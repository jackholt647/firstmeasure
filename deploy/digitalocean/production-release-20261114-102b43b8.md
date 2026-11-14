# Production release 102b43b8: batch FM-457 (pin limit), FM-405 (roof rendering), FM-401 (report pitch), FM-383 (held reports), November 14, 2026

Released from fm-agents-1 by the FM-457 batch production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. Jack approved FM-383's production release on
2026-11-12 (comment on FM-383).

The release starts from `production-live` `2c07dda6` (the record of release `29855eb0`, FM-455, production at the start of
the run) and merges each plan's production branch in turn, with `--no-ff`. All four merged with no conflict. Two files are
changed by more than one plan, and in each the release's `+/-` lines are exactly the union of the plans' lines:
`project-map/app.js` (FM-457, FM-383) and the apps manifest (FM-401 `settings/company.js` key, FM-383 `measurements/project.js` key).
Every other changed file is byte-identical to its plan branch. Nothing outside the four plans is in the release.

| Merge | Plan branch (tip) | Commits | Same change as (verified on dev) |
| --- | --- | --- | --- |
| `253a80da` | `claude/fm-457-incorrect-pin-limit-prod` (`a3ef7fd0`) | `69f2419a`, `a3ef7fd0` | canonical `5c3dfdf7`, `55ee4ca4`; dev `platform-20261114060323-1d35f28c` |
| `0981b61f` | `claude/fm-405-roof-rendering-issue-prod3` (`5981c2bb`) | `60de565f`, `3c0846ad`, `5981c2bb` | dev `87d4e452`, lane `950cebd3`, dev `4875b1bf`; `platform-20261112185958-945b5632`, `measure-internal-20261112190652-a3f657a5`, `platform-20261114061659-cf6ed9ef` |
| `2c3f36d7` | `claude/fm-401-company-slope-units-prod` (`22824e9f`) | `22824e9f` | canonical `23a8dba3`; dev `platform-20261112162938-f1baa54a` |
| `102b43b8` | `claude/fm-383-preserve-pending-message-prod` (`9fd483d7`) | `89ca43e2`, `76c7ac4f`, `7e62d8c4`, `3b24cd5d` | canonical `49acd623`, `c56d9858`, `51fbe4de`, `cdea7cb5`; re-verified on dev `cf6ed9ef` |

## Change

- FM-457 (browser): with no project type chosen, the new-project map takes 10 pins, matching its notice
  (`project-map/app.js` `pinLimitType()`, `project-request/app.js` `maxPinsForType('')` = 10).
- FM-405 (browser): the 3D roof viewer draws each roof face as its plane, sets a broken flat face at its own corners'
  level and stops a left-out face's lines hanging from a roof corner (`measurements/roof-viewer.js`). The editor's XML
  export merges points only when their heights agree (`measure/internal/editor_scripts/xml_generator.js`).
- FM-401 (Node + browser): Roof pitch is a report setting in Settings › Reports › Units (`settings/company.js`, apps manifest
  key `20261114-fm401-report-pitch`); orders read `report_preferences.pitch_notation` first (`firstmeasure/report_preferences.ts`);
  `/me/localization` no longer returns `pitch_notation` (`platform/localization/settings.ts`). 3 new `settings` language keys;
  catalog `settings.b8b34ee59a518973.json`.
- FM-383 (Node + browser): a report held for release changes nothing on its project until it is delivered: completion
  event, satellite photo and measurements only once delivered (`firstmeasure/project-events.ts`, `api.ts`, `storage.ts`,
  `platform/publication/datasets.ts`, `firstmeasure-datasets.ts`); a held report keeps its "in review" look
  (`portal/scripts/core.js`, `project-map/app.js`, `measurements/project.js`, `guided-experiences.js`; manifest key
  `20261114-fm455-fm383-held-reports`).
- Tests (not served): `tests/project-pin-limit.test.mjs`, `measurements-roof-viewer-layers.test.mjs`,
  `dev/xml-generator-layers.test.cjs`, `pitch-notation.test.ts`, `report-localization.test.ts`,
  `firstmeasure-held-report-*.test.ts`.
- No database, environment, flag, nginx, dependency or config-library change. No data repair.

## Checks before release

- At 06:51 UTC `current` was `29855eb0` on all 8 hosts, readiness 5/5 on it, root disks 74 GB or more free. Rollback target
  `29855eb0` was recorded on all four issues before anything was activated.
