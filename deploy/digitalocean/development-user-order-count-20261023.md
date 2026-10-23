# Customer users' order counts (1M8-238), development rollout 2026-10-23

Branch `claude/customer-user-order-count-20261023`, cut from `codex/hotfix-20261023f` (`9daef908`). Commit `51384eaa`.
Not on production.

**Report.** The internal Customers tab showed Paco's Roofing Inc's user with 0 orders while the portal lists a dozen.

**Cause (predates the batched summaries).** Signup stores `stats.projects_ordered = 0` on every user document and nothing
updates it; `organizationUserView` (`public/v1/internal/api.ts`) preferred any stored count over counting the user's
orders. Production: Paco's only user stores 0, the organization has 14 indexed orders under its id and its row shows
`lifetimeOrders` 14 on page 34 of the default list; 11,579 user documents store 0 and 277 store a positive count. The
rule dates from the initial import (`6813cc6a`); batched and per-organization rows are identical.

**Fix.** Count the user's orders in the organization; keep a stored count only as a floor (legacy migration snapshots).
`tests/customer-summary-batch-postgres.test.ts` covers a stored 0 (counted 3) and a stored 4 (kept), on both paths.
`internal-api.test.ts` (12) passes; `tsc` clean.

**Verification.** Same page-1 request: production `9daef908` has 108 of 127 organizations with orders whose users all
show 0 orders; dev `51384eaa` has 2 of 119 (orders under emails that are not the organization's users).

**Rollout.** `output/user-order-count-20261023/ship.sh`: worker activated, then legacy refused ("Active release changed")
while another session activated `8be13d84`; legacy, web and pool were re-audited and rolled onto it (`verify_exit=0`).
All four roles run `51384eaa` with the change in source and `dist`.
