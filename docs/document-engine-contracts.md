# Document Engine — Implementation Contracts

Binding contracts between the engine's parts. If you are implementing one part,
build EXACTLY to these interfaces. The shared format library
`public/libraries/doc-model/firstmate-doc-model.js` (global `FMDocModel`,
also CommonJS-importable from Node) is the source of truth for the DocModel
JSON shape, expressions, override patches, theme tokens, validation, and
geometry — do not reimplement any of that; call it.

Companion spec: `docs/document-engine-spec.md`.

## Global/library names

| Library | Path | Global |
|---|---|---|
| doc-model | `public/libraries/doc-model/firstmate-doc-model.js` | `FMDocModel` |
| doc-renderer | `public/libraries/doc-renderer/firstmate-doc-renderer.js` (+ `doc-renderer.css`) | `FMDocRenderer` |
| doc-widgets | `public/libraries/doc-widgets/firstmate-doc-widgets.js` | `FMDocWidgets` |
| doc-editor | `public/libraries/doc-editor/firstmate-doc-editor.js` (+ `doc-editor.css`) | `FMDocEditor` |
| documents-api | `public/libraries/documents-api/documents-api.js` | `DocumentsAPI` |

All libraries are vanilla-JS IIFEs (match the style of `public/libraries/markup/firstmate-markup.js`),
no build step, no external CDNs. Fonts self-hosted under `doc-renderer/fonts/`.

## Coordinate + unit conventions

- Node frames are in **points** (pt) in the parent's space. Page size from
  `FMDocModel.paperDimensions(doc)` (letter = 612×792pt).
- On screen, render at `1pt = (96/72)px` times an optional `scale` — the
  renderer exposes its scale so the editor can convert pointer px → pt.
- Shape `points[]` / path `d` are normalized 0..1 within the node frame.
- Markup layer items are normalized 0..1 (existing Markup convention).

## 1. Renderer contract (`FMDocRenderer`)

```js
FMDocRenderer.render(container, {
  document,          // RESOLVED DocModel (FMDocModel.resolveBindings output)
  theme,             // theme definition object (tokens, page_masters, type_styles, widget_skins)
  themeContext,      // { branding, overrides } for resolveThemeTokens
  mode,              // "interactive" | "static"  (static = print/PDF: no handlers, deterministic)
  widgetData,        // { [node_id]: resolvedData } from server widget resolution
  widgetContext,     // passed through to widget renderers (see §2: submitOutput, api, publicToken, ...)
  scale,             // optional CSS scale (default 1); renderer sets data-scale on root
  pageRange,         // optional [start,end] page indexes
}) -> handle
```

`handle`:
- `handle.destroy()`
- `handle.update(next)` — re-render with changed inputs (may be full re-render)
- `handle.pageElements()` — ordered array of page root elements
- `handle.nodeElement(nodeId)` — DOM element for a node (editor uses this for overlays)
- `handle.scale` — current pt→px scale factor
- `handle.setScale(scale)` — scale-only fast path: retransforms the existing
  render in place (no teardown/rebuild). Hosts use it for zoom.
- `handle.measureNode(nodeId)` — { x, y, w, h } in pt within its page.
  Absolute page children remain PAGE-relative everywhere: Visual, Doc,
  Preview, interactive delivery, HTML export, and static/PDF output all use
  the authored coordinates. A page master's `content_inset` describes its
  safe area for authoring guidance; it must not add a render-only offset.
  `applyThemeMargins: true` exists only as an explicit legacy compatibility
  mode for documents being migrated from the old 40pt design-box mapping.

DOM/CSS requirements:
- Page root: `<section class="fmdoc-page" data-page-id data-role>` sized in pt
  (CSS `width: 612pt` etc.); interior nodes absolutely positioned per frame,
  `transform: rotate(Ndeg)` about center, z-index from `frame.z`.
- Every node element carries `data-node-id` and `data-node-type`.
- Flow frames use flexbox per `props.flow`.
- Style mapping MUST go through `FMDocModel.fillToCss/filtersToCss/fontToCss`.
- Theme: renderer computes `resolveThemeTokens(theme, themeContext)` and sets
  the variables on the render root; page masters (`pageMasterForRole`) render
  their `chrome` nodes UNDER page children (chrome is non-interactive,
  `data-chrome="true"`, never hit-testable in the editor).
