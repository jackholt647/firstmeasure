# Project Notes refinements — October 11, 2026

Feature commit `32421d06389e2ab19206b37bf4a414501790ffbb` follows the
[composer rollout](development-project-notes-composer-20261011.md).

## User behavior

Author photos and initial avatars invoke the shared `summary.user` hover/focus
widget with an organization-scoped user target. Note editing opens a rich-text
form inside the original card. Its own Save changes, Cancel and visibility
chooser preserve the separate Add Note draft. Edit drafts survive history
refreshes. Edit history retains its revisions and adds an X close control.

Archive Note uses the existing reversible soft archive endpoint. Show Archived
and Hide Archived replace the Removed checkbox; restoration says Unarchive Note.
Pinned notes have a clickable Unpin Note control. Search starts collapsed and
opens from the search icon. Note menus close on outside pointer presses and
Escape. Saving and success status bars are removed; actionable errors remain
inline. Save message was a personal Channels bookmark and is removed from the
Notes menu; Channels saved messages are unchanged.

## Department audience contract

The old Office/Crew/Sales audience enums remain compatible for existing notes.
New notes select multiple real active organization departments from the existing
directory. Only departments available through `relevantDepartmentContext` are
selectable, and the server validates them again. Notes show their department
labels (one department says “only”). Everybody explicitly writes an unrestricted
department audience. Editing an old note preserves its prior role audience and
department metadata unless the user changes the chooser.

The typed optional `department_ids` input is limited to root project notes.
It writes the existing `department_ids` and `department_access` resource fields;
reads and notification recipient checks reuse `canAccessDepartmentResource`.
Department-restricted realtime messages are stubs without the message body.
Replies inherit their root's departments, and changing the root updates existing
reply restrictions within the same storage transaction. Posting to a reply
requires access to its root as well as its immediate parent. Authorship and
organization/channel permissions remain authoritative.

## Validation and publication

The expanded browser regression covers all prior composer controls and adds the
actual shared summary renderer, department combinations and displayed labels,
inline save/cancel, separate Add Note draft retention, search expansion, outside
menu dismissal, pin clicks, archives/restoration and the history X. It tests
360, 280 and 240 pixel widths. APIs, audio capture and widget data use fixtures;
no customer notes are posted by the regression.

Local TypeScript checks passed. The Channels API suite plus department tests
passed 46/46. The focused department suite tests unavailable/foreign department
selection, non-note targets, reads, mentions, realtime stubs, inherited replies,
audience changes, legacy preservation and author-only edits.

Deployment overlays the Notes library and four Channels domain sources (API,
schemas, service and storage), with their four compiled JavaScript counterparts.
The current dev service contains the Feed moderation adapter, and storage
contains `listFeedManualMessageRecords`; both were audited and retained by
applying only the committed Notes patch. Deployed source bytes therefore include
these independent live changes. Line endings are normalized for payload hashes.

Staging copies the current immutable release, breaks target hard links before
writing, verifies the reviewed before/after hashes, builds/checks TypeScript and
runs the isolated three-test department suite. Activation guards the current
path, atomically switches the release and restarts its development web/legacy
service. It reloads PHP-FPM and restores the prior release on failure only if its
candidate remains current. No database migration is required.

Receipts, exact hashes, the owned patch, audited baselines and publication scripts
are under ignored `output/notes-refinement-deploy/`. A rollback must preserve
intervening releases and restore only the Notes patch; do not blindly reactivate
an older whole release. Production and configuration are outside this rollout.

## Release paths

All three frontend/API roles use source release
`32421d06389e2ab19206b37bf4a414501790ffbb`. The worker is unchanged.

| Role | Candidate | Previous release |
| --- | --- | --- |
| Web | `/opt/firstmeasure/releases-phone-second-pass/32421d06389e2ab19206b37bf4a414501790ffbb-notes-refinement-r2` | `/opt/firstmeasure/releases-phone-second-pass/c9df85696311127d3d7bb1d3f3a99101fead0dec-activity-r2` |
| Pool | `/opt/firstmeasure/releases-phone-second-pass/32421d06389e2ab19206b37bf4a414501790ffbb-notes-refinement-r2` | `/opt/firstmeasure/releases-phone-second-pass/c9df85696311127d3d7bb1d3f3a99101fead0dec-activity-r2` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases-phone-second-pass/32421d06389e2ab19206b37bf4a414501790ffbb-notes-refinement-r2` | `/mnt/firstmeasure_dev_releases/releases-phone-second-pass/c9df85696311127d3d7bb1d3f3a99101fead0dec-activity-r2` |

All three roles activated successfully. Final per-role source and compiled
file hashes, exact runtime release identity, readiness and enforced development
isolation passed. Four public readiness samples and the publicly hosted Notes
asset matched the release. The expanded browser regression also passed with
assets fetched from dev after activation.

Fresh r2 stages were built after the concurrent activity rollout advanced web's
baseline. Earlier unactivated stages are not rollback targets. The deployed
Notes asset's normalized SHA-256 is
`344e9bf57d08da8e09f81cf5775575f1197f9a7aa8a9ba65092464e7ad879033`.
