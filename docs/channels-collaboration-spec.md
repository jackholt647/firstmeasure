# Channels Collaboration Update

Status: implementation specification  
Date: 2026-07-30  
Owners: Channels, Platform, Media, Documents, To Dos, Realtime  
Scope: core collaboration, project-aware resources, clips, workflows, AI assistance, external collaboration, huddles, screen sharing, and keyboard access

## 1. Decision summary

FirstMate Channels will become the collaboration surface for work that already lives in FirstMate. It will not become a second document, task, photo, or file system.

The update has four connected parts:

1. Make messaging dependable: correct unread state, a durable activity inbox, followed threads, rich messages, drafts, scheduling, reminders, search, notification controls, channel discovery, and keyboard navigation.
2. Make work available in context: channel tabs, folders, resource cards, project-aware files and media, Documents, To Dos, links, clips, workflows, and AI assistance.
3. Add lightweight synchronous collaboration: huddles with audio, video, live screen sharing, a huddle thread, and optional recordings.
4. Preserve system boundaries: Media, Documents, To Dos, Projects, Identity, Work, and Realtime remain authoritative for their own records. Channels stores references and channel-specific presentation state.

For a project channel, the associated project is the resource scope. Anything uploaded or created through that channel is created in the project's canonical store and becomes visible through the corresponding FirstMate app. Existing project resources are available to the channel without copying them.

For a non-project channel or direct message, Channel membership defines a collaboration scope. Media may be canonically owned by that channel. Documents and To Dos remain canonical records in their existing systems and are attached to the channel by reference and explicit access policy.

## 2. Goals

- Match the collaboration behavior medium-sized teams expect from Slack: reliable attention management, capable messaging, organized resources, useful automation, and quick real-time calls.
- Make project channels a natural collaboration view over an existing project.
- Let users share and work with Media, Photos, Documents, To Dos, and other FirstMate records without duplicating them.
- Make unread state, mentions, replies, reminders, and notifications predictable across devices.
- Support async video and screen-recording clips as first-class messages.
- Support live huddles and screen sharing without requiring a separate meeting product.
- Provide complete keyboard operation and a fast command switcher.
- Make staged rollout safe through authoritative, server-enforced capabilities.

## 3. Non-goals

The following are explicitly outside this update:

- Replacing or redesigning the existing Media, Photos, Documents, To Dos, Projects, or Files experiences.
- Storing duplicate binary files inside Channels.
- Enterprise compliance exports, legal hold, eDiscovery, data-loss prevention, enterprise key management, or HIPAA-specific controls.
- Deep organization analytics, employee surveillance, or productivity scoring.
- Multi-workspace enterprise administration.
- A public third-party app marketplace in the first release.
- PSTN calling, webinar hosting, calendar replacement, or large scheduled meetings.
- Granting access to a project or resource merely because its link was posted in a channel.

Normal organization retention, authorization, deletion, and security logging still apply. The exclusion is for a new enterprise compliance product, not for baseline safety.

## 4. Product principles

### 4.1 One record, many surfaces

A resource has one canonical identity. A document shown in a channel is the same document shown in Documents. A To Do created from a message is the same To Do shown in To Dos. A project photo uploaded through a project channel is the same media record shown on that project.

Channels may store:

- a reference to the resource;
- the message that introduced it;
- its folder or tab placement;
- a channel-specific label or note;
- whether it is pinned;
- sort order and display preferences.

Channels must not store a second editable copy of the resource.

### 4.2 Scope before convenience

Showing a resource never widens access implicitly. The viewer must satisfy both the channel access rule and the canonical resource access rule unless an explicit share operation grants a supported resource permission.

### 4.3 Attention is user-controlled

Opening a channel is not enough to mark every loaded message read. Read state follows what the user has actually reached, with explicit mark-read and mark-unread actions and an undo path.

### 4.4 Async and live collaboration meet in the same history

Clips, huddles, huddle notes, recordings, shared resources, and follow-up To Dos appear in the channel's ordinary message history and search results. They do not become disconnected mini-products.

### 4.5 Features do not flash into existence

Capability decisions are available before application mounting. Disabled applications, sidebar injections, tabs, and actions are neither rendered nor requested from the server.

## 5. Existing foundation

The current Channels implementation already provides:

- public and private channels;
- direct and group direct messages;
- project-message channels;
- messages, threads, reactions, mentions, attachments, pins, saves, edits, revision history, and deletion recovery;
- typing and realtime events;
- audio notes;
- basic full-text search;
- monotonic channel read cursors;
- a partial mentions and replies inbox;
- translation and FirstMate Assistant participation.

The platform already provides the canonical systems needed by this update:

- Media storage and metadata, including owner, scope, collection, project association, tags, variants, and storage usage;
- project Documents, document events, snapshots, and exports;
- canonical To Dos through action items and work nodes;
- Projects and project authorization;
- realtime publication and subscription;
- work events and automation infrastructure;
- capability definitions and organization settings.

This specification extends those systems. It does not introduce replacements.

## 6. Release composition

The work is divided into dependency-ordered releases. These are engineering boundaries, not separate product promises.

### Release A: dependable collaboration

- Read and unread state v2
- All Unreads
- Activity inbox
- Followed threads and Threads view
- Notification and do-not-disturb controls
- Rich message model and composer
- Per-conversation drafts
- Scheduled messages
- Message reminders
- Forwarding, links, and share actions
- Improved channel browser, join, leave, archive, and default-channel behavior
- Custom sidebar sections
- Advanced search
- Quick switcher and keyboard shortcuts
- Authoritative capability loading

### Release B: resources in context

- Channel resource references
- Project resource adapter
- Files, Photos/Media, Documents, To Dos, Pins, and Links tabs
- Custom tabs and folders
- Resource picker and share cards
- Message-to-To-Do conversion
- Async video clips
- Async screen-recording clips
- User groups and group mentions
- Workflow shortcuts and message-triggered workflows
- FirstMate Assistant summaries, recaps, and resource-aware answers
- Internal app, bot, and webhook extension points
- External direct messages and shared channels

