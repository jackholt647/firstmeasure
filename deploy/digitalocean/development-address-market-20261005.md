# Property-aware roof pricing and continuous ordering

Pricing commit: `ce57ad563725ee51034f3d47a01dec1506d1d4d3`.
Final runtime with geocoder fallback: `7aa141435832a3c1b7e52f433bef932a2e1eb796`.

US/Canadian accounts retain existing domestic rates for US/Canadian properties,
and pay 21 USD for international roof reports. International accounts use EUR
and pay 20 EUR for roof reports anywhere. All countries outside US/Canada,
including the UK, use the same international signup/billboard boundary. Gutter
add-ons are 2 units of account currency. International-priced rush surcharges
are 2.5 times the corresponding US surcharge. Commercial/multifamily roof
prices remain per structure; residential remains flat. Existing weather,
instant-preview, full-house and subscription schedules remain separate.

Server-side geocoding determines the property country before charging.
Google Geocoding is not enabled on the configured development Google project.
The already configured Azure Maps service provides the verified fallback; no
provider credentials or cloud configuration were changed. Its reverse endpoint
uses longitude,latitude and reads the ISO country field. See the
[Azure reverse-geocoding contract](https://learn.microsoft.com/en-us/rest/api/maps/search/get-reverse-geocoding?view=rest-maps-2025-01-01).
Client country claims cannot lower the price. Mixed domestic/international pins
require separate orders; failed verification makes no deduction. Successful
lookups are cached for five minutes. Provider-backed quotes require an existing
authenticated session and use the existing provider-request rate limit; the
public API retains its API-key/scopes/rate enforcement.

The same context covers portal/API quotes and orders, upgrades and follow-ups.
Reports and ledger entries persist country and account currency. International
orders require report_market_revision 1. The browser invalidates quotes on
address changes and waits for authoritative prices. All supported report
locales are accepted consistently. No FX conversion, credit balance migration,
subscription repricing or permission-flag changes were made.

Evening closure notices and after-hours rush restrictions are removed for roof
and full-house orders. QA, workload estimates, SLAs and release scheduling
remain. No existing held deliveries were replayed.

## Verification

TypeScript, PHP syntax and JavaScript syntax checks passed. Eighteen focused
pricing, currency/Stripe-fixture, units, turnaround and full-house tests passed.
An additional end-to-end test verifies actual portal deductions and public API
quotes/orders for US, UK and French accounts, saved currencies, spoofed-country
rejection, unknown-country no-charge behavior and unauthenticated geocoder
rejection. Provider fixtures do not send customer messages or charge real cards.

Browser candidate checks passed: 7 USD -> 21 USD -> 7 USD on US -> France -> US
address changes, retained map country, hidden closure banner and mobile layout.
Hosted login checks passed in 25 responsive layouts.
Fifteen login routing/exclusion cases passed, including UK and Australia using
the international billboard. Both website billboard URLs remain website-owned.

Development's saved profiles were audited: none required an international
currency migration. Production is unchanged. Audit existing production profiles
and funding contracts before a later separately authorized production rollout.

## Deployment

Immutable per-role overlays preserve the audited live baselines, configuration,
runtime assets and unrelated development work. Source/build hashes, baselines
and rollback paths are in `output/address-market-20261005/manifest.json` and
`output/address-market-provider-20261005/manifest.json`.
The final overlay changes only the property-country resolver and its compiled
output, preserving the pricing and concurrent mobile releases.
Web, compatibility and pool use detached-on-write hardlink staging with explicit
free-space/inode checks; worker uses the existing reflink/clone path.
Restore each role's previous_path, restart its development service and reload
PHP-FPM on serving roles for code rollback. This does not reverse business data.

Activation and hosted verification passed on all four development roles.
Concurrent release `e1abe2674f95640df6e0b54974fbdfce9fc74280` succeeded the
web/worker/compatibility activation; every owned source/build hash was checked
again and retained. Verification records are in
`output/address-market-20261005/verified-deployment.json`.

Hosted real-provider quotes and the browser both passed US 7 USD -> France
21 USD -> US 7 USD, with the verified US/FR country codes and no closure banner.
All 25 responsive login layouts passed again after the final correction.
The fallback adds a regression test for coordinate order, address queries,
Google rejection and both-provider failure. The pricing/order tests were rerun
and all eight passed; TypeScript and Linux checks passed.

Both external billboard URLs still returned HTTP 404. The app-side embed is
ready; the website team must publish the pages. Production was not activated.

See [regional billing architecture](../../docs/architecture/regional-billing.md)
for the complete policy and API contract.