- Print: `doc-renderer.css` includes `@media print` + `.fmdoc-print` rules —
  zero page margins (`@page { size: ...; margin: 0 }`), `break-after: page`
  on `.fmdoc-page`.
- Pagination: a flow frame with `props.overflow === "paginate"` that overflows
  its page splits its children across cloned continuation pages at render time
  (clone page chrome, continue the flow). Widgets that paginate (line-item
  tables) do so through the same mechanism by rendering rows as flow children.
- Static mode completion: after all images decode + widget static renders
  resolve, set `container.__fmdocReady = true` and dispatch a
  `fmdoc:ready` CustomEvent on the container. The PDF harness waits for this.
- Unknown widget id → render a neutral placeholder box with the widget id
  text; never throw.

## 2. Widget contract (`FMDocWidgets`)

```js
FMDocWidgets.register({
  id: "doc.line_items",          // namespaced, lowercase
  version: 1,
  title: "Line items",
  icon: "fa-table-list",         // editor palette
  category: "data",              // data | input | media | layout | commerce
  defaults: { config: {...}, frame: { w: 540, h: 220 } },  // for editor insertion
  configPanel: [ ... ],          // editor inspector schema (see §4 fields DSL)
  renderStatic(el, ctx) {},      // MUST be synchronous-completing or return Promise
  renderInteractive(el, ctx) {}, // may attach handlers; return optional { destroy() }
});
FMDocWidgets.get(id, version) -> definition | null   // version fallback: highest <= requested
FMDocWidgets.list() -> definitions[]
```

Widget render context `ctx`:
```js
{
  node,            // the resolved widget node (props.config already interpolated)
  config,          // node.props.config shortcut
  data,            // server-resolved data for this node (widgetData[node.id]), may be null
  mode,            // "static" | "interactive"
  scope,           // { params, outputs, computed, theme, org, project, customer, doc }
  themeVars,       // resolved CSS var map
  skin,            // theme.widget_skins[widget.id] || {}
  submitOutput(key, value),   // interactive only; wired to DocumentsAPI public/internal output submission
  outputs,         // current output values for the document
  api,             // { publicToken?, documentId?, orgId? } + DocumentsAPI reference when available
  refresh(),       // ask host to re-render this widget node
}
```

Rules:
- Static render must be deterministic from `node + data + scope + theme` — no
  fetches. If `data` is null, render from `config`/`scope` params where
  possible, else a clearly-labeled placeholder.
- Interactive renders submit outputs ONLY via `ctx.submitOutput`.
- All money in integer cents. Use `FMDocModel.formatters.money`.

Built-in set v1 (ids): `doc.line_items`, `doc.payment_schedule`, `doc.pay_now`,
`doc.signature`, `doc.form_field`, `doc.choice_group`, `doc.qr`, `doc.photo`,
`doc.photo_grid`, `doc.page_number`, `doc.video`.

`doc.line_items` data shape (produced by the server resolver, consumed by the client renderer):
```js
{ rows: [{ id, depth, name, description, quantity, unit, unit_price_cents, amount_cents,
           included, optional, selected, selectable_by, group_id, media: [{media_id, variant, url}] }],
  totals: { subtotal_cents, tax_cents, tax_percent, total_cents, currency },
  columns: ["name","description","qty","unit_price","amount"] }
```
Config keys: `source` ("params.scope_items" path), `show_prices`, `show_included`,
`show_media`, `columns`, `depth`, `group_by`, `compact` (legal-style single-flow).

`doc.signature` output value shape (matches proposal e-sign):
`{ type: "typed"|"drawn", text, signer_name, style, image_data?, signed_at, evidence? }`.

`doc.qr`: local generation — implement a self-contained QR encoder in the
widget (byte mode, EC level M, versions 1-10 are sufficient) rendering to SVG.
No external services. Default payload: `ctx.api.portalUrl || config.url`.

## 3. Backend contract (`public/v1/documents/`)

Module mounted at `/v1/documents` via `registerDocumentsApi` (follow
`proposals/api.ts` patterns: `requirePlatformAuth`, CSRF, zod schemas).

Collections (added to `platform/storage.ts` COLLECTIONS by the integrator —
do NOT edit that file; import and use):
`document_templates`, `document_template_versions`, `documents`,
`document_snapshots`, `document_events`, `document_themes`.

