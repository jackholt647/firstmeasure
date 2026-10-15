# Payroll API v1

The payroll domain is the durable source of truth for how people are paid (pay
rules, pay plans and each payee's pay setup), what they have earned, pay-cycle
configuration, clawbacks, pay runs, and per-payee payment history. It remains
separate from project payment collection.

Earnings are derived: pay rules read published data and a refresh posts only
the difference to the ledger. Read
[pay rules](../../../docs/architecture/pay-rules.md) before changing how anyone
is paid. There are no commission rules on scope templates and no project payee
roles.

## Model

- A **schedule** is a top-level payroll group. Two schedules that happen to pay
  on the same date remain separate. Hourly, salary, piece-rate, and commission
  entries assigned to the same schedule remain together as subgroups.
- Which schedule pays someone is a **schedule choice** on their pay setup or on
  a pay default (the organization, a kind of assignee, a worker classification,
  a role, a type of group or company). Choices are dated and may name one kind
  of earning; the highest layer that says wins and the exact kind beats the
  catch-all. `resolvePaySchedule` is the one answer. There are no policies.
- A **payee** is any assignee: a user, a group of users paid as one, or an
  outside company. Who is paid for a role on a project is an assignee custom
  field on the project.
- The **ledger** stores signed projected or accrued entries. Accrued entries are
  immutable. Corrections append new entries; a reduction is a negative
  adjustment or clawback.
- A **batch** (a *pay run* on screen) snapshots accrued entries eligible for
  one schedule occurrence. Each payee can be marked run or paid independently.
  Batch history is durable. Every run is approved by named approvers and made
  final before it is marked run or paid.
- A **payment made outside a pay run** is a negative accrued entry of the kind
  it paid (`off-cycle.ts`); the next run takes it off, in full up to what that
  run pays, before any clawback. See
  [pay rules](../../../docs/architecture/pay-rules.md#payments-made-outside-a-pay-run).

Employee and subcontractor items share a batch only when they share the exact
schedule ID, but API responses always keep them in separate sections.

## Recognition and delay

`timing_basis: worked` recognizes each earning from `worked_at`.
`timing_basis: completed` recognizes it from `completed_at`, allowing all work
on a multi-day job to follow the completion period. Schedule delays are applied
after recognition and support both whole pay periods and calendar days.
Cutoffs are calculated at the end of the configured IANA-timezone calendar day.

## Clawbacks

Clawbacks are negative accrued ledger entries. For every check:

```text
maximum deduction = positive gross * clawback_cap_percent
applied deduction = min(outstanding clawback, maximum deduction, gross)
```

Any remainder stays open for a later batch. Payroll never creates a negative
check or initiates a bank debit.

## Main routes

Configuration:

- `GET|POST /v1/payroll/organizations/:orgId/schedules`
- `GET|PATCH|DELETE /v1/payroll/organizations/:orgId/schedules/:scheduleId`

Schedule choices, pay rules, plans, setups and defaults have no HTTP routes of
their own: they are published data and actions (`payroll.pay_setup`,
`payroll.pay_default`, `payroll.paySetup.save`, `payroll.payDefault.save`,
`payroll.paySchedule.resolve`), reached in the browser through `PayrollAPI.pay`.

Projects and earnings:

- `GET /v1/payroll/organizations/:orgId/earnings/me`
- `GET /v1/payroll/organizations/:orgId/earnings/payees/:payeeType/:payeeId`
- `GET /v1/payroll/organizations/:orgId/earnings?payee=organization_user:user_1&payee=organization_user:user_2`
- `GET|POST /v1/payroll/organizations/:orgId/ledger`
- `POST /v1/payroll/organizations/:orgId/projections`
- `POST /v1/payroll/organizations/:orgId/projections/:entryId/accrue`
- `POST /v1/payroll/organizations/:orgId/ledger/:entryId/reverse`

Payroll operations:

- `GET|POST /v1/payroll/organizations/:orgId/off-cycle-payments`, `DELETE .../off-cycle-payments/:entryId`
- `GET /v1/payroll/organizations/:orgId/approvals/me`, `POST .../batches/:batchId/decision` (a named approver; no payroll permission needed)
- `GET /v1/payroll/organizations/:orgId/timesheets/me` (the time clock permission only)
- `GET /v1/payroll/organizations/:orgId/dashboard`
- `GET /v1/payroll/organizations/:orgId/upcoming`
- `GET|POST /v1/payroll/organizations/:orgId/batches`
- `PATCH /v1/payroll/organizations/:orgId/batches/:batchId/items/:itemId`
- `POST /v1/payroll/organizations/:orgId/batches/:batchId/actions`

## Reusable earnings views

`earnings/me` is the safe self-service route. It derives the organization user
from the authenticated session and never accepts an alternate payee. It is
available to field-only users without granting access to payroll runs,
schedules, or anyone else's compensation.

The single- and multi-payee earnings routes retain the normal
`manage_payroll|manage_company_settings` boundary. They use the same report
shape as `earnings/me`, so Crew, sales, and future role-specific apps can render
the data differently without creating new payroll calculations. Reports
include projected, accrued, in-payroll, owed, and paid totals; project groups;
sanitized ledger details; and the caller's payment history. `project_id`,
`from`, `through`, `include_projected`, `entry_limit`, and `payment_limit` are
supported filters.

The browser library exposes the contract as:

```js
PayrollAPI.earnings.me(orgId, options);
PayrollAPI.earnings.forPayee(orgId, payeeType, payeeId, options);
PayrollAPI.earnings.list(orgId, [{ type: 'organization_user', id: userId }], options);
```

## Pay run files

`exports.ts`. The platform does not move money; a pay run is copied out to the
company's payroll or accounting software. Per pay run, CSV unless noted:

| Type | What |
|---|---|
| `pay_run_summary` | Everyone, employees then contractors, earnings by kind, reimbursements, already paid outside a run, clawbacks or corrections, amount to pay; section and run totals. Also PDF. |
| `gusto_employees` | One row per employee: Last Name, First Name, Email, an amount column per kind, Reimbursement, deductions, Total To Pay, dates, note. |
| `gusto_contractors` | One row per contractor or company: Wage, Reimbursement, Total. |
| `quickbooks_payroll` | One row per employee and pay item (Hourly pay, Salary, Piece rate, Commission, Bonus or adjustment, Reimbursement, deductions as negative amounts). |
| `quickbooks_bills` | Contractors as bills: one line per vendor and category (Subcontractor payments, Reimbursements). |

The column headers follow each product's import vocabulary; check the column
mapping on the first import. A viewer limited to some branches exports only
those branches' payees.

## Branch scope

`payee-scope.ts`. With several branches, payee lists (upcoming, runs, ledger,
timesheets, review, off-cycle payments, finalized work, projected totals) leave
out payees of branches the viewer cannot see, and take `branch_ids`
(`mine`, `region`, `all` or ids) like the People lists. Writes about one payee
need the payee in a branch the viewer manages; drafting, asking for approval,
making final, running, paying, reopening or voiding a whole run needs every
payee in it to be. An approval decision is not branch-scoped: the approver is
named on the run.

## Audit and idempotency invariants

- A ledger entry's identity is its source event, trigger and payee. An earning
  from a pay rule uses `pay_rule:<rule>:<record or period>:<line>` as its source,
  so a rule's entries for one earning can always be summed and compared.
- Projected entries may transition to accrued. Accrued entries cannot be edited.
- Draft/run batches reserve their ledger allocations. Voiding an unpaid batch
  releases them; paid items require later correcting entries.
- Schedules, pay rules, pay plans, pay setups and pay defaults use revisions to
  prevent lost updates.
