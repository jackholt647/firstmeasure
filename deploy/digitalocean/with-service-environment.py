#!/usr/bin/env python3
"""Run a deployment helper with an existing service's environment, never print it."""
import os
from pathlib import Path
import shlex
import subprocess
import sys

if len(sys.argv) < 3:
    raise SystemExit('Usage: with-service-environment.py SERVICE COMMAND [ARGS...]')
service = sys.argv[1]
if service not in {'firstmeasure-web.service', 'firstmeasure-worker.service', 'firstmeasure-legacy.service'}:
    raise SystemExit('Unsupported FirstMeasure service')
pid = subprocess.check_output(['systemctl', 'show', service, '-p', 'MainPID', '--value'], text=True).strip()
if pid == '0':
    if service != 'firstmeasure-web.service':
        raise SystemExit('Stopped non-web service environment is unavailable')
    # For a new stopped node, the cloud-init environment overlay has already
    # been fetched. Parse its reviewed assignment files without executing shell.
    environment = {}
    for name in ('preproduction-runtime.env', 'production-cutover.env'):
        for line in (Path('/etc/firstmeasure') / name).read_text().splitlines():
            tokens = shlex.split(line, comments=True)
            if not tokens:
                continue
            if len(tokens) != 1 or '=' not in tokens[0]:
                raise SystemExit('Unsupported environment assignment')
            key, value = tokens[0].split('=', 1)
            environment[key] = value
else:
    environment = dict(x.split('=', 1) for x in (Path('/proc') / pid / 'environ').read_text().split('\0') if '=' in x)
environment['PATH'] = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
if os.environ.get('FIRSTMEASURE_RELEASE_PUBLISH_LOCK') == 'held':
    environment['FIRSTMEASURE_RELEASE_PUBLISH_LOCK'] = 'held'
os.chdir('/opt/firstmeasure/current/public/v1')
os.execvpe(sys.argv[2], sys.argv[2:], environment)
