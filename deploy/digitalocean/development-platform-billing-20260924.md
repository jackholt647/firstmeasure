# Development platform billing — September 24, 2026

## Scope and source

Billing source: `295f63e9c0a80368a2a94fdc784b52e26ff85b89`.
Portal entry-point follow-up: `adfb2cf324020cd48959d62573beb7be351c9fdc`.
The main implementation is in `252d73ebb6acaa56c4c09a6a5fa31e208d35cd74`;
the follow-up fixes duplicate live-chat metering and records verification.
See [architecture and operating behavior](../../docs/architecture/platform-billing.md).

Company Settings now has a separate **Platform Billing** section for expanded
platform organizations. An operator can publish versioned prices for eligible
capabilities, including monthly subscriptions and registered usage rates.
Customers explicitly accept price versions. SMS, agents, live chat and retained
media storage have trusted usage collectors. Estimates, immutable monthly
invoices, adjustments and hosted invoice checkout share a separate billing
ledger. FirstMeasure credits, auto top-up, existing Billing and the seven
production permissions retain their existing contracts.

The initial scope is monthly USD billing with explicit invoice payment through
Stripe Checkout. Subscription acceptance does not enable automatic card
collection. Tax calculation, annual periods and tiered prices are future
extensions. Storage covers platform media originals and renditions, not all
database, report-artifact or backup storage. See the architecture document for
late usage, cancellation, monitoring and invoice timing.

## Deployment

The exact committed source was built with Node 22 on the development Linux
worker. The payload contains 20 task-owned source/document/test files and 13
compiled JavaScript files; no dependency changes were needed.

- Compiled archive SHA-256:
  `14d3aceadce6f37ee18f2c512454a6c8aa815ddfdf61c20747678b82e6c3754a`.
- Selected payload SHA-256:
  `c2966000b7636e69aac02ece4d2e02b776a7d7544fef349d1e20d93e12a10fdb`.
- Both web nodes were staged from their complete mobile/signup release
  `252d73ebb6acaa56c4c09a6a5fa31e208d35cd74`.
- Worker and compatibility were staged from
  `4d9aa8674197b36be18b4b186c3861d38199506b`.

All affected pre-existing source and compiled files were audited before staging.
The shared application bootstrap also carries forward the previously committed
multipart proxy-body fix, which was already on the second web node. All other
deployed files, private APK links, PHP settings, environment files and service
drop-ins were preserved. Each role was activated separately with an atomic
symlink switch, service restart, readiness and outbound-isolation checks. The
worker had no running measurement jobs at activation.

A concurrent registry update and banner update subsequently advanced both web
nodes to `c9bb07c2204098c7e2afbe0c023971034f52aca8` and then
`b545ad88cef850b235e9dca15de2fedb1848374b`. Verification checked all 33
billing payload hashes within those releases.

The authenticated portal browser check caught an additional entry point: the
main portal loads Company Settings directly, bypassing the app manifest's
bundle list. The follow-up adds the billing script immediately before the
existing Company Settings script in `public/portal/index.php`. PHP lint and
the live portal check cover this path. The one-line follow-up is overlaid on
each role's actual deployed baseline, preserving the concurrent registry and
banner work, then activated as `adfb2cf324020cd48959d62573beb7be351c9fdc`.

The live development operator allowlist was empty. A dedicated
`platform-billing-operator.conf` systemd drop-in now sets
`PLATFORM_TEST_ORG_IDS=3dbf7f79528139e27c491363` on the four development
services. This follows the existing authorization contract: the
`notifications@1m8.ai` identity must also hold an owner/admin role in Test Company.
Its identity, membership and organization were verified before provisioning.
The setting also enables the existing app-flag operator controls for that same
account. Tenant administrators cannot edit the catalog or enroll themselves as
operators.

Test Company had expanded platform access disabled. Its rollout was switched to
the selected-user mode containing only this existing operator, then
`platform.expanded_access` and `platform.platform_billing` were enabled. Effective
capability checks confirm the operator can use billing and a non-selected user
cannot. The other users retain their FirstMeasure interface.

