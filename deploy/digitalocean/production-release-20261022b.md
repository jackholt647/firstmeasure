# Production release f7fd3fc8, October 22, 2026

Jack authorized the release on the condition that tests show no new failures.
Branch `codex/release-20261022b`: production `9398c0ad` plus the October 22
release candidate, the 1M8-231 replay test, and the event-stream fix (with its
cache key bumped). The October 21 exteriors editor work is left out.

## Contents

| Area | Linear |
| --- | --- |
| Billing | 198, 200, 218 |
| Accounts | 201, 203, 204, 207, 209, 212, 213, 221, 223, 227 |
| Europe signup and pricing | 214–217, 219, 220 |
| Country of record | 228 |
| Editor | 191 (K toggles pitch labels), 226 (paste duplicates) |
| Event stream | pages without expanded access open no platform event stream |

## Tests (dev worker, Linux)

**Server tests:** 1,699 run, 1,546 pass, 115 fail.

- Against production `9398c0ad`, run the same day, the only file failing for
  the release alone is `documents-api`.
- Against `8c908166`, it is `access-gates`.
- Run alone, both files fail identically on production's code, so neither is
  new.
- `access-gates` lists this release's new routes: the commercial-profile price
  admin (checked by `requirePricingAdmin` in its handler), the country rules
  admin, signup options, and exterior measurements.

**Browser tests:** the extra failures are new tests that need Chrome. The build
server has none; they pass on Windows with Chrome.

## Rollout (UTC)

| Time | Role | Result |
| --- | --- | --- |
| 22:26 | Compatibility | Activated in 9 s. 0 errors and 0 crashes in the next 20 s. |
| 22:27 | Worker | Waited for 0 running jobs, then activated in 1 s. Settings unchanged. |
| 22:28–22:38 | Signed channel and six web nodes | Channel published against `7e8593d1…` (`9398c0ad`). Each node drained and activated in about 94 s, and passed readiness, the asset match and the sandbox 404. |

Public readiness returned `f7fd3fc8` 10 out of 10 times.

**Since 22:37:** median responses of 9 ms on compatibility and 41–44 ms on the
web nodes, no HTTP 500s, and 2 requests over 5 s out of about 13,000.

## Organization country backfill (1M8-228)

The backfill ran on the worker by calling the compiled
`backfillOrganizationCountries`. The production build does not ship the tsx
script.

| Run | Result |
| --- | --- |
| Dry run | 11,914 organizations, 1 already set |
| Write (22:39–22:41, about 92 s) | 11,913 stored, with 0 pool waits |
| Second dry run | 0 left |

What was stored:

- US: 6,318 from orders, 5,292 as the `legacy_default`, 251 detected at signup.
- 21 Canada from orders; 1 Peru and 1 France from orders.
- Detected at signup: 27 Russia (probably spam signups), 1 UK, 1 Mexico.

Billing profiles and prices are unchanged.

## Rollback

Every role keeps its previous release: compatibility and web `9398c0ad`, and the
worker `8c908166`. Republish `9398c0ad` (`7e8593d1…`) to the channel before
rolling back a web node. The stored countries need no rollback: they are
additive, and older releases ignore them.
