# FirstMate Document Engine — Specification

Status: **draft for review** (2026-07-23)
Replaces: proposals rendering/builder, invoice rendering, change orders, project docs surface. No backwards compatibility required — these systems get rebuilt on top of this engine and the old paths are deleted.

---

## 1. Purpose

One engine for every "designed surface" in FirstMate:

- **Documents** — proposals, invoices, change orders, contracts, work orders, warranties, reports. Printable, PDF-able, signable, payable.
- **Interactive views** — the customer-portal companion of any document (pay a change order, fill a form, sign), and later fully designed portal tabs.
- **Future surfaces** — the website builder and portal-tab designer are the same problem (arrange text/media/interactive content, themed, data-bound) and MUST be able to reuse this engine's model, renderer, widgets, and editor framework unchanged.

The engine is four separable layers, each usable without the others:

| Layer | What it is | Analogy |
|---|---|---|
| **DocModel** | JSON scene-graph document format + typed data contract (params in, outputs out) | The file format |
| **Renderer** | One isomorphic renderer: DOM (interactive), print HTML → PDF, image | The browser |
| **Widgets** | Code-backed live components registered by id, referenced by data | The plugin API |
| **Editor** | One editing engine with composable feature policies ("rails") | Canva → Acrobat form-fill, same UI kit |

Everything the model can express is renderable in all targets; everything is data except widgets, themes-as-code hooks, and behaviors — which are **code registered under stable ids and referenced from data**, exactly like `registerWorkAutomation` in the work engine.

---

## 2. Grounding: what exists today (and what we keep)

Findings from the current codebase that shape this design:

**Kept and built upon:**
- **Playwright HTML→PDF pipeline** (`public/v1/proposals/pdf.ts`, `renderProposalPdf`) — proven; generalized to `renderDocumentPdf`.
- **Platform document store** (`public/v1/platform/storage.ts`) — org-scoped JSON collections with revisions, optimistic concurrency; new collections added to the allow-list.
- **Media store** — `storeMediaUpload`/`readMediaFile`, sharp renditions, markup layers with normalized 0..1 coordinates. Markup layers become first-class overlay content in DocModel.
- **Work engine** (`public/v1/work/*`) — events + `registerWorkAutomation` + data-only bindings in scope templates. Document behaviors emit work events and are consumed by exactly this machinery.
- **Capability registry** (`platform/capabilities.ts`) — gates the apps and the editor feature tiers.
- **Receipt extraction** (`payments/receipt_extraction.ts`) — the LLM strict-json-schema pattern, generalized for document ingestion.
- **Snapshot/public-token/e-sign/payment lifecycle** from proposals (`proposals/storage.ts`) — the lifecycle survives; its rendering and content model are replaced.
- **Scope template versioning pattern** (`scopes/storage.ts`) — template + immutable published versions + preset revisions; document templates version the same way.

**Replaced (deleted at the end of the build):**
- The three duplicate render paths: client `proposalPdfDocumentHtml` (13k-line `apps/proposals/project.js`), server `invoiceHtml` string template (`payments/invoices.ts`), and the portal iframe re-invocation (`customer_portal/proposal_renderer.html`).
- The three hardcoded themes (`margin`/`triangles`/`clean`) duplicated across proposal CSS and invoice HTML — reborn as theme documents (§7).
- `proposal.editable.pages[]` free-form JSON — replaced by DocModel.
- ~~The `apps/docs` project tab — replaced by the unified Documents app.~~
  **Reversed (2026-08 consolidation):** the `apps/docs` gallery tab is the one
  SURVIVING project documents surface. The standalone `project.documents` tab
  is hidden; `apps/documents/project.js` now also runs as an embedded service
  (`params.embed`) inside the Docs tab, supplying the create wizard, the
  SmartDoc editor, and the engine document list that the Docs gallery merges
  with uploaded files/receipts/report PDFs. Engine documents open in the
  editor; uploads, receipts, and measurement reports keep the preview viewer.

---

## 3. Mental model

```
Document Type ─────── "what kind of thing is this" (proposal, invoice, change_order…)
   │  registers: param schema, output schema, extraction schema, behaviors, default template
   ▼
Document Template ─── org-owned, versioned DocModel + edit policy + bindings
   │  referenced by id from scope templates / automations (never inlined)
   ▼
Document Instance ─── template@version + param values + edit overrides + lifecycle status
   │  issue/send ──► Snapshot (frozen data + frozen HTML + PDF media ref + public token)
   ▼
Outputs ──────────── signatures, form values, selections, payments
   │
   ▼
Work events ──────── document.signed / document.form.submitted / payment.received …
                     → scope-template external_triggers & automation_bindings react
```

A **template + params** renders equally as (a) a paginated print document and (b) an interactive portal view. That is the line between "send them a change-order PDF" and "show a change order in their portal": same template, two render targets, org chooses per scope template which delivery to use.

---

## 4. DocModel — the document format