### Release C: lightweight live collaboration

- Channel and DM huddles
- Audio and optional camera
- Live screen sharing
- Huddle thread and reactions
- Optional recording, transcript, notes, and follow-up To Dos
- Call-state recovery and device handoff

## 7. Information architecture

Channels retains its existing application entry. Within Channels, the standard top-level views are:

- Home
- All Unreads
- Activity
- Threads
- Later
- Channels
- Direct Messages

A conversation contains:

- a header with members, notification state, search, and huddle action;
- ordered tabs;
- the active tab;
- an optional thread pane;
- a composer or resource action bar, depending on the active tab.

Default channel tabs are:

1. Messages
2. Files
3. Documents
4. To Dos
5. Pins

Photos/Media and Links may be enabled as separate tabs or included in Files according to organization preference. Project channels default to separate Photos/Media and Documents tabs because those collections already have project meaning.

Custom folders organize references inside a channel. They do not move or rename the canonical resource.

## 8. Resource scope and ownership

### 8.1 Scope matrix

| Conversation type | Binary media owner | Documents | To Dos | Access authority |
| --- | --- | --- | --- | --- |
| Project channel | Project | Existing project Documents | Existing project action items | Project access plus channel visibility |
| Public channel | Channel | Referenced canonical documents; channel-context creation where supported | Canonical action items with channel context | Organization and channel membership |
| Private channel | Channel | Explicitly referenced canonical documents | Canonical action items with channel context | Channel membership and resource permission |
| Direct/group message | Conversation channel | Explicitly referenced canonical documents | Canonical personal or shared action items | Conversation membership and resource permission |
| External shared channel | Channel in home organization, federated reference remotely | Explicit shares only | Explicit shares only | Both organizations' policies |

### 8.2 Project channels

A project channel has a stable `project_id`. Its resource tabs are backed by the existing project APIs:

- Photos/Media queries canonical media by project.
- Documents queries canonical project Documents.
- To Dos queries canonical action items associated with the project.
- Files is a filtered union of media and document resources.

When a user uploads a file, photo, video, audio note, or clip through a project channel:

1. Channels resolves the project scope.
2. Media creates a project-owned media record with `project_id`.
3. Channels posts a message containing the media reference.
4. The resource immediately appears in the project Media/Photos experience.

When a user creates a Document or To Do from a project channel, it is created with that project association. The message and channel store back-references only.

Deleting a message does not delete its canonical project resource. A separate, permission-checked resource deletion action is required. If an upload has never been used outside its draft and the draft is abandoned, normal media orphan cleanup may remove it.

### 8.3 Non-project conversations

Binary uploads use the existing Media service with owner type `channel` and the conversation channel ID. No Channels-specific blob store is added.

Documents remain in Documents. The Documents service must support a canonical non-project context before a user can create a new standalone document from a non-project channel. Until that dependency is delivered, users may attach an authorized existing document, or select a project and create the document there. Channels must not silently manufacture a project or store a private document copy.

To Dos are canonical action items. They may have a project association, a channel context, or both.

### 8.4 Access behavior

- A channel reference does not bypass the resource's authorization.
- A user without resource access sees an unavailable card, not a leaked title, thumbnail, transcript, or snippet.
- An explicit Share action may grant access only through the canonical resource system and only when the actor has permission to grant it.
- Removing a user from a project or private channel invalidates subsequent resource reads immediately.
- Search filters every result through current conversation and resource authorization.
- External participants receive only explicitly shared resources. Project-wide implicit discovery is never available externally.

## 9. Core messaging

### 9.1 Rich message format

Messages gain a versioned structured content field while retaining normalized plain text for previews, notifications, export, accessibility, and search.

Supported blocks:

- paragraph;
- heading;
- ordered and unordered list;
- quote;
- code block and inline code;
- divider;
- link;
- user, channel, user-group, project, and resource mention;
- emoji;
- resource card;
- image or media gallery;
- clip;
- lightweight table pasted from another FirstMate surface.

The first release does not need a freeform page editor inside the composer. Formatting must remain fast and message-oriented.

Paste handling must preserve links and readable text, strip unsafe markup, upload pasted images through Media, and never accept executable HTML.

### 9.2 Composer behavior

- Inline formatting toolbar and Markdown-style shortcuts
- Mention and emoji autocomplete
- Resource picker for Files, Photos/Media, Documents, and To Dos
- Drag, drop, paste, and multi-file upload
- Video clip, screen clip, and audio-note actions
- Send now or schedule
- Draft saving
- Configurable Enter-to-send or Ctrl/Cmd+Enter-to-send
- Visible upload and processing state
- Retry without losing entered content
- Accessible error announcements

### 9.3 Drafts

Drafts are saved per user and per target:

- channel root;
- direct message root;
- individual thread.

Drafts sync across devices after a short debounce. Local persistence covers temporary network loss. A server revision prevents an older device from overwriting a newer draft. A sent or explicitly discarded draft is tombstoned so it does not reappear from an offline client.

### 9.4 Scheduled messages

Users may schedule a message in their organization time zone, edit it, reschedule it, or cancel it. The server is authoritative for delivery. Scheduled messages are not exposed to other members until sent.

At delivery time the service rechecks:

- sender status;
- channel membership;
- channel archived state;
- attachment/resource access;
- capability state.

A failed delivery remains in the sender's Scheduled view with a clear reason and retry action.

### 9.5 Message actions

Every eligible message supports:

- reply in thread;
- react;
- edit or delete, according to policy;
- save for later;
- remind me;
- mark unread from here;
- copy text;
- copy stable link;
- forward/share to another conversation;
- pin;
- create To Do;
- start workflow;
- report, when the organization enables moderation.

Forwarding creates a new message with a reference to the source. It does not clone attachments or bypass source access. The user may instead choose "share files as new copies" only where the canonical resource system supports an explicit copy.

