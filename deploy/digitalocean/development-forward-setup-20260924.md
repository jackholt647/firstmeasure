# Forward hosted setup on development (2026-09-24)

The development web nodes `do-598520065` and `do-603124965` serve release
`a827676fbbf9c865d606f68767711e0412a2141c` from branch
`codex/forward-setup-dev-20260924-v3`. The previous release was
`adfb2cf324020cd48959d62573beb7be351c9fdc`.

The release sends `partner_data.redirect_url` on Forward sandbox applications
to `https://dev.1m8.ai/portal/payments-setup-complete.html`. The default
setup opens Forward's hosted application in a plain iframe. The former overlay
is retained behind **Test prior overlay workflow** in Forward test mode.

Each development web node has a root-owned, mode 600
`/etc/firstmeasure/development-forward.env`, loaded by the systemd drop-in
`/etc/systemd/system/firstmeasure-development-web.service.d/90-forward-sandbox.conf`.
It contains the sandbox API base and public/private Forward keys recovered
from the local FirstMate 2.0 development configuration. Values are not stored
in this repository. No production service or credential was changed.

The existing signup-sandbox test organization `org_adcbb832e4ac7189`
(`Willow Marlin Test Co 19977d`) had its merchant provider changed from
`mock` to `forward`, with a payment event recording the change. No other
organization's provider was changed. Its Forward sandbox application was
created by opening **Finish setup** in the portal; it remains in `DRAFT`.
Forward's GET application response confirmed the redirect URL above.

Verification: both nodes returned `ready` with the exact release ID,
development data environment, and passing outbound safety checks. Public
readiness requests reached both nodes. The public settings script and splash
page loaded. In the test organization, **Finish setup** displayed Forward's
Business Info form inside the iframe, with no FirstMate overlay around the
form. The application was not submitted.

To roll back this development release, switch each node's
`/opt/firstmeasure/current` symlink to the previous release and restart
`firstmeasure-development-web.service` and `php8.3-fpm.service`; then run
`deploy/digitalocean/verify-node.sh` against `http://127.0.0.1:3201`.
Rollback of code does not delete the sandbox application or revert the test
organization's provider. Those are separate development data changes.
