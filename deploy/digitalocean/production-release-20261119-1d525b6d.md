# Production release 1d525b6d: report line totals from the delivered report (FM-623), November 19, 2026

Released from fm-agents-1 by the FirstMate Tracker production run for the "FirstMeasure bug fixes" workspace (standing
authorization for issues set to "Claude → Testing in prod" once verified on dev). Jack approved releasing it on
2026-11-19 in the Claude Code session that made the fix ("Yes, do both").

The release is `1d525b6d`, the plan's branch `claude/stale-report-xml-prod` as is: one commit on `origin/production-live`
`8631f31c` (the record of `03645bd4`, production at the start of the run). `pdf.js` is byte-identical to dev's lane file
(blob `3fe81d31`, lane `70b67cc7`); the `measurements/project.js` hunks equal canonical `81f2c53c`'s line for line (blob
`ece24abf`); the apps manifest bumps only `measurements/project.js` to `20261119-report-line-totals`, as on dev
(`platform-20261119220115-72d284c6`).

## Change

- `public/measure/internal/editor_scripts/pdf.js` (sha256 `dd372c65dcfa…`, was `41161cd64f9f…`): after
  `saveStandalonePdfState` saves the PDF state, `syncSubmittedModelXml` rewrites `model_data.xml` from the same state
  (`generateRoofXML` + `firstMeasureUploadArtifact`) when the project is completed, awaiting review or already has a
  model. A failure is logged and does not fail the save. Before, the XML was written only on the technician's submit, so
  a QA correction or later update left the customer's XML and the portal's totals on the first submit's line types.
- `public/libraries/apps/measurements/project.js` (sha256 `ceddb9972058…`, was `ee36f6f1f10f…`): when the customer is
  refused the measurement dataset, the Roof Report Summary's line rows come from `GET
  /v1/firstmeasure/projects/:id/roof-lines` (the PDF's own totals, FM-455; already on production) through the new
  `reportMeasurementValues`; the XML keeps the area, facet and pitch rows.
- `public/libraries/apps/firstmate-apps-manifest.js`: `measurements/project.js` `?v=20261119-report-line-totals` (was
  `20261118-hole-area`).
- `public/v1/tests/full-house-customer-summary.test.mjs`: the guards (it is in the archive under `public/v1/tests`, which
  nothing runs on production).
- No Node source, dependency, configuration, environment, database, flag or config library change. **No data repair:**
  orders whose XML is already stale keep it until their PDF state is saved again; the repair of existing orders' XML runs
  separately from Jack's Claude Code session (`/root/xml-repair-20261119` on the worker) and is not part of this release.

## Checks before release

- Plan test `public/v1/tests/full-house-customer-summary.test.mjs` with the release's files: 4/5; with `03645bd4`'s
  files 0/5 (control). Test 3 (full-house Summary.pdf regex) fails on `03645bd4` unchanged too, as the plan says.
- Built on the dev worker (`build.sh`, 320 s, `npm run check` included). Archive sha256
  `2ede728b5d9640717296349363a028fbd1ac50d2931dad302db94ae88e576e54`. `diff -rq` against `03645bd4`'s archive lists only
  the four files above, `release.env` and the previous record.
- `fastpath.sh decide` against `03645bd4`: **full procedure** (`public/libraries` and `pdf.js`, which Node's PDF runtime
  serves, count as Node's side).
- `web_activate.py` = the `03645bd4` run's, repinned for the three changed files (FM-375/518/520 `pdf.js` digest,
  FM-532 round 3 `project.js` digest, apps manifest digest; FM-400/455 manifest `project.js` key → the new version,
  FM-455/FM-401 `20261118-hole-area` count 3 → 2, FM-455 ``/roof-lines` `` in `project.js` 1 → 2) plus an FM-623 block
  (file digests, served files, `syncSubmittedModelXml` ×2, `projectHasSubmittedModel` ×1, `'model_data.xml'` ×1,
  `reportMeasurementValues` ×2, old manifest key ×0). 129 file asserts pass on the archive and on the trees installed on
  compatibility and the worker, and fail on `03645bd4`'s tree (control). Rollback asserts (`03645bd4`'s, base
  `1d525b6d`) pass on `03645bd4`'s tree (126).

## Rollout (scripts: fm-agents /srv/agents/work/fm-623-prodrun-scripts)

