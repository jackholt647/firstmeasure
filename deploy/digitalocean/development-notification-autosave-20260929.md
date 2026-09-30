# Notification autosave and compact controls — September 29, 2026

Source and development release: `c999122561ad9f6980e05fe102bd3b5905d9cbe9`.

Quiet Hours now autosaves, uses a time-zone selector and compact delivery toggles. Advanced notification controls contain delivery toggles, a trash icon and autosaving organization protection segments. Plain-English delivery rules remain visible below their notification. Toolbar sizing, Settings visibility, gear and Advanced tooltip positioning are corrected. The shared date/time picker inherits the application font, uses an always-visible custom time tile and avoids covering its trigger where viewport space permits.

Organization administrators can reset defaults for future users through a permission-checked, revision-checked endpoint. Reset stores a versioned system-default marker and audit entry; existing personal settings and organization locks are unchanged. No database schema migration, production activation or topology changes.

The task delta was isolated with a temporary Git index. Each role's immutable release preserves its own active source baseline. Updated files and release metadata are replaced atomically after hard-link staging. The older deployed notification UI fixture was replaced with the committed current regression suite; runtime sources required no conflict resolution.

## Validation

- All four staged Linux releases passed full TypeScript checks, JavaScript syntax checks and compiled-output comparisons.
- All 12 defaults and ownership tests passed, including reset permissions, stale revisions, existing personal settings and locks.
- Development PostgreSQL checks passed against temporary tables inside a rolled-back transaction, including reset and stale-revision rejection; no organization settings were changed.
- Hosted-source notification browser tests passed, including autosave, timezone selection, visible rule summaries, protection controls, deletion, compact tooltips and responsive layout.
- All 14 hosted-source picker check groups passed, including inline custom time, typography, placement, keyboard, constraints, seconds, mobile and application registration. Browser scenarios used API fixtures.
- All four roles activated successfully and passed source hashes, runtime identity, readiness and enforced development isolation. All four public asset hashes and six public readiness responses passed; notification failure scans returned zero on every role.
- Public traffic remained on the old second web node during the first restart. Sequential activation used direct per-role identity/readiness checks plus public safety checks allowing either known rollout version; final public checks required the new release.

## Role baselines and rollback

- web: predecessor `e5c26c451797e6a2dab28256ad70173c9d7a1701`.
- worker: predecessor `ef95bf16e2668e7eb2128230a74e404311ba8691`.
- legacy: predecessor `e5c26c451797e6a2dab28256ad70173c9d7a1701`.
- pool: predecessor `e5c26c451797e6a2dab28256ad70173c9d7a1701`.

Before rollback, inspect for intervening deployments. Restore the corresponding predecessor symlink and restart only that development role (plus PHP-FPM for web/compatibility), then verify release identity, readiness and enforced development isolation. If newer work has since deployed, prepare an inverse task delta on its baseline instead. The reset marker is additive JSON and requires no schema rollback. Evidence and per-role manifests are in ignored `output/notification-autosave-20260929/`. Existing replacement-image limitations remain.
