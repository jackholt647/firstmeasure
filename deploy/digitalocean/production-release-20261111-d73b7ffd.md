# Production release d73b7ffd: Reports › Default materials and labor only with the Materials app (FM-394 follow-up), November 11, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. FM-394's second plan branch
`claude/fm-394-disable-materials-setting-prod` is one commit on `production-live` `79ae89d6` (the record of release
`fcf59dc1`, whose tree it equals apart from release records) and was taken as is:

| Commit | Change | Same diff as (verified on dev) |
| --- | --- | --- |
| `d73b7ffd` | FM-394: Reports › Default materials and labor only with the Materials app (platform.materials) | `40b456b8` line for line (only hunk offsets differ), in `platform-20261111202356-150e3533` |

## Change

- `public/libraries/apps/settings/company.js`: `canReportDefaults = canReports && appFlag('platform', 'materials')`.
  Without the Materials app, Settings › Reports has no "Report settings / Default materials and labor" sub-tab row,
  only the report settings, and `measurement-defaults.js` is never loaded. Release `fcf59dc1` had removed
  Settings › Materials, but the same Calculations editor was still shown to every FirstMeasure organization as
  Settings › Reports › Default materials and labor (since `96b87085`, Oct 22).
- `public/libraries/apps/settings/search.js`: `registerExclusion(fn)`, applied to every search caller (Settings
  sidebar and top bar).
- `public/libraries/apps/materials/settings.js`: registers the exclusion, so Settings search hides Reports
  `view: defaults` and every `measurement-defaults.js` entry unless `platform.materials` is on.
- Plus `docs/architecture/requirements.md`, `docs/architecture/settings-search.md` and a regression case in
  `public/v1/tests/materials-settings-browser.test.mjs` (none served). No Node server, PHP, environment, flag, nginx,
  dependency, config-library or database change; the server route `materials/measurement-defaults.ts` and stored
  defaults are untouched; no data migration or repair. `portal/index.php` versions all three scripts by content
  hash; no manifest `?v=` bump.
- Flags (read only, from the plan): production `platform.materials` is on only for the internal "Test Company"
  (`is_test`). No flag was changed.

## Checks before release

- At 20:29 UTC every host's `current` was `fcf59dc1`, and readiness reported `fcf59dc1`. The rollback target
  `fcf59dc1` was recorded on FM-394 before anything was activated.
- The commit's diff equals the dev-verified `40b456b8` (only blob ids and hunk offsets differ). sha256:
  `company.js` `08de6e07…` → `8a1a2fba619b01faa4335b977cc646fba289f4d775b97c84561ad7f3aebe5673`, `search.js`
  `c36ba444…` → `635b972f7ec93a087f91d06b8eeb8de7fbdfb3f7641a6f5223015eaf88f3e1a3`, `materials/settings.js`
  `1a23dff2…` → `5e8616d40b57e3fdbb7ad2e85395cdf7c575e3953f57784deea0e52edb7e47fa`, as in the plan.
- Build on the dev worker took 280 s, from a bundle `d73b7ffd ^fcf59dc1`. Archive sha256
  `502b05a23889cf1abd0bc100b901b30d5e0ab4154a6f48ab7d90542d333042b9`, verified on fm-agents, compatibility, the
  worker and each web node.
- Fast path (`fastpath.sh decide`): exit 3, full procedure. Server and dependencies identical; the three
  `public/libraries/` files count as Node's, and the test under `public/v1/tests/` as configuration.
- `web_activate.py` keeps every earlier assert. The FM-394 one now pins `materials/settings.js` to `5e8616d4…` and
  still requires `if (!flag('platform', 'materials')) return [];` once. It adds `registerExclusion` and the
  `view === 'defaults'` exclusion once, `company.js` (`8a1a2fba…`, the `canReportDefaults` line once) and
  `search.js` (`635b972f…`, `registerExclusion` once), each equal to the bytes served on the node. All 47 earlier
  file asserts passed on the extracted archive; the three new hashes matched there and in the installed trees on
  compatibility and the worker. `portalAssetVersion()` on the extracted tree gives `8a1a2fba619b01fa`,
  `635b972f7ec93a08` and `5e8616d40b57e3fd`.
