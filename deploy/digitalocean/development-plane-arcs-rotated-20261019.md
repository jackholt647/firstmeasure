# Plane-mode arcs on rotated walls — development, October 19, 2026

Source `10212b7a404303783e2603d45a8a409c5a7473cc`, over `0655b0a9`. Follow-up to
[plane-mode stickers and arcs](development-plane-arcs-20261019.md) (`8b7f87c2`).

Jack reported that pasting the flipped arc on the right side of the door top turned the existing left arc into about
eight selectable points, though it still drew as a curve and the face filled. Cause: the closing paste rebuilds the
faces with polygon booleans on the 1e-6 grid in the plane's own frame. On a wall that is not axis-aligned, mapping back
to world moved the untouched arc samples by about a micrometre. Their vertex keys no longer matched the arc's other
vertices, so the surface wire showed them as points. The earlier tests used an axis-aligned wall, where the round trip
is exact.

Faces rebuilt by a closing plane paste or drawing, plane subtraction and edge-delete merge or repair now restore the
exact source vertex (within 3 micrometres). The surface wire also snaps edge split points at deleted-edge intervals to
the edge or cut ends, which had left a second apex node. Curve ids and the arcs' defining points are unchanged.

Five new tests in `dev/wall-face-draft.test.cjs` run Jack's flow on walls at 0, 17, 30, 45 and 63 degrees and check
that both arcs keep their curve ids and only their defining points (11 points on the plane, 3 nodes in the pasted
arc's draft). The rotated cases fail on the previous code; a scratch sweep of 14 angles up to 347 degrees passed.
Two existing tests compared areas exactly or to 1e-6 against grid-quantized values; they now allow the source
vertices' floating-point noise (1e-9 and 1e-5). `node --test dev/*.test.cjs`: 1643 pass, 1 fail (the known
exterior-ai Luna test), 2 skipped. Both engine replays report no failures.

The rollout (`output/plane-arcs-rotated-20261019/ship.sh`) waited for another session's activation, then three-way
merged `wall_face_draft.js` and `wall_solid_geometry.js` onto the live release `61d391ce` (contact automations, from
another branch) on the web, legacy and pool roles. All three roles verified release `10212b7a`, and the files served
from `dev.1m8.ai` contain the change. The worker and production were not changed. Not checked by hand in the browser.
