# Global appointment booking — October 2, 2026

Development release: backend `9bb3be78f67c1a702fa083392d73093cbca99fd9`; final frontend `54a626f768e4579b7deb2066e8e5c1321a3f638a`. Feature commit: `fdc0550be1dbe8c694ec58b0b8d71325ded681ea`.

## Behavior

Scheduling has a red **+ Appointment** button at the far left of its toolbar. It opens the global booking dialog for an existing project or lead. The public form embed and staff dialog share the availability calendar and time-slot component; the public form retains its contact fields and public security boundary. The assistant can open the same dialog through `open_scheduling_widget`; opening does not book an appointment.

Staff bookings use the authenticated, CSRF-protected appointment endpoint and the typed `scheduling.appointment.book` publication. Organization, branch, permission, capability and current availability checks run on the server. Stable event IDs make retries idempotent. Existing slot holds and domain event saving supply resource assignment and duration. This reuses existing concurrency guarantees; it does not introduce distributed locking.

The final frontend correction loads the booking bundle directly when Scheduling is entered through the legacy portal loader, which does not use the app manifest.

## Verification

- TypeScript checks passed locally and on each staged Linux role.
- Publication suite: 50 passed, one environment-gated PostgreSQL test skipped.
- Appointment integration tests passed for authentication, CSRF, strict schemas, booking, idempotent retry, stale availability, branch access and revoked capability. Three appointment reschedule tests passed.
- Assistant widget-opening integration test and 97 assistant frontend tests passed.
- Two browser tests passed: direct entry without the manifest, stale availability responses, duplicate submission prevention, focus restoration, public embed styling and responsive sizing.
- Broader scheduling suite: 62 passed and 14 failed; the same 14 failures were reproduced against the pre-change HEAD source. Broader assistant suite: 20 passed and two unrelated notification failures remained.
- Hosted verification passed for the red far-left action, shared dialog, real project loading and availability, mobile bounds, global reopening and authenticated schema rejection. Desktop/mobile screenshots were inspected. No browser errors or appointment creations occurred during hosted verification.
- Public readiness, role release identity, source hashes and development outbound isolation passed. Seven public frontend asset hashes matched the release manifests.

## Rollout and rollback

Backend release `9bb3be78` activated on development web, worker, compatibility and pool. Frontend correction `54a626f7` then activated on web, compatibility and pool; worker remains on `9bb3be78` because the correction has no backend changes. Each immutable package preserved its role's existing source baseline and excluded unrelated workspace changes. Production, topology and runtime configuration were not changed.

Evidence, manifests, hashes, per-role previous paths and scripts are in ignored directories `output/appointment-booking-20261002` and `output/appointment-booking-loader-20261002`.

Immediate frontend rollback targets `9bb3be78`, which reintroduces the direct-loader issue. For a full feature rollback, use the initial manifest's `previous_path`: web/pool `d6715469f8a24bf642d1de2b89c1d806b5c24485`, worker `a1d965d72131e26744b0fa918767fad01364441f`, compatibility `3eec6a5f7a2f8a3e09669b3dbb8646fe79e07b5c`. Restore each development current symlink, restart its service, reload PHP on frontend roles and verify readiness, identity and outbound isolation. No destructive migration is required.
