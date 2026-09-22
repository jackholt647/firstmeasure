# Layered roof generation regression

The captured model-local fixture reproduces the September 22 interior chimney shaft, three roof-mounted turret shafts, narrow chimney-side roof panels, and open foundation corners. It contains no address or imagery location.

The construction engine now groups connected roof pitches into support layers. Flashing, chimney, eave, and rake boundaries separate layers. Downward generation recognizes near-coincident roof contact and a lower supporting roof beneath an upper roof's opening; a roof-material hole is not an empty shaft through the house. Embedded details below a higher roof body do not create interior ground walls. Exterior projections remain exposed.

For newly generated walls, measured flashing bounds the eave setback when it covers the source span. Narrow layers reduce the requested soffit to retain a one-foot minimum projected body width where the measured roof is wide enough. The fallback foundation fills known chimney roof notches before offsetting and retains the small lower roof footprints. Ground walls follow that same regularized boundary; upper walls retain their roof contact elevations. This reconciliation skips edited elevations and explicit foundation overrides. Deduplication of the reconciled boundary preserves its exact junctions instead of repeating survey alignment.

Chimney clipping uses a tolerance consistent with the polygon kernel's grid, avoiding seams where a rounded foundation point falls microscopically outside the chimney it touches. This remains much smaller than the editor's picking tolerance.

Validation: 807 passing tests across wall editing/construction, base/sketch geometry, kernel/replay, chimney, and extrusion suites. Eleven new regressions exercise the captured house at 0, 12, 18, 24 inches and Auto, rotated/translated coordinates, saved and inferred chimney outlines, minimum body width, interior/exterior termination, immutable inputs, deterministic regeneration, and edited foundation elevations.

The new behavior is enabled by From Roof generation. Existing saved editing state is not silently rebuilt on load. Regeneration is an undoable editor action.

## Chimney soffit follow-up

A collinear lower cap edge must not determine the entire upper eave setback after roof elevations have been flattened into a footprint. The variable offset keeps the deeper setback; separate narrow layers add their own smaller support footprints. A duplicate rake on a measured chimney edge is attached masonry, so it creates neither a free-edge source nor a side soffit. Contact matching checks finite extent and interpolated elevation, tolerating duplicated/reversed vertices without conflating different roof levels.

The updated suite passes 811 tests. Explicit support-to-masonry contact and main-eave depth assertions now supplement foundation closure, including rotated fixtures and 12-, 18-, and 24-inch presets. These assertions reproduce the remaining defects in the previous release.

## Roof-clipped walls and finite chimney occlusion

The next regression exposed two additional assumptions: a source pitch extrapolated beyond its finite hip face, and the unioned foundation hid chimney sides at every elevation. Generated ground-wall remnants are now replaced with their rebuilt perimeter, and final wall tops are clipped against the roof triangulation. Measured parallel flashing contacts within 2 cm align the generated footprint before union, eliminating overlapping near-coplanar wall panels while retaining genuine larger setbacks.

Automatic chimney exposure partitions each side at the actual building/roof surface planes and classifies the resulting regions at their own heights. Lower supporting bodies hide masonry only below their sloped roof. Near-boundary survey drift uses the same 2 mm roof contact tolerance; wholly internal chimneys remain roof-terminated. Exposed regions are unioned before panelization, and the rendered surfaces and wire retain that finite-height clipping. Edited/drafted wall fabric and explicit base overrides retain their existing path.

All 814 selected tests pass. Three regressions fail against the previous release and pass with the correction: generated top edges stay below roof triangles, near-coplanar wall panels do not overlap, and both chimney sides remain covered above all four lower caps at multiple heights/positions in the rendered triangle mesh. The historical rake-stage fixture explicitly uses legacy generation settings so it continues testing its original saved-state workflow.
