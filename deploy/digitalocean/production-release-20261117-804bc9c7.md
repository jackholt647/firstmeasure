# Production release 804bc9c7: text-only QA notes out of Resources > Files (FM-524), November 17, 2026

Released from fm-agents-1 by the FM-524 production run (FirstMeasure bug fixes workspace, Router's standing
authorization for issues set to "Testing in prod" once verified on dev). Plan branch
`claude/fm-524-exclude-text-only-notes-prod` (`d4c0e6f3`, a child of `faa0df05`) was cherry-picked onto
`production-live` `813c3cad` (record of `43a59307`, FM-523, live since 04:40 UTC), as the plan said to do if FM-523
landed first:

| Commit | Change | Same change as (verified on dev) |
| --- | --- | --- |
| `804bc9c7` | Resources > Files lists only what QA attached; QA thread message text no longer becomes "QA notes" cards | `d4c0e6f3`; lane commit `a10f87bb`, lane release `measure-internal-20261117040043-da757511` |

## Change

- `public/measure/internal/editor_scripts/project_resources.js`: in `referenceCatalog()`, QA-role messages in the QA
  and manager threads add only their images and files, not their text. Tech replies, the tech's submission notes and
  customer notes are unchanged. sha256 `6f4e4db8…` → `0f01c6ee68e2daa47c8a75f1d978a4286bcf8261ef60819c9314837c546b5acc`
  (byte-identical to the plan commit and to dev). `editor.php` versions it by content (`fm_editor_asset_version`), so
  the script URL is now `?v=0f01c6ee68e2daa4` with no manual bump.
- `dev/resource-catalog.test.cjs`: FM-524 regression test (not in the archive).
- Also in the archive, inert: the `43a59307` record.
- No Node server code, environment, flag, nginx, dependency, config-library or database change; no data repair.
  Nothing stored is changed or deleted: the editor only lists existing thread messages differently.

## Checks before release

- Every host's `current` was `43a59307`; readiness ok 10/10 on `43a59307`. Rollback target `43a59307` recorded on
  FM-524 before anything was built. Disk `/` 74–135 GB free on all 8 hosts.
- `git diff 813c3cad 804bc9c7`: exactly the two files above.
- Built on the dev worker in 274 s; archive sha256 `c07f28c2e9c531139e4ff3470ba2f5c4443593292105ddb01f354a19080f3318`.
- `fastpath.sh decide` against `43a59307`'s archive (`81239095…`): **fast path**. Server same, dependencies same,
  configuration same, 2 changed files (both static: the `43a59307` record and `project_resources.js`), 0 Node files,
  no unclassified readers.
- `switch-release-files.py --check`: "fast path possible" on all 8 hosts.
- Control: production's served `project_resources.js` (`6f4e4db8…`) placed in the release tree fails
  `dev/resource-catalog.test.cjs` (2 of 4, both the FM-524 cases); the release's file passes 4/4.

## Rollout (scripts: fm-agents /srv/agents/work/fm-524-prodrun-scripts)

- Installed on compatibility and the worker and web channel published against `43a59307`'s archive 04:48–04:50 UTC;
  installed on the six web nodes 04:50:45–04:51. Nothing activated.
- Fast path switch 04:53:49–04:55:39 UTC: compatibility, then the six web nodes one at a time, then the worker. Each:
  `current` switched in 0.0–0.7 s, PHP-FPM reloaded, Node kept (same MainPID), the changed static file served with the
  new bytes (worker: none served).

## Verification

- `current` is `804bc9c7` on all 8 hosts. Readiness ok 10/10, reporting `43a59307` (Node did not restart).
- `served.py` and the plan check: `project_resources.js` 12/12 from app.1m8.ai with sha256 `0f01c6ee…`; needle
  `role==='qa'?'':m.text` 0 → 1 (12/12 before was `6f4e4db8…` with 0).
- The served file, placed in the release tree, passes `dev/resource-catalog.test.cjs` 4/4 and `node --check`.
- `/measure/internal/editor.php` answers 302 to the staff login without a session, as before. A signed-in editor smoke
  test was not run: no production staff session is available to the run, and none was created.
- Watch 04:53:49–05:05 UTC against the 30 minutes before (`rates.py`): one compatibility watchdog kill at 04:54:11
  (HTTP worker 3404126; its last log line was 04:53:44, before the switch command started, and compatibility's switch
  and PHP-FPM reload came at 04:54:27; unfinished requests `legacy-action`, `queue/status/compat`,
  `referrals/publicAcquisitionLookup`, the known referrals stall in Node code this release does not change, also seen
  today at 00:51, 00:54, 01:59 and 04:17 ×2). It caused the only new 5xx: 10 `legacy-action` and 2 `/v1/internal/users`
  500s across the web nodes, all at 04:54:11, plus three acquisition 500s (`event`/`track`) at 04:54:05–04:54:48. From 04:55 to 05:05 the
  only 5xx on all 7 NGINX hosts is the long-standing `/measure/internal/top_view_reroll_proxy.php`. Compatibility Node
  since the switch: 0 Node 500s, 0 pool timeouts, primary MainPID 2990601 unchanged. Worker: MainPID unchanged; its
  only error lines before and after are the known Maps Static 403 (`google.png`), 6 in the 12 minutes before, 4 after.

## Rollback

`NEW=804bc9c7… OLD=43a59307… bash fastpath.sh rollback` (switch back, compatibility → web → worker, nothing restarts),
then `bash rollback/release.sh publish` (republishes the channel with `43a59307`'s archive, still on compatibility at
`/var/tmp/firstmeasure-release-43a59307`).
