# Plane nudging — September 23, 2026

Release: `1762b2a37b5ee7dd5d4edf6245f557c6cc7f0f58`.
Baseline: `31f1f62a5b09b48e36415d7b6601f0936a8484e6`.

Plane-mode key routing previously returned before assigning the nudge undo key. Shared routing now assigns that key before dispatch. Consecutive arrow nudges share an epoch across directions and step modifiers. Non-nudge keys, pointer presses, selection changes and undo/redo delimit edits as before.

Plane movement previously interpreted stored construction-frame U/V as right/up, even if the first boundary edge was vertical or the selected points defined a diagonal frame. Nudges now use the existing upright view-oriented movement frame on the same plane. Geometry stays on the plane; the stored drawing frame is unchanged.

All 450 wall-mode and wall-face-draft tests pass, including grouped undo/redo in ordinary and plane modes, changed directions/step sizes, non-nudge boundaries, all four arrows, first-edge variation, reversed winding and opposite camera sides. Existing single-point, line, copy/paste and geometry checks pass. Evidence: `output/plane-nudge-tests.log`.

Only `wall_mode.js` and `wall_face_draft.js` are deployed through the immutable delta workflow. All three development roles activated successfully. Staging verified every unrelated public file unchanged. Public readiness reports the exact release and development isolation, and both changed JavaScript hashes match the committed delta. Release evidence: `output/plane-nudge-20260923/`. Production is unchanged.
