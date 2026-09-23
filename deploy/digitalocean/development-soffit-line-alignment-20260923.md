# Soffit line alignment — September 23, 2026

Development runtime: `90c6a3c9831c4935bc9b0d64a5f67e995e26146a`.
Previous runtime: `0dbd848b4684350e1735b62ba116df65cbd152cd`.

The near-straight wall boundary cleanup left the red Resoffit overlay following original roof-mesh stations. The yellow boundary and red highlight consequently separated at close zoom, despite there being only one wall. Generated contacts now resolve to the same merged boundary used by wall rendering and picking. Contacts mapping to the same boundary are deduplicated.

Resoffit roof-contact tolerance now agrees with the 5 cm generated-edge simplification tolerance. Its candidate check also accepts an interior-supported run whose terminal corner sits just inside a rising hip. This keeps the displayed full edge actionable after conversion into an editable wall, while source-plane, alignment and inset checks remain in force.

## Verification

- All 1,026 relevant wall, roof, base and exterior checks pass.
- Captured-house regressions at both 18 and 24 inches verify one full-length red edge with exactly the yellow outline's endpoints, one rendered highlight, matching picking and a successful one-foot Resoffit.
- Drawing is verified not to mutate or duplicate wall geometry.
- Only `wall_face_draft.js` and `wall_resoffit.js` were deployed as a delta from the previous development runtime. Architecture commit `4a3c46c` is in source ancestry but was explicitly excluded from the runtime package.
- Web, worker and legacy staging/activation succeeded with unchanged baseline files verified. Public readiness identifies the exact development release with outbound isolation enforced; both JavaScript checksums match.
- A separate authenticated browser tab loaded the house with the corrected highlight. The original user tab and saved model were not modified or rebuilt. Reload is sufficient to load the new scripts.

Evidence: `C:/Users/jackh/.codex/worktrees/wall-drawing-boundaries/FirstMeasure/output/soffit-line-alignment/`; test log: sibling `wall-boundary-noise/double-line-tests.log`.

Production is unchanged. Rollback uses the previous development runtime above with the existing role-specific activation procedure and PHP-FPM refresh.
