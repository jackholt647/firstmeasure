# Exterior PDF rework and roof materials — development, October 22, 2026

Source `60552c1d9a12acc2094b1036b0da1c6acd59c6ca`.

## Elevations
- **Four views.** Front, back, left and right at the configured front bearing +0/180/90/−90. Each face is counted and
  labelled on exactly one view. On the pilot house all 66 faces are counted once, and the totals equal the gross area
  (4,511.14 sq ft).
- **Layout.** No disclaimer. Tables use the roof-table style and are split into two columns (Wall, Material, Gross,
  Openings), with one totals box underneath. A smaller compass and a key marking the viewed side sit in the header.
  The drawing starts higher on the page. All four elevations fit on one page each on the pilot house.

## PDF rendering fixes
- Chimney caps and roof trim are drawn in the PDF. Trim shows where a trim height is saved.
- Roof and trim win the depth test against wall tops within about 4 cm (more at grazing angles, capped at 30 cm). This
  applies to the PDF only, so soffit lines no longer z-fight. Roof against roof still compares exact depths.

## Wall dimension context
- Each wall dimension drawing shows a dimmed house behind the measured face. Anything between the camera and the face
  is dropped.
- It adds about 12 ms per face and about 215 KB on a 2.4 MB PDF. The cost is logged in `docs/optimization-backlog.md`.
- Setting: `report_settings.general.exterior_dimension_context`, on by default. Organizations change it in
  Company › Reports › Exterior report, and a single report can override it on its Exteriors configuration page.

## Roof materials and the cover
- **Materials.** Shingles, Shake, Slate and Standing seam metal, each with category colour presets plus a custom
  colour.
- **Textures.** Procedural canvas textures at real scale.
- **Storage.** Saved as `finishDefaults.roof`, with undo; the default is charcoal shingles.
- **Where it is set and shown.** Set in Wall materials › Default finishes › Roof, and shown in the Textured modes.
- **Cover.** The "Property Measurement Report" cover uses a fully textured offscreen render (about 200 KB in the PDF
  snapshot). The Exterior Summary and the elevations stay untextured.

## Tests and rollout
- **Tests.** The full suite has 1,697 of 1,700 passing, with the known exterior-ai failure.
- **Rollout.** Editor scripts (including the new `exterior_cover.js`), `editor.php` and the platform settings
  `company.js` were overlaid on web, legacy and pool. All roles verified, and the served files match.
- **Not done.** `PDF_RENDER_RECIPE_VERSION` was not bumped.

## Follow-up: textured cover, doors, ridge caps, chimney tops — `a22d22f5c931b9ad96aa03c68bae7aaef47827c1`

**Cover.** The cover was grey even with walls set to brick. It used procedural substitute walls and rendered
synchronously, so it could never wait for photo textures. It now renders through Textured mode's own pipeline (wall
materials, photo textures, the HDR and the light rig), and `pdf.js` awaits `ExteriorCover.attach` before the snapshot.
If textures fail, it falls back to the procedural cover and then to the line drawing.

**Doors.** Doors of any shape render in a default door material. Rectangles get recessed panel layouts, and other
outlines get a groove traced 3.5" inside the edge, drawn as a normal map. Odd shapes previously fell through to the
wall material.

**Ridge and hip caps.** Caps for shingles, shake and slate run on ridge and hip lines only, built as one merged mesh
per roof and shown in the textured views only.

**Chimney tops.** Chimney tops are plain, coloured with the area-dominant side's texture mean × tint.

**Tests and rollout.** Five new tests. The full suite has 1,708 passing, with the known exterior-ai failure.
`exterior_cover.js`, `exterior_finishes.js`, `exterior_rendered.js`, `pdf.js` and `wall_mode.js` were overlaid on web,
legacy and pool. The served `pdf.js` also carries another session's live roof-title change, merged in.

## Follow-up: table style everywhere and the orientation-only Exteriors tab — `1b40b5bca91204fa3c3211bfd0d53a3b5cf0d66b`

**Tables.** Exterior Summary, Opening Schedule, Measured lengths, Net area by material and Material Allowances use
the left-bar boxed roof-table style, with numeric columns right-aligned. Tables of three columns or fewer and more
than ten rows split into two columns. Row capacity accounts for the new row height, and a section heading is never
left stranded at a page bottom.

