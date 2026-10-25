# Development rollout: request security (2026-10-24)

Release `57a9aa43` (branch `claude/request-security-20261024`, which merges canonical `2428ecc8`) on the development
worker, legacy (compatibility) and web roles, activated 2026-10-25 03:00:51 to 03:01:15 UTC. The pool node
(10.124.16.3) is down and was not part of the rollout. Production was not touched, and host nginx was not changed
(the `deploy/*.nginx` templates in the release were not applied). Design:
[request security](../../docs/architecture/request-security.md). Audit:
[security-audit-20261024.md](security-audit-20261024.md). Tooling: `output/request-security-20261024/`
(`setup.py`, `ship.sh`, `replay.py`, `preflight.mts`, `integrate.py`).

| Role | Before | After |
| --- | --- | --- |
| worker | `efd891a0` | `57a9aa43` (126 files: backend `.ts` and their dist builds, tests) |
| legacy | `efd891a0` | `57a9aa43` (161 files, `public/portal/symlink.php` removed) |
| web | `efd891a0` | `57a9aa43` (161 files, `public/portal/symlink.php` removed); the standby API on port 3202 followed at 03:02:10 |

## What shipped

The change from `2428ecc8` to `57a9aa43` under `public/`: 62 backend `.ts` files (route access tables, principal,
service signatures, safe fetch, browser protections, staff guards, portal action access), 36 PHP files
(`includes/node_api.php`, `safe_fetch.php`, `web_security.php`, the `/measure/internal` staff gate, portal pages),
`measure/internal/portal_scripts/users.js` and the tests. Docs, AGENTS.md and the nginx templates were not deployed.

## Host merges

Every file was three-way merged onto each role's live copy (base `2428ecc8`), so dev's uncommitted work stays.
Six files conflicted and were resolved hunk by hunk against exact expected text (`replay.py`):

- `platform/api.ts`: dev's `assertOrganizationKeepsAdmin` calls (not in git) kept beside the release's
  `portalOrgUserDocument` and `assertMayGrantPortalAccess`.
- `portal/login.php`: dev's invited-organization line kept after the release's same-origin redirect check.
- Tests (type-checked only on hosts): `exteriors-order` and `qa-manual-reservation` keep dev's hunk;
  `regional-commerce` takes the release's staff sign-in with dev's price (21). `access-gates.snapshot.json` keeps
  each host's copy.

## Pre-flight: undeclared routes

The server refuses to start if a route under a covered prefix has no access declaration. Each role's merged copy of
every covered module (live copy where not shipped) was scanned and run through the release's own `onRoute` check.
The first build (`5e5eeb13`) found four routes that dev runs from `production-live` (1M8-228, country of record) and
git lacks, so nothing was staged. `57a9aa43` declares them:

