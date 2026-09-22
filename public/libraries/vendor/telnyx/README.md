# Telnyx browser SDK

`webrtc-2.27.10.js` is the pinned browser bundle from `@telnyx/webrtc` 2.27.10, distributed under the accompanying MIT license. Upstream: https://github.com/team-telnyx/webrtc. No CDN dependency is needed at runtime.

The customer-phone runtime uses short-lived JWT authentication and accepts only correlated staff legs. It does not call the SDK's public-number network test. FirstMate creates a separate, time-limited SIP diagnostic through its server.

When upgrading, verify authentication, custom-header propagation, call events, answer/hangup/mute, device selection and `call.peer.instance.getStats()` against the new release. Run the customer-call tests and a controlled Telnyx audio test before activation.

Bundle SHA-256: `07911545687ebcc5bc62e92d6ec0c5dd2ce6a19467672b27ae013896b31a9bf7`.
