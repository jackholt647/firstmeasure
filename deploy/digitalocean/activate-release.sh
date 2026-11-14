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

# Fail BEFORE changing symlinks or services if future autoscaled production nodes
# would boot different code. Publish the tested artifact on the release controller
# first. This also applies to deliberate web rollbacks: restore the channel first.
if [[ "$service_name" == "firstmeasure-web.service" ]]; then
  activation_script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
  python3 "$activation_script_dir/with-service-environment.py" "$service_name" \
    node "$activation_script_dir/release-channel.mjs" require-target "$release_directory"
fi

previous_target="$(readlink -f /opt/firstmeasure/current 2>/dev/null || true)"
activation_dir="$(cd -- "$(dirname -- "$0")" && pwd)"

# Housekeeping after a successful activation: keep the hourly release pruning
# timer installed and start one pruning run in the background, so activation is
# not delayed and its output (callers read its last line) is unchanged. Pruning
# never deletes the active release, a symlinked one, one a running process uses
# or the newest four (prune-releases.py). Never fails the activation.
prune_after_activation() {
  if [[ -z "${FIRSTMEASURE_SYSTEMCTL:-}" && -f "$activation_dir/install-release-prune.sh" ]]; then
    bash "$activation_dir/install-release-prune.sh" >/dev/null 2>&1 || true
  fi
  if "$systemctl_command" start --no-block firstmeasure-release-prune.service >/dev/null 2>&1; then
    return 0
  fi
  if [[ -f "$activation_dir/prune-releases.py" ]]; then
    python3 "$activation_dir/prune-releases.py" --root /opt/firstmeasure >/dev/null 2>&1 || true
  fi
  return 0
}
php_fpm_service="${FIRSTMEASURE_PHP_FPM_SERVICE:-php8.3-fpm.service}"
# Overridable only so test_release_activation.py can run this against a fake host.
systemctl_command="${FIRSTMEASURE_SYSTEMCTL:-systemctl}"
journalctl_command="${FIRSTMEASURE_JOURNALCTL:-journalctl}"
proc_root="${FIRSTMEASURE_PROC:-/proc}"
node_http="${FIRSTMEASURE_NODE_HTTP:-http://127.0.0.1:3101}"
rolling_timeout="${FIRSTMEASURE_ROLLING_TIMEOUT:-600}"

# Compatibility is one host: a restart stops every worker at once and starts cold ones into the
# backlog, which stalled it under load (FM-389). Its cluster primary instead replaces workers one
# at a time on SIGHUP, from the release `current` points at, keeping warm workers throughout.
# The primary keeps running the code it started with, so that is used only when the running
# primary has it and its server.js is the new release's; otherwise (the first release with it, a
# change to the primary, a stopped service) the service restarts as before.
# FIRSTMEASURE_LEGACY_ACTIVATION=restart forces a restart.
rolling_replace_possible() {
  local target="$1" pid started
  [[ "$service_name" == "firstmeasure-legacy.service" ]] || return 1
  [[ "${FIRSTMEASURE_LEGACY_ACTIVATION:-rolling}" == "rolling" ]] || return 1
  "$systemctl_command" is-active --quiet "$service_name" || return 1
  pid="$("$systemctl_command" show "$service_name" -p MainPID --value)"
  [[ -n "$pid" && "$pid" != 0 ]] || return 1
  # Only a cluster primary (its workers are its children) can hand over to a new worker.
  [[ -n "$(cat "$proc_root/$pid/task/$pid/children" 2>/dev/null)" ]] || return 1
  started="$(readlink -f "$proc_root/$pid/cwd")" || return 1
  grep -q 'v1-rolling-replace' "$started/dist/src/server.js" 2>/dev/null || return 1
  cmp -s "$started/dist/src/server.js" "$target/public/v1/dist/src/server.js" || return 1
}

