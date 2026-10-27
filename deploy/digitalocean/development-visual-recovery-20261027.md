# Development visual recovery audit â€” October 27, 2026

The live manifest retired Photos (`libraries/apps/photos/feed.js`, generation 119) and Operations (`libraries/apps/materials/project.js`, generation 136) as conflicts. A conflict removes an overlay when the underlying file changes; it does not merge its changes. The upload icon/centering and shared mobile search styles were missing from the served Photos file. Operations had reverted only the customer/XML badge placement. Report loading and the restored mobile ordering controls matched their committed versions.

Photos was recovered from the reviewed `fm-feed-mobile-live` source, retaining its mobile feed layout, with real upload icon markup rather than a CSS pseudo-element substitution. Release `205d0c842d8fd95912a61916a009e779db429a08` was activated on development legacy and web, with upload activation, centering and search margins verified at 320/390/430px.

The follow-up release includes the committed Docs covers/mobile grid/pills, restored Operations badge placement, camera action colors and markup Done/text-box interactions. Source deltas are integrated into canonical by three-way merges, with originals retained in ignored audit output. Production and worker are unchanged.

## Separate outstanding conflict

`portal/scripts/topbar.js` was retired as a conflict at generation 94. The earlier source is retained in `C:/Users/jackh/Code/2026/fm-live-visual-test/public/portal/scripts/topbar.js`; another dirty candidate exists in worktree `3d03`. The visual-test delta changes the More-menu placement, grouping, labels, close animation and report-search wording. The currently served source also contains newer message visibility gating, stale-load protection and photo-link navigation. These must be reconciled with the More-menu owner; do not replace the served file with either older candidate. This file was not changed by this recovery.

Other active overlays belong to ongoing work and were inventoried, not cleared or blindly published. The audit snapshots and per-role source hashes are retained under `output/live-recovery-audit`. The former staged document-cover releases `8433910a`, `aa62dce8` are superseded and must not be activated.

## Permanent activation and verification

Release `c9d694e1a0c21f297685e2290fdc8f66872407cf` was activated successfully on development legacy and web. Readiness and development isolation checks passed; backend digests remained unchanged. Public gzip-decoded responses for Docs, Operations project, markup, camera capture and Photos feed matched committed source and had no live-overlay header.

All 49 tests passed across `documents-mobile-browser.test.mjs`, `markup-text-box-browser.test.mjs`, `overview-order-layout-browser.test.mjs` and `project-scope-work-browser.test.mjs`. This verifies report entries, mobile layout/search/upload, ordering controls and markup interactions in browser fixtures; the user's authenticated project was not manually exercised.

The served `materials/scope-of-work.js` has concurrent measurements-only tray and shared measurement-start changes. Its diff retains report-asset handling and the existing ordering callback. Those concurrent changes were preserved rather than replaced with this checkout's older version.

The separate More-menu conflict was passed to **Dev visual tweaks** (thread `01a17bbc-a7cc-7600-a7ff-f57299968008`). Its owner reported a clean reconciliation retaining newer message gating, stale-load protection and photo navigation, and was notified after this rollout completed to finish its own verified development deployment. Its deployment remains a separate follow-up.

The served project-request app also includes concurrent project-details-tray work. It retains mobile ordering controls, but intentionally removes the Overview order action in favor of the tray measurement widget. This differs from this chat's earlier request to retain that action; leave the newer owner's changes intact and hand this discrepancy back for reconciliation. Project-map matches this checkout.
