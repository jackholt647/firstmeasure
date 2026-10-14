# Organization structure: branches, regions and departments

Organization ownership remains the tenant boundary. Above departments the
organization has branches and, optionally, flat regions that group branches:
organization -> regions -> branches -> departments. The hierarchy, the branch
scope rule, the migration from organizational units and the People UI contract
are in [branches](branches.md).

`organization_departments/catalog` stores a revision-checked catalog of every
branch's departments, the organization's `regions` and department terminology.
A department has a stable id (unique across the organization), exactly one
`branch_id`, membership selectors, an optional default channel and per-app
default/restricted presentation policies. There are no department categories
and no organizational units; a catalog saved with them is migrated on read. An
empty catalog is valid and reads never create Sales/Production departments or
other records. Older per-branch scheduling catalogs are projected (each
department in the branch it was found in) and adopted on first save.

`resolveOrganizationStructure` reads the branch documents, current local
people, active resource-group memberships and connection subjects.
`buildOrganizationStructure` is its pure shared resolver. Every subject has
`branch_ids` (users and groups always at least one; an outside company with
none works in every branch) and `region_ids`. Direct users, roles, groups and
group kinds combine; a role or group type confers a department only within the
subject's branches, and group members inherit their groups' departments.
Multiple sources deduplicate effective membership while preserving
explanations. Disabled users, inactive memberships, archived groups,
departments, branches and regions do not confer membership.

Organization connections are distinct assignable subjects, not resource-group
subclasses. A department may contain an external connection without importing
that company's people or granting them access. Their explicit connection/share
contract remains authoritative.

Scheduling consumes the same effective membership and avoids counting a group
and its individual member as separate units in a mixed staffing requirement.
Projects remain cross-department; their work, documents, and departmental
responsibility can be classified independently. Equipment has optional owning
`department_id`, separate from custody and owned/leased/rented
classifications. Equipment APIs and publications authorize loaded units and
work orders; ownership transfers require authority over both old and new
scopes.

Department membership is relevance, not permission. `department-access.ts`
owns scoped role grants (department, branch or region scope) and target-aware
authorization; a branch grant covers the branch's departments and records, a
region grant its branches. Filters never enlarge permissions. Branch reach
(who sees and manages which branches) is `branch-scope.ts` and is separate
from scoped grants. The common presentation context suppresses selectors
unless there are multiple configured departments and more than one authorized
relevant option. Shared records stay available subject to existing domain
authorization.

Validation: `tests/organization-structure.test.ts`, `tests/branches.test.ts`,
`tests/department-access.test.ts`, `tests/appointment-booking.test.ts`,
`tests/departments-browser.test.mjs`, and `tests/equipment-api.test.ts` cover
inheritance, per-branch departments, migration, branch scope, appointment
pools, equipment ownership and permission boundaries.
