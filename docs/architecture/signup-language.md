# Signup language hand-off (1M8-240)

A visitor is never asked for a country or a language, and a signup is never refused for
where it comes from. The language they already saw follows them from the landing page to
the login page, the signup, onboarding and the organization they create. Currency follows
their location; the card's country settles VAT later.

## The contract

- **`?lang=<tag>`** on any app URL (`/portal/login.php`, `/portal/landing/...`). It accepts any
  BCP 47 tag.
- **`fm_lang` cookie**, set the first time a page sees `?lang`: `Domain=.1m8.ai`, `Path=/`,
  30 days, `SameSite=Lax`, and `Secure` on https. Later app pages read it when the URL has
  no `lang`.
- The tag maps onto a shipped language pack (`commerce/regions.ts` `supportedLanguage`):
  - an exact pack wins;
  - otherwise the same language is used: `es-MX` → `es-ES`, `pt-PT` → `pt-BR`, `de-AT`/`de-CH` → `de-DE`, `no`/`nn` → `nb-NO`;
  - English is `en-GB` outside the Americas and `en-US` inside them.
  
  A language without a pack is ignored, and detection continues.
- **Resolution order** (`resolveSignupLanguage`): the hand-off first, then the edge country
  header (`cf-ipcountry`, …), the browser's languages and finally the time zone's country.
  With none of these, the language is `en-US`.

`GET /v1/platform/auth/signup-options` returns `language` and `language_source`, with the
calling-code list. The detected country comes first in that list, even when it is outside
the operating countries. The signup forms send the resolved language as `signup_language`.
Registration (`register`, `legacy-action`, Google) stores it as the organization's company
language, with report localization on.

The country of record and the currency come from location:

1. a chosen country;
2. the edge header;
3. the time zone;
4. a North American phone number;
5. the hand-off language's region;
6. if none of these, `US`.

## Pages

- `public/libraries/signup-language/signup-language.js` resolves the language, loads the
  `signup` catalog and translates elements marked with `data-i18n` (with `-placeholder`,
  `-aria-label` and `-title` variants). It also adds `lang` to `/portal/` links. Both
  `login.php` and the landing widget (`portal/landing/shared/signup-widget.js`, used by
  every `app.1m8.ai/portal/landing` variant, including Meta's) use it.
- `public/libraries/signup-language/handoff.js` is for the websites (1m8.ai and eu.1m8.ai,
  which are separate droplets and not in this repository). When a visitor clicks a link to
  app.1m8.ai, it passes on the page's language: the language the browser translated the
  page into, or the page's own non-English `<html lang>`. Each website page needs:

  ```html
  <script src="https://app.1m8.ai/libraries/signup-language/handoff.js" defer></script>
  ```

  A website that serves its own translations can instead add `?lang=<tag>` to its app links.

## Translations

The `signup` namespace and the onboarding, `phone-input` and `signup-region` keys exist in
every language pack. `tests/signup-language-catalog.test.mjs` fails when:

- a pack is missing a key;
- a translation changes or leaves a placeholder raw;
- a page uses a key the catalog lacks.

`tests/signup-language-browser.test.mjs` runs each landing source in es, fr and de, from
the landing page through to the organization.
