# Security audit and request-security release (2026-10-24)

Trigger: Jeremiah Gaylord (RollWith.AI, integrator for B&B Roofing,
`org_536ea57c076525bf`) reported on 2026-10-24 that
`POST /v1/firstmeasure/projects/list` decides whose projects to return from the
`actor` in the request body.

Design: [request security](../../docs/architecture/request-security.md).
Branch: `claude/request-security-20261024` (with `claude/request-security-portal`
and `claude/request-security-php` merged in). PHP and nginx host steps:
[security-php-nginx-20261024.md](security-php-nginx-20261024.md).

## What was verified on production (read-only)

Probes were sent with no cookie and were built to return no customer data:
a search for a nonexistent address, the API index and `/v1/internal/me`.

- `POST /v1/firstmeasure/projects/list` answers 200 with **no session at
  all**, not only to signed-in users. `limit: 0` returns up to 5,000 rows.
- `/v1/internal/*` answers anonymous callers (`/me` returns
  `authenticated: false` and serves the route).
- The production code matches git exactly. All eight roles run `6fefe93c`,
  and a hash of every release file was compared with git. That commit is
  the tip of `origin/production-live`, which canonical does not contain; see
  "Release baseline" below.

## Findings and status

Critical, all reachable by anyone on the internet before this release:

| # | Finding | Fixed by |
|---|---|---|
| 1 | About 130 of 143 `/v1/firstmeasure` routes had no auth, and identity came from `body.actor` (admin = `roles: ["admin"]`). Anyone could list or read any project and report PDF, overwrite artifacts, redirect report emails, replace the Apple key, approve or kick QA work, and chain PATCH `amount_charged` into `coverage/reject` to make real refunds | Route access table, `firstmeasure/access.ts` (verified actor, organization scope in SQL, per-project 404, customer PATCH field allowlist, staff money-field rule) |
| 2 | `/v1/internal` and `/v1/communications`: the web proxy added the legacy secret to every public request, and identity came from `X-Internal-User-*`. Anyone could create admins, mint credits, mint any organization's live API key, rewrite server config or send Gmail as staff | Route table, principal-based `actorFromRequest`, `/me` staff-only, staff guards, legacy-action levels |
| 3 | Payments boarding admin console (`/v1/payments` admin) trusted `X-Internal-User-Email` | `requireBoardingOpsStaff` reads the principal |
| 4 | Customer `portal-action`: any member could run every action. `refund_instant_rejection` credited `body.refund_amount`, billing accepted arbitrary Stripe ids, and members could add owners or change other users' emails | `platform/portal_action_access.ts`, server-owned refunds, Stripe session ownership |
| 5 | PHP built the Node URL from the request's `Host` and attached the internal secret, which could send the secret to an attacker and trust forged "admin" answers | One PHP Node client from configuration, TLS on, signed requests |
| 6 | Server-side fetch of any URL: `image_proxy.php`, `portal-action fetch_image` / `scrape_logos`, instant PDF logos. This reached the metadata service and local Node `server-config` (OpenAI key) | `safeFetch` (Node) and `safe_fetch.php` |

High: a customer login satisfied the `/measure/internal` gate, so
`editor.php` streamed any project; the Apple endpoint was open; tutorial
uploads accepted any type, served inline; `api.php` was an internet-facing
file manager; the login `redirect` accepted `javascript:`; uploaded XML was
served inline with no `nosniff`. Medium: CORS reflected every origin with
credentials; CSRF covered some routes only; debug traces were open; there were
no security headers; `unused/` PHP was reachable. All are addressed in this
release or in the nginx templates.

**Production configuration found (not code):**

- **A dev site on the production compatibility host.**
  `/etc/nginx/sites-enabled/firstmeasure-development` (Aug 29, `server_name
  dev.1m8.ai 10.124.0.9`) serves release `1b09f15` through PHP with the
  production provider-keys file. Web nodes pass the client's Host through, so
  `Host: dev.1m8.ai` sent to app.1m8.ai likely reaches it. Untested. **Remove
  it** (needs Jack's authorization).
- Production nginx is not tracked in the repo: GeoIP trusts
  `X-Forwarded-For` from 10.124.0.0/20, it uses `$document_root`, and there is
  no `PLATFORM_SESSION_COOKIE_NAME` for PHP.
- Firewall: UFW is off on compatibility (Node on 0.0.0.0:3101), but an
  upstream firewall blocks it from the internet.

## Forensics (2026-10-11 to 10-25, read-only)

Logs hold no client IPs (every line shows the load balancer), no Host header
and no request bodies. Node request logs start Oct 20 (compatibility) and
Oct 22 (web).

- **No hits from outside in 14 days** on credits/adjust, API key admin,
  server-config or state writes, Gmail, coverage/reject, weather/order,
  send-report, release/force, bulk-approve, `unused/`, or image-proxy
  internal URLs.
- **Staff user creation (11) and edits (97)**: all from staff browsers on the
  staff console; the database matches (trainee accounts). No admin, system
  admin or manager was created after Sep 8.
- **API keys**: 22, all made by staff in the admin portal.
  **`server_config`**: unchanged since 2026-06-08.
- **Credit adjustments**: 195 credits and 50 deductions since Oct 10, all
  with `by_email = null`, so they cannot be attributed. The pattern looks
  like support work. This release attributes every adjustment to the
  verified actor.
- **Apple key**: `POST /v1/firstmeasure/apple-key/ingest` has been called every
  2–4 minutes since Oct 22 from one Windows Chrome client with no referer:
  2,018 unauthenticated writes with `key_changed=true`. Before that, from
  Oct 14, the same client called `apple_endpoint.php`. This is probably
  Jack's harvester tool, to be confirmed. After this release it needs
  `FIRSTMEASURE_APPLE_KEY_INGEST_TOKEN` (`Authorization: Bearer`).
- **Python-urllib/3.12**: about 12.4K `POST /v1/internal/legacy-action`
  calls a day, in bursts around 07:00 UTC, origin unknown. It sends no
  session, so after this release it gets 401. **Identify it before release.**
- **`curl/8.21.0`** at 2026-10-24 23:38 UTC (`projects/list`,
  `queue/changes`): the audit's own probes from this workstation.
- **B&B / RollWith.AI**: only browser portal sessions; the organization has no
  API key.

Cannot be determined: anything before Oct 11, real client IPs, whether the
compatibility host's dev site was reached, request bodies, and who made
credit adjustments or Apple key writes.

## Release baseline

Production's line `origin/production-live` (6fefe93c) holds 48 code commits
canonical lacks and 4 that are partly there (Europe signup and VAT,
customer-portal regressions, batched summaries, artifact byte-for-byte serving,
holds). Dev hosts carry them through file merges. **Canonical must merge
`production-live` before any release built from it goes to production**,
including this one.

## After the release reaches production

1. Rotate `FIRSTMEASURE_INTERNAL_API_SECRET` (set the old value as
   `FIRSTMEASURE_INTERNAL_API_SECRET_PREVIOUS` during the roll),
   `LEGACY_PROXY_SECRET`, the full-house signing secret, and every key that
   `GET /v1/internal/server-config` could return (OpenAI and the other provider
   entries). All were readable before this release.
2. Re-issue public API keys if `PUBLIC_FIRSTMEASURE_API_KEY_SECRET` is set
   (it currently falls back to the session secret).
3. Remove the old full-house signature (`x-full-house-*`) once every PHP
   host sends the request-bound signature.
4. Reply to Jeremiah Gaylord.
