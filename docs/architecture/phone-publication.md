# Phone Settings: data, actions and triggers

October 11, 2026. This contract covers the unified Phone Settings, static tracking
numbers, number porting, outgoing voicemail drop, power-dial number pools and
cached Telnyx reputation monitoring. Registration is in the shared publication
bootstrap, so API, assistant, document modules and user-backed Work consumers
receive the same contracts. Source publication is distinct from activating a
release on development servers; see the [release record](../../deploy/digitalocean/development-phone-extensions-20261011.md).

## Typed data

Provider `phone-settings`, version `1`, owns these 13 exports. All targets use
`scope: organization` and the authenticated organization ID. Single-record reads
use `target.id` as described below. Lists use bound keyset cursors, a default page
size of 50 and maximum of 200. Singleton settings and the report are read-only
operations without list pagination. Reads never provision an organization,
contact Telnyx, enqueue work, refresh scores, reconcile billing, or save settings.

| Export | Record ID / content | Authority |
| --- | --- | --- |
| `personal` | Omit ID or use own user ID; hours, availability, notifications, greeting, outgoing voicemail drop, power-dial pool and limits | Authenticated phone user, own preferences only |
| `line` | Owned E.164 number; status, label, branch, routing, group/user/department assignments, SMS assignment status and tracking campaign | Communications/company manager for the stored line classification |
| `group` | Local group ID; members, departments, work/after-hours routing | Manager for the stored group |
| `messaging` | Omit ID or `default`; delivery windows, contact timezone rules, expiry, reply cancellation and automatic replies | Organization communications/company manager |
| `lead` | Local inquiry ID; caller, first/last touch, source calls, contact/project and qualification | Manager for inquiry, access to both source calls and linked project |
| `tracking_report` | `args.from`, `args.to`: ISO range, exclusive end, maximum 366 days; source totals, calls, attributed leads and selectable projects | Organization manager plus resource authorization |
| `port` | Local port draft ID; number, label, branch, local/provider status | Manager for the stored port |
| `order` | Local purchase order ID; number, label, branch, status | Manager for the stored order |
| `reputation` | Owned number; monitored state, nullable risk/scores, score timestamp and last 30 cached observations | Manager for the number and its line classification |
| `reputation_settings` | Omit ID or `default`; business/LOA approval, check frequency, last sync and safe error | Organization manager |
| `greeting` | Own uploaded recording ID; name, owner, content type | Recording owner only |
| `voicemail` | Call ID; handled state and revision | Call access, recording permission and retained ready voicemail |
| `billing` | Owned number; recorded accepted carrier monthly/upfront costs and currency | Platform billing viewer/manager or billing manager |

`line.revision` is the editable line configuration revision (zero before it is
configured), not the underlying number provisioning revision. All settings reads
return the revision to supply when saving. Provider content hashes also cover
status fields owned by other records. Missing personal/messaging settings return
the documented defaults with revision zero without creating a record.

Existing `customer-calls.record`, `.recordings`, and `.transcripts` now use schema
version `2`. Their additive `phone` field publishes power-dial selection, outgoing
voicemail delivery state/time, and the call's immutable tracking campaign
snapshot. Media continues through the existing authenticated, retention-checked
recording/transcript exports. No raw metadata, provider IDs, audio bytes, signed
greeting URLs, storage paths, carrier account/PIN fields or authorization documents
are published. Greeting IDs are local selectable references, not playable URLs.

Frozen captures retain viewer/source identity and reauthorize the captured record
on replay. Voicemail checks source retention again. Attribution reports recheck
the captured call, inquiry and project IDs, not merely the current report results.
A different viewer, revoked permission, removed source or expired recording
cannot revive a previously captured value. Project/department checks use stored
resources, not consumer-supplied filters.

## Business actions

All IDs below have prefix `phone-settings.` and version `1`. They are writes,
require command mode and a durable idempotency key, and work from authenticated
API, agent, module and Work contexts. They reuse the UI's domain writers. Bare
system grants are not accepted. Current target authorization happens before
receipt replay, including voicemail retention. The implementation identity is
bound to the backend artifact; consumers must not substitute a different artifact
for a pinned unavailable implementation.

| Action | Target / input | Effect |
| --- | --- | --- |
| `personal.save` | Own user; personal settings and `revision` | Work hours, notifications, greeting, drop and power-dial policy |
| `line.save` | Owned number; complete line settings and `revision` | Assignments, routing, per-line SMS policy and tracking |
| `group.save` | Existing or new local group ID; group settings and `revision` | Ring/department membership and routing |
| `messaging.save` | `default`; `policy`, `revision` | Organization message windows and automatic replies |
| `lead.save` | Inquiry ID; `project_id`, `status`, `revision` | Qualification (`new`, `qualified`, `converted`, `spam`) and project link |
| `voicemail.handle` | Retained voicemail call ID; `handled`, `revision` | Shared handled state |
| `port.draft` | Organization; `phone_number`, `label` | One local draft keyed by the execution receipt; no carrier request |

Settings saves replace the documented configuration; omitted fields take schema
defaults. Read, edit and send the complete object to preserve existing choices.
A stale revision fails instead of overwriting concurrent changes. Zod refinements
(timezone validity, split overnight hours, distinct IVR digits) run before receipt
acquisition; domain checks validate active members, departments, routing loops,
allowed destinations, uploaded recording ownership and active assigned pool
numbers. Action receipts retain only record ID and revision, not private content.

