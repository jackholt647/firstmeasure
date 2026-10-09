# Development roof-clearance ownership correction — October 9, 2026

Source: `0da3e7a4a23f0b84257345485109eb3cc01ca76e`.

The preceding overlap-clearance release introduced a diagonal inward wall notch at the neighboring hip in the Lake Washington Boulevard fixture. A source fragment could change its supporting roof face during hip clipping. Foundation generation then mistakenly treated that support face as the owner of the clearance inset, applying a half-plane cut to an unrelated main-roof body.

Clearance metadata now retains its original roof body, full boundary and inward normal. Foundation clipping and narrow-body reconstruction use that owner instead of a fragment's later support face. The crossing-roof clearance behavior remains in place.

## Verification

- Retrieved the saved project read-only; its roof still exactly matches the captured fixture.
- Replayed the actual From Roof handler: 64 sources, 44 rendered wall faces, zero open perimeter edges.
- Three new rotated-project regressions assert that the main-house footprint remains present behind its normal setback and that the walkway roof is not pierced by walls. All three fail on the preceding deployed modules and pass with this correction.
- Full relevant suite: 287 passed, zero failures.
- Downloaded and SHA-256 verified the JavaScript served by dev.1m8.ai, replayed the From Roof handler using those modules, and reloaded the top-down preview. The final screenshot is `deployed-top-after.png`.
- Compared the old and corrected generated geometry from the same top-down camera. The old diagonal notch matches the user screenshot; the corrected outline follows the roof edge. Also inspected the corrected corner in 3D.

Local evidence: `output/roof-clearance-owner-20261009/` contains the original/corrected scene data, test logs and top-down before/after screenshots. These renders use production topology from an isolated generation replay, not a saved overwrite of the user's project.

## Rollout

All four development roles are active on the source release above. Runtime identities, both file hashes, readiness and development isolation passed on each host. Public readiness and served JavaScript hashes also passed. Only the two geometry JavaScript modules are included. No production, database, configuration or backend changes. Existing saved walls require an explicit From Roof rebuild to pick up the change; refresh alone preserves saved edits. Rollback paths are recorded per role in the ignored deployment manifest.
