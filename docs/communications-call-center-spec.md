# Unified Communications and Call Center

Status: proposed implementation specification. Prepared September 4, 2026, from the current local working tree (base commit `df139a5c`, with substantial existing uncommitted work).

This document specifies the product, UI, backend, integrations, migration, and release criteria. It does not claim that VoIP has been provisioned or that the proposed features are implemented. The review covered the app manifest and runtime architecture, the communication and call paths in depth, the shared Work/scope/agent infrastructure, and integration points across the app families. It was not an exhaustive audit of every file or a production security test. Local browser inspection covered Calls, its call workspace, Communications, and project Comms; available inbox fixtures were empty.

## 1. Product decision

Make **Communications** the central customer communication application. It contains **Inbox, Call lists, Follow-ups, and Call history**. When business calling is enabled, add **Call center** for incoming queues and team availability. A persistent call workspace is available from anywhere in FirstMate.

Keep Call lists as an independently mountable app within that product. Preserve existing lists, their configurations, assignments, automation connections, and a board view. Allow users to pin a **Call lists** shortcut in their app navigation. That shortcut opens the same app and data as Communications → Call lists; it does not maintain a separate workflow.

Calls work in two primary modes:

| Mode | Experience | Automatic evidence |
| --- | --- | --- |
| External phone | Open the shared workspace, call with the user's existing phone, take notes, follow a script, record the outcome, schedule work | Only facts the user enters; opening a `tel:` link does not prove dialing, connection, duration, or completion |
| FirstMate phone, optional | Make and receive business calls in the browser through Telnyx, with routing, call controls, recording policy, and AI assistance | Provider call events, duration, quality, and permitted recordings/transcripts |

Offer **Call my phone** as a later voice-enabled mode: Telnyx calls a verified staff number and bridges it to the customer. It still incurs provider usage and follows voice policies. It can help staff whose browser audio is unreliable; it is not equivalent to an untracked external call.

Keep **Channels** as the internal team collaboration app. Project messages and team huddles remain there. They can reference customer calls with permission-aware cards. Internal room calls and customer telephone calls share presentation primitives where useful, but keep separate media adapters and access rules.

## 2. Current state and specific repairs

The important architectural split is between CRM queue entries, customer communications messages, internal Channels notes, and internal call rooms.

| Finding from the working tree | Consequence | Required repair |
| --- | --- | --- |
| Calls UI links to `tel:` and posts dispositions to `/v1/internal/crm`; it does not use the internal calls service | It is a manual call workflow, not an operational browser dialer | Preserve manual operation and introduce a distinct business telephony adapter |
| Call notes are Channels messages tagged `call_note`; Communications reads the messaging store | A customer call can appear in project notes without appearing in project Comms | Add canonical call activity and aggregate it into both global and project Communications |
| A blank note produces no Channels call-note message | A call can have an outcome but no visible narrative record | Every actual attempt gets a call record, even without notes or recording |
| Skip posts `disposition: skipped` to the completion endpoint | An ordinary entry can complete its linked Work node; a follow-up can instead fail for missing outcome | Make Skip a session action. Completing or canceling work requires a separate explicit action |
| The client accepts arbitrary per-list disposition settings; the server accepts four hardcoded dispositions | Configuration can promise a workflow the backend rejects | One server-validated outcome schema, with stable system actions and configurable labels/custom business outcomes |
| Frontend quick options can come from list settings, while cadence calculation uses branch follow-up configuration | Per-list retry configuration is not consistently authoritative | Resolve policy once on the server, return both allowed actions and suggested dates |
| Disposition processing writes a random-ID note before follow-up resolution and later updates the entry and emits work events | Failed/retried saves can leave duplicate notes, successor tasks, or incomplete state | Durable idempotent wrap-up operation with resumable effects |
| Entry upsert resets `result_json`, and an entry contains only one current result | Reopening/reusing an entry cannot serve as an immutable attempt history | Store call attempts separately; queue entries link to them |
| List assignment filters use caller-supplied user/role information; these CRM handlers lack the explicit platform auth/CSRF calls used by Comms | The current route cannot be treated as a secure multi-tenant call-center boundary | Authenticate migrated endpoints and legacy adapters; derive viewer and actor server-side. Verify deployment exposure separately |
| Follow-up projection scans org projects and open nodes when the queue is requested, uses server-local calendar calculations, and does not filter `metadata.follow_up.channel` | Expensive reads, timezone inconsistencies, and non-call follow-ups can enter a call queue | Incremental projection; explicit branch/customer timezone and channel eligibility |
| Lists expose a singular `work_node_id`, while current automation defaults deduplicate by project/list | Parallel scope obligations can overwrite the source reference | Keep one calling intent if desired, but retain many source obligations and complete only explicitly satisfied ones |
| Contact matching chooses the most recently updated matching project | Repeat customers and shared phone numbers can be linked to the wrong job | Return candidate matches and make ambiguity visible |
| Global Inbox's Mine/Unclaimed filters explicitly omit email and SMS | The same controls mean different things across channels | Introduce common assignment/read/workflow metadata across communication types |
| Global email/SMS loading errors can become an empty array; header presence represents live chat | An outage can look like an empty inbox or a company-wide Offline status | Independent channel health, retryable errors, and retained last-known content |
| Inbox/feed reads use bounded recent-message lists and per-conversation lookups | Counts/history can look complete when they are truncated; large inboxes become slow | Cursor pagination, independent aggregate counts, indexed latest-activity projection |
| Current SMS deactivation deletes the owned number | Reusing that number for voice would couple two service lifecycles dangerously | Shared number ownership with separate SMS and voice bindings before voice activation |

Browser observations: Project Comms devoted a large permanent column to settings, leaving the actual communication area cramped. An initial screenshot was cropped; its apparent right-edge cutoff is not a confirmed application overflow bug. The Call-card Open project action did not open a project in the first inspected flow; opening the same project from My Projects did. Track that as a reproduced local navigation symptom, with its loading/host cause to be determined in implementation.

## 3. Functionality that must survive

The redesign must preserve these capabilities before replacing existing surfaces:

| Existing capability | New home / preservation rule |
| --- | --- |
| Organization-defined call lists, names, icons, ordering, active/archive state, team assignments | Communications → Call lists; full editor remains available |
| Scope-created and automation-created entries; source keys; reactivation | Same trusted automation interfaces, routed through the new service |
| Board columns, Start list, start specific contact, notes, previous/next | Board view plus table view; reusable call-list runner |
| External-phone calling, SMS from the call workspace, message templates | Available without buying VoIP; same sender/readiness/consent checks |
| Dispositions, follow-up cadence, quick dates, calendar appointment scheduling | Unified wrap-up and shared Work/scheduling actions |
| Global and project email, SMS, and web/portal chat | Same native threads, participants, recipients, delivery history, and replies |
| Email subjects, CC/BCC, HTML rendering protections, attachments where supported, threading | Preserve channel-specific composer behavior and thread identities |
| Audio notes, SMS audio attachments, email dictation, web-chat audio modes | Preserve existing settings; distinguish these from telephone recording |
| Web-chat claim/handoff, viewers, typing, close/reopen, suggestions, page context, online status | Keep chat behavior and generalize applicable workflow metadata to other channels |
| Search, templates, AI conversations, auto-reply drafts and approved auto-send settings | Same agent framework and settings, with permission-aware call sources added |
| Notification targeting, forwarding, project AI instructions and overrides | Move configuration into a settings drawer, retaining inheritance semantics |
| Test/capture mode, simulation, SMS setup/consent/usage accounting | Continue behind appropriate environment and admin gates |
| Project notes and internal team calls | Keep Channels history, permissions, recordings, and room behavior intact |

