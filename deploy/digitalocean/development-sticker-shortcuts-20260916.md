# Development sticker shortcut correction

Status: activated and verified on all three development roles.

- Runtime: `3bf6dab5e60a1cf12b710e7afe357cad493b1803`.
- Baseline: `c0faba77b5fec96a22760e069155ed914e814402`.
- Branch: `codex/exterior-trim-controls`.
- L starts sticker division and toggles its direction. D again places doors, converts selected stickers to doors, and retains normal size cycling.
- Placement tooltips and active division help reflect L. Roof Parallel Lines and Face Lock already use L in their separate editing context; those bindings are unchanged.
- Public changes are limited to `wall_face_draft.js` and `wall_features.js`. Concurrent shared-workspace work was preserved and excluded.
- Focused tests: 267 passed in the shared checkout, 265 in the isolated release checkout, and 265 on Linux. Coverage includes normal D conversion, L preview/orientation/commit/cancel, dividing existing sections, deleting seams, copy/paste, undo and report grouping.
- Artifact: `/home/dev/exteriors-3bf6dab.tar.gz`, 249945074 bytes; SHA-256 `6bd07e5ad7a0e21b92f96c2e79b07140a6b847d32f99549e27b43445e11de3c5`.
- All three development roles staged with 1335 unchanged public files verified, then activated successfully. Public readiness recovered after the restart and confirms the new development release; both served modules match Git source after newline normalization.
- Experimental access, outbound isolation, dependencies and database configuration are unchanged. Production was not changed.
