# "VAT included" only where credit is added (1M8-241) - development, October 23, 2026

Source `ab16a5c9` on `claude/vat-label-credits-20261023`, cut from production branch `codex/hotfix-20261023g` (`f3cfb2de`,
production `242fba6c`). Not on the canonical branch.

**Removed** (project-request/app.js, bundle key `20261023-vat-credits-only-v1`): "VAT included" on the order flow's
property-type cards ("€25.00 flat rate", "€40.00 / structure") and on the "Order Roof Report - {price}" button. Prices,
the per-property quote and the VAT calculation are unchanged.

**Kept** (add-credit workflows, unchanged): billing top-up cards ("More credit needed" / "Load your account": the required
amount and the pending-order line, `billing/app.js`), the signup "Load your account" step's "Prices include VAT." note
(`onboarding/wizard.js`), and the Stripe credit checkout description (`platform/api.ts`).

**Tests.** `public/v1/tests/vat-label-credits-browser.test.mjs` (3 pass) runs the real platform-commerce runtime with a
euro account and the real order flow in Chrome; the type cards read "..., VAT included" on `f3cfb2de` and plain euro prices
now, while the add-credit surfaces keep the label. Related suites and `npm run check` pass (`project-feature-gates` fails
its known typed-address test, as on the base).

**Rollout.** `output/vat-credits-20261023/`, merged onto live `d8e2243f` on legacy and web; both verified and dev serves
the new key. The pool node (10.124.16.3) was unreachable (no ARP reply from the web node; the address that answers next to
it has an unknown host key, not accepted), so pool was not updated. Production not changed.
