# Development payroll publication integration — October 6, 2026

User authorization: complete payroll's integration with the data publication,
action and widget registries, and publish it to `dev.1m8.ai`. Production
activation is outside this authorization.

Source: `a4dd61f047313f6dc49d70dee66fe822450edf2f`, with discovery and widget
contract corrections in `edffff4d15d6847a90700b66ea7d6f7ddc64f97e`.
See [the payroll architecture contract](../../docs/architecture/payroll-publication.md).

The integration exposes 19 datasets, 41 payroll operations, and 12 shared
widgets. The Payroll tab consumes the same six native leaf widgets that agents
can display. Data reads do not reconcile commissions or seed workforce roles.
Writes reuse the domain services with publication receipts and current
authorization. Existing HTTP and binary download compatibility is retained.

Validation completed locally:

- TypeScript check.
- Full publication suite: 61 passed, one optional PostgreSQL test skipped.
- Focused payroll/domain/permission/widget tests: 19 passed; the new payroll
  test also passed after adding global agent-discovery coverage.
- Browser check: all native leaves, independent filters, typed mutation receipt,
  access-revocation cleanup, widget destruction and mobile layout passed.
- Payroll export UI and details contracts: three passed.

Rollout uses per-role immutable overlays over freshly inspected development
baselines. It preserves other sessions' changes and uses baseline fingerprints,
Linux TypeScript checks, detached overlay files, readiness checks and rollback
gates. A concurrent widget-refresh deployment changed the baseline during
staging; the guard rejected the stale attempt rather than replacing that work.
The final baseline is re-audited before activation.

Activated and verified on all four development roles: web, pool, compatibility
and worker. Active release: `edffff4d15d6847a90700b66ea7d6f7ddc64f97e`.
All final baselines were `2f89368773cadbdf0bb8e9b80a1aa89040e2cfdf`; role-specific
source drift was preserved. Primary/public readiness was checked again after
all role activations, since a healthy remaining role can still serve the prior
release during a rolling update.

Live verification passed:

- Source and compiled overlay fingerprints: 32 files on each web/compatibility
  role and 25 on the worker, including the worker's widget catalog.
- Every role ready, using development data and the development session cookie,
  with outbound safety enforced.
- Seven public assets match the expected payload, including catalog, renderer,
  runtime, PayrollAPI, native workspace, settings and cache-version manifest.
- Real signed-in agent discovery returns all 12 payroll widgets; presentation
  authorization succeeds for upcoming payroll without writing chat history.
- Eleven actual payroll publication reads return ready, including personal
  earnings and the safe assignment directory. The registry contains all 19
  exports and 41 actions. No payroll domain mutation was performed by live smoke
  verification.

Verification artifacts are retained under the ignored
`output/payroll-integration-20261006/` directory: per-role baseline inventory,
manifest/payload hashes, `verified-deployment.json`, `verified-public.json`,
`live-discovery.json`, and browser screenshots.

Functional gaps are deliberately deferred: crew earning creation, group
allocation semantics, and contractor payable synchronization on changed or
voided runs. Empty forecasts do not prove that no compensation is owed.

Verified UTC: 2026-10-06T19:00:23.478778+00:00
