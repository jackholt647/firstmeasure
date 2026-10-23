# Exterior roof rebuild

A change to the roof after wall work has started must keep the wall work. Switching back to wall
mode after a roof edit follows the change: it works out which roof lines changed, changes only the
walls those lines drive, carries their edits along and reports what it could not keep. Nothing is
regenerated wholesale unless the person asks for it with **From Roof**.

Code: `public/measure/internal/editor_scripts/wall_roof_rebuild.js` (pure, testable in node), wired
in by `smartRebuild` in `wall_mode.js`. Tests: `dev/wall-roof-rebuild.test.cjs`, on the house the dev
pilot was drawn from (`dev/fixtures/ce52-roof-rebuild.json`).

## What happened before

- `rebuildForRoofChange` (`wall_mode.js`) compared `roofSignature()` with the signature stored when
  the walls were built. On any difference it ran `generate()`, which replaces the whole wall state:
  every stage list, the chimneys and all of `wallEdits` (drafted faces, windows, doors, stickers,
  extrusions, loose lines, base edits). When there were edits it asked first; the only choices were
  "discard everything" or "keep the stale walls".
- The roof signature includes every point, every line type and the face outlines, so retyping two
  cricket lines from rake to valley, or nudging one flashing line, counted the same as a new roof.
- Edits are keyed by generated wall ids. Those ids came from array positions: a roof line's source
  is `R<index+1>` (`wall_geometry.js`, `buildSources`), a wall is `<source>:<piece>` (`extrude`), and
  walls reconciled with the base are `envelope-<layer>-<face>-<edge>` numbered in order along a base
  edge. Deleting or adding a roof line renumbered every later line; a moved line could renumber the
  pieces next to it. Nothing related a wall before the change to the same wall after it.
- Chimney ids are built from roof line indices (`roof-chimney-29-30-…`, `wall_chimneys.js`
  `detect`), so they shared the same weakness.
- Roof trim is the roof's (`roof_trim.js`) and is keyed by the ends of each panel; it already
  followed the line types. It was never the problem, but a moved line lost its trim settings.

## The snapshot

`state.roof` is the roof the walls were built from (metric points, typed connections, resolved
faces). It is the snapshot; it is replaced only when walls are rebuilt or followed. When the person
leaves wall mode, `rememberRoofIdentity` also records which of the editor's point and line objects
are which `state.roof` point and line (a `WeakMap`, only when the stored signature still matches).
Dragging a point or changing a line type keeps those objects, so on return the editor knows a moved
line is the same line even when it moved far. Undo in roof mode can replace the objects; then the
geometric matching below decides.

Roof metres are measured from the image centre. When the project's image is centred elsewhere than
the one the walls were built in (`state.context`; the dev pilot's drawing was copied from another
project 25 cm away), the captured roof is first moved into the walls' frame, the same offset
`toPixel` applies when drawing the walls.

## Identity and classification (`identify`)

On return to wall mode the captured roof is compared with `state.roof`:

1. Points: the recorded objects, then unchanged positions (under 0.1 mm).
2. Lines: the recorded objects; then lines whose two ends are known points (the same type first, as
   a ridge can run over a head wall between the same two points); then geometry: a line that kept
   one end and its direction, or a parallel line that overlaps it within 2 m, is the same line
   moved. A moved line's ends are the same points, moved.
3. Each line is **unchanged**, **type** (same place, new type), **moved** (with or without a new
   type), **added** or **removed**. Faces are **unchanged** (same outline), **changed** (a face that
   covers the same place) or **added**/**removed**.

The new roof is rebuilt in the old order with stable ids: every known line keeps its id (`R<n>`,
carried on the connection as `id`; `buildSources` uses `c.id` before the index), new lines get ids
no earlier roof used, faces keep their ids. So a wall driven by line X before is driven by X after,
and its id is unchanged.

## Following the walls (`rebuild`, `diffWalls`, `patchWalls`)

The generator runs twice in the edit-free context From Roof uses (`freshStages`: the current base,
grade, options and chimneys, no wall edits): once on the old roof and once on the new one. Anything
that differs between the two runs is the roof change, and only that is applied to the walls as
they are now: `current + (new − old)` vertex by vertex, metadata likewise. A wall the generator no
longer knows (an older regrade piece) follows its parent wall or is kept.

Walls are paired by place, not only by id, because a change can renumber pieces it did not move:
identical walls pair first (their own id preferred), then walls of the same roof line that overlap
where they stand. A paired wall keeps the old id. Differences under a micron are noise between the
two runs. Results: walls kept as they were, **moved** (same id, new place), **removed**, **added**
(new ids, never an id that carried someone else's edits).

## Carrying the edits (`carry`)

- **Drafted faces** (`$drafts` with members) follow their walls through the editor's own follow,
  `wall_face_draft.js` `reflow`, the code plane-move (M) uses. For a wall that turned or moved off
  its plane the face frame is first turned about the end that moved least and shifted along the new
  normal; `reflow` then stretches the outline to the new ends. Windows, doors and stickers keep
  their place along the wall and their height.
- A face whose walls now move differently (the upper part followed a flashing, the lower part
  stands on the base) **splits**: each part keeps the walls that moved together and the sketch
  points and stickers that sit on them. A window on a part that held still does not move.
- A face whose walls are all gone is removed. A sticker that no part holds is removed. Both are
  reported.
- **World-space faces** (`$surfaces`: extrusions, pasted and drawn faces) go with the wall they sit
  on; a face off the wall (an extrusion's cap) goes with the faces it is joined to. A point at a
  corner shared with a wall that held still counts as holding still. Faces on removed walls go.
- Frame drafts follow their host face; loose lines and hidden points on a moved wall move with it.
- Generated parapets and closed soffits are rebuilt only for the lines and walls that changed.
- Chimneys are re-detected only when a chimney line changed, and keep their ids when the new roof
  describes the same footprint or one in the same place.
- Per-wall offsets, merges and joints of removed walls are dropped. Roof trim settings of a moved
  line move to the panel that now covers it.

## Report and undo

The status line and a notice say what happened, for example: *Roof change applied to the walls (3
lines moved): 11 walls moved, 1 wall removed; everything else was kept. 1 edited wall was split
where the roof moved part of it. Undo restores the previous walls.* Removed windows, doors and
stickers are named.

The rebuild is one full undo step (walls, edits, chimneys and the roof they were built from).
Undo also marks that roof as kept, so the next stage click or mode switch does not redo it; the
next roof change follows from the restored walls.

## When it still falls back

The smart rebuild is tried whenever the walls carry edits. It is not tried, and the earlier
behaviour applies (ask before discarding, or keep the stale walls), when:

- the imagery scale changed by more than 1% (`state.context.mpp`: every point moved, so it is a new
  calibration, not a roof edit);
- the generator or the follow throws (logged as `[Walls] The roof change could not be followed`).

Within a rebuild, these parts are rebuilt from the roof or lost, and reported:

- a drafted face whose walls were all removed, or a split part with no walls left;
- a window, door or sticker on a part of a face that no wall supports any more;
- faces drawn on a removed wall;
- with the wall editor's follow unavailable, a face that would have to split.

Not followed (kept as they are): the base and its edits (as with From Roof, the foundation is
not refit to a moved roof line), loose lines that sit on no wall, and a world-space face whose
points split between a wall that moved and one that held still. A wall the generator renumbered
and moved more than 3 m, or turned by more than about 10°, cannot be paired; it is removed and a
new one added.

Every rebuild runs the generator twice (about 0.5 s on the pilot house); see
[the optimization backlog](../optimization-backlog.md).
