# Production hotfix a8b97899: doors and garage doors can be glass in the Full Exterior editor (FM-310), October 29, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-310 set to Testing in prod, verified on dev). Run from fm-agents-1, right after FM-305's `f4e8cb35`.

It is production-live `e0946c89` (code `f4e8cb35`, which contains FM-302 `784b7bd0`, FM-300 `9af332be` and FM-311 `bbf23641`) plus three commits:
- `ce0e815f` FM-310: doors and garage doors can be glass, off until turned on.
- `34d2c2c3`, `a8b97899` FM-310: the glass door panel test finds the regression server's Chromium, and skips (saying so) on a host with none. Tests only; nothing served.

Branch `claude/fm-310-glass-doors-prodrun`. The plan's branch `claude/fm-310-glass-doors-prod` (`5eb01c4f` on `3e902d1d`) was rebased onto the newer production-live with no conflicts, so this release keeps FM-302, FM-300, FM-311 and FM-305. The diff from `e0946c89` is the plan's 11 files (+125/−16). The 8 changed editor scripts are byte-identical to dev's `measure-internal-20261029202658-76014660`, now including `exterior_pdf.js`: FM-311's Wall Notes hunk, which the plan left out, was already on production.

## Cause

The Full Exterior editor had no way to mark a door or garage door as glass. Doors always got the default door material. Windows are always glass and stay that way with no option.

## Fix

Measure editor only (`public/measure/internal/editor_scripts`, plus tests under `dev/`):
- `wall_features.js`: a **Glass** switch in Face type & size for a selected door or garage door, off by default, saved as `feature.glass` and left out when off.
- `wall_face_draft.js`, `wall_editor.js`, `wall_mode.js`: `glassCommand`, one undo step; every section of a divided door shares it.
- `exterior_finishes.js`, `exterior_rendered.js`: a glass door or garage door is drawn glazed in Textured and Rendered modes (a pane per garage section).
- `exterior_report_model.js`, `exterior_pdf.js`: the opening carries `glass:true`; the schedule says "Door, glass" and the PDF drawings use the window colour.

## Checks

- **Dev:** live and verified in `measure-internal-20261029202658-76014660` (headless Chromium against dev's served scripts: switch for doors and garage doors only, `setGlass` stores `glass:true`, glass doors get their own textured opening map, the report model marks glass doors only, no page errors).
- **Release commit (`a8b97899`), on fm-agents-1:** `node --check` on the 8 editor scripts; `dev/glass-doors` 5 of 5 and the `wall-face-draft` glass case 1 of 1 in Chromium; FM-311's `exterior-notes-blank` 2 of 2 and FM-305's `summary-card-labels` 2 of 2 still pass.

**Build:** on the dev worker (npm ci, check, build), archive `d3941ae1…`, verified; its 8 editor scripts match the commit, and its sha256 was rechecked on compatibility and the worker after copying.

## Not changed

No Node code, migration, configuration, environment or data change. Saved projects are unchanged: `glass` is absent until someone turns it on. The customer viewer model (`public/v1/firstmeasure/exterior_model.ts`, platform) does not carry `glass` yet, so customer viewers show glass doors as regular doors; that is a separate follow-up.

## Rollout

- Compatibility at 22:11:57Z, from `f4e8cb35`.
- Worker at 22:13:40Z, after no running jobs; 8 slots, production, email on, heartbeat off.
- Signed channel, published against `6e606ae2…`, so new pool nodes get this release.
- Six web nodes, 22:14 to 22:24 UTC, one at a time, each drained from the load balancer, ready in about 94 s, with matching assets (`portal/scripts/core.js`, `measure/internal/editor_scripts/wall_features.js` and `exterior_pdf.js`).

Public readiness returned `a8b97899` 20 out of 20 times. The 8 changed editor scripts served from `https://app.1m8.ai/measure/internal/editor_scripts/` are byte-identical to the commit, and `wall_features.js` contains `setGlass`.

After activation:
- **Compatibility:** 5 `/v1/internal/legacy-action` calls returned 500 at 22:12:05 ("Fastify has already been closed and cannot be reopened"), all on the old process (pid 1134745) while it shut down during the restart. There were none before or after (0 of 33,990 in the half hour before). The release's Node code is identical to `f4e8cb35`, so these came from the restart itself; the restarts in earlier releases today logged none. Since then, nginx 5xx is 1 of 281 (0.36%, the existing `top_view_reroll_proxy.php` 500, which returned 552 500s between 20:00 and 22:00), against 0.71% before.
- **Web nodes:** 0 to 1 5xx per ~750–960 requests (0–0.13%), each at or below the same node's 0.14–0.20% in the half hour before; no HTTP worker exits.
- **Worker:** 143 jobs completed and 0 failed in the 13 minutes after activation. The 412 queued jobs are all `report.release`, scheduled ahead.

**Not checked:** the signed-in editor on production. This run has no production staff session and touched no production data, so nobody clicked Glass on a real door. `/measure/internal/` redirects to its login as before.

## Disk

Compatibility is at 86% (17 GB free) and the web nodes at 85–88% (13 GB free), mostly old `/opt/firstmeasure/releases` directories and `/var/tmp/firstmeasure-release-*` archives. Each release adds about 1.2 GB. Nothing was deleted; this needs a cleanup soon.

## Rollback

Every role keeps `f4e8cb35`. Republish it (`6e606ae2…`) to the channel before rolling back a web node. Code only; a door saved as glass after this release renders as a default door on the old code.
