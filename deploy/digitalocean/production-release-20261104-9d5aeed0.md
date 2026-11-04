# Production release 9d5aeed0: typing a report order's address on a phone keeps the keyboard open (FM-329), November 4, 2026

Released from fm-agents-1 by the tracker's production run for FM-329 ("Typing address on mobile", FirstMeasure bug fixes), under the workspace's standing authorization for issues set to "Testing in prod" once verified on dev.

It is production-live `8b93c7bd` (release `6802e716`) plus one commit on `claude/fm-329-typing-address-on-mobile-prod`:

- `9d5aeed0`: cherry-pick of canonical `5e1cdc3f`, unchanged, on dev as `platform-20261104173143-e27771d7`.

## Change

- **Typing a project address while ordering a report on a phone keeps the keyboard open** (FM-329). Every letter re-renders the order, and that re-render opened the project details tray, which on a phone is a sheet that focuses its close button; the mobile order pages then closed it again at once and made it `inert`, so nothing was focused and the keyboard closed after each letter. `setDetailsTrayOpen` in `public/libraries/apps/project-request/app.js` (3 lines) no longer opens the tray by itself over the mobile order pages; a person's tap on the project title still opens it, and desktop is unchanged.
- New test `public/v1/tests/project-request-mobile-address-focus-browser.test.mjs`.
- Browser code only: no server code, PHP, editor, database, migration, dependency, environment or config library change. No production data changed.

## Checks before release

- Diff against production-live: the plan's 2 files only (`app.js` +3, the new test).
- Build on the dev worker in 317 s (npm ci, type check, build, prune): archive sha256 `0470188cbea875813e29b5946f86d2b25db11de0b3e2327c7ad2910832b64617`, verified there, on compatibility and on the worker. The archive's `app.js` has the fix.

## Rollout

- Rollback target recorded on FM-329 before activation: `6802e716cef9938affbe26009b3d47d0635a6740` (all eight hosts' `current`, public readiness 3 of 3, 17:36 UTC).
- Compatibility at 17:44:57 UTC from `6802e716`: active on `9d5aeed0`, no 500s and no worker exits in the first 20 s.
- Worker at 17:45:44 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published against `ec9c4329…` (6802e716's archive); all six web nodes downloaded `9d5aeed0` / `0470188c` from it.
- Six web nodes one at a time behind the load balancer, 17:46:43–18:00:00 UTC, each withdrawn, activated (94–96 s), asset-checked (`core.js`, color picker, `roof-viewer.js`, `project-request/app.js` served = `current`; served `app.js` has the FM-329 fix; FM-326's and FM-327's builds still there) and back behind the load balancer on the new release before the next.

## After activation

- Public readiness answered `9d5aeed0` (`ok`, `ready`) on 12 of 12 requests; all eight hosts point `current` at `9d5aeed0`.
- `https://app.1m8.ai/libraries/apps/project-request/app.js` contains "nothing opens the tray over them by itself".
- Errors: NGINX 5xx on each web node since its activation 0.03–0.08 % (30 min before: 0.16–0.20 %), all `top_view_reroll_proxy.php`, which was failing before this release; compatibility 0.61 % since 17:45:20 vs 0.68 % before, the same proxy route plus one editor.php 503, as before at a few per hour. Web error-level log lines are the same kinds as before (stream "premature close", a request aborted). Worker and compatibility: no error-level log lines since activation.
- Jobs since worker activation (17:45:44): 236 completed (imagery, PDF sync, report delivery and release), none failed, 2 running; queued jobs are 271 scheduled `report.release`, none due.
- Not done: typing an address on a real phone against production. That was verified on dev in iPhone 13 and Pixel 7 viewports (FM-329's comment); the confirmation here is a person ordering a report on a phone.

## Rollback

Every role keeps `6802e716`. Republish its archive (`ec9c4329…`) to the channel from `/opt/firstmeasure/releases/6802e716…/deploy/digitalocean/`, then `activate-release.sh 6802e716… <service>` on each role. Code only: this release writes no data.
