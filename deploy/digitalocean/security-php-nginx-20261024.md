# Request security, PHP and nginx half — October 24, 2026

Branch `claude/request-security-php`. Code only: nothing was deployed, and no
production or development host was touched. This is the PHP and nginx side of
[request security](../../docs/architecture/request-security.md), written after
the 2026-10-24 audit found `/v1/firstmeasure`, `/v1/internal` and
`/v1/communications` answering anonymously, with identity taken from
`X-Internal-User-*` headers. The Node half (principals, route gates, signed
PHP requests, `/v1/internal/impersonation`) is a separate branch.

**Release order: Node first, then this PHP.** Without that release, PHP's
calls to Node carry no identity Node accepts, and the staff console stops
working. Then change the nginx configurations below, one role at a time.

## What changed in PHP

New shared files:

- `public/includes/node_api.php`: the PHP-to-Node client. The base URL comes
  only from configuration (`FIRSTMEASURE_API_BASE`, else
  `FIRSTMEASURE_NODE_BASE_URL`); unset means a logged error and a 503-style
  refusal. The only exception is a loopback default (`127.0.0.1:3111`/`:3101`)
  when the request is to `127.0.0.1`/`localhost` *and* arrives from loopback
  or the built-in PHP server, so a forged `Host: localhost` on a public host
  gets nothing. TLS is verified (`VERIFYPEER` true, `VERIFYHOST` 2),
  redirects are never followed, the curl proxy is off. Signing implements
  `public/v1/platform/security/service.ts` exactly:
  `hex(HMAC-SHA256(secret, "v1\nMETHOD\npath?query\ntime\nactor\nsha256(body)"))`
  with `X-FM-Service-Time`, `-Actor`, `-Body-Sha256`, `-Signature`; multipart
  bodies use `UNSIGNED-PAYLOAD`; a streamed body (`full_house.php`) is hashed
  from `php://input` first.
- `public/includes/web_security.php`: `fm_session_start_secure()` (HttpOnly,
  `SameSite=Lax`, `Secure` over HTTPS, `use_strict_mode`, cookie-only ids),
  per-session CSRF tokens, `fm_safe_redirect_path()`, the uploaded-file type
  allowlist and serving headers.
- `public/includes/safe_fetch.php`: fetching a URL a person supplied.
- `public/measure/internal/_staff_session.php`: the staff gate.

Identity:

- **Staff mark.** A PHP session is staff only when `$_SESSION['fm_staff']`
  names the same email as `user_email`. It is set only after Node confirmed
  the platform session: `GET {api}/internal/me` with the browser's platform
  cookie, then `GET {api}/internal/users/{email}` with the same cookie (Node
  serves staff records only to staff), and the record passes the unchanged
  `backendUserCanAccessInternal` rule. A customer's portal login (which
  `portal/session_bootstrap.php` copies into the shared PHP session with
  `platform_node_auth`) never satisfies it, and any change of `user_email`
  voids it. The gate re-verifies every 10 minutes; if Node cannot answer then,
  the page fails with 503 rather than trusting the old mark. A staff member
  who still has a platform session but no mark (everyone, right after this
  release) is verified silently on the first page load: no new sign-in.
- **Gated entry points:** `index.php`, `editor.php` (every action, including
  `project_bundle` and `project_feedback`), `data_agent.php`, `full_house.php`,
  `project_resources.php`, `top_view_reroll_proxy.php`, `tutorial_audit.php`,
  `tutorial_sources.php`, `exterior_ai.php`, `apple_endpoint.php` (staff full
  admin, verified live with Node on every request) and `backend_login.php`.
- **Signing.** Every PHP-to-Node call made for the signed-in staff member is
  signed with actor = their verified email (`fm_api_request`,
  `portalNodeInternalRequest`, the editor bundle stream, the full-house proxy,
  resources, the tutorial bridge, user lookups). Calls PHP makes on its own are
  signed `system`: credit refunds computed after a review decision
  (`portalRefundCreditsByOrganizationId`) and reading `server-config` for the
  top-view model key. Browser-context proxies forward the platform session
  cookie instead (session checks, `/internal/me`, impersonation,
  `stripe_create_checkout.php`, the Stripe billing actions in `server.php`).
  Only the platform session and CSRF cookies are forwarded, never PHP's. For a
  forwarded write, the browser's own `Origin` (or `Referer`) and
  `X-Platform-CSRF` go with it, so Node's cross-site check applies as if the
  browser had called it.
- **No `X-Internal-User-*`** header is sent anywhere. Body `actor` fields are
  still sent where handlers use them for attribution (Node overwrites them).
  `server.php` no longer prefers `actor_email`/`actor_org_id` from the body: it
  uses the session, and a `return_base_url` from the body is kept only when it
  is on this site. The `x-full-house-*` and `x-tutorial-*` receipts are still
  sent beside the new signature for one release; full-house signs only for a
  verified staff session now.
