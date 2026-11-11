# Production release 06cee255: Summary page layout fixes (FM-378, FM-379, FM-380) and the shared PDF runtime's chunked hand-off, November 11, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. This is the FM-378/379/380 batch `dd3489bc`,
rolled back on November 10 (see "Background"), plus the fix for the failure that rolled it back. The plan branch
`claude/fm-380-measurement-summary-typography-prod2` was already four commits on production-live `8f2922ae` (the
record of release `5e90c26a`), so it was released as is:

| Issue | Plan commit | Verified on dev in |
| --- | --- | --- |
| FM-379 waste table overflow | `cb727de2` (editor `pdf.js`) | measure-internal lane releases for FM-379 |
| FM-380 measurement summary typography | `a1ac2e77` (editor `pdf.js`; cherry-pick of lane `ba6ddacc`) | `measure-internal-20261110194130-512631c1` |
| FM-378 surface area overlap | `dd3489bc` (editor `pdf.js`) | measure-internal lane releases for FM-378 |
| FM-380 shared PDF runtime | `06cee255` (cherry-pick of canonical `cdca59c4`, identical `public/v1` diff) | `platform-20261111000439-a90f41be` |

Commits 1–3 are byte-for-byte release `dd3489bc`, whose own diffs match their plan commits.

## Background

Release `dd3489bc` (the first three commits) was live on the worker and web from 20:48 to 22:29 UTC on November 10
and was rolled back for 7 failed `pdf.sync` jobs, `Shared PDF runtime failed: page.evaluate: Target page, context or
browser has been closed`. Those failures were older than the batch: they hit production 1–11 times a day from
October 28, one large project at a time, and continued on `5e90c26a` after the rollback (2 more at 23:xx and 2 at
00:xx UTC on November 11). The cause was Chrome closing its DevTools connection, and the browser with it, on any
message over 100 MB: the runtime passed the whole snapshot (65–100 MB of JSON when it holds photos) as one
`page.evaluate` argument.

## Change

- `public/measure/internal/editor_scripts/pdf.js` (sha256 `5b9e7ed5…` →
  `6f064017e7108b8a52ff01d91b15e8d686ca1c2596e4e768de7489b0b0bc4028`, as in `dd3489bc`): FM-379 sizes the Summary
  page's pitch and waste label column to the longest label (`pdfSummaryLabelColumn`); FM-380 lays out the totals card
  in one type size, wrapping long labels onto two lines instead of shrinking each one (`layoutPdfStatCard`,
  `wrapPdfStatLabel`); FM-378 lays out the Layer Details totals from their measured widths (`layoutLayerTotals`).
  Used by the editor's PDF button and by the worker's shared PDF runtime (`/v1/firstmeasure/pdf-runtime/assets/pdf`).
- `public/v1/firstmeasure/pdf_runtime.ts`: `renderSharedProjectPdfs` sends the snapshot to the page as JSON text in
  4M-character pieces (`sendJsonToPage`) and reads each PDF back the same way (`readStringFromPage`). Used by the
  worker's `pdf.sync` and `report.delivery` and the web's PDF batch route. Rendering is otherwise unchanged.
- Not served: `dev/*.test.cjs`, `public/v1/tests/pdf-runtime-transfer.test.ts`, AGENTS.md ("Shared PDF runtime"),
  `tools/dev-push/lanes/platform/test-map.mjs`.
- No API, schema, PHP, environment, database, migration, flag, nginx, dependency, language-catalog or config-library
  change. No data repair: PDFs already stored are not re-rendered, and projects whose server PDFs failed before get
  them the next time their report is saved.

## Checks before release

- At 00:11 UTC every host's `current` was `5e90c26a`; readiness reported `5e90c26a` 10/10. The rollback target was
  recorded on FM-380 before anything was activated.
- Worker baseline (72 h): `pdf.sync` "browser has been closed" failures at 21:00 (4), 22:00 (3), 23:00 (2) and 00:00
  (1) UTC, plus 2 `report.delivery` with the same error, all on `5e90c26a` after the rollback or during `dd3489bc`;
  "The reviewed PDF revision was superseded before delivery" 3 (re-saves) and "The customer report email failed to
  send" 2.
- Build on the dev worker (`npm run check` included) took 284 s, from a bundle `06cee255 ^dd3489bc`. Archive
  sha256 `2fd8d7852df6e840e8c86491c84553be3e8af2c6244d38931f1f12b78e6d93bd`, verified on fm-agents, compatibility,
  the worker and each web node.
