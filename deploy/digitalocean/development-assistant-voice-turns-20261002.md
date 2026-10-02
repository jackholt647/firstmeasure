# Separate voice conversation turns — October 2, 2026

Source/release: `8b2c81652c5c301006ee58bb1bbebb89805aab9a`.
Target: `https://dev.1m8.ai`, development web/pool.

The previous display kept an open bubble per speaker until a 1.5-second gap.
Fast replies therefore appended to earlier turns. The display now also detects
speaker handoffs using the transcript intervals. A late fragment whose interval
precedes the other speaker still completes its existing bubble. Transcript text
and backend delegation remain unchanged.

GPT-Live supplies timed fragments without explicit completed-turn events; see
[official session guidance](https://developers.openai.com/api/docs/guides/live-conversations).
The UI derives boundaries from those intervals rather than network arrival gaps.

## Verification

The voice browser regression covers repeated sub-1.5-second handoffs for both
speakers, incremental fragments and delayed delivery from the previous speaker.
The shared project assistant browser test and JavaScript syntax check also pass.

## Deployment

Activated and verified on both development roles. Only the assistant JavaScript
was overlaid onto each verified
live baseline (`74605b592745bec626d5d8d99354e37e02aa0aa9`). Backend digest remains
`99a503f0b19fae9262afa4364a11bc5da268381930e677f1a69995c3ee0a6173`.
Evidence is in ignored `output/assistant-voice-turns-20261002/`.

Rollback uses each previous release path recorded in the manifest, followed by
web service restart, PHP reload, readiness and development outbound-safety checks.
Review any subsequent releases before restoring an older baseline.

Both roles passed release, asset hash, readiness and outbound-safety checks.
Public readiness reported the new release; the served asset hash was
`1298dacff4846a4ae2d2ad06c9771dbdc045b7c84acd8deb1ca3afdcb4f84666`.
The voice and project browser tests passed again against public development
assets, including the rapid alternating-turn regression. Unauthenticated voice
endpoints retained their 401 responses.
