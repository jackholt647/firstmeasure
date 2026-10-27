# Production hotfix 62119658: embeddable signup form for the websites (1M8-240), October 24, 2026

Jack approved this in the PM session: "make the app's signup form embeddable on the websites (dev and tests first, safe cross-site setup)". It is production `bf8a99a8` plus `claude/signup-embed-20261023` (`c17c3797`).

## What it adds

- **Embedding:** a website page can embed the app's signup form with a `data-firstmate-signup` element and `portal/landing/shared/signup-widget.js`.
- **Allowed origins:** auth routes accept cross-origin requests only from the exact origins in `SIGNUP_EMBED_ORIGINS` (default `https://1m8.ai,https://www.1m8.ai,https://eu.1m8.ai`) or the app's own host. Every other origin gets 403.
- **Redirects:** a redirect after signup may go only into the app or back to the page's own site. This closes an open redirect on the old app landing pages.
- **Kept fields:** attribution fields and the bonus guard are kept.
- **Same behaviour as `login.php`:** no Country or Language dropdowns, signup never refused, and the language hand-off, detected phone code and 17 languages all apply.

## Checks

- `tsc` passes. PHP lint passes. No stale cache keys.
- 58 of 58 pass: signup-embed-browser (10, including disallowed origins, an off-site redirect and third-party-cookie blocking), signup-language-browser, signup-language-catalog, signup-region, access-gates (snapshot updated), portal-auth-errors and phone-input.
- `experimental-accounts` fails identically on production `bf8a99a8`, so it is not new.

**Build:** archive `c9096dd3…`, verified.

## Rollout

- Compatibility (0 errors and 0 crashes in the next 20 s), worker, the signed channel (against `9ca28147…`, `bf8a99a8`) and six web nodes were activated.
- Public readiness returned `62119658` 10 out of 10 times.

## Live checks

`signup-options` with `Origin` set:

| Origin | Status |
| --- | --- |
| `https://1m8.ai` | 200 |
| `https://www.1m8.ai` | 200 |
| `https://eu.1m8.ai` | 200 |
| `https://evil.example` | 403 |
| `https://1m8.ai.evil.example` | 403 |

`signup-widget.js` returns 200.

## Known issue, left as it is

The platform-wide CORS setting still reflects any origin with credentials. The refused origins above get 403 but still see their origin echoed in Access-Control-Allow-Origin. Session cookies are not sent cross-site, so this gives no signed-in access. Tightening it platform-wide is a separate decision for Jack.

## Rollback

Every role keeps `bf8a99a8`. Republish it (`9ca28147…`) to the channel before rolling back a web node.
