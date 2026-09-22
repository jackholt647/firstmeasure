# V1 Email API

The Email API is mounted at `/v1/email`. It is separate from `/v1/platform` because it handles outbound email, provider routing, and inbound automation. Platform-owned records created by email still live in the Platform org storage buckets.

## FirstMate Mail engine (customer email)

The engine behind the project Comms tab (`docs/comms-spec.md`):

- `engine.ts` — provisions each org's inbox (`<orgslug>@firstmatemail.com`, env `FIRSTMATE_MAIL_DOMAIN`) as the default email sender identity in the communications DB, and sends conversational customer email through `sendCommunication` with RFC 2822 threading metadata (`metadata.email.message_id` / `in_reply_to` / `references`).
- `providers.ts` — `EmailProvider` adapter with capture, safe-test, and live modes. Test/live delivery uses Cloudflare Email Service; test mode rewrites recipient domains to `EMAIL_TEST_RECIPIENT_DOMAIN`.
- `EMAIL_DELIVERY_MODE=test` is the preferred backend-only development safety
  gate. Every outbound Cloudflare recipient keeps its local part but has its domain
  rewritten to `EMAIL_TEST_RECIPIENT_DOMAIN`
  (`1m8.ai` by default). `EMAIL_TEST_RECIPIENT_REWRITE=true` remains a legacy
  force-rewrite override. Frontends must not duplicate either rule.
- `inbound.ts` — `POST /v1/email/inbound/events` accepts a NORMALIZED inbound payload (token-guarded like the Postmark webhook). Routing: org by recipient inbox address → thread by References/In-Reply-To → open conversation with the sender → new conversation, with project/contact matching via `comms/matching.ts`. Fires `communication.received` and the comms notification/auto-response hook. Unroutable mail returns 202 so providers do not retry.
- `cloudflare-email-worker/` — receives Email Routing events, stores raw MIME in private R2, and enqueues an object key. Its Queue consumer parses MIME and posts normalized input to the V1 host; repeated failures land in a DLQ.
- `tenants.ts` — enforces organization isolation and pause state locally without provider-specific tenant resources.
- `GET /v1/email/organizations/:orgId/inbox` — provisions/returns the org inbox.
- Organization-to-customer transactional sending (`organization_outbound.ts`) uses the same tenant-aware Cloudflare path. Feedback requests, instant estimates, documents, invoices, and proposals use this lane, including PDF attachments where applicable.
- Platform-to-account transactional sending (`outbound.ts`) remains on Postmark and is restricted to senders on `PLATFORM_MAIL_DOMAIN` (`1m8.ai` by default). User invitations, password resets, signup verification, internal support mail, and FirstMeasure stay on this platform lane until separately migrated.

Development does not need real customer companies. Capture mode, synthetic organizations, MIME fixtures, recipient safety rewriting, and rate limits are deterministic test paths. A live canary is still required before production to prove public MX/DKIM, Email Worker routing, queue retries, and deliverability.

Current inbound lead flow:

- Authenticated Platform UI calls `GET /v1/email/organizations/:orgId/branch/:branchId/lead-import`.
- That route creates or returns a branch `lead_import` module with a unique address like `leads-default-xxxxxxxx-yyyyyy@1m8.ai`.
- New branch lead-import addresses are separate `leads-...@firstmatemail.com` inboxes. Cloudflare stores raw mail in R2 and the shared Queue consumer checks lead routing before normal conversational inbox routing.
- The Postmark webhook remains only for legacy `@1m8.ai` lead inbox aliases while lead providers are moved to the new address.
- Run `npm run email:migrate-lead-inboxes` once during deployment to replace stored legacy addresses and retain them as compatibility aliases.
- Matching mail is parsed into a lead extraction object.
- The API creates:
  - a `projects` document with `stage` and `stage_id` set to `new_lead`, and contacts stored on `project.data.contacts`,
  - a passive `notifications` document targeted to branch notification roles.

