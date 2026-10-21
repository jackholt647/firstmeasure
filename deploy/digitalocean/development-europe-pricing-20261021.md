# Europe report pricing — development, October 21, 2026

Source `cd556525` on branch `claude/lucid-yonath-777e5b`, after merging `origin/codex/consolidated-firstmeasure-20260923`
(`31141b11`, includes hotfixes `10d8d525` and `7b4b9df6`). Not on the canonical branch yet.

**Prices outside the US and Canada** (confirmed by Jack): €25 residential and €40 per structure for commercial and
multifamily, VAT included; €5 gutter add-on. They live in the commercial pricing policy as `international_prices`
(`residential`, `per_structure`, `gutters`, `vat_included`, `expedite_time_zone`). Operators can edit them on the internal
Prices page ("Outside the US and Canada"). Saved policies without the field load with these defaults.

**Expedite.** Rush is offered in every market. The `international_expedite_enabled` switch is retired (still accepted
in saved policies). Rush fees use the same numbers as the US tiers, in euros. A USD account ordering abroad converts
them at the reference rate to the cent (base prices stay whole dollars). The busy-period curve, cut-offs and delivery
windows run on the property country's zone. If there is no property, they use the organization's company time zone,
then its country's zone, then the configured default (`Europe/London`). US and Canada stay on Pacific time. EUR
quotes from before this release are refused with `pricing_changed` (market revision 3).

**VAT included.** The commerce view and quotes return `vat_included`. VAT included is shown on the order type cards
("€25.00 flat rate, VAT included", "€40.00 / structure, VAT included"), on the order button, on the onboarding load
page ("Prices include VAT."), in the Stripe credit checkout description, and on the credits page order summary (see
the follow-up below). No VAT is calculated or itemised.

**Also.** The regional billing policy form keeps the other policy fields when it saves.

**Tests.** New `tests/europe-pricing.test.ts` (5) passes. property-market-pricing, property-market-orders,
pricing-admin and signup-region were updated to the new rules and pass, as does regional-commerce. `npm run check`
passes.

**Rollout** (`output/europe-pricing-20261021/`). Only this commit's files were shipped, with base `6af36b1c`, so
canonical changes owned by other sessions were not pushed. Localization files were replayed onto live copies. Hosts
run `14a6e3de`'s equivalent `profileBasePrice` fix in `billing/app.js` and a newer `pricing-admin.test.ts`, so both
were kept live. All four roles were activated and verified on `cd556525`.

**Checked on dev.** Signing up with France chosen, from an America/New_York browser, gave EUR, `vat_included: true` and
€25/€40/€40/€5. A Paris quote offered standard €25, under-1-hour €28.45 and 1–3-hour €26.15 on `Europe/Paris`
windows. Multifamily cost €40 per structure, with €41.97 for a 1–3-hour rush. The Stripe test checkout came back in
`eur` for €100.00. Production was not changed.

## Follow-up: credits page VAT text — release `ebc56372`

Keeping the hosts' `billing/app.js` whole had dropped this release's two credits-page edits. The follow-up
(`output/europe-pricing-billing-20261021/`) replays only those edits onto the live copy: VAT included on the "Needed for
order" total and on the pending order summary. It also bumps the billing bundle to `20261021-europe-pricing-v2`.
Legacy, web and pool were activated and verified, and the served file contains the change. The candidate is the record
commit, whose `billing/app.js` matches `cd556525`. The ship script's parent check was disabled for this follow-up only.
