# Schedule events: resources, parents and children, overlap

Read this before changing what a schedule event stores, who or what it is
assigned to, how events relate to each other, or how double-booking is checked.
The code is `public/v1/scheduling/` (`event-model.ts`, `placement.ts`,
`occupancy.ts`); the project event write in `platform/api.ts` and the floating
calendar event write call into it.

## An event

An event is one time range plus the resources it uses for that whole range.
Project events live in `project.events[]`; events with no project live in the
`calendar_events` collection. Both have the same shape.

Anything that needs a different range from its event is a **child event**. A
resource never carries its own dates.

## Resources: one list

`resource_refs` is the only place an event says which crews, companies and
equipment it uses.

```json
{ "kind": "resource_group", "id": "rg_1", "name": "North team", "role": "crew", "unit_id": "unit_2" }
{ "kind": "equipment_type", "id": "lift", "name": "Boom lift", "role": "equipment", "quantity": 2 }
```

| Field | Meaning |
|---|---|
| `kind` | `organization_user`, `resource_group`, `organization_connection` (the three assignee types), `equipment_unit`, `equipment_type` |
| `id`, `name` | The resource. `name` is a display copy. |
| `role` | `crew` for an assignee, `equipment`, or `operator` (a person running equipment). Defaults from `kind`. |
| `unit_id` | Optional. The unit inside the assignee that does the work (see [assignees](assignees.md)). |
| `quantity` | Equipment only. |

The first assignee in the list is the primary one. `eventAssignees(event)`,
`eventEquipment(event)` and `eventAssigneeKeys(event)` in `event-model.ts` are
how server code reads the list; do not read the array by hand.

People attached to an event through `assigned_user_ids` (the sales appointment
path) are still stored there. Readers that need everyone on an event use
`eventAssigneeKeys`, which includes them.

These fields no longer exist on events and must not be written or read:
`work_resource_ref`, `assigned_resource_kind`, `assigned_resource_id`,
`assigned_resource_name`, `resource_id`, `resource_name`, `assigned_crew_id`,
`assigned_crew_ids`, `assigned_crew_name`, `assigned_crew`, `crew_id`,
`crew_name`, and `start_at` / `end_at` on a `resource_refs` entry.

## Link to a list

An event made for a material, labor or equipment list carries
`scope_resource_list_id`, `resource_type` and `list_title`. A list may have more than one
event (two deliveries of one material list): each carries a `list_part_id`, and
the first has an empty one. The list records its first event in `schedule` and
the others under `schedule.parts`. `material_list_id`, `labor_list_id` and
`equipment_list_id` no longer exist, and the same values are no longer copied
into `event.metadata`.

A labor list's own assignment is `list.assignment.work_resource_ref`
(`{ kind, id, name }`) plus `list.assignment.unit_id`. The `crew_id`,
`crew_name` and `resource_kind` copies beside it no longer exist.

## Parents and children

An event may name a parent with `parent_event_id`. The parent drives the child.
There is one relation and it nests: a span for a piece of work, the
installation under it, an equipment reservation under the installation.

- A **span** is an event of `kind: "schedule_group"`. It has its own range, set
  by whoever schedules the work. Its range is not derived from its children.
  Scope templates create one per scope piece and group (`schedule.group_id`).
  A list's `schedule.group_duration` (an amount, reading `measurements.<key>`)
  gives an unscheduled span the length it should run, as `duration_minutes`.
- A child stores a `placement`: where it sits relative to its parent.

```json
{ "anchor": "start", "offset": { "value": -1, "unit": "business_day" }, "duration": { "value": 1, "unit": "day" }, "all_day": true }
{ "anchor": "span" }
```

| Field | Meaning |
|---|---|
| `anchor` | `start`: measured from the parent's start. `end`: measured from the parent's end. `span`: the child covers the parent's whole range. |
| `offset` | `{ value | expression, unit, adjust? }`. Units: `minute`, `hour`, `day`, `business_day`, `week`. `adjust: { calendar: "business_day", direction: "previous" | "next" }` moves a weekend result to a weekday. |
| `duration` | Same shape as `offset`. Left out, the child keeps the length it has. |
| `all_day` | Whether the child occupies whole days. |
| `manual` | Set by the server when someone moved the child by hand. |

