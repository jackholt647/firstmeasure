# Stickers: one model, one writer, one edit pipeline

A sticker (window, door, garage door, vent) is a closed face on a host face that
can be moved, resized and reshaped. Before this change a sticker was whatever
face carried a `feature` object: a draft region, a stored surface, or a draft
rebuilt from a surface. Each edit picked an engine by storage form (about seven
for moving, five for resizing), the hole in the host came from three different
mechanisms, and curves were recovered from tessellation by tolerance tests.
This note describes the replacement.

## The sticker outline

`WallStickers` (`editor_scripts/wall_stickers.js`) is pure geometry. A sticker's
shape is an **outline** in the host plane:

```
{ v:1, frame:{origin,u,v,n},           // world plane frame, u level, v up
  loop:[{x,y, seg?}] }                  // vertices in frame metres
```

`loop[i].seg` describes the edge from vertex `i` to `i+1`:

- absent: a straight edge;
- `{type:'spline', via:[{x,y}...]}`: a natural spline through the two vertices
  and its interior controls (arches, drawn splines);
- `{type:'ellipse', center:{x,y}, rx, ry, a0, a1}`: an elliptical arc (round
  and oval windows are two half-ellipses).

Vertices and spline `via` points are the sticker's **controls**: the only
editable points. Tessellation is derived from the outline every time; it is
never read back as editable geometry.

## One reader

`WallStickers.read(face)` returns the outline of any sticker face in any storage
form. A face written by the new writer carries its outline on
`feature.outline`, which is used when the face still matches it. Otherwise
(older saves, or a host edit that carried the sticker) the outline is derived
once from the face's analytic `curves` and its non-sample points; a legacy
48-point round window becomes an ellipse.

## One writer

`writeStickers([{ref, outline}])` in the face editor writes every sticker edit
(`outline: null` deletes). It keeps the sticker's `feature` (type, trim,
divisions, axis), records the new outline on `feature.outline`, and is the
only code that changes a sticker's shape:

- A **draft** sticker is lifted off its draft (`liftSticker`: its own curve
  edges and nodes go, the host's outline edges stay) and reinstalled from the
  outline, with spline and ellipse edges as analytic sketch curves. Face id and
  control node ids are kept, so selection and attachments follow it.
- A **stored** sticker is replaced in `$surfaces` by a new object holding the
  outline's tessellation and curves. Its wall keeps no hole or notch for it
  (a hole it kept from older saves is dropped); the opening is cut where the
  wall is drawn and reported (`ExteriorModel.cutOpenings`).

The writer never selects. The caller does: whole-sticker edits keep the
stickers selected, point edits keep the moved points selected.

## One closed-face rule

`draftOpenings(d)` in the face editor is the one rule: a region is an opening
of its draft when another region contains it and none of its points is on the
draft outline. It does not look at whether points are fixed, so a loop redrawn
over points a deleted sticker left behind cuts its wall instead of lying over
it. `classify` and drawing both use it.

`WallStickers.check(outline)` (finite, at least 0.01 m, non-zero area, no
self-intersection) runs on every outline the writer receives. Placement
against the host and other stickers is checked by the draft (or, for stored
stickers, `checkStoredSticker`) with an overlap threshold of 10 mm².

## One edit pipeline

Every operation turns into an outline transform, then the writer:

| Operation | Transform |
| --- | --- |
| M (face slide, multi-sticker move), paste placement, nudge of a whole sticker, E distance lock | `translate(outline, dx, dy)` |
| Nudge or M of some of a sticker's points (corners, arch ends, arch controls) | `moveControls(outline, ids, dx, dy)` |
| Edge stretch (selected sticker edge nudged) | `moveControls` on the edge's two vertices |
| Preset size (repeat W/D/G), typed size | `resize(outline, box, anchors)` |
| Y scale, R rotate, T flip in the move tool | `affine(outline, map)` |
| Delete some of a sticker's points | `deleteControls(outline, ids)`: the sticker stays a closed face through the rest; all of its points, or too few left, deletes it; deleting an arch control straightens that edge |

A spline whose controls move is refitted through its controls; one that loses
an end continues from the neighbouring vertex. Nothing is sheared or
re-sampled from old tessellation.

## Out of scope

Stickers moved In/Out (recessed with returns) or extruded leave the host plane
and stay on the existing extrusion engine. Divided stickers move as their
group; dividing and merging sections keep their existing commands.

## Commit guard

`host.commit` counts curves before and after every edit. An edit that turns a
curve's tessellation into vertices, loose wire or sketch nodes, or a nudge that
changes the number of curves, is refused and rolled back with a message.

## Verification

`node --test dev/wall-stickers.test.cjs dev/wall-face-draft.test.cjs`. The
sticker sections of `wall-face-draft.test.cjs` run every nudge selection (whole
door, all points, corners, arch ends, arch control, bottom corners, one or both
door stickers) on four storage forms (draft doors on a wall foot, a draft
arched window, stored pilot garage doors from a consumed draft, stored doors in
a plain wall), then reload and nudge again; M, R, Y, paste, corner delete and
whole-sticker delete; and every sticker on the saved session
`dev/fixtures/ce52-sticker-session-20261029.json` (Jack's project, location
removed) nudged whole, reshaped by a corner and missing a corner.
