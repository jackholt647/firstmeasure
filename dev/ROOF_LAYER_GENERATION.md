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
