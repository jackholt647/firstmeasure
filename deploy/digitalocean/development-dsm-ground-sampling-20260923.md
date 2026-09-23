# Development: pick flat grade from the DSM

## Runtime and scope

All three development roles run `4588f07769e7a995b1042c93bbafd19e66e65538`,
based on the complete `5f1ea338f6ce3707c7374884f79de20f5529bff1` runtime.
Only four browser files changed: `ground_geometry.js`, `ground_editor.js`,
`wall_mode.js` and `scene_3d.js` under `public/measure/internal/editor_scripts/`.
The deployed publication architecture, backend and prior editor geometry work
are preserved. Production is unchanged. No database migration was needed.

## Behavior

Reference grade's DSM button now shows the DSM and enters point selection.
Clicking exposed ground sets a flat grade from the actual raster elevation,
including valid zero and negative heights. Three-dimensional picking raycasts
the DSM surface only; it does not use a fallback display plane. Missing data or
a missed click leaves selection active with an explanation. Escape or clicking
DSM again cancels without changing grade.

The chosen grade updates the base and attached wall bottoms together through
the existing foundation binding, with one undo/redo step. It survives From Roof
and project reload. Sampling consumes the pointer event before geometry
selection and ignores the trailing native click. The roof is not changed.

An existing chosen grade is retained. For initial grade, the automatic dominant
ground-plane fit is used when it has sufficient support; otherwise the grade
is flat. Manual DSM sampling permits use of small exposed ground patches that
cannot support the automatic fit.

## Validation and deployment

- All 1,049 relevant roof, wall, base, exterior and ground tests passed.
- After the final cancellation-scoping adjustment, all 59 wall-mode tests
  passed again. Added coverage includes actual tool handlers, no-data clicks,
  cancellation, foundation updates, undo/redo, From Roof/reload persistence,
  automatic initialization, coordinate conversion and DSM-only 3D picking.
- Staging verified 24,495 unchanged public files on web and compatibility,
  and 24,509 on worker, against the actual previous runtime.
- Web, worker and compatibility activated sequentially with development-data,
  outbound-isolation and role-readiness guards. Worker activation required no
  running jobs; PHP-FPM was refreshed on both PHP-serving hosts.
- All three roles report the exact new release. Public readiness confirms
  development data and enforced outbound isolation; all four served assets
  match committed source hashes. A transient public 503 during load-balancer
  restart health convergence cleared without configuration changes.
- A separate authenticated editor tab confirmed the DSM control enters point
  selection, the actual DSM becomes visible, and Escape removes the picking
  prompt. No grade was committed and no project geometry was saved during this
  live smoke check; successful sampling is covered by the automated fixtures.

Release evidence and guarded helpers are in
`output/dsm-ground-sampling-20260923/`. Test logs are
`output/dsm-sampling-full.log` and `output/dsm-sampling-ui-final.log`.

## Recovery

The previous complete runtime `5f1ea338f6ce3707c7374884f79de20f5529bff1`
remains installed. Roll back development roles using the same role readiness
checks, quiet-worker requirement and PHP-FPM refresh on web/compatibility.
No data rollback is required. Preserve the newer publication architecture;
do not substitute one of the older editor-only runtime baselines.
