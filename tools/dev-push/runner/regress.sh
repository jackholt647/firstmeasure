#!/usr/bin/env bash
# Regression runner for the dev push router (docs/architecture/dev-lanes.md, "Checks"). Installed on the agent droplet
# (fm-agents-1: 8 vCPU, Chromium) as the forced command of the router's key; the router sends
#   regress <40-hex commit> <test id>...
# where each id is v1:tests/<file>, v1:npm:<script>, v1:cmd:localization-check or root:tests/<file>. The commit is
# fetched from the router's repository (ref regress/<commit>, pushed by the router), checked out, node_modules installed
# once per package-lock, and each suite runs on its own with Chromium; one JSON line per suite goes back:
#   {"id": "...", "ok": true|false, "ms": 1234, "output": "<last 4000 characters>"}
set -uo pipefail
export PATH="$HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
read -r -a argv <<< "${SSH_ORIGINAL_COMMAND:-}"
[ "${argv[0]:-}" = regress ] || { echo '{"error":"usage: regress <commit> <test id>..."}'; exit 2; }
sha=${argv[1]:-}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo '{"error":"bad commit"}'; exit 2; }
ids=("${argv[@]:2}")
for id in "${ids[@]}"; do
  [[ "$id" =~ ^(v1:(tests/[A-Za-z0-9._/-]+|npm:[a-z0-9:_-]+|cmd:localization-check)|root:tests/[A-Za-z0-9._-]+)$ ]] || { echo "{\"error\":\"bad test id $id\"}"; exit 2; }
done

work=${DEV_PUSH_RUNNER_HOME:-$HOME/dev-push-runner}
repo=$work/repo.git
mkdir -p "$work"
exec 9>"$work/.lock"; flock 9   # one run at a time
[ -d "$repo" ] || git init -q --bare "$repo"
git -C "$repo" fetch -q "${DEV_PUSH_ROUTER_REPO:-dev-sync-droplet:/home/dev/router/firstmeasure.git}" "+refs/heads/regress/$sha:refs/regress/$sha" || { echo '{"error":"fetch failed"}'; exit 3; }
tree=$work/tree
git -C "$repo" worktree prune
[ -d "$tree/.git" ] || [ -f "$tree/.git" ] || git -C "$repo" worktree add -q --detach --force "$tree" "$sha"
git -C "$tree" checkout -q --detach -f "$sha" && git -C "$tree" clean -fdq -e node_modules

# node_modules per package-lock and Node version.
hash=$( (cat "$tree/public/v1/package.json" "$tree/public/v1/package-lock.json"; node --version) | sha256sum | cut -c1-16)
modules=$work/modules/$hash
if [ ! -d "$modules/node_modules" ]; then
  rm -rf "$modules.tmp" && mkdir -p "$modules.tmp" && cp "$tree/public/v1/package.json" "$tree/public/v1/package-lock.json" "$modules.tmp/"
  (cd "$modules.tmp" && npm ci --no-audit --no-fund >/dev/null 2>&1) && mv "$modules.tmp" "$modules" || { echo '{"error":"npm ci failed"}'; exit 4; }
fi
ln -sfn "$modules/node_modules" "$tree/public/v1/node_modules"

chrome=${CHROME_PATH:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | tail -1)}
export CHROME_PATH=$chrome PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$chrome
export FIRSTMEASURE_INTERNAL_API_SECRET=ci-test-internal-service-secret CI=1 NODE_OPTIONS=--max-old-space-size=4096

for id in "${ids[@]}"; do
  scope=${id%%:*}; rest=${id#*:}
  case "$scope:$rest" in
    v1:npm:*) dir=$tree/public/v1; cmd=(npm run --silent "${rest#npm:}") ;;
    v1:cmd:localization-check) dir=$tree/public/v1; cmd=(node scripts/localization-catalogs.mjs --check) ;;
    v1:*-postgres.test.ts) dir=$tree/public/v1; cmd=(node tests/run-embedded-postgres.mjs "$rest") ;;
    v1:*) dir=$tree/public/v1; cmd=(node --experimental-sqlite --import tsx --test --test-force-exit "$rest") ;;
    root:*) dir=$tree; cmd=(node --test --test-force-exit "$rest") ;;
  esac
  start=$(date +%s%3N)
  output=$(cd "$dir" && timeout 900 "${cmd[@]}" 2>&1); code=$?
  ms=$(( $(date +%s%3N) - start ))
  python3 -c 'import json,sys; print(json.dumps({"id": sys.argv[1], "ok": sys.argv[2] == "0", "ms": int(sys.argv[3]), "output": sys.stdin.read()[-4000:]}))' "$id" "$code" "$ms" <<< "$output"
done
