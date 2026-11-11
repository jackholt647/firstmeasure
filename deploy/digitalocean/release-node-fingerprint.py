#!/usr/bin/env python3
"""Decide whether a production release can skip the Node restart (FM-388).

A release whose Node side is byte-identical to the release Node is running can be
activated by switching `current` and reloading PHP-FPM: NGINX and PHP read files
through `current` on every request, and Node keeps running the code it would
restart into. See DEPLOYMENT.md, "Production run fast path".

Node does not read only its build. It resolves its release directory once, at start
(systemd's WorkingDirectory and import.meta.url are real paths), and reads files
outside public/v1/dist from there for as long as it runs: the PDF runtime's editor
scripts, libraries, fonts, portal landing pages, the solar key in editor.php. So the
Node side of a release is everything in it EXCEPT the paths only NGINX and PHP-FPM
serve (STATIC_ONLY), minus the files Node reads inside those (NODE_READS). Anything
not listed is Node's, so an unknown file forces the full procedure, never the reverse.
The release's own public/v1 sources are scanned too: a source file outside READERS
that builds a path into measure/ or portal/ refuses the fast path, and
tests/release-fast-path.test.mjs fails on canonical until it is classified here.

  fingerprint RELEASE      JSON fingerprints of a release directory or .tar.gz
  compare RUNNING NEW      exit 0 if NEW can be activated without restarting Node
                           (RUNNING = the release Node started in), 3 if not
  readers TREE             public/v1 sources in a checkout that read into measure/ or portal/
  classify NAME...         how each release path is treated (identity, key, static, node)
  rules                    the classification lists as JSON

Never prints file contents. Key sources are compared by a digest of the key lines.
"""
import hashlib
import json
import os
import re
import sys
import tarfile
from pathlib import Path

# Release identity, different in every release; Node keeps the RELEASE_ID it started with.
IDENTITY = {'release.env', '.release-artifact.json'}

# Served only by NGINX and PHP-FPM through /opt/firstmeasure/current, or deploy tooling
# that no service reads.
STATIC_ONLY = ('public/measure/internal/', 'public/portal/', 'deploy/')

# Files under STATIC_ONLY that Node reads (paths relative to the release root).
NODE_READS = (
    # firstmeasure/pdf_runtime.ts: the shared PDF runtime loads and serves these.
    'public/measure/internal/editor_scripts/pdf.js',
    'public/measure/internal/editor_scripts/pdf_standalone.js',
    'public/measure/internal/editor_scripts/exterior_geometry.js',
    'public/measure/internal/editor_scripts/exterior_pdf.js',
    'public/measure/internal/editor_scripts/vendor/',
    # firstmeasure/api.ts, queue.ts, apple.ts, internal/data_agent.ts: legacy config and data.
    'public/measure/internal/config/',
    'public/measure/internal/users/',
    'public/measure/internal/organizations/',
    'public/measure/internal/storage/',
    'public/measure/internal/apple_key.json',
    # internal/crm/api.ts: lists and reads the landing pages.
    'public/portal/landing/',
)

# The public/v1 source files that build filesystem paths into measure/ or portal/; each read
# is classified above (most are runtime storage, which is never in a release).
READERS = (
    'public/v1/firstmeasure/api.ts',
    'public/v1/firstmeasure/apple.ts',
    'public/v1/firstmeasure/pdf_runtime.ts',
    'public/v1/firstmeasure/queue.ts',
    'public/v1/forms/solar.ts',
    'public/v1/internal/api.ts',
    'public/v1/internal/crm/api.ts',
    'public/v1/internal/data_agent.ts',
)
READ_PATTERN = re.compile(rb'path\.(?:join|resolve)\([^\n]*[\'"](?:\.\./)*(?:measure|portal)\b'
                          rb'|rootFolderName:\s*[\'"]measure'
                          rb'|new URL\(\s*[\'"](?:\.\./)+(?:measure|portal)/')
SOURCE = re.compile(r'public/v1/(?!node_modules/|dist/|tests/|scripts/|src/scripts/).*\.(?:ts|mts|mjs|js|cjs)$')

# forms/solar.ts reads only the Google key from these (once, then caches it): a change
# elsewhere in them is static, a change to the key line is Node's.
KEY_SOURCES = (
    'public/measure/internal/editor.php',
    'public/measure/internal/index.php',
    'public/measure/internal/main.js',
    'public/measure/internal/editor_scripts/main.js',
)
KEY_PATTERNS = (
    re.compile(rb'\$GOOGLE_API_KEY\s*=\s*(?:\$GLOBALS\[[\'"]GOOGLE_API_KEY[\'"]\]\s*\?\?\s*)?[\'"]([^\'"]+)[\'"]'),
    re.compile(rb'\bGOOGLE_API_KEY\s*=\s*[\'"]([^\'"]+)[\'"]'),
    re.compile(rb'define\(\s*[\'"]TERRITORY_GOOGLE_API_KEY[\'"]\s*,\s*[\'"]([^\'"]+)[\'"]\s*\)'),
)


def classify(name):
    """'identity', 'key' (static except its key), 'static' or 'node'."""
    if name in IDENTITY:
        return 'identity'
    if name in KEY_SOURCES:
        return 'key'
    if not name.startswith(STATIC_ONLY):
        return 'node'
    if any(name == entry or (entry.endswith('/') and name.startswith(entry)) for entry in NODE_READS):
        return 'node'
    return 'static'


