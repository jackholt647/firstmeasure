#!/usr/bin/env python3
"""Activate an installed release on this host WITHOUT restarting Node (FM-388).

  switch-release-files.py [--check] NEW_RELEASE_ID EXPECTED_CURRENT_RELEASE_ID

Only for a release whose Node side is identical to the release Node is running
(release-node-fingerprint.py compare, run here against the directory each Node
service's serving processes actually started in: a cluster's workers, FM-389). Switches /opt/firstmeasure/current and gracefully
reloads PHP-FPM where it runs (web, compatibility); Node services keep running and
keep their RELEASE_ID. Then checks the Node services did not restart and are ready,
that NGINX serves every changed static file with the new release's bytes, and that
PHP answers. Any failure switches back and reloads PHP-FPM again (exit 1).

--check stops before the switch: run it on every host first, so no host switches
when another would refuse. Rollback is the same command with the two ids swapped. Refuses (exit 3, nothing
changed) when the Node side differs: use activate-release.sh, the full procedure.
DEPLOYMENT.md, "Production run fast path".
"""
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Overridable only so tests/release-node-fingerprint.test.mjs can run this against a fake host.
ROOT = Path(os.environ.get('FIRSTMEASURE_ROOT', '/opt/firstmeasure'))
CURRENT = ROOT / 'current'
SYSTEMCTL = os.environ.get('FIRSTMEASURE_SYSTEMCTL', 'systemctl')
LOCAL_HTTP = os.environ.get('FIRSTMEASURE_LOCAL_HTTP', 'http://127.0.0.1')
# Node itself, as verify-node.sh checks it (compatibility's NGINX redirects /v1/health/ready for the public host).
NODE_HTTP = os.environ.get('FIRSTMEASURE_NODE_HTTP', 'http://127.0.0.1:3101')
PROC = Path(os.environ.get('FIRSTMEASURE_PROC', '/proc'))
NODE_SERVICES = ('firstmeasure-web', 'firstmeasure-legacy', 'firstmeasure-worker')
HTTP_SERVICES = {'firstmeasure-web', 'firstmeasure-legacy'}
PHP_FPM = os.environ.get('FIRSTMEASURE_PHP_FPM_SERVICE', 'php8.3-fpm')
# A PHP page each PHP role serves itself with no side effects (web proxies /measure/internal/ to compatibility).
PHP_PROBE = {'firstmeasure-web': '/portal/login.php', 'firstmeasure-legacy': '/measure/internal/backend_login.php'}
HOST = os.environ.get('FIRSTMEASURE_PUBLIC_HOST', 'app.1m8.ai')


def say(**fields):
    print(json.dumps(fields), flush=True)


def active(service):
    return subprocess.run([SYSTEMCTL, 'is-active', '--quiet', service]).returncode == 0


def main_pid(service):
    return subprocess.check_output([SYSTEMCTL, 'show', service, '-p', 'MainPID', '--value'], text=True).strip()


def started_in(pid):
    """The release directory a Node process started in (its cwd is <release>/public/v1, a real path)."""
    cwd = Path(os.readlink(PROC / pid / 'cwd'))
    return cwd.parent.parent if cwd.parts[-2:] == ('public', 'v1') else cwd


def serving(pid):
    """The processes that answer requests: a cluster primary's workers, which a rolling replace (FM-389) starts in a
    newer release than the one the primary started in; a process without workers serves itself."""
    try:
        children = (PROC / pid / 'task' / pid / 'children').read_text().split()
    except OSError:
        children = []
    return children or [pid]


def get(path, timeout=15, base=None):
    request = urllib.request.Request((base or LOCAL_HTTP) + path, headers={'Host': HOST})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def settled(path, ok, base=None, tries=10):
    """(status, body) once ok(status, body), retrying for about 10 s: PHP-FPM respawns its workers after a reload."""
    for attempt in range(tries):
        try:
            status, body = get(path, base=base)
        except OSError as error:  # refused or timed out while workers respawn
            status, body = 0, str(error).encode()
        if ok(status, body) or attempt == tries - 1:
            return status, body
        time.sleep(1)


