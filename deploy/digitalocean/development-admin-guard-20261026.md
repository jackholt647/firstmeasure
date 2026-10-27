# 1M8-245: adding a person never replaces a member (development, October 26)

Branch `claude/admin-guard-20261026`, cut from the production hotfix branch `codex/hotfix-20261026x` (`26612569`).
Code commit `ef1e3db5`. Live on development worker, legacy and web (pool unreachable, as since October 22).
**Not on production.** Production received only the data repair below.

## What happened at What The Hail Roofing (`org_243874dbe004671c`)

An organization user's record id comes from their email (`user_` + the first 16 hex of sha256(email)), and the signup
owner's id has the same value. On October 26 at 17:43:57 UTC someone in the account used People › Invite with the
owner's own email. `POST /v1/platform/organizations/:orgId/users` (`createPlatformOrgUser`) wrote that id with
`replace: true`, so the owner's record became a new invited viewer (`role` viewer, `permissions` view_reports). The
1M8-235 guard (`assertOrganizationKeepsAdmin`) only ran on PATCH, DELETE and the three portal actions, never on create.
The other member was a manager without user permissions, so nobody could undo it. From 18:18 the owner's requests
were refused (403 on credits, departments, users).

`org_users_add_my` (`portalAddOrgUser`) and the canvassing invite (`createOrInviteCanvassingUser`) had the same
replace-by-derived-id shape; PUT `/users/:id` replaced a record without the guard.

## Fix

- `POST /users` and `org_users_add_my` refuse an existing, unarchived member (same id or same email):
  409 `org_user_exists`, "That person is already in this account. Change their level in People instead." People's
  invite dialog shows the message. An archived member can be added again.
- `assertOrgUserWriteKeepsAdmin(orgId, userId, next)` checks the record a write will store: the owner may only stay
  owner or super admin, and the last active super admin may not stop being one. It runs in
  `upsertPlatformOrgUserDocument` (PUT and PATCH) and in the canvassing invite.
- Test: `tests/account-org-invites.test.ts` (new case; 6/6 pass). `tsc --noEmit` clean. The 24 failures in
  assistant-api, platform-attention and project-trays-api (`apps.assistant` capability_denied) fail the same on `26612569`.

Dev merge: dev's live `portalAddOrgUser` (security-audit work, not on production) already refuses an existing member
with `user_exists`; the rollout kept that live hunk (`output/admin-guard-1M8-245/replay.py`). Verified on
dev.1m8.ai: a fresh signup inviting its own email gets 409 `org_user_exists` and stays owner.

## Production data repair (approved by Jack through the coordinator)

Backup on compatibility `144.126.222.110`: `/var/backups/firstmeasure/1M8-245-20261026T202158Z/` (users.json,
organization.json, identity without password fields). Written with the storage writer as a merge guarded by
`expected_revision: 20`; only these fields changed on `users/user_7d3dc98ec115d2ac` (wthroofing@gmail.com):

| field | before (rev 20) | after (rev 21) |
| --- | --- | --- |
| role | viewer | owner |
| org_permission_level | viewer | owner |
| org_permissions | {level: viewer, items: {}} | {level: owner, items: {}} |
| permissions | {view_reports: true} | {"*": true} |
| roles | [] | [sales_appointments, inside_sales] (the signup default) |

Metadata gained `repaired_at` and `repair_reason`. The identity membership already said owner. Production's own
`buildAuthContext` for that user now returns role owner with order_reports, manage_company_users,
manage_company_user_permissions and manage_billing; the manager is unchanged. Not restored: the owner's original
`stats` counters (unknown) and the profile fields the overwrite reset to defaults.

## Other production organizations without an active owner or super admin (read-only, nothing changed)

12,302 organizations scanned. 760 have no user records at all (legacy accounts created January 31 to August 24).
27 have users but no active owner or super admin: 4 look like the same bug (three confirmed in the access logs:
`org_2fe7c973719ddedf` and `org_89a01db6b0cf40e7` "Your Company", `org_ca786d14ee342321` Roofing911; plus
`org_5e1fdcfbfc7911fc` M&H Roofing Services, older than the logs), 15 have a sole user without
manage_company_user_permissions, 5 have a "custom" user holding all seven flags, 3 have only an invited super admin.
The full list with emails is in the side-session notes (`1M8-245-affected-orgs.md`), not in the repository.
