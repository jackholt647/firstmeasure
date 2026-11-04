# Production release f7819345: Design's Walls default changes every wall (FM-332), November 4, 2026

Released from fm-agents-1 by the tracker's production run for FM-332 ("Unchanged wall material", FirstMeasure bug fixes), under the workspace's standing authorization for issues set to "Testing in prod" once verified on dev.

It is production-live `ae0b01cc` (release `9d3a3cf2`) plus one commit on `claude/fm-332-unchanged-wall-material-prod`:

- `f7819345`: clean cherry-pick of canonical `d4ffe855`, on dev as `platform-20261104195348-8bfed166`. Its three served files are byte-identical to `d4ffe855`'s.

## Change

- **Design mode Walls default** (`public/libraries/apps/measurements/roof-viewer.js`): new `designWithWallDefault(design, material)`. Picking a Walls default chip sets `defaults.material` and clears each face's own `material` in `design.walls`, so the newest choice reaches every wall. A face's own color stays, and walls the drafter gave another material (foundation concrete and stucco) keep it. Before this, a face's earlier *Selected face* material beat the default: on 2301 19th Ave S wall W16 kept Stucco when the default became Stone, drawn in the navy wall color.
- Version bumps: `project-widgets.js` loads `roof-viewer.js?v=20261104-wall-default`; `firstmate-apps-manifest.js` bundles roof-viewer at `20261104-wall-default`.
- New test `public/v1/tests/measurements-roof-viewer-wall-default.test.mjs`.
- Browser code only: no server code, PHP, editor, database, migration, dependency, environment or config library change. No production data changed. The reporter's saved design still holds W16 = Stucco until someone clicks a Walls default once; that click clears it.

## Checks before release

- Diff against production-live: the plan's 4 files only.
- Build on the dev worker in 309 s (npm ci, type check, build, prune): archive sha256 `bf9fd64c39e2f8b151c8f3340694e7cfec0b9631fe22456a9809c740cf82d08e`, verified there, on compatibility and on the worker. The worker's build repo held a leftover `public/v1/node_modules` symlink from the 9d3a3cf2 run, which made build.sh's clean-tree check exit silently; the link (not its target) was removed first.

## Rollout

- Rollback target recorded on FM-332 before activation: `9d3a3cf26c6fc0e0f92b49f14ac90c330b9efca1`. At 20:00 UTC it was every host's `current` (eight hosts) and what public readiness reported.
- Compatibility at 20:09:39 UTC from `9d3a3cf2`: active on `f7819345`, with no 500s and no worker exits in the first 20 s. Five editor/login 502/503 fell inside the restart window 20:09:39–20:09:46.
- Worker at 20:10:16 UTC, after no jobs were running: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published against `778f9e1a…` (9d3a3cf2's archive). All six web nodes downloaded `f7819345` / `bf9fd64c` from it.
- Six web nodes one at a time behind the load balancer, 20:11:19–20:24:24 UTC. Each was withdrawn, activated (94–96 s) and asset-checked: served `core.js`, color picker, `roof-viewer.js`, `project-request/app.js`, `exteriors.js`, `project-widgets.js`, the apps manifest, photos, doc workflow and holiday lights match `current`. Served `roof-viewer.js` has `designWithWallDefault` beside FM-330/331's and 9d3a3cf2's markers, and `project-widgets.js` and the manifest load roof-viewer at `20261104-wall-default`. Each node was back behind the load balancer on the new release before the next started.

## After activation

- Public readiness answered `f7819345` (`ok`) on 12 of 12 requests; all eight hosts point `current` at `f7819345`.
- `https://app.1m8.ai/libraries/apps/measurements/roof-viewer.js?v=20261104-wall-default` is byte-identical to the commit's file (`designWithWallDefault` present). `project-widgets.js` and the manifest carry `20261104-wall-default` publicly.
- Errors: NGINX 5xx on each web node in the first 5 minutes after 20:24:24 is 0–0.06 % (30 min before: 0.13–0.14 %), only `top_view_reroll_proxy.php` (failing before this release). Compatibility since 20:09:50: 0.63 % vs 0.72 % before, all the same proxy route. Worker and compatibility: no error-level log lines since activation.
- Jobs since worker activation (20:10:16): 289 completed (imagery, PDF sync, report delivery and release), none failed, 2 running. Queued jobs are 319 scheduled `report.release`, none due.
- Not done: clicking Stone in the production Design panel as a signed-in person (there is no production login on fm-agents-1). The confirmation is a person doing it.

## Rollback

Every role keeps `9d3a3cf2`. To roll back, republish its archive (`778f9e1a…`) to the channel from `/opt/firstmeasure/releases/9d3a3cf2…/deploy/digitalocean/`, then run `activate-release.sh 9d3a3cf2… <service>` on each role. Code only: this release writes no data.
