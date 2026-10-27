#!/usr/bin/env python3
"""The live layer's receiver on the development web host (docs/architecture/live-layer.md).

Owns <live>/public (served by NGINX ahead of the release) and <live>/manifest.json (read by the web service,
which tells open pages what changed). Development only: install-web.sh puts it on dev web alone.

  serve   JSON lines on stdin/stdout, one request per line. The droplet's live-sync runs it over SSH as the
          forced command of a key that can do nothing else.
            {"op":"list"}
            {"op":"batch","source":"<host:checkout>","ops":[{"op":"put","path","sha","base","commit"?,"data"(base64)},
                                                           {"op":"remove","path","force"?}]}
            {"op":"check"}
          The dev push router (tools/dev-push/router/live.mjs) bakes overlays into each platform release with:
            {"op":"export"}                                   live and parked entries, and the release identity
            {"op":"blob","sha"}                               an accepted save's bytes (base64) from the journal
            {"op":"merged","release","files":{path: sha}}     those saves are in the release now active
            {"op":"unpark","path"}                            drops a parked save (live-sync clear)
  check   Retires files the release now has ("released") and parks those it changed under them. A timer runs it,
          so a rollout ends or guards the layer even when no sync is connected.
  list    Prints the manifest.

Several syncs may share the layer: each file belongs to the sync that put it live, and another sync's put or
remove of it is refused ("owned-by-other") unless the remove says force. Another sync's put never retires or
parks the owner's file.

A put is refused with "dev-differs" when the release's copy is neither the base it was edited from nor the
new bytes: the editor's checkout is older than dev there, and serving it would revert someone's release. The
one exception is a continuation: the release's copy is a save this same sync had live before (the router baked
it in), so the new save is accepted on top of the release.

Nothing accepted is lost. Every accepted put is kept by content in <live>/journal/<sha>. A live file the release
changed under it is not dropped but parked ("parked" in the manifest): no longer served, its bytes kept, until
the router reports it merged into a release or someone clears it.
"""
import base64
import hashlib
import json
import os
import re
import sys
import time

try:
    import fcntl
except ImportError:  # Windows, for the tests: one process at a time there
    fcntl = None

LIVE = os.environ.get("FM_LIVE_DIR", "/opt/firstmeasure/live")
RELEASE = os.environ.get("FM_RELEASE_PUBLIC", "/opt/firstmeasure/current/public")
TYPES = {".js", ".mjs", ".css", ".json", ".map", ".txt", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
         ".woff", ".woff2", ".ttf", ".mp3", ".mp4", ".webm"}
TEXT = {".js", ".mjs", ".css", ".json", ".map", ".txt", ".svg"}
SEGMENT = re.compile(r"^[A-Za-z0-9_@+\-][A-Za-z0-9_@+.\- ]*$")
MAX_BYTES = 32 * 1024 * 1024
SHA = re.compile(r"^[0-9a-f]{40}$")
JOURNAL_DAYS = 14
HISTORY = 10


def ext_of(path):
    return os.path.splitext(path)[1].lower()


def valid_path(path):
    """A browser file under public/: never server code, storage, a page, or anything outside the layer."""
    if not isinstance(path, str) or not path or len(path) > 400 or path.startswith("/") or "\\" in path:
        return False
    parts = path.split("/")
    if parts[0] in ("v1", "storage") or not all(SEGMENT.match(part) for part in parts):
        return False
    return ext_of(path) in TYPES


def digest(path, data):
    if ext_of(path) in TEXT:
        data = data.replace(b"\r\n", b"\n")
    return hashlib.sha1(data).hexdigest()


def release_sha(path):
    try:
        with open(os.path.join(RELEASE, path), "rb") as handle:
            return digest(path, handle.read())
    except OSError:
        return None


def release_id():
    """The release the layer sits on: RELEASE_COMMIT or RELEASE_ID from its release.env, else its directory name."""
    root = os.path.dirname(os.path.normpath(RELEASE))
    values = {}
    try:
        with open(os.path.join(root, "release.env"), encoding="utf-8") as handle:
            for line in handle:
                key, _, value = line.strip().partition("=")
                values[key.strip()] = value.strip().strip("'\"")
    except OSError:
        pass
    return values.get("RELEASE_COMMIT") or values.get("RELEASE_ID") or os.path.basename(os.path.realpath(root))


def manifest_path():
    return os.path.join(LIVE, "manifest.json")


def read_manifest():
    try:
        with open(manifest_path(), encoding="utf-8") as handle:
            value = json.load(handle)
        gen = int(value.get("gen") or 0)
        # Recent retirements stay so a page that missed a write still knows a file left because it was released.
        retired = {path: entry for path, entry in dict(value.get("retired") or {}).items() if int(entry.get("gen") or 0) > gen - 50}
        return {"gen": gen, "files": dict(value.get("files") or {}), "retired": retired,
                "parked": dict(value.get("parked") or {}), "history": dict(value.get("history") or {})}
    except (OSError, ValueError):
        return {"gen": 0, "files": {}, "retired": {}, "parked": {}, "history": {}}


