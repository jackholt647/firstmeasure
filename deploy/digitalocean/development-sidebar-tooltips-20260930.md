# Instant sidebar tooltips — development, September 30, 2026

Source/runtime release: `8a4bb2675abef4cea577a124ccfe4018390527d4`. User-authorized target: https://dev.1m8.ai.

My Settings → Left column → Sidebar behavior now offers Instant tooltips. The collapsed menu stays narrow on hover and displays the item name immediately beside the rail, without hover delay or animation. The edge button still toggles expansion. Keyboard focus also displays instant labels, dynamically rendered app icons inherit the behavior, and expansion or mode changes dismiss visible tooltips. Mobile keeps its existing tooltip behavior.

Six-file overlays preserve each role's active source: portal core, shared Platform UI, company settings, settings bundle token, platform API source and matching compiled output. Only the two behavior enum lists differ in compiled API output. No dependencies, migrations, customer preference changes, worker, production or topology changes.

Validation: local JavaScript syntax, TypeScript check, all twelve capabilities tests, sidebar browser behavior and overflow checks passed. The browser test also passed using prepared deployment scripts and scripts fetched from dev.1m8.ai. The broader sidebar contract suite retains its existing unrelated Doc Studio release assertion failure.

Web, pool and compatibility activated and independently verified. Public readiness returned the exact release eight times with development environment and outbound isolation enforced. All four served frontend asset hashes match their prepared overlays. Role receipts record exact predecessor releases and file hashes.

Staging stopped safely before activation for low web disk headroom. It used immutable hardlink clones, atomically replacing overlaid files and rechecking unchanged active hashes. Compatibility's usual release volume has exhausted inodes; an unsuccessful cross-filesystem clone was removed only after verifying it was this task's inactive target. Compatibility staged beside its existing active release under `/opt/firstmeasure/releases-root-archive`; no prior releases were removed. The release volume's inode exhaustion remains an infrastructure limitation.

Rollback predecessors:
- web: `3507c3b447ed60a1df625a3ae924e88861cf5488`
- legacy: `3507c3b447ed60a1df625a3ae924e88861cf5488`
- pool: `3507c3b447ed60a1df625a3ae924e88861cf5488`

Check for intervening deployments before restoring the relevant predecessor current symlink and restarting its development service and PHP-FPM. Verify release identity, readiness and outbound isolation. Stored tooltip preferences are additive; older code falls back to Adaptive. Evidence and role manifests: ignored `output/sidebar-tooltips-dev-20260930/`.
