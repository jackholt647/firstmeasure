# A delete only removes — development, October 20, 2026

Source `d5928a336bc48261b986d431fca3649d08681a55`.

**Report.** After pushing a plane-mode face inward to make a recess, the user deleted the line left across the
opening. A face refilled the opening, which looked like a floor. A triangle of points that had been deleted long
before reappeared on the opening's left corner. Ctrl+S then did nothing.

**Finding the state.** No server copy reproduced it. The editor prefers the browser's local wall backup over the server
copy when the backup is newer, and the user's work existed only there. Reading that backup in place showed the
state:
- plane-mode faces split the front wall;
- `plane-face-5`, a 5 mm sliver triangle, ran along the opening's bottom, because one corner was drawn 5 mm below the base;
- `$loose` held the old opening outline and a small triangle;
- the triangle's points were hidden in `$removedSurfacePoints`.

The geometry is in `dev/fixtures/recess-plane-sliver.json`.

**Root causes.**
- `removeFaceEdges` (`wall_solid_geometry.js`) marked the sliver invalid and repaired it by partitioning every wire on
  its plane, the loose outline included. Nothing kept the repaired face inside existing surface, so a 5.5 m² face
  refilled the opening.
- `restoreCreatedSurfaceWire` then treated that face as newly drawn. It removed hidden points from
  `$removedSurfacePoints` and rewrote `$loose`, which revived the triangle.
- A delete could therefore create area and reverse earlier deletions.
- Ctrl+S only clicks an enabled save button, and saves are queued. One save that never settled silently blocked every
  later save.

**Fix.**
- A repaired face is kept only inside faces that already covered its plane. Loose wire can divide that area but never
  create a face. Sticker fills keep following their own wire.
- A face that first appears from a merge or repair revives no hidden wire.
- `deleteLines3D` refuses, and rolls back, any delete whose merged or rebuilt faces would add area.
- A save that has not finished after 120 s fails with a message in the save banner. Pressing Ctrl+S during a save says
  a save is in progress.

**Not done.** Plane mode still lets a corner be drawn a few millimetres off the base, which creates the sliver. Deleting
such a sliver is now clean.

**Tests.** Four new tests in `dev/wall-face-draft.test.cjs` fail on the previous code and pass now. The wall and base
suites pass 1,274. The full suite passes 1,664, with 1 known failure (exterior-ai) and 1 load-dependent timeout
(resource media viewer, which passes alone).

**Rollout.** `wall_solid_geometry.js`, `wall_face_draft.js` and `main.js` were overlaid on web, legacy and pool. All roles
were verified and the served files match. The worker and production were not changed.
