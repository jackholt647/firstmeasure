# Exterior editor performance — September 16, 2026

## Findings and changes

The editing path performs synchronous geometry work, then rebuilds the 2D and
3D presentation. Idle camera rendering does not pay those reconstruction costs.
That explains why an idle model can be fast while moving or deleting stalls.

This pass addresses measured redundant work without weakening topology checks:

- Editor redraw requests share one animation-frame callback. A commit upgrades
  an already pending preview redraw to a full UI refresh. Geometry and undo
  commits still happen synchronously; no intermediate edit becomes authoritative.
- 2D and 3D redraws share the composed wall snapshot. Ground-gap detection is
  invalidated by wall/ground contents, not a newly allocated array with identical
  contents. Sticker-only changes no longer invalidate the ground-gap result.
- Opening cuts use a conservative 3D grid before exact coplanarity and polygon
  subtraction. Long/large queries fall back to scanning all openings. A bounded
  512-entry cache reuses identical local polygon differences. Each output still
  receives the current face metadata and current world transform.
- Unchanged draft structural boundaries are reused by content, including all
  draft fields. This works across preview copies and undo, and cannot hide an
  in-place coordinate mutation. The cache is bounded at 512 draft entries.
- Dimension labels share textures by text and selection style. Sprite materials
  remain independent. Reference counting prevents disposal of a live texture;
  unused entries are evicted above 256. Generic scene disposal respects this
  explicitly shared texture ownership.
- Wire endpoint lookups use maps. Point/segment contact searches use sorted-axis
  range queries followed by the unchanged exact contact test, replacing repeated
  scans of all model points.
- Interior-point deletion avoids polygon unions for planes that do not touch
  any deleted point. Load-bearing and face-area checks still run where relevant.

## Reproduction and measurements

Run from the repository root:

```powershell
node dev/exterior-edit-performance.cjs
node dev/exterior-edit-performance.cjs C:/path/to/exported-editor-state.json
```

The benchmark uses real geometry/editor routines with stub render objects.
It excludes DOM, WebGL uploads/draw calls, browser storage, and WallMode history.
Numbers below are CPU timings, **not end-to-end browser FPS**. Runs use two
warmups followed by medians; timings depend on machine and JIT state.

Synthetic coplanar sections spaced eight metres apart, one window per section:

| Walls/windows | Previous opening algorithm | Indexed/cached path | Candidate pairs |
| --- | ---: | ---: | ---: |
| 20 / 20 | 6.8 ms | 0.7 ms | 400 → 20 |
| 100 / 100 | 351.6 ms | 1.2 ms | 10,000 → 100 |
| 1,000 / 1,000 | Not run | 8.1 ms | 1,000,000 → 1,000 |

The reference implementation is included in the benchmark. These results measure
opening cuts, not all rendering. Dense overlapping geometry will yield more
candidates, as required for correct intersections.

User's locally saved snapshot: 51 collected editable faces, 586 unbatched stub
render objects. Warm median editor 3D preparation: 26.0 ms; numeric sticker
movement geometry: 4.2 ms; point-deletion geometry: 41.9 ms. The snapshot stays
outside the repository. These operations are exercised on disposable copies.

## Validation and remaining costs

724 relevant tests passed across walls, base geometry, opening area/reporting,
trim, curves, snapping, selection/undo, and deletion. New regressions cover
conservative index queries, opening-cache invalidation, redraw coalescing,
shared-label lifetime, and exact point-contact candidate preservation.

This is not a claim that arbitrary large structures now sustain 60 FPS. The
editor still rebuilds scene objects and 2D DOM, copies full edit snapshots,
and performs synchronous validation. Even the measured 26 ms CPU preparation
exceeds a 16.7 ms frame budget before GPU work. The next architectural step is
retained per-face rendering with dirty-region updates; benchmark that together
with real browser traces before choosing worker boundaries. Workers should
receive immutable snapshots with revision IDs and discard stale results, while
undo and authoritative commits remain ordered. Deferring destructive validation
without that protocol could reintroduce geometry corruption.

The local port-8031 sandbox serves canonical editor assets through its existing
allowlist. Its separate `scene_3d.js` received only the shared-label disposal guard;
the same guard is in canonical source. No project geometry or production service
was changed.


## Persistent rendering and frame scheduling (2026-09-17)

Wall redraw now explicitly invalidates the shared renderer. Previously wall mode
returned before the roof renderer set its dirty flag, leaving edits dependent on
the 100 ms idle refresh. The new latest-input queue runs pointer preview before
view preparation and WebGL drawing in the same animation frame. Commit flushes
pending input; clearing tools cancels it, and project transitions clear old tools.

`exterior_scene_cache.js` retains unchanged face and batched wire render objects.
Changed faces, openings and selection rebuild from existing geometry routines.
The cache transaction returns reused objects to the previous scene on failure;
only obsolete objects are disposed. Grouped sticker divisions deliberately use
the existing rendering path because their trim ownership spans sections.
Textured rendering similarly retains unchanged presentation parts and lights,
including shadow-map resources. Authoritative geometry and undo remain ordered
and synchronous; this change does not defer correctness checks or add workers.