- **Impersonation** (`backend_login.php`) no longer switches identity in PHP
  alone. Start: CSRF token, verified admin, `POST {api}/internal/impersonation`
  `{target_email}` with the admin's cookie, then `/internal/me` must answer as
  the target (otherwise PHP sends `DELETE` and refuses). Only then is the PHP
  session set to the target (as before, so the console renders as them) with
  the admin kept in `impersonating_from_email`. Stop: CSRF token,
  `DELETE {api}/internal/impersonation`, then re-verify as the admin. The
  token is `PORTAL_CFG.csrf_token` on the console page, sent by `users.js` as
  `X-CSRF-Token`. Sign-out (`backend_logout.php`) also stops an impersonation.
- Session ids are regenerated whenever the PHP session's identity changes:
  staff verification, impersonation start and stop, and the portal's
  hydration from the platform session (portal login).

Other fixes:

- `portal/image_proxy.php` fetches through `safe_fetch.php`: http/https on
  ports 80 and 443, no credentials in URLs, numeric host shorthands refused,
  every resolved address must be public (private, loopback, link-local,
  metadata, CGNAT, multicast, reserved and documentation ranges; IPv6 outside
  2000::/3, Teredo, 6to4, NAT64 and IPv4-mapped included), the connection is
  pinned with `CURLOPT_RESOLVE` and its peer address re-checked, redirects are
  followed by hand (at most 3, each re-checked), 2 MB / 512 KB limits,
  `image/*` responses only for `fetch_image` and bytes that are not an image
  are refused (they used to be relabelled `image/png`).
- `apple_endpoint.php` drops `Access-Control-Allow-Origin: *`, needs a staff
  full admin for both reading and writing, and refuses cross-origin writes.
- `server.php` drops its wildcard CORS and no longer reveals the Node URL.
- `top_view_reroll_proxy.php` no longer retries OpenAI without TLS
  verification when the certificate check fails.
- Tutorial artifacts (`_tutorials.php`, `editor.php`): uploads and text
  artifacts accept only png, jpg/jpeg, gif, webp, avif, bmp, tif/tiff, pdf,
  json, txt, csv, glb, gltf, bin, gz, zip, mp4, webm, mov. Served files take
  their type from that list (not `mime_content_type`), only images and PDFs
  display inline, and every response has `X-Content-Type-Options: nosniff`
  and `Content-Security-Policy: sandbox`.
