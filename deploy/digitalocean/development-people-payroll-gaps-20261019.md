# Development rollout: pay sheet editor, payroll payables and export templates, People gaps (October 19, 2026)

Release `c255dda34a0738f41487579cbd0d3b17284fdddb` on `codex/consolidated-firstmeasure-20260923`, built on
`f709807f`, activated on all four development roles (worker, legacy, web, pool) and verified. It replaced `702908be`
(the staff entry forms release) on every role. The development platform worker was restarted on it. Production is
unchanged.

## What shipped

139 files changed, 11,285 insertions and 741 deletions; `public/v1/payroll/contractor_disbursements.ts` is removed.

### Pay sheet editor

Design: [pay sheets](../../docs/architecture/pay-sheets.md).

- People edits each assignee's pay sheets: `people/pay-sheets-model.js`, `pay-sheets-editor.js` and
  `pay-sheets-list.js`, on the user, group and outside company pages, with `labor/pay-sheet-editor.ts` behind them.
- The editor speaks in the words each kind of work uses, shows who could use a sheet they do not have, and
  `pay-sheets.try` prices an unsaved sheet on a project with the same validation as saving, field by field.
- `custom-fields-project.definitions` and the product type on `materials-inputs.products` feed it.

### Payroll: payables and export templates

Design: [pay rules](../../docs/architecture/pay-rules.md), "Paid with payroll or through payables" and "Export
templates"; `public/v1/payroll/README.md`.

- Payees paid through payables (contractors on net terms, outside companies) get a bill per pay run, due on their
  terms, listing the ledger entries it pays (`payroll/payables.ts`, replacing `contractor_disbursements.ts`). Paying
  the bill wherever payables are paid marks the pay run item paid, once (`payments/storage.ts` calls
  `settlePaidPayrollBills`); `payroll.bills.reconcile` finishes a settlement that failed part way.
- A reimbursement paid in payables is settled once: voided before any run holds it, or the run is held until it is
  reopened without it.
- Pay run files are made from export templates (`payroll/export-templates.ts`). The five built-in files are templates
  that make the same files as before (`tests/fixtures/payroll-pay-run-files.json`); a company duplicates one and edits
  it with a preview of the first rows of a pay run.
- Schema: the payroll store goes from version 5 to 6 for the new `payroll_export_templates` table. The table is
  created by the store on start; no data was migrated.

### People

Design: [branches](../../docs/architecture/branches.md), [assignee base](../../docs/architecture/assignee-base.md) and
[organization collaboration](../../docs/architecture/organization-collaboration-implementation.md).

- Removing a person archives them: kept for the record, unable to sign in, and restorable
  (`workforce/user-archive.ts`).
- Company types list onboarding requirements, an outside company shows what it still needs, and an invitation sent
  from a company's window links that company (`connections/onboarding.ts`, `people/onboarding.js`).
- What an organization calls a branch and a region comes from terminology (`terminology-settings.ts`,
  `platform-terminology.js`), and settings search shows the organization's own words.
- A person's, group's or outside company's window has a Branches section with a change menu, and the branch filter
  can add everyone a list shows to, move them to, or take them out of one branch (`people/branches.js`, one
  `organization-branches.membership.set` each).
- Appointment departments must belong to the event's branch (`appointments/department-access.ts`).

### Also

- The time clock is described as an app option, and the retired key `custom-fields.m_04d80605ab674b` is removed from
  the language packs.
- The localization outputs, the settings search index and the access gates snapshot were regenerated from these
  sources in a clean worktree.
- A new [optimization backlog](../../docs/optimization-backlog.md) entry, "Payroll bills and payment routes read whole
  collections", records the full scans in payables and export templates.

## Tests in the release

Added: `labor-pay-sheets` (extended), `pay-sheets-editor-browser`, `payroll-payables`, `payroll-export-templates`,
`payroll-bills-templates-browser`, `payroll-reimbursement-settlement`, `user-archive`, `company-onboarding`,
`branch-terminology`. Updated: `publication-custom-fields`, `payroll-api`, `payroll-off-cycle-exports`,
`collaboration-api`, `people-settings-browser` and the access gates snapshot.

## Rollout

Tooling: `output/people-payroll-gaps-20261019/` (`candidate.py`, `commit.py`, `prepare.py`, `host-tree.py`,
`host-overlay.py`, `host-regen.py`, `build-payload.py`, `rollout.py`, `deploy.py`, `restart-platform-worker.py`).

- The commit was built from HEAD plus only this session's files through a temporary index (`candidate.py`), so other
  sessions' uncommitted work in the shared checkout stayed out of it.
- The audit (`prep-*.log`) found all four roles on `702908be`, newer than the release's base. The payload is the
  release's files, each merged three ways onto the role's live copy with `f709807f` as the base.
- Clean three-way merges: the 15 language packs, `platform/api.ts` and `permission-bundles.ts` on every role,
  `portal/index.php` on legacy, web and pool, and `crew/app.js` on legacy.
- Merges by rule: `publication/coverage.ts` word by word on every role, and `firstmate-apps-manifest.js` on legacy,
  web and pool, where this release's bundle versions were moved on the live line and its new bundles (the three pay
  sheet scripts and `people/onboarding.js`) were put in front of the bundle that follows them.
- Generated files were regenerated per host. Each role's live source tree was listed and fetched (`host-tree.py`), the
  payload laid on top (`host-overlay.py`), and the settings search index and localization catalogs rebuilt against
  that tree until their checks passed (`host-regen.py`, into `host-gen/<role>/`). Only those regenerated files ship
  for the generated paths: 61 on legacy, web and pool; on the worker only the `public/v1` ones (catalog source,
  coverage and the terminology contract, which is also copied under `dist/`).
- Staged 173 files on legacy, web and pool and 105 on the worker, counting the compiled `dist/` copies of each
  TypeScript file (`stage-*.log`). Staging checks each file's hash, `node --check` for JavaScript, `php -l` for PHP,
  that each compiled copy matches its source, and a Linux `tsc --noEmit` on the staged tree.
- Staged and activated role by role (the stage logs run worker, legacy, web, pool). Each activation waits for the role's readiness on the new release
  (development data, outbound safety enforced); after pool the public `dev.1m8.ai/v1/health/ready` had to answer
  twice in a row. Verified `c255dda3` on all four roles.
- The platform worker (`firstmeasure-development-platform-worker.service`) was restarted and is active on the new
  release (`restart-platform-worker.py`).