## 10. Read state, unread state, and attention

### 10.1 Read model

Each user has a read boundary per conversation and a separate read boundary per followed thread.

A message is read when:

- it is at or before the user's read boundary; and
- there is no manual unread marker at or before that message.

The client advances the boundary only for messages that have crossed a viewport observation threshold while the window is visible and the conversation has focus. Merely fetching or mounting messages does not mark them read.

The service accepts monotonic read advancement. Manual unread markers may move attention backward without reducing the stored read boundary.

### 10.2 Explicit actions

Users can:

- mark a conversation read;
- mark unread from a specific message;
- mark a thread read or unread;
- mark every visible item in All Unreads read;
- mark all conversations read;
- undo bulk read actions for a short period.

Bulk operations return an operation token. Undo restores the previous manual markers and attention state if the token has not expired.

### 10.3 All Unreads

All Unreads presents unread messages grouped by conversation. It supports:

- newest or oldest conversation ordering;
- collapse per conversation;
- reply, react, save, and create To Do in place;
- mark channel read;
- mark all read with undo;
- filters for channels, direct messages, projects, and external conversations.

Thread replies contribute to unread state when the user follows the thread, is mentioned, or authored the root message, subject to notification preferences.

### 10.4 Activity

Activity is a durable attention inbox, not a temporary reconstruction from recent messages.

Activity kinds include:

- direct message;
- mention;
- user-group mention;
- thread reply;
- reaction to the user's message;
- assignment or To Do update originating in Channels;
- workflow requiring user action;
- huddle invitation or missed huddle;
- assistant answer explicitly requested by the user.

Users can filter, mark read/unread, clear, and jump to context. Retention follows ordinary product retention, not an arbitrary short lookback window.

### 10.5 Threads

Users automatically follow a thread when they:

- start it;
- reply;
- are explicitly mentioned;
- choose Follow.

They may unfollow any thread. The Threads view shows followed threads with unread replies, draft state, and the ability to reply without leaving the view.

### 10.6 Realtime and cross-device behavior

Read boundaries, manual unread markers, thread subscriptions, activity state, drafts, and notification preferences publish realtime changes. Clients use version numbers to reject older events and reconcile from the server after reconnect.

### 10.7 Later

Later is the user's durable list of saved messages and personal message reminders. It supports:

- in-progress, archived, and completed groupings;
- personal notes;
- reminder times;
- jumping to message context;
- converting a saved message into a canonical To Do;
- marking an item complete without changing the source message.

Saving a message does not copy its content into a new editable record. The saved-item row retains the source reference and a minimal, retention-safe fallback. If the source is deleted or access is lost, the item becomes unavailable without leaking its former contents.

## 11. Notifications

### 11.1 Preference hierarchy

Effective notification policy is resolved in this order:

1. Organization safety policy
2. User do-not-disturb schedule and temporary pause
3. Conversation override
4. User default
5. Event type

Conversation levels are:

- Every new message
- Mentions and followed threads
- Nothing

Muting suppresses ordinary attention but does not hide the conversation or block explicit calls from permitted users. Users can separately control huddle invitations.

### 11.2 Controls

- Per-channel and default notification level
- Keyword notifications
- User-group mention preferences
- Daily and weekly do-not-disturb schedule
- Pause for a duration
- Mobile delay after desktop activity
- Browser, mobile, and email transport preferences where those transports exist
- Notification preview privacy
- Sound selection and mute

Notifications are generated server-side from the same attention events used by Activity. Delivery is idempotent and records a deduplication key.

## 12. Search and discovery

### 12.1 Search

Search spans messages and authorized referenced resources. It supports:

- plain terms and quoted phrases;
- `from:`;
- `in:`;
- `project:`;
- `has:file`, `has:link`, `has:clip`, `has:document`, `has:todo`, and `has:reaction`;
- `before:`, `after:`, and `on:`;
- `is:thread`, `is:pinned`, `is:saved`, and `is:external`;
- sort by relevance or recency.

Results show matched context and expose thread, channel, project, and resource filters. Resource contents are indexed by their canonical system and joined by authorized references. Channels does not create a second document index.

AI semantic search may augment, but never replace, deterministic filters. Every candidate is authorization-checked before its text or metadata is returned.

### 12.2 Channel browser

Users can browse discoverable channels, search by name, topic, project, and member, preview public channels, and join. Private channels remain undiscoverable unless the user is invited or organization policy explicitly allows a name-only directory.

Default organization channels may be required membership. Ordinary channels support leave. Project channel membership follows the chosen project policy:

- mirrored from project access; or
- project access required, with explicit channel membership layered on top.

The policy is organization-configurable, but a channel may not expose a project to someone without project access.

### 12.3 Sidebar organization

Users may create, rename, reorder, collapse, and delete personal sidebar sections. Moving a conversation changes only that user's navigation. Unreads remain visible through section badges and All Unreads.

System sections for Channels, Direct Messages, and Project Messages remain collapsible and keep aligned headers and trailing controls.

When FirstMate Assistant is enabled, its direct-message conversation is materialized or resolved as a stable default conversation and appears in Direct Messages even before the user sends the first message.

### 12.4 Direct-message discovery and creation

The new-message picker lists all active organization users the actor may message, not only users with an existing conversation. Search covers display name, role, team, and email where policy permits. Suspended, deactivated, and unauthorized external identities are excluded.

Each user is a full-width selectable row:

- clicking anywhere on the row toggles selection;
- keyboard focus plus Space or Enter toggles selection;
- a trailing checkmark communicates selection without being the only click target;
- selected adjacent rows retain a visible gutter and individual boundary;
- one selected user creates or opens a one-to-one DM;
- multiple selected users create or open a group DM after a clear confirmation action.

The UI labels the multi-person result as a group conversation so a checkbox is never the user's only explanation of the behavior. Before creating a duplicate group DM, the service may offer an existing conversation with the exact same active membership while still allowing a new group when policy permits.

