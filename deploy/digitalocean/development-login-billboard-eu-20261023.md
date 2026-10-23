# European login billboard on dev (October 23, 2026)

Release `f4c4600e` on branch `claude/kind-ishizaka-2fffa9`, cut from production `6e8093f7`
(`codex/hotfix-20261023i`). Not on production; not on the canonical branch.

## Problem

Production's `public/portal/login.php` framed `https://eu.1m8.ai/billboards/login` for known
international visitors (country headers, `X-FirstMate-Region: EU`, or browser time zone/locale).
`eu.1m8.ai` is a separate website host (Apache, 157.230.121.5) that never published that page:
it answers 404 with and without the trailing slash, so European visitors saw "Not Found" in the
left panel. `https://1m8.ai/billboards/login/` answers 200 (the bare path 301s to the slash) and its
content ("Coming Soon: Full Exterior Measurements") is not regional. The signup widget has no billboard.

## Change

- `portal/marketing/billboard_source.php`: one URL, `https://1m8.ai/billboards/login/`, for every
  visitor. The per-region choice and the `X-FirstMate-Region` billboard override are removed.
- `portal/marketing/billboard_status.php`: same-origin HEAD check of that URL, cached five minutes in
  the web host's temp directory. `{"ok":false}` only for a real 4xx/5xx; no HTTP answer returns
  `{"ok":null}` (unknown) and is not cached.
- `login.php`: the frame sits in a panel and stays transparent until it has loaded and the check has
  not said `false`. A definite failure, or no load within 10 s, removes the frame and shows a red
  FirstMate panel ("Roof and exterior measurement reports"). Styles are inline in login.php, so no
  bundle cache keys changed.
- `docs/architecture/regional-billing.md` updated.

## Tests

`public/v1/tests/login-billboard-browser.test.mjs` (new, Playwright + `php -S`): a French visitor
(Europe/Paris, fr-FR, `CF-IPCountry: FR`, `X-FirstMate-Region: EU`) gets the main billboard and no
request goes to eu.1m8.ai; a 404 billboard shows the fallback (desktop and 4:1 mobile); an unreachable
check still reveals a loading billboard; the endpoint serves a cached result. 4/4 pass, with
`account-access-browser` and `portal-auth-errors` (14/14 together).

## Rollout

`output/login-billboard-eu-20261023/` (worktree, ignored), copied from `phone-countries-2-20261023`.
PHP only, so legacy and web; the worker serves no portal PHP and pool was unreachable ("No route to
host"), as in the previous rollout. Both roles' live `login.php` matched `6e8093f7` (no drift).

| Role | Previous release | Result |
| --- | --- | --- |
| legacy | `3d1784ee` | staged, activated, verified |
| web | `3d45f7cc` | staged, activated, verified |

Rollback: `rollout.py` previous paths in `manifest.json` (`/mnt/firstmeasure_dev_releases/releases/3d1784ee…`
and `/opt/firstmeasure/releases/3d45f7cc…`).

Checked on dev.1m8.ai: `login.php` with `CF-IPCountry: FR` frames `https://1m8.ai/billboards/login/`
and contains no `eu.1m8.ai`; `portal/marketing/billboard_status.php` returns `{"ok":true}`; in the
browser the panel reaches `is-ready` and shows the billboard.

## Production notes

Ship `login.php`, `marketing/billboard_source.php` and `marketing/billboard_status.php` together. Web
hosts need outbound HTTPS to 1m8.ai for the check; without it the check reports unknown and the page
behaves as before (frame shown once it loads).
