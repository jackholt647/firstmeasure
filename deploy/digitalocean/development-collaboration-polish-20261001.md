# Collaboration UI polish — October 1, 2026

Development source release: `9775015b23df8db33b479508c8057f185d7a70de`.

## User-facing changes

- Projects and Contacts now offer checkboxes for our records and records shared with us. Selecting incoming records reveals individual organization checkboxes. The controls disappear when there are no incoming records, and stale saved filters cannot hide local records behind invisible controls. Organization selections do not affect local records.
- Contacts places Manage view last in its toolbar, matching Projects.
- Channel managers can choose Share from a channel's three-dot menu or Channel settings. The dialog offers connected organizations or a new organization invitation, view/participate access, recipient audience, and removal of existing grants. Invitation results offer copying, optional QR display and email through the existing Communications library. Anonymous browsing is not introduced: account sign-in, email binding where supplied, and owner approval for unbound links remain enforced by the collaboration service.
- Partners uses the shared `AppChrome.header` library, five primary navigation items, contextual sharing/payment subviews, compact organization rows, secondary action menus, styled forms and explanatory empty states. Mobile layouts wrap controls and retain horizontal tab navigation.

## Validation

- Five focused tests passed across collaboration browser, native view and channel sharing suites. Contacts' existing view/style/mobile smoke check passed.
- The helper tests cover multiple owners, qualified identities, pagination, organization changes, revocation and hiding controls without incoming shares.
- The dialog test verifies scoped invitation payloads, participation permissions, optional QR, one email delivery request with idempotency, connected organization grants and mobile sizing. Email was mocked as captured; no external test email was sent.
- Exact release assets were exercised in the real development portal with controlled data: filter checkboxes, Contacts toolbar order, Partners desktop/mobile, both channel Share entry points, real QR rendering, messaging and revocation. No JavaScript errors. Screenshots were visually inspected.
- Eight-file staged hashes and JavaScript/PHP checks passed on development web, compatibility and web pool. Backend fingerprint remains `ea6ec36f327444590add564ac441ddc102be913826fa349a3b585e2495d0cd5f`.

## Scope and rollback

Frontend-only, with existing collaboration and Communications APIs. No database, backend, worker, production or topology changes. Immutable role baselines and unrelated working changes are preserved, including the already-deployed Contacts search removal, which remains separately staged locally.

Previous development release on the three affected roles: `c275eb94a8105acdea59cece2711acb6dfeea861`. Use each role's recorded `previous_path` in `output/collaboration-polish-20261001/manifest.json` to restore its development symlink, restart the corresponding service and reload PHP. Verify readiness, runtime release, source hashes and outbound isolation.

Activation verified on all three development web roles: release `9775015b23df8db33b479508c8057f185d7a70de`, expected source hashes, readiness and outbound isolation passed. A post-deployment browser run passed without JavaScript errors, including the absence of sharing controls for organizations without incoming shares.

The real two-organization sandbox check passed: channel settings invitation creation, QR generation, recipient sign-in and preview, owner approval required for an unbound invitation, approved channel visibility in the recipient rail, participation composer and immediate loss of access after revocation. Test invitations and grants were revoked during cleanup. No real email was sent; email delivery UI and payload were verified with captured fixtures.