- Tests on the release tree here: project-pin-limit 5/5, roof-viewer-layers 5/5, xml-generator-layers 2/2,
  held-report late-hold 1/1 and completion-events 4/4, report-localization 1/1, pitch-notation 7/9 (the 2 failures,
  "the PDF writes pitch in the project's notation" and "summary totals card", also fail on the base, per FM-401's plan).
- Built `102b43b8` on the dev worker (`npm run check` and build passed, 273 s). Archive sha256
  `83a682d750be62e15135d11b1edfe9dc33be883d2ac669c4b8bc39d47b78f4d7`. Full procedure, because Node changes.
- `web_activate.py` keeps every earlier assert. Pins this release changes now name `102b43b8`'s blobs (`project-request/app.js`,
  apps manifest, `settings/company.js`, catalog `manifest.json`, `roof-viewer.js`, `measurements/project.js`), and FM-400's
  manifest check expects FM-383's `project.js` key. New batch asserts: `project-map/app.js` (sha, served, `pinLimitType`),
  `project-request/app.js` needles, `roof-viewer.js` `separateLayers` x2 and `A broken flat face` x1, `xml_generator.js`
  (sha, `XML_POINT_MATCH_TOLERANCE_Z_M` x2), `company.js` needles (no `csPitchNotation`), settings catalog served, manifest
  keys, `dist` FM-401 and FM-383 code. 73 file asserts pass on the archive (`check_asserts.py`, now run with served reads
  answered from the tree); control: they fail on `29855eb0`'s tree, whose own asserts still pass.
- Read-only probes against the installed, inactive release on the worker:
  - FM-401 `resolveOrderReportPreferences` for 8 organizations (2 each: rise_12/rise_12, degrees/degrees, none-metric,
    none): the same `pitch_notation` on `29855eb0` and `102b43b8`.
  - FM-383: of the 59 reports held at the time, `29855eb0`'s completion gate (status completed) counted 59 as delivered;
    `102b43b8`'s `reportDeliveredToProject` counts 0.

## Rollout (scripts: fm-agents /srv/agents/work/prod-batch-fm457-383-prodrun-scripts)

- Compatibility and the worker installed 06:59–07:01. Worker activated 07:01:33 UTC, with no running jobs.
- Channel published against `29855eb0`'s archive (`ca3ae732…`).
- Web nodes one at a time, 07:02:52–07:16:36 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility at 07:16:51 UTC; the gate opened at once (289 legacy-action/min, load 0.78): rolling replace, 0 Node 500s
  and 0 exits in the 20 s after.

## Verification

- `current` is `102b43b8` on all 8 hosts. Readiness reports `102b43b8` 10/10 (5 nodes answering).
- app.1m8.ai serves all 11 changed browser files equal to the release, 6/6 requests each (incl. the editor's
  `xml_generator.js` through compatibility). Needle counts: `pinLimitType` 1, `separateLayers` 2, `A broken flat face` 1,
  `XML_POINT_MATCH_TOLERANCE_Z_M` 2, `csPitchNotation` 0, `reportOrderReleaseHoldIsActive()) return 'review'` 1.
- FM-457: the two files served by web node 64.23.240.81, copied into a detached worktree of the release (clean
  `git status`): `tests/project-pin-limit.test.mjs` 5/5. Control on the pre-release served files: 0/5.
- FM-405: the served `roof-viewer.js` draws the 1202 Sharon Park Dr model with 0 of 50 faces more than 1 ft off their plane
  and 0 hanging lines (`faces.mjs`, `loose.mjs`); the pre-release served file: 6 faces and 44 lines.
  `measurements-roof-viewer-layers` 5/5 on the served file.
- FM-383, on the live release since the worker activation (07:01:33): 47 reports held, 0 treated as delivered, 0
  `measurement.report.completed` work events for a held report.
- 5xx from 07:18 to 07:33 UTC (after compatibility settled), excluding health probes:
  - web nodes: 0.00–0.07 % (0–2 each, all `top_view_reroll_proxy.php`), against 0.00–0.07 % in the 30 minutes before
  - compatibility: 0.60 % (4, all `top_view_reroll_proxy.php`), against 0.63 % before
- Compatibility, 07:16:51–07:45: 0 watchdog kills, 0 Node 500s, 0 pool timeouts, one MainPID throughout.
- Worker 07:01:33–07:43: 63 jobs completed, 0 failed; no "Worker stopping", browser-closed, pool-timeout or heartbeat errors.

## Rollback

`/srv/agents/work/prod-batch-fm457-383-prodrun-scripts/rollback/`: `release.sh worker`, `publish` (republishes `29855eb0`'s
archive), `web_rollout.sh` (FM-455's forward asserts with base `102b43b8`), `release.sh compat`. Rolling back restores the
old pin limit, viewer, Settings layout and completion gate. Data stays compatible both ways: a branch saved by the new
Reports pane has `report_preferences.pitch_notation`, which the old code also reads; reports held meanwhile are released
by their schedule either way.
