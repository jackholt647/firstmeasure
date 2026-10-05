# Regional billing and property markets

## Current roof-report policy — October 5, 2026

The shared market boundary is **US/Canada versus every other country**. The UK,
Switzerland, Japan and Australia are international; EU membership is irrelevant.
`commerce/region-data.json` owns the domestic-country list and IANA time-zone
map used by signup and the login billboard.

| Account | Property | Standard roof report | Gutter add-on | Currency |
| --- | --- | --- | --- | --- |
| US/Canada | US/Canada | Existing rates: residential 7; commercial/multifamily 12 per structure | 2 | USD |
| US/Canada | Any other country | 21 | 2 | USD |
| International | Anywhere | 20 | 2 | EUR |

International commercial/multifamily prices are per structure. Residential keeps
its existing flat-report/structure allowance. International-priced rush
**surcharges** are 2.5 times the corresponding US surcharge, rounded to cents,
then added to 20 EUR or 21 USD. A free-rush entitlement discounts only that
surcharge, never the international base. US/Canada pricing is unchanged.
Weather, instant-preview add-ons, full-house base rates and subscription rates
retain their existing separate policies; this change targets full roof reports
and the gutter add-on.

There is no currency conversion at order time. Location may raise a domestic
account's price but cannot lower an international account's price. Stripe
funding and the prepaid ledger remain in the organization's currency.

## Region detection and presentation

Signup resolves country from country headers (`CF-IPCountry`, then
`X-Vercel-IP-Country`, then `X-AppEngine-Country`), browser time zone, browser
locale region, and the existing North American phone fallback. New US/Canada
accounts receive USD; every other country receives EUR, including the UK.
Non-US accounts default to metric; US accounts default to imperial. Language
comes from installed packs in `platform/localization/languages.json` and is
independent of billing currency.

The login embeds `https://1m8.ai/billboards/login` for US/Canada and
`https://eu.1m8.ai/billboards/login` for known international visitors.
`X-FirstMate-Region: EU` or `EUROPE` forces the international billboard only.
It never changes account country, currency or prices. Unknown visitors use the
main billboard until a country is resolved. Browser and password/Google signup
use the same time-zone/country data. Both signup paths send browser hints.

The website owns all billboard content and internal padding. The app provides
a rounded, zero-padding, non-scrolling frame, 16:10 on desktop and 4:1 at
viewport widths up to 760px. The external pages returned 404 during rollout;
the website team still must publish them.

## Property verification and charge safety

`commerce/property-market.ts` resolves the actual order coordinates (or address)
through the server's Google geocoder. Client `country` and `address_components`
values cannot authorize domestic pricing. Successful results are cached for
five minutes, with bounded in-memory storage; unavailable/unknown countries
stop an order before charging. Multiple pins cannot combine domestic and
international markets in one order.

Portal and public-API quotes and orders use the same pricing context. Portal
quotes refresh on address/type/structure changes and discard stale responses.
Ordering waits for a verified quote. New international prices require
`report_market_revision: 1`; API pricing responses expose this value. Existing
commercial and rush-pricing revision checks remain in force. Follow-up and
rush upgrades re-resolve the stored property's location. Reports and ledger
metadata retain property country and account currency.

The map's Google address components now retain country instead of discarding
it. These components are useful UI metadata, while server geocoding remains
authoritative for charging.

## Continuous operations

The evening closure banner and time-of-day rush restrictions are removed.
Roof and full-house ordering remain available 24/7. Existing SLA turnaround,
workload estimates, QA requirements and release scheduling remain; none is an
"office closed" gate. Existing held deliveries are not bulk-replayed.

## Accounting continuity and protections

A commercial profile is assigned at signup and protected from customer global
writes. Travel, browser language and the billboard header never reassign it.
Existing prepaid funds and accepted subscriptions are not silently converted or
repriced. Development was audited before rollout: no saved international
profiles required currency migration. Production was not changed; before a
future production rollout, audit legacy international profiles/balances and
agree any migration explicitly. Unprofiled legacy accounts retain USD.

Order units follow explicit order choice, then branch defaults, then company
defaults when localization is enabled. Saved orders retain their units. Feature
flags continue to govern customization. All installed report locales are
accepted consistently at both ordering APIs.

Payment fulfillment still validates amount/currency and replay protection;
accepted subscription prices remain snapshotted. Geographic hints at signup
are not verified residency: edge headers must be overwritten by trusted
infrastructure. Property-country verification protects report pricing without
asserting where the account owner resides.

## Verification

Run `npm run check` in `public/v1`. Focused tests include
`property-market-pricing.test.ts`, `property-market-orders.test.ts`,
`regional-commerce.test.ts`, `report-localization.test.ts`,
`firstmeasure-expedite.test.ts`, `expedite-workload.test.ts`, and
`exteriors-order.test.ts`. Payment and geocoder tests use provider fixtures;
no real card charges or customer messages are needed.
