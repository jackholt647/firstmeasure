# Production hotfix 51e9d84f: VAT label only where credit is added (1M8-241), October 23, 2026 (~04:35–04:47 UTC)

Released under Jack's standing approval. It is production `242fba6c` plus `claude/vat-label-credits-20261023` (`ab16a5c9`).

"VAT included" no longer shows on the order flow's property-type cards or on the Order button. It stays on the billing top-up page, the signup "Load your account" step and the Stripe credit checkout. This is display only: prices and VAT are unchanged.

## Checks

- `vat-label-credits-browser` and `portal-regressions`: 21 of 21 pass.
- No stale cache keys: `project-request` is at `20261023-vat-credits-only-v1`.

**Build:** archive `f38896a7…`, verified.

## Rollout

- Compatibility, worker, the signed channel (against `94c1b947…`, `242fba6c`) and six web nodes activated, 04:38–04:47.
- Each node passed readiness and the asset match.
- Public readiness returned `51e9d84f` 10 out of 10 times.

## Rollback

Every role keeps `242fba6c`. Republish it (`94c1b947…`) to the channel before rolling back a web node.
