# Production hotfix ce7a2ed4, October 23, 2026 (00:11–00:21 UTC)

Jack authorized the release and gave standing approval for tested hotfixes.
Branch `codex/hotfix-20261022c`, on production `f7fd3fc8`, merges two branches.

## Contents

**`claude/report-tabs-hotfix-20261022`**

- `d12a4c71` (1M8-205, 1M8-232): report tabs follow the open report, and XML
  stays in the flat header.
- `772f66fb` (1M8-234): orders in a release hold read Processing again, and an
  existing project never mints a draft.

**`claude/customers-batch-reads-20261022`**

- `318f799d`, `1e995038`, `e3db0de0` (1M8-225): Customers rows are read in
  batched queries and full summaries are compacted per batch. Results are
  unchanged.

## Tests

- `tsc` passes.
- `customer-country`, `internal-api` and `customer-dashboard-search`: 16 of 16
  pass.
- Browser tests (`report-tabs-real-clicks`, `order-status-real-app`,
  `portal-regressions`, `report-header`, `portal-order-without-expanded-access`):
  35 of 35 pass.

## Rollout

Build `b99079fa…`, verified.

| Time | Role | Result |
| --- | --- | --- |
| 00:11 | Compatibility | Activated. 0 errors and 0 crashes in the next 20 s. |
| 00:11 | Worker | Activated. |
| 00:13–00:21 | Signed channel and six web nodes | Channel published against `4fa40b91…` (`f7fd3fc8`). Each node drained and activated in about 94 s, and passed readiness, the asset match and the sandbox 404. |

Public readiness returned `ce7a2ed4` 10 out of 10 times.

## Effect on the compatibility host

| | 22:40–00:10 (before) | 00:12–00:24 (after) |
| --- | --- | --- |
| `legacy-action` requests | 32,427 | 4,329 |
| p95 | 988 ms | 779 ms |
| Over 5 s | 204 | 1 |
| Over 10 s | 102 | 1 |

Since 00:12 there have been no HTTP 500s, no out-of-memory aborts and no worker
exits.

## Not in this hotfix

- The customer-portal project list slowness that followed `f7fd3fc8`
  (`firstmeasure/projects/list` p95 12 s on web nodes). A diagnosis session is
  working on it.
- 1M8-233 (Quad elevation page), which waits on a product decision.

## Rollback

Every role keeps `f7fd3fc8`. Republish it (`4fa40b91…`) to the channel before
rolling back a web node.
