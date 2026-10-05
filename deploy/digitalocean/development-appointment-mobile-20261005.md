# Mobile scheduling and fullscreen appointment booking — October 5, 2026

Runtime commit: `85711a2f51a35329c58ec4b8be774d6aadc6136d`.

The phone appointment action is a 40px red plus at the right of the existing calendar toolbar. The separate full-width row is removed. Month controls shrink without overlapping adjacent controls at 320px. The payment attention banner no longer reserves its height twice in the mobile flex layout. Booking uses the full viewport through the scheduling phone breakpoint (720px), including safe-area padding; desktop retains its inset dialog.

Only Scheduling app.js, booking.css and platform-banners.js are included in the development overlay. Public form booking contracts and availability computation are unchanged. The booking browser suite now asserts the exact fullscreen bounds.

Validation: ten appointment browser tests passed. Hosted browser checks cover 320, 390 and 430px widths, toolbar placement without overlap or a header gap, fullscreen timed and multi-day booking, and desktop dialog sizing. Disposable signup-sandbox organizations are removed after verification. Screenshots and rollout evidence are in output/appointment-mobile-20261005.

Deployment: development only, preserving each server's current source baseline. Concurrent deployments caused guard stops and fresh baseline audits before staging. Final baseline on web and compatibility was 0ed4fb7cfca333795dc1eaab6df76fbc5e301c13. Pool was re-audited and restaged on 0562254e1086b7aeab71226aba99763e2b39146a after another concurrent activation. All three roles subsequently passed source-hash, runtime release, development isolation and readiness verification. All three hosts use guarded hardlink staging with every changed file and release metadata detached before writing. Pool initially rejected full-copy staging for insufficient free space; hardlink staging retains the existing 1GiB reserve/inode checks and deletes no old release. No production, worker, data, configuration or topology changes.

Rollback: retain the previous release recorded per host in the rollout manifest; use the guarded development activation procedure after checking the current baseline. No data migration to reverse.
