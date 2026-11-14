#!/usr/bin/env python3
"""Delete old FirstMeasure release directories so a node's disk never fills.

Keeps the active release (/opt/firstmeasure/current), anything another symlink
in /opt/firstmeasure points at, any release a running process still uses (its
working directory, executable, open files or mapped files; compatibility's
cluster primary keeps running from the release it started in across rolling
replaces), every release changed in the last two hours
(an install or activation may be in flight) and the newest KEEP releases. If
free space is still below --min-free-percent, it keeps only the active release
and the newest other one, so a rollback target always survives. Abandoned
install staging folders older than a day are removed too.

Runs after every activation, before every artifact install and hourly from
firstmeasure-release-prune.timer. Never fails a release: errors are printed
and the exit code is 0 unless --strict is given.
"""
import argparse
import os
import re
import shutil
import sys
import time
from pathlib import Path

# Only full commit ids, the names release-artifact.py installs. Hand-made folders
# (cluster-v1.0.0, preprod-r1-..., short ids) are never touched.
RELEASE_NAME = re.compile(r'^[0-9a-f]{40}$')
STAGING_NAME = re.compile(r'^\.(release-install-.*|.+\.installing\.\d+)$')
RECENT_SECONDS = 2 * 3600
STAGING_SECONDS = 24 * 3600


def free_percent(path):
    usage = shutil.disk_usage(path)
    return 100.0 * usage.free / usage.total


def protected_targets(root, releases):
    """Releases any symlink directly under root points at (current, previous...)."""
    keep = set()
    for entry in root.iterdir():
        if entry.is_symlink():
            target = Path(os.path.realpath(entry))
            if target.parent == Path(os.path.realpath(releases)):
                keep.add(target.name)
    return keep


def in_use(releases, proc=Path('/proc')):
    """Releases any running process has as cwd, executable, open file or mapping."""
    prefix = os.path.realpath(releases) + os.sep
    used = set()
    if not proc.is_dir():
        return used

    def note(path):
        if path.startswith(prefix):
            used.add(path[len(prefix):].split(os.sep, 1)[0].split(' ', 1)[0])

    for pid in proc.iterdir():
        if not pid.name.isdigit():
            continue
        try:
            for link in ('cwd', 'exe', 'root'):
                try:
                    note(os.readlink(pid / link))
                except OSError:
                    pass
            try:
                for fd in (pid / 'fd').iterdir():
                    try:
                        note(os.readlink(fd))
                    except OSError:
                        pass
            except OSError:
                pass
            try:
                with open(pid / 'maps', errors='replace') as maps:
                    for line in maps:
                        parts = line.split(None, 5)
                        if len(parts) == 6:
                            note(parts[5].strip())
            except OSError:
                pass
        except Exception:
            continue
    return used


def plan(root, keep_count, now, emergency=False, proc=Path('/proc')):
    releases = root / 'releases'
    if not releases.is_dir():
        return [], []
    protected = protected_targets(root, releases) | in_use(releases, proc)
    candidates = []
    stale_staging = []
    for entry in releases.iterdir():
        if entry.is_symlink() or not entry.is_dir():
            continue
        age = now - entry.stat().st_mtime
        if STAGING_NAME.match(entry.name):
            if age > STAGING_SECONDS:
                stale_staging.append(entry)
            continue
        if not RELEASE_NAME.match(entry.name):
            continue
        candidates.append((entry.stat().st_mtime, entry))
    candidates.sort(key=lambda item: item[0], reverse=True)
    # Symlinked releases are always kept. Others fill the remaining slots, newest
    # first; at least one survives as a rollback target. Emergency keeps just one.
    present = sum(1 for _, entry in candidates if entry.name in protected)
    others = 1 if emergency else max(keep_count - present, 1)
    remove = []
    for mtime, entry in candidates:
        if entry.name in protected:
            continue
        if others > 0 or (not emergency and now - mtime < RECENT_SECONDS):
            others -= 1
            continue
        remove.append(entry)
    return remove, stale_staging


def prune(root, keep_count, min_free_percent, dry_run=False, now=None, proc=Path('/proc')):
    now = time.time() if now is None else now
    removed = []
    for emergency in (False, True):
        if emergency and free_percent(root) >= min_free_percent:
            break
        remove, staging = plan(root, keep_count, now, emergency, proc)
        for entry in remove + staging:
            removed.append(entry.name)
            print(('would remove ' if dry_run else 'removing ') + str(entry), flush=True)
            if not dry_run:
                shutil.rmtree(entry, ignore_errors=True)
    level = free_percent(root)
    if level < min_free_percent:
        print(f'WARNING: only {level:.1f}% free on {root} after pruning releases; '
              'something other than releases is filling the disk.', file=sys.stderr, flush=True)
    return removed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('/opt/firstmeasure'))
    parser.add_argument('--keep', type=int, default=4, help='newest releases to keep, including the active one')
    parser.add_argument('--min-free-percent', type=float, default=15.0)
    parser.add_argument('--only-below-free-percent', type=float,
                        help='do nothing unless free space is below this percentage')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--strict', action='store_true', help='exit non-zero on errors')
    args = parser.parse_args()
    if args.keep < 2:
        parser.error('--keep must be at least 2 so a rollback target survives')
    try:
        if not args.root.is_dir():
            return 0
        if args.only_below_free_percent is not None and free_percent(args.root) >= args.only_below_free_percent:
            return 0
        lock_path = args.root / '.release-prune.lock'
        import fcntl  # Linux only; imported here so the module loads anywhere
        with open(lock_path, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            prune(args.root, args.keep, args.min_free_percent, args.dry_run)
        return 0
    except Exception as error:  # never break a release over housekeeping
        print(f'prune-releases failed: {error}', file=sys.stderr, flush=True)
        return 1 if args.strict else 0


if __name__ == '__main__':
    sys.exit(main())
