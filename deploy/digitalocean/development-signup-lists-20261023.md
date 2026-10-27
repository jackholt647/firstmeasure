# Signup country, language and phone example (1M8-240, second review) — development, October 23, 2026

Source `eef3b3fa` on the session branch `claude/phone-countries-3-20261023`, cut from `codex/hotfix-20261023o`
(`afa31161`, production `aa66cd9b`). Not merged; production was not changed.

Ben's comments: "It is still showing the preview of the formatting for a US number despite a UK number being selected" (his
screenshot: GB +44 with the placeholder `(555) 555-0123`, and a second with 23 digits typed), and "Do the same thing for the
country dropdown and the language dropdown so that both of those are styled better and only show relevant countries and
languages".

**The example number.** signup-region.js set the phone placeholder from the Country select (`(555) 555-0123` for any +1
country) and never from the calling code. The phone input now owns it: the chosen calling code's example mobile number in
that country's national format (libphonenumber `examples.mobile.json`, vendored beside the library): GB `07400 123456`,
Sweden `070-123 45 67`, US `(201) 555-0123`. It changes with the calling code and with the country. Digits beyond the
longest number the country has are not taken.

**Country and language lists.** The styled list is now the shared `libraries/select-list` (`FirstMateSelectList`), used by
the calling code, Country and Language on login.php and the signup widget (the only places these selects appear). The
native selects stay hidden in the form. Country offers the same `operating_countries` as the calling code (one list,
`commerce/region-data.json`), by name; `/auth/signup-options` returns it as `operating_countries`. A detected country
outside the list is not preselected ("Choose your country"); `detected_country` still reports it. Choosing a country moves
the language, the calling code and the example with it.

**Languages.** The packs the operating countries use: each country's regional language (`regionLanguage`, the same choice
the billing profile makes), `signupLanguages()` in signup-options.ts. All 17 packs qualify today: English (US) (US, CA),
English (UK) (GB, IE), Português (Brasil) (PT, the only Portuguese pack), Español (ES), Français (FR), Italiano (IT),
Ελληνικά (GR), Deutsch (AT, CH), Dansk (DK), Polski (PL), Čeština (CZ), Nederlands (NL, BE), Norsk (NO), Svenska (SE),
Lietuvių (LT), Suomi (FI), 日本語 (JP). A pack no operating country uses would not be offered.

**Server.** `/auth/register`, the legacy register action and Google signup refuse a chosen `signup_country` outside the
list: 400 `signup_country_unavailable`, "FirstMate is not available in that country yet. Choose one of the countries
listed." (login.php and the widget show it). A signup that sends no country keeps the existing detection, so API clients
and existing organizations are unaffected. Phone validation is unchanged.

**Note for Ben/Jack.** Germany is not on Ben's list (Austria and Switzerland are), so German visitors are no longer
preselected; adding it is one line in `operating_countries`.

**Tests.** `phone-input-browser.test.mjs` (5, Chrome) and `signup-region.test.ts` (+2; the Berlin case now expects no
preselection). `npm run check`, organization-country, signup-widget-auth and platform-localization pass; europe-pricing
has one regex failure on `project-request/app.js`, which this change does not touch.

**Rollout.** `output/phone-countries-5-20261023/`: worker, legacy and web, every file merged cleanly onto `7e3ddeb8` /
`ab63b371`, activated and verified on `eef3b3fa`. Pool is still unreachable.

**Checked on dev.1m8.ai.** login.php, Create Account. New York: Country "United States" (21), Language "English (US)" (17),
calling code US +1, placeholder `(201) 555-0123`; choosing GB as the calling code changes the placeholder to `07400 123456`
and typing gives `020 7946 0123` with the extra digits refused. Stockholm: Sverige, Svenska, SE +46, `070-123 45 67`.
Berlin: "Choose your country", Deutsch. Registering with `signup_country: AU` returns 400 `signup_country_unavailable`.
No page errors.