def group(name):
    """Which part of the Node side a file belongs to, for the report."""
    if name.startswith('public/v1/dist/'):
        return 'server'
    if name.startswith('public/v1/node_modules/') or name in {'public/v1/package.json', 'public/v1/package-lock.json'}:
        return 'dependencies'
    if name.startswith('public/v1/'):
        return 'configuration'
    return 'other'


def key_digest(content):
    """Digest of the key the solar form would read, never the key itself."""
    for pattern in KEY_PATTERNS:
        match = pattern.search(content)
        if match and match.group(1).strip():
            return hashlib.sha256(match.group(1).strip()).hexdigest()
    return 'none'


def contents(release):
    """(name, bytes) for every regular file in a release directory or archive."""
    release = Path(release)
    if release.is_dir():
        for path in sorted(release.rglob('*')):
            if path.is_file() and not path.is_symlink():
                yield path.relative_to(release).as_posix(), path.read_bytes()
        return
    with tarfile.open(release, 'r:*') as archive:
        for member in archive:
            if member.isfile():
                yield member.name.removeprefix('./'), archive.extractfile(member).read()


def index(release):
    """{name: (sha256, key digest or None)} and the public/v1 sources that read into measure/ or portal/."""
    files, readers = {}, set()
    for name, content in contents(release):
        files[name] = (hashlib.sha256(content).hexdigest(), key_digest(content) if name in KEY_SOURCES else None)
        if SOURCE.match(name) and READ_PATTERN.search(content):
            readers.add(name)
    if not files:
        raise SystemExit(f'no files in {release}')
    return files, readers


def fingerprints(files):
    hashes = {part: hashlib.sha256() for part in ('server', 'dependencies', 'configuration', 'other', 'node')}
    counts = {'node': 0, 'static': 0, 'key': 0, 'identity': 0}
    for name in sorted(files):
        digest, key = files[name]
        kind = classify(name)
        counts[kind] += 1
        if kind == 'node':
            line = f'{name}\0{digest}\n'.encode()
            hashes[group(name)].update(line)
            hashes['node'].update(line)
        elif kind == 'key':
            hashes['node'].update(f'{name}\0key:{key}\n'.encode())
    return {part: h.hexdigest() for part, h in hashes.items()}, counts


def fingerprint(release):
    files, readers = index(release)
    prints, counts = fingerprints(files)
    return {'release': str(release), **prints, 'files': counts, 'unclassified_readers': sorted(readers - set(READERS))}


def compare(running, new):
    (old_files, _), (new_files, readers) = index(running), index(new)
    unclassified = sorted(readers - set(READERS))
    old_prints, _ = fingerprints(old_files)
    new_prints, _ = fingerprints(new_files)
    changed = sorted(name for name in set(old_files) | set(new_files)
                     if classify(name) != 'identity' and old_files.get(name, (None,))[0] != new_files.get(name, (None,))[0])
    node, static = [], []
    for name in changed:
        kind = classify(name)
        if kind == 'node' or (kind == 'key' and old_files.get(name, (None, None))[1] != new_files.get(name, (None, None))[1]):
            node.append(name)
        else:
            static.append(name)
    fast = not node and not unclassified and old_prints['node'] == new_prints['node']
    return {
        'fast_path': fast,
        'running': str(running), 'new': str(new),
        'node': {'running': old_prints['node'], 'new': new_prints['node']},
        'server': {'running': old_prints['server'], 'new': new_prints['server']},
        'dependencies_same': old_prints['dependencies'] == new_prints['dependencies'],
        'configuration_same': old_prints['configuration'] == new_prints['configuration'],
        'changed': len(changed),
        'changed_node': node[:50],
        'changed_node_count': len(node),
        # Sources that read files under STATIC_ONLY and are not in READERS: classify them first.
        'unclassified_readers': unclassified,
        # Paths of changed static files, removed ones included (they 404 after the switch).
        'changed_static': static,
        'removed': sorted(set(old_files) - set(new_files) - IDENTITY)[:50],
    }


def main(argv):
    if len(argv) == 2 and argv[1] == 'rules':
        print(json.dumps({'identity': sorted(IDENTITY), 'static_only': STATIC_ONLY, 'node_reads': NODE_READS, 'key_sources': KEY_SOURCES, 'readers': READERS}))
        return 0
    if len(argv) == 3 and argv[1] == 'readers':
        root, found = Path(argv[2]), []
        for folder, subfolders, names in os.walk(root / 'public/v1'):
            subfolders[:] = [x for x in subfolders if x not in {'node_modules', 'dist'}]
            for name in names:
                relative = (Path(folder) / name).relative_to(root).as_posix()
                if SOURCE.match(relative) and READ_PATTERN.search((root / relative).read_bytes()):
                    found.append(relative)
        found.sort()
        print(json.dumps({'readers': found, 'unclassified': sorted(set(found) - set(READERS))}))
        return 0
    if len(argv) >= 3 and argv[1] == 'classify':
        print(json.dumps({name: classify(name) for name in argv[2:]}))
        return 0
    if len(argv) == 3 and argv[1] == 'fingerprint':
        print(json.dumps(fingerprint(argv[2]), indent=2))
        return 0
    if len(argv) == 4 and argv[1] == 'compare':
        result = compare(argv[2], argv[3])
        print(json.dumps(result, indent=2))
        return 0 if result['fast_path'] else 3
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
