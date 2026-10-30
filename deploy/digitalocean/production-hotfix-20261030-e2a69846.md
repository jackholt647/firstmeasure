# Production hotfix e2a69846: a roof edit can no longer leave wall mode black and the project unloadable (FM-312), October 30, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-312 set to Testing in prod, verified on dev). Run from fm-agents-1.

It is production-live `233c82fb` (code `a8b97899`, FM-310) plus one commit, `e2a69846` (branch `claude/fm-312-training-instance-issue-prod`): 4 files, +45/−3. The 3 changed editor scripts are byte-identical to dev's `measure-internal-20261030072017-26d92442` (lane commit `26d92442`). `dev/wall-roof-rebuild.test.cjs` stays on the lane only; production-live has neither that suite nor its fixture.

## Cause

Reported from a training org on production (Tutorial Mode, 4725 W Mercer Way): after a roof edit, switching back to wall mode left the wall pane black, and every reload alerted "Load Error: The face does not define a valid planar region."

After a roof edit, wall mode follows the roof (smart rebuild). Some edits produce a merged wall whose outline has a junction vertex 5e-8 m beside its corner, a twist below the 1 µm polygon grid. `WallGeometry.topology` threw on it, and `topology` runs in wall mode's render, in Save and in `WallMode.restore()` on project load, so the render stopped and the whole project load aborted although the roof was fine. A half-applied smart rebuild could also be kept when someone pressed Cancel on "Rebuild the walls now?".

## Fix

Measure editor only (`public/measure/internal/editor_scripts`, plus a test under `dev/`):
- `wall_geometry.js`: `topology` welds vertices closer than 10 µm and retries when a merged region can't be triangulated, then falls back to the union's own outline, then draws the outline unfilled. It never throws. Valid regions are unchanged.
- `wall_mode.js`: smart rebuild is all or nothing. If the followed walls can't be committed or drawn, the earlier walls, the undo history and the local backup are restored.
- `main.js`: a wall restore failure no longer aborts the project load. The roof and the rest of the project open, and an alert names the wall problem.
- `dev/wall-geometry.test.cjs`: the two walls from the reproduction.

## Checks

- **Dev:** live in `measure-internal-20261030072017-26d92442`, regression gate passed; dev's served scripts mesh the reproduction walls in Chromium.
- **Release commit:** `node --check` on the 3 scripts (rechecked by this run); `dev/wall-geometry.test.cjs` 32/32 (from the production plan).
- **Build:** on the dev worker (npm ci, check, build), archive sha256 `0b138323…`, verified. Its 3 editor scripts match the commit, and its sha256 was rechecked on compatibility and the worker after copying.
- **Before activation:** loading `clipper`, `earcut`, `exterior_geometry.js` and `wall_geometry.js` from app.1m8.ai in Chromium and running `WallGeometry.topology` on the FM-312 walls threw "The face does not define a valid planar region."

## Not changed

No Node code, migration, configuration, environment or data change. Saved walls are not touched. The fixed code just opens them, so Rashid's project needs no repair.

## Rollout

- Compatibility at 07:31:48Z, from `a8b97899`.
- Worker at 07:32:36Z, after no running jobs: 8 slots, production, email on, heartbeat off.
- Signed channel published against `d3941ae1…` (new archive `0b138323…`), so new pool nodes get this release.
- Six web nodes from 07:33 to 07:43 UTC, one at a time. Each was drained from the load balancer and ready in about 94 s, with matching assets (`portal/scripts/core.js`, `wall_geometry.js`, `wall_mode.js`, `main.js`).

Public readiness returned `e2a69846` 20 out of 20 times. The 3 changed editor scripts served from `https://app.1m8.ai/measure/internal/editor_scripts/` are byte-identical to the commit. The same Chromium check against app.1m8.ai now returns 2 filled faces (areas 5.709 and 0.658 m²).

After activation:
- **Compatibility:** 3 errors from 07:31:52 to 07:32:00, all inside the restart. Two `editor.php` requests (a tutorial session) found no PHP-FPM socket while it restarted, and one `backend_login.php` 502 came from a staff lookup while Node was starting. After that, nginx 5xx is 5 of 1,003 (0.50%), all the existing `top_view_reroll_proxy.php` 500, against 0.59% in the half hour before. No Node 500s.
- **Web nodes:** 0 to 1 5xx per 34–1,828 requests (0–0.12%, only `top_view_reroll_proxy.php`), each below the same node's 0.17–0.41% before; no HTTP worker exits.
- **Worker:** 21 jobs completed and 0 failed in the first 11 minutes after activation.

**Not checked:** the signed-in editor on production. This run has no production staff session and touched no production data, so nobody has reopened the reported project yet. Ask Rashid to reopen 4725 W Mercer Way and switch to wall mode.

## Disk

Before this release, compatibility was at 88% (15 GB free) and the web nodes at 86–89% (12–14 GB free). Each release adds about 1.2 GB. Nothing was deleted; old `/opt/firstmeasure/releases` directories and `/var/tmp/firstmeasure-release-*` archives still need a cleanup.

## Rollback

Every role keeps `a8b97899`. Republish it (`d3941ae1…`) to the channel before rolling back a web node. Code only: nothing this release writes needs the new code to read.
