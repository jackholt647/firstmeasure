# Preserve repaired walls through foundation generation

Release: `af50a6f11117c9cd208d9d42c6af1efc43f75848`.
Baseline: `c7ad4a788c5dce86f62b1c10ff3ca52ff2d4d550`.

The saved roof reproduced a missing strip after From Roof. Gap repair initially filled the wall, but foundation tracing clustered nearby corners using the first endpoint as the geometry. This displaced the foundation boundary a few millimeters inward from the actual repair. The subsequent base-bound generation could not extrude that strip onto the foundation and reopened the hole.

Base tracing now uses clustered endpoints only for graph connectivity. It retains each wall edge's actual endpoint coordinates in the foundation perimeter, including short links between neighboring endpoints. Measured roof geometry is unchanged. One runtime file changes: `base_geometry.js`.

Validation: all 789 exterior regression tests passed. A geometry-only fixture of the saved roof verifies the repaired wall remains present and supported by the base, with zero final open wall gaps, at three rotations. The fixture is not mutated. A before/after side projection was rendered and visually inspected: the previously empty strip is filled.

The release merges the current exterior training baseline and stages a one-file guarded delta, preserving other runtime files, compiled backend, service overrides and access settings. Production and user project data are unchanged. Refresh and run From Roof to regenerate the saved exterior; From Roof replaces exterior edits and is undoable.

All three development roles activated successfully. 18,097 other runtime files verified unchanged per role. Public readiness and served base_geometry.js match the tested release. The 30 focused foundation tests also pass after merging the current baseline.
