# Development: upright plane guide and selected lines

Release: `9dc5476ddc1646aab12ffc4c268f1ed3b4cd7ee2`.
Baseline: `be04d368ac308b4ea533dbfd1402078fdf43576e`.

The transient drawing-plane guide formerly used the arbitrary tangent axes of the selected face/point frame. A diagonal starting edge could rotate the entire background grid. The guide now projects world-up onto its supporting plane, with a horizontal-plane fallback. Grid bounds are reprojected into that guide frame; existing drawing coordinates and geometry remain intact.

Plane picking already stored selected edges, but drawing only highlighted their endpoints. The renderer now draws each explicitly selected edge with the standard white selected-line overlay. It is marked as a plane guide so the plane display filter preserves its visibility. Selecting the same two endpoints alone does not imply a line highlight.

All 395 wall-drafting tests passed, including regressions for a gable face with a diagonal source frame, unchanged drawing coordinates, and line-versus-endpoint selection rendering with depth testing disabled.

The one-script immutable delta preserves the full baseline runtime. Evidence: `output/plane-guide-20260923/`. Production is unchanged.

All three development roles passed exact-release readiness verification. The public script SHA-256 matches the immutable commit; development outbound isolation is enforced. The editor URL redirects to login, so public verification is not an authenticated live-model interaction check.
