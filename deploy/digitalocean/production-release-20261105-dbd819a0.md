# Production release dbd819a0: QA mode controls, staff Edit button, sign-in org choice, fast frame saving (FM-340, FM-341, FM-342, FM-343), November 5, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, as one batch, under that
workspace's standing authorization for issues set to "Testing in prod" once verified on dev. It is production-live
`aaaf9537` (release `825b5601`, FM-339) plus each plan's production commit, cherry-picked in turn with no conflicts
(each diff identical to its plan commit):

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-340 QA mode controls | `a73de47d` (`claude/fm-340-qa-mode-controls-prod`) | `469aa38b` | `measure-internal-20261105204239-e009c220` |
| FM-342 Permission editing broken | `acf9753e` (`claude/fm-342-permission-editing-broken-prod`) | `c2c25cfd` | `measure-internal-20261105205735-6e7455a9` |
| FM-343 Slow frame saving | `7e300076` (`claude/fm-343-slow-frame-saving-prod`) | `c8fd9861` | `measure-internal-20261105212003-506d4153` |
| FM-341 Cross-org user transfer | `e8ea0f88` (`claude/fm-341-cross-org-user-transfer-prod`) | `dbd819a0` | `platform-20261105205610-d97a9271` |

Release branch: `claude/prod-batch-fm340-343` (tip `dbd819a06cf13ea74a04ef20e093423290d4bec2`).

## Change

- FM-340, `public/measure/internal/editor_scripts/wall_mode.js`: with the editor embedded and its header hidden (the QA
  view), the Wall mode / Return to roof toggle sits at the front of the toolbar's action group instead of the hidden
  address bar. `editor_scripts/project_resources.js` `reportImages`: elevation photo choices leave out video references.
- FM-342, `public/measure/internal/portal_scripts/users.js`: the Users tab's Edit button is bound with
  `addEventListener` to the row's user object instead of an inline `onclick` with `JSON.stringify(user)` (which broke
  for users whose Gmail signature contains `&quot;`).
- FM-343, `public/measure/internal/_resource_frames.php` `fm_resource_extract_frame`: the decode window writes each
  frame over one uncompressed PAM file and PNG-encodes only the last one; `project_resources.js` `pollFrameJob` keeps
  polling through a failed, stalled or 5xx/408/429 status check until the existing 5-minute deadline.
- FM-341, `public/v1/platform/auth.ts` `loginPlatformVerifiedIdentity`: without a requested organization the person
  belongs to, sign-in opens one where they are neither archived nor suspended (`membershipCanSignIn`); naming the
  organization they were archived from is still refused.
- Regression tests (not served): `dev/wall-mode`, `dev/resource-catalog`, `dev/users-edit-modal`,
  `dev/resource-frame-extract`, `dev/resource-media-viewer`, `public/v1/tests/account-org-invites.test.ts`.
- Roles: compatibility (editor/portal files and PHP; Node sign-in), web (Node sign-in). No schema, environment,
  configuration, flag, dependency, nginx/PHP-FPM or data change.

## Checks before release

- On the release commit: `php -l` clean, `node --check` on the three browser files; `node --test` on
  `dev/users-edit-modal`, `wall-mode`, `resource-catalog`, `resource-frame-extract`, `resource-submission-sources`:
  111 pass, 1 skipped (the PHP curl bridge, which needs curl in PHP; it passed on dev legacy).
- Build on the dev worker (`npm run check` included), 282 s. Archive sha256
  `907732a0890457684c70af6c10b72dbbf813e69da9c08aeec04bfda8e9774f31`, verified on fm-agents, compatibility, the worker
  and each web node. The archive's four editor/portal files are byte-identical to the commit, and
  `dist/platform/auth.js` has `membershipCanSignIn`.

## Rollout (scripts: fm-agents /srv/agents/work/prod-batch-fm340-343-prodrun-scripts)

- Rollback target before activation: `825b56012836dc44e9ef6d84ad7de54677b9519c`, every host's `current` at 21:31 UTC;
  recorded on FM-340, FM-341, FM-342 and FM-343.
