# Development drawing-plane snapping

October 11, 2026. Source `71b13d1f`, integrated on the canonical branch through `8bcba61b`.

Locked N lengths previously returned before snapping. They now snap the bearing while keeping the exact radius from the nearest selected anchor. Candidates include the plane's 45-degree grid, directions parallel/perpendicular/45 degrees to straight scene edges, and bearings toward scene points. Screen-space tolerance is measured at the raw cursor distance, with a 10-degree angular limit, so a short preset radius does not snap every direction. F retains free aiming. Preview and placement use the same constrained endpoint.

Q's derived-corner solver could snap a moving corner onto the starting row or column and collapse a valid rectangle to a line. Candidate and fallback snaps now require four finite corners, nonzero area and distinct adjacent vertices at kernel contact tolerance. If snapping would collapse the shape, the raw valid rectangle remains visible without the misleading guides. This shared fix covers ordinary wall drafting and drawing-plane mode, including the rotated-diagonal construction.

Validation: 593 tests passed across wall geometry, wall drafting and wall-mode suites. Added regressions cover collapsed row/column snaps, exact locked radius at axial/diagonal/rotated-edge bearings, free movement, visible Q height and committed geometry. Browser replay reproduced the collapsed preview using the old cached script, then explicitly loaded the new assets and verified a four-sided 0.12 m-high preview and one successful double-click placement. A typed 1 ft line aimed off axis snapped horizontally and committed at exactly 1.000000 ft with zero endpoint height. Evidence: `output/plane-snap-20261011/tests-final.txt`, `quad-preview-detail.png` and `length-committed.png`. This is a synthetic replay of the failure mechanism, not the user's exact unsaved model.

The development overlay updates only wall_solid_geometry.js and wall_face_draft.js. The PHP entry point already versions both asset URLs. Each role preserves its audited backend and unrelated assets; production is unchanged. Previous role paths are recorded in `output/plane-snap-20261011/manifest.json`. Re-audit and reverse only these owned scripts for rollback after intervening releases.

All four development roles passed exact script-hash, runtime readiness and development-isolation checks. HTTPS served both expected scripts and healthy release `71b13d1f`. Evidence: `output/plane-snap-20261011/verified-deployment.json` and `http-verification.json`.
