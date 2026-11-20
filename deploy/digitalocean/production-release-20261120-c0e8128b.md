# Production release c0e8128b: QA and manager send-back save the embedded editor first (FM-626), November 20, 2026

Released from fm-agents-1 by the production run for FM-626 (FirstMeasure bug fixes workspace, Router's standing
authorization for issues set to "Testing in prod" once verified on dev). The release is the plan commit as is:

| Commit | Change | Same change as (verified on dev) |
| --- | --- | --- |
| `c0e8128b` | FM-626: QA's and the manager's "Send back to tech" save the embedded editor before posting the decision | plan branch `claude/fm-626-roof-geometry-lost-prod`; lane commit `fa3c5c3a` (diff identical), lane release `measure-internal-20261120160953-1804e5b8` |

`c0e8128b` is a cherry-pick (`-x`) of `fa3c5c3a` onto `production-live` `d7942af4` (the record of the live release
`4db9163b`, FM-622). This record is committed on top, so the push is a fast-forward.

## Change

- `public/measure/internal/portal_scripts/qa.js` (+28): `submitDecision('rejected')` (QA) and
  `submitManagerDecision('rejected')` (manager) now call `saveEmbeddedEditorBeforeSendBack()` first, which runs the
  embedded editor's `saveProjectData(true, true)`, the same save Approve already did. If that save fails, nothing is
  sent back and the reviewer is told their changes are still in the editor. With no editor loaded the send-back goes
  ahead as before. Served sha256 `d0458cc485f4…` → `e8a6eed43dcf…` (the bytes dev serves); `index.php` loads it with
  `?v=time()`, so no version bump.
- `dev/qa-send-back-saves-editor.test.cjs`: regression test (not served).
- No Node server code, environment, flag, nginx, dependency, config-library or database change. No data repair: the
  reported job (1522 Garnet Mine Rd) was never saved by QA; its fix existed only in QA's browser backup and needs
  ordinary rework in the editor (see FM-626).

## Checks before release

- `current` was `4db9163b` on all 8 hosts; readiness 10/10 on `4db9163b`. Rollback target `4db9163b` was recorded on
  FM-626 before anything was built. Disk `/` had 64–128 GB free on every production host. Compat over the hour
  before: 1 watchdog kill (2 lines), 0 Node 500s, 0 pool timeouts.
- `git diff 4db9163b c0e8128b`: `qa.js`, the test and the previous release record; the `+/-` lines of `c0e8128b`
  equal lane commit `fa3c5c3a`'s.
- The plan test with production's served `qa.js` before the release (control): fails.
- Built on the dev worker (302 s). Archive sha256 `d9b7b818ebc19861b2ea4cd5836387abc50c2f791cdd7df771f062ed77af091d`;
  its `qa.js` is the bytes dev serves (`e8a6eed4…`).
- `fastpath.sh decide` against `4db9163b`'s archive (`2d349b81…`) chose the **fast path**: server, dependencies and
  configuration the same; 2 changed files, both static (`qa.js`, `production-release-20261120-4db9163b.md`); 0 Node
  files; no unclassified readers.
- `switch-release-files.py --check` reported "fast path possible" on all 8 hosts.

## Rollout (scripts: fm-agents /srv/agents/work/fm-626-prodrun-scripts)

- Installed on compatibility and the worker; the web channel was published against `4db9163b`'s archive and the
  release installed on the six web nodes. Nothing was activated at this stage.
- Fast-path switch, 16:28:29–16:30:44 UTC: compatibility first (16:29:21), then the six web nodes one at a time, then
  the worker. On each host `current` switched in 0.0–0.4 s, PHP-FPM reloaded and Node was kept (same MainPID).

## Verification

- `current` is `c0e8128b` on all 8 hosts. Readiness is ok 10/10 and reports `4db9163b` (the release Node started in;
  this is a fast path).
- 12 requests to app.1m8.ai: `qa.js` 12/12 the release's bytes (sha256 `e8a6eed43dcf…`), and
  `saveEmbeddedEditorBeforeSendBack` appears 3 times in each; the same count on disk on compatibility and every web
  node.
- The served `qa.js` passes `dev/qa-send-back-saves-editor.test.cjs` 4/4 (QA send-back saves first, manager
  send-back saves first, a failed save sends nothing, no editor open still sends back).
- Web nodes' NGINX after the switch: each of the 7 `qa/decision` / `manager/decision` POSTs between 16:29 and 16:32
  came 1–3 s after an `editor/save` for the same project. The log can't tell a send-back from an approval (which
  already saved), and pages opened before the switch keep the old `qa.js` until reloaded.
- Watch 16:28:29–16:41 UTC against the 30 minutes before (`rates.py`):
  - Web nodes: 5xx 0.03–0.06 % after, against 0.04–0.07 % before; almost all `top_view_reroll_proxy.php`
    (long-standing).
  - Compatibility: 0.57 % against 0.67 % before, `top_view_reroll_proxy.php` plus two `editor.php` 503s at 16:33
    ("staff verification failed: HTTP 0" on `project_feedback`, which happened 3 times earlier today on `4db9163b`;
    neither `editor.php` nor Node changed). Node: 0 watchdog kills, 0 Node 500s, 0 pool timeouts; MainPID 3681809
    unchanged.
  - Worker (MainPID 4060857 unchanged): 0 failed or retried jobs since activation; 126 completed (75 `pdf.sync`,
    24 `imagery.process`, 21 `report.delivery`, 6 `report.release`). The 152 queued `report.release` jobs are
    scheduled holds, none due.
- No signed-in QA send-back was run: the run has no production staff session, and none was created.

## Rollback

`NEW=c0e8128b… OLD=4db9163b… bash fastpath.sh rollback` switches back (compatibility → web → worker; nothing
restarts). Then `bash rollback/release.sh publish` republishes the channel with `4db9163b`'s archive, which is still
on compatibility at `/var/tmp/firstmeasure-release-4db9163b`.
