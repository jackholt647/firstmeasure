#!/usr/bin/env bash
# For the reviewed production image containing the pinned release helpers/key,
# production network/proxy/browser configuration and this boot dependency.
# Never use with the historical image whose web service can start early.
set -Eeuo pipefail
systemctl stop firstmeasure-web.service
test -f /etc/systemd/system/firstmeasure-release-bootstrap.service
test -f /etc/systemd/system/firstmeasure-web.service.d/zz-release-bootstrap.conf
test -f /etc/firstmeasure/release-signing-public.pem
python3 - <<'PY'
import os
from pathlib import Path
import shlex
import time
import urllib.request

os.umask(0o077)
def parse(raw):
    result = {}
    for line in raw.decode().splitlines():
        tokens = shlex.split(line, comments=True)
        if not tokens:
            continue
        if len(tokens) != 1 or '=' not in tokens[0]:
            raise RuntimeError('Unsupported production environment assignment')
        key, value = tokens[0].split('=', 1)
        result[key] = value
    return result

base = parse(Path('/etc/firstmeasure/preproduction-runtime.env').read_bytes())
assert base['FIRSTMEASURE_DATA_ENVIRONMENT'] == 'production'
assert base['SPACES_PREFIX'] == 'production'
request = urllib.request.Request(
    'http://10.124.0.9/__firstmeasure_bootstrap_20260908/production.env',
    headers={'Host': 'firstmeasure-production-bootstrap.internal',
             'x-firstmeasure-legacy-proxy': base['LEGACY_PROXY_SECRET']})
for attempt in range(12):
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read(65537)
        assert len(raw) < 65537
        values = {**base, **parse(raw)}
        assert values['FIRSTMEASURE_DATA_ENVIRONMENT'] == 'production'
        assert values['SPACES_PREFIX'] == 'production'
        assert values['PLATFORM_HEARTBEAT_DISABLED'] == '1'
        break
    except Exception:
        if attempt == 11:
            raise RuntimeError('Production environment fetch failed') from None
        time.sleep(5)
target = Path('/etc/firstmeasure/production-cutover.env')
temporary = target.with_suffix('.env.next')
temporary.write_bytes(raw)
temporary.chmod(0o600)
temporary.replace(target)
drop = Path('/etc/systemd/system/firstmeasure-web.service.d')
drop.mkdir(exist_ok=True)
(drop / '99-production-cutover.conf').write_text(
    '[Service]\nEnvironmentFile=/etc/firstmeasure/production-cutover.env\n')
PY
systemctl daemon-reload
systemctl start firstmeasure-instance-identity.service
source /run/firstmeasure/instance.env
[[ "$DROPLET_ID" =~ ^[0-9]+$ ]]
hostnamectl set-hostname "fm-web-$DROPLET_ID"
nginx -t
systemctl reload nginx
# cloud-final must finish before the release dependency can run. Waiting here
# for web readiness would deadlock its startup ordering.
systemctl --no-block start firstmeasure-web.service
