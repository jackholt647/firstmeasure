# Forward dispute sandbox — September 26, 2026

## Current result

Created a fresh FirstMate development organization and submitted its Forward sandbox application through the hosted DEV shortcut. Merchant SSO works. Three Visa test payments are captured and visible in Forward. **No disputes have been created.** Neither the merchant dispute list nor the inspected payment detail offered a dispute-generation control. Forward's published testing guide does not document a dispute-trigger card or amount. The response/evidence form remains unverified until Forward supplies a supported simulation method or seeds cases.

No application code was changed or deployed. No production transactions were made. The samples were created directly in Forward, not through a FirstMate invoice, so this does not validate FirstMate invoice allocation, payment linkage, webhook delivery, or dispute notifications.

## Reopen the test organization

1. Open [development signup sandbox](https://dev.1m8.ai/portal/signup-sandbox/).
2. Select **Test orgs** and find **Lantern Heron Test Co 8f2a7e**. Click **Open app**.
3. Open **Settings → Money → Payments → Manage at Forward**. This mints the merchant login; no Forward password is needed. In the current UI this is Money, rather than the separate platform Billing tab.
4. Choose **Payments** to see the samples, or **Disputes** to inspect the dispute queue.

The merchant portal is [FirstMate's Forward sandbox](https://5249495063.partner.sandbox.getfwd.com/disputes). If its session expires, repeat step 3 rather than signing in at the partner admin portal.

| Record | ID |
| --- | --- |
| FirstMate organization | `org_a859434bdbf69f3f` |
| Forward business | `bus_3JslYThWTjmS6g0ZG2jkqnwgdVJ` |
| Forward application | `aapp_3JslYQ49NrOa37L74xtK5JAnXfP` |
| Forward merchant account | `acct_3JslaZIVeUpC2yb0yktlIWOeEjS` |

Forward DEV generated the legal business name **Cedar Grove Services** and fictional signatory **Haiyan Petrova**. The merchant account retains the FirstMate test organization name. Processing and payouts report enabled; no bank is linked, and the portal still labels the account Boarding. A captured sandbox payment is verified; payout readiness is not.

## Sample payments

| Amount | Payment ID | Intent ID | Result |
| --- | --- | --- | --- |
| USD 11.00 | `pmt_3JsmBBRvxaV7aCtOnmXW9xQhqR9` | `pi_3JsmB5rRddH65eLLzpyQyd7yWnC` | Captured |
| USD 22.00 | `pmt_3JsmHSLbzqXGJZMEhs1Uaqplgnn` | `pi_3JsmHSwGMiGZN2b8RdWh9WYSrno` | Captured |
| USD 33.00 | `pmt_3JsmHZPiGJPAAKfMTGMV4Q6XPTb` | `pi_3JsmHVKfHkMFywuvpL1FsoUpXlg` | Captured |

The first used Forward hosted checkout and its secure card inputs. The other two used the resulting sandbox payment-method token. All used the documented Visa success card ending 4242. The API returned zero disputes after capture. Do not assume a successful card or a decline automatically creates a chargeback.

## Fields and workflow still to verify

Observed portal list columns: Account Name, Status, Reason, Dispute Date, Respond By, Disputed Amount, Currency, Source. It offers filtering, sorting, date selection, and CSV export.

The [current API reference](https://docs.getfwd.com/docs/payments-api) exposes read-only dispute list/detail endpoints. Its dispute data includes reason text/code, response and original deadlines, payment/intent references, response text, notes, attachment references, lifecycle dates and transaction metadata. These describe returned data, not a verified list of required response inputs.

Our adapter and webhook projection currently normalize `reason` and `respond_by`/`evidence_due_by`; the reference instead shows `reason_disputed`, `reason_disputed_code`, and `response_due_date`. Both paths need review against a real sandbox event before relying on displayed reasons or deadlines. Raw payload retention exists, but does not repair missing normalized fields.

For each seeded reason, record: required text fields and choices; conditional questions; document types/count/size limits; draft/save behavior; final submission confirmation; accept versus contest behavior; response deadlines; subsequent status changes and webhook payloads. None of those evidence-form constraints has yet been observed.

The intended operator flow is: receive dispute → associate payment/project → collect evidence in FirstMate → authorized employee opens merchant SSO → enters/uploads the response in Forward → records submission confirmation → reconciles resulting status. This is a proposed operational flow, not an end-to-end tested implementation.

## Draft request for the Forward implementation contact — not sent

Please enable repeatable sandbox dispute testing for FirstMate merchant account `acct_3JslaZIVeUpC2yb0yktlIWOeEjS` (Lantern Heron Test Co 8f2a7e). We have three captured payments listed above. Can you provide the supported test card/amount, simulator, or seed disputes against those payments? We want to exercise accepting a dispute and contesting with evidence, including fraud, services not received, and duplicate-processing examples if supported. Please also explain how to reset/create additional cases, simulate won/lost/pre-arbitration outcomes, and receive the corresponding `v2.dispute.*` events. We need the actual merchant response forms and upload constraints to prepare evidence in our own UI for authorized staff submission.

## Local evidence

Screenshots and resumable sample-payment state are under `output/forward-dispute-lab-20260926/` (ignored local output). `seed-payments.cjs` resumes only the three listed samples, pins the sandbox host and account, and uses stable idempotency keys. It is not a dispute generator. Credentials are loaded from the existing local development configuration and are not copied into the evidence. The legacy raw-card PMI harness was rejected by the current API; hosted checkout was used successfully instead.

Reference: [Forward test cards](https://docs.getfwd.com/docs/articles/test-card-numbers).
