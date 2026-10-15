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
