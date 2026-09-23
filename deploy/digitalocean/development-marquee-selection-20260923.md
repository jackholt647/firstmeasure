# Development: rectangle point selection

Release: `33969f09f82127ea94e4bca6f9b5c8d63bb97819`.
Baseline: `9ca524208bd8d86826ffac40405065fdd108b3ba`.

Rectangle release previously materialized drafts through repeated wall queries, rebuilt the picking mesh list per candidate, and requested both full view redraws. Point-only selection now updates persistent marker color/size attributes, with in-place SVG marker updates for the other view. Meshes, lines and marker positions remain unchanged. Plane-mode selection uses the same path. Same-layer selection no longer queues an unsolicited geometry redraw before the selection handler can update highlights.

Picking shares one mesh snapshot within the synchronous rectangle query, then releases it so camera/geometry changes remain fresh. Draft materialization reuses one wall snapshot. Existing additive/subtractive selection, occlusion and selection undo history are retained. Face/line transitions, newly materialized drafts, base selection, pending edits and layer changes safely use the normal redraw path.

All 510 combined tests passed, plus the wall-mode suite repeated after the layer-change fallback check. Tests cover point-only/plane rectangles, subtraction, bounded wall queries, one picking traversal for 200 visibility queries, and Chrome WebGL selection/occlusion. Updating 10,000 marker attributes took about 2 ms in the isolated browser fixture; this is not total rectangle latency in the user's model. Browser tests verify persistent mesh and position-buffer identity. Logs: `output/marquee-final-tests.log`, `output/marquee-mode-tests.log` and `output/marquee-render-tests.log`.

The immutable three-script delta preserves the baseline runtime. Deployment evidence: `output/marquee-selection-20260923/`. Production is unchanged.

All three roles passed activation and local exact-release readiness. All three public editor script hashes match the release. Public readiness eventually returned the expected release with development isolation, but an eight-request concurrent sample returned four `a66efdc` and four current release responses. This is an unresolved mixed backend readiness observation, not a clean public fleet verification. No infrastructure routing was changed. Public editor access requires login; user-model latency remains unmeasured.
