# Platform billing

Platform Billing is a separate Company Settings section for expanded platform
organizations. FirstMeasure's Billing tab, seven production permissions, report
credits, auto top-up and monthly statement keep their existing contracts.
The new section uses `platform.platform_billing`, `view_platform_billing` and
`manage_platform_billing`. Its backend is `/v1/platform-billing/organizations/:orgId`.

## Catalog and access

The operator pricing catalog references the existing stable capability keys.
Eligible boolean apps, features and subsystems can have a product. FirstMeasure
capabilities, core report access and billing itself cannot be priced here.
Capabilities without a published paid product remain free. Numeric configuration
values and human permissions are not sellable products.

Prices have a fixed monthly USD amount and any number of registered usage rates.
Each rate specifies included units, units per price and an exact integer price in
millionths of a dollar. This supports subscriptions, usage-only products and a
subscription with included usage/overage. New prices start as drafts; publication
is explicit. Reusing a product ID creates another immutable price version.
Publishing does not enroll or charge any organization. A meter can be priced by
only one product to prevent overlapping charges.

Customers explicitly review and accept a published price. The subscription retains
the full price snapshot and acceptance actor/time. New catalog versions never
change that agreement. The first month's base fee is prorated by elapsed time;
subsequent months renew until cancelled. Cancellation takes effect at the end of
the current UTC calendar month. After cancellation, another version can be chosen.
The initial release uses monthly USD billing; annual periods, tiered rates and
tax calculation are separate future extensions.

Commercial access checks are explicitly enabled per organization. Until enabled,
existing capability behavior continues. Once enabled, a published paid product
marked as requiring a subscription masks its capability when no subscription is
active. Existing parent/dependency resolution, rollout audiences and user
permissions still apply. Buying a subscription does not grant a user permission
or enable an operator-disabled app. Agent runtime entry points also check their
registered capability for background runs. This release does not automatically
suspend customers based on unpaid invoices.

Operators use the existing deployment-owned test-organization/email allowlist;
ordinary organization administrators cannot edit prices or enable commercial
checks. An authorized operator can enter another organization ID in Account
controls to inspect subscriptions, enable monitoring/enforcement and record an
adjustment. Tenant users can access only their current organization.

## Usage and storage

`platform-billing/model.ts` declares trusted meters, not arbitrary queries or
customer supplied code. SMS segments come from `communication_usage_events`,
agent runs/input/output tokens from `agent_runs`, and live chat tokens from
`chat_ai_usage_events`. Provider costs are not customer prices. Source rows remain
the evidence. No HTTP endpoint lets a customer submit arbitrary measured usage.

`metering.ts` imports durable source rows in bounded pages, with a saved cursor
per organization/source. A unique organization/meter/source key prevents retries
or multiple nodes from billing the same event twice. A conflicting replay fails
instead of changing evidence. Record-based meters count events during the active
subscription. Agent run counts include recorded attempts; token meters retain
the measured consumption, including consumption from failed attempts.

Storage measures retained platform media originals and generated renditions.
It does not claim to measure every report artifact, database, backup or provider
recording. Hourly snapshots integrate bytes over elapsed time and divide by the
calendar month's duration. Set units per price to 1073741824 for GiB-month pricing.
Included storage is prorated to the active portion of the month. Before the first
snapshot there is no inferred historical usage; during gaps the last measured
value carries forward. The UI shows the last measurement and synchronization
status. Enable monitoring before starting a storage subscription.

Monitoring starts explicitly or on the first subscription. An hourly task uses
the existing shared task lease and per-organization SQL transactions. It runs in
the compatibility heartbeat or dedicated platform worker, whichever claims it.
Refresh usage is an explicit authenticated command; overview GETs do not create
subscriptions, snapshots, invoices or domain records.

## Invoices and collection

Usage and subscriptions are rated with integer arithmetic. Estimates accrue
through the current time. Invoices close 72 hours after month end, after source
catch-up finishes. The invoice contains its original line items and price version
identities. Repeated finalization returns the same invoice. Late usage is flagged
for review rather than silently rewriting an issued invoice. Operators can post
an auditable positive adjustment or negative credit to an open period. Negative
invoice totals require allocating the remaining credit to another period.

Collection uses a dedicated hosted Stripe Checkout payment for each platform
invoice. It can reuse the organization's Stripe customer, but does not debit
measurement credits, change auto top-up or use the Forward merchant-payment flow.
Customers pay issued invoices explicitly; automatic saved-card collection is not
enabled by accepting a subscription in this release. Payment reconciliation runs
on explicit refresh and the hourly task. The existing FirstMeasure webhook does
not fulfill these sessions because they lack its credit-purchase metadata.

Checkout request identity and exact parameters are saved before the external
request. Concurrent/retried requests use the same Stripe idempotency key. A new
attempt is allowed only after confirming that the preceding session expired.
An uncertain result older than 23 hours requires provider reconciliation before
retry, because the provider's idempotency retention cannot be assumed forever.
Settlement verifies organization, invoice, currency, amount and test/live mode.
Development refuses live Stripe keys and production return hosts.

## Storage and publication boundaries

The shared `SqlStore` uses PostgreSQL in the cluster and SQLite in local mode.
Additive `platform_billing_records` and `platform_billing_usage` tables hold
prices, accounts, subscriptions, usage, cursors, invoices, adjustments and audit
events. Advisory transaction locks and unique constraints enforce concurrency.
Rollback can retain these tables without changing existing domain data.

Account, catalog and subscription mutations have dedicated authenticated routes,
CSRF protection and explicit permissions. They are deliberately excluded from
general tenant module/agent actions, consistent with publication architecture.
Settings ownership is documented in `platform/publication/coverage.ts`.

## Verification

From `public/v1`:

```text
npm run check
npm run build
node --experimental-sqlite --import tsx --test --test-force-exit tests/platform-billing.test.ts tests/platform-billing-api.test.ts tests/platform-stripe.test.ts
node tests/run-embedded-postgres.mjs tests/platform-billing.test.ts
npm run test:publication
node --test tests/billing-resume-project.test.mjs tests/settings-autosave-optout.test.mjs
```

The billing API test includes a real headless browser against its isolated API:
subscription confirmation, operator price creation/publication and phone layout.
Set `BILLING_BROWSER_PATH` when Chromium is elsewhere. Linux build hosts without
a browser may set `SKIP_BILLING_BROWSER=1` after the local browser gate passes.
Provider tests simulate Stripe responses and never create a real customer charge.