## 13. Tabs, folders, and resource cards

### 13.1 Tabs

Tabs are ordered channel-level views. Built-in tab kinds are:

- Messages
- Files
- Photos/Media
- Documents
- To Dos
- Pins
- Links
- Huddle Notes
- Folder
- Workflow

Channel managers can add, remove, rename, and reorder optional tabs. Removing a tab removes the view only; it never deletes resources.

Tabs may be saved filters. For example, a project channel can have "Approved Photos" backed by project media with an `approved` tag, or "Open Install To Dos" backed by canonical action-item filters.

### 13.2 Folders

Folders organize channel resource references. A reference may appear in more than one folder. Folder membership does not alter the resource's canonical folder, project, tag, or lifecycle.

Folders support:

- label, description, icon, and color;
- nested folders up to three levels;
- drag-and-drop ordering;
- permission-aware item counts;
- a shareable channel link.

### 13.3 Resource cards

Cards use canonical metadata and render an appropriate preview:

- image thumbnail and dimensions;
- video duration and processing state;
- document title, type, owner, and modified time;
- To Do status, assignees, priority, and due date;
- project summary;
- safe web-link preview.

Cards expose actions supplied by the canonical system. A document card opens Documents; a To Do card edits the canonical action item; a photo opens the existing media viewer.

### 13.4 Resource picker

The picker is scoped in this order:

1. Current project, for project channels
2. Current channel references
3. Recent authorized resources
4. Search across authorized FirstMate resources

It supports multi-select and clearly distinguishes linking an existing resource from uploading or creating a new one.

## 14. Message-to-To-Do conversion

The "Create To Do" message action opens a compact form prefilled with:

- title derived from the first meaningful line;
- description containing a stable message link and readable excerpt;
- project from the project channel, when applicable;
- suggested assignee from mentions or conversation context;
- source channel, message, and thread;
- optional due date and priority.

On confirmation, Channels calls the canonical action-item API. The action item records a structured source reference such as:

```json
{
  "source_type": "channel_message",
  "channel_id": "chn_...",
  "message_id": "msg_...",
  "thread_root_id": "msg_...",
  "conversation_url": "..."
}
```

The message records a `created_from` reference to the action item and renders a live To Do card. Status, assignee, and due-date changes arrive through work events and update the card in realtime.

Creating a To Do is idempotent for a client operation ID. A user may deliberately create more than one To Do from a message, but retrying a single submission never creates duplicates.

Deleting the message does not delete the To Do. Deleting the To Do leaves a historical unavailable reference on the message.

## 15. Video, audio, and screen clips

### 15.1 Clip types

- Camera video
- Screen recording
- Screen recording with camera overlay
- Audio note

Clips are asynchronous media messages, distinct from live huddles.

### 15.2 Capture flow

1. User selects a capture mode.
2. Browser permission is requested in context.
3. A compact recorder shows source, microphone, camera, duration, pause, restart, and stop.
4. A local preview allows trim, title, caption, and discard.
5. The client uploads through canonical Media using resumable upload.
6. Media processing creates playback variants and a poster frame.
7. Channels sends the message with the media reference.

In a project channel, the clip is project-owned. Elsewhere it is channel-owned. Recordings are never uploaded before the user confirms unless an explicit organization setting enables live recovery chunks; recovery chunks are private, short-lived, and deleted after cancel.

### 15.3 Transcripts and accessibility

When transcription is enabled, the transcript is stored as canonical media metadata or a linked transcript artifact, not only inside the message. Users can search the transcript, correct it if permitted, and generate captions. Assistant summaries cite timestamps and respect access.

### 15.4 Limits and failure handling

- Organization-configurable duration and size limits
- Visible network and processing progress
- Resumable upload
- Local recovery while the tab remains available
- Clear permission fallback
- No silent camera or screen capture
- Browser warning before navigating away from an unsaved recording

## 16. Workflows, apps, and AI

### 16.1 Workflow shortcuts

Channels exposes existing FirstMate workflow capabilities through:

- composer shortcuts;
- message actions;
- tab forms;
- scheduled triggers;
- reaction triggers;
- channel and project events.

Example flows:

- Turn a customer request into a project To Do.
- Request approval for a document or photo.
- Post a project status summary every Monday.
- Notify a channel when a work node changes state.
- Collect a structured field report into a project.

Workflow definitions remain in the existing work/automation system. Channels stores only invocation and presentation references.

### 16.2 Extension model

The internal extension contract supports:

- bot identities;
- commands;
- composer shortcuts;
- message actions;
- workflow steps and triggers;
- channel tabs;
- incoming and outgoing webhooks;
- resource-card renderers.

Every extension declares scopes. Installation and invocation are organization-admin controlled. Webhooks are signed, replay-protected, rate-limited, and redact content outside their scopes.

A public marketplace and arbitrary third-party code hosting are deferred.

### 16.3 FirstMate Assistant

When the AI agents capability is enabled:

- FirstMate Assistant has a stable direct-message conversation.
- Users can ask questions in channels or the Assistant DM.
- Assistant answers may use authorized message history and referenced resources.
- Users can request channel, thread, document, clip, or huddle summaries.
- Catch-up summaries link to the source messages and resources.
- Assistant can propose To Dos and workflow actions, but creation or mutation requires confirmation unless a pre-authorized automation owns the action.
- The Assistant never sees content the requesting user cannot access.

AI-generated summaries are labeled and are not treated as canonical project records until a user saves them into Documents, To Dos, or another system.

## 17. User groups and mentions

Organizations may create named user groups with a handle, description, owners, and members. Groups can be mentioned in permitted conversations.

- A group mention creates attention only for members who can access the conversation.
- Large-group mentions show an audience warning.
- `@channel`, `@here`, and group mentions are permission- and rate-controlled.
- Membership changes affect future notifications, not historical message authorship.
- External participants cannot enumerate internal groups unless the group is explicitly exposed to the shared channel.

