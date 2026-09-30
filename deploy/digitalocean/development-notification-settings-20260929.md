# Personal notification settings and document tags — development, September 29, 2026

Implementation source: `c889812111a34c55020f45b0aee46e99addfa0a0`. The shared checkout's concurrent realtime commit also captured the staged notification changes. This release uses an explicit notification/document file manifest; unrelated realtime changes are not included by this rollout.

Includes per-user notification registrations and delivery configuration, organization starting defaults, independent personal/organization permissions, removal/full administrative locks, event group declarations, document tag management and inheritance, and the dedicated Settings view with quiet hours, delivery rules and change history.

Deployment targets both development web nodes, the worker and compatibility service. Preserve each role's current baseline, merge only the committed feature delta, type-check on Linux and verify source/compiled hashes before rolling activation. Database tables are additive. No production or topology changes are authorized.

Local validation passed: TypeScript; 43 notification tests; publication suite (49 passed, one optional PostgreSQL test skipped); document tag and ownership tests; responsive browser Settings/registration checks. Final development verification is recorded below.

Evidence and explicit file manifest: ignored `output/notification-settings-release-20260929/`. Rollback restores each recorded predecessor and restarts the applicable development service, plus PHP-FPM for web/compatibility. Retain additive tables; code rollback does not undo delivered notifications or user configuration changes. Recheck intervening deployments before rollback.

## Verified activation

Active release: `490f326db6b303ab37d35dd1a7658aef4256fea3` on both web nodes, worker and compatibility. The release includes PostgreSQL schema version 2 so existing installations create the new configuration, organization-default, lock, history and deletion-tombstone tables. The preactivation PostgreSQL test caught and corrected the missing version bump. Updated event-contract test fixtures are included in the deployment manifest.

All four roles passed Linux TypeScript, JavaScript syntax, source/compiled hash checks, runtime release identity, readiness and enforced development outbound isolation. PostgreSQL schema upgrade, per-user configuration reads, organization policy row locks and exclusive delivery claims passed using temporary tables and rolled-back fixtures. No user settings or notification sends were used as test fixtures.

Seven public frontend assets matched the release hashes; six public readiness responses matched the release. The browser test loaded the hosted Settings source and registration module with mocked API data and passed registration/retry, tag/workflow selection, grouping, delivery controls, custom deletion, administrator locks/defaults, Settings/history and responsive layout. This browser check does not claim an authenticated real-organization end-to-end test. Four notification endpoints rejected unauthenticated requests with HTTP 401.

Recent logs contained zero notification-lane errors across all four roles.

No production or topology changes were made. Existing replacement-image limitations remain; this was a rollout to the current development fleet.

### Recorded predecessors

- web: `c889812111a34c55020f45b0aee46e99addfa0a0`
- worker: `e515f117a35fe9f6201f0df60f0db419c0638d4a`
- legacy: `9cfc7fc78d0c55bd83d6a4b0e70c9ed554d88906`
- pool: `c889812111a34c55020f45b0aee46e99addfa0a0`
