# Production release 250d4076: on phones the report order address moves above the map while it is typed (FM-324), November 9, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan commit was already a child of
production-live `8580170c` (release `b4b7f404` plus its record), so it was released as is, with no cherry-pick:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-324 Saving bug (iPhone follow-up) | `250d4076` (cherry-pick of canonical `29a902b1`) on `claude/fm-324-iphone-address-prod` | `250d4076` | `platform-20261109155206-f3c9085f` |

## Change

- `public/libraries/apps/project-request/app.js`: on phones, while the report order's address field has focus on the
  first order page, the order panel sits above the map (overlay class `address-typing`), so the iOS keyboard never
  covers it and the page does not have to pan. Google's suggestions open below the field, capped to the room above the
  keyboard (replacing the block that placed them above the field). Desktop is unchanged; 350 ms after the field loses
  focus the page goes back to map-above-address.
- `public/libraries/apps/firstmate-apps-manifest.js`: `project-request/app.js` bundle version
  `20261109-fm324-address-typing`.
- Not served: `public/v1/tests/overview-order-layout-browser.test.mjs` (new regression test).
- Browser files only. No Node, PHP, editor, environment, database, migration, flag, nginx, dependency or data change;
  no data repair.

## Checks before release

- The diff of `250d4076` equals canonical `29a902b1` line for line. Both library files have the same sha256 as the
  files dev.1m8.ai served (`app.js` `0ff190df…`, manifest `034c38fc…`).
- Build on the dev worker (`npm run check` included), 286 s. Archive sha256
  `e7708c06d15bd07ca6621958e30efdccb3b7925ae71f95a8be2d1a08a1b10ac6`, verified on fm-agents, compatibility, the worker
  and each web node; its two library files match dev's hashes.
- New assert in `web_activate.py` (FM-324), beside FM-335 to FM-352 and cad6a00b: each node's two files have dev's
  sha256, are served unchanged by the node's own NGINX, `app.js` holds `__fmAddressTypingOnTop` and not
  `__fmAddressSuggestionsAbove`, and the manifest names `20261109-fm324-address-typing`.
- Baseline at 15:56 UTC: web 5xx 0.05–0.08 % over 30 min, compatibility 0.71 % (nearly all
  `top_view_reroll_proxy.php`); no failed or retried worker job in the two hours before.

## Rollout (scripts: fm-agents /srv/agents/work/fm-324-prodrun-scripts)

- Rollback target before activation: `b4b7f4048eb4d3deeed1a4db8cc30c3629a83d87`, every host's `current` at 15:55 UTC;
  recorded on FM-324.
- Signed channel published from compatibility against `a9a1b3dc…` (b4b7f404's archive).
- Worker at 16:05:48 UTC (no job running): 8 slots, production, heartbeat off, outbound email on.
- Six web nodes one at a time behind the load balancer, 16:06–16:20:10 UTC. The first node (64.23.240.81) activated,
  then stopped on the new FM-324 assert, which expected `__fmAddressTypingOnTop` once; the shipped file (same as dev's)
  has it twice on one line. NGINX was restored and the node was ready on the new release; the assert was corrected to
  2, the rollout resumed (`web_rollout2.sh`), that node passed the load balancer check, and the post-activation checks
  were rerun on it read-only (`web_verify.py`): all passed. The other five passed every assert.
- Compatibility last at 16:20:21 UTC through the gate, which opened at once at 323 `legacy-action`/min, load 0.6.
  0 Node 500s and 0 HTTP worker exits in the 20 s after.

## After activation

- All eight hosts point `current` at `250d4076`. Public readiness answered `250d4076`, `ok`, on 12 of 12 and then on
  24 of 24 (all six instances).
- FM-324: through the load balancer `app.js` was `0ff190df…` on 10 of 10 requests (`__fmAddressTypingOnTop` present,
  `__fmAddressSuggestionsAbove` absent) and the manifest `034c38fc…` on 5 of 5, the same files as dev.
- 5xx from 16:22 (after compatibility settled) to 16:32: web 0.02–0.13 % (about 10,000–11,000 requests each; the 30 min
  before were 0.11–0.21 %), compatibility 0.81 % against 0.80 % before. Every 5xx was the existing
  `top_view_reroll_proxy.php`.
- Compatibility from 16:20:21: cluster watchdog **0 kills**, 0 Node 500s, 0 pool timeouts at 228–321
  `legacy-action`/min, load up to 3.2 (watched until 16:41).
- Worker, 16:05:48–16:32: 386 jobs completed (66 `imagery.process`, 253 `pdf.sync`, 53 `report.delivery`, 15
  `report.release`), none failed and none retried, no error-level log lines. 187 `report.release` queued, none due
  (scheduled holds, as before).

## Not covered

- A real iPhone keyboard: Playwright's WebKit has none, and there is no production login on fm-agents. Whether tapping
  Project Address in New Report on an iPhone now moves the field to the top with suggestions under it is for a person
  to confirm.

## Rollback

`b4b7f4048eb4d3deeed1a4db8cc30c3629a83d87` is still installed on every host: activate it on the web nodes one at a
time (`fm-324-prodrun-scripts/rollback/`), the worker and compatibility with `activate-release.sh`, and republish the
channel with b4b7f404's archive against `e7708c06…`. Code only: rolling back puts the phone address field back under
the map with suggestions above it.
