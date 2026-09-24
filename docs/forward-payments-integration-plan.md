# Forward Payments Integration Plan

**Status:** Pre-key build COMPLETE (2026-08-13) — everything in §6a is built and verified against the mock provider; awaiting API keys from rep for sandbox go-live
**Date:** 2026-08-12 (portal recon added same day)
**Provider:** Forward (docs.getfwd.com) — managed PayFac ("Managed PFAC")
**Direction:** API-first with our own UIs. Forward's hosted/white-label surfaces only where unavoidable.

---

## 1. Where we stand today

The good news: FirstMate already has a complete AR backbone — payment schedules with a normalized vocabulary, obligations with a recognition engine, invoices with derived statuses and aging, allocations, refund records, a double-entry ledger, an append-only payment event stream, and a processor-agnostic card/ACH intake modal mounted on the customer portal, Money app, crew app, and document widgets. `payment_intents` and `payment_transactions` even have `provider`/`processor` fields already carved out (currently inert).

What's missing is everything acquiring-specific — and Forward covers all of it:

- **No processor.** The intake modal collects card fields and throws them away; portal payments are recorded via a `mock-deposit` route. No tokenization, no PCI boundary, no real money movement.
- **No onboarding/underwriting.** No merchant application, KYB/KYC, beneficial owners, MCC, bank verification, or boarding state machine.
- **No payouts/batches/settlement.** Our reconciliation is a manual `cleared_at` flag.
- **No fee model.** Only a hardcoded 3% document-level surcharge formula; no per-org rate config, no per-transaction fee capture.
- **No dispute handling, no vault, no wallets, no terminals.**

Forward's model maps almost 1:1 onto the slots we left open. This is a wiring job plus new dashboards, not a rebuild.

---

## 2. Forward capability inventory — everything their API can do

### 2.1 Boarding API (onboarding + underwriting + merchant management)

| Capability | Endpoints | Notes |
|---|---|---|
| **Businesses** | `POST/GET /businesses` | Top-level entity = one of our orgs. Name + contact info. |
| **Applications** | `POST/GET/PUT/DELETE /applications`, `POST /applications/{id}/link` | The underwriting vehicle. Draft → submit → underwriting → approved. Carries company (legal name, EIN/BN, ownership type, MCC, category, start date, website), address, owners, volumes/ticket sizes, delivery timeframes, in-person vs online mix. API fields PRE-POPULATE the hosted `/link` form; final submission (signatures) is hosted-only for partners — see §5. |
| **Application lifecycle** | status on GET | `DRAFT → UNDER_REVIEW → UNDERWRITING → APPROVED / NEED_INFORMATION / CONDITIONALLY_APPROVED / CREDIT_PENDED / DECLINED / CANCELLED`. `NEED_INFORMATION` exposes `documents_requested`. |
| **Owners / beneficial owners** | on application | Name, email, phone, SSN/SIN, DOB, residence address, ownership %, title (valid titles vary by ownership type, US + Canada). Exactly one owner must have `signer: true`. |
| **Accounts** | `GET /accounts`, `GET /accounts/{id}` | Auto-created on approval. Carries `processing_enabled`, `payouts_enabled`, gateway config. `external_account_id` persists our org id through application → account. |
| **Processing plans** | `GET /processing_plans[/{id}]` | **This is where interchange-plus vs flat-rate lives.** Plans define fees + payout behavior; you pick `processing_plan_id` per application. Switching a merchant between pricing models = assigning a different plan. Plan contents are configured with Forward's team, selected by us via API. |
| **Bank accounts** | `GET /bank_accounts[/{id}]` | Merchant payout accounts + verification status. (Read endpoints documented; adding may go through the application/hosted flow — open question.) |
| **Locations** | full CRUD | Multi-location merchants. |
| **Users + magic login** | `POST/GET/PUT /users`, `PUT /users/{id}/status`, `POST /users/{id}/login_url` | Merchant-side users with single-use passwordless login links (created automatically for the signer at submission). REQUIRED: bank-account changes and dispute responses are portal-only, so we mint SSO links from the Payments pane and dispute rows — see §5. |
| **Payees** | `POST /payees/link`, `GET /payees`, activate/deactivate, payee applications | Lightweight-underwritten recipients (individuals or companies) that can receive payment splits. Onboarded via a hosted link (their KYC — unavoidable hosted surface). |
| **MCC codes** | `GET /mccs` | Assigned merchant category codes for application prefill. |
| **User fields** | on applications | Free-form JSON custom data, optionally schema-validated — lets us stamp FirstMate org/branch ids on everything. |

