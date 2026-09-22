# FirstMate Live Chat Suite — Specification

Status: **draft for review** (2026-07-23)
Scope: embeddable website chat widget, customer-portal chat, backend chat service, portal "Chat" inbox app, AI chat agent + suggested responses, team presence/claiming, settings, notifications, and full work-event integration.

---

## 1. Purpose

One live-chat system with three faces:

- **Visitor widget** — a self-contained script any org can drop on their website (and that we mount inside the customer portal), fully parameterized: colors, copy, position, behavior all server-driven from org settings.
- **Team inbox** — a new global portal app ("Chat", left column) built like a desktop messaging client: always-visible conversation list with unread/age/ownership state, multi-conversation, multi-user, deep-linkable.
- **AI agent** — an optional package that can front the chat entirely, hand off to humans, or sit behind humans generating suggested responses. Context access, tone, and instructions are all org-configurable.

Everything rides existing platform machinery: the messaging conversation/message layer, the capability registry for gating, `requirePlatformAuth` permissions, branch modules for settings, platform notifications for alerting, and work events for logging/automations. No parallel systems.

---

## 2. Grounding: what exists today (and what we reuse)

Findings from the current codebase that shape this design:

**Reused directly:**
- **Messaging conversation/message layer** (`public/v1/messaging/communications_storage.ts`) — channel-agnostic `communication_conversations` / `communication_messages` tables in `communications.sqlite` (WAL, leased workers, idempotency keys, org-hash-namespaced ids). Live chat becomes a new channel `webchat` in `communicationChannelSchema`; chat messages are communication messages. Conversations already link `project_id`, `contact_id`, `participants_json`, and messages additionally link `proposal_id`, `work_plan_id`, `work_node_id` — chat inherits all entity linking for free.
- **Work-event bus** (`public/v1/work/engine.ts` `emitWorkEvent`, catalog in `work/events.ts`) — the platform's event log AND automation trigger substrate. Messaging already publishes `communication.*` events via `publishWorkCommunicationEvent`; chat registers `chat.*` events the same way. Org automation rules, scope bindings, and `registerWorkAutomation` handlers subscribe with zero new plumbing.
- **Capability registry** (`platform/capabilities.ts`, `capability_defs.ts`) — new `apps.live_chat` app node with child feature nodes (`live_chat.ai_agent`, `live_chat.suggested_responses`) and permission nodes. `runtime_app_id` gates the portal app; `requirePlatformAuth({capability})` gates the backend (note: existing agent APIs only gate the UI — chat gates both).
- **Auth guard** (`platform/auth.ts` `requirePlatformAuth`) — cookie session + `X-Platform-CSRF`, pipe-OR permission strings, `capability:` option.
- **Branch modules** (`platform/storage.ts` `readBranchModule`/`saveBranchModule`) — all chat settings live in a new `live_chat` branch module, managed from a new Settings tab (same pattern as `document_settings`, SMS settings, `automation_rules`).
- **Lead-embed widget pattern** (`public/libraries/lead-embed/firstmate-lead-embed.js` + `lead-intake/api.ts` public routes) — the proven third-party embed recipe: `<script data-*>` auto-init, opaque key as the capability token, `credentials:'omit'` fetches, server-driven whitelisted `style`/`copy`, scoped CSS variables under a random instance id, per-endpoint capability checks even without auth.
- **Platform notifications** (`platform/api.ts` `createPlatformNotification`, frontend `platform-notifications.js` + `topbar.js`) — targeting model (broadcast / `target_user_ids` / `target_role_ids`), 10s poll + chime, `frontend_action` deep links (the mention-event pattern). Chat alerts are notifications with `frontend_action: open_chat_conversation`.
- **AI agent loop** (`scopes/agent/service.ts` `runScopeAgentTurn`, mirrored by stats agent) — OpenAI Responses API via `requestOpenAIResponse` (`src/openai/responses.ts`), function tools, bounded tool rounds, full per-tool trace persisted with the message. The chat agent is a third consumer of this pattern (and the forcing function to extract a shared loop helper).
- **Lead creation** (`createPlatformLead`, lead-intake `availability` endpoints) — offline chat capture and AI booking tools reuse these.
- **Calls app UI patterns** (`apps/calls/app.js`) — per-item draft persistence (`state.drafts` Map), navigation handler registration for deep-linkable modal state, flag-driven register/unregister lifecycle.

**Gaps this spec must close (found in recon):**
1. **No realtime transport exists anywhere** — the portal is 100% polling (10s notifications, 60s data). Chat needs faster; §7 specs adaptive polling for v1 with contracts designed so SSE can be added without breaking changes.
2. **CORS allowlist rejects arbitrary customer origins** (`src/app.ts` allowlist from `env.corsOrigins`). Public chat routes need a permissive CORS branch (lead-embed only works today because `credentials:'omit'` requests from simple GET/POSTs slip through browsers inconsistently — chat must fix this properly for `/public/*`).
3. **No rate limiting on public routes** — lead-intake public endpoints have none. A public message-send endpoint absolutely needs it (§16).
4. **Lead-intake's O(n) org scan to resolve a public form id** (`findEmbeddableFormAssignment`) — chat adds an indexed key table instead (§4.6).
5. **No per-call AI metering** — scope/stats agents are unmetered. Chat AI adds a usage-event table mirroring `communication_usage_events` (§12.6).
6. **Notification `push` is logged-only** — no real push transport. In-app chime + fast poll is the v1 alerting reality; real push is out of scope here.

---

## 3. Mental model

