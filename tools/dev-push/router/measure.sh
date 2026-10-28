#!/usr/bin/env bash
# Times every check piece on the dev sync droplet (docs/architecture/dev-lanes.md, "Checks"): run as `dev` there.
# Output: ~/dev-push/measure/results.tsv (stage<TAB>seconds<TAB>exit). Uses the router's platform worktree; run it while idle.
set -u
export PATH=$HOME/.local/node/bin:$PATH
W=$HOME/dev-push/state/work/platform
OUT=$HOME/dev-push/measure
rm -rf "$OUT"; mkdir -p "$OUT"
R=$OUT/results.tsv
t() { local name=$1; shift; local s=$(date +%s.%N); "$@" > "$OUT/$(echo "$name" | tr '/: ' '___').log" 2>&1; local c=$?; local e=$(date +%s.%N); printf '%s\t%.2f\t%s\n' "$name" "$(echo "$e - $s" | bc)" "$c" >> "$R"; }
cd "$W" || exit 1
echo "commit $(git rev-parse HEAD)" > "$OUT/info"
V1=$W/public/v1

# (a) npm ci cold, in a scratch directory
rm -rf /tmp/npmci && mkdir -p /tmp/npmci && cp "$V1/package.json" "$V1/package-lock.json" /tmp/npmci/
npm cache clean --force >/dev/null 2>&1
t "a npm ci cold (empty npm cache)" bash -c "cd /tmp/npmci && npm ci --no-audit --no-fund"
rm -rf /tmp/npmci
# (b) dependency step on a cache hit: hash package.json + lock + node version, find the cached tree, link it
t "b deps cache hit (hash + link)" bash -c "cd $V1 && h=\$( (cat package.json package-lock.json; node --version) | sha256sum | cut -c1-16); ls -d $HOME/dev-push/cache/modules/* >/dev/null; ln -sfn $HOME/dev-push/cache/modules/\$(ls $HOME/dev-push/cache/modules | head -1)/node_modules /tmp/nm-link-test; rm /tmp/nm-link-test"

cd "$V1"
# (c) full type check and full build, cold
t "c tsc --noEmit full (npm run check)" node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
t "c tsc build full (emit dist)" node node_modules/typescript/bin/tsc -p tsconfig.json --outDir /tmp/measure-dist
# (d) incremental: build info kept between runs
rm -f /tmp/m.tsbuildinfo
t "d tsc incremental first run (noEmit)" node node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile /tmp/m.tsbuildinfo -p tsconfig.json
t "d tsc incremental no change" node node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile /tmp/m.tsbuildinfo -p tsconfig.json
f=forms/runtime.ts; [ -f "$f" ] || f=$(git ls-files '*.ts' | grep -v tests | head -1)
cp "$f" /tmp/m-orig.ts; echo "export const __measure_${RANDOM} = 1;" >> "$f"
t "d tsc incremental one-file change ($f)" node node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile /tmp/m.tsbuildinfo -p tsconfig.json
cp /tmp/m-orig.ts "$f"
t "d tsc incremental one-file revert" node node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile /tmp/m.tsbuildinfo -p tsconfig.json
rm -rf /tmp/m.tsbuildinfo /tmp/measure-dist
# Per-file transpile of one file (the old tooling's method)
t "c transpileModule one file" node -e "const ts=require('./node_modules/typescript');const s=require('fs').readFileSync('$f','utf8');ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}})"
# Syntax checks
t "s node --check one browser file" node --check ../libraries/apps/crm/app.js
t "s php -l (n/a on droplet)" bash -c "command -v php && php -l ../portal/index.php"

# (e) every suite AGENTS.md names, one at a time
export FIRSTMEASURE_INTERNAL_API_SECRET=ci-test-internal-service-secret CI=1
run_ts() { t "e $1" timeout 600 node --experimental-sqlite --import tsx --test --test-force-exit "$1"; }
for f in route-access document-as-sent-editing app-experience app-experience-registry access-gates contacts-store contact-merge lead-receive new-leads project-entry publication-measurement-schemas crm-views crm-rescission labor-completion labor-pay-sheets pay-rules pay-sources labor-commitments assignee-base assignee-roster assignee-base-store branches organization-structure work-requirements project-history documents-versions document-signing schedule-events scheduling-event-writes automation-contracts agent-how-to-index setup-steps guided-experiences guided-experiences-dev pricebook-roofing-setup guided-tab-tours realtime-single-stream session-replay session-replay-archive session-replay-agent-access forms-api; do
  [ -f "tests/$f.test.ts" ] && run_ts "tests/$f.test.ts"
done
for f in view-presence-client; do [ -f "tests/$f.test.mjs" ] && run_ts "tests/$f.test.mjs"; done
t "e npm run test:payments" timeout 900 npm run --silent test:payments
t "e npm run test:publication" timeout 900 npm run --silent test:publication
t "e localization-catalogs --check" node scripts/localization-catalogs.mjs --check
cd "$W"
t "e root tests/live-layer.test.mjs" timeout 300 node --test tests/live-layer.test.mjs
t "e root tests/frontend-bridge.test.mjs" timeout 300 node --test tests/frontend-bridge.test.mjs
echo done >> "$OUT/info"
