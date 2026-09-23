> Completion continuation: see [implementation and verification](implementation-completion.md)
> and [the current architecture guide](publication-architecture.md). The agreement
> below preserves the original discussion; later completion evidence supersedes
> its checkpoint status.

# Data and action architecture continuity

> **Authorization update:** The full-conversation continuation subsequently
> authorized implementation of all three layers: data, actions/functions and
> customizable document/scope code, with shared version binding. Core action/data
> infrastructure comes first, then all relevant app integrations and specialized
> runtimes. The naming-only rename blocker does not prevent implementation in
> the actual canonical `FirstMeasure` directory. No automatic architecture
> deployment or production change is authorized. Audit-only wording below
> records the earlier decision state and is superseded by this update.


Current implementation: shared publication contracts, providers, domain actions,
versioned bindings and document/scope code runtimes are implemented locally.
See [the implementation guide](publication-architecture.md) for entry points,
verification and coverage limits. This is not a claim that every legacy endpoint
has migrated, or that the complete moving-company workflow has been configured.
The original audit request below is retained as historical context.
The canonical source is described in [the checkout record](../canonical-checkout.md).

## Conversation and next owner

- Original discussion: [Scope, Documents, and Pricing](codex://threads/01a0cc68-dfb7-7aa2-936e-168a21b7344c).
- Full-conversation continuation: [FirstMate Platform architecture](codex://threads/01a0ccc6-5e6f-7e91-88f1-dad5d8d45795).
- Consolidation execution: [Audit FirstMeasure data and action architecture](codex://threads/01a0cca7-497b-7313-83e2-72e897117846).

The fork carries completed conversation history; the originating task supplies
active-turn updates separately. Continue interactive architecture discussion in
that continuation, not additional tasks. This document preserves decisions and
acceptance scenarios; it does not replace the full conversation.

The initial audit inspected the wrong FirstMate 2.0 checkout. The integrated
platform actually combines FirstMeasure with FirstMate 2.0 Polish Pass, followed
by exterior and mobile changes. All prior implementation findings must be
revalidated against the canonical integrated source. Consolidation, development
deployment and directory rename precede the architecture audit. Future work
primarily on the development host is a user intention, not authorization to
relocate infrastructure or edit a live release directory.

## Objective and boundaries

Audit the current integrated codebase, then propose a phased implementation
plan for standardized data and function/action publication across every app:
photos/media, money/accounting, canvassing, field crew, documents, scopes and the
rest of the actual inventory. Existing uniform action exposure was presumed,
not proven. Establish coverage denominators and per-app evidence. Assess shared
interfaces, documentation, scaffolding and CI so future developers and language
models expand the same architecture consistently. Identify execution runtimes
beyond documents and scopes. Broad implementation awaits the user's decision.

## Three layers and shared binding infrastructure

1. Published **data** with discoverable schemas and instance identities.
2. Customizable **code** that consumes data and calls actions.
3. Exported **functions/actions** with discoverable typed contracts.

A shared **Versioned Binding Service** is cross-cutting infrastructure, separate
from specialized document/scope execution and rendering. Consumers select
policies; the shared service resolves, captures, retains, authorizes and tracks
version identities. The proposal that a specialized runtime should own freezing
was rejected.

Store only **live** or **frozen** policies at the smallest meaningful binding
unit: field, row, dataset, module or function. A group may contain both, but
`mixed` is not a third stored policy. Support group defaults, overrides and
coherent capture of related values. Define live refresh/evaluation, dependency
invalidation, cycles, missing/error behavior and side-effect boundaries.

## Data publication

Publish schema, type, units, access rules and discovery metadata alongside
instance ID/revision. Support nested objects and arrays. Missing, pending,
denied and error states must remain distinct from zero.

Generic project datasets have name, type, schema version, revision, ownership
and provenance. Measurement datasets retain specialized editor/front-end
semantics and FirstMeasure/report/PDF integration. FirstMeasure is one producer
alongside manual entry and other providers. Inventory/cube sheets may use the
generic mechanism or later specialization; not all industries or data are
measurements. Support multiple datasets with explicit roles, defaults and
selection. Avoid two independently mutable authoritative copies. Geometry and
PDF artifacts may remain linked in their original stores.

Project, customer, organization, global, pricebook, document, workflow and scope
data can participate. Data objects are persisted records, often JSON; behavior
is code implementing shared interfaces. A generic provider with registered type
schemas and special handlers is sufficient; no separate service/class per
record is required. Ownership, authorization and version policy are distinct.
Apps and services can publish data and actions; publication is not tied to UI.

## DocumentModule and execution

**DocumentModule** is the common base/interface for separate **Document** and
**DocumentWorkflow** instance subtypes. The user explicitly rejected two views
of one shared instance. Modules declare inputs, private state, published outputs
with read/write/private permissions, customizable raw code/formulas and rendering
widgets. Reuse existing document builders where appropriate. Sandbox and code
runtime design remains open; hardcoded action registration alone is inadequate.

Example: a CubeSheet Document publishes inventory arrays and totals. A separate
EstimateWorkflow imports it, calculates hours/rates, allows authorized human
overrides and requires manual hours if the cube sheet is absent. It generates a
separate EstimateDocument that imports workflow outputs and publishes its own
values. A BillOfLading can import the cube sheet or estimate independently.
The shared interface alone does not link instances: runtime resolution must
handle typed instance bindings, permissions, code, lifecycle and rendering.
Scopes orchestrate apps, actions and document modules and can themselves publish
data. Local overrides are distinct from writes back to the producer.

## ActionRegistry, context and effects

Discover typed inputs/outputs, permissions, targets and versions. Distinguish
pure calculations from mutating/external actions. Validate permissions against
the actual target at invocation. Organization-configurable behavior remains
inside platform authorization boundaries. Project/work/organization/global
context is explicit; project scope does not imply privilege inheritance.
Authorized reads from higher-level sources are allowed; upstream writes require
explicit authorized actions. Specify sandbox limits, retries, idempotency,
audit records and receipts for effects. Pinning a function freezes its
implementation version, not historical results or the external world. Never
replay a payment merely to reconstruct or render history.

## Frozen references and accepted artifacts

A frozen reference belongs to its **consumer**. Producers support consistent
capture/revision reads but do not choose consumer policy. Preserve source type,
ID, revision/version, selected fields and values, or a retained resolvable
immutable snapshot, together with provenance. A consumer may explicitly
re-export a frozen CubeSheet reference; do not flatten it into anonymous values.
Snapshot storage may be shared. Re-export cannot bypass source access rules.

Retain schema, code/module/formula/function versions and calculation results,
render/evidence as needed to reproduce the accepted estimate. Signature binds
the exact content accepted; do not refetch changed source values when signing.
Live/frozen policy is independent of permissions. Editable local overrides must
not silently mutate upstream data.

## Moving-service acceptance scenario

Phone intake can lead to a branch quote or in-person appointment. Inventory cube
sheet feeds an hourly/nonbinding-hours estimate calculation. Estimate portal
signature **and deposit** gate booking. Then pre-move confirmation, staged bill
of lading at start/finish, actual hours and final charges accounting for the
deposit, and final payment/closeout. Preserve the original signed estimate rather
than overwrite it. Audit actual stage, signature, payment and idempotency gates;
this sequence is the desired acceptance scenario, not verified current behavior.

## Evidence still required and next deliverable

Old-checkout leads to revalidate: separate work action and context registries;
row-oriented document sources for measurements/pricebooks; shared visual-editor
model with separate workflow rendering; no then-confirmed general module-export
or raw-code runtime. These are search leads, not universal current facts.

Produce a source-cited audit and implementation plan covering:

- Complete app/service inventory with current/partial/missing coverage and
  explicit denominators; distinguish UI app registration from action publication.
- Action discovery, invocation authorization and scope work-context exposure.
- Data adapters, read/write ownership, schemas, revisions and snapshot retention.
- Document/workflow/scope behavior and other execution runtimes.
- Binding policy, accepted-artifact capture, effects and permission boundaries.
- Documentation, starter scaffolds, contract tests and CI enforcement.
- Concrete shared component owners, migration order, phased acceptance criteria,
  open design decisions and confidence limits.

Then obtain the user's implementation direction. Do not silently turn the audit
into architecture implementation or provider/customer mutations.
