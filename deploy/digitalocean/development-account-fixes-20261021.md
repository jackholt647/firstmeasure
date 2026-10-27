# Customer portal account and user fixes — development, October 21, 2026

Source `61402f23`, committed on the session branch `claude/nifty-wright-f19096` and based on `31141b11`
(`fixes-base-20261021`, the production release plus the October 21 hotfixes). The commit is not on the canonical branch
yet; the coordinating session merges it. Production was not changed.

**1M8-207: admins shown as viewers.** With the platform off, People shows each user's FirstMeasure level from
`userLegacy()` (people-data.js). Signup writes the first user as role `owner` with no level, and any level outside
viewer/manager/admin/super_admin/custom fell back to Viewer. `owner` now reads as Super admin (and is protected from
suspend/archive like other owners); any other unknown level is read from the user's flags (`*` is Super admin, an exact
preset match is that preset, anything else is Custom). Company settings' `normLevel` also treats `owner` as Super admin.
Regression: the People users page is new in 31f87be5.

**1M8-204: the same order on both accounts.** A browser has one active account (the account switcher swaps the session
cookie), but a tab keeps the account it loaded as (`__APP.userOrgId`). After a switch or a sign-in in another tab,
`projects/list` answered for the active account, so the old tab listed the other account's orders under its own name.
Now each portal page announces its account in `localStorage` (`fm_active_account_v1`), and a tab whose account is no
longer active stops with a notice: continue as the active account (reload) or switch back. A `projects/list` refresh
whose page account is not the session's is refused (`organization_forbidden`), and a refused portal request triggers the
same check. Browser-wide caches are kept per organization: the project store (`fm_platform_project_store_v1:<org>`; the
old shared store is dropped), the pending order (stamped with its organization; billing ignores another account's, so a
top-up in one account never submits the other's order) and the theme cache (stamped with its organization; reads in
company settings, the report viewer, onboarding and the portal shell require a match, so no other company's logo or
colors appear). Remembered accounts now carry `organization_id`, so one email in two companies shows as two accounts.

**1M8-203: logo upload failed.** The upload endpoint, size limits and storage worked on dev (a 70-byte and a 2 MB PNG
both saved). Production nginx logs show the company settings page receiving `403 organization_forbidden` (127-byte
bodies, repeated retries): the upload sends the page's organization, and the session belonged to another account
(1M8-204). The upload now shows the server's message instead of a bare code, and the refusal opens the account notice.

**1M8-213: inviting someone who already has an account.** The invite did add a membership, but the email linked to
activation with no organization, the activation's sign-in picked the person's first company, and the invited user stayed
"Invited, never signed in". Invitations now carry `org=<organization>`: `activate.php` and `login.php` sign in to it (both
the legacy-action login and the `/auth/login` sync). Someone who already has an account (signed in before, or has a
password) gets "You've been added to <company>" with a sign-in link instead of "set your password" (which reset their
password), and the create response says `existing_account`, which People shows to the inviter.

**1M8-212: activation code wording.** `activate.php` sends `purpose=activation`; the email is "1m8 Activation Code" and the
page says "We sent an activation code to your email". Password reset is unchanged.

**1M8-209: invite UI.** The photo field is a styled button with the chosen file's name instead of the browser's "Choose
File". Organizations without roles choose the permission level in the invite (Viewer, Manager, Admin, Super admin), shown
only to someone who may set levels and applied through the existing permissions update after the user is created.

**1M8-201: oval profile photos.** `.pp-avatar` is an inline grid; the photo's percentage size counted as auto while the
grid sized its row, so a tall photo stretched the avatar (34x102 measured in Chrome). The image is now absolutely
positioned inside the avatar (34x34).

**Bundles.** `people/people-data.js`, `people/people-kit.js`, `people/users-page.js`, `settings/company.js`,
`billing/app.js`, `project-request/app.js` and `projects/viewer.js` use `versionedBundle(..., '20261021-account-fixes-v1')`;
the account switcher, `core.js`, `project_viewer.js`, `index.php`, `login.php` and `activate.php` are versioned by the portal.

**Tests.** New: `account-org-invites.test.ts` (existing-account invite email and link, sign-in into the inviting company and
the inviter's view, activation code wording, remembered accounts' organizations, a stale tab's refresh refused),
`account-org-browser.test.mjs` (two Chrome tabs on different accounts, the per-organization caches, pending orders, round
avatars) and `people-legacy-levels.test.mjs` (owner and unknown levels, invite level). `npm run check` and PHP lint pass.
The overlapping existing suites (31 browser/contract files, 9 server files) have the same failures on the base commit;
nothing new fails.

**Rollout.** All four roles (`output/account-fixes-20261021/`, copied from `portal-regressions-20261021`, with backend
files). Each of the 18 files was three-way merged onto each role's live copy (base `31141b11`); every merge was clean
except the one-line apps manifest, onto which the seven bundle keys were replayed. The worker was activated first; another
session then activated legacy, so legacy's activation refused ("Active release changed") and nothing else moved. Legacy, web
and pool were re-audited on `d4d6ea7a`, rebuilt, staged, activated and verified on `61402f23`. The worker has since been
activated by the billing session (`039723d8`), merged onto live: its `auth.ts` and `firstmeasure/api.ts` are this
release's, and its `platform/api.ts` contains this release's changes.

**Checked on dev.1m8.ai** (pilot test accounts): the served People, account switcher and project store code is this
release's; remembered accounts carry their organization; a refresh with another account's organization gets 403
`organization_forbidden` and the account's own refresh lists its projects; the pilot owner (`role: owner`) reads as Super
admin; the invite form has the photo button and the Permission level select; inviting the QA pilot (an account in another
company) returns `existing_account: true` and a `login.php?...&org=` link, signing in with that organization opens the
inviting company and the inviter then sees the person active, and a plain sign-in still opens the person's own company (the
invite check user was archived afterwards); two tabs in one browser: after the second tab signed in to the drafter pilot,
the first showed the account notice, the second did not, and "Switch back" moved the first back to the customer and the
second then showed the notice. Not checkable on dev: the email texts (dev Postmark answers 422 for the `@example.com`
pilot recipients, before and after this release); they are covered by `account-org-invites.test.ts`.
