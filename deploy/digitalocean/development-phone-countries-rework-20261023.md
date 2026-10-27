# Phone picker rework after Ben's review (1M8-240) — development, October 23, 2026

Source `ab63b371` and follow-up `ffbdfc29` on the session branch `claude/phone-countries-2-20261023`, cut from
`codex/release-20261023m` (`36786714`, production `67cb3617`). Not merged; production was not changed.

Ben sent 1M8-240 back from Testing in Prod with three comments: drop the "Saved as" line and format the field itself for the
chosen country; use each country's local style (United Kingdom 020 7946 0123, Sweden 070-123 45 67); and offer only the
countries he listed, in a better-styled dropdown.

**National format in the field.** The "Saved as +44 ..." line is gone. The field shows the number in the chosen country's
national format as it is typed (libphonenumber AsYouType): `020 7946 0123`, `070-123 45 67`, `(555) 555-0123`, exactly as
Ben wrote them. E.164 is still what is submitted; the server's validation is unchanged (8-15 digits, ten for +1). A
stored +1 number reads `(555) 555-0123`, a bare ten-digit US number still saves as +1, and a stored number from a country
not offered keeps its international format and value. Digits typed before the formatting library has loaded are
formatted when it arrives.

**Ben's countries.** From the 1M8-240 description ("These are the countries we are operating in"): Portugal, Spain,
France, Ireland, UK, Italy, Greece, Austria, Denmark, Poland (listed twice), Czechia, Switzerland, Belgium, Netherlands,
Norway, Sweden, Lithuania, Finland, Japan, United States, Canada: 21 countries. They are `operating_countries` in
`commerce/region-data.json` (`OPERATING_COUNTRIES` in regions.ts), the country-rules data, not a list in the component.
The detected country comes first, then US and CA, then by name; a detected country outside the list is no longer added.
The account Country select still lists every country.

**The dropdown.** No shared select component exists to reuse (settings and the order form use native selects), and the
signup pages load no portal libraries, so the picker is a listbox in the app's menu style (the account switcher's white
card, 12px radius and shadow, hover and selected rows) showing code, country name and calling code. The button matches
the phone field's height and corners. Arrow keys, Home/End, Enter, Escape and type-ahead by name work; the native select
stays hidden as the submitted `phone_country`. Language keys `phone-input.calling_code` and `calling_code_value`.

**Tests.** `phone-input-browser.test.mjs` (4, Chrome: UK and Sweden as Ben wrote them, US, no preview line, the styled
list and keyboard, stored numbers, the signup form with the reduced list) and `signup-region.test.ts` (the exact 21).
`npm run check`, signup-widget-auth, platform-localization, localization-browser and the login-page suites pass;
`login-billboard-browser` has one failure that also fails on `36786714`.

**Rollout.** `output/phone-countries-3-20261023/` (worker, legacy, web; all files merged cleanly onto `a04e452c` /
`c38eeb44`) and `output/phone-countries-4-20261023/` (the chevron, legacy and web). Pool is still unreachable.

**Checked on dev.1m8.ai.** login.php, Create Account: from London `GB +44`, typing 02079460123 shows `020 7946 0123`; from
Stockholm `SE +46`, 0701234567 shows `070-123 45 67`; from New York `US +1`, 5555550123 shows `(555) 555-0123`. No "Saved
as" line, 21 options in the styled list, no page errors.
