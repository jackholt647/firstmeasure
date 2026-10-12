# Phone infrastructure for marketing

Phone Settings provides setup screens for lead-source links, website tracking pools
and SMS broadcast campaigns. A separate marketing app can own audience selection,
lead-source records, campaign creation and dashboards through the same published
contracts. No checkout, subscription, new billing entitlement or price catalog is
introduced here. The existing SMS delivery service continues to apply its existing
registration, allowance and usage rules.

## Tracking numbers and lead sources

Purchase or port real numbers through the existing human-confirmed Phone Settings
flow. An active number can have static attribution or belong to a website pool.
Static line settings and website rules carry `lead_source_id` and
`marketing_campaign_id`, separately from descriptive source/campaign labels and
Telnyx's 10DLC campaign IDs. A local source record owns its stable ID and optional
external reference. Other apps use `phone-marketing.source.save` to establish
their organization-scoped links. Existing historical labels are preserved.

The signed inbound-call handler snapshots attribution before routing. Website
assignments are resolved at the provider event time; an assignment created later
cannot claim an earlier call. Calls, first/last lead touches, published call records
and typed events retain their captured references. Attribution is observed website
source data, not independent proof of an advertisement impression or conversion.
The existing tracking report remains available; the new indexed call export
supports number/source/campaign/pool/visit/date filters with bounded pages. A
maintenance backfill adds historical tracked calls to the index without modifying
their original attribution or creating new lead records.

## Website number insertion

A pool contains dedicated, owned active voice numbers, a separate fallback number,
exact HTTPS website origins, optional ordered UTM/referrer rules, and assignment,
reuse-hold and retention durations. Pool numbers cannot overlap another pool or
have static attribution enabled. Numbers use their existing line/group/company
routing. Editing a pool cannot remove a number with an unexpired visitor hold.

Install `public/libraries/phone-tracking/website.js` using the snippet shown in
Website Tracking. The host consent control sets
`window.FirstMateCallTrackingConsent = true` and dispatches
`document.dispatchEvent(new Event('firstmate:tracking-consent'))`. Assignment does
not begin until consent is granted. The script replaces matching phone text and
`tel:` links, supports `data-phone-tracking` elements and subsequently inserted DOM
elements, and restores originals when consent is withdrawn or the service fails.
Each tab retains its opaque visitor key across tagless navigation. A new tagged
campaign creates a new visitor key; normal navigation preserves the initial source.
`FirstMateCallTracking.init(...)` also returns `refresh()` and `destroy()` for host
integration. No platform session cookie or carrier credential is sent to websites.

Public endpoints under `/v1/comms/phone-tracking/:orgId/pools/:id` are:

- `POST /assign`: visitor key, consent, page URL and referrer; returns assigned or
  fallback number, status, session reference and expiration.
- `POST /release`: visitor key; ends active assignment while retaining its reuse hold.
- `OPTIONS /:action`: validates the configured exact origin before allowing CORS.

Assignments are transactional. Simultaneous visitors cannot receive the same
reserved number. Active calls prevent reassignment. Defaults are a 30-minute lease,
24-hour reuse hold and 30-day history. Renewals retain source information; calls
during the hold have `retained_session` attribution. Pool exhaustion, rate limits,
disabled pools and absent consent use the fallback. A call without a retained
assignment is explicitly unattributed. Calling a saved number after it has been
reassigned cannot be reliably tied to its previous website visitor; hold duration
and pool capacity must account for that limitation.

Only allowlisted UTM fields, URL origin/path and referring hostname are stored.
Arbitrary URL queries, raw IP addresses, user-agent strings and visitor keys are
excluded from reports/publications. Private minute counters use hashed identifiers,
expire after two minutes, and limit one origin/pool/IP to 60 requests per minute
and a pool to 1,200 per minute. The existing phone maintenance owner purges expired
counters and visitor history. Session storage is scoped to the website origin/tab;
cross-device or cross-origin identity stitching is outside this implementation.

## Broadcast SMS

A draft owns a sender, template, sending schedule, optional start time, recipient
time-zone policy, expiry, reply cancellation, pace and marketing references.
Templates accept `name`, `first_name`, `last_name` and `company_name` placeholders.
Audience additions resolve saved contacts through current project permissions,
normalize and deduplicate phone numbers, and snapshot the selected contact fields.
Add up to 500 contacts per request, with up to 50,000 unique recipients per campaign.
Eligibility preview is paginated at a maximum of 500 recipients per request.

