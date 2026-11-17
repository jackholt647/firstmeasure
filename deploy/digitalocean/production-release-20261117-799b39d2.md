# Production release 799b39d2: FM-532 (Exterior rejection handling), November 17, 2026

Released from fm-agents-1 by the FM-532 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The release is the plan commit as is: `799b39d2` on `claude/fm-532-exterior-rejection-handling-prod`, a direct child of
production-live `43b318fc` (record of release `955ca8de`, FM-530, production at the start of the run). Its three
commits match dev `a4681604`, `1768fb42` and lane `62cd80e5` line for line, except the files the plan re-did on
production's tree: the `?v=` lines in `firstmate-apps-manifest.js` and the language catalog (4 new `measurements`
keys, `measurements.30c8bc97962e9b0b.json`). Verified on dev in `platform-20261117202014-a1d0404d`,
`platform-20261117205614-bef3916a` and `measure-internal-20261117202057-21fa075c`.

## Change

- `public/v1/firstmeasure/api.ts` (Node): new staff reason `incorrect_footage` "Incorrect footage uploaded", refused
  for a roof order; Full Exterior copy for every rejection reason; a Full Exterior's rejection email says "Unable to
  complete Full Exterior report", and its footage reasons get a button to the project. Roof emails are unchanged.
- `public/libraries/apps/project-request/app.js`: My Projects' newer order record updates the browser's cached copy
  (the rejected order that would not open in a report-only org); a bare rejected order is that project's order; a
  missing order state can't fail the window; a route naming the open project's order matches it (phone hang).
- `public/libraries/apps/measurements/project.js`: the rejected card's reason, copy and "Upload the correct footage"
  for `incorrect_footage`; the manifest re-read keeps a rejected order's reason, copy and refund.
- `public/libraries/apps/project-map/app.js`: null guard in a Maps zoom callback.
- `firstmate-apps-manifest.js` `?v=` bumps; language catalogs (4 keys).
- Editor: `firstmeasure_node.php` default reasons, `portal_scripts/projects.js`, `editor_scripts/main.js` (footage
  reasons only for a Full Exterior order).
- Tests (not served): `public/v1/tests/exterior-rejection.test.ts`, `dev/exterior-rejection-reasons.test.cjs`.
- No data, environment, dependency, flag, nginx or config-library change. The Renton order (`exteriors_e1eb627b…`)
  keeps its stored reason (`no_satellite_image`); changing it would be a data change outside this release.

## Checks before release

- At 21:07 UTC `current` was `955ca8de` on all 8 hosts, root disks had ≥ 71 GB free, and no watch or gate processes
  were left over. Rollback target `955ca8de` was recorded on FM-532 before anything was built or activated, and the
  agent channel lock was posted.
- Built `799b39d2` on the dev worker (298 s). Archive sha256
  `7a9e0ec65c6c60373adce939b70cf9189b115e45edbb45df6ac4f4aa121c9b6f`.
- `fastpath.sh decide`: exit 3, full procedure (server changed; dependencies the same).
- `web_activate.py` keeps every earlier assert, repins the files this release changes (`project-request/app.js`,
  apps manifest, `measurements/project.js`, `project-map/app.js`, catalog `manifest.json`, the measurements catalog
  now `30c8bc97962e9b0b`) and the manifest `?v=` needles (FM-324, FM-400/455, FM-410, FM-383, FM-401), and adds
  FM-532's: served browser files equal to local, 4 `incorrect_footage` in `project.js`, the Full Exterior email title
  and `incorrect_footage` in `dist/firstmeasure/api.js`, and the three editor reason lists. All 87 file asserts pass
  on the archive and on compat's and the worker's installed tree; on `955ca8de`'s archive they fail (control).
- Plan test `tests/exterior-rejection.test.ts`: 16/16 on the release; with production's then-served
  `project-request/app.js` and `measurements/project.js` it fails 7/16 (control).

## Rollout (scripts: fm-agents /srv/agents/work/fm-532-prodrun-scripts)

- Compatibility and the worker installed; channel published against `955ca8de`'s archive (`042be6fc…`).
- Worker activated at 21:19:41 UTC with no running jobs.
- Web nodes one at a time, 21:20:54-21:33:47 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility through the gate: it waited 25 min at 440-915 legacy-action/min and opened at 21:59:26 (343/min,
  load 1.5). Rolling replace 21:59:27-22:00:03, 0 Node 500s and 0 exits in the 20 s after.

## Verification

- `current` is `799b39d2` on all 8 hosts. Readiness reports `799b39d2` 10/10. Compat's HTTP workers run
  `RELEASE_ID=799b39d2`.
- Served files over https://app.1m8.ai, 12/12 each, git blob = the plan's "after":
  `project-request/app.js` `68ca275c…`, `measurements/project.js` `91d51334…`, `project-map/app.js` `f1932f0d…`,
  `measure/internal/portal_scripts/projects.js` `cfc9c36f…`, `measure/internal/editor_scripts/main.js` `79ab0395…`.
- The two browser files served by the first activated web node are byte-identical to the release and pass the plan
  test 16/16.
- Node: `Unable to complete Full Exterior report` appears once in `current/public/v1/dist/firstmeasure/api.js` on
  compat and the worker. A read-only probe (`probe532_email.mjs`: the deployed email builder on a synthetic order, no
  database or customer data) gives "Unable to complete Full Exterior report" with the upload link for a Full
  Exterior rejected for incorrect footage and "Unable to complete roof report" for a roof, on both hosts; on
  `955ca8de` the Full Exterior gets the roof title (control).
- PHP on compat: `fm_default_rejection_reasons()` ends `insufficient_footage,incorrect_footage`.
- 5xx from 22:01 UTC (after compatibility settled), excluding health probes: web nodes 0.04-0.13 % (5-18 of
  ~12-15k each) against 0.04-0.07 % in the 30 minutes before; compatibility 0.77 % against 0.65 %. Nearly all are
  the pre-existing `top_view_reroll_proxy.php` 500s.
- Compatibility, 22:00-22:19: 0 OOM kills, 0 Node 500s, 0 pool timeouts, one MainPID, 0.7-2.4 GB available. One
  watchdog kill at 22:11:36 (the hour before the release had 4); the killed worker's open requests were
  `/v1/internal/users` and the referrals `publicAcquisitionLookup`, which this release doesn't touch.
- Worker, 21:19:41-22:20: 715 jobs completed, 5 failed, all `pdf.sync` for one customer exterior project
  (`exteriors_445c…`, "The face does not define a valid planar region"). The same project failed the same way at
  19:15 on `955ca8de`, and every file the PDF runtime loads (`pdf.js`, `exterior_geometry.js`, `exterior_pdf.js`,
  `dist/firstmeasure/pdf_runtime.js`) is byte-identical between the two releases. No "Worker stopping",
  browser-closed, pool-timeout or heartbeat errors. Queued jobs are `report.release` scheduled for later.
- No production login exists on fm-agents-1 and no real order was rejected to test; a person confirms the customer
  card and email on the next real rejection.

## Rollback

`/srv/agents/work/fm-532-prodrun-scripts/rollback/`: `release.sh worker`, `publish` (republishes `955ca8de`'s archive),
`web_rollout.sh` (FM-530's asserts with base `799b39d2`; all 84 pass on `955ca8de`'s archive), `release.sh compat`.
Rolling back restores the previous rejection copy, email and cards; no data depends on this release.
