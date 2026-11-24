# Production release 4e1a5ad6 (FM-636 + FM-630 wall mode opens with a broken base), November 24, 2026

Production runs `4e1a5ad659bac5f038b41f2db59ea085c52cadc4` on all 8 hosts (compatibility, worker, 6 web nodes).
Rollback target: `38684d9a93da6e9ff72ee759d3a2f358b6393776` (FM-635), recorded on FM-636 before activation.

## What changed

Branch `claude/fm-636-release-20261124` = production-live `deccc596` (record of 38684d9a) plus three cherry-picks of
`claude/fm-636-fix-prod` (verified on dev in `measure-internal-20261124222648-35d27f6d`):

- `9337b0b1` FM-630 (cherry-pick of `db7cae63`/`b2bd0bf2`, whose own release was rolled back on 11-23 for an unrelated
  compat stall): `BaseGeometry.dropEmptyFaces`; wall mode drops base faces with no area on open.
- `2387dd0b` + `4e1a5ad6` FM-636: `BaseGeometry.dropSpikes` removes a no-width corner (out and back over the same
  line) from a base face that cannot be drawn, keeping the cleaned ring only if it then draws; wall mode runs it on
  open and saves, and the weld (`wall_face_draft.js`) runs both repairs on the base faces it moves.

Served files: `editor_scripts/base_geometry.js` `a989c81b…`, `wall_face_draft.js` `64c77598…`, `wall_mode.js`
`ba01942c…` (equal to dev). Tests in `dev/` (not served). No Node, PHP, data, environment, flag, NGINX or
config-library change; saved bases are repaired by the editor the next time a tech opens the order.

## Rollout (fast path)

Scripts: `/srv/agents/work/fm-636-prodrun-scripts` on fm-agents-1 (FM-630's fast-path set; rollback in `rollback/`).

- Built on the dev worker (`build.sh`, 322 s), archive sha256 `faf8aed78198601b31f355ce40594a8891e0581aa603600e614ccb20ca5d7aa1`.
  `dev/base-geometry.test.cjs` 21/21 and `dev/wall-face-draft.test.cjs` 643/643 on the release tree.
- `fastpath.sh decide`: fast path; server, dependencies and configuration the same; 5 changed files, 0 Node files
  (the three editor scripts and two earlier release records).
- `release.sh install` (compatibility, worker) and `publish` (previous channel sha256 `61d2be2c…`, 38684d9a);
  `fastpath.sh web-install` on the six web nodes; `tools`; `check` passed on all 8 hosts.
- Compatibility kills in the 90 min before: 0. `switch` 23:15:37–23:17:43 UTC: compatibility, six web nodes, worker;
  every host kept its Node MainPID and served the 3 files with the new bytes.

## Checks

- `current` = 4e1a5ad6 on all 8 hosts; `/v1/health/ready` 10/10 ok, all on 38684d9a (the release Node started in;
  fast path, no restart).
- `https://app.1m8.ai/measure/internal/editor_scripts/{base_geometry,wall_face_draft,wall_mode}.js`: 12/12 each equal the
  plan's sha256. Only these three of the served editor scripts differ from before the release.
- Editor proof with production's served scripts: FM-636's order (exteriors_f8ab6ebe…) restores in wall mode (before:
  `restoreErr: The face does not define a valid planar region`); FM-630's order (exteriors_bc3841a8…) restores too.
- 5xx from 23:15:37 to 23:28: web nodes 0.01–0.05 % vs 0.02–0.04 % in the 30 min before; compatibility 0.47 % vs
  0.69 %; every 5xx is the long-standing `top_view_reroll_proxy.php`. Compatibility: 0 watchdog kills, 0 Node 500s,
  0 pool timeouts, same MainPID 3681809.
- Worker since activation: 74 jobs completed, 0 failed; queued are future `report.release` timers (0 due).