A single JSON format (`schema_version: 1`). Zod-schema'd in `public/v1/documents/schemas.ts`; the same schema module is shared isomorphically with the browser (`public/libraries/doc-model/`).

### 4.1 Top level

```jsonc
{
  "schema_version": 1,
  "kind": "document",              // "document" | "view"  (view = unpaged web surface)
  "settings": {
    "paper": { "size": "letter" | "legal" | "a4" | {w_pt,h_pt}, "orientation": "portrait" },
    "locale": "en-US",
    "base_font_pt": 11
  },
  "theme_ref": { "theme_id": "...", "version": 3 },   // §7; overridable at instance level
  "params": { ... },               // typed inputs — §5.1
  "outputs": { ... },              // typed outputs — §5.3
  "pages": [ Page, ... ],          // kind:"document"
  "root": Node,                    // kind:"view" (single flow root instead of pages)
  "assets": [ MediaRef, ... ],     // media referenced by nodes (media_id + variant + markup_layer_id)
  "edit_policy": { ... },          // §9.3
  "metadata": { "document_type": "change_order", "tags": ["change_order","roofing"], ... }
}
```

### 4.2 Pages

```jsonc
{
  "id": "pg_cover",
  "role": "cover" | "body" | "pricing" | "signature" | "fine_print" | "custom",
  "master_ref": "master_id?",      // optional page-master (theme-provided chrome: rails, corners, headers)
  "repeat": { "for": "{{params.line_item_groups}}" }?,  // data-repeated pages
  "children": [ Node, ... ]
}
```

