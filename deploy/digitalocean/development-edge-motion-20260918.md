# Development measured edge motion — September 18, 2026

Runtime `8cc783db5112c7b2f9d085b9ebad5d46e9f254ec`; baseline `03616a26140b9013e34f28ca2046e79d69d013ae`.

Selected edge chains on several walls now use a common constrained motion axis when each edge can remain on its supporting wall. M and E expose the shared feet input and displacement measurements for every selected edge. Enter commits; Escape cancels. E preserves transverse neighboring edges by inserting connecting segments instead of dragging their endpoints diagonally. Parallel connections shorten normally. M retains ordinary connected-vertex movement. Wall edges remain independent of the base.

866 regression tests passed; the final distance-label/input adjustment also passed all 273 editor interaction tests. New tests exercise three wall bottoms plus an adjoining front face, real keyboard entry of 2 ft, exact 0.6096 m placement, displacement markers, front-edge preservation for E, ordinary M behavior, unchanged base geometry, cancellation and one undoable Enter commit.

Root files were updated only after confirming they matched the pre-change release source. The guarded two-file delta preserves all other development runtime files and checks release identity, readiness and outbound isolation on worker, web and compatibility hosts. Production is unchanged.

Refresh the editor, select the wall edges, press E, type 2 and press Enter to create the 2 ft step. M accepts the same input for a connected move.
