# From Roof survey stations — development, October 19, 2026

Source `220f7be0d519802f532eb6c626cb435d3c90dda9`.

After From Roof, straight eave and side runs showed load-bearing points at measured-roof survey stations; deleting one
broke the wall. The generated-station clean-up (0.05 m tolerance, 5° rule) ran only when every piece of a merged wall
was a plain perimeter strip. Walls continuing above a lower roof include flashing strips and were skipped.

`WallGeometry.surveyedGeneratedRun` now covers perimeter and flashing pieces with a generated source, excluding
chimneys. It is used for preview simplification, for station snapping (applied in every wall sharing the station) and
in draft construction (`ensure`). On the reported project (`fullhouse_ce52…`) this removes 7 straight-run load-bearing
points. Real corners, chimney points, junctions where another wall turns, user walls and existing drafts are unchanged.
The fix appears on the next From Roof.

Tests: full suite 1,647 pass, 2 skipped, 1 known failure (exterior-ai). New regressions are in `wall-geometry.test.cjs` and
`wall-face-draft.test.cjs`, using the fixture `dev/fixtures/flashing-survey-stations-roof.json` (geometry only).

Rollout: `wall_geometry.js` and `wall_face_draft.js` were overlaid onto `70770aae` on the web, legacy and pool roles. All
roles verified, and the served files match. The worker and production were not changed.
