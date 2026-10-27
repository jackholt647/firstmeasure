# 1M8-243: Help & support for every customer - development, October 26, 2026

Source `7d5ca591` on `claude/customer-support-entry-20261026`, cut from `codex/hotfix-20261024w` (`0978bd54`, production
`eac399d9`). Not on the canonical branch.

**Cause (regression).** The portal's only support entry was the floating help widget (`libraries/apps/help/app.js`,
"Need a hand?" with `mailto:support@1m8.ai`). `2325b63c` (September 21, "Integrate local platform, localization and
exterior work for development") commented its script tag out of `portal/index.php`: "Floating help widget disabled
2026-07-22: low value and it covered UI (e.g. chat composers)". Production ran `15ed3851`, which still loaded it, until
the October 20 release `31f87be5`. 1M8-236 (Settings gating) is not the cause. The in-report Support tab needs
`firstmeasure.report_followup` (default off; 52 of 12,257 production organizations), so it never served most customers.

**Change.** `index.php` loads the help card again, without its floating button. `core.js` `renderSidebarLaunchers` always
adds a "Help & support" launcher (`fa-circle-question`, key `platform.help_and_support` with a placeholder-free fallback)
to the sidebar's bottom row, ungated by permissions, Settings or app flags, in the single, split and integrated layouts
(compact stacks it). It opens the same card beside the sidebar, or in the corner on phones after closing the drawer.
The channel is unchanged: email to support@1m8.ai. Manifest key `help/app.js` `20261026-support-entry-v1`; `index.php`
versions by file hash.

**Tests.** `public/v1/tests/support-entry-browser.test.mjs` (4 pass) runs the real launcher code, its stylesheet and the
real help card in Chrome for a customer who can only view reports (no Settings), and in the other layouts.
`app-placement-ui-contract.test.mjs` is updated for the extra launcher; its 7 other failures fail the same way on
`0978bd54`. `settings-launcher-access-browser.test.mjs` passes. `npm run check` passes.

**Rollout.** `output/support-entry-20261026/`, three-way merged onto live `67bc496a` on legacy and web without conflicts;
verified, dev serves the launcher, the card and the manifest key. The dev pool node (10.124.16.3) is still unreachable and
was not updated. Production not changed.

**Check on dev.** Sign in as a user who can only view reports (or any user), look at the bottom of the left sidebar,
click the question-mark icon ("Help & support"): the "Need a hand?" card opens with support@1m8.ai. On a phone it is
in the menu drawer.