The email/SMS transports must not be replaced to accomplish this redesign. A unified UI does not require forcing emails, chat messages, phone legs, and internal notes into the same database row type.

## 4. Navigation and primary UI

### Communications shell

Use the existing FirstMate typography, brand accent, spacing tokens, and embeddable app runtime. Reduce tiny labels, heavy card borders, all-caps microcopy, and oversized empty areas. Primary text should be about 14px, supporting text 12–13px, and touch targets at least 44px. Use neutral surfaces and reserve status colors for meaningful states with text labels.

The header contains the page title, unified search, **New** (message, call, call log, follow-up), and personal phone availability when enabled. Main views:

1. **Inbox** — customer conversations needing attention. Filters: Mine, Unassigned, Team, All; Open, Snoozed, Resolved; channel; branch; owner. Unread is personal read state, not a synonym for Open.
2. **Call lists** — the existing operational lists. Start in the last used board/table view. Preserve a Calls-only user's board preference during migration.
3. **Follow-ups** — all authorized communication tasks, with Overdue, Today, Upcoming, and Unscheduled. Filter by channel and owner.
4. **Call history** — searchable inbound, outbound, and manually logged attempts, voicemail, and outcomes. Filters include owner, list, contact, project, business line, result, date, and recording availability.
5. **Call center**, only with voice/team permissions — waiting inbound calls, active calls, callbacks, availability, and routing health. A single-person organization sees a compact version.

Settings are reached from the existing company settings host or a contextual settings drawer. Keep setup, AI configuration, and notification editing out of the default conversation reading area.

### Inbox layout

At wide desktop widths, use a 280–320px conversation list, flexible timeline, and a collapsible 280–320px context drawer. At approximately 1,024px, default the context drawer closed. At narrow widths, show one panel at a time with explicit back navigation. Respect the host's available width, including project modals; do not calculate layout only from the browser viewport.

Each list row shows customer/number, project if linked, channel, latest meaningful preview, time, owner, and unread/needs-action state. Missed calls and voicemail are first-class entries. Batch events from one phone attempt into one call card instead of showing every ringing/bridge/recording event as a separate conversation.

Opening an item shows its native conversation. **Related activity** exposes other authorized communication with that contact/project. Do not automatically merge separate email subjects, SMS participant groups, or unrelated projects just because a phone number matches.

The timeline includes compact call cards: direction, person, time, connected duration or manual label, human disposition, note/summary, next action, and recording/transcript when available. An unanswered call still has a card. A received voicemail is an artifact of the incoming call and produces one follow-up obligation, not a second apparent call.

The composer explicitly chooses **Text / Email / Chat / Internal note** where supported and displays recipients and sender. Internal notes have a distinct visual treatment and never pass through an outbound message transport. Switching channels preserves drafts. Closing a conversation does not complete its outstanding callback; completing a callback does not silently resolve every conversation.

### Call lists

Table columns: contact, project/reason, next due, owner/team, last attempt, attempt count, status, and primary action. Board view uses the same entry model. Support search, sorting, saved personal filters, user/role assignments, list archive, and bulk reassignment/snooze with eligibility checks. Keep dynamic lists defined by scope/automation rules and manual lists; show why each item is present.

Show blocked entries with a reason (missing number, do-not-call, unavailable project, outside permitted hours, or another agent working it), rather than silently dropping them. Separate **Ready now** from **Later today**. Default Start list selects only eligible ready entries.

Start list creates a resumable work session, not an automatic outbound dial. The runner selects and claims one entry, shows context and script, and waits for an explicit Call action. **Skip for now** releases the claim and advances within this session without logging an attempt or completing a task. **Snooze** changes the task's due date. **Remove from list** and **Cancel task** are separate actions with a reason and clear effects.

After each attempt, **Save & next** persists wrap-up before advancing. Previous opens prior entries/history without allowing a second accidental submission. Progress distinguishes completed, skipped this session, blocked, and remaining. On restart it is restored from server state, not an in-memory Set.

### Project and contact surfaces

Project **Comms** uses the same timeline components scoped to `project_id`, with Activity, Email, Texts, Calls, and Chat filters as enabled. It shows recent communications and next follow-up first. Phone/email/contact chips and **Call / Message / Follow up** actions stay near the heading. Notification and AI overrides move behind Settings.

A compact Calls view is useful inside project Comms, but a second project-level Calls tab is unnecessary. Project Overview can show the last customer contact and next callback. Contact detail shows communication across that contact's projects, subject to access, and requires a project choice when context is ambiguous. Contacts with no project can still be called, messaged, and assigned a follow-up.

## 5. Persistent call workspace

The active telephone session is owned by an ambient/service app mounted once per signed-in organization session. Page views subscribe to it. Navigating to Scheduling, a document, a project, or another tab must not disconnect media or discard a draft.

Expanded workspace:

- Header: customer, selected number, business caller ID, project/reason, connection state, elapsed connected time, and recording/transcription state.
- Main area: script and structured answers, editable notes, and recent relevant communication. Avoid a mandatory three-column layout in a narrow modal.
- Context drawer: contact/project details, selected scope, appointment availability, documents, existing tasks, and permitted quick actions.
- Stable controls: mute, hold/resume, keypad, audio devices, transfer, add participant when supported, recording controls when permitted, minimize, and End call. Destructive and frequently used controls remain visually distinct.
- Bottom work area: proposed next action and draft/save status. Keep call controls visible when notes or script content scroll.

Minimizing produces a compact call bar with person, state, timer, mute, restore, and hang up. Closing a project never hangs up. Closing expanded call UI minimizes it; End call is explicit. Tab close/refresh gets a browser unload warning while media is active, with the limitation that browsers can still terminate unexpectedly. Recover draft and server session on return; do not promise uninterrupted media after a full browser restart.

Incoming calls use a compact panel across the app showing caller, dialed business line/queue, match candidates, and Accept/Decline. Do not automatically interrupt typing or accept audio. If another customer or team call owns the microphone, show busy and route the new call according to policy. Start with one active customer call per person; a consultation leg is part of that session, not permission for unrelated parallel calls.

External mode uses the same script, notes, actions, and wrap-up. It shows **Use my phone** and **Log result** without fake live state, a fabricated timer, recording controls, or an implied transcript. After-call dictation is explicitly labeled the employee's recollection.

## 6. Scripts, outcomes, and actions during calls

Scripts are versioned organization resources with optional branch, list, scope-template, language, and call-purpose defaults. A script has an opening, required disclosures where applicable, talking points, conditional sections, typed questions, objection guidance, and closing/next actions. Reuse document/checklist primitives where their semantics fit; do not make every call generate a full project document.

Store the script version and answer snapshot on the attempt. Editing a script does not rewrite prior calls. A caller can switch script while retaining existing answers with their original version references. Prefill only fields supported by current authorized project data; show missing values instead of inventing them. Draft scripts can be previewed in settings; only published versions are defaults.

Business outcomes and transport outcomes are separate. A provider can report answered without a human conversation; voicemail systems also answer calls. Suggested human results: reached person, left voicemail, no answer, busy, invalid/wrong number, customer requested callback, do not call, and technical failure. Organizations may rename or add business outcomes mapped to validated actions.

Wrap-up actions:

