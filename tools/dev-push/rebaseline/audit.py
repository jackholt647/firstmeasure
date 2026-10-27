#!/usr/bin/env python3
"""Read-only drift audit: what is deployed on the dev hosts that canonical git lacks.

Before a re-baseline (every dev role switched to a release built purely from
git), this finds every file on a dev host whose bytes git does not hold, so
nothing is lost. It never writes on a host: each host gets a small Python
program over SSH stdin that only reads and hashes files.

Usage (from the checkout root; Python 3.8+, stdlib only, git and ssh on PATH):

    python tools/dev-push/rebaseline/audit.py
    python tools/dev-push/rebaseline/audit.py --canonical codex/consolidated-firstmeasure-20260923 \
        --roles web,worker,legacy --out output/rebaseline-20261027

    --no-fetch        skip `git fetch origin`
    --no-capture      classify only; do not copy host-only bytes
    --capture-limit   total bytes to capture per run (default 200 MB)
    --host ROLE=IP    override a host address (repeatable)
    --jump / --key / --ssh   SSH jump host, identity file, ssh binary

Classes for a file in the release tree (release root == repository root):
    same                      raw or CRLF->LF folded blob equals canonical's
    committed-canonical       host blob is reachable from canonical (an older version)
    committed-other-ref       host blob is reachable only from other refs (listed)
    object-only               blob is in the object database but no ref reaches it
    novel                     blob is in no git object: host-only content (captured + diff)
Host-only paths (not in canonical's tree) are grouped as code (public/, deploy/,
tools/, tests/, dev/, docs/), junk (release-root rollout manifests) or other,
each with the same committed/object-only/novel status. Paths in canonical but
absent on the host are listed as missing-on-host. The dev web live layer
(/opt/firstmeasure/live) is captured whole and compared the same way.

Outputs: <out>/audit-<timestamp>.json, <out>/audit-<timestamp>.md, captured
bytes under <out>/<role>/<path> with <path>.diff next to each novel file.
"""

import argparse
import base64
import collections
import concurrent.futures
import datetime
import difflib
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
import zlib

DEFAULT_CANONICAL = "codex/consolidated-firstmeasure-20260923"
DEFAULT_HOSTS = {"web": "143.198.68.11", "worker": "137.184.44.82", "legacy": "137.184.229.145"}
DEFAULT_JUMP = "dev-sync-droplet"
DEFAULT_KEY = os.path.join(os.path.expanduser("~"), ".ssh", "id_ed25519_firstmeasure_cluster_v2")
RELEASE_LINK = "/opt/firstmeasure/current"
LIVE_ROOT = "/opt/firstmeasure/live"
SKIP_PREFIXES = ("public/v1/node_modules", "public/v1/dist", "public/storage", "public/v1/storage", "public/v1/output")
SKIP_NAMES = ("node_modules", ".git")
CODE_PREFIXES = ("public/", "deploy/", "tools/", "tests/", "dev/", "docs/")
JUNK_ROOT_RE = re.compile(r"(-release\.json|-manifest\.json|\.sha256|-release\.txt|\.release)$")
GENERATED_HINT_RE = re.compile(
    r"(\.min\.(js|css)$|bundle|/lang/|/i18n/|/locales?/|catalog|manifest|\.map$|/generated/|/build/|lock\.json$)", re.I)

