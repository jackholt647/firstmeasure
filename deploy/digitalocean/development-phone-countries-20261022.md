# Phone country codes: served countries, formatting and preview (1M8-240) — development, October 22–23, 2026

Source `01f5e5c2` on the session branch `claude/phone-countries-20261022`, cut from `codex/hotfix-20261023g` (`f3cfb2de`,
production `242fba6c`). Not merged; production was not changed.

**Too many options.** The calling-code select listed every country with a calling code (about 245), from
`/auth/signup-options` `countries`. The options now carry `phone_countries`: the countries the platform serves,
`SERVED_COUNTRIES` in commerce/regions.ts, derived from the region data (the domestic market, US and CA, plus every
country on a `Europe/*` time zone: the EU, UK, Switzerland, Norway and the rest of geographic Europe), 52 in all. The
detected country comes first and is offered even outside them, then US and CA, then by name. The account Country select
still lists every country. Iceland (Atlantic/Reykjavik) is not included by this rule; changing the rule is one line.

**Formatting and preview.** New shared `libraries/phone-input/phone-input.js` (`FirstMatePhoneInput.attach`): the number
is formatted for the chosen country as it is typed (020 7946 0958, (555) 555-0123), "Saved as +44 20 7946 0958" shows
under the field, E.164 is what is submitted, and typing + and a calling code picks that country. Formatting uses
libphonenumber-js 1.12.31, the server's own dependency, vendored for the browser in `libraries/vendor/libphonenumber-js-1.12.31`
(MIT). Validity is the server's existing rule (8–15 digits, ten for +1), so the client and server agree. A stored +1
number reads (555) 555-0123; a ten-digit US number without a code still saves as +1. The worker has no
libphonenumber-js installed, so the server's E.164 conversion is unchanged (the browser always sends E.164).

**Where.** The picker lives in signup-region.js (login.php and the signup widget), now through the shared component; no
other portal form has a calling-code picker (the comms dialer in phone-tray.js is a separate control). New language
namespace `phone-input`. signup-region.js is cache-busted in the widget (`?v=20261022-phone-countries-v1`; on dev
`20261023-minimal-phone`); login.php on dev already versions it by file hash.

**Tests.** `phone-input-browser.test.mjs` (3, Chrome: formatting, preview, E.164, +CC switching, backspace, a stored US
number, the signup picker with served countries) and `signup-region.test.ts` (+1: served list, detected first, Japan
offered only when detected). `npm run check`, signup-widget-auth, platform-localization, localization-browser and the
login-page suites pass.

**Rollout** (`output/phone-countries-20261022/`). Dev runs the Europe session's minimal signup (1M8-239, `d8e2243f`), which
rewrote signup-region.js, signup-options.ts and the widget's cache key; this release's edits were replayed onto those live
files (replay.py, exact replacements), login.php kept live, and the language manifest only gained `phone-input`. Pool
(10.124.16.3) did not answer (no route to host), as for other rollouts today; worker, legacy and web were released. Two
attempts were refused because other releases went live in between; the third staged, activated and verified `01f5e5c2`
on worker, legacy and web (on top of `a92e9f27`). The public endpoint returned 503 for about a minute after web's restart
while it was the only node behind the load balancer.

**Checked on dev.1m8.ai.** From a London browser `signup-options` detects GB and offers 52 calling codes (GB, US, CA
first; no Japan). The served picker on the login page: GB +44 selected, 02079460958 shows "020 7946 0958" and "Saved as +44
20 7946 0958" and submits +442079460958; US 5555550123 shows "(555) 555-0123" and submits +15555550123. On dev the minimal
signup has no phone field, so the picker is not visible in the signup form there until 1M8-239 is decided.

## Second rollout, October 23: production's signup form back on dev (1M8-239 removed)

Ben deleted 1M8-239, so its minimal signup will not ship. Dev now shows production's signup form (country, language,
mobile with the calling-code picker, confirm password) instead of the 1M8-239 review form, with 1M8-240 on it.

**What was removed from dev.** Every change of the 1M8-239 commit `d8e2243f` except its new test file: the minimal
login.php and signup-widget.js forms, signup-region.js's compact summary, the optional phone on the first onboarding step
(wizard.js) and its bundle key, `/auth/register` and the legacy register action accepting a signup without a phone
(platform/api.ts; a phone is required again), the billing currency in `/auth/signup-options` (signup-options.ts), and its
onboarding and signup-region language catalogs (the manifest points at production's catalogs again).

**How.** `output/phone-countries-2-20261023/revert239.py` rewrites each role's downloaded live copy before the build: a
three-way merge from `d8e2243f` back to its parent `f3cfb2de` (production's form), so later sessions' edits stay.
signup-region.js and signup-options.ts were exactly 1M8-239's versions (plus the first 1M8-240 replay) and were set to
production's; in login.php and the widget only the signup-region.js cache-key lines conflicted and took production's side.
1M8-240 (`01f5e5c2`) was then merged onto the result. The language manifest keeps every other live namespace.

**Release.** `01f5e5c2` again, rebuilt. Pool is still unreachable. One build produced an empty compiled `api.js`
(a stopped earlier build was still writing), and worker staging refused it on the hash check; the build now asserts every
compiled file is non-empty. Other sessions' activations refused three attempts; worker and legacy then activated, web
then refused because another release went live there; a web-only run staged, activated and verified it. Web and worker run
`01f5e5c2`; legacy has since moved to `4cf68f77`, another session's release built on this one (no onboarding phone,
`phone_countries` present).

**Checked on dev.1m8.ai.** login.php, Create Account, from a London browser: Country, Language, Phone (GB +44 of 52
calling codes), Email, Password, Confirm Password; typing 07700900123 shows "07700 900123" and "Saved as +44 7700 900123".
From a New York browser: US +1, "(555) 555-0123", "Saved as +1 555 555 0123". No page errors. The served wizard.js has no
onboarding phone. Not changed here: European visitors' login billboard (`https://eu.1m8.ai/billboards/login`, production's
login.php) answers 404 from the marketing site.

