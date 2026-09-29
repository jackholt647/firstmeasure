# Compact notification controls - development, September 29, 2026

Source commit: `fa9295e029d6d38225b51b82d8af8b177f57749f`.

The in-app selector is now three always-visible grouped buttons: Off, Silent,
and Alerting. Advanced is a chevron at the end of the existing notification row.
Its initially hidden tray is one compact row of Bell and Badge switches, with
explanations in the existing tooltip system instead of paragraphs. Delivery and
saved preference semantics are unchanged.

Only `public/libraries/apps/settings/company.js` changes. Each role inherits its
verified live predecessor, `b1e6f324344741609c70243b625be9fb267c7ddb`, with a guarded
single-file overlay. No backend build, database, worker or topology changes.

Syntax checks and browser fixture checks passed for all three modes, independent
push, saved bell changes, disabled advanced controls while Off, initially hidden
Advanced and mobile fit. Geometry checks confirm the state controls, Push and
chevron share one row and the two Advanced switches share one row. Screenshots
were inspected. Evidence is in ignored `output/notification-compact-20260929/`.

Both development web nodes and compatibility activated `fa9295e` and passed
local readiness, environment isolation and changed-file hashes. Both web instances
were observed healthy through the public load balancer, and the public script
matches its release hash. The browser fixture passed again using the actual
hosted script, including keyboard activation and tooltip visibility. Test fixtures
mock preference responses; no tester preferences were changed. Rollback must
inspect intervening releases before restoring predecessor symlinks and restarting
the development service and PHP-FPM one node at a time. The existing historical
autoscale-image limitation remains. Production is unchanged.
