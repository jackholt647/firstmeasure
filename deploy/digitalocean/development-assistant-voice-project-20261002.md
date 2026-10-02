# Assistant voice handshake and shared project UI — October 2, 2026

Source: `62190dbf89191d366ad8d1d31cf16960812c2d93`; final source/release: `ba1c7d9e8b5bb2ec0d04370399ef75a7c38ef8bf`.
Target: `https://dev.1m8.ai`, development web and pool only.

## Changes

- Preserve the complete WebRTC SDP offer through authenticated session creation.
  Trimming its trailing CRLF reproduced the provider's HTTP 400 `invalid_offer`
  with an SDP EOF error. Both development credentials already supported GPT-Live.
  Provider failures no longer falsely claim account ineligibility.
- Send initial commentary when voice connects, providing audible confirmation.
- Use the same assistant renderer/controller for global and embedded project
  conversations. Project context remains bound to its existing private thread,
  with project suggestions and independent drafts. Parent project windows retain
  placement ownership. Hiding/removing a tray ends microphone capture; observers,
  event handlers and polling are released on destruction. Starting voice in
  another assistant ends the previous call.
- Tighten Dictate/Voice controls, measure available placeholder width and shorten
  its text as needed. Placeholder-only inputs stay one line; typed messages still
  grow across lines.

## Verification

- `npm run check` passed locally.
- Two focused assistant voice API tests passed, including exact SDP preservation,
  existing credentials, authentication/CSRF/ownership and shared tool instructions.
- Eight browser/runtime checks passed across project, voice, channel and payment
  assistant tests. Project coverage includes 240–440px widths, navigation closed
  by default, project suggestions, separate drafts, correct thread routing, tray
  closure and voice exclusivity.
- An isolated authenticated API fixture using the actual browser assistant UI
  completed a real GPT-Live handshake, received audio and closed cleanly with the
  existing remote server credential. No provider key was copied to the browser or
  local workspace. Raw service/customer records were not used in this probe.

## Delivery

Both role baselines are `c70a1d4b9dffa0f913934c9d26d06046d23c0621`, preserving the completed project header/contact shortcut rollout. Both roles activated and verified the final release. Linux TypeScript/syntax/compiled-output checks passed on both staged releases. Public readiness reported the expected release, development data isolation and enforced outbound safety. The public assistant asset matched its manifest SHA-256, unauthenticated voice routes returned 401, and both voice/project browser suites passed again using the deployed asset. The scoped overlay contains one frontend
file, two TypeScript sources and their two compiled JavaScript files. Each role
clones its verified current baseline before applying the overlay; unrelated
workspace changes and other active releases are preserved. Guards stop on a
baseline change. Production, worker and compatibility hosts are outside scope.

## Rollback

Restore the role-specific previous release recorded in the deployment manifest,
restart `firstmeasure-development-web.service`, reload `php8.3-fpm.service`, and
verify development readiness and enforced outbound safety. Do not reuse an older
baseline without reviewing any subsequent releases.

Ignored evidence: `output/assistant-voice-project-20261002/` contains the inventory,
manifest, scoped payloads, public verification and real voice receipt.
