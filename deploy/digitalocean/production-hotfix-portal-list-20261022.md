# Production hotfix c9479381: customer portal project list (1M8-230), October 22, 2026

Jack authorized the release.

## Problem

Since the October 20 release, every customer's portal project list stopped at
October 20. The portal mirrored FirstMeasure orders into the platform project
store, and production refuses those writes because no organization has
`platform.expanded_access`.

New orders were placed and processed but didn't appear in the list. Customers
reordered and created duplicates; 1M8-231 covers the duplicate-order side.

## Fix

Branch `codex/hotfix-portal-list-20261022`, built on production `8c908166`:

- `3eca5f19` (cherry-picked from `41b65307`): an account without expanded access
  lists FirstMeasure orders directly and skips the refused platform sync. The
  same commit carries the portal display fixes 202, 205, 206, 208, 210 and 211.
- `13e98984` (from `a1a58fd2`): a regression test that runs the real
  `list_projects` against a stale platform store.
- `c9479381` (from `d706f831`): the expedite wait bar (1M8-197).

No data repair is needed. Lists read the FirstMeasure orders, which were always
complete.

**Tests:** all 21 portal-regression and report-header tests pass, as does
`tsc`. Every changed bundle has a new cache key.

**Build:** the dev worker built archive `d8912d45…`, 358,616,611 bytes,
verified.

## Rollout (UTC)

| Time | Role | Result |
| --- | --- | --- |
| 18:11 | Compatibility | Activated in 39 s. The background-off drop-in still applies. |
| ~18:13 | Signed web channel | Published, checked against `d1d3ed8b…` (`8c908166`). |
| 18:14–18:24 | Six web nodes, one at a time | Each drained and activated in about 94 s. Each passed readiness, the asset match and the sandbox 404. |
| — | Worker | Unchanged on `8c908166`. Nothing it runs changed. |

**Afterwards:**

- Public readiness returned `c9479381` 10 out of 10 times.
- The portal serves the fixed `core.js` (`platformExpandedAccess`).
- No new errors. The only 500s are the existing `trackAcquisitionEvent`
  duplicate-key errors, and the 403s are the known `events/stream` noise at the
  same rate as before.

## Rollback

Compatibility and web keep `8c908166`. Republish it (`d1d3ed8b…`) to the
channel before rolling back a web node.
