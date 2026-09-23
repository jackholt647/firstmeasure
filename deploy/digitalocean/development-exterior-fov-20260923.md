# Development camera FOV — September 23, 2026

Release `52e3e76ea4c0af3659e0f98d05dd0ccbc7761278`, baseline `a436c5eb94903434dedaff1fc9ab7d7cdb55c54c`.

The existing ISO side uses a perspective camera. Its new FOV slider appears after Pitch, ranges from 15 to 100 degrees, and leaves camera position and heading unchanged. It hides in TRI/orthographic mode, remembers the last perspective FOV across toggles, and updates its readout after AI camera changes. Smaller angles flatten perspective; larger angles widen the lens. Zoom separately to frame the photo.

Only `public/measure/internal/editor_scripts/scene_3d.js` changed in the runtime. Initial staging against `ebcfb8b` stopped before mutation because a concurrent nudge update had activated. Restaging preserved the full `a436c5e` runtime and verified every other public file unchanged. All three development roles activated and passed readiness/outbound isolation checks. Production is unchanged.

Validation: JavaScript syntax check and eight tests across `scene-fov.test.cjs`, `scene-metric-scale.test.cjs` and `exterior-render-pipeline.test.cjs` passed. Camera tests cover unchanged pose, projection changes, hidden controls, toggle retention, input bounds and external FOV synchronization. Public script SHA-256: `9abaf9a80ee296bb19f02b9187a290ea641bccd086b22993c88395f63d51fa03`. No live visual browser check was performed.

Local deployment manifests: ignored `output/exterior-fov-20260923/`.
