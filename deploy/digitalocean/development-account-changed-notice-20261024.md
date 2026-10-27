# Development: shorter account-changed notice (October 24, 2026)

Release `a03568a3` on branch `claude/account-changed-notice-20261024`, cut from the hotfix tip `65c1fcca`
(`codex/hotfix-20261024v`, where this notice was added in `61402f23`). It is not on the canonical branch.

## Change

`public/libraries/account-switcher/account-switcher.js` only. The notice a tab shows after another tab switches accounts:

- Reads "You switched accounts / This tab is still on {page}. Another tab switched to {active}." with
  "Back to {page}" and "Continue as {active}". New language keys (`account_changed_title_short`,
  `account_changed_body_short`, `account_changed_back_short`).
- Accounts are named by company; the email is added only when both accounts share a company name.
- Title, text and buttons use the portal's `Montserrat-Regular` face; buttons use `--primary-readable` (the
  organization's primary color) instead of a fixed `#1a73e8`.

## Rollout

`output/account-notice-20261024/` (copied from the acquisition-tracking rollout), legacy then web, the file three-way
merged onto each live copy (both live releases `0222323f`, live file equal to the hotfix copy). Staged, activated and
verified (`verify_exit=0`) in one attempt.

Checked on dev.1m8.ai: a simulated switch from another tab shows the new copy, the Montserrat title and the organization's
red buttons.

To release to production: ship the one file to the web nodes and compatibility; no server change.
