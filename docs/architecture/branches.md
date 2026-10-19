# Branches and regions

Read this before changing branches, regions, departments' place in the
organization, who belongs to which branch, or what a person may see of other
branches. The code is `public/v1/workforce/`: `department-contracts.ts`
(stored shapes and the migration), `departments.ts` (the catalog),
`organization-structure.ts` (the one resolver), `branch-scope.ts` (who may see
and manage which branches), `branch-guards.ts` (scope on the People routes),
`branches.ts` and `branch-publication.ts` (the structure read and actions).

## The hierarchy

```
organization
  └─ region (optional, flat)          catalog `regions[]`, lists its branch_ids
       └─ branch                       a `branch` document; `default` always exists
            └─ department              catalog `departments[]`, each with one branch_id
```

| Word in code | What it is | UI word |
|---|---|---|
| **branch** | The organization's settings scope (`branch` documents and branch modules in `platform/storage.ts`). `default` always exists. | From the terminology system: a company may call it a location, office or yard. |
| **region** | A flat group of branches, for sorting, filtering and access scope. A branch is in at most one region, or in none. A region never contains a region and never holds departments. | From the terminology system. |
| **department** | Belongs to exactly one branch (`branch_id`). Each branch configures its own. Department ids stay unique across the organization. | Department terminology in the catalog (`terminology.department`). |

There are **no department categories**: `groups` and `group_id` are gone from
the catalog, the department save and the scheduling copy. There are **no
organizational units** (`divisions`, `division_id`, `division_ids`): units
became regions or were dropped (see Migration). Groups of users and departments
do not nest; regions are flat because nothing needed nesting.

## One branch is no branch

A typical roofing company has one branch. Then:

- The default branch is used implicitly. It needs no name (`name: ""`; the
  `"Default Branch"` placeholder storage writes counts as no name).
- Nothing about branches or regions is shown anywhere, except the Branches
  button on the People overview when the feature is on.
- Nothing is restricted. Branch scope applies only when the organization has
  the feature **and** more than one active branch (`multiple: true`).

Multiple branches is the feature `platform.multiple_branches` (Platform &
Appearance, requires `platform.expanded_access`, default off). Regions are
behind the same feature. With it off, an organization with several branch
documents still behaves as one implicit branch: nothing is shown or scoped.

When the organization adds its first extra branch, the existing default branch
becomes the one everyone is in ("my branch" for its people) and can be given a
name (`organization-branches.branch.rename` with `branch_id: "default"`) and a
region.

## Who belongs to a branch

Users, groups of users and outside companies belong to one or more branches.
Each kind keeps them where it already kept its branch; the assignee base
publishes them as `branch_ids` on every directory row.

| Kind | Home | Rule |
|---|---|---|
| User | user document `branch_id` (their own branch; it picks their settings and is `ctx.branchId`) plus `branch_ids` | Always at least one; `branch_id` is first. Nothing saved means `["default"]`. |
| Group of users | `resource_groups.branch_id` plus `metadata.branch_ids` | Always at least one; `branch_id` is first. |
| Outside company | `organization_connection_branches` rows | Empty means the company works in **every** branch. |

`listResourceGroups(org, { branch_id })` and the users list's `branch_id`
filter match any of a record's branches.

A role or a group type puts someone in a department only when they belong to
that department's branch. Direct assignment (`subject_keys`) is explicit and is
kept as made. A person inherits the departments of the groups they are in, as
before. So a department-scoped role applies within that branch.

## Access: the branch-scope rule

**Most people see and manage only their own branches.** Four permissions widen
that; they are in People & access, subcategory Branches, and are available only
with the feature on:

| Key | Meaning |
|---|---|
| `view_region_branches` | See the other branches of the regions their branches are in. |
| `manage_region_branches` | Manage them. Implies seeing them. |
| `view_all_branches` | See every branch. |
| `manage_all_branches` | Manage every branch. Implies seeing every branch. Also needed (with `manage_company_settings`) to add or archive branches and change regions. |

The seeded Administrator and Super Administrator roles have them (explicitly and
through `*`); no other seeded role does. They cannot be given at department,
branch or region scope (`isDepartmentScopeablePermission`).

Branch scope never grants anything. The record's ordinary permission
(`manage_company_users`, `manage_company_settings`, ...) is still required; scope
only removes records outside the reach. Enforced on the server for:

