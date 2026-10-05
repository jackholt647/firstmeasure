# Mobile map cache and order reload continuity — October 5, 2026

Runtime source: `33320dc9bd6034f6074040fb160f04dbb26cd898`. Development activation was authorized in the ongoing conversation.

The project layout import still used its September 30 URL after the mobile map sizing fix. Reproducing with that cached asset made the map content zero pixels wide, despite a nonzero map height. The project request bundle now requests new versions of the layout, window shell and retained-window registry. This avoids requiring a manual cache clear.

An open, unfinished order saves its UI state to this browser tab's session storage on reload. Only the owning portal consumes it, and only on a reload for the matching organization and project. It restores report scope, pin confirmation, mobile step, contacts, notes, CCs, add-ons and persisted exterior media references/capture stage. It does not persist an active camera stream or an upload still in progress. Explicit close and later project opening continue to use the normal project view; completed reports do not resume ordering.

The embedded project route handler now defers to its parent's in-flight initial project read. Previously it could start a second read, whose later hydration overwrote the restored order state.

## Validation

- Twelve focused report-entry and shared window/shell tests passed, including a new reload/close browser regression that loads the retained-window code in both portal and iframe.
- JavaScript syntax checks passed for the three runtime files.
- A temporary development organization with FirstMeasure, both report scopes and no extra project tabs exercised real autocomplete and Google Maps. The candidate passed report-scope selection and refresh, roof details and refresh, Full Structure photo step and refresh, and explicit close/reopen. No order was purchased.
- The old layout reproduction measured a zero-width map. The corrected mobile map measured 414px wide with rendered Google Maps tiles.

## Deployment

All three development web roles activated and passed release, file-hash, readiness and development-isolation verification. All three public assets match their deployed hashes. Seven hosted browser scenarios passed with no asset interception, including preserved technician notes and both report scopes. Three frontend files are overlaid onto each immutable development release, preserving unrelated live changes. The compatibility host's old registry URL conflicted with the version bump; only those three import lines were resolved to the new versions. No production or worker deployment.

Evidence: `output/mobile-order-resume-20261005/` contains per-role source inventories, guarded manifests/payloads, screenshots, browser logs and the stale-cache reproduction. Prior release on all three affected roles: `19209b71ebc31eecc2cf2e128601fe8428442531`. Rollback uses each manifest's `previous_path` and its development service.
