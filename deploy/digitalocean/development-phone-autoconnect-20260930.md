# Automatic browser-phone connection — September 30, 2026

Development-only source: `8ce56b346d45dafc6c99ebfbc045e9b92c65bc07`.

Opening the enabled phone starts registration. Starting a browser call waits for
the same connection with a Connecting status before submitting the call once.
Browser calling stays selected while offline; external-phone notes remain an
explicit option. The phone menu no longer asks users to connect or disconnect.

Closing an idle phone disconnects its SDK immediately and releases the endpoint
lease. Closing during token issuance or registration cancels the pending start.
Late callbacks cannot revive a closed connection. Reopening waits for lease
cleanup. Minimized, floating and docked phones retain their connection; closing
an active browser call continues to minimize it without ending the conversation.
Required outcomes and first-device audio readiness checks remain enforced.

Validation: JavaScript syntax and six focused browser tests, including delayed
registration, a single queued call, close during token issuance and SDK readiness,
late events, reopen, minimized connectivity and local cleanup when the server is
unreachable. Existing tray layout, app groups, outcomes and readiness tests pass.
All automated calls use fixture APIs; no live call was placed.

The immutable frontend overlay preserves each role's live baseline, including
concurrent releases. Compatibility retains its role-specific manifest entries.
Worker, provider configuration, database schema and production are unchanged.
Evidence and role-specific previous release paths are in ignored
`output/phone-autoconnect-20260930/`.

Rollback: inspect subsequent releases first. Restore each affected role's recorded
previous immutable symlink, restart its development service and verify readiness
and outbound safety. There is no database migration to reverse.

Activated web, compatibility and pool to
`8ce56b346d45dafc6c99ebfbc045e9b92c65bc07` from
`f18a958008fd0d425640402f6c289ec345fdde52`. Worker remains
`1e0858b281c905950e7d6476d67357d77f37e123`. Each service passed readiness.
Four served asset hashes matched across four requests each. Public readiness
reported the new development release with outbound safety enforced. Unauthenticated
voice status and contacts returned 401. The two connection/readiness browser tests
passed again against the served runtime and UI assets.
