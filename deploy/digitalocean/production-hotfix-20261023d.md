# Production hotfix 9ada3dc1, October 23, 2026 (00:53–01:05 UTC)

Released under Jack's standing approval for tested hotfixes. Branch
`codex/hotfix-20261023d` is production `ce7a2ed4` plus
`claude/portal-projects-list-20261022` (`b5da9acd`).

## Change

Project list pages first select the page's ids, then read only those rows'
manifests. Rows and their order are unchanged.

## Why

Staff-app list pages (Stats and the Customers order history) read and sorted
every project's full manifest on every page:

- p95 22 s at 22:58–23:22 UTC;
- on production's database, EXPLAIN showed 2.8 s for page 1 and 7.8 s for a deep
  page, with a 1.2 GB sort spilled to disk.

The new query takes 69 ms and 222 ms for the same pages.

## Checks

- `legacy-list-page-postgres` (embedded Postgres) compares every page of four
  list types with the old query: they are identical.
- `tsc` passes.

**Build:** archive `7f630109…`, verified.

## Rollout (UTC)

| Time | Role | Result |
| --- | --- | --- |
| 00:53 | Compatibility | Activated. 0 errors and 0 crashes in the next 20 s. |
| 00:53 | Worker | Activated. |
| — | Signed channel | Published, checked against `b99079fa…` (`ce7a2ed4`). |
| 00:56–01:05 | Six web nodes | Each passed readiness, the asset match and the sandbox 404. |

Public readiness returned `9ada3dc1` 10 out of 10 times. There have been no HTTP
500s since. Overnight traffic is too light to compare list timings; check
daytime p95 for `firstmeasure/projects/list` on the web nodes.

## Rollback

Every role keeps `ce7a2ed4`. Republish it (`b99079fa…`) to the channel before
rolling back a web node.
