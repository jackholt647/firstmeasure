# Payroll publication and widgets

Payroll is an obligation and payment-tracking workspace. This integration does
not add tax calculation, bank transfers, or new earning recognition rules.

`public/v1/payroll/publication.ts` registers the version 1 payroll provider with
schema version 2 and the payroll action domain during shared bootstrap. The old
flat collection export and standalone upcoming adapter are replaced by typed
domain adapters. The provider exposes ledger entries, schedules, policy
assignments, configuration, project payees, upcoming occurrences, dashboard,
runs, earnings, timesheets, contractor and assignment directories, report
catalog, and generated artifacts. Ledger entries retain payee type, source
evidence, recognition state, eligibility, currency, and remaining balance.
Connected organizations use the existing `organization_connection` payee type.

Payroll management requires the existing `manage_payroll` or
`manage_company_settings` permission and enabled Payroll capability. Personal
earnings are subject-scoped to the signed-in user, including retained snapshot
authorization. Project targets and explicit project filters are checked against
organization ownership. Contractor profile edits additionally require the
existing workforce/company permission. Sensitive workforce fields and file
bytes are excluded from the directory and artifact exports.

Reads do not reconcile commissions, seed roles, create ledger entries, or
generate reports. Scope commission reconciliation is an explicit published
write. Existing business writers handle schedule/policy changes, project payee
assignments, earning posting/accrual/reversal, commission operations, run
creation/approval/payment, timesheet corrections/approval, contractor terms, and
report generation. Published writes require durable idempotency receipts.
PayrollAPI routes the existing browser controls through these actions; binary
downloads retain their authenticated HTTP endpoint.

`platform_list` paginates ledger, run and artifact collections using
query/principal-bound cursors. These are successive observations, not an
immutable global snapshot. Dashboard and earnings reports retain domain limits
and truncation indicators; reads do not invent missing obligations.

The shared widget catalog contains six native view widgets (`payroll.upcoming`,
`timesheets`, `contractors`, `exports`, `history`, `settings`) and six detail
widgets (`ledger`, `commissions`, `earnings`, `my_earnings`, `project_payees`,
`batch`). The Payroll tab mounts those same native leaves. Agents discover
their sources and configuration through the standard widget registry and
present them through `platform_show_widget`. Each instance owns its filters,
visibility, refresh lifecycle and cleanup. Access is rechecked on reads, and
failed refreshes clear previously displayed payroll values.

This completes publication wiring of the existing domain, not its functional
coverage. Crew obligation creation, group allocation semantics, and contractor
payable synchronization on changed/voided runs need a separate domain review.
Forecasts describe recorded projected entries; an empty forecast or missing
schedule does not establish that nothing is owed.

Validation: payroll publication/domain tests, publication permission/widget
tests, full publication suite, TypeScript check, and a browser test exercising
all six native leaves, independent instances, mutation receipts, revoked access
cleanup, and mobile layout.
