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

- `time_shifts`, `time_clock_events` and `time_shift_changes` — the whole time
  clock; see [Time clock](#time-clock).
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

## Defaults

`payroll/pay-rules.ts`. A **pay default** is a pay setup shared by every payee a
subject covers. It has the same entries as a payee's own setup and sits
underneath it. Subjects, lowest first:

1. `organization` — everyone;
2. `assignee_kind` — all users, all groups of users, or all outside companies;
3. `worker_classification` (users) — employees or independent contractors;
   `group_kind` (groups) — groups of one kind.

A payee's pay is these layers and then their own setup (`payLayersFor`). Each
layer can add to, change or remove what the layers below brought, so a person
keeps following their default except where their own entries say otherwise.
Rules from different layers add up; nothing has to be reconciled between them.
A refresh covers everyone a default reaches, not only payees with a setup of
their own. Defaults deliberately do not attach to access roles or assignment
tags: those mean other things, and giving someone a permission or a scheduling
tag must not change what they are paid.

## Groups: paid as one, or split

A group of users is one payee by default. Its setup, or a default for its kind,
may carry `distribution`: dated settings, each `as_one` or `split`, where a
split is `equal` among the group's active members or by fixed `shares` per
user. The setting in effect on the day an earning was earned applies.

With a split, the group's rules still decide what was earned, and each line is
posted to the members in whole cents that add up exactly. Every such entry
names the group and the line it is a share of. Who shared an earning is fixed
when it is first worked out: someone who joins later shares only new work, and
changing the setting never moves pay already earned. A split with no active
members is unresolved, not paid to nobody.

## Pay schedules

`payroll/schedule.ts`, `payrollRecurrenceSchema`. When a schedule pays is data:
a `frequency` (`daily`, `weekly`, `monthly`, `quarterly`, `yearly`, with
`biweekly` and `semi_monthly` as the common cases by name) repeated every
`interval`, and within it pay days chosen by weekday (`weekday`, `weekdays`),
by day of the month (`day`, `days`; negative counts back from the end, so -1 is
the last day), or by position (`nth_weekdays`: the 3rd Thursday is
`{ nth: 3, weekday: 4 }`, the last Friday `{ nth: -1, weekday: 5 }`). `months`
limits the months, and `adjust` moves a pay day off a weekend. A pay run can
only be created on a day its schedule pays on.

Which schedule applies is a policy, and a policy may name one kind of earning,
so commissions can be paid on the 3rd Thursday while hours are paid every
Friday. The schedule only decides when an earning is paid; when it was earned
comes from the rule.

## Salary

A salary is a pay rule with no inputs: an amount on a cadence. It is earned by
the day (`period: "day"`, `always: true`), so someone who starts or gets a
raise mid-month is paid correctly without proration, and it is paid whenever
the payee's schedule says. Because a formula has no calendar, each period
carries `days`, `weekday`, `day_of_month`, `month`, `year`, `days_in_month` and
`days_in_year`. The sample `salary` rule divides an annual amount across the
days of the year, or across weekdays only.

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

The time clock is data about when somebody worked, when they clocked in and
out, and where they were. It knows nothing about pay, and nothing about pay
decides who may use it.

**Who may clock.** The time clock permission (`crew.time_clock.use`, which also
sets the `time_clock_enabled` parameter of the field overview) and nothing
else. Someone on a salary, on piece rates or with no pay set up at all can
clock if their role lets them. Whether clocked hours are paid is only a
question of whether the person's pay rules select the published clock.

**What is published** (`payroll/time-clock-sources.ts`). Everything the clock
collects, as three selectable collections. Every row has a string `id`, an
`assignee_key` (`organization_user:<id>`), `user_id`, `project_id`, and a
`revision` that is a hash of the row's content, so it changes whenever anything
in the row does.

- `time_shifts` — one row per shift, open or closed.
  - `status` (`active`, `closed`), `clocked_in_at`, `clocked_out_at`,
    `timezone`, `source`, `shift_revision` (the stored counter that the
    timesheet routes take as `expected_revision`).
  - `break_seconds` (finished breaks), `break_count`, `on_break`,
    `active_break_started_at`.
  - `elapsed_seconds` and `worked_seconds` (net of breaks), **closed shifts
    only**.
  - `clock_in` and `clock_out` (`clock_out` once closed): `event_id`,
    `occurred_at`, `location_status` (`captured`, `denied`, `unavailable`),
    `latitude`, `longitude`, `accuracy_meters`, `location_captured_at`,
    `location_reason`, and `distance_to_project_meters` when both the event and
    the project have a place. A number that is not known is left out rather
    than published as zero.
  - review: `approval_status` (`active`, `pending`, `approved`, `rejected`),
    `approved_at`, `approved_by_user_id`, `rejected_at`, `rejected_by_user_id`,
    `manager_note`, `corrected`, `correction_count`, `last_corrected_at`,
    `last_corrected_by_user_id`.
- `time_clock_events` — one row per event: `action` (`clock_in`, `break_start`,
  `break_end`, `clock_out`), `occurred_at`, `shift_id`, `shift_status`,
  `shift_approval_status`, the same place fields as above (flat, not nested),
  `break_seconds` on a break's end, `automatic` and `automatic_reason` when the
  clock made the event itself (a break closed by clocking out), and what
  recorded it: `timezone`, `source`, `client_path`, `ip_address`, `user_agent`.
  An event's `project_id` is its shift's, so a corrected shift carries its
  events with it.
- `time_shift_changes` — one row per thing a manager did to a shift, in order:
  `id` is `<shift id>:<sequence>`, with `action` (`corrected`, `approved`,
  `rejected`, `pending`), `actor_user_id`, `at`, `note`, and for a correction
  the clock times, break and project `before` and `after`. Rows are only added.

All three are answered by listing and need `manage_payroll` or
`manage_company_settings`, the same as the timesheet screens.

**A shift still on the clock** is published so anything can see who is working
and where, but without `elapsed_seconds` or `worked_seconds`, and with only
finished breaks in `break_seconds`. Those durations move every second while
nothing about the shift is recorded as changing, so a published value would
drift under an unchanged revision, and a revision made to follow the clock
would make every reading look like a change and re-run every rule that read it.
A consumer that wants a running total works it out from `clocked_in_at` at its
own stated instant. Starting or ending a break, and clocking out, do change the
row and its revision.

**Distance** is worked out from the project's own location when the row is
read. Correcting a project's location therefore changes the rows that carry a
distance, and their revisions, so rules that select on it are worked out again.

**Pay.** Approving a shift does not post pay. Approval, correction and
rejection change the published rows, and the payee's rules price them at the
next refresh; a change to a shift that was already paid comes out as a
correction. There are no fields made for pay: the sample hourly rule selects
approved shifts and adds up `worked_seconds`, and a rule that pays only hours
clocked in on site selects
`clock_in.distance_to_project_meters less_or_equal 150` in exactly the same
way. Rates live in pay rule parameters.

The payroll timesheet screens (`payroll.timesheets`, approve, correct, reject)
manage this data; they are not a pay system.

## Published

Data (provider `payroll`): the sources above, `pay_rules`, `pay_plans`,
`pay_setups`, `pay_setup` and `pay_units` (target id `type:id`; what each rule
last worked out for a payee and why anything is unresolved).

Actions: `payroll.payRule.save`, `.archive`; `payroll.payPlan.save`,
`.archive`; `payroll.paySetup.preview`, `.save`; `payroll.earnings.refresh`;
`payroll.correction.decline`. All need `manage_payroll` or
`manage_company_settings`. The browser reaches them through `PayrollAPI.pay`.

## Not built

- An editor for rules, plans and setups, and a review screen for held
  corrections. Today they are managed through the published actions.
- Any screen in user, group or outside-company management for how someone is
  paid. The compensation profile editors that used to sit there were removed
  with compensation profiles; until the replacement exists, pay is set only
  through the published pay actions.
- An index for the time clock collections. A selection reads every shift or
  event and filters, up to the host's 50,000-row scan limit.
- Labor line suggestions from an assignee's rates. A labor category's
  `piece_rate` and `hourly_labor` line item sources (`materials/resource-types.ts`)
  used to read the assigned group's compensation plan and now suggest nothing;
  they need pointing at the assignee's pay sheet or removing.
- The `compensation` object on a labor list and on a scope template's labor
  piece (pay mode, estimated hours) is still stored and copied but nothing
  reads it: a labor list's projected cost is its own priced lines.
- Change feeds on the sources, so a refresh still selects every input.
- Projected (not yet earned) earnings from rules.
- Splitting a group's pay by the hours each member worked. Equal and fixed
  shares exist.
- Defaults by an assignee type. There is no single type shared by users, groups
  and outside companies yet, so defaults attach to what is single-valued today
  (see "Defaults").
- A completion signal on labor commitments. `released` covers both finished
  work and work taken back, so the sample rule pays on release.
- Running projects created before this change may still hold bindings to the
  removed `payroll.commission.*` automations; those bindings fail when reached.

Run `tests/pay-rules.test.ts`, `tests/pay-defaults.test.ts`,
`tests/pay-cadence.test.ts`, `tests/pay-rules-store.test.ts`, `tests/pay-sources.test.ts`,
`tests/publication-select.test.ts` and `npm run test:payroll` for changes here.
