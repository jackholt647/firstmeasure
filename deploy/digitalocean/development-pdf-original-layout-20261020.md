# Development rollout: original roof report layout — October 20, 2026

Since the Sept 18 exterior sync (`b77f3943`), every roof PDF on dev used the Full
House layout. That layout has roof-prefixed titles and puts the summary,
materials and ventilation pages ahead of the pitch, area and layer diagrams.
Production never had it. Release `128d7f2b` keeps production's layout for
roof-only reports and uses the Full House layout only for Full House reports.

## Behaviour

- A report uses the Full House layout when it has Full House pages: exterior
  walls, or a customer `exteriors_` project. This applies to both full and
  summary PDFs.
- Every other report keeps production's titles and order, in English:
  - Cover boxes: Project Summary, Measurement Breakdown.
  - Pages, in order: Top View, 3D Elevations, 3D Facets, Pitch Diagram,
    Area Diagram, Layer N Measurements, Structure Breakdown, Project Summary,
    Steep-Slope Materials / Materials, Flat Roof Materials, Ventilation,
    Gutters, Notes.
- Roof-only reports in another language keep the translated Full House titles,
  because those reports never had the original ones. They still follow the
  original page order.
- The Full House imagery pages are drawn only for Full House reports.
- Settings › Reports preview shows the original roof layout. Its script version
  is now `20261020-original-roof-layout-v7`. `pdf.js` is versioned by content
  hash, so editors pick it up on reload.

## Verification

- `dev/report-localization.browser.cjs` renders 14 fixture PDFs, and
  `dev/full-house-workflow.browser.cjs` renders 16. Both run in Chrome, cover
  roof and Full House, steep and flat, full and summary, US and metric, and
  pass. They check:
  - original titles and page order for roof-only English reports;
  - no Full House titles on roof-only reports;
  - Full House titles otherwise.
- `tests/report-preview-browser.test.mjs` passes with the original page list.
- Compatibility, web and pool were staged, activated and verified on
  `128d7f2b`. The worker serves none of these files.
- Dev serves the new `pdf.js`.

## Rollback

The previous release on compatibility, web and pool was `5f45f385`. Tooling is
in the ignored `output/pdf-layout-20261020/` directory.
