# Project Reports tab: stale header tab strip (development, October 14)

Commit `8cad86bd5d0830f61643aa3a7c2636f6117b41a6`, built on `5023afb8`. Frontend only
(`measurements/project.js` and the apps manifest): legacy (compatibility), web and pool.

## What was wrong

The Reports tab moves its report tab strip (`#rMeasureTabs`) into the window header. When the
Reports panel was rebuilt, it made a new strip and moved that one into the header too. The
old strip stayed in place: it still showed its first selection ("Model & photos") and still
answered clicks. A click opened the chosen report, but the old strip went on highlighting
"Model & photos".

## Fix

`renderReportNavigation` removes every other `#rMeasureTabs` in the window before placing
the current one. `tests/report-header-browser.test.mjs` now rebuilds the panel strip and
checks that a single strip is left and that it follows clicks. It fails on the previous
source and passes now.

## Rollout

All roles were on `d46c3f6a`. Only the manifest drifted; it merged cleanly. Staged, then
activated legacy, web and pool one at a time. `verify` passed on all three, and the public
file serves the fix.

Not verified in a signed-in browser session.
