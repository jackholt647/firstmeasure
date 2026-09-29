# Projects stage-board space — development, September 29, 2026

Release `3cc4935019da836fc1474ae112267c1ac3acc671` removes the manual-movement hint above My Projects stages and its unused style. The Projects app bundle version changes so clients fetch the updated viewer. Dragging behavior remains intact. The release is pushed and active on both development web nodes and compatibility; worker and production are unchanged.

The immutable release overlays only `public/libraries/apps/projects/viewer.js` and `public/libraries/apps/firstmate-apps-manifest.js` onto each role's verified predecessor, `c9824fa1168a6d407b8ba5a9ffc026bb2e94e23f`. Live versions of both files matched the source predecessor on all three roles before staging. JavaScript syntax and diff checks passed, as did the focused Projects stages capability test. The broader Projects feature-gates test still has an unrelated existing address-autocomplete assertion failure.

All three roles passed staged and activated file hashes, readiness, and development-isolation checks. Two public assets and six public readiness responses matched the release. Evidence is in ignored `output/project-stage-space-20260929/`.

Rollback: check for intervening releases, then restore predecessor `c9824fa1168a6d407b8ba5a9ffc026bb2e94e23f` on the three updated roles using the existing atomic symlink and service workflow. Verify public readiness after each web node returns to traffic. There is no database or configuration change. The existing development autoscale replacement-image limitation remains.
