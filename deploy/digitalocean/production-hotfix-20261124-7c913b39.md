# Production release 7c913b39 (FM-634 Stripe Checkout says "FirstMate Credit"), November 24, 2026

Production runs `7c913b3982bf6bc644028c572147c24932a4ddfc` on all 8 hosts (compatibility, worker, 6 web nodes).
Rollback target: `a19876b4ac9bb264b795666a72631e8612081242` (FM-632), recorded on FM-634 before activation.

## What changed

Branch `claude/fm-634-fix-prod` = production-live `5f93bd60` (record of a19876b4) plus one commit, released as is:

- `7c913b39` (cherry-pick of dev `4ca95ba3b`, platform-20261124201426-951393e6): every credit checkout sends its own
  Stripe line item (`price_data`: currency, `unit_amount` = one credit in minor units, i.e. 100 for USD, the same as
  the old fixed Price; `product_data` name and description). It no longer sends `line_items[0][price]`, the
  dashboard Price whose product showed "Roof Measurement Credit" / "FirstMeasure roof measurement report credits."
  (`platform/api.ts`, `stripePriceId()` removed). `payments/stripe_receipt.ts`: name "FirstMate Credit", description
  "FirstMate Credits" (bonus offers: "FirstMate Credits With Limited-Time Bonus" with the breakdown). The unused
  `STRIPE_*PRICE_ID` settings left `src/config/env.ts`; the variables on hosts stay and nothing reads them. Billing
  keys `stripe_line_credits`/`_bonus` reworded, `stripe_line_added` replaced by `stripe_line_description` in the
  catalog source and 15 packs; compiled `billing.7aa55f2b61e0a538.json`, catalog manifest points to it (the old hashed
  file stays). Tests: stripe-receipt-description, regional-commerce, stripe-credit-fulfillment, europe-pricing.

The archive (sha256 `decc41ef4a4340f7d501f34119323070a1c231c4dda672be014be074f60fa0b9`) differs from a19876b4's only in
those files plus their compiled `dist/` output, `release.env` and the earlier records. No data, environment, flag,
NGINX, config-library or Stripe change. Fulfillment reads session metadata and checks `amount_subtotal` against
`paid_minor` (100 x quantity), unchanged. New USD purchases show in Stripe as inline line items named "FirstMate
Credit" instead of under the dashboard product "Roof Measurement Credit" (EUR and bonus purchases already did).

## Rollout (full path: Node code and catalogs change)

Scripts: `/srv/agents/work/fm-634-prodrun-scripts` on fm-agents-1 (FM-632's set, base a19876b4; rollback set in `rollback/`).

- Built on the dev worker (`build.sh`, 309 s). The plan's compiled tests from the archive (stripe-receipt-description,
  regional-commerce, stripe-credit-fulfillment): 18/18 pass. `release.sh install` on compatibility and worker.
- Worker activated 20:34:34 UTC (no running jobs). Web channel published with previous sha256 `2dae639d…` (a19876b4).
- Web nodes one at a time 20:35–20:48 UTC, each drained, activated and checked before the next (file asserts for every
  release through FM-634; FM-634's: no `line_items[0][price]` and no `stripePriceId` in `dist/platform/api.js`,
  `stripe_line_description` in `dist/payments/stripe_receipt.js`, no `STRIPE_LIVE_PRICE_ID` in `dist/src/config/env.js`,
  catalog manifest billing entry, billing catalog sha256 `3b465cc9…` served by the node, en-US "FirstMate Credit" /
  "FirstMate Credits" and no roof wording in any language's line item). FM-622's billing manifest pin was dropped;
  its catalog file is still pinned and served.
- Compatibility through the gate: waited 31 min (560–1,330 legacy-action/min, 20:48–21:19 UTC), opened 21:20:01;
  rolling replace, 0 500s, 0 exits in the first 20 s.

## Checks

- `readlink -f /opt/firstmeasure/current` = 7c913b39 on all 8 hosts; `/v1/health/ready` 10/10 ok on 7c913b39.
- Through app.1m8.ai (4 requests each): catalog `manifest.json` names `billing.7aa55f2b61e0a538.json`; that file 200,
  sha256 `3b465cc9…`, contains `"stripe_line_description":"FirstMate Credits"`.
- Installed release on all 8 hosts: `line_items[0][price]"` count 0 in `dist/platform/api.js`,
  `stripe_line_description` count 1 in `dist/payments/stripe_receipt.js`.
- Worker in-process (read-only, no Stripe call): the deployed `stripeCreditLineItem` gives en-US
  "FirstMate Credit" / "FirstMate Credits", bonus "FirstMate Credits With Limited-Time Bonus" / "$250 purchased + $25
  limited-time bonus (10% bonus) = $275 added to your account", fr-FR "Crédit FirstMate", de-DE "FirstMate-Credit".
  No live charge was made.
- Web journals since 20:35: 0 `Stripe checkout failed`, `stripe_checkout_payment_review` or
  `stripe_checkout_amount_warning` (24 h before: 0).
- 5xx: web nodes 0.02–0.06 % from 20:49 vs 0.03–0.07 % in the 30 min before; after compat 0–0.12 %; compatibility
  0.36 % (1 request) vs 0.56 % before. Every 5xx is the long-standing `top_view_reroll_proxy.php`.
- Worker since activation: 0 failed jobs and no worker journal errors (pdf.sync, report.delivery, report.release,
  imagery.process completing; queued report.release are future timers).
- Compatibility watch 21:21–21:37 UTC: no OOM, no Node 500s, no pool timeouts; one watchdog kill at 21:32:22 (slot 2),
  whose only unfinished request was `GET /v1/internal/crm/referrals/acquisition/export` (the staff CRM export that
  holds the event loop, FM-393). `dist/internal/crm/referrals.js` is byte-identical in both releases, and the old
  release had the same kind of kill at 15:21; not a regression, not rolled back.
