# Development chimney shell correction — September 22, 2026

Release: `4a773213df4bd219c8a053825a8dbfb1a1bbf8a0`
Baseline: `c6953cd9c9034697fab031d15cc6544c9ebefa68`
Branch: `codex/dev-chimney-shell-20260922`

The user reported small wall/eave protrusions above roof intersections, nearly coplanar overlapping wall panels, and openings in both chimney sides above the lower roof caps. Local and development fixes and regeneration were authorized. Production was unchanged.

Two browser assets changed: `base_geometry.js` and `wall_chimneys.js`. Rebuilt wall tops now split and clip against finite rendered roof triangles rather than extrapolating fitted planes across hip boundaries. Replaced perimeter fragments are removed even when earlier deduplication raised their bottoms. Nearby parallel generated base edges align to measured flashing contacts within 2 cm, allowing duplicate wall panels to consolidate. The nominal 24-inch setback can consequently shift by approximately 1 cm at these measured junctions.

Generated chimney shells now partition each side by finite building and roof intersections and classify exposure at each region's elevation. The lower roof caps no longer cause the whole shaft above them to be hidden. A 2 mm contact tolerance handles surveyed edge mismatch, and visible regions are unioned before panelization. Legacy edited and explicit-base clipping paths remain available.

All 814 selected wall, base, kernel, chimney, and extrusion tests pass in both the primary workspace and isolated release worktree. Three new regressions fail against the previous dev release and pass with this correction: wall tops bounded by rendered roof triangles, nearly coplanar wall overlap, and rendered chimney coverage above all four sloping lower caps.

Staged from the active baseline on all three dev roles, preserving 24,128 other public files on web/compatibility and 24,142 on worker. All roles activated and passed readiness, development identity, and enforced outbound isolation. Worker activation required zero running jobs. PHP-FPM was refreshed on both PHP-serving roles. Public checksums match both changed assets. No infrastructure settings changed.

Rebuilt the requested saved house through From Roof, inspected the chimney elevation and local oblique side views, saved, and reloaded. The stored model has 93 sources, 112 composed panels, 57 editor faces, and two height-map-inferred exterior chimneys. The three new geometric checks also pass against the actual saved dev state, with zero detected ground gaps. Existing unsupported flashing notices remain.

Rollback code to the retained immutable baseline and restart each dev role, refreshing PHP-FPM on web/compatibility. Pre-change metadata is backed up in ignored local output. Preserve the previous NGINX temporary-directory ownership correction. Other projects require an explicit rebuild to regenerate their saved wall geometry.
