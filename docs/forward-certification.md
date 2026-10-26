# Forward certification

Where FirstMate stands against Forward's certification sheet ("FirstMate
Certification Script.xlsx", from Forward), with the evidence for each case and
what is left. How payments work is in [payments](architecture/payments.md).

Everything below ran on the development stack (`https://dev.1m8.ai`) against
Forward's **sandbox**, through the real UI wherever a person would do it, on
October 19, 2026. A filled copy of Forward's sheet is kept outside the
repository (it includes Forward's sandbox keys):
`output/forward-cert-20261019/FirstMate Certification Script - filled.xlsx`.

## Status

| Module | Status |
| --- | --- |
| Must Dos (partner data, idempotency, ref id, MIT/CIT, L1/L2, error handling) | Done in code and verified at Forward |
| Must Dos (CNAMEs, static IPs, logos, brand color) | Decisions and an email for Jack, below |
| Boarding AP00–AP04 | Done (real UI) |
| Boarding AP05 (video of the boarding flow) | Jack records |
| Webhooks WH00 (mandatory), WH01 | Blocked: the dev webhook endpoint is not registered at Forward and dev has no signing secret |
| Card not present CNP00–CNP07 | Done (real UI, staff and customer portal) |
| ACH00 | Done (real UI, staff Take a payment; also paid a deposit by ACH in the customer portal) |
| ACH01 | $5.55 ACH payment made; Forward triggers the failure (a return) from its payment id, which needs the webhook to reach our books |
| MIT and CIT RC00–RC07 | Done |
| Refunds R00 (full), R01 (partial $9.00) | Done (October 25, on settled payments) |
| Void V00 | Done |
| Video of the checkout (card, ACH, refund policy screenshot) | Jack records |

## Evidence

Sandbox merchant account `acct_3Kk1k0lydGHJHFkaHKOF2bR5k4J` (dev sandbox
organization `org_478ab3c83600ed5e`). Card cases were typed into Forward's card
element in the staff "Take a payment" form; RC04–RC07 saved the card; RC00–RC03
are autopay charging those saved cards for an invoice due now, after the
customer's autopay authorization was recorded. Every intent was read back from
Forward: CIT intents carry `ecommerce`/`customer`, MIT intents
`recurring`/`merchant`/`is_scheduled_payment: true`, all carry `ship_to_zip`
60606 and our payment id as `reference_id`.

| Case | Amount | Card | Initiated by | Payment method | Payment intent | Payment | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CNP00 | $10.00 | VISA | customer | `pm_3KvkwsEQ9V9LlYzhbUQIwgaStuy` | `pi_3KvkwWj6ITfDysfT8SPJ3yF04VW` | `pmt_3Kvkx3uiscCRsONqPtHf0gKJRk2` | Success (captured) |
| CNP01 | $5.55 | VISA | customer | `pm_3KvkywCSNGf57LEQguWOWbgN2jC` | `pi_3KvkyShd6kXcpzPSDyZlHhPmmyS` | `pmt_3Kvkyt8PDjSvlzpJxikfXJskf9G` | Declined: Payment authorization failed. Try a different payment method. |
| CNP02 | $11.00 | MASTERCARD | customer | `pm_3Kvl0STsroH9BRolYxrctATiDq5` | `pi_3Kvl0CnjsprxjLh2SCGf9nrWpeb` | `pmt_3Kvl0TbZDfdOHlWKEvyJAcXFKuV` | Success (captured) |
| CNP03 | $6.66 | MASTERCARD | customer | `pm_3Kvl3tTIqVT5UhOSeQDpVUUzFM0` | `pi_3Kvl3cltaf4rhI4aoxa7tnQtKR7` | `pmt_3Kvl3ztP6d0IOKNVzltcLpFueJX` | Declined: Payment authorization failed. Try a different payment method. |
| CNP04 | $12.00 | DISCOVER | customer | `pm_3Kvl5x2bgfEnJ2sntKqqQUDFGsp` | `pi_3Kvl5W1ojGLW4i4W77DauGBgYG6` | `pmt_3Kvl5x7scucLjmSLPVD7JGUaJdJ` | Success (captured) |
| CNP05 | $7.77 | DISCOVER | customer | `pm_3Kvl7sBwa8CBOTxGGUkBwk2exVP` | `pi_3Kvl7QifuoEgmuMPJ0tFZWV8T9g` | `pmt_3Kvl7ymNme0ENqECAuVTu20yRHa` | Declined: Payment authorization failed. Try a different payment method. |
| CNP06 | $13.00 | AMEX | customer | `pm_3Kvl9lg3gHiD1bbtXUTtyBprVoJ` | `pi_3Kvl9Vr2fw7sMK51hokR6p5dMt9` | `pmt_3Kvl9w1vpKo7MH3Y31VgxoaYmqB` | Success (captured) |
| CNP07 | $8.88 | AMEX | customer | `pm_3KvlBOj8qFClmKzWQ1nsgNb0EHX` | `pi_3KvlBBvvdP3hvrtoXTel6CMAXe5` | `pmt_3KvlBdlfCCcZyBQufYqlINdpWaO` | Declined: Payment authorization failed. Try a different payment method. |
| RC00 | $12.81 | VISA | merchant | `pm_3KvlDVZykc8ryhk6OuEvEKrDmMs` | `pi_3KvlJbQTOXaYb9bAbZ03dLI7BSp` | `pmt_3KvlJhNCdyweN0qga6qZHUwD7LI` | captured |
| RC01 | $19.33 | MASTERCARD | merchant | `pm_3KvlFNnJbcrtDtGW9PzCG3oEiEu` | `pi_3KvlJxLadMqCEgxYhjotpUEEsqs` | `pmt_3KvlK8ePG7Lu31NEIklmlGjIuqy` | captured |
| RC02 | $26.50 | DISCOVER | merchant | `pm_3KvlHN0UXr7bjl40VwIZCG64hpW` | `pi_3KvlKNqku0VmbKCOmgNJMQQ0yIP` | `pmt_3KvlKLQl3si4UHWcA3Rbvrf23AZ` | captured |
| RC03 | $13.85 | AMEX | merchant | `pm_3KvlJBNCpz7Y5PRJSneHspN5SgQ` | `pi_3KvlKjm8WNeblYMwKFNKmk6dlxI` | `pmt_3KvlKoEEiIybqoAUoLcU8fQL5PJ` | captured |
| RC04 | $12.81 | VISA | customer | `pm_3KvlDVZykc8ryhk6OuEvEKrDmMs` | `pi_3KvlD8JWxgb2MN43Wlf4mxcgyL2` | `pmt_3KvlDcPB73Z4i1ncTiw3oQc3PGM` | captured |
| RC05 | $19.33 | MASTERCARD | customer | `pm_3KvlFNnJbcrtDtGW9PzCG3oEiEu` | `pi_3KvlF209hWApGbhhxqdtiJAUlZs` | `pmt_3KvlFJvyLiGfIumLokWEtGiPcvL` | captured |
| RC06 | $26.50 | DISCOVER | customer | `pm_3KvlHN0UXr7bjl40VwIZCG64hpW` | `pi_3KvlH5sPktoWoGnpASQodxksUx6` | `pmt_3KvlHUArFda2BrhUlD8VcKkUewf` | captured |
| RC07 | $13.85 | AMEX | customer | `pm_3KvlJBNCpz7Y5PRJSneHspN5SgQ` | `pi_3KvlIpxljuWCPTUmocdzZ0Gupqw` | `pmt_3KvlJEgMAF4BV1FGCmPnmwWOEmV` | captured |
| V00 | $10.00 | VISA | customer | — | `pi_3KvlMdb5Fcblyl2vnEwzzfd468p` | `pmt_3KvlN4FpzEBmyF4oVRDw5LrKTua` | voided (intent cancelled, $10.00 voided) |

ACH, through Forward's bank element in staff "Take a payment" (MoneyKit's sandbox
Chase bank, an OAuth sandbox bank that needs no credentials; GrailPay's default
account picker; Forward then creates the bank payment method):

