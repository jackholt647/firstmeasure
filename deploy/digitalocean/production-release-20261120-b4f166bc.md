# Production release b4f166bc: customers get a report's PDF and model only once it is delivered (FM-625), November 20, 2026

Released from fm-agents-1 by the FirstMate Tracker production run for the "FirstMeasure bug fixes" workspace (Router's
standing authorization for issues set to "Testing in prod" once verified on dev; FM-625 was verified on dev in
`platform-20261120155830-9c891cd1` and `platform-20261120161151-ed8560e3`).

The release is `b4f166bc`: `origin/production-live` `c29c8dd8` (the record of `c0e8128b`, FM-626, production at the
start of the run) + `git merge --no-ff` of the plan branch `claude/fm-625-fix-prod` (`675c3c37`, two commits written on
`d7942af4` before FM-626 released). The merge was clean; `git diff 4db9163b 675c3c37` and `git diff c0e8128b b4f166bc`
differ only in the previous record file, and each plan commit's `+/-` lines equal its canonical commit's
(`8158ad3a` = `a1feb556` apart from the apps manifest's unrelated `map-view.js` key, `675c3c37` = `c6655f94`).
The plan named `4db9163b` as rollback target; FM-626 (`c0e8128b`, fast path) had released since, so the recorded
target was `c0e8128b`.

| Commit | Change | Canonical (verified on dev) |
| --- | --- | --- |
| `8158ad3a` | Customers get a report's PDF and model only once it is delivered: server gate, portal board, project window, test, doc | `a1feb556` |
| `675c3c37` | The public integrator API follows the same rule | `c6655f94` |

## Change

- `public/v1/firstmeasure/api.ts`: `customerMayReadReport(manifest)` (completed and not held for its release window,
  or a customer rework of a delivered report) and `isCustomerReportFileName`. A **customer** session reading
  `Report.pdf`, `Summary.pdf`, `model_data.xml`/`model_data.generated.xml`, `pdf_state.json` or `app_metadata.json`
  (artifacts), `/projects/:id/pdf` or `/pdfs/report` gets 404 `report_not_ready` otherwise; `GET /projects/:id` leaves
  those files out and nulls `pdf_state`/`app_metadata`; `?view=portal-card` reports the artifact flags false. Staff,
  PHP-signed and system callers are unchanged.
- `public/v1/public-firstmeasure/api.ts`: `/v1/public/firstmeasure/reports/:id/pdf`, `/measurements` and report files
  under `/files/:name` follow the same rule (`assertPublicReportDelivered`); `/files` leaves them out until delivery.
- Browser: `libraries/apps/projects/viewer.js` (board hydration no longer marks a tile Ready from file presence),
  `libraries/apps/measurements/project.js` (PDF/model offered only once the order's status says returned),
  `firstmate-apps-manifest.js` (both bundles `20261120-fm625-report-after-qa`).
- Test `public/v1/tests/customer-report-access.test.ts`; `docs/architecture/request-security.md`.
- No database, environment, flag, config-library or nginx change, and no data repair: the gate applies to existing
  records as they are.

## Checks before release

- `current` was `c0e8128b` on all 8 hosts at 16:44 UTC; disk `/` 63–126 GB free on every host; no watch or gate
  scripts left from earlier runs. Rollback target `c0e8128b` recorded on FM-625 at 16:44 UTC, before anything was built.
- Built on the dev worker (340 s, `npm run check` included). Archive sha256
  `620d386e4d7724007ec6bfa6e6802fa16e03e308deaa817d0ca8b090b75a3aea`. `diff -rq` against `c0e8128b`'s archive lists only
  the files above, their `dist/` output, the test, `release.env` and the previous record.
- The archive's `dist/tests/customer-report-access.test.js` 1/1 (in QA, requeue, held, released, customer rework;
  customer and public API).
- `web_activate.py` = the `4db9163b` run's (FM-622), with the apps manifest, `measurements/project.js` and
  `projects/viewer.js` digests repinned, three manifest `?v=` needle counts that this release replaces set 1 → 0, and
  an FM-625 block (`dist/firstmeasure/api.js` `customerMayReadReport` ×4, `report_not_ready` ×1,
  `assertCustomerMayReadReport` ×4; `dist/public-firstmeasure/api.js` `assertPublicReportDelivered` ×4; served
  `viewer.js` (sha256 `a5f3f742…`, `isCustomerReworkStatus` ×2), `project.js` (`manifest.customer_rework_in_qa ===
  true` ×1), manifest `fm625-report-after-qa` ×2). 138 file asserts pass on the archive and fail on `c0e8128b`'s tree
  (control); the rollback asserts (base `b4f166bc`) pass on `c0e8128b`'s tree (133).
- Read-only in-process probe (`probe625.mjs` via `probe_run.py`: worker environ, `default_transaction_read_only`,
  counts only). On `c0e8128b` (control): no `customerMayReadReport`. On the installed, inactive `b4f166bc`: readable
  0 of awaiting_review 51, awaiting_manager_review 15, requeue 8, rejected 1,500, cancelled 1,500, in_progress 4; the
  video's order `f7f9ce8c…` (now rejected) false; 200 latest completed: 84 readable, 116 inside their release hold.
  Over the 20,000 latest completed orders (`probe625b.mjs`): 163 refused, all 163 held for release (FM-383), 0 refused
  that are not held.

## Rollout (scripts: fm-agents /srv/agents/work/fm-625-prodrun-scripts)

- Installed on compatibility and the worker before 16:57:20 UTC.
- Worker activated 16:58:27 UTC with no running jobs.
- Channel published against `c0e8128b`'s archive at 16:58:43 UTC.
- Web nodes one at a time, 16:59:14–17:12:05 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility through `compat_gate.sh` (legacy-action < 420/min and load < 10): waited 17:12:16–18:33:35 UTC (79 checks)
  at 465–1,415/min, opened at 401/min. Rolling replace, `COMPAT_DONE` 18:34:38, 0 Node 500s and 0 worker exits in the 20 s
  after.

## Verification

- `current` is `b4f166bc` on all 8 hosts; the worker and compatibility's HTTP workers run `RELEASE_ID=b4f166bc…` (compatibility's
  MainPID keeps an older id after rolling replaces, as before). Readiness 10/10 ok with `b4f166bc` after the web rollout and again after compatibility (18:36 UTC).