```
Visitor (website / customer portal)
   │  firstmate-chat-embed.js  (widget key, visitor token, credentials:'omit')
   ▼
/v1/chat/public/*  ── public endpoints: config, session, start, send, poll, typing
   │
   ▼
communications.sqlite
   communication_conversations (channel_strategy: webchat)  ◄─── entity links: contact, project
   communication_messages      (channel: webchat)
   chat_* sidecar tables       (visitors, widget keys, presence, claims, read state, AI usage)
   │
   ├── emitWorkEvent ─── chat.conversation.started / chat.message.received / …
   │                     → org automation rules, scope bindings, activity feeds
   ├── createPlatformNotification ── targeted per settings → bell + chime + deep link
   └── AI dispatcher ── mode says AI handles? → runChatAgentTurn → reply or handoff
   ▲
   │
/v1/chat/organizations/:orgId/*  ── authenticated team endpoints (inbox, send, claim,
   │                                presence, suggest, settings)
   ▼
Portal "Chat" app (portal.chat, left column, global)
```

One conversation, two participant classes: the **visitor** (anonymous-by-default, token-identified, maybe later linked to a contact) and **org-side senders** (users or the AI agent). Every org-side message records who sent it.

---

## 4. Data model

Chat extends the **messaging module** (`public/v1/messaging/`). Messages and conversations use the existing tables; chat-specific state lives in sidecar tables in the same `communications.sqlite` so everything is transactional together.

### 4.1 Channel extension

