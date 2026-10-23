# Editing a document as sent

"Edit manually" on a document opens it **exactly as the customer will get
it**: the same static render the PDF is made from, with line items expanded,
totals computed and every field filled. There are no variables on the page.
A person edits it like the PDF they were about to send, and the document
system decides what each edit means.

This is a general mechanism of the document engine, not an estimate feature:
any template whose text binds data gets it. Entry points:

| Piece | Where |
|---|---|
| Provenance (`trace`) and the helpers below | `public/libraries/doc-model/firstmate-doc-model.js`, section "Bound inputs" |
| Traced resolution, input kinds, the write route | `public/v1/documents/service.ts` (`resolveDocumentInstance({ trace })`, `writeDocumentInputs`), `public/v1/documents/inputs.ts` |
| Routes | `POST /organizations/:orgId/documents/:id/resolve { trace: true }`, `POST /organizations/:orgId/documents/:id/inputs` |
| The editor | `public/libraries/doc-sent-editor/firstmate-doc-sent-editor.js` (`FMDocSentEditor.open`) |
| Host | `openAsSentEditor()` in `public/libraries/apps/documents/project.js` |
| Tests | `public/v1/tests/document-as-sent-editing.test.ts` |

## What every value on the page is

`FMDocModel.resolveBindings(doc, data, { trace: true })` renders exactly what
an untraced resolution renders. It also records, on every bound text run,
`run.binding = { expr, path, format, format_args, value, kind }`:

- `path` is the data the run shows, as a dotted path
  (`params.scope_items.0.children.3.quantity`). It follows the expression to
  the reference it displays: through formatters (`| money`), the branch a
  ternary took and the argument `coalesce` used. An expression that combines
  several values (`a + b`, `concat(...)`) has no path.
- Rows of a list keep where they live. A repeater over a plain path stamps
  each row with `source_path`; a projection the server builds (the flat
  `params.scope_rows` of a scope tree) carries `source_path` back to the tree
  row it shows. So `item.quantity` in a repeated line row resolves to the
  scope item itself, never to the projection.
- Nodes made from data (repeater rows, component instances, repeated nodes
  and pages) carry `generated: true`.

`kind` says what a person can do with the value:

| kind | What it is | In the editor |
|---|---|---|
| `input` | The document's own data: a `params.*` value that is stored on the document | Click and type. The data changes and everything derived from it recomputes |
| `derived` | Computed from inputs: `computed.*`, a line amount that is the sum of its lines, a resolver projection | Read only, with a note saying it follows the values it comes from |
| `upstream` | Another record: `project.*`, `customer.*`, `org.*`, `doc.*` | Read only; "Type over it here" pins a different text in this document only |
| `output` | What the customer filled in (`outputs.*`) | Read only |
| `calculated` | An expression with no single source | Read only |
| `pinned` | A value typed over in this document (see below) | Kept; flagged when the record changes |

The server refines `input` (`public/v1/documents/inputs.ts`): a params key the
resolver computes every time (`scope_rows`, `scope_packages`, `account`, ...)
or one that is neither stored nor declared is `derived`, and a registered
**input rule** classifies and stores values inside a kind of data. Rules are
per kind of data, not per template, so every document showing the same data
behaves the same.

### Line items

The built-in rule `documents.line_items` owns rows of `scope_items`,
`line_items`, the option slots, `proposal_options[n].items` and
`pricing_adjustments`, at any depth of `children`:

- A line's quantity, name, display name, description and unit are inputs.
- Its amount is an input on a line that prices itself. A typed amount is
  stored as the line's unit price (amount / quantity, whole cents); when no
  whole-cent unit price gives the amount exactly (or the line takes its price
  from a variation) the typed amount is kept as the line's explicit amount.
  Changing the quantity later drops that explicit amount, so quantity x unit
  price applies again.
- A group line's amount (the sum of its lines), a line priced by a formula,
  a non-chargeable line, and the pricing engine's own fields (`selected`,
  `show_amount`, `depth`, ...) are derived.

**The rule for derived values:** totals and anything else computed are never
typed. They always equal what the document's data adds up to, and the sent
document, its payments and its signature all agree with its lines. To change
a total, change a line.

