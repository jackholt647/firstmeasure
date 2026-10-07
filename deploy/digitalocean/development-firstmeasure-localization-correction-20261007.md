# FirstMeasure localization correction — development, October 7, 2026

Runtime release: `401a6e30171432ca7fa31cbf5875eef380f29caa`.

The prior audit missed source-owned text in processing/report states, property
pricing, ordering explanations, Users dialogs, and compact Billing views. This
release makes those paths language-driven and fixes the Billing input layout.
Dates, counts, report-summary numbers and monetary displays use the company
locale. Currency, prices, canonical numeric calculations, pitch ratios, addresses,
names and authored notes retain their values. Japanese normally uses the same
Western digits as English; localized dates and units do not require kanji digits.

The corrective inventory covers FirstMeasure navigation, Company and Brand Kit,
report preview/settings, Users and its invite/edit/action dialogs, Billing and
credit summaries/warnings/history, project list/tiles, project Overview, report
ordering and gutter/roof/exterior explanations, and report summary/processing/
delivery/cancellation/rejection states. Dynamic durations, counts and due-time
messages use complete ICU messages. Modal `bodyHtml` is now included by the
catalog extractor; it had omitted Users dialog content. Disabled boards no longer
leak a stage badge. Departments follows `platform.expanded_access`, matching its
API requirement instead of offering an unavailable tab to FirstMeasure accounts.
The seven FirstMeasure permission keys remain unchanged.

All sixteen existing GPT-6 Luna language assignments completed the corrective
packets. Import validation accepted 8,605 response entries with no missing active
FirstMeasure packet entries. Disabled-app and retired keys are recorded separately
in `output/firstmeasure-localization-complete-20261006/integration-results.json`.
Source hashes, packet identity and ICU argument/type checks passed. These checks
prove structural completeness of this inventory, not professional linguistic
review of every phrase or translation of the disabled FirstMate modules.

Validation passed: 15 platform/localization/translation/PDF-worker/display tests,
22 report/exterior tests, TypeScript checking, and 14 browser PDF export fixtures
with default/explicit-US equivalence and metric checks. Regression checks retain
numeric calculation values and ensure localization cannot replace keyboard
commands, HTTP header names or metric identifiers.

Browser verification captured 24 states in German against the exact isolated
release payload and the same 24 states in Japanese against hosted development
assets after activation, including a 390px Billing view. Screenshots were inspected
for Users/Billing layout, Company and Brand Kit, report states, and gutter/order
copy. Both runs completed with no page errors or critical-English-copy assertion
failures. Actual order navigation was exercised; additional report states used the
real Measurements component with representative fixture data. Billing card and
ledger examples used GET-only fixtures. No payment, report submission, invitation
or external message was sent. Temporary test organizations were deleted. Evidence
is in `output/firstmeasure-localization-complete-20261006/evidence/de-DE/` and the
parent directory's `hosted-*` captures and `hosted-ui-audit.json`. Non-Latin PDF
glyph coverage remains the separate export-review limitation documented by the
previous release; this UI audit does not establish it.

Web, pool, compatibility and worker activated this release. All deployed file
hashes, local/public readiness, development data environment, session namespace
and outbound isolation passed. Release overlays preserve role-specific code and
unrelated workspace edits; source and compiled catalogs reached the worker.
A small existing undefined proposal-settings helper prevented the shared project
module loading and was repaired without restoring a shared project content rail.
Production, provider configuration, topology and schemas were not changed.

All four prior active release IDs were
`8661111e894e662f8bf356d921b1370d6bbcb9b6`; compatibility uses the root-archive
release directory. Exact prior/target paths, hashes, detached hardlink clone
capacity checks and verification receipts are in
`output/firstmeasure-localization-complete-20261006/deployment/manifest.json` and
`verified-deployment.json`. Rollback restores each recorded previous symlink and
restarts its development service, reloading PHP-FPM for serving roles. Recheck
intervening deployments before rollback. Historical content-hashed catalogs are
retained for issued snapshots.
