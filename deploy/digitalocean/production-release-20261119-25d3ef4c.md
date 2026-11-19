# Production release 25d3ef4c: Full Exterior order upload flow (FM-568) and photo workflow fixes (FM-569), November 19, 2026

Released from fm-agents-1 by the FirstMate Tracker production run for the "FirstMeasure bug fixes" workspace (standing
authorization for issues set to "Claude → Testing in prod" once verified on dev). Ben OK'd both for production on
2026-11-18 ("This is fine to go to prod", 19:02 UTC on each issue), which lifted the hold in their descriptions.

The release is `25d3ef4c` on `claude/prod-batch-fm568-569`: `origin/production-live` (`8cada234`, the record of
`00c01154`, production at the start of the run) plus `git merge --no-ff` of each plan's production branch in turn:

- FM-568 `claude/fm-568-upload-flow-updates-prod` (`1ff9a3e5`, a cherry-pick of dev commit `13d36219`), live on dev in
  `platform-20261118170620-af2a134e`.
- FM-569 `claude/fm-569-photo-workflow-fixes-prod` (`9b8c973c`, a cherry-pick of dev commit `5b90cbec` on top of
  FM-568's branch), live on dev in `platform-20261118172627-87f28797`.

Both merged cleanly. The release tree equals `9b8c973c`'s tree; `exteriors.js` and the test are byte-identical to dev's
`5b90cbec`, and the sample files to `13d36219`. FM-573 stacks on these and was not in this run; it goes next, alone.

## Change

- `public/libraries/apps/firstmeasure/order/exteriors.js` (sha256 `990f700d20d6…`, was `efdb6f31c34d…`):
  - FM-568: the phone walkaround review shows the videos at the top, the other-angles line and a **Record additional
    videos** button (no "Additional videos" / "Nothing added yet" group unless a stray extra file exists); the phone
    photo page copy ("Add photos", "Skip photo upload"); steps anchored under the picture; on desktop no "Optional with a
    video walkaround" line and the bottom-right button is always **Continue** (the Order button still needs all eight
    views when there is no walkaround).
  - FM-569: on the phone, "View sample" sits under the three steps on *Record a video walkaround* (sample video) and
    *Upload photos* (the whole sample gallery, tap to enlarge); each angle's "Example" still shows that angle; once every
    angle has a photo, the angle guide's forward button says **Review** and returns to *Review your photos*.
- `public/portal/samples/full-exterior/`: Ben's 2026-11-18 footage (8 views, poster, `walkaround.mp4` 640×360,
  4,477,145 bytes) and new `other-1..4.jpg`; house number blurred, no GPS. Requested with `?v=20261118`.
- `tests/exteriors-order-copy.test.mjs` (not in the archive).
- Browser and static files only: no Node source, dependency, configuration, environment, database, flag or config
  library change. No data repair.

## Checks before release

- `tests/exteriors-order-copy.test.mjs` on the release tree: 8/8.
- Built on the dev worker (`build.sh`, 345 s, `npm run check` included). Archive sha256
  `b888a7acfa655ae3e2d10d51c36bd9c6de4d421706e20797e8154d41002a7c3b`. `diff -rq` against `00c01154`'s archive lists
  only `exteriors.js`, the 15 sample files, `release.env` and the two earlier records.
- `fastpath.sh decide` against `00c01154`: exit 3, **full procedure** (`public/libraries` counts as Node's side).
- `web_activate.py` = the `00c01154` run's, repinned for `exteriors.js` (FM-530/563/567 digests; FM-563 needles
  "Skip photos" 5→0, "View sample" 3→8, "other angles" 6→7; FM-563 mp4 size) plus an FM-568/569 block (file digest and
  needles, all 14 sample digests in the release and served through NGINX). 124 file asserts pass on the archive and
  fail on `00c01154`'s tree (control). Rollback asserts (`00c01154`'s, base `25d3ef4c`) pass 121/121 on `00c01154`'s tree.

## Rollout (scripts: fm-agents /srv/agents/work/fm-569-prodrun-scripts)

- Rollback target `00c01154` recorded on FM-568 and FM-569 at 02:30 UTC, before anything was installed.
- Installed on compatibility and the worker; channel published against `00c01154`'s archive.
- Web nodes one at a time, 02:43:35–02:57:23 UTC. Each passed every assert and came back behind the load balancer.
- Worker activated 02:57:29 UTC with no running jobs.
- Compatibility: through `compat_gate.sh`; the gate opened at once (02:57:33, 408/min). Rolling replace,
  `COMPAT_DONE` at 02:58:34, with 0 Node 500s and 0 worker exits in the 20 s after.

## Verification

- `current` is `25d3ef4c` on all 8 hosts. Readiness 10/10 `ok`/`ready` with `25d3ef4c` (5 instances).
- Through the load balancer, 12/12 requests each: `exteriors.js` `990f700d20d6…` (equal to the release),
  `front.jpg` `130182a6…`, `other-1.jpg` `a2e9c662…` (200 `image/jpeg`, was 404), `walkaround.mp4` `74df09ba…`.
- Served `exteriors.js`: `data-intro-sample` ×5, `everyAngleTaken` ×3, "Record additional videos" ×2,
  "Skip photo upload" ×2, "Optional with a video walkaround" ×0.
- The plan test run with the file served by the first activated node (64.23.240.81) copied into a release worktree:
  `git status` clean (byte-identical), 8/8.
- `/portal/` redirects to login when signed out, so its content-hash `?v=` for `exteriors.js` was not read; the served
  sha256 is the proof.
- Web 5xx 02:43:35–02:59 UTC against the 30 minutes before: 0.01–0.05 % (1–6 per node) against 0.02–0.06 %; every one is
  the long-standing `/measure/internal/top_view_reroll_proxy.php`.
- Worker jobs since 02:57:29: 5 completed, 0 failed; queued `report.release` jobs are scheduled, none overdue.
- Compatibility 02:58:34–03:14:20 UTC: 0 Node 500s, 0 worker exits, 0 watchdog kills, 0 pool timeouts.
- Web 5xx 02:57:23–03:15 UTC: 0.02–0.06 % (2–7 per node), all `top_view_reroll_proxy.php` except one
  `/measure/internal/editor.php` on 137.184.88.252 (the compatibility rolling replace). Readiness 10/10 `25d3ef4c` at 03:15.

## Rollback

`rollback/`: the `00c01154` run's `web_activate.py` (base `25d3ef4c`), `web_install.py` and `web_rollout.sh`;
republish the channel with `00c01154`'s archive (`rollback/rel.tar.gz`, sha256 `64178057…`, `PREVSHA` = this archive)
before rolling the web nodes; worker and compatibility back with `activate-release.sh 00c01154…`. Rolling back brings
back the FM-567 order flow and the old sample media.
