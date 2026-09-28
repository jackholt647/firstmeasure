# Forward Continue Application draft-link guard (development, 2026-09-25)

The serving development web nodes (`do-598520065` and `do-603124965`)
now run `ee187841b5ec6c18da65ab966ce81df17a91ec72`, layered over
`54fcd99f4204250534cd12e241fad8c91f3b1c4b`. Only the payment
API/provider/attention modules and the payment setup and Money settings
scripts were overlaid; concurrent development changes in the base release
were preserved. Production was not changed.

The Continue Application action previously called Forward's
`POST /applications/{id}/link` even after a hosted application had left
`DRAFT`. Forward rejects that request. The attention feed now reads the live
application state before offering the draft-only action. The hosted-signup
route returns the current status without minting a link for a submitted
application, clears its stale stored link, and the client refreshes the
banner without opening Money settings. The direct link route also blocks
non-draft applications before calling Forward. Unknown Forward statuses no
longer default to `DRAFT`.

Validation: `npm run check`, `npm run build`, JavaScript syntax checks and
the 20 focused onboarding tests passed. The new regression covers a stale
tracked `DRAFT` status after provider submission and verifies no link is
offered. Both nodes passed `verify-node.sh`; eight public readiness requests
reached both nodes with the exact release ID, and the public modal script
contains the submitted-application guard.

Rollback: point each node's `/opt/firstmeasure/current` back to release
`54fcd99f4204250534cd12e241fad8c91f3b1c4b`, restart
`firstmeasure-development-web.service` and `php8.3-fpm.service`, and run
`deploy/digitalocean/verify-node.sh` against `http://127.0.0.1:3201`.
