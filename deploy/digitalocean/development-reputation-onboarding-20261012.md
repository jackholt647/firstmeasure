# Reputation onboarding — October 12, 2026 UTC

## Scope and source

Source commits `4e396d15bdd418c1fd2fecfdcc0197482be59545` and
`8a4e2ed40cf27601ed0bf62fa582f01a18f7087c` add the guided business draft,
Telnyx enterprise registration, authorization download/drawn signature/PDF upload,
separate enterprise and LOA approval status, rejected-registration correction,
number enrollment and scheduling, spam-label remediation and polled outcomes,
and disabling reputation without disconnecting phone service. The final commit
also requests the LOA using the correct PDF Accept header, with a binary transport
regression test.

Per the user's revised scope, there is no checkout, customer charge, price catalog,
subscription, billing entitlement or usage-meter integration. Telnyx carrier costs
are disclosed before live commands. Development allows local drafts and continues
to block carrier registration, authorization submission and paid commands.

The [phone settings architecture](../../docs/architecture/phone-settings.md) and
[publication contracts](../../docs/architecture/phone-publication.md) describe the
workflows, permissions, carrier prerequisites and failure recovery. EIN and signature
bytes are not stored locally or exposed through publications. Uncertain carrier
writes stay locked for reconciliation instead of repeating a paid request.

## Publication and validation

The compiled catalog contains **15 data exports, 7 actions and 20 triggers**.
New onboarding/remediation read models and events use the existing tenant-scoped
storage and atomic outbox. Signing, registration and paid commands remain explicit
human-confirmed flows. No schema migration or general scheduler activation is needed.

- TypeScript passes locally and on each staged Linux role.
- 37 focused phone/onboarding/publication tests pass on SQLite; 21 onboarding and
  publication tests pass against embedded PostgreSQL.
- After the PDF-header correction, all 10 onboarding tests pass, including the
  real client transport with an injected HTTP response and no external network.
- The full publication suite passes 81 tests, with its one PostgreSQL-only test
  skipped in the SQLite run.
- Both browser tests pass, covering the new signup/signature/approval/enrollment
  flow, existing phone settings, no billing requests, and mobile bounds. The
  mobile screenshot was inspected.
- A temporary organization on development exercised a real local onboarding draft.
  The running compatibility phone owner completed the resulting durable outbox
  and `phone.reputation.onboarding_updated` Work event. The probe did not invoke
  either event processor directly. Temporary organization, resources and events
  were removed afterward. No carrier operation was performed.

## Development rollout

All four final candidates passed Linux checks and compiled publication validation.
All four roles serve the final phone source and compiled modules. HTTP readiness
is verified on web, pool and compatibility; the dedicated worker is active.
Three consecutive public readiness responses passed, and public Phone Settings
and application-manifest bytes match the staged hashes. See the committed
[verification receipt](reputation-onboarding-20261012/verification.json).
The initial staged release was `4e396d15`; the final release is `8a4e2ed4`.
Each candidate copies its current immutable role baseline and overlays only the
reviewed task files. Unrelated Feed, SMS, policy, editor and permission changes are
preserved. The worker receives backend files only. No production service or
configuration is changed.

Reviewable cumulative patches from the originally captured baselines and final
source/hash manifests are in [reputation-onboarding-20261012](reputation-onboarding-20261012/).
The ignored `output/reputation-rollout-20261012` directory holds captured archives,
complete candidate payloads, staging logs, guarded activation scripts and checks.

Activation checks development environment, current baseline and source hashes,
stamps a detached release environment, switches the current symlink atomically,
and restarts the matching development service. Failed readiness rolls back only
if that role still points to this candidate. The standard production activator is
not used. The compatibility process remains the sole phone maintenance/event owner.

## Candidate identities and rollback baselines

| Role | Final candidate | Immediate rollback baseline |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/phone-8a4e2ed40cf27601ed0bf62fa582f01a18f7087c-web` | `/opt/firstmeasure/releases-gif-drafts-1791774124/d31cfa48b3afa20a2a5165315093abffad506ab3` |
| pool | `/opt/firstmeasure/releases/phone-8a4e2ed40cf27601ed0bf62fa582f01a18f7087c-pool` | `/opt/firstmeasure/releases-gif-drafts-1791774200/d31cfa48b3afa20a2a5165315093abffad506ab3` |
| compat | `/mnt/firstmeasure_dev_releases/releases/phone-8a4e2ed40cf27601ed0bf62fa582f01a18f7087c-compat` | `/mnt/firstmeasure_dev_releases/releases/phone-4e396d15bdd418c1fd2fecfdcc0197482be59545-compat` |
| worker | `/opt/firstmeasure/releases/phone-8a4e2ed40cf27601ed0bf62fa582f01a18f7087c-worker` | `/opt/firstmeasure/releases/phone-4e396d15bdd418c1fd2fecfdcc0197482be59545-worker` |

The original captured releases were `30e07f0a-policy-redirects` on web/pool,
`30e07f0a-policy-redirects-r2` on compatibility and
`7c40900917d67d4b41c235cc037beda9a3f25aed` on the worker. The intermediate
`4e396d15` activation reached worker, compatibility and web before the PDF-header
follow-up; concurrent Feed/GIF releases advanced web and pool before final staging. Hash guards
rejected the old web manifest; final candidates preserve these newer changes.

## Concurrent deployment verification

The compatibility server subsequently activated the Feed/GIF release at
`/mnt/firstmeasure_dev_releases/releases-gif-drafts-1791774385/d31cfa48b3afa20a2a5165315093abffad506ab3`.
Its process release label is `d31cfa48`, while its phone source remains `8a4e2ed4`.
Verification compares every phone source and compiled backend module against the
final candidate, checks the Phone Settings bundle version, and validates readiness
against the actual process release. An unrelated loader cache-version change is
preserved; it is not treated as a reason to roll back another feature.

## Limits

Carrier approval is external and remains required. No real Telnyx enrollment,
signature submission, paid check or remediation was performed. Retail pricing,
customer billing and subscription management remain outside this implementation.
