#!/usr/bin/env bash
set -Eeuo pipefail

base_url="${1:-http://127.0.0.1:3101}"
deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
  body="$(curl --silent --show-error --fail --max-time 5 "$base_url/v1/health/ready" 2>/dev/null || true)"
  if [[ "$body" == *'"ok":true'* ]]; then
    echo "$body"
    exit 0
  fi
  sleep 2
done
echo "Node did not become ready within 180 seconds." >&2
exit 1
