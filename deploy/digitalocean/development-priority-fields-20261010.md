# Shared Priority fields — development rollout, October 10, 2026

Feature commit: `49309ae1f2a6d25b506161bf81bc64525fc6241c` on `codex/consolidated-firstmeasure-20260923`.
User authorized GitHub publication and activation on `https://dev.1m8.ai`.

## Architecture

Project configuration now stores an ordered `priority_fields` list of singular
published field references. Project modal quick displays use the shared
`priority-fields.values` resolver and browser `FirstMatePriorityFields` API.
Settings → Projects → Priority fields edits the shared list, labels, formatting,
order and empty-value behavior. Explicit configuration determines the exact list.
Existing header and custom-tag settings read through compatibility defaults until saved.

Calculated custom fields own their expressions. Supported operations include
first available, sum, product, difference and quotient. A calculation can select
published document variables by template/status/date or a specific instance.
A priority entry points to the resulting declared field. Source reads preserve
permissions and provenance; captured values reauthorize their dependencies.
See [the developer guide](../../docs/architecture/priority-fields.md).

## Validation

- Isolated feature commit: TypeScript check passed.
- New backend tests: 4 passed with file storage and 4 with embedded PostgreSQL.
- New browser editor/shared-renderer fixture: passed, including document alternatives,
  order, singular-field priority, denied-value hiding and valid zero currency.
- Isolated publication suite: 69 passed, 1 PostgreSQL-only skip, no failures.
- Dirty working-tree publication suite: 87 passed, 1 PostgreSQL-only skip.
- Existing custom-fields browser tests passed.
- Older project window/opening and contact-flow browser/contract tests have
  inherited failures. The identity-popover visibility, Close project selector,
  and old contact-opening assertion were also reproduced on saved pre-change source.
  The broader window run additionally exposed fixture attachment and tab-count failures.
  These checks do not establish a clean full-project-window regression baseline.

## Delivery and baselines

GitHub contains only feature-owned changes; unrelated dirty and staged source
was retained. Development roles had different release baselines. Each immutable
release overlays only the verified feature delta onto its audited existing role
baseline; it is not a wholesale checkout deployment. Owned source/compiled files
are detached before writes during same-filesystem hardlink staging. Baseline
hashes, service identity, development data environment, development session cookie
and outbound safety are checked before activation. No schema/dependency changes.

All four roles passed Linux TypeScript checks and all four new backend tests
in isolated temporary fixture storage. Every active source/compiled payload hash
matches its audited role manifest. Shared publication bootstrap registers
`priority-fields` and `project-summary` on every role. Runtime readiness passes
with development data, development session-cookie isolation and outbound safety
enforced. Public readiness reports the feature release. All six hosted frontend
assets match an approved frontend-role payload; the priority editor and shared
header/card browser regression passes with those downloaded hosted scripts and
fixture APIs. This browser check does not edit real project or branch records.

The second web node's first activation exceeded the initial readiness window
and automatically restored its prior release. Service logs showed a shutdown
timeout. Retrying the same verified artifact with a 90-attempt startup readiness
window passed, preserving the same baseline/isolation/rollback guards. No
service unit, environment setting, topology or production system was changed.

| Role | Active release | Verified payload files |
| --- | --- | --- |

## Prior paths for rollback

Before rollback, check for subsequent deployments. Restore the applicable prior
`/opt/firstmeasure/current` symlink, restart only that development service, reload
PHP-FPM for frontend roles and verify readiness/isolation. Keep saved priority
configuration and calculated-field definitions; prior readers ignore those additions.

- web: `/opt/firstmeasure/releases/26022ecc-user-preview-phone`.
- worker: `/opt/firstmeasure/releases/68a734d5a50af9d12c31d68a3e35f98d74a10ea3`.
- legacy: `/mnt/firstmeasure_dev_releases/releases/1466c0883b3710ed547c81ec172ebc70229bc980`.
- pool: `/opt/firstmeasure/releases/1466c0883b3710ed547c81ec172ebc70229bc980`.

| web | `49309ae1f2a6d25b506161bf81bc64525fc6241c` | 36 |
| worker | `49309ae1f2a6d25b506161bf81bc64525fc6241c` | 27 |
| legacy | `49309ae1f2a6d25b506161bf81bc64525fc6241c` | 36 |
| pool | `49309ae1f2a6d25b506161bf81bc64525fc6241c` | 36 |
