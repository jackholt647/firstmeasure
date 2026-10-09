# Development SMS test recipients - October 9, 2026

The development SMS recipient allowlist now contains exactly +14259700671,
+12068590917, and +15099600721 on the web, pool, and compatibility roles.
Release `b600cdc30c813db3234dcf34fa4acb1047101dba` is pushed and active on
all three roles. The request path rejects a live development SMS with any
recipient outside that list before sender resolution or writes. The delivery
worker repeats the guard immediately before provider submission. Capture-mode
SMS remains available for UI and conversation tests without contacting Telnyx.

This is **not live text delivery**. `COMMUNICATIONS_DELIVERY_MODE` remains
`capture`; no test SMS was sent. A read-only Telnyx audit found one enabled
test Messaging Profile, but its only owned number (+12068645766) is not
assigned to that profile or a 10DLC campaign. Pioneer Puffin Test Co
(`org_983c8e17cd313149`) has no SMS compliance profile. The account's two
existing test brands are failed mock registrations, not live senders. Real
delivery requires a verified FirstMate legal-business brand, approved campaign,
number assignment, webhook setup, and recipient consent. No synthetic
business identity or opt-in attestation should be submitted to the carrier.

The active development web, pool, and compatibility processes each passed
local readiness with `sms.mode=allowlist`, `allowed_number_count=3`, and the
development environment-safety check. Public readiness at `dev.1m8.ai`
reported the same release healthy. All three were staged from the exact
`aa9311887b3111267421c692e984e4c76236188b` release, with source and
compiled hashes checked before and after staging. Runtime configuration was
backed up as `development-runtime.env.before-b600cdc...` on web/pool and
`development.env.before-b600cdc...` on compatibility. Rollback must restore
the respective configuration backup along with the previous release symlink.

The separate development worker host remains on its earlier release and was
not changed because this task's SSH identity lacks deployment access there.
Keep live SMS disabled until that worker receives the provider-boundary guard
and passes the same allowlist/readiness checks.

Local TypeScript check/build and the focused development SMS safety tests
passed; the staged compiled tests passed on all three activated roles. The
captured-SMS flow passed in the broader communications suite. One unrelated
email-notification assertion failed in that suite (8 of 9 passed); the
notification list was empty when the test expected a `comms_message` entry.
