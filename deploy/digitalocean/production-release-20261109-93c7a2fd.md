# Production release 93c7a2fd: an account left without a super admin gives its owner back their access (FM-353), November 9, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan commit was already a child of release
`f0d23e3f` (production-live `5f583639` is `f0d23e3f` plus its record), so it was released as is, with no cherry-pick:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-353 single-user admin permissions | `93c7a2fd` (= canonical `97183603`) on `claude/fm-353-single-user-admin-permissions-prod` | `93c7a2fd` | `platform-20261109182527-898502a5` |

## Change

- `public/v1/platform/auth.ts` (Node, every role): `buildAuthContext` calls the new `restoreOwnerWithoutSuperAdmin`.
  It acts only when the signed-in person is active, not a super admin, and their identity membership for the
  organization says `owner`; then it lists the organization's users, and if no active user is a super admin it writes
  the person back to owner as sign-up made them (`role` owner, `org_permission_level` owner,
  `org_permissions {level: owner}`, `permissions {"*": true}`, `super_admin` added to an explicit `access_role_ids`).
  The record's metadata gets `owner_restored_at`, `owner_restored_reason` ("FM-353: …") and `owner_restored_from`
  (previous role, org_permissions and permissions). The write merges into the stored record (`upsertDocument`
  without `replace`), so the user's other fields are kept. An owner lowered by another active super admin stays
  lowered; other members are never promoted.
- Not served: `public/v1/tests/account-org-invites.test.ts` (FM-353 case), `docs/architecture/permissions-and-agents.md`
  and `docs/optimization-backlog.md` (the rule and its per-request user list).
- No PHP, editor, browser, environment, database migration, flag, nginx, dependency or config library change. No
  manual data repair: the affected accounts are restored by this code when their owner next signs in or loads a page.

## Checks before release

- The diff of `93c7a2fd` equals canonical `97183603` line for line.
- Build on the dev worker (`npm run check` included), 274 s. Archive sha256
  `1e456b12116237b4cd24f8d14a6cc366b35030a30d963cfe37f53d8d07e1bb11`, verified on fm-agents, compatibility, the worker
  and each web node. The archive's `dist/platform/auth.js` holds `restoreOwnerWithoutSuperAdmin` (defined once,
  called once from `buildAuthContext`) and the FM-353 reason.
- New assert in `web_activate.py` (FM-353), beside FM-324, FM-335 to FM-354 and cad6a00b: each node's
  `dist/platform/auth.js` has the function, its call and the reason once.
- Baseline at 18:42 UTC: web 5xx 0.08–0.09 % over 30 min, `/v1/platform/*` about 3–5 401s and 23–38 403s per
  ~9,800 requests per node, 0 `buildAuthContext` errors in the hour; compatibility 0.75 % (nearly all
  `top_view_reroll_proxy.php`), 4 watchdog kills in the 3 h before.
- Read-only audit on the worker at 18:48 (redacted: org ids and counts only): 13,838 organizations, **24** with users
  but no active super admin (the 24 of the plan, `org_2fe7c973719ddedf` and `org_89a01db6b0cf40e7` among them),
  none restored yet.

## Rollout (scripts: fm-agents /srv/agents/work/fm-353-prodrun-scripts)

- Rollback target before activation: `f0d23e3f2d69391695d10e0d1c6b9324e32e22aa`, every host's `current` at 18:34 UTC;
  recorded on FM-353.
- Signed channel published from compatibility against `ebe92bd4…` (f0d23e3f's archive).
- Worker at 18:46:17 UTC (no job running): 8 slots, production, heartbeat off, outbound email on.
- Six web nodes one at a time behind the load balancer, 18:45:07–18:58:16 UTC; every node passed every assert,
  including FM-353's.
- Compatibility last at 18:58:31 UTC through the gate, which opened at once at 334 `legacy-action`/min, load 1.1.
  0 Node 500s and 0 HTTP worker exits in the 20 s after.

## After activation

- All eight hosts point `current` at `93c7a2fd`. Public readiness answered `93c7a2fd`, `ok`, on 10 of 10 after the
  web rollout and again at 19:21, after compatibility.
- 19:00–19:10 (after compatibility settled): web 5xx 0.05–0.10 % (the 30 min before: 0.11–0.16 %), every one the
  existing `top_view_reroll_proxy.php` except one `editor.php`. `/v1/platform/*` on each web node: 0 5xx, 0–2 401s
  and 4–8 403s per ~3,300 requests, the same rate as before. 0 `buildAuthContext`, `restoreOwnerWithoutSuperAdmin` or
  `document_missing` errors since activation in the journals of two web nodes (64.23.240.81, 143.198.104.224),
  compatibility and the worker.
- Compatibility from 18:58:31 to 19:20: cluster watchdog **0 kills**, 0 pool timeouts at 246–637
  `legacy-action`/min, load up to 1.7. Its 2 Node 500s were both at 18:58:31 ("Fastify has already been closed",
  the restart itself). 5xx 0.86 % against 0.67 % before, 63 of 64 `top_view_reroll_proxy.php`.
- Worker, 18:46:17–19:09: 409 jobs completed (69 `imagery.process`, 252 `pdf.sync`, 58 `report.delivery`, 30
  `report.release`), none failed and none retried. 270 `report.release` queued, none due (scheduled holds, as before).
- FM-353 audit rerun at 19:20: still 24 organizations without an active super admin, 0 restored, the reporter's user
  still viewer. Expected: restoration happens on the owner's next authenticated request; none had made one yet.

## Not covered

- An affected owner actually getting owner back on production: none had signed in by 19:20. Rerun the audit
  (`fm-353-prodrun-scripts/audit_after.mjs` via `audit_after.py` on the worker) later; restored users carry
  `owner_restored_reason` FM-353 and drop off the list. For the reporter, after they next open the app,
  `org_2fe7c973719ddedf/users/user_deacda697780824d` should be role owner.

## Rollback

`f0d23e3f2d69391695d10e0d1c6b9324e32e22aa` is still installed on every host: activate it on compatibility, the web
nodes one at a time and the worker (`fm-353-prodrun-scripts/rollback/`: `release.sh compat|worker|publish`,
`web_rollout.sh`), and republish the channel with f0d23e3f's archive against `1e456b12…`. Code only: owners already
restored stay owners, the state sign-up gave them.