Storage shapes (in `data`):
- template: `{ name, document_type, status: "draft"|"active"|"archived", current_version, tags[], description, preview_media_ref, metadata: { preset, preset_revision, based_on_preset } }`
- template version: `{ template_id, version, definition: DocModel, checksum, published_at, published_by }`
- theme: same versioning pattern, `definition` = theme object
- document instance: `{ document_type, title, template_ref: { template_id, version } | null, theme_ref, theme_overrides, project_id, contact_ids[], params, param_defs, output_defs, overrides: OverrideOp[], outputs: { [key]: value }, status, delivery: { public_token, sent_at, first_viewed_at, current_snapshot_id, recipients[] }, pdf: { latest_media_id, latest_media_ref, page_count, generated_at }, source: "generated"|"uploaded", ingestion? }`
- snapshot: `{ document_id, snapshot_number, reason: "send"|"sign"|"pdf"|"manual", resolved_definition (post-override, post-binding DocModel), widget_data: { [node_id]: data }, theme (frozen definition), theme_vars, params, outputs, evidence, public_token, pdf: { media_id, media_ref }, locked: true }`

Instance status lifecycle: `draft → issued → sent → viewed → signed → completed`
(+ `declined | expired | void`); `signed`/`completed` computed via
`FMDocModel.requiredOutputsSatisfied(output_defs, outputs, gate)` — never set directly.

Server widget resolvers (`widgets/registry.ts`):
```ts
registerDocumentWidgetResolver(id: string, resolver: (ctx: WidgetResolveContext, config) => Promise<unknown>)
// ctx: { organizationId, document, params, project, snapshot?, services: { pricebook, payments, media, platform } }
```
Resolvers run at snapshot creation and on-demand render; results keyed by node id.

Document type registry (`types/registry.ts`):
```ts
registerDocumentType(id, { label, icon, param_schema, output_schema, default_theme_id?, seeded_templates?: [...], behaviors?: { on_signed?: string[] } })
```
Built-ins: `proposal`, `invoice`, `change_order`, `contract`, `work_order`, `generic`.

Routes (org routes need `view_projects`; template/theme writes need `manage_company_settings`):
```
GET/POST        /organizations/:orgId/templates            (list supports ?document_type=&status=)
GET/PATCH/DELETE /organizations/:orgId/templates/:templateId
GET             /organizations/:orgId/templates/:templateId/versions[/:version]
POST            /organizations/:orgId/templates/:templateId/publish   { definition, expected_version } -> bumps current_version
Same family for  /organizations/:orgId/themes
GET             /organizations/:orgId/catalog              -> { widgets, types, themes, fonts } (editor palette data)
GET/POST        /organizations/:orgId/projects/:projectId/documents   (create: { document_type, template_id?, title?, params? })
GET/PATCH/DELETE /organizations/:orgId/documents/:documentId          (PATCH: { params?, overrides?, title?, theme_ref?, expected_revision, template_ref?, workflow_ref? })
                 Draft re-template: PATCH template_ref { template_id, version? } / workflow_ref { workflow_id, version? } repoints a DRAFT
                 at another published template/workflow (409 document_not_draft otherwise). The new template's params/outputs MERGE into
                 param_defs/output_defs (template wins over stale defs; param VALUES untouched); workflow_state resets current_step to the
                 new workflow's first step and prunes completed_steps to surviving step ids. Used by the rail doc card's
                 "Add variant" convert flow (standard proposal -> tpl_three_option_proposal + wfl_three_option_proposal).
POST            /organizations/:orgId/documents/:documentId/resolve   -> { resolved_definition, widget_data, theme, theme_vars } (editor/preview live resolution)
POST            /organizations/:orgId/documents/:documentId/issue|send|snapshots
POST/GET        /organizations/:orgId/documents/:documentId/pdf
POST            /organizations/:orgId/documents/:documentId/outputs/:key   (internal fill)
Public (no auth): GET /public/:token   -> { snapshot, document: { id, status, document_type }, workflow: { payment_summary? } }
                POST /public/:token/view
                POST /public/:token/outputs/:key   { value, evidence } -> records output, recomputes status, emits events
                GET  /public/:token/pdf
```

