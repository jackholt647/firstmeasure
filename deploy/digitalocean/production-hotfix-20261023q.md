# Production hotfix 6948c461: imported accounts' logos on reports (1M8-242), October 23, 2026 (~19:16–19:28 UTC)

Released under Jack's standing approval. It is production `8ee3c3b1` plus `claude/fix-1m8-242-logos` (`712de6b4`).

## Cause

748 accounts imported from legacy kept the old relative logo path, `organizations/<org>/logo.png`, in their default branch settings. That file exists on no production host. Branch settings won over the organization's working platform logo URL, so their reports carried a broken logo.

## Fix

The fix is in the reader only (`firstmeasure/api.ts`); no data is written:

- The server prefers the platform logo URL over the old relative path.
- When only a missing old path exists, it falls back to the account's logo in the media store.

Reports already delivered stay without a logo unless they are regenerated.

## Checks

- `tsc` passes.
- `legacy-organization-logo` (4, which fail without the fix), `portal-regressions` and `report-header`: 22 of 22.

**Build:** archive `9b4d8a70…`, verified.

## Rollout

- **Compatibility:** activated.
  - The 20 s check counted 47 HTTP 500s.
  - Grouped by route, every 500 in the 40 minutes around the release is `POST /v1/private/referrals/trackAcquisitionEvent` (1,160 in total), at the same rate before and after.
  - No other route failed and no errors were logged.
- **Worker:** activated.
- **Signed channel:** published against `f8cd6cf7…` (`8ee3c3b1`).
- **Web:** six nodes activated.
- **Readiness:** public readiness returned `6948c461` 10 out of 10 times.

## Follow-up

`trackAcquisitionEvent` 500s have grown to about 40 a minute, all of them pre-existing noise.

## Rollback

Every role keeps `8ee3c3b1`. Republish it (`f8cd6cf7…`) to the channel before rolling back a web node.
