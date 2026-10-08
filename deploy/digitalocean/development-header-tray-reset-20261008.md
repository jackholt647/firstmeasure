# Header tray close/reopen placement — October 8, 2026

Development application release: `6c2a3d16a0c31d71d8206ad0d2c3b5a3ebda529e`.

Closing the global To Do, Phone, or FirstMate Assistant tray resets its original
right-docked placement and size. Reopening through the header uses that default
instead of its previous floating, maximized, minimized, or alternate dock layout.
The shared window controller exposes the opt-in `resetOnHide` behavior; other
windows retain their existing behavior. Minimize/restore within an open tray
continues to preserve placement. Existing content and assistant drafts survive
closing. A closed mobile tray also reopens docked when returning to desktop.
Phone close remains subject to its existing active-call and wrap-up rules.

Validation: browser regressions cover the shared reset, app-driven and async
closes, alternate docks, minimize/restore, retained content, mobile-to-desktop
reopening, the real To Do tray, Phone lifecycle, and the assistant draft.
Eight focused tests pass against the files served by dev.1m8.ai. The existing
local phone interaction suite also passes. Its broader hosted run expects the
uncommitted Phone settings control and cannot complete against the deployed
phone baseline; the focused hosted placement regression passes. Unrelated phone
settings edits were preserved locally and excluded from this release.

The frontend-only rollout overlaid four reviewed browser files on each live
role's immutable baseline. No backend, schema, environment, or topology change
was required. Concurrent development rollout drift was caught before activation
and re-audited. An intermittent development readiness 503 was retried without
weakening readiness or outbound-safety checks. Web and pool activated sequentially,
followed by compatibility. The worker does not serve these browser assets.

All three roles report the release above, pass local readiness and development
isolation checks, and match the four payload hashes. Public readiness returned
200 with outbound safety enforced; all four served asset hashes match the
verified payload. Evidence is in `output/header-tray-reset-20261008/`.
Production was not changed.

Rollback only after checking for newer releases: restore the role's prior
`current` symlink, restart its development service, reload PHP-FPM where applicable,
and verify readiness. The previous paths are:

- web: `/opt/firstmeasure/releases/7ca935eb0c8a3b8bd6ca96eca83842d19eca4087`.
- legacy: `/opt/firstmeasure/releases-root-archive/7ca935eb0c8a3b8bd6ca96eca83842d19eca4087`.
- pool: `/opt/firstmeasure/releases/72c0ee4e1bec4da865d6e306ee7111ea0d8b0700`.
