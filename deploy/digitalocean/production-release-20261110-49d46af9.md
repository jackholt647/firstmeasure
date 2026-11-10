# Production release 49d46af9: the Opening Schedule gives windows and doors to the nearest whole inch (FM-361), November 10, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. Jack asked for this change in his Claude Code
session (2026-11-10, ~04:30 UTC). The plan commit was already a child of production-live `ff80597e` (release
`8eed0a59`, FM-359), so it was released as is:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-361 Opening Schedule whole inches | `49d46af9` on `claude/fm-361-opening-schedule-windows-and-doors-to-th-prod` (67a8372f cherry-picked onto `ff80597e`, identical diff) | `49d46af9` | `measure-internal-20261110045654-c48d7fdd` (lane commit `c48d7fdd`) |

## Change

3 files, +4/−5, editor only.

- `public/measure/internal/editor_scripts/exterior_pdf.js`: the Opening Schedule's `inchText` rounds windows and
  entry/patio doors to the nearest whole inch (`Math.round(feet*12)+'"'`, e.g. `36" x 48"`) instead of the nearest
  1/4"; `FRACTIONS` removed. Garage doors (ft+in), other openings (decimal ft) and metric (mm/m) are unchanged.
  sha256 `6282360d…04a1b0` → `5c062e6afd4883f2561e157710f2f121b8f332a54cbd62b423670c8b0fc8a5f5`, the same bytes dev
  serves.
- Not served: `dev/exterior-pdf-layout.test.cjs` (openingSize expectations) and `dev/EXTERIOR_REPORT.md` (wording).
- The worker's PDF runtime loads this file, so new or regenerated exterior PDFs get whole inches; saved PDFs change
  only when regenerated. No Node, PHP, environment, database, migration, flag, nginx, dependency or config-library
  change; no data repair.

## Checks before release

- Every host's `current` was `8eed0a59` at 05:01 UTC, and each host's and app.1m8.ai's `exterior_pdf.js` was
  `6282360d…` (git `8eed0a59`). Readiness 10/10 on `8eed0a59`.
- `dev/exterior-pdf-layout.test.cjs` at `49d46af9`: 32/32 with the commit's file; 31/32 with the file production
  served before the release (the new whole-inch expectation fails), so the test tells the two apart.
- Build on the dev worker (`npm run check` included), 271 s. Archive sha256
  `e55f823428662cda4e283fdf5304f6c2fa49b101dcb008e6814380b1becd2cfd`, verified on fm-agents, compatibility, the
  worker and each web node. Against `8eed0a59`'s archive it differs only in `exterior_pdf.js`, `release.env` and
  the FM-359 record.
- `web_activate.py` keeps every earlier assert (FM-324, FM-335 to FM-359, cad6a00b) and adds FM-361: `exterior_pdf.js`
  sha256 `5c062e6a…`, `Math.round(feet*12)+'"'` once, `FRACTIONS` absent. All 29 file asserts passed on the extracted
  archive and on compatibility's and the worker's installed trees before any activation (`check_asserts.py`).
- Baseline: web 5xx 0.04–0.08 % and compatibility 0.65 % in the 30 min before 05:03; compatibility 2 cluster
  watchdog kills and 0 pool timeouts in the 3 h before. Worker: no failed `pdf.sync` in the 72 h before, 15 failed
  `report.delivery` ("The customer report email failed to send", 13 of them 11/07 13:00).

## Rollout (scripts: fm-agents /srv/agents/work/fm-361-prodrun-scripts)

- Rollback target before activation: `8eed0a596df9ec55e80f4b5e3eb103c70b8833e8`, recorded on FM-361.
- Signed channel published from compatibility at 05:17 UTC against `cabd4059…` (8eed0a59's archive).
- Worker at 05:17:56 UTC (no job running): 8 slots, production, heartbeat off, outbound email on.
- Six web nodes one at a time behind the load balancer, 05:18:26–05:31:07 UTC; every node passed every assert,
  including FM-361's.
- Compatibility last at 05:31:41 UTC through the gate, which opened at once (193 `legacy-action`/min, load 2.1).
  0 Node 500s and 0 HTTP worker exits in the 20 s after.

## After activation

- All eight hosts point `current` at `49d46af9`, and each one's `exterior_pdf.js` is `5c062e6a…`. Public readiness
  answered `49d46af9`, `ok`, on 10 of 10 after the web rollout and again after compatibility.
- app.1m8.ai serves `exterior_pdf.js` as `5c062e6a…` (it was `6282360d…` just before compatibility switched); the
  served file has no `FRACTIONS`, and `dev/exterior-pdf-layout.test.cjs` passes 32/32 with it swapped in.
- Web nodes answered 500 to PHP→Node `/v1/internal/*` calls for 13 s (05:31:41–05:31:54, 16–19 per node) while
  compatibility switched, the same transient as FM-359's (04:07, 20–21 per node) and FM-357's (01:37) compatibility
  activations; none since.
- 05:32:41–05:50 (after compatibility settled): web 5xx 0.00–0.08 % on all six nodes, against 0.15–0.24 % in the 30
  min before (which include the switch) and 0.04–0.08 % before the release; compatibility 0.49 % against 0.40–0.65 %.
  Every 5xx was the existing `top_view_reroll_proxy.php`.
- Compatibility from 05:31:41 to 05:50: cluster watchdog 0 kills, 0 Node 500s, 0 pool timeouts at 157–220
  `legacy-action`/min (baseline about one kill an hour).
- Worker, 05:17:55–05:50: 85 jobs completed (30 `pdf.sync`, 10 `imagery.process`, 8 `report.delivery`, 37
  `report.release`) on the new PDF runtime, none failed and none retried. 192 `report.release` queued, none due
  (scheduled holds).

## Not covered

- No production login here, so no exterior PDF was regenerated on app.1m8.ai to look at an Opening Schedule; the
  worker renders with the asserted file, and dev was checked with the same bytes. A person confirms on production
  before Done.

## Rollback

`8eed0a596df9ec55e80f4b5e3eb103c70b8833e8` is still installed on every host: activate it on compatibility, the web
nodes one at a time and the worker (`fm-361-prodrun-scripts/rollback/`: `release.sh compat|worker|publish`,
`web_rollout.sh`), and republish the channel with 8eed0a59's archive against `e55f8234…`. Code only: no data,
schema or setting changed.
