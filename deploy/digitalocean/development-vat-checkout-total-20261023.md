# 1M8-241 follow-up: "VAT included" moves to the checkout total - development, October 23, 2026

Source `7e3ddeb8` on `claude/vat-checkout-total-20261023`, cut from `codex/hotfix-20261023n` (`2f246d80`). Not on the
canonical branch.

Ben's comment and screenshot (the "More credit needed" modal): remove "VAT included" from the top-left "Needed for
order" amount and show it at the checkout total as "€25 VAT included". `billing/app.js` (bundle key
`20261023-vat-checkout-total-v1`): "Needed for order" shows the plain amount; for VAT-included accounts "Total for
checkout" reads "{amount} VAT included" (new key `billing.checkout_total_vat_included`) in the account's currency format
and follows the credit to add. US accounts are unchanged. The screenshot also shows the label on the pending-order line
("Residential - Standard - Roof Only - €25.00, VAT included"); Ben did not mention it and it is unchanged.

Unchanged: no label in the order flow, the signup "Prices include VAT." note, the Stripe credit checkout description.

Tests: `public/v1/tests/vat-label-credits-browser.test.mjs` (5 pass) opens the real billing modal in the "More credit
needed" state with a euro account and a pending order (fails on `2f246d80` with "€25.00, VAT included" at the top and a
plain total) and checks a US total has no label. `npm run check` passes.

Rollout: `output/vat-checkout-20261023/`, merged onto live `ffbdfc29` on legacy and web; both verified and dev serves the
new key. The dev pool node (10.124.16.3) is still unreachable, so pool was not updated. Production not changed.
