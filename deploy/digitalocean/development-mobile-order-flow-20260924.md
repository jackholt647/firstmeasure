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
Follow-ups `5330dd7` and `252d73e` remove the duplicated Android system-bar
inset while retaining the browser safe area for the close button. The
`252d73e` commit also contains concurrently staged platform billing files;
the development runtime rollout below includes only the two order scripts.
JavaScript syntax, Git whitespace, and 14 focused order/mobile checks passed.
No physical Android device was available for a visual pass. The native Android
host still reserves the system navigation area; this web release fills the
WebView above it and places Next directly above those controls.

The initial `ed8d1ee` release was based on `6a58230`. A concurrent signup
sandbox repair later replaced that runtime with
`2e15300977cae157b0b4118b425c2a0026b9b05e`, which restored the portal's
external app registry and made the order scripts old again. The final
`252d73ebb6acaa56c4c09a6a5fa31e208d35cd74` release was staged from that
exact repaired runtime with only the two final order scripts overlaid. Both
web nodes activated it in sequence and passed local exact-release readiness
with development data and enforced outbound isolation. The active project
request and Full Structure script SHA-256 values are respectively
`1e286dec60a20dd5ada01d7a10af71020251e09f19addac079338d4b4096be2e`
and `5929e4fba8314b5ccc02c43015b00080aca2603b2a1fd4b2ac31ac5978f016a3`.
Public script URLs returned those same hashes, and the signup sandbox state
API continued to respond. Production and the historical development autoscale
image were unchanged.

Rollback is the previous `2e15300` release on either web node. A
replacement web node needs a current release before serving this flow.
