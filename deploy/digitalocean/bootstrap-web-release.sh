#!/usr/bin/env bash
# Called only on a new/rebooting node before its web service is allowed to start.
set -Eeuo pipefail
[[ "$EUID" == 0 && "$(uname -sm)" == 'Linux x86_64' ]] || exit 2
if systemctl is-active --quiet firstmeasure-web.service; then
  echo 'Refusing bootstrap on a serving web node.' >&2
  exit 2
fi
exec 9>/run/lock/firstmeasure-release-bootstrap.lock
flock -n 9 || exit 2
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
download_dir="$(mktemp -d /var/tmp/firstmeasure-release.XXXXXXXX)"
trap 'rm -rf -- "$download_dir"' EXIT
python3 "$script_dir/with-service-environment.py" firstmeasure-web.service \
  node "$script_dir/release-channel.mjs" download "$download_dir"
target="$(python3 "$script_dir/release-artifact.py" install --archive "$download_dir/release.tar.gz" --manifest "$download_dir/release.json")"
[[ "$target" =~ ^/opt/firstmeasure/releases/[a-f0-9]{40}$ ]]
# Check compiled entry point syntax before switching. No code or SQL is executed.
node --check "$target/public/v1/dist/src/server.js"
if systemctl is-active --quiet firstmeasure-web.service; then
  echo 'Web service started during preparation; refusing to switch its code.' >&2
  exit 2
fi
ln -sfn "$target" /opt/firstmeasure/current.next
mv -Tf /opt/firstmeasure/current.next /opt/firstmeasure/current
echo 'Verified replacement-node code installed; web service remains stopped.'
