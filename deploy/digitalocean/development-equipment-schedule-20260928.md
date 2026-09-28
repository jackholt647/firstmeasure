# Development equipment schedule and live fleet status

Source release `d3701c17d8c19a06e3a90e89e2df1122f9ec376d` is active on both
development web nodes, the compatibility API, and the worker. Production was
not changed. The four roles started from the same verified `71f21223` release.
The release overlays nine committed source files and three compiled equipment
modules; the rest of each role's existing runtime remains hardlinked to its
previous immutable release. Local delta and hash manifests are retained under
ignored `output/fleet-schedule-20260928/`.

Scheduled maintenance now creates a shared `calendar_events` record of type
`equipment_maintenance`. Maintenance dates read from that event, so moves in
the global Scheduling app appear in Equipment. The Equipment Timeline includes
both project and calendar events, and moves either through the respective
shared scheduling API. Equipment status is computed for the current instant:
active maintenance means Down, active project or booking events mean In Use,
and an equipment reservation means Reserved. Down takes precedence over In
Use, then Reserved. Retired remains a stored lifecycle state. The previous
manual status selector and optional downtime-block setting were removed from
the Equipment UI; new unit writes accept only Available or Retired.

The Ironwood Fleet Lab synthetic organization was updated with an active
maintenance event for Truck 03, a reservation for Truck 04, and an active
Willow Ridge project assignment for Truck 01. A service readback confirmed
Down, Reserved, and In Use respectively, with each status linked to its event.
These test events are labeled synthetic and remain only in development.

Verification: TypeScript check and build passed locally; TypeScript check also
passed in the staged Linux release. Focused equipment API cases passed,
including global calendar rescheduling and live status transitions. A browser
check loaded and moved a maintenance event in the Equipment Timeline without
page errors. Twelve public readiness requests reached both web nodes on the
new release, and the public Equipment script SHA-256 matched the staged
manifest. Each API role reported development data isolation and healthy
readiness. The worker had zero running and queued jobs before activation and
a fresh heartbeat afterward. The inherited equipment frontend contract suite
still contains outdated assertions unrelated to this change; its new fleet
status assertion passes.

Rollback: repoint each development role's `current` symlink to its preserved
`71f21223d5ffeca94efbf3d3d19f0a9777a2e881` release, restart the matching
development service and PHP-FPM on web and compatibility hosts, then verify
release identity and development isolation. Wait for an idle worker before
switching that role. Organization events and work orders remain in development
storage after a code rollback.
