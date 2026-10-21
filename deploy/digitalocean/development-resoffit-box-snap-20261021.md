# Resoffit box select and exact snapping — development, October 21, 2026

Source `0a3a740d1de4833e03c00b531b1e8010034ea3dc`.

**Resoffit select mode.**
- While the Resoffit menu is open, a drag in the 3D view adds every roof-contact line the box touches; a line does not
  have to be fully inside. Ctrl+drag removes lines. A click still toggles one line.
- Only roof-contact lines can be selected.
- Opening the menu keeps the roof-contact lines that were already selected.
- Presses in the views no longer close the menu. Done, the Resoffit button, a successful Apply, Escape or a press
  elsewhere in the toolbars closes it.
- `startBox` marks the editor's real press path as a Resoffit box. A headless browser on the pilot copy selected 38 lines
  with one drag.

**A near-level grade is exactly level.** `ground_geometry.js`: a DSM/USGS grade plane within `LEVEL_SLOPE` (0.5% rise,
about 0.3°) is placed exactly level at its average height. This covers both `reference()` (every grade commit) and the
initial DSM fit. A base regrounded on it is level.

**Plane-mode corners land exactly on what they nearly touch.** `wall_solid_geometry.js` `PLANE_CONFORM` and
`conformPlanePoints`, applied by `wall_face_draft.js` on every plane-mode commit (click, typed lengths, Q quad, N, C/U,
move, nudge and paste):
- a new vertex within 1 cm of an existing vertex snaps to it; otherwise one within 1 cm of an edge moves onto that edge;
- a side that is nearly collinear with an edge it touches is brought onto it;
- free move (F) turns this off, like the other snaps.

This removes the millimetre slivers that a pushed opening left against a slightly sloped base.

**Tests.** New tests in `dev/wall-face-draft.test.cjs` and `dev/ground-geometry.test.cjs` fail on the previous code and
pass now. The related suites pass 699. The full suite passes apart from the known exterior-ai failure.

**Rollout.** `wall_face_draft.js`, `wall_mode.js`, `ground_geometry.js` and `wall_solid_geometry.js` were overlaid on web,
legacy and pool. All roles verified, and the served files match. The worker and production were not changed.