- `web_activate.py` keeps every earlier assert, and adds an FM-380 runtime assert: `dist/firstmeasure/pdf_runtime.js`
  has `function sendJsonToPage(`, `function readStringFromPage(` and `sendJsonToPage(page, request.snapshot)` once
  each. All 37 file asserts passed on the extracted archive and on the installed trees on compatibility and the worker.
- Render proof on the production worker with the installed, not yet active, release (read-only: the failed job's own
  payload, rendered in memory, no upload or job write): project `a7864f22` (99.9M-character snapshot) rendered both
  PDFs in 22 s (2.48 MB and 2.28 MB); `b3e48eea` (77.4M characters) in 18 s (1.64 MB and 1.55 MB). Both fail on
  `5e90c26a` with "browser has been closed".

## Rollout (scripts: fm-agents /srv/agents/work/fm-380-prodrun-scripts)

- Worker first: activation waited 18 min for running `imagery.process` jobs and went live at 00:38:55 UTC (8 slots,
  production, heartbeat off, outbound email on). The render proof was repeated on the active release with the same
  results.
- While the worker waited, the signed channel was published from compatibility against `6b1163cc…` (`5e90c26a`'s
  archive), and the six web nodes went one at a time behind the load balancer, 00:34:09–00:47:22 UTC. Each passed
  every assert and returned behind the load balancer on `06cee255`. (DEPLOYMENT.md allows web before the worker.)
- Compatibility went last, at 01:18:54 UTC, through the gate: it waited 31 min at 437–1,141 `legacy-action`/min and
  opened at 299, load 3.4. In the 20 s after: 0 HTTP worker exits; the only Node 500s were 7 "Fastify has already been
  closed" requests at 01:18:54 (the restart).

## Verification

- `current` is `06cee25578aa0ef29aa144492dba3b20ff095d9c` on all 8 hosts; readiness reports `06cee255` 10/10.
- app.1m8.ai serves `pdf.js` with sha256 `6f064017…` (with `function layoutPdfStatCard(` once) at both
  `/measure/internal/editor_scripts/pdf.js` and `/v1/firstmeasure/pdf-runtime/assets/pdf`, 6/6 each.
- FM-380 card proof (`fm-380-prodrun-harness/render.cjs`, synthetic fixture, production's served runtime): every
  label and value on the French totals card prints at 9.00 pt, with "Surface de toiture", "Solin de mur en amont" and
  the chimney flashings wrapped onto two lines. Before the release (November 10 control) those labels printed at
  7.50 pt.
- Worker since activation (00:38:55 to 01:55 UTC): 649 jobs completed, 0 failed, among them every `pdf.sync` and
  `report.delivery`. No "browser has been closed" in the worker journal, no "Worker stopping", no pool acquisition
  failures. The 00:00 hour's last two "browser has been closed" failures came before the worker switched.
- Compatibility watch to 01:55: a burst from 01:21 to 01:25, two minutes after its restart. Its DB pool was exhausted
  (236 "timeout exceeded when trying to connect", 203 Node 500s) and the watchdog killed 3 HTTP workers. One more
  kill came at 01:35. There were no pool timeouts or Node 500s after 01:25, and no kills after 01:35. The burst was on
  `/v1/internal/legacy-action`, `/v1/internal/me`, `/v1/internal/users` and QA status, which this release doesn't
  change. Compatibility ran no PDF rendering in that window. It matches the pool bursts after earlier compatibility
  restarts (78 in one minute at 17:07 on November 9). In the 48 h before, compatibility logged 0–2 kills an hour.
- 5xx after compatibility settled (01:26 to ~01:55): web 0.05–0.10 % per node, against 0.43–0.48 % in the 30 min
  before (a window that includes the burst). Every web 5xx since is `top_view_reroll_proxy.php` or a few
  `legacy-action`. Compatibility 0.68 % against 0.81 %, all but two `top_view_reroll_proxy.php` (long-standing).

## Rollback

`/srv/agents/work/fm-380-prodrun-scripts/rollback/` (the same scripts reversed to `5e90c26a`; the channel
republishes `5e90c26a`'s archive from `/var/tmp/firstmeasure-release-5e90c26a/` on compatibility, against
`2fd8d785…`). Rolling back restores the old runtime, so projects with large photo snapshots fail to render again, and
the old Summary page layouts. Nothing to undo in data or configuration.
