# Full-house production points

How a customer full-house (`exteriors_…`) report is timed and paid for the
drafter and QA. Decided by Jack on 2026-10-19.

## The model

A full house is drafted as a roof and its walls. When the drafter submits (the
first move into review, and again after a correction), the server scores the
completed model from the snapshot pinned to the reviewed PDF
(`updateStatusForSubmission` in `firstmeasure/api.ts`,
`firstmeasure/full_house_points.ts`):

- **Roof complexity** is the existing roof calculation
  (`firstMeasureComplexityForRoofSegments`, facet count to 1-5) applied to the
  drawn roof facets, with skylight and chimney faces left out as the PDF does.
- **Wall complexity** comes from `wallComplexityProxy`: windows, doors and wall
  planes, weighted and banded into 1-5. It is a stand-in that will be
  improved; replace that one function and bump `WALL_COMPLEXITY_PROXY_VERSION`.
- **Total points** = roof points + 2 × wall points (the usual 2/3/4/6/10 point
  table). When the walls score the same complexity as the roof, a full house is
  exactly 3× the same roof.
- **Project complexity** is the 1-5 level whose full-house total is nearest
  the computed total (ties go up).

The result is written to the manifest as `complexity`, `point_value` and a
`point_calculation` with `mode: "full_house"` that records every count and
parameter. `point_value` is what everything else reads, so the drafter's
allotted time (18 min per point), pay bands (₱19/16/13/10 per point, ₱5 after
time), earnings, payroll, the staff Production Timing panel, QA ranking and QA
shift points all use the one total. Parameters live in
`FULL_HOUSE_POINTS_DEFAULTS`.

## What the drafter sees

While drafting a full-house job, the editor header shows only the elapsed
stopwatch: no allotted-time bar, band tooltip, rush pill or rush toast
(`firstMeasureHidesPayWhileDrafting` in `editor.php`). After the submit is
accepted, the editor reads the scored manifest back and the post-submit modal
shows the complexity, points, rate and earnings. Staff see no Production Timing
for a full-house job until it is first submitted. Roof jobs are unchanged.

## Why this is not a platform pay rule

Drafter and QA pay is FirstMeasure's own production-points system: the editor,
the internal earnings and payroll pages and QA shifts all derive time and pay
from `point_value`. Platform [pay rules](pay-rules.md) pay assignees of
organization projects from published data and do not read FirstMeasure
production work yet. Scoring a full house is a change to how points are
assigned, so it stays in the points system; moving drafter pay onto pay rules
would be a separate migration of every consumer above.

## Known gaps

- A manager's complexity override (`firstmeasure_node.php`) sets the point
  value from the roof table, so overriding a full house's complexity drops it
  to roof points.
