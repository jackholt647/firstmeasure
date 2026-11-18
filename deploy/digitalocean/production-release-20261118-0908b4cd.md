# Production release 0908b4cd: FM-532 round 3 (Full Exterior rejection review), November 18, 2026

Released from fm-agents-1 by the FM-532 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The release is the plan commit as is: `0908b4cd` on `claude/fm-532-exterior-rejection-handling-prod`, a child of
production-live `960f5a07` (record of release `46f4d9d0`, FM-563, production at the start of the run). It is one
cherry-pick of dev `3a19d79e`. The code diff of `api.ts`, `exteriors.ts`, `measurements/project.js`,
`projects/viewer.js`, the test and `catalog-source.json` is identical to the dev commit (checked line for line). The two
`?v=` lines in the apps manifest and the measurements catalog were redone on production's tree. Verified on dev in
`platform-20261118052450-5ba4bc93` (FM-532 comments, every reason on desktop and phone, and the emails).

## Change

- `public/v1/firstmeasure/api.ts` (Node):
  - Full Exterior *No satellite image* copy no longer says "A Full Exterior report measures the roof from aerial
    imagery…".
  - A Full Exterior rejected as *Incorrect structure type* says "It seems to be a commercial (multi-family) building
    and we currently don't offer exterior reports for commercial (multi-family) buildings."
  - For that case the reject route stores no `reorder_url` or `rejection_reorder`, and the email has no reorder link.
  - Roof rejections are unchanged.
- `public/v1/firstmeasure/exteriors.ts`: `fullExteriorOffered()` (residential only), used by `requireExteriorAccess`.
  Behaviour is the same.
- `public/libraries/apps/measurements/project.js` (browser):
  - The card offers no "Reorder as …" for a Full Exterior of a type that isn't offered, and shows the sentence above,
    including on orders rejected before this release.
  - It drops the stored aerial sentence when it shows older copy.
  - A rejected order's Summary has a "Why it was rejected" box with the reason, the explanation, the refund and the
    card's buttons.
- `public/libraries/apps/projects/viewer.js`: the older viewer offers no "Reorder as …" for a Full Exterior.
- `firstmate-apps-manifest.js`: `projects/viewer.js` → `20261118-fm532-no-exterior-type-reorder`,
  `measurements/project.js` → `20261118-fm532-summary-reason`.
- Language: one new `measurements` key. The catalog is now `measurements.995c2a75019d3b07.json`, and
  `catalog-source.json`, `coverage.json` and the catalog `manifest.json` changed with it.
- `tests/exterior-rejection.test.ts` (20 tests).
- No data, environment, dependency, flag, nginx, config-library or editor (`measure/internal`) change.

## Checks before release

- At 05:3x UTC, `current` was `46f4d9d0` on all 8 hosts. Root disks had ≥ 69 GB free, no watch or gate processes were
  left over and no other run was live. Rollback target `46f4d9d0` was recorded on FM-532 before anything was built or
  activated, and the agent channel lock was posted.
- Built `0908b4cd` on the dev worker (278 s). Archive sha256
  `b3690b6d3922dbe42f85a02f3c23a478dca41a755636a99c1a43f39dced3385e`. The extracted tree differs from `46f4d9d0`'s
  only in the files above, their compiled `dist/` files, `release.env` and the previous record.
- `fastpath.sh decide`: exit 3, full procedure (server changed).
- `web_activate.py` = FM-563's with one sed pass. Repinned:
  - the apps manifest, `measurements/project.js` and catalog `manifest.json` digests;
  - the FM-400 manifest needle (`20261118-fm532-summary-reason`);
  - the FM-410 measurements catalog name and digest.

  Added FM-532 round 3's assert: both browser files' digests and needles served; the manifest keys;
  `we currently don't offer exterior reports for` once and `as well as your footage` never in `dist/firstmeasure/api.js`;
  `fullExteriorOffered` in `dist/firstmeasure/exteriors.js`. All 101 file asserts pass on the archive and fail on
  `46f4d9d0`'s (control). The rollback asserts (FM-563's) pass 97/97 on `46f4d9d0`'s archive.
- Email-builder probe (`probe532c_email.mjs`: the release's `dist` functions in a vm, synthetic orders, no database).
  On `46f4d9d0` (control), a Full Exterior *No satellite image* has the aerial line, and a Full Exterior
  commercial/multi-family has a reorder link. On `0908b4cd` (extracted, then installed but inactive on the worker):
  - no aerial line;
  - commercial and multi-family get the new sentence and no link;
  - a roof keeps "Reorder as commercial";
  - incorrect footage keeps "Upload the correct footage".
- The plan test in a detached worktree of the release passes 20/20. With `46f4d9d0`'s two browser files it passes 13/20
  (control).

## Rollout (scripts: fm-agents /srv/agents/work/fm-532c-prodrun-scripts)

- Compatibility and the worker installed 05:45-05:47 UTC.
- Worker activated at 05:47:25 UTC with no running jobs. Channel published against `46f4d9d0`'s archive
  (`fe355095…`).
- Web nodes one at a time, 05:48:24-06:01:35 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility through the gate: it opened at once at 06:01:44 (246 legacy-action/min, load 0.6). Rolling replace at
  06:01:45, with 0 Node 500s and 0 worker exits in the 20 s after.

## Verification

- `current` is `0908b4cd` on all 8 hosts, and readiness reports `0908b4cd` 10/10. Compat's HTTP workers run
  `RELEASE_ID=0908b4cd…`. The cluster primary keeps the release it started in, by design of the rolling replace.
- Served through the load balancer, 12/12 each, git blob = the plan's "after":
  - `measurements/project.js` `8aa9dc50`;
  - `projects/viewer.js` `257e690b`;
  - `firstmate-apps-manifest.js` `bbf20443`;
  - catalog `manifest.json` `dd359b6c`;
  - `measurements.995c2a75019d3b07.json` `17f400ab`.
- The plan test on the two browser files the first activated web node served (byte-identical to the release): 20/20.
- Node on compat and the worker:
  - `we currently don't offer exterior reports for` once and `as well as your footage` 0 times in
    `current/public/v1/dist/firstmeasure/api.js`;
  - `Unable to complete Full Exterior report` once;
  - the email-builder probe on `current` gives the results above.
- 5xx from 06:03:45 UTC (after compatibility settled) to about 06:18, excluding health probes:
  - web nodes 0.00-0.04 % (0-2 of ~4.5k each), against 0.01-0.02 % in the 30 minutes before;
  - compatibility 0.21 %, against 0.31 %;
  - every one is the pre-existing `top_view_reroll_proxy.php` 500.
- Compatibility, 06:02-06:20 (2-minute polls): 0 watchdog kills, 0 OOM kills, 0 Node 500s, 0 pool timeouts. One
  MainPID throughout, 2.4-2.7 GB available, 215-291 legacy-action/min.
- Worker, 05:47:25-06:18: 61 jobs completed, 0 failed. No "Worker stopping", browser-closed, pool-timeout or heartbeat
  errors. No rejection was made in the window, so no rejection email was sent.
- No order was rejected as a test, and no production data was changed. A person confirms the card and the email on the
  next real Full Exterior rejection.

## Rollback

`/srv/agents/work/fm-532c-prodrun-scripts/rollback/`:
- `release.sh worker`;
- `publish`, which republishes `46f4d9d0`'s archive (PREVSHA `b3690b6d…`);
- `web_rollout.sh`, with FM-563's asserts and base `0908b4cd` (97/97 pass on `46f4d9d0`'s archive);
- `release.sh compat`, through the gate.

Nothing is migrated: rolling back only switches the files.
