# Assignees, units, commitments and delivery

## Words

Use these words in product copy, documentation and new code. Older names remain
in stored data and are listed so they can be recognised, not copied.

| Word | Meaning | Older names in code and storage |
|---|---|---|
| **Assignee** | Anyone work can be assigned to: a person, a group of users, or an outside company. It is not specific to production — a sales team taking appointments is one. Equipment is never one. | "work resource" (`work_resource_ref` on lists and events), "assignable subject" (`workforce/assignability.ts`), "subject" (pay sheets), "resource group" for a group of users, "organization connection" for an outside company |
| **Unit** | A group inside an assignee that does one job at a time. | — |
| **Pay sheet** | How one assignee prices a job, as data evaluated against it. See [pay sheets](pay-sheets.md). What they are then paid, and when, comes from [pay rules](pay-rules.md). | "compensation profile" and "compensation plan" were the older per-person and per-group pay records; they are removed |
| **Commitment** | A frozen copy of a labor list as it was handed to its assignee. | — |
| **Delivery** | How a commitment reaches its assignee. | — |

An assignee is one of three **kinds**: `organization_user`, `resource_group` and
`organization_connection`. Stored references are `{ type, id }`, where `type` is
the kind. An assignee's **types** are a different thing and are always
`type_ids`, a list: a user's types are their access roles (there is no separate
user type), a group has exactly one type (its `kind_id`), and an outside company
has zero or more company types. Do not rename the stored `work_resource_ref`;
new records and published data say `assignee`.

What every assignee has (name, status, types, tags, departments and its
structural **traits**: has members, has a login, can be linked, splits pay), the
roles a group type gives its members when they join, the directory that
publishes one row per assignee, who is actually on a piece of work, time off and
**staffing requirements** are in
[the assignee base and the roster](assignee-base.md). `labor/assignees.ts` is a
thin user of that contract. The traits are not capabilities: a capability is
what kinds of work an assignee can do (below).

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

`commitLaborList` freezes a labor list that is assigned to a real assignee, not
archived and not empty: its lines, the assignee, the chosen unit, the revisions
of the assignee's pay sheets, the list's schedule and a note. Each line keeps
the list's own rate exactly and the list's own line total, so a commitment
never disagrees with what the list showed; a line with no rate is unpriced, and
the commitment says how many are (`unpriced_lines`) rather than presenting a
partial sum as the whole. It also records the list revision and a
`content_hash` of exactly what was frozen, so anything can tell whether the
list has changed since.

Rules that keep it safe to build on:

- **Unchanged means the same commitment.** Committing a list whose frozen
  content has not changed returns the commitment it already has. Nothing is
  sent again. A second click cannot create a second commitment.
- **One winner.** A commitment's id is its list and revision, created
  create-only, so two requests racing for the same revision cannot both
  succeed; the loser is told to reload.
- **Same key, same result.** An `idempotency_key` (body or `Idempotency-Key`
  header) returns the commitment first made with it.
- **Only the newest revision can be current.** Readers treat any older
  revision as superseded even if the write that should have marked it never
  finished, and whatever later happened to the newer one.
- **A project-scoped call stays in its project.** The published actions refuse
  a list or commitment that belongs to a different project than their target.
- Commitments are never edited. `releaseCommitment` marks one `released` when
  the work is finished or taken back; archiving a list releases what it held.

`labor.list.committed`, `labor.list.delivered` and `labor.list.released` are
registered when the module loads and emitted as they happen. If an event could
not be recorded the commitment carries `event_error`.

## Delivery

Each assignee has a delivery method, chosen in `labor_delivery_settings` or
defaulted: people and groups of users are shared with; an outside company is
emailed a work order.

- `share` — the commitment is the assignee's inside FirstMate. For people and
  groups in this organization that is arrival. An outside company's own account
  is not reached yet, so sharing with one stays `pending`.
- `work_order_email` — a work order is emailed from the project. With no
  address the delivery needs attention.
