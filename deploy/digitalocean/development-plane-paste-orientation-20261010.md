# Development plane clipboard orientation

October 10, 2026. Source: `9831303f801cf56581e4fc0876d9a4e1d9d73393` (with `1c0f5ad6`).

Plane-mode clipboard mounting and placement now derive a frame from world up and the camera-facing side of the drawing plane. They no longer inherit roll or winding from its first polygon edge. All nonhorizontal planes use projected world up; horizontal planes use world X/Y. Drawing-grid axes are unchanged.

Validation: 498 editor and geometry tests passed. Regression cases cover both source and destination winding orders, vertical and sloped destinations including shallow roof slopes, and horizontal source planes. The new tests reproduced both the original roll/reflection and the old helper's near-horizontal axis discontinuity before their respective fixes. A local Chrome replay copied an asymmetric F onto a perpendicular plane with reversed winding and a sloping first edge, then placed it. The placed shape stayed upright and unmirrored, with all vertices on the destination plane. Evidence: `output/plane-paste-20261010/tests-final.txt` and `pasted-detail.png`.

The release overlays only `public/measure/internal/editor_scripts/wall_face_draft.js` onto individually audited development role baselines. Initial baselines were `b4057929502175324a6ad6c00b704eff2c5f9613`. The pool changed to `5759f2eecff3fe9bd08c1b17ce05516bd84a489c` before activation; the guard stopped the stale activation, and a fresh audit/restage preserved that baseline. Other assets and backend code are preserved. The intermediate `1c0f5ad6` release was staged but never activated. Production is unchanged.

All four roles verified the exact asset hash, runtime readiness and enforced development isolation after activation. Public HTTPS also returned the expected asset hash and healthy release `9831303f`. Evidence: `output/plane-paste-20261010/verified-deployment.json` and `http-verification.json`.

Rollback: re-audit live roles and reverse only the owned asset if later changes have landed. Whole-release rollback to the previous role-specific path is suitable only when no subsequent changes need preservation.
