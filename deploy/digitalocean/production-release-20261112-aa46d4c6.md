# Production release aa46d4c6: Holiday Lights by side of the house (FM-375), November 12, 2026

Jack approved FM-375 for production on 2026-11-10 ("Ok looks good, push it to prod now"); it was never run. FM-400 asked
again ("make sure that push got fully completed") and then "go ahead and push this to prod". Released from fm-agents-1
by the FM-400 runs. Branch `claude/fm-375-prod-20261112` is the six FM-375 commits from `claude/fm-375-prod`
cherry-picked onto `production-live` `3c51e1c8` (the record of `6166ea12`), plus one cache-busting commit:

| Commit | Change |
| --- | --- |
| `103d3b52`, `180c8a4d`, `a20a8ded` | 3D Holiday Lights view: lights by side and roofline, run lengths, sides switch off (`holiday-lights.js`, `roof-viewer.js` ?v, test) |
| `3ae9d6b4`, `ce4f3652`, `49ad4fe3` | Report Holiday Lights page (editor `pdf.js`, Holiday Lights section only) and its dev test |
| `aa46d4c6` | `?v=` bumps for `roof-viewer.js`, `holiday-lights.js`, `project-widgets.js` in the apps manifest and project-widgets |

No Node server code, PHP, environment, flag, nginx, dependency, config-library or database change; no data repair.

## Rollout (scripts: fm-agents /srv/agents/work/fm-375-prodrun-scripts)

- Rollback target `6166ea12` on every host. Build on the dev worker; archive sha256
  `8f21a705176553c34b39b69bb2a852e781826b3b3b0e855db48189a3ae54d1fd`. `fastpath.sh decide`: full procedure (editor
  `pdf.js` and `public/libraries` are read by Node).
- Worker 16:48:46 UTC (no running jobs). Channel published against `6166ea12`'s archive. Web nodes one at a time behind
  the load balancer, 16:50–17:02:55 UTC, each ready with its assets matching.
- The run that did this ended at 16:59, before compatibility, so production was split (worker + web on `aa46d4c6`,
  compat on `6166ea12`) from 17:02 until 23:53 UTC. Other production runs held off (agent channel, FM-401).
- Compatibility at 23:53:24 UTC through the gate (98 `legacy-action`/min, load 5.0): rolling replace, in the 20 s after
  0 Node 500s and 0 HTTP worker exits.

## Verification

- Readiness reports `aa46d4c6` 10/10; `current` is `aa46d4c6` on compat, worker and the web nodes.
- app.1m8.ai serves `roof-viewer.js` loading `holiday-lights.js?v=20261110-side-switches`, `holiday-lights.js` with
  `groupHolidayLights`, and `/measure/internal/editor_scripts/pdf.js` with `PDF_HOLIDAY_SIDE_COLORS`.
- Worker since activation: 5118 jobs completed, no pool timeouts or browser-closed errors. Two `report.delivery` jobs
  failed with "The customer report email failed to send." (22:38, 22:54 UTC) while 753 others delivered: email,
  not this change.
