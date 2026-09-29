# Global huddle windows — September 29

Release `2e7aa64e5a65d18cdf0c435b8f3d2c82791a306e` is pushed and active on both development web nodes and compatibility. Worker and production are unchanged.

Huddles now attach to the global workspace window manager in every Channels layout, including full conversations and embedded project threads. They can move outside chat, resize, maximize, minimize, and dock alongside other windows. Hiding Channels leaves the call open; closing the call leaves it and releases dock space.

JavaScript syntax and diff checks passed. Isolated browser checks passed locally and against dev-served assets for global hosting, movement outside a constrained conversation, resizing, maximize/minimize/restore, shared nonoverlapping docking, keeping the call when Channels is hidden and cleanup on leave. Screenshot reviewed. Tests use fake APIs and media. The maintained workspace fixture now also asserts global call ownership.

The immutable release overlays only Channels UI and its bundle manifest. All three roles passed hashes, readiness and development isolation checks. Two public asset hashes and six readiness responses matched. No backend or database change.

Rollback predecessor for all three updated roles is `70769784deef7b1147203105fd42469d6648ba7d`. Verify intervening releases before using the existing atomic symlink/service workflow. Evidence: ignored `output/channels-global-huddle-20260929/`. The existing autoscale replacement-image limitation remains.
