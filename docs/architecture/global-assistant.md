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
full workspace and activates the Assistant tab; Dock returns it to
the right. Close hides the assistant while preserving its conversation and draft.
The assistant has no minimize button. On phones, its dock occupies the workspace width and uses the same
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
`left_column_auto_collapse` independently controls Apps, To Dos, Channels and
Agents. Unset modes retain the legacy compact behavior; explicit false keeps
that mode expanded even when an app requests a compact rail.
They do not alter organization capabilities or grant access to an app. The Agents tab reuses the same
conversation list and controls as the assistant window. Selecting a conversation
opens the full assistant workspace; docked and mobile layouts retain the compact
in-window conversation panel. The preference defaults off. In either full-screen
layout, the assistant's Float, Dock, Maximize and Close controls float at the upper
right while the conversation body uses the full workspace height.

The assistant header keeps the conversations toggle at left and the shared
Float, Maximize and Close window controls at right, with Close to the right of
Maximize. Conversation history is
a default-closed, toggleable left sidebar in desktop full view and an overlay in
docked, floating and mobile views. Full-screen mode keeps the conversations toggle
at the upper left and does not automatically open history. When conversations
are mounted in the global left column, that column retains its own visibility handling. The sidebar searches titles and the user's
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

Agent occurrences are queued as `assistant_agent` wakeup jobs. Every process
that serves the assistant API and has the OpenAI key runs a dedicated lane every
15 seconds (`ASSISTANT_AGENT_LANE_DISABLED=1` turns it off). The lane sweeps only
assistant agent schedules and drains only those jobs, so agents work where no
platform worker is installed; Channels need not be enabled and dormant Channels
wakeups are left alone. A platform worker, when installed, also runs these jobs.
Schedule and job claims are transactional, so replicas never duplicate an
occurrence. The recurring sweep evaluates cron minutes since each agent's last
run; revisit its cost before very large agent counts. A run executes in the agent thread as its creator through
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

Channels invitations to an assistant enqueue an immediate reply. Inviting one
into a two-person DM converts it to a group DM and clears its pair lookup key,
so future human-only DMs stay separate. Interactive DM and mention requests
start draining the durable `channel` queue on the serving process; they do not
depend on a separate worker being present. Queue claims still prevent duplicate
execution when a worker or another replica is also draining it.

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

## Focused notification entry point

Notification settings uses `notification_assistant`, a focused declaration of the
same FirstMate assistant foundation. It shares the model, instruction layers,
settings adapter, durable conversation runtime and shared chat renderer. It exposes
only notification inspection/configuration plus `report_result`; the definition's
`platformTools: false` prevents the runtime from adding cross-app tools.

The default-on Notifications feature has thin authenticated routes under the
platform API so FirstMeasure-only accounts can use this focused conversation without
enabling expanded platform access or the full assistant app. Catalog and resource
checks still limit choices to enabled apps and authorized data. Threads are personal;
mutations require CSRF. Company assistant enabled/allow_actions settings remain in
effect. Read [notification declarations and configuration](notifications.md) for
matching, duplicate prevention, delivery authorization and the preference contract.

## Focused terminology entry point

Configuration → Terminology uses `terminology_assistant`, another focused declaration
of the same FirstMate foundation. It shares the model, instruction layers, settings,
personal durable threads and chat renderer. It exposes only `draft_terminology` and
`report_result`, with `platformTools: false` and `manage_company_settings` required.
The tool returns locale-specific editor drafts rather than changing configuration;
the administrator uses the normal Save action. See [terminology and language](terminology.md)
for the catalog, inheritance, public projections and validation contract.


## Private channel conversations

Channels' recap action calls `PlatformAssistant.openChannelConversation` and uses
exactly the global assistant drawer, composer, history, settings and window controls.
It opens docked beside Channels. The first opening sends a recap request privately;
later openings resume that channel's conversation. Follow-ups use the same assistant
runtime, provider configuration and permission-gated tools. No recap request or
answer is posted to the source channel. Explicit assistant mentions in a channel
continue to use the existing public participant workflow.

`POST /v1/assistant/organizations/:orgId/channels/:channelId/conversation` requires
both Assistant and Channels access and source membership. A transactional lookup
returns one personal `assistant` thread with subject `channel:<id>` per user/channel.
The assistant prepare hook refreshes source context on every turn through the
Channels domain's authorized readers, including audience filtering. A persisted
thread subject is carried separately from caller-supplied subjects so the generic
agent endpoint cannot bypass this check. Source access revoked after creation blocks
subsequent turns before model invocation. The user's existing private history stays
in their own assistant history.

The default snapshot includes up to 100 recent top-level messages, up to 30 replies
for each of the latest 10 threads, and attachment metadata. Text excerpts are capped
at 2,000 characters each and 60,000 total. The prompt states these bounds and treats
source content as untrusted data; file metadata is not treated as file content.
Deeper research uses the existing authorized platform tools.

Regression coverage includes `tests/channel-assistant-browser.test.mjs`, the Channels
workspace browser fixture, and the channel recap case in `tests/assistant-api.test.ts`.
Provider requests in these tests are mocked.


## GPT-Live voice conversations

The global composer has a Voice conversation button beside dictation. It starts
`gpt-live-1` over WebRTC, using the same server-side `env.openaiApiKey` as the
Responses agent. Authenticated, CSRF-protected session creation checks assistant
access, thread ownership, company settings and project/channel membership before
seeding a bounded recent history. Browser configuration cannot select another
model, instructions or tools. Provider credentials never reach the browser.

