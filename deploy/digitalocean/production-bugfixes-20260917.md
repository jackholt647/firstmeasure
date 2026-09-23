# Scoped production bug fixes — September 17, 2026

## Scope and immutable artifact

User authorized production activation of the fixes completed in development, specifically these fixes only. Release includes 1M8-193 (credit ledger export), 1M8-189 (historical address search), and 1M8-190 (manager approval history). It excludes 1M8-192 and unrelated editor/exterior development changes.

- Previous production runtime: `6eed8c8a0b0f2d02673176a0dda205d2bfc6a685`.
- New runtime: `3d424a69a869c2ba0b2b8897481af1b0e63c4b68`.
- Branch: `codex/prod-193-189-190`, isolated from the dirty canonical checkout.
- Cherry-picks: `3cd3958`, `65ca4c0`, `3d424a6`.
- Archive SHA-256: `f89677da96c3cb57256e4f2b3f28e3d13a1111661b1fc13d718a7ec6b7c857ae` (249,772,878 bytes).
- Controller artifacts: `/root/bugfix-prod193.tar.gz` and `/root/bugfix-prod193.tar.json`.
- Retained rollback artifacts: `/root/exteriors-6eed8c8.tar.gz` and `.tar.json`; baseline archive SHA-256 `6b23d56fbfb6f6e6e4803c656eee0dfcce579ad1b501bd95959e846de6149b28`.

The Linux-built artifact overlays only nine reviewed source/test files and corresponding compiled outputs onto the retained production archive. 18,129 unchanged baseline files were hash-verified, preserving production dependencies. No migration, configuration, capacity, permission, or feature-flag change is included.

## Preflight and deployment safeguards

- Linux TypeScript check/build and ten focused regression tests passed. Previous development verification included PostgreSQL locked-row export tests and a browser TSV with all 60,344 development ledger entries, no duplicates.
- All eight live roles matched the retained source/compiled baseline (1,668 nondependency files).
- Actual service environments were privately fingerprinted before deployment. Post-activation audit requires unchanged fingerprints except volatile process/release fields.
- Preserved production data environment, disabled automatic migrations/full-house feature, mail credential presence, heartbeat ownership, database pool sizes, eight web children, existing 40-second drain, readiness settings, and worker/PDF settings.
- Published the signed replacement-node channel before activation, then independently downloaded and staged the exact signed archive on all eight hosts.
- Web servers roll one at a time. Each must pass readiness, environment audit, at least three successful load-balancer readiness probes, at least one successful routed request, and zero routed 5xx in the reentry check before proceeding.
- Worker activation requires zero running jobs at that moment. Legacy activation also restarts PHP-FPM to clear stale symlink/opcache state.

### Operational path caveat

The release-channel Node entrypoint compares its resolved module URL with argv. Invoking its wrapper through `/opt/firstmeasure/current` returned exit zero without publication. The signed-download guard caught the old channel before any activation. Publication was rerun using the fully resolved baseline release path and verified on all eight nodes. Always invoke release-channel wrappers through resolved release paths and independently verify the manifest; exit zero alone is insufficient. No guard was bypassed and no unrelated code fix was added.

## Completion verification

- All six web hosts, worker, and legacy/controller activated the exact runtime and passed a final identity/environment audit. Each web reentry check recorded three successful readiness probes, successful routed traffic, and zero routed 5xx. Provider UI refreshed to Healthy, all six members Active.
- Worker safety check initially held activation for a running job. After it completed, the guarded retry succeeded. An intermediate SSH jump-host timeout made no change; connection retry succeeded.
- Production API: all three 189 addresses returned one match each. Browser search as Jack showed the Jefferson report dated April 29, 2026.
- Production export: two bounded API pages returned 500 distinct rows each. Full browser download completed with 81,003 rows and 81,003 unique organization/ledger keys. This is current production data, not the earlier 60,344-row development snapshot.
- Production project `58e9861e101e334fbda964970de4b98f` visibly showed "Manager approved" / Aaron Alt, separately from the prior QA reviewer, confirming 190 in the live modal.
- Public customers.js and projects.js matched scoped release source after normalizing local Windows line endings.
- Database spot check after legacy activation: 73 connections of 100, zero running background jobs at that instant. No data, permissions, pricing, or order state was changed for verification.
- Linear handoff: 193, 189, and 190 are Testing in Prod for final team acceptance; 192 remains excluded.

## Rollback

Retain both immutable releases and artifacts. A web rollback must first republish the retained baseline artifact to the signed channel with compare-and-swap against the current new archive SHA, then use the checked-in guarded activation workflow one node at a time. Do not only switch symlinks: replacement nodes must remain consistent. Preserve production configuration and inspect job activity before worker restart.
