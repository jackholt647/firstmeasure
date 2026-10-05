# Android project opening inset — October 5, 2026

Development-only runtime commit: `15dc6d879aa839703658fcaf8acf30e7355a23a2`.

The Android host already applies system-bar insets around its WebView. Project opening chrome additionally used `env(safe-area-inset-top)`, creating blank space above both New Report and existing-project loading headers. The portal now sets a window inset override synchronously in its head for the Android FirstMate user-agent marker. Shared window headers and the route precover consume that override. Browser safe-area handling retains its existing fallback. No native APK change or production activation is included.

Validation: four browser-engine regression cases cover Android app/browser user agents, existing/New Report entry, a 47px top inset, route precover, managed loading shell, and embedded shell without a native bridge response. The pre-fix shared stylesheet fails both native cases with 47px rather than 0px; the updated stylesheet passes all four. The existing nine loading/header geometry cases also pass. These are Chromium emulation tests; a physical Android device was not connected for automated verification.

Deployment uses immutable, baseline-guarded overlays containing only `public/portal/index.php` and `public/libraries/window-manager/window-shell.js`. Unrelated workspace and host changes are preserved. Evidence: `output/android-header-inset-20261005/`.

The worker has no changed runtime files and is excluded from activation. Its staged no-op candidate was not activated. The rollout refreshed compatibility baseline after a concurrent development release; no guards were bypassed.

Verified activation on web, compatibility and web-pool roles: release `15dc6d879aa839703658fcaf8acf30e7355a23a2`, exact overlay hashes and development isolation/readiness passed. PHP lint passed during staging. The public shell asset hash and public readiness endpoint also passed. Production was untouched.