| Data | Read | Write |
|---|---|---|
| Users: `GET /v1/platform/organizations/:org/users` and `.../users/:id`, `GET /v1/workforce/organizations/:org/users` and `.../users/:id/profile` | only users in visible branches; the viewer always sees themselves | create (a restricted maker's new user without a branch lands in the maker's own branch; any branch given must be manageable), PUT/PATCH/DELETE, the invite resend (`POST .../users/:id/invite`) and the profile PATCH need the user in a manageable branch, and every branch added or removed must be manageable |
| Groups: `/v1/workforce/organizations/:org/branches/:branch/resource-groups[...]` | listed and read only in visible branches | create in the route's branch, patch, archive, member changes need a manageable branch; moving `branch_id` needs both |
| Outside companies: `/v1/connections/organizations/:org/organization-connections[...]` | a company with no branch is always visible | needs a manageable branch; only someone who manages every branch can create a company with no branch or change one |
| Assignee directory: `assignee-directory.assignees` | rows of visible branches (companies with no branch always) | n/a |
| Departments: `GET/PUT /v1/workforce/organizations/:org/departments`, `workforce-departments.catalog`, `workforce.departments.*` | only departments of visible branches; the people lists in the response are scoped too | a save changes, adds or moves only departments of manageable branches; departments of branches the saver cannot see are kept as they are; a direct assignment needs the person, group or company in a manageable branch and every department whose members change in a manageable branch |
| Direct department assignment (`subject_keys`, by save or `workforce.departments.assign`) | n/a | someone without `manage_all_branches` may put a person, group or company only in a department of a branch that assignee belongs to (`department_branch_mismatch`, 400); `manage_region_branches` lifts this inside their region. A company with no branch fits every branch |
| Appointment catalog of a branch (`appointments/planning.ts`) | lists only that branch's departments; a stored preset naming another branch's department loses that department and those staffing requirements; assignees' `department_ids` are limited to the branch | a save naming another branch's department is `department_other_branch` (400); booking cannot ask for one (`unknown_department`). A department without `branch_id` counts as every branch's |
| Scoped roles: `scoped_access_assignments` on the profile PATCH | n/a | a newly added department, branch or region grant must be inside manageable branches (a region needs all its branches) |

Scoped role grants now have three scopes: `department`, `branch` (its
departments and every record tagged with the branch) and `region` (its
branches). A role given in a region covers its branches. `division` is read as
the scopes the old unit now covers and is saved as those.

## The resolver

`organization-structure.ts` stays the one resolver for auth, scheduling and
reporting. `resolveOrganizationStructure(org)` returns:

```ts
{ catalog,                                   // departments (each with branch_id), regions (all, with status), terminology, unit_migration?
  branches: [{ id, name, status, is_default }],
  regions:  [/* active regions only */],
  users | groups | connections: [{ id, department_ids, branch_ids, region_ids, sources }],
  meaningful_department_count }
```

Pure helpers: `buildOrganizationStructure(catalog, users, groups, connections?, branches?)`,
`subjectBranchIds`, `branchIdsInRegion`, `regionIdsForBranch`,
`departmentIdsInBranch`, `departmentIdsInRegion`, `structureBranch`.
`divisionAncestors` and `departmentIdsInDivision` are gone.
`relevantDepartmentContext` returns `branch_ids` and `region_ids` in place of
`division_ids`. Stats' organizational dimension is `region_id` (a filter on the
region's branches); the stats field catalog lists `regions`.

## Migration

No live customers, so there is no compatibility layer, only a migration on read.

- **A stored catalog with units or categories** (`divisions`, `groups`,
  `group_id`, `division_id`) is migrated when read (`migrateLegacyCatalog`) and
  written in the new shape on its first save, with `unit_migration` recording
  what each unit became.
  - Categories are dropped.
  - A department moves to the branch of its unit, or of the nearest unit above it
    that names a branch; otherwise to the default branch.
  - A unit that **stands for one branch** (it names a branch and nothing below it
    names another) is that branch: its scoped grants become `branch` grants.
  - A unit that **groups branches** (branches are named below it, or by it and
    below it) becomes a flat region with the same id and label. Each branch goes
    to its nearest grouping unit. A grant on an outer grouping covers the regions
    inside it.
  - A unit that names **no branch**, itself or below it, is dropped with its
    grants (`unit_migration.dropped_unit_ids`). Direct affiliations to units
    (`subject_keys`) are dropped: membership is branch membership now.
  - Archived units and units naming a branch that does not exist are dropped.
- **Older per-branch scheduling catalogs** (no organization catalog saved yet)
  are projected as before; each department is in the branch it was first found
  in. The first save adopts them.
- **Saved `division` grants** on users resolve through `unit_migration` (or a
  region of the same id) and are rewritten as `branch`/`region` grants the next
  time that person's scoped roles are saved.
