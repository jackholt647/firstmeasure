# Channels calling and conversation workspace

Implemented in the shared Channels UI and Channels/Calls APIs. Changes are local;
this work does not deploy the service or change production provider configuration.

## Interaction model

Calls have a participant stage, a compact labeled control bar, and separate
participants and settings surfaces. A camera-off tile shows the person's profile
image or initials, name, and mute state. Cameras and screens have separate tiles;
screen tiles use contain sizing so shared content is not cropped. A microphone
toggle does not mute shared computer audio. The stage supports resize, drag,
minimize, viewport expansion, and browser fullscreen where supported.

Settings contain Audio, Video & backgrounds, and Troubleshooting tabs. Audio
includes device selection, browser noise suppression, echo cancellation, and
automatic gain control. Video includes camera selection, blur, and a custom
background image. Diagnostics include device inventory, connection state, peer
packet loss/jitter or LiveKit quality, a speaker tone, and a microphone level
test. Unsupported speaker selection explains the operating-system fallback.

Reactions travel over the LiveKit data channel or the existing peer signaling
API. Invites copy a conversation link; recipients must already have channel
access. The host can remove a participant or end the call from Participants.
Removal is authorized on the server, marks the participant as removed, denies
future API joins/media updates/signaling, and disconnects them through LiveKit
when that provider is in use. Browser peers periodically reconcile their roster.

Clip recording uses **preview → start → stop → review → attach → send**.
Screen clips mix microphone narration with available screen audio. Recording
does not start until explicitly requested; stopping never uploads or sends.
Review supports native playback, discard, and recording again. Attach uploads to
the original conversation's draft. Tracks, audio contexts, and object URLs are
released when finished. Browser screen-audio availability still depends on the
selected tab/window and operating system.

Message hover controls show React, Reply, Save, and More. The More menu retains
editing, deletion, pinning, reminders, forwarding, follow, unread, links, and To Do
actions, with keyboard navigation. Schedule sits immediately before Send. The
datetime picker uses local time, and rejects past or invalid dates.

The main and thread composers render formatted content while editing. Their
toolbars include bold, italic, strikethrough, lists, quotes, code blocks, links,
tables, clear formatting, and mentions. Tables have configurable initial rows
and columns. The wire format remains Markdown, preserving compatibility with
drafts, editing, search, scheduling, and assistant history. Clipboard text is
converted to safe formatted content; arbitrary clipboard HTML is not inserted.
The editor is a lightweight browser editor, not a full document authoring suite:
complex nested Markdown and advanced table editing are not part of this change.

Assistant DMs expose **New assistant conversation** with a name. Each conversation
has its own channel ID and message history; the default assistant DM remains
available. Ordinary teammate DMs continue to deduplicate by membership. Existing
agent execution is reused; no credentials or model settings are changed.

Integrated conversation content supports full, docked, floating/resizable, and
minimized modes. Floating windows can be dragged. Pin keeps an expanded
conversation open when changing apps; docked/floating/minimized conversations
remain available while other work is active. An active call docks automatically
when changing apps. Closing an instance releases its media and marks its call
participant as left. Pin/window choices are browser-route state, not cross-device
preferences. This is one managed conversation window at a time, with multiple
assistant conversations available in the rail.

## Browser navigation

- `channelsOverlay`: integrated conversation channel ID.
- `channelWindow`: `full`, `docked`, `floating`, or `minimized`, scoped to
  `channelsOverlay`.
- `channelPinned`: `1`, scoped to `channelsOverlay`.
- `huddleFullscreen`: `1`, representing call expansion. Restoring this preference
  never grants media permission or auto-joins a call.

Opening a conversation pushes its identifying route. Window adjustments replace
the current entry. Closing uses `Portal.navigation.backOrClose`. Registered
handlers restore conversation/window state and do not write history while
navigation is applying. Native fullscreen requires a new user gesture on reload.

## Dependencies and operating limits

Camera effects vendor LiveKit track processors 0.7.2, MediaPipe Tasks Vision
0.10.14, and selfie segmenter float16 model v1 under `calls-runtime/effects`.
They are loaded only when an effect is selected. WASM and the model are served
locally; frames and custom images are processed in the browser. Includes upstream
licenses. The two WASM variants and model add approximately 21 MB to the checkout.
Segmentation uses the CPU delegate to avoid platform-specific GPU teardown stalls.

