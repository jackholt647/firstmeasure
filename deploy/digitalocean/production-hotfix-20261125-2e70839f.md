# Production release 2e70839f (FM-638 an ordered project's contact edits are saved to the order), November 25, 2026

Production runs `2e70839ff9145bc8a8e73d196e2ef498bb23d220` on all 8 hosts (compatibility, worker, 6 web nodes).
Rollback target: `4e1a5ad659bac5f038b41f2db59ea085c52cadc4` (FM-636 + FM-630), recorded on FM-638 before activation.

## What changed

Branch `claude/fm-638-option-a-implementation-prod`, one commit `2e70839f` on the release `4e1a5ad6` (canonical
`7e05427b`, verified on dev in `platform-20261125043019-9a5961f3`; its `access.ts` and `project_viewer.js` hunks equal
canonical's change from before the live-layer bake `a306e6f2` to `7e05427b`). Released as is.

- `public/portal/scripts/project_viewer.js`: without expanded access (report-only orgs), `ProjectStore.saveRemote`
  sends a changed primary contact (name, email, phone) of an ordered project to the existing customer route
  `PATCH /v1/firstmeasure/projects/<order id>` `{resident}`, one write per order at a time; a record without contacts
  never clears the order. Projects with expanded access are unchanged.
- `public/v1/firstmeasure/access.ts` (Node, all hosts): a customer's PATCH of that route stores only
  `resident.name/email/phone`, each text of at most 320 characters or null; other keys are dropped, a non-object or
  non-text value is 400 `invalid_resident`. Route, access entry and the organization + `order_reports` check unchanged.
- Tests: `tests/route-access.test.ts`, `tests/portal-order-without-expanded-access.test.mjs`.

No database, data, environment, flag, NGINX or config-library change. Contact edits customers made before this
release exist only in their browsers and are sent the next time they edit that contact.

## Rollout (full path)

Scripts: `/srv/agents/work/fm-638-prodrun-scripts` on fm-agents-1 (FM-635's full-path folder, one id pass, base =
the FM-636 fast-path release; rollback set in `rollback/`).

- The dev worker's build directory had filled its disk (99 %, 3.1 GB free): removed 115 build stages older than 3 days
  from `/var/tmp/fm-prod-release-20261020/` (scratch only; archives kept), 97 GB free after.
- Built on the dev worker (`build.sh`, 289 s, type check included), archive sha256
  `990c5b99d84a8386a53329b9dc5bdd2049deb13988d840642bd736aa05fc449e`. The extracted tree differs from 4e1a5ad6 only in
  the fix's two files, compiled `dist/firstmeasure/access.js`, the two tests and `release.env`. `web_activate.py`
  asserts 153/153 on the new tree (they fail on the old one); rollback asserts 150/150 on the old tree.
  Archive tests: `portal-order-without-expanded-access.test.mjs` 6/6; `dist/tests/route-access.test.js` 13/14 with
  the FM-638 test passing (test 4 fails the same on 4e1a5ad6's archive: pre-existing).
- Worker activated 05:04:39 UTC (no running jobs); web channel published (previous `faf8aed7…`); web rolled one node
  at a time 05:05:55–05:19:10, every node passing the asserts and back behind the LB; compatibility gate open at once
  (95 legacy-action/min, load 1.1), rolling replace at 05:19:28, both slots on 2e70839f.

## Checks

- `current` = 2e70839f on all 8 hosts; `https://app.1m8.ai/v1/health/ready` 10/10 ok on 2e70839f (twice, 05:19 and 05:40).
- Served `https://app.1m8.ai/portal/scripts/project_viewer.js`: `orderIdForProject` ×2, `saveOrderContact` ×2, sha256
  `a522a2fa06c69e64…` = the release file. Anonymous `PATCH /v1/firstmeasure/projects/probe`: 401 (3/3).
- Web nginx `PATCH /v1/firstmeasure/projects/*`: 24 h before ~280 × 200, 2 × 499, no 400/5xx; after: 1 × 200 from a
  customer plus the three 401 probes, no 400/5xx.
- 5xx from 05:21 (compatibility settled) to 05:32 vs the 30 min before: web 0.00–0.04 % vs 0.02–0.10 %, compatibility
  0.36 % vs 0.52 %; every 5xx is the long-standing `top_view_reroll_proxy.php`.
- Compatibility 05:20–05:39: 0 watchdog kills, 0 OOM, 0 Node 500s, 0 pool timeouts, MainPID 3681809 throughout
  (0 kills in the 24 h before). Worker since activation: 78 jobs completed, 0 failed, 4 queued; no stops, browser
  closures or pool timeouts.
