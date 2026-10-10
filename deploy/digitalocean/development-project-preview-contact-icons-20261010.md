# Project preview contact card — October 10, 2026

Feature commit `5069afe0` is on `codex/consolidated-firstmeasure-20260923` and active at `https://dev.1m8.ai`. Production was not changed.

The project summary publication now includes `project_contact_count`, based on the normalized project contacts. It returns zero when contact access is denied. The preview shows “Primary contact” only when that count exceeds one. Call, Text and Email are compact icon links at the top right of the contact card, with accessible labels and the existing `tel:`, `sms:` and `mailto:` destinations.

## Verification

- TypeScript check and build passed. The focused browser tests passed for one and multiple contacts, icon actions, hover behavior, priority fields, optional cover and opening the project. The publication suite passed: 69 tests, one skipped.
- The staged widget and backend files on all three development roles match these SHA-256 values: `grouped-widgets.js` `624bb60d02742ce2c836565e4b2b26f5032ddcfe29ee1a1030a1ff2f389392f2`, `runtime.js` `ae6dd9b9b32066157bb96ce414bb0df57e732c83c19a389975921167b0b35ec3`, compiled `objects.js` `50ef53b53cd983aaa1c42851807729130a3482a2b181afb7cced0f14b1bda9e2`.
- Each role returned `ok=true`, `state=ready`, `data_environment=development` and enforced outbound isolation. The public dev URL serves the updated widget hashes and the manifest references `20261010-project-contact-icons`.

## Release state and rollback

Each role was staged as an immutable overlay on its then-current development release. The first web activation briefly returned 502 while starting; its guarded rollback restored the preceding release. A readiness retry was added, and the second activation succeeded. A concurrent deployment advanced the compatibility role after staging; its activation guard stopped the stale overlay, which was rebuilt from the new baseline and activated successfully.

Current release paths at verification:

- Web: `/opt/firstmeasure/releases/project-contact-icons-5069afe0-fm-dev-web-598520065`
- Pool: `/opt/firstmeasure/releases/project-contact-icons-5069afe0-fm-dev-web-603124965`
- Compatibility: `/mnt/firstmeasure_dev_releases/releases/project-contact-icons-5069afe0-r2-firstmeasure-development-compatibility`

Before rollback, inspect the role’s current symlink because later deployments may advance it. If it still points to this overlay, restore that role’s preceding release, restart its development service and PHP-FPM, and verify readiness and development isolation. The worker was not changed.
