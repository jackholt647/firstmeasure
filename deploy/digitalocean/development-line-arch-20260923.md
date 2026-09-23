# Development: arch existing lines

Code release: `0642b848b03dcfde922c86360839a39ead92b0d4`.
Baseline: `a9392d0d46c367e9e88d5960a6481cadd1f7e9d3`.

Five browser files change: `base_editor.js`, `base_sketch_editor.js`,
`exterior_geometry.js`, `wall_face_draft.js` and `wall_solid_geometry.js`.
The complete baseline includes the concurrently deployed experimental camera
work, DSM grade sampling, chimney heights and publication architecture.
Production is outside this release.

## Interaction and geometry

Select a straight line and press A, or use A / Arch line in the editing panel.
Move to preview and click interpolation points. Enter or A finishes the clicked
points; double-click places the last point and finishes. Escape cancels the
entire gesture. Each completed arch is one undo item. Clicking only on the
original line leaves it unchanged and creates no history item.

The endpoints remain fixed. A natural cubic spline interpolates the placed
points in chord order on the supporting face plane. Off-center points produce
an asymmetric curve. Snapping includes the chord midpoint, midpoints between
existing stations, reflected stations and heights, and nearby planar geometry
alignment. F toggles snapping during placement. Guide lines and point markers
show the active placement.

The spline definition is saved, transformed and sampled by the common geometry
kernel. Actual face rings, adjoining boundaries and editable draft graphs are
rewritten together; the old chord is removed. Window/door metadata becomes a
custom shape. Extrusion retains the spline definition for its curved sides.
Tessellation vertices are not presented as extra editable anchors, and surface
curve segments share one selection identity. Base and drawing-plane lines
share the same interpolation and snapping behavior.

## Verification

The expanded suite ran 1,084 tests: 1,082 passed and two existing curved-eave
extrusion regressions failed. Both failures were reproduced with the unchanged
committed geometry modules through an isolated module loader:

- `real house fillet crosses its finite eave without upright curtains or restored height`
- `saved failing outward extrusion removes all three eave curtains`

Those existing failures are not addressed by this feature. Two additional
targeted tests subsequently passed for a drawing-plane loose line and no-op
completion. All new arch cases pass, including the three finish paths, full
cancellation, one-step history, window metadata, generated draft ownership,
base boundaries, symmetry, off-center interpolation, snapping, persistence,
extrusion and tessellation selection.

Evidence: `output/arch-full-tests.log`, `output/arch-baseline-tests.log`,
`output/arch-targeted-ui.log` and `output/line-arch-20260923/`.

## Deployment

All three development roles activated and passed release identity, readiness
and outbound-isolation checks. Staging verified 24,496 unchanged public files
on web/compatibility and 24,510 on worker. The public site serves all five
changed scripts with exact committed hashes and reports the new release.
Worker activation required no running jobs; both PHP-serving roles refreshed
PHP-FPM. No saved project geometry was changed by deployment.

A separate authenticated browser tab was opened for a live interaction check.
It displayed the project loading screen, then browser snapshot and console
requests timed out. No live arch was placed or saved. The interactive finish
and cancellation checks above are automated handler tests, not a completed
manual full-house smoke check.

## Recovery

Keep the complete baseline installed. Roll back through the existing guarded
development activation procedure, including worker idle checks, readiness,
outbound isolation and PHP-FPM refresh on both PHP-serving roles. Older code
does not understand newly saved spline definitions: preserve such projects
and avoid editing them on the old release until the feature is restored.
