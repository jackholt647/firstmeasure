# Operations scope and proposal setup — October 27, 2026

Verified runtime: `1b28c1df` (implementation `e64f840c`) on branch `codex/app-offers-20261027`.

Operations now starts with the shared document workflow: quick internal scope without preview/payment/signature, or proposal with preview/payment terms and normal send/present controls. Roofing, gutters and siding can be combined. The saved planning snapshot publishes real materials/work requirements; later customer acceptance replaces that planning artifact instead of duplicating it. Siding starts with explicitly unpriced products, and proposals require price review.

The completion checklist offers suppliers (5 min), Equipment (3 min), workforce (5 min), and proposals (10 min). Optional guided steps return to the checklist; Generate resumes materials generation before its tour. Equipment is offered in global navigation with New and stays operationally disabled until activation. New Labor defaults wait for setup evidence; existing work/settings remain visible. Legacy manufacturer setup remains manual/history only.

## Validation

- TypeScript check passed.
- Publication suite: 87 passed, one PostgreSQL-only test skipped.
- Materials/requirements integration: 16 passed, including quick scope, proposal planning, actual material generation, signing replacement, and replay without duplicates.
- Operations onboarding: 4 passed including permissions before mutation, real workforce save, and initial Labor visibility.
- Browser guide regressions: 24 passed, including 7 Operations cases; desktop and 360px screenshots reviewed.
- Guide tests passed after updating generation-before-tutorial assertion; document fixture tests accept the offered Documents app normally.

## Rollout

Activated and verified `1b28c1df88c6ec6f19a4c9ae7855e5f6c3e7190e` on worker, compatibility and web. All roles passed Linux TypeScript, immutable payload hashes, development isolation, outbound-safety and readiness checks. The live authenticated guide API returns the three Operations widgets, and the released browser assets return HTTP 200 without a live-layer override. Shared project-access regression tests passed 8/8. Payload is built against each dev host's live `a487ec88` source, preserving role-specific drift. Worker permission-bundle conflict resolved by inserting only the ten new Operations actions into the live permission map; existing role differences retained. The first staging pass found an unavailable photo-specific import on the worker. Project access was extracted into a shared module; web/legacy photo code re-exports the same helper while the worker receives only the shared module. No production activation.

## Source handoff

Canonical checkout contains extensive unrelated staged and unstaged work. This task preserves it and keeps the implementation in the committed task branch; do not overwrite canonical with this checkout. Runtime payload inventory and verified hashes are retained in ignored `output/operations-setup-20261027`.
