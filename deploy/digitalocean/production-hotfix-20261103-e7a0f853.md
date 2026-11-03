# Production hotfix e7a0f853: walls resumed over an empty roof drawing bring back their roof (FM-322), November 3, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-322 set to Testing in prod, in Done in Dev). Run from fm-agents-1.

It is production-live `36d5e625` (code `cb4034d8`, the guide preview hotfix) plus one commit, the FM-322 fix `e735d6bf` cherry-picked unchanged: `e7a0f853` on `claude/fm-322-prod-r2`. 2 files, +48. The production plan in FM-322 was written against `ac09d330`; `cb4034d8` went live after it, so the same commit was applied on top of it and the rollback target is `cb4034d8`.

## Change

**Walls** (`editor_scripts/wall_mode.js`, +21): when the walls are restored and the roof drawing is empty, `recoverRoofFromWalls()` puts back the drawing the walls were built from, from their `roofSignature` (points, lines, types, manual faces), placed through the walls' image context if the imagery differs. A roof drawing that exists is never replaced. A trainee's Chapter 3 project had come back after page reloads with walls from the browser backup but no roof drawing, so Measurements and the report kept asking to run Measurements. Its test is in `dev/wall-mode.test.cjs` (+27).

## Not changed

No Node code, migration, configuration, environment or data change. The trainee's project is not repaired by hand: reopening it brings the roof back, then Save and submit.

## Checks before release

- **Dev:** `measure-internal-20261103044113-8e322f1f` (lane commit `8e322f1f`), router regression tests passed. The trainee's saved project replayed through dev's `wall_mode.js` restores 17 points and 20 lines, identical to the walls' `roofSignature` (from the production plan). The signed-in editor was not opened on dev: the dev test login isn't staff.
- **Release commit:** `node --test dev/wall-mode.test.cjs` 100/100 on `e7a0f853`.
- **Build:** on the dev worker (npm ci, check, build, prune) in 282 s, archive sha256 `94a2c8c5552138dd8d6471170c68e752ec58c8d1735a769cbf7f79a1adf7a01c`, verified there and rechecked on compatibility and the worker after copying. The archive's `wall_mode.js` matches the commit.

## Rollout

- Compatibility at 05:14:46–05:14:58 UTC, from `cb4034d8`: ready on `e7a0f853`, production data, full house on, heartbeat off as before, 8 workers, pool 4. 3 `POST backend_login.php` got 502 during the restart (05:14:52–55). No Node 500s or HTTP worker exits in the next 20 s.
- Worker at 05:15:28 UTC, after no running jobs: 8 slots, production, email on, heartbeat off.
- Signed channel published against `4e2b59ff…` (cb4034d8's archive), from the release's real path, with archive `94a2c8c5…`, so new pool nodes get this release.
- Six web nodes from 05:16:29 to 05:29:31 UTC, one at a time. Each was drained from the load balancer, ready in about 94 s with served assets matching the release, pool 4, 8 workers and full house on. The next node started only after public readiness answered from that node on the new release.

## After activation

Checked to about 05:31 UTC.

- **Release identity:** public readiness `e7a0f853` 40 of 40 (all six instances answering), then 10 of 10. All eight hosts point `current` at `e7a0f853`.
- **New code served:** `https://app.1m8.ai/measure/internal/editor_scripts/wall_mode.js` has the commit's sha256 (`2306dad7…`) on 10 of 10 requests, and contains `recoverRoofFromWalls` twice.
- **Web nodes:** 1 5xx in 11,869 requests after activation (one `top_view_reroll_proxy.php`), against 0.13–0.39% in each node's half hour before. No HTTP worker exits.
- **Compatibility, nginx:** 9 5xx in 3,004 requests since 05:14:58 (0.30%, against 0.36% in the half hour before): 8 of the existing `top_view_reroll_proxy.php` and 1 `GET /measure/internal/` 503 at 05:18:09, "staff record lookup failed: HTTP 0". That message appeared 10 times between 03:38 and 03:59 UTC, before this release, so it is not new; its cause was not investigated. No PHP-FPM errors.
- **Compatibility, Node:** no 500s and no HTTP worker exits since activation (also none in the 20 minutes before).
- **Worker:** no failed jobs and no error-level log lines. 27 jobs completed since activation (`pdf.sync`, `report.release`, `report.delivery`, `imagery.process`). 162 queued, all `report.release`, none due yet (scheduled; 160 were queued before activation).

**Not checked:** the real editor flow has not run on dev or production with this change (the dev login isn't staff). The confirmation is the trainee reopening Chapter 3 Practice 2 (2605 Camas Ave NE): the roof drawing comes back, then Save and submit. Until she saves, the restored roof lives only in her open editor.

## Known limits

- Canonical gets this fix through `lane/measure-internal` (`8e322f1f`); a release that takes the editor from an older lane commit would drop it.
- Side note from the plan, not changed here: her editor POSTs `editor.php?action=tutorial_project_unsupported` about 4 times a minute and each gets a 404.

## Rollback

Every role keeps `cb4034d8`. Republish its archive (`4e2b59ff…`) to the channel from `/opt/firstmeasure/releases/cb4034d8…/deploy/digitalocean/`, then `activate-release.sh cb4034d8… <service>` on each role. Code only: this release writes nothing.
