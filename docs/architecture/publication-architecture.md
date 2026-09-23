# Data, actions, bindings and programmable modules

This is the implementation guide for the shared publication architecture. The
[conversation decisions](data-actions-continuity.md) explain the intent. The
[data guide](data-publication.md) and [action guide](action-publication.md)
describe individual adapters and migration limits.

## Ownership

- A **provider** is backend code implementing a common interface over many data
  records. A project, dataset or pricebook instance is the referenced resource.
  Discovery describes its exports; reading resolves one authorized instance.
- An **action** is a versioned operation with input/output schemas, target,
  permissions, application/capability requirements and an effect classification.
  Domain services retain their business invariants. Registry publication does
  not turn a raw database write into an authorized business operation.
- A **binding** belongs to the consumer. Its policy is `live` or `frozen`.
  The binding service resolves and retains data, code or action identities.
  It is independent of document rendering and scope execution.
- A **document module definition** describes code, schemas, exports, bindings
  and a DocModel renderer. Document and workflow instances have separate IDs,
  inputs, outputs and execution records. Generating a document from a workflow
  creates another instance with an explicit binding to the workflow's export.

The data/action interfaces are platform infrastructure. Custom code currently
runs in document modules and the scope automation `scope.code.run.v1`. Other
apps can publish data and operations without needing a custom-code interpreter.

## Entry points

Backend contracts live in `public/v1/platform/publication`. Bootstrap registers
the built-in providers and domain actions. The Work registry publishes existing
automation IDs with a private trusted-host adapter. Agent tools also pass through
schema, permission and effect checks; agent presentation facilities remain local.

HTTP discovery and invocation are under `/v1/publication/organizations/:orgId`:

| Route | Purpose |
| --- | --- |
| `GET /catalog?scope=project&projectId=...` | Discover permitted provider exports and API-callable actions |
| `POST /data/read` | Read a source reference, returning ready/missing/pending/denied/error |
| `POST /data/list` | Read a bounded page with a continuation cursor |
| `POST /actions/invoke` | Validate and execute an action; mutations need an idempotency key |
| `GET /projects/:projectId/measurements` | Read the project's selected effective measurement dataset |

The browser entry point is `PlatformAPI.publication`. It uses the existing
session, CSRF and error handling. Document module APIs are under
`/v1/document-modules/organizations/:orgId`; Document Studio's **Document modules**
control opens the advanced definition/instance editor. An existing saved document
does not become a programmable module implicitly.

## A concrete binding

```json
{
  "cubeSheet": {
    "kind": "data",
    "policy": "frozen",
    "required": false,
    "source": {
      "provider": "datasets",
      "export": "value",
      "target": {
        "scope": "project",
        "organizationId": "company",
        "projectId": "move",
        "id": "inventory-instance"
      }
    }
  }
}
```

The module can execute JavaScript such as:

```js
const inventory = await api.data.read('cubeSheet');
const estimatedHours = inventory
  ? inventory.items.reduce((total, item) => total + item.quantity * item.volume, 0) / inputs.cubesPerHour
  : inputs.manualHours;
return { outputs: { estimatedHours: inputs.overrideHours ?? estimatedHours } };
```

The author must declare input/output schemas and publish the desired output.
The sample formula is illustrative, not a built-in moving tariff. Optional
absence returns null; permission errors, invalid data and provider failures do
not silently become an empty inventory. An estimate document can bind to
`document-modules.value` using the workflow instance as `target.id` and
`args.exportName` to identify its published result.

## Version semantics

Live inputs are resolved once per source per evaluation, so two selected fields
do not observe different versions during that evaluation. Related values that
must be captured together should use one object/dataset binding. Independent
field bindings retain independent histories. No third `mixed` policy is stored.

Frozen captures retain source identity, revision, schema version, values and
provenance in a consumer-owned record. A unique database key resolves concurrent
first captures to one retained value. Authorization is checked again when a
snapshot is read. Historical values do not confer historical permissions.

The binding store and action receipts use the shared SQL abstraction:
PostgreSQL in cluster mode, SQLite for local mode. Dataset history is committed
with the current record using revision preconditions; it is never pruned silently.
Immutable initial records use atomic create-only writes on both storage backends.

Published module definitions are content-addressed, including source, renderer,
schemas and bindings. Evaluations record source/engine identities and binding
evidence. Freezing an instance retains its accepted result and prevents further
evaluation/input edits. Materializing it into the existing document pipeline
captures pricing/source/widget context; signature, QR and payment interaction
state are overlaid separately without recalculating accepted prices.

Materialization is idempotent for an instance execution, including concurrent
requests. Repeating it returns the retained document even after signing.
Published parameters on that artifact remain independent of subsequent module
edits. Writable input exports are changed through
`document-modules.export.write`, with revision checks, authorization and action
receipts; calculated outputs remain read-only.

