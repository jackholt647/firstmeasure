# Production hotfix 226e87fd: full-house practice reference imagery (FM-319), November 1, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-319 set to Testing in prod, in Done in Dev). Run from fm-agents-1.

It is production-live `75c3eccc` (code `bcf1e43d`, FM-318) plus two commits from `claude/fm-319-missing-reference-images-prod`, unchanged: `a79f2ea5` and `226e87fd`. 8 files, +99/−8. Canonical `aff309c4` is not an ancestor, so the config library gate does not apply.

## Cause and fix

- **Map and 3D imagery missing in full-house practice.** Practice reads its source through a file-name allowlist, kept in both Node and PHP, that dropped `azure.png`, `apple.png`, `structure-N-*` imagery and `instant-structures.json`. The saved Google 3D capture was dropped too. Both lists now allow these files. `readTutorialSourceCapture` gives read-only access to the capture, and `tutorial_sources.php` serves its manifest and tiles.
- **No capture attempts from training.** The editor no longer asks to generate a Google 3D capture in a training project, which a training project cannot do.
- **False error in Resources.** Every practice project showed "Reference notes could not be loaded", because it asked for feedback that training projects are refused. It now uses the manifest it loaded with.
- Still refused: `app_metadata.json`, `pdf_state.json`, reports, `model_data.xml` and markups. Student access checks are unchanged.
- Regression tests, not served: `public/v1/tests/tutorial-exteriors.test.ts`, `dev/tutorial-reference-imagery.test.cjs`.

## Not changed

No migration, configuration, environment or data change. Practice projects read the source live, so existing ones pick this up when reopened.

## Checks before release

- **Dev:** `platform-20261101231631-0a450e5b` and `measure-internal-20261101231757-f6eb5f29`; both still live on dev at release time. Not exercised in a signed-in training session, because the dev test login isn't staff (from the production plan).
- **Build:** on the dev worker (npm ci, check, build, prune), archive sha256 `a2f4e4f4c753e03144bbd26f680f04ce837d05fa513a345ef731dabccaf596b8`, verified, and rechecked on compatibility and the worker after copying.

## Rollout

- Compatibility at 23:33:01–23:33:10 UTC, from `bcf1e43d`. One `HEAD editor.php` 5xx in that window.
- Worker at 23:33:43 UTC, after no running jobs: 8 slots, production, email on, heartbeat off.
- Signed channel published against `86476ae5…` (new archive `a2f4e4f4…`), so new pool nodes get this release.
- Six web nodes from 23:34:44 to 23:47:23 UTC, one at a time. Each was drained from the load balancer and ready in about 94 s, with served assets matching the release, and the next node started only after the load balancer's probes passed again.

Public readiness returned `226e87fd` 40 out of 40 times with all six instances answering, after 10 out of 10 at the end of the rollout. All eight hosts run `226e87fd`.

## After activation (to about 23:52 UTC)

- **Compatibility:** 19 of 2,776 nginx 5xx (0.68%) since 23:33:10, all the existing `top_view_reroll_proxy.php`, against 0.91% (45 of 4,926) in the half hour before. No Node 5xx, no HTTP worker exits.
- **Web nodes:** 0–0.14% 5xx after activation, all `top_view_reroll_proxy.php`, against 0.06–0.15% before; no HTTP worker exits.
- **Worker:** no failed jobs and no error-level log lines; imagery, PDF, delivery and release jobs completing. 128 queued, all `report.release`, none due yet (scheduled; 121 were queued before activation).
- **New code served:** `scene_3d.js` and `project_resources.js` on app.1m8.ai carry the change. PHP-FPM restarted with compatibility's activation.
- **Access:** unauthenticated `tutorial_sources.php` returns 401 and the Node bridge returns 403.
- **`project_resources.php` and `tutorial_sources.php`:** no new 5xx or 403s.

**Not checked:** no trainee opened a practice project after activation (`tutorial_sources.php` and training `project_resources.php` had no real requests). The new allowlist, the 3D manifest and tiles, and the removed notes error have not run on production with real source data. The real confirmation is a trainee opening Full House Drawing practice: map layers and 3D imagery appear, and Resources shows photos with no red notes error.

## Seen during the release

- **`tutorial_project_unsupported` has not dropped.** The plan expected these `editor.php` POSTs to fall. They ran at about 22 a minute before activation and about 19 a minute after, from 6 clients since 23:40. Pages opened before the release keep the old script, so this may change as they reload, but nothing shows these POSTs come from the capture request. The plan says this is not a release failure. Still open.

## Disk

After this release, compatibility is at 92% (11 GB free), `64.23.240.81` at 89% (11 GB free), and the other five web nodes at 87% (14 GB free). Nothing was deleted. Compatibility and the web nodes lose 1–2 percentage points with each release, so old releases need pruning soon.

## Rollback

Every role keeps `bcf1e43d`. Republish it (`86476ae5…`) to the channel before rolling back a web node, then `activate-release.sh bcf1e43d… <service>` on each role. Code only: this release writes nothing the old code can't read.
