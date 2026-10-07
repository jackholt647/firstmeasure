# Call center assistance and reusable source analysis

The call center uses the existing customer-call storage, Telnyx conference,
phone endpoint, consent, recording and job infrastructure. The shared agents
library owns source analysis; call transcripts are its first source adapter.

## Supervisor participation

`comms/calls/supervision.ts` owns monitor (live listen), whisper, barge,
takeover and leave. Each mode has a distinct permission: `listen_calls`,
`whisper_calls`, `barge_calls`, `takeover_calls`. These are ordinary role/user
grants and may be scoped to departments or organizational divisions. Reading
the call still requires call access. Takeover also requires `make_calls`, so
the new owner can operate and finish it. There is no special manager identity.

An authorized supervisor joins through their registered browser endpoint.
Requests first create durable operations and provider jobs. The worker reloads
the user's current authorization before submission. Telnyx conference roles
control audibility: monitor is silent; whisper targets the current agent's
leg; barge is audible to everyone. Takeover joins first, changes ownership and
the agent leg, and only then releases the previous agent. Leaving a supervisor
session never terminates the customer call. Maintenance disconnects sessions
whose authorization or endpoint is no longer valid; it runs approximately once
per minute. Existing whispers stop when their target is replaced.

HTTP: `GET/POST /v1/comms/organizations/:orgId/calls/:callId/supervision`.
POST accepts an `operation_id` and `mode`. Call detail and the live center
include target-specific permissions and the current user's safe session state.
The five `customer-calls.supervision.*` publications are interactive API actions,
not general assistant tools. Unknown provider outcomes are retained for review
and are never blindly retried; the user can still leave their supervisor leg.

## Recording and automatic dialing

Recording retains the existing organization policy, explicit caller consent,
visible capture state, server-side authorization and retained-artifact checks.
The phone supports recording controls and review of available recordings and
transcripts. Declining or withdrawing consent blocks queued recording starts.

Auto dial is an explicit, tab-lifetime call-list session. It uses the existing
call creation service, durable operation identity and atomic contact/entry
claims. A Web Lock prevents a second browser tab from starting another dialer.
It rereads the queue before each attempt, excludes entries already visited in
the session, waits for required outcomes and pending saves, and displays a
cancelable countdown. Pause stops the next attempt without ending the current
call. Errors and uncertain commands pause progression. Refresh does not restart
the dialer. Browsers without Web Locks retain manual dialing.

## Reusable analysis layer

`agents/analysis.ts` accepts an authorized source adapter with source identity,
revision, expiration and labeled text parts. It packs long input into bounded
chunks, produces evidence extracts, then reduces those into notes or an answer.
The current limit is 240,000 source characters and a five-minute overall budget.
All model calls reuse `runAgentOnce`, the existing OpenAI configuration,
shared usage accounting and agent settings. The `source_analysis` definition
has no tools; source text and editable instructions cannot grant capabilities.
Its organization instructions and enabled setting live in the shared agent
settings. Each request may additionally supply instructions and a question.

`agents/analysis-store.ts` persists queued/running/ready/failed results and
idempotency. `comms/calls/analysis.ts` supplies the retained-transcript adapter,
refreshes membership and resource permissions, and queues work on the existing
call worker. HTTP returns immediately and the UI polls. No raw transcripts or
generated answers are copied into generic agent conversation history. The
result store reuses the shared SQL abstraction for SQLite and PostgreSQL.

Generating notes requires `analyze_call_recordings` and access to the source
recording/transcript. Every read and frozen replay checks current source access,
revision and retention. Deleting source artifacts revokes and purges dependent
analysis; expiry cleanup also purges results. Interrupted model work is not
automatically repeated because the external request may already have incurred
cost. A new explicit request is required. Human notes are preserved; appending
an AI result is a separate user action using the existing draft-save path.

HTTP: `GET/POST /v1/comms/organizations/:orgId/calls/:callId/analysis`.
POST accepts `operation_id`, optional `system_prompt`, and optional `question`.
GET returns availability and result states. The shared assistant discovers
`customer-call-analysis.notes`, `customer-calls.analysis.generate`, and
`customer-calls.analysis.ask` through its existing publication tools. Agent reads return processing/status metadata and omit source-derived text and prompts,
so generic assistant history does not retain a second copy after source revocation.
Full notes and answers are available in the authorized call UI and API. Action
receipts store only analysis IDs, not confidential result content.

To add another source type, implement an adapter that loads and authorizes its
actual resource, identifies immutable source revisions, and supplies a retention
deadline. Reuse the analysis runner and store; provide domain-specific HTTP and
publication gates. Do not accept arbitrary URLs or caller-supplied access grants.

## UI handoff and verification

The starting UI lives in `libraries/apps/comms/workspace.js`,
`calling-runtime.js`, `phone-tray.js`, and `communications.css`. It uses existing
window and style conventions. Supervisor controls appear in the live center
and phone; takeover has an explicit confirmation. AI notes include instructions,
questions, processing/failure states and an optional append action.

Focused tests are `call-supervision.test.ts`, `call-analysis.test.ts`,
`call-analysis-publication.test.ts`, `call-center-api.test.ts`, and
`call-assistance-browser.test.mjs`. Existing customer-call, department,
publication, phone and provider tests cover the inherited paths. Provider mocks
verify command semantics and event ordering; real multi-party audio still needs
a supervised test call to confirm audibility and device behavior end to end.

Provider references: [Telnyx conference supervisor behavior](https://telnyx.com/release-notes/improving-supervisor-behavior-conferences),
[official conference action schemas](https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/conferences/actions.ts),
and [OpenAI text generation](https://developers.openai.com/api/docs/guides/text).
