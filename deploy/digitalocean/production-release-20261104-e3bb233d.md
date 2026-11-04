# Production release e3bb233d: viewer stands doors and windows off the outside of their wall (FM-331), November 4, 2026

Released from fm-agents-1 by the tracker's production run for FM-331 ("Viewer door discrepancy", FirstMeasure bug fixes), under the workspace's standing authorization for issues set to "Testing in prod" once verified on dev.

It is production-live `6f39af7b` (release `31ddf81a`) plus one commit on `claude/fm-331-prod-on-fm330`:

- `e3bb233d`: cherry-pick of the plan's `1aa19289` (itself a cherry-pick of canonical `bb7d0211`), on dev as `platform-20261104182224-cfe80a7f`. The plan was cut from `edae8c54`; FM-330 shipped in between and also changed `roof-viewer.js`. That file merged cleanly, and its diff matches `1aa19289` line for line, beside FM-330's `materialsUsable`. Only the `?v=` strings in `project-widgets.js` and the apps manifest conflicted: production's lines were kept with `20261104-wall-outward`.

## Change

- **Model viewer openings** (`public/libraries/apps/measurements/roof-viewer.js`): new `exteriorOutwards(walls, base)` orients each wall for standing doors, windows and their trim 3 cm off it. It checks, in order, the base footprint (as the report does), then ray parity against the other walls, then the saved normal, then the house centre. Before this, the viewer trusted the saved normal (d35e275f). A report drawn without a base saves some walls' normals pointing into the house: on 2301 19th Ave S those were W01, W07, W09/W10, W18 and W25. Their doors and windows sat 3 cm behind the siding, and whether they showed depended on canvas size and zoom. Walls the base orients keep the result they had before.
- Version bumps: `project-widgets.js` loads `roof-viewer.js?v=20261104-wall-outward`; `firstmate-apps-manifest.js` bundles roof-viewer and project-widgets at `20261104-wall-outward`.
- New test `public/v1/tests/measurements-roof-viewer-wall-outward.test.mjs`.
- Browser code only: no server code, PHP, editor, database, migration, dependency, environment or config library change. No production data changed. The report's stored normals and the elevation labels of reports without a base are unchanged (a possible editor follow-up, not part of this release).

## Checks before release

- Diff against production-live: the plan's 4 files only; JavaScript parses. On `e3bb233d`: wall-outward 5/5, report-rounding 6/6, full-house-viewer-browser 6/6, roof-viewer-browser 2/2.
- Build on the dev worker in 299 s (npm ci, type check, build, prune): archive sha256 `5822d50ecb19f37786faa2c84deb2cfef0e8567a3238f8eb2e8d295f789925a2`, verified there, on compatibility and on the worker.

## Rollout

- Rollback target recorded on FM-331 before activation: `31ddf81ac9bbf40619255d51128bf2596d48442b`. At 18:58 UTC it was every host's `current` (eight hosts) and what public readiness reported, 10/10.
- Compatibility at 19:06:42 UTC from `31ddf81a`: active on `e3bb233d`, with no 500s and no worker exits in the first 20 s.
- Worker at 19:07:37 UTC, after no jobs were running: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published against `f5a04a2d…` (31ddf81a's archive). All six web nodes downloaded `e3bb233d` / `5822d50e` from it.
- Six web nodes one at a time behind the load balancer, 19:08:52–19:21:13 UTC. Each was withdrawn, activated (94–97 s) and asset-checked: served `core.js`, color picker, `roof-viewer.js`, `project-request/app.js`, `exteriors.js`, `project-widgets.js` and `firstmate-apps-manifest.js` match `current`. Served `roof-viewer.js` has `exteriorOutwards` and `materialsUsable`, and `project-widgets.js` and the manifest load roof-viewer at `20261104-wall-outward`. FM-326's to FM-330's changes are still there. Each node was back behind the load balancer on the new release before the next started.

## After activation

- Public readiness answered `e3bb233d` (`ok`) on 12 of 12 requests; all eight hosts point `current` at `e3bb233d`.
- `https://app.1m8.ai/libraries/apps/measurements/roof-viewer.js` is byte-identical to the commit's file (`exteriorOutwards` present). `project-widgets.js` and the manifest carry `20261104-wall-outward`, publicly and on every web node and compatibility.
- The door: the FM-331 worker's headless harness rendered this report's model with the `roof-viewer.js` production now serves, at 290 px and 780 px and three zooms. W01's door (inside corner by the small west gable) draws as a door every time, including zoomed in at 290 px, where the old file showed only siding.
- Errors: NGINX 5xx on each web node since 19:21:13 is 0–0.06 % (30 min before: 0.10–0.16 %), only `top_view_reroll_proxy.php` (failing before this release). Compatibility since 19:06:42: 0.62 % vs 0.71 % before, the same proxy route plus four editor.php 502/503 inside the restart window 19:06:44–19:06:49. Worker and compatibility: no error-level log lines since activation.
- Jobs since worker activation (19:07:37): 212 completed (imagery, PDF sync, report delivery and release), none failed, 3 running. Queued jobs are 314 scheduled `report.release`, none due.
- Not done: opening 2301 19th Ave S in the production portal as a signed-in person (there is no production login on fm-agents-1). The confirmation is a person opening it.

## Rollback

Every role keeps `31ddf81a`. To roll back, republish its archive (`f5a04a2d…`) to the channel from `/opt/firstmeasure/releases/31ddf81a…/deploy/digitalocean/`, then run `activate-release.sh 31ddf81a… <service>` on each role. Code only: this release writes no data.
