# 1M8-240 follow-up: the app's signup form embedded on the websites - development, October 23, 2026

Source `c17c3797` on `claude/signup-embed-20261023`, cut from `codex/hotfix-20261023r` (`08ffcf8b`; production runs
`bf8a99a8`). The design is in [signup language](../../docs/architecture/signup-language.md#the-form-embedded-on-the-websites).

## Request

Jack: "Yes: make the app's signup form embeddable on the websites (dev and tests first, safe cross-site setup), then
switch the 1m8.ai Spanish, Meta and multi-family pages and the eu.1m8.ai uk/uk2 pages to it, one site at a time with
rollback." This record covers the app side only. The websites are unchanged until production has this release.

## Change

- **Embedding.** A website page embeds the real form: a `data-firstmate-signup` element plus
  `<script src="https://app.1m8.ai/portal/landing/shared/signup-widget.js" defer>`. The widget calls the API of the
  app its script came from.
- **Why a script and not an iframe.** The websites are the same site as app.1m8.ai, so the SameSite=Lax session
  cookie survives and Safari's third-party blocking doesn't apply. The pixel events stay on the host page.
- **Origin allowlist** (`commerce/signup-embed.ts`). `/v1/platform/auth/*` only answers:
  - its own host;
  - the configured CORS origins;
  - `SIGNUP_EMBED_ORIGINS`, default `https://1m8.ai,https://www.1m8.ai,https://eu.1m8.ai`.

  Any other origin gets `403 origin_not_allowed`.
- **Assets through the API.** Static files have no CORS, so two read-only endpoints serve them:
  - `GET /auth/signup-catalogs`: English plus the requested language only;
  - `GET /auth/phone-examples`.
- **Widget.**
  - It leaves the host page's `<html lang>` alone, and counts it as the hand-off language when it isn't English
    or the browser translated it.
  - A `redirect` only goes back into the app or to the page's own site.
  - It carries over the website copies' `data-require-bonus` guard and `acquisition_code`.
  - One new key, `signup.err_bonus_unconfirmed`, is translated in all 15 non-English packs.

## Tests

- `signup-embed-browser`: 10 pass.
  - Website-origin signups in es (from the page's `es-US`), fr (`?lang=fr`) and en-GB (eu.1m8.ai from GB).
  - Each one lands signed in on app.1m8.ai.
  - Campaign, landing variant, bonus token and Meta click id are all kept.
  - Every call from a disallowed origin gets 403, including lookalikes such as `https://1m8.ai.evil.example`.
  - A redirect pointing at another site is not followed.
  - The bonus guard refuses to create an account.
  - With Chromium blocking third-party cookies, the signup still lands signed in. A cross-site control origin
    loses its cookie, which shows the check would catch the problem.
- `signup-language-browser`: 22 pass. Its proxy now sends `Host`, as nginx does.
- These pass:
  - `signup-language-catalog` 4, `signup-region` 9, `phone-input-browser` 5;
  - `portal-auth-errors` 6, `signup-widget-auth` 2;
  - `login-billboard` 4, `account-access-browser` 4, `localization-browser` 1;
  - `integrations` 20, `materials-api` 11;
  - `access-gates` 1, with the snapshot updated for the two new public routes.
- `npm run check` passes.
- `experimental-accounts` fails on a module path under the temp folder; that looks unrelated and was not checked
  on the base.

## Rollout

The rollout used `output/signup-language-20261023/` onto worker, legacy and web; verify exited 0. The dev pool node
is still unreachable.

## Checks on dev

- `signup-options` from the 1m8.ai, www, eu and dev origins answers 200 with that origin allowed.
- From `https://evil.example`, it answers 403.
- The catalog endpoint returns only `en-US` and `es-ES`.
- The examples endpoint returns GB `7400123456` and ES `612345678`.
- In a browser on the live `https://1m8.ai/landing/espanol/`, the dev form was injected (nothing was submitted):
  - it rendered in Spanish ("Crear cuenta", "Empezar a pedir informes", Spanish terms);
  - `signup_language` was `es-ES`, and the page kept its own `<html lang>` (`es-US`);
  - the only control was the calling-code picker.

## Next

After production has this release, switch the website pages to the app form, one site at a time. That is not done
here.
