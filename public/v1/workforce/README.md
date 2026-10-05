# Workforce domain

The workforce domain extends organization users; it does not create a second
identity system. A person who can belong to an internal work group is always a
document in the platform `users` collection.

## Domain model

- `application_access` is independent from organization permissions. The
  canonical application IDs are `management` and `field`; each entry can carry
  its own role and permission map.
- `access_role_ids` assigns reusable organization roles. Organizations may
  rename the seeded roles or add their own without changing stable role IDs.
- `permission_overrides` grants or denies an individual data/action permission
  after role defaults are combined.
- `app_access_overrides` uses `show`, `hide`, or `inherit` per app. App
  relevance is intentionally separate from permission grants.
- `resource_groups` group existing organization users. Each group has a
  data-defined `kind_id`, assignment tags, memberships, scope capabilities,
  and an optional fallback compensation profile. `crew` is the seeded default
  kind, not a separate storage type.
- `organization_connections` represent persistent organizations outside the
  tenant. “Subcontractor” is the default terminology, not the storage or API
  type. A connection can later link to another FirstMate organization.
- `compensation_profiles` are polymorphic records whose subject is an
  `organization_user`, `resource_group`, or `organization_connection`.
- Scope capabilities reference versioned scope-template IDs. Availability
  flags control whether a scope is offered for new work without invalidating
  existing capability or historical version references.

Direct user compensation takes precedence over resource-group compensation.
Organization connections may use hourly and piece-rate components, but not
salary components.

## Access and Crew facade

`access.ts` resolves application access, permissions, app visibility,
parameters, device eligibility, and layout into one access profile. Existing
users without explicit role assignments retain management access; Crew access
remains opt-in. Seeded field roles are Crew Member, Repairman (a solo
technician, `metadata.field_mode: "solo"`), Crew Foreman, and Supervisor,
alongside the four management roles. Crew roles are production-focused by
default: read-only change orders, no customer payments (the foreman only adds
checklist management). The Supervisor role closes jobs out -- it holds
`crew.checklists.supervise` (supervisor-audience quality checklists with
good/neutral/bad ratings), payments, change-order management, and
`crew.projects.view_all_production`, which scopes their Crew app to every
project with scheduled work (their Today tab shows anything being worked on by
anybody that day) instead of only assigned work. All of this is per-role
permission data, so companies can build their own foreman/supervisor/repairman
variants from the access matrix.

The time clock is compensation-derived, not role-derived: the
`time_clock_enabled` entitlement param and the time-clock endpoints require an
hourly component on the worker's compensation profile (falling back to their
active resource group's profile), so salaried and pure piece-rate workers never
see or use the clock (`hasHourlyCompensation` in `access.ts`).

Project checklists live in `crew_checklists`/`crew_checklist_items` with
per-checklist `audience` and `crew_editable` flags; the management project
modal exposes all of them through the Checklists tab.

The access catalog covers every injectable management and Crew portal/project
tab. Management entries use `default_enabled: true` so missing role defaults
preserve the existing portal experience; Crew entries default off. A role can
store an explicit disabled default, and a user's `show`/`hide` override is
applied after the catalog and role layers. Modal shells, left-region helpers,
and service apps are not tab entitlements.

Administration endpoints live at
`/v1/workforce/organizations/:orgId/access`. Assigned Crew operations live at
`/v1/workforce/organizations/:orgId/crew`. Every project-specific Crew route
revalidates that the current user or one of their active resource groups is
assigned through a schedule event before returning or mutating project data.

## Assignment contract

Anything that can receive work is an assignable subject. The canonical subject
types are `organization_user`, `resource_group`, and
`organization_connection`. Users keep the normal `assigned_user_ids` shape;
groups and external organizations use a typed reference rather than an
ambiguous crew ID:

```json
{
  "work_resource_ref": {
    "kind": "resource_group",
    "id": "resource_group_123",
    "name": "North Crew"
  }
}
```

Resource-group kinds and assignment tags are organization configuration data.
Tags can be attached independently to users and resource groups. A `drywall`
tag can therefore qualify either a drywall-capable person or group without
turning drywall into a new identity or permission role.

Assignment policies contain alternative rules. Rules are ORed together, while
the constraints inside one rule are ANDed. A rule can filter on:

- subject type and exact subject ID;
- user access-role ID;
- resource-group kind ID;
- generic kind ID;
- required assignment tags (`all` or `any`);
- scope capability IDs.

