# Production release 0addf376: credentialed CORS again for the websites' embedded signup form (FM-349), November 6, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan commit was already a child of release
`74655f32` (FM-348), which every host ran, so it was released as is:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-349 Landing page signup form broken | `0addf376` (`claude/fm-349-landing-page-signup-form-broken-prod`) | `0addf376` | `platform-20261106200349-8b098a30` (canonical `49519e6e`, diff identical) |

## Change

- `public/v1/platform/security/browser.ts`: the signup embed origins (`SIGNUP_EMBED_ORIGINS`, unset on production, so
  the default `https://1m8.ai`, `https://www.1m8.ai`, `https://eu.1m8.ai`) get `Access-Control-Allow-Credentials: true`,
  and pass the cross-site-write check with a session cookie, only on `/v1/platform/auth/*` and
  `/v1/platform/acquisition/event`. Every other route still gives credentials to our own origin only. Since the Nov 3
  release (request security, `2cd0f568`) the website form's `credentials: 'include'` calls failed their preflight and
  showed "Connection error"; the cause and impact are in FM-349's postmortem comment.
- Not served: `tests/route-access.test.ts`, `docs/architecture/request-security.md`.
- Roles: web serves `/v1/platform/*` (Node restarted by activation); worker and compatibility carry the same code. No
  PHP, widget, database, environment, configuration, flag, nginx or data change.

## Checks before release

- Build on the dev worker (`npm run check` included), 277 s. Archive sha256
  `05ef116bee1a422b708bd4931265b477aca4f0cb700cd79d481b5bd2ea4c819f`, verified on fm-agents, compatibility, the worker
  and each web node. Every assert in `web_activate.py` (FM-335 to FM-348, cad6a00b) plus the new FM-349 one
  (`isCredentialedOrigin`, `isSignupEmbedRoute` and the acquisition route in `dist/platform/security/browser.js`) passes
  on the extracted archive. `web_activate.py` also sends each node, once active, local preflights to legacy-action,
  login and acquisition/event from the three website origins (204, origin echoed, credentials `true`) and from
  `https://evil.example` and to `/v1/platform/me` from 1m8.ai (no credentials).
- Control on 74655f32: a node's local preflight from 1m8.ai had no `Access-Control-Allow-Credentials`; headless
  Chromium on the real `https://1m8.ai/landing/meta-619a/` logged 8 CORS errors (`auth/signup-options`,
  `auth/google/config`, `auth/signup-catalogs`, `auth/legacy-action`, four `acquisition/event`).

## Rollout (scripts: fm-agents /srv/agents/work/fm-349-prodrun-scripts)

- Rollback target before activation: `74655f32db03d9b6a4971d4da302448dab2ba29c`, every host's `current` at 20:24 UTC;
  recorded on FM-349.
- Worker at 20:33:06 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `4a6ee816…` (74655f32's archive).
- Six web nodes one at a time behind the load balancer, 20:34:10–20:46:53 UTC (about 2.1 min each), each with every
  assert and the local preflight check.
- Compatibility last at 21:36:39 UTC through the gate (`legacy-action` 386/min, load 1.6), after 48 minutes at
  430–830/min. 0 Node 500s and 0 worker exits in the 20 s after.

## After activation

- All eight hosts point `current` at `0addf376`. Public readiness answered `0addf376`, `ok`, on 10 of 10 (after the web
  rollout and again after compatibility).
- Through the load balancer, 10 requests each: preflights to `/v1/platform/auth/legacy-action`, `/v1/platform/auth/login`
  and `/v1/platform/acquisition/event` from `https://1m8.ai`, `https://www.1m8.ai` and `https://eu.1m8.ai` all 204 with
  the origin echoed and `access-control-allow-credentials: true`; from `https://evil.example` no credentials header;
  `GET /v1/platform/me` from 1m8.ai 401 with no credentials header. `/portal/login.php` 200 (10/10), `/portal/` signed
  out 302 to login.
- Headless Chromium on the real `https://1m8.ai/landing/meta-619a/` (trackers blocked, no signup submitted): the form
  renders, `auth/signup-options`, `google/config`, `signup-catalogs`, `phone-examples` 200 and every `acquisition/event`
  200, all with credentials. A login with a nonexistent `@example.test` address got `legacy-action` 404 `not_found` and
  the form showed "We couldn't find an account with that email or phone number." instead of "Connection error". The one
  CORS error left is the static `/libraries/platform-language/catalogs/manifest.json`, which the widget falls back from
  by design (same on dev).
- Real visitors: website-referred (`https://1m8.ai/`) `legacy-action` POSTs returned 200 at 21:22, 21:23 (2) and
  21:32 UTC, the first since Nov 3; 64 website `acquisition/event` POSTs 200 between 20:34 and 21:33.
- Web nodes 20:47–21:33: 0 `cross_site_request` refusals in the Node journal; no 403 on the auth routes. 5xx
  0.04–0.09 % (about 52,000–54,000 requests each) against 0.03–0.07 % in the 30 minutes before, nearly all
  `top_view_reroll_proxy.php` (failing before this release) and a few `/v1/internal/legacy-action`; `acquisition/event`
  500s at 0–3 per node, the same rate as before the release.
- Compatibility, 21:36:39–21:57 (20 min): cluster watchdog **0 kills**, 0 Node 500s, 0 pool timeouts, at 319–419/min
  `legacy-action` and load 1.0–4.0. On 74655f32 in the 68 minutes before (from 20:01:30): 4 kills, 25 Node 500s, 25
  pool timeouts.
- Worker, 20:33:06–21:50: 696 jobs completed (126 `imagery.process`, 413 `pdf.sync`, 95 `report.delivery`, 62
  `report.release`), 0 failed. 304 `report.release` queued, none due (scheduled holds, as before).

## Rollback

`74655f32db03d9b6a4971d4da302448dab2ba29c` is still installed on every host: activate it on the web nodes one at a time,
the worker and compatibility with `activate-release.sh` (`fm-349-prodrun-scripts/rollback/`), and republish the channel
with 74655f32's archive against `05ef116b…`. Node code only; the websites' embedded signup goes back to failing its
preflight.
