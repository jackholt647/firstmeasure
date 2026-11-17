# Production release 90818652: FM-531 (Full Exterior standard delivery is 12 hours), November 17, 2026

Released from fm-agents-1 by the FM-531 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The release is the plan commit as is: `90818652` on `claude/fm-531-standard-delivery-time-prod`, a child of
production-live `e5c5a405` (record of release `799b39d2`, FM-532, production at the start of the run). Its two commits
match canonical `eefa944f` and lane `4df6e69a` line for line; only hunk offsets and one context line in the catalog
`manifest.json` (production's `measurements` catalog name) differ. Verified on dev in
`platform-20261117221556-aa29db36` and `measure-internal-20261117221633-bd001b2c`.

## Change

- `public/v1/firstmeasure/exteriors.ts` (Node): `EXTERIOR_STANDARD_MINUTES = 720`. The `exteriors_standard` quote
  option is "Standard · 12 hours", 720 minutes, deadline now + 12 h, and the wait estimate spans 9-12 h (was 18-24 h).
  An order stores that deadline as `report_due_window_end`, and the unchanged release hold
  (`buildReportReleaseHoldPlan`, FM-383) releases a finished standard report 10-15 min before it. Orders placed
  before this release keep the 24 h deadline they were sold with.
- `public/libraries/apps/firstmeasure/order/exteriors.js`: the phone and desktop delivery bars are drawn on 9-12 h
  with "9 hrs"/"12 hrs" labels (keys `m_70bebe3d5e1c4a`, `m_a5dd2a1c20d0a5`); the standard label fallback says
  12 hours.
- `public/libraries/apps/billing/app.js`: the pending Full Exterior label says "12 hours" (apps manifest
  `?v=20261117-fm531-12h-standard`).
- Language: `firstmeasure.88074127c11b59f6.json` + catalog `manifest.json`, catalog source/overrides/translation
  context and the 15 packs.
- Editor: `measure/internal/portal_scripts/prices.js` hint says "12-hour delivery".
- Tests (not served): `tests/exteriors-order.test.ts`, `tests/full-house-delivery.test.ts`,
  `tests/order-status-real-app-browser.test.mjs`.
- No data, environment, dependency, flag, nginx or config-library change.

## Checks before release

- At 22:25 UTC `current` was `799b39d2` on all 8 hosts and readiness reported it; root disks had ≥ 71 GB free and
  no watch or gate processes were left over. Rollback target `799b39d2` was recorded on FM-531 before anything was
  built or activated, and the agent channel lock was posted.
- Built `90818652` on the dev worker (327 s, including the type check). Archive sha256
  `2ad834165348d4727084773914190a21dae2af0f8a938bae99a5dbe0116eeaaa`.
- Full procedure (Node changed), so no fast-path decision.
- `web_activate.py` keeps every earlier assert, repins the files this release changes (apps manifest, catalog
  `manifest.json`, FM-396's `firstmeasure` catalog name, FM-530's `exteriors.js` digest) and adds FM-531's: served
  `exteriors.js`, `billing/app.js` and the new catalog equal to local, the 9-12 h bar and keys, no "24 hrs", the
  billing `?v=`, "Standard · 12 hours" and no `1440` in `dist/firstmeasure/exteriors.js`, and the Prices hint. All
  92 file asserts pass on the archive. The rollback asserts (FM-532's forward set, base `90818652`) pass 87/87 on
  `799b39d2`'s archive.
- Read-only quote probe (`probe531_quote.mjs`: the release's `exteriorQuote()` in process, no route, read-only
  Postgres session): `799b39d2` gives "Standard · 24 hours", 1440 min, 24 h deadline (control); the installed,
  inactive `90818652` gives "Standard · 12 hours", 720 min, 12 h deadline, estimate 630 min.

## Rollout (scripts: fm-agents /srv/agents/work/fm-531-prodrun-scripts)

- Compatibility and the worker installed; channel published against `799b39d2`'s archive (`7a9e0ec6…`).
- Worker activated at 22:36:28 UTC with no running jobs.
- Web nodes one at a time, 22:37:35-22:50:39 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility through the gate: it opened on its second check at 22:51:52 (401 legacy-action/min, load 0.9).
  Rolling replace 22:51:54-22:52:53, 0 Node 500s and 0 exits in the 20 s after.

## Verification

- `current` is `90818652` on all 8 hosts. Readiness reports `90818652` 10/10. Compat's HTTP workers run
  `RELEASE_ID=90818652` (the primary keeps its start-up release, as with every rolling replace).
- Served over https://app.1m8.ai, 12/12 each and byte-identical to the archive: `order/exteriors.js` `85283dbb…`
  (2× `m_a5dd2a1c20d0a5`, 2× the 9-12 h bar formula, no "24 hrs"), `billing/app.js` `58c4fae5…`
  (`exteriors_standard:'12 hours'`), catalog `manifest.json` `a7eb5866…` (names `firstmeasure.88074127c11b59f6.json`),
  that catalog `47ee95f2…`, apps manifest `66c3f135…`. `measure/internal/portal_scripts/prices.js` says
  "12-hour delivery" 12/12 after compatibility.
- The quote probe on the worker's live `current` gives "Standard · 12 hours", 720 min, a 12 h deadline and a 630 min
  estimate (in 540-720).
- 5xx from 22:53 UTC (after compatibility settled) to about 23:14, excluding health probes: web nodes 0.03-0.08 %
  (4-10 of ~12-13k each) against 0.03-0.06 % in the 30 minutes before; compatibility 0.64 % against 0.63 %. All but
  one are the pre-existing `top_view_reroll_proxy.php` 500s.
- Compatibility, 22:53-23:11 (10 polls): 0 watchdog kills (the hour before the release had 2), 0 OOM kills, 0 Node
  500s, 0 pool timeouts, one MainPID throughout, 2.1-2.5 GB available, 455-666 legacy-action/min.
- Worker, 22:36:28-23:13: 401 jobs completed, 0 failed; no "Worker stopping", browser-closed, pool-timeout or
  heartbeat errors. `report.release` jobs keep completing (19); the 523 queued are scheduled for later, none overdue.
- No production login exists on fm-agents-1 and no real order was placed to test; a person confirms the order form's
  bar and the first standard order released at its 12-hour mark.

## Rollback

`/srv/agents/work/fm-531-prodrun-scripts/rollback/`: `release.sh worker`, `publish` (republishes `799b39d2`'s
archive), `web_rollout.sh` (FM-532's asserts with base `90818652`; 87/87 pass on `799b39d2`'s archive),
`release.sh compat`. Rolling back restores the 24 h standard for new orders; orders placed in the meantime keep the
12 h deadline they were sold with, and no data depends on this release.