Action pins include a backend dependency artifact digest. This conservative
implementation rejects a frozen executable reference after a backend artifact
change rather than substituting new service code. It does not archive and run old
server releases. Historical calculations remain available as recorded outputs;
historical external effects must never be rerun merely to render a document.

## Execution and effects

Raw tenant JavaScript runs in QuickJS inside a bounded worker. It has no Node,
filesystem, network or import access. It sees JSON inputs/state, captured time,
declared data bindings and declared action bindings. CPU, heap, wall time, JSON
size and capability-call budgets apply. Tenant schemas use a bounded subset to
avoid running tenant regexes or recursive references in host validation.

Evaluation cannot write or trigger external actions. Commands have durable
identities; each named action call gets a stable derived receipt. Concurrent
requests cannot repeat an effect. A timeout or lost result can leave the outcome
uncertain, so retries do not dispatch it again automatically. Accepted in-flight
capability calls must finish before an execution can report success.

Scope programs are authored in the versioned scope/work definition as an
automation input. They declare their own input/output schemas and bindings. The
same sandbox and binding service run them. Source code defaults to a frozen
binding for the scope instance; changing the program identity or explicitly
choosing live code is deliberate. Guest code never receives the Work engine's
privileged context or service closures. Completed outputs are published through
`scope-code.outputs` with project ownership checks.

## Extending an app

1. Identify its real domain records and services. Define a provider with explicit
   public fields, schemas, units and statuses. Keep secrets and private fields out.
2. Register domain actions with real validation, target checks, effect class and
   stable implementation identity. Reuse the same domain service as existing APIs.
3. Register through shared bootstrap. Add the app to `publication/coverage.ts`.
   Presentation-only apps need a stated reason rather than a dummy provider.
4. Add behavior tests: permitted use, wrong tenant/project, revoked access,
   malformed data, frozen reads and repeated/concurrent effects where applicable.
5. Use `PlatformAPI.publication` or backend binding sessions for new cross-domain
   consumers. Preserve explicit compatibility paths during migration.

Run `npm run check` and `npm run test:publication` from `public/v1`.
Run `node tests/run-embedded-postgres.mjs tests/publication-postgres.test.ts`
for the distributed storage guarantees. CI covers all app ownership entries,
publication behavior, the sandbox and the PostgreSQL path.

## What coverage means

The ownership inventory accounts for all current app packages and verifies that
its referenced providers and action domains really register. It is not an
endpoint-by-endpoint completeness proof. Existing HTTP domain APIs remain
supported, and narrow projections do not publish every underlying field.
Dedicated account, credential, subscription and administrative flows are not
made generally callable by tenant code. Consult each adapter's actual catalog
and the data/action guides when planning an additional operation.

The concurrent FirstMeasure editor work remains separate. This architecture
does not change `public/measure/internal`, deploy another thread's dirty files,
or authorize production activation.

## Verified implementation checkpoint — September 23, 2026

Type checking and the backend build pass. The publication suite has 36 passing
tests and one PostgreSQL-only test skipped in its default invocation. That test
also passed separately against embedded PostgreSQL, exercising concurrent
create-only writes, snapshot capture and effect receipts. The compiled sandbox
and dependency fingerprint pass on Node 22. A focused existing-domain regression
suite passes 61 tests across documents, collaboration, versions, Work, assistant,
materials, canvassing and media. Module editor browser smoke checks passed.

The integrated tests cover inventory to a separate estimate workflow to a
separate frozen document, optional-input fallback, overrides, permissions,
materialization, signed-artifact retention and effect replay prevention. They do
not assert that the entire moving-company sales/fulfillment scope is configured.

Remaining migration and product work is explicit:

- Expand narrow data projections and action contracts when additional domain
  operations are needed; the catalog is not a publication of every HTTP endpoint.
  Some legacy nested maps and outputs remain flexible JSON contracts.
- Existing document row sources and Work context resolvers remain supported
  compatibility paths. New cross-domain consumers should use publications.
- FirstMeasure normalization currently covers roofing measurements. Exteriors
  and instant-report structures need their own typed mappings. Import repair is
  explicit; no background projection retry or bulk backfill was run.
- Live bindings refresh during explicit evaluation. Automatic downstream
  invalidation and a reconciliation UI for uncertain effects are not implemented.
- Frozen action implementations fail closed after backend artifact changes;
  running archived backend implementations is not supported.
- Configure and validate the full moving-company scope separately, including
  signature-plus-deposit booking, staged bill of lading and final settlement.

Architecture changes have not been deployed. The independent editor development
release remains the deployed baseline and must be preserved by any later release.
