# Organizational units and departments

Organization ownership remains the tenant boundary. `organization_departments/catalog`
stores a revision-checked department catalog and an arbitrary-depth `divisions` tree.
Each unit has a configurable kind label, parent, optional existing branch affiliation,
active/archive status, and direct subject affiliations. Cycles, missing parents,
cross-organization subjects, and removal of historical IDs are rejected. Archive
children and their departments before archiving a parent. Resource groups remain flat.

Departments have stable IDs, optional unit placement, membership selectors, an optional
default channel, and per-app default/restricted presentation policies. Department
terminology supports organization-specific singular/plural labels. An empty catalog
is valid and reads never create Sales/Production departments or other records.
Existing explicitly configured scheduling catalogs can be adopted on first save.

`resolveOrganizationStructure` reads current local people, active resource-group
memberships, and connection subjects. `buildOrganizationStructure` is its pure shared
resolver. Direct users, roles, groups, and group kinds combine; group members inherit
departments and unit affiliations with provenance. Multiple sources deduplicate effective
membership while preserving explanations. Disabled users, inactive memberships, and
archived groups/departments do not confer membership. Division ancestors include self.

Organization connections are distinct assignable subjects, not resource-group subclasses.
A department may contain an external connection without importing that company's people
or granting them access. Their explicit connection/share contract remains authoritative.

Scheduling consumes the same effective membership and avoids counting a group and its
individual member as separate units in a mixed staffing requirement. Projects remain
cross-department; their work, documents, and departmental responsibility can be classified
independently. Equipment has optional owning `department_id`, separate from custody and
owned/leased/rented classifications. Equipment APIs and publications authorize loaded
units and work orders; ownership transfers require authority over both old and new scopes.

Department membership is relevance, not permission. `department-access.ts` owns scoped
role grants and target-aware authorization. Filters never enlarge permissions. The common
presentation context suppresses selectors unless there are multiple configured departments
and more than one authorized relevant option. Shared records stay available subject to
existing domain authorization. Catalog editing remains organization administration.

Validation: `tests/organization-structure.test.ts`, `tests/department-access.test.ts`,
`tests/appointment-booking.test.ts`, `tests/departments-browser.test.mjs`, and
`tests/equipment-api.test.ts` cover inheritance, history, invalid trees, appointment pools,
unit editing at mobile widths, equipment ownership and permission boundaries.
