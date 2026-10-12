# Complete activity labels and expandable notes — October 12, 2026

Source: `62a9a116b8975dfc8b16aec49989ed576dd60f10`, pushed to the canonical branch.
Includes the preceding name-only preview change from `ca76a69f`.

User-summary attributes now belong to the actor's name control, rather than the
activity article. Hovering the description, icon, time or row background does
not trigger a preview; hover and keyboard focus on the name use the shared widget.

Every main event label is bold as a complete phrase, including “Uploaded a
document,” “Uploaded 8 images,” “Added a project note” and named task or appointment
events. Communication participants, note content and supplementary amounts remain
regular text. The presenter exposes the complete label separately from details.

The presenter retains the full authorized note text. The activity view initially
shows up to 140 Unicode code points, then provides an inline **See more** link.
It expands the full text and changes to **See less**, with keyboard activation,
`aria-expanded` and `aria-controls`. Expansion is local to the widget and survives
filters and automatic updates. Note bodies preserve whitespace and are escaped
as text, rather than injected as markup. No note content is truncated in storage.

Nine focused presenter/browser tests pass. They verify complete labels across
event types, full retained note text, name-only previews, negative description/time
hover checks, expansion/collapse by mouse and keyboard, persistence during resync,
upload batching, note population, filters, pagination and refresh behavior.

Only the two activity assets and their manifest versions were patched into
immutable clones of each role's own live release. Concurrent Notes audience
updates were preserved. Web and compatibility were restaged on the newer
`ad1c5062...-notes-audience-ui` baseline after their pointers moved. Pool retained
its latest backend baseline. Activation passed on all three development roles,
with development data and outbound isolation enforced. Worker and production
were not changed.

| Asset | Final SHA-256 |
| --- | --- |
| Project trays, web and pool | `90c2888d59aa44a1c9f379f74000a4aadb4a730da86931768efad9069273d6b2` |
| Project trays, compatibility | `5f0cca9bae37690fc1d06234cd0cfb142d12fed3d48a4fbe5c4583ae26549730` |
| Activity presenter, all roles | `87a54813b9866ba275a709210ca0f696828a68ce107d7169b448652581f990b8` |

Per-role hashes and rollback paths are installed in `activity-labels-release.json`.
Local staging and activation scripts are retained under ignored
`output/activity-labels-20261012/`. Existing open windows need a reload to acquire
the `20261012-activity-labels-v4` assets.
