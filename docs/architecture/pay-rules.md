# Pay rules, pay plans and earnings

Payroll keeps track of who needs to be paid what, and when. It does not move
money, calculate tax or file anything; its pay runs are what a company hands to
its payroll or accounts-payable software.

Anyone work can be assigned to can be paid: a person, a group of users paid as
one, or an outside company ([assignees](assignees.md)). Employees and
subcontractors go through the same rules, ledger and pay runs and are only
shown, and handed off, separately. Some payees are paid through payables
instead of payroll: their part of a pay run becomes a bill
([paid with payroll or through payables](#paid-with-payroll-or-through-payables)).

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
  clock; see [Time clock](#time-clock). `time_shifts` with
  `args: { "projected": true }` publishes scheduled time from now on as the
  shifts it is expected to become; see [Projected earnings](#projected-earnings).
- `work_roster` — who the schedule roster has on each piece of scheduled work,
  one row per exact interval; see [Split rules](#split-rules).
- `project_records` — every project with its stored custom field values under
  `fields`, and under `assignee_keys` the same paths for assignee fields as
  lists of `type:id` (match with `contains`, which covers one-valued and
  many-valued fields alike). With `args: { "facts": true }` each row also has
  indexed `sold_at`, `completed_at`, `canceled_at` and money in cents; that
  reading is `pending` until project indexing has finished.
- `labor_commitments` — committed labor lists with `assignee_key`, `status`,
  `total_cents`, `unpriced_lines`, `committed_at`, `released_at`.
  With `args: { "projected": true }` it publishes the labor not done yet
  instead, each row as finished work looks; see
  [Projected earnings](#projected-earnings).

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

A payee's types have a history, recorded **at the write that changes them**
(`assignee_type_history` in `assignees/base.ts`, `noteAssigneeTypes`,
`assigneeTypeHistory`): a user's roles when their user record is saved
(`platform/storage.ts` `upsertDocument` notes it for `users`), a group's type
when the group is created or its kind changes (`workforce/storage.ts`), and a
company's types when its assignee base is written. Each row is one type over
`active_from` to `active_until`, by day; a type already held when history began
has a blank `active_from` (since always). Default coverage
(`coverageSpans` in `payroll/pay-rules.ts`) follows that history: a role given
on the 1st pays what is earned from the 1st, whenever the next refresh runs,
and one taken away stops the day before it was taken away.

For anything before the history began, payroll still has the days a refresh
saw each default subject cover each payee (`pay_layer_spans`,
`notePayCoverage`), and uses them as a fallback:

- the first time a payee's pay is worked out, everything that covers them is
  taken to have always done so;
- after that, a subject that appears covers them **from the day a refresh
  noticed it**, and one that disappears stops covering them **the day before**.

A noticed span is used only where the history says nothing: it is kept when it
ended before the type's first recorded day, and dropped for a type whose history
starts "since always". Subjects that are not types (everyone, a kind of
assignee, a worker classification) follow the noticed spans alone.

So removing a role stops only what is earned afterwards. Earnings earned while
the role covered someone stay theirs: nothing posted under it is edited, and
nothing is taken back. This is how a setup entry *ended* with
`effective_through` behaves, not how a *deleted* entry behaves (deleting an
entry says it never applied, and what it posted is taken back as corrections).
Given the role again later, it pays from the day it was given again, not for
the time in between. A layer whose cover has a start or an end carries
`covered_from` and `covered_through`.

Only a refresh that posts records what it noticed; previews and every other
reader see the same answer without writing.

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
changing the setting never moves pay already earned. A split with no members on
the earned day is unresolved, not paid to nobody.

**Who was a member on the day.** Group membership has dates
(`resource_group_membership_history` in `workforce/storage.ts`): every path that
adds or removes a member records it, and a join or a removal may be dated in
the past (`effective_from` on the member write, `effective_on` on the removal),
so one entered late still counts from when it happened. A member removed on a
day is not a member that day. Members there before the history began were
backfilled as members since always. An earning first worked out is divided
among `membersOfGroupOn(earned day)`, not today's members, so a group whose
pay is worked out a month late still pays the people who were in it then.

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
  among, the group's members on the earned day. Someone whose join or removal
  is entered after that does not move earnings already worked out. An earning
  that was split equally before a rule was put in place from a past date keeps
  the members it had.
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

**Who was on the work** (`payroll.work_roster`, `payroll/roster-sources.ts`).
Payroll publishes the schedule roster as rows a split rule selects like any
other input: for every project schedule event that names an assignee,
`schedule-roster.events` (`scheduling/roster.ts` `readEventRosters`) says who
is on it, through which assignee, and the exact intervals they are on it after
removals, time off and unavailability. Each interval is one row: `id`,
`revision` (changes with anything in the row), `assignee_key`
(`organization_user:<id>`, or an outside company's key), `user_id`, `name`,
`via`, `project_id`, `event_id`, `parent_event_id`, `title`, `from`, `until`
and `seconds`. Matched on `project_id` and windowed on `from` to `until`, it
says who the schedule had on the earning's job that day, to the second.

**Samples** (`SAMPLE_PAY_SPLIT_RULES` in `payroll/sample-pay-rules.ts`):

- `present_on_the_job`: members who were on the earning's project on the day it
  was earned share equally: on its schedule that day (the roster) or with an
  approved shift on it (the time clock). Others get nothing. `minimum_minutes`
  sets how long counts as present, measured in exact time inside the day. Each
  share's reason says which (clocked for so many hours, or on the schedule for
  so many hours, or neither), and `details` carries `seconds_scheduled` and
  `seconds_clocked`.
- `by_hours_on_the_job`: in proportion to approved `worked_seconds` (net of
  breaks) on that project, counting every shift that started before the end of
  the earned day, however long the job ran. A shift counts whole; hours clocked
  on the project after the day it was earned are not part of that earning. When
  nobody clocked any hours on it, the hours the roster had each member on it
  count instead, and the reason says so.
- `whole_team`: equal among members whatever happened, written as a rule.

The two that read who was on the job divide earnings that carry a project (a
record rule naming its `project` field).

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

### Payments made outside a pay run

`payroll/off-cycle.ts`. "We paid Sam $500 on the 10th" is recorded against the
payee and the kind of earning it was for (`payroll.offCycle.record` with
`{ payee, kind, amount_cents, paid_on, reference?, note? }`), as one negative
accrued ledger entry of that kind with subgroup `off_cycle` and
`metadata.off_cycle_payment`. It changes nothing already posted. Its schedule is
the payee's schedule for that kind (`resolvePaySchedule`), and it is eligible
from the day it was paid.

The next pay run on that schedule that pays the payee takes it off
(`planDeductions` in `payroll/service.ts`): recorded payments first, in full up
to what the run pays them in earnings, then clawbacks within the clawback cap
from what is left. Reimbursements are never reduced: outside payments,
clawbacks and other negative entries come off earnings only (the cap is a share
of earnings), and what earnings cannot cover waits for a later run. It is not a clawback, so the cap does not limit it. What a run cannot take
off waits for the run after. The upcoming preview and the drafted run show it as
the subgroup `off_cycle` (and `off_cycle_cents`), so nobody is paid twice. Back
pay asked to be paid off-cycle that someone pays outside a run is recorded the
same way and nets to nothing in the next run.

The earnings report counts a recorded payment as paid (`paid_cents`, and it is
listed under `off_cycle_payments`), so a payee's earned total is unchanged. A
payment no pay run has taken off yet can be removed (`payroll.offCycle.remove`:
the entry is voided, as any unused entry can be); once a run has taken any of
it off it stays, and a mistake is corrected with an adjustment.
`payroll.off_cycle_payments` lists them with how much runs have taken off
(`subtracted_cents`) and how much is still to come off (`waiting_cents`).

The older off-cycle pay run (`run_type: off_cycle`, which pays chosen accrued
earnings early) is still accepted by the API; the Payroll app does not offer it.

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

## Projected earnings

`projectPayeeEarnings`, `projectUserEarnings` and `projectOrganizationEarnings`
in `payroll/pay-refresh.ts`. A payee can see what they are expected to earn
before it is earned. A projection is the payee's own pay rules evaluated over
projected inputs, never a second formula:

- **Which rules.** Every rule that pays per record (`grain: "record"`) whose
  primary input publishes a projected reading, and every rule that pays by
  period (`grain: "period"`) with an input that publishes one or with `always`
  (a salary). A collection publishes a projected reading by taking a boolean
  `projected` argument (`projected: true` in its options schema); with it, it
  publishes the work that is not done yet, each row as it is expected to look
  once done. The collection owns what "done" means and when it is expected.
- **Periods.** For a rule that pays by period, the periods projected are the
  current one and every one that ends within `PROJECTED_PERIOD_DAYS` (35) of
  today. Each holds its real rows so far (what happened earlier this period)
  and its projected rows (what is scheduled), dated by the input's `date`
  field, and is expected on its last day. With `always` every period counts,
  rows or not, so a salary paid by the day projects one earning a day. A period
  whose last day has passed is earned, not projected.
- **How.** The rule's own selection, with `projected: true` added to the
  arguments of the primary input (a record rule) or of every dated input that
  takes it (a period rule), and the real rows read beside them; other inputs are
  read as they are. The rows are split into records or periods and run in the
  sandbox exactly as a refresh runs them: the version and
  parameters in effect on the expected day (today when no day is known), as the
  person who last saved the rule. A record the rule has already earned (a
  stored result) is not projected again.
- **Unresolved stays unresolved.** A formula that throws, or an input that
  cannot be read, is listed under `unresolved` with the reason and is never
  counted as zero. The sample labor rule refuses a commitment with unpriced
  lines in a projection just as it does when paying.
- **Never posted.** Nothing is written: no ledger entry, no stored result, no
  coverage noted. A projection is not part of a pay run and leaves nothing
  waiting for the next refresh. Every projected earning carries
  `projected: true` and `expected_on`, the day it is expected to be earned
  (blank when nothing is scheduled). This is unrelated to the ledger's
  `projected` state, which holds corrections held for review and hand-posted
  forecasts.

**Labor** (`payroll/pay-sources.ts`, `projectedLaborRows`). Projected rows are:

- every current commitment that is neither released nor finalized
  ([completion](../../public/v1/labor/completion.ts)); a finalized commitment
  is earned, and a released one was taken back;
- every assigned labor list that was never committed, priced exactly as
  committing it would freeze it (`laborLinesOf`), with id `labor_list:<list id>`
  and `committed_at` blank.

Each looks like finished work: `status` committed and `finalized_at` the
expected date, so a rule that earns on `finalized_at` finds it. The expected
date is the end of the list's schedule event as it stands (its last part when it
has parts), else the list's own copy of its schedule, else the schedule frozen
on the commitment; `expected_from` says which (`schedule_event`, `labor_list`,
`commitment`, or blank when nothing is scheduled). `asDone` in the same file is
the one place that says what finished looks like; change it with the finished
row's shape.

**Hours** (`payroll/roster-sources.ts`, `projectedShiftRows`). The time
clock's projected reading (`time_shifts` with `projected: true`) is everyone's
scheduled time from now to `PROJECTED_SHIFT_DAYS` (35) ahead, from the schedule
roster (`work_roster`): each future interval a person is on scheduled work
looks like the approved, closed shift it is expected to become
(`clocked_in_at`, `clocked_out_at`, `worked_seconds`, no breaks), with
`projected: true` and `expected_from: schedule_event`. The part of an interval
already past is left to the real time clock. So the sample hourly rule
projects a week's scheduled hours at the payee's rate, overtime included.

**Groups.** A group's projection is the group's own. When the group's pay is
split on the expected day, each earning says how it would be divided among
today's members (`equal` or `shares`); under a split rule it says the division
is decided when the earning is worked out. A user's own projection
(`projectUserEarnings`) adds their share of each group they are an active
member of whose pay is split; a share decided by a split rule is listed as
unresolved rather than guessed. A group paid as one keeps its projection to
itself.

**Who sees it.**

- The payee: `payroll.view_own_projected_earnings` ("See own projected
  earnings", Money & payroll > Payroll, under the self-service earnings
  feature). Every seeded role and the development roofing roles grant it; a
  company that does not want projections shown denies it on a role or a user.
  Without it the read is refused and the Earnings app shows nothing of it. It
  is only ever the signed-in user's own.
- Payroll managers (`manage_payroll|manage_company_settings`) see anyone's, and
  everyone's totals, with no key of their own.

**Published.** Data `payroll.my_projected_earnings` and action
`payroll.projectedEarnings.me` (the signed-in user, needs the permission and
`payroll.self_service_earnings`), route
`GET /v1/payroll/organizations/:orgId/earnings/me/projected`
(`PayrollAPI.earnings.projectedMine`). Data `payroll.projected_earnings` and
action `payroll.projectedEarnings.read` for managers: one payee by target id
(or `payee`), or, left out, totals for everyone whose pay comes from rules (at
most 200 payees, `truncated` beyond) (`PayrollAPI.pay.projected`). Reads only.

**Screens.** Every self-service Earnings tab shows the one **My pay** view
(`apps/payroll/my-pay.js`): the field Earnings tab (`portal.crew_payouts`), a
project's Earnings tab (`project.crew_payouts`, that job only), the sales
Earnings tab (`portal.sales_earnings`, commissions first, picked by earning
kind) and the Payroll app's My pay. It shows what is earned and not paid, the
next pay date, what was paid, **Projected** (the rule forecast, only when the
access profile's `projected_enabled` parameter or the permission allows it, and
hidden when the server refuses), **Held for review** (ledger entries waiting on
a manager; the ledger's `projected` state is never called projected on a
screen), anything of theirs that could not be worked out, pay runs, payments
made outside a pay run and, when Today's time clock option is on for them, their
own timesheets.
`payroll.my_earnings` carries `next_payment` and `unresolved` for it. The Payroll tab shows a payee's projection in their
"Why" drawer and, on request, projected totals per payee.

## When a payee is removed

`payroll/assignee-cleanup.ts`. Someone who did the work must still be paid, so
removing an assignee deletes nothing in payroll. The cleanup step
(`payroll-pay`, registered with `registerAssigneeCleanup`) keeps their ledger
entries, paid or not, the results their rules last worked out, their pay setup
and the record of which defaults covered them, and reports how much it kept.
The setup is marked `closed`, so the payee is no longer refreshed; saving the
setup again reopens it. What they had already accrued stays payable in the next
pay run.

**Their last day.** Before the setup is closed the step runs one last refresh
(`finalPayOnRemoval`, `refreshPayeeEarnings` with `removed.closeThrough`): what
their rules say they earned up to and including their last active day is worked
out and posted, and nothing after it. The last day is the day they were
removed (`deleted_at` on a user, `archived_at` on a group or an outside
company), whenever the cleanup runs, so a daily salary stops on that day and a
week's hours that run past it are earned up to it. The step's report says the
day and how many entries it posted. A second cleanup changes nothing.

Archiving a user (`workforce/user-archive.ts`) runs the assignee cleanup for
them as it does for a group or an outside company, as the platform: the archive
is the authority, and a step that fails is reported and the archive stands.

The step is registered when `payroll/assignee-cleanup.ts` loads;
`assignees/base.ts` lists it in `cleanupOwners`, so it is loaded before a
cleanup in any process.

## Time clock

The time clock is data about when somebody worked, when they clocked in and
out, and where they were. It knows nothing about pay, and nothing about pay
decides who may use it.

**Who may clock.** Today's time clock option (`time_clock` on
`portal.crew_overview`, passed to Today as `time_clock_enabled`;
[app experience](app-experience.md)) and nothing else. It is not a permission.
Someone on a salary, on piece rates or with no pay set up at all can clock if
their app experience turns it on. Their own timesheets (My pay,
`payroll.my_timesheets`, `GET .../timesheets/me`) follow the same option;
everyone's timesheets need `manage_payroll` or
`manage_company_settings`. Whether clocked hours are paid is only a
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

## Paid with payroll or through payables

`payroll/payables.ts`. The payroll ledger is the one record of what everyone is
owed, however they are paid. What differs is how a payee's part of a pay run is
paid, and that is read from settings People already has; payroll adds none:

| Payee | Paid |
|---|---|
| Employee (a user) | with payroll |
| Independent contractor whose payment terms are "on the pay schedule" (People, Compensation) | with payroll |
| Independent contractor whose payment terms are net days | through payables, due that many days after the pay date |
| Outside company (People, Subcontractors, payment terms) | through payables, due after its net days, or on the pay date when it is paid on the pay schedule |
| Group of users | with payroll |
| Anyone, while the organization has Money turned off | with payroll (there are no payables) |

A pay run is the same for everyone: it is drafted from the same ledger
entries, takes off payments made outside a run and clawbacks by the same rules
(`planDeductions`; reimbursements are never reduced), and allocates the
entries to each payee's item, so none of them is in a later run. The answer
above is worked out when the run is drafted (and again when it is reopened)
and kept on each item: `metadata.paid_through` (`payroll` or `payables`),
`payment_terms` and, for payables, `due_date`. The upcoming preview carries
the same fields per payee.

**Bills.** A payables item becomes a bill when the run is entered (marked run),
or when it is marked paid in Payroll: a payable of kind `contractor_payroll`
whose id is fixed by the run and the item
(`payment_payable_payroll_<run>_<item>`), so making it again finds the same
one. It is due on the item's `due_date`, names the payee, and under
`metadata.payroll_ledger_entries` lists every ledger entry the item pays and
how much of each, with the amounts by kind under `metadata.breakdown`. Its
amount is the item's amount to pay less approved reimbursements that already
have a payable of their own (those are paid by theirs when the item is paid),
so nothing is in payables twice. A payables item with nothing left to bill is
paid like everyone else.

**Paid exactly once.** Paying the bill wherever payables are paid
(`createDisbursement` in `payments/storage.ts`, used by the Money tab and
`POST /v1/payments/.../disbursements`) calls `settlePaidPayrollBills`: once
the bill is fully paid, its item is marked paid with what paid it under
`metadata.settlement` (`source: payables`, the payable and payment), its
reimbursements are marked paid, and the run is paid when everyone in it is.
Its entries were already allocated to the item, so the Payroll app, the
earnings reports and My pay now count them as paid; nothing posted is edited.
A second report of the same payment, or any re-run, changes nothing. A partly
paid bill leaves the item open (the Payroll app shows how much is paid).
Marking the item paid in Payroll instead records the payment against the bill
(a disbursement with a fixed id), once. If recording the payment in payroll
fails after payables was paid, `payroll.bills.reconcile` finishes it; the
Payroll app offers it when a bill shows `needs_settlement`.

**What a run's actions do to bills.** Marking a run paid marks everyone paid
with payroll paid and enters the bills; the run stays entered until every
bill is paid (the Payroll app calls that "Bills open"). Reopening or voiding a
run removes its unpaid bills; a run whose bill has any payment in payables
cannot be reopened or voided (`payroll_bill_paid`): correct it on a later run.

**Handoff.** The pay run files keep payroll and payables apart: the Gusto and
QuickBooks Payroll files hold people paid with payroll, and
`quickbooks_bills` holds the bills with their due dates, for an accounting
system that pays bills. The pay run summary lists employees, contractors and
bills as three sections.

**Branch scope.** Bills are listed only for payees the viewer may see, and
reconcile only touches payees the viewer manages. Paying a bill in payables
needs payables' own permission (`manage_projects`); the payment is a fact
payroll records, not a payroll write.

### Reimbursements paid in payables

An approved reimbursement to be paid "with the next payroll" has both a ledger
entry and a payable of its own (`payments/reimbursements.ts`; the entry's
`metadata.payable_id`). Once payables records any payment on that payable,
payables owns it and payroll never pays it too (`settleReimbursementsPaidInPayables`,
run from the same `createDisbursement` hook, before a pay run is drafted or
reopened, and by `payroll.bills.reconcile`):

- **Paid in payables before any pay run holds it:** the entry, unused, is
  voided with what paid it under `metadata.settled_in_payables`, so no run
  includes it.
- **Already in a pay run whose item is not paid:** the payment cannot be
  refused (payables has recorded it), so the run is held instead: the item
  carries `metadata.reimbursement_paid_in_payables`, and marking it or the
  run entered or paid is refused (`payroll_reimbursement_paid_in_payables`)
  until the run is reopened. Reopening works the run out again without the
  entry, which is then voided as above. The Payroll app shows "Reopen:
  reimbursement paid" on that person.
- **Already paid by payroll:** payroll marked its payable paid itself; nothing
  changes.

Every step finds what is already settled and does nothing again, so it is
safe to run any number of times.

## Export templates

`payroll/export-templates.ts`. A pay run is copied out with a template: which
people are in the file, one row per person or per person and pay item, and a
list of columns. The five pay run files (the pay run summary, Gusto employees
and contractors, QuickBooks Payroll and QuickBooks bills) are the **built-in
templates** and make exactly the files they made before templates existed
(`tests/fixtures/payroll-pay-run-files.json` holds those files). A company
duplicates one and changes it; it never edits a built-in.

**Reports for dates** are templates too, with one row per `earning` (a ledger
entry whose earned day is in the dates) or per `reimbursement` (a request asked
for in the dates). The All earnings, Commission and Reimbursement reports are
built-in templates of that kind (`earnings_ledger`, `commissions`,
`reimbursements`) and make exactly the CSV files the reports made before
(`tests/fixtures/payroll-date-range-reports.json`). A template's `scope`
(`pay_run` or `date_range`, from its rows) says which it is. Every template,
built in or a company's own, prints: its PDF is made from the same table as its
CSV, with a total row when the template has one. A report for dates is limited
to the payees of the branches the viewer may see, as a pay run file is.

A template's `definition`:

| Field | Meaning |
|---|---|
| `name`, `description` | What the file is called. |
| `people` | Any of `employees`, `contractors` (paid with payroll) and `bills` (paid through payables). |
| `rows` | `person`, or `pay_item` (one row per person and pay item), for a pay run; `earning` or `reimbursement`, for dates. |
| `kinds`, `include_projected` | Earning rows: only these kinds of earning (every kind when left out), and forecasts and held corrections too. |
| `pay_items` | For pay item rows: `by_kind` (each kind of earning, then what was taken off, as negatives) or `work_and_reimbursement` (two lines, as bills are). Lines of zero are left out. |
| `pay_item_labels` | Names for pay items by key (`hourly`, ..., `work`, `reimbursements`). |
| `sort`, `group` | By `name` or `last_name` (or `none`, as recorded, for dates); grouped by `section` (employees, contractors, bills) or `none`. |
| `totals` | Person rows: `none`, `grand` (a row at the end) or `sections` (one per group and at the end); rows for dates: `none` or `grand`. Amounts are added up; a total row names its group. |
| `skip_zero` | Leave out people with nothing to pay. |
| `number` | `decimals` (0 to 4), `unit` (`dollars` or `cents`), `negative` (`minus` or `parentheses`), `thousands`, `zero` (`show` or `blank`). Default: dollars with two decimals and a minus sign. |
| `date` | `YYYY-MM-DD` (default), `MM/DD/YYYY`, `M/D/YYYY`, `DD/MM/YYYY`, `YYYYMMDD`. |
| `file` | `type: csv`; `delimiter` `comma`, `semicolon` or `tab` (a `.tsv` file); `bom`; `header_row`. CSV is written with a byte order mark and CRLF unless turned off. |
| `columns` | Up to 60, each `{ header, source, value?, field?, format? }`; `format` overrides the number or date format for that column. |

The **sources** a column can show are published with the templates
(`export_templates.sources`, `EXPORT_SOURCES`), each with a label, a
description and a kind: the payee (name, first and last name, email, platform
ID, a **custom field** of a user by its path such as an employee number,
person/group/company, worker classification, individual or business, paid as,
paid through, payment terms, branch, department, approved hours on shifts that
ended in the period); amounts (each kind of earning, reimbursements, paid
outside a run, clawbacks, earnings, earnings and reimbursements, taken off,
to pay without reimbursements, amount to pay); pay item (name, amount, code,
description); the pay run (pay date, period, schedule, regular or off-cycle,
status, currency, memo, memo with what was taken off); the payment (status,
reference, paid on); the bill (number, date, due date); the earning (earned on, kind and its code, project, description, status, amount, already in a pay run, still owed, currency, ID); the reimbursement (project, amount, currency, status, requested, approved and paid on, how it is paid, note); the report's dates; and fixed text. Each source lists the kinds of `rows` it can fill. A
template reads only what its columns need: branches and departments from the
organization structure, hours from the time clock, a custom field only when
the viewer may read it (a private field is left blank, with a warning).

**Stored and used.** A company's templates are rows of the payroll store
(`payroll_export_templates`, schema version 6) with a revision; saving needs
the current revision. A file is made from the template as it is then
(`payroll.artifact.generate` with `template_id`, or `type` for a built-in) and
records the template's id, revision and definition under `metadata.template`;
files made before never change, and the same template on the same run gives
the same file back. A removed template is no longer offered or used; its files
stay. The pay run summary's PDF is made from the same table. Everything is
limited to the branches the viewer may see, like every pay run file.

| To | Call |
|---|---|
| list the templates and sources | data `payroll.export_templates` (action `payroll.exportTemplates.list`) |
| save one (create, or replace with `id` and `expected_revision`; `based_on` names what it was copied from) | action `payroll.exportTemplate.save` |
| remove one | action `payroll.exportTemplate.archive` with `expected_revision`, target id the template |
| see the first rows a template, saved or not, makes from a pay run or for dates | action `payroll.exportTemplate.preview` with `batch_id`, or `from` and `through`, and `template_id` or `definition` (a read) |
| make the file | action `payroll.artifact.generate` with `batch_id`, or `from` and `through`, and `template_id` (or `type`), `format` `csv` or `pdf` |

All need `manage_payroll` or `manage_company_settings`.

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
subjects, so no screen keeps its own copy); `configuration` (pay schedules
and the organization's schedule choices); `bills` (bills of pay runs, `status`
open, paid or all; see [paid with payroll or through payables](#paid-with-payroll-or-through-payables));
and `export_templates` ([export templates](#export-templates)). The vocabulary also carries `periods`
and, under `labels`, what each kind of earning, parameter type and period is
called. Projected earnings are
`projected_earnings` and `my_projected_earnings`, with the actions
`payroll.projectedEarnings.read` and `payroll.projectedEarnings.me`; see
[Projected earnings](#projected-earnings) for who may read them.

Actions: `payroll.payRule.save`, `.preview`, `.archive`;
`payroll.paySplitRule.save`, `.preview`, `.archive`; `payroll.payPlan.save`, `.preview`,
`.archive`; `payroll.paySetup.preview`, `.save`; `payroll.payDefault.save`,
`.preview`; `payroll.paySchedule.resolve`; `payroll.earnings.refresh`;
every preview's changed earning carries `pay_date`, `schedule_id` and
`schedule_name`: the pay date it lands on (a correction to an earning already in
a pay run lands on the next one; one held for review on none), and a split
rule's preview carries, per group, `samples`: how its latest three earnings
would be divided, member by member;
`payroll.correction.decline`; `payroll.bills.reconcile`;
`payroll.exportTemplate.save`, `.archive`, `.preview`. All need `manage_payroll` or
`manage_company_settings`. The browser reaches them through `PayrollAPI.pay`.

## Screens

- **Payroll settings** (`apps/settings/payroll.js`): pay schedules; the
  organization's schedule for everyone and per kind of earning; an editor for
  pay plans, pay rules and split rules with version history (who entered each
  version), a picker for the collection an input reads, the published condition
  operators, parameter kinds, and a preview of what a version would change
  before saving, with the pay date each change lands on. A split rule's editor
  also sets, per input, the member field, the fields that match the earning and
  the time window; its formula is under Advanced; its preview shows how each
  group's latest earnings would be divided, with every member's share and
  reason.
- **People, Compensation tab** (`apps/people/compensation-panel.js`, the
  `compensation` slot): for a payee, the rules in effect with the layer each
  came from, and per rule inherit, override or remove, add a rule or a plan,
  an own schedule choice, and how a group's pay is divided; for a role, a type
  of group or a type of company, the same editor on its default with who it
  covers. Every change starts on a chosen day and is previewed before saving.
  A payee's "Why" opens their Why on the Payroll tab (route `payrollWhy`
  `type:id`), and a group's "How pay was divided" opens its Divided tab
  (`payrollWhyTab: divided`).
- **Payroll** (`apps/payroll/app.js`), views by permission and app flag only
  (its `ACTIONS` table):
  - Whether pay runs need approval is the organization's payroll setting
  (`payroll.settings.save`, `settings.approval_required` on `configuration`, on
  unless turned off). With it off a pay run goes draft, entered, paid; the
  server refuses to mark a run entered or paid while an approval someone asked
  for is waiting or was rejected. With it on, named approvers approve and the
  run is made final first.
  - *Pay runs* (payroll managers): upcoming pay dates with who is paid what,
    split into employees, contractors and bills; bills waiting to be paid,
    with their due dates and what payables has paid (and "Show payments in
    pay runs" when payables paid one the run does not show yet). A pay run
    opens with its people in those three sections (earned, reimbursements,
    already paid outside a run, taken back, to pay; a bill's due date, terms
    and payment), the next step (draft, approve or ask named approvers, mark
    entered, mark paid, reopen, void; "Bills open" once only bills are left)
    and its files (`Copy out`: every export template, built in or the
    company's own, with a download per format. A file's menu duplicates it,
    or changes or removes the company's own; "Make your own file" starts from
    any of them. The editor, in the same tab, sets who is in the file, rows,
    order, grouping, totals, number, date and separator formats, and the
    columns (header, source, a fixed text or custom field, a format per
    column, moved up or down), with a preview of the first rows of that pay
    run).
  - *Review*: earnings that could not be worked out, held corrections (accept
    or decline), back pay asked to be paid off-cycle, payments made outside a
    pay run, work orders finalized to be paid with the earnings they produced
    (`payroll.finalized_work`), and reimbursements waiting to be paid.
  - *Timesheets*: everyone's shifts for payroll managers (fix, approve, reject);
    your own for someone with only Today's time clock option
    (`payroll.my_timesheets`).
  - *Earnings*: each payee's amount owed and projected, and "Why" (rules and
    the layer each came from, schedules and who chose them, what each rule
    worked out, how pay was divided, ledger entries, projected earnings,
    payments). *Divided*, for a group, shows each earning it divided, line by
    line, with the method, the split rule and its parameters, and every
    member's weight, share, amount and reason (from `pay_units`); for a person,
    each share of a group's earning they were paid, with their weight out of
    the total and the reason (from the ledger entries' `metadata.split`). The
    route `payrollWhy` opens it from anywhere.
  - *History*, *Reports* (date-range reports, the company's own reports for
    dates made in the same template editor with a preview of the dates chosen,
    as CSV or PDF, and prepared files), *Approvals*
    (pay runs waiting for you as a named approver, `payroll.my_approvals`,
    `payroll.batch.decide`), *My pay* (your own earnings, payments and, with
    `payroll.view_own_projected_earnings`, projections) and *Settings* (the
    one Payroll settings component; Company Settings links to it).
  Payee lists are limited to the branches the viewer may see
  (`payroll/payee-scope.ts`, [branches](branches.md)); a branch filter shows
  when the organization has several.

## Not built

- An organization-wide list in Money to pay bills that belong to no project or
  several. A payroll bill with one project shows in that project's Money tab;
  others are paid by marking them paid in Payroll (recorded against the bill)
  or through `POST .../disbursements`. Owned by the Money app.
- Contractors on payment terms in the Gusto contractors file: they are bills,
  in the QuickBooks bills file; a company that pays them through Gusto sets
  them to be paid on the pay schedule.
- Labor line suggestions from an assignee's rates. A labor category's
  `piece_rate` and `hourly_labor` line item sources (`materials/resource-types.ts`)
  used to read the assigned group's compensation plan and now suggest nothing;
  they need pointing at the assignee's pay sheet or removing.
- The `compensation` object on a labor list and on a scope template's labor
  piece (pay mode, estimated hours) is still stored and copied but nothing
  reads it: a labor list's projected cost is its own priced lines.
- Splits of a group that has groups or outside companies as members: members
  are users.
- Restoring a removed payee does not reopen their pay setup: saving the setup
  again does, and what was earned after their last day is then worked out.
- Performance only, with the same results when done:
  - change feeds on the sources and an index for the time clock collections, so
    a refresh selects only what changed instead of every input, up to the host's
    50,000-row scan limit; see
    [indexed selections and change feeds](../optimization-backlog.md#indexed-selections-and-change-feeds-for-pay-refresh);
  - a bound on how far back a split input reads: like a pay rule's inputs, the
    selection covers the group's whole history up to the 5,000-row selection
    limit, beyond which the earnings it divides are unresolved until the
    selection is narrowed; per-earning lookups against an index, or a change
    feed, remove this (same entry);
  - the published work roster reads every project and the roster of every
    scheduled event each time it is selected; see
    [payroll work roster](../optimization-backlog.md#payroll-work-roster-reads-every-scheduled-event);
  - payroll bill and route reads scan whole collections; see
    [the optimization backlog](../optimization-backlog.md#payroll-bills-and-payment-routes-read-whole-collections).

Running projects created before pay rules may have held bindings to the removed
`payroll.commission.*` automations; a scan of the development organizations
found none, so nothing is left to migrate.

Run `tests/pay-rules.test.ts`, `tests/pay-defaults.test.ts`, `tests/pay-splits.test.ts`,
`tests/pay-cadence.test.ts`, `tests/pay-rules-store.test.ts` (also through
`node tests/run-embedded-postgres.mjs`), `tests/pay-sources.test.ts`,
`tests/payroll-publication.test.ts`, `tests/publication-select.test.ts`,
`tests/payroll-settings-browser.test.mjs`, `tests/payroll-pay-rules-browser.test.mjs`,
`tests/pay-projections.test.ts`, `tests/payouts-projected-browser.test.mjs`,
`tests/payroll-payables.test.ts`, `tests/payroll-reimbursement-settlement.test.ts`, `tests/payroll-export-templates.test.ts`,
`tests/payroll-bills-templates-browser.test.mjs`, `tests/pay-history-roster-removal.test.ts`,
`tests/payroll-split-rules-browser.test.mjs`, `tests/payroll-report-templates-browser.test.mjs`,
`tests/people-compensation-panel-browser.test.mjs` and `npm run test:payroll` for
changes here.
