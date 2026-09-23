# Selection performance and turret contact picking — September 22, 2026

Runtime release: `59fc259934108ff238d7664d5843a25e1e02058e`.
Original baseline: `1730b0ea934dfca700e1f246738868f57e10e2e3`.
Intermediate release / immediate rollback: `e4a2e9ae6311653da76a78020f2d3909d5da85e6`.

## Cause and correction

A live selection capture spent 1,358 ms in 36 wall-composition calls. Picking bypassed the render-derived geometry cache, and rectangle selection repeated support queries. Selecting an entity also called the active-layer setter, which persisted the model and synchronously rebuilt the views even when the layer had not changed; another highlight redraw followed.

Composed walls now reuse a value-keyed snapshot for unchanged state and stage. Pointer picking shares one composition scope. Read-only selection queries reuse render-derived support topology, wire geometry and roof-contact candidates. Draft materialization occurs before entering a rectangle query snapshot. In-place edits, replaced geometry and undo invalidate the caches.

Selecting the active layer no longer persists state or synchronously rebuilds the views. Wall selection defers any necessary layer transition to its queued highlight redraw.

Roof-contact highlights come from merged structural outlines, whereas picking previously required corresponding sketch edges. The picker now includes the displayed contact edges, and Resoffit picks directly from that same list. Rectangle line visibility is tested at the projected line midpoint rather than the pointer-release corner.

## Validation

All 908 editor and geometry regression tests pass. Added cases cover cache reuse and invalidation, displayed contacts absent from the sketch in both normal and Resoffit modes, rectangle visibility coordinates, and same-layer selection without synchronous scene rebuilds or model timestamp changes.

A Node geometry-query benchmark on the layered-turret house reduced warm repeated line picks from approximately 15–19 ms to 3–5 ms and rectangle queries from approximately 27–30 ms to 7–11 ms. These exclude browser rendering and visibility raycasts.

The first live follow-up capture reduced wall composition from 36 calls / 1,358 ms to one call / 60 ms. This capture exposed the duplicate layer-change redraw, which was then removed in the final runtime release.

## Delivery

Changes to `wall_face_draft.js`, `wall_mode.js`, `wall_editor.js` and their tests were synced to the primary local workspace after verifying the previous versions. Both development deltas validate changed-file baseline hashes and more than 24,000 unchanged files on each role before activation. PHP-FPM is refreshed on PHP-serving roles.

No production changes or server-side project save are part of this release. Browser verification uses a temporary tab; the user's original tab and selection remain untouched.

All three development roles activated the final release. Public readiness reports the matching development release with outbound isolation enforced, and both changed assets match their expected HTTP checksums.

Final live verification selected the front and adjoining turret contact lines. A warm additive contact query measured 12.7 ms; a rectangle query measured 16.9 ms and selected 19 points. Neither capture included wall composition or model backup work. The rectangle capture included one 48.5 ms 2D redraw and one 63.9 ms 3D rebuild, so these query timings are not claims of complete input-to-paint latency. General view rendering remains separate work. The temporary verification tab was closed.
