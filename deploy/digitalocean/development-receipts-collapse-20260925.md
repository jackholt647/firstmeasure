# Collapsible reimbursements, open by default — development, September 25, 2026

The development web nodes `do-598520065` and `do-603124965` run release `92cf566182c4cf019000671bc298b5ad494f6a6c`, layered over `67b9b026cdc9756fb4668a438577ba95de93dbbe`. The prior release replaced the reimbursement On/Off switch and its large hidden placeholder with a collapse arrow and a 40px reopen rail; collapsing returns the remaining width to Receipts. The current release removes saved collapse state, so the panel starts expanded every time the Receipts tab opens. Mobile retains its two sub-tabs.

Only `public/libraries/apps/receipts/app.js` changed in each release. Both nodes passed baseline and source hash guards, JavaScript syntax checks, local exact-release readiness, development data checks, and outbound isolation checks. Public readiness and the served script hash matched the current release. Production was not changed.

Rollback: point `/opt/firstmeasure/current` on each development web node back to `/opt/firstmeasure/releases/67b9b026cdc9756fb4668a438577ba95de93dbbe`, restart `firstmeasure-development-web.service` and `php8.3-fpm.service`, then run `deploy/digitalocean/verify-node.sh http://127.0.0.1:3201` and check development isolation. The development autoscale image remains historical and needs the current release before a replacement node can preserve this behavior.
