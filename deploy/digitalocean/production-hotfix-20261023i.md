# Production hotfix 6e8093f7: phone country codes (1M8-240), October 23, 2026 (05:13–05:24 UTC)

Released under Jack's standing approval. It is production `51e9d84f` plus `claude/phone-countries-20261022` (`01f5e5c2`).

The signup phone picker now lists only the served countries (52), with the detected country first. Numbers are formatted as typed, and the field shows a preview of the international number it will save (E.164). It uses vendored `libphonenumber-js` 1.12.31.

## Checks

- `tsc` passes.
- `signup-region`: 6 of 6 pass.
- phone-input, vat-label-credits, portal-regressions and account-access browser tests: 28 of 28 pass.
- No stale cache keys.

**Build:** archive `0eff5828…`, verified.

## Rollout

- Compatibility, worker, the signed channel (against `f38896a7…`, `51e9d84f`) and six web nodes activated, 05:13–05:24.
- Each node passed readiness and the asset match.
- Public readiness returned `6e8093f7` 10 out of 10 times.

## Errors on the compatibility host

The 20 s check counted 6 HTTP 500s. Grouped by route, none of them is new:

- **Referral tracking:** the usual `trackAcquisitionEvent` noise.
- **Tutorial upload:** `POST /v1/internal/tutorial-projects/tutorial_c6d771f6…/artifacts`, all from one tutorial project and one student. It has failed since 04:32, before this release.

## Rollback

Every role keeps `51e9d84f`. Republish it (`f38896a7…`) to the channel before rolling back a web node.
