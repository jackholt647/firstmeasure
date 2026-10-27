# 1M8-240 signup language hand-off, no dropdowns, never refused - development, October 23, 2026

Source `e7144481` and `52df0758` on `claude/signup-language-handoff-20261023`. The branch was cut from
`claude/phone-countries-3-20261023` and merged with `codex/hotfix-20261023q` (`703f27b7`) as `ed601229`. It is not
on the canonical branch, and production is unchanged. The design is in
[signup language](../../docs/architecture/signup-language.md).

## Jack's request

Remove the dropdowns and never refuse a signup. Detect the visitor's language and currency; don't ask for them. The
language a visitor already saw must carry through the landing page, login, signup and the organization, in every
FirstMeasure language. This applies to the 1m8.ai and eu.1m8.ai websites and to the old app.1m8.ai landing pages
that Meta campaigns use.

## Changes

- **Signup form.** `login.php` and the landing widget have no Country or Language dropdowns. The calling-code
  picker stays and defaults to the detected country. A detected country outside the 21 operating countries is added
  to the front of the picker; Germany, for example, is not in the list.
- **Never refused.** `signup_country_unavailable` is gone from every path: register, legacy and Google. With no
  location signal at all, the country comes from the hand-off language's region, else US.
- **Hand-off contract.** The language travels as `?lang=<tag>` and is stored in the `fm_lang` cookie
  (`Domain=.1m8.ai`, 30 days). It is resolved in this order: hand-off, then edge country, browser language, time zone.
  It is mapped onto the 17 packs and stored as the organization's company language. Currency follows location.
- **Websites.** `libraries/signup-language/handoff.js` lets the two website droplets pass on the page's language,
  including a language the browser translated the page into.
- **Translations.** A new `signup` namespace has 105 keys. Gaps in onboarding, `phone-input` and `platform-commerce`
  are filled. All of this is in all 15 non-English packs and was compiled through the catalog pipeline. The Meta
  pages' own "Start Ordering Reports" button is translated too. The English-only `{v0} invite{v1} sent.` key is
  replaced by the ICU plural `onboarding.invites_sent`.

## Tests

| Test | Result |
| --- | --- |
| `signup-language-catalog.test.mjs`: every key in every pack, no raw placeholders, every page key catalogued, no dropdowns | 4 pass |
| `signup-language-browser.test.mjs`: 1m8.ai, eu.1m8.ai and app.1m8.ai Meta landing, each in es, fr and de, from landing to organization language, onboarding text and currency, plus hand-off beating location | 13 pass |
| `signup-region.test.ts`: never refused (chosen, detected, missing or unknown country), resolution order, hand-off to organization | 9 pass |
| `phone-input-browser`, `portal-auth-errors`, `signup-widget-auth`, `regional-commerce` (both), `organization-country`, `platform-localization`, `login-billboard`, `vat-label-credits`, `account-*` | pass |
| `npm run check` | passes |

These failures existed before this change and are unrelated to it:

- `europe-pricing`: the project-request VAT regex;
- `localization-api`: `report_localization` now defaults on, so a 403 is expected but a 200 comes back;
- `full-house-address-php`;
- `localization-catalogs --check`: it lists unmigrated literals in about 112 other files.

## Rollout

The rollout used `output/signup-language-20261023/`, with two runs onto the live release on worker, legacy and web.
Both runs verified with exit 0.

- **Catalog manifest, catalog source and packs.** These were replayed key by key onto each host's live files: only
  the 1M8-240 namespaces and keys were added or removed, and other sessions' translations were kept.
- **Widget.** Hosts declared two library promises in a different order. The release copy was shipped in the hosts'
  order.
- **Pool node.** The dev pool node (10.124.16.3) is still unreachable ("No route to host") and was not updated.

## Checked on dev

- `GET /v1/platform/auth/signup-options?lang=es` returns `es-ES` from the `handoff`.
- With `time_zone=Europe/Berlin`, the detected country is DE, the price is €25 VAT included, and DE is first in
  the picker.
- `https://dev.1m8.ai/portal/login.php?start=register&lang=fr` is in French with no dropdowns.
- `https://dev.1m8.ai/portal/landing/variants/meta-619a/?lang=es&cid=meta`:
  - the tab reads "Crear cuenta";
  - the button reads "Empezar a pedir informes";
  - `signup_language` is `es-ES`;
  - `fm_lang=es` is set.
- `https://dev.1m8.ai/libraries/signup-language/handoff.js` returns 200.

## Not covered here

- **Website droplets.** Every 1m8.ai and eu.1m8.ai page needs
  `<script src="https://app.1m8.ai/libraries/signup-language/handoff.js" defer></script>`. Their source is not in
  this repository and nothing was deployed to them. Until the tag is added, a visitor from those sites still gets
  their browser language and location.
- **Landing page copy.** The app.1m8.ai landing pages' own text (hero, "$7") is still English; only the signup
  widget is translated.
- **Google button.** Google renders the "Sign up with Google" button in its own language.

## Follow-up: phone format follows the calling code (`01953359`, legacy and web)

Jack asked that the calling code be detected like the language, and that the example, typing format and length
follow whichever code is selected; production still showed the US "(555) 555-0123".

- **Calling code.** The code is preselected from the same detection as the language: edge country, then browser
  language and time zone, then the hand-off language's region.
  - A detected country outside the 21 is added to the front of the picker, not replaced by US.
  - From a US connection, `?lang=sv` keeps +1: language does not decide the code.
- **Example.** `login.php` and the landing widget no longer ship a hard-coded US placeholder. That placeholder showed
  until detection finished. The example is now always the selected code's, from libphonenumber.
- **Typing.** Typing keeps the selected country's national format. A digit that would turn a formatted number back
  into bare digits is refused; before, Sweden and Germany let extra digits through and lost their format.
- **Tests.** `signup-language-browser.test.mjs` now has 22 checks. It adds GB, SE, DE and ES edges on both
  `login.php` and the app landing widget, checking for each:
  - the preselected code;
  - that country's example;
  - the typed format and the length;
  - that switching codes reformats both the example and the number.

  `phone-input-browser` still passes (5 pass).
- **Checked on dev.** On `login.php` from a US connection, the code is +1 with the example "(201) 555-0123".
  Picking SE changes the example to "070-123 45 67" and formats the typed number as "070-123 45 67"; the 11th digit
  is refused.
- **Rollout.** The worker was not part of this run because these are frontend-only files; its verify failure is
  expected.