Event types store their own `assignment_policy`, so appointment types remain
data-driven. The same policy contract is also available on Work nodes. The
workforce resolve endpoint previews eligible subjects, and event/Work writes
enforce the policy on the server rather than trusting a dropdown filter.

Legacy crew and singular-user fields remain compatibility projections. New
code should make assignment decisions from the typed subject and policy.

## Invariants

- A resource-group membership must reference an active user in the same
  organization.
- Compensation is optional for any organization user.
- Optimistically updated configuration, groups, connections, and compensation
  profiles use revision checks.
- Resource groups and organization connections are archived rather than
  deleted so historical assignments remain resolvable.
- Code uses neutral domain names. Tenant-facing labels come from workforce
  terminology, whose defaults are Crew, Crew Member, and Subcontractor.


## Partner assignment configuration — October 2, 2026

Group kinds may opt into `external_assignment`. Each connected pair has directional
assignment settings in the collaboration domain: local kind mappings and a separate
exposure policy for the organization's own groups. Setup may enable a selected kind,
but it does not enroll other partners. Whole-organization assignment is the default
partner offering; individual teams require explicit type/group exposure. Current and
future groups, headcount, and member names each have separate choices. Organization
privacy remains a ceiling; pay profiles, phones and arbitrary group attributes never
enter the foreign projection.

External teams are catalog projections with deterministic organization-qualified IDs,
not local resource-group records. They retain `organization_connection` subject type
and carry `external_target` and `mapped_group_kind_ids`. Local group-kind rules accept
only mapped external kinds. If a policy identifies group kinds, unrelated external
mappings cannot bypass them via a legacy broad organization-connection rule.

The catalog rechecks connection state, privacy and current exposure. Settings bind to
the connection revision; a suspended/reconnected relationship requires renewed setup.
New project-event assignments and moves of existing external bookings revalidate
eligibility. Historical assignments remain retained. Accepted engagements can select
an eligible organization or team without changing the contractual counterparty.

This does not expose foreign group membership as local membership, grant project
access, coordinate calendars across companies, or add external subjects to every Work
node assignment field. Those are separate contracts. See the
[development release record](../../../deploy/digitalocean/development-partner-assignments-20261002.md).


## Organization departments

Settings → Users → Departments owns one organization catalog, stored as the internal
`organization_departments/catalog` document with revision checks. It is not
available through the generic document API. Department membership is additive:
`role_ids` supplies defaults for user roles, `group_kind_ids` supplies defaults
for generic resource-group types, and `subject_keys` adds individual users or
groups. Multiple departments are supported. Group membership does not grant
permissions or automatically turn each group member into an individually
assignable department member; group roster requirements still reserve members
through the existing scheduler.

The department editor exposes all four assignment lists. Users, Roles & access,
individual group cards, and the group-type settings expose the reverse view of
the same records. Inherited membership is identified separately from direct
checkbox assignments. Existing user/role/group Save controls also persist their
department selections. Department saves are independent revision-checked writes;
they are not a transaction with the rest of a user or group profile.

Company-settings administrators manage departments and group/type membership.
User administrators can change direct user assignments; permission administrators
can change role defaults. Department membership never changes permission grants.
Scheduling readers receive the catalog without the administrative user directory.

Before the first explicit save, a read-only projection combines existing branch
catalogs. Stable department IDs are retained; memberships and type rules with the
same ID are unioned. Default-branch labels/colors/categories take priority,
followed by branch IDs in sorted order. Saved empty catalogs remain empty. With
no legacy catalog, Sales and Production are seeded in the projection only.
The first write checks a fingerprint of the branch revisions and creates the
organization catalog atomically. Branch snapshots, presets and saved appointment
IDs remain intact. Existing department IDs cannot be removed by this API.

The booking widget manages presets and links to department settings. Both booking
and calendar filters read organization departments. Legacy catalog saves reject
attempts to change departments; branch scheduling configuration is not a second
authority after adoption. The generic resource-group resolver remains the engine
for every group type; `crew_member_percent` is retained as a compatibility field
name, while the UI labels it “Group members required”.

API: `GET/PUT /v1/workforce/organizations/:orgId/departments` and
`PATCH /v1/workforce/organizations/:orgId/departments/assignments`.
Published data: `workforce-departments.catalog`. Typed actions:
`workforce.departments.read`, `.save`, and `.assign`. All reuse the domain
permission checks and optimistic revisions.
