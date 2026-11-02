# Production hotfix bcf1e43d: training saves and training project files (FM-318), November 1, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-318 set to Testing in prod, in Done in Dev). Run from fm-agents-1.

It is production-live `7b848e33` (code `20fd2f8a`, FM-316) plus two commits from `claude/fm-318-training-file-loading-prod`, unchanged: `bcdd8205` and `bcf1e43d`. 6 files, +111/−2. Canonical `aff309c4` is not an ancestor, so the config library gate does not apply.

## Cause and fix

- **Project files never load in exterior training.** The editor's file requests name no course, so projects in `full-house-drawing` asked Node for the `default` course, Node answered 403 and the editor got 502. `project_resources.php` and `_tutorial_source.php` now use the course the project was found in.
- **A training save failed with "Tutorial project not found".** A save uploads many files at once and each upload rewrote `manifest.json` with a plain write that empties the file first, so a concurrent read saw no project. `writeJsonFile` in `public/v1/internal/api.ts` now writes beside the file and renames over it (`public/v1/internal/tutorial_project_storage.ts`, new on production). This covers every JSON file that function writes. The new file is a hand-made equivalent of canonical's `a12dd9b6`; `writeJsonFileAtomic` has the same logic as canonical's.
- Regression tests, not served: `dev/tutorial-resource-course.test.cjs`, `public/v1/tests/tutorial-project-storage.test.ts`.

**Not fixed:** the reported walls not generating has not been reproduced, and nothing links it to either fix. See FM-318.

## Not changed

No migration, configuration, environment or data change.

## Checks before release

- **Dev:** `measure-internal-20261101221752-9f8a2211` and `platform-20261101221917-c8aca1d4`; both are still live on dev. Neither fix was exercised in a signed-in training session, because the dev test login isn't staff (from the production plan).
- **Build:** on the dev worker (npm ci, check, build, prune), archive sha256 `86476ae52bbdd744a4dc770d00244741c6636df5d4aa1f18a9cca7b51a55bf4a`, verified, and rechecked on compatibility and the worker after copying.

## Rollout

- Compatibility at 22:44:16Z, from `20fd2f8a`. The old service took 52 s to stop and the new one was serving at 22:45:20, so Node was down for about 64 s.
- Worker at 22:45:56Z, after no running jobs: 8 slots, production, email on, heartbeat off.
- Signed channel published against `b63396f3…` (new archive `86476ae5…`), so new pool nodes get this release.
- Six web nodes from 22:46:54 to 22:56:56 UTC, one at a time. Each was drained from the load balancer and ready in about 94 s, with served assets matching the release.

Public readiness returned `bcf1e43d` 40 out of 40 times with all six instances answering, then 10 out of 10 twice. All eight hosts run `bcf1e43d`.

## After activation (to 23:05 UTC)

- **Training files:** `project_resources.php?project=tutorial_…` returned 8 200, 4 206, 1 404 and 1 499, and no 502. It returned 502 on every request earlier on Nov 1 (62 by 22:43). Node's `tutorial-exteriors` 403s went from 62 earlier today to 0. `tutorial_project_bundle`, `tutorial_project_artifact` and `tutorial_sources.php` returned 200.
- **Compatibility:** 18 of 3,532 nginx 5xx (0.51%) from 22:45:20, all the existing `top_view_reroll_proxy.php`, against 0.47% (22 of 4,671) in the half hour before activation. No HTTP worker exits.
- **Web nodes:** 0–0.07% 5xx after activation, each below the same node's 0.41–0.55% before; no HTTP worker exits.
- **Worker:** 46 jobs completed and none failed; 5 queued; no error-level log lines.
- **Temporary files:** no `.*.tmp` left in the training folders.

**Not checked:** no training upload (`POST …/artifacts`) has happened since activation and no training `manifest.json` has changed, so the atomic write and PHP writing a Node-written manifest have not run on production yet. `tutorial_project_status` had no requests either. This run created no production data. The real confirmation is a trainee saving and reopening a project.

## Seen during the release

- **Logins during the restart:** 14 `backend_login.php` POSTs from 5 clients returned 502 from 22:44:34 to 22:45:17, inside the 64 s the compatibility service was down. Logins have succeeded since and none failed before it today. A 52 s stop is longer than the 11 s activation of the previous release.
- **One Node 500:** `POST /v1/internal/legacy-action` at 22:49:47, "timeout exceeded when trying to connect" to the database. This also happened 16 times on Oct 31, so it is not new.

## Open, not caused by this release

- **`tutorial_project_unsupported`:** `editor.php` answered 575 POSTs with this action with 404 after activation and 699 with 404 in the 20 minutes before. It was not changed and not investigated here.

## Disk

After this release, compatibility is at 91% (12 GB free), `64.23.240.81` at 88% (12 GB free), and the other five web nodes at 85% (15 GB free). Nothing was deleted.

## Rollback

Every role keeps `20fd2f8a`. Republish it (`b63396f3…`) to the channel before rolling back a web node. Code only: files written by the new code are ordinary JSON the old code reads.
