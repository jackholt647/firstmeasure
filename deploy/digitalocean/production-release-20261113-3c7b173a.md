# Production release 3c7b173a: Holiday Lights toggle, Reports › Holiday Lights tab, note as a tooltip (FM-400), November 13, 2026

Jack on FM-400: "go ahead and push this to prod". Released from fm-agents-1 by the FM-400 run, right after it finished the
split FM-375 release `aa46d4c6` (record `abf7462c`). Branch `claude/fm-400-prod` is one commit on `production-live`
`abf7462c`:

| Commit | Change | Same change as (verified on dev) |
| --- | --- | --- |
| `3c7b173a` | FM-400: Holiday Lights toggle on the 3D model, Reports › Holiday Lights tab back, note as a tooltip | `1f296d58` in `platform-20261112164622-7321ea86` |

## Change

- `measurements/holiday-lights.js` and `roof-viewer.js`: byte-identical to dev. The 3D model gets a lightbulb toggle left of
  Expand (no Holiday Lights key tab, column title or "Show holiday lights" button); small, it shows the night roof fitted to
  the stage with the total and "Open Holiday Lights"; side by side, the counts take the left column. The measuring note is
  a tooltip on an info button by the Holiday Lights title. The lights view fits the whole roof to the stage.
- `measurements/project.js`: Reports › Holiday Lights tab restored (removed on 11/03 by `3688a52d`), and the widget's
  "Open Holiday Lights" opens it. Production's copy is older than canonical's; the cherry-pick applied the same diff.
- `?v=` bumps in `firstmate-apps-manifest.js` (roof-viewer, holiday-lights, measurements/project, project-widgets) and
  `project-widgets.js` (roof-viewer). Plus `public/v1/tests/measurements-holiday-lights-browser.test.mjs` (not served).
- No Node server code, PHP, environment, flag, nginx, dependency, config-library or database change; no data repair.

## Checks before release

- Every host's `current` was `aa46d4c6`; rollback target `aa46d4c6` recorded on FM-400 before activating.
- Archive sha256 `8d6c5776eb47f43d154ed4a7f3cff9b0acd7570d578a5ada210f9c4031b695ec`. `fastpath.sh decide`: full
  procedure (server and dependencies identical; `public/libraries` files are Node readers).
- `web_activate.py` keeps the earlier asserts and replaces FM-375's with FM-400's: the four files' sha256 equal to the
  plan commit and to what the node serves, and the manifest's four `20261112-lights-toggle` bumps. File asserts: 49 pass on
  the extracted archive. On the plan tree, `measurements-holiday-lights-browser`, `-roof-viewer-browser` and
  `-roof-viewer-report-rounding` pass 10/10.

## Rollout (scripts: fm-agents /srv/agents/work/fm-400-prodrun-scripts)

- Worker 00:15:13 UTC (no running jobs). Channel published against `aa46d4c6`'s archive.
- Web nodes one at a time, 00:16–00:30:23 UTC. The first node (64.23.240.81) activated and was restored behind the load
  balancer, but the script stopped on its FM-400 assert: the expected count of `fm-hl-info` was wrong (8 from `grep -c`,
  which counts lines; the file has 11). The file itself matched the plan hash and the served bytes. The count was fixed,
  the FM-400 asserts were run by hand on that node (pass), and the rollout continued with the other five, each passing
  every assert.
- Compatibility at 00:31:59 UTC through the gate: rolling replace, 0 Node 500s and 0 exits in the 20 s after.

## Verification

- `current` is `3c7b173a` on all 8 hosts; readiness reports `3c7b173a` 10/10.
- app.1m8.ai serves `holiday-lights.js` with sha256 `8048b7c4…` (6/6), `roof-viewer.js` loading
  `holiday-lights.js?v=20261112-lights-toggle`, `measurements/project.js` with the Holiday Lights pane, and the manifest
  bumps. The 3D widget (tray size and side by side) and the Reports view rendered from production's served files show the
  toggle, the compact total and the tooltip, 263 ft on the 15122 Diekman Ct model.
- Worker since 00:15: 155 jobs completed, 0 failed. Compat since 00:31:59: 10 Node 500s (`/v1/internal/legacy-action`
  and unmatched) against 28 in the 12 minutes before, and one SIGABRT worker exit (5 in the 12 hours before): baseline.
