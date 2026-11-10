# Production release 5e90c26a: a long delivery label no longer runs into its price (FM-376), November 10, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan commit `5e90c26a` was already a child
of production-live `eaff0630` (the record of release `790a19c8`), so it was released as is:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-376 French label overlap | `5e90c26a` on `claude/fm-376-french-label-overlap-prod` (cherry-pick of dev commit `25639076`, identical diff) | `5e90c26a` | `platform-20261110193413-7c879e0b` |

## Change

Browser CSS only, served by web.

- `public/libraries/apps/project-request/app.js`: the delivery buttons on the last order step (roof report and Full
  Exterior) are a wrapping flex row instead of a two-column grid. `.r-expedite-copy` is `flex:1 1 7em;
  min-width:min-content`, `.r-expedite-price` is `flex:none;margin-left:auto`. When the label's longest word and the
  price don't fit side by side (French "Moins de 3 heures" + "+2,32 $US" in a half-width button), the price moves
  under the label instead of overlapping it. sha256 `0ff190df…` →
  `a1a70846a8d8eb3ce393a37f42e391f98cc91b418c5003d12e127870bd0e5a70`.
- Not served: `public/v1/tests/overview-order-layout-browser.test.mjs` (new FM-376 test).
- Against `790a19c8` the release adds only those two files and the FM-357 record. No Node, PHP, editor, environment,
  database, migration, flag, nginx, dependency, language-catalog or config-library change. No data repair. The portal
  versions `app.js` itself (`portalAssetVersion`), so there is no `?v=` bump.

## Checks before release

- At 19:39 UTC every host's `current` was `790a19c8`; readiness reported `790a19c8` 10/10. app.1m8.ai served
  `app.js` with sha256 `0ff190df…`.
- Control: with production's served file, the FM-376 test (`node --test --test-name-pattern="long delivery label"
  tests/overview-order-layout-browser.test.mjs` in a worktree of the release) failed: French and English labels
  overlapped their prices from 300 px. The plan's headless repro (`harness/repro.mjs`) showed French spilling out of
  the button at 300 px.
- Build on the dev worker (`npm run check` included) took 277 s. Archive sha256
  `6b1163ccde5d1f57e65e244f6ff8da6feb049f14a56544bdc5eac06c79ce18b8`, verified on fm-agents, compatibility, the
  worker and each web node.
- `web_activate.py` keeps every earlier assert. The FM-324 pin on `app.js` now pins the new sha256 (FM-324's own
  `__fmAddressTypingOnTop` count still holds), and a new FM-376 assert counts each of the three changed rules once
  and the old grid rule (`grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto`) once (the unrelated
  `.r-pending-action`). All 32 file asserts passed on the extracted archive before any activation.
- Worker: no failed `pdf.sync` in 72 h; 2 failed `report.delivery` (11/08 19:00, 11/09 13:00).

## Rollout (scripts: fm-agents /srv/agents/work/fm-376-prodrun-scripts)

- The rollback target `790a19c883c25fea15de5a0388c6ad98a51ab8a2` was recorded on FM-376 before activation.
- Worker at 19:49:10 UTC (no job running): 8 slots, production, heartbeat off, outbound email on.
- The signed channel was published from compatibility against `12569113…` (790a19c8's archive).
- Six web nodes went one at a time behind the load balancer, 19:50:08–20:03:35 UTC. Each passed every assert,
  including served `app.js` == local == the new sha256, and returned behind the load balancer on `5e90c26a`.
- Compatibility went last, at 20:12:07 UTC, through the gate (it waited 8 min at 440–640 `legacy-action`/min and
  opened at 393, load 4.7). In the 20 s after: 0 Node 500s, 0 HTTP worker exits.

## Verification

- `current` is `5e90c26a682d65c373f87ac06c771968b610cf7e` on all 8 hosts; readiness reports `5e90c26a` 10/10.
- app.1m8.ai served `app.js` with sha256 `a1a70846…` 12/12 through the load balancer.
- Proof: the FM-376 test passed on the file served by web node 64.23.240.81 (byte-identical to the commit). It had
  failed on the pre-release served file.
- Web 5xx from 20:14 (after compatibility settled) to ~20:25: 0.04–0.11 % per node, against 0.23–0.30 % in the 30 min
  before (that window holds the web rollout). Every 5xx after the cut is the long-standing
  `/measure/internal/top_view_reroll_proxy.php`. Compatibility 0.86 % (all `top_view_reroll_proxy.php`) vs 0.95 %.
- Compatibility watch to 20:30: 0 watchdog kills. 14 Node 500s: 10 "Fastify has already been closed" at 20:12:14
  (the restart) and 4 pool timeouts in one second at 20:26:41. Pool timeouts ran 8 and 7 an hour at 18:00 and 19:00
  UTC, before the release.
- Worker jobs since activation: 610 completed, 0 failed.

## Rollback

`/srv/agents/work/fm-376-prodrun-scripts/rollback/` (same scripts reversed to `790a19c8`; the channel republishes
790a19c8's archive from `/var/tmp/firstmeasure-release-790a19c8/` on compatibility). Browser CSS only: nothing to
undo in data or configuration.
