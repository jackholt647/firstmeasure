# Development driven soffits — September 24, 2026

## Change

Source release `2acb42780eee33487a08fc1a7e2b17553beeb7b2` adds default-on
**Driven soffits · advanced Z-offset** under Walls → Advanced settings.
From Roof starts from measured roof contacts and compares adjoining measured
or inherited depths with the default, choosing the candidate closest to the
measured top-of-wall height. Propagation follows connected eaves within a roof
layer; rakes, disconnected runs and clearance-controlled sources stop it.
Existing layer-width limits and downstream closure remain in force.

The preference is saved and applies on the next From Roof rebuild. Turning it
off retains the previous default-depth behavior without immediately replacing
edited walls. Compare modes by changing the toggle and rebuilding From Roof.

## Validation

All 233 focused geometry and wall-mode tests passed. Coverage includes a
six-inch turret, default-depth preference when flatter, competing measured
anchors, rotated/reordered inputs, disconnected roofs, rakes, zero soffits,
measured depths above the default, and preference persistence.

The captured layered-turrets house fixture retains its measured side depths
and reduces the front top-of-wall height spread from over 0.1 m to under
0.002 m, with zero open foundation junctions. Legacy assertions that require
the old front depth run with driven soffits disabled.

## Deployment

A two-script delta (`wall_geometry.js`, `wall_mode.js`) was staged from exact
runtime baseline `d885489a08e42dacedfa9b8fc4e9275db005bc44` on development
web, worker, compatibility and the second serving web node `fm-dev-web-603124965`.
Staging verified 24,509 unchanged public files per web/compatibility node and
24,523 on the worker. Each node's existing environment was preserved. The
second web node has no full-house feature environment overrides; its exact
existing configuration was checked rather than changed.

Production and the development autoscale template were not changed. The
historical autoscale image limitation recorded in the global-assistant release
still applies to future replacement nodes.

All four services activated successfully and passed local exact-release
readiness with development data and enforced outbound isolation. The worker
had no running measurement jobs at activation. Both public editor script
hashes match the commit. The public editor redirects to login, so no claim is
made of interactive verification in the user's authenticated project.

Script SHA-256 values:
- `wall_geometry.js`: `4d2b3c488e696a4df168f4ffb592231eacad7bea508c587304d517f4ef6c7d5a`
- `wall_mode.js`: `fb237f9fa9081899e6ba4760182d24bb792e01ab93ef7038860e459b2144fe67`

Two batches of 24 public readiness requests all reached `do-598520065` and
reported the exact release, development data and enforced outbound isolation.
The second web node passed direct local readiness, but did not appear in these
public samples after restart. Public load-balancer coverage of that node is
therefore unverified; no routing or pool configuration was changed.
