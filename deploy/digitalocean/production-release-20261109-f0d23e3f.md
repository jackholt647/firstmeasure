# Production release f0d23e3f: the exteriors editor's FOV slider goes to 180 degrees (FM-354), November 9, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan commits were already children of
production-live `a32f90f2` (release `250d4076` plus its record), so they were released as is, with no cherry-pick:

| Issue | Plan commits (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-354 FOV slider maximum | `6bbb7e0c`, `f0d23e3f` (= lane `f762f63c`, `c37118c8`) on `claude/fm-354-fix-prod` | `f0d23e3f` | `measure-internal-20261109173838-5aeaa107` |

## Change

- `public/measure/internal/editor_scripts/scene_3d.js`: the perspective FOV slider goes 15–180° (was 15–100°). A
  rectilinear camera cannot be exactly 180° tall, so at 180 the camera uses 179.5° and the slider and label show 180°.
  From 15° to 100° the camera still moves in or out to keep the orbit target the same size on screen, exactly as
  before; above 100° it stays where 100° put it and only the lens widens
  (`PERSPECTIVE_FOV_COMPENSATION_MAX = 100`). Tooltip copy updated.
- Not served: `dev/scene-fov.test.cjs` (new FM-354 test), `dev/scene-fov-drag.test.cjs` (drag across 15–180).
- Measure editor browser file only. No Node, PHP, environment, database, migration, flag, nginx, dependency or data
  change; no data repair. The editor's `?v=` is content-based, so there was no version bump.

## Checks before release

- The diffs of `6bbb7e0c` and `f0d23e3f` equal lane `f762f63c` and `c37118c8` line for line. The release's
  `scene_3d.js` has the sha256 dev.1m8.ai serves (`c4a0e877…`); production served `3ebe62c7…` (250d4076's).
- Control: `dev/scene-fov.test.cjs` against production's file before the release failed 0/2; against the release file
  it passed 2/2.
- Build on the dev worker (`npm run check` included), 314 s. Archive sha256
  `ebe92bd498dcb002d1fd73f4fcb16a4ee791327dfdc7812eb1d72b38810db494`, verified on fm-agents, compatibility, the worker
  and each web node.
- New assert in `web_activate.py` (FM-354), beside FM-324, FM-335 to FM-352 and cad6a00b: each node's local
  `scene_3d.js` has sha256 `c4a0e877…`, holds `max="180" step="1" aria-label="Perspective field of view"` and
  `PERSPECTIVE_FOV_COMPENSATION_MAX = 100` once, and no `max="100"` slider. Checked against the archive's file first.
- Baseline at 17:52 UTC: web 5xx 0.05–0.06 % over 30 min, compatibility 0.68 % (nearly all
  `top_view_reroll_proxy.php`); compatibility 2 watchdog kills in the 3 h before.

## Rollout (scripts: fm-agents /srv/agents/work/fm-354-prodrun-scripts)

- Rollback target before activation: `250d4076033acb933ef996838141acb07ffaa9d2`, every host's `current` at 17:41 UTC;
  recorded on FM-354.
- Signed channel published from compatibility against `e7708c06…` (250d4076's archive).
- Worker at 17:52:44 UTC (no job running): 8 slots, production, heartbeat off, outbound email on.
- Six web nodes one at a time behind the load balancer, 17:52:35–18:05:20 UTC; every node passed every assert,
  including FM-354's.
- Compatibility last at 18:11:45 UTC through the gate, which opened at 18:11:44 at 400 `legacy-action`/min, load 1.0
  (after 6 min at 426–689/min). 0 Node 500s and 0 HTTP worker exits in the 20 s after.

## After activation

- All eight hosts point `current` at `f0d23e3f`. Public readiness answered `f0d23e3f`, `ok`, on 10 of 10 (all six
  instances) after the web rollout and again at 18:32, after compatibility.
- FM-354: through the load balancer `scene_3d.js` was `c4a0e877…` on 5 of 5 requests, with the `max="180"` slider and
  `PERSPECTIVE_FOV_COMPENSATION_MAX = 100`. The file production serves, put in a checkout of `f0d23e3f`, is
  byte-identical to the commit and passes `dev/scene-fov.test.cjs` 2/2 and `dev/scene-fov-drag.test.cjs` 1/1
  (Playwright Chromium, drag across 15–180).
- 5xx from 18:13 (after compatibility settled) to 18:23: web 0.02–0.08 % (about 14,000–15,000 requests each; the
  30 min before were 0.11–0.19 %), compatibility 0.75 % against 0.80 % before. Every 5xx was the existing
  `top_view_reroll_proxy.php`.
- Compatibility from 18:11:45 to 18:31: cluster watchdog **0 kills**, 0 Node 500s, 0 pool timeouts at 371–550
  `legacy-action`/min, load up to 2.0.
- Worker, 17:52:44–18:23: 534 jobs completed (90 `imagery.process`, 336 `pdf.sync`, 70 `report.delivery`, 38
  `report.release`), none failed and none retried. 237 `report.release` queued, none due (scheduled holds, as before).

## Not covered

- Dragging the slider in the real editor on production: there is no production login on fm-agents. Whether 180° in
  a real exterior project looks right is for a person to confirm.

## Rollback

`250d4076033acb933ef996838141acb07ffaa9d2` is still installed on every host: activate it on compatibility, the web
nodes one at a time and the worker (`fm-354-prodrun-scripts/rollback/`: `release.sh compat|worker|publish`,
`web_rollout.sh`), and republish the channel with 250d4076's archive against `ebe92bd4…`. Code only: rolling back
puts the slider's maximum back at 100°.
