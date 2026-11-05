# Production release 73ff28d0: Wall materials "Select all unassigned", November 5, 2026

Released from Jack's PC through fm-agents-1 on Jack's request to have it on production "as fast as possible"
(relayed by the session that started this one), after dev verification. It is production-live `87b1d1bf` (release
`f55d5b10`) plus one editor-only commit, `73ff28d0`. That commit is the measure-internal lane change (on dev as
`measure-internal-20261105000309-5e150e64`) ported onto production's own copies of the six files. Production is pinned
before curved-face editing, and four of the six differ from the lane, so the lane's files were not copied. No dev-only
lane work came along.

Order agreed with the two other editor releases that night: `4132aeda` (Resources videos), then `f55d5b10` (WebGL
context), then this one.

## Change (public/measure/internal/editor_scripts)

- `wall_features.js`: a **Select all unassigned** button at the top of Wall materials › Faces, with a status line:
  "N faces selected", "No unassigned faces", and "· M hidden wall pieces can't be selected" when such pieces exist.
  A material or colour clicked next assigns every selected face in one step (the existing `applySelectedFinish`).
- `exterior_report_model.js`: `unassignedFace` (exported). It is `build()`'s own test for a face it reports as wall
  cladding, plus its material-name table (`materialNames`, now shared by `build()`). The button finds exactly the
  faces the report's "Unassigned materials" warning counts.
- `wall_mode.js`: `reportParts` gives a face's report parts (chimney and closed-soffit pieces, finish resolved).
  `reportSnapshot` now uses it, unchanged in effect. `selectUnassigned` maps each matching face to a selection ref and
  fits the view to them.
- `wall_face_draft.js` / `wall_editor.js`: `selectFaces(refs)` replaces the selection with solid surfaces, draft
  regions or generated walls. A generated wall not drawn yet is drafted first (`ensure`), as a click on it does.
- `scene_3d.js`: `fit3DViewToActiveGeometry({points})` fits given points instead of the whole measurement.
- No server, PHP, data, config or dependency change.

Known gap (pre-existing, not changed): a chimney-side draft whose `members` list is empty never claims its
`:cell-N` generated walls, so the report counts each cell as a wall of its own and no click or selection reaches it.
The button skips these and reports how many there are. The fix belongs in chimney draft membership
(`WallGeometry.draftOwnsWall`).

## Checks before release

- Dev (pilot house, headless Chrome, server writes aborted, localStorage writes dropped), 1600x1000 and 1280x800.
  - With the house's Brick wall default: "No unassigned faces", and the warning agrees.
  - With the default set to Smooth in the tab: the warning counted 67 walls. The button selected 76 faces; one
    Stucco click left 8 walls, the 11 hidden chimney cells the status names.
- The candidate with every other production editor script from app.1m8.ai: same results.
- Build on the dev worker (`npm run check` included) in 260 s. Archive sha256
  `e0d1e105fa457dc38ba86110f7fb2aa2178575441c903bc2df9335eb57411e0b`, which contains this change and f55d5b10's
  WebGL fix.

## Rollout (scripts: fm-agents /srv/agents/work/sel-73ff28d0-prodrun-scripts)

- Tracker router `tracker-router@bugs` was already stopped (left stopped by the 3e102a37/4132aeda/f55d5b10 runs).
- Rollback target before activation: `f55d5b101ba87541c2c488d77e722e65d8115a54`, every host's `current`.
- Compatibility at 01:37:57 UTC: active, no 500s and no worker exits in the first 20 s.
- Worker at 01:38:53 UTC, after no jobs were running: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility (from the release directory) against `7090de25…` (f55d5b10's
  archive). All six web nodes downloaded `73ff28d0` / `e0d1e105` from it.
- Six web nodes one at a time behind the load balancer, 01:40:05–01:53:11 UTC (about 94 s each). Each was
  asset-checked as in f55d5b10's run (all earlier fixes, including the WebGL context, Resources video and window
  sides), plus `selectUnassigned`, `wall-select-unassigned`, `unassignedFace` and the `selectFaces` forwarder in the
  built editor.

## After activation

- Public readiness answered `73ff28d0` on 12 of 12 requests; all eight hosts point `current` at it.
- app.1m8.ai serves the new `wall_features.js` and `wall_mode.js`.
- Every production editor script served from app.1m8.ai (68 files, none local), on the dev pilot house: same results
  as before release at 1600x1000 and 1280x800.
- Web nodes since 01:40: 12–21 5xx of about 12,500 requests each. All are `top_view_reroll_proxy.php` (failing
  before this release), apart from the planned `/v1/health/ready` 503s while each node was taken out of the load
  balancer.
- Tracker router started again at 01:55 UTC.
- Not done: a customer project opened in the production editor. No production staff session was used, to avoid
  editor writes to customer projects. The confirmation is Jack opening Wall materials on a project with the warning.

## Rollback

Every role keeps `f55d5b10`. To roll back, republish its archive (`7090de25…`) to the channel from
`/opt/firstmeasure/releases/f55d5b10…/deploy/digitalocean/`, then run `activate-release.sh f55d5b10… <service>` on
each role. Code only: this release writes no data.
