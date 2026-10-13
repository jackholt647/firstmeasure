# Assignees, units, commitments and delivery

## Words

Use these words in product copy, documentation and new code. Older names remain
in stored data and are listed so they can be recognised, not copied.

| Word | Meaning | Older names in code and storage |
|---|---|---|
| **Assignee** | Anyone work can be assigned to: a person, a group of users, or an outside company. It is not specific to production — a sales team taking appointments is one. Equipment is never one. | "work resource" (`work_resource_ref` on lists and events), "assignable subject" (`workforce/assignability.ts`), "subject" (compensation profiles, pay sheets), "resource group" for a group of users, "organization connection" for an outside company |
| **Unit** | A group inside an assignee that does one job at a time. | — |
| **Pay sheet** | How one assignee is paid, as data evaluated against a job. See [pay sheets](pay-sheets.md). | "compensation profile" is the older, per-person pay record that payroll reads |
| **Commitment** | A frozen copy of a labor list as it was handed to its assignee. | — |
| **Delivery** | How a commitment reaches its assignee. | — |

An assignee's three types are `organization_user`, `resource_group` and
`organization_connection`. Do not rename the stored `work_resource_ref`; new
records and published data say `assignee`.

**"Crew" is not a platform word.** A crew is what one organization calls a
one-job unit that does production work; another department's units are teams or
pods. What a unit or a group is called comes from the terminology system for
that kind of group (a unit's `kind_id`, a resource group's kind). Do not write
"crew" into a contract, a field name, a published id or fixed interface copy.
Existing identifiers that already contain it (`crew_*` tables, the `crew` app,
the default `crew` group kind) are names of things, not the vocabulary.

## Units inside an assignee

`assignee_units` (`labor/commitments.ts`) holds units. Each belongs to one
assignee and may sit under another unit of the same assignee through
`parent_unit_id`; a cycle is refused. Work is committed either to the assignee as
a whole or to one of its units.

## Commitment

`commitLaborList` freezes a labor list that is assigned and not empty: its lines
with rates and totals, the assignee, the chosen unit, the assignee's pay sheet
revision, the list's schedule and a note. Editing the list afterwards never
changes a commitment. Committing again writes the next revision and marks the
previous one `superseded`. `releaseCommitment` marks one `released` when the work
is finished or taken back.

A committed list emits `labor.list.committed`, and `labor.list.delivered` once
it has reached the assignee, so organization rules and scope automations can
react.

## Delivery

Each assignee has a delivery method, chosen in `labor_delivery_settings` or
defaulted: people, groups of users and outside companies whose organization is
linked are shared with; an unlinked outside company is emailed a work order.

- `share` — the commitment is the assignee's inside FirstMate. Nothing is sent.
- `work_order_email` — a work order is emailed from the project. With no
  address the delivery needs attention; it is never reported delivered.
- `custom` — the assignee's own delivery code runs in the document-module
  sandbox. It receives the commitment, the recipient and the rendered work
  order, can read and invoke nothing, and returns steps from a fixed set:
  `todo`, `email`, `share`. The platform carries the steps out. With no code of
  its own an assignee gets `DEFAULT_CUSTOM_DELIVERY`, which creates a to-do asking
  someone to deliver the work by hand.

A delivery ends `delivered`, `pending` (only to-dos were created: someone still
has to send the work) or `needs_attention` (a step failed or could not run). To
add a kind of step, add it to `DeliveryStep` and to the dispatcher; do not let
delivery code call actions directly.

## Availability

Availability is worked out from commitments and nothing else
(`assigneeAvailability`). Every unit with no units under it does one job at a
time; an assignee with no units is itself one such unit. Capacity is the number
of units; each `committed` commitment uses one. Work committed to the assignee as
a whole, or to a unit that has units under it, uses a unit without naming which
and is reported as `unplaced`. More commitments than units is `over_committed`
and is reported, not prevented. Dates are carried on each commitment's `schedule`
for a scheduler to use; this view does not reason about dates.

## Published

- `labor-commitments.project` — commitments on a project. `labor-commitments.settings` — delivery methods.
- `assignees.units` and `assignees.availability` (arguments `type`, `id`).
- Actions `labor.list.commit`, `labor.commitment.release` (`manage_projects`);
  `labor.delivery-setting.save`, `assignees.unit.save`, `assignees.unit.archive`
  (`manage_company_settings`).
- HTTP under `/v1/materials/organizations/:orgId/`: `lists/:listId/commit`,
  `projects/:projectId/labor-commitments`, `labor-commitments/:id/release`,
  `labor-delivery-settings`, `assignees/:type/:id`, `assignee-units`.

Commitments, delivery and pay sheets are about labor lists today, so their names
say `labor`. Units and availability belong to assignees in general and are named
for them.

## Not built

The interface for any of this; sharing a commitment into a linked
organization's own account; a rendered work order document (the email carries a
table); payouts and actuals against a commitment; scheduling against
availability; equipment an assignee brings covering a job's equipment needs.

Run `tests/labor-commitments.test.ts` for changes here.
