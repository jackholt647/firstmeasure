#!/usr/bin/env bash
set -Eeuo pipefail

# Both inline instant reports on web nodes and queued PDFs need Chromium.
# Use the browser revision required by the deployed, locked Playwright package.
app_root="${1:-/opt/firstmeasure/current/public/v1}"
export PLAYWRIGHT_BROWSERS_PATH=/opt/firstmeasure/browsers
export DEBIAN_FRONTEND=noninteractive
node "$app_root/node_modules/playwright-core/cli.js" install --with-deps --only-shell chromium

revision="$(node -e 'const p=require(process.argv[1]); const b=p.browsers.find(x=>x.name==="chromium-headless-shell"); if(!b)process.exit(1); process.stdout.write(b.revision)' "$app_root/node_modules/playwright-core/browsers.json")"
[[ "$revision" =~ ^[0-9]+$ ]]
browser="$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-$revision/chrome-headless-shell-linux64/chrome-headless-shell"
[[ -x "$browser" ]]
# Preserve a system-managed Chromium installation if one already exists.
if [[ ! -e /usr/bin/chromium ]]; then
    ln -s "$browser" /usr/bin/chromium
fi
runuser -u firstmeasure -- /usr/bin/chromium --version
