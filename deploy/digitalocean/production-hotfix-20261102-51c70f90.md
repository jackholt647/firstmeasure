# Production hotfix 51c70f90: walls open past a face with no surface, and the house front reaches the PDF (FM-320), November 2, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-320 set to Testing in prod, in Done in Dev). Run from fm-agents-1.

It is production-live `62f4093f` (code `f9c88a71`, FM-309) plus one commit from `claude/fm-320-fix-prod`, unchanged: `51c70f90`. 4 files, +23/−9. Canonical `aff309c4` is not an ancestor, so the config library gate does not apply.

## Change

- **Walls** (`editor_scripts/wall_mode.js`): a roof face that can't be triangulated is left out, both when reading the roof and when restoring stored walls. It previously stopped the walls with "The face does not define a valid planar region."
- **House front** (`editor_scripts/pdf.js`, `report.js`, `exterior_report.js`): `exteriorSettings` saved through PHP as `[]` now reads as `{}`, so the front bearing and elevation photo slots are kept.

## Not changed

No Node code, migration, configuration, environment or data change. The regression tests stay on `lane/measure-internal`, because production-live has neither suite.

## Checks before release

- **Dev:** `measure-internal-20261102203558-a64f67a7` (lane commit `872cb91b`). The full editor flow and a generated PDF were not run on dev, because the dev test login isn't staff (from the production plan).
- **Build:** on the dev worker (npm ci, check, build, prune), archive sha256 `eb8a98be95df042cd874ba1c8e00be7eb4c100db07ee6e689fe06ab932d84b60`, verified, and rechecked on compatibility and the worker after copying. The 4 scripts in the archive match the commit.

## Rollout

- Compatibility at 20:48:01–20:48:28 UTC, from `f9c88a71`. 13 `POST backend_login.php` and 1 `editor.php` got 502 in the 20:40 window, which contains the restart.
- Worker at 20:48:52 UTC, after no running jobs: 8 slots, production, email on, heartbeat off.
- Signed channel published against `1660c72e…` (new archive `eb8a98be…`), so new pool nodes get this release.
- Six web nodes from 20:49:52 to 21:04:20 UTC, one at a time. Each was drained from the load balancer and ready in about 94 s, with served assets matching the release, and the next node started only after public readiness answered from that node on the new release.

Public readiness returned `51c70f90` 40 out of 40 times with all six instances answering, then 10 out of 10. All eight hosts run `51c70f90`.

## After activation (to about 21:09 UTC)

- **New code served:** `wall_mode.js`, `pdf.js`, `report.js` and `exterior_report.js` on app.1m8.ai have the same sha256 as the commit's files, on repeated requests.
- **Browser check:** Chromium with production's served `exterior_pdf.js`, `exterior_report_model.js`, `exterior_report.js` and `pdf.js`, on a made-up report in a blank page, starting from `exteriorSettings: []`. A front of 110 survives a JSON copy, `ExteriorPDF.frontBearing` reads 110 from the copy, and `serializePdfConfigForSave` keeps it. No page errors. Nothing was written to production.
- **Web nodes:** no HTTP worker exits. 5xx rate 0.06–0.13% after activation on each node, against 0.22–0.31% in the half hour before; mostly the existing `top_view_reroll_proxy.php`. These windows are 2–15 minutes long.
- **Compatibility, nginx:** 106 of 18,847 5xx (0.56%) since 20:48:28, against 0.71% in the half hour before: 105 `top_view_reroll_proxy.php` and 1 `tutorial_sources.php`.
- **Compatibility, Node:** 27 500s in the 21 minutes after activation, against 12 in the 20 minutes before and 42 in the 58 minutes before that. So the count is about double, with no new kind of failure: the same routes in the same mix (`/v1/internal/legacy-action` 12, `/v1/internal/me` 4, `/v1/internal/tutorial-exteriors` 3, user lookups). This release changes no server code. No HTTP worker exits. The cause of these existing 500s was not investigated.
- **Worker:** no failed jobs and no error-level log lines. 305 jobs completed since activation (PDF sync, report release, report delivery, imagery). 321 queued, all `report.release`, none due yet (scheduled; 282 were queued before activation).

**Not checked:** the real editor flow and a generated PDF have not run on dev or production. `wall_mode.js`'s face check did not run in the browser check above; it was tested with the project's saved data before release (from the production plan). The real confirmation is the reporters reopening 4725 W Mercer Way: the walls open, From Roof works, and a front set on the dial appears in the PDF.

## Known limits

- The alert at project load was not reproduced from the server's saved model, so it probably came from a newer wall backup in that person's browser. Only the person reopening the project can confirm it is gone.
- A front set before this fix was never saved, so those projects need the dial set again and the PDF regenerated.
- Subtract Face is unchanged and can still create these faces. They no longer stop the walls.
- Canonical doesn't have this change. It is on `lane/measure-internal` and this production-live, and a release built directly from canonical would drop it.

## Disk

After this release, compatibility is at 94% (7.3 GB free), `64.23.240.81` at 92% (8.1 GB free), and the other five web nodes at 89–90% (11 GB free). Nothing was deleted. Old releases need pruning soon: compatibility has room for only a few more.

## Rollback

Every role keeps `f9c88a71`. Republish it (`1660c72e…`) to the channel before rolling back a web node, then `activate-release.sh f9c88a71… <service>` on each role. Code only: this release writes nothing.