# --------------------------------------------------------------------------- remote side
# Streamed to the host as `python3 -`; reads only. The last line of the program
# (appended by remote_call) calls main(<json args>). Output: zlib(JSON).
REMOTE = r'''
import hashlib, json, os, stat, sys, zlib, base64, socket

def blob_id(data):
    h = hashlib.sha1(b"blob %d\0" % len(data)); h.update(data); return h.hexdigest()

def hash_file(path, size):
    if size > 256 * 1024 * 1024:
        h = hashlib.sha1(b"blob %d\0" % size)
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest(), None
    with open(path, "rb") as f:
        data = f.read()
    raw = blob_id(data)
    folded = blob_id(data.replace(b"\r\n", b"\n")) if b"\r\n" in data else None
    return raw, folded

def walk(root, skip_prefixes, skip_names):
    files, links, skipped, errors = [], [], [], []
    stack = [""]
    while stack:
        rel_dir = stack.pop()
        abs_dir = os.path.join(root, rel_dir) if rel_dir else root
        try:
            entries = list(os.scandir(abs_dir))
        except OSError as e:
            errors.append([rel_dir, str(e)]); continue
        for e in entries:
            rel = rel_dir + "/" + e.name if rel_dir else e.name
            try:
                if e.is_symlink():
                    links.append({"p": rel, "l": os.readlink(e.path)}); continue
                if e.is_dir():
                    if e.name in skip_names or rel in skip_prefixes:
                        skipped.append(rel)
                    else:
                        stack.append(rel)
                    continue
                st = e.stat(follow_symlinks=False)
                if not stat.S_ISREG(st.st_mode):
                    continue
                raw, folded = hash_file(e.path, st.st_size)
                files.append({"p": rel, "s": st.st_size, "m": "%o" % (st.st_mode & 0o7777), "b": raw, "f": folded})
            except OSError as ex:
                errors.append([rel, str(ex)])
    return {"files": files, "links": links, "skipped": sorted(skipped), "errors": errors}

def main(args):
    out = {"host": socket.gethostname()}
    if args["cmd"] == "walk":
        link = args["release_link"]
        out["release_link_target"] = os.readlink(link) if os.path.islink(link) else None
        root = os.path.realpath(link)
        out["release_root"] = root
        out["release"] = walk(root, tuple(args["skip_prefixes"]), tuple(args["skip_names"]))
        live = args["live_root"]
        if os.path.isdir(live):
            m = os.path.join(live, "manifest.json")
            try:
                with open(m, "rb") as f:
                    out["live_manifest"] = json.loads(f.read().decode("utf-8"))
            except (OSError, ValueError) as e:
                out["live_manifest_error"] = str(e)
            pub = os.path.join(live, "public")
            out["live"] = walk(pub, (), ()) if os.path.isdir(pub) else None
    elif args["cmd"] == "fetch":
        got = {}
        for p in args["paths"]:
            try:
                with open(p, "rb") as f:
                    got[p] = base64.b64encode(f.read()).decode("ascii")
            except OSError as e:
                got[p] = {"error": str(e)}
        out["files"] = got
    sys.stdout.buffer.write(zlib.compress(json.dumps(out).encode("utf-8"), 6))
'''


class Ssh:
    def __init__(self, ssh, jump, key, timeout):
        self.ssh, self.jump, self.key, self.timeout = ssh, jump, key, timeout

    def call(self, ip, args):
        program = REMOTE + "\nmain(json.loads(%r))\n" % json.dumps(args)
        cmd = [self.ssh, "-o", "BatchMode=yes", "-o", "UpdateHostKeys=no", "-o", "ConnectTimeout=15"]
        if self.jump:
            cmd += ["-J", self.jump]
        if self.key:
            cmd += ["-i", self.key]
        cmd += ["root@" + ip, "python3 -"]
        res = subprocess.run(cmd, input=program.encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             timeout=self.timeout)
        if res.returncode != 0:
            raise RuntimeError("ssh %s failed (%d): %s" % (ip, res.returncode, res.stderr.decode("utf-8", "replace")[-2000:]))
        return json.loads(zlib.decompress(res.stdout).decode("utf-8"))