Launch, pause, resume and cancel require an explicit confirmed command and current
revision. Launched content/audiences are immutable. The phone background lane
prepares recipients separately from voice processing, reloads owner membership,
feature access and sender authority, checks marketing consent and registration,
and respects company and campaign hours. Unknown contact time zones can hold or
use the configured fallback. Changed contact phone numbers are skipped rather
than silently sending to the original number. Queue preparation uses a stable
campaign/recipient message ID and receipt. Expired preparation leases reconcile
already created messages before another local creation. Skipped recipients retain
a reason; transient preparation errors retry until the campaign expires.

Every recipient uses the existing organization SMS delivery service and separate
delivery record. That dispatcher rechecks campaign controls, actor/contact access,
consent, 10DLC readiness and both sending policies immediately before dispatch.
Pause holds queued messages; cancel prevents remaining sends. Messages already
accepted by the carrier cannot be recalled. Manually launching a campaign does
not bypass its automated sending hours.

All live SMS shares a transactional carrier-account/profile pacing budget, so
extra numbers or workers do not multiply the configured allowance. GSM extension
characters and Unicode messages consume multipart segment budgets. The platform
operator configures `TELNYX_SMS_APPROVED_MPS` to the verified account allowance;
default is one segment per second. Campaigns may reduce their pace, never exceed
that allowance. Carrier-specific restrictions and provider rejection/retry handling
still apply; do not treat a local setting as carrier approval.

Delivery, skip, failure, cancellation, reply and opt-out totals are exposed through
the campaign report. Replies match the most recent applicable campaign on the
receiving business number; replies received before preparation can stop remaining
work when enabled. Completed status is recorded only after preparation and delivery
waits settle. Existing inbound conversations, STOP handling and signed provider
delivery updates remain authoritative.

## Shared publications

Provider `phone-marketing@1` has seven typed exports: `source`, `pool`, `call`,
`visit`, `broadcast`, `recipient`, and `broadcast_report`. Source/pool/campaign
records list with bound cursors. Call lists require `args.from` and `args.to`
(exclusive end, maximum 366 days), with optional `phone_number`, `lead_source_id`,
`marketing_campaign_id`, `pool_id` and `visit_id`. Visit lists use `args.pool_id`;
recipient lists use `args.broadcast_id`. Record reads use `target.id`.

Six versioned actions reuse domain services: `source.save`, `pool.save`,
`broadcast.save`, `broadcast.audience.add`, `broadcast.control`, and the read-only
`broadcast.preview`. Writes require action receipts and revisions. Control is an
external effect; evaluate-only module execution cannot start a campaign. Preview
accepts optional `limit` and bound `cursor`. Current manager, organization,
application, branch, phone and project permissions are rechecked, including frozen
replay and expiration/removal of visitor/recipient sources. Reads do not create
domain records or make carrier calls.

Three events join the existing atomic phone outbox:
`phone.tracking.source_updated`, `phone.tracking.pool_updated`, and
`phone.broadcast.updated`. Existing call/lead events now include stable source,
marketing campaign, pool and visit references. Payloads contain status and changed
field names, never message bodies, browser keys or raw URLs. The existing scoped
development phone-event lane consumes these event types too.

## Deployment and verification

Web and phone/messaging workers must be released together. New indexed SQL tables
are additive and initialized through the communications store. Initialize them
once against the shared database before HTTP activation; code rollback retains
the compatible tables and records. Production activation remains separate.

Tests cover both SQLite and PostgreSQL: tenant and resource authority, pool
reservation/consent/CORS, concurrency, exhaustion, quarantine, historical call
indexing/pagination, preview pagination, campaign lifecycle and immutable content,
consent/feature/hours rechecks, shared multipart pacing, missed-call deduplication,
reply/opt-out attribution and typed publication privacy. Browser tests cover actual
settings submissions, website number/text replacement, consent withdrawal,
tagless navigation, dynamic DOM replacement, and mobile bounds. No real paid number
purchase, marketing text or carrier call is used in validation.
