/* public/libraries/platform-offline/contracts/documents.js
 *
 * Documents offline (docs/architecture/offline.md, "Documents").
 *
 * Read: a document that was opened, or that belongs to a pinned project: its record, its workflow, its sent
 * versions and the resolved definition the browser renders, plain and traced.
 *
 * Made and changed without a connection:
 *   - a document created from a template that is on the device (`document.create`, id made on the device);
 *   - its title, data, layout overrides, theme and contacts (`document.patch`, merged per field, per data key
 *     and per override item when it is sent);
 *   - values and text typed into the document as sent (`document.as_sent`, merged per value).
 *
 * What the page shows is what the server resolved last, with the person's changes applied to what a device can
 * apply (text, plain values) and everything the server computes (line amounts, totals, account figures, widget
 * data) marked as waiting for a connection (`deviceResolve`). The server's own resolve replaces it after the
 * sync. The document model (FMDocModel) does that work; the worker loads it here.
 *
 * Needs the server, and says so (documents-api.js): invoices, change orders, completion certificates and
 * documents with custom behavior (the server alone makes them), sending, presenting, signing, PDF, outputs and
 * workflow steps.
 */
(function () {
  'use strict';

  // The document model in the worker. Without it nothing below can be made on the device: every write then
  // behaves as if it had no contract, and reads still work.
  if (typeof importScripts === 'function' && !self.FMDocModel) { try { importScripts('/libraries/doc-model/firstmate-doc-model.js'); } catch (_) { /* documents stay read-only offline */ } }
  const model = () => self.FMDocModel || null;

  const DOCUMENTS = '/v1/documents/organizations/:org';
  const enc = encodeURIComponent;
  const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value) => String(value == null ? '' : value).trim();
  const list = (value) => (Array.isArray(value) ? value : []);
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
  const base = (ctx) => `/v1/documents/organizations/${enc(ctx.org)}`;
  const documentUrl = (ctx, id) => `${base(ctx)}/documents/${enc(id)}`;

  /** Types whose numbers and amounts the server works out when the document is made. */
  const SERVER_MADE_TYPES = new Set(['invoice', 'change_order', 'completion_certificate', 'payment_receipt']);
  /** Statuses a document can no longer be edited in (documents app, READ_ONLY_STATUSES). */
  const EDITABLE_STATUSES = new Set(['', 'draft']);
  /** What a patch may carry to be kept on the device. Anything else (a new template, a status, a project) needs the server. */
  const PATCH_FIELDS = ['title', 'params', 'overrides', 'theme_ref', 'theme_overrides', 'contact_ids', 'tags'];
  /** Params the server computes at every resolve (documents/inputs.ts RESOLUTION_ONLY_PARAMS). */
  const RESOLUTION_ONLY = new Set(['scope_rows', 'line_rows', 'conditional_rows', 'line_conditional_rows', 'scope_packages', 'pricing_rows', 'pricing_conditional_rows', 'spec_derived', '__sources', 'account', 'measurement_requirements']);
  /** Line lists and what a line stores itself (documents/inputs.ts, the documents.line_items rule). */
  const LINE_LISTS = new Set(['scope_items', 'line_items', 'pricing_adjustments', 'option_a_items', 'option_b_items', 'option_c_items']);
  const LINE_PLAIN_FIELDS = ['quantity', 'name', 'display_name', 'description', 'unit'];
  const PRICE_LEAVES = new Set(['amount_cents', 'unit_price_cents']);
  const PRICE_FIELDS = ['unit_price', 'unitPrice', 'base_price', 'basePrice', 'amount', 'total', 'total_price', 'totalPrice', 'amount_cents'];
  const DEVICE_ID = /^doc_[a-z0-9]{16,40}$/;
  /** What stands in for a figure only the server can work out, until it has. */
  const WAITING_FIGURE = '…';

  // ---------------------------------------------------------------------------------------------------------
  // What a pinned project downloads
  // ---------------------------------------------------------------------------------------------------------

  /** Everything the tab, the preview and the editors read for one document. */
  function documentReads(ctx, document) {
    const id = enc(document.id);
    const reads = [
      `${base(ctx)}/documents/${id}`,
      `${base(ctx)}/documents/${id}/snapshots`,
      // What the browser renders: bindings and widget data resolved by the server, as the preview and editor ask for it,
      // and with where each value comes from, as "Edit manually" asks for it.
      { url: `${base(ctx)}/documents/${id}/resolve`, body: {} },
      { url: `${base(ctx)}/documents/${id}/resolve`, body: { trace: true } }
    ];
    if (isObject(document.workflow_ref) && text(document.workflow_ref.workflow_id)) {
      reads.push(`${base(ctx)}/documents/${id}/workflow`, `${base(ctx)}/workflows/${enc(document.workflow_ref.workflow_id)}`);
    }
    if (isObject(document.template_ref) && text(document.template_ref.template_id) && document.template_ref.version != null) {
      reads.push(`${base(ctx)}/templates/${enc(document.template_ref.template_id)}/versions/${enc(document.template_ref.version)}`);
    }
    return reads;
  }

  /** The published version of every template a document can be made from, so New document works without a connection. */
  const TEMPLATE_LIMIT = 40;
  function templateReads(json, ctx) {
    return list(json && json.templates).filter((template) => isObject(template) && text(template.id) && text(template.status) === 'active' && Number(template.current_version) > 0)
      .slice(0, TEMPLATE_LIMIT)
      .map((template) => `${base(ctx)}/templates/${enc(template.id)}/versions/${enc(Number(template.current_version))}`);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Paths into a document's data
  // ---------------------------------------------------------------------------------------------------------

  const segments = (path) => String(path || '').split('.').filter(Boolean).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const at = (target, path) => path.reduce((value, key) => (value == null ? undefined : value[key]), target);
  const idOf = (row) => (isObject(row) && (typeof row.id === 'string' || typeof row.id === 'number') ? String(row.id) : null);

  /** documents/inputs.ts lineRowPath: { row, field } for a path (after "params") into a line list, or null. */
  function lineRowPath(rest) {
    let start = 0;
    if (LINE_LISTS.has(String(rest[0]))) start = 1;
    else if (rest[0] === 'proposal_options' && typeof rest[1] === 'number' && rest[2] === 'items') start = 3;
    else return null;
    if (typeof rest[start] !== 'number') return null;
    let end = start + 1;
    while (rest[end] === 'children' && typeof rest[end + 1] === 'number') end += 2;
    if (end !== rest.length - 1) return null;
    return { row: rest.slice(0, end), field: String(rest[end]) };
  }

  /**
   * Stored data laid over what the server resolved: plain values take the stored one, rows are matched by id,
   * and everything the server added (cents, projections) stays as it last was.
   */
  function overlayPlain(resolved, stored) {
    if (Array.isArray(stored)) {
      if (!Array.isArray(resolved)) return clone(stored);
      const named = (rows) => rows.length > 0 && rows.every((row) => idOf(row) !== null);
      if (named(stored) && named(resolved)) {
        const known = new Map(resolved.map((row) => [idOf(row), row]));
        return stored.map((row) => (known.has(idOf(row)) ? overlayPlain(known.get(idOf(row)), row) : clone(row)));
      }
      if (stored.length === resolved.length) return stored.map((row, index) => overlayPlain(resolved[index], row));
      return clone(stored);
    }
    if (isObject(stored)) {
      if (!isObject(resolved)) return clone(stored);
      const out = Object.assign({}, resolved);
      for (const key of Object.keys(stored)) out[key] = overlayPlain(resolved[key], stored[key]);
      return out;
    }
    return stored;
  }

  /** Rows the server projects from line lists (scope_rows, ...) show the plain fields of the line they come from. */
  function refreshProjections(scope) {
    const visit = (rows) => {
      for (const row of list(rows)) {
        if (!isObject(row)) continue;
        if (typeof row.source_path === 'string' && row.source_path) {
          const source = at(scope, segments(row.source_path));
          if (isObject(source) && (idOf(row) === null || idOf(source) === null || idOf(row) === idOf(source))) {
            for (const field of LINE_PLAIN_FIELDS) if (has(source, field) && !isObject(source[field])) row[field] = source[field];
          }
        }
        for (const key of ['children', 'rows']) if (Array.isArray(row[key])) visit(row[key]);
      }
    };
    for (const key of RESOLUTION_ONLY) if (Array.isArray(scope.params[key])) visit(scope.params[key]);
  }

  // ---------------------------------------------------------------------------------------------------------
  // The resolved view a device can make
  // ---------------------------------------------------------------------------------------------------------

  async function templateDefinition(ctx, document) {
    const M = model();
    const ref = isObject(document.template_ref) ? document.template_ref : {};
    const templateId = text(ref.template_id);
    if (!templateId) return (M.createBlankDocument || M.createDocument)({ metadata: { document_type: text(document.document_type) } });
    const pinned = Number(ref.version) || 0;
    const exact = pinned ? await ctx.saved(`${base(ctx)}/templates/${enc(templateId)}/versions/${pinned}`) : null;
    const found = exact || (await ctx.find('GET ' + DOCUMENTS + '/templates/:template/versions/:version'))
      .filter((read) => read.params.template === templateId)
      .sort((a, b) => Number(b.params.version) - Number(a.params.version))
      .map((read) => read.json)[0];
    const definition = found && isObject(found.version) ? found.version.definition : null;
    return isObject(definition) && Object.keys(definition).length ? definition : null;
  }

  /** The scope of a document no server has resolved yet: its own data and the records the device has. */
  async function madeScope(ctx, document) {
    const projectId = text(document.project_id);
    const saved = projectId ? await ctx.saved(`/v1/platform/organizations/${enc(ctx.org)}/projects/${enc(projectId)}`) : null;
    const project = saved && isObject(saved.document) ? Object.assign({ id: projectId }, saved.document.data) : (isObject(document.params.project) ? document.params.project : {});
    const contacts = list(project.contacts).filter(isObject);
    const customer = isObject(document.params.customer) && Object.keys(document.params.customer).length ? document.params.customer : (contacts.find((contact) => contact.primary === true) || contacts[0] || {});
    const orgRead = await ctx.saved(`/v1/platform/organizations/${enc(ctx.org)}`);
    const organization = orgRead && isObject(orgRead.organization) ? orgRead.organization : {};
    const branding = isObject(organization.branding) ? organization.branding : {};
    return {
      params: clone(document.params) || {},
      outputs: {},
      org: { id: ctx.org, name: text(organization.name), branding, logo_media_id: text(organization.logo_media_id), logo_url: text(organization.logo_url || branding.logo_node_url || (typeof branding.logo === 'string' ? branding.logo : '')), logo: organization.logo == null ? null : organization.logo },
      project,
      customer,
      doc: { id: document.id, status: 'draft', title: text(document.title), document_type: text(document.document_type), sent_at: null, first_viewed_at: null, last_viewed_at: null, signed_at: '', expires_at: '', valid_days: null },
      checkout: {},
      components: {}
    };
  }

  async function themeFor(ctx, document) {
    const themeId = text(isObject(document.theme_ref) ? document.theme_ref.theme_id : '');
    if (!themeId) return {};
    const catalog = await ctx.saved(`${base(ctx)}/catalog`);
    const theme = list(catalog && catalog.themes).find((item) => isObject(item) && text(item.id) === themeId);
    return theme && isObject(theme.definition) ? theme.definition : {};
  }

  /** The kind of each traced value in a resolved definition, by its data path (the server's own classification). */
  function tracedKinds(definition) {
    const kinds = new Map();
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (Array.isArray(node.runs)) for (const run of node.runs) {
        const binding = isObject(run) && isObject(run.binding) ? run.binding : null;
        if (binding && binding.path && binding.kind !== 'pinned' && (!kinds.has(binding.path) || binding.kind === 'input')) kinds.set(binding.path, binding.kind);
      }
      for (const child of Object.values(node)) if (child && typeof child === 'object') visit(child);
    };
    visit(definition);
    return kinds;
  }

  /** What a device can say about a value without the server's rules: only plain stored values are inputs. */
  function deviceKind(binding, document) {
    if (binding.kind !== 'input' || !binding.path) return binding.kind;
    const path = segments(binding.path);
    if (path[0] !== 'params' || path.length < 2) return 'derived';
    const key = String(path[1]);
    if (RESOLUTION_ONLY.has(key)) return 'derived';
    if (!has(document.params, key) && !has(document.param_defs, key)) return 'derived';
    const line = lineRowPath(path.slice(1));
    if (line && !LINE_PLAIN_FIELDS.includes(line.field)) return 'derived';
    return 'input';
  }

  /**
   * True for a value the server works out from the document's lines (an amount, a total, account figures), as
   * far as its expression tells. On a document made here those have no last value; other text made from data
   * (a name with a fallback) is as right on the device as anywhere.
   */
  function isFigure(binding) {
    const path = binding.path ? segments(binding.path) : null;
    if (path && path[0] === 'computed') return true;
    if (path && path[0] === 'params' && RESOLUTION_ONLY.has(String(path[1]))) return true;
    const named = path ? String(path[path.length - 1]) : String(binding.expr || '');
    return /computed\.|_cents|account|amount|total|price|balance|(scope_rows|line_rows|scope_packages|pricing_rows)/i.test(named);
  }

  /** A value as the document formats it where the value is shown. */
  function formatted(value, binding) {
    if (binding.format && !list(binding.format_args).length) {
      try { const shown = model().interpolate(`{{value | ${binding.format}}}`, { value }); if (shown != null && shown !== '') return String(shown); } catch (_) { /* shown plainly */ }
    }
    return String(value == null ? '' : value);
  }

  /** The text of a value typed while offline, as the document would format it. */
  function typedDisplay(write, binding) {
    return has(write, 'parsed') && binding.format && !list(binding.format_args).length ? formatted(write.parsed, binding) : String(write.text == null ? '' : write.text);
  }

  /**
   * The resolved definition as a device can make it: the document's template with its overrides, resolved
   * against the scope the server last gave (`last`, null for a document made here) with the stored data laid
   * over it. Runs carry `offline`: "pending" for a value typed here that the server has yet to store its way,
   * "stale" for a value only the server computes, when the data it follows changed here. Widgets and nodes made
   * from data carry `offline: "stale"` the same way.
   *
   * hint: { made, data, layout, writes: [{ path, text, parsed }] } for the change being applied.
   */
  async function deviceResolve(ctx, document, last, body, hint) {
    const M = model();
    const before = isObject(last) && isObject(last.offline) ? last.offline : {};
    const offline = {
      pending: true,
      made: !!(hint.made || before.made),
      data: !!(hint.data || before.data),
      layout: !!(hint.layout || before.layout),
      writes: [...list(before.writes), ...list(hint.writes)]
    };
    const restyled = !!(hint.theme || before.theme);
    if (!M || !isObject(document)) return last ? Object.assign({}, last, { offline: Object.assign(offline, { whole: true }) }) : undefined;
    const definition = await templateDefinition(ctx, document);
    // Without the template on the device the last resolved copy is all there is: it is shown as it was, marked as a whole.
    if (!definition) return last ? Object.assign({}, last, { offline: Object.assign(offline, { whole: true }) }) : undefined;
    const working = M.applyOverrides(definition, list(document.overrides)).document;
    const scope = isObject(last) && isObject(last.scope) ? clone(last.scope) : await madeScope(ctx, document);
    scope.params = isObject(scope.params) ? scope.params : {};
    for (const key of Object.keys(isObject(document.params) ? document.params : {})) scope.params[key] = overlayPlain(scope.params[key], document.params[key]);
    refreshProjections(scope);
    scope.doc = Object.assign({}, scope.doc, { title: text(document.title) });
    scope.components = M.mergedComponents(working, isObject(definition.components) ? definition.components : {});
    const traced = !!(isObject(body) && body.trace === true);
    const resolved = M.resolveBindings(working, scope, { trace: true });
    const kinds = isObject(last) && isObject(last.resolved_definition) ? tracedKinds(last.resolved_definition) : new Map();
    const typed = new Map(offline.writes.filter((write) => isObject(write) && write.path).map((write) => [String(write.path), write]));
    const follows = offline.data || offline.made;
    const lastScope = isObject(last) && isObject(last.scope) ? last.scope : null;
    const lastComputed = isObject(last) && isObject(last.resolved_definition) && isObject(last.resolved_definition.computed_values) ? last.resolved_definition.computed_values : null;
    // The figures a page reads off the answer (a document card's total) are the server's last ones too.
    if (follows && isObject(resolved.computed_values)) resolved.computed_values = lastComputed ? clone(lastComputed) : {};

    const markRuns = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(markRuns); return; }
      if (Array.isArray(node.runs)) for (const run of node.runs) {
        const binding = isObject(run) && isObject(run.binding) ? run.binding : null;
        if (!binding || binding.kind === 'pinned') continue;
        if (binding.kind === 'input' && binding.path) binding.kind = kinds.get(binding.path) || deviceKind(binding, document);
        const write = binding.path ? typed.get(binding.path) : null;
        const stored = binding.path ? at({ params: document.params }, segments(binding.path)) : undefined;
        if (write && (stored === undefined || isObject(stored) || PRICE_LEAVES.has(String(segments(binding.path).pop())))) { run.text = typedDisplay(write, binding); run.offline = 'pending'; }
        else if (follows && (binding.kind === 'derived' || binding.kind === 'calculated')) {
          run.offline = 'stale';
          const path = binding.path ? segments(binding.path) : null;
          // What is shown is the server's last figure, never one the device worked out: a computed value is the
          // last one the server gave, and a figure it never worked out for this document (the document was made
          // here, or its line was added here) is a placeholder.
          if (!lastScope) { if (isFigure(binding)) run.text = WAITING_FIGURE; else delete run.offline; }
          else if (path && path[0] === 'computed') { const value = at({ computed: lastComputed || {} }, path); run.text = value === undefined || value === null ? WAITING_FIGURE : formatted(value, binding); }
          else if (path && at(lastScope, path) === undefined) run.text = WAITING_FIGURE;
        }
        if (!traced) { delete run.binding; }
      }
      for (const [key, child] of Object.entries(node)) if (key !== 'runs' && child && typeof child === 'object') markRuns(child);
    };
    markRuns(resolved);

    // Pictures: the same file URLs the server gives an interactive resolve.
    const mediaUrl = (ref) => {
      const mediaId = isObject(ref) ? text(ref.media_id || ref.mediaId || ref.id) : '';
      if (mediaId && !text(ref.url)) ref.url = `/v1/platform/organizations/${enc(ctx.org)}/media/${enc(mediaId)}/file?variant=${enc(text(ref.variant) || 'original')}`;
    };
    // As-sent text: which nodes can be typed into, and whether the template's text moved under an edit (service.ts annotateAsSentNodes).
    const templateText = new Map();
    M.walkNodes(definition, (node) => { if (text(node.type) === 'text' && text(node.id)) templateText.set(text(node.id), M.fingerprint(list(isObject(node.props) ? node.props.blocks : null))); });
    const textOps = new Map();
    for (const op of list(document.overrides)) if (isObject(op) && op.op === 'node.set' && op.prop === 'props.blocks' && text(op.node_id)) textOps.set(text(op.node_id), op);
    M.walkNodes(resolved, (node) => {
      if (text(node.type) === 'image' && isObject(node.props)) mediaUrl(node.props.media);
      if (isObject(node.style) && isObject(node.style.fill) && text(node.style.fill.type) === 'image') mediaUrl(node.style.fill.media);
      if (text(node.type) === 'widget' && follows) node.offline = 'stale';
      if (!traced) { delete node.generated; return; }
      if (text(node.type) !== 'text' || node.generated === true || !text(node.id)) return;
      const fingerprint = templateText.get(text(node.id)) || null;
      const op = textOps.get(text(node.id));
      const opBase = op ? text(op.base) : '';
      node.as_sent = { fingerprint, edited: !!op, conflict: !!(op && opBase && fingerprint && opBase !== fingerprint) };
    });

    const theme = isObject(last) && isObject(last.theme) && !restyled ? last.theme : await themeFor(ctx, document);
    const themeVars = isObject(last) && isObject(last.theme_vars) && !restyled ? last.theme_vars : M.resolveThemeTokens(theme, { branding: isObject(scope.org) && isObject(scope.org.branding) ? scope.org.branding : {}, overrides: isObject(document.theme_overrides) ? document.theme_overrides : {} });
    return {
      ok: true,
      resolved_definition: resolved,
      widget_data: isObject(last) && isObject(last.widget_data) ? last.widget_data : {},
      sources: isObject(last) && isObject(last.sources) ? last.sources : {},
      theme,
      theme_vars: themeVars,
      scope,
      offline
    };
  }

  // ---------------------------------------------------------------------------------------------------------
  // A document made on this device
  // ---------------------------------------------------------------------------------------------------------

  /** documents/service.ts resolveDocumentParams: given values, then each declared default, with {{...}} filled from the project, customer and organization. */
  function resolveParams(paramDefs, explicit, scope) {
    const M = model();
    const entities = { project: scope.project || {}, customer: scope.customer || {}, org: scope.org || {} };
    const fill = (value) => {
      if (typeof value === 'string' && M.hasInterpolation(value)) return M.interpolate(value, entities);
      if (Array.isArray(value)) return value.map(fill);
      if (isObject(value)) { const out = {}; for (const [key, entry] of Object.entries(value)) out[key] = fill(entry); return out; }
      return value;
    };
    const params = {};
    for (const [key, def] of Object.entries(paramDefs)) {
      const given = explicit[key];
      if (given !== undefined && given !== null && given !== '') { params[key] = fill(given); continue; }
      const fallback = M.paramDefaultValue(isObject(def) ? def : {});
      params[key] = typeof fallback === 'string' && M.hasInterpolation(fallback) ? fill(fallback) : fallback;
    }
    for (const [key, value] of Object.entries(explicit)) if (!(key in params)) params[key] = fill(value);
    return params;
  }

  const tags = (...lists) => [...new Set(lists.flatMap((values) => list(values)).filter((tag) => typeof tag === 'string').map((tag) => tag.trim().normalize('NFKC').toLowerCase()).filter(Boolean))];
  const projectOf = (ctx) => text(ctx.params.project);

  /**
   * The document the create route answers with, as far as a device can know it (documents/service.ts
   * createDocumentInstance). It throws when the device does not have what the route would read (the type, the
   * template's published version, its workflow), so the create is then not queued and the page is told it needs
   * a connection.
   */
  async function madeDocument(ctx) {
    const M = model();
    if (!M) throw new Error('The document model is not loaded');
    const body = ctx.body;
    const catalog = await ctx.saved(`${base(ctx)}/catalog`);
    const type = list(catalog && catalog.types).find((item) => isObject(item) && text(item.id) === text(body.document_type));
    if (!type) throw new Error('This kind of document is not on the device');
    let template = null, version = 0, definition = {};
    if (text(body.template_id)) {
      const templates = await ctx.saved(`${base(ctx)}/templates`);
      template = list(templates && templates.templates).find((item) => isObject(item) && text(item.id) === text(body.template_id)) || null;
      if (!template) throw new Error('This template is not on the device');
      version = Number(body.template_version || template.current_version || 0);
      const saved = version ? await ctx.saved(`${base(ctx)}/templates/${enc(template.id)}/versions/${version}`) : null;
      definition = saved && isObject(saved.version) && isObject(saved.version.definition) ? saved.version.definition : null;
      if (!definition) throw new Error('This template is not on the device');
      // Custom behavior runs in the server's sandbox when the document is made.
      if (isObject(definition.program) && definition.program.enabled === true) throw new Error('This template runs on the server');
    }
    const templateMeta = template && isObject(template.metadata) ? template.metadata : {};
    let workflowRef = null, workflowState = null, workflowTags = [];
    const optedOut = has(body, 'workflow_id') && (body.workflow_id === null || text(body.workflow_id) === '');
    const workflowId = optedOut || templateMeta.disable_default_workflow === true ? '' : text(body.workflow_id) || text(templateMeta.default_workflow_id) || text(type.default_workflow_id);
    let workflowOutputs = {};
    if (workflowId) {
      const saved = await ctx.saved(`${base(ctx)}/workflows/${enc(workflowId)}`);
      const workflow = saved && isObject(saved.workflow) ? saved.workflow : null;
      if (!workflow) throw new Error('This document\'s steps are not on the device');
      const current = Number(workflow.current_version || 0);
      if (current && isObject(workflow.definition)) {
        const steps = list(workflow.definition.steps).filter(isObject);
        workflowRef = { workflow_id: workflowId, version: current };
        workflowState = { current_step: text(steps[0] && steps[0].id), completed_steps: [] };
        workflowTags = list(workflow.tags);
        workflowOutputs = isObject(workflow.definition.contract) && isObject(workflow.definition.contract.outputs) ? workflow.definition.contract.outputs : {};
      }
    }
    const projectId = projectOf(ctx);
    const id = text(body.id);
    const stamp = new Date(ctx.now).toISOString();
    // documents/capability_policy.ts filterParamDefinitionsByCapabilities: a payment schedule is off where payments are.
    const features = isObject(catalog.capabilities) ? catalog.capabilities : {};
    const paramDefs = Object.fromEntries(Object.entries(Object.assign({}, type.param_schema, isObject(definition.params) ? definition.params : {})).map(([key, def]) => [key,
      isObject(def) && text(def.type).toLowerCase() === 'payment_schedule' && features['documents.payments'] !== true
        ? Object.assign({}, def, { disabled: true, disabled_capability: 'documents.payments', disabled_reason: 'Payments is disabled for this organization.' })
        : (isObject(def) ? def : {})]));
    const scaffold = { id, project_id: projectId, title: '', document_type: text(type.id), params: isObject(body.params) ? body.params : {} };
    const scope = await madeScope(ctx, scaffold);
    const params = resolveParams(paramDefs, isObject(body.params) ? body.params : {}, scope);
    const inputMeta = isObject(body.metadata) ? body.metadata : {};
    const themeRef = isObject(body.theme_ref) && Object.keys(body.theme_ref).length ? body.theme_ref
      : (isObject(definition.theme_ref) && text(definition.theme_ref.theme_id) ? definition.theme_ref : (type.default_theme_id ? { theme_id: type.default_theme_id } : null));
    const document = {
      schema_version: 1,
      id,
      organization_id: ctx.org,
      branch_id: text(scope.project.branch_id) || 'default',
      project_id: projectId,
      document_type: text(type.id),
      department_ids: body.department_ids != null ? body.department_ids : (template && template.department_ids != null ? template.department_ids : []),
      department_access: body.department_access != null ? body.department_access : (template && template.department_access != null ? template.department_access : 'shared'),
      tags: tags(template && template.tags, workflowTags, body.tags),
      title: text(body.title || (template && template.name) || scope.project.title || type.label) || text(type.label),
      template_ref: template ? { template_id: text(template.id), version } : null,
      theme_ref: themeRef,
      theme_overrides: isObject(body.theme_overrides) ? body.theme_overrides : {},
      contact_ids: list(body.contact_ids).map(text).filter(Boolean),
      params,
      param_defs: paramDefs,
      output_defs: Object.assign({}, type.output_schema, isObject(definition.outputs) ? definition.outputs : {}, workflowOutputs),
      workflow_ref: workflowRef,
      workflow_state: workflowState,
      overrides: [],
      outputs: {},
      status: 'draft',
      delivery: {},
      pdf: {},
      source: 'generated',
      metadata: Object.assign({}, inputMeta, { customer_presentation: Object.assign({}, templateMeta.customer_presentation, inputMeta.customer_presentation) }),
      created_by_user_id: ctx.user,
      updated_by_user_id: ctx.user,
      created_at: stamp,
      updated_at: stamp,
      revision: 0
    };
    const required = Object.fromEntries(Object.entries(paramDefs).filter(([, def]) => !(isObject(def) && def.disabled === true)));
    return { ok: true, document, missing_params: M.missingRequiredParams(required, params) };
  }

  /** A document list with one document added or replaced; a list row keeps the summary the server gave it. */
  function inList(json, document, add) {
    if (!json || !Array.isArray(json.documents)) return json;
    const found = json.documents.findIndex((item) => item && item.id === document.id);
    if (found < 0 && !add) return json;
    const documents = json.documents.slice();
    if (found < 0) documents.unshift(Object.assign({ summary: null }, document));
    else documents[found] = Object.assign({}, document, { summary: documents[found].summary === undefined ? null : documents[found].summary });
    return Object.assign({}, json, { documents, count: documents.length });
  }

  /** The lists a document is in: its project's, or the list of documents with no project. */
  function listEffects(document, apply) {
    const projectId = text(document.project_id);
    return projectId
      ? [{ match: 'GET ' + DOCUMENTS + '/projects/:project/documents', when: (m) => m.project === projectId, apply }]
      : [{ match: 'GET ' + DOCUMENTS + '/documents', apply }];
  }

  // ---------------------------------------------------------------------------------------------------------
  // An edit to a document
  // ---------------------------------------------------------------------------------------------------------

  const withIds = (ops) => (model() ? model().withOverrideIds(list(ops).filter(isObject)) : list(ops));

  /** The person's value for one field of a patch, over the document it was made on. */
  function patchValue(field, body, from) {
    if (field === 'title') return text(body.title) || from.title;
    if (field === 'params') return Object.assign({}, from.params, isObject(body.params) ? body.params : {});
    if (field === 'overrides') return withIds(body.overrides);
    if (field === 'theme_ref') return body.theme_ref === null ? null : (isObject(body.theme_ref) ? body.theme_ref : {});
    if (field === 'theme_overrides') return isObject(body.theme_overrides) ? body.theme_overrides : {};
    if (field === 'contact_ids') return list(body.contact_ids).map(text).filter(Boolean);
    if (field === 'tags') return tags(body.tags);
    return body[field];
  }
  const patchFields = (body) => PATCH_FIELDS.filter((field) => has(body, field));

  /**
   * A document with the queued patch applied. Each field is merged three ways (as it was, as the person left
   * it, as it is now), so data another person saved since stays while the change waits.
   */
  function patchedDocument(ctx, current) {
    const was = isObject(ctx.base) ? ctx.base : null;
    const next = Object.assign({}, current);
    for (const field of patchFields(ctx.body)) {
      const mine = patchValue(field, ctx.body, was || current);
      const theirs = field === 'overrides' ? withIds(current.overrides) : current[field];
      next[field] = was ? FMOffline.merge3(field === 'overrides' ? withIds(was.overrides) : was[field], mine, theirs).value : mine;
    }
    next.updated_at = new Date(ctx.now).toISOString();
    next.updated_by_user_id = ctx.user;
    return next;
  }

  /** What every saved read of a document shows while a change to it waits. `change(document)` applies it. */
  function documentEffects(ctx, id, change, home) {
    const mine = (m) => m.document === id;
    const changed = (json) => (json && isObject(json.document) ? Object.assign({}, json, { document: change(json.document) }) : json);
    const inAnyList = (json) => {
      const found = json && Array.isArray(json.documents) ? json.documents.find((item) => item && item.id === id) : null;
      return found ? inList(json, change(found), false) : json;
    };
    // Only the list the document is in: its project's, or the one of documents with no project. (`home` is
    // undefined when the device does not know; then every saved list is looked through.)
    const lists = [];
    if (home !== '') lists.push({ match: 'GET ' + DOCUMENTS + '/projects/:project/documents', when: (m) => home === undefined || m.project === home, apply: inAnyList });
    if (!home) lists.push({ match: 'GET ' + DOCUMENTS + '/documents', apply: inAnyList });
    return [{ match: 'GET ' + DOCUMENTS + '/documents/:document', when: mine, apply: changed }, ...lists];
  }

  /** True when no later change to this document waits: that one makes the resolved view, earlier ones only say what changed. */
  async function isNewest(ctx, id) {
    try {
      const entries = (await FMOffline.queue.list({ user: ctx.user, org: ctx.org })).filter((entry) => entry.contract === 'documents' && (entry.records || []).includes(id));
      return !entries.length || entries[entries.length - 1].id === ctx.id;
    } catch (_) { return true; }
  }

  /** What an earlier change adds to the view without making it: its hints, for the newest change to resolve once. */
  function noteHint(json, hint) {
    const before = isObject(json) && isObject(json.offline) ? json.offline : {};
    return Object.assign({}, json, { offline: { pending: true, made: !!(hint.made || before.made), data: !!(hint.data || before.data), layout: !!(hint.layout || before.layout), theme: !!(hint.theme || before.theme), writes: [...list(before.writes), ...list(hint.writes)] } });
  }

  /**
   * The effects of a change on a document's reads, with the resolved view. The worker keeps traced and plain
   * resolve answers apart (the read's key), so there is one effect for each. However many changes wait, the
   * view is resolved once per read, by the newest.
   */
  async function resolveEffects(ctx, id, change, hint) {
    const known = await ctx.saved(documentUrl(ctx, id));
    const home = known && isObject(known.document) ? text(known.document.project_id) : undefined;
    const forBody = (trace) => ({
      match: 'POST ' + DOCUMENTS + '/documents/:document/resolve',
      when: (m, read) => m.document === id && (isObject(read.body) && read.body.trace === true) === trace,
      apply: async (json) => {
        if (!(await isNewest(ctx, id))) return noteHint(json, hint);
        // The document as the person has it: every change up to this one, then this one.
        const saved = await ctx.saved(documentUrl(ctx, id));
        const current = saved && isObject(saved.document) ? change(saved.document) : null;
        return current ? deviceResolve(ctx, current, json, { trace }, hint) : json;
      }
    });
    return [...documentEffects(ctx, id, change, home), forBody(true), forBody(false)];
  }

  // ---------------------------------------------------------------------------------------------------------
  // Values and text typed into the document as sent
  // ---------------------------------------------------------------------------------------------------------

  const writesOf = (body) => list(body && body.writes).filter((write) => isObject(write) && text(write.path));
  const textOf = (body) => (isObject(body && body.text) && text(body.text.node_id) ? body.text : null);
  const textKey = (edit) => 'text.' + text(edit.node_id);
  const isTextOp = (op, nodeId) => isObject(op) && op.op === 'node.set' && text(op.node_id) === nodeId && (text(op.prop) === 'props.blocks' || text(op.prop).startsWith('props.blocks.'));

  /**
   * Where a typed value lives in a document: the row it belongs to is found by id, so a line another person
   * added or removed above it does not move the edit to the wrong line. `was` is the same value as it was found
   * when the edit was made ({ path, ids, sizes }), or null then.
   * Resolves { path, ids, sizes, value }: `path` is null and `value` says "gone" when the row is no longer there.
   */
  function locate(document, write, was) {
    const path = segments(write.path);
    const ids = [], sizes = [], now = [];
    let value = { params: isObject(document.params) ? document.params : {} };
    let row = null, hop = 0, gone = false;
    for (const key of path) {
      if (typeof key === 'number' && Array.isArray(value)) {
        let index = key;
        if (was) {
          const id = was.ids[hop];
          if (id != null) index = value.findIndex((item) => idOf(item) === id);
          else if (value.length !== was.sizes[hop]) index = -1;
        }
        if (index < 0 || index >= value.length) { gone = true; break; }
        ids.push(idOf(value[index])); sizes.push(value.length); now.push(index);
        value = value[index]; row = value; hop++;
      } else {
        now.push(key);
        value = value == null ? undefined : value[key];
      }
    }
    if (gone) return { path: null, ids: was ? was.ids : ids, sizes: was ? was.sizes : sizes, value: { gone: true } };
    const leaf = String(path[path.length - 1]);
    // A typed amount is stored as the line's price: the part it changes is the line's price fields.
    const shown = PRICE_LEAVES.has(leaf) && isObject(row) ? Object.fromEntries(PRICE_FIELDS.filter((field) => has(row, field)).map((field) => [field, row[field]])) : (value === undefined ? null : value);
    return { path: now.join('.'), ids, sizes, value: shown };
  }

  /** How a field is named for a person choosing between two values: the data path with rows by id. */
  function fieldKey(write, found) {
    let hop = 0;
    return segments(write.path).slice(1).map((key) => (typeof key === 'number' ? '#' + (found.ids[hop++] || key) : key)).join('.');
  }

  /** The person's value: the stored value where the page could say it, else what they typed. */
  function typedValue(write) {
    const leaf = String(segments(write.path).pop());
    if (PRICE_LEAVES.has(leaf) || !has(write, 'parsed')) return { typed: String(write.text == null ? '' : write.text) };
    return leaf === 'quantity' ? Math.max(0, Number(write.parsed) || 0) : write.parsed;
  }

  /** The parts an as-sent edit touches, as they are in a document: one entry per typed value, one for the text. */
  function asSentParts(document, ctx) {
    const was = isObject(ctx.base) ? ctx.base : null;
    const keys = was ? Object.keys(was).filter((key) => !key.startsWith('text.')) : [];
    const parts = {};
    writesOf(ctx.body).forEach((write, index) => {
      const found = locate(document, write, was ? was[keys[index]] : null);
      let key = was ? keys[index] : fieldKey(write, found);
      if (!was && has(parts, key)) key = key + '~' + index;
      parts[key] = found;
    });
    const edit = textOf(ctx.body);
    if (edit) {
      const op = list(document.overrides).filter((item) => isTextOp(item, text(edit.node_id))).pop();
      parts[textKey(edit)] = op && Array.isArray(op.value) ? op.value : null;
    }
    return parts;
  }

  /** A document with the as-sent edit applied, as far as a device stores it: plain values and the text override. */
  function asSentDocument(ctx, current) {
    const M = model();
    const next = Object.assign({}, current, { params: clone(isObject(current.params) ? current.params : {}) });
    for (const write of writesOf(ctx.body)) {
      const rest = segments(write.path).slice(1);
      if (!rest.length || !has(write, 'parsed')) continue;
      const line = lineRowPath(rest);
      if (line && PRICE_LEAVES.has(line.field)) continue;            // the server prices the line; shown as typed until then
      if (line && line.field === 'quantity') {
        const row = at(next.params, line.row);
        if (!isObject(row)) continue;
        row.quantity = Math.max(0, Number(write.parsed) || 0);
        // inputs.ts: a typed amount stood in for an inexact unit price; quantity x unit price applies again.
        if (Number(row.unit_price != null ? row.unit_price : (row.unitPrice != null ? row.unitPrice : (row.base_price != null ? row.base_price : row.basePrice))) > 0) for (const key of ['amount', 'total', 'total_price', 'totalPrice', 'amount_cents']) delete row[key];
        continue;
      }
      if (M) M.setPath(next.params, rest, write.parsed);
    }
    const edit = textOf(ctx.body);
    if (edit) {
      const nodeId = text(edit.node_id);
      const kept = list(current.overrides).filter((op) => !isTextOp(op, nodeId));
      next.overrides = withIds(Array.isArray(edit.blocks)
        ? [...kept, Object.assign({ op: 'node.set', node_id: nodeId, prop: 'props.blocks', value: edit.blocks }, text(edit.base) ? { base: text(edit.base) } : {}, { source: 'as_sent' })]
        : kept);
    }
    next.updated_at = new Date(ctx.now).toISOString();
    next.updated_by_user_id = ctx.user;
    return next;
  }

  async function editable(ctx, id) {
    const saved = await ctx.saved(documentUrl(ctx, id));
    const document = saved && isObject(saved.document) ? saved.document : null;
    if (!document) throw new Error('This document is not on the device');
    if (!EDITABLE_STATUSES.has(text(document.status).toLowerCase())) throw new Error('A sent document is changed with a connection');
    if (isObject(document.module_ref) && text(document.module_ref.execution_id)) throw new Error('This document is made by custom behavior on the server');
    return document;
  }

  const titleOf = async (ctx, id) => { const saved = await ctx.saved(documentUrl(ctx, id)); return text(saved && saved.document && saved.document.title); };

  FMOffline.contracts.add({
    id: 'documents',
    reads: [
      {
        // documents/api.ts resolve: the definition with its bindings and widget data filled in. Nothing is saved.
        id: 'documents.resolve',
        match: 'POST ' + DOCUMENTS + '/documents/:document/resolve',
        when: (ctx) => ctx.body == null || isObject(ctx.body),
        key: (ctx) => ({ document: ctx.params.document, body: isObject(ctx.body) ? ctx.body : {} })
      }
    ],
    prefetch: [
      (ctx) => [`${base(ctx)}/catalog`, `${base(ctx)}/document-types`],
      { url: (ctx) => `${base(ctx)}/templates`, each: templateReads },
      // The steps a new document starts with (the workflow its template or type names).
      { url: (ctx) => `${base(ctx)}/catalog`, each: (json, ctx) => list(json && json.workflows).filter((workflow) => isObject(workflow) && text(workflow.id)).slice(0, TEMPLATE_LIMIT).map((workflow) => `${base(ctx)}/workflows/${enc(workflow.id)}`) },
      { url: '/v1/platform/me', each: (me, ctx) => [`${base(ctx)}/settings?branch_id=${enc(text(me && me.membership && me.membership.branch_id) || 'default')}`] },
      {
        url: (ctx) => `${base(ctx)}/projects/${enc(ctx.project)}/documents`,
        each: (json, ctx) => list(json && json.documents).filter((document) => isObject(document) && text(document.id)).flatMap((document) => documentReads(ctx, document))
      }
    ],
    writes: [
      {
        // DocumentsAPI.documents.createForProject / createStandalone with the id the page made.
        id: 'document.create',
        match: ['POST ' + DOCUMENTS + '/projects/:project/documents', 'POST ' + DOCUMENTS + '/documents'],
        when: (ctx) => isObject(ctx.body) && DEVICE_ID.test(text(ctx.body.id)) && !SERVER_MADE_TYPES.has(text(ctx.body.document_type))
          // Without a named template the server chooses one; a device cannot know which.
          && has(ctx.body, 'template_id') && (ctx.body.template_id === null || typeof ctx.body.template_id === 'string'),
        kind: 'create',
        scope: (ctx) => 'document:' + text(ctx.body.id),
        records: (ctx) => [text(ctx.body.id)],
        label: (ctx) => FMOffline.label('sync_document_new', 'New document', text(ctx.response && ctx.response.document && ctx.response.document.title) || text(ctx.body.title)),
        respond: (ctx) => madeDocument(ctx),
        // The first try reached the server and its answer was lost. The same request is answered with the
        // document; `document_exists` is the answer when the id is taken by anything else.
        duplicate: (ctx, answer) => answer.status === 409 && answer.code === 'document_exists',
        effects: (ctx) => {
          const document = ctx.response.document;
          const id = document.id;
          const mine = (m) => m.document === id;
          const seeds = [
            { match: 'GET ' + DOCUMENTS + '/documents/:document', when: mine, seed: () => ({ ok: true, document }) },
            { match: 'GET ' + DOCUMENTS + '/documents/:document/snapshots', when: mine, seed: { ok: true, snapshots: [], count: 0 } },
            { match: 'GET ' + DOCUMENTS + '/documents/:document/events', when: mine, seed: { ok: true, events: [], count: 0 } },
            {
              match: 'POST ' + DOCUMENTS + '/documents/:document/resolve',
              when: (m, read) => mine(m) && !(isObject(read.body) && read.body.trace === true),
              seed: async () => ((await isNewest(ctx, id)) ? deviceResolve(ctx, document, null, {}, { made: true }) : noteHint({ ok: true }, { made: true }))
            },
            {
              match: 'POST ' + DOCUMENTS + '/documents/:document/resolve',
              when: (m, read) => mine(m) && isObject(read.body) && read.body.trace === true,
              seed: async () => ((await isNewest(ctx, id)) ? deviceResolve(ctx, document, null, { trace: true }, { made: true }) : noteHint({ ok: true }, { made: true }))
            }
          ];
          if (document.workflow_ref) {
            seeds.push({
              match: 'GET ' + DOCUMENTS + '/documents/:document/workflow',
              when: mine,
              seed: async () => {
                const saved = await ctx.saved(`${base(ctx)}/workflows/${enc(document.workflow_ref.workflow_id)}`);
                const definition = saved && isObject(saved.workflow) ? saved.workflow.definition : null;
                if (!isObject(definition)) return undefined;
                return { ok: true, workflow_ref: document.workflow_ref, workflow: definition, state: Object.assign({ current_step: '', completed_steps: [] }, document.workflow_state), contract: isObject(definition.contract) ? definition.contract : {}, sources: {} };
              }
            });
          }
          return [...listEffects(document, (json) => inList(json, document, true)), ...seeds];
        }
      },
      {
        // DocumentsAPI.documents.patch: the title, the data (workflow steps, the Data panel), the layout
        // overrides (the editor's autosave), the theme, contacts and tags of a draft.
        id: 'document.patch',
        match: 'PATCH ' + DOCUMENTS + '/documents/:document',
        when: (ctx) => isObject(ctx.body) && patchFields(ctx.body).length > 0 && Object.keys(ctx.body).every((key) => key === 'expected_revision' || PATCH_FIELDS.includes(key)),
        kind: 'patch',
        scope: (ctx) => 'document:' + ctx.params.document,
        records: (ctx) => [ctx.params.document],
        label: async (ctx) => FMOffline.label('sync_document_edit', 'Document change', text(ctx.body.title) || await titleOf(ctx, ctx.params.document)),
        // Override items are sent with their ids, so the list merges item by item.
        prepare: (ctx) => (has(ctx.body, 'overrides') && model() ? Object.assign({}, ctx.body, { overrides: withIds(ctx.body.overrides) }) : ctx.body),
        respond: async (ctx) => {
          const document = await editable(ctx, ctx.params.document);
          return { ok: true, document: patchedDocument(Object.assign({}, ctx, { base: document }), document) };
        },
        effects: (ctx) => resolveEffects(ctx, ctx.params.document, (document) => patchedDocument(ctx, document), { data: has(ctx.body, 'params'), layout: has(ctx.body, 'overrides') || has(ctx.body, 'theme_ref') || has(ctx.body, 'theme_overrides'), theme: has(ctx.body, 'theme_ref') || has(ctx.body, 'theme_overrides') }),
        conflict: {
          current: (ctx) => documentUrl(ctx, ctx.params.document),
          pick: (json) => (json && isObject(json.document)
            ? { doc: Object.assign({}, json.document, { overrides: withIds(json.document.overrides) }), revision: json.document.revision }
            : { doc: null, revision: undefined }),
          fields: (ctx) => patchFields(ctx.body),
          mine: (ctx, was) => Object.assign({}, was, Object.fromEntries(patchFields(ctx.body).map((field) => [field, patchValue(field, ctx.body, was || {})]))),
          send: (ctx, merged, revision) => Object.assign({}, merged, revision ? { expected_revision: revision } : {})
        }
      },
      {
        // DocumentsAPI.documents.editAsSent ("Edit manually"): values typed into the rendered document and
        // the text of one node. The answer has no resolved view; the page asks the resolve read for it.
        id: 'document.as_sent',
        match: 'POST ' + DOCUMENTS + '/documents/:document/as-sent',
        when: (ctx) => isObject(ctx.body) && (writesOf(ctx.body).length > 0 || !!textOf(ctx.body)),
        kind: 'patch',
        scope: (ctx) => 'document:' + ctx.params.document,
        records: (ctx) => [ctx.params.document],
        label: async (ctx) => FMOffline.label('sync_document_edit', 'Document change', await titleOf(ctx, ctx.params.document)),
        respond: async (ctx) => ({ ok: true, document: asSentDocument(ctx, await editable(ctx, ctx.params.document)) }),
        effects: (ctx) => resolveEffects(ctx, ctx.params.document, (document) => asSentDocument(ctx, document), { data: writesOf(ctx.body).length > 0, layout: !!textOf(ctx.body), writes: writesOf(ctx.body).map((write) => Object.assign({ path: text(write.path), text: write.text }, has(write, 'parsed') ? { parsed: write.parsed } : {})) }),
        conflict: {
          current: (ctx) => documentUrl(ctx, ctx.params.document),
          // The "document" that is merged is the parts this edit touches: each typed value, and the node's text.
          pick: (json, ctx) => (json && isObject(json.document) ? { doc: asSentParts(json.document, ctx), revision: json.document.revision } : { doc: null, revision: undefined }),
          fields: (ctx) => Object.keys(isObject(ctx.base) ? ctx.base : {}),
          mine: (ctx, was) => {
            const keys = Object.keys(was || {}).filter((key) => !key.startsWith('text.'));
            const parts = {};
            writesOf(ctx.body).forEach((write, index) => { const part = (was || {})[keys[index]]; if (part) parts[keys[index]] = Object.assign({}, part, { value: typedValue(write) }); });
            const edit = textOf(ctx.body);
            if (edit) parts[textKey(edit)] = Array.isArray(edit.blocks) ? edit.blocks : null;
            return parts;
          },
          // A value is written where its row is now; a value the person gave up, or one the server already has, is left out.
          send: (ctx, merged, revision) => {
            const keys = Object.keys(isObject(ctx.base) ? ctx.base : {}).filter((key) => !key.startsWith('text.'));
            const writes = writesOf(ctx.body).map((write, index) => { const part = merged[keys[index]]; return isObject(part) && part.path ? { path: part.path, text: write.text } : null; }).filter(Boolean);
            const edit = textOf(ctx.body);
            return Object.assign({}, writes.length ? { writes } : {}, edit && has(merged, textKey(edit)) ? { text: { node_id: edit.node_id, blocks: Array.isArray(edit.blocks) ? edit.blocks : null, base: edit.base == null ? null : edit.base } } : {}, revision ? { expected_revision: revision } : {});
          }
        }
      }
    ]
  });
})();
