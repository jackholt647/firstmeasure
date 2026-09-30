# Animated window docking — development, September 29, 2026

Source and development web release: `c80d775f1e4139f853f8605c8d1dc5ebd52a46b9`.
Previous release on both web nodes: `dddf305003fbdb170570f1f11e1d3a2615c1d36c`.

The project window rejects entire-screen presentation and retains workspace
maximize. Dock clicks alternate right/left. Right-click offers side and corner
placements, separated by a thin rule. Floating header drags preview side, corner,
top and bottom docks; release commits and moving away cancels. Divider double
clicks exchange adjacent windows or swap the dock with the main workspace and
its remaining width. Window geometry and content reservations animate together;
direct pointer manipulation and reduced-motion preferences are respected.

Only three frontend assets were overlaid onto each guarded predecessor release:
the shared window manager, project app and application manifest. The manifest
preserves the already-deployed Contacts global-search cache version and comment
encoding. Concurrent unpublished Notes, Feedback and other changes were excluded.
The project bundle cache version was advanced for the fullscreen restriction.

Both development web nodes, `do-598520065` and `do-603124965`, were activated
sequentially using the existing guarded staging/activation procedure. Each passed
development environment safety, release identity, readiness and asset hashes.
Public hashes match all three committed assets; six public readiness checks passed.

Validation: JavaScript syntax and TypeScript checks, shared docking browser
regression, assistant docking regression, and retained project iframe checks.
The project fixture uses real pointer dragging across the iframe boundary and
verifies exact preview bounds, independent drafts, retained document identity,
placements and disabled fullscreen. Both the project fixture and the shared
window regression also passed using scripts fetched from dev.1m8.ai. These are
browser fixtures using hosted assets, not an authenticated customer session.
Evidence and guarded release manifests are in ignored
`output/window-docking-20260929/`.

Production, development worker/compatibility roles, configuration, schemas and
customer data were unchanged. No autoscale image was created; the historical
replacement-image limitation recorded in earlier frontend rollouts remains.

Rollback: first confirm no newer deployment has taken place. Restore the previous
release above through the atomic current symlink, restart the development web
service and PHP FPM one web node at a time, and verify readiness after each.
