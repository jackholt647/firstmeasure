# Report settings by kind of report — development only, October 23, 2026

Releases `0fccea08` and `d5730630` (the tab polish). **Development only.** Jack asked to review this on dev before
production, so it is not part of any production release.

**Orientation is an organization setting, per kind of report.**
- **Roof reports:** `report_settings.general.report_orientation`, portrait by default.
- **Full Exterior reports:** `general.exterior_report_orientation`, landscape by default. Full Exterior means a
  customer full-house order, or a report with its exterior pages on.
- **Override:** a render override still wins.
- **Removed:** the editor's development-only portrait/landscape switch is gone, and a report's own
  `exteriorSettings.orientation` is no longer read.

**Full Exterior customer pages.**
- Settings › Reports › "Full Exterior pages" chooses the exterior pages of a Full Exterior customer PDF:
  - Exterior Summary;
  - elevations, with hidden faces;
  - wall dimensions;
  - opening schedule;
  - exterior quantities;
  - material allowances;
  - wall notes.
- The default keeps today's customer PDF: the Exterior Summary only. The internal PDF keeps every page.
- `drawExteriorReportPages` takes the page selection; `pdf.js` has `customerExteriorPages`.

**Feature flag.** The Full Exterior orientation and both exterior sections show only when the organization has
`firstmeasure.exteriors`.

**Preview.**
- For those organizations, the report preview switches its sample between "Roof only" (the existing replica) and
  "Full Exterior".
- The Full Exterior sample is the real PDF. The shared PDF runtime makes it in a hidden same-origin frame, from the
  same scripts `/v1/firstmeasure/pdf-runtime` serves to the editor and the worker.
- **Data:** `report-preview/full-exterior-sample.json` (3.3 MB, 0.77 MB gzipped), captured with the editor's
  `captureStateForPDF` from `exteriors_057d…` (4725 W Mercer Way). The customer name is replaced and photo links are
  removed; the front is set to 120°.
- **Settings:** it uses the organization's settings, colours and logo.
- **Display:** pages are drawn with pdf.js 3.11.174 from cdnjs, as Proposals does.
- **Speed:** on dev the customer PDF builds in about 4 seconds.

**Checks on dev (pilot customer organization, exteriors on).** Settings › Reports shows:
- "Roof reports in landscape" (off) and "Full Exterior reports in landscape" (on);
- "Exterior report";
- "Full Exterior pages", with Exterior Summary on.

The Full Exterior sample built 13 customer pages, ending with Exterior Summary and Roof Notes. Locally:
- the internal PDF built 36 pages in 9 s;
- a customer PDF with elevations, quantities and wall notes on built 18 pages, in portrait.

**Tests.**
- `dev/pdf-landscape.test.cjs` (9/9): orientation by kind of report, and portrait from the setting equals a render
  override byte for byte.
- `tests/full-house-customer-summary.test.mjs` (3/3): page selection.
- `tests/report-preview-browser.test.mjs` (3/3): the sample switch only with exteriors.
- The other `dev/` PDF suites pass.

**Rollout.**
- Legacy and web: three-way merged, with the edit scripts in `output/fh-report-settings-20261023/` for replay.
- The pool node is still unreachable.
- The worker's PDF runtime still has October 7 editor scripts (see `development-exterior-trim-20261023.md`), so PDFs
  it rebuilds use neither these settings nor the trim work.