An `expression` is `{ operator, left, right }` / `{ operator, operands }` over
numbers and `{ ref }` paths. The paths are `parent.duration.days`,
`parent.duration.minutes` and `measurements.<key>`. Operators: `add`,
`subtract`, `multiply`, `divide`, `floor`, `ceil`, `round`, `min`, `max`,
`coalesce`.

Rules, enforced in the project event write (`placeChildren` in `placement.ts`):

- **Saving a parent with a new range re-places its children**, and theirs. A
  child whose parent is unscheduled is unscheduled.
- **Locked and completed children never move.** They are returned in
  `blocked_children` so the caller can say they are now out of place.
- **Moving a child by hand rewrites its placement** as a fixed offset from its
  parent (`manual: true`), so it keeps that position when the parent moves. A
  hand-moved child of a `span` anchor stops stretching with the parent. A child
  saved with a range and no placement gets one the same way.
- **A placement sent without a range places the child** against its parent as
  it is now.
- A child sent `placement: null` has none and does not follow its parent.
- Deleting a parent leaves its children on the project with no parent.
- Day arithmetic uses the organization's timezone.

A child is a full event. It keeps every field and its events are still emitted
(`project.event_scheduled` carries `parent_event_id`). What differs is the
default behaviour: a child is not a customer appointment. It is not sent for
confirmation, not offered for customer rescheduling and not shown to the
customer unless it says so itself (`confirmation.required`, `customer_visible`).

`depends_on` links between events are a separate thing: ordering between
siblings, cascaded by the schedule views. They are unchanged.

## Overlap

`assessAssigneeOverlap` (`occupancy.ts`) answers "is this assignee already
booked during this range?" from events and nothing else. It is the only
availability answer; a commitment says what was handed over and for what pay,
not when anyone is free.

- Two events overlap when their ranges intersect and they share an assignee.
  Two all-day events on the same day overlap.
- **Family is ignored.** An event never conflicts with its own ancestors or
  descendants.
- **Capacity comes from the assignee's units.** An assignee with no units does
  one job at a time. With units, it can hold as many overlapping events as it
  has units that have no units under them. An event that names a `unit_id`
  conflicts with another event naming the same unit.
- Cancelled and unscheduled events hold nothing.

What happens on an overlap is a setting, not a rule:

| Setting | Where | Values |
|---|---|---|
| Organization default | branch `scheduling` module, `assignee_overlap` | `warn` (default), `block`, `allow` |
| One assignee | `assignee_scheduling_settings` collection, `overlap` | `inherit` (default), `warn`, `block`, `allow` |

`warn` saves the event and returns the overlaps in `assignee_conflicts`.
`block` refuses the save with `409 assignee_conflict`. `allow` skips the check.
The write also checks every child it re-placed, so one response covers the
whole move. `POST .../schedule/overlap-check` runs the same check on a draft
without saving.

Equipment has its own check with the same modes (`equipment/service.ts`): it is
about units and pooled quantities, not people.

## What a write returns

`POST /v1/platform/organizations/:orgId/projects/:projectId/events` returns,
beside `event` and `project`:

| Field | Meaning |
|---|---|
| `related_events` | Children the save re-placed, in their new state. |
| `blocked_children` | Locked or finished children that did not move. |
| `assignee_conflicts` | Overlaps found for the event and for every re-placed child. Each is `{ event_id, assignee: { kind, id, name, unit_id? }, reason: "overlap" | "unit" , capacity, conflicts: [{ event_id, project_id, project_title, title, start_at, end_at, unit_id? }] }`. |
| `equipment_conflicts`, `equipment_operator_warnings` | As before. |

`POST /v1/platform/organizations/:orgId/schedule/overlap-check` takes
`{ project_id?, event }` (a draft, saved or not) and returns
`{ mode, assignee_conflicts }` without saving.

## Not built

A person who belongs to a group is not treated as booked when the group is.
Working hours and days off are applied when offering appointment slots, not
when checking an overlap. A committed labor list does not learn that its event
moved. `assigned_user_ids` is still a second place people are named.

Run `tests/schedule-events.test.ts` and `tests/scheduling-event-writes.test.ts`
for changes here.
