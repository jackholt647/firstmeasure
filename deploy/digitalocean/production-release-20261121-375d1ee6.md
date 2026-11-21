# Production release 375d1ee6: the report summary card and its CSV list the parapet wall (FM-629), November 21, 2026

Released from fm-agents-1 by the production run for FM-629 (FirstMeasure bug fixes workspace, Router's standing
authorization for issues set to "Testing in prod" once verified on dev). The release is the plan branch tip as is:

| Commit | Change | Same change as (verified on dev) |
| --- | --- | --- |
| `375d1ee6` | FM-629: report summary and its CSV list the parapet wall | canonical `d684f746` (`+/-` lines identical), dev release `platform-20261121164255-d68cf41c` |

`375d1ee6` (plan branch `claude/fm-629-fix-prod`) is a direct child of `production-live` `a43e900a` (the record of
the live release `6a7a8a16`, FM-628). This record is committed on top of `375d1ee6`, so the push is a fast-forward.
Rollback target `6a7a8a16d0b03b4bda8b2db7d8df5d789e14a2b3`, recorded on FM-629 at 16:49 UTC before anything was built.

## Change

- `public/libraries/apps/measurements/project.js` (+2): `reportSummaryRowsFromRoofMeasurements` adds a "Parapet wall"
  row from `parapetLf`. That function builds the project window's Measurements card and its CSV, for staff (dataset)
  and customers (`roof-lines`). Both sources already carried `parapetLf`; only the row was missing (2524 S Sepulveda
  Blvd, report `1cd1981f…`: 612.4 ft of parapet in the PDF and `model_data.xml`, absent from the card and CSV).
- `public/v1/tests/full-house-customer-summary.test.mjs` (+13): regression test (not served).
- No Node, server, environment, flag, NGINX, dependency, config-library or database change, and no data repair.

## Path: full, not fast

The plan expected the fast path. `release-node-fingerprint.py compare` on the two archives exits 3: everything
under `public/libraries/` counts as Node's (as for FM-394, FM-563), here `changed_node` = `project.js` and the test,
server digest and dependencies unchanged. So the full procedure ran (compat gate, Node restarts, web nodes one at a
time). The release content is exactly the plan's.

## Checks before release

- `current` was `6a7a8a16` on all 8 hosts; 62–63 GB free on every web node, 70 GB on compatibility, 126 GB on the worker;
  no watch or gate loops left from earlier runs.
- Built on the dev worker (`npm run check` included). Archive sha256
  `11bf3f0e12d38c680610ac6d17cb4370ef5a52e94d70d5b28107616d3a1e4293`. `diff -rq` against `6a7a8a16`'s archive
  (node_modules excluded): only `project.js`, the test, `release.env` and the previous record. `project.js` sha256
  `55d53a605c18f06465f21d6daba309f4f9c405ce35ece8cec76031d560fa4eb6`, `add("Parapet wall", measurements.parapetLf,
  'ft', 1);` ×1.
- Plan test in the plan worktree (its `project.js` byte-identical to the archive's): tests 1, 2, 4, 5 and 6 (the
  FM-629 test) pass; test 3 (customer `Summary.pdf` exterior page, reads `pdf.js` only) fails before and after this
  commit, as the plan states.
- `web_activate.py` = the `b4f166bc` run's (FM-625, last full run), with `project.js` (×3) and `wall_face_draft.js`
  (FM-628) digests repinned by an automatic old→new map, and an FM-629 block (served `project.js` sha256 and the
  parapet needle). 139 file asserts pass on the new tree and fail on `6a7a8a16`'s (control); the rollback asserts
  (release `6a7a8a16`, base `375d1ee6`) pass on `6a7a8a16`'s tree (138).
- Plan harness control (`/tmp/fm629/served-check.mjs` on the file production served before): the CSV ended at
  `Sidewalls,8.6,ft`; production served `44100681…` 3/3.

## Rollout (scripts: fm-agents /srv/agents/work/fm-629-prodrun-scripts)

- Installed on compatibility and the worker before 16:59:57 UTC.
- Worker activated 17:00:47 UTC with no running jobs (`RELEASE_ID=375d1ee6…`, 8 job workers, production environment).
- Channel published against `6a7a8a16`'s archive at 17:00:50 UTC.
- Web nodes one at a time, 17:01:42–17:14:37 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility through `compat_gate.sh`: opened at once at 17:14:44 UTC (193 legacy-action/min, load 0.41). Rolling
  replace, `COMPAT_DONE` 17:15:40, 0 Node 500s and 0 worker exits in the 20 s after.

## Verification

- `current` is `375d1ee6` on all 8 hosts; compatibility's HTTP workers run `RELEASE_ID=375d1ee6…`. Readiness 10/10 ok
  with `375d1ee6` (4 instances answering).
- `https://app.1m8.ai/libraries/apps/measurements/project.js` 12/12 sha256 `55d53a60…`, also with the manifest's
  `?v=20261120-fm625-report-after-qa`.
- Plan harness on the served file: the CSV now ends with `Parapet wall,612.4,ft` (order `1cd1981f…`'s real roof-lines
  values).
- 5xx from 17:15:40 UTC against the 30 minutes before: web 0–3 per node (0.00–0.05 %) against 0.04–0.07 %;
  compatibility 10 (0.59 %) against 0.65 %. All are the long-standing `/measure/internal/top_view_reroll_proxy.php`.
- Worker jobs since 17:00:45 UTC: 136 completed, 0 failed; queued jobs are scheduled `report.release` holds (0 due).
  Worker journal 17:15–17:30 UTC: 0 "Worker stopping", 0 PDF "browser has been closed", 0 pool timeouts, 0 heartbeat
  failures.
- Compatibility 17:15:51–17:28 UTC: 0 watchdog kills, 0 OOM, 0 Node 500s, 0 pool timeouts; same MainPID throughout,
  115–355 legacy-action/min, load 0.12–0.47, available memory 2.19–2.66 GB.
- No signed-in customer check against production: the run has no production customer session, and none was created.

## Note: browser caching

The plan said `project.js`'s `?v=` is its own content hash. It is not: the apps manifest loads it with a fixed
`?v=20261120-fm625-report-after-qa`, and NGINX sends no `Cache-Control` for it (only `ETag`/`Last-Modified`). A
browser that fetched the old file recently may keep using it until its heuristic freshness runs out (about a tenth of
the file's age at fetch time, so up to about an hour here) and then revalidates and gets the new file. Nothing was
added to the release for this; a manifest key bump would make it immediate for future changes to this file.

## Rollback

`rollback/`: `web_activate.py` = this run's template with only FM-628's `wall_face_draft.js` pin applied (release
`6a7a8a16`, base `375d1ee6`), `web_install.py` (`6a7a8a16`'s archive, sha256 `f4811a7f…`) and `web_rollout.sh`; republish
the channel with `6a7a8a16`'s archive (still on compatibility at `/var/tmp/firstmeasure-release-6a7a8a16`, `PREVSHA` =
this archive) before rolling the web nodes; worker and compatibility back with `activate-release.sh 6a7a8a16…`
(`rollback/release.sh`). No data to undo.
