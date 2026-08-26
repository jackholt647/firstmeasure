# Platform Scheduling Library

`libraries/platform-scheduling/platform-scheduling.js` is the shared browser library for branch-level scheduling. Load it after `libraries/platform-api/platform-api.js`.

## Storage

- User scheduling roles live on each user document as `user.roles`, an array of stable ids such as `sales_appointments`.
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

- `sales_appointment`: 60 minutes, role `sales_appointments`, assignable later.

## Event Shape

Events deliberately separate singular scheduling facts from plural staffing facts:

- `start_at`: one ISO timestamp.
- `duration_minutes`: one duration.
- `event_type_default_id`: one template/default id, such as `sales_appointment`.
- `required_role_ids`: array of roles that must have at least one available person.
- `allowed_role_ids`: array of roles whose users may be assigned to the event.
- `role_ids`: compatibility/read shortcut containing the union of required and allowed roles.
- `assigned_user_ids`: array of assigned user ids.
- `assigned_users`: optional denormalized array with `{ id, name, role_ids }` for fast rendering.

Older singular fields like `assigned_user_id` are normalized into the arrays for compatibility, but new code should write the plural fields.

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
