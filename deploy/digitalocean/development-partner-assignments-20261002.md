# Partner assignments — October 2, 2026

Source release: `8f3bc4926da1c24c709d917b350ec85828eb6cba` (feature commit `e03fa5ccdededa9ec98093a400dc819d4ea7e6f6`). Development only.

## Configuration and behavior

Resource-group kinds now have an optional `external_assignment` boolean, defaulting off. Workforce Settings → Types, tags & terminology exposes the toggle and a Manage partners entry point for each kind. Partners → Assignments edits the same relationship mappings. Selecting a disabled type during partner setup enables that type without adding any other partners. Connection acceptance/approval offers an assignment setup step.

Directional `assignment_settings` records store the local kind mapping separately from the owner's exposure choices. Assignment settings are bound to the connection revision: suspension, ending or reconnection invalidates previous mappings and team exposure until explicitly configured again. The partner defaults to exposing only its whole organization. It may expose selected types and individual groups, or explicitly include all current and future groups of those types. Team names are visible for exposed groups; headcount and member names are separate opt-ins. Organization privacy can still suppress member names. Email, phones, pay profiles, arbitrary attributes and documents never enter this projection. Certifications and documents use explicit existing sharing grants.

The assignable catalog intersects active connections, current organization privacy/capabilities, active local kinds with external assignment enabled, relationship mappings, and current source-team exposure. External teams remain organization-connection subjects with deterministic tenant-qualified IDs and source references; they do not become local resource-group memberships. The receiving company's type mapping qualifies them for group-kind assignment rules. When a policy names group kinds, unrelated external mappings are excluded even if a legacy broad connection rule is present. Existing unlinked legacy organization connections retain their earlier assignment behavior.

Accepted partner engagements can select the whole organization or an exposed team when scheduling. Options use the project's branch. The partner remains the contractual counterparty. Existing event validation rejects newly ineligible assignments; moving an external booking also revalidates its assignee. Historical records remain intact. Sharing and project access remain governed by the existing engagement grants, independently of assignment eligibility.

Exposure discovery uses a minimal workforce query rather than hydrating compensation or contact records. Settings writes enforce current membership, connection-management and company-settings permissions, revisions, active connection, valid kinds/groups and partner exposure. No new SQL table or destructive migration is required; assignment settings use the existing collaboration record store.

## Validation

- Collaboration/workforce SQLite integration: 18 tests passed.
- Collaboration PostgreSQL integration: all 9 passed, including team assignment, private fields, kind enablement, unexposed type rejection, organization isolation, stale revisions, privacy narrowing, withdrawal and rejection of rescheduling a withdrawn team.
- Browser tests: assignment setup and scheduling payload, desktop/mobile sizing, existing Partners sharing and invitation continuation passed. Screenshots inspected.
- Publication suite: 49 passed, one separate PostgreSQL publication test skipped by its environment gate.
- Local TypeScript check and all four per-role Linux TypeScript/syntax/source checks passed. All roles produced backend digest `1db63aa7d38e5f15607f2bb8ffd491282995f1ce2c513060e038480f7b31a549`.
- All 11 existing scheduling event-write regressions passed.

## Scope and operations

This extends assignment configuration and existing project-event scheduling. It does not add cross-company calendar conflict coordination, partner-internal delegation, payroll processing for foreign crew members, or generic foreign-assignee fields on every Work node. Sales/Production presentation remains as before. The existing document sharing system supplies explicit certification/document access.

Ignored release artifacts, role baselines, hashes and rollback paths are in `output/partner-assignments-20261002`. The final package overlays each role's current immutable source; unrelated staged and working files are excluded. Production and infrastructure topology are unchanged.

A concurrent frontend deployment was detected by the baseline guard before main-web activation. The web package was rebuilt over release `4ae69418523989bc8f25c1d2fcb9ef184a85575c` and rechecked. The pool initially served the correct source directory with a stale process release label; inventory verified its actual working directory and readiness identity separately. Normal activation replaces the process and verifies the new label.

Activation verified on development web, worker, compatibility and pool: release `8f3bc4926da1c24c709d917b350ec85828eb6cba`. Per-role source hashes, process release identity, readiness and development outbound isolation passed.

Hosted two-organization verification passed with no browser errors: the real assignment form enabled Crew assignment, the partner organization and its exposed crew appeared in the assignable catalog, the foreign projection omitted roster details, and withdrawing exposure removed the team immediately. Desktop screenshots and a fresh 390px mobile session were visually inspected; the mobile form measured x=14, width=362 with no horizontal page overflow. Sandbox settings were restored and only the newly created QA crew was archived. No external email or real payment was sent.

Rollback: use each role's recorded `previous_path` in the manifest, restore its current symlink, restart that development service and reload PHP on web roles. Verify readiness, release identity, source hashes and outbound isolation. The additive assignment settings records may remain inert when rolling back; no destructive data migration is needed.
