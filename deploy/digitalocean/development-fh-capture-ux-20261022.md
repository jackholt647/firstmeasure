# Full-house capture: photo intro layout, Next starts capture, structure pills — development, October 22, 2026

Release `862b17d58083638ce0cebe9cc6b8b2693e2d5dbf` (parent `559a1782`).

**Changes (mobile full-house ordering).**
- Order from photos uses the orbital intro's full-height layout. Title, text and animation stay at the top. The two
  steps and the footage warning are spread evenly in the middle. Start and the switch link are anchored at the
  bottom, in the same place as on the orbital intro.
- On either intro the pager's Next is enabled and starts recording, or starts the eight photos. Back from Order from
  photos returns to the orbital video intro it was opened from, and a second Back leaves the capture step.
- Pills replace the structure dropdown, which also had a clipped focus border. The selected structure drives both the
  diagram and the angle groups, so only one structure is listed at a time.
- On mobile summaries, the Additional photos and videos button is a 68 px bar docked above Back/Next (the old drop
  was 170 px). Its tiles now follow the angle groups.
- Copy:
  - shorter orbital intro;
  - new photo intro, step two ("Anything hard to see?") and footage warning;
  - Structure N instead of House N;
  - no STREET label in either orbit animation;
  - no "per structure + selected delivery fee" line under Delivery.
- Reworded strings use new catalog keys. English shows the new text, and other languages show it in English until
  the catalogs are rebuilt.

**Tests.**
- `exteriors-guided-camera` passes 19/19, including a new pills/docked-bar case.
- `orbital-intro-layout` now also measures the photo intro at five sizes: even gaps, no scroll, bottom anchored.
- `exteriors-orbital-video` has updated House→Structure and Back/Next assertions.
- Two failures predate this change and also fail on the parent commit: "Orbital video2 segments" in
  `exteriors-orbital-video` and the pin-confirmation case in `exteriors-photo-workflow`.

**Rollout.** `exteriors.js`, `project-request/app.js` and the apps manifest were overlaid on legacy, web and pool,
which were all on `60552c1d`. On each host, `app.js` was three-way merged and the manifest got only the new
project-request cache key (`20261022-fh-capture-pager-v1`). Verify passed, and dev serves the new files. Scripts:
`output/fh-capture-ux-20261022/`.
