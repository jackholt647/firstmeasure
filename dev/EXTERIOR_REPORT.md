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
