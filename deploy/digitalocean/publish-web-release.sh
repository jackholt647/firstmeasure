#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# == 3 ]] || { echo 'Usage: publish-web-release.sh MANIFEST ARCHIVE PREVIOUS_SHA256|none' >&2; exit 2; }
[[ "${EUID}" == 0 ]] || exit 2
# One designated publisher. Do not run independent publishers on each web node.
systemctl is-active --quiet firstmeasure-legacy.service
exec 9>/run/lock/firstmeasure-release-publish.lock
flock -n 9 || { echo 'Another release publisher is running.' >&2; exit 2; }
export FIRSTMEASURE_RELEASE_PUBLISH_LOCK=held
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
python3 "$script_dir/with-service-environment.py" firstmeasure-legacy.service \
  node "$script_dir/release-channel.mjs" publish "$(realpath "$1")" "$(realpath "$2")" "$3"
