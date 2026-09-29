# Channels settings inside the app — September 29

Release `c2998c968551e1d28806cc45b1e56ce2175d758e` is pushed and active on both development web nodes and compatibility. Worker and production are unchanged.

The Channels settings button mounts the existing Company Settings component in its embedded Channels-only mode, inside the current Channels surface. A Back to Channels button restores the mounted conversation and draft. The same flow is available in the integrated sidebar conversation window. No global tab navigation occurs. Existing settings fields, persistence and permissions are reused.

The conversation stays mounted while hidden. Back, app unmount, window close and opening another overlay conversation clean up the settings view. A settings mount that completes after closing is immediately destroyed. Load failures remain inside the view with Back available.

JavaScript syntax and diff checks passed. A real-browser harness passed locally and against dev-served scripts for embedded parameters, no global navigation, Back, draft preservation, pending-load cleanup, overlay settings and overlay-close cleanup. The harness uses a mocked settings mount and messaging API; it checks the integration and lifecycle without changing organization settings. The underlying shared settings implementation is unchanged.

Three public asset hashes and six public readiness responses matched. All three updated roles passed source hashes, readiness and development-isolation verification. This immutable release inherits the live predecessor and overlays only the Channels app shell, shared Channels UI and bundle manifest. No backend, package or database change was required.

Rollback predecessor for each updated role is `b7a178b0e736f87e70c236f158eb0fdffcd457d8`. Check for newer deployments before rolling back, use the existing atomic symlink/service workflow, and wait for each web node to return to public traffic before proceeding. Evidence is under ignored `output/channels-settings-20260929/`. The existing autoscale replacement-image limitation remains.
