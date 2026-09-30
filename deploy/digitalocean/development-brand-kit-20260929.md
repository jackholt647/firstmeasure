# Brand Kit and shared color picker - development, September 29, 2026

Source release: `a2577c9e9ee9e86291f1c4df157b9f02cfe297e0`, pushed on `codex/consolidated-firstmeasure-20260923`.
Development activation is authorized in the originating chat. Production is unchanged.

Doc Studio uses the shared Company Settings Brand Kit: resolved media logo URLs,
alternate logos and primary selection, logo appearance, supporting palette regeneration,
serialized debounced autosaves with success/error toasts, default and optional title fonts.
Palette/fonts share the left column; the logo editor fills the right column. Replacement
controls are compact, section descriptions are tooltips, and redundant subtitles are removed.

A shared custom color picker replaces native color dialogs across active platform,
Measurements and standalone editor entry points. Backing inputs preserve existing values,
selectors and events. The complete consumer audit is in
[the color picker architecture guide](../../docs/architecture/color-picker.md).

The 15-file frontend/PHP delta is applied to verified per-role live baselines, preserving
unrelated runtime source and workspace changes. Both web nodes and compatibility previously
ran `6ca57704c2c46951a2a84f4f1fe9555981e7dbfe`. Source/host/runtime guards run before staging and activation. No
backend rebuild, migration, database, configuration, topology or worker changes are needed.
The existing development autoscale-image limitation remains.

Validation: 14 focused browser, Company Settings and CSRF tests; TypeScript and frontend
syntax checks passed. Desktop/mobile screenshots were inspected. The broader Doc Studio
suite has the same 24 pre-existing failures with both the baseline and updated studio code.
Staged PHP/JavaScript checks and content hashes must pass before activation. A CRLF hash
mismatch was caught before activation; that incomplete tree was preserved, then a normalized
bundle was restaged. Evidence: ignored `output/brand-kit-deploy/` and `output/brand-kit/`.

Activated on development web `do-598520065`, pool `do-603124965`, and compatibility.
All 15 per-role file hashes, runtime release identity, development environment isolation,
outbound safety and readiness passed. Both web nodes returned through public traffic.
Twelve public static asset hashes and six public readiness responses passed. Three browser
checks passed again using the scripts fetched from dev.1m8.ai, covering logo selection,
font inheritance, palette regeneration, autosave, responsive layout and custom picker events.
Browser checks use controlled fixture data; no customer branding records were changed.

Rollback: inspect for intervening releases, restore each role's prior `/opt/firstmeasure/current`
symlink, restart its `firstmeasure-development-web.service` or
`firstmeasure-development-legacy.service` and PHP-FPM, then verify readiness, development
isolation, outbound safety and web load-balancer return. No migrations require reversal.
