# Soffit cleanup and foundation outlines — development

Live development release: `1bb13aee8795eb2ef8ea872541e2ac30eb5a385b`.
Baseline: `c76965cac1ee91e4f22ab5e7f8ba82f98f3194a5`.
Source branch: `codex/soffit-foundation-cleanup`, isolated FirstMeasure Soffit Fix worktree.

## Changes

Four runtime files: `base_geometry.js`, `wall_geometry.js`, `wall_rake_cleanup.js`, and the generation/preset portions of `wall_mode.js`. Unrelated local rendering, performance, trim, report and ordering changes are excluded.

- Preserve the dominant soffit through roof overlaps without moving the exposed remainder of the other run. Retain the previous crossed-rake return cleanup near the chimney.
- Close small source-clipping gaps only with matching source provenance and nearby measured flashing. Reconnect staggered parallel wall ends only when the measured flashing chain and selected setback establish the missing return. Protect edited wall IDs.
- Trace cleaned generated walls before constructing the base. A roof-footprint fallback honors the selected setback instead of reverting to the eaves.
- Reconnect wall ends masked by a chimney even when an overlap adjusted their wall planes differently. The entire inferred connection must lie inside the same chimney, with both wall runs facing the connection.
- New Auto generation uses the fixed 18-inch preset. Existing inferred Auto data remains compatible. No automatic regeneration of saved or edited exterior geometry.

## Validation

- 756 editor tests passed in the isolated release checkout, including its browser tests.
- 158 geometry, foundation, chimney, cleanup and wall-mode tests passed on Linux against the staged runtime.
- 812 editor tests passed in the shared local checkout containing the user's other ongoing changes.
- The saved second-house geometry reproduces the roof-footprint foundation and collapsed return. Regenerated Auto, 12-, 18- and 24-inch variants have a Wall perimeter base and zero open ground-reaching edges after chimney composition.
- Private before/after WebGL renders verified the inset foundation, short return, and chimney joins. Existing roof geometry was not changed; the saved live project was only read.
- Original overlapping-roof fixture, rotated geometry, explicit zero setback, separate wings, protected edits, repeat cleanup and save/reload checks passed.

## Staging and activation

All three development roles staged the same four-file delta after verifying the exact baseline and 18,086 unchanged runtime files per host, including dependencies and compiled code. No Node rebuild is needed for these browser-only changes. Runtime readiness, development data, outbound isolation and the experimental owner allowlist are enforced by the existing deployment helper.

Worker, web and compatibility activated successfully in that order. Worker activation confirmed zero running jobs. Public readiness reports `1bb13aee8795eb2ef8ea872541e2ac30eb5a385b`, healthy development data and enforced outbound isolation. All four JavaScript responses through dev.1m8.ai match the tested commit after line-ending normalization. The experimental owner allowlist is unchanged. Production is unchanged.

The four-file archive, normalized before/after checksums and guarded helper are retained as `/tmp/soffit-delta.tar.gz`, `/tmp/soffit-delta.json`, and `/tmp/deploy-soffit-delta.py` on each development role. The worker also retains `/tmp/soffit-validation-1bb13ae/results.log`.

## Using the fix and rollback

Refresh the editor to load the versioned assets, then use From Roof/the desired soffit preset to regenerate the exterior. Regeneration replaces exterior geometry and is undoable. Saved project geometry is not silently rewritten during deployment.

The baseline release remains installed on all three development roles for rollback. Restore that release consistently, after the worker is idle, restart the corresponding development services and PHP FPM on compatibility, then verify readiness, release identity, development isolation and owner access. Production was not targeted.
