# FirstMeasure contact links and loading header â€” October 6, 2026

Runtime release: `62884b984deecc90f91995db710dc6916459c028`.

When the organization Communications app is disabled, project contact shortcuts
open the device handler using `tel:`, `sms:` or `mailto:`. These actions do not
mount the Communications tab or call its phone API. Enabled organizations retain
the existing phone and message/email compose behavior. Empty contact fields
continue to receive focus rather than initiating an action.

The shared header-pill renderer now checks the Money feature flag before creating
the dollar-value pill. The initial parent-window loading header uses that same
renderer, so a FirstMeasure-only project no longer briefly shows $0 before its
iframe loads. Money-enabled organizations retain their configured value pill.
The project-request asset version is updated.

Validation: JavaScript syntax; disabled/enabled contact action behavior and
sanitized/encoded protocol targets; no communications calls on disabled paths;
empty-field handling; a fresh FirstMeasure browser fixture with iframe loading
delayed by 2.2 seconds and an insertion observer verifying no value-pill flash;
loaded header without a value pill; enabled Money opening-header behavior.

Deployment updates only project-request and the asset manifest on development
web, compatibility and pool. Role-specific source differences are retained using
audited immutable overlays, with baseline/hash/capacity guards and files detached
before writing to hardlink clones. Worker and production are excluded.
The prior serving release is `d84177313554eeeac9b7e3ec59301991f619d9a4`;
the role-specific previous paths and deployment receipts are recorded in
`output/firstmeasure-contact-links-20261006/manifest.json` and associated files.
Rollback restores the recorded prior role path and restarts its service and
reloads PHP-FPM; check for intervening releases first.

Activation and verification passed on all three serving roles. Exact asset hashes,
readiness and development outbound isolation passed. The fresh hosted browser
check repeated delayed-loading and enabled-Money assertions with no page errors;
its temporary signup fixture was deleted. Device protocol targets were tested
without launching a real external call/message/email client.
