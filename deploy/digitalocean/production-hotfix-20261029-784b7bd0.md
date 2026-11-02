# Production hotfix 784b7bd0: onboarding step 1 names only the missing field (FM-302, 1M8-250), October 29, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-302 set to Testing in prod, verified on dev). Run from fm-agents-1; a laptop run before it was stopped before activating anything.

It is production-live `3e902d1d` (code `3d1fdb12`), plus:
- `d587264a`, a cherry-pick of `c26ea539` (`claude/owner-handover-20261028`), "Onboarding names only the missing field";
- `784b7bd0`, which bumps the `onboarding/wizard.js` bundle key to `20261028-missing-field-v1`.

Branch `claude/fm-302-if-i-press-next-on-step-one-of-creating--prod`, tree `333144b4`. It does not carry 1M8-251 (owner handover).

## Cause

On the welcome step, `welcomeNamesComplete()` in `onboarding/wizard.js` marked only the empty field but always showed one fixed notice, "Your name and company: Enter your name and company name to continue."

## Fix

Frontend and language only:
- With one field missing, the notice names that field: "Your name: Enter your name to continue." or "Company name: Enter your company name to continue." With both empty, the combined notice stays.
- New keys `ob_name_missing_body` and `ob_company_missing_body` in `catalog-source.json` and all 15 packs; the onboarding catalog is `onboarding.653746189c18c32d.json`.
- Both fields stay required.

## Checks

- **Dev:** live and verified in `platform-20261029193403-c7771b4b` (canonical `b2bf56cc`, same wizard, catalog and pack content). Server regression run passed (type check, localization check, `onboarding-company-name-browser`, `people-settings-browser`, `account-org-invites`, `route-access`); each case was exercised in the real `/portal/` page.
- **Production branch:** `onboarding-company-name-browser` 2 of 2; `node --check` on both changed scripts.
- **Pre-existing:** `localization-catalogs.mjs --check` fails on `errors` and `session-replay`, as on `3d1fdb12`.

**Build:** on the dev worker (npm ci, check, build), archive `a48761d7…`, verified.

## Not changed

No migration, configuration, environment or data change.

## Rollout

- Compatibility at 20:23:07Z, from `3d1fdb12`, with 0 errors and 0 crashes in the next 20 s; still the heartbeat owner.
- Worker at 20:24:01Z, after no running jobs; production environment values unchanged.
- Signed channel, published against `4e370cd7…`.
- Six web nodes, 20:25 to 20:35 UTC, one at a time, each drained from the load balancer, ready, with matching assets.

Public readiness returned `784b7bd0` 10 out of 10 times. Production serves the catalog manifest's `onboarding.653746189c18c32d.json` (200), the bundle key `20261028-missing-field-v1`, and a `wizard.js` with both new keys.

After activation, web 5xx were at or below each node's rate for the same length of time before it. Compatibility's 500s are the existing `top_view_reroll_proxy.php` ones (about 50 to 60 every 10 minutes since before 19:00), plus one 502 during its restart. The worker completed 153 jobs with 0 failed; the 404 queued `report.release` jobs are all scheduled for later. No production signup was created to test.

## Rollback

Every role keeps `3d1fdb12`. Republish it (`4e370cd7…`) to the channel before rolling back a web node. Code only.
