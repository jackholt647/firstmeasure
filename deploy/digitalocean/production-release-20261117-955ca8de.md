# Production release 955ca8de: FM-530 (Exteriors order flow copy), November 17, 2026

Released from fm-agents-1 by the FM-530 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The release is the plan commit as is: `955ca8de` on `claude/fm-530-exteriors-order-flow-copy-prod`, a direct child of
production-live `9ac053e1` (record of release `ebc79cf7`, FM-527, production at the start of the run). Its patch equals
canonical `421ef543` line for line; verified on dev in `platform-20261117182926-825dd95b`.

## Change

- `public/libraries/apps/firstmeasure/order/exteriors.js` (browser only), the customer Exteriors order:
  - Phone recorder: the header is just the title "Record a video walkaround", with more room for the camera. The
    Upload tile is off the camera; the button right of the shutter (was "Can't record?") reads Upload and opens the
    video picker, then becomes Review / Next structure as before. A small "Use photos instead" link sits at the bottom
    (hidden while recording).
  - Ordering from photos (phone): the "not enough footage, we may have to reject the project" warning is gone.
  - Desktop copy from Jack's screenshots: "Upload a video walkaround" and "Upload photos".
- Test (not served): `tests/exteriors-order-copy.test.mjs`.
- No server code, dependency, environment, flag, nginx, config-library, language-catalog or data change. The portal
  loads the file with its content hash (`portalAssetVersion` = `0e68ce6caf2b6359`), so browsers get it without a `?v=`
  bump.

## Checks before release

- At 18:45 UTC `current` was `ebc79cf7` on all 8 hosts and root disks were 26-31 % used. Rollback target `ebc79cf7` was
  recorded on FM-530 before anything was built or activated, and the agent channel lock was posted.
- Built `955ca8de` on the dev worker. Archive sha256
  `042be6fca50b5d695193978ba2cbc4fc3ec855041e2f2fa42210c5bab789ae36`.
- `fastpath.sh decide`: exit 3, full procedure (server, dependencies and configuration the same, but
  `public/libraries/` counts as read by Node).
- `web_activate.py` keeps every earlier assert, repins `project_resources.js` and `wall_mode.js` to the live release's
  files (changed by the FM-524 and FM-527 fast-path releases; equal to `git show ebc79cf7:…`), and adds FM-530's:
  `exteriors.js` sha256 `0e68ce6c…`, served equal to local, 3 `data-rec-photos`, 1
  `"ext_use_photos_instead","Use photos instead"`, 2 `Upload a video walkaround`, 0 `ext_photo_footage_risk`.
  All 84 file asserts pass on the archive. On `ebc79cf7`'s archive every assert passes except FM-530's (control).

## Rollout (scripts: fm-agents /srv/agents/work/fm-530-prodrun-scripts)

- Compatibility and the worker installed; channel published against `ebc79cf7`'s archive (`e8d93d7b…`).
- Worker activated at 18:47:09 UTC with no running jobs.
- Web nodes one at a time, 18:47:31-19:00:23 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility: at 19:01:08, before the gate opened, the kernel OOM killer killed one of compat's Node workers
  (1.2 GB RSS) on the *old* release and systemd restarted the whole service ("restart counter is at 5"; the same
  happened at 13:19, 13:21, 13:22 and 14:37 today, on earlier releases). That restart gave ~100 Node 500s per web node
  in the 19:01 minute. The gate opened at 19:02:00 (166/min, load 5.0); rolling replace 19:02:03-19:02:45, 0 Node 500s
  and 0 exits in the 20 s after. A watchdog kill at 19:02:42 hit pid 3572055, a worker the OOM restart had started
  from the old release.

## Verification

- `current` is `955ca8de` on all 8 hosts. Readiness reports `955ca8de` 10/10. Compat's HTTP workers run from
  `955ca8de` (`RELEASE_ID` and cwd; the primary keeps its start-up release by design).
- `https://app.1m8.ai/libraries/apps/firstmeasure/order/exteriors.js`: git blob `810444b7…` 12/12 (before:
  `aa58b59c…`), with 3 `data-rec-photos`, 1 `"ext_use_photos_instead","Use photos instead"`, 2 `Upload a video
  walkaround` and no `ext_photo_footage_risk`. `portalAssetVersion` on a web node: `0e68ce6caf2b6359`.
- Plan test: the file served by the first activated node passes `tests/exteriors-order-copy.test.mjs` 3/3; the old
  served file fails 3/3.
- 5xx from 19:04:00 UTC (after compatibility settled), excluding health probes:
  - web nodes: 0.09-0.17 % (13-24 of ~12-15k each), against 0.08-0.13 % in 18:17-18:47 (before anything was
    touched); mostly `/v1/internal/legacy-action` and `top_view_reroll_proxy.php`.
  - compatibility: 0.71 % (48 of 6,750), against 1.08 % before; mostly `top_view_reroll_proxy.php`.
- Compatibility after activation, 19:02-19:25: watchdog kills at about the rate before it (16 in the 74 minutes before
  activation, on the old release, about 13/h), 0 pool timeouts. At 19:18:44 a second OOM kill (a 3.1 GB Node worker)
  restarted the service again (16 Node 500s).
- **Cause of the OOM restarts:** a `compat_watch.sh` left by the FM-520 run (pid 1634037 on fm-agents-1, started
  2026-11-16 23:50 with `UNTIL=2359`; its 2-minute sleep stepped over 23:59, so it never stopped) polled compat every 2
  minutes for 19.5 hours with `J=$(journalctl -u firstmeasure-legacy --since '2026-11-16 23:48:15')`. Each poll held
  the whole day's journal in a root bash on a 4 GB host. At 19:23 the kernel killed four of those bash processes at
  ~1.75 GB RSS each. This run's own watch had the same shape, with a shorter window. Both were stopped at 19:26.
  From 19:28 to 19:36: 0 OOM kills, 0 Node 500s, one MainPID, 1 watchdog kill, 1.6-2.6 GB available. Today's earlier
  compat OOM restarts (13:19, 13:21, 13:22, 14:37) fall within that watch's lifetime. Future watches must count
  matches over a short `--since "-2 min"` window, never hold a growing journal in a variable, and use an end time
  that can't be stepped over.
- Worker, 18:47:09-19:25: 526 jobs completed and 1 failed: one `pdf.sync` for one customer exterior project (3
  attempts at 19:15, "The face does not define a valid planar region"). Nothing under `public/measure` or
  `public/v1` differs between `ebc79cf7` and `955ca8de`, so the PDF runtime is unchanged and the failure comes from
  that project's saved model. No "Worker stopping", browser-closed, pool-timeout or heartbeat errors.

## Rollback

`/srv/agents/work/fm-530-prodrun-scripts/rollback/`: `release.sh worker`, `publish` (republishes `ebc79cf7`'s archive),
`web_rollout.sh` (this run's asserts with base `955ca8de`, FM-530's dropped; all 83 pass on `ebc79cf7`'s archive),
`release.sh compat`. Rolling back only restores the previous `exteriors.js`; no data depends on it.
