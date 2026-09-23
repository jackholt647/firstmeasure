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
`/v1/document-modules/organizations/:orgId`; Both visual builders expose **Data & behavior** for schemas, code, exports and
bindings. Publishing an enabled design saves an immutable module version alongside
the native design. The project Documents **Workflows** control manages independent
instances. The scope builder exposes the same catalog and editor for configured
plan/task triggers. The advanced module editor remains available for full JSON
editing. Existing saved artifacts retain their captured result.

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

## Execution and dependency lifecycle

Instance bindings resolve `$organization`, `$project` and `$branch` target tokens
at creation. Arbitrary arguments and source strings are not interpolated.
`codePolicy` defaults to `frozen` (pin the published module version); `live` opts
into later compatible published versions. The accepted execution records the
actual code version, schemas, source revisions, values and action receipts.
Failed upgrades retain the last accepted version/result.

GET freshness and provider reads never execute code or write domain records.
Explicit evaluation refreshes upstream live module dependencies in order, with
cycle detection and a 64-module graph bound. Scope triggers do the same before
consuming module outputs. The visible instance editor checks every ten seconds
and refreshes stale live drafts while there are no unsaved edits; it stops when
closed, hidden, frozen or awaiting command review. There is no continuously
running organization-wide invalidation worker. API consumers use the freshness
and refresh endpoints or published refresh action at their execution boundary.

Data and read/compute action evidence rechecks current permissions, including
transitive retained module and scope outputs. Frozen values do not retain an
expired access grant. Effects require command mode; `api.mode` allows a program
to distinguish calculation from its explicitly requested command. Nested module
execution is limited to eight levels in addition to each sandbox's own limits.

Scope definitions stamp their author on the server. At execution, the program
must match that immutable template version and the author's current membership,
application access and permissions. Client metadata cannot choose an authority.
Republish older custom-code scopes lacking that stamp before running them.

A command that may have performed an effect retains an uncertain receipt and
blocks subsequent edits/executions. An administrator can inspect the command,
verify effects in the owning app, and record a review through the instance UI or
`POST /instances/:id/reconcile`. This records a note and author, retains the last
accepted result, and unlocks the instance; it never replays the failed command
or fabricates a successful output. Process-crash claims that remain actively
running require operational investigation before recovery.

Published `document-modules.*` actions cover instance creation, refresh, explicit
commands, freezing, writable exports, generation from workflow exports and portal
document materialization. Scopes can compose these through ordinary declared
action bindings. Materialization never executes code and signed artifacts never
silently adopt a new result.

## Verification and boundaries — September 23, 2026

The completion implementation passes TypeScript checking/build, 44 publication
tests, the separately run PostgreSQL concurrency test, 71 affected domain
regressions, and headless browser checks for authoring, binding selection,
instance creation/save/refresh/freeze and scope version preservation. See
[the completion record](implementation-completion.md) and the development release
record for the final deployment identity and runtime verification.

The shared registry is the extension contract for all current app owners, not a
raw export of every HTTP endpoint. Existing dedicated payment, signature,
credential, upload and administration flows keep their own authorization and
protocols. The operation inventory in [action-publication.md](action-publication.md)
records adapters and remaining endpoint migrations. Some legacy nested maps and
results intentionally retain flexible JSON schemas. Existing Work context and
document row-source syntax remain compatibility paths.

Measurement publication normalizes roof XML, saved exterior report totals and
instant roof-area estimates with explicit units and source attribution. It does
not rebuild geometry or fabricate unavailable dimensions. Historical import is
explicit; no bulk data backfill or geometry migration is part of this release.

Historical executable functions are not required. Accepted results and evidence
are retained; an unavailable pinned action implementation fails rather than
substituting another implementation. No moving-company product is included.
