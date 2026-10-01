# Calling interface polish — September 30, 2026

Development-only update for dev.1m8.ai. Production and provider configuration are unchanged.

Source: `5aabcd80430010edadb15de90e318754c8d696a5`, with focus and settings refinements through `578b279a112416e7257f071736e77d4cedaba121`.

The phone tray now inherits the organization palette, platform typography and surface tokens. Number entry, a labeled twelve-key pad and the call action lead the flow; optional call metadata lives in a disclosure. Contact search and queue empty states have consistent hierarchy. Keyboard tab navigation, focus treatment and pressed control states are explicit. The call action fits a compact floating phone at a 720px viewport height. Floating phones stay above other minimized windows after resizing, as well as on first opening.

Call Center distinguishes setup from a ready calling workspace, with live counts, team availability and a direct dialer action. Phone setup reuses the development disclosure and puts transport implementation details behind Connection details. Completed mock setup refreshes its parent view. Shared generated headers use branded icon tiles, theme colors and grouped tabs; the concurrently added selector isolation for existing app headers is retained.

The live audit found that the eager PHP bootstrap did not load AppChrome before grouped apps. The loader fix was incorporated by the concurrent invitation/bootstrap release and is preserved here. A source-order regression test protects that path.

Validation: JavaScript syntax; five focused browser tests for app registration, responsive shared headers, bootstrap order, required/optional outcomes and the phone lifecycle. Tests also check a custom brand color, plus/delete number editing, collapsed optional fields, visible call action and resized minimized-window clearance. In-app-browser visual review covered Call Center, setup, docked/floating phone, contact search and mobile. Calls use fixture APIs in browser tests; no live call was placed.

Release overlays preserve the live role baseline, including concurrent invitation/resource-list/header work. Worker code, database schema, carrier setup and production are unchanged. Evidence is in ignored `output/phone-polish-20260930/`.

Activated web, pool and compatibility to `578b279a112416e7257f071736e77d4cedaba121`, preserving the completed `15d3cbd8fae869c573307b44b680fab770b9ee7a` baseline on each. Worker remains `1e0858b281c905950e7d6476d67357d77f37e123`. All three services passed readiness. Seven served frontend files matched their expected hashes across four requests each; public readiness reports this development release with outbound safety enforced. Unauthenticated call status and contact searches returned 401. The phone regression passed again using the served assets. Signed-in browser verification confirmed Call Center and phone setup load with the organization’s typography and colors. The initial missing-AppChrome startup errors did not recur on the new navigation.

Rollback: check for subsequent releases first. The role manifest records each previous immutable release and directory. Restore that role's prior symlink and restart only the corresponding development web/compatibility service, then verify readiness and outbound-safety enforcement. No data migration needs reversal.

Final visual follow-up: `4714d592baef6c25b67b55d33ceb7b1de6ea8004` centers generic empty-state icons, and `ba65a2f75fe938599c3f44d3acb48de92518cdab` refreshes the stylesheet cache. Web, compatibility and pool are now activated on `ba65a2f75fe938599c3f44d3acb48de92518cdab`. Seven served asset hashes and public development readiness/outbound safety passed again. Hosted keyboard navigation from Dialer to Contacts also passed. Follow-up evidence: `output/phone-polish-alignment-20260930/`.
