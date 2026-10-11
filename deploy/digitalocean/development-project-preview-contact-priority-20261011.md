# Project preview contact details — October 11, 2026

Feature commit `1f9110a9` is on `codex/consolidated-firstmeasure-20260923` and active at `https://dev.1m8.ai`. Production was not changed.

The project preview contact card now shows the selected contact's saved tag labels beneath the name, followed by phone and email, then configured contact priority fields when any have visible values. The existing `priority-fields.contact-values` publication and browser formatter resolve each field under the contact's project identity and current permissions. Unset, denied, pending and error values are omitted. The contact identity and tag labels are gated by contact visibility in the project summary publication.

## Verification

- TypeScript check and build passed. Browser tests passed for tag order, contact priority order, zero values, hidden missing/private values, contact-target identity, hover behavior and project opening.
- The publication suite passed in isolated storage: 69 passed, one PostgreSQL-only skip. An initial run against shared test storage hit an existing organization fixture collision; the isolated run passed. The focused project summary and contact priority publication tests also passed.
- All three development frontend roles have SHA-256 `a54bb08d60936d328fc5de46ce06e3b2ebea85feae0936cbf82f06c5fac492d3` for `grouped-widgets.js`, `95631b900288ecfd50c24076e094c98edbe96edb94c49db1b414c77399bdcd3c` for `runtime.js`, and `5d2f3d149a5165e37d2f42cc186ec6095908a64532a411a3de288dc7f23e7eca` for compiled `objects.js`. The public dev site serves the same frontend hashes and references `20261011-contact-preview-priority` in its manifest.
- Each role returned `ok=true`, `state=ready`, `data_environment=development` and enforced outbound isolation.

## Release state and rollback

Each role was staged as an immutable overlay on its then-current development release. A concurrent GIF-picker deployment advanced the pool role after staging; the activation guard stopped the stale overlay, and a replacement was staged from the new active release. The final release paths are:

- Web: `/opt/firstmeasure/releases-gif-overlay-1791757470/project-contact-priority-1f9110a9-fm-dev-web-598520065`
- Pool: `/opt/firstmeasure/releases-gif-overlay-1791757575/project-contact-priority-1f9110a9-r2-fm-dev-web-603124965`
- Compatibility: `/mnt/firstmeasure_dev_releases/releases/project-contact-priority-1f9110a9-firstmeasure-development-compatibility`

Before rollback, inspect each role's current symlink because subsequent deployments may have advanced it. Restore the preceding role release only when it still points to this overlay, restart its development service and PHP-FPM, and verify readiness and development isolation. The worker was not changed; project previews are served by the frontend roles.
