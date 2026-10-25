# Signup-funnel events recorded again - development, October 24, 2026

Source `f4c2eafa` on `claude/acquisition-tracking-20261024`, cut from production branch `codex/hotfix-20261023s`
(`7a37961d`, production `62119658`). Not on the canonical branch.

## What production showed (read-only)

- **Compatibility 500s.** `POST /v1/private/referrals/trackAcquisitionEvent` fails with `UNIQUE constraint failed:
  referral_events.partner_id, referral_events.actor_email, referral_events.actor_org_id, referral_events.event_type`
  (`ERR_SQLITE_ERROR` 2067). By day since the journal starts (Oct 20): 1,362 / 14,412 / 11,189 / 10,930 / 8,025 (to
  22:30 UTC Oct 24) failed against 1 / 16 / 1 / 2 / 4 recorded. Every other referral operation (landing lookups, signup
  completions, bonus offers and quotes) returned 200.
- **Web 503s.** Not throttling: there is no NGINX `limit_req`, and the 503 is the app's `referral_service_unavailable`,
  which the referral proxy throws for any non-2xx answer from compatibility. On 64.23.240.81, one hour: 120 503 and 0
  200 in the app journal; the NGINX log holds 1,247 503 against 1 200. Page views succeed because they go through
  `publicAcquisitionLookup`, a different operation.
- **Cause.** The compatibility ledger (`/var/lib/firstmeasure-legacy-production/.../crm/databases/referrals.sqlite`)
  still has `idx_referral_events_unique`, created by the retired PHP module, which kept one counter row per campaign,
  actor and type. The signup form sends every interaction as a unique event (its own `event_id`), which the TypeScript
  ledger inserts as its own row. Visitors are anonymous (empty email and organization), so after the first row per
  campaign and type every later one collides. Known since September 14 (`production-promotion-20260914.md`, deferred as
  174); `referral-ledger-reconciliation.md` found the same index blocking event recovery.

## What was lost