GPT-Live uses **client delegation**: its input/output transcript fragments and
delegation IDs drive serialized requests through the existing messages endpoint
with `intent: voice`. All business tools, permissions, memory, limits, thread
leases and required confirmations remain in the shared agent runtime. The voice
turn note treats spoken assistant text as context rather than evidence of a
completed action. Duplicate delegation events are ignored. Uncertain requests
are not automatically replayed. Backend results remain in the thread; live
captions and small talk are session-local. The browser is the sole delegation
owner; no sideband also executes tools.

Mute disables the microphone track. End voice, window close, settings or thread
changes stop capture and close the session. An authenticated close endpoint can
attach a server sideband as a fallback; its expiring HMAC ticket binds the provider
session to the user, organization and thread across web nodes. The browser ends
sessions at 20 minutes. Session starts have a per-user, per-process limit of six
per minute; this is not a fleet-wide billing quota. A task already submitted can
continue after interruption or end-call, which the UI states explicitly. Later
corrections are serialized as subsequent agent requests; this first implementation
does not cancel an already-running business operation or automatically retry it.

Official protocol references: [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc),
[client delegation](https://developers.openai.com/api/docs/guides/live-delegation),
and [session controls](https://developers.openai.com/api/docs/guides/voice-server-controls).
Tests: `tests/assistant-voice-browser.test.mjs` and voice cases in
`tests/assistant-api.test.ts`. A synthetic microphone/provider verification is
recorded in ignored `output/assistant-live-20261002/`; it uses the existing
server credential without copying it locally.

Development delivery and verification: [GPT-Live voice rollout](../../deploy/digitalocean/development-assistant-live-20261002.md).


### Shared project surface and voice handshake follow-up (October 2)

`createAssistant` owns the common renderer, composer, settings, attachments,
dictation and voice controller. The global window and `mountProject` each create
an independent instance; the old `fmpa` project chat implementation is removed.
Project instances use the existing private project-conversation endpoint and its
persisted subject binding. They show project suggestions and project history,
with independent drafts and messages. The parent project shell still owns window
placement and controls. Tray hiding or removal ends capture; destroying an
instance releases its listeners, observers and refresh timer. Only one live voice
call is active across assistant instances.

The composer measures the placeholder against the available input width, falling
back to shorter text. Dictation and live voice have adjacent 32px-wide controls.
Empty inputs stay one line while typed messages retain multiline expansion.

Voice session validation must preserve SDP bytes, including the final CRLF.
Calling `trim()` caused OpenAI to return `invalid_offer` / SDP EOF, previously
masked as unavailable account access. The route now preserves the offer, and
connection errors no longer claim account ineligibility. A connected session
receives initial spoken commentary so the person hears confirmation.

Regression coverage: `assistant-project-browser.test.mjs`, the updated
`project-trays-browser.test.mjs`, and the voice API test asserting exact SDP
preservation. An isolated authenticated API fixture plus the actual browser UI
was exercised against GPT-Live using the existing remote credential; session
start, received audio and orderly close succeeded.

Delivery record: [Voice handshake and shared project UI](../../deploy/digitalocean/development-assistant-voice-project-20261002.md).


### Voice inside chat (October 2)

The shared assistant presents live speech as ordinary chat bubbles. Voice mode
replaces Dictate/Start Voice with Mute/Stop controls in the composer; Stop uses a
red square. The header indicator stays absolutely centered and scales fixed bars
from the received remote audio RMS, with a static reduced-motion alternative.
It owns a separate audio context and animation frame, both closed on hang-up.
Autoplay recovery is a chat-level play button rather than a separate voice panel.

Typing and file uploads remain available during voice. Typed requests share the
serialized delegation queue and the existing authenticated upload/messages APIs;
results return to GPT-Live through commentary. Submitted typed work may continue
after hanging up, like an already submitted spoken task. Chat draft and unused
attachments remain intact. Live transcripts are session-local; durable backend
turns retain the existing storage behavior. Live chat segments retain their place
relative to later typed messages during the mounted conversation.

The official [client delegation guidance](https://developers.openai.com/api/docs/guides/live-delegation)
directs typed input to the existing backend, with results returned as commentary.
No provider credentials, tool grants or backend operation implementations change.


### Widget view and voice cues (October 2)

Platform widget renders share the assistant's side panel with dashboard artifacts
in full view. Left is the default; the panel's side switch persists the preference.
The composer remains a sibling beneath both columns. Close widget view and narrow
layouts render widgets inline instead. Content widgets retain natural height;
inline previews cap at the larger of 600px/80vh and expand into the chat scroll,
without a nested preview scrollbar. Fill widgets use the available panel height
or a usable inline viewport. Hidden voice-backend messages retain widget renders.
Closing the side view disposes its mounts before inline replacements are created.

Voice-only Web Audio cues mark starting, connected and hang-up; a low-volume
connecting pulse ends on readiness, cancellation or failure. Capture stops
immediately on hang-up; the audio context closes after the short ending tone.


## Project tray session lifetime

The outer portal owns project assistant controllers, including their microphone, peer connection and audio context. Their existing renderer mounts in the project's document, so changing trays or minimizing a project changes presentation without stopping the call. Voice automatically pins the same renderer in a 100px bottom-right surface when the Agent tray is hidden; text conversations can be pinned manually. The current project, tab, tray and minimized state travel as bounded navigation metadata, never as instructions or authorization. The existing navigation presentation tool can show only a tray currently declared by the project surface.

Closing a project with an active call offers End voice agent or Transfer to global voice agent. Ending uses the normal microphone cleanup and hang-up cue. Transfer preserves the same thread and live connection, moves its renderer to the outer assistant window, and changes the owned thread subject from `project:<id>` to `transferred-project:<id>` through a CSRF- and ownership-checked endpoint. The transferred subject supplies global context with explicit provenance and no default project; later project opens get a new project-scoped conversation. Transfer is rejected while an agent action is working. The originating project iframe may then be removed without terminating the transferred call.
