# Oversized Incoming MMS Groups

Source: `f3a961462e1bd8385bab4182067d4b063f186453`, pushed on
`codex/pioneer-puffin-feed-photos`. Development only; production unchanged.

## Behavior

Signed incoming group messages retain complete normalized membership, text and
media without applying the outgoing eight-recipient cap. Groups outside outgoing
constraints expose `read_only` and `reply_block_reason`. No generic, dedicated or
published group send can bypass this by dropping participants.

Tray/modal omit the group composer and offer explicitly named private replies
to incoming senders. The selected sender is shown before sending. The server
derives the sole recipient and original sending line from an authorized stored
incoming message. Private history is separate; group history is unchanged.
Images, emoji, cancellation and unchanged-request retry behavior are shared.

The conversation data export is schema version 2. The new external action
`comms.smsGroup.replyPrivately@1` requires receipts and `send_communications`.
Source ownership, project access, image ownership, consent and registration
safeguards remain in the shared domain service. Existing SMS idempotency hashes
are unchanged; private operations bind image identity into their own fingerprint.

This preserves oversized MMS that Telnyx forwards, without guaranteeing carrier
delivery of conversations beyond its documented outgoing limit.

## Verification

- TypeScript check passed.
- Messaging suite: 68 passed, including signed oversized inbound events,
  duplicate delivery, member/sender identity, images, eight-recipient boundary,
  STOP, private delivery isolation, tenant/source checks and revoked action replay.
- Publication suite: 50 passed; one PostgreSQL-specific test skipped.
- Six focused phone browser tests passed, including group/private texting,
  desktop/mobile, images, retries, conference controls and endpoint refresh.
- Three group API/provider tests and publication coverage passed against merged
  Linux sources on every serving host. Rebases reused verified compiled bytes
  only after exact source equality checks; group tests also passed on rebased trees.
- Desktop/mobile read-only screenshots inspected. No real carrier message sent.

## Deployment Continuity

Seven backend modules and six browser assets were overlaid onto actual current
development sources. Only those backend modules were compiled. Newer call
permissions, calling-runtime versions, SMS registration UI and Feed changes were
preserved. Manifest changes were limited to the four phone bundle cache versions.

Concurrent SMS releases superseded activation during rollout. Activation guards
now leave newer releases untouched rather than restoring an obsolete parent.
Web/pool carried the feature forward into
`/opt/firstmeasure/releases-oversized-mms/1b68c868-sms-button`.
Compatibility was separately rebased and activated at
`/mnt/firstmeasure_dev_releases/releases-oversized-mms/f3a961462e1bd8385bab4182067d4b063f186453-r4`.
Each prepared release records its parent and scoped source/runtime checksums.

Final active-runtime audits passed on all three hosts: group schema version 2,
the private-reply action and business permission, authorized pilot data reads,
and preserved call publications. Ready/outbound-safety checks passed.

Capture mode, consent enforcement, the three-phone development allowlist and
registration scope stayed unchanged. No numbers purchased, registration
submitted, live sending enabled or worker service activated.
