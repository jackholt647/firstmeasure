# Document Engine — Editing Tiers & Workflow Layer Specification

Status: **draft for review** (2026-07-26)
Builds on: `docs/document-engine-spec.md`, `docs/document-engine-contracts.md`, and the shipped engine (DocModel, renderer, widgets, editor profiles, templates/instances/snapshots, work-engine integration).

---

## 1. The model in one paragraph

One stored format (DocModel), three editing experiences over it, plus a workflow
layer beside it. **Visual** (exists today: the designer profile — Canva) edits
nodes as boxes. **Doc** (new) edits the same nodes as a word processor — text
flows across pages, styles are named and applied by reference, objects anchor
to text or page; the user never sees a "text box" unless they ask. **Workflow**
(new) is not an editor of the document at all — it is a versioned, data-driven
intake definition (steps → questions → params) bound to the same data contract
the template binds to; filling the workflow *produces* the document. The
customer portal runs the same workflow definitions with a different skin. The
complexity budget: powerful primitives + excellent seeded templates/workflows
authored by us; the org user sees "pick a template, answer the questions,
preview, send."

```
                       ┌───────────────── data contract (params/outputs) ─────────────────┐
                       │                                                                   │
  Workflow definition ─┤ writes params            reads params ├─ Document template (DocModel)
  (steps, questions,   │                                        │  (pages, flows, components,
   conditions, sources)│         outputs (sig/pay/choices)      │   repeaters, widgets)
                       └───────────────◄───────────────────────►┘
        ▲ runs in: internal fill UI, customer portal wizard, (future) mobile
        ▲ edited in: Workflow Editor (settings-level, "us" audience)
```

## 2. Why this decomposition is right

- The user-visible tiers ("Canva / Google Docs / quote builder") are NOT three
  formats or three engines. Tier 1 and 2 are **two projections of the same
  DocModel document**; tier 3 is **a workflow asset + a template**, where the
  "editor" is mostly the workflow runtime plus the preview. This keeps the
  fungible, data-driven substrate the engine was built for — anything editable
  in Doc mode is by definition editable in Visual mode, and everything renders
  everywhere (portal, PDF, print) through the one renderer.
- The existing editor profile system already gates features per surface; the
  new tiers slot in as **modes** (different interaction surfaces), not new
  editors. One command bus, one undo model, one policy enforcement point.
- The existing scope configurator, lead-intake forms, and the params form are
  all *proto-workflows*. The workflow asset unifies them into one definition
  format with one runtime, instead of a fourth bespoke form system.

## 3. DocModel additions (schema_version 2 — additive, no breaking changes)

### 3.1 Flow chains (the word-processor backbone)

A **flow chain** is a sequence of flow frames that text/content pours through,
across pages (and columns).

```jsonc
// On a frame node:
"props": { "flow": { ... }, "chain": { "id": "body", "index": 0 } }

// On the document:
"chains": {
  "body": {
    "auto_pages": true,          // overflow appends pages cloned from page_defaults
    "page_defaults": { "role": "body", "margins_pt": {top:72,right:72,bottom:72,left:72}, "columns": 1, "column_gap_pt": 24 },
    "keep_rules": { "widow_lines": 2, "orphan_lines": 2 }
  }
}
```

