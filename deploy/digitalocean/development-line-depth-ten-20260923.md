# Development: ten-pixel line depth allowance

Release: `9d132fad68ba53563d172c24224305c156380d81`.
Baseline: `8a322e205537b165ef2d99f44a8bb898e26d590d`.

At the user's request, the line-only camera-depth allowance increases from four to ten CSS pixels. Point visibility remains at four pixels. Coordinates, depth testing and translucent behavior are unchanged.

All 52 existing focused checks passed, including Chrome WebGL line occlusion and point visibility tests. Log: `output/line-depth-ten-tests.log`. The one-script immutable delta preserves all other baseline files. All three development roles passed activation and exact-release readiness checks; the public script hash matches and public readiness passed on retry after an older release response. Evidence: `output/line-depth-ten-20260923/`. Production is unchanged. The user's extreme-zoom model remains for visual assessment after refresh.
