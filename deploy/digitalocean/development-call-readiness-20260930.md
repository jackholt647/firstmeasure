# Development call readiness — September 30, 2026

Source: `fd4e70334953b66ea1362925b10f516b552b51c8`.

The Willow Puffin Test Co device diagnostic passed microphone access but never
connected its Telnyx staff leg. Both recent diagnostic calls ended with
`PROVIDER_REJECTED`; their saved result reported inconclusive connectivity and
no metrics. Repeating the rejected provider request with the original command
ID returned HTTP 422, code 90029: `time_limit_secs` must be at least 30. The
application requested 25. The diagnostic now uses 30 seconds; its existing
server-controlled early hangup remains in place.

A live provider smoke check accepted a 30-second call to a temporary staff SIP
credential. The call was ended and the credential removed. No customer phone
was dialed. This confirms provider acceptance, not two-way browser audio.

The shared phone runtime now opens a readiness dialog from both Phone setup
and Start call. It shows five steps (registration, microphone, test audio,
quality measurements and saving), elapsed time, microphone permission guidance,
expected waits, and actual measured latency, jitter and packet loss. Results
include a specific reason and Run checks again. Hiding the dialog allows the
check to continue. Retry is enabled after cleanup. No customer is dialed and
voice is not recorded by this check.

During the media wait, the runtime polls the diagnostic record and stops early
on provider failure. Saved verdicts now distinguish microphone denial, missing
hardware, provider rejection, media connection failure and missing quality
measurements. Phone setup adopts the latest shared diagnostic result, including
results produced by retrying inside the dialog.

Validation: 36 customer-call tests, the Chromium call workspace regression,
frontend syntax checks and TypeScript check passed. Additional assertions cover
granular diagnostic reasons and the provider's duration minimum. Browser
coverage includes the visible in-progress microphone step, Allow guidance,
denied permission, retry, measured success, expired checks and early provider
failure. Provider/media behavior in the browser regression is simulated.

Deployment overlays only the two communications frontend scripts and
`comms/calls/voice.ts`, `comms/calls/settings.ts` with their compiled output onto
verified development role baselines. The report worker receives backend files
only. Immutable source, hashes, baseline guards, readiness and isolation checks
are required; unrelated live source and Telnyx configuration are preserved.
Receipts are in ignored `output/call-readiness-20260930`.

Concurrent development releases required fresh audits immediately before each
role activation. Baseline guards stopped stale staging/activation attempts.
Owned source must match the audited pre-change source or the desired source;
other source is retained from each role's actual live release. A newer web
release (`aad93679ad9512672be397e6e7142cf0db3a1d98`) retained this fix, so it was
verified in place using all desired source/compiled hashes and fresh runtime
readiness. Public traffic checks verify the served frontend hashes and healthy
development responses, allowing compatible successor release IDs. Per-role
final manifests are saved as `*-final.json` in the receipt directory.

The readiness dialog's progress and blocked-result states were visually
inspected in Chromium with the actual communications stylesheet. Screenshots
are retained in the ignored receipt directory.

Activation completed on all four roles. Final source/compiled hash and runtime
verification found the fix in the compatible successor web release
`c5d51c9298f4aedde93d489de74acf0b3a843ff9-contact-editor-1`; worker, compatibility
and pool were on `fd4e70334953b66ea1362925b10f516b552b51c8` at final inventory.
The public communications scripts matched the desired committed content and
public readiness remained healthy with development isolation enforced.
An SSH banner timeout on the pool was retried after a fresh audit; it did not
bypass any baseline checks. Production was unchanged.

The pool subsequently moved to the same compatible Contact editor successor
release as web. A fresh audit and source/compiled hash verification confirmed
that it also retained the diagnostic and UI fixes with healthy, isolated runtime.
