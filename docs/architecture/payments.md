# Taking customer payments (Forward)

FirstMate takes card and bank (ACH) payments through Forward, a managed payment
facilitator. This page is the contract every payment path follows. The
integration history and Forward's capability list are in
[the Forward integration plan](../forward-payments-integration-plan.md); the
certification evidence is in [Forward certification](../forward-certification.md).

## One gate: can this organization take a payment now?

`payments/readiness.ts` answers it, on the server, for every path that charges,
saves a card or bank account, enrolls autopay or asks a customer to pay online.
An organization is ready only when all of these hold:

- Money is on, taking payments (`money.take_payment`) is on, and online
  processing (`money.merchant_processing`) is on.
- Its merchant account runs on Forward, the Forward keys are configured
  (private and public), and the account id is known.
- The application is `APPROVED` and Forward has `processing_enabled` on the
  account.

`requirePaymentsReady(orgId, { rail })` refuses with `payments_not_ready` (409)
and a reason the person can act on, and hands back the provider to charge
through. A rail (card or bank) the organization switched off refuses too; both
default on once approved.

What the gate never does: record a payment as paid without a charge. There is
no "mock" or "recorded as paid" fallback for card or bank payments anywhere. A
payment taken outside the platform (cash, check, a card run on another
terminal) is recorded by staff as exactly that, from the record-payment forms.

Customer-facing surfaces read the same answer: the payment form shows no card
or bank entry when not ready, the customer portal's `can_pay` and
`online_payments` follow it, a document's Pay widget says online payment is
not available, and invoice emails only say "to pay" when the organization can
take the payment.

The in-process simulator (`providers/mock.ts`) stands in for Forward only
outside production data (`mockProviderAllowed()`); on production data it is
never selectable, never a default, and its controls refuse.

Who may change the merchant account: Forward (webhooks and boarding sync) and
FirstMate staff (Boarding Ops). An organization's own `PATCH /merchant-config`
can only choose its rails.

## The checkout: one attempt to take one payment

Forward's secure element (card or bank) pays a payment intent that already
exists, so every browser payment is two steps:

1. **Prepare** — `prepareCheckout` (routes: staff `POST
   /payments/organizations/:org/payment-checkouts`, crew `.../crew/projects/:id/payment-checkouts`,
   customer portal `POST /documents/public/:token/payments/checkout`, partner
   `.../resources/payment-method`). The server works out the amount (a
   document's or invoice's own amount, never the browser's), writes a
   `payment_checkouts` record, then creates Forward's payment intent with:
   - `amount`, our `reference_id` (the payment id we will record) and
     `user_fields` (payment, checkout, organization, project);
   - `order_details`: `card_not_present_type` + `initiated_by` (customer at a
     checkout: `ecommerce`/`customer`; staff charging a stored card:
     `ecommerce`/`merchant`; autopay: `recurring`/`merchant` with
     `is_scheduled_payment`), `invoice_id`, the job site's ZIP as
     `ship_to_zip`, tax when known;
   - `payment_method_types` for the chosen rail;
   - idempotency key `fm-pi-<checkout id>`.
   The browser gets the client secret, Forward's public key and SDK URL.
2. **Confirm** — the browser element tokenizes (`onReady(tokenize)` for cards;
   the bank element confirms itself) and posts the token with the checkout id.
   `recordProviderChargedPayment` → `chargeCheckout` claims the checkout and
   calls `POST /payment_intents/:id/payments` with the token, billing details,
   the same order details and key `fm-pay-<checkout id>-<attempt>`.

Outcomes:

- **Captured** (card) → the payment is recorded settled and allocated.
- **Pending** (bank) → recorded `pending`, not applied to anything; the
  `v2.payment.captured` webhook settles it (`settlePendingPayment`) and a
  failure or return reverses it (`failRecordedPayment`, `payment.failed`).
- **Declined** (Forward answers 200 with `status: failed` and
  `decline_category_text`) → nothing is recorded; the customer sees Forward's
  reason; the checkout stays open for another card (next attempt, new key).
- **No answer** (timeout, 5xx after retries) → the checkout is marked
  `unknown`, the intent is looked up, and a charge Forward made is recorded
  (`reconcileCheckout`, `finishCheckoutFromProvider`, also from the webhook).
  The customer is told not to pay again. Autopay retries the same checkout,
  never a new charge.

A Forward token without a checkout is refused (`checkout_required`), and raw
card or bank numbers are refused (`raw_payment_details_refused`): they are
typed only into Forward's iframe. A checkout belongs to its job, amount, rail
and (for documents) document output; paying another with it is refused.

`providers/forward.ts` retries 429/5xx and network errors with the same
idempotency key (backoff), and never retries a write without a key.

## Refunds and voids

`payments/provider_refunds.ts`, behind `POST /payments/:id/refunds`:

- Whole amount before the payment settles → **void**: `POST
  /payment_intents/:id/cancel` (`cancellation_reason`), payment becomes
  `voided`.
- Otherwise → **refund** (full or part): `POST /payment_intents/:id/refunds`
  with key `fm-ref-<payment>-<n>-<amount>`; the refund record carries the
  Forward refund id.
- A refund in flight is marked on the payment so Forward's `v2.refund.created`
  echo is not mirrored twice; refunds and voids made in Forward's portal are
  mirrored from webhooks.
- A payment recorded by hand is reversed on our books only.

## Webhooks

`payments/webhooks_forward.ts` verifies the Svix signature, routes by Forward
account, application, business or our organization id (`external_account_id`),
stores each event once, processes it, then marks it processed; an event whose
processing failed answers 500 and is processed again on redelivery.
`v2.account.*` events (including the mandatory `v2.account.gateway_updated`)
re-read the account from Forward and keep `processing_enabled`,
`payouts_enabled`, account status and gateway MID current.

## Tests

`npm run test:payments` (includes `tests/payments-forward-checkout.test.ts`,
which drives the real Forward adapter against a fake Forward API) and
`scripts/forward-checkout-ui-e2e.mjs` (the real UI against Forward's sandbox).

## Not built

- Apple Pay and Google Pay buttons (the Payment Element supports them; needs a
  merchant id and domain verification).
- Pulling Forward's transaction list for reconciliation (payouts and disputes
  come from webhooks today).
- Two full scans are listed in [the optimization backlog](../optimization-backlog.md#payment-checkouts-and-refunds-scan-collections):
  finding a checkout by payment id without its derived id, and listing a
  payment's refunds.
