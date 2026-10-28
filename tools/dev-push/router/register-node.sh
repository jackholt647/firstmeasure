#!/usr/bin/env bash
# Forced command for the dev web pool's registration key on the dev sync droplet (docs/architecture/dev-lanes.md,
# "New web nodes"). A new pool node announces itself; the router adopts it (router/fleet.mjs). Nothing else is allowed.
#   ssh dev@<droplet> register <droplet id> <public ipv4> <private ipv4>
set -euo pipefail
read -r verb id public private extra <<< "${SSH_ORIGINAL_COMMAND:-}"
ip='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
if [ "$verb" != register ] || ! [[ "$id" =~ ^[0-9]{6,12}$ ]] || ! [[ "$public" =~ $ip ]] || ! [[ "$private" =~ $ip ]] || [ -n "${extra:-}" ]; then
  echo "usage: register <droplet id> <public ipv4> <private ipv4>" >&2
  exit 1
fi
from=$(echo "${SSH_CLIENT:-}" | awk '{print $1}')
printf '{"id":"%s","public":"%s","private":"%s","from":"%s","at":"%s"}\n' "$id" "$public" "$private" "$from" "$(date -u +%FT%TZ)" >> "$HOME/dev-push/state/registrations.jsonl"
echo "registered $id"
