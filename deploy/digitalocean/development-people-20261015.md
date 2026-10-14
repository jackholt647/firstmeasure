# Development rollout: assignee base, pay by role and type, field homes and People settings

Development only. No production host, data or topology was touched.

- Commit: `04ff6ca377b84f793c140add76ec778cf49d4b8e` on `codex/consolidated-firstmeasure-20260923`, built on `db215173`.
- Live on all four development roles (worker, legacy, web, pool) as release `04ff6ca377b84f793c140add76ec778cf49d4b8e`.

## What changed

- **Assignee base** (`public/v1/assignees/`, [guide](../../docs/architecture/assignee-base.md)): one contract for users,
  groups of users and outside companies, with traits, a published directory, a roster resolved from assignment
  entries, time off and staffing requirements that warn and never block. A user's types are their roles; a group has
  one type whose `member_role_ids` are given on joining; an outside company has any number of company types.
- **Pay** ([guide](../../docs/architecture/pay-rules.md)): defaults layer by organization, kind, worker
  classification, role, group type and company type under the payee's own setup. The pay schedule is chosen on the
  same ladder. Groups are paid as one or split by equal parts, shares or a split rule. Rule, plan and default changes
  can be previewed.
- **Field homes** ([guide](../../docs/architecture/custom-fields.md)): people field definitions live on a role, a group
  type, a company type or one department. One shared definitions editor, values form and read-only renderer. New
  `department` field type. The `timezone` field type written by another session shares lines with this work in
  `custom_fields/contracts.ts` and the browser library and shipped with it.
- **People settings** (`public/libraries/apps/people/`): Overview, Users, Groups, Departments and outside companies on
  shared list, modal, permissions, compensation and fields panels.

## Removed

- Payroll policies: the table, routes, published export and actions, and the per-person assignment panel in payroll
  settings. The payroll store schema version is 4, which drops `payroll_policies` on PostgreSQL.
- The old Users, Departments and Crews and Subcontractors settings code in `settings/company.js`, plus
  `settings/firstmeasure-users.js`, `settings/departments.js` and `tests/users-menu-browser.test.mjs`. The rollout
  tooling does not delete files, so the two retired scripts remain on the hosts unreferenced.

## Checks

Run from a clean worktree at the commit's content (rebuilt once onto `db215173`, which changed only customer portal
files).

- `npm run check`: clean. The hosts' own type check passed at staging.
- Server tests passing: assignee-base 9, assignee-roster 6, assignee-base-store 1, pay-rules 2, pay-defaults 1,
  pay-splits 1, pay-cadence 2, pay-rules-store 1, pay-sources 1, payroll-publication 1, publication-permissions 3,
  publication-coverage 1, publication-actions 10, custom-fields-homes 4, custom-fields-service 3,
  scoped-custom-fields 2, user-custom-fields 2, publication-custom-fields 2, labor-commitments 6, labor-pay-sheets 3,
  publication-select 1, platform-payroll-store 1, appointment-booking 5.
- payroll-api 7, workforce-api 9, crew-api 14, money-round2 5 and persona-templates 5: every case passes, but in the
  clean worktree the test process does not exit afterwards (a FirstMeasure job worker loop keeps polling a table the
  fresh storage does not have). Not investigated further; these files do not touch that runtime.
- Browser tests passing: people-settings-browser 16 (three runs), people-fields-panel-browser 1,
  people-compensation-panel-browser 1, custom-fields-surfaces-browser 3, payroll-settings-browser 1,
  payroll-pay-rules-browser 1, payroll-widgets-browser 1, departments-browser 2, document-settings-browser 2,
  user-custom-fields-browser 1, settings-search-dropdown-browser 1, settings-pane-visibility-browser 1.
- Failing before and after this change: publication-widget-types "summary reads" (1), settings-layout-contract (2),
  navigation-contract (7).

## Rollout

- The hosts carried other sessions' deployed, uncommitted edits in four of the same files. `settings/company.js`:
  their edits inside the deleted Users code went with it and their new Feed section was kept; the merged file has no
  undefined names. `permission-bundles.ts` and `coverage.ts` were merged word by word; `bootstrap.ts` keeps both
  sides' registrations.
- Staged, activated (worker, legacy, web, pool) and verified per role.
- Host check on the web role: providers `assignee-directory`, `assignment-roster`, `custom-fields-homes` and
  `custom-fields-company` are registered; the new assignee, field and pay actions exist; `payroll.policies` and
  `payroll.policy.save` are gone; the pay default subjects are organization, assignee_kind, worker_classification,
  role, group_type, company_type.
- `https://dev.1m8.ai/v1/health/ready` returns 200 and the People bundles are served.

## Not done

- People was not opened in a signed-in browser on dev; it has only been exercised by the browser tests.
- The hashed language catalogs still hold the old "User or crew group" label; the library and the source catalog say
  "User group".
- Outside company Onboarding and Documents tabs, link invitations and restoring an archived user have no backend.
