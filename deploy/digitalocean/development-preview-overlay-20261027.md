# Sticker hover overlay — development, October 27, 2026

Release `59112102` (parent `d4c4c5c8`), on development legacy and web. Three files in
`public/measure/internal/editor_scripts/`: `wall_face_draft.js`, `wall_editor.js` and `wall_mode.js`. Canonical
`codex/consolidated-firstmeasure-20260923` was fast-forwarded to it; branch `claude/sticker-snap-perf-20261027`.
This follows [the snap scene fix](development-sticker-snap-20261027.md).

**Problem.** After the snap scene fix, placing a sticker was still slow. Each pointer move rebuilt the whole 3D
scene and redrew the 2D plan, although the hover preview never changes the model.

**Change.**

- The draft draws the placement hover (sticker, its trim, outline, dimensions and alignment guides) in
  `drawFeatureOverlay`. Without an overlay host it stays part of `draw3D`, unchanged.
- Wall mode draws that hover as its own group (`exteriors-wall-overlay`) after every 3D rebuild. On a pointer
  move it asks for `redrawOverlay`: when the built scene is current (same scene and editing layer), only that
  group is replaced. Any other render request in the same frame turns it back into a normal render. Size, trim
  and rotate commands still redraw in full, because they refresh the placement panel.
- The overlay builds its guide targets and divider seams once per model. They are keyed by the same identities
  as the snap scene.

**Equivalence.** On the pilot house fixture, driven through the editor (24 hovers, 6 placements, trim on and
off): `draw3D` without the overlay host is identical to before, and `draw3D` plus the overlay hold exactly the
objects `draw3D` held before. Placements are identical. All non-browser `dev/*.test.cjs`: 1,789 of 1,792 pass,
1 fails and 2 did not run. The failure, `exterior-ai.test.cjs` (Luna), times out waiting for the AI tab, as on
the base.

**On dev** (Chrome, pilot house `exteriors_057d…`, Opaque view, window tool, the same 60-move sweep, Speed tab),
main-thread work per pointer move:

| | Before (`8e0aa10b`) | After |
| --- | ---: | ---: |
| 3D scene rebuild | 90 ms | — |
| 2D redraw | 88 ms | — |
| Sticker preview | 18.5 ms | 20 ms |
| Preview overlay | — | 2.7 ms |
| WebGL render (CPU) | 24 ms | 11.5 ms |
| Total | about 220 ms | about 34 ms |

The browser window used was not in front, so Chrome ran it at about one animation frame per second even when
idle. Its frame-rate figures (1–2 fps before and after) are not meaningful; the per-move work above is.

**Checked in the page.** Exactly one overlay group exists while hovering, and none once the pointer leaves the
house. The blue window preview and its gold guide draw under the pointer, and no preview mesh is left in the
main scene. Escape removes the overlay. Nothing was placed or saved in the project. The view was restored to
Textured and zoomed back out.

**Rollout.** `output/preview-overlay-20261027/`, with the same scripts as `sticker-snap-20261027`. Legacy and
web staged, activated and verified. Dev serves all three files with the release's hashes. Before the rollout,
dev served the base copy of each file.

**Not done.** Dragging an existing sticker (M) writes its preview into the model on each move, so it still
rebuilds the scene (and runs `prepareEdits`) per move.
