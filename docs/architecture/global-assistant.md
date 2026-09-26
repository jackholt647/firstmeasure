# Global assistant architecture

The portal's global assistant is registered as `assistant` in
`public/v1/assistant/agent/definition.ts`. It uses the shared Responses loop in
`public/v1/agents/runtime.ts`, the same SQL-backed thread and run store as other
agents, and the published platform data/action tools in `agents/platform_tools.ts`.
`platform_search` discovers authorized resources and operations; `platform_describe`
returns typed contracts; read/list/invoke/resolve-binding operate through the
publication layer. A local tool list is a convenience, not a limit on app reach.
Each tool call refreshes the human principal and checks current permissions.

## Instruction layers

1. **Platform rules** are versioned source in the agent definition and shared
   runtime. They include tool use, confirmation, permission and memory rules.
2. **Platform-wide editable instructions** live in the platform configuration
   record `global_assistant_instructions`. The Company Settings page displays
   them to company administrators. Editing requires a platform session with
   `manage_company_settings` and a verified full internal admin identity.
3. **Organization instructions** use `assistant_organization_instructions`,
   keyed by organization. The settings API retains the `custom_instructions`
   field; if no organization record exists it reads the legacy branch value.
   The first settings save writes the organization record. Company
   administrators edit them in Company Settings.
4. **User interaction instructions** live in `assistant_profiles`, keyed by
   organization and user. A user edits only their own profile in Company
   Settings. They are loaded on every authenticated assistant turn.

Platform rules take precedence over editable platform instructions, then
organization instructions, then personal instructions and saved memories.
Editable text is treated as preferences and cannot grant permissions or
override action gates. Admin or personal edits apply to the next turn; no
process cache is used.

## Memory and history

`assistant_memories` stores up to 50 short, user-owned entries per organization.
The user can add, edit, delete or clear them and turn prompt use off without
deleting them. Memory is disabled for automatic runs. The agent's
`save_user_memory` tool is instructed to save only at the user's explicit
request and never store credentials or sensitive personal data. The owner can
ask the agent to forget an entry or manage it directly in Settings. Saved
memories are bounded and loaded into each prompt when enabled.

Conversation messages remain durable in `agent_messages`. The runtime replays
the most recent 40 messages, in chronological order. The assistant may search
older messages across only its caller's own threads with
`search_my_conversation_history`. This gives it retrieval across the replay
window without growing every prompt indefinitely. The user can inspect their
threads through the existing assistant API.

## API and UI

`/v1/assistant/organizations/:orgId/settings` remains the organization
settings route. The API adds `global-instructions`, `profile` and `memories`
routes under the same prefix. Profile and memory endpoints derive user identity
from the authenticated session; they accept no user-id selector. Mutations
require CSRF. The Company Settings AI Agents tab shows the platform and
organization settings to admins and personal settings and memory controls to
assistant users.

## Portal window and app entry

The top-bar assistant and `portal.assistant` app use the same
`PlatformAssistant` instance, thread state, and `FirstMateWindows` controller.
The assistant starts as a right dock. The shared maximize control opens the
full workspace and activates the Assistant tab; Dock or Minimize returns it to
the right. On phones, its dock occupies the workspace width and uses the same
compact layout. Channels conversations and the assistant both use
`libraries/window-manager/window-manager.js`; the assistant no longer has a
separate fixed drawer implementation.

The app manifest exposes Assistant in the Apps launcher through
`apps.assistant`. Its default `portal.assistant` placement is `more` and
`app_placements` pinning moves it to the left sidebar. The assistant sidebar
opens a complete in-window settings view in docked, floating and full layouts.
Personalization and Memory belong to the signed-in user. Company administrators
also get Capabilities, Agents and Advanced tabs. These expose the assistant's
name, organization instructions, action and data switches, every registered
agent's common and advanced settings, and the platform-wide instructions
(editable only by a verified platform administrator). Saves use the existing
permission-checked assistant and agent APIs. No settings link leaves the
assistant window. Enable controls use accessible visual switches in the
assistant and the legacy AI Agents settings page.

