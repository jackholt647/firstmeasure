# Production release 3c749b00: signup country detection (FM-334), November 5, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. It is production-live `bd83fbb0` (release
`73ff28d0`) plus one commit, `3c749b00`: the dev commit `a8195b7b` cherry-picked unchanged (identical diff), verified
on dev in `platform-20261105025158-1afd1951`.

## Change (Node only)

- `public/v1/commerce/regions.ts`: `detectSignupCountry` checks a North American (+1) phone before the nginx IP
  country (DB-IP, `CF-IPCountry`). The area code picks US, Canada or the Caribbean country that owns it
  (`libphonenumber-js/min`, already a dependency); an unassigned +1 area code counts as the US. Order: choice -> +1
  phone -> IP -> time zone -> browser locale -> page language -> US. New signups only; no account is re-detected.
- `public/v1/commerce/reassign.ts`: `commercialProfileLock` no longer counts billing events that move no money
  (Stripe customer created, card saved, failed or attempted top-ups). A successful top-up and unknown event types
  still lock.
- `public/v1/internal/api.ts`: the staff org detail keeps the summary's `country`, `country_name` and
  `country_source` instead of the stored country record ("Colombia ([object Object])").
- Tests and two architecture docs. No PHP, browser file, schema, configuration or data change.

## Checks before release

- Dev: router regression passed (type check, signup-region, organization-country, regional-commerce,
  property-market-orders, route-access); a real dev signup with a +1 416 number, Bogota time zone and es-CO locale
  became CA / USD / `north_american_phone`.
- Build on the dev worker (`npm run check` included) in 276 s. Archive sha256
  `5361d6b9b1a63316629b4e22f9d4932bd0f66cfe7c78e221ffe7135897af4ac9`.

## Rollout (scripts: fm-agents /srv/agents/work/fm-334-prodrun-scripts)

- Rollback target before activation: `73ff28d0cb242ea3d50980fe209c511969023121`, every host's `current` at 02:57 and
  again just before install; recorded on FM-334.
- Compatibility at 03:03:18 UTC: active, no 500s and no worker exits in the first 20 s.
- Worker at 03:04:13 UTC, after no jobs were running: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `e0d1e105…` (73ff28d0's archive). All six web nodes downloaded
  `3c749b00` / `5361d6b9` from it.
- Six web nodes one at a time behind the load balancer, 03:05:09–03:19:32 UTC (about 94 s each), each asset-checked
  as in 73ff28d0's run plus the FM-334 build (`northAmericanPhoneCountry`, `NO_CHARGE_BILLING_EVENTS`,
  `country: summary.country`).

## After activation

- Public readiness answered `3c749b00` on 12 of 12 requests (all six instances); all eight hosts point `current` at
  it, with the expected service active on each.
- `GET /v1/platform/auth/signup-options` answers 200 with `detected_country`.
- Deployed `detectSignupCountry` on a web node and compatibility: CO IP + `+12125550123` -> US
  (`north_american_phone`); DE IP + `+4915123456789` -> DE (`cf-ipcountry`); DE IP + `+14165550123` -> CA;
  `+18095550123` -> DO.
- `commercialProfileLock("org_561daf42f9df71c6")` (Pro Lux) on the worker: `"stripe_charges"` on 73ff28d0 before the
  release, `""` after. Read only; nothing was reassigned.
- Web nodes since 03:05: 1–7 5xx of about 12,000 requests each (0.01–0.06 %, down from 0.28–0.46 % in the 30 minutes
  before). All but two are `top_view_reroll_proxy.php` (failing before this release); the two are
  `/v1/platform/acquisition/public/track`.
- Compatibility Node: 3 500s at the 03:03:18 restart, then 11 at 03:04:47 from a 20 s database pool wait ("timeout
  exceeded when trying to connect", pool 12/12 busy, 20 waiting) just after the worker restart. The same pool timeouts
  appear before this release (11/04 13:32, 14:34, 15:42; 11/05 00:30, 00:40), and compat's pool saturates often on
  73ff28d0 too. No compat 500s since 03:05. Not caused by this change; worth its own look.
- Jobs since the worker activation: completed 111 (imagery.process, pdf.sync, report.delivery, report.release),
  2 running. 260 `report.release` jobs queued with none due yet (252 queued before activation).
- Not checked: a real production signup with a +1 phone after activation.

## Left for staff (not done by the release)

Staff re-save **United States** on Pro Lux (`org_561daf42f9df71c6`) and R. Cooper in the staff customer page; billing
then moves to USD. No production data was changed by this run.

## Rollback

`73ff28d0cb242ea3d50980fe209c511969023121` is still installed on every host: activate it on compatibility, the worker
and each web node one at a time with `activate-release.sh`, and republish the channel against `5361d6b9…`.