- Rollback target `03645bd4` recorded on FM-623 at 22:04 UTC, before anything was installed.
- Installed on compatibility and the worker (22:14–22:16 UTC).
- Worker activated 22:16:28 UTC with no running jobs.
- Channel published against `03645bd4`'s archive.
- Web nodes one at a time, 22:17:36–22:31:11 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility: through `compat_gate.sh` (legacy-action < 420/min and load < 10). The first gate ran its 180
  checks, 22:31:19–01:37:56 UTC, at 514–1,577/min and gave up; restarted at 01:39:03 (`compat_gate2.log`), it opened at
  01:53:42 (413/min). Rolling replace, `COMPAT_DONE` at 01:54:55, with 0 Node 500s and 0 worker exits in the 20 s after.
  Production was split (worker and web new, compatibility old) for those 3 h 23 min; the change is browser-only and the
  old and new trees differ only in the three browser files, so nothing server-side disagreed.

## Verification

- `current` is `1d525b6d` on all 8 hosts; compatibility's HTTP workers run `RELEASE_ID=1d525b6d…`. Readiness 10/10 200
  with `1d525b6d` (6 instances) before compatibility switched and again after.
- Every web node and compatibility serve `pdf.js`, `measurements/project.js` and the apps manifest at the plan's git blobs
  `3fe81d31`, `ece24abf` and `49458093`; through the load balancer 5/5 requests give the same. Node's PDF runtime asset
  (`/v1/firstmeasure/pdf-runtime/assets/pdf`) serves `3fe81d31` too.
- Plan test with the files production serves (through the load balancer, after compatibility): 4/5, tests 4 (line rows
  from `roof-lines` when the dataset is refused) and 5 (a PDF state save rewrites `model_data.xml`) pass; test 3 is the
  pre-existing failure.
- The plan's catalog check, read-only on the worker (`xmlsync.py`, `PGOPTIONS` read-only, counts only): of the
  `firstmeasure_artifact_catalog` rows whose `pdf_state.json` was written 01:55–02:06 UTC, 18 of 27 have a
  `model_data.xml` written within 2 minutes of it (12 after it); in the control window before the release (19 Nov
  20:00–22:31 UTC) it was 43 of 330 (10 after), i.e. only submits. The remaining rows are drafts with no XML yet (3) or
  `pdf_state.json` writes that are not editor saves.
- Editor artifact uploads (`POST …/artifacts`) 01:55–02:07 UTC: 119, all 200 (30 min before: 209 × 200, one 400, one 499).
- 5xx from 01:56 (after compatibility settled) to 02:07 UTC against the 30 minutes before: web 1–5 per node (0.01–0.06 %)
  against 0.03–0.07 %; compatibility 19 (0.53 %) against 0.62 %. All are the long-standing
  `/measure/internal/top_view_reroll_proxy.php`, plus one `/v1/public/firstmeasure/reports` (a caller's invalid JSON,
  pre-existing). Web 22:31–22:45 UTC (web new, compatibility old): 0.02–0.07 % against 0.05–0.10 %.
- Worker jobs since 22:16:28: 2,010 completed, 1 failed (02:22 UTC); queued jobs are scheduled. The failure is a
  `report.delivery` whose customer email Postmark refused (422/406, the recipient is marked inactive after a hard bounce);
  the release changes no Node or email code. Worker journal
  22:17–22:42 UTC: 0 "Worker stopping", 0 PDF "browser has been closed", 0 pool timeouts, 0 heartbeat failures.
- Compatibility 01:54:55–02:24 UTC: 0 Node 500s, 0 watchdog kills, 0 OOM, 0 pool timeouts; same MainPID throughout,
  413–983 legacy-action/min, load 0.3–2.3. The one kill in the hour (01:53:00) hit an old-release worker before the gate
  opened. Available memory went from 2.4 GB to ~0.95 GB by 02:20 as the two fresh HTTP workers grew to ~1.2–1.3 GB each,
  then held (945/945/922 MB at 02:22–02:24); the Node `dist` is identical to `03645bd4`'s.
- Readiness 10/10 200 `1d525b6d` again at 02:22 UTC.

## Rollback

`rollback/`: the `03645bd4` run's `web_activate.py` (base `1d525b6d`), `web_install.py` and `web_rollout.sh`; republish
the channel with `03645bd4`'s archive (sha256 `dae74b2f…`, `PREVSHA` = this archive) before rolling the web nodes;
worker and compatibility back with `activate-release.sh 03645bd4…` (`rollback/release.sh`). Rolling back only stops new
PDF state saves from rewriting `model_data.xml` and brings back XML-based line tiles for customers; XML already
rewritten stays.
