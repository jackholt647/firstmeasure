# Production hotfix 1de5ee2b: draft cleanup for 1M8-234, October 23, 2026 (01:37–01:47 UTC)

Released under Jack's standing approval. It is production `9ada3dc1` plus `claude/impersonation-orders-20261023`
(`cd6b04f2`): the portal discards drafts that exist only in the browser cache at the address of a
listed order, so a processing order is never shown as a new draft with the order button.

No impersonation-specific code path was found. Livia's exact account is still unknown.

**Tests:** order-status-real-app, portal-regressions, portal-order-without-expanded-access and
report-tabs-real-clicks: 34 of 34 pass.

**Build:** archive `3318d2e0…`, verified.

## Rollout

| Time | Role | Result |
| --- | --- | --- |
| 01:37 | Compatibility | Activated. 0 errors and 0 crashes in the next 20 s. |
| 01:37 | Worker | Activated. |
| 01:38–01:47 | Signed channel and six web nodes | Channel published against `7f630109…` (`9ada3dc1`). Each node passed readiness, the asset match and the sandbox 404. |

Public readiness returned `1de5ee2b` 10 out of 10 times.

## Rollback

Every role keeps `9ada3dc1`. Republish it (`7f630109…`) to the channel before rolling back a web node.
