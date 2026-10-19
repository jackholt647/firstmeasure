# Plane-mode stickers and arcs — development, October 19, 2026

Source `8b7f87c205fb1f769a2a3cb56b6c7de93df94205`, over `c316b63d` (live editor files were `180c64a0`). Three plane-mode
bugs with a door sticker whose angled top has an arched left half:

- Deleting the straight top-right door edge left the door filled and still a "3 x 8 ft" sticker. An opened sticker now
  stops being a face and keeps only its lines (and arch) on the plane; the wall around it is rebuilt from the remaining
  coplanar edges instead of disappearing. Arching a line in plane mode also no longer rewrites a consumed draft's
  boundary, which had resurrected a straight-topped region under the surfaces.
- Pasting the flipped copy of the arch to close the outline left the region empty. A plane paste whose wire closes an
  outline now makes that region a face (the same step plane drawing uses), so it can be clicked and typed with Shift+D.
  The arch can be copied before or after the edge delete.
- Deleting the arch's jamb end, control and apex left four tessellation samples as real points and two arc fragments.
  Deleting a curve's end or control now removes the whole curve and its samples from the wire.

Five regression tests in `dev/wall-face-draft.test.cjs` build the scenario with the editor's tools and fail on the
previous code. `node --test dev/*.test.cjs`: 1638 pass, 1 fail (the known exterior-ai Luna test), 2 skipped.

The rollout overlaid `wall_face_draft.js` and `wall_solid_geometry.js` onto the web, legacy and pool roles with
`output/plane-arcs-20261019/ship.sh`. All three roles verified release `8b7f87c2`, and the files served from
`dev.1m8.ai` contain the change. The worker and production were not changed. Not yet checked by hand in the browser.
