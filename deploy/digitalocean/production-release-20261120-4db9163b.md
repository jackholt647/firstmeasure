# Production release 4db9163b: localized Stripe receipts (FM-622), November 20, 2026

Released from fm-agents-1 by the FirstMate Tracker production run for the "FirstMeasure bug fixes" workspace (standing
authorization for issues set to "Claude → Testing in prod" once verified on dev; FM-622 was verified on dev in
`platform-20261119214915-30ac78c0`).

The release is `4db9163b`: `origin/production-live` `8d217860` (the record of `1d525b6d`, production at the start of the
run) + `git merge --no-ff` of the plan's branch `claude/fm-622-localized-stripe-receipts-prod` (one commit, `eec9c2a3`,
written on `8631f31c` before FM-623 released). The merge was clean, and its `+/-` lines against `1d525b6d` equal
`eec9c2a3`'s line for line. The plan named `03645bd4` as rollback target; FM-623 (`1d525b6d`) had released since, so
the recorded target was `1d525b6d`.

## Change

- `public/v1/payments/stripe_receipt.ts`: the organization's language (its company/portal language,
  `companyLocalization`) mapped to Stripe's codes (`stripeLocale`: fr-FR → `fr`, en-US → `en`, en-GB/pt-BR as is, …);
  our receipt description and the credit line item (name, description, "VAT included") come from the `billing`
  language catalog in that language. English text is unchanged byte for byte.
- `public/v1/platform/api.ts`: credit Checkout and the save-card setup Checkout send `locale`; a new Stripe customer
  gets `preferred_locales[0]`; an existing customer is updated once (remembered in `billing.stripe.preferred_locale`)
  before a checkout and before the portal automatic top-up, whose description is localized.
- `public/v1/public-firstmeasure/billing.ts`: the same for the public API automatic top-up.
- `public/v1/platform/localization/catalog-source.json` + 15 `packs/*.json`: 7 new `billing` keys;
  `public/libraries/platform-language/catalogs/billing.59a52ce417a5e29e.json` (new) and the catalog manifest's
  `billing` line.
- Tests: `public/v1/tests/stripe-receipt-description.test.ts`, `public/v1/tests/regional-commerce.test.ts`.
- No database, environment, flag or config library change, and no data repair. The only new production Stripe write is
  the one-time `preferred_locales` update on an organization's existing Stripe customer at its next checkout or top-up.

## Checks before release

- Built on the dev worker (`build.sh`, `npm run check` included). Archive sha256
  `2d349b8117d29214c82dbea9cd2b8cbd2b5757575c9a369c6800ec050748439b`. `diff -rq` against `1d525b6d`'s archive lists only
  the files above, their `dist/` output, `release.env` and the previous record.
