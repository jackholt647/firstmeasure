#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 RELEASE_ID firstmeasure-web.service|firstmeasure-worker.service|firstmeasure-legacy.service" >&2
  exit 2
fi

release_id="$1"
service_name="$2"
case "$service_name" in
  firstmeasure-web.service|firstmeasure-worker.service|firstmeasure-legacy.service) ;;
  *) echo "Unsupported service: $service_name" >&2; exit 2 ;;
esac

release_directory="/opt/firstmeasure/releases/$release_id"
if [[ ! -f "$release_directory/public/v1/dist/src/server.js" ]]; then
  echo "Compiled release is missing: $release_directory" >&2
  exit 2
fi

previous_target="$(readlink -f /opt/firstmeasure/current 2>/dev/null || true)"
php_fpm_service="${FIRSTMEASURE_PHP_FPM_SERVICE:-php8.3-fpm.service}"

restart_release_services() {
  systemctl restart "$service_name" || return 1
  if [[ "$service_name" == "firstmeasure-legacy.service" ]]; then
    # The compatibility host serves the PHP staff portal from the `current`
    # symlink. Restart FPM as part of the release so its realpath/opcache does
    # not keep executing PHP from the previous release directory.
    systemctl restart "$php_fpm_service" || return 1
  fi
}

ln -sfn "$release_directory" /opt/firstmeasure/current.next
mv -Tf /opt/firstmeasure/current.next /opt/firstmeasure/current

if restart_release_services; then
  if [[ "$service_name" == "firstmeasure-worker.service" ]]; then
    worker_started_at="$(systemctl show "$service_name" --property=ActiveEnterTimestamp --value)"
    deadline=$((SECONDS + 180))
    while (( SECONDS < deadline )); do
      if ! systemctl is-active --quiet "$service_name"; then
        break
      fi
      if journalctl -u "$service_name" --since "$worker_started_at" --no-pager \
        | grep -q 'dedicated background worker is ready'; then
        echo "Activated $release_id for $service_name."
        exit 0
      fi
      sleep 2
    done
  elif bash /opt/firstmeasure/current/deploy/digitalocean/verify-node.sh; then
    echo "Activated $release_id for $service_name."
    exit 0
  fi
fi

echo "Activation failed; restoring the previous release." >&2
if [[ -n "$previous_target" && -d "$previous_target" ]]; then
  ln -sfn "$previous_target" /opt/firstmeasure/current.next
  mv -Tf /opt/firstmeasure/current.next /opt/firstmeasure/current
  restart_release_services
fi
exit 1
