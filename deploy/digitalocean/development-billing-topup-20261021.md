# Development: orders after a credit top-up, refunds on the statement

October 21, 2026. Releases `14a6e3de` and `039723d8` on branch `claude/musing-perlman-70af85`
(built on `31141b11`, the production base with hotfixes `10d8d525` and `7b4b9df6`). Not yet on the
canonical branch; the coordinating session merges it. Nothing was released to production.

Customer bugs:

- **1M8-198 (order not placed after adding funds).** A paid Stripe credit checkout is credited when
  Stripe's configured amount (`amount_subtotal`, Price unit_amount x quantity) or `amount_total`
  matches the credit sold, so tax or a discount no longer refuses it; a higher configured amount is
  credited with a `stripe_checkout_amount_warning` log line. A different currency or a lower amount is
  held: one `stripe_checkout_payment_review` log line, `stripe_payment_reviews` on the organization
  and in the internal documents, and the customer is told the payment was received and the order is
  saved. The billing resubmit now sends `report_market_revision` (international orders were rejected
  without it) and uses the quote the order screen showed (`order_original_amount`,
  `order_quoted_amount`, else `report_expedite_net_total_price`) instead of local US prices. A balance
  still short of the order says so; a failed resubmit shows the server's message.
- **1M8-218 (top-up page in USD).** The pending-order fallback uses the organization's commercial
  prices; weather is charged per structure, as on the server.
- **1M8-200 (refunds counted as payments).** The monthly statement classifies ledger entries by reason
  (`platform/credit_statement.ts`): `total_payments` counts payments only, refunds are
  `total_refunds`/`refunds_in` and stay out of `total_in`; the billing tab shows Refunds and
  Payments / Refunds.

The review-list route first added at `/v1/internal/payments/stripe-reviews` was removed in `039723d8`:
`/v1/internal/*` answers without authentication on dev, so it would have exposed customer emails.

## Rollout

Scripts in the worktree's `output/billing-topup-20261021/` (copied from `resoffit-occlusion-20261021`),
all four roles, every file three-way merged onto each host's live copy; the one-line apps manifest is
replayed (bundle versions `20261021-billing-topup-v1`/`-v2`). Other sessions activated releases
between audits; their merges kept these changes. For `039723d8`, one legacy stage failed its host
TypeScript check with no compiler output while other rollouts compiled, and one activation stopped
after the worker because another session activated legacy first (the guard refused); legacy, web and
pool were then rebuilt on the new live files and activated. All four roles verified on `039723d8`;
`/v1/internal/payments/stripe-reviews` returns 404 again.

## Validation

- `npm run check`; `npm run test:payments` (71 + 4 pass), which now includes
  `tests/stripe-credit-fulfillment.test.ts` and `tests/billing-pending-order.test.mjs`;
  `platform-stripe`, `regional-commerce`, `billing-workspace` and `credit-export` tests pass.
- The new client tests fail against the previous `billing/app.js`.
- On dev: all roles verified on the release; a read-only host script ran the compiled amount check and
  statement totals and scanned dev ledgers (5807 organizations with ledgers, 728 with refunds, 2248
  refund entries that the old statement counted as payments); the served billing, settings,
  project-request and manifest files carry the changes.
