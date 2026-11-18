# Production release 4fb31733: FM-402 (elevation background shading), November 17, 2026

Released from fm-agents-1 by the FM-402 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The release is the plan commit as is: `4fb31733` on `claude/fm-402-elevation-background-shading-prod`, a direct child of
production-live `f6adda10` (record of release `1bdcbc1c`, FM-520, production at the start of the run). Its patch equals
dev lane commit `2ae7ed40`; it was verified on dev in `measure-internal-20261117014532-df6e45aa`.

## Change

- Editor PDF code, `public/measure/internal/editor_scripts/exterior_pdf.js` (sha256 `4d2b237c…6b89`, the same file dev
  serves): new `farSide(face, camera)`, and `paintScene(scene, muted, background)` takes a predicate that feeds the
  existing context dimming. On Full Exterior elevations a face that is not counted on that elevation and whose saved
  outward normal points away from the viewer (a wall on the far side of the house, seen through an opening) is drawn
  like the house context on the Wall Dimensions pages: light grey, light-grey edges, no dividers or labels, with its
  openings and trim dimmed too. Before, those faces kept dark edges and full-colour windows and doors. It is a repaint
  only: which elevation counts each wall and the table totals do not change.
- Tests and docs (not served): `dev/exterior-pdf-layout.test.cjs` (FM-402 case), `dev/EXTERIOR_REPORT.md`.
- No database, environment, flag, nginx, dependency or config-library change, and no data repair. PDFs already made
  keep their old drawing until a report is rendered again.

## Checks before release

- At 01:49 UTC `current` was `1bdcbc1c` on all 8 hosts, readiness reported it, root disks had 74 GB+ free. Rollback
  target `1bdcbc1c` was recorded on FM-402 before anything was built or activated.
- Built `4fb31733` on the dev worker (257 s). Archive sha256
  `a87e8de83608709bbe30870a7b197761c63af9cbb19f8a1d48935eede30262c9`.
- `fastpath.sh decide`: full procedure. Server, dependencies and configuration are the same; the one Node-read file
  changed is `exterior_pdf.js` (Node's shared PDF runtime loads it).
- Plan tests in a worktree of `4fb31733`: `dev/exterior-pdf-layout.test.cjs`, `dev/exterior-report.test.cjs`,
  `dev/sticker-divisions.test.cjs` 47/47.
- `web_activate.py` keeps every earlier assert. The FM-357 `exterior_pdf.js` pin now names this release's file; new
  FM-402 assert: one `function farSide(`, one `farSide(face,scene.camera)`, the three-argument `paintScene`. 81 file
  asserts pass on the archive. The archive's `exterior_pdf.js` is byte-identical to the commit, and so are compat's and
  the worker's installed copies.
- Control run of the plan's harness (`/tmp/fm402/render.cjs`, the reported house rendered with production's served
  scripts, a read-only copy) on `1bdcbc1c`: the Left elevation shows the far-side door and window in colour.

## Rollout (scripts: fm-agents /srv/agents/work/fm-402-prodrun-scripts)

- Compatibility and the worker installed at 01:56. Worker activated 01:58:13 UTC, with no running jobs.
- Channel published against `1bdcbc1c`'s archive (`ccc75c5a…`).
- Web nodes one at a time, 01:59:29–02:12:45 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility: the gate waited 30 min (legacy-action 471–704/min, 02:12–02:42 UTC Tuesday) and opened at 02:43:00.
  Rolling replace at 02:43:02, with 0 Node 500s and 0 exits in the 20 s after.

## Verification

- `current` is `4fb31733` on all 8 hosts. Readiness reports `4fb31733` 10/10.
- `https://app.1m8.ai/measure/internal/editor_scripts/exterior_pdf.js`: sha256 `4d2b237c…6b89` 12/12, equal to
  `git show 4fb31733:…`.
- Plan harness against app.1m8.ai after compatibility: the Left elevation shows the far-side wall, door and window in
  the context grey; Back and Right are pixel-identical to the control, only the Front (its small far-side sliver) and
  the Left changed, and the tables (Left: 8 faces, 429.9 ft²) are unchanged. The read-only model and state files and
  the rendered PDFs were deleted afterwards.
- 5xx from 02:44:30 to 03:03 UTC (after compatibility settled), excluding health probes:
  - web nodes: 0.01–0.04 % (1–4 of ~11.4k each), against 0.02–0.05 % in the 30 minutes before. They are
    `/measure/internal/top_view_reroll_proxy.php` (compatibility PHP, which errors at this rate on every release) and
    2 POSTs to `/v1/public/firstmeasure/reports` whose callers sent invalid JSON (Fastify body parse error; the same
    route logged 42 and 21 such 500s on Nov 12 and 13, and no server code changed).
  - compatibility: 0.20 % (11 of 5,488), against 0.61 % before; all `top_view_reroll_proxy.php`.
- Compatibility, 02:43:02–03:01: 0 watchdog kills, 0 Node 500s, 0 pool timeouts, one MainPID throughout (legacy-action
  309–480/min, load under 2).
- Worker 01:58:13–03:03: 402 jobs completed (186 `pdf.sync`, 47 `report.delivery`, 42 `imagery.process`, 127
  `report.release`), 0 failed, and no "Worker stopping", browser-closed, pool-timeout or heartbeat errors. The 72 h
  before had 10 `pdf.sync`/`report.delivery` failures (email refusals, superseded revisions, one fetch error). Queued
  `report.release` jobs are scheduled and not yet due.

## Rollback

`/srv/agents/work/fm-402-prodrun-scripts/rollback/`: `release.sh worker`, `publish` (republishes `1bdcbc1c`'s archive),
`web_rollout.sh` (FM-520's forward asserts with base `4fb31733`), `release.sh compat`. Rolling back brings back
full-strength far-side walls, windows and doors on newly rendered elevations. No data is involved either way.
