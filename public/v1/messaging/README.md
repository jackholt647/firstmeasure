# Messaging and Communications API

The API is mounted at `/v1/messaging` and provides organization-scoped Telnyx SMS plus the shared communications message/conversation model.

## Production model

- FirstMate owns and pays the shared Telnyx account.
- Every customer organization receives a distinct Telnyx Messaging Profile. This is required because Telnyx STOP/START blocking is Messaging-Profile scoped.
- Every purchased E.164 number has one unique FirstMate organization ownership record.
- An organization cannot send live SMS until its brand is verified, campaign is `MNO_PROVISIONED`, number order is successful, number-to-campaign assignment is `ASSIGNED`, the exact campaign START/STOP/HELP responses have been read-back verified on its Messaging Profile, webhook signing is configured, and the recipient has active purpose-appropriate consent.
- Provider cost and segment events are stored independently from future subscription/markup pricing.

The canonical production webhook is:

```text
https://app.1m8.ai/v1/messaging/webhooks/telnyx
```

Telnyx webhooks are verified over the exact raw body using Ed25519, timestamp limited, durably deduplicated by provider event ID, and protected from out-of-order delivery regressions.
TCR and Telnyx campaign IDs are normalized into one ordering domain. Expiration, rejection, suspension, resubmission, review, approval, and unsuspension events all remove send readiness; only Telnyx's final `VERIFIED` event or an authoritative `MNO_PROVISIONED` status refresh can restore it.

## Required production configuration

See `../.env.example`. Live startup fails closed unless the API key, webhook public key, compliance-data encryption key, HTTPS webhook URL, strong session secret, explicit public URL, absolute persistent messaging storage path, and mandatory consent enforcement are configured. Before the worker starts, the service opens and migrates the SQLite database, commits a write probe, performs a WAL checkpoint, and logs the resolved database path.

`COMMUNICATIONS_DELIVERY_MODE` defaults to `capture`; it must explicitly be `live` in production.

SQLite is supported for the current single-host, multi-process deployment only. `MESSAGING_STORAGE_ROOT` must be durable local storage shared by every worker on that host and covered by tested backups. A multi-host deployment requires moving the messaging state to a shared transactional database before scaling out.

## 10DLC setup routes

- `GET /organizations/:orgId/sms/setup`
- `POST /organizations/:orgId/sms/compliance-profiles`
- `GET /organizations/:orgId/sms/compliance-profiles/:profileId`
- `PATCH /organizations/:orgId/sms/compliance-profiles/:profileId`
- `POST /organizations/:orgId/sms/compliance-profiles/:profileId/set-default`
- `GET /organizations/:orgId/sms/compliance-profiles/:profileId/available-numbers`
- `POST /organizations/:orgId/sms/compliance-profiles/:profileId/select-number`
- `POST /organizations/:orgId/sms/compliance-profiles/:profileId/submit-brand`
- `POST /organizations/:orgId/sms/compliance-profiles/:profileId/submit-campaign`
- `POST /organizations/:orgId/sms/compliance-profiles/:profileId/appeal-campaign`
- `POST /organizations/:orgId/sms/compliance-profiles/:profileId/refresh-status`
- `POST /organizations/:orgId/sms/compliance-profiles/:profileId/deactivate`

Sole proprietor profiles additionally use the `/sole-proprietor/otp/request`, `/otp/status`, and `/otp/verify` routes before campaign submission.

The provider/reseller setup UI registers `AGENTS_FRANCHISES` (or `SOLE_PROPRIETOR` when applicable), matching FirstMate's provider model. API-imported campaigns with a narrower Telnyx use case are enforced through an explicit purpose mapping; unknown and mismatched purposes fail closed. The submitted message flow and samples are organization-owned attestations; FirstMate does not manufacture opt-in claims.

Number selection is chargeable in live mode. It creates/reuses the organization Messaging Profile, records an idempotent provider operation, claims unique ownership, revalidates current provider inventory and price, creates the Telnyx number order with an organization customer reference, and records setup/monthly provider cost metadata. Brand and campaign submissions likewise record their non-recurring fees and campaign recurring commitment. These are provider-cost records, not customer invoices.

Provider acceptance, the current provider reference, the immutable accepted quote, audit event, and provider-cost entries commit atomically. A crash before that commit leaves the operation unresolved and read-reconciled; it never exposes a locally successful operation that could be mistaken for permission to create another chargeable resource. Correcting an existing rejected brand uses an idempotent `PUT`, not a second brand registration. A corrected replacement campaign uses a new reference generation, retains the old phone binding until the replacement is fully approved, then performs a verified detach/attach cutover and retires the prior campaign once.

Native campaigns in `TELNYX_FAILED` or `MNO_REJECTED` can use `appeal-campaign` with a detailed remediation reason. The appeal is rejected if locally registered campaign fields changed; the organization must then explicitly confirm a new paid replacement. Appeal POSTs are idempotent and remain send-disabled until a later final `VERIFIED` event. Appeal review cost is recorded from the actual `CAMPAIGN_RESUBMISSION` event rather than guessed at submission time. `TCR_FAILED` and expired campaigns follow the replacement path. Telnyx's current appeal and rejected-campaign guides conflict on some correction cases, so a controlled live pilot must verify the account's native-versus-partner campaign mode before broad release.

Immediately before a live campaign is submitted, FirstMate reconciles US `start`, `stop`, and Telnyx `info` (HELP) auto-response settings from the final campaign copy. It lists first, updates an existing setting by ID, creates only when absent, then requires an exact read-back. Ambiguous POST outcomes are persisted and never blindly repeated. Multiple settings for the same operation fail closed for operator reconciliation. Status refresh repairs legacy or drifted submitted profiles, while every send path remains disabled until the stored applied hash matches the current campaign response hash.

