# Request security: who is calling, and what they may touch

Read this before adding a route, an internal or service call, a PHP call to
Node, anything that fetches a URL a person supplied, or anything that serves a
file a person uploaded. It replaces the earlier assumption that
`/v1/firstmeasure`, `/v1/internal` and `/v1/communications` sit behind a
trusted portal: they are on the public internet, and the 2026-10-24 audit
found them answering anonymous requests (see
[the audit record](../../deploy/digitalocean/security-audit-20261024.md)).

## Rules

1. **Identity comes only from a verified credential.** A platform session
   cookie, a public API key, the in-process service token, or a signed PHP
   service request. Never from `actor`, `actor_email`, `organization_id`,
   `roles` or `X-Internal-User-*` in a body, query or header. Those fields may
   still be sent by old clients; they are ignored for authority.
2. **Every route declares who may call it, and the server refuses the rest
   before the handler runs.** A route without a declaration fails at startup
   in the covered prefixes. "Public" is a declaration with a reason.
3. **Every record is checked against the caller.** Passing the route gate says
   *who* is calling. The handler, through one helper per kind of record, says
   whether *this* caller may read or change *this* record. A customer never
   reaches beyond their organization (see
   [permissions](permissions-and-agents.md#organization-boundary)).
4. **Failing closed.** A missing secret, an unreadable session or an unknown
   record refuses. A project the caller may not see answers 404, as if it did
   not exist.

## Principals

`platform/security/principal.ts` resolves one principal per request, once,
and keeps it on the request (`requestPrincipal(request)`):

| Kind | Proven by | Carries |
|---|---|---|
| `anonymous` | nothing | - |
| `customer` | platform session cookie | the `PlatformAuthContext` (organization, user, permissions, apps) |
| `staff` | platform session cookie whose identity has an active membership in the internal staff organization (`INTERNAL_PLATFORM_ORG_ID`, default `legacy_internal`) **and** an active internal user record | the auth context, the internal user (role, permissions) and, when an administrator is acting as someone, `impersonator` |
| `service` | in-process service token, or a signed PHP service request | `actor`: the person the service acts for (a signed staff email or a platform user), or `system` |
| `api_key` | public FirstMeasure API key | the key's organization (unchanged, `public-firstmeasure/keys.ts`) |

A staff member is identified by **membership in the staff organization**, not
by an email that happens to match an internal user record. An email alone is
not proof: an internal user can exist before its login does.

**Staff roles** are read from the internal user record through
`staffAuthority(user)`, the one place that answers *is this a full admin, a
manager, QA, a technician*. The scattered checks
(`canAccessFirstMeasureDebugTools`, `requireQaManagerReviewActor`,
`requireQaBulkApprovalAdmin`, `requirePricingAdmin`, `requireReplayAdmin`,
`backendUserCanAccessInternal`) all call it.

**Acting as another staff member** (the staff console's impersonation) is a
server-side mark on the administrator's platform session, set only by a full
admin through `POST /v1/internal/impersonation`, time-limited (4 hours),
recorded in the internal audit log on start and stop. While it is set the
effective staff user is the target and `impersonator` names the admin. PHP no
longer switches identity on its own.

## Route access declarations

Routes in the covered prefixes declare access in their plugin's access table
(`firstmeasure/route-access.ts`, `internal/route-access.ts`,
`public-firstmeasure/route-access.ts`, loaded by
`platform/security/route-access-tables.ts`), keyed by method and full URL, or
in their route options:

```ts
"GET /v1/firstmeasure/projects/:id": "customer_or_staff",
"POST /v1/firstmeasure/admin/reindex": { staff: "admin" },
"GET /v1/firstmeasure/pdf-runtime/fonts/:name": { public: "report fonts (static, allowlisted)" },
// or inline: app.get(url, { config: { access: { staff: "qa" } } }, handler)
```

A table keeps every decision for a plugin in one reviewable place and out of
the plugin's handlers. A route nothing calls is `{ staff: "admin" }` until a
caller needs it.

Access values (`platform/security/route-access.ts`):

- `{ public: "<reason>" }`: anyone. Only static files, health, and flows that
  carry their own proof (a signed link token, a Stripe signature).
- `"service"`: in-process or signed PHP calls only.
- `{ staff: <level> }`: staff at that level or above
  (`any` < `technician` < `qa` < `manager` < `admin`), or a service acting for
  such a staff member, or `system`.
- `"customer_or_staff"`: any signed-in customer, any staff member, or a
  service. The handler must then authorize the record.
- `"customer"`: a signed-in customer (staff sessions qualify only through their
  own organization).

A root `onRoute` hook (`installRouteAccess`) refuses to register a route
under a covered prefix without a valid declaration, and a root `preHandler`
enforces it. Covered prefixes today: `/v1/firstmeasure`,
`/v1/firstmeasure-remote`, `/v1/internal`, `/v1/communications`,
`/v1/public/firstmeasure`. The rest of the platform is listed in
`UNDECLARED_PREFIXES` with the date it is due; shrinking that list is the
platform audit.

The gate does not replace per-record checks, permission flags or CSRF; it
guarantees that no handler in a covered prefix ever runs for a caller it was
not written for.

**Legacy actor fields.** Older handlers read `body.actor`, `actor_email` or
`actorFromRequest`. Before any FirstMeasure handler runs,
`firstmeasure/access.ts` replaces `actor` with the verified one; in
`/v1/internal`, `actorFromRequest` and the legacy-action dispatcher do the
same. Only the system principal (our own service code) may name an actor.
Staff console actions (`POST /v1/internal/legacy-action`) each need a staff
level (`LEGACY_ACTION_LEVELS` in `internal/staff-guards.ts`); changing staff
users goes through `assertMayManageInternalUser`: only a full admin grants
admin roles or admin permission flags, sets a password hash, changes another
person's password or email, or edits an admin.

Routes that carry their own proof are declared public with that reason and
check it in the handler: the tutorial bridge HMAC, the public API key, the
remote analytics key, the one-time key delivery token, Google's OAuth state,
and the Apple key harvester's `FIRSTMEASURE_APPLE_KEY_INGEST_TOKEN`
(`Authorization: Bearer`; unset refuses every caller).

## Service calls

**In process (`app.inject`).** `serviceInject(app, request, { actor })` adds a
per-process token generated at startup (`crypto.randomBytes`, never written,
logged or sent off the machine) and a JSON actor. Because the token exists only
inside the running process, a network request cannot present it. Every
`app.inject` that reaches a covered prefix goes through this helper; a test
fails on a bare `app.inject` to one.

**PHP to Node.** PHP signs each request with the internal secret:

```
X-FM-Service-Time: <unix seconds>
X-FM-Service-Actor: <staff email, or "system">
X-FM-Service-Signature: hex(HMAC-SHA256(secret, "v1\n" + METHOD + "\n" + path?query + "\n" + time + "\n" + actor + "\n" + sha256(body)))
```

Node accepts it within 120 seconds, only for an actor that is an active staff
member (or `system` for unattended jobs), and treats it as that staff member.
PHP takes the actor from its own session, which it sets only after Node has
verified the platform session (`backend_login.php`). The older Full House
HMAC (`x-full-house-*`, email and time only) is still accepted as that staff
member so PHP hosts that have not been updated keep working; remove it once
every PHP host sends the request-bound signature. A bare
`x-firstmeasure-internal` header proves nothing on its own any more.

PHP reaches Node at a configured base URL (`FIRSTMEASURE_NODE_BASE_URL`), never
one built from the request's `Host`, with TLS verification on. Without the
setting PHP refuses rather than guessing.

In PHP this is `public/includes/node_api.php`: `fm_node_v1_url()` (the base,
from `FIRSTMEASURE_API_BASE` or `FIRSTMEASURE_NODE_BASE_URL`),
`fm_node_request()` and `fm_node_identity_headers()` (`session` signs as the
verified staff member, `system` for PHP's own work, `cookie` forwards the
browser's platform session), and `fm_node_curl_options()` (TLS verified, no
redirects). A `/measure/internal` page gates with `fm_internal_require_staff()`
(`measure/internal/_staff_session.php`): the PHP session is staff only after
Node confirmed the platform session (`GET /v1/internal/me`, then the staff
record) and only for that email, so a customer's portal login in the shared
session never passes. Sessions start through `fm_session_start_secure()`
(`includes/web_security.php`), which also holds the CSRF tokens, the
same-site redirect check and the uploaded-file headers; URLs people supply are
fetched with `includes/safe_fetch.php`. Host configuration is in
[the PHP and nginx release notes](../../deploy/digitalocean/security-php-nginx-20261024.md).

**Web to compatibility (`/v1/internal`, `/v1/communications`).** The web
tier's proxy no longer turns any public request into a trusted one. It
forwards the caller's cookies; the compatibility host resolves the principal
from the same session store and applies the same route gate. The legacy proxy
secret only proves the request came through the web tier.

## Records

`firstmeasure/access.ts` is the one answer to *may this principal read or
change this project*:

- **staff, service:** yes (staff level still applies per route).
- **customer:** the project's organization (`organization_ref.id`, or the
  legacy `organization_id`) must be the session's organization; reading needs
  `view_reports`, ordering and changing need `order_reports`. A project with no
  organization is visible only to staff.
- Otherwise the project is reported as not found.

Listing and search routes take the organization and actor from the principal
and narrow `filter` to what the caller holds; a customer's `filter` is one of
`mine`, `team` or `org`, inside their own organization.

Customer writes to a project accept an explicit list of fields
(`CUSTOMER_PROJECT_PATCH_FIELDS`, today the Customer info card's `resident`).
Money fields (anything named like an amount, refund, charge, credit, price,
cost, payment, invoice or balance) are dropped from a staff edit unless the
staff member is a full admin; they are written by the domain writers that move
the money.

**Files without a session.** Thumbnails and report files that a page without a
session shows (the homeowner portal) use a signed link:
`signedProjectFileQuery(projectId, name)` appends `exp` and `sig`, valid for
one project file for 7 days. Without a valid link the caller needs a session
that may read the project.

## Browser protections

- **CORS** allows credentials only for `CORS_ALLOWED_ORIGINS`
  (production: `https://app.1m8.ai`). Other origins get no CORS headers.
- **Cross-site writes:** a request that carries a platform session cookie and
  is not `GET`/`HEAD`/`OPTIONS` must have an `Origin` (or, failing that, a
  `Referer`) in the allowed origins. This covers every route, including those
  that predate `csrf: true`, without changing clients. `csrf: true` stays where
  it is.
- **Security headers** on every Node response: `X-Content-Type-Options:
  nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`. Framing is
  left to each page (forms and the chat widget are embedded on customers'
  sites).
- **Files people upload** are served with their stored type only when it is on
  a safe list (images, PDF, JSON, plain text, gzip, glTF). Anything else,
  including XML, SVG and HTML, is served `Content-Disposition: attachment` with
  `Content-Security-Policy: sandbox`. Customer artifacts are `private`, never
  `public`, in `Cache-Control`.
- **Debug output** (`X-FirstMeasure-Debug`, `?debug=1`, traces, internal
  error messages, stack traces) is returned only to staff with debug access
  (full admins, or the `firstmeasure_debugger` permission).

## Fetching URLs

Anything that fetches a URL a person or a record supplied uses
`platform/security/safe-fetch.ts`: http(s) only, the host is resolved and every
address checked against private, loopback, link-local, metadata and multicast
ranges (IPv4 and IPv6, including mapped forms), the connection is pinned to the
checked address, redirects are followed manually and re-checked (at most 3), a
size and time limit applies. The PHP image proxy (`portal/image_proxy.php`)
applies the same rules through `public/includes/safe_fetch.php` (pinned with
`CURLOPT_RESOLVE`, ports 80 and 443 only, image responses only for images).

## Secrets

- `FIRSTMEASURE_INTERNAL_API_SECRET`: PHP and Node service signatures.
- `LEGACY_PROXY_SECRET`: web tier to compatibility host.
- `PUBLIC_FIRSTMEASURE_API_KEY_SECRET`: public API key hashes and the key
  vault. Unset, the session secret is used. Setting it invalidates every
  existing key, so set it together with re-issuing the keys.
- `FIRSTMEASURE_APPLE_KEY_INGEST_TOKEN`: the Apple key harvester's token (at
  least 32 characters).

After the release reaches production, the internal secret, the legacy proxy
secret and every provider key that `/v1/internal/server-config` could return
are rotated, because before this release they were readable.

## Tests

- `tests/route-access.test.ts` boots the app and sends every route in the
  covered prefixes an anonymous request, then a customer request from another
  organization, and checks each answer against its declaration. A route that
  answers 2xx to a caller its declaration excludes fails the test.
- `tests/firstmeasure-project-access.test.ts`: cross-organization reads,
  lists, writes, artifacts and money fields.
- `tests/service-auth.test.ts`: in-process token, PHP signature (time window,
  body binding, inactive staff), and that spoofed actor fields grant nothing.
- `tests/safe-fetch.test.ts`: blocked address forms and redirect re-checks.
- `tests/access-gates.test.ts` records the declarations in its snapshot.
