# Line center ticks — September 23, 2026

Release: `44a3693faeba00222662bfc7dd34f011216eeb4b`.
Baseline: `1762b2a37b5ee7dd5d4edf6245f557c6cc7f0f58`.

Line-center circles/squares are replaced with roof-style cyan ticks perpendicular to the line: 12 screen pixels long, 2 pixels wide, 70% opacity. SVG uses the existing inverse scale; the 3D renderer batches midpoint sprites and computes projected edge orientation in the shader, preserving size through zoom and orientation through orbit. Snapping, stored geometry and actual point styling remain unchanged.

All 389 wall-face-draft checks pass, including existing midpoint visibility/snapping and rendering cache checks. The test renderer supports the added direction attribute; two door-preview selectors now exclude midpoint markers instead of relying only on shared opacity. JavaScript syntax and diff checks pass. Evidence: `output/line-center-ticks-tests.log`.

Only `wall_face_draft.js` is deployed. All three development roles activated successfully. All unrelated public files were verified unchanged during staging. Public readiness reports the exact release and development isolation; the public script hash matches the committed delta. Evidence: `output/line-center-ticks-20260923/`. Production is unchanged.
