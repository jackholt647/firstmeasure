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
| **Pay setup** | One payee's own list: the plans they are on, rules added, removed or changed for them, and which pay schedule pays them. |
| **Pay default** | A pay setup shared by everyone a subject covers (the organization, a role, a type of group or company), underneath each payee's own. |
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
  or a payee sets without touching the formula. A parameter may declare its `type`
  (`number`, `boolean`, `text`, `cents`, `basis_points`) so a form asks for it
  properly without guessing: money is typed in whole units and stored in cents,
  a percentage is stored in basis points. A default that does not fit its type
  is refused.
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
read; `payroll.pay_rule_sources` lists them for a picker. `payroll/sample-pay-rules.ts` holds a starting library (hourly from the
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
earning, without changing anything. `payroll.payRule.preview`,
`payroll.payPlan.preview` and `payroll.payDefault.preview` do the same for a
version of a rule, a plan or a default across everyone it reaches
(`previewPayChange`): each payee is worked out with the refresh's dry run as
things are stored and as they would be, and only what differs between the two
is reported, so differences already waiting for the next refresh are not
blamed on the change. A preview works through at most 200 payees and says so
when there are more. After saving, the differences are posted as
corrections; nothing already paid is edited.

## Defaults and layers

`payroll/pay-rules.ts`. A **pay default** is a pay setup shared by every payee a
subject covers. It has the same entries as a payee's own setup, the same
[schedule choices](#when-someone-is-paid), and sits underneath it. Subjects,
lowest first:

1. `organization` — everyone;
2. `assignee_kind` — all users, all groups of users, or all outside companies;
3. `worker_classification` (users) — employees or independent contractors;
4. the payee's **types** ([assignee base](assignee-base.md)):
   - `role` — every user who resolves to that access role today: the roles
     saved on them, or the role inferred for them when none are saved. There is
     no separate user type: a user's roles are their types;
   - `group_type` — groups of users of that kind (a group has exactly one);
   - `company_type` — outside companies with that type (a company may have
     several).

   All three are asked through `assigneeTypeIds`, the one place that knows an
   assignee's types; payroll never reads roles off a record itself.

A payee's pay is these layers and then their own setup (`payLayersFor`). Each
layer can add to, change or remove what the layers below brought, so a person
keeps following their defaults except where their own entries say otherwise. A
refresh covers everyone a default reaches, not only payees with a setup of
their own.

**Several roles, or several company types, apply together.** Each is its own
layer, in order of id, so the order is stable. Rules that differ simply add up:
someone who is both a salesperson and a supervisor is paid by both roles'
rules, and nothing has to be reconciled between them. When two layers name the
*same* rule, the later one replaces the earlier one's parameters for that rule,
as any higher layer does; give two roles two rules if both should pay.

A `role` is checked against the role store and a `group_type` or
`company_type` against the organization's type lists when a default is saved.
`distribution` (paid as one or split) may be set on `organization`,
`assignee_kind: resource_group` and `group_type` only.

### When a role or a type is given or taken away

Roles, a group's type and a company's types have no history of their own, so
payroll keeps the days it saw each default subject cover each payee
(`pay_layer_spans`, `notePayCoverage`):

- the first time a payee's pay is worked out, everything that covers them is
  taken to have always done so;
- after that, a subject that appears covers them **from the day a refresh
  noticed it**, and one that disappears stops covering them **the day before**.

So removing a role stops only what is earned afterwards. Earnings earned while
the role covered someone stay theirs: nothing posted under it is edited, and
nothing is taken back. This is how a setup entry *ended* with
`effective_through` behaves, not how a *deleted* entry behaves (deleting an
entry says it never applied, and what it posted is taken back as corrections).
Given the role again later, it pays from the day that was noticed, not for the
time in between. A layer whose cover has a start or an end carries
`covered_from` and `covered_through`.

Only a refresh that posts records what it noticed; previews and every other
reader see the same answer without writing. Because the day is the day a
refresh noticed, an organization that changes roles often should refresh often
(an organization rule on a schedule does this).

## Groups: paid as one, or split

A group of users is one payee by default. Its setup, or a default that covers
it, may carry `distribution`: dated settings, each `as_one` or `split`. A split
is `equal` among the group's active members, by fixed `shares` per user, or by
a **split rule** (`method: "rule"`, `split_rule_id`, `params`). The setting in
effect on the day an earning was earned applies, and the highest layer that
has one wins, so a kind of group can default to a split and one group can
differ.

With a split, the group's rules still decide what was earned, and each line is
posted to the members in whole cents that add up exactly. Every such entry
names the group and the line it is a share of. Who shared an earning is fixed
when it is first worked out: someone who joins later shares only new work, and
changing the setting never moves pay already earned. A split with no active
members is unresolved, not paid to nobody.

### Split rules

`payroll/pay-rules.ts` (`paySplitDefinitionSchema`), `payroll/pay-refresh.ts`.
How a group's pay is divided is a rule a company sets, for any kind of group:
a production team may pay only the members who were on the job, a sales team
may share a commission whoever was in that day. Nothing in payroll knows what
attendance is. A split rule is a formula with declared inputs, kept beside pay
rules with the same vocabulary (versions with `effective_from`, parameters with
labels and defaults, a formula run evaluate-only in the document-module
sandbox). It returns weights, never money.

```json
{ "inputs": { "shifts": {
    "source": { "provider": "payroll", "export": "time_shifts" },
    "where": { "rules": [
      { "field": "assignee_key", "operator": "in", "value": "$members.keys" },
      { "field": "approval_status", "operator": "equals", "value": "approved" } ] },
    "member": "assignee_key",
    "match": { "project_id": "$earning.project_id" },
    "window": { "start": "clocked_in_at", "end": "clocked_out_at" } } },
  "parameters": { "minimum_minutes": { "label": "Minutes to count as present", "default": 1 } },
  "code": "..." }
```

An input is a [declared selection](data-publication.md#declared-selections)
plus how its rows belong to one earning:

- `where` and source `args` may use `$payee.key`, `$payee.type`, `$payee.id`
  (the group) and the lists `$members.keys` (`organization_user:<id>`) and
  `$members.ids`, for the `in` operator. Which rows are read is all here.
- `member` names the row field holding the member (`type:id`) a row is about.
  Rows about anyone who is not one of the earning's members are not handed
  over.
- `match` maps a row field to something about the earning it must equal:
  `$earning.project_id`, `$earning.unit` (the record or period key),
  `$earning.rule_id`, or `$earning.record.<field>` of a record rule's primary
  row. An earning with no such value (no project) gets no rows.
- `window` places rows in time by exact instants, not whole days, so someone
  off for part of a day is handled as what they are. The window is the earned
  day for a record rule and the whole period for a period rule, cut in the same
  timezone the earning was; `days_before` starts it earlier and
  `any_time_before` leaves the start open. A row is in when the span from its
  `start` to its `end` touches the window, and with `end` declared it carries
  the exact `seconds` that fall inside. A row with no start, or with `end`
  declared and no end yet (a shift still on the clock), is in no window.

The formula runs once per earning line and sees:

- `earning`: `rule_id`, `unit`, `record` (or `period`), `earned_on`,
  `earned_at`, `project_id`, `span` (`from` and `to`, the instants the earned
  day or period starts and ends) and `line` (`key`, `amount_cents`,
  `description`);
- `members`: `[{ key, id, name }]`, the members this earning is divided among;
- `rows`: per input, `[{ row, member?, seconds? }]`;
- `params` and `group`.

It returns an object keyed by member key whose values are a weight or
`{ weight, reason?, details? }`. Weights are any numbers, 0 or more; only their
proportion matters. A member given 0 or left out gets nothing. If every weight
is 0, the formula throws, it names someone who is not a member, or an input
cannot be read, the earning is **unresolved** with the reason: it is never paid
to nobody, never falls back to an equal split, and whatever was posted before
stays where it is. A sandbox has no clock or `Date`, which is why the host
hands over `seconds` rather than leaving time arithmetic to the formula.

**What is fixed and what follows data.** With a split rule:

- *Fixed when the earning is first worked out:* the members it is divided
  among. Membership history is not tracked, so this is the only record of who
  was in the group then; someone who joins or leaves later does not move old
  earnings. An earning that was split equally before a rule was put in place
  from a past date keeps the members it had.
- *Follows data:* the weights. Attendance can arrive or be corrected after the
  earning was worked out (a shift approved late). At each refresh the weights
  are worked out again among the same members whenever something the split
  read has changed, and each member's ledger total for the line is compared
  with their new share. The difference moves between members as
  [corrections](#corrections), each handled as that member's own pay schedule says:
  before a pay run it simply joins the run; after one, an increase is back pay
  and a decrease is held for review by default, so for a while the members'
  accrued shares can add up to more than the line until the held decrease is
  accepted or declined.
- *Also follows:* the split rule's version in effect on the earned day and the
  parameters the distribution sets, like any backdated change.

`equal` and fixed `shares` are unchanged: both members and weights are fixed
when the earning is first worked out.

**Cost.** Each split input is selected once per refresh for the whole group,
with every member any of its earnings could involve, not once per earning. The
rows are sorted once by their `match` fields; handing an earning its rows is an
equality lookup, a member set and a time range, which is exactly what a
provider's index would answer, so nothing here filters in a way an index could
not replace. The earning's digest includes the split rule version, parameters,
members and the key and revision of every row the split was handed, so an
unchanged refresh runs neither formula. Those rows are stored in
`pay_rule_evidence` under the source `split:<input>`. Split formulas run in one
sandbox call per split rule version and parameters, over every changed earning
line.

**What it explains.** Each ledger entry for a member carries
`metadata.split`: the group, the line's amount and, under a split rule,
`method: "rule"`, `split_rule_id`, `split_rule_version`, `params`, the member's
`weight`, the `total_weight`, `share_cents` and the formula's `reason` and
`details`, including on the entry that takes a share back. `pay_units` carries
the same per earning under `split`: the method, the rule, the members, and for
each line every member's weight, cents and reason.

**Samples** (`SAMPLE_PAY_SPLIT_RULES` in `payroll/sample-pay-rules.ts`):

- `present_on_the_job`: members with an approved shift on the earning's
  project on the day it was earned share equally; others get nothing.
  `minimum_minutes` sets how long counts as present, measured in exact time
  inside the day.
- `by_hours_on_the_job`: in proportion to approved `worked_seconds` (net of
  breaks) on that project, counting every shift that started before the end of
  the earned day, however long the job ran. A shift counts whole; hours clocked
  on the project after the day it was earned are not part of that earning.
- `whole_team`: equal among members whatever happened, written as a rule.

The two that read the time clock divide earnings that carry a project (a
record rule naming its `project` field). **A roster source**, when one is
published, is selected the same way and needs no change here: a split rule
reads it in place of, or alongside, the time clock. It is usable when each row
has a stable `id` and a `revision` that changes with the row, names who it is
about as `type:id` in one field, names the piece of work in a field an earning
can match (`project_id`, or the id of the record the pay rule's primary input
publishes), and gives exact start and end instants for the time the person was
on, or unavailable for, the work, with a removal changing or removing the row.

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

The schedule only decides when an earning is paid; when it was earned comes
from the rule.

## When someone is paid

There is one ladder. The layers that say what someone is paid also say when: a
pay default or a payee's own setup may carry `schedules`, a list of **schedule
choices** (`payScheduleChoiceSchema`):

| Field | Meaning |
|---|---|
| `effective_from`, `effective_through` | The earned days the choice applies to, like any entry. |
| `earning_kind` | One kind of earning (`hourly`, `salary`, `piece_rate`, `commission`, `reimbursement`, `adjustment`, `clawback`), or `*` (the default): every kind with no choice of its own. |
| `schedule_id` | The pay schedule. |
| `timing_basis` | Optional override of the schedule's: recognize when the work was done (`worked`) or when the job was completed (`completed`). |
| `clawback_cap_percent` | Optional override of how much of one check a clawback may take. |

`resolvePaySchedule(orgId, payee, earningKind, date)` answers for one kind of
earning earned on one day:

- the **highest layer that says** wins: the payee's own setup, then their
  roles (or group type, or company types), then worker classification, kind of
  assignee, and the organization;
- within a layer, a choice for the **exact kind beats the catch-all**; a higher
  layer's catch-all still beats a lower layer's exact kind;
- among choices of one kind in one layer, the latest to start that has not
  ended;
- a layer counts only on days it covered the payee;
- an earning from a day before any choice had started is paid by today's
  choice, so work done before a schedule was first chosen is not left without
  one.

Example. The organization default says `{ "*": Weekly, from Jan 1 }`. The
`role:salesperson` default says `{ commission: Monthly, timing_basis:
completed, from Jan 1 }`. Eve is a salesperson, and from July 1 her own setup
says `{ "*": Monthly, clawback_cap_percent: 25 }`.

| Eve's earning | Earned | Paid on | Because |
|---|---|---|---|
| hourly | June 15 | Weekly | her role says nothing about hours; the organization answers |
| commission | June 15 | Monthly, recognized on completion | her role names commissions exactly |
| commission | July 15 | Monthly, clawbacks capped at 25% | her own catch-all is the highest layer that says |
| hourly | July 15 | Monthly, clawbacks capped at 25% | the same |

Everything that needs to know when someone is paid asks there: the ledger when
an entry is posted without a schedule (the entry records the layer that chose
it under `metadata.pay_schedule`), the clawback cap of a pay run, how a
correction is handled, and the timezone a rule's periods are cut in. An entry
posted with its own `schedule_id` keeps it. An entry posted by hand that names
no schedule and resolves none is refused with a message saying so, except a
commission or a reimbursement, which may wait unscheduled. A payee with no
record at all (a name on a hand-posted entry) follows the organization and
kind-of-assignee defaults.

A save that leaves `schedules` out keeps what is stored; an empty list clears
it. Choosing an archived schedule for new earnings is refused.

The policy mechanism this replaced (the `payroll_policies` table, its routes
and its `payroll.policy.*` actions) is gone, with no migration: the table is
dropped when the payroll store's schema is next initialized. On PostgreSQL
that happens only when the store's schema version is raised
(`DATABASE_SCHEMA_VERSION` in `payroll/storage.ts`), which this change did.

### Where it is edited

Payroll settings choose the organization's schedule: one for everyone and,
optionally, one per kind of earning, from a date. A role's, a type's or one
person's choice is edited where people are managed, through the published
calls below.

| To | Call |
|---|---|
| read one payee's pay and schedule | data `payroll.pay_setup`, target id `type:id` (`PayrollAPI.pay.setup`): own `entries`, `distribution`, `schedules`; `layers`; `effective`; `schedule_today` |
| see what a change to it would do | action `payroll.paySetup.preview` (`PayrollAPI.pay.previewSetup`) |
| change it | action `payroll.paySetup.save` with `{ payee, entries, distribution?, schedules?, expected_revision }` (`PayrollAPI.pay.saveSetup`) |
| read one role's or type's default | data `payroll.pay_default`, target id `role:<id>`, `group_type:<id>`, `company_type:<id>` (`PayrollAPI.pay.default`): entries, schedules, `subject_name`, `covers` |
| see what a change to it would do | action `payroll.payDefault.preview` (`PayrollAPI.pay.previewDefault`) |
| change it | action `payroll.payDefault.save` with `{ subject, entries, distribution?, schedules?, expected_revision }` (`PayrollAPI.pay.saveDefault`) |
| ask which schedule pays someone and why | action `payroll.paySchedule.resolve` (`PayrollAPI.pay.resolveSchedule`) |

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

What each earning read is stored in `pay_rule_evidence`, keyed by source row,
including what a [split rule](#split-rules) read to divide it.
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

## When a payee is removed

`payroll/assignee-cleanup.ts`. Someone who did the work must still be paid, so
removing an assignee deletes nothing in payroll. The cleanup step
(`payroll-pay`, registered with `registerAssigneeCleanup`) keeps their ledger
entries, paid or not, the results their rules last worked out, their pay setup
and the record of which defaults covered them, and reports how much it kept.
The setup is marked `closed`, so the payee is no longer refreshed; saving the
setup again reopens it. What they had already accrued stays payable in the next
pay run. Earnings not yet worked out when they were removed are not worked out
afterwards, so refresh before removing someone.

The step is registered when `payroll/assignee-cleanup.ts` loads, which the
payroll publication does at startup. `assignees/base.ts` should also list it in
`cleanupOwners` so it is loaded before a cleanup in any process.

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

Data (provider `payroll`): the sources above; `pay_rules`, `pay_split_rules`,
`pay_plans`, `pay_setups`, `pay_defaults` (each version and entry carries
`entered_by` and, resolved when read, `entered_by_name`); `pay_default` (one
default, target id `type:id`, with what its subject is called and who it
covers); `pay_setup` and `pay_units` (target id `type:id`; a payee's layers,
rules and schedule today, and what each rule last worked out, how a split
divided it, and why anything is unresolved); `pay_unresolved`; `pay_review`;
`pay_rule_sources` (the collections a rule can select from that the reader may
read: provider, export, description, units, known fields, the options each
takes and whether it needs any); `pay_rule_vocabulary` (the condition operators
of `work/conditions.ts`, parameter types, kinds of earning and default
subjects, so no screen keeps its own copy); and `configuration` (pay schedules
and the organization's schedule choices).

Actions: `payroll.payRule.save`, `.preview`, `.archive`;
`payroll.paySplitRule.save`, `.archive`; `payroll.payPlan.save`, `.preview`,
`.archive`; `payroll.paySetup.preview`, `.save`; `payroll.payDefault.save`,
`.preview`; `payroll.paySchedule.resolve`; `payroll.earnings.refresh`;
`payroll.correction.decline`. All need `manage_payroll` or
`manage_company_settings`. The browser reaches them through `PayrollAPI.pay`.

## Screens

- **Payroll settings** (`apps/settings/payroll.js`): pay schedules; the
  organization's schedule for everyone and per kind of earning; an editor for
  pay plans and pay rules with version history (who entered each version), a
  picker for the collection an input reads, the published condition operators,
  parameter kinds, and a preview of what a version would change before saving.
- **People, Compensation tab** (`apps/people/compensation-panel.js`, the
  `compensation` slot): for a payee, the rules in effect with the layer each
  came from, and per rule inherit, override or remove, add a rule or a plan,
  an own schedule choice, and how a group's pay is divided; for a role, a type
  of group or a type of company, the same editor on its default with who it
  covers. Every change starts on a chosen day and is previewed before saving.
- **Payroll** (`apps/payroll/app.js`): for a payee, the rules in effect and the
  layer each came from, the schedule they are paid on and the layer that chose
  it, what each rule last worked out, unresolved earnings, and the review of
  held corrections (accept or decline) and off-cycle back pay.

## Not built

- A deep link from the People compensation panel to one payee's "Why" on the
  Payroll tab; the panel's link opens the tab.
- A history of roles and types. Payroll records when it *noticed* a role or
  type start or stop covering a payee, at a refresh; the day it actually
  changed is not known.
- A final refresh when a payee is removed.
- A preview for split rules, and a preview's effect on when people are paid: a
  preview reports earnings, not pay dates.
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
- An editor for split rules and a screen showing how an earning was divided.
  The data is in `pay_units` and on each ledger entry.
- A published roster (who is on a piece of work, with removals and
  unavailability). Until it exists, split rules that depend on who was there
  read the time clock; see "Split rules" for what a roster source must provide.
- Membership history for groups. A split captures the members when an earning
  is first worked out and cannot reconstruct who was a member on a past date.
- Splits of a group that has groups or outside companies as members: members
  are users.
- A bound on how far back a split input reads. Like a pay rule's inputs, the
  selection covers the group's whole history up to the 5,000-row selection
  limit; beyond that the earnings it divides are unresolved until the selection
  is narrowed. Per-earning lookups against an index, or a change feed, remove
  this.
- A completion signal on labor commitments. `released` covers both finished
  work and work taken back, so the sample rule pays on release.
- Running projects created before this change may still hold bindings to the
  removed `payroll.commission.*` automations; those bindings fail when reached.

Run `tests/pay-rules.test.ts`, `tests/pay-defaults.test.ts`, `tests/pay-splits.test.ts`,
`tests/pay-cadence.test.ts`, `tests/pay-rules-store.test.ts` (also through
`node tests/run-embedded-postgres.mjs`), `tests/pay-sources.test.ts`,
`tests/payroll-publication.test.ts`, `tests/publication-select.test.ts`,
`tests/payroll-settings-browser.test.mjs`, `tests/payroll-pay-rules-browser.test.mjs`
and `npm run test:payroll` for changes here.
