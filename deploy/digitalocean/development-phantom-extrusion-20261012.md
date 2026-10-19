# Development: editable extrusion topology after coordinate reuse — October 12, 2026

Source: `abef1e005c5b3087e64c50ee0e90bbd3e5282054`. Integrated and pushed on the canonical branch through `aa0db37f`.

A 3-foot directional extrusion of the saved floating face landed exactly on four previously deleted corners. Global coordinate deletion masks hid its new vertices and all incident edges while its cap and side faces rendered normally. The saved-project replay reproduced zero editable cap corners before the fix and four afterward.

The shared preview/commit preparation now restores newly created boundary coordinates and overlapping edge intervals. Historical exclusions remain scoped to deleted source faces, and suppressed old loose connections are removed before the coordinates are reused. Unrelated deletions and partial edge exclusions remain intact. Normalization repairs an existing live face whose entire boundary was hidden by stale point exclusions. Cancellation, undo snapshots, and reload preserve the intended state.

Validation: 680 geometry/editor tests pass. Added tests cover reused coordinates, deleted diagonals and loose connections, partial edge revival, unchanged sub-micron geometry, exact saved geometry, rendered corner markers, preview/commit equality, cancellation, and idempotent load repair. Browser replay with the full existing saved project and cached rendering: 0/4 cap corners before, 4/4 after, with eight new edges. Evidence is in `output/phantom-extrusion-20261012/` (`before.png`, `after.png`, test logs and deployment manifests).

Development-only frontend activation verified on web, compatibility and web pool roles. The three changed editor assets match the immutable source commit on every role and through HTTPS at dev.1m8.ai. Development readiness and outbound isolation pass. Runtime processes and backend release `9d7aab3b259e86bcd4e80fa3e90d6ef8a45e794b` were preserved; the frontend release path is `abef1e005c5b3087e64c50ee0e90bbd3e5282054`. Production and customer project records were not changed.

Rollback: each role's exact pre-activation current path is recorded in `manifest.json`; all three began on frontend release `9d7aab3b259e86bcd4e80fa3e90d6ef8a45e794b`. Use the deployment workflow's guarded frontend rollback only while the current target is still this release, then reload PHP and recheck readiness. Do not overwrite a later deployment.
