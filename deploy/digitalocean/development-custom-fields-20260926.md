# Custom fields development rollout — September 26, 2026

User-authorized target: `https://dev.1m8.ai`. Production is outside this rollout.

## Source and scope

Source commit: `d2815009f88dabb08b1a3997a0f6285ebfa97b9a` (`codex/custom-fields-publication`), based on the canonical integrated checkout. Only custom-field hunks were selected from shared files; unrelated workspace changes were preserved.

The release adds typed project/contact/organization variables, nested arrays and dictionaries, integer and declared format validation, shared data-provider reads, and authorized revision-checked write actions. Existing notification, billing, localization and role-specific runtime source is retained.

## Runtime identities

| Role | Previous release | Custom-fields release |
| --- | --- | --- |
| web | `5070a34c52b60688faa7afe432befd0da12d0874` | `e5b4ed935875663c3e4e64c119a3848808e19ec5` |
| worker | `b106df96608c0a36850e2f6564c3307bdb811af5` | `529dea1c5ebabcd2c06d598f9d2a15ccbf55b4ca` |
| legacy | `998dac1913322c0c6b547e776eb99ff55e329f45` | `6991a9a733e8270ba419b8e60c269fbc2b405427` |
| pool | `fb98bd981d0e38f9aaa1c243982c91a0b1f5a76e` | `a7d72ff58d673f10a58f040b1a266d16b9d2cee5` |

## Rollout and verification

All four roles activated successfully and passed source/compiled hash checks, development readiness, outbound-safety checks, and provider/action registration checks. No rollback was needed. Evidence and guarded deployment helpers are under `output/custom-fields-dev/`.

- Every role passed `npm run check`, production build, and `npm run test:publication` (49 passed, one PostgreSQL-only test skipped).
- Every role passed 12 focused service, UI-contract and custom-field publication tests.
- A separate embedded PostgreSQL run passed all three tests, including custom-field writes with `POSTGRES_POOL_MAX=1` and shared immutable records/action receipts.
- Authenticated HTTPS checks through `dev.1m8.ai` verified discovery, integer writes, private owner reads, read-only rejection through both actions and generic PATCH, idempotent replay, embedded contact arrays, organization email fields, invalid nested values/email rejection, and cross-organization denial.
- The disposable organization, identity, session and receipts were removed after the live checks.
- Both web releases and the served custom-field JavaScript asset passed public verification.

Builds run against captured role source on the development worker. Generated language catalogs and the PHP portal entrypoint are included in the isolated test fixtures. Source is overlaid onto each inventoried immutable runtime baseline; dependencies and runtime configuration are preserved. Activation verifies expected baseline identity, development data isolation, enforced outbound restrictions, source/compiled hashes, readiness, and all three custom-field providers/actions. Worker activation requires no running measurement jobs; failed readiness restores the prior release.

Custom-field validation reuses the active PostgreSQL transaction client, verified with a one-connection pool to prevent nested-read pool exhaustion.

No database migration, provider credential change, topology change, or production activation is included. The previously documented historical development autoscale image/bootstrap remains a separate limitation: future replacement nodes are not certified by this rollout.

## Rollback

Restore the corresponding previous release's `current` symlink and restart its existing development service; refresh PHP-FPM on HTTP roles and verify development readiness. Organization custom-field records are additive data and should be retained. A code rollback does not reverse user edits.
