# Development rollouts: Payroll rebuild, widget catalog revalidation and My pay

Development only. No production host, data or topology was touched. Three releases from
`codex/consolidated-firstmeasure-20260923`, each activated and verified on all four development roles (worker, legacy,
web, pool):

| Release | Built on | Replaced | Tooling |
| --- | --- | --- | --- |
| `57c8a2ea8f70c25bfbc4e1b22ceac515da4a50ab` Payroll rebuild and People worker classification | `780c8375` | `b5d02390` (legacy, web, pool), `b3347716` (worker) | `output/payroll-rebuild-20261015/` |
| `07544bd59b842341fe1d5496563c0f4f7b21a424` widget runtime revalidates `catalog.json` | `57c8a2ea` | `57c8a2ea` | `output/catalog-fix-20261015/` |
| `81df90e7618d88cee5f40a3137327082846df966` My pay, reimbursements, optional pay run approval | `dbe0b1fb` | `dbe0b1fb` | `output/payroll-mypay-20261015/` |

## 57c8a2ea: Payroll rebuild and People worker classification

- Payroll (`public/libraries/apps/payroll/app.js`) is rebuilt around its views: Upcoming, Review, Timesheets, Payees,
  History, Exports, Approvals, Mine and Settings.
- Pay runs have named approvals, and a named approver decides without payroll permission (`payroll.batch.decide`,
  `payroll.my_approvals`, `payroll.approvals.mine`).
- Payments made outside a pay run are recorded and taken off the next one (`payroll/off-cycle.ts`,
  `payroll.off_cycle_payments`). Work orders finalized to be paid are listed for payroll (`payroll/finalized-work.ts`,
  `payroll.finalized_work`).
- Your own timesheets need only the time clock permission (`payroll.my_timesheets`, `payroll.timesheets.me`,
  `crew.time_clock.use`). Payee lists are limited to the branches the viewer may see (`payroll/payee-scope.ts`).
- Exports include Gusto and QuickBooks pay run files. Payroll settings have one home, the Payroll app's Settings view;
  company settings link there. People opens from Payroll in the People entity modal.
- People: a person is an employee or an independent contractor, seen and changed with Compensation; contractors are
  marked beside their name.
- Docs: [pay rules](../../docs/architecture/pay-rules.md) and `public/v1/payroll/README.md`.
- Tests added or updated with the commit: payroll-off-cycle-exports, payroll-api, payroll-publication, and browser
  tests payroll-app-browser, payroll-pay-rules-browser, payroll-settings-browser, payroll-widgets-browser,
  people-settings-browser, app-groups-browser, financial-ui-contract, navigation-contract and
  payroll-exports-ui-contract.
- Host merges: `settings/company.js` (all roles, three-way), `coverage.ts` and `permission-bundles.ts` (word by word),
  and `firstmate-apps-manifest.js`, where bundle versions were moved on the live line, the People kit, list page and
  entity modal were put just before `payroll/app.js`, and Payroll's routed views (`payrollView`) replaced on the live
  line. Staged 52 files on legacy, web and pool and 40 on the worker (stage logs in the tooling folder).

## 07544bd5: widget runtime revalidates catalog.json

- The widget runtime fetched `catalog.json` with a fixed version, so browsers kept a copy without the rebuilt Payroll
  views and showed "This widget version is unavailable". `public/libraries/platform-widgets/runtime.js` now fetches
  `catalog.json?v=20261015-payroll-views` with `cache: 'no-cache'`.
- Host merge: the line beside the call differs on the hosts, so the one call was replaced on the live text. Legacy, web
  and pool took one file; the worker takes no browser files and was promoted to the new release id unchanged.

## 81df90e7: My pay, reimbursements protected from deductions, optional pay run approval

- `apps/payroll/my-pay.js` is the one view of a person's own pay: earnings, and projected earnings behind
  `payroll.view_own_projected_earnings`. Crew's earnings and projected section and Sales' commission cards are
  replaced by it, and Payroll shows it as Mine. Sales earnings take the `projected_enabled` parameter like Crew.
- Reimbursements are paid in full: deductions come off earnings only (`deductibleCents` in `payroll/service.ts`).
- Payroll keeps company settings in a new `payroll_settings` table, including whether pay runs need approval
  (`approval_required`, on by default; `payroll.settings.save`). With approval off a run may be marked run or paid from
  a draft unless an approval someone asked for is waiting or was rejected.
- Payroll store schema version 4 -> 5. After activation a read-only probe
  (`output/payroll-mypay-20261015/settings-probe.mjs`) confirmed on dev that the store initializes at version 5 and the
  `payroll_settings` table answers.
- Tests added or updated with the commit: payroll-off-cycle-exports, payouts-projected-browser, payroll-app-browser and
  financial-ui-contract.
- Host merges: `firstmate-apps-manifest.js` (bundle versions moved, `payroll/my-pay.js` put just before Crew, Sales and
  Payroll), `permission-bundles.ts` (word by word), `portal/index.php` script tags (both sides), and three-way merges
  of `crew/app.js` (legacy) and `workforce/access.ts` (legacy, web, pool). Staged 23 files on legacy, web and pool and
  16 on the worker.

## Checks and verification

The rollout folders do not keep test output, so pass counts are not recorded here. For each release
`build-payload.py` refused to build on any unresolved conflict; staging used hardlink clones and checked that the live
files still matched the audited baseline; activation went worker, legacy, web, pool and was verified per role (active
release and `RELEASE_ID` match, every shipped file hash matches, local readiness reports development with outbound
safety enforced), and `https://dev.1m8.ai/v1/health/ready` returned ready twice in a row after the pool activation.

## Not done

- The rebuilt Payroll and My pay were not walked through in a signed-in browser on dev beyond the browser tests.
