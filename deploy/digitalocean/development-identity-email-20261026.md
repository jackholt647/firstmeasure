# Sign-in email and organization user email (1M8-244), production repair and development rollout 2026-10-26

Branch `claude/identity-mismatch-1m8-244`, cut from `codex/hotfix-20261026x` (`26612569`, production `3c2c21da`). Commit
`de3d8c6d`. Code not on production.

## Report

Proven Roofing & Construction (`org_89af6a1db06530a4`): impersonating Adrian Ornatowski (adrian@provenroof.com) failed
with `identity_not_found`, Forgot Password found no account, and signing in showed "You switched accounts in another
tab" naming info@provenroof.com.

## Cause

Adrian signed up on 2026-10-14 as info@provenroof.com (identity `identity_1c06a7e15131f214`, owner membership). By
2026-10-19 his organization user record `user_1c06a7e15131f214` said adrian@provenroof.com (source
`org_users_update`, the users collection PATCH that the People/Settings editor uses). That PATCH changes only the user
document; identities are looked up by email (`findIdentityByEmail`: password reset, impersonation, login), so
adrian@ matched nothing while he kept signing in as info@. The account guard compares the page's account (user record
email, adrian@) with the session's identity email (info@) in the same organization and reported a switch; "Switch back"
found no saved account for adrian@. The browser's owner-email lock is client-only; the server never checked. Not
caused by the Oct 20-24 releases.

## Production repair (2026-10-26 20:13 UTC, compatibility host, app writer `patchIdentity`)

- Backup (root-only, contains the identity's password hash): `/root/backups/1m8-244-20261026/before-2026-10-26T20-13-12-216Z.json`
  (identity row, user document, three `account-devices` documents). Post-change snapshot: `before-2026-10-26T20-13-22-244Z.json`.
- Before: identity email info@provenroof.com, revision 35; `findIdentityByEmail(adrian@)` = not_found.
- Change: identity email -> adrian@provenroof.com (revision 36), `metadata.email_changes` records from/to/reason.
  Password, memberships and the user record unchanged; Adrian stays owner.
- After: `findIdentityByEmail(adrian@)` = identity_1c06a7e15131f214 (the lookup Forgot Password and impersonation
  use); its membership is Proven, owner. info@ no longer signs in; Adrian signs in as adrian@ with his existing
  password or uses Forgot Password. No reset was sent and no impersonation session was started.

## Fix (`public/v1/platform/api.ts`, `upsertPlatformOrgUserDocument`)

A changed user email is reconciled with the linked identity: an invitation nobody has used, held only by this user,
moves with the record (uniqueness enforced by `patchIdentity`); an account someone signs in to, or one in another
organization, is refused with `sign_in_email_locked`, so an organization cannot redirect a person's login or resets.
Test: `tests/account-org-invites.test.ts` ("a user's email stays their sign-in email", 6/6 pass); `tsc` clean.

## Other organizations (read-only count)

50 of 14,239 production organization users have an email with no identity; all 50 are linked to an identity under a
different email (45 active, 3 invited, 2 pending; mostly owners; none differ only by case or spaces). Not changed:
each needs a decision on which email is right. List: side-session notes `identity-mismatch-1M8-244.md`.

## Development rollout

`output/identity-email-20261026/ship.sh` (tooling from `sign-own-choices-20261026`; dev pool is down): worker, legacy,
web, `verify_exit=0`; all three run `de3d8c6d`. Dev's live `account-org-invites.test.ts` came from another line, so
this test was appended to it (`replay.py`). Verified by source/dist inspection and the test, not a dev click-through.
