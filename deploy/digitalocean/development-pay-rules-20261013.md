# Pay rules, pay plans and derived earnings (development)

Development rollout of commit `aeaf7c9f` on
`codex/consolidated-firstmeasure-20260923`. Not a production activation and no
production change was made.

## What changed

- Pay is derived by **pay rules**: a rule declares its inputs as selections
  over published data, runs in the document-module sandbox and returns what was
  earned; a refresh posts only the difference to the payroll ledger. See
  [pay rules](../../docs/architecture/pay-rules.md).
- Rules are grouped into **pay plans** and assigned, added, removed or
  overridden per payee, all effective-dated, with a preview for backdated
  changes. Any assignee (user, group of users, outside company) can be paid.
- Declared selections over published collections
  (`platform/publication/select.ts`), answered by scanning today and by an
  index later without changing callers.
- Published for rules: `payroll.time_shifts`, `payroll.project_records`,
  `payroll.labor_commitments`; pay rule data and actions; the
  `payroll.refreshEarnings.v1` automation and `payroll.earnings.changed` event.
- Removed: scope-template commission rules and their editor tab, project payee
  roles, the `payroll.commission.*` and `payroll.projectPayees.*` automations,
  actions and routes, the project Commissions panel, and pay posted directly on
  timesheet approval.

## Checks

- TypeScript check and 93 affected backend tests pass in a clean worktree at
  the commit (pay rules, pay sources, the storage test, declared selections,
  payroll API and publication, publication permissions/actions/coverage,
  automation contracts, scope event map and artifacts, custom fields, work,
  crew, payroll store, labor commitments). The full publication suite passes
  there (74 passed, 1 skipped).
- `tests/pay-rules-store.test.ts` passes on SQLite and on embedded PostgreSQL.
- Not passing, and not caused by this change: seven other cases in
  `tests/navigation-contract.test.mjs` fail at the parent commit too;
  `payments-api`, `proposals-api` and `platform-workflows` cases fail in the
  shared checkout on retired proposal-link signing and portal queue checks.

## Rollout

Staged then activated one role at a time: worker, compatibility, web, pool.
Each stage ran the host's TypeScript check on the merged tree. All four roles
verified on release `aeaf7c9fe77339bb48de0e06242e7432f1f1a99a` with readiness
and outbound safety enforced. A check on the web host confirmed the new
exports, actions and automation are registered, the retired ones are not, and
the three pay rule tables exist on the development database.

## Left on the hosts

- `public/v1/payroll/commission_rules.ts` (and its compiled file) and
  `public/libraries/apps/payroll/project.js` are deleted in the repository but
  remain on the hosts, unreferenced; the rollout tooling does not delete files.
- The `payroll_project_payees` table still exists on the development database.
  The statement that drops it only runs when the payroll schema version is
  next raised.
- Projects whose scope started before this release may hold bindings to the
  removed commission automations; those bindings fail when reached.