### 2.2 Payments API (money movement)

| Capability | Endpoints | Notes |
|---|---|---|
| **Payment intents** | `POST/GET/PATCH /payment_intents`, `/search`, `/cancel`, `/capture` | Core object. Amount in cents, `merchant_amount`, `payment_splits`, order details, `reference_id`, `user_fields`. Statuses: `created → processing/pending/uncaptured → captured / cancelled / failed`. Tracks authorized, captured, refunded, voided, disputed, reversed, rejected amounts. Auth-then-capture supported. |
| **Payments (charges)** | `POST/GET /payment_intents/{id}/payments`, `GET /payments/{id}` | Executes an intent with a `payment_method_id`. Returns AVS/CVV results, auth codes, entry mode, decline categories, settlement status, gateway responses. Billing details overridable per payment. |
| **Refunds** | `POST /payment_intents/{id}/refunds`, `GET /refunds/{id}` | Full + partial. |
| **Tokenization (Elements SDK)** | JS SDK, sandbox + prod CDN | Iframe-based secure capture inside **our** UI: Payment Element, Card Element, Bank Element, Apple Pay / Google Pay buttons. Brandable/styleable. Returns a `payment_method` token; card data never touches our servers. This is the PCI boundary — required, but it's embedded fields, not a hosted page. |
| **Payment methods (vault)** | `GET/PATCH /payment_methods/{id}` | Types: `card`, `bank` (US ACH), `ca_bank` (EFT). PATCH updates billing address, contact, expiration. |
| **Payment method intents (PMI)** | full CRUD + cancel | Card/bank-on-file storage decoupled from charging. Two modes: client-secret flow (customer enters details in our UI) or direct server-side creation (bulk migration). Optional $0-auth validation with CVV/AVS; validation fee billable to partner or merchant via `bill_to`. |
| **Bank payments (ACH/EFT)** | via intents with `payment_method_types: ["bank"]` | Bank Element handles account linking. Requires per-merchant enablement. |
| **Wallets** | Apple Pay / Google Pay via SDK | Forward manages Apple certificates; we host a domain-association file per domain (≤99 domains per merchant ID). |
| **Checkout sessions** (hosted) | full CRUD, expire, send via SMS/email, email receipt | Forward-hosted payment page with surcharge config + expiration. **White-label — we skip it**; our portal + Elements replicates it. Noted as fallback for "text a payment link" before our own surface exists. |
| **Payouts / settlement** | `GET /payouts`, `/payouts/{id}`, `/payouts/business/{id}` | **The batches-to-bank data**: what's been swept, settlement status, per-business payout listings. Feeds "money taken / batch / when you'll receive it." |
| **Balances** | `GET /balances` | Ledger account balances (funds held pre-payout). |
| **Transactions (reporting)** | `GET /transactions`, `/search`, `/download` | Unified transaction reporting with advanced filtering + bulk export. |
| **Unmatched settlements** | `GET /unmatched_settlements` | Settlement rows that didn't match a known payment — reconciliation exceptions feed. |
| **Disputes** | `GET /disputes[/{id}]` | Chargeback listing + detail. (Evidence-submission workflow: open question — may be dashboard-only.) |
| **Adhoc fees** | `POST/GET /fees`, `POST /fees/{id}/refund` | Charge a merchant a fee, attached to a payment (≤ payment amount, settles with it) or standalone (settles on schedule). Use: platform fees, late fees, service charges. Requires account-level enablement by Forward. |
| **Payment splits** | `payment_splits[]` on intent | Route portions of a payment to the partner (us) or activated payees at settlement. This is how **our per-transaction platform revenue** can be collected automatically. |
| **Surcharge** | `POST /surcharge/calculate` | Compliant card-surcharge calculation — replaces our hardcoded 3%. |
| **External payments/refunds** | `POST/PATCH /external_payments[...]`, `/external_refunds` | Record transactions authorized on a third-party gateway for unified reporting/settlement. Likely unused; useful only for migration overlap. |
| **Idempotency** | `x-idempotency-key` header | Min 10 chars, 1-hour retention. Use on every POST. |
| **Order details / L2-L3** | on intents/payments | Tax, tip, surcharge, freight, duty, line items (UPC, qty, unit cost) — interchange optimization on commercial cards. |