PDF: `pdf.ts` generalizes `proposals/pdf.ts` (copy the Playwright browser
resolution + readiness logic). `render.ts` builds the harness HTML: inline the
doc-model/doc-renderer/doc-widgets library sources + `doc-renderer.css` +
font-face CSS, inject `{ document, theme, themeContext, widgetData, scope }`
as JSON, call `FMDocRenderer.render(document.body, { mode: "static", ... })`,
wait for `fmdoc:ready`/`__fmdocReady`, then `page.pdf({ width/height from
FMDocModel.paperDimensions, printBackground: true, preferCSSPageSize: true })`.
Store via `storeMediaUpload({ ownerType: "document", ownerId, slot })`.

Events: emit through `emitWorkEvent` with types `document.issued|sent|viewed|
output.recorded|signed|completed|declined|ingested|payment.received`, payload
`{ document_id, document_type, template_id, project_id }`. (Event registration
in `work/events.ts` is done by the integrator.)

Param resolution for issue (`service.ts`): explicit values → `{{...}}`
interpolation against `{ project, customer, org }` via
`FMDocModel.interpolate` → template `params` defaults →
`FMDocModel.paramDefaultValue`. Unresolved required params → status stays
`draft` and response includes `missing_params[]`.

## 4. Editor contract (`FMDocEditor`)

```js
FMDocEditor.mount(container, {
  document,            // working DocModel (template definition or instance-resolved-with-overrides)
  theme, themeContext,
  profile,             // "designer" | "document" | "fill" | "inline"
  editPolicy,          // doc.edit_policy override (merged: doc policy ∧ caller policy)
  widgetData,          // optional pre-resolved widget data for preview
  resolveScope,        // scope data for live binding preview { params, project, ... }
  catalog,             // { widgets, themes, fonts, params } for palettes/pickers
  media,               // { pick(): Promise<mediaRef>, url(mediaRef, variant): string }
  onChange(doc, changeMeta),   // debounced document changes (autosave hook)
  onCommand(cmd),              // observe applied commands (integration hooks)
  onSelect(nodeIds),
  onRequestData(kind, cb),     // e.g. "scope_items" -> host supplies pricebook picker
}) -> editor
```

`editor`: `getDocument()`, `setDocument(doc)`, `apply(command)`, `undo()`,
`redo()`, `select(ids)`, `selection()`, `zoom(scaleOrFit)`, `setProfile(p)`,
`destroy()`, `on(event, fn)` (`change|selection|profile|dirty`).

Command bus — ALL mutations go through `editor.apply({ type, ... })`:
`node.set`, `node.insert`, `node.remove`, `node.move`, `node.reorder`(z),
`node.group`, `node.ungroup`, `page.insert`, `page.remove`, `page.move`,
`page.set`, `doc.set`, `text.edit` (block/run replacement). Commands map 1:1
onto `FMDocModel` override ops where possible; command log powers undo/redo
(cap 200). Edit policy + per-node `locks` are enforced IN `apply()` — a
rejected command returns `{ ok: false, reason }` and UI affordances for locked
operations are hidden/disabled.

Profiles are feature-flag presets over:
`free_transform, rotate, resize, shapes, images, filters, text_style,
widget_insert, page_manage, group, z_order, theme_edit, bind_edit, unlock`.
`fill`: only widget inputs + nodes with `locks.content !== true` text editing.
The `unlock` affordance escalates profile up to `edit_policy.max_profile`.

UI regions (single shared component set): top toolbar (undo/redo, zoom,
insert, profile/unlock), left rail (pages/layers/palette tabs), right
inspector (selection properties; widget `configPanel` schema-driven), canvas
center (renders via `FMDocRenderer` in interactive mode + overlay layer for
handles/guides/marquee).

`configPanel` field DSL (used by widget defs AND node inspectors):
`[{ key, label, kind: "text"|"number"|"toggle"|"select"|"color"|"font"|"media"|"binding"|"list", options?, min?, max?, when? }]`.

`media` fields may further declare `accept` (for example `video/*`) and
`mediaKind`; the host picker must honor both. `list` fields may be primitive,
or structured repeaters using `itemLabel` plus `itemFields`, whose nested
fields use the same DSL (including media and select controls).

