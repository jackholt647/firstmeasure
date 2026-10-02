# Sandbox measurement defaults and developer controls — October 2, 2026

Backend source release `23a2ddd79a0ecc532696b143140cf970dd662b0d` is verified
on all four current development roles. Web, worker and compatibility run that
release. The pool node subsequently activated the concurrent UI release
`a8467b0f07a6940b624da6a9e360e4c5b788bce9`, retaining all four measurement
source/compiled hashes unchanged. Its readiness and isolation were reverified.
Production is unchanged.

## Behavior

The Instant full org (dev) preset disables `firstmeasure.weather_reports` and
`firstmeasure.instant_reports` by default. Other capabilities remain as before.
Existing seeded workflow defaults are repaired; creating a full test instance
also applies these two defaults. Other workflow presets are unaffected.

The development report service now recognizes the existing sandbox operator
gate (`canManageSandboxOrgFlags`) alongside developer allowlists/test operators.
It still requires the development application and data environments. Sandbox
access requires an owner/admin session whose sandbox instance matches the test
organization metadata. Ordinary org admins, mismatched sessions and non-dev
environments remain denied. API `order_reports` permission checks are unchanged.

No new organization is necessary. Refresh an existing sandbox session (or reopen
that existing organization through the sandbox). The FM button appears beside the
address. The separate Instant development report toggle appears after FM selects
a saved address matching the current type/scope; it stays opt-in. Disabling the
regular instant-report capability does not disable this development-copy helper.

## Existing test organizations

At the user's explicit request, all 29 existing Instant full org (dev) test orgs
had only the two report capability values set to false. Membership and matching
sandbox instance metadata were checked before each update. Domain `mutateGlobal`
preserved other global fields and flags under its normal locking behavior.
Original values and workflow defaults were saved to a private timestamped JSON
backup under the compatibility role's configured platform storage directory at
`development-migrations/measurement-defaults-*.json` before the update.
Post-update audit: 29 eligible, 29 with both options disabled, 29 sandbox operator
contexts admitted by the developer-report gate, zero skipped or still needing changes.
No customer order or report generation was triggered.

## Validation and rollout

The development service authorization/copy test and an isolated full signup test
pass. The latter creates a real test identity/session and checks its access,
new org flags, stored workflow upgrades, and preservation of unrelated settings.
Local TypeScript checks pass. Linux TypeScript, compiled-source parity, runtime
release identity, file hashes, readiness and enforced development isolation passed
on all four roles. Public activation readiness passed.

Only this task's backend changes were committed/deployed. Other local staged and
unstaged edits were preserved. Concurrent UI deployments changed the web baseline
twice; baseline assertions stopped activation, and the package was rebuilt against
the then-current live files before proceeding. Final prior releases were
`a8467b0f07a6940b624da6a9e360e4c5b788bce9` on web,
`590ff6709cf947cf76cd55f5fc77c74775cc624b` on compatibility/pool, and
`0f0774d4241a51dd22b2b7ff36cfa69ce5cf09b3` on worker.
The historical development autoscale image limitation remains.

## Evidence and rollback

Ignored `output/sandbox-measurement-defaults-20261002/` contains source selection,
role inventories, payloads, migration scripts and audit output. Actual release
receipts retain their previous paths; later local inventories may list already
updated roles. For code rollback, confirm the current release, restore each
receipt's previous symlink, restart its development service and check readiness
and isolation. Shared hardlinked release files must never be edited in place.
The two data flag changes are separate: use the private backup if explicitly
reverting them, preserving any later unrelated organization changes.
