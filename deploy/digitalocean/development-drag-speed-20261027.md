# Sticker drag speed-ups — development, October 27, 2026

Release `b49fedfb` (parent `1f89dada`), on development legacy and web. Three files in
`public/measure/internal/editor_scripts/`: `wall_chimneys.js`, `wall_mode.js` and `wall_face_draft.js`.
Canonical `codex/consolidated-firstmeasure-20260923` was fast-forwarded to it; branch
`claude/sticker-snap-perf-20261027`. This follows [the hover overlay](development-preview-overlay-20261027.md).

**Scope.** Jack chose to keep the drag exact: the wall is re-cut live while a placed sticker is dragged (M). So the
model is still republished on every move, and these changes only remove repeated work.

- **Chimney contact fits.** `alignRoofContacts` (run by `prepareEdits` on every move) keeps each point's fit while
  the chimney definitions and roof faces are equal by value (`fitMemo`, bounded at 200,000 points). Pilot house,
  Node: 6.2 to 1.1 ms per pass. Output is identical on all nine chimney fixtures, including runs that reuse fits
  across fixtures and runs with moved draft points (51/51).
- **Passive 2D plan.** While a gesture runs in the 3D view, the 2D plan is a passive pane. It redrew every 100 ms
  even though one redraw costs about 140 ms on the pilot house, so it held most of the main thread. It now waits at
  least `PASSIVE_2D_SHARE` (4) times its own last cost (never under 100 ms), so it takes at most about a quarter of
  the gesture's time, and it still redraws once more when the gesture ends. This changes how often the side pane
  updates during a drag, not what it shows.
- **Rollback.** A failed slide move restores the published edits it replaced, instead of a deep copy taken
  beforehand on every move. The replaced object is never modified.

**Equivalence.** On the pilot house fixture, placements, hover previews and 51 drag steps in three move modes
compare identical before and after. All non-browser `dev/*.test.cjs`: 1,788 of 1,792 pass, 2 fail and 2 did not
run. The failures were `exterior-ai.test.cjs` (Luna), which fails on the base too, and
`resource-media-viewer.test.cjs`, which timed out under load and passes on its own. `wall-face-draft`,
`wall-mode` and `wall-chimneys`: 715/715.

**On dev** (Chrome, pilot house `exteriors_057d…`, Opaque view, dormer window `R92:1:roof-2`, Free on face, the
same 40-move drag, Speed tab), per move:

| | Before (`1f89dada`) | After |
| --- | ---: | ---: |
| Sticker move preview | 32.6 ms | 13.6 ms |
| Compose walls | 58 ms | 40 ms |
| 3D scene rebuild | 80 ms | 87 ms |
| 2D redraw | 141 ms, every move | 138 ms per redraw |

The browser window used ran at about one animation frame per second (it was not in front), so the 2D pane still
redrew on every move there. In a normal window it now redraws about every 0.55 s during a drag instead of every
0.1 s. Before, every move paid for all of it: about 266 ms (2D 141 including composition, 3D 80, preview 33,
WebGL 12). After, in a normal window, a move without a 2D redraw costs about 140 ms (3D 71, composition 40,
preview 14, WebGL 14), and the 2D redraw adds about 35 ms per move on average: roughly 175 ms, or 1.5x faster.
This is an estimate from the measured parts, not a measured frame rate. The drag was checked visually: the window moves within the
dormer with its handle and dimension, and Escape restores it. Nothing was saved, and the view was restored to
Textured.

**Remaining.** Each drag move still recomposes the walls (the composition key includes every draft face's
points when the house has chimneys) and rebuilds the whole 3D scene. Making those incremental means caching
per-draft geometry across model versions, where chimney visibility and structural support depend on every draft.

**Rollout.** `output/drag-speed-20261027/`, the same scripts as `preview-overlay-20261027`. Legacy and web staged,
activated and verified, and dev serves all three files with the release's hashes.