| Case | Amount | Payment method | Payment intent | Payment | Result |
| --- | --- | --- | --- | --- | --- |
| ACH00 | $10.00 | `pm_3Kvpwr8ErDBoNE2Nl3FmuOT7xjh` | `pi_3KvppJdsX7QA0kWW75pOKtsn861` | `pmt_3KvpwzVV9R1YaVb7JhCh6OQ6e1m` | captured (rail `us_bank_ach`, unsettled) |
| ACH01 | $5.55 | `pm_3KvrP20bb5gF6WSqkybiRFgma4N` | `pi_3KvrHKqwYb3unLt7NymKcK9igKh` | `pmt_3KvrPADpeurKfkJ8ZhwhGkkvzoi` | captured; ask Forward to fail it (return) |

A $10.00 deposit was also paid by ACH from a document in the customer portal
(the path the checkout video uses).

Found while running ACH, fixed and live (release `6fed67a7`): GrailPay's
account picker and MoneyKit's bank link are added to the page at z-index
999999, below FirstMate's project window, so in Take a payment the bank link
opened invisibly and the account could never be chosen. The payment form now
lifts both above everything while a bank element is mounted.

Two things for Forward or Jack, not bugs in FirstMate:

- The sandbox bank link is branded "Maple Ridge Supp…" (MoneyKit/GrailPay
  configuration on Forward's side), not FirstMate. Ask Forward to set the
  production branding to FirstMate.
- Forward answers an ACH debit as `captured` at once (settlement pending), so
  FirstMate records it as received and a later return reverses it. If Jack
  wants ACH shown as "processing" until it settles, that is a product
  decision and a small change.

Refunds, on payments Forward had settled (run October 25):

| Case | Payment | Payment intent | Refund | Result |
| --- | --- | --- | --- | --- |
| R00 | $11.00 (CNP02) | `pi_3Kvl0CnjsprxjLh2SCGf9nrWpeb` | `ref_3LD9mWyPwwPge9CjAfmuOzo9yfv`, $11.00 | refunded in full |
| R01 | $12.00 (CNP04) | `pi_3Kvl5W1ojGLW4i4W77DauGBgYG6` | `ref_3LD9mh3YXmPLntUCSZI3fpD62H4`, $9.00 | partially refunded |

Boarding, through Settings › Payments › Set up payments on a fresh dev sandbox
organization (`org_5fc5b06045060cdc`):

- AP00 business: `bus_3KvkwCl68kbWiujGBCr3UtyRRpC`
- AP01 application (US, DRAFT, `external_account_id` = our organization id):
  `aapp_3KvkwF1gn3ENr4P2zT7XrHNNmge`. Forward stored our partner data
  (`paid_subscription`, `backbook`, `merchant_joined`, `last_ip_address`,
  `redirect_url`).
- AP02 hosted application link:
  `https://application.sandbox.getfwd.com/aapplink_3KvkwHqhyH9o55sCI1tWJKCWor2`,
  shown inside our "Set up payments" window (screenshot
  `cert-shots/ap2/AP02-hosted-application.png`).
- AP03 MCCs: 1761 Roofing, sheet metal and siding contractors; 5039
  Construction materials.
- AP04 processing plans: `partppl_3HpoNDtV6PtzrHasDxATGCIww6m` (Standard Flat
  Rate Plan - US), `partppl_3HpoagfDHkidHgm5jNA6Y0UhuAk` (Standard Flat Rate -
  CAN).

Also verified on dev through the UI (`scripts/forward-checkout-ui-e2e.mjs`,
12/12): the customer portal declines Forward's failure card with Forward's
reason, records nothing, then takes another card on the same checkout and
records exactly one payment; the refund policy shows on every checkout; a staff
refund of an unsettled payment voids it at Forward; an organization that is not
set up shows no Pay button on documents and a "not set up" notice instead of
card or bank entry in Take a payment.

Webhook events FirstMate handles (sheet "Webhooks"): `v2.account.gateway_updated`
and the other `v2.account.*` events, `v2.application.*`, `v2.payment.*`,
`v2.payment_intent.*`, `v2.refund.*`, `v2.reversal.*`, `v2.payout.*`,
`v2.dispute.*`.

## Must Dos

- **Partner data**: sent on every application, hosted or API-created.
- **Idempotency**: every write has a stable key: `fm-pi-<checkout>` (intent),
  `fm-pay-<checkout>-<attempt>` (charge), `fm-ref-…` (refund), `fm-void-…`.
  Retries reuse the key.
- **Ref id**: `reference_id` is our payment id; `invoice_id` is the invoice or
  document number.
- **MIT/CIT**: as above.
- **L1/L2**: the card element collects card, expiry, CVC, country and postal
  code (AVS); billing details go with the charge; Level 2 sends the job site's
  ZIP as `ship_to_zip` and the tax amount when the document or invoice has one.
- **Error handling**: 429 and 5xx are retried with backoff and the same key;
  other 4xx are not retried; a decline (Forward answers 200 with
  `status: failed`) shows Forward's reason and leaves the checkout open; a
  timeout or lost answer is looked up on the intent before anyone can pay again.
- **CNAMEs** (decision): Forward asks for an application-page and a
  merchant-portal domain. The brand package suggests `app.1m8.ai` for the
  application page, but **`app.1m8.ai` is production FirstMate**; pointing it
  at Forward would take production offline. Use a new name, for example
  `apply.1m8.ai` (application) and `payments.1m8.ai` (merchant portal).
- **Static IPs** (decision): production's web pool replaces nodes and their IPs
  change ("Web IPs change when the pool replaces nodes", DEPLOYMENT.md), so an
  allowlist of today's IPs would break. Calls to Forward come from the web nodes
  (and the worker once autopay runs there). A fixed egress (for example a
  DigitalOcean NAT gateway or reserved egress IP for the web pool and worker) is
  needed before giving Forward IPs. Development today: web `143.198.68.11`,
  worker `137.184.44.82`, compatibility `137.184.229.145`.
- **Logos and brand color**: the package in
  `C:/Users/jackh/Code/2026/FirstMate Forward Brand Package` (primary
  `#DB0000`, transparent PNG logos) is ready; Forward asked for it as a ZIP in
  the kickoff email thread. Nothing has been sent.

## What Jack needs to do

1. **Webhooks (WH00, and ACH settlement):** in Forward's sandbox dashboard add
   the endpoint `https://dev.1m8.ai/v1/payments/webhooks/forward` for all
   events, and put its signing secret (`whsec_…`) on the dev web and pool hosts
   as `FORWARD_WEBHOOK_SECRET`. Then boarding a sandbox account produces
   `v2.account.gateway_updated`; its event id goes in WH00.
2. **ACH01:** ask Forward to fail (return) ACH payment
   `pmt_3KvrPADpeurKfkJ8ZhwhGkkvzoi`; with the webhook set up, FirstMate
   reverses it and records `payment.failed`.
4. **Videos:** AP05 (Settings › Payments › Set up payments on a fresh sandbox
   organization, through Forward's application) and the checkout video (a
   document's Pay button in the customer portal: the address bar shows the
   https link; pay by card, then by ACH; screenshot the refund policy line).
5. **Ops decisions above:** CNAMEs, fixed egress IPs, and the brand email.
6. **Dev worker and compatibility hosts** have no Forward keys
   (`/etc/firstmeasure/development-forward.env` is loaded only by web and
   pool), so scheduled autopay on the worker treats payments as not set up and
   charges nothing; the autopay cases ran through `POST /autopay/run` on web.
   Production needs the keys on every role that charges.

## Re-running

From `public/v1`, with the dev sandbox organization:

```bash
CERT_SANDBOX_ORG=sbi_ed160dc071c04ae5 CERT_ORG_ID=org_478ab3c83600ed5e CERT_SHOTS=<dir> node scripts/forward-certification-run.mjs cards cit mit void
```

Phases: `cards` (CNP00–07), `cit` (RC04–07), `mit` (RC00–03), `void` (V00),
`refunds` (R00/R01, after settlement), `boarding` (AP03/AP04), `timeout`
(Forward's sandbox timeout card). Cases already recorded as passing are kept.
`scripts/forward-checkout-ui-e2e.mjs` runs the portal, staff and not-set-up
checks (`WEB_ORIGIN`/`API_ORIGIN` `https://dev.1m8.ai`, login files
`{"sandbox": "sbi_…", "orgId": "org_…"}`).
