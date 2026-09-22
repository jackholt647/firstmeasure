# Project Comms Tab — Architecture Spec

Centralized per-project communications: email, SMS, and customer-portal live chat in one
project tab, with cross-channel search, an AI comms agent, notification routing, and a
provider-agnostic email engine that runs fully in capture (test) mode until FirstMate Mail
(SES + firstmatemail.com) goes live.

## Principles

- **One message store.** Everything rides `communications.sqlite` (`communication_messages`
  / `communication_conversations` / `communication_deliveries`). Email, SMS, and webchat are
  `channel` values, not separate systems. New channels (e.g. `recording`) are additive.
- **Capture mode is a feature.** `transport_mode: "capture"` deliveries are how automated
  messages are tested pre-launch. The comms feed surfaces this as `test_mode: true` and the
  UI shows a TEST badge. Nothing else behaves differently.
- **Adapters, not rewrites.** The email engine talks to an `EmailProvider` interface. The
  `mock` provider captures; the `ses` provider is a stub wired for Amazon SES v2 +
  tenant management, activated by env config when the AWS account clears.
- **Apps publish agent instructions.** Modules register natural-language usage guidance in
  `platform/agent_instructions.ts`; agents assemble context from whatever is enabled for the
  org instead of hardcoding knowledge about each app.

## Backend modules

### `email/` additions (the FirstMate Mail engine)
- `engine.ts` — org inbox provisioning (`ensureOrgEmailInbox`): allocates
  `<slug>@firstmatemail.com` (env `FIRSTMATE_MAIL_DOMAIN`) as a `communication_sender_identities`
  row (`id: firstmate_mail`, provider `firstmate_mail`, default email sender). Slug derived
  from org name, globally unique (numeric suffix on collision).
- `providers.ts` — `EmailProvider` interface + `mock` (capture) + `ses` stub
  (env: `EMAIL_DELIVERY_MODE=capture|live`, `AWS_SES_*`). Outbound email today is always
  capture inside `sendCommunication`; going live means implementing `ses.send()` and adding
  an email branch to the delivery worker.
- `inbound.ts` — `processInboundEmail(normalizedPayload)`: org lookup by recipient address,
  thread resolution (References/In-Reply-To → `metadata.email.message_id`, else open email
  conversation with the remote address, else new conversation), project/contact matching,
  inbound message record, `communication.received` work event, comms notification hook.
  Routes: `POST /v1/email/inbound/events` (token-guarded, normalized JSON; the SES/SNS
  adapter will convert into this same shape later).

### `comms/` (new module, mounted at `/v1/comms`)
- `capabilities.ts` — `apps.comms` (Communications category, default on, runtime_app_id
  `project.comms`), features `comms.email`, `comms.sms`, `comms.portal_chat` (requires
  `apps.live_chat`), `comms.search`, `comms.agent`, `comms.auto_response` (default off),
  permissions `view_comms` / `send_comms`.
- `storage.ts` — sidecar tables in the communications DB: FTS5 index
  (`comms_message_fts`, trigger-maintained over `communication_messages`), agent threads
  (`comms_agent_threads` / `comms_agent_messages`), auto-reply log (`comms_auto_replies`).
- `matching.ts` — `matchProjectContact(orgId, {email?|phone?})`: scans project contacts to
  attach inbound messages/conversations to a project.
- `settings.ts` — branch module `comms_settings` (notification targets, agent config,
  auto-response policy) + per-project overrides in `project.data.comms`
  (notification overrides, `agent_instructions`, auto-response override).
- `notifications.ts` — `onInboundCommunication(orgId, messageId)`: resolves targets
  (project override → branch settings → default `office` role), creates a platform
  notification (`kind: comms_message`, `frontend_action: open_project_comms`), and triggers
  auto-response when enabled. Called from Telnyx inbound, email inbound, and simulation.
  Scope sets can ALSO bind on the `communication.received` work event with
  `notification.create.v1` (+ conditions) for stage-parameterized routing — e.g. notify
  operations once the project is in production.
- `service.ts` — overview/feed/threads assembly (`test_mode` derived from
  `transport_mode=capture`), FTS search, send wrappers (email adds RFC Message-ID threading
  metadata; SMS reuses conversation per remote number), webchat conversation listing for a
  project, simulate-inbound helper.
- `agent.ts` — comms agent (OpenAI Responses loop mirroring `assistant/agent/service.ts`).
  System prompt = global `comms_settings.agent` + per-project `agent_instructions` +
  `buildAgentInstructions()` registry output. Tools: search/read comms, project context,
  send email/SMS (send gated), scheduling read + schedule/reschedule (gated), report_result.
  Auto-response: `draft` mode logs a suggested reply (surfaced in UI + notification),
  `send` mode sends it.
- `api.ts` — project-scoped REST (overview, feed, email threads/send, sms/send, chat
  conversations/reply, search, settings, agent threads, simulate-inbound).

### `platform/agent_instructions.ts` (new)
`registerAgentInstructions({id, title, capability?, instructions})` where `instructions`
may be a `(ctx) => string|Promise<string>` deriving data-driven guidance (e.g. scheduling
publishes sales-appointment hours from the branch scheduling module).
`buildAgentInstructions(orgId, branchId)` filters by enabled capabilities and joins
sections. Consumed by the comms agent and appended to the global assistant manifest.
Initial publishers: scheduling (work), communications (messaging), live chat, comms.

### Touched existing files
- `messaging/telnyx_webhooks.ts` — inbound SMS: project/contact matching + comms
  notification hook (dynamic import, mirrors the work-engine import pattern).
- `messaging/communications_service.ts` — simulate-inbound routes through the same hook;
  feed exposes capture state to comms service (internal read, not public API change).
- `assistant/agent/manifest.ts` — append instruction-registry output.
- `work/events.ts` — register `communication.auto_replied`.
- `src/app.ts` — mount `/v1/comms`.

## Frontend

- `libraries/comms-api/comms-api.js` — `window.CommsAPI` (assistant-api idiom).
- `libraries/apps/comms/project.js` — embeddable app `project.comms`
  (`kind: project_modal_app`, `regions: ['main','left']`, tab id `comms`, route param
  `commsView`: `overview|email|sms|chat`). Sub-tab registry is a data array so future
  channels (recordings) are one entry + one renderer. Left column (desktop) = comms
  controls: notification targets, agent settings/per-project instructions, channel status
  chips. TEST badges on captured messages (FontAwesome flask). Search bar + "Ask AI"
  panel (per-project agent threads). 3s active-tab polling like the chat inbox.
- `libraries/apps/firstmate-apps-manifest.js` — app entry, `appCapabilities`
  (`project.comms` → `apps.comms`), `nestedRouteParams.comms`.
- `portal/index.php` — script tags for comms-api + comms app.
- `portal/scripts/topbar.js` — route `open_project_comms` notifications into the project
  modal comms tab.
- `libraries/apps/settings/comms.js` + `company.js` sub-tab — global comms settings
  (notification defaults, agent global prompt, auto-response policy).

## Test-mode + go-live path

Today (`COMMUNICATIONS_DELIVERY_MODE=capture`, `EMAIL_DELIVERY_MODE=capture`): every
outbound email/SMS is recorded as sent with `transport_mode=capture`; automated messages
from scope automations land in the same feed with TEST badges; inbound is exercised via
simulate-inbound (dev UI + API) and the spool replay tooling.

Go-live: SES provider implements send (per-tenant `tenant` on every call), inbound SNS→
`/v1/email/inbound/events` adapter, `EMAIL_DELIVERY_MODE=live`. Telnyx already has its live
worker. No schema, API, or UI changes.
