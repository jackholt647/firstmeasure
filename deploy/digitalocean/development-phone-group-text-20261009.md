# Phone Group Texting Development Rollout

Source commit: `d004d65267ac8233eaf99a98f065ec2c135a97e0` on
`codex/pioneer-puffin-feed-photos`, pushed to origin.

## Scope

The phone tray and Windows-managed phone modal now share recipient selection,
group/private thread loading, image rendering and group replies. Select 1-8
distinct contact phone numbers; 2-8 creates true group MMS rather than bulk SMS.
New groups use the selected configured line. Existing groups reply through the
dedicated endpoint using their stored full membership and original line.
Incoming authors/photos, participant details, delivery states, paginated older
history and explicit refresh are available. Images and emoji reuse the existing
composer and Channels picker. Failed unchanged sends retain their uploaded image
and idempotency key. One-to-one project SMS stays compatible.

## Verification

- `npm run check` passed.
- Fourteen distinct focused frontend/browser checks passed across group texting,
  tray/modal, conference calls, optional audio, session refresh and phone features.
- Both backend group-MMS API/publication/provider integration tests passed.
- Desktop/mobile screenshots inspected; incoming and outgoing image fixtures render.
- Authenticated dev browser confirmed two-contact group composing, image/emoji
  controls, and the working workspace button in both actual tray and modal.
- Real messages were not sent. The pilot currently has no text-ready line;
  registration and delivery activation still gate real sending.

## Deployment

Only six public browser assets were overlaid: the Comms API client, shared
communications UI/styles, tray, modal and application manifest. Current runtime
styles and unrelated manifest changes were three-way merged and preserved.
No backend rebuild, schema change, settings change or worker activation occurred.

Each serving host was staged from its actual current
`833eb38d-10dlc-approval` release and activated sequentially at
`/opt/firstmeasure/releases-phone-group-ui/d004d65267ac8233eaf99a98f065ec2c135a97e0`.
Web/pool use `firstmeasure-development-web`; compatibility uses
`firstmeasure-development-legacy`. Local/public ready checks passed after
activation. Rollback restores each host's recorded parent release.

Concurrent follow-on registration/feed releases carried these changes forward.
Continuity checks verify the five exact phone asset hashes and the group-text
cache versions in the manifest, allowing unrelated manifest updates. The original
release retains `phone-group-ui-runtime.sha256` and its parent-release record.

Group data/action publications remain available on all three hosts. Capture mode,
consent enforcement and the three-number test allowlist remain unchanged:
`+14259700671`, `+12068590917`, `+15099600721`. Live delivery still requires
carrier-approved registration and activation of the worker's group-MMS release.
Production was not modified.
