# Wall boundaries and unrestricted drawing — September 23, 2026

Runtime: `5960ca6257dfadabee2816d68ce7484f130fedce`.
Previous development runtime: `ac96d0c19eb3256c01ed89ddc8bcd11d7c8bdc9a`.
Implementation: `412d077`, merged into the canonical branch after consolidation handed off rollout ownership.

## Changes

Generated merged walls were displaying collinear endpoints left by internal source subdivisions. Draft initialization also promoted those stations into editable anchors. The generated boundary now joins straight runs, preserves real corners and foreign-wall junctions, and supplies the same geometry to drawing and picking. Draft initialization retains genuine junctions without reintroducing generated straight-run stations. Existing user sketch points and manually merged wall anchors are preserved.

The previous connection fix already lets Q extend a wall. A new UI regression verifies a quadrilateral crossing both the top and side, preserving every existing point and producing wall material outside the former bounds. Remaining outline guards were removed from double-click point placement, analytic curves, rotation and scaling. External curves persist through rebinding/reload. Geometry remains on its active supporting plane, with finite-coordinate and valid-polygon checks.

## Verification

- All 955 selected editor/geometry checks passed after configuring the new worktree's dependency junction.
- After the final picking update, all 365 wall-face-draft tests passed. The explicit seven-segment regression selects one full-length edge, creates only four generated sketch corners, and preserves a manually added fifth point through reload.
- Additional tests cover exterior Q placement, exterior points/arcs, persisted base arcs, and perpendicular-wall junctions.
- The canonical merge has identical editor source and test bytes to the tested implementation.
- Four runtime files were staged against verified baseline hashes, preserving 23,476 web/legacy and 23,487 worker files. All three development roles activated with local readiness and outbound isolation verified.

Public HTTP verification passed: all four served editor assets match their expected SHA-256 checksums, readiness identifies the exact runtime with development isolation enforced, and the editor endpoint returns its normal login redirect. The transient 503 following activation recovered without further changes.

Evidence and deployment helpers: `C:/Users/jackh/.codex/worktrees/wall-drawing-boundaries/FirstMeasure/output/wall-drawing-boundaries/` (delta manifest, stage/activation receipts, test logs and HTTP verifier).

Production and saved user models were not changed. Physical canonical directory remains `FirstMeasure`; the deferred rename script's pinned HEAD must be refreshed after reviewing the final checkout before it is used.
