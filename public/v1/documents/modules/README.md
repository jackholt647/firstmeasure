# Document modules

Documents and workflows have the same programmable contract and **separate
instance identities**. Existing document/workflow records keep their legacy
behavior unless a user explicitly materializes a module result into a draft.

## Authoring

Doc Studio → **Document modules** opens the authoring panel for organizations
with advanced definition editing. Publish input/output/private-state JSON
schemas, declared exports, data/action bindings, JavaScript, and an optional
DocModel renderer. Each published definition is immutable and content-addressed;
instances retain that version even after a newer definition is published.

The JavaScript body receives `inputs`, `state`, and `api`:

```js
const cube = await api.data.read('cube');
const hours = inputs.overrideHours ??
  (cube ? cube.volume / 100 : inputs.manualHours);
if (hours == null) throw new Error('Manual hours are required');
return { outputs: { hours, total: hours * inputs.rate } };
```

Optional missing data returns null only when its binding sets `required:false`.
Denied, pending, and failed reads do not masquerade as missing values.
`api.actions.invoke(name,input)` uses a declared action binding. Evaluation may
call pure/read operations; effects require an explicit command execution.
`api.now` is captured execution time. Ambient date/randomness and arbitrary
module imports are unavailable.

Export paths start at `/inputs` or `/outputs`. Exports are `read`, `write`, or
`private`; writable paths must address input fields. A caller still needs
instance-write permission and the current revision. Public exports cannot
overlap private paths. Private state is never returned by the instance API.

## API and integration

The Fastify plugin `registerDocumentModuleRoutes` mounts at
`/v1/document-modules`. Organization routes are:

- `GET/POST /organizations/:orgId/modules`: list/publish definitions.
- `GET /organizations/:orgId/modules/:moduleId?version=...`: exact definition.
- `GET/POST /organizations/:orgId/instances`: list/create independent instances.
- `GET/PATCH /organizations/:orgId/instances/:instanceId`: view/update inputs.
- `POST .../evaluate` or `.../command`: execute with `expectedRevision`;
  commands also require `idempotencyKey`.
- `POST .../freeze`: retain the evaluated artifact without rereading sources.
- `GET/PATCH .../exports/:exportName`: read/write a declared export.
- `POST .../generate`: create a separate document instance bound to a workflow
  export. Supply document `moduleId`, `bindingName`, `exportName`, `policy`,
  and any required target inputs.
- `POST .../document`: materialize the evaluated view into a new ordinary
  document, or explicitly attach to a same-project draft using `documentId`
  and `expectedDocumentRevision`.

Data consumers use provider `document-modules`, export `value`, target ID equal
to the instance ID, and `args.exportName`. Discovery metadata describes this
dynamic envelope; the module definition describes and validates the actual
field schema. Authorization checks field visibility even on frozen replay.

The action `document-modules.export.write@1` accepts `exportName`, `value`, and
`expectedRevision`, targeting the module instance. It validates writable input
exports, uses the shared action receipt, and never evaluates another module.
System consumers need only the published `document-modules.value` or
`document-modules.export.write` grant, not internal service operations.

`createBindingSession` is shared infrastructure, not part of the interpreter.
Its manifest is retained with each execution. `configureModuleBroker` exists
for trusted host integration/testing; callers must not configure it from HTTP.
Scope consumers may reuse `runModuleCode` with a separately authorized broker.

## Execution and persistence

QuickJS WebAssembly runs in a fresh Node worker/runtime per invocation. The
normal build exposes asynchronous capabilities through guest promises. Guest
code receives JSON only, no Node process/filesystem/network objects. Heap,
stack, execution deadline, source/output size, and capability count are bounded.
The parent deadline terminates unresolved guest promises as well as loops.

Instance CAS claims and create-only execution receipts prevent concurrent
commands from executing twice. Idempotency keys bind to the original instance
revision/mode. A failed or interrupted command receipt is inspected rather
than automatically replayed; external effects cannot be rolled back by killing
a worker. Action receipts remain authoritative for such effects.

Module result views pass shared DocModel validation and active-content checks.
Materialization stores the resolved legacy render payload, including widget
data and source values, so later source changes do not alter accepted content.
It does not implicitly refresh an existing signed document.
Creating a portal document is idempotent for the instance and evaluated
execution. Repeated requests return its existing artifact, including after
signing. Public exports are copied to the document's explicit published-param
allowlist. Signing retains those execution values independently of later
module edits; it does not silently freeze a newer module revision.

The current implementation pins `quickjs-emscripten@0.32.0` in definitions and
execution evidence. Engine upgrades require explicit compatibility handling.
No assumption is made that Node's `vm` is a tenant-code security boundary.

## Validation

Run `node --experimental-sqlite --import tsx --test
tests/publication-modules-runtime.test.ts tests/publication-modules-service.test.ts`
from `public/v1`. Tests exercise inventory-to-workflow-to-independent-document,
manual fallback/override, frozen imports, private/writable exports, denied
effects, concurrent command replay, resource termination, and explicit draft
materialization. Sandbox tests also run on Node 22.

Retained render artifacts recheck current capability visibility. Only signature,
QR/delivery and payment-status widgets receive lifecycle overlays against the
captured inputs; price and other source widgets stay frozen. Regression tests
verify new signature evidence and delivery tokens without refreshing prices.
