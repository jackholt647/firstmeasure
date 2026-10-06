# Contact window chrome — October 5, 2026

Commits `4dfcbcc3dbcd5285a6d278e75e06acc71d9c4f6e` and
`bdaa6dbd20efcc7ce08f7f9284ba5db0143c81bc` remove the contact identity
title's redundant docking dropdown using the shared window manager's
`titleMenu:false` option. Existing header presentation and docking controls
remain available. Contacts now inherit the shared window corner radius.
Hosted computed styles confirmed that both contact and project windows render
with 12px corners; the project frame's earlier 14px declaration is superseded
by shared window styles.

The first scoped rollout advanced the contact, project loader, and manifest
bundle versions. Hosted verification exposed the effective project radius,
so a second single-file overlay removed the contact-specific radius entirely.
Both overlays preserve each audited serving baseline and unrelated source
changes, including the newer mobile presentation adjustment already deployed.
The worker had no affected runtime files and was excluded from activation.

All three development serving roles were verified on
`bdaa6dbd20efcc7ce08f7f9284ba5db0143c81bc`, with runtime release identity,
development isolation, and identical contact payload hashes. Public readiness
and the public asset hash passed. The retained prior immutable paths in
`output/contact-window-chrome-20261005/manifest.json` support rollback through
the normal sequential development activation and readiness workflow.

All five local window shell browser tests pass. A disposable hosted sandbox
confirmed matching computed corner radii, a plain contact title with no
dropdown or arrow, and the existing header docking placement menu. It also
rechecked project title → View Contact handoff, project closure after success,
18px desktop and 12px mobile media insets, split panes, and absence of document
overflow or browser page errors. The temporary organization was removed.
Verification receipts and desktop/mobile screenshots are under
`output/contact-window-chrome-20261005/`. This rollout activates development
only.
