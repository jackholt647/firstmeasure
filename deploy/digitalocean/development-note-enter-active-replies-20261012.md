# Note Enter, active reply counts and thread boundary — October 12, 2026

Feature commits `8b931c913b3f73dbd867024ac650aabc973c4893` and
`6cd8f83dbf3865fe82e4ed1f49786846a9291e17`.

The main Notes composer sends with Enter and inserts a line with Shift+Enter.
The shared Notes/reply keyboard handler captures plain Enter before the rich
editor's list handling, matching Channels for ordinary text, lists and quotes.
Mention selection, composition, key code 229 and repeated keys are respected.
Inline edit save shortcuts are unchanged.

Project Note root reply counts use one organization-scoped aggregate query per
hydration batch, counting only rows without deleted_at. It applies to notes in
history, pinned notes and thread roots, including older notes with stale stored
counters. Archive and restoration therefore update the displayed count without
a migration or data rewrite. The existing total counter and ordinary channel
message behavior remain unchanged; Notes exposes the current active total.

The left reply line belongs to the reply list, not the whole thread wrapper.
It stops at the last visible reply and is absent for an empty list; Add Reply and
the composer sit outside it. A successful reply post immediately hides the
composer, shows Add Reply and focuses that button before awaiting thread/history
refreshes. Failed posts keep their draft and composer open.

## Checks

Local TypeScript passed. Seven isolated note API tests passed locally and on all
three staged Linux roles. The count test archives/restores replies, checks zero
remaining replies and deliberately changes an older root's stored total to 999
to verify accurate history/thread responses without a migration.

The browser regression passed with Enter/Shift+Enter in the main composer,
composition suppression, list/quote Enter sending, active reply counts in the UI,
archive/restoration, the reply-list boundary, and composer closure during a delayed
thread refresh. Existing drafts, formatting, uploads, menus and narrow widths
remain covered. Fixture APIs do not post customer notes.

## Development rollout

Owned changes are the two Channels source modules, their compiled counterparts,
Notes library and its version in the application manifest. Notes uses bundle
version `20261012-notes-enter-count-v4`. Audited live Feed moderation and manual
Feed query additions are preserved. Web/pool and compatibility retain their own
live manifest entries, changing only the Notes version.

Each role's initial immutable stage compiled TypeScript and passed all seven
API tests. The final keyboard-only follow-up clones that validated stage,
verifies identical API source/compiled hashes, replaces only the two frontend
files, checks their syntax and writes the final release identity/receipt. The
earlier stages were never activated. This reuses the validated backend build
without treating modified backend sources as already tested.

Activation guards the prior current path and runtime, switches the immutable
release atomically, restarts only the development web/legacy service and reloads
PHP-FPM. Development readiness and isolation remain mandatory; failure restores
the prior release only while the candidate is still current. No migration or
worker change is required. Production is outside this rollout.

Reviewed payloads, baselines, compiled hashes and scripts are retained in ignored
`output/notes-counts-deploy/`; releases contain `notes-counts-release.json`.
Rollback must preserve intervening changes and reverse only this owned patch.

## Verified result

All three roles activated successfully. Final source and compiled hashes, exact
runtime release identity, readiness and enforced development isolation passed.
The public Notes and manifest hashes matched the reviewed final payloads. The
expanded browser regression passed again with libraries fetched from dev after
all three roles were active.

| Role | Current release | Previous release |
| --- | --- | --- |
| Web | `/opt/firstmeasure/releases-phone-second-pass/6cd8f83dbf3865fe82e4ed1f49786846a9291e17-notes-counts` | `/opt/firstmeasure/releases-phone-second-pass/7f3def9de84b80ab2aecf23c9b0ab2c75541b9e5-notes-toolbar` |
| Pool | `/opt/firstmeasure/releases-phone-second-pass/6cd8f83dbf3865fe82e4ed1f49786846a9291e17-notes-counts` | `/opt/firstmeasure/releases-phone-second-pass/7f3def9de84b80ab2aecf23c9b0ab2c75541b9e5-notes-toolbar` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases-phone-second-pass/6cd8f83dbf3865fe82e4ed1f49786846a9291e17-notes-counts` | `/mnt/firstmeasure_dev_releases/releases-phone-second-pass/7f3def9de84b80ab2aecf23c9b0ab2c75541b9e5-notes-toolbar` |

All roles report runtime `6cd8f83dbf3865fe82e4ed1f49786846a9291e17`; their prior
runtime was `62a9a116b8975dfc8b16aec49989ed576dd60f10`. Backend compilation and
isolated tests were validated in the unactivated `8b931c91...-notes-counts`
stages; final receipts retain that provenance and the identical compiled hashes.
