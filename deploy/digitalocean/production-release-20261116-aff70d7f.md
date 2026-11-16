# Production release aff70d7f: FM-518 (Spanish PDF label overlap), November 16, 2026

Released from fm-agents-1 by the FM-518 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The release is the plan commit as is: `aff70d7f` on `claude/fm-518-espanol-label-overlap-prod`, a direct child of
`production-live` `aaddb540` (the record of release `ddd8086f`, production at the start of the run). Its diff equals dev
lane commit `18c01293` line for line; it was verified on dev in `measure-internal-20261116201740-439a0f28`.

## Change

- Editor PDF code, `public/measure/internal/editor_scripts/pdf.js` (blob `ab019244`, sha256 `af9ba48e…ab0fc`, the same
  file dev serves):
  - The colour key under a layer drawing measures the translated label it prints, not the English one. In portrait it
    starts higher when it needs a third row; in landscape a label wraps inside its column. The gutter key and elevation
    pills measure the translated label too.
  - The cover Roof Measurements boxes use the new `drawPdfLabelValueRow`: the value keeps its width, and a label that
    would reach it wraps onto a second line. The Standard cover closes up its rows when a label wraps; the customer
    cover widens its lines column toward the stats and makes the type smaller only when a label still needs more than
    two lines.
  - English layouts that already fit are unchanged (pixel-identical renders on dev).
- Test (not served): `dev/pdf-translated-key-and-cover.test.cjs`.
- No database, environment, flag, nginx, dependency or config-library change, and no data repair. Existing PDFs keep
  their old layout until they are rendered again. The config library gate (`aff309c4`) is unaffected: the snapshot is
  byte-identical to `ddd8086f`'s.

## Checks before release

- At 20:22 UTC `current` was `ddd8086f` on all 8 hosts, readiness reported it, root disks 22–30 % used. Rollback target
  `ddd8086f` was recorded on FM-518 before anything was built or activated.
- Built `aff70d7f` on the dev worker (`npm run check` and build passed, 267 s). Archive sha256
  `823ac2c728ed619d9843458e459eaab4e60003208d0c074b3ffc8e32b0e07268`.
- `fastpath.sh decide`: exit 3, full procedure (`pdf.js` is read by Node's shared PDF runtime).
- `web_activate.py` keeps every earlier assert. The FM-375 `pdf.js` pin now names `af9ba48e…`, and FM-390, 379, 380 and
  378's `pdf.js` needles still hold. New FM-518 assert: one `drawPdfLabelValueRow` function with 6 uses, and
  `layoutPdfLegend` and `pdfLegendTop`. 78 file asserts pass on the archive and on compat's and the worker's installed
  tree. Control: they fail on `ddd8086f`'s tree at the `pdf.js` pin.
- Control run of the plan's harness (`fm-518-harness/served.test.cjs`, Spanish es-ES wording, rendered with the served
  PDF runtime) against production on `ddd8086f`: tests 1-3 fail, with "Borde inclinado del hastial" running into
  "Alero" and "Babero de encuentro con paramento:" running into "4,66 m".

## Rollout (scripts: fm-agents /srv/agents/work/fm-518-prodrun-scripts)

- Compatibility and the worker installed 20:31–20:33. Worker activated 20:34:25 UTC, with no running jobs.
- Channel published against `ddd8086f`'s archive (`f5615882…`).
- Web nodes one at a time, 20:34:19–20:46:38 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility: the gate waited 43 min (legacy-action 466–746/min, 20:46–21:28 UTC Monday) and opened at 21:29:29.
  Rolling replace at 21:29:30, with 0 Node 500s and 0 exits in the 20 s after.

## Verification

- `current` is `aff70d7f` on all 8 hosts. Readiness reports `aff70d7f` 10/10 (5 nodes answering).
- `https://app.1m8.ai/measure/internal/editor_scripts/pdf.js` and `/v1/firstmeasure/pdf-runtime/assets/pdf`: sha256
  `af9ba48e…ab0fc` 12/12.
- Plan harness against app.1m8.ai after compatibility: tests 1-3 pass (key with no overlap, Standard cover and customer
  cover labels stay left of their values, in both orientations).
- 5xx from 21:31 to 21:47 UTC (after compatibility settled), excluding health probes:
  - web nodes: 0.04–0.13 % (8–22 of 17–18k each), against 0.05–0.08 % in the 30 minutes before; every one is
    `/measure/internal/top_view_reroll_proxy.php` (compatibility PHP, which errors at this rate on every release).
  - compatibility: 0.70 % (78 of 11,184), against 0.63 % before; all `top_view_reroll_proxy.php`.
- Compatibility, 21:29:30–21:47: 0 watchdog kills, 0 pool timeouts, one MainPID throughout (legacy-action
  390–550/min, load under 4). 3 Node 500s: two "Fastify has already been closed" from the old processes as they shut
  down, and one data-agent permission refusal from a caller at 21:30:46. That refusal came from `data_agent.js`, which
  is byte-identical in both releases (nothing under `public/v1` changed).
- Worker 20:34:25–21:47: 1,008 jobs completed (636 `pdf.sync`, 143 `report.delivery`, 160 `imagery.process`, 69
  `report.release`), 0 failed, and no "Worker stopping", browser-closed, pool-timeout or heartbeat errors. The queued
  `report.release` jobs are scheduled and not yet due.

## Rollback

`/srv/agents/work/fm-518-prodrun-scripts/rollback/`: `release.sh worker`, `publish` (republishes `ddd8086f`'s archive),
`web_rollout.sh` (FM-406's forward asserts with base `aff70d7f`), `release.sh compat`. Rolling back brings back the
overlapping Spanish labels in newly rendered PDFs. No data is involved either way.
