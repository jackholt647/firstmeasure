# Voice integrated into assistant chat — October 2, 2026

Initial source: `b4be201581da016e9dac90105a675f7efa0a99a0`; final source/release: `8af889459db53e340156730a1b6be96cf082a773`.
Target: `https://dev.1m8.ai`, development web/pool.

## Behavior

Live speech appears in normal chat bubbles. Dictate/Start Voice become Mute and
Stop (a red square). A fixed, centered header waveform scales vertically with
received remote audio RMS; reduced-motion uses a static indicator. Typed messages
and uploads remain usable and share the serialized voice/backend queue. Replies
return to GPT-Live commentary. Hang-up releases capture, audio context and meter
animation and restores composer controls. Drafts and unused attachments survive.
A chat-level play button recovers blocked autoplay without a separate voice panel.

Backend calls retain existing permissions and durable history. Live small-talk
transcripts remain session-local. Queued typed work and already submitted spoken
tasks may complete after hang-up; no uncertain action is automatically replayed.

## Verification

Eight focused browser/runtime tests passed for voice, project, channel and
payment surfaces. Coverage includes typed requests/files during a pending voice
turn, serialized execution, mute/stop, transcript placement, overlapping speaker deltas, draft retention,
waveform amplitude, fixed centering and narrow-header collision avoidance.
Docked/full screenshots were reviewed. An authenticated isolated API fixture and
the real browser UI completed a live GPT-Live call with audible output, in-chat
transcription, a responding waveform and orderly close using the existing server
credential. Evidence is under `output/assistant-voice-chat-20261002/` (ignored).

## Release

Activated and verified on both development web roles. Both were reconciled over
`a1d965d72131e26744b0fa918767fad01364441f`, preserving the completed widget rollout.
Only the assistant frontend was overlaid; production, worker and compatibility
were outside scope. The backend implementation digest remains unchanged at
`99a503f0b19fae9262afa4364a11bc5da268381930e677f1a69995c3ee0a6173`.

Both roles passed release, file hash, readiness and development outbound-safety
checks. Public readiness reported the new release and the served assistant asset
matched SHA-256 `3ad25e79bb811964b6a71154612e27ecd778af35b6c386cbbb31e1619d5c7f80`.
Unauthenticated voice endpoints still returned 401. Both voice and shared project
assistant browser tests passed again using assets fetched from `dev.1m8.ai`.

Rollback uses the previous role path recorded in the manifest, followed by a web
service restart, PHP reload and development readiness/outbound-safety checks.
Review subsequent releases before restoring an older baseline.