**Exteriors tab.** The "Include exterior pages" and "house context" toggles, the faces list, the notes box and the
front-wall picker are removed from the UI. `exteriorSettings.include`, `.dimensionContext` and `.notes` are still
honoured as parameters, and the Company › Reports toggle is unchanged. The tab is one large dial: drag the footprint,
use the slider or type a bearing. It snaps within 3° of the strongest wall directions (Shift disables snapping), saves
on release, and fires one change event, which re-renders the textured cover.

**Tests and rollout.** Exterior suites pass. The full suite has 1,708 of 1,711 passing, with the known exterior-ai
failure. `exterior_pdf.js` and `exterior_report.js` were overlaid on web, legacy and pool, and the served files match.

## Follow-up: sticker colour defaults and proud trim — `1767838f06a5de756d3eb554fd2e06e842bda0d7`

**Trim z-fighting.** Textured mode kept the editor's depth offset only for the base and the ground, so sticker trim
and doors sat in the wall plane. Trim is now a thin slab 1.5 cm proud on both sides, with a stronger depth offset than
doors.

**Flat white trim.** Trim used a colour-cancelled wood scan stretched across one texture tile. It is now satin paint.

**Defaults couldn't apply.** Placing a sticker or changing its trim size baked `#f5f3ef` into it, so no default could
reach it. New trims store no colour, and old fixed-white trims follow the default.

**Stickers block.** Wall materials › Default finishes › Stickers has collapsed Trim and Main swatches, shown as "mixed"
when the pieces differ. "Each piece" expands to Door trim, Door colour, Window trim, Garage door trim, Garage door
colour, Untyped trim and Untyped main. The pieces are data (`ExteriorFinishes.stickerPieces`), stored in
`finishDefaults` with undo. A sticker's own colour still wins.

**Known issue.** Untyped stickers cannot carry trim yet. A local arched-door fixture shows brick wedges at the arch both
before and after this change; this has not been investigated.

**Tests and rollout.** Related suites: 665 pass. Full suite: 1,711 passing, with the known exterior-ai and media-viewer
failures. `exterior_finishes.js`, `exterior_rendered.js`, `wall_face_draft.js`, `wall_features.js` and `wall_mode.js` were
overlaid on web, legacy and pool, and the served files match.

## Follow-up: colour picker, undo on swatches, tray-aware dividers, window trim

**`77ec2925` — shared "Choose color" picker and undo.**
- The picker's palette now shows recently used colours instead of stock primaries. Recent colours persist in
  `firstmate:recent-colors` and also include the page's own recent list.
- A "Pick from screen" button uses the browser EyeDropper.
- Undo and redo now reach the editor from a focused colour swatch, checkbox or slider. Before, focus returned to the
  swatch after a pick, and both key handlers ignored any focused input, so Ctrl+Z did nothing.
- Checked in a browser: Ctrl+Z reverts and Ctrl+Y re-applies the default colour and the sticker trim. This change is
  platform-wide, because the picker is shared.

**`e7cb1bf8` — tray-aware dividers.** In report mode the right column kept a fixed 30% basis. Beside a wide tray the
panes overflowed, and the browser shrank the main pane away from the dragged divider (69 px off with a 1,000 px tray).
The right column now takes the remaining space. Measured: the handle stays on the mouse.

**`e7cb1bf8` — window trim.** Window frames and sills use the Window trim default in Textured mode, Match textured and
the plain-mode trim strips. A trim colour copied in from the wall trim at placement counts as the default.

All files were overlaid on web, legacy and pool and the served files match. The served `interaction_2d.js` merges
another session's live copy-and-paste change.

## Follow-up: sticker nudges, Trim line selection, distinct masonry — `9d24a032944b5e0abb1077c5f834ed1228a71103`

**Arched door nudges.**
- Problem: `completePointGeometry` counted a face as complete only when every ring vertex was selected, including
  curve tessellation points, which can never be selected. The selection then fell to per-point sliding, which
  sheared the door and dropped points from the selection.
- Fix: whole doors now move as one piece in the wall sketch, with one undo step per nudge.
- Points no longer pile up on the wall foot: base slides apply only when a base corner itself moves.
- Base points are gold only at real turns, at junctions of more than two edges, or at curve ends.
- A selected arched door sticker no longer throws "Resolve the face boundary"; it nudges.

