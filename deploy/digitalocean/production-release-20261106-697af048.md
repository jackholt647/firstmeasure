# Production release 697af048: TikTok CompleteRegistration on app-hosted signup pages (FM-352), November 6, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan commit was already a child of
production-live `7bfc543f` (release `0addf376` plus the FM-348 and FM-349 records), so it was released as is:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-352 TikTok tracking pixel registration tracking | `697af048` (`claude/fm-352-tiktok-tracking-pixel-registration-track-prod`) | `697af048` | `platform-20261106222403-09a62ce2` (canonical `6cd411cf`, diff identical) |

## Change

- `public/portal/tiktok-pixel.php` (`fm_tiktok_pixel()`, FM-348) still prints the same base pixel
  (`DBN2ED3C77UF91065S40`). Right after `ttq.page()` it now adds one listener for the shared signup widget's
  `firstmate:auth-success`: when the target is a `[data-firstmate-signup]` widget and `detail.first_login === true` it
  calls `ttq.track('CompleteRegistration')` once per page, inside try/catch, and does nothing when `ttq` is missing.
  Guarded by `window.__firstmateTikTokSignupTracking`. The listener runs while the widget emits the event, before its
  redirect.
- Every portal page and landing variant that prints the include gets it with no page edits. `signup-widget.js` is
  unchanged (production's served copy is byte-identical to the release), so Meta `CompleteRegistration`, GA `sign_up`,
  auth and redirects are untouched. No server-side `CompleteRegistration`.
- `first_login` is true only for `register` (new email account) and Google sign-in that creates an account
  (`public/v1/platform/api.ts`, unchanged).
- Not served: `tests/portal-tracking-pixels.test.mjs` (+4 tests), an `AGENTS.md` note.
- Roles: web serves `/portal/*.php` through its local PHP-FPM; worker and compatibility carry the file unchanged. No
  Node, database, environment, configuration, flag, dependency, nginx or data change.

## Checks before release

- Build on the dev worker (`npm run check` included), 304 s. Archive sha256
  `5ced79bfc4ca540d9bd16fe50f51f30b3ee6bc0191b03042ee367b7c976dabf2`, verified on fm-agents, compatibility, the worker
  and each web node. The archive's `tiktok-pixel.php` and `signup-widget.js` are byte-identical to the commit; the
  release differs from `0addf376` only in the plan's files and the two existing release records.
- New assert in `web_activate.py` (FM-352), beside FM-335 to FM-349 and cad6a00b: `tiktok-pixel.php` holds the listener,
  and each node's own `/portal/landing/variants/{meta-619b, meta-619c, sample}/` HTML holds
  `ttq.load("DBN2ED3C77UF91065S40")`, `firstmate:auth-success` and `track('CompleteRegistration')` exactly once.
- Control: before release all 15 pages below answered 200 with the pixel once and no listener; the plan's harness
  (`google-new` on meta-619b) sent 0 `CompleteRegistration`.

## Rollout (scripts: fm-agents /srv/agents/work/fm-352-prodrun-scripts)

- Rollback target before activation: `0addf3764113ce705ff5603627fdb42c9f21ad87`, every host's `current` at 22:32 UTC;
  recorded on FM-352.
- Signed channel published from compatibility at 22:48 against `05ef116b…` (0addf376's archive).
- Six web nodes one at a time behind the load balancer, 22:49:31–23:02:08 UTC (about 2.1 min each), each asset-checked
  plus every FM assert.
- Worker at 23:00:30 UTC: one `imagery.process` job (started 22:25, heartbeating) ran past the first 5-minute wait, so
  the worker waited up to 30 min for it while web rolled; activated as soon as no job was running. 8 slots,
  production, heartbeat off, outbound email on.
- Compatibility last at 23:02:20 UTC through the gate (`legacy-action` 333/min, load 2.0): 0 Node 500s in the 20 s
  after.

## After activation

- All eight hosts point `current` at `697af048`. Public readiness answered `697af048`, `ok`, on 10 of 10 (five
  instances).
- Through the load balancer, 10 requests each, every one 200 with `ttq.load("DBN2ED3C77UF91065S40")`,
  `firstmate:auth-success` and `track('CompleteRegistration')` exactly once: `/portal/login.php`,
  `/portal/activate.php`, `/portal/landing/`, `/portal/landing/?variant=` customer-referral, representative-referral
  and meta-619a, and `/portal/landing/variants/{email, instantly-signup, landing_template, main-site-page,
  measurements, meta-619a, meta-619b, meta-619c, sample}/`. `/portal/` signed out still 302s to login.
- The plan's headless harness (`fm-352-prodrun-harness/verify.mjs`, answers TikTok/Meta/Google requests itself, creates
  no account) against app.1m8.ai: `google-new` sent 1 `CompleteRegistration` on meta-619b, meta-619c and sample;
  `google-existing` on meta-619b sent 0. No real signup was made on production.
- FM-349 regression through the LB: credentialed preflights from 1m8.ai, www and eu still 204 with credentials; a
  foreign origin and `GET /v1/platform/me` get none (same as after FM-349).
- Web nodes: no `PHP Fatal` in `php8.3-fpm.log` or nginx `error.log`; `/portal/*` 22:49–23:16: 0 5xx of about 1,000.
  5xx from 23:03 (after the compatibility restart) to 23:17 against the 30 minutes before: web 0.03–0.07 % (about
  13,000 requests each) against 0.19–0.27 %; compatibility 0.40 % against 0.60 %. Nearly all are
  `top_view_reroll_proxy.php` (failing before this release).
- Compatibility, 23:02–23:23 (21 min): cluster watchdog **0 kills**, 0 Node 500s, 0 pool timeouts.
- Worker, 23:00:30–23:16: 142 jobs completed (21 `imagery.process`, 88 `pdf.sync`, 15 `report.delivery`, 18
  `report.release`), 0 failed, 0 retried. 341 `report.release` queued, none due (scheduled holds, as before).

## Not covered

- `portal/login.php`'s own registration form (not the widget) still sends only Meta; out of this issue's scope.
- A real TikTok-side confirmation (one new `CompleteRegistration` in TikTok Events Manager after a real ad signup) is
  for a person.

## Rollback

`0addf3764113ce705ff5603627fdb42c9f21ad87` is still installed on every host: activate it on the web nodes one at a time,
the worker and compatibility with `activate-release.sh` (`fm-352-prodrun-scripts/rollback/`), and republish the channel
with 0addf376's archive against `5ced79bf…`. Code only (PHP); the pages just stop sending `CompleteRegistration`.
