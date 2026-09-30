# Notification UI refinements — September 29, 2026

Source release: `e50bb4f9bd8f57eab4948addc9e2a67179d098a5`.

Removes the redundant Ask Assistant button, puts an icon-only settings gear in the toolbar, combines Flows and Scopes into Workflows, centers the segmented-control icons, and gives Add notification a colored plus button. The registration dialog uses two columns, moves event/tag help to tooltips, removes redundant copy, and supports close, backdrop and Escape dismissal. Mobile retains access to the assistant.

Only `public/libraries/apps/settings/company.js` and `public/libraries/apps/settings/notification-registration.js` are deployed. Each target starts from its verified current baseline; hard-link copies use atomic replacement of changed files and release metadata. No backend, database, worker, production or topology changes.

Local syntax and browser regression checks passed, covering toolbar geometry, combined workflow categories, centered icons, dialog layout/dismissal, existing registration behavior and mobile settings. Activation and hosted verification pending.

## Predecessors and rollback

- web: `aad93679ad9512672be397e6e7142cf0db3a1d98`
- legacy: `aad93679ad9512672be397e6e7142cf0db3a1d98`
- pool: `aad93679ad9512672be397e6e7142cf0db3a1d98`

Before rollback, check for intervening deployments. Restore the relevant previous current symlink and restart its development web/compatibility and PHP-FPM services. Verify development readiness and actual release identity. Evidence: ignored `output/notification-ui-polish-20260929/`. Existing replacement-image limitations remain.
