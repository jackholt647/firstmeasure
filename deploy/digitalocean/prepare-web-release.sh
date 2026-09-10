#!/usr/bin/env bash
# Run on the designated controller using an already built, tested Linux stage.
# This publishes code for future booting nodes; it is a production release action.
set -Eeuo pipefail
[[ $# == 5 ]] || { echo 'Usage: prepare-web-release.sh REPOSITORY STAGE COMMIT ARCHIVE PREVIOUS_SHA256|none' >&2; exit 2; }
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
archive="$(realpath -m "$4")"
python3 "$script_dir/release-artifact.py" package --repo "$1" --stage "$2" --commit "$3" --out "$archive"
bash "$script_dir/publish-web-release.sh" "${archive%.*}.json" "$archive" "$5"
