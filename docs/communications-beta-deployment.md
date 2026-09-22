# Communications and customer calling: beta deployment

This implementation unifies customer call lists, call history, follow-ups, scripts, and optional Telnyx browser calling inside Communications. Communications is the single sidebar app; legacy Calls URLs open its Call lists view. Project Communications includes a Calls view and calls in its activity feed. Internal Channels huddles remain independent.

The product specification is [communications-call-center-spec.md](communications-call-center-spec.md). This runbook describes the implemented beta. AI after-call summaries and reviewed action proposals still require completion; do not advertise that feature as available. Automated provider simulations have passed, but a real two-party Telnyx interoperability test has not yet been performed. Do that controlled test before inviting beta customers.

## Deploy with voice off

1. Use the platform's supported Node 22+ runtime with SQLite support. From `public/v1`, install with the existing lockfile, run `npm run check`, `npm run build`, and `npm run test:customer-calls`. Deploy the frontend and backend together, including `public/libraries/vendor/telnyx/webrtc-2.27.10.js` and its license.
2. Preserve the existing Platform, CRM, Work, Channels, and messaging storage. Customer-call tables are added to `MESSAGING_STORAGE_ROOT/communications.sqlite`; recordings live under `MESSAGING_STORAGE_ROOT/call-recordings`. Store these outside ephemeral release directories. Restrict filesystem access and back up the database and recording directory together. Use the application's SQLite backup/checkpoint procedure rather than copying an open database without its WAL.
3. Serve the portal and API over HTTPS. Keep the portal's authenticated cookie/CSRF configuration and same-origin API routing. Reverse proxies must preserve raw webhook bytes and the Telnyx signature headers. Do not publish the recording directory as static files: playback goes through the authenticated, permission-checked API.
4. Initially set `TELNYX_VOICE_MODE=disabled` and `CUSTOMER_CALL_WORKER_DISABLED=0`. The worker is part of the API process and must remain running for manual wrap-up effects too. Use a single API/worker host for the initial SQLite beta; do not place this database on a network filesystem or distribute independent database copies across replicas.
5. Confirm Communications and Calls are enabled for the pilot organization and the intended staff have the appropriate permissions. Management uses `manage_communications` or `manage_company_settings`; calling uses `make_calls` and the existing compatible communication/project permissions. Recording and artifact access have separate `record_calls` and `view_call_recordings` permissions. Branch and project authorization still apply.
6. Verify external-phone mode: open an existing list without creating an attempt, log an explicitly labeled test call, save notes/outcome, select only completed obligations, create exactly one follow-up, and find the call in project/global history. No Telnyx account changes are needed for this mode.

## Import historical calls

Run from `public/v1`, against the intended organization's persistent storage:

```sh
npm run migrate:customer-calls -- --org ORGANIZATION_ID
npm run migrate:customer-calls -- --org ORGANIZATION_ID --apply
```

The first command is a dry run. Review its counts and conflicts before applying. The import is additive and uses stable identities, so repeating an applied import does not create another attempt. It correlates legacy entry results and existing Work/Channels/project evidence; it does not place calls, generate new follow-ups, or infer missing audio/duration. Conflicts return exit code 2 and require review. Keep the original records and backup.

## Activate a controlled Telnyx pilot

Supply these through the deployment secret/configuration mechanism, not source control:

```dotenv
TELNYX_VOICE_MODE=live
TELNYX_API_KEY=<existing server-side Telnyx account key>
TELNYX_WEBHOOK_PUBLIC_KEY=<Telnyx Ed25519 public verification key>
TELNYX_VOICE_WEBHOOK_URL=https://YOUR_API_HOST/v1/comms/voice/webhooks/telnyx
CUSTOMER_CALL_WORKER_DISABLED=0
```

The organization still starts disabled. In **Communications → Phone setup**:

1. Check that the server reports its key, webhook key, and public HTTPS endpoint as configured. The webhook must be reachable from Telnyx at exactly the configured URL.
2. Choose **Prepare Telnyx voice**. This creates an organization-specific outbound profile, Call Control application, and staff credential connection. These are real provider operations. If the provider response is uncertain, setup looks for the deterministic resource name before another create; do not manually repeat resource creation.
3. Connect an organization-owned Telnyx number already provisioned through SMS setup. Use a dedicated test line first. Confirm any existing voice-route replacement explicitly. SMS remains bound to its messaging profile; FirstMate stores the previous voice connection for rollback. Number purchasing and porting remain outside this voice setup.
4. Set the number's branch, business timezone/hours and closed dates, incoming team/ring order, wait/ring time, voicemail or external forwarding, concurrency, maximum call length, allowed countries/prefixes, daily attempts, and provider spend cap. Saving updates an existing provider outbound profile as well as local policy. A failed provider sync blocks new outbound calls until repaired.
5. Enter the service location and acknowledge the alternate emergency-phone requirement. **Emergency short codes are blocked. This beta does not provision E911; entering an address does not activate emergency calling.** Staff must keep a separate emergency-capable phone.
6. If using recording, configure the disclosure and retention policy and confirm the organization has reviewed it. Transcription requires recording. Call recording begins only after staff explicitly records caller consent; pause/resume/stop are available during the call. Voicemail recording follows its voicemail greeting.
7. Enable FirstMate phone for this organization and save. Each staff member connects their own browser under **Call center** or the phone menu, selects audio devices, and runs **Run call readiness check**. Preferences are saved for that account/browser. Another tab cannot take over a fresh endpoint lease.
8. The readiness check uses a short server-controlled SIP leg to the staff browser and real WebRTC media statistics. It does not call a public speed-test number. Missing microphone, failed media, or inconclusive statistics cannot pass as Ready. Recheck after changing networks or devices.

