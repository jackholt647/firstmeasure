# Open chimney height inference — development

Release: `8e062a062f871e8d9a56a939800f9e5e45d3c8b3`.
Baseline: `1bb13aee8795eb2ef8ea872541e2ac30eb5a385b`.
Source branch: `codex/chimney-height-extension`, isolated FirstMeasure Soffit Fix checkout.

## Change

Three browser files change: `wall_chimneys.js`, `wall_mode.js`, and `base_geometry.js`. Explicit From Roof generation samples five strips of the DSM to infer the outer edge of an open rectangular chimney. At least three strips must agree on a sustained drop relative to the adjacent pitched roof. Near-edge results snap to the measured roof crossing; clear beyond-edge results remain beyond it. Missing, coarse or inconsistent evidence retains the established mirrored-depth fallback. Closed measured outlines are unchanged.

The result is saved with the chimney and shared with foundation construction. No sampling occurs during dragging, rendering, stage changes or restoring saved geometry. Existing exterior edits are not silently regenerated. Details and thresholds: [Height inference](../../dev/CHIMNEY_HEIGHT_INFERENCE.md).

## Validation

- 826 editor tests passed in the shared working checkout. After limiting inference strictly to generation, the 64 focused height/editor tests passed again.
- 769 editor tests passed in the isolated release checkout.
- 171 geometry, foundation, chimney, cleanup and wall-mode tests passed on Linux against the staged release.
- Five strips in the saved example agreed on a 0.379 m / 14.94-inch outward extension, replacing the 0.650 m / 25.60-inch mirror. All four soffit presets retain a closed wall and foundation outline.
- Private before/after WebGL images checked the resulting chimney and wall joins. Tests cover near-roof snapping, beyond-roof extensions, rotated/pitched outlines, noisy/missing data, closed footprints, source immutability, persistence and sampling only during generation.
- Localhost serves the exact working source for all three files.

## Deployment and rollback

The guarded delta helper verifies development data, outbound isolation, the experimental owner allowlist and the baseline hashes. Each role stages the same three-file delta, with 18,087 other runtime files verified unchanged. Activation follows worker (idle), web, compatibility, with service readiness and automatic rollback on failure. All three development roles activated successfully. Public readiness reports the expected release, healthy development data and enforced outbound isolation. All three served scripts match the tested commit after line-ending normalization. Production is unchanged.

Deployment artifacts: `/tmp/chimney-delta.tar.gz`, `/tmp/chimney-delta.json`, `/tmp/deploy-chimney-delta.py` on each development role. Linux results: `/tmp/chimney-validation-8e062a0/results.log` on the worker. The baseline remains installed for coordinated rollback using the existing release workflow.

Refresh the editor, then use From Roof or the desired soffit preset to apply this to an existing project. Regeneration replaces exterior geometry and edits and can be undone. Saved project data was only read for this work.
