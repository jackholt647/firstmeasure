# Exterior report prototype

## Use

In Walls mode, choose a material from the bottom-right 3D palette, then click each
wall section to paint it. Escape ends painting. Split a face before assigning
different materials to its sections. Material colors toggles visualization only;
it does not clear assignments. Unassigned clears an assignment explicitly.

Open Config after editing. Exteriors shows the current model's material schedule,
an include-pages toggle, and report notes. The full PDF appends exterior pages.
Roof-only projects and roof summary PDFs retain their existing page flow.

## Coverage and sources

Reviewed EagleView's actual [Walls, Windows & Doors sample](https://www.eagleview.com/wp-content/uploads/2023/07/Walls-Windows-Doors-Sample.pdf).
Its exterior coverage includes structure diagrams, cardinal elevations, opening
dimensions and perimeters, wall areas, siding/masonry quantities, and waste tables.
Those information categories guided this prototype; artwork, branding, fonts,
and implementation are FirstMate's existing report system.

[GAF QuickMeasure](https://www.gaf.com/en-us/resources/business-services/quickmeasure)
describes roof reports; it was not used as evidence of exterior-report coverage.

The appendix provides four elevated house corner views (roof, walls, and returns),
cardinal elevations, individual wall dimensions, opening schedules, wall takeoff, corners,
material transitions, opening perimeter, net material area, and waste scenarios.
Roof imagery, roof dimensions, and roof quantities remain in the existing pages.
The editor base supports geometry calculations but is omitted from report visuals
and pages. Its default appearance in the textured editor is plain concrete gray,
independent of the default wall finish.
This is a model-derived prototype, not a claim of complete competitor parity:
field photographs, product-specific accessories, fascia/soffit classification,
trim widths, rough-opening allowances, hidden surfaces, and actual installation
waste require additional input. Opening dimensions follow the drawn boundary;
the report does not assume it includes casing.

## Data boundary

`ExteriorReportModel.build` accepts final edited metric world faces and the edited
base. It never rebuilds roof geometry or mutates editor state. WallMode captures
that model through the same composed faces displayed in the editor, including
chimney clipping. The serializable report snapshot travels through the existing
browser and standalone PDF paths.

Materials live on individual draft/solid faces, inside normal wall edit history
and project persistence. Resolving a split preserves its containing face's
material. Extrusion carries material to the cap and connecting returns. Material
visualization is separate from assignments and reporting.

Report regions union adjacent coplanar faces of the same material; distinct
materials and chimneys stay separate. Modeled openings are reunited with their
host region for gross area, then subtracted once for net area. Openings must have
a supporting wall; unsupported features appear in review notes. Openings spanning
multiple independently assigned material regions are not currently apportioned
across those regions; keep a feature on one host section for this prototype.
Horizontal/sloped returns are listed separately from vertical cladding area.
Length totals exclude shared coplanar seams and distinguish material transitions.

## Elevation pages

The cover, Exterior Summary and Front elevation all look from the configured front
bearing (the orientation key's Front); nothing derives the view from the geometry.
Elevations draw walls and the roof as light faces with dark edges on white; the roof
only occludes and is never labeled.

There are four elevations: **Front, Back, Left and Right**, looking from the
configured front bearing turned by 0, 180, +90 and -90 degrees (`elevationViews`).
Each wall face is counted on exactly one of them (`elevationPlan` in
`exterior_pdf.js`): among the views where the face points toward the viewer
within 60 degrees and at least a quarter of its area is visible, the one that looks
most directly at it. A face no view shows that well goes to the view showing most of
it; a face no view shows at all is listed on **Hidden Wall Faces**. Faces under 1 sq ft
are one **Small pieces** row on the view they face. Elevation totals plus hidden
faces therefore equal the gross wall area. Every face in an elevation's table is
labeled in its drawing (inside, smaller, or beside it with a leader line) and every
label is in the table; faces counted elsewhere are drawn pale and unlabeled. The
Wall Dimensions headings name the elevation each face is counted on.

An elevation page has no explanatory note. Its header carries a small key beside the
page title: the north-up footprint with the viewed side marked by an accent bar (the
viewing plane) and an arrow toward the house, and a small compass. The drawing starts
just under the header and is only as tall as the house needs at full width (at most
110 mm). The faces are listed in two boxed tables side by side, in the roof pages'
style (white box, accent bar on the left, bold headers over a rule); each has Wall,
Material, Gross and Openings columns. Rows fill the left box, then the right (split
evenly on the last page), and one totals box under both gives the face count and the
gross, openings and net area. Hidden Wall Faces uses the same tables. On the pilot
house all four elevations fit on one page each. "Openings" is the area of modeled
windows, doors and other openings cut from the face.

### What the drawings include

The report model carries two render-only lists that are never wall area:
`caps` (plain chimney tops, material `chimney-top`, which the wall schedule skips)
and `roofTrim` (roof fascia panels built by `RoofTrim.panels` from the roof and the
saved trim heights that `WallMode.reportSnapshot` passes in, so a house with no trim
height set has none, exactly as in the editor). `houseFaces` draws walls, returns,
chimney tops, roof trim and the roof in the cover, summary, elevation and notes
views; the roof elevations add the trim to the roof.

### PDF-only z-fight rule

Wall tops along soffit lines often lie in, or a few centimetres through, the roof
plane. The editor keeps that exact geometry (and its slight z-fighting) for precise
control. The PDF rasterizer (`rasterScene`) resolves it like a polygon offset: against
any non-roof surface, the roof and roof trim win a depth comparison within 4 cm plus
1.5 px of their own depth slope (capped at 30 cm, `roofDepthBias`). Roof against roof
compares exact depths, so overlapping roof layers never fight. A wall that really
rises above the roof by more than that still shows.

### House context behind wall dimension drawings

Each Wall/Trim Dimensions drawing keeps its framing, angle, dimensions and look (dark
outline, grey face), and the rest of the house is drawn behind it in very light grey
with light-grey edges and no labels or measurements (`rasterScene` with `focus`).
Context is kept only behind the face's plane, so nothing between the camera and the
face can hide it, and it is clipped to the drawing's frame. On the pilot house (66
faces) it costs about 12 ms more per face (17 ms instead of 6 ms at 600x400 px; the
whole PDF is within run-to-run noise at about 8 s) and adds about 215 KB to a 2.4 MB PDF.

It is on by default. An organization turns it off with **Company › Reports ›
Exterior report › Show house context behind wall dimension drawings**, saved as
`report_settings.general.exterior_dimension_context` on the branch (the same place as
the other report defaults). A report overrides the organization default from its own
Exteriors configuration page (`exteriorSettings.dimensionContext`, saved with the
report's PDF configuration). Off draws each face alone, exactly as before. Rasterizing
the whole house per face is a known shortcut, listed in
[the optimization backlog](../docs/optimization-backlog.md).

Report configuration warns while any face has no material (the editor's "Smooth"
default with no default texture), with buttons to list those faces or open Wall
materials. The tray opens at 36% of the workspace, resizes from its left edge, and
keeps each person's width in this browser.

## Local verification and artifacts

- `node --test dev/*.test.cjs`: existing geometry/editor suite plus focused
  report area and material persistence checks.
- `editor_tests/step_fixture.html`: Paint materials runs actual editor picking,
  repeated painting, cancellation, and a subsequent geometry edit.
- `node dev/exterior-report-preview.cjs`: reads the saved sandbox house and writes
  `output/pdf/FirstMeasure-exterior-prototype.pdf`; no project writes or uploads.
- `node dev/exterior-report-visual-check.cjs`: renders separate synthetic mixed
  materials/openings and an unchanged roof reference under `tmp/pdfs`.

The generated saved-house example uses the current sandbox snapshot, which has
no labeled openings or assigned materials. It does not contain fabricated labels. Synthetic layout QA
is separate. PDF page PNGs were inspected, and all 11 original roof page texts
were compared with the roof reference.

Browser capture verification loads the actual editor page and calls
`captureStateForPDF` against the saved house, with writes intercepted. The report
module must load after the exterior geometry kernel and wall solid module; its
browser initialization order is covered by the focused report test.
