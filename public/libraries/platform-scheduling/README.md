# Platform Scheduling Library

`libraries/platform-scheduling/platform-scheduling.js` is the shared browser library for branch-level scheduling. Load it after `libraries/platform-api/platform-api.js`.

## Storage

- User scheduling/access roles and assignment tags live on the canonical
  organization user. Resource-group kinds and tags live in workforce
  configuration and resource-group records.
- Project events live on each project document as `project.events`, an array. New projects should start with `events: []`.
- Branch event defaults live in the branch module `scheduling`.
- Branch variable labels live in the branch module `variable_mappings`.
- Branch stage definitions live in the branch module `stages`.
- Branch trigger definitions live in the branch module `triggers`.

Branch-wide sales appointment hours live in `scheduling.availability.sales_appointment_start_time` and `scheduling.availability.sales_appointment_end_time`. `availability.working_hours[]` mirrors the same start/end window for day matching. Use `PlatformScheduling.availabilityWindow(config, date, 'sales_appointment')` before rendering slots; the project scheduling modal and public website lead embed both depend on this shared window.

The library owns terminology mapping. UI code should use stable ids and render the returned `label`, `mapped_roles`, or `mapped_type` values.

## Defaults

Standard roles:

- `sales_appointments`
- `inside_sales`

Default event type:

- `sales_appointment`: 60 minutes, assignment policy allowing the
  `sales_appointments` user role, assignable later.

## Event Shape

The contract is [schedule events](../../../docs/architecture/schedule-events.md);
this library mirrors `public/v1/scheduling/event-model.ts` and `placement.ts`.
An event is one time range plus the resources it uses for that whole range.

- `start_at`, `end_at`, `duration_minutes`, `all_day`: the range.
- `event_type_default_id`: one template/default id, such as `sales_appointment`.
- `required_role_ids`, `allowed_role_ids`, `role_ids`: roles that must be staffed and roles whose users may be assigned.
- `resource_refs`: the only place an event names its groups, people, companies and equipment, as `{ kind, id, name, role, unit_id?, quantity? }`. The first `crew`-role assignee is the primary one. A resource has no dates of its own.
- `assigned_user_ids`, `assigned_users`: people attached through the sales appointment path.
- `scope_resource_list_id`, `resource_type`, `list_part_id`: the material, labor or equipment list the event was made for.
- `assignment_policy`: the normalized snapshot used to validate the event assignment.

Read resources with `eventResources()`, `eventAssignees()`, `eventEquipment()`,
`eventPrimaryAssignee()` and `eventAssigneeKeys()` (which includes
`assigned_user_ids` as `organization_user:<id>`); do not read the array by
hand. Write them with `setEventWorkAssignees(event, refs)` (the whole assignee
set; equipment is kept) or `setEventPrimaryAssignee(event, ref)`. Read the list
link with `eventListId()`, `eventListPartId()` and `eventResourceType()`.

## Assignment policies

Every data-defined event type may include an `assignment_policy`. Its rules are
alternatives; constraints within one rule are cumulative. Rules may allow
specific subjects, person roles, resource-group kinds, assignment tags, and
scope capabilities. This supports, for example, either a tagged salesperson or
a `sales_team` group, and a production type that accepts only `crew` groups
tagged `drywall`.

Use `PlatformScheduling.filterAssignableSubjects()` to render candidates.
Project event writes enforce the same policy on the server. Availability is
still evaluated for individual users; group selection is assignment
eligibility, not a claim that every member is available.

## Gantt structure fields

All optional; see [schedule events](../../../docs/architecture/schedule-events.md).

- `kind: 'schedule_group'`: a span, an event that holds its own stored range for its children to be placed against (`eventIsSpan()`, `createScheduleGroupEvent()`). Its range is never derived from its children.
- `parent_event_id`: the parent that drives this event. Any event may be a parent and the relation nests. `eventChildren()`, `eventDescendants()`, `eventAncestorIds()` and `eventFamilyIds()` read the family.
- `placement`: where a child sits relative to its parent, `{ anchor: start|end|span, offset?, duration?, all_day?, manual? }` with amounts of `{ value | expression, unit, adjust? }`. The server places children when a parent is saved and returns them in `related_events`. `placeChildren(events, parentId, { measurements })` previews that for a drag and returns `{ updated, blocked }`; `evaluatePlacement()`, `manualPlacement()`, `normalizePlacement()` and `evaluatePlacementExpression()` are its parts. Previews use the browser's local days; the server's answer is the result. Child drafts are not saved one by one: saving a child by hand makes its placement manual.
- `depends_on`: array of `{ id, event_id, type: finish_to_start|start_to_start|finish_to_finish, lag_minutes }` links between siblings. `dependencyRescheduleImpact(events, movedEventId, nextRange)` walks the graph both ways (cycle-safe): successors are pushed later only when their link is violated (slack is kept; nothing is pulled earlier), predecessors are pulled earlier only when needed, whole-day items land on day boundaries and timed items keep their time of day. Locked/completed items never move and are returned in `blocked`. `cascadeDependentDrafts()` returns just the drafts and `scheduleGraph()` exposes the edges.
- `relatedScheduleRescheduleImpact(event, projectEvents, nextRange, project, options)` combines both for one move: `{ children, dependents, drafts, blocked }`, where `children` are placement previews and `dependents` are the linked items the caller saves.

