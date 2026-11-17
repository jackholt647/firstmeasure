# Production release c32f4563: arched window trim (FM-533) and glass door placement (FM-534), November 17, 2026

Released from fm-agents-1 by one batch production run for FM-533 and FM-534 (FirstMeasure bug fixes workspace,
Router's standing authorization for issues set to "Testing in prod" once verified on dev). The release starts from
`production-live` `9a03f5ff` (the record of the live release `90818652`) and merges each plan's production branch in
turn. Neither conflicted:

| Commit | Change | Same change as (verified on dev) |
| --- | --- | --- |
| `171e04ae` (merged in `fb735360`) | FM-534: the placement menu's Glass box can be ticked, and doors placed while it is ticked are glass | plan branch `claude/fm-534-glass-door-checkbox-prod`; lane commit `1855e1c8`, lane release `measure-internal-20261117225419-99d12b2b` |
| `1a64147c` (merged in `c32f4563`) | FM-533: opening trim on an arched window no longer folds into a face that cannot be drawn ("The face does not define a valid planar region.") | plan branch `claude/fm-533-error-message-guidance-prod`; lane commit `1ee4da12`, lane release `measure-internal-20261117224427-0003be57` |

`c32f4563` is a child of `production-live`, so this record is a fast-forward on top of it.

## Change

- `public/measure/internal/editor_scripts/wall_editor.js` (FM-534): the wall editor passes `setPlacementGlass`
  through to the face draft. Blob `2145dc34` → `1b5d6d0f`.
- `public/measure/internal/editor_scripts/wall_features.js` (FM-533): in `trimFaces`, a trim board whose two mitre lines
  cross is returned as the triangle up to the crossing instead of a bow-tie. Blob `d609d8a5` → `000a1128`.
- `dev/placement-glass.test.cjs`, `dev/opening-trim.test.cjs`: regression tests (not served).
- No Node server code, environment, flag, nginx, dependency, config-library or database change. No data repair: the
  FM-533 project (`exteriors_445cbb65…`) only needs its Report PDF regenerated in the editor.

## Checks before release

- `current` was `90818652` on all 8 hosts. Rollback target `90818652` was recorded on FM-533 and FM-534 before
  anything was built. Disk `/` was 28–33 % used on all 8 hosts.
- `git diff 90818652 c32f4563` touches the four files above plus the previous record; each plan's `+/-` lines equal
  its plan commit's.
- `node --test dev/placement-glass.test.cjs dev/glass-doors.test.cjs dev/opening-trim.test.cjs` on the release tree
  (Chromium): 13/13. Control with production's served files placed in the same tree: 10/13 (the three FM-533/FM-534
  tests fail).
- Built on the dev worker in 310 s. Archive sha256
  `34b85636a00b8b9f02c239295f43e447b6f9ec56f2f4c203422a9e9ce5e03466`.
- `fastpath.sh decide` against `90818652`'s archive (`2ad83416…`) chose the **fast path**: server, dependencies and
  configuration the same; 3 changed files, all static (two editor scripts and the previous record); 0 Node files.
- `switch-release-files.py --check` reported "fast path possible" on all 8 hosts.

## Rollout (scripts: fm-agents /srv/agents/work/prod-batch-fm533-534-prodrun-scripts)

- Installed on compatibility and the worker; the web channel was published against `90818652`'s archive and the
  release installed on the six web nodes. Nothing was activated at this stage.
- Fast-path switch, 23:29:03–23:30:46 UTC: compatibility first, then the six web nodes one at a time, then the worker.
  On each host `current` switched in 0.1–0.4 s, PHP-FPM reloaded and Node was kept (same MainPID).

## Verification

- `current` is `c32f4563` on all 8 hosts. Readiness is ok 10/10 and reports `90818652` (Node did not restart).
- 12 requests each to app.1m8.ai: `wall_editor.js` 12/12 the release's bytes (sha256 `daf2bea1bf29…`, was
  `e890d3f991ee…`), `setPlacementGlass` 0 → 2 occurrences (key and call); `wall_features.js` 12/12 the release's bytes
  (sha256 `28d6e1829856…`, was `7b6805466a5f…`), `FM-533` 0 → 1.
- The served files, placed in a clean tree of the release (`git status` clean, so byte-identical), pass the three
  suites 13/13.
- FM-533 harness: the reported project's saved walls run through all 69 editor scripts production serves mesh 312 of
  312 report faces (0 bad); with the pre-release scripts, 2 trim faces fail with "The face does not define a valid
  planar region." The customer data copies were deleted afterwards.
- Watch 23:29:03–23:40 UTC against the 30 minutes before (`rates.py`):
  - Web nodes: 5xx 0.04–0.05 % after, against 0.05–0.07 % before; all are the long-standing
    `top_view_reroll_proxy.php`.
  - Compatibility: 0.55 % against 0.77 % before, all `top_view_reroll_proxy.php`. Node: 0 watchdog kills, 0 Node 500s,
    0 pool timeouts; MainPID 3578892 unchanged.
  - Worker (MainPID 2751628 unchanged): 0 failed or retried jobs since activation; 134 completed (64 `pdf.sync`,
    17 `imagery.process`, 16 `report.delivery`, 39 `report.release`). The 496 queued `report.release` jobs are
    scheduled holds, none due.
- No signed-in editor smoke test was run: the run has no production staff session, and none was created.

## Rollback

`NEW=c32f4563… OLD=90818652… bash fastpath.sh rollback` switches back (compatibility → web → worker; nothing
restarts). Then `bash rollback/release.sh publish` republishes the channel with `90818652`'s archive, which is still
on compatibility at `/var/tmp/firstmeasure-release-90818652`.
