# Production release eac399d9: signup-funnel tracking events recorded again, October 25, 2026 (04:00 UTC)

Released under Jack's standing approval. He started the "Fix dropped acquisition tracking events" session himself.

This release is production `6fefe93c` plus:

- `claude/acquisition-tracking-20261024` (`f4c2eafa`);
- the follow-up `claude/acquisition-tracking-flaky-20261024` (`98d2c05b`, `3d283459`).

## Cause

The production referral database still had the retired PHP module's unique index, `idx_referral_events_unique`, on (campaign, email, organization, event type). Visitors are anonymous, so after the first row per campaign and type every insert failed.

- On compatibility, `trackAcquisitionEvent` returned 500 about 40 times a minute, roughly 46,000 since Oct 20.
- The web node proxy turned each of those 500s into a 503 on `/v1/platform/acquisition/event`.
- Since tracking began on 2026-06-17, the database kept only the first event of each type per campaign.
- Landing visits, completed signups, attribution and bonus offers were not affected.

## Fix

- **Index:** the unique index is replaced by an ordinary one, applied on first open (222 rows).
- **Single rows:** events kept as one row are written in one locked step.
- **Input errors:** invalid input returns 400 `invalid_acquisition_event`, and web passes 4xx through instead of turning it into 503.
- **Batching:** the signup widget sends batches of up to 25 events every 2 s, flushes on pagehide, and sends submits and results immediately.
- **Rate limit:** 300 events a minute per address per web node, with 429 and `Retry-After` beyond that.
- **Windows test fix:** `writeFileAtomic` retries a contended rename over the existing record instead of deleting it first. This is a Windows-only path; Linux behaviour is unchanged.

## Checks

- `tsc` passes.
- These seven suites passed 54 of 54, three times in a row: acquisition-events, signup-widget-auth, referral-cluster, referral-ledger-reconcile, access-gates, signup-embed-browser and signup-language-browser.
- The earlier intermittent failures were a duplicate test phone number and the Windows rename race.
- The bonus fix is still present in the widget.

**Build:** archive `13f47378…`, verified.

## Rollout

Compatibility went first, at 04:00:43 UTC, as the web route needs the new batch operation:

- compatibility logged 0 errors and 0 crashes in the next 20 s;
- the worker was activated;
- the channel was published against `f1267322…`;
- the six web nodes were activated;
- readiness returned `eac399d9` 10 out of 10 times.

## Effect

Compatibility, `trackAcquisitionEvent`:

| Window | Requests | Result |
| --- | --- | --- |
| 90 minutes before | 364 | all 500 |
| After the release | 4 | all 200 |

## Recovery

Web node 64.23.240.81 kept 1,910 events from Sept 8–9 in its local database. The existing recovery tool could merge them. That was not done; it needs Jack's call.

## Rollback

Roll back to `6fefe93c` by republishing `f1267322…`. The old code would fail inserts again: the unique index is dropped, but that is harmless.
