# Production release 03645bd4: Full Exterior walkaround recording flow (FM-573), November 19, 2026

Released from fm-agents-1 by the FirstMate Tracker production run for the "FirstMeasure bug fixes" workspace (standing
authorization for issues set to "Claude → Testing in prod" once verified on dev). Ben OK'd it for production on
2026-11-18 ("This is good to push to prod", 18:59 UTC), which lifted the hold in its description.

The release is `03645bd4` on `claude/prod-fm573`: `origin/production-live` (`cf8fa6ae`, the record of `25d3ef4c`,
production at the start of the run) plus `git merge --no-ff` of the plan's branch
`claude/fm-573-walkaround-recording-flow-prod` (`2ffd0851`). That branch is FM-569's production branch (`9b8c973c`, whose
tree equals `25d3ef4c`) plus cherry-picks of the five dev commits `9800c2c1`, `492f210c`, `d4b7138f`, `d0e38adc` and
`6a50e62c`, live on dev in `platform-20261118185152-458246c7`. The merge was clean; `git diff 25d3ef4c 03645bd4` for the
two files equals `git diff 9b8c973c 2ffd0851`, and `exteriors.js` is byte-identical to dev's (blob `229d65ff`).

## Change

- `public/libraries/apps/firstmeasure/order/exteriors.js` (sha256 `7353bdcc7bf2…`, was `990f700d20d6…`), the phone
  "View sample" popover on *Record a video walkaround* and *Upload photos*:
  - it opens above the tip, or from the top of the page covering the tip, and never reaches Start recording / Add photos;
  - a header row with the title and a close X in the top-right corner (the X never sits on the media);
  - a light shadow that falls upward;
  - nothing scrolls inside it (the sample shrinks to fit); a tapped photo is shown on its own;
  - after a recording, the intro button says **Record another video** (was the hard-coded "Record another segment").
  The desktop sample card is unchanged.
- `tests/exteriors-order-copy.test.mjs` (not in the archive).
- Browser file only: no Node source, dependency, configuration, environment, database, flag or config library change.
  No data repair. The new `ext_close_sample` language key is in no catalog (on canonical either) and shows its English
  fallback, as on dev.

## Checks before release

- `tests/exteriors-order-copy.test.mjs` on the release tree: 10/10 (with `25d3ef4c`'s `exteriors.js`: 7/10, control).
- Built on the dev worker (`build.sh`, 300 s, `npm run check` included). Archive sha256
  `dae74b2f2233005c254f4b61fbc81aed58381955d691cd3f782b20a0e78262c6`. `diff -rq` against `25d3ef4c`'s archive lists
  only `exteriors.js`, `release.env` and the previous record.
- `fastpath.sh decide` against `25d3ef4c`: exit 3, **full procedure** (`public/libraries` counts as Node's side).
- `web_activate.py` = the `25d3ef4c` run's, repinned for `exteriors.js` (FM-530/563/567/568 digests; needles that FM-573
  changes: FM-563 "View sample" 8→9, FM-567 "Record another video" 2→4, FM-569 `data-intro-sample` 5→7) plus an FM-573
  block (file digest, served file, "Record another segment" ×0, `data-intro-sample-close` ×2). 126 file asserts pass on
  the archive and fail on `25d3ef4c`'s tree (control). Rollback asserts (`25d3ef4c`'s, base `03645bd4`) pass on
  `25d3ef4c`'s tree.

## Rollout (scripts: fm-agents /srv/agents/work/fm-573-prodrun-scripts)

- Rollback target `25d3ef4c` recorded on FM-573 at 03:16 UTC, before anything was installed.
- Installed on compatibility and the worker (03:26–03:27 UTC).
- Worker activated 03:27:33 UTC with no running jobs.
- Channel published against `25d3ef4c`'s archive.
- Web nodes one at a time, 03:28:40–03:42:25 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility: through `compat_gate.sh`; the gate opened at once (03:42:35, 395/min). Rolling replace, `COMPAT_DONE`
  at 03:43:43, with 0 Node 500s and 0 worker exits in the 20 s after.

## Verification

- `current` is `03645bd4` on all 8 hosts. Readiness 10/10 200 with `03645bd4` (5 instances).
- Every web node and compatibility serve `exteriors.js` with sha256 `7353bdcc7bf2…`; through the load balancer 5/5
  requests give git blob `229d65ffb20a12e176d38b72a371d8ab819b3b51` (the plan's).
- The plan's phone harness (`fm-573-harness/phone4.mjs`, dev.1m8.ai page with the order files production's first
  activated node, 64.23.240.81, serves):
  - 360×640: video popover 244–479 above the tip (487), photos 84–446 vs Add photos at 531;
  - 412×915: photos 68–469 covering the tip, vs Add photos at 806;
  - 412×560: photos 68–463 vs Add photos at 477.
  No inner scroll anywhere (scrollHeight = clientHeight), zoom and the X work, and after one fake-camera recording the
  button says "Record another video". The same harness with `25d3ef4c`'s served files fails (no header/body: control).
- `/portal/` redirects to login when signed out, so its content-hash `?v=` for `exteriors.js` was not read; the served
  sha256 is the proof.
- 5xx 03:45–04:06 UTC against the 30 minutes before: web 4–6 per node (0.03–0.05 %) against 0.01–0.05 %; compatibility
  33 (0.50 %) against 0.43 %. Every one is the long-standing `/measure/internal/top_view_reroll_proxy.php`.
  Readiness 10/10 `03645bd4` again at 04:06.
- Worker jobs since 03:27:33: 214 completed, 0 failed (04:06 UTC); queued jobs are scheduled `report.release`, none overdue.
  Worker journal 03:28–03:53 UTC: 0 "Worker stopping", 0 PDF "browser has been closed", 0 pool timeouts, 0 heartbeat
  failures.
- Compatibility 03:43:43–04:06:26 UTC: 0 Node 500s, 0 watchdog kills, 0 OOM, 0 pool timeouts; same MainPID
  throughout, 2.1 GB available, 374–572 legacy-action/min, load 0.2–1.7.

## Rollback

`rollback/`: the `25d3ef4c` run's `web_activate.py` (base `03645bd4`), `web_install.py` and `web_rollout.sh`;
republish the channel with `25d3ef4c`'s archive (`rollback/rel.tar.gz`, sha256 `b888a7ac…`, `PREVSHA` = this archive)
before rolling the web nodes; worker and compatibility back with `activate-release.sh 25d3ef4c…`
(`rollback/release.sh`). Rolling back brings back the FM-569 sample popover and "Record another segment".
