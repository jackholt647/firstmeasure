#!/usr/bin/env bash
set -Eeuo pipefail

production_confirmation="COPY_PRODUCTION_SNAPSHOT_TO_PRODUCTION"

usage() {
  cat >&2 <<'EOF'
Usage: sync-legacy-clone.sh \
  --source-storage-root /snapshot/v1/storage \
  --source-public-root /snapshot/public \
  --source-id SNAPSHOT_ID \
  --target-environment development|production \
  --target-root /var/lib/firstmeasure-legacy-development \
  [--apply --confirm-read-only-source] \
  [--confirm-production COPY_PRODUCTION_SNAPSHOT_TO_PRODUCTION]
EOF
  exit 2
}

source_storage_root=""
source_public_root=""
source_id=""
target_environment=""
target_root=""
confirm_production=""
apply=0
confirm_read_only=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-storage-root) source_storage_root="${2:-}"; shift 2 ;;
    --source-public-root) source_public_root="${2:-}"; shift 2 ;;
    --source-id) source_id="${2:-}"; shift 2 ;;
    --target-environment) target_environment="${2:-}"; shift 2 ;;
    --target-root) target_root="${2:-}"; shift 2 ;;
    --confirm-production) confirm_production="${2:-}"; shift 2 ;;
    --apply) apply=1; shift ;;
    --confirm-read-only-source) confirm_read_only=1; shift ;;
    *) usage ;;
  esac
done

[[ -n "$source_storage_root" && -n "$source_public_root" && -n "$source_id" && -n "$target_environment" && -n "$target_root" ]] || usage
[[ "$target_environment" == "development" || "$target_environment" == "production" ]] || usage
[[ "$source_id" =~ ^[A-Za-z0-9._-]{3,100}$ ]] || { echo "Invalid source id." >&2; exit 2; }

source_storage_root="$(realpath "$source_storage_root")"
source_public_root="$(realpath "$source_public_root")"
target_root="$(realpath -m "$target_root")"
expected_target_root="/var/lib/firstmeasure-legacy-$target_environment"

if [[ "$target_root" != "$expected_target_root" ]]; then
  echo "Target root must be exactly $expected_target_root." >&2
  exit 2
fi
if [[ "$target_environment" == "production" && "$apply" -eq 1 && "$confirm_production" != "$production_confirmation" ]]; then
  echo "Production legacy writes require --confirm-production $production_confirmation." >&2
  exit 2
fi
if [[ "$apply" -eq 1 && "$confirm_read_only" -ne 1 ]]; then
  echo "Applied legacy synchronization requires --confirm-read-only-source." >&2
  exit 2
fi

mount_options="$(findmnt -n -o OPTIONS --target "$source_storage_root" 2>/dev/null || true)"
if [[ "$apply" -eq 1 && ",$mount_options," != *,ro,* ]]; then
  echo "Source storage is not mounted read-only: $source_storage_root" >&2
  exit 2
fi

declare -a mappings=(
  "$source_storage_root/internal|v1/internal"
  "$source_storage_root/crm|v1/crm"
  "$source_storage_root/communications|v1/communications"
  "$source_public_root/measure/internal/tutorials|tutorials"
  "$source_public_root/storage|public-storage"
)

if [[ "$apply" -ne 1 ]]; then
  echo "Legacy clone dry run: source=$source_id target=$target_environment"
  for mapping in "${mappings[@]}"; do
    source_path="${mapping%%|*}"
    relative_target="${mapping#*|}"
    if [[ -d "$source_path" ]]; then
      files="$(find "$source_path" -type f -printf '.' | wc -c)"
      bytes="$(du -sb "$source_path" | awk '{print $1}')"
      echo "$relative_target files=$files bytes=$bytes"
    else
      echo "$relative_target missing"
    fi
  done
  exit 0
fi

install -d -m 0750 -o firstmeasure -g firstmeasure "$target_root" "$target_root/releases"
marker="$target_root/.firstmeasure-data-environment"
if [[ -f "$marker" ]]; then
  existing_environment="$(tr -d '[:space:]' < "$marker")"
  if [[ "$existing_environment" != "$target_environment" ]]; then
    echo "Legacy volume is marked '$existing_environment', expected '$target_environment'." >&2
    exit 2
  fi
else
  printf '%s\n' "$target_environment" > "$marker"
  chown firstmeasure:firstmeasure "$marker"
  chmod 0640 "$marker"
fi

release_directory="$target_root/releases/$source_id"
staging_directory="$target_root/releases/.$source_id.staging.$$"
if [[ -e "$release_directory" || -e "$staging_directory" ]]; then
  echo "Legacy clone release already exists for source id $source_id." >&2
  exit 2
fi
install -d -m 0750 -o firstmeasure -g firstmeasure "$staging_directory"
cleanup() {
  if [[ -d "$staging_directory" ]]; then
    rm -rf -- "$staging_directory"
  fi
}
trap cleanup EXIT

current_directory=""
if [[ -L "$target_root/current" ]]; then
  current_directory="$(realpath "$target_root/current")"
fi

for mapping in "${mappings[@]}"; do
  source_path="${mapping%%|*}"
  relative_target="${mapping#*|}"
  destination_path="$staging_directory/$relative_target"
  install -d -m 0750 -o firstmeasure -g firstmeasure "$destination_path"
  [[ -d "$source_path" ]] || continue
  link_arguments=()
  if [[ -n "$current_directory" && -d "$current_directory/$relative_target" ]]; then
    link_arguments=("--link-dest=$current_directory/$relative_target")
  fi
  rsync -aH --numeric-ids --checksum "${link_arguments[@]}" "$source_path/" "$destination_path/"
  differences="$(rsync -aHnc --delete --itemize-changes "$source_path/" "$destination_path/")"
  if [[ -n "$differences" ]]; then
    echo "Legacy verification failed for $relative_target:" >&2
    echo "$differences" >&2
    exit 1
  fi
done

printf '{"source_id":"%s","target_environment":"%s","created_at":"%s"}\n' \
  "$source_id" "$target_environment" "$(date --iso-8601=seconds)" > "$staging_directory/clone.json"
chown -R firstmeasure:firstmeasure "$staging_directory"
mv "$staging_directory" "$release_directory"
trap - EXIT

next_link="$target_root/.current.$$.next"
ln -s "releases/$source_id" "$next_link"
mv -Tf "$next_link" "$target_root/current"

echo "Legacy clone installed at $release_directory"
echo "Current legacy clone now points to source $source_id"
echo "Restart only the target environment's legacy service so open SQLite handles use the new release."
