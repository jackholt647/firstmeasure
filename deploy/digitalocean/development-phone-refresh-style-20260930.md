# Phone refresh and shared minimized chrome — September 30, 2026

Development-only source: `8cea7bf32665660d67b7f531cc404be8eadb4789`.

Refreshing previously generated a new device ID while the server still held the
old endpoint lease, producing a false another-tab conflict. The phone now keeps
its tab ID in sessionStorage and holds a document-lifetime Web Lock. A duplicated
tab cannot reuse the live original's ID. Page exit stops the SDK locally without
sending a late credential revocation that could disrupt the reloaded page.
The existing backend protection against a different device remains unchanged.

The minimized phone uses shared window identity and control styling. It shows a
phone icon and New call before dialing, or the contact name after a call starts.
There is no subtitle, idle waveform or Click to open text. Idle width is 264px;
active calls use 360px for audio, mute, hold and hangup controls. Height remains
32px. All buttons share the window manager's control dimensions. Clicking the
bar still opens the previous placement. The 264 by 448 floating dialer is retained.

Validation: nine browser tests cover real reload identity reuse, a duplicated tab
with copied storage, registration cancellation, queued calls, outcomes, exact
window dimensions, consistent minimized controls, docking and project/contact
window regressions. Screenshots with the app's Font Awesome stylesheet were
inspected. Tests use fixture APIs; no live call was placed.

The frontend overlay preserves each role's baseline and compatibility manifest.
No backend, database, provider configuration, worker or production change is
included. Evidence and previous paths are in ignored
`output/phone-refresh-style-20260930/`.

Rollback: check for newer releases first; restore each role's previous immutable
symlink, restart its development service and verify readiness and outbound safety.
There is no data migration to reverse.

Web, compatibility and pool were activated from
`2f541394dabffc53112a3cd54b7f7e3921a9fb0e` to
`8cea7bf32665660d67b7f531cc404be8eadb4789`. Worker remains unchanged.
All four changed assets matched their expected hashes on four public requests
each. Public readiness confirmed this development release and outbound safety.
Both refresh/duplicate-tab and phone layout/interaction regressions passed again
using served JavaScript. Unauthenticated voice status and contacts returned 401.
