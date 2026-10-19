# Project Notes composer and note cards — October 11, 2026

Source commit `2f38fe5498722be076573225d56168e5a60e18f6` is on
`codex/consolidated-firstmeasure-20260923`.

The shared Project Notes workspace uses the Channels rich editor and formatting
bar with Bold, Italic, Strikethrough, Bulleted list, Numbered list and Quote.
Its larger bordered composer contains Emoji, Attach a file, Dictate message,
Record an audio note, Send and the existing pinned-note action. The four shared
actions follow Channels order (excluding its GIF and other extra actions).
Dictation inserts text; recording stages an audio attachment. Saving preserves
mentions, visibility, attachments, edits and failure drafts. The note cards have
initial avatars, separate author/date lines, quieter actions, improved spacing,
rendered formatting and content-based expansion.

Only two browser files are overlaid: `channels-ui/channels-ui.js` and
`project-notes/project-notes.js`. The Channels formatting-bar helper accepts an
optional allowed-command list; its existing callers retain their controls.

The focused browser regression covers all six formatting commands, saved and
edited text, cancel editing, failed-send draft retention, file and audio
attachment payloads, dictation, emoji selection, tagged users, empty search
results and widths of 360, 280 and 240 pixels. Data APIs and audio capture are
fixtures: this does not send customer notes or certify real microphone capture.
Seven broad Channels contract failures reproduce against the unchanged source
baseline and were not expanded into this UI task.

## Development publication

The overlay was staged from each role's current immutable development release.
Both target files matched canonical source before publication (allowing only
line-ending normalization). JavaScript syntax and Linux TypeScript passed on
all three candidates. The candidate replaces hard links before writing and
checks that the prior release remains unchanged. Activation guards the current
path, changes its symlink atomically and reloads PHP-FPM, restoring the previous
path on failure if this candidate is still current.

No backend restart is needed for these browser files. The Node runtime release
labels remain those of each role: `590e75f71e40312fbe2be423a636b7a21dca0729` on
web and compatibility, and `cab8e056bad0ad1f18481af9e77375911197eb26` on pool.
Frontend source provenance is separately recorded in `notes-tray-release.json`.

| Role | Candidate path | Prior path |
| --- | --- | --- |
| Web | `/opt/firstmeasure/releases/2f38fe5498722be076573225d56168e5a60e18f6-notes-tray` | `/opt/firstmeasure/releases/phone-590e75f71e40312fbe2be423a636b7a21dca0729-web` |
| Pool | `/opt/firstmeasure/releases-oversized-mms/2f38fe5498722be076573225d56168e5a60e18f6-notes-tray` | `/opt/firstmeasure/releases-oversized-mms/cab8e056-sms-identity` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases/2f38fe5498722be076573225d56168e5a60e18f6-notes-tray` | `/mnt/firstmeasure_dev_releases/releases/phone-590e75f71e40312fbe2be423a636b7a21dca0729-compat` |

All three roles activated successfully. Per-role checks and public samples
passed readiness, development environment and enforced outbound safety. Both
publicly hosted files match the committed bytes. The focused browser regression
also passed with scripts fetched from dev; it uses fixture records and audio.

A concurrent phone/backend rollout changed compatibility during staging and web
before activation. The guards rejected both stale candidates. The final stages
were rebuilt from the newer phone releases and retained their backend changes.
The original rejected stages remain unactivated; their source is not a rollback
target.

Verified frontend SHA-256 hashes:

- Channels UI: `68555bdacf548573e076e48684d5d704275369094964d193891d457b8a615c82`.
- Project Notes: `6f33b0cfe922a85c0254fa906849aed4ccbc777d2779e2e0754618b899f8216c`.

Receipts, scripts, baseline copies and the checked payload are under ignored
`output/notes-tray-deploy/`. Rollback must account for intervening deployments;
revert only these changes onto the latest baseline if another release has moved
current. Production, workers, environment and data are outside this publication.
