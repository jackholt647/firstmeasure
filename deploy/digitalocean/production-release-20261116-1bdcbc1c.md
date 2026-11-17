# Production release 1bdcbc1c: FM-520 (dormer hole area deduction), November 16, 2026

Released from fm-agents-1 by the FM-520 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The release is the plan commit as is: `1bdcbc1c` on `claude/fm-520-dormer-area-deduction-prod`, a direct child of
release `aff70d7f` (FM-518, production at the start of the run). Its patch equals dev lane commit `47febf24` (patch-id
`925e8263`); it was verified on dev in `measure-internal-20261116214157-122f881d`.

## Change

- Editor PDF code, `public/measure/internal/editor_scripts/pdf.js` (sha256 `41161cd6…2effc`, the same file dev serves):
  new `getPdfFaceNetAreaPx(face)`, a facet's outline less each distinct hole cut in it, never below zero. It is used by
  `recalculateReportMaterials` (facet labels, Total Squares, footprint/attic area), the Layer N pages,
  `buildDefaultDiagramLabelsInternal` and `collectPdfFaceDebugRows`. Before, every one of these used the outline only,
  so a facet under a dormer (or with a chimney or skylight hole) printed its full area and the totals counted the hole.
- `public/measure/internal/editor_scripts/report.js` (`a9121687…bbc4`): the editor's default diagram labels use it too.
- `public/measure/internal/editor_scripts/measurements.js` (`326e26ad…8304`): `calculateMaterials` subtracts each hole's
  absolute area, so a hole wound the other way no longer adds.
- Test (not served): `dev/pdf-dormer-hole-area.test.cjs`.
- No database, environment, flag, nginx, dependency or config-library change, and no data repair. PDFs already made
  keep their old figures until a report is rendered again.

## Checks before release

- At 21:50 UTC `current` was `aff70d7f` on all 8 hosts, readiness reported it 10/10, root disks 23–30 % used. Rollback
  target `aff70d7f` was recorded on FM-520 before anything was built or activated.
- Built `1bdcbc1c` on the dev worker (`npm run check` and build passed, 261 s). Archive sha256
  `ccc75c5a484cef217d9ea040f28068fd319e2ac4b6a7ae894daf16d0d4deff49`.
- `fastpath.sh decide`: exit 3, full procedure (`pdf.js` is read by Node's shared PDF runtime; `report.js` and
  `measurements.js` are static).
- `web_activate.py` keeps every earlier assert. The FM-375/FM-518 `pdf.js` pin and the FM-357 `report.js` pin now name
  this release's files. New FM-520 asserts: one `getPdfFaceNetAreaPx` function, 7 occurrences, used once in
  `report.js`, and the `measurements.js` hash with both hole-subtraction blocks. 80 file asserts pass on the archive and
  on compat's and the worker's installed tree. Control: they fail on `aff70d7f`'s tree.
- Control run of the plan's harness against production on `aff70d7f`: `fm-520-harness/served.test.cjs` tests 1-3 fail
  ("Total Squares (Net): 48.14" instead of 47.17), and a real production report's geometry (7 facets, holes in 3; a
  read-only copy) printed facets 902 / 902 / 457 sq ft and 27.35 squares.

## Rollout (scripts: fm-agents /srv/agents/work/fm-520-prodrun-scripts)

- Compatibility and the worker installed 21:58–21:59. Worker activated 22:00:44 UTC, with no running jobs.
- Channel published against `aff70d7f`'s archive (`823ac2c7…`).
- Web nodes one at a time, 22:01:27–22:14:07 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility: the gate waited 94 min (legacy-action 446–928/min, 22:14–23:47 UTC Monday) and opened at 23:48:14
  at 255/min. Rolling replace at 23:48:15, with 0 Node 500s and 0 exits in the 20 s after.

## Verification

- `current` is `1bdcbc1c` on all 8 hosts. Readiness reports `1bdcbc1c` 10/10.
- `https://app.1m8.ai/measure/internal/editor_scripts/pdf.js` and `/v1/firstmeasure/pdf-runtime/assets/pdf`: sha256
  `41161cd6…2effc`, 7 `getPdfFaceNetAreaPx`, 6/6 each; served `report.js` and `measurements.js` equal the commit 3/3.
  The worker's installed `pdf.js` is the same file.
- Plan harness against app.1m8.ai, after the web rollout and again after compatibility: tests 1-3 pass. The real
  report's geometry now prints 886 / 886 / 449 sq ft and 26.95 squares on production, the same as dev, and agrees with
  the editor's own stored total (26.93).
- 5xx from 23:49:30 to 23:59 UTC (after compatibility settled), excluding health probes:
  - web nodes: 0.07–0.13 % (5–9 of 6.9–7.6k each), against 0.06–0.07 % in the 30 minutes before. They are
    `/measure/internal/top_view_reroll_proxy.php` (compatibility PHP, which errors at this rate on every release) and
    15 `/v1/internal/legacy-action`, all at 23:50:30, the moment of the one watchdog kill below.
  - compatibility: 0.55 % (22 of 4,003), against 0.93 % before; all `top_view_reroll_proxy.php`.
- Compatibility, 23:48:15–00:05: one watchdog kill (HTTP worker slot 1 at 23:50:30, two minutes after the rolling
  replace, at 545/min legacy-action), then none; 0 Node 500s, 0 pool timeouts, one MainPID throughout (legacy-action
  376–545/min, load under 3). The 26 h before had 10 kills, and fresh workers after a rolling replace have had 1-3 with
  identical server code before. No server code changed in this release (`fastpath.sh decide`: server same).
- Worker 22:00:44–23:51: 1,321 jobs completed (789 `pdf.sync`, 203 `report.delivery`, 167 `imagery.process`, 162
  `report.release`), 1 failed, and no "Worker stopping", browser-closed, pool-timeout or heartbeat errors. The failure
  is a `report.delivery` whose one recipient Postmark refuses as inactive after a hard bounce (406, five attempts,
  22:38–22:41), not the release; the 72 h before had 2 such failures. Queued `report.release` jobs are scheduled and not
  yet due.

## Rollback

`/srv/agents/work/fm-520-prodrun-scripts/rollback/`: `release.sh worker`, `publish` (republishes `aff70d7f`'s archive),
`web_rollout.sh` (FM-518's forward asserts with base `1bdcbc1c`), `release.sh compat`. Rolling back brings back facet
areas that include the holes cut in them in newly rendered PDFs. No data is involved either way.
