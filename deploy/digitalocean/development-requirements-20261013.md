# Requirements, coverage and the work order column — October 13, 2026

One development release, `d13a6886`, staged, activated and verified on worker,
legacy, web and pool. Nothing was sent to production and nothing was pushed.

What it adds is described in [requirements](../../docs/architecture/requirements.md):

- Measurement partitions: a measurement can be a part of another, so overlap
  and addition are known (`measurement-schemas.partitions`).
- The work item dictionary and the roofing work schema
  (`platform/publication/work-items.ts`).
- Pay sheets map pay to work (`covers`, `work`, `provides`), estimate hours from
  the work (`work_hours`), and can be evaluated for part of the work.
- Assignee capabilities (`labor/capabilities.ts`, new collection
  `assignee_capabilities`).
- Project requirements and coverage (`labor/requirements.ts`,
  `work-requirements.project`).
- Project tab: labor and equipment share a Work order column, and a collapsible
  Requirements tray follows the columns.

Host notes:

- `platform/storage.ts` and `storage_postgres.ts` keep their collection names on
  one line that other sessions had also extended on web, legacy and pool, so the
  three-way merge conflicted there. The new name was added to each host's live
  line instead. `permission-bundles.ts` has the same fallback.
- Bundle versions: `materials/project.js` and `materials-api.js` are
  `20261013-requirements`.

Data changed on the development database, all additive:

- `output/requirements-20261013/seed.mjs` brought the five sample pay sheets up
  to the mapping in the seven Instant Full Org sandboxes created since October 7.
- `output/requirements-20261013/regen.mjs` built the one generated work order on
  Granite Heron project `project_mv012kxo_m7a0s916` again from its pay sheet, so
  its lines carry what they cover. Its prices did not change; the sheet's dump
  truck line was added. Other work orders generated before this release show
  their work as open until they are generated again.

Validation: `tests/work-requirements.test.ts` (4), `tests/labor-generation.test.ts`,
`tests/labor-pay-sheets.test.ts`, `tests/labor-commitments.test.ts`,
`tests/publication-measurement-schemas.test.ts`, `tests/roofing-library.test.ts`
and `tests/project-scope-work-browser.test.mjs` (21) pass. `npm run test:publication`
had three failures, all in another session's unfinished payroll and custom-field
work (`payroll.time_clock_events` has no permission bundle yet); `npm run check`
fails on that session's `tests/pay-sources.test.ts`. On the web host the
requirements of a real project were read after activation and matched its lists.

Not checked: nothing was opened in a signed-in browser.