- Served through the load balancer: `projects/viewer.js`, `measurements/project.js` and the apps manifest equal the
  release's bytes (sha256 `a5f3f742…`, `44100681…`, `0b32e015…`) 4/4 each.
- Anonymous `GET /v1/firstmeasure/projects/f7f9ce8c…/artifacts/Report.pdf` and `/pdf` still answer 401
  `authentication_required`, and the public API `/reports/f7f9ce8c…/pdf` 401 `missing_api_key` (route gates
  unchanged), on the first activated node.
- The live worker (`current/public/v1`, same probe): the same results as on the installed release (0 readable in every
  undelivered status, the video's order false; completed sample 83 readable + 117 held).
- Customer traffic on the six web nodes' NGINX since 16:59:14 UTC: report files (`artifacts/Report.pdf`,
  `Summary.pdf`, `/pdf`) answered 200/206/401/499 only, no 404, so no customer asked for an undelivered report in the
  window. The share of client-closed (499) `/pdf` requests, 51–60 % per hour after, stays in today's range on the
  old releases (35–60 %; 53–57 % at 00–01 UTC, 60 % at 05 UTC); `Report.pdf`/`Summary.pdf` 499 shares are unchanged.
  Node response time on one web node, 14:00–16:59 against 16:59–18:55 UTC: `/pdf` median 44 → 49 ms (p90 64 → 74 ms,
  the added manifest read for customers), `Report.pdf` 65 → 62 ms, `Summary.pdf` 51 → 55 ms.
- 5xx from 18:35:40 (after compatibility settled) to 18:45 UTC against the 30 minutes before: web 5–9 per node
  (0.05–0.08 %) against 0.02–0.06 %; compatibility 43 (0.67 %) against 0.50 %. All are the long-standing
  `/measure/internal/top_view_reroll_proxy.php`. Web 16:59–17:13 UTC (rolling, compatibility old): 0.04–0.07 % against
  0.04–0.06 %.
- Worker jobs since 16:58:20 UTC: 1,418 completed (855 `pdf.sync`, 256 `imagery.process`, 201 `report.delivery`, 107
  `report.release`), 0 failed; queued jobs are scheduled `report.release` holds (0 due). Worker journal since
  activation: 0 "Worker stopping", 0 PDF "browser has been closed", 0 pool timeouts, 0 heartbeat failures.
- Compatibility 18:33:36–19:00 UTC: 0 watchdog kills, 0 worker exits, 0 OOM, 0 Node 500s, 0 pool timeouts; same
  MainPID throughout, 300–569 legacy-action/min, load 0.6–2.2, available memory 1.36–2.63 GB.
- No signed-in customer check was run against production: the run has no production customer session, and none was
  created.

## Rollback

`rollback/`: `web_activate.py` = this run's forward asserts before the FM-625 repins (release `c0e8128b`, base
`b4f166bc`), `web_install.py` (`c0e8128b`'s archive, sha256 `d9b7b818…`) and `web_rollout.sh`; republish the channel with
`c0e8128b`'s archive (still on compatibility at `/var/tmp/firstmeasure-release-c0e8128b`, `PREVSHA` = this archive)
before rolling the web nodes; worker and compatibility back with `activate-release.sh c0e8128b…`
(`rollback/release.sh`). No data to undo.
