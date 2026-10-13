# Scope artifacts, equipment functions and tray changes — October 13, 2026

Three development releases after [requirements and coverage](development-requirements-20261013.md).
Nothing was sent to production and nothing was pushed.

- `38af6f2b` and `442cfe12` — Requirements tray wording and layout, browser
  files only, on legacy, web and pool. Each requirement shows the icon of the
  list that meets it, descriptions moved to tooltips, only line items that can
  meet a requirement are offered for it, covers are one row with a small
  Remove, counts sit inside the status circles, and the non-labor group is
  called Other.
- `ff9c3fa4` — on worker, legacy, web and pool:
  - A project requires only what its scope artifacts say. A materials calculus
    set may carry `work` (work items and functions) beside its material lines;
    requirements are the artifacts added together (`labor/scope-artifacts.ts`).
    The scope set sizes amounts and decides what can be added by hand. It is no
    longer the source of requirements.
  - Work can be added by hand (`work-requirements.manual.save`,
    `PUT projects/:projectId/scope/manual`, "+ Add" in the tray) and an agent
    can publish a whole scope through `materials.calculus.command`.
  - The sample roofing document's calculation returns `work`.
  - Equipment types and units say which functions they provide; the Equipment
    tab's type editor has a Functions section; equipment picked for a project
    line item is stamped with what it provides. Built in a separate task and
    shipped here. New columns `provides_json` on `equipment_types` and
    `equipment_units` are added on start.

Host notes:

- The shared checkout held other sessions' uncommitted changes in most files
  this touched. The commit is the committed text plus this release's exact
  replacements (`output/scope-artifacts-20261013/replay.py`), tested from a
  scratch copy of the commit rather than the working copy.
- Legacy runs an older equipment app without the type editor, so
  `equipment/app.js` kept its live version there. The Functions section is on
  web and pool only.
- Bundle versions: `materials/project.js` and `materials-api.js` are
  `20261013-scope`; `equipment/app.js` and `equipment-api.js` are
  `20261013-functions`; `calculus-native.js` is `20261013-scope`.

Data changed on the development database: Granite Heron project
`project_mv012kxo_m7a0s916` was given a hand-added scope of the nine roofing
items (`output/scope-artifacts-20261013/seed.mjs`), because its accepted
document predates documents publishing work. Before that it had no work
artifact, so it required no work.

Validation, run from a scratch copy of `ff9c3fa4`: `tests/work-requirements.test.ts`
(4), `tests/equipment-functions.test.ts` (3), `tests/labor-generation.test.ts`,
`tests/labor-pay-sheets.test.ts`, `tests/materials-calculus.test.ts` (10) and the
three browser files (24) pass. `tests/instant-roofing.test.ts` has one failure
that is the same on the commit before this work. On the web host the test
project's requirements and the organization's equipment functions were read
after activation.

Not checked: nothing was opened in a signed-in browser; Postgres storage for the
new equipment columns was exercised only by the host starting and answering.
