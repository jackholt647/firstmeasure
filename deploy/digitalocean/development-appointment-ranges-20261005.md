# Duration shortcuts and multi-day appointment ranges

Runtime commit: `19209b71ebc31eecc2cf2e128601fe8428442531`.

Timed appointments offer 15/30/60/90/120-minute buttons; day-based appointments offer 1/2/3/7/14-day buttons. Custom durations remain available. Weeks mean consecutive calendar days. Changing a duration keeps its appointment preset context.

Day-based booking uses a full-width calendar without the time-slot panel. Start and inclusive End controls select the range; changing the end updates duration. Available starts satisfy the entire configured duration. End-date choices are checked from the selected start through the candidate end, including cross-month ranges. The existing planner enforces one eligible resource set across every day and recurrence, and booking rechecks it atomically. A missing crew is reported as a configuration issue rather than an empty time-slot panel.

Preview calls are read-only, cached within the picker and bounded to three concurrent requests. Superseded month/configuration views discard stale responses. No business API or department architecture changes. Public timed embeds retain their existing component path.

Nine browser tests pass, including cross-month ranges, inclusive duration, unavailable endpoints, mobile bounds, versioned upgrade behavior and existing booking/Settings flows. A disposable hosted Instant Full Org test creates a crew, selects and books three days, and checks that overlapping crew availability is then blocked. Desktop and mobile screenshots were inspected. Final deployed verification passed on all three development web roles. The live booking blocked all three selected days and left the following day available, with zero browser errors; the disposable test organization was removed.

Deployment overlays nine owned frontend files onto verified development baseline `7427319f4f738d779e35f50b6b754f19f7493448`. Unrelated staged and unstaged work remains excluded; legacy-role manifest drift is retained. Asset versions include the availability component as well as booking/configuration/styles. Worker and production are unchanged.

Evidence and rollback paths: `output/appointment-ranges-20261005/`. Restore the per-role previous release path from its manifest, restart the affected development service, reload PHP-FPM, and verify readiness/isolation to roll back.
