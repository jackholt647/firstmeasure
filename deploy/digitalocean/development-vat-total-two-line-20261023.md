# 1M8-241 second follow-up: checkout total on two lines - development, October 23, 2026

Source `5d388d2c` on `claude/vat-total-two-line-20261023`, cut from `codex/hotfix-20261023o` (`afa31161`, production
`aa66cd9b`). Not on the canonical branch.

**"Broken."** Ben's screenshot shows the checkout total as the literal "{amount} VAT included". `aa66cd9b` used a new key
(`billing.checkout_total_vat_included`) with a raw "{amount} VAT included" fallback; the language runtime (`core.ts`
`text`) returns a key's fallback unchanged when the compiled catalog lacks the key, so the placeholder was never filled.
The browser test had not loaded the language runtime.

**Change** (`billing/app.js`, bundle key `20261023-vat-total-two-line-v1`): the total shows only the amount; "VAT included"
is on its own line beneath it (`#bTotalVat`, 12px, secondary grey, new key `billing.checkout_vat_included` without a
placeholder), hidden for accounts without VAT-included prices.

**Tests.** `public/v1/tests/vat-label-credits-browser.test.mjs` (5 pass) now loads the real language runtime and asserts
the two lines (amount alone, "VAT included" below, smaller, different colour) and no unfilled placeholders in the modal;
it reproduces "{amount} VAT included" on `afa31161`. `npm run check` passes.

**Rollout.** `output/vat-two-line-20261023/`, merged onto live `eef3b3fa` on legacy and web; verified, dev serves the new
key. The dev pool node (10.124.16.3) is still unreachable and was not updated. Production not changed.
