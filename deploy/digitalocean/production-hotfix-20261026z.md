# Production hotfix fc31553b: onboarding asks for the company name again (1M8-246), October 26, 2026

Released under Jack's standing approval. It is production `fe807b75` (records `1d16c61b`) plus:

- `claude/company-name-20261026`: `059ae868`, `ef6d7a10`, `66c4d0c4` and record `313ca01a`;
- `fc31553b`, which bumps the apps manifest's `onboarding/wizard.js` bundle key from `20261023-signup-language-v1` to `20261026-company-name-v1` so returning browsers load the new step.

## Cause

No signup path asks for a company name. Before Oct 20, the onboarding welcome page asked for full name, phone and company, and saved them. The Sept 21 integration (`2325b63c`) turned those fields into plain text, and it shipped in the Oct 20 release (`31f87be5`). Since then, 744 orgs have been named "Your Company".

## Fix

The welcome page asks for "Your name" and "Company name" while either is unsaved ("Your Company" counts as unsaved), and doesn't move on until both are filled. They are saved through the same action Company Settings uses, and a saved name is never overwritten. The sample report and the team page show the typed names. The new strings are in every language pack.

## Not changed

Production data. A dry run (`1M8-246-dryrun.md` in the shared notes, kept out of the repo) proposes names for 34 orgs at high confidence and 114 for review. 596 have no evidence. Nothing is written until Jack approves.

## Checks

onboarding-company-name-browser, signup-language-catalog, company-onboarding, platform-localization and route-access: 14 of 14 pass. There are no stale cache keys.

**Build:** archive `b272cc31…`, verified.

## Rollout

- Compatibility at 01:58:36Z (Oct 27), with 0 errors and 0 crashes in the next 20 s.
- Worker.
- Signed channel, published against `8cab11f0…`.
- Six web nodes, 02:00 to 02:08 UTC, each ready with matching assets.

Public readiness returned `fc31553b` 10 out of 10 times. Production serves the manifest with `20261026-company-name-v1` and the new wizard.

## Rollback

Every role keeps `fe807b75`. Republish it (`8cab11f0…`) to the channel before rolling back a web node.
