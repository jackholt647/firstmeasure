# Hidden flat initial grade — development

Runtime release: `3ca9f780538614c3ab78a6f7bc11118faa0e6fe1`.
Baseline: `7d341c1ececfdbbffa0167285bbfa50e7562d92b` (retains the concurrent exterior training release).

New wall-mode grade starts hidden, with a horizontal plane at the existing ground elevation estimate. From Roof no longer automatically fits the DSM slope. Explicit DSM/USGS/Flat buttons remain available; existing saved grade source, visibility and plane remain intact through rebuild/save/reload. Reground remains the control to fit the base to the chosen reference grade.

The one-file runtime delta is `public/measure/internal/editor_scripts/wall_mode.js`. It preserves saved project geometry and requires only a page refresh for future initialization. Existing projects with a grade are deliberately not reset.

Validation: 53 wall-mode tests pass locally, and all 65 wall-mode/base tests pass in the merged release checkout. Regression coverage verifies hidden/flat initialization, rebuild preservation, explicit sloped selection, and reload preservation. Localhost serves the updated file. Deployment uses baseline/hash guards, unchanged-file verification, development-only safety checks and rollback on failed activation.

All three development roles activated. 18,097 other runtime files were verified unchanged per role. Public readiness and the served wall_mode.js response match the tested release. Production was not modified.
