# Production hotfix ef39262b: staff can impersonate, and customers aren't locked out, when a user's profile email differs from their sign-in (1M8-244, 248, 249, 252, 253), October 28, 2026

Released under Jack's standing approval. It is production `71bf98a2` (records `e7603c76`) plus `claude/impersonate-account-email-1m8-249` (`ef39262b`).

## Cause

- **Staff side.** `71bf98a2` fixed the Customers tab row button, but the Impersonate buttons in the organization window's Users list call `Customers.impersonateUser(email, name)`, which dropped the user id. The server kept looking up the sign-in by profile email and returned `identity_not_found`.
- **Customer side.** `portal/scripts/core.js` set the page's email from the user record before the sign-in identity. The account guard added on Oct 21 (`61402f23`) compares the page's email with the session's.
  - For anyone whose two emails differ, they never match: the account menu lists both emails, and the guard stops the tab with "You switched accounts in another tab". Ask Zello reported this as "completely locked out".
  - It affected all of the roughly 50 mismatched users since Oct 21.

## Fix

- **Staff side:** the helper passes the user id. Without one, the server finds the user record by organization plus profile email, so tabs opened before this release also work. Impersonation then follows that record's identity.
- **Customer side:** portal pages use the sign-in email first.

## Not changed

Production data. The per-account recommendations wait for Jack. They are in `identity-mismatch-dryrun-1M8-244.md` in the shared notes, kept out of the repo.

## Checks

These pass, 30 of 30:
- customer-impersonation;
- route-access;
- account-access-browser;
- portal-regressions-20261021;
- account-switching;
- account-switcher-ui-contract.

The type-check is clean. `core.js` is versioned by content and `customers.js` by `time()`.

**Build:** archive `b0e797a0…`, verified.

## Rollout

- Compatibility at 22:18:36Z, with 0 errors and 0 crashes in the next 20 s.
- Worker.
- Signed channel, published against `e73134a1…`.
- Six web nodes, 22:20 to 22:28 UTC, each ready with matching assets.

Public readiness returned `ef39262b` 10 out of 10 times.

## Rollback

Every role keeps `71bf98a2`. Republish it (`e73134a1…`) to the channel before rolling back a web node.
