# Pay rules, pay plans and earnings

Payroll keeps track of who needs to be paid what, and when. It does not move
money, calculate tax or file anything; its pay runs are what a company hands to
its payroll or accounts-payable software.

Anyone work can be assigned to can be paid: a person, a group of users paid as
one, or an outside company ([assignees](assignees.md)). Employees and
subcontractors go through the same rules, ledger and pay runs and are only
shown, and handed off, separately.

## The pieces

| Word | Meaning |
|---|---|
| **Pay rule** | One formula with declared inputs. It says what was earned and on which day. |
| **Pay plan** | A named group of pay rules, for assigning the same pay to many people quickly. |
| **Pay setup** | One payee's own list: the plans they are on, and rules added, removed or changed for them. |
| **Earning** | One line a rule produced: an amount, the day it was earned, and why. |
| **Pay schedule** | When a payee is paid (weekly, twice a month, …). It turns an earned date into a pay date. |
| **Pay run** | The earnings one schedule pays on one date, per payee. Never edited once paid. |
| **Pay sheet** | An assignee's piece-rate table for labor lists ([pay sheets](pay-sheets.md)). A pay rule pays what a committed list came to. |

"Commission" is one use of a pay rule, not a separate system. Scope templates
hold no pay logic and there are no project payee roles.

## Who is paid for a role on a project

A role on a project is a project custom field that holds an assignee
(`organization_user` when it must be one accountable person, `assignable_subject`
when a group or outside company may hold it). The standard scopes already
declare `assignments.estimator` and `assignments.inside_salesperson` and fill
them from the sales appointment. A rule then selects "every project where that
field names this payee". To pay a new role: add the field, add an automation
that sets it when the relevant thing happens (`project.patch.v1` on the
trigger, or a field default), and write the rule against the field.

## A pay rule

`payroll/pay-rules.ts`. A rule's definition has:

