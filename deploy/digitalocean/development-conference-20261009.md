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

Local TypeScript check passes. The PostgreSQL concurrency test and three browser
tests pass, including the conference test against the merged development UI.
The staged Linux runtime passes TypeScript check and compilation.
Its new conference suite passes 6/6; the existing call suite passes 33/36.
The three failures reproduce unchanged against the unmodified live baseline:
the diagnostic fixture expects 25 seconds instead of 30, and the canceled-transfer
and withdrawn-consent fixtures lack the newer department-view permission.
No runtime permissions were weakened to accommodate stale fixtures.

Activation details and final readiness verification will be appended after rollout.
