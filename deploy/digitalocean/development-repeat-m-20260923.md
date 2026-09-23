# Repeated Move cancellation — September 23, 2026

Release `794ef7c9f31483048bd63ec77cf2fa1d025caf1e` is verified on all three development roles, based on `b897412d541be2613a23951e0a02b67a191f517f`. Only wall_face_draft.js and base_sketch_editor.js changed. Public script hashes, readiness and development isolation passed. Production is unchanged.

Repeated M no longer passes through generic finish-and-restart handling for single-direction point/face moves or base-point height moves. Single-mount and drawing-plane movement retain the current preview. Existing multi-plane and sticker direction cycling stays within its original transaction. Escape restores the original geometry; click commits one undo entry.

All 407 wall-face-draft and base-sketch checks pass, including repeated M, key repeat, cancellation and a single click commit for interior points, boundary points and base heights. Evidence: output/repeat-m-tests.log and output/repeat-m-20260923/.
