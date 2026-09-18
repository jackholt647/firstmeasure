# Development wall and base edge ownership — September 18, 2026

Runtime `313e9de52398a367c3f9b159cae0963131bc22b1`; baseline `0edd665db8157b2f31e73a71015ecd5ad7f5504f`.

Coincident wall/base edges were routed into base selection. Delete then protected the base boundary instead of deleting the wall face. Wall movement also added base faces to its transform scene, so lifting only some base vertices failed planar validation.

Wall-visible edge picking now prefers a live wall owner. After deleting the wall the remaining edge routes to the base editor. Wall-only line and multi-geometry movements do not include base faces; explicit external base selections retain base editing behavior. Base geometry remains available for snapping. No saved geometry is modified automatically.

Validation: 859 regression tests pass, including single wall-bottom deletion, retained base ownership, single-edge lifting, three-edge lifting, unchanged base, cancellation, existing base picking and chamfer behaviors. Runtime delta is only wall_face_draft.js, with guarded per-file hashes, preservation checks, readiness and outbound isolation on all development roles. Production and experimental access are unchanged.

Refresh to load this interaction fix. From Roof is not required.
