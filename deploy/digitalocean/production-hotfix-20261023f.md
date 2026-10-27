# Production hotfix 9daef908: People protection and Settings launcher (1M8-235, 1M8-236), October 23, 2026 (02:35–02:47 UTC)

Released under Jack's standing approval. It is production `1de5ee2b` plus `claude/users-settings-20261022` (`e9bfef63`).

- **1M8-235:** admins can suspend, archive and revoke other super admins. The account owner and the last active super admin stay protected, and the server now enforces that in `assertOrganizationKeepsAdmin`. Who may manage users is unchanged.
- **1M8-236:** Settings is hidden for users with no settings page.

## Checks

- `tsc` passes.
- `account-org-invites`: 5 of 5 pass.
- people-settings, settings-launcher-access, account-access, people-legacy-levels and portal-regressions browser tests: 59 of 59 pass.
- Every changed bundle has a new cache key.

**Build:** archive `6f6695f8…`, verified.

## Rollout

| Time | Role | Result |
| --- | --- | --- |
| ~02:35 | Compatibility | Activated. 0 errors and 0 crashes in the next 20 s. |
| ~02:35 | Worker | Activated. |
| 02:37–02:47 | Signed channel and six web nodes | Channel published against `3318d2e0…` (`1de5ee2b`). Each node passed readiness, the asset match and the sandbox 404. |

Public readiness returned `9daef908` 10 out of 10 times.

## Rollback

Every role keeps `1de5ee2b`. Republish it (`3318d2e0…`) to the channel before rolling back a web node.
