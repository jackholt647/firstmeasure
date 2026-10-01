# Cross-organization collaboration development rollout

This release implements the authenticated Partners workspace and resource-specific sharing infrastructure described in [the implementation record](../../docs/architecture/organization-collaboration-implementation.md). Activation is authorized for `dev.1m8.ai` only. Production is excluded.

## Artifact and baseline

- Backend application commit: `1e0858b281c905950e7d6476d67357d77f37e123`.
- Previous development release: `680346769fd7de2f2d77f236768a2c25fc8d3055`.
- Source comparison baseline: `2d441848e9adef32610339286eb99121f57d9ff9`.
- Task changes are committed separately from unrelated Contacts, Feedback, project-window and settings edits. Role overlays retain existing unrelated frontend changes.
- Read-only inventory found 25 backend source files lagging on worker and compatibility roles. Both web nodes matched the committed source baseline exactly for all 25. The release includes those committed dependencies on every role to restore a common executable identity for pinned published actions. No fingerprint bypass or action substitution is used.
- New SQL tables and indexes initialize through the existing SQL store migration mechanism; no existing organization ownership is rewritten.

- Frontend follow-up: `5d44c75b05495907afe6569beb17b3685a99e3a9`, with the Partners registry placeholder, capability gate, responsive controls, invitation continuation/cache correction and eager shared-list helper loading. It overlays the concurrently deployed window-shell release on web nodes without replacing that work. The measurement worker remains on `1e0858b281c905950e7d6476d67357d77f37e123` because the follow-up contains only frontend files.
- Verified common backend fingerprint on all roles: `ea6ec36f327444590add564ac441ddc102be913826fa349a3b585e2495d0cd5f`.

## Deployment safeguards

Each stage verifies the active immutable baseline, development runtime and cookie isolation, package/source hashes, disk reserve, JavaScript syntax, PHP syntax and Linux TypeScript compilation. Owned hardlinked files are detached before writing. The worker must have no active measurement jobs before activation. Each activation checks readiness and enforced development outbound isolation and rolls back its symlink if verification fails.

A failed early worker stage at `7711e6fa585252553341e6d62525433c35d38aec` exposed missing pre-existing Contacts dependencies. That stage was checksum-verified and preserved as `7711e6fa585252553341e6d62525433c35d38aec-incomplete-contacts`; it was never activated. The successful intermediate `5eefad0f7ba965da05bdde0dc680ff55584bf6e5` worker stage was also never activated. Final artifacts include the required dependencies.

## Validation

- Eight PostgreSQL collaboration integration tests pass, including revocation, field projection, identity-bound invitations, recipient audience ceilings, engagement scheduling, signature receipt flow, channel privacy/attribution and payment idempotency.
- A payment regression verifies that the processor token type must match the quoted rail before any charge claim.
- Publication tests: 49 pass, one environment-dependent test run separately against embedded PostgreSQL and passed.
- Existing scheduling and Work integration: 25 pass.
- Both browser harness tests pass, including token removal from URLs and resuming the pending invitation in Partners after login.
- Hosted API acceptance confirmed owner-approved connection, selected-field projection, denial through ordinary foreign-org endpoints and delivery of collaboration events.

## Background execution

The deployed development topology runs the collaboration maintenance loop in the compatibility API processes. Public web replicas have `PLATFORM_HEARTBEAT_DISABLED=1`; the dedicated measurement worker does not execute platform tasks. The implementation also registers three jobs in the standalone platform-worker entry point for deployments using that process. No new service or topology change was made. Hosted outbox delivery must be verified on the compatibility loop.

## Rollback

Retain each role's `previous_path` in its release receipt. Restore that symlink and restart its existing development service; reload PHP on web/compatibility roles. Recheck readiness, development environment and outbound safety. Keep the additive collaboration records for forward recovery; rollback does not delete test or user data. Do not use a production host or production runtime configuration.

## Scope limits

External operations run through explicit adapters; unadapted legacy editors, channel huddles and arbitrary document widgets remain inaccessible. Partner-local crew delegation, organization-wide standing grants, a counterpart user directory and bulk export are not implemented. Pickers still enumerate per-organization source metadata before paginating. Payment tests use the simulator and do not validate live underwriting or execute a real charge. Unknown processor outcomes and interrupted accounting require reconciliation and are never retried as new charges.


## Completed hosted acceptance

On September 30, 2026 (Pacific), both public web nodes and the compatibility role were activated and verified on `5d44c75b05495907afe6569beb17b3685a99e3a9`. The measurement worker remains verified on the backend release `1e0858b281c905950e7d6476d67357d77f37e123`. All roles retain the common backend fingerprint above. Public readiness and enforced development outbound isolation passed after each activation.

The final browser test used deployed files without response overrides and passed with zero browser errors:

- Two separate sandbox organizations: `Collaboration QA Contractor` and `Collaboration QA Partner`.
- Owner-approved organization connection and selected-field project projection; ordinary foreign-org project access is denied.
- Invitation fragment removal, automatic Partners navigation, consent and owner approval.
- Received-project list, owner label and shared detail; the private cost field is absent.
- Shared note submission through the UI.
- Shared project in the normal Projects app, filtering by the owner organization, and hide/show controls.
- Revocation removes the resource from the shared list and subsequent reads return 403.

The compatibility maintenance loop delivered all 20 collaboration outbox records generated by the hosted checks, with none pending. No real card charge or external customer message was sent. Screenshots and execution artifacts are retained locally under `output/collaboration-20260930`; role manifests and hashes for the frontend follow-up are under `output/collaboration-ui-20260930`.

The first hosted pass caught a hidden manifest placeholder; a follow-up caught the eager-app dependency path and invitation routing. These are fixed in the final artifact. Intermediate frontend releases were superseded; use the per-role receipt for precise rollback rather than assuming every role previously had the same release ID.
