# Production release 633e5c23: FM-457 (pin limit by project type), November 18, 2026

Released from fm-agents-1 by the FM-457 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The release is the plan commit as is: `633e5c23` on `claude/fm-457-incorrect-pin-limit-prod`, a child of production-live
`774dc035` (record of release `7747d91e`, FM-566, production at the start of the run). On top of production-live it
carries `ad6a7ba2` (the production form of canonical `99c49e41`), two merges of production-live into the plan branch and
a manifest `?v=` bump. `project-map/app.js` and `tests/project-pin-limit.test.mjs` are byte-identical to canonical.
Verified on dev in `platform-20261116203851-4fa70ca3` and again on 11/18 in `8aea6e58` (FM-457 comments).

Why it was needed: production still had the 11/14 fix (`if (!normalized) return MAX_PINS_PER_STRUCTURE_REPORT;`),
so a new project request with no type took 10 pins. The Router's 11/16 "this is in production" notes matched the
older commits, not this fix.

## Change

- `public/libraries/apps/project-map/app.js` and `public/libraries/apps/project-request/app.js`: `maxPinsForType('')`
  goes from 10 to 5 (`if (!normalized || normalized === 'residential') return MAX_PINS_RESIDENTIAL;`). With no type
  chosen, the 6th pin is refused with "Maximum of 5 pins per report. Remove a pin to place a new one." Residential (5)
  and Commercial/Multi-family (10) are unchanged.
- `public/libraries/apps/firstmate-apps-manifest.js`: `project-request/app.js` and `project-map/app.js` →
  `20261118-fm457-pin-limit-prod` (were `20261118-fm567-order-tray-prod` and `20261117-fm532-zoom-guard`).
- `public/v1/platform/api.ts` `portalPinLimitForType`: an empty type gives 5, the same as residential (the queue
  already turned a missing type into residential before the check, so this changes nothing in practice).
- `tests/project-pin-limit.test.mjs` (8 tests).
- No data, environment, dependency, flag, nginx, config-library, language catalog or editor change.

## Checks before release

- At 18:28 UTC, `current` was `7747d91e` on all 8 hosts. Root disks had ≥ 68 GB free, no watch or gate processes were
  left over, and no other production run was live. Rollback target `7747d91e` was recorded on FM-457 before anything
  was built or activated, and the agent channel lock was posted.
- Built `633e5c23` on the dev worker (291 s). Archive sha256
  `342e8b2d8b3df762f86e2c7cf3c1895452441a6c1ec83087442a8a7a682eb7e7`. The extracted tree differs from `7747d91e`'s
  only in the four files above, the compiled `dist/platform/api.js`, `release.env` and the two previous records.
- Full procedure: `api.ts` is Node code.
- `web_activate.py` = FM-567's with one sed pass. Repinned:
  - the FM-324/376 `project-request/app.js` + manifest digest pair, and the FM-563 `project-request/app.js` digest;
  - the FM-457 (102b43b8) `project-map/app.js` digest, and its old needle
    `if (!normalized) return MAX_PINS_PER_STRUCTURE_REPORT;` 1 → 0;
  - FM-566's `scene_3d.js` digest (FM-566 was a fast path);
  - the FM-324 and FM-563 manifest `?v=` needles.

  Added this release's assert: both browser files served equal to the release, each with the 5-pin line ×1 and the old
  line ×0; the manifest has `20261118-fm457-pin-limit-prod` ×2 and neither old key; `portalPinLimitForType` in
  `dist/platform/api.js` has `!normalized || normalized === "residential"`. All 107 file asserts pass on the archive
  and on compat's and the worker's installed trees, and fail on `7747d91e`'s (control). The rollback asserts pass
  103/103 on `7747d91e`'s archive.
- The plan test passes 8/8 on the archive's files and 3/8 on the files production served before (control).

## Rollout (scripts: fm-agents /srv/agents/work/fm-457-prodrun-scripts)

- Compatibility and the worker installed at 18:39 UTC.
- Worker activated at 18:40:44 UTC, with no running jobs. Channel published against `7747d91e`'s archive
  (`82e70ba5…`).
- Web nodes one at a time, 18:41:51-18:55:22 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility through the gate. It waited 96 min (428-1244 legacy-action/min, 18:55-20:31 UTC Wednesday) and
  opened at 20:31:13. Rolling replace at 20:31:14, with 0 Node 500s and 0 worker exits in the 20 s after.

## Verification

- `current` is `633e5c23` on all 8 hosts, and readiness reports `633e5c23` 10/10 (HTTP 200). Compat's HTTP workers
  run `RELEASE_ID=633e5c23…`; the cluster primary keeps the release it started in (`efc0bdc4`), by design.
- Served through the load balancer (12/12 each): `project-map/app.js`, `project-request/app.js` and the apps manifest
  equal the release; each app file has the 5-pin line once and the old line 0 times; the manifest has the new key twice.
- The plan test on the files production serves (plus the live `api.ts`): 8/8 (3/8 before the release).
- 5xx (excluding health probes), from 20:33 UTC (after compatibility settled):
  - web nodes: 0.08-0.12 % (13-20 of ~17k each), against 0.04-0.07 % in the 30 minutes before. All but 2-5 per node
    are the pre-existing `top_view_reroll_proxy.php` 500; the rest are `/v1/internal/legacy-action` and
    `/v1/internal/users` requests dropped at 20:44:25 by the compat watchdog kill below, plus the pre-existing
    acquisition-track 500s;
  - compatibility: 0.76 % (71 of 9,324), against 0.61 % (105 of 17,322) before, mostly `top_view_reroll_proxy.php`.
- Compatibility, 20:31-20:59 (2-minute polls): 2 watchdog kills, both of the freshly started slot-2 HTTP worker
  (20:44:25 and 20:53:30) at 550-870 legacy-action/min with the database pool saturated; 0 OOM kills, 0 Node 500s
  outside those kills, 0 pool timeouts after activation, one MainPID, 1.1-1.3 GB available. Baseline today on the
  earlier releases: kills at 15:34 (2), 15:46, 16:01, 18:02 and 19:15 (2). The 7 pool timeouts at 20:30:55 were in an
  old-release process, before activation. The release's only Node change is `portalPinLimitForType`, which is not
  on that path, so it was not rolled back.
- Worker, 18:40:44-20:59: 2,023 jobs completed, 0 failed; no "Worker stopping", browser-closed or pool-timeout errors.
  The 328 queued jobs are scheduled `report.release` jobs, none due.
- No request was placed as a test, and no production data was changed. A person confirms the flow on production.

## Rollback

`/srv/agents/work/fm-457-prodrun-scripts/rollback/`:
- `release.sh worker`;
- `publish`, which republishes `7747d91e`'s archive (PREVSHA `342e8b2d…` = this release's archive);
- `web_rollout.sh`, with FM-567's asserts plus FM-566's `scene_3d.js` pin and base `633e5c23` (103/103 pass on
  `7747d91e`'s archive);
- `release.sh compat`, through the gate.

Nothing is migrated, so rolling back only switches the files.
