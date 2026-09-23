# Planar drawing and movement audit — September 23, 2026

## Reproduced failure

Draw a Q rectangle from a point on a slightly sloping wall top to the floor.
The right side crosses the old top edge, so partitioning creates an intersection.
The rendered faces refer to that intersection, while the stored construction edge
still references the original rectangle corner above it. Nudge moved the visible
intersection and bottom point without splitting the original construction edge.
Repartitioning then produced the diagonal from the moved bottom to the old top.
A flat rectangular-wall fixture did not expose this mismatch.

A separate containment check rejected nudges beyond the previous supporting
outline. The M route could convert regions into surfaces, changing which ownership
path the next nudge used. These were deterministic engine inconsistencies.

## Implemented ownership rules

- Before changing planar coordinates, node straight sketch edges at existing
  anchors and crossings and merge coincident segments. Preserve deliberate points,
  analytic curves and stable IDs for unchanged edges. Normalize only affected
  drafts, not the entire model or the selection/render path.
- Ordinary line movement within one live planar sketch uses the same graph edit
  for M and arrow keys. Rebuild face loops and outlines from that graph; do not
  manufacture independent replacement surfaces for an ordinary planar move.
- Shared geometry across owners, extrusion, curves and typed stickers keep their
  specialized operations. Their spatial line-result application also nodes the
  affected sketches before moving shared endpoints.
- The previous outline is an output, not a clipping boundary for general line or
  face editing. Ordinary face resizing no longer inherits sticker placement checks.
  Window/door placement continues to use its explicit feature constraints.
- Arrow keys during line movement apply an exact step and finish the operation.
  A preview returned to zero restores the original state and adds no undo entry.
  Escape restores both original geometry and the original selected edge.

## Audit coverage

Reviewed Q placement and source-point insertion, partition/resolve/rebind,
line and point selection representations, nudge dispatch, M previews/cycling,
feature resize, consumed-region synchronization, and commit/cancel paths.
Existing unbounded point/curve/Q tests, shared-wall tests and Shift-miss selection
checks remain part of the regression suite.

Added tests for the sloping-top Q reproduction in both arrow directions; M and
keyboard equivalence; exact undo snapshots; Escape and reload; twenty alternating
mouse/keyboard moves with stable point, edge and face counts; boundary expansion;
zero-displacement commit; and graph crossing/overlap normalization idempotence.
Two older tests now assert the resulting planar faces instead of requiring an
implementation-specific conversion to replacement surfaces.

Validation: 1,032 wall/roof/base/exterior tests pass. This is focused coverage of
these editing paths, not a claim that every possible geometry or tool sequence
has been proven. Existing unrelated curved-surface failures are documented in the
canonical handoff; this change does not claim to resolve those extrusion cases.

## Future changes must preserve

One graph owns each planar edit. Visible intersections must be connected editable
vertices before motion. Derived faces must not compete with their source graph.
Preview from an immutable source, preserve untouched owners, and restore the
original state on cancel. Test slightly sloped boundaries and repeated mixed-tool
sequences, not only axis-aligned rectangles or individual geometry functions.


## Geometry reconciliation follow-up

The earlier outline cleanup was incomplete: it simplified wire boundaries while
retaining the unsimplified source triangles. Extrusion and selection therefore
could read different shapes. This was a source-model inconsistency, not merely
line rendering or a keyboard focus problem.

Generated wall runs now reconcile source elevations before composition. Merged
strips use a planar union (including overlaps), and that region supplies both the
filled triangles and boundary edges. Protected wall junctions are inserted into
the union boundary. Disconnected regions receive separate valid loops; holes stay
holes. Unreferenced source stations are omitted from the derived geometry.
Original strips remain as provenance, not competing visible or editable faces.

Survey cleanup bounds total run deviation to 5 cm, retains protected junctions,
and preserves short physical corners. Long, nearly level eaves also reconcile
short steep noise stations. Deliberately edited source owners are excluded from
automatic coordinate correction. Repeated canonicalization is stable on both
18-inch and 24-inch captured-house fixtures.

Extrusion of a generated contact uses the same canonical rim. Near-planar roof
cutters are fitted to that established contact within the survey tolerance, so
old triangle stations do not reappear as thin extrusion returns. Source roof data
is not rewritten. Authored nonuniform profiles retain their exact outlines.
Real finite roof intersections still have their own clipping/continuation faces;
this is not a general assertion that all roof-adjacent extrusions have four sides.

Horizontal divider movement evaluates its endpoints against the wall's top and
bottom profiles. Crossing a peak detaches the old attachment without dragging the
peak, then nodes the divider into the destination segment. Mouse movement and
keyboard nudges return the actual moved endpoints to selection. Outside the
finite profile, existing free expansion remains available.

Regression coverage includes actual source elevations and mesh boundaries,
union area/no duplicate overlap, holes/disconnected regions, captured outward
extrusions at multiple depths, exact nonuniform extrusion, repeated divider
movement across a peak and sloping floor, mouse placement and cancel. Historical
face-count assertions were updated because disconnected regions now have valid
individual loops rather than one unordered point list. The old test requiring
ragged triangles was replaced with mesh/outline agreement; measured roof contact
uses the explicit 5 cm generation tolerance.

Previously committed custom extrusions are not regenerated or discarded on load.
The corrected generation applies to fresh From Roof output and unedited generated
owners. Retest old altered geometry from its pre-edit state to avoid retaining an
already committed bad extrusion.
