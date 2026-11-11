# Production release 22195bf2: compatibility rolling replace (FM-389) and translated cover line types (FM-390), November 11, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. One release for the batch FM-390, FM-389,
FM-388. FM-389's plan branch `claude/fm-389-compatibility-replace-node-workers-one-a-prod` is one commit on release
`217f1691` (FM-387) and was taken as is; FM-390's plan commit (on the older production-live `83ce3e5d`) was
cherry-picked on top without conflicts:

| Commit | Change | Same diff as (verified on dev) |
| --- | --- | --- |
| `7ac4d447` | FM-389: compatibility replaces Node workers one at a time instead of restarting | plan commit; `server.ts`, `worker_warmup.ts`, `env.ts`, `activate-release.sh` byte-identical to `9fbd3605`, in `platform-20261111050409-790ed971` |
| `22195bf2` | FM-390: translate line type names on the report cover | `fd091524` line for line (= `6f7f0470`, lane commit `8fea84b8`, in `measure-internal-20261111043922-01f7ba15`) |

FM-388 (production run fast path) has no production code: its plan ships procedure and scripts only (canonical
`c06197c3`, tooling branch `codex/prod-release-tooling-20261029`). This run used its `fastpath.sh decide`, which
chose the full procedure (below). Nothing of FM-388 is in this release.

## Change

- FM-389: `public/v1/src/server.ts`: SIGHUP to the cluster primary replaces its workers one at a time from the release
  `current` points at; each new worker warms up (`src/worker_warmup.ts`: 4 database connections, readiness 3 times)
  before the old one is retired. The primary no longer loads the app; a worker ignores SIGHUP. Start, stop, drain,
  crash restarts and the watchdog are unchanged. `deploy/digitalocean/activate-release.sh` uses the rolling replace
  for `firstmeasure-legacy` when the running primary has it and its `server.js` is the new release's, otherwise it
  restarts as before. New settings at their defaults (`V1_ROLLING_RELEASE_DIR`, `V1_WORKER_WARMUP_CONNECTIONS=4`).
  Also tests, test-map entries, `ExecReload` in the two legacy unit files (documentation only) and DEPLOYMENT.md
  "Compatibility: rolling replace instead of a restart".
- FM-390: `public/measure/internal/editor_scripts/pdf.js`: new `pdfLineTypeLabel(typeId)`; the cover's Roof
  Measurements rows and the layer pages' line totals look the line type name up in the report dictionary instead of
  passing it as a `{value1}`. English output unchanged. Plus `dev/report-localization.test.cjs` (not served).
- Diff from `217f1691`: 14 files. No PHP, environment, flag, nginx, dependency, config-library or database change;
  no data migration or repair. Existing reports pick up FM-390 when their PDF is regenerated (their frozen
  `report_dictionary` already holds the names).

## Checks before release

- At 05:33 UTC every host's `current` was `217f1691` and readiness reported it. The rollback target `217f1691` was
  recorded on FM-390 and FM-389 before anything was activated.
- Each commit's diff equals its plan commit line for line.
- Build on the dev worker (`npm run check` included) took 264 s, from a bundle `22195bf2 ^217f1691`. Archive sha256
  `cdbf0e39fa334ac00cdc7fd5178553fd40fd37a19b0257423ffff633b4e6186f`, verified on fm-agents, compatibility, the
  worker and each web node.
- Fast path (`fastpath.sh decide`, FM-388): exit 3, full procedure. Node files changed: `dist/src/server.js`,
  `dist/src/worker_warmup.js`, `dist/src/config/env.js` (and their sources and tests) and `editor_scripts/pdf.js`,
  which the PDF runtime reads; static: `activate-release.sh` and the two unit files.
- `web_activate.py` keeps every earlier assert, replaces the FM-378/379/380 `pdf.js` hash pin with the FM-390 file's
  (`f462198c…`), and adds FM-390 (`function pdfLineTypeLabel(` once, `pdfLineTypeLabel` 3 times, no
  `pdfLabel("{value1}:"`) and FM-389 (`dist/src/server.js` holds `v1-rolling-replace` and `rolling replace complete`
  once, `dist/src/worker_warmup.js` exists, `activate-release.sh` names `rolling_replace_possible` 3 times). All 45
  file asserts passed on the extracted archive and on the installed trees on compatibility and the worker.
- Baselines: compatibility over the 3 h before: 0 watchdog kills, 3 Node 500s, 0 pool timeouts; 151
  `legacy-action`/min, load 1.1. The worker's 72 h failed `pdf.sync`/`report.delivery` history: none since 01:00.