# SIGHUP to the primary, then wait for its log to say the replace onto this release finished.
rolling_replace() {
  local target="$1" expected pid since log
  expected="$(sed -n 's/^RELEASE_ID=//p' "$target/release.env" 2>/dev/null | tail -n 1)"
  [[ -n "$expected" ]] || expected="$(basename "$target")"
  pid="$("$systemctl_command" show "$service_name" -p MainPID --value)"
  # journalctl --since has whole seconds: wait out the second of any earlier replace's last line.
  sleep 1
  since="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  "$systemctl_command" kill --kill-whom=main --signal=SIGHUP "$service_name" || return 1
  local deadline=$((SECONDS + rolling_timeout))
  while (( SECONDS < deadline )); do
    sleep 2
    if [[ "$("$systemctl_command" show "$service_name" -p MainPID --value)" != "$pid" ]]; then
      echo "The compatibility primary restarted during the rolling replace." >&2
      return 1
    fi
    log="$("$journalctl_command" -u "$service_name" --since "$since" --no-pager -o cat 2>/dev/null | grep 'v1 HTTP cluster rolling replace' || true)"
    if grep -q "rolling replace complete: release=$expected " <<<"$log"; then
      # Every worker answers for the new release (the primary hands connections round robin).
      local attempt body
      for attempt in 1 2 3 4 5 6 7 8; do
        body="$(curl --silent --max-time 5 "$node_http/v1/health/ready" || true)"
        [[ "$body" == *"\"release_id\":\"$expected\""* ]] || { echo "A worker does not answer for $expected: ${body:0:200}" >&2; return 1; }
      done
      return 0
    fi
    if grep -q 'rolling replace failed' <<<"$log"; then
      grep 'rolling replace failed' <<<"$log" | tail -n 1 >&2
      return 1
    fi
  done
  echo "The rolling replace did not finish within ${rolling_timeout} s." >&2
  return 1
}

activate_release_services() {
  local target="$1"
  if rolling_replace_possible "$target"; then
    rolling_replace "$target" || return 1
    activation_method="rolling replace"
    # PHP-FPM reloads gracefully, as the fast path does: in-flight PHP requests finish.
    "$systemctl_command" reload "$php_fpm_service" || return 1
    return 0
  fi
  activation_method="restart"
  restart_release_services
}

restart_release_services() {
  "$systemctl_command" restart "$service_name" || return 1
  if [[ "$service_name" == "firstmeasure-web.service" || "$service_name" == "firstmeasure-legacy.service" ]]; then
    # Both web (customer portal) and compatibility (staff portal) serve PHP.
    # Refresh FPM on activation AND rollback so PHP includes and Node/assets
    # cannot belong to different releases. Workers do not run PHP.
    "$systemctl_command" restart "$php_fpm_service" || return 1
  fi
}

activation_method="restart"
ln -sfn "$release_directory" /opt/firstmeasure/current.next
mv -Tf /opt/firstmeasure/current.next /opt/firstmeasure/current

if activate_release_services "$release_directory"; then
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
        prune_after_activation
        exit 0
      fi
      sleep 2
    done
  elif bash /opt/firstmeasure/current/deploy/digitalocean/verify-node.sh "$node_http"; then
    echo "Activated $release_id for $service_name ($activation_method)."
    prune_after_activation
    exit 0
  fi
fi

echo "Activation failed; restoring the previous release." >&2
if [[ -n "$previous_target" && -d "$previous_target" ]]; then
  ln -sfn "$previous_target" /opt/firstmeasure/current.next
  mv -Tf /opt/firstmeasure/current.next /opt/firstmeasure/current
  # Workers a failed rolling replace already moved go back the same way, keeping warm workers;
  # a restart is the last resort.
  if rolling_replace_possible "$previous_target" && rolling_replace "$previous_target"; then
    "$systemctl_command" reload "$php_fpm_service" || "$systemctl_command" restart "$php_fpm_service"
  else
    restart_release_services
  fi
fi
exit 1
