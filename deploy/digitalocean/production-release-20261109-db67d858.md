# Production release db67d858: exterior report walls with no base face out of the house (FM-355), November 9, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan commit was already a child of
production-live `2b9d4e12` (release `93c7a2fd` plus the FM-353 record and the FM-351 configuration record), so it was
released as is, with no cherry-pick:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-355 sliding door PDF | `db67d858` (= lane `cbc8d0e3`, canonical `54f037d6`) on `claude/fm-355-sliding-door-pdf-prod` | `db67d858` | `measure-internal-20261109221255-a51c427b` |

## Change

- `public/measure/internal/editor_scripts/exterior_report_model.js` (measure editor browser code, served by
  compatibility): `build()` orients a wall the house base does not orient (there is no base, or the wall is above it)
  from the other walls. A level ray from a point on the wall that heads into the house crosses an odd number of
  walls; it votes over the wall's openings, quarter points and centre. Undecided, the wall faces away from the base's
  centre, or the walls' centre when there is no base. Before, such a wall kept its face winding (no base) or faced
  away from the base centre. Walls the base orients, chimney faces and curved walls are unchanged.
- Not served: `dev/exterior-report.test.cjs` (new FM-355 case: a no-base house with inward-wound front and right
  walls and a gap under a back sliding door).
- Measure editor browser file only. No Node, PHP, environment, database, migration, flag, nginx, dependency or data
  change; no data repair. The editor's `?v=` is content-based. A saved report changes only when someone presses
  **Regenerate** (the report model is rebuilt from the walls then); wall ids may renumber, because walls sort by
  their compass side.

## Checks before release

- The +/- lines of `db67d858` equal lane `cbc8d0e3` line for line.
- Control: on the FM-355 order (`exteriors_e734a21ea05e7fc3ec412f6aa4ecbd7c`, no base; its saved report read
  read-only on a web node), the plan's harness (`verify-dev.cjs`) with app.1m8.ai's served scripts gave Front 0 /
  Back 7 (W01, W03, W04, W05, W07, W14, W16) / Left 0 / Right 3, the reported page. `dev/exterior-report.test.cjs`
  against production's served file (`e44182e9…`) failed the FM-355 case; against the release file it passed 9/9.
- Build on the dev worker (`npm run check` included), 307 s. Archive sha256
  `c55fef9a3b29dfe824be15541646f84d136448d8d4b80bb1d41c234786b52ace`, verified on fm-agents, compatibility, the worker
  and each web node. The archive's `exterior_report_model.js` has sha256 `8e69b59f…`.
- New assert in `web_activate.py` (FM-355), beside FM-324, FM-335 to FM-354 and cad6a00b: each node's
  `exterior_report_model.js` has that sha256, `planes.push({w,fr,region,unsure:!chimneyCenter&&sign===null})` once and
  the ray-crossing helper once.
- Baseline at 22:19 UTC: web 5xx 0.05 % over 30 min; compatibility 0.60 %, 2 watchdog kills in the 3 h before.

## Rollout (scripts: fm-agents /srv/agents/work/fm-355-prodrun-scripts)

- Rollback target before activation: `93c7a2fd1dfa3a1849dfcab8d893363f005629be`, every host's `current` at 22:18 UTC;
  recorded on FM-355.
- Signed channel published from compatibility against `1e456b12…` (93c7a2fd's archive).
- Worker at 22:27:18 UTC (no job running): 8 slots, production, heartbeat off, outbound email on.
- Six web nodes one at a time behind the load balancer, 22:27:24–22:40:45 UTC; every node passed every assert,
  including FM-355's.
- Compatibility last at 22:41:00 UTC through the gate, which opened at once at 372 `legacy-action`/min, load 1.6.
  0 Node 500s and 0 HTTP worker exits in the 20 s after.

## After activation

- All eight hosts point `current` at `db67d858`. Public readiness answered `db67d858`, `ok`, on 10 of 10 after
  compatibility and again at 23:02.
- `https://app.1m8.ai/measure/internal/editor_scripts/exterior_report_model.js` has sha256 `8e69b59f…` (the release
  file) and holds `unsure:!chimneyCenter&&sign===null` once (0 before). `dev/exterior-report.test.cjs` against the
  served file: 9/9.
- Behaviour: the plan's harness on the FM-355 order with app.1m8.ai's served scripts now gives Front 5 (W01, W02,
  W04, W05, W06) / Back 3 (W11, W12 with the sliding door, W13) / Left 4 / Right 4: all 16 faces counted once, and
  nothing labelled under the door on the Back page.
- 22:42–22:52 (after compatibility settled): web 5xx 0.03–0.10 % (the 30 min before, which held the web rollout:
  0.13–0.18 %); compatibility 0.67 % against 0.76 %. Every 5xx in that window was the existing
  `top_view_reroll_proxy.php`.
- Compatibility from 22:41:00 to 23:02: cluster watchdog **0 kills**, 0 Node 500s, 0 pool timeouts at
  337–483 `legacy-action`/min.
- Worker, 22:27:18–23:02: 481 jobs completed (56 `imagery.process`, 287 `pdf.sync`, 94 `report.delivery`, 44 `report.release`), none failed and none retried. 465 `report.release` queued, none due (scheduled holds, as before).

## Not covered

- The customer's saved PDF for 9241 Fairway Dr, Orland Park is unchanged until someone opens the order in the editor
  and presses **Regenerate**; nothing was regenerated by this run.

## Rollback

`93c7a2fd1dfa3a1849dfcab8d893363f005629be` is still installed on every host: activate it on compatibility, the web
nodes one at a time and the worker (`fm-355-prodrun-scripts/rollback/`: `release.sh compat|worker|publish`,
`web_rollout.sh`), and republish the channel with 93c7a2fd's archive against `c55fef9a…`. Code only: reports
regenerated in the meantime keep their corrected walls until regenerated again.
