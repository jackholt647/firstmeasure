# Development: choose the front from eight textured views

Release `f9cc71f335a41cf9bbe4422009fe63e03f27578d` is a four-file runtime delta from `0642b848b03dcfde922c86360839a39ead92b0d4`, preserving the existing line-arch, AI, chimney and publication runtime. Production is unchanged.

## Behavior

AI > Find front from 8 views replaces free-form coordinate estimation. It loads the assigned Front reference, switches the building to textured display with roof/walls/base visible, waits for texture and environment assets, and visibly captures eight numbered views at 45-degree intervals. The camera is six feet (1.8288m) above the current reference grade at each position and always aims at the complete building bounds center.

All eight positions use one shared orbit radius and a 45-degree vertical field of view, with camera zoom reset to one. A bounded search projects the full model bounding box into all eight camera frustums, including terrain-induced pitch and perspective depth, and chooses the smallest common radius with a 10% frame margin. This preserves a consistent distance while framing the entire model; narrower elevations naturally occupy less horizontal space. Reference grade planes extrapolate outside their displayed quad as in the original experiment.

One GPT-6 Luna request at low reasoning receives the front photo plus eight individually labeled images. The model returns only a view number, confidence and explanation. It receives no cardinal labels, camera coordinates or plan diagram. The editor validates the choice, highlights its screenshot and moves to that exact captured position. This selects the closest 45-degree sample; it does not claim an exact photographic pose or perform the old position-refinement loop.

The reference, eight JPEGs, angle/radius/height, exact camera poses and Luna response are retained in browser IndexedDB, with Last saved run, individual downloads and Export run. Prior experiment records remain readable. Stop/project changes retain completed captures and prevent a stale response from moving the camera. Missing textures abort before an AI request; a viewport resize aborts to preserve identical framing. Display changes do not edit building geometry.

## Access and deployment

The existing owner-only development endpoint and private server key remain in place. The endpoint requires the versioned orbit mode and exactly nine images, labels them explicitly, and validates a strict 1-8 response. Old editor tabs receive a refresh instruction. No key is exposed or committed. No database migration or production activation is involved.

Evidence and guarded rollout helpers are in ignored `output/exterior-ai-orbit-20260923/`. The prior complete `0642b848b03dcfde922c86360839a39ead92b0d4` runtime remains available for rollback; refresh PHP-FPM on PHP-serving roles and use the same development-data/readiness checks.

## Validation

- 62 camera, profiler and wall-mode checks passed. Independent Three.js projection verifies all eight bounding-box corners at every pose across wide/tall buildings, slopes and portrait/wide viewports. The pipeline test covers one nine-image request, correct selected pose, saved captures, texture failure and stale-project responses.
- PHP lint and JavaScript syntax checks passed.
- 23 additional rendered-mode, material and skylight checks passed, including real PBR assets and image export (85 total checks).
- Staging verified 24,497 unchanged public files on web/compatibility and 24,511 on worker. All three roles activated and verified with development-data, outbound-isolation and readiness guards; PHP-FPM was refreshed on both PHP-serving roles.
- Public assets match committed source hashes and public readiness reports this exact release with development data.
- Live authenticated browser run completed on the saved house: eight textured captures at a shared 41.94m radius, then one Luna request selected View 2 at 43% confidence and returned the camera to that view. Visual comparison suggests the correct front elevation (two prominent dormers, central turret and right chimney), but does not establish an exact photographic pose. The full reference/capture/response history is retained in the browser. Initial page model loading temporarily blocked browser interaction; the run completed after loading settled.
