# Trim attachment regression review

## Follow-up: straight runs and opaque annotations

The saved upper gable (`line-merge-5`) reproduced a lower vertical strip turning diagonal during a two-foot extrusion. The shared top endpoint followed the moved cross-band, but the bottom endpoint stayed behind. Trim-run maps now propagate lateral displacement along the complete saved run while preserving longitudinal stretching. Updated trim boundaries also bind adjoining wall boundaries in the same transaction.

Opaque annotation sprites now test their surface anchor against visible opaque meshes. Hidden labels have zero opacity; visible labels remain whole overlays without per-glyph depth clipping. Camera and geometry signatures reuse visibility when unchanged. The existing dimension sizing callback is preserved.

Follow-up validation: actual editor extrusion handlers on a saved-project clone, six inward/outward preview reversals, cancellation, commit, undo snapshot and JSON reload; real WebGL screenshots for the upper gable before and after +/-2 ft; synthetic straight-run, adjacent-wall, longitudinal stretch, camera orbit, surface movement and label visibility regressions. No project save was performed. Localhost responses for `wall_solid_geometry.js` and `wall_editor.js` match the workspace bytes.

## Corrections

- Follow saved trim-run identities across incident planes, restricted to the moved section's run interval. Upper sections of the same run remain independent.
- Preserve corner cells when tiny grade adjustments perturb an otherwise rigid move; affine support mapping handles corner cells without a shared edge.
- Keep adjacent planar return boundaries joined; preserve every region when a boundary update partitions an adjacent face.
- Filter inherited trim anchors by actual face ownership during partition, legacy wire rendering, and movement. Publish one destination per moved anchor.
- Never merge extrusion return material into a sticker or resize its dimensions implicitly.

## Validation

793 relevant tests passed. Synthetic regressions cover 90-degree and 9-degree returns, split-height trim ownership, static preference, retained anchor ownership, resize, movement and independent multi-face extrusion.

`trim-repro-local.cjs` runs the real editor handlers against a private clone of a supplied saved model. This run exercised six reversals from 0.15 m to 0.6096 m, checked cancellation, commit, undo snapshot and JSON reload, and verified that all 20 neighboring stickers retained their points and IDs. No user project was saved.

`trim-follow-visual.cjs` renders those snapshots using the real editor draw path and Three.js in headless Chrome. Before, inward and outward screenshots, including two-foot offsets, were visually inspected. Private snapshots and screenshots remain outside the repository in the local temporary directory. The three affected JavaScript responses from localhost:8031 were verified byte-for-byte against the working files.
