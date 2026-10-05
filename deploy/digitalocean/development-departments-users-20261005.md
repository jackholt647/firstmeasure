# Organization departments in Users — October 5, 2026

Departments now live in Settings → Users → Departments, with direct Settings search routing for department names and keywords. Both the full platform and legacy Users shells expose the sub-tab. Scheduling Settings links to the same editor.

The organization catalog supports creating departments, role defaults, generic user-group-type defaults, and multiple direct assignments for individual users and groups. Crews use the generic group-kind relationship. Existing branch department catalogs are projected without writes until an explicit revision-protected save adopts the organization catalog; branch records, existing identifiers and appointment presets are retained. Scheduling reads consume the organization catalog. Domain APIs, typed publication providers/actions and permissions use the same service and schemas.

Source release: `d673dbeaaade035ff9812e8c55f4b1a59ec0bd83`. All work from this department task is included. Unrelated concurrent checkout edits are excluded. No production, topology, environment or schema migration changes.

Validation: TypeScript check; 13 workforce/appointment tests; 50 publication tests (one PostgreSQL-only test skipped without local test database); six browser tests for editing, scheduling cache invalidation, both Users routing modes, search dropdown and user menus. Linux stage checks validate compiled output and TypeScript for each role.

Deployment evidence and previous per-role absolute paths: `output/departments-users-20261005/manifest.json`. Rollback restores each recorded symlink and development service, reloads PHP-FPM on frontend hosts and verifies readiness/isolation. Once organization department edits exist, rollback must retain this catalog integration to avoid making subsequent department changes invisible to older scheduling code.

All four development roles activated and verified release `d673dbeaaade035ff9812e8c55f4b1a59ec0bd83`, exact source/runtime hashes, readiness and development isolation. Public readiness passed.

A disposable Instant Full Org on dev.1m8.ai verified Settings search → Users → Departments, creation through the real form, role and generic group-type defaults, multiple direct user department assignments, reload persistence and the same catalog in scheduling. No browser runtime errors. The temporary organization was deleted afterward. Hosted evidence: `output/departments-users-20261005/hosted-verification.json` and desktop screenshot. The mobile viewport had no document overflow; its screenshot includes the open navigation drawer, so it is not a full visual certification of the mobile editor.
