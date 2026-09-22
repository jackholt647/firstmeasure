#!/usr/bin/env python3
"""Linux/root integration check with isolated NGINX/FPM and fictional releases.

Exercises cached PHP includes across a symlink upgrade and rollback. Does not
use application credentials, databases, production ports, or running services.
Requires nginx and php-fpm8.3 already installed.
"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request


def run_case(script_root):
    with tempfile.TemporaryDirectory(prefix='fm-php-release-test-') as directory:
        root = Path(directory)
        root.chmod(0o755)
        for version in ('old', 'new'):
            release = root / version
            release.mkdir(mode=0o755)
            (release / 'version.php').write_text('<?php return ' + repr(version) + ';')
            (release / 'index.php').write_text("<?php header('Content-Type: application/json'); echo json_encode(['release' => require __DIR__.'/version.php']);")
        current = root / 'current'
        current.symlink_to(root / 'old')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        (root / 'fpm.conf').write_text(f'''[global]
daemonize = no
error_log = {root}/fpm-error.log
[release-test]
user = www-data
group = www-data
listen = {root}/php.sock
listen.mode = 0666
pm = static
pm.max_children = 1
php_admin_value[opcache.enable] = 1
php_admin_value[opcache.validate_timestamps] = 0
php_admin_value[realpath_cache_ttl] = 3600
''')
        (root / 'nginx.conf').write_text(f'''pid {root}/nginx.pid;
error_log {root}/nginx-error.log;
events {{ worker_connections 32; }}
http {{ access_log off; server {{
listen 127.0.0.1:{port};
root {current};
location ~ \\.php$ {{
include /etc/nginx/fastcgi_params;
fastcgi_param SCRIPT_FILENAME {script_root}$fastcgi_script_name;
fastcgi_pass unix:{root}/php.sock;
}}
}} }}
''')
        processes = []
        with (root / 'process.log').open('w') as log:
            try:
                processes.append(subprocess.Popen(['php-fpm8.3', '--fpm-config', str(root / 'fpm.conf'), '--nodaemonize'], stdout=log, stderr=log))
                processes.append(subprocess.Popen(['nginx', '-p', str(root), '-c', str(root / 'nginx.conf'), '-g', 'daemon off;'], stdout=log, stderr=log))
                def request():
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/index.php', timeout=2) as response:
                        return json.load(response)['release']
                for attempt in range(40):
                    try:
                        assert request() == 'old'
                        break
                    except Exception:
                        if attempt == 39: raise
                        time.sleep(0.1)
                def switch(version):
                    pending = root / 'next'
                    pending.symlink_to(root / version)
                    os.replace(pending, current)
                    return request()
                return {'initial': 'old', 'upgrade': switch('new'), 'rollback': switch('old')}
            finally:
                for process in reversed(processes):
                    process.terminate()
                    try: process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


if __name__ == '__main__':
    assert os.geteuid() == 0, 'Run as root so the isolated pool can use www-data.'
    assert shutil.which('nginx') and shutil.which('php-fpm8.3')
    legacy = run_case('$document_root')
    fixed = run_case('$realpath_root')
    assert legacy['upgrade'] == 'old', 'Fixture must reproduce stale PHP before validating the fix.'
    assert fixed == {'initial': 'old', 'upgrade': 'new', 'rollback': 'old'}, fixed
    print(json.dumps({'legacy_reproduced': legacy, 'resolved_release': fixed, 'passed': True}))