- No SQL column was added. Group branches use the existing `metadata_json`;
  users use their document. No `schemaVersion` bump was needed.

## Published

| Export / action | Permission | What |
|---|---|---|
| `organization-branches.structure` | any signed-in member (explicit empty bundle) | The structure as the viewer may see it. Works with the feature off and says so. |
| `organization-branches.branch.add` | `manage_company_settings` + `manage_all_branches`, feature | Add a branch, optionally in a region |
| `organization-branches.branch.rename` | `manage_company_settings` + the branch in manage reach, feature | Rename; only `default` may be left unnamed |
| `organization-branches.branch.archive` | `manage_company_settings` + `manage_all_branches`, feature | Archive or restore (`archived: false`) |
| `organization-branches.region.save` | `manage_company_settings` + `manage_all_branches`, feature | Add (no `id`), rename or archive a region |
| `organization-branches.branch.region.set` | `manage_company_settings` + `manage_all_branches`, feature | Put a branch in a region or none |
| `organization-branches.membership.set` | `manage_company_users` (user) or `manage_company_settings` (group, company), branch reach, feature | Set someone's branches |

The feature gate is the action policy's `capabilities: ["platform.multiple_branches"]`
(`publication_capability_denied`), and the domain functions check it again
(`multiple_branches_disabled`). Branch reach failures are `branch_scope_denied`
(403).

## UI contract for the People screens

The People UI (`public/libraries/apps/people/**`) is owned separately. This is
what the backend gives it.

### Reading the structure

```js
const result = await PlatformAPI.publication.read(orgId, {
  provider: 'organization-branches', export: 'structure',
  target: { scope: 'organization', organizationId: orgId }
});
const structure = result.value;
```

```json
{
  "feature_enabled": true,
  "multiple": true,
  "default_branch_id": "default",
  "my_branch_id": "scranton",
  "my_branch_ids": ["scranton"],
  "my_region_ids": ["region_9f2c"],
  "branches": [
    { "id": "default", "name": "", "status": "active", "is_default": true, "is_mine": false, "region_id": "",
      "counts": { "users": 3, "groups": 1, "companies": 0, "departments": 2 }, "can_manage": true },
    { "id": "scranton", "name": "Scranton", "status": "active", "is_default": false, "is_mine": true, "region_id": "region_9f2c",
      "counts": { "users": 12, "groups": 3, "companies": 2, "departments": 4 }, "can_manage": true }
  ],
  "regions": [ { "id": "region_9f2c", "label": "East", "status": "active", "branch_ids": ["erie", "scranton"], "is_mine": true } ],
  "companies_in_every_branch": 5,
  "access": {
    "see": "region", "manage": "own", "restricted": true,
    "visible_branch_ids": ["erie", "scranton"], "manageable_branch_ids": ["scranton"],
    "can_add_branch": false, "can_archive_branch": false, "can_manage_regions": false,
    "can_rename_branch_ids": ["scranton"], "can_set_membership": true
  },
  "catalog_revision": 7,
  "revision": "sha256:..."
}
```

- `branches` and `regions` hold only what the viewer may see; a region's
  `branch_ids` are only its visible branches. Archived branches and regions are
  included with `status: "archived"`.
- `counts.companies` counts companies tied to that branch;
  `companies_in_every_branch` counts the ones with no branch.
- `name: ""` is an unnamed default branch: show the terminology phrase for it
  (suggested new terminology keys: `organization.branch` / `organization.branches`,
  `organization.region` / `organization.regions`, and a default-branch phrase
  such as "Main branch"; they do not exist yet).
- Revisions: `revision` changes when anything shown changes. Region actions take
  an optional `expected_revision`, which is the `catalog_revision`.

### When things show

| Condition | Show |
|---|---|
| `feature_enabled && access.can_add_branch` (or any `can_manage` branch) | the **Branches** button on the People overview, even with one branch |
| `multiple` | the branch filter on Users, Groups, Departments and Subcontractors, branch names and regions anywhere |
| `!multiple` | nothing else about branches |

### The Branches modal

| UI action | Call | Input |
|---|---|---|
| Add branch | `organization-branches.branch.add` | `{ name, region_id? }` |
| Rename branch (incl. naming the default branch) | `organization-branches.branch.rename` | `{ branch_id, name }` |
| Archive / restore branch | `organization-branches.branch.archive` | `{ branch_id, archived?: true }` |
| Add region | `organization-branches.region.save` | `{ label }`, result has `region_id` |
| Rename / archive region | `organization-branches.region.save` | `{ id, label, status?: "archived" \| "active", expected_revision? }` |
| Put branch in region / none | `organization-branches.branch.region.set` | `{ branch_id, region_id: "" \| id, expected_revision? }` |
| Set someone's branches | `organization-branches.membership.set` | `{ assignee: "organization_user:<id>" \| { type, id }, branch_ids, primary_branch_id? }` |

