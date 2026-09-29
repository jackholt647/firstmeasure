# Pinned message attachments — September 29

Release `34ea50ad7addf8af6656fbca60b944d093c236f9` is pushed and active on both development web nodes and compatibility. Worker and production are unchanged.

The pins API already includes attachments, but the side panel rendered only message text. It now reuses the complete message renderer, including images, file links, video controls and attachment-only messages. An explicit View in conversation button opens the original message without intercepting attachment clicks. Existing pins benefit without being pinned again; the Pins tab already uses the complete renderer.

JavaScript syntax and diff checks passed. An isolated browser harness passed locally and against dev-served assets: pinning an attachment-only message, loaded image previews, file/video URLs and controls, file clicks keeping the panel open, original-message navigation and the Pins tab. Screenshots were reviewed with a synthetic image; video decoding/playback was not exercised. The harness uses fake APIs and does not modify user messages.

The immutable release overlays only the shared Channels UI and bundle manifest. All updated roles passed source hashes, readiness and development-isolation checks. Two public asset hashes and six public readiness responses matched. No backend or database change was needed.

Rollback predecessor for all three updated roles is `3e053cde2b68b83a27b6e46885ef241d27a450ed`. Check for intervening releases and use the existing atomic symlink/service workflow with public readiness verification. Evidence is under ignored `output/channels-pin-attachments-20260929/`. The existing autoscale replacement-image limitation remains.
