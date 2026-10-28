#!/usr/bin/env bash
# User data for the DEVELOPMENT web autoscale pool (firstmeasure-development-web-autoscale-r1); docs/architecture/dev-lanes.md,
# "New web nodes". A node built from the pool image carries whatever release the image had. This keeps it out of the
# load balancer (its web service and standby stay stopped, so /v1/health/ready fails) and hands it to the dev push
# router: fm-release and the router's key are installed, and the router stages and activates its current release on
# the node, which then enables the services. Development only; production uses bootstrap-web-release.sh.
set -uo pipefail
exec >>/var/log/dev-push-bootstrap.log 2>&1
echo "$(date -u +%FT%TZ) dev push bootstrap"
systemctl cat firstmeasure-development-web.service >/dev/null 2>&1 || { echo "not a development web node"; exit 0; }

# Out of rotation until the router's release is active.
units="firstmeasure-development-web.service firstmeasure-development-web-standby.service firstmeasure-dev-standby-sync.path firstmeasure-dev-standby-sync.timer"
systemctl disable --now $units || true
install -d -m 0755 /var/lib/dev-push
echo "$units" > /var/lib/dev-push/awaiting-release

# The router reaches the node with a key that can only run fm-release (tools/dev-push/host/install.sh).
ROUTER_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEsjE4CiP4EDYsQzBBTGZIXFO8k02eEMv6/VBYB3LlWU dev-push-router@dev-sync-droplet'
base=https://raw.githubusercontent.com/jackholt647/firstmeasure/codex/consolidated-firstmeasure-20260923/tools/dev-push/host
for attempt in 1 2 3 4 5; do
  curl -fsS "$base/fm-release.py" -o /tmp/fm-release.py && curl -fsS "$base/install.sh" -o /tmp/dev-push-install.sh && break
  sleep 10
done
bash /tmp/dev-push-install.sh web /tmp/fm-release.py "$ROUTER_KEY"
echo "$(date -u +%FT%TZ) waiting for the dev push router"
