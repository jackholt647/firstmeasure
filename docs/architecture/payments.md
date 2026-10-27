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

## Boarding: from application to "payments are on"

Merchants apply on Forward's hosted application, opened in the payment setup
window (`payments-setup/payments-setup.js`, a full-height iframe with the title
and Close floating over it). Forward redirects to
`/portal/payments-setup-complete.html`, which asks the parent window
(`FirstMatePaymentsSetup.outcome`) for Forward's answer: reading the
application (`syncBoardingFromProvider`) records status, account, processing
and payouts even when no webhook has arrived. Instant underwriting can approve
at once, so the page says "approved, you can take payments now" when Forward
says so and "under review" otherwise, checking again for about a minute.
Settings › Money refreshes on `fm:payments-setup-updated`.

Once the application is approved and Forward has processing on, everyone who
can manage company settings gets one notification ("Payments are on", unread
in the bell; `maybeNotifyMerchantApproved`, stamped `approval_notified_at`).
A notification must name its recipients: one with no targets reaches nobody.
The money onboarding attention entry (`onboarding_attention.ts`) records what
Forward says before choosing what to show, and shows an interim entry only
while Forward reports processing or payouts off. It shows nothing until
`money.merchant_processing` is on, and only Money's setup turns that on when
someone starts it (`core.js`, the `platform.money` setup handler), so an
organization that has Money but has not started its setup gets no payments
onboarding banner, card or notification. A configuration that offers Money keeps
merchant processing off (the MVP platform names it in `DISABLED`).

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
- **Bank (ACH)**: a charge Forward answers as pending is recorded `pending`,
  not applied to anything, until the `v2.payment.captured` webhook settles it
  (`settlePendingPayment`). Forward's sandbox answers ACH debits `captured`
  (settlement pending) at once, so they are recorded as received. Either way a
  failure or return reverses it (`failRecordedPayment`, `payment.failed`).
- **Bank link windows**: Forward's bank element links the bank through
  GrailPay and MoneyKit, which add their windows to the page at z-index
  999999; `payment-intake.js` lifts them above FirstMate's windows while a bank
  element is mounted, or the bank link opens hidden behind the project window.
  While the bank link is open our form is hidden, so the customer sees one
  window. When it closes, Forward still needs a few seconds to create the bank
  payment method, so the form shows a locked "Confirming your bank payment"
  state (no close button; leaving the page asks first) until the payment is
  recorded or fails. A cancelled link (GrailPay's `ACTION_ABANDONED`, read by
  wrapping `grailpay.init` as Forward calls it) returns to the form at once; if
  no account arrives, the form comes back after a timeout saying nothing was
  charged. A card charge in progress is locked the same way.
- **Forward's "Provide bank account details" button** is inside Forward's
  iframe and has no pointer cursor; no style option reaches it, so that is
  Forward's to fix.
- **Declined** (Forward answers 200 with `status: failed` and
  `decline_category_text`) → nothing is recorded; the customer sees Forward's
  reason; the checkout stays open for another card (next attempt, new key).
- **No answer** (timeout, 5xx after retries) → the checkout is marked
  `unknown`, the intent is looked up, and a charge Forward made is recorded
  (`reconcileCheckout`, `finishCheckoutFromProvider`, also from the webhook).
  The customer is told not to pay again. Autopay retries the same checkout,
  never a new charge.

A charge never runs inside another feature's database transaction. On
PostgreSQL a transaction that throws rolls back everything written in it, so a
charge made inside one could lose its checkout attempt (the next card would
replay the first card's answer) or its payment record while Forward kept the
money. A document's payment output is therefore charged before the document's
signing transaction starts (`chargeDocumentPaymentBeforeLock` in
`documents/service.ts`); the locked step finds that payment and attaches it.
`tests/document-payment-checkout.test.ts` covers this, also on PostgreSQL
(`npm run test:payments:postgres`).

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