`role` is what themes key their page chrome off (today's "margin rail on every page, big triangle on cover" becomes theme rules matched to roles — §7).

### 4.3 Nodes — the scene graph

Every node: `{ id, type, name?, frame, style?, locks?, bind?, visible?, children? }`.

**`frame`** — geometry, in **points** within the parent's coordinate space:

```jsonc
{
  "x": 36, "y": 120, "w": 540, "h": 200,
  "position": {
    "x": { "unit": "percent|px", "anchor": "left|center|right", "value": 0 }
  }?,
  "responsive": {
    "mode": "auto|manual",
    "width": "percent|fixed",
    "height": "proportional|fixed"
  }?,
  "rotation": -3.5,                 // degrees, around center
  "z": 4,
  "constraints": { "h": "left|right|center|stretch|scale", "v": "top|bottom|center|stretch|scale" },
  "layout": "absolute" | "flow"     // how THIS node lays out its children
}
```

- `layout:"absolute"` — Canva-style free placement (children positioned by their frames).
- `layout:"flow"` — HTML-style block stacking with `gap`, `padding`, `direction`, `wrap`. Flow is what makes structured documents and responsive web views possible; absolute is what makes free design possible. They nest freely (a flow page containing an absolutely-positioned hero frame containing flowed text).
- `position.x` is the canonical horizontal placement contract for absolute
  descendants of `kind:"view"` sections. The selected item anchor is mounted
  to the matching parent anchor plus a signed offset. A `percent` offset is a
  percentage of the immediate parent's rendered width; a `px` offset is in CSS
  pixels. For example, `{unit:"percent",anchor:"center",value:0}` centers an
  item, while `{unit:"px",anchor:"right",value:-24}` keeps its right edge 24px
  inside the parent. `frame.x` remains the editor/design-coordinate snapshot
  used by fixed-page documents and geometry tools; view rendering treats
  `position.x` as authoritative. Switching unit or anchor must round-trip
  through the current rendered left coordinate so it never moves the item.
- Website API writes validate an explicitly supplied `position.x`, add the
  center/percentage default when it is absent, and persist only the normalized
  `{unit,anchor,value}` shape. The same normalization is applied to seeded,
  agent-authored, and resolved website definitions.
- `responsive.mode:"auto"` is the default for every absolutely positioned
  website-section descendant. Its left edge, top, width, and height are
  authored as fractions of the immediate parent design width, so the item
  scales proportionally on both axes and retains the same surrounding space.
  Vertically overlapping items form one logical row; a later row preserves
  only the gap after the preceding row's maximum bottom, preventing two
  side-by-side items from pushing downstream content twice. The containing
  section scales its authored height by the same ratio, so following sections
  move exactly once. Fixed-page documents never use this behavior.
- `responsive.mode:"manual"` makes `position.x` authoritative again and
  exposes independent fixed/percentage width and fixed/proportional height.
  These advanced choices are stored in the shared model rather than editor UI
  state, so API-authored, seeded, agent-authored, previewed, and published
  website definitions render identically.
- A website section can opt into an independent phone layout. The desktop
  frame stays canonical and sets `props.mobile_variant_enabled`; its paired
  root frame sets `props.view_variant:"mobile"`, `props.variant_of` to the
  desktop id, and `props.mobile_enabled:true`. Descendants retain a stable
  `props.variant_source_id` link while receiving independent ids, so phone
  edits (including phone-only insertions) never mutate desktop content.
- Mobile rendering selects the enabled paired frame at a 600px-or-narrower
  view width and otherwise selects the desktop frame. Without an enabled pair,
  mobile falls back exactly to desktop. “Magic Mobile” always rebuilds the
  complete pair from the current desktop frame, groups vertically-overlapping
  siblings into visual rows, orders each row left-to-right, stacks and centers
  them against percentage rails derived from the widest multi-item desktop
  row's outer left/right edges. Headings, paragraphs, and stacked media share
  those rails when they were already aligned; standalone text retains its own
  desktop rails and width. Rail discovery resolves canonical manual mounts
  (`frame.position.x`) rather than stale `frame.x` snapshots, so the sampled
  edges match what desktop actually paints. It preserves
  bounded intentional separation between desktop rows, adds extra semantic
  clearance from text/headings into visual rows, normalizes mobile font sizes, and grows the section around the
  final descendant bounds. The replacement is one batch command and therefore one
  undo step; prior manual phone edits are intentionally discarded.

**Node types:**

| type | purpose | key props |
|---|---|---|
| `frame` | container / group. Groups are just frames created by the editor's Group command | `layout`, `clip`, `background` |
| `text` | rich text box | `runs[]` (text + per-run style), `align`, `valign`, `line_height`, `letter_spacing`, `auto_fit` |
| `image` | media reference | `media` (MediaRef), `fit: cover/contain/fill`, `crop`, `focal_point` |
| `shape` | vector | `shape: rect/ellipse/line/polygon/path`, `points[]`/`d`, `fill`, `stroke`, `corner_radius` |
| `markup_overlay` | a Markup layer composited over a sibling/parent image | `media_id`, `layer_id`, `revision` — reuses Markup's normalized 0..1 items verbatim |
| `widget` | live registered component | `widget: "doc.line_items@1"`, `props{}`, `bind{}` — §6 |
| `table` | static table (non-live) | rows/cells of text nodes |

**`style`** — visual properties, all expressible as CSS (that is a hard constraint: **every style property must have an exact CSS mapping**, because CSS is the render substrate for all targets):

```jsonc
{
  "opacity": 0.9,
  "fill": { "type": "solid|linear|radial", "color": "#... | var(--fm-primary)", "stops": [...] },
  "stroke": { "color", "width_pt", "dash" },
  "shadow": { "x","y","blur","color" },
  "radius": [4,4,0,0],
  "blend": "normal|multiply|screen|overlay",
  "filters": {                      // media adjustments — maps 1:1 to CSS filter/backdrop pipeline
    "brightness": 1.1, "contrast": 1.0, "saturate": 0.8,
    "hue_rotate_deg": 15, "grayscale": 0, "sepia": 0, "blur_px": 0,
    "tint": { "color": "#0a3", "amount": 0.25 }   // implemented as overlay + blend
  },
  "font": { "family", "size_pt", "weight", "style", "color", "transform" }   // text defaults; runs override
}
```

Colors may be literals or **theme tokens** (`var(--fm-primary)` style references) so one document restyles under any theme.

**`locks`** — per-node editing rails (consumed by the editor, §9.3): `{ move, resize, rotate, style, content, delete, children }`, each `true|false|"role:designer"`.

**`bind`** — data bindings (§5.2): map any node prop to an expression, control repetition/visibility: `{ "props": { "children.0.runs.0.text": "{{params.customer.name}}" }, "if": "{{params.deposit_cents}} > 0", "repeat": {"for": "{{computed.rows}}", "as": "row"} }`.

### 4.4 Text model

Rich text as `runs[]` (Quill/ProseMirror-style flat runs, not HTML strings): `{ text, font?, color?, weight?, italic?, underline?, strike?, link?, bind? }` grouped in `blocks[]` (`paragraph | heading | list_item`, with `align`, `indent`, `list` info). Inline data tokens are runs with `bind` — this is what renders "Dear {{customer.first_name}}" and re-flows correctly. Text sits anywhere in z-order, including over images — it's just a node.

### 4.5 Pagination & overflow

- `kind:"document"`: pages are fixed-size; a flow container may declare `"overflow": "paginate"` — the renderer splits its content across cloned continuation pages (this is how a 40-row line-item table breaks across pages; widgets can also declare their own pagination behavior).
- `kind:"view"`: no pages; the root flows and is responsive via constraints + flow layout. Print of a view auto-paginates through a default page master.

---

## 5. Data layer — params, bindings, outputs

This is what makes these *documents about data* rather than pictures.

### 5.1 Params (typed inputs)

Declared on document types (base contract) and templates (additions). JSON-schema-like, with FirstMate-native types:

```jsonc
"params": {
  "customer":        { "type": "entity", "entity": "contact" },
  "project":         { "type": "entity", "entity": "project" },
  "scope_items":     { "type": "list", "items": {"type":"pricebook_line"} },
  "deposit_cents":   { "type": "currency", "required": true },
  "install_address": { "type": "address" },
  "notify_email":    { "type": "email" },
  "shingle_color":   { "type": "select", "options_from": "{{pricebook.item(itm_x).options.color}}" },
  "measurements":    { "type": "measurements" },       // FirstMeasure payload
  "hero_photo":      { "type": "media", "kinds": ["image"] }
}
```

Primitive types: `string, text, number, currency, percent, date, datetime, boolean, email, phone, address, select, multi_select, media, signature_request, list, object`. Reference types: `entity` (project/contact/customer/org/user), `pricebook_line`, `measurements`, `payment_schedule`.

**Param resolution order** at instantiation: explicit values passed by the caller → automation-supplied bindings (`{{project.customer.name}}` interpolation, same resolver family as the work engine's `resolveValue`) → template defaults → prompt-the-user (the issuing UI renders a form from unresolved required params — the param schema IS the web form the owner described).

### 5.2 Bindings & expressions

One expression language everywhere (editor, renderer, server), implemented once in `doc-model` and used isomorphically:

- Path interpolation `{{params.x.y}}`, `{{theme.colors.primary}}`, `{{outputs.sig_customer.signed_at}}`, `{{computed.total_cents}}` — deliberately the same `{{namespace.path}}` shape as work-engine automation inputs so org admins learn it once.
- Formatters: `{{params.total_cents | money}}`, `| date("MMM d, yyyy")`, `| upper`, `| qty(unit)`.
- Guarded expressions for `if`/`repeat` and computed fields: a small, **non-Turing-complete** expression grammar (comparisons, boolean ops, arithmetic, ternary, path access, whitelisted functions). No arbitrary JS in documents — widgets are the escape hatch for real logic.
- `computed`: template-level named expressions (`"computed": { "total_cents": "sum(params.scope_items[].amount_cents)" }`) so display nodes bind to one definition.

### 5.3 Outputs (typed results)

What the document produces when a human interacts with it:

```jsonc
"outputs": {
  "sig_customer":   { "type": "signature", "required": true, "signer": "customer" },
  "sig_company":    { "type": "signature", "required": false, "signer": "internal" },
  "selected_tier":  { "type": "select", "from_widget": "w_choice_group" },
  "deposit_payment":{ "type": "payment", "obligation": "deposit", "required_for": "completed" },
  "intake_fields":  { "type": "form_values", "from_widget": "w_intake_form" }
}
```

Rules:
- Every output is produced by a **widget instance** in the document (signature slot widget, payment widget, form-field widgets, choice group widget). Declaring an output that no widget produces is a template validation error; the template studio surfaces this.
- `required` outputs gate lifecycle transitions (§10.3): a document is `signed` only when all required signature outputs exist; `completed` when all `required_for:"completed"` outputs exist.
- Output values are written to the **instance** (and frozen into snapshots) under `outputs{}` with full evidence (reuse `publicRequestAudit` browser-evidence capture from proposals).
- Outputs are queryable uniformly: `GET /documents/:id` returns `outputs` in the typed shape — "what payment schedule is on this proposal" is `doc.params.payment_schedule` / `doc.outputs.deposit_payment` regardless of whether the doc was system-generated or ingested from an upload (§12).

---

## 6. Widget registry

Widgets are the only place code meets documents. Registered like work automations:

**Server** (`public/v1/documents/widgets/registry.ts`):
```ts
registerDocumentWidget("doc.line_items", {
  version: 1,
  props_schema: z.object({ view: ..., show_included: ... }),
  data_requirements: ["params.scope_items", "pricebook"],  // what the resolver must supply
  resolve: async (ctx, props) => ({ rows, totals }),        // server-side data resolution, runs before render
  outputs: [],                                              // or e.g. [{key, type:"select"}]
  print: { paginates: true },
})
```

**Client** (`public/libraries/doc-widgets/`): renderer per widget id+version with two required modes — `renderStatic(el, data, ctx)` (print/PDF; must be deterministic, no network after resolve) and `renderInteractive(el, data, ctx)` (portal/editor; may attach handlers, submit outputs via `ctx.submitOutput(key, value)`).

Documents reference widgets **by id@version + props + bindings only** — a template never contains widget code. Unknown widget id → render-time placeholder + template validation error, never a crash.

### Built-in widget set (v1)

| id | purpose | notes |
|---|---|---|
| `doc.line_items` | pricebook/scope line-item table | replaces proposal pricing pages + invoice line items; choice/optional selection in interactive mode; paginates in print |
| `doc.payment_schedule` | schedule table bound to payment obligations | live status (paid/due) in interactive mode |
| `doc.pay_now` | payment CTA/embed | wraps `FirstMatePaymentIntake`; static mode renders amount-due summary + QR to portal |
| `doc.signature` | signature slot | typed/drawn capture, adopt-and-apply flow ported from proposals; static mode renders signed image or blank line |
| `doc.form_field` | single input (text/number/select/date/address/…) | writes to `outputs.form_values`; static mode renders value or blank rule |
| `doc.choice_group` | pick-one-of-N option cards | replaces proposal choice groups |
| `doc.qr` | QR code | **local generation** (add a QR lib server+client; drop the api.qrserver.com dependency for documents); default payload = the doc's portal URL |
| `doc.photo` | project photo w/ markup overlay + caption | integrates `FirstMateMarkup` viewer in interactive mode |
| `doc.photo_grid` | data-repeated gallery | |
| `doc.measurement_report` | FirstMeasure diagram/summary insert | replaces `measurement_insert` pages |
| `doc.page_number`, `doc.toc` | print furniture | resolved during pagination |
| `doc.video` | interactive video, print fallback poster | ports `r-proposal-video-print-fallback` behavior |

The website/portal builder later adds its own widget namespace (`web.nav`, `web.testimonial_feed`, …) to the same registry — that's the extension path, not a new system.

---

## 7. Themes & style frameworks

Generalizes `margin` / `triangles` / `clean` into data.

A **theme** is its own versioned document (`document_themes` collection):

```jsonc
{
  "id": "thm_margin", "name": "Margin", "version": 4,
  "tokens": {
    "colors": { "primary": {from:"org.branding", fallback:"#2563EB"}, "accent": ..., "text": ... },
    "fonts":  { "display": "Montserrat", "body": "Inter" },
    "spacing": { "page_margin_pt": 40, "gap_pt": 12 }
  },
  "type_styles": { "h1": {...}, "h2": {...}, "body": {...}, "caption": {...}, "legal": {...} },
  "page_masters": [
    { "id": "m_cover", "match": {"role": "cover"},
      "chrome": [ /* DocModel nodes: the triangle shape, the logo frame, footer */ ],
      "content_inset": {"top":..., "left":...} },
    { "id": "m_body", "match": {"role": "*"}, "chrome": [ /* 48pt primary rail on the left */ ] }
  ],
  "widget_skins": { "doc.line_items": {"header_fill":"var(--fm-primary)", ...} }
}
```

- Documents bind to tokens (`var(--fm-primary)`), never to literals, unless deliberately overridden — so **one theme swap restyles proposal + invoice + change order together** (the "style parity" requirement).
- Page masters carry the chrome as ordinary DocModel nodes matched by page role — the margin rail and corner triangles are just shapes in a master, not CSS forks.
- Token resolution: theme defaults ← org branding ← branch presentation settings ← per-document overrides. Same chain proposals use today, formalized.
- Themes ship as seeded presets (port Margin/Triangles/Clean day one) and are org-editable in the template studio with the same editor (a theme is edited in `designer` profile).

---

## 8. Rendering architecture — one renderer, three targets

**Single renderer codebase**: `public/libraries/doc-renderer/` (vanilla JS, IIFE bundle like every other FirstMate library; depends only on `doc-model` and `doc-widgets`). It renders DocModel → DOM/CSS. All targets run *this same code*:

1. **Interactive DOM** — portal tabs, the Documents app preview, and the editor canvas (the editor renders THROUGH the renderer and decorates it with handles; no second implementation). Widgets in `renderInteractive` mode.
2. **Print/PDF** — a static harness page `public/v1/documents/render/harness.html` loads `doc-model` + `doc-renderer` + `doc-widgets`, receives `{document, resolved_data, theme}` via injected JSON, renders with widgets in `renderStatic` mode, sets `window.__docRenderReady`. The server (`documents/pdf.ts`, generalized from `proposals/pdf.ts`) drives Playwright: `page.setContent(harness)`, wait for fonts/images/`__docRenderReady`, `page.pdf(...)`. **Server-authoritative**: the client never uploads HTML (unlike today's proposal flow) — the server resolves data, renders, prints. PDF bytes stored via `storeMediaUpload(ownerType:"document", slot:"pdf_<snapshotId>")`.
3. **Image** — same harness, `page.screenshot()` per page (thumbnails for pickers, og-images, portal cards).

Widget data resolution (`resolve()`) always runs **server-side before render** and its result is frozen into snapshots — print, portal, and PDF all render from identical resolved data, killing the current three-way drift by construction.

Fonts: self-host the proposal font set (Montserrat, Inter, Roboto, Open Sans, Lato, Poppins, Source Sans 3) under `public/libraries/doc-renderer/fonts/` so PDF rendering never depends on external CDNs.

---

## 9. Editor framework — one engine, composable rails

`public/libraries/doc-editor/` — the piece that makes this Canva-and-more without shipping ten editors.

### 9.1 Core engine (profile-independent)

- Selection model (click, shift-multi, marquee, enter-group), transform handles (move/resize/rotate with snapping, smart guides, keyboard nudge), z-order, align/distribute, **group/ungroup** (groups are `frame` nodes), duplicate, copy/paste (internal clipboard of DocModel fragments).
- Command bus: every mutation is a named command over the DocModel (`node.move`, `text.setRun`, `page.add`, …) → **undo/redo is a command-log** (pattern proven in `PhotoMarkup`, history-capped), and the same commands drive collaborative/edit-policy filtering.
- Inspector framework: property panels registered per node type; widget prop panels generated from `props_schema` + optional custom panel per widget.
- Text editing in place (contenteditable over the rendered node, committing to `runs[]`).
- Asset drawer: org media library (existing media APIs), pricebook items, param tokens (drag a param into a text box → bound run), widget palette.

### 9.2 Profiles (feature-set presets)

A **profile** = a named set of enabled features + UI arrangement. All profiles share the same components (toolbar, inspector, layers panel, page rail), so nothing is learned twice:

| profile | enabled | intended use |
|---|---|---|
| `designer` | everything: free placement, rotation, shapes, filters, masters, theme editing | template studio, marketing pages, website builder later |
| `document` | flow-first editing: pages, blocks, text, images, widgets; free-transform off by default (unlockable per user action if policy allows) | day-to-day proposal/contract authoring |
| `fill` | only widget inputs + `content:true` text nodes editable; layout untouchable | filling a form/contract before sending |
| `inline` | single-surface, no chrome; embedded in another app (edit a portal card in place) | portal designer, quick edits |

Features are **flags, not forks** — `features: { free_transform, rotate, shapes, filters, page_masters, theme_edit, widget_insert, page_manage, ... }` — so orgs/contexts can mix arbitrary combinations; profiles are just shipped presets over the flag set.

### 9.3 Edit policy (rails carried by the document)

The template author decides what downstream editors may touch; the policy travels with the template:

```jsonc
"edit_policy": {
  "base_profile": "document",
  "max_profile": "designer",          // what "unlock" can escalate to, if anything
  "features": { "page_manage": false, "widget_insert": ["doc.photo","doc.form_field"] },
  "unlock": { "allowed": true, "permission": "manage_company_settings" }
}
```
plus per-node `locks` (§4.3). The engine enforces policy at the **command bus** (a locked command is filtered, its UI affordance hidden) — one enforcement point, so every profile automatically respects rails. This is the "legal contract that isn't a free canvas but can be unlocked" requirement.

### 9.4 Where the editor mounts

Registered as embeddable apps: `documents.studio` (template + theme studio, settings surface), `project.documents` (project tab: instances — replaces `apps/docs`), and the issuing flow (param form + `fill` profile) launched from scope-driven automations and the project tab.

---

## 10. Templates, instances, snapshots, lifecycle

### 10.1 Storage (platform JSON collections — same substrate as proposals today)

New collections in `platform/storage.ts` `COLLECTIONS`:

- `document_templates` — current pointer: `{id, name, document_type, status: draft|active|archived, current_version, tags[], preview_media_ref, metadata:{preset, preset_revision}}`
- `document_template_versions` — immutable: `{template_id, version, definition (DocModel), checksum, published_at, published_by}`. Save uses `expected_revision`; publishing bumps `current_version`. Presets seed/upgrade by `preset_revision` exactly like scope templates; editing a preset flips `preset:false, based_on_preset`.
- `document_themes` (+ `document_theme_versions`)
- `documents` — instances: `{id, document_type, template_ref:{template_id, version}, theme_ref, project_id, contact_ids[], params{}, overrides (DocModel patch), outputs{}, status, delivery{}, pdf{}, source: "generated"|"uploaded", ingestion{}?}`
- `document_snapshots` — frozen: `{document_id, snapshot_number, reason: send|sign|pdf|manual, resolved (DocModel + resolved widget data + theme tokens), params, outputs, evidence, public_token, pdf{media_id,...}, locked:true}`
- `document_events` — append-only audit, mirrored into `emitWorkEvent`.

Instances store **overrides as a patch against the template version**, not a full copy — templates stay authoritative; "detach from template" is an explicit action that materializes the patch.

### 10.2 Referenced, never inlined

Scope templates, automations, and org settings reference documents by `{document_type}` or `{template_id}` only (the "global list" requirement). Resolution: explicit `template_id` → org default template for the type → seeded preset. A `roofing_proposal` template is an org asset with its own required params (measurements in, payment schedule out); the scope template just points at it and supplies bindings.

### 10.3 Lifecycle

`draft → issued → sent → viewed → in_progress → signed → completed | declined | expired | void`

- **issue** = resolve params, create instance (optionally straight to send).
- **send** = create snapshot (+ public token, + PDF if delivery includes it), deliver (email w/ attached PDF via existing Postmark path, and/or portal share). Re-send after edits = new snapshot superseding the old token, same as proposals today.
- **signed/completed** are computed from required outputs (§5.3), never set directly.
- Every transition emits a work event (§11) and appends to `document_events` with evidence.
- Change orders on signed documents: signed instances are locked (`document_locked_signed`); the "amend" action creates a new instance of the org's `change_order` type pre-bound to the source document's params/deltas — the current proposal→change-order gesture, formalized.

### 10.4 Public/portal companion

Every snapshot has a public token: `GET /v1/documents/public/:token` returns `{snapshot, workflow}`; the portal renders it with the interactive renderer (replacing `proposal_renderer.html` + the portal's bespoke proposal code). Interactive widgets submit outputs to `POST /public/:token/outputs/:key` with browser evidence. `GET /public/:token/pdf` streams the stored PDF. The `doc.qr` widget on the printed page points at the portal URL — print and portal are two views of one snapshot.

---

## 11. Behaviors — wiring documents into the platform

All integration flows through the work engine; the document module itself stays ignorant of roofing, payments logic, etc.

**New work events** (registered in `work/events.ts`): `document.issued`, `document.sent`, `document.viewed`, `document.output.recorded`, `document.signed`, `document.completed`, `document.declined`, `document.expired`, `document.ingested`, `document.payment.received`. Payloads carry `{document_id, document_type, template_id, project_id, scope_piece_id?, work_plan_id?, outputs_summary}` so `eventTargetsNode` scoping works unchanged.

**New automations** (registered in `work/automations/builtins.ts`):
- `documents.issue.v1` — input `{document_type | template_id, params (with {{bindings}}), deliver: "portal"|"email"|"none", assign_fill_to?}`. This is how a scope template says "when the job hits this node, issue a change order / send the contract."
- `documents.requireCompletion.v1` — creates a work requirement satisfied by `document.completed`.
- Payment flow: the `payment` output type integrates with the existing receivables machinery — on `document.signed` with a `payment_schedule` param, `payments.ensureReceivables.v1` (generalized to read from document params instead of proposal snapshots) creates schedules/obligations; `doc.pay_now`/portal payments record against them and emit `document.payment.received`.

**Document types** (`public/v1/documents/types/registry.ts`): `registerDocumentType(id, {label, icon, param_schema, output_schema, extraction_schema, default_behaviors, seeded_templates})`. v1 ships: `proposal`, `invoice`, `change_order`, `contract`, `work_order`, `receipt` (adopting the existing pipeline's classification), `generic`. Org-defined custom types are supported from day one (they're data; only widgets/automations need code).

**Capabilities**: new nodes `platform.documents` (app, `runtime_app_id:"documents"`), children `documents.templates_studio`, `documents.designer_profile` (gates the full-canvas editor tier), `documents.ingestion`, `documents.esign`, `documents.payments`. `platform.project_docs` and `docs.markup` are retired/aliased.

---

## 12. Ingestion — uploaded documents become the same thing

Generalizes `receipt_extraction.ts` into `public/v1/documents/ingestion.ts`:

1. Upload (PDF/docx/image/…) → media store, sha256, magic-byte typing — verbatim the receipt pipeline's input handling (sharp conversions, `input_file`/`input_image` routing, size caps).
2. **Classify**: LLM pass (strict json schema) → `document_type` + confidence, against the registered type list.
3. **Extract**: run the type's `extraction_schema` (each document type registers one — the same schema family as its `params`) with the hardened untrusted-content prompt. Retries → heuristic fallback → `needs_review`, mirroring receipts.
4. Create a `documents` instance: `source:"uploaded"`, `params` = extracted values, `outputs` = detected artifacts (e.g. an existing wet signature → `{type:"signature", method:"detected"}`), file kept as the render source (`ingestion:{media_id, extraction, attempts[], confidence}`), status `needs_review` until confirmed.
5. Emits `document.ingested`; review UI is the `fill` profile over a side-by-side of the file and the extracted fields.

Result: an uploaded competitor proposal PDF and a generated FirstMate proposal answer the same queries (`params.payment_schedule`, `params.total_cents`, `outputs.sig_customer`) through the same API. Receipts migrate to be `document_type:"receipt"` instances whose apply/attribution flow stays in `payments/` unchanged.

---

## 13. Module layout & API surface

```
public/v1/documents/
  schemas.ts        DocModel + params/outputs/theme zod schemas (isomorphic source of truth)
  storage.ts        collections, template versioning, snapshotting
  service.ts        lifecycle, param resolution, output recording, event emission
  render.ts         server render orchestration (resolve widget data, drive harness)
  pdf.ts            Playwright pipeline (generalized from proposals/pdf.ts)
  ingestion.ts      classify + extract + instance creation
  types/registry.ts document type registry + built-in types
  widgets/registry.ts + widgets/*.ts   server halves of built-in widgets
  api.ts            routes (below)
  render/harness.html
public/libraries/
  doc-model/        format, expression engine, validation (browser build of schemas)
  doc-renderer/     DOM renderer + print CSS + fonts
  doc-widgets/      client halves of built-in widgets
  doc-editor/       engine, command bus, profiles, panels
  documents-api/    window.DocumentsAPI client
public/libraries/apps/
  documents/        studio (templates+themes), project tab, issuing flow
```

Routes (`/v1/documents`, platform auth + CSRF; public routes token-only):
`GET/POST /organizations/:orgId/document-templates[/:id]`, `.../versions[/:v]`, `POST .../publish`, same family for themes; `GET/POST /organizations/:orgId/projects/:projectId/documents`, `GET/PATCH/DELETE /documents/:id`, `POST /documents/:id/issue|send|snapshots|pdf`, `GET /documents/:id/pdf`, `POST /organizations/:orgId/documents/ingest`; public: `GET /public/:token`, `GET /public/:token/pdf`, `POST /public/:token/view|outputs/:key|payments/*`. Widget/type catalogs: `GET /catalog/widgets|types|themes` (drives editor palettes, like the automation catalog).

---

## 14. Rebuilding the three systems on the engine

- **Proposal** = document type `proposal`: params (project, contacts, scope_items, measurements, payment_schedule, choice groups), outputs (customer signature, selections, deposit payment), seeded templates porting today's cover/pricing/signature/fine-print pages onto the Margin/Triangles/Clean themes. Signing→work-plan activation keeps working because `scopes.activateFromProposal.v1` just re-targets `document.signed` for type `proposal`. `enrichedProposalScopePieces` freezing moves into the snapshot's resolved widget data.
- **Invoice** = type `invoice`: params (obligations, manual line items, tax), widgets (`doc.line_items`, `doc.payment_schedule`, `doc.pay_now`, `doc.qr`), server-issued via `documents.issue.v1` or the money tab; email delivery path unchanged. `invoiceHtml` and its duplicated themes are deleted.
- **Change order** = type `change_order`: first-class at last — amend gesture from a signed doc (§10.3), payment output wired to a supplemental obligation, portal companion for one-click payment, QR on the print.
- Deletion list at the end: `proposals/pdf.ts` HTML path specifics, `proposalPdfDocumentHtml` + page-building bulk of `apps/proposals/project.js`, `proposal_renderer.html`, `invoiceHtml`, `PROPOSAL_THEMES` CSS in `project-request/app.js`. (`apps/docs/project.js` was removed from this list by the 2026-08 consolidation — it is the surviving unified tab; see §2.)

## 15. Build phases

Each phase is shippable and testable on its own:

1. **Model + renderer + PDF** — DocModel schemas, expression engine, DOM renderer, harness, `renderDocumentPdf`. Prove: a hand-authored DocModel renders pixel-identical in portal-DOM and PDF. Tests: schema round-trip, expression eval, golden-page PDF page counts.
2. **Widgets + themes** — registry both sides; `line_items`, `signature`, `form_field`, `qr`, `photo`, `page_number`; Margin/Triangles/Clean as theme documents; org-token resolution.
3. **Templates/instances/snapshots/lifecycle** — collections, versioning, issue/send/public token/outputs/evidence, work events + `documents.issue.v1`, capability nodes, DocumentsAPI.
4. **Editor v1** — core engine + `document` and `fill` profiles + inspector + param binding UI; template studio app; project documents tab.
5. **Rebuild the three types** — proposal, invoice, change order end-to-end (portal companion, payments, signing, scope integration); delete legacy paths; port the portal's Proposals/Payments tabs onto the renderer.
6. **Editor v2 (`designer`) + ingestion** — free transform/rotate/shapes/filters/masters/theme editing; LLM ingestion + review flow; receipts adopt the type.
7. **Later (separate specs)**: portal-tab designer (`kind:"view"` + `inline` profile), website builder (new widget namespace + publishing), collaborative editing (command bus is already the right substrate).

## 16. Decisions taken (flagging for review)

1. **JSON scene graph, not HTML, as the stored format** — HTML is the render target, never the source of truth. Rationale: rails, bindings, theming, and programmatic manipulation all need a typed tree; HTML round-tripping is where document systems go to die. (The user's "HTML/JS as the language" instinct is honored one level down: CSS-mappable styles only, HTML as the universal render substrate.)
2. **Server-authoritative rendering** — the client never submits rendered HTML for PDF (today's proposal flow does; it's a correctness and trust hole). Costs a harness page; buys one render path.
3. **Non-Turing-complete expressions; widgets carry all real logic** — keeps documents safe to store/share/eval and keeps the escape hatch (registered code) governable.
4. **Platform JSON collections over SQLite** for storage — consistency with proposals/media/snapshots and the smallest number of substrates; template versioning copies the scope-template pattern onto collections. (Flip to SQLite later if listing perf demands it; the API doesn't change.)
5. **Overrides-as-patch** for instances — keeps templates authoritative and makes "update template, reissue" coherent; detach is explicit.
6. **Local QR generation** — new dependency, removes the external qrserver call from anything customer-facing.
7. **Naming**: module `documents`, format name **DocModel**. Bikeshed freely.

## 17. Open questions

1. **docx export** — is PDF/print/image/portal enough, or do we need editable-Word export for contracts? (Affects nothing structurally; it'd be a render target added later.)
2. **Per-contact fill sessions** — do we need multi-party signing ceremonies (ordered signers, per-signer tokens/fields) in v1, or is single-customer + internal countersign enough to launch?
3. **Choice-group repricing** — when a customer flips options in the portal, totals recompute from frozen snapshot data (safe) — confirm we never want live pricebook repricing post-send.
4. **LLM provider for ingestion** — receipts use OpenAI today; keep that pipeline as-is or standardize new ingestion on Anthropic? Engine treats it as a pluggable extractor either way.
