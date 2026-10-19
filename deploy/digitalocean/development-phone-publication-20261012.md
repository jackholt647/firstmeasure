# Phone Settings and publications — October 12, 2026 UTC

This record covers the coordinated development activation of unified Phone
Settings, Call Lists, the phone extensions, and shared data/actions/triggers.
Production was not changed.

## Release identity and preserved baseline

Phone source is `ca303672e994c86e43bcd1726b2317a5e12d4373`, including the
publication audit and the scoped development phone-event consumer. The canonical
branch also contains concurrent changes through `d4c90d0a`. Source and this receipt
are published to `codex/consolidated-firstmeasure-20260923` and
`codex/phone-settings-20261010`.

Each candidate copies its current immutable role baseline and applies only the
verified phone source overlay. Hash guards rejected two concurrent baseline
advances before activation. Final candidates preserve the deployed editor changes
through `745f994ca8d680112208137cb0ddc0d018fc6df6`, including plane snapping and loose
connection rendering. Group MMS, conference participants, Feed settings and each
role's existing permission baseline are retained.

The committed patches in `phone-publication-20261012/` contain the complete phone
integration against the captured source baseline. Later unrelated releases did
not change these files. The ignored `output/phone-rollout-20261011/` directory
contains source manifests, archives, staging logs and the guarded activation and
verification scripts.

| Role | Activated release | Rollback baseline |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/phone-ca303672e994c86e43bcd1726b2317a5e12d4373-web` | `/opt/firstmeasure/releases/745f994ca8d680112208137cb0ddc0d018fc6df6` |
| pool | `/opt/firstmeasure/releases/phone-ca303672e994c86e43bcd1726b2317a5e12d4373-pool` | `/opt/firstmeasure/releases/745f994ca8d680112208137cb0ddc0d018fc6df6` |
| compatibility | `/mnt/firstmeasure_dev_releases/releases/phone-ca303672e994c86e43bcd1726b2317a5e12d4373-compat` | `/mnt/firstmeasure_dev_releases/releases/745f994ca8d680112208137cb0ddc0d018fc6df6` |
| worker | `/opt/firstmeasure/releases/phone-ca303672e994c86e43bcd1726b2317a5e12d4373-worker` | `/opt/firstmeasure/releases/745f994ca8d680112208137cb0ddc0d018fc6df6` |

The development deployment key now permits root access on the dedicated worker;
the ordinary employee alias still logs in as `ben` without noninteractive sudo.
No account, key, environment policy or fleet topology was changed for this release.
Activation stamps a detached candidate `release.env`, checks the existing service's
development environment, switches its current link atomically, and restarts the
matching development service. Failed readiness rolls that role back only if its
current link still points to this candidate. The standard production activator
was not used.

Services are `firstmeasure-development-web.service` on web/pool,
`firstmeasure-development-legacy.service` on compatibility, and
`firstmeasure-development-worker.service` on the worker. PHP-FPM is restarted on
the three HTTP roles. Activation order is worker, compatibility, web, pool.

## Runtime and publication coverage

The [phone architecture](../../docs/architecture/phone-settings.md) documents
settings, Telnyx setup and feature limits. The
[publication contract](../../docs/architecture/phone-publication.md) documents all
13 typed data exports, 7 domain actions and 18 typed phone triggers. Catalog
registration was verified from the compiled modules on every role. No new database
tables or migration are needed for this release.

Development's compatibility process is the existing phone worker owner. There is
no general platform worker in this topology. Its existing phone event lane now
drains only the registered phone Work event types, using the shared engine's
leases and retries. General Work backlogs and unrelated schedulers are not enabled.
Production's platform-worker behavior is unchanged.

A temporary development organization exercised `phone-settings.personal.save`
through the real publication action and domain writer. The running compatibility
phone owner completed its durable outbox job and `phone.personal.updated` Work
event without the probe directly invoking either processor. The temporary
organization, phone resources, outbox jobs and Work events were removed afterward;
the action execution receipt is retained as audit evidence. No customer setting
was changed and no carrier action was performed.

## Validation

- All four Linux candidates passed TypeScript checks, changed-module compilation,
  source SHA-256 checks, JavaScript syntax checks and compiled catalog validation.
  HTTP roles contain 38 overlaid source files; the worker contains 31.
- The scoped event-drain change passed 24 phone-publication/automation tests and
  all 12 phone-publication tests against embedded PostgreSQL.
- The earlier integrated publication audit passed 80 publication checks (one
  PostgreSQL-only case skipped in SQLite), 123 focused regressions and 13 embedded
  PostgreSQL checks. Earlier feature checks included 111 backend and 8 browser
  tests; those historical runs are detailed in the extension record.
- Public `https://dev.1m8.ai/v1/health/ready` returned the new release in three
  consecutive requests, with development data and enforced outbound isolation.
  Public Phone Settings, Company Settings, CRM settings and application manifest
  downloads matched the staged SHA-256 hashes exactly.
- Runtime checks verify the process release identity and all source hashes on
  each role, with HTTP readiness on web, pool and compatibility and systemd
  readiness for the dedicated worker.

## Provider limits and rollback

Development destination restrictions remain enforced. Paid number purchases,
actual port transfers and reputation enrollment were not performed during this
rollout. Live provider behavior still requires the documented Telnyx account,
number/application, recording and reputation approvals. Tracking is static
tracking-number attribution; dynamic browser number insertion is not included.
Phone billing reports accepted number costs and existing billing links; it is not
a new subscription billing engine.

For rollback, first stop new phone-setting writes and account for queued
`phone_event` work before reverting the compatibility consumer. Restore each exact
baseline above only after verifying no newer release has replaced this one, then
restart its listed development service and PHP-FPM for HTTP roles. Verify local
and public readiness and development outbound isolation. No schema rollback is
required. Do not roll the consumer back while leaving new writers active.
