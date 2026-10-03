# Instant Full Org appointment defaults — October 3, 2026

Source: `1a417f9bbe8f3679ee9a18c04176a242ef730e72`. Development deployment only.

## Presets and behavior

Instant Full Org development sandboxes seed Sales appointments (one hour, exact start), Installation work (two full days), Maintenance appointments (one hour in a four-hour arrival window, four quarterly occurrences), Repair appointments (same window without recurrence), Material deliveries (one hour in a four-hour arrival window, delivery flag), Company meeting (all people, one hour) and Company sales meeting (all salespeople, one hour). Production defaults reserve one crew and its whole active roster. All settings are editable.

Meetings default to Company office, a reference to the existing Company Settings branch address with global contact fallback. The office is resolved when booking and saved as a snapshot; a missing address is shown as a settings hint. Project address, another address and no location remain selectable. A preset retains the office reference rather than hardcoding an address.

Day scheduling checks every consecutive local day and the same resources throughout. Events reserve local midnight through an exclusive local midnight end; DST does not change the day count. Closed days are not skipped. Existing timed public forms remain compatible.

New sandboxes receive stored catalogs. Older Instant Full sandboxes without a saved catalog receive the new defaults on reads; existing saved catalogs are preserved. Other workflows and production defaults are unchanged. Only the appointment seed insertion is included from the concurrently edited signup service.

## Verification

Six planning/booking tests, five browser tests, three recurrence tests, TypeScript and 50 publication tests passed (one gated PostgreSQL test skipped). Tests include all-day DST boundaries, day-by-day staffing conflicts, company meeting blocking and resolving a changed office address at booking. All four development roles passed staging and activated the backend/defaults release `1a417f9bbe8f3679ee9a18c04176a242ef730e72`; readiness and outbound isolation passed. The separate frontend correction `93e869010ac19bf8a677cdde966175906e25db9e` makes calendar details honor office/custom/no-location overrides and preserves legacy project-address fallback. It applies only to the two web roles and compatibility frontend; worker code stays on the backend release. Both web roles and the compatibility frontend passed final hash/readiness/isolation verification on `93e869010ac19bf8a677cdde966175906e25db9e`; the worker passed verification on `1a417f9bbe8f3679ee9a18c04176a242ef730e72`. Public asset checks confirm both calendar surfaces honor the selected location.

A newly created hosted Instant Full sandbox had all seven stored presets. Real PostgreSQL bookings verified a two-day installation with a crew and its roster, resolved office addresses, and company meetings blocking sales availability. Browser checks verified the day-count input and date-only availability choice, office selector/address, preset choices, mobile bounds and zero browser errors. Screenshots were inspected after availability loaded. Temporary verification organizations and their records were deleted afterward.

Deployment preserves per-role baselines and excludes unrelated workspace changes. Intermittent SSH transfer/reset failures were retried with baseline checks intact. Rollback paths are recorded in each manifest: the backend release follows `f552a8219a9b2e4a8da5e198f480f469dabf6ca9`; the frontend-only release follows `1a417f9bbe8f3679ee9a18c04176a242ef730e72`. Restore a role's previous symlink and restart that development service.

Evidence: `output/appointment-defaults-20261003/` and `output/appointment-location-display-20261003/`. See [planning architecture](../../docs/architecture/appointment-planning.md).
