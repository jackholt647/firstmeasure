# Generated wall boundary noise — September 23, 2026

Development runtime: `0dbd848b4684350e1735b62ba116df65cbd152cd`.
Previous runtime: `5960ca6257dfadabee2816d68ce7484f130fedce`.

## Correction

The previous exact-collinearity cleanup missed centimetre-scale height variation introduced by clipping walls against measured roof triangles. Near-straight generated perimeter boundaries now join these stations into continuous editable edges. The accumulated deviation of every removed station is bounded to 5 cm, with a maximum local turn of 5 degrees. Real turns, shared wall junctions, manual points, chimney faces and mixed flashing/perimeter groups are preserved. The original roof-contact triangles and input wall geometry are retained; this does not flatten or lift the roof mesh.

New draft outlines use the same cleanup, so selection does not restore the redundant points. Existing authored drafts are not destructively rewritten. The captured house front wall at 18-inch setback has four outline corners and one top edge longer than 7.6 m, before and after beginning face editing.

## Validation and deployment

- 1,023 relevant wall, roof, base and exterior tests pass, plus the subsequently added captured-house draft-selection test (1,024 total).
- New regressions cover slightly non-collinear generated stations, whole-edge picking, manual point persistence, genuine corners, junctions, cumulative curvature and degenerate triangles.
- The broader run also reproduced the two already-documented curved-extrusion/eave-curtain failures; these are unrelated and unchanged. Two initial mixed-face Resoffit regressions were resolved before deployment; all relevant tests pass on the final implementation.
- Only `wall_geometry.js` and `wall_face_draft.js` were packaged from the immutable canonical commit. Concurrent architecture work was excluded.
- All three development services staged and activated successfully. Staging verified 23,478 unchanged web/legacy files and 23,489 unchanged worker files.
- Public readiness reports the exact release, development environment and enforced outbound isolation. Both public JavaScript checksums match the release manifest.
- A separate authenticated browser tab loaded the house and visually confirmed that the long front boundary no longer shows the intermediate points. The original user tab was not reloaded or edited; no project save or From Roof rebuild was performed.

Evidence: `C:/Users/jackh/.codex/worktrees/wall-drawing-boundaries/FirstMeasure/output/wall-boundary-noise/` contains immutable delta, staging/activation receipts and HTTP verification. Test logs are in the sibling `wall-drawing-boundaries/` directory.

Reload the editor to load the new scripts. Production and saved user models were not changed. Rollback is the previous development runtime above, using the same role-specific activation procedure and PHP-FPM refresh.
