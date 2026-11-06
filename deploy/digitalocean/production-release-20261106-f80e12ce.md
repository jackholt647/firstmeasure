# Production release f80e12ce: ask before following a roof change that came with the saved project (FM-347), November 6, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan commit was already a child of
production-live `153664df` (release `33c12c01` plus the FM-346 record), so it was released as is:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-347 Project handoff issues (walls removed after QA send-back) | `f80e12ce` (`claude/fm-347-fix-prod`) | `f80e12ce` | `measure-internal-20261106063022-f0cd251d` (lane `e3568b3a`, changed lines identical) |

## Change

- Editor (compatibility) `public/measure/internal/editor_scripts/wall_mode.js` and `wall_roof_rebuild.js`: wall mode
  records whether the stored walls matched the roof drawing when the project opened (`staleAtOpen`). If a roof change
  came in with the saved project and following it (smart rebuild) would remove walls, edited walls, windows, doors,
  stickers or faces, the editor asks first ("This project was saved with a roof drawing that does not match its
  walls…"); Cancel keeps the walls exactly as saved. Roof edits made in the same session are followed without asking,
  as before. Before, a roof drawing saved 3.60 m low on order `exteriors_db0184…` (3905 NE 6th St, Renton) made the
  editor silently remove 9 walls, 10 edited walls, 6 doors and 1 window when the drafter reopened it.
- Test (not served): `dev/wall-roof-rebuild.test.cjs` (14/14 on the release commit).
- Roles: compatibility serves the files; worker and web carry them unchanged. No Node, PHP, database, environment,
  configuration, flag, dependency, nginx/PHP-FPM or data change. The editor's `?v=` is content-based
  (`fm_editor_asset_version`), so no manual bump.

## Checks before release

- Build on the dev worker (`npm run check` included). Archive sha256
  `2749fc6b00417b8f62500f47a0b0b63f05764dc42629266f0c777e6d3973f719`, verified on fm-agents, compatibility, the worker
  and each web node. The archive's `wall_mode.js` and `wall_roof_rebuild.js` are byte-identical to the commit; every
  assert in `web_activate.py` (FM-335 to FM-346, cad6a00b, plus the new FM-347 one: `staleAtOpen` 7 times and the
  prompt once in `wall_mode.js`) passes on the extracted archive.
- Control: the plan's check (`verify-served.sh`: the order's stored walls opened in wall mode in headless Chromium
  with the host's served editor scripts) against production's `33c12c01` files: no prompt, and the rebuild removed 9
  walls (as in John Paul's screenshot).

## Rollout (scripts: fm-agents /srv/agents/work/fm-347-prodrun-scripts)

- Rollback target before activation: `33c12c0195a89ff4cee63e6714d084c5beae8aec`, every host's `current` at 06:36 UTC;
  recorded on FM-347.
- Worker at 06:44:18 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `464997a4…` (33c12c01's archive).
- Six web nodes one at a time behind the load balancer, 06:45:20–06:58:11 UTC (about 2.1 min each), each asset-checked
  plus every FM assert.
- Compatibility last (it serves the editor files), at 06:58:25 UTC at a calm minute (`legacy-action` 157/min, load
  1.21). No Node 500s and no worker exits in the first 20 s.

## After activation

- All eight hosts point `current` at `f80e12ce`. Public readiness answered `f80e12ce`, `ok`, on 10 of 10 (four
  instances).
- Served file: `https://app.1m8.ai/measure/internal/editor_scripts/wall_mode.js` contains `staleAtOpen` 7 times.
- The plan's check against production's served files: the prompt appears with the order's numbers (14 of 20 roof
  points 3.60 m lower; would remove 9 walls, 10 edited walls, 6 doors, 1 window, 76 drawn faces), Cancel gives
  `"rebuild":null`, and the house renders intact as QA approved it.
- Compatibility, 06:58:30–07:16 (18 min): cluster watchdog **0 kills**, 0 Node 500s, 0 pool timeouts; load 1.2–1.5;
  `legacy-action` about 140–160/min (0 kills in the 3 h before). `/measure/internal/editor.php`: 2,106 requests, 0 5xx.
- 5xx from 06:59:30 (after the compatibility restart) to 07:16 against the 30 minutes before: web nodes 0–0.05 %
  (about 4,100–4,300 requests each) against 0.06–0.28 %; compatibility 0.15 % (4 of 2,734) against 0.05 %. Every one
  after is `top_view_reroll_proxy.php` (failing before this release).
- Worker, 06:44:18–07:16: 33 jobs completed (1 `imagery.process`, 6 `pdf.sync`, 26 `report.release`), 0 failed. 86
  `report.release` queued, none due (scheduled holds, as before).

## After the release

No data repair: order 3905 NE 6th St still has its roof drawing 3.60 m below its walls. That is a drafting fix (raise
the roof back, or rebuild the walls), which the tech was already reworking. Opening it now asks before removing walls.

## Rollback

`33c12c0195a89ff4cee63e6714d084c5beae8aec` is still installed on every host: activate it on compatibility first, then
the web nodes one at a time and the worker with `activate-release.sh` (`fm-347-prodrun-scripts/rollback/`), and
republish the channel with 33c12c01's archive against `2749fc6b…`. Code only; this release writes no data.
