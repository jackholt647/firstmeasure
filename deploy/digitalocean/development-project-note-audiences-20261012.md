# Project Note audiences and archives — October 12, 2026

Feature commit: `ad1c506261a6c8a7bdfba06b0bf15b70b728e896`.

The eye/visibility label on each author-owned active note opens an audience
picker directly. It is positioned above the scrolling tray in a body portal,
with Apply, Cancel, outside dismissal and inline failure feedback. Visibility
changes use a dedicated authenticated, CSRF-protected PATCH operation, preserving
the latest text, edit timestamp and revision history. Existing replies inherit
both department access and any changed legacy audience.

Field crew is a separate audience, identified through the existing field-user
audience resolver. It can be combined with multiple active departments: either
field-user access or a selected department satisfies the note audience check.
Organization, project/channel access, explicit permissions and authorship checks
still apply. The directory advertises the crew capability; new selection clears
the older role audience while untouched old notes remain compatible.

Cards have tighter padding, no footer divider, visibility at the lower left and
Reply at the lower right. Long-note toggles use plain text styling matching Feed.
Only edited notes offer View Edit History. Archived project notes retain readable
text and visibility metadata for authorized readers, without requiring restoration;
ordinary deleted channel messages retain their tombstones. The shared summary
layer correction already landed upstream and is preserved, allowing user previews
to appear above the project modal.

## Validation

TypeScript checks and the 49-test Channels/department/access suite passed.
Six focused note tests cover department validation, field crew union access,
reply inheritance, realtime redaction, text/revision preservation, legacy audience
conversion and authorized archive reads. Each staged Linux build runs that suite
against disposable SQLite fixtures, outside live development data.

The browser regression tests direct visibility Apply/Cancel/failure behavior,
separate draft retention, actual shared user-summary rendering above a project
modal layer, long-note toggle styling and expansion, conditional history,
readable archives, menus, composer controls and 360/280/240-pixel trays. All APIs
and user/widget data in this fixture are mocked; no customer note is posted.

## Deployment

The rollout upgrades the four Channels TypeScript sources and their compiled
modules on web, pool and compatibility before publishing the two frontend files.
This prevents an older API schema from dropping the new crew flag during a mixed
rollout. No migration or worker change is required.

The reviewed owned patches preserve live Feed moderation, manual-feed query and
Feed API-client additions not yet present in the canonical baseline. Immutable
release copies break hard links before writes; source and compiled hashes,
current-path guards, development isolation and exact runtime identity are checked.
The fresh backend stages preserve the concurrent SMS rollout. Earlier failed,
unactivated stages are not rollback targets.

Receipts, manifests, reviewed live baselines, merged files and deployment scripts
are retained in ignored `output/notes-audience-deploy/`. Rollback must reverse the
owned note changes while preserving later releases, rather than switching blindly
to an old whole release. Production and configuration are outside this rollout.

## Verified result

All three roles passed final source, compiled, frontend and shared-widget hashes,
runtime identity against their current release environment, readiness and enforced
development isolation. Public asset hashes matched and the browser regression
passed again with libraries fetched from dev after frontend publication.

| Role | Final current release |
| --- | --- |
| Web | `/opt/firstmeasure/releases-phone-second-pass/62a9a116b8975dfc8b16aec49989ed576dd60f10-activity-labels-r2` |
| Pool | `/opt/firstmeasure/releases-phone-second-pass/ad1c506261a6c8a7bdfba06b0bf15b70b728e896-notes-audience-ui` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases-phone-second-pass/62a9a116b8975dfc8b16aec49989ed576dd60f10-activity-labels-r2` |

The concurrent Activity release retains the verified Notes sources and compiled
modules on all roles. Its runtime release ID is
`62a9a116b8975dfc8b16aec49989ed576dd60f10`. Pool's frontend publication clones that
Activity release; web and compatibility's subsequent Activity stages preserve the
already-published Notes frontend. Expected transient readiness failures during
those restarts delayed final checks until the servers were healthy. No old
release was reactivated over another task's changes.

All backend stages started from `07074cab-sms-final-ui`, with runtime release
`07074caa1c301bb795ecce8e488a8b6803089bf2`. Backend candidates use the feature
commit plus `-notes-audience-backend-r2`; frontend candidates use
`-notes-audience-ui`. These stages and their receipts remain available for audit.
