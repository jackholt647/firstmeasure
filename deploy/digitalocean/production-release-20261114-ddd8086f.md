# Production release ddd8086f: FM-406 (billing activity descriptions), November 14, 2026

Released from fm-agents-1 by the FM-406 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The release is the plan commit as is: `ddd8086f` on `claude/fm-406-billing-activity-descriptions-prod2`, a direct child
of `production-live` `e2e684a3` (the record of release `102b43b8`, the FM-457 batch, production at the start of the run).
Its code diff (`credit_statement.ts`, `api.ts`, `settings/company.js`, `catalog-source.json`, the 15 packs, the new test)
equals dev commit `a2435c81` line for line; it was verified on dev in `platform-20261112185145-67490ca7` and re-verified
in `platform-20261114061659-cf6ed9ef`. Generated files (apps manifest key, catalog `manifest.json`, `coverage.json`) were
rebuilt on production's lines; the new catalog `settings.b4c2822ca4567837.json` is byte-identical to canonical's.

## Change

- Node: a customer's billing reads (`GET /v1/platform/organizations/:org/credits/ledger`, `org_billing_history_my`,
  `org_monthly_statement`, billing events) go through `customerLedgerEntries` (`platform/credit_statement.ts`), which
  removes from each ledger row every email that is not one of the organization's own users, with the name stored beside
  it (`rejected_by_*`, `cancelled_by_*`, a staff `by_email`). The stored ledger is unchanged; staff tools still see it.
  New expedite charge and expedite-failure refund rows store the report address (`platform/api.ts`).
- Browser: Settings › Billing titles `order_expedite_upgrade` "Expedite fee" and its refund "Expedite fee refund"
  instead of "Credit adjustment" (`settings/company.js`; apps manifest key `20261114-fm406-billing-activity`).
- Language: `fm_expedite_fee`, `fm_expedite_fee_refund` in `catalog-source.json` and all 15 packs; catalog
  `settings.b4c2822ca4567837.json`.
- Test (not served): `public/v1/tests/billing-activity-labels.test.ts`.
- No database, environment, flag, nginx, dependency or config-library change. No data repair: older rows that hold a
  technician's email are hidden when read.

## Checks before release

- At 07:49 UTC `current` was `102b43b8` on all 8 hosts, readiness on it, root disks 24–31 % used. Rollback target
  `102b43b8` was recorded on FM-406 before anything was built or activated.
- Built `ddd8086f` on the dev worker (`npm run check` and build passed, 279 s). Archive sha256
  `f5615882d28f7fef506980c1ed537e0ab973877a4b133f1f04b18bfb20cac53c`. Full procedure, because Node changes.
- `web_activate.py` keeps every earlier assert. Pins this release changes now name `ddd8086f`'s blobs (apps manifest,
  `settings/company.js`, catalog `manifest.json`); FM-401's checks no longer require the old catalog to be the manifest's
  `settings` entry or the old `company.js` key. New FM-406 asserts: `company.js` served and its two titles, the manifest
  key, catalog `settings.b4c2822ca4567837.json` (sha, served, 16 locales of each key), `dist` `customerLedgerEntries` and
  three `customerLedgerView` calls. 77 file asserts pass on the archive (`check_asserts.py`); control: they fail on
  `102b43b8`'s tree.
- Read-only probe against the installed, inactive release on the worker (`probe406.mjs`, worker environment,
  `default_transaction_read_only`): the release's `customerLedgerEntries` over the whole ledger of the 5 most recently
  updated organizations with a `rejection_refund` row, with each organization's user emails. Counts only:
  934 rows, 13 rejection refunds, 4 expedite upgrades; member emails 1264 before and after; other emails 30 → 0;
  `rejected_by_*` 26 → 0; `cancelled_by_*` 4 → 0; row counts unchanged. `102b43b8` has no such function (control).

## Rollout (scripts: fm-agents /srv/agents/work/fm-406-prodrun-scripts)

- Compatibility and the worker installed 07:57–07:58. Worker activated 07:59:11 UTC, with no running jobs.
- Channel published against `102b43b8`'s archive (`83a682d7…`).
- Web nodes one at a time, 08:00:10–08:12:55 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility at 08:13:01 UTC; the gate opened at once (273 legacy-action/min, load 0.00): rolling replace, 0 Node 500s
  and 0 exits in the 20 s after.

## Verification

- `current` is `ddd8086f` on all 8 hosts. Readiness reports `ddd8086f` 10/10 (5 nodes answering).
- app.1m8.ai serves the apps manifest with `versionedBundle('settings/company.js', '20261114-fm406-billing-activity')`,
  catalog `manifest.json` naming `settings.b4c2822ca4567837.json` (16 locales of each new key), and `company.js` with both
  titles. `GET /v1/platform/organizations/x/credits/ledger` anonymously: 401 6/6.
- The same probe on the live release (`/opt/firstmeasure/current`) at 08:14: identical counts (other emails 30 → 0,
  member emails 1264 → 1264).
- 5xx from 08:15 to 08:30 UTC (after compatibility settled), excluding health probes:
  - web nodes: 0 of 2020–2196 requests each (0.00 %), against 0.00–0.02 % (0–1) in the 30 minutes before
  - compatibility: 0 of 196 (0.00 %), against 0.16 % (1) before
- Compatibility, 08:13:01–08:36: 0 watchdog kills, 0 Node 500s, 0 pool timeouts, one MainPID throughout
  (legacy-action 234–298/min, load under 1).
- Worker 07:59:11–08:36: 5 jobs completed, 0 failed; no "Worker stopping", browser-closed, pool-timeout or heartbeat
  errors. The 22 `report.release` jobs queued before the release are scheduled, not yet due.

## Rollback

`/srv/agents/work/fm-406-prodrun-scripts/rollback/`: `release.sh worker`, `publish` (republishes `102b43b8`'s archive),
`web_rollout.sh` (the FM-457 batch's forward asserts with base `ddd8086f`), `release.sh compat`. Rolling back shows staff
emails on rejection refunds again and "Credit adjustment" for expedites; no data is involved either way.