## 18. External collaboration

External collaboration has two modes:

- External direct message
- Shared channel

An external identity belongs to a home organization and is represented through a federated membership. Invitations require organization permission and acceptance. Shared-channel records have a home organization responsible for canonical message storage and a federation mapping for participants.

Required controls:

- clear external badges at conversation, member, composer, and resource level;
- restricted resource sharing;
- no implicit project browsing;
- organization-level allow/block lists;
- invitation expiry and revocation;
- content and event delivery contracts with idempotency;
- visible behavior when one organization disables the relationship.

External collaboration should ship after the internal resource and authorization model is stable. It is part of the target capability, but not on the critical path for the first internal release.

## 19. Huddles and live screen sharing

### 19.1 Experience

A huddle starts from a channel or direct message. Joining must take one clear action and open a compact call surface without navigating away from the conversation.

Capabilities:

- audio by default;
- optional camera;
- live screen sharing;
- participant list and speaking state;
- mute, camera, device, and output controls;
- emoji reactions;
- huddle thread for links, messages, and resources;
- picture-in-picture/minimized state;
- device handoff and reconnect;
- invitation to additional eligible conversation members.

The active huddle is visible in the conversation header and sidebar. A huddle cannot silently include users outside the conversation.

### 19.2 Technical shape

Use WebRTC media with an SFU for group reliability. The Channels service owns huddle identity and authorization. A dedicated realtime signaling service issues short-lived join credentials and relays session state. TURN is available for restricted networks.

The signaling layer must not use browser navigation state as call state. Reconnecting clients fetch the authoritative huddle session and participant roster.

### 19.3 Screen sharing

- User chooses a display, window, or browser tab through the browser's native picker.
- A persistent indicator shows what is being shared.
- Only one primary screen share is displayed at a time in the initial release; another participant may request or take over with confirmation.
- System audio is offered only when the browser supports it.
- Screen sharing stops immediately when the user ends it, leaves, loses permission, or is removed.

### 19.4 Recordings, transcript, and notes

Recording is off by default and requires an explicit action. Every participant sees and hears a recording indicator. Organization policy may disable recording.

A recording from a project-channel huddle is project-owned Media. Other huddle recordings are channel-owned Media. The recording, transcript, and generated notes are posted to the huddle thread and appropriate channel tabs.

Generated notes may be saved as a canonical Document. Follow-up items may be confirmed into canonical To Dos.

### 19.5 Huddle history

Starting a huddle creates a system message and stable huddle thread. Ending it updates that message with:

- start and end time;
- participants;
- shared links and resources;
- recording and transcript, if present;
- saved notes and To Dos.

Presence events are ephemeral; the huddle summary is durable.

## 20. Data model

Names below are conceptual. Final migrations should follow existing storage naming and ID conventions.

### 20.1 Message extensions

`channel_messages`

- retain `text` as normalized plain text;
- add `content_json`;
- add `content_schema_version`;
- add `scheduled_message_id`, nullable;
- add `client_operation_id`, nullable and unique within sender scope.

`channel_message_resource_refs`

- `id`
- `organization_id`
- `channel_id`
- `message_id`
- `resource_type`
- `resource_id`
- `relationship` (`attachment`, `shared`, `created_from`, `huddle_output`)
- `created_by`
- `created_at`

This table stores identity and relationship only. Titles, status, thumbnails, and permissions come from the canonical service.

### 20.2 Read and attention state

`channel_read_states`

- `organization_id`
- `channel_id`
- `user_id`
- `read_through_seq`
- `manual_unread_seq`, nullable
- `last_viewed_at`
- `version`
- `updated_at`

`channel_thread_subscriptions`

- `organization_id`
- `channel_id`
- `root_message_id`
- `user_id`
- `following`
- `notify_level`
- `read_through_reply_seq`
- `manual_unread_reply_seq`, nullable
- `version`
- timestamps

`channel_attention_items`

- `id`
- `organization_id`
- `recipient_user_id`
- `kind`
- `channel_id`
- `message_id`, nullable
- `root_message_id`, nullable
- `actor_user_id`, nullable
- `resource_type`, nullable
- `resource_id`, nullable
- `dedupe_key`
- `created_at`

`channel_attention_states`

- `attention_item_id`
- `recipient_user_id`
- `read_at`, nullable
- `cleared_at`, nullable
- `snoozed_until`, nullable
- `version`

### 20.3 Drafts, schedules, and reminders

`channel_drafts`

- user and organization
- channel and optional thread root
- content JSON and plain text
- pending resource references
- revision
- tombstone state
- timestamps

`channel_scheduled_messages`

- sender, channel, and optional thread root
- content and resource references
- scheduled time and time zone
- state (`scheduled`, `sending`, `sent`, `failed`, `cancelled`)
- failure reason
- resulting message ID
- client operation ID
- timestamps

Message reminders use canonical action items with source type `channel_reminder`, private visibility, source message reference, and due time. Channels does not add a parallel reminder scheduler.

### 20.4 Tabs, folders, and resources

`channel_tabs`

- channel
- kind
- label
- configuration JSON containing validated canonical filters
- position
- created by
- visibility
- timestamps

`channel_resource_folders`

- channel
- parent folder, nullable
- label, description, icon, color
- position
- timestamps

`channel_resource_refs`

- organization and channel
- resource type and canonical resource ID
- folder, nullable
- source message, nullable
- added by
- display note, nullable
- position
- timestamps

The unique constraint is channel, resource type, resource ID, and folder. A project resource may appear automatically in a built-in tab without a row in this table. Rows are needed for curated folder placement, pins, non-project references, and message provenance.

### 20.5 Sidebar and preferences

`channel_sidebar_sections`

- user
- label
- position
- collapsed
- timestamps

`channel_sidebar_items`

- user
- section
- channel
- position

Notification preferences extend existing user settings and permit per-channel overrides.

### 20.6 Huddles