Browser noise suppression is not speaker-trained voice isolation. This change
does not add AI voice separation, captions/transcripts, breakout rooms, guest
access/waiting rooms, PSTN dial-in, remote desktop control, simultaneous docked
conversations, or server-side recording. Existing recording remains client-owned.
Those are separate capabilities, not implied by the new controls.

A full Zoom/Slack parity claim would also require load and network-interruption
testing against the deployed SFU, multiple real users, supported browsers/mobile
devices, and production recording/accessibility checks. Removal of already-issued
LiveKit tokens follows the deployed provider's token revocation semantics; API
rejoin denial alone is not a guarantee against token reuse on a self-hosted SFU.

## Validation

- Existing Channels API/SSE tests: 22 passed before new regressions were added.
- New API regressions: host-only removal, rejoin/media/signaling denial, separate
  assistant conversation identity, naming, empty history, and default-DM reuse.
- Shared Channels UI contract: 19 passed.
- Browser navigation contract: 40 passed.
- TypeScript check and JavaScript syntax checks passed.
- `node scripts/channels-workspace-e2e.mjs` uses an isolated in-memory API and
  Chromium fake media. It exercises real editing/table serialization, menus,
  scheduling, MediaRecorder screen capture/review, camera restart, the actual
  WASM blur processor, call cleanup, diagnostics, docking, minimizing, dragging,
  pinning, and Back/Forward. It sends no real messages or invitations.
- The same browser test opens two real WebRTC peers using in-memory signaling.
  It verifies duplex audio/video, simultaneous camera changes, camera plus
  screen sharing, screen stop, and host removal. Camera/screen slots are reserved
  during initial negotiation; media switches use `replaceTrack`.
- Screenshots are in `output/channels-workspace/`.
- The full `npm run test:navigation` also runs settings-layout contracts. Its
  Money settings layout assertion fails in an existing modified Money file;
  that unrelated work was preserved.

The browser runs caught an effects teardown race after camera restart and
one-way media during concurrent negotiation. The camera processor now shuts down
before its input camera track is stopped. Initial offer ownership is deterministic;
the answerer adopts offered media slots instead of creating duplicate transceivers.
LiveKit remote tracks now use the SDK's three-argument subscription callback and
retain their participant and camera/screen identity.

## Reference patterns