Keyboard: arrows nudge (shift=10), Del deletes, Ctrl/Cmd+Z / Shift+Z,
Ctrl/Cmd+D duplicate, Ctrl/Cmd+G / Shift+G group/ungroup, Esc deselect/exit
text edit.

## 5. Integration notes (owner: main session)

- `platform/storage.ts` COLLECTIONS + `capability_defs.ts` (`platform.documents`,
  runtime_app_id `documents`) + `work/events.ts` + `work/automations/builtins.ts`
  (`documents.issue.v1`) + `src/app.ts` mount + apps manifest — done centrally,
  not by library agents.
- Proposal editor app (`apps/documents/`) composes: DocumentsAPI + FMDocEditor
  (profile `document`, unlockable to `designer`) + a scope panel that loads
  line items from the project scope/pricebook into `params.scope_items`.
- Customer portal loads doc-model/doc-renderer/doc-widgets and renders
  snapshots from `GET /v1/documents/public/:token` in interactive mode.

---

# V2 CONTRACTS — editing tiers & workflow layer (see docs/document-editor-tiers-spec.md)

## 6. DocModel v2 (implemented in doc-model; additive)

New node types: `component_ref`, `repeater`, `page_break`. New node field
`anchor`: `"page"` (default, legacy behavior) | `"flow"` | `"inline"` |
`{ to_block, offset?, wrap? }`. New doc fields: `styles{}` (named block
styles), `components{}` (defs: `{ params, root, variants? }`), `chains{}`
(`{ body: { auto_pages, page_defaults:{role,margins_pt,columns,column_gap_pt},
keep_rules:{widow_lines,orphan_lines} } }`). Frames join a chain via
`props.chain = { id, index }`.

Resolution (`FMDocModel.resolveBindings(document, data)`):
- Component defs = `data.components` (server-merged template/library defs)
  overridden by `doc.components`. Helper: `mergedComponents(doc, ...sets)`.
- `component_ref` → inlined resolved subtree; instance root carries
  `component` (def name), `component_ref_id` (original node id), ref frame
  merged over root frame. `props.detached:true` skips inlining (children are
  the fork). Unknown def → node marked `resolved_component_missing`.
- `repeater` → node survives with `children` = one resolved instance per
  source row (`component` + `repeater_index` markers, deterministic ids
  `<repId>__i<n>_*`). `props.layout` + `props.break_rules` drive renderer
  pagination. `props.source` accepts any list expression.
- Text styles: blocks may carry `style_ref`; resolution helper
  `resolveStyleRef(ref, doc, theme)` (doc.styles over theme.type_styles);
  renderer applies ref first, then block/run inline overrides.
  `availableStyleRefs(doc, theme)` feeds style dropdowns.
- `instantiateComponent(def, input, scope, ctx, idBase)` exported for editor
  def-preview use.

## 7. Renderer v2 requirements (doc-renderer)

- **Chains**: lay out `anchor:"flow"` blocks through chained frames
  (`props.chain.id/index` order), splitting paragraphs at LINE level with
  `keep_rules` widow/orphan enforcement; `auto_pages` chains append pages
  built from `page_defaults` (margins → one chained frame per column,
  `columns`/`column_gap_pt`). `page_break` nodes force a frame break.
- **Anchors**: `inline` nodes render in the run stream (inline-block);
  `{to_block}` floats render beside their block with text wrap
  (float/shape-outside); `page` unchanged.
- **Repeaters**: instances are the split units; honor `break_rules`
  (`repeat_header` re-renders instance index 0 per segment when it is a
  header component, `min_rows_per_segment`, `keep_with_next`). Reuse the
  existing rows-splitting machinery.
- **Styles**: blocks with `style_ref` resolve through
  `FMDocModel.resolveStyleRef(ref, doc, theme)` before inline overrides.
- **Masters**: optional `header`/`footer` slots on page masters
  (`{ frame_h_pt, chrome:[nodes] }`) rendered on every matching page;
  `doc.page_number` works inside them.
- **Editor hooks**: rendered elements carry `data-component`,
  `data-component-ref`, `data-repeater-index`, `data-chain` attributes;
  `measureNode` continues to work for all new types. Add
  `handle.chainMetrics(chainId)` → per-frame fill info for Doc-mode caret
  work.
- Static/PDF path unchanged (harness + `__fmdocReady`).

## 8. Workflow contract

