# Production release 07ce15fc: FM-567 (Full Exterior order follow-ups, FM-563 round two), November 18, 2026

Released from fm-agents-1 by the FM-567 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The release is the plan commit as is: `07ce15fc` on `claude/fm-567-video-upload-flow-prod`, a child of production-live
`390b00da` (record of release `0908b4cd`, FM-532 round 3, production at the start of the run). It is two cherry-picks:
- `400aff0e` = dev `3971203b` (FM-563 follow-ups, on dev since `platform-20261118055008-aee45a95` but never released).
  Its code diff is identical to the dev commit except for the line offsets in `project-request/app.js`, whose
  production copy differs from dev's. The apps manifest's `project-request/app.js` line was redone on production's tree
  with a production-only key.
- `07ce15fc` = dev `04d066d5` (FM-567), identical.

After both, `order/exteriors.js` (git blob `b5e81ac3`) and `tests/exteriors-order-copy.test.mjs` are byte-identical to
canonical and to dev's served file. Verified on dev in `platform-20261118152856-9ac7f398` (FM-567 comments: 412 px
phone and 1440 px desktop, signed in, fake camera).

## Change (browser files only)

- `public/libraries/apps/firstmeasure/order/exteriors.js`:
  - Desktop: the order tray stays hidden until the photos are uploaded or skipped. After the video, Continue sits at the
    bottom right, then Skip photos in the same place.
  - The price is on the Order button ("Order Full Exterior - $25"), with no Total line on desktop or phone.
  - The walkaround review says "Additional videos" and has no "Additional photos and videos" upload area.
  - Every structure's recording is titled "Record a video walkaround" ("Keep walking the loop" is gone).
  - "Skip video upload" replaces "Upload photos instead".
  - A second recording on the same structure is titled "Record another video" (not "Segment saved") and the camera
    shows no tip.
- `public/libraries/apps/project-request/app.js`: one line. A Full Exterior's order button takes
  `Portal.ExteriorOrder.orderLabel()` (with the price). Roof orders are unchanged.
- `firstmate-apps-manifest.js`: `project-request/app.js` → `20261118-fm567-order-tray-prod` (was
  `20261117-fm530-exterior-sequence`). `exteriors.js` is versioned by content in `portal/index.php`.
- `tests/exteriors-order-copy.test.mjs` (7 tests).
- No server code, data, environment, dependency, flag, nginx, config-library, language catalog or editor
  (`measure/internal`) change. New copy uses its English fallbacks, as on dev.

## Checks before release

- At 15:4x UTC, `current` was `0908b4cd` on all 8 hosts, and readiness reported it. Root disks had ≥ 68 GB free, no
  watch or gate processes were left over, and the only other live run (FM-566) is editor work on dev. Rollback target
  `0908b4cd` was recorded on FM-567 before anything was built or activated, and the agent channel lock was posted.
- Built `07ce15fc` on the dev worker (284 s). Archive sha256
  `d8ff73d1d45a3bb65660ff1ba9179b26969dd2b63427e4a50f1b5bef9025e314`. The extracted tree differs from `0908b4cd`'s
  only in the three browser files above, `release.env` and the previous record.
- `fastpath.sh decide`: exit 3, full procedure (`public/libraries/` files are read by Node).
- `web_activate.py` = FM-532 round 3's with one sed pass. Repinned:
  - the `exteriors.js` digest in the FM-530 and FM-563 asserts;
  - FM-563's needles (`Upload photos instead` 6 → 0, `Skip video upload` 6, `Skip photos` 2 → 5);
  - the FM-324/376 `project-request/app.js` + manifest digest pair;
  - the FM-324 and FM-563 manifest `?v=` needles.

  Added FM-567's assert: both browser files' digests served; `Segment saved` 0, `Record another video` 2,
  `Keep walking the loop` 0, `Additional videos` 2; `ExteriorOrder.orderLabel` once in `project-request/app.js`.
  All 103 file asserts pass on the archive and fail on `0908b4cd`'s (control). The rollback asserts (FM-532 round 3's,
  base `07ce15fc`) pass 101/101 on `0908b4cd`'s archive.
- The plan test passes 7/7 on the plan tree. With `0908b4cd`'s two browser files it passes 2/7 (control).

## Rollout (scripts: fm-agents /srv/agents/work/fm-567-prodrun-scripts)

- Compatibility and the worker installed at 15:45-15:46 UTC.
- Worker activated at 15:46:52 UTC, with no running jobs. Channel published against `0908b4cd`'s archive
  (`b3690b6d…`).
- Web nodes one at a time, 15:47:56-16:00:49 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility through the gate. It waited 30 min (404-1102 legacy-action/min, 16:01-16:31 UTC Wednesday) and
  opened at 16:31:17. Rolling replace at 16:31:18, with 0 Node 500s and 0 worker exits in the 20 s after.

## Verification

- `current` is `07ce15fc` on all 8 hosts, and readiness reports `07ce15fc` 10/10. Compat's HTTP workers run
  `RELEASE_ID=07ce15fc…`. The cluster primary keeps the release it started in (`efc0bdc4`), by design of the rolling
  replace.
- Served through the load balancer (6/6 each):
  - `order/exteriors.js` git blob `b5e81ac3` (was `a9e32a34`);
  - the apps manifest contains `20261118-fm567-order-tray-prod`;
  - `project-request/app.js` contains `ExteriorOrder.orderLabel`.
- The plan test on the two browser files production serves: 7/7.
- Browser check (the plan's harness, `/tmp/fm567-prodharness`): dev.1m8.ai signed in, with production's served
  `exteriors.js` and `project-request/app.js` swapped in, fake camera.
  - Phone, 412 px:
    - the first recording is "Record a video walkaround", with the tip;
    - after one segment it is "Record another video", "1 segment · 0:05", with no tip;
    - structure 2 is "Record a video walkaround".
  - Desktop, 1440 px:
    - Video step: no tray, and the link reads "Skip video upload".
    - After the upload: Continue at the bottom right.
    - Photos step: Skip photos in the same place, still no tray.
    - After Skip photos: the tray with "Order Full Exterior - $25" and no Total line.
- 5xx (excluding health probes):
  - web nodes since 15:48 UTC: 0.05-0.07 % (33-46 of ~68k each), against 0.09-0.13 % in the 30 minutes before;
  - compatibility from 16:32:30 UTC: 0.69 % (59 of 8,560), against 0.82 % (122 of 14,923) in the 30 minutes before;
  - compatibility's are all, and the web nodes' nearly all, the pre-existing `top_view_reroll_proxy.php` 500.
- Compatibility, 16:32-16:48 (2-minute polls): 0 watchdog kills, 0 OOM kills, 0 Node 500s and 0 pool timeouts. One MainPID throughout, with
  2.3-2.5 GB available and 362-571 legacy-action/min.
- Worker, 15:46:52-16:49: 784 jobs completed, 0 failed. No "Worker stopping", browser-closed or pool-timeout errors. Baseline: 748 completed
  and 0 failed in the hour before.
- No order was placed as a test, and no production data was changed. A person confirms the flow on production.

## Rollback

`/srv/agents/work/fm-567-prodrun-scripts/rollback/`:
- `release.sh worker`;
- `publish`, which republishes `0908b4cd`'s archive (PREVSHA `d8ff73d1…` = this release's archive);
- `web_rollout.sh`, with FM-532 round 3's asserts and base `07ce15fc` (101/101 pass on `0908b4cd`'s archive);
- `release.sh compat`, through the gate.

Nothing is migrated, so rolling back only switches the files.
