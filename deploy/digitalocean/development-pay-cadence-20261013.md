# Pay cadence, salary, defaults, group splits and the time clock as data (development)

Development rollout of commit `efa95d76` on
`codex/consolidated-firstmeasure-20260923`. Not a production activation and no
production change was made. It follows
[the pay rules rollout](development-pay-rules-20261013.md); the model is in
[pay rules](../../docs/architecture/pay-rules.md).

## What changed

- **Pay schedules** accept any cadence as data: weekdays, days of the month
  (counting back from the end too), positions such as the 3rd Thursday,
  intervals, named months and weekend moves. A pay run can only be created on a
  day its schedule pays on.
- **Salary** is a pay rule with no inputs, earned by the day. Each period hands
  a formula its calendar facts.
- **Pay defaults** layer under each payee's own setup (organization, all users /
  groups / outside companies, employees or contractors, group kind). A refresh
  covers everyone a default reaches.
- **Groups** are paid as one or split among members (equal or fixed shares),
  dated, with the split fixed when an earning is first worked out.
- **Review reads:** unresolved earnings and corrections awaiting a person can
  be read for the whole organization at any time.
- **Time clock:** shifts (open and closed), every clock event with where it
  happened, and the review and correction trail are published and selectable.
  Who may clock follows the time clock permission and nothing about pay.
- **Removed:** compensation profiles (module, table access, inputs and outputs
  on users, groups and outside companies, their editors and capability), the
  legacy `/v1/labor` crews API and its migration.
- **Payroll settings:** a schedule editor for every cadence with a pay-date
  preview and correction policy, and pay plan and pay rule management.
- **Payroll tab:** refresh earnings, unresolved items, why a payee is paid what
  they are, held corrections review, off-cycle back pay.

## Not in this release

`public/libraries/apps/materials/project.js` is unchanged here. Its
compensation clean-up sits in the working tree interleaved with another
session's uncommitted scheduling work and ships with that. Until then the
Project tab still shows its pay-mode controls, which no longer affect cost, and
its labor estimate breakdown does not list salaried-time (`cost_rate`) rows,
though the total includes them.

## Checks

- In a clean worktree at the commit: TypeScript check passes; 77 backend tests
  and 5 browser tests pass (pay rules, defaults, cadence, storage, sources,
  selections, payroll API and publication, permissions, actions, coverage,
  automation contracts, crew, workforce, payroll store, labor, and the Payroll
  settings and Payroll tab browser tests).
- `tests/pay-rules-store.test.ts` passes on SQLite and embedded PostgreSQL.
- Not passing, and not caused by this change: six `payments-api` cases fail on
  retired proposal-link signing (the rewritten expense projection case in that
  file passes); other suites noted in the previous record are unchanged.
- Neither payroll UI has been exercised against the real backend in a browser.

## Rollout

Staged then activated one role at a time: worker, compatibility, web, pool.
Each stage ran the host's TypeScript check on the merged tree. All four roles
verified on release `efa95d76351665b2559837d9a3a184c191bfa949`. A check on the
web host confirmed the new exports and action are registered, the third
Thursday resolves to the right dates, the split column exists on the
development database and the compensation gate is gone.

The hosts' `settings/company.js` runs an older form of the user profile save
than the branch; the merge kept the hosts' form and removed compensation from
it.

## Left on the hosts

- Files deleted in the repository remain on the hosts, unreferenced:
  `compensation/*`, `workforce/legacy_migration.ts`, `labor/api.ts`,
  `labor/storage.ts`, and those listed in the previous record.
- The `compensation_profiles` and `payroll_project_payees` tables still exist
  on the development database and are no longer read.