The design uses the separation of primary controls, settings, and participants
in [Slack huddles](https://slack.com/intl/en-gb/help/articles/4402059015315-Use-huddles-in-Slack),
along with the audio/video and reaction preferences described in
[Slack's preferences guide](https://slack.com/help/articles/1500002037922-Adjust-your-huddles-preferences).
[Zoom's participant controls](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062674)
and [meeting security guide](https://www.zoom.com/en/products/virtual-meetings/resources/securing-your-meetings/)
inform the distinction between personal device settings and host actions.
The background pipeline follows the
[LiveKit video-processor documentation](https://github.com/livekit/track-processors-js/blob/main/processor-docs/video-processors.md).
Peer offer-collision handling follows the
[MDN negotiation pattern](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation).

## Follow-up browser review (September 4, 2026)

Recording controls and disabled-feature copy are now omitted from both call startup
and channel settings when recording is unavailable. Saving unrelated channel
settings preserves recording defaults while the feature is unavailable.
Message avatars and names open a profile card with the available name, photo,
email, and a Message action. The card supports keyboard dismissal and stays
inside the viewport.

The expanded call used z-index 1500 while its body-mounted dialogs and popovers
used 1000/1001. Dialogs and popovers now sit above the call at 1600/1601.
Dialogs have consistent typography, accessible names, Escape dismissal and
focus containment/restoration. Avatar buttons align with the message header.

The executable regression is `public/v1/scripts/channels-workspace-e2e.mjs`.
It runs real Chrome at 1366 x 768 with isolated API fixtures, synthetic camera
and microphone devices, and a synthetic replacement for the screen picker.
Clicks are performed normally, without forced clicks through overlapping layers.

| Surface | Exercised behavior |
| --- | --- |
| Profiles | Avatar and author-name opening, email, Close/Escape, Message recipient |
| Retention disabled | No recording fields or retention copy in startup or channel settings |
| Call window | Fullscreen/exit, minimize/restore, resize grip, camera-off identities |
| Primary controls | Mic mute/unmute, camera on/off/restart, reactions, invite copy, participants, settings, leave |
| Audio settings | Microphone selection, speaker selection when supported, noise suppression off/on |
| Video settings | Camera selection, missing-image guidance, custom image upload, blur, no effect |
| Troubleshooting | Connection check, speaker tone invocation, microphone-level meter |
| Host controls | Remove confirmation cancellation, actual removal and guest departure, end-call cancellation and confirmation |
| Two browser peers | Real WebRTC audio/video connection, concurrent cameras, camera plus screen, stop sharing, removal |
| Messaging regression | Rich formatting/table round-trip, action menu, scheduled send, clip preview/start/stop/attach |
| Conversation window | Dock, minimize, float, drag, expand, pin, close, browser Back/Forward |

Screenshots are saved in `output/channels-workspace/`, including
`fullscreen-audio-settings.png`, `fullscreen-invite.png`, `call-troubleshooting.png`,
`custom-background.png`, `resized-call.png`, and `user-profile.png`.
These were visually inspected at desktop size. This does not verify production
signaling, a deployed LiveKit service, physical-device quality, human segmentation
quality, or the operating system's screen-selection dialog.

The 59 Channels UI and navigation contract checks pass. The wider
`npm run test:navigation` has a separate Money settings layout failure.
The current `npm run check` reports an unrelated unknown-to-string type error in
`public/v1/comms/calls/service.ts:38`. Those concurrent changes were not modified.

### Conversation windows and profiles (September 7, 2026)

Window controls occupy a non-wrapping header row. Conversation actions occupy a
separate toolbar below it. Floating conversations have four pointer resize corners;
the dock has a draggable divider (also adjustable with Left/Right while focused).
A dock reserves its width in `mainPanels`, so the page occupies the remaining
space inside the existing main workspace and locked left sidebar. Closing,
minimizing or floating the conversation releases the reserved space.

Profiles use a compact card with Message and View profile actions, followed by a
right-side panel with available contact/work details. This follows the progressive
profile disclosure requested by the user; available fields are informed by
[Slack's profile documentation](https://slack.com/help/articles/204092246-edit-your-profile).
Profile information comes from the authenticated organization directory; unrelated
account fields are not included.

Run the focused browser check from `public/v1` with `CHANNELS_LAYOUT_ONLY=1` and
`node scripts/channels-workspace-e2e.mjs`. It checks the four resize corners,
360-pixel header, dock drag and keyboard resizing, workspace bounds between a
simulated locked sidebar and dock, profile actions, and profile Back/Forward.
Screenshots: `narrow-floating-conversation.png`, `docked-conversation.png`,
`user-profile.png`, and `full-user-profile.png` in `output/channels-workspace`.

Verification for the September 7 changes: the focused layout browser tests and
the wider real-Chrome messaging/call/two-peer regression pass. The directory API
regression passes for shared profile fields and exclusion of private account
fields. TypeScript passes. Contract suites still report unrelated assertions for
Money nested settings and the retired Calls entry point. The browser fixtures
use test data; production has not been deployed or modified.

### Shared window library

Conversations and calls now use `FirstMateWindows` from
`public/libraries/window-manager/window-manager.js`. It provides all four edge
and corner resize handles, dragging, shared dock reservations, focus stacking,
and minimize/restore. Title-bar controls are Dock/Float, Minimize, Maximize and X;
maximized windows instead show Dock, Float, Minimize and X. Pinning is in the
title menu. Restoring a minimized window preserves its previous mode and geometry.

Calls started from windowed conversations are independent workspace windows.
Closing a conversation leaves its call running; closing the call's X leaves the
call. Browser checks verify both the visible lifecycle and leave-call API counts.
Multiple docks are tested together with page content and a locked left sidebar.
See `shared-window-docks.png` in `output/channels-workspace` for the resulting layout.
The complete browser regression and TypeScript passed. The previously noted Money
and retired Calls contract assertions remain unrelated failures.
