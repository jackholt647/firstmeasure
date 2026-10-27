# Production hotfix 71bf98a2: Impersonate works for users whose profile email differs from their sign-in (1M8-248), October 27, 2026

Released under Jack's standing approval. It is production `fc31553b` (records `12a429c8`) plus `claude/impersonate-by-user-1m8-248`: `b49136e1` and record `71bf98a2`.

## Cause

This was not a regression from `fe807b75` or `fc31553b`. The internal portal's Customers tab Impersonate button looked up a person's sign-in by the email on their user record. For the 50 users whose profile email was edited away from their sign-in email (the 1M8-244 dry run), that lookup returned `identity_not_found`. The lookup was unchanged since the initial import.

## Fix

The Customers tab now sends the user id with the email, and the server follows that user record to its sign-in identity. Support can impersonate all 50 users, whatever is decided about their emails.

## Not changed

Production data. The 50 users' emails wait for Jack.

## Checks

customer-impersonation (new), route-access and account-org-invites: 9 of 9 pass. The type-check is clean. The internal portal loads `customers.js` with `?v=time()`, so no cache keys apply.

**Build:** archive `e73134a1…`, verified.

## Rollout

- Compatibility at 04:30:26Z, with 0 errors and 0 crashes in the next 20 s.
- Worker.
- Signed channel, published against `b272cc31…`.
- Six web nodes, 04:32 to 04:40 UTC, each ready with matching assets.

Public readiness returned `71bf98a2` 10 out of 10 times.

## Rollback

Every role keeps `fc31553b`. Republish it (`b272cc31…`) to the channel before rolling back a web node.
