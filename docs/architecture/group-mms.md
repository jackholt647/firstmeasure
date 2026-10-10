# Telnyx Group MMS

True group MMS is explicit; ordinary multi-recipient SMS remains independent
bulk delivery. Set `sms_mode: "group_mms"` on the existing conversation/message
API, or use the dedicated group endpoints below. Text-only group messages are
still MMS. Telnyx supports 2-8 external recipients on US/Canadian local long
codes, not toll-free numbers, short codes or international destinations.

## Thread Identity

A group is identified by organization, local sending line and sorted normalized
external participants. Changing membership or sending line creates another
thread. Inbound `message.received` webhooks combine the sender with `cc` and
other recipients, exclude the local number and resolve that same identity.
One-to-one conversations never absorb group replies. Group context cannot be
silently replaced with another project, and newly received groups are not
assigned to a project merely by matching one participant's phone number.

## API

Under `/v1/messaging/organizations/:orgId/sms/groups`:

- `POST /` with `{participants: ["+14259700671", "+12068590917"],
  sender_identity_id?, subject?}` creates/reuses a thread. Optional
  `?project_id=...` attaches a new thread to an authorized project.
- `GET /` lists threads; `limit` (1-200), `cursor` and `project_id` are optional.
- `GET /:conversationId` returns a typed group summary.
- `GET /:conversationId/messages` returns bounded, newest-first history with
  optional `limit`/`cursor`, attachments and per-recipient delivery states.
- `POST /:conversationId/messages` with `{text?, image_media_id?, purpose?,
  scheduled_for?, idempotency_key}` sends to the stored full group. Text or a
  validated user-owned JPG/PNG/GIF attachment is required. Arbitrary remote
  attachment URLs, audio-note metadata and changing the recipient set are not
  accepted by this endpoint.

The existing generic API still accepts the complete group recipient set and
configured sender. It applies the same group checks. The dedicated API derives
these details from the conversation to prevent accidental partial replies.

## Phone Texting Surfaces

The phone tray and phone workspace share `Portal.PhoneTexting` for recipient
selection, thread loading, images and replies. New text supports 1-8 unique
phone numbers. One recipient retains the existing project SMS workflow; two or
more create an explicit group MMS conversation through the generic messaging
API with the selected configured sending line and contact display names.
Group replies use the dedicated group-message endpoint, never client-supplied
recipients or an alternate sending line. Legacy bulk threads remain separate.

The inbox merges private SMS threads with the paginated group catalog by ID.
Older group history is loaded on demand. Incoming group authors, images,
participants and per-recipient delivery results are visible in both surfaces.
Attachments reuse the shared user-owned SMS image upload and preparation flow;
an unchanged failed send retains its upload and idempotency key on retry.
Refresh controls reload the conversation explicitly rather than replacing an
unsent draft in the background. Emoji insertion uses the Channels picker.

Browser verification: `node --test tests/phone-group-text-browser.test.mjs
tests/phone-tray-browser.test.mjs tests/phone-modal-browser.test.mjs` in
`public/v1`. These are isolated fixtures, not real provider sends.

## Publications

Provider `comms-sms-groups@1` exports `conversations` and `messages`; both are
typed, paginated and discoverable under Comms. Messages require a
`conversation_id` argument. Organization and project targets are supported;
project reads are restricted to the target project. Data uses `view_comms` and
fresh organization/branch/project/feature checks, including frozen snapshot
replay. Organization lists reauthorize each thread's current project, omitting
inaccessible or deleted projects even when the thread's original branch matches.
Pagination advances across scanned rows, including omitted rows. No provider
responses, callback credentials or consent evidence are
published. Snapshot provenance retains viewer and conversation identities.

- `comms.smsGroup.create@1`: write effect, required receipt, input mirrors group
  creation. A project target attaches project context. Creation grants no consent.
- `comms.smsGroup.send@1`: external effect, required receipt; `target.id` is the
  conversation. Input contains text/image/purpose/schedule only. Full member and
  sending-line details come from the authorized thread. Project ownership is
  checked before receipt replay as well as execution. No trusted-system bypass
  is published; API, agent, module and Work callers need a current human context.

Both actions belong to `send_communications`, retain immutable implementation
identity and delegate to the same domain services as HTTP. Shared bootstrap
registers them for every execution host.

## Delivery Safety

One message owns one delivery row per recipient. Exactly one leader is eligible
for submission; followers remain `group_pending` until a transaction claims the
whole group. The worker checks the original sending line's fully provisioned
campaign, every recipient's purpose-specific consent, development allowlist and
per-recipient billing allowance. One ineligible member fails the whole unsent
group; it is never silently reduced or converted into individual sends.

The worker makes one `POST /v2/messages/group_mms` request. Scheduling stays in
FirstMate until due because this Telnyx endpoint has no scheduling field. Shared
provider group identifiers and recipient identifiers are distinct. Communications
storage initialization adds group lookup indexes and splits provider-ID uniqueness:
individual sends remain globally unique; group sends are unique per recipient.

Signed callbacks correlate by group ID, local number, organization and recipient,
with the signed delivery callback token anchoring events arriving before POST
completion. Callback acceptance persists the shared identifier on every sibling.
Duplicate/out-of-order events cannot downgrade terminal delivery results or meter
cost twice. Telnyx `unknown` final status becomes `delivery_unconfirmed`, not
`delivered`. Combined multi-recipient webhook cost is recorded once; individual
recipient callbacks retain separate cost entries.

Timeouts, network/5xx ambiguity and expired submitting leases do not automatically
resend. Definitive retryable rejection may retry the leader only. Known group IDs
reconcile via `GET /v2/messages/group/{message_id}`. Missing group IDs remain
explicitly uncertain for investigation. STOP suppresses all remaining unsent
group members; already provider-accepted group sends cannot be canceled or unsent.
Inbound group messages notify users but do not run one-to-one appointment or AI
auto-reply workflows.

## Verification And Activation

Run `npm run check`, `npm run test:publication`, `npm run test:messaging` and
`npm run test:group-mms:postgres` in `public/v1`. Group tests exercise HTTP,
publication schemas/receipts, tenant boundaries, stable participant identity,
pagination, signed early callbacks, inbound `cc`, per-recipient cost/status,
uncertain submission, STOP and shared PostgreSQL claims/indexes/lease recovery.

Development delivery remains in capture mode. Deploying these contracts does
not submit registration, enable live messaging or send a test message. Real
delivery still requires carrier-approved registration and an activated worker
release with the shared messaging configuration.

Provider contracts: [Telnyx group messaging](https://developers.telnyx.com/docs/messaging/messages/group-messaging)
and [Telnyx MMS support](https://support.telnyx.com/en/articles/8255134-group-messaging-bulk-sending-mms).
