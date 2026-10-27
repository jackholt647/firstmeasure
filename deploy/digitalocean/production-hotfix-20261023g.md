# Production hotfix 242fba6c: customer user order counts (1M8-238), October 23, 2026 (03:05–03:16 UTC)

Released under Jack's standing approval. It is production `9daef908` plus `claude/customer-user-order-count-20261023` (`51384eaa`).

On the internal Customers tab, each user's order count is now counted from their orders in the organization. A stored count is kept only when it is higher. Before, the stored signup value of 0 was shown: 11,579 user documents carry it.

## Checks

- `tsc` passes.
- `internal-api`, `customer-summary-batch-postgres`, `customer-country` and `customer-dashboard-search`: 16 pass, 0 fail, 1 skipped.
- The change is server-only, so no cache keys changed.

**Build:** archive `94c1b947…`, verified.

## Rollout

| Time | Role | Result |
| --- | --- | --- |
| 03:05 | Compatibility | Activated. 0 errors and 0 crashes in the next 20 s. |
| 03:05 | Worker | Activated. |
| 03:06–03:16 | Signed channel and six web nodes | Channel published against `6f6695f8…` (`9daef908`). Each node drained and activated in about 94 s, and passed readiness and the asset match. |

Public readiness returned `242fba6c` 10 out of 10 times.

## Rollback

Every role keeps `9daef908`. Republish it (`6f6695f8…`) to the channel before rolling back a web node.
