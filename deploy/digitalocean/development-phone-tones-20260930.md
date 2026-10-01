# Phone tones, readiness and editing — September 30, 2026

Development-only source: `c275eb94a8105acdea59cece2711acb6dfeea861`.

Typed phone digits and keypad clicks play short local DTMF tones by default.
Keypad sounds can be disabled in Call details & options or beside the active-call
keypad. The browser saves the preference for the organization and account.
Disabling local sound preserves in-call provider DTMF commands. Tone oscillators
release after playback and their audio context closes with the phone.

The initial readiness prompt is an inline card over the number, with the dialer
dimmed and inert behind it. Checks run there with short progress text; Not now
returns to editing without bypassing device validation. Errors appear in a small
bottom strip. The primary hover state retains readable brand contrast. Detailed
audio diagnostics remain available from settings.

The delete button no longer becomes stuck at the start of a retained cursor
position. It removes the final digit or selected range. Keyboard focus and caret
restoration now follow tray DOM rearrangement, preserving typing through a
connection update.

Validation: the tray browser regression verifies DTMF pairs, default-on behavior,
saved opt-out, live DTMF while muted locally, deletion of a 15-digit number by
both methods, typing after a connection redraw, inline readiness, failure/retry
presentation, bottom error placement, dismissal and primary hover contrast.
Connection cancellation, reload/duplicate-tab identity and the existing required
outcome/readiness tests also passed. Screenshots with the app icon stylesheet
were inspected. All call/provider APIs were fixtures; no live call was placed.

The immutable overlay changes only the phone runtime, tray and manifest cache
tokens, preserving the live role baseline and compatibility manifest differences.
Worker, backend, database, provider configuration and production are unchanged.
Evidence and previous paths are in ignored `output/phone-tones-20260930/`.

Rollback: inspect newer releases first, restore each role's prior immutable
symlink from the manifest, restart its development service and verify readiness
and outbound safety. No data migration needs reversal.

Web, compatibility and pool were activated from
`bf582ca080208f828cb4f11615b8696e39b8e80e` to
`c275eb94a8105acdea59cece2711acb6dfeea861`. Worker remains unchanged.
All three changed assets matched their hashes across four public requests each.
Public readiness confirmed this development release with outbound safety enforced.
The expanded phone browser regression passed again using the served files,
including tone preferences, in-call DTMF, deletion, focus, readiness and errors.
