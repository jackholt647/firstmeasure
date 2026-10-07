# Mobile project header and company contact layout — October 6, 2026

Runtime release: `dd27dc17e08db99f57ac7450773a66601328eb99`.

My Projects keeps its title and List/Tiles controls on one row on mobile. The
mobile title and icon scale down to fit at 320px. Advanced opt-in controls retain
wrapping. Desktop layout and project view preferences are preserved.

Company information uses two equal columns on mobile: company name and phone on
the first row, with email spanning both columns below. The scoped grid rule takes
precedence over the shared Brand Kit stylesheet. Desktop retains three columns.
Language, measurement preferences, company data and saving behavior are unchanged.
The two asset versions are updated in the application manifest.

Candidate Chrome checks passed at 1440, 620, 390 and 320px as applicable, including
field alignment/full-width email, no horizontal overflow, inline project title
and view controls, repeated List/Tiles switching and reload. Disabled boards did
not request board data. Disposable signup sandbox fixtures were deleted.

Deployment uses audited per-role immutable overlays on web, compatibility and
pool. Three frontend files are updated, with unrelated live differences preserved
by three-way merge. The worker and production are excluded. Staging uses hardlink
clones with detach-before-write, hash/baseline checks and capacity guards.

Deployment artifacts, receipts and verification are in
`output/projects-inline-header-20261006/`. The prior serving release is
`90fce73f149950417eabda93538d22ca47a9e2a8`, under `/opt/firstmeasure/releases/`
on web/pool and `/opt/firstmeasure/releases-root-archive/` on compatibility.
Rollback restores the role-specific recorded prior path, restarts its service
and reloads PHP-FPM; inspect intervening releases before rollback.

Activation and final verification passed on all three serving roles: all owned
asset hashes matched, readiness passed and development outbound isolation remained
enforced. A fresh hosted sandbox organization passed both responsive layouts,
full-width email/right-column phone checks, no horizontal overflow, repeated
List/Tiles switching and reload, and no board requests. Screenshots were visually
reviewed. All verification fixtures were deleted.
