# Development: six-pixel line and point allowance

Release: `9ca524208bd8d86826ffac40405065fdd108b3ba`.
Baseline: `9d132fad68ba53563d172c24224305c156380d81`.

At the user's request both line depth bias and point-anchor visibility allowance are six CSS pixels. Point markers retain render order 1000 and disabled depth testing after anchor visibility filtering, above ordinary/selected wire and soffit lines. Model geometry is unchanged.

All 52 focused checks passed, including Chrome WebGL rendering and point occlusion tests. Log: `output/overlay-depth-six-tests.log`. The one-script immutable delta preserves other baseline files. All three development roles passed activation and exact-release readiness checks. Public script checksum and development readiness/isolation passed; an initial readiness response reported an older release and passed on retry. Evidence: `output/overlay-depth-six-20260923/`. Production is unchanged.
