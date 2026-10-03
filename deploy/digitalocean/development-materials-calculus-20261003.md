# Document-owned materials calculus development rollout

## Source and authorization

The user authorized implementation and deployment to `dev.1m8.ai`, with no
backward-compatibility requirement for existing documents. Production activation
is not authorized. Core source: `c29425096933b102432e899c8dedf789fa7b0834`; hardening:
`b3165be4121ba1c399214d1f4dd22ca522292787`; final review UI:
`39f6f68f803b9e8da475dfe8c0cbd42fb5223f6b`, on the canonical
combined branch. [Architecture and authoring guide](../../docs/architecture/materials-calculus.md).

## Delivered behavior

Signed document snapshots own typed materials calculus definitions. The signing
outbox publishes independent pending sets exactly once. Pure calculations combine
accepted document values, explicit measurement/catalog bindings and manual inputs.
Reviewed results become immutable requirements. Amendments remove exact prior
lines and add replacements; quantities already ordered follow compatible lineage.
Duplicate requirements remain distinct through orders and shared deliveries.
Partial receipts, cancellation, returns, price adjustments and rescheduling retain
an audit trail. Orders are internal commitments; no supplier API transmission is
configured or implied.

The organization price-book publication is read-only. PostgreSQL organization
catalogs retain their overrides in shared storage and save them atomically with
the effective catalog and revision. Sources reauthorize current callers, including
retained evidence. Existing unrelated workspace edits and staged files were
preserved using an isolated commit index.

## Validation

- Isolated committed-source TypeScript check: passed.
- Materials lifecycle, authorization, concurrency, signed artifacts, package
  conversion, source access and real-service browser tests: 10 passed.
- Full signing/API integration plus materials: 10 passed.
- Embedded PostgreSQL materials and immutable publication tests: 10 passed.
- Publication suite: 50 passed; the PostgreSQL case ran separately above.
- Price-book model/storage regression tests: 5 passed.
- Existing document/materials API regression suites: 35 passed.
- Desktop/mobile screenshots captured; mobile materials rows remain within width.

## Release method

Immutable overlays of verified live development baselines, with three-way merges
preserving role-specific source. Source and compiled hashes are checked before
activation; each Linux release passes syntax checks, compiled/source parity and
TypeScript checks. Unchanged files in hardlink releases are not modified.
Runtime checks require development data, the development session cookie,
readiness and enforced outbound safety. Activation rolls back automatically if
readiness fails. Deployment manifests and verification output are retained under
`output/materials-calculus-20261003` (ignored operational artifacts).

## Rollback

Use each role's `previous_path` in the deployment manifest, atomically restore
`/opt/firstmeasure/current`, and restart its development service. Reload PHP-FPM
on serving roles after changing frontend releases. Retained material ledger data
must not be deleted during rollback. The original pre-feature release cannot display the new ledger; the
final rollout baseline already includes the core materials feature. No database schema migration
is required beyond the shared platform collection allowlist.

## Activation and hosted verification

The final release passed the hosted browser check: two independent 20-bundle
sets, a shared order/delivery, then an amendment to 25 bundles with 5 outstanding.
No browser errors. A fresh mobile viewport verified both document and materials
width at 372px without horizontal overflow. The sandbox fixture is retained as a
reviewable demonstration; its internal order is explicitly a verification record.

Final activation of `39f6f68f803b9e8da475dfe8c0cbd42fb5223f6b` was activated and verified against
`01a9c235800aeaafea34c9150a6ab39abc12b625`, preserving the concurrent partner
invitation release. All four roles passed post-activation source/compiled hash
verification and development readiness. Four public readiness requests reported
this exact release with outbound safety enforced. The served Materials workspace,
project app and document authoring panel matched the staged hashes.

The final hosted scenario retained project `project_materials_8b5ff2c92d46465d`
in the development verification sandbox. The browser confirmed separate sets,
shared delivery allocations, explicit removal/addition review and exactly five
outstanding bundles after increasing one requirement. No browser errors.