- `GET`/`POST /v1/firstmeasure/admin/prices/organizations/:orgId/commercial-profile`: `{ staff: "admin" }`
  (staff console prices page, reassign an organization's country).
- `GET`/`PUT /v1/internal/admin/capability-country-rules`: `{ staff: "any" }`; the handler's feature-flag admin
  check still applies (no caller found).

With `57a9aa43` the pre-flight was clean on all three roles.

## Configuration check (read-only, hashes only)

- Legacy PHP signs with `FIRSTMEASURE_FULL_HOUSE_SIGNING_SECRET` (pool `zz-firstmeasure-exteriors.conf`). Legacy
  Node accepts it through `FIRSTMEASURE_INTERNAL_API_SECRET`; web Node through its provider key and environment.
- Web PHP has no pool environment; it signs with `application.internal_api_secret` from
  `/etc/firstmeasure/provider-keys.json` (readable by www-data), the same value, accepted by both.
- Legacy Node's own provider-key secret differs from the others; it also accepts the environment value, so
  signatures verify.
- Node base URLs: legacy PHP `FIRSTMEASURE_API_BASE=http://10.124.16.12/v1/firstmeasure`; both hosts'
  nginx pass `FIRSTMEASURE_NODE_BASE_URL=http://127.0.0.1:3201/v1/platform`.

## Verified on dev.1m8.ai (no cookie, nothing that writes)

| Request | Before | After |
| --- | --- | --- |
| `POST /v1/firstmeasure/projects/list` (body `actor` claiming admin) | 200 | 401 |
| `GET /v1/firstmeasure/queue/changes` | 200 | 401 |
| `GET /v1/internal/me` | 200 `authenticated:false` | 401 (declared `customer_or_staff`; PHP treats 401 as not staff) |
| `GET /v1/internal/users` | 200, user list | 401 |
| `POST /v1/internal/users` (empty body) | 400 `missing_email` | 401 |
| `GET /v1/internal/users` with `X-Internal-User-Email: jack@1m8.ai` | 200 | 401 |
| `/v1/firstmeasure/ping`, `/v1/firstmeasure/pdf-runtime/manifest`, `/v1/health/ready`, `/portal/login.php`, `/measure/internal/backend_login.php` | 200 | 200 |

`Origin: https://evil.example`: `access-control-allow-credentials` was `true` before and is now absent on GET and
preflight. `access-control-allow-origin` still echoes the origin without credentials (by design: public, cookie-free
answers stay readable).

## Logs after activation (03:01 to 03:12 UTC)

- No startup errors and no level 50+ entries in the web, web-standby, legacy or worker journals.
- Six 502s at 03:02:11 on web (`attention`, `inbox`, `notifications`): nginx had no live upstream for that second
  while the standby restarted onto the release. None after.
- Every 401 on `/v1/firstmeasure`, `/v1/internal` and `/v1/communications` came from the verification probes
  (`curl/8.21.0`). No refused browser or other callers were seen, and no PHP errors.

## Canonical

`integrate.py` moved `codex/consolidated-firstmeasure-20260923` from `2428ecc8` to `57a9aa43` by compare-and-swap.
Other sessions' staged and unstaged edits to `platform/api.ts` and their unstaged edits to
`tests/platform-workflows.test.ts` were merged and checked hunk for hunk; `public/portal/symlink.php` was removed
from the index and working copy (it matched the base).

## Not done here

- Production: the audit's release-baseline and secret-rotation steps apply before any production release.
- Host nginx configuration from the templates (`security-php-nginx-20261024.md`).
- Pool node: down.

## Addendum: follow-up release `b6f6c951` (2026-10-25)

Release `b6f6c951` (commits `3d6ed369` and `b6f6c951` on `claude/request-security-20261024`, commit-base `a55f4d66`)
on worker, legacy and web, activated 04:27:24 to 04:27:40 UTC; the web standby followed at 04:27:50. Pool still down.
Tooling: `output/request-security-followup-20261025/`.

- `3d6ed369`: when a staff save adopts a login that is not staff, that login's password and sessions are cleared;
  signup can no longer claim a verified email (`internal/api.ts`, `platform/api.ts`, `tests/route-access.test.ts`).
- `b6f6c951`: `get_apple_key_info` is open to any staff member again (the editor reads it); writing the key stays
  admin-only (`internal/staff-guards.ts`).

All four files three-way merged onto each role's live copy without conflicts, and the route pre-flight was clean on
every role. Verified: the anonymous probes answer as before (401 on the covered routes, 200 on the public pages,
no credentialed CORS for a foreign origin). The editor load as fh-pilot-tech (technician) now gets 200 on
`legacy-action` `get_apple_key_info`; before, it got 403 `staff_level_required`. No startup errors in the journals.
Two 502s fell inside the restarts (legacy health probe at 04:27:31, a web poll at 04:27:50). One web "Premature
close" at 04:44:31 on `legacy-action` came from the verification browser being stopped mid-request. Canonical moved
from `a55f4d66` to `b6f6c951` by compare-and-swap; other sessions' edits to `platform/api.ts` were kept.