- The **Doc editor's page is just a page whose only child is a chained flow
  frame sized to the margins** ("a big rectangle that fills most of the screen
  with some sort of margin" — exactly). Columns = N chained frames per page.
- Content of a chain is a list of **blocks** (paragraphs, headings, lists,
  tables, repeaters, block widgets, images with wrap). Blocks are ordinary
  DocModel nodes; the chain lays them out and splits them across frames.
- Renderer: pagination generalizes the existing `overflow:"paginate"` logic —
  same staging-measure-split machinery, extended to (a) split at line level
  inside paragraphs (with widow/orphan rules), (b) chain-aware continuation
  (next frame in chain, else clone page when `auto_pages`), (c) columns.
  Line-level splitting is the main new renderer work.
- Visual mode shows chained frames as linked boxes (link glyphs on the frame
  chrome, like InDesign) — power users can reflow a document into custom
  shapes; Doc-mode users never see it.

### 3.2 Anchoring

`node.anchor`: `"page"` (today's absolute), `"flow"` (block in a chain — the
default in Doc mode), `"inline"` (in the run stream: checkbox, tag, small
image), or `{"to_block": blockId, offset}` (floats that travel with a
paragraph, text wraps via CSS float/shape-outside). Doc mode inserts objects
as flow/inline/floating; dragging a floating object re-anchors it to the
nearest block. Visual mode can flip any node's anchor in the inspector.

### 3.3 Named styles applied by reference

Today runs carry inline style. Add **style refs**: `block.style_ref:
"body" | "h1" | "quote_total" | ...` resolving through doc `styles{}` →
template → theme `type_styles`. Editing a named style restyles every user of
it (Doc mode's style dropdown; Visual mode's "update style from selection").
Inline overrides remain as deltas on top. This is also what makes "our
templates look great by default" enforceable — seeded templates use refs
everywhere, so org rebranding = editing a handful of styles.

### 3.4 Components (the "line item is from a template" mechanic)

```jsonc
"components": {
  "li_row": {
    "params": { "item": { "type": "pricebook_line" } },   // instance inputs
    "root": { /* DocModel subtree: name runs bound to {{item.name}}, qty, price, optional photo */ },
    "variants": { "compact": {...}, "with_photo": {...} } // optional
  }
}
// Instantiation:
{ "type": "component_ref", "component": "li_row", "input": { "item": "{{row}}" } }
```

- Component defs live on the document, on the template, or in an **org
  component library** (new collection, versioned like themes) — resolution
  order doc → template → library. Seeded libraries ship ours.
- **Repeaters** replace data-table widgets for layout-driven lists:

```jsonc
{ "type": "repeater",
  "props": {
    "source": "{{params.scope_items}}",       // any list expression or named data source (§5)
    "component": "li_row", "as": "row",
    "layout": { "direction": "column", "columns": 1, "gap_pt": 6 },
    "break_rules": { "keep_with_next": ["group_header"], "min_rows_per_segment": 2, "repeat_header": true },
    "empty_state": "component_or_text"
  } }
```

  A repeater is a block in a flow chain (so it page-breaks through the chain
  machinery) or an absolute frame (Visual placement). Selecting an instance in
  Visual mode shows "Edit component" → opens the def in place, edits propagate
  to all instances live (this is the user's restyle-one-restyle-all flow).
  Resizing an instance edits the def (or forks a variant — explicit choice).
- `doc.line_items` (widget) remains for v1 compatibility but the seeded
  templates migrate to repeater + `li_row` components; widgets stay the tool
  for *interactive/logic-heavy* elements (signature, payment, QR, video).
  Rule of thumb: **widgets do behavior, components do layout.**

### 3.5 Inline bindable controls

Small typed elements insertable in BOTH modes, bindable to contract fields or
free-standing: `checkbox`, `pill/tag`, `field_text` (inline variable),
`date`, `signature_line`. Stored as inline-anchored widget nodes
(`doc.checkbox@1` etc. — new small widgets) with `props.binding:
"params.include_gutters" | "outputs.form_values.x" | null`. Unbound = static
decoration; bound = reads/writes the contract (interactive surfaces) and
renders the value (static surfaces). This is "document elements tieable to a
workflow in a generally flexible way."

## 4. Workflows as first-class assets

### 4.1 Definition format (new collection `document_workflows` + versions)

```jsonc
{
  "schema_version": 1,
  "name": "Roofing estimate intake",
  "contract": { "params": {...}, "outputs": {...} },     // same schema family as templates
  "steps": [
    { "id": "st_scope", "title": "What are we doing?",
      "items": [
        { "kind": "piece_picker", "writes": "params.scope_items", "source": "scope_template:roof_replacement" },
        { "kind": "select", "writes": "params.shingle_line", "options_from": "{{pricebook.category('shingles')}}",
          "presentation": { "style": "cards", "images": true } }
      ] },
    { "id": "st_measure", "title": "Measurements",
      "items": [ { "kind": "measurements", "writes": "params.measurements",
                   "fields_from": "scope_items_formulas",     // derive required fields (already built)
                   "prefill": "project.measurements" } ],
      "when": "{{count(params.scope_items[]) > 0}}" },
    { "id": "st_options", "title": "Customer options", "audience": ["internal","customer"],
      "items": [ { "kind": "choice_group", "writes": "outputs.selections", ... } ] },
    { "id": "st_review", "kind": "review", "preview": { "template_ref": "...", "live": true } }
  ],
  "audiences": { "internal": {...}, "customer": { "theme": "portal", "hide_steps": ["st_scope"] } }
}
```

- Item `kind`s are a registry (like widgets/automations): `select`,
  `multi_select`, `text`, `currency`, `measurements`, `media_picker`,
  `piece_picker` (wraps the scope configurator), `choice_group`,
  `line_item_editor`, `signature`, `payment`, `review`. Each kind has one
  renderer used by every surface; the rich param editors already built
  (measurements/payment schedule/photo picker) become item renderers.
- `when` conditions and `writes` paths use the SAME expression language as
  documents. Sources (`options_from`, `prefill`) use it too.
- **Audiences**: one workflow, filtered/staged per audience — internal rep
  fills scope+measurements; the customer-portal wizard gets the options steps
  with the live document preview beside it ("choose options as a workflow, see
  the preview document based on outputs"). Outputs recorded through the
  existing public output endpoints with evidence.

### 4.2 Workflow runtime (one, shared)

`public/libraries/doc-workflow/` — renders a workflow definition as a stepper
(left rail steps, main pane items, optional live preview pane rendering the
bound template via the existing renderer + `/resolve`). Mounts in: the
Documents tab (create/fill flow), the customer portal (portal-skinned), the
studio (test mode). Persistence: workflow state IS the document instance's
params/outputs — no second store; a draft document is a paused workflow.

### 4.3 Workflow editor ("us" tier, settings-level)

In the studio under **Advanced → Workflows**: step list editor, item palette
(from the kind registry), `writes` binding picker driven by the contract,
condition builder (same `{{}}` helper as the widget config panels), audience
toggles, live test-run pane. It edits JSON we could hand-write — the editor is
sugar, which keeps it honest and cheap. Org users normally never open it.

### 4.4 Document types become bundles

`registerDocumentType` gains: `default_workflow_id`, and scope templates
reference bundles: `documents: [{ document_type, template_id?, workflow_id?,
trigger: "node:sign_sales_proposal" | "manual" }]`. The "roofing proposal"
experience = contract + workflow + template set + automations, referenced by
the scope set — matching the intent that scope sets carry the what, documents
carry the how-it-looks, workflows carry the how-it's-asked.

## 5. Named data sources (pull-from-anywhere, declared not coded)

A server-side **source registry** (generalizing widget resolvers):

```ts
registerDocumentSource("materials.order_lines", { params: {order_id}, resolve, shape })
registerDocumentSource("measurements.project", ...)
registerDocumentSource("pricebook.category", ...)
registerDocumentSource("payments.obligations", ...)
```

Usable anywhere an expression is: repeater `source`, workflow `options_from`/
`prefill`, param defaults (`{{source('materials.order_lines', {order_id: ...})}}`
or the sugar `"source": "materials.order_lines"`). Resolved server-side at
/resolve and frozen into snapshots like widget data. This is exactly how the
**purchase order** example works with zero new document code: a `purchase_order`
type whose template has a repeater over `materials.order_lines`, issued by an
automation when an order is placed.

## 6. The three modes, concretely (UX)

**Mode switcher in the editor top bar: Preview | Doc | Visual** (Visual gated
by `documents.designer_profile`; Doc is the default for document-ish types;
fill-style workflow panel replaces "Data" when the instance has a workflow).

- **Preview**: static render, print-true. Default landing for signed/sent.
- **Doc mode** (new surface in `doc-editor`): caret editing in flow chains
  (Enter/Backspace across blocks, selection across pages), style dropdown
  (named styles), toolbar (bold/italic/lists/align), Insert menu (image,
  table, checkbox, page break, repeater/section from the component library,
  widget), margins/page-numbers/header-footer controls (page masters get
  optional `header`/`footer` slots — small theme addition), drag objects with
  anchoring. **No visible frames.** Implementation honesty: pagination on
  idle/commit (~100ms debounce), not per keystroke — Google Docs does the
  same; caret math stays inside one chain's contenteditable projection.
- **Visual mode**: today's designer profile, plus: chain link chrome,
  component instance badges + "Edit component", anchor controls, repeater
  bounds with break-rule inspector.
- **Simple-by-default**: org users land in workflow → preview. "Edit
  document" → Doc mode. "Advanced" reveals Visual. Templates/workflow editing
  live in the studio, workflow editor behind Advanced. Power surfaces
  capability-gated so the default experience is: pick template → answer
  questions → preview → send.

## 7. What this reuses (nothing is thrown away)

| Existing | Becomes |
|---|---|
| Editor profiles/command bus/policy | The mode system's substrate (modes = interaction surfaces over the same bus) |
| `overflow:"paginate"` machinery | Flow-chain pagination core (extended: line splits, chains, columns) |
| Rich param editors (measurements, schedule, photos) | Workflow item renderers |
| Legacy scope configurator bridge | `piece_picker` workflow item (wraps it; later replaced by a native item) |
| Widget registry + resolvers | Splits into widgets (behavior) + sources (data) + components (layout) |
| doc.line_items widget | Seeded templates migrate to repeater + `li_row` component; widget kept for compat |
| Portal choice-group/sign/pay flows | Steps of the customer audience of the workflow |
| Theme system | + named-style refs, header/footer slots |

## 8. Build phases (each shippable, in dependency order)

1. **Styles + anchoring + components/repeaters** (model + renderer + Visual
   mode support; no Doc mode yet). Migrate seeded line items to components.
   Deliverable: restyle-one-restyle-all works in Visual mode; repeaters
   page-break with keep rules.
2. **Flow chains + Doc mode MVP**: body chain, caret editing, styles
   dropdown, insert image/checkbox/page-break, auto-pages, page numbers,
   margins UI. (The renderer line-splitting + the contenteditable projection
   are the two hard engineering items of the whole program — budget
   accordingly; everything else is assembly.)
3. **Workflow asset + runtime (internal)**: definition schema, kind registry,
   stepper UI, document-instance-as-state, `piece_picker` wrapping the legacy
   configurator, live preview pane. New-proposal flow becomes workflow-first.
4. **Portal audience**: portal-skinned runtime, options/sign/pay as steps,
   live preview; replaces the portal's bespoke choice-group UI.
5. **Workflow editor + sources**: studio Advanced editor; source registry with
   materials/measurements/pricebook/payments sources; purchase-order seeded
   bundle as the proof.
6. **Polish tier**: org component library UI, style manager, header/footer
   editor, column layouts.

## 9. Open decisions (owner input wanted)

1. **Doc-mode fidelity bar**: is "Docs-like for our templates" enough for v1
   (no tables-in-tables, no track changes, no comments), with tables and
   floats-with-wrap in v1 and the exotic stuff never? (Recommended: yes.)
2. **Component fork semantics**: when a user tweaks ONE instance (e.g. widens
   one line item), default to "edit the template for all" with an explicit
   "detach this instance" escape hatch, or the reverse? (Recommended: edit-all
   by default — matches the user's stated flow — with detach as the escape.)
3. **Workflow state visibility**: do internal reps see/redo customer-audience
   steps (impersonation view), and can a customer resume a half-filled
   workflow across sessions? (Recommended: yes to both; state is the document
   instance so it's nearly free.)
4. **Legacy proposal tab retirement**: once workflow-first creation ships
   (phase 3), the old Proposals tab becomes read-only for old records and we
   delete the builder? Timing call.
5. **Purchase-order & materials**: which document bundles do we seed first —
   proposal, change order, invoice, purchase order, work order? (Recommended
   order: proposal (flagship), change order, purchase order (proves sources),
   invoice, work order.)

---

## 10. Addendum (2026-07-27): content blocks, option groups, conditional pricing

### 10.1 Content blocks (workflow-editable media + text)
`params.content_blocks: [{ id, title?, body, media?: {media_id|url}, video?: {url|media_id}, layout: "auto"|"media_left"|"media_right"|"text_only", display: "inline"|"popup" }]`.
- Rendered by a repeater over a `media_text_row` component; `"auto"` alternates
  left/right by row index (repeater `variant_by_index`). Text-only rows just
  omit the media column. Video: interactive surfaces embed the player; print
  renders the poster + a QR/link marker. `display:"popup"` renders a thumbnail
  chip that opens a lightbox on interactive surfaces (portal/editor) and falls
  back to inline-thumbnail in print.
- Workflow kind `content_blocks`: add/remove/reorder rows, text editor, media
  picker (project photos/upload), video URL, layout + display toggles — live
  preview updates per edit. Seeded proposal gains a "Project details" step +
  template page bound to `params.content_blocks`.
- Line items can carry `media[]`/`video` the same way (attach UI in the
  line-items workflow step); `display` inline (row grows) or popup.

### 10.2 Interactive widget plugins (sample)
Registered widgets remain the plugin surface. Sample to ship: `doc.layers_diagram`
— an interactive exploded roof-layers diagram (configurable layer list: name,
blurb, color/icon, optional media), hover/tap to highlight layers on portal;
print renders the stacked static diagram with a legend. Orgs configure data,
never code — new interactive programs arrive as registered widgets (add-ons).

### 10.3 Option groups (multi-proposal in one document)
`params.proposal_options: [{ id, label, summary?, items: scope_item[], content_blocks?: [...] }]`
plus `outputs.option_choice: { type:"select", required_for:"signed" }`.
- Detail pages: page `repeat` over `params.proposal_options` (one detail page
  per option: line-item repeater + optional media).
- Summary page: 3-column compare (repeater `layout.columns:3` over options,
  per-option computed totals via `sum(option.items[].amount_cents)`), each
  column a selectable card wired to `outputs.option_choice` (interactive) —
  the pick "solidifies" that option: `params.scope_items` derive from the
  chosen option (`computed`/server post-pick), receivables from its total.
- Portal: the workflow's customer audience presents the compare step; document
  and portal read the same variables so both stay consistent.

### 10.4 Conditional pricing (discounts = negative line items)
Line items (and therefore discounts) gain optional fields, same framework:
`{ condition?: "<expr>", pricing?: { formula?: "<expr>" }, expires_at?, badge? }` —
amount_cents may be negative (discount rows render distinctly).
- **Pricing scope** adds `checkout` + timing variables, available to every
  expression: `checkout.payment_method ("card"|"ach"|null)`,
  `checkout.processing_fee_percent`, `doc.sent_at`, `doc.first_viewed_at`,
  `now`, and derived helpers `days_since(doc.sent_at)`, `hours_since(...)`.
  Other candidates exposed as they land: `checkout.amount_due_cents`,
  `customer.repeat_customer`, `project.season/month`, `outputs.option_choice`.
- Evaluation: server evaluates conditions at resolve/snapshot AND marks
  conditional rows with their expressions (frozen but reactive); interactive
  surfaces (portal pay flow) re-evaluate client-side via the same
  FMDocModel expressions when checkout variables change (picking card vs ACH
  live-toggles the card-fee row and retotals); the PAYMENT INTENT amount is
  recomputed server-side with the same scope at charge time (authoritative —
  the client view is a preview, never the source of truth).
- Examples to seed: ACH discount (-2% when checkout.payment_method=="ach"),
  card processing fee (+3% when "card"), early-signing discount
  (condition `days_since(doc.sent_at) < 7`, expiring badge with date).

### 10.5 One-page legal template ("one_page_legal")
Seeded contract-type template reproducing the classic single-page roofing
agreement on LEGAL paper (8.5×14): org logo/name/license header (org brand
colors, never hardcoded), two-column checkbox specification sections
(tear-off, deck prep & ventilation, flashing / material, gutters, fascia,
warranty, additional terms) — every checkbox an inline `doc.checkbox` bound to
`params.spec.*` so the workflow drives them; manufacturer/product/color and
warranty years as inline bound fields; notes block; representative +
purchaser signature slots; price panel (contract price, tax code/rate,
computed total, payment schedule rows) bound to params/computed. Fill via
Doc/fill modes or workflow; prints one page.
