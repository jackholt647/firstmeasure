# Production release da4ea82e: TikTok CompleteRegistration from login.php's own signup form (FM-352 follow-up), November 7, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan commit was already a child of
production-live `2d4f3370` (release `5eb8b1db` plus the FM-351 record), so it was released as is:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-352 TikTok tracking pixel registration tracking (follow-up: `portal/login.php`) | `da4ea82e` (`claude/fm-352-tiktok-tracking-pixel-registration-track-prod`, cherry-pick of canonical `7e764633`; `git diff` of both identical) | `da4ea82e` | `platform-20261107004850-0a5c4a24` (canonical `0a5c4a24`) |

## Change

- `public/portal/tiktok-pixel.php`: the base pixel is unchanged. The send moves out of the FM-352 widget listener into
  `window.firstmateTikTokCompleteRegistration()`, with the same once-per-page guard, missing-`ttq` check and try/catch.
  The `firstmate:auth-success` listener calls it with the same rules as before (`[data-firstmate-signup]` target,
  `first_login === true`).
- `public/portal/login.php`: `reportTikTokRegistration(data)` calls that helper only when `data.first_login === true`,
  right after the existing Meta `CompleteRegistration` in the Google success handler, the email register success and
  the (unreachable today) `require_otp` fallback, before the redirect. Login, OTP, forgot password and reset unchanged.
- Not served: `tests/portal-tracking-pixels.test.mjs`, `AGENTS.md`.
- No Node code, environment, database, migration, flag, nginx, dependency or data change. `signup-widget.js` and
  `api.ts` untouched (the archive's `signup-widget.js` is byte-identical to `5eb8b1db`'s).

## Checks before release

- Build on the dev worker (`npm run check` included), 279 s. Archive sha256
  `efa5ade6cbe94b610e7b5049e0f3a5ab992345fb6cb72e1e591b8b68c927ae3b`, verified on fm-agents, compatibility, the worker
  and each web node. The archive's `login.php` and `tiktok-pixel.php` are byte-identical to the commit.
- New assert in `web_activate.py` (FM-352 login.php), beside FM-335 to FM-352 and cad6a00b: `tiktok-pixel.php` holds
  `firstmateTikTokCompleteRegistration` 3 times, `login.php` `reportTikTokRegistration(data);` 3 times and the function
  once; each node's own served `/portal/login.php` holds `firstmateTikTokCompleteRegistration` 4 times,
  `reportTikTokRegistration(data);` 3 times and `ttq.load("DBN2ED3C77UF91065S40")`, `firstmate:auth-success` and
  `track('CompleteRegistration')` once each; served meta-619b, meta-619c and sample hold the helper twice. Strings
  checked against the archive's files before installing.
- Control before release, through the load balancer: login.php and the 14 other portal / landing pages 200 with the
  pixel, listener and event once and neither helper string. The plan's login.php harness (`google-new`, real handler,
  tracking requests answered locally) sent TikTok CompleteRegistration 0 times on production.

## Rollout (scripts: fm-agents /srv/agents/work/fm-352b-prodrun-scripts)

- Rollback target before activation: `5eb8b1db729c98125a2670130f59570317f944d1`, every host's `current` at 00:55 UTC;
  recorded on FM-352.
- Signed channel published from compatibility against `d1abe249…` (5eb8b1db's archive).
- Six web nodes one at a time behind the load balancer, 01:06:38–01:19:54 UTC (about 2.2 min each), each asset-checked
  plus every FM assert.
- Worker at 01:08:46 UTC (no job running), in parallel with the web rollout: 8 slots, production, heartbeat off,
  outbound email on.
- Compatibility last at 01:25:22 UTC through the gate: it waited 4 min at 424–823 `legacy-action`/min and opened at
  263/min, load 2.3. 0 Node 500s and 0 HTTP worker exits in the 20 s after.

## After activation

- All eight hosts point `current` at `da4ea82e`. Public readiness answered `da4ea82e`, `ok`, on 10 of 10 (four
  instances), twice.
- Through the load balancer, 10 requests each, all 200: `/portal/login.php` `200:1:1:1:4:3` (pixel, listener, event,
  helper, login.php calls); `activate.php`, `/portal/landing/` (and `?variant=` customer-referral,
  representative-referral, meta-619a), variants email, instantly-signup, landing_template, main-site-page, measurements,
  meta-619a, meta-619b, meta-619c and sample `200:1:1:1:2:0`. `/portal/` signed out still 302s to login. FM-349's
  credentialed preflights unchanged from the previous release.
- Browser harnesses (headless, no account created, TikTok / Meta / Google requests answered locally):
  login.php `google-new` sent **1** TikTok CompleteRegistration plus Meta's `fbq('track','CompleteRegistration')`
  (0 before this release); `google-existing` 0 and no Meta call. Widget pages: meta-619b `google-new` 1,
  `google-existing` 0, meta-619c `google-new` 1, sample `google-new` 1.
- Web nodes from 01:20 (after the web rollout): 5xx 0–0.03 % against 0.02–0.04 % in the 30 min before (nearly all
  `top_view_reroll_proxy.php`, failing before this release), no `PHP Fatal`, 0 `/portal/*` 5xx since 01:06.
- 5xx from 01:27 (after the compatibility restart) to 01:38: web 0.02–0.08 % (about 8,300–8,800 requests each),
  compatibility 0.44 % (26 of 5,930, all `top_view_reroll_proxy.php`, failing before this release; FM-351's record
  shows 0.42–0.57 %).
- Compatibility, 01:25:22–01:45 (20 min, at 170–690 `legacy-action`/min): cluster watchdog **0 kills**, 0 Node 500s,
  0 pool timeouts.
- Worker, 01:08:46–01:38: 151 jobs completed (27 `imagery.process`, 87 `pdf.sync`, 23 `report.delivery`, 14
  `report.release`). One `pdf.sync` failed at 01:31:28 with "Shared PDF runtime failed: page.evaluate: Target page,
  context or browser has been closed", the intermittent error seen 1–2 times an hour on 11/05–06 (and once at 01:08:40
  on the old release, just before the worker activated); this release changes no code the worker or PDF runtime loads.
  245 `report.release` queued, none due (scheduled holds, as before).

## Not covered

- No real signup was made on production. Confirming one new CompleteRegistration in TikTok Events Manager after a real
  signup on `/portal/login.php` (email or Google) is for a person.

## Rollback

`5eb8b1db729c98125a2670130f59570317f944d1` is still installed on every host: activate it on the web nodes one at a time,
the worker and compatibility with `activate-release.sh` (`fm-352b-prodrun-scripts/rollback/`), and republish the channel
with 5eb8b1db's archive against `efa5ade6…`. Code only: PHP pages, no stored state.
