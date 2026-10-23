# Production hotfix 2f246d80: phone picker rework (1M8-240, Ben's bounce), October 23, 2026

Released under Jack's standing approval. This release is production `67cb3617` plus `claude/phone-countries-2-20261023` (`ab63b371`, `ffbdfc29`).

## What changed

- **No "Saved as" line.** The phone field formats the number in the selected country's national style as it is typed: UK `020 7946 0123`, Sweden `070-123 45 67`, US `(555) 555-0123`. Numbers are still stored in E.164.
- **Ben's country list only.** The picker offers the 21 countries Ben listed in the 1M8-240 description, kept as `operating_countries` in `commerce/region-data.json`.
- **Restyled picker.** It now matches the account-switcher menu.

## Checks

- `tsc` passes.
- `signup-region`: 6 of 6.
- phone-input, login-billboard, portal-regressions, account-access and vat-label-credits browser tests: 33 of 33.
- No stale cache keys.

**Build:** archive `30e2b877…`, verified.

## Rollout

- Compatibility, with 0 errors and 0 crashes in the next 20 s.
- Worker.
- Signed channel, published against `a80cf249…` (`67cb3617`).
- Six web nodes.

Public readiness returned `2f246d80` 10 out of 10 times.

## Rollback

Every role keeps `67cb3617`. Republish it (`a80cf249…`) to the channel before rolling back a web node.