- Open redirects: `portal/login.php`, `portal/activate.php`,
  `measure/internal/backend_login.php` and the IDE `public/login.php` accept
  only a path on this site (exactly one leading `/`, or a relative path with no
  scheme; never `//`, `/\`, backslashes, whitespace or control characters).
  The browser-side redirects re-check with `new URL(...)` and the page origin.
- Developer tools: `api.php` refuses any action that changes files unless it
  is a POST carrying `ide.php`'s per-session token (`X-IDE-CSRF`); downloads
  and listings may stay GET. `add_user.php` forms carry the same token. The IDE
  session uses the secure session helper. `portal/symlink.php` (unused, created
  symlinks from a web request) is deleted.

## Configuration each role needs

Values are configuration names and URLs, never secrets. Check the effective
value under the running PHP-FPM pool, not only a file.

| Role | `FIRSTMEASURE_API_BASE` | `FIRSTMEASURE_NODE_BASE_URL` | Signing secret |
| --- | --- | --- | --- |
| Production web pool (and the autoscale image/bootstrap) | not needed | `http://127.0.0.1:3101/v1/platform` (already a `fastcgi_param`) | not used: web PHP only forwards cookies or Stripe's signed webhook |
| Production compatibility `144.126.222.110` / `10.124.0.9` | **new: `https://app.1m8.ai/v1/firstmeasure`** (until now derived from `Host`) | keep the live `$fm_preview_php_platform_base` map (`app.1m8.ai` to `https://app.1m8.ai/v1/platform`), or `http://127.0.0.1:3101/v1/platform` | must equal the web nodes' and the compatibility Node's `FIRSTMEASURE_INTERNAL_API_SECRET` (provider key `application.internal_api_secret`) |
| Development compatibility `10.124.16.5` | keep `env[FIRSTMEASURE_API_BASE] = http://10.124.16.12/v1/firstmeasure` (`pool.d/zz-firstmeasure-development-api.conf`) | `http://127.0.0.1:3201/v1/platform` | see below |
| Development web `10.124.16.12` and pool | not needed | `http://127.0.0.1:3201/v1/platform` | not used |

Secret selection in PHP (`fm_node_service_secret`), first set wins:
`FIRSTMEASURE_NODE_SIGNING_SECRET`; for routes the web nodes serve
(`/v1/firstmeasure`, `/v1/platform`) the existing
`FIRSTMEASURE_FULL_HOUSE_SIGNING_SECRET` override; the provider key
`application.internal_api_secret`; `FIRSTMEASURE_INTERNAL_API_SECRET`. On
development the compatibility provider file was known to differ from the web
nodes' (that is why the full-house override exists), so `/v1/firstmeasure`
calls sign with the override and `/v1/internal` calls with the compatibility
provider key, which the compatibility Node verifies. **Simplest and
recommended:** one `FIRSTMEASURE_INTERNAL_API_SECRET` value on every web and
compatibility role, then drop the override. A wrong secret now fails closed
(401 `service_signature_invalid`) instead of falling back.

The compatibility host needs a CA bundle that trusts the load balancer's
certificate (`ca-certificates`), because PHP now verifies TLS on
`https://app.1m8.ai`.

## nginx changes per role

The repository templates were updated: `nginx-web.conf.template`,
`nginx-legacy.conf`, `nginx-development-web.conf`,
`nginx-development-legacy.conf`. Live configurations carry repairs these
templates do not (`$fm_forwarded_https`, the PHP platform-base map, the
production bootstrap endpoint): **edit the live files, do not replace them
with the templates.** For each role:

1. `nginx -T` and save a copy of the live configuration.
2. Apply the changes below. `nginx -t`, then `systemctl reload nginx`.
3. Run the role's checks. Restore the copy if any check fails.

Changes (every role):

- Replace `listen 80 default_server; server_name _;` on the application
  server with `listen 80;` and an explicit `server_name`: `app.1m8.ai`
  (production), `dev.1m8.ai` (development web), `dev.1m8.ai 10.124.16.5`
  (development compatibility, as today).
- Add a separate default server that answers everything else with `return
  444;`, except `^~ /v1/health/` (load balancer health checks arrive by IP)
  and, on web roles, `^~ /v1/` from `127.0.0.0/8` and `10.0.0.0/8` only (the
  compatibility PHP reaches development Node at `http://10.124.16.12/v1/...`).
- Before the PHP handler: `location ^~ /measure/internal/unused/` (web roles,
  because `^~ /measure/internal/` stops regex matching) and
  `location ~ (^|/)unused/` return 404; `location ^~ /includes/` returns 404;
  dotfiles `location ~ /\.(?!well-known/)` return 404; backups
  `location ~* (\.(bak|orig|old|swp|save)|~)$` return 404.
- `add_header X-Content-Type-Options nosniff always;` on the application
  server, with `proxy_hide_header X-Content-Type-Options;` in proxied
  locations so Node's own header is not doubled.
- `/storage/`: only `/storage/measure/internal/organizations/` (customer
  portal organization files) is served, with PHP refused inside it; the rest
  of `/storage/` (PHP's JSON stores, Apple key, tutorials, logs) returns 404.
- `/portal/symlink.php` returns 404 (the file is also deleted).

Production only (web pool and compatibility):

- `/api.php`, `/ide.php`, `/login.php` (the IDE sign-in), `/add_user.php`,
  `/auth.php` return 404 instead of being proxied to compatibility.
  `/sync.php` is still proxied (it checks its own HMAC); see open questions.

**Before changing production compatibility:** find how the web bootstrap
endpoint (`http://10.124.0.9/__firstmeasure_bootstrap_20260908/...`, Host
`firstmeasure-production-bootstrap.internal`) is served. If it lives in, or
falls through to, the current default server, give it its own `server_name
firstmeasure-production-bootstrap.internal` block first, or new web nodes will
fail to bootstrap. The same applies to anything else that reaches a host by
IP or by an unlisted name: list it in `server_name` before adding the 444
default.

**Web pool:** apply to every node and to the autoscale image/bootstrap, one
node at a time behind the load balancer, confirming each rejoins.

## Verification

Per role, after reload (replace `IP`):

- `curl -sS -o /dev/null -w '%{http_code}\n' http://IP/v1/health/ready` gives
  200 (health by IP still works).
- `curl -sS -H 'Host: attacker.example' http://IP/` gives an empty reply
  (`curl: (52)`), and `-H 'Host: attacker.example' http://IP/portal/` the same.
- Through the public name: `/measure/internal/unused/diagnostics/diagnose.php`,
  `/portal/unused/`, `/.git/config`, `/.env`, `/index.php.bak`,
  `/includes/node_api.php`, `/storage/measure/internal/config/apple_key.json`
  all give 404; `/.well-known/` paths still work.
- Production: `/api.php`, `/ide.php`, `/login.php`, `/add_user.php` give 404.
- `curl -sSI https://HOST/portal/login.php` shows one
  `X-Content-Type-Options: nosniff`.
- Development compatibility to web: from `10.124.16.5`,
  `curl -sS http://10.124.16.12/v1/health/ready` gives 200.

Application, after the Node and PHP release:

- Staff sign-in at `/measure/internal/backend_login.php` reaches the console;
  an already signed-in staff member reaches it without signing in again.
- A customer account signed in at `/portal/` and then opening
  `/measure/internal/` is sent to the staff sign-in, and
  `/measure/internal/editor.php?action=project_bundle&folder=...` gives 401.
- The queue, the editor (open, save, PDF), full house, resources, tutorials,
  the data agent and a QA rejection refund work as before (Node logs show
  `staff:...:php` and `system:php` principals, no anonymous calls from PHP).
- Impersonation: an admin starts and stops it from Users; Node's
  `security_audit` has both entries; a non-admin gets 403; a POST without the
  token gets 403 `invalid_csrf_token`.
- Image proxy: a public logo URL still loads in onboarding;
  `image_proxy.php?action=fetch_image&url=http://169.254.169.254/latest/meta-data/`
  and `...url=http://127.0.0.1:3101/v1/health/ready` give `Fetch failed`.
- Stripe: the public negative-signature probe still answers HTTP 400
  `Invalid signature`.

Tests: `public/v1/tests/request-security-php.test.ts` (PHP signatures verified
by Node's `verifyServiceSignature`, the PHP helper checks in
`request-security-php.test.php`, source checks, nginx rules),
`tests/stripe-webhook-bridge.test.php`, `tests/portal-session-availability.test.php`,
and `npm run test:platform:php` (PHP lint). The PHP integration tests
(`full-house-*-php`, `tutorial-exteriors`, `dev/resource-frame-extract`) now
set the staff mark in their session fixtures.

Results on this branch (2026-10-24): `request-security-php.test.ts` 5/5, PHP
lint 86 files, the PHP-only tests, `full-house-php` and
`full-house-references-php` pass. `full-house-address-php` fails only on its
last assertion, which predates this work (`full_house.php` already sends
`measurement_system` and `report_language` that the test does not expect).
`tutorial-exteriors` cannot boot the app yet: the Node WIP route gate refuses
`POST /v1/firstmeasure/ai/gemini-image` for lack of an access declaration.

## Open questions

1. **`/v1/internal/me` for non-staff.** The current handler answers any
   signed-in identity with a synthetic `user` built from its own role, so a
   customer organization admin would look like an admin. PHP therefore also
   requires the staff record (`/internal/users/{email}`, staff only). Confirm
   the Node branch makes `/me` answer 403 (or no `user`) for non-staff, as the
   contract says.
2. **Impersonation response shapes.** PHP reads `GET /v1/internal/impersonation`
   as `{target_email, admin_email?, expires_at, started_at?}` (also accepted
   nested under `impersonation`, and `active: false`), and the POST response's
   `expires_at`. Confirm against the Node branch.
3. **Does the web Node verify signatures on `/v1/internal` before proxying to
   compatibility?** If it does, compatibility PHP must sign `/v1/internal` with
   the web nodes' secret as well; with one shared secret it does not matter.
4. **Apple key harvester.** `apple_endpoint.php` was a public cross-origin
   write, and production logs show traffic to it. If an external script posts
   keys there, it now gets 401; it should call
   `POST /v1/internal/admin/apple-key` as a staff admin instead.
5. **`/sync.php` in production.** It stays reachable (HMAC-signed, used for
   explicitly requested production file syncs). Deny it too unless that
   workflow is still wanted.
6. **`/storage/measure/internal/organizations/`** stays public because the
   customer portal links organization files there. Check what that directory
   holds on production; anything private in it is still downloadable.
7. **Tutorial upload types.** The allowlist covers what the editor saves as
   far as the code shows; a save of another extension is now skipped. Watch
   for "This file type cannot be uploaded" after release.
8. **Portal and console during impersonation.** Opening `/portal/` while
   impersonating switches the shared PHP session back to the admin (as before);
   the console then re-verifies and becomes the target again. Harmless, but it
   regenerates the session id each switch.
9. **`stripe_create_checkout.php` and the `server.php` billing actions** now
   forward the platform cookie with the browser's `Origin`. Confirm Node's
   `portal-action` accepts that and attributes the checkout to the session.
10. Remove the `x-full-house-*`, `x-tutorial-*` receipts and the
    `X-Internal-User-*` CORS allowance one release after this one.
11. Rotate the internal secret, legacy proxy secret and provider keys once this
    and the Node release are in production (per the contract document).
