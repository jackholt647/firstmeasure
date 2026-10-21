# Europe signup: country, phone code and language — development, October 21, 2026

Source `451430094e6bb9ab4aa03f1d4cf0846466dccdf0` on branch `claude/lucid-yonath-777e5b`, one commit on top of canonical
`72cd1962`. It is **not on the canonical branch yet**; the coordinating session merges it.

**Signup country decides the billing profile.** `detectSignupCountry` honors `signup_country` before edge headers and
browser hints (`source: "signup_choice"`). Choosing a non-domestic country only raises prices; property-market pricing
still applies to each order. `GET /v1/platform/auth/signup-options` returns the detected country, countries with
calling codes and default languages, and the language packs. Calling codes are a generated table
(`commerce/calling-codes.json`) because the worker has no `libphonenumber-js` installed.

**Signup forms.** `login.php` and the landing signup widget load `libraries/signup-region/signup-region.js`, which adds
Country, Language (app and reports) and a calling-code select beside the phone (1M8-214, 1M8-220). Phones are sent as
E.164 with the national trunk 0 dropped; the client minimum is 8 digits after `+`, as on the server. The server also
builds E.164 from `phone_country`/`signup_country` when a national number arrives. The chosen language is saved on the
default branch as `localization.locale`; report localization is enabled whenever the country is not US or the language
is not en-US.

**Onboarding and ordering.** The wizard's load page, bonus text and auto top-up summary use `PlatformCommerce` instead
of a hard-coded `$` (1M8-215). Project-type cards quote the chosen address as soon as it is picked, before a type is
chosen (1M8-216). 1M8-217/219 follow from the profile: a EUR organization gets EUR prices and EUR Stripe checkout.

**Operator reassignment.** Prices page card and `GET|POST /v1/firstmeasure/admin/prices/organizations/:org/commercial-profile`
(full internal admins). Refused with `commercial_profile_in_use` once the organization has a credit ledger entry, a
non-zero balance, a fulfilled Stripe session, billing events, or platform-billing purchase/invoice/subscription/adjustment
records. The internal organization PATCH no longer writes `commercial_profile`.

**Tests.** New `tests/signup-region.test.ts` (5) passes. `npm run check`, regional-commerce (6), property-market-pricing (9),
property-market-orders (1), platform-localization (6), report-localization (1), localization-browser, signup-widget-auth
and firstmeasure-localization-display pass. localization-api, platform-phone-auth (stale error text) and
platform-google-auth (Windows EPERM on temp cleanup) fail identically on unmodified `72cd1962`.

**Rollout.** Generated localization files were replayed onto each host's live copy (`output/europe-signup-20261021/replay.py`):
the catalog manifest keeps every live namespace except onboarding and the new signup-region; `coverage.json` stays live.
- Worker activated `45143009` first. Another session then activated `039723d8` on the worker, built on top of it; the
  worker's live `api.ts`, `signup-options.ts`, `reassign.ts`, `pricing_admin.ts`, `regions.ts` and their dist files
  carry this change.
- Legacy, web and pool: the first legacy stage was OOM-killed during `tsc` (other sessions' `tsc` runs on the 4 GB host)
  and two activations were refused because other releases went live in between. The half-staged directories were
  renamed `45143009…-aside-1`. The final run staged and activated all three, and each verifies on `45143009`.

**Checked on dev.** `signup-options` from an America/New_York browser detects US (dev has no edge country header, which
is how the original tester got USD). A legacy-action signup choosing France and French from that browser produced a EUR
profile (€25/€50/€5), `fr-FR` metric localization, phone `+336…`, a €25 standard quote for a Paris address, and a Stripe
test checkout session in `eur` for €100.00. The login page shows the three selects, and choosing France switches the
calling code to +33 and the language to Français. Production was not changed.
