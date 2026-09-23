# DSM ground picking visibility — September 23, 2026

Release: `d5140bc5f217cc16f857fa4bfe480c1d4d57b9dc`.
Baseline: `b81e79c92a37d910423e630d8aab110bfad5e95a`.

The ground picker saves the image visibility before enabling DSM. A successful pick, Escape, clicking DSM again, or leaving restores that visibility. Invalid samples retain picking mode and the image. The button says “Picking DSM…” during the operation and returns to “DSM” on completion; the status confirms the measured height and completion.

Only `ground_editor.js` and `scene_3d.js` are deployed. The visibility getter reads the actual surface setting, including when no mesh is present. Existing grade commits and undo remain unchanged. All 61 wall-mode checks pass, including both initial visibility states, missed picks, completion, cancellation, repeat entry and project exit. JavaScript syntax and diff checks pass.

Staging verified all unchanged public files on web, worker and compatibility roles. All three development roles activated successfully. Public readiness reports the exact release and development isolation; both public JavaScript hashes match the committed delta. Evidence: `output/dsm-visibility-tests.log` and `output/dsm-visibility-20260923/`. Production is unchanged.
