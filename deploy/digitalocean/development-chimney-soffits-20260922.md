# Development chimney soffit correction — September 22, 2026

Release: `c6953cd9c9034697fab031d15cc6544c9ebefa68`
Baseline: `11b13e0e444c7af901381bcf4e6e67e8017f80d8`
Branch: `codex/dev-chimney-soffits-20260922`

The user reported a remaining gap beside one chimney and buried lower roof panels beside the other after the layered-roof release. Local and development changes and regeneration were authorized. Production was unchanged.

Two browser assets changed: `base_geometry.js` and `wall_geometry.js`. The flattened roof union had chosen the smallest setback among overlapping collinear edges, allowing a lower cap's 5.6-inch soffit to replace the entire upper eave's 24-inch soffit. The main footprint now preserves the deeper setback while narrow layers retain their own reduced footprints. A duplicate rake connection on a chimney contact also incorrectly inset the attached side. Contact classification now uses finite 3D chimney edges and excludes those duplicate free edges from both sources and small-layer offsets.

All 811 selected wall, base, kernel, chimney, and extrusion tests pass in the primary workspace and isolated release worktree. New physical-contact and setback assertions fail against the previous release, including rotated/translated instances of the house. The tests cover 12-, 18-, and 24-inch setbacks, reversed/duplicated contact vertices, and unrelated edges at different elevations. They supplement the previous ground-gap tests, which did not detect these defects.

Staged from the active baseline on all three dev roles. Verified 24,128 unchanged public files on web/compatibility and 24,142 on worker. All roles activated and passed readiness, development identity and enforced outbound isolation. Worker activation required zero running jobs; PHP-FPM was refreshed on both PHP-serving roles. Public checksums match both changed assets. No infrastructure settings changed.

Rebuilt the requested saved full-house editor using From Roof, inspected both chimney elevations, saved and reloaded. The saved state has 93 sources, 88 composed panels (64 editor faces), Auto/24-inch soffits, and two height-map-inferred exterior chimneys. A read-only saved-state check measures the main setback at 24.0000 inches, verifies all four lower supports meet masonry, and finds zero ground gaps and no upper turret/interior-detail shafts. The six pre-existing unsupported flashing notices remain; no browser errors were recorded during verification.

Rollback code to the retained immutable baseline and restart each dev role, refreshing PHP-FPM on web/compatibility. The rebuild is undoable; pre-change metadata is backed up in ignored local output. Regeneration is explicit, so other saved projects are not silently changed. Preserve the earlier NGINX temporary-directory ownership correction.
