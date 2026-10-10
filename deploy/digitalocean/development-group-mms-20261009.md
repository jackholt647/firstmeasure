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
  pool and compatibility; Linux TypeScript check and build passed.
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

Final activation and public verification are recorded below when complete.

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

Restore the immediately preceding `449e8316...` role directory and restart that
role's development service plus `php8.3-fpm`. Preserve registration scoping,
captured delivery, encryption key, writable storage and allowlist. Leave the
additive group-aware database indexes in place; do not restore the old unique
provider-ID index after shared group IDs have been persisted. Pool's
`449e8316...` directory already contains the group overlay, unlike web and
compatibility, so rollback is role-specific.
