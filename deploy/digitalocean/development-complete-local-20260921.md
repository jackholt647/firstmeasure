# Complete local development release — September 21, 2026

Development runtime: `2325b63c541aec4eb785a8998f2d11a752755d47` (activated September 22, 00:26 UTC).
Previous runtime and rollback target: `3240bc71374eb13dc65852c81a12f26e033fd8c6`.
Source branch: `codex/dev-complete-local-20260921` on origin.

This release reconciles the main local FirstMeasure checkout with the complete
`firstmate-platform-integration` worktree. It includes the integrated platform
apps, portal/mobile changes, customer exterior work, measurement preferences,
platform language catalogs and report/document localization. Later deployed
editor fixes from the September 18 baseline are retained. A feature-picker
measurement formatter was corrected to use its browser scope.

## Activated development roles

| Role | Host | Service |
| --- | --- | --- |
| Web | 143.198.68.11 | firstmeasure-development-web.service |
| Worker | 137.184.44.82 | firstmeasure-development-worker.service |
| Compatibility | 137.184.229.145 | firstmeasure-development-legacy.service |

All three current symlinks and running process release IDs match the runtime
above. Fresh per-role readiness verifies development data and enforced outbound
isolation. All three services are active with zero automatic restarts. Public
`https://dev.1m8.ai/v1/health/ready` reports the new release and healthy checks.
The portal login was verified in a browser; language, units and company-settings
assets return HTTP 200. No authenticated order, payment or delivery was submitted
during this deployment. The single web backend briefly returned 503 during its
restart and load-balancer health recovery; public availability was verified
afterward.

## Packaging and configuration

2,278 reviewed public/deployment source files were packaged from the immutable
Git commit. Before staging, deployed application files matched either the old
Git baseline or the candidate. Five obsolete deployed test files differed;
they were replaced by the reviewed source tests. Missing baseline files were
documentation/tests. Existing runtime assets outside the source bundle were
preserved by cloning each inactive release directory before overlaying source.

Dependencies were installed from the lockfile and checked/built on Linux. The
worker's compiled output and pruned dependencies were checksummed and installed
on web and compatibility: 21,965 runtime files, 53,589,023 compressed bytes,
SHA-256 `6d85b3162f2f5812aade1e08d256da25bd24605f03bd61423ad2428dd79561f0`.
The web host has no npm toolchain. The compatibility host also passed its own
TypeScript check/build before receiving the identical worker-built runtime.

Local credentials, databases, preview fixtures, node_modules and build output
were not uploaded as source. The fictional Flow Roofing (Local review) dataset
and its local flags were not imported. Existing development organization flags,
service configuration, Spaces settings, full-house owner access and September 18
no-drain overrides were retained. New localization/metric and expanded-platform
capabilities remain default-off. The new platform worker was not installed or
started. Production was not changed.

The additive platform storage/index preparation ran successfully against the
development database (`platform_expanded_orgs_idx`). No fresh/cutover/data-import
commands were run. Existing provider isolation remains enforced.

This operation updated the three observed running development roles. Provider
autoscaling configuration and its historical machine image were not modified;
a future replacement node must receive this release before serving traffic.

## Validation

- Windows and Linux TypeScript checks/builds passed.
- Eight localization tests passed locally and on Linux, including company/user
  preference isolation, gated ordering, ICU catalogs and frozen document/report
  preferences with US compatibility.
- Seventeen focused portal/customer regressions passed.
- Four isolated PostgreSQL tests passed: shared transactions, cross-process
  realtime/document collaboration, and platform worker startup/drain.
- Four compiled deployment/preflight tests passed on Linux.
- All 164 PHP files passed syntax checks.
- Exterior suite initially passed 998/1,002. Two feature-picker failures were
  fixed and their two browser tests passed on rerun. The remaining two curved
  surface tests also fail in the original main checkout: `real house fillet
  crosses its finite eave without upright curtains or restored height` and
  `saved failing outward extrusion removes all three eave curtains`.
- The older inherited platform frontend contract failures remain documented in
  `docs/platform-integration.md`; a fully green all-app test suite is not claimed.

## Rollback

The previous immutable directory remains on every host. Atomically repoint
`/opt/firstmeasure/current` to the previous runtime above and restart the named
development service; restart PHP-FPM on compatibility as well. Wait for worker
jobs to be idle before switching that role. Preserve environment files and
development no-drain overrides. Retain the additive database schema/index and
any new data; do not restore databases or run fresh/cutover commands. Verify
per-role and public readiness after switching. Do not enable the new platform
worker as part of rollback.

Local reconciliation and deployment audit artifacts are retained under the
main checkout's ignored `output/dev-release-20260921/` directory. Original dirty
source workspaces were preserved; the small formatter correction and this
deployment record were synchronized back without replacing unrelated changes.
