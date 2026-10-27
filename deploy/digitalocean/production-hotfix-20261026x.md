# Production hotfix 3c2c21da: Help & support for every customer (1M8-243), October 26, 2026

Released under Jack's standing approval. It is production `eac399d9` (records `0978bd54`) plus `claude/customer-support-entry-20261026` (`7d5ca591`).

## Cause

This was a regression. The floating help card ("Need a hand?", support@1m8.ai) was customers' only support entry. Commit `2325b63c` (Sep 21) commented it out of `portal/index.php` because it covered chat composers. It left production with the Oct 20 release `31f87be5`.

The in-report Support tab is not a replacement: it needs `report_followup`, which only 52 of 12,257 orgs have.

## Fix

The help card loads again without the floating button. A question-mark "Help & support" button now sits in the sidebar's bottom row:

- every customer sees it, whatever their permissions, Settings access or app settings;
- it appears in every sidebar layout, and in the menu drawer on phones;
- it opens the same card, and support is still by email to support@1m8.ai.

## Checks

support-entry-browser (new), settings-launcher-access, portal-regressions and account-access: 27 of 27 pass. PHP lint passes. There are no stale cache keys, and `core.js` is versioned by hash.

**Build:** archive `08e695b4…`, verified.

## Rollout

- Compatibility, with 0 errors and 0 crashes in the next 20 s.
- Worker.
- Signed channel, published against `13f47378…`.
- Six web nodes.

Public readiness returned `3c2c21da` 10 out of 10 times. The `core.js` served in production carries the launcher.

## Rollback

Every role keeps `eac399d9`. Republish it (`13f47378…`) to the channel before rolling back a web node.
