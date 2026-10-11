# Unified phone settings

Settings now calls the call-list configuration **Call Lists** and the former SMS page **Phone Settings**. Existing SMS-only tenants retain their registration flow. The comprehensive workspace covers personal hours and greetings, line assignments, department ring groups, routing, voicemail, sending policy, tracking numbers, carrier porting and existing billing.

## Runtime behavior

The customer-call resource store holds versioned `phone_personal`, `phone_line`, `phone_group`, `phone_messaging`, `phone_greeting`, `phone_lead`, `phone_port`, `phone_order`, `phone_sms` records. Existing SQL storage initializes these without a destructive migration. Writes reject stale revisions; authorization uses existing organization and department permissions. Existing 10DLC registrations and their compliance gates remain authoritative.

Incoming calls snapshot tracking attribution before routing. Configured lines resolve line routing, group routing, individual settings, then company defaults. Personal availability/hours exclude off-duty members. Destinations include users/groups, external forwarding, voicemail, announcements and keypad menus. Strategies include fixed order, longest idle, round robin and simultaneous ringing. A transactional winner claim disconnects late simultaneous answers. Queue limits, timeouts, holidays and after-hours destinations are enforced by the call worker. Existing call recording consent, retention, disposition and transcription policies continue to apply.

Voicemail greetings can be spoken text, uploaded MP3/WAV, or a browser recording converted to mono WAV. Carrier audio URLs are signed and expire. Shared mailbox media requires recording permission, not merely call access. Individual text/missed-call/voicemail/push choices feed the existing notification system.

Scheduled outbound SMS remains locally queued until due so consent, sender authority, active registration and current sending hours can be checked at dispatch. Contact-local windows honor the contact time-zone tracking setting and an explicit unknown-zone hold/fallback. Policies support expiry, cancellation on reply/workflow completion, manual-message inclusion and consent-gated automatic replies with cooldowns. Additional sending lines attach to approved 10DLC registrations and verify carrier campaign assignment at dispatch.

## Attribution

A dedicated static number identifies an advertising source, medium, campaign, ad ID and landing page. Calls retain an immutable snapshot; first/last lead touches tolerate duplicate/out-of-order processing. Unambiguous existing project matches receive attribution. Reports include calls, unique callers, answered/missed calls, voicemail, talk time and qualified/converted inquiries, with CSV export and manual lead/project association. Conversion counts describe current outcomes for inquiries first seen in the selected interval. This is static-number attribution; dynamic website number substitution, visitor/session matching and ad-platform conversion uploads are separate integrations.

## Carrier operations

Telnyx contracts were checked against its official OpenAPI specification. Port requests support local drafts, portability checks, carrier drafts, account/service-address details, requested activation date, LOA/bill/CSR uploads, requirements/status refresh, explicit submission and cancellation. PIN/account inputs go directly to Telnyx and are not stored in local resource JSON. Uploaded documents are linked immediately. Port completion imports the owned number and verifies voice routing; SMS authorization remains a separate registration step. Ordinary ports are not force-activated using the FastPort-only activation endpoint.

Purchases require a fresh matching carrier quote and a durable customer reference. An ambiguous purchase/port submission is reconciled by that reference before another POST can occur. Development blocks carrier purchases, port submissions and new SMS registration assignments; local drafts and existing sandbox lines remain usable. No customer number or paid carrier action is exercised by automated tests.

Billing uses existing invoices/subscriptions and real carrier usage records. No customer price or new recurring charge is invented from carrier cost. Status/requirements refresh is user initiated. Browser endpoints retain the existing one-active-device-per-user design; native mobile push ringing is outside this change.

## Deployment and verification

Deploy the additive API and workers together. An older worker must not consume the new `phone_attribution` and `phone_notice` job kinds. Preserve each development role's actual live baseline and compiled dependencies. No production activation is authorized by this task.

Focused tests cover authentication/tenant isolation, revision conflicts, membership/loop validation, DST and missing-zone windows, ordered attribution, simultaneous-answer arbitration, signed audio, development carrier isolation, mocked Telnyx port recovery/documents and after-hours routing. The browser test exercises real form submissions against mocked HTTP contracts, existing 10DLC handoff, billing navigation and mobile bounds. Live carrier audibility and an actual transfer require a separately authorized test number.

The broader communication suite has a pre-existing email-notification visibility failure, reproduced with the original notification module from `f7b6dd78`. It is not hidden by changing that assertion.


## October 11: outgoing voicemail, dialing pools, reputation

My Phone now saves a separate outgoing recording and opt-in voicemail-drop scope
(power dialing or all browser calls). Creation snapshots the recording. Only the
customer carrier leg requests Telnyx premium AMD. The conference waits for a
human result; a confirmed beep starts a single durable playback command. Unknown
results or 45 seconds without a confirmed beep connect the caller normally. A
correlated `call.playback.ended` with `status=completed` records delivery and ends
the customer leg. Duplicate, canceled, inbound and late events cannot start a
second drop. Provider uncertainty is recorded, not retried blindly. Existing
wrap-up requirements still apply. These are audio calls placed by an available
user, not ringless voicemail.

Personal power-dial pools use owned, active, assigned numbers in the correct
branch. Selection and call creation share the SQL transaction/advisory lock.
Round robin chooses the least recently used number; least-used chooses the
fewest outgoing attempts over the rolling 24 hours. All browser outbound calls
count, including manually placed calls. Per-number limits, cooldowns and optional
high-risk exclusion pause the dialer if no number qualifies. Permissions and
number ownership are checked again before carrier dispatch. The chosen number
is retained on the call and stable under request retries. Existing suppression,
call capacity, device readiness and outcome requirements remain enforced.

Reputation uses Telnyx enterprise-scoped APIs. Platform operators must configure
`TELNYX_REPUTATION_ENTERPRISES` as a JSON object mapping organization IDs to
approved Telnyx enterprise IDs in the existing role environment configuration.
Each enterprise must map to exactly one organization; tenant users cannot select
arbitrary enterprises from the shared carrier account. Before binding, complete
Telnyx enterprise registration, account-level terms acceptance, and signed LOA
approval. Both reputation `status` and `loa_status` must be approved. This carrier
onboarding is an external prerequisite, not automatically submitted by this UI.

Managers can enroll/remove their active numbers, change the carrier's monitoring
schedule, sync cached results, and request a confirmed billed refresh. Telnyx
runs the scheduled checks. The existing voice maintenance worker polls cached
inventory every 15 minutes and stores the last 30 score snapshots, timestamps,
and errors. Polling uses the list endpoint: a single-number GET could cause a
billed first lookup even without `fresh=true`. The UI shows actual nullable
scores and their carrier update time. Cached high-risk results remain excluded
until refreshed or the user disables that preference; unknown results are not
claimed to be healthy. Development prevents enrollment, fresh lookups and
frequency changes. No real carrier enrollment or calls were used during tests.

No schema migration is required: settings, score snapshots and durable work use
existing tenant-scoped voice resources and call jobs. Web and worker must be
released together because the worker consumes new voicemail detection jobs.

Provider references checked October 11, 2026:
- https://developers.telnyx.com/docs/voice/programmable-voice/answering-machine-detection
- https://developers.telnyx.com/docs/number-reputation/phone-numbers
- https://developers.telnyx.com/docs/number-reputation/settings
- https://developers.telnyx.com/docs/number-reputation/quickstart

## Shared publication contracts

See [Phone Settings data, actions and triggers](phone-publication.md) for the typed
exports, permission-checked domain actions, durable event bridge, dedicated carrier
flows, tests and coordinated worker rollout dependency.
