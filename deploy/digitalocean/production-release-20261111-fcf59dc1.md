# Production release fcf59dc1: Settings › Materials only with the Materials app (FM-394), November 11, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. FM-394's plan branch
`claude/fm-394-fix-prod` is one commit on release `99cfd8be` (FM-393) and was taken as is:

| Commit | Change | Same diff as (verified on dev) |
| --- | --- | --- |
| `fcf59dc1` | FM-394: Settings › Materials only with the Materials app (platform.materials) | `ed68e984` line for line, in `platform-20261111173244-17f20248` |

## Change

- `public/libraries/apps/materials/settings.js`: `sections()` returns nothing when the organization does not have the
  Materials app (`platform.materials`), so Settings has no Materials section (`company.js` `canMaterials`) and
  `mountInline` mounts nothing. Until now the **Calculations** sub-tab checked only `apps.firstmeasure` and
  `manage_report_settings` + `manage_company_settings`, so every FirstMeasure organization's owners and admins saw a
  Materials tab with just Calculations. Calculations stays in Settings › Reports › Default materials and labor. With
  the app on, nothing changes.
- Plus a regression case in `public/v1/tests/materials-settings-browser.test.mjs` (not served). Diff from `99cfd8be`:
  2 files. No Node server, PHP, environment, flag, nginx, dependency, config-library or database change; no data
  migration or repair. `portal/index.php` versions the script by content hash, so pages ask for
  `settings.js?v=1a23dff2277d50b7` after the switch; no manifest `?v=` bump.
- Flags (read only, from the plan): of 14,097 production organizations only the internal "Test Company"
  (`is_test`) has `platform.materials` on; default off, no rollout, no overrides. No flag was changed.

## Checks before release

- At 18:02 UTC every host's `current` was `99cfd8be`. The rollback target `99cfd8be` was recorded on FM-394 before
  anything was activated.
- The commit's diff equals the dev-verified `ed68e984` line for line; the file's sha256 goes from `a6c97b1b…` to
  `1a23dff2277d50b78f837a35b6746781b2800a4db54f18ec1c55b4b252891841`.
- Build on the dev worker (`npm run check` included) took 306 s, from a bundle `fcf59dc1 ^99cfd8be`. Archive sha256
  `6ecb19d0021a150f8c9739117433a3e67d7889d207f7ebc5e21a57ae26c522b6`, verified on fm-agents, compatibility, the
  worker and each web node.
- Fast path (`fastpath.sh decide`): exit 3, full procedure. Server and dependencies identical; the two changed files
  (`public/libraries/apps/materials/settings.js`, the test) are outside the static-only folders, so the fingerprint
  counts them as Node's.
- `web_activate.py` keeps every earlier assert and adds FM-394: `settings.js` in the served-asset list, its sha256
  pinned to `1a23dff2…`, the bytes served on the node equal to the file, and
  `if (!flag('platform', 'materials')) return [];` once. All 47 file asserts passed on the extracted archive and on
  the installed trees on compatibility and the worker.
- Control: `materials-settings-browser.test.mjs` run against the file production served before (`a6c97b1b…`) fails
  the FM-394 case (2/3).

## Rollout (scripts: fm-agents /srv/agents/work/fm-394-prodrun-scripts)

- Worker first, at 18:12:58 UTC (no running jobs; 8 slots, production, heartbeat off, outbound email on).
- The signed channel was published from compatibility against `474430f1…` (`99cfd8be`'s archive), and the six web
  nodes went one at a time behind the load balancer, 18:14:07–18:26:58 UTC. Each passed every assert and returned
  behind the load balancer on `fcf59dc1`.
- Compatibility last, through the gate: it opened at once at 18:28:37 (382 `legacy-action`/min, load 1.6). The
  activation printed `(rolling replace)`, complete in 37.9 s; MainPID unchanged (2266335), both HTTP workers new with
  `RELEASE_ID=fcf59dc1…` and cwd in the new release. In the 20 s after: 0 Node 500s, 0 HTTP worker exits.

## Verification

- `current` is `fcf59dc1164da3a25012637a2d0ce97240334702` on all 8 hosts; readiness reports `fcf59dc1` 10/10 after
  the web rollout, after compatibility, and at 18:51.
- `https://app.1m8.ai/libraries/apps/materials/settings.js` serves sha256 `1a23dff2…` 12/12 over the load balancer.
  The portal's own `portalAssetVersion()` on a switched node gives `1a23dff2277d50b7` (old node: `a6c97b1bd05e23cf`).
- Plan proof: the bytes the first activated node served, copied into a detached worktree of `fcf59dc1` (`git status`
  clean, so byte-identical), pass `materials-settings-browser.test.mjs` 3/3, including a FirstMeasure organization
  with the price book, every permission and Materials off getting no section and `mountInline` mounting nothing.
- Compatibility watch from 18:28:38 to 18:50 (21 min): 0 watchdog kills, 0 Node 500s, 0 pool timeouts; MainPID
  2266335 throughout; `legacy-action` 375–579/min, load 0.7–2.3. Worker from 18:12:58 to 18:51: 614 jobs completed,
  0 failed.
- 5xx from 18:30 (compatibility settled) against the 30 min before: web 0.04–0.09 % per node against 0.10–0.16 %,
  compatibility 0.67 % against 0.82 %; every one `top_view_reroll_proxy.php` (long-standing). Nothing on the release's
  file.

## Seen during the run, not caused by it

Compatibility had 5 HTTP-worker watchdog kills from 18:03 to 18:16 UTC, before anything here was activated (worker
18:12:58, compatibility 18:28:38). The first two followed FM-393's `GET /v1/internal/crm/referrals/acquisition/export`
on the same worker by about 30 s (18:02:41, 18:03:44): the export appears to hold the event loop until the heartbeat
deadline, so neither export finished. The other three had `legacy-action` / `publicAcquisitionLookup` in flight. Reported on
FM-393 and the agent channel. This release does not change compatibility's server code, and the watch after its
activation had 0 kills.

## Rollback

`/srv/agents/work/fm-394-prodrun-scripts/rollback/` (the same scripts reversed to `99cfd8be`; the channel republishes
`99cfd8be`'s archive from `/var/tmp/firstmeasure-release-99cfd8be/` on compatibility, against `6ecb19d0…`). Rolling
back brings the Calculations-only Materials tab back for FirstMeasure organizations; there is no data to undo.
