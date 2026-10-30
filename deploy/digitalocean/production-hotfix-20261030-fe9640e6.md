# Production hotfix fe9640e6: a training source missing one photo view no longer stops a trainee starting it (FM-315), October 30, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-315 set to Testing in prod, verified on dev). Run from fm-agents-1.

It is production-live `3cde46be` (code `70c22b02`, FM-313) plus one commit, `fe9640e6` (branch `claude/fm-315-tutorial-project-on-prod`): 3 files, +32/−9. It is the same change as canonical `26a065e602`, checked line for line. Canonical `aff309c4` is not an ancestor, so the config library gate does not apply.

## Cause

Reported from production: starting the second tutorial project alerted "Exterior source data is missing: right. Update the references or select Roof only."

A practice assignment set to Full exteriors refused to start unless the source had all four views tagged, and a trainee can't act on that message. The plan names the source as 9632 Lake Washington Blvd NE, from the error text and the open item in the `091e5c36` record. Production data was not read to confirm it, and the fix doesn't depend on which source it is.

## Fix

Node only:
- `public/v1/internal/tutorial_exteriors.ts`: the training check also returns `startable`, meaning at least one tagged view, the height map and roof imagery.
- `public/v1/internal/api.ts`: a practice assignment set to Full exteriors starts when `startable` is true. The instance stays `full_house` and ungraded.
- `public/v1/tests/tutorial-exteriors.test.ts`: regression test (not served).

## Checks

- **Dev:** verified in `platform-20261030215038-c9dbbd8d` (readiness and an unsigned bridge call refused). The signed-in start was not checked on dev, because the dev test login isn't staff.
- **Release commit:** `tests/tutorial-exteriors.test.ts` and `tsc --noEmit` pass (from the production plan; the test was not rerun by this run, `npm run check` ran in the build).
- **Build:** on the dev worker (npm ci, check, build, prune), archive sha256 `f99527af9b121f61ed4dadc41e0ece0c8259542355309f0902147872f07b991d`, verified, and rechecked on compatibility and the worker after copying. `startable` is in the built `tutorial_exteriors.js` on compatibility and every web node.

## Not changed

No PHP, editor, migration, configuration, environment or data change.

## Rollout

- Compatibility at 22:05:37Z, from `70c22b02`; activation took 64 s.
- Worker at 22:10:38Z, after no running jobs: 8 slots, production, email on, heartbeat off.
- Signed channel published against `0c741068…` (new archive `f99527af…`), so new pool nodes get this release.
- Six web nodes from 22:11:42 to 22:21:15 UTC, one at a time. Each was drained from the load balancer and ready in about 94 s.

Public readiness returned `fe9640e6` 20 out of 20 times, then 40 out of 40 (all six instances answering) and 10 out of 10.

After activation:
- **Compatibility:** 78 `backend_login.php` 502s and 14 Node 500s, inside the restart. The 500s were all at 22:05:40 from the old release's process shutting down ("Fastify has already been closed"). Technicians signing in during that minute got an error, as in the FM-313 release. From 22:07:00 nginx 5xx is 46 of 6,466 (0.71%), all the existing `top_view_reroll_proxy.php` 500, against 1.58% in the half hour before (a window that includes the restart). No Node 500s from 22:06:45 and no HTTP worker exits.
- **Web nodes:** 0.00–0.07% 5xx after activation, only `top_view_reroll_proxy.php`, each below the same node's 0.66–0.77% before; no HTTP worker exits.
- **Worker:** 119 jobs completed and 2 failed in the first 13 minutes after activation; 16 queued, in line with earlier releases (see below for the failures).

**Not checked:** the signed-in start on production. This run has no production staff session and touched no production data. The real confirmation is Rashid starting the Foundations and Grades practice in Full House Drawing: it should open in Tutorial Mode with an empty Right slot in Resources core views.

## Open, not caused by this release

- **PDF browser failures on the worker.** `Shared PDF runtime failed: page.evaluate: Target page, context or browser has been closed` started before this release: `pdf.sync` failed 2 times in the 20:00 UTC hour and 3 in the 21:00 hour, with none in that form in the 30 hours before. Since activation it has failed one `pdf.sync` and one `report.delivery` (`dd8c062787bd8dda9fd8949a8eabea5c`, created 22:08:30 before the worker activation, last attempt 22:14:13, attempts 5 of 5). That delivery did not go out and nothing retried it. This release changes no PDF code, so a rollback would not help. Cause not investigated.
- **`editor.php` 404s.** Compatibility's log for today has about 44,000 404s on `editor.php?tutorial_id=…&course_id=…&action=…`, already 2,204 in the 20:00 hour and 1,254 in the 21:00 hour, before this release. Cause not investigated.
- **The curriculum editor still says "Roof only — missing right"** on a row set to Full exteriors (`portal_scripts/tutorials.js`).
- **The source still has no `right` photo.** Tagging one is optional instructor work.
- **FM-313's `project_resources.php` 502 on tutorial projects.** If it applies here, the project starts but its Resources tab may fail to load.

## Disk

After this release, compatibility is at 92% (11 GB free), five web nodes at 90% (about 9.8 GB free) and `64.23.240.81` at 93% (7.3 GB free). Each release adds about 1.2 GB. Nothing was deleted; old `/opt/firstmeasure/releases` directories and `/var/tmp/firstmeasure-release-*` archives need a cleanup soon.

## Rollback

Every role keeps `70c22b02`. Republish it (`0c741068…`) to the channel before rolling back a web node. Code only: nothing this release writes needs the new code to read.
