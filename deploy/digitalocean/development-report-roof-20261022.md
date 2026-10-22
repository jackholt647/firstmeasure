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