The signed-in user's `left_column_agents` preference enables the desktop Agents mode in the
portal left column, alongside Apps, To Dos and Channels. All left-column tab and layout
preferences live in Company Settings > My Settings and use `/v1/platform/me/preferences`.
They do not alter organization capabilities or grant access to an app. The Agents tab reuses the same
conversation list and controls as the assistant window. Selecting a conversation
opens the full assistant workspace; docked and mobile layouts retain the compact
in-window conversation panel. The preference defaults off. In either full-screen
layout, the assistant's Float, Dock and Minimize controls float at the upper
right while the conversation body uses the full workspace height.

The assistant header keeps the conversations toggle at left and the shared
Float, Minimize and Maximize window controls at right. Conversation history is
a persistent left sidebar in desktop full view and a 68%-width overlay in
docked, floating and mobile views. The sidebar searches titles and the user's
own conversation messages, and owns new
conversation and assistant settings. The chat and settings panes use the same
assistant instance, so switching window modes preserves their state.

The composer accepts up to five files of 20 MB each through an authenticated
assistant upload route. Uploads are bound to the current user's conversation;
the send route rechecks both user ownership and thread binding. Supported
images and document types are passed to the current Responses turn as image
and file input parts. Audio attachments are transcribed first. Other formats,
including video, are stored and shown in history but their contents are not
analyzed by the model. Browser microphone dictation uses the same transcription
service and places recognized text into the composer for review before send.

## Main thread, agents and the dashboard

Each user has one **main thread** (`agent_threads.subject_id = 'main'`), created
on first `context` read inside a store transaction. Other personal threads are
**side chats**. The navigation lists the main thread, a collapsible **Agents**
section and a collapsible **Side chats** section; new side chat and settings are
in its header and search is at its bottom.

An **agent** is a personal scheduled task the assistant creates with
`create_agent` (also `list_agents`, `update_agent`, `delete_agent`,
`run_agent_now`). It is an `agent_schedules` row with `surface = 'assistant'`,
a short title, a summary and run instructions, plus its own thread
(`subject_id = 'agent:<schedule id>'`). That thread holds the configuration chat
(the API adds the current setup to each turn) and the history of runs, so runs
can compare with earlier ones. Schedules use the company timezone; recurring
agents may run at most every 15 minutes, and a user may have 20 active or paused
agents. Resuming or rescheduling does not replay missed occurrences.

The shared channel scheduler on the worker role sweeps due schedules and routes
`surface = 'assistant'` jobs to `assistant/agent/agents.ts` (Channels need not
be enabled). A run executes in the agent thread as its creator through
`backgroundAuthContext`, so current permissions, capability and settings gates
still apply. The reply is appended to the creator's main thread with
`data.source = 'agent'`, its artifacts are pinned to the dashboard (replacing the
same agent's artifact with the same key), the schedule records the last result,
and a push notification (`frontend_action.kind = 'open_assistant'`) opens the
main thread. Delivery is in-app and push; agents do not send SMS.

**Artifacts** are declarative specs from `create_artifact` (bar, line, pie,
donut, metrics, table, text), validated server-side and drawn by the browser's
own SVG/HTML renderer; model-authored HTML or script is never executed. Chat
artifacts are pinned to the per-user `assistant_dashboard_items` table (12 most
recent). In the full workspace the dashboard sits left of the conversation with
an invisible, draggable divider; the composer stays centered beneath both. When
the window is narrow, docked, or the dashboard is hidden, artifacts render
inline in the conversation. Settings → Agents lists, pauses, resumes, runs and
deletes a user's agents. Routes: `agents`, `agents/:id` (GET, PATCH, DELETE),
`agents/:id/run`, `dashboard` and `dashboard/:itemId` under the organization prefix.

## Reliability

The shared runtime stops after 16 rounds, 64 tool calls, or repeated identical
tool batches, whichever comes first. Hitting a limit records a failed run and
attempts the agent's revert hook. A run requiring `report_result` fails if the
model ends without it. Tool calls and outcomes are recorded in the message
trace. The assistant defaults to `gpt-6-luna` with medium reasoning effort;
`OPENAI_ASSISTANT_AGENT_MODEL` and `OPENAI_ASSISTANT_AGENT_EFFORT` can override
it operationally.

Verification: `npm run check`, `npm run test:assistant`,
`npm run test:assistant:frontend`, and `npm run test:publication` in
`public/v1`. Tests mock Responses and cover instruction loading, memory across
threads, memory opt-out, action permissions and loop stopping.
