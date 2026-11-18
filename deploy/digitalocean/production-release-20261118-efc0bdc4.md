# Production release efc0bdc4: roof trim follows the roof's rake labels with kept walls (FM-541), November 18, 2026

Released from fm-agents-1 by the production run for FM-541 (FirstMeasure bug fixes workspace, Router's standing
authorization for issues set to "Testing in prod" once verified on dev). The release is the plan commit as is:

| Commit | Change | Same change as (verified on dev) |
| --- | --- | --- |
| `efc0bdc4` | FM-541: when the walls were kept from an earlier roof, wall mode's roof lines, Trim panel Rakes/Eaves and the report's roof trim use the roof's current line types | plan branch `claude/fm-541-fix-prod`; lane commit `e3226889` (diff identical), lane release `measure-internal-20261118000040-1e865386` |

`efc0bdc4` is a child of `production-live` `425171a2` (the record of the live release `c32f4563`), so this record is a
fast-forward on top of it.

## Change

- `public/measure/internal/editor_scripts/wall_mode.js`: new `roofLines()` returns `state.roof` with the roof's
  current type for every line still between the same two points; used for the 3D roof lines, the roof trim pieces and
  `reportSnapshot`. It returns the same `state.roof` object when nothing differs; `state.roof` and the saved walls are
  never changed. Served sha256 `3e6e0de99247…` → `9179d51478d6…`.
- `dev/wall-roof-rebuild.test.cjs`: regression test "FM-541" (not served).
- No Node server code, environment, flag, nginx, dependency, config-library or database change. No data repair: trim
  settings are keyed by panel ends, so the reported order (14517 E Caprio Ave) lists 15 rakes once opened, and
  Rakes + a width trims the two that were missing. Delivered PDFs change only when an order is saved again.

## Checks before release

- `current` was `c32f4563` on all 8 hosts. Rollback target `c32f4563` was recorded on FM-541 before anything was
  built. Disk `/` was 28–33 % used on all 8 hosts. Compat over the hour before: 0 watchdog kills, 2 Node 500s, 2 pool
  timeouts.
- `git diff c32f4563 efc0bdc4`: the two files above plus the previous record; the plan commit's diff equals lane
  commit `e3226889`'s line for line.
- `node --test dev/wall-roof-rebuild.test.cjs` on the release tree: 19/19. Control with `c32f4563`'s `wall_mode.js`:
  18/19 (the FM-541 test fails on "both cricket rakes take trim").
- Plan harness (`kept.cjs`) on the reported order's saved walls and roof, with the 75 editor scripts production
  served before the release: 13 rake trim pieces.
- Built on the dev worker. Archive sha256 `d5db218dccbb47070d46fb423658edbbcdb6029d41fe9b42a9a30e30feef60a4`.
- `fastpath.sh decide` against `c32f4563`'s archive (`34b85636…`) chose the **fast path**: server, dependencies and
  configuration the same; 2 changed files, both static (`wall_mode.js` and the previous record); 0 Node files.
- `switch-release-files.py --check` reported "fast path possible" on all 8 hosts.

## Rollout (scripts: fm-agents /srv/agents/work/fm-541-prodrun-scripts)

- Installed on compatibility and the worker; the web channel was published against `c32f4563`'s archive and the
  release installed on the six web nodes. Nothing was activated at this stage.
- Fast-path switch, 00:18:48–00:20:32 UTC: compatibility first, then the six web nodes one at a time, then the worker.
  On each host `current` switched in 0.0–0.4 s, PHP-FPM reloaded and Node was kept (same MainPID).

## Verification

- `current` is `efc0bdc4` on all 8 hosts. Readiness is ok 10/10 and reports `90818652` (the last Node restart; this
  and `c32f4563` were fast paths).
- 12 requests to app.1m8.ai: `wall_mode.js` 12/12 the release's bytes (sha256 `9179d51478d6…`), `FM-541` 0 → 1.
- The served `wall_mode.js`, placed in a clean tree of the release (`git status` clean, so byte-identical), passes
  `dev/wall-roof-rebuild.test.cjs` 19/19.
- Plan harness with the 75 editor scripts production serves after the release: 15 rake trim pieces (13 before);
  the walls' `state.roof` is unchanged. The customer data copies were deleted afterwards.
- Watch 00:18:48–00:30 UTC against the 30 minutes before (`rates.py`):
  - Web nodes: 5xx 0.01–0.05 % after, against 0.03–0.06 % before; almost all are the long-standing
    `top_view_reroll_proxy.php`.
  - Compatibility: 0.57 % against 0.72 % before (18 of 20 `top_view_reroll_proxy.php`, 2 `editor.php`). Node: 0 watchdog
    kills, 0 Node 500s, 0 pool timeouts; MainPID 3578892 unchanged.
  - Worker (MainPID 2751628 unchanged): 0 failed or retried jobs since activation; 82 completed (43 `pdf.sync`,
    9 `imagery.process`, 13 `report.delivery`, 17 `report.release`). The 449 queued `report.release` jobs are
    scheduled holds, none due.
- No signed-in editor smoke test was run: the run has no production staff session, and none was created.

## Rollback

`NEW=efc0bdc4… OLD=c32f4563… bash fastpath.sh rollback` switches back (compatibility → web → worker; nothing
restarts). Then `bash rollback/release.sh publish` republishes the channel with `c32f4563`'s archive, which is still
on compatibility at `/var/tmp/firstmeasure-release-c32f4563`.
