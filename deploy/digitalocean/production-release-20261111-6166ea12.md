# Production release 6166ea12: report type names translated (FM-396), November 11, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. FM-396's plan branch
`claude/fm-396-translate-report-types-prod` is one commit on `production-live` `40834c0e` (the record of release
`d73b7ffd`) and was taken as is:

| Commit | Change | Same diff as (verified on dev) |
| --- | --- | --- |
| `6166ea12` | FM-396: Translate report type names (Roof, Roof & Gutters, Full Exterior) | `176abfd2` in its additions (only the context line before them differs), in `platform-20261111223149-e7ce5a96` |

## Change

- The report type names use hand-named language keys (`firstmeasure.ext_scope_roof`, `ext_full_exterior`,
  `projects.report_kind_roof`, `report_kind_roof_and_gutters`, `report_kind_full_exterior`, ...) that were never in
  `catalog-source.json` or the language packs, so every language showed the English text from the code: the order
  chooser ("Roof" / "Full Exterior") and the blue tag on My projects ("ROOF") for a German organization.
- `public/v1/platform/localization/catalog-source.json` and the 15 `packs/*.json`: 18 report type keys with
  translations (German: Dach, Dach und Dachrinnen, Gebäudehülle, Gebäudehüllenbericht).
- `public/libraries/platform-language/catalogs/`: rebuilt from production-live's own sources. `manifest.json` now
  names `billing.160f88fa588ba4a7`, `firstmeasure.d7dea9a3ff583176`, `measurements.08bcc1e2491856ba`,
  `project-request.d78d9d03ae985fa3`, `projects.5c976e67db186e02` (new files; the previous hashed files stay for
  frozen snapshots). `coverage.json` count.
- Plus `public/v1/tests/report-type-labels-localization.test.mjs` and a paragraph in `docs/platform-localization.md`
  (neither served). No app JavaScript, Node server code, PHP, environment, flag, nginx, dependency, config-library or
  database change; no data repair.

## Checks before release

- At 22:43 UTC every host's `current` was `d73b7ffd`, and readiness reported `d73b7ffd`. The rollback target
  `d73b7ffd` was recorded on FM-396 before anything was activated.
- Build on the dev worker took 298 s, from a bundle `6166ea12 ^d73b7ffd`. Archive sha256
  `309cd00ffcfb853c6330e19d4b234cca888292930e6891bf1540d90378fe555c`, verified on fm-agents, compatibility, the
  worker and each web node.
- Fast path (`fastpath.sh decide`): exit 3, full procedure. Server and dependencies identical; the catalogs under
  `public/libraries/` are read by Node (`platform/localization/server.ts`, the offline asset set).
- `web_activate.py` keeps every earlier assert and adds FM-396: `manifest.json` (`c3da6499…`) and the five new
  namespace files (`c7c598c5…`, `d98a71cd…`, `d7a775ad…`, `9438718a…`, `1ed95027…`) equal to the plan commit and to
  the bytes the node serves; the manifest names the new `projects`/`firstmeasure` files; de-DE `report_kind_roof` =
  Dach, `report_kind_full_exterior` = Gebäudehülle, `ext_scope_roof` = Dach, `ext_full_exterior` = Gebäudehülle;
  the old `projects.262e3642a5822147.json` is still present. All 48 file asserts passed on the extracted archive; the
  installed trees on compatibility and the worker had the same catalog hashes.
- Control: before the release production served `projects.262e3642a5822147.json` with no de-DE `report_kind_roof`,
  and `projects.5c976e67db186e02.json` was not there (302). `report-type-labels-localization.test.mjs` in a
  detached worktree of `6166ea12` with `d73b7ffd`'s catalog manifest and localization sources fails 0/4.

## Rollout (scripts: fm-agents /srv/agents/work/fm-396-prodrun-scripts)

- Worker first, at 22:54:26 UTC (no running jobs; 8 slots, production, heartbeat off, outbound email on).
- The signed channel was published from compatibility against `502b05a2…` (`d73b7ffd`'s archive), and the six web
  nodes went one at a time behind the load balancer, 22:55:32–23:08:47 UTC (~2 min each). Each passed every assert
  and returned behind the load balancer on `6166ea12`.
- Compatibility last, through the gate, which opened at once at 23:09:05 (373 `legacy-action`/min, load 1.2). The
  activation printed `(rolling replace)`; MainPID unchanged (2416619), both HTTP workers new with
  `RELEASE_ID=6166ea12…` and cwd in the new release. In the 20 s after: 0 Node 500s, 0 HTTP worker exits.

## Verification

- `current` is `6166ea12f956c11141318dcaf15a225c7c8cd09d` on all 8 hosts; readiness reports `6166ea12` 10/10.
- Over the load balancer the catalog manifest names `projects.5c976e67db186e02.json` 12/12, and all six changed
  catalog files serve the archive's sha256. de-DE: `report_kind_roof` Dach, `report_kind_roof_and_gutters` Dach und
  Dachrinnen, `report_kind_full_exterior` Gebäudehülle; `ext_scope_roof` Dach, `ext_full_exterior` Gebäudehülle.
- Plan proof: the six catalog files the first activated node served (64.23.240.81, `Host: app.1m8.ai`), copied into
  the detached worktree of `6166ea12` (`git status` clean, so byte-identical), pass
  `report-type-labels-localization.test.mjs` and `project-report-kind-tag.test.mjs` 6/6.
- During the web rollout, nodes still on `d73b7ffd` answered 302 (not found) to 53 requests for the new catalog file
  names (browsers that already had the new manifest); the last at 23:06:12, before the last node switched, none
  after. Those pages showed that namespace in English until reloaded. The previous hashed files stayed in the
  release, so no request for an old name failed.
- Compatibility watch from 23:09:06 to 23:31 (22 min): 0 watchdog kills, 0 Node 500s, 0 Postgres pool timeouts;
  MainPID 2416619 throughout; `legacy-action` 322–499/min, load 1.0–1.8.
- Worker from 22:54:26 to 23:32: 453 jobs completed, 0 failed; no "Worker stopping", no "browser has been closed",
  no pool timeouts. The 414 queued jobs are scheduled `report.release` jobs, none overdue.
- 5xx from 23:10:30 (compatibility settled) against the 30 min before: web 0.03–0.10 % per node against
  0.03–0.10 %, compatibility 0.69 % against 0.74 %; almost all `top_view_reroll_proxy.php` (long-standing). Three
  500s on `/v1/public/firstmeasure/reports` around 23:30 were a caller sending invalid JSON
  (`FST_ERR_CTP_INVALID_JSON_BODY`); the release does not change server code. During the web rollout (from 22:55:30)
  web was 0.03–0.09 % against 0.04–0.09 %.
- Readiness 10/10 on `6166ea12` again at 23:32.

## Rollback

`/srv/agents/work/fm-396-prodrun-scripts/rollback/`: the same scripts reversed to `d73b7ffd` (the forward
`web_activate.py`/`worker_activate.py` of release `d73b7ffd` with `base` set to `6166ea12`). The channel republishes
`d73b7ffd`'s archive from `/var/tmp/firstmeasure-release-d73b7ffd/` on compatibility, against `309cd00f…`.
Rolling back only brings back the English report type names; there is no data to undo.