Measurements are inputs like any other param (`params.measurements.*`). As in
the workflow's Line items step, a measurement typed in does not rewrite line
quantities generated from the old measurements (that would discard edits made
to those lines); the Line items step shows those lines as stale and
regenerates them on request.

### Writing an input

`POST /documents/:id/inputs { writes: [{ path, text }] }`
(`writeDocumentInputs`):

1. Resolves the document traced and accepts only paths it shows as `input`
   (409 `document_input_not_writable` otherwise). The client cannot write a
   path the document does not show.
2. Parses the text the way the value is formatted
   (`FMDocModel.parseBoundInput`: money is typed in currency and stored in
   cents, quantities drop their unit).
3. Applies it through the owning input rule, or sets the path.
4. Saves the changed params keys with `patchDocumentInstance`, the same
   writer every document edit uses (department access, signing locks,
   revision check). The edit is a document revision, which the document
   version history shows.
5. Returns the fresh traced resolution: line amounts, subtotals, tax and
   totals are recomputed by the same resolver the PDF uses.

A draft estimate's line items are the document's data until it is accepted;
the project's lists are produced from the accepted document
(`proposals/document_artifacts.ts`), so an as-sent edit never writes project
lists directly and needs no project-history entry of its own. Upstream
records (project, customer, measurement dataset, price book) are never
written from a document: "local overrides are distinct from writes back to
the producer" (`data-actions-continuity.md`).

## Text edits

Text that is not data is edited in place. Only text nodes that exist in the
template (or were inserted by an override) can be edited; text inside rows
made from data is part of the row's layout.

On save the editor reads the edited node back into blocks (block and run
elements carry `data-block-index` / `data-run-index` from the renderer) and
`FMDocModel.boundBlocksToTemplate` turns them into template blocks:

- a bound run becomes its binding again, so **the value stays live**;
- typed text is literal (`literal: true` when it contains `{{`: a person
  typing braces never writes an expression);
- a run typed over an upstream value becomes `{ text, literal: true,
  pinned: { expr, value } }`.

The host stores one override per node,
`{ op: "node.set", node_id, prop: "props.blocks", value, base, source: "as_sent" }`,
appended to the document's override log through the normal document PATCH
(with `expected_revision`), so it is a document revision like every other
edit. `base` is `FMDocModel.fingerprint` of the template node's own blocks
when the edit was made. Paragraph style (`style_ref`), bold, italic and
underline are run and block properties of the same override.

### When things change later

- **Data changes** (a quantity, a price, a customer's name): edited text
  keeps its bindings, so it shows the new values. Nothing to reconcile.
- **The template changes the same text** (a draft follows its template's
  current version): the override is kept and wins, and the traced resolution
  marks the node `as_sent.conflict` because `base` no longer matches. The
  editor shows "The template's text changed after this was edited" with
  **Keep mine** (re-save with the current fingerprint) or **Use the
  template's** (drop the override). An edit is never silently dropped and
  never silently overwrites newer template text without saying so. Template
  text nobody edited follows the template.
- **A pinned value's record changes**: the pinned text stays and its run is
  flagged (`binding.conflict`, with the record's `current` value). The
  editor offers **Keep mine** or **Use the data again** (the run becomes a
  binding).

"Use template text" on any edited node removes its override.

## The PDF is the page

The editor renders the traced resolution with `FMDocRenderer` in static mode,
the same renderer and mode the PDF harness (`documents/render.ts`) runs on the
same resolution without tracing. Tracing only splits runs that mixed text and
tokens into runs of the same style, so the page and the PDF are the same
document. Every edit is stored as data or as an override, never as rendered
HTML, so the next resolution (preview, PDF, snapshot at send) includes it.

## Limits

- Values drawn by widgets (`doc.line_items`, `doc.payment_schedule`, ...) are
  rendered by the widget from server data, not text runs; they are not typed
  into in place. Change them where their data is edited. The seeded estimates
  draw their lines with repeaters, which are fully editable.
- Pages and layout (adding, moving or removing blocks) are the template
  editor's job: "Edit layout" opens it from the as-sent editor.
- Module-owned documents (`module_ref`) refuse params and overrides, as they
  do for every other editor.
- Not built: each typed value resolves the document twice (validate, then
  return the new page); see [the optimization backlog](../optimization-backlog.md).
