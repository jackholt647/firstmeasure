# Organization regional billing

## Initial policy

| Signup country | Price schedule | Billing currency | FirstMeasure display | Initial language | Units |
| --- | --- | --- | --- | --- | --- |
| US | Base | USD | Dollars | en-US | Imperial |
| Canada | Base | USD | Dollars | en-US | Metric |
| EU | International, initially 2× base | EUR | Euros | Closest installed language, currently en-GB | Metric |
| Other countries with an officially supported local currency | International | That currency | Currency | Closest installed language | Metric |
| Other countries | International | USD | Credits | Americas en-US, otherwise en-GB until a closer pack exists | Metric |

A residential roof report is therefore $7 in the US/Canada, €14 in the EU, and
14 USD-backed credits in Japan or the UK. Add-ons, rush fees, additional
structures, exteriors, subscription base prices and metered rates use the
organization's schedule. A credit purchase itself is not multiplied: buying
50 credits purchases 50 units of the organization's billing currency, plus any
separately authorized promotional credit.

These policy names and comparisons are operator information. Customer responses
and screens show the organization's resolved price, currency and credit label.
Customer settings cannot change the assigned commercial profile. Currency,
pricing schedule, language and measurement units are separate concepts.

## Signup and persistence

`public/v1/commerce/regions.ts` selects the signup country using country headers
from the edge, then browser time zone, browser locale region, and the legacy
North American phone convention. Unrecognized countries use international
USD-backed credits. The signup form supports international E.164 phone numbers
and sends browser locale/time-zone hints for both password and Google signup.

`timezone-countries.ts` contains IANA country mappings including aliases.
`territory-defaults.ts` contains Unicode CLDR dominant national official language
and current currency defaults, with business defaults in `regions.ts` taking
priority. Their headers record source/version. Time-zone and locale hints are
fallbacks, not proof of residence. Edge deployment should overwrite geolocation
headers; no VPN, card-country or property-location enforcement is implemented.

All three registration paths write `global.data.commercial_profile` once.
Login, travel, personal language changes and normal company settings never
reassign the profile. Organizations without a profile keep legacy US/USD prices.
There is no automatic migration of existing balances or subscriptions. Any
future currency migration must reconcile prepaid balances, saved payment
methods, pending payments and existing contracts explicitly.

Country language routing prefers an exact installed pack, then the same language,
then another national official language, then the geographic English fallback.
English-speaking countries retain their geographic English fallback. Only en-US/en-GB are currently shipped.
France records fr-FR as its preferred locale and uses en-GB until a French pack
is installed and the organization's preference is explicitly changed. Adding a
pack requires updating the shared locale registry/validators and translated
catalogs, templates and fonts as described in `docs/platform-localization.md`.

## Pricing and administration

The shared internal document `pricing_config/commercial` holds:

```json
{
  "multipliers": {"domestic": 1, "international": 2},
  "currencies": {
    "USD": {"minor_digits": 2, "report_multiplier": 1},
    "EUR": {"minor_digits": 2, "report_multiplier": 1}
  }
}
```

Full internal administrators can use **Billing → Billing administration →
Pricing catalog → Manage regional billing**, or GET/PUT
`/v1/firstmeasure/admin/prices/commercial`. PUT requires CSRF, the current
revision and the complete config. Saves are serialized, reject stale revisions
and retain previous values/actor metadata. Existing supported currencies cannot
be removed or have their minor-unit precision changed.

Report prices are the base report price × market multiplier × the fixed
`report_multiplier` for that currency. This currency multiplier sets a fixed
price, not a live exchange rate. USD/EUR start at 1. Future currencies can use a
different factor and appropriate minor digits. Subscription products can use
explicit `regional_prices` in each version of the private catalog:

```json
{
  "international": {
    "EUR": {"monthly_cents": 6000, "rates": []},
    "JPY": {"monthly_cents": 8000, "rates": []}
  }
}
```

Historical `*_cents` fields mean currency minor units; `*_dollars` fields in
FirstMeasure mean credit/billing-currency major units for compatibility. JPY
8000 minor units is ¥8,000 when configured with zero minor digits. Rate values
in FirstMeasure are rounded to the currency precision, capped at two decimals
to match the existing credit ledger; a three-decimal currency uses increments of 0.01 credit. Subscription metered rate values
are millionths of that price's currency. Regional overrides retain the same
meters as the base product. USD/EUR prices without overrides use the market
multiplier; additional currencies require explicit subscription prices. Publish
those prices before making a currency available to new organizations.

Accepted subscription snapshots contain resolved currency, precision, base
charge and usage rates. Catalog edits and multiplier changes do not reprice
existing subscriptions. Stripe price identities include resolved commercial
terms, so the same catalog version cannot reuse a different currency's Stripe
price. Mixed-currency invoices/subscriptions are rejected.

FirstMeasure quote/charge calculations use request-scoped authenticated org
context. The published exterior quote action also establishes this context for
background callers. The portal loads pricing before allowing ordering screens
to render. Price configuration changes require an open ordering page to reload;
charge requests carry `commercial_pricing_revision`. Public API clients obtain
it from `/v1/public/firstmeasure/pricing` → `commerce.pricing_revision` and send
it when ordering. Existing revision-zero clients retain compatibility until
the first commercial policy update.

## Stripe and conversion

Fixed-currency payments charge the exact USD/EUR amount. FirstMeasure checkout,
automatic top-ups, subscriptions and usage invoices retain their integration
currency. Payment settlement validates amount/currency before adding credits.
Idempotency protects repeated fulfillment, and ledger entries retain currency,
minor units, credit display and provider presentment details where available.

USD-backed credit and subscription Checkouts request Stripe Adaptive Pricing.
Availability depends on the Stripe account, integration and customer/payment
method. The integration amount remains USD; any converted presentment amount
is separate. Automatic off-session FirstMeasure top-ups and usage invoices
charge their billing currency; the card issuer may convert them. No homegrown
FX engine or merchant yen balance is required.

The application shows an approximate local equivalent for unsupported local
currencies where an ECB reference rate is available. Rates are fetched from a
fixed ECB endpoint, cached hourly and discarded after seven days. Missing rates
omit the estimate. Estimates never determine the amount charged and cannot
promise the eventual card-issuer or Stripe rate.

Statements label each cash payment/invoice in its stored currency, keep credit
movements separate, group cash totals by currency and include currency in CSV.
No payment, deployment or Stripe Dashboard change is performed by this work.

## Verification

Run from `public/v1`:

```powershell
npm run check
node --experimental-sqlite --import tsx --test --test-force-exit tests/regional-commerce.test.ts tests/regional-commerce-browser.test.mjs
```

The tests exercise country persistence, locale/unit defaults, customer mutation
denial, concurrent price isolation, roof/rush/add-on/exterior prices, EUR/USD
checkout and automatic top-ups, settlement mismatch/replay handling, Stripe
subscription price separation, future currency configuration and browser
formatting/mobile layouts. Payment tests use deterministic provider fixtures;
they do not charge cards. Screenshots are written to `output/regional-billing-ui`.
