# Development payment browser and canonical source alignment

The global assistant's **Set up payments** suggestion invokes `open_payment_setup`.
The resulting widget stays in the left dashboard while the conversation remains
on the right. Forward's sandbox application runs in an isolated Chromium context
on the development worker. The old iframe overlays are removed.

## Source reconciliation

The user authorized reconciliation and development deployment of all local work,
including Documents signing, the FirstMate mobile host, and the measurement editor.
The original canonical checkout was archived at
`C:/Users/jackh/Code/2026/FirstMeasure-recovery-20260928-payments` before editing.
Its source ZIP, staged/unstaged patches and status remain available for recovery.

The canonical source incorporates remote canonical `472bc729ff40167040752e7c9bece011156aa885`
and the deployed assistant lineage through `215ef74`, with three-way reconciliation
against the local changes. Per-role live source was downloaded and compared before
deployment. Local document signing and editor changes are retained; existing mobile
download service overrides and private runtime configuration must be preserved.

## Browser service

`firstmeasure-development-payment-browser.service` runs under a dedicated user on
the worker. It binds to the worker's private VPC address on port 3218. Platform API
processes use `PAYMENTS_BROWSER_URL` and a shared private `PAYMENTS_BROWSER_TOKEN`.
The browser gets no platform/provider credentials in its environment. There is no
public DevTools endpoint. The platform rechecks organization membership, the same
`manage_projects` permission as hosted signup, and CSRF on every mutation.
Development enables the global assistant, Money and merchant-onboarding capabilities
for fresh organizations without expanded platform access. The assistant route is
also exempt from the development-only expanded-access boundary. Explicit Money
opt-out still revokes browser access. Other expanded apps and payment-taking
features remain gated; production defaults and route boundaries are unchanged.

The worker reserves one session per organization before minting a provider link,
so repeated requests across web nodes cannot invalidate the active application.
Frames are transient JPEGs from CDP, returned only to the authenticated owner.
Typing, mouse input, scrolling, file upload, dialogs, back/reload and reconnect
use a bounded input protocol. URLs, screenshots and form values are not given to
the agent or stored in its conversation. Only a sandbox Forward URL can start a
session; the browser egress proxy blocks private/VPC/metadata addresses and pins
DNS resolution to the checked public address.

Sessions expire after 30 idle minutes or two hours total, and are removed on close.
There are six browser slots. Uploads are limited to 10 MB. The completion return
screen indicates submission, not underwriting approval. Camera/microphone relay
and provider font/theme customization are not implemented in this initial stream.

## Development storage

With explicit user authorization, a 100 GB DigitalOcean volume named
`firstmeasure-dev-releases` was purchased for **$10/month** and attached to
development compatibility droplet `596237571` in SFO3. It is ext4 and automatically
mounted at `/mnt/firstmeasure_dev_releases`; its fstab entry was verified.
Six inactive historical releases (`cluster-v1.0.0` through `cluster-v1.0.4`, and
`cluster-v1.1.0`) were copied with metadata and checksum verified, then replaced
by same-path symlinks. This recovered about 3 GB on the full root disk without
losing rollback versions. `/opt/firstmeasure/releases` now points to the volume.
All 194 existing release entries retained their verified file identities; older
root-disk releases remain reachable through links to `releases-root-archive`.
Compatibility and PHP-FPM require the volume mount before starting.

## Verification before activation

- TypeScript check passed after integration.
- Publication: 49 passed, one optional PostgreSQL test skipped.
- Assistant plus browser API and fresh-org authorization: 21 passed.
- Browser interaction/global suggestion/layout: four passed in Chromium.
- Worker Chromium launch, Forward sandbox origin and live JPEG delivery passed.
- A dedicated development QA organization exercised the real agent function call,
  provider application creation and browser session. Its real hosted application
  rendered in the live portal's left dashboard beside chat, with no page errors.
  Final financial submission is left to the user's new-organization test.
- Broad Windows baseline: 934 passed, 48 failed, 20 skipped; JavaScript: 466
  passed, 78 failed, one skipped. This is not a green full-suite claim.
  All 78 JavaScript failures also occur in the archived pre-change source (83
  failures there). Functional comparisons reproduced the older proposal-signing,
  document-collaboration permission and phone/rollout fixture failures. Many other
  Windows failures are SQLite cleanup locks. Regional tests were updated for the
  reconciled French, Japanese and Spanish catalogs, rather than English fallback.

The immutable release's `canonical-release.json` records its canonical Git commit,
archive digest and source-file count. Every development role is verified against
that manifest on activation, including readiness and enforced development outbound
isolation. Local verification evidence is under `output/payment-browser`.

To test, create a new organization on `https://dev.1m8.ai`, open the global assistant
and select **Set up payments**. Enter business and owner information in the streamed
application. It supports the provider's Business Info, Sales Info, Owners and
Review & Submit stages. No production service, data or release is activated.

Rollback restores the prior role-specific `current` link and restarts its development
service (and PHP-FPM on web/compatibility). The browser service can be stopped
separately. Existing private APK paths, environment files and role overrides are
preserved. Development autoscale replacement-image provisioning remains the
pre-existing limitation; the running serving nodes are the verified targets.
