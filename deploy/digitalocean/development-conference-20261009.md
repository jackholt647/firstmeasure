# Conference calling - October 9, 2026

Adds an in-call Add person dialog for available teammates and external numbers
or contacts. The existing Telnyx conference carries all participants; no second
browser phone session is created. Hosts can cancel invitations/remove guests;
guests can mute themselves or leave without ending the customer's call.
The six-person limit includes pending guests and supervisor sessions.

Reservations, participant state, operation idempotency and tenant scoping use
the existing calls store. Signed events correlate each invited leg, protect
against late answers after cancellation and resolve uncertain submitted dials
without redialing. Guest failures never end the parent call. Hold/resume includes
guest legs, transfers require removing guests first, and a guest cannot start
another call or device diagnostic while joined.

## Integration baseline

Local feature source starts at f6a071a0f4b39f8f03958151511d992e093ca743.
All development roles reported abe9017333edf16c216a1f0a226bb2beb5ececc4.
That deployed source additionally contains department authorization, call
analysis, automated dialing and supervisor controls. The adjacent patch is the
reviewed, reproducible feature delta against that live baseline, preserving
those newer features. It also prevents concurrent guest/supervisor sessions and
reserves supervisor capacity. Do not replace the newer live files with the
older branch's complete versions. Compatibility's unrelated manifest
differences must remain intact.

The release is development only. No schema migration, credentials, user data,
production activation or live carrier test is part of this change. Existing
development PSTN redirection remains enabled.

The integration patch uses LF line endings. It passes
`git apply --ignore-space-change --check` against the live release; normalize
the touched source files to LF before replay to reproduce the staged bytes.

## Verification and rollout

Local TypeScript check and all 42 customer-call tests pass. The PostgreSQL concurrency test and three browser
tests pass, including the conference test against the merged development UI.
The staged Linux runtime passes TypeScript check and compilation.
Its new conference suite passes 6/6; the existing call suite passes 33/36.
The three failures reproduce unchanged against the unmodified live baseline:
the diagnostic fixture expects 25 seconds instead of 30, and the canceled-transfer
and withdrawn-consent fixtures lack the newer department-view permission.
No runtime permissions were weakened to accommodate stale fixtures.

## Activated release

Code commit `c0fa1e6f8020d99d0151df9ee394ef8139880ed8` was pushed on
`codex/pioneer-puffin-feed-photos` and activated on development web, pool and
compatibility. Each role passed readiness with development outbound protection
enforced. Public `https://dev.1m8.ai/v1/health/ready` reported the same release
and healthy PostgreSQL, artifacts, legacy state and environment safety at
2026-10-09 15:30 UTC. Production was not touched.

Each role was staged from its existing release. Web/pool source and runtime
checksums match. Compatibility retains its unrelated manifest differences;
its hardlink-staged files were unlinked before replacement, and the old release
checksums were rechecked before activation. Services and PHP-FPM were restarted
with readiness-gated rollback to the prior symlink.

The common source/runtime archive SHA-256 is
`462e58a3e3aa94861ddbff31972ceee46e29e28f2fb93e78d226d23e9ab68d49`.
Each activated directory has `phone-conference-runtime.sha256`; all entries
were verified after activation. The publicly served calling runtime matches
`1e1cc4beb52f7a542718786b57cf9ae0297c265911739a94e2064348266387de`.
Web/pool manifest SHA-256:
`17de09fedec804ec771ef65d8527c647e9d2fc3798ac1874633d92454be7ac24`.
Compatibility manifest SHA-256:
`507b424d57dab1896e862adcd0960cfc965f0015b68abef5c2631422022a429b`.

No live multi-person carrier call was placed. Provider request/event behavior
was exercised with test doubles. Development external calls continue to route
to +14259700671; teammate invitations use their assigned browser SIP endpoints.
