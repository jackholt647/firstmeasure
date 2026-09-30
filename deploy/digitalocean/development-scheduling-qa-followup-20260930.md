# Scheduling QA follow-up (rounds 5–7) — development rollout, September 30, 2026

Source release: `7515ac2bc321ae3e103ea538fe9f9cdeec400cbe` on
`codex/consolidated-firstmeasure-20260923` (`735a0655` plus the bundle-token
bump). The user authorized deployment to `https://dev.1m8.ai` for testing.
Production activation was not authorized; no production host, service,
autoscale image/template, DNS or provider setting was touched.

It follows [the first Scheduling QA rollout](development-scheduling-qa-20260930.md)
(`5f7cff24`) and was overlaid on the app-groups release `7bab9c55` that was
live on every development role.

## Behavior

- **Placement:** the Routing daily lane keeps timed work timed; the Routing
  chip ✓ confirms the staged draft, so End/time/title edits from its editor
  are saved; reopened draft editors show dragged dates; an edited sales draft
  asks before it is discarded and its banner names the assignee; double-click
  ✓ saves once; the "Saving…" toast stays until the result.
- **Drag safety:** data refreshes wait for the pointer release, so a
  focus-triggered refresh cannot drop a drag that has started. Toasts dismiss
  on click instead of passing the click to a control they cover.
- **Month:** opens, and returns on Today, resize and view switch, with today's
  whole week visible and no row under the weekday header.
- **Timeline:** zoom keeps the viewed range; month-zoom drags scale their
  click threshold; a section whose items are all unscheduled is unscheduled.
- **Header:** unsaved editor edits are guarded for keyboard activation too.
- **Routing:** sales Auto-route confirms first and counts real reassignments;
  sales resizes update `duration_minutes`; vehicle resizes say "resized".
- **Project window:** the New dialog marks down/booked equipment for the
  chosen time and names conflicts; Edit keeps the primary crew; Add section
  validates; a project deleted elsewhere shows a lasting notice from Overview
  and the Schedule tab and is never recreated; Overview skips cancelled
  appointments; delete-conflict wording matches the global editor.
- **Phone:** hold-to-create swallows the follow-up click, so the new event's
  sheet opens instead of a neighbour's.
- **Server:** the work-event drain is scheduled after the response, equipment
  bookings hold a per-organization lock, and project writes that name an
  existing project never recreate a deleted one. No schema or data migration.

## Validation

- TypeScript check passed in the workspace and on every staged role.
- Scheduling event writes 11/11, recurrence series 3/3, scheduling
  dependencies 5/5.
- Scheduling UI contract: 62 of 76 pass. The 14 failures are older source-text
  assertions that failed before the first fix pass. Seven assertions that
  encoded replaced behavior (for example "Day/Week/Month events are not
  draggable") were updated.
- Navigation contract: 35 of 42, the same seven failures as the parent commit.
- Browser QA rounds 5, 6 and 7 on local test organizations (ten areas, then
  four and two confirmation testers), each followed by a fix pass. Round 7's
  three findings were fixed and re-run.

## Deployment

The two commits contain only Scheduling-owned files and hunks, committed
through a temporary index. Other sessions' uncommitted edits (the Feedback
portal link in `platform/api.ts`, Feedback delivery in `work/engine.ts`, the
sidebar catalog work in `portal/scripts/core.js`, and their manifest entries)
were excluded and remain in the working tree; the manifest token strings were
also applied to their staged and unstaged copies so they do not revert them.
Bundle tokens for `project-schedule/panel.js` and the shared date/time picker
are `20260930-scheduling-qa-v2`. The portal loads the other changed libraries
with its per-request version.

All four development roles were inspected at `7bab9c55`, staged, and activated
one at a time (worker, compatibility, web, pool). Each overlay was 3-way
merged onto that role's live baseline with no conflicts; the worker and
compatibility hosts kept their role-specific lines. On each role the service
is active, deployed source/compiled hashes match the payload, the runtime
release and data environment are development, and outbound safety is
enforced. Public readiness at `https://dev.1m8.ai` reports the release, and
eleven served JavaScript assets match the payload hashes.

Disk:

- **Web (`fm-dev-web-598520065`)** had 2.35 GiB free, below the 2.75 GiB a
  full release copy needs. This release was staged there as a hardlinked copy
  of the live tree with a 1 GiB reserve; every file the release writes was
  unlinked first, so `7bab9c55` is unchanged. 2.4 GiB remain.
- **Compatibility** has no free inodes on its releases volume
  (`/mnt/firstmeasure_dev_releases`, 100% of 3,276,800). The release lives
  under `releases-root-archive` as before; only the convenience alias in
  `/opt/firstmeasure/releases` could not be created and was skipped.

No historical release was deleted on any host. Both limits need a cleanup
decision before much more is staged.

Artifacts (inventory, merged role payloads, archives and scripts) are in the
ignored `output/scheduling-qa-followup-20260930/`.

## Rollback

Each release directory has a `channels-release.json` receipt recording its
previous release and deployed file hashes. To roll back a role:

1. Confirm `/opt/firstmeasure/current` still points to `7515ac2b…`, so no
   later release is overwritten.
2. Point the symlink back to `7bab9c551b66f14dca61e302d92fed3a567c109e`
   (under `releases-root-archive` on the compatibility host).
3. Restart that role's development service, plus `php8.3-fpm` on
   web/pool/compatibility.
4. Check development readiness and outbound isolation.

On the web node, do not edit files inside either release in place: unchanged
files are shared hardlinks between `7bab9c55` and `7515ac2b`.