The browser receives a short-lived endpoint JWT. The account API key and SIP password remain off the frontend. Browser-originated dialing is parked; customer PSTN dialing is authorized and initiated on the server. Provider dial commands include maximum duration and stable command correlation.

## Controlled acceptance test

Use a staff-controlled external phone and a dedicated beta line. Record the actual browser, headset, network, timestamps and result. Do not use customer numbers for this test.

| Scenario | Expected evidence |
| --- | --- |
| Outbound answered / busy / no answer | Staff leg connects first; correct customer outcome; both legs end; one history record |
| Incoming during business hours | Correct branch/team rings; accept connects two-way audio; decline advances routing without dropping caller |
| Nobody available / closed hours | Configured fallback; voicemail greeting precedes capture; one missed-call callback |
| Mute, DTMF, hold and resume | Audio behaves as labeled; customer hold uses conference controls |
| Warm and cold handoff; canceled/failed handoff | Correct recipient; customer stays connected; failed or canceled consultation returns to original teammate |
| Consent granted, paused, resumed, withdrawn | No capture before consent; withdrawal stops capture; accurate recording controls |
| Recording/transcript delivery | Authorized playback and range seeking; transcript linked to the call; unauthorized user denied |
| Browser disconnect / expired session / second tab | Clear failure; orphan legs cleaned up; no duplicate outbound call or stolen endpoint |
| Reload and browser Back/Forward | Same call/script/notes restored; closing does not produce an empty call panel |
| Repeated Save outcome and delayed response | One outcome and one successor task; original obligations completed only when selected |
| Project and contact integration | Context retained, appointment/message/project links work, history appears on the linked project |
| Existing channels | Existing email, SMS, web chat, Channels huddles, and call-list workflows still work |
| Usage and recording expiry | Provider cost correlated by leg; expired media unavailable and deleted; SMS configuration retained |

Start with a small staff roster and low limits. Capture real media/transfer/voicemail evidence before expanding. Browser/network interoperability cannot be established by the simulated backend tests alone.

## Operations and recovery

**Phone setup → Voice health** reports delayed jobs, failed or uncertain work, and resources needing repair. Its API is `GET /v1/comms/organizations/:orgId/voice/health`, restricted to communications managers. Provider usage is a cost ledger, not a customer invoice: missing cost is unknown, and this change does not add markup or bill tenants.

- **Uncertain dial or call control:** use **Check provider status** on the call. Reconciliation reads known provider legs and correlates exact operation evidence. It never blindly replays a paid dial. If no provider call ID was returned and no signed webhook arrived, inspect the named operation in Telnyx and restore webhook delivery. Keep the call unresolved until its result is established; there is intentionally no “retry dial” bypass.
- **Failed saved work:** after correcting the underlying storage/configuration issue, use **Retry saved work**. It resumes the same wrap-up/recording/missed-callback job and its effect checkpoints. The API `POST .../calls/:callId/retry-work` accepts `job_id` only for these background kinds; provider commands cannot be retried through it.
- **Provider policy mismatch:** correct the reported configuration and save Phone setup again. This retries the outbound-profile sync before persisting changed local settings.
- **Provisioning response lost:** retry Prepare once the provider inventory is available. The deterministic name must resolve to exactly one resource. Zero/multiple matches stay unresolved for operator investigation.
- **Phone in another tab:** disconnect it there, or allow the stale heartbeat lease to expire. Finish active calls before changing devices or renewing credentials. Idle/expired credentials are revoked by maintenance.
- **Webhook delivery failure:** inspect Telnyx delivery logs and API logs. Signatures cover timestamp plus the exact raw payload. The receiver durably stores valid events before returning 202, deduplicates event IDs, and scrubs completed payloads. Monitor pending/failed `customer_voice_webhooks` globally from the trusted operations environment; that global queue is not exposed to arbitrary tenant managers.
- **Private storage unavailable:** restore disk access/capacity before retrying ingestion. Recording downloads are bounded and authenticated playback is private. Never make the directory public as a workaround.
- **Retention:** maintenance expires recordings and related transcripts and retries provider deletion. Tombstones prevent delayed provider delivery from resurrecting deleted artifacts. Keep the worker active; disabling voice can defer provider-side deletion until provider access is restored.

## Roll back phone service without losing history

1. Stop taking new calls and finish or transfer active ones. Set staff unavailable.
2. In Phone setup, disconnect each beta number while provider access is still enabled. Verify Telnyx shows the original voice connection. The disconnect operation refuses to overwrite a route changed outside FirstMate.
3. Disable the organization's FirstMate phone setting, then set server `TELNYX_VOICE_MODE=disabled` if needed. Keep the API/background worker running for external-call outcomes and retained records.
4. Preserve call data, Work links, scripts, recordings, and migration evidence. Continue lists and follow-ups using external phones. Do not release SMS numbers or delete legacy tables.

The global voice switch stops provider submissions; it does not independently restore a number's Telnyx route or terminate already-connected media. If an outage prevents normal disconnect, route the pilot number in Telnyx to the known alternate destination and document that change before disabling the service.
