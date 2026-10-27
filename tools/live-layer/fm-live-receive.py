#!/usr/bin/env python3
"""The live layer's receiver on the development web host (docs/architecture/live-layer.md).

Owns <live>/public (served by NGINX ahead of the release) and <live>/manifest.json (read by the web service,
which tells open pages what changed). Development only: install-web.sh puts it on dev web alone.

  serve   JSON lines on stdin/stdout, one request per line. The droplet's live-sync runs it over SSH as the
          forced command of a key that can do nothing else.
            {"op":"list"}
            {"op":"batch","ops":[{"op":"put","path","sha","base","data"(base64)}, {"op":"remove","path"}]}
            {"op":"check"}
  check   Retires files the release now has ("released") or changed under them ("conflict"). A timer runs it,
          so a rollout ends or guards the layer even when no sync is connected.
  list    Prints the manifest.

A put is refused with "dev-differs" when the release's copy is neither the base it was edited from nor the
new bytes: the editor's checkout is older than dev there, and serving it would revert someone's release.
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


def manifest_path():
    return os.path.join(LIVE, "manifest.json")


def read_manifest():
    try:
        with open(manifest_path(), encoding="utf-8") as handle:
            value = json.load(handle)
        gen = int(value.get("gen") or 0)
        # Recent retirements stay so a page that missed a write still knows a file left because it was released.
        retired = {path: entry for path, entry in dict(value.get("retired") or {}).items() if int(entry.get("gen") or 0) > gen - 50}
        return {"gen": gen, "files": dict(value.get("files") or {}), "retired": retired}
    except (OSError, ValueError):
        return {"gen": 0, "files": {}, "retired": {}}


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


def retire(manifest, path, reason):
    if path not in manifest["files"]:
        return
    del manifest["files"][path]
    manifest["retired"][path] = {"reason": reason, "gen": manifest["gen"] + 1}
    try:
        os.remove(os.path.join(LIVE, "public", path))
    except OSError:
        pass


class Locked:
    def __enter__(self):
        os.makedirs(LIVE, exist_ok=True)
        self.handle = open(os.path.join(LIVE, ".lock"), "a")
        if fcntl:
            fcntl.flock(self.handle, fcntl.LOCK_EX)
        return read_manifest()

    def __exit__(self, *_):
        self.handle.close()


def put(manifest, op):
    path, sha, base = op.get("path"), op.get("sha"), op.get("base")
    if not valid_path(path):
        return {"path": path, "ok": False, "error": "not-a-browser-file"}
    data = base64.b64decode(op.get("data") or "")
    if len(data) > MAX_BYTES or digest(path, data) != sha:
        return {"path": path, "ok": False, "error": "bad-content"}
    release = release_sha(path)
    if release == sha:
        retire(manifest, path, "released")
        return {"path": path, "ok": True, "state": "released"}
    if release != base:
        retire(manifest, path, "conflict")
        return {"path": path, "ok": False, "error": "dev-differs", "release": release, "base": base}
    if manifest["files"].get(path, {}).get("sha") == sha:
        return {"path": path, "ok": True, "state": "live"}
    write_atomic(os.path.join(LIVE, "public", path), data)
    manifest["files"][path] = {"sha": sha, "base": base, "at": int(time.time())}
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
            retire(manifest, path, "conflict")
            retired[path] = "conflict"
    return retired


def handle(request):
    op = request.get("op")
    if op == "list":
        manifest = read_manifest()
        return {"ok": True, "gen": manifest["gen"], "files": manifest["files"]}
    with Locked() as manifest:
        before = json.dumps(manifest["files"], sort_keys=True)
        if op == "check":
            result = {"ok": True, "retired": check(manifest)}
        elif op == "batch":
            results = []
            for item in request.get("ops") or []:
                if item.get("op") == "put":
                    results.append(put(manifest, item))
                elif item.get("op") == "remove" and valid_path(item.get("path")):
                    retire(manifest, item["path"], "reverted")
                    results.append({"path": item["path"], "ok": True, "state": "removed"})
                else:
                    results.append({"path": item.get("path"), "ok": False, "error": "bad-op"})
            result = {"ok": True, "results": results}
        else:
            return {"ok": False, "error": "bad-op"}
        if json.dumps(manifest["files"], sort_keys=True) != before:
            save_manifest(manifest)
        result["gen"] = manifest["gen"]
        result["files"] = manifest["files"]
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
