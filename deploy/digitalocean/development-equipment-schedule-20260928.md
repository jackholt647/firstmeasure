# Development equipment schedule and live fleet status

Final release `330470f3712f69c53c3bb14f36c112232df14d48` is active on both
development web nodes, the compatibility API, and the worker. Production was
not changed. The initial equipment release was `d3701c17d8c19a06e3a90e89e2df1122f9ec376d`,
staged from verified `71f21223`. The final five-file legacy-status follow-up
was staged from the web nodes' concurrently advanced `a3d9ae9` baseline and
the `d3701c1` baseline on compatibility and worker. Each role retains its own
prior immutable release for rollback. Local deltas and hash manifests are in
ignored `output/fleet-schedule-20260928/`.

Scheduled maintenance now creates a shared `calendar_events` record of type
`equipment_maintenance`. Maintenance dates read from that event, so moves in
the global Scheduling app appear in Equipment. The Equipment Timeline includes
both project and calendar events, and moves either through the respective
shared scheduling API. Equipment status is computed for the current instant:
active maintenance means Down, active project or booking events mean In Use,
and an equipment reservation means Reserved. Down takes precedence over In
Use, then Reserved. Retired remains a stored lifecycle state. Historical
manually stored Down and Reserved values remain effective until converted to
events and are labeled as legacy manual status. The previous manual status
selector and optional downtime-block setting were removed from the Equipment
UI; new unit writes accept only Available or Retired.

The Ironwood Fleet Lab synthetic organization was updated with a maintenance
event for Truck 03, a reservation for Truck 04, and a Willow Ridge project
assignment for Truck 01. Initial readback confirmed Down, Reserved, and In
Use respectively, each linked to its event. At the final readback, Truck 01's
project event had been marked completed, so the unit correctly showed
Available; Truck 03 remained Down and Truck 04 Reserved. The synthetic test
events remain only in development.

Verification: TypeScript check and build passed locally; TypeScript check also
passed in the staged Linux release. Focused equipment API cases passed,
including global calendar rescheduling, live status transitions, and safe
handling of historical manual Down values. A browser
check loaded and moved a maintenance event in the Equipment Timeline without
page errors. Twelve public readiness requests reached both web nodes on the
final release, and the public Equipment script SHA-256 matched the staged
manifest. Each API role reported development data isolation and healthy
readiness. The worker had zero running and queued jobs before activation and
a fresh heartbeat afterward. The inherited equipment frontend contract suite
still contains outdated assertions unrelated to this change; its new fleet
status assertion passes.

Rollback: repoint each web node's `current` symlink to its preserved `a3d9ae9`
release, and compatibility and worker to their preserved `d3701c1` release.
Restart the matching development service and PHP-FPM on web and compatibility
hosts, then verify release identity and development isolation. Wait for an idle
worker before switching that role. Organization events and work orders remain
in development storage after a code rollback.