Validation includes actual WebGL comparison against full rebuilding while moving
one of 20 windows, switching opacity and cancelling. At least 19 unaffected
window parts persist between movement samples. Geometry and opening cuts match
the full-rebuild reference. Textured scene creation and 4K export also pass.
Synthetic timings are noisy and are not a claimed user-project FPS improvement.
The localhost smoke check on this run could not connect: port 8031 refused the
connection. The existing sandbox asset allowlist and template include both new
modules, ready for its runtime to restart. No project data was saved.

## Draw memos (2026-10-19)

Most wall-mode redraws draw an unchanged model: selection and hover changes, a
preview pointer move that lands on the same result, and the second view of every
frame. The drafting editor's render cache (`beginRenderCache`) already keyed
derived topology by the serialized state, walls and visibility. `draw2D` and
`draw3D` now keep their per-face derivations in that same generation:

- each solid's drawn parts (chimney clipping, opening cuts, closed-soffit
  presentation) and each draft face's 3D parts;
- support classification and marker keys of wire and draft edges and points;
- the draft nodes shown, keyed by that draft's picked ids;
- draft visibility, inner regions and wall ownership.

Chimney clipping of a surface is computed once per generation and shared by the
wire graph, the support faces and the solid drawing; its readers never write to it.

Invalidation: any change to the serialized state, walls or visibility starts a new
generation; entries are keyed by the identity of the state object and of the face,
node, edge or draft they describe, so an equal-valued replacement is recomputed,
never substituted; 3D parts are also keyed by the features and closed-soffit panels
read before the key. Draw memos apply only inside draw passes; picking and edits
recompute. `window.EXTERIOR_DISABLE_DRAW_MEMO = true` turns them off. Also exact:
the selection is resolved once per draw pass, a division index with no seams
answers without building grid keys, and `draw3D` collects features once for seams
and openings.

`dev/wall-face-draft-draw-memo.test.cjs` compares SVG calls, 3D objects (geometry,
materials, userData, persistent-part reuse) and state frame by frame, memos on
against off and against the editor before this change, over saved houses, and
freezes shared chimney parts. A browser capture of the real editors on three saved
projects matched the earlier editor at every one of 223 interaction steps.

On the 420 KB saved house (real Chrome), face-draft `draw3D` fell from about 775 to
595 ms and `drawSolids` from about 410 to 200 ms over a 70-frame move preview;
selection clicks no longer produce long tasks. Frames whose model changed still
rebuild everything. Remaining costs are listed in the optimization backlog
(`docs/optimization-backlog.md`, wall drafting entries).

## Preview interaction (2026-10-19)

Pointer-move previews (line move and extrude, point and line entity tools, face
extrude and move, geometry move and rotate, arrow nudges) now do less work per
frame and return exactly what they returned before:

- `copy` in `wall_face_draft.js` and `exterior_model.js` is an exact clone of
  the JSON round trip without the text (same keys and order, -0 becomes 0,
  non-finite numbers become null, dropped members, nothing shared). Anything
  that is not plain data takes the JSON round trip itself, including its
  errors. About 5 times faster.
- Previews copy the gesture's edits once: `copyWithDrafts` skips the drafts a
  preview replaces at once, line slides share the members of their private
  snapshot that nothing changes in place (`shareWithDrafts`), and entity
  previews no longer copy edits that are immediately replaced.
- Snap candidates for line moves and line extrusions across a face are built
  once per line, axis and face, as the other tools already did. `motionSnap`
  does not project candidates already beyond the radius by distance alone and
  projects each start point once per call (a large drop in
  `getBoundingClientRect` calls).
- `vertexKey` and `edgeKey` build the same strings without temporary arrays.
  `jsonEqual` answers `JSON.stringify(a)===JSON.stringify(b)` without
  building the strings; `validateEdits` compares prior surfaces on demand when
  the caller guarantees nothing is shared with them.
- Bounding boxes skip exact contact tests that cannot pass (`contactBox`),
  keeping every remaining test and its order: base binding, line slides,
  trim-following bindings, geometry transforms and draft-node moves. Move
  lookups by vertex key are indexed.
- Arrow nudges no longer build the wire graph unless solid edges are selected.

`dev/exterior-preview-equivalence.test.cjs` proves the equivalence: pure
helpers against their reference definitions, and every editor gesture run in
a current and a reference build (each shortcut textually reverted), comparing
state, history, selection, message and drawn preview after every step,
including -0, undefined keys and shared references. Set
`PREVIEW_EQUIVALENCE_MODELS` to add saved houses and
`PREVIEW_EQUIVALENCE_BASE` to compare against a commit.

On the 420 KB benchmark house (CPU only, no rendering, median of three), line
move previews went from about 17 to 8 ms, line extrusions from 27 to 16 ms,
point moves from 15 to 7 ms and arrow nudges of a line from 34 to 18 ms. Face
moves, geometry moves past a valid limit and the remaining copies are listed
in docs/optimization-backlog.md.
