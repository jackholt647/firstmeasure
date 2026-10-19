# Independent project Notes and conversations — October 12, 2026

Feature commit `93f34621358e942c449bcb02a067367c6d623ad4`.

Project Notes always load designated project-note roots and note pins. Ordinary
project channel posts remain in the project conversation. A legacy separation
feature value cannot combine these domains. The Notes renderer also rejects
ordinary messages from mixed or older responses, including pinned messages,
author options and older-history pages. Channel live updates exclude note posts.
The separate Messages tray remains available through its existing app access
gate. Activity hydrates only designated notes instead of treating ordinary
channel messages as note activity.

The channel API filters project messages before pagination and keeps project
pins separate, including legacy `view=all` requests. Notes keep their existing
audience, department and project authorization. Note events, agent-authored
notes, unread counts, search and message notification handling use mandatory
separation. Project Notes no longer offer Share to channel, and the share API
rejects project-note crossover after authorization. Photo discussions remain
independently scoped to their media and retain their existing behavior.

No stored messages are deleted, moved or rewritten. Existing notes and ordinary
channel messages retain their original record designation. Both domains reuse
Channels storage internally; their user-facing lists and posting behavior are
distinct. The prior Select All/Deselect All filter behavior remains in place.

## Validation

TypeScript and frontend JavaScript syntax checks pass. The two focused API
regressions pass separation, pins, pagination, sharing rejection and both values
of the old feature flag. The broader Channels and photo-comment API run passes
41 tests. Nine browser and activity tests pass locally, including a mixed API
response with a pinned channel message and legacy separation disabled. The Notes
and photo-comment browser checks pass again with development-hosted assets.

Three unrelated broader-suite failures were reproduced on unchanged baseline
`96ddd5a5`: the business notification bell expectation and two project-assistant
tests whose fixture lacks `apps.assistant`. They are outside this patch.

## Development rollout

All three roles passed immutable staging, Linux TypeScript compilation and
isolated separation and photo-comment API checks. The staged service preserves
the live Feed moderation import and authorization correction. Role-specific
application manifest differences and the compatibility host's existing tray
implementation are preserved; only the owned tray gate and asset version change.

Activation guards the prior path/runtime, switches releases atomically, restarts
the development web or legacy service and reloads PHP-FPM. Each role passes final
source/compiled hashes, exact runtime identity, readiness, development environment
and enforced outbound safety. The shared frontend bundle version is
`20261012-notes-separation-v1`.

| Role | Activated release |
| --- | --- |
| Web | `/opt/firstmeasure/releases/93f34621358e942c449bcb02a067367c6d623ad4-notes-separation` |
| Pool | `/opt/firstmeasure/releases/93f34621358e942c449bcb02a067367c6d623ad4-notes-separation` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases/93f34621358e942c449bcb02a067367c6d623ad4-notes-separation` |

Runtime identity is `93f34621358e942c449bcb02a067367c6d623ad4` on all roles.
The previous releases have suffix
`31d47774730bc957b96d00765d74ef13733354e5-notes-filter-toggle`; the prior backend
runtime is `5b2eb1a823614698ac8ddf0fa65bda4b2e0fe1d8`. Rollback must preserve
subsequent changes and reverse only this patch. Audited baselines, merged
payloads, deployment scripts and receipts remain in ignored
`output/notes-separation-deploy/`. Fixture checks do not post customer notes.
No database migration, worker change or production activation is included.
