# Full-house customer wall numbers and atomic Full House ordering — development, October 19, 2026

Two releases onto all four development roles (worker, legacy, web, pool). Each was verified on every role. Production
was not changed.

## `41c43b985f9663f3794af8e0c7a6eb4315cd73dc`

- **Customer measurements summary and CSV** (`apps/measurements/project.js`): for a project whose `measurement_scope`
  is `full_house`, the Report.pdf Exterior Summary and Exterior Quantities follow the roof rows: net and gross wall
  area, opening area and perimeter (the opening trim), horizontal returns, tops and bottoms of walls, inside and outside
  corners, material transitions and exposed vertical terminations. They come from dictionary keys
  (`exterior_wall.*`) with explicit units. Roof-only summaries are unchanged.
- **Standard report description**: a full-house order reads "Full house PDF with roof, gutter and exterior wall
  measurements" instead of "Main roof measurement PDF with gutter measurements".
- **Customer Summary.pdf**: a full-house customer summary now carries the one-page Exterior Summary
  (`ExteriorPDF.drawExteriorSummaryPage`), next to the Gutters page it already forced. Elevations, dimensions, the
  opening schedule and quantities stay in Report.pdf. The pilot's delivered Summary.pdf was rendered before this
  change and is not regenerated.
- **Atomic Full House order** (`firstmeasure/api.ts`, `/projects/queue`): if copying the customer references into the
  new `exteriors_` project fails, the project is cancelled (`cancellation_reason: reference_copy_failed`) and the
  request fails, so the platform's refund and the project agree. Before, the project stayed `awaiting_references`
  forever.
- **Metric reports**: no change was needed. The exterior editor always saves wall totals in feet (`units: "ft"`).
  Metric is applied only when the report is displayed, so `measurementPayloadFromExterior` already publishes them. A
  test now covers a metric-system report.

## `42ca4abc6eed20fc5cdcb98248d95dfa92599617`

On dev, the pilot customer was refused their own measurement dataset: `GET /v1/publication/.../measurements`
returns 403 `capability_denied` (`platform.expanded_access`). So the summary's dataset load fails for customers.
- New read route `GET /v1/firstmeasure/projects/:id/exterior-measurements` (`view_reports`, same organization or
  owner/issuer email). It returns only the saved exterior totals of a completed customer full-house report, and `{}`
  otherwise.
- The summary loads wall rows from that route, separately from the roof load. Roof-only summaries make no request.
- `firstmate-apps-manifest.js` bundle version `measurements/project.js` → `20261019-full-house-walls-v2`.

## Rollout notes

- The hosts run an older `public/v1/tests/exteriors-order.test.ts`, which conflicted. The live copy was kept: it is a
  test, not runtime code.
- The first activation of the second release stopped before activating anything, because another rollout changed the
  worker. The re-run activated after the sibling release `03d57cc1`, so both are live.
- Scripts: `output/fh-customer-walls-20261019/` (git-ignored).

## Verification

- Tests: `tests/full-house-customer-summary.test.mjs` (new; includes the roof-only regression),
  `exteriors-order.test.ts`, `publication-data-firstmeasure.test.ts`, `full-house-workflow.test.ts`,
  `full-house-php.test.ts`, `publication-measurement-schemas.test.ts`, `firstmeasure-localization-display.test.mjs`
  all pass. `tsc` is clean apart from an unrelated `comms/phone/events.ts` error.
- Pilot customer `fh-pilot-customer@example.com`, delivered project `exteriors_057d257e0423cdceb010a24af21c3b8f`.
  The summary shows the wall rows (net 4,430.8 sq ft; tops 385.1, bottoms 399.2, inside 182.4, outside 357.5,
  terminations 108.9 ft), matching Report.pdf pages 16 and 43. The CSV carries them, and the roof rows are identical to
  before the release.
- Roof-only: no pilot account has a delivered roof project. Dev serves the committed `project.js` byte for byte, and
  its roof-only path is covered by the regression test.

## Known gaps

- The customer's roof rows come from a project-data heuristic, not the report: Ridges 15 ft against 93 ft in
  Report.pdf, and no roof squares. This is the same 403 on the dataset. It is pre-existing and was not changed here.
- No stored gutter totals: "Active gutter" equals Eaves for the pilot, but the downspout count exists only in the
  rendered PDF.
- Net area by material is not published: material names are free text, not dictionary keys.
