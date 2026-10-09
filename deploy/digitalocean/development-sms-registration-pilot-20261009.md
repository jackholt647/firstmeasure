# Development FirstMate 10DLC registration pilot - October 9, 2026

The user's real FirstMate Low Volume Mixed registration is owned by development
organization `org_983c8e17cd313149` (Pioneer Puffin Test Co 6277ef). The user
will enter FirstMate's legal business details and submit through Settings > SMS.
No legal details, brand/campaign submission, number order, or real text was
performed during this rollout.

Source commit `70ddc9b70200a56f17c7f1bdf33aaa88c74eb03d` is pushed to
`codex/pioneer-puffin-feed-photos`. Real registration is scoped by
`SMS_LIVE_REGISTRATION_ORGANIZATION_IDS` only in development and independent
of `COMMUNICATIONS_DELIVERY_MODE=capture`. Other organizations retain the
existing simulated registration and subscription setup. The pilot skips the
internal SMS subscription checkout, but not actual provider registration fees.
Fresh carrier profiles leave legal identity fields blank; previously simulated
submissions cannot be reused as carrier registrations. New campaigns default
to `LOW_VOLUME` (Low Volume Mixed).

## Validation

- Local TypeScript check and communications frontend checks passed.
- Fifteen focused registration API tests passed locally and on web, pool, and
  compatibility stages, including carrier scoping, attestations, payloads,
  fee recording, ambiguous number orders, and status refresh races.
- The real shared setup-wizard browser fixture passed at desktop 1280x860 and
  mobile 390x844; legal identity fields stay blank and Next stays visible.
- The merged development source passed Linux TypeScript check and build.
  Only the three changed compiled modules were retained from that build.
- All three roles activated the release with readiness and enforced development
  outbound safety. Public readiness reports the new release. An unsigned POST
  to the public Telnyx callback returns 401 before event persistence.
- A live settings check discovered the old relative messaging folder under the
  read-only release. Its runtime root is now the existing writable
  `/var/cache/firstmeasure-development/messaging`. All three roles restarted
  with that configuration and passed readiness again.
- In the signed-in Pioneer Puffin account, Settings > SMS now shows Telnyx
  Configured and Carrier registration - Low Volume Mixed. Set Up SMS Registration
  opens the real five-step shared wizard with empty display name, legal company
  name, EIN, and website fields. It is left open for the user to complete; merely
  opening the wizard did not submit any provider action.

The pool's isolated tests logged an unrelated missing `firstmeasure_jobs`
SQLite worker table during cleanup; all fifteen selected tests passed. The
full messaging suite was not used as a release claim.

## Deployment and Configuration

Stages were narrow overlays of the actual active development
`c967b5cb0e1ffc7cc71e8602e24eed260c38974a` directories, not whole-branch
replacements. Baseline file checksums were verified before overlay and
activation. Web and pool use `/opt/firstmeasure/releases/70ddc9b70200a56f17c7f1bdf33aaa88c74eb03d`.
Compatibility uses
`/opt/firstmeasure/releases-root-archive-sms-registration/70ddc9b70200a56f17c7f1bdf33aaa88c74eb03d`;
its stage was hardlinked and overlaid by unlinking only changed files because
disk space is constrained. Source/runtime checksums agree across the three roles.

Each serving role loads root-only
`/etc/firstmeasure/development-sms-registration.env` through the new
`zzzzzzzz-sms-registration-20261009.conf` systemd drop-in. It contains the
Pioneer pilot organization, captured delivery, required consent, writable
messaging root, shared encryption key, and callback
`https://dev.1m8.ai/v1/messaging/webhooks/telnyx`. The encryption key was
generated on web and securely transferred using existing SSH aliases without
printing or storing it locally. No encrypted compliance profiles existed
before key creation. Telnyx API credentials and verification public key were
already configured and left unchanged.

The three approved test SMS destinations remain exactly `+14259700671`,
`+12068590917`, and `+15099600721`. Delivery stays captured: carrier approval
alone does not enable real SMS. Ordinary accepted webhooks process immediately
on the receiving web service, and manual status refresh remains available.

## Remaining Delivery Activation

The separate development worker was not changed. The available `ben` SSH
account on `firstmeasure-employee` has no noninteractive administrative access;
root SSH is not accepted. Before enabling real delivery, deploy compatible
source/configuration there, including the same encryption key, and verify the
sender's approved brand/campaign, number association, recipient consent, and
three-number safety allowlist. Do not switch all dev organizations to real
carrier registration merely to activate the pilot.

## Rollback

Previous web/pool target:
`/opt/firstmeasure/releases/c967b5cb0e1ffc7cc71e8602e24eed260c38974a`.
Previous compatibility target:
`/opt/firstmeasure/releases-root-archive-sms-low-volume/c967b5cb0e1ffc7cc71e8602e24eed260c38974a`.
Restore the appropriate symlink and restart its development service and
`php8.3-fpm`. Preserve captured delivery, the writable messaging path, and the
shared encryption key. After any real profile has been saved, never remove or
replace that encryption key; it is required to read the stored legal identity.
Disable pilot registration by removing only its allowlist entry when needed.
No production source, configuration, services, or registration was changed.
