# Willow Puffin development voice sandbox

User-authorized target: `https://dev.1m8.ai`. The selected sandbox is
**Willow Puffin Test Co 2c0485** (`org_42f8a856f0c87909`). Production is outside
this change. This uses real Telnyx voice service and a dedicated purchased line,
not simulated carrier calls.

## Configuration

- Dedicated US number: **+1 206-864-5766**. Telnyx quoted $1 upfront and $1/month.
- Only the user's approved controlled phone, ending in **5049**, is permitted
  as an outbound PSTN destination in development. The complete number is kept
  in private runtime configuration and this sandbox's test call-list entry.
- One concurrent customer call, five-minute maximum, ten attempts per day,
  and a $1/day provider calling limit. US destinations only.
- Live-call recording, transcription and AI summaries are disabled. The
  configured unavailable-agent fallback is the disclosed test voicemail.
- The user supplied the service address and confirmed using a separate
  emergency-capable phone. This beta does not provide E911.
- An organization-specific Call Control application, outbound voice profile,
  and parked staff credential connection were provisioned. The new line is
  registered to this organization and bound only to that voice application.
  No messaging profile or 10DLC campaign was created. Development SMS remains
  blocked.
- **Voice sandbox test** contains the controlled **Call my test phone** entry.

Each existing development service receives private configuration from
`/etc/firstmeasure/development-voice-sandbox.env` through
`90-voice-sandbox.conf`. The existing server-side Telnyx API key is reused;
the public webhook verification key was retrieved from Telnyx. Webhook URL:
`https://dev.1m8.ai/v1/comms/voice/webhooks/telnyx`.

Only compatibility receives `CUSTOMER_CALL_WORKER_OWNER=1`. This explicit
development-only flag enables the call worker in its existing API process,
without enabling the general platform schedulers or adding infrastructure.
Development call/job/webhook queues were empty before enabling the owner.

## Code and validation

Final source release: `047ef15c755ff4b7a6e520830ff11d6c3dd80cc2` on the
canonical branch. Deployment overlays only the three owned backend files and
their verified compiled JavaScript onto each role's reviewed live baseline.
Unrelated releases, runtime assets and workspace edits are preserved.

Real provider provisioning exposed invalid codec names and an underscore in
the SIP username. Staff connections now use Telnyx's `G711U`/`G711A` names and
alphanumeric usernames. Provider dialing and forwarding/transfer commands
enforce the development destination allowlist before making carrier requests.
The Phone setup health query now uses PostgreSQL table discovery on PostgreSQL.

- TypeScript check passed.
- All 36 existing customer-call tests passed.
- Three focused adapter/worker-policy tests passed.
- One isolated PostgreSQL regression passed, covering health before usage
  exists, cost deduplication, and organization isolation.
- Real Telnyx number routing and resource provisioning succeeded.
- Real endpoint credential/JWT issuance succeeded; the temporary credential
  and endpoint were revoked/removed afterward. No tokens were logged.
- The public webhook endpoint rejected an unsigned payload with HTTP 401.

The final release is active on both development web nodes, worker and
compatibility. Per-role source/compiled hashes, readiness and enforced
development isolation passed. Six public readiness responses reached both web
instances with the final release and SMS still blocked. Runtime checks confirm
only compatibility owns the call worker and general platform schedulers remain
off. Voice health is healthy, the dedicated provider route/profile are active,
and the user's queue exposes the callable test entry.

Real browser/headset media, incoming ringing, outgoing answered calls,
hold/resume and voicemail interoperability still require the user's controlled
two-party acceptance test. No PSTN call has been placed by this setup.
Automated tests and endpoint-token issuance do not establish two-way audio.

## Test and rollback

Refresh the development portal, open **Communications → Call center**, connect
the browser phone, allow microphone access, run the readiness check, and set
Available. Call **206-864-5766** from the approved external phone for inbound
testing. Use **Call lists → Voice sandbox test → Call my test phone** for the
outbound test. Finish calls before changing settings.

Disable this organization's FirstMate phone setting to stop new customer calls.
Use the normal disconnect operation to restore the line's previous voice route;
the new line had no previous connection. Keep histories and worker processing
for unresolved outcomes. Do not release the purchased number without the
user's instruction. To revert code, restore each role's recorded previous
immutable release and verify readiness/isolation. Do not enable generic
platform schedulers as a substitute for the explicit call worker owner.

Operational evidence and exact per-role rollback identities are in ignored
`output/voice-sandbox-20260929/`.
