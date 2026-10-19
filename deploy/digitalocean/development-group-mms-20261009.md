# Development Telnyx group MMS - October 9, 2026

Source implementation `25f85b17560339898b7acacfbc54861536c9f8e5` is pushed to
`codex/pioneer-puffin-feed-photos`. This change builds the group backend and
publication contracts; it does not add a phone-tray group composer or enable
real sending. See [the domain contract](../../docs/architecture/group-mms.md).

## Contracts And Safety

- Explicit `sms_mode: "group_mms"` preserves independent bulk SMS behavior.
  Stable threads contain the sending line and 2-8 normalized external members.
- Dedicated authenticated group creation, listing, history and send endpoints
  use the full stored participant set. Validated user-owned image uploads work.
- Inbound signed `cc` webhooks stay in the group, separate from private threads.
  Group inbound messages do not trigger one-to-one automated appointment replies.
- Whole-group delivery claims, per-recipient states/cost, opt-out suppression,
  provider reconciliation and ambiguity handling prevent automatic duplicate
  submission. PostgreSQL initialization adds group-safe indexes.
- Data provider `comms-sms-groups@1` publishes typed `conversations` and
  `messages`; `comms.smsGroup.create@1` and `comms.smsGroup.send@1` publish
  required-receipt actions. Fresh tenant, feature, branch/project and user
  authorization applies to invocation and frozen replay. No provider credentials
  or consent evidence are exposed.

## Validation

- Local TypeScript check passed.
- Full messaging suite: 67 passed. The extended group tests also passed after
  adding definitive retry and shared-ID reconciliation coverage.
- Full publication suite: 50 passed, one PostgreSQL-dependent test skipped.
- Real embedded-PostgreSQL group concurrency/migration test: one passed.
- Linux merged-stage group and publication coverage tests: three passed on web,
  pool and compatibility; Linux TypeScript check and build passed. Final tests
  additionally cover moved-project visibility and pagination across hidden
  threads. Local TypeScript and group checks passed again for that change.
- The wider Comms suite passed eight of nine checks; its ordinary email
  notification fixture did not produce the expected notification. This was not
  changed or treated as a passing check.
- The latest dev baseline's generic publication permission test rejects agent
  invocation of `customer-calls.supervision.barge`. The identical failure was
  reproduced directly on unchanged release `32cfaa66...`; group authorization
  and replay checks pass independently. Do not relax live call restrictions
  to satisfy this old test assertion.

## Rollout Continuity

The initial narrow overlay was built from actual development release
`32cfaa66b705030d42966e0b6a54b19e71b1fefd`, retaining newer call-analysis,
supervision, Channels and lead-intake publication changes. Pool activation of
the group source release passed readiness and captured-delivery checks.

Another release, `449e8316f6cc94c9190a896c11829ca1f7b634d5`, activated while
the rollout was in progress. It retained group changes on pool but not web or
compatibility. Read-only comparison confirmed its 15 pre-existing affected
source files on web are unchanged from `32cfaa66...`. A second narrow overlay
is prepared against `449e8316...` instead of reverting that release. Only the
23 scoped source files, 16 changed compiled modules and locked
`libphonenumber-js@1.12.31` dependency are carried forward; all unrelated
runtime files are retained from the current role.

The subsequent `00048e11d18454ed3ac907719a03692bc11b4543` number-search
repair changed only `messaging/telnyx.ts` among the affected source files. It
merged without conflict, including the original sending-line and registration
behavior. Its directory retained runtime release ID `449e8316...`. Full group
release `3ed5fc322b6e47af084e11259f2b139725e2c1e3` then activated on all three
serving roles, passing readiness, captured-delivery and authorized pilot data
reads. No existing call publication was removed.

Final source `4b5a14d76b463f4f1de5cb3fbf8ebe0093727374` hardens organization
thread lists against projects that move to another branch or become unavailable.
Listings omit inaccessible rows while advancing pagination across scanned rows.
Its regression checks pass. During staging another SMS API update landed as
directory `14ceb1ddc0cb480fc16fb1899499ed5fbbe4f039`, retaining runtime release
ID `3ed5fc32...`. That API source and compiled module were preserved exactly.
All other affected files were verified against the prior full group manifest.
Final stages copy this latest directory and overlay only three source/doc files,
one compiled group service, release metadata and the refreshed manifest.

Final web/pool stage path is
`/opt/firstmeasure/releases-group-mms-final/4b5a14d76b463f4f1de5cb3fbf8ebe0093727374`.
Compatibility uses
`/opt/firstmeasure/releases-root-archive-group-mms-final/4b5a14d76b463f4f1de5cb3fbf8ebe0093727374`.
The full prior-runtime artifact SHA-256 is
`af37cb07cd514e9aceda1b242302f69b3a998d236f82f335f3af0b1b7130968c`;
the final incremental artifact SHA-256 is
`2aac525e92dc026b1085ba79c69362556efb5d024a8c205d4c07d9c3fc90053e`.
Changed source/runtime checksums agree across the final stages. The source
commits are pushed; this is a current-dev overlay, not a whole-branch replacement.

Web, pool and compatibility have activated the final release. All pass readiness and a real
authorized Pioneer data read with `comms-sms-groups` and both required-receipt
actions registered. Existing `customer-calls` and `customer-call-analysis`
publications remain registered. Public readiness reports the final release,
development data and enforced outbound safety; unauthenticated group access and
an unsigned Telnyx callback both return 401. Public readiness briefly returned
503 during pool draining and recovered to 200 afterward. Compatibility's final
restart, captured-delivery check and authorized catalog/data audit passed too.
The complete changed-file manifest verifies on every active role. Public
readiness and both 401 rejection checks passed again after all activations.

## Delivery Remains Captured

All serving roles retain `COMMUNICATIONS_DELIVERY_MODE=capture`, required
recipient consent, shared encryption key, writable messaging root, the existing
Telnyx callback and Pioneer registration scope. The SMS allowlist remains
`+14259700671`, `+12068590917`, `+15099600721`. No real test message, number
order, registration submission or production change occurred.

The separate worker remains on `80ffae0533ce180f92b205a3acda2142d951738d`.
The available `ben` account has no noninteractive administrative access, and
root SSH is not accepted. Real delivery requires an administrative worker
rollout with this backend and the shared messaging configuration, approved
carrier registration/number association and purpose-specific recipient consent.
Do not switch capture to live before those conditions have been verified.

## Rollback

Restore the immediately preceding `14ceb1dd...` role directory and restart that
role's development service plus `php8.3-fpm`. Web/pool rollback target is
`/opt/firstmeasure/releases/14ceb1ddc0cb480fc16fb1899499ed5fbbe4f039`;
compatibility target is
`/opt/firstmeasure/releases-root-archive-group-mms/14ceb1ddc0cb480fc16fb1899499ed5fbbe4f039`.
Preserve registration scoping,
captured delivery, encryption key, writable storage and allowlist. Leave the
additive group-aware database indexes in place; do not restore the old unique
provider-ID index after shared group IDs have been persisted. These rollback
targets retain the full group backend but not the final moved-project listing
hardening. To remove the group feature entirely, review older role-specific
release provenance instead of blindly switching to a whole-branch checkout.
