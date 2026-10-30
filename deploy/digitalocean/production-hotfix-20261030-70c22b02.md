# Production hotfix 70c22b02: the PDF step opens even when project files can't be read (FM-313), October 30, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-313 set to Testing in prod, verified on dev). Run from fm-agents-1.

It is production-live `2dc543cd` (code `e2a69846`, FM-312) plus one commit, `70c22b02` (branch `claude/fm-313-pdf-preview-failures-prod`): 3 files, +98/−21. The 2 changed editor scripts are byte-identical to dev's `measure-internal-20261030182432-f5c8d997` (lane commit `f5c8d997`). `dev/resource-submission-sources.test.cjs` stays on the lane only; production-live doesn't have that suite.

## Cause

Reported from production: the Full Exterior Report Configuration wizard showed "Error rendering preview." on the PDF step, and no PDF could be generated.

Before the PDF build starts, the PDF step copies the project's Resources into Sources & Notes (`ProjectResources.mergeSubmission`), and nothing caught a failure there. Any failed read killed the whole step.

## What the production log shows

On compatibility's nginx log for October 30, `project_resources.php` returned 502 92 times up to the report and 0 times with success on that project. All 92 came from one tutorial project opened with `editor.php?tutorial=1`, including 8 between 15:05:38 and 15:07:43 UTC, the minutes around the report at about 15:07.

Each 502 has a 48-byte body. That length fits `Training references are unavailable.`, the message `project_resources.php` sends when `fm_tutorial_fetch_source_bundle` returns nothing. This is inferred from the length and the code path: the log holds neither the response text nor the user, so it does not prove this is the session that was reported.

**Still open, not in this release:** that 502 itself. This release lets the PDF step carry on past it, but the tutorial project's files still can't be read, so they won't reach Sources & Notes and its Resources tab keeps failing.

## Fix

Full Exterior editor only (`public/measure/internal/editor_scripts`, plus a test under `dev/`):
- `report.js`: the merge goes through `mergeProjectResourcesIntoSources`, which can't throw, in the PDF step and at submission. If it fails, the PDF step shows a red notice with the reason and carries on to the PDF. Empty saved entries in Sources & Notes are dropped. The generic error names its reason.
- `project_resources.js`: the merge moved into `mergeSubmissionSources`; an unreadable markup costs only that note.
- `dev/report-pdf-step-resources.test.cjs`: regression test (not served).

If the merge fails, a submission can go through without those files in Sources & Notes. The tech sees the notice in the PDF step, but nothing warns at submission itself. The files stay in Resources.

## Checks

- **Dev:** live in `measure-internal-20261030182432-f5c8d997`, regression gate passed.
- **Release commit:** `node --check` on both scripts and `dev/report-pdf-step-resources.test.cjs` 6/6 (from the production plan; not rerun by this run).
- **Build:** on the dev worker (npm ci, check, build), archive sha256 `0c741068…`, verified. Its 2 editor scripts match the plan's sha256 prefixes (`553a85cf30c2a1ee`, `73d61ed2cf7f7e85`), and its sha256 was rechecked on compatibility and the worker after copying.

## Not changed

No Node code, migration, configuration, environment or data change.

## Rollout

- Compatibility at 18:35:38Z, from `e2a69846`.
- Worker at 18:38:01Z, after no running jobs: 8 slots, production, email on, heartbeat off.
- Signed channel published against `0b138323…` (new archive `0c741068…`), so new pool nodes get this release.
- Six web nodes from 18:39:00 to 18:48:33 UTC, one at a time. Each was drained from the load balancer and ready in about 94 s, with matching assets (`portal/scripts/core.js`, `report.js`, `project_resources.js`).

Public readiness returned `70c22b02` 10 out of 10 times, then 20 out of 20 and 10 out of 10 on rechecks. Served from `https://app.1m8.ai/measure/internal/editor_scripts/`, `report.js` has 4 lines with `mergeProjectResourcesIntoSources` and `project_resources.js` 3 with `mergeSubmissionSources`, as the plan expected, and both are byte-identical to the commit.

After activation:
- **Compatibility:** 72 `backend_login.php` 502s from 18:35:48 to 18:36:43, all inside the restart. Node was down for those 65 s (it logged listening at 18:36:43), so PHP's staff lookup failed and technicians signing in during that minute got an error. There were none after that, against 0 5xx on that page in the hours before. This window is far larger than the 1 such error in FM-312's 07:31 release: compatibility's restart now interrupts editor sign-in for about a minute, so daytime releases are noticeable. From 18:37:00 nginx 5xx is 59 of 7,539 (0.78%), all the existing `top_view_reroll_proxy.php` 500, against 1.21% in the half hour before. No Node 500s from 18:36:30 and no HTTP worker exits.
- **Web nodes:** 0.00–0.14% 5xx after activation, only `top_view_reroll_proxy.php`, each below the same node's 0.68–0.82% before; no HTTP worker exits.
- **Worker:** 132 jobs completed and 0 failed in the first 12 minutes after activation; 20 queued, in line with 46 queued in the half hour before.

**Not checked:** the signed-in editor on production. This run has no production staff session and touched no production data, so no complete PDF has been generated and submitted with this fix on a real project. Ask Rashid to reopen the project and go to the PDF step.

## Disk

After this release, compatibility is at 90% (12 GB free), five web nodes at 89% (11–12 GB free) and `64.23.240.81` at 92% (8.6 GB free). Each release adds about 1.2 GB, so `64.23.240.81` has room for about six more. Nothing was deleted; old `/opt/firstmeasure/releases` directories and `/var/tmp/firstmeasure-release-*` archives need a cleanup soon.

## Rollback

Every role keeps `e2a69846`. Republish it (`0b138323…`) to the channel before rolling back a web node. Code only: nothing this release writes needs the new code to read.