| Action | Durable result |
| --- | --- |
| Complete this obligation | Complete only the linked source work selected by policy/user |
| Follow up | Create or reschedule a Work node with channel, owner, due date/time, purpose, and source call |
| Schedule appointment | Use existing availability, validation, reservation where available, and commit services; retain returned appointment ID |
| Send text/email | Open the existing composer/template with recipients and project context; actual send creates its own delivery record |
| Create project task / checklist item | Use Work/checklist APIs with ownership and source-call provenance |
| Open/share proposal, document, invoice, or payment link | Use the owning app and its permissions; creating or sending is a distinct confirmed product action |
| Correct contact / link project | Audited relationship or field update, with ambiguity resolved by a person |
| Mark lead lost | Show the affected sales scope/pipeline and reason; invoke existing lifecycle behavior deliberately |
| Do not call | Persist number/contact voice suppression and remove eligible pending outbound work; keep history |

Fix the sales-specific assumption in follow-ups: a materials callback, warranty call, or billing question must not be completed merely because any sales appointment exists on the project. Completion predicates reference a specific obligation and relevant appointment/event. An appointment boolean supplied by the client is not authoritative evidence.

## 7. Follow-up semantics

Continue using Work nodes as the single task authority. Enrich `metadata.follow_up` with contact, endpoint, communication/call source, purpose, cadence/version, current step, preferred timezone, and cancellation reason. Support contact-only follow-ups without inventing a placeholder project. All views use the same node ID and completion service.

Persist date-only obligations as a calendar date plus IANA timezone; timed obligations as an absolute UTC timestamp plus scheduling timezone. A date-only task means due that day, not due at midnight. Display the customer's local time next to a phone number when known, otherwise branch time with an explicit label. Never silently infer a reliable timezone from an area code alone. Test DST changes and month-end intervals.

Resolve defaults in this order: organization policy constraints → branch defaults → published list/purpose cadence → allowed user adjustment. Organization restrictions always win. Show the server's suggested next date and why. Existing repeat-last cadences migrate unchanged, with their repeat behavior visible; add attempt limits, permitted contact hours, business-day options, pause/stop rules, and an optional maximum cadence duration for newly configured policies.

Call-list projection includes only call-channel follow-ups eligible for that list, branch, assignment, status, and due window. Pending/blocked work does not become actionable just because it has a date. Upcoming work remains visible in Follow-ups but outside Ready now.

Meaningful inbound replies/calls can pause the related outbound cadence while the owner reviews. Do not cancel every task for that contact. Explicit appointment, payment, signature, customer opt-out, project loss, and task-completion events affect only matching purposes/source obligations. Two automations requesting the same callback converge by a stable business key. A genuine second purpose remains separate.

Use per-entry claims with expiry/heartbeat and a revision check. Also detect concurrent attempts to the same normalized customer endpoint across lists. Recheck eligibility immediately before dialing and before applying the business outcome. A claim can expire if a caller disappears, but an active provider session prevents another agent from silently redialing that endpoint.

## 8. Integration map for the platform

Use one shared communication action contract and reference the owning entity. Integrations add context; they do not copy notes or mutate another app's private state.

| App family | Integration and example | Ownership boundary |
| --- | --- | --- |
| Projects / project-request / Overview | Call/message primary or chosen contact, view last contact and next callback, show calls in Comms | Project host supplies identity and navigation; Communications renders the workspace |
| Contacts / CRM / lead intake | Contact timeline, call without project, inbound unknown-number triage, create/link lead after review | Contacts own person and endpoint data; CRM owns acquisition metadata |
| Sales / Today / Scheduling | Work the day's calls, prepare from prior interactions, book an appointment during the call, attach its ID | Work owns follow-ups; scheduling owns availability and booking |
| Canvassing | A recorded visit can create a consent-aware requested callback, carrying territory/visit context | Do not automatically telephone imported or visited leads just because a number exists |
| Crew / field work | Call authorized customer or office from the visit, log operational results, dictate an after-call note | Project/visit access still limits contact visibility; employee calls retain their audience |
| Scopes / automations / checklists | New-lead, welcome, pre-start, delivery, completion, and warranty call obligations | Preserve `crm.callLists.add.v1` / remove adapters and explicit Work transitions |
| Proposals / signatures / documents | Discuss the specific version, open it in context, send a link, create follow-up on expiration | AI does not sign, approve pricing, or mark a document accepted from a transcript |
| Money / invoices / payments / receipts / financials | Invoice-question call linked to invoice/project; send secure payment link; callback stops on matching settlement | Payment truth remains in Payments; avoid collecting payment-card data in call recordings |
| Materials | Supplier/customer delivery call tied to order or delivery; update through Materials actions | Supplier communications are not automatically customer-visible |
| Equipment | Service/vendor call from a unit or maintenance obligation; retain unit reference | No forced project dependency; restricted operational contact access |
| Customer portal / websites / live chat | Request callback, select preferred number/time, carry verified project/contact context into inbox | Customer views never expose staff notes, transcripts, scripts, or recordings by default |
| Channels / project notes / internal huddles | Share a permission-aware call link; post reviewed summary or task to an internal thread | Internal channels keep their own membership and room access rules |
| Photos / map / measurements / FirstMeasure reports | Open a report/photo/map during a call; preserve the referenced entity/version in notes | No new dialer on every toolbar; shared contact actions only where useful |
| Stats / insights | Call outcomes, callback timeliness, list conversion, routing and quality metrics | Report from canonical events, not screen clicks or inferred human connections |
| Training / Training Studio | Script training and reviewed/redacted examples explicitly published by a manager | Training does not automatically gain access to customer recordings |
| Payroll / compensation | Optional downstream attribution through verified business outcomes | Call count alone must not trigger payouts; payroll is not part of this rewrite |
| Settings / onboarding / help | Communication settings, voice onboarding, device test, channel health and troubleshooting | Reuse manifest settings and setup-workflow architecture |
| Billing / referrals / promotions / pricebook / editor infrastructure | Surface communications only through a relevant contact/business event | No dedicated call UI or unrelated redesign; preserve current domain behavior |
| Native management/customer shells | Shared responsive history/logging now; native incoming-call integration as a separate deliverable | Do not assume a Capacitor WebView supplies reliable background telephony |

Proposed app service contract (new API, not an existing global):

```ts
communications.open({
  action: 'call' | 'message' | 'log_call' | 'follow_up',
  organizationId, branchId,
  contactId?, endpointId?, projectId?, conversationId?,
  entity?: { type, id, version? },
  workNodeIds?: string[], callListEntryId?, returnContext?
});
```

Hosts pass IDs and intent. The service loads permitted data and resolves features; it does not trust a pasted contact snapshot as authority. Register action contributions/hooks in the app runtime, with explicit bundle dependencies and teardown. Phone links keep an accessible external-phone alternative.

## 9. Canonical data and service boundaries

Create a customer-call domain under `public/v1/comms/calls/` and a Telnyx voice adapter under `public/v1/telephony/`. Keep existing `public/v1/calls/` room APIs stable for Channels. The name distinction prevents customer PSTN calls from being accidentally routed through LiveKit's internal room assumptions.

Persist customer-call tables alongside the shared communications database so call activity, intent/idempotency, and outbox changes can commit together. Keep media in private object storage. Existing Work, CRM, and Channels stores remain separate initially; cross-store operations require an outbox/saga, not an imaginary transaction spanning all databases. The current SQLite deployment requires durable local storage on one host, tested backups, leases across processes, and short transactions. Move the transactional state to a shared database before multi-host scaling; do not put SQLite files on a shared network drive to simulate that architecture.

