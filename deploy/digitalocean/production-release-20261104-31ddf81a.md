# Production release 31ddf81a: hide Generate from materials (FM-330), November 4, 2026

Released from fm-agents-1 by the tracker's production run for FM-330 ("Hide material generation", FirstMeasure bug fixes), under the workspace's standing authorization for issues set to "Testing in prod" once verified on dev.

It is production-live `8d67a97d` (release `edae8c54`) plus one commit on `claude/fm-330-prod-rel`:

- `31ddf81a`: cherry-pick of the plan's `2c448f04` (itself a cherry-pick of canonical `939375d4`), on dev as `platform-20261104180242-a1346503`. The plan was cut from `04bbbedb`; FM-328 shipped in between, and the cherry-pick onto `8d67a97d` applied cleanly.

## Change

- **Model Viewer Design panel** (`public/libraries/apps/measurements/roof-viewer.js`): opening Design quietly asks for the project's material lists, and *Generate from materials* shows only when they hold a usable roof, siding, trim or door product. Organizations without Materials (403 `app_flag_disabled`), empty or unusable lists, or no list address: the button is hidden and "The material lists could not be read." no longer appears. *Reset to as built* stays.
- Version bumps: `project-widgets.js` loads `roof-viewer.js?v=20261104-hide-material-generation`; `firstmate-apps-manifest.js` bundles roof-viewer and project-widgets at `20261104-hide-material-generation`.
- Test in `public/v1/tests/measurements-full-house-viewer-browser.test.mjs`.
- Browser code only: no server code, PHP, editor, database, migration, dependency, environment or config library change. No production data changed.

## Checks before release

- Diff against production-live: the plan's 4 files only; JavaScript parses.
- Build on the dev worker in 299 s (npm ci, type check, build, prune): archive sha256 `f5a04a2df0a9ebe5a175b0a26321e504ab99e443c48b7a6aa789874417637c59`, verified there, on compatibility and on the worker.

## Rollout

- Rollback target recorded on FM-330 before activation: `edae8c54d951869e674f9536d7de29fa7d18609f` (all eight hosts' `current`, public readiness, 18:29 UTC).
- Compatibility at 18:37:33 UTC from `edae8c54`: active on `31ddf81a`, no 500s and no worker exits in the first 20 s.
- Worker at 18:38:44 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published against `ba4be5d3…` (edae8c54's archive); all six web nodes downloaded `31ddf81a` / `f5a04a2d` from it.
- Six web nodes one at a time behind the load balancer, 18:39:47–18:53:15 UTC, each withdrawn, activated (94–96 s), asset-checked (`core.js`, color picker, `roof-viewer.js`, `project-request/app.js`, `exteriors.js`, `project-widgets.js`, `firstmate-apps-manifest.js` served = `current`; served `roof-viewer.js` has `materialsUsable`, served `project-widgets.js` loads `roof-viewer.js?v=20261104-hide-material-generation`; FM-326's, FM-327's, FM-328's and FM-329's changes still there) and back behind the load balancer on the new release before the next.

## After activation

- Public readiness answered `31ddf81a` (`ok`) on 12 of 12 requests; all eight hosts point `current` at `31ddf81a`.
- `https://app.1m8.ai/libraries/apps/measurements/roof-viewer.js` is byte-identical to the commit's file (has `materialsUsable`); `project-widgets.js` and the manifest carry `20261104-hide-material-generation`.
- Errors: NGINX 5xx on each web node since its activation 0.03–0.07 % (30 min before: 0.11–0.20 %), nearly all `top_view_reroll_proxy.php` (failing before this release) plus two 502s from `POST /v1/firstmeasure/projects/…/google-3d/capture` (a 10 s upstream call, server code unchanged here, seen before too); compatibility 0.73 % since 18:37:33 vs 0.72 % before, the same proxy route plus editor.php/backend_login.php 502/503 inside the restart window 18:37:33–18:37:48 and one 73-byte editor.php 503 at 18:50:29 of the kind seen every hour today. Worker and compatibility: no error-level log lines since activation.
- Jobs since worker activation (18:38:44): 250 completed (imagery, PDF sync, report delivery and release), none failed, 1 running; queued jobs are 322 scheduled `report.release`, none due.
- Not done: opening Design on production as an organization without Materials. That was verified on dev against the real material-lists endpoint (FM-330's comment); the confirmation here is a person opening it.

## Rollback

Every role keeps `edae8c54`. Republish its archive (`ba4be5d3…`) to the channel from `/opt/firstmeasure/releases/edae8c54…/deploy/digitalocean/`, then `activate-release.sh edae8c54… <service>` on each role. Code only: this release writes no data.
