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
    signed: 'Signed', completed: 'Completed', declined: 'Declined', expired: 'Expired', void: 'Void',
    needs_review: 'Needs review', archived: 'Archived'
  };
  const TYPE_META = {
    proposal: { icon: 'fa-file-signature', color: '#2563eb' },
    invoice: { icon: 'fa-file-invoice-dollar', color: '#175cd3' },
    change_order: { icon: 'fa-file-contract', color: '#7c3aed' },
    contract: { icon: 'fa-file-pen', color: '#0f766e' },
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
      const pieceId = firstText(piece.id, `piece_${templateId}_${index}`);
      root.scope_piece_id = pieceId;
      root.scope_template_id = templateId;
      root.display_name = firstText(piece.name, root.display_name, root.name, 'Project piece');
      root.name = root.display_name;
      if (firstText(piece.color)) root.scope_color = cleanText(piece.color);
      // Namespace choice groups per piece so two pieces never share a group
      // (same rule proposalBuilderApplyPieceMetadata applies).
      const prefixGroups = (item) => {
        const sel = objectValue(item.selection);
        if (firstText(sel.group_id) && !String(sel.group_id).includes(':')) {
          item.selection = { ...sel, group_id: `${pieceId}:${sel.group_id}` };
        }
        arrayValue(item.children).forEach((child) => prefixGroups(objectValue(child)));
      };
      prefixGroups(objectValue(root));
      return root;
    }).filter(Boolean);
  }

  // ----------------------------------------------------- lifecycle helpers
  const READ_ONLY_STATUSES = ['signed', 'completed', 'declined', 'expired', 'void'];
  const AMENDABLE_STATUSES = ['signed', 'completed'];
  function isReadOnlyStatus(status){ return READ_ONLY_STATUSES.includes(cleanText(status).toLowerCase()); }
  function isAmendableStatus(status){ return AMENDABLE_STATUSES.includes(cleanText(status).toLowerCase()); }

  // Best-effort total for the list cards, read straight off the instance
  // params (line-item math mirrors public/v1/proposals/scope.ts).
  function docTotalCents(doc){
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
        const res = await api().documents.listForProject(orgId(), projectId());
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
              ${String(capabilityEnabled('documents.ingestion') ? `<label class="fmdx-btn fmdx-upload-btn"><i class="fas fa-arrow-up-from-bracket"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_9ca9dace4f122f"," Upload") ?? " Upload")}<input type="file" data-fmdx-upload accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,application/pdf,image/*" multiple></label>` : '')}
              <button type="button" class="fmdx-btn primary" data-fmdx-new><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_7754e23bbfc088"," New document") ?? " New document")}</button>
            </div>
          </header>
          <div class="fmdx-body" data-fmdx-list></div>
        </div>`;
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
          ${String(statusChip(doc.status))}
          <div class="fmdx-doc-actions">
            <button type="button" class="fmdx-btn" data-doc-open-btn><i class="fas ${String(readOnly ? 'fa-eye' : 'fa-pen')}"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_c47557fbf9d3f5"," Open") ?? " Open")}</button>
            <button type="button" class="fmdx-icon-btn" data-doc-preview title="${(globalThis.PlatformLanguage?.htmlText("documents","m_afff48796c3165","Preview") ?? "Preview")}"><i class="fas fa-eye"></i></button>
            <button type="button" class="fmdx-icon-btn" data-doc-send title="${(globalThis.PlatformLanguage?.htmlText("documents","m_c23a056552a09f","Send") ?? "Send")}"><i class="fas fa-paper-plane"></i></button>
            <button type="button" class="fmdx-icon-btn" data-doc-pdf title="${(globalThis.PlatformLanguage?.htmlText("documents","m_4944e59816b60a","Download PDF") ?? "Download PDF")}"><i class="fas fa-file-pdf"></i></button>
            <button type="button" class="fmdx-icon-btn" data-doc-duplicate title="${(globalThis.PlatformLanguage?.htmlText("documents","m_24fc1d3519ef6a","Duplicate") ?? "Duplicate")}"><i class="fas fa-copy"></i></button>
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
            ${String(reviewed ? '' : `<button type="button" class="fmdx-btn primary" data-upload-confirm><i class="fas fa-circle-check"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_a213af3a6be2cc"," Confirm &amp; apply") ?? " Confirm &amp; apply")}</button>`)}
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
              outputs: outputsPayload()
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
      toggle.hidden = !state.docWorkflow || isReadOnlyStatus(state.doc?.status);
      toggle.querySelectorAll('[data-fmdx-mode]').forEach((button) => {
        button.classList.toggle('active', cleanText(button.dataset.fmdxMode) === state.docView);
      });
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
        // Native step-1 vocabulary (piece_select cards).
        pieceCatalog: () => loadPieceCatalog(),
        // Native line-items generation (line_items_review + measurement-key
        // derivation): the legacy module's exported generation, pricebook
        // hydrated first so formulas resolve (see generateScopeItemsForSelection).
        generateScopeItems: async (selection, measurements) => {
          try { await Promise.resolve(pricebookModule()?.loadState?.()); } catch (e) { /* formulas fall back */ }
          return generateScopeItemsForSelection(selection, measurements);
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
          url: (mediaId) => window.PlatformAPI?.media?.thumbnailUrl?.(orgId(), mediaId, 320) || ''
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
          onStepState: (stepState) => persistWorkflowStepState(stepState),
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
        host.innerHTML = `<div class="fmdx-inline-wrap"><div class="fmdx-modal">${contentHtml}</div></div>`;
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
        modal = openModal(contentHtml, { onClose: options.onClose });
      }
      const body = modal.el.querySelector('[data-create-body]');
      const [catalog, templates] = await Promise.all([loadCatalog(), loadTemplates(true)]);
      if (!modal.el.isConnected) return;
      const wizard = { type: cleanText(prefill.document_type).toLowerCase(), template: null };

      function typesList(){
        const types = arrayValue(catalog.types);
        if (types.length) return types;
        return Object.keys(TYPE_META).filter((k) => k !== 'receipt').map((id) => ({ id, label: typeMeta(id).label, icon: TYPE_META[id].icon }));
      }

      function renderStepOne(){
        const types = typesList();
        const typeCards = types.map((type) => {
          const id = firstText(type.id, type.type);
          const meta = typeMeta(id, types);
          return `<button type="button" class="fmdx-pick-card ${wizard.type === id ? 'selected' : ''}" data-pick-type="${esc(id)}">
              <span class="fmdx-pick-icon"><i class="fas ${esc(meta.icon)}"></i></span>
              <strong>${esc(meta.label)}</strong>
            </button>`;
        }).join('');
        const typeTemplates = wizard.type
          ? arrayValue(templates).filter((t) => cleanText(t.document_type) === wizard.type && cleanText(t.status).toLowerCase() !== 'archived')
          : [];
        const templateCards = wizard.type ? `
          <p class="fmdx-section-label">${(globalThis.PlatformLanguage?.htmlText("documents","m_587d96db750df7","Template") ?? "Template")}</p>
          <div class="fmdx-pick-grid">
            <button type="button" class="fmdx-pick-card ${String(wizard.template === null ? 'selected' : '')}" data-pick-template="">
              <span class="fmdx-pick-icon"><i class="fas fa-file"></i></span>
              <strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_7860b2aaae1cb5","Blank") ?? "Blank")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("documents","m_16e49e1ae8de06","Start from an empty page") ?? "Start from an empty page")}</small>
            </button>
            ${String(typeTemplates.map((tpl) => {
              const isUpload = cleanText(objectValue(tpl.metadata).intake) === 'upload';
              return `
              <button type="button" class="fmdx-pick-card ${wizard.template?.id === tpl.id ? 'selected' : ''}" data-pick-template="${esc(tpl.id)}">
                <span class="fmdx-pick-icon"><i class="fas ${isUpload ? 'fa-file-arrow-up' : 'fa-file-invoice'}"></i></span>
                <strong>${esc(firstText(tpl.name, 'Template'))}</strong>
                <small>${isUpload ? 'Paper upload — the agent extracts the fields' : esc(firstText(tpl.description, `v${tpl.current_version || 1}`))}</small>
              </button>`;
            }).join(''))}
            <button type="button" class="fmdx-pick-card ${String(wizard.template === '__upload__' ? 'selected' : '')}" data-pick-template="__upload__">
              <span class="fmdx-pick-icon"><i class="fas fa-arrow-up-from-bracket"></i></span>
              <strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_38387e00ca292b","Upload a paper contract") ?? "Upload a paper contract")}</strong>
              <small>${(globalThis.PlatformLanguage?.htmlText("documents","m_c67e5a6a1dff96","Free-form — scan or photo; add fields during review") ?? "Free-form — scan or photo; add fields during review")}</small>
            </button>
          </div>` : '';
        body.innerHTML = `
          <p class="fmdx-section-label">${(globalThis.PlatformLanguage?.htmlText("documents","m_61cd09102e4af8","Document type") ?? "Document type")}</p>
          <div class="fmdx-pick-grid" style="margin-bottom:14px">${String(typeCards)}</div>
          ${String(templateCards)}
          <div class="fmdx-modal-foot">
            <button type="button" class="fmdx-btn primary" data-create-next ${String(wizard.type ? '' : 'disabled')}>${(globalThis.PlatformLanguage?.htmlText("documents","m_854c72abba5166","Continue ") ?? "Continue ")}<i class="fas fa-arrow-right"></i></button>
          </div>`;
        body.querySelectorAll('[data-pick-type]').forEach((btn) => btn.addEventListener('click', () => {
          wizard.type = btn.dataset.pickType;
          wizard.template = null;
          renderStepOne();
        }));
        body.querySelectorAll('[data-pick-template]').forEach((btn) => btn.addEventListener('click', () => {
          const id = btn.dataset.pickTemplate;
          wizard.template = id === '__upload__' ? '__upload__' : (id ? typeTemplates.find((t) => cleanText(t.id) === id) || null : null);
          renderStepOne();
        }));
        body.querySelector('[data-create-next]')?.addEventListener('click', async (event) => {
          const button = event.currentTarget;
          // Paper uploads skip creation entirely: pick a file, ingest, review.
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
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Preparing…';
            const started = await tryWorkflowFirstCreate(workflowHint);
            if (started || !modal.el.isConnected) return;
            button.disabled = false;
            button.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
          }
          renderStepTwo();
        });
      }

      /** Workflow id declared by the picked template or the catalog type. */
      function createWorkflowHint(){
        const catalogType = arrayValue(catalog.types).find((t) => firstText(t.id, t.type) === wizard.type) || {};
        return firstText(
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
          const runtime = await ensureWorkflowRuntime();
          if (!runtime) return false;
          let record = null;
          if (api().workflows?.get) {
            try { record = normalizeWorkflowRecord(await api().workflows.get(orgId(), workflowId)); }
            catch (error) { record = null; }
          }
          if (!record) return false; // route/definition missing → params form
          if (!modal.el.isConnected) return true;
          // Defaults only — the workflow gathers everything else.
          const catalogType = arrayValue(catalog.types).find((t) => firstText(t.id, t.type) === wizard.type) || {};
          const templateDef = wizard.template ? await templateDefinition(wizard.template) : null;
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
          // Prefer the server-attached workflow (it may carry saved state).
          state.doc = doc;
          const attached = await loadDocWorkflow();
          openWorkflowView(doc, attached || record);
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

      if (wizard.type) renderStepTwo();
      else renderStepOne();
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
      state.view = 'editor';
      state.doc = objectValue(docRecord);
      const record = objectValue(options.workflow);
      state.docWorkflow = arrayValue(objectValue(record.definition).steps).length ? record : null;
      state.docView = options.view === 'workflow' && state.docWorkflow ? 'workflow' : 'editor';
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
      if (!state.docWorkflow) loadDocWorkflow();
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
              ${String(statusChip(doc.status))}
              <span class="fmdx-save-state" data-fmdx-save-state></span>
              <div class="fmdx-mode-toggle" data-fmdx-mode-toggle hidden>
                <button type="button" data-fmdx-mode="workflow"><i class="fas fa-list-check"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_6d5cbceb09ad8e"," Workflow") ?? " Workflow")}</button>
                <button type="button" data-fmdx-mode="editor"><i class="fas fa-pen-ruler"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_cf117560db33b2"," Editor") ?? " Editor")}</button>
              </div>
              <div style="margin-left:auto;display:flex;gap:7px;align-items:center;flex-wrap:wrap">
                ${String(readOnly ? '' : `<button type="button" class="fmdx-btn ${state.dataPanelOpen ? 'active' : ''}" data-fmdx-data-toggle><i class="fas fa-database"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_afc71019d2978d"," Data") ?? " Data")}</button>`)}
                ${String(readOnly || !capabilityEnabled('documents.agent') ? '' : `<button type="button" class="fmdx-btn" data-fmdx-agent-btn><i class="fas fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_6132f8a9f6606d"," Agent") ?? " Agent")}</button>`)}
                ${String(readOnly ? '' : `<button type="button" class="fmdx-btn" data-fmdx-theme><i class="fas fa-palette"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_3f7a6d0c7b9c29"," Theme") ?? " Theme")}</button>`)}
                <button type="button" class="fmdx-btn" data-fmdx-history><i class="fas fa-clock-rotate-left"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_b78c21a6c3a083"," History") ?? " History")}</button>
                <button type="button" class="fmdx-btn" data-fmdx-preview><i class="fas fa-eye"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_a48897118cb076"," Preview") ?? " Preview")}</button>
                <button type="button" class="fmdx-btn" data-fmdx-pdf><i class="fas fa-file-pdf"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_ff8d3e1189f812"," PDF") ?? " PDF")}</button>
                ${String(readOnly && isAmendableStatus(doc.status)
                  ? `<button type="button" class="fmdx-btn primary" data-fmdx-amend><i class="fas fa-file-medical"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_4986fc99e268e8"," Amend → Change Order") ?? " Amend → Change Order")}</button>`
                  : `<button type="button" class="fmdx-btn primary" data-fmdx-send><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_c66c415b0e5570"," Send") ?? " Send")}</button>`)}
              </div>
            </header>
            ${String(readOnly ? `<div class="fmdx-locked-banner"><i class="fas fa-lock"></i>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("documents","m_a919d34f0dcde5",` This document is ${v0} and locked. ${v1}`,{v0,v1}) ?? ` This document is ${v0} and locked. ${v1}`)(esc(statusLabel.toLowerCase()),isAmendableStatus(doc.status) ? 'Amend it with a change order to make revisions.' : 'It can no longer be edited.')}</div>` : '')}
            <div class="fmdx-doc-card-row" data-fmdx-doc-card-row>
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
      root.querySelector('[data-fmdx-preview]')?.addEventListener('click', async () => {
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
    // revisions start a change order prefilled from the source document.
    function amendToChangeOrder(doc){
      const source = objectValue(doc);
      const params = objectValue(source.params);
      openCreateModal({
        document_type: 'change_order',
        title: ((v0) => globalThis.PlatformLanguage?.text("documents","m_24d875eaf00564",`Change Order — ${v0}`,{v0}) ?? `Change Order — ${v0}`)(firstText(source.title, 'Document')),
        params: {
          source_document_id: firstText(source.id),
          ...(arrayValue(params.scope_items).length ? { scope_items: clone(params.scope_items) } : {}),
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
      const el = root.querySelector('[data-fmdx-doc-card] [data-card-total]');
      if (!el) { renderDocCard(); return; }
      const total = docCardTotalCents();
      el.textContent = total ? moneyFromCents(total) : '—';
    }

    function renderDocCard(){
      const row = root.querySelector('[data-fmdx-doc-card-row]');
      const card = root.querySelector('[data-fmdx-doc-card]');
      if (!row || !card || !state.doc) return;
      const doc = state.doc;
      const readOnly = isReadOnlyStatus(doc.status);
      const meta = typeMeta(doc.document_type, state.catalog?.types);
      const params = objectValue(doc.params);
      const isProposal = cleanText(doc.document_type).toLowerCase() === 'proposal';
      const multi = isProposal && isMultiOptionDoc(doc, params);
      const filled = multi ? variantSlots(params).filter((slot) => slot.items.length) : [];
      const total = docCardTotalCents();
      card.innerHTML = `
        <div class="fmdx-doc-card-id">
          <span class="fmdx-doc-card-icon" style="--fmdx-doc-color:${String(esc(meta.color))}"><i class="fas ${String(esc(meta.icon))}"></i></span>
          <div class="fmdx-doc-card-title">
            <strong title="${String(esc(firstText(doc.title, meta.label)))}">${String(esc(firstText(doc.title, meta.label)))}</strong>
            <span class="fmdx-doc-card-sub">${String(esc(meta.label))}</span>
          </div>
          ${String(statusChip(doc.status))}
        </div>
        <div class="fmdx-doc-card-total"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_9403c7637d4905","Total") ?? "Total")}</span><b data-card-total>${String(total ? esc(moneyFromCents(total)) : '—')}</b></div>
        ${String(filled.length ? `
          <div class="fmdx-doc-card-variants">
            ${filled.map((slot) => `
              <span class="fmdx-variant-chip ${readOnly ? 'static' : ''}" data-variant-chip="${esc(slot.slot)}">
                <button type="button" class="jump" data-variant-jump="${esc(slot.slot)}" ${readOnly ? 'disabled' : ''} title="${readOnly ? esc(slot.label) : `Open ${esc(slot.label)} · double-click to rename`}">${esc(slot.label)}</button>
                ${!readOnly && slot.slot !== 'a' ? `<button type="button" class="x" data-variant-remove="${esc(slot.slot)}" title="${((v1) => globalThis.PlatformLanguage?.htmlText("documents","m_ade5cd0266b010",`Remove ${v1}`,{v1}) ?? `Remove ${v1}`)(esc(slot.label))}"><i class="fas fa-xmark"></i></button>` : ''}
              </span>`).join('')}
          </div>` : '')}
        <div class="fmdx-doc-card-actions">
          ${String(!readOnly && isProposal ? `<button type="button" class="fmdx-btn tiny" data-card-add-variant title="${multi ? 'Add another option to this proposal' : 'Turn this into a multi-option (Good/Better/Best) proposal'}"><i class="fas fa-code-branch"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_95299bfa43bab3"," Add variant") ?? " Add variant")}</button>` : '')}
          <button type="button" class="fmdx-btn tiny" data-card-duplicate title="${(globalThis.PlatformLanguage?.htmlText("documents","m_eab1f6b49f7769","Create a draft copy of this document") ?? "Create a draft copy of this document")}"><i class="fas fa-copy"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_7eec37dfa2be3f"," Duplicate") ?? " Duplicate")}</button>
        </div>`;
      card.querySelector('[data-card-duplicate]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await flushAllWrites();
          await duplicateDoc(state.doc, button);
        } finally { button.disabled = false; }
      });
      card.querySelector('[data-card-add-variant]')?.addEventListener('click', (event) => addVariant(event.currentTarget));
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
          const res = await api().documents.patch(orgId(), state.doc.id, { theme_ref: themeId ? { theme_id: themeId } : null });
          const updated = objectValue(res.document || res.doc);
          if (updated.id) state.doc = { ...state.doc, ...updated };
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

    function openHistoryMenu(anchor){
      const doc = state.doc || {};
      const menu = openMenu(anchor, '<div class="fmdx-menu-note"><div class="fmdx-spinner" style="width:16px;height:16px;border-width:2px;margin:4px auto"></div></div>');
      api().documents.snapshots(orgId(), doc.id).then((res) => {
        if (!menu.el.isConnected) return;
        const snapshots = arrayValue(res.snapshots || res.items || (Array.isArray(res) ? res : []))
          .map(objectValue)
          .sort((a, b) => Number(b.snapshot_number || 0) - Number(a.snapshot_number || 0));
        if (!snapshots.length) {
          menu.el.innerHTML = `<div class="fmdx-menu-note">${(globalThis.PlatformLanguage?.htmlText("documents","m_bb8fd5a06bd600","No snapshots yet. A snapshot freezes the document each time you send it or print a PDF.") ?? "No snapshots yet. A snapshot freezes the document each time you send it or print a PDF.")}</div>`;
          return;
        }
        menu.el.innerHTML = `
          <div class="fmdx-menu-note">${(globalThis.PlatformLanguage?.htmlText("documents","m_3f1e9a05720693","Frozen versions of this document") ?? "Frozen versions of this document")}</div>
          ${String(snapshots.map((snapshot, index) => `
            <button type="button" class="fmdx-menu-item" data-menu-snapshot="${index}">
              <i class="fas fa-camera"></i>
              <span style="min-width:0">
                <span style="display:block">#${Number(snapshot.snapshot_number || snapshots.length - index)} · ${esc(firstText(snapshot.reason, 'manual'))}</span>
                <small>${esc(firstText(timeAgo(firstText(snapshot.created_at, snapshot.captured_at, snapshot.updated_at)), ''))}</small>
              </span>
            </button>`).join(''))}`;
        menu.el.querySelectorAll('[data-menu-snapshot]').forEach((button) => button.addEventListener('click', () => {
          const snapshot = snapshots[Number(button.dataset.menuSnapshot || 0)];
          menu.close();
          if (!snapshot) return;
          if (!objectValue(snapshot.resolved_definition).pages && !objectValue(snapshot.resolved_definition).root) {
            showToast((globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("documents","m_01f4be0d7fbc03","This snapshot does not carry a renderable definition.") ?? "This snapshot does not carry a renderable definition."), false);
            return;
          }
          openPreview(state.doc, {
            title: ((v0,v1) => globalThis.PlatformLanguage?.text("documents","m_7adfd2a97b5bed",`${v0} — snapshot #${v1}`,{v0,v1}) ?? `${v0} — snapshot #${v1}`)(firstText(state.doc?.title, 'Document'),Number(snapshot.snapshot_number || 0) || ''),
            resolved: {
              resolved_definition: snapshot.resolved_definition,
              theme: objectValue(snapshot.theme),
              widget_data: objectValue(snapshot.widget_data)
            }
          });
        }));
      }).catch((error) => {
        if (menu.el.isConnected) menu.el.innerHTML = `<div class="fmdx-menu-note">${((v0) => globalThis.PlatformLanguage?.htmlText("documents","m_70b4daaf4f6666",`Snapshots unavailable: ${v0}`,{v0}) ?? `Snapshots unavailable: ${v0}`)(esc(errorMessage(error, '')))}</div>`;
      });
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
      return {
        async pick(){
          if (!window.PlatformAPI?.media?.list || !window.Portal?.PhotoFeed?.openProjectMediaPicker) throw new Error('The media tray is unavailable.');
          const response = await window.PlatformAPI.media.list(oid);
          const media = arrayValue(objectValue(response).media || objectValue(response).items).map(objectValue);
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
                const uploaded = [];
                for (const file of Array.from(files || [])) {
                  const result = await window.PlatformAPI.media.upload(oid, file, { ownerType: 'document', ownerId: firstText(state.doc?.id, projectId()), collection: 'documents' });
                  const item = objectValue(objectValue(result).media || result);
                  if (Object.keys(item).length) { media.unshift(item); uploaded.push(item); }
                }
                return { photos: uploaded, selectedIds: uploaded.map((item) => firstText(item.id, item.media_id)).filter(Boolean) };
              },
              onClose: () => finish(null)
            });
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
    function mountReadOnlyCanvas(canvas){
      if (!window.FMDocRenderer?.render) {
        canvas.innerHTML = `<div class="fmdx-state" style="margin:20px"><i class="fas fa-eye-slash"></i><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_fc865c9558abcb","Preview unavailable") ?? "Preview unavailable")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_97e3a8c68504bb","The document renderer library is not loaded.") ?? "The document renderer library is not loaded.")}</span></div>`;
        return;
      }
      canvas.innerHTML = '<div class="fmdx-readonly-scroll" data-fmdx-readonly-stage></div>';
      const stage = canvas.querySelector('[data-fmdx-readonly-stage]');
      try {
        const available = Math.max(320, stage.clientWidth - 48);
        const dims = window.FMDocModel?.paperDimensions?.(objectValue(state.resolved.resolved_definition)) || { w_pt: 612 };
        const scale = Math.min(1.25, available / (dims.w_pt * (96 / 72)));
        window.FMDocRenderer.render(stage, {
          document: state.resolved.resolved_definition,
          theme: state.resolved.theme,
          themeContext: { branding: objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding), overrides: { ...objectValue(state.resolved?.theme_vars), ...objectValue(state.doc?.theme_overrides) } },
          mode: 'static',
          widgetData: state.resolved.widget_data,
          scale
        });
      } catch (error) {
        stage.innerHTML = `<div class="fmdx-state" style="margin:20px"><i class="fas fa-triangle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_315a295c7205d8","Render failed") ?? "Render failed")}</strong><span>${String(esc(errorMessage(error, '')))}</span></div>`;
      }
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
          // Version-history checkpoints (File ▸ Version history, Tools ▸ Compare).
          versionsApi: state.doc?.id && window.DocumentsAPI?.checkpoints ? {
            list: () => window.DocumentsAPI.checkpoints.list(state.doc.id),
            get: (checkpointId) => window.DocumentsAPI.checkpoints.get(state.doc.id, checkpointId),
            create: (body) => window.DocumentsAPI.checkpoints.create(state.doc.id, body),
            diff: (a, b) => window.DocumentsAPI.checkpoints.diff(state.doc.id, a, b)
          } : null,
          // Phase-1 realtime collaboration (presence + serialized command log).
          collab: state.doc?.id && window.DocumentsAPI?.collab ? {
            actor: objectValue(window.Portal?.util?.currentActor?.()),
            connect: (handlers) => window.DocumentsAPI.collab.connect(state.doc.id, handlers)
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
      overlay.innerHTML = `
        <header class="fmdx-preview-top">
          <strong>${String(esc(firstText(options.title, doc.title, 'Document preview')))}</strong>
          <div style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span class="fmdx-preview-zoom">
              <button type="button" data-zoom-out title="${(globalThis.PlatformLanguage?.htmlText("documents","m_acf282d479dddf","Zoom out") ?? "Zoom out")}"><i class="fas fa-minus"></i></button>
              <span class="pct" data-zoom-pct>${(globalThis.PlatformLanguage?.htmlText("documents","m_2d8510904d5879","Fit") ?? "Fit")}</span>
              <button type="button" data-zoom-in title="${(globalThis.PlatformLanguage?.htmlText("documents","m_a593d968057ce9","Zoom in") ?? "Zoom in")}"><i class="fas fa-plus"></i></button>
              <button type="button" data-zoom-fit title="${(globalThis.PlatformLanguage?.htmlText("documents","m_b4e9fa5595e7cf","Fit width") ?? "Fit width")}"><i class="fas fa-arrows-left-right-to-line"></i></button>
            </span>
            <button type="button" class="fmdx-btn" data-preview-print><i class="fas fa-print"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_6331c8921612bb"," Print") ?? " Print")}</button>
            <button type="button" class="fmdx-btn" data-preview-pdf><i class="fas fa-file-pdf"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_932226afd1106e"," Download PDF") ?? " Download PDF")}</button>
            <button type="button" class="fmdx-btn" data-preview-close><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_373bd9180a7ee3"," Close") ?? " Close")}</button>
          </div>
        </header>
        <div class="fmdx-preview-scroll" data-preview-scroll>
          <div class="fmdx-preview-stage" data-preview-stage>
            <div class="fmdx-state" style="min-width:320px"><div class="fmdx-spinner"></div><strong style="color:#e7ecf5">${(globalThis.PlatformLanguage?.htmlText("documents","m_6c82cfd4965b22","Rendering preview") ?? "Rendering preview")}</strong></div>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      let rendererHandle = null;
      let zoom = 0; // 0 = fit
      const close = () => {
        try { rendererHandle?.destroy?.(); } catch (e) {}
        document.body.classList.remove('fmdx-print-mode');
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        state.previewCleanup = null;
      };
      const onKey = (event) => { if (event.key === 'Escape') close(); };
      document.addEventListener('keydown', onKey);
      state.previewCleanup = close;
      overlay.querySelector('[data-preview-close]').addEventListener('click', close);
      overlay.querySelector('[data-preview-pdf]').addEventListener('click', (event) => downloadPdf(doc, event.currentTarget));
      overlay.querySelector('[data-preview-print]').addEventListener('click', () => {
        document.body.classList.add('fmdx-print-mode');
        const done = () => { document.body.classList.remove('fmdx-print-mode'); window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done);
        window.print();
        setTimeout(done, 2000);
      });

      let resolved = objectValue(options.resolved);
      if (!resolved.resolved_definition) {
        try {
          resolved = objectValue(await api().documents.resolve(orgId(), doc.id));
        } catch (error) {
          overlay.querySelector('[data-preview-stage]').innerHTML = `<div class="fmdx-state" style="min-width:320px"><i class="fas fa-cloud-bolt"></i><strong style="color:#e7ecf5">${(globalThis.PlatformLanguage?.htmlText("documents","m_fc865c9558abcb","Preview unavailable") ?? "Preview unavailable")}</strong><span style="color:#9aa6bd">${String(esc(errorMessage(error, '')))}</span></div>`;
          return;
        }
      }
      if (!overlay.isConnected) return;

      const stage = overlay.querySelector('[data-preview-stage]');
      const scroll = overlay.querySelector('[data-preview-scroll]');
      const dims = window.FMDocModel?.paperDimensions?.(objectValue(resolved.resolved_definition)) || { w_pt: 612, h_pt: 792 };

      function currentScale(){
        if (zoom > 0) return zoom;
        const pagePx = dims.w_pt * (96 / 72);
        const available = Math.max(280, scroll.clientWidth - 44);
        return Math.min(1.4, available / pagePx);
      }
      function renderStage(){
        const scale = currentScale();
        overlay.querySelector('[data-zoom-pct]').textContent = zoom > 0 ? `${Math.round(scale * 100)}%` : 'Fit';
        try { rendererHandle?.destroy?.(); } catch (e) {}
        stage.innerHTML = '';
        try {
          rendererHandle = window.FMDocRenderer.render(stage, {
            document: resolved.resolved_definition,
            theme: resolved.theme,
            themeContext: { branding: objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding), overrides: objectValue(resolved?.theme_vars || state.resolved?.theme_vars) },
            mode: 'static',
            widgetData: resolved.widget_data,
            scale
          });
        } catch (error) {
          stage.innerHTML = `<div class="fmdx-state" style="min-width:320px"><i class="fas fa-triangle-exclamation"></i><strong style="color:#e7ecf5">${(globalThis.PlatformLanguage?.htmlText("documents","m_315a295c7205d8","Render failed") ?? "Render failed")}</strong><span style="color:#9aa6bd">${String(esc(errorMessage(error, '')))}</span></div>`;
        }
      }
      overlay.querySelector('[data-zoom-in]').addEventListener('click', () => { zoom = Math.min(2, (zoom || currentScale()) + 0.15); renderStage(); });
      overlay.querySelector('[data-zoom-out]').addEventListener('click', () => { zoom = Math.max(0.25, (zoom || currentScale()) - 0.15); renderStage(); });
      overlay.querySelector('[data-zoom-fit]').addEventListener('click', () => { zoom = 0; renderStage(); });
      renderStage();
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

    // ================================================================ send
    function openSendModal(docRecord){
      const doc = objectValue(docRecord);
      if (!doc.id) return;
      const emailValid = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanText(value));
      const contacts = projectContacts();
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
          <div class="fmdx-field wide"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_c1791596944182","Recipients") ?? "Recipients")}</span>
            <div class="fmdx-recipient-list">${String(contactRows)}</div>
          </div>
          <label class="fmdx-field wide"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_2346d86fbb7dfd","Add another email (optional)") ?? "Add another email (optional)")}</span><input type="email" data-send-extra placeholder="${(globalThis.PlatformLanguage?.htmlText("documents","m_ee9cc9ca2a8b83","name@email.com") ?? "name@email.com")}"></label>
          <label class="fmdx-field wide"><span>${(globalThis.PlatformLanguage?.htmlText("documents","m_1cc093ae43d736","Message (optional)") ?? "Message (optional)")}</span><textarea data-send-message placeholder="${(globalThis.PlatformLanguage?.htmlText("documents","m_c6b7216b3e2a6c","A short note included with the email…") ?? "A short note included with the email…")}"></textarea></label>
          <label class="fmdx-check"><input type="checkbox" data-send-portal checked>${(globalThis.PlatformLanguage?.htmlText("documents","m_948ada5da279bb"," Include portal link (view, sign & pay online)") ?? " Include portal link (view, sign & pay online)")}</label>
          <label class="fmdx-check"><input type="checkbox" data-send-pdf checked>${(globalThis.PlatformLanguage?.htmlText("documents","m_c96d1087aa82e3"," Attach PDF") ?? " Attach PDF")}</label>
        </div>
        <div class="fmdx-modal-foot">
          <button type="button" class="fmdx-btn primary" data-send-go><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_c66c415b0e5570"," Send") ?? " Send")}</button>
        </div>`, { className: 'narrow' });
      modal.el.querySelector('[data-send-go]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const recipients = [...modal.el.querySelectorAll('[data-send-contact]')]
          .filter((input) => input.checked)
          .map((input) => contacts[Number(input.dataset.sendContact || 0)])
          .filter((contact) => contact && emailValid(contact.email))
          .map((contact) => ({ name: contact.name, email: cleanText(contact.email), ...(contact.role ? { role: contact.role } : {}) }));
        const extra = cleanText(modal.el.querySelector('[data-send-extra]')?.value);
        if (extra) {
          if (!emailValid(extra)) { showToast((globalThis.PlatformLanguage?.text("documents","m_c23a056552a09f","Send") ?? "Send"), (globalThis.PlatformLanguage?.text("documents","m_878e0d319b42ce","The extra email address is not valid.") ?? "The extra email address is not valid."), false); return; }
          if (!recipients.some((r) => r.email.toLowerCase() === extra.toLowerCase())) recipients.push({ name: extra, email: extra, role: 'customer' });
        }
        if (!recipients.length) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_c23a056552a09f","Send") ?? "Send"), (globalThis.PlatformLanguage?.text("documents","m_dbf9b52b0188bd","Choose at least one recipient with a valid email address.") ?? "Choose at least one recipient with a valid email address."), false);
          return;
        }
        button.disabled = true;
        button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Sending…';
        try {
          const res = objectValue(await api().documents.send(orgId(), doc.id, {
            recipients,
            include_portal: modal.el.querySelector('[data-send-portal]')?.checked !== false,
            include_portal_link: modal.el.querySelector('[data-send-portal]')?.checked !== false,
            include_pdf: modal.el.querySelector('[data-send-pdf]')?.checked !== false,
            message: cleanText(modal.el.querySelector('[data-send-message]')?.value)
          }));
          if (state.doc?.id === doc.id) {
            const updated = objectValue(res.document);
            if (updated.id) state.doc = { ...state.doc, ...updated };
          }
          loadDocs({ silent: true });
          renderSendSuccess(modal);
        } catch (error) {
          button.disabled = false;
          button.innerHTML = '<i class="fas fa-paper-plane"></i> Send';
          showToast((globalThis.PlatformLanguage?.text("documents","m_c23a056552a09f","Send") ?? "Send"), errorMessage(error, 'Could not send the document.'), false);
        }
      });
    }

    function renderSendSuccess(modal){
      const body = modal.body;
      body.querySelectorAll(':scope > *:not(.fmdx-modal-close)').forEach((el) => el.remove());
      const wrap = document.createElement('div');
      wrap.className = 'fmdx-send-success';
      wrap.innerHTML = `
        <div class="headline"><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_73ac601e395a23"," Document sent") ?? " Document sent")}</div>
        <p class="fmdx-data-hint">${(globalThis.PlatformLanguage?.htmlText("documents","m_dd1890d2df48f8","The email is on its way.") ?? "The email is on its way.")}</p>
        <div class="fmdx-modal-foot"><button type="button" class="fmdx-btn" data-send-done>${(globalThis.PlatformLanguage?.htmlText("documents","m_8cb6b086a0e69c","Done") ?? "Done")}</button></div>`;
      body.appendChild(wrap);
      wrap.querySelector('[data-send-done]')?.addEventListener('click', () => modal.close());
    }

    // ---------------------------------------------------------------- boot
    loadCatalog();
    loadDocs();
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