| Record | Required content / authority |
| --- | --- |
| `communication_calls` | Tenant/branch, mode, direction, participants and endpoint snapshots, primary contact/project, native conversation if related, call-list entry, source obligations, purpose, transport state, human result, timestamps/duration source, script version, policy snapshot, revision |
| `communication_call_legs` | Internal ID, attempt ID, provider, provider connection/control/leg/session IDs, endpoint role, parent/transfer relationship, lifecycle, hangup cause, billable duration/cost references |
| `communication_activity` | Rebuildable feed/search projection pointing to original message/call/note records; source type+ID unique within tenant; audience and entity references |
| `communication_workflow_state` | Common owner/team, open/snoozed/resolved state, due/needs-response information, revisions for native threads or call items |
| Read markers | User+thread/activity cursor; opening a message does not imply resolution |
| Call-list definitions and entries | Existing IDs, source keys and configuration retained; add revisions, eligibility, claims and references to immutable attempts |
| Source-obligation links | Many Work nodes/other authorized sources can contribute to one list entry; explicit completion requirements and source status |
| Call work sessions / drafts | User, list, selected stable entry ID, skipped IDs, progress, script answers, notes, draft version, last saved state |
| Telephony resources | Tenant-owned business number, independent SMS/voice bindings, Call Control app, SIP connection, outbound profile, number policy, provider provisioning/reconciliation status |
| Agent endpoints / presence | Authorized user/device, credential reference, registration status, availability, heartbeat, routing skills/queue memberships, active session lease |
| Call artifacts | Recording/voicemail/transcript/summary IDs, source call/leg, private storage reference, processing state, consent interval, audience, retention, redaction/version/provenance |
| Wrap-up operations / outbox | Stable client operation ID, validated intent, accepted revision, completed effects, retry/reconciliation status |
| Call events / usage | Append-only normalized lifecycle and business events; provider costs in exact decimal currency with reconciliation status |

A call can have multiple legs and artifacts but appears as one customer interaction. One entry can have many attempts. Follow-up nodes can have a chain of predecessors/successors. Recording, transcript, and summary are optional child artifacts, never the existence condition for a call.

Endpoint identity is normalized E.164 plus optional extension, with original entered value retained. Reject ambiguous invalid inputs with a country selector. Match inbound calls first by owned receiving number → tenant/branch; then by existing provider/session correlation; then verified endpoints and linked conversation. Caller ID is not identity verification. Return multiple candidates for shared numbers/repeat customers; keep unmatched calls in an Unlinked inbox with explicit association tools.

Use one primary project for default workflow context and optional audited related-entity links. Access to a call linked to several projects is not automatically granted to everyone on every project. Explicit audience rules control visibility and redact unauthorized linked-entity names. Relinking updates projections without rewriting historic participants or duration evidence.

## 10. States and reliable operations

Maintain independent state machines:

```text
Transport: created → authorizing → agent_connecting → dialing → ringing
           → connected ↔ held → ending → ended
Terminal alternatives: canceled, busy, no_answer, rejected, failed

Human work: draft → needs_wrap_up → processing_effects → saved
Artifacts: not_requested / waiting_consent / processing / ready / failed / deleted
Queue: pending / claimed / deferred / completed / canceled / removed
```

Transfers and conferences are legs/operations within the parent call, with progress and failure substates. Record raw provider state as well as normalized state. Provider answers/hangups never infer a sale, completed follow-up, or successful appointment.

Wrap-up protocol:

1. Client submits a stable operation ID and call/entry revision, result, note, source obligations, and intended next action.
2. Server authenticates, validates current permissions/policy/source statuses, resolves schedule/outcome, and accepts one immutable operation. Same ID+same payload returns the same result; same ID+different payload conflicts.
3. Commit call result, note reference, and durable effects in the communications transaction. Show Saved or Finishing follow-up truthfully; do not report an unfinished effect as completed.
4. Workers invoke Work, CRM projections, Channels note linking, notifications, and search updates with stable effect IDs. Effects retry safely and are visible to operations. Work transitions also deduplicate and check the expected version.
5. A retry resumes that operation. It does not create a new call, new note, new successor, or second appointment. Reopening wrap-up makes an audited correction with explicit compensating effects where needed.

The application cannot guarantee exactly-once execution by making HTTP requests; it must achieve one business effect using durable idempotency, recorded attempts, and reconciliation. Ambiguous dial/send/booking responses stay unresolved until reconciled. Do not blindly retry a charged or externally visible operation.

SSE through the existing real-time infrastructure distributes authorized updates; reconnect fetches a canonical snapshot plus a resumable cursor. Keep a bounded polling fallback with backoff. Call media and WebRTC signaling use the provider transport; SSE is for app state. Never stream org-wide sensitive events to a client and rely on frontend filtering.

## 11. Telnyx implementation