Collections (already in the platform allow-list? NO — integrator adds
`document_workflows`, `document_workflow_versions`): versioned like templates.

Definition: `{ schema_version:1, name, contract:{params,outputs},
steps:[{ id, title, when?, audience?:["internal","customer"],
items:[{ kind, writes, label?, when?, source?/options_from?, prefill?,
presentation?, required? }] }], audiences:{...} }`.

Item kind registry (server `documents/workflows/kinds.ts` + client runtime):
`text, currency, number, select, multi_select, boolean, date, measurements,
media_picker, piece_picker, choice_group, line_item_editor, review,
signature, payment`. Each kind: server validate/normalize + client renderer
(one renderer per kind used by ALL surfaces; the rich param editors in
apps/documents are extracted/reused).

Runtime: `public/libraries/doc-workflow/firstmate-doc-workflow.js` (global
`FMDocWorkflow`): `mount(container, { workflow, audience, state:{params,
outputs}, contract, onWrite(path,value), onStepChange, preview:{resolve():
Promise<resolved>, mount(el)}, services:{pricebook, scopeBridge, media} })`.
Workflow state lives ON the document instance (params/outputs) — no separate
store; `onWrite` PATCHes the instance (debounced) exactly like the Data panel.

Sources (server `documents/sources/registry.ts`):
`registerDocumentSource(id, { params_schema, resolve(ctx, args), shape })`.
Callable from param defaults / repeater sources / workflow `options_from` via
the sugar string `"source:<id>"` or expression fn `source('<id>', {...})`
(server injects resolved values into the resolution scope under
`sources[...]` before resolveBindings; documents never call the network).
Built-ins v1: `measurements.project`, `pricebook.category`,
`materials.order_lines`, `payments.obligations`.

Document types gain `default_workflow_id`; scope templates may reference
document bundles `{document_type, template_id?, workflow_id?, trigger}`.

## 9. Editor v2 (doc-editor)

- Mode switcher API: `editor.setMode("visual"|"doc"|"preview")`,
  `on("mode")`. Modes are surfaces over the same command bus/undo stack.
- Doc mode: caret editing projected over chain content (contenteditable per
  chain, repagination debounced ~120ms on idle — NOT per keystroke), style
  dropdown (style_ref application = command `text.set_style_ref`), toolbar
  (bold/italic/underline/lists/align), Insert menu (image/table/checkbox/
  page_break/component/repeater/widget), margins + page-number controls
  writing chain `page_defaults` and master header/footer usage.
- Visual mode additions: component instance badges; "Edit component" opens
  def editing in place (edits apply to all instances — DEFAULT); "Detach
  instance" forks (`component_ref.props.detached=true` + children); anchor
  control in inspector; chain link chrome on chained frames; repeater
  inspector (source binding, layout, break rules).
- New commands: `component.update_def`, `component.detach`,
  `chain.set_defaults`, `text.set_style_ref`, `node.set_anchor` — all
  expressible as override ops (`doc.set components.X`, `node.set` etc.).

## 10. Website builder additions (see docs/web-builder-spec.md)

All additive; behavior for `kind: "document"` is unchanged.

### doc-model

- `node.props.link = { href?, page?, target? }` — allowed on ANY node type.
  `href` is a full/relative URL; `page` is a site-page slug resolved by the
  host at render time; `target` is `"_self"` (default) or `"_blank"`.
  `validateDocument` soft-checks the shape (strings + valid target) and
  tolerates extra keys.

### doc-renderer

- Nodes with `props.link` render as `<a class="fmdoc-link">` in BOTH modes —
  the anchor IS the node element (it keeps `data-node-id`/`data-node-type`
  and its frame positioning, so overlays/hit-testing/measureNode are
  untouched). `target:"_blank"` adds `rel="noopener"`. href resolution:
  `link.href`, else `widgetContext.resolvePageHref(link.page)` when the host
  supplies it (site runtime + portal do; documents don't → page-only links
  render without an anchor). Inside an editor canvas (`.fmde-root` /
  `[data-fmde]` ancestor) a delegated guard suppresses navigation so clicks
  keep selecting.
- New `widgetContext.resolvePageHref(slug) -> href` key, passed through to
  widget render ctx as `ctx.resolvePageHref` (used by `web.nav_menu` to
  finalize slug links exactly like node links).

### doc-editor

