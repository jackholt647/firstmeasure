# Production release 29855eb0: the project window's 3D model draws and totals the report's own line types, as its PDF does (FM-455), November 14, 2026

Released from fm-agents-1 by the FM-455 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The plan branch `claude/fm-455-line-type-mismatch-prod` (`29855eb0`) sits directly on the release `a4d1051d` (FM-410),
which was production at the start of the run. It was released as is: no cherry-pick. Each plan commit's `+/-` lines equal its
canonical commit. The only exception is the apps manifest, rebuilt from production's file with only FM-455's `?v=` swaps.
FM-410's `project-request/app.js` bump is kept.

| Release commit | Change | Same change as (verified on dev) |
| --- | --- | --- |
| `ae2fda87` | The project window's 3D model draws and totals the report's own line types, as its PDF does | canonical `d8eeba39` |
| `29855eb0` | The 3D model takes only the report's line totals, not its saved squares | canonical `97d7318d` |

Verified on dev in `platform-20261113191425-8694a4e1` (first ship `platform-20261113190950-3389b212`).

## Change

- Node: new read-only route `GET /v1/firstmeasure/projects/:id/roof-lines` (`firstmeasure/api.ts`, `customer` in
  `firstmeasure/route-access.ts`, same organization check as `exterior-model`). It returns the completed report's line
  types and the line totals its PDF prints. `platform/widgets/roof-classifications.ts`: `reportEdgeTypes(saved, xml)` picks
  the point numbering that agrees with the stored XML. `platform/widgets/catalog.ts` passes the XML.
- Browser: `measurements/roof-viewer.js` (`linesUrl`; draws only the report's lines), `measurements/project.js` (passes
  `linesUrl`), `platform-widgets/project-widgets.js` (passes `linesUrl`, roof-viewer `?v=`), apps manifest `?v=`
  (`20261113-fm455-line-totals` for roof-viewer and project-widgets, `20261113-fm455-roof-lines` for project.js).
- Tests (not served): `measurements-roof-viewer-line-types.test.mjs` (new), `roof-classifications.test.ts`, `route-access.test.ts`.
- No database, environment, flag, nginx, dependency or config-library change. No data repair: existing reports are fixed
  by the code alone.

## Checks before release

- At 06:00 UTC `current` was `a4d1051d` on all 8 hosts, and readiness reported `a4d1051d`. Root disks had 75 GB or more free.
  Rollback target `a4d1051d` was recorded on FM-455 before anything was activated.
- Built `29855eb0` on the dev worker (`npm run check` and build passed, 262 s). Archive sha256
  `ca3ae73235ab9d623c2ba093f2c37efa9294ff151f13b315e835a01b36d03e9b`. Full procedure, because Node changes.
- `web_activate.py` keeps every earlier assert. Pins that this release changes now name `29855eb0`'s blobs: the apps
  manifest, `roof-viewer.js`, `project.js` and `project-widgets.js`. FM-400's and FM-410's manifest checks now expect the
  FM-455 bumps, and FM-410's `rejection-tooltips` bump is gone (count 0). `no-build-proposal` is still 1. New FM-455
  asserts:
  - served `roof-viewer.js` equals local, with `linesUrl` x2 and `line.unlisted` x3
  - `project.js` has `/roof-lines` x1
  - the manifest has `fm455-line-totals` x2
  - `dist` has the route and its access entry, and `catalog.js` calls `reportEdgeTypes(detail.pdf_state,`
  - an anonymous `GET /v1/firstmeasure/projects/x/roof-lines` answers 401
  
  54 file asserts pass on the archive. Control: before the release, app.1m8.ai answered that route with 404 "Route not found".
- Read-only probe (`reportEdgeTypes` + `measurementPayloadFromSavedReport` on the reported job's report
  `9e0b30f3…`, as `/roof-lines` does), run against the installed but inactive release on the worker: 576 line types,
  including PROTRUSION x264, CHIMNEY_EDGE/BACK/FRONT 29/17/17 and a single SKYLIGHT.

## Rollout (scripts: fm-agents /srv/agents/work/fm-455-prodrun-scripts)

- Compatibility and the worker were installed at 06:09. The worker was activated at 06:10:06 UTC, with no running jobs.
- Channel published against `a4d1051d`'s archive (`ba2f1bf6…`).
- Web nodes went one at a time, 06:11:13–06:24:13 UTC. Each passed every assert (route 401, served roof-viewer
  `0e07c81e8d18`) and came back behind the load balancer.
- Compatibility at 06:24:18 UTC through the gate (291 legacy-action/min, load 0.15): rolling replace, with 0 Node 500s and 0 exits
  in the 20 s after.

## Verification

- `current` is `29855eb0` on all 8 hosts. Readiness reports `29855eb0` 10/10 (5 nodes answering).
- An anonymous `/roof-lines` request answers 401 (3/3). app.1m8.ai serves `roof-viewer.js` `0e07c81e8d18`, `project.js` `b177fc9a7b6c`,
  `project-widgets.js` `e1ddfd288228` and the manifest `4870097a2eb1`, 3/3 each, all equal to the release.
- Plan probe on web node 64.23.240.81 with firstmeasure-web's environment, in `current/public/v1`, on the reported job:
  - 576 line types (PROTRUSION, CHIMNEY_*, one SKYLIGHT)
  - line totals equal the PDF: Eave 1926.1, Rake 540.3, Valley 64.5, Parapet 360.9, Skylight 10.4, Headwall 760.8,
    Sidewall 177.5, Protrusion 516.0
- Two real customer `/roof-lines` requests after the rollout answered 200.
- 5xx from 06:26 to 06:41 UTC (after compatibility settled), excluding health probes:
  - web nodes: 0.00–0.04 % (0–1 each: `top_view_reroll_proxy.php` and one acquisition track), against 0.09–0.24 % in
    the 30 minutes before
  - compatibility: 0.34 % (3, all `top_view_reroll_proxy.php`), against 0.64 % before
- Compatibility, 06:24:18–06:46: 0 watchdog kills, 0 Node 500s, 0 pool timeouts, one MainPID throughout. In the 3 h
  before: 0 kills.
- Worker since 06:10:06: 30 jobs completed, 0 failed. No error-level lines, no browser-closed errors and no
  pool-timeout errors.

## Rollback

`/srv/agents/work/fm-455-prodrun-scripts/rollback/`: `release.sh worker`, `publish` (republishes `a4d1051d`'s archive),
`web_rollout.sh` (FM-410's forward asserts with base `29855eb0`), `release.sh compat`. Rolling back restores the 3D
model's XML-only line types. Nothing stored changes.
