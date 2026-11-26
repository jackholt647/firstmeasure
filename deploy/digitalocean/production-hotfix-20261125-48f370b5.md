# Production release 48f370b5 (FM-640 public API report lookups filter by organization in the query), November 25, 2026

Production runs `48f370b5730d79785466ff3b687aa3c0df3dda0c` on all 8 hosts (compatibility, worker, 6 web nodes).
Rollback target: `2e70839ff9145bc8a8e73d196e2ef498bb23d220` (FM-638), recorded on FM-640 before activation.

## What changed

Branch `claude/fm-640-fix-prod`, one commit `48f370b5` on production-live `1c9a98350` (the record of `2e70839f`), a
cherry-pick of canonical `5d3c728b` (its `public/v1` diff is identical), verified on dev in
`platform-20261125222606-97162e52`. Released as is.

- `public/v1/src/database/shared_documents.ts`: new `listSharedDocumentsMatching` lists one collection of
  `app_shared_documents` filtered on top-level document fields in SQL (field names and values are query parameters),
  ordered by a document field, with the limit applied after filtering. Read-only; no table, index or schema change.
- `public/v1/public-firstmeasure/reports.ts` (Node, all hosts): `listPublicFirstMeasureReports` filters org_id, mode
  (missing = live), external_id, idempotency_key_hash and firstmeasure_project_id in the query, newest created first,
  limit 1-500 as before. It used to load the 500 most recently updated public API reports of every organization and
  filter afterwards, so `GET /v1/public/firstmeasure/reports?external_id=`, idempotent `POST /reports` replays and
  the project -> report lookup missed older reports. `findPublicFirstMeasureReportByIdempotency` and
  `findPublicFirstMeasureReportByProjectId` ask for their exact match (limit 1).
- Test `tests/public-firstmeasure-report-lookup.test.ts`; `docs/optimization-backlog.md` entry (the JSON filter has
  no index and reads every public API report row, about 1,200, per lookup).

No database, data, environment, flag, NGINX or config-library change.

## Rollout (full path)

Scripts: `/srv/agents/work/fm-640-prodrun-scripts` on fm-agents-1 (FM-638's full-path folder, one id pass through
placeholders, base = 2e70839f, previous channel archive = FM-638's; rollback set in `rollback/`).

- Built on the dev worker (`build.sh`, 288 s, type check included), archive sha256
  `931a67dcdbd519c92012c2728b8ddfc75c1f28b03eb825c015754cc7f8b0e328`. The extracted tree differs from 2e70839f only
  in the fix's two files (source and compiled), its test (source and compiled), `release.env` and the two earlier
  records. `web_activate.py` asserts 155/155 on the new tree (the FM-640 assert fails on the old one); rollback
  asserts 153/153 on the old tree. No browser file changed, so nothing was repinned. Archive test
  `dist/tests/public-firstmeasure-report-lookup.test.js` 1/1 (file storage).
- Read-only probe (`probe640.mjs`, worker environment, ids and booleans only), control on 2e70839f: the 744-report
  organization's oldest report (recency rank 1117 of 1155) was found by none of external_id, idempotency hash and
  project id, and its live list returned 216 of its 725 live reports. The same probe on the installed, inactive
  48f370b5: all three found, never from another organization, live list 500 (the cap); FM-639's report (rank 368)
  found both times.
- Worker activated 22:45:39 UTC (no running jobs); web channel published (previous `990c5b99…`); web rolled one node
  at a time 22:46:50-23:00:11, every node passing the asserts and back behind the LB. Compatibility waited at its load gate (legacy-action
  1,000-1,700/min against 420 from 23:00; the gate timed out after 3 h and was restarted at 02:19), opened at 03:38:12
  UTC and replaced its workers one at a time (rolling replace), both slots on 48f370b5. Web and worker ran 48f370b5
  while compatibility stayed on 2e70839f for 4 h 40 min; the change is read-only, so the mixed state was safe.

## Checks

- `current` = 48f370b5 on all 8 hosts; `https://app.1m8.ai/v1/health/ready` 10/10 ok on 48f370b5 (at 23:11, 02:19 and 03:52 UTC).
- Probe on the live worker release: FM-639's report and the 744-report organization's oldest report found by
  external_id, idempotency hash and project id; another organization gets 0 / null; live list 500 of 725.
  Anonymous `GET /v1/public/firstmeasure/reports?external_id=probe`: 401 (3/3).
- Web 5xx 23:00-23:11 vs the 30 min before: 0.01-0.04 % vs 0.01-0.03 % per node; every 5xx is the long-standing
  `top_view_reroll_proxy.php`. Web nginx `/v1/public/firstmeasure/reports*` from 22:46:50 to 03:52: 8 x 200 and 6 x 404 by id
  (that path is unchanged) and the three 401 probes; the 24 h before had 33 (31 authenticated), no 5xx either side.
- Compatibility 03:38-03:52: 0 watchdog kills (0 in the 24 h before), 0 OOM, 0 Node 500s, 0 pool timeouts, 0
  restarts, MainPID 3681809 throughout; 5xx 0.22 % vs 0.27 % in the 30 min before, all `top_view_reroll_proxy.php`.
  Web 5xx 03:39-03:52: 0.00-0.03 % vs 0.01-0.02 %.
- Worker since activation: 811 jobs completed, 0 failed, 62 queued (scheduled `report.release`).
