# Payroll API v1

The payroll domain is the durable source of truth for pay-cycle configuration,
earned and projected compensation, commissions, clawbacks, payroll batches, and
per-payee payment history. It deliberately remains separate from project
payment collection and from compensation-rate configuration.

## Model

- A **schedule** is a top-level payroll group. Two schedules that happen to pay
  on the same date remain separate. Hourly, salary, piece-rate, and commission
  entries assigned to the same schedule remain together as subgroups.
- A **policy** assigns a schedule to an organization default, worker
  classification, access role, resource group, user, or organization
  connection. Policies may target all earning kinds or one component. Direct
  payee policies take precedence; ambiguous same-level policies are rejected.
- A **project payee role** is a named array of typed payees such as `estimators`
  or `booked_by`. Scope-template automations can address these roles.
- The **ledger** stores signed projected or accrued entries. Accrued entries are
  immutable. Corrections and commission cancellations append negative
  adjustment/clawback entries.
- A **batch** snapshots accrued entries eligible for one schedule occurrence.
  Each payee can be marked run or paid independently. Batch history is durable.

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
- `GET /v1/payroll/organizations/:orgId/policies`
- `PUT|DELETE /v1/payroll/organizations/:orgId/policies/:subjectType/:subjectId`
- `GET /v1/payroll/organizations/:orgId/policies/effective/:payeeType/:payeeId`

Projects and earnings:

- `GET /v1/payroll/organizations/:orgId/earnings/me`
- `GET /v1/payroll/organizations/:orgId/earnings/payees/:payeeType/:payeeId`
- `GET /v1/payroll/organizations/:orgId/earnings?payee=organization_user:user_1&payee=organization_user:user_2`
- `GET /v1/payroll/organizations/:orgId/projects/:projectId/payees`
- `PUT /v1/payroll/organizations/:orgId/projects/:projectId/payees/:roleKey`
- `POST /v1/payroll/organizations/:orgId/projects/:projectId/commission-events`
- `POST /v1/payroll/organizations/:orgId/projects/:projectId/commission-overrides`
- `GET|POST /v1/payroll/organizations/:orgId/ledger`
- `POST /v1/payroll/organizations/:orgId/projections`
- `POST /v1/payroll/organizations/:orgId/projections/:entryId/accrue`
- `POST /v1/payroll/organizations/:orgId/ledger/:entryId/reverse`

Payroll operations:

- `GET /v1/payroll/organizations/:orgId/dashboard`
- `GET /v1/payroll/organizations/:orgId/upcoming`
- `GET|POST /v1/payroll/organizations/:orgId/batches`
- `PATCH /v1/payroll/organizations/:orgId/batches/:batchId/items/:itemId`
- `POST /v1/payroll/organizations/:orgId/batches/:batchId/actions`

## Reusable earnings views

`earnings/me` is the safe self-service route. It derives the organization user
from the authenticated session and never accepts an alternate payee. It is
available to field-only users without granting access to payroll runs,
schedules, policies, or anyone else's compensation.

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

## Scope-template commission rules

Commission formulas belong to the versioned scope-template definition. A rule
chooses a project payee role, an allocation method, a Work lifecycle trigger,
and either a preset calculation or trusted custom code. The preset library
supports percentages, percentages after discounts, discount-rate tiers, fixed
amounts, and selected or excluded line items.

Custom code is an advanced internal implementation path, not the default
customer authoring model. A saved rule is evaluated with JSON-only project,
scope, signed-proposal, Money-summary, Work-event, plan, and node context plus
normalized `context.facts`. Facts include proposal totals, discounts, collected
revenue, forecast profit, and normalized line items. The function must return
an integer `amount_cents`, an award object, an array of award objects, or
`{ awards: [...] }`. Execution is synchronous, time-limited, and cannot use
dynamic code generation; it must not perform I/O or mutate application state.

Scope versions compile these rules to the trusted
`payroll.commission.rule.v1` Work automation. The older lower-level automation
contract remains available for compatible definitions:

Scope-level commission roles use stable internal keys and editable labels.
Roles may be assigned manually or populated from the sales appointment's
assigned user or scheduling user. A rule may also define installments whose
shares total 100%. The full calculated commission is posted as projected when
the scope starts; each installment is accrued only when its configured Work
node reaches the configured lifecycle hook.

The standard Roof Replacement preset defines:

- `estimator`: 10% of total proposal revenue, projected as two equal payments;
  the first accrues when the deposit is received and the second when production
  is completed.
- `inside_salesperson`: a projected $100 booking commission that accrues when
  the deposit is received.

These triggers are independent of the amounts or percentages of the
customer's deposit, progress, and final-payment obligations.

```json
{
  "id": "signed-estimator-commission",
  "automation": "payroll.commission.post.v1",
  "input": {
    "entry_state": "accrued",
    "payee_role": "estimators",
    "amount": {
      "kind": "percentage_pool",
      "rate_bps": 1000,
      "basis_path": "proposal.pricing.total_cents"
    },
    "allocation": "split_evenly",
    "reason": "Proposal signed"
  }
}
```

Fixed pay for each member of a role uses `amount.kind: fixed`,
`amount.amount_cents`, and `allocation: each`. The companion
`payroll.projectPayees.set.v1` automation can populate a project role from a
trusted workflow. Cancellation rules post `state: cancelled` and may specify
`reverses_source_event_id` or `reverses_trigger_id`; otherwise matching project
commission entries for that trigger are reversed.

## Audit and idempotency invariants

- Commission identity includes work event, binding/trigger, and payee, so two
  rules on the same event can pay the same person independently.
- Projected entries may transition to accrued. Accrued entries cannot be edited.
- Draft/run batches reserve their ledger allocations. Voiding an unpaid batch
  releases them; paid items require later correcting entries.
- Schedule, policy, and project-payee configuration use revisions to prevent
  lost updates.