No prices, subscriptions, enforcement settings, customer charges or production
configuration were activated. The new SQL tables are additive and use the
existing shared PostgreSQL application store.

## Verification

- TypeScript check and production build passed locally and on Linux.
- Six billing behavior tests passed with SQLite and embedded PostgreSQL.
- Four billing API/browser tests passed locally: tenant and permission checks,
  CSRF, catalog publication, explicit subscription acceptance, source usage
  deduplication, payment retry identity, settlement validation and phone layout.
- Linux repeated the domain/API/provider checks; its browser test was skipped
  because the local real-Chromium gate had already passed.
- Four existing Stripe tests and eleven assistant API tests passed.
- Publication suite: 47 passed, one PostgreSQL-dependent skip.
- Existing billing-resume and settings-autosave browser contracts passed.

Payment-provider tests use simulated Stripe responses. No real customer payment
was attempted.

All four roles passed readiness and verification of the 33 original payload
files after the portal follow-up. Both web nodes serve the same portal entry
point hash `5f973808bdfd56475d705f12328c2c60bea780feb14615e9482dee8e272db8dd`;
worker/compatibility preserve their earlier portal baseline with the same one-line
fix. Twenty-four public readiness requests reached both serving instances
(`do-598520065`: 11; `do-603124965`: 13), reporting `adfb2cf`, development
data and enforced outbound isolation. All four public billing-related scripts
matched the verified source hashes.

An authenticated Chromium session against the actual public portal confirmed
the new section, operator pricing catalog and available capability options,
empty catalog/subscriptions/invoices, disabled commercial enforcement and CSRF
rejection. Desktop and phone screenshots were inspected; the billing component
has no horizontal overflow and the page reported no JavaScript errors. The
test session was revoked, including an earlier session interrupted by a
concurrent release. No operator test created a price or customer agreement.

## Recovery and infrastructure limit

Prior immutable releases remain available. Coordinate rollback across roles and
retain the additive billing tables and any accepted subscriptions or issued
invoices. Disabling commercial enforcement is an explicit operator action;
rollback must not delete billing evidence.

The pre-existing development autoscale image/bootstrap is still historical and
can reintroduce old code on a replacement or scale-out node. This release updates
the current serving fleet, not the image or pool topology. A development image
or signed-bootstrap update with a new-node rehearsal remains necessary for
durability across autoscaling; see the global assistant and mobile-download
release records for the same existing infrastructure limitation.

## Follow-up: one Billing tab

`a6b1857ef005dca529adc13cd194d880050abfcd` combines both surfaces under
Settings → Billing. FirstMeasure's existing controls remain in their original
renderer. Expanded users with an enabled platform feature see a Subscriptions &
usage section below them. Disabling all platform features restores the original
FirstMeasure-only view, with no platform ledger requests from the hidden section.
The platform billing switch by itself does not count as an enabled feature.
Search uses Billing, and old `sub=platform_billing` links open that same pane.

This is a frontend-only delta: four scripts, architecture documentation and a
behavior test file. There are no API, payment, database or rollout-setting changes.
The worker retains `adfb2cf`; it does not serve this interface. The web and
compatibility roles receive the immutable frontend release. Company Settings
receives only five scoped patches on each live baseline, preserving concurrent
Forward work on web release `1d995eb7bff07ac6bda83d1ce94f2e9d1debd980` and
the earlier compatibility baseline.

Eight targeted behavior/regression tests passed. The authenticated browser
check exercised the combined page, old links, the pricing editor, phone layout,
and FirstMeasure-only fallback. The disabled-feature cases use client-only flag
snapshots to exercise the real renderer without changing saved customer settings.

Post-deployment checks passed against the public portal without local script
overrides. Both web nodes and compatibility passed readiness and all six file
hash checks. Twenty-four public readiness requests reached both web nodes (13
original, 11 pool), all on `a6b1857` with enforced development isolation. The
four public UI assets matched the deployed hashes. Both desktop and mobile
views were inspected; the browser reported no JavaScript errors. Production
and saved billing/account configuration were not changed.