`channel_huddles`

- organization and channel
- thread root message
- state (`starting`, `active`, `ended`, `failed`)
- started by, started at, ended at
- media-region/session reference
- recording policy and recording media reference
- transcript resource reference
- notes document reference

`channel_huddle_participants`

- huddle
- user or federated identity
- joined at, left at
- last connection state
- role

`channel_huddle_events`

- huddle
- event type
- actor
- sanitized payload
- event time

High-frequency speaking and network telemetry is ephemeral and must not be written as durable event rows.

## 21. Service boundaries

```text
Channels UI
  |
  +-- Channels API -------- messages, reads, activity, tabs, refs, huddles
  +-- Resource gateway ---- permission-checked card resolution
  |     +-- Projects
  |     +-- Media / Photos
  |     +-- Documents
  |     +-- To Dos / Work
  +-- Realtime ------------ messages, reads, work updates, huddle state
  +-- Search gateway ------ message index + canonical resource indexes
  +-- Huddle signaling ---- short-lived WebRTC session credentials
```

The resource gateway is an adapter layer, not a data warehouse. It batches canonical reads, normalizes card shapes, and enforces authorization. It must not cache sensitive resource data beyond a short request or permission-aware cache lifetime.

Work-event subscriptions update live cards without copying the entire canonical record into Channels.

## 22. API surface

Exact response envelopes should follow existing v1 conventions.

### 22.1 Attention and reads

- `GET /v1/channels/organizations/:orgId/unreads`
- `POST /v1/channels/organizations/:orgId/channels/:channelId/read`
- `POST /v1/channels/organizations/:orgId/channels/:channelId/unread`
- `POST /v1/channels/organizations/:orgId/read-all`
- `POST /v1/channels/organizations/:orgId/read-operations/:operationId/undo`
- `GET /v1/channels/organizations/:orgId/activity`
- `PATCH /v1/channels/organizations/:orgId/activity/:itemId`
- `GET /v1/channels/organizations/:orgId/threads`
- `PUT /v1/channels/organizations/:orgId/threads/:rootMessageId/subscription`
- `POST /v1/channels/organizations/:orgId/threads/:rootMessageId/read`

All mutations accept a client operation ID and return the resulting version.

### 22.2 Messages

- Existing create-message endpoint accepts structured content and resource references.
- `GET|PUT|DELETE /v1/channels/organizations/:orgId/drafts/:draftKey`
- `GET|POST /v1/channels/organizations/:orgId/scheduled-messages`
- `PATCH|DELETE /v1/channels/organizations/:orgId/scheduled-messages/:id`
- `POST /v1/channels/organizations/:orgId/messages/:messageId/reminders`
- `POST /v1/channels/organizations/:orgId/messages/:messageId/forward`
- `POST /v1/channels/organizations/:orgId/messages/:messageId/action-items`

### 22.3 Resources

- `GET|POST /v1/channels/organizations/:orgId/channels/:channelId/tabs`
- `PATCH|DELETE /v1/channels/organizations/:orgId/channels/:channelId/tabs/:tabId`
- `GET|POST /v1/channels/organizations/:orgId/channels/:channelId/folders`
- `PATCH|DELETE /v1/channels/organizations/:orgId/channels/:channelId/folders/:folderId`
- `GET|POST /v1/channels/organizations/:orgId/channels/:channelId/resources`
- `DELETE /v1/channels/organizations/:orgId/channels/:channelId/resources/:refId`
- `POST /v1/channels/organizations/:orgId/channels/:channelId/resources/resolve`

Upload initiation and binary delivery continue to use Platform Media APIs. Document and To Do creation continue to use their canonical APIs, with Channels passing context and then creating references.

### 22.4 Search

- `GET /v1/channels/organizations/:orgId/search`
- `GET /v1/channels/organizations/:orgId/search/suggestions`

Search cursors are opaque and stable for a single query. Results state their source type and provide a canonical open action.

### 22.5 Huddles

- `POST /v1/channels/organizations/:orgId/channels/:channelId/huddles`
- `GET /v1/channels/organizations/:orgId/huddles/:huddleId`
- `POST /v1/channels/organizations/:orgId/huddles/:huddleId/join`
- `POST /v1/channels/organizations/:orgId/huddles/:huddleId/leave`
- `POST /v1/channels/organizations/:orgId/huddles/:huddleId/end`
- `POST /v1/channels/organizations/:orgId/huddles/:huddleId/recording`

Join returns short-lived signaling and media credentials, never permanent secrets.

## 23. Realtime events

New event families:

- `channels.read_state.updated`
- `channels.thread_subscription.updated`
- `channels.attention.created`
- `channels.attention.updated`
- `channels.draft.updated`
- `channels.scheduled.sent`
- `channels.scheduled.failed`
- `channels.resource.added`
- `channels.resource.removed`
- `channels.tab.updated`
- `channels.huddle.started`
- `channels.huddle.updated`
- `channels.huddle.ended`
- `channels.huddle.participant_updated`

Canonical `media.*`, `document.*`, and work/action-item events remain canonical. The client invalidates or updates visible resource cards from those events.

Every durable event includes organization, entity ID, version, event ID, and occurred-at time. Consumers must be idempotent.

## 24. Navigation contract

All navigation uses `Portal.navigation` as required by the portal contract.

Register route state for:

- `tab=channels`
- `channelsView=home|unreads|activity|threads|later|browse`
- `channel=<channelId>`
- `channelTab=<tabIdOrKind>`
- `channelThread=<rootMessageId>`
- `channelMessage=<messageId>`
- `channelResource=<type:id>`
- `huddle=<huddleId>`

Opening a conversation, thread, resource detail, or huddle uses `Portal.navigation.push()`. Search filters, result sort, tab filters, and density use `replace()`. Transient menus, composer formatting, selected uploads, recording permission prompts, and call controls never enter browser history.

Handlers render routed chrome synchronously, load remote data afterward, remain idempotent, and do not write history while navigation restoration is applying.