def content(manifest):
    """What a request may change; the manifest is written only when it did."""
    return json.dumps([manifest["files"], manifest["parked"], manifest["history"]], sort_keys=True)


def write_atomic(target, data):
    os.makedirs(os.path.dirname(target), exist_ok=True)
    temp = f"{target}.tmp-{os.getpid()}"
    with open(temp, "wb") as handle:
        handle.write(data)
    os.chmod(temp, 0o644)
    os.replace(temp, target)


def save_manifest(manifest):
    manifest["gen"] += 1
    manifest["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_atomic(manifest_path(), json.dumps(manifest, indent=1, sort_keys=True).encode())


def journal_path(sha):
    return os.path.join(LIVE, "journal", sha)


def journal(sha, data):
    """Keeps an accepted save's bytes by content, so the router can bake it in whatever happens to the live copy."""
    if not os.path.exists(journal_path(sha)):
        write_atomic(journal_path(sha), data)


def prune_journal(manifest):
    """Drops journal bytes older than JOURNAL_DAYS that no live or parked entry needs."""
    keep = {entry.get("sha") for entry in list(manifest["files"].values()) + list(manifest["parked"].values())}
    cutoff = time.time() - JOURNAL_DAYS * 86400
    try:
        names = os.listdir(os.path.join(LIVE, "journal"))
    except OSError:
        return
    for name in names:
        try:
            if name not in keep and os.path.getmtime(journal_path(name)) < cutoff:
                os.remove(journal_path(name))
        except OSError:
            pass


def retire(manifest, path, reason):
    if path not in manifest["files"]:
        return
    del manifest["files"][path]
    manifest["retired"][path] = {"reason": reason, "gen": manifest["gen"] + 1}
    try:
        os.remove(os.path.join(LIVE, "public", path))
    except OSError:
        pass


def park(manifest, path):
    """The release changed under a live file: stop serving it (pages get the release's copy again, as for any
    retirement other than "released") but keep the entry and its journal bytes for the router."""
    entry = manifest["files"].get(path)
    if not entry:
        return
    manifest["parked"][path] = {**entry, "reason": "conflict", "parked_gen": manifest["gen"] + 1}
    retire(manifest, path, "parked")


def unpark(manifest, path, reason):
    if manifest["parked"].pop(path, None) is not None and path not in manifest["files"]:
        manifest["retired"][path] = {"reason": reason, "gen": manifest["gen"] + 1}


def continues(manifest, path, source, release):
    """Whether the release's copy is a save this source had accepted for this path (the router baked it in)."""
    if not release:
        return False
    parked = manifest["parked"].get(path) or {}
    if parked.get("source") == source and parked.get("sha") == release:
        return True
    return any(item.get("sha") == release and item.get("source") == source for item in manifest["history"].get(path) or [])


class Locked:
    def __enter__(self):
        os.makedirs(LIVE, exist_ok=True)
        self.handle = open(os.path.join(LIVE, ".lock"), "a")
        if fcntl:
            fcntl.flock(self.handle, fcntl.LOCK_EX)
        return read_manifest()

    def __exit__(self, *_):
        self.handle.close()


def put(manifest, op, source, release_name):
    path, sha, base = op.get("path"), op.get("sha"), op.get("base")
    if not valid_path(path):
        return {"path": path, "ok": False, "error": "not-a-browser-file"}
    data = base64.b64decode(op.get("data") or "")
    if len(data) > MAX_BYTES or digest(path, data) != sha:
        return {"path": path, "ok": False, "error": "bad-content"}
    release = release_sha(path)
    current = manifest["files"].get(path, {})
    # Another sync's save is only answered: it never retires or parks the owner's live file.
    mine = not current or current.get("source") == source
    if release == sha:
        if mine:
            retire(manifest, path, "released")
        return {"path": path, "ok": True, "state": "released"}
    if release != base:
        if not continues(manifest, path, source, release):
            if mine and current.get("base") != release:
                park(manifest, path)
            return {"path": path, "ok": False, "error": "dev-differs", "release": release, "base": base}
        base = release  # the router baked an earlier save of this source in: this one continues on top of the release
    if current.get("sha") == sha:
        if mine and current.get("base") != base:
            current["base"] = base
        return {"path": path, "ok": True, "state": "live"}
    if not mine:
        return {"path": path, "ok": False, "error": "owned-by-other", "owner": current.get("source")}
    journal(sha, data)
    write_atomic(os.path.join(LIVE, "public", path), data)
    entry = {"sha": sha, "base": base, "source": source, "at": int(time.time()), "release": release_name}
    if isinstance(op.get("commit"), str) and op["commit"]:
        entry["commit"] = op["commit"][:80]
    manifest["files"][path] = entry
    history = [item for item in manifest["history"].get(path) or [] if item.get("sha") != sha]
    manifest["history"][path] = (history + [{"sha": sha, "source": source, "at": entry["at"]}])[-HISTORY:]
    manifest["retired"].pop(path, None)
    return {"path": path, "ok": True, "state": "live"}


def check(manifest):
    retired = {}
    for path, entry in list(manifest["files"].items()):
        release = release_sha(path)
        if release == entry.get("sha"):
            retire(manifest, path, "released")
            retired[path] = "released"
        elif release != entry.get("base"):
            if continues(manifest, path, entry.get("source"), release):
                entry["base"] = release
            else:
                park(manifest, path)
                retired[path] = "parked"
    prune_journal(manifest)
    return retired


def merged(manifest, files):
    """The router merged these saves into the release now active: they leave the layer and the parked list. A
    newer live save of the same path stays live and continues on top of the release."""
    results = {}
    for path, sha in dict(files or {}).items():
        live, parked = manifest["files"].get(path), manifest["parked"].get(path)
        states = []
        if parked and parked.get("sha") == sha:
            unpark(manifest, path, "released")
            states.append("unparked")
        if live and live.get("sha") == sha:
            retire(manifest, path, "released")
            states.append("released")
        elif live:
            live["base"] = release_sha(path)
            states.append("continues")
        results[path] = {"ok": bool(states), "state": "+".join(states) or "unknown"}
    return results


def blob(sha):
    if not isinstance(sha, str) or not SHA.match(sha):
        return None
    served = [os.path.join(LIVE, "public", path) for path, entry in read_manifest()["files"].items() if entry.get("sha") == sha]
    for candidate in [journal_path(sha)] + served:
        try:
            with open(candidate, "rb") as handle:
                return handle.read()
        except OSError:
            continue
    return None


def handle(request):
    op = request.get("op")
    if op == "list":
        manifest = read_manifest()
        return {"ok": True, "gen": manifest["gen"], "files": manifest["files"], "parked": manifest["parked"]}
    if op == "export":
        manifest = read_manifest()
        return {"ok": True, "gen": manifest["gen"], "release": release_id(), "files": manifest["files"], "parked": manifest["parked"]}
    if op == "blob":
        data = blob(request.get("sha"))
        if data is None:
            return {"ok": False, "error": "no-blob", "sha": request.get("sha")}
        return {"ok": True, "sha": request.get("sha"), "data": base64.b64encode(data).decode()}
    with Locked() as manifest:
        before = content(manifest)
        if op == "check":
            result = {"ok": True, "retired": check(manifest)}
        elif op == "batch":
            results = []
            # Each sync names itself; it may replace or remove only the files it put live (or any, with force).
            source = str(request.get("source") or "unknown")[:200]
            release_name = release_id()
            for item in request.get("ops") or []:
                if item.get("op") == "put":
                    results.append(put(manifest, item, source, release_name))
                elif item.get("op") == "remove" and valid_path(item.get("path")):
                    path = item["path"]
                    # A parked save goes with it only when it is this sync's too (or forced).
                    live_owner, parked_owner = ((manifest[part].get(path) or {}).get("source") for part in ("files", "parked"))
                    owner = live_owner or parked_owner
                    if owner and owner != source and not item.get("force"):
                        results.append({"path": path, "ok": False, "error": "owned-by-other", "owner": owner})
                        continue
                    retire(manifest, path, "reverted")
                    if item.get("force") or parked_owner == source:
                        unpark(manifest, path, "reverted")
                    results.append({"path": path, "ok": True, "state": "removed"})
                else:
                    results.append({"path": item.get("path"), "ok": False, "error": "bad-op"})
            result = {"ok": True, "results": results}
        elif op == "merged":
            result = {"ok": True, "release": request.get("release"), "results": merged(manifest, request.get("files"))}
        elif op == "unpark":
            path = request.get("path")
            if path in manifest["parked"]:
                unpark(manifest, path, "reverted")
                result = {"ok": True, "path": path, "state": "unparked"}
            else:
                result = {"ok": False, "path": path, "error": "not-parked"}
        else:
            return {"ok": False, "error": "bad-op"}
        if content(manifest) != before:
            save_manifest(manifest)
        result["gen"] = manifest["gen"]
        result["files"] = manifest["files"]
        result["parked"] = manifest["parked"]
        return result


def serve():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            response = handle(request)
            response["id"] = request.get("id")
        except Exception as error:  # report and keep serving; the sync decides what to do
            response = {"ok": False, "error": type(error).__name__}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


def main(argv):
    command = argv[1] if len(argv) > 1 else "serve"
    # A forced SSH command sees the client's request in SSH_ORIGINAL_COMMAND; only these words are honoured.
    original = os.environ.get("SSH_ORIGINAL_COMMAND", "").split()
    if original and original[0] in ("serve", "check", "list"):
        command = original[0]
    if command == "serve":
        serve()
    elif command == "check":
        print(json.dumps(handle({"op": "check"})["retired"]))
    elif command == "list":
        print(json.dumps(handle({"op": "list"}), indent=1))
    else:
        sys.exit("usage: fm-live-receive.py serve|check|list")


if __name__ == "__main__":
    main(sys.argv)
