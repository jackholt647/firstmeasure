# Development mobile map hint alignment — September 24, 2026

The New Project map's pin instruction showed a narrow strip of map between
the address section and instruction banner on mobile. The shared map style
placed `#rMapHint` 14 pixels below the map frame. The mobile order banner
style changed its shape but did not override that more specific top offset.

Commit `4c42747e06326d54d9d80c95c19be15b72cd0cc2` anchors the banner at
the top of the frame in the mobile order layout. It applies to mobile browser
and the Android WebView; the desktop map hint retains its 14-pixel inset.

JavaScript syntax, Git whitespace, and all five focused mobile draft tests
passed. No physical-device visual check was available.

The one-file delta was staged from development web runtime `bdefd3f` as an
immutable `4c42747` release and activated one web node at a time. Both
`do-598520065` and `do-603124965` passed local exact-release readiness with
development data and enforced outbound isolation. The active map script on
both has SHA-256 `9fad18ae3d9bc34c77129210add00e79b4102a58dd59cca7e0b87bfaf20ec677`.
The public map-script URL returns the corrected selector. Public readiness
requests during verification reached only `do-598520065`, so load-balancer
routing through the second node remains unverified.

Worker, compatibility, production and the historical development autoscale
image were unchanged. A future replacement web node still needs a current
release/template to retain the fix.
