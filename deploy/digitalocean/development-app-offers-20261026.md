# Development: app advertisements and organization activation

Release `65b356253a4ed8f9f0d0d7cd2ee562c85463eb29` is on development web,
legacy and worker. Previous release: `b49136e1668354c413cbbc7fb8c4e6cf127702d8`.
Production was not changed. Preparation and per-role source hashes are in the
session checkout's `output/app-offers-20261027/manifest.json`.

Photos, Documents, Customer Portal and Materials have designed HTML/CSS welcome
advertisements: headlines, benefit copy, product illustrations, free messaging
and Get Started. There are no generated image dependencies. New organizations
keep these apps pending until someone who can see one starts it for the whole
organization. Configured-off and commercially unavailable apps stay unavailable.
Operational capabilities and their dependents remain off while offered.
Opening a welcome neither consumes New nor starts a tutorial. Activation uses
the existing app and guided-experience runtimes afterwards.

Implementation and API details: [app experience](../../docs/architecture/app-experience.md#offered-apps).
The project host's small integration is currently served through the live layer
from `C:/Users/jackh/Code/2026/fm-live-visual-test`; its prior ordering, contact and
other concurrent visual edits remain intact. The other browser and server files
are in this immutable release. Per-host three-way reconciliation retained the
live country capability rules and country-aware signup. Remote Linux type checks,
source/compiled hashes, readiness and outbound-isolation checks passed before
activation. Worker activation checked that no jobs were running.

Validation:

- App experience, offers, registry and responsive welcome tests pass, including
  concurrent organization activation, hidden-app denial, unrelated offers kept,
  generic-global-write protection and no operational mount on viewing an offer.
- All 56 required guided-experience and request-security checks pass.
- TypeScript checks pass locally and on all three staged roles.
- The two new access-gate snapshot entries are recorded. The baseline still has
  93 unrelated differences (68 check-order differences and 25 older route/action
  changes); these were not silently accepted into the snapshot.
- In the live sandbox `org_f42f56802f97e21a`, all four welcomes were made available
  for the user's test. Live session entitlements carried the welcome definitions,
  the runtime showed the designed banner and New badges, and the console had no
  application errors. Subsequent reads showed Documents and Materials activated
  while Photos and Portal remained offered, with their effective flags off.

Rollback is the previous immutable release on each role, plus reverting the
welcome-specific host integration in its live owner checkout. Do not clear the
whole live layer: it also contains other user-requested visual work. Offer state
is additive organization metadata; rolling back code does not remove app data.
