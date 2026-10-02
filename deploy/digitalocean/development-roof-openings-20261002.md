# Roof openings in the report viewer — October 2, 2026

Development source release `68427767fcdd194317dc027a1375cb726f5669c9` fixes roof openings in the read-only Measurements viewer. The XML generator writes holes as sibling `WALLPENETRATION` faces referenced by a roof face's `children` attribute. The viewer now resolves those references per structure and triangulates the roof with its inner rings, instead of drawing penetration faces as additional roof surfaces. Hole vertices use the parent face's texture basis. Boundary line colors remain visible.

Verification covers two openings in a pitched face with reversed edge directions, repeated face IDs across structures, ordinary faces without holes, total triangle area excluding openings, and raycasts through each void in both textured and untextured modes. Existing gallery, texture-coordinate and report-aerial browser checks passed. A rendered screenshot confirms the cutouts. JavaScript syntax checks passed.

The two frontend files were deployed as per-role overlays preserving concurrent source changes. Both web nodes and compatibility passed deployed hash, readiness, runtime identity and enforced development isolation checks. Worker, production, data and the FirstMeasure editor were unchanged. No report regeneration is required.

All three roles previously ran `0cdcdedb22d404f4895135738af3ba6c0a44efde`. To roll back, confirm the role still runs this release and restore its installed `channels-release.json` previous_path, restart its development service and reload PHP-FPM; verify readiness and isolation. Do not edit hardlinked release files in place. The historical development autoscale replacement-image limitation remains.

Ignored `output/roof-holes-20261002/` contains the inventories, task source, payloads and rollout scripts. Browser screenshots are in `output/measurements-viewer/`. Verification used saved-format fixtures rather than the user's authenticated report.
