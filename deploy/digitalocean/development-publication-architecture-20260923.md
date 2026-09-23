# Publication architecture development release — September 23, 2026

Active runtime: `5f1ea338f6ce3707c7374884f79de20f5529bff1`.
Previous runtime: `974f20e6639bbe4a4a1011bd69d67cd20edf0ef6`.
Canonical branch: `codex/consolidated-firstmeasure-20260923`.

This release deploys previously undeployed architecture `4a3c46c` together with
native document/workflow and scope builder integration, dependency-aware live
evaluation, consumer-owned frozen data/code/action bindings, typed datasets,
published module lifecycle actions, current author/resource authorization and
uncertain-command review. Measurements normalize supported roof XML, saved
exterior reports and instant roof-area estimates without changing geometry.

See [the architecture guide](../../docs/architecture/publication-architecture.md)
and [the completion record](../../docs/architecture/implementation-completion.md)
for supported behavior and explicit compatibility boundaries. Historical
executable functions and the moving-company thought experiment are not deliverables.

## Source and runtime verification

- Commit pushed before packaging. Exactly 77 reviewed source files were overlaid
  from immutable Git content; runtime source before-hashes matched the inherited
  architecture's pre-change source. Commit ancestry alone was not used to infer
  deployed contents.
- Staging retained and checked 23,452 unchanged public files on web/compatibility
  and 23,463 on worker. All 226 `public/measure/internal` files were independently
  compared byte-for-byte with the previous runtime after activation.
- The staged backend's TypeScript/JSON source matches the clean committed Linux
  build. `npm ci`, TypeScript check/build and 44 publication tests passed on Linux;
  the PostgreSQL-only test passed separately in the embedded PostgreSQL runner.
- Locally, 71 affected existing-domain tests and the headless authoring/instance/
  scope browser checks passed. The compiled QuickJS worker passed data-bridge and
  host-isolation checks before packaging production dependencies.
- One Linux runtime archive was distributed to the roles, containing 22,283 files
  and 56,525,723 bytes. SHA-256:
  `459ef12ae3b78640d1a2a82b477d212068fb1e9bc3dcf193f3f3eca58f796477`.
- All three running roles report this release and backend fingerprint
  `eb5e5d48ae27d5e2e786e7e3c0c7c65d6ca28e524653f19d0c2401a6516cda3e`.

## Activation and live checks

The guarded helper verified development data, outbound isolation, expected
baseline and owner configuration before staging/activation. Compatibility,
worker and web were activated sequentially; worker activation required no
running measurement jobs. PHP-FPM was refreshed on compatibility and web.
Each role passed readiness and release identity checks with rollback available.

The public load balancer returned 503 during its restart health transition.
Origin NGINX and the application were healthy; public availability recovered
without configuration changes. Final public readiness confirms the exact
release, development data and enforced outbound isolation. Six served assets
match committed source, covering new builders and retained editor scripts.

A disposable owner account and organization exercised the real HTTPS API:

1. Authenticated provider/action catalog discovery.
2. Typed dataset creation and durable idempotent action replay.
3. A live workflow output feeding a separately instantiated document, refreshing
   upstream dependencies when the source dataset changes.
4. A frozen accepted document remaining unchanged after another source change.
5. Explicit module commands invoking a data-write action exactly once on replay.
6. Accepted module renders materializing into native portal documents.
7. Native template publication attaching code and native document creation
   calculating its declared outputs.
8. Tenant isolation and CSRF denial paths.

A scope saved through the live HTTPS API retained its actual publishing author,
ignoring forged client authority. The compiled scope runtime executed its bound
module-creation action once and replayed the accepted result. Revoking the
author's membership blocked further replay. This used the development database
and current deployed runtime, without modifying any customer project.

Disposable organizations, identities, sessions, captures, receipts and scope
records were removed in test cleanup. Evidence and guarded release helpers are
under `output/publication-architecture-20260923/` locally and
`/tmp/publication-architecture-20260923/` on the development hosts. No secret
values are stored in these evidence files. Production and saved editor geometry
were unchanged. Existing feature entitlements were preserved.

## Recovery

The previous complete runtime remains installed. If rollback is needed, activate
`974f20e6639bbe4a4a1011bd69d67cd20edf0ef6` on development roles with the same
role-specific readiness checks, worker quiet check and PHP-FPM refresh. Stop
new programmable scope use before rollback; the old runtime does not support
new module actions. Publication tables are additive. Preserve records and
receipts for recovery; do not delete them or blindly replay uncertain commands.
