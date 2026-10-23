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
