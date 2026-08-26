#!/usr/bin/env bash
set -Eeuo pipefail

# One-command production activation for the dedicated FirstMeasure worker.
# The existing HTTP service remains online while TypeScript is compiled; the
# only application downtime is the final firstmate-v1 restart.

V1_ROOT="${1:-/var/www/ide/v1}"
HTTP_SERVICE="${FIRSTMEASURE_HTTP_SERVICE:-firstmate-v1.service}"
WORKER_SERVICE="${FIRSTMEASURE_WORKER_SERVICE:-firstmeasure-worker.service}"
ENV_FILE="${FIRSTMEASURE_ENV_FILE:-/var/www/.env}"
HEALTH_PORT="${V1_PORT:-3101}"
SYSTEMD_ROOT="/etc/systemd/system"
DROPIN_DIR="${SYSTEMD_ROOT}/${HTTP_SERVICE}.d"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKER_TEMPLATE="${SCRIPT_DIR}/firstmeasure-worker.service.example"
WEB_DROPIN="${SCRIPT_DIR}/firstmate-v1-background-role.conf"
WEB_RESILIENCE_DROPIN="${SCRIPT_DIR}/firstmate-v1-resilience.conf"
TEMP_UNIT=""

cleanup() {
  if [[ -n "${TEMP_UNIT}" && -f "${TEMP_UNIT}" ]]; then
    rm -f -- "${TEMP_UNIT}"
  fi
}
trap cleanup EXIT

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "Run this script with sudo."
[[ -d "${V1_ROOT}" ]] || fail "V1 directory not found: ${V1_ROOT}"
[[ -f "${V1_ROOT}/package.json" ]] || fail "package.json is missing from ${V1_ROOT}"
[[ -f "${V1_ROOT}/src/firstmeasure_worker.ts" ]] || fail "The new worker source has not been uploaded."
[[ -f "${WORKER_TEMPLATE}" ]] || fail "Worker service template is missing."
[[ -f "${WEB_DROPIN}" ]] || fail "HTTP service drop-in is missing."
[[ -f "${WEB_RESILIENCE_DROPIN}" ]] || fail "HTTP resilience drop-in is missing."
systemctl cat "${HTTP_SERVICE}" >/dev/null 2>&1 || fail "Systemd service ${HTTP_SERVICE} was not found."

SERVICE_USER="$(systemctl show "${HTTP_SERVICE}" --property=User --value)"
SERVICE_GROUP="$(systemctl show "${HTTP_SERVICE}" --property=Group --value)"
MAIN_PID="$(systemctl show "${HTTP_SERVICE}" --property=MainPID --value)"

if [[ -z "${SERVICE_USER}" && "${MAIN_PID}" =~ ^[1-9][0-9]*$ ]]; then
  SERVICE_USER="$(ps -o user= -p "${MAIN_PID}" | xargs)"
fi
if [[ -z "${SERVICE_GROUP}" && "${MAIN_PID}" =~ ^[1-9][0-9]*$ ]]; then
  SERVICE_GROUP="$(ps -o group= -p "${MAIN_PID}" | xargs)"
fi
SERVICE_USER="${SERVICE_USER:-root}"
SERVICE_GROUP="${SERVICE_GROUP:-${SERVICE_USER}}"

[[ "${SERVICE_USER}" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "Unsafe service user value: ${SERVICE_USER}"
[[ "${SERVICE_GROUP}" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "Unsafe service group value: ${SERVICE_GROUP}"
[[ -f "${ENV_FILE}" ]] || fail "Environment file not found: ${ENV_FILE}"

echo "Building the uploaded release while ${HTTP_SERVICE} remains online..."
cd -- "${V1_ROOT}"
npm run check
npm run build

[[ -f "dist/src/server.js" ]] || fail "Compiled HTTP entrypoint is missing."
[[ -f "dist/src/firstmeasure_worker.js" ]] || fail "Compiled worker entrypoint is missing."
node --check dist/src/server.js
node --check dist/src/firstmeasure_worker.js

echo "Installing systemd configuration for user ${SERVICE_USER}:${SERVICE_GROUP}..."
install -d -m 0755 -- "${DROPIN_DIR}"
install -m 0644 -- "${WEB_DROPIN}" "${DROPIN_DIR}/10-background-role.conf"
install -m 0644 -- "${WEB_RESILIENCE_DROPIN}" "${DROPIN_DIR}/20-resilience.conf"

TEMP_UNIT="$(mktemp)"
sed \
  -e "s/REPLACE_WITH_FIRSTMATE_SERVICE_USER/${SERVICE_USER}/g" \
  -e "s/REPLACE_WITH_FIRSTMATE_SERVICE_GROUP/${SERVICE_GROUP}/g" \
  -e "s|WorkingDirectory=/var/www/ide/v1|WorkingDirectory=${V1_ROOT}|g" \
  -e "s|EnvironmentFile=/var/www/.env|EnvironmentFile=${ENV_FILE}|g" \
  "${WORKER_TEMPLATE}" > "${TEMP_UNIT}"
install -m 0644 -- "${TEMP_UNIT}" "${SYSTEMD_ROOT}/${WORKER_SERVICE}"

systemctl daemon-reload

echo "Starting the dedicated worker before the short HTTP restart..."
systemctl enable "${WORKER_SERVICE}" >/dev/null
systemctl restart "${WORKER_SERVICE}"
systemctl is-active --quiet "${WORKER_SERVICE}" || fail "${WORKER_SERVICE} did not start."

# Give the worker time to initialize the database schema and write its first
# heartbeat before the web process begins reporting shared worker health.
sleep 2

echo "Restarting ${HTTP_SERVICE}..."
systemctl restart "${HTTP_SERVICE}"
systemctl is-active --quiet "${HTTP_SERVICE}" || fail "${HTTP_SERVICE} did not restart."

HTTP_OK=0
BACKGROUND_OK=0
for _attempt in $(seq 1 30); do
  if curl --silent --fail --max-time 2 "http://127.0.0.1:${HEALTH_PORT}/v1/firstmeasure/ping" >/dev/null; then
    HTTP_OK=1
  fi
  if curl --silent --fail --max-time 2 "http://127.0.0.1:${HEALTH_PORT}/v1/firstmeasure/health/background" >/dev/null; then
    BACKGROUND_OK=1
  fi
  if [[ "${HTTP_OK}" -eq 1 && "${BACKGROUND_OK}" -eq 1 ]]; then
    break
  fi
  sleep 1
done

[[ "${HTTP_OK}" -eq 1 ]] || fail "The HTTP health check did not recover on port ${HEALTH_PORT}."
[[ "${BACKGROUND_OK}" -eq 1 ]] || fail "The background worker heartbeat did not become healthy."

echo
echo "Deployment complete."
echo "  HTTP service:       active"
echo "  Background worker:  active with a fresh heartbeat"
echo "  Health endpoint:    http://127.0.0.1:${HEALTH_PORT}/v1/firstmeasure/health/background"