- `FMDocEditor.registerProfile(name, flags, { rank }) -> flags` — registers
  (or replaces) a profile without editing the library. Flag keys are
  validated against `FEATURE_KEYS` (throws on unknown keys); missing keys
  default to false; array values are per-id allow-lists (`widget_insert`).
  `rank` slots the profile into the unlock ladder (fractional ok; default =
  document's rank). Exported `PROFILE_RANK` mirrors the ladder.
- Built-in `website` profile (registered through that same API), rank 2.5
  (between document and designer): everything on EXCEPT `page_manage`,
  `theme_edit`, `bind_edit`, `unlock`.
- `insertTabAvailable` is flag-driven now:
  `widget_insert || shapes || images` (identical outcome for the built-ins).
- View-doc fixes: double-click insert works with `currentPageId === null`
  (inserts into the view root), selection/hit-testing/layers map onto the
  renderer's synthetic `view_root` page, and `zoom("fit-width")` fits the
  view's actual design width (root frame may exceed `settings.paper`).
- `mount(container, { viewportWidth })` +
  `editor.setViewportWidth(px|null)` (view docs only): constrains the stage
  to a CSS pixel width and rescales — the mobile-preview surface, mirroring
  the site runtime's `min(1, width / designPx)` scaling. Emits `"viewport"`
  with the active width (null = auto fit-width). `getViewportWidth()` reads
  it back.
- Inspector "Link" section (profiles with `text_style`): URL input, page-slug
  input, "new tab" toggle writing `node.props.link` (empty fields prune keys;
  fully empty → `props.link = null`).

### web-widgets (`public/libraries/web-widgets/firstmate-web-widgets.js`)

Global `FirstMateWebWidgets`; registers into the SAME `FMDocWidgets`
registry (load after doc-widgets). Widget ids:

- `web.lead_form` — category `input`, config `{ form_id }` (per-org options
  baked by the websites catalog). Interactive: lazy-loads
  `libraries/lead-embed/firstmate-lead-embed.js` (resolved relative to its
  own script src) and mounts `FirstMateLeadEmbed.render`. Static/editor: a
  labeled placeholder card (`fa-envelope-open-text`, title from
  `ctx.data.form_title`).
- `web.nav_menu` — category `layout`, config `{ source: "header"|"footer",
  layout: "horizontal"|"vertical", align, gap_pt, link_style:
  "plain"|"pill"|"underline" }`. Links from server-resolved `ctx.data.links`
  (`[{ slug, title, href }]`), else `ctx.scope.site.nav`, else placeholders.
  Hrefs finalize via `ctx.resolvePageHref(slug)` when present, else
  `link.href`, else a non-navigating `#`; in-editor clicks never navigate.

CSS embedded + self-injected as `<style id="fm-web-widgets-styles">`; theme
colors via `var(--fm-primary)`.

### Image fills (drop-media-onto-shape)

- `style.fill = { type: "image", media: { media_id, variant? } | { url },
  fit?: "cover", fallback_color? }` — valid on **frame and shape nodes only**
  for now (table cells and text nodes resolve it to `fallback_color`).
  `fit` defaults to `"cover"` (the only contracted value; `"contain"` is
  tolerated on frames). `fallback_color` paints while/if the URL is missing
  or unloadable.
- doc-model: `fillToCss` returns `fill.fallback_color || ""` for
  `type: "image"` — a CSS string cannot express the fill, so string callers
  degrade to the fallback. Validation tolerates the shape; nothing else in
  the model changes.
- doc-renderer (interactive AND static modes):
  - URL resolution goes through the SAME path as image nodes:
    `rctx.resolveMediaUrl(fill.media, fill.media.variant)` — i.e.
    `media.url` first, else `opts.mediaUrl`, else the platform media route
    from `opts.orgId`. No URL → fallback color, never a broken layout.
  - FRAME nodes: `background-image` + `background-size: cover` /
    `background-position: center` / `background-repeat: no-repeat`, with
    `background-color: fallback_color` underneath. `style.radius` clips the
    image (backgrounds clip to the border box).
  - SHAPE nodes: a per-node `<pattern patternUnits="userSpaceOnUse"
    width=frameW height=frameH>` containing an optional `fallback_color`
    under-rect plus `<image preserveAspectRatio="xMidYMid slice">`; the
    geometry is painted `fill="url(#id)"` so ellipse/polygon/rounded shapes
    crop the image naturally. Stroke unchanged. Pattern ids are unique per
    render (node id + random suffix) so multiple renders never collide.
- Backend: the server-side URL-attachment walks
  (`attachImageMediaUrls` in `public/v1/documents/service.ts` for document
  renders/PDF, and in `public/v1/websites/service.ts` for site-page
  resolution) also visit every node's `style.fill`: `type: "image"` with a
  `media_id` and no `url` gets one attached exactly like `props.media` on
  image nodes (data URI for static/PDF targets in the documents walk).

### Cross-section drag (doc-editor, view docs)

- During a move gesture every dragged element is visually lifted
  (`z-index: 9999`, restored on release): sections keep `z: auto`, so the
  lifted child paints above later sibling sections' backgrounds instead of
  vanishing beneath them mid-drag.
- On commit, a node whose parent is a page section and whose final
  PAGE-space center lies inside a DIFFERENT section's box is REPARENTED
  into that section: same node id, `frame.x/y = pagePos − newSectionOrigin`,
  then `frame.position.x` is recomputed against the new immediate parent's
  rendered width while preserving the node's selected unit and anchor
  (y clamped to `0..sectionH − nodeH`, min 0), `frame.z` = topmost z in the
  new section + 1. Implemented as ONE undoable batch —
  `node.move { parent_id, frame:{x,y} }` (its inverse restores the original
  parent, index and frame) plus `node.set frame.z`. Undo restores the
  original parent AND frame in a single step.
- Dropping below the last section / on no section keeps the old parent.
  Sections themselves and nodes whose parent is not a section never
  reparent. Reparenting never produces NaN (non-finite geometry falls back
  to a plain in-parent move).
- Every view-section descendant created through insert, paste, duplicate,
  group/ungroup, agent generation, seed construction, or the website save API
  passes through `normalizeViewHorizontalPositions`. This is an invariant at
  the shared command/API boundaries, not a UI-only migration. Drag, resize,
  keyboard nudge, align/distribute, and cross-section move all recompute the
  canonical offset from the concrete gesture frame before commit.
- The same normalization assigns every absolute website-section descendant a
  canonical `frame.responsive` contract. Missing values become
  `{mode:"auto",width:"fixed",height:"fixed"}`; manual-only width/height
  settings remain dormant while Auto Resize is active. Auto rendering derives
  x/y/w/h from the immediate parent's authored width, scales the containing
  section by that same ratio, and clusters vertically overlapping siblings as
  one row. A following row therefore preserves the authored gap after the
  prior row's maximum bottom instead of accumulating growth once per sibling.
  `kind:"document"` nodes are never normalized or rendered through this path.
- Independent mobile sections are paired model nodes, not editor-only state.
  `activeViewSections(doc,"mobile")` returns an enabled mobile pair or its
  desktop fallback; hit testing, insertion, selection, rendering, preview, and
  publishing use that same projection. A plain enable clones desktop geometry
  exactly. Magic regeneration removes the old pair and inserts a deterministic
  desktop-derived mobile frame in one `engine.apply` batch, so Ctrl-Z restores
  the entire previous mobile variant atomically.

### site-runtime (`public/libraries/site-runtime/firstmate-site-runtime.js`)

Global `FirstMateSiteRuntime.boot(config?)` — reads `window.__FM_SITE =
{ siteKey, pageSlug, basePath, apiBase }`; fetches
`GET {apiBase}/public/site/:siteKey/manifest` + `/page/:slugOr~home` in
parallel (credentials omitted) plus `~header`/`~footer` when published;
renders each section via `FMDocRenderer.render(..., { mode: "interactive",
widgetData: widget_data, themeContext: { overrides: theme_vars },
widgetContext: { resolvePageHref: slug => basePath + slug } })`; responsive
via ResizeObserver → `handle.setScale(min(1, width / designPxWidth))`; sets
`document.title`/meta description from page-then-site SEO; injects the chat
embed when `manifest.chat.widget_key` is set; friendly 404/error panels and
a loading skeleton. Served by `public/sites/index.php` (nginx
`location ^~ /sites/` + `router.php` fallback both rewrite
`/sites/<siteKey>[/<pageSlug>]` to it).
