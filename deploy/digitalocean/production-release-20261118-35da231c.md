# Production release 35da231c: FM-561 (cancel project reads only the manifest), November 18, 2026

Released from fm-agents-1 by the FM-561 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The release is the plan commit as is: `35da231c` on `claude/fm-561-fix-prod`, a child of production-live `0cd5f1fd`
(record of release `efc0bdc4`, FM-541, production at the start of the run). It is a clean cherry-pick of canonical
`7441763f` (merged as `8df6f867`); only line offsets differ. Verified on dev in `platform-20261118023245-8df6f867`.

## Change

- `public/v1/internal/api.ts` (Node, runs in compatibility's Node): `handleCancelProjectLegacyAction` reads the
  project with `readManifest(projectId)` instead of injecting `GET /v1/firstmeasure/projects/:id`, which also parsed
  app_metadata, pdf_state (524 MB for the reported project) and branding_defaults and ran a compat worker out of
  memory on every cancel of a big commercial roof (OOM kills 11/17 16:36, 19:17 and 11/18 02:16). A missing project
  still answers 404 "Project not found". The refund and no-refund branches, the history entry and the PATCH are
  unchanged.
- `public/v1/tests/cancel-project-legacy.test.ts` (new, not loaded at runtime).
- No PHP, editor, browser, data, environment, dependency, flag, nginx or config-library change. No data repair: the
  reported project (624 Douglas Ave) was never modified by the failed attempts.

## Checks before release

- At 02:40 UTC `current` was `efc0bdc4` on all 8 hosts (Node processes still ran `90818652`, the last full release;
  the releases since were fast-path and changed nothing Node reads). Readiness reported `90818652`. Root disks had
  ≥ 70 GB free and no watch or gate processes were left over. Rollback target `efc0bdc4` was recorded on FM-561
  before anything was built or activated, and the agent channel lock was posted.
- Built `35da231c` on the dev worker (265 s). Archive sha256
  `1e6694033b6ca8d15ce4a584b6357ed4a8af734ca5ee0bf61b1230c44d7a7659`. The extracted tree differs from `efc0bdc4`'s
  only in `internal/api.ts`/`dist/internal/api.js`, the new test (source and dist), `release.env` and the previous
  record.
- Full procedure (Node changed), so no fast-path decision.
- `web_activate.py` = FM-531's (last full run) with one sed pass, `wall_mode.js` repinned to the live release's blob
  (changed by fast-path FM-541), and FM-561's assert: in `dist/internal/api.js`, the text from
  `async function handleCancelProjectLegacyAction` to `function numericUnix` holds `readManifest(projectId)` once and
  no `injectJson(app, "GET"`. 93 file asserts pass on the archive; on `efc0bdc4`'s archive the FM-561 assert fails
  (control). The rollback asserts (same set without FM-561, base `35da231c`) pass 92/92 on `efc0bdc4`'s archive.

## Rollout (scripts: fm-agents /srv/agents/work/fm-561-prodrun-scripts)

- Compatibility and the worker installed; channel published against `efc0bdc4`'s archive (`d5db218d…`).
- Worker activated at 02:49:46 UTC with no running jobs.
- Web nodes one at a time, 02:50:44-03:04:32 UTC. Each passed every assert (FM-561: 1 `readManifest`, 0 GET injects)
  and came back behind the load balancer.
- Compatibility through the gate: it opened on its first check at 03:04:47 (322 legacy-action/min, load 1.4).
  Rolling replace from 03:04:48, 0 Node 500s and 0 worker exits in the 20 s after.

## Verification

- `current` is `35da231c` on all 8 hosts. Readiness reports `35da231c` 10/10 across 6 instances. Compat's HTTP
  workers run from `/opt/firstmeasure/releases/35da231c…/public/v1` with `RELEASE_ID=35da231c…`; the installed
  `dist/internal/api.js` on compat has the manifest-only cancel.
- 5xx from 03:06 UTC (after compatibility settled) to about 03:20, excluding health probes: web nodes 0.02-0.06 %
  (2-7 of ~10-11k each) against 0.00-0.06 % in the 30 minutes before; compatibility 0.53 % against 0.45 %. Every one
  is the pre-existing `top_view_reroll_proxy.php` 500.
- Compatibility, 03:06-03:28 (12 polls): 0 watchdog kills (1 in the hour before), 0 OOM kills, 0 Node 500s, 0 pool
  timeouts, one MainPID throughout, 2.0-2.5 GB available, 369-566 legacy-action/min.
- Worker, 02:49:46-03:28: 310 jobs completed, 0 failed; no "Worker stopping", browser-closed, pool-timeout or
  heartbeat errors. `report.release` jobs keep completing; the queued ones are scheduled for later, none overdue.
- No customer project was cancelled as a test. No staff cancel of the reported project
  (`fd7cf4f24137e9a64513c83360e49566`) happened during the watch; a person confirms the cancel works. When it is
  cancelled, compat's log should show the `legacy-action` completing with only a `PATCH` for that project (no GET)
  and no OOM.

## Rollback

`/srv/agents/work/fm-561-prodrun-scripts/rollback/`: `release.sh worker`, `publish` (republishes `efc0bdc4`'s
archive, PREVSHA `1e669403…`), `web_rollout.sh` (asserts without FM-561, base `35da231c`; 92/92 pass on
`efc0bdc4`'s archive), `release.sh compat` through the gate. Rolling back brings back the full-detail read, so
cancelling a project with a huge pdf_state would crash a compat worker again; no data depends on this release.