- The ledger holds 222 event rows. Each `signup_*` type has about nine rows: one per campaign, the first ever seen
  (from 2026-06-17, when the form's interaction tracking first wrote). Every later signup-form interaction on the
  authoritative ledger was refused: focus, input, clicks, mode changes, submit attempts, validation errors, OTP, login
  and register results.
- September 8-9, before web nodes proxied to compatibility, the inspected web node's own ledger
  (`/var/cache/firstmeasure/crm/databases/referrals.sqlite`) kept 1,910 `signup_*` events. Other nodes may hold more.
  They can be merged with the reviewed reconciliation tool now that the index no longer collides.
- Not lost: landing attributions (about 900 a day), completed signups and their attribution, bonus offers and quotes.

## Fix

- `referrals.ts`: the ledger replaces `idx_referral_events_unique` with the plain `idx_referral_events_actor` the
  first time it opens. Counter events (no event id) are read and written in one `BEGIN IMMEDIATE` transaction, so they
  stay one row per key across compatibility processes. `acquisitionEventInputs` validates a request: one event or
  `{ events: [...] }` of 1-25, `event_type` required (80 of `A-Za-z0-9_.:-`), `event_id` text up to 120, `metadata` an
  object, 16 KB an event; anything else is `400 invalid_acquisition_event`. `trackAcquisitionEvents` records a batch in
  one transaction.
- `referrals_service.ts`: the new `trackAcquisitionEvents` operation, and a 400 from compatibility stays a 400 on the
  web node instead of becoming a 503.
- `platform/acquisition_event_limits.ts` + `platform/api.ts`: each visitor address (the rightmost public
  X-Forwarded-For entry, which the load balancer appends) gets 300 events a minute, refilling continuously, per web node;
  beyond it `429 acquisition_events_rate_limited` with `Retry-After`.
- `signup-widget.js`: interactions are queued and sent as batches (25 events and under 48 KB, the beacon limit being
  64 KB) every 2 seconds; submits, results and errors flush at once with the queue so a signup that navigates away keeps
  its trail, and leaving the page flushes the rest. Older cached copies of the form still work (single events).

## Tests

- `public/v1/tests/acquisition-events.test.ts` (8 pass): a ledger carrying the PHP index records repeated anonymous
  interactions and loses the index; counters stay single; a batch of 25 is one call; bad input is a 400 and a refused
  batch records nothing; through the compatibility RPC a batch is recorded and a 400 stays a 400; the limiter accepts a
  page burst and a full form fill and refuses a flood with a retry time; visitor address parsing; the public route
  returns 200 for single and batch, 400 and 429 with `Retry-After`.
- `public/v1/tests/signup-embed-browser.test.mjs` adds a website visitor who fills and submits the form on a ledger
  with the PHP index: every request is a batch, returns 200, and every event (repeated `signup_field_input` included)
  is in the ledger through `signup_register_success`.
- Also pass: `referral-cluster`, `referral-ledger-reconcile`, `signup-widget-auth`, `access-gates`, the rest of
  `signup-embed-browser` (29 in all) and `tsc --noEmit`.

## Rollout

`output/acquisition-tracking-20261024/` (copied from the bonus-utm rollout), legacy then web, each file three-way merged
onto the live copy. The first attempt was refused at legacy activation ("Active release changed": another session
activated `8c81b7e7` between stage and activate; nothing of this release went live). The retry merged onto `8c81b7e7`
cleanly; legacy and web activated and verified on `f4c2eafa`. On dev.1m8.ai: a batch of 7 anonymous `signup_field_focus`
events returns 200 with `recorded: 7`, three more single events of that type return 200, an event without
`event_type` returns `400 invalid_acquisition_event`, and the served `signup-widget.js` batches.

## Production

Not changed. To release: compatibility (legacy) before the web nodes, because the web route calls the new
`trackAcquisitionEvents` operation. The first compatibility open drops the index (222 rows; instant). Ship
`public/portal/landing/shared/signup-widget.js` with the web nodes and compatibility; the websites need nothing.

## Follow-up: failures after merging onto production (October 24)

Merged onto `codex/hotfix-20261024u` as `codex/hotfix-20261024v` (`65c1fcca`), some browser tests failed. Fixed on
`claude/acquisition-tracking-flaky-20261024` (from `65c1fcca`):

- `98d2c05b` (the reported failure). The funnel case in `signup-embed-browser.test.mjs` registered `(415) 555-0195`,
  the number the Meta bonus case from `b9f89a1d` uses later in the same file. Merged together, the second signup was
  refused as a duplicate phone and never left the form (`waitForURL` timeout); alone, each passed. The funnel case now
  uses `(415) 555-0196`.
- `3d283459` (the language-suite failures, which also happen on production base `6fefe93c`: 1 of 5 runs there). On
  Windows, `writeFileAtomic` (`platform/storage.ts`) removed a record after a failed rename-over-existing and retried.
  Every request rewrites its session file, so after a signup the onboarding page's requests left windows where the
  session file did not exist; a read in that window failed (`me/localization` 404 "platform record was not found";
  captured) and the organization language, cookie or onboarding checks failed at random. It now retries the rename
  over the existing record (12 tries, up to 100 ms apart) and never removes it. Linux renames atomically and never
  takes this path, so development and production behave as before.
- Not involved: the event limiter (the language suite sent 350 events in 27 batches and never came near it), the
  batching timer and page-hide flush, and the ledger write transaction.

Runs (this machine): each of acquisition-events, signup-widget-auth, referral-cluster, referral-ledger-reconcile,
access-gates, signup-embed-browser and signup-language-browser 3 times in a row, all green (8, 2, 3, 4, 1, 14, 22
pass); the seven together 3 times, 54 of 54 each; `tsc --noEmit` clean. Before the storage fix the language suite
failed in about half of its runs.

Rollout: `output/acquisition-flaky-20261024/` (commit-base `65c1fcca`), `storage.ts` and the embed test three-way
merged onto live `6420a83a`; legacy and web activated and verified on `3d283459` at the first attempt; dev.1m8.ai is
ready and records a two-event batch (200).