- Worker at 21:40:20 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `a9496bbc…` (825b5601's archive); all six web nodes downloaded
  `dbd819a0` / `907732a0` from it.
- Six web nodes one at a time behind the load balancer, 21:41:24–21:54:42 UTC (about 2.2 min each), each asset-checked
  as in 825b5601's run plus the FM-340–343 strings.
- Compatibility last, at 21:54:50 UTC, at a calm minute (`legacy-action` 351/min, load 3.3). No Node 500s and no
  worker exits in the first 20 s.

## After activation

- All eight hosts point `current` at `dbd819a0` with the expected service active. Public readiness answered
  `dbd819a0`, `ok`, on 12 of 12 requests across all six instances after the web rollout and on 32 of 32 at 22:18.
- Served files: `https://app.1m8.ai/measure/internal/` `editor_scripts/wall_mode.js`, `editor_scripts/project_resources.js`
  and `portal_scripts/users.js` are byte-identical to the release commit (FM-340 markers 1 and 1; FM-342 `user-edit-btn`
  2 and no inline `JSON.stringify` handler; FM-343 "only a definite answer ends polling" 1).
- FM-340: headless Chromium with production's served editor scripts in the QA-embedded layout (header hidden): the
  toggle is in `toolbar-action-group`, visible, and goes Wall mode → Return to roof → Wall mode; in the normal layout it
  stays in the address bar. No page errors.
- FM-342: headless Chromium with production's served `users.js` and a user like ben@1m8.ai (signature with `&quot;`):
  Edit opens the modal for that user, no page errors (before this release it threw `Unexpected identifier`).
- FM-343: on compatibility, the active `_resource_frames.php` extracted the 4.0 s frame of a synthetic 1080p60 clip in
  3.50 s (the old code took ~25 s idle and 60 s+ under load); the clip lived only in `/tmp/fm343-check`, removed after.
  No real `action=frame` save happened between activation and 22:18.
- FM-341: read-only on the worker with the release's `dist`: the reporter's identity has two memberships;
  `membershipCanSignIn` is false for the archived `org_17ddc691182c500c` and true for `d7636ef71162e3fe336d30c1`, so a
  plain sign-in now opens the employer's organization. `loginPlatformVerifiedIdentity` was not called (it writes).
  Sign-in routes on every web node, 21:56–22:18 vs 21:20–21:40: `/v1/platform/auth/login` all 2xx before and after;
  `/v1/internal/legacy-action` 0 5xx after (3 before), 4xx 3–13 per node after vs 26–50 before.
- Web nodes from 21:56 (after the compatibility restart): 5xx 0.04–0.07 % against 0.14–0.18 % in the 30 minutes
  before, all `top_view_reroll_proxy.php` (failing before this release).
- Worker, 21:40:20–22:18: 427 jobs completed (66 `imagery.process`, 268 `pdf.sync`, 65 `report.delivery`, 30
  `report.release`), 0 failed, 0 level-50, 0 `firstmeasure_order_imagery_failed` / `imagery_provider_busy`. 253
  `report.release` queued, none due (scheduled holds, as before).
- Compatibility, 21:54:50–22:16 (21 min): cluster watchdog **0 kills** (about 11 in the 3 hours before), 0 Node 500s
  after the restart; load 1.4–5; `legacy-action` about 350–400/min. PHP-FPM "seems busy" warnings continue at the
  pre-existing rate (50–75 an hour all afternoon).

## Not in this release

- FM-340: the Edmonds Ave order's missing base (deleted by a Walls-layer box delete) is drafting work in the editor,
  not a data change; whether that delete should spare the base is an open question to Jack.
- FM-343: production compatibility's general saturation (2 vCPU, PHP-FPM `max_children` reached) is capacity, not
  this fix.

## Rollback

`825b56012836dc44e9ef6d84ad7de54677b9519c` is still installed on every host: activate it on the web nodes one at a
time, the worker and compatibility with `activate-release.sh` (`prod-batch-fm340-343-prodrun-scripts/rollback/`), and
republish the channel with 825b5601's archive against `907732a0…`. Code only; this release writes no data.
