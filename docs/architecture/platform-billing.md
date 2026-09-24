# Platform billing

Company Settings has one **Billing** tab. It contains the existing FirstMeasure
credit, auto top-up and monthly statement controls, plus a **Subscriptions &
usage** section when the user has a configured expanded-platform feature and
platform billing permission, including paid features awaiting checkout. With
all platform features disabled, only the
original FirstMeasure view is rendered. The billing switch itself and numeric
configuration values do not count as enabled platform features. Search uses
the single Billing destination; old `sub=platform_billing` links remain aliases.
FirstMeasure's seven production permissions and billing contracts are preserved.
The additional section uses `platform.platform_billing`, `view_platform_billing` and
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
change that agreement. New subscriptions prepay their first month and renew on
the monthly anniversary; add-ons are prorated to that date. Cancellation retains
access through the paid period. Legacy arrears subscriptions keep their UTC
calendar-month contract. After cancellation ends, another version can be chosen.
Billing uses monthly USD prices; annual periods, tiered rates and
tax calculation are separate future extensions.

Commercial access checks are explicitly enabled per organization. Until enabled,
existing capability behavior continues. Once enabled, a published paid product
marked as requiring a subscription masks its capability when no subscription is
active. Existing parent/dependency resolution, rollout audiences and user
permissions still apply. Buying a subscription does not grant a user permission
or enable an operator-disabled app. Agent runtime entry points also check their
registered capability for background runs. An unpaid Stripe renewal does not
extend paid access. Legacy subscriptions and usage invoices retain their existing
access policy.

Operators use the existing deployment-owned test-organization/email allowlist;
ordinary organization administrators cannot edit prices or enable commercial
checks. An authorized operator can enter another organization ID in Account
controls to inspect subscriptions, enable monitoring/enforcement and record an
adjustment. Tenant users can access only their current organization.

## Usage and storage

`platform-billing/model.ts` declares trusted meters, not arbitrary queries or
customer supplied code. SMS segments come from `communication_usage_events`,
agent runs/input/output tokens from `agent_runs`, and live chat tokens from
`chat_ai_usage_events`. Live chat's duplicate `agent_runs` records are excluded
from general agent meters to prevent charging twice. Provider costs are not customer prices. Source rows remain
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

### Subscription checkout and renewals

New fixed monthly subscriptions use Stripe Billing, with a dedicated platform
customer and one recurring subscription containing an item for each add-on.
The first purchase uses Stripe Checkout and charges the full first month, with
renewal on its monthly anniversary. Adding a product preserves that renewal date
and charges only its remaining-period proration. A server-created quote shows
current and new monthly totals, every included product, and the amount due now.
Descriptions and included usage come from the immutable catalog price version.
No trial is currently offered; the catalog does not silently imply a trial.

The review is shared by Billing, SMS setup and Assistant setup through
`FirstMatePlatformBilling.review` / `setup`. New app setup can use the same helper
with its registered capability keys. Setup can display a configured capability
whose commercial entitlement is still locked; this never grants runtime access
or bypasses the user's billing permissions or the platform rollout audience.

Quotes expire after ten minutes. Acceptance checks the current plan and previews
again using the original Stripe `proration_date`. An add-on uses
`payment_behavior=pending_if_incomplete` and `proration_behavior=always_invoice`.
Stripe tries the saved payment method only after the user confirms the displayed
amount. When card authentication or another payment step is needed, the customer
continues on Stripe's hosted invoice page. A declined payment keeps the existing
plan and does not grant the new entitlement. The provider's verified paid result,
not the browser redirect, activates the price snapshot locally.

A purchase and its exact Stripe parameters are committed before the provider
request. Requests share a durable idempotency key; each organization has at most
one pending purchase/cancellation. Signed webhook events, explicit refresh and
the hourly worker reconcile provider state. Duplicate or out-of-order events
fetch current Stripe state. Unknown results are retried with the same request
within 23 hours; older ambiguous requests require operator reconciliation with
Stripe request logs before any replacement purchase. Operators must identify the
original session/subscription/invoice and settle or void it; never delete the
purchase record and start another charge blindly.

Stripe handles automatic monthly collection. Local entitlements retain their
verified paid-through date when a renewal fails and resume after verified payment.
Cancellation removes an item from future renewals without refunding the current
period; access continues through the paid period. The last item cancels the
Stripe subscription at period end. Subscription receipts and outstanding payments
appear alongside usage invoices in the single Billing tab.

Prepaid Stripe fixed fees are excluded from the local usage invoice. Existing
subscriptions retain their original arrears contract. Usage continues to use UTC
calendar months, with explicit Stripe payment for issued usage invoices. Existing
FirstMeasure credits, saved cards, auto top-up and Forward merchant payments keep
their original contracts. Platform sessions are routed by metadata only after the
existing webhook signature and mode validation.

The Stripe API version is pinned to `2025-06-30.basil`. All settlement verifies
organization, provider customer/subscription, currency, amount, price/item and
mode. Development refuses live keys and production return hosts. No paid product
or subscription is enabled for a customer by deploying this implementation.

Provider contracts: [pending updates](https://docs.stripe.com/billing/subscriptions/pending-updates),
[invoice previews](https://docs.stripe.com/api/invoices/create_preview),
[subscription updates](https://docs.stripe.com/api/subscriptions/update).

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
node --experimental-sqlite --import tsx --test --test-force-exit tests/platform-billing.test.ts tests/platform-billing-api.test.ts tests/platform-subscription-checkout.test.ts tests/platform-stripe.test.ts
node tests/run-embedded-postgres.mjs tests/platform-billing.test.ts tests/platform-subscription-checkout.test.ts
npm run test:publication
node --test tests/billing-resume-project.test.mjs tests/settings-autosave-optout.test.mjs
node --test tests/unified-billing.test.mjs
```

The billing API test includes a real headless browser against its isolated API:
subscription confirmation, operator price creation/publication and phone layout.
Set `BILLING_BROWSER_PATH` when Chromium is elsewhere. Linux build hosts without
a browser may set `SKIP_BILLING_BROWSER=1` after the local browser gate passes.
Provider tests simulate Stripe responses and never create a real customer charge.
