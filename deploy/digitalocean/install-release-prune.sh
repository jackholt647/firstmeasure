#!/usr/bin/env bash
# Install (or refresh) hourly release pruning and a journal size cap on this
# node. Idempotent; activate-release.sh runs it after every activation so new
# and autoscaled nodes get it with their first release.
set -Eeuo pipefail
[[ "$EUID" == 0 ]] || { echo 'Run as root.' >&2; exit 2; }
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
lib=/usr/local/lib/firstmeasure-release

install -d -m 0755 "$lib"
install -m 0755 "$script_dir/prune-releases.py" "$lib/prune-releases.py.next"
mv -f "$lib/prune-releases.py.next" "$lib/prune-releases.py"

cat > /etc/systemd/system/firstmeasure-release-prune.service.next <<'UNIT'
[Unit]
Description=Delete old FirstMeasure releases so the disk never fills

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
ExecStart=/usr/bin/python3 /usr/local/lib/firstmeasure-release/prune-releases.py
UNIT
cat > /etc/systemd/system/firstmeasure-release-prune.timer.next <<'UNIT'
[Unit]
Description=Hourly FirstMeasure release pruning

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
UNIT
mv -f /etc/systemd/system/firstmeasure-release-prune.service.next /etc/systemd/system/firstmeasure-release-prune.service
mv -f /etc/systemd/system/firstmeasure-release-prune.timer.next /etc/systemd/system/firstmeasure-release-prune.timer

# Cap the systemd journal; rotated text logs are already handled by logrotate.
install -d -m 0755 /etc/systemd/journald.conf.d
if [[ ! -f /etc/systemd/journald.conf.d/firstmeasure.conf ]] || ! grep -q '^SystemMaxUse=1G$' /etc/systemd/journald.conf.d/firstmeasure.conf; then
  printf '[Journal]\nSystemMaxUse=1G\nSystemKeepFree=10G\n' > /etc/systemd/journald.conf.d/firstmeasure.conf
  systemctl restart systemd-journald
fi

systemctl daemon-reload
systemctl enable --now firstmeasure-release-prune.timer >/dev/null
echo 'Release pruning timer installed.'
