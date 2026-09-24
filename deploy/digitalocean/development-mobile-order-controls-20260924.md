# Mobile report order controls — September 24, 2026

## Compact pill follow-up

Source commit `7818dc5706e3b163469a36e767a40b4a5f52ac99` returns the
Residential, report scope, and Pin confirmed controls to 28 px pill height.
The address input now shares their 12 px horizontal inset. Its focus highlight
is drawn inside the field, preserving the complete border at the screen edge.
Chrome layout checks at 320 px and 390 px showed matching address and pill
edges and three equal-height pills. The changed script passed `node --check`.

Both development web nodes run release
`7edfbc71e5c5c17ae1aae4f0add559b4e1532e4b`, copied from the common
`d754760eea47a19e6f33af5a72a3ea47a18f5c8d` baseline. Only
`project-request/app.js` and `release.env` changed. Local readiness reported
the exact release, development data, and enforced outbound isolation on both
nodes. The public script SHA-256 matched the staged file:
`7edbb28a4cbb99383f9011599bb4c0a641b4647206ca32ddeacb5e2fcef232a7`.
Rollback is the retained `d754760` release. Production was not changed.

Source commit `25b27ad96075a73e793ef855dfb1cfba4ff27abc` changes the
development mobile New Report location step. Address focus spacing is symmetric.
The opening shell and step transitions no longer repaint repeatedly, the map
tab is not reactivated during routine workflow renders, and the modal does not
focus an input automatically on mobile. The pin step reveals once when it first
becomes available. Moving or adding a pin keeps its control mounted and does
not replay that animation.

After confirmation, the existing checkbox becomes a green **Pin confirmed**
pill next to the property type and, when available, Full Structure selectors.
The Next button fills the row previously occupied by the checkbox. Commercial
and Multifamily go directly from property type to pin placement. Residential
does the same when Full Structure is disabled; a sole Roof Only choice is not
shown.

The 14 focused mobile, draft, and exterior workflow tests passed. All three
changed scripts passed `node --check`, and a 390 px Chrome layout check showed
three equal 118 px pills, a full width Next button, and equal 16 px address
insets. Physical Android visual acceptance remains to be done.

Both serving development web nodes now run release
`d754760eea47a19e6f33af5a72a3ea47a18f5c8d`, copied from their common
previous release `05a5d0488b416d9e08a52ea2a9cfc1b21ca678d1`. Only the
three order scripts and `release.env` differ from that baseline. Both nodes
passed local readiness on development data with outbound isolation enforced.
The public script hashes matched the staged files:

- `project-request/app.js`: `711b41ab7c9bc85c83aa1d8d353c62d862ac9a3a7745e510df989e7548d70bae`
- `firstmeasure/order/app.js`: `ff01b211dcc0fc01da8c29d7fc4798852d270f8efea0da4bb7c648931c413315`
- `firstmeasure/order/exteriors.js`: `8c3a69ed23d1e004585d86344dcffe1990d3afe16759fb00313c0c3258a2934b`

Rollback: switch each development web node to the retained `05a5d048`
release, restart `firstmeasure-development-web.service` and `php8.3-fpm`, and
check `/v1/health/ready` on localhost port 3201. Production was not changed.
