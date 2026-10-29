# Production hotfix 9af332be: owners are asked for the company name, and Settings › Company saves it again (FM-300, 1M8-246), October 29, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-300 set to Testing in prod, verified on dev). Run from fm-agents-1, right after FM-302's `784b7bd0`.

It is production `784b7bd0` (FM-302), plus the three FM-300 commits from canonical:
- `7522bd4e` (canonical `81189dbd`): ask owners for the company name while the organization is still "Your Company";
- `70e04531` (canonical `b41c572a`): the company name banner takes the topbar ahead of payments setup;
- `9af332be` (canonical `f3cb595a`): Settings › Company saves the company name to the organization again.

Branch `claude/fm-300-every-company-since-10-20-has-no-company-prod`. The issue's production plan named the same three commits on `3e902d1d` (`22d43784`); they were rebased onto `784b7bd0` so this release keeps FM-302. The diff from `784b7bd0` is the plan's diff line for line. `production-live` records it as a merge, because FM-302's record commit `7e569a69` came after `784b7bd0`.

## Cause

1. Organizations that signed up Oct 20 to 26 were never asked for a name again after `fc31553b`, so 744 of them kept the "Your Company" placeholder. Nothing in the portal asked for it.
2. Owners couldn't fix it either. Settings › Company saved the typed name only into the default branch's presentation style; the organization's own `name` was never written, and the page reloaded the old name. The `PlatformAPI.orgs.patch` call had been dropped in `2325b63c` (Sept 21).

## Fix

- `public/v1/platform/attention.ts`: a computed `company_name` attention source. While the organization's name is a placeholder ("Your Company", empty, "Untitled Organization"), people with `manage_company_settings` see an orange topbar banner, "Add your company name", and a pinned notification row; the button opens Settings › Company. It ranks above the payments-setup banner. Nobody without the permission sees it.
- `public/libraries/apps/settings/company.js`: saving renames the organization (`PATCH /organizations/:id {name}`) when the name changed, then refreshes the attention feed. Manifest key `20261029-company-name`.
- Tests: `tests/platform-attention.test.ts`, `tests/company-settings-organization-name.test.mjs`.

## Checks

- **Dev:** live and verified in `platform-20261029195417-2c677f88` on a throwaway organization: banner shown for "Your Company", hidden for a named organization, rename saved and kept after reload, banner gone at once.
- **Production branch (`9af332be`):** `tsc --noEmit` clean; `company-settings-organization-name` 2 of 2; the new `platform-attention` subtests pass.
- **Pre-existing:** `platform-attention`'s "existing notifications API behavior is untouched" fails the same way on unchanged `3e902d1d`.

**Build:** on the dev worker (npm ci, check, build), archive `914b0eca…`, verified. Copied from the dev worker to compatibility and the worker through fm-agents-1.

## Not changed

No migration, configuration, environment or data change. The dry-run names for the 744 organizations (34 high confidence, 114 to review) were **not** written; that needs Jack's decision in FM-300. Until then, owners are asked by the banner.

## Rollout

- Compatibility at 20:41:12Z, from `784b7bd0`, with 0 Node 500s and 0 crashes; still the heartbeat owner.
- Worker at 20:41:50Z, after no running jobs; 8 slots, production, email on, heartbeat off.
- Signed channel, published against `a48761d7…`.
- Six web nodes, 20:42 to 20:52 UTC, one at a time, each drained from the load balancer, ready, with matching assets (including `settings/company.js`).

Public readiness returned `9af332be` 20 out of 20 times. Production serves the manifest key `20261029-company-name` (FM-302's `20261028-missing-field-v1` is still there) and a `company.js` with the organization rename.

After activation, the only web 5xx at nginx were the existing `top_view_reroll_proxy.php` 500s, below each node's earlier rate. The Fastify "Reply was already sent" warning on a `/v1/firstmeasure/pr…` route runs at the same rate as the hour before. No attention errors. The worker completed 162 jobs with 0 failed and did not restart. The authenticated attention check on a production organization was not run: this run has no production session, and no production data was touched to test.

## Rollback

Every role keeps `784b7bd0`. Republish it (`a48761d7…`) to the channel before rolling back a web node. Code only; names owners have already saved stay.
