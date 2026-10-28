#!/usr/bin/env bash
# User data for the DEVELOPMENT web autoscale pool (firstmeasure-development-web-autoscale-r1); docs/architecture/dev-lanes.md,
# "New web nodes". A node built from the pool image carries whatever release the image had. This keeps it out of the
# load balancer (its web service and standby stay stopped, so /v1/health/ready fails), installs fm-release with the
# router's key, and registers the node with the dev push router, which stages and activates its current release on the
# node and then enables the services. Development only; production uses bootstrap-web-release.sh.
#
# This file is a template: tools/dev-push/router/install-registration.sh renders it with the registration key into
# ~/dev-push/secrets/pool-user-data.sh on the dev sync droplet. Paste that rendered file into the pool; never commit it.
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
for attempt in 1 2 3 4 5 6; do
  curl -fsS "$base/fm-release.py" -o /tmp/fm-release.py && curl -fsS "$base/install.sh" -o /tmp/dev-push-install.sh && break
  sleep 10
done
bash /tmp/dev-push-install.sh web /tmp/fm-release.py "$ROUTER_KEY"

# Agents on fm-agents-1 get root here to fix dev outages (fm-dev-host; docs/architecture/agent-droplet.md). Dev only.
DEVOPS_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIChfi4l37riFVq2kI21GhXM6UZASNpv355hxUtmgJLyo fm-agents-1 dev-ops (dev hosts only)'
install -d -m 0700 /root/.ssh
grep -qF "fm-agents-1 dev-ops" /root/.ssh/authorized_keys 2>/dev/null || echo "$DEVOPS_KEY" >> /root/.ssh/authorized_keys

# Register with the router: a key that can only append "register <id> <public ip> <private ip>" on the droplet.
install -d -m 0700 /root/.dev-push
cat > /root/.dev-push/register-key <<'KEY'
@@REGISTRATION_PRIVATE_KEY@@
KEY
chmod 0600 /root/.dev-push/register-key
meta=http://169.254.169.254/metadata/v1
id=$(curl -fsS $meta/id); public=$(curl -fsS $meta/interfaces/public/0/ipv4/address); private=$(curl -fsS $meta/interfaces/private/0/ipv4/address)
for attempt in $(seq 1 30); do
  ssh -i /root/.dev-push/register-key -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
    dev@147.182.178.6 "register $id $public $private" && break
  sleep 20
done
echo "$(date -u +%FT%TZ) registered $id $public; waiting for the dev push router"
