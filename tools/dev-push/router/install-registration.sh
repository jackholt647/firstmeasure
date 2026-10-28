#!/usr/bin/env bash
# Sets up dev web pool registration on the dev sync droplet (docs/architecture/dev-lanes.md, "New web nodes"). Run as
# `dev` from the router's checkout. Creates the registration key (its only power: router/register-node.sh appends one
# registration line), authorizes it, and renders deploy/digitalocean/dev-pool-user-data.sh with the private key into
# ~/dev-push/secrets/pool-user-data.sh: the text to paste into the pool's user data. Never commit the rendered file.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
secrets=$HOME/dev-push/secrets
install -d -m 0700 "$secrets" "$HOME/dev-push/bin"
install -m 0755 "$here/register-node.sh" "$HOME/dev-push/bin/register-node"
key=$secrets/register_ed25519
[ -f "$key" ] || ssh-keygen -q -t ed25519 -N "" -C "dev-push pool registration" -f "$key"
pub=$(cat "$key.pub")
KEYS=$HOME/.ssh/authorized_keys
touch "$KEYS"; chmod 0600 "$KEYS"
body=$(echo "$pub" | awk '{print $2}')
grep -qF "$body" "$KEYS" || printf 'restrict,command="%s" %s\n' "$HOME/dev-push/bin/register-node" "$pub" >> "$KEYS"
python3 - "$root/deploy/digitalocean/dev-pool-user-data.sh" "$key" "$secrets/pool-user-data.sh" <<'PY'
import sys
template, key, out = sys.argv[1:4]
text = open(template).read()
assert text.count("@@REGISTRATION_PRIVATE_KEY@@") == 1
open(out, "w").write(text.replace("@@REGISTRATION_PRIVATE_KEY@@", open(key).read().strip()))
PY
chmod 0600 "$secrets/pool-user-data.sh"
echo "registration key authorized; user data to paste: $secrets/pool-user-data.sh ($(wc -c < "$secrets/pool-user-data.sh") bytes)"
