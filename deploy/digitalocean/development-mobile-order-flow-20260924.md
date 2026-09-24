# Development mobile report ordering — September 24, 2026

The mobile New Report flow now uses one shared pager for Roof Only and Full
Structure. Location shows the property types, then the two report scopes, then
pin confirmation. Full Structure continues through Details, Photos, and Review;
Roof Only retains its existing three-page flow. The map fills the available
WebView height behind the Next control. The address suggestions and mobile
choice sizing were adjusted, and the Full Structure review includes customer,
address, technician, CC, and internal-note information.

Commit `ed8d1ee4cf474aece20306abf276203afa18d7b3` changed only the shared
project request script, the Full Structure order script, and a focused test.
JavaScript syntax, Git whitespace, and 14 focused order/mobile checks passed.
No physical Android device was available for a visual pass. The native Android
host still reserves the system navigation area; this web release fills the
WebView above it and places Next directly above those controls.

Both serving development web nodes were staged from exact runtime release
`6a58230d9d194b02da0af2d0685d323352e32e70`, whose two order scripts matched
the parent source of `ed8d1ee`. Only those two scripts were overlaid; the
concurrent portal boot change in `6a58230` and all runtime data were retained.
Both nodes activated `ed8d1ee` in sequence and passed local exact-release
readiness with development data and enforced outbound isolation. The active
project request and Full Structure script SHA-256 values are respectively
`35ec93ade794c2162007a533eec822ea4ebd0e08f189d1c88ea4e57e1e14581f`
and `5929e4fba8314b5ccc02c43015b00080aca2603b2a1fd4b2ac31ac5978f016a3`.
Public script URLs returned those same hashes. Production and the historical
development autoscale image were unchanged.

Rollback is the previous immutable `6a58230` release on either web node. A
replacement web node needs a current release before serving this flow.
