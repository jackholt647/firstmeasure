# 1M8-246: onboarding asks for the company name again (development, October 26)

Branch `claude/company-name-20261026`, cut from `production-live` (`1d16c61b`, production `fe807b75`).
Commits `059ae868` (fix and test), `ef6d7a10` (sample report and team page show the typed names), `66c4d0c4` (spacing).
Live on development legacy and web (the worker has no files in this change; pool unreachable, as since October 22).
**Not on production.** Nothing was written to production data.

## Cause

Signup (login page, landing widget, Google) never asks for a company name, so `createOrganization` names every new
organization "Your Company". Until October 20 the onboarding welcome page asked for full name, phone and company name and
saved them with `org_update_my`. The September 21 integration (`2325b63c`) turned those inputs into plain text that shows
the current names, and the October 20 release (`31f87be5`) shipped it. Every organization created on production since
then (710 by October 27 01:45 UTC) is "Your Company", and its owner has no name.

## Fix

- `public/libraries/apps/onboarding/wizard.js`: the welcome page asks for "Your name" and "Company name" while either is
  unsaved ("Your Company", "Untitled Organization" and "Default Branch" count as unsaved; a name equal to the email counts
  as no name). Nothing leaves the page until both are filled; the fields are marked and a notice says what is missing.
- They are saved with the branding through `org_update_my` (`name`, `full_name`), the action Company Settings uses. A
  saved name is never rewritten. The sample report shows the company name as it is typed and the team page lists the owner
  by name.
- Six onboarding catalog keys (`ob_full_name_*`, `ob_company_name_*`, `ob_names_missing_*`), translated in every pack;
  only the onboarding catalog was rebuilt (`onboarding.ba4a9710d866d100.json`).
- Test: `tests/onboarding-company-name-browser.test.mjs` runs the real wizard in Chrome (2/2);
  `signup-language-catalog` and `vat-label-credits-browser` pass.

Verified on dev.1m8.ai with two new signups: desktop (`org_03043e8c75eaf752`) and phone width (`org_6becd8c8a96ef273`).
Empty fields are refused, and the organization and identity carry the typed names afterwards.

## Production data

Read-only scan and repair dry run (no writes) are in the side-session notes (`1M8-246-dryrun.md`, `1M8-246-no-name.tsv`):
744 placeholder organizations since October 20. 34 have a high-confidence name from the website they typed in onboarding,
114 need review (from an email domain), and 596 have no evidence. No organization record holds the real name.
