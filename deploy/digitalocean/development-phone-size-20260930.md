# Compact phone windows — September 30, 2026

Development-only frontend release `2f541394dabffc53112a3cd54b7f7e3921a9fb0e`,
with the main sizing change in `429ef3879f4f954c474fe6dc4ca2557982269187`.

The minimized phone is 32 pixels tall, equal to a minimized project window.
The title, audio trace, mute, hold/resume, hangup, free-move, dock and close
controls fit in one row. The redundant Restore button is hidden; clicking or
keyboard-activating the title still opens the previous expanded placement.

The floating dialer is 264 by 448 pixels, down from 330 by 560. Header controls,
spacing and number-entry layout are compacted while the keypad and Call action
remain visible without scrolling. Docked sizing is unchanged.

Validation: the phone browser regression checks exact floating dimensions,
project-height parity, single-row control bounds, absence of Restore, dock and
float transitions, ended-call outcome persistence, responsive placement and a
visible Call action at 720px viewport height. Captured floating and minimized
screenshots were inspected. Fixture APIs were used; no live call was placed.

The immutable overlay updates only the phone tray and its manifest cache token.
Role-specific manifest entries and unrelated changes are preserved. No database,
provider, worker or production changes are included. Evidence and previous role
paths are in ignored `output/phone-size-20260930/`.

Rollback: inspect subsequent releases first, restore each role's previous immutable
symlink from the manifest, restart its development service, and verify readiness
and outbound safety. There is no data migration to reverse.

Web, compatibility and pool were activated from
`8ce56b346d45dafc6c99ebfbc045e9b92c65bc07` to
`2f541394dabffc53112a3cd54b7f7e3921a9fb0e`. Worker remains unchanged.
Both changed assets matched their expected hashes across four public requests
each. Public readiness confirmed the new release and development outbound safety.
The browser layout/interaction regression passed again using the served files.
