# Production hotfix f9c88a71: users export gets the organization's country (FM-309), November 2, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-309 set to Testing in prod, in Done in Dev). Run from fm-agents-1.

It is production-live `cd686cca` (code `226e87fd`, FM-319) plus one commit from `claude/fm-309-add-country-field-to-the-users-export-prod`, unchanged: `f9c88a71`. 2 files, +70/−2. Canonical `aff309c4` is not an ancestor, so the config library gate does not apply.

## Change

- **Export Users TSV** (`public/measure/internal/portal_scripts/customers.js`) ends with two new columns, `organization_country` (ISO code) and `organization_country_name`. The existing columns and their order are unchanged. The server's export page already returned both values.
- Regression test, not served: `dev/customers-users-export.test.cjs`.

## Not changed

No Node code, migration, configuration, environment or data change.

## Checks before release

- **Dev:** `measure-internal-20261102051115-72f3a91a`. The export function ran on real dev rows through a replaced `apiPost`; nobody clicked the button signed in, because the dev test login isn't staff (from the production plan).
- **Build:** on the dev worker (npm ci, check, build, prune), archive sha256 `1660c72ec352c53982e7ade745fea085b80a3972c31ee2de788de812d4f7ae58`, verified, and rechecked on compatibility and the worker after copying.

## Rollout

- Compatibility at 05:21:44–05:21:56 UTC, from `226e87fd`. Three staff `POST backend_login.php` requests got 502 at 05:21:50–53 during the restart.
- Worker at 05:22:20 UTC, after no running jobs: 8 slots, production, email on, heartbeat off.
- Signed channel published against `a2f4e4f4…` (new archive `1660c72e…`), so new pool nodes get this release.
- Six web nodes from 05:23:23 to 05:36:21 UTC, one at a time. Each was drained from the load balancer and ready in about 94 s, with served assets matching the release, and the next node started only after public readiness answered from that node on the new release.

Public readiness returned `f9c88a71` 40 out of 40 times with all six instances answering, then 10 out of 10. All eight hosts run `f9c88a71`.

## After activation (to about 05:38 UTC)

- **New code served:** `customers.js` on app.1m8.ai has the same sha256 as the commit's file and contains `organization_country_name`.
- **Web nodes:** no HTTP worker exits. Five nodes had no 5xx after activation; `143.198.104.224` had 2 of 334 (0.6%), both `top_view_reroll_proxy.php`, against 0.15–0.27% across the nodes before. These windows are 2–13 minutes long.
- **Compatibility:** 11 of 2,594 nginx 5xx (0.42%) since 05:21:56, all the existing `top_view_reroll_proxy.php`, against 0.24% (17 of 7,219) in the half hour before. That is a small rise in percent, inside the 0.06–0.51% range of the 10-minute windows from 03:00 to 05:20. This release does not touch that path. No Node 5xx, no HTTP worker exits.
- **Worker:** no failed jobs and no error-level log lines; 41 jobs completed since activation (PDF sync, report release, report delivery, imagery). 50 queued, all `report.release`, none due yet (scheduled; 48 were queued before activation).

**Not checked:** nobody has clicked Export Users TSV on production. The real `customer_users_export_page` call and the file download have not run with the new columns, on dev or production. The real confirmation is a staff member clicking Export Users TSV in the internal portal: the last two columns show the country code and name.

## Known limits

- An organization with no evidence of its country has US with source `legacy_default`, and the export shows these as plain US (2 of the 25 orgs checked on dev).
- Canonical's `customers.js` doesn't have this change. It is on `lane/measure-internal` and this production-live, and a release built directly from canonical would drop the columns.

## Disk

After this release, compatibility is at 93% (9.0 GB free), `64.23.240.81` at 90% (9.8 GB free), and the other five web nodes at 88% (13 GB free). Nothing was deleted. Old releases need pruning soon.

## Rollback

Every role keeps `226e87fd`. Republish it (`a2f4e4f4…`) to the channel before rolling back a web node, then `activate-release.sh 226e87fd… <service>` on each role. Code only: this release writes nothing.
