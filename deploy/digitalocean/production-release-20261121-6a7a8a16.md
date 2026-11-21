# Production release 6a7a8a16: a wall its merge group's draft no longer owns can be selected and deleted (FM-628), November 21, 2026

Released from fm-agents-1 by the production run for FM-628 (FirstMeasure bug fixes workspace, Router's standing
authorization for issues set to "Testing in prod" once verified on dev). The release is the plan branch tip as is:

| Commit | Change | Same change as (verified on dev) |
| --- | --- | --- |
| `109f84ae` | FM-628: a wall its merge group's draft no longer owns can be selected and deleted | plan branch `claude/fm-628-unexpected-rendering-issue-prod` |
| `6a7a8a16` | FM-628: keep a wall its merge group's draft covers with that draft | together with `109f84ae`: lane commit `51a5b7aa` (diff identical), lane release `measure-internal-20261121050740-b801b3a6` |

`109f84ae` is a direct child of `production-live` `7649d84a` (the record of the live release `b4f166bc`, FM-625).
This record is committed on top of `6a7a8a16`, so the push is a fast-forward.

## Change

- `public/measure/internal/editor_scripts/wall_face_draft.js` (+7/-2): `id()` uses a wall's merge-group key only
  when the draft stored under it owns or covers that wall; otherwise the wall gets a draft of its own, so a click
  selects it and Delete removes it. `ensure()` leaves walls of the group that another draft owns out of the new
  draft's outline. Reported case: 3501 Groveton St, where a later roof follow brought back generated wall `R6.0:0`
  outside the R4/R18 draft of its merge group, so clicks on it selected nothing and Delete did nothing. Served
  sha256 `06a1017ca908…` → `a463806035a8…` (the bytes dev serves). The editor's `?v=` is the file's own hash, so
  no version bump.
- `dev/wall-face-draft.test.cjs`: regression test (not served).
- No Node server code, environment, flag, nginx, dependency, config-library or database change. No data repair:
  the tech deletes the facet in the editor as usual.

## Checks before release

- `current` was `b4f166bc` on all 8 hosts; readiness 10/10 on `b4f166bc`. Rollback target `b4f166bc` was recorded
  on FM-628 before anything was built. Disk `/` had 63–127 GB free on every production host. Compat over the hour
  before: 0 watchdog kills, 0 Node 500s, 0 pool timeouts.
- `git diff 7649d84a 6a7a8a16`: `wall_face_draft.js` and the test only.
- Editor harness on the order's saved walls (`/srv/agents/work/fm-628-harness`, real mouse and Delete key in
  headless Chromium) with production's served scripts before the release (control): the click on the facet
  selects nothing and `R6.0:0` is still drawn, also after save and reopen.
- Built on the dev worker (290 s). Archive sha256 `f4811a7fd7dcf14104abc5c87a37ee6a9e0b37dc684d29cb21e1bca80185c4a0`;
  its `wall_face_draft.js` is the bytes dev serves (`a4638060…`).
- `fastpath.sh decide` against `b4f166bc`'s archive (`620d386e…`) chose the **fast path**: server, dependencies
  and configuration the same; 2 changed files, both static (`wall_face_draft.js`,
  `production-release-20261120-b4f166bc.md`); 0 Node files; no unclassified readers.
- `switch-release-files.py --check` reported "fast path possible" on all 8 hosts.

## Rollout (scripts: fm-agents /srv/agents/work/fm-628-prodrun-scripts)

- Installed on compatibility and the worker; the web channel was published against `b4f166bc`'s archive and the
  release installed on the six web nodes. Nothing was activated at this stage.
- Fast-path switch, 05:52:09–05:53:54 UTC: compatibility first (05:52:29), then the six web nodes one at a time,
  then the worker. On each host `current` switched in 0.0–0.5 s, PHP-FPM reloaded and Node was kept (same MainPID).

## Verification

- `current` is `6a7a8a16` on all 8 hosts. Readiness is ok 10/10 and reports `b4f166bc` (the release Node started
  in; this is a fast path).
- 12 requests to app.1m8.ai: `wall_face_draft.js` 12/12 the release's bytes (sha256 `a463806035a8…`).
- Editor harness with production's served scripts after the release: clicking the facet selects `R6.0:0` as its
  own draft (`{"draft":"R6.0:0","face":"wall-region-0"}`), Delete removes it, and it is still gone after save and
  reopen.
- `node --test dev/wall-face-draft.test.cjs` on the release commit with the served `wall_face_draft.js` (git
  status clean, so the served bytes equal the commit): 642/642, including "a wall its merge group draft no longer
  owns gets its own draft, so Delete removes it".
- Watch 05:52:09–06:03 UTC against the 30 minutes before (`rates.py`):
  - Web nodes: 5xx 0–0.2 % after, against 0–0.08 % before; all `top_view_reroll_proxy.php` (long-standing).
  - Compatibility: 0.9 % (5 of 557) against 0.64 % (15 of 2348) before, all `top_view_reroll_proxy.php` both
    before and after. Node: 0 watchdog kills, 0 Node 500s, 0 pool timeouts; MainPID 3681809 unchanged.
  - Worker (MainPID 38070 unchanged): 0 failed or retried jobs since activation; 26 completed (13 `pdf.sync`,
    5 `report.delivery`, 8 `report.release`). The 60 queued `report.release` jobs are scheduled holds, none due.
- No signed-in production editor session was used: the proof is the harness on production's served scripts.

## Rollback

`NEW=6a7a8a16… OLD=b4f166bc… bash fastpath.sh rollback` switches back (compatibility → web → worker; nothing
restarts). Then `bash rollback/release.sh publish` republishes the channel with `b4f166bc`'s archive, which is still
on compatibility at `/var/tmp/firstmeasure-release-b4f166bc`.
