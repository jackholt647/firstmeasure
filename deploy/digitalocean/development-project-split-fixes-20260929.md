# Development project split-pane fixes — September 29, 2026

## Change

Release `e5aadcf6387bd013a462ec893d79934972e2d8e3` updates only the project-request app and project-layout helper, based on development release `0fd9508eaafddc0b228abc3802d962234d08b5d8`.

- Normal tab clicks replace the focused pane, preserving the other open panes. Clicking an already open tab focuses its pane. Context-menu docking creates or moves a pane.
- Divider double-clicks swap content while retaining the physical left/right width ratio and live documents.
- Every displayed tab receives the existing red selected treatment, without stars. Tabs are 32px tall with a continuous header baseline.
- Dock actions are horizontal icons in an animated menu centered below the tab. Existing secondary panes also expose an icon for closing.
- Docked documents ignore startup route restoration: their parent owns their lifetime. A hosted browser trace reproduced the previous route timer closing a pane immediately after its ready handshake.
- Loading covers clear when the app reveals its shell, without waiting for background project hydration. Closing a pending pane removes its frame immediately; late completion cannot restore it.

The code-only sidebar rollback flags remain unchanged. No application settings UI was added.

## Realtime follow-up

The live browser then exposed connection starvation: each nested document opened separate organization events, online presence and project presence EventSources, leaving the pricebook language catalog and other assets pending. Release `c889812111a34c55020f45b0aee46e99addfa0a0` adds a **single-file** overlay for `public/libraries/platform-realtime/platform-realtime.js` onto `e5aadcf6387bd013a462ec893d79934972e2d8e3`.

Owned same-origin project documents share the parent's realtime transport. Project-presence watches are reference-counted by organization and scope. Subscribers still receive events in their own document; activity is forwarded and subscriptions are released on pagehide. Standalone documents retain their normal client.

The shared index was concurrently populated when this follow-up commit was made, so it also records unrelated staged source. **Only the realtime file is included in this deployment overlay.** Other commit contents were neither bundled nor activated.

## Validation

The split-layout browser regression covers local rails, both docking directions, pane focus and replacement, simultaneous selected styles, divider geometry, retained drafts, 32px tabs, menu positioning/icons, dismissal before startup, and a rendered shell whose hydration never resolves.

An eight-pane realtime browser test verifies three shared transports, delivery to every pane, and disposal when individual frames close.

The retained-window regression covers eight project contexts, independent drafts, five placements, minimization/wrapping and closing. All 15 window restoration checks pass.

An authenticated disposable development organization was used to verify Photos and Scope together, content-local rails, swapping without moving the divider, minimize/restore, switching the secondary pane to Overview, and closing, with no page errors. Fixture data and session are removed after verification.

## Deployment and rollback

The two layout files and subsequent single-file realtime overlay were deployed as immutable committed files with verified predecessor hashes to each development web node, preserving all other deployed files. The staging workflow copies the previous release with hard links and writes replacement files atomically; activation checks development environment safety and readiness. No production or topology changes are included.

Rollback each node by restoring its previous current symlink to `0fd9508eaafddc0b228abc3802d962234d08b5d8` and restarting the development web and PHP-FPM services, using the existing guarded activation workflow. Verify readiness and development environment safety afterward.

## Final verification

Both development web instances (`do-598520065` and `do-603124965`) report release `c889812111a34c55020f45b0aee46e99addfa0a0` healthy with development environment safety checks passing. Public hashes match both layout assets from `e5aadcf` and the realtime asset from `c889812`; six public readiness requests passed.

The authenticated browser test passed against the final live site with no asset or transport overrides, including loaded Photos/Scope panes and replacement of Scope by Overview. No page errors occurred. Temporary fixture organization, identity and session were removed.
