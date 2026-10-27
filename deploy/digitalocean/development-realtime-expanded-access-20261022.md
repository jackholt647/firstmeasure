# Refused platform event stream on every portal page (2026-10-22)

Found while investigating 1M8-231. Production web nodes refuse
`GET /v1/platform/organizations/:org/events/stream?watch=presence%3Aonline`
with 403 (142-byte `capability_denied` for `platform.expanded_access`) hundreds
of thousands of times a day.

## Cause

`public/libraries/platform-realtime/platform-realtime.js` starts account
presence at load (`startPresence(APP.userOrgId)`), which watches the
`presence:online` channel on the organization's one stream. No production
organization has expanded access, so the server refuses the stream; with only
a channel watched, the client retries every 3 s (`CHANNEL_RETRY_MS`), so every
open portal tab makes about 1,200 refused requests an hour.

Read-only production evidence, web node 64.23.240.81, 2026-10-22 00:00–20:42
UTC: about 473,000 refused stream requests (11–39k an hour, following
daytime use); 124,604 403s in the last 400,000 log lines, against 33 401s and
no 200s.

## Fix

Commit `4333a843` (on `claude/realtime-stream-expanded-access`, cut from the
hotfix line `9398c0ad`): `connect()` opens nothing, stream or poll fallback,
unless the page has expanded access, using the same check as
`Portal.platformExpandedAccess()` (falling back to `APP.platformExpandedAssets`
before core.js loads; a page that does not set the flag keeps its stream). A
`fm:capabilities:updated` that grants access connects what the page already
wants. Still one stream per page.

Test: `tests/platform-realtime-client.test.mjs` adds a case that fails on
`9398c0ad` and passes on `4333a843`; `tests/view-presence-client.test.mjs`,
`tests/dashboard-afk-presence.test.mjs` and `tests/realtime-single-stream.test.ts`
pass.

## Dev

Rolled to web, pool and legacy with `output/realtime-gate-expanded/` (3-way
merge of `9398c0ad..4333a843` onto the live `7579af54` files, no drift; worker
untouched, it serves no browser files). Activated about 20:47 UTC; verify exit
0, `/v1/health/ready` reports `4333a843`, the served script carries the gate.

Refused stream requests on dev (web + pool nginx, per 10 minutes):

| UTC | 19:00–20:30 | 20:40 | 20:50 | 21:00–21:04 |
| --- | --- | --- | --- | --- |
| 403 | 145–245 | 52 | 19 (tabs on the old script) | 0 |

Expanded-access organizations still connect (200s continue). Not clicked
through as a signed-in user on dev.
