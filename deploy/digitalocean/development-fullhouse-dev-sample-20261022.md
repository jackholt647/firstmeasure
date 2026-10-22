# Instant dev full-house reports copy the Mercer Way pilot — development, October 22, 2026

Source `6ec6f3dded306814d7f841e801195470b2e1aaaf` (parent `133530a1`).

**Request.** An instant dev report for a full house should copy the one complex completed full house on dev
(4725 W Mercer Way, Mercer Island), not a random completed full house.

**Source project.** The drawing lives in the internal draft `fullhouse_ce52c5ebb595e2c7461e102f8478e89c`. That draft is
`ready`, `internal_only`, and has no Report.pdf, Summary.pdf or model_data.xml, so it cannot be copied as a report.
Its completed customer order is the pilot `exteriors_057d257e0423cdceb010a24af21c3b8f`. On 2026-10-19 the pilot's model
was copied from ce52, and ce52 has not changed since (`app_metadata.json` last written 2026-10-19 20:57 UTC). The pilot
has all three report files, 8 elevation photos and its customer-reference images.

**Change.** `pickDevelopmentReport` (`firstmeasure/development_reports.ts`) offers `exteriors_057d…` first for
`measurement_scope: full_house`. It is still checked as completed, residential, full house, not internal, with non-empty
report files and coordinates. `FIRSTMEASURE_DEV_FULL_HOUSE_SAMPLE_ID` overrides the id. Set it empty to restore
random selection. Choosing another address (`exclude_id`) still falls back to random candidates. Roof samples are unchanged.

**Rollout.** `development_reports.ts` and its test were overlaid on all four roles (web, worker, legacy, pool), each
staged and then activated in turn. Health is ready on `6ec6f3dd`. On dev web, three full-house picks returned
`exteriors_057d…` and a roof pick returned a random project. `tests/development-reports.test.ts` passes.
Scripts: `output/dev-sample-fullhouse-20261022/`.
