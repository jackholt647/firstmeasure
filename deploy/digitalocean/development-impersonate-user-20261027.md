# 1M8-248: Customers tab impersonation by user record, development rollout, October 27, 2026

Branch `claude/impersonate-by-user-1m8-248`, from `production-live` (`12a429c8`, production `fc31553b`). Code commit
`b49136e1`. Not on production.

## Cause

"Impersonation failed: identity_not_found" comes from the Customers tab's Impersonate button
(`admin_impersonate_user`, `startCustomerImpersonation` in `public/v1/internal/api.ts`). It looked the sign-in identity
up by the user record's email. For users whose profile email was edited away from their sign-in email (1M8-244), no
identity has that email, so the lookup failed.

Not a regression: the lookup is unchanged since the initial import, and neither `fe807b75` nor `fc31553b` touched it.

## Fix

- The Customers tab sends the user id with the email (`portal_scripts/customers.js`).
- The server reads that user record, follows its `identity_id`, and selects the membership for exactly that
  organization and user. With no user id, it still looks up by email.
- User rows in the internal organization views always carry `id` (the record id), so the tab has an id to send.
- Test: `public/v1/tests/customer-impersonation.test.ts`. It fails on production code and passes with the fix.
- `customer-export.test.ts` and `internal-permissions.test.ts` each fail one test on `production-live` as well;
  neither failure is caused by this change.

## Production, read-only (nothing written)

- 50 organization users still have an email with no identity: the same 50 identity ids as the 1M8-244 dry run.
- All 50 are linked to an identity that has a different email. None has a missing identity, a dangling `identity_id`
  or no `identity_id`.
- The legacy journal logs only the route and status, not the action, so identity_not_found can't be counted on its own.
- `/v1/internal/legacy-action` 404s after the two releases were within the range of earlier days.

## Development rollout

- `output/impersonate-user-20261027/` rolled out to the worker, legacy and web roles; the pool is down.
- Each role's live `api.ts` was three-way merged. Dev's live copy also has the staff-impersonation guard from the
  security release, and `replay.py` keeps it while replacing only the email check.
- Verify passed.

Verified on the dev legacy service with a temporary staff session, deleted afterwards along with the impersonation
session it created. Target: `user_20dd62a9076d1166` in `org_fb1d3dd27a843f61`, profile `fasco@gosunflo.com`, sign-in
`fascojunk@gosunflo.com`.

- Email only: 404 `identity_not_found`.
- With the user id: 200, `org_fb1d3dd27a843f61` / `user_20dd62a9076d1166`.
- `https://dev.1m8.ai/measure/internal/portal_scripts/customers.js` serves the version that sends `user_id`.
