# Production release 790a19c8: saving submission notes no longer wipes the roof and walls (FM-357), November 10, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. This is FM-357's second production plan (the
walls fix). The first one, release `85f64c33` (full-house regeneration approval), went out earlier the same day. The
plan commit `27e38407` was built on production-live `ff80597e`. Production-live had since moved to `62d49576` (FM-361,
release `49d46af9`), so, as the plan said, it was cherry-picked onto `62d49576`. The pick applied cleanly with an
identical diff:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-357 QA-notes refresh wiped the loaded model | `27e38407` on `claude/fm-357-walls-prod` (lane commit `bfd7ee27`) | `790a19c8` on `claude/fm-357-walls-prod2` | `measure-internal-20261110045907-969607b1` |

## Change

3 files, +80/−7, editor only.

- `public/measure/internal/editor_scripts/notes_overlay.js`: the QA-notes feedback refresh (after every load, on
  every focus or tab switch) merges only `qa_thread_drafts` into `window.currentProjectLoadedAppMetadata`, and only
  for the open project (`adoptFeedbackDrafts`). Before, it replaced the whole loaded model with the drafts. sha256
  `c7499b95…` → `354222a203ee17b162bd7340afc676f4d13e084ae24a148ec1503336eb70bd44`.
- `public/measure/internal/editor_scripts/report.js`: `persistSubmissionSourceMetadata` (Submit and the post-QA
  Regenerate) starts from the stored `app_metadata.json` when the loaded copy has no `geometry`, and saves nothing if
  that read fails (`getSubmissionSourceMetadataBase`). sha256 `c7f1007d…` →
  `cb322cb3a1f1698c840bdaabf3c929feb334fe6ff4cc42392e45dfd4c7afe5eb`.
- Not served: `dev/editor-metadata-feedback-drafts.test.cjs` (new regression test, 3/3 at `790a19c8`).
- Both served files are byte-identical to what dev.1m8.ai serves (lane `969607b1`). No Node, PHP, environment,
  database, migration, flag, nginx, dependency or config-library change. This release repairs no data. The 26 wiped
  `app_metadata.json` files were restored separately (05:52–05:53 UTC, approved by Jack, recorded on FM-357).

## Checks before release

- At 05:58 UTC every host's `current` was `49d46af9`, and readiness reported `49d46af9` 10/10. app.1m8.ai served
  `notes_overlay.js` with no `adoptFeedbackDrafts` and `report.js` with no `getSubmissionSourceMetadataBase`.
- The plan's no-login browser check (`fm-357-prodrun-scripts/walls/e2e-focus-refresh.cjs`; stubbed fetches, no
  writes) against app.1m8.ai before the release: `loaded after focus refresh: qa_thread_drafts`. It posted
  `{"qa_thread_drafts":{"qa":null},"submission_sources":{}}`, the stub stored on the 26 orders.
- Build on the dev worker (`npm run check` included) took 297 s. Archive sha256
  `125691131e4943ea11fd6740da17b21e4c493233efdfdffcf3c07707971edda3`, verified on fm-agents, compatibility, the
  worker and each web node. Against `49d46af9`'s archive it differs only in `notes_overlay.js`, `report.js`,
  `release.env` and the FM-361 record.
- `web_activate.py` keeps every earlier assert (FM-324, FM-335 to FM-361, cad6a00b) and adds FM-357: the two files'
  sha256, `adoptFeedbackDrafts` twice, `async function getSubmissionSourceMetadataBase` once. All 31 file asserts
  passed on the extracted archive and on compatibility's and the worker's installed trees before any activation.
- Baseline: in the 30 min before 05:59, web 5xx was 0.18–0.27 % (this window includes FM-361's 05:31 compatibility
  switch transient on `/v1/internal/*`) and compatibility 0.45 %. Compatibility had 2 watchdog kills and 0 pool
  timeouts in the 3 h before. Worker: no failed `pdf.sync` in 72 h, and 15 failed `report.delivery` (13 of them at
  11/07 13:00).

## Rollout (scripts: fm-agents /srv/agents/work/fm-357-walls-prodrun-scripts)

- The rollback target `49d46af9959d3f15a5b5e8a8270044fec9520c37` was recorded on FM-357 before activation.
- The signed channel was published from compatibility at 06:06 UTC against `e55f8234…` (49d46af9's archive).
- Worker at 06:06:58 UTC (no job running): 8 slots, production, heartbeat off, outbound email on.
- Six web nodes went one at a time behind the load balancer, 06:07:30–06:20:47 UTC. On the first node
  (64.23.240.81) the release activated and the node passed every earlier assert. A new served-file check I had added
  then stopped the script. That check was wrong for web: web nginx proxies `/measure/internal/` to compatibility, so
  a web node serves the editor from compatibility's release. I removed the check, and the node passed all 31 file
  asserts on its installed tree. It returned behind the load balancer on `790a19c8` at 06:09:52. The other five nodes
  passed every assert. The served-file check ran after compatibility instead (below).
- Compatibility went last, at 06:21:01 UTC, through the gate, which opened at once (236 `legacy-action`/min, load
  0.8). In the 20 s after, there were 0 Node 500s and 0 HTTP worker exits.

## After activation

- All eight hosts point `current` at `790a19c8`. Public readiness answered `790a19c8`, `ok`, 10 of 10 after the
  web rollout, after compatibility, and again at 06:38.
- app.1m8.ai serves `notes_overlay.js` (`354222a2…`) and `report.js` (`cb322cb3…`) byte-identical to the release
  and to dev.1m8.ai, with `adoptFeedbackDrafts` twice and `getSubmissionSourceMetadataBase` once.
- The plan's browser check after the release: `loaded after focus refresh: exteriorsWalls,geometry,qa_thread_drafts`.
  The post holds `geometry` and `exteriorsWalls`.
- From 06:21:35 to 06:38: web 5xx 0.00–0.08 % on all six nodes and compatibility 0.43 % (before: 0.12–0.22 % and
  0.52 %). Nearly every 5xx was the existing `top_view_reroll_proxy.php`. The other two were one
  `/v1/platform/acquisition/event` and one `/v1/platform/acquisition/public/track`.
- Compatibility from 06:21:01 to 06:38: 0 cluster watchdog kills, 0 Node 500s and 0 pool timeouts, at 226–305
  `legacy-action`/min.
- Worker from 06:06:57 to 06:38: 69 jobs completed (30 `pdf.sync`, 3 `imagery.process`, 8 `report.delivery`, 28
  `report.release`), with none failed and none retried. 169 `report.release` jobs were queued, none due (scheduled
  holds).

## Not covered

- There is no production editor login here, so no real editor session was exercised on app.1m8.ai. The served code
  was checked with the stubbed browser sequence above. A person confirms on production before Done. 9241 Fairway Dr
  (restored model) still needs a qualified person to regenerate its PDF and re-send it (see FM-357).

## Rollback

`49d46af9959d3f15a5b5e8a8270044fec9520c37` is still installed on every host. To roll back, activate it on
compatibility, then the web nodes one at a time, then the worker (`fm-357-walls-prodrun-scripts/rollback/`:
`release.sh compat|worker|publish`, `web_rollout.sh`). Then republish the channel with 49d46af9's archive
(`/var/tmp/firstmeasure-release-49d46af9` on compatibility) against `12569113…`. This is code only. A rollback brings
back the old refresh, so the wipe could happen again.
