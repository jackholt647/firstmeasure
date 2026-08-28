#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 RELEASE_ID SOURCE_DIRECTORY" >&2
  exit 2
fi

release_id="$1"
source_directory="$(realpath "$2")"
release_root="/opt/firstmeasure/releases"
release_directory="$release_root/$release_id"
staging_directory="$release_root/.$release_id.installing.$$"

if [[ ! "$release_id" =~ ^[A-Za-z0-9._-]{7,80}$ ]]; then
  echo "Invalid release id." >&2
  exit 2
fi
if [[ ! -f "$source_directory/public/v1/package-lock.json" ]]; then
  echo "Source directory is not a FirstMeasure release." >&2
  exit 2
fi
if [[ -e "$release_directory" ]]; then
  echo "Release already exists: $release_directory" >&2
  exit 2
fi

install -d -o firstmeasure -g firstmeasure "$release_root"
install -d -o firstmeasure -g firstmeasure "$staging_directory"
cleanup() {
  if [[ -d "$staging_directory" ]]; then
    rm -rf -- "$staging_directory"
  fi
}
trap cleanup EXIT

if git -C "$source_directory" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ -n "$(git -C "$source_directory" status --porcelain)" ]]; then
    echo "Refusing to install a dirty Git checkout." >&2
    exit 2
  fi
  expected_commit="$(git -C "$source_directory" rev-parse "$release_id^{commit}" 2>/dev/null || true)"
  source_commit="$(git -C "$source_directory" rev-parse HEAD)"
  if [[ -z "$expected_commit" || "$expected_commit" != "$source_commit" ]]; then
    echo "Release id does not resolve to the source checkout's HEAD commit." >&2
    exit 2
  fi
  git -C "$source_directory" archive --format=tar HEAD | tar -xf - -C "$staging_directory"
else
  # Source bundles may be used without Git metadata. Never copy local runtime
  # state, credentials, dependencies, or a previous build into a release.
  tar -C "$source_directory" \
    --exclude='.git' \
    --exclude='.env' \
    --exclude='public/v1/.env' \
    --exclude='private' \
    --exclude='node_modules' \
    --exclude='*/node_modules' \
    --exclude='dist' \
    --exclude='*/dist' \
    --exclude='./storage' \
    --exclude='./storage/*' \
    --exclude='./public/v1/storage' \
    --exclude='./public/v1/storage/*' \
    -cf - . | tar -xf - -C "$staging_directory"
fi
chown -R firstmeasure:firstmeasure "$staging_directory"

runuser -u firstmeasure -- bash -lc "cd '$staging_directory/public/v1' && npm ci --include=dev && npm run check && npm run build && npm prune --omit=dev"
printf 'RELEASE_ID=%s\n' "$release_id" > "$staging_directory/release.env"
chown firstmeasure:firstmeasure "$staging_directory/release.env"
mv "$staging_directory" "$release_directory"
trap - EXIT
echo "Prepared release $release_id. The current symlink and services were not changed."
