# Development rollout: Forward certification, one payments gate and the two-step checkout (October 19, 2026)

Releases on `codex/consolidated-firstmeasure-20260923`, each activated on all four development roles (worker,
legacy, web, pool) and verified. Production is unchanged.

| Release | What |
| --- | --- |
| `dd213586` | The payments gate, the two-step Forward checkout, voids and refunds through Forward, webhook processing (with `c638bb4a`, the manifest bump, and `efe2da57`) |
| `0655b0a9` | Document payments are charged before the signing transaction |
| `e5d8475a` | The job site's ZIP goes to Forward as `ship_to_zip`; a declined card leaves no uncaught page error (`c9fa7542`) |
| `dd704773` | Hosted sign-up sends Forward the full partner data |
| `6fed67a7` | The bank-link windows (GrailPay, MoneyKit) open above the project window. Legacy, web and pool only (browser code); the worker kept another session's `d63d657f` |

`35aa58f6` was staged on legacy, web and pool but never activated (another rollout activated in between and the
activation refused); it was superseded by `e5d8475a`.

## What shipped

Design: [payments](../../docs/architecture/payments.md). Certification evidence and what is left:
[Forward certification](../../docs/forward-certification.md).

- `payments/readiness.ts` is the one gate for charging, saving methods, autopay and online payment requests. No
  mock or "recorded as paid" path remains for card or bank payments; the simulator is refused on production data.
- Every browser payment prepares a checkout and a Forward payment intent (CIT/MIT order details, invoice id,
  ship-to ZIP, stable idempotency keys), then confirms with the element's token. Declines leave the checkout open;
  lost answers are looked up; ACH is pending until Forward's webhook.
- Refunds before settlement void through Forward; later ones refund through it.
- New collection `payment_checkouts` (platform documents; no schema change). New work event `payment.failed`.

## Fixes found by testing on dev

- **Document payments rolled back on PostgreSQL.** The document output is recorded inside the signing store's
  transaction, which on PostgreSQL also holds every platform write; a decline rolled back the checkout's attempt,
  so the next card replayed the first attempt's key and Forward answered with the same decline. Local file storage
  has no rollback, so only dev showed it. Fixed in `0655b0a9`; `tests/document-payment-checkout.test.ts` fails on
  embedded PostgreSQL without the fix (`npm run test:payments:postgres`).
- **No ship-to ZIP.** A scripted edit had turned the ZIP regex's `\b` into backspace characters.
- **Hosted sign-up partner data** carried only the return URL.
- Staff saw saved cards as `american_express ending in …`.
- **ACH bank link hidden.** GrailPay's account picker and MoneyKit's bank link sit at z-index 999999, under the
  project window (2147483200); the bank could be "linked" but never chosen, so no payment was ever made. Verified
  after the fix by ACH00, ACH01 and a customer-portal deposit paid by ACH.

## Host merges

`platform/storage.ts` and `storage_postgres.ts` collection lists and the hosted sign-up block of `payments/api.ts`
were replayed as exact edits onto each host's live file (hosts carry their own versions of those lines; the
redirect-comparison mode on canonical is not deployed). Hosts keep their own `tests/access-gates.snapshot.json`
and `tests/payment-browser-api.test.ts`. Tooling: `output/forward-cert-20261019/` (`candidate.py`,
`integrate.py` merges a worktree branch into the shared checkout without touching other sessions' staged or
unstaged work, `replay.py`, `ship.sh` with `ROLES=`).

## Checks

- Local: `npm run check`; `npm run test:payments` (65); `document-payment-checkout` on SQLite and embedded
  PostgreSQL; `documents-api`, `crew-api`, `customer-portal-v2`, `customer-portal-writes`, `document-signing`,
  `document-signing-postgres`, `access-gates`, `contact-merge`, `contacts-store`, `publication-actions`,
  `publication-actions-domains`, `app-experience`, `payments-onboarding`, `payments-forward-redirect` pass.
  Failing before this work and unchanged: one `documents-api` workflow-steps case, one `collaboration-api`
  appointment-permission case, `proposals-api` fixture, one `payment-browser-api` streamed-signup case.
- Dev, real UI against Forward's sandbox: the certification cases (22/22) and
  `scripts/forward-checkout-ui-e2e.mjs` (12/12), every intent read back from Forward.
- The development platform worker was restarted after the releases.

## Notes

- Dev worker and compatibility hosts do not load `development-forward.env`; scheduled autopay there sees payments
  as not set up and charges nothing. No `FORWARD_WEBHOOK_SECRET` is set on any dev role.
- Rollback: `dd704773` replaced `e5d8475a` on every role; `e5d8475a` replaced `10212b7a` (web, legacy, pool) and
  `61d391ce` (worker); `dd213586` replaced `f709807f` (web, legacy, pool) and `c255dda3` (worker). Other sessions
  shipped in between, so roll forward rather than back where possible. `payment_checkouts` documents are additive.
