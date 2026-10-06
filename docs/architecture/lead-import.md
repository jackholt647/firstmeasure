# Lead import

Implemented October 6, 2026. Email inboxes, Connections webhooks, synchronized
API resources and the published `leads.import` action share the canonical
`leads/intake.ts` service. Website forms continue to use their forms domain writer.

## Intake and recovery

Each delivery has an organization, source and stable external identity. A durable
claim precedes project creation; PostgreSQL advisory locking serializes competing
hosts. Retries retain the original project identity and do not repeat contact,
workflow or notification creation. Different connections have distinct source
namespaces. Contact-only leads are valid; provider fields and connector version
are retained as provenance.

An interrupted dispatch becomes uncertain. It is never automatically replayed.
An authorized project manager reviews the retained project and workflow, then
records an imported or dismissed outcome and a note. Mapping failures occur
before dispatch and may be corrected and redelivered. Delivery history excludes
raw messages and credentials. Reading history does not mutate receipts.

The ledger is an additive `lead-intake` SqlStore. Rollback preserves it: deleting
receipts or enabling older code that bypasses intake would remove retry protection.

## Unique email inbox

The Cloudflare delivery Bearer token is accepted alongside existing webhook token
headers. Hosted requests fail closed without configuration. A provider message ID
is preferred; a stable sender/subject/body hash is the fallback. Extraction supports
general service inquiries, rather than requiring roofing keywords. Non-lead mail
is recorded as rejected. Inbox regeneration revokes previous aliases; the provider
must be updated to use the new address. Inbox provisioning and settings writes
serialize per branch. Existing FirstMate Mail routing remains the delivery channel.

## Connections

`definition.leadImport` configures webhook or resource mode, branch, external ID
path, provider, notification roles and bounded evaluate-only mapping code. Code
receives `inputs.record` and returns `outputs.lead`, or `outputs.skip` and a reason.
It has no data/action bindings. `connections_lead_preview` validates a sample
without writing leads. Intake checks the current owner's membership, Connections
access, project management permission and lead-import capability. Pausing stops
new intake. Polling consumes complete snapshots in a separate worker lane with a
durable cursor; import latency does not block event automation or synchronization.

Webhooks support HMAC-SHA256, a header token or a JSON body token, with credentials
stored through Connections' private encrypted credential flow. Generic event
allowlists, credential redaction and event deduplication remain in place.
Webhook-only connectors may have no outbound operations.

Google Ads delivery is supported through body-token verification at `google_key`,
`lead_id` identity, a default `lead.received` event and `is_test` suppression.
Map `user_column_data` by `column_id`, preserving useful campaign fields. See
[the official protocol](https://developers.google.com/google-ads/webhook/docs/implementation).
Its guidance entry is not an already connected account. Other providers require
their verified protocol and mapping; unsupported signature or subscription
verification protocols need a host adapter. Provider-side subscription setup must
be performed through an authorized declared operation or completed by the user.

## UI and assistant

Company settings exposes the unique inbox, other lead sources and paginated
delivery history. Connect a lead source opens the shared Connections assistant.
Connection detail displays its webhook URL, lead configuration and outcomes.
The shared assistant can provision the inbox, inspect deliveries, preview mappings,
author Connections drafts and record an explicit delivery review. Activation is
separate from draft creation. Secrets are entered only in the private credential
widget.

The typed `leads.import` action requires project management, lead-import capability
and an action idempotency key. `lead-import.deliveries` publishes authorized branch
history through the existing catalog. No raw collections or credentials are exposed.

## Verification

`npm run check`, `npm run test:publication`, isolated email and Connections suites
with SQLite and embedded PostgreSQL, and Connections/lead-history browser tests.
Coverage includes token failures, retry races, source/tenant isolation, optional
address, provenance, test webhook suppression, mapping preview without effects,
polling snapshot replay, revoked access, action receipts, pagination, mobile layout
and explicit recovery review.
