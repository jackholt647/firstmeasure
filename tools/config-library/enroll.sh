#!/bin/sh
# Gives this machine its dev config library key (docs/architecture/config-library.md, "Agent machines").
#
#   sh tools/config-library/enroll.sh agents:<machine>      e.g. agents:fm-agents-1
#
# Signs a one-time enrollment with this machine's SSH key (~/.ssh/fm_config_library_ed25519, listed by its public half
# in public/v1/config-library/agent-machines.json) and writes the key dev returns to
# ~/.config/firstmate/config-library-key, mode 600. The key is never printed. Running it again replaces the key (the
# earlier one is revoked). Needs only sh, ssh-keygen, curl, od and base64. Dev only.
set -eu
machine=${1:?usage: enroll.sh agents:<machine>}
origin=${FM_DEV_ORIGIN:-https://dev.1m8.ai}
signing=${FM_CONFIG_LIBRARY_SIGNING_KEY:-$HOME/.ssh/fm_config_library_ed25519}
dir=$HOME/.config/firstmate
out=$dir/config-library-key
[ -f "$signing" ] || { echo "No signing key at $signing. Create it: ssh-keygen -t ed25519 -N '' -f $signing, then list its .pub in agent-machines.json." >&2; exit 2; }
umask 077
mkdir -p "$dir"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
timestamp=$(( $(date +%s) * 1000 ))
nonce=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
printf 'fm-config-library-enroll\n%s\n%s\n%s' "$machine" "$timestamp" "$nonce" > "$tmp/message"
ssh-keygen -Y sign -q -f "$signing" -n fm-config-library "$tmp/message" >/dev/null 2>&1 || ssh-keygen -Y sign -f "$signing" -n fm-config-library "$tmp/message" >/dev/null
signature=$(base64 < "$tmp/message.sig" | tr -d '\n')
printf '{"machine":"%s","timestamp":%s,"nonce":"%s","signature":"%s"}' "$machine" "$timestamp" "$nonce" "$signature" > "$tmp/body"
status=$(curl -sS -o "$tmp/key" -D "$tmp/headers" -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary @"$tmp/body" "$origin/v1/config-library/keys/enroll")
if [ "$status" != "200" ] || ! grep -q '^fmck_' "$tmp/key"; then
  echo "Enrollment refused ($status):" >&2
  grep -o '"message":"[^"]*"' "$tmp/key" >&2 || true
  exit 1
fi
cat "$tmp/key" > "$out.new"
chmod 600 "$out.new"
mv "$out.new" "$out"
id=$(grep -i '^x-config-library-key-id:' "$tmp/headers" | tr -d '\r' | awk '{print $2}')
echo "$machine has its config library key ($id) in $out (mode 600)."