# --------------------------------------------------------------------------- git side
class Git:
    def __init__(self, cwd):
        self.cwd = cwd

    def run(self, *args, input_bytes=None, check=True):
        res = subprocess.run(["git"] + list(args), cwd=self.cwd, input=input_bytes,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if check and res.returncode != 0:
            raise RuntimeError("git %s failed: %s" % (" ".join(args), res.stderr.decode("utf-8", "replace")))
        return res.stdout

    def text(self, *args, **kw):
        return self.run(*args, **kw).decode("utf-8", "replace")

    def rev(self, ref):
        return self.text("rev-parse", "--verify", "-q", ref + "^{commit}", check=False).strip() or None

    def ls_tree(self, commit):
        tree = {}
        for rec in self.run("ls-tree", "-r", "-z", "--full-tree", commit).split(b"\0"):
            if not rec:
                continue
            meta, path = rec.split(b"\t", 1)
            mode, typ, oid = meta.decode().split()
            if typ == "blob":
                tree[path.decode("utf-8", "surrogateescape")] = (mode, oid)
        return tree

    def batch_check(self, specs):
        """spec -> (type, size) or None. Specs may be ids or <rev>:<path>."""
        specs = list(dict.fromkeys(specs))
        if not specs:
            return {}
        out = self.text("cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)",
                        input_bytes=("\n".join(specs) + "\n").encode("utf-8")).splitlines()
        result = {}
        for spec, line in zip(specs, out):
            parts = line.split()
            result[spec] = None if (len(parts) < 3 or parts[-1] == "missing") else (parts[0], parts[1], int(parts[2]))
        return result

    def blobs(self, oids):
        """oid -> bytes, via one cat-file --batch."""
        oids = list(dict.fromkeys(o for o in oids if o))
        if not oids:
            return {}
        data = self.run("cat-file", "--batch", input_bytes=("\n".join(oids) + "\n").encode())
        result, pos = {}, 0
        for oid in oids:
            nl = data.index(b"\n", pos)
            header = data[pos:nl].decode().split()
            pos = nl + 1
            if header[-1] == "missing":
                continue
            size = int(header[2])
            result[oid] = data[pos:pos + size]
            pos += size + 1
        return result

    def reachable_blobs(self, *revs):
        found = {}
        for line in self.text("rev-list", "--objects", *revs).splitlines():
            parts = line.split(" ", 1)
            if len(parts) == 2:
                found.setdefault(parts[0], parts[1])
            else:
                found.setdefault(parts[0], "")
        return found


def blob_id(data):
    h = hashlib.sha1(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def skipped(path):
    parts = path.split("/")
    if any(p in SKIP_NAMES for p in parts[:-1]):
        return True
    return any(path == s or path.startswith(s + "/") for s in SKIP_PREFIXES)


def host_only_group(path):
    if "/" not in path and JUNK_ROOT_RE.search(path):
        return "junk"
    if path.startswith(CODE_PREFIXES):
        return "code"
    return "other"


def is_text(data):
    return b"\0" not in data[:65536]


def lines_of(data):
    return data.replace(b"\r\n", b"\n").decode("utf-8", "replace").split("\n")


# --------------------------------------------------------------------------- audit
class Audit:
    def __init__(self, opts):
        self.opts = opts
        self.git = Git(opts.repo)
        self.ssh = Ssh(opts.ssh, opts.jump, opts.key, opts.timeout)
        self.captured_bytes = 0

    def log(self, msg):
        print(msg, file=sys.stderr, flush=True)

    def prepare_git(self):
        if self.opts.fetch:
            self.log("git fetch origin ...")
            r = subprocess.run(["git", "fetch", "origin", "--prune"], cwd=self.opts.repo,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if r.returncode != 0:
                self.log("warning: git fetch failed: " + r.stderr.decode("utf-8", "replace")[-500:])
        self.canonical = self.git.rev(self.opts.canonical)
        if not self.canonical:
            raise SystemExit("canonical ref not found: " + self.opts.canonical)
        self.log("canonical %s = %s" % (self.opts.canonical, self.canonical))
        self.tree = self.git.ls_tree(self.canonical)
        self.canon_reach = self.git.reachable_blobs(self.canonical)
        self.all_reach = self.git.reachable_blobs("--all")
        refs = self.git.text("for-each-ref", "--format=%(refname)").split()
        self.refs = [r for r in refs if r != "refs/stash"]
        self.unmerged = [r.strip().replace("* ", "").replace("+ ", "").strip() for r in
                         self.git.text("branch", "-a", "--no-merged", self.canonical).splitlines()]
        self.unmerged = [("refs/remotes/" + r[len("remotes/"):]) if r.startswith("remotes/") else
                         ("refs/heads/" + r) for r in self.unmerged if r and "->" not in r]
        self._ref_index = None
        self._release_trees = {}
        self._host_blobs = {}

    def ref_index(self):
        """blob -> refs that reach it but canonical does not (computed once, lazily)."""
        if self._ref_index is None:
            self.log("indexing blobs on refs not merged into canonical (%d refs) ..." % len(self.refs))
            idx = collections.defaultdict(list)
            for ref in self.refs:
                out = self.git.text("rev-list", "--objects", ref, "--not", self.canonical, check=False)
                for line in out.splitlines():
                    oid = line.split(" ", 1)[0]
                    if oid not in self.canon_reach:
                        idx[oid].append(ref.replace("refs/heads/", "").replace("refs/remotes/", ""))
            self._ref_index = idx
        return self._ref_index

    def path_history(self, paths, per_path=300):
        """path -> blob ids that path has had in any commit of any ref (newest first, capped)."""
        hist = collections.defaultdict(list)
        paths = sorted(set(paths))
        for i in range(0, len(paths), 80):
            chunk = paths[i:i + 80]
            out = self.git.run("log", "--all", "--format=", "--raw", "--no-abbrev", "--no-renames", "-z", "--", *chunk)
            recs = out.split(b"\0")
            j = 0
            while j < len(recs) - 1:
                meta = recs[j].decode("utf-8", "replace").strip()
                if not meta.startswith(":"):
                    j += 1
                    continue
                path = recs[j + 1].decode("utf-8", "surrogateescape")
                j += 2
                parts = meta.split()
                for oid in (parts[3], parts[2]):
                    if set(oid) != {"0"} and oid not in hist[path] and len(hist[path]) < per_path:
                        hist[path].append(oid)
        return hist

    def release_tree(self, name):
        if name not in self._release_trees:
            commit = self.git.rev(name) if re.fullmatch(r"[0-9a-f]{7,40}", name or "") else None
            info = {"commit": commit, "tree": None}
            if commit:
                info["tree"] = self.git.ls_tree(commit)
                info["ancestor_of_canonical"] = subprocess.run(
                    ["git", "merge-base", "--is-ancestor", commit, self.canonical], cwd=self.opts.repo).returncode == 0
                info["commits_not_in_canonical"] = int(self.git.text("rev-list", "--count", commit, "--not", self.canonical))
                info["canonical_commits_not_in_release"] = int(self.git.text("rev-list", "--count", self.canonical, "--not", commit))
            self._release_trees[name] = info
        return self._release_trees[name]

    def status_of(self, candidates, exists):
        """Classify blob ids not equal to canonical's: committed-canonical / committed-other-ref / object-only / novel."""
        for oid in candidates:
            if oid and oid in self.canon_reach:
                return "committed-canonical", oid
        for oid in candidates:
            if oid and oid in self.all_reach:
                return "committed-other-ref", oid
        for oid in candidates:
            if oid and exists.get(oid):
                return "object-only", oid
        return "novel", None

    # ---- per role
    def walk_role(self, role):
        ip = self.opts.hosts[role]
        self.log("[%s] walking %s on %s ..." % (role, RELEASE_LINK, ip))
        data = self.ssh.call(ip, {"cmd": "walk", "release_link": RELEASE_LINK, "live_root": LIVE_ROOT,
                                  "skip_prefixes": list(SKIP_PREFIXES), "skip_names": list(SKIP_NAMES)})
        self.log("[%s] %d files, %d symlinks from %s" % (role, len(data["release"]["files"]),
                                                         len(data["release"]["links"]), data["release_root"]))
        return data

    def classify(self, role, data):
        rel = data["release"]
        release_name = os.path.basename(data["release_root"])
        rinfo = self.release_tree(release_name)
        rtree = rinfo.get("tree") or {}
        host_files = {f["p"]: f for f in rel["files"]}
        host_links = {l["p"]: l for l in rel["links"]}
        self._host_blobs[role] = {p: (f["b"], f["f"]) for p, f in host_files.items()}

        need = set()
        for f in rel["files"]:
            c = self.tree.get(f["p"])
            if c and c[1] in (f["b"], f["f"]):
                continue
            need.update(x for x in (f["b"], f["f"]) if x)
        exists = {k: v is not None for k, v in self.git.batch_check(need).items()}

        entries, counts = [], collections.Counter()
        for path in sorted(host_files):
            f = host_files[path]
            c = self.tree.get(path)
            e = {"path": path, "size": f["s"], "mode": f["m"], "blob": f["b"]}
            if f["f"]:
                e["blob_lf"] = f["f"]
            if c:
                e["canonical_blob"] = c[1]
                if c[0] == "100755" and not int(f["m"], 8) & 0o100:
                    e["mode_note"] = "canonical is executable"
                if c[1] in (f["b"], f["f"]):
                    counts["same"] += 1
                    continue
                cls, via = self.status_of([f["b"], f["f"]], exists)
            else:
                group = host_only_group(path)
                e["group"] = group
                st, via = self.status_of([f["b"], f["f"]], exists)
                if st == "novel":
                    st = "never-committed"
                cls = "host-only-%s:%s" % (group, st)
            e["class"] = cls
            if via:
                e["matched_blob"] = via
                if via in self.canon_reach and self.canon_reach[via] and self.canon_reach[via] != path:
                    e["canonical_history_path"] = self.canon_reach[via]
            rb = rtree.get(path)
            if rtree:
                e["release_commit_blob"] = rb[1] if rb else None
                e["equals_release_commit"] = bool(rb and rb[1] in (f["b"], f["f"]))
            if GENERATED_HINT_RE.search(path):
                e["generated_hint"] = True
            counts[cls] += 1
            entries.append(e)

        if any(e["class"] == "committed-other-ref" or e["class"].endswith(":committed-other-ref") for e in entries):
            idx = self.ref_index()
            for e in entries:
                if e.get("matched_blob") and (e["class"] == "committed-other-ref" or e["class"].endswith(":committed-other-ref")):
                    refs = sorted(set(idx.get(e["matched_blob"], [])))
                    e["refs"] = refs[:8]
                    e["ref_count"] = len(refs)

        links = []
        for path in sorted(host_links):
            target = host_links[path]["l"]
            c = self.tree.get(path)
            st = "host-only"
            if c:
                st = "same" if (c[0] == "120000" and c[1] == blob_id(target.encode("utf-8"))) else "differs"
            links.append({"path": path, "target": target, "status": st})
            counts["symlink-" + st] += 1

        missing = sorted(p for p in self.tree if p not in host_files and p not in host_links and not skipped(p))
        counts["missing-on-host"] = len(missing)
        missing_by_top = collections.Counter(p.split("/", 1)[0] if "/" in p else "(root)" for p in missing)

        return {
            "ip": self.opts.hosts[role], "host": data.get("host"), "release_root": data["release_root"],
            "release_link_target": data.get("release_link_target"),
            "release_commit": {k: v for k, v in rinfo.items() if k != "tree"},
            "file_count": len(host_files), "symlink_count": len(host_links),
            "skipped_dirs": rel["skipped"], "walk_errors": rel["errors"],
            "counts": dict(sorted(counts.items())), "entries": entries, "symlinks": links,
            "missing_on_host": missing, "missing_on_host_by_top": dict(missing_by_top.most_common()),
        }

    def classify_live(self, data, release_report):
        manifest = data.get("live_manifest") or {}
        live = data.get("live") or {"files": [], "links": []}
        live_files = {f["p"]: f for f in live["files"]}
        release_files = {e["path"]: e for e in release_report["entries"]}
        mfiles = manifest.get("files", {})
        need = set()
        for f in live["files"]:
            need.update(x for x in (f["b"], f["f"]) if x)
        exists = {k: v is not None for k, v in self.git.batch_check(need).items()}
        out, counts = [], collections.Counter()
        for rel in sorted(set(live_files) | set(mfiles)):
            path = "public/" + rel
            f, m = live_files.get(rel), mfiles.get(rel)
            e = {"path": path, "rel": rel, "manifest": m}
            if not f:
                e["class"] = "manifest-entry-without-file"
            else:
                e.update({"size": f["s"], "blob": f["b"], "blob_lf": f["f"]})
                c = self.tree.get(path)
                e["canonical_blob"] = c[1] if c else None
                if c and c[1] in (f["b"], f["f"]):
                    e["class"] = "same"
                else:
                    cls, via = self.status_of([f["b"], f["f"]], exists)
                    e["class"] = cls if c else "host-only:" + cls
                    if via:
                        e["matched_blob"] = via
                e["in_manifest"] = bool(m)
                rel_entry = release_files.get(path)
                e["release_blob"] = rel_entry["blob"] if rel_entry else (e["canonical_blob"] if path in self.tree else None)
            counts[e["class"]] += 1
            out.append(e)
        if any("committed-other-ref" in e["class"] for e in out):
            idx = self.ref_index()
            for e in out:
                if "committed-other-ref" in e["class"]:
                    e["refs"] = sorted(set(idx.get(e["matched_blob"], [])))[:8]
        return {"manifest_at": manifest.get("at"), "manifest_error": data.get("live_manifest_error"),
                "counts": dict(sorted(counts.items())), "files": out}

    # ---- capture and provenance
    def capture(self, role, ip, root, entries, subdir):
        """Fetch bytes of the given entries from the host and write them under out/<subdir>/."""
        todo, skipped_big = [], []
        for e in entries:
            size = e.get("size", 0)
            if size > self.opts.max_file or self.captured_bytes + size > self.opts.capture_limit:
                skipped_big.append(e["path"])
                e["capture"] = "skipped (size limit)"
                continue
            self.captured_bytes += size
            todo.append(e)
        got = {}
        batch, batch_size = [], 0
        for e in todo + [None]:
            if e is not None:
                batch.append(e)
                batch_size += e.get("size", 0)
            if batch and (e is None or batch_size > 20 * 1024 * 1024):
                remote_paths = [root.rstrip("/") + "/" + (b.get("rel") or b["path"]) for b in batch]
                res = self.ssh.call(ip, {"cmd": "fetch", "paths": remote_paths})["files"]
                for b, rp in zip(batch, remote_paths):
                    got[b["path"]] = res.get(rp)
                batch, batch_size = [], 0
        for e in todo:
            v = got.get(e["path"])
            if not isinstance(v, str):
                e["capture"] = "error: %s" % (v or {}).get("error", "missing")
                continue
            data = base64.b64decode(v)
            if blob_id(data) != e["blob"]:
                e["capture"] = "changed on host since walk (captured anyway)"
                e["captured_blob"] = blob_id(data)
            dest = os.path.join(self.opts.out, subdir, *e["path"].split("/"))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as fh:
                fh.write(data)
            e.setdefault("capture", "ok")
            e["captured_to"] = os.path.relpath(dest, self.opts.out).replace(os.sep, "/")
            e["_bytes"] = data
        return skipped_big

    def provenance(self, role, entries, release_commit):
        """For captured novel bytes: diff against canonical and look for the added lines on unmerged refs."""
        specs = []
        refs = self.unmerged + ([release_commit] if release_commit else [])
        for e in entries:
            if "_bytes" not in e:
                continue
            specs += ["%s:%s" % (r, e["path"]) for r in refs]
        found = self.git.batch_check(specs)
        ref_blobs = collections.defaultdict(dict)  # path -> blob -> [refs]
        for spec, v in found.items():
            if v and v[1] == "blob":
                ref, path = spec.split(":", 1)
                ref_blobs[path].setdefault(v[0], []).append(ref.replace("refs/heads/", "").replace("refs/remotes/", ""))
        history = self.path_history([e["path"] for e in entries if "_bytes" in e])
        wanted = ([e.get("canonical_blob") for e in entries] + [b for d in ref_blobs.values() for b in d]
                  + [b for s in history.values() for b in s])
        contents = self.git.blobs(wanted)
        host_blobs = self._host_blobs.get(role, {})
        for e in entries:
            data = e.pop("_bytes", None)
            if data is None:
                continue
            if e["path"].endswith(".gz"):
                try:
                    plain = gzip.decompress(data)
                    sib = e["path"][:-3]
                    pb = blob_id(plain)
                    e["gunzip_blob"] = pb
                    e["gunzip_matches"] = ("host sibling" if pb in host_blobs.get(sib, ()) else
                                           "canonical sibling" if self.tree.get(sib, (0, 0))[1] == pb else
                                           "a committed version" if pb in self.all_reach else "nothing in git")
                except (OSError, EOFError) as ex:
                    e["gunzip_error"] = str(ex)
                continue
            if not is_text(data):
                e["binary"] = True
                continue
            host_lines = lines_of(data)
            canon = contents.get(e.get("canonical_blob"))
            canon_lines = lines_of(canon) if canon is not None else []
            if canon is not None:
                diff = list(difflib.unified_diff(canon_lines, host_lines, "canonical/" + e["path"], "host/" + e["path"],
                                                 lineterm="", n=3))
                dest = os.path.join(self.opts.out, *e["captured_to"].split("/")) + ".diff"
                with open(dest, "w", encoding="utf-8", newline="\n") as fh:
                    fh.write("\n".join(diff) + "\n")
                e["diff_to"] = e["captured_to"] + ".diff"
                e["diff_added"] = sum(1 for l in diff if l.startswith("+") and not l.startswith("+++"))
                e["diff_removed"] = sum(1 for l in diff if l.startswith("-") and not l.startswith("---"))
            canon_set = set(canon_lines)
            added = [l for l in host_lines if l not in canon_set and l.strip()]
            e["lines_not_in_canonical"] = len(added)
            candidates = ref_blobs.get(e["path"], {})
            union, best = set(), None
            hc = collections.Counter(host_lines)
            for oid, rlist in candidates.items():
                c = contents.get(oid)
                if c is None:
                    continue
                cl = lines_of(c)
                union.update(cl)
                dist = sum((hc - collections.Counter(cl)).values()) + sum((collections.Counter(cl) - hc).values())
                if best is None or dist < best[0]:
                    best = (dist, rlist)
            unexplained = [l for l in added if l not in union]
            e["lines_unexplained_by_refs"] = len(unexplained)
            ever = set(union)
            hbest = None
            for oid in history.get(e["path"], ()):
                c = contents.get(oid)
                if c is None:
                    continue
                cl = lines_of(c)
                ever.update(cl)
                dist = sum((hc - collections.Counter(cl)).values()) + sum((collections.Counter(cl) - hc).values())
                if hbest is None or dist < hbest[0]:
                    hbest = (dist, oid)
            never = [l for l in added if l not in ever]
            e["lines_in_no_committed_version"] = len(never)
            e["new_line_sample"] = [l.strip()[:160] for l in never[:6]]
            e["history_versions"] = len(history.get(e["path"], ()))
            if hbest:
                e["closest_version_line_distance"] = hbest[0]
                e["closest_version_blob"] = hbest[1]
                e["closest_version_on_canonical"] = hbest[1] in self.canon_reach
            if best:
                e["closest_ref_line_distance"] = best[0]
                e["closest_refs"] = sorted(best[1])[:6]
            e["refs_with_path"] = len(candidates)

    # ---- driver
    def run(self):
        self.prepare_git()
        roles = self.opts.roles
        walks = {}
        with concurrent.futures.ThreadPoolExecutor(len(roles)) as pool:
            futs = {pool.submit(self.walk_role, r): r for r in roles}
            for fut in concurrent.futures.as_completed(futs):
                walks[futs[fut]] = fut.result()
        report = {"generated_at": self.opts.stamp, "canonical_ref": self.opts.canonical, "canonical": self.canonical,
                  "repo": os.path.abspath(self.opts.repo), "skip_prefixes": SKIP_PREFIXES, "skip_names": SKIP_NAMES,
                  "unmerged_ref_count": len(self.unmerged), "roles": {}}
        for role in roles:
            data = walks[role]
            r = self.classify(role, data)
            report["roles"][role] = r
            if data.get("live") is not None or data.get("live_manifest"):
                r["live"] = self.classify_live(data, r)
            if self.opts.capture:
                grab = [e for e in r["entries"] if e["class"] in ("novel", "object-only")
                        or (e["class"].startswith("host-only-") and e.get("group") != "junk"
                            and e["class"].split(":")[1] in ("never-committed", "object-only"))]
                self.capture(role, r["ip"], r["release_root"], grab, role)
                self.provenance(role, grab, r["release_commit"].get("commit"))
                if r.get("live"):
                    lv = [e for e in r["live"]["files"] if "size" in e]
                    self.capture(role, r["ip"], LIVE_ROOT + "/public", lv, role + "-live")
                    self.provenance(role, [e for e in lv if e["class"] != "same"], None)
                    for e in lv:
                        e.pop("_bytes", None)
        report["captured_bytes"] = self.captured_bytes
        return report


# --------------------------------------------------------------------------- output
def summary_md(report):
    out = ["# Dev drift audit %s" % report["generated_at"], "",
           "Canonical `%s` = `%s`; %d refs not merged into it." % (report["canonical_ref"], report["canonical"],
                                                                    report["unmerged_ref_count"]), ""]
    for role, r in report["roles"].items():
        rc = r["release_commit"]
        out += ["## %s (%s)" % (role, r["ip"]), "",
                "Release `%s`: %d files, %d symlinks. Release commit in git: %s%s." % (
                    r["release_root"], r["file_count"], r["symlink_count"], bool(rc.get("commit")),
                    (", ancestor of canonical: %s, %d commits not in canonical, canonical %d ahead" % (
                        rc.get("ancestor_of_canonical"), rc.get("commits_not_in_canonical", 0),
                        rc.get("canonical_commits_not_in_release", 0))) if rc.get("commit") else ""), ""]
        out += ["| class | count |", "|---|---|"] + ["| %s | %d |" % kv for kv in r["counts"].items()] + [""]
        novel = [e for e in r["entries"] if e["class"] in ("novel", "object-only")]
        if novel:
            out += ["### Novel content (in canonical's tree, bytes in no reachable git object)", ""]
            for e in novel:
                out.append("- `%s` %s: +%s/-%s vs canonical; %s lines not in canonical, %s not on any unmerged tip, "
                           "%s in no committed version of the path%s" % (
                    e["path"], e["class"], e.get("diff_added", "?"), e.get("diff_removed", "?"),
                    e.get("lines_not_in_canonical", "?"), e.get("lines_unexplained_by_refs", "?"),
                    e.get("lines_in_no_committed_version", "?"), " (generated?)" if e.get("generated_hint") else ""))
            out.append("")
        ho = [e for e in r["entries"] if e["class"].startswith("host-only-") and e.get("group") != "junk"]
        if ho:
            out += ["### Host-only paths (not junk)", ""]
            for e in ho:
                extra = (" refs: " + ", ".join(e["refs"])) if e.get("refs") else ""
                if e.get("gunzip_matches"):
                    extra += " (gunzip matches %s)" % e["gunzip_matches"]
                elif "lines_in_no_committed_version" in e:
                    extra += " (%s lines in no committed version)" % e["lines_in_no_committed_version"]
                out.append("- `%s` %s%s" % (e["path"], e["class"], extra))
            out.append("")
        junk = [e["path"] for e in r["entries"] if e.get("group") == "junk"]
        if junk:
            out += ["Release-root rollout records (no carry-forward): %d files." % len(junk), ""]
        if r["missing_on_host_by_top"]:
            out += ["Missing on host by top directory: " + ", ".join("%s %d" % kv for kv in r["missing_on_host_by_top"].items()), ""]
        lv = r.get("live")
        if lv:
            out += ["### Live layer (manifest %s)" % lv.get("manifest_at"), ""]
            for e in lv["files"]:
                m = e.get("manifest") or {}
                out.append("- `%s` %s; source %s%s" % (e["path"], e["class"], m.get("source", "-"),
                                                     (", %s lines in no committed version" % e["lines_in_no_committed_version"])
                                                     if "lines_in_no_committed_version" in e else ""))
            out.append("")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--canonical", default=DEFAULT_CANONICAL)
    ap.add_argument("--roles", default="web,worker,legacy")
    ap.add_argument("--out", default=None, help="default output/rebaseline-<UTC date>")
    ap.add_argument("--repo", default=".", help="git checkout to compare with (default: cwd)")
    ap.add_argument("--host", action="append", default=[], metavar="ROLE=IP")
    ap.add_argument("--jump", default=DEFAULT_JUMP)
    ap.add_argument("--key", default=DEFAULT_KEY)
    ap.add_argument("--ssh", default="ssh")
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--no-fetch", dest="fetch", action="store_false")
    ap.add_argument("--no-capture", dest="capture", action="store_false")
    ap.add_argument("--capture-limit", type=int, default=200 * 1024 * 1024)
    ap.add_argument("--max-file", type=int, default=25 * 1024 * 1024)
    opts = ap.parse_args()
    now = datetime.datetime.now(datetime.timezone.utc)
    opts.stamp = now.strftime("%Y%m%dT%H%M%SZ")
    opts.out = opts.out or os.path.join("output", "rebaseline-" + now.strftime("%Y%m%d"))
    opts.hosts = dict(DEFAULT_HOSTS)
    for h in opts.host:
        k, _, v = h.partition("=")
        opts.hosts[k] = v
    opts.roles = [r.strip() for r in opts.roles.split(",") if r.strip()]
    unknown = [r for r in opts.roles if r not in opts.hosts]
    if unknown:
        raise SystemExit("no host for role(s): " + ", ".join(unknown))
    os.makedirs(opts.out, exist_ok=True)

    report = Audit(opts).run()
    jpath = os.path.join(opts.out, "audit-%s.json" % opts.stamp)
    mpath = os.path.join(opts.out, "audit-%s.md" % opts.stamp)
    with open(jpath, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1, sort_keys=False)
    with open(mpath, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(summary_md(report))

    for role, r in report["roles"].items():
        print("%s  %s  release %s" % (role, r["ip"], os.path.basename(r["release_root"])))
        for k, v in r["counts"].items():
            print("    %-45s %d" % (k, v))
        if r.get("live"):
            print("    live layer: " + ", ".join("%s %d" % kv for kv in r["live"]["counts"].items()))
    print("captured %.1f MB" % (report["captured_bytes"] / 1048576.0))
    print("wrote " + jpath)
    print("wrote " + mpath)


if __name__ == "__main__":
    main()
