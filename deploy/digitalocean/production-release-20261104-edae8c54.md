# Production release edae8c54: exteriors desktop order tweaks (FM-328), November 4, 2026

Released from fm-agents-1 by the tracker's production run for FM-328 ("Exteriors desktop order workflow tweaks", FirstMeasure bug fixes), under the workspace's standing authorization for issues set to "Testing in prod" once verified on dev.

It is production-live `04bbbedb` (release `9d5aeed0`) plus one commit on `claude/fm-328-prod-release`:

- `edae8c54`: cherry-pick of the plan's `8609ac18` (itself a cherry-pick of canonical `8c8bc6c3`), on dev as `platform-20261104175321-aefd3939`. Its three files are byte-identical to canonical `8c8bc6c3`.

## Change

- **Desktop Full Exterior order panel** (`public/libraries/apps/firstmeasure/order/exteriors.js`): no single-structure "Needs a video walkaround" or "0 of 8 angles" chip; new video subtitle ("Record one full loop around the house on your phone or tablet, then upload it here. Or, order directly from your phone."); the header Map button becomes "Back to Map" at the start of the upload strip in video and photo modes; "What's included" opens an anchored hover/click card in the order column instead of the bottom sheet with a backdrop; "Roof Only" becomes "Roof" (new key `ext_scope_roof`), on mobile and desktop.
- `public/libraries/apps/project-request/app.js` (2 lines): the order context gains `infoHtml`, and the roof info title becomes "Roof report" (`roof_report_title`).
- Tests in `public/v1/tests/exteriors-desktop-capture-browser.test.mjs`.
- Browser code only: no server code, PHP, editor, database, migration, dependency, environment or config library change. No production data changed.

## Checks before release

- Diff against production-live: the plan's 3 files only.
- Build on the dev worker in 299 s (npm ci, type check, build, prune): archive sha256 `ba4be5d3b1ecafb16179cf8c0867c264311fc1dd3591a8d4ca1a935dca0b3c86`, verified there, on compatibility and on the worker. The archive's `exteriors.js` has the fix.

## Rollout

- Rollback target recorded on FM-328 before activation: `9d5aeed07f19bfb3fb680d76bb53213ec6df2783` (all eight hosts' `current`, public readiness 10 of 10, 18:02 UTC).
- Compatibility at 18:11:05 UTC from `9d5aeed0`: active on `edae8c54`, no 500s and no worker exits in the first 20 s.
- Worker at 18:11:44 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published against `0470188c…` (9d5aeed0's archive); all six web nodes downloaded `edae8c54` / `ba4be5d3` from it.
- Six web nodes one at a time behind the load balancer, 18:12:43–18:26:29 UTC, each withdrawn, activated (94–96 s), asset-checked (`core.js`, color picker, `roof-viewer.js`, `project-request/app.js`, `firstmeasure/order/exteriors.js` served = `current`; served `exteriors.js` has `ext_desk_back_to_map` and `ext_scope_roof`, served `app.js` has the FM-328 `infoHtml` line; FM-326's, FM-327's and FM-329's changes still there) and back behind the load balancer on the new release before the next.

## After activation

- Public readiness answered `edae8c54` (`ok`) on 12 of 12 requests; all eight hosts point `current` at `edae8c54`.
- `https://app.1m8.ai/libraries/apps/firstmeasure/order/exteriors.js` contains `ext_desk_back_to_map` and no "Roof Only"; `project-request/app.js` contains `roof_report_title`.
- Errors: NGINX 5xx on each web node since its activation 0.04–0.06 % (30 min before: 0.08–0.24 %), all `top_view_reroll_proxy.php`, which was failing before this release; compatibility 0.73 % since 18:11:05 vs 0.68 % before, the same proxy route plus 7 editor.php and 1 backend_login.php 502/503 inside the restart window 18:11:05–18:11:13 (the same happened at FM-329's restart), none after. Worker and compatibility: no error-level log lines since activation.
- Jobs since worker activation (18:11:44): 250 completed (imagery, PDF sync, report delivery and release), none failed, 1 running; queued jobs are 298 scheduled `report.release`, none due.
- Not done: walking through a desktop Full Exterior order on production. That was verified on dev signed in at 1600×1000 (FM-328's comment); the confirmation here is a person ordering one.

## Rollback

Every role keeps `9d5aeed0`. Republish its archive (`0470188c…`) to the channel from `/opt/firstmeasure/releases/9d5aeed0…/deploy/digitalocean/`, then `activate-release.sh 9d5aeed0… <service>` on each role. Code only: this release writes no data.
