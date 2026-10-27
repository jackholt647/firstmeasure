#!/usr/bin/env bash
# Sets up the live layer on the DEVELOPMENT web host (docs/architecture/live-layer.md). Run as root:
#   install-web.sh <fm-live-receive.py> "<a machine's fm_live_ed25519.pub line>"
# Idempotent: run it again with another machine's public key to let that machine push too. Never run it on a production host: it refuses unless the web service is the development one.
set -euo pipefail
RECEIVER_SRC=$1
PUBKEY=$2
SITE=/etc/nginx/sites-enabled/firstmeasure-development

systemctl cat firstmeasure-development-web >/dev/null 2>&1 || { echo "not the development web host" >&2; exit 1; }
grep -Eq '^FIRSTMEASURE_DATA_ENVIRONMENT="?development"?$' /etc/firstmeasure/development-runtime.env || { echo "data environment is not development" >&2; exit 1; }
case "$PUBKEY" in ssh-ed25519\ *) ;; *) echo "expected an ssh-ed25519 public key" >&2; exit 1 ;; esac

id fmlive >/dev/null 2>&1 || useradd --system --home-dir /var/lib/fmlive --create-home --shell /bin/bash fmlive
passwd -l fmlive >/dev/null
install -d -o fmlive -g fmlive -m 0755 /opt/firstmeasure/live /opt/firstmeasure/live/public
install -o root -g root -m 0755 "$RECEIVER_SRC" /usr/local/bin/fm-live-receive
install -d -o fmlive -g fmlive -m 0700 /var/lib/fmlive/.ssh
# One line per machine that may push (the droplet, each PC); every one can only run the receiver.
KEYS=/var/lib/fmlive/.ssh/authorized_keys
touch "$KEYS"
key_body=$(echo "$PUBKEY" | awk '{print $2}')
grep -qF "$key_body" "$KEYS" || printf 'restrict,command="/usr/local/bin/fm-live-receive serve" %s\n' "$PUBKEY" >> "$KEYS"
chown fmlive:fmlive "$KEYS"
chmod 0600 /var/lib/fmlive/.ssh/authorized_keys

cat > /etc/systemd/system/fm-live-check.service <<'UNIT'
[Unit]
Description=Live layer: retire files the release now has or changed (docs/architecture/live-layer.md)
[Service]
Type=oneshot
User=fmlive
ExecStart=/usr/local/bin/fm-live-receive check
UNIT
cat > /etc/systemd/system/fm-live-check.timer <<'UNIT'
[Unit]
Description=Live layer check every 20 seconds
[Timer]
OnBootSec=30s
OnUnitActiveSec=20s
AccuracySec=1s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now fm-live-check.timer

# NGINX: the live folder first for everything `location /` serves; PHP keeps its own location and never reads it.
target=$(readlink -f "$SITE")
if ! grep -q 'opt/firstmeasure/live/public' "$target"; then
  cp -p "$target" "$target.before-live-layer"
  python3 - "$target" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
old = "    location / { try_files $uri $uri/ /index.php?$query_string; }"
new = ("    # Live layer (docs/architecture/live-layer.md): browser files saved on the droplet, ahead of the release.\n"
       "    location / { root /opt/firstmeasure/live/public; try_files $uri @release; add_header Cache-Control \"no-cache\" always; add_header X-FirstMate-Live 1 always; }\n"
       "    location @release { try_files $uri $uri/ /index.php?$query_string; }")
assert text.count(old) == 1, "location / not found exactly once"
open(path, "w").write(text.replace(old, new))
PY
  if ! nginx -t; then cp -p "$target.before-live-layer" "$target"; echo "nginx -t failed; restored" >&2; exit 1; fi
  systemctl reload nginx
fi
echo "live layer ready on $(hostname)"
