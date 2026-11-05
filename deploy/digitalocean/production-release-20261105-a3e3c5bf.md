# Production release a3e3c5bf: Report type filter in the Queue Monitor (FM-335), November 5, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev; Ben asked for the retry on FM-335. It is
production-live `ef08f985` (release `cad6a00b`: FM-336 `6249b30a` plus the Resources hotfix) plus three commits on
`claude/fm-335-report-type-filter-prod2`, cherry-picked unchanged from the commits verified on dev (diff identical to
`0fae642f..f6e02024`, the first run's `ab5e8a9f`):

- `acfbdcdf` (= `0fae642f`): server. `queue/counts` and `queue/bucket` take `report_type` (`roof` | `full_house`).
- `956be27c` (= `880fdb72`): portal. The Report type select in the Queue Monitor.
- `a3e3c5bf` (= `f6e02024`, canonical `b69b5d5a`): the filter tests the order id (`^exteriors_[a-f0-9]{32}$`).

Verified on dev in `platform-20261105024638-b1110547`, `platform-20261105025432-891d80fa` and
`measure-internal-20261105024724-042a281b`.

## The first run (ab5e8a9f) and why this one went ahead

`ab5e8a9f` (the same three commits on `be498109`) was live 03:34–03:57 and rolled back after compatibility's cluster
watchdog SIGKILLed HTTP workers four times in six minutes from 03:49 (stacked `/v1/internal/legacy-action`). The
investigation on FM-335 found no `queue/counts` or `queue/bucket` request on compatibility in any window, the same
stall shape before the release (00:45, 03:24), and the kills following compatibility restarts at peak
`legacy-action` load (696–743/min at 03:47–03:49). So this run activated compatibility only while `legacy-action` was
under about 450/min and watched the watchdog through the rollout and after it. The stall itself is not fixed here.

## Change

- Node: `firstmeasure/api.ts` passes `report_type` through; `project_index.ts` (`normalizeQueueReportType`, SQLite)
  and `project_index_postgres.ts` (`appendReportType`) filter before counting and paging. With a report type the
  counts and bucket total come from `projects`; without one nothing changes (`project_queue_counters`).
- Internal portal (compatibility): `index.php` gets `#queueReportTypeSelect` (All / Roof / Full exterior) beside
  Team; `portal_scripts/projects.js` sends `report_type`, resets bucket pages and caches per report type.
- `tests/firstmeasure-queue-report-type.test.ts` and an optimization-backlog entry. No schema, configuration,
  dependency or data change; route access unchanged.

## Checks before release

- On the branch (fm-agents-1): `npm run check`; `firstmeasure-queue-report-type`, `firstmeasure-queue-overview-in-progress`,
  `full-house-customer-resources` and `full-house-access` pass. `firstmeasure-postgres-indexed-queue` fails 1 of 4
  ("hot queue paths do not search JSON documents") on production-live as well (`queue_postgres.ts`, untouched).
- Build on the dev worker (`npm run check` included) in 246 s. Archive sha256
  `475d4faa12576a775f81eb56c8b725ee27f9be3db06e27be51d34de91e994ba5`, verified on fm-agents, compatibility and the
  worker.

## Rollout (scripts: fm-agents /srv/agents/work/fm-335-prodrun2-scripts)

- Rollback target before activation: `cad6a00bfbdec43b11fc4ba1199f11b7562947b9`, every host's `current` at 05:2x;
  recorded on FM-335.
- Compatibility at 05:30:43 UTC with `legacy-action` at about 250/min (load 2.1): active, no Node 500s and no worker
  exits in the first 20 s. 13 `backend_login.php`/`editor.php` 502s at 05:30:52–05:31:06, the restart window.
- Worker at 05:31:36 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `8aaa1b12…` (cad6a00b's archive); all six web nodes downloaded
  `a3e3c5bf` / `475d4faa` from it.
- Six web nodes one at a time behind the load balancer, 05:32:50–05:45:42 UTC (about 94 s each), each asset-checked
  as in cad6a00b's run plus the FM-335 build (`appendReportType`, the id pattern, `normalizeQueueReportType`), the
  FM-335 portal (`queueReportTypeSelect`, `queueAdminReportType`) and cad6a00b's Resources gate.

## After activation

- Public readiness answered `a3e3c5bf` on 12 of 12 requests (all six instances); all eight hosts point `current` at
  it, with the expected service active on each.
- Compatibility's `index.php` has `queueReportTypeSelect`, `projects.js` has `report_type`, the build has
  `appendReportType` with the id pattern, and cad6a00b's `fm_is_customer_full_house_id` / `isCustomerFullHouseId`
  are still there. `https://app.1m8.ai/measure/internal/portal_scripts/projects.js` serves `queueAdminReportType`.
  `queue/counts` without a session still answers 401.
- In-process on the worker (read-only, `rt_probe.py`): in all 12 queue groups Roof + Full exterior = All (All
  120,256 = Roof 120,253 + Full exterior 3). Full exterior is the 3 completed `exteriors_` orders, and every Roof
  bucket holds none. Filtered counts took 60–75 ms, unfiltered 42 ms.
- Web nodes since 05:32:50: 0–3 5xx of about 4,500–4,900 requests each (0–0.06 %; 0.22–0.39 % in the 30 minutes
  before, which include compatibility's restart minute), all `top_view_reroll_proxy.php` (failing before this
  release) or `/v1/platform/acquisition/event`.
- Compatibility after the restart window (05:31:10–06:06): 5 5xx of 5,492 nginx requests, all
  `top_view_reroll_proxy.php`; no Node 5xx. Cluster watchdog (`missed its` / `exited (slot`): **0 kills** from 05:30
  to 06:06 UTC, 20 minutes past the last web node (the first run's kills began 15 minutes after compatibility's
  restart, as the last web node switched). `legacy-action` stayed at 250–300/min, load 1.0–2.1.
- Jobs since the worker activation: 13 completed (imagery.process, pdf.sync, report.release), none failed;
  142 `report.release` queued from before activation, none due.
- Not checked: the Queue Monitor dropdown in a signed-in production staff session (no production staff login
  here). A person confirms that.

## Rollback

`cad6a00bfbdec43b11fc4ba1199f11b7562947b9` is still installed on every host: activate it on compatibility, the worker
and each web node one at a time with `activate-release.sh` (`fm-335-prodrun-scripts/rollback/` has the reversed
scripts from the first run; swap the ids), and republish the channel with cad6a00b's archive against `475d4faa…`.
Code only; this release writes no data.
