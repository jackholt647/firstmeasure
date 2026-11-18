# Production release ebc79cf7: walls keep a roof plane with a stray resolver hole (FM-527), November 17, 2026

Released from fm-agents-1 by the FM-527 production run (FirstMeasure bug fixes workspace, Router's standing
authorization for issues set to "Testing in prod" once verified on dev). The plan branch
`claude/fm-527-wall-update-failure-prod` (`a98332b2`) sits on `production-live` `f9b8d7ad`, the record of `ad6f5c6e`.
That record is a sibling of the release `ad6f5c6e`, not its child (both are on `96b3c694`), so `a98332b2` lacks FM-524's
follow-up `project_resources.js` change and would have reverted it. The plan's one commit was therefore cherry-picked
onto the live release `ad6f5c6e`:

| Commit | Change | Same change as (verified on dev) |
| --- | --- | --- |
| `ebc79cf7` | A roof face that the face resolver gave a stray hole (a small face outside it that touches only one corner) stays in the walls' roof instead of being left out; walls saved without such a plane follow it once when the project is opened again | plan `a98332b2` (diff identical, same blobs); dev commit `7e56d238`, lane release `measure-internal-20261117154420-d76b2cc3` |

This record merges `production-live` (`f9b8d7ad`) into `ebc79cf7`, so `production-live` keeps the earlier record and
now descends from the live release again.

## Change

- `public/measure/internal/editor_scripts/wall_geometry.js`: new `holesInside(face)`. It drops a hole that has nothing
  inside its face's outline and something outside it. Holes on or inside the outline are kept (a face that is its own
  hole, FM-320, still has no surface). Blob `3d395cf7` → `8d666e32`, sha256 `d110c2397cfe2a50…`.
- `public/measure/internal/editor_scripts/wall_mode.js`: `usableRoofFaces` uses it. `leftOutRoofPlane` runs once per
  opened project: when the saved walls lack a plane like that (and the drawing is unchanged), the walls follow it on
  entering the Wall page. Walls are added, wall work is kept, and there is no prompt. Blob `ee6542e6` → `88ef03e1`,
  sha256 `3e6e0de99247bcfa…` (the same file dev serves).
- `dev/wall-roof-rebuild.test.cjs`: 3 FM-527 regression tests (not in the archive).
- No Node server code, environment, flag, nginx, dependency, config-library or database change. No data repair: the
  reported project (`exteriors_4ea4d378…`, Renton WA) repairs itself through this code the next time it is opened in
  the editor and the Wall page is entered, and then it needs saving.

## Checks before release

- `current` was `ad6f5c6e` on all 8 hosts. Readiness was ok and reported `43a59307` (Node unchanged since FM-523). The
  served `wall_mode.js` blob was `ee6542e6`. Rollback target `ad6f5c6e` was recorded on FM-527 before anything was
  built. Disk `/` was 25–31 % used on all 8 hosts.
- `git diff ad6f5c6e ebc79cf7` touches exactly the three files above, and the `+/-` lines equal those of `a98332b2`
  and `7e56d238`.
- `node --test dev/wall-roof-rebuild.test.cjs` on the candidate tree: 18/18.
- Built on the dev worker in 279 s (`npm run check` passed). Archive sha256
  `e8d93d7b2df486a930e78d9707e495d08e781f20426f4111ba21856f14f608df`.
- `fastpath.sh decide` against `ad6f5c6e`'s archive (`269723f2…`) chose the **fast path**: server, dependencies and
  configuration the same; 2 changed files, both static (the two editor scripts); 0 Node files; no unclassified readers.
- `switch-release-files.py --check` reported "fast path possible" on all 8 hosts.

## Rollout (scripts: fm-agents /srv/agents/work/fm-527-prodrun-scripts)

- Installed on compatibility and the worker; the web channel was published against `ad6f5c6e`'s archive and the
  release installed on the six web nodes. Nothing was activated at this stage.
- Fast-path switch, 16:03:47–16:05:35 UTC: compatibility first, then the six web nodes one at a time, then the worker.
  On each host `current` switched in 0.0–0.3 s, PHP-FPM reloaded and Node was kept (same MainPID). The changed static
  files were served with the new bytes (the worker serves none).

## Verification

- `current` is `ebc79cf7` on all 8 hosts. Readiness is ok 10/10 and reports `43a59307` (Node did not restart; true at
  16:05 and again at 16:15).
- `served.py` plus the plan check, 12 requests each to app.1m8.ai: `wall_mode.js` 12/12 blob `88ef03e1` (the plan's
  blob) with needles `function leftOutRoofPlane(){`, `G.holesInside(f)` and `if(!leftOutRoofPlane())return 'same';`
  0 → 1 each; `wall_geometry.js` 12/12 blob `8d666e32` with `function holesInside(` and `roofPlanesOnly,holesInside,`
  0 → 1.
- The served files, placed in a clean tree of the release (`git status` clean, so byte-identical), pass
  `dev/wall-roof-rebuild.test.cjs` 18/18. Control: `ad6f5c6e`'s files fail all 3 FM-527 tests (0/3).
- Watch 16:03:47–16:15 UTC against the 30 minutes before (`rates.py`):
  - Web nodes: 5xx 0.06–0.16 % after, against 0.07–0.14 % before. The top routes are the long-standing
    `top_view_reroll_proxy.php` and `/v1/internal/legacy-action`.
  - Compatibility: 0.97 % against 0.77 % before. 52 of its 54 5xx are `top_view_reroll_proxy.php`; its 2
    `editor.php` 503s match the rate before the release (10 between 14:32 and 15:53).
  - Compatibility Node: 0 Node 500s and 0 pool timeouts. 3 watchdog kills, against 12 in the hour before (the same
    rate). MainPID 3480169 is unchanged. The 16:04:11 kill came before compatibility's PHP-FPM reload at 16:04:22.
  - Worker: MainPID 2287929 unchanged and 0 error lines, before and after.
- No signed-in editor smoke test was run: the run has no production staff session, and none was created.

## Rollback

`NEW=ebc79cf7… OLD=ad6f5c6e… bash fastpath.sh rollback` switches back (compatibility → web → worker; nothing
restarts). Then `bash rollback/release.sh publish` republishes the channel with `ad6f5c6e`'s archive, which is still
on compatibility at `/var/tmp/firstmeasure-release-ad6f5c6e`.
