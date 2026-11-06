# Production release 74655f32: TikTok Pixel on every customer portal page and landing page (FM-348), November 6, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan commit was already a child of
production-live `c608e59e` (release `f80e12ce` plus the FM-347 record), so it was released as is:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-348 Tiktok tracking | `74655f32` (`claude/fm-348-tiktok-tracking-prod`) | `74655f32` | `platform-20261106192149-1b73cce4` (canonical `62a75ab1`, diff identical) |

## Change

- New `public/portal/tiktok-pixel.php` defines `fm_tiktok_pixel()`, which returns the TikTok Pixel snippet from the
  issue (pixel `DBN2ED3C77UF91065S40`). Requested directly it prints nothing.
- Pages that require it and print it once in `<head>`: portal `index.php`, `login.php` (also `login_disabled.php`),
  `activate.php`, `mobile/index.php`; landing variants email, instantly-signup, landing_template, main-site-page,
  measurements (also customer-referral and representative-referral), meta-619a, meta-619b, meta-619c and sample.
- Not served: `tests/portal-tracking-pixels.test.mjs`, the platform lane test map, an `AGENTS.md` note.
- Roles: web serves `/portal/*.php` through its local PHP-FPM (restarted by `activate-release.sh`, so opcache can't keep
  the old pages); worker and compatibility carry the files unchanged. No Node, database, environment, configuration,
  flag, dependency, nginx or data change. Production sends no CSP on `/portal/*`.

## Checks before release

- Build on the dev worker (`npm run check` included), 295 s. Archive sha256
  `4a6ee816e8bf05d0e539f44281fa48a3fa0631760dbe6bac8296b08b665b8618`, verified on fm-agents, compatibility, the worker
  and each web node. The archive's `public/portal` is byte-identical to the commit and every PHP file in it passes
  `php -l`. Every assert in `web_activate.py` (FM-335 to FM-347, cad6a00b, plus the new FM-348 one: the pixel id once in
  `tiktok-pixel.php` and `<?= fm_tiktok_pixel() ?>` once in login, index, activate, mobile and the measurements variant)
  passes on the extracted archive.
- Control: before release all 15 pages below answered 200 with no `ttq.load("DBN2ED3C77UF91065S40")`.

## Rollout (scripts: fm-agents /srv/agents/work/fm-348-prodrun-scripts)

- Rollback target before activation: `f80e12cefbc2826e9e8a42bbe4a9aa21e8d89f1b`, every host's `current` at 19:26 UTC;
  recorded on FM-348.
- Worker at 19:36:15 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `2749fc6b…` (f80e12ce's archive).
- Six web nodes one at a time behind the load balancer, 19:37:15–19:51:21 UTC (about 2.3 min each), each asset-checked
  plus every FM assert.
- Compatibility last at 20:01:04 UTC through the gate (`legacy-action` 377/min, load 9.8). The restart cost 14 Node
  500s ("Fastify has already been closed") in 20:01:04–07 from the closing processes; none in the 20 s after.

## After activation

- All eight hosts point `current` at `74655f32`. Public readiness answered `74655f32`, `ok`, on 10 of 10 (five
  instances).
- Through the load balancer, 10 requests each, every one 200 with `ttq.load("DBN2ED3C77UF91065S40")` exactly once:
  `/portal/login.php`, `/portal/activate.php`, `/portal/landing/`, `/portal/landing/?variant=` customer-referral,
  representative-referral and meta-619a, and `/portal/landing/variants/{email, instantly-signup, landing_template,
  main-site-page, measurements, meta-619a, meta-619b, meta-619c, sample}/`. `/portal/` signed out still 302s to login.
- Headless Chromium on `/portal/login.php`, `/portal/landing/` and `/portal/landing/?variant=meta-619a`: each requests
  `analytics.tiktok.com/i18n/pixel/events.js?sdkid=DBN2ED3C77UF91065S40`, sends `api/v2/pixel` page views, and
  `window.ttq` has the pixel instance.
- Web nodes: no `PHP Fatal` in `php8.3-fpm.log` or nginx `error.log`. `/portal/*` 19:37–20:22: 0 5xx of about 2,600
  requests. 5xx from 20:02 (after the compatibility restart) to 20:22 against the 30 minutes before: web 0.04–0.07 %
  (about 23,000–24,000 requests each) against 0.33–0.51 %; compatibility 0.46 % against 1.07 %. Nearly all after are
  `top_view_reroll_proxy.php` (failing before this release).
- Compatibility, 20:01–20:20 (19 min): cluster watchdog **0 kills**; 3 Node 500s after the restart (2 pool timeouts,
  one `completeAcquisitionSignup` "Premature close"), against 25–37 pool timeouts an hour at 16:00–18:00 today.
- Worker, 19:36:15–20:22: 628 jobs completed (60 `imagery.process`, 407 `pdf.sync`, 112 `report.delivery`, 49
  `report.release`), 0 failed. 279 `report.release` queued, none due (scheduled holds, as before).

## Rollback

`f80e12cefbc2826e9e8a42bbe4a9aa21e8d89f1b` is still installed on every host: activate it on the web nodes one at a time,
the worker and compatibility with `activate-release.sh` (`fm-348-prodrun-scripts/rollback/`), and republish the channel
with f80e12ce's archive against `4a6ee816…`. Code only (PHP); the pages just lose the pixel again.
