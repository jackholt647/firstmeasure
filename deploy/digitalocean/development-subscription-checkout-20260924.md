# Standardized platform subscription checkout — September 24, 2026

Source release: `f48e7b2ae384aa162caab106f7dc978913a368b0`. Published to **dev.1m8.ai** on both web nodes,
the platform worker and compatibility service. Production was not changed.

## Delivered

- One Billing tab, including FirstMeasure and platform subscriptions/usage.
- Shared subscription review in Billing, SMS setup and Assistant setup. It shows
  each product, the current monthly total, the new monthly total and due today.
- First purchase uses Stripe Checkout and prepays the first month. New add-ons
  keep the renewal date and charge only the remaining-period proration.
- Automatic recurring collection through Stripe Billing. Additions use a fixed
  preview timestamp, immediate invoicing and a pending update until paid.
- Durable quotes/purchases, idempotent retries, verified activation, renewal and
  cancellation reconciliation, and receipts beside the separate usage invoices.
- Stripe prepaid fees cannot also appear on local month-end usage invoices.
- Existing FirstMeasure credits, auto top-up and Forward merchant payments retain
  their contracts. No customer catalog prices or subscriptions were enabled.

Architecture and operational recovery: [platform billing](../../docs/architecture/platform-billing.md).

## Build and deployment

The exact immutable commit was built and tested with Node 22 on Linux. The
selected payload contains 13 source/document files and eight compiled files.
Both web nodes and compatibility received all 21 files; the worker received the
16 backend source/compiled files. No package/dependency change was required.

- Compiled archive SHA-256:
  `edd1e7cedb66e3df178cbd85799fb76f2d9bb3e0d6048040b6da2099ed885de3`.
- Selected payload SHA-256: `bb88cf7fe6ae7ddcab4e9e3cb74b9993decf8c3d7552a18436a0966bbbacc5ed`.
- Previous web/compatibility release: `a6b1857ef005dca529adc13cd194d880050abfcd`.
- Previous worker release: `adfb2cf324020cd48959d62573beb7be351c9fdc`.

Each role's complete serving baseline was copied, with audited file hashes and
only the checkout delta overlaid. Company Settings changes were applied as three
scoped patches, preserving the concurrent Forward setup implementation. Existing
private APK links, environment files, PHP settings, service drop-ins and unrelated
runtime changes remain intact. Each role passed readiness, release identity,
payload verification and enforced development outbound isolation. The worker had
zero running measurement jobs before its atomic activation.

Twenty-four public readiness requests reached both instances: `do-598520065`
(9) and `do-603124965`
(15). All reported this release and healthy development
isolation. All four public checkout/settings scripts matched the deployed hashes.
The load balancer initially served only the first restarted node, then admitted
the second after its health checks; the completed verification reached both.

## Verification

- TypeScript check and Linux production build passed.
- Five new subscription tests cover initial payment, incremental amount, failed
  payment, renewal recovery, cancellation, duplicate acceptance, concurrent
  quotes, lost responses, stale/changed quotes, tenant mismatch, settlement
  validation and free subscriptions. They pass with SQLite and PostgreSQL.
- Six existing ledger tests pass with SQLite and PostgreSQL (11 PostgreSQL tests
  total across both files).
- Four API/browser tests pass locally, including signed webhook replay, CSRF,
  permissions, payment-required activation, desktop/phone checkout and the shared
  SMS setup flow. Phone review screenshots show current/new/monthly totals and
  the prorated payment without horizontal overflow.
- Four original FirstMeasure Stripe regressions and eleven Assistant API tests
  pass. The Linux combined suite reports 29 passes and one browser skip; the real
  Chromium browser gate passed locally.
- Publication contracts: 47 passes and one PostgreSQL-specific skip.
- Five unified Billing contracts plus four existing billing-resume/autosave
  checks pass, including purchase discovery while commercial access is locked.

An actual Stripe **test-mode** contract check created an isolated temporary test
customer, two recurring prices and a subscription. The first $30 payment was
paid; adding another $30 item produced a $60 monthly plan and exactly a $30
invoice at the start of the cycle. The fixed preview timestamp, pending-update
parameters, hosted Checkout creation and item cancellation were accepted by
Stripe. The test subscription was cancelled, customer deleted, and prices/product
archived. No real customer card or live-mode payment was used.

## Stripe webhook configuration

The existing test endpoint `we_1UCkixLsVt78N4NAoTWFf5kd` at
`https://dev.1m8.ai/portal/stripe_webhook.php` retains its URL, signing secret and
API version `2025-11-17.clover`. Its original checkout and saved-card events
remain enabled. Added events:

- `checkout.session.expired`
- `invoice.paid`, `invoice.payment_failed`, `invoice.voided`
- `customer.subscription.updated`, `customer.subscription.deleted`
- `customer.subscription.pending_update_applied`
- `customer.subscription.pending_update_expired`

A signed invoice event sent through the public PHP bridge returned HTTP 200; an
invalid signature returned HTTP 400. The probe referenced no billing account and
created no subscription or invoice. Hourly reconciliation remains a recovery path.

## Live UI and current Test Company settings

A concurrent authorized task reset Test Company to FirstMeasure defaults with
five test exceptions. That configuration was preserved. The actual authenticated
portal shows the original FirstMeasure-only Billing view, and platform billing
API access returns 403 while expanded platform access is disabled.

The combined layout was checked using browser-only billing/flag fixtures on the
live assets. This preserved the server's configuration and created no catalog or
customer records. The old Billing URL alias, single navigation tab, both sections,
desktop/phone layouts, disabled-feature fallback, zero hidden billing requests
and zero page errors all passed. Temporary authenticated smoke sessions were
revoked after the checks.

## Rollback and inherited environment limitation

Application rollback may restore each role's recorded previous release symlink
and restart its service (and PHP-FPM for serving roles). Billing records are
additive. **Do not roll back the payment reconciler after accepting new Stripe
subscriptions without an operator plan for their invoices and renewals.** Stripe
subscriptions continue independently of the deployed application.

The historical development autoscale image limitation remains: a replacement or
scale-out node needs this verified release and the previously documented runtime
provisioning. This task changed neither topology nor the image baseline.
