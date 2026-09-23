# Development wall and plane editor — September 22, 2026 UTC

Runtime `18a81abf43bc80ca38ed5f84a2809cfd78fdb3fd`, branch
`codex/dev-wall-plane-20260922`. Previous runtime and rollback target:
`9ee0e68ba5c8671468d121629ac97be00e7336c6`.

The release adds all-pairs 3D point connections with C, along-wall/perpendicular
extrusion toggling with E, constrained planes from selected geometry, two-stage
single-point rotation, tolerant plane membership, and plane clipboard,
transformation, deletion and nudge operations. See
[Wall and plane editing](../../dev/WALL_PLANE_EDITOR.md) for controls and scope.

The release was built on the deployed development commit in an isolated worktree.
Only `wall_face_draft.js`, `wall_solid_geometry.js`, `wall_editor.js`, and
`wall_mode.js` changed in the runtime. Guarded staging checked each baseline and
replacement checksum, then verified every other public runtime file unchanged:
24,113 on web and compatibility; 24,127 on worker. The complete platform,
localization, co-branding and earlier exterior fixes remain present.

Validation: 815 regression tests passed against the release candidate, including
the real Three.js/headless Chrome plane interaction test. All three development
services were activated and independently verified, with development outbound
isolation enforced. The worker was idle before restart. PHP-FPM was restarted
on both web and compatibility hosts.

Public `/v1/health/ready` returned this release and healthy development status.
All four JavaScript assets fetched through `https://dev.1m8.ai` matched their
release SHA-256 checksums. The requested editor URL for folder
`fullhouse_ce52c5ebb595e2c7461e102f8478e89c` resolves to the internal login for an
unauthenticated request; its saved project was not modified. Browser interaction
verification used the local regression fixture rather than that private project.

Hosts: web `143.198.68.11`, worker `137.184.44.82`, compatibility
`137.184.229.145`, using the respective `firstmeasure-development-*` services.
Production, databases, organization settings, rollout flags and runtime
configuration were unchanged. Local staging/checksum records are in ignored
`output/wall-plane-20260922/`.

The concurrent mobile task was notified after all checks passed so its next
release can preserve this baseline. Check live symlinks before any subsequent
deployment or rollback.

Rollback: while this is still the current release, restore the previous current
symlink on all three development hosts and restart the corresponding services,
waiting for worker jobs to be idle. Restart PHP-FPM on both web and compatibility.
Recheck readiness and outbound isolation. No database rollback is needed.
