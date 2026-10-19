# Notes toolbar and shared formatting state — October 12, 2026

Feature commit `7f3def9de84b80ab2aecf23c9b0ab2c75541b9e5`.

Opening a note's replies displays the thread with Add Reply at the lower right.
The rich composer starts hidden and opens only from that button. Closing the
composer keeps the thread visible and retains its draft. Collapsing and reopening
the thread keeps the composer hidden; Add Reply recovers its saved draft. Sending
successfully returns to the thread view. Archived roots cannot open a composer.

Notes uses Activity's toolbar geometry: a visible bordered search field with an
inset search icon on the left and Show Archived/Hide Archived on the right in the
filter-button position. The inner Notes heading and collapsed-search row are
removed, leaving the tray's outer title. Escape clears the search.

The shared Channels rich-editor toolbar now tracks bold, italic, strikethrough,
lists and block formatting through aria-pressed. Active controls remain red with
a pale red background, including on Notes and Feed where local styles previously
masked shared control styling. Input, caret/selection changes, keyboard shortcuts
and programmatic draft resets update the state. The shared document selection
listener uses a WeakMap, avoiding retention of discarded editors. Clicking a
format control preserves an already-active caret: replacing an unchanged empty
range would otherwise discard the browser's pending formatting and prevent a
second click from turning it off before typing.

## Validation

Browser regressions passed for Notes, Channels/DMs/thread replies and Feed posts.
They cover active red styling, on/off toggles in empty and populated drafts,
caret changes between bold and ordinary text, native Control+B, Add Reply gating,
thread/composer collapse behavior, retained drafts, the visible search toolbar
and existing send/upload/archive workflows. Width checks include 360/280/240
pixels. Fixtures use mocked APIs and do not post customer notes.

## Development publication

The three owned frontend files are the Notes library, Channels UI library and
the application manifest's relevant bundle versions. Notes is versioned
`20261012-notes-toolbar-format-v2`; Channels UI uses
`20261012-format-active-v2`. Live manifest variants are retained separately for
compatibility and web/pool; only these two version tokens change. Other Feed,
phone, window and compatibility entries remain intact.

Immutable stages check audited before/after hashes and JavaScript syntax, break
target hard links before writes, guard current paths/runtime identities, and
activate atomically with PHP-FPM reload. No API restart, database migration or
worker change is required. Receipts and reviewed manifests/payloads are retained
under ignored `output/notes-toolbar-deploy/` and inside each release. Rollback
must preserve later releases and reverse only these owned changes. Production
is outside this rollout.

## Verified rollout

All three roles activated and passed final source hashes, readiness, exact
unchanged backend runtime identity and enforced development isolation. The three
browser regressions passed again using files fetched from dev; public Notes,
Channels UI and role-appropriate manifest hashes matched the reviewed payloads.

| Role | Current frontend release | Previous current release |
| --- | --- | --- |
| Web | `/opt/firstmeasure/releases-phone-second-pass/7f3def9de84b80ab2aecf23c9b0ab2c75541b9e5-notes-toolbar` | `/opt/firstmeasure/releases-phone-second-pass/3e4215c05cf725f3e2729e442d8c89b04726cd88-notes-replies` |
| Pool | `/opt/firstmeasure/releases-phone-second-pass/7f3def9de84b80ab2aecf23c9b0ab2c75541b9e5-notes-toolbar` | `/opt/firstmeasure/releases-phone-second-pass/3e4215c05cf725f3e2729e442d8c89b04726cd88-notes-replies-r3` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases-phone-second-pass/7f3def9de84b80ab2aecf23c9b0ab2c75541b9e5-notes-toolbar` | `/mnt/firstmeasure_dev_releases/releases-phone-second-pass/3e4215c05cf725f3e2729e442d8c89b04726cd88-notes-replies-r3` |

The backend runtime remains `62a9a116b8975dfc8b16aec49989ed576dd60f10`.
Normalized Notes SHA-256:
`3c24a9e7949a5e01c1edc1b1cebe054fad18b67ecb6e15f16deed4c307fbd94c`.
Channels UI SHA-256:
`e2973295f0b448db65c9516f782d3794dd394fd44ad19eddeeaa27e3a9346d08`.
