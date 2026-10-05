# Document-owned materials calculus

## Contract

An estimating workflow and its generated customer documents are independent
DocumentModule instances. A document definition declares typed deliverables.
A `materials_calculus` deliverable is a versioned calculation specification,
not an order and not an instruction inferred from document prose. Documents may
produce any number of independent material sets. Alternatives are dormant until
the corresponding document is accepted; calculations can condition their output
on the document's captured selections. Manual sets use the same ledger.

Each specification declares a stable key, title, bounded pure JavaScript, named
data bindings, manual-input schema and defaults. The document's captured public
parameters and non-signature outputs are available as `inputs.document`.
Project/catalog data uses the existing publication bindings with live/frozen
policy and fresh authorization. No network, filesystem or action invocation is
available to a calculus. Required missing data fails explicitly; optional data
may be null and any assumption must be returned as a warning. Output lines have
stable recipe keys, product identity, quantity and unit, optional package coverage,
estimated cost, structure/delivery grouping and a human-readable explanation.

The accepted signing package captures the deliverable specification and document
values. The signature outbox publishes its artifacts idempotently. Publication
does not evaluate code, purchase materials, or require the signer to possess
staff material permissions. Invalid deliverables are rejected before issuance.
Later template/catalog edits do not rewrite the accepted specification.

## Persistence and concurrency

The project materials ledger stores independent sets, accepted evaluation
revisions, immutable amendments, orders, delivery groups and command receipts.
Each mutation uses an exact ledger revision and a caller-generated idempotency
key. The entire state transition and receipt commit in one storage CAS. Repeating
the same request returns the saved outcome; changing a payload under the same key
fails. Concurrent edits produce a conflict, never a partial removal/addition.
Reads never evaluate, initialize, refresh or otherwise mutate domain data.

Every evaluation retains its definition hash, data-binding evidence, manual
inputs, raw output and timestamp. Result lines preserve stable per-set keys;
duplicates across sets are intentional. Results are proposals until explicitly
applied as the initial requirement or as a reviewed revision. Failure retains
the last accepted requirements. Subsequent evaluation cannot silently erase amendments; replacing requirements
always requires an explicit review and apply operation.

## Amendments and replacement

An amendment names one target set and its exact effective revision. It removes
specific active line identities and adds complete new lines. A replacement link
joins an added line to a removed line for display and allocation continuity.
The UI edits a copy and presents the resulting before/after diff. Whole-set
replacement is an amendment removing all active lines and adding a complete new
set. Historical lines and evidence remain immutable. An amendment can itself be
a document deliverable; acceptance publishes a pending amendment for review,
with stale targets visibly blocked rather than silently rebased.

## Purchasing and fulfillment

Requirements, commitments and receipts are separate quantities. Orders snapshot
exact set/line references, product, purchasing units and price. Quantities must
be positive and cannot exceed uncommitted requirements. Reductions after ordering
show excess commitments; removing a requirement never cancels an order. Linked
replacements carry allocation only when product identity and ordering unit match.
Product substitutions expose the old commitment as excess instead of counting it
toward a different product. Partial cancellations and receipts are explicit ledger
events. Received quantities cannot be cancelled; returns have their own event.

Delivery groups reference order lines from any number of sets without merging
requirements or losing duplicates. Dates do not imply fulfillment. Supplier
submission is a distinct external capability: internal manual commitments and
delivery tracking must never claim an API order was sent. Credentials, supplier
availability and supplier acknowledgement are outside pure calculation.

## Interface and permissions

Document authoring exposes deliverables beside data/behavior, including examples
and input/source contracts. Materials displays sets by source, readiness,
requirements, calculation evidence, revisions and pending amendments. Manual
creation, input editing, evaluation preview, amendment review, purchasing and
delivery grouping are explicit user actions. Unsaved edits survive errors.

The project entry point is the original Scope workspace and its color-coded
material-section renderer, inline fields and price-book controls. The separate
Document materials viewer was removed after user rejection on October 5. The
left library retains roof, aerial, measurements and list views without a duplicate
Materials selector. On narrow screens these widgets stack above the lists.

Integration gap: document ledger sets are not yet adapted into the original
material-list API/renderer. Their backend data is preserved. Future integration
must use that renderer and its editing/ordering workflow, with accepted source
context on the left; it must not add a separate replacement material list UI.
Formula source and generator configuration belong in document authoring.
Opening or refreshing Scope is read-only.

Project identity and organization are server-authorized; cross-project amendment,
order and delivery references are rejected. Source evidence is reauthorized on
reads. Publication actions reuse the same service as HTTP/UI operations.

## Acceptance coverage

- Workflow produces separate alternative documents; only accepted deliverables
  authorize material sets; duplicate signature delivery creates no duplicates.
- Two 20-bundle lines remain separate through calculations, ordering and one
  shared delivery; partial receipt keeps their allocations separate.
- 10 to 15 bundles is an atomic remove/add; an existing 10-bundle commitment
  leaves 5 outstanding; 10 to 8 exposes 2 excess.
- Missing inputs, malformed output, negative/non-finite quantities, unsafe code,
  stale revisions, reused request keys and invalid target references fail clearly.
- Package rounding is applied per line; no aggregation changes set quantities.
- Code/input versions and failed evaluations cannot rewrite accepted history.
- Revoked permissions and cross-tenant/project references do not expose data.
- Development rollout preserves unrelated source and records exact release,
  hosted checks and rollback. Existing document compatibility is not required.

## Authoring an organization pipeline

1. Build the estimator workflow with inputs for the product/package, scope,
   measurements and pricing. Each generated alternative is a separate customer
   document. The existing module materialization action creates those documents.
2. In the customer document designer, open Data & behavior and Materials
   deliverables. The roof example consumes accepted `squares`, `waste` and
   `product` parameters; rename those references to match the document schema.
   Include accessory rules explicitly. The example is deliberately shingles-only.
3. Add named read bindings to each recipe. `materials-inputs.products` has an
   organization target; `materials-inputs.measurements` has a project target.
   Use `$organization` and `$project` placeholders in reusable definitions.
   The products export carries physical package coverage, not a supplier quote.
   The measurement export uses the project's selected dataset and fails when none
   is selected. Choose live or frozen binding policy according to the contract.
4. Issue and sign the generated document. Its accepted source, public values and
   material recipe are retained together. The signing outbox creates pending sets.
5. In Materials, calculate, inspect warnings/evidence, and apply a preview. Record
   orders against the resulting independent lines and group their deliveries.
   Recalculation is explicitly reviewed; it never silently changes an order.

For a package estimate, the document may expose only a package identifier and
contract amount. The recipe maps that identifier to products and obtains physical
quantities from measurements. Customer selling price, estimated material cost and
actual order price remain different values. A discount does not change physical
quantities unless the recipe explicitly changes scope.

## Initial operating limits

The ledger is an atomic project document capped at 16 MiB; calculation output is
limited to 1,000 lines and a document to 40 deliverables. Signed artifacts are
immutable; editing a published recipe requires a new document or a new manual
set. One order allocation belongs to one delivery group, with partial receipts;
split an intended purchase into separate order allocations for separate scheduled
deliveries. Supplier transmission is not configured: the order screen records
commitments already arranged with a supplier. API integrations can use the same
references and receipts when a supplier connector is added.
