#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: prepare-live-clone-bundle.sh \
  --app-root /var/www/ide/v1 \
  --volume-root /mnt/volume_sfo3_01 \
  --source-id SOURCE_ID \
  --apply --confirm-live-source-read

Creates a new immutable migration bundle on the attached data volume. It does
not stop or restart services and never writes to the live SQLite databases.
EOF
  exit 2
}

app_root=""
volume_root=""
source_id=""
apply=0
confirm_live_source=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-root) app_root="${2:-}"; shift 2 ;;
    --volume-root) volume_root="${2:-}"; shift 2 ;;
    --source-id) source_id="${2:-}"; shift 2 ;;
    --apply) apply=1; shift ;;
    --confirm-live-source-read) confirm_live_source=1; shift ;;
    *) usage ;;
  esac
done

[[ -n "$app_root" && -n "$volume_root" && -n "$source_id" ]] || usage
[[ "$source_id" =~ ^[A-Za-z0-9._-]{3,100}$ ]] || { echo "Invalid source id." >&2; exit 2; }

app_root="$(realpath "$app_root")"
volume_root="$(realpath "$volume_root")"
storage_root="$app_root/storage"
public_root="$app_root/public"
bundle_parent="$volume_root/firstmeasure-clone-sources"
bundle_root="$bundle_parent/$source_id"
staging_root="$bundle_parent/.$source_id.staging"
script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ -d "$storage_root" ]] || { echo "Storage root is missing: $storage_root" >&2; exit 2; }
[[ -d "$volume_root/measure/internal/saves" ]] || { echo "Project volume layout is missing under $volume_root." >&2; exit 2; }
[[ "$(findmnt -n -o TARGET --target "$volume_root")" == "$volume_root" ]] || {
  echo "Volume root is not a mount point: $volume_root" >&2
  exit 2
}
case "$bundle_root" in
  "$volume_root"/firstmeasure-clone-sources/*) ;;
  *) echo "Unsafe bundle path: $bundle_root" >&2; exit 2 ;;
esac
[[ ! -e "$bundle_root" && ! -e "$staging_root" ]] || {
  echo "Clone bundle or staging path already exists for $source_id." >&2
  exit 2
}

if [[ "$apply" -ne 1 ]]; then
  echo "Live clone bundle dry run"
  echo "source storage: $storage_root"
  echo "project data:   $volume_root/measure/internal/saves"
  echo "bundle target:  $bundle_root"
  find "$storage_root" -xdev -type f -name '*.sqlite' -printf 'sqlite %s %p\n'
  exit 0
fi
[[ "$confirm_live_source" -eq 1 ]] || {
  echo "Applied preparation requires --confirm-live-source-read." >&2
  exit 2
}

install -d -m 0750 -o root -g root "$bundle_parent" "$staging_root/v1/storage" "$staging_root/public"

rsync -aH --numeric-ids --one-file-system \
  --exclude '/firstmeasure/projects' \
  --exclude '*.sqlite' \
  --exclude '*.sqlite-wal' \
  --exclude '*.sqlite-shm' \
  "$storage_root/" "$staging_root/v1/storage/"

while IFS= read -r -d '' sqlite_source; do
  sqlite_relative="${sqlite_source#"$storage_root"/}"
  sqlite_destination="$staging_root/v1/storage/$sqlite_relative"
  node --experimental-sqlite "$script_root/sqlite-online-backup.mjs" \
    "$sqlite_source" "$sqlite_destination"
done < <(find "$storage_root" -xdev -type f -name '*.sqlite' -print0)

install -d -m 0750 "$staging_root/v1/storage/firstmeasure"
ln -s ../../../../../measure/internal/saves "$staging_root/v1/storage/firstmeasure/projects"

if [[ -d "$public_root/measure/internal/tutorials" ]]; then
  install -d -m 0750 "$staging_root/public/measure/internal/tutorials"
  rsync -aH --numeric-ids "$public_root/measure/internal/tutorials/" \
    "$staging_root/public/measure/internal/tutorials/"
fi
if [[ -d "$public_root/storage" ]]; then
  install -d -m 0750 "$staging_root/public/storage"
  rsync -aH --numeric-ids "$public_root/storage/" "$staging_root/public/storage/"
fi

printf '{"source_id":"%s","created_at":"%s","source_app_root":"%s","source_volume_root":"%s"}\n' \
  "$source_id" "$(date --iso-8601=seconds)" "$app_root" "$volume_root" > "$staging_root/source.json"

mv "$staging_root" "$bundle_root"
sync -f "$bundle_root"
echo "Live clone bundle is ready: $bundle_root"
echo "Create a snapshot of the volume only after this command completes successfully."
