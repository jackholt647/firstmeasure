# Customer references during full-house ordering — development

Release: `05a11ef27f291a0665e2683c0d66a6e46b5b1835`.
Baseline: `3e4d25e52b2a569ffbc9081a8c9705ae642b5f0d`.
Source branch: `codex/customer-order-references` in the isolated FirstMeasure References worktree.

The private `/measure/internal/full_house.php` form accepts eight house-relative elevation photos, one walkthrough video, and optional extra photos. Directional slots use front, back, left, right, front-left, front-right, back-left, and back-right. Missing photos do not prevent internal testing.

After imagery creation, references upload in bounded 8 MB chunks before editor navigation. Completed files are published only after their parts exist. Upload retry reuses the created project and completed uploads. Customer attribution requires the existing full-house owner gate plus the ordering session's CSRF token; ordinary editor uploads retain Tech/QA attribution. Direction assignments persist in each project resource index and are returned in inventory. Resources shows the direction beside the original filename.

Validation: browser selection/upload check covered eight slots, two extra photos and a two-part video, checksum submission and duplicate-free retry; three ordering tests and two real-PHP boundary tests passed on Windows and Linux. PHP checks covered CSRF rejection, incomplete publication, invalid direction, customer origin, retained original filenames and video byte ranges. No real customer order or imagery charge was created for validation.

All three development roles staged and activated with runtime environment and outbound-isolation guards. Every stage verified 18,082 unchanged files, including compiled code and dependencies. No database or configuration changes. The worker had no running jobs when activated. Rollback is the preserved baseline release on those same development roles. Production was untouched.

Five public source files changed: full_house.php, project_resources.php, full_house_address.js, new full_house_references.js, and project_resources.js. Existing texture/editor changes were preserved; unrelated local PDF and geometry work was excluded. A complete archive and manifest are retained on the development worker as `/home/dev/references-05a11ef.tar.gz` and `.tar.json`; archive SHA-256 is `bfbd29e5905b2462fbdfb404bb8177efdae38c5f81b73c1ec98a5e8439ec4676`. Activation used a five-file delta against the verified baseline.

Public verification: dev.1m8.ai recovered after load-balancer reentry and reports this exact release, development data and enforced outbound isolation. All three changed/new JavaScript modules served through the public hostname match the tested source after newline normalization. Authenticated live order submission was not performed; the order/upload boundary was exercised with isolated browser and real-PHP tests.

## Login redirect follow-up

Release `5807feaa00437acf54ebac8e236c2c601614d635` adds an anonymous-session redirect to `backend_login.php` with a fixed return destination of `/measure/internal/full_house.php`. Signed-in unauthorized users still receive 404. The response is not cached.

The real-PHP ordering test now covers anonymous 302, the return URL, no-store, and signed-in denial alongside existing order creation. It passed on Windows and Linux. The runtime delta changes only full_house.php against `05a11ef27f291a0665e2683c0d66a6e46b5b1835`; staging verified 18,087 other files unchanged on each development role.

All three development roles activated successfully. Public verification returned HTTP 302 with the expected login/return URL and no-store header; readiness reported the exact release with development isolation enforced. Production is unchanged.

## Bulk photo assignment follow-up

Release `4a71a891b2519bdeeb9a1bd5e73fbeeedb8d3464` replaces individual direction upload inputs with a bulk picker and drag-and-drop area. Preview cards assign each photo to a house view or Additional photo. Occupied views swap assignments. A summary shows coverage of the eight views, and a separate video picker remains available.

Browser validation covered ten photos, all eight assignments, occupied-view swaps, assigning an additional photo, invalid-file rejection, disabled controls during upload, mobile overflow, two video chunks, customer provenance and duplicate-free retry. Three address/order tests also passed. Runtime staging changes one JavaScript file against `5807feaa00437acf54ebac8e236c2c601614d635` and verifies 18,087 other files unchanged per development role.

All three development roles activated successfully. Public readiness reports this release and the served bulk-reference script matches the browser-tested source. Production is unchanged.

## Spatial reference board follow-up

Release `81f6dc35b1954aa4fa49b7c6deba753ffc882ce7` uses a wide desktop layout with a 3-by-3 house-view board on the left and photo bank on the right. The house occupies the center, front views sit below it, back views above it, and left/right views sit alongside it. Dragging assigns, swaps occupied slots, or unassigns by returning to the bank. Clicking a photo then a slot supports touch and keyboard selection. Mobile stacks the bank below the board.

Browser checks cover all eight drag assignments, slot swaps, replacing from the bank, click assignment, unassignment, locked controls, mobile overflow, customer upload metadata and duplicate-free retry. Three order/address tests also pass. Runtime delta changes one JavaScript file against `4a71a891b2519bdeeb9a1bd5e73fbeeedb8d3464`.

All three development roles activated successfully after verifying 18,087 unchanged files per role. Public readiness reports this release and the served board script matches the browser-tested source. Production is unchanged.