- Control: `materials-settings-browser.test.mjs` in a detached worktree of `d73b7ffd`, with the four files production
  served before the release (`company.js`, `search.js`, `search-index.js`, `materials/settings.js`, all equal to
  `fcf59dc1`'s), fails the new case "Settings › Reports shows Default materials and labor, and search finds it, only
  with the Materials app" (3/4). With the release's files it passes 4/4.

## Rollout (scripts: fm-agents /srv/agents/work/fm-394b-prodrun-scripts)

- Worker first, at 20:39:44 UTC (no running jobs; 8 slots, production, heartbeat off, outbound email on).
- The signed channel was published from compatibility against `6ecb19d0…` (`fcf59dc1`'s archive), and the six web
  nodes went one at a time behind the load balancer, 20:40:49–20:54:23 UTC (~94 s each). Each passed every assert
  and returned behind the load balancer on `d73b7ffd`.
- Compatibility last, through the gate: it waited 34 min at 480–850 `legacy-action`/min and opened at 21:28:54
  (391/min, load 1.3). The activation printed `(rolling replace)`; MainPID unchanged (2416619), both HTTP workers new
  with `RELEASE_ID=d73b7ffd…` and cwd in the new release. In the 20 s after: 0 Node 500s, 0 HTTP worker exits.

## Verification

- `current` is `d73b7ffd8ce0db6b6e1dd8e34797cdef168ac8fa` on all 8 hosts; readiness reports `d73b7ffd` 10/10 after
  the web rollout and after compatibility.
- Over the load balancer, `company.js`, `search.js` and `materials/settings.js` each serve the new sha256 12/12. On a
  switched node, the portal's own `portalAssetVersion()` gives `8a1a2fba619b01fa`, `635b972f7ec93a08` and
  `5e8616d40b57e3fd`, which `/portal/` puts in its `?v=`.
- Plan proof: the four files the first activated node served (64.23.240.81, `Host: app.1m8.ai`), copied into the
  detached worktree of `d73b7ffd` (`git status` clean, so byte-identical), pass `materials-settings-browser.test.mjs`
  4/4. That includes the new case: a FirstMeasure organization with the price book, every permission and Materials
  off has no Reports sub-tabs, and search finds nothing for "Default materials and labor", "Default materials",
  "Default labor" or "Base %". With Materials on, the tabs and results come back.
- Compatibility watch from 21:28:55 to 21:50 (21 min): 0 watchdog kills; MainPID 2416619 throughout;
  `legacy-action` 464–891/min, load 1.3–3.4. One burst of 4 Postgres pool timeouts (4 Node 500s after ~10.5 s) at
  21:45:30, at 780/min. That is the long-standing pool-exhaustion pattern: the same journal has 22 in the 16:00 UTC
  hour and 55 in the 19:00 UTC hour, before this release. The release does not change compatibility's server code.
- Worker from 20:39:44 to 21:52: 868 jobs completed, 0 failed; no "Worker stopping", no "browser has been closed".
  The 121 queued jobs are scheduled `report.release` jobs, none overdue (317 were queued before activation).
- 5xx from 21:30:30 (compatibility settled) against the 30 min before: web 0.04–0.09 % per node against
  0.04–0.07 %, compatibility 0.71 % against 0.67 %; almost all `top_view_reroll_proxy.php` (long-standing). During
  the web rollout (from 20:40) web was 0.05–0.12 % against 0.06–0.08 %. Nothing on the release's files.
- Readiness 10/10 on `d73b7ffd` again at 21:52.

## Rollback

`/srv/agents/work/fm-394b-prodrun-scripts/rollback/`: the same scripts reversed to `fcf59dc1` (the forward
`web_activate.py`/`worker_activate.py` of release `fcf59dc1` with `base` set to `d73b7ffd`). The channel republishes
`fcf59dc1`'s archive from `/var/tmp/firstmeasure-release-fcf59dc1/` on compatibility, against `502b05a2…`.
Rolling back brings Settings › Reports › Default materials and labor back for every FirstMeasure organization;
there is no data to undo.
