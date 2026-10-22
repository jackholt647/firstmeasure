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
