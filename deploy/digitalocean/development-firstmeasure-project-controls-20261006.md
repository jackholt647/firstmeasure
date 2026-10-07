# FirstMeasure language, units and project controls — October 6, 2026

Runtime release: `90fce73f149950417eabda93538d22ca47a9e2a8`.

New FirstMeasure organizations have language and measurement customization on,
including US signups and persisted signup configurations that previously disabled
it. US accounts still start in imperial; regional defaults and existing saved
preferences remain. No existing explicit organization configuration is rewritten.

`platform.project_boards` is a new opt-in feature, off by default. It gates board
loading and selection, board fields and grouping, stages, manual movement and
Manage View in My Projects. Fresh FirstMeasure signup also suppresses stale board,
stages and movement defaults. List and Tiles remain independent of that feature;
flat lists show all visible projects and retain bounded paging without requesting
boards. Old board/stages URLs cannot opt an organization into the feature.

View buttons are explicitly visible/enabled in both views and their container
resists shrinking and can wrap on narrow screens. The originally reported lost
Tiles button was not reproduced in a fresh hosted fixture before the change.
Candidate Chrome checks passed repeated switching, list reload and returning to
Tiles at 1440, 390 and 320px, no board requests while disabled, and metric save
and reload. All fixtures were deleted. TypeScript checking and the focused signup,
rollout audience, board controls and unassigned-project tests passed.

Per-role audited immutable overlays preserve unrelated source, configuration and
runtime assets. Each changed TypeScript source has verified compiled output and
Linux type checking. The worker uses detached-on-write hardlink staging with
free-space/inode guards and a 1GiB reserve; no release cleanup is performed.
Receipts and prior release paths are in `output/firstmeasure-project-controls-20261006/`.
Rollback restores the recorded role-specific prior path and restarts the service
(with PHP-FPM reload for serving roles). Inspect intervening releases first.
Production is excluded.

Activation and final verification passed on web, worker, compatibility and pool.
Each role retained its audited baseline and all owned source/build hashes matched.
Public development readiness and outbound isolation passed. A fresh hosted sandbox
organization, with no language/units flag override, showed both Company information
selectors, started imperial, saved metric and retained it after reload. Boards,
Stages and Manage View were hidden by default; no board data was requested. Repeated
List/Tiles switching passed after project loading and reload at 1440, 390 and 320px.
Explicitly enabling Project Boards and Stages on the expanded fixture restored
Manage View and Stages while retaining List/Tiles switching. The fixture was deleted.
