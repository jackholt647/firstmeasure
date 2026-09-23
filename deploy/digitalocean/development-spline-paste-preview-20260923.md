# Development: spline paste preview

Release: `66c0cd14f12afa8b8a673bb97530f8ecc98ba071`.
Baseline: `02ccd8a43ddd5e056618db2a2fa03be3ed98fb45`.

Paste preview drew straight clipboard edges and control points but omitted top-level analytic curves. It now samples the transformed curve definitions for the preview line overlay, using the existing valid/invalid colors and depth policy. The clipboard and persisted spline remain analytic.

Two focused renderer regression tests passed: copying/pasting a spline in plane mode and outside plane mode after flipping it. Both check visible preview lines, disabled depth testing and unchanged model geometry during rendering, then verify analytic controls persist after placement.

This one-script immutable delta preserves the complete baseline, including AI sticker placements. Evidence: `output/spline-paste-preview-20260923/`. Production is unchanged.

All three development roles passed exact-release readiness verification. The public script hash matches the immutable commit and outbound isolation is enforced. A transient public 503 after restart settled on retry. The editor requires login; public verification is not an authenticated live-model interaction test.
