#!/usr/bin/env bash
# Lets another machine's agents submit to the dev push router (docs/architecture/dev-lanes.md). Run as `dev` on the
# dev sync droplet:  tools/dev-push/router/install-submit-key.sh "<ssh-ed25519 public key line>" [<source ip>]
# The key can only fetch/push the router's repository (queue refs) and read the router status (router/submit-shell.sh).
set -euo pipefail
PUBKEY=$1
FROM=${2:-}
case "$PUBKEY" in ssh-ed25519\ *) ;; *) echo "expected an ssh-ed25519 public key line" >&2; exit 1 ;; esac
here=$(cd "$(dirname "$0")" && pwd)
install -d -m 0755 "$HOME/dev-push/bin"
install -m 0755 "$here/submit-shell.sh" "$HOME/dev-push/bin/submit-shell"
KEYS=$HOME/.ssh/authorized_keys
touch "$KEYS"; chmod 0600 "$KEYS"
body=$(echo "$PUBKEY" | awk '{print $2}')
if grep -qF "$body" "$KEYS"; then echo "key already authorized"; exit 0; fi
options="restrict,command=\"$HOME/dev-push/bin/submit-shell\""
[ -n "$FROM" ] && options="from=\"$FROM\",$options"
printf '%s %s\n' "$options" "$PUBKEY" >> "$KEYS"
echo "submit-only key authorized${FROM:+ from $FROM}"
