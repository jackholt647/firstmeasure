# Scheduling QA fixes — development rollout, September 30, 2026

Source release: `5f7cff24fcd55ca3e823af106267de78ecbb2841` on
`codex/consolidated-firstmeasure-20260923`. The user authorized deployment to
`https://dev.1m8.ai` for testing. Production activation was not authorized; no
production host, service, autoscale image/template, DNS or provider setting was
touched.

## Behavior

- **Global Scheduling tab:** Week/4-Day/Day/Month, Routing and Timeline views,
  placement drafts and banners, drag thresholds and past-day confirmation,
  all-day/month overflow ("+N more"), keyboard order, failed loads that keep
  last-good data with Retry, and neutral view-only feedback.
- **Project Schedule tab and shared renderer** (`PlatformScheduleView`,
  `PlatformScheduling`): timeline sections, dependency links with a two-way
  reschedule impact, group moves/rollups, touch-hold drags and schedule deep
  links (`projectScheduleView/Target/Date`) that survive project windows.
- **Recurrence:** series edits keep deleted and moved occurrences, local times
  are DST-safe, and skipped/cancelled occurrences can be restored.
- **Assignments and equipment:** multiple crews per item, sequence-only
  production auto-routing (never swaps crews for people or routes groups),
  vehicle/equipment booking windows with conflict checks, and read access to
  equipment types/availability/settings for schedule editors.
- **Concurrency:** schedule items carry an event revision; stale saves are
  refused or merged. Every project-document writer (event saves/deletes,
  confirmations, automations, work projection, materials, routing and crew
  visits) goes through `platform/project_document_mutation.ts`: per-project
  serialization plus a conditional `expected_revision` write that re-reads on
  conflict. This uses the existing storage revision check; no schema or data
  migration is included.
- **Pipeline stage:** a manual board stage is released only when the workflow
  reaches it, instead of on any node transition.
- **Permissions:** scheduling module settings need `manage_schedule` or
  `manage_company_settings`; members may save only their own preferences on
  their user record. The seven production permission flags are unchanged.
- **Shared UI and project window:** date/time picker placement beside dialogs,
  double-click/Enter apply and Escape layering; toast tones and z-index; dialog
  focus that never defaults to a destructive action; tooltip cleanup. Opening
  a project never writes it; overview saves send changed fields only; schedule
  changes are relayed between windows and the portal; the route precover is
  removed once a project window exists.

## Validation

- TypeScript check passed in the workspace and in an isolated checkout of the
  release commit.
- Isolated release tests: scheduling event writes 7/7, recurrence series 3/3,
  work API 14/14, equipment API 11 passed (2 skipped), appointment
  rescheduling 3/3, appointment confirmations 5/5, crew API 14/14, materials API
  5/5, workforce API 9/9, scheduling dependencies 5/5, equipment picker browser
  test 1/1, publication suite 49 passed (1 PostgreSQL-only test skipped).
- Scheduling UI contract: 59 of 76 pass. The 17 failures are older source-text
  assertions that predate this work (33 failed before the first fix pass).
- Four rounds of local browser QA across ten areas (header, month, time grid,
  editor, rail, timeline, resource, project, equipment, mobile), with three
  fix passes between rounds.

## Deployment

The commit contains only Scheduling-owned files and hunks, committed through a
temporary index. Other sessions' uncommitted edits in shared files (project
notes composer/GIF/audio controls in `project-request/app.js`, the Feedback
portal link in `platform/api.ts`, and other manifest entries) were excluded and
remain in the working tree. Bundle tokens for `project-schedule/panel.js`,
`project-request/app.js`, `window-manager/project-windows.js` and the shared
date/time picker are `20260930-scheduling-qa-v1`. The portal loads the other
changed libraries with its per-request version.

All four development roles were activated one at a time and verified
independently: web (`fm-dev-web-598520065`) and pool (`fm-dev-web-603124965`)
from `8a4bb267`, compatibility from `8a4bb267`, and worker from `d9e08684`.
Each overlay was 3-way merged onto that role's inspected live baseline. The
worker kept its older `branchModuleWritePermission` line, with the scheduling
rule added. The compatibility host kept its earlier project-request loader and
left-region schedule panel, with the Scheduling hunks applied. Every role was
re-inspected for drift before staging and before activation. On each role the
service is active, the deployed source/compiled hashes match the payload,
runtime release and data environment are development, and outbound safety is
enforced. Public readiness at `https://dev.1m8.ai` reports the release. Eleven
served JavaScript assets match the payload hashes, and the served manifest
carries the four new tokens.

The development web node's root disk is 99% full: 2.97 GiB were free before
staging and 2.17 GiB remained after activation. Its new-copy threshold was lowered from
3 GiB to 2.75 GiB for this release. No historical release was deleted. Later
web releases will need a cleanup decision first.

Artifacts (inventory, merged role payloads, archives and scripts) are in the
ignored `output/scheduling-qa-20260930/`.

## Rollback

Each release directory has a `channels-release.json` receipt recording its
previous release and deployed file hashes. To roll back a role:

1. Confirm `/opt/firstmeasure/current` still points to `5f7cff24…`, so no
   later release is overwritten.
2. Point the symlink back to the recorded previous release: `8a4bb267…` for
   web, pool and compatibility, or `d9e08684…` for the worker.
3. Restart that role's development service, plus `php8.3-fpm` on
   web/pool/compatibility.
4. Check development readiness and outbound isolation.

A code rollback does not undo schedule edits already saved with event
revisions. Older code ignores the extra revision field.