- Embeddable website forms have moved to `/v1/lead-intake`.
- Legacy `/v1/email/public/forms/*` routes delegate to Lead Intake for compatibility only.
- Do not add new form modes, form settings, or website form storage under this Email API.
- Public customer websites should load `public/libraries/lead-embed/firstmate-lead-embed.js`; Platform admin UI should manage forms through `public/libraries/lead-intake-api/lead-intake-api.js`.
- Appointment/call submissions may add a requested event to the new Platform project. The event stores one `start_at` and one `duration_minutes`, with plural role/user arrays.
- Branch sales appointment hours live in `branch_data/{branchId}/scheduling.json` under `data.availability.sales_appointment_start_time` and `data.availability.sales_appointment_end_time`. The Platform settings UI edits these as Scheduling Settings, and both project scheduling and website forms should use them.

App flags:

- Email inbox import requires `platform.lead_import` and `email.inbound_lead_import`.
- Website embeds require `platform.website_embed_import` and are served by the Lead Intake API.
- These flags live in Platform org `global.json` under `data.app_flags` and are read through `public/v1/platform/app_flags.ts`.
- Do not expose disabled lead import features in customer settings; the API also rejects direct calls when a flag is off.

OpenAI extraction:

- Default model: `gpt-5-nano`, chosen as the fast, low-cost GPT-5 family model for structured extraction.
- Configure with `OPENAI_API_KEY`.
- Override with `OPENAI_LEAD_MODEL`.
- Set `EMAIL_LEAD_AI_DISABLED=1` to force deterministic regex fallback for tests/local debugging.

Webhook security:

- If `EMAIL_INBOUND_WEBHOOK_TOKEN` is set, the webhook requires `X-Email-Webhook-Token`, `X-Postmark-Token`, or `?token=...`.
- Do not expose this token or the OpenAI key to browser libraries.

Outbound email:

- Customer-facing delivery must use `sendOrganizationTransactionalEmail` from `email/organization_outbound.ts`; it selects the organization's custom identity or FirstMate Mail fallback and sends through Cloudflare Email Service.
- FirstMate account/system delivery from `1m8.ai` uses `sendPlatformTransactionalEmail` from `email/outbound.ts` and remains backed by Postmark.
- Authenticated admins may call `POST /v1/email/outbound/platform-transactional`. `POST /v1/email/outbound/transactional` remains as a compatibility alias and has the same platform/Postmark semantics; it must not be used for customer-facing messages.
- Public form submissions should not call that route directly from the browser. Lead Intake triggers controlled customer emails server-side after it creates/handles the form submission.
- Configure Postmark with `POSTMARK_SERVER_TOKEN`, `POSTMARK_API_TOKEN`, `FIRSTMEASURE_POSTMARK_TOKEN`, or `storage/secrets/pm_server_token.txt`.
- Set `EMAIL_OUTBOUND_DISABLED=1` in tests/local probes that should never send real email.

Postmark endpoint:

```text
POST /v1/email/inbound/postmark
```

Local examples usually need a tunnel because Postmark cannot call `127.0.0.1`.

## Test-Only Public Inbox

For local testing without ngrok, use `postmark-forwarder.index.php` as a tiny public inbox at:

```text
https://app.1m8.ai/v1/email/inbound/postmark/index.php
```

This PHP file is not the production email integration. Later, Postmark should call the real deployed V1 Email API directly. This hosted PHP endpoint is only a temporary capture box for real provider email payloads.

Behavior:

- Every normal Postmark POST is stored in `.postmark_spool`.
- Download and ack require `FIRSTMATE_POSTMARK_SPOOL_KEY`.
- The inbox does not forward anything by itself.
- Local testing decides when to pull messages and whether to ack them after replay.

Public server env:

```text
FIRSTMATE_POSTMARK_SPOOL_KEY=make-a-long-random-secret
```

Local replay command from `public/v1`:

```powershell
$env:POSTMARK_SPOOL_KEY="make-a-long-random-secret"
node email/testing/pull-postmark-spool.mjs
```

Optional local env:

```text
POSTMARK_SPOOL_URL=https://app.1m8.ai/v1/email/inbound/postmark/index.php
LOCAL_EMAIL_WEBHOOK_URL=http://127.0.0.1:3101/v1/email/inbound/postmark
EMAIL_INBOUND_WEBHOOK_TOKEN=optional-local-token
```

This test helper downloads queued public Postmark payloads, posts them into the local Email API, and only then acks the public spool records.