Invoke with `PlatformAPI.publication.invoke(orgId, action, { scope: 'organization', organizationId: orgId }, input, { idempotencyKey })`.
Every structure action returns the new structure (the same shape as the read),
so the modal can replace its state from the result; `membership.set` returns
`{ assignee, branch_ids, primary_branch_id }`. Errors to show: `branch_name_taken`,
`region_name_taken`, `branch_name_required`, `default_branch_required`,
`branch_in_use` (`details: { users, groups, departments }` that only belong
there), `branch_scope_denied`, `branch_structure_denied`,
`multiple_branches_disabled`, `stale_branch_structure`, `unknown_region`.

### The branch filter

On Users, Groups, Departments and Subcontractors, only when `multiple`:

- Default selection **My branch**: the subtitle is the name of `my_branch_id`.
- A nested checkbox list: each region (collapsible; clicking its header selects
  all its visible branches), then its branches; branches in no region after
  them. Select all / none, **My region** (`my_region_ids`' branches), **All**.
- Every row already carries its branches, so the filter can be applied on the
  client: users `branch_ids` (workforce rows and assignee directory rows), user
  documents `data.branch_id` + `data.branch_ids`, groups `branch_ids`,
  companies `branch_ids` (empty means every branch: always matches),
  departments `branch_id`.
- Or ask the server: the users lists, the group list and the company list take
  `branch_ids=mine|region|all|<id>,<id>` (words and ids can be combined). The
  result is never wider than what the viewer may see. For groups, `branch_ids`
  replaces the route's `:branchId`; without it the route's branch is used as
  before.

### Departments in the People UI

- A department row is `{ id, label, color, icon?, branch_id, status, default_channel, app_defaults, subject_keys, role_ids, group_kind_ids }`.
  No `group_id`, no `division_id`. Section departments by branch (and region),
  not by category or unit.
- Department settings (`GET /v1/workforce/organizations/:org/departments`)
  return `{ departments, regions, terminology, revision, legacy_token, users, roles, resource_groups, group_kinds, connections, branches, effective_memberships, branch_scope, can_manage, can_assign }`;
  `users[]`, `resource_groups[]` and `connections[]` carry `branch_ids`;
  `branches[]` is `{ id, name, status, is_default }`; `branch_scope` is
  `{ multiple, my_branch_id, visible_branch_ids, manageable_branch_ids }`.
- Save (`PUT .../departments`) is `{ departments, terminology?, revision, legacy_token? }`.
  Sending `groups`, `divisions`, `group_id` or `division_id` is a 400. A new
  department without `branch_id` goes to the saver's own branch; omit
  `branch_id` on an existing one to keep it. Send only the departments you were
  shown.
- A person's scoped roles use `scope.kind` `department`, `branch` or `region`.

### Where the People UI does this

`public/libraries/apps/people/branches.js` holds the Branches modal (the
overview's Branches button) and the branch filter. The lists are read once with
`branch_ids=all` and filtered on each row's branches, so changing the filter
needs no request; the choice is remembered per page
(`fm.people.branch-filter.<page>`). Every control declares its action in
`people-data.js` `ACTIONS` (`branches.*`, `regions.edit`, `users.scoped_branch`,
`departments.branch`); the structure's `access` flags are capabilities there.

### Words

What an organization calls a branch and a region is terminology:
`branches.branch`, `branches.branches`, `branches.region`, `branches.regions`
and `branches.main_branch` (the unnamed default branch). They are the
organization's, so they are kept on the **default** branch's `variable_mappings`
and `readTerminologyMappings` gives every branch those words under its own
(`platform/localization/terminology-settings.ts`). People's Wording panel sets
them when the feature is on; with no word of its own for the default branch it
is "Main" and the organization's word for a branch. People (`data.bt`), Payroll's
branch filter and the CRM use them.

### Membership in People

A person's, group's or outside company's window has a Branches section with a
change menu (only branches the viewer manages can be ticked), and the branch
filter's dropdown can set the branches of everyone a list shows (add to, move
to, or take out of one branch), one `organization-branches.membership.set`
each.

### Calendar events

A department named on an appointment or a calendar event made by hand must
belong to the event's branch (`event.branch_id`, else the caller's):
`validateAppointmentDepartments` refuses another branch's department with
`department_other_branch`.

## Not built

Custom fields on regions keep the owner name `division`. Moving a person's
settings when their own branch changes.
