# Huddle controls, recording lifecycle and shared Files gallery — September 29

Release `c9824fa1168a6d407b8ba5a9ffc026bb2e94e23f` is pushed and verified active on both development web nodes, compatibility and worker. Production is unchanged.

Compact huddles prioritize the active speaker (or shared screen), retain a scrollable participant filmstrip, highlight speakers and keep the controls within the window. Recording uses a pulsing red dot. Microphone controls disable the captured tracks and update the published track; Web Audio gates quiet streams and explicitly muted participants for playback and recording. The voice threshold is configurable through the Channels UI options.

The starter is the default huddle admin and can grant admin access to a joined participant. Admins can end the huddle for everyone and stop/resume recording. An admin's departure ends the room, including the window-close path. Recording replies contain attachments without placeholder message text, retries use a stable identifier, and the huddle message renders spaced playable recording cards with downloads. Recording remains browser-based in the original starter's tab; that tab must remain open until saving finishes. Granting admin access does not transfer the browser recorder.

The background-effects failure was caused by `.mjs` assets being served as `application/octet-stream`. Vendored `.js` entry points and local imports now receive a JavaScript content type, retaining the existing local model/WASM assets. Blur, custom images and camera restart were exercised with actual processing.

Channels Files now mounts the existing `Portal.PhotoFeed.mountProjectGallery` implementation and delegates media opening to the shared viewer. Shared gallery code supplies thumbnails, tile styles, search, density and multi-select media-type filters. Native document entries without media URLs are retained and use their existing document navigation.

Validation: TypeScript check and JavaScript syntax checks passed; all 33 Channels API/inbox tests and the composer regression suite passed. New real-browser scripts cover compact layouts down to 320×260, speaker priority, capture-track mute, real oscillator audio gating, background processing, admin promotion, recording stop/resume, end/cleanup, recording cards and downloads, and shared gallery filtering/viewer delegation. Both scripts passed locally and with dev-served assets. Browser checks use isolated APIs and fake devices; they do not substitute for a live multi-person hardware call. All four roles passed release hashes, readiness and development isolation. Seven public asset hashes and JavaScript content types matched, alongside six public readiness responses.

The immutable overlay changes seven frontend runtime assets and four backend source/compiled pairs. Worker receives backend files only. It preserves the preceding notification runtime release and unrelated local work. No schema, dependency or topology change.

Rollback predecessor for all four roles: `a1378aa16ecfb44208e589073ccabe5155520c9a`. Check intervening releases before using the existing atomic symlink/service rollback workflow. Evidence is under ignored `output/channels-huddle-polish-20260929/`. The existing autoscale replacement-image limitation remains.
