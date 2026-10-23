# Production hotfix aa66cd9b: VAT label at the checkout total (1M8-241, Ben's bounce), October 23, 2026

Released under Jack's standing approval. It is production `2f246d80` plus `claude/vat-checkout-total-20261023` (`7e3ddeb8`).

## What changed

- "VAT included" is gone from the top of the "Needed for order" card.
- The checkout card's total now reads, for example, "€25 VAT included".
- No prices changed.

## Checks

- vat-label-credits, phone-input and portal-regressions browser tests: 27 of 27 pass.
- billing-pending-order, billing-resume-project and billing-workspace: 11 of 11 pass.
- No stale cache keys.

**Build:** archive `4f318641…`, verified.

## Rollout

- Compatibility (0 errors and 0 crashes in the next 20 s), worker, the signed channel (against `30e2b877…`, `2f246d80`) and six web nodes activated.
- Public readiness returned `aa66cd9b` 10 out of 10 times.

## Rollback

Every role keeps `2f246d80`. Republish it (`30e2b877…`) to the channel before rolling back a web node.
