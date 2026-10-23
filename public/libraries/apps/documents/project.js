/* public/libraries/apps/documents/project.js
 * Project "Documents" tab — the document engine's instance surface.
 *
 * Composes DocumentsAPI + FMDocEditor (profile "document", unlockable to
 * "designer" when the documents.designer_profile capability is on) +
 * FMDocRenderer previews + a params/data side panel with a scope line-items
 * loader (project scope / pricebook / manual).
 *
 * Registered as runtime app id "project.documents" (manifest-declared).
 * See docs/document-engine-contracts.md and docs/document-engine-spec.md.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  if (!runtime?.registerApp) return;

  const SCRIPT_URL = (document.currentScript && document.currentScript.src) || '';

  // ------------------------------------------------------------- utilities
  function cleanText(value){ return String(value ?? '').trim(); }
  function firstText(...values){
    for (const value of values) {
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }
  const esc = (value) => runtime.escapeHtml
    ? runtime.escapeHtml(value)
    : String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  function clone(value){
    try { return structuredClone(value); } catch (e) { return JSON.parse(JSON.stringify(value ?? null)); }
  }
  function objectValue(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function arrayValue(value){ return Array.isArray(value) ? value : []; }
  function showToast(title, message, ok = true){
    (window.Portal?.ui?.showToast || (() => {}))(title, message, ok);
  }
  function errorMessage(error, fallback){
    return firstText(error?.data?.message, error?.data?.error, error?.message, fallback, 'Something went wrong.');
  }
  async function transcribeDocumentDictation(organizationId, documentName){
    const audio = window.FirstMateAudioNotes;
    if (!audio?.record || !audio?.transcribe) throw new Error('Document dictation is unavailable.');
    const recording = await audio.record({ title:(globalThis.PlatformLanguage?.text("documents","m_939ec72e8123ba","Dictate into document") ?? "Dictate into document"), maxSeconds:600 });
    const transcription = await audio.transcribe(organizationId, recording.file, {
      prompt:`Construction business document dictation${cleanText(documentName) ? ` for ${cleanText(documentName)}` : ''}. Preserve names, measurements, product terms, and punctuation.`
    });
    return cleanText(transcription?.text);
  }
  function moneyFromCents(cents){
    const n = Number(cents || 0) / 100;
    return n.toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { style: 'currency', currency: 'USD' });
  }
  function moneyFromDollars(dollars){
    return (Number(dollars || 0)).toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { style: 'currency', currency: 'USD' });
  }
  function timeAgo(value){
    const time = new Date(value || 0).getTime();
    if (!time) return '';
    const diff = Date.now() - time;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
    if (diff < 7 * 86400000) return `${Math.round(diff / 86400000)}d ago`;
    return new Date(time).toLocaleDateString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { month: 'short', day: 'numeric', year: 'numeric' });
  }
  let uidCounter = 0;
  function uid(prefix){ return `${prefix}_${Date.now().toString(36)}${(++uidCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

  // Shared stylesheet (documents.css alongside this bundle).
  function ensureStyles(){
    if (document.getElementById('fmdx-documents-css')) return;
    const link = document.createElement('link');
    link.id = 'fmdx-documents-css';
    link.rel = 'stylesheet';
    try {
      const href = new URL('documents.css', SCRIPT_URL || window.location.href);
      if (SCRIPT_URL.includes('?')) href.search = SCRIPT_URL.slice(SCRIPT_URL.indexOf('?'));
      link.href = href.toString();
    } catch (e) {
      link.href = '/libraries/apps/documents/documents.css';
    }
    document.head.appendChild(link);
  }

  // Inline create surface (doc-first flows): the create wizard rendered into a
  // host panel instead of a floating modal. Reuses every .fmdx-modal inner
  // style; this block only neutralizes the dialog chrome.
  function ensureInlineStyles(){
    if (document.getElementById('fmdx-inline-css')) return;
    const style = document.createElement('style');
    style.id = 'fmdx-inline-css';
    style.textContent = `
      .fmdx-inline-wrap{position:relative;height:100%;min-height:0;overflow:auto;background:#fff;box-sizing:border-box}
      .fmdx-inline-wrap .fmdx-modal{position:relative;inset:auto;transform:none;width:auto;max-width:860px;max-height:none;margin:0 auto;box-shadow:none;border:0;border-radius:0;padding:26px 30px 40px}
      .fmdx-inline-wrap .fmdx-modal-close{display:none}
    `;
    document.head.appendChild(style);
  }

  // ------------------------------------------- workflow runtime lazy loader
  // The doc-workflow runtime (contracts §8) is not in the app manifest — this
  // app loads it on demand next to its own bundle. Failure → null (hosts fall
  // back to the params-form flow).
  let workflowRuntimePromise = null;
  function ensureWorkflowRuntime(){
    if (window.FMDocWorkflow?.mount) return Promise.resolve(window.FMDocWorkflow);
    if (workflowRuntimePromise) return workflowRuntimePromise;
    workflowRuntimePromise = new Promise((resolve) => {
      let src = '/libraries/doc-workflow/firstmate-doc-workflow.js';
      try {
        const href = new URL('../../doc-workflow/firstmate-doc-workflow.js', SCRIPT_URL || window.location.href);
        if (SCRIPT_URL.includes('?')) href.search = SCRIPT_URL.slice(SCRIPT_URL.indexOf('?'));
        src = href.toString();
      } catch (e) { /* keep the absolute fallback */ }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve(window.FMDocWorkflow?.mount ? window.FMDocWorkflow : null);
      script.onerror = () => { workflowRuntimePromise = null; resolve(null); };
      document.head.appendChild(script);
    });
    return workflowRuntimePromise;
  }

  // ------------------------------------------------ readable on-primary text
  // Ported from public/customer_portal/customer_portal.js: when the org's
  // primary brand color is light, white button text disappears. Compute the
  // relative luminance of the resolved primary and publish --fmdx-on-primary
  // (white or near-black) on <html> so every fmdx surface — including body-
  // mounted modals/menus — renders readable text on primary buttons.
  function parseCssColor(value){
    const text = cleanText(value);
    if (!text) return null;
    let m = text.match(/^#([0-9a-f]{3})$/i);
    if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16) };
    m = text.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
    m = text.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i);
    if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
    return null;
  }
  function relativeLuminance(r, g, b){
    const channels = [r / 255, g / 255, b / 255].map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }
  function readableOnColor(color){
    const rgb = parseCssColor(color);
    if (!rgb) return '#fff';
    return relativeLuminance(rgb.r, rgb.g, rgb.b) > 0.40 ? '#111827' : '#fff';
  }
  function syncOnPrimaryVar(el){
    try {
      const styles = getComputedStyle(el || document.documentElement);
      const branding = (window.__APP?.orgBranding || window.Portal?.cfg?.branding || {});
      const primary = firstText(
        styles.getPropertyValue('--fm-primary'),
        styles.getPropertyValue('--primary'),
        branding?.colors?.primary,
        branding?.primary,
        '#2563EB'
      );
      document.documentElement.style.setProperty('--fmdx-on-primary', readableOnColor(primary));
    } catch (e) { /* keep the CSS #fff fallback */ }
  }

  // ------------------------------------------------ theme preview cards (§5)
  // CSS-drawn page mockups: the theme's page-master chrome (rects/polygons in
  // 612×792pt space) redrawn proportionally with its own resolved token
  // colors, plus name, fonts, and color dots. Shared visual language with
  // studio.js (styles live in documents.css).
  function themeVarsInline(definition, branding){
    let vars = {};
    try {
      if (window.FMDocModel?.resolveThemeTokens) vars = window.FMDocModel.resolveThemeTokens(objectValue(definition), { branding: objectValue(branding) });
    } catch (e) { vars = {}; }
    return vars;
  }
  function themeFontLabel(vars){
    const first = (value) => cleanText(String(value || '').split(',')[0]).replace(/["']/g, '');
    const display = first(vars['--fm-font-display']);
    const body = first(vars['--fm-font-body']);
    if (display && body && display !== body) return `${display} · ${body}`;
    return display || body || '';
  }
  function themeThumbHtml(definition){
    const def = objectValue(definition);
    const masters = arrayValue(def.page_masters);
    const master = masters.find((m) => cleanText(objectValue(m.match).role) === 'cover')
      || masters.find((m) => ['*', ''].includes(cleanText(objectValue(m.match).role)))
      || masters[0] || null;
    const chrome = arrayValue(master?.chrome).slice(0, 6).map((raw) => {
      const node = objectValue(raw);
      const frame = objectValue(node.frame);
      const left = ((Number(frame.x) || 0) / 612) * 100;
      const top = ((Number(frame.y) || 0) / 792) * 100;
      const w = ((Number(frame.w) || 0) / 612) * 100;
      const h = ((Number(frame.h) || 0) / 792) * 100;
      const fill = firstText(objectValue(objectValue(node.style).fill).color, 'var(--fm-primary,#2563EB)');
      let clip = '';
      if (cleanText(objectValue(node.props).shape) === 'polygon') {
        const pts = arrayValue(objectValue(node.props).points)
          .map((p) => `${((Number(objectValue(p).x) || 0) * 100).toFixed(1)}% ${((Number(objectValue(p).y) || 0) * 100).toFixed(1)}%`)
          .join(',');
        if (pts) clip = `clip-path:polygon(${pts});`;
      }
      return `<i style="left:${left.toFixed(1)}%;top:${top.toFixed(1)}%;width:${w.toFixed(1)}%;height:${h.toFixed(1)}%;background:${esc(fill)};${clip}"></i>`;
    }).join('');
    const inset = objectValue(master?.content_inset);
    const textLeft = Math.min(58, ((Number(inset.left) || 44) / 612) * 100);
    const textTop = Math.max(16, ((Number(inset.top) || 64) / 792) * 100);
    const lines = [62, 88, 80, 52].map((w, i) => `<b style="left:${textLeft.toFixed(1)}%;top:${(textTop + i * 9).toFixed(1)}%;width:${Math.max(12, Math.min(w, 90 - textLeft)).toFixed(1)}%"></b>`).join('');
    return `<span class="fmdx-theme-thumb">${chrome}${lines}</span>`;
  }
  /** options: { definition, branding, attr, value, name, sub, current } */
  function themeCardHtml(options = {}){
    const vars = themeVarsInline(options.definition, options.branding);
    const varStyle = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
    const fonts = firstText(options.sub, themeFontLabel(vars));
    return `
      <button type="button" class="fmdx-theme-card ${String(options.current ? 'current' : '')}" ${String(esc(options.attr || 'data-menu-theme'))}="${String(esc(options.value ?? ''))}" style="${String(esc(varStyle))}">
        ${String(themeThumbHtml(options.definition))}
        <span class="fmdx-theme-card-info">
          <strong>${String(esc(firstText(options.name, 'Theme')))}${String(options.current ? ' <i class="fas fa-circle-check"></i>' : '')}</strong>
          ${String(fonts ? `<small>${esc(fonts)}</small>` : '')}
          <span class="fmdx-theme-dots">
            <i style="background:var(--fm-primary,#2563EB)" title="${(globalThis.PlatformLanguage?.htmlText("documents","m_2436076ece8629","Primary") ?? "Primary")}"></i>
            <i style="background:var(--fm-accent,#0EA5E9)" title="${(globalThis.PlatformLanguage?.htmlText("documents","m_12ab6737efe605","Accent") ?? "Accent")}"></i>
            <i style="background:var(--fm-text,#111827)" title="${(globalThis.PlatformLanguage?.htmlText("documents","m_124287f184b88b","Text") ?? "Text")}"></i>
          </span>
        </span>
      </button>`;
  }

  const STATUS_LABELS = {
    draft: 'Draft', issued: 'Issued', sent: 'Sent', viewed: 'Viewed', in_progress: 'In progress',
    signed: 'Signed', paid: 'Paid', completed: 'Completed', declined: 'Declined', expired: 'Expired', void: 'Void',
    needs_review: 'Needs review', archived: 'Archived'
  };
  const TYPE_META = {
    proposal: { icon: 'fa-file-signature', color: '#2563eb' },
    invoice: { icon: 'fa-file-invoice-dollar', color: '#175cd3' },
    change_order: { icon: 'fa-file-contract', color: '#7c3aed' },
    contract: { icon: 'fa-file-contract', color: '#0f766e' },
    work_order: { icon: 'fa-clipboard-list', color: '#b45309' },
    receipt: { icon: 'fa-receipt', color: '#b54708' },
    generic: { icon: 'fa-file-lines', color: '#64748b' }
  };
  function typeMeta(type, catalogTypes){
    const key = cleanText(type).toLowerCase();
    const catalogType = arrayValue(catalogTypes).find((t) => cleanText(t.id || t.type) === key);
    const base = TYPE_META[key] || TYPE_META.generic;
    return {
      icon: firstText(catalogType?.icon, base.icon),
      color: base.color,
      label: firstText(catalogType?.label, key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), 'Document')
    };
  }
  function statusChip(status){
    const key = cleanText(status).toLowerCase() || 'draft';
    return `<span class="fmdx-chip ${esc(key)}">${esc(STATUS_LABELS[key] || key)}</span>`;
  }
  /** What a document shows as its status: Completed, Signed, Paid, else its
   *  delivery status. One rule, shared with the Docs tab (FMDocModel). */
  function progressChip(doc){
    const record = objectValue(doc);
    return statusChip(window.FMDocModel?.documentProgress?.(record) || record.status);
  }

  // ------------------------------------------------- scope item shape (v1)
  // EXACTLY the old proposal builder's editable.scope.root_items item shape so
  // the server-side doc.line_items resolver understands params.scope_items.
  function makeScopeItem(overrides = {}){
    return {
      id: uid('scope'),
      type: 'scope_item',
      pricebook_ref: {},
      name: '',
      display_name: '',
      description: '',
      unit: 'ea',
      quantity: '1',
      unit_price: 0,
      base_price: 0,
      included: false,
      price_driving: true,
      selection: { mode: 'always', selected: true },
      variations: [],
      children: [],
      ...overrides
    };
  }
  function normalizeScopeItem(item = {}){
    const normalized = {
      ...makeScopeItem(),
      ...objectValue(item),
      id: firstText(item.id, uid('scope')),
      type: firstText(item.type, 'scope_item'),
      name: firstText(item.name, item.display_name, 'Line item'),
      quantity: String(item.quantity ?? '1'),
      unit_price: Number(item.unit_price ?? item.unitPrice ?? item.base_price ?? item.basePrice ?? item.amount ?? 0) || 0,
      base_price: Number(item.base_price ?? item.basePrice ?? item.unit_price ?? 0) || 0,
      children: arrayValue(item.children).map(normalizeScopeItem)
    };
    return normalized;
  }
  function scopeItemsTotal(items){
    let total = 0;
    const walk = (list) => arrayValue(list).forEach((item) => {
      if (item.included !== true && item.price_driving !== false && item.selection?.selected !== false) {
        total += (Number(item.quantity || 0) || 0) * (Number(item.unit_price || 0) || 0);
      }
      walk(item.children);
    });
    walk(items);
    return total;
  }
  function isScopeItemsParam(key, def = {}){
    if (cleanText(key) === 'scope_items') return true;
    const type = cleanText(def.type).toLowerCase();
    if (type === 'pricebook_line') return true;
    if (type === 'list') {
      const items = objectValue(def.items);
      return cleanText(items.type).toLowerCase() === 'pricebook_line';
    }
    return false;
  }

  // ------------------------------------------------------------ modal kit
  function openModal(contentHtml, options = {}){
    const back = document.createElement('div');
    back.className = 'fmdx-modal-back';
    back.innerHTML = `<div class="fmdx-modal ${String(esc(options.className || ''))}" role="dialog" aria-modal="true">${String(contentHtml)}<button type="button" class="fmdx-modal-close" aria-label="${(globalThis.PlatformLanguage?.htmlText("documents","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>`;
    const close = () => { back.remove(); options.onClose?.(); };
    back.querySelector('.fmdx-modal-close').addEventListener('click', close);
    back.addEventListener('mousedown', (event) => { if (event.target === back && options.dismissable !== false) close(); });
    document.body.appendChild(back);
    return { el: back, body: back.querySelector('.fmdx-modal'), close };
  }

  // Anchored dropdown menu (theme picker, snapshot history).
  function openMenu(anchor, contentHtml){
    document.querySelector('.fmdx-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'fmdx-menu';
    menu.innerHTML = contentHtml;
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const menuWidth = Math.max(menu.offsetWidth, 240);
    menu.style.top = `${Math.round(rect.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)))}px`;
    const close = () => {
      document.removeEventListener('mousedown', onDown, true);
      menu.remove();
    };
    const onDown = (event) => { if (!menu.contains(event.target) && event.target !== anchor) close(); };
    setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
    return { el: menu, close };
  }

  // ------------------------------------- proposal scope-workflow bridge (§7)
  // The old proposals app exports its scope-configuration workflow for
  // external hosts: startProjectScopeWorkflow({ render, onComplete, onCancel })
  // routes every builder re-render through our callback, and completion hands
  // back a project scope whose root_items are EXACTLY the shape
  // params.scope_items expects (editable.scope.root_items). We render the
  // builder into a modal via renderProjectScopeBuilder({ left, main }).
  function scopeWorkflowModule(){
    const tab = window.Portal?.modules?.proposalsTab || window.Portal?.ProposalsTab || null;
    if (!tab || typeof tab.invoke !== 'function') return null;
    try {
      const names = arrayValue(tab.functionNames?.());
      if (!names.includes('startProjectScopeWorkflow') || !names.includes('renderProjectScopeBuilder')) return null;
    } catch (e) { return null; }
    return tab;
  }
  // Prefer the host-installed window shims (project-request/app.js) — they
  // route through proposalInvoke, which installs the shared project context
  // accessors (activeBaseProject, measurements) before the call.
  function scopeWorkflowInvoke(tab, name, args = []){
    try {
      if (typeof window[name] === 'function') return window[name](...args);
    } catch (e) { /* fall through to the module API */ }
    return tab.invoke(name, args);
  }


  // ------------------------------------- proposal piece vocabulary + generation
  /** The proposals module when it exposes ALL of the given functions. */
  function proposalEngineModule(requiredNames){
    const tab = window.Portal?.modules?.proposalsTab || window.Portal?.ProposalsTab || null;
    if (!tab || typeof tab.invoke !== 'function') return null;
    try {
      const names = arrayValue(tab.functionNames?.());
      if (!arrayValue(requiredNames).every((name) => names.includes(name))) return null;
    } catch (e) { return null; }
    return tab;
  }

  // Mirrors the legacy PROPOSAL_BUILDER_TEMPLATES defaults (apps/proposals) —
  // used only when PlatformAPI.scopes templates can't be loaded. The REAL
  // vocabulary is the org's scope templates (same records the legacy builder
  // loads through PlatformAPI.scopes.list).
  const FALLBACK_PIECE_CATALOG = [
    { id: 'roof_replacement', name: 'Roof Replacement', description: (globalThis.PlatformLanguage?.text("documents","m_374a375092faec","Replacement scope with per-structure measurements, roofing materials, deliveries, and production scheduling.") ?? "Replacement scope with per-structure measurements, roofing materials, deliveries, and production scheduling."), icon: 'fa-house-chimney', color: '#dc2626' },
    { id: 'repairs', name: 'Repairs', description: (globalThis.PlatformLanguage?.text("documents","m_2a5b6132b2a466","Repair-first scope with a lighter workflow and closeout path.") ?? "Repair-first scope with a lighter workflow and closeout path."), icon: 'fa-screwdriver-wrench', color: '#eab308' },
    { id: 'gutters', name: 'Gutters', description: (globalThis.PlatformLanguage?.text("documents","m_008fd0b95a704b","Gutter scope with material, run length, and installation scheduling details.") ?? "Gutter scope with material, run length, and installation scheduling details."), icon: 'fa-water', color: '#2563eb' },
    { id: 'maintenance', name: 'Maintenance', description: (globalThis.PlatformLanguage?.text("documents","m_613cd5fd842991","Recurring or one-time maintenance work for upkeep, inspection, and minor service tasks.") ?? "Recurring or one-time maintenance work for upkeep, inspection, and minor service tasks."), icon: 'fa-clipboard-check', color: '#0d9488' },
    { id: 'siding_replacement', name: 'Siding Replacement', description: (globalThis.PlatformLanguage?.text("documents","m_993980429157e6","Siding replacement scope for exterior wall areas, materials, color, and crew scheduling.") ?? "Siding replacement scope for exterior wall areas, materials, color, and crew scheduling."), icon: 'fa-layer-group', color: '#16a34a' },
    { id: 'manual', name: 'Manual', description: (globalThis.PlatformLanguage?.text("documents","m_f63722d5bd52fb","Start with a blank scope and build it by hand.") ?? "Start with a blank scope and build it by hand."), icon: 'fa-pen-to-square', color: '' }
  ];

  /** SAME generation the legacy proposal flow performs: for each selected
   *  piece, the proposals module's exported proposalBuilderScopeForTemplate
   *  (scope template + FirstMatePricebook.scopeItemFromPricebook + choice
   *  group shaping) builds one root scope item — NO pricing math lives here.
   *  Fallbacks (module absent): the pricebook's scopeItemFromPricebook for a
   *  same-id catalog item, else a blank editable scope row. The light piece
   *  metadata applied afterwards mirrors proposalBuilderApplyPieceMetadata
   *  (display name, template refs, per-piece choice-group namespacing). */
  function generateScopeItemsForSelection(selection, measurements){
    const pieces = arrayValue(selection).map(objectValue).filter((piece) => firstText(piece.template_id, piece.id));
    if (!pieces.length) return [];
    const tab = proposalEngineModule(['proposalBuilderScopeForTemplate']);
    const pricebook = window.FirstMatePricebook || window.Portal?.modules?.pricebook || null;
    let normalized = objectValue(measurements);
    if (tab) {
      try { normalized = objectValue(scopeWorkflowInvoke(tab, 'normalizeProposalMeasurements', [objectValue(measurements)])); }
      catch (e) { normalized = objectValue(measurements); }
    }
    return pieces.map((piece, index) => {
      const templateId = firstText(piece.template_id, piece.id);
      let root = null;
      if (tab) {
        try {
          const generated = scopeWorkflowInvoke(tab, 'proposalBuilderScopeForTemplate', [templateId, clone(normalized)]);
          if (generated && typeof generated === 'object' && firstText(generated.id)) root = generated;
        } catch (e) { root = null; }
      }
      if (!root && pricebook?.scopeItemFromPricebook) {
        try { root = pricebook.scopeItemFromPricebook(templateId, clone(normalized)) || null; }
        catch (e) { root = null; }
      }
      if (!root) {
        root = makeScopeItem({
          name: firstText(piece.name, templateId, 'Project piece'),
          display_name: firstText(piece.name, templateId, 'Project piece'),
          unit: 'scope'
        });
      }
      return applyScopePieceMetadata(root, piece, index);
    }).filter(Boolean);
  }

  /** Stamp a generated root with the piece it came from (display name,
   *  template refs) and namespace its choice groups per piece so two pieces
   *  never share a group — the rule proposalBuilderApplyPieceMetadata applies. */
  /** The structures the selected measurement dataset measured separately (see FMDocWorkflow.structures.fromDataset). */
  function datasetStructureFields(dataset){
    try { return objectValue(window.FMDocWorkflow?.structures?.fromDataset?.(dataset)); } catch (error) { return {}; }
  }

  function applyScopePieceMetadata(root, piece, index){
    if (!root || typeof root !== 'object' || !firstText(root.id)) return null;
    const templateId = firstText(piece.template_id, piece.id);
    const pieceId = firstText(piece.id, `piece_${templateId}_${index}`);
    root.scope_piece_id = pieceId;
    root.scope_template_id = templateId;
    root.display_name = firstText(piece.name, root.display_name, root.name, 'Project piece');
    root.name = root.display_name;
    if (firstText(piece.color)) root.scope_color = cleanText(piece.color);
    const prefixGroups = (item) => {
      const sel = objectValue(item.selection);
      if (firstText(sel.group_id) && !String(sel.group_id).includes(':')) {
        item.selection = { ...sel, group_id: `${pieceId}:${sel.group_id}` };
      }
      arrayValue(item.children).forEach((child) => prefixGroups(objectValue(child)));
    };
    prefixGroups(objectValue(root));
    return root;
  }

  // ----------------------------------------------------- lifecycle helpers
  const READ_ONLY_STATUSES = ['signed', 'completed', 'declined', 'expired', 'void'];
  const AMENDABLE_STATUSES = ['signed', 'completed'];
  function isReadOnlyStatus(status){ return READ_ONLY_STATUSES.includes(cleanText(status).toLowerCase()); }
  function isAmendableStatus(status){ return AMENDABLE_STATUSES.includes(cleanText(status).toLowerCase()); }

  // Best-effort total for the list cards, read straight off the instance
  // params (line-item math mirrors public/v1/proposals/scope.ts).
  function docTotalCents(doc){
    // The server's summary is the priced total of what was sent (or the draft).
    const summaryTotal = Number(objectValue(objectValue(doc).summary).total_cents);
    if (Number.isFinite(summaryTotal) && summaryTotal > 0) return Math.round(summaryTotal);
    const params = objectValue(objectValue(doc).params);
    for (const key of ['amount_due_cents', 'total_cents', 'amount_cents']) {
      const value = Number(params[key]);
      if (Number.isFinite(value) && value > 0) return Math.round(value);
    }
    for (const key of ['scope_items', 'line_items']) {
      const items = arrayValue(params[key]);
      if (!items.length) continue;
      let total = 0;
      const walk = (list) => arrayValue(list).forEach((raw) => {
        const item = objectValue(raw);
        const selected = item.selected !== false && objectValue(item.selection).selected !== false;
        if (selected && item.included !== true && item.price_driving !== false) {
          if (Number.isFinite(Number(item.amount_cents))) total += Math.round(Number(item.amount_cents));
          else if (Number.isFinite(Number(item.unit_price_cents))) total += Math.round((Number(item.quantity || 1) || 0) * Number(item.unit_price_cents));
          else total += Math.round((Number(item.quantity || 1) || 0) * (Number(item.unit_price ?? item.base_price ?? 0) || 0) * 100);
        }
        walk(item.children);
      });
      walk(items);
      if (total > 0) return total;
    }
    return 0;
  }

  // ------------------------------------------ commands → override ops (§4)
  const OVERRIDE_OPS = ['doc.set', 'node.set', 'node.insert', 'node.remove', 'node.move', 'page.insert', 'page.remove', 'page.move', 'page.set'];

  /**
   * Map one editor command (contracts §4 command bus) onto override ops
   * (contracts §3 / FMDocModel.OVERRIDE_OPS). Commands map ~1:1; anything the
   * op vocabulary can't express (group/ungroup/unknown) falls back to a
   * whole-pages doc.set snapshot of the editor's working document — heavy but
   * always correct, and consecutive fallbacks collapse to a single op.
   */
  function commandToOps(cmd, editorHandle, workingDoc){
    const command = objectValue(cmd);
    const type = cleanText(command.type);
    const nodeId = firstText(command.node_id, command.nodeId, command.id);
    const prop = firstText(command.prop, command.path);
    const pageId = firstText(command.page_id, command.pageId);
    switch (type) {
      case 'doc.set':
        if (prop) return [{ op: 'doc.set', prop, value: clone(command.value) }];
        break;
      case 'node.set':
        if (nodeId && prop) return [{ op: 'node.set', node_id: nodeId, prop, value: clone(command.value) }];
        break;
      case 'node.insert':
        if (command.node) {
          return [{
            op: 'node.insert',
            node: clone(command.node),
            ...(firstText(command.parent_id, command.parentId) ? { parent_id: firstText(command.parent_id, command.parentId) } : {}),
            ...(pageId ? { page_id: pageId } : {}),
            ...(Number.isFinite(Number(command.index)) ? { index: Number(command.index) } : {})
          }];
        }
        break;
      case 'node.remove': {
        const ids = arrayValue(command.node_ids || command.nodeIds || (nodeId ? [nodeId] : [])).map(cleanText).filter(Boolean);
        if (ids.length) return ids.map((id) => ({ op: 'node.remove', node_id: id }));
        break;
      }
      case 'node.move':
        if (nodeId) {
          return [{
            op: 'node.move',
            node_id: nodeId,
            ...(firstText(command.parent_id, command.parentId) ? { parent_id: firstText(command.parent_id, command.parentId) } : {}),
            ...(pageId ? { page_id: pageId } : {}),
            ...(Number.isFinite(Number(command.index)) ? { index: Number(command.index) } : {}),
            ...(command.frame ? { frame: clone(command.frame) } : {})
          }];
        }
        break;
      case 'node.reorder':
        if (nodeId && command.z !== undefined) return [{ op: 'node.set', node_id: nodeId, prop: 'frame.z', value: Number(command.z) || 0 }];
        break;
      case 'text.edit': {
        if (!nodeId) break;
        let blocks = command.blocks;
        if (blocks === undefined) {
          const source = editorHandle?.getDocument?.() || workingDoc;
          const found = source && window.FMDocModel?.findNode ? window.FMDocModel.findNode(source, nodeId) : null;
          blocks = found ? objectValue(found.node.props).blocks : undefined;
        }
        if (blocks !== undefined) return [{ op: 'node.set', node_id: nodeId, prop: 'props.blocks', value: clone(blocks) }];
        break;
      }
      case 'page.insert':
        if (command.page) return [{ op: 'page.insert', page: clone(command.page), ...(Number.isFinite(Number(command.index)) ? { index: Number(command.index) } : {}) }];
        break;
      case 'page.remove':
        if (pageId) return [{ op: 'page.remove', page_id: pageId }];
        break;
      case 'page.move':
        if (pageId) return [{ op: 'page.move', page_id: pageId, index: Number(command.index) || 0 }];
        break;
      case 'page.set':
        if (pageId && prop) return [{ op: 'page.set', page_id: pageId, prop, value: clone(command.value) }];
        break;
      default:
        // The command may already be a raw override op.
        if (OVERRIDE_OPS.includes(cleanText(command.op))) return [clone(command)];
        break;
    }
    // Fallback: whole-tree snapshot from the editor's working document.
    const doc = objectValue(editorHandle?.getDocument?.() || workingDoc);
    if (Array.isArray(doc.pages)) return [{ op: 'doc.set', prop: 'pages', value: clone(doc.pages) }];
    if (doc.root) return [{ op: 'doc.set', prop: 'root', value: clone(doc.root) }];
    return [];
  }

  function sameSetTarget(a, b){
    if (!a || !b || a.op !== b.op) return false;
    if (a.op === 'node.set') return a.node_id === b.node_id && a.prop === b.prop;
    if (a.op === 'page.set') return a.page_id === b.page_id && a.prop === b.prop;
    if (a.op === 'doc.set') return a.prop === b.prop;
    return false;
  }

  /** Collapse consecutive same-target set ops so the override log stays lean. */
  function collapseOps(ops){
    const out = [];
    for (const op of arrayValue(ops)) {
      if (!op) continue;
      if (out.length && sameSetTarget(out[out.length - 1], op)) out[out.length - 1] = op;
      else out.push(op);
    }
    return out;
  }

  // ---------------------------------------------------------- param fields
  function paramFieldHtml(key, def = {}, value, context = {}){
    const type = cleanText(def.type).toLowerCase() || 'string';
    const label = firstText(def.label, key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
    const req = def.required ? '<i class="req">*</i>' : '';
    const attrs = `data-param-key="${esc(key)}" data-param-type="${esc(type)}"`;
    const head = `<span>${esc(label)}${req}</span>`;
    if (type === 'entity') {
      const entity = cleanText(def.entity).toLowerCase();
      let display = 'Auto-filled';
      let icon = 'fa-link';
      if (entity === 'project') { display = firstText(context.project?.name, context.project?.title, context.project?.customer_name, 'This project'); icon = 'fa-diagram-project'; }
      else if (entity === 'contact' || entity === 'customer') { display = firstText(context.project?.customer_name, context.project?.customer?.name, 'Project customer'); icon = 'fa-user'; }
      return `<label class="fmdx-field">${head}<span class="fmdx-entity-chip" ${attrs} data-param-locked="1"><i class="fas ${esc(icon)}"></i>${esc(display)}</span></label>`;
    }
    if (isScopeItemsParam(key, def)) {
      // Rendered by the caller through mountScopeEditor into this container.
      return `<div class="fmdx-field wide">${head}<div data-scope-editor-for="${esc(key)}" ${attrs}></div></div>`;
    }
    if (type === 'boolean') {
      return `<label class="fmdx-check"><input type="checkbox" ${attrs} ${value === true ? 'checked' : ''}> ${esc(label)}${req}</label>`;
    }
    if (type === 'text' || type === 'address') {
      const text = type === 'address' && value && typeof value === 'object'
        ? firstText(value.formatted, [value.line1, value.line2, value.city, value.state, value.postal_code].filter(Boolean).join(', '))
        : cleanText(value);
      return `<label class="fmdx-field wide">${head}<textarea ${attrs} placeholder="${esc(def.placeholder || '')}">${esc(text)}</textarea></label>`;
    }
    if (type === 'select' || type === 'multi_select') {
      const options = arrayValue(def.options).map((opt) => {
        const v = typeof opt === 'object' ? firstText(opt.value, opt.id) : cleanText(opt);
        const l = typeof opt === 'object' ? firstText(opt.label, opt.value, opt.id) : cleanText(opt);
        const selected = type === 'multi_select' ? arrayValue(value).map(cleanText).includes(v) : cleanText(value) === v;
        return `<option value="${esc(v)}" ${selected ? 'selected' : ''}>${esc(l)}</option>`;
      }).join('');
      return `<label class="fmdx-field">${head}<select ${attrs} ${type === 'multi_select' ? 'multiple' : ''}><option value="">—</option>${options}</select></label>`;
    }
    if (type === 'currency') {
      const dollars = value === null || value === undefined || value === '' ? '' : (Number(value || 0) / 100).toFixed(2);
      return `<label class="fmdx-field">${head}<span class="fmdx-money"><input type="number" step="0.01" min="0" ${attrs} value="${esc(dollars)}" placeholder="0.00"></span></label>`;
    }
    if (type === 'number' || type === 'percent') {
      return `<label class="fmdx-field">${head}<input type="number" step="any" ${attrs} value="${value === null || value === undefined ? '' : esc(value)}"></label>`;
    }
    if (type === 'date') {
      return `<label class="fmdx-field">${head}<input type="date" ${attrs} value="${esc(cleanText(value).slice(0, 10))}"></label>`;
    }
    if (type === 'datetime') {
      return `<label class="fmdx-field">${head}<input type="datetime-local" ${attrs} value="${esc(cleanText(value).slice(0, 16))}"></label>`;
    }
    if (type === 'email' || type === 'phone') {
      return `<label class="fmdx-field">${head}<input type="${type === 'email' ? 'email' : 'tel'}" ${attrs} value="${esc(value)}"></label>`;
    }
    if (type === 'measurements' || type === 'payment_schedule' || type === 'media') {
      // Rich editors mounted by mountRichParamEditors(); the hidden textarea
      // keeps the JSON payload so collectParamValues() works unchanged. The
      // raw JSON stays reachable behind an "advanced" toggle.
      const json = value === null || value === undefined ? '' : (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      return `<div class="fmdx-field wide">${head}<div data-rich-param-for="${esc(key)}" data-rich-kind="${esc(type)}"></div><textarea ${attrs} data-param-json="1" class="fmdx-json-fallback" hidden spellcheck="false">${esc(json)}</textarea></div>`;
    }
    if (type === 'list' || type === 'object' || type === 'signature_request') {
      const json = value === null || value === undefined ? '' : (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      return `<label class="fmdx-field wide">${String(head)}<textarea ${String(attrs)} data-param-json="1" placeholder="${(globalThis.PlatformLanguage?.htmlText("documents","m_be0c75317a1197","JSON value") ?? "JSON value")}" spellcheck="false">${String(esc(json))}</textarea></label>`;
    }
    return `<label class="fmdx-field">${head}<input type="text" ${attrs} value="${esc(value)}" placeholder="${esc(def.placeholder || '')}"></label>`;
  }

  function collectParamValues(container, defs = {}, scopeEditors = new Map()){
    const values = {};
    container.querySelectorAll('[data-param-key]').forEach((el) => {
      const key = el.dataset.paramKey;
      if (!key || el.dataset.paramLocked === '1') return;
      if (scopeEditors.has(key)) { values[key] = scopeEditors.get(key).getItems(); return; }
      const type = cleanText(el.dataset.paramType).toLowerCase();
      if (el.type === 'checkbox') { values[key] = el.checked; return; }
      const raw = el.value;
      if (el.dataset.paramJson === '1') {
        const text = cleanText(raw);
        if (!text) { values[key] = null; return; }
        try { values[key] = JSON.parse(text); } catch (e) { values[key] = text; }
        return;
      }
      if (type === 'currency') { values[key] = cleanText(raw) === '' ? null : Math.round(Number(raw || 0) * 100); return; }
      if (type === 'number' || type === 'percent') { values[key] = cleanText(raw) === '' ? null : Number(raw); return; }
      if (type === 'multi_select' && el.tagName === 'SELECT') {
        values[key] = [...el.selectedOptions].map((opt) => opt.value).filter(Boolean);
        return;
      }
      values[key] = raw;
    });
    return values;
  }

  // ------------------------------------------------------ rich param editors
  // Structured UIs for measurements / payment_schedule / media params. Each
  // editor writes JSON into its hidden sibling textarea so collectParamValues
  // stays the single collection path; "Edit JSON" reveals the raw payload.

  function richParamState(holder){
    const field = holder.closest('.fmdx-field');
    const hidden = field?.querySelector('textarea[data-param-json]');
    const read = () => {
      const text = cleanText(hidden?.value);
      if (!text) return null;
      try { return JSON.parse(text); } catch (e) { return null; }
    };
    const write = (value) => {
      if (!hidden) return;
      hidden.value = value === null || value === undefined ? '' : JSON.stringify(value, null, 2);
    };
    return { field, hidden, read, write };
  }

  function richJsonToggleHtml(){
    return `<button type="button" class="fmdx-btn ghost tiny" data-rich-json-toggle><i class="fas fa-code"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_7a25664f092e7e"," Edit JSON") ?? " Edit JSON")}</button>`;
  }

  function bindRichJsonToggle(holder, state, rerender){
    holder.querySelector('[data-rich-json-toggle]')?.addEventListener('click', () => {
      const hidden = state.hidden;
      if (!hidden) return;
      const showing = !hidden.hidden;
      hidden.hidden = showing;
      if (showing) rerender();
    });
    state.hidden?.addEventListener('change', () => rerender());
  }

  function prettyKeyLabel(key){
    return cleanText(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function measurementSummaryChips(value){
    const chips = [];
    const source = objectValue(value);
    for (const [key, entry] of Object.entries(source)) {
      if (chips.length >= 14) { chips.push({ label: ((v0) => globalThis.PlatformLanguage?.text("documents","m_1d44c767357f4a",`+${v0} more`,{v0}) ?? `+${v0} more`)(Object.keys(source).length - 14), value: '' }); break; }
      if (entry === null || entry === undefined || entry === '') continue;
      if (typeof entry === 'number' || typeof entry === 'string' || typeof entry === 'boolean') {
        chips.push({ label: prettyKeyLabel(key), value: String(entry) });
      } else if (Array.isArray(entry)) {
        chips.push({ label: prettyKeyLabel(key), value: `${entry.length} ${entry.length === 1 ? 'entry' : 'entries'}` });
      } else if (typeof entry === 'object') {
        const numeric = Object.entries(entry).filter(([, v]) => typeof v === 'number').slice(0, 2);
        chips.push({ label: prettyKeyLabel(key), value: numeric.length ? numeric.map(([k, v]) => `${prettyKeyLabel(k)} ${v}`).join(' · ') : `${Object.keys(entry).length} fields` });
      }
    }
    return chips;
  }

  function projectMeasurements(projectObj){
    const p = objectValue(projectObj);
    return objectValue(p.measurements || p.data?.measurements || p.measurement_summary);
  }

  // Measurement keys the scope ACTUALLY needs: every formula_config token of
  // type "measurement" across the scope items (their children/variations),
  // plus — when the pricebook is loaded — the catalog item each row points at.
  function scopeMeasurementKeys(items){
    const keys = new Set();
    const pricebook = window.FirstMatePricebook;
    const addFromConfig = (config) => {
      arrayValue(objectValue(config).tokens).forEach((raw) => {
        const token = objectValue(raw);
        if (cleanText(token.type) === 'measurement' && cleanText(token.value)) keys.add(cleanText(token.value));
      });
    };
    const walk = (list) => arrayValue(list).forEach((raw) => {
      const item = objectValue(raw);
      addFromConfig(item.formula_config || item.formulaConfig);
      arrayValue(item.variations).forEach((variation) => addFromConfig(objectValue(variation).formula_config || objectValue(variation).formulaConfig));
      const ref = objectValue(item.pricebook_ref);
      const refId = firstText(ref.item_id, ref.catalog_item_id, ref.id);
      if (refId && pricebook?.getItem) {
        try {
          const pbItem = objectValue(pricebook.getItem(refId));
          addFromConfig(pbItem.formula_config || pbItem.formulaConfig);
        } catch (e) { /* pricebook not hydrated — formula keys from the item itself still count */ }
      }
      walk(item.children);
    });
    walk(items);
    return [...keys];
  }

  function measurementLabelFor(key){
    const pricebook = window.FirstMatePricebook;
    let fields = [];
    try { fields = arrayValue(pricebook?.formulaFields?.() || pricebook?.measurementFields); } catch (e) { fields = arrayValue(pricebook?.measurementFields); }
    return firstText(fields.find((field) => objectValue(field).key === key)?.label, prettyKeyLabel(key));
  }

  function mountMeasurementsParam(holder, context){
    const state = richParamState(holder);
    const render = () => {
      const value = state.read();
      const fromProject = projectMeasurements(context.project);
      const hasProject = Object.keys(fromProject).length > 0;
      // First open: the scope/project already defines the measurements — load
      // them automatically instead of asking for JSON.
      if ((value === null || (typeof value === 'object' && !Object.keys(objectValue(value)).length)) && hasProject) {
        state.write(fromProject);
        return render();
      }
      const current = objectValue(value);
      // Keys the scope's pricing formulas reference get first-class numeric
      // inputs; everything else keeps the summary chips + JSON fallback.
      const scopeItems = typeof context.getScopeItems === 'function' ? arrayValue(context.getScopeItems()) : [];
      const neededKeys = scopeMeasurementKeys(scopeItems);
      const missing = neededKeys.filter((key) => current[key] === undefined || current[key] === null || current[key] === '');
      const chips = measurementSummaryChips(
        Object.fromEntries(Object.entries(current).filter(([key]) => !neededKeys.includes(key)))
      );
      holder.innerHTML = `
        <div class="fmdx-rich-card">
          ${String(neededKeys.length ? `
            <p class="fmdx-data-hint" style="margin:0"><i class="fas fa-ruler-combined"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_77f0e7c9e9d01d"," These measurements drive this document’s line-item pricing:") ?? " These measurements drive this document’s line-item pricing:")}</p>
            <div class="fmdx-meas-grid">
              ${neededKeys.map((key) => {
                const filled = !(current[key] === undefined || current[key] === null || current[key] === '');
                return `
                  <label class="fmdx-meas-field ${filled ? '' : 'needed'}">
                    <span>${esc(measurementLabelFor(key))}</span>
                    <input type="number" step="any" min="0" data-measure-key="${esc(key)}" value="${filled ? esc(Number(current[key])) : ''}" placeholder="—">
                  </label>`;
              }).join('')}
            </div>
            ${missing.length ? `<p class="fmdx-meas-note"><i class="fas fa-triangle-exclamation"></i>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("documents","m_5d86a0fb6c1652",` ${v0} measurement${v1} still needed`,{v0,v1}) ?? ` ${v0} measurement${v1} still needed`)(missing.length,missing.length === 1 ? '' : 's')}</p>` : ''}` : '')}
          ${String(chips.length
            ? `<div class="fmdx-stat-grid">${chips.map((chip) => `<span class="fmdx-stat"><i>${esc(chip.label)}</i><b>${esc(chip.value)}</b></span>`).join('')}</div>`
            : (neededKeys.length ? '' : `<p class="fmdx-data-hint">${(globalThis.PlatformLanguage?.htmlText("documents","m_ebfc9ac0d87754","No measurements yet. Load them from the project, or paste JSON.") ?? "No measurements yet. Load them from the project, or paste JSON.")}</p>`))}
          <div class="fmdx-rich-actions">
            <button type="button" class="fmdx-btn ghost tiny" data-measure-reload ${String(hasProject ? '' : 'disabled title="This project has no stored measurements yet"')}><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_641beeb7a2ff91"," Load from project") ?? " Load from project")}</button>
            ${String(chips.length || neededKeys.length ? `<button type="button" class="fmdx-btn ghost tiny" data-measure-clear><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_687e1653230514"," Clear") ?? " Clear")}</button>` : '')}
            ${String(richJsonToggleHtml())}
          </div>
        </div>`;
      holder.querySelectorAll('[data-measure-key]').forEach((input) => {
        input.addEventListener('change', () => {
          const next = objectValue(state.read());
          const key = input.dataset.measureKey;
          if (cleanText(input.value) === '') delete next[key];
          else next[key] = Number(input.value) || 0;
          state.write(Object.keys(next).length ? next : null);
          render();
        });
      });
      holder.querySelector('[data-measure-reload]')?.addEventListener('click', () => { state.write(projectMeasurements(context.project)); render(); });
      holder.querySelector('[data-measure-clear]')?.addEventListener('click', () => { state.write(null); render(); });
      bindRichJsonToggle(holder, state, render);
    };
    render();
    return { rerender: render };
  }

  const SCHEDULE_DUE_OPTIONS = [
    { value: 'on_signature', label: (globalThis.PlatformLanguage?.text("documents","m_59188fee8a4092","On signature") ?? "On signature") },
    { value: 'project_completion', label: (globalThis.PlatformLanguage?.text("documents","m_840d3d973229d1","On completion") ?? "On completion") },
    { value: 'on_invoice', label: (globalThis.PlatformLanguage?.text("documents","m_7e182460eb9a7a","When invoiced") ?? "When invoiced") },
    { value: 'on_date', label: (globalThis.PlatformLanguage?.text("documents","m_b05e5c3ce8a9f2","Specific date") ?? "Specific date") }
  ];

  function normalizeScheduleRow(row, index){
    const source = objectValue(row);
    const kind = cleanText(source.kind) === 'fixed' || Number(source.amount_cents) > 0 ? 'fixed' : 'percent';
    return {
      id: firstText(source.id, `sched_${index}_${Math.random().toString(36).slice(2, 7)}`),
      label: firstText(source.label, source.title, index === 0 ? 'Deposit' : 'Payment'),
      kind,
      percent: Number(source.percent ?? (Number(source.percent_bps) ? Number(source.percent_bps) / 100 : 0)) || 0,
      amount_cents: Math.round(Number(source.amount_cents) || 0),
      due_rule: firstText(source.due_rule, source.due, 'on_signature'),
      due_date: cleanText(source.due_date).slice(0, 10)
    };
  }

  function mountPaymentScheduleParam(holder, context){
    const state = richParamState(holder);
    const rows = arrayValue(state.read()).map(normalizeScheduleRow);
    const sync = () => state.write(rows.length ? rows : null);
    const render = () => {
      sync();
      const percentTotal = rows.filter((r) => r.kind === 'percent').reduce((acc, r) => acc + r.percent, 0);
      const fixedTotal = rows.filter((r) => r.kind === 'fixed').reduce((acc, r) => acc + r.amount_cents, 0);
      holder.innerHTML = `
        <div class="fmdx-rich-card">
          ${String(rows.length ? `
            <div class="fmdx-sched-rows">
              ${rows.map((row, index) => `
                <div class="fmdx-sched-row" data-sched-index="${index}">
                  <input type="text" data-sched-label placeholder="${(globalThis.PlatformLanguage?.htmlText("documents","m_9fd79f4276d659","Label") ?? "Label")}" value="${esc(row.label)}">
                  <select data-sched-kind>
                    <option value="percent" ${row.kind === 'percent' ? 'selected' : ''}>%</option>
                    <option value="fixed" ${row.kind === 'fixed' ? 'selected' : ''}>$</option>
                  </select>
                  ${row.kind === 'percent'
                    ? `<input type="number" data-sched-amount min="0" max="100" step="0.5" value="${esc(row.percent)}">`
                    : `<input type="number" data-sched-amount min="0" step="0.01" value="${esc((row.amount_cents / 100).toFixed(2))}">`}
                  <select data-sched-due>
                    ${SCHEDULE_DUE_OPTIONS.map((opt) => `<option value="${esc(opt.value)}" ${row.due_rule === opt.value ? 'selected' : ''}>${esc(opt.label)}</option>`).join('')}
                  </select>
                  ${row.due_rule === 'on_date' ? `<input type="date" data-sched-date value="${esc(row.due_date)}">` : ''}
                  <button type="button" class="fmdx-icon-btn" data-sched-remove title="${(globalThis.PlatformLanguage?.htmlText("documents","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-trash"></i></button>
                </div>`).join('')}
            </div>
            <p class="fmdx-data-hint">${percentTotal ? `${percentTotal}% scheduled` : ''}${percentTotal && fixedTotal ? ' · ' : ''}${fixedTotal ? `$${(fixedTotal / 100).toFixed(2)} fixed` : ''}${percentTotal > 100 ? ' — over 100%' : ''}</p>`
            : `<p class="fmdx-data-hint">${(globalThis.PlatformLanguage?.htmlText("documents","m_13991f0e0abcf7","No payment schedule. Add milestones, or use the quick preset.") ?? "No payment schedule. Add milestones, or use the quick preset.")}</p>`)}
          <div class="fmdx-rich-actions">
            <button type="button" class="fmdx-btn ghost tiny" data-sched-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_00a6dac3bb30c9"," Add milestone") ?? " Add milestone")}</button>
            ${String(rows.length ? '' : `<button type="button" class="fmdx-btn ghost tiny" data-sched-preset><i class="fas fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_e718d425696681"," 30% deposit / 70% completion") ?? " 30% deposit / 70% completion")}</button>`)}
            ${String(richJsonToggleHtml())}
          </div>
        </div>`;
      holder.querySelectorAll('.fmdx-sched-row').forEach((rowEl) => {
        const index = Number(rowEl.dataset.schedIndex);
        const row = rows[index];
        if (!row) return;
        rowEl.querySelector('[data-sched-label]')?.addEventListener('change', (e) => { row.label = cleanText(e.target.value) || row.label; sync(); });
        rowEl.querySelector('[data-sched-kind]')?.addEventListener('change', (e) => { row.kind = e.target.value === 'fixed' ? 'fixed' : 'percent'; render(); });
        rowEl.querySelector('[data-sched-amount]')?.addEventListener('change', (e) => {
          if (row.kind === 'percent') row.percent = Math.max(0, Number(e.target.value) || 0);
          else row.amount_cents = Math.max(0, Math.round(Number(e.target.value || 0) * 100));
          render();
        });
        rowEl.querySelector('[data-sched-due]')?.addEventListener('change', (e) => { row.due_rule = e.target.value; render(); });
        rowEl.querySelector('[data-sched-date]')?.addEventListener('change', (e) => { row.due_date = cleanText(e.target.value); sync(); });
        rowEl.querySelector('[data-sched-remove]')?.addEventListener('click', () => { rows.splice(index, 1); render(); });
      });
      holder.querySelector('[data-sched-add]')?.addEventListener('click', () => {
        rows.push(normalizeScheduleRow({ label: rows.length ? 'Payment' : 'Deposit', kind: 'percent', percent: rows.length ? 0 : 30 }, rows.length));
        render();
      });
      holder.querySelector('[data-sched-preset]')?.addEventListener('click', () => {
        rows.splice(0, rows.length,
          normalizeScheduleRow({ label: (globalThis.PlatformLanguage?.text("documents","m_894309a0cbf8a4","Deposit") ?? "Deposit"), kind: 'percent', percent: 30, due_rule: 'on_signature' }, 0),
          normalizeScheduleRow({ label: (globalThis.PlatformLanguage?.text("documents","m_eb3b751277fbeb","Final payment") ?? "Final payment"), kind: 'percent', percent: 70, due_rule: 'project_completion' }, 1));
        render();
      });
      bindRichJsonToggle(holder, state, render);
    };
    render();
  }

  function projectPhotoRefs(projectObj){
    const p = objectValue(projectObj);
    const photos = arrayValue(p.photos || p.data?.photos || p.media);
    return photos
      .map((photo) => objectValue(photo))
      .map((photo) => ({ media_id: firstText(photo.media_id, photo.id), label: firstText(photo.label, photo.file_name, '') }))
      .filter((photo) => photo.media_id);
  }

  function mountMediaParam(holder, context){
    const state = richParamState(holder);
    const render = () => {
      const value = objectValue(state.read());
      const selectedId = firstText(value.media_id, value.id);
      const photos = projectPhotoRefs(context.project).slice(0, 24);
      const thumbUrl = (mediaId) => window.PlatformAPI?.media?.thumbnailUrl?.(context.orgId, mediaId, 320) || '';
      holder.innerHTML = `
        <div class="fmdx-rich-card">
          ${photos.length ? `
            <div class="fmdx-photo-pick-grid">
              ${photos.map((photo) => `
                <button type="button" class="fmdx-photo-pick ${photo.media_id === selectedId ? 'active' : ''}" data-pick-media="${esc(photo.media_id)}" title="${esc(photo.label)}">
                  <img src="${esc(thumbUrl(photo.media_id))}" alt="${esc(photo.label || 'Project photo')}" loading="lazy">
                  ${photo.media_id === selectedId ? '<i class="fas fa-circle-check"></i>' : ''}
                </button>`).join('')}
            </div>`
            : `<p class="fmdx-data-hint">${(globalThis.PlatformLanguage?.htmlText("documents","m_5a86caef245f9c","No project photos yet — upload photos to the project to pick one here.") ?? "No project photos yet — upload photos to the project to pick one here.")}</p>`}
          <div class="fmdx-rich-actions">
            ${selectedId ? `<button type="button" class="fmdx-btn ghost tiny" data-pick-clear><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_f4875af91310b6"," Remove selection") ?? " Remove selection")}</button>` : ''}
            ${richJsonToggleHtml()}
          </div>
        </div>`;
      holder.querySelectorAll('[data-pick-media]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.write({ media_id: btn.dataset.pickMedia, variant: 'display' });
          render();
        });
      });
      holder.querySelector('[data-pick-clear]')?.addEventListener('click', () => { state.write(null); render(); });
      bindRichJsonToggle(holder, state, render);
    };
    render();
  }

  /** Mount structured editors for every rich param container in the form.
   *  Returns a Map of param key → handle ({ rerender }) where available. */
  function mountRichParamEditors(container, context = {}){
    const handles = new Map();
    container.querySelectorAll('[data-rich-param-for]').forEach((holder) => {
      const kind = cleanText(holder.dataset.richKind);
      const key = cleanText(holder.dataset.richParamFor);
      if (kind === 'measurements') handles.set(key, mountMeasurementsParam(holder, context));
      else if (kind === 'payment_schedule') mountPaymentScheduleParam(holder, context);
      else if (kind === 'media') mountMediaParam(holder, context);
    });
    return handles;
  }

  // =========================================================================
  // App mount
  // =========================================================================
  function mountDocumentsTab(context = {}){
    ensureStyles();

    const root = context.roots?.main || context.panelRoot || context.root;
    if (!root) return { destroy(){} };

    // Embedded service mode (Docs-tab consolidation): when the host mounts us
    // with params.embed = { enabled:true, ... }, this module renders NO list of
    // its own — the unified Docs tab (apps/docs/project.js) owns the browsing
    // surface and drives the create wizard / editor through the embed API
    // handed to embed.onReady. The doc screen (editor/workflow) still renders
    // into our root; the host shows/hides that root via onDocScreen/onListView.
    const embed = objectValue(objectValue(context.params).embed);
    const embedded = embed.enabled === true;

    // Readable text on primary buttons: resolve the org primary from the
    // mounted context (portal/theme variables) and publish --fmdx-on-primary.
    syncOnPrimaryVar(root);

    const state = {
      destroyed: false,
      active: context.active !== false,
      view: 'list',                    // 'list' | 'editor'
      docs: [],
      loading: false,
      loadError: null,
      loaded: false,
      catalog: null,                  // { widgets, types, themes, fonts }
      departmentContext: {},
      departmentId: "",
      templates: null,                // cached templates list
      // editor state
      doc: null,                      // current instance record
      resolved: null,                 // latest /resolve payload
      working: null,                  // { definition, fromTemplate } — overrides applied to the template
      editorHandle: null,
      workingDoc: null,               // latest editor document (dirty copy)
      baseOverrides: [],              // overrides already persisted on the instance
      pendingOps: [],                 // accumulated command→override ops not yet PATCHed
      dirty: false,
      saving: false,
      saveTimer: 0,
      saveFailures: 0,
      saveState: 'idle',              // idle|dirty|saving|saved|error|conflict
      dataPanelOpen: true,
      previewCleanup: null,
      // workflow view (contracts §8)
      docWorkflow: null,              // { definition, state } for the open doc (null = none)
      workflowHandle: null,           // FMDocWorkflow mount handle
      workflowWrites: { params: {}, outputs: {} },
      workflowFlushTimer: 0,
      workflowFlushing: null,
      // unified document screen (one top bar for BOTH views)
      docView: 'editor',              // 'editor' | 'workflow' — sub-mode of view 'editor'
      editorLoaded: false,            // editor canvas resolved + mounted at least once
      editorLoading: false,
      workflowTouched: false,         // workflow wrote data since the editor last resolved
      pieceCatalog: null,             // cached scope-template piece vocabulary
      cardTotalCents: null            // live total from the last resolve (rail doc card)
    };

    const orgId = () => firstText(context.orgId, window.Portal?.cfg?.userOrgId, window.__APP?.userOrgId, window.__APP?.orgId);
    const project = () => context.project || context.activeProject || context.host?.getProject?.() || {};
    const projectId = () => firstText(project()?.id, project()?.platform_project_id, context.projectId, context.entityId);
    const api = () => window.DocumentsAPI;

    function capabilityEnabled(key){
      const caps = context.capabilities?.current?.() || window.Portal?.capabilities?.current?.() || null;
      if (caps?.effective_by_key && Object.prototype.hasOwnProperty.call(caps.effective_by_key, key)) return caps.effective_by_key[key] === true;
      return objectValue(state.catalog?.capabilities)[key] === true;
    }

    // Create under the project when we have one, standalone otherwise
    // (doc-first flows attach the document to a project later via PATCH).
    function createDocumentRecord(body = {}){
      const pid = projectId();
      return pid
        ? api().documents.createForProject(orgId(), pid, body)
        : api().documents.createStandalone(orgId(), body);
    }
    function rememberStandaloneDoc(doc){
      if (projectId() || !doc?.id) return;
      const index = state.docs.findIndex((entry) => cleanText(entry.id) === cleanText(doc.id));
      if (index >= 0) state.docs[index] = doc;
      else state.docs.push(doc);
      if (embedded) embed.onDocsChanged?.(state.docs);
    }

    // Unlock-to-designer gate: honor the capability registry when it exposes a
    // matching node; when the capability can't be read at all, allow (contract
    // §5: gate on capability if you can read it, else allow).
    function designerAllowed(){
      return capabilityEnabled('documents.designer_profile');
    }

    function hasPermission(key){
      const permissions = objectValue(context.permissions);
      return permissions[key] === true || (permissions[key] !== false && permissions['*'] === true);
    }

    // Effective edit policy: the template's edit_policy rails, with the unlock
    // escalation additionally gated on this user's capability/permission.
    function editPolicyFor(definition){
      const policy = objectValue(objectValue(definition).edit_policy);
      const unlock = objectValue(policy.unlock);
      let allowed = unlock.allowed !== false && designerAllowed();
      const permission = firstText(unlock.permission);
      if (allowed && permission && !hasPermission(permission)) allowed = false;
      const base = firstText(policy.base_profile, 'document');
      return {
        ...policy,
        features: {
          ...objectValue(policy.features),
          widget_insert: arrayValue(state.catalog?.widgets).map((widget) => firstText(widget.id, widget.widget_id)).filter(Boolean),
          ...(capabilityEnabled('documents.advanced_definition_editing') ? {} : { bind_edit: false })
        },
        base_profile: base,
        max_profile: allowed ? firstText(policy.max_profile, 'designer') : base,
        unlock: { ...unlock, allowed }
      };
    }

    function projectContacts(){
      const p = project();
      const contacts = arrayValue(p.contacts)
        .filter((c) => c && (c.email || c.name || c.phone))
        .map((c, index) => ({
          name: firstText(c.name, `Contact ${index + 1}`),
          email: cleanText(c.email),
          phone: cleanText(c.phone),
          role: firstText(c.role, 'customer'),
          primary: c.primary === true || (index === 0 && !arrayValue(p.contacts).some((x) => x?.primary === true))
        }));
      if (contacts.length) return contacts;
      const name = firstText(p.customer_name, p.customer?.name);
      const email = firstText(p.customer_email, p.primary_contact_email, p.customer?.email);
      if (name || email) return [{ name: name || 'Customer', email, phone: cleanText(p.customer_phone), role: 'customer', primary: true }];
      return [];
    }

    function primaryContact(){
      const contacts = projectContacts();
      const primary = contacts.find((c) => c.primary) || contacts[0] || {};
      return { name: firstText(primary.name), email: firstText(primary.email) };
    }

    // ------------------------------------------------------------- loading
    async function loadCatalog(force = false){
      if (state.catalog && !force) return state.catalog;
      try {
        const res = await api().catalog.get(orgId());
        const data = objectValue(res.catalog) && Object.keys(objectValue(res.catalog)).length ? res.catalog : res;
        state.catalog = {
          widgets: arrayValue(data.widgets),
          types: arrayValue(data.types),
          themes: arrayValue(data.themes),
          fonts: arrayValue(data.fonts),
          params: objectValue(data.params),
          capabilities: objectValue(data.capabilities)
        };
      } catch (error) {
        state.catalog = state.catalog || { widgets: [], types: [], themes: [], fonts: [], params: {}, capabilities: {} };
        console.warn('Documents catalog unavailable', error);
      }
      return state.catalog;
    }

    async function loadDocs(options = {}){
      if (!api()) { state.loadError = { missing: true }; render(); return; }
      // Standalone mode (doc-first flows, no project yet): there is no server
      // list to fetch — the instance only knows the documents it created this
      // session (rememberStandaloneDoc).
      if (!projectId()) {
        state.loading = false;
        state.loaded = true;
        state.loadError = null;
        if (!state.destroyed) render();
        if (!state.destroyed && embedded) embed.onDocsChanged?.(state.docs);
        return;
      }
      state.loading = true;
      if (options.silent !== true) render();
      try {
        const res = await api().documents.listForProject(orgId(), projectId(), { department_id: state.departmentId });
        state.departmentContext = objectValue(res.department_context);
        state.docs = arrayValue(res.documents || res.items).map((doc) => objectValue(doc));
        state.loadError = null;
        state.loaded = true;
      } catch (error) {
        state.loadError = error;
        state.docs = [];
      } finally {
        state.loading = false;
        if (!state.destroyed) render();
        if (!state.destroyed && embedded) embed.onDocsChanged?.(state.docs);
      }
    }

    async function loadTemplates(force = false){
      if (state.templates && !force) return state.templates;
      try {
        const res = await api().templates.list(orgId());
        state.departmentContext = objectValue(res.department_context);
        state.templates = arrayValue(res.templates || res.items).map(objectValue);
      } catch (error) {
        state.templates = [];
        console.warn('Document templates unavailable', error);
      }
      return state.templates;
    }

    async function templateDefinition(template){
      if (!template) return null;
      if (objectValue(template.definition).pages || objectValue(template.definition).root) return template.definition;
      try {
        const version = Number(template.current_version || 0);
        if (version > 0) {
          const res = await api().templates.version(orgId(), template.id, version);
          const record = objectValue(res.version || res.template_version || res);
          if (objectValue(record.definition).pages || objectValue(record.definition).root) return record.definition;
        }
      } catch (error) { console.warn('Template version unavailable', error); }
      return null;
    }

    // -------------------------------------------------------------- render
    function render(){
      if (state.destroyed) return;
      // A background refresh must not take the opening screen away.
      if (state.openingDoc && state.view !== 'editor' && root.querySelector('[data-fmdx-opening]')) return;
      if (state.view === 'editor') {
        renderDocScreen();
        return;
      }
      if (embedded) {
        // The Docs tab renders the list — clear our surface and let the host
        // bring its gallery back.
        root.innerHTML = '';
        embed.onListView?.();
        return;
      }
      renderList();
    }

    function renderList(){
      const docs = state.docs.filter((doc) => cleanText(doc.status).toLowerCase() !== 'void');
      root.innerHTML = `
        <div class="fmdx-shell">
          <header class="fmdx-top">
            <div class="fmdx-top-title">
              <strong><i class="fas fa-file-signature" style="color:var(--fmdx-primary)"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_fab6ec5986f912"," Documents") ?? " Documents")}</strong>
              <span>${String(docs.length ? `${docs.length} document${docs.length === 1 ? '' : 's'} on this project` : 'Proposals, contracts, invoices & more')}</span>
            </div>
            <div class="fmdx-top-actions">
              ${state.departmentContext.show_selector ? `<select class="fmdx-input" style="width:auto;max-width:180px" aria-label="${esc(state.departmentContext.department_label || 'Department')}" data-fmdx-department><option value="">${esc('All available ' + (state.departmentContext.departments_label || 'departments'))}</option>${arrayValue(state.departmentContext.departments).map(d => `<option value="${esc(d.id)}" ${state.departmentId === d.id ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select>` : ''}
              ${String(capabilityEnabled('documents.ingestion') ? `<label class="fmdx-btn fmdx-upload-btn"><i class="fas fa-arrow-up-from-bracket"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_9ca9dace4f122f"," Upload") ?? " Upload")}<input type="file" data-fmdx-upload accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,application/pdf,image/*" multiple></label>` : '')}
              <button type="button" class="fmdx-btn primary" data-fmdx-new><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_7754e23bbfc088"," New document") ?? " New document")}</button>
            </div>
          </header>
          <div class="fmdx-body" data-fmdx-list></div>
        </div>`;
      root.querySelector('[data-fmdx-department]')?.addEventListener('change', event => { state.departmentId = event.target.value; loadDocs({ silent:true }); });
      const listEl = root.querySelector('[data-fmdx-list]');
      if (state.loading && !state.loaded) {
        listEl.innerHTML = `<div class="fmdx-state"><div class="fmdx-spinner"></div><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_34768a8382fa48","Loading documents") ?? "Loading documents")}</strong></div>`;
      } else if (state.loadError?.missing || !api()) {
        listEl.innerHTML = `<div class="fmdx-state"><i class="fas fa-plug-circle-xmark"></i><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_ba70ff7085cae0","Documents service unavailable") ?? "Documents service unavailable")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_4643897f23dcba","The documents API client is not loaded for this session.") ?? "The documents API client is not loaded for this session.")}</span></div>`;
      } else if (state.loadError) {
        listEl.innerHTML = `<div class="fmdx-state"><i class="fas fa-cloud-bolt"></i><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_3c874fe4c55ac0","Couldn’t load documents") ?? "Couldn’t load documents")}</strong><span>${String(esc(errorMessage(state.loadError, '')))}</span><button type="button" class="fmdx-btn" data-fmdx-retry><i class="fas fa-rotate-right"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_cbfbb44ff35f0f"," Try again") ?? " Try again")}</button></div>`;
        listEl.querySelector('[data-fmdx-retry]')?.addEventListener('click', () => loadDocs());
      } else if (!docs.length) {
        listEl.innerHTML = `<div class="fmdx-state"><i class="fas fa-file-medical"></i><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_23a05531a1d864","No documents yet") ?? "No documents yet")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_85443b85cda373","Create a document from an approved template.") ?? "Create a document from an approved template.")}</span><button type="button" class="fmdx-btn primary" data-fmdx-empty-new><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_7754e23bbfc088"," New document") ?? " New document")}</button></div>`;
        listEl.querySelector('[data-fmdx-empty-new]')?.addEventListener('click', () => openCreateModal());
      } else {
        listEl.innerHTML = `<div class="fmdx-doc-list">${docs.map(docRowHtml).join('')}</div>`;
        bindListRows(listEl);
      }
      root.querySelector('[data-fmdx-new]')?.addEventListener('click', () => openCreateModal());
      if (projectId()) {
        const launch = document.createElement('button'); launch.type = 'button'; launch.className = 'fmdx-btn'; launch.textContent = (globalThis.PlatformLanguage?.text("documents","m_abe699167c0dad","Documents & workflows") ?? "Documents & workflows");
        launch.onclick = async () => { try { const { openModuleInstances } = await import('/libraries/apps/documents/program-panel.js'); await openModuleInstances(orgId(), projectId()); } catch(error) { showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"),errorMessage(error),false); } };
        root.querySelector('[data-fmdx-new]')?.before(launch);
      }
      root.querySelector('[data-fmdx-upload]')?.addEventListener('change', (event) => {
        uploadFiles(event.target.files);
        event.target.value = '';
      });
    }

    function docRowHtml(doc){
      const meta = typeMeta(doc.document_type, state.catalog?.types);
      const pdf = objectValue(doc.pdf);
      const pageCount = Number(pdf.page_count || doc.page_count || 0);
      const needsReview = cleanText(doc.status).toLowerCase() === 'needs_review' || objectValue(doc.ingestion).needs_review === true;
      const uploaded = cleanText(doc.source).toLowerCase() === 'uploaded';
      const updated = firstText(doc.updated_at, doc.created_at);
      const totalCents = docTotalCents(doc);
      const readOnly = isReadOnlyStatus(doc.status);
      const metaBits = [
        `<span class="fmdx-badge" style="--fmdx-doc-color:${esc(meta.color)}">${esc(meta.label)}</span>`,
        uploaded ? `<span class="fmdx-badge" style="--fmdx-doc-color:#b54708"><i class="fas fa-arrow-up-from-bracket"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_303e8fa1e345f5"," Uploaded") ?? " Uploaded")}</span>` : '',
        needsReview && cleanText(doc.status).toLowerCase() !== 'needs_review' ? `<span class="fmdx-chip needs_review">${(globalThis.PlatformLanguage?.htmlText("documents","m_00c9ae159a1656","Needs review") ?? "Needs review")}</span>` : '',
        updated ? `<span><i class="far fa-clock"></i> ${esc(timeAgo(updated))}</span>` : '',
        pageCount ? `<span><i class="far fa-file"></i>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("documents","m_01f08ac1f4370c",` ${v0} page${v1}`,{v0,v1}) ?? ` ${v0} page${v1}`)(pageCount,pageCount === 1 ? '' : 's')}</span>` : '',
        pdf.latest_media_id ? `<span><i class="far fa-file-pdf"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_fffdbbba28616b"," PDF ready") ?? " PDF ready")}</span>` : ''
      ].filter(Boolean).join('');
      return `
        <div class="fmdx-doc-row" data-doc-id="${String(esc(doc.id))}" style="--fmdx-doc-color:${String(esc(meta.color))}">
          <span class="fmdx-doc-icon"><i class="fas ${String(esc(meta.icon))}"></i></span>
          <div class="fmdx-doc-main" data-doc-open title="${(globalThis.PlatformLanguage?.htmlText("documents","m_c25cc66b28cc9d","Open") ?? "Open")}">
            <strong>${String(esc(firstText(doc.title, meta.label)))}</strong>
            <div class="fmdx-doc-meta">${String(metaBits)}</div>
          </div>
          ${String(totalCents ? `<span class="fmdx-doc-total">${esc(moneyFromCents(totalCents))}</span>` : '')}
          ${String(progressChip(doc))}
          <div class="fmdx-doc-actions">
            <button type="button" class="fmdx-btn" data-doc-open-btn><i class="fas ${String(readOnly ? 'fa-eye' : 'fa-pen')}"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_c47557fbf9d3f5"," Open") ?? " Open")}</button>
            <button type="button" class="fmdx-icon-btn" data-doc-preview title="${(globalThis.PlatformLanguage?.htmlText("documents","m_afff48796c3165","Preview") ?? "Preview")}"><i class="fas fa-eye"></i></button>
            <button type="button" class="fmdx-icon-btn" data-doc-send title="${(globalThis.PlatformLanguage?.htmlText("documents","m_c23a056552a09f","Send") ?? "Send")}"><i class="fas fa-paper-plane"></i></button>
            <button type="button" class="fmdx-icon-btn" data-doc-pdf title="${(globalThis.PlatformLanguage?.htmlText("documents","m_4944e59816b60a","Download PDF") ?? "Download PDF")}"><i class="fas fa-file-pdf"></i></button>
            ${!readOnly && cleanText(doc.status) === 'draft' ? '<button type="button" class="fmdx-icon-btn" data-doc-tags title="Document tags"><i class="fas fa-tags"></i></button>' : ''}<button type="button" class="fmdx-icon-btn" data-doc-duplicate title="${(globalThis.PlatformLanguage?.htmlText("documents","m_24fc1d3519ef6a","Duplicate") ?? "Duplicate")}"><i class="fas fa-copy"></i></button>
            ${String(readOnly ? '' : `<button type="button" class="fmdx-icon-btn danger" data-doc-archive title="${(globalThis.PlatformLanguage?.htmlText("documents","m_ce16922c5208b8","Void") ?? "Void")}"><i class="fas fa-ban"></i></button>`)}
          </div>
        </div>`;
    }

    function bindListRows(listEl){
      listEl.querySelectorAll('[data-doc-id]').forEach((row) => {
        const doc = state.docs.find((d) => cleanText(d.id) === row.dataset.docId);
        if (!doc) return;
        const openDoc = cleanText(doc.source).toLowerCase() === 'uploaded' ? () => openUploadReview(doc) : () => openEditor(doc);
        row.querySelector('[data-doc-open]')?.addEventListener('click', openDoc);
        row.querySelector('[data-doc-open-btn]')?.addEventListener('click', openDoc);
        row.querySelector('[data-doc-preview]')?.addEventListener('click', () => openPreview(doc));
        row.querySelector('[data-doc-send]')?.addEventListener('click', () => openSendModal(doc));
        row.querySelector('[data-doc-pdf]')?.addEventListener('click', (event) => downloadPdf(doc, event.currentTarget));
        row.querySelector('[data-doc-tags]')?.addEventListener('click', async () => { try { const { openTagManager } = await import(new URL('./tag-manager.js', SCRIPT_URL).href); await openTagManager(orgId(), { tags:arrayValue(doc.tags), save:async tags => { await api().documents.patch(orgId(),doc.id,{tags,expected_revision:doc.revision}); await loadDocs({silent:true}); } }); } catch(error) { showToast('Document tags',errorMessage(error),false); } });
        row.querySelector('[data-doc-duplicate]')?.addEventListener('click', (event) => duplicateDoc(doc, event.currentTarget));
        row.querySelector('[data-doc-archive]')?.addEventListener('click', () => archiveDoc(doc));
      });
    }

    // Duplicate = a fresh draft with the same type/template/params/theme.
    async function duplicateDoc(doc, button){
      if (button) button.disabled = true;
      try {
        const res = await createDocumentRecord({
          document_type: cleanText(doc.document_type) || 'generic',
          template_id: firstText(objectValue(doc.template_ref).template_id) || undefined,
          workflow_id: firstText(objectValue(doc.workflow_ref).workflow_id) || undefined,
          title: ((v0) => globalThis.PlatformLanguage?.text("documents","m_69a8e411deda5e",`${v0} (copy)`,{v0}) ?? `${v0} (copy)`)(firstText(doc.title, 'Document')),
          tags: arrayValue(doc.tags),
          params: clone(objectValue(doc.params)),
          ...(doc.theme_ref ? { theme_ref: clone(doc.theme_ref) } : {})
        });
        showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_2e37959a7fa632","Draft copy created.") ?? "Draft copy created."), true);
        rememberStandaloneDoc(objectValue(res.document || res.doc || res));
        await loadDocs({ silent: true });
        openEditor(objectValue(res.document || res.doc || res));
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not duplicate the document.'), false);
      } finally {
        if (button) button.disabled = false;
      }
    }

    // -------------------------------------------------------------- upload
    // The ingest endpoint takes JSON { file_name, content_type, data_base64 }
    // (ingestDocumentSchema) — NOT multipart.
    function fileToBase64(file){
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',').pop() || '');
        reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
        reader.readAsDataURL(file);
      });
    }

    async function uploadFiles(files){
      const list = [...(files || [])].filter(Boolean);
      if (!list.length || !api()?.ingestion?.upload) return;
      for (const file of list) {
        try {
          showToast((globalThis.PlatformLanguage?.text("documents","m_7bad5a46bb7de0","Uploading") ?? "Uploading"), ((v0) => globalThis.PlatformLanguage?.text("documents","m_f80ba48928c5d6",`Uploading ${v0}…`,{v0}) ?? `Uploading ${v0}…`)(file.name), true);
          await api().ingestion.upload(orgId(), {
            file_name: file.name,
            content_type: cleanText(file.type) || undefined,
            data_base64: await fileToBase64(file),
            project_id: projectId(),
            title: file.name
          });
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_eba695c553b0b3","Upload failed") ?? "Upload failed"), errorMessage(error, `Could not upload ${file.name}.`), false);
        }
      }
      await loadDocs({ silent: true });
    }

    // ------------------------------------------- paper upload review screen
    const UPLOAD_FIELD_TYPES = [
      ['string', 'Short text'], ['text', 'Long text'], ['number', 'Number'],
      ['currency', 'Money'], ['date', 'Date'], ['boolean', 'Yes / no'],
      ['email', 'Email'], ['phone', 'Phone']
    ];

    function uploadFieldInputHtml(key, def, value){
      const type = cleanText(def.type) || 'string';
      const id = `upf_${key}`;
      if (type === 'boolean') {
        return `<select class="fmdx-input" id="${String(esc(id))}" data-upload-field="${String(esc(key))}"><option value=""></option><option value="true" ${String(value === true ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("documents","m_549ccd0e27a3d4","Yes") ?? "Yes")}</option><option value="false" ${String(value === false ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("documents","m_2f0222913078f4","No") ?? "No")}</option></select>`;
      }
      if (type === 'text') {
        return `<textarea class="fmdx-input" id="${esc(id)}" data-upload-field="${esc(key)}" rows="3">${esc(cleanText(value))}</textarea>`;
      }
      const inputType = type === 'currency' || type === 'number' || type === 'percent' ? 'number'
        : type === 'date' ? 'date' : type === 'email' ? 'email' : type === 'phone' ? 'tel' : 'text';
      const display = type === 'currency'
        ? (Number(value) > 0 ? (Number(value) / 100).toFixed(2) : '')
        : (value === undefined || value === null ? '' : String(value));
      return `<input class="fmdx-input" id="${esc(id)}" type="${inputType}" ${type === 'currency' ? 'step="0.01" placeholder="0.00"' : ''} data-upload-field="${esc(key)}" value="${esc(display)}">`;
    }

    function uploadFieldValue(el, def){
      const type = cleanText(def.type) || 'string';
      const raw = cleanText(el.value);
      if (raw === '') return undefined;
      if (type === 'boolean') return raw === 'true';
      if (type === 'currency') return Math.round(Number(raw) * 100) || 0;
      if (type === 'number' || type === 'percent') return Number(raw);
      return raw;
    }

    /** Review + confirm screen for paper uploads: original file beside the
     *  agent-extracted fields, signature verdicts, and manual field editing. */
    async function openUploadReview(docRecord){
      let doc = objectValue(docRecord);
      try {
        const detail = await api().documents.get(orgId(), doc.id);
        doc = objectValue(detail.document || detail);
      } catch (error) { /* render with what we have */ }
      const modal = openModal(`<h2><i class="fas fa-file-import"></i> <span data-upload-title-label>${(globalThis.PlatformLanguage?.htmlText("documents","m_3baf296daabc9e","Review paper upload") ?? "Review paper upload")}</span></h2><div data-upload-body></div>`, { className: 'wide' });
      const body = modal.el.querySelector('[data-upload-body]');
      const ingestion = objectValue(doc.ingestion);
      const extraction = objectValue(ingestion.extraction);
      const local = {
        paramDefs: clone(objectValue(doc.param_defs)),
        outputDefs: clone(objectValue(doc.output_defs)),
        params: clone(objectValue(doc.params)),
        outputs: clone(objectValue(doc.outputs)),
        verdicts: {} // output key -> true (signed) / false (not signed)
      };
      Object.entries(local.outputDefs).forEach(([key, def]) => {
        if (cleanText(objectValue(def).type) !== 'signature') return;
        local.verdicts[key] = !!objectValue(local.outputs[key]).signer_name || !!objectValue(local.outputs[key]).text;
      });
      const mediaUrl = ingestion.media_id && window.PlatformAPI?.media?.fileUrl
        ? window.PlatformAPI.media.fileUrl(orgId(), ingestion.media_id)
        : '';
      const isImage = cleanText(ingestion.content_type).startsWith('image/');
      const reviewed = cleanText(doc.status) !== 'needs_review';

      function collectFields(){
        const params = {};
        body.querySelectorAll('[data-upload-field]').forEach((el) => {
          const key = el.dataset.uploadField;
          const def = objectValue(local.paramDefs[key]);
          const value = uploadFieldValue(el, def);
          if (value !== undefined) params[key] = value;
        });
        return params;
      }

      function outputsPayload(){
        const outputs = {};
        Object.entries(local.verdicts).forEach(([key, signed]) => {
          if (!signed) { outputs[key] = null; return; }
          const stored = objectValue(local.outputs[key]);
          const name = cleanText(body.querySelector(`[data-upload-signer="${key}"]`)?.value) || cleanText(stored.signer_name || stored.text);
          const date = cleanText(body.querySelector(`[data-upload-signdate="${key}"]`)?.value) || cleanText(stored.signed_at);
          outputs[key] = { type: 'wet_ink', signer_name: name, text: name, ...(date ? { signed_at: date } : {}) };
        });
        return outputs;
      }

      function renderReview(){
        const warnings = arrayValue(extraction.warnings).map(cleanText).filter(Boolean);
        const confidence = Number(ingestion.confidence || 0);
        const simpleDefs = Object.entries(local.paramDefs).filter(([, def]) => !['entity', 'list', 'object', 'media', 'measurements', 'payment_schedule', 'signature_request'].includes(cleanText(objectValue(def).type)));
        const signatureDefs = Object.entries(local.outputDefs).filter(([, def]) => cleanText(objectValue(def).type) === 'signature');
        body.innerHTML = `
          <div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap">
            <div style="flex:1 1 320px;min-width:280px">
              <p class="fmdx-section-label">${(globalThis.PlatformLanguage?.htmlText("documents","m_80c06f8c43b553","Original file") ?? "Original file")}</p>
              ${String(mediaUrl
                ? (isImage
                  ? `<a href="${esc(mediaUrl)}" target="_blank" rel="noopener"><img src="${esc(mediaUrl)}" alt="${(globalThis.PlatformLanguage?.htmlText("documents","m_813b8ed311685d","Uploaded document") ?? "Uploaded document")}" style="max-width:100%;border:1px solid var(--fmdx-border,#d0d5dd);border-radius:10px"></a>`
                  : `<iframe src="${esc(mediaUrl)}" title="${(globalThis.PlatformLanguage?.htmlText("documents","m_813b8ed311685d","Uploaded document") ?? "Uploaded document")}" style="width:100%;height:420px;border:1px solid var(--fmdx-border,#d0d5dd);border-radius:10px;background:#fff"></iframe>`)
                : `<div class="fmdx-state" style="min-height:120px"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_a455a7684d29a0","The original file preview is unavailable.") ?? "The original file preview is unavailable.")}</span></div>`)}
              ${String(mediaUrl ? `<a class="fmdx-btn" style="margin-top:8px" href="${esc(mediaUrl)}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_fec4097d4bf7d9"," Open original") ?? " Open original")}</a>` : '')}
              <p class="fmdx-section-label" style="margin-top:14px">${(globalThis.PlatformLanguage?.htmlText("documents","m_5e3ecdbdf50134","Extraction") ?? "Extraction")}</p>
              <small style="color:#667085;display:block;line-height:1.5">
                ${String(cleanText(extraction.method) === 'heuristic_filename' ? 'Automatic extraction was unavailable — fill the fields manually.' : `The agent read this document${confidence ? ` (confidence ${(confidence * 100).toFixed(0)}%)` : ''}. Review every field before confirming.`)}
                ${String(cleanText(extraction.notes) ? `<br>${esc(cleanText(extraction.notes))}` : '')}
              </small>
              ${String(warnings.length ? `<div class="fmdx-state" style="min-height:0;padding:10px 12px;margin-top:8px;text-align:left"><small style="color:#b54708">${warnings.map((w) => `<i class="fas fa-triangle-exclamation"></i> ${esc(w)}`).join('<br>')}</small></div>` : '')}
            </div>
            <div style="flex:1 1 360px;min-width:300px">
              <label class="fmdx-field"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_29dbd3d8b69f55","Title") ?? "Title")}</span><input class="fmdx-input" data-upload-title value="${String(esc(firstText(doc.title, 'Uploaded document')))}"></label>
              <p class="fmdx-section-label">${(globalThis.PlatformLanguage?.htmlText("documents","m_3fb0ccaf330e5c","Fields") ?? "Fields")}</p>
              ${String(simpleDefs.length ? simpleDefs.map(([key, def]) => `
                <label class="fmdx-field"><span>${esc(firstText(objectValue(def).label, key))}${objectValue(def).required === true ? ' *' : ''}</span>${uploadFieldInputHtml(key, objectValue(def), local.params[key])}</label>`).join('')
                : `<small style="color:#667085">${(globalThis.PlatformLanguage?.htmlText("documents","m_bca8cdb5e1c6ee","No fields yet — add the ones this contract should capture.") ?? "No fields yet — add the ones this contract should capture.")}</small>`)}
              <button type="button" class="fmdx-btn" data-upload-add-field style="margin-top:6px"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_d20af8e8ec43c2"," Add field") ?? " Add field")}</button>
              <p class="fmdx-section-label" style="margin-top:14px">${(globalThis.PlatformLanguage?.htmlText("documents","m_3f44e36c22a79e","Signatures") ?? "Signatures")}</p>
              ${String(signatureDefs.length ? signatureDefs.map(([key, defValue]) => {
                const def = objectValue(defValue);
                const stored = objectValue(local.outputs[key]);
                const signed = local.verdicts[key] === true;
                return `
                <div class="fmdx-state" style="min-height:0;padding:10px 12px;margin-bottom:8px;text-align:left" data-upload-signature="${esc(key)}">
                  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <strong style="flex:1">${esc(firstText(def.label, key))}${def.required === true ? ' *' : ''}</strong>
                    <label style="display:inline-flex;align-items:center;gap:6px"><input type="radio" name="upsig_${esc(key)}" value="signed" ${signed ? 'checked' : ''} data-upload-verdict="${esc(key)}">${(globalThis.PlatformLanguage?.htmlText("documents","m_190d905262b4b5"," Signed on paper") ?? " Signed on paper")}</label>
                    <label style="display:inline-flex;align-items:center;gap:6px"><input type="radio" name="upsig_${esc(key)}" value="unsigned" ${signed ? '' : 'checked'} data-upload-verdict="${esc(key)}">${(globalThis.PlatformLanguage?.htmlText("documents","m_538911e46eb471"," Not signed") ?? " Not signed")}</label>
                  </div>
                  <div style="display:${signed ? 'flex' : 'none'};gap:8px;margin-top:8px;flex-wrap:wrap" data-upload-signature-detail="${esc(key)}">
                    <input class="fmdx-input" style="flex:2;min-width:160px" placeholder="${(globalThis.PlatformLanguage?.htmlText("documents","m_460ba393b619a1","Signer name") ?? "Signer name")}" data-upload-signer="${esc(key)}" value="${esc(cleanText(stored.signer_name || stored.text))}">
                    <input class="fmdx-input" style="flex:1;min-width:130px" type="date" data-upload-signdate="${esc(key)}" value="${esc(cleanText(stored.signed_at).slice(0, 10))}">
                  </div>
                </div>`;
              }).join('') : `<small style="color:#667085">${(globalThis.PlatformLanguage?.htmlText("documents","m_76cc5b3407a65a","This document has no signature fields.") ?? "This document has no signature fields.")}</small>`)}
            </div>
          </div>
          <div class="fmdx-modal-foot" style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="fmdx-btn" data-upload-save><i class="fas fa-floppy-disk"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_f1adbc86bd9029"," Save fields") ?? " Save fields")}</button>
            <button type="button" class="fmdx-btn" data-upload-save-template><i class="fas fa-clone"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_c43329c1c5cfe4"," Save as upload template") ?? " Save as upload template")}</button>
            <span style="flex:1"></span>
            ${String(reviewed ? '' : `<p>${(globalThis.PlatformLanguage?.htmlText("documents","m_289c753b1afcdf","By confirming, you attest that you inspected the original upload and every signature you mark as present appears on that original. Imported signatures are recorded as your review, not as signatures collected online.") ?? "By confirming, you attest that you inspected the original upload and every signature you mark as present appears on that original. Imported signatures are recorded as your review, not as signatures collected online.")}</p><button type="button" class="fmdx-btn primary" data-upload-confirm><i class="fas fa-circle-check"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_a213af3a6be2cc"," Confirm &amp; apply") ?? " Confirm &amp; apply")}</button>`)}
          </div>`;

        body.querySelectorAll('[data-upload-verdict]').forEach((input) => input.addEventListener('change', () => {
          const key = input.dataset.uploadVerdict;
          local.verdicts[key] = input.value === 'signed' && input.checked ? true : (input.value === 'unsigned' && input.checked ? false : local.verdicts[key]);
          const detail = body.querySelector(`[data-upload-signature-detail="${key}"]`);
          if (detail) detail.style.display = local.verdicts[key] ? 'flex' : 'none';
        }));

        body.querySelector('[data-upload-add-field]')?.addEventListener('click', () => {
          const label = window.prompt((globalThis.PlatformLanguage?.text("documents","m_f586d38bd38fdc","Field label (e.g. \"Shingle color\")") ?? "Field label (e.g. \"Shingle color\")"));
          if (!cleanText(label)) return;
          const typeChoice = window.prompt(`Field type — one of: ${UPLOAD_FIELD_TYPES.map(([id]) => id).join(', ')}`, 'string');
          const type = UPLOAD_FIELD_TYPES.some(([id]) => id === cleanText(typeChoice)) ? cleanText(typeChoice) : 'string';
          const key = cleanText(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || `field_${Object.keys(local.paramDefs).length + 1}`;
          local.params = { ...local.params, ...collectFields() };
          local.paramDefs[key] = { type, label: cleanText(label) };
          renderReview();
        });

        body.querySelector('[data-upload-save]')?.addEventListener('click', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const res = await api().ingestion.updateFields(orgId(), doc.id, {
              title: cleanText(body.querySelector('[data-upload-title]')?.value),
              param_defs: local.paramDefs,
              output_defs: local.outputDefs,
              params: collectFields()
            });
            doc = objectValue(res.document || doc);
            local.params = clone(objectValue(doc.params));
            showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_942fb578458377","Fields saved.") ?? "Fields saved."), true);
            await loadDocs({ silent: true });
          } catch (error) {
            showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not save the fields.'), false);
          } finally {
            button.disabled = false;
          }
        });

        body.querySelector('[data-upload-save-template]')?.addEventListener('click', async (event) => {
          const name = window.prompt((globalThis.PlatformLanguage?.text("documents","m_c4b7cbfdc9b700","Template name") ?? "Template name"), `${firstText(doc.title, 'Contract')} — Paper Upload`);
          if (!cleanText(name)) return;
          const button = event.currentTarget;
          button.disabled = true;
          try {
            await api().ingestion.updateFields(orgId(), doc.id, { param_defs: local.paramDefs, output_defs: local.outputDefs, params: collectFields() });
            await api().ingestion.saveTemplateFromDocument(orgId(), doc.id, { name: cleanText(name) });
            showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), ((v0) => globalThis.PlatformLanguage?.text("documents","m_a8bc20de6951b7",`"${v0}" saved — future paper uploads can start from it.`,{v0}) ?? `"${v0}" saved — future paper uploads can start from it.`)(cleanText(name)), true);
          } catch (error) {
            showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not save the template.'), false);
          } finally {
            button.disabled = false;
          }
        });

        body.querySelector('[data-upload-confirm]')?.addEventListener('click', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Confirming…';
          try {
            const res = await api().ingestion.confirm(orgId(), doc.id, {
              title: cleanText(body.querySelector('[data-upload-title]')?.value),
              param_defs: local.paramDefs,
              output_defs: local.outputDefs,
              params: collectFields(),
              outputs: outputsPayload(),
              attest_original_signatures: true
            });
            const updated = objectValue(res.document);
            const status = cleanText(updated.status);
            showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), ['signed', 'completed'].includes(status) ? 'Confirmed — the signed contract is now on record.' : 'Confirmed — the upload is now a live document.', true);
            modal.close();
            await loadDocs({ silent: true });
          } catch (error) {
            showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not confirm this upload.'), false);
            button.disabled = false;
            button.innerHTML = '<i class="fas fa-circle-check"></i> Confirm &amp; apply';
          }
        });
      }
      renderReview();
    }

    /** Paper-upload create path: pick a file, ingest (optionally against an
     *  upload template), then open the review screen. */
    function startPaperUpload(templateId, documentTypeHint, onDone){
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*';
      picker.addEventListener('change', async () => {
        const file = picker.files && picker.files[0];
        if (!file) return;
        try {
          showToast((globalThis.PlatformLanguage?.text("documents","m_7bad5a46bb7de0","Uploading") ?? "Uploading"), ((v0) => globalThis.PlatformLanguage?.text("documents","m_2449cfb5bcb8a3",`Reading ${v0}…`,{v0}) ?? `Reading ${v0}…`)(file.name), true);
          const res = await api().ingestion.upload(orgId(), {
            file_name: file.name,
            content_type: cleanText(file.type) || undefined,
            data_base64: await fileToBase64(file),
            project_id: projectId(),
            ...(templateId ? { template_id: templateId } : {}),
            ...(documentTypeHint ? { document_type: documentTypeHint } : {})
          });
          await loadDocs({ silent: true });
          onDone?.();
          openUploadReview(objectValue(res.document));
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_eba695c553b0b3","Upload failed") ?? "Upload failed"), errorMessage(error, `Could not upload ${file.name}.`), false);
        }
      });
      picker.click();
    }

    // DELETE on an instance voids it server-side (lifecycle §10.3) — the
    // record survives, customers just can't open it any more.
    async function archiveDoc(doc){
      const prompt = `Void "${firstText(doc.title, 'this document')}"? Customers will no longer be able to open it.`;
      const confirmed = window.Portal?.ui?.confirm ? await window.Portal.ui.confirm(prompt) : window.confirm(prompt);
      if (!confirmed) return;
      try {
        await api().documents.archive(orgId(), doc.id);
        showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_6c96383ec2b19d","Document voided.") ?? "Document voided."), true);
        await loadDocs({ silent: true });
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not void the document.'), false);
      }
    }

    // ==================================================== workflow view (§8)
    // The stepper runtime (doc-workflow) renders the document's attached
    // workflow full-screen with a live preview. Persistence stays exactly the
    // Data-panel contract: params PATCH the instance, outputs go through
    // recordOutput, step state POSTs to /workflow/state — every call
    // defensive because the backend routes are being built in parallel.

    function setDeepValue(target, path, value){
      const parts = cleanText(path).split('.').filter(Boolean);
      if (!parts.length) return;
      let cursor = target;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (cursor[parts[i]] === null || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
        cursor = cursor[parts[i]];
      }
      cursor[parts[parts.length - 1]] = value;
    }

    /** Accepts every plausible response shape and returns { definition, state }
     *  when a definition with steps is present — otherwise null. */
    function normalizeWorkflowRecord(res){
      const source = objectValue(res);
      let definition = null;
      for (const candidate of [source.workflow, source.definition, source]) {
        const value = objectValue(candidate);
        if (arrayValue(value.steps).length) { definition = value; break; }
        if (arrayValue(objectValue(value.definition).steps).length) { definition = objectValue(value.definition); break; }
      }
      if (!definition) return null;
      const stepState = objectValue(source.state || source.workflow_state || objectValue(source.workflow).state);
      return { definition, state: stepState };
    }

    /** The workflow attached to the open instance — clean null when the route
     *  is missing (backend built in parallel) or nothing is attached. */
    async function loadDocWorkflow(){
      state.docWorkflow = null;
      updateModeToggle();
      if (!state.doc?.id || typeof api()?.documents?.workflow !== 'function') return null;
      try {
        state.docWorkflow = normalizeWorkflowRecord(await api().documents.workflow(orgId(), state.doc.id));
      } catch (error) {
        state.docWorkflow = null; // 404/501 → no workflow, keep the old flow
      }
      if (!state.destroyed) updateModeToggle();
      return state.docWorkflow;
    }

    /** [Workflow | Editor] segmented control in the unified top bar. The
     *  workflow segment (and therefore the whole toggle) is hidden when the
     *  instance has no attached workflow or is locked read-only. */
    function updateModeToggle(){
      const toggle = root.querySelector('[data-fmdx-mode-toggle]');
      if (!toggle) return;
      // A document with steps opens on them; this is the way back after "Edit manually".
      toggle.hidden = !state.docWorkflow || isReadOnlyStatus(state.doc?.status) || state.docView !== 'editor';
    }

    // Debounced write-through: params.* accumulate into one PATCH, outputs.*
    // go through recordOutput (falling back to a PATCH on older backends).
    function setWorkflowSaveState(mode){
      // The unified top bar has ONE save-state element shared by both views.
      const el = root.querySelector('[data-fmdx-save-state]');
      if (!el) return;
      const map = {
        idle: ['', ''],
        dirty: ['dirty', 'Unsaved changes'],
        saving: ['saving', 'Saving…'],
        saved: ['saved', 'Saved'],
        error: ['error', 'Save failed — retrying']
      };
      const [cls, text] = map[mode] || map.idle;
      el.className = `fmdx-save-state ${cls}`;
      el.innerHTML = text ? `<i class="fas ${mode === 'saving' ? 'fa-circle-notch fa-spin' : (mode === 'saved' ? 'fa-check' : 'fa-circle')}"></i> ${esc(text)}` : '';
    }

    function queueWorkflowWrite(path, value){
      const target = cleanText(path);
      if (!target) return;
      if (target.startsWith('outputs.') && value?.__signing) return flushWorkflowWrites().then(async () => {
        const res = await api().documents.recordOutput(orgId(), state.doc.id, target.slice(8), { value });
        if (res.document) state.doc = res.document;
        return true;
      });
      state.workflowTouched = true; // editor view must re-resolve on switch
      if (target.startsWith('outputs.')) state.workflowWrites.outputs[target.slice('outputs.'.length)] = clone(value);
      else state.workflowWrites.params[target.replace(/^params\./, '')] = clone(value);
      clearTimeout(state.workflowFlushTimer);
      state.workflowFlushTimer = setTimeout(() => { flushWorkflowWrites(); }, 900);
      setWorkflowSaveState('dirty');
    }

    async function flushWorkflowWrites(){
      clearTimeout(state.workflowFlushTimer);
      state.workflowFlushTimer = 0;
      if (state.workflowFlushing) { try { await state.workflowFlushing; } catch (e) {} }
      const paramEntries = Object.entries(state.workflowWrites.params);
      const outputEntries = Object.entries(state.workflowWrites.outputs);
      if ((!paramEntries.length && !outputEntries.length) || !state.doc?.id) return;
      state.workflowWrites = { params: {}, outputs: {} };
      const run = (async () => {
        setWorkflowSaveState('saving');
        let failed = false;
        if (paramEntries.length) {
          try {
            const merged = clone(objectValue(state.doc.params));
            paramEntries.forEach(([key, value]) => setDeepValue(merged, key, value));
            const res = await api().documents.patch(orgId(), state.doc.id, { params: merged });
            const updated = objectValue(res.document || res.doc);
            state.doc = updated.id ? { ...state.doc, ...updated } : { ...state.doc, params: merged };
          } catch (error) {
            failed = true;
            paramEntries.forEach(([key, value]) => {
              if (!(key in state.workflowWrites.params)) state.workflowWrites.params[key] = value;
            });
          }
        }
        for (const [key, value] of outputEntries) {
          try {
            await api().documents.recordOutput(orgId(), state.doc.id, key, { value, source: 'workflow' });
            state.doc = { ...state.doc, outputs: { ...objectValue(state.doc.outputs), [key]: value } };
          } catch (error) {
            try {
              const res = await api().documents.patch(orgId(), state.doc.id, { outputs: { ...objectValue(state.doc.outputs), [key]: value } });
              const updated = objectValue(res.document || res.doc);
              state.doc = updated.id ? { ...state.doc, ...updated } : { ...state.doc, outputs: { ...objectValue(state.doc.outputs), [key]: value } };
            } catch (patchError) {
              failed = true;
              if (!(key in state.workflowWrites.outputs)) state.workflowWrites.outputs[key] = value;
            }
          }
        }
        if (failed) {
          setWorkflowSaveState('error');
          clearTimeout(state.workflowFlushTimer);
          state.workflowFlushTimer = setTimeout(() => { flushWorkflowWrites(); }, 4000);
        } else {
          setWorkflowSaveState('saved');
          renderDocCard(); // variant labels/slots may have changed
        }
      })();
      state.workflowFlushing = run;
      try { await run; } finally { state.workflowFlushing = null; }
    }

    function persistWorkflowStepState(stepState){
      if (state.docWorkflow) state.docWorkflow.state = { ...objectValue(state.docWorkflow.state), ...objectValue(stepState) };
      if (!state.doc?.id || typeof api()?.documents?.workflowState !== 'function') return;
      api().documents.workflowState(orgId(), state.doc.id, objectValue(stepState))
        .then((res) => {
          // Completing a step may generate documents server-side
          // (generate_document items) — pull the fresh outputs back into the
          // stepper so their cards flip from "will generate" to a live link.
          const updated = objectValue(res?.document);
          if (!updated.id) return;
          const before = JSON.stringify(objectValue(state.doc?.outputs));
          state.doc = { ...state.doc, ...updated };
          const after = JSON.stringify(objectValue(updated.outputs));
          if (before !== after) {
            try { state.workflowHandle?.refresh?.({ outputs: clone(objectValue(updated.outputs)) }); } catch (e) {}
            loadDocs({ silent: true });
          }
        })
        .catch(() => { /* route may not exist yet — local state still advances */ });
    }

    // Piece vocabulary: the org's scope templates via PlatformAPI.scopes.list
    // — the SAME source the legacy proposal builder maps into its
    // "What are we doing?" cards (loadProposalScopeTemplates). Fallback: the
    // legacy module's built-in defaults.
    async function loadPieceCatalog(){
      if (Array.isArray(state.pieceCatalog) && state.pieceCatalog.length) return state.pieceCatalog;
      const branchId = firstText(
        window.Portal?.branchModules?.currentBranchId?.(),
        window.__APP?.userBranchId,
        project()?.branch_id,
        'default'
      );
      try {
        if (window.PlatformAPI?.scopes?.list) {
          const res = await window.PlatformAPI.scopes.list(orgId(), branchId, {});
          const templates = arrayValue(res?.templates).map((record) => {
            const rec = objectValue(record);
            const definition = objectValue(rec.definition && typeof rec.definition === 'object' ? rec.definition : rec);
            return {
              id: firstText(rec.id, definition.id),
              name: firstText(rec.name, definition.name, 'Project Piece'),
              description: firstText(rec.description, definition.description),
              icon: firstText(rec.icon, definition.icon, 'fa-diagram-project'),
              color: firstText(rec.color, definition.color),
              // The kinds of work it is measured as (a structure added by hand asks for these).
              measurement_schema_ids: arrayValue(definition.measurement_schema_ids || rec.measurement_schema_ids).map(cleanText).filter(Boolean),
              enabled: rec.enabled !== false
            };
          }).filter((template) => template.id && template.enabled);
          if (templates.length) {
            state.pieceCatalog = templates;
            return templates;
          }
        }
      } catch (error) {
        console.warn('Scope templates unavailable — using the built-in piece list', error);
      }
      state.pieceCatalog = FALLBACK_PIECE_CATALOG.map((piece) => ({ ...piece }));
      return state.pieceCatalog;
    }

    function workflowServices(){
      const pricebook = pricebookModule();
      return {
        api: { signing: { organizationId: orgId(), documentId: state.doc?.id } },
        // Native step-1 vocabulary (piece_select cards).
        pieceCatalog: () => loadPieceCatalog(),
        // The project's selected measurement dataset (FirstMeasure report or
        // an import), flattened to { key: number } for the measurements item.
        projectMeasurements: async () => {
          const projectId = firstText(state.doc?.project_id, project()?.id);
          if (!projectId) return { values: {}, source: '' };
          const numbers = (source) => {
            const values = {};
            Object.entries(objectValue(source)).forEach(([key, value]) => { if (typeof value === 'number' && Number.isFinite(value)) values[key] = value; });
            return values;
          };
          const loader = window.FirstMeasureAPI?.roofMeasurements;
          if (!loader?.load) {
            const result = objectValue(await window.PlatformAPI.publication.measurements(orgId(), projectId));
            const values = {};
            Object.entries(objectValue(objectValue(result.value).measurements)).forEach(([key, entry]) => {
              const value = Number(objectValue(entry).value);
              if (Number.isFinite(value)) values[key] = value;
            });
            return { values, source: 'the measurements on this project', ...datasetStructureFields(result) };
          }
          // The shared loader reads the project's measurement dataset and, for
          // a report that was never published as one, the report itself.
          const subject = { ...objectValue(project()), id: projectId, organization_id: orgId() };
          // The host knows which report the project is linked to even when
          // the project record itself does not carry the link yet.
          const options = { force: true, reportOrderState: objectValue(context.host?.getReportOrderState?.()) };
          let loaded = objectValue(await loader.load(subject, options));
          const measured = (result) => Object.values(numbers(result.measurements)).some((value) => value > 0);
          if (loaded.legacyFallback && measured(loaded) && typeof loader.import === 'function') {
            // Publish the completed report as the project's dataset, which is
            // what materials generation reads after signing. Someone without
            // permission to do that still gets the report's values below.
            try {
              await loader.import(subject);
              loaded = objectValue(await loader.load(subject, options));
            } catch (error) {
              console.warn('Could not publish the report as the project measurement dataset', error);
            }
          }
          if (!measured(loaded)) return { values: {}, source: '' };
          const values = numbers(loaded.measurements);
          // A report read directly has no waste figure; leave the field to its default.
          if (!(values.wastePercent > 0)) delete values.wastePercent;
          return { values, source: 'the measurement report on this project', ...(loaded.origin === 'project_measurement_dataset' ? datasetStructureFields(loaded.source) : {}) };
        },
        // What a structure entered by hand asks for: the measurement schemas
        // the selected scope templates name, read from the shared dictionary.
        // None named: the runtime falls back to the step's own fields.
        structureMeasurementFields: async ({ selection, keys, measurements } = {}) => {
          const helpers = window.FMDocWorkflow?.structures;
          if (!helpers?.fieldsFromSchemas || !window.PlatformAPI?.publication?.read) return [];
          const templateIds = arrayValue(selection).map(objectValue).map((piece) => firstText(piece.template_id, piece.id)).filter(Boolean);
          const catalog = arrayValue(await loadPieceCatalog());
          const schemaIds = [...new Set(catalog.filter((template) => templateIds.includes(template.id)).flatMap((template) => arrayValue(template.measurement_schema_ids)))];
          if (!schemaIds.length) return [];
          if (!state.measurementVocabulary) {
            const target = { scope: 'organization', organizationId: orgId() };
            const read = async (name) => {
              const result = await window.PlatformAPI.publication.read(orgId(), { provider: 'measurement-schemas', export: name, target });
              return arrayValue(objectValue(objectValue(result).result || result).value);
            };
            const [dictionary, catalogValue, partitions] = await Promise.all([read('dictionary'), read('catalog'), read('partitions')]);
            state.measurementVocabulary = { dictionary, catalog: catalogValue, partitions };
          }
          return helpers.fieldsFromSchemas(state.measurementVocabulary, schemaIds, keys, measurements);
        },
        // Native line-items generation (line_items_review + measurement-key
        // derivation): the legacy module's exported generation, pricebook
        // hydrated first so formulas resolve (see generateScopeItemsForSelection).
        // Price book items that fit one choice group (line_items_review's
        // "Add option" search), priced from the same measurements.
        openFullPreview: async () => { await flushAllWrites(); openPreview(state.doc); },
        // What the Review & send step offers: only what this workflow declares.
        deliverables: async () => {
          const options = state.presentOptions || await presentationOptions(state.doc?.id);
          // Sending is the step's own Send button; these sit to its left. The
          // presentation's own editor and its emailed link are under More.
          return [
            { id: 'edit_manually', label: 'Edit manually', icon: 'fa-pen-ruler', quiet: true, title: 'Open the finished document in the editor to change it by hand', run: () => openAsSentEditor() },
            canPresent(options) ? { id: 'present', label: 'Present', icon: 'fa-chalkboard-user', title: 'Present this estimate to the customer', run: () => openPresentation() } : null
          ].filter(Boolean);
        },
        scopeCandidates: async (templateId, group, measurements) => arrayValue((await window.PlatformAPI.publication.invoke(orgId(), 'pricebook.scope.candidates', { scope: 'organization', organizationId: orgId() }, { templateId, group, measurements: objectValue(measurements) })).value),
        // Pieces the server can price (pricebook.scope.generate) are built
        // there from the organization price book; the rest still use the
        // legacy module's exported generation, pricebook hydrated first.
        generateScopeItems: async (selection, measurements) => {
          const pieces = arrayValue(selection).map(objectValue).filter((piece) => firstText(piece.template_id, piece.id));
          let legacyReady = false;
          const roots = [];
          for (const [index, piece] of pieces.entries()) {
            const templateId = firstText(piece.template_id, piece.id);
            let generated = null;
            try {
              const result = await window.PlatformAPI.publication.invoke(orgId(), 'pricebook.scope.generate', { scope: 'organization', organizationId: orgId() }, { templateId, measurements: objectValue(measurements), ...(firstText(piece.variant) ? { variant: firstText(piece.variant) } : {}) });
              generated = applyScopePieceMetadata(objectValue(result.value), piece, index);
            } catch (error) {
              if (cleanText(error?.code || error?.data?.error) !== 'scope_generation_unsupported') console.warn('Server scope generation failed — using the legacy generator', error);
            }
            if (!generated) {
              if (!legacyReady) { try { await Promise.resolve(pricebookModule()?.loadState?.()); } catch (e) { /* formulas fall back */ } legacyReady = true; }
              generated = generateScopeItemsForSelection([piece], measurements)[0] || null;
            }
            if (generated) roots.push(generated);
          }
          return roots;
        },
        pricebook: {
          pick: () => new Promise((resolve) => openPricebookPicker({ onDone: (items) => resolve(items) })),
          getState: () => { try { return pricebook?.getState?.(); } catch (e) { return null; } },
          category: (name) => {
            try {
              return arrayValue(objectValue(pricebook?.getState?.()).items)
                .filter((item) => cleanText(objectValue(item).category) === cleanText(name));
            } catch (e) { return []; }
          }
        },
        media: {
          photos: () => projectPhotoRefs(project()).map((photo) => ({
            ...photo,
            url: window.PlatformAPI?.media?.thumbnailUrl?.(orgId(), photo.media_id, 320) || ''
          })),
          url: (mediaId) => window.PlatformAPI?.media?.thumbnailUrl?.(orgId(), mediaId, 320) || '',
          // The picture itself, for the live preview of the document.
          fileUrl: (mediaId, variant) => window.PlatformAPI?.media?.fileUrl?.(orgId(), mediaId, variant || 'original') || '',
          // The shared media library (Portal.PhotoFeed picker), the same one
          // the document editor opens.
          pick: () => mediaBridge().pick(),
          ...(window.FirstMateWidgets?.mount && window.Portal?.PhotoFeed?.mountProjectMediaPicker ? { mount: (host, options) => mediaBridge().mount(host, options) } : {})
        },
        // generate_document cards: open the minted document in this screen.
        openDocument: async (documentId) => {
          try {
            const res = await api().documents.get(orgId(), documentId);
            const record = objectValue(res.document || res.doc || res);
            if (record.id) openDocScreen(record);
          } catch (error) {
            showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not open the generated document.'), false);
          }
        }
      };
    }

    function destroyWorkflowView(){
      clearTimeout(state.workflowFlushTimer);
      state.workflowFlushTimer = 0;
      try { state.workflowHandle?.destroy?.(); } catch (e) {}
      state.workflowHandle = null;
      destroyWfRunAgent();
    }

    // ── Copilot beside the running workflow (internal audience only) ──
    function destroyWfRunAgent(){
      try { state.wfRunAgent?.destroy?.(); } catch (e) {}
      state.wfRunAgent = null;
    }

    function setWfRunAgentOpen(open){
      state.wfAgentOpen = !!open;
      const aside = root.querySelector('[data-fmdx-wfrun-agent]');
      root.querySelector('[data-fmdx-agent-btn]')?.classList.toggle('active', state.wfAgentOpen && state.docView === 'workflow');
      if (!aside) return;
      aside.classList.toggle('collapsed', !state.wfAgentOpen);
      if (state.wfAgentOpen && !state.wfRunAgent) mountWfRunAgent(aside);
    }

    /** The copilot needs the working DocModel; workflow-first entry never
     *  loads it, so warm the same resolve + template path lazily. */
    async function ensureAgentWorkingDefinition(){
      if (state.workingDoc || objectValue(state.working).definition) return;
      try {
        if (!Object.keys(objectValue(state.resolved)).length) {
          const resolvedRes = await api().documents.resolve(orgId(), state.doc.id);
          state.resolved = objectValue(resolvedRes);
        }
        state.working = await instanceWorkingDefinition();
      } catch (error) {
        console.warn('Could not load the working definition for the copilot', error);
      }
    }

    async function mountWfRunAgent(host){
      destroyWfRunAgent();
      if (!window.FMDocAgentPanel?.create) {
        host.innerHTML = `<div class="fmdx-state" style="margin:14px"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_b81cd219469c9b","The document copilot library is not loaded.") ?? "The document copilot library is not loaded.")}</span></div>`;
        return;
      }
      await ensureAgentWorkingDefinition();
      if (state.destroyed || !host.isConnected) return;
      state.wfRunAgent = window.FMDocAgentPanel.create(host, {
        orgId: orgId(),
        subjectId: firstText(state.doc?.id),
        title: (globalThis.PlatformLanguage?.text("documents","m_ec99d1d510fb3c","Document copilot") ?? "Document copilot"),
        placeholder: (globalThis.PlatformLanguage?.text("documents","m_a6794f2378bc40","Describe the change…") ?? "Describe the change…"),
        welcome: 'I can edit this document while you walk through the workflow — wording, layout, sections — and the live preview updates as I go.',
        suggestions: [
          'Rewrite the intro paragraph to be warmer',
          'Add a page with our workmanship warranty',
          'Make the totals section more prominent'
        ],
        getInput: () => ({
          mode: 'document',
          subject: {
            id: firstText(state.doc?.id),
            name: firstText(state.doc?.title),
            status: cleanText(state.doc?.status) || 'draft',
            document_type: cleanText(state.doc?.document_type) || 'generic'
          },
          definition: objectValue(state.workingDoc || state.editorHandle?.getDocument?.() || objectValue(state.working).definition)
        }),
        onAction: (action) => {
          if (cleanText(objectValue(action).type) !== 'document.set_definition') return;
          if (isReadOnlyStatus(state.doc?.status)) return;
          const docModel = clone(objectValue(objectValue(action).document));
          if (!arrayValue(docModel.pages).length && !docModel.root) return;
          applyAgentDocument(docModel);
          // The stepper's live preview resolves server-side — wait for the
          // override autosave so the agent's edit is actually in the resolve.
          flushAutosave().then(() => {
            try { state.workflowHandle?.refreshPreview?.(); } catch (e) {}
          }).catch(() => {});
        }
      });
    }

    /** Mounts the stepper runtime into the unified screen's workflow host.
     *  Anything missing (runtime, record, host) falls back to editor view. */
    async function mountWorkflowHost(){
      const doc = objectValue(state.doc);
      const record = state.docWorkflow;
      const runtime = await ensureWorkflowRuntime();
      if (state.destroyed || state.view !== 'editor') return;
      const host = root.querySelector('[data-fmdx-wfrun-main]') || root.querySelector('[data-fmdx-workflow-host]');
      if (!runtime || !record || !host || !doc.id) {
        state.docView = 'editor';
        updateModeToggle();
        syncDocViewVisibility();
        if (!state.editorLoaded) loadEditorView();
        return;
      }
      destroyWorkflowView();
      state.workflowWrites = { params: {}, outputs: {} };
      try {
        state.workflowHandle = runtime.mount(host, {
          workflow: record.definition,
          audience: 'internal',
          contract: objectValue(record.definition.contract),
          state: {
            params: clone(objectValue(state.doc.params)),
            outputs: clone(objectValue(state.doc.outputs)),
            current_step: firstText(objectValue(record.state).current_step),
            completed_steps: arrayValue(objectValue(record.state).completed_steps)
          },
          scope: { project: project() },
          onWrite: (path, value) => queueWorkflowWrite(path, value),
          onStepState: (stepState) => { persistWorkflowStepState(stepState); syncDeliverableButtons(objectValue(stepState).ready); },
          labels: { finish: 'Send' },
          // Finishing the workflow means the document is ready to go out —
          // open the Send flow directly (the editor stays one toggle away).
          onComplete: async () => {
            try { await flushAllWrites(); } catch (e) {}
            openSendModal(state.doc);
          },
          preview: {
            resolve: async () => {
              await flushWorkflowWrites();
              const payload = await api().documents.resolve(orgId(), state.doc.id);
              // Rail doc card rides the same resolve: live total for free.
              if (captureResolvedTotal(payload)) updateDocCardTotal();
              return payload;
            }
          },
          services: workflowServices()
        });
        if (state.wfAgentOpen) setWfRunAgentOpen(true);
      } catch (error) {
        console.warn('Workflow runtime mount failed — falling back to the editor', error);
        destroyWorkflowView();
        state.docView = 'editor';
        updateModeToggle();
        syncDocViewVisibility();
        if (!state.editorLoaded) loadEditorView();
      }
    }

    /** Switch the unified screen between the Workflow stepper and the Editor
     *  canvas WITHOUT recreating the inactive surface: both hosts stay in the
     *  DOM; pending writes flush on every switch; the editor re-resolves only
     *  when the workflow actually wrote data since it last resolved. */
    async function setDocView(view){
      const next = view === 'workflow' ? 'workflow' : 'editor';
      if (state.view !== 'editor' || state.docView === next) return;
      if (next === 'workflow' && !state.docWorkflow) return;
      state.docView = next;
      updateModeToggle();
      syncDocViewVisibility();
      if (next === 'editor') {
        await flushWorkflowWrites();
        if (!state.editorLoaded) {
          await loadEditorView();
        } else if (state.workflowTouched) {
          state.workflowTouched = false;
          await refreshResolvedEditor();
          renderDataPanel();
        } else {
          setTimeout(() => { try { state.editorHandle?.zoom?.('fit-width'); } catch (e) {} }, 60);
        }
      } else {
        await flushAutosave();
        destroyEditor();
        state.editorLoaded = false;
        state.editorLoading = false;
        if (!state.workflowHandle) {
          await mountWorkflowHost();
        } else {
          // Editor-side data saves live on state.doc — hand the stepper the
          // fresh values without restarting it (step position preserved).
          try {
            state.workflowHandle.refresh({
              params: clone(objectValue(state.doc?.params)),
              outputs: clone(objectValue(state.doc?.outputs))
            });
          } catch (e) { /* the stepper keeps its local copy */ }
        }
      }
    }

    /** Flush BOTH write paths (editor override autosave + workflow param/
     *  output queue) — used before Preview/PDF/Send/Theme so those actions
     *  always operate on the latest data regardless of the active view. */
    async function flushAllWrites(){
      try { await flushAutosave(); } catch (e) { /* retried by autosave */ }
      try { await flushWorkflowWrites(); } catch (e) { /* retried by queue */ }
    }

    /**
     * The document screen before there is a document: its top bar and an
     * opening state, shown the instant a template is picked. openDocScreen
     * replaces it; cancel() goes back to the list.
     */
    function showOpeningScreen(title){
      state.openingDoc = true;
      setEditorFocus(true);
      root.innerHTML = `
        <div class="fmdx-shell">
          <div class="fmdx-editor-screen workflow-view" data-fmdx-opening>
            <header class="fmdx-editor-top">
              <button type="button" class="fmdx-icon-btn" disabled><i class="fas fa-arrow-left"></i></button>
              <strong class="fmdx-doc-title-input" style="border-color:transparent">${esc(firstText(title, 'New document'))}</strong>
              ${statusChip('draft')}
            </header>
            <div class="fmdx-state" style="margin:64px auto"><div class="fmdx-spinner"></div><strong>Opening\u2026</strong></div>
          </div>
        </div>`;
      if (embedded) embed.onDocScreen?.();
      return { cancel(){ const shown = state.openingDoc && !!root.querySelector('[data-fmdx-opening]'); state.openingDoc = false; if (!shown) return; setEditorFocus(false); render(); } };
    }

    /** Entry: open the unified document screen (one top bar for both views). */
    function openWorkflowView(docRecord, workflowRecord){
      return openDocScreen(docRecord, { view: 'workflow', workflow: workflowRecord || state.docWorkflow });
    }

    // ========================================================== create flow
    // `prefill` supports the amend flow: { document_type, title, params }.
    // options.inlineHost renders the wizard INTO that element (doc-first
    // flows fill the modal's right panel) instead of a floating modal.
    async function openCreateModal(prefill = {}, options = {}){
      if (!api()) { showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_85a81051cef7b8","The documents service is not available.") ?? "The documents service is not available."), false); return; }
      const contentHtml = `<h2><i class="fas fa-file-medical"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_7754e23bbfc088"," New document") ?? " New document")}</h2><div data-create-body><div class="fmdx-state" style="min-height:140px"><div class="fmdx-spinner"></div></div></div>`;
      let modal;
      if (options.inlineHost) {
        ensureInlineStyles();
        const host = options.inlineHost;
        host.innerHTML = `<div class="fmdx-inline-wrap"><div class="fmdx-modal fmdx-create-modal">${contentHtml}</div></div>`;
        const el = host.querySelector('.fmdx-modal');
        modal = {
          el,
          body: el,
          close(){
            host.innerHTML = '';
            options.onClose?.();
          }
        };
      } else {
        modal = openModal(contentHtml, { onClose: options.onClose, className: 'fmdx-create-modal' });
      }
      const body = modal.el.querySelector('[data-create-body]');
      const [catalog, templates, pinSettings, typeSettings] = await Promise.all([loadCatalog(), loadTemplates(true), api().documents.settings(orgId(), 'default').catch(() => ({})), api().documents.types(orgId()).catch(() => ({}))]);
      if (!modal.el.isConnected) return;
      const wizard = { type: cleanText(prefill.document_type).toLowerCase(), template: null, departmentId: state.departmentId };

      function typesList(){
        const types = arrayValue(catalog.types);
        if (types.length) return types;
        return Object.keys(TYPE_META).filter((k) => k !== 'receipt').map((id) => ({ id, label: typeMeta(id).label, icon: TYPE_META[id].icon }));
      }

      // One screen: search, the organization's pinned templates, then the
      // whole library filtered by type (and department). Picking a template
      // starts the document; Blank and Upload are their own buttons.
      const savedPins = objectValue(objectValue(pinSettings).settings).pinned_template_ids;
      const picker = { query: '', type: '', departments: null, pins: Array.isArray(savedPins) ? savedPins.map(cleanText) : null };
      const PIN_LIMIT = 12;
      // System templates (payment receipts, payroll reports) are produced by
      // other apps and are never started by hand.
      const activeTemplates = () => arrayValue(templates).filter((t) => cleanText(t.status).toLowerCase() !== 'archived' && objectValue(t.metadata).system !== true);
      // Document types are the organization's own groupings. Each has a kind:
      // the built-in behavior a blank document of that type gets.
      const org = { types: arrayValue(objectValue(typeSettings).types).map(objectValue), assignments: objectValue(objectValue(typeSettings).assignments), kinds: arrayValue(objectValue(typeSettings).kinds).map(objectValue) };
      if (!org.types.length) org.types = typesList().map((type) => ({ id: firstText(type.id, type.type), label: firstText(type.label, typeMeta(firstText(type.id, type.type)).label), kind: firstText(type.id, type.type), color: '', icon: '', department_ids: [], archived: false }));
      const liveTypes = () => org.types.filter((type) => type.archived !== true);
      const TYPE_COLORS = ['#2563eb', '#0d9488', '#7c3aed', '#ea580c', '#db2777', '#0891b2', '#65a30d', '#b45309', '#4f46e5', '#be123c', '#059669', '#9333ea'];
      /** The type's own color, else one of a spread of distinct hues by its place in the list (never two alike until they run out). */
      function typeColor(type){
        if (cleanText(type.color)) return type.color;
        const taken = new Set(org.types.map((entry) => cleanText(entry.color).toLowerCase()).filter(Boolean));
        const free = TYPE_COLORS.filter((color) => !taken.has(color));
        const unset = org.types.filter((entry) => !cleanText(entry.color));
        return (free.length ? free : TYPE_COLORS)[Math.max(0, unset.indexOf(type)) % (free.length || TYPE_COLORS.length)];
      }
      const typeView = (type) => { const base = typeMeta(type.kind, catalog.types); return { id: type.id, label: firstText(type.label, base.label), color: typeColor(type), icon: firstText(type.icon, base.icon), kind: firstText(type.kind, 'generic') }; };
      /** The type a template is filed under: where it was moved, else the first type of its kind. */
      function typeOf(tpl){
        const moved = liveTypes().find((type) => type.id === cleanText(org.assignments[cleanText(tpl.id)]));
        return moved || liveTypes().find((type) => cleanText(type.kind) === cleanText(tpl.document_type)) || null;
      }
      const OTHER = { id: '__other__', label: 'Other', color: '#667085', icon: 'fa-file', kind: 'generic' };
      const viewOf = (tpl) => { const type = typeOf(tpl); return type ? typeView(type) : OTHER; };
      const isUploadTemplate = (tpl) => cleanText(objectValue(tpl.metadata).intake) === 'upload';
      const departments = () => (state.departmentContext.enabled ? arrayValue(state.departmentContext.departments).map(objectValue) : []);
      /** The user's own departments to start with; everything when they have none or see them all. */
      function selectedDepartments(){
        if (picker.departments) return picker.departments;
        const own = arrayValue(state.departmentContext.member_department_ids).filter((id) => departments().some((entry) => entry.id === id));
        picker.departments = new Set(own.length ? own : departments().map((entry) => entry.id));
        return picker.departments;
      }
      function inDepartments(tpl){
        const all = departments();
        if (!all.length) return true;
        const chosen = selectedDepartments();
        if (chosen.size === all.length) return true;
        // A type belongs to departments; a template may narrow that further.
        const allows = (ids) => !arrayValue(ids).length || arrayValue(ids).some((id) => chosen.has(id));
        return allows(objectValue(typeOf(tpl)).department_ids) && allows(tpl.department_ids);
      }
      /** Until the organization pins its own, the everyday documents: one each of the common types. */
      function defaultPins(){
        const list = activeTemplates().filter((tpl) => !isUploadTemplate(tpl));
        const named = arrayValue(objectValue(objectValue(pinSettings).settings).default_pinned_template_ids).map(cleanText).filter((id) => list.some((tpl) => cleanText(tpl.id) === id));
        if (named.length) return named;
        return ['proposal', 'contract', 'change_order', 'invoice', 'work_order']
          .map((type) => list.filter((tpl) => cleanText(tpl.document_type) === type))
          .map((group) => group.find((tpl) => objectValue(tpl.metadata).default === true) || group[0])
          .filter(Boolean).map((tpl) => cleanText(tpl.id));
      }
      const pins = () => (picker.pins || defaultPins()).filter((id) => activeTemplates().some((tpl) => cleanText(tpl.id) === id));
      async function togglePin(id){
        const next = pins().includes(id) ? pins().filter((entry) => entry !== id) : [...pins(), id].slice(0, PIN_LIMIT);
        picker.pins = next;
        renderStepOne();
        try { await api().documents.pinTemplates(orgId(), next); }
        catch (error) { showToast('Documents', errorMessage(error, 'The pinned templates could not be saved.'), false); }
      }
      function tileHtml(tpl, pinned){
        const meta = viewOf(tpl);
        const upload = isUploadTemplate(tpl);
        const id = cleanText(tpl.id);
        const isPinned = pins().includes(id);
        return `
          <div class="fmdx-tpl ${pinned ? 'pinned' : ''}" style="--fmdx-type:${esc(meta.color)}" title="${esc(firstText(tpl.description, tpl.name))}">
            <button type="button" class="fmdx-tpl-open" data-pick-template="${esc(id)}">
              <span class="fmdx-tpl-icon"><i class="fas ${esc(upload ? 'fa-file-arrow-up' : meta.icon)}"></i></span>
              <span class="fmdx-tpl-text"><strong>${esc(firstText(tpl.name, 'Template'))}</strong><small>${esc(meta.label)}</small></span>
            </button>
            <button type="button" class="fmdx-tpl-pin ${isPinned ? 'on' : ''}" data-pin-template="${esc(id)}" title="${isPinned ? 'Unpin for everyone' : 'Pin for everyone'}" aria-pressed="${isPinned}"><i class="fas fa-thumbtack"></i></button>
          </div>`;
      }

      function renderStepOne(){
        const types = [...liveTypes().map(typeView), OTHER];
        const query = picker.query.trim().toLowerCase();
        const matches = (tpl) => !query || [tpl.name, tpl.description, viewOf(tpl).label].some((value) => cleanText(value).toLowerCase().includes(query));
        const visible = activeTemplates().filter(inDepartments).filter(matches);
        const counts = new Map();
        visible.forEach((tpl) => counts.set(viewOf(tpl).id, (counts.get(viewOf(tpl).id) || 0) + 1));
        // A type is a filter only when it groups something.
        const typeChips = types.filter((type) => counts.get(type.id));
        if (picker.type && !counts.get(picker.type)) picker.type = '';
        const place = new Map(types.map((type, index) => [type.id, index]));
        const library = visible.filter((tpl) => !picker.type || viewOf(tpl).id === picker.type)
          .sort((a, b) => (place.get(viewOf(a).id) - place.get(viewOf(b).id)) || cleanText(a.name).localeCompare(cleanText(b.name)));
        const pinned = query ? [] : pins().map((id) => activeTemplates().find((tpl) => cleanText(tpl.id) === id)).filter(Boolean).filter(inDepartments);
        const deptChips = departments().length > 1 ? `
          <div class="fmdx-fchips" role="group" aria-label="${esc(state.departmentContext.departments_label || 'Departments')}">
            ${departments().map((entry) => `<button type="button" class="fmdx-fchip ${selectedDepartments().has(entry.id) ? 'on' : ''}" data-pick-department="${esc(entry.id)}" aria-pressed="${selectedDepartments().has(entry.id)}">${esc(entry.label)}</button>`).join('')}
          </div>` : '';
        const focused = document.activeElement === body.querySelector('[data-tpl-search]');
        body.innerHTML = `
          <div class="fmdx-create-top">
            <label class="fmdx-create-search"><i class="fas fa-magnifying-glass"></i><input type="search" data-tpl-search value="${esc(picker.query)}" placeholder="Search templates" autocomplete="off"></label>
            <button type="button" class="fmdx-btn" data-create-blank title="Start from an empty page"><i class="fas fa-file"></i> Blank</button>
            <button type="button" class="fmdx-btn" data-create-upload title="Scan or photo of a paper document; add fields during review"><i class="fas fa-arrow-up-from-bracket"></i> Upload</button>
          </div>
          ${pinned.length ? `
            <p class="fmdx-section-label">Pinned</p>
            <div class="fmdx-tpl-row">${pinned.map((tpl) => tileHtml(tpl, true)).join('')}</div>` : ''}
          <div class="fmdx-create-library-head">
            <p class="fmdx-section-label">${query ? 'Results' : 'Library'}</p>
            ${deptChips}
          </div>
          ${typeChips.length > 1 ? `
            <div class="fmdx-fchips">
              <button type="button" class="fmdx-fchip ${picker.type ? '' : 'on'}" data-pick-type="">All <small>${visible.length}</small></button>
              ${typeChips.map((meta) => `<button type="button" class="fmdx-fchip ${picker.type === meta.id ? 'on' : ''}" data-pick-type="${esc(meta.id)}" style="--fmdx-type:${esc(meta.color)}"><i class="fmdx-fchip-dot"></i>${esc(meta.label)} <small>${counts.get(meta.id)}</small></button>`).join('')}
              <button type="button" class="fmdx-fchip quiet" data-manage-types title="Rename, color, add or retire document types, and choose their departments"><i class="fas fa-sliders"></i> Edit types</button>
            </div>` : `<div class="fmdx-fchips"><button type="button" class="fmdx-fchip quiet" data-manage-types><i class="fas fa-sliders"></i> Edit types</button></div>`}
          ${library.length
            ? `<div class="fmdx-tpl-scroll">${types.filter((type) => library.some((tpl) => viewOf(tpl).id === type.id)).map((type) => { const group = library.filter((tpl) => viewOf(tpl).id === type.id); return `
                <section class="fmdx-tpl-group" style="--fmdx-type:${esc(type.color)}">
                  <h3><i class="fas ${esc(type.icon)}"></i>${esc(type.label)}<small>${group.length}</small></h3>
                  <div class="fmdx-tpl-grid">${group.map((tpl) => tileHtml(tpl, false)).join('')}</div>
                </section>`; }).join('')}</div>`
            : `<p class="fmdx-data-hint">${query ? 'No template matches that search.' : 'No templates here yet. Start from Blank, or upload a paper document.'}</p>`}`;
        const search = body.querySelector('[data-tpl-search]');
        if (focused) { search.focus(); search.setSelectionRange(picker.query.length, picker.query.length); }
        search.addEventListener('input', (event) => { picker.query = event.target.value; renderStepOne(); });
        body.querySelectorAll('[data-pick-department]').forEach((btn) => btn.addEventListener('click', () => {
          const chosen = selectedDepartments();
          const id = btn.dataset.pickDepartment;
          if (chosen.has(id) && chosen.size > 1) chosen.delete(id); else chosen.add(id);
          renderStepOne();
        }));
        body.querySelectorAll('[data-pick-type]').forEach((btn) => btn.addEventListener('click', () => { picker.type = btn.dataset.pickType; renderStepOne(); }));
        body.querySelector('[data-manage-types]')?.addEventListener('click', () => renderTypeEditor());
        body.querySelectorAll('[data-pin-template]').forEach((btn) => btn.addEventListener('click', () => togglePin(btn.dataset.pinTemplate)));
        body.querySelectorAll('[data-pick-template]').forEach((btn) => btn.addEventListener('click', () => {
          const tpl = activeTemplates().find((entry) => cleanText(entry.id) === btn.dataset.pickTemplate);
          if (!tpl) return;
          wizard.type = cleanText(tpl.document_type);
          wizard.template = tpl;
          proceed(btn);
        }));
        /** Blank and Upload need to know what kind of document: the filter in use, else ask. */
        const withType = (anchor, run) => {
          const current = types.find((type) => type.id === picker.type);
          if (current) { run(current.kind); return; }
          const menu = openMenu(anchor, `<p class="fmdx-menu-label">What kind of document?</p>${liveTypes().map(typeView).map((meta) => `<button type="button" class="fmdx-menu-item" data-menu-type="${esc(meta.kind)}"><i class="fas ${esc(meta.icon)}" style="color:${esc(meta.color)}"></i><span>${esc(meta.label)}</span></button>`).join('')}`);
          (menu?.el || document.querySelector('.fmdx-menu'))?.querySelectorAll('[data-menu-type]').forEach((item) => item.addEventListener('click', () => { document.querySelector('.fmdx-menu')?.remove(); run(item.dataset.menuType); }));
        };
        body.querySelector('[data-create-blank]').addEventListener('click', (event) => withType(event.currentTarget, (type) => { wizard.type = type; wizard.template = null; proceed(body.querySelector('[data-create-blank]')); }));
        body.querySelector('[data-create-upload]').addEventListener('click', (event) => withType(event.currentTarget, (type) => { wizard.type = type; wizard.template = '__upload__'; proceed(body.querySelector('[data-create-upload]')); }));
      }

      /** The organization edits its own types here: name, color, departments, order, and where each template is filed. */
      function renderTypeEditor(){
        const draft = { types: clone(org.types), assignments: { ...org.assignments } };
        const palette = ['#2563eb', '#0f766e', '#7c3aed', '#c2410c', '#be185d', '#0369a1', '#4d7c0f', '#b45309', '#475467'];
        const draw = () => {
          const live = draft.types.filter((type) => type.archived !== true);
          const filedUnder = (tpl) => { const moved = live.find((type) => type.id === cleanText(draft.assignments[cleanText(tpl.id)])); return (moved || live.find((type) => cleanText(type.kind) === cleanText(tpl.document_type)) || {}).id || ''; };
          body.innerHTML = `
            <div class="fmdx-create-top">
              <button type="button" class="fmdx-btn" data-types-back><i class="fas fa-arrow-left"></i> Back</button>
              <strong style="flex:1;font-size:14px">Document types</strong>
              <button type="button" class="fmdx-btn" data-types-add><i class="fas fa-plus"></i> Add type</button>
              <button type="button" class="fmdx-btn primary" data-types-save>Save</button>
            </div>
            <p class="fmdx-data-hint" style="margin:0">Types are how your templates are grouped. Rename them, give them a color and the ${esc((state.departmentContext.departments_label || 'departments').toLowerCase())} that use them, or add your own.</p>
            <div class="fmdx-types">
              ${draft.types.map((type, index) => { const view = typeView(type); return `
                <div class="fmdx-type-row ${type.archived ? 'archived' : ''}" data-type-row="${index}">
                  <span class="fmdx-type-move"><button type="button" data-type-up title="Move up" ${index === 0 ? 'disabled' : ''}><i class="fas fa-chevron-up"></i></button><button type="button" data-type-down title="Move down" ${index === draft.types.length - 1 ? 'disabled' : ''}><i class="fas fa-chevron-down"></i></button></span>
                  <input type="color" data-type-color value="${esc(view.color)}" list="fmdx-type-colors" title="Color">
                  <input type="text" class="fmdx-input" data-type-label value="${esc(type.label)}" maxlength="60" placeholder="Type name">
                  <select class="fmdx-input" data-type-kind title="What a blank document of this type is">${org.kinds.map((kind) => `<option value="${esc(kind.id)}" ${cleanText(type.kind) === kind.id ? 'selected' : ''}>${esc(kind.label)}</option>`).join('')}</select>
                  ${departments().length > 1 ? `<span class="fmdx-fchips">${departments().map((entry) => `<button type="button" class="fmdx-fchip ${arrayValue(type.department_ids).includes(entry.id) ? 'on' : ''}" data-type-department="${esc(entry.id)}" title="${arrayValue(type.department_ids).length ? '' : 'No department chosen: every department sees this type'}">${esc(entry.label)}</button>`).join('')}</span>` : ''}
                  <button type="button" class="fmdx-icon-btn" data-type-archive title="${type.archived ? 'Bring back' : 'Retire this type'}"><i class="fas ${type.archived ? 'fa-rotate-left' : 'fa-box-archive'}"></i></button>
                </div>`; }).join('')}
              <datalist id="fmdx-type-colors">${palette.map((color) => `<option value="${color}"></option>`).join('')}</datalist>
            </div>
            <p class="fmdx-section-label">Templates</p>
            <div class="fmdx-types">
              ${activeTemplates().map((tpl) => `
                <label class="fmdx-type-row template"><span>${esc(firstText(tpl.name, 'Template'))}</span>
                  <select class="fmdx-input" data-template-type="${esc(tpl.id)}">${live.filter((type) => type.id).map((type) => `<option value="${esc(type.id)}" ${filedUnder(tpl) === type.id ? 'selected' : ''}>${esc(type.label)}</option>`).join('')}${filedUnder(tpl) ? '' : '<option value="" selected>Other</option>'}</select>
                </label>`).join('')}
            </div>`;
          body.querySelector('[data-types-back]').addEventListener('click', () => renderStepOne());
          body.querySelector('[data-types-add]').addEventListener('click', () => { draft.types.push({ id: '', label: 'New type', color: palette[draft.types.length % palette.length], icon: '', kind: 'generic', department_ids: [], archived: false }); draw(); body.querySelector(`[data-type-row="${draft.types.length - 1}"] [data-type-label]`)?.select(); });
          body.querySelectorAll('[data-type-row]').forEach((row) => {
            const index = Number(row.dataset.typeRow);
            const type = draft.types[index];
            const swap = (to) => { [draft.types[index], draft.types[to]] = [draft.types[to], draft.types[index]]; draw(); };
            row.querySelector('[data-type-up]')?.addEventListener('click', () => swap(index - 1));
            row.querySelector('[data-type-down]')?.addEventListener('click', () => swap(index + 1));
            row.querySelector('[data-type-label]').addEventListener('change', (event) => { type.label = cleanText(event.target.value) || type.label; draw(); });
            row.querySelector('[data-type-color]').addEventListener('change', (event) => { type.color = event.target.value; });
            row.querySelector('[data-type-kind]').addEventListener('change', (event) => { type.kind = event.target.value; });
            row.querySelectorAll('[data-type-department]').forEach((chip) => chip.addEventListener('click', () => {
              const ids = new Set(arrayValue(type.department_ids));
              if (ids.has(chip.dataset.typeDepartment)) ids.delete(chip.dataset.typeDepartment); else ids.add(chip.dataset.typeDepartment);
              type.department_ids = [...ids];
              draw();
            }));
            row.querySelector('[data-type-archive]').addEventListener('click', () => { type.archived = !type.archived; draw(); });
          });
          body.querySelectorAll('[data-template-type]').forEach((select) => select.addEventListener('change', () => {
            // New types get their id when saved; until then they are told apart by position.
            const target = live.find((type) => type.id === select.value);
            if (target && target.id) draft.assignments[select.dataset.templateType] = target.id; else delete draft.assignments[select.dataset.templateType];
          }));
          body.querySelector('[data-types-save]').addEventListener('click', async (event) => {
            event.currentTarget.disabled = true;
            try {
              const saved = objectValue(await api().documents.saveTypes(orgId(), draft.types, draft.assignments));
              org.types = arrayValue(saved.types).map(objectValue);
              org.assignments = objectValue(saved.assignments);
              picker.type = '';
              renderStepOne();
            } catch (error) {
              showToast('Documents', errorMessage(error, 'The document types could not be saved.'), false);
              event.currentTarget.disabled = false;
            }
          });
        };
        draw();
      }

      /** Start the chosen document: paper intake, its workflow, or the inputs form. */
      let proceeding = false;
      async function proceed(button){
        const uploadTemplateId = wizard.template === '__upload__'
          ? ''
          : (cleanText(objectValue(wizard.template?.metadata).intake) === 'upload' ? cleanText(wizard.template.id) : '');
        if (wizard.template === '__upload__' || uploadTemplateId) {
          startPaperUpload(uploadTemplateId, wizard.type, () => modal.close());
          return;
        }
        // Workflow-first (§8): when the chosen type/template declares a
        // workflow, skip the params form and open the stepper instead. Any
        // failure along the way falls back to the classic params form.
        const workflowHint = createWorkflowHint();
        if (workflowHint) {
          if (proceeding) return;
          proceeding = true;
          const label = button ? button.innerHTML : '';
          body.querySelectorAll('button').forEach((entry) => { entry.disabled = true; });
          if (button) button.classList.add('busy');
          const opening = options.inlineHost ? null : showOpeningScreen(firstText(prefill.title, wizard.template?.name, typeMeta(wizard.type, catalog.types).label));
          if (opening) modal.el.style.display = 'none';
          const started = await tryWorkflowFirstCreate(workflowHint);
          proceeding = false;
          if (started || !modal.el.isConnected) return;
          // Nothing was created: back to the dialog, on its details form.
          if (opening) { opening.cancel(); modal.el.style.display = ''; }
          body.querySelectorAll('button').forEach((entry) => { entry.disabled = false; });
          if (button) { button.classList.remove('busy'); button.innerHTML = label; }
        }
        renderStepTwo();
      }

      /** Workflow id declared by the picked template or the catalog type. */
      function createWorkflowHint(){
        const catalogType = arrayValue(catalog.types).find((t) => firstText(t.id, t.type) === wizard.type) || {};
        // Templates pin their workflow in metadata; one that opts out of the
        // type's default opens straight in the editor.
        const templateMeta = objectValue(wizard.template?.metadata);
        if (templateMeta.disable_default_workflow === true) return '';
        return firstText(
          templateMeta.default_workflow_id,
          wizard.template?.workflow_id,
          wizard.template?.default_workflow_id,
          objectValue(wizard.template?.definition).workflow_id,
          catalogType.default_workflow_id,
          catalogType.workflow_id
        );
      }

      /** Load runtime + definition, create the draft, open the stepper.
       *  Returns false (nothing created) when any prerequisite is missing. */
      async function tryWorkflowFirstCreate(workflowId){
        try {
          // The runtime, the workflow and the template's defaults load together.
          const [runtime, record, templateDef] = await Promise.all([
            ensureWorkflowRuntime(),
            api().workflows?.get ? api().workflows.get(orgId(), workflowId).then(normalizeWorkflowRecord).catch(() => null) : null,
            wizard.template ? templateDefinition(wizard.template).catch(() => null) : null
          ]);
          if (!runtime) return false;
          if (!record) return false; // route/definition missing → params form
          if (!modal.el.isConnected) return true;
          // Defaults only — the workflow gathers everything else.
          const catalogType = arrayValue(catalog.types).find((t) => firstText(t.id, t.type) === wizard.type) || {};
          const defs = { ...objectValue(catalogType.param_schema), ...objectValue(templateDef?.params) };
          const params = { ...objectValue(prefill.params) };
          Object.entries(defs).forEach(([key, def]) => {
            if (params[key] === undefined) {
              params[key] = window.FMDocModel?.paramDefaultValue ? window.FMDocModel.paramDefaultValue(def) : (objectValue(def).default ?? null);
            }
          });
          const meta = typeMeta(wizard.type, catalog.types);
          const res = await createDocumentRecord({
            document_type: wizard.type,
            template_id: wizard.template?.id || null,
            workflow_id: workflowId,
            title: firstText(prefill.title, `${meta.label} — ${firstText(project().name, project().customer_name, 'New Document')}`),
            params
          });
          const doc = objectValue(res.document || res.doc || res);
          if (!doc.id) return false;
          modal.close();
          rememberStandaloneDoc(doc);
          loadDocs({ silent: true });
          // A draft made a moment ago has no saved step state to fetch: open on the workflow in hand.
          openWorkflowView(doc, record);
          return true;
        } catch (error) {
          console.warn('Workflow-first create failed — using the params form', error);
          return false;
        }
      }

      async function renderStepTwo(){
        body.innerHTML = '<div class="fmdx-state" style="min-height:140px"><div class="fmdx-spinner"></div></div>';
        const meta = typeMeta(wizard.type, catalog.types);
        const catalogType = arrayValue(catalog.types).find((t) => firstText(t.id, t.type) === wizard.type) || {};
        const templateDef = wizard.template ? await templateDefinition(wizard.template) : null;
        if (!modal.el.isConnected) return;
        // Params: type base schema + template additions (template wins).
        const defs = { ...objectValue(catalogType.param_schema), ...objectValue(templateDef?.params) };
        const prefillParams = objectValue(prefill.params);
        const values = {};
        Object.entries(defs).forEach(([key, def]) => {
          values[key] = prefillParams[key] !== undefined
            ? clone(prefillParams[key])
            : (window.FMDocModel?.paramDefaultValue ? window.FMDocModel.paramDefaultValue(def) : (def?.default ?? null));
        });
        // Prefilled params the schema doesn't know about (e.g. source_document_id
        // on amend when the template omits it) still ride along on create.
        Object.entries(prefillParams).forEach(([key, value]) => {
          if (values[key] === undefined) values[key] = clone(value);
        });
        const scopeEditors = new Map();
        const fieldsHtml = Object.entries(defs)
          .map(([key, def]) => paramFieldHtml(key, objectValue(def), values[key], { project: project() }))
          .join('');
        body.innerHTML = `
          <div class="fmdx-form-grid">
            <label class="fmdx-field wide"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_29dbd3d8b69f55","Title") ?? "Title")}</span><input type="text" data-create-title value="${String(esc(firstText(prefill.title, firstText(project().name, project().customer_name) ? `${meta.label} — ${firstText(project().name, project().customer_name)}` : meta.label)))}"></label>
            ${String(fieldsHtml || `<p class="fmdx-data-hint wide">${(globalThis.PlatformLanguage?.htmlText("documents","m_8c43f5efc8b00c","This template has no inputs — you can add data later from the editor’s Data panel.") ?? "This template has no inputs — you can add data later from the editor’s Data panel.")}</p>`)}
          </div>
          <div class="fmdx-modal-foot">
            <button type="button" class="fmdx-btn ghost spacer" data-create-back><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_206d31a7c795c4"," Back") ?? " Back")}</button>
            <button type="button" class="fmdx-btn primary" data-create-go><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_af2b65d24b9260"," Create document") ?? " Create document")}</button>
          </div>`;
        let richHandles = new Map();
        body.querySelectorAll('[data-scope-editor-for]').forEach((holder) => {
          const key = holder.dataset.scopeEditorFor;
          scopeEditors.set(key, mountScopeEditor(holder, arrayValue(values[key]).map(normalizeScopeItem), {
            // §7 bridge: a completed scope workflow also feeds the
            // measurements param and refreshes its required-inputs view.
            onScopeWorkflow: (scope) => {
              const measurements = objectValue(scope.measurements);
              const measHolder = body.querySelector('[data-rich-param-for][data-rich-kind="measurements"]');
              if (measHolder && Object.keys(measurements).length) richParamState(measHolder).write(measurements);
              richHandles.forEach((handle) => handle?.rerender?.());
            }
          }));
        });
        richHandles = mountRichParamEditors(body, {
          project: project(),
          orgId: orgId(),
          getScopeItems: () => {
            for (const editor of scopeEditors.values()) return editor.getItems();
            return arrayValue(values.scope_items);
          }
        });
        body.querySelector('[data-create-back]')?.addEventListener('click', () => renderStepOne());
        body.querySelector('[data-create-go]')?.addEventListener('click', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const extras = Object.fromEntries(Object.entries(values).filter(([key]) => !(key in defs)));
            const params = { ...extras, ...collectParamValues(body, defs, scopeEditors) };
            const res = await createDocumentRecord({
              document_type: wizard.type,
              template_id: wizard.template?.id || null,
              title: cleanText(body.querySelector('[data-create-title]')?.value) || undefined,
              params
            });
            modal.close();
            const doc = objectValue(res.document || res.doc || res);
            showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_07b310dcc0f93e","Document created.") ?? "Document created."), true);
            rememberStandaloneDoc(doc);
            await loadDocs({ silent: true });
            openEditor(doc);
          } catch (error) {
            button.disabled = false;
            showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not create the document.'), false);
          }
        });
      }

      // A prefilled type (Amend → Change Order) starts that type's own
      // template, in its workflow when it has one.
      if (wizard.type) {
        const ofType = activeTemplates().filter((tpl) => cleanText(tpl.document_type) === wizard.type && !isUploadTemplate(tpl));
        wizard.template = ofType.find((tpl) => objectValue(tpl.metadata).default === true) || ofType[0] || null;
        proceed();
      } else renderStepOne();
    }

    // ============================================================== editor
    /** Slide the project modal's left column out and go fullscreen while the
     * editor is open — the same focus treatment the Photos viewer uses. */
    function setEditorFocus(active){
      const win = root.closest?.('.r-win');
      if (win) win.classList.toggle('photo-focus', !!active);
      const overlay = root.closest?.('.r-overlay') || document.getElementById('rOverlay');
      const fullscreenNow = !!overlay?.classList?.contains('fullscreen');
      const toggleBtn = document.getElementById('rFullscreenToggle');
      if (active && overlay && !fullscreenNow && toggleBtn) {
        state.forcedFullscreen = true;
        toggleBtn.click();
      } else if (!active && state.forcedFullscreen) {
        state.forcedFullscreen = false;
        if (overlay?.classList?.contains('fullscreen')) toggleBtn?.click();
      }
      // Re-fit the canvas once the slide/expand transition settles.
      if (active) setTimeout(() => { try { state.editorHandle?.zoom?.('fit-width'); } catch (e) {} }, 620);
    }

    /** One document screen shell for BOTH views. options:
     *  { view: 'editor'|'workflow', workflow?: {definition,state} } */
    async function openDocScreen(docRecord, options = {}){
      destroyWorkflowView();
      destroyEditor();
      setEditorFocus(true);
      state.openingDoc = false;
      state.view = 'editor';
      state.doc = objectValue(docRecord);
      const record = objectValue(options.workflow);
      state.docWorkflow = arrayValue(objectValue(record.definition).steps).length ? record : null;
      // A document that has steps always opens on them, at the step it was
      // left on; the editor is "Edit manually" on the last step. A locked
      // document has nothing left to step through.
      const stepsFirst = () => !!state.docWorkflow && options.manual !== true && !isReadOnlyStatus(state.doc?.status);
      // The record usually says whether it has steps, so the right surface
      // shows at once instead of after the workflow has been fetched.
      const expectsSteps = !!firstText(objectValue(state.doc.workflow_ref).workflow_id) && options.manual !== true && !isReadOnlyStatus(state.doc?.status);
      state.docView = stepsFirst() || expectsSteps ? 'workflow' : 'editor';
      state.canPresent = false;
      state.presentOptions = null;
      state.resolved = null;
      state.working = null;
      state.workingDoc = null;
      state.dirty = false;
      state.baseOverrides = [];
      state.pendingOps = [];
      state.saveFailures = 0;
      state.saveState = 'idle';
      state.forceScopeSection = false;
      state.editorLoaded = false;
      state.editorLoading = false;
      state.workflowTouched = false;
      state.workflowWrites = { params: {}, outputs: {} };
      state.cardTotalCents = null;
      renderDocScreen();
      // Attach the instance's workflow when the caller didn't hand one over
      // (silent — reveals the [Workflow | Editor] toggle when found).
      if (!state.docWorkflow) {
        const opened = state.doc.id;
        const waiting = root.querySelector('[data-fmdx-wfrun-main]');
        if (waiting && state.docView === 'workflow') waiting.innerHTML = '<div class="fmdx-state" style="margin:48px auto"><div class="fmdx-spinner"></div><strong>Opening\u2026</strong></div>';
        ensureWorkflowRuntime(); // fetched alongside the workflow, not after it
        await loadDocWorkflow();
        if (state.destroyed || state.view !== 'editor' || state.doc?.id !== opened) return;
        const next = stepsFirst() ? 'workflow' : 'editor';
        if (next !== state.docView) {
          state.docView = next;
          if (waiting) waiting.innerHTML = '';
          updateModeToggle();
          syncDocViewVisibility();
        }
      }
      if (state.docView === 'workflow') {
        mountWorkflowHost();
        loadCatalog(); // warm the catalog for the editor switch
      } else {
        loadEditorView();
      }
    }

    function openEditor(docRecord){
      return openDocScreen(docRecord, { view: 'editor' });
    }

    /** Resolve + mount the editor canvas into the unified screen (lazy: only
     *  runs when the editor view is first shown). */
    async function loadEditorView(){
      if (state.editorLoading || !state.doc?.id) return;
      state.editorLoading = true;
      try {
        await loadCatalog();
        const [detailRes, resolvedRes] = await Promise.all([
          api().documents.get(orgId(), state.doc.id),
          api().documents.resolve(orgId(), state.doc.id)
        ]);
        if (state.destroyed || state.view !== 'editor') return;
        const detail = objectValue(detailRes.document || detailRes.doc || detailRes);
        if (detail.id) state.doc = { ...state.doc, ...detail };
        state.resolved = objectValue(resolvedRes);
        captureResolvedTotal(state.resolved);
        state.baseOverrides = arrayValue(state.doc.overrides).map((op) => clone(op));
        state.working = isReadOnlyStatus(state.doc.status) ? null : await instanceWorkingDefinition();
        if (state.destroyed || state.view !== 'editor') return;
        state.editorLoaded = true;
        state.workflowTouched = false;
        renderDocScreen();
        mountEditorCanvas();
        renderDataPanel();
      } catch (error) {
        if (state.destroyed) return;
        const canvas = root.querySelector('[data-fmdx-canvas]');
        if (canvas) canvas.innerHTML = `<div class="fmdx-state" style="margin:20px"><i class="fas fa-cloud-bolt"></i><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_804ccab73a4f98","Couldn’t open this document") ?? "Couldn’t open this document")}</strong><span>${String(esc(errorMessage(error, '')))}</span></div>`;
      } finally {
        state.editorLoading = false;
      }
    }

    /** Working definition for the editor: the instance's overrides applied to
     * its template version (never binding-resolved — the editor previews
     * bindings live through resolveScope). Falls back to the server-resolved
     * copy when the template can't be fetched, with bound values baked in. */
    async function instanceWorkingDefinition(){
      const ref = objectValue(state.doc?.template_ref);
      const FM = window.FMDocModel;
      if (firstText(ref.template_id) && FM?.applyOverrides) {
        try {
          let version = Number(ref.version || 0);
          if (!version) {
            const detail = await api().templates.get(orgId(), ref.template_id);
            version = Number(objectValue(detail.template || detail).current_version || 0);
          }
          const definition = await templateDefinition({ id: ref.template_id, current_version: version });
          if (definition) {
            const applied = FM.applyOverrides(definition, arrayValue(state.doc.overrides));
            return { definition: applied.document, fromTemplate: true };
          }
        } catch (error) {
          console.warn('Template definition unavailable — editing the resolved copy', error);
        }
      }
      const resolvedDefinition = clone(objectValue(state.resolved).resolved_definition);
      return { definition: resolvedDefinition, fromTemplate: false };
    }

    function closeDocScreen(){
      flushAutosave();
      flushWorkflowWrites();
      destroyWorkflowView();
      destroyEditor();
      setEditorFocus(false);
      state.view = 'list';
      state.doc = null;
      state.docWorkflow = null;
      state.resolved = null;
      state.editorLoaded = false;
      state.docView = 'editor';
      render();
      loadDocs({ silent: true });
    }

    function destroyEditor(){
      rememberDocumentViewport();
      clearTimeout(state.saveTimer);
      state.saveTimer = 0;
      destroyDocAgent();
      try { state.editorHandle?.destroy?.(); } catch (e) {}
      state.editorHandle = null;
      state.mountedEditorDocumentId = '';
      state.workingDoc = null;
    }

    function rememberDocumentViewport(){
      const canvas = root.querySelector('.fmde-canvas');
      const documentId = cleanText(state.mountedEditorDocumentId);
      if (!canvas || !documentId) return;
      state.editorCanvasViewport = {
        documentId,
        left: canvas.scrollLeft,
        top: canvas.scrollTop
      };
    }

    function restoreDocumentViewport(){
      const saved = objectValue(state.editorCanvasViewport);
      if (!saved.documentId || saved.documentId !== cleanText(state.doc?.id)) return;
      const apply = () => {
        if (state.destroyed || state.view !== 'editor') return;
        const canvas = root.querySelector('.fmde-canvas');
        if (!canvas) return;
        canvas.scrollLeft = numberValue(saved.left) || 0;
        canvas.scrollTop = numberValue(saved.top) || 0;
      };
      requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
      });
      setTimeout(apply, 120);
    }

    // ── Right-tray subtabs: Setup (the data panel) | Agent (doc copilot) ──
    function setTrayTab(tab){
      state.trayTab = tab === 'agent' ? 'agent' : 'data';
      const panel = root.querySelector('[data-fmdx-data-panel]');
      if (!panel) return;
      panel.querySelectorAll('[data-fmdx-tray-tab]').forEach((btn) => btn.classList.toggle('active', btn.dataset.fmdxTrayTab === state.trayTab));
      const dataPane = panel.querySelector('[data-fmdx-tray-data]');
      const agentPane = panel.querySelector('[data-fmdx-tray-agent]');
      if (dataPane) dataPane.hidden = state.trayTab !== 'data';
      if (agentPane) agentPane.hidden = state.trayTab !== 'agent';
      if (state.trayTab === 'agent' && agentPane && !state.docAgent) mountDocAgent(agentPane);
    }

    function destroyDocAgent(){
      try { state.docAgent?.destroy?.(); } catch (e) {}
      state.docAgent = null;
    }

    /** Apply an agent-staged full document to the live editor + autosave. */
    function applyAgentDocument(docModel){
      try { state.editorHandle?.setDocument?.(clone(docModel), { source: 'agent' }); } catch (error) { console.warn('Agent document apply failed', error); }
      state.workingDoc = clone(state.editorHandle?.getDocument?.() || docModel);
      // Autosave as coarse doc.set override ops through the normal op log so
      // revision handling and conflict rebase stay on one path.
      for (const op of coarseOverrideOps(state.workingDoc)) state.pendingOps.push(op);
      state.dirty = true;
      if (state.saveState !== 'saving') { state.saveState = 'dirty'; updateSaveState(); }
      scheduleAutosave();
      syncTrayOffset();
    }

    function mountDocAgent(host){
      destroyDocAgent();
      if (!window.FMDocAgentPanel?.create) {
        host.innerHTML = `<div class="fmdx-state" style="margin:14px"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_b81cd219469c9b","The document copilot library is not loaded.") ?? "The document copilot library is not loaded.")}</span></div>`;
        return;
      }
      state.docAgent = window.FMDocAgentPanel.create(host, {
        orgId: orgId(),
        subjectId: firstText(state.doc?.id),
        title: (globalThis.PlatformLanguage?.text("documents","m_ec99d1d510fb3c","Document copilot") ?? "Document copilot"),
        placeholder: (globalThis.PlatformLanguage?.text("documents","m_a6794f2378bc40","Describe the change…") ?? "Describe the change…"),
        welcome: 'Tell me what should change on this document — wording, layout, sections — and I’ll edit it in real time.',
        suggestions: [
          'Rewrite the intro paragraph to be warmer',
          'Add a page with our 5-year workmanship warranty',
          'Make the totals section more prominent'
        ],
        getInput: () => ({
          mode: 'document',
          subject: {
            id: firstText(state.doc?.id),
            name: firstText(state.doc?.title),
            status: cleanText(state.doc?.status) || 'draft',
            document_type: cleanText(state.doc?.document_type) || 'generic'
          },
          definition: objectValue(state.workingDoc || state.editorHandle?.getDocument?.() || objectValue(state.working).definition)
        }),
        onAction: (action) => {
          if (cleanText(objectValue(action).type) !== 'document.set_definition') return;
          if (isReadOnlyStatus(state.doc?.status)) return;
          const docModel = clone(objectValue(objectValue(action).document));
          if (!arrayValue(docModel.pages).length && !docModel.root) return;
          applyAgentDocument(docModel);
        }
      });
    }

    /** Show/hide the editor body vs the workflow host (both stay mounted so
     *  switching preserves state), and keep the Data button editor-only. */
    function syncDocViewVisibility(){
      const body = root.querySelector('[data-fmdx-editor-body]');
      const wfHost = root.querySelector('[data-fmdx-workflow-host]');
      const workflowMode = state.docView === 'workflow';
      if (body) body.hidden = workflowMode;
      if (wfHost) wfHost.hidden = !workflowMode;
      root.querySelector('[data-fmdx-editor-screen]')?.classList.toggle('workflow-view', workflowMode);
      const dataBtn = root.querySelector('[data-fmdx-data-toggle]');
      if (dataBtn) {
        dataBtn.disabled = workflowMode;
        dataBtn.title = workflowMode ? 'The Data tray lives in the editor view' : '';
      }
      syncDeliverableButtons();
      syncTrayOffset();
    }

    /** ONE top bar for BOTH views (owner direction): back, title, status,
     *  save state, [Workflow | Editor] toggle, then Data (editor only),
     *  Theme, History, Preview, PDF, Send — all working from either view. */
    function renderDocScreen(){
      rememberDocumentViewport();
      if (!capabilityEnabled('documents.agent') && state.trayTab === 'agent') state.trayTab = 'data';
      if (state.view !== 'editor') return;
      // Several paths render the doc screen without going through render() —
      // make sure the embedded host surface is revealed on every one of them.
      if (embedded) embed.onDocScreen?.();
      const doc = state.doc || {};
      const readOnly = isReadOnlyStatus(doc.status);
      // Preserve canvas/panel/workflow hosts between chrome refreshes when
      // already present in the right mode; rebuild when read-only flips.
      const existing = root.querySelector('[data-fmdx-editor-screen]');
      if (existing && existing.dataset.readonly === String(readOnly)) {
        // The status can move without the lock flipping (draft to sent).
        const chip = existing.querySelector('.fmdx-editor-top > .fmdx-chip:not(.locked)');
        if (chip) chip.outerHTML = progressChip(doc);
        updateSaveState();
        updateModeToggle();
        syncDocViewVisibility();
        renderDocCard();
        return;
      }
      const statusLabel = STATUS_LABELS[cleanText(doc.status).toLowerCase()] || 'locked';
      root.innerHTML = `
        <div class="fmdx-shell">
          <div class="fmdx-editor-screen ${String(!readOnly && state.dataPanelOpen ? 'data-open' : '')}" data-fmdx-editor-screen data-readonly="${String(readOnly)}">
            <header class="fmdx-editor-top">
              <button type="button" class="fmdx-icon-btn" data-fmdx-back title="${(globalThis.PlatformLanguage?.htmlText("documents","m_2e600c57ddd018","Back to documents") ?? "Back to documents")}"><i class="fas fa-arrow-left"></i></button>
              ${String(readOnly
                ? `<strong class="fmdx-doc-title-input" style="border-color:transparent">${esc(firstText(doc.title, 'Document'))}</strong>`
                : `<input class="fmdx-doc-title-input" data-fmdx-title value="${esc(firstText(doc.title, 'Untitled document'))}" spellcheck="false">`)}
              ${String(readOnly ? `<span class="fmdx-chip locked" tabindex="0" title="${esc(`This document is ${statusLabel.toLowerCase()} and locked. ${isAmendableStatus(doc.status) ? 'Amend it with a change order to make revisions.' : 'It can no longer be edited.'}`)}"><i class="fas fa-lock"></i>Locked</span>` : '')}
              ${String(progressChip(doc))}
              <span class="fmdx-top-total" title="${(globalThis.PlatformLanguage?.htmlText("documents","m_9403c7637d4905","Total") ?? "Total")}"><b data-card-total>—</b></span>
              <span class="fmdx-save-state" data-fmdx-save-state></span>
              <button type="button" class="fmdx-btn" data-fmdx-mode-toggle data-fmdx-mode="workflow" title="Go back to this document's steps" hidden><i class="fas fa-list-check"></i> Back to steps</button>
              <div style="margin-left:auto;display:flex;gap:7px;align-items:center;flex-wrap:wrap">
                ${String(readOnly ? '' : `<button type="button" class="fmdx-btn fmdx-btn-icon ${state.dataPanelOpen ? 'active' : ''}" data-fmdx-data-toggle title="Data"><i class="fas fa-database"></i></button>`)}
                ${String(readOnly || !capabilityEnabled('documents.agent') ? '' : `<button type="button" class="fmdx-btn fmdx-btn-icon" data-fmdx-agent-btn title="Agent"><i class="fas fa-wand-magic-sparkles"></i></button>`)}
                ${String(readOnly ? '' : `<button type="button" class="fmdx-btn fmdx-btn-icon" data-fmdx-theme title="Theme"><i class="fas fa-palette"></i></button>`)}
                <button type="button" class="fmdx-btn fmdx-btn-icon" data-fmdx-history title="History"><i class="fas fa-clock-rotate-left"></i></button>
                ${String(readOnly ? '' : `<button type="button" class="fmdx-btn fmdx-btn-icon" data-fmdx-preview title="Preview"><i class="fas fa-eye"></i></button>
                <button type="button" class="fmdx-btn fmdx-btn-icon" data-fmdx-pdf title="Download PDF"><i class="fas fa-download"></i></button>`)}
                <button type="button" class="fmdx-btn fmdx-btn-more" data-fmdx-more title="More actions"><i class="fas fa-ellipsis"></i></button>
                ${String(readOnly ? '' : `<button type="button" class="fmdx-btn" data-fmdx-present title="Present this estimate to the customer" hidden><i class="fas fa-chalkboard-user"></i> Present</button>`)}
                ${String(readOnly && isAmendableStatus(doc.status)
                  ? `<button type="button" class="fmdx-btn primary" data-fmdx-amend><i class="fas fa-file-medical"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_4986fc99e268e8"," Amend → Change Order") ?? " Amend → Change Order")}</button>`
                  : `<button type="button" class="fmdx-btn primary" data-fmdx-send><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_c66c415b0e5570"," Send") ?? " Send")}</button>`)}
              </div>
            </header>
            <div class="fmdx-doc-card-row" data-fmdx-doc-card-row hidden>
              <div class="fmdx-doc-card" data-fmdx-doc-card></div>
            </div>
            <div class="fmdx-editor-main" data-fmdx-editor-body>
              <div class="fmdx-editor-canvas" data-fmdx-canvas>
                <div class="fmdx-state" style="margin:20px"><div class="fmdx-spinner"></div><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_b86508131600f7","Opening document") ?? "Opening document")}</strong></div>
              </div>
              ${String(readOnly ? '' : `<aside class="fmdx-data-panel ${state.dataPanelOpen ? '' : 'collapsed'}" data-fmdx-data-panel>
                <div class="fmdx-tray-tabs">
                  <button type="button" class="fmdx-tray-tab ${state.trayTab === 'agent' ? '' : 'active'}" data-fmdx-tray-tab="data"><i class="fas fa-database"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_6b124d14be8596"," Setup") ?? " Setup")}</button>
                  ${capabilityEnabled('documents.agent') ? `<button type="button" class="fmdx-tray-tab ${state.trayTab === 'agent' ? 'active' : ''}" data-fmdx-tray-tab="agent"><i class="fas fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_6132f8a9f6606d"," Agent") ?? " Agent")}</button>` : ''}
                </div>
                <div class="fmdx-tray-pane" data-fmdx-tray-data ${state.trayTab === 'agent' ? 'hidden' : ''}></div>
                ${capabilityEnabled('documents.agent') ? `<div class="fmdx-tray-pane" data-fmdx-tray-agent ${state.trayTab === 'agent' ? '' : 'hidden'}></div>` : ''}
              </aside>`)}
            </div>
            <div class="fmdx-workflow-host" data-fmdx-workflow-host hidden>
              <div class="fmdx-wfrun-main" data-fmdx-wfrun-main></div>
              ${String(readOnly || !capabilityEnabled('documents.agent') ? '' : `<aside class="fmdx-wfrun-agent ${state.wfAgentOpen ? '' : 'collapsed'}" data-fmdx-wfrun-agent></aside>`)}
            </div>
          </div>
        </div>`;
      root.querySelector('[data-fmdx-back]')?.addEventListener('click', () => closeDocScreen());
      root.querySelectorAll('[data-fmdx-mode]').forEach((button) => {
        button.addEventListener('click', () => setDocView(button.dataset.fmdxMode));
      });
      root.querySelector('[data-fmdx-data-toggle]')?.addEventListener('click', () => {
        if (state.docView !== 'editor') return;
        setDataPanelOpen(!state.dataPanelOpen);
      });
      root.querySelectorAll('[data-fmdx-tray-tab]').forEach((button) => {
        button.addEventListener('click', () => setTrayTab(button.dataset.fmdxTrayTab));
      });
      if (state.trayTab === 'agent') setTrayTab('agent');
      // One Agent button for both views: the Data-tray Agent tab in editor
      // view, the docked copilot aside beside the stepper in workflow view.
      root.querySelector('[data-fmdx-agent-btn]')?.addEventListener('click', () => {
        if (state.docView === 'workflow') { setWfRunAgentOpen(!state.wfAgentOpen); return; }
        setDataPanelOpen(true);
        setTrayTab('agent');
      });
      if (state.wfAgentOpen && state.docView === 'workflow') setWfRunAgentOpen(true);
      root.querySelector('[data-fmdx-theme]')?.addEventListener('click', async (event) => {
        const anchor = event.currentTarget;
        await flushAllWrites();
        openThemeMenu(anchor);
      });
      root.querySelector('[data-fmdx-history]')?.addEventListener('click', (event) => openHistoryMenu(event.currentTarget));
      root.querySelector('[data-fmdx-more]')?.addEventListener('click', (event) => openMoreMenu(event.currentTarget));
      // One preview: in a workflow it is the docked live preview (which has
      // its own full-screen button); elsewhere it opens full screen.
      root.querySelector('[data-fmdx-preview]')?.addEventListener('click', async () => {
        if (state.docView === 'workflow' && state.workflowHandle?.togglePreview?.()) return;
        await flushAllWrites();
        openPreview(state.doc);
      });
      root.querySelector('[data-fmdx-pdf]')?.addEventListener('click', async (event) => {
        const anchor = event.currentTarget;
        await flushAllWrites();
        downloadPdf(state.doc, anchor);
      });
      root.querySelector('[data-fmdx-send]')?.addEventListener('click', async () => {
        await flushAllWrites();
        openSendModal(state.doc);
      });
      const presentButton = root.querySelector('[data-fmdx-present]');
      if (presentButton) {
        presentButton.addEventListener('click', () => openPresentation());
        presentationOptions(doc.id).then((options) => {
          if (state.destroyed || state.doc?.id !== doc.id) return;
          state.presentOptions = objectValue(options);
          state.canPresent = canPresent(options);
          syncDeliverableButtons();
        });
      }
      syncDeliverableButtons();
      root.querySelector('[data-fmdx-amend]')?.addEventListener('click', () => amendToChangeOrder(state.doc));
      const titleInput = root.querySelector('[data-fmdx-title]');
      titleInput?.addEventListener('change', async () => {
        const title = cleanText(titleInput.value) || 'Untitled document';
        try {
          const res = await api().documents.patch(orgId(), state.doc.id, { title });
          state.doc = objectValue(res.document || res.doc) || { ...state.doc, title };
          showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_f5a2169ab59181","Title updated.") ?? "Title updated."), true);
          renderDocCard();
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not rename the document.'), false);
        }
      });
      updateSaveState();
      updateModeToggle();
      syncDocViewVisibility();
      renderDocCard();
    }

    // Amend gesture (§10.3): a signed/completed document is never edited —
    // revisions start a change order against it. The change order lists only
    // what changes; the signed scope stays on the source document.
    function amendToChangeOrder(doc){
      const source = objectValue(doc);
      const params = objectValue(source.params);
      openCreateModal({
        document_type: 'change_order',
        title: ((v0) => globalThis.PlatformLanguage?.text("documents","m_24d875eaf00564",`Change Order — ${v0}`,{v0}) ?? `Change Order — ${v0}`)(firstText(source.title, 'Document')),
        params: {
          source_document_id: firstText(source.id),
          ...(params.tax_percent !== undefined ? { tax_percent: params.tax_percent } : {})
        }
      });
    }

    // ==================================== rail document card + variants
    // A persistent card representing the DOCUMENT itself, pinned to the top
    // of the step rail in workflow view (visually continuous with the fmdw
    // rail) and shown as a slim band in editor view. Carries title, status,
    // live total, Duplicate, and — for proposals — the variant mechanics
    // (Add variant / jump / rename / remove). General rail furniture, not a
    // workflow step.
    const OPTION_SLOTS = [
      { slot: 'a', step: 'st_option_a', fallback: 'Good' },
      { slot: 'b', step: 'st_option_b', fallback: 'Better' },
      { slot: 'c', step: 'st_option_c', fallback: 'Best' }
    ];
    const MULTI_OPTION_TEMPLATE_ID = 'tpl_three_option_proposal';
    const MULTI_OPTION_WORKFLOW_ID = 'wfl_three_option_proposal';

    function variantSlots(params){
      const source = objectValue(params);
      return OPTION_SLOTS.map((def) => ({
        ...def,
        items: arrayValue(source[`option_${def.slot}_items`]),
        label: firstText(source[`option_${def.slot}_label`], def.fallback)
      }));
    }

    /** Multi-option proposal: the three-option template, or any filled slot. */
    function isMultiOptionDoc(doc, params){
      if (firstText(objectValue(objectValue(doc).template_ref).template_id) === MULTI_OPTION_TEMPLATE_ID) return true;
      return OPTION_SLOTS.some((def) => arrayValue(objectValue(params)[`option_${def.slot}_items`]).length > 0);
    }

    /** Live total off a /resolve payload (computed chain first). Returns
     *  true when a total was captured. */
    function captureResolvedTotal(payload){
      const computed = objectValue(objectValue(objectValue(payload).resolved_definition).computed_values);
      for (const key of ['total_cents', 'contract_total_cents', 'subtotal_cents']) {
        const value = Number(computed[key]);
        if (computed[key] !== null && computed[key] !== undefined && Number.isFinite(value)) {
          state.cardTotalCents = Math.round(value);
          return true;
        }
      }
      return false;
    }

    function docCardTotalCents(){
      return state.cardTotalCents !== null && state.cardTotalCents !== undefined
        ? state.cardTotalCents
        : docTotalCents(state.doc || {});
    }

    function updateDocCardTotal(){
      const el = root.querySelector('[data-fmdx-editor-screen] [data-card-total]');
      if (!el) return;
      const total = docCardTotalCents();
      el.textContent = total ? moneyFromCents(total) : '—';
    }

    /** Variant chips for multi-option proposals. The document's title, status
     *  and total live in the top bar; this row only exists while there are
     *  variants to jump between. */
    function renderDocCard(){
      const row = root.querySelector('[data-fmdx-doc-card-row]');
      const card = root.querySelector('[data-fmdx-doc-card]');
      if (!row || !card || !state.doc) return;
      const doc = state.doc;
      const readOnly = isReadOnlyStatus(doc.status);
      const params = objectValue(doc.params);
      const isProposal = cleanText(doc.document_type).toLowerCase() === 'proposal';
      const multi = isProposal && isMultiOptionDoc(doc, params);
      const filled = multi ? variantSlots(params).filter((slot) => slot.items.length) : [];
      row.hidden = !filled.length;
      card.innerHTML = filled.length ? `
          <div class="fmdx-doc-card-variants">
            ${filled.map((slot) => `
              <span class="fmdx-variant-chip ${readOnly ? 'static' : ''}" data-variant-chip="${esc(slot.slot)}">
                <button type="button" class="jump" data-variant-jump="${esc(slot.slot)}" ${readOnly ? 'disabled' : ''} title="${readOnly ? esc(slot.label) : `Open ${esc(slot.label)} · double-click to rename`}">${esc(slot.label)}</button>
                ${!readOnly && slot.slot !== 'a' ? `<button type="button" class="x" data-variant-remove="${esc(slot.slot)}" title="${((v1) => globalThis.PlatformLanguage?.htmlText("documents","m_ade5cd0266b010",`Remove ${v1}`,{v1}) ?? `Remove ${v1}`)(esc(slot.label))}"><i class="fas fa-xmark"></i></button>` : ''}
              </span>`).join('')}
          </div>` : '';
      updateDocCardTotal();
      card.querySelectorAll('[data-variant-jump]').forEach((button) => {
        button.addEventListener('click', () => jumpToVariant(button.dataset.variantJump));
        button.addEventListener('dblclick', () => renameVariant(button.dataset.variantJump));
      });
      card.querySelectorAll('[data-variant-remove]').forEach((button) => {
        button.addEventListener('click', () => removeVariant(button.dataset.variantRemove));
      });
    }

    /** Jump the stepper to a variant's step (switching to workflow view
     *  first — the card renders in editor view too). refresh() is used over
     *  goTo() so a freshly revealed `when` step is reachable even while an
     *  earlier step is still incomplete. */
    async function jumpToVariant(slot){
      const def = OPTION_SLOTS.find((entry) => entry.slot === slot);
      if (!def || !state.docWorkflow || isReadOnlyStatus(state.doc?.status)) return;
      if (state.docView !== 'workflow') await setDocView('workflow');
      if (!state.workflowHandle) return;
      try { state.workflowHandle.refresh({ current_step: def.step }); } catch (e) { /* stepper keeps its position */ }
      persistWorkflowStepState({ current_step: def.step });
    }

    async function renameVariant(slot){
      const def = OPTION_SLOTS.find((entry) => entry.slot === slot);
      if (!def || !state.doc?.id || isReadOnlyStatus(state.doc.status)) return;
      const params = objectValue(state.doc.params);
      const current = firstText(params[`option_${slot}_label`], def.fallback);
      const next = cleanText(window.prompt((globalThis.PlatformLanguage?.text("documents","m_ca125d59fcd810","Option name") ?? "Option name"), current));
      if (!next || next === current) return;
      try {
        await flushAllWrites();
        const res = await api().documents.patch(orgId(), state.doc.id, { params: { [`option_${slot}_label`]: next } });
        const updated = objectValue(res.document || res.doc);
        state.doc = updated.id ? { ...state.doc, ...updated } : { ...state.doc, params: { ...params, [`option_${slot}_label`]: next } };
        renderDocCard();
        try { state.workflowHandle?.refresh?.({ params: clone(objectValue(state.doc.params)) }); } catch (e) {}
        try { state.workflowHandle?.refreshPreview?.(); } catch (e) {}
        state.workflowTouched = true;
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not rename the option.'), false);
      }
    }

    async function removeVariant(slot){
      const def = OPTION_SLOTS.find((entry) => entry.slot === slot);
      if (!def || slot === 'a' || !state.doc?.id || isReadOnlyStatus(state.doc.status)) return;
      const params = objectValue(state.doc.params);
      const label = firstText(params[`option_${slot}_label`], def.fallback);
      const prompt = `Remove option "${label}"? Its line items are cleared and its workflow step disappears.`;
      const confirmed = window.Portal?.ui?.confirm ? await window.Portal.ui.confirm(prompt) : window.confirm(prompt);
      if (!confirmed) return;
      try {
        await flushAllWrites();
        const res = await api().documents.patch(orgId(), state.doc.id, {
          params: { [`option_${slot}_items`]: [], [`option_${slot}_label`]: null, [`option_${slot}_summary`]: null }
        });
        const updated = objectValue(res.document || res.doc);
        state.doc = updated.id ? { ...state.doc, ...updated } : {
          ...state.doc,
          params: { ...params, [`option_${slot}_items`]: [], [`option_${slot}_label`]: null, [`option_${slot}_summary`]: null }
        };
        showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), ((v0) => globalThis.PlatformLanguage?.text("documents","m_bc9bc7845f96a4",`Removed option "${v0}".`,{v0}) ?? `Removed option "${v0}".`)(label), true);
        renderDocCard();
        // Hand the stepper the pruned params — the `when` gate hides the step
        // live; if it was current the stepper falls back to the first open step.
        try { state.workflowHandle?.refresh?.({ params: clone(objectValue(state.doc.params)) }); } catch (e) {}
        try { state.workflowHandle?.refreshPreview?.(); } catch (e) {}
        state.workflowTouched = true;
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not remove the option.'), false);
      }
    }

    /** Add variant: on a multi-option doc, fill the first empty slot with a
     *  copy of the active option's items; on a standard proposal, convert to
     *  the three-option template/workflow (draft re-template PATCH). */
    async function addVariant(button){
      if (!state.doc?.id || isReadOnlyStatus(state.doc.status)) return;
      if (cleanText(state.doc.document_type).toLowerCase() !== 'proposal') return;
      if (button) button.disabled = true;
      try {
        await flushAllWrites();
        const params = objectValue(state.doc.params);
        if (!isMultiOptionDoc(state.doc, params)) {
          await convertToMultiOption();
          return;
        }
        const slots = variantSlots(params);
        const empty = slots.find((slot) => !slot.items.length);
        if (!empty) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_85161446d68515","All three option slots are in use — proposals support up to three options (Good / Better / Best).") ?? "All three option slots are in use — proposals support up to three options (Good / Better / Best)."), false);
          return;
        }
        // Copy the ACTIVE option's items: the slot whose step is current in
        // the stepper, else the first filled slot, else the contract scope.
        const currentStepId = firstText(
          objectValue(state.workflowHandle?.state?.()).current_step,
          objectValue(objectValue(state.docWorkflow).state).current_step
        );
        const active = slots.find((slot) => slot.step === currentStepId && slot.items.length)
          || slots.find((slot) => slot.items.length);
        const sourceItems = active ? clone(active.items) : clone(arrayValue(params.scope_items));
        const label = cleanText(window.prompt((globalThis.PlatformLanguage?.text("documents","m_5dda250ebcbba7","Name the new option") ?? "Name the new option"), empty.fallback)) || empty.fallback;
        const res = await api().documents.patch(orgId(), state.doc.id, {
          params: { [`option_${empty.slot}_items`]: sourceItems, [`option_${empty.slot}_label`]: label }
        });
        const updated = objectValue(res.document || res.doc);
        state.doc = updated.id ? { ...state.doc, ...updated } : {
          ...state.doc,
          params: { ...params, [`option_${empty.slot}_items`]: sourceItems, [`option_${empty.slot}_label`]: label }
        };
        showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), ((v0,v1) => globalThis.PlatformLanguage?.text("documents","m_245d50f1a7e006",`Added option "${v0}"${v1}.`,{v0,v1}) ?? `Added option "${v0}"${v1}.`)(label,active ? ` from ${active.label}` : ''), true);
        state.workflowTouched = true;
        renderDocCard();
        // Reveal the `when` step and land on it.
        if (state.docView !== 'workflow' && state.docWorkflow) await setDocView('workflow');
        try { state.workflowHandle?.refresh?.({ params: clone(objectValue(state.doc.params)), current_step: empty.step }); } catch (e) {}
        persistWorkflowStepState({ current_step: empty.step });
        try { state.workflowHandle?.refreshPreview?.(); } catch (e) {}
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not add the option.'), false);
      } finally {
        if (button) button.disabled = false;
      }
    }

    /** Standard proposal → multi-option: current scope becomes Option A, a
     *  copy becomes Option B, and the draft is re-pointed at the three-option
     *  template + workflow (backend draft re-template support). */
    async function convertToMultiOption(){
      const doc = state.doc;
      const params = objectValue(doc.params);
      const items = arrayValue(params.scope_items);
      const prompt = 'Convert to a multi-option proposal? Your current line items become Option A, and a copy becomes Option B for you to adjust. The customer compares the options and picks one.';
      const confirmed = window.Portal?.ui?.confirm ? await window.Portal.ui.confirm(prompt) : window.confirm(prompt);
      if (!confirmed) return;
      const res = await api().documents.patch(orgId(), doc.id, {
        params: {
          option_a_items: clone(items),
          option_a_label: 'Option A',
          option_b_items: clone(items),
          option_b_label: 'Option B'
        },
        template_ref: { template_id: MULTI_OPTION_TEMPLATE_ID },
        workflow_ref: { workflow_id: MULTI_OPTION_WORKFLOW_ID }
      });
      const updated = objectValue(res.document || res.doc);
      if (updated.id) state.doc = { ...state.doc, ...updated };
      showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_c4129b381059c3","Converted to a multi-option proposal.") ?? "Converted to a multi-option proposal."), true);
      // Template + workflow changed under the open screen: drop every cached
      // surface, re-attach the new workflow, and land on Option B.
      state.editorLoaded = false;
      state.editorLoading = false;
      state.working = null;
      state.resolved = null;
      state.cardTotalCents = null;
      state.workflowTouched = false;
      state.baseOverrides = arrayValue(state.doc.overrides).map((op) => clone(op));
      state.pendingOps = [];
      destroyEditor();
      destroyWorkflowView();
      const attached = await loadDocWorkflow();
      renderDocCard();
      if (attached) {
        state.docView = 'workflow';
        updateModeToggle();
        syncDocViewVisibility();
        await mountWorkflowHost();
        try { state.workflowHandle?.refresh?.({ current_step: 'st_option_b' }); } catch (e) {}
        persistWorkflowStepState({ current_step: 'st_option_b' });
        try { state.workflowHandle?.refreshPreview?.(); } catch (e) {}
      } else {
        state.docView = 'editor';
        updateModeToggle();
        syncDocViewVisibility();
        loadEditorView();
      }
    }

    function openThemeMenu(anchor){
      const doc = state.doc || {};
      const themes = arrayValue(state.catalog?.themes);
      const currentId = firstText(objectValue(doc.theme_ref).theme_id);
      const branding = objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding);
      const menu = openMenu(anchor, `
        <div class="fmdx-menu-note">${(globalThis.PlatformLanguage?.htmlText("documents","m_d056fb485eea2e","Org themes restyle the whole document") ?? "Org themes restyle the whole document")}</div>
        ${String(themeCardHtml({
          definition: null,
          branding,
          value: '',
          name: 'Template default',
          sub: 'Whatever the template shipped with',
          current: !currentId
        }))}
        ${String(themes.length ? themes.map((theme) => themeCardHtml({
          definition: objectValue(theme.definition),
          branding,
          value: firstText(theme.id, theme.theme_id),
          name: firstText(theme.name, theme.id, 'Theme'),
          current: firstText(theme.id, theme.theme_id) === currentId
        })).join('') : `<div class="fmdx-menu-note">${(globalThis.PlatformLanguage?.htmlText("documents","m_0fceeb48a2f9ea","No published themes yet — create them in Doc Studio.") ?? "No published themes yet — create them in Doc Studio.")}</div>`)}`);
      menu.el.classList.add('fmdx-theme-menu');
      // The card layout is wider than the default menu — re-clamp to viewport.
      menu.el.style.left = `${Math.max(8, Math.min(parseFloat(menu.el.style.left) || 8, window.innerWidth - menu.el.offsetWidth - 8))}px`;
      menu.el.querySelectorAll('[data-menu-theme]').forEach((button) => button.addEventListener('click', async () => {
        const themeId = cleanText(button.dataset.menuTheme);
        menu.close();
        try {
          await flushAutosave();
          // A page style brings its own margins: re-fit the document's page
          // regions to it, the way the editor's Page setup dialog does.
          const working = await instanceWorkingDefinition();
          const targetId = themeId || (working.fromTemplate ? firstText(objectValue((await templateDefinition({ id: state.doc.template_ref.template_id, current_version: state.doc.template_ref.version }))?.theme_ref).theme_id) : '');
          const target = themes.find((theme) => firstText(theme.id, theme.theme_id) === targetId);
          const marginOps = working.fromTemplate && target && window.FMDocModel?.pageSetupOverrides
            ? window.FMDocModel.pageSetupOverrides(working.definition, objectValue(target.definition))
            : [];
          const overrides = marginOps.length ? collapseOps([...arrayValue(state.doc.overrides), ...marginOps]) : null;
          const res = await api().documents.patch(orgId(), state.doc.id, { theme_ref: themeId ? { theme_id: themeId } : null, ...(overrides ? { overrides } : {}) });
          const updated = objectValue(res.document || res.doc);
          if (updated.id) state.doc = { ...state.doc, ...updated };
          if (overrides) state.baseOverrides = overrides.map((op) => clone(op));
          showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), themeId ? 'Theme applied.' : 'Reverted to the template theme.', true);
          await refreshResolvedEditor();
          // The workflow live preview re-resolves on its own writes only —
          // out-of-band changes like a theme switch must push a refresh.
          try { state.workflowHandle?.refreshPreview?.(); } catch (e) {}
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not change the theme.'), false);
        }
      }));
    }

    /** Less-used document actions, kept out of the top bar. */
    function openMoreMenu(anchor){
      const doc = state.doc || {};
      const readOnly = isReadOnlyStatus(doc.status);
      const isProposal = cleanText(doc.document_type).toLowerCase() === 'proposal';
      const multi = isProposal && isMultiOptionDoc(doc, objectValue(doc.params));
      const menu = openMenu(anchor, `
        ${!readOnly && multi ? `<button type="button" class="fmdx-menu-item" data-more-variant title="${multi ? 'Add another option to this proposal' : 'Turn this into a multi-option (Good/Better/Best) proposal'}"><i class="fas fa-code-branch"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_95299bfa43bab3"," Add variant") ?? " Add variant")}</button>` : ''}
        <button type="button" class="fmdx-menu-item" data-more-duplicate title="${(globalThis.PlatformLanguage?.htmlText("documents","m_eab1f6b49f7769","Create a draft copy of this document") ?? "Create a draft copy of this document")}"><i class="fas fa-copy"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_7eec37dfa2be3f"," Duplicate") ?? " Duplicate")}</button>
        ${!readOnly && state.canPresent ? `${window.FMPresentationEditorHost ? '<button type="button" class="fmdx-menu-item" data-more-edit-presentation title="Open this presentation in the visual editor"><i class="fas fa-chalkboard"></i> Edit presentation</button>' : ''}${arrayValue(objectValue(state.presentOptions).offers).includes('send_presentation') ? '<button type="button" class="fmdx-menu-item" data-more-send-presentation title="Email the customer a link to go through the presentation themselves"><i class="fas fa-share-from-square"></i> Email presentation link</button>' : ''}` : ''}`);
      menu.el.querySelector('[data-more-edit-presentation]')?.addEventListener('click', () => { menu.close(); editPresentation(objectValue(objectValue(state.presentOptions).presentation).moduleId); });
      menu.el.querySelector('[data-more-send-presentation]')?.addEventListener('click', () => { menu.close(); sendPresentation(); });
      menu.el.querySelector('[data-more-variant]')?.addEventListener('click', (event) => {
        const button = event.currentTarget;
        menu.close();
        addVariant(button);
      });
      menu.el.querySelector('[data-more-duplicate]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        menu.close();
        await flushAllWrites();
        await duplicateDoc(state.doc, button);
      });
    }

    // Document history (docs/architecture/document-history.md): every revision
    // with who or what made it, what changed between any two, a view of any
    // version, and restore as a new revision. Sent and signed versions view as
    // their frozen snapshot.
    const HISTORY_CUTS = {
      created: ['fa-file-circle-plus', (globalThis.PlatformLanguage?.text("documents","m_dc002b01a36e6f","Created") ?? "Created")],
      baseline: ['fa-flag', (globalThis.PlatformLanguage?.text("documents","m_e6b6d3d1964041","History starts here") ?? "History starts here")],
      edit: ['fa-pen', (globalThis.PlatformLanguage?.text("documents","m_0137fa44ab2c7b","Edited") ?? "Edited")],
      named: ['fa-bookmark', (globalThis.PlatformLanguage?.text("documents","m_c8ea6794e4d453","Named version") ?? "Named version")],
      restore: ['fa-rotate-left', (globalThis.PlatformLanguage?.text("documents","m_7a6d09ae711ddb","Restored an earlier version") ?? "Restored an earlier version")],
      present: ['fa-display', (globalThis.PlatformLanguage?.text("documents","m_903fdc2cf28a25","Presented") ?? "Presented")],
      present_choices: ['fa-list-check', (globalThis.PlatformLanguage?.text("documents","m_690eceaadb30dd","Presentation choices applied") ?? "Presentation choices applied")],
      snapshot: ['fa-camera', (globalThis.PlatformLanguage?.text("documents","m_71455a79e35b80","Snapshot taken") ?? "Snapshot taken")],
      pdf: ['fa-file-pdf', (globalThis.PlatformLanguage?.text("documents","m_c7b3d1f3ea66cb","PDF prepared") ?? "PDF prepared")],
      issue: ['fa-stamp', (globalThis.PlatformLanguage?.text("documents","m_103d1f897eea51","Issued") ?? "Issued")],
      send: ['fa-paper-plane', (globalThis.PlatformLanguage?.text("documents","m_3468b446cb1456","Sent") ?? "Sent")],
      view: ['fa-eye', (globalThis.PlatformLanguage?.text("documents","m_2239713bcd2f00","Viewed by the customer") ?? "Viewed by the customer")],
      response: ['fa-reply', (globalThis.PlatformLanguage?.text("documents","m_df6de9f6437847","Response recorded") ?? "Response recorded")],
      payment: ['fa-credit-card', (globalThis.PlatformLanguage?.text("documents","m_e14ce2b0e5f1e9","Payment recorded") ?? "Payment recorded")],
      sign: ['fa-signature', (globalThis.PlatformLanguage?.text("documents","m_ab7ec8db303996","Signed") ?? "Signed")],
      complete: ['fa-circle-check', (globalThis.PlatformLanguage?.text("documents","m_3c4d2141b2fa1c","Completed") ?? "Completed")],
      decline: ['fa-circle-xmark', (globalThis.PlatformLanguage?.text("documents","m_bf5390659e3677","Declined") ?? "Declined")],
      void: ['fa-ban', (globalThis.PlatformLanguage?.text("documents","m_9629786e01442d","Voided") ?? "Voided")],
      expire: ['fa-hourglass-end', (globalThis.PlatformLanguage?.text("documents","m_e685fe954b1758","Expired") ?? "Expired")],
      workflow: ['fa-diagram-next', (globalThis.PlatformLanguage?.text("documents","m_7b27447fdce391","Workflow step") ?? "Workflow step")],
      upload: ['fa-upload', (globalThis.PlatformLanguage?.text("documents","m_cd35b3ca1cde41","Upload confirmed") ?? "Upload confirmed")],
      manual_edit: ['fa-hand', (globalThis.PlatformLanguage?.text("documents","m_781df8b1112a51","Edited manually") ?? "Edited manually")],
      publish: ['fa-upload', (globalThis.PlatformLanguage?.text("documents","m_fcef580bdd8824","Published") ?? "Published")]
    };
    const HISTORY_SECTIONS = {
      title: (globalThis.PlatformLanguage?.text("documents","m_29dbd3d8b69f55","Title") ?? "Title"), status: (globalThis.PlatformLanguage?.text("documents","m_1352cafa75b8da","Status") ?? "Status"), params: (globalThis.PlatformLanguage?.text("documents","m_d90dd04a0cd959","Inputs") ?? "Inputs"), outputs: (globalThis.PlatformLanguage?.text("documents","m_4ea0d63d1e0b6f","Responses") ?? "Responses"), workflow_state: (globalThis.PlatformLanguage?.text("documents","m_7dbbeae35a4717","Workflow") ?? "Workflow"),
      delivery: (globalThis.PlatformLanguage?.text("documents","m_b73185deef6d79","Delivery") ?? "Delivery"), contact_ids: (globalThis.PlatformLanguage?.text("documents","m_c1791596944182","Recipients") ?? "Recipients"), tags: (globalThis.PlatformLanguage?.text("documents","m_562d2cd3a48b8f","Tags") ?? "Tags"), theme_ref: (globalThis.PlatformLanguage?.text("documents","m_e352b4d5acce2e","Theme") ?? "Theme"), theme_overrides: (globalThis.PlatformLanguage?.text("documents","m_e352b4d5acce2e","Theme") ?? "Theme"),
      template_ref: (globalThis.PlatformLanguage?.text("documents","m_587d96db750df7","Template") ?? "Template"), metadata: (globalThis.PlatformLanguage?.text("documents","m_b3ecc234f63212","Details") ?? "Details"), overrides: (globalThis.PlatformLanguage?.text("documents","m_89f6b80ae9b0fe","Content") ?? "Content"), signing: (globalThis.PlatformLanguage?.text("documents","m_d3dec34e595431","Signing") ?? "Signing"), pdf: (globalThis.PlatformLanguage?.text("documents","m_2440c46d7ac5f3","PDF") ?? "PDF")
    };
    const historyCut = (cut) => HISTORY_CUTS[cut] || ['fa-circle', cleanText(cut).replace(/_/g, ' ')];
    const historySection = (key) => HISTORY_SECTIONS[key] || cleanText(key).replace(/_/g, ' ');
    function historyActor(revision){
      const source = objectValue(revision.source);
      const label = cleanText(revision.actor_label);
      if (source.kind === 'person' && cleanText(revision.actor_name)) return cleanText(revision.actor_name);
      if (label === 'customer') return (globalThis.PlatformLanguage?.text("documents","m_ae8e4953e07d70","Customer") ?? "Customer");
      if (label) return label;
      return ({ person: (globalThis.PlatformLanguage?.text("documents","m_96895caa53f69d","Someone") ?? "Someone"), agent: (globalThis.PlatformLanguage?.text("documents","m_b8071e017821d8","Agent") ?? "Agent"), automation: (globalThis.PlatformLanguage?.text("documents","m_a888fe79af378e","Automation") ?? "Automation"), module: (globalThis.PlatformLanguage?.text("documents","m_7e535c1105c21b","Custom code") ?? "Custom code"), generator: (globalThis.PlatformLanguage?.text("documents","m_866a03fce1595b","Generated") ?? "Generated") })[source.kind] || (globalThis.PlatformLanguage?.text("documents","m_9df9882cf648fb","System") ?? "System");
    }
    function historyTitle(revision){
      const [, label] = historyCut(revision.cut);
      if (revision.cut === 'named' && cleanText(revision.label)) return cleanText(revision.label);
      if (revision.cut === 'restore' && objectValue(revision.attributes).restored_from) return `${label} (#${Number(objectValue(revision.attributes).restored_from)})`;
      return label;
    }
    function historyWhen(value){
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? cleanText(value) : date.toLocaleString(globalThis.PlatformLanguage?.formatLocale?.(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
    function historyValue(value, key){
      if (value === undefined || value === null || value === '') return `<em>${esc((globalThis.PlatformLanguage?.text("documents","m_4e4914655c7461","empty") ?? "empty"))}</em>`;
      if (typeof value === 'number' && /_cents$/.test(cleanText(key))) return esc((value / 100).toLocaleString(globalThis.PlatformLanguage?.formatLocale?.(), { style: 'currency', currency: 'USD' }));
      if (typeof value === 'boolean') return esc(value ? (globalThis.PlatformLanguage?.text("documents","m_549ccd0e27a3d4","Yes") ?? "Yes") : (globalThis.PlatformLanguage?.text("documents","m_2f0222913078f4","No") ?? "No"));
      if (typeof value !== 'object') return esc(String(value));
      const text = JSON.stringify(value);
      return `<code>${esc(text.length > 160 ? `${text.slice(0, 160)}…` : text)}</code>`;
    }
    function historyDiffHtml(diff){
      const parts = [];
      const content = objectValue(diff.content);
      const blocks = [];
      for (const changed of arrayValue(content.changed_blocks)) {
        blocks.push(`<div class="fmdx-hist-block">${arrayValue(changed.word_diff).map((part) => part.type === 'add' ? `<ins>${esc(part.text)}</ins>` : part.type === 'del' ? `<del>${esc(part.text)}</del>` : esc(part.text)).join(' ')}</div>`);
      }
      for (const added of arrayValue(content.added_blocks)) blocks.push(`<div class="fmdx-hist-block"><ins>${esc(added.text)}</ins></div>`);
      for (const removed of arrayValue(content.removed_blocks)) blocks.push(`<div class="fmdx-hist-block"><del>${esc(removed.text)}</del></div>`);
      if (Number(content.other_changes || 0)) blocks.push(`<div class="fmdx-hist-note"><i class="fas fa-shapes"></i> ${esc(String(Number(content.other_changes)))} ${esc((globalThis.PlatformLanguage?.text("documents","m_882efc6285bf29","layout or design changes") ?? "layout or design changes"))}</div>`);
      if (blocks.length) parts.push(`<section><h4>${esc((globalThis.PlatformLanguage?.text("documents","m_89f6b80ae9b0fe","Content") ?? "Content"))}</h4>${blocks.join('')}</section>`);
      const groups = new Map();
      for (const field of arrayValue(diff.fields)) {
        const key = cleanText(field.section);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(field);
      }
      for (const [section, fields] of groups) {
        const rows = fields.map((field) => {
          const path = arrayValue(field.path).map((part) => cleanText(part).replace(/_/g, ' ')).join(' › ');
          const key = arrayValue(field.path).slice(-1)[0] || section;
          const change = field.change === 'added'
            ? `<ins>${historyValue(field.after, key)}</ins>`
            : field.change === 'removed'
              ? `<del>${historyValue(field.before, key)}</del>`
              : `<del>${historyValue(field.before, key)}</del> <i class="fas fa-arrow-right"></i> <ins>${historyValue(field.after, key)}</ins>`;
          return `<div class="fmdx-hist-field">${path ? `<span class="fmdx-hist-path">${esc(path)}</span>` : ''}<span class="fmdx-hist-change">${change}</span></div>`;
        }).join('');
        parts.push(`<section><h4>${esc(historySection(section))}</h4>${rows}</section>`);
      }
      if (diff.truncated) parts.push(`<div class="fmdx-hist-note">${esc((globalThis.PlatformLanguage?.text("documents","m_060bcc38b4ed51","Only the first changes are shown.") ?? "Only the first changes are shown."))}</div>`);
      return parts.join('') || `<div class="fmdx-hist-note">${esc((globalThis.PlatformLanguage?.text("documents","m_35920add51d770","Nothing in the document changed in this version.") ?? "Nothing in the document changed in this version."))}</div>`;
    }

    async function openHistoryMenu(){
      const doc = state.doc || {};
      if (!doc.id || !api()?.revisions) return;
      await flushAllWrites().catch(() => null);
      const modal = openModal(`
        <h2><i class="fas fa-clock-rotate-left"></i> ${esc((globalThis.PlatformLanguage?.text("documents","m_3fe33cd11f8a29","History") ?? "History"))}</h2>
        <p class="fmdx-modal-sub">${esc((globalThis.PlatformLanguage?.text("documents","m_fdb6907ae482e8","Every change to this document, newest first. Pick a version to see what changed.") ?? "Every change to this document, newest first. Pick a version to see what changed."))}</p>
        <div class="fmdx-hist">
          <div class="fmdx-hist-list" data-hist-list><div class="fmdx-hist-note"><div class="fmdx-spinner" style="width:16px;height:16px;border-width:2px"></div></div></div>
          <div class="fmdx-hist-detail" data-hist-detail></div>
        </div>
        <div class="fmdx-modal-foot">
          <input class="fmdx-hist-name" data-hist-name maxlength="200" placeholder="${esc((globalThis.PlatformLanguage?.text("documents","m_3036003f9a87e7","Name this version (optional)") ?? "Name this version (optional)"))}">
          <button type="button" class="fmdx-btn" data-hist-mark><i class="fas fa-bookmark"></i> ${esc((globalThis.PlatformLanguage?.text("documents","m_9752fa609808f4","Save version") ?? "Save version"))}</button>
          <span class="spacer"></span>
          <button type="button" class="fmdx-btn primary" data-hist-done>${esc((globalThis.PlatformLanguage?.text("documents","m_8cb6b086a0e69c","Done") ?? "Done"))}</button>
        </div>`, { className: 'fmdx-history-modal' });
      const listEl = modal.body.querySelector('[data-hist-list]');
      const detailEl = modal.body.querySelector('[data-hist-detail]');
      modal.body.querySelector('[data-hist-done]').addEventListener('click', () => modal.close());
      const editable = !isReadOnlyStatus(doc.status);
      let revisions = [];
      let selected = 0;
      let compareWith = '';
      const showError = (target, error) => { target.innerHTML = `<div class="fmdx-hist-note">${esc(errorMessage(error, (globalThis.PlatformLanguage?.text("documents","m_2dfab372d45ea4","History is unavailable right now.") ?? "History is unavailable right now.")))}</div>`; };

      async function showDetail(){
        const revision = revisions.find((entry) => entry.seq === selected);
        if (!revision) { detailEl.innerHTML = ''; return; }
        const older = revisions.filter((entry) => entry.seq < revision.seq);
        const base = compareWith || (older[0] ? String(older[0].seq) : '');
        const newest = revisions[0]?.seq === revision.seq;
        const options = [
          ...older.map((entry) => `<option value="${entry.seq}" ${String(entry.seq) === base ? 'selected' : ''}>#${entry.seq} · ${esc(historyTitle(entry))} · ${esc(historyWhen(entry.updated_at))}</option>`),
          ...(newest ? [] : [`<option value="current" ${base === 'current' ? 'selected' : ''}>${esc((globalThis.PlatformLanguage?.text("documents","m_b76c509b48201b","The current document") ?? "The current document"))}</option>`])
        ].join('');
        detailEl.innerHTML = `
          <div class="fmdx-hist-head">
            <div><strong>#${revision.seq} · ${esc(historyTitle(revision))}</strong><span>${esc(historyActor(revision))} · ${esc(historyWhen(revision.updated_at))}${revision.edits > 1 ? ` · ${esc(String(revision.edits))} ${esc((globalThis.PlatformLanguage?.text("documents","m_e7d6a2abb9c654","saves") ?? "saves"))}` : ''}</span></div>
            <div class="fmdx-hist-actions">
              <button type="button" class="fmdx-btn" data-hist-view><i class="fas fa-eye"></i> ${esc((globalThis.PlatformLanguage?.text("documents","m_2b8e4c9b866e80","View") ?? "View"))}</button>
              ${editable && !newest ? `<button type="button" class="fmdx-btn" data-hist-restore><i class="fas fa-rotate-left"></i> ${esc((globalThis.PlatformLanguage?.text("documents","m_954a04d61ae9d6","Restore") ?? "Restore"))}</button>` : ''}
            </div>
          </div>
          ${options ? `<label class="fmdx-hist-compare">${esc((globalThis.PlatformLanguage?.text("documents","m_94754f592bcf0a","Changes since") ?? "Changes since"))} <select data-hist-compare>${options}</select></label>` : `<div class="fmdx-hist-note">${esc((globalThis.PlatformLanguage?.text("documents","m_44e85409fb9fb7","This is the first version in the history.") ?? "This is the first version in the history."))}</div>`}
          <div class="fmdx-hist-diff" data-hist-diff>${options ? '<div class="fmdx-hist-note"><div class="fmdx-spinner" style="width:16px;height:16px;border-width:2px"></div></div>' : ''}</div>`;
        detailEl.querySelector('[data-hist-compare]')?.addEventListener('change', (event) => { compareWith = event.currentTarget.value; showDetail(); });
        detailEl.querySelector('[data-hist-view]').addEventListener('click', async () => {
          try {
            const view = objectValue(await api().revisions.view(orgId(), doc.id, revision.seq));
            openPreview(state.doc, { title: `${firstText(doc.title, 'Document')} — #${revision.seq} ${historyTitle(revision)}`, resolved: objectValue(view.resolved) });
          } catch (error) { showToast((globalThis.PlatformLanguage?.text("documents","m_3fe33cd11f8a29","History") ?? "History"), errorMessage(error, (globalThis.PlatformLanguage?.text("documents","m_7b12830102712d","That version could not be shown.") ?? "That version could not be shown.")), false); }
        });
        detailEl.querySelector('[data-hist-restore]')?.addEventListener('click', async (event) => {
          if (!window.confirm((globalThis.PlatformLanguage?.text("documents","m_8684300865e50c","Put this version's content back? It becomes a new version; nothing in the history is lost.") ?? "Put this version's content back? It becomes a new version; nothing in the history is lost."))) return;
          event.currentTarget.disabled = true;
          try {
            const restored = objectValue(await api().revisions.restore(orgId(), doc.id, revision.seq));
            modal.close();
            showToast((globalThis.PlatformLanguage?.text("documents","m_3fe33cd11f8a29","History") ?? "History"), (globalThis.PlatformLanguage?.text("documents","m_2e72e049730ed5","The earlier version was restored.") ?? "The earlier version was restored."), true);
            if (objectValue(restored.document).id) await openDocScreen(restored.document, { manual: state.docView === 'editor' });
          } catch (error) {
            event.currentTarget.disabled = false;
            showToast((globalThis.PlatformLanguage?.text("documents","m_3fe33cd11f8a29","History") ?? "History"), errorMessage(error, (globalThis.PlatformLanguage?.text("documents","m_67d2f3e074f783","That version could not be restored.") ?? "That version could not be restored.")), false);
          }
        });
        if (!base) return;
        const diffEl = detailEl.querySelector('[data-hist-diff]');
        try {
          const result = objectValue(await api().revisions.diff(orgId(), doc.id, base, revision.seq));
          if (selected === revision.seq) diffEl.innerHTML = historyDiffHtml(objectValue(result.diff));
        } catch (error) { showError(diffEl, error); }
      }

      function renderList(){
        listEl.innerHTML = revisions.map((revision) => {
          const [icon] = historyCut(revision.cut);
          const sections = arrayValue(revision.sections).filter((key) => key !== '*').map(historySection);
          const summary = [...new Set(sections)].slice(0, 4).join(' · ');
          return `<button type="button" class="fmdx-hist-row ${revision.seq === selected ? 'active' : ''}" data-hist-seq="${revision.seq}">
            <i class="fas ${icon}"></i>
            <span><strong>${esc(historyTitle(revision))}</strong><small>${esc(historyActor(revision))} · ${esc(historyWhen(revision.updated_at))}</small>${summary ? `<small class="fmdx-hist-sections">${esc(summary)}</small>` : ''}</span>
            <em>#${revision.seq}</em>
          </button>`;
        }).join('') || `<div class="fmdx-hist-note">${esc((globalThis.PlatformLanguage?.text("documents","m_e417a816d3eaee","No history yet.") ?? "No history yet."))}</div>`;
        listEl.querySelectorAll('[data-hist-seq]').forEach((button) => button.addEventListener('click', () => {
          selected = Number(button.dataset.histSeq);
          compareWith = '';
          renderList();
          showDetail();
        }));
      }

      async function load(){
        try {
          revisions = arrayValue(objectValue(await api().revisions.list(orgId(), doc.id)).revisions).map(objectValue);
          if (!revisions.some((entry) => entry.seq === selected)) selected = revisions[0]?.seq || 0;
          renderList();
          showDetail();
        } catch (error) { showError(listEl, error); }
      }
      modal.body.querySelector('[data-hist-mark]').addEventListener('click', async (event) => {
        const input = modal.body.querySelector('[data-hist-name]');
        event.currentTarget.disabled = true;
        try {
          await api().revisions.mark(orgId(), doc.id, { label: cleanText(input.value) });
          input.value = '';
          selected = 0;
          await load();
        } catch (error) { showToast((globalThis.PlatformLanguage?.text("documents","m_3fe33cd11f8a29","History") ?? "History"), errorMessage(error, (globalThis.PlatformLanguage?.text("documents","m_fe67033c3dac77","The version could not be saved.") ?? "The version could not be saved.")), false); }
        event.currentTarget.disabled = false;
      });
      load();
    }

    function updateSaveState(){
      const el = root.querySelector('[data-fmdx-save-state]');
      if (!el) return;
      const map = {
        idle: ['', ''],
        dirty: ['dirty', 'Unsaved changes'],
        saving: ['saving', 'Saving…'],
        saved: ['saved', 'Saved'],
        error: ['error', 'Save failed — retrying'],
        conflict: ['error', 'Autosave paused — reopen this document to retry']
      };
      const [cls, text] = map[state.saveState] || map.idle;
      el.className = `fmdx-save-state ${cls}`;
      el.innerHTML = text ? `<i class="fas ${state.saveState === 'saving' ? 'fa-circle-notch fa-spin' : (state.saveState === 'saved' ? 'fa-check' : 'fa-circle')}"></i> ${esc(text)}` : '';
    }

    function editorScope(){
      const doc = state.doc || {};
      return {
        params: objectValue(doc.params),
        outputs: objectValue(doc.outputs),
        project: project(),
        customer: objectValue(project().customer),
        org: { id: orgId() }
      };
    }

    function mediaBridge(){
      const oid = orgId();
      /** The organization's photos and videos as picker items, this project's first. */
      function libraryMedia(response){
        const pid = projectId();
        const items = arrayValue(objectValue(response).media || objectValue(response).items).map(objectValue).map(libraryItem)
          .filter((item) => /^(image|video)\//i.test(firstText(item.content_type, item.mime_type)));
        const ofProject = (item) => cleanText(objectValue(item.metadata).project_id || (cleanText(objectValue(item.owner).type) === 'project' ? objectValue(item.owner).id : '')) === pid;
        return [...items.filter(ofProject), ...items.filter((item) => !ofProject(item))];
      }
      function libraryItem(item){
        return { ...item, media_id: firstText(item.media_id, item.id), label: firstText(item.label, objectValue(item.metadata).label, item.file_name, item.name) };
      }
      async function uploadAll(files){
        const uploaded = [];
        for (const file of Array.from(files || [])) {
          const result = await window.PlatformAPI.media.upload(oid, file, { ownerType: 'document', ownerId: firstText(state.doc?.id, projectId()), collection: 'documents' });
          const item = objectValue(objectValue(result).media || result);
          if (Object.keys(item).length) uploaded.push(libraryItem(item));
        }
        return uploaded;
      }
      return {
        async pick(){
          if (!window.PlatformAPI?.media?.list || !window.Portal?.PhotoFeed?.openProjectMediaPicker) throw new Error('The media tray is unavailable.');
          const media = libraryMedia(await window.PlatformAPI.media.list(oid));
          return new Promise((resolve) => {
            let complete = false;
            const finish = (value) => { if (!complete) { complete = true; resolve(value || null); } };
            window.Portal.PhotoFeed.openProjectMediaPicker({
              id: 'project-document-media-picker', title: (globalThis.PlatformLanguage?.text("documents","m_a02452f60b6418","Add Media") ?? "Add Media"),
              subtitle: (globalThis.PlatformLanguage?.text("documents","m_9dd0cc66d2569b","Choose an image or video from your media library.") ?? "Choose an image or video from your media library."),
              photos: media, getPhotos: () => media, multiple: false, imageOnly: false, accept: 'image/*,video/*',
              onConfirm: (chosen) => {
                const item = objectValue(arrayValue(chosen)[0]);
                if (!firstText(item.id, item.media_id, item.url, item.src)) return false;
                finish({ media_id: firstText(item.media_id, item.id), variant: 'original', content_type: firstText(item.content_type, item.mime_type, item.type), name: firstText(item.name, item.filename, item.label), url: firstText(item.url, item.src, item.original_url) });
                return true;
              },
              onUpload: async (files) => {
                const uploaded = await uploadAll(files);
                media.unshift(...uploaded);
                return { photos: uploaded, selectedIds: uploaded.map((item) => item.media_id).filter(Boolean) };
              },
              onClose: () => finish(null)
            });
          });
        },
        /** The same library as pick(), mounted inside the caller's element as the media.picker widget. */
        async mount(host, options){
          const opts = objectValue(options);
          const media = libraryMedia(await window.PlatformAPI.media.list(oid));
          const idOf = (item) => firstText(objectValue(item).media_id, objectValue(item).id);
          return window.FirstMateWidgets.mount(host, {
            id: 'media.picker', version: '1',
            config: { multiple: false, kind: 'image_video', prompt: (globalThis.PlatformLanguage?.text("documents","m_9dd0cc66d2569b","Choose an image or video from your media library.") ?? "Choose an image or video from your media library.") },
            ...(opts.selected ? { state: { media_ids: [opts.selected] } } : {})
          }, {
            surface: 'project',
            target: { scope: 'project', organizationId: oid, projectId: projectId() },
            data: { 'media.picker': { items: media } },
            onSize: () => opts.onResize?.(),
            onUpload: async (files) => {
              const uploaded = await uploadAll(files);
              media.unshift(...uploaded);
              return { photos: uploaded, selectedIds: uploaded.map(idOf).filter(Boolean) };
            },
            onSelect: (value, detail) => {
              const id = firstText(arrayValue(objectValue(value).media_ids)[0]);
              if (!objectValue(detail).confirmed || !id) return;
              const item = objectValue(media.find((entry) => idOf(entry) === id));
              opts.onPick?.({ media_id: id, variant: 'original', content_type: firstText(item.content_type, item.mime_type, item.type), name: firstText(item.name, item.filename, item.label), url: firstText(item.url, item.src, item.original_url) });
            }
          });
        },
        url(mediaRef, variant){
          const ref = typeof mediaRef === 'string' ? { media_id: mediaRef } : objectValue(mediaRef);
          if (ref.url) return ref.url;
          if (!window.PlatformAPI?.media?.fileUrl) return '';
          return window.PlatformAPI.media.fileUrl(oid, firstText(ref.media_id, ref.id), variant || ref.variant || 'original');
        }
      };
    }

    // Read-only rendering for signed/completed/declined/void/expired docs —
    // exactly what the customer sees, straight from the resolver.
    // A locked document is shown as the customer has it: the snapshot they
    // were sent, with their signature and payment, rendered from exactly the
    // inputs the customer portal uses (snapshotRenderOptions). Only when no
    // snapshot exists does it fall back to the live resolution.
    function mountReadOnlyCanvas(canvas){
      try { state.readonlyViewer?.destroy?.(); } catch (e) {}
      const doc = state.doc || {};
      const live = {
        document: state.resolved.resolved_definition,
        theme: state.resolved.theme,
        themeContext: { overrides: objectValue(state.resolved?.theme_vars) },
        widgetData: state.resolved.widget_data,
        widgetContext: { outputs: objectValue(doc.outputs) }
      };
      canvas.innerHTML = `<div class="fmdx-state" style="margin:20px"><div class="fmdx-spinner"></div><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_b86508131600f7","Opening document") ?? "Opening document")}</strong></div>`;
      frozenRenderOptions(doc).then((frozen) => {
        if (!canvas.isConnected || state.doc !== doc) return;
        state.readonlyViewer = mountDocViewer(canvas, { doc, initialZoom: 'page', renderOptions: frozen || live });
      });
    }

    /** The current snapshot of a sent document, or null. */
    async function currentSnapshot(doc){
      if (!doc?.id || !api()?.documents?.snapshots) return null;
      try {
        const list = arrayValue(objectValue(await api().documents.snapshots(orgId(), doc.id)).snapshots);
        const currentId = cleanText(objectValue(doc.delivery).current_snapshot_id);
        const snapshot = objectValue(list.find((entry) => cleanText(entry.id) === currentId) || list[list.length - 1]);
        return snapshot.resolved_definition ? snapshot : null;
      } catch (error) {
        return null;
      }
    }
    async function frozenRenderOptions(doc){
      const snapshot = await currentSnapshot(doc);
      return snapshot ? snapshotRenderOptions(snapshot) : null;
    }
    /** Render inputs for a snapshot: the same ones the customer portal uses,
     *  so both show the identical document (theme_vars are fully resolved,
     *  branding and overrides included, when the snapshot is made). */
    function snapshotRenderOptions(snapshot){
      return {
        document: snapshot.resolved_definition,
        theme: snapshot.theme || null,
        themeContext: { overrides: objectValue(snapshot.theme_vars) },
        widgetData: objectValue(snapshot.widget_data),
        widgetContext: { outputs: objectValue(snapshot.outputs) }
      };
    }

    /**
     * A rendered document with its view controls floating top left: zoom out,
     * Fit (the whole page), zoom in, fit width, print and download. Shared by
     * the locked document view and Preview; Preview passes onClose for its X.
     */
    function mountDocViewer(host, options = {}){
      const doc = objectValue(options.doc);
      const renderOptions = objectValue(options.renderOptions);
      if (!window.FMDocRenderer?.render) {
        host.innerHTML = `<div class="fmdx-state" style="margin:20px"><i class="fas fa-eye-slash"></i><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_fc865c9558abcb","Preview unavailable") ?? "Preview unavailable")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_97e3a8c68504bb","The document renderer library is not loaded.") ?? "The document renderer library is not loaded.")}</span></div>`;
        return { destroy(){} };
      }
      host.innerHTML = `
        <div class="fmdx-viewer-scroll" data-viewer-scroll><div class="fmdx-viewer-stage" data-viewer-stage></div></div>
        <div class="fmdx-viewer-tools" role="toolbar" aria-label="View">
          <button type="button" data-viewer-zoom-out title="Zoom out" aria-label="Zoom out"><i class="fas fa-minus"></i></button>
          <button type="button" class="fmdx-viewer-fit" data-viewer-fit title="Fit the page">Fit</button>
          <button type="button" data-viewer-zoom-in title="Zoom in" aria-label="Zoom in"><i class="fas fa-plus"></i></button>
          <button type="button" data-viewer-width title="Fit width" aria-label="Fit width"><i class="fas fa-arrows-left-right"></i></button>
          <span class="fmdx-viewer-sep" aria-hidden="true"></span>
          <button type="button" data-viewer-print title="Print" aria-label="Print"><i class="fas fa-print"></i></button>
          ${doc.id ? '<button type="button" data-viewer-download title="Download PDF" aria-label="Download PDF"><i class="fas fa-download"></i></button>' : ''}
        </div>
        ${options.onClose ? '<button type="button" class="fmdx-viewer-close" data-viewer-close title="Close" aria-label="Close"><i class="fas fa-xmark"></i></button>' : ''}`;
      const scroll = host.querySelector('[data-viewer-scroll]');
      const stage = host.querySelector('[data-viewer-stage]');
      const fitButton = host.querySelector('[data-viewer-fit]');
      const widthButton = host.querySelector('[data-viewer-width]');
      const dims = window.FMDocModel?.paperDimensions?.(objectValue(renderOptions.document)) || { w_pt: 612, h_pt: 792 };
      const pageWidth = dims.w_pt * (96 / 72);
      const pageHeight = (dims.h_pt || 792) * (96 / 72);
      let zoom = options.initialZoom || 'width'; // 'width' | 'page' | a scale
      let handle = null;
      let lastScale = 0;
      const scaleFor = (mode) => {
        const byWidth = Math.min(1.6, Math.max(0.2, (scroll.clientWidth - 48) / pageWidth));
        if (mode === 'width') return byWidth;
        if (mode === 'page') return Math.min(byWidth, Math.max(0.2, (scroll.clientHeight - 56) / pageHeight));
        return mode;
      };
      const render = () => {
        const scale = scaleFor(zoom);
        fitButton.textContent = zoom === 'page' ? 'Fit' : `${Math.round(scale * 100)}%`;
        fitButton.classList.toggle('active', zoom === 'page');
        widthButton.classList.toggle('active', zoom === 'width');
        if (handle && Math.abs(scale - lastScale) < 0.002) return;
        lastScale = scale;
        try { handle?.destroy?.(); } catch (e) {}
        stage.innerHTML = '';
        try {
          handle = window.FMDocRenderer.render(stage, { ...renderOptions, mode: 'static', scale }) || {};
        } catch (error) {
          stage.innerHTML = `<div class="fmdx-state" style="margin:20px"><i class="fas fa-triangle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_315a295c7205d8","Render failed") ?? "Render failed")}</strong><span>${String(esc(errorMessage(error, '')))}</span></div>`;
        }
      };
      const step = (delta) => { zoom = Math.min(2.5, Math.max(0.25, scaleFor(zoom) + delta)); render(); };
      host.querySelector('[data-viewer-zoom-out]').addEventListener('click', () => step(-0.15));
      host.querySelector('[data-viewer-zoom-in]').addEventListener('click', () => step(0.15));
      fitButton.addEventListener('click', () => { zoom = 'page'; render(); });
      widthButton.addEventListener('click', () => { zoom = 'width'; render(); });
      host.querySelector('[data-viewer-print]').addEventListener('click', () => printRenderedDocument(renderOptions));
      host.querySelector('[data-viewer-download]')?.addEventListener('click', (event) => downloadPdf(doc, event.currentTarget));
      host.querySelector('[data-viewer-close]')?.addEventListener('click', () => options.onClose());
      // A fitted view follows the space it has.
      const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (typeof zoom === 'string') render(); }) : null;
      resize?.observe(scroll);
      render();
      return {
        destroy(){ resize?.disconnect(); try { handle?.destroy?.(); } catch (e) {} }
      };
    }

    /** Print a document at full size, on its own, then tidy up. */
    function printRenderedDocument(renderOptions){
      const sheet = document.createElement('div');
      sheet.className = 'fmdx-print-sheet';
      document.body.appendChild(sheet);
      let handle = null;
      try { handle = window.FMDocRenderer.render(sheet, { ...renderOptions, mode: 'static', scale: 1 }); }
      catch (error) { sheet.remove(); showToast('Print', errorMessage(error, 'Could not prepare the document for printing.'), false); return; }
      document.body.classList.add('fmdx-print-mode');
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        document.body.classList.remove('fmdx-print-mode');
        window.removeEventListener('afterprint', done);
        try { handle?.destroy?.(); } catch (e) {}
        sheet.remove();
      };
      window.addEventListener('afterprint', done);
      // Let images in the sheet start loading before the print dialog opens.
      setTimeout(() => { window.print(); setTimeout(done, 1500); }, 120);
    }

    function mountEditorCanvas(){
      const canvas = root.querySelector('[data-fmdx-canvas]');
      if (!canvas || !state.resolved) return;
      if (isReadOnlyStatus(state.doc?.status)) { mountReadOnlyCanvas(canvas); return; }
      if (!window.FMDocEditor?.mount) {
        canvas.innerHTML = `<div class="fmdx-state" style="margin:20px"><i class="fas fa-pen-ruler"></i><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_d08399aef41777","Editor unavailable") ?? "Editor unavailable")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_ef10e4987f32bc","The document editor library is not loaded. You can still preview, send, and download this document.") ?? "The document editor library is not loaded. You can still preview, send, and download this document.")}</span></div>`;
        return;
      }
      canvas.innerHTML = '';
      const workingDefinition = objectValue(state.working).definition || state.resolved.resolved_definition;
      const fromTemplate = objectValue(state.working).fromTemplate === true;
      try {
        // Shared visual-editor chrome: instance documents open in Doc mode
        // (chrome hidden); switching to Visual gets the same rail/panels as
        // the Web Editor, applied to the document.
        const mountEditor = window.FMVisualEditor?.mount || window.FMDocEditor.mount;
        const chromeOpts = window.FMVisualEditor?.mount ? { chrome: {
          contentKind: 'document',
          orgId: window.Portal?.cfg?.orgId || undefined,
          upload: { ownerType: 'document', ownerId: firstText(state.doc?.id, 'document'), collection: 'documents' }
        } } : {};
        state.editorHandle = mountEditor(canvas, {
          ...chromeOpts,
          document: clone(workingDefinition),
          theme: state.resolved.theme,
          themeContext: { branding: objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding), overrides: { ...objectValue(state.resolved?.theme_vars), ...objectValue(state.doc?.theme_overrides) } },
          profile: 'document',
          // Documents open in the word-processor surface by default; the
          // in-editor mode control switches to Visual (Canva) or Preview.
          mode: 'doc',
          allowedModes: designerAllowed() ? ['doc', 'visual', 'preview'] : ['doc', 'preview'],
          agentEnabled: capabilityEnabled('documents.agent'),
          editPolicy: editPolicyFor(workingDefinition),
          widgetData: state.resolved.widget_data,
          resolveScope: objectValue(state.resolved.scope).params ? state.resolved.scope : editorScope(),
          // Instances open with resolved data showing (templates keep raw
          // {{tokens}} — studio does not pass this).
          dataPreview: true,
          catalog: state.catalog,
          collaboration: { actor: objectValue(window.Portal?.util?.currentActor?.()) },
          // Document history for Tools ▸ Compare; the History button opens the
          // documents History panel (documentActions.versions).
          versionsApi: state.doc?.id && window.DocumentsAPI?.revisions ? {
            list: async () => ({ checkpoints: arrayValue(objectValue(await window.DocumentsAPI.revisions.list(orgId(), state.doc.id)).revisions).map((row) => ({ id: String(row.seq), name: cleanText(row.label) || `#${row.seq}`, reason: row.cut, created_at: row.updated_at })) }),
            get: async (seq) => ({ definition: objectValue(await window.DocumentsAPI.revisions.get(orgId(), state.doc.id, seq)).definition }),
            create: (body) => window.DocumentsAPI.revisions.mark(orgId(), state.doc.id, { label: cleanText(objectValue(body).name) }),
            diff: async (a, b) => ({ diff: objectValue(objectValue(objectValue(await window.DocumentsAPI.revisions.diff(orgId(), state.doc.id, a, b)).diff).content) })
          } : null,
          // Phase-1 realtime collaboration (presence + serialized command log).
          collab: state.doc?.id && window.DocumentsAPI?.collab ? {
            actor: objectValue(window.Portal?.util?.currentActor?.()),
            connect: (handlers) => window.DocumentsAPI.collab.connect(state.doc.id, handlers, orgId())
          } : null,
          documentActions: {
            new: () => { closeDocScreen(); openCreateModal({}); },
            open: () => closeDocScreen(),
            copy: async () => {
              await flushAllWrites();
              const source = state.doc || {};
              const res = await createDocumentRecord({ document_type: source.document_type, template_id: objectValue(source.template_ref).template_id || null, template_version: objectValue(source.template_ref).version || undefined, workflow_id: objectValue(source.workflow_ref).workflow_id || null, title: ((v0) => globalThis.PlatformLanguage?.text("documents","m_69a8e411deda5e",`${v0} (copy)`,{v0}) ?? `${v0} (copy)`)(firstText(source.title, 'Document')), params: clone(objectValue(source.params)), theme_ref: clone(objectValue(source.theme_ref)) });
              const created = objectValue(res.document || res.doc || res);
              rememberStandaloneDoc(created);
              showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_a571fd03354b1f","Copy created.") ?? "Copy created."), true);
              if (created.id) openDocScreen(created);
            },
            share: async () => {
              const data = { title: firstText(state.doc?.title, 'Document'), url: window.location.href };
              if (navigator.share) await navigator.share(data);
              else { await navigator.clipboard?.writeText?.(data.url); showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_83b3cddc831f9d","Document link copied.") ?? "Document link copied."), true); }
            },
            email: async () => { await flushAllWrites(); openSendModal(state.doc); },
            download: async ({ format = 'pdf', document: documentDef } = {}) => { await flushAllWrites(); if (format === 'pdf') downloadPdf(state.doc, null); else downloadDocumentData(documentDef || objectValue(state.working).definition, format, state.doc?.title); },
            rename: () => { const input = root.querySelector('[data-fmdx-title]'); input?.focus(); input?.select(); },
            versions: () => { const anchor = root.querySelector('[data-fmdx-history]'); if (anchor) openHistoryMenu(anchor); },
            trash: async () => {
              const confirmed = window.Portal?.ui?.confirm ? await window.Portal.ui.confirm(((v0) => globalThis.PlatformLanguage?.text("documents","m_374f3cd66d87e4",`Move "${v0}" to trash?`,{v0}) ?? `Move "${v0}" to trash?`)(firstText(state.doc?.title, 'this document'))) : window.confirm((globalThis.PlatformLanguage?.text("documents","m_4f4fab5c316170","Move this document to trash?") ?? "Move this document to trash?"));
              if (!confirmed) return;
              await api().documents.archive(orgId(), state.doc.id);
              showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_f7c00219137166","Document moved to trash.") ?? "Document moved to trash."), true);
              closeDocScreen();
            },
            agent: ({ task } = {}) => {
              setDataPanelOpen(true);
              setTrayTab('agent');
              if (firstText(task)) state.docAgent?.send?.(task);
            }
          },
          media: mediaBridge(),
          onDictate: () => transcribeDocumentDictation(orgId(), state.doc?.title),
          onChange: (docModel) => {
            state.workingDoc = docModel;
            state.dirty = true;
            if (state.saveState !== 'saving') { state.saveState = 'dirty'; updateSaveState(); }
            scheduleAutosave();
          },
          onCommand: (cmd) => queueEditorCommand(cmd),
          onRequestData: (kind, cb) => {
            if (kind === 'scope_items') openPricebookPicker({ onDone: (items) => cb?.(items) });
          }
        });
        state.mountedEditorDocumentId = cleanText(state.doc?.id);
        restoreDocumentViewport();
        // Line-items affordance (§bug 3): selection chip + double-click.
        try { state.editorHandle.on?.('selection', (ids) => updateLineItemsChip(ids)); } catch (e) { /* optional */ }
        if (canvas.dataset.fmdxDblBound !== '1') {
          canvas.dataset.fmdxDblBound = '1';
          canvas.addEventListener('dblclick', () => {
            const ids = state.editorHandle?.selection?.() || [];
            if (selectedLineItemsNode(ids)) openScopeItemsSection();
          });
        }
        if (!fromTemplate) {
          canvas.insertAdjacentHTML('afterbegin', `<div class="fmdx-float-note"><i class="fas fa-circle-info"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_c8553a97311096"," Editing a resolved copy — the source template could not be loaded, so data bindings are baked in for this session.") ?? " Editing a resolved copy — the source template could not be loaded, so data bindings are baked in for this session.")}</div>`);
        }
      } catch (error) {
        console.warn('FMDocEditor mount failed', error);
        canvas.innerHTML = `<div class="fmdx-state" style="margin:20px"><i class="fas fa-triangle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_61445ee660b4e6","Editor failed to start") ?? "Editor failed to start")}</strong><span>${String(esc(errorMessage(error, '')))}</span></div>`;
      }
      // Dock the Data tray under the editor's toolbar row (owner bug #1).
      syncTrayOffset();
      setTimeout(() => syncTrayOffset(), 80);
    }

    // Accumulate command→override ops (collapsing consecutive same-target
    // sets) so autosave PATCHes an append-only op log, not document blobs.
    function queueEditorCommand(cmd){
      if (isReadOnlyStatus(state.doc?.status)) return;
      const ops = commandToOps(cmd, state.editorHandle, state.workingDoc);
      if (!ops.length) return;
      for (const op of ops) {
        if (state.pendingOps.length && sameSetTarget(state.pendingOps[state.pendingOps.length - 1], op)) {
          state.pendingOps[state.pendingOps.length - 1] = op;
        } else {
          state.pendingOps.push(op);
        }
      }
      state.dirty = true;
      if (state.saveState !== 'saving') { state.saveState = 'dirty'; updateSaveState(); }
      scheduleAutosave();
    }

    // Autosave. Preferred path: the editor's command stream, mapped 1:1 onto
    // override ops (queueEditorCommand), APPENDED to the instance's existing
    // override log and PATCHed with expected_revision. Fallback path (an
    // editor build without onCommand): a coarse-but-correct whole-document
    // doc.set snapshot from the working copy. Conflicts rebase optimistically:
    // re-GET the record, replay unsent ops on the fresh override log, retry.
    function scheduleAutosave(){
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => { flushAutosave(); }, 1200);
    }

    function coarseOverrideOps(docModel){
      const ops = [];
      if (docModel?.pages) ops.push({ op: 'doc.set', prop: 'pages', value: docModel.pages });
      if (docModel?.root) ops.push({ op: 'doc.set', prop: 'root', value: docModel.root });
      if (docModel?.settings) ops.push({ op: 'doc.set', prop: 'settings', value: docModel.settings });
      return ops;
    }

    async function flushAutosave(){
      clearTimeout(state.saveTimer);
      state.saveTimer = 0;
      if (!state.doc?.id || state.saving || isReadOnlyStatus(state.doc.status)) return;
      if (!state.pendingOps.length && !state.dirty) return;
      const usingCommandOps = state.pendingOps.length > 0;
      let sending = [];
      let batch = [];
      if (usingCommandOps) {
        sending = state.pendingOps.splice(0, state.pendingOps.length);
        batch = collapseOps([...state.baseOverrides, ...sending]);
      } else if (state.workingDoc) {
        batch = coarseOverrideOps(state.workingDoc);
        if (!batch.length) { state.dirty = false; updateSaveState(); return; }
      } else {
        state.dirty = false;
        updateSaveState();
        return;
      }
      state.saving = true;
      state.saveState = 'saving';
      updateSaveState();
      try {
        const res = await api().documents.patch(orgId(), state.doc.id, {
          overrides: batch,
          expected_revision: Number(state.doc.revision || 0) || undefined
        });
        const updated = objectValue(res.document || res.doc);
        if (updated.id) state.doc = { ...state.doc, ...updated };
        state.baseOverrides = batch;
        state.saveFailures = 0;
        state.dirty = state.pendingOps.length > 0;
        state.saveState = state.dirty ? 'dirty' : 'saved';
      } catch (error) {
        if (usingCommandOps) state.pendingOps = [...sending, ...state.pendingOps];
        state.saveFailures += 1;
        if (Number(error?.status) === 409) {
          // Someone else advanced the revision — rebase on their overrides and
          // retry with ours replayed on top.
          try {
            const freshRes = await api().documents.get(orgId(), state.doc.id);
            const fresh = objectValue(freshRes.document || freshRes.doc || freshRes);
            if (fresh.id) {
              state.doc = { ...state.doc, ...fresh };
              state.baseOverrides = arrayValue(fresh.overrides).map((op) => clone(op));
            }
          } catch (refreshError) {
            console.warn('Conflict rebase failed', refreshError);
          }
        }
        state.dirty = true;
        if (state.saveFailures >= 5) {
          state.saveState = 'conflict';
          showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_98b208db341db5","Autosave keeps failing — check your connection, then reopen this document.") ?? "Autosave keeps failing — check your connection, then reopen this document."), false);
        } else {
          state.saveState = 'error';
          scheduleAutosave();
        }
      } finally {
        state.saving = false;
        updateSaveState();
        if ((state.dirty || state.pendingOps.length) && !state.saveTimer && state.saveState !== 'conflict') scheduleAutosave();
      }
    }

    // Re-resolve the instance and remount the editor so bound values (params,
    // widget data) refresh live after a data change.
    async function refreshResolvedEditor(){
      // Editor never loaded (e.g. theme changed from the workflow view): the
      // next switch to editor view resolves fresh anyway — nothing to remount.
      if (!state.editorLoaded) return;
      try {
        const res = await api().documents.resolve(orgId(), state.doc.id);
        if (state.destroyed || state.view !== 'editor') return;
        state.resolved = objectValue(res);
        captureResolvedTotal(state.resolved);
        renderDocCard();
        state.baseOverrides = arrayValue(state.doc?.overrides).map((op) => clone(op));
        state.pendingOps = [];
        state.working = isReadOnlyStatus(state.doc?.status) ? null : await instanceWorkingDefinition();
        if (state.destroyed || state.view !== 'editor') return;
        destroyEditor();
        state.dirty = false;
        state.saveState = 'saved';
        updateSaveState();
        mountEditorCanvas();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not refresh the document.'), false);
      }
    }

    // ---------------------------------------------------------- data panel
    /** ONE open/close path for the Data drawer (§bug 2): the toolbar toggle,
     *  the drawer's X, and the line-items chip all go through here, so the
     *  editor inspector (hidden while data-open) is always restored. */
    function setDataPanelOpen(open){
      state.dataPanelOpen = !!open;
      root.querySelector('[data-fmdx-data-toggle]')?.classList.toggle('active', state.dataPanelOpen);
      root.querySelector('[data-fmdx-data-panel]')?.classList.toggle('collapsed', !state.dataPanelOpen);
      root.querySelector('[data-fmdx-editor-screen]')?.classList.toggle('data-open', state.dataPanelOpen);
      syncTrayOffset();
      // The tray pushes the canvas (flex sibling) — refit so the page stays
      // centered in the remaining width instead of hanging off one side.
      setTimeout(() => { try { state.editorHandle?.zoom?.('fit-width'); } catch (e) {} }, 60);
    }

    /** Owner bug #1: the Data tray used to sit flush with the screen top and
     *  cover the editor's own toolbar row (zoom/page controls). Offset the
     *  tray below that row by measuring the mounted editor's .fmde-toolbar
     *  height (recomputed on window resize; 0 when no editor is mounted). */
    function syncTrayOffset(){
      const panel = root.querySelector('[data-fmdx-data-panel]');
      if (!panel) return;
      let offset = 0;
      if (state.docView === 'editor') {
        try {
          const toolbar = root.querySelector('[data-fmdx-canvas] .fmde-toolbar');
          if (toolbar) offset = Math.round(toolbar.getBoundingClientRect().height);
        } catch (e) { offset = 0; }
      }
      panel.style.marginTop = offset > 0 ? `${offset}px` : '';
      panel.classList.toggle('below-toolbar', offset > 0);
    }

    // §bug 3: selecting a doc.line_items widget surfaces an "Edit line items"
    // chip that opens the Data drawer scrolled to the scope-items section.
    function selectedLineItemsNode(ids){
      const list = arrayValue(ids);
      if (list.length !== 1) return null;
      const FM = window.FMDocModel;
      const doc = state.workingDoc || (state.editorHandle?.getDocument ? state.editorHandle.getDocument() : null);
      if (!doc || !FM?.findNode) return null;
      const found = FM.findNode(doc, list[0]);
      const node = objectValue(found?.node);
      if (cleanText(node.type) !== 'widget') return null;
      const widgetId = cleanText(objectValue(node.props).widget).split('@')[0];
      return widgetId === 'doc.line_items' ? node : null;
    }

    function updateLineItemsChip(ids){
      const canvas = root.querySelector('[data-fmdx-canvas]');
      if (!canvas) return;
      const existing = canvas.querySelector('[data-fmdx-li-chip]');
      if (isReadOnlyStatus(state.doc?.status) || !selectedLineItemsNode(ids)) {
        existing?.remove();
        return;
      }
      if (existing) return;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'fmdx-selection-chip';
      chip.setAttribute('data-fmdx-li-chip', '1');
      chip.innerHTML = '<i class="fas fa-table-list"></i> Edit line items';
      chip.addEventListener('click', () => openScopeItemsSection());
      canvas.appendChild(chip);
    }

    function openScopeItemsSection(){
      state.forceScopeSection = true;
      setDataPanelOpen(true);
      setTrayTab('data');
      const panel = root.querySelector('[data-fmdx-data-panel]');
      if (!panel) return;
      if (!panel.querySelector('[data-scope-editor-for]')) renderDataPanel();
      const holder = panel.querySelector('[data-scope-editor-for]');
      const field = holder?.closest('.fmdx-field') || holder;
      if (!field) return;
      // Wait a beat for the drawer slide-in, then scroll + flash-highlight.
      setTimeout(() => {
        try { field.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { field.scrollIntoView(); }
        field.classList.remove('fmdx-flash');
        void field.offsetWidth;
        field.classList.add('fmdx-flash');
        setTimeout(() => field.classList.remove('fmdx-flash'), 1900);
      }, 180);
    }

    function instanceParamDefs(){
      const doc = state.doc || {};
      const fromInstance = objectValue(doc.param_defs);
      if (Object.keys(fromInstance).length) return fromInstance;
      const catalogType = arrayValue(state.catalog?.types).find((t) => firstText(t.id, t.type) === cleanText(doc.document_type));
      return objectValue(catalogType?.param_schema);
    }

    function renderDataPanel(){
      const panel = root.querySelector('[data-fmdx-data-panel]');
      if (!panel || !state.doc) return;
      const pane = panel.querySelector('[data-fmdx-tray-data]') || panel;
      const defs = instanceParamDefs();
      const params = objectValue(state.doc.params);
      const entries = Object.entries(defs);
      const scopeEditors = new Map();
      // Always offer a scope_items section for project docs even when the
      // schema omits it — the roofing flow stores line items there.
      const hasScopeParam = entries.some(([key, def]) => isScopeItemsParam(key, objectValue(def)));
      const extraScope = !hasScopeParam && (Array.isArray(params.scope_items) || state.forceScopeSection === true);
      pane.innerHTML = `
        <div class="fmdx-data-head">
          <strong><i class="fas fa-database"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_afc71019d2978d"," Data") ?? " Data")}</strong>
          <button type="button" class="fmdx-icon-btn" data-data-close title="${(globalThis.PlatformLanguage?.htmlText("documents","m_2c2a1aeb49b92d","Hide panel") ?? "Hide panel")}"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="fmdx-data-body" data-data-fields>
          ${String(entries.length || extraScope ? '' : `<p class="fmdx-data-hint">${(globalThis.PlatformLanguage?.htmlText("documents","m_1c093aace018f2","This document has no data inputs. Params defined on its template will appear here.") ?? "This document has no data inputs. Params defined on its template will appear here.")}</p>`)}
          ${String(entries.map(([key, def]) => paramFieldHtml(key, objectValue(def), params[key], { project: project() })).join(''))}
          ${String(extraScope ? paramFieldHtml('scope_items', { type: 'list', items: { type: 'pricebook_line' }, label: (globalThis.PlatformLanguage?.htmlText("documents","m_3b9617d28d534e","Scope line items") ?? "Scope line items") }, params.scope_items, { project: project() }) : '')}
          <p class="fmdx-data-hint">${(globalThis.PlatformLanguage?.htmlText("documents","m_081725d329b5ee","Values here feed the document’s bound fields and widgets — line items, totals, customer info — wherever the template references them.") ?? "Values here feed the document’s bound fields and widgets — line items, totals, customer info — wherever the template references them.")}</p>
        </div>
        <div class="fmdx-data-foot">
          <button type="button" class="fmdx-btn primary" data-data-save><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_f88972b3f98242"," Save & refresh") ?? " Save & refresh")}</button>
        </div>`;
      let richHandles = new Map();
      panel.querySelectorAll('[data-scope-editor-for]').forEach((holder) => {
        const key = holder.dataset.scopeEditorFor;
        scopeEditors.set(key, mountScopeEditor(holder, arrayValue(params[key]).map(normalizeScopeItem), {
          onScopeWorkflow: (scope) => {
            const measurements = objectValue(scope.measurements);
            const measHolder = panel.querySelector('[data-rich-param-for][data-rich-kind="measurements"]');
            if (measHolder && Object.keys(measurements).length) richParamState(measHolder).write(measurements);
            richHandles.forEach((handle) => handle?.rerender?.());
          }
        }));
      });
      richHandles = mountRichParamEditors(panel, {
        project: project(),
        orgId: orgId(),
        getScopeItems: () => {
          for (const editor of scopeEditors.values()) return editor.getItems();
          return arrayValue(params.scope_items);
        }
      });
      panel.querySelector('[data-data-close]')?.addEventListener('click', () => setDataPanelOpen(false));
      panel.querySelector('[data-data-save]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await flushAutosave();
          const values = collectParamValues(panel.querySelector('[data-data-fields]'), defs, scopeEditors);
          const res = await api().documents.patch(orgId(), state.doc.id, {
            params: { ...params, ...values },
            expected_revision: Number(state.doc.revision || 0) || undefined
          });
          const updated = objectValue(res.document || res.doc);
          if (updated.id) state.doc = { ...state.doc, ...updated };
          else state.doc = { ...state.doc, params: { ...params, ...values } };
          showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_c60565e4d90e99","Data saved.") ?? "Data saved."), true);
          await refreshResolvedEditor();
          renderDataPanel();
          try { state.workflowHandle?.refreshPreview?.(); } catch (e) {}
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), errorMessage(error, 'Could not save the data.'), false);
        } finally {
          button.disabled = false;
        }
      });
    }

    // ===================================================== scope line items
    function mountScopeEditor(holder, initialItems = [], hooks = {}){
      let items = arrayValue(initialItems).map(normalizeScopeItem);
      holder.classList.add('fmdx-scope-editor');

      // Media services for the shared attach popover (FMDocWorkflow.openMediaAttach)
      // — same project-photo bridge workflowServices() hands the stepper.
      const attachMediaServices = {
        media: {
          photos: () => projectPhotoRefs(project()).map((photo) => ({
            ...photo,
            url: window.PlatformAPI?.media?.thumbnailUrl?.(orgId(), photo.media_id, 320) || ''
          })),
          url: (mediaId) => window.PlatformAPI?.media?.thumbnailUrl?.(orgId(), mediaId, 320) || ''
        }
      };
      // Attached photo/video indicator (item.media[0] / item.video —
      // persisted with params.scope_items, rendered by doc.line_items).
      function attachThumbHtml(item){
        const entry = objectValue(arrayValue(item.media)[0]);
        const hasVideo = !!firstText(objectValue(item.video).url);
        let url = firstText(entry.url);
        if (!url && firstText(entry.media_id)) url = window.PlatformAPI?.media?.thumbnailUrl?.(orgId(), entry.media_id, 160) || '';
        if (url) return `<span class="fmdx-scope-thumb" title="${esc(firstText(entry.caption, 'Attached photo'))}"><img src="${esc(url)}" alt=""></span>`;
        if (firstText(entry.media_id) || hasVideo) return `<span class="fmdx-scope-thumb video"><i class="fas ${hasVideo ? 'fa-circle-play' : 'fa-image'}"></i></span>`;
        return '';
      }
      const itemHasAttachment = (item) => arrayValue(item.media).length > 0 || !!firstText(objectValue(item.video).url);

      function renderRows(){
        const rows = [];
        const pushRow = (item, depth) => {
          rows.push(`
            <div class="fmdx-scope-row ${String(depth ? 'child' : '')}" data-scope-id="${String(esc(item.id))}">
              <div class="fmdx-scope-name">
                <span class="fmdx-scope-name-line">
                  ${String(attachThumbHtml(item))}
                  <strong>${String(esc(firstText(item.display_name, item.name, 'Line item')))}</strong>
                </span>
                ${String(item.description ? `<small>${esc(item.description)}</small>` : (item.included ? `<small>${(globalThis.PlatformLanguage?.htmlText("documents","m_f02be43cb91cd2","Included") ?? "Included")}</small>` : ''))}
              </div>
              <input class="qty" type="number" step="any" min="0" value="${String(esc(item.quantity))}" data-scope-qty title="${(globalThis.PlatformLanguage?.htmlText("documents","m_9c689ddee2f502","Quantity") ?? "Quantity")}">
              <span class="unit">${String(esc(item.unit || 'ea'))}</span>
              <input type="number" step="0.01" min="0" value="${String(esc(Number(item.unit_price || 0).toFixed(2)))}" data-scope-price title="${(globalThis.PlatformLanguage?.htmlText("documents","m_c68827ddeaf565","Unit price ($)") ?? "Unit price ($)")}">
              <button type="button" class="fmdx-icon-btn ${String(itemHasAttachment(item) ? 'has-media' : '')}" data-scope-attach title="${(globalThis.PlatformLanguage?.htmlText("documents","m_74c8aa88118d1c","Attach photo or video") ?? "Attach photo or video")}"><i class="fas fa-camera"></i></button>
              <button type="button" class="fmdx-icon-btn danger" data-scope-remove title="${(globalThis.PlatformLanguage?.htmlText("documents","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-xmark"></i></button>
            </div>`);
          arrayValue(item.children).forEach((child) => pushRow(child, depth + 1));
        };
        items.forEach((item) => pushRow(item, 0));
        holder.innerHTML = `
          <div class="fmdx-scope-toolbar">
            <button type="button" class="fmdx-btn" data-scope-load><i class="fas fa-clipboard-list"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_f3cabca64844e0"," Load from scope") ?? " Load from scope")}</button>
            <button type="button" class="fmdx-btn" data-scope-pricebook><i class="fas fa-book-open"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_c38fcf1b64a2ea"," Pricebook") ?? " Pricebook")}</button>
            <button type="button" class="fmdx-btn" data-scope-manual><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_8e13db264d4c9f"," Add row") ?? " Add row")}</button>
          </div>
          <div class="fmdx-scope-list">
            ${String(rows.length ? rows.join('') : `<div class="fmdx-scope-empty">${(globalThis.PlatformLanguage?.htmlText("documents","m_aded42d45a9ae8","No line items yet. Load them from the project scope, pick from the pricebook, or add a row.") ?? "No line items yet. Load them from the project scope, pick from the pricebook, or add a row.")}</div>`)}
          </div>
          ${String(rows.length ? `<div class="fmdx-scope-total"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_9403c7637d4905","Total") ?? "Total")}</span> ${esc(moneyFromDollars(scopeItemsTotal(items)))}</div>` : '')}`;
        bindRows();
      }

      function findItem(list, id){
        for (const item of arrayValue(list)) {
          if (item.id === id) return { item, list };
          const found = findItem(item.children, id);
          if (found) return found;
        }
        return null;
      }

      function bindRows(){
        holder.querySelectorAll('[data-scope-id]').forEach((row) => {
          const id = row.dataset.scopeId;
          row.querySelector('[data-scope-qty]')?.addEventListener('change', (event) => {
            const found = findItem(items, id);
            if (found) { found.item.quantity = String(Math.max(0, Number(event.target.value || 0))); renderRows(); }
          });
          row.querySelector('[data-scope-price]')?.addEventListener('change', (event) => {
            const found = findItem(items, id);
            if (found) { found.item.unit_price = Math.max(0, Number(event.target.value || 0)); renderRows(); }
          });
          row.querySelector('[data-scope-remove]')?.addEventListener('click', () => {
            const found = findItem(items, id);
            if (found) { found.list.splice(found.list.indexOf(found.item), 1); renderRows(); }
          });
          row.querySelector('[data-scope-attach]')?.addEventListener('click', async (event) => {
            const button = event.currentTarget;
            const found = findItem(items, id);
            if (!found) return;
            // The popover lives in the workflow runtime — lazy-load it the
            // first time (same script mountWorkflowHost pulls in).
            const runtime = window.FMDocWorkflow?.openMediaAttach ? window.FMDocWorkflow : await ensureWorkflowRuntime();
            if (!runtime?.openMediaAttach) {
              showToast((globalThis.PlatformLanguage?.text("documents","m_49e775f365e4e6","Media") ?? "Media"), (globalThis.PlatformLanguage?.text("documents","m_941ad0eeacdd91","The media attach editor could not be loaded.") ?? "The media attach editor could not be loaded."), false);
              return;
            }
            runtime.openMediaAttach({
              anchor: button,
              item: found.item,
              services: attachMediaServices,
              onSave: (patch) => {
                const applied = objectValue(patch);
                found.item.media = arrayValue(applied.media);
                found.item.video = applied.video && firstText(objectValue(applied.video).url) ? applied.video : null;
                found.item.display = cleanText(applied.display) === 'popup' ? 'popup' : 'inline';
                renderRows();
              }
            });
          });
        });
        holder.querySelector('[data-scope-load]')?.addEventListener('click', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const loaded = await loadScopeFromProject();
            if (!loaded.length) { showToast((globalThis.PlatformLanguage?.text("documents","m_9d3e82ecfd10ec","Scope") ?? "Scope"), (globalThis.PlatformLanguage?.text("documents","m_bd5b322492b17f","No scope line items were found on this project’s proposals.") ?? "No scope line items were found on this project’s proposals."), false); return; }
            items = loaded.map(normalizeScopeItem);
            renderRows();
            showToast((globalThis.PlatformLanguage?.text("documents","m_9d3e82ecfd10ec","Scope") ?? "Scope"), ((v0,v1) => globalThis.PlatformLanguage?.text("documents","m_f71f7a7671c20d",`Loaded ${v0} line item${v1} from the project scope.`,{v0,v1}) ?? `Loaded ${v0} line item${v1} from the project scope.`)(loaded.length,loaded.length === 1 ? '' : 's'), true);
          } finally { button.disabled = false; }
        });
        holder.querySelector('[data-scope-pricebook]')?.addEventListener('click', () => {
          openPricebookPicker({ onDone: (picked) => { items = [...items, ...picked.map(normalizeScopeItem)]; renderRows(); } });
        });
        holder.querySelector('[data-scope-manual]')?.addEventListener('click', () => {
          const name = window.prompt((globalThis.PlatformLanguage?.text("documents","m_eea3c1be9ead94","Line item name") ?? "Line item name"));
          if (!cleanText(name)) return;
          items.push(makeScopeItem({ name: cleanText(name), display_name: cleanText(name) }));
          renderRows();
        });
      }

      renderRows();
      return {
        getItems: () => clone(items),
        setItems: (next) => { items = arrayValue(next).map(normalizeScopeItem); renderRows(); }
      };
    }

    // Source 1: the project's own defined scope (project.scope.root_items —
    // what the scope builder / proposals app writes via saveProjectScope).
    // Source 2: the latest proposal that carries editable.scope.root_items.
    async function loadScopeFromProject(){
      const projectScope = objectValue(project().scope);
      const scopeRoots = arrayValue(projectScope.root_items || projectScope.rootItems);
      if (scopeRoots.length) return clone(scopeRoots);
      try {
        if (window.ProposalsAPI?.projects?.list) {
          const res = await window.ProposalsAPI.projects.list(orgId(), projectId());
          const proposals = arrayValue(res?.proposals)
            .filter((p) => !['archived', 'void', 'discarded'].includes(cleanText(p.status).toLowerCase()))
            .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
          for (const proposal of proposals) {
            const rootItems = arrayValue(proposal?.editable?.scope?.root_items || proposal?.data?.editable?.scope?.root_items);
            if (rootItems.length) return clone(rootItems);
          }
        }
      } catch (error) {
        console.warn('Unable to load proposal scope', error);
      }
      // Fallback: proposals kept on the local project object.
      for (const proposal of arrayValue(project().proposals)) {
        const rootItems = arrayValue(proposal?.editable?.scope?.root_items);
        if (rootItems.length) return clone(rootItems);
      }
      return [];
    }

    // Source 2: the pricebook picker (search + category filter + qty).
    function pricebookModule(){
      return window.FirstMatePricebook || window.Portal?.modules?.pricebook || null;
    }

    function openPricebookPicker(options = {}){
      const pricebook = pricebookModule();
      if (!pricebook?.getState) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_f574625863d5b7","Pricebook") ?? "Pricebook"), (globalThis.PlatformLanguage?.text("documents","m_76fed630572456","The pricebook is not loaded for this session.") ?? "The pricebook is not loaded for this session."), false);
        return;
      }
      const modal = openModal(`<h2><i class="fas fa-book-open"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_f9a23e8ae26123"," Add from pricebook") ?? " Add from pricebook")}</h2><div data-pb-body><div class="fmdx-state" style="min-height:120px"><div class="fmdx-spinner"></div></div></div>`);
      const body = modal.el.querySelector('[data-pb-body]');
      const picked = [];
      Promise.resolve(pricebook.loadState?.() || null).catch(() => null).then(() => {
        if (!modal.el.isConnected) return;
        const pbState = objectValue(pricebook.getState?.());
        const allItems = arrayValue(pbState.items);
        const categories = [...new Set(allItems.map((item) => cleanText(item.category)).filter(Boolean))];
        const filters = { search: '', category: '' };

        function filteredItems(){
          const needle = filters.search.toLowerCase();
          return allItems.filter((item) => {
            if (filters.category && cleanText(item.category) !== filters.category) return false;
            if (!needle) return true;
            return `${item.name || ''} ${item.description || ''} ${item.category || ''}`.toLowerCase().includes(needle);
          }).slice(0, 200);
        }

        function renderPicker(){
          const list = filteredItems();
          body.innerHTML = `
            <div class="fmdx-pb-controls">
              <input type="search" placeholder="${(globalThis.PlatformLanguage?.htmlText("documents","m_f8e59b2816f580","Search pricebook items…") ?? "Search pricebook items…")}" value="${String(esc(filters.search))}" data-pb-search>
              <select data-pb-category>
                <option value="">${(globalThis.PlatformLanguage?.htmlText("documents","m_0abe1295afa55b","All categories") ?? "All categories")}</option>
                ${String(categories.map((cat) => `<option value="${esc(cat)}" ${filters.category === cat ? 'selected' : ''}>${esc(pricebook.getCategoryLabel?.(cat) || cat.replace(/_/g, ' '))}</option>`).join(''))}
              </select>
            </div>
            <div class="fmdx-pb-list">
              ${String(list.length ? list.map((item) => `
                <div class="fmdx-pb-row" data-pb-item="${esc(item.id)}">
                  <div class="fmdx-pb-main">
                    <strong>${esc(firstText(item.display_name, item.name, 'Item'))}</strong>
                    <small>${esc([pricebook.getCategoryLabel?.(item.category) || item.category, item.description].filter(Boolean).join(' · '))}</small>
                  </div>
                  <span class="price">${esc(moneyFromDollars(item.unit_price ?? item.base_price ?? item.basePrice ?? 0))}${item.unit ? ` / ${esc(item.unit)}` : ''}</span>
                  <input class="qty" type="number" step="any" min="0" value="1" data-pb-qty title="${(globalThis.PlatformLanguage?.htmlText("documents","m_9c689ddee2f502","Quantity") ?? "Quantity")}">
                  <button type="button" class="fmdx-btn" data-pb-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_8803dece55359d"," Add") ?? " Add")}</button>
                </div>`).join('') : `<div class="fmdx-scope-empty">${(globalThis.PlatformLanguage?.htmlText("documents","m_18c4bf2309f871","No pricebook items matched.") ?? "No pricebook items matched.")}</div>`)}
            </div>
            <div class="fmdx-modal-foot">
              <span class="fmdx-data-hint spacer" data-pb-count>${String(picked.length ? `${picked.length} item${picked.length === 1 ? '' : 's'} queued` : '')}</span>
              <button type="button" class="fmdx-btn primary" data-pb-done ${String(picked.length ? '' : 'disabled')}><i class="fas fa-check"></i>${((v5) => globalThis.PlatformLanguage?.htmlText("documents","m_620963be2953a9",` Add ${v5} to document`,{v5}) ?? ` Add ${v5} to document`)(picked.length || '')}</button>
            </div>`;
          body.querySelector('[data-pb-search]')?.addEventListener('input', (event) => {
            filters.search = event.target.value;
            renderPicker();
            const input = body.querySelector('[data-pb-search]');
            input?.focus();
            input?.setSelectionRange(input.value.length, input.value.length);
          });
          body.querySelector('[data-pb-category]')?.addEventListener('change', (event) => {
            filters.category = event.target.value;
            renderPicker();
          });
          body.querySelectorAll('[data-pb-item]').forEach((row) => {
            row.querySelector('[data-pb-add]')?.addEventListener('click', () => {
              const item = allItems.find((entry) => cleanText(entry.id) === row.dataset.pbItem);
              if (!item) return;
              const quantity = Math.max(0, Number(row.querySelector('[data-pb-qty]')?.value || 1)) || 1;
              const measurements = objectValue(project().measurements);
              // Preferred: the pricebook's own scope-item factory (keeps
              // formulas, components, variations exactly proposal-shaped).
              const viaFactory = pricebook.scopeItemFromPricebook?.(item.id, measurements, { quantity, manualQuantity: true });
              picked.push(viaFactory || makeScopeItem({
                name: firstText(item.name, 'Item'),
                display_name: firstText(item.display_name, item.name),
                description: cleanText(item.description),
                unit: firstText(item.unit, 'ea'),
                quantity: String(quantity),
                unit_price: Number(item.unit_price ?? item.base_price ?? item.basePrice ?? 0) || 0,
                base_price: Number(item.base_price ?? item.basePrice ?? item.unit_price ?? 0) || 0,
                pricebook_ref: { item_id: item.id, catalog_item_id: item.id }
              }));
              renderPicker();
            });
          });
          body.querySelector('[data-pb-done]')?.addEventListener('click', () => {
            modal.close();
            options.onDone?.(clone(picked));
          });
        }
        renderPicker();
      });
    }

    // ============================================================= preview
    // options.resolved: preloaded { resolved_definition, theme, widget_data }
    // (used for snapshot history views); otherwise resolves live.
    async function openPreview(docRecord, options = {}){
      const doc = objectValue(docRecord);
      if (!doc.id && !options.resolved) return;
      if (!window.FMDocRenderer?.render) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_afff48796c3165","Preview") ?? "Preview"), (globalThis.PlatformLanguage?.text("documents","m_97e3a8c68504bb","The document renderer library is not loaded.") ?? "The document renderer library is not loaded."), false);
        return;
      }
      const overlay = document.createElement('div');
      overlay.className = 'fmdx-preview-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', firstText(options.title, doc.title, 'Document preview'));
      overlay.innerHTML = `<div class="fmdx-state" style="min-width:320px;margin:auto"><div class="fmdx-spinner"></div><strong style="color:#e7ecf5">${(globalThis.PlatformLanguage?.htmlText("documents","m_6c82cfd4965b22","Rendering preview") ?? "Rendering preview")}</strong></div>`;
      document.body.appendChild(overlay);
      let viewer = null;
      const close = () => {
        try { viewer?.destroy?.(); } catch (e) {}
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        state.previewCleanup = null;
      };
      const onKey = (event) => { if (event.key === 'Escape') close(); };
      document.addEventListener('keydown', onKey);
      state.previewCleanup = close;

      let resolved = objectValue(options.resolved);
      const frozen = !resolved.resolved_definition && isReadOnlyStatus(doc.status) ? await frozenRenderOptions(doc) : null;
      if (frozen) {
        if (!overlay.isConnected) return;
        viewer = mountDocViewer(overlay, { doc, onClose: close, initialZoom: 'page', renderOptions: frozen });
        return;
      }
      if (!resolved.resolved_definition) {
        try {
          resolved = objectValue(await api().documents.resolve(orgId(), doc.id));
        } catch (error) {
          overlay.innerHTML = `<div class="fmdx-state" style="min-width:320px;margin:auto"><i class="fas fa-cloud-bolt"></i><strong style="color:#e7ecf5">${(globalThis.PlatformLanguage?.htmlText("documents","m_fc865c9558abcb","Preview unavailable") ?? "Preview unavailable")}</strong><span style="color:#9aa6bd">${String(esc(errorMessage(error, '')))}</span><button type="button" class="fmdx-btn" data-preview-close><i class="fas fa-xmark"></i> Close</button></div>`;
          overlay.querySelector('[data-preview-close]').addEventListener('click', close);
          return;
        }
      }
      if (!overlay.isConnected) return;
      viewer = mountDocViewer(overlay, {
        doc,
        onClose: close,
        initialZoom: 'page',
        renderOptions: {
          document: resolved.resolved_definition,
          theme: resolved.theme,
          themeContext: { branding: objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding), overrides: objectValue(resolved?.theme_vars || state.resolved?.theme_vars) },
          widgetData: resolved.widget_data
        }
      });
    }

    /**
     * "Edit manually": the document exactly as it will be sent (FMDocSentEditor,
     * docs/architecture/document-as-sent-editing.md). Values from the data
     * write the data and other text is saved as a text override, both through
     * POST /as-sent (patchDocumentInstance), so each is a document revision.
     */
    async function openAsSentEditor(){
      if (!state.doc?.id) return;
      if (!window.FMDocSentEditor?.open) { setDocView('editor'); return; }
      await flushAllWrites();
      const traced = async () => objectValue(await api().documents.resolve(orgId(), state.doc.id, { trace: true }));
      // Both kinds of edit are one server call each, saved as a document revision.
      const save = async (body) => {
        const res = objectValue(await api().documents.editAsSent(orgId(), state.doc.id, body));
        const updated = objectValue(res.document);
        if (updated.id) {
          state.doc = { ...state.doc, ...updated };
          state.baseOverrides = arrayValue(updated.overrides).map((op) => clone(op));
        }
        return res;
      };
      window.FMDocSentEditor.open({
        title: firstText(state.doc.title, 'Document'),
        themeContext: { branding: objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding) },
        load: traced,
        writeInputs: (writes) => save({ writes }),
        setTextOverride: async (nodeId, blocks, base) => {
          await flushAutosave();
          return save({ text: { node_id: nodeId, blocks, base } });
        },
        actions: [
          { id: 'layout', label: 'Edit layout', icon: 'fa-object-group', title: 'Open the template layout editor for this document', run: async (editor) => { await editor.close(); setDocView('editor'); } },
          { id: 'pdf', label: 'Download PDF', icon: 'fa-download', run: () => downloadPdf(state.doc, null) },
          { id: 'done', label: 'Done', icon: 'fa-check', primary: true, run: (editor) => editor.close() }
        ],
        onClose: (changed) => {
          if (!changed) return;
          state.workflowTouched = true; // the template editor re-resolves on its next open
          try { state.workflowHandle?.refresh?.({ params: clone(objectValue(state.doc?.params)), outputs: clone(objectValue(state.doc?.outputs)) }); } catch (e) {}
          try { state.workflowHandle?.refreshPreview?.(); } catch (e) {}
          renderDocCard();
        }
      });
    }

    // ================================================================= pdf
    async function downloadPdf(docRecord, button){
      const doc = objectValue(docRecord);
      if (!doc.id) return;
      const original = button?.innerHTML;
      if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>'; }
      try {
        const res = objectValue(await api().documents.generatePdf(orgId(), doc.id));
        const pdf = objectValue(res.pdf);
        const url = firstText(res.pdf_url, res.url, pdf.url) || api().documents.pdfUrl(orgId(), doc.id, { media_id: firstText(pdf.latest_media_id, pdf.media_id, res.media_id) });
        window.open(url, '_blank', 'noopener');
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_2440c46d7ac5f3","PDF") ?? "PDF"), errorMessage(error, 'Could not generate the PDF.'), false);
      } finally {
        if (button) { button.disabled = false; button.innerHTML = original; }
      }
    }

    function downloadDocumentData(documentDef, format, name){
      const base = firstText(name, 'Document').replace(/[\\/:*?"<>|]+/g, '-');
      const lines = [];
      const visit = (node) => { if (node?.type === 'text') for (const block of arrayValue(node.props?.blocks)) lines.push(arrayValue(block.runs).map((run) => cleanText(run.text)).join('')); for (const child of arrayValue(node?.children)) visit(child); };
      for (const page of arrayValue(documentDef?.pages)) visit(page);
      let blob; let ext;
      if (format === 'json') { blob = new Blob([JSON.stringify(documentDef, null, 2)], { type:'application/json' }); ext = 'json'; }
      else if (format === 'txt') { blob = new Blob([lines.join('\n')], { type:'text/plain;charset=utf-8' }); ext = 'txt'; }
      else { blob = new Blob([`<!doctype html><meta charset="utf-8"><title>${base}</title><body>${lines.map((line) => `<p>${esc(line) || '&nbsp;'}</p>`).join('')}</body>`], { type:'application/msword' }); ext = 'doc'; }
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${base}.${ext}`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ============================================================= present
    const canPresent = (options) => arrayValue(objectValue(options).offers).includes('present') && !!objectValue(options).presentation && !!window.FMDocPresent && !!window.FMDocParts;
    /**
     * Send and Present in the header wait for the workflow: until it stands on
     * its last step the deliverables are not ready, and the buttons say so.
     * Outside a workflow there is nothing to wait for.
     */
    function syncDeliverableButtons(ready){
      const host = state.root || document;
      const inWorkflow = state.docView === 'workflow' && !!state.workflowHandle;
      const isReady = !inWorkflow || (ready === undefined ? state.workflowHandle?.deliverablesReady?.() !== false : ready === true);
      // On the steps, Present and Send are the last step's own buttons; the
      // header carries them only while editing manually. No presentation, no Present.
      const onSteps = state.docView === 'workflow';
      host.querySelectorAll('[data-fmdx-send]').forEach((button) => { button.hidden = onSteps; });
      host.querySelectorAll('[data-fmdx-present]').forEach((button) => { button.hidden = onSteps || state.canPresent !== true; });
      host.querySelectorAll('[data-fmdx-present],[data-fmdx-send]').forEach((button) => {
        if (!button.dataset.readyTitle) button.dataset.readyTitle = button.getAttribute('title') || '';
        button.disabled = !isReady;
        button.setAttribute('title', isReady ? button.dataset.readyTitle : 'Finish the steps before Review & send first');
      });
    }
    /** Open the workflow's presentation in the visual editor; saving publishes a new version for new proposals. */
    async function editPresentation(moduleId){
      if (!moduleId || !window.FMPresentationEditorHost) return;
      const branding = objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding);
      const sample = window.FMRoofingPresentation;
      try {
        const result = objectValue(await window.FMPresentationEditorHost.open({
          orgId: orgId(), moduleId,
          scope: { org: { name: firstText(branding.name, window.__APP?.orgName, window.Portal?.cfg?.orgName), logo_url: firstText(branding.logo_url, branding.logoUrl, objectValue(branding.logo).url) }, customer: { name: firstText(objectValue(project().customer).name, 'your customer') } },
          ...(sample ? { sampleState: sample.priceSample(sample.sampleState()), priceSample: sample.priceSample } : {})
        }));
        if (result.saved) showToast('Presentation', 'Saved. New proposals use this version.', true);
      } catch (error) { showToast('Presentation', errorMessage(error, 'The presentation editor could not be opened.'), false); }
    }
    /** Email the customer a link to go through the presentation on their own. */
    async function sendPresentation(){
      const request = presentationRequest();
      const documentId = cleanText(state.doc?.id);
      if (!documentId) return;
      if (!window.confirm('Email the customer a link to this presentation? They can make their own choices; you review them before a contract goes out.')) return;
      try {
        await flushAllWrites();
        const read = (response) => objectValue(objectValue(response).presentation);
        const open = arrayValue((await presentationOptions(documentId)).presentations).map(objectValue).find((entry) => entry.frozen !== true);
        let current = open ? read(await request(`/presentations/${encodeURIComponent(open.id)}`)) : read(await request('/presentations', 'POST', { documentId }));
        if (open) current = read(await request(`/presentations/${encodeURIComponent(open.id)}/evaluate`, 'POST', { expectedRevision: current.revision, refresh: true }));
        const contact = objectValue(projectContacts().find((entry) => entry.primary && entry.email) || projectContacts().find((entry) => entry.email));
        if (!cleanText(contact.email)) { showToast('Presentation', 'Add the customer\u2019s email to the project first.', false); return; }
        const shared = objectValue(await request(`/presentations/${encodeURIComponent(current.id)}/shares`, 'POST', { expectedRevision: current.revision, access: 'choose', deliver: true, recipients: [{ name: firstText(contact.name, contact.email), email: cleanText(contact.email) }] }));
        const missed = undeliveredEmails(shared);
        showToast('Presentation', missed.length ? undeliveredText(missed) : `${firstText(contact.name, contact.email)} has been emailed a link.`, !missed.length);
      } catch (error) { showToast('Presentation', errorMessage(error, 'The presentation could not be sent.'), false); }
    }
    /** The company's colors as the variables slides use, for a deck opened before the document's theme has resolved. */
    function presentationColors(presentation){
      const colors = { ...objectValue(objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding).colors), ...objectValue(objectValue(objectValue(presentation).org).colors) };
      const primary = firstText(colors.primary, colors.brand, colors.accent);
      return primary ? { '--fm-primary': primary, '--fm-color-primary': primary, ...(firstText(colors.secondary) ? { '--fm-accent': firstText(colors.secondary) } : {}) } : {};
    }
    /** Calls the presentation routes of the document-modules API for this organization. */
    function presentationRequest(){
      const platform = window.PlatformAPI;
      const base = new URL(platform.baseUrl().replace(/\/platform\/?$/, '/document-modules'), location.href).href.replace(/\/$/, '');
      return (path, method = 'GET', body) => platform.request(`${base}/organizations/${encodeURIComponent(orgId())}${path}`, { method, ...(body === undefined ? {} : { body }) });
    }
    /** What this draft's last step offers: { offers, presentation, presentations }. Empty when it offers nothing. */
    async function presentationOptions(documentId){
      try { return objectValue(await presentationRequest()(`/documents/${encodeURIComponent(documentId)}/presentation`)); } catch (error) { return {}; }
    }
    /**
     * Present the estimate: the document's presentation, full screen, on the
     * live prices of this draft. Choices are saved on the presentation; "sign"
     * or "send" on its last slide writes them to the draft and opens Send.
     */
    async function openPresentation(){
      const request = presentationRequest();
      const parts = window.FMDocParts;
      const documentId = cleanText(state.doc?.id);
      if (!documentId || !window.FMDocPresent || !parts) return;
      const read = (response) => objectValue(objectValue(response).presentation);
      let current;
      try {
        await flushAllWrites();
        // Carry on with the presentation already started for this draft, on its latest lines.
        const open = arrayValue((await presentationOptions(documentId)).presentations).map(objectValue).find((entry) => entry.frozen !== true);
        if (open) {
          current = read(await request(`/presentations/${encodeURIComponent(open.id)}`));
          current = read(await request(`/presentations/${encodeURIComponent(open.id)}/evaluate`, 'POST', { expectedRevision: current.revision, refresh: true }));
        } else current = read(await request('/presentations', 'POST', { documentId }));
      } catch (error) { showToast('Present', errorMessage(error, 'The presentation could not be opened.'), false); return; }
      if (state.destroyed || !current.id) return;

      const overlay = document.createElement('div');
      overlay.className = 'fmdx-present-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483540;background:#0b0d12'; // above the project window
      document.body.appendChild(overlay);
      let player = null;
      // Writes go one at a time, each on the revision the one before returned.
      let writes = Promise.resolve();
      const close = () => { try { player?.destroy(); } catch (e) {} overlay.remove(); };
      // Everything from here happens in front of the customer, so it stays in
      // the presentation: nothing of the app shows until the device is handed back.
      const company = firstText(objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding).name, window.__APP?.orgName, window.Portal?.cfg?.orgName, 'our team');
      const reopen = async () => {
        close();
        try {
          const response = await api().documents.get(orgId(), documentId);
          await openDocScreen(objectValue(response.document || response.doc || response));
        } catch (error) { /* the list still shows it */ }
      };
      // A full-screen presentation shows only its own element: sheets go inside it.
      const stage = () => (document.fullscreenElement && overlay.contains(document.fullscreenElement) ? document.fullscreenElement : overlay);
      const sheetOf = (html) => {
        overlay.querySelector('[data-present-sheet]')?.remove();
        const sheet = document.createElement('div');
        sheet.dataset.presentSheet = '';
        sheet.style.cssText = 'position:absolute;inset:0;z-index:2147483600;background:#0b0d12;color:#fff;display:grid;place-items:center;padding:24px;font-family:var(--fm-body-font,Montserrat),Segoe UI,Arial,sans-serif';
        sheet.innerHTML = html;
        stage().appendChild(sheet);
        return sheet;
      };
      /** Where the presentation is left: a thank-you the customer can hold, and a quiet way out for whoever takes it back. */
      const rest = (headline, detail) => {
        const sheet = sheetOf(`
          <div style="max-width:560px;text-align:center">
            <div style="width:76px;height:76px;border-radius:50%;background:var(--fm-primary,#d93025);display:grid;place-items:center;margin:0 auto 26px;font-size:34px;font-weight:800">✓</div>
            <h1 style="margin:0 0 12px;font-size:34px;font-weight:800;line-height:1.15">${esc(headline)}</h1>
            <p style="margin:0 0 30px;font-size:17px;line-height:1.5;color:#c9ced8">${esc(detail)}</p>
            <p style="margin:0;font-size:14px;color:#8b93a3">You can hand this back to ${esc(company)} now.</p>
          </div>
          <button type="button" data-present-finish title="Close the presentation" style="position:absolute;right:16px;bottom:14px;border:0;background:none;color:#5b6272;font:600 12px/1 inherit;padding:10px;cursor:pointer">Finish</button>`);
        Object.entries(presentationColors(current)).forEach(([name, value]) => sheet.style.setProperty(name, value));
        sheet.querySelector('[data-present-finish]').addEventListener('click', reopen);
      };
      /** "Send me the estimate": ask only where to send it, send it, and say so. */
      const finish = () => {
        const contact = objectValue(projectContacts().find((entry) => entry.primary) || projectContacts()[0]);
        const field = 'width:100%;box-sizing:border-box;border:1px solid #2c3342;border-radius:12px;background:#141821;color:#fff;font:600 16px/1.2 inherit;padding:14px 16px;margin-top:6px';
        const sheet = sheetOf(`
          <form data-present-send style="width:min(460px,100%)">
            <h1 style="margin:0 0 8px;font-size:28px;font-weight:800">Where should we send it?</h1>
            <p style="margin:0 0 22px;font-size:15px;line-height:1.5;color:#c9ced8">We\u2019ll email your estimate with everything you chose today, so you can read it and approve it when you\u2019re ready.</p>
            <label style="display:block;font-size:12px;font-weight:700;color:#8b93a3;margin-bottom:14px">Name<input data-present-name autocomplete="name" value="${esc(firstText(contact.name))}" style="${field}"></label>
            <label style="display:block;font-size:12px;font-weight:700;color:#8b93a3">Email<input data-present-email type="email" inputmode="email" autocomplete="email" value="${esc(firstText(contact.email))}" style="${field}"></label>
            <p data-present-error role="alert" style="min-height:18px;margin:10px 0 0;font-size:13px;font-weight:700;color:#ff8a80"></p>
            <div style="display:flex;gap:10px;margin-top:10px">
              <button type="button" data-present-back style="flex:none;border:1px solid #2c3342;border-radius:12px;background:none;color:#c9ced8;font:700 15px/1 inherit;padding:15px 20px;cursor:pointer">Back</button>
              <button type="submit" data-present-go style="flex:1;border:0;border-radius:12px;background:var(--fm-primary,#d93025);color:#fff;font:800 15px/1 inherit;padding:15px 20px;cursor:pointer">Send my estimate</button>
            </div>
          </form>`);
        Object.entries(presentationColors(current)).forEach(([name, value]) => sheet.style.setProperty(name, value));
        const error = sheet.querySelector('[data-present-error]');
        const go = sheet.querySelector('[data-present-go]');
        sheet.querySelector('[data-present-back]').addEventListener('click', () => sheet.remove());
        sheet.querySelector('[data-present-send]').addEventListener('submit', async (event) => {
          event.preventDefault();
          const name = cleanText(sheet.querySelector('[data-present-name]').value);
          const email = cleanText(sheet.querySelector('[data-present-email]').value);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { error.textContent = 'Enter the email address to send it to.'; sheet.querySelector('[data-present-email]').focus(); return; }
          error.textContent = '';
          go.disabled = true;
          go.textContent = 'Sending\u2026';
          let result;
          try {
            await writes.catch(() => {});
            result = await deliverDocument({ id: documentId }, { recipients: [{ signer_id: customerSignerRole(), role: 'customer', name: name || email, email }] }, { request, presentation: current });
            current = objectValue(result.presentation).id ? objectValue(result.presentation) : current;
          } catch (failure) {
            go.disabled = false;
            go.textContent = 'Send my estimate';
            error.textContent = sendFailure(failure).message;
            current = await rereadPresentation(current);
            return;
          }
          const missed = undeliveredEmails(result);
          if (missed.length) { rest('Your estimate is ready.', `${undeliveredText(missed)} ${company} will get it to you.`); return; }
          rest(name ? `Thank you, ${name.split(/\s+/)[0]}.` : 'Thank you.', `Your estimate is on its way to ${email}.`);
        });
        setTimeout(() => { try { sheet.querySelector(firstText(contact.email) ? '[data-present-go]' : '[data-present-email]').focus(); } catch (e) {} }, 50);
      };
      /**
       * Accept & sign. Whoever is presenting says who signs and attests they
       * will witness it; the agreement is issued to that person from what was
       * chosen (no invitation email: they sign here), then the customer signs on
       * this screen with the contract beside the signature. Signing runs on the
       * documents engine's presenter route; the sealed executed copy is emailed
       * to them by the engine.
       */
      let issued = null;
      const openSigning = () => {
        const signing = window.FMPresentSigning;
        if (!signing) { rest('Thank you.', `Your agreement is ready. ${company} will send it to you to sign.`); return; }
        const platform = window.PlatformAPI;
        const base = new URL(platform.baseUrl().replace(/\/platform\/?$/, '/documents'), location.href).href.replace(/\/$/, '')
          + `/organizations/${encodeURIComponent(orgId())}/documents/${encodeURIComponent(issued.documentId)}/signing/present`;
        const totals = objectValue(objectValue(current.pricing).totals);
        signing.open(stage(), {
          base,
          request: (url, options) => platform.request(url, options),
          signer: issued.signer,
          title: firstText(issued.title, state.doc?.title, 'Your agreement'),
          total: totals.total_cents !== undefined && Number.isFinite(Number(totals.total_cents)) ? moneyFromCents(Number(totals.total_cents)) : '',
          company,
          presenterAttested: true,
          onBack: () => {},
          onDone: () => rest('Thank you.', `Your signed agreement is on its way to ${issued.signer.email}.`)
        });
      };
      const sign = () => {
        if (issued) { openSigning(); return; }
        const contact = objectValue(projectContacts().find((entry) => entry.primary) || projectContacts()[0]);
        const field = 'width:100%;box-sizing:border-box;border:1px solid #2c3342;border-radius:12px;background:#141821;color:#fff;font:600 16px/1.2 inherit;padding:14px 16px;margin-top:6px';
        const presenter = firstText(window.__APP?.userName, window.Portal?.cfg?.userName, 'I');
        const sheet = sheetOf(`
          <form data-present-signer style="width:min(480px,100%)">
            <h1 style="margin:0 0 8px;font-size:28px;font-weight:800">Who is signing?</h1>
            <p style="margin:0 0 22px;font-size:15px;line-height:1.5;color:#c9ced8">The agreement is made out to this person. They review and sign it on this screen, and a sealed copy is emailed to them.</p>
            <label style="display:block;font-size:12px;font-weight:700;color:#8b93a3;margin-bottom:14px">Full name<input data-present-name autocomplete="name" value="${esc(firstText(contact.name))}" style="${field}"></label>
            <label style="display:block;font-size:12px;font-weight:700;color:#8b93a3">Email<input data-present-email type="email" inputmode="email" autocomplete="email" value="${esc(firstText(contact.email))}" style="${field}"></label>
            <label style="display:flex;gap:10px;align-items:flex-start;margin-top:18px;font-size:13px;line-height:1.45;color:#c9ced8;cursor:pointer"><input type="checkbox" data-present-witness style="flex:none;width:18px;height:18px;margin:1px 0 0;accent-color:var(--fm-primary,#d93025)"><span>${esc(presenter === 'I' ? 'I' : `I, ${presenter},`)} am presenting this agreement in person and will witness this person review and sign it on this screen.</span></label>
            <p data-present-error role="alert" style="min-height:18px;margin:10px 0 0;font-size:13px;font-weight:700;color:#ff8a80"></p>
            <div style="display:flex;gap:10px;margin-top:10px">
              <button type="button" data-present-back style="flex:none;border:1px solid #2c3342;border-radius:12px;background:none;color:#c9ced8;font:700 15px/1 inherit;padding:15px 20px;cursor:pointer">Back</button>
              <button type="submit" data-present-go style="flex:1;border:0;border-radius:12px;background:var(--fm-primary,#d93025);color:#fff;font:800 15px/1 inherit;padding:15px 20px;cursor:pointer">Continue to sign</button>
            </div>
          </form>`);
        Object.entries(presentationColors(current)).forEach(([name, value]) => sheet.style.setProperty(name, value));
        const error = sheet.querySelector('[data-present-error]');
        const go = sheet.querySelector('[data-present-go]');
        sheet.querySelector('[data-present-back]').addEventListener('click', () => sheet.remove());
        sheet.querySelector('[data-present-signer]').addEventListener('submit', async (event) => {
          event.preventDefault();
          const name = cleanText(sheet.querySelector('[data-present-name]').value);
          const email = cleanText(sheet.querySelector('[data-present-email]').value);
          if (!name) { error.textContent = 'Enter the full name of the person signing.'; sheet.querySelector('[data-present-name]').focus(); return; }
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { error.textContent = 'Enter their email address: the signed copy goes there.'; sheet.querySelector('[data-present-email]').focus(); return; }
          if (!sheet.querySelector('[data-present-witness]').checked) { error.textContent = 'Confirm that you are presenting this in person.'; sheet.querySelector('[data-present-witness]').focus(); return; }
          error.textContent = '';
          go.disabled = true;
          go.textContent = 'Preparing the agreement\u2026';
          try {
            await writes.catch(() => {});
            // In person: no invitation email, they sign here; the engine emails the sealed copy.
            const result = await deliverDocument({ id: documentId }, { recipients: [{ signer_id: customerSignerRole(), role: 'customer', name, email }], include_portal: false, include_pdf: false }, { request, presentation: current });
            current = objectValue(result.presentation).id ? objectValue(result.presentation) : current;
            issued = { documentId: firstText(objectValue(result.document).id, documentId), title: firstText(objectValue(result.document).title), signer: { name, email } };
          } catch (failure) {
            go.disabled = false;
            go.textContent = 'Continue to sign';
            error.textContent = sendFailure(failure).message;
            current = await rereadPresentation(current);
            return;
          }
          sheet.remove();
          openSigning();
        });
        setTimeout(() => { try { sheet.querySelector(firstText(contact.name) && firstText(contact.email) ? '[data-present-witness]' : (firstText(contact.name) ? '[data-present-email]' : '[data-present-name]')).focus(); } catch (e) {} }, 50);
      };
      /** After a refused send the presentation may have moved on (its contract was written): carry on from where it is. */
      const rereadPresentation = async (known) => {
        try { return read(await request(`/presentations/${encodeURIComponent(known.id)}`)); } catch (e) { return known; }
      };
      player = window.FMDocPresent.mount(overlay, {
        document: current.layout,
        widgetData: objectValue(current.widgetData),
        orgId: orgId(),
        theme: objectValue(state.resolved?.theme),
        themeContext: { branding: objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding), overrides: { ...presentationColors(current), ...objectValue(state.resolved?.theme_vars) } },
        mediaUrl: (ref, variant) => mediaBridge().url(ref, variant),
        live: {
          state: parts.stateFromPresentation(current),
          readonly: current.frozen === true,
          onInput: (input) => (writes = writes.catch(() => {}).then(async () => {
            const write = parts.inputWrite(input);
            if (!write) return null;
            current = read(await request(`/presentations/${encodeURIComponent(current.id)}/inputs`, 'PATCH', { expectedRevision: current.revision, ...write }));
            return parts.stateFromPresentation(current);
          })),
          onError: (error) => showToast('Present', errorMessage(error, 'That choice could not be saved.'), false)
        },
        onAction: (name) => { if (name === 'sign') sign(); else if (name === 'send') finish(); },
        onExit: close
      });
      try { player.fullscreen(); } catch (e) { /* needs a user gesture; the top bar has the button */ }
    }

    // ================================================================ send
    async function openSendModal(docRecord){
      let deliveryDefaults;
      try {
        const branchId = firstText(docRecord.branch_id, project().branch_id, window.Portal?.branchModules?.currentBranchId?.(), 'default');
        deliveryDefaults = objectValue(objectValue(await Promise.race([
          api().documents.settings(orgId(), branchId),
          new Promise((resolve) => setTimeout(() => resolve({}), 2500))
        ])).settings);
        if (state.destroyed) return;
      } catch (error) { deliveryDefaults = {}; }
      const doc = objectValue(docRecord);
      if (!doc.id) return;
      const branding = objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding);
      const consentDefault = firstText(objectValue(doc.metadata).consent_contact, deliveryDefaults.consent_contact, branding.email, branding.support_email, branding.phone, window.Portal?.cfg?.userEmail);
      const emailValid = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanText(value));
      const contacts = projectContacts();
      const signerRoles = [...new Set(Object.values(objectValue(doc.output_defs)).filter(d => d?.type === 'signature').map(d => cleanText(d.signer_id) || (['internal','company'].includes(d.party || d.signer) ? 'company' : 'customer')))];
      const signerRows = signerRoles.map((role, index) => {
        const required = Object.values(objectValue(doc.output_defs)).some(d => d?.type === 'signature' && (cleanText(d.signer_id) || (['internal','company'].includes(d.party || d.signer) ? 'company' : 'customer')) === role && (d.required === true || ['signed','completed'].includes(d.required_for)));
        const prior = arrayValue(doc.delivery?.recipients).find(r => (r.signer_id || r.role || 'customer') === role);
        const contact = prior || (role === 'customer' && contacts.length === 1 ? contacts[0] : {});
        return `<fieldset class="fmdx-field wide" data-signer-role="${esc(role)}" data-signer-required="${required}"><legend>${((v2,v3) => globalThis.PlatformLanguage?.htmlText("documents","m_76f28d31e96fe0",`Signer: ${v2}${v3}`,{v2,v3}) ?? `Signer: ${v2}${v3}`)(esc(role),required ? '' : ' (optional)')}</legend>
          <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_8cf345002184e5","Name") ?? "Name")}<input data-signer-name value="${esc(contact.name || '')}"></label>
          <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_5d2b9327181e33","Email") ?? "Email")}<input type="email" data-signer-email value="${esc(contact.email || '')}"></label>
          <details class="fmdx-send-more"><summary>Signing order, capacity, company signer</summary>
          <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_2673fb88cdc226","Organization user ID (for a signed-in company signer)") ?? "Organization user ID (for a signed-in company signer)")}<input data-signer-user value="${esc(contact.user_id || '')}"></label>
          <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_f8bc5a366f36e4","Signing order (same number signs in parallel)") ?? "Signing order (same number signs in parallel)")}<input type="number" min="0" max="1000" data-signer-order value="${Number(contact.order || 0)}"></label>
          <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_32d13195480127","Capacity, such as homeowner or authorized representative") ?? "Capacity, such as homeowner or authorized representative")}<input data-signer-capacity value="${esc(contact.capacity || '')}"></label></details></fieldset>`;
      }).join('');
      const contactRows = contacts.length
        ? contacts.map((contact, index) => `
            <label class="fmdx-check fmdx-recipient-row">
              <input type="checkbox" data-send-contact="${index}" ${emailValid(contact.email) ? 'checked' : 'disabled'}>
              <span class="who"><strong>${esc(contact.name)}</strong><small>${esc(contact.email || 'No email on file — add one below')}</small></span>
              ${contact.primary ? `<span class="fmdx-chip plain">${(globalThis.PlatformLanguage?.htmlText("documents","m_2436076ece8629","Primary") ?? "Primary")}</span>` : ''}
            </label>`).join('')
        : `<p class="fmdx-data-hint">${(globalThis.PlatformLanguage?.htmlText("documents","m_176b9c549a6bd9","No project contacts with an email yet — add an address below.") ?? "No project contacts with an email yet — add an address below.")}</p>`;
      const modal = openModal(`
        <h2><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_bb59e0b2a090e3"," Send document") ?? " Send document")}</h2>
        <p class="fmdx-modal-sub">${((v0) => globalThis.PlatformLanguage?.htmlText("documents","m_5ae7520a0cb450",`${v0} — a snapshot is frozen and delivered to your customer.`,{v0}) ?? `${v0} — a snapshot is frozen and delivered to your customer.`)(esc(firstText(doc.title, 'Document')))}</p>
        <div class="fmdx-form-grid">
          ${signerRows}
          ${signerRoles.length ? `<details class="fmdx-send-more fmdx-field wide"><summary>Contact for paper copies: ${esc(consentDefault || 'your own email')}</summary><label class="fmdx-field wide"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_0d57df484a893a","Your contact for paper copies and electronic-consent withdrawal") ?? "Your contact for paper copies and electronic-consent withdrawal")}</span><input data-consent-contact value="${esc(consentDefault)}" placeholder="${(globalThis.PlatformLanguage?.htmlText("documents","m_a434d7e39d7caf","Your company's support email or phone") ?? "Your company's support email or phone")}"></label></details>` : ''}
          <div class="fmdx-field wide"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_c1791596944182","Recipients") ?? "Recipients")}</span>
            <div class="fmdx-recipient-list">${String(contactRows)}</div>
          </div>
          <label class="fmdx-field wide"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_2346d86fbb7dfd","Add another email (optional)") ?? "Add another email (optional)")}</span><input type="email" data-send-extra placeholder="${(globalThis.PlatformLanguage?.htmlText("documents","m_ee9cc9ca2a8b83","name@email.com") ?? "name@email.com")}"></label>
          <label class="fmdx-field wide"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_1cc093ae43d736","Message (optional)") ?? "Message (optional)")}</span><textarea data-send-message placeholder="${(globalThis.PlatformLanguage?.htmlText("documents","m_c6b7216b3e2a6c","A short note included with the email…") ?? "A short note included with the email…")}"></textarea></label>
          <label class="fmdx-check"><input type="checkbox" data-send-portal ${deliveryDefaults.send_include_portal !== false ? 'checked' : ''}>${(globalThis.PlatformLanguage?.htmlText("documents","m_948ada5da279bb"," Include portal link (view, sign & pay online)") ?? " Include portal link (view, sign & pay online)")}</label>
          <label class="fmdx-check"><input type="checkbox" data-send-pdf ${deliveryDefaults.send_include_pdf !== false ? 'checked' : ''}>${(globalThis.PlatformLanguage?.htmlText("documents","m_c96d1087aa82e3"," Attach PDF") ?? " Attach PDF")}</label>
        </div>
        <div class="fmdx-modal-foot">
          <span class="fmdx-send-error" data-send-error role="alert" hidden></span>
          <button type="button" class="fmdx-btn primary" data-send-go><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_c66c415b0e5570"," Send") ?? " Send")}</button>
        </div>`, { className: 'narrow' });
      modal.el.querySelector('[data-send-go]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const errorEl = modal.el.querySelector('[data-send-error]');
        // Say what is wrong in the dialog and put the cursor on it.
        const problem = (message, field) => {
          if (errorEl) { errorEl.textContent = message; errorEl.hidden = !message; }
          if (field) { const more = field.closest('details'); if (more) more.open = true; try { field.focus(); field.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {} }
        };
        problem('');
        let recipients = [...modal.el.querySelectorAll('[data-send-contact]')]
          .filter((input) => input.checked)
          .map((input) => contacts[Number(input.dataset.sendContact || 0)])
          .filter((contact) => contact && emailValid(contact.email))
          .map((contact) => ({ name: contact.name, email: cleanText(contact.email), ...(contact.role ? { role: contact.role } : {}) }));
        const extra = cleanText(modal.el.querySelector('[data-send-extra]')?.value);
        if (extra) {
          if (!emailValid(extra)) { problem('The extra email address is not valid.', modal.el.querySelector('[data-send-extra]')); return; }
          if (!recipients.some((r) => r.email.toLowerCase() === extra.toLowerCase())) recipients.push({ name: extra, email: extra, role: 'customer' });
        }
        if (signerRoles.length) {
          recipients = recipients.map(r => ({ ...r, role: 'copy' }));
          for (const row of modal.el.querySelectorAll('[data-signer-role]')) {
            const email = cleanText(row.querySelector('[data-signer-email]').value);
            const user_id = cleanText(row.querySelector('[data-signer-user]').value);
            if (!email && !user_id && row.dataset.signerRequired !== 'true') continue;
            if ((!emailValid(email) && !user_id) || (email && !emailValid(email))) { problem('Enter an email address for the person who signs.', row.querySelector('[data-signer-email]')); return; }
            recipients.push({ signer_id: row.dataset.signerRole, name: cleanText(row.querySelector('[data-signer-name]').value), email, user_id, order: Number(row.querySelector('[data-signer-order]').value), capacity: cleanText(row.querySelector('[data-signer-capacity]').value) });
          }
          recipients = recipients.filter(r => r.role !== 'copy' || !recipients.some(s => s.signer_id && s.email && s.email.toLowerCase() === r.email.toLowerCase()));
        }
        if (!recipients.length) {
          problem('Choose at least one recipient with an email address.', modal.el.querySelector('[data-send-extra]'));
          return;
        }
        button.disabled = true;
        button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Sending…';
        try {
          const res = await deliverDocument(doc, {
            recipients,
            consent_contact: cleanText(modal.el.querySelector('[data-consent-contact]')?.value),
            include_portal: modal.el.querySelector('[data-send-portal]')?.checked !== false,
            include_pdf: modal.el.querySelector('[data-send-pdf]')?.checked !== false,
            message: cleanText(modal.el.querySelector('[data-send-message]')?.value)
          });
          if (state.doc?.id === doc.id) {
            const updated = objectValue(res.document);
            if (updated.id) state.doc = { ...state.doc, ...updated };
          }
          loadDocs({ silent: true });
          renderSendSuccess(modal, res);
          // The draft is now a sent document: reopen it so the screen says so.
          if (state.view === 'editor' && state.doc?.id === doc.id) openDocScreen(state.doc);
        } catch (error) {
          button.disabled = false;
          button.innerHTML = '<i class="fas fa-paper-plane"></i> Send';
          const failure = sendFailure(error);
          problem(failure.code === 'signature_contact_required' ? 'Add your company contact for paper copies under the signer\u2019s extra options.' : failure.message, failure.code === 'signature_contact_required' ? modal.el.querySelector('[data-consent-contact]') : null);
        }
      });
    }

    /**
     * The one way a document goes to the customer, from the workflow's Send and
     * from a presentation alike: the documents send on the server, with the
     * same fields, read back the same way. From a presentation its choices are
     * first written onto the draft (contract/send), which then sends it.
     * Returns { document, emailed, signing, portal_url, preview_url, presentation }.
     */
    async function deliverDocument(docRecord, fields, via){
      const input = objectValue(fields);
      if (via?.presentation) {
        const sent = objectValue(await via.request(`/presentations/${encodeURIComponent(via.presentation.id)}/contract/send`, 'POST', {
          expectedRevision: via.presentation.revision, documentId: docRecord.id, recipients: arrayValue(input.recipients),
          ...(cleanText(input.consent_contact) ? { consentContact: cleanText(input.consent_contact) } : {}),
          ...(cleanText(input.message) ? { message: cleanText(input.message) } : {}),
          ...(input.include_pdf !== undefined ? { includePdf: input.include_pdf !== false } : {}),
          ...(input.include_portal !== undefined ? { includePortal: input.include_portal !== false } : {})
        }));
        return { document: objectValue(sent.document), emailed: arrayValue(sent.emailed), signing: sent.signing, portal_url: cleanText(sent.portalUrl), preview_url: cleanText(sent.previewUrl), presentation: objectValue(sent.presentation) };
      }
      return objectValue(await api().documents.send(orgId(), docRecord.id, { ...input, ...(input.include_portal !== undefined ? { include_portal_link: input.include_portal !== false } : {}) }));
    }
    /** Emails the send recorded as not delivered: [{ email, reason }]. */
    function undeliveredEmails(result){
      return arrayValue(objectValue(result).emailed).map(objectValue)
        .filter((entry) => entry.ok === false || entry.success === false)
        .map((entry) => ({ email: cleanText(entry.email), reason: cleanText(entry.error || entry.message) }));
    }
    /** The same words wherever a send could not email someone. */
    function undeliveredText(missed){
      const list = arrayValue(missed);
      const who = list.map((entry) => entry.email).filter(Boolean).join(', ');
      return `The email to ${who || 'the customer'} did not go out${list[0]?.reason ? ` (${list[0].reason.replace(/\.$/, '')})` : ''}.`;
    }
    /** What a refused send says, from either place. */
    function sendFailure(error){
      const code = cleanText(error?.data?.code || error?.data?.error || error?.code);
      const known = {
        signature_recipient_required: 'This agreement needs every signer named. Send it from the Docs screen to add the other signers.',
        signature_contact_required: 'Your company needs a contact for paper copies before agreements can be sent. Add one in Documents settings.',
        presentation_frozen: 'This presentation was already sent. Open the sent document from the Docs screen.',
        presentation_contract_not_draft: 'This document was already sent. Void it on the Docs screen to send a new one.',
        presentation_incomplete: 'A choice is still missing. Go back and finish the presentation first.',
        module_revision: 'Something changed while this was open. Please try again.'
      };
      return { code, message: known[code] || errorMessage(error, 'The document could not be sent. Please try again.') };
    }
    /** The customer signer's role on this document (the send dialog's rule): its first outside signer. */
    function customerSignerRole(){
      const roles = Object.values(objectValue(state.doc?.output_defs)).filter((def) => def?.type === 'signature')
        .map((def) => cleanText(def.signer_id) || (['internal', 'company'].includes(def.party || def.signer) ? 'company' : 'customer'));
      return roles.find((role) => role !== 'company') || 'customer';
    }

    /**
     * What Send leaves on screen: who it went to, whether each email went
     * out, and the link each person was sent, to copy or open if they ask for
     * it again.
     */
    function renderSendSuccess(modal, result = {}){
      const body = modal.body;
      body.querySelectorAll(':scope > *:not(.fmdx-modal-close)').forEach((el) => el.remove());
      const emailed = arrayValue(result.emailed).map(objectValue);
      const failed = (email) => emailed.some((entry) => cleanText(entry.email).toLowerCase() === cleanText(email).toLowerCase() && (entry.ok === false || entry.success === false));
      const signers = arrayValue(result.signing?.invitations).map(objectValue);
      // Signers first, then anyone who only received a copy.
      const people = [
        ...signers.map((entry) => ({ name: firstText(entry.name, entry.email, entry.signer_id), email: cleanText(entry.email), link: entry.user_id ? '' : cleanText(entry.portal_url), role: entry.user_id ? 'Signs in the app' : 'To sign', account: !!entry.user_id })),
        ...emailed.filter((entry) => !signers.some((signer) => cleanText(signer.email).toLowerCase() === cleanText(entry.email).toLowerCase()))
          .map((entry) => ({ name: firstText(entry.name, entry.email), email: cleanText(entry.email), link: cleanText(result.portal_url), role: signers.length ? 'Copy' : '' }))
      ];
      const anyFailed = people.some((person) => person.email && failed(person.email));
      const names = people.map((person) => person.name).filter(Boolean);
      const to = names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(' and ');
      const wrap = document.createElement('div');
      wrap.className = 'fmdx-send-success';
      wrap.innerHTML = `
        <div class="fmdx-sent-mark ${anyFailed ? 'warn' : ''}"><i class="fas ${anyFailed ? 'fa-triangle-exclamation' : 'fa-check'}"></i></div>
        <h2 class="fmdx-sent-title">${esc(anyFailed ? 'Sent, but an email did not go out' : (to ? `Sent to ${to}` : 'Document sent'))}</h2>
        <p class="fmdx-sent-sub">${esc(anyFailed
          ? 'Copy the link for anyone marked below and send it to them yourself, then check your email settings.'
          : (signers.length ? 'They have an email with a link to read it, sign and pay online.' : 'They have an email with a link to read it online.'))}</p>
        <div class="fmdx-sent-list">${people.map((person, index) => `
          <div class="fmdx-sent-row">
            <span class="fmdx-sent-avatar">${esc((person.name || '?').trim().charAt(0).toUpperCase())}</span>
            <span class="fmdx-sent-who"><strong>${esc(person.name)}</strong><small>${esc([person.email !== person.name ? person.email : '', person.role].filter(Boolean).join(' \u00b7 '))}</small></span>
            ${person.email ? `<span class="fmdx-sent-state ${failed(person.email) ? 'bad' : ''}"><i class="fas ${failed(person.email) ? 'fa-circle-xmark' : 'fa-circle-check'}"></i>${failed(person.email) ? ' Not emailed' : ' Emailed'}</span>` : ''}
            ${person.link ? `<button type="button" class="fmdx-btn fmdx-btn-icon" data-sent-copy="${index}" title="Copy their link"><i class="fas fa-link"></i></button>` : ''}${person.link && cleanText(result.preview_url) ? `<a class="fmdx-btn fmdx-btn-icon" href="${esc(cleanText(result.preview_url))}" target="_blank" rel="noopener" title="Preview what they see (nothing can be signed or paid)"><i class="fas fa-eye"></i></a>` : ''}
          </div>`).join('')}</div>
        <div class="fmdx-modal-foot"><button type="button" class="fmdx-btn primary" data-send-done>${(globalThis.PlatformLanguage?.htmlText("documents","m_8cb6b086a0e69c","Done") ?? "Done")}</button></div>`;
      body.appendChild(wrap);
      wrap.querySelectorAll('[data-sent-copy]').forEach((button) => button.addEventListener('click', async () => {
        const link = people[Number(button.dataset.sentCopy)]?.link;
        try { await navigator.clipboard.writeText(link); button.innerHTML = '<i class="fas fa-check"></i>'; button.title = 'Copied'; setTimeout(() => { button.innerHTML = '<i class="fas fa-link"></i>'; button.title = 'Copy their link'; }, 1600); }
        catch (error) { window.prompt('Copy this link', link); }
      }));
      wrap.querySelector('[data-send-done]')?.addEventListener('click', () => modal.close());
      try { wrap.querySelector('[data-send-done]').focus(); } catch (e) {}
    }

    // ---------------------------------------------------------------- boot
    loadCatalog();
    loadDocs();
    ensureWorkflowRuntime(); // warm, so the first document opens without waiting on it
    const onWindowResize = () => { if (state.view === 'editor' && !state.destroyed) syncTrayOffset(); };
    window.addEventListener('resize', onWindowResize);

    if (embedded) {
      embed.onReady?.({
        openCreateModal: (prefill = {}) => openCreateModal(objectValue(prefill)),
        openCreateInline: (host, prefill = {}, opts = {}) => openCreateModal(objectValue(prefill), { inlineHost: host, onClose: opts.onClose }),
        openDocument: (doc) => {
          // Standalone sessions track their documents locally (no server list)
          // so the gallery and adopt-project handoff can see resumed drafts.
          rememberStandaloneDoc(objectValue(doc));
          return openEditor(objectValue(doc));
        },
        openPreview: (doc, options = {}) => openPreview(objectValue(doc), options),
        openSendModal: (doc) => openSendModal(objectValue(doc)),
        downloadPdf: (doc, button) => downloadPdf(objectValue(doc), button || null),
        duplicateDoc: (doc, button) => duplicateDoc(objectValue(doc), button || null),
        archiveDoc: (doc) => archiveDoc(objectValue(doc)),
        getDocs: () => state.docs,
        getCatalog: () => state.catalog,
        getCurrentDoc: () => (state.view === 'editor' ? state.doc : null),
        isDocScreenOpen: () => state.view === 'editor',
        closeDocScreen: () => closeDocScreen(),
        refresh: () => loadDocs({ silent: true })
      });
    }

    return {
      setActive(active){
        state.active = !!active;
        // Leaving the tab mid-edit must release the focus treatment so other
        // tabs get their left column back.
        const focused = state.view === 'editor';
        if (!active && focused) setEditorFocus(false);
        if (active && focused) setEditorFocus(true);
        if (active && state.loaded && state.view === 'list') loadDocs({ silent: true });
      },
      update(){ /* context refreshes handled lazily */ },
      destroy(){
        state.destroyed = true;
        clearTimeout(state.saveTimer);
        window.removeEventListener('resize', onWindowResize);
        flushAutosave();
        flushWorkflowWrites();
        try { state.previewCleanup?.(); } catch (e) {}
        try { setEditorFocus(false); } catch (e) {}
        destroyWorkflowView();
        destroyEditor();
        root.innerHTML = '';
      }
    };
  }

  runtime.registerApp({
    id: 'project.documents',
    kind: 'project_modal_app',
    title: (globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"),
    label: (globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"),
    icon: 'fa-file-signature',
    order: 26,
    // Docs-tab consolidation: this app no longer surfaces its own tab. The
    // unified "Docs" tab (apps/docs/project.js) mounts this module hidden via
    // runtime.mount + params.embed and reuses its create wizard + editor.
    // visible:false keeps it out of the tab bar while on-demand mounts work.
    visible: false,
    surfaces: ['project_modal'],
    regions: ['main'],
    requiresContext: ['project'],
    panelHtml: '<div data-fmdx-panel style="height:100%"></div>',
    mount: (context = {}) => mountDocumentsTab(context)
  });
})();
