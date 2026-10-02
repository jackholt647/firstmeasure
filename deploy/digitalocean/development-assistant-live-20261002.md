# GPT-Live assistant voice — October 2, 2026

Final source and development web/pool release: `47a309bef4b3626e58dac73732883ab13ce17530`.
Initial feature commit: `65595e530cd85d2074c135ea60f4cd142a702706`.
Pre-feature release on both nodes: `1ae9b783ad8a08af8a645580108e93765c64114c`.

The global assistant composer now has a headphones button beside Dictate. It
starts GPT-Live (`gpt-live-1`) over WebRTC, with live captions, mute and end-call
controls. Client delegation sends accumulated spoken context through the existing
assistant messages API. The shared agent retains tools, personalization, history,
resource authorization and confirmation rules. The project API key remains on the
server; the existing development credential has verified model and session access.

Only four application source files and the two compiled backend counterparts were
overlaid onto each verified baseline. All other node contents were preserved.
Production, worker, compatibility, data, credentials and topology were unchanged.
Baseline/hash guards, development isolation checks, sequential activation and
rollback protection were used. Both final roles and public readiness were verified.

## Verification

- Local and staged Linux TypeScript checks passed.
- Assistant frontend syntax and 97 client checks passed.
- Voice API tests passed, covering authentication, explicit missing-CSRF denial,
  cross-organization access, settings, input validation, server credential reuse,
  fixed provider configuration, sanitized errors and owner-bound close tickets.
- Delegated voice requests were verified to retain platform tools and voice-specific
  instructions through the existing runtime.
- Browser checks passed locally and with the actual dev.1m8.ai scripts: cold start,
  duplicate delegation suppression, transcript forwarding, microphone mute/release,
  draft preservation, cancellation during session creation and window close.
- Real GPT-Live WebRTC sessions using the existing server credential received audio,
  transcribed a synthetic spoken request, delegated it, spoke the supplied backend
  result and closed. The deployed server-side close fallback was separately verified.
- Public asset hashes matched the final manifest; unauthenticated voice and close
  requests returned 401. Both roles verified final release, files and outbound isolation.

The broader assistant API suite passed 20 of 22 tests. Its two failures were the
notification rule-count assertion at `assistant-api.test.ts:502` and focused
notification-tool inventory at line 529; those notification behaviors were not
changed by this work. Focused voice cases passed separately.

## Operational scope and rollback

Operational artifacts are in ignored `output/assistant-live-20261002/`, including
initial/final manifests, source snapshots, public verification and real-provider
connection/delegation/close receipts. Neither API keys nor raw microphone recordings
are included in committed source. The test WAV contains synthetic speech only.

The browser ends a voice session after 20 minutes and releases capture on end,
window close or conversation change. Tasks already submitted can continue; later
corrections run sequentially rather than canceling an in-flight business operation.
Live small talk/captions remain session-local; delegated requests and agent results
are retained in conversation history. Start throttling is per process, not a
fleet-wide billing quota. No native mobile audio integration was added.

To roll back, inspect later releases first. Restoring the preceding `65595e5` release
removes only the startup/context hardening; a complete feature rollback should use
a scoped reverse delta of the four source files and compiled backend files. Restore
the pre-feature release only if that would not discard subsequent concurrent work.
