# Personal notification settings and document tags — development, September 29, 2026

Implementation source: `c889812111a34c55020f45b0aee46e99addfa0a0`. The shared checkout's concurrent realtime commit also captured the staged notification changes. This release uses an explicit notification/document file manifest; unrelated realtime changes are not included by this rollout.

Includes per-user notification registrations and delivery configuration, organization starting defaults, independent personal/organization permissions, removal/full administrative locks, event group declarations, document tag management and inheritance, and the dedicated Settings view with quiet hours, delivery rules and change history.

Deployment targets both development web nodes, the worker and compatibility service. Preserve each role's current baseline, merge only the committed feature delta, type-check on Linux and verify source/compiled hashes before rolling activation. Database tables are additive. No production or topology changes are authorized.

Local validation passed: TypeScript; 43 notification tests; publication suite (49 passed, one optional PostgreSQL test skipped); document tag and ownership tests; responsive browser Settings/registration checks. Final dev results and predecessors will be recorded after activation.

Evidence and explicit file manifest: ignored `output/notification-settings-release-20260929/`. Rollback restores each recorded predecessor and restarts the applicable development service, plus PHP-FPM for web/compatibility. Retain additive tables; code rollback does not undo delivered notifications or user configuration changes. Recheck intervening deployments before rollback.
