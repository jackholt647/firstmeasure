# Channels settings and implicit FirstMate — September 29, 2026

Source/runtime release: `66a53b38e324fd954901f98976f89bf954fbbb7f`.

Channels app settings now open from a small gear in the Channels left-column
heading, including the integrated sidebar. Per-channel settings remain in the
conversation controls. Workflow shortcuts were removed from that header.
Channel settings save automatically, serialize changes, flush pending edits
when closed, and close after successful archival. Save failures remain visible.

FirstMate stays mentionable in every authorized conversation without being
invited. Membership responses and people pickers exclude the assistant, and
old add-assistant requests do not create membership/activity or wake it up.
Dedicated assistant DMs retain their backing identity and automatic replies;
legacy membership in human conversations no longer triggers unsolicited replies.
Human membership and resource authorization remain unchanged.

Channel recap requests carry validated internal metadata. The shared assistant
tray hides that automatic prompt immediately and after reopening, including the
exact legacy opening recap prompt. Actual user follow-ups remain visible.

Validation: TypeScript check passed; channel API/agent suites passed 42 of 44
tests. The two notification-routing assertions also fail on an unmodified HEAD
snapshot with the same assertions, independently of this change. Targeted recap
API and shared assistant browser tests passed. Chrome settings checks cover
sidebar placement, actual embedded settings mounting/back navigation, removal
of redundant controls, ordered autosave, close-time flushing, archive dismissal
and legacy assistant member filtering. UI/API fixtures isolate test data.

Deployment uses immutable copy-current overlays: four frontend assets and three
backend modules plus compiled outputs on the serving roles, six backend files
on the worker. No schema, dependency, environment or topology changes.
Concurrent source and role-specific runtime differences are retained.
Production is unchanged. Evidence: ignored
`output/channels-settings-assistant-20260929/`.

Rollout guards stopped activation twice as Brand Kit and Contacts releases
advanced the baseline. Payloads were rebuilt against the completed releases.

Rollback predecessors: serving roles `0d3f064715641f07131a4492336e6006712b6799`;
worker `047ef15c755ff4b7a6e520830ff11d6c3dd80cc2`. Check for intervening releases
before reverting each role's current symlink and restarting its service. Verify
development isolation, readiness and owned asset hashes after rollback.

Final verification: all four roles activated successfully with file hashes,
runtime readiness and development isolation checked. All four public frontend
asset hashes and six public readiness responses matched this release. The
Chrome settings/member suite passed again using dev-served scripts, including
the embedded app settings mount and Back navigation, autosave ordering and
close flushing, archive dismissal and assistant member filtering.
