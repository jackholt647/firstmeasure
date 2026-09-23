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