`saveProjectEvent()` resolves to `{ event, project, document, related_events, blocked_children, assignee_conflicts, equipment_conflicts, equipment_operator_warnings }`. `checkAssigneeOverlap(orgId, { project_id, event })` asks the server whether a draft's assignees are already booked without saving and resolves to `{ mode, assignee_conflicts }`.

Scope sets emit this structure from each resource list's `schedule` block (`group_id`, `group_title`, `depends_on: [{ list_id, type, lag_minutes }]`) — the materials store resolves list refs to deterministic event ids at instantiation. `PlatformScheduleView.renderGanttScheduler()` renders it with zoomable hour→month scales, dependency connectors, drag move/resize, and drag-to-link.

Use `availabilityForEventType()` when deciding whether an appointment can be booked. It checks every required role independently and returns `eligibleUsers` from the allowed-role pool.

Required roles are staffed as distinct people by default. If an event type requires `sales_appointments` and `repair`, the slot is viable only when the library can find one available user for each required role. Users with allowed roles are returned as the assignment pool. Use `availableEventTypeTimeSlots()` for calendar-style slot picking; it applies the same required/allowed role logic to every slot.

Availability can evaluate partially assigned events:

```js
PlatformScheduling.availabilityForEventType({
  users,
  projects,
  eventType,
  start,
  assignedUserIds: ['user_salesperson']
});
```

Assigned users are checked for conflicts and can satisfy required roles they have. In a salesperson-plus-repair event, an assigned available salesperson fulfills `sales_appointments`, and the scheduler only needs to find the remaining required repair role. `saveProjectEvent()` does not enforce availability; it saves whatever event it is given. The UI should use `hasAvailability`, `assignedStatus`, and `overrideRequired` to decide whether to warn, block, or allow a controlled override.

Super admin/owner users are treated as having all standard roles when `roles` is missing, so older migrated users continue to work.

## Core Calls

```js
const config = await PlatformScheduling.loadBranchConfig(orgId, branchId);
const users = await PlatformScheduling.listUsers(orgId, config);
const projects = await PlatformScheduling.listProjects(orgId, config);

const availability = PlatformScheduling.availabilityForRole({
  users,
  projects,
  roleId: 'sales_appointments',
  start: '2026-05-04T14:00:00',
  durationMinutes: 60
});

const event = PlatformScheduling.createProjectEvent(project, 'sales_appointment', {
  start: '2026-05-04T14:00:00',
  assignedUserId: availability.availableUsers[0]?.id
}, config);

await PlatformScheduling.saveProjectEvent(orgId, project, event, config);
```

`availableTimeSlots()` returns slots for a day where at least one user with a role can be scheduled. `saveProjectEvent()` calls `PlatformAPI.projects.scheduleEvent()` when available so the server saves the event and emits `project.event_scheduled`. The legacy direct `events` field save is only a fallback.

## Stages

Branch stages default to:

- `new_lead`
- `appointment_scheduled`
- `drafting_proposal`
- `proposal_sent`
- `newly_sold` (displayed as `Sold`; locked/default; should always exist)
- `project_started`
- `in_progress`
- `completed`
- `cancelled`
- `lost`

Legacy-compatible ids such as `contacting` can still be present on older projects or custom branch configurations, but they are not in the default display order. The Stages board displays `contacting` between `new_lead` and `appointment_scheduled` only when at least one project is actually in that stage.

`loadBranchConfig()` returns `config.stages` in branch display order and `normalizeProject(project, config)` adds `project.mapped_stage = { id, label }`. The stage id remains the stable internal variable; labels come from `variable_mappings.labels.stages`.

## Triggers

Trigger execution is API-owned. The default branch trigger is:

- event: `project.event_scheduled`
- condition: scheduled event has `event_type_default_id = sales_appointment` and project stage is `contacting`
- action: `project.stage.set`
- result: project stage becomes `appointment_scheduled`

The Platform API also seeds a default trigger for `project.stage.entered.newly_sold`. It creates a lightweight celebration notification consumed by `PlatformCelebrations`; frontend code does not need to manually play celebration effects after setting the stage.

Frontend code should schedule appointments through `PlatformScheduling.saveProjectEvent()` or `PlatformAPI.projects.scheduleEvent()`, not by writing `project.events` directly, whenever trigger outcomes should run.
