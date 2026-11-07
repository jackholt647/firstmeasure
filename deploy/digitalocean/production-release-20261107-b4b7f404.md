# Production release b4b7f404: company name banner only where documents, email or the portal are on (FM-350), November 7, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan branch was built on `5eb8b1db` plus
the FM-351 record; production had moved on to `da4ea82e` (FM-352 follow-up), so production-live `6e79aeb9` was merged
into it as the plan says (a record file only, no conflict):

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-350 Feature-gated banner | `6fce50b8` (gating, cherry-pick of canonical `640ddbf2`) and `3bea9810` (new-signup test, cherry-pick of canonical `933572d9`) on `claude/fm-350-feature-gated-banner-prod` | `b4b7f404` (merge of production-live `6e79aeb9`) | `platform-20261106212845-3f6715e9` (gating) and `platform-20261106234107-0da88f3d` (test) |

## Change

- `public/v1/platform/attention.ts`: the `company_name` attention source ("Add your company name", topbar and
  notification) returns an entry only when at least one of `platform.documents`, `comms.email` or
  `platform.customer_portal` is effectively on, read from the request's own capability resolution (no new reads;
  pending offers count as off). The body names only the apps that are on (`companyNamePlaceholderBody`).
- Not served: `public/v1/tests/platform-attention.test.ts`.
- Diff against production-live `6e79aeb9` is only those two files. No PHP, browser, environment, database, migration,
  flag, nginx, dependency or data change; no data repair.

## Checks before release

- On fm-agents, tree `b4b7f404`: `tsc --noEmit` clean; `tests/platform-attention.test.ts` company-name tests 2, 3 and 4
  pass (only the subtest "existing notifications API behavior is untouched" fails, as it does without this change).
- Build on the dev worker (`npm run check` included), 270 s. Archive sha256
  `a9a1b3dcecadfbd3aff5b8c935da62cbfc8d5422dd7ab8655ba40982adbf1737`, verified on fm-agents, compatibility, the worker
  and each web node. Its `dist/platform/attention.js` has `companyNamePlaceholderBody` and not the old fixed copy.
- New assert in `web_activate.py` (FM-350), beside FM-335 to FM-352 and cad6a00b: each node's
  `dist/platform/attention.js` holds `function companyNamePlaceholderBody` and `platform.customer_portal` and not
  "Documents, emails and the portal show a placeholder".
- Control before release: production served `da4ea82e` everywhere, `dist/platform/attention.js` had no gating.
  Read-only probe on a web node for `org_7bd1ca9110156d78` ("Your Company", a FirstMeasure-only signup from 11/06):
  `apps.firstmeasure` on, `platform.expanded_access`, `platform.documents`, `comms.email`, `platform.customer_portal`
  off.

## Rollout (scripts: fm-agents /srv/agents/work/fm-350-prodrun-scripts)

- Rollback target before activation: `da4ea82e9baf4acda8e31cd6ffd80c60e1169cab`, every host's `current` at 01:49 UTC;
  recorded on FM-350.
- Worker first at 01:58:30 UTC (no job running): 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `efa5ade6…` (da4ea82e's archive).
- Six web nodes one at a time behind the load balancer, 01:59:33–02:14:31 UTC (about 2.5 min each), each asset-checked
  plus every FM assert.
- Compatibility last at 02:15:52 UTC through the gate: it waited one minute at 603 `legacy-action`/min and opened at
  406/min, load 2.0. 0 Node 500s and 0 HTTP worker exits in the 20 s after.

## After activation

- All eight hosts point `current` at `b4b7f404`. Public readiness answered `b4b7f404`, `ok`, on 10 of 10 (all six
  instances), twice.
- FM-350: every web node's `attention.js` has the gating. Read-only probe of the deployed code on two web nodes:
  `org_7bd1ca9110156d78` resolves to an empty body, so no company-name entry; `{ comms.email }` gives "Emails show a
  placeholder instead of your company's name.", all three on gives the old full copy.
- `GET /v1/platform/organizations/<org>/attention` from real sessions since 02:17: 1,051 answers 200 and 5 answer 403
  across the six nodes; 403 was already about 0.2 % of this route before the release (449 in the two days of logs on
  two nodes). No 5xx on the route.
- FM-349's credentialed preflights, `/v1/platform/me`, `/portal/login.php` 200 and signed-out `/portal/` 302 through
  the load balancer unchanged from the previous release.
- 5xx: during compatibility's restart (02:15:52–about 02:16:30) the web nodes' `/v1/internal/*` proxies to it returned
  about 50–80 5xx each, as on every compatibility activation. From 02:17 to 02:20: web 0–0.12 % (about 2,500–2,800
  requests each; the 30 min before were 0.29–0.42 %, nearly all `top_view_reroll_proxy.php`), compatibility 0.78 %
  (10 of 1,286, 9 `top_view_reroll_proxy.php`, failing before this release).
- Compatibility, 02:15:52–02:21: cluster watchdog **0 kills**, 0 Node 500s, 0 pool timeouts at 336–708
  `legacy-action`/min.
- Worker, 01:58:30–02:21: 91 jobs completed (7 `imagery.process`, 50 `pdf.sync`, 10 `report.delivery`, 24
  `report.release`), none failed and none retried. 229 `report.release` queued, none due (scheduled holds, as before).

## Not covered

- No signup was made on production. That a new FirstMeasure-only signup no longer sees "Add your company name" in the
  portal is for a person to confirm (Ben's incognito check).

## Rollback

`da4ea82e9baf4acda8e31cd6ffd80c60e1169cab` is still installed on every host: activate it on the web nodes one at a
time, the worker and compatibility with `activate-release.sh` (`fm-350-prodrun-scripts/rollback/`), and republish the
channel with da4ea82e's archive against `a9a1b3dc…`. Code only: rolling back brings the banner back for unnamed
FirstMeasure-only organizations.
