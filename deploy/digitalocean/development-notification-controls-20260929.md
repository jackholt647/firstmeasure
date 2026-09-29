# Notification delivery controls - development, September 29, 2026

Source commit: `b1e6f324344741609c70243b625be9fb267c7ddb` on the canonical branch.

Messaging now has its own Notifications settings section. Each notification offers
Off, Silent or Alerting in-app delivery, independent push, and an initially closed
Advanced tray for notification-bell placement and unread-badge participation.
Existing boolean delivery preferences remain compatible. The browser enforces
sound suppression, including celebrations, and consumes recipient-filtered alerts
outside the bell. Conversations remain available in the messaging inbox.

Validation: TypeScript and changed JavaScript syntax checks pass. Five focused
unit/browser-runtime checks and six notification/API regression checks pass.
The browser UI fixture exercises the real settings renderer, saving all three
modes, independent push, initially closed Advanced, bell preferences and mobile
fit. Publication checks pass 49 with one PostgreSQL skip. The wider 40-test run
passes 39; its unrelated app-flags test receives the operator-only 403 response.

Development staging inherits each verified live baseline, with six changed source
files and three compiled backend modules. The compatibility API is three-way
merged with its existing baseline. Staged Linux TypeScript builds and source hashes
are checked before activation. No databases, provider credentials, topology or
production configuration are changed. The worker's push processing is unaffected.

Initial predecessor on both web nodes and compatibility:
`7e860e0bf2aa58eebb21f48069c1d83d98643a1d`.
Evidence, manifests, browser fixture and activation receipts live in ignored
`output/notification-controls-20260929/`.

All three roles activated `b1e6f324344741609c70243b625be9fb267c7ddb` and
passed local readiness, development isolation and all nine changed-file hashes.
Both web instances were observed healthy through the public development load
balancer. All three public JavaScript assets match the release manifest. The
settings browser fixture also passes using the actual hosted company.js, including
mobile fit; this uses mocked preference responses and does not mutate tester
accounts. Production remains unchanged.

Rollback must inspect
intervening releases before restoring recorded predecessor symlinks and restarting
the applicable development service plus PHP-FPM one node at a time. The existing
historical autoscale-image limitation remains; this release does not replace nodes.
