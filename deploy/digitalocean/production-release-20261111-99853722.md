# Production release 99853722: rush timer restarts when a rejected project is reordered (FM-386), November 11, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan branch
`claude/fm-386-timer-carries-over-prod` was cut from production-live `9bba4cc9` (the record of release `99446050`), so
the release is its tip as is:

| Commit | Change | Same diff as (verified on dev) |
| --- | --- | --- |
| `c6b9d59b` | reordering a rejected project clears the first claim's start (platform) | `dd59a198`, in `platform-20261111032247-ed2b7e27` |
| `99853722` | rush timer restarts when a rejected project is reordered (editor and staff portal) | lane `59c69b78`, in `measure-internal-20261111032358-3431b47d` |

## Change

- `public/v1/firstmeasure/api.ts` (web and worker Node): `reopenRejectedProjectForReorder` also sets
  `timestamps.started_at: null`, so the reordered project's first new claim sets it again (release-to-queue already
  did this).
- `public/measure/internal/editor.php` (compatibility): the editor's rush timer (`firstMeasureFindClaimStartedAt`)
  treats the `reordered_rejected_project` history event as a reset point, like `project_reopened_for_edits`.
- `public/measure/internal/portal_scripts/{projects,earnings,payroll,stats}.js` (compatibility): the same reset rule
  in the staff portal's project timer, earnings and payroll speed band, and stats.
- Not served: `public/v1/tests/firstmeasure-reorder-timer.test.ts`, `dev/claim-timer-reorder.test.cjs`.
- Diff from `99446050`: 8 files, +166/−5. No schema, environment, database, flag, nginx, dependency, language-catalog
  or config-library change, and no data repair: projects reordered before this release show and pay correctly
  because the reset point is read from their existing history.

## Checks before release

- At 03:28 UTC every host's `current` was `99446050` and readiness reported it 10/10. The rollback target `99446050`
  was recorded on FM-386 before anything was activated.
- The plan commits' diffs equal the dev commits (`c6b9d59b` = `dd59a198`; `99853722` = lane `59c69b78`).
- Plan tests on `99853722`: `dev/claim-timer-reorder.test.cjs` 7/7; `firstmeasure-reorder-timer.test.ts` and
  `firstmeasure-terminal-state-recovery.test.ts` 9/9.
- Build on the dev worker (`npm run check` included) took 249 s, from a bundle `99853722 ^99446050`. Archive sha256
  `b1015bb629a989931c5e52a5460a272080f3c5712df2343a410010e5e62aeca3`, verified on fm-agents, compatibility, the
  worker and each web node. The five served files in the archive are byte-identical to the commit.
- `web_activate.py` keeps every earlier assert and adds FM-386: the `api.js` comment "The reorder's first claim starts
  the drafting timer again (FM-386)." once, `event !== 'reordered_rejected_project'` once in `editor.php`, and
  `ev.event === 'reordered_rejected_project'` once in each of the four portal scripts. All 42 file asserts passed on
  the extracted archive and on the installed trees on compatibility and the worker; the FM-386 ones fail on
  `99446050`'s tree (control).
- Control on production before the release: the plan's `dev/claim-timer-reorder.test.cjs` run on compatibility's
  `editor.php` and the portal scripts served by app.1m8.ai failed 5 of 7.
- Worker baseline (72 h, failed `pdf.sync`/`report.delivery`): "browser has been closed" 10 + 2 (all before FM-380's
  runtime fix), "superseded before delivery" 3, "customer report email failed to send" 2.

## Rollout (scripts: fm-agents /srv/agents/work/fm-386-prodrun-scripts)

- Worker first, at 03:37:18 UTC (no running jobs; 8 slots, production, heartbeat off, outbound email on).
- The signed channel was published from compatibility against `e41a5a63…` (`99446050`'s archive), and the six web
  nodes went one at a time behind the load balancer, 03:38:19–03:51:37 UTC. Each passed every assert and returned
  behind the load balancer on `99853722`.
- Compatibility went last (it serves `editor.php` and the portal scripts), at 04:09:40 UTC through the gate: it waited
  18 min at 618–1,005 `legacy-action`/min and opened at 406, load 0.9. In the 20 s after: 0 HTTP worker exits; the
  only Node 500s were 2 at 04:09:41 ("Fastify has already been closed": the restart).

## Verification

- `current` is `998537228f2bee0ec83244b68c75cfa22822b3b5` on all 8 hosts; readiness reports `99853722` 10/10 (state
  ready) after the web rollout and after compatibility.
- Compatibility's `current/public/measure/internal/editor.php` has `event !== 'reordered_rejected_project'`, and
  app.1m8.ai serves each of the four portal scripts with `reordered_rejected_project` (3/3 requests each). The served
  files are byte-identical to the archive.
- The plan's `dev/claim-timer-reorder.test.cjs` on production's served files: 7/7 (5 failed before).
- Read-only on the worker: the editor timer rule run on project `61ddd744…`'s stored manifest starts at
  2026-11-10T21:15:22.824Z with `99853722`'s `editor.php` and at 21:05:36.711Z with `99446050`'s. That project's stored
  `timestamps.started_at` stays 21:05:36.711Z (no data change); display and pay read the history.
- Worker since activation (03:37:18 to 04:12 UTC): 132 jobs completed (`pdf.sync` 58, `report.release` 41,
  `imagery.process` 20, `report.delivery` 13), 0 failed. The queue held only `report.release` jobs scheduled for
  later (0 due). No "Worker stopping", "browser has been closed" or pool acquisition failures in the worker journal;
  the 72 h failed-job history is unchanged.
- Compatibility watch from 04:09:40 to 04:28 (18 min): 0 watchdog kills, 0 pool timeouts, no Node 500s after the
  restart second; `legacy-action` 419–953/min, load 0.8–1.4. At 04:28 the worker had 186 jobs completed since
  activation and 0 failed; readiness `99853722` 10/10.
- 5xx from 04:11 (compatibility settled) against the 30 min before: web 0–0.12 % per node against 0.14–0.20 %;
  compatibility 0.35 % against 0.49 %, all `top_view_reroll_proxy.php` (long-standing).

## Rollback

`/srv/agents/work/fm-386-prodrun-scripts/rollback/` (the same scripts reversed to `99446050`; the channel
republishes `99446050`'s archive from `/var/tmp/firstmeasure-release-99446050/` on compatibility, against
`b1015bb6…`). Rolling back restores the old timer start (first claim before a reorder) in the editor and staff portal
and stops clearing `started_at` on reorder. Nothing to undo in data or configuration.
