# Production release 46f4d9d0: FM-563 (sequential media uploads, FM-530 round two), November 18, 2026

Released from fm-agents-1 by the FM-563 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The release is the plan commit as is: `46f4d9d0` on `claude/fm-563-sequential-media-uploads-prod`, a child of
production-live `f8d94535` (record of release `35da231c`, FM-561, production at the start of the run). Its diff is
identical to the earlier FM-530 plan commit `f2281d1b` (on `claude/fm-530-exteriors-order-flow-copy-prod2`, now
superseded), which is canonical `ca9e287f`; `exteriors.js`, the test and the sample media are the same blobs as on
canonical. FM-530 round one (`955ca8de`) reached production; round two never did until this release. Verified on dev
in `platform-20261117232722-34a44219` and again on dev `92ae6218` (FM-563 comments, 412 px phone and 1440 px desktop).

## Change

- `public/libraries/apps/firstmeasure/order/exteriors.js` (browser): Full Exterior order is a video walkaround, then
  the eight photos, either skippable ("Upload photos instead", "Skip photos"). Phone: Upload tile back on the left of
  the camera, walkaround review without Upload/"Can't take a video?", Record under "Additional photos and videos",
  "other angles" copy, per-angle Example beside "View n of 8" (no house picture top right). Desktop: "View sample"
  hover card (sample walkaround video on the video step, eight sample angles on the photos step) and the copy.
- `public/libraries/apps/project-request/app.js` (browser): `mobileOrderUsesFinalPage()` is false for a Full
  Exterior, so the phone orders from the delivery page with no review page (roof orders unchanged). What's included
  reads Roof & gutter / Door & window / Siding & trim measurements.
- `public/libraries/apps/firstmate-apps-manifest.js`: `project-request/app.js` `?v=` from
  `20261117-fm532-rejected-orders-2` to `20261117-fm530-exterior-sequence`.
- New static `public/portal/samples/full-exterior/`: 8 JPGs (2605 Camas Ave NE), `walkaround.mp4` (3.7 MB, 5207 N
  Rees Rd) and `walkaround-poster.jpg`; metadata stripped, house numbers blurred. Production answered 302 for that
  path before.
- `tests/exteriors-order-copy.test.mjs` (not in the archive).
- No server code, PHP, editor, data, environment, dependency, flag, nginx or config-library change.

## Checks before release

- At 04:0x UTC `current` was `35da231c` on all 8 hosts, root disks had ≥ 69 GB free and no watch or gate processes
  were left over. Rollback target `35da231c` was recorded on FM-563 before anything was built or activated, and the
  agent channel lock was posted.
- Built `46f4d9d0` on the dev worker (295 s). Archive sha256
  `fe355095b400299d89485ff8d55b17744de182c886a260f0d8187554aa86a653`. The extracted tree differs from `35da231c`'s
  only in the three browser files, the new `portal/samples/full-exterior/` folder, `release.env` and the previous
  record.
- `fastpath.sh decide`: exit 3, full procedure (the three browser files are under `public/libraries/`, which Node
  reads; server, dependencies and configuration unchanged).
- `web_activate.py` = FM-561's with one sed pass; repinned the FM-324/376 `project-request/app.js` and apps manifest
  digests, the FM-324 manifest needle (`20261117-fm530-exterior-sequence`), FM-530's `exteriors.js` digest (and its
  "Use photos instead" count 1 → 0); added FM-563's assert (both files' digests and needles, manifest key, and every
  sample file served with status 200 and `image/jpeg`/`video/mp4`, byte-equal to the release). 97 file asserts pass
  on the archive; on `35da231c`'s archive they fail (control). The rollback asserts pass 93/93 on `35da231c`'s
  archive.

## Rollout (scripts: fm-agents /srv/agents/work/fm-563-prodrun-scripts)

- Compatibility and the worker installed 04:10-04:12 UTC; channel published against `35da231c`'s archive
  (`1e669403…`).
- Worker activated at 04:13:07 UTC with no running jobs.
- Web nodes one at a time, 04:14:05-04:29:16 UTC. Each passed every assert (FM-563: 10 samples served, mp4 3742627
  bytes) and came back behind the load balancer.
- Compatibility through the gate: it waited 21 min at 450-700 legacy-action/min, opened at 04:50:16 (392/min,
  load 0.9). Rolling replace at 04:50:18, 0 Node 500s and 0 worker exits in the 20 s after.

## Verification

- `current` is `46f4d9d0` on all 8 hosts. Readiness reports `46f4d9d0` 10/10. Compat's HTTP workers run from
  `/opt/firstmeasure/releases/46f4d9d0…/public/v1` with `RELEASE_ID=46f4d9d0…`.
- Plan checks through the load balancer: `exteriors.js` hashes to git blob
  `a9e32a345c3dd7f739cbcdb6d2ebe6abada36289` (6/6); all 10 `portal/samples/full-exterior/` files answer 200 with
  `image/jpeg` / `video/mp4` (was 302); the served manifest has `20261117-fm530-exterior-sequence` (and not the old
  key); `project-request/app.js` has `full_exterior_door_window_measurements`.
- The plan's `tests/exteriors-order-copy.test.mjs` on the files the first activated web node served: 7/7 pass; on
  `35da231c`'s files 1/7 (control).
- FM-530b harness on dev's page with production's served files substituted: desktop video step shows "View sample"
  (the sample walkaround plays), after a video "Continue to photos", the photos step shows the eight sample angles,
  What's included reads Roof & gutter / Door & window / Siding & trim. Phone: the recorder has the Upload tile and
  "Upload photos instead", which goes to Upload photos. (The rest of the phone script stopped on dev's two-structure
  sample address; not release-related.)
- 5xx from 04:52 UTC (after compatibility settled) to about 05:07, excluding health probes: web nodes 0.00-0.04 %
  (0-3 of ~7.6k each) against 0.05-0.09 % in the 30 minutes before; compatibility 0.20 % against 0.39 %. Every one is
  the pre-existing `top_view_reroll_proxy.php` 500.
- Compatibility, 04:51-05:14 (12 polls): 0 watchdog kills, 0 OOM kills, 0 Node 500s, 0 pool timeouts, one MainPID
  throughout, 2.1-2.4 GB available, 249-443 legacy-action/min.
- Worker, 04:13:07-05:07: 258 jobs completed, 0 failed; no "Worker stopping", browser-closed or pool-timeout
  errors. The queued `report.release` jobs are scheduled for later, none overdue.
- No customer order was placed as a test; a person confirms the order flow on production.

## Rollback

`/srv/agents/work/fm-563-prodrun-scripts/rollback/`: `release.sh worker`, `publish` (republishes `35da231c`'s
archive, PREVSHA `fe355095…`), `web_rollout.sh` (FM-561's asserts, base `46f4d9d0`; 93/93 pass on `35da231c`'s
archive), `release.sh compat` through the gate. Nothing is migrated; rolling back only switches the files.