Example: read `phone-settings.personal`, update `power_dial` or `voicemail_drop`,
then invoke `phone-settings.personal.save` with its revision. The same runtime
phone services consume that stored policy on the next call. A settings change
does not interrupt an already-created call's captured policy.

## Automation triggers

The central Work event catalog registers 18 triggers. Every payload is validated
against `phoneEventPayload` before queueing and delivery. Events are internal
`system` events: discoverable to automation authors, hidden from ordinary activity
feeds and never customer-portal events. Existing missed-call/voicemail notification
preferences still govern their dedicated user notifications.

| Trigger | Published when |
| --- | --- |
| `phone.line.updated` | Assignment, routing, messaging or tracking configuration changes |
| `phone.group.updated` | Ring/department group settings change |
| `phone.personal.updated` | Own phone preferences change |
| `phone.messaging.updated` | Organization sending policy changes |
| `phone.lead.updated` | Attribution, qualification, project/contact link or classification changes |
| `phone.port.updated` | Local/provider port status or pending carrier action changes |
| `phone.order.updated` | Purchase order status changes |
| `phone.number.updated` | Number status, branch, label or legacy assignment changes |
| `phone.reputation.updated` | Cached approval, monitoring frequency or sync error changes |
| `phone.reputation.number_updated` | Enrollment or cached reputation data changes |
| `phone.voicemail.handled` | Handled state or handler changes |
| `phone.sms.updated` | Number campaign/profile assignment or carrier assignment status changes |
| `phone.call.created` | Customer call creation is accepted |
| `phone.call.connected` | Customer connection is confirmed |
| `phone.call.ended` | Call ends, including final drop outcome |
| `phone.voicemail.received` | Voicemail recording ingestion completes |
| `phone.voicemail_drop.started` | Correlated customer machine/beep initiates playback |
| `phone.voicemail_drop.finished` | Handling completes, is interrupted/skipped, fails, or is uncertain |

Payload fields: `schema_version: 1`, `occurred_at`, `resource_id`, `revision`,
`branch_id`, `project_id`, `department_ids`, `changed_fields`, `status`,
`previous_status`, `call_id`, `user_id`, `phone_number`, `direction`,
`voicemail_drop_state`, `source`, `medium`, `campaign`, `ad_id`, `spam_risk`,
`previous_spam_risk`, `monitored`, `handled`. Inapplicable strings are empty;
inapplicable booleans are false. Configuration triggers carry changed field names,
not greeting text, recordings, credentials or entire settings. Reputation
conditions can compare risk directly; lead conditions can inspect `status` and
`changed_fields`. Read authorized exports for full details. `phone.call.ended`
is distinct from existing `call.completed`, which remains the wrap-up/disposition
contract and is not emitted a second time by this bridge.

Resource changes and call-log events write `phone_event` jobs atomically in the
existing communications transaction. Duplicate call-log IDs create no second job;
unchanged business fields and poll timestamp/lease-only updates create no event.
The dedicated `events` worker lane cannot block voice control or wrap-up work.
Delivery inserts a Work event using `phone:<job ID>` as its durable idempotency key.
A crash after Work insertion and before job acknowledgment safely reuses that
identity. Temporary errors follow the existing bounded background retry policy
(up to eight attempts); exhausted failures remain visible as failed call jobs.
No new database tables or migrations are required. Existing PostgreSQL transaction
locking protects resource revision and job creation together.

No new automation handler is needed: these are cataloged Work events, while
published actions are invoked through the existing authorized action/module
binding mechanism. Existing condition and sequence contracts are unchanged.
Organizations without expanded Work access follow the engine's existing disabled
event behavior; enabling Work later does not replay earlier disabled events.

## Dedicated flows and limits

Carrier number searches/purchases, port submission/confirmation/cancellation,
carrier documents and account details, SMS campaign enrollment, paid reputation
enrollment/refresh/frequency updates, media uploads, and platform subscription or
payment changes remain dedicated authenticated flows with their existing explicit
confirmation and development restrictions. They are not arbitrary provider
proxies in the actions catalog. `port.draft` prepares the non-billable portion;
`port`/`order`/reputation exports report persisted results. Existing 10DLC
registration stays in its current dedicated compliance flow; line campaign
assignment status is published. Billing data here is accepted carrier number cost,
not subscription management, a live quote, reconciliation or a new billing engine.

Attribution is static tracking-number attribution; dynamic number insertion and
browser session identity are not implemented by these contracts. The report uses
first-touch source for new-lead totals and current qualification state. Existing
report semantics and source ranges are preserved.

## Verification and release dependency

`tests/publication-phone.test.ts` covers schema-safe exports, read purity,
permissions, cross-tenant and own-user access, receipts/revisions, real settings
writers, frozen replay and expired voicemail, attribution, transactional rollback,
event idempotency, polling noise and independent worker lanes. The same suite
supports `TEST_POSTGRES_URL` for PostgreSQL validation. Existing publication,
automation, call, phone, messaging and webhook suites remain required.

The earlier `5ead8527` candidates do not contain this publication audit. Rebuild
all serving roles from the current source plus their verified live baseline.
Activate the compatible worker before enabling writers that create `phone_event`
jobs; an older worker treats the new job kind as unknown. Verify registered
provider/action/event catalogs and one safe local settings update after activation.
Do not describe Git publication as live development deployment.

Audit verification on the integrated source: TypeScript clean; 80 publication tests
passed with one database-specific skip; 123 focused regression tests passed; all
13 embedded PostgreSQL checks passed (including the SQLite-skipped case and all
11 phone publication tests). The publication run used an isolated outer storage
root to avoid a pre-existing custom-fields fixture's early environment import.
