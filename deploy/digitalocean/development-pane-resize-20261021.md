# Pane divider drags at 60 fps — development, October 21, 2026

Source `0f066dc4c7f51b5f6a22497104e6f6ebb62e8556`.

**Report.** Dragging the editor's pane dividers lagged by up to a second, although orbiting the 3D view was smooth.

**Cause.**
- Every pointer move during a divider drag (`pane_layout.js` → `resizeEditorPanes`) dispatched a synchronous window
  `resize` event, up to two per frame.
- Each event triggered a full 2D plan rebuild from `interaction_2d.js`, which in turn ran `redrawCanvas`, and that also
  renders the geometry. `customer_rework.js` triggered another, synchronous, rebuild. Each rebuild re-derived the wall
  topology.
- The plan lives in a pan/zoom layer in image coordinates, so a pane resize changes only what is in view.

Profiled on dev, a 60-move drag took 14.9 s, with p95 frames of 117–134 ms and spikes up to 550 ms.

**Fix.**
- Divider drags apply sizes immediately but notify views at most once per frame, and set
  `window.firstMeasurePaneResizing` until release.
- During a drag the 2D plan only updates its transform and the viewport-sized grid. The customer rework markers wait
  for release.
- One full redraw runs when the drag ends.

**After (live dev, no patches).** The same drags take 1.8 s (main divider) and 1.3 s (right column), with p95 frames of
17 ms. The remaining drag cost is mostly the Google map resizing itself.

**Rollout.** `editor.php`, `interaction_2d.js`, `pane_layout.js` and `customer_rework.js` were overlaid on web, legacy and pool.
The first attempt failed while staging on legacy (connection reset during its health check) and was retried onto
another session's newer live release (`14a6e3de`). All roles verified, and the served files match. Pane-layout and
history tests pass.

## Also: sticker centre snapping — `d4d6ea7af215aac52e0e16aa89a1b7b286007f0f`

When placing, pasting or moving a sticker (door, window, garage door or vent), its horizontal and vertical centres
snap independently to the centre of the face it sits on, within the usual 12 px snap radius. Active centre snaps
show a yellow centre line across the face, and free move (F) disables them.
- The centre is the bounding-box centre of the largest face outline containing the sticker. Existing openings and
  dividers do not shift it. On a gable wall the vertical centre includes the triangle.
- Snap order is unchanged: the snap needing the smallest move wins.

Tests: four new tests fail on the previous code and pass now. The related suites pass 672, and the full suite has
1,675 passing with the known exterior-ai failure. `wall_solid_geometry.js` and `wall_face_draft.js` were overlaid on
web, legacy and pool, and the served files match.

## Follow-up: the 3D view stretches while dragging — `7b3a27d970b8cd06a86dbfefc90c25932eb72a32`

The user still saw slow resizing, with the 3D view in the main pane. Every frame of the drag still reallocated the
WebGL drawing buffer (`sync3DViewportSize` → `renderer.setSize`). That is cheap in a 1× software browser but stalls a
real GPU on large high-DPI views: measured at 2× density on a 2400×1350 window, `setSize` was the top cost, at about
14 ms per frame even in software. During a divider drag the canvas, which is 100% of its pane, now only stretches, and
the camera takes the new aspect so proportions stay correct. The buffer is resized once on release. Measured at 2×,
the 60-move drag dropped from 2.1 s to 1.1 s with p95 frames of 17 ms, and `setSize` no longer appears during the drag.
`scene_3d.js` was overlaid on web, legacy and pool, and the served file matches.

## Follow-up: GPU-side resizing during drags — `c570b2c77754743b2ba8ecac67d883bf02d178d2`

The user still saw about a second of visible lag dragging the junction handle with Resources (around 20 photos and
a video) in the bottom pane. Headless and headed test browsers stayed at p95 17 ms, so the remaining cost is
GPU-side and does not show in main-thread timings.
- On every stage size change the resources viewer reallocated its photo canvas at device resolution and redrew the
  full photo (`project_resources.js` `resize`). During a drag its canvas now keeps its pixel size, so the stage shows
  more or less of it, and it resizes once on release.
- The 3D Tiles viewer (Cesium) kept rendering and resizing its canvas every frame, even behind another tab. A single
  switch, `firstMeasureSetPaneResizing`, now pauses its render loop for the drag and resumes it on release.

Checked headed at 2×: Cesium no longer appears in the drag profile, its loop resumes after release, and the canvas
returns to automatic sizing. Resource tests pass. Not yet confirmed on the user's own machine.

## Follow-up: no white flash on release — `f759aa3115f6ab02f0e04c994e3365d19b7282dd`

After the drag fixes, the 3D view sometimes flashed white for a few frames when a drag ended. The release resize
called `renderer.setSize`, which clears the WebGL buffer even when the size is unchanged, and the scene was redrawn
only on a later animation frame. That could be the next frame or, when idle, up to 100 ms later, depending on
callback order. `sync3DViewportSize` now resizes only when the size changed and draws in the same frame. Checked by
logging resize and redraw frame numbers: the old code redrew one frame after the resize, and the new code redraws
in the same frame and skips the resize when the size is unchanged. The served `scene_3d.js` contains the change,
merged with another session's live tooltip edit.
