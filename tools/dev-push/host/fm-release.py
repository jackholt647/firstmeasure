#!/usr/bin/env python3
"""Dev host release helper for the dev push router (docs/architecture/dev-lanes.md).

Installed as /usr/local/sbin/fm-release on every dev role by tools/dev-push/host/install.sh. The router's key may run
only this (forced command `fm-release ssh`), so a dev host activates nothing but a release the router staged here.

  rsync --server ... <releases root>/<sha>.staging/     receive a release tree (validated, then run as rsync)
  fm-release finish <lane> <sha>      < manifest.json   check the staged tree is exactly the manifest, make it a release
  fm-release activate <lane> <sha> [--expect <sha>|-]   switch `current`, restart, wait for readiness, roll back on failure
  fm-release rollback <lane> <sha>                      switch back to an existing release
  fm-release status [<lane>]                            JSON: current release, receipts, free space
  fm-release tree <lane>                                JSON: every file of the current release with its sha256
  fm-release prune <lane> [--keep N] [--days D]         delete old release directories (never current or previous)
  fm-release seal on|off                                make /opt/firstmeasure immutable (only this helper switches `current`)
  fm-release publish                  < status.json     web only: the router status document, served at /__dev-push/status.json

Lanes: `platform` switches /opt/firstmeasure/current (the role's releases root holds the releases); any other lane
switches /opt/firstmeasure/lanes/<lane>/current with releases in /opt/firstmeasure/lanes/<lane>/releases.
Role settings: /etc/firstmeasure/dev-push-role.json.
"""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path("/opt/firstmeasure")
CONFIG = pathlib.Path(os.environ.get("FM_RELEASE_CONFIG", "/etc/firstmeasure/dev-push-role.json"))
LOCK = pathlib.Path("/run/lock/fm-release.lock")
SHA = re.compile(r"^[0-9a-f]{40}$")
LANE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
RECEIPT = "dev-push-release.json"
# Never part of a release tree: runtime data carried from the running release, and the router's receipt.
HOST_PATHS = ("public/storage", "public/v1/storage", "public/v1/output")
SKIP_IN_TREE = set(HOST_PATHS) | {RECEIPT, "channels-release.json"}


def out(value, code=0):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def fail(message, **extra):
    out({"ok": False, "error": message, **extra}, 1)


def config():
    return json.loads(CONFIG.read_text())


def lane_dirs(lane):
    if not LANE.match(lane):
        fail(f"bad lane {lane!r}")
    if lane == "platform":
        return pathlib.Path(config()["releases_root"]), ROOT / "current"
    base = ROOT / "lanes" / lane
    return base / "releases", base / "current"


def current_release(link):
    return link.resolve() if link.is_symlink() or link.exists() else None


def file_sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def walk(tree):
    """{rel: [sha256, size, mode]} for files and {rel: target} for symlinks, excluding host paths."""
    files, links = {}, {}
    tree = str(tree)
    for dirpath, dirnames, filenames in os.walk(tree):
        rel_dir = os.path.relpath(dirpath, tree).replace(os.sep, "/")
        rel_dir = "" if rel_dir == "." else rel_dir + "/"
        keep = []
        for name in dirnames:
            rel = rel_dir + name
            full = os.path.join(dirpath, name)
            if rel in SKIP_IN_TREE:
                continue
            if os.path.islink(full):
                links[rel] = os.readlink(full)
            else:
                keep.append(name)
        dirnames[:] = keep
        for name in filenames:
            rel = rel_dir + name
            if rel in SKIP_IN_TREE:
                continue
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                links[rel] = os.readlink(full)
                continue
            st = os.stat(full)
            files[rel] = [file_sha(full), st.st_size, st.st_mode & 0o777]
    return files, links


def tree_digest(files, links):
    digest = hashlib.sha256()
    for rel in sorted(files):
        digest.update(f"f {rel} {files[rel][0]}\n".encode())
    for rel in sorted(links):
        digest.update(f"l {rel} {links[rel]}\n".encode())
    return digest.hexdigest()


def environment(service):
    pid = subprocess.check_output(["systemctl", "show", service, "-p", "MainPID", "--value"], text=True).strip()
    if pid in ("", "0"):
        raise RuntimeError(f"{service} is not running")
    env = dict(item.split("=", 1) for item in pathlib.Path("/proc", pid, "environ").read_text().split("\0") if "=" in item)
    if env.get("FIRSTMEASURE_DATA_ENVIRONMENT") != "development":
        raise RuntimeError(f"{service} is not a development process")
    return env