## Rollout (scripts: fm-agents /srv/agents/work/prod-batch-fm389-390-prodrun-scripts)

- Worker first, at 05:40:58 UTC (no running jobs; 8 slots, production, heartbeat off, outbound email on).
- The signed channel was published from compatibility against `d6c09610…` (`217f1691`'s archive) at 05:41, and the
  six web nodes went one at a time behind the load balancer, 05:41:47–05:54:42 UTC. Each passed every assert and
  returned behind the load balancer on `22195bf2`.
- Compatibility last, at 05:54:56 UTC; the gate opened at once (151 `legacy-action`/min, load 0.5). The activation
  printed `(restart)`, as planned: the running primary from `217f1691` had no rolling replace. In the 20 s after: 0
  Node 500s, 0 HTTP worker exits. Its primary's cwd is the new release and its `server.js` has `v1-rolling-replace`.

## Verification

- `current` is `22195bf2fcdb4d4093c4db8cf04c2cca5419afe0` on all 8 hosts; readiness reports `22195bf2` 10/10 (state
  ready) after the web rollout and after compatibility.
- FM-390: `https://app.1m8.ai/v1/firstmeasure/pdf-runtime/assets/pdf` and `/measure/internal/editor_scripts/pdf.js`
  serve the release file (sha256 `f462198c…`, `pdfLineTypeLabel` 3 times) 8/8 each. The plan's harness
  (`/srv/agents/work/fm-390-harness/render.cjs`, `FROM_DEV=1 BASE=https://app.1m8.ai`) renders a French metric cover
  with production's served runtime: `MESURES DE TOITURE`, `Égout`, `Rive`, `Faîte`, `Raccordement`, `Noue`,
  `Lucarne`, `Solin de mur en amont`, `Solin de mur latéral`. en-US is unchanged (`MEASUREMENT BREAKDOWN`,
  `Eave: 82'`). Before the release production rendered `Eave:`, `Rake:` … (the issue's screenshot).
- FM-389 step 6, the rolling replace on production without a release: at 06:06:50 UTC (155 `legacy-action`/min, load
  1.2) one `systemctl kill --kill-whom=main --signal=SIGHUP firstmeasure-legacy`. The journal shows `rolling replace
  started (v1-rolling-replace): release=22195bf2…, workers=2` and `rolling replace complete: release=22195bf2… in
  32122 ms`; MainPID unchanged (2266335), both workers new. 0 `exited|missed` lines, 0 Node 500s, no nginx 5xx in the
  window; one Node 503, a `/v1/health/ready` probe answered by the retiring worker. Node readiness on :3101 reports
  `22195bf2` afterwards.
- Compatibility watch from 05:54:56 to 06:30 (35 min, the SIGHUP included): 0 watchdog kills, 0 Node 500s, 0 pool
  timeouts; MainPID 2266335 throughout; `legacy-action` 134–213/min, load 0.5–1.6. Worker from 05:40:58 to 06:31: 77
  jobs completed (35 `pdf.sync`, 9 `imagery.process`, 6 `report.delivery`, `report.release`), 0 failed; queued only
  `report.release` scheduled for later (0 due); no "Worker stopping", "browser has been closed" or pool acquisition
  failures. Readiness `22195bf2` 10/10 at 06:31.
- 5xx from 05:56 (compatibility settled) against the 30 min before: web 0–0.08 % per node against 0.08–0.17 %;
  compatibility 0.35 % against 0.63 %, and 0.25 % against 0.47 % from 06:07:30 (after the SIGHUP), all
  `top_view_reroll_proxy.php` (long-standing).

## Compatibility gate

Unchanged by this release (`compat_gate.sh`: legacy-action under 420 a minute, load under 10). Step 6 above is the
first production evidence for the rolling replace; per FM-389's plan, the first release whose compatibility line
says `(rolling replace)` (the next one with an unchanged `server.ts`) is the real test before the gate is lowered.

## Rollback

`/srv/agents/work/prod-batch-fm389-390-prodrun-scripts/rollback/` (the same scripts reversed to `217f1691`; the
channel republishes `217f1691`'s archive from `/var/tmp/firstmeasure-release-217f1691/` on compatibility, against
`cdbf0e39…`). On compatibility `217f1691`'s `activate-release.sh` restarts the service, which is right: older
workers don't understand the retire message.
