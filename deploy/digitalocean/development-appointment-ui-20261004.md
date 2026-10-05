# Compact appointment booking — October 4, 2026

## Change

Booking now uses recent preset buttons with a searchable More menu, compact project/name pickers, and a directly editable address with saved locations. Advanced is one 32px disclosure row. Delivery, recurrence and arrival windows use independent switches. Staffing controls have compact labels and tooltips. Changing configuration retains the selected date.

Preset creation, editing and deletion live in Settings → Scheduling → Appointment presets. Department administration is also in Settings: the existing organization department settings are used when available, with the existing catalog editor retained in Scheduling Settings for older development backends. Booking contains no catalog administration controls. Settings saves retain revision checks and permission enforcement.

The shared public calendar retains its existing styling. Staff-only styles are scoped to the booking dialog/configuration editor. Existing availability and booking APIs are unchanged.

## Source and verification

- UI commit: `d9cc7afdcce9086c938d51990c803c67f4c90bc8`; loading-state follow-up: `8e36db65ff0bff3acadbd9c68ee4a5f88afe9e65`, on the canonical branch.
- Seven focused browser tests pass, covering named assignment, independent flags, standalone booking, stale response rejection, public embed styling, searchable project selection, address resolution, and Settings save/delete/conflict behavior, including navigation disabled while the editor loads.
- Rendered desktop and mobile screenshots inspected at 1280×800 and 390×844. Collapsed dialog heights were 549px and 592px respectively, without dialog overflow. Complex advanced configurations may scroll within their own bounded section.
- A disposable Instant Full Org sandbox verified default types, office location, More search, date retention and preset save/delete using the real development backend. The test organization was removed afterward.
- Final hosted verification passed against the deployed assets: unassigned office meeting booking, actual Settings → Scheduling entry, preset creation/deletion with all seven defaults retained, and department creation. No browser runtime errors. All temporary sandbox organizations were deleted.
- All three audited development web roles verified the release hash, source file hashes, readiness and development isolation. Public readiness returned the new release.

## Deployment scope and rollback

Frontend-only overlay of six owned runtime files onto audited development release `f9951cd170bb82b49ba83a99abeaa0d006f8c4da`. Shared company Settings file includes only this task's loader insertion. Concurrent uncommitted department, backend, assistant, contacts and other work is excluded. Worker and production are unchanged.

Release artifacts, per-host source hashes, inventory and rendered screenshots: `output/appointment-ui-20261004/` and `output/appointment-ui-loading-20261004/` (local evidence). The release manifest retains each role's previous absolute path. To roll back, restore that verified prior symlink on the affected development role, restart its development service, reload PHP-FPM, and verify readiness and environment isolation.

The Settings follow-up disables preset navigation until the asynchronous editor is ready, preventing an early New preset click from leaving the old preset selected. It overlays only `settings.js` onto the verified UI release; its rollback baseline is that UI release.
