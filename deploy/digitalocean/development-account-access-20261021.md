# Add another account, ordering permission and password visibility — development, October 21, 2026

Source `78a839d1` on the session branch `claude/nifty-wright-f19096` (after `61402f23`, the account fixes). Not on the
canonical branch yet; the coordinating session merges it. Production was not changed.

**1M8-223: unable to add another account.** The add-account modal reuses the signup widget, whose login field is named
`identifier` (email or phone). The account switcher sent `formData.get('email')` (empty) and `/auth/accounts/add` read only
`email`, so every attempt failed with `missing_login_identifier`, shown as "Unable to log in. Please try again." Production
nginx logs: all 28 `POST /auth/accounts/add` since the release returned 400 with that 114-byte body. The switcher now sends
`identifier`, the route accepts `identifier` like `/auth/login`, and the widget shows the server's reason (for example "The
password you entered is incorrect.").

**1M8-227: permission levels.** The desktop New button was already hidden without `order_reports`
(`project-request/app.js updateButtonVisibility`), but the mobile "+" and the New menu's report item were not; pressing them
opened an order window that never loaded ("Opening project" spinning). The New menu (portal/index.php) now leaves out the
report item and hides both buttons when the loaded permissions lack `order_reports` (nothing is hidden before permissions
arrive), and re-evaluates on `fm:perms:updated`. The report workflow refuses with "You cannot order reports" instead of
opening. Ordering itself was already refused by the server (`queue` requires `order_reports`).

**1M8-221: see the password.** Every password field has a show/hide button: login, signup, password reset, invitation
activation and the add-account modal. One helper, `portal/landing/shared/password-toggle.js`, is loaded by `login.php` and
`activate.php` and by the signup widget (beside its own script, applied inside its shadow root). Submitting a form hides the
password again. Landing pages that load the widget with a fixed `?v=` pick it up when their cache expires.

**Tests.** `account-access-browser.test.mjs` (the toggle on a page and in a shadow root, the add-account payload, the New
menu for a viewer and an orderer in Chrome) and a new case in `account-org-invites.test.ts` (adding an account by
identifier; a wrong password reports `invalid_credentials`). `npm run check` and PHP lint pass; the related existing suites
fail only where they also fail on the base.

**Rollout.** `output/account-access-20261021/` (commit-base `2c3b9af7`). The Europe signup release on dev had added lines at
the same spots in `login.php` and `signup-widget.js`; those adjacent insertions were merged keeping both (replay.py
`resolve_conflict`, which refuses any conflict that changes base lines). As with the previous release, the worker activated
and then another session activated legacy first, so legacy refused; legacy, web and pool were re-audited on `c570b2c7`,
rebuilt, activated and verified on `78a839d1`. The worker runs `78a839d1`.

**Checked on dev.1m8.ai** (pilot accounts): login.php shows the toggles and switches the field to text; signed in through
the form; the add-account modal shows the toggle, reports a wrong password as such, and with the right password adds the
drafter pilot and switches to it (both accounts remembered); a viewer has no New button on desktop or mobile and the report
workflow does not open, while the owner has both; activate.php shows both toggles. No page errors.
