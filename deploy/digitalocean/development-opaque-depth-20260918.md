# Exterior depth ordering — development

Release: `c6963cea9c6bc4165c56b022021933ab7838b9d7`.
Baseline: `f188c0ebd40d32c2112b6a212158bc2886428e28`.
Branch: `codex/opaque-depth-sync`.

## Behavior

Port the missing local wall visibility helpers to development. Coplanar grade renders behind the base through polygon offset, without changing measured elevations. Ordinary wires have a one-CSS-pixel camera-depth bias. Selected white lines interpolate endpoint depth and use a three-CSS-pixel bias; nearer walls still occlude them. Opaque point markers use anchor visibility against opaque depth-writing surfaces, so visible markers draw as complete squares and hidden anchors do not leak around wall silhouettes. Sticker labels also use anchor occlusion. Translucent mode retains its existing visibility policy.

Only `public/measure/internal/editor_scripts/wall_editor.js` changes at runtime. The isolated release ports the rendering helpers and selected-line function, preserving unrelated local work and all previously deployed changes. Rendered/PBR base and grade already have separate polygon offsets. Saved geometry is unchanged; refresh is sufficient.

## Validation

- All 785 exterior regression tests passed in the release checkout.
- Actual WebGL tests cover orthographic and perspective cameras, zoom and oblique views, line visibility on surfaces versus nearer occluders, grade/base in either insertion order, genuinely higher grade, whole visible markers, hidden anchors, and all-hidden recovery. The selected-line screenshot was visually inspected.
- 49 focused tests passed on Linux against the staged release.
- Localhost serves the updated working source; the deployed rendering helpers and selected-line function match that local source.

## Deployment

A guarded one-file delta verifies the current baseline and 18,094 other runtime files unchanged on every role. Existing compiled backend, dependencies and experimental access remain intact. Development worker, web and compatibility roles are activated in that order, with readiness/outbound-isolation checks and rollback on failure. Production is unchanged.

Deployment artifacts: `/tmp/opaque-delta.tar.gz`, `/tmp/opaque-delta.json`, `/tmp/deploy-opaque-delta.py`. Linux results: `/tmp/opaque-validation-c6963ce/results.log` on the worker.

All three roles activated successfully. Public readiness confirms the expected release and development isolation. The public wall_editor.js response matches the tested release byte-for-byte after line-ending normalization.
