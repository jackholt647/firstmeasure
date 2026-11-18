# Production release ad6f5c6e: text-only tech notes out of Resources > Files (FM-524 follow-up), November 17, 2026

Released from fm-agents-1 by the FM-524 follow-up production run (FirstMeasure bug fixes workspace, Router's standing
authorization for issues set to "Testing in prod" once verified on dev). Plan branch `claude/fm-524-tech-notes-prod`
(`ad6f5c6e`, a child of `production-live` `96b3c694`, the record of `e57fe7e4`, FM-526) was released as is:

| Commit | Change | Same change as (verified on dev) |
| --- | --- | --- |
| `ad6f5c6e` | The tech's submission notes and tech/drafter thread replies no longer become text "Tech notes" cards in the Full Exteriors editor's Resources > Files; only their attachments are listed | `84f13de2` (`claude/fm-524-exclude-text-only-notes`); lane commit `5550f903`, lane release `measure-internal-20261117063448-302a4630` |

## Change

- `public/measure/internal/editor_scripts/project_resources.js`: in `referenceCatalog()`, the tech's submission
  sources and every QA/manager thread message (tech or QA) add only their images and files, never a text card. Customer
  order notes are unchanged. The text stays in the Sources & Notes panel and the QA thread. sha256 `0f01c6ee…` →
  `8e0ae22323f20e33…` (the same file dev serves).
- `dev/resource-catalog.test.cjs`: FM-524 regression test extended (not in the archive).
- Also in the archive, inert: the `e57fe7e4` record.
- The editor loads the file with `?v=<sha256 prefix>` (`fm_editor_asset_version`), so no version bump. No Node server
  code, environment, flag, nginx, dependency, config-library or database change; no data repair.

## Checks before release

- Every host's `current` was `e57fe7e4`; readiness ok 10/10, reporting `43a59307` (Node unchanged since FM-523).
  Rollback target `e57fe7e4` recorded on FM-524 before anything was built. Disk `/` 25–31 % used on all 8 hosts.
- `git diff 96b3c694 ad6f5c6e`: exactly the two files above.
- Built on the dev worker in 269 s (`npm run check` passed); archive sha256
  `269723f2e5e9a016165c37b9b147467866d78d6f7c0e629ea39c043080b08da8`.
- `fastpath.sh decide` against `e57fe7e4`'s archive (`f7c1c7ce…`): **fast path**. Server same, dependencies same,
  configuration same, 2 changed files (both static), 0 Node files, no unclassified readers.
- `switch-release-files.py --check`: "fast path possible" on all 8 hosts.
- Control: production's served `project_resources.js` before the release (`0f01c6ee…`), in a tree with the plan's test,
  fails the 2 changed cases of `dev/resource-catalog.test.cjs` (2/4).

## Rollout (scripts: fm-agents /srv/agents/work/fm-524b-prodrun-scripts)

- Installed on compatibility and the worker and web channel published against `e57fe7e4`'s archive; installed on the
  six web nodes. Nothing activated.
- Fast path switch 06:50:03–06:51:54 UTC: compatibility, then the six web nodes one at a time, then the worker. Each:
  `current` switched in 0.0–0.3 s, PHP-FPM reloaded, Node kept (same MainPID), the changed static files served with the
  new bytes (worker: none served).

## Verification

- `current` is `ad6f5c6e` on all 8 hosts. Readiness ok 10/10, reporting `43a59307` (Node did not restart).
- `served.py` and the plan check, 12 requests from app.1m8.ai: `project_resources.js` 12/12 `8e0ae223…`, needle
  `add('tech','submission','',sources.images)` 0 → 1, `add('tech','submission',sources.notes,sources.images)` 1 → 0,
  `role==='qa'?'':m.text` 1 → 0. Equal to `git show ad6f5c6e:<path>`.
- The served file passes `node --check` and, placed in a tree with the test, `dev/resource-catalog.test.cjs` 4/4.
- Watch 06:50:03–07:01 UTC against the 30 minutes before (`rates.py`): no new 5xx. After the switch the only 5xx on all
  7 NGINX hosts is the long-standing `/measure/internal/top_view_reroll_proxy.php` (2 in ~11 min; 19 5xx across the
  hosts in the 30 minutes before). Compatibility Node since the switch: 0 kills, 0 Node 500s, 0 pool timeouts, MainPID
  2990601 unchanged. Worker: MainPID 2287929 unchanged, no error lines after the switch (before: only the known Maps
  Static 403, 2 in 30 minutes). Readiness ok 10/10 again at 07:01.
- A signed-in editor smoke test was not run: no production staff session is available to the run, and none was
  created.

## Rollback

`NEW=ad6f5c6e… OLD=e57fe7e4… bash fastpath.sh rollback` (switch back, compatibility → web → worker, nothing restarts),
then `bash rollback/release.sh publish` (republishes the channel with `e57fe7e4`'s archive, still on compatibility at
`/var/tmp/firstmeasure-release-e57fe7e4`).
