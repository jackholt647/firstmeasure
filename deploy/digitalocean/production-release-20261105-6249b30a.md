# Production release 6249b30a: hide Show Dev Controls in the exterior editor (FM-336), November 5, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. It is production-live `be498109` (release
`3c749b00`) plus one commit, `6249b30a`: the plan commit `cf5789fb` cherry-picked unchanged (identical diff, and line
for line the lane commit `e4e97d2c` verified on dev in `measure-internal-20261105033326-dd29e7f0`).

The plan was written on top of FM-335's `ab5e8a9f`; that release was rolled back at 03:59–04:14 (compat watchdog
kills), so this release does not contain FM-335.

## Change (editor only)

- `public/measure/internal/editor.php`: `window.FIRSTMEASURE_DEV_TOOLS` is true only when the host is `dev.1m8.ai`
  (the same host check as Exterior AI). Always false on app.1m8.ai.
- `editor_scripts/wall_mode.js`: the Full Exterior gear menu renders and wires **Show Dev Controls** only with that flag.
- `editor_scripts/exterior_performance.js`: without the flag a stored `firstmeasure:editor:show-dev-controls=true` is
  ignored and `setControlsVisible` does nothing, so the Wall development panel and profiler stay hidden for people who
  ticked it before.
- `dev/wall-mode.test.cjs`, `dev/exterior-performance.test.cjs`: regression guards. No Node, schema, configuration,
  dependency or data change.

## Checks before release

- Dev: router regression (`wall-mode`, `exterior-performance` and 14 other mapped editor suites) passed; headless check
  on dev's deployed `exterior_performance.js`.
- Production before the release (3c749b00): with the stored setting the panel showed (`controlsVisible: true`),
  confirming the bug.
- Build on the dev worker (`npm run check` included) in 278 s. Archive sha256
  `8a36959900586c6b3d2453ff751f3bf6e5db616663962c0e0d89c857a9353a84`.
- Installed `editor.php`'s expression gives false for `app.1m8.ai` and `app.1m8.ai:443`, true for `dev.1m8.ai`.

## Rollout (scripts: fm-agents /srv/agents/work/fm-336-prodrun-scripts)

- Rollback target before activation: `3c749b003040c090fd5ad06d09a241ccea2729d4`, every host's `current` at 04:15;
  recorded on FM-336.
- Compatibility at 04:24:10 UTC: active, no Node 500s and no worker exits in the first 20 s (4 nginx 5xx at
  04:24:10–19, the expected restart window).
- Worker at 04:24:53 UTC, after no jobs were running: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `5361d6b9…` (3c749b00's archive). All six web nodes downloaded
  `6249b30a` / `8a369599` from it.
- Six web nodes one at a time behind the load balancer, 04:25:56–04:38:26 UTC (about 94 s each), each asset-checked
  as in 3c749b00's run plus FM-336 (`FIRSTMEASURE_DEV_TOOLS` and `${devTools?` in `wall_mode.js`, the guard in
  `exterior_performance.js`, the flag line in `editor.php`, and both files as served).

## After activation

- Public readiness answered `6249b30a` on 12 of 12 requests (all six instances); all eight hosts point `current` at
  it, with the expected service active on each.
- `https://app.1m8.ai/measure/internal/editor_scripts/wall_mode.js` has `FIRSTMEASURE_DEV_TOOLS` once,
  `exterior_performance.js` twice.
- Headless, production's served `exterior_performance.js` with `show-dev-controls=true` stored and no flag: panel
  hidden, still hidden after `setControlsVisible(true)`, `controlsVisible` false. With the flag set it still works.
- Web nodes since 04:25:56: 0–2 5xx of about 9,000 requests each (0–0.02 %, down from 0.81–0.94 % in the 30 minutes
  before, which included FM-335's rollback); all `top_view_reroll_proxy.php` (failing before this release) or
  `/v1/platform/acquisition/*`.
- Compatibility since 04:24:30: 6 5xx of 5,173 nginx requests, all `top_view_reroll_proxy.php`; no Node 5xx; no
  cluster watchdog kills (`missed its` / `exited (slot`) from 04:24 to 04:50 UTC (FM-335's kills began 15 min in).
- Jobs since the worker activation: 29 completed (imagery.process, pdf.sync, report.delivery, report.release);
  `report.release` jobs queued with none due yet (215 queued before activation).
- Not checked: opening the Full Exterior editor's gear menu in a signed-in production session (no production staff
  login here). A person confirms that.

## Followed by cad6a00b

At 04:47 UTC another session started hotfix `cad6a00b` (branch `hotfix/resources-customer-orders-20261105`, Resources
on customer full-house orders), built on top of this release's `6249b30a`, so it keeps FM-336. Its compat restart at
04:47:33 caused about 50 Node 503s ("server is closing") and 18 `backend_login.php` 502s in 8 s; those belong to that
release's activation, not this one. That run records its own release and rollback.

## Rollback

`3c749b003040c090fd5ad06d09a241ccea2729d4` is still installed on every host: activate it on compatibility, the worker
and each web node one at a time with `activate-release.sh`, and republish the channel with 3c749b00's archive against
`8a369599…`. Code only; this release writes no data.