## 25. Keyboard and accessibility specification

Shortcuts must be registered through a shared command registry, displayed in a shortcut reference, remappable where practical, and suppressed while incompatible editable controls have focus.

| Action | Default shortcut |
| --- | --- |
| Quick switcher | `Ctrl/Cmd+K` |
| Search | `Ctrl/Cmd+G` |
| All Unreads | `Ctrl/Cmd+Shift+A` |
| Threads | `Ctrl/Cmd+Shift+T` |
| Activity | `Ctrl/Cmd+Shift+M` |
| Next unread conversation | `Alt/Option+Shift+Down` |
| Previous unread conversation | `Alt/Option+Shift+Up` |
| Mark current conversation read | `Esc` when composer is not expanded |
| Mark all read | `Shift+Esc`, with undo |
| Mark focused message unread | `Alt/Option+click` or message command |
| Focus composer | `C` outside an editor |
| Send | User preference: `Enter` or `Ctrl/Cmd+Enter` |
| New line | Complement of the send preference |
| Edit last own message | `Up Arrow` in an empty composer |
| Open focused message thread | `R` |
| React to focused message | `E` |
| Save focused message | `S` |
| Open shortcut reference | `Ctrl/Cmd+/` |

Before implementation, audit portal-wide collisions. Where an operating system or browser reserves a shortcut, the command registry must expose a usable alternative.

Accessibility requirements:

- Complete operation without a pointer
- Logical roving focus through sidebar, messages, tabs, resource grids, and huddle controls
- Visible focus treatment
- Semantic headings and landmarks
- Screen-reader labels for unread counts, reaction counts, external status, upload state, and call controls
- Live announcements for new messages only when appropriate, avoiding noisy replay
- Captions and transcripts for recorded media when available
- No color-only unread, mention, recording, or mute indicators
- Reduced-motion behavior
- Minimum target size for row selectors and huddle controls

## 26. Capability and rollout model

Use staged organization capabilities under the existing Channels parent capability:

- `apps.channels`
- `apps.channels.injected`
- `channels.attention_v2`
- `channels.rich_messages`
- `channels.scheduled_messages`
- `channels.resources`
- `channels.clips`
- `channels.workflows`
- `channels.ai`
- `channels.external`
- `channels.huddles`
- `channels.recording`

Rules:

- Capability bootstrap completes before app registry and sidebar construction.
- Disabled apps are not mounted and their bundles/data are not eagerly requested.
- The API enforces every material capability; UI hiding is not authorization.
- The Settings UI reads and writes the same canonical capability keys.
- Capability changes publish a realtime invalidation and have a deterministic refresh path.
- Parent-off always wins over child-on.
- Unknown or unavailable capability state fails closed for optional apps during initial load.

## 27. Migration and compatibility

### 27.1 Additive migrations

All storage changes are additive until the new clients are proven. Existing plain-text messages remain readable.

Backfills:

- convert existing text messages to a minimal structured paragraph representation;
- migrate current read cursors into `read_through_seq`;
- build thread subscriptions for roots the user authored, replied to, or was mentioned in within the supported retention window;
- create resource-reference rows for existing message attachments;
- preserve IDs and timestamps;
- establish stable FirstMate Assistant DMs for eligible users.

### 27.2 Project attachment correction

Existing attachments uploaded in project-message channels may currently be channel-owned. A migration must:

1. resolve the channel's project;
2. verify the media is not already owned by another canonical scope;
3. add the project association and correct canonical owner metadata where safe;
4. preserve media and message IDs;
5. report conflicts rather than duplicating bytes.

Future project-channel uploads must be project-owned at creation.

### 27.3 Client compatibility

During rollout:

- old clients render structured messages from the plain-text fallback;
- new clients accept old text-only messages;
- read-state v2 maintains the legacy summary fields until all consumers migrate;
- new resource cards include a safe link and fallback label;
- huddle messages are ordinary system messages to clients without huddle support.

## 28. Performance and reliability

Targets at normal organization scale:

- Cached Channels shell visible in under 1 second on a warm load.
- No disabled application content appears during bootstrap.
- Initial conversation metadata and first message page p95 under 800 ms server time.
- Sending an ordinary text message acknowledged p95 under 500 ms excluding network transit.
- Realtime message fan-out visible to connected peers p95 under 1 second.
- Read-state update p95 under 500 ms and safe to retry.
- Activity and All Unreads first page p95 under 1 second.
- Resource tabs batch-resolve cards without one request per card.
- Search first page p95 under 1.5 seconds for ordinary organizations.
- A clip upload can resume after a transient connection loss.
- Huddle join reaches connected audio p95 under 5 seconds on supported networks.
- Huddle reconnection begins automatically and preserves the thread/session identity.

Pagination is required for messages, activity, threads, resources, search, and channel browsing. List endpoints must have bounded defaults and maximums.

## 29. Security and privacy

- Server-side organization, membership, capability, and resource authorization on every endpoint
- Short-lived signed upload and huddle credentials
- Content sanitization for structured messages and link previews
- Malware scanning and media processing through canonical Media
- No thumbnail, transcript, filename, or title leaks for unauthorized resources
- Rate limits for messaging, mentions, invitations, webhooks, search, and huddle creation
- Idempotency for all retryable mutations
- External-conversation badges and explicit sharing confirmation
- Recording consent indicator and organization recording policy
- Secrets excluded from message bodies, webhook logs, and huddle event payloads
- Baseline security events for permission and membership changes, without building the deferred enterprise audit product

## 30. Testing strategy

### 30.1 Contract and unit tests

- Rich-content validation, sanitization, and plain-text normalization
- Read-boundary and manual-unread algorithms
- Thread auto-follow rules
- Notification preference precedence
- Activity deduplication
- Resource-scope resolution
- Message-to-To-Do idempotency
- Project upload ownership
- Capability parent/child behavior
- Navigation contract keys and history behavior
- Shortcut conflict and editable-focus suppression

