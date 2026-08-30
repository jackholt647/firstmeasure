#!/usr/bin/env bash
set -euo pipefail

seed=/root/firstmeasure-development-config-seed
target=/etc/firstmeasure
install -d -m 750 -o root -g firstmeasure "$target"

strip_sensitive() {
  awk -F= '
    !/^(DATABASE_URL|DATABASE_ADMIN_URL|SPACES_ENDPOINT|SPACES_REGION|SPACES_BUCKET|SPACES_ACCESS_KEY_ID|SPACES_SECRET_ACCESS_KEY|SPACES_FORCE_PATH_STYLE|PLATFORM_SESSION_SECRET|LEGACY_PROXY_SECRET|FIRSTMEASURE_INTERNAL_API_SECRET|META_CAPI_ACCESS_TOKEN)=/
  ' "$1"
}

strip_development_endpoints() {
  awk -F= '
    !/^(DATABASE_URL|DATABASE_ADMIN_URL|SPACES_ENDPOINT|SPACES_REGION|SPACES_BUCKET|SPACES_ACCESS_KEY_ID|SPACES_SECRET_ACCESS_KEY|SPACES_FORCE_PATH_STYLE)=/
  ' "$1"
}

umask 077
strip_sensitive "$seed/common.env" > "$target/common.env"
strip_development_endpoints "$seed/development.env" > "$target/development.env"

app_uri="$(tr -d '\r\n' < "$target/db-development-app.uri")"
admin_uri="$(tr -d '\r\n' < "$target/db-development-admin.uri")"
admin_uri="${admin_uri/defaultdb/firstmeasure_development}"

{
  printf 'DATABASE_URL="%s"\n' "$app_uri"
  printf 'DATABASE_ADMIN_URL="%s"\n' "$admin_uri"
  while IFS= read -r line; do
    line="${line%$'\r'}"
    case "$line" in
      SPACES_*=*) printf '%s\n' "$line" ;;
    esac
  done < "$target/spaces-development.env"
} >> "$target/development.env"

install -m 640 -o root -g firstmeasure "$seed/web.env" "$target/web.env"
install -m 640 -o root -g firstmeasure "$seed/worker.env" "$target/worker.env"
install -m 640 -o root -g firstmeasure "$seed/legacy.env" "$target/legacy.env"
install -m 640 -o root -g firstmeasure "$seed/ca-certificate.crt" "$target/ca-certificate.crt"
install -m 640 -o root -g firstmeasure "$seed/provider-keys.json" "$target/provider-keys.json"
chown root:firstmeasure "$target/common.env" "$target/development.env"
chmod 640 "$target/common.env" "$target/development.env"

echo DEVELOPMENT_CONFIG_ASSEMBLED
sed -n 's/^\([A-Z0-9_]*\)=.*/\1/p' "$target/development.env" | sort -u | wc -l
