# Production hotfix 9c022473: European login billboard, October 23, 2026

Released under Jack's standing approval. It is production `6e8093f7` plus `claude/kind-ishizaka-2fffa9` (`f4c4600e`).

European visitors saw "Not Found" in the login page's left panel, because `eu.1m8.ai/billboards/login` returns 404. Every visitor now gets `https://1m8.ai/billboards/login/`. A same-origin status check (`portal/marketing/billboard_status.php`, cached for 5 minutes per host) shows a fallback panel when the billboard is missing.

## Checks

- PHP lint passes.
- login-billboard, phone-input, portal-regressions and account-access browser tests: 29 of 29 pass.
- No stale cache keys.

**Build:** archive `9f39f64c…`, verified.

## Rollout

- Compatibility (0 errors and 0 crashes in the next 20 s), worker, the signed channel (against `0eff5828…`, `6e8093f7`) and six web nodes activated.
- Public readiness returned `9c022473` 10 out of 10 times.

## Rollback

Every role keeps `6e8093f7`. Republish it (`0eff5828…`) to the channel before rolling back a web node.
