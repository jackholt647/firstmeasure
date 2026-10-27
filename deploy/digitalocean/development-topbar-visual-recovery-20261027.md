# More menu and markup recovery — October 27, 2026

Development web (`fm-dev-web-598520065`) and legacy (`firstmeasure-development-compatibility`) now run release `927488a6b0dc437619eb2557c46f5e446f0f80c5`. Production, the worker, configuration and databases were not changed.

## Changes and source

The More menu lost its live overlay at generation 94. A three-way merge of `fm-live-visual-test` into the served top-bar source restored the compact top-right menu, primary icon color, separate Messages and Notifications cards, Setups/Development labels, rotating dots/Close control and “Order a measurement report” search wording. The served message app gating, stale-load generation protection and photo-message navigation were preserved exactly; the unrelated notification candidate in worktree `3d03` was not imported.

The reviewed recovery commit is `4fd4eb53`; its canonical integration is `28480250`. The authorized markup follow-ups `15ff9e95`, `fc69ab1c` and `dcfa03f4` were integrated as `c0f11d97`, `6d0e25a2` and `927488a6`. The final markup includes shared viewer/editable text behavior, undo, attached translucent formatting controls, SVG bold/italic buttons and the grouped minus/editable-size/plus stepper.

## Rollout and verification

Only `public/portal/scripts/topbar.js` and `public/libraries/markup/firstmate-markup.js`, plus their generated gzip siblings, were overlaid on each role’s audited immutable baseline. Stale Brotli siblings were excluded. Hardlink staging detached every changed file before writing. Activation rechecked the previous release and owned source hashes, verified the development environment/session isolation and enforced outbound safety, and retained rollback on failed readiness. Unrelated frontend files and live overlays were preserved.

`28480250` and `c0f11d97` were staged but not activated. `6d0e25a2` was activated, then a concurrent document-markup rollout advanced both hosts to `0bf560cd`; the final rollout audited and cloned that newer baseline before activating `927488a6`. Backend implementation digests stayed equal to that baseline on both roles.

Validation: seven mobile shell/tray checks, one additional message-gating/stale-response/photo-link check, seven search-offer checks and three markup browser checks passed (18 total). Both roles passed post-activation identity, source-hash and readiness verification. The public ready endpoint returned `927488a6` on `do-598520065`.

Earlier verification observed genuinely old August static responses mixed with current responses; it was not treated as a successful recovery. Origin checks, IPv4/IPv6 and compression checks followed. After final activation, all 16 public requests (two files × IPv4/IPv6 × identity/gzip × unversioned/unique version query) matched the committed, decoded bytes. A subsequent header check confirmed neither file depended on a live overlay; the markup overlay retired normally. The cause of the earlier transient old responses was not conclusively established.

Audit manifests, role source snapshots, archive hashes, scripts and the final 16-request result are retained in `C:/Users/jackh/Code/2026/fm-topbar-visual-recovery/output/topbar-rollout-audit` (ignored). Role receipts are under `/opt/firstmeasure/channels-release-927488a6/`. Rollback target is the audited `0bf560cddf2505ce277081af86644a12d5cbe85a` path recorded per role in that manifest; switch only the affected development role and verify readiness after any authorized rollback.

## Remaining owner follow-up

No direct instruction in this visual-tweaks chat superseded Overview report ordering. However the currently served `project-request/app.js` is owned by the active `C:/Users/jackh/Code/2026/FirstMeasure/.claude/worktrees/project-details-tray-80eca4` overlay. Its Overview `roof` choice deliberately has visibility `false`, while the release baseline retains the earlier `firstMeasureReportOrdersEnabled() && !hasReportOrdered()` predicate. That overlay was not cleared, replaced or edited by this rollout. Restoring the Overview entry alongside the new Measurements tray still needs reconciliation with that active owner; the new tray and report assets were preserved.
