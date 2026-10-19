# Project activity follow-up — October 12, 2026

Frontend source: `8495c45c0cd7ceb7cc5b04cd0ea9262807f3a229`, pushed to
`codex/consolidated-firstmeasure-20260923`.

The Activity toolbar is one row: search followed by filters. The event total and
manual refresh button are removed. Existing polling now works alongside project
events, authorized realtime notifications and resync callbacks. Unchanged
refreshes preserve the existing DOM so user previews and focus are not disrupted.
Subscriptions and debounce timers are released when the widget is destroyed.

Upload descriptions omit filenames. Uploads by the same recorded user, of the
same kind and category, within a three-minute span are grouped into counts such
as “Uploaded 8 images” and “Uploaded 5 documents.” Separate users and later
uploads retain separate entries. Unknown actors are not combined. Document
uploads classify as Documents; image uploads classify as Files & photos.

Communications emphasize the action and channel together: **Received email**
from Taylor Chen. Text-message and call actions use the same emphasis.

Notes were hidden by the renderer when `channels.separate_project_notes` was off.
That exclusion is removed. Authorized note roots are read from the existing
Notes cache, or from an existing project channel with `initialize:false`, without
ensuring or creating channels. When separation is off, the activity uses the
same root-message population as Notes; when it is on, explicit note roots are
used. Replies, system messages and archived notes do not create active-note
fallback entries. Recorded creation events take precedence over the fallback
rows, preserving one creation per note. Note snippets come only from authorized
message reads. Pinned notes are included in the read population.

The shared preview was behind the project window: the live project overlay was
observed at `z-index:2147483200`, while the preview used `100000`. The shared
widget now uses `2147483646`; its runtime asset URL is versioned to load the new
renderer. The user preview's actual publication resolution and authorized user
read returned ready. No replacement tooltip, permission grant or user matching
by guessed name was introduced.

Nine focused tests pass, including batching boundaries and users, note population
with separation off, communication emphasis, combined filters, pagination,
automatic refresh/retry, teardown, safe text, popup hit-testing above the project
layer, keyboard previews and the existing user-summary widget behavior. Recorded
Taylor Chen data produced 15 active note rows, generic upload descriptions and
“Received email from Taylor Chen.” Test screenshots and actual-record review are
retained in the task's ignored output directories.

Each development role received only the four owned asset patches and activity
manifest versions on an immutable clone of its own current release. Compatibility
keeps its older agent-tray implementation. Web staging was rebuilt on the
concurrent `0200f8b0-sms-copy` release after its current pointer moved, preserving
those changes. Web uses `8495c45c...-activity-v2-r2`; pool and compatibility use
`8495c45c...-activity-v2`. All three activation checks passed with development
data and outbound safety enforced. The worker and production were not changed.

| Asset | Final SHA-256 |
| --- | --- |
| Project trays, web and pool | `ef4c2f66686cf3ecc04cae8e0154fa619a03dc316d538e9578e5748191b547aa` |
| Project trays, compatibility | `b7f220526a51af6caf7814bac69f03998723ae5d9001b64848e803f927c65f58` |
| Activity presenter | `1b829216c41ded83c4963697a5549c33df0bff5fb5c0611dbc58e0589852ad05` |
| Shared widget renderers | `e6b5930a99f1e21c61932b31cf0427b70c85e37b4ab5d5a1e8e31be4c7ceb770` |
| Widget runtime | `d58a2dd838bdf0ff4c3a2a33127f4836c0270221c457cfd0a3549317b9e09e59` |

Per-role hashes, retained baseline and rollback targets are installed in
`activity-followup-release.json`. Local staging scripts and read-only data review
are under `output/activity-followup-20261012/` in the task workspace. Existing
open windows need one reload to acquire the new script versions.