### 30.2 API integration tests

- Every endpoint rejects cross-organization access
- Project resources require project access
- Private and external channel membership changes take effect immediately
- Disabled capabilities reject API use
- Scheduled delivery revalidates membership and resources
- Message deletion does not delete canonical resources
- To Do and Document mutations are visible through their canonical APIs
- Existing attachment migration preserves IDs

### 30.3 Realtime tests

- Cross-device read reconciliation
- Offline draft conflict resolution
- Message, reaction, activity, resource, and work-event fan-out
- Reconnect replay without duplicates
- Huddle roster and lifecycle recovery

### 30.4 Browser end-to-end tests

- No app flash when a capability is off
- Viewport-based read behavior
- Mark unread and bulk-read undo
- All Unreads and Threads reply flows
- Draft resume on another client
- Schedule, edit, cancel, and failed delivery
- Project media appears in both Channels and project Media without duplication
- Existing Document attachment and access loss
- Create To Do from message and update it from To Dos
- Record and post camera, screen, and audio clips
- Start, join, share screen, reconnect, and end a huddle
- Back/forward restoration for channel, tab, thread, resource, and huddle routes
- Full keyboard-only happy path

### 30.5 Accessibility and network tests

- Automated accessibility checks plus manual screen-reader coverage
- 200 percent zoom and narrow viewport
- Reduced motion and high contrast
- Slow, intermittent, and offline transitions
- Denied camera, microphone, notification, and screen-capture permissions
- TURN-only huddle connectivity

## 31. Implementation sequence

### Milestone 0: foundations

- Finalize schemas and capability definitions.
- Correct capability bootstrap so disabled apps never mount.
- Add navigation schemas and command registry.
- Add resource gateway interfaces and canonical authorization adapters.
- Add telemetry for errors, latency, unread drift, and resource-resolution failures.

### Milestone 1: attention

- Read state v2 and viewport observer.
- Mark unread, mark read, bulk read, and undo.
- Durable Activity.
- Thread subscriptions and Threads view.
- Notification preferences and DND.
- All Unreads.

This milestone should ship behind `channels.attention_v2` and run shadow comparisons against legacy unread counts before cutover.

### Milestone 2: composing and finding

- Structured messages and fallback text.
- Composer, drafts, scheduling, reminders, forwarding, and links.
- Advanced search.
- Channel browser and custom sidebar sections.
- Direct-message discovery and group-DM creation.
- Keyboard and accessibility completion for all Release A flows.

### Milestone 3: project-aware resources

- Resource references, tabs, folders, and picker.
- Project Media/Photos adapter.
- Project Documents adapter.
- Project To Dos adapter.
- Correct project-channel upload ownership.
- Message-to-To-Do conversion.
- Work-event live cards.

This milestone is complete only when a resource created through a project channel appears in its native project app without copying or reconciliation.

### Milestone 4: clips, workflows, and assistant

- Video, screen, and audio clips.
- Transcript and clip search.
- Workflow shortcuts, message actions, tabs, and event triggers.
- User groups.
- Assistant DM, summaries, recaps, and confirmed actions.
- Internal bot and webhook contracts.

### Milestone 5: huddles

- Signaling, SFU/TURN integration, and session authorization.
- Audio huddles, camera, screen sharing, thread, reactions, and reconnect.
- Optional recordings, transcripts, notes, and To Do follow-up.
- Load, network, permission, and device testing.

### Milestone 6: external collaboration

- Federated identity and invitation lifecycle.
- External DMs and shared channels.
- Restricted resource-sharing flows.
- Federation delivery, revocation, and failure behavior.

External collaboration is last because it depends on correct resource authorization, attention, and message delivery contracts.

## 32. Acceptance criteria

The update is ready when all of the following are true:

1. A disabled app or Channels injection does not render, flash, mount, or request app data during refresh.
2. Unread counts include the appropriate followed-thread replies and agree across two active clients after reconciliation.
3. Loading a message without viewing it does not mark it read.
4. Users can mark unread from a message, mark all read, and undo the bulk operation.
5. Activity retains mentions, replies, reactions, assignments, workflow prompts, and missed huddles for the configured retention period.
6. Drafts, scheduled messages, notification settings, and followed threads sync across devices.
7. Users can create and search rich messages while older messages and clients retain a readable fallback.
8. A project-channel upload creates one project-owned Media record and one or more references, never a duplicate Channels blob.
9. Existing authorized project Media, Photos, Documents, and To Dos are visible from the project channel.
10. Removing access to a canonical resource removes its preview and content from Channels immediately.
11. Creating a To Do from a message creates one canonical action item with a bidirectional source reference.
12. Users can arrange tabs and folders without moving or deleting canonical resources.
13. Camera, screen, and audio clips survive transient upload failure and appear in the correct canonical scope.
14. Users can start and join a huddle, share a screen, use the huddle thread, reconnect, and end the session.
15. Huddle recordings require visible consent state and are stored in the correct canonical Media scope.
16. Every primary Release A and Release B flow is operable by keyboard and screen reader.
17. Channel, tab, thread, resource, and huddle URLs restore correctly with browser Back and Forward.
18. Server tests prove that UI feature hiding cannot bypass capability or authorization checks.

## 33. Definition of done

Each milestone requires:

- approved additive migrations and rollback strategy;
- API and realtime contracts documented;
- server authorization and capability enforcement;
- unit, integration, navigation-contract, and browser tests;
- accessibility review;
- performance measurements against the stated targets;
- empty, loading, offline, error, and permission-denied states;
- product telemetry sufficient to detect failures without capturing message content;
- user-facing Settings and shortcut documentation;
- removal or explicit deprecation plan for superseded legacy paths.

The whole initiative is complete when Channels works as the collaboration layer over FirstMate's existing project systems, supports reliable async and lightweight live work, and does so without creating a second source of truth for files, media, documents, or tasks.
