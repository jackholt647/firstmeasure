# Schedule events: resources, parents and children, overlap

Read this before changing what a schedule event stores, who or what it is
assigned to, how events relate to each other, or how double-booking is checked.
The code is `public/v1/scheduling/` (`event-model.ts`, `placement.ts`,
`occupancy.ts`, `roster.ts`); the project event write in `platform/api.ts` and the floating
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
  A list the scope did not create (a signed document's material set, or a work
  order or equipment list made in the Project tab) has no `schedule.group_id`;
  when its event is ensured, `scopeScheduleFallback` in `materials/storage.ts`
  takes the grouping (group, title, colour, length, placement, never event types)
  that the project's work plan's template defines for that kind of list, so every
  list of the job still sits under one span. A project whose plans define the
  grouping in more than one template is ambiguous and is left ungrouped. The
  Project tab's Schedule button ensures every list's event first and places the
  span it finds; only with no span does it offer to schedule each list by hand.
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
| `assignee_conflicts` | Overlaps found for the event and for every re-placed child. Each is `{ event_id, assignee: { kind, id, name, unit_id? }, reason: "overlap" | "unit" | "person", capacity, via?, conflicts: [{ event_id, project_id, project_title, title, start_at, end_at, unit_id? }] }`. |
| `equipment_conflicts`, `equipment_operator_warnings` | As before. |

`POST /v1/platform/organizations/:orgId/schedule/overlap-check` takes
`{ project_id?, event }` (a draft, saved or not) and returns
`{ mode, assignee_conflicts }` without saving.

## Roster and warnings

Scheduling reads the assignee base's roster and its check
([assignee base](assignee-base.md#assignment-and-roster)), so who is actually on
an event, unmet staffing requirements and conflicts come from one answer. The
code is `scheduling/roster.ts`, published as `schedule-roster.events`
(`scheduling/publication.ts`, `view_schedule`).

The answer is **derived and read-only**: it is returned beside the events and
never written into them. A page keeps it by event (`PlatformScheduleView.roster`)
and does not put it on the event objects it saves.

- **The assignment** is built from the event's `resource_refs` and
  `assigned_user_ids` with `assignmentFromEvent` (an entry's `op`, `from` and
  `until` are honoured if a writer ever stores them). Equipment is skipped.
- **The roster** is the assignee base's: the people the groups and named people
  put on the event over its range, minus removals and anyone off (time off and
  the scheduling settings' days off). A person in two of the event's groups is
  one person. An outside company is one party.
- **The check** adds the standing staffing requirements of every group on the
  event to the event's own `staffing_requirements` and those of the scope piece
  it was made for (`scope.pieces[].staffing_requirements`).
- **Other work** is every scheduled event in the window the asked-for events
  cover, minus the event's own family. Its people are other work's own
  rosters, so a member of crew A on this event and of crew B on another is seen.
- **Overlap stays `assessAssigneeOverlap`.** It is fed the roster's people
  conflicts (`rosterOverlaps` on a subject). Where the other event names one of
  the assignees that put the person here, the assignee check answers, with its
  units, and the person is not reported again. The rest are reported once per
  person as `reason: "person"`, with `via`. What an overlap does is still the
  organization's and the assignee's setting (a person's own setting, or the
  default), carried as `mode`.
- **Branch scope.** Only assignees in the reader's branches are considered
  ([branches](branches.md#access-the-branch-scope-rule)): an entry naming one
  outside them is left out of the event's assignment and of other work's. The
  members of a group the reader can see are shown, as the group's directory row
  shows them.

`schedule-roster.events` takes `{ events?: [{ project_id?, event_id }], draft?: { project_id?, event }, include_children? }`.
`events` are saved events (a calendar event with no project leaves out
`project_id`); their children come with them unless `include_children` is
false. `draft` is an event being placed, as it would be saved: it replaces the
stored copy, its children are re-placed against it as the save would place
them, and they come back with `draft: true`. At most 200 events per read.

Each event returns:

| Field | Meaning |
|---|---|
| `window` | The range it holds, or null (unscheduled, cancelled). |
| `roster` | `people` (`id`, `user_id`, `name`, `via`, `whole_window`, `present`), `parties`, `absent`, `count`, `party_count`, `min_count`, `max_count`, and `days`: who is on it each local day (`date`, `person_ids`, `party_ids`). Null when it names no one and has no staffing requirement. |
| `staffing_requirements` | Each one checked, met or not, as the check returns it. |
| `warnings` | `{ id, kind, message, accepted, mode, intervals, person_id?, assignee_id?, staffing_requirement_id? }`. Kinds: `staffing_requirement_unmet`, `double_booked` (a person through different assignees), `assignee_overlap` (an assignee over its capacity), `unavailable`, `missing_member` (a member who is no longer active), `unknown_assignee`, `nobody_assigned`. Ids listed in the event's `accepted_roster_warnings` come back `accepted`. |
| `assignee_conflicts` | The overlap check's own answer for the event, including `reason: "person"`. |

**Warnings never block.** Nothing here refuses a save; the event writes are
unchanged and still apply `block` only to the assignee overlap they already
checked.

**Where they show.** The project schedule panel, the Scheduling app and every
view of `PlatformScheduleView` (range views, resource views, the day team grid
and the timeline) draw, on each event, the people as faces with a count and a
small badge whose tooltip lists the warnings; only titles are on the chip. A
one-line chip shows the count and the badge icon; a timed chip gives the faces a
line of their own. While placing, the draft chip and the placement banner show
the draft's warnings as the save would find them.

## Not built

The event writes do not call the roster: `assignee_conflicts` on a save and
`overlap-check` are still the named-assignee check only, and `block` does not
apply to a person reached through two groups (that needs the write in
`platform/api.ts` to pass `rosterOverlaps`). Nothing stores
`accepted_roster_warnings` yet; it is read if present. Working hours are applied
when offering appointment slots, not when checking an overlap. A committed labor
list does not learn that its event moved. `assigned_user_ids` is still a second
place people are named. The roster read scans every project's events
([optimization backlog](../optimization-backlog.md#schedule-roster-reads-every-project)).

Run `tests/schedule-events.test.ts`, `tests/scheduling-event-writes.test.ts`,
`tests/schedule-roster.test.ts` and `tests/schedule-roster-browser.test.mjs`
for changes here.
