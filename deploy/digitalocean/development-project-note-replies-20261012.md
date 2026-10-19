# Project Note reply composer — October 12, 2026

Feature commits `3d283c37` and `3e4215c05cf725f3e2729e442d8c89b04726cd88`.

Author/date spacing uses explicit compact line heights and a one-pixel gap.
The smaller header brings the note body upward. Replies place the author and
timestamp above the rich text, with smaller spacing and an action menu containing
Edit Reply, Copy text and Archive Reply when allowed by the existing API flags.
Edited replies also offer history; archived replies can be displayed with Show
Archived and restored by authorized users.

The Add Note and reply composers share their control markup, the Channels rich
editor and formatting toolbar, and existing upload, mention, emoji and voice
integrations. Replies include all six formatting controls and the same action-icon
order. Enter sends; Shift+Enter inserts a line. The editor honors composition and
already-handled keyboard events. Pending upload/recording states prevent sending.
Failed sends retain text, prepared attachments and a retry operation identifier.
Success clears only the reply draft. Each thread keeps its composer and selection
across list refreshes; collapse/reopen preserves the draft. Destroy aborts capture
and removes mention, picker and document listeners.

Replies use the existing authenticated Channels post/edit/archive/restore APIs.
The server inherits the note's department and crew visibility for replies. Reply
editing omits root-only audience fields. No backend, schema, migration, access-rule
or worker changes are part of this rollout.

## Verification

The expanded real-browser regression passed locally and again using libraries
fetched from dev. It covers formatting, Enter, Shift+Enter, file and audio payloads,
dictation, emoji selection, author/body ordering, editing/copy/archive/restore,
failed-send draft retention, separate Add Note drafts, refresh focus retention,
collapse/reopen drafts and 360/280/240-pixel tray widths. Existing Notes workflows
remain covered. Customer notes are not posted: API and widget-data fixtures are
isolated. JavaScript syntax checks and reviewed screenshot layouts passed.

## Development publication

Only `public/libraries/project-notes/project-notes.js` and the Notes bundle version
in `public/libraries/apps/firstmate-apps-manifest.js` are overlaid. The version is
`20261012-notes-reply-composer-v1`. The live manifest has independent Feed, phone
and window changes; compatibility also has a distinct historical manifest. Each
role retains all of those entries byte-for-byte after line-ending normalization,
with only the Notes version changed. The Notes library matches the feature commit.

Staging clones each immutable current release, checks audited before/after hashes,
breaks target hard links before writes and checks syntax. Activation guards current
path and runtime, atomically switches the frontend release and reloads PHP-FPM.
No backend service restart is needed. Readiness checks retry transient failures
while retaining development-isolation assertions. Pool's initial stages were never
activated after readiness failures; compatibility's first attempt stopped at its
manifest guard before copying a release. Fresh stages were used for both roles.

| Role | Verified release | Previous current path |
| --- | --- | --- |
| Web | `/opt/firstmeasure/releases-phone-second-pass/3e4215c05cf725f3e2729e442d8c89b04726cd88-notes-replies` | `/opt/firstmeasure/releases-phone-second-pass/62a9a116b8975dfc8b16aec49989ed576dd60f10-activity-labels-r2` |
| Pool | `/opt/firstmeasure/releases-phone-second-pass/3e4215c05cf725f3e2729e442d8c89b04726cd88-notes-replies-r3` | `/opt/firstmeasure/releases-phone-second-pass/ad1c506261a6c8a7bdfba06b0bf15b70b728e896-notes-audience-ui` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases-phone-second-pass/3e4215c05cf725f3e2729e442d8c89b04726cd88-notes-replies-r3` | `/mnt/firstmeasure_dev_releases/releases-phone-second-pass/62a9a116b8975dfc8b16aec49989ed576dd60f10-activity-labels-r2` |

All roles passed final hashes, readiness and enforced development isolation.
The backend runtime remains `62a9a116b8975dfc8b16aec49989ed576dd60f10`.
Public Notes and manifest hashes matched their reviewed payloads. The Notes SHA-256
is `21f75ada84bb2a14704bc0a9f311aa6f5775af334cee60b408228202cc4f46aa`.

Scripts, audited role baselines, owned patches, manifests and merged payloads are
under ignored `output/notes-replies-deploy/`; immutable releases contain receipts.
Rollback should reverse these two owned changes while preserving subsequent
releases, rather than blindly switching an older whole release. Production is
outside this publication.