def ready(expected):
    """Readiness of the role's main service on the expected release (as the old deploy.py safety check)."""
    settings = config()
    service = settings["services"][0]
    env = environment(service)
    if env.get("RELEASE_ID") != expected:
        raise RuntimeError(f"{service} runs RELEASE_ID {env.get('RELEASE_ID')}, not {expected}")
    if settings.get("readiness") == "worker":
        code = ("const {inspectRuntimeReadiness}=await import('./dist/src/runtime_health.js');"
                "const r=await inspectRuntimeReadiness({fresh:true});"
                "console.log(JSON.stringify({ok:r.ok,env:r.data_environment,safe:r.outbound_safety?.ok,enforced:r.outbound_safety?.enforced}));process.exit(r.ok?0:1);")
        result = subprocess.run(["node", "--experimental-sqlite", "--input-type=module", "-e", code], cwd=ROOT / "current/public/v1", env=env, capture_output=True, text=True, timeout=45)
        data = json.loads((result.stdout.strip().splitlines() or ["{}"])[-1])
        if result.returncode != 0 or data != {"ok": True, "env": "development", "safe": True, "enforced": True}:
            raise RuntimeError(f"worker readiness: {result.stdout.strip()[-300:]} {result.stderr.strip()[-300:]}")
    else:
        request = urllib.request.Request(f"http://127.0.0.1:{env.get('V1_PORT', '3201')}/v1/health/ready")
        if env.get("LEGACY_PROXY_SECRET"):
            request.add_header("x-firstmeasure-legacy-proxy", env["LEGACY_PROXY_SECRET"])
        with urllib.request.urlopen(request, timeout=8) as response:
            data = json.load(response)
        if not (data.get("ok") and data.get("release_id") == expected and data.get("data_environment") == "development"
                and data.get("outbound_safety", {}).get("ok") and data.get("outbound_safety", {}).get("enforced")):
            raise RuntimeError(f"not ready: {json.dumps(data)[:300]}")
    for other in settings["services"][1:]:
        state = subprocess.run(["systemctl", "is-active", other], capture_output=True, text=True).stdout.strip()
        if state != "active":
            raise RuntimeError(f"{other} is {state}")


def wait_ready(expected, seconds):
    error = None
    for _ in range(seconds):
        try:
            ready(expected)
            return None
        except Exception as exc:  # noqa: BLE001
            error = str(exc)
            time.sleep(1)
    return error


