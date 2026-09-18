# Deeper soffit alignment — development

Release: `f188c0ebd40d32c2112b6a212158bc2886428e28`.
Baseline: `b8d15b8a02828f6f114ea6a40b3aac68c9ac53e5` (includes exterior training, height-map chimney inference, and Resources/core photo views).
Branch: `codex/deeper-soffit-alignment`, isolated FirstMeasure Soffit Fix checkout.

## Behavior

When nearby overlapping roof edges describe the same exterior side, select the more inward wall plane, preserving the deeper soffit rather than selecting the longer roof edge. On the saved stepped-eave house, the middle rake retains the full 18-inch inset and aligns with the upper rake across the chimney; previously the longer lower eave reduced that inset to about 9 inches. Exposed portions outside the overlap retain their own selected setback.

Keep the measured flashing-chain evidence in overlap source metadata even when its rendered flashing is hidden. Cleanup can then close the clipped transition between the two inset planes. Recompute wall runs after closing an intermediate source gap. Bound both legs of a diagonal join by the selected soffit; the original roof return also accounts for the offset between the wall planes. Existing source provenance, outward-normal, elevation, continuity and protected-edit guards remain in force.

Two runtime files change: `wall_geometry.js` and `wall_rake_cleanup.js`. Saved exterior geometry is not automatically regenerated. Production and experimental access settings are unchanged.

## Validation

- 831 tests passed in the shared working checkout; the additional rotated-house test and all 11 foundation-fixture tests also passed afterward.
- 774 tests passed in the isolated release checkout before adding that final rotation regression.
- After merging the concurrent Resources release, all 60 wall-mode, core-view and foundation tests passed.
- 178 geometry, foundation, chimney, cleanup and wall-mode tests passed on Linux against the final staged release, including the rotation regression and latest wall-mode test. The separate Resources browser test passed on Windows; the server does not have Chromium installed.
- Auto, 12-, 18- and 24-inch variants preserve the selected minimum soffit and a closed wall/base perimeter. Tests cover protected edits, missing return evidence, repeat cleanup, roof-face ordering, rotation, exposed overlap remainders and chimney DSM inference.
- Private before/after top-view images show the middle wall aligned to the upper rake rather than pulled toward the lower eave. Existing project metadata was not written.
- Localhost responses match the updated source for both files.

## Deployment

The original candidates `a9ac799` and `94d16e1` were not activated: baseline guards detected concurrent Resources and training releases. The tested changes were merged with those releases before restaging.

The guarded delta stages only the two browser files, verifying the exact current baseline and 18,093 other runtime files unchanged per role. The existing compiled backend, training changes, dependencies and configuration are retained. Activation order is worker (idle), web, compatibility, with development isolation and readiness checks and automatic rollback on failure.

All three development roles activated successfully. Public readiness confirms the release, healthy development data and enforced outbound isolation. Both served geometry scripts match the tested commit after line-ending normalization.

Artifacts remain at `/tmp/deeper-soffit-delta.tar.gz`, `/tmp/deeper-soffit-delta.json`, `/tmp/deploy-deeper-soffit-delta.py` on each development role. Linux results are at `/tmp/deeper-soffit-validation-f188c0e/results.log` on the worker. The baseline release remains available for coordinated rollback through the documented release workflow.

Refresh, then use From Roof or a soffit preset to regenerate. This replaces exterior geometry and edits and is undoable.
