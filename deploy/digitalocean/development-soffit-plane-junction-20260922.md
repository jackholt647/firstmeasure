# Tower soffits constrained by finite roof junctions — September 22, 2026

Runtime release: `9aa47ca76f3411dc2f6b5c69e9078177f970310a`.
Baseline: `20b08ab6a68df26ef5521244fd4bcbb2f27ce3a3`.

## Problem and correction

On the entry tower in `fullhouse_ce52c5ebb595e2c7461e102f8478e89c`, the measured side-wall contact and the fallback foundation inset disagreed. A short return could invert a miter, remove the contact source, and cause the fallback outline to apply the default soffit again. The adjoining eaves could also inset beyond the measured lower roof endpoint, leaving isolated flashing wings in front of another wall.

Generation now carries the measured contact through the source and foundation calculations, constrains adjoining setbacks at the finite roof endpoint, and clips grounded flashing returns to their supporting outline. Roof-mounted dormer walls remain independent. Sliver reconciliation uses the lower adjoining roof height so corners cannot rise through a roof pitch.

For this tower, the measured side contact is approximately 0.20119 m from its eave; adjoining setbacks stop at approximately 0.44413 m when the requested depth is greater. Unconstrained front eaves retain the requested depth. The geometry rule uses actual source planes and endpoints, not these coordinates or IDs.

## Verification

- 894 editor and geometry tests pass.
- New junction checks cover 0, 6, 12, 18, 24 and 36 inches plus rotated, translated and reordered roof geometry. Six of seven fail against the previous runtime; all pass with the correction.
- Fresh saved-house geometry rebuilt with the From Roof base reset at 6, 12, 18, 24 and 36 inches: zero open ground junctions and no unsupported tower flashing wings.
- Existing chimney exposure, lower-layer clearance, roof-edge extrusion, Shift selection and adjoining Resoffit tests pass. The formerly rejected lower-tower Resoffit now succeeds on its reconciled junction.

## Delivery

Only `wall_geometry.js`, `base_geometry.js` and `wall_gaps.js` are included in the runtime delta. Their baseline hashes are checked before staging; all other public files are verified unchanged. The five source/test files are synced to the primary local workspace after confirming their previous contents against the task baseline.

All three development roles activated successfully. The public readiness endpoint reports the new release and all three HTTP asset checksums match. The load balancer briefly returned 503 during the restart health-check transition, then recovered; no additional infrastructure changes were needed.

Live editor verification regenerated From Roof successfully (95 sources, 54 faces, 3 chimneys). Top and oblique views showed the entry tower meeting the main roof on continuous side contacts without the previous isolated wing. No browser console errors were reported. Undo restored the pre-verification model (93 sources, 56 faces); no server-side project save was made. Reload the editor and use From Roof to apply the generation correction to an existing model.

Production was not activated or changed. The prior development release is the rollback target.
