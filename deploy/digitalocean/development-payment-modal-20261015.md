# Direct payment application modal — October 15, 2026

The development banner's Continue application / Finish setup action uses the
existing hosted application iframe modal. Explicit assistant requests retain
the streamed browser widget. Existing sandbox applications bypass the fresh-org
redirect comparison chooser and resume through the hosted-signup endpoint.

Runtime source: `1c4cd22719fecdb7d1670ead18cbf228a421a7e9`, pushed to
`codex/payment-modal-20261015`. Only
`public/libraries/payments-setup/payments-setup.js` is overlaid onto each audited
live development baseline. The deployed file previously contained the agent-only
launcher; the canonical source already contained the iframe implementation.
No backend, database, provider configuration or production changes are included.

Release manifests, baseline hashes, staged archives and rollout scripts are in
`output/payment-modal-20261015`. Each host uses an immutable clone with owned
files detached before replacement. Activation stops on baseline drift and checks
development isolation, outbound safety and runtime readiness, with automatic
rollback on failure. Previous release: `273a7ab6039869a3eb4fdaef2a3566070534b137`.

JavaScript syntax validation passed locally and on every staged host.

Rollout verified on web, pool and compatibility hosts; readiness reports the
expected release, development environment and enforced outbound restrictions.
Live browser verification: clicking Continue application opened the Payment setup
dialog with Forward's new Merchant Application as a nested AXWebArea, including
editable First name, Last name, Email address and Mobile phone fields. The
existing application resumed without creating a streamed browser widget.
Screenshot: `output/payment-modal-20261015/hosted-modal.png`. The application was
left open for manual testing; no form fields, signatures or bank details submitted.

## October 15 viewport sizing and Forward redirect investigation

Runtime follow-up `d9af43d08584ae6aabbb667b98bb8ff7fbf056a6` is verified on all
three development web-serving roles. The modal now uses 96% of viewport width
and height, without the former 1180px/900px caps. Browser measurement: 1957.47 x
1198.09 within 2039 x 1248, with the new Forward contact form rendered in the
iframe. Evidence: `output/payment-modal-size-20261015/expanded-modal.png`.

Read-only Forward sandbox check for Anchor Marlin Test Co d2505f,
application `aapp_3KjzjlXxBUyrpEsdXARCw6wK9Ld`: status APPROVED, zero linked bank
accounts, partner_data.redirect_url persisted as
`https://dev.1m8.ai/portal/payments-setup-complete.html`. The user's screenshot
shows Forward's own live-account completion screen instead of that destination.
This is evidence of saved configuration plus a missing redirect for this run,
not proof of every branch's redirect behavior or production underwriting speed.
Our cached merchant status still read DRAFT at inspection time.

The current downloaded Boarding OpenAPI schema lists only
partner_data.redirect_url (description: Redirect URL, maxLength 400). No separate
post-bank redirect, return URL or completion-callback parameter was found.
Public hosted-script downloads returned HTTP 403, preventing a code-level
confirmation of undocumented alternatives. No guessed provider parameters or
approval-triggered redirects were introduced; approval can precede bank linking.
