# V1 Email API

The Email API is mounted at `/v1/email`. It is separate from `/v1/platform` because it will eventually handle outbound email, provider routing, and inbound automation. Platform-owned records created by email still live in the Platform org storage buckets.

Current inbound lead flow:

- Authenticated Platform UI calls `GET /v1/email/organizations/:orgId/branch/:branchId/lead-import`.
- That route creates or returns a branch `lead_import` module with a unique address like `leads-default-xxxxxxxx-yyyyyy@1m8.ai`.
- Postmark should deliver unmatched `@1m8.ai` inbound mail to `POST /v1/email/inbound/postmark`.
- The webhook checks recipients against branch lead-import addresses.
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

- Reusable transactional delivery lives in `email/outbound.ts`.
- Authenticated admins may call `POST /v1/email/outbound/transactional`.
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
LOCAL_EMAIL_WEBHOOK_URL=http://127.0.0.1:3111/v1/email/inbound/postmark
EMAIL_INBOUND_WEBHOOK_TOKEN=optional-local-token
```

This test helper downloads queued public Postmark payloads, posts them into the local Email API, and only then acks the public spool records.
