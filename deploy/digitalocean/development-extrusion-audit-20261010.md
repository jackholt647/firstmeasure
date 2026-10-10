# Development extrusion finalization and visibility

October 10, 2026. Source: `b4057929502175324a6ad6c00b704eff2c5f9613`. Architectural findings: [Exterior extrusion audit](../../docs/architecture/exterior-extrusion-audit.md).

Face and line extrusion previews now use the same pure reconciliation and validation entry point as placement. Placement rejection preserves the active preview and reports the error; Enter for grouped extrusion uses the same recovery boundary. Explicit user anchors and their incident boundaries remain editable when their visible face supports them despite chimney clipping. Models without chimneys or old chimney foundation metadata skip chimney reconciliation.

Validation: eight focused suites passed 563 tests. Four subsequent focused tests passed, including the added Enter rejection regression, giving 564 distinct passing tests across these runs. Forty-eight signed face extrusions from existing saved geometry committed successfully; the only preview/commit coordinate difference was about 1.8e-15 metres. Chrome reproduced the old disappearing point and verified the corrected point remained visible within 0.00000059 metres of its preview. The sequence regression repeats placement, cancel, reload and undo snapshots. The audit distinguishes this confirmed fixture failure from the user's last screenshot, whose exact operation was not conclusively identified.

Only `public/measure/internal/editor_scripts/exterior_model.js` and `public/measure/internal/editor_scripts/wall_face_draft.js` were overlaid onto audited role baselines. Production was unchanged. Concurrent work advanced the pool node to `5759f2ee` before activation; the guard rejected the stale baseline. Re-auditing and restaging preserved those changes before applying this two-file overlay.

All four roles verified exact asset hashes, runtime readiness and enforced development isolation. Public HTTPS asset hashes and readiness passed. Evidence: `output/extrusion-audit-20261010/verified-deployment.json`, `http-verification.json`, `regressions-final.txt` and `point-after.png`.

| Role | Previous release path |
| --- | --- |
| web | `/opt/firstmeasure/releases/33649640dc68d96321a88e1064e70b9e7b09a136` |
| worker | `/opt/firstmeasure/releases/f718a0e40225324c1129fee780023080f4793c43` |
| legacy | `/mnt/firstmeasure_dev_releases/releases/33649640dc68d96321a88e1064e70b9e7b09a136` |
| pool | `/opt/firstmeasure/releases/5759f2eecff3fe9bd08c1b17ce05516bd84a489c` |

Rollback: re-audit live roles and reverse only the two owned assets if later changes have landed. Previous release paths are suitable for whole-release rollback only when no subsequent changes need to be preserved.
