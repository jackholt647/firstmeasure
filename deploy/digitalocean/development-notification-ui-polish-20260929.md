# Notification UI refinements — September 29, 2026

Source release: `e50bb4f9bd8f57eab4948addc9e2a67179d098a5`.

Removes the redundant Ask Assistant button, puts an icon-only settings gear in the toolbar, combines Flows and Scopes into Workflows, centers the segmented-control icons, and gives Add notification a colored plus button. The registration dialog uses two columns, moves event/tag help to tooltips, removes redundant copy, and supports close, backdrop and Escape dismissal. Mobile retains access to the assistant.

Only `public/libraries/apps/settings/company.js` and `public/libraries/apps/settings/notification-registration.js` are deployed. Each target starts from its verified current baseline; hard-link copies use atomic replacement of changed files and release metadata. No backend, database, worker, production or topology changes.

Local syntax and browser regression checks passed, covering toolbar geometry, combined workflow categories, centered icons, dialog layout/dismissal, existing registration behavior and mobile settings. Activation and hosted verification passed. Both public asset hashes matched, six public readiness responses passed, and each of the three affected roles passed file hashes, runtime identity, readiness and enforced development isolation. The hosted-source browser regression passed the toolbar, combined workflow categories, centered icons, wider dialog, close/backdrop/Escape dismissal, registration retry, delivery methods and responsive layout with API fixture data. No authenticated organization settings were changed for testing.

## Activation and rollback

Final deployment release: `7ee54c8b9a34670fb64507513884f7299efd0a88` on compatibility and the second web node. Concurrent releases changed the baseline during staging; guards stopped the rollout and the source was re-audited before continuing. The first web node already contains the exact two feature files under the subsequent Contacts release, so that verified release is retained without another restart.

- web: retained active `c5d51c9298f4aedde93d489de74acf0b3a843ff9-contact-editor-1`
- legacy: predecessor `fd4e70334953b66ea1362925b10f516b552b51c8`
- pool: predecessor `c5d51c9298f4aedde93d489de74acf0b3a843ff9-contact-editor-1`

Before rollback, check for intervening deployments. Restore the relevant previous current symlink and restart its development web/compatibility and PHP-FPM services. For the retained web release, prepare an inverse of only the notification UI delta rather than replacing the newer Contacts release. Verify development readiness and actual release identity. Evidence: ignored `output/notification-ui-polish-20260929/`. Existing replacement-image limitations remain.
