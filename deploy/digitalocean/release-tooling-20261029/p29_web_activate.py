"""Runs on a production web node: withdraw it from the load balancer, activate the release, verify, and restore NGINX.
Adapted from output/production-protection-20261012/activate.py (the October 12 rollout)."""
import pathlib, subprocess, json, urllib.request, time, hashlib
release = '3d1fdb127507247b2bdb73b0cdf29f72aac1af29'; base = 'ef39262b0ef277b6d84e6341251741d3851b5a46'
current = pathlib.Path('/opt/firstmeasure/current')
if current.resolve().name == release:
    print(json.dumps({'already_active': release}), flush=True); raise SystemExit(0)
assert current.resolve().name == base, current.resolve()
assert pathlib.Path('/opt/firstmeasure/releases/' + release + '/.release-artifact.json').exists(), 'release not installed'
health = json.load(urllib.request.urlopen('http://127.0.0.1/v1/health/ready', timeout=15)); assert health['ok']
start = time.time(); print(json.dumps({'activation_started': start, 'instance': health['instance_id']}), flush=True)
conf = pathlib.Path('/etc/nginx/sites-enabled/firstmeasure').resolve(); original = conf.read_bytes()
assert b'location = /v1/health/ready' not in original
assert original.count(b'server {') == 1
modified = original.replace(b'server {', b'server {\n    # Temporary rolling deployment withdrawal.\n    location = /v1/health/ready { return 503; }', 1)
backup = conf.with_name('firstmeasure.before-release-3d1fdb12')
if backup.exists(): assert backup.read_bytes() == original
else: backup.write_bytes(original); backup.chmod(0o600)
access = pathlib.Path('/var/log/nginx/access.log'); offset = access.stat().st_size
try:
    conf.write_bytes(modified)
    subprocess.run(['nginx', '-t'], check=True, capture_output=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    print(json.dumps({'draining': health['instance_id'], 'wait_seconds': 45}), flush=True)
    time.sleep(45)
    with access.open('rb') as f:
        f.seek(offset); lines = f.read().decode(errors='replace').splitlines()
    failed_probes = sum(' /v1/health/ready HTTP/1.1" 503 ' in line and line.startswith('10.124.0.7 ') for line in lines)
    assert failed_probes >= 3, 'Load balancer withdrawal probes not confirmed'
    print(json.dumps({'load_balancer_failed_health_probes': failed_probes}), flush=True)
    subprocess.run(['bash', '/opt/firstmeasure/releases/' + release + '/deploy/digitalocean/activate-release.sh', release, 'firstmeasure-web.service'], check=True, timeout=400)
finally:
    assert conf.read_bytes() == modified, 'NGINX changed concurrently; inspect before restoring'
    conf.write_bytes(original)
    subprocess.run(['nginx', '-t'], check=True, capture_output=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
for attempt in range(30):
    try:
        d = json.load(urllib.request.urlopen('http://127.0.0.1/v1/health/ready', timeout=15)); assert d['ok'] and d['release_id'] == release
        break
    except Exception:
        if attempt == 29: raise
        time.sleep(2)
pid = subprocess.check_output(['systemctl', 'show', 'firstmeasure-web', '-p', 'MainPID', '--value'], text=True).strip()
e = dict(x.split('=', 1) for x in pathlib.Path('/proc/' + pid + '/environ').read_bytes().decode().split('\0') if '=' in x)
assert e.get('FIRSTMEASURE_DATA_ENVIRONMENT') == 'production' and e.get('PLATFORM_HEARTBEAT_DISABLED') == '1', 'unexpected environment'
for name in ['public/portal/scripts/core.js', 'public/libraries/apps/measurements/project.js']:
    expected = hashlib.sha256((current / name).read_bytes()).hexdigest()
    actual = hashlib.sha256(urllib.request.urlopen('http://127.0.0.1/' + name.removeprefix('public/') + '?release=3d1fdb12', timeout=15).read()).hexdigest(); assert actual == expected, name
sandbox = 0
try: urllib.request.urlopen(urllib.request.Request('http://127.0.0.1/portal/signup-sandbox/', headers={'Host': 'app.1m8.ai'}), timeout=15)
except urllib.error.HTTPError as err: sandbox = err.code
print(json.dumps({'activated': release, 'instance': d['instance_id'], 'seconds': round(time.time() - start, 1), 'ready': True, 'assets_match': True,
                  'pool': e.get('POSTGRES_POOL_MAX'), 'workers': e.get('V1_WEB_WORKERS'), 'signup_sandbox_status': sandbox}), flush=True)
