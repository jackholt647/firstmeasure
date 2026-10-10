# Development phone settings — October 10, 2026

Implementation: `fd248928`; merged source pushed to `codex/consolidated-firstmeasure-20260923` at `0cc05eb5`. Feature branch: `codex/phone-settings-20261010`. This task authorizes development only.

Status: **source pushed; development activation blocked by worker deployment access**. No server current symlink or service was changed by this task. Existing development remains active. Production is unchanged.

The available worker account is `ben` through SSH alias `firstmeasure-employee`; it can prepare and verify a candidate but cannot write the root-owned deployment symlink or restart the service. Noninteractive sudo requires authentication, and installed deployment identities are rejected for root. An approved privileged deployment path is required before activation. Do not activate web APIs without the worker: new attribution/notification jobs and routing policies require the new worker.

## Verification

- TypeScript checks pass on the integrated local source and all four staged server candidates.
- All four staged candidates pass source-hash checks and compiled phone API runtime imports.
- 105 focused backend tests pass: phone settings, customer calls, messaging API, and Telnyx compliance state. FirstMeasure background workers are disabled in isolated test processes.
- Two browser tests pass: phone settings forms/navigation/mobile bounds and the existing docked phone tray.
- An existing broader communication email-notification visibility assertion fails with the unchanged original notification module from `f7b6dd78`; it is recorded, not suppressed.
- Provider tests use mocks. No real calls, purchases, port submissions, number transfers or paid provider operations were initiated.

## Candidate preparation

The source release basis is immutable ancestor `77ec49a09b7963485860cc14509c12b1f2edbcee`. Role packages contain only the task's frontend/backend files; the worker receives backend files only. Each package preserves its captured deployed baseline. Stage checks compare actual source hashes before copying, compile only changed modules using the package's native ESM format, check the complete TypeScript tree and verify source/compiled syntax.

Web candidate: `/opt/firstmeasure/releases-phone-settings/77ec49a09b7963485860cc14509c12b1f2edbcee-web`.
Worker candidate for validation only: `/home/ben/phone-settings-candidate/77ec49a09b7963485860cc14509c12b1f2edbcee-worker`. A privileged deployer must place the worker release in the normal service-readable release tree before activation.
Other role candidates use the same release prefix with `-pool` and `-compat`.

The web baseline includes concurrent conference, group MMS, feed and live-registration changes not present on the initial canonical branch. Reviewed integration patches are retained in `phone-settings-20261010/` and local per-role source/hash manifests are in `output/phone-settings/deploy/`. Web/pool/compatibility preserve those changes; group MMS checks all participants' sending windows before dispatch. Worker differences preserve its older UI by excluding frontend files. Revalidate current role baselines before using a staged candidate after any intervening deployment.

No activation or readiness claim is implied by preparation. After access is supplied, inspect concurrent changes, refresh candidates as needed, activate worker/web/pool/compatibility with rollback guards, stamp the new release identity in each candidate’s `release.env`, then verify public readiness, development isolation, asset hashes and authenticated settings behavior.

See [feature architecture](../../docs/architecture/phone-settings.md) for settings precedence, authorization, carrier contracts and functional limits.
