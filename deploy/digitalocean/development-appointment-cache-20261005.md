# Appointment asset upgrade path — October 5, 2026 UTC

The user reported the old booking form after a hard refresh. Fresh-session checks of the prior release passed but did not cover an existing browser cache. The manifest still identified booking as `20261002-booking-v1`, and lazy configuration/calendar/style URLs were unversioned.

Commit `7427319f4f738d779e35f50b6b754f19f7493448` adds a content-versioned portal entry point before app manifests, propagates that version to booking dependencies and CSS, updates the standalone Scheduling/manifest fallback version, and versions Settings' configuration loader. No API, permissions, organization data or production changes.

Eight browser tests pass. The added test warms a real Chromium HTTP cache with old unversioned scripts, navigates within the same browser context, and verifies the compact UI and versioned calendar/configuration/style requests. This is separate from the fresh-session hosted booking/Settings checks.

Development deployment uses seven owned files over audited baseline `8e36db65ff0bff3acadbd9c68ee4a5f88afe9e65`. Per-role legacy manifest differences are preserved through a three-way merge. Shared manifest and company Settings files include only this task's replacements; unrelated local work remains excluded. PHP syntax and JavaScript syntax checks run during staging.

Inventory, per-host hashes and rollout manifests are retained in `output/appointment-cache-20261005/`. Rollback uses the manifest's previous absolute release path, followed by restarting only the affected development service, PHP-FPM reload and readiness verification.

Final verification: all three development web roles passed source-hash, release, readiness and isolation checks. A hosted Instant Full Org test recorded the content-versioned entry point and matching configuration/calendar/CSS requests, rendered the compact desktop/mobile UI, booked an unassigned appointment, and saved/deleted a new preset while retaining all seven defaults. Department editing also passed. No browser errors; the disposable organization was removed. The user’s separate Chrome profile was not available through the connected browser inventory, so its exact prior cached response was not inspected.
