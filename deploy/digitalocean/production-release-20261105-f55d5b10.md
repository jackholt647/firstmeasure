# Production release f55d5b10: the editor survives a refused or lost WebGL context, November 5, 2026

Released from Jack's PC through fm-agents-1 as an urgent production bug fix. Jack hit it in production QA and asked
for the fix on production after dev verification; the go was relayed by the session that started this one. It is
production-live `c0eaf46c` (release `4132aeda`) plus one editor-only commit, `f55d5b10` (lane `a3cdf808`, on dev as
`measure-internal-20261105003026-2f5fada3`). Production's `main.js`, `scene_3d.js` and `wall_mode.js` equalled
`7b1fb765`'s before, so no dev-only lane work came along (production stays pinned before curved-face editing).

## Cause

Opening a full-exterior project in the editor for QA ("233 Prairie Vista Dr, Dallas") raised the alert "Load Error:
Error creating WebGL context." and the 3D view stayed blank. Three.js r128 says exactly that (without "with your
selected attributes") only when the browser refuses every WebGL context. So at that moment Jack's Chrome (Intel Arc,
D3D11) gave the page no WebGL, most likely after a GPU reset. WebGL worked again on app.1m8.ai when checked later.

The editor does not leak contexts. A page makes 5 and keeps 3 live (Cesium 3D Tiles, the main 3D view, the axis
gizmo), and `init3D` disposes the ones it replaces. QA's visible editor iframe plus its 1×1 preload frame held about 6
live across 8 swaps on this PC's GPU, with no failure. Neither earlier release that day (`3e102a37`, `4132aeda`)
touched renderer or context creation.

The editor's faults:
- `init3D` let the renderer's error escape to `loadProject`'s catch, so the project stopped loading (no walls, no
  undo history) behind a raw `alert`.
- A context lost later was never handled.
- Every editor, including QA's hidden preload frame, ran a Cesium 3D-tiles viewer that redrew every frame.

## Change (public/measure/internal/editor_scripts)

- `scene_3d.js`: `init3D` creates its renderer first (`create3DRenderer`). If the browser refuses, the current view
  stays as it is and a notice in the 3D pane says so. It retries after 1.5, 4 and 10 s, then offers Try again / Reload
  page with advice (close other editor tabs; restart Chrome; check hardware acceleration). The rest of the project
  loads.
- `webglcontextlost` shows "restoring". On `webglcontextrestored` the scene redraws in place. With no restore within
  6 s the view restarts. A replaced renderer is marked `_fmRetired` so its own `forceContextLoss` is ignored. The axis
  gizmo is skipped when it can't get a context.
- `main.js`: Cesium runs with `requestRenderMode` (it draws when the camera, tiles or size change) inside a try/catch.
- `wall_mode.js`: its window capture-click handler swallowed clicks in `#three-view-wrapper`. `#three-context-notice`
  is now excluded, so the notice's buttons work.
- No server, PHP, data, config or dependency change.

## Checks before release

- Dev (headed Chrome on Jack's PC, real GPU, pilot house, writes and localStorage writes blocked).
  - Unpatched: a refused context reproduces the alert, and the project never finishes loading.
  - Patched: recovers with no alert; Try again restores the view; lost→restored and lost-without-restore both
    recover, with the textured house drawn.
  - 4 QA-style iframe swaps: no failures, context counts unchanged.
  - 3D Tiles view identical to before.
- The candidate checked with every production editor script served from app.1m8.ai plus these three files: same
  results.
- Build on the dev worker (`npm run check` included) in 270 s. Archive sha256
  `7090de250a1125c74a722da7ceed33676891ad8721c9045cbcde48629eddd8d6`.

## Rollout

- Tracker router `tracker-router@bugs` was already stopped (by the 3e102a37 release).
- Rollback target before activation: `4132aedabd4197f3ac4b855f32fba11bcae270ad`, every host's `current`.
- Compatibility at 01:12:57 UTC: active, no 500s and no worker exits in the first 20 s. Its only 5xx since then are 14
  requests in the restart minute, answered by the outgoing 4132aeda processes ("Fastify has already been closed").
  None after 01:14.
- Worker at 01:13:45 UTC, after no jobs were running: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility (from the release directory) against `a539ddc6…` (4132aeda's archive).
  All six web nodes downloaded `f55d5b10` / `7090de25` from it.
- Six web nodes one at a time behind the load balancer, 01:14:48–01:28:16 UTC (about 94 s each). Each was
  asset-checked as in 4132aeda's run, plus `create3DRenderer`, `requestRenderMode: true` and `#three-context-notice`
  in the built editor.

## After activation

- Public readiness answered `f55d5b10` on 12 of 12 requests; all eight hosts point `current` at it.
- app.1m8.ai serves the new `scene_3d.js`, 6 of 6 requests.
- Every production editor script served from app.1m8.ai (67–68 files, none local), run in the dev editor on the pilot
  house: normal load, refused-context recovery with no alert, lost→restored. All pass.
- Web nodes since 01:14:48: 0.03–0.07 % 5xx, only `top_view_reroll_proxy.php` (failing before; 0.45–0.51 % in the 30
  minutes before).
- Jobs since worker activation: 157 completed, 20 queued.
- Not done: a customer project opened in the production editor. No production staff session was used, to avoid
  editor writes to customer projects. The confirmation is Jack reopening the project in QA.

## Rollback

Every role keeps `4132aeda`. To roll back, republish its archive (`a539ddc6…`) to the channel from
`/opt/firstmeasure/releases/4132aeda…/deploy/digitalocean/`, then run `activate-release.sh 4132aeda… <service>` on
each role. Code only: this release writes no data.
