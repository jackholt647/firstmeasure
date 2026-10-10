# Project preview priority fields — October 10, 2026

Feature commits `39862609` and `843ecba8` are on `codex/consolidated-firstmeasure-20260923` and active at `https://dev.1m8.ai`. Production was not changed.

The project preview now reads the shared `priority-fields.values` result through `FirstMatePriorityFields.resolve`. It renders the configured fields in their saved order, using the shared formatter, when they have a ready value. Missing, empty, pending, denied and error entries are omitted; zero remains a value. The preview no longer chooses Stage, Job/Project type or Deal value itself. It omits the entire cover area when there is no cover media or the image cannot load. The contact card and Open project action remain.

## Verification

- TypeScript check passed; six nearby browser tests and four priority-field backend tests passed.
- The browser fixture covers an arbitrary future priority field, configured order, zero, hidden unset and denied fields, a real cover, and a project without a cover.
- All three active development roles have SHA-256 `64a246510c625307263d7e0057866f877e788c204c2c4a6d2826bb7ae58ac6bc` for `grouped-widgets.js` and `6eaa0e6d1e8aa7af25c1b1079008f382bd5c50094eba8c8139b50998bf6dde2f` for `runtime.js`. Their manifest points the runtime bundle to `20261010-project-priority-preview`, preserving each role's other manifest changes.
- Each role returned `ok=true`, `state=ready`, `data_environment=development` and enforced outbound isolation. The public dev site served both updated widget assets with the same SHA-256 hashes.

## Release state and rollback

The frontend files were staged as immutable overlays on each role's then-current development release. A concurrent rollout subsequently moved both web roles to `b503165858815d7f6e47417891c815d85c39eb0a`, retaining the preview assets. The compatibility role was active at `/opt/firstmeasure/releases/project-priority-preview-39862609-r2-firstmeasure-development-compatibility` during verification. The worker was not changed.

Before any rollback, inspect the role's current symlink because later deployments may have advanced it. Restore that role's preceding release only when it still points to this preview overlay, restart its development service and PHP-FPM, then verify readiness and the development isolation checks. Preserve release directories.
