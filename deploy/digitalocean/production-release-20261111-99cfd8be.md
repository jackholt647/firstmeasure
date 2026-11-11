# Production release 99cfd8be: Export Acquisition Data (FM-393), November 11, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. FM-393's plan branch
`claude/fm-393-acquisition-data-export-prod` is two commits on release `22195bf2` (FM-389/FM-390) and was taken as is:

| Commit | Change | Same diff as (verified on dev) |
| --- | --- | --- |
| `86ca417b` | FM-393: export every acquisition campaign's data for all time as one zip | `c5c29eae` line for line (`api.ts`, `referrals.ts`, `zip-stream.ts`, `route-access.ts`), in `platform-20261111164135-f6f2bf8d` |
| `99cfd8be` | FM-393: Export Acquisition Data button in the Customers tab | lane commit `125d6245` line for line, in `measure-internal-20261111164215-a485e777` |

## Change

- `public/v1/internal/crm/`: new staff route `GET /v1/internal/crm/referrals/acquisition/export`, with the same guard
  as `/report` (sales-managing staff), declared in `internal/route-access.ts`. It streams one zip of CSVs for every
  campaign, all time: `attributions.csv`, `signups.csv`, `events.csv`, `spend_ledger.csv`, `campaigns.csv`,
  `daily.csv`, `hourly.csv`, `breakdowns.csv`, `bonus_offers.csv`. Rows are read from `referrals.sqlite` on
  compatibility 250 at a time (`zip-stream.ts`), and files are split at 1 GiB. Cells a spreadsheet would read as
  formulas get a leading `'`. The `/report` breakdown labels and per-campaign totals moved into shared helpers;
  the report's output is unchanged.
- `public/measure/internal/portal_scripts/customers.js`, `acquisition_campaigns.js`: an **Export Acquisition Data**
  button beside Export Users TSV and Export Credit Ledger, for the staff who can open the Campaigns tab.
- Plus `tests/crm-api.test.ts` and the access-gates snapshot (not served). Diff from `22195bf2`: 8 files. No PHP,
  environment, flag, nginx, dependency, config-library or database change; no data migration or repair.

## Checks before release

- At 16:50 UTC every host's `current` was `22195bf2` and readiness reported it. The rollback target `22195bf2` was
  recorded on FM-393 before anything was activated.
- Each commit's file diffs equal the dev-verified commits line for line.
- Build on the dev worker (`npm run check` included) took 273 s, from a bundle `99cfd8be ^22195bf2`. Archive sha256
  `474430f1b82442cb8329cb43c74675394ff6c60ae179f66f5ce9f72b7333da75`, verified on fm-agents, compatibility, the
  worker and each web node.
- Fast path (`fastpath.sh decide`): exit 3, full procedure (Node files changed: `dist/internal/crm/{api,referrals,
  zip-stream}.js`, `dist/internal/route-access.js`; static: the two portal scripts).
- `web_activate.py` keeps every earlier assert and adds FM-393: `writeAcquisitionExport`, the `/export` route,
  `class ZipStream` and the route-access entry once each in `dist/`, and `customers.js` / `acquisition_campaigns.js`
  pinned to the plan commit's sha256 (`657786e6…`, `98bafc44…`). All 47 file asserts passed on the extracted
  archive and on the installed trees on compatibility and the worker, and fail on `22195bf2`'s tree (control).
- Baselines at 16:51: the export route answered 404 anonymously, `customers.js` had no
  `customersExportAcquisitionBtn`. Compatibility over the 6 h before: 6 watchdog kills (12 lines), 23 Node 500s,
  22 pool timeouts; 511 `legacy-action`/min, load 2.4.

## Rollout (scripts: fm-agents /srv/agents/work/fm-393-prodrun-scripts)

- Worker first, at 16:59:14 UTC (no running jobs; 8 slots, production, heartbeat off, outbound email on).
- The signed channel was published from compatibility against `cdbf0e39…` (`22195bf2`'s archive), and the six web
  nodes went one at a time behind the load balancer, 16:59:57–17:13:02 UTC. Each passed every assert and returned
  behind the load balancer on `99cfd8be`.
- Compatibility last, through the gate (`legacy-action` under 420/min, load under 10): it waited 11 min at
  448–823/min and opened at 17:24:47 (448/min, load 1.0). The activation printed **`(rolling replace)`**: the first
  production release to use FM-389's rolling replace. The journal shows `rolling replace started
  (v1-rolling-replace): release=99cfd8be…` and `complete … in 53321 ms`; MainPID unchanged (2266335), both HTTP workers
  new with `RELEASE_ID=99cfd8be…` and cwd in the new release. In the 20 s after: 0 Node 500s, 0 HTTP worker exits.

## Verification

- `current` is `99cfd8be0f392218ba7c059b077bc8c37c69d469` on all 8 hosts; readiness reports `99cfd8be` 10/10 (state
  ready) after the web rollout and after compatibility.
- Anonymous `GET https://app.1m8.ai/v1/internal/crm/referrals/acquisition/export` answers **401** 5/5 (404 before):
  the route is live behind its guard (`/report`, the control, 401 before and after).
- `https://app.1m8.ai/measure/internal/portal_scripts/customers.js` and `acquisition_campaigns.js` serve the release
  files (sha256 `657786e6…`, `98bafc44…`; `customersExportAcquisitionBtn` and `exportAllData` on 4 lines each) 3/3.
- No production export was downloaded (staff-only data); the plan leaves the first real export to staff.
- Compatibility watch from 17:24:48 to 18:00 (35 min): 0 watchdog kills, 0 Node 500s, 0 pool timeouts; MainPID
  2266335 throughout; `legacy-action` 324–633/min, load 0.8–3.9. Compatibility nginx during the rolling replace: two
  `editor.php` 502s at 17:25:44 (when the old workers retired), against the ~10 s of editor 503s a restart used to
  cost; no 5xx spike on web from the switch. Worker from 16:59:14 to 18:00: 904 jobs completed (545 `pdf.sync`, 160
  `imagery.process`, 136 `report.delivery`, 63 `report.release`), 0 failed; queued only `report.release` scheduled for
  later (0 due). Readiness `99cfd8be` 10/10 at 18:00.
- 5xx from 17:26 (compatibility settled) against the 30 min before: web 0–0.21 % per node against 0.04–0.06 %, every
  one `top_view_reroll_proxy.php` (long-standing); compatibility 0.81 % against 0.54 %, 180 of 181
  `top_view_reroll_proxy.php` and one `editor.php` 503 at 17:54. Nothing on the release's routes.
- The only requests to the export route since activation are the five anonymous 401 probes above (17:26:29).

## Compatibility gate

Unchanged by this release (`compat_gate.sh`). This is the first release whose compatibility activation said
`(rolling replace)`: 53 s, no kills, no Node 500s. Per FM-389's plan this is the first real evidence toward lowering
the gate; that decision is not part of this release.

## Rollback

`/srv/agents/work/fm-393-prodrun-scripts/rollback/` (the same scripts reversed to `22195bf2`; the channel republishes
`22195bf2`'s archive from `/var/tmp/firstmeasure-release-22195bf2/` on compatibility, against `474430f1…`). Rolling
back removes the route and the button; there is no data to undo.