def running_jobs():
    settings = config()
    if settings.get("readiness") != "worker":
        return 0
    env = environment(settings["services"][0])
    code = ("const {queryPostgres}=await import('./dist/src/database/postgres.js');"
            "const r=await queryPostgres(\"SELECT COUNT(*)::int AS running FROM firstmeasure_jobs WHERE status='running'\");"
            "console.log(JSON.stringify(r.rows[0]));process.exit(0);")
    result = subprocess.run(["node", "--input-type=module", "-e", code], cwd=ROOT / "current/public/v1", env=env, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return 0  # the check is advisory; a broken query must not block every release
    return json.loads(result.stdout.strip().splitlines()[-1]).get("running", 0)


def seal(on):
    flag = "+i" if on else "-i"
    subprocess.run(["chattr", flag, str(ROOT)], check=True)


def swap(link, target):
    """Atomically point `link` at `target` (the lane's current symlink)."""
    sealed = link.parent == ROOT and "i" in subprocess.run(["lsattr", "-d", str(ROOT)], capture_output=True, text=True).stdout.split()[0]
    if sealed:
        seal(False)
    try:
        temp = link.with_name(link.name + ".fm-release-next")
        if temp.is_symlink() or temp.exists():
            temp.unlink()
        temp.symlink_to(target)
        os.replace(temp, link)
    finally:
        if sealed:
            seal(True)


def restart(lane, settings):
    if lane == "platform":
        for service in settings["services"]:
            subprocess.run(["systemctl", "restart", service], check=True)
    for service in settings.get("reload", []) if lane == "platform" else settings.get("lane_reload", {}).get(lane, []):
        subprocess.run(["systemctl", "reload", service], check=True)


def locked():
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    handle = open(LOCK, "w")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fail("another fm-release operation is running")
    return handle


# ------------------------------------------------------------------------------------------------ commands

def cmd_finish(lane, sha):
    if not SHA.match(sha):
        fail("bad sha")
    releases, link = lane_dirs(lane)
    staging = releases / f"{sha}.staging"
    target = releases / sha
    if not staging.is_dir():
        fail(f"nothing staged at {staging}")
    manifest = json.load(sys.stdin)
    files, links = walk(staging)
    want_files = {rel: list(entry) for rel, entry in manifest["files"].items()}
    want_links = manifest.get("links", {})
    extra = sorted(set(files) - set(want_files))[:20]
    missing = sorted(set(want_files) - set(files))[:20]
    wrong = sorted(rel for rel in set(files) & set(want_files) if files[rel][0] != want_files[rel][0])[:20]
    if extra or missing or wrong or links != want_links:
        fail("staged tree differs from the manifest", extra=extra, missing=missing, wrong=wrong, links=sorted(set(links) ^ set(want_links))[:20])
    digest = tree_digest(files, links)
    if manifest.get("tree_sha256") and digest != manifest["tree_sha256"]:
        fail("tree digest mismatch", digest=digest)
    current = current_release(link)
    if lane == "platform" and current:
        for rel in HOST_PATHS:  # runtime data travels with the running release, as it always has
            source, dest = current / rel, staging / rel
            if source.is_dir() and not dest.exists():
                subprocess.run(["cp", "-a", str(source), str(dest)], check=True)
    subprocess.run(["chown", "--reference", str(current or releases), str(staging)], check=False)
    receipt = {"release_id": manifest.get("release_id"), "lane": lane, "sha": sha, "tree_sha256": digest, "files": len(files), "staged_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "router": True}
    (staging / RECEIPT).write_text(json.dumps(receipt, indent=1))
    if target.exists():
        try:
            old = json.loads((target / RECEIPT).read_text())
        except Exception:  # noqa: BLE001
            old = {}
        if old.get("tree_sha256") == digest:
            shutil.rmtree(staging)
            out({"ok": True, "release": str(target), "reused": True, "tree_sha256": digest})
        if current and current == target.resolve():
            fail(f"{target} is the running release with a different tree; refusing to replace it")
        target.rename(releases / f"{sha}-replaced-{int(time.time())}")
    staging.rename(target)
    out({"ok": True, "release": str(target), "tree_sha256": digest, "files": len(files)})


def cmd_activate(lane, sha, expect, wait_jobs):
    if not SHA.match(sha):
        fail("bad sha")
    handle = locked()
    settings = config()
    releases, link = lane_dirs(lane)
    target = releases / sha
    if not (target / RECEIPT).is_file():
        fail(f"{target} was not staged by the router")
    previous = current_release(link)
    if previous == target.resolve():
        error = wait_ready(sha, 30) if lane == "platform" else None
        out({"ok": error is None, "reused": True, "previous": previous.name, "error": error}, 0 if error is None else 1)
    if expect and expect != "-" and (previous is None or previous.name != expect):
        fail(f"current release is {previous.name if previous else None}, not {expect}", previous=previous.name if previous else None)
    if lane == "platform":
        deadline = time.time() + wait_jobs
        while running_jobs() > 0:
            if time.time() > deadline:
                fail("worker has running jobs", busy=True, previous=previous.name if previous else None)
            time.sleep(5)
    swap(link, target)
    try:
        restart(lane, settings)
        error = wait_ready(sha, 120) if lane == "platform" else None
        if error:
            raise RuntimeError(error)
    except Exception as exc:  # noqa: BLE001
        reason = str(exc)
        if previous:
            swap(link, previous)
            restart(lane, settings)
            back = wait_ready(previous.name, 120) if lane == "platform" else None
            fail(f"activation failed: {reason}", rolled_back=back is None, rollback_error=back, previous=previous.name)
        fail(f"activation failed: {reason}", rolled_back=False)
    handle.close()
    out({"ok": True, "release": sha, "previous": previous.name if previous else None})


def cmd_rollback(lane, sha):
    handle = locked()
    releases, link = lane_dirs(lane)
    target = releases / sha
    if not target.is_dir():
        fail(f"no release {target}")
    swap(link, target)
    restart(lane, config())
    error = wait_ready(sha, 120) if lane == "platform" else None
    handle.close()
    out({"ok": error is None, "release": sha, "error": error}, 0 if error is None else 1)


def cmd_status(lane):
    settings = config()
    lanes = [lane] if lane else ["platform"] + sorted(p.name for p in (ROOT / "lanes").glob("*") if p.is_dir())
    result = {"ok": True, "role": settings.get("role"), "host": os.uname().nodename, "lanes": {}}
    for name in lanes:
        releases, link = lane_dirs(name)
        current = current_release(link)
        receipt = {}
        if current and (current / RECEIPT).is_file():
            receipt = json.loads((current / RECEIPT).read_text())
        usage = shutil.disk_usage(releases) if releases.exists() else None
        stat = os.statvfs(releases) if releases.exists() else None
        result["lanes"][name] = {"current": current.name if current else None, "receipt": receipt, "releases": str(releases),
                                 "free_bytes": usage.free if usage else None, "free_inodes": stat.f_favail if stat else None}
    lsattr = subprocess.run(["lsattr", "-d", str(ROOT)], capture_output=True, text=True).stdout.split()
    result["sealed"] = bool(lsattr) and "i" in lsattr[0].replace("I", "")
    out(result)


def cmd_tree(lane):
    _, link = lane_dirs(lane)
    current = current_release(link)
    files, links = walk(current)
    out({"ok": True, "release": current.name, "tree_sha256": tree_digest(files, links), "files": files, "links": links})


def cmd_prune(lane, keep, days):
    handle = locked()
    releases, link = lane_dirs(lane)
    current = current_release(link)
    keepers = {current.name} if current else set()
    candidates = sorted((p for p in releases.iterdir() if p.is_dir() and re.match(r"^[0-9a-f]{40}", p.name)), key=lambda p: p.stat().st_mtime, reverse=True)
    newest = {p.name for p in candidates[:keep]}
    cutoff = time.time() - days * 86400
    removed = []
    for path in candidates:
        if path.name in keepers or path.name in newest or path.stat().st_mtime > cutoff:
            continue
        if current and path.resolve() == current:
            continue
        shutil.rmtree(path, ignore_errors=True)
        removed.append(path.name)
    handle.close()
    out({"ok": True, "removed": len(removed), "kept": len(candidates) - len(removed)})


def cmd_publish():
    status_dir = config().get("status_dir")
    if not status_dir:
        fail("this role does not hold the router status")
    data = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024:
        fail("status document too large")
    json.loads(data)
    target = pathlib.Path(status_dir) / "status.json"
    temp = target.with_name("status.json.tmp")
    temp.write_bytes(data)
    os.chmod(temp, 0o644)
    os.replace(temp, target)
    out({"ok": True, "bytes": len(data)})


def cmd_ssh():
    """Forced command for the router key: rsync into a staging directory, or one of the commands above."""
    original = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    argv = shlex.split(original)
    if not argv:
        fail("no command")
    if argv[0] == "rsync":
        if argv[1:2] != ["--server"] or "--sender" in argv or any(a.startswith(("--remove-source", "--rsync-path")) for a in argv):
            fail("only rsync uploads are allowed")
        dest = os.path.normpath(argv[-1])
        allowed = [str(lane_dirs("platform")[0])] + [str(p / "releases") for p in (ROOT / "lanes").glob("*")]
        if not any(dest.startswith(root + "/") for root in allowed) or not re.search(r"/[0-9a-f]{40}\.staging$", dest):
            fail(f"rsync destination {dest} is not a staging directory")
        for arg in argv:
            if arg.startswith("--link-dest="):
                link_dest = os.path.normpath(arg.split("=", 1)[1])
                if not link_dest.startswith(str(ROOT) + "/"):
                    fail("link-dest outside /opt/firstmeasure")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        os.execvp("rsync", argv)
    if argv[0] in ("fm-release", "/usr/local/sbin/fm-release"):
        argv = argv[1:]
    if not argv or argv[0] not in ("finish", "activate", "rollback", "status", "tree", "prune", "publish"):
        fail(f"command not allowed: {original[:80]}")
    main(argv)


def main(argv):
    if not argv:
        fail(__doc__)
    command, rest = argv[0], argv[1:]

    def option(name, default):
        if name in rest:
            index = rest.index(name)
            value = rest[index + 1]
            del rest[index:index + 2]
            return value
        return default

    if command == "ssh":
        return cmd_ssh()
    if command == "finish":
        return cmd_finish(rest[0], rest[1])
    if command == "activate":
        expect = option("--expect", "-")
        wait_jobs = int(option("--wait-jobs", "600"))
        return cmd_activate(rest[0], rest[1], expect, wait_jobs)
    if command == "rollback":
        return cmd_rollback(rest[0], rest[1])
    if command == "status":
        return cmd_status(rest[0] if rest else None)
    if command == "tree":
        return cmd_tree(rest[0] if rest else "platform")
    if command == "prune":
        keep = int(option("--keep", "10"))
        days = float(option("--days", "3"))
        return cmd_prune(rest[0] if rest else "platform", keep, days)
    if command == "publish":
        return cmd_publish()
    if command == "seal":
        seal(rest[0] == "on")
        out({"ok": True, "sealed": rest[0] == "on"})
    fail(f"unknown command {command}")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        fail(f"{type(exc).__name__}: {exc}")
