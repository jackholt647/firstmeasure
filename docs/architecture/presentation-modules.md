# Presentation modules

A presentation is the third kind of document module, beside documents and
workflows. A workflow (internal: measure, build line items, terms, review)
produces a presentation (a slideshow shown in person or sent to the customer,
where either side picks options and the price follows), which produces the
contract document the customer signs. The presentation is optional.

This is not the per-document `customer_presentation` display setting in
`public/v1/documents/presentation.ts`. Code for this feature is named
`presentation-*` under `public/v1/documents/modules/`.

## Decision: a module kind, bridged to the legacy document at both ends

The Docs tab's roofing proposal is one legacy document with a `workflow_ref`;
its steps write `params.*` and signing reads the same params. Rebuilding that
as chained module instances would mean rewriting the workflow and the signing
inputs. A bridge with no module identity would leave presentations outside the
shared contract (inputs, exports, code, layout, versions).

So a presentation **definition and instance are module records**
(`document_modules`, `document_module_versions`, `document_module_instances`,
kind `presentation`), and the two ends of the chain go through the documents
domain:

- **in**: creating a presentation captures the draft document's params (or a
  workflow module instance's export) into the instance inputs;
- **out**: producing the contract writes the chosen lines back onto a draft
  through `patchDocumentInstance`, then the existing send and signing run.

The roofing workflow's steps are unchanged. It gains one data field naming its
presentation.

## Representation

`ModuleDefinition` with `kind: "presentation"`:

- `renderer`: any valid DocModel. The owner's presentations are paged decks
  (`kind: "document"`, custom paper `{ w_pt, h_pt }`); a fluid `view` is also
  accepted. Structure is checked by the shared validator. Editor-owned fields
  (`page.transition`, `page.steps`, `page.notes`, `props.animations`,
  `props.part`, `metadata.presentation`) are not inspected and round-trip.
- `inputSchema`, `outputSchema`, `exports`: as for every module. Writable
  exports address `/inputs/...`.
- `source`: optional code. Without it the host prices and resolves the layout.
- `bindings`: must be empty (see Left out).
- `presentation`: `{ pricing: "scope" | "none", inputs, customer, contract }`.
  `inputs` declares the interactive inputs. Each names a writable export and has
  a kind (`scope_selections`, `variant`, `value`) and an audience
  (`internal`, `customer`). `customer.exports` is the read allowlist for token
  access. `customer.contract` is `review` (default) or `direct`.

`scopePresentationDefinition()` builds the standard contract: inputs use the
document param names (`scope_items`, `payment_schedule`, `tax_percent`,
`pricing_adjustments`, `measurements`, `customer`, `project`), choices live at
`/inputs/choices/{selections,variants}`, and `scope_items` is a private export.

## Evaluation

Each change is one request: check revision, validate the pick, re-evaluate,
save with a compare-and-set, write a receipt. Nothing is required up front;
present values must match their schemas and absent required ones are reported
as `missing`.

1. **Host pricing** (`pricing: "scope"`). Selections are applied with the
   documents write-through (`applyScopeSelections`) and priced with
   `documentCheckoutPricing`, the same call the payment path trusts. Each
   alternative is repriced whole to give an exact `delta_cents`. The payment
   schedule resolves on the basis signing uses for receivables.
2. **Code**, if any, runs evaluate-only in the module sandbox with a broker that
   refuses every read and action. It adds outputs; it cannot replace pricing.
3. **Layout** resolves once per audience against declared exports only, so a
   slide cannot bind private state. Widget data for `doc.price_display`,
   `doc.choice_selection` and `doc.selection_review` comes from the document
   widget registry, keyed by node id.

Variant picks had no server writer. `applyVariantChoices` mirrors
`applyVariants` in `doc-workflow` (offered values, exclusions, unit price from
`variant_base_price`) and must change with it.

## State, permissions, evidence

State is the instance: captured inputs, last outputs, both resolved layouts,
and `presentation` metadata (source, shares, contract, submission).

| Actor | Authority | Can |
| --- | --- | --- |
| Staff, read | `view_projects` | read state and the change log |
| Staff, write | `manage_documents`, `manage_projects` or `manage_company_settings` | create, change, refresh, produce the contract |
| Staff, issue | `issue_documents` | share, send the contract |
| Link holder | the share's public link | read customer exports; with `choose`, change customer inputs and submit |

Shares use `public-links` (random token, SHA-256 at rest, expiry, revocation,
allowed actions). The token is returned once to the sender. A customer never
receives raw inputs, private exports, shares, source or module identity, and
priced rows are an allowlisted projection without costs.

Every accepted change writes a `document_module_executions` record: actor
(user id, or share id with IP and user agent), the change, and for a selection
the set that was presented with its prices and what was chosen. The actor is
derived by the server, never taken from the request.

## What freezes when

- **Choosing** changes only the presentation. The draft is untouched.
- **Produce contract** writes the chosen lines (customer-selectability removed),
  mapped value inputs and `presented_choices` onto the draft, after checking
  that the document's own pricing totals what the presentation shows. It can be
  repeated while the document is a draft.
- **Send** issues the document as today (snapshot, signing package) and freezes
  the presentation. The snapshot carries `presented_choices`.
- **Signature** is unchanged: the first receipt locks the contract, and
  receivables use the accepted basis. A voided contract reopens its presentation.

The generic module routes refuse presentation instances, so choices cannot
bypass validation, evidence or the freeze.

## Workflow hook

A workflow definition may declare
`completion: { offers, default?, presentation?: { module_id, version? }, share_presentation_with_estimate }`
with offers from `present`, `send_estimate`, `send_presentation`. Publishing
validates the shape and that the module exists. A template can name one in
`metadata.presentation`. Sending the estimate directly needs nothing new.

## Left out

- Bindings on presentations. Token holders evaluate them, and anonymous
  evaluation has no data or action access. Data arrives by capture.
- A presentation produced by a presentation, and proposal option slots
  (`proposal_options`).
- SMS delivery of a share, and resending a share (create a new one).
- A UI, and the portal page a shared link lands on
  (`PRESENTATION_PORTAL_PATH`).
- In-person signing without issuing: the signature widget signs the sent
  document through its invitation, as everywhere else.

Tests: `tests/publication-presentations.test.ts` (runs in `npm run test:publication`).