- **grain** — `record`: one earning per row of its primary input (a commission
  per sold project, a payment per released labor commitment). `period`: one per
  calendar `day`, `week`, `month`, `quarter` or `year` (hours with weekly
  overtime, a tiered bonus on the month's count, a salary).
- **inputs** — up to eight named [declared selections](data-publication.md#declared-selections)
  over published collections. `where` values and source `args` may use
  `$payee.key` (`type:id`), `$payee.type` and `$payee.id`. A rule never filters
  in its own code and can read nothing it did not declare.
- **earned date** — for a record rule, `earned_at` names the field of the
  primary row holding the date it was earned; a row without that date has not
  been earned. A period rule's earnings are earned on the period's last day,
  and only once that day is over. The date is data, not something the formula
  decides, so the version of the rule in effect on that day can be found before
  anything is run.
- **parameters** — named numbers and switches (a rate, a threshold) that a plan
  or a payee sets without touching the formula.
- **code** — the body of a function run in the document-module sandbox, once
  per record or period, with `unit`, `params`, `payee` and `shared`. It returns
  cents, `{ amount_cents, key?, description?, details? }`, a list of those, or
  null. It cannot read the clock, fetch, or act. A formula that throws or
  returns something that is not whole cents leaves that record or period
  **unresolved** with the reason; it is never paid as zero and whatever was
  posted before stays.

`unit` is `{ record, earned_at }` for a record rule and
`{ period: { key, from, through }, rows: { <input>: [...] } }` for a period
rule. Inputs that are not the primary input (record rules) or have no `date`
(period rules) arrive whole as `shared`.

Period boundaries are cut in the rule's `timezone`, else the timezone of the
payee's pay schedule, else UTC.

### Sources published for rules

Provider `payroll`, organization scope, `manage_payroll|manage_company_settings`
(`payroll/pay-sources.ts`):

- `time_shifts` — closed time clock shifts with `assignee_key`,
  `worked_seconds`, `approval_status`, clock times and `project_id`.
- `project_records` — every project with its stored custom field values under
  `fields`, and under `assignee_keys` the same paths for assignee fields as
  lists of `type:id` (match with `contains`, which covers one-valued and
  many-valued fields alike). With `args: { "facts": true }` each row also has
  indexed `sold_at`, `completed_at`, `canceled_at` and money in cents; that
  reading is `pending` until project indexing has finished.
- `labor_commitments` — committed labor lists with `assignee_key`, `status`,
  `total_cents`, `unpriced_lines`, `committed_at`, `released_at`.

A rule may select from any other listable published collection its author can
read. `payroll/sample-pay-rules.ts` holds a starting library (hourly from the
time clock, committed labor, estimator and inside-sales commissions) and plans
that group them; development Instant Full Orgs are seeded with it.

## Versions and effective dates

Rules and plans keep every version with the date it takes effect. A setup's
entries each have `effective_from` and optionally `effective_through`, and
record who entered them and when. An earning is worked out with whatever was in
effect on the day it was earned, so a promotion or a new rate never changes
what earlier work paid.

A setup entry is one of:

- `plan` — use a plan;
- `add` — one more rule, with parameters;
- `remove` — take one rule out;
- `override` — change one rule's parameters, or swap its formula for another
  rule's (`replacement_rule_id`).

Plans are referenced, not copied, so a change to a plan reaches everyone on it
except where a person has their own replacement for that one rule. Most
personal deals are a parameter override and keep following the shared formula.
A swapped rule keeps the original rule's id as its slot, so what it earned
before and after the swap is compared rather than paid twice.

**Backdating** is an entry or version with a past effective date.
`payroll.paySetup.preview` reports what a setup would change, earning by
earning, without changing anything. After saving, the differences are posted as
corrections; nothing already paid is edited.

## Earnings are derived

`payroll/pay-refresh.ts`. A refresh works out, for each payee, what their rules
say and makes the ledger agree:

1. For every rule a setup could bring in, the inputs are selected and split
   into records or periods.
2. Each record or period has a digest of the rule version, the parameters and
   the key and revision of every row it reads. If the digest is unchanged the
   formula is not run.
3. Changed ones run in the sandbox. For each earning line the ledger total for
   that rule, record or period, and line is compared with the new amount and
   only the difference is posted, as a new ledger entry.
4. A record that left the selection, or a period or rule that no longer
   applies, has what it posted taken back the same way.

An input that cannot be read (`pending`, denied, too large) leaves that rule
unresolved for the payee and takes nothing back: could not read is not zero.

What each earning read is stored in `pay_rule_evidence`, keyed by source row.
Reading the rows is a scan today. When sources publish a change feed, a refresh
can look up the earnings a changed row affects instead of selecting again; the
rules and their stored results do not change.

### Corrections

A difference on an earning that has not been in a pay run yet simply joins the
same run. Once any part of it is in a run, the payee's schedule decides
(`metadata.correction_policy` on the schedule: `{ "increase": …, "decrease": … }`):

- `next_run` (default for increases) — accrued now and paid on the next run,
  marked `back_pay`;
- `off_cycle` — the same, marked `off_cycle_requested` for an off-cycle run;
- `hold` (default for decreases) — posted as a projected entry marked
  `review_required`. Accrue it to accept it (`payroll.projection.accrue`), or
  decline it (`payroll.correction.decline`); a declined correction stays
  settled and is not raised again.

Every correction records the day the earning was originally earned. Negative
amounts are clawbacks or adjustments and are capped per check and carried
forward by the existing pay-run rules.

### When a refresh happens

- before a pay run is drafted;
- when someone asks (`payroll.earnings.refresh`, one payee or everyone);
- when an automation asks (`payroll.refreshEarnings.v1`), for example an
  organization rule on a schedule that refreshes and then notifies.

`payroll.earnings.changed` is emitted per payee whose pay a refresh changed, so
notifications are ordinary automations on that event. Reads never refresh.

Reads behind a refresh run as the person who last saved each rule, with their
current permissions. If that person can no longer read an input the rule is
unresolved until someone saves it again.

## Time clock

Approving a shift no longer posts pay. Approval, correction and rejection
change the published shift, and the payee's rules price the hours at the next
refresh; a change to a shift that was already paid comes out as a correction.
Compensation profiles still decide who sees the time clock; rates live in pay
rule parameters.

## Published

Data (provider `payroll`): the three sources above, `pay_rules`, `pay_plans`,
`pay_setups`, `pay_setup` and `pay_units` (target id `type:id`; what each rule
last worked out for a payee and why anything is unresolved).

Actions: `payroll.payRule.save`, `.archive`; `payroll.payPlan.save`,
`.archive`; `payroll.paySetup.preview`, `.save`; `payroll.earnings.refresh`;
`payroll.correction.decline`. All need `manage_payroll` or
`manage_company_settings`. The browser reaches them through `PayrollAPI.pay`.

## Not built

- An editor for rules, plans and setups, and a review screen for held
  corrections. Today they are managed through the published actions.
- Change feeds on the sources, so a refresh still selects every input.
- Projected (not yet earned) earnings from rules.
- Splitting a group's pay among its members; a group is one payee.
- Default plans by role, worker type or group. A setup is per payee.
- A completion signal on labor commitments. `released` covers both finished
  work and work taken back, so the sample rule pays on release.
- Running projects created before this change may still hold bindings to the
  removed `payroll.commission.*` automations; those bindings fail when reached.

Run `tests/pay-rules.test.ts`, `tests/pay-sources.test.ts`,
`tests/publication-select.test.ts` and `npm run test:payroll` for changes here.
