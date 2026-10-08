# International roof pricing — development, October 8, 2026

Application release: `629f7d6f3b89c40bf66a70fd97147713ea46c3f0`.

International roof reports are €25 residential and €50 per commercial or
multifamily structure. The residential gutter add-on is €5. US/Canada accounts
ordering US/Canada properties retain $7 residential, $12 per commercial or
multifamily structure, and $2 gutters. EUR organizations retain international
prices when ordering domestic properties, following the existing premium rule.
Existing balances, account currencies, paid reports and subscriptions are not
converted or repriced.

The existing server-verified property-country boundary remains US/Canada versus
every other country. USD accounts ordering abroad use the shared ECB daily euro
reference rate, rounded independently to the nearest whole dollar for the base
report and gutters. International expedite surcharges use the corresponding US
surcharge divided by its US base, multiplied by the international base; only the
surcharge rounds to cents. Commercial/multifamily prices remain per structure.

The quote revision identifies the new price version and, for international USD
quotes, the reference rate. Old quotes and changed rates are rejected before
charging. A missing usable reference rate prevents an international USD quote
or order rather than guessing a conversion. The existing rate cache retains
recent rates during temporary ECB failures and rejects rates older than seven
days.

Expediting is disabled for properties outside US/Canada, including requests from
US accounts, existing-project expedite upgrades, the public API, and full-house
delivery options. The server rejects direct rush requests and the client does
not restore fallback rush options after receiving a standard-only quote.
Domestic properties still allow expediting, including orders from EUR accounts.
No automatic expiry is scheduled. A full internal administrator can enable it
under **Prices → International launch → Enable expediting for properties outside
US/Canada → Save international expediting**. This uses the existing commercial
policy revision, permission checks and audited configuration save.

The release applies only the reviewed pricing delta over each active development
role's source baseline. It preserves other deployed frontend changes and the
October 7 development readiness timeout/cache mitigation. Production is outside
this rollout.

Verification evidence is in `output/international-pricing-20261008/`: isolated
pricing/order/admin tests, TypeScript checking, role manifests and hashes,
runtime readiness, and hosted API/browser verification. Test fixtures do not
send live payments or submit live measurement orders.