- The archive's `dist/tests/stripe-receipt-description.test.js` 4/4 and `dist/tests/regional-commerce.test.js` 6/6.
- `web_activate.py` = the `1d525b6d` run's, with the catalog `manifest.json` digest repinned (the only pinned file the
  release changes) plus an FM-622 block: `stripe_receipt.js` exports and keys, `platform/api.js`
  `stripeSyncCustomerLocale` ×1, `locale: stripeLocale(locale)` ×2, `preferred_locales[0]` on create ×1, no fixed
  English line-item name; `public-firstmeasure/billing.js` top-up locale; catalog manifest `billing` →
  `billing.59a52ce417a5e29e.json` (sha256 `897dba01…`, served), 16 locales carry the new keys (en-GB falls back to
  en-US), French description text. 133 file asserts pass on the archive and fail on `1d525b6d`'s tree (control);
  rollback asserts (`1d525b6d`'s, base `4db9163b`) pass on `1d525b6d`'s tree (129).
- In-process probe (read-only, no Stripe call, worker environ with read-only `PGOPTIONS`): on `1d525b6d` (control) the
  module exports only `stripeCreditReceiptDescription` (English); on the installed, inactive `4db9163b`:
  `stripeLocale` fr-FR→`fr`, de-DE→`de`, pt-BR→`pt-BR`, en-GB→`en-GB`, en-US→`en`, ja-JP→`ja`;
  `stripeCreditReceiptDescription(250)` = the existing English sentence; the EUR/fr-FR description = "50 € de crédit
  ajoutés à votre solde FirstMate. Les rapports de toiture sont déduits de ce solde ; …"; the line item "Crédits de
  métré de toiture" / "50 € ajoutés à votre compte FirstMate. TVA incluse."; customer fields `{preferred_locales[0]: fr}`
  and `null` once `fr` is saved.

## Rollout (scripts: fm-agents /srv/agents/work/fm-622-prodrun-scripts)

- Rollback target `1d525b6d` recorded on FM-622 at 02:30 UTC, before anything was installed.
- Installed on compatibility and the worker before 02:37 UTC.
- Channel published against `1d525b6d`'s archive at 02:37:56 UTC.
- Worker activated 02:38:42 UTC with no running jobs.
- Web nodes one at a time, 02:39:02–02:51:42 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility through `compat_gate.sh` (legacy-action < 420/min and load < 10): waited 02:51:55–03:03:28 UTC at
  657–926/min, opened at 407/min. Rolling replace, `COMPAT_DONE` 03:04:33, 0 Node 500s and 0 worker exits in the 20 s
  after.

## Verification

- `current` is `4db9163b` on all 8 hosts; the worker and compatibility's HTTP workers run `RELEASE_ID=4db9163b…`
  (compatibility's MainPID keeps an older id after rolling replaces, as before). Readiness 10/10 200 with `4db9163b`
  right after compatibility and again at 03:25 UTC.
- Plan check 2: `catalogs/manifest.json` through the load balancer gives `"billing": "billing.59a52ce417a5e29e.json"`
  10/10, and that file answers 200 `application/json` with sha256 `897dba01…` 6/6.
- Plan check 3 on the live worker (`current/public/v1`, same probe as above): same results as on the installed release.
- 5xx from 03:05:30 (after compatibility settled) to ~03:20 UTC against the 30 minutes before: web 1–5 per node
  (0.02–0.08 %) against 0.01–0.05 %; compatibility 20 (0.62 %) against 0.54 %. All are the long-standing
  `/measure/internal/top_view_reroll_proxy.php`. Web 02:51–02:55 UTC (web new, compatibility old): 0–1 per node.
- Web and compatibility journals since 02:39 UTC: 0 error lines mentioning Stripe, checkout or top-up. No customer
  credit checkout or top-up ran during the watch (03:00 UTC); `/v1/platform/stripe-webhook-proxy` 7 × 200. No
  production checkout or charge was created by this run.
- Worker jobs since 02:38:40 UTC: 288 completed, 0 failed; queued jobs are scheduled `report.release` (0 due). Worker
  journal 03:00–03:25 UTC: 0 "Worker stopping", 0 PDF "browser has been closed", 0 pool timeouts, 0 heartbeat failures.
- Compatibility 03:04:33–03:23 UTC: 0 watchdog kills, 0 OOM, 0 Node 500s, 0 pool timeouts; same MainPID throughout,
  477–779 legacy-action/min, load 0.9–2.3, available memory 2.47 → 2.25 GB.

## Rollback

`rollback/`: the `1d525b6d` run's forward `web_activate.py` (base `4db9163b`), `web_install.py` and `web_rollout.sh`;
republish the channel with `1d525b6d`'s archive (sha256 `2ede728b…`, `PREVSHA` = this archive) before rolling the web
nodes; worker and compatibility back with `activate-release.sh 1d525b6d…` (`rollback/release.sh`). Code rollback needs
no data change: customers already updated keep `preferred_locales` (only Stripe's email language) and
`billing.stripe.preferred_locale` is ignored by the old code.
