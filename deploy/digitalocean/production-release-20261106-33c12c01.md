# Production release 33c12c01: keep chimney side edits on exposure-clipped cells when the editor loads (FM-346), November 6, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan commit was already a child of
production-live `32ce3795` (release `440abec4` plus the FM-344 and FM-345 records), so it was released as is:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-346 Chimney side edits hidden on load | `33c12c01` (`claude/fm-346-investigate-reported-issue-prod`) | `33c12c01` | `measure-internal-20261106042443-20a29f83` (lane `e694817a`, diff identical) |

## Change

- Editor (compatibility) `public/measure/internal/editor_scripts/wall_chimneys.js`: `normalizeDrafts` also keeps a
  chimney-side draft's own `<chimney>:side-N:cell-K` members (sides clipped by the house's exposure). They were
  dropped on every load, so the person's edit no longer replaced the generated side: the generated side showed again
  (double walls, band line) and the report counted both. Other sides' members are still dropped.
- Test (not served): `dev/wall-chimneys.test.cjs`, "reload keeps a chimney side draft that owns exposure-clipped
  cells".
- Roles: compatibility serves the file; worker and web carry it unchanged. No Node, PHP, database, environment,
  configuration, flag, dependency, nginx/PHP-FPM or data change. The editor's `?v=` is content-based
  (`fm_editor_asset_version`), so no manual bump.

## Checks before release

- Build on the dev worker (`npm run check` included), 269 s. Archive sha256
  `464997a41274e3af13c235f2f9b9d37a6ff6ce42700d89643c29c02905ff8048`, verified on fm-agents, compatibility, the worker
  and each web node. The archive's `wall_chimneys.js` is byte-identical to the commit; every assert in
  `web_activate.py` (FM-335 to FM-345, cad6a00b, plus the new FM-346 one: `id.startsWith(prefix+':cell-')` once in
  `wall_chimneys.js`) passes.
- Control: the plan's render check (`verify-served.sh`: the stored model of order `exteriors_9b73…`, 3820 E 21st Ave,
  rendered in headless Chromium with the host's served editor scripts) against production's `440abec4` files gives an
  image byte-identical to the plan's `before-prod-440abec4.png` (double-walled chimney, as in the reporter's
  screenshot).

## Rollout (scripts: fm-agents /srv/agents/work/fm-346-prodrun-scripts)

- Rollback target before activation: `440abec4a5f7ba2d532c66ccb09fc6a00010d16b`, every host's `current` at 04:28 UTC;
  recorded on FM-346.
- Worker at 04:38:20 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `5e166ee4…` (440abec4's archive); all six web nodes downloaded
  `33c12c01` / `464997a4` from it.
- Six web nodes one at a time behind the load balancer, 04:39:38–04:54:01 UTC (about 2.2 min each), each asset-checked
  plus the FM-346 assert. On the fifth node (143.198.137.97) `web_activate.py`'s first local readiness probe timed out
  (15 s) before it changed anything; the node was still on `440abec4`, NGINX untouched, readiness 200 in 0.7 s. The
  rollout resumed for the last two nodes (`web_rollout_resume.sh`) and both activated normally.
- Compatibility last (it serves the editor files), at 04:54:20 UTC at a calm minute (`legacy-action` 226/min, load
  1.15). No Node 500s and no worker exits in the first 20 s.

## After activation

- All eight hosts point `current` at `33c12c01` with the expected service active. Public readiness answered
  `33c12c01`, `ok`, on 10 of 10 (four instances).
- Served file: `https://app.1m8.ai/measure/internal/editor_scripts/wall_chimneys.js` is byte-identical to the release
  commit; `startsWith(prefix+':cell-')` occurs once.
- The plan's render check against production's served files gives an image byte-identical to the plan's
  `dev-fixed.png`: the chimney is clean, in its own finish, with no siding showing through.
- Compatibility, 04:54:40–05:15 (20 min): cluster watchdog **0 kills**, 0 Node 500s, 0 pool timeouts; load 1.0–1.9;
  `legacy-action` about 230/min. `/measure/internal/editor.php`: 0 5xx.
- 5xx from 04:55 to 05:15 against the 30 minutes before: web nodes 0.01–0.07 % (about 6,800–7,300 requests each)
  against 0.19–0.24 %; compatibility 0.32 % against 0.35 %. Every one is `top_view_reroll_proxy.php` (failing before
  this release).
- Worker, 04:38:20–05:15: 111 jobs completed (7 `imagery.process`, 39 `pdf.sync`, 6 `report.delivery`, 59
  `report.release`). 160 `report.release` queued, none due (scheduled holds, as before). 2 failed: one `pdf.sync`
  (04:40) and one `report.delivery` (04:44), both "Shared PDF runtime failed: page.evaluate: Target page, context or
  browser has been closed". Not this release: the PDF runtime loads `pdf.js`, `exterior_geometry.js`,
  `exterior_pdf.js` and `pdf_standalone.js`, not `wall_chimneys.js`, and the same error failed 1–3 jobs an hour on
  `440abec4` before it (01, 02 and 03 UTC today; 15–16 and 22 UTC on November 5).

## After the release

No data repair: order 3820 E 21st Ave already holds the rework, and it now shows when opened. Its PDF and report saved
at 03:17 UTC were built from the hidden-edit view (93 walls, 2060.57 sq ft gross; with the fix the same file gives 90
walls, 1918.12 sq ft), so QA should reopen it (the QA editor regenerates the PDF on open) before it is delivered.

## Rollback

`440abec4a5f7ba2d532c66ccb09fc6a00010d16b` is still installed on every host: activate it on compatibility first, then
the web nodes one at a time and the worker with `activate-release.sh` (`fm-346-prodrun-scripts/rollback/`), and
republish the channel with 440abec4's archive against `464997a4…`. Code only; this release writes no data.
