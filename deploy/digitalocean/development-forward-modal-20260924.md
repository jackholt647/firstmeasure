# Forward setup modal follow-up (development, 2026-09-24)

## Completion copy update

Both development web nodes now run `d7437b8caa5993ee5406aeb949f36a82a1495fb3`.
This release copied the then-current live release
`63db2b3989acf39b5bcd3c720aabe33703edd565` and replaced only
`public/portal/payments-setup-complete.html`. The page now says **Payment
application submitted** and **Your application is under review. We will notify
you once it has been processed.** The **Close window** action remains.
Both nodes passed `verify-node.sh` and the public page returned HTTP 200 with
the exact copy, with no Forward or bank-account wording. Production was not
changed. To roll back this copy, switch both nodes to the `63db2b` release
above and restart the development web service and PHP-FPM.

## Initial modal change

Both serving development web nodes (`do-598520065`, `do-603124965`) ran
`7769ec15fd6f60ddf14336041b9a85046d4e4263`, based on the previously
serving `f48e7b2ae384aa162caab106f7dc978913a368b0`. This is a targeted
web/API delta; the staged runtime carried forward the exact live portal files,
including concurrent sidebar, banner-dismissal, and platform-billing edits.
Production was not changed.

For Forward sandbox organizations, payment attention actions now open the
hosted application in a global modal without switching to Money settings.
This covers the top banner, sidebar banner, and pinned notification. Other
payment modes retain their existing settings route. The modal is 1180px wide,
matching the shared setup wizard, and can be closed and reopened from the
banner. The own-origin return page has one **Close window** button, which
closes the iframe modal through `postMessage`; as a standalone page it attempts
to close its browser window.

Verification: `npm run check` and `npm run build` passed in the isolated
worktree, all edited JavaScript passed `node --check`, and the staged PHP
passed `php -l`. Both nodes passed `verify-node.sh` with exact release ID,
development isolation, and Forward sandbox configuration. Eight public
readiness requests reached both nodes. In Chrome, the existing signup-sandbox
test organization's **Continue application** top banner and pinned notification
each opened Forward's iframe over **My Projects**, leaving the URL and tab
unchanged. Closing and reopening worked. The rendered modal measured 1180px
wide. The public return page served the new single-button copy.

Forward's documented `partner_data.redirect_url` applies after submission.
The observed sandbox flow bypasses Forward's following bank-account prompt.
The boarding guide recommends adding a bank account during the hosted
application, and the account guide allows funding details later. The public
API docs do not describe a separate post-bank redirect. Do not present the
bank account as linked merely because the application was submitted.

Rollback: switch each node's `/opt/firstmeasure/current` to release
`f48e7b2ae384aa162caab106f7dc978913a368b0`, restart
`firstmeasure-development-web.service` and `php8.3-fpm.service`, and run
`deploy/digitalocean/verify-node.sh` against `http://127.0.0.1:3201`.
