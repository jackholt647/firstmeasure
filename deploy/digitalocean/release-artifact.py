#!/usr/bin/env python3
"""Package reviewed Linux runtime code, or safely install a verified archive.

Never packages a working tree recursively. Source paths come from a specific
Git commit; compiled output and production dependencies come from its reviewed
Linux staging directory. Does not activate services or touch runtime data.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile


def safe_name(name):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name or p.as_posix() != name:
        raise ValueError('Unsafe archive path')
    if any(x in {'.git', 'private', 'storage', 'secrets', '.local-runtime'} for x in p.parts):
        raise ValueError('Runtime state or secret directory in code archive')
    if p.name == '.env' or p.name.startswith('.env.') or p.suffix.lower() in {'.pem', '.key', '.sqlite', '.db', '.zip'}:
        raise ValueError('Private or nested archive file in code archive')
    if '.sqlite-' in p.name or '.db-' in p.name or p.name in {'provider-keys.json', 'credentials.json', 'pm_server_token.txt'}:
        raise ValueError('Credential or database file in code archive')
    return p


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def validate_manifest(m):
    if m.get('schema') != 1 or m.get('environment') != 'production' or m.get('role') != 'web':
        raise ValueError('Unsupported release manifest')
    if not re.fullmatch('[a-f0-9]{40}', m.get('release_id', '')) or not re.fullmatch('[a-f0-9]{64}', m.get('sha256', '')):
        raise ValueError('Invalid release identity')
    if m.get('platform') != 'linux-x64' or type(m.get('size')) is not int or not 0 < m['size'] <= 2_000_000_000:
        raise ValueError('Unsupported artifact platform or size')
    return m


def package(repo, stage, commit, out):
    commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', commit + '^{commit}'], text=True).strip()
    tracked = subprocess.check_output(['git', '-C', str(repo), 'ls-tree', '-rz', '--name-only', commit]).decode().split('\0')
    names = set()
    for name in filter(None, tracked):
        try:
            safe_name(name)
        except ValueError:
            continue
        if name.startswith(('public/', 'deploy/')):
            names.add(name)
    for relative in ('public/v1/dist', 'public/v1/node_modules'):
        folder = stage / relative
        if not folder.is_dir():
            raise ValueError('Missing compiled Linux runtime or dependencies')
        for path in folder.rglob('*'):
            if path.is_file() and '.bin' not in path.relative_to(stage).parts:
                names.add(path.relative_to(stage).as_posix())
    required = {'public/v1/dist/src/server.js', 'public/v1/package-lock.json', 'public/v1/node_modules/pg/package.json'}
    if not required <= names:
        raise ValueError('Incomplete release runtime')
    # Staging must already have the reviewed release identity. Packaging cannot
    # manufacture identity for an unrelated tree or repair an old build.
    if (stage / 'release.env').read_text().strip() != 'RELEASE_ID=' + commit:
        raise ValueError('Staged release identity does not match selected commit')
    names.add('release.env')
    if out.exists() or out.with_suffix('.json').exists():
        raise ValueError('Output already exists')
    with tarfile.open(out, 'w:gz', dereference=True) as archive:
        for name in sorted(names):
            safe_name(name)
            path = stage / name
            if not path.resolve().is_relative_to(stage.resolve()) or not path.is_file():
                raise ValueError('Staged source is missing or escapes release root')
            safe_name(path.resolve().relative_to(stage.resolve()).as_posix())
            archive.add(path, arcname=name, recursive=False)
    m = {'schema': 1, 'environment': 'production', 'role': 'web', 'platform': 'linux-x64',
         'release_id': commit, 'sha256': digest(out), 'size': out.stat().st_size}
    validate_manifest(m)
    out.with_suffix('.json').write_text(json.dumps(m, indent=2) + '\n')
    (stage / '.release-artifact.json').write_text(json.dumps(m, indent=2) + '\n')
    return m


def install(archive_path, manifest, releases):
    m = validate_manifest(manifest)
    if archive_path.stat().st_size != m['size'] or digest(archive_path) != m['sha256']:
        raise ValueError('Artifact checksum or length mismatch')
    releases.mkdir(parents=True, exist_ok=True)
    target = releases / m['release_id']
    if target.exists():
        if json.loads((target / '.release-artifact.json').read_text()) != m:
            raise ValueError('Existing release has different or unverified content')
        return target
    stage = Path(tempfile.mkdtemp(prefix='.release-install-', dir=releases))
    try:
        with tarfile.open(archive_path, 'r:gz') as archive:
            names = set()
            size = 0
            for member in archive:
                safe_name(member.name)
                if not member.isfile() or member.name in names:
                    raise ValueError('Archive contains links, special files or duplicates')
                names.add(member.name)
                size += member.size
                if size > 6_000_000_000 or len(names) > 150_000:
                    raise ValueError('Expanded archive exceeds limits')
            required = {'release.env', 'public/v1/dist/src/server.js', 'public/v1/package-lock.json', 'public/v1/node_modules/pg/package.json'}
            if not required <= names:
                raise ValueError('Incomplete release archive')
            # Only regular files with validated relative names. No stored owner,
            # setuid bits, symlinks, devices or archive metadata are restored.
            for member in archive.getmembers():
                path = stage / member.name
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as src, path.open('xb') as dst:
                    shutil.copyfileobj(src, dst)
                path.chmod(0o755 if member.mode & 0o111 else 0o644)
        if (stage / 'release.env').read_text().strip() != 'RELEASE_ID=' + m['release_id']:
            raise ValueError('Archive release identity mismatch')
        (stage / '.release-artifact.json').write_text(json.dumps(m, indent=2) + '\n')
        stage.chmod(0o755)
        stage.rename(target)
        return target
    finally:
        if stage.exists():
            shutil.rmtree(stage)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('package')
    for name in ('repo', 'stage', 'commit', 'out'):
        p.add_argument('--' + name, required=True)
    p = commands.add_parser('install')
    p.add_argument('--archive', type=Path, required=True)
    p.add_argument('--manifest', type=Path, required=True)
    p.add_argument('--releases', type=Path, default=Path('/opt/firstmeasure/releases'))
    p = commands.add_parser('verify')
    p.add_argument('--archive', type=Path, required=True)
    p.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'package':
        if os.name != 'posix' or os.uname().sysname != 'Linux' or os.uname().machine != 'x86_64':
            parser.error('Build release artifacts on the reviewed Linux x64 staging host')
        print(json.dumps(package(Path(args.repo), Path(args.stage), args.commit, Path(args.out))))
    elif args.command == 'install':
        print(install(args.archive, json.loads(args.manifest.read_text()), args.releases))
    else:
        with tempfile.TemporaryDirectory(prefix='fm-release-verify-') as folder:
            install(args.archive, json.loads(args.manifest.read_text()), Path(folder) / 'releases')
        print('Archive structure, runtime identity and checksum verified.')
