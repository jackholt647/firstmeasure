# Channels composer controls inside the message box — October 9, 2026

Source commit `c2998e823e68f9582a58b3944e061d13aedd86ae` was pushed to GitHub on
`codex/consolidated-firstmeasure-20260923` and activated on development only.

The shared Channels editor now places the action row inside the bordered
composer for both channel messages and thread replies. The writing area is
slightly taller. Emoji, GIF, attachments, recording, Schedule Send, Send, and
the separator between the send controls keep their existing behavior.

The release overlaid only `public/libraries/channels-ui/channels-ui.js` on each
role's current immutable development release. A concurrent contact-window
rollout completed first; all three roles were then staged from its
`62ae7d72308f13d8c1df0c87d021edc5c9ebc37c` release. The prior Channels
asset hash was `805706feb6f2a5a6e264373e659621e2a72c3ed1bef6d765480f865848536a93`;
the committed and hosted asset hash is
`dc175a1936c49ef603c1f0b7f272af320bd0f0744d6bf28c05d01c459655ad87`.
No backend, worker, data, environment, or production files changed.

All three stages passed JavaScript syntax and Linux TypeScript checks before
activation. Web, pool, and compatibility were activated sequentially with
automatic restoration of the previous release on failure. Each role passed
local readiness, exact release identity, asset hash, and development isolation
checks. Four public readiness samples returned the new release, and the public
Channels asset matched the committed bytes. An isolated browser run using the
hosted asset passed the existing dictation, recording, draft-preservation, and
mutual-exclusion regression. The separate Messages browser suite passed two
cases and failed one existing business-alert assertion (`business-bell` absent
from the fixture result); it does not exercise the composer layout.

| Role | Activated release | Previous release path |
| --- | --- | --- |
| Web | `c2998e823e68f9582a58b3944e061d13aedd86ae` | `/opt/firstmeasure/releases-group-mms-final/62ae7d72308f13d8c1df0c87d021edc5c9ebc37c` |
| Pool | `c2998e823e68f9582a58b3944e061d13aedd86ae` | `/opt/firstmeasure/releases-group-mms-final/62ae7d72308f13d8c1df0c87d021edc5c9ebc37c` |
| Compatibility | `c2998e823e68f9582a58b3944e061d13aedd86ae` | `/opt/firstmeasure/releases-root-archive-group-mms-final/62ae7d72308f13d8c1df0c87d021edc5c9ebc37c` |

Rollback: first check for intervening releases. Restore each role's previous
path through the atomic `current` symlink, restart only its development web or
legacy service and PHP-FPM, then verify readiness, development isolation, and
the public asset. The worker was not part of this frontend release.

Local deployment scripts and receipts are in ignored
`output/channels-composer-20261009/`.

Subsequent independent contact and Feed rollouts superseded these release IDs
while retaining the exact Channels asset hash on all three roles. After those
rollouts, the public development endpoint again returned ready with isolation
enforced, and its Channels asset still matched the committed file.
