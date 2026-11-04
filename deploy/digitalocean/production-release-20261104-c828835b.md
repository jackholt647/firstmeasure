# Production release c828835b: Concrete wall material in Full Exteriors (FM-325), November 4, 2026

Released from fm-agents-1 by the tracker's production run for FM-325 ("Concrete material option", FirstMeasure bug fixes), under the workspace's standing authorization for issues set to "Testing in prod" once verified on dev.

It is production-live `843c58d1` (release `f3789644`) plus the plan's two commits on `claude/fm-325-fix-prod`, unchanged:

- `046da2c3`: cherry-pick of canonical `2985822f`, on dev as `platform-20261104043840-4050cda7`.
- `c828835b`: the editor change, on dev as lane commit `c240461c` in `measure-internal-20261104045050-afb6089e`. Production's `exterior_report_model.js` is older than the lane's (no curved-face work), so only the same `concrete:'Concrete'` label was added to it.

## Change

- **Concrete wall finish** (FM-325). Techs marked concrete walls as stucco because the Full Exteriors editor had no concrete. `wall_features.js` ExteriorMaterials gets Concrete (`#9fa4a6`), which puts it in the face picker, the Default texture menu and the roof-trim material grid; `exterior_report_model.js` labels it Concrete; `exterior_pdf.js` tints it grey in diagrams; `exterior_finishes.js` gives it the stucco-style speckle. Like brick and stucco, it gets no automatic trim.
- Server and viewer: `exterior_design.ts` WALL_MATERIALS keeps `concrete` in saved customer designs (it was dropped), `exterior_model.ts` maps the label Concrete to `concrete`, and `roof-viewer.js` labels, colours, offers and matches it.
- Tests: `dev/exterior-materials.test.cjs`, a case in `measurements-full-house-viewer-browser.test.mjs`.
- No stored value changes, no migration, no config-library change (production-live's snapshot is unchanged), no data repair. Translated reports show "Concrete" in English until the language packs add it.

## Checks before release

- Plan: `dev/exterior-materials`, `exterior-report`, `wall-trim`, `default-finish-controls` pass on the production branch; the viewer browser test 5/5. Dev: Concrete offered, painted and labelled in the editor; dev's `sanitizeExteriorDesign` keeps `concrete`.
- Diff against production-live checked: the plan's 9 files only.
- Build on the dev worker in 274 s (npm ci, type check, build, prune): archive sha256 `d09a221b0977da8f419320d31de436aef00cd3a0eba0607756eda0776bf1ced6`, verified there, on compatibility and on the worker.

## Rollout

- Rollback target recorded on FM-325 before activation: `f378964471a7367e7fddc95dfbb56c5ade694192` (all eight hosts' `current` and public readiness, checked ~04:58 and again ~05:00 UTC).
- Compatibility at 05:03:47 UTC from `f3789644`: active on `c828835b`, no 500s and no worker exits in the first 20 s. Two `backend_login.php` 502s at 05:03:52/54 fall inside the restart (the same blip as FM-323's at 00:38).
- Worker at 05:04:31 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published against `4326a410…` (f3789644's archive) from the release's real path; all six web nodes downloaded `c828835b` / `d09a221b` from it.
- Six web nodes one at a time behind the load balancer, 05:05:33–05:18:44 UTC, each withdrawn, activated (~94 s), asset-checked (`core.js`, color picker, `roof-viewer.js` served = `current`) and back behind the load balancer on the new release before the next.

## After activation

- Public readiness answered `c828835b` (`ok`) on 12 of 12 requests; each of the six web nodes answers `c828835b` locally; all eight hosts point `current` at `c828835b`.
- `https://app.1m8.ai/measure/internal/editor_scripts/wall_features.js` contains `concrete:{label:'Concrete'`, `exterior_report_model.js` `concrete:'Concrete'` twice, and `/libraries/apps/measurements/roof-viewer.js` `['concrete','Concrete']`, 6 of 6 requests. Compatibility's built `exterior_design.js` WALL_MATERIALS includes `concrete`.
- Errors: NGINX 5xx on each web node since its activation 0–0.07 % (30 min before: 0.13–0.28 %), all `top_view_reroll_proxy.php`; compatibility 0.49 % since 05:04:05 vs 0.66 % before, the same proxy route. Worker and compatibility: no error-level log lines since activation.
- Jobs since worker activation: 67 completed (imagery, PDF sync, report delivery and release), none failed, none stuck running; queued `report.release` jobs are scheduled ones, none due (167 were queued before activation).
- Not done: a signed-in editor test on production (no production staff login here, and painting a real project is a production data change). The confirmation is a tech choosing Concrete on a Full Exteriors face.

## Rollback

Every role keeps `f3789644`. Republish its archive (`4326a410…`) to the channel from `/opt/firstmeasure/releases/f3789644…/deploy/digitalocean/`, then `activate-release.sh f3789644… <service>` on each role. Code only: this release writes no data; a face saved as `concrete` would show as Unassigned on the old code.
