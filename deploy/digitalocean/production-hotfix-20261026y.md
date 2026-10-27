# Production hotfix fe807b75: sign-in email and owner guard (1M8-244, 1M8-245), October 26, 2026

Released under Jack's standing approval. It is production `3c2c21da` (records `26612569`) plus two fixes:

- `claude/identity-mismatch-1m8-244` (`de3d8c6d`);
- `claude/admin-guard-20261026` (`ef1e3db5`);

and their development records. The two fixes' tests both append to `account-org-invites.test.ts`; both tests were kept.

## Fixes

### 1M8-244

Changing an organization user's email in People no longer leaves their sign-in on the old address.

- An account someone signs in to keeps its email. The change is refused with `sign_in_email_locked`.
- An unused invitation moves with the corrected email.

### 1M8-245

People › Invite, the onboarding add-user action, the canvassing invite and a full-record save could replace an existing member's record. With the owner's own email, that turned the owner into an invited viewer.

- Adding someone who is already a member is now refused with 409 `org_user_exists`.
- Whole-record writes refuse to demote the owner or the last active super admin.

## Data repairs (made earlier today, before this release)

### Proven Roofing (1M8-244)

The owner identity's email was changed from info@ to adrian@provenroof.com. The backup is `/root/backups/1m8-244-20261026/` on compatibility.

### What The Hail Roofing (1M8-245)

The owner was restored on `user_7d3dc98ec115d2ac`. The backup is `/var/backups/firstmeasure/1M8-245-20261026T202158Z/` on compatibility.

### Not changed

A read-only dry run of the 50 other users whose sign-in email differs from their profile email found that most still sign in with the identity email. Switching them would lock them out, so none were changed until Jack decides.

A read-only scan found 27 orgs with users but no active owner or super admin. 4 of them were hit by the same overwrite. None were changed.

## Checks

account-org-invites and route-access: 7 of 7 pass. The type-check is clean.

**Build:** archive `8cab11f0…`, verified.

## Rollout

- Compatibility at 21:02:51Z, with 0 errors and 0 crashes in the next 20 s.
- Worker.
- Signed channel, published against `08e695b4…`.
- Six web nodes, 21:06 to 21:14 UTC, each ready with matching assets.

Public readiness returned `fe807b75` 10 out of 10 times.

## Rollback

Every role keeps `3c2c21da`. Republish it (`08e695b4…`) to the channel before rolling back a web node.
