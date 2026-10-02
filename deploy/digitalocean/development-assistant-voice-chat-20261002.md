# Voice integrated into assistant chat — October 2, 2026

Source: `b4be201581da016e9dac90105a675f7efa0a99a0`.
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
turn, serialized execution, mute/stop, transcript placement, draft retention,
waveform amplitude, fixed centering and narrow-header collision avoidance.
Docked/full screenshots were reviewed. An authenticated isolated API fixture and
the real browser UI completed a live GPT-Live call with audible output, in-chat
transcription, a responding waveform and orderly close using the existing server
credential. Evidence is under `output/assistant-voice-chat-20261002/` (ignored).

## Release

Activation verification pending. Only the assistant frontend is overlaid. The
source delta is reconciled from its actual parent commit to avoid publishing
concurrent widget changes that are not yet present on a role. Each role retains
its current release baseline; production, worker and compatibility are outside
scope. The staged backend implementation digest remains unchanged.

Rollback uses the previous role path recorded in the manifest, followed by a web
service restart, PHP reload and development readiness/outbound-safety checks.
Review subsequent releases before restoring an older baseline.
