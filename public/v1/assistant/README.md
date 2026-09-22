# FirstMate Assistant (global AI agent)

The company-wide AI assistant that lives in the portal top bar: a chat drawer
that can answer questions about anything in the workspace, look up projects,
customers, tasks, schedules, documents, and stats, and — when the company
allows it — take action (create/complete to-dos, advance pipeline stages,
schedule project events, fire automation events, post project notes, send
customer messages).

## Architecture

Mirrors the stats agent (`../stats/agent/`) exactly in shape:

- **`agent/service.ts`** — the tool-calling loop over the OpenAI Responses
  API. Model/effort/timeout come from `env.openaiAssistantAgent*`
  (`OPENAI_ASSISTANT_AGENT_MODEL`, default `gpt-5.6-sol` at `high` effort).
  Up to 16 tool rounds per turn; every turn ends with a `report_result` call.
  Failed runs cancel any to-dos the run created (best effort) and say so;
  automation events that already fired cannot be recalled and the tool output
  says as much.
- **`agent/manifest.ts`** — the knowledge base baked into the system prompt:
  platform overview, the stats metric DSL + live field catalog (imported from
  `stats/metrics.ts`), and the automation event catalog (imported from
  `work/events.ts`), so new fields/events appear automatically.
- **`storage.ts`** — `assistant.sqlite` under `env.platformStorageRoot`:
  `assistant_threads` + `assistant_messages`. Threads are personal (listed
  per `created_by_user_id`) and org-scoped.
- **`settings.ts`** — per-branch settings in the `assistant_settings` branch
  module (same idiom as live chat): enabled, assistant name, custom
  instructions, `allow_actions` / `allow_notes` / `allow_messaging`, and
  per-area `data_scope` toggles (projects, contacts, stats, documents,
  schedule, activity).
- **`capabilities.ts`** — registry nodes: `apps.assistant` (app, default on),
  `assistant.actions` (feature, default on), `assistant.messaging` (feature,
  default OFF), `permission.use_assistant`. Write tools are gated by BOTH the
  capability and the settings toggle.
- **`api.ts`** — `/v1/assistant`: `GET /organizations/:orgId/context` (drawer
  boot: settings subset + caller's threads), `GET|PUT .../settings`
  (manage_company_settings), `GET|POST .../threads`,
  `GET .../threads/:threadId`, `POST .../threads/:threadId/messages` (runs one
  synchronous agent turn). Chat access requires the `apps.assistant`
  capability plus `use_assistant|view_projects|manage_projects|manage_company_settings`.

## Tool surface

Read: `get_workspace_context`, `search_platform`, `list_projects`,
`get_project` (project + contacts + scope/stage projection + tasks + docs +
recent activity in one call), `list_tasks`, `get_schedule`, `list_activity`,
`run_stats_queries`, `read_document`.

Write (capability `assistant.actions` + settings `allow_actions`):
`create_task`, `update_task_status` (to-dos AND pipeline stage nodes),
`schedule_project_event`, `trigger_automation_event` (fires `emitWorkEvent`;
matching automations run and cannot be undone), `post_project_note`
(`allow_notes`).

Messaging (capability `assistant.messaging` + settings `allow_messaging`,
both default off): `send_customer_message` — the prompt requires an explicit
confirmation in the conversation first; all of messaging's own compliance,
consent, and rate-limit guards still apply because it goes through
`sendCommunication`.

UX: `suggest_navigation` records chips in `assistant_message.data.actions`
that the drawer renders as "open this" buttons (project modal / portal tab);
`report_result` is the mandatory final status call.

## Frontend

- `public/libraries/assistant-api/assistant-api.js` — `window.AssistantAPI`
  client (CSRF + credentials pattern shared with stats-api).
- `public/libraries/platform-assistant/platform-assistant.js` —
  `window.PlatformAssistant`, the global right-hand chat drawer (closed by
  default). Renders markdown replies, "What changed" lists from
  `data.changes`, and navigation chips from `data.actions`.
- Top bar icon: `#platformAssistantBtn` (desktop) / `#mobilePlatformAssistantBtn`
  (mobile) in `public/portal/index.php`, sitting between global search and
  notifications, wired in `public/portal/scripts/topbar.js`, hidden when
  `Portal.can('apps.assistant')` is false.
- Settings: the "AI Assistant" tab in Company Settings
  (`public/libraries/apps/settings/company.js`), which reads/writes
  `/v1/assistant/organizations/:orgId/settings`.

## Tests

`npm run test:assistant` → `tests/assistant-api.test.ts` (OpenAI mocked by
scripting `globalThis.fetch`, the codebase-standard pattern).