Privacy-policy and terms URLs are checked over HTTPS using a DNS-resolved public IP pinned into the TLS connection. Redirects, credentials, private/special-use addresses, mixed public/private DNS answers, certificate failures, and non-2xx responses fail closed; this prevents DNS rebinding from turning registration validation into an internal-network request.

The fee ledger separates the current standard-brand fee, sole-proprietor brand fee, initial prepaid three-month campaign subscription, and carrier review fee. Each actual `CAMPAIGN_RESUBMISSION` records another idempotent review fee. Telnyx's `CAMPAIGN_BILLED` event does not contain an amount, so it is stored as a zero-dollar, unpriced reconciliation notice rather than inventing a charge from an old rate. Customer billing must not treat those notices as priced usage until a Telnyx invoice reconciliation source is added.

Deactivation requires `confirm_irreversible: true`. Set `release_number: false` to retain the number and its voice route while disabling SMS. Set `release_number: true` only when releasing the number; release is blocked while FirstMate voice still uses it. Deactivation suspends unsent work, disables the Messaging Profile, removes the campaign-number assignment, deactivates the campaign, clears the default messaging profile, and ends messaging commitments. Provider operations are idempotent so a partially completed offboarding can be retried.

## Production onboarding and operator boundaries

The Telnyx account must be messaging-enabled and Level 2 verified, and Telnyx must confirm that the account may register native downstream-customer brands/campaigns for FirstMate's provider model. The API key alone is insufficient: copy the account Ed25519 public key from Mission Control into `TELNYX_WEBHOOK_PUBLIC_KEY`. Public-profit email verification and sole-proprietor mobile OTP require the customer to complete their interactive verification step.

TCR permits one brand per EIN. A customer already registered through another CSP needs a transfer/shared-partner workflow; do not retry brand POSTs. Until an import/share workflow is implemented, route those customers to operations and use a net-new EIN for the controlled pilot.

Carrier review is asynchronous. The current self-service UI requires the organization to return and click **Refresh Status** after approval; that action verifies current provider state, completes number assignment, and activates sending. Do not promise automatic activation until a background setup reconciler is deployed.

Operator handling is fail-closed:

- An ambiguous brand/campaign/number POST is reconciled by deterministic provider reads; never manually reset it and retry the POST without proving absence.
- Duplicate START/STOP/INFO configurations require removing the duplicate in Telnyx, then running status refresh for an exact read-back.
- A replacement assignment first verifies the old detach, then the exact new campaign binding. If either remains ambiguous, leave sending disabled and retry refresh after provider state converges.
- Brand re-vetting and optional external vetting are separate Telnyx workflows with eligibility/cadence and possible fees. They are not silently triggered by brand correction.
- Reconcile unpriced `CAMPAIGN_BILLED` notices and all fixed fee constants against the Telnyx invoice before using provider cost as a customer invoice.

## Consent and suppression

Record consent before sending:

```json
POST /organizations/:orgId/sms/consents
{
  "phone_number": "+12065550123",
  "status": "opted_in",
  "consent_id": "consent_123",
  "source": "web_form",
  "disclosure_version": "sms-consent-v1",
  "purposes": ["appointment", "project_update"],
  "evidence": { "form_url": "https://example.com/contact", "checkbox": true }
}
```

Marketing requires an explicit `marketing` purpose. Inbound STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT immediately suppress future sends and cancel unsent/scheduled work. START/UNSTOP restores customer-care consent only; marketing requires fresh marketing consent. HELP/INFO is logged without changing consent.

Marketing consent additionally requires a written-capable source plus an affirmative checkbox, signed-document ID, or durable consent-record URL. Evidence must retain the disclosure text, the time consent was obtained, and confirmation that consent was not a condition of purchase. `GET /organizations/:orgId/sms/consent-events` exposes the immutable audit trail.

## Sending

```json
POST /organizations/:orgId/messages
{
  "channel": "sms",
  "purpose": "appointment",
  "recipients": [{
    "address": "+12065550123",
    "contact_id": "contact_123",
    "consent_id": "consent_123"
  }],
  "content": { "text": "Your appointment is tomorrow at 10:00 AM. Reply STOP to opt out." },
  "idempotency_key": "appointment-reminder:event_123"
}
```

Messages, deliveries, initial events, and outbox state are created transactionally. The leased delivery worker submits outside the database transaction, honors provider rate limits/transient failures, does not blindly retry ambiguous POST timeouts, and reconciles nonterminal messages against Telnyx.

Scheduled timestamps must be RFC 3339 with an explicit timezone. Telnyx native scheduling is used inside its five-day window; longer FirstMate schedules remain durable until they enter that window.

## Usage

`GET /organizations/:orgId/sms/usage` returns exact decimal provider amounts, segments, direction/type metadata, per-currency totals, and active/ended recurring provider commitments. Duplicate finalized webhooks cannot duplicate a ledger entry. Telnyx-managed outbound responses that emit normal finalized events are attributed through the organization's owned number even though they have no FirstMate delivery row. Events marked `unpriced` or `reconciliation_required` are operational notices and must be excluded from customer invoices. Future subscription or piece-rate billing should calculate customer charges from the reconciled provider ledger without rewriting it.

## Developer capture mode

Capture mode remains available for local UI/automation tests. Developer simulation routes are unavailable in production or live mode. Telnyx configuration and health routes require authenticated company-management access and never expose credentials or profile details.
