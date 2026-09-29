# Project Modal window integration — development, September 29, 2026

Final source/runtime release: `aba0e9c0aeedcf126a9735becea7a885af2a9203`.
The initial integration release was `68d7cc5efc70e511a74e8a76177b6fc02bb049fc`;
`2fc1561` keeps app header actions out of the minimized bar so Close fits.
The final release also dismisses placement menus before the containing modal
receives Escape, covered with an earlier-registered host keyboard handler.

Project Modal uses the shared window manager with its own header and content
layout. The existing tab bar, app header action, left/right split, app region
mounts and close lifecycle remain owned by Project Modal. No second title bar
is added. Tall controls expose modal, floating, dock-right, workspace fill,
whole-screen fill, minimize/restore, pin and close. All are enabled for this
host; other window consumers keep their existing controls unless they opt in
with `presentationModes`.

The window manager accepts custom chrome, an existing controls container,
viewport coordinates, native modal layout, a menu container, and a stacking
container. Project Modal retains its responsive CSS in modal mode and moves
its intact overlay into the workspace for non-modal placements. Shared dock
reservations and stacking then cooperate with other windows. Modal registration
is released while docked, floating, workspace-filled or minimized. Tab-route
updates preserve placement; the existing fullscreen URL flag still restores
whole-screen mode. Moving or minimizing does not recreate app content.

Validation: JavaScript syntax and TypeScript checks pass. The new Chromium
script covers five placements and restoration from each, retained draft input,
custom header, drag, resize, placement menu, stacking with another window,
pinning, mobile screen dimensions, and release of dock space on close. The
existing 15 window restoration interactions pass. Eighteen of nineteen focused
project/mobile checks pass; the property-type forward-geocoding source assertion
also fails against unchanged HEAD and is unrelated to this integration.
Browser coverage uses isolated content/API fixtures with the real modal CSS and
integration functions, rather than a live customer project.

The three-file frontend overlay preserves the current release and concurrent
workspace changes. Evidence and per-node manifests are in ignored
`output/project-window-20260929/`. Development web nodes only; no schema,
dependency, service configuration or topology changes. Production, compatibility
and worker remain unchanged. The existing historical autoscale image limitation
remains.

Rollback predecessor on both web nodes: `3cc4935019da836fc1474ae112267c1ac3acc671`.
Check for intervening releases before using the existing atomic symlink/service
rollback workflow, one node at a time, with readiness and development isolation
verification.

Final verification: both serving development nodes (`do-598520065` and
`do-603124965`) passed local readiness, development isolation and all three
runtime asset hashes on `aba0e9c`. Six public readiness checks passed; all three
public script hashes matched. Both Chromium scripts passed with the assets
served by dev.1m8.ai. No production activation occurred.
