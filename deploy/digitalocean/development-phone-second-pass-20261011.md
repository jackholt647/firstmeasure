# Phone Texting, Voicemail, and Conference Controls

Development only. Source commits: `f8a8e4c8`, `ca3c8f71`, `3b0ec277`,
`199e35f9`, and `355602ab` on `codex/pioneer-puffin-feed-photos`.

## User Experience

- Tray and modal share recipient entry, contact selection, visible Continue,
  a larger composer, image attachments, the Channels emoji picker, and
  Enter-to-send / Shift+Enter-to-add-a-line. A raw number works without a contact.
- Incoming video attachments render in both conversation views.
- Recent calls refresh every 15 seconds without a refresh button. Completed
  calls show duration; unanswered/missed calls retain meaningful labels.
- Voicemail has playback speed, format-correct downloads, and icon-only
  Call/Text actions in the upper-right corner.
- Conference hosts have separate Leave and End for everyone controls.
  Removing/reinviting and individual hold/resume also cover the original caller.
  Prior participants remain visible; added participants use Telnyx's join beep.
  The keypad no longer crowds the active conference. Notes save before leaving.
- Leaving requires two other connected people and resumed holds. It frees the
  host's device while preserving the bridge. Remaining legs continue using
  company phone service. Maintenance does not terminate a departed host's call;
  normal duration limits and final-participant cleanup still apply.

## Backend and Publications

No database migration or role-grant changes. Conference states use existing
typed call services and scoped resources. `customer-call-conference@1` exposes
authorized participant/hold/departure state. Six external actions under
`customer-calls.conference.*@1` require `make_calls`, fresh call access, and
idempotent receipts: add, remove, hold, resume, leave, and end.

Pioneer Puffin's recording, transcription, and recording-policy confirmation
were disabled. Recent real calls had no retained recording/transcript. Nothing
was silently enabled; unrecorded past calls cannot be recovered. History now
explains missing capture and links authorized retained transcripts to AI notes.
The existing recording/transcription tests pass. No live carrier conference or
new paid AI-generation request was made for verification.

## Synthetic Data

`seed-pioneer-puffin-texts-20261011.mjs` added two private and three group threads,
292 messages, two images, and a five-second sample video to
`org_983c8e17cd313149` (Pioneer Puffin Test Co 6277ef). Group sizes are 3, 5, and 8.
Records are synthetic, idempotently keyed, and written without any transport.
The script requires development, capture delivery, consent safeguards, and the
named sandbox organization. It neither grants consent nor sends messages.

## Verification and Rollout

- Local TypeScript check passed; publication suite: 50 pass, one isolated
  PostgreSQL test skipped. Customer-call suite: 45 pass.
- Six phone browser cases passed, including emoji lazy loading, outside-click
  dismissal, Enter/Shift+Enter, number entry, footer visibility, WAV download,
  voicemail speed, conference controls, and historical host access.
- Merged runtime checks on all three serving roles: 46 pass per role.
  Desktop/mobile screenshots were inspected.
- Scoped overlays were rebased on concurrently deployed Notes, Phone Marketing,
  and SMS-registration changes. Guarded activation never rolls back a newer
  release. Unrelated assets, publications, configurations, and legal details
  were preserved.
- Serving roles are development web, pool, and compatibility. The final
  frontend correction uses release `355602abd9b1f5baee72ceb186347f4fd9b97ee0`
  with the `-download` suffix under each role's `releases-phone-second-pass`.
  Subsequent deployments may supersede this ID; audit actual process cwd as
  well as the current symlink and verify conference contracts and asset bytes.
- Capture, required consent, the three approved test destinations, and existing
  registration-pilot settings remain unchanged. Production was not touched.
