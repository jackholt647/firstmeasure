# Production release e57fe7e4: queue tag EXTERIOR, dashboard EXT tag (FM-526), November 17, 2026

Released from fm-agents-1 by the FM-526 production run (FirstMeasure bug fixes workspace, Router's standing
authorization for issues set to "Testing in prod" once verified on dev). Plan branch `claude/fm-526-fix-prod`
(`e57fe7e4`, a child of `production-live` `5486dccb`, the record of `804bc9c7`, FM-524) was released as is:

| Commit | Change | Same change as (verified on dev) |
| --- | --- | --- |
| `e57fe7e4` | Queue type tag on full exterior orders reads EXTERIOR; dashboard active-project tiles add an EXT tag | `f6c09d76` (`claude/fm-526-fix`); lane commit `32b2200b`, lane release `measure-internal-20261117050945-73a3dfdf` |

## Change

- `public/measure/internal/portal_scripts/projects.js`: the queue type tag on `exteriors_…` orders reads `EXTERIOR`
  instead of `FULL HOUSE` (main queue list and requeue list). sha256 `29d4d225…` → `a830d3bde262f98b…`.
- `public/measure/internal/portal_scripts/shifts.js`: dashboard active-project tiles get an `EXT` tag
  (`.sh-work-tag.exterior`, dark blue) for `exteriors_…` ids and `measurement_scope: 'full_house'` projects that are not
  `fullhouse_` drafts. sha256 `8965c511…` → `58b477f870597fdb…`.
- `dev/exterior-project-tags.test.cjs`: FM-526 regression test (not in the archive).
- Also in the archive, inert: the `804bc9c7` record.
- `index.php` loads both scripts with `?v=<?=time()?>`, so no version bump. No Node server code, environment, flag,
  nginx, dependency, config-library or database change; no data repair.

## Checks before release

- Every host's `current` was `804bc9c7`; readiness ok 5/5, reporting `43a59307` (Node unchanged since FM-523). Rollback
  target `804bc9c7` recorded on FM-526 before anything was built. Disk `/` 72–135 GB free on all 8 hosts.
- `git diff 5486dccb e57fe7e4`: exactly the three files above.
- Built on the dev worker in 267 s (`npm run check` passed); archive sha256
  `f7c1c7ce6985407d3b5437f6ef8c1d62e6cea6af2b255cb981d6f6f6cfd64e98`.
- `fastpath.sh decide` against `804bc9c7`'s archive (`c07f28c2…`): **fast path**. Server same, dependencies same,
  configuration same, 3 changed files (all static), 0 Node files, no unclassified readers.
- `switch-release-files.py --check`: "fast path possible" on all 8 hosts.
- `node --test dev/exterior-project-tags.test.cjs` on the release tree: 2/2. Control: production's previous
  `projects.js` and `shifts.js` fail it 0/2.

## Rollout (scripts: fm-agents /srv/agents/work/fm-526-prodrun-scripts)

- Installed on compatibility and the worker and web channel published against `804bc9c7`'s archive; installed on the
  six web nodes. Nothing activated.
- Fast path switch 05:25:23–05:27:07 UTC: compatibility, then the six web nodes one at a time, then the worker. Each:
  `current` switched in 0.0–0.3 s, PHP-FPM reloaded, Node kept (same MainPID), the changed static files served with the
  new bytes (worker: none served).

## Verification

- `current` is `e57fe7e4` on all 8 hosts. Readiness ok 10/10 (twice: right after the switch and at 05:38), reporting
  `43a59307` (Node did not restart).
- `served.py` and the plan check, 12 requests per file from app.1m8.ai: `projects.js` 12/12 `a830d3bd…`, needle
  `'EXTERIOR':(qTypeLabels` 0 → 2, `'FULL HOUSE':(qTypeLabels` 2 → 0; `shifts.js` 12/12 `58b477f8…`, `sh-work-tag exterior`
  0 → 1. Both equal `git show e57fe7e4:<path>`.
- The served files pass `node --check` and, placed in a tree with the test, `dev/exterior-project-tags.test.cjs` 2/2.
- Watch 05:25:23–05:37 UTC against the 30 minutes before (`rates.py`): no new 5xx. After the switch the only 5xx on all
  7 NGINX hosts is the long-standing `/measure/internal/top_view_reroll_proxy.php` (12 in ~12 min; it was also the
  largest source before). Compatibility Node since the switch: 0 kills, 0 Node 500s, 0 pool timeouts, MainPID 2990601
  unchanged. Worker: MainPID 2287929 unchanged; its only error lines before and after are the known Maps Static 403
  (`google.png`), 2 in the 12 minutes before, 4 after.
- A signed-in staff queue/dashboard smoke test was not run: no production staff session is available to the run, and
  none was created.

## Rollback

`NEW=e57fe7e4… OLD=804bc9c7… bash fastpath.sh rollback` (switch back, compatibility → web → worker, nothing restarts),
then `bash rollback/release.sh publish` (republishes the channel with `804bc9c7`'s archive, still on compatibility at
`/var/tmp/firstmeasure-release-804bc9c7`).
