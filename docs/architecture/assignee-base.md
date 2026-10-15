# The assignee base and the roster

Read this before changing what every assignee has, the assignee directory, who
is on a piece of work, time off, or staffing requirements. The code is
`public/v1/assignees/`. [Assignees](assignees.md) covers units, commitments and
delivery; [schedule events](schedule-events.md) covers what an event stores.

## Words

| Word | Meaning |
|---|---|
| **Assignee** | Anyone work can be assigned to. |
| **Kind** | Which of the three an assignee is: a user (`organization_user`), a group of users (`resource_group`) or an outside company (`organization_connection`). Stored references are `{ type, id }`; that `type` is the kind and keeps its stored name. |
| **Type** | What an assignee is within its kind. Always `type_ids`, a list, in code and published rows. **A user's types are their access roles**; there is no separate user type. **A group has exactly one type** (its `kind_id`). **An outside company has zero or more** company types, because one company can do several jobs. |
| **Trait** | A structural fact about a kind: `has_members`, `has_login`, `external_link`, `splits_pay`. Not a *capability*: in this codebase a capability is what kinds of work an assignee can do (`labor/capabilities.ts`, [requirements](requirements.md#capabilities)). |
| **Key** | `organization_user:<id>`: the one string form of a reference. Published row ids, roster ids and condition values use it. |
| **Assignment** | A list of entries that add or remove an assignee, for all of a piece of work or part of it. |
| **Roster** | The people an assignment actually puts on the work at each moment. |
| **Staffing requirement** | A count and a condition over the people on the work: who has to be there. "Requirements" alone means what a job needs done ([requirements](requirements.md): material, work and functions). |
| **Branch** | The organization's settings scope; every assignee belongs to one or more ([branches](branches.md)). Above branches are optional flat **regions**; below them, each branch's departments. |

## One contract, three stores

The three kinds stay in their own stores. `AssigneeRecord` in `contract.ts` is
what every assignee has; `adapters.ts` has one adapter per kind that fills it
with that store's own reader. Nothing outside the adapters reads a user
document, a group row or a connection row to learn these things.
`labor/assignees.ts` is a thin user of it and keeps the names labor, payroll and
scheduling already import.

The kinds differ by **trait**, not by class. Ask the trait:

| Trait | User | Group of users | Outside company |
|---|---|---|---|
| `has_members` (members are always users) | no | yes | no |
| `has_login` | yes | no | only once linked to its own organization |
| `external_link` (can be linked and onboarded) | no | no | yes |
| `splits_pay` | no | yes | no |

### Where each shared field lives

A field is read from the home it already had. The base record holds only what
had none.

| Field | User | Group of users | Outside company |
|---|---|---|---|
| name, status | user document | `resource_groups` row | `organization_connections` row |
| **types** (`type_ids`) | the roles they resolve to today: the user document's `access_role_ids`, or the role inferred for them when none are saved. Also given as `role_ids` | the row's `kind_id`, exactly one. The kind **is** the type; there is no second field | base record `type_ids`, zero or more |
| **tags** | user document `assignment_tag_ids` | row `assignment_tags_json` | row `metadata.assignment_tag_ids` |
| **departments** | the department catalog (`workforce/departments.ts`), for all three kinds: direct assignment (`subject_keys`), a role, the type of a group, and for a user the groups they are in. Resolved by `resolveOrganizationStructure`, the same resolver access and scheduling use | same | same |
| **permissions** | their own roles and overrides, on the user document | none of its own: the roles a member gets on joining belong to the group **type** | its own permission set, in the base record |
| standing staffing requirements | not allowed | base record | not allowed |
| members | none | `resource_group_memberships` | none |
| **branches** (`branch_ids`) | user document `branch_id` (their own branch) plus `branch_ids` | row `branch_id` plus `metadata.branch_ids` | `organization_connection_branches`; none means every branch |

A user and a group always belong to at least one branch (`default` when nothing
is saved). A branch is not a department and does not stand in for one; a
department belongs to one branch. Branch membership is set with
`organization-branches.membership.set`; department assignment with the existing
`workforce.departments.assign`, which already takes a user, a group or a
connection.

**Branch scope.** With the multiple-branches feature and more than one branch, a
person reading the directory (or the People lists) sees only the assignees of
the branches they may see: their own, their region's with
`view_region_branches`, every branch with `view_all_branches`. Writes need the
assignee in a branch they manage. See [branches](branches.md#access-the-branch-scope-rule).

`assigneeTypeIds(orgId, ref): Promise<string[]>` (`base.ts`) answers "what are
its types" for any kind, and is what pay defaults and field homes call. It is
empty for an assignee that does not exist.

A user's types are the roles they resolve to today, by the same resolution the
permission system uses (`resolveAccessProfile`). A saved `access_role_ids` list
is authoritative and is read as it is. A user with none saved still has the role
inferred from their older permission level, and that role is their type, so pay
defaults and field definitions on a role reach them. Reading this saves nothing
to the user.

### The type lists

There are two, both in the workforce configuration and of the same shape
(`id`, `name`, `description`, `status`):

- **Group types** are `resource_group_kinds`. The list keeps its stored name
  because a group's `kind_id`, department `group_kind_ids` and assignment rules
  already point at it.
- **Company types** are `organization_connection_types`.

There is no user type list. A user's types are roles, and roles live in the
role store (`workforce/access.ts`); the directory names them from there.

`assignees.type.save` adds, renames or archives a type in either list (`kind`
says which). A type cannot be archived while a group or a company still has it.
`assignees.profile.set` sets an assignee's tags, and its types where they can be
set: the whole list for an outside company, exactly one for a group. It refuses
types for a user; change their roles with the existing role assignment.

### Roles a group type gives its members

Permission defaults belong to the group **type**, not to each group. A group
type carries `member_role_ids`. When a user becomes an active member of a group
of that type, those roles are added to the user's `access_role_ids`, where
permissions live.

- A role the user already has is left alone.
- **Nothing is removed when they leave.** A role outlives the membership that
  gave it.
- Changing a type's `member_role_ids` changes no one who is already a member.
- The roles added are recorded on the membership row (`joined_role_ids`), so it
  can be told afterwards that they came from joining.
- A saved role list is authoritative, so for a user with none saved yet the
  roles they resolve to today are written together with the new ones. Saving
  only the new ones would take their inferred role away.

It happens in `grantGroupTypeRolesOnJoin` (`workforce/storage.ts`), which every
path that adds a member runs after the membership is saved: creating a group
with members (`createResourceGroup`), replacing a group's member list
(`patchResourceGroup`: whoever is active now and was not before), and adding
one member or reactivating an inactive one (`putResourceGroupMember`). Each
returns `member_role_grants`, one entry per user who joined, with the roles
added or the reason they could not be. A failure to write a user's roles is
reported there; the membership stands.

Choosing those roles is permission administration: `assignees.type.member-roles.set`
needs `manage_company_user_permissions`. Saving the type list or the workforce
configuration with company settings access keeps `member_role_ids` as they are
and cannot change them. Someone with company settings access can still put a
user into a group and so give them that type's roles; that is the point of the
default, and it is why the roles are chosen by a permission administrator.

**Pay never hangs off tags.** Pay defaults attach to types: a role for users,
the group type, a company type. That wiring is payroll's
([pay rules](pay-rules.md)) and is not in this module.

### The base record

`assignee_base` (in `assignees.sqlite`, or PostgreSQL in cluster mode) has one
row per assignee that has something saved: `type_ids` and `permission_defaults`
(outside companies), `staffing_requirements` (groups), `revision`. An assignee
with no row reads as an empty record; reading never writes. A user has nothing
here.

An outside company's **permission set** is `{ access_role_ids, permission_overrides }`:
what its own people get while they work on this organization's projects
(`assignees.permission-defaults.set`). It is stored and documented only.
Nothing resolves it yet, and nothing reads the base record when a permission is
checked. Permission resolution is unchanged.

`carriedPermissions(orgId, record)` reads what each kind carries from where it
lives: a user's own roles, the roles a group's type gives on joining, a
company's permission set.

### Removal

`cleanupAssignee(orgId, ref, actor)` removes what hangs off a reference to an
assignee that is archived or gone. It refuses an assignee that is still active.
Each step reports what it removed and what it kept, and one failing step does
not stop the others. A module that keeps records by assignee registers its step
with `registerAssigneeCleanup` and is listed in `cleanupOwners` in `base.ts`.

| Wired | What it does |
|---|---|
| `assignee-base`, `assignee-time-off` | deletes the base record and time off |
| `labor-pay-sheets` | archives the assignee's pay sheets |
| `assignee-units` | archives units from the bottom up; one that holds committed work is kept and reported |
| `assignee-capabilities`, `labor-delivery-settings` | deletes the record |
| `payroll-pay` | payroll's own step (`payroll/assignee-cleanup.ts`): it keeps what was earned and closes the pay setup |

It runs when a group or an outside company is archived through its HTTP route
(the response carries `assignee_cleanup`). Not wired: archiving or deleting a
user; the scheduling setting in `assignee_scheduling_settings`; `subject_keys`
in the department catalog; a removed user's group memberships; commitments,
which are frozen and never touched. Restoring an archived assignee does not bring cleaned up
records back.

## Published

Everything here reads only. Reads need `view_schedule`, except the one noted.

| Export | What |
|---|---|
| `assignee-directory.assignees` | One row per assignee, selectable with `selectPublishedData` |
| `assignee-directory.types` | The group types and the company types |
| `assignee-directory.time-off` | Time off as exact intervals |
| `assignee-directory.staffing-requirements` | Each group's standing staffing requirements |
| `assignee-directory.permission-defaults` | One outside company's permission set, `{ assignee, permission_defaults, revision }`. The target `id` is the company's key (`organization_connection:<id>`). Needs `manage_company_user_permissions`, not `view_schedule`: it is kept out of the directory row on purpose |
| `assignment-roster.roster` | Who is on a piece of work (arguments: the assignment and the window) |
| `assignment-roster.check` | What is wrong with an assignment |

| Action | Permission |
|---|---|
| `assignees.type.save`, `assignees.profile.set` (types and tags), `assignees.staffing-requirements.set` | `manage_company_settings` |
| `assignees.type.member-roles.set`, `assignees.permission-defaults.set` (outside companies only) | `manage_company_user_permissions` |
| `assignees.time-off.save`, `assignees.time-off.remove` | `manage_schedule` |

A directory row:

```json
{ "id": "resource_group:rg_1", "kind": "resource_group", "assignee_id": "rg_1", "name": "Crew A", "status": "active",
  "type_ids": ["crew"], "type_names": ["Crew"], "role_ids": [], "tag_ids": ["roofing"], "department_ids": ["production"], "branch_ids": ["default"],
  "traits": { "has_members": true, "has_login": false, "external_link": false, "splits_pay": true }, "link_status": "",
  "fields": {}, "fields_error": "",
  "member_ids": ["organization_user:ana", "organization_user:ben"], "member_count": 2,
  "members": [{ "id": "organization_user:ana", "user_id": "ana", "name": "Ana", "role": "member", "is_lead": true, "status": "active", "type_ids": ["crew_foreman"], "tag_ids": ["lead"], "fields": { "has_cdl": true } }],
  "member_fields": { "has_cdl": [true, false] }, "member_tag_ids": ["lead"], "member_type_ids": ["crew_foreman"],
  "group_ids": [], "revision": "sha256:..." }
```

`type_ids` is a list for every kind: a user's role ids (also in `role_ids`,
which is empty for the other kinds), a group's one type, a company's zero or
more. `type_names` names them in the same order, from the list that kind draws
on; an id with no name there is its own name. A member's `role` is their role
*in the group* (member, lead), not an access role. A type row is
`{ id, name, description, status, kind, member_role_ids }`, where `kind` is
`resource_group` or `organization_connection`.

**What is true of a person lives on them and rolls up.** "Has a CDL" is an
ordinary user custom field. A user's row carries their values under `fields`; a
group's row carries its members with their fields and, under `member_fields`,
each field as the list of its members' values. No field is special.

```json
{ "where": { "rules": [{ "field": "kind", "operator": "equals", "value": "organization_user" }, { "field": "fields.has_cdl", "operator": "equals", "value": true }] } }
{ "where": { "rules": [{ "field": "member_fields.has_cdl", "operator": "contains", "value": true }] } }
{ "where": { "rules": [{ "field": "type_ids", "operator": "contains", "value": "crew_foreman" }] } }
```

The second selects groups with at least one member who has a CDL. "At least
two" is a staffing requirement, not a selection. The third selects everyone
with a role.

A row carries a user field only if it is not `private` and names no
`read_permission`. The rule is the same for every reader, so a staffing
requirement never comes out differently depending on who asked. Non-private
user fields are therefore visible to anyone who can view the schedule; a field
that schedulers must not see has to be marked private. When a user's fields
cannot be read, `fields_error` says so rather than the row looking as if they
had none.

## Assignment and roster

```json
[ { "op": "add", "assignee": { "type": "resource_group", "id": "rg_1" } },
  { "op": "remove", "assignee": { "type": "organization_user", "id": "ben" } },
  { "op": "add", "assignee": { "type": "organization_user", "id": "dan" }, "from": "2026-10-13T08:00:00Z", "until": "2026-10-13T17:00:00Z" } ]
```

Entries apply in order and a later one wins where they overlap. `from` and
`until` are optional; left out, the entry holds for the whole window.

`resolveRoster` (`roster.ts`) is pure. `loadRoster(orgId, input)` gathers what
it needs from the stores. The effective roster is the members of the groups,
plus the people added, minus the people removed, minus anyone who is off.

- **Exact intervals.** Everything is stored and compared as instants. Someone
  off for a morning is off for that morning and on for the afternoon. Showing it
  by the day or by the hour is a screen's choice.
- **A person in two assigned groups is one person.** `via` lists both.
- **An outside company is one party.** Nothing is known about who it sends.
- **Unavailable people come off the roster.** Time off comes from
  `assignee_time_off` and from the scheduling settings' whole-day exceptions
  (`resource_availability["<kind>:<id>"].exceptions`, `available: false`), read
  as that whole local day. Working hours are not treated as time off.
- **Being promised twice is a conflict, and the person stays on the roster.**
  Other work is every scheduled event in the window: a group on another event
  holds its members.
- A member who is not active, and an entry naming no one, are reported.

Worked example. Crew A is Ana (CDL), Ben and Cy. The work runs 8:00 to 17:00 on
Oct 13. Ana has time off 8:00 to 12:00. The assignment is `[add Crew A]`:

```json
{ "window": { "from": "2026-10-13T08:00:00.000Z", "until": "2026-10-13T17:00:00.000Z" },
  "assigned": [{ "id": "resource_group:rg_1", "kind": "resource_group", "name": "Crew A" }],
  "people": [
    { "id": "organization_user:ana", "name": "Ana", "type_ids": ["crew_foreman"], "fields": { "has_cdl": true }, "via": ["resource_group:rg_1"], "whole_window": false,
      "present": [{ "from": "2026-10-13T12:00:00.000Z", "until": "2026-10-13T17:00:00.000Z" }], "removed": [],
      "unavailable": [{ "from": "2026-10-13T08:00:00.000Z", "until": "2026-10-13T12:00:00.000Z", "reason": "Dentist", "source": "time_off", "source_id": "time_off_1" }] },
    { "id": "organization_user:ben", "name": "Ben", "present": [{ "from": "2026-10-13T08:00:00.000Z", "until": "2026-10-13T17:00:00.000Z" }], "whole_window": true },
    { "id": "organization_user:cy", "name": "Cy", "present": ["..."], "whole_window": true } ],
  "absent": [], "parties": [], "conflicts": [], "unknown": [],
  "timeline": [
    { "from": "2026-10-13T08:00:00.000Z", "until": "2026-10-13T12:00:00.000Z", "person_ids": ["organization_user:ben", "organization_user:cy"], "party_ids": [] },
    { "from": "2026-10-13T12:00:00.000Z", "until": "2026-10-13T17:00:00.000Z", "person_ids": ["organization_user:ana", "organization_user:ben", "organization_user:cy"], "party_ids": [] } ],
  "facts": { "count": 3, "min_count": 2, "max_count": 3, "party_count": 0, "person_hours": 23, "type_ids": ["crew_foreman"], "tag_ids": [],
    "person_ids": ["organization_user:ana", "organization_user:ben", "organization_user:cy"], "fields": { "has_cdl": [true] } } }
```

`people` also carry `user_id`, `type_ids` (their roles), `tag_ids`,
`department_ids` and `group_ids`. A party carries the company's `type_ids`.
`absent` lists people the list names who are not on the work at all, with
`reason` `removed`, `unavailable` or `inactive`. `facts` is what duration
formulas and pay read. `rosterAt(roster, instant)` answers one moment.

## Staffing requirements

A staffing requirement is exactly a count and a condition:

```json
{ "id": "cdl", "label": "CDL driver", "count": 1, "where": { "rules": [{ "field": "fields.has_cdl", "operator": "equals", "value": true }] } }
```

"At least `count` people on the work for whom `where` holds." `where` is the
group form of the one condition contract (`work/conditions.ts`); there is no
second matcher. Its fields are `id`, `user_id`, `name`, `type_ids`, `tag_ids`,
`department_ids`, `group_ids` and `fields.<path>`. "Someone with this role" is
`{ "field": "type_ids", "operator": "contains", "value": "crew_foreman" }`.
"This specific person" is
`{ "field": "id", "operator": "equals", "value": "organization_user:dan" }`.
`label` is a singular noun phrase used in the reason.

- A group's standing staffing requirements are in its base record
  (`assignees.staffing-requirements.set`). Only an assignee with members can
  have them.
- A piece of work carries its own and passes them to the check as
  `staffing_requirements`.
- Both are checked against the **whole** effective roster, at every moment of
  the window. Adding someone to the work can meet a group's requirement.

`evaluateStaffingRequirements(roster, requirements, { timezone })`
(`staffing-requirements.ts`) is pure. `checkAssignment(orgId, input)` loads the
roster, adds the standing staffing requirements of every group the list adds,
and returns warnings. For the example above with Crew A's requirement:

```json
{ "ok": false, "timezone": "UTC",
  "staffing_requirements": [{ "id": "staffing-requirement:5c1f...", "staffing_requirement_id": "cdl", "label": "CDL driver", "count": 1,
    "source": { "kind": "assignee", "id": "resource_group:rg_1", "name": "Crew A" }, "met": false,
    "unmet": [{ "from": "2026-10-13T08:00:00.000Z", "until": "2026-10-13T12:00:00.000Z", "matching": 0 }],
    "matching_ids": ["organization_user:ana"],
    "missing": [{ "id": "organization_user:ana", "name": "Ana", "reason": "unavailable", "intervals": [{ "from": "2026-10-13T08:00:00.000Z", "until": "2026-10-13T12:00:00.000Z" }] }],
    "reason": "Crew A is assigned, but its only CDL driver (Ana) is off 8:00 AM-12:00 PM on Oct 13." }],
  "warnings": [
    { "id": "staffing-requirement:5c1f...", "kind": "staffing_requirement_unmet", "message": "Crew A is assigned, but its only CDL driver (Ana) is off 8:00 AM-12:00 PM on Oct 13.", "accepted": false, "staffing_requirement_id": "cdl", "intervals": ["..."] },
    { "id": "unavailable:9a20...", "kind": "unavailable", "message": "Ana is off 8:00 AM-12:00 PM on Oct 13 (Dentist) and is not counted on the work then.", "accepted": false, "person_id": "organization_user:ana", "intervals": ["..."] } ] }
```

**Warnings never block.** Nothing in this module refuses a save. The remedies
are to add another assignee for that time, or to accept the warning: pass its
`id` in `accepted` and it comes back marked accepted. A warning's id changes
when what it is about changes, so an old acceptance does not cover a new
problem. Warning kinds: `staffing_requirement_unmet`, `double_booked`,
`unavailable`, `unknown_assignee`, `nobody_assigned`.

## Departments

Departments are read from where they already live, the one department catalog.
Each department belongs to one branch (`branch_id`); a role or a group type
puts an assignee in a department only when the assignee belongs to that branch.
There are no department categories.
A department definition has a `color` and, beside it, an optional `icon`: a
Font Awesome class name such as `fa-helmet-safety`, the same kind of value
scope templates and equipment types store (`departmentIconSchema` in
`workforce/department-contracts.ts`; an empty string clears it). It is kept
through every catalog save and published wherever the color is, which is the
`workforce-departments.catalog` export and the departments HTTP route.

## For scheduling

Scheduling reads the roster and the check for what it shows: `schedule-roster.events`
(`scheduling/roster.ts`, see [schedule events](schedule-events.md#roster-and-warnings))
calls `assignmentFromEvent` and `checkAssignment` for each event and each draft
being placed, passing the schedule it read once as `other_work` and the time off
for the window as `unavailable`, and limited to the reader's branches. The
answer is derived and never stored on the event. The event writes themselves do
not call the check yet; the steps below are what is left for them.

1. **Keep `op` on a `resource_refs` entry.** `normalizeResourceRef` drops
   everything but `kind`, `id`, `name`, `role`, `unit_id` and `quantity`. Keep
   `op: "remove"` on an assignee entry (absent means add), so "crew A minus Ben"
   can be stored. `eventAssignees` and the overlap check must skip entries with
   `op: "remove"`.
2. **Time-limited entries.** Keep "a resource never carries its own dates" and
   store "Dan covers Tuesday" as a child event whose resources are the change;
   that fits the event model as it stands. `assignmentFromEvent(event, changes)`
   also accepts `from` / `until` on an entry should that rule ever change: it reads
   `op`, `from` and `until` from each entry, adds `assigned_user_ids`, and limits
   the entries of each event in `changes` to that event's own range. Which
   children are roster changes is scheduling's to decide.
3. **Carry the work's staffing requirements** as `staffing_requirements` on the
   event (or on the list or scope piece it was made for): an array of the shape
   above.
4. **Call the check where `assessAssigneeOverlap` is called** (the project event
   write, the calendar event write and `POST .../schedule/overlap-check`):

   ```ts
   const { checkAssignment, assignmentFromEvent, eventWindow } = await import("../assignees/roster.js");
   const window = eventWindow(event);
   const check = window && await checkAssignment(orgId, {
     assignment: assignmentFromEvent(event, rosterChangeChildren),
     from: window.from, until: window.until,
     exclude_event_ids: [...eventFamilyIds(events, event)],
     staffing_requirements: event.staffing_requirements || [],
     accepted: event.accepted_roster_warnings || [],
     branch_id: branchId
   });
   ```

   Return `check.warnings` beside `assignee_conflicts` as `roster_warnings`, and
   store the ids someone accepts as `accepted_roster_warnings` on the event. Do
   not refuse the save. During a write, pass the schedule as it will be after
   the save as the third argument, `{ other_work }`, built with
   `assignmentFromEvent` for each event; otherwise the check reads the stored
   schedule.
5. **Per-person booking.** `roster.conflicts` is the answer to "a person who
   belongs to a group is not treated as booked when the group is". It does not
   replace capacity by units, which stays in `occupancy.ts`.
6. **Time off** is stored here (`assignee_time_off`, `assignees.time-off.save`)
   as exact intervals for a user or an outside company. The whole-day
   `exceptions` in the scheduling settings are still read. If scheduling wants
   one home, move the exceptions here; do not add a third.
7. `assignee_scheduling_settings` should register a cleanup step with
   `registerAssigneeCleanup` and be added to `cleanupOwners`.

## Open with other threads

Each of these is a place where two parts of the platform answer the same
question. None is resolved in this module; each needs the other owner.

**One home for time off.** Time off is recorded in two places: the scheduling
settings hold whole-day exceptions per assignee
(`resource_availability["<kind>:<id>"].exceptions`), and this module holds
exact intervals (`assignee_time_off`). The roster reads both, so nothing is
missed today, but a person can be marked off in one place and not show in the
other's screen, and only one of them can say "the morning". Proposed: this
module's exact-interval record is the home. Scheduling writes a day off as an
interval covering that local day through `assignees.time-off.save`, existing
exceptions are converted once, and the settings stop holding them. Working
hours stay in the scheduling settings; they are not time off.

**One conflict check.** Scheduling's `assessAssigneeOverlap` and this module's
roster both decide whether an assignee is already promised. For what scheduling
shows they now give one answer: `schedule-roster.events` feeds the roster's
people conflicts into `assessAssigneeOverlap` (`rosterOverlaps`), which leaves a
conflict to its own assignee check, with units, when the other event names one
of the assignees that put the person on this one, and otherwise reports it once
per person (`reason: "person"`). Still open: the event writes and
`POST .../schedule/overlap-check` in `platform/api.ts` call the overlap check
without the roster (step 4 above), so a save's `assignee_conflicts` and `block`
do not yet see a person reached through two groups.

**Project and labor commitment lists published once.** Payroll re-publishes the
project and labor-commitment sources its pay rules select from, alongside the
exports their owners already publish (`labor-commitments.project` and the
project provider). Two exports of the same records can drift in shape,
permission and revision, and a consumer cannot tell which is authoritative.
Proposed: each list is published once, by its owner, as a selectable
collection; pay rules bind to those exports and payroll removes its copies.

**Nesting.** The product rule is that groups and departments do not nest.
Divisions are gone: above departments are branches and flat regions
([branches](branches.md)). One structure still nests: labor's units
(`assignee_units`, `parent_unit_id`) inside an assignee. A unit is capacity
inside one assignee, never a group of its own, has no members, types or
permissions, and nests only to describe how capacity is divided. Whether it
becomes a count on the assignee is a decision for labor.

**Hourly and salary entered twice.** An hourly rate or a salary can be put on a
pay sheet (how an assignee prices a job) and as a pay rule (what an assignee is
paid, and when). The same number in two places will be changed in one and not
the other, and an assignee could be paid on both. Proposed: time-based pay is a
pay rule only. A pay sheet prices work on a job from its measurements and
inputs and does not carry hourly or salary lines; sheets that have them are
converted to rules and the sheet editor stops offering them.

**The older assignable-subject code.** `public/v1/workforce/assignability.ts`
(with `listAssignableResources` and `resolveAssignableSubjects` in
`workforce/service.ts`) builds its own projection of users, groups, companies
and equipment and filters it with its own policy rules over `kind_ids` and
`assignment_tag_ids`. It predates the assignee contract and repeats what the
directory now publishes; for a user it already puts roles in `kind_ids`, which
is the same idea as "a user's types are their roles", under another name.
Proposed: retire it in favour of the assignee contract. Assignment policies
become declared selections over `assignee-directory.assignees` (`type_ids`,
`tag_ids`, `department_ids`, `fields`), equipment is selected from the
equipment provider, and the `assignable-resources` and
`assignable-subjects/resolve` routes are removed once their callers have moved.

## Not built

Any interface of this module's own (scheduling shows the roster and the check on
events; see [schedule events](schedule-events.md#roster-and-warnings)). Applying an outside company's permission set. Exposing
selections, and therefore the directory, to the module sandbox. An index: the
directory reads every assignee, and each user's fields one at a time, on every
read; the roster's conflict check reads every project's events. Working hours
as unavailability. Recurring time off.

Run `tests/assignee-base.test.ts`, `tests/assignee-roster.test.ts` and
`tests/assignee-base-store.test.ts` (also through
`node tests/run-embedded-postgres.mjs tests/assignee-base-store.test.ts`) for
changes here.
