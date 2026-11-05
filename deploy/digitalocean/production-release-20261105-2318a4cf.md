# Production release 2318a4cf: window labels on the exterior elevation pages (FM-337), November 5, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. It is production-live `c4ed1581` (release
`a3e3c5bf`, FM-335) plus one commit on `claude/fm-337-prod-release`: `2318a4cf`, the FM-337 plan's `fe53155f`
(lane `5f78cb8d`, canonical `26877e9c`) cherry-picked unchanged. The plan was written on `cad6a00b`; FM-335's retry
shipped in between, so the fix went onto the newer production-live. Its diff is line for line the plan's, and its
`exterior_pdf.js` is byte-identical to the one dev serves (sha256 `d600c4a8…`).

Verified on dev in `measure-internal-20261105051022-d3dcbf95`.

## Change

- `public/measure/internal/editor_scripts/exterior_pdf.js`: `placeLabels` with a set of wall ids (the elevation
  pages) now also labels each visible opening whose wall is in that set, in the Exterior Summary style (white box,
  bold; 5.5 then 4.5 inside the opening, otherwise a leader line), with the Opening Schedule ids (`W23-1`, …).
  `rasterScene` stamps each opening with its parent `wall`. Wall labels, the summary page, tables and schedule are
  unchanged. Each opening is labeled on the one elevation that counts its wall.
- `dev/exterior-pdf-layout.test.cjs`: regression test. Browser asset only: no Node, schema, configuration, dependency
  or data change. `?v=` comes from `fm_editor_asset_version`.

## Checks before release

- `node --test dev/exterior-pdf-layout.test.cjs` on the release commit: 31/31.
- Build on the dev worker (`npm run check` included) in 255 s. Archive sha256
  `e6cd04bbd699df353e91662e9263195c82a6d4177d8497b5fd8888437210500f`, verified on fm-agents, compatibility, the
  worker and each web node.
- Render on production before the release (the plan's `render.cjs` against https://app.1m8.ai, public assets only):
  every elevation had no opening labels.

## Rollout (scripts: fm-agents /srv/agents/work/fm-337-prodrun-scripts)

- Rollback target before activation: `a3e3c5bf348d24772443c3fb0535bd9756492cd2`, every host's `current` at 06:10;
  recorded on FM-337.
- Compatibility at 06:16:30 UTC with `legacy-action` at about 300/min: active, no Node 500s and no worker exits in
  the first 20 s.
- Worker at 06:17:18 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `475d4faa…` (a3e3c5bf's archive); all six web nodes
  downloaded `2318a4cf` / `e6cd04bb` from it.
- Six web nodes one at a time behind the load balancer, 06:18:26–06:31:10 UTC (about 94 s each), each asset-checked
  as in a3e3c5bf's run plus `exterior_pdf.js` served = installed and carrying the FM-337 change.

## After activation

- Public readiness answered `2318a4cf` on 32 of 32 requests; all eight hosts point `current` at it, with the
  expected service active on each.
- `https://app.1m8.ai/measure/internal/editor_scripts/exterior_pdf.js` carries the change.
- Render on production after the release (same model, a dev full-house report with six openings): Back elevation
  `W42-1`; Left `W23-2`, `W23-1`, `W34-1`, `W22-1`; Front and Right none; Opening Schedule all six. Same as dev.
  W31-1 (a door) has no visible pixels in any view and stays unlabeled, as on the summary page.
- Web nodes since 06:18:26: 0–3 5xx of about 3,400–3,650 requests each (0–0.09 %; 0.14–0.20 % in the 30 minutes
  before), all `top_view_reroll_proxy.php` (failing before this release).
- Compatibility since 06:17:10: 8 nginx 5xx of 1,755, all `top_view_reroll_proxy.php`; no Node 5xx.
  Cluster watchdog (`missed its` / `exited (slot`): **0 kills** from 06:16:30 to 06:51 UTC, 20 minutes past the
  last web node; `legacy-action` 280–500/min, load about 1.
- Jobs since the worker activation: 42 completed (imagery.process, pdf.sync, report.delivery, report.release), none
  failed; 107 `report.release` queued from before activation, none due.
- Not checked: a PDF of a production report rendered in a signed-in session (no production login here). A person
  confirms that.

## Rollback

`a3e3c5bf348d24772443c3fb0535bd9756492cd2` is still installed on every host: activate it on compatibility, the worker
and each web node one at a time with `activate-release.sh` (reverse this run's scripts, swapping the ids through
placeholders), and republish the channel with a3e3c5bf's archive against `e6cd04bb…`. Code only; this release writes
no data.
