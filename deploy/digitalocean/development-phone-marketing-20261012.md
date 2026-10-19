# Website call tracking and SMS broadcast infrastructure — October 12, 2026 UTC

Source `590e75f71e40312fbe2be423a636b7a21dca0729` implements stable lead-source and
marketing-campaign references, consent-aware website number insertion, dedicated
number pools, visitor assignment/reuse holds, historical call indexing, paginated
attribution reads, and durable broadcast campaigns. Phone Settings includes
Website Tracking and SMS Broadcasts setup screens. A future marketing app can
consume the shared backend instead of maintaining another delivery service.

Missed-call textbacks now check customer-care consent purposes and retain an event
receipt beyond their cooldown. Existing purchases/porting, routing and SMS
registration remain the provisioning path. No new customer billing, subscription,
price catalog or payment integration is added.

The [phone marketing architecture](../../docs/architecture/phone-marketing.md)
documents anonymous website endpoints, consent integration, leases, fallback,
privacy/retention, sender and contact authorization, campaign controls, preparation
recovery, sending windows, pacing, and reporting limits. The
[publication contract](../../docs/architecture/phone-publication.md) links all shared
data/actions/triggers.

## Verification

- TypeScript and JavaScript syntax checks pass locally and on each Linux candidate.
- 45 focused SQLite checks pass: 17 new marketing tests, 16 existing phone tests and
  12 phone-publication tests. The new tests include permission/feature revocation,
  quiet hours, stable query cursors, deduplication, expired assignment handling,
  delayed event attribution and historical backfill.
- All 29 marketing and phone-publication tests pass against embedded PostgreSQL.
- Four browser tests pass, including actual settings form submissions, sources and
  pools, campaign audience/preview/launch, text/tel replacement, tagless navigation,
  dynamically added phone links, consent withdrawal and mobile bounds. The mobile
  screenshot was inspected.
- All 59 existing messaging and Telnyx webhook state tests pass. Full publication
  tests pass 81, with the existing PostgreSQL-only case skipped in SQLite. The full
  suite uses a fresh platform root because one inherited custom-field fixture
  imports environment before its own setup.
- All 17 new tests also pass on the staged Linux web package against its actual
  integrated code, with SQLite and capture/disabled transports explicitly selected.

## Data and runtime publication

The existing `phone-settings@1` retains 15 exports and 7 actions. New provider
`phone-marketing@1` adds 7 exports and 6 actions; the phone event catalog contains
23 event types. Compiled catalog checks cover every candidate. Account and source
permissions, project authority, and frozen-source retention remain enforced.

Six additive SQL tables are created explicitly against the development PostgreSQL
store before HTTP activation. This is necessary because this deployment disables
automatic PostgreSQL schema migration. No existing table, tenant setting, provider
registration or billing record is altered by the schema step. The verified schema
result records six ready tables and no carrier call. The same additive initializer
is part of the communications schema for installations that permit schema creation.

The compatibility process remains the existing phone worker owner. Broadcast
preparation is a separate asynchronous lane; it does not block voice webhook and
call-command processing. Existing SMS dispatch rechecks controls, consent and
sending windows. General schedulers/backlogs are not enabled by this rollout.

## Development integration

Each candidate copies its actual immutable role baseline and overlays only reviewed
phone-owned source files. HTTP roles receive 24 files; the worker receives 20 backend
files. Current SMS-registration naming/header changes, Group MMS publications,
oversized-MMS handling, SMS identity approval, Feed, notes-tray and editor changes
are preserved. One concurrent pool baseline advance was rejected before activation
and restaged against the newer notes-tray package.

Reviewable cumulative patches and candidate source manifests are in
[phone-marketing-20261012](phone-marketing-20261012/). The ignored
`output/marketing-rollout-20261012` directory contains source captures, archives,
Linux build/test logs, guarded activation scripts and runtime checks. Activation
checks development environment, current baseline and source hashes, stamps a
detached release environment, switches the current link atomically and restarts the
matching development service. Readiness failure rolls back only if that role still
points to this candidate. Production is untouched.

All four roles serve the final phone source and compiled modules. Web, pool and
compatibility are ready with development outbound isolation; the dedicated worker
is active. Three public readiness requests passed. Public Phone Settings, its
marketing module, website insertion script and application manifest match staged
SHA-256 hashes. A temporary organization exercised the real published source-save
action, public HTTPS visitor assignment, stable source snapshot, durable outbox and
`phone.tracking.source_updated` event. The running compatibility phone owner
completed the event without the probe directly invoking either event processor.
The fixture organization, phone resources, visitor session, jobs and Work events
were removed; the action receipt remains as audit evidence.

See the committed [verification receipt](phone-marketing-20261012/verification.json).
A direct compatibility-node HTTP probe was rejected by its existing private proxy
guard; the real public HTTPS path was used. During the rolling upgrade an old pool
returned one 404; final public assignment succeeded after the newer route was
available. No proxy or authentication guard was weakened.

## Operational limits

Website setup requires installing the provided snippet and connecting the host's
consent control. Number pools use purchased/ported active numbers; setup does not
automatically buy inventory. Attribution reflects observed tags/referrers and the
retained number lease; calls to saved numbers after reassignment cannot be reliably
matched to the earlier visitor. Cross-device/origin identity stitching and external
advertising conversion uploads remain separate integrations.

Campaign consent, marketing-compatible registration and current sender authority
are required for real sending. Messages already accepted by a carrier cannot be
recalled by pause/cancel. No real paid number purchase, marketing SMS, provider
signup or carrier call was performed during this release. Website assignment and
shared-data/event verification use a temporary development fixture that is removed
afterward. Retail billing remains outside this work.


## Verified runtime identities

| Role | Current verified path | Candidate rollback baseline |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/2f38fe5498722be076573225d56168e5a60e18f6-notes-tray` | `/opt/firstmeasure/releases-oversized-mms/cab8e056-sms-identity` |
| pool | `/opt/firstmeasure/releases/phone-590e75f71e40312fbe2be423a636b7a21dca0729-pool` | `/opt/firstmeasure/releases-oversized-mms/2f38fe5498722be076573225d56168e5a60e18f6-notes-tray` |
| compat | `/mnt/firstmeasure_dev_releases/releases/2f38fe5498722be076573225d56168e5a60e18f6-notes-tray` | `/mnt/firstmeasure_dev_releases/releases-oversized-mms/cab8e056-sms-identity` |
| worker | `/opt/firstmeasure/releases/phone-590e75f71e40312fbe2be423a636b7a21dca0729-worker` | `/opt/firstmeasure/releases/cab8e056-sms-identity` |

Concurrent notes-tray activation on web and compatibility retained every phone
source and compiled module from `590e75f7`; verification checks their actual served
content rather than replacing the unrelated feature to normalize directory names.
