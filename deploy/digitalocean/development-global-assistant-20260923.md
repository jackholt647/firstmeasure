# Global assistant development release — September 23, 2026

Development release: `05df16b68c2a8a0a4d680a360cb37fd8316c7578`.
Production was not changed.

The global assistant now composes platform, organization and user instructions;
supports user-controlled saved memories and older conversation search; uses the
shared published data/action catalog; defaults to GPT-6 Luna; and fails bounded
tool loops instead of reporting success. The Company Settings AI Agents page
shows all three instruction levels and memory controls. The platform-wide text
can only be edited by a verified full internal admin.

## Source and build

The release was committed and pushed before packaging. Development's fixed
web, worker and compatibility roles started from `33969f09f82127ea94e4bca6f9b5c8d63bb97819`;
the second serving web node started from
`a66efdc91fcfe8bb5ae8bec6ce9d3a700f0a4fa2`. Separate checked source
deltas reconciled both ancestors to one commit. Changed source files were
compared to each host's live baseline before staging. Each staged release kept
unchanged runtime files and preserved existing role configuration.

The exact Git source built on the development worker. Linux `npm ci`,
`npm run check`, `npm run build`, `npm run test:assistant` and
`npm run test:publication` passed before dependencies were pruned. The common
compiled runtime archive contained 22,287 files, 56,545,548 bytes, SHA-256
`db5a666e802f3d183a25ddb3a60d63f5f04ef12ad2069dece02d347b09e4b4f8`.
Its checksum and file count were checked during installation on both web nodes
and compatibility. Local verification also passed the assistant frontend syntax
checks, ten assistant tests, and 47 publication tests with one PostgreSQL-only
skip. A disposable local assistant turn reached the real OpenAI API on
`gpt-6-luna` and completed with `report_result`; no credential was packaged.

## Activation and verification

Compatibility, worker and the two web nodes were activated sequentially with
development data and outbound safety checks. The worker had no running
measurement jobs at activation. The second web node rejoined the public load
balancer before the first web node was switched. Role-local verification passed
on all four hosts. Twenty-four public readiness calls split evenly between
`do-598520065` and `do-603124965`; both reported the exact release,
development data and enforced outbound isolation. The public assistant client
and Company Settings scripts returned HTTP 200 and matched the commit byte for
byte. `/v1/assistant/` advertised the new profile and memory routes.

The deployment used no production credentials or data and did not send a
customer message, order a report or create a charge. An authenticated assistant
turn was tested locally against the real model; the public development check
was route and asset verification only.

## Recovery and remaining limit

The previous immutable releases remain on each role. If rollback is needed,
coordinate both web nodes, worker and compatibility to one compatible release;
the new assistant SQL tables are additive and should be retained. Preserve any
new saved memory/profile data rather than restoring an older database.

The development autoscale pool still uses historical image `244484489` and
bootstrap code. A replacement node can reintroduce old code. Update its
development-only image or signed release bootstrap and rehearse a new node
before treating this deployment as durable across scaling. This image and
pool configuration were not changed by this release.
