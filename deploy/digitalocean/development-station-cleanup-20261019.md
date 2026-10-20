# Survey-station clean-up on every rebuild — development, October 19, 2026

Source `600d2b2138b20275e03c24b601b8a0009ea567f9`.

After From Roof, Resoffit brought back load-bearing points across the model. It rebuilt wall drafts from the raw
measured-roof outline, so survey stations came back. Junction protection also counted every shared station as a
junction, so the cleanup kept them.

`WallGeometry` now has one cleanup step (`cleanSurveyRings`, `cleanSurveyedFaces`, `generatedGroupOutline`), built on a
shared boundary graph. A point is a junction only where the walls turn or where more than two edges meet. Draft
construction (`ensure`) and `applyLineResult` (Resoffit, Wallless, line moves, nudges and their previews) all use it.
Straight stations no longer become source splits. Closed-soffit panels join across dropped stations.

Audit of the other rebuild paths: they already applied the cleanup or never see generated stations. Two rare paths were
left alone because nothing had failed: the chimney cleanup sub-merge and the gap-repair groups.

Known leftovers:
- Drafts saved before this release keep their stations until rebuilt.
- A second Resoffit of the whole turret cluster with closed soffits still fails with "These soffits cannot meet".
  This also happens on the previous release.

Tests: suites touched 679 pass, full suite 1,654/1,657 with only the known exterior-ai failure. New regressions in
`wall-geometry`, `wall-face-draft` and `wall-closed-soffits` tests, using `dev/fixtures/ce52-from-roof-walls.json`
(geometry only).

Rollout: the three editor scripts were overlaid on web, legacy and pool. All roles were verified and the served files
match. The worker and production were not changed.
