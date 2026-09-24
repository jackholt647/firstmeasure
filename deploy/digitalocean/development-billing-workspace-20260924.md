# Cohesive Billing workspace — September 24, 2026

## Scope and preparation

Source commit: `0b3750bf2dab7115dac9b2a16e7730d99dde142f`.
Development only; no production or account configuration changes.

The customer page now has one responsive summary, subscriptions, credit
auto-top-up, usage/storage details, monthly statement, transaction history and
CSV export. Catalog/account administration opens separately. The existing
FirstMeasure-only page remains the fallback when platform features are off.

Fourteen focused tests passed, including real Chromium interactions, mixed
statement totals, formula escaping, request races, failures, read-only access,
legacy flags, autosave exclusions and credit-purchase resume behavior.
Candidate scripts were also exercised inside the actual development portal at
1440, 900 and 390 pixels. Screenshots were inspected. The combined flow used
browser-only fixtures: mixed credit/subscription/usage history and CSV,
auto-top-up save adapter, invoice details, catalog administration and Stripe
add-on review. No customer charge, saved rollout flag or auto-top-up setting
was changed. Test Company retains its FirstMeasure defaults.

## Deployment status

Prepared for activation. Initial staging on `0b3750b` was not activated: the
baseline guard detected the concurrent payment-completion release before any
Billing activation. The replacement release will preserve web/pool baseline
`d7437b8caa5993ee5406aeb949f36a82a1495fb3` and compatibility baseline
`f48e7b2ae384aa162caab106f7dc978913a368b0`.

Only three frontend paths are deployed: the settings bundle manifest,
`settings/platform-billing.js`, and five scoped Billing hunks in
`settings/company.js`. Unrelated company settings changes are preserved.
The worker backend does not need a new release. Activation verifies source
hashes, JavaScript syntax, process release identity and development outbound
isolation, with rollback on readiness failure.

Post-activation results will be recorded here. The previously documented
historical autoscale-image limitation remains; this change does not alter
images, infrastructure topology or production.
