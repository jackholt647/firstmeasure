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
