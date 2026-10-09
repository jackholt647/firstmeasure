# Local resoffit junctions and chimney material regions

Development runtime: `e7822f0cad7511b6967de4a59a963dca43fbfe86` (October 9, 2026).
Source changes: `437cd1ff`, followed by repeat-edit correction `e7822f0c`.

## Behavior

A captured Lake Washington Boulevard model generated with 3 ft soffits rejected a local 2 ft edit with "These soffits cannot meet while preserving their connected planes." A short surveyed return and its almost collinear larger neighbor both pinned the selected corner. Local resoffit now permits the short return to pivot at its far end, keeps shared stations on its new plane, follows the pitched base and contacted roof, and retains that return ownership through repeated edits.

Selectable hip-return segments also retain their proven soffit source when the editable merged face is rebuilt. The fallback requires both the selected source and a shared boundary on the same editable face; it does not select unrelated parallel walls.

Generated chimney/wall merges preserve separate material ownership, including legacy mixed merge groups. Region boundaries remain editable, with unchanged strip geometry and conserved material areas. The user's unsaved yellow chimney patch was unavailable for exact replay; the confirmed mixed-ownership merge failure was reproduced separately.

## Validation

- 614 focused geometry/editor tests passed before the repeat-edit refinement.
- 455 resoffit, wallless and editor tests passed on the final refinement.
- Four captured-model regressions cover both selectable segments of R7 and R36: 3 ft to 2 ft, persistence, undo, then repeated 2/3/2 ft edits after reload.
- Inspected captured-model before/after geometry from above and in 3D, including the connected return with the roof hidden. The selected wall measures 0.6096 m from its source edge.
- Evidence: `output/chimney-material-20261009/` and `output/local-resoffit-20261009/`, including `selected-line.png`, test logs, manifests and verification reports.

## Rollout

All four development roles (compatibility, web, pool and worker) were activated and independently verified at the runtime above. Each role used its freshly audited baseline with only the four owned editor JavaScript files overlaid. File hashes, readiness and development isolation passed on every role. The public development URL returned this runtime and matching asset hashes. Production was not changed.

Refresh the editor and apply the local depth to the existing line; global wall regeneration is not required.
