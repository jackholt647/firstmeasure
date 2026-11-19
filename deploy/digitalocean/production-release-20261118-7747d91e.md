# Production release 7747d91e: wall mode no longer moves the hidden roof drawing (FM-566), November 18, 2026

Released from fm-agents-1 by the production run for FM-566 (FirstMeasure bug fixes workspace, Router's standing
authorization for issues set to "Testing in prod" once verified on dev). The release is the plan commit cherry-picked
onto the live release:

| Commit | Change | Same change as (verified on dev) |
| --- | --- | --- |
| `7747d91e` | FM-566: in wall mode, the roof's key handler leaves Ctrl+A and M to wall mode, and the 3D height drag and resize don't touch the roof | plan branch `claude/fm-566-fix-prod` `9b8f03d6` (on the older `390b00da`); lane commit `94c749d0` (diff identical), lane release `measure-internal-20261118154057-87ee5914` |

`7747d91e` is a cherry-pick (`-x`) of `9b8f03d6` onto the live release `07ce15fc` (FM-567, which went live after
the plan was written). `production-live` `689b0f16` (the record of `07ce15fc`) was merged into it with `--no-ff`
and this record committed on top, so the push is a fast-forward.

## Change

- `public/measure/internal/editor_scripts/scene_3d.js` (+8 −2): while wall mode is on, the window key handler
  registered by `scene_3d.js` (before wall mode's) no longer runs Ctrl+A (select every roof point) or M (vertical
  move of the selection); Ctrl+A still has its default prevented. `onMouseMove3D` doesn't run the roof height drag or
  resize in wall mode. Roof mode is unchanged. Served sha256 `c4a0e877a1a2…` → `e6152391dea6…`; the editor's
  `scene_3d.js?v=` (content hash) is now `e6152391dea6b86d`.
- `dev/scene-wall-mode-roof-keys.test.cjs`: regression test (not served).
- No Node server code, environment, flag, nginx, dependency, config-library or database change. No data repair:
  14408 E Queen Ave was already corrected by a second tech and approved by QA; 820 Monroe Ave NE (the issue's second
  report) was not a save problem and is back with a tech.

## Checks before release

- `current` was `07ce15fc` on all 8 hosts. Rollback target `07ce15fc` was recorded on FM-566 before anything was
  built. Disk `/` had 68–131 GB free on every host. Compat over the hour before: 0 watchdog kills, 0 Node 500s,
  0 pool timeouts.
- `git diff 07ce15fc 7747d91e`: the two files above; its `+/-` lines equal plan commit `9b8f03d6`'s.
- `node --test dev/scene-wall-mode-roof-keys.test.cjs` on the release tree: 2/2. Control with `07ce15fc`'s
  `scene_3d.js`: 1/2.
- Plan harness (`fm-566-harness/served.cjs`: real keys and mouse in Chromium, wall mode on with the reported order's
  walls, production's served editor scripts) before the release: Ctrl+A selected 65 roof points, M started a drag
  (`MOVING`), a 50 px mouse move raised the whole roof 1.0 m.
- Built on the dev worker (274 s). Archive sha256 `82e70ba5eb6a6915d5c85ceb4c6b5a615f64dc8d2c7e1440e48bbe8effce3351`;
  its `scene_3d.js` is the bytes dev serves (`e6152391…`).
- `fastpath.sh decide` against `07ce15fc`'s archive (`d8ff73d1…`) chose the **fast path**: server, dependencies and
  configuration the same; 1 changed file, static (`scene_3d.js`); 0 Node files.
- `switch-release-files.py --check` reported "fast path possible" on all 8 hosts.

## Rollout (scripts: fm-agents /srv/agents/work/fm-566-prodrun-scripts)

- Installed on compatibility and the worker; the web channel was published against `07ce15fc`'s archive and the
  release installed on the six web nodes. Nothing was activated at this stage.
- Fast-path switch, 17:04:38–17:06:38 UTC: compatibility first, then the six web nodes one at a time, then the worker.
  On each host `current` switched in 0.1–0.3 s, PHP-FPM reloaded and Node was kept (same MainPID).

## Verification

- `current` is `7747d91e` on all 8 hosts. Readiness is ok 10/10 and reports `07ce15fc` (the release Node started in;
  this is a fast path).
- 12 requests to app.1m8.ai: `scene_3d.js` 12/12 the release's bytes (sha256 `e6152391dea6…`); `roofEditable`
  appears 3 times. Compat's `editor.php` versions it `?v=e6152391dea6b86d`.
- The served `scene_3d.js`, placed in a clean tree of the release (`git status` clean, so byte-identical), passes
  `dev/scene-wall-mode-roof-keys.test.cjs` 2/2.
- Plan harness against app.1m8.ai after the release: Ctrl+A selects 0 points, state `IDLE`, roof heights unchanged,
  no history save.
- Watch 17:04:38–17:20 UTC against the 30 minutes before (`rates.py`):
  - Web nodes: 5xx 0.02–0.04 % after, against 0.05–0.07 % before; all `top_view_reroll_proxy.php` (long-standing).
  - Compatibility: 0.56 % against 0.76 % before, all `top_view_reroll_proxy.php`. Node: 0 watchdog kills, 0 pool
    timeouts, 1 Node 500 (`completeAcquisitionSignup` "Premature close": caller closed the connection; Node code and
    process unchanged); MainPID 3681809 unchanged.
  - Worker (MainPID 3036191 unchanged): 0 failed or retried jobs since activation; 185 completed (106 `pdf.sync`,
    34 `imagery.process`, 31 `report.delivery`, 14 `report.release`). The 278 queued `report.release` jobs are
    scheduled holds, none due.
- No signed-in editor smoke test was run: the run has no production staff session, and none was created.

## Rollback

`NEW=7747d91e… OLD=07ce15fc… bash fastpath.sh rollback` switches back (compatibility → web → worker; nothing
restarts). Then `bash rollback/release.sh publish` republishes the channel with `07ce15fc`'s archive, which is still
on compatibility at `/var/tmp/firstmeasure-release-07ce15fc`.
