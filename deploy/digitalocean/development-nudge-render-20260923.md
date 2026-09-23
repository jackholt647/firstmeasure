# Nudge rendering and snapshot coalescing — September 23, 2026

Release: `900b2158b332e5e4698fc72c46c7dd44b4386d55`.
Baseline: `95cce15f0a25f4c0396ddecd3a48db750d0e2edc`.

Arrow input updates geometry immediately and requests the existing coalesced frame. While nudges continue, frames refresh 2D geometry and a lightweight 3D selection overlay. Full panel summaries, scene rebuilds, textured-surface updates and browser backup serialization wait for 180 ms without a nudge. Only the latest model is then rebuilt. Undo captures the burst's starting state once and its final state once; idle gaps do not split the existing nudge group.

This avoids scheduling full scene work for intermediate positions; it does not preempt JavaScript already executing or move topology calculations into a worker. Each requested geometry step is retained. Picking flushes the latest mesh before hit testing. Non-nudge keys settle pending changes, history export includes them, and project exit saves the latest state and cancels stale work.

470 wall-mode, wall-face-draft and base-sketch checks passed. After the final undo snapshot optimization, all 63 wall-mode checks passed again. The instrumented regression applies 20 nudges in 20 frames, verifies 20 2D redraws, zero intermediate 3D rebuilds/backups, one final rebuild/backup and two history snapshots total. It also covers undo, picking and project exit. Evidence: `output/nudge-render-full-tests.log`, `output/nudge-render-tests.log`.

Only wall_mode.js, wall_editor.js and wall_face_draft.js are deployed. All three development roles activated successfully. Staging verified every unrelated public file unchanged; public hashes match all three scripts and readiness reports the exact release and development isolation. Release evidence: `output/nudge-render-20260923/`. The baseline includes the repeated-M cancellation fix and concurrent AI experiments. Production is unchanged.
