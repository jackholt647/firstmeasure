# Development call workspace fixes — September 30, 2026

Source commit: `225ed4f5f42bedec3ac21fdffd6d337af435c03a`.

The call workspace X button previously silently minimized every nonterminal
call. External-phone note records remain in `created` until wrap-up, so X could
never take the user to the outcome form. X now expands unfinished owned calls,
preserves notes and outcome choices, explains Save outcome, and focuses the
outcome selector. For a browser call it requests hangup first and presents
wrap-up after the server reports the call ended. Saved records close normally;
observing another user's call does not send hangup.

Start call now offers Run checks before the first browser call on this device.
It uses the existing microphone and Telnyx media-path diagnostic, retains the
call form, displays failures with a retry button, and returns to Start call
after a ready or degraded result. Passing the check does not automatically
dial. A server `device_check_required` response returns to the same actionable
check flow, including when a previously accepted check expires.

Validation: customer-call frontend syntax checks and the Chromium regression
test `public/v1/tests/customer-call-workspace-browser.test.mjs` passed. The
browser test covers minimized external notes, retained outcome choices,
explicit wrap-up, saved-record close, microphone denial, retry, successful
checks without dialing, expired diagnostics, and browser X hangup/wrap-up.
Its provider is a fixture; this is not evidence of real two-way call audio.

Deployment uses an immutable committed frontend file overlay over each verified
live development role baseline. Only
`public/libraries/apps/comms/calling-runtime.js` is replaced. Web, pool and
compatibility receive the frontend; the report worker needs no change.
Unrelated source, runtime settings, Telnyx resources and development isolation
are preserved. Activation requires baseline and hash checks and fresh readiness;
failure rolls the affected role back to its previous release.

Previous role release at final inventory:
`66a53b38e324fd954901f98976f89bf954fbbb7f` on web, pool and compatibility.
An overlapping development rollout changed the earlier baseline. Activation
was stopped by the release guard and all roles were re-audited before restaging.
Deployment receipts are in ignored `output/call-workspace-20260930`.

Activation completed on web, pool and compatibility with readiness, isolation
and deployed-file hash checks passing. Public readiness returned the new release,
and the public call runtime matched the committed source byte-for-byte after
line-ending normalization (SHA-256
`e26dae6493946e8ff667f0ce2248226bee976c0edc527b5a2cf1e58cf9b18a20`).
