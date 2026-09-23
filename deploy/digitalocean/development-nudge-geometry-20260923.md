# Development: curve nudges and held-arrow geometry batching

Runtime commit: `a436c5eb94903434dedaff1fc9ab7d7cdb55c54c`.
Baseline: `ebcfb8b3af3f0d96bc02a122c706ba3f6384ea60`.

The prior nudge optimization deferred rendering, backup and history snapshots, but still executed one complete geometry transaction per key repeat. Held arrows now accumulate distance and run one pending transaction on release, idle, direction/step change, picking or another command. Point previews use cached planning geometry and a lightweight animation frame; they do not mutate the model. Consecutive nudges retain their existing undo grouping. This batching applies to idle wall and drawing-plane editing; active placement tools retain their own arrow handling.

Solid point movement previously changed sampled polygons without moving their analytic curve definitions. Movement now deforms incident curve definitions and their samples together. Draft curve endpoints explicitly allow boundary-node movement, and selection is resolved from the placed geometry rather than stale node IDs. Unrelated faces are no longer normalized during a point/line slide.

Validation:
- 509 focused geometry, draft, base-sketch and wall-mode tests passed.
- Final key-release handling: all 64 wall-mode tests passed again.
- Regression tests cover repeated solid curve endpoint movement, fixed draft curve controls, selection retention, nonmutating point previews, 51 held-arrow events producing two transactions, full distance, grouped undo and flushing before picking.
- A 500-face test confirms only the incident face is normalized.
- Saved layered-turret fixture (113 faces), five runs of 20 slide operations: before 22.1–26.5 ms; after 5.6–9.9 ms. This measures the slide operation, not end-to-end browser latency or the user's unsaved model.

Deployment evidence is in `output/nudge-geometry-20260923/`: immutable four-script delta, baseline guards, unchanged runtime-file verification, role readiness and public asset hashes. No production activation or topology changes.

Verified on web, worker and legacy: exact release, development environment and full-house readiness. All four public asset SHA-256 hashes match the immutable commit. The public editor URL redirects to login; this is not an authenticated live-model interaction test.