- `custom` — the assignee's own delivery code runs in the document-module
  sandbox. It receives the commitment, the recipient and the rendered work
  order, can read and invoke nothing, and returns at most ten steps from a
  fixed set: `todo`, `email`, `share`. The platform carries the steps out. With
  no code of its own an assignee gets `DEFAULT_CUSTOM_DELIVERY`, which creates a
  to-do asking someone to deliver the work by hand.

Email only ever goes to an address already on record for the assignee (the
delivery setting's address, or the company's own contacts). Delivery code that
names any other address is refused, so it cannot be used to send pay data
elsewhere.

A delivery ends `delivered`, `pending` (someone still has to send the work) or
`needs_attention` (a step failed or could not run). It never reports delivered
unless the work reached someone. `redeliverCommitment` tries again without
making a new revision or re-sending an email that already went;
`confirmDelivery` records that it was handed over by hand. To add a kind of
step, add it to `DeliveryStep` and to the dispatcher; do not let delivery code
call actions directly.

## Availability

A commitment is a handoff: what was given to an assignee and for what pay. It
does not say when anyone is free. Whether an assignee is already booked during
a range is worked out from schedule events, where a unit is named on the event
(`unit_id`) and an assignee can hold as many overlapping events as it has units
with no units under them. See [schedule events](schedule-events.md).

## Published and access

Pay sheets and delivery settings are compensation records. What a job pays,
what was committed and who is free are project management. Seeing materials is
not enough for any of it.

| | Permission |
|---|---|
| `pay-sheets.catalog`, `pay-sheets.requirements`, `labor-commitments.settings`; saving sheets, delivery settings and units | `manage_company_settings` |
| `pay-sheets.evaluation`, `labor-commitments.project`, `assignees.units`; `labor.list.commit`, `labor.commitment.release`, `.deliver`, `.confirm-delivery` | `manage_projects` |

The HTTP routes under `/v1/materials/organizations/:orgId/` enforce the same
permissions and the same Materials switch as the published views:
`pay-sheets`, `projects/:projectId/pay-sheets/evaluate`, `lists/:listId/commit`,
`projects/:projectId/labor-commitments`, `labor-commitments/:id/release`,
`…/deliver`, `…/confirm-delivery`, `labor-delivery-settings`,
`assignees/:type/:id`, `assignee-units`. The commit and commitment actions can
also be run by the platform itself for an automation that has been granted
them.

A pay sheet, delivery setting or unit can only be saved for an assignee that
exists. A unit that still holds committed work cannot be removed.

Commitments, delivery and pay sheets are about labor lists today, so their names
say `labor`. Units belong to assignees in general and are named for them.

## Not built

The interface for any of this; sharing a commitment into an outside company's
own account; commitments are listed by reading the whole collection,
which will need an index before there are many thousands; a rendered work order document (the email carries a
table); actuals against a commitment (what a released commitment pays is a
[pay rule](pay-rules.md)); a commitment learning that its event
moved. Equipment an assignee brings is on their pay sheet and covers a job's
functions; see [requirements](requirements.md).

Archiving a group or an outside company removes its pay sheets, units, delivery
setting and declared capabilities through `cleanupAssignee`
([assignee base](assignee-base.md#removal)); a unit that still holds committed
work is kept and reported. Removing a user does not run it yet.

Run `tests/labor-commitments.test.ts` for changes here.

## Capabilities

What an assignee is able to do, as work items, is kept apart from how they are
paid and is described in [requirements](requirements.md#capabilities). The
`capability_scope_ids` on a group or company grant the kinds of work those
scopes work in; `labor/capabilities.ts` adds or removes single items.

That is what an assignee can do as work items. What is true of the people on a
piece of work ("has a CDL") is a user field that rolls up through the roster,
and who a group or a piece of work needs to be there is a staffing requirement;
both are in [the assignee base and the roster](assignee-base.md). The structural
facts about a kind of assignee (has members, has a login) are called traits
there, so that "capability" keeps this one meaning.
