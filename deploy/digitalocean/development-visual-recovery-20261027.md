# Development visual recovery audit — October 27, 2026

The live manifest retired Photos (`libraries/apps/photos/feed.js`, generation 119) and Operations (`libraries/apps/materials/project.js`, generation 136) as conflicts. A conflict removes an overlay when the underlying file changes; it does not merge its changes. The upload icon/centering and shared mobile search styles were missing from the served Photos file. Operations had reverted only the customer/XML badge placement. Report loading and the restored mobile ordering controls matched their committed versions.

Photos was recovered from the reviewed `fm-feed-mobile-live` source, retaining its mobile feed layout, with real upload icon markup rather than a CSS pseudo-element substitution. Release `205d0c842d8fd95912a61916a009e779db429a08` was activated on development legacy and web, with upload activation, centering and search margins verified at 320/390/430px.

The follow-up release includes the committed Docs covers/mobile grid/pills, restored Operations badge placement, camera action colors and markup Done/text-box interactions. Source deltas are integrated into canonical by three-way merges, with originals retained in ignored audit output. Production and worker are unchanged.

## Separate outstanding conflict

`portal/scripts/topbar.js` was retired as a conflict at generation 94. The earlier source is retained in `C:/Users/jackh/Code/2026/fm-live-visual-test/public/portal/scripts/topbar.js`; another dirty candidate exists in worktree `3d03`. The visual-test delta changes the More-menu placement, grouping, labels, close animation and report-search wording. The currently served source also contains newer message visibility gating, stale-load protection and photo-link navigation. These must be reconciled with the More-menu owner; do not replace the served file with either older candidate. This file was not changed by this recovery.

Other active overlays belong to ongoing work and were inventoried, not cleared or blindly published. The audit snapshots and per-role source hashes are retained under `output/live-recovery-audit`. The former staged document-cover releases `8433910a`, `aa62dce8` are superseded and must not be activated.
