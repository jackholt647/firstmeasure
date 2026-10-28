#!/usr/bin/env bash
# Puts the dev push router's release helper on one DEVELOPMENT role (docs/architecture/dev-lanes.md). Run as root:
#   install.sh <web|worker|legacy> <fm-release.py> "<router public key line>"
# Idempotent. Refuses on a host whose services are not the development ones. Does not seal /opt/firstmeasure;
# `fm-release seal on` does that at cutover, after which only fm-release can switch `current`.
set -euo pipefail
ROLE=$1
HELPER_SRC=$2
PUBKEY=$3

case "$ROLE" in
  web) UNIT=firstmeasure-development-web.service ;;
  legacy) UNIT=firstmeasure-development-legacy.service ;;
  worker) UNIT=firstmeasure-development-worker.service ;;
  *) echo "role must be web, worker or legacy" >&2; exit 1 ;;
esac
systemctl cat "$UNIT" >/dev/null 2>&1 || { echo "$UNIT not found: not the development $ROLE host" >&2; exit 1; }
pid=$(systemctl show "$UNIT" -p MainPID --value)
tr '\0' '\n' < "/proc/$pid/environ" | grep -qx 'FIRSTMEASURE_DATA_ENVIRONMENT=development' || { echo "$UNIT is not a development process" >&2; exit 1; }
case "$PUBKEY" in ssh-ed25519\ *) ;; *) echo "expected an ssh-ed25519 public key" >&2; exit 1 ;; esac

install -o root -g root -m 0755 "$HELPER_SRC" /usr/local/sbin/fm-release
current=$(readlink -f /opt/firstmeasure/current)
releases=$(dirname "$current")
lsattr -d /opt/firstmeasure | awk '{print $1}' | grep -q 'i' && sealed=1 || sealed=0
[ "$sealed" = 1 ] && chattr -i /opt/firstmeasure
install -d -o root -g root -m 0755 /opt/firstmeasure/lanes
[ "$ROLE" = web ] && install -d -o root -g root -m 0755 /opt/firstmeasure/dev-push
[ "$sealed" = 1 ] && chattr +i /opt/firstmeasure

python3 - "$ROLE" "$releases" > /etc/firstmeasure/dev-push-role.json <<'PY'
import json, sys
role, releases = sys.argv[1], sys.argv[2]
services = {
    "web": ["firstmeasure-development-web.service"],
    "legacy": ["firstmeasure-development-legacy.service"],
    "worker": ["firstmeasure-development-worker.service", "firstmeasure-development-platform-worker.service", "firstmeasure-development-payment-browser.service"],
}[role]
config = {"role": role, "releases_root": releases, "services": services,
          "reload": [] if role == "worker" else ["php8.3-fpm.service"],
          "readiness": "worker" if role == "worker" else "http",
          "lane_reload": {} if role == "worker" else {"measure-internal": ["php8.3-fpm.service"]}}
if role == "web":
    config["status_dir"] = "/opt/firstmeasure/dev-push"
print(json.dumps(config, indent=1))
PY

install -d -m 0700 /root/.ssh
KEYS=/root/.ssh/authorized_keys
touch "$KEYS"
key_body=$(echo "$PUBKEY" | awk '{print $2}')
grep -qF "$key_body" "$KEYS" || printf 'restrict,command="/usr/local/sbin/fm-release ssh" %s\n' "$PUBKEY" >> "$KEYS"
chmod 0600 "$KEYS"

if [ "$ROLE" = web ]; then
  SITE=/etc/nginx/sites-enabled/firstmeasure-development
  target=$(readlink -f "$SITE")
  if ! grep -q '__dev-push' "$target"; then
    cp -p "$target" "$target.before-dev-push"
    python3 - "$target" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
anchor = "    root /opt/firstmeasure/current/public;\n"
block = ("    # Dev push router status (docs/architecture/dev-lanes.md).\n"
         "    location = /__dev-push/status.json { alias /opt/firstmeasure/dev-push/status.json; default_type application/json; add_header Cache-Control \"no-cache\" always; }\n")
assert text.count(anchor) == 1, "release root line not found exactly once"
open(path, "w").write(text.replace(anchor, anchor + block))
PY
    if ! nginx -t; then cp -p "$target.before-dev-push" "$target"; echo "nginx -t failed; restored" >&2; exit 1; fi
    systemctl reload nginx
  fi
fi
echo "fm-release ready on $(hostname) as $ROLE (releases in $releases)"