### 2.3 Terminals API (card-present)

Cloud-driven Fiserv/Clover terminals: connect/disconnect sessions (10-min validity), ping, activation codes, read/auth card (EMV/tap/swipe) or manual entry, tip prompts with presets, signature capture, receipt printing, display control, confirmations and formatted input prompts. Card-present auths execute against the same payment intents as online payments.

### 2.4 Webhooks

Endpoint + event-type subscription configured in account settings; signature verification over the raw body; exponential-backoff retries (immediate → 5s → 5m → 30m → 2h → 5h → 10h ×2), endpoint disabled after 5 days of failures; single-message replay and bulk recovery. Known events: `v2.account.created`, `v2.account.gateway_updated`, `v2.account.payouts_enabled`, application/payee status changes, plus payment-side events (full catalog: open question — get the list from our rep).

### 2.5 Supporting

- **Data migrations:** PGP-encrypted file handoff via account manager — imports vaulted cards from a previous provider as PMIs.
- **AVS/CVV code references, error handling, test cards** for sandbox work.
- **Two API keys:** public (JS SDK) + private (server, `x-api-key`), plus `x-account-id` to act on behalf of a specific merchant.

---

## 3. The build-out list — every system we can build on this

Ordered roughly by dependency, not priority. ★ = required for "orgs can take real payments."

### A. Platform / plumbing

1. **★ Provider adapter layer + Forward adapter** — a `PaymentProviderAdapter` interface in `public/v1/payments/` (create intent, charge, refund, void/capture, vault, surcharge, payouts, disputes) with a Forward implementation. Populates the existing inert `provider`/`processor` fields on `payment_intents`/`payment_transactions`. Keeps us provider-portable.
2. **★ Org merchant-account config** — per-org (and possibly per-branch) record: Forward business id, application id, account id, processing plan, enabled rails (card/ACH/wallets/terminals), boarding status, payout status. Lives beside the existing `payment_settings` branch module; gated by new capability keys (e.g. `money.merchant_processing`).
3. **★ Webhook infrastructure** — a `/v1/payments/webhooks/forward` receiver with signature verification, an idempotency/event store, per-org routing (via `external_account_id` / account id → org), and handlers that update boarding status, transaction status, settlement, payouts, and disputes. Completely separate from the existing Stripe-billing webhook path.
4. **Sandbox harness** — test-card driven E2E flows (auth, capture, decline categories, AVS/CVV variants) following the existing Playwright harness pattern.

### B. Onboarding & underwriting (Boarding API)

5. **★ Merchant onboarding wizard (our UI)** — in Company Settings → Payments: collect business, company, address, owners/signer, volumes, MCC, bank details; create/update the Forward application by API; submit. Prefill from org data we already hold.
6. **★ Underwriting status tracker** — application state machine surfaced in our UI, driven by webhooks + polling: `UNDER_REVIEW`, `NEED_INFORMATION` (show `documents_requested` and collect responses), `CONDITIONALLY_APPROVED`, `APPROVED`, `DECLINED`. On approval: store account id, watch for `payouts_enabled`, flip the org's processing capability on.
7. **★ Pricing-plan management (interchange-plus ⇄ flat-rate)** — internal admin: list Forward processing plans, assign per application, display the org's current plan, switch plans. This is exactly the "set them between interchange plus and flat rate" requirement.
8. **Internal boarding ops console** — FirstMate-admin view across all orgs: application pipeline, statuses, accounts, plans, payout enablement, MCCs. Our version of "full management suite for everything in their API."

### C. Taking money (Payments API + Elements)