**Trim mode.**
- Resoffit and Trim are two configurations of one line-selection mode.
- While the Trim menu is open, lines are selected by click or box, and points are hidden. Ridges, hips and valleys
  are greyed and cannot be selected.
- Closing the menu by any route restores normal selection.

**Masonry.**
- Stone and masonry have their own procedural textures; they no longer reuse the brick photo.
- Opening Wall materials switches to Textured; closing it restores the previous mode.

**Tests.** Related suites: 690 pass. Full suite (agents): 1,724 passing, with the known exterior-ai failure.

**Rollout note.** Before this commit landed, another session's deploy (`45d01e14`) had already carried these
uncommitted files from the shared checkout onto dev. This rollout re-anchored dev on the commit.

## Follow-up: compact Wall materials panel — `450c3003877220e3bb7d56c8f97a3ff6d7777f93`

- **Header:** slimmed to a single 28 px row.
- **Sections:** Faces, Walls, Roof and Stickers are collapsible, keyboard-operable, remember their state and show a
  summary when collapsed.
- **Disclaimers:** removed; useful hints are now tooltips.
- **Bottom palettes:** these applied a colour to the selected face or armed a paint colour, so they are kept as one
  Colour row (reset plus the project's colours). The Common and Recent rows duplicated the shared Choose color pop-up
  and are removed.
- **Height:** 431 px with the default sections open (was 1,223 px), so the panel fits 1366×768.
- **Tests:** picker suites pass 132.
- **Rollout:** `wall_features.js` overlaid on web, legacy and pool; the served file matches.

## Follow-up: Textured views gate unsupported tools — `1566abbe46755f345c689133beb7cda22b87af60`

**Cause.** Textured views draw a separate scene of finished surfaces and turn picking off. Plane guides, previews,
lines, points and labels therefore never render, and plane mode could stay "on" with nothing shown.

**Fix.** One table, `WallMode.displaySupports`, now governs which tools work in textured views. Plane mode, nudges,
line tools, the geometry clipboard keys, Resoffit, Trim, sticker placement and measurement overlays are disabled
there:
- their buttons are greyed with a tooltip;
- their shortcuts are ignored;
- entering Textured exits any of these modes that is active;
- leaving Textured re-enables everything.

Painting, face selection, Delete, undo, redo, save and the view controls keep working.

**Wall materials panel.** Roof and Stickers open by default. The "Wall defaults" section has rows Default texture,
Default colour and Default trim, and holds the renamed "Show material colours in Opaque and Translucent" checkbox.

**Tests and rollout.** Related suites pass 655. `wall_mode.js` and `wall_features.js` were overlaid on web, legacy and
pool, and the served files match.

## Follow-up: arched doors nudge as one piece; curves cannot be flattened — `8be13d84b5e52af27c49ebbd8c814bc569e61079`

The pilot's arched garage doors are stored surfaces whose draft was already consumed, a representation the first
nudge fix missed. Three root causes, all in `wall_face_draft.js` unless noted:

**Shear and dropped selection.** A partial point selection slid each point along its own line in `nudgePoints`.
**Fix:** a nudge of any curved-sticker point now selects all of the sticker's defining points and moves them together.

**Arch flattened into a point polyline.** `applyLineResult` moved the consumed draft's nodes, which rebuilt the faces
as new surfaces with tessellated rings. **Fix:** a commit guard (see below) refuses such edits.

**Ghost arch.** In `wall_solid_geometry.js`, `transformSelection` left a neighbour's plain copy of the arch in place.
**Fix:** a moving curved face now carries those vertices with it.

**Commit guard.** Every editor commit goes through `W.flattenedCurveSamples`. An edit is refused, rolled back and
reported if it would turn curve samples into corners, loose wire, sketch nodes or retained points, or if a nudge
changes the curve count.

**Testing.**
- The full test matrix (agent): 33 tests across 4 storage representations and 8 selections, with plain, Shift and Alt
  nudges, M moves, undo, and save/restore. On the previous code, 21 of the 30 nudge cases fail.
- Before release, the nudge hunks were split out of a working tree that also held unfinished inside-trim work, and
  tested in a clean worktree: 636 pass. The 2 failures also occur at HEAD and come from a missing three.js link in that
  worktree.
- The test file ships with the trim commit, because the two share it.

**Rollout.** `wall_face_draft.js` (nudge hunks only) and `wall_solid_geometry.js` were overlaid on web, legacy and pool.
The served files match.

## Follow-up: Trim Selection section and inside face trim — `c68faf481986d361718796ab3652159fc21e3046`

**Selection section.** The Trim menu now has a pinned Selection section covering wall lines, faces, eaves and rakes,
and openings in any mix.
- It shows a count by type and sets width (2, 3, 4, 6 or 8 in, or custom; roof sides take it as height) and colour
  immediately. Each change is one undo step, written through each type's own writer.
- It shows "Mixed" when the selection differs, and has Remove and Clear.
- The bulk sections fold and remember their state. Bulk Select buttons add to the selection.

**Inside face trim.** With a plain wall face selected, T toggles a one-sided strip inside every edge of the face,
including holes. The strip follows the face and never reaches a neighbour. Line trim remains two-sided, and sticker
trim remains outside the opening.

**Behaviour changes.**
- T inside Trim mode now adds trim and keeps the menu open.
- T on a face toggles inside trim; Flip applies to point selections only.

**Tests.** Related suites pass 729, including the arched-door nudge matrix. Full suite (agent): 1,769 of 1,772, with
the known exterior-ai failure.

**Rollout.** `roof_trim.js`, `roof_trim_editor.js`, `wall_trim.js`, `wall_face_draft.js`, `wall_mode.js` and
`wall_editor.js` were overlaid on web, legacy and pool. The served files match.

## Follow-up: colour picker commits once per drag — `93ccbcd10229426e9f4209f487c91d263c3d491c`

**Problem.** Dragging across the shared picker's colour plane or hue slider fired `change` on every move. Every call site
records a recent colour on `change`, so the in-between shades filled the recent colours.

**Fix.** A drag now fires only `input`, for the live preview, and fires one `change` on release, closing or Done.
Typed values, swatches and the eyedropper still commit immediately.

**Tests.** A browser test drags across the plane and checks that there is no commit mid-drag, exactly one on release,
and one recent colour.

**Rollout.** `firstmate-color-picker.js` was overlaid on web, legacy and pool, and the served file matches.

## Follow-up: landscape PDF option and balanced portrait elevations — `81298584`, merge `a92e9f27`

**What changed.**
- Reports can be laid out landscape. The org setting is Company › Reports › Layout › "Landscape pages". A dev-only
  switch on the Exteriors tab saves a per-report override.
- Every page has a landscape layout. Landscape elevations put the drawing on the left and the tables on the right.
- Portrait single-page elevations bottom-align the tables above the footer and centre the drawing above them.
- Sources and Notes no longer list video frames.

**Merge.** It was merged with another session's live roof-report changes (quad retirement, roof-only titles), keeping both.

**Limits.**
- The organisation default is read when the report is generated; it is not frozen in the snapshot.
- Landscape elevation drawings are limited by width.
- The settings preview reuses the portrait images.

**Rollout.**
- All seven files were shipped as the release copy to legacy and web, and the served files match `a92e9f27`.
- The pool host (10.124.16.3) was unreachable, so the pool role was skipped. Server-rendered PDFs stay portrait until the
  pool has the new `pdf.js` and `exterior_pdf.js`.

## Follow-up: walls follow a roof edit — `ae7cb1ef`

**What changed.** Coming back to wall mode after a roof edit no longer rebuilds all the walls (or asks to discard every
edit). The editor diffs the roof against the one the walls were built from. Line and wall ids are kept, and only walls
whose driving lines changed are changed:
- Edited faces follow moved walls.
- Windows, doors and stickers move with them.
- Anything that cannot be kept is removed and named in a notice.

One undo step reverts the change. The old prompt is now only a fallback, for a scale change or a failed follow. Design:
`docs/architecture/exterior-roof-rebuild.md`.

**Tests.** 7 new tests on the ce52 house: line retype, moved flashing, turned flashing, deleted head wall, added facet, and two unit tests. Related wall suites: 773 of 773 pass.

**Rollout.**
- `wall_mode.js`, `wall_geometry.js`, `wall_editor.js`, the new `wall_roof_rebuild.js` and `editor.php` were merged onto live
  `01f5e5c2` for legacy and web, with no drift. The served files match.
- A served-script browser check on the pilot found the module present, wall edits unchanged across a mode toggle, and
  no page errors.
- The pool host was still unreachable, so it was skipped.
