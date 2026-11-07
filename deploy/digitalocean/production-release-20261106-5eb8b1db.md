# Production release 5eb8b1db: server-side TikTok Purchase for paid credit checkouts (FM-351), November 6, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan commit was already a child of
production-live `abb209f4` (release `697af048` plus the FM-352 record), so it was released as is:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-351 Set up TikTok Events API | `5eb8b1db` (`claude/fm-351-set-up-tiktok-events-api-prod`: `0f63e55e` cherry-pick of canonical `29671644`, merged with production-live `abb209f4`) | `5eb8b1db` | `platform-20261106223017-84389904` (canonical `84389904`; `abb209f4..5eb8b1db` equals canonical `09a62ce2..29671644` file for file) |

## Change

- `public/v1/platform/tiktok-events.ts` (new): the TikTok Events API 2.0 `Purchase`
  (`POST https://business-api.tiktok.com/open_api/v1.3/event/track/`, pixel `DBN2ED3C77UF91065S40`,
  `event_id: stripe_purchase:<checkout session id>`, the same id Meta's purchase uses), hashed email / phone /
  `external_id`, `ttclid`, `ttp`, customer IP and user agent when known. Kept in the internal `tiktok_events_outbox` /
  `tiktok_events_log` collections (created on first write), delivered asynchronously with 4 bounded retries; TikTok's
  body `code` is checked, not only the HTTP status.
- `public/v1/platform/api.ts`: checkout writes `ttclid`, `ttp`, `client_ip`, `client_user_agent` into the Stripe session
  metadata; `stripeFulfillFromSession` queues the Purchase after the credit is committed (same point and rule as the Meta
  Conversions API purchase, which is unchanged) and records `tiktok_events` on the fulfilled session. Spending credit
  sends nothing. The outbox drain timer starts only when a token is set. Signup attribution keeps `ttclid` / `_ttp`.
- `public/v1/src/config/env.ts`: `TIKTOK_PIXEL_ID` (default `DBN2ED3C77UF91065S40`), `TIKTOK_EVENTS_ACCESS_TOKEN`,
  `TIKTOK_EVENTS_TEST_EVENT_CODE`, all optional. `acquisition_event_limits.ts` exports `isPrivateAddress`;
  `internal/crm/referrals.ts` attribution fields include `ttclid`, `_ttp`.
- `public/portal/login.php` and `public/portal/landing/shared/signup-widget.js`: an ad's `?ttclid=` is kept in a 30-day
  first-party `fm_ttclid` cookie (the widget only on the app's own origin), and `ttclid` / `_ttp` go with signup
  attribution.
- Not served: tests, `AGENTS.md`, `deploy/digitalocean/*development*`.
- **No environment change.** Production has no `TIKTOK_*` setting, so every paid checkout records
  `tiktok_events: {status: "skipped", reason: "missing_access_token"}` and nothing is sent to TikTok until the access
  token is added to production's environment (a separate change that needs Jack's OK; FM-351 asks for it).
  `TIKTOK_EVENTS_TEST_EVENT_CODE` must never be set on production. No database, migration, flag, nginx, dependency or
  data change.

## Checks before release

- Build on the dev worker (`npm run check` included), 291 s. Archive sha256
  `d1abe249e20e0ba11d21066587d96076755055e8665c9556f78dc9a2811e4392`, verified on fm-agents, compatibility, the worker
  and each web node. The archive's `login.php`, `signup-widget.js` and `tiktok-pixel.php` are byte-identical to the
  commit; `dist/platform/tiktok-events.js` holds the Events API URL and `dist/platform/api.js` calls
  `enqueueTiktokPurchase`, `tiktokCheckoutAttribution` and `startTiktokEventsOutbox`.
- New assert in `web_activate.py` (FM-351), beside FM-335 to FM-352 and cad6a00b: the build markers above, each
  `fm_ttclid=` once in `login.php` and `signup-widget.js`, each node's own served `/portal/login.php` and
  `signup-widget.js` carrying them, and **no `TIKTOK_EVENTS_TEST_EVENT_CODE` in the web process environment**.
- Control before release, through the load balancer: `/portal/login.php`, `/portal/landing/`,
  `?variant=meta-619a` and `variants/meta-619b/` 200 with no `fm_ttclid`; `signup-widget.js` without it; Stripe's
  public negative-signature probe (`POST /measure/internal/server.php`, bogus `Stripe-Signature`) HTTP 400
  `Invalid signature`.

## Rollout (scripts: fm-agents /srv/agents/work/fm-351-prodrun-scripts)

- Rollback target before activation: `697af0484ff01cb06bb876a6235020a6e76dae1a`, every host's `current` at 23:26 UTC;
  recorded on FM-351.
- Worker at 23:36:12 UTC (no job running): 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `5ced79bf…` (697af048's archive).
- Six web nodes one at a time behind the load balancer, 23:37:14–23:50:32 UTC (about 2.2 min each), each asset-checked
  plus every FM assert; each reported `tiktok_token_set: false`.
- Compatibility last at 00:22:55 UTC (November 7) through the gate: it waited 32 min at 500–1,450 `legacy-action`/min
  and opened at 246/min, load 3.1. The 18 Node 500s in the 20 s after were all in the restart second ("Fastify has
  already been closed", the old processes closing); none since. No `TIKTOK_*` in its process environment.

## After activation

- All eight hosts point `current` at `5eb8b1db`. Public readiness answered `5eb8b1db`, `ok`, on 10 of 10 (four
  instances).
- Through the load balancer, 10 requests each, all 200: `/portal/login.php` holds `fm_ttclid=` and the
  `'ttclid', '_ttp'` attribution field once (and FM-352's `track('CompleteRegistration')`); `/portal/landing/`,
  `?variant=meta-619a` and `variants/meta-619b/` unchanged with `CompleteRegistration` once; served
  `signup-widget.js` holds both. `/portal/` signed out still 302s to login. Stripe's negative-signature probe still HTTP
  400 `Invalid signature`.
- Web nodes: no `tiktok_events_*` lines at all (no token), no `stripe_checkout_payment_review`, no Stripe errors, no
  `PHP Fatal`. Node error-level lines are client disconnects ("premature close") at the rate before the release.
- 5xx from 00:24 (after the compatibility restart) to 00:36: web 0.01–0.05 % (about 11,500–12,200 requests each),
  compatibility 0.42 % against 0.44–0.57 % before; nearly all `top_view_reroll_proxy.php` (failing before this
  release).
- Compatibility, 00:22:55–00:44:50 (22 min, at 420–1,060 `legacy-action`/min): cluster watchdog **0 kills**, no Node
  500 after the restart second, 0 pool timeouts.
- Worker, 23:36:12–00:36: 314 jobs completed (42 `imagery.process`, 165 `pdf.sync`, 43 `report.delivery`, 64
  `report.release`), 0 failed. 297 `report.release` queued, none due (scheduled holds, as before). No error-level or
  TikTok lines in its journal.

## Not covered

- No real payment was made on production (no test charges). The first real paid checkout's fulfilled record should
  show `tiktok_events: {status: "skipped", reason: "missing_access_token"}` with `meta_capi` unchanged.
- Sending to TikTok starts only when `TIKTOK_EVENTS_ACCESS_TOKEN` is added to production's environment
  (`/etc/firstmeasure/production-cutover.env` on compatibility and each web node's copy, then a rolling restart). That
  needs Jack's OK and a rotated token; it is not part of this release.
- Auto top-ups (off-session charges) and platform subscriptions are not sent, as with Meta.

## Rollback

`697af0484ff01cb06bb876a6235020a6e76dae1a` is still installed on every host: activate it on the web nodes one at a time,
the worker and compatibility with `activate-release.sh` (`fm-351-prodrun-scripts/rollback/`), and republish the channel
with 697af048's archive against `d1abe249…`. Code only: the old code ignores the internal TikTok collections and the
extra Stripe metadata keys.