def swap(target):
    nxt = ROOT / 'current.next'
    if nxt.is_symlink() or nxt.exists():
        nxt.unlink()
    nxt.symlink_to(target)
    os.replace(nxt, CURRENT)


def reload_php():
    subprocess.run([SYSTEMCTL, 'reload', PHP_FPM], check=True, timeout=120)
    for _ in range(30):
        if active(PHP_FPM):
            return
        time.sleep(1)
    raise RuntimeError(f'{PHP_FPM} not active after reload')


def main(new_id, expected_id, check=False):
    releases = ROOT / 'releases'
    new, expected = releases / new_id, releases / expected_id
    for release in (new, expected):
        if not (release / '.release-artifact.json').is_file():
            say(error='release not installed', release=str(release)); return 2
    if CURRENT.resolve() == new:
        say(already_active=new_id); return 0
    if CURRENT.resolve() != expected:
        say(error='unexpected current', current=str(CURRENT.resolve()), expected=str(expected)); return 2

    spec = importlib.util.spec_from_file_location('fingerprint', Path(__file__).with_name('release-node-fingerprint.py'))
    fingerprint = importlib.util.module_from_spec(spec); spec.loader.exec_module(fingerprint)

    nodes = {service: main_pid(service) for service in NODE_SERVICES if active(service)}
    if not nodes:
        say(error='no Node service is running here'); return 2
    php = active(PHP_FPM)
    static = set()
    os.nice(10)  # hashing two trees; compatibility has 2 vCPU
    for service, pid in nodes.items():
        for running in sorted({started_in(process) for process in serving(pid)}):
            result = fingerprint.compare(running, new)
            say(service=service, pid=pid, started_in=running.name, node_same=result['fast_path'], server_same=result['server']['running'] == result['server']['new'],
                changed=result['changed'], changed_node=result['changed_node'][:10])
            if not result['fast_path']:
                say(refused='Node side differs from the release this Node started in: use the full procedure (activate-release.sh)'); return 3
            static.update(result['changed_static'])
    if check:
        say(check='fast path possible', new=new_id, current=expected_id, php=php); return 0
    before = time.time()
    swap(new)
    try:
        if php:
            reload_php()
        for service, pid in nodes.items():
            if not active(service) or main_pid(service) != pid:
                raise RuntimeError(f'{service} restarted or stopped (pid {pid} -> {main_pid(service)})')
            if service in HTTP_SERVICES:
                status, body = settled('/v1/health/ready', lambda status, body: status == 200 and b'"ok":true' in body, base=NODE_HTTP)
                if status != 200 or not json.loads(body).get('ok'):
                    raise RuntimeError(f'{service} not ready: {status}')
        served = {'same': 0, 'not_served': 0}
        if any(service in HTTP_SERVICES for service in nodes):
            for name in sorted(static):
                if not name.startswith('public/') or name.endswith('.php') or not (new / name).is_file():
                    continue
                status, body = get('/' + name[len('public/'):] + '?fm_switch=' + new_id[:8])
                if status != 200:
                    served['not_served'] += 1
                    continue
                if hashlib.sha256(body).digest() != hashlib.sha256((new / name).read_bytes()).digest():
                    raise RuntimeError(f'served {name} is not the new release\'s file')
                served['same'] += 1
        if php:
            for service in nodes:
                if service in PHP_PROBE:
                    status, _ = settled(PHP_PROBE[service], lambda status, body: 0 < status < 500)
                    if status >= 500:
                        raise RuntimeError(f'PHP probe {PHP_PROBE[service]} answered {status}')
        say(switched=new_id, previous=expected_id, seconds=round(time.time() - before, 1), php_reloaded=php,
            node_kept={service: pid for service, pid in nodes.items()}, served=served)
        return 0
    except Exception as error:  # noqa: BLE001
        swap(expected)
        if php:
            reload_php()
        say(error=str(error), rolled_back_to=expected_id)
        return 1


if __name__ == '__main__':
    check = '--check' in sys.argv[1:]
    ids = [x for x in sys.argv[1:] if x != '--check']
    if len(ids) != 2 or not all(len(x) == 40 for x in ids):
        print(__doc__, file=sys.stderr); sys.exit(2)
    sys.exit(main(ids[0], ids[1], check))
