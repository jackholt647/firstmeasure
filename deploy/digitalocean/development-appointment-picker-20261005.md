# Appointment project title, picker dismissal and heading font

Main commit: `1663e284be6137ab8af10cc7a5c4bc47e8a2e31c`. Final runtime: `f8f244fd0f5f5f6b188f0ccb53bc7d5314f1575b`, including valid project-title restoration when a custom name is cleared.

Selecting a project supplies its title until the user manually names the appointment. Automatic titles follow project changes; manual names survive project and preset changes. An initial project is resolved before the configuration editor returns, and stale project reads cannot overwrite newer selections or an edited name.

The shared project selector previously invoked its host callback before refocusing its input. Closing an outer details popup in that callback could be undone by the subsequent focus. Selection now completes focus handling before notifying the host, with an optional selection-complete callback. Booking closes its outer picker and returns focus to its summary. Configuration pickers also dismiss on outside pointer/focus and Escape, and closed popovers are explicitly hidden. Document listeners are removed on destruction.

The booking dialog heading inherits the active app typography instead of forcing Inter. Hosted verification compares it with the themed appointment controls (the portal body has a separate fallback font).

Ten browser tests pass, including automatic titles, retained manual names, full popup dismissal, Escape behavior and inherited typography. The changes were also checked in a disposable development sandbox on desktop and mobile, with no browser errors. Final deployed verification passed: automatic titles, manual-name preservation, clearing to a valid default, full picker dismissal, matching app typography, and zero browser errors. All three serving development roles passed source, release and readiness checks. The disposable sandbox was deleted.

Frontend-only deployment overlays eight owned files onto audited development baseline `8677524cfde4f5a8fb89518e5a36efb36d528574`. Asset versions are updated; existing legacy manifest differences and unrelated source changes are preserved. Worker and production remain unchanged.

Evidence, screenshots, per-role hashes and previous absolute release paths are in `output/appointment-picker-20261005/`. Rollback restores each role's recorded previous release, restarts its development service, reloads PHP-FPM, and verifies readiness and development isolation.

A concurrent rollout changed the live baseline after initial staging. The activation guard rejected that stale candidate before any activation. All roles were re-audited after the concurrent rollout completed, and the immutable candidate was rebuilt on its new baseline.

The title-clear correction overlays only configuration.js onto the initial picker release. Its manifest and rollback baseline are in `output/appointment-title-reset-20261005/`.
