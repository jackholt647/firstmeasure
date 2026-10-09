# Development roof-overlap clearance — October 9, 2026

Source: `32d70ea6632664618a631095ae3e6fc65ec8dd87` on `codex/consolidated-firstmeasure-20260923`.

## Change

Skylight, parapet and shallow-roof edges still default to zero soffit. When a lower roof crosses their prospective wall run and has a usable parallel rear boundary, generation now sets the entire run back to that boundary. Adjacent returns stop at the same plane. Clearance is calculated before skylight segmentation; a short exposed end no longer becomes a separate pillar. At a corner the shallower clearance takes priority when it already resolves the overlap, avoiding an unnecessary second inset across the lower roof's width.

The fallback foundation uses the same inset body. Lower support walls stop at the intercepted roof instead of continuing through its top surface. Roof vertices, saved project geometry and grade-edit behavior are not changed by this release.

## Verification

- 284 tests passed across generation, base geometry, roof contact, zero soffit, overlap, regrade, wall editing and Wallless suites.
- Fourteen dedicated new checks include skylights and parapets, 0.4 m and 1.4 m overlaps, rotation, roof/connection ordering, roof holes and unrelated/upper/interior layers.
- Running those tests against the previous deployed source produced nine failures, including the captured project's wall intersecting roof 2. All fourteen pass with the fix.
- Replayed the actual From Roof UI handler with the saved Lake Washington Boulevard project: 64 sources, 43 rendered wall faces, zero open perimeter edges.
- Checked every generated wall segment against the crossing walkway roof: none spans through its elevation inside its finite footprint.
- Visually inspected a separate WebGL preview of production topology at both corners with roofs shown and hidden. Compared the original 47-face result with the corrected 43-face result. The protruding green triangle and its narrow wall extension are removed.
- Downloaded the two JavaScript modules served by dev.1m8.ai, verified their SHA-256 against the immutable release, and reran the From Roof handler with those modules. Reloaded the preview and captured the final result.

Evidence lives in ignored `output/roof-overlap-clearance-20261009/`: `final-tests.txt`, `baseline-tests.txt`, `ui-state.json`, `ui-scene.json`, `before.png`, and `deployed-after.png`. This is an isolated generation replay, not an overwrite of the user's open editor or saved project.

## Development rollout

All four roles (compatibility/editor, web, pool and worker) now run the source release above. Runtime identities, both file hashes, development isolation and readiness were verified on each host. Public dev.1m8.ai readiness and served asset hashes also passed. Only `wall_geometry.js` and `base_geometry.js` are deployed, over each role's freshly audited immutable baseline. No production activation, data writes, schema, backend or environment changes.

Existing saved walls are not regenerated on refresh. To exercise this generation change, refresh the development editor and run From Roof; that existing action replaces generated walls and edits. Rollback uses each role's previous release recorded in the deployment manifest.
