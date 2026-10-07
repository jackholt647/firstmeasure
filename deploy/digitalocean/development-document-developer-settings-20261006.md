# Document and developer settings — October 6, 2026

Development deployment requested for dev.1m8.ai. Production is outside this rollout.

Source commit: `d242018a906e89236fbed2db00cb1837682975c9`.

Company Document Settings now owns PDF and portal-link delivery defaults and the
customer completion message. Existing proposal values remain read-only fallbacks
until document defaults are saved. The document Send dialog and backend honor the
defaults; each issued snapshot captures its message. The customer portal displays
it after the document's signing and initial payment requirements are satisfied.
The Proposals settings page is removed; old settings entry points open Documents.
Naming prefixes and proposal comparison-header controls are not migrated.

The developer-only feature/app configuration category is named Developer Settings,
uses a code icon, and retains its existing access checks, routes and nested controls.

## Validation

Local TypeScript and JavaScript syntax checks passed. The new API/defaults/completion
tests and two real-browser settings/send-dialog tests passed. The wider API run had
29 passing tests and one legacy-proposal test expecting a signing operation that
the existing implementation deliberately rejects with `proposal_signature_reissue_required`.
Focused settings search/navigation tests passed; the broader search contract also
has an unrelated portal asset-order assertion failure.

## Deployment evidence

All four development roles (web, worker, compatibility and pool) were activated
on the source commit and verified healthy. Each role passed all 17 deployed-file
hash checks, process release checks and development isolation checks. Linux
TypeScript checks passed on all four staged overlays.

Public dev.1m8.ai readiness passed, five public JavaScript assets matched the
release payload, and the document settings endpoint correctly required authentication.
Hosted authenticated UI flows were covered by local browser tests rather than
exercised with live customer records.

Immutable overlays were built from the source commit and merged against each
role's verified active source. Historical
worker frontend differences are preserved. No data, credentials or installed
service configuration are included in the payload.

Exact previous paths, source and compiled hashes, per-role archives and capacity
checks are recorded in `output/document-developer-settings-20261006/manifest.json`
and `capacity.json`. Final results are recorded in verified-deployment.json and public-verification.json alongside them.

## Rollback

Restore the previous current symlink recorded for each role, restart its development
service, and reload PHP-FPM on serving roles. Recheck current release identities
before rollback to avoid replacing a subsequent deployment.