9. **★ Real card intake** — swap the fake inputs inside `payment-intake.js` for Forward's Card/Payment Element iframe, keeping the existing modal shell and portal/Money/crew/doc-widget mount points (UI-preservation rule: same surfaces, new guts). Server: map our `payment_intents` → Forward payment intents → charge with the returned token → write the real `payment_transactions` row through the existing `createPayment` → allocation → ledger path.
10. **★ Refunds/voids that move money** — wire `refundPayment()` to Forward refunds (and void/capture for uncaptured auths) before writing the negative transaction record.
11. **ACH / bank payments** — Bank Element in the same intake modal; per-merchant enablement; pending→settled status handling and return/failure webhooks feeding obligation de-allocation.
12. **Saved payment methods (card/bank-on-file)** — replace `fakeSavedMethods()` with real PMIs: customer-portal "save my card," pick-a-saved-method at checkout, PATCH updates (expiry/billing), $0-auth validation.
13. **Scheduled/automatic payments** — Forward has no native subscriptions, but we already have the schedule/obligation/recognition engine: add an auto-charge runner that charges a stored method when an obligation comes due (with retry/dunning + receipt email). This turns payment schedules into actual autopay.
14. **Apple Pay / Google Pay** — wallet buttons on the customer portal checkout; per-domain association file hosting (relevant to the Web Builder's custom-domain sites too).
15. **Compliant surcharging / fee pass-through** — replace the hardcoded 3% document-engine fee with `POST /surcharge/calculate`; per-org toggle: absorb fees vs pass through; ACH discount stays as-is.
16. **Card-present / terminals for field crews** — Fiserv/Clover terminals driven from the crew app's existing field-payment flow: connect terminal, push amount from an obligation, tip + signature, receipt. Natural fit for the Work tab world.
17. **Pay-by-link** — we already generate portal payment links; ensure quick-invoice email/SMS deep-links straight into the real checkout. (Forward's hosted checkout-session send-by-SMS/email exists as a fallback but our portal replaces it.)

### D. Money out + visibility (the finance dashboard)

18. **★ Payouts & batches dashboard** — the centerpiece of "see everything":
    - money taken (captured payments, gross vs `merchant_amount` net)
    - current balance awaiting sweep (`GET /balances`)
    - batches headed to their bank (`GET /payouts` with settlement status)
    - expected arrival date per payout
    - drill-down: payout → transactions → original invoice/obligation/project
    Built into the existing Financials app; payout arrival auto-sets our `cleared_at` reconciliation flag (today a manual click).
19. **★ Fee reporting** — per-transaction fee capture from settlement data; monthly statement view: gross, fees, net, effective rate; interchange-plus vs flat-rate comparison view; surcharge collected. Feeds the stats warehouse for trend charts.
20. **Settlement reconciliation** — match Forward transactions/payouts to our `payment_transactions`; surface `unmatched_settlements` as an exceptions queue in the Financials reconcile view.
21. **Disputes/chargebacks center** — list + detail from `GET /disputes`, webhook-driven alerts, linkage back to project/invoice/customer, amount_disputed reflected on obligations. (Evidence submission per rep answer.)
22. **Platform revenue engine (our side)** — `payment_splits` on every intent to auto-collect FirstMate's per-transaction take at settlement, and/or adhoc `POST /fees` for monthly platform fees, chargeback-handling fees, etc. Internal residuals dashboard: our revenue per org.
23. **Adhoc merchant fees (org-facing)** — optional: let orgs pass late fees/service charges through the same mechanism where appropriate, or keep adhoc fees internal-only.

### E. Extended

24. **Payee splits for contractor payouts** — onboard crew/subs as Forward payees (hosted KYC link) and split payments to them at settlement — a real-money upgrade path for the existing contractor-disbursement records. (Phase later; overlaps payroll.)
25. **Card data migration** — if any org arrives with a vault at a previous processor: PGP file handoff → PMIs. Also `external_payments` for reporting continuity during a cutover window.
26. **Multi-location support** — Boarding locations mapped to branches if an org processes under multiple locations.
27. **L2/L3 data enrichment** — pass invoice line items/tax through order details to cut interchange on commercial cards (we have the line items already — nearly free win for interchange-plus orgs).

---

## 4. Integration plan for the existing payment system

### Phase 0 — Foundations (before/with sandbox access)
- Adapter interface + Forward adapter skeleton; env config for sandbox keys (public/private, `x-account-id` handling).
- Org merchant-config record + capability keys (`money.merchant_processing` etc., registered in `capability_defs.ts`).
- Webhook receiver + event store + signature verification.
- **Pre-existing gaps to fix while in there:**
  - `money.invoices` / `money.take_payment` are UI-gated only — add server-side enforcement in `payments/api.ts`.
  - Public document-payment path records no `payment_transactions` row (`documents/service.ts` `recordDocumentOutput`) — must create one before real money flows through it.
  - Remove hardcoded Stripe webhook-secret fallbacks in `platform/api.ts` (~line 9513) before touching that file for anything acquiring-related.

### Phase 1 — Onboarding & underwriting (build-outs 5-8)
Wizard, status tracking, plan assignment, admin console. Exit: a sandbox org goes application → approved → `payouts_enabled` entirely through our UI.

### Phase 2 — Real charging (build-outs 9-10, 17)
Elements into the intake modal; intents mapped; mock-deposit route retired (portal proposal deposits, Money app take-payment, doc-widget checkout, crew field payments all flow through the adapter); processor-backed refunds. Exit: sandbox card payment lands as a captured transaction, allocated to an obligation, visible on the ledger, receipt emailed.

### Phase 3 — Money visibility (build-outs 18-20)
Payouts/batches/balances dashboard, fee reporting, settlement auto-reconciliation. Exit: the org dashboard answers "what was taken, what's batched, when does it hit my bank, what did it cost."

### Phase 4 — Payment-method depth (build-outs 11-15)
ACH, vault/saved methods, autopay on schedules, wallets, compliant surcharge.

### Phase 5 — Operations & expansion (build-outs 16, 21-27)
Disputes center, terminals, platform revenue splits/fees, payee payouts, migration tooling, L2/L3.

### Entity mapping (ours ↔ Forward)

| FirstMate | Forward | Notes |
|---|---|---|
| Organization | Business (+ Application → Account) | `external_account_id` = our org id |
| Branch | Location (maybe) | only if processing differs per branch |
| `payment_intents` | Payment Intent | our record stores their id in existing `provider` slot |
| `payment_transactions` | Payment | statuses map to captured/failed/etc.; fee fields added |
| `refundPayment()` | Refund | processor call first, then our negative record |
| saved methods (fake) | Payment Method / PMI | vault |
| `cleared_at` manual flag | Payout settlement | auto-set on payout webhook |
| document 3% fee row | `/surcharge/calculate` | compliant + dynamic |
| contractor disbursements | Payees + splits | later phase |
| — (new) | Disputes, Balances, Fees, Unmatched settlements | new entities in our store |

---

## 5. Hosted/white-label surfaces — what we can and can't avoid

**Revised 2026-08-14 after rep confirmation (their rep's word overrides their docs).** Three surfaces we planned to avoid turned out to be mandatory on Forward's side; our wizard still owns data entry (it pre-fills their form) and webhooks close every loop.

| Surface | Avoidable? | Plan |
|---|---|---|
| Hosted merchant application (`/applications/{id}/link`) | **NO — mandatory** (rep-confirmed 2026-08-14) | API application fields only PRE-POPULATE the hosted form. Full underwriting submission (signatures included) requires the merchant to complete Forward's hosted application workflow; `PUT /applications/{id}/submit` is partner-capability-gated and not enabled for us. Our wizard collects everything, then hands off via the link (14-day expiry, regenerable, persisted on merchant config); `v2.application.submitted` closes the loop. |
| Card/bank entry | **Partially** | Must use their Elements iframe for PCI — but it embeds inside our modal and is styleable. Not a hosted page. |
| Hosted checkout sessions | **Yes** | Our portal checkout replaces it. |
| Forward merchant portal (users + magic login) | **Partially — required for bank changes + dispute responses** (rep-confirmed 2026-08-14) | Bank-account changes and dispute/evidence responses are PORTAL-ONLY on Forward's side. We deep-link via single-use magic-link SSO (`POST /users/{id}/login_url`) from our Payments pane ("Manage at Forward") and dispute rows ("Respond at Forward"); webhooks (`v2.bank_account.*`, `v2.dispute.*`) keep our read models current. Dashboards/read surfaces remain ours. |
| Payee KYC application link | **No** | Payee identity collection is their hosted flow — acceptable (it's their compliance surface, used rarely). |
| Underwriting document upload (`NEED_INFORMATION`) | **No — hosted application** (rep-confirmed) | Documents are uploaded on the hosted application form; our NEED_INFORMATION card records the org's response context and routes the CTA through the hosted link. |
| Apple Pay domain verification | n/a | Just hosting a file at `/.well-known/`. |

---

## 5a. Sandbox portal recon (2026-08-12)

Findings from the live partner portal (portal.sandbox.getfwd.com):

- **Partner account approved**: FirstMate, `part_3HpmN6yqGUD2C8GvrVx0XBiAXpz`, "Integration Completed / Application Approved", accounts allowed, payouts enabled, US + Canada, MCCs 1761 + 5039. Merchant Portal Domain `5249495063.partner.sandbox.getfwd.com`; Hosted Application Domain and Checkout Domain unset (fine — we're not using them). No merchant accounts boarded yet.
- **Processing plans**: `partppl_3HpoNDtV6PtzrHasDxATGCIww6m` "Standard Flat Rate Plan - US" and `partppl_3HpoagfDHkidHgm5jNA6Y0UhuAk` "Standard Flat Rate - CAN", both type Flat Rate. Full fee schedules are visible in the portal (cards 2 bps + $0.30 auth CP/CNP; Pay-by-Bank enabled, 25 bps capped $25, $1 linking, $15 reject/reversal; $3 platform fee, $15 chargeback/retrieval; PCI/cancellation/updater/network-token fees $0). **No interchange-plus plan exists yet — request one from the rep to support both pricing models.**
- **Webhook event catalog (v2)** — full list from the portal's Event Catalog:
  - `v2.account.` closed, created, gateway_updated, payouts_disabled, payouts_enabled, processing_disabled, processing_enabled, updated
  - `v2.application.` approved, cancelled, created, deleted, manually_approved, manually_declined, need_information, submitted, updated
  - `v2.bank_account.` created, risk_validation_requested, updated, validated
  - `v2.checkout_session.` completed, created, updated
  - `v2.contractor.` activated, approved, created, deactivated, deleted
  - `v2.dispute.` accepted, contested, created, pre_arbitration, updated
  - `v2.payee.` activated, created, deactivated, deleted; `v2.payee_application.` approved, cancelled, created, deleted, information_requested, rejected, submitted, updated
  - `v2.payment.` cancelled, captured, created, failed, refunded
  - `v2.payment_intent.` cancelled, captured, created, pended
  - `v2.payment_method.` automatically_updated, network_token_provisioned
  - `v2.payout.` cancelled, completed, created, failed, held, pended, retried, returned, updated
  - `v2.refund.created`, `v2.reversal.created`
  Notable: dispute lifecycle is event-driven (created/contested/accepted/pre_arbitration → contest flow likely exists); `payment_method.automatically_updated` + `network_token_provisioned` mean card-account-updater is push-based; payout lifecycle is rich enough to drive the batches dashboard entirely from webhooks. Endpoints tab supports add-endpoint + logs/activity (Svix-style UI).
- **API keys are NOT self-serve in the partner portal** (no developer/API-keys screen anywhere in Settings). The public/private key pair is delivered by the account manager / integration email.

## 5b. Live sandbox findings (2026-08-13, first day with keys)

- **API base confirmed**: `https://api.sandbox.getfwd.com`, `x-api-key` auth works. Lists use a `{data:[], meta:{page,size,total_count}}` envelope with `page`/`size` pagination.
- **Adapter corrected against live reality** (11 divergences; see git history of `providers/forward.ts`): `bus_`/`aapp_` id prefixes, `contact_email`/`contact_phone_number` on businesses, full application wire translation (address/owner/volume field renames, LLC ownership/title vocab, `partner_processing_plan_id` echo), submission is `PUT /applications/{id}/submit` **with the full body** + `terms_accepted:true`, `PUT /applications/{id}` is FULL-REPLACE (adapter now merges to preserve PATCH semantics), balances live at `/ledger/balances`, PMI uses `payment_method_types`+`payment_method_data`, payments-side reads require `x-account-id`, error shape `{type, code, message, argument_errors}`.
- **Live state**: business `bus_3HsMe26OmzoG4c9FgyWcYPfGdBb` "FM Sandbox Test Co"; applications `aapp_3HsMq6UulMP7aFjLGvVBR6GVv7t` + `aapp_3HsNsPWRlSnXwYBUTZPZiJq7msR` (the second created through OUR routes end-to-end) — both DRAFT.
- ~~**BLOCKER**: API submission returns *"You cannot submit applications via the API because this capability is not enabled for your integration"* → rep must enable it.~~ **RESOLVED-BY-DESIGN (2026-08-14)**: the rep confirmed API submission is not available to partners at all — the HOSTED application workflow is the intended path (our API fields pre-populate it; merchant completes signatures there). The wizard now ends in a hosted-link hand-off and `v2.application.submitted` closes the loop, so no enablement is needed. No accounts exist yet, so charge/test-card/payout/SDK testing is armed but waiting (`scripts/forward-sandbox-e2e.mjs` auto-runs the payments phase once `GET /accounts` shows a processing-enabled account).
- **Hosted-surface wire shapes (LIVE-VERIFIED 2026-08-14)**:
  - `POST /applications/{id}/link` (empty body) → `{ link_id: "aapplink_…", uri: "https://application.sandbox.getfwd.com/aapplink_…", expiration_date, expired }` — 14-day expiry, regenerable at will (each POST mints a fresh link). A `redirect_url` in the POST body is silently ignored; the documented `redirect_url` lives on the application's `partner_data` (PartnerDataDto on POST/PUT /applications). FirstMate now sets it to `/portal/payments-setup-complete.html` on its allowlisted public origin (or configured local `PUBLIC_BASE_URL`) on new drafts and updates existing drafts before link generation. The Forward-hosted completion redirect still needs a live sandbox confirmation.
  - Application GET now known to echo `application_link_id` / `application_link_uri`, plus `requires_bank_account_file_ids_on_submit`, `comments_from_underwriting`, `business_users_exist`.
  - `POST /users` accepts `{ first_name, last_name, email, business_id }` → bare `{ id: "user_…", type: "BUSINESS", …, status: "ACTIVE" }`. `GET /users` REQUIRES a `type` query param (400 without); `email`/`business_id` filters work, standard `{data, meta}` envelope.
  - `POST /users/{id}/login_url` (no body) → `{ id, login_url }` — single-use magic link on the partner merchant-portal domain (`5249495063.partner.sandbox.getfwd.com/auth/magic-link…`). A `redirect_url` body field is ignored.
- `company.description` is required at submit — wizard field added 2026-08-13.
- Sandbox test cards recorded in the harness (4242… approve; 4867094332104873 decline; 4112912498587255 NSF; 4208475663072763 AVS; per-brand equivalents).
- **Webhook registration checklist** (portal → Settings → Webhooks → Add Endpoint): URL `https://<public-host>/v1/payments/webhooks/forward`; subscribe `v2.application.*`, `v2.account.*`, `v2.payment.*`, `v2.payment_intent.*`, `v2.refund.created`, `v2.reversal.created`, `v2.payout.*`, `v2.dispute.*`, `v2.bank_account.*`; paste the endpoint's `whsec_…` into `FORWARD_WEBHOOK_SECRET`. Receiver 401s until the secret is set. No tunnel tool locally, so delivery testing awaits a public deployment.

## 6. Open questions for the Forward rep

1. ~~Full **webhook event catalog**~~ **Answered** — see §5a.
2. **Processing plan** configuration: request an **interchange-plus plan** (none exists yet); can a live merchant be moved between plans; is plan/fee detail exposed via `GET /processing_plans/{id}` for display in our UI (portal shows it, so likely yes)?
2b. **Sandbox API keys**: where are they issued? (Not self-serve in the portal — need them from the rep/welcome email.) Also confirm the sandbox API base URL.
3. **Per-transaction fee data**: are our costs (interchange, plan fees) exposed on transactions/payouts/settlement records so we can compute effective rates, or only on statements?
4. ~~**Underwriting documents**: API path for responding to `NEED_INFORMATION`, or hosted-form only?~~ **Answered (rep, 2026-08-14)** — hosted application form only; our NEED_INFORMATION CTA routes through the hosted link.
5. ~~**Bank account add/verify** for payouts: API or hosted-only?~~ **Answered (rep, 2026-08-14)** — portal-only: merchants change bank accounts inside Forward's merchant portal (we deep-link via magic-link SSO); `GET /bank_accounts` + `v2.bank_account.*` webhooks give us status.
6. ~~**Disputes**: read-only by API, or is there evidence submission? Webhooks for new disputes?~~ **Answered (rep, 2026-08-14)** — API is read-only; evidence/dispute responses happen in Forward's merchant portal (SSO deep-link from our dispute rows). Webhooks per §5a (`v2.dispute.*`).
7. **ACH details**: settlement timing, return handling/webhooks, verification method (instant vs microdeposits), limits.
8. Enablement needed on our account: **adhoc fees**, **bank payments**, **surcharging** (and state-compliance handling), **splits/payees**, **terminals**.
9. **Sandbox**: underwriting auto-approval in sandbox? Test payout/settlement simulation?
10. Rate limits, and whether `x-account-id` sub-scoping affects them.

---

## 6a. Pre-key build-out (no API keys required)

Strategy: a **mock Forward provider** implements the same adapter interfaces and synthesizes the same v2.* webhook events through the same dispatch path, so every surface below is fully drivable today. Swapping to the real provider = env keys + merchant config `provider: "forward"`; zero UI changes.

Build order:
1. **Foundation (backend)** — mock provider with simulated underwriting/charges/payouts/fees; complete webhook projection handlers (`v2.payment.*` → transaction fee fields, `v2.payout.*` → payout records + auto-clear, `v2.dispute.*` → dispute records); read-model endpoints (payouts list/detail, finance-summary, disputes) + PaymentsAPI client methods.
2. **Onboarding UI** — Company Settings → Payments: application wizard (prefilled), underwriting status tracker with need-info handling, plan display.
3. **Finance dashboard** — Financials app: money taken, balance awaiting sweep, batches → bank with expected arrival, fee statements/effective rate, payout → transaction → invoice drilldown.
4. **Intake modal upgrade** — tokenization shell (SDK loader/iframe mount/token callback; mock element behind flag), saved methods (PMI-backed), ACH/wallet selection, adapter-driven surcharge line.
5. **Autopay** — enroll stored method on payment schedules, charge-on-due runner status, retry/dunning display.
6. **Disputes center + reconciliation** — disputes list/detail, auto-cleared payments, unmatched-settlements queue.
7. **Internal boarding ops console** — cross-org application pipeline, plan assignment (interchange-plus ⇄ flat-rate switch), account/payout status.
8. **Gap fixes** — server-side `money.invoices`/`money.take_payment` enforcement; document-payment transaction row; Stripe webhook-secret fallback removal.

Remaining once keys arrive: 4 env vars, register webhook endpoint URL, flip an org's provider to "forward" (Staff Console → Boarding Ops), run sandbox test cards.

**Build status (2026-08-13): ALL EIGHT ITEMS DONE**, uncommitted, verified: `test:payments` 35/35, `test:capabilities` 11/11, `tsc --noEmit` clean, five Playwright harnesses green (`merchant-onboarding-e2e` 29/29, `finance-payouts-e2e` 32/32, `payment-intake-e2e` 23/23 ×5 consecutive, `autopay-e2e` 14/14, `boarding-admin-e2e` 22/22). Key artifacts: providers/{types,forward,mock}.ts, merchant_config.ts, webhooks_forward.ts, intake.ts, autopay.ts, payouts.ts, reconciliation.ts, admin_api.ts; UI in settings/company.js (wizard), financials/app.js (Payouts view), payment-intake.js (tokenization + saved methods + surcharge), money/project.js (autopay card), measure/internal boarding_ops.js (staff console). Two real pre-existing bugs found and fixed along the way: the intake modal read its form after replacing it (all submissions carried amount 0), and a lossy embedded-proposal save could strip the portal's public token so the portal demanded an already-paid deposit (server-side fallback + retry added; write-side fix tracked separately). Deferred: unmatched-settlements UI wiring (backend + client done), Forward `GET /unmatched_settlements` passthrough (needs keys), crew/doc-widget Elements mounts beyond the doc-output charge path.

## 7. Immediate next steps

1. Get sandbox API keys (public + private) and webhook signing secret.
2. Send the open-questions list to the rep.
3. Phase 0 build: adapter skeleton, merchant-config record, capability keys, webhook receiver.
4. First sandbox milestone: board a test merchant via API end-to-end, then charge a test card through the portal intake modal.
