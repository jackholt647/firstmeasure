# Face extrusion over sloped ground - October 8, 2026

The saved small face has a slanted side edge. Ground fitting changed a lower
corner of its extrusion return and produced a twisted quad, causing the plane
validator to reject the operation. Generated warped returns now triangulate
before clipping, keeping their boundary corners and the ground contact intact.
Planar returns remain unchanged; geometry validation remains enabled.

Validation: 48 geometry tests passed, plus an editor regression covering numeric
extrusion, cancellation and a single undoable commit. The saved face also passed
in its complete scene at -0.3, 0.3 and 1 metre. The regression verifies sealed
edges, valid faces, immutable source geometry and deterministic previews.
Evidence: output/face-extrusion-20261008/. Development verification pending.
No saved project data or runtime configuration changes.
