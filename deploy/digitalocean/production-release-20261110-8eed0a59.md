# Production release 8eed0a59: production's measure editor becomes dev's (lane 90c7d9e3): Resources perspective and ratio, opening inches, eave length, curved-face editing and more (FM-359), November 10, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. Jack asked for this feature release in his
Claude Code session (2026-11-10, ~01:10 and ~01:40 UTC). The plan commit was already a child of production-live
`173af0e7` (release `85f64c33`, FM-357), so it was released as is, with no cherry-pick:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-359 dev editor to production | `8eed0a59` on `claude/fm-359-release-to-prod-dev-editor-resources-per-prod` (the 10 commits of `release/prod-resources-perspective-20261110` rebased onto `173af0e7`) | `8eed0a59` | measure-internal lane `90c7d9e3` |

## Change

30 files, +1199/−87, editor only. In these files the release is byte-identical to `lane/measure-internal` `90c7d9e3`,
so production's `public/measure/internal` now equals dev's.

- `editor_scripts/`: `resource_perspective.js` (new: Resources Perspective tray, live corrected view, crop, Save as
  new file / Download), `project_resources.js`/`.css` (Ratio tool and button, temporary marks on order photos),
  `exterior_geometry.js`, `exterior_model.js`, `exterior_finishes.js`, `exterior_report_model.js`, `exterior_pdf.js`
  (openings in inches / ft+in, curved-face stickers laid out along the surface and cut in (u,v), listed in the
  report), `wall_face_draft.js`, `wall_editor.js`, `wall_solid_geometry.js`, `wall_mode.js`, `roof_trim_editor.js`
  (eave/rake click selects and shows length without opening Trim, Textured outline, floating-line extrude,
  Shift-click across draft and base lines, V for a face from four edges, chord edges; walls fall back to the last
  Save when the local backup cannot be shown), `report.js` (QA PDF preview Open and Download).
- `portal_scripts/`: `projects.js`, `customers.js` (Impersonate customer for admins), `portal_status_bar.js` (`--`
  with no average), `flag_console.js` (who an introduction is for; falls back to the old wording, since production's
  server has no `introduction_audience`).
- PHP: `editor.php` (one `<script>` tag for `resource_perspective.js`, content-based `?v=`) and `_resource_frames.php`
  (Save Frame decodes a quarter second, FM-343 part 2).
- Not served: `dev/` docs, tests and one fixture.
- The worker's PDF runtime loads `exterior_geometry.js` and `exterior_pdf.js` from the editor, so exterior PDFs get
  the inch / ft+in openings too. No Node, environment, database, migration, flag, nginx, dependency or config-library
  change; no data repair.

## Checks before release

- Every host's `current` was `85f64c33` at 02:31 UTC. compatibility's served `public/measure/internal` equalled git
  `85f64c33` for every file (plan check), so production had no hand edits to lose.
- Before release, dev.1m8.ai served all 18 changed JS/CSS files byte-identical to `8eed0a59` (lane `90c7d9e3`), and
  app.1m8.ai served none of them (`resource_perspective.js` answered 302).
- Regression on the candidate with `85f64c33` as control (plan): 0 new failures over the 94 mapped suites; the
  failing ones fail identically on `85f64c33`, and portal-status-bar passes only on the candidate.
- Build on the dev worker (`npm run check` included), 277 s. Archive sha256
  `cabd40591c33e7c9a27e8513df70168cd3b136baebf3f3d25ccdae5a5b604004`, verified on fm-agents, compatibility, the
  worker and each web node.
- `web_activate.py`, beside the FM-324, FM-335 to FM-357 and cad6a00b asserts: FM-359 sha256 of
  `resource_perspective.js` `ab72809a…`, `project_resources.js` `4bec346e…`, `wall_face_draft.js` `c104c256…`,
  `exterior_geometry.js` `90d8f4a2…`, `wall_mode.js` `0a4592e6…`, and one perspective script tag in `editor.php`.
  FM-355's `exterior_report_model.js` hash moved to the new file (`12c2efef…`; its two FM-355 strings still present).
  `exterior_pdf.js` was dropped from the served-asset comparison: web proxies `/measure/internal/` to compatibility,
  which activates last. All 28 file asserts passed on the extracted archive and on compatibility's and the worker's
  installed trees before any activation (`check_asserts.py`).
- Baseline: web 5xx 0.03–0.13 % in the 30 min windows before; compatibility 0.58–0.70 %, 2 cluster watchdog kills and
  8 pool timeouts in the 3 h before 03:07. Worker: 17 failed `pdf.sync`/`report.delivery` jobs in the 72 h before,
  none since 11/09 13:00.

## Rollout (scripts: fm-agents /srv/agents/work/fm-359-prodrun-scripts)

- Rollback target before activation: `85f64c33f999293a6a47bb9227d93c728d36d1f2`, recorded on FM-359.
- Signed channel published from compatibility at 02:39 UTC against `857d4daa…` (85f64c33's archive).
- Worker at 02:39:57 UTC (no job running): 8 slots, production, heartbeat off, outbound email on.
- Six web nodes one at a time behind the load balancer, 02:40:20–02:53:57 UTC; every node passed every assert,
  including FM-359's.
- Compatibility last at 04:07:04 UTC through the gate (`legacy-action` < 420/min and load < 10), which waited 73 min
  at 460–1,000/min (load 0.5–2.2) and opened at 396/min, load 1.0. 0 Node 500s and 0 HTTP worker exits in the 20 s
  after.

## After activation

- All eight hosts point `current` at `8eed0a59`. Public readiness answered `8eed0a59`, `ok`, on 10 of 10 after the web
  rollout and again after compatibility.
- app.1m8.ai serves all 18 changed JS/CSS files byte-identical to the release (and so to dev); the five asserted
  files answer 200 with the hashes above. compatibility's `editor.php` holds the perspective script tag once; it and
  `_resource_frames.php` pass `php -l`. editor.php status mix after activation equals the hour before (about 22 %
  404, as before).
- 04:08:30 onward (after compatibility settled): web 5xx 0.02–0.05 % on three sampled nodes against 0.11–0.13 % in
  the 30 min before; compatibility 0.52 % against 0.58 %. Every 5xx was the existing `top_view_reroll_proxy.php`.
- Compatibility from 04:07:04 to 04:45: cluster watchdog **1 kill** (04:26:44, slot 2, one worker restarted; no editor
  5xx around it), 0 Node 500s, 0 pool timeouts at 310–577 `legacy-action`/min. That is the baseline: 8 kills from
  11/09 14:00 to 11/10 04:07, about one an hour, all on `85f64c33` and earlier. It did not chain (watched 18 min more).
- Worker, 02:39:56–04:20: 561 jobs completed (67 `imagery.process`, 274 `pdf.sync`, 68 `report.delivery`, 152
  `report.release`) on the new PDF runtime, none failed and none retried; by 04:45, 791 completed and still none failed. 265 `report.release` queued, none due
  (scheduled holds).

## Not covered

- No production login here, so the editor's new tools (Perspective tray, Ratio, eave length, curved-face stickers)
  were not opened on app.1m8.ai; they were checked on dev by Jack and the plan, and production now serves the same
  bytes. A person confirms on production before Done.

## Rollback

`85f64c33f999293a6a47bb9227d93c728d36d1f2` is still installed on every host: activate it on compatibility, the web
nodes one at a time and the worker (`fm-359-prodrun-scripts/rollback/`: `release.sh compat|worker|publish`,
`web_rollout.sh`), and republish the channel with 85f64c33's archive against `cabd4059…`. Code only: no data,
schema or setting changed.
