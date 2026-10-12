# Development world-axis face extrusion

October 12, 2026. Source `9810ddcb69c5075e2d078f1b0edebc40b8dbc590`, integrated on the canonical remote through `9b0990a0`.

Repeated E during a single-face extrusion cycles from the original face normal to viable world X/Y/Z axes, sorted by absolute alignment with the source normal. Directions parallel to the face plane are excluded at numerical tolerance, and axes duplicating the normal are omitted. Signed distance is preserved; no intermediate preview is committed. The distance display identifies the active direction. Held-key repeat does not cycle.

The immutable extrusion engine receives the selected direction for cap translation, side construction, curved boundary offsets, and horizontal roof clipping. Directional motion snapping and camera-projected dragging use that same vector. Normal-only contained/roof target helpers are bypassed for alternate axes; general geometry motion snapping remains available. Movement of faces and multi-face extrusion retain their existing behavior.

Validation: 645 tests passed across wall geometry, drafting, wall mode, extrusion sweep, roof extrusion and multi-face extrusion. New regressions cover positive/negative numeric distances, ordering, degenerate-axis rejection, repeat suppression, no intermediate commit, cancellation and exact preview/placement agreement. The three new tests also passed in the clean publishing checkout. Browser replay typed a 1 ft distance, cycled through World Z and World X and back, reversed the sign and placed a cap with X/Y offset zero and Z offset exactly +1 ft. Evidence: `output/world-extrusion-20261012/tests-final.txt`, `index.html`, `placed-detail.png`.

Deployment updates only wall_solid_geometry.js, wall_face_draft.js and exterior_model.js. Separate uncommitted plane-stepping work was excluded from the source commit and payload. Each role retains its audited backend and unrelated assets. Previous role paths and hashes are in `output/world-extrusion-20261012/manifest.json`; re-audit before reversing these owned assets after any later release. Production was not activated.

All four roles passed exact owned-asset hash, backend-preservation, readiness and development-isolation verification. Public HTTPS served all three expected assets and ready release `9810ddcb`. Evidence: `output/world-extrusion-20261012/verified-deployment.json` and `http-verification.json`.
