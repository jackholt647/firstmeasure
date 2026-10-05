# Mobile capture controls — October 5, 2026

Runtime commit: `16c7bd83b35309f277a602ab4f5377551fbd3160`.

Full Structure photo and orbital-video capture now offer mobile-only camera switching, supported zoom presets, a continuous slider, and two-finger zoom. Controls sit beneath the upload/thumbnail strip. Zoom uses the active track capability range and `applyConstraints`; no unsupported ultrawide lens is fabricated. Switching releases the previous camera, requests the opposite facing mode, and restores the prior camera if unavailable. Active recordings lock camera switching while preserving zoom.

Camera startup no longer waits for native bridge discovery. Embedded project windows consult the top-level adapter's already-known info; Android only answers native messages from the main frame. Known older hosts still receive the update hint. Visibility changes caused by a permission dialog no longer invalidate a pending camera request. Backgrounding an active camera still stops it; foregrounding the active capture screen reopens it without an unnecessary Retry tap. Actual permission denial retains the explicit retry/upload fallback.

Verification: 15 guided-camera cases, nine orbital-video cases, and four theme cases passed. Added tests use simulated camera tracks to cover supported ranges, presets, slider, pinch, camera switching/track release, permission visibility changes with delayed bridge discovery, unsupported/rejected zoom, recording switch lock, and absent desktop controls. Screenshot inspection covered mobile control placement. A physical Android phone was not attached; OEM camera/ultrawide exposure remains device-dependent.

Deployment scope is one runtime file, `public/libraries/apps/firstmeasure/order/exteriors.js`, applied as a baseline-guarded immutable development overlay. Existing compatibility-host selector differences are preserved by the three-way merge. No APK rebuild, production activation, or worker restart is required. Evidence: `output/mobile-camera-controls-20261005/`.

Verified activation on web, compatibility and web-pool roles at `16c7bd83b35309f277a602ab4f5377551fbd3160`. Exact asset hashes, public readiness and development isolation passed. Each role was refreshed against the concurrent `bccb945f7d609caf9134eaa35ed8d8c06fd035e6` release before staging/activation. No deployment guard was bypassed. Production and worker were untouched.
