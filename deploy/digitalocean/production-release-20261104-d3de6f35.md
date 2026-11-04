# Production release d3de6f35: exterior points rounded up to whole numbers (FM-326), November 4, 2026

Released from fm-agents-1 by the tracker's production run for FM-326 ("Exteriors point rounding", FirstMeasure bug fixes), under the workspace's standing authorization for issues set to "Testing in prod" once verified on dev.

It is production-live `7b3bd536` (release `c828835b`) plus one commit on `claude/fm-326-prod-release`:

- `d3de6f35`: cherry-pick of canonical `1bfd26ef`, unchanged, on dev as `platform-20261104050600-8476bdbb`. (The plan's branch `claude/fm-326-exteriors-point-rounding-prod` was cut from `843c58d1`, before FM-325 landed; the same commit was cherry-picked onto the newer production-live.)

## Change

- **Exterior (full-house) points are whole numbers, rounded up** (FM-326). `computeFullHousePoints` in `public/v1/firstmeasure/full_house_points.ts` rounds roof points + 1.1 × wall points to cents first (so float noise such as 21.000000000000004 stays 21), then up to the next whole point: 9.6 becomes 10. The unrounded value is kept as `point_calculation.raw_points` and still picks the project complexity, so complexity doesn't change. Roof jobs are unchanged.
- It applies when the API computes a full-house project's points at submission. Projects already stored keep their stored `point_value`.
- Test: `tests/firstmeasure-full-house-points.test.ts`.
- No PHP, editor, browser, database, migration or config-library change (production-live's snapshot is unchanged). No production data changed.

## Checks before release

- `tests/firstmeasure-full-house-points.test.ts` 8/8 on the release commit.
- Diff against production-live checked: the plan's 2 files only.
- Build on the dev worker in 284 s (npm ci, type check, build, prune): archive sha256 `01bf3e13aed4e370680914dace2e1be47d865efacfc3939a9d4cfddd95f83d0b`, verified there, on compatibility and on the worker; its `dist/firstmeasure/full_house_points.js` contains `Math.ceil(rawPoints)`.

## Rollout

- Rollback target recorded on FM-326 before activation: `c828835b62215a51bf7a3ce126ebcda8ecfaa2c5` (all eight hosts' `current`, and public readiness 10 of 10, ~16:25 UTC).
- Compatibility at 16:27:43 UTC from `c828835b`: active on `d3de6f35`, no 500s and no worker exits in the first 20 s.
- Worker at 16:28:21 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published against `d09a221b…` (c828835b's archive); all six web nodes downloaded `d3de6f35` / `01bf3e13` from it.
- Six web nodes one at a time behind the load balancer, 16:29:22–16:43:27 UTC, each withdrawn, activated (~95 s), asset-checked (`core.js`, color picker, `roof-viewer.js` served = `current`; built `full_house_points.js` has the fix) and back behind the load balancer on the new release before the next.

## After activation

- Public readiness answered `d3de6f35` (`ok`) on 12 of 12 requests; all eight hosts point `current` at `d3de6f35` and their built `dist/firstmeasure/full_house_points.js` contains `Math.ceil(rawPoints)`.
- Errors: NGINX 5xx on each web node since its activation 0.03–0.21 % (30 min before: 0.10–0.14 %), all but two `top_view_reroll_proxy.php` (one `editor.php`, one acquisition event/track each on two nodes); compatibility 0.68 % since activation vs 0.96 % before, the same proxy route. Worker and compatibility: no error-level log lines since activation.
- Jobs since worker activation: 209 completed (imagery, PDF sync, report delivery and release), none failed, 2 running; queued `report.release` jobs are scheduled ones, none due (203 were queued before activation).
- Not done: a real full-house submission on production (that is a technician's submit). The confirmation is the next exterior project showing a whole number of points.

## Not in this release: the two completed projects

Two exterior projects completed before this release keep their fractional points (`exteriors_6e0db661…` 9.6, `exteriors_c0db6887…` 10.6). Repairing them is a production data change that changes technicians' earnings, and was not part of this code release.

## Rollback

Every role keeps `c828835b`. Republish its archive (`d09a221b…`) to the channel from `/opt/firstmeasure/releases/c828835b…/deploy/digitalocean/`, then `activate-release.sh c828835b… <service>` on each role. Code only: this release writes no data; projects submitted on it keep their whole-number points after a rollback.
