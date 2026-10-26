# Development rollout: customer portal payment step (October 25, 2026)

Release `3f4a7277` on the development worker, legacy and web (pool down),
shipped with `output/portal-payment-step-20261025/ship.sh`; `verify` passed.

## What changed

- Each document in the customer portal payload carries `payment_due`
  (`output_key`, `label`, `amount_cents`) for its first unpaid payment output,
  priced by `documentPaymentDue`, the same function the document's Pay button
  charges with. It is `null` once paid or when nothing is due.
- The Summary tab's Next Steps adds **Make payment** with the amount due. It
  opens the document on its Pay task. When the organization cannot take online
  payments (`online_payments: false`) or the viewer cannot pay, the step shows
  the amount and "Contact <company> to pay" and is not clickable. "All
  documents are complete" no longer shows while a payment is due.
- The portal now reads `online_payments` from the top-level payload; project
  bundles do not repeat it, so the old check always read "available".
- The `portal.next_steps` widget opens a step through the portal's new
  `openStep`, so its payment step also lands on the Pay task.

Files: `public/v1/platform/api.ts`, `public/customer_portal/customer_portal.js`,
`public/libraries/portal-widgets/firstmate-portal-widgets.js`; tests in
`public/v1/tests/customer-portal-v2.test.ts`.

## Verified on dev

Portal `229b82d0-188f-4d0b-97fa-0a892afc2787` (sandbox org
`org_bd2dc4ec23d4c65f`): the signed deposit proposal's payload carries
`payment_due.amount_cents = 626632`, Next Steps shows "Make payment —
$6,266.32 due", and clicking it opens the proposal scrolled to its Pay widget
(no payment was made).
