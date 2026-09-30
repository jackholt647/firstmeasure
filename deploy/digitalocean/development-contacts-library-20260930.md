# Contact library, managed tags and typed relationships - September 30, 2026

Development feature commit: `42aeee2ac3080232affcfc33bad94ff9746b771e` on the canonical consolidated branch. User authorization covers dev.1m8.ai only.

Contacts support optional profile photos, managed tag IDs, required human/org classification, and contact/media custom field references. Administrators manage the available tag catalog in Settings; other contact writers select available tags. The built-in Org tag follows classification and uses the branch terminology label. Optional Employer and Spouse defaults reference org and human contacts respectively. Required, organization, target-kind, field privacy and media ownership checks run on the server.

Profile uploads and optional import photos enter the existing central media pipeline. Tiles show profile photos prominently. The contact Photos & Media tab uses the shared Feed gallery. Media fields select from this library. Photo import is off by default; a photo failure is reported separately and does not discard a successfully imported contact. Import undo preserves media artifacts. Remote photo imports require bounded public HTTPS/image validation.

The release overlays 42 owned source, compiled and frontend files plus precise bundle tokens on each audited development role baseline, `23978a0abd94997ae4999045e801dce041df0aac`. Unrelated workspace changes and deployed assets are preserved. The compatibility manifest retains its role-specific entries; its older contact-window layout and operator-only app-access checks are preserved with task-only patches. A separate clean compatibility build and browser fixture verify those variants. Source/runtime/hash guards run before staging and activation; readiness failure restores the prior pointer. No production, worker or topology changes.

Validation: clean immutable TypeScript builds for web/pool and compatibility; `npm run check`; 25 focused contact/custom-field tests; publication suite (49 passed, one PostgreSQL fixture test skipped); Contacts editor/gallery/settings/import browser tests; Contacts/Feed computed-font, action-size, padding, view-control and mobile checks. Desktop and mobile screenshots were inspected. Browser tests use the actual app code and isolated API fixtures, avoiding customer mutations. The current signed-in account does not expose Contacts, so this is not a claim of end-to-end customer-account verification.

Rollback: restore each development role current pointer to `/opt/firstmeasure/releases/23978a0abd94997ae4999045e801dce041df0aac`, restart its corresponding development service and PHP-FPM, and verify development data environment, outbound safety and readiness. Preserve later releases if a newer deployment has occurred.

See [contact architecture](../../docs/architecture/contacts.md) for storage, publication, import and media contracts.

Activated successfully on web, pool and compatibility. Eight public frontend asset hashes and six public readiness responses match the feature release with development isolation and outbound safety enforced. The editor/gallery/settings/import and Contacts/Feed view-control browser tests passed again using scripts fetched from dev.1m8.ai; hosted desktop/mobile screenshots were inspected.
