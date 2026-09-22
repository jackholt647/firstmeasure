# Communications API Browser Client

`CommunicationsAPI` is the organization-scoped browser client for customer SMS and email. It is mounted over `/v1/messaging`; the transport provider and capture/live routing remain server concerns.

## Sending

```js
await CommunicationsAPI.messages.send(orgId, {
  channel: 'sms',
  purpose: 'appointment',
  recipients: [{ address: '+12065550123', contact_id: 'contact_123', consent_id: 'consent_123' }],
  content: { text: 'Your appointment is tomorrow at 10:00 AM.' },
  context: { project_id: 'project_123', work_node_id: 'node_123' },
  source: { type: 'automation', automation_id: 'appointment-reminder' },
  idempotency_key: 'appointment-reminder:event_123'
});
```

Record auditable, purpose-specific consent before the first live SMS:

```js
await CommunicationsAPI.sms.consents.record(orgId, {
  phone_number: '+12065550123',
  status: 'opted_in',
  consent_id: 'consent_123',
  source: 'web_form',
  disclosure_version: 'sms-consent-v1',
  purposes: ['appointment', 'project_update'],
  evidence: { form_url: 'https://example.com/contact', checkbox: true }
});
```

Consent is exact-purpose: `customer_care` or `transactional` consent does not silently authorize `appointment`, `billing`, marketing, or specialized registered use cases. Specialized campaign purposes include `account_notification`, `delivery_notification`, `fraud_alert`, `higher_education`, `polling_voting`, `public_service_announcement`, `security_alert`, and `two_factor_auth`.

Email uses the same request shape with `channel: 'email'` and `content.subject`; `content.html` is optional. `sendSms` and `sendEmail` are convenience wrappers.

## Conversations

- `conversations.create(orgId, definition)` creates an SMS, email, or omnichannel thread.
- `conversations.list(orgId, filters)` lists organization threads.
- `conversations.get(orgId, conversationId)` returns the thread and message history.
- `conversations.send(orgId, conversationId, message)` sends through that thread.

## Delivery Contract

Normal responses expose message and per-recipient delivery statuses without provider internals. Capture and live Telnyx delivery use the same frontend methods and response shape. Live SMS fails closed when provisioning or consent is incomplete.

`CommunicationsAPI.sms.usage(orgId, filters)` returns organization-attributed Telnyx segments, priced provider costs, recurring commitments, and explicit unpriced reconciliation notices. Events marked `unpriced` or `reconciliation_required` must not be included in customer billing until matched to a Telnyx invoice.

The temporary authenticated log viewer is available from `CommunicationsAPI.developer.testLogUrl()` for development verification only.
