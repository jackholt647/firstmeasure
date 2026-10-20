# Full-house editor fixes — development, October 19-20, 2026

Three overlays of `public/measure/internal/editor_scripts` onto the web, legacy and pool roles. Each was verified on
every role and the served files match. The worker and production were not changed.

## Resoffit dropdown — `9e823e5904552952e3b122c1b5181d039efeb281`

Resoffit now behaves as a dropdown.
- A successful Apply closes it.
- A press anywhere outside it closes it and selects normally. The exceptions are a roof-contact line in the 3D view
  (the press toggles that line) and the camera controls.
- Files: `wall_mode.js`, `wall_editor.js`, `wall_face_draft.js` (`resoffitHit`).

## Base pitch on leaning walls — `d7c5eaaf5da955134c98dd8033a53fdde6155416`

Base pitch (Y) is now applied on houses with walls that lean slightly.
- Cause: following a pitched base moved the wall bottom points vertically. On walls leaning by about 0.2 mm this left the
  walls non-planar, so every render after the edit threw ("A face must remain on its supporting plane").
- Fix: `WallBaseBinding.face` slides followed points horizontally back onto the wall plane and keeps the base height.
- A pitch that puts the base above a wall top is still refused, with a message.
- Test: `dev/base-pitch-lean.test.cjs`, with the fixture from project ce52.

## Recess extrusion and line delete — `58249cdc22395083c33017fca8da2775e31c4901`

Pushing a wall region in now makes a recess: side walls, a ceiling, no floor, and the base pulled back.
- Cause: hosted wall patches got returns only along edges another face shared, and the base was never checked. A
  0.24 mm sliver under the region produced a floor, and the unshared top edge got no ceiling.
- Fix: `W.extrude` skips edges that rest on the base. A new `hostedPatch` option closes every other edge except a
  downward threshold, so door thresholds stay open. `createExtrusion` sets it for regions of a coplanar wall.

Delete on a line no longer removes a neighbouring wall the line overlaps by a sub-millimetre sliver.
- Cause: `removeFaceEdges` counted a face as owning the line on any overlap above 1e-6 of its length. It then
  invalidated the face and could not rebuild it.
- Fix: a face must run along the line for at least 1 mm (or half the line).

Tests: full suite 1,660 pass, with 1 known failure (exterior-ai Luna).
