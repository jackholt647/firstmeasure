# Initial Schedule tab and compact contact dropdown — development, October 2

Source release: `2ddd423f0d1c12962d5a7c12aa399d143e6841a7`.

The opening header supplied the incoming project to the app registry but retained
`schedulePreviewAvailable` from the idle modal context. That false flag hid Schedule
until the child hydrated its project. Opening now evaluates the shared availability
predicate against the incoming project, without borrowing a previous modal's address
state. Scheduling entitlements remain unchanged.

The project identity dropdown places name and phone on a vertically aligned two-column
row, keeps email below, and removes duplicate contact bottom padding above the address divider.

Validation: seven opening tests, three header/identity browser tests, and four contact
shortcut/title tests passed. Release JavaScript passed syntax checks on all roles.

Only project-request/app.js and its manifest version are deployed. Role-specific live
frontend changes were retained through three-way reconciliation; all backend files and
workers remain unchanged. Production is outside this release.

## Rollback baselines

- web: `/opt/firstmeasure/releases/ba1c7d9e8b5bb2ec0d04370399ef75a7c38ef8bf`
- legacy: `/opt/firstmeasure/releases-root-archive/c70a1d4b9dffa0f913934c9d26d06046d23c0621`
- pool: `/opt/firstmeasure/releases/ba1c7d9e8b5bb2ec0d04370399ef75a7c38ef8bf`

All three roles activated successfully with development isolation and readiness checks.
Both public JavaScript assets matched the release SHA-256 hashes. The live blank-project
dropdown confirmed aligned name/phone fields and zero duplicate bottom padding.
The sandbox account has no saved projects, so the existing-project Schedule transition
was verified by the automated regression rather than against the reported live record.
