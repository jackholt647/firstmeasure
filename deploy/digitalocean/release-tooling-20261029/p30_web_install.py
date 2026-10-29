"""Runs on a production web node: download the signed channel's archive and install it without activating."""
import pathlib, subprocess, json
RELEASE = 'ef3f183f602553940d01b09fe7f6c04da16e5c7d'
root = pathlib.Path('/var/tmp/firstmeasure-release-' + RELEASE[:8]); root.mkdir(exist_ok=True); root.chmod(0o700)
h = pathlib.Path('/usr/local/lib/firstmeasure-release')
if not (root / 'release.json').exists():
    subprocess.run(['python3', str(h / 'with-service-environment.py'), 'firstmeasure-web.service', 'node', str(h / 'release-channel.mjs'), 'download', str(root)], check=True)
m = json.loads((root / 'release.json').read_text())
assert m['release_id'] == RELEASE and m['sha256'] == '55250d9b317d87b199a127572110d2925d3a3b1bc73365b6fc7826e3ad1eef67', m
target = subprocess.run(['python3', str(h / 'release-artifact.py'), 'install', '--archive', str(root / 'release.tar.gz'), '--manifest', str(root / 'release.json'), '--releases', '/opt/firstmeasure/releases'], check=True, capture_output=True, text=True).stdout.strip()
print(json.dumps({'installed': target, 'activated': False, 'current': str(pathlib.Path('/opt/firstmeasure/current').resolve())}), flush=True)
