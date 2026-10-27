# Sticker placement snap scene — development, October 27, 2026

Release `8e0aa10b` (parent `67d09079`), on development legacy and web. Two files:
`public/measure/internal/editor_scripts/wall_face_draft.js` and `wall_chimneys.js`. Canonical
`codex/consolidated-firstmeasure-20260923` was fast-forwarded to it; branch `claude/sticker-snap-perf-20261027`.

**Problem.** Placing windows lagged, and got worse with every sticker placed. On each pointer move the hover
preview copied the model, materialized every wall draft, then rebuilt the whole house's snap scene: every
draft's edges, the wire graph, chimney visibility and the support faces (`sceneLines()` runs outside the render
cache, so nothing was reused). Retained draft points could also rebuild the support faces once per generated
boundary point (chimney drafts).

**Change.** Results are unchanged; only repeated work is gone.

- The placement hover keeps its snap scene (`stickerSnapScene`) for the gesture, keyed by the identities of the
  state, the wall edits it was built from, the composed walls, and roof, wall, closed-soffit and base visibility.
  Placement itself (`live`) still builds it fresh.
- `moveScene` answers every retained point from one support snapshot and index.
- A face slide (moving a sticker with M) builds its snap targets once per move frame, for both the move and the
  guide drawing (`faceSlideTargets`).
- `alignRoofContacts` (run by `prepareEdits` on every drag preview) fits each exact corner position once per pass;
  a fitted point is still a new object, as before.

**Equivalence.** On the pilot house fixture (`dev/fixtures/pilot-arched-garage-doors.json`), driven through the
editor with 10 windows placed (some with trim): all 50 hover previews (outline and snap targets), every
placement's saved state and 51 drag steps in three move modes are byte-identical before and after.
`alignRoofContacts` output is identical on all nine chimney fixtures.

**Speed.** Node, same fixture, per pointer move:

| | Before | After |
| --- | ---: | ---: |
| Placing, 2 / 8 / 13 windows | 70 / 87 / 124 ms | 4.5 / 4.4 / 6.8 ms |
| Dragging a window | 54 ms | 35 ms |

On dev in Chrome (pilot house `exteriors_057d…`, Opaque view, window tool, the same 60-move sweep, Speed tab):
"Sticker preview" fell from 49.1 ms to 7.8 ms per move and the snap scene is no longer rebuilt (it was 88 ms
each time it ran). Frame rate did not improve much: each hover move also runs a full "3D scene rebuild"
(64–92 ms) and "2D redraw" (67–77 ms), now the main cost. Nothing was placed or saved in the project.

**Tests.** All non-browser `dev/*.test.cjs`: 1,789 of 1,792 pass, 1 fails and 2 did not run. The failure,
`exterior-ai.test.cjs` "one Luna request…", times out waiting for the AI tab and fails the same way on `67d09079`.

**Rollout.** `output/sticker-snap-20261027/`, copied from `fh-trim-20261023`. Legacy's releases now live in
`/opt/firstmeasure/frontend-releases`. The first stage failed before anything was activated ("Hardlink staging
must share baseline filesystem"). The retry used `mvp-platform-20261024`'s `deploy.py` and stages beside the
active release (`current_path`'s parent). Legacy and web staged, activated and verified. Dev serves both files
with the release's hashes. No cache bump: editor scripts are versioned by content hash. The worker serves no
editor files. The live layer does not cover `/measure/internal/` (dev serves it from the release only).

**Not done.** A hover preview that leaves the model unchanged still redraws the whole 2D and 3D scene. Until
that is fixed, placement on a large house still runs at a few frames per second in the browser.
