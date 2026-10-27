# Suspend, archive and revoke for admins; Settings only with a settings page — development, October 22, 2026

Source `e9bfef63` on the session branch `claude/users-settings-20261022`, cut from `codex/hotfix-20261023e` (`7df89fe0`, which
contains production `1de5ee2b`). Not merged to canonical or the hotfix branch; production was not changed.

**1M8-235: archive and suspend unavailable.** People treated every Super admin as the account owner (`isOwner` matched
`super_admin`), so a person invited as Super admin, now possible from the invite form, showed greyed Suspend and Archive and
the invitation could not be revoked. The owner is now only the person who created the account (signup role `owner` with no
other level), plus the last active super admin is protected; you still cannot suspend or archive yourself. The same rules are
enforced by the server (`assertOrganizationKeepsAdmin` in platform/api.ts on PATCH status or level, DELETE, and the portal
actions `org_users_set_disabled_my`, `org_users_delete_my` and `org_users_set_perms_my`): `owner_protected` and
`last_admin_protected`. A disabled action's label says why, and archiving someone who never signed in reads "Revoke
invitation" (the link stops working; they stay under Archived and can be restored).

**1M8-236: Settings without settings access.** A view-reports-only user had a Settings gear that opened an empty page. The
launcher (portal/scripts/core.js `settingsAvailable`) is shown only when Settings has a page for the person: one of their
own pages the organization switched on (My Settings, Notifications, Phone, Channels, App download; AI Agents with project
access) or a page their permissions open (company settings, users, user permissions, report settings, billing, payroll,
feed, channels, platform billing). These are the section gates of settings/company.js, which the server enforces per
section. Until the session's permissions arrive the launcher stays. Desktop and the mobile drawer share the launcher.

**Tests.** People browser harness (`people-settings-browser.test.mjs`): an invited super admin can be suspended and revoked,
the owner and yourself are protected with the reason shown, and signed in as someone else the only super admin is protected;
the FirstMeasure-only expectations now read "Revoke invitation" for an unaccepted invite. `settings-launcher-access-browser.test.mjs`
(the gate in Chrome for permissions and organization flags), and a server case in `account-org-invites.test.ts` (owner and
last-admin rules, a migrated organization without a signup owner). `npm run check` passes; the related suites fail only where
they also fail on `7df89fe0`.

**Rollout.** `output/users-settings-20261022/` (commit-base `7df89fe0`), all four roles on `1cf37662`, every file merged
cleanly onto live (the apps manifest by replaying the two People bundle keys, `20261022-users-settings-v1`). Staged, activated
worker, legacy, web and pool, verified on `e9bfef63`.

**Checked on dev.1m8.ai** (pilot company): a user invited and made Super admin shows Suspend and "Revoke invitation"
enabled, revoking archived them; the owner's own row says "You cannot suspend or archive yourself"; the server refuses
suspending the owner (`owner_protected`); the owner has the Settings launcher on desktop and mobile, the view-reports-only
test user has none on either.