Use the Telnyx browser WebRTC SDK for the staff audio endpoint and the server-side Voice/Call Control API for policy, routing, customer legs, recording, and transfer. Telnyx documents a contact-center pattern using individual staff credentials and backend routing, and an outbound pattern using parked WebRTC calls followed by controlled PSTN dialing and bridging. These establish feasibility; our exact account configuration still requires a controlled pilot. [Contact-center reference](https://developers.telnyx.com/docs/voice/webrtc/use-cases/contact-center), [outbound flow reference](https://developers.telnyx.com/docs/voice/webrtc/use-cases/outbound-dialer/index).

### Provisioning and credential boundary

FirstMate's existing messaging model owns a shared Telnyx account with tenant-owned numbers and messaging profiles. Extend that model with separately mapped voice resources. Default to isolated per-organization voice connections/applications and an outbound policy boundary, with branch number/routing configuration beneath them. Validate account limits and whether managed subaccounts are needed before scaling; do not assume messaging profiles isolate voice credentials.

Create individual staff/device telephony credentials and issue provider-generated expiring tokens only after platform authentication. Keep account API keys and persistent SIP passwords server-side. Store tokens in memory, refresh using their actual provider expiry, and revoke endpoint credentials on logout/removal as supported. Provider documentation supports credentials with expiry; verify token/revocation behavior in the chosen SDK/account instead of claiming an arbitrary token TTL. [Telephony credential reference](https://developers.telnyx.com/docs/voice/webrtc/auth/telephony-credentials).

Staff browser credentials must not be an unrestricted path to arbitrary paid PSTN destinations. Use parked/control-mediated dialing, restricted SIP reachability, provider outbound restrictions and spend/channel limits. The backend authorizes the requested customer destination and caller ID. Attempt to bypass the UI in the pilot and prove that unauthorized direct dialing is blocked. Rate limiting the FirstMate endpoint alone is insufficient.

### Outbound sequence

1. Create an authorized call intent with a unique ID; reserve entry/agent, validate suppression, permitted time, destination, caller ID, limits and provider readiness.
2. Connect the browser staff leg to the controlled voice application. Correlate it with the authorized intent using a server-issued opaque nonce and verified credential/connection identity. Do not trust client-supplied base64 state as authorization.
3. Once the staff endpoint is ready, the backend dials the customer leg. A customer should not answer before an agent is available to speak.
4. Correlate `call_control_id`, `call_leg_id`, and `call_session_id`; bridge at the appropriate event. Only then show the confirmed connected state.
5. Apply disclosure/consent before recording, transcription, or media forwarding starts. Allow an unrecorded call where policy permits.
6. End all applicable owned legs, retain their causes, release routing resources, and open wrap-up. Browser disconnect without recovery uses a bounded grace period and an explicit orphan-leg cleanup policy.

A canceled intent cannot create a customer leg if delayed ready/answered events arrive afterward. Timeouts apply to authorization, agent setup, ringing, transfers, and maximum duration. With an ambiguous provider response, reconcile; do not redial automatically.

### Inbound sequence and queueing

Owned business number → tenant/branch/business-hours policy → greeting/optional IVR → eligible queue/team → available staff endpoint → accepted/bridged call. A browser must report registered and available; a signed-in user alone is not callable. Backend offers have leases and an atomic winner; accepting one cancels other offers.

Initial routing supports direct user, sequential ring group, and longest-idle eligible agent, with business hours/holidays and overflow. Add simultaneous ringing only with the same atomic-accept guarantees. Define wrap-up time, maximum waiting time, caller abandonment, per-agent capacity, and missed-offer handling. Display wait estimate only if backed by sufficient data; otherwise display wait time.

No eligible agent or exceeded wait: route to configured voicemail, verified external overflow number, or customer-requested callback. Callback requests create one Work node and confirmation through an available permitted channel. After-hours behavior is explicit. Unknown/spam callers remain visible for triage; do not create a customer/project on every ring.

### Controls and recovery

Mute affects staff audio; hold affects the customer leg with appropriate audio. DTMF is a dedicated keypad, not recorded in notes. Warm transfer creates a consultation leg, supports cancel/return to the caller, and completes only when the target accepts. Cold transfer displays target and changes ownership after provider success. A failed transfer returns to the original call when possible. Conferences retain per-leg accounting and role visibility. Clearly distinguish End my participation from End customer call where relevant.

Use a single elected browser owner per staff endpoint, coordinated with a server lease and multi-tab signaling. Additional tabs subscribe to state. Reconnect attempts reattach to the current provider session where supported; if unsuccessful, display the real failure, clean up orphaned legs, and offer an explicit retry. Coordinate microphone ownership with Channels huddles and audio-note recording.

Browser/background suspension, headset removal, permission denial, expired credentials, one-way audio, network changes, and provider disconnects need distinct recovery states. Incoming calls with no viable browser go to routing fallback. Reliable native background ringing requires native Telnyx/OS call integration and its own testing; the existing Capacitor shell does not establish it.

### Webhooks and durable commands

Add a dedicated voice webhook endpoint. Verify Ed25519 against the raw body, enforce timestamp policy, persist accepted events before acknowledgment, deduplicate by provider event ID, and process asynchronously. Map tenant ownership from persisted resources; never from an untrusted organization field. Keep SMS handlers independent.

Track commands durably with FirstMate operation IDs and Telnyx `command_id`; keep app deduplication beyond the provider's duplicate-suppression window. Handle duplicate, delayed, and out-of-order events with per-leg timestamps and terminal-state protection. Hangup may arrive before a create response. Record unmatched events for correlation/reconciliation; do not discard them. [Telnyx webhook behavior](https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks).

## 12. Optional setup and readiness tests

Communications and manual call workflows require no voice subscription, provider setup, microphone permission, or network test. Voice setup appears only when an administrator chooses **Enable FirstMate phone**.

Setup workflow:

1. **Calling model** — explain browser calling, existing-phone logging, and optional forwarded staff endpoint. Show accountable service/billing owner.
2. **Business number** — select an existing tenant-owned voice-capable Telnyx number or begin a separate quote/order/port workflow. Display SMS and voice status independently. Do not purchase or port as a side effect of enabling a feature toggle.
3. **Routing and identity** — branch, business hours, caller ID, inbound team, fallback, voicemail greeting, outbound restrictions, usage limits. Verify number entitlement and caller-ID configuration; do not promise spam-label prevention.
4. **Emergency and service obligations** — service location and applicable emergency-routing setup, supported regions, operator/provider responsibilities and required acknowledgments. Resolve with Telnyx and counsel for the actual reseller/service model before release.
5. **Recording and AI** — choose off/default policy, disclosure, retention, access, processing region/vendor policy, and draft-versus-approved action rules.
6. **Devices and network** — staff microphone, speaker/ringtone device, local playback, diagnostic connection.
7. **Test** — explicit test call to a controlled number and inbound test, including two-way audio, routing fallback, voicemail and permitted recording. Never silently dial a customer or use a real emergency call as a test.
8. **Activate** — show independent organization service readiness and the current staff device readiness; release only the tested capabilities.

A download speed number is insufficient. Telnyx's published `webrtc@2.27.10` release (August 21, 2026) adds `runPreCall`, `runNetworkCheck`, and `runMicrophoneCheck`, with structured verdicts covering ICE/network/microphone/media. Pin and verify that SDK release or a subsequently validated stable release in the integration spike. [SDK releases](https://github.com/team-telnyx/webrtc/releases).

Readiness checks should measure connectivity to the actual voice path, microphone permission/level, speaker playback, ICE/TURN reachability, RTT, jitter, packet loss, usable bitrate, and two-way media. Upload/download throughput is supplementary. Protect diagnostic traffic with rate limits, cleanup, and an explicit test indicator; exclude it from sales call metrics. Meter any provider-billed diagnostic legs.

Use provider verdict/reason codes where available, normalize units, and keep raw measurements. Proposed initial product thresholds, to calibrate with Telnyx and pilot results, are: good RTT under 200ms, jitter under 30ms, loss under 1%; degraded outside that range; sustained RTT above 400ms, jitter above 50ms or loss above 3% prevents Ready pending retry or a configured fallback. These are engineering acceptance targets, not universal guarantees or claims about Telnyx's built-in thresholds. An inconclusive test is not a pass. Missing microphone or no viable media path is blocked regardless of speed. [Telnyx diagnostic interpretation](https://developers.telnyx.com/docs/voice/webrtc/troubleshooting/interpreting-debug-data).

Show plain-language results: **Ready**, **Audio may be unstable**, **Microphone unavailable**, **Network blocks calling**, or **Test inconclusive**, with a specific corrective action. Recheck on first use, device/network change, prolonged reconnect, and manually; use a lightweight check before each call. Do not run a full bandwidth test on every click. In-call quality warnings must not themselves hang up a working call. Store only necessary measurements and redacted diagnostics with a bounded retention period.

Emergency calling is a launch dependency, not a dismissible disclaimer. Number-level address configuration exists in Telnyx, while roaming staff may require a dynamic location strategy. Do not assume every staff member is at the branch address or that blocking 911 establishes compliance. Confirm applicability, routing, location updates, test method, and outages/notifications before customer availability. [Telnyx emergency configuration](https://developers.telnyx.com/api-reference/phone-number-configurations/enable-emergency-for-a-phone-number), [National 911 Program guidance](https://www.911.gov/calling-911/frequently-asked-questions/).

## 13. Recording, transcripts, and AI

### Recording and retention

Use provider-side recording of the actual customer call rather than treating the browser microphone recorder as a two-party recorder. Request separated channels where supported, retaining actual leg/speaker mapping; transfers and conferences complicate speaker identification. Recording, streaming transcription, and saved transcripts all follow the consent policy. A visual recording badge is not evidence that required disclosure happened.

Consent state begins off/waiting. Log disclosure version, participants, evidence, timestamp, and allowed interval before starting capture. Support refusal and withdrawal. Pause/resume applies to every active capture path: recording, live transcript, and AI media streaming. Reassess when participants join or transfers change the audience. If a mandatory policy cannot be satisfied, route to the configured permitted alternative. Counsel-approved policies must account for caller/recipient jurisdictions; no blanket legal conclusion is assumed here.

Recording-save events create pending artifacts and trigger durable ingestion. Verify format, size, ownership and integrity; use private storage and short-lived authenticated playback links. Do not persist provider download URLs as permanent playback assets. Telnyx documents short-lived download links and custom storage options. Retry/reconcile expired or delayed links through its recording API. [Recording API](https://developers.telnyx.com/api-reference/call-commands/recording-start), [recording storage](https://developers.telnyx.com/docs/voice/programmable-voice/storing-call-recordings).

Set explicit organization retention with separate recording/transcript/summary policies, bounded defaults and any necessary holds. Propagate deletions to provider copies, object storage, transcripts, search indexes, derived AI artifacts, and expiring backups under the documented policy. Keep an audit tombstone without retained content. Playback/export permission is narrower than general call-history permission. Default audience is authorized internal staff; customer portal and training publication are explicit separate actions.

### AI levels

| Level | Behavior | Release dependency |
| --- | --- | --- |
| Preparation | Summarize authorized prior communication, propose a script and questions, show upcoming commitments | Unified read APIs; can work without VoIP |
| After-call assistant | Summarize transcript or clearly labeled staff notes, propose disposition and next tasks | Durable artifacts, structured output, review and action APIs |
| Live assistant | Show provisional transcript, relevant script branch and suggested next question/action | Consent-aware streaming, latency/error handling and tested model/provider |
| Autonomous voice agent | Optional inbound receptionist/triage with human transfer; separately scoped outbound automation | Separate permissions, voice-agent evaluation, disclosure/consent rules, routing and operational sign-off |

The first AI release supports preparation and after-call review. A transcript is optional: notes can be summarized, but the source must be labeled. Lack of audio must never produce a fictional transcript. Long recordings use asynchronous processing and chunking with overlap/offsets; do not route a long call through the existing short audio-note upload endpoint unchanged.

Reuse `public/v1/agents` and the Comms agent definition. Add structured tools for reading a call/transcript, preparing a call, proposing a wrap-up, and creating a communication follow-up through Work. Reuse existing message and scheduling tools. Keep interactive agent threads distinct from customer conversation IDs and provider sessions.

AI output contains summary, customer requests, commitments, proposed result, suggested next actions, and evidence references to transcript segments or staff notes. Include missing/uncertain fields and processing errors. Draft fields never overwrite a caller's edits. Show **Suggested by AI**, with edit/accept/dismiss. Readiness to finish a call does not wait on an AI request.

Allow automatic attachment of a clearly labeled draft summary if enabled; business writes default to review. Sending a message, booking or moving an appointment, changing contact data, completing work, or marking a lead lost requires a server-validated action and the applicable product approval policy. A transcript's instruction to ignore rules or send data is customer content, not a tool authorization. Previously enabled email/SMS auto-response behavior remains governed by its existing explicit configuration; adding calls does not expand it.

Evaluate summaries for evidence support, entity/date accuracy, missed commitments, wrong-project linking, and inappropriate tool proposals using representative authorized/redacted calls. Test accents, noise, silence, voicemail, language changes and interrupted audio. Record model/prompt/version and processing cost. Avoid speculative emotion scores or biometric voice identification.

Autonomous outbound voice is not implicit in "AI notes." The FCC has ruled that AI-generated voices fall within artificial/prerecorded-voice TCPA restrictions; any such later feature needs its own eligibility/consent workflow and current legal review. [FCC declaratory ruling](https://docs.fcc.gov/public/attachments/FCC-24-17A1_Rcd.pdf).

## 14. Permissions, tenant isolation, and service lifecycle

Separate feature entitlement, organization configuration, user permission, and technical readiness. A disabled Calls shortcut must not remove history from a project where the user is authorized to see it.

Proposed capability additions: `comms.calls`, `comms.call_lists`, `comms.follow_ups`, `comms.voice`, `comms.voice_inbound`, `comms.recording`, `comms.transcription`, `comms.call_assistant`, and `comms.call_center`. Preserve current email/SMS/chat flags and internal `calls.*`/`channels.*` room capabilities. Migrate legacy `calls.app` as an access/configuration alias for call-list workflows, never as automatic paid-voice activation.

Permissions distinguish view history, log calls, manage own/team lists, make/receive calls, transfer, view recordings/transcripts, export, edit scripts, manage routing/numbers, supervise, and approve AI actions. Check tenant, branch, project, contact, list/team and artifact audience on reads, writes, search, downloads, exports, agent context, and event subscriptions. Server actor identity replaces user-submitted email/name/roles.

Common number ownership moves behind a shared telephony-resource service while retaining the existing ownership records and IDs. SMS setup and voice setup attach independent service bindings to that resource. SMS STOP remains SMS consent behavior and does not authorize or automatically imply phone-call marketing permission. Voice do-not-call/suppression and record/transcribe consent are distinct. Intentional all-contact suppression can apply to both through an explicit policy.

Disable SMS without releasing a voice-bound number; disable voice without changing its SMS profile/campaign. Number release is a separate reviewed operation showing every affected service, pending port, active call, and future charge. Number purchase/porting preserves the existing idempotent quote/provision/reconcile pattern. Do not silently change an existing inbound voice route simply because the number is already used for SMS. Use verified read-back and a reversible configuration cutover.

Security controls specific to a paid phone system include per-tenant/user rate and spend limits, international/premium destination restrictions, concurrency limits, short-lived endpoint access, webhook verification, audit trails and emergency operational kill switches. A voice outage or spend cap must not erase history or block permitted manual call logging and other communication channels.

## 15. API and event contract

Extend `/v1/comms/organizations/:orgId` with versioned response schemas. Proposed routes below are new, not claims about existing endpoints:

| Surface | Operations |
| --- | --- |
| `/activity`, `/inbox`, `/search` | Cursor-based queries with project/contact/entity/channel/owner filters and separate counts |
| `/calls` | Create authorized manual/browser/callback intent; list history |
| `/calls/:id`, `/calls/:id/draft` | Read detail; revisioned draft autosave |
| `/calls/:id/actions/:action` | Allowlisted accept, reject, hangup, hold, resume, DTMF, transfer, participant and capture commands |
| `/calls/:id/wrap-up` | Idempotent validated business result and effects |
| `/calls/:id/artifacts` | Authorized recording/transcript/summary metadata and playback request |
| `/call-lists`, `/call-lists/:id/entries` | Preserve list/entry CRUD and source-key semantics |
| `/call-list-sessions`, `/entries/:id/claim` | Resume queue work; acquire/renew/release claim; skip session entry |
| `/scripts`, `/scripts/:id/versions` | Draft, publish, preview and archive versioned scripts |
| `/voice/setup`, `/voice/resources`, `/voice/endpoints/token` | Admin onboarding, resource state and authenticated staff endpoint access |
| `/voice/presence`, `/voice/queues`, `/voice/diagnostics` | Availability, routing, bounded diagnostic reports |
| `/workflow/:kind/:id` | Common assignment/snooze/resolve/read-state commands pointing at native records |
| `/events` | Authorized SSE with cursor/snapshot recovery |

Follow-up creation/completion stays in `/v1/work`; Communications may expose a thin context-aware facade, never a second task store. Existing `/v1/internal/crm/...call-lists` and disposition routes become authenticated compatibility adapters. Existing agent/scope automation IDs remain valid during migration.

New events: `communication.call.created`, `.connected`, `.ended`, `.wrap_up_saved`, `.missed`, `.voicemail_received`, `.recording_ready`, `.transcript_ready`, `.summary_ready`, `.linked`, and `communication.follow_up.requested`. Raw provider events remain diagnostic/system events. Emit the existing `call.completed` compatibility event once on accepted human wrap-up for a real attempt, with a shared canonical ID; never emit it for Skip. Inventory existing consumers and deduplicate automation subscriptions during the overlap.

All commands need request limits, structured validation errors, idempotency where externally visible, and meaningful revision conflicts. E.g. `entry_claimed`, `outside_call_window`, `number_suppressed`, `voice_not_ready`, `recording_not_permitted`, `wrong_project`, and `wrap_up_effect_pending`. Show the actionable message without exposing provider credentials or raw private payloads.

## 16. Browser routing and runtime implementation

Retain `tab=chat` as the compatibility-backed Communications shell initially; a user-facing title does not require renaming every existing deep link. Route `tab=calls` through a normalizing adapter to the Call lists view. Preserve existing pinned app IDs/settings with aliases until migrated. Do not strand Calls-only organizations behind a newly disabled Comms entitlement.

Register proposed keys through the manifest/navigation schema:

- `communicationsView`: inbox, lists, followups, history, center — push.
- `communicationConversation`, `communicationCall`, `callList`, `callEntry`: stable entity destinations — push.
- `communicationChannel`, `communicationStatus`, `communicationOwner`, `communicationQuery`, list density/sort: replace.
- Project state includes main `tab`, `project`, `projectTab=comms`, then the scoped communication view/entity. Existing `commsView` and conversation keys receive a migration adapter.

Avoid array-index identity such as `callIndex` for durable selected-entry routing. Read old index-based links as a best-effort selection on the legacy snapshot and normalize to an entry ID. Loading a URL never dials, accepts, resumes recording, or triggers a message send. Opening a call record and establishing media are separate operations.

Use `Portal.navigation.push`, `replace`, schema/handler registration, and `backOrClose` for routed workspace closure. Render routed chrome synchronously, then fetch. Handlers are idempotent, suppress entrance animation during restoration, and do not write history while `applying`. Scripts, note inputs, keypad state and menus remain transient. A task becoming unavailable during a deep-link restore displays an explanation; it does not silently rewrite to another task.

Reorganize product UI under `public/libraries/apps/comms/` with reusable timeline, inbox, call workspace, follow-ups, scripts, and settings modules. Keep `public/libraries/apps/calls/app.js` as a thin mount/compatibility entry for the reusable call-list runner. `public/libraries/apps/chat/app.js` becomes a thin compatibility host around the communications shell and retained chat-specific components. Shared clients remain in `comms-api`; internal `calls-api` stays room-oriented.

Do not put app bodies in `public/portal/scripts`. Use the topbar only to mount shared ambient call chrome through runtime services. Explicitly declare ProjectNotes, scheduling, templates and media dependencies. Unmounting a view removes listeners/subscriptions without ending the ambient call. Logout/account switch performs an explicit active-call handoff/end decision, revokes endpoint access and clears scoped drafts/cache; it must never carry a customer's call into another tenant session.

## 17. Migration and rollout

This is an additive migration with staged read/write cutover, not a mass rewrite of message storage.

1. Inventory each tenant's lists/settings, pending/completed entries, call-note metadata, `call.completed` events, legacy lead dial records, follow-up Work nodes, number ownership and app entitlements. Dry-run reports contain counts/conflicts, not sensitive note contents.
2. Backfill canonical call records using stable source mappings `(tenant, source_system, source_id)`. Correlate `metadata.call.id`, note IDs and entry results before creating a record. Mark legacy/manual evidence and unknown duration explicitly. Keep raw disposition labels and provenance.
3. Sources include current entry results, Channels `call_note` messages and recorded work events, plus a separately versioned adapter for the older CRM lead-call path. Old entries may have overwritten results; report unrecoverable gaps. Never fabricate missing historic calls, recordings or timestamps.
4. Backfill activity/search references without moving or deleting original notes/messages. A call with a linked call note displays once in the unified feed. Channels can retain its note/card, resolving visibility through the source.
5. Preserve list IDs/source keys, branch configuration, custom labels and assignments. Detect multiple source obligations before adopting the many-source link model. Do not infer that all deduplicated scope tasks were completed by one old call.
6. Use an organization-level feature flag and shadow feed to compare authorized counts, ordering, status and latency. Validate existing and new message/call records written during the backfill using durable cursors and replay.
7. Cut manual-call writes to the canonical service with a brief per-organization write drain or equivalent bounded cutover barrier. Legacy routes call the new service. Do not run two independent writers. Keep new events replayable and bridge older consumers with deduplication.
8. Enable the unified shell for internal users, then manual-only pilot tenants. Preserve the old Call lists shortcut and direct links. Verify no email/SMS/chat/list regression before removing legacy rendering.
9. Pilot voice separately on a controlled number and small team, then opt-in tenants. Require the provider/topology, media, number-lifecycle and service-policy gates before activating live customer calls.
10. Enable recording/after-call AI only after consent, media access and retention checks. Add team-center controls, live assistance and native background calling through subsequent gates.

Rollback means switch presentation/capability flags while keeping canonical writes and compatibility adapters, or roll back to a tested adapter-compatible build. Do not erase new history or point an old binary at incompatible schema. Record and rehearse number-routing rollback before a live cutover. Disable voice provisioning/outbound traffic independently from inbound fallback and the rest of Communications.

## 18. Delivery sequence and acceptance gates

| Stage | Concrete deliverable | Required gate |
| --- | --- | --- |
| A — Domain and UX contract | Final interaction layouts, capability map, permission rules, outcome schemas, source/migration inventory; Telnyx technical spike | Inbound/outbound browser leg correlation, policy-controlled dialing, recording/transfer feasibility, SDK diagnostics and SMS coexistence proven on controlled resources |
| B — Manual calls and unified feed | Canonical calls, reliable wrap-up, fixed Skip, Work follow-ups, history/backfill, shared action contract | Manual-only users retain every current list and communication feature; duplicate/error tests pass |
| C — Unified application | Inbox/list/follow-up/history UI, project/contact views, scripts, persistent drafts, common workflow metadata, deep links | Browser flow and independent app smoke tests pass at target sizes; existing channel parity verified |
| D — Opt-in business phone | Provisioning, shared numbers, endpoint auth, diagnostics, outbound/inbound calls, voicemail/fallback, usage and operational controls | Tenant isolation, emergency/service readiness, network failures, reconnect and paid-operation reconciliation verified |
| E — Recording and after-call AI | Consent-aware capture, protected artifacts, transcripts, evidence-backed drafts, review actions | Consent/pause/deletion, source-grounded output and no unauthorized business mutations demonstrated |
| F — Full team call center | Ring groups/queues, transfers/conferences, callback routing, supervisor operational view and reports | Race, routing, overflow, concurrency, quality and load tests meet pilot targets |
| G — Advanced opt-ins | Live assistance, native background ringing, controlled inbound AI receptionist; separately proposed outbound AI | Dedicated evaluation and operational/legal approval per feature |

These are dependency milestones, not fixed calendar estimates. Size implementation after the technical spike and inventory, especially provider/account limits, current source-history quality, deployment topology and native support. The first useful release does not wait for native apps or an autonomous voice agent.

## 19. Validation and operations

Tests must verify business invariants and real workflows, not merely regexes matching the new implementation.

| Scenario | Pass condition |
| --- | --- |
| External call with blank note | One manual attempt in global and correct project/contact history; no invented duration/recording |
| Skip vs complete | Skip creates no attempt, completes no node and changes only this work session |
| Double-click / lost wrap-up response | One outcome, note, successor and compatibility event; retry resumes the same operation |
| Effect fails after call save | Durable visible pending state; eventual recovery with no duplicate business action |
| Parallel scope sources | Source links preserved; only satisfied obligations complete; other scope work remains active |
| Date-only/timed callbacks across zones/DST | Correct eligible day/time and stable display on server/browser in different zones |
| Two agents / two tabs / same endpoint in two lists | One winning authorized claim/call; no accidental concurrent customer dialing |
| Unauthorized tenant/branch/project | No read, claim, dial, transcript, export, search hit, AI context or SSE leakage |
| Custom outcomes | UI and server share schema; allowed labels/actions work for sales, production and billing |
| Wrong/unknown/shared phone | No silent association; user can resolve and audit it |
| Existing email/SMS/chat | Native threading, recipients, delivery, consent, attachment/audio, claim/handoff, templates, AI and overrides remain correct |
| Unified filters | Mine/Unassigned/read state works for every eligible channel; empty and unavailable are distinguishable |
| Long history | Pagination reaches old records, counts are truthful, no per-row project scan bottleneck |
| Navigation | Back/Forward/deep link restores context without dialing or losing drafts; minimizing and opening projects keeps media alive |
| Incoming simultaneous accepts | Atomic winner; losing offers stop ringing; one customer call card |
| Browser failure and provider events | Duplicate/reversed/delayed events do not resurrect an ended call or redial; orphan legs are cleaned up |
| Transfers | Successful, rejected, timed-out and canceled consultation paths retain the caller and correct ownership/accounting |
| Shared business number | Disable SMS with voice active, and voice with SMS active, without releasing or breaking the other service |
| Capture and live modes | Tests cannot dial real destinations; fixture/test traffic cannot become sales metrics or live deliveries |
| Consent / payment discussion | Refusal and pause stop all capture paths; resumption follows policy; transcript/AI excludes paused content |
| Artifact errors / deletion | Audio ingestion failure does not lose the call; expired URLs recover; deleted content disappears from derived stores |
| AI | No fabricated facts, scheduling or sends; accepted actions still enforce current permissions and entity revisions |
| Browser size/accessibility | Keyboard and screen reader flows, 200% zoom, 360/768/1024/1440 widths; no hidden End call or horizontal dialog clipping |

Run the existing relevant suites while changing their owners: `test:crm`, `test:work`, `test:comms`, `test:messaging`, `test:channels`, `test:audio-notes`, `test:appointments`, `test:rescheduling`, `test:capabilities`, and the required `npm run test:navigation` from `public/v1`. Run syntax/type checks and the independent app smoke harness. Add focused call-domain, telephony-adapter, webhook replay, migration and browser workflow suites. Run only suites relevant to a given stage; the final rollout gate includes end-to-end channel parity.

Proposed initial performance goals, to validate rather than present as existing service levels: interactive shell within 200ms once bundles are loaded; cached first page within 500ms p95 and indexed 50-row API pages within 300ms p95 at agreed pilot volume; voice webhook durable acknowledgment within 1s p95; app state visible within 2s of accepted event; save acknowledgement within 1s p95 excluding asynchronous business effects. Measure call-setup and transcript latency separately against provider and recording length. Load-test at twice the approved pilot concurrent-call capacity before widening rollout.

Operations need dashboards/alerts for registration failures, call-setup failures, one-way audio, queue wait/abandonment, orphan legs, webhook lag, pending command reconciliation, wrap-up effects, recording/transcript backlog, tenant spend, and channel health. Support can inspect redacted diagnostics; listening to a recording requires explicit artifact access. Provide runbooks for provider outage, bad headset/network, number misrouting, transfer failure, stuck session, missed webhook, storage failure and usage discrepancy.

Metrics: actual attempts, human connections, provider answers, completed obligations, skipped entries, callback timeliness, talk/hold/wrap time, inbound answer/abandon rates, appointment conversion, per-list outcomes and quality. Separate manual estimates from provider facts and customer calls from internal huddles and diagnostics. Do not label provider-answer rate as human contact rate.

Extend the existing provider-cost ledger for voice legs, recording, transcription/storage and AI usage with exact currency and source IDs. Transfers/forwarding can create multiple billable legs. Reconcile provider CDRs/costs before customer billing; keep estimated charges labeled. Customer pricing, taxes/surcharges, service/reseller obligations, number fees and limits require a separate commercially approved plan; do not invent rates in this spec.

## 20. Decisions to confirm before the relevant release

Use these defaults to proceed with design and manual-call implementation; they are not blockers to completing the spec.

| Decision | Recommended starting point | Must resolve before |
| --- | --- | --- |
| Primary navigation | Communications central; optional Call lists shortcut | UI cutover |
| VoIP | Opt-in per organization, disabled by default | Provider provisioning |
| Initial dialer | One agent-reviewed customer call at a time; no predictive dialing | Voice pilot |
| Account/resource isolation | Existing FirstMate-owned account plus separately mapped tenant voice resources | Provisioning scale-up |
| Reuse existing SMS number | Only after capability/ownership/existing voice-route verification and independent lifecycle work | Binding voice |
| Initial recording/AI | Explicit policy setup; after-call drafts first | Enabling capture/AI |
| Initial customer launch region | Confirm service geography and emergency obligations with the business/provider | Any customer voice release |
| Retention and access | Internal audience, separate playback/export permission, explicit retention chosen during setup | Recording |
| Native background calls | Separate implementation; external-phone fallback available | Promising mobile incoming-call availability |
| Autonomous voice agents | Separate opt-in scope; human transfer first | Any voice-agent launch |

## Source map for implementation

The links below identify the actual code inspected; proposed modules above do not yet exist.

| Area | Source |
| --- | --- |
| App boundaries and host lifecycle | [Embeddable apps architecture](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/portal/EMBEDDABLE_APPS_ARCHITECTURE.md>) |
| Apps, surfaces, entitlements and routes | [App manifest](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/libraries/apps/firstmate-apps-manifest.js>) |
| Manual Calls UI, `tel:` actions, Skip and draft handling | [Calls app](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/libraries/apps/calls/app.js:57>) |
| List persistence, projection and disposition writes | [CRM call lists](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/internal/crm/call_lists.ts:224>) |
| Existing call-list HTTP boundary | [CRM API](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/internal/crm/api.ts:99>) |
| Global inbox merge and channel-specific filtering | [Communications shell in chat app](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/libraries/apps/chat/app.js:265>) |
| Project Communications UI | [Project Comms](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/libraries/apps/comms/project.js>) |
| Feed/inbox aggregation | [Comms service](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/comms/service.ts:264>) |
| Ambiguous inbound matching | [Comms matching](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/comms/matching.ts>) |
| Existing agent tools/settings | [Comms agent](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/comms/definition.ts>), [Comms settings](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/comms/settings.ts>) |
| Work follow-up authority | [Follow-ups](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/work/followups.ts:76>), [Work model](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/work/README.md>) |
| Scope/list automation deduplication | [Built-in automations](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/work/automations/builtins.ts:217>) |
| Internal media-room provider | [Room provider](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/calls/provider.ts:29>) |
| Message persistence, outbox and shared number ownership | [Communications storage](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/messaging/communications_storage.ts>), [Messaging design](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/messaging/README.md>) |
| Existing SMS deactivation releases number | [Messaging API](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/messaging/api.ts:2736>) |
| Existing short audio-note processing | [Audio notes](<C:/Users/jackh/Code/2026/FirstMate 2.0/public/v1/audio-notes/README.md>) |
| Navigation contract | [Browser navigation](<C:/Users/jackh/Code/2026/FirstMate 2.0/docs/browser-navigation.md>), [AGENTS.md](<C:/Users/jackh/Code/2026/FirstMate 2.0/AGENTS.md>) |

No application code, live provider resources, customer communications, or production configuration were changed to produce this specification.
