#!/usr/bin/env bash
set -Eeuo pipefail

metadata_url="http://169.254.169.254/metadata/v1/id"
droplet_id="$(curl -fsS --max-time 5 "$metadata_url")"
if [[ ! "$droplet_id" =~ ^[0-9]+$ ]]; then
  echo "DigitalOcean metadata returned an invalid Droplet id." >&2
  exit 1
fi

install -d -m 0755 /run/firstmeasure
umask 0022
printf 'INSTANCE_ID=do-%s\nDROPLET_ID=%s\n' "$droplet_id" "$droplet_id" \
  > /run/firstmeasure/instance.env
