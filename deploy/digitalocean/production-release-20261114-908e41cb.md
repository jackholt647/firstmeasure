# Production release 908e41cb: dev editor modeling batch (FM-466), November 14, 2026

Jack in his Claude Code session on 2026-11-14: "Now that that's fixed, can we push all of these changes that we have made
to production? I think we're finally there." Released from fm-agents-1 by the FM-466 run (FirstMeasure bug fixes
workspace). Branch `release/prod-editor-modeling-20261114` (= `claude/fm-466-release-to-prod-dev-editor-modeling-batc-prod`)
is one commit on `production-live` `5a7289e4`, released as is:

| Commit | Change | Same change as (verified on dev) |
| --- | --- | --- |
| `908e41cb` | 39 measure-internal lane commits: point weld, load-bearing markers, base folds, resoffit, lines stored once, trim per side, Resources "Delete this file", and more (FM-466 description) | `claude/editor-lane-20261112` `513c2eee`, lane release `861994a8` |

## Change

- 15 scripts under `public/measure/internal/editor_scripts/` (base_editor, base_geometry, base_sketch_editor,
  base_sketch_geometry, exterior_model, project_resources, wall_axis_cuts, wall_base_binding, wall_editor, wall_face_draft,
  wall_features, wall_geometry, wall_mode, wall_resoffit, wall_solid_geometry) and `public/measure/internal/project_resources.php`
  (new `POST action=delete`, a soft delete: marks the file's index `deleted_at`/`deleted_by`, removes nothing from storage).
  All 16 are byte-identical to `claude/editor-lane-20261112` `513c2eee`.
- Deliberately unchanged: `editor_scripts/main.js` and `xml_generator.js` stay at production's copies (dev carries other
  sessions' unreleased changes to them: FM-405 height tolerance, insufficient-footage reason filter).
- Also in the archive, inert: production-live's release-pruning tooling under `deploy/` (`3c006205`, `31c96bd8`,
  `5a7289e4`) and the `3c7b173a` record. The fast path does not run `activate-release.sh`, so pruning first runs at the
  next full release.
- `dev/**` tests and fixtures and `tests/release-legacy-rolling-activation.test.mjs` are not in the archive.
- No Node server code, environment, flag, nginx, dependency, config-library or database change; no data repair.
- On opening a full-house project in wall mode the new editor tidies stored wall edits (hidden outlines of deleted faces
  become ordinary lines, duplicate free-standing lines are dropped, tiny leftover roof faces are dropped). If technicians
  report lines or faces missing after opening, roll back (below).

**Not on canonical yet:** `claude/editor-lane-20261112` (`513c2eee`, = `lane/measure-internal`) is not an ancestor of
`codex/consolidated-firstmeasure-20260923`, and all 16 files above differ there. A production release built from
canonical before the lane is merged into it would put back the older editor files; releases branched from
`production-live` keep them.

## Checks before release

- Every host's `current` was `3c7b173a`; rollback target `3c7b173a` recorded on FM-466 before anything was installed.
  Disk `/` 22–30 % used on all 8 hosts.
- `git diff 3c7b173a 908e41cb`: exactly the files above; main.js and xml_generator.js unchanged.
- Built on the dev worker in 269 s; archive sha256 `3a9cf807ba538f7da333a5169e57e5c4839f6d663b4fbb09c52cac45fc717ae7`.
- `fastpath.sh decide` against `3c7b173a`'s archive (`8d6c5776…`): **fast path**. Server same, dependencies same,
  configuration same, 23 changed files, 0 Node files, no unclassified readers; changed (all static): the 7 `deploy/`
  files, the 15 editor scripts and `project_resources.php`.
- `switch-release-files.py --check`: "fast path possible" on all 8 hosts.

## Rollout (scripts: fm-agents /srv/agents/work/fm-466-prodrun-scripts)

- Installed on compatibility and the worker 02:07–02:08 UTC; web channel published against `3c7b173a`'s archive 02:09;
  installed on the six web nodes 02:09:24–02:09:46. Nothing activated.
- Fast path switch 02:12:42–02:14:23 UTC: compatibility, then the six web nodes one at a time, then the worker. Each:
  `current` switched in 0.0–0.2 s, PHP-FPM reloaded, Node kept (same MainPID), 15/15 changed static files served with the
  new bytes (worker: none served).

## Verification

- `current` is `908e41cb` on all 8 hosts. Readiness ok 10/10, reporting `3c7b173a` (Node did not restart).
- `served.py`: all 15 editor scripts 12/12 from app.1m8.ai with the release's sha256. Plan needles (byte counts, 12
  requests each): `wall_face_draft.js` `const planeDrives=` 0 → 1, `wall_geometry.js` `LEFTOVER_SPAN` 0 → 3,
  `project_resources.js` `data-action="deleteFile"` 0 → 2. `main.js` `0c1219264fdc2789…` and `xml_generator.js`
  `aa9e944f5c24db59…` unchanged before and after.
- `project_resources.php` on compatibility = release (`ad01c9af…`), `php -l` clean; `POST ?action=delete` with no session
  answers 401.
- Watch 02:12:42–02:26:09 UTC against the 30 minutes before (`rates.py`): NGINX 5xx 0.00–0.03 % on the six web nodes
  (0.01–0.04 % before) and 0.23 % on compatibility (0.37 % before); every 5xx is the long-standing
  `/measure/internal/top_view_reroll_proxy.php`. Compatibility Node since the switch: 0 watchdog kills, 0 Node 500s,
  0 pool timeouts (same in the 30 minutes before), MainPID unchanged. Worker: no error-level lines before or after,
  MainPID unchanged.

## Rollback

`NEW=908e41cb… OLD=3c7b173a… bash fastpath.sh rollback` (switch back, compatibility → web → worker, nothing restarts),
then `bash rollback/release.sh publish` (republishes the channel with `3c7b173a`'s archive, still on compatibility at
`/var/tmp/firstmeasure-release-3c7b173a`).
