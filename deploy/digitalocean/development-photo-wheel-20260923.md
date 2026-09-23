# Photo reference wheel zoom — September 23, 2026

Release: `ad5c325fc4406ed4db71c56f2e7ef3037cb1a073`.
Baseline: `55e5497f9305219e6fd7e1c35b82f2e5f7457f90`.

Wheel input over the photo reference zooms the image about the cursor; input over its control panel zooms about the image center. Rotated photo bounds are tested through the model canvas because the reference layer is pointer-transparent. Wheel events are captured before model controls, normalized for pixel/line/page deltas, and clamped to the existing 10–500% range. Other controls and canvas space outside the image retain their wheel behavior. The existing debounced alignment persistence saves zoom and offset.

Both headless browser checks pass: cursor anchoring, panel-centered zoom, model-event isolation, outside-photo pass-through, existing dragging/sliders and per-image alignment restoration. Evidence: `output/photo-wheel-tests.log`.

Only resource_3d_overlay.js is deployed. All three development roles activated successfully. Unrelated public files were verified unchanged; the public script hash matches and readiness confirms the exact release and development isolation. Evidence: `output/photo-wheel-20260923/`. Production is unchanged.
