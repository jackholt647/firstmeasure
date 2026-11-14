# Production release a4d1051d: rejected reports name their reason; a Full Exterior rejected for footage offers a retry or the roof alone (FM-410), November 14, 2026

Jack approved FM-410 for production on 11/13 ("looks good let's get this pushed to prod"), and again on 11/14 after
freeing the web disks ("Fixed this. You can go ahead and push."). Released from fm-agents-1 by the FM-410 run.

The plan branch `claude/fm-410-fix-prod` (`55672261`) was built on `3c7b173a`. Production had since moved to `908e41cb`
(FM-466, editor modeling batch, record `f4ded85d`), so the plan's six commits were cherry-picked onto `908e41cb`. Each
picked commit's diff is byte-identical to its plan commit, and none of them touches a file FM-466 changed.

| Release commit | Plan commit | Change | Same change as (verified on dev) |
| --- | --- | --- | --- |
| `1e979224` | `09ee8935` | A rejected report names its reason; a Full Exterior rejected for footage offers a retry or the roof alone | canonical `66a5672c` |
| `549ad306` | `d66245f1` | Staff can reject a Full Exterior for insufficient footage | lane `c87ad40e` |
| `65499ad8` | `77a3c36d` | Every reorder of a rejected Full Exterior is a new order, Reorder as Commercial included | `026cb21a` |
| `40bd44e5` | `210961f3` | Rejected report card is the title, the reason and the buttons; explanations are tooltips | `68fce217` |
| `d60664d5` | `9dbb4849` | Test reads possibly-missing tooltips as empty (type check) | `efab8b15` |
| `a4d1051d` | `55672261` | The project's left column no longer offers the old "Build proposal" | `72510fd2` (FM-382 is not on production, so only that entry leaves the row) |

Verified on dev in `platform-20261113054535-341e619b` and `measure-internal-20261112194057-3a8717df`.

## Change

- Node `firstmeasure/api.ts`: new rejection reason `insufficient_footage`, refused for anything but a Full Exterior, with
  its customer copy; `reopenRejectedProjectForReorder` refuses a Full Exterior (`exterior_reorder_requires_new_order`).
- Browser: `measurements/project.js` (rejected card: title, reason, buttons; explanations as tooltips; footage retry and
  roof-only reorders as new orders), `project-request/app.js` (card CSS, phone left-column padding, no "Build proposal"),
  apps manifest `?v=` (`20261113-fm410-rejection-tooltips`, `20261113-fm410-no-build-proposal`), measurements catalog
  `measurements.13e2907dda3dc96a.json` (production's catalog plus the new keys; nothing removed or changed).
- Compatibility: `firstmeasure_node.php` default reasons include Insufficient footage; `portal_scripts/projects.js` and
  `editor_scripts/main.js` offer it only for Full Exterior orders.
- Tests (not served): `public/v1/tests/exterior-rejection.test.ts`, `dev/exterior-rejection-reasons.test.cjs`,
  `public/v1/tests/project-overview-workflow-browser.test.mjs`.
- No database, environment, flag, nginx, dependency or config-library change; no data repair.

## First attempt, November 13 (rolled back, no customer impact)

Release `55672261` (the plan commit on `3c7b173a`) was built and activated on the worker at 06:47 UTC and the channel
published, but every web node's root disk was 100% full (65 unpruned releases, 61 cached downloads), so the web install
failed with ENOSPC before any web node or compatibility switched. The worker and the channel went back to `3c7b173a` at
06:53–06:54. Jack freed the disks, and automatic release pruning shipped in `3c006205`/`31c96bd8`/`5a7289e4`.

## Checks before release

- `current` was `908e41cb` on all 8 hosts at 04:06 UTC; rollback target `908e41cb` recorded on FM-410 before activating.
  Root disks 23–30% used.
- Built `a4d1051d` on the dev worker (`npm run check` and build passed). Archive sha256
  `ba2f1bf61eca911e663b59defcefe1b1ca54e6d1e2126975377503d8144a1106`. Full procedure (Node changes).
- `web_activate.py` keeps the earlier asserts. Pins that FM-466 invalidated (`wall_mode.js`, `project_resources.js`,
  `wall_solid_geometry.js`, `wall_face_draft.js` hashes; `staleAtOpen` 7 -> 8) now name `908e41cb`'s files, and each
  file was checked to equal `908e41cb`'s blob. FM-410 asserts: the sha256 of `project-request/app.js`, the manifest and
  the catalog manifest; `data-rejection-why` x2 and `reorderRejectedExteriorReport` x3 in `measurements/project.js`,
  `.r-rejection-why` x3 and no `proposal` choice in `app.js`, both manifest bumps, the new catalog's hash, served equal to
  local, `insufficient_footage` and `exterior_reorder_requires_new_order` in `dist/firstmeasure/api.js`, and the staff
  reasons. 53 file asserts pass on the archive; on `908e41cb`'s archive they fail (control).

## Rollout (scripts: fm-agents /srv/agents/work/fm-410-prodrun2-scripts)

- Compatibility and worker installed 04:15. Worker activated 04:16:41 UTC (no running jobs).
- Channel published against `908e41cb`'s archive (`3a9cf807…`).
- Web nodes one at a time, 04:17:46–04:30:40 UTC; each passed every assert and came back behind the load balancer.
- Compatibility at 04:30:50 UTC through the gate (343 legacy-action/min, load 0.27): restart, 0 Node 500s and 0 exits in
  the 20 s after.

## Verification

- `current` is `a4d1051d` on all 8 hosts; readiness reports `a4d1051d` 10/10 (5 nodes answering).
- app.1m8.ai serves the manifest with both FM-410 bumps, `measurements/project.js` with `data-rejection-why` x2 and
  `reorderRejectedExteriorReport` x3, `project-request/app.js` with `.r-rejection-why` x3, the catalog manifest naming
  `measurements.13e2907dda3dc96a.json`, and `/measure/internal/portal_scripts/projects.js` with
  `FULL_EXTERIOR_ONLY_REJECTION_REASONS` x2 (3/3 requests each). Compatibility's release has `insufficient_footage` x3
  and `exterior_reorder_requires_new_order` x2 in `dist/firstmeasure/api.js`, `insufficient_footage` x1 in
  `firstmeasure_node.php`, and its Node runs from the release.
- The five browser files served by the first switched node, copied into a worktree of `a4d1051d`, leave `git status`
  clean, and `tests/exterior-rejection.test.ts` passes 8/8 on them; with `908e41cb`'s `project.js` it fails 5/8 (control).
- 5xx from 04:32 to 04:55 UTC (after compatibility settled), excluding health probes: web nodes 0.00–0.04 % (0–3 each,
  mostly the known `/measure/internal/top_view_reroll_proxy.php`) against 0.13–0.20 % in the 30 minutes before;
  compatibility 0.53 % (6, all `top_view_reroll_proxy.php`) against 0.57 % before.
- Compatibility 04:30:50–04:54: 0 watchdog kills, 0 Node 500s, 0 pool timeouts, one MainPID throughout (3 h before: 0
  kills).
- Worker since 04:16:40: 64 jobs completed, 0 failed, one `imagery.process` running normally; no error-level lines,
  no browser-closed or pool-timeout errors.
- Not exercised on production: no Full Exterior has been rejected there yet, so the new card and reorders were checked
  through the served files and the plan test, not with a real rejected order.
