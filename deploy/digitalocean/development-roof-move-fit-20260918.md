# Development roof fitting for Move and Extrude — September 18, 2026

Runtime: `e35244102a4f7c6e8fc952287d9f5ee7b225b2b6`.
Baseline: `2d423723eea7289975173b05432b832a92ce71d6` (complete editor sync, training and skylight texture updates retained).

## Change

M continuously fits moved faces to roof surfaces and propagates lowered shared corners to connected walls. It retains Move connectivity rather than adding swept extrusion returns. Finite roof-edge snapping no longer rejects an otherwise valid snap because extrapolating that edge across the whole face intersects a different roof section.

Both tools preserve measured roof vertex heights when triangulating slightly nonplanar roof polygons. Under existing roof footprints they use the actual surface ceiling; conservative swept limits apply outside those footprints. This removes the artificial gap at the saved inside corner without introducing a trim allowance.

## Validation and deployment

- 842 local geometry/editor regression tests passed.
- 285 focused tests passed against the merged release on Windows and the staged Linux development release, including the saved inside corner, continuous M movement, connected neighbors, cancellation and skylight rendering regressions.
- A before/after side-elevation image of the saved corner confirms the cap reaches the measured eave.
- Three browser scripts changed: wall_editor.js, wall_face_draft.js and wall_solid_geometry.js.
- Staging verified hashes and 18,098 unchanged public files on each development role.
- All three development roles activated with readiness and outbound isolation checks. Experimental access and production are unchanged. No saved user geometry was modified.
- Served script hashes and public readiness checked after activation.

Refresh the editor to load the fix. Existing geometry is not automatically regenerated; the change applies to subsequent Move and Extrude operations with roof constraints enabled.
