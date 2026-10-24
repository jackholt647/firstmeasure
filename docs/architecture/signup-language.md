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

## The form embedded on the websites

A website page embeds the app's own signup form instead of a copy:

```html
<div data-firstmate-signup data-mode="register" data-landing-variant="…" data-submit-label="…"></div>
<script src="https://app.1m8.ai/portal/landing/shared/signup-widget.js" defer></script>
```

On dev, the script comes from `https://dev.1m8.ai`. The form renders on the website page and calls the API of the app
its script came from, cross-origin with credentials.

**Why a script and not an iframe.** 1m8.ai, www.1m8.ai and eu.1m8.ai are the same site as app.1m8.ai, so the app's
SameSite=Lax session cookie set by the signup request is kept. Third-party cookie blocking, including Safari's, does
not apply. The Meta pixel and Google conversion events also stay on the host page, and no framing headers need
loosening.

**Origins.** `/v1/platform/auth/*` answers a browser that names another origin only when that origin is one of:

- the app's own host;
- the configured CORS origins;
- `SIGNUP_EMBED_ORIGINS`, which defaults to `https://1m8.ai,https://www.1m8.ai,https://eu.1m8.ai`.

Every other origin gets `403 origin_not_allowed` (`commerce/signup-embed.ts`). CSRF for signed-in routes is unchanged:
the CSRF cookie is only readable on the app origin. A `redirect` after signup must stay in the app or on the page's
own origin.

**Assets.** The app's static files carry no CORS headers, so an embedded form loads two read-only assets through the
API:

- the signup language catalogs, `GET /auth/signup-catalogs` (English plus the page's language only);
- the phone example numbers, `GET /auth/phone-examples`.

**Host page.** The host page's own `<html lang>` is never changed. Its language counts as a hand-off when the page is
not English or was translated by the browser.

**Campaigns.** Landing pages keep their hidden fields: referral, campaign, Meta click and browser ids, bonus token and
landing variant. With `data-require-bonus="true"`, an account is never created without the promised bonus.

`tests/signup-embed-browser.test.mjs` checks this from fake website origins:

- signup in es, fr and en-GB, landing signed in, with attribution kept;
- a disallowed origin is refused;
- the redirect stays in the app;
- the bonus guard holds;
- signup still works with third-party cookies blocked, with a cross-site control case.
