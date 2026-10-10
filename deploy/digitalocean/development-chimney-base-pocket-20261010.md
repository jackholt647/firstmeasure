# Chimney foundation pocket at three-foot soffits

Source: `e6563b0af175774e7b923bdbb23c60272411ea78` (October 10, 2026).

## Cause and behavior

The captured Lake Washington Boulevard roof produced a 0.056 m² enclosed pocket, approximately 95 mm wide, between its generated inset perimeter and the projecting chimney. Adding the chimney footprint closed the pocket into a hole. The foundation join rejects unions with holes, leaving a separate chimney base and the visible empty sliver.

During From Roof generation, enclosed pockets against a finite chimney side are now incorporated into the house footprint only when they are at most six inches wide and fully covered by actual roof surfaces. Open gaps, wider courtyards and roof openings are preserved. Normal chimney foundation union then joins the footprint; the pocket's former exposed chimney wall is suppressed by existing visibility handling. Roof geometry, chimney dimensions and materials are unchanged. Redraws and ground rotation do not invoke this repair.

Existing saved models require From Roof generation again to receive this correction; refresh alone does not replace saved edits.

## Validation

- 464 focused roof/base/chimney/soffit tests passed, followed by 80 wall-mode tests after adding the actual UI regression (465 distinct tests overall).
- Captured generation and the actual From Roof 3 ft handler produce two base regions (house and detached wing), with no separate chimney foundation. The actual handler produces zero open wall edges.
- Browser before/after rendering inspected from above with roof hidden and from below. The original black pocket is visible before and absent after; the underside is connected without the generated seam.
- Negative tests preserve wide courtyards, open gaps and explicit roof openings. Repeated foundation sync is stable.
- Local evidence: `output/chimney-base-20261010/` (saved metadata, before/after scenes, screenshots, UI replay and test logs).

## Rollout

All four development roles (compatibility, web, pool and worker) activated and independently verified at the source release above. Runtime identity, owned-file hashes, readiness and development isolation passed on every role. The public development URL returned the same release and matching editor asset hash. Only `public/measure/internal/editor_scripts/base_geometry.js` is overlaid onto each freshly audited role baseline. No configuration, database, or production changes.

Rollback: restore the per-role `previous_path` recorded in `output/chimney-base-20261010/manifest.json`, restart that role, and verify readiness and development isolation. The compatibility baseline now resides on `/mnt/firstmeasure_dev_releases/releases`; staging uses that same filesystem for immutable hardlink copies.

