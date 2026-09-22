# Snapped roof-edge extrusion tolerance — September 22, 2026

Development runtime: `da6f7094b847ad14f1ed69969d3bbb46b40be627`.
Previous runtime: `0a8957121da0933d2e98f552c67c62ac834763b2`.
Branch: `codex/dev-chimney-edit-20260922`.

## Cause and correction

Snapping the lower support side to its measured rake rounded a shared corner just outside the roof cutter. A subsequent front extrusion retained an upright return at that corner. The previous regression used a deliberate overhang, which exercised contact continuation but missed the exact snap boundary. The real snap resolver and pre-cut height-fit sequence reproduced a 0.13534 m protrusion on lower roofs 36 and 37.

Add a 2 mm outer-edge halo only where a coplanar source edge already contacts that roof. This makes snapped boundary points and adjoining wall returns fall inside the cutter. It does not change the measured roof, extend unrelated roofs, or fill roof holes. The chimney exposure fix remains intact.

## Validation

- 856 editor and geometry tests pass. Four new snap regressions cover both sides of both exterior chimneys; two fail against the previous release.
- Fresh saved development geometry also passes all four snap-then-front sequences, including shared anchors and replacement faces. Maximum roof-plane deviation is 0.000000741 m.
- Local runtime and tests were synced after comparing the primary workspace against the prior commit. Unrelated local work is preserved.
- Runtime delta contains only `wall_solid_geometry.js`. Staging verified 24,130 unchanged web files, 24,144 worker files, and 24,130 compatibility files against the previous runtime.

- All three development roles activated successfully; readiness and the served JavaScript checksum match the release. Outbound isolation remains enforced.
- The authenticated editor reloaded the saved house with 56 faces and three chimneys. Exact sequential snap geometry was verified through the real snap resolver and extrusion engine against the saved model, rather than a manual browser drag. The separate verification tab was closed without saving.

No database, configuration, project-metadata, or production changes are included.

## Rollback

Restore the previous runtime on all three development roles using the standard activation workflow. Refresh PHP-FPM on web and compatibility hosts and verify readiness and asset checksums. Do not overwrite project metadata.