- `communicationChannelSchema` gains `"webchat"` (`messaging/schemas.ts`).
- `providerForChannel("webchat")` → `"firstmate"` (internal — no external provider, no delivery worker; a webchat message is "delivered" when written; the visitor's widget picks it up on poll).
- `communicationCapabilities()` advertises the channel: `{ channel: "webchat", supports: ["outbound", "inbound", "typing", "presence"] }`.
- Conversations use `channel_strategy: "webchat"`. `conversationDetail`, `listConversations`, `sendCommunication` work unchanged; `sendCommunication` gets a `webchat` branch that skips sender-identity/compliance/delivery-queue logic.

### 4.2 `chat_widget_keys` — public key → org resolution (fixes recon gap #4)

```sql
CREATE TABLE chat_widget_keys (
  widget_key      TEXT PRIMARY KEY,          -- "cw_" + 24 random url-safe chars
  organization_id TEXT NOT NULL,
  branch_id       TEXT NOT NULL DEFAULT 'default',
  status          TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  created_at      TEXT NOT NULL,
  revoked_at      TEXT
);
CREATE INDEX idx_chat_widget_keys_org ON chat_widget_keys(organization_id, branch_id);
```

Generated when the org enables live chat in settings; rotatable (old key → `revoked`, widget snippet shows the new one). O(1) public lookup, unlike lead-intake's org scan.

### 4.3 `chat_visitors` — visitor identity across sessions

```sql
CREATE TABLE chat_visitors (
  id               TEXT PRIMARY KEY,          -- "cv_" + scopedCallerId
  organization_id  TEXT NOT NULL,
  branch_id        TEXT NOT NULL DEFAULT 'default',
  token_hash       TEXT NOT NULL,             -- sha256 of the bearer visitor token
  contact_id       TEXT,                      -- linked when identified
  display_name     TEXT,                      -- from pre-chat form / AI capture
  email            TEXT,
  phone            TEXT,
  ip_hash          TEXT,                      -- sha256(ip + org salt) — matching, not storage of raw IP
  last_ip_hash     TEXT,
  user_agent       TEXT,
  page_url         TEXT,                      -- last seen page
  portal_customer_id TEXT,                    -- set when widget runs inside customer portal
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  metadata_json    TEXT
);
CREATE UNIQUE INDEX idx_chat_visitors_token ON chat_visitors(organization_id, token_hash);
CREATE INDEX idx_chat_visitors_ip ON chat_visitors(organization_id, ip_hash, last_seen_at);
CREATE INDEX idx_chat_visitors_contact ON chat_visitors(organization_id, contact_id);
```

Identity layers, weakest → strongest:
1. **Visitor token** (localStorage) — durable per browser. This is what powers "the widget remembers previous conversations."
2. **IP hash** — agent-side hinting only ("likely the same visitor as conversation X from Tuesday"). Never merges identities automatically; surfaces as a suggestion chip in the inbox.
3. **Contact link** — set when the visitor gives an email/phone that matches a contact, when the AI/agent explicitly links one, or automatically when embedded in the **customer portal** (portal session → known customer → `contact_id` + `portal_customer_id` set at session creation; strongest identity, no guessing).

### 4.4 `chat_conversation_state` — chat-specific conversation sidecar

One row per webchat conversation; keyed to `communication_conversations.id`.

```sql
CREATE TABLE chat_conversation_state (
  conversation_id   TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL,
  branch_id         TEXT NOT NULL DEFAULT 'default',
  visitor_id        TEXT NOT NULL,             -- FK chat_visitors
  widget_key        TEXT NOT NULL,
  origin_url        TEXT,                      -- page the chat started on
  handling_mode     TEXT NOT NULL,             -- 'ai' | 'human' | 'offline_capture'
  ai_status         TEXT,                      -- null | 'active' | 'handed_off' | 'disabled'
  claimed_by_user_id TEXT,                     -- hard claim owner (null = unclaimed)
  claimed_at        TEXT,
  claim_expires_at  TEXT,                      -- idle-release deadline, refreshed on activity
  visitor_last_seen_at TEXT,                   -- widget heartbeat → "visitor still on page"
  visitor_typing_until TEXT,
  agent_typing_user_id TEXT,
  agent_typing_until TEXT,
  first_response_due_at TEXT,                  -- drives "unanswered for 2m" escalation
  closed_at         TEXT,
  closed_by         TEXT,                      -- user id | 'visitor' | 'ai' | 'system'
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_chat_state_org_open ON chat_conversation_state(organization_id, closed_at, updated_at DESC);
CREATE INDEX idx_chat_state_visitor ON chat_conversation_state(organization_id, visitor_id, created_at DESC);
```

### 4.5 `chat_agent_presence` + `chat_read_state` — team coordination

```sql
CREATE TABLE chat_agent_presence (
  organization_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  conversation_id TEXT,             -- null row = "user is in the Chat app" (global availability)
  last_seen_at    TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id, conversation_id)
);

CREATE TABLE chat_read_state (
  organization_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  last_read_message_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id, conversation_id)
);
```

- Presence rows are heartbeat-refreshed (15s) while a user has the Chat app open (global row) or a conversation open (per-conversation row). A row older than 45s is stale — presence is *derived*, never explicitly cleared, so crashed tabs and closed laptops self-heal. "Is anyone online?" = live hours check AND (if `require_agent_presence` setting) any fresh global presence row.
- Unread for the inbox = conversation `last_message_at` (inbound only) newer than the viewer's `chat_read_state`. Per-user, like notification read state — but stored here (SQLite) because it's queried on every inbox poll.

### 4.6 `chat_ai_usage_events` — AI metering (fixes recon gap #5)

Mirrors `communication_usage_events`:

```sql
CREATE TABLE chat_ai_usage_events (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  conversation_id TEXT,
  kind            TEXT NOT NULL,     -- 'agent_turn' | 'suggestion' | 'polish'
  model           TEXT NOT NULL,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  tool_rounds     INTEGER,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_chat_ai_usage_org ON chat_ai_usage_events(organization_id, created_at);
```

Written on every AI call. Enables future billing/limits (`env.chatAiOrganizationDailyLimit` guard, same shape as SMS daily limits) without schema change.

### 4.7 Message conventions

- Visitor message: `direction: "inbound"`, `sender_json: { kind: "visitor", visitor_id, display_name }`.
- Team message: `direction: "outbound"`, `sender_json: { kind: "user", user_id, name }` — this is how "Bill sent this" renders.
- AI message: `direction: "outbound"`, `sender_json: { kind: "ai_agent" }`, `metadata_json.ai: { model, trace_ref, suggested: false }`.
- System/internal notes (visible to team only, not the visitor): `purpose: "internal_note"` — filtered out of the public poll feed.
- All sends carry `idempotency_key` (widget generates a UUID per send; retries are safe).

---

## 5. Backend service — `/v1/chat`

New module `public/v1/chat/` (`api.ts`, `service.ts`, `storage.ts`, `agent/`, `schemas.ts`, `capabilities.ts`), registered in `src/app.ts`: `void app.register(registerChatApi, { prefix: "/v1/chat" });`. Storage functions live in `chat/storage.ts` but open the same messaging DB (export the handle from `communications_storage.ts`).

### 5.1 Public endpoints (widget-facing, no session auth)

All under `/v1/chat/public/`, authenticated by `widget_key` + (after session creation) a **visitor bearer token** in the `Authorization` header. `credentials: 'omit'`. Every handler checks: key active → `isCapabilityEnabled(orgId, "apps.live_chat")` → settings `enabled` → rate limits.

| Endpoint | Purpose |
|---|---|
| `GET  /public/widgets/:widgetKey` | Whitelisted config: style, copy, position, online status (`online \| offline \| ai`), pre-chat field requirements, whether history is visible. Never internal data. |
| `POST /public/widgets/:widgetKey/sessions` | Create-or-resume visitor. Body: optional existing visitor token, `page_url`, optional portal customer session proof (§8). Returns `{ visitor_token, visitor_id, conversations?: [...] }` (past conversations only if `visitor_history.visible_to_visitor`). |
| `POST /public/widgets/:widgetKey/conversations` | Start a conversation (+ optional pre-chat fields + first message). Returns conversation id + initial feed. |
| `POST /public/widgets/:widgetKey/conversations/:id/messages` | Visitor sends a message. Idempotency-Key honored. |
| `GET  /public/widgets/:widgetKey/conversations/:id/feed?after=<cursor>` | Poll: new messages (visitor-visible only), typing state, agent display info ("Bill joined"), conversation status. Cursor = last event id. Doubles as the visitor heartbeat (`visitor_last_seen_at`). |
| `POST /public/widgets/:widgetKey/conversations/:id/typing` | Visitor typing signal (sets `visitor_typing_until = now + 5s`; throttled client-side to 1/3s). |
| `POST /public/widgets/:widgetKey/conversations/:id/close` | Visitor ends the chat. |

Agent identity exposure to visitors is settings-controlled: first name + org name by default, configurable to a generic team name.

### 5.2 Authenticated endpoints (team-facing)

All guarded `requirePlatformAuth(request, { orgId, capability: "apps.live_chat", permission, csrf (mutations) })`. Permissions per §14.

| Endpoint | Permission | Purpose |
|---|---|---|
| `GET  /organizations/:orgId/chat/inbox` | `view_live_chat` | Inbox snapshot: open + recently-closed conversations with last message preview, unread-for-me, visitor summary, presence (who's viewing), claim state, waiting-since. One call, poll-friendly (§7). |
| `GET  /organizations/:orgId/chat/conversations/:id` | `view_live_chat` | Full thread (reuses `conversationDetail`) + chat state + visitor profile + prior conversations for this visitor (+ IP-hash "possibly same visitor" hints). |
| `POST /organizations/:orgId/chat/conversations/:id/messages` | `send_live_chat` | Send as the current user. Blocked with `409 claim_held` if hard-claimed by someone else (unless takeover allowed). |
| `POST /organizations/:orgId/chat/conversations/:id/claim` / `/release` | `send_live_chat` | Claim / manual release. Release also happens on idle expiry and (if configured) session end. |
| `POST /organizations/:orgId/chat/conversations/:id/read` | `view_live_chat` | Upsert `chat_read_state`. |
| `POST /organizations/:orgId/chat/conversations/:id/typing` | `send_live_chat` | Agent typing indicator. |
| `POST /organizations/:orgId/chat/conversations/:id/close` | `send_live_chat` | Close (visitor sees "chat ended" + optional transcript offer). |
| `POST /organizations/:orgId/chat/conversations/:id/link` | `send_live_chat` | Link visitor → contact and/or conversation → project (writes through to `communication_conversations.contact_id/project_id`). |
| `POST /organizations/:orgId/chat/conversations/:id/ai/handoff` | `send_live_chat` | Take over from AI (`ai_status: handed_off`) / hand back to AI. |
| `POST /organizations/:orgId/chat/conversations/:id/suggest` | `send_live_chat` + capability `live_chat.suggested_responses` | Generate a suggested reply draft (§12.5). |
| `POST /organizations/:orgId/chat/compose/polish` | `send_live_chat` + capability `live_chat.suggested_responses` | Clean up the agent's drafted text (grammar/tone), returns revised text (§12.5). |
| `POST /organizations/:orgId/chat/presence` | `view_live_chat` | Heartbeat: `{ conversation_id? }` — upserts global and per-conversation presence. |
| `GET/PUT /organizations/:orgId/branch/:branchId/chat/settings` | `manage_company_settings` | Read/write the `live_chat` branch module (validated through `chatSettingsSchema`). PUT regenerates/rotates widget key on request. |

### 5.3 Inbound message flow (the core sequence)

On visitor message (`POST .../messages`):

1. Insert message via `sendCommunication` webchat branch (transactional with events).
2. `emitWorkEvent("chat.message.received", …)`.
3. Update `first_response_due_at` if no org-side response yet.
4. **Dispatch decision** (from settings `mode` + live status):
   - AI handles (`ai` mode, or `ai_when_offline` and offline) → enqueue an AI turn (§12.3).
   - Humans handle and org is **online** → notification routing (§11) unless someone is already actively viewing (fresh per-conversation presence) — presence suppresses redundant notifications.
   - Humans handle and org is **offline** → conversation `handling_mode: offline_capture`; widget shows the configured offline message and prompts for email; captured info → `createPlatformLead` + `chat.offline.message` event.

---

## 6. Embeddable widget — `public/libraries/chat-embed/firstmate-chat-embed.js`

Mirrors `firstmate-lead-embed.js` exactly in packaging, then diverges in UI (floating launcher instead of inline form).

```html
<script src="https://app.1m8.ai/libraries/chat-embed/firstmate-chat-embed.js"
        data-widget-key="cw_example" async></script>
```

- **Auto-init** from `document.currentScript` (`data-widget-key`, `data-base-url`, `data-auto`, `data-position`). Programmatic API: `FirstMateChatEmbed.init({ widgetKey, baseUrl, ... })`, `.open()`, `.close()`, `.identify({ name, email })` (for host pages that know the user).
- **Rendering:** floating launcher bubble (configurable corner) → chat panel. All styles scoped under a random `#fmce_<id>` instance root with CSS variables (`--fmce-primary`, `--fmce-bg`, …) fed from server config — zero leakage into the host page, matching lead-embed's technique. Mobile: full-height sheet.
- **Config-driven** (from `GET /public/widgets/:key`): colors, font (same 7-font whitelist), launcher icon/label, greeting, pre-chat fields (none / name / name+email / name+email+phone, each optional-or-required), online/offline copy, AI disclosure line, "powered by FirstMate" toggle.
- **State:** `localStorage["fmchat:<widgetKey>"] = { visitor_token, open_conversation_id }`. If storage is unavailable (Safari ITP, blocked cookies/storage), the widget degrades gracefully: chat works for the page session in memory; history continuity is lost — exactly the "not the end of the world" case. Server-side history for the org is unaffected either way.
- **Networking:** `fetch` with `credentials:'omit'`, visitor token as `Authorization: Bearer`. Poll cadence: 2.5s while panel open, 15s while closed with an active conversation, stopped otherwise; resets to fast on visibility/focus. Sends are optimistic with an idempotency UUID and retry.
- **History:** if settings allow, the panel shows "Previous conversations" from the session response; visitor can reopen/read them. If settings disallow, the token still resumes the *current* open conversation after a reload but past threads are hidden.
- **Typing/presence:** shows "…" when `agent_typing`, shows agent first name on join; emits its own typing signal throttled.

---

## 7. Realtime transport (v1: adaptive polling; upgrade path: SSE)

The platform has no push transport (recon gap #1). v1 ships on polling, tuned per surface:

| Surface | Cadence |
|---|---|
| Widget, panel open | 2.5s feed poll (doubles as visitor heartbeat) |
| Widget, panel closed, active conversation | 15s |
| Portal Chat app, foreground | 3s inbox poll; open conversation rides the same response (inbox payload includes the active thread's new messages when `?active=<id>` is passed) |
| Portal Chat app, background tab | 15s (via `document.visibilitychange`) |
| Rest of portal (Chat app not open) | nothing extra — the existing 10s notification poll carries "new chat" alerts |

Contract rule that makes SSE a drop-in later: **every poll endpoint is a cursor feed** (`?after=<event-cursor>` returning ordered events). An SSE endpoint (`GET .../feed/stream`) can later emit the identical event objects; clients keep the poll as fallback. No schema change, no client rewrite. SSE is explicitly **phase 3** — single-host SQLite architecture supports it, but it's the platform's first push transport and shouldn't gate chat shipping.

Latency expectation to state honestly in review: visitor→agent worst case ≈ inbox poll (3s) when the app is open, ≈ notification poll (10s) + chime when it isn't. Acceptable for v1; SSE tightens it later.

---

## 8. Customer portal integration

The same widget mounts inside `public/customer_portal/` — with identity upgraded:

- The portal shell initializes the embed programmatically with a **portal session proof**: the portal backend mints a short-lived signed token (`chat_portal_grant`) identifying `{ organization_id, customer_id, contact_id }`; the widget passes it in `POST /sessions`. The chat service verifies and sets `chat_visitors.contact_id` + `portal_customer_id` — conversations from the portal arrive pre-linked to the real customer and their projects.
- Settings toggle: `portal.enabled` (show chat in customer portal), independent of `website.enabled`.
- History visibility in the portal defaults to visible (the customer is authenticated — there's no privacy ambiguity), still overridable.

---

## 9. Portal inbox app — `portal.chat`

New global left-column app. Registration follows the calls-app lifecycle exactly:

- **Manifest entry** (`firstmate-apps-manifest.js`): `{ id: 'portal.chat', package: 'chat', kind: 'portal_tab', surfaces: ['portal_tab'], portalTabId: 'chat', title: 'Chat', terminologyKey: 'chat', icon: 'fa-comments', order: 54, access: { applicationsAny: ['management'], permissionsAny: ['view_live_chat'] } }`, plus `appCapabilities['portal.chat'] = 'apps.live_chat'`.
- **Bundle** `public/libraries/apps/chat/app.js` calls `Portal.apps.registerPortalApp({...})` when the flag is on, unregisters when off (calls `app.js:260` pattern).
- **Deep links:** registers a navigation handler (`registerHandler('chat', …)`) with route params `{ tab: 'chat', chatConversation }` so notifications and activity items can open a specific thread.

### 9.1 Layout — desktop-messenger two-pane (the Google Voice model)

```
┌────────────┬──────────────────────────────┬─────────────┐
│ Conversa-  │  Thread                      │ Context     │
│ tion list  │  (messages, sender names,    │ (visitor,   │
│ (always    │   AI/human badges, composer) │  contact,   │
│  visible)  │                              │  history)   │
└────────────┴──────────────────────────────┴─────────────┘
```

**Conversation list** (persistent, never hidden by an open thread):
- Sort: unanswered-longest-first among unread, then by recency. Each row: visitor name (or "Website visitor"), last message preview, **waiting-time badge** ("2m" in amber, escalating red past a settings threshold), unread dot, and the **coordination tag**.
- Coordination tags (from presence + claims): `Unclaimed · unread` / `Bill is viewing` / `Claimed by Bill` / `AI handling` / `You` — the at-a-glance "who's got this" the team coordinates around.
- Filters: Open / Mine / Unclaimed / AI / Closed.
- Sidebar badge: total unread count on the left-column "Chat" entry (rendered via the tab registry badge, updated by the inbox poll while the app is open and by the notification payload while it isn't).

**Thread pane:**
- Messages with sender attribution: visitor left, org-side right with sender chip ("Bill", "AI Agent" with distinct styling). Internal notes rendered inline with a visually distinct "team only" treatment.
- **Composer:** textarea with native `spellcheck` (the baseline "basic autocorrect"), Enter-to-send, per-conversation draft persistence (calls-app `state.drafts` pattern), typing-signal emission, and — when the AI package is on — the suggestion strip (§12.5).
- Claim controls per settings mode (§10): claim/release button, or automatic soft-presence. If hard-claimed by someone else: composer disabled with "Claimed by Bill" and (if `allow_takeover`) a "Take over" action.
- AI handoff bar when `ai_status: active`: "AI is handling this conversation — [Take over]".

**Context pane:** visitor profile (name/email/phone as known), page they're on, linked contact/project with link/unlink actions, **previous conversations** by this visitor token, and "possibly the same visitor" IP-hint suggestions (explicit confirm to merge — never automatic).

### 9.2 In-app alerting

While the Chat app is open, new-message awareness comes from the inbox poll: row highlight, unread dot, optional chime (reuses `playNotificationIndicator`), title-bar count (`(2) Chat — FirstMate`). Cross-app (user elsewhere in the portal), the platform notification (§11) provides bell + chime + deep link.

---

## 10. Presence, claiming, multi-user coordination

Two coordination modes, org-selectable (settings `claiming.mode`):

**`presence` (soft, default):** No ownership. Tags show who's viewing (fresh per-conversation presence rows). Anyone can reply anytime. First reply implicitly makes you "the human on it" for routing purposes (subsequent notifications for that conversation target you first), but nothing is locked.

**`claim` (hard):** A conversation is claimed explicitly (button) or implicitly on first reply (`claiming.auto_claim_on_reply`). While claimed:
- Others see `Claimed by Bill`; their composer is disabled unless `claiming.allow_takeover: true` (takeover releases the prior claim and emits `chat.conversation.claim_taken`).
- The owner can always release manually.
- **Idle release:** `claim_expires_at = last owner activity (message sent, presence heartbeat on the conversation) + claiming.idle_release_minutes`. A sweep on inbox reads releases expired claims (no cron needed — lazily enforced, like lease expiry in the delivery worker).
- **Logout/disappear release:** if `claiming.release_on_disconnect: true`, a claim whose owner has no fresh *global* presence for `2 × heartbeat` is released. Covers logout, closed laptop, crashed browser — because presence is heartbeat-derived, "logged out" and "vanished" are the same observable and heal identically.

All claim transitions emit work events and are visible in the thread as system notes ("Bill claimed this conversation").

---

## 11. Notifications & routing

### 11.1 Live status

`chatLiveStatus(orgId, branchId)` returns `online | offline`:
- **Live hours** from settings: per-weekday windows + org timezone (+ optional holiday overrides list). Outside hours → offline.
- If `presence.require_agent_presence: true`: also require ≥1 fresh global presence row (someone actually has the Chat app open). This is the "is somebody actually on?" mode.
- Manual override: `presence.force_status: online | offline | auto` (a "we're slammed, go dark" switch in the app header, `manage_live_chat_settings` or any `send_live_chat` user per settings).

The widget shows the corresponding state (greeting vs offline message) and the config endpoint returns it so the widget renders correctly pre-conversation.

### 11.2 Alert flow

On a conversation needing human attention (new conversation while online in human mode; AI handoff; new message on an unclaimed/un-viewed conversation):

1. `createPlatformNotification(orgId, { kind: "chat_message", title: "New website chat", body: "<visitor> — «first line…»", push: true, target_user_ids | target_role_ids per settings, frontend_action: { type: "open_chat_conversation", conversation_id } })`.
2. Targeting from settings `notifications.route`: `all` (broadcast — omit targets), `roles: [...]` (`target_role_ids`), `users: [...]` (`target_user_ids`). A second-tier `notifications.escalate_after_seconds` re-notifies (broader target) if `first_response_due_at` passes with no org-side message — implemented as a work-engine automation on `chat.message.received` with a scheduled follow-up check, not a new scheduler.
3. **Debounce:** per conversation, at most one notification per `notifications.debounce_seconds` (default 120) unless the prior one was completed/dismissed. Presence suppression: skip if someone with a fresh per-conversation presence row is already viewing it.
4. `topbar.js` needs one addition: a `frontend_action` handler for `open_chat_conversation` → navigate to the chat tab + conversation route (mention-event pattern).

Notification click-through marks the notification completed and opens the thread.

---

## 12. AI agent & suggested responses

### 12.1 Gating

- Capability `live_chat.ai_agent` (feature, parent `apps.live_chat`, default **off**) — "part of the AI agent package": bundle it into whichever preset/package sells AI (alongside `platform.proposal_agent` etc.). Org toggle in settings; if the capability is off org-wide, the settings section, the AI mode options, the suggestion strip, and the backend endpoints are all disabled (backend enforced via `requirePlatformAuth({ capability: "live_chat.ai_agent" })` on suggest/polish, and the dispatcher checks `isCapabilityEnabled` before any AI turn).
- Capability `live_chat.suggested_responses` (feature, parent `live_chat.ai_agent`, default on-when-parent-on) — lets orgs keep AI-front-of-house off but suggestions on, or vice versa.

### 12.2 Modes (settings `mode`)

| Mode | Behavior |
|---|---|
| `human` | Humans only. AI never replies (suggestions still available if enabled). |
| `ai` | AI fronts every conversation; hands off on request/trigger. |
| `ai_when_offline` | Humans during live status online; AI takes over when offline. |
| `ai_first_then_human` | AI opens (greeting, triage, capture), auto-hands-off once a human claims or when triage completes. |

### 12.3 The chat agent turn — `chat/agent/service.ts`

Third consumer of the scope/stats agent pattern; this build **extracts the shared loop** (`src/openai/agent_loop.ts`: conversation array management, tool round cap, trace capture, retryable-status handling) rather than copying it a third time.

- Trigger: inbound visitor message on a conversation whose dispatch decision is AI. Turns are serialized per conversation (a simple per-conversation lease in `chat_conversation_state`, same BEGIN IMMEDIATE pattern as `claimNextEvent`) — one AI turn at a time, new visitor messages during a turn get folded into the next turn.
- Model: `env.openaiChatAgentModel` (default `gpt-5.6-sol`), effort medium, timeout 60s, `MAX_TOOL_ROUNDS = 6` (conversational turns are cheap; 16 is for batch agents).
- **System prompt assembly** from settings `ai` block: base guardrails (ours, fixed) + org `tone` (preset: friendly / professional / concise, or freeform) + org `instructions` (freeform prompt text) + org `knowledge` (freeform business info: services, service area, pricing posture, FAQs) + live context (business hours, online status, page the visitor is on, visitor's known identity).
- **Fixed guardrails (non-configurable):** never invent prices/commitments beyond provided knowledge; never reveal internal/other-customer data; disclose being an AI when asked (and per `ai.disclose` setting, proactively in the greeting); hand off rather than argue; treat the visitor as **unverified** — identity-sensitive tools stay locked regardless of settings until verified (portal-embedded chats count as verified).
- Every turn writes the full tool trace to the message's `metadata_json.ai.trace` (scope-agent convention) and a `chat_ai_usage_events` row.

### 12.4 Tools (each behind a settings toggle in `ai.tools`, several also capability-dependent)

| Tool | Default | Notes |
|---|---|---|
| `send_reply` | always | The terminal tool — the reply text. (Analogue of `report_result`.) |
| `request_handoff` | always | Flags for human attention → notification flow (§11), tells the visitor. Auto-invoked on failure/uncertainty. |
| `capture_contact` | on | Name/email/phone → visitor record; `create_lead` behavior per `ai.tools.create_lead` (reuses `createPlatformLead`, source `live_chat`). |
| `get_business_info` | on | Reads the settings `knowledge` block + org profile (hours, address, service area). |
| `get_availability` | off | Lead-intake scheduling availability (requires `lead_forms.appointment_form` capability). |
| `book_appointment` | off | Creates the appointment/lead like an embeddable-form submission. |
| `lookup_customer` | off | Look up contact/project status **only for verified visitors** (portal grant or agent-linked contact). Hard-locked otherwise; the settings UI says so. |
| `get_pricing_guidance` | off | Pricebook-derived ballparks, clearly framed as estimates (requires pricebook capability). |

This is the "what the AI has access to in the context" surface the user asked for — org-visible, toggle-per-tool, with the dangerous ones (customer data) additionally gated by verification, not just settings.

### 12.5 Suggested responses & composer polish (human-facing AI)

- **Suggestion strip:** in the composer, on demand (button / hotkey) or auto (`ai.suggestions.auto: true` generates when an unanswered visitor message is >N seconds old). `POST .../suggest` runs a single-shot completion (thread context + same knowledge/tone prompt, read-only tools only) → 1 draft (fast) shown above the composer with **Insert** (edit-then-send) and **Insert & Send** (`ai.suggestions.allow_one_click_send` toggle, default off). Inserted-and-edited vs sent-verbatim is recorded in `metadata_json.ai.suggested/edited` for later quality review.
- **Polish:** selects/whole-draft grammar+tone cleanup via `POST .../compose/polish`. This plus native `spellcheck` covers "basic auto-correct" — native catches typos free and offline; polish is the AI upgrade.
- Both endpoints: capability `live_chat.suggested_responses`, metered as `suggestion`/`polish` usage events, and invisible (not just disabled) in the UI when the capability or org toggle is off.

### 12.6 Metering

Every AI call writes `chat_ai_usage_events` (§4.6). Env guard `chatAiOrganizationDailyLimit` (count of agent turns/day, 0 = unlimited) with the SMS-limit enforcement shape; on limit, AI mode degrades to human/offline flow gracefully (never a dead widget).

---

## 13. Settings — branch module `live_chat` + Settings tab

### 13.1 Module schema (`chat/schemas.ts` — `chatSettingsSchema`, validated on PUT)

```jsonc
{
  "schema_version": 1,
  "enabled": false,
  "widget_key": "cw_…",                      // read-only in UI; rotate action
  "website": { "enabled": true },
  "portal":  { "enabled": true },
  "appearance": {
    "primary_color": "#1f6feb", "background_color": "#ffffff", "text_color": "#111827",
    "font_family": "Inter", "position": "bottom_right",
    "launcher_label": "Chat with us", "show_branding": true
  },
  "copy": {
    "greeting": "Hi! How can we help?",
    "offline_message": "We're offline right now — leave your email and we'll get back to you.",
    "team_display": "first_name",            // first_name | team_name
    "team_name": "Support"
  },
  "pre_chat": { "require_name": false, "require_email": false, "require_phone": false },
  "live_hours": {
    "timezone": "America/Chicago",
    "days": { "mon": [{"start":"08:00","end":"17:00"}], "...": [] },
    "overrides": []                          // [{date, closed|windows}]
  },
  "presence": { "require_agent_presence": true, "force_status": "auto" },
  "mode": "human",                           // human | ai | ai_when_offline | ai_first_then_human
  "claiming": {
    "mode": "presence",                      // presence | claim
    "auto_claim_on_reply": true,
    "allow_takeover": true,
    "idle_release_minutes": 10,
    "release_on_disconnect": true
  },
  "notifications": {
    "route": { "kind": "all" },              // all | roles{role_ids} | users{user_ids}
    "debounce_seconds": 120,
    "escalate_after_seconds": 180,
    "escalation_route": { "kind": "all" }
  },
  "visitor_history": { "visible_to_visitor": true },
  "transcripts": { "offer_email_on_close": false },
  "ai": {
    "enabled": false,                        // org toggle under the capability
    "disclose": true,
    "tone": { "preset": "friendly", "custom": "" },
    "instructions": "",
    "knowledge": "",
    "tools": { "capture_contact": true, "create_lead": true, "get_business_info": true,
               "get_availability": false, "book_appointment": false,
               "lookup_customer": false, "get_pricing_guidance": false },
    "suggestions": { "enabled": true, "auto": false, "auto_after_seconds": 45,
                     "allow_one_click_send": false }
  }
}
```

### 13.2 Settings tab

New "Live Chat" tab in the company settings app (`settings/company.js` conventions): `canLiveChat` gate in `updateSidebarVisibility` (`appFlag('apps','live_chat') && hasPerm('manage_company_settings')`), `cs-tab`/`cs-pane` pair, renderer in a new sibling file `settings/live_chat.js` (following `settings/feedback.js`'s file-per-domain pattern rather than growing company.js). Sections mirror the schema: Widget & appearance (with live preview iframe + copy-paste embed snippet + key rotation), Hours & availability, Routing & notifications, Team coordination (claiming), AI agent (visible only when capability on; tone/instructions/knowledge textareas, tool toggles with explanatory copy, suggestion settings), Privacy (visitor history, transcripts). Persists via `PlatformAPI`-style client → `PUT .../chat/settings`.

---

## 14. Capabilities & permissions

Declared in `chat/capabilities.ts` via `registerCapabilities`, imported for side effect before boot (registry convention):

| Key | Kind | Parent | Default | Notes |
|---|---|---|---|---|
| `apps.live_chat` | app | — | off | Category "Sales & CRM"; `runtime_app_id: "chat"` gates the portal app |
| `live_chat.ai_agent` | feature | `apps.live_chat` | off | The AI package hook — added to AI-tier presets |
| `live_chat.suggested_responses` | feature | `live_chat.ai_agent` | on | Independent off-switch for suggestions |
| `permission.view_live_chat` | permission | `apps.live_chat` | — | `permission_key: "view_live_chat"`, read |
| `permission.send_live_chat` | permission | `apps.live_chat` | — | `permission_key: "send_live_chat"`, write |

- Role presets: `viewer` gets `view_live_chat`; `manager`+ get both (flat permission-map convention in `auth.ts`).
- Backend: **every** authenticated chat route passes `capability:` to `requirePlatformAuth` (closing the UI-only-gating gap the scope/stats agents have).
- Presets: `full_platform` gains all three; a future "AI package" preset bundles `live_chat.ai_agent` with the other `*_agent` flags.

---

## 15. Work events (registered in `work/events.ts`)

| Event | Visibility | Emitted when |
|---|---|---|
| `chat.conversation.started` | activity | Visitor opens a conversation |
| `chat.message.received` | system | Every visitor message (activity would flood feeds; the started event covers the timeline) |
| `chat.message.sent` | system | Every org-side message (payload: sender kind user/ai) |
| `chat.conversation.claimed` / `.released` / `.claim_taken` | system | Claim transitions |
| `chat.ai.replied` | system | AI turn produced a reply |
| `chat.ai.handoff` | activity | AI requested / was given human handoff |
| `chat.offline.message` | activity | Offline capture (usually also a lead) |
| `chat.conversation.linked` | activity | Linked to contact/project — from here on, the conversation appears in that project's activity feed via existing indexing |
| `chat.conversation.closed` | activity | Closed (payload: closed_by, duration, message counts) |

Payloads carry `conversation_id`, `visitor_id`, `contact_id?`, `project_id?` so org automation rules can condition on them (e.g. "on `chat.offline.message` → create follow-up call task" via existing `DEFAULT_AUTOMATION_RULES` machinery). Idempotency keys: `chat:<conversation_id>:<event>:<message_id|seq>`.

---

## 16. Security & abuse (public surface)

- **CORS (recon gap #2):** `/v1/chat/public/*` registers its own CORS config: reflect any origin, `credentials: false`, methods GET/POST, headers `Content-Type, Authorization, Idempotency-Key`. Safe because these routes never read cookies and the visitor token is an explicit header. The rest of `/v1` keeps the strict allowlist. (Optional hardening, phase 2: per-org `allowed_origins` list in settings, enforced against the `Origin` header.)
- **Rate limiting (recon gap #3):** in-process token buckets (single-host architecture makes this sufficient), keyed at three levels: per-IP (config fetch 30/min; session create 10/min), per-visitor-token (messages 20/min, 200/day; typing 30/min), per-widget-key circuit breaker (messages 600/min org-wide — a runaway-bot fuse). 429 with `Retry-After`; widget backs off silently.
- **Input limits:** message body ≤ 4k chars, text-only v1 (attachments are a later phase with real upload scanning); strip control chars; render as text everywhere (no HTML injection into portal or widget).
- **Visitor tokens:** 256-bit random, stored hashed (`token_hash`), no expiry (continuity is the feature) but revoked if the widget key rotates.
- **IP privacy:** raw IPs are never stored — salted hashes only, used for same-visitor hints.
- **Widget key rotation:** settings action; old key revoked, embed snippet updated. Public endpoints 403 on revoked keys with a widget-rendered "chat unavailable" state.
- **AI safety:** unverified-visitor tool lock (§12.3), fixed guardrail prompt, handoff-on-uncertainty default, daily AI turn limit.

---

## 17. Build plan

**Phase 1 — human live chat, end to end (the shippable core):**
1. Messaging channel extension (`webchat`), chat sidecar tables, `/v1/chat` service with public + team endpoints, rate limiting, public CORS branch.
2. Capabilities + permissions registration; work events registration.
3. Widget library (`chat-embed`), settings module + Settings tab (widget, hours, routing, claiming — AI section hidden).
4. Portal `portal.chat` app: inbox, thread, presence, claiming, read state, drafts, deep links, notification handler in topbar.
5. Notification routing + debounce + escalation automation; offline capture → lead.
6. Customer-portal mount with portal grant.

**Phase 2 — AI package:**
7. Shared agent-loop extraction; chat agent turns with settings-driven prompt + tool set; AI modes and dispatch; handoff flow.
8. Suggested responses + polish; AI usage metering + daily limit.

**Phase 3 — hardening & polish:**
9. SSE feed endpoint (same event contract) with poll fallback; per-org allowed-origins; transcript email on close; attachment support; suggestion-quality review loop (edited-vs-verbatim stats via `chat_ai_usage_events` + message metadata).

Dependencies to note: phase 1 has none outside this spec; phase 2 wants the loop extraction but can copy-then-extract if scheduling demands; SSE (phase 3) is the only piece touching platform-wide infrastructure assumptions.

---

## 18. Open questions (for review, with recommendations)

1. **Unified inbox ambition** — should the Chat app eventually absorb SMS/email conversations into one omnichannel inbox? The data model already allows it (same tables, `channel_strategy`). Recommend: design the inbox UI with a channel filter from day one but ship webchat-only; the biggest cost of merging later is UI, not data.
2. **Multi-host future** — messaging README already flags SQLite as single-host. Chat deepens that dependency (presence, leases). Recommend: accept it; chat adds no *new* migration burden beyond what messaging already carries.
3. **AI in customer portal** — should `lookup_customer` auto-unlock for portal-verified visitors by default (it's their own data)? Recommend: yes, but keep the settings toggle as the master switch.
4. **Notification sound while in another app** — the 10s notification poll gives ≤10s alert latency portal-wide. If field feedback says that's too slow for chat, the cheap fix is dropping the notification poll to 5s when `apps.live_chat` is enabled, before reaching for SSE.
