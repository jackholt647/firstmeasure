# Development lower-layer clearance — September 22, 2026

Release: `453277465a814dd3bb1079fdd105ae4ca3cb4abb`
Baseline: `4a773213df4bd219c8a053825a8dbfb1a1bbf8a0`
Branch: `codex/dev-layer-clearance-20260922`

The user found lower chimney roof caps buried by the main walls after selecting 1.5-foot soffits. Local and development fixes and regeneration remained authorized. Production was unchanged.

The two changed runtime assets are `wall_geometry.js` and `base_geometry.js`. Attached lower-layer head flashing now imposes a minimum setback on upper eave sources independently of the selected soffit depth. Finite overlap, lower height and attachment to the same plan boundary are required. Unrelated eaves retain their selected soffit. Lower support footprints are retained even at zero soffit. Measured layer contact vertices within 2 mm are normalized before the footprint offset, preventing tiny union edges from producing setback notches. Support walls inside a lower roof terminate at that roof even when their nearest source is the upper eave. Roof measurements remain unchanged.

All 825 selected geometry/editor tests pass in the primary workspace and isolated release checkout. New clearance assertions cover 0, 6, 12, 18, 24 and 30 inches, rotated 18-inch models, and synthetic nonoverlapping, interior and higher-layer exclusions. Earlier roof-ceiling, nearly coplanar overlap and chimney-shell coverage checks now run at both 18 and 24 inches. Negative controls against the previous dev release fail at 6, 12 and 18 inches and in the synthetic attached-layer case.

All three development roles staged and activated from the stated baseline, preserving 24,128 other public files on web/compatibility and 24,142 on worker. Worker activation required zero running jobs; PHP-FPM was refreshed on both PHP-serving roles. Runtime readiness, development identity and enforced outbound isolation passed. Both public asset checksums match the committed release. No infrastructure settings changed.

The requested saved house was rebuilt with the 1.5-foot preset, inspected in the browser, saved, and reloaded. Its stored state has 94 sources, 112 composed panels, 60 editor faces, and two height-map-inferred exterior chimneys. The affected upper eave sources require 23.570–23.586 inches of clearance from the measured lower roof geometry. Four checks against the actual saved dev model pass: lower roof exposure, roof-bounded wall tops, no overlapping junction panels, and continuous chimney side coverage. Ground gap detection returns zero. The previous unsupported flashing notices remain.

Rollback code to the retained immutable baseline and restart all three dev roles, refreshing PHP-FPM on web/compatibility. Pre-change saved metadata is backed up in ignored local output. Preserve the earlier NGINX temporary-directory ownership correction. Other saved houses require an explicit From Roof rebuild to regenerate geometry.
