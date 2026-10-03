# Searchable project selection and standalone appointments — October 3, 2026

Source release: `96267164e4b7479808082365fdc5f2b420109562`. Development only.

## Behavior

The global booking dialog immediately loads availability without requiring a project. Staff can leave the optional project field empty and book a standalone calendar event, then link a project using the existing calendar event editor. No placeholder project or lead is created. Standalone bookings require schedule-management permission, retain stable IDs for safe retries, and use the same slot holds, resource assignment and calendar domain writer. Availability now counts standalone calendar events as well as project events so a booked slot is not offered again.

The reusable `FirstMateProjectSelector` replaces the native dropdown. It offers debounced server search, at most 12 results, recent project choices, keyboard selection, clear/no-project selection and protection against stale search responses. Six recently selected IDs are stored in the current user's organization-scoped browser session; labels are loaded through the authenticated API. It uses the existing server search instead of downloading the project collection. Other forms can mount the same component.

The typed `scheduling.appointment.book` publication accepts organization targets for standalone appointments and retains project targets for linked appointments. Public customer contact forms keep their existing behavior.

## Validation

- TypeScript check passed.
- Publication suite: 50 passed, one environment-gated PostgreSQL test skipped.
- Three browser tests passed, covering direct Scheduling entry, standalone submission, stale availability/search responses, remote search, recent choices, keyboard selection, focus restoration, public embed styling and responsive layout.
- Authenticated appointment integration passed: existing authority/schema/branch checks, standalone persistence, idempotent retry, occupied-slot rejection and later project linking without changing the appointment time.

## Deployment

All four development roles passed staged source hashes, JavaScript syntax, TypeScript transpilation parity and Linux TypeScript checks. Web/pool backend digest: `dc76c0563341deb6889bdc11aaf15ed7217d3226636cef90e7ab67a366597ccc`; worker/compatibility: `db738f0016ee559af3613e482ffed4187adabb5b4f94fb65ef0ec5092ec368f9`. The differing digests retain each role's existing source baseline.

Per-role source snapshots, manifests, package hashes and verification evidence are retained in ignored `output/appointment-booking-followup-20261003`. Packages preserve existing deployed source and exclude unrelated workspace changes. No dependency, migration, runtime configuration or topology changes are required.

Activation and post-activation verification passed on web, worker, compatibility and pool. Public readiness confirmed development identity and enforced outbound isolation. Both public JavaScript assets matched their package hashes. Hosted browser verification passed for server search, recent selection, booking without a project, persisted calendar data, later project linking and mobile bounds, with no browser errors. Desktop/mobile screenshots were inspected. One temporary appointment was created in an existing development sandbox account, linked to a sandbox project, then deleted successfully. Production was not changed.

Rollback uses each role's `previous_path` from the manifest: web and pool `54a626f768e4579b7deb2066e8e5c1321a3f638a`, worker `9bb3be78f67c1a702fa083392d73093cbca99fd9`, compatibility `/opt/firstmeasure/releases-root-archive/54a626f768e4579b7deb2066e8e5c1321a3f638a`. Restore the development current symlink, restart the relevant service, reload PHP on frontend roles and verify readiness, release identity and outbound isolation. Stored standalone events remain ordinary editable calendar events after rollback; the earlier availability implementation does not account for them.
