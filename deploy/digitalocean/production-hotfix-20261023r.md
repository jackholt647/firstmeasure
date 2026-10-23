# Production hotfix bf8a99a8: signup language hand-off, no signup dropdowns, never refused (1M8-240), October 23, 2026

Built from `claude/signup-language-handoff-20261023` on production `6948c461`. Jack set this direction in the PM session (see `product-decisions` memory, 2026-10-23); it was released under his standing approval.

## Changes

- **Signup form:** the Country and Language dropdowns are gone.
- **Refusals:** no signup is refused for any country. The `assertSignupCountry` check is removed from all three signup paths.
- **Language hand-off:**
  - `?lang=<BCP-47>` on any app URL sets an `fm_lang` cookie (`.1m8.ai`, 30 days).
  - The visitor's language comes from the hand-off first, then the location header, then the browser languages, then the time zone.
  - It becomes the new organization's company language.
  - Currency follows location.
  - All 17 language packs are covered, and a catalog completeness test checks every signup and onboarding key in every language.
- **Phone field:** the calling code comes from the same detection, and the example, typing format and length limit follow the selected code.
- **Old app.1m8.ai landing pages:** they read `?lang`, the cookie or detection, and their signup button labels are translated.
- **Website hand-off script:** `/libraries/signup-language/handoff.js` is served for the website droplets.

## Checks

- `tsc` passes.
- signup-region, signup-widget-auth, organization-country and account-org-invites: 21 of 21 pass.
- Browser and contract tests pass: signup-language-browser 22 (run with tsx), signup-language-catalog, phone-input, portal-auth-errors, login-billboard, vat-label-credits, portal-regressions, account-access and billing.
- No stale cache keys. PHP lint passes.

**Build:** archive `9ca28147…`, verified.

## Rollout

- Compatibility, with 0 errors and 0 crashes in the next 20 s.
- Worker.
- Signed channel, published against `9b4d8a70…` (`6948c461`).
- Six web nodes.

Public readiness returned `bf8a99a8` 10 out of 10 times.

## Live checks

- `handoff.js` returns 200 `application/javascript`.
- `login.php?lang=fr` returns 200 and contains no country or language selects.
- `/v1/platform/auth/signup-options?lang=es&time_zone=America/Chicago` returns country US, USD and language es-ES.

## Known gap: no IP-based country on production

Detection reads `cf-ipcountry`, `x-vercel-ip-country` or `x-appengine-country`. Production is not behind Cloudflare, and NGINX sets no country header (its geoip module is built but not configured). Location detection therefore falls back to the browser time zone and language.

With no time zone hint, a request with `lang=es` picks ES and EUR. Browsers always send the time zone, so they are not affected.

Adding IP geolocation needs an NGINX geoip2 header with a MaxMind database on the web nodes, plus Jack's approval.

## Not done

The website droplets (1m8.ai `104.248.225.27`, eu.1m8.ai `157.230.121.5`) still need the `handoff.js` script tag. They are not deployed.

## Rollback

Every role keeps `6948c461`. Republish it (`9b4d8a70…`) to the channel before rolling back a web node.
