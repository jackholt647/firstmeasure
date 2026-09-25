/* public/libraries/apps/documents/studio.js
 * Doc Studio — the portal tab where org admins design document templates and
 * themes for the document engine.
 *
 * Two sub-tabs:
 *   - Templates: versioned DocModel templates grouped by document type,
 *     edited full-page in FMDocEditor's "designer" profile, with a simple
 *     param/output schema editor. Draft saves via templates.patch; Publish
 *     via templates.publish { definition, expected_version }.
 *   - Themes: token editors (colors/fonts/spacing) with a live sample-render
 *     preview via FMDocRenderer; saved/published through the themes API.
 *
 * Registered as runtime app id "documents.studio" (portalTabId
 * "documents_studio" — manifest-declared). See docs/document-engine-contracts.md.
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
  function editorActor(){
    const actor = objectValue(window.Portal?.util?.currentActor?.());
    return {
      id: firstText(actor.id, actor.user_id, actor.email, 'unknown'),
      name: firstText(actor.name, actor.display_name, actor.email, 'Unknown user'),
      email: firstText(actor.email)
    };
  }
  function mediaReference(item){
    const media = objectValue(item);
    return {
      media_id: firstText(media.media_id, media.id),
      variant: firstText(media.variant, 'original'),
      content_type: firstText(media.content_type, media.mime_type, media.type),
      name: firstText(media.name, media.filename, media.original_name, media.label),
      url: firstText(media.url, media.src, media.original_url)
    };
  }
  async function pickDocumentMedia({ organizationId, ownerType, ownerId } = {}){
    if (!window.PlatformAPI?.media?.list) throw new Error('The media library is unavailable.');
    const response = await window.PlatformAPI.media.list(organizationId);
    const media = arrayValue(objectValue(response).media || objectValue(response).items).map(objectValue);
    const openPicker = window.Portal?.PhotoFeed?.openProjectMediaPicker;
    if (typeof openPicker !== 'function') throw new Error('The media tray is unavailable.');
    return new Promise((resolve) => {
      let complete = false;
      const finish = (value) => {
        if (complete) return;
        complete = true;
        resolve(value || null);
      };
      openPicker({
        id: 'document-media-picker',
        title: (globalThis.PlatformLanguage?.text("documents","m_a02452f60b6418","Add Media") ?? "Add Media"),
        subtitle: (globalThis.PlatformLanguage?.text("documents","m_9dd0cc66d2569b","Choose an image or video from your media library.") ?? "Choose an image or video from your media library."),
        photos: media,
        getPhotos: () => media,
        multiple: false,
        imageOnly: false,
        accept: 'image/*,video/*',
        onConfirm: (chosen) => {
          const selected = objectValue(arrayValue(chosen)[0]);
          if (!firstText(selected.id, selected.media_id, selected.url, selected.src)) return false;
          finish(mediaReference(selected));
          return true;
        },
        onUpload: async (files) => {
          const uploaded = [];
          for (const file of Array.from(files || [])) {
            const result = await window.PlatformAPI.media.upload(organizationId, file, {
              ownerType: firstText(ownerType, 'document'),
              ownerId: firstText(ownerId, 'document'),
              collection: 'documents'
            });
            const item = objectValue(objectValue(result).media || result);
            if (Object.keys(item).length) {
              media.unshift(item);
              uploaded.push(item);
            }
          }
          return { photos: uploaded, selectedIds: uploaded.map((item) => firstText(item.id, item.media_id)).filter(Boolean) };
        },
        onClose: () => finish(null)
      });
    });
  }
  function timeAgo(value){
    const time = new Date(value || 0).getTime();
    if (!time) return '';
    const diff = Date.now() - time;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
    return new Date(time).toLocaleDateString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function ensureStyles(){
    const existing = document.getElementById('fmdx-documents-css');
    const link = existing || document.createElement('link');
    link.id = 'fmdx-documents-css';
    link.rel = 'stylesheet';
    try {
      const href = new URL('documents.css', SCRIPT_URL || window.location.href);
      if (SCRIPT_URL.includes('?')) href.search = SCRIPT_URL.slice(SCRIPT_URL.indexOf('?'));
      link.href = href.toString();
    } catch (e) {
      link.href = '/libraries/apps/documents/documents.css';
    }
    if (!existing) document.head.appendChild(link);
  }

  // ------------------------------------------------ readable on-primary text
  // Same approach as apps/documents/project.js (ported from
  // customer_portal.js): publish --fmdx-on-primary so primary-button text
  // stays readable when the org primary is a light color.
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
        styles.getPropertyValue('--primary'),
        styles.getPropertyValue('--fm-primary'),
        branding?.colors?.primary,
        branding?.primary,
        '#d93025'
      );
      document.documentElement.style.setProperty('--fmdx-on-primary', readableOnColor(primary));
    } catch (e) { /* keep the CSS #fff fallback */ }
  }

  // ------------------------------------------------ theme preview cards (§5)
  // Same card visuals as the project editor's theme picker; the shared CSS
  // lives in documents.css (.fmdx-theme-card / .fmdx-theme-thumb).
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
      const fill = firstText(objectValue(objectValue(node.style).fill).color, 'var(--fm-primary,var(--primary,#d93025))');
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
            <i style="background:var(--fm-primary,var(--primary,#d93025))" title="${(globalThis.PlatformLanguage?.text("documents","m_2436076ece8629","Primary") ?? "Primary")}"></i>
            <i style="background:var(--fm-accent,var(--secondary,#202124))" title="${(globalThis.PlatformLanguage?.text("documents","m_12ab6737efe605","Accent") ?? "Accent")}"></i>
            <i style="background:var(--fm-text,#111827)" title="${(globalThis.PlatformLanguage?.text("documents","m_124287f184b88b","Text") ?? "Text")}"></i>
          </span>
        </span>
      </button>`;
  }

  const TYPE_ICONS = {
    proposal: 'fa-file-signature', invoice: 'fa-file-invoice-dollar', change_order: 'fa-file-contract',
    contract: 'fa-file-pen', work_order: 'fa-clipboard-list', receipt: 'fa-receipt', generic: 'fa-file-lines'
  };

  // Folder item kinds (Marketing + custom folder tabs).
  const ITEM_TYPE_META = {
    media: { icon: 'fa-image', label: (globalThis.PlatformLanguage?.text("documents","m_49e775f365e4e6","Media") ?? "Media") },
    file: { icon: 'fa-file-arrow-up', label: (globalThis.PlatformLanguage?.text("documents","m_fa09b3f3085cdc","File") ?? "File") },
    document: { icon: 'fa-file-lines', label: (globalThis.PlatformLanguage?.text("documents","m_9c9b98b1f4e8c9","Document") ?? "Document") },
    visual_document: { icon: 'fa-object-group', label: (globalThis.PlatformLanguage?.text("documents","m_61a718221ec5f8","Visual document") ?? "Visual document") }
  };
  const FILE_EXT_ICONS = {
    pdf: 'fa-file-pdf', doc: 'fa-file-word', docx: 'fa-file-word', xls: 'fa-file-excel', xlsx: 'fa-file-excel',
    ppt: 'fa-file-powerpoint', pptx: 'fa-file-powerpoint', csv: 'fa-file-csv', zip: 'fa-file-zipper',
    mp4: 'fa-file-video', mov: 'fa-file-video', mp3: 'fa-file-audio', wav: 'fa-file-audio',
    jpg: 'fa-file-image', jpeg: 'fa-file-image', png: 'fa-file-image', webp: 'fa-file-image', svg: 'fa-file-image'
  };
  function folderItemIcon(item){
    const meta = ITEM_TYPE_META[cleanText(item?.item_type)] || ITEM_TYPE_META.file;
    if (cleanText(item?.item_type) === 'file') {
      const name = firstText(objectValue(item?.media_ref).file_name, item?.name);
      const ext = cleanText(name).split('.').pop().toLowerCase();
      return FILE_EXT_ICONS[ext] || meta.icon;
    }
    return meta.icon;
  }
  const DEFAULT_FONTS = ['Montserrat', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Poppins', 'Source Sans 3', 'Arial'];
  const PARAM_TYPES = () => arrayValue(window.FMDocModel?.PARAM_TYPES).length
    ? window.FMDocModel.PARAM_TYPES
    : ['string', 'text', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean', 'email', 'phone', 'address', 'select', 'multi_select', 'media', 'list', 'object', 'entity', 'pricebook_line', 'measurements', 'payment_schedule'];
  const OUTPUT_TYPES = () => arrayValue(window.FMDocModel?.OUTPUT_TYPES).length
    ? window.FMDocModel.OUTPUT_TYPES
    : ['signature', 'payment', 'select', 'form_values', 'value'];

  function typeLabel(id, catalogTypes){
    const key = cleanText(id).toLowerCase();
    const catalogType = arrayValue(catalogTypes).find((t) => cleanText(t.id || t.type) === key);
    return firstText(catalogType?.label, key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), 'Document');
  }
  function typeIcon(id, catalogTypes){
    const key = cleanText(id).toLowerCase();
    const catalogType = arrayValue(catalogTypes).find((t) => cleanText(t.id || t.type) === key);
    return firstText(catalogType?.icon, TYPE_ICONS[key], TYPE_ICONS.generic);
  }
  function statusChip(status){
    const key = cleanText(status).toLowerCase() || 'draft';
    const labels = { draft: 'Draft', active: 'Active', archived: 'Archived' };
    return `<span class="fmdx-chip ${esc(key)}">${esc(labels[key] || key)}</span>`;
  }

  function openModal(contentHtml, options = {}){
    const back = document.createElement('div');
    back.className = 'fmdx-modal-back';
    back.innerHTML = `<div class="fmdx-modal ${String(esc(options.className || ''))}" role="dialog" aria-modal="true">${String(contentHtml)}<button type="button" class="fmdx-modal-close" aria-label="${(globalThis.PlatformLanguage?.text("documents","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>`;
    const close = () => { back.remove(); options.onClose?.(); };
    back.querySelector('.fmdx-modal-close').addEventListener('click', close);
    back.addEventListener('mousedown', (event) => { if (event.target === back) close(); });
    document.body.appendChild(back);
    return { el: back, body: back.querySelector('.fmdx-modal'), close };
  }

  // Fallback DocModel skeleton when FMDocModel isn't loaded (never expected —
  // the manifest bundles it — but a blank screen is never acceptable).
  function blankDefinition(documentType){
    if (window.FMDocModel?.createBlankDocument || window.FMDocModel?.createDocument) {
      const create = window.FMDocModel.createBlankDocument || window.FMDocModel.createDocument;
      const doc = create({ first_page_role: 'body', metadata: { document_type: cleanText(documentType) || 'generic' } });
      return doc;
    }
    return {
      schema_version: 1,
      kind: 'document',
      settings: { paper: { size: 'letter', orientation: 'portrait' }, locale: 'en-US', base_font_pt: 11 },
      theme_ref: null,
      params: {},
      computed: {},
      outputs: {},
      assets: [],
      edit_policy: { base_profile: 'document', max_profile: 'designer', features: {}, unlock: { allowed: true } },
      metadata: { document_type: cleanText(documentType) || 'generic' },
      pages: [{ id: 'pg_1', role: 'cover', name: '', master_ref: null, repeat: null, children: [] }]
    };
  }

  // ------------------------------------------------------- sample data kit
  // Realistic stand-in entities so designers preview bindings the way a real
  // issued document will resolve them (contract §5: sample-data panel).
  const SAMPLE_PROJECT = { id: 'proj_sample', name: 'Jordan Residence Re-roof', customer_name: 'Jordan Customer', address: '123 Main Street, Springfield', status: 'sold' };
  const SAMPLE_CUSTOMER = { id: 'cust_sample', name: 'Jordan Customer', first_name: 'Jordan', last_name: 'Customer', email: 'jordan@example.com', phone: '(555) 010-1234' };
  const SAMPLE_SCOPE_ITEMS = [
    { id: 'li_1', name: 'Tear-off & disposal', description: (globalThis.PlatformLanguage?.text("documents","m_dff268d8985ff8","Remove existing roofing to the deck") ?? "Remove existing roofing to the deck"), quantity: 24, unit: 'sq', unit_price_cents: 9500, amount_cents: 228000, included: false, optional: false, selected: true, depth: 0 },
    { id: 'li_2', name: 'Architectural shingles', description: (globalThis.PlatformLanguage?.text("documents","m_436965508556bc","GAF Timberline HDZ, weathered wood") ?? "GAF Timberline HDZ, weathered wood"), quantity: 24, unit: 'sq', unit_price_cents: 32500, amount_cents: 780000, included: false, optional: false, selected: true, depth: 0 },
    { id: 'li_3', name: 'Ice & water shield', description: (globalThis.PlatformLanguage?.text("documents","m_01cc25c626b9d1","Eaves and valleys") ?? "Eaves and valleys"), quantity: 1, unit: 'ea', unit_price_cents: 0, amount_cents: 0, included: true, optional: false, selected: true, depth: 1 },
    { id: 'li_4', name: 'Ridge vent upgrade', description: '', quantity: 1, unit: 'ea', unit_price_cents: 45000, amount_cents: 45000, included: false, optional: true, selected: true, depth: 0 }
  ];

  function sampleParamsForDefs(defs){
    const out = {};
    Object.entries(objectValue(defs)).forEach(([key, rawDef]) => {
      const def = objectValue(rawDef);
      const type = cleanText(def.type).toLowerCase();
      if (def.default !== undefined) { out[key] = clone(def.default); return; }
      if (key === 'scope_items' || type === 'pricebook_line' || (type === 'list' && cleanText(objectValue(def.items).type).toLowerCase() === 'pricebook_line')) {
        out[key] = clone(SAMPLE_SCOPE_ITEMS);
        return;
      }
      switch (type) {
        case 'currency': out[key] = 1053000; break;
        case 'number': out[key] = 24; break;
        case 'percent': out[key] = 7.5; break;
        case 'boolean': out[key] = true; break;
        case 'date': out[key] = new Date().toISOString().slice(0, 10); break;
        case 'datetime': out[key] = new Date().toISOString(); break;
        case 'email': out[key] = 'jordan@example.com'; break;
        case 'phone': out[key] = '(555) 010-1234'; break;
        case 'address': out[key] = { line1: '123 Main Street', city: 'Springfield', state: 'OH', postal_code: '45501' }; break;
        case 'entity': out[key] = cleanText(def.entity).toLowerCase() === 'project' ? clone(SAMPLE_PROJECT) : clone(SAMPLE_CUSTOMER); break;
        case 'measurements': out[key] = { totalSquares: 24, ridgeLf: 86, valleyLf: 42, eaveLf: 130 }; break;
        case 'payment_schedule': out[key] = [
          { label: (globalThis.PlatformLanguage?.text("documents","m_894309a0cbf8a4","Deposit") ?? "Deposit"), amount_cents: 250000, due: 'on_acceptance' },
          { label: (globalThis.PlatformLanguage?.text("documents","m_4c3d3abe22cc64","Balance") ?? "Balance"), amount_cents: 803000, due: 'on_completion' }
        ]; break;
        case 'media': out[key] = null; break;
        case 'list': case 'multi_select': out[key] = []; break;
        case 'object': out[key] = {}; break;
        case 'text': out[key] = 'Sample paragraph text so bound copy previews realistically.'; break;
        default: out[key] = 'Sample text'; break;
      }
    });
    return out;
  }

  // Edit-policy rails carried by the template definition (spec §9.3).
  const PROFILE_OPTIONS = ['inline', 'fill', 'document', 'designer'];
  function normalizeEditPolicy(policy){
    const p = objectValue(policy);
    const features = objectValue(p.features);
    const unlock = objectValue(p.unlock);
    return {
      base_profile: PROFILE_OPTIONS.includes(cleanText(p.base_profile)) ? cleanText(p.base_profile) : 'document',
      max_profile: PROFILE_OPTIONS.includes(cleanText(p.max_profile)) ? cleanText(p.max_profile) : 'designer',
      features: {
        page_manage: features.page_manage === true,
        widget_insert: arrayValue(features.widget_insert).map(cleanText).filter(Boolean)
      },
      unlock: {
        allowed: unlock.allowed !== false,
        permission: firstText(unlock.permission)
      }
    };
  }
  function editPolicyForDefinition(policy){
    const normalized = normalizeEditPolicy(policy);
    const features = { page_manage: normalized.features.page_manage };
    if (normalized.features.widget_insert.length) features.widget_insert = normalized.features.widget_insert;
    return {
      base_profile: normalized.base_profile,
      max_profile: normalized.max_profile,
      features,
      unlock: {
        allowed: normalized.unlock.allowed,
        ...(normalized.unlock.permission ? { permission: normalized.unlock.permission } : {})
      }
    };
  }

  // A tiny fixed sample document for the theme live preview.
  function sampleDocument(role){
    const FM = window.FMDocModel;
    const textNode = (overrides) => FM?.createNode
      ? FM.createNode('text', overrides)
      : { id: `nd_${Math.random().toString(36).slice(2, 9)}`, type: 'text', frame: { x: 0, y: 0, w: 100, h: 20, z: 1 }, style: {}, visible: true, ...overrides };
    const shapeNode = (overrides) => FM?.createNode
      ? FM.createNode('shape', overrides)
      : { id: `nd_${Math.random().toString(36).slice(2, 9)}`, type: 'shape', frame: { x: 0, y: 0, w: 100, h: 20, z: 1 }, style: {}, props: { shape: 'rect' }, visible: true, ...overrides };
    const doc = blankDefinition('proposal');
    const page = doc.pages?.[0];
    if (!page) return doc;
    page.role = cleanText(role) || 'cover';
    page.children = [
      shapeNode({
        name: 'Accent bar',
        frame: { x: 42, y: 64, w: 150, h: 10, z: 1, layout: 'absolute' },
        props: { shape: 'rect' },
        style: { fill: { type: 'solid', color: 'var(--fm-primary)' }, radius: [4, 4, 4, 4] }
      }),
      textNode({
        name: 'Headline',
        frame: { x: 42, y: 92, w: 520, h: 78, z: 2, layout: 'absolute' },
        props: { blocks: [{ type: 'heading', level: 1, style_ref: 'h1', align: 'left', runs: [{ text: 'Project Proposal' }] }] }
      }),
      textNode({
        name: 'Subhead',
        frame: { x: 42, y: 176, w: 520, h: 30, z: 2, layout: 'absolute' },
        props: { blocks: [{ type: 'paragraph', style_ref: 'h2', align: 'left', runs: [{ text: 'Prepared for Jordan Customer · 123 Main Street' }] }] }
      }),
      textNode({
        name: 'Body copy',
        frame: { x: 42, y: 226, w: 520, h: 220, z: 2, layout: 'absolute' },
        props: { blocks: [{ type: 'paragraph', style_ref: 'body', align: 'left', runs: [{ text: 'This sample page previews how your theme tokens — primary and accent colors, display and body fonts, spacing — restyle every document in this workspace. Proposals, invoices, and change orders all read from the same palette, so one edit here keeps them visually in step.' }] }] }
      }),
      shapeNode({
        name: 'Footer rule',
        frame: { x: 42, y: 700, w: 528, h: 3, z: 1, layout: 'absolute' },
        props: { shape: 'rect' },
        style: { fill: { type: 'solid', color: 'var(--fm-accent)' } }
      })
    ];
    return doc;
  }

  function defaultThemeDefinition(){
    const primary = studioBrandColor('primary');
    const secondary = studioBrandColor('secondary');
    return {
      tokens: {
        colors: {
          primary: { from: 'org.branding.colors.primary', fallback: primary },
          secondary: { from: 'org.branding.colors.secondary', fallback: secondary },
          accent: { from: 'org.branding.colors.secondary', fallback: secondary },
          text: '#111827'
        },
        fonts: { display: 'Montserrat', body: 'Inter' },
        spacing: {
          page_margin_pt: 40,
          page_margin_top_pt: 40,
          page_margin_right_pt: 40,
          page_margin_bottom_pt: 40,
          page_margin_left_pt: 40,
          gap_pt: 12
        }
      },
      type_styles: {},
      page_masters: [],
      widget_skins: {}
    };
  }
  function tokenColor(token, fallback){
    if (typeof token === 'string') return token || fallback;
    return firstText(objectValue(token).fallback, fallback);
  }
  function withTokenColor(original, color){
    if (original && typeof original === 'object' && !Array.isArray(original)) return { ...original, fallback: color };
    return color;
  }
  function studioBrandColor(kind = 'primary'){
    try {
      const theme = window.Portal?.currentTheme || {};
      const css = getComputedStyle(document.documentElement);
      return firstText(css.getPropertyValue(`--${kind}`), theme[kind], kind === 'primary' ? '#d93025' : '#202124');
    } catch (e) { return kind === 'primary' ? '#d93025' : '#202124'; }
  }

  // =========================================================================
  function mountStudio(context = {}){
    ensureStyles();
    const root = context.roots?.main || context.panelRoot || context.root;
    if (!root) return { destroy(){} };

    // Readable text on primary buttons (see documents.css --fmdx-on-primary).
    syncOnPrimaryVar(root);

    const state = {
      destroyed: false,
      active: true,
      sidebarCompactRelease: null,
      tab: 'templates',              // 'templates' | 'workflows' | 'themes' | 'brand-kit' | 'folder:<id>'
      brandKit: null,
      view: 'list',                  // 'list' | 'template' | 'workflow' | 'theme' | 'folder_item'
      workflows: null,
      // folders (Marketing + custom tabs) and their items
      folders: null,
      folderItems: {},               // folderId -> items array (definition omitted)
      folderItem: null,              // item open in the folder-item editor
      folderItemDef: null,
      folderItemDirty: false,
      folderItemSaving: false,
      folderItemQueued: false,
      folderItemSaveTimer: 0,
      folderItemOpenToken: 0,
      folderItemHeader: null,
      itemEditorHandle: null,
      folderItemAgent: null,
      pendingFolderItemAgentTask: null,
      // workflow editor
      workflow: null,
      workflowDef: null,
      workflowDirty: false,
      workflowEditorHandle: null,    // FMWorkflowEditor (thin FMVisualEditor wrapper)
      workflowAgent: null,           // FMDocAgentPanel handle
      catalog: null,
      templates: null,
      themes: null,
      loading: false,
      loadError: null,
      listLoadToken: 0,
      listRetryTimer: 0,
      listRetryAttempt: 0,
      typeFilter: '',                // template list filter chip
      // template editor
      template: null,
      definition: null,
      editorHandle: null,
      dirty: false,
      schemaPanelHost: null,         // Setup tab host inside the editor tray
      templateAgent: null,           // FMDocAgentPanel handle (template editor)
      pendingAgentBrief: null,       // "Describe it" kickoff from the New modals
      paramRows: [],
      outputRows: [],
      sampleParams: null,            // sample data feeding resolveScope
      editPolicy: null,              // normalized edit_policy rails
      // theme editor
      theme: null,
      themeDef: null,
      themeDirty: false,
      themePreviewHandle: null,
      themePreviewTimer: 0,
      themePreviewRole: 'cover'      // page-master role previewed
    };

    const orgId = () => firstText(context.orgId, window.Portal?.cfg?.userOrgId, window.__APP?.userOrgId, window.__APP?.orgId);
    const api = () => window.DocumentsAPI;
    const folderItemTopbarOwner = `documents.studio.folder-item.${context.instanceId || 'main'}`;

    function capabilityEnabled(key){
      const caps = context.capabilities?.current?.() || window.Portal?.capabilities?.current?.() || null;
      if (caps?.effective_by_key && Object.prototype.hasOwnProperty.call(caps.effective_by_key, key)) return caps.effective_by_key[key] === true;
      const catalogCaps = objectValue(state.catalog?.capabilities);
      return catalogCaps[key] === true;
    }

    function studioRouteForTab(tab, extra = {}){
      const value = cleanText(tab);
      const folderId = value.startsWith('folder:') ? value.slice('folder:'.length) : '';
      return {
        studioSection: folderId ? 'folder' : (['templates', 'workflows', 'themes', 'brand-kit'].includes(value) ? value : 'templates'),
        studioFolder: folderId || null,
        studioDocument: null,
        ...extra
      };
    }

    function writeStudioRoute(tab, extra = {}, options = {}){
      const navigation = window.Portal?.navigation;
      if (!navigation || navigation.applying) return;
      const patch = studioRouteForTab(tab, extra);
      const method = options.replace ? 'replace' : 'push';
      navigation[method]?.(patch, {
        source: options.source || 'documents-studio',
        ownedKeys: ['studioSection', 'studioFolder', 'studioDocument']
      });
    }

    function requestEditorSidebar(){
      if (state.active === false || state.sidebarCompactRelease) return;
      const release = window.Portal?.sidebarMode?.requestCompact?.('documents.studio.editor');
      if (typeof release === 'function') state.sidebarCompactRelease = release;
    }

    function releaseEditorSidebar(){
      const release = state.sidebarCompactRelease;
      state.sidebarCompactRelease = null;
      try {
        if (release) release();
        else window.Portal?.sidebarMode?.releaseCompact?.('documents.studio.editor');
      } catch (error) { console.warn('Could not restore the portal sidebar', error); }
    }

    // ------------------------------------------------------------- loading
    async function loadCatalog(){
      if (state.catalog) return state.catalog;
      try {
        const res = await api().catalog.get(orgId());
        const data = objectValue(res.catalog) && Object.keys(objectValue(res.catalog)).length ? res.catalog : res;
        state.catalog = {
          widgets: arrayValue(data.widgets),
          types: arrayValue(data.types),
          themes: arrayValue(data.themes),
          fonts: arrayValue(data.fonts),
          itemKinds: arrayValue(data.item_kinds),
          sources: arrayValue(data.sources),
          capabilities: objectValue(data.capabilities)
        };
      } catch (error) {
        state.catalog = { widgets: [], types: [], themes: arrayValue(state.themes), fonts: [], itemKinds: [], sources: [], capabilities: {} };
        console.warn('Documents catalog unavailable', error);
      }
      return state.catalog;
    }

    const MARKETING_FOLDER_ID = 'docfld_marketing';

    function completeFolderResponse(response){
      const payload = objectValue(response);
      const folders = arrayValue(payload.folders || payload.items).map(objectValue);
      const declaredCount = Number(payload.count);
      if (Number.isFinite(declaredCount) && declaredCount !== folders.length) {
        throw new Error(`Incomplete folder response (${folders.length} of ${declaredCount})`);
      }
      const hasMarketing = folders.some((folder) => (
        cleanText(folder.id) === MARKETING_FOLDER_ID
        || cleanText(folder.key).toLowerCase() === 'marketing'
      ));
      if (!hasMarketing) throw new Error('Incomplete folder response (Marketing is missing)');
      return folders;
    }

    async function loadCompleteFolderList(){
      if (!api()?.folders?.list) throw new Error('The document folder service is unavailable.');
      let lastError = null;
      // The API seeds Marketing before listing. A response without it is an
      // incomplete startup response, never an authoritative empty folder list.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return completeFolderResponse(await api().folders.list(orgId()));
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
        }
      }
      throw lastError || new Error('Could not load document folders.');
    }

    function scheduleListRetry(){
      if (state.destroyed || state.listRetryTimer) return;
      const delay = Math.min(5000, 250 * Math.pow(2, Math.min(state.listRetryAttempt, 5)));
      state.listRetryAttempt += 1;
      state.listRetryTimer = window.setTimeout(() => {
        state.listRetryTimer = 0;
        if (!state.destroyed && state.active && state.view === 'list') loadLists();
      }, delay);
    }

    async function loadLists(){
      if (!api()) { state.loadError = { missing: true }; render(); return; }
      const loadToken = ++state.listLoadToken;
      if (state.listRetryTimer) {
        clearTimeout(state.listRetryTimer);
        state.listRetryTimer = 0;
      }
      state.loading = true;
      render();
      try {
        let themeLoadError = null;
        const [tplRes, themeRes, workflowRes, folders] = await Promise.all([
          api().templates.list(orgId()),
          api().themes.list(orgId()).catch((error) => { themeLoadError = error; return null; }),
          api().workflows.list(orgId()).catch(() => ({ workflows: [] })),
          loadCompleteFolderList()
        ]);
        // Mount and activation can legitimately overlap. Only the newest
        // request may publish its snapshot; an older response must never erase
        // folders returned by a newer one.
        if (loadToken !== state.listLoadToken || state.destroyed) return;
        state.templates = arrayValue(tplRes.templates || tplRes.items).map(objectValue);
        if (themeRes) state.themes = arrayValue(themeRes.themes || themeRes.items).map(objectValue);
        else {
          const catalog = await loadCatalog();
          state.themes = arrayValue(catalog?.themes).map(objectValue);
          console.warn('Theme list unavailable; using the document catalog fallback', themeLoadError);
        }
        state.workflows = arrayValue(workflowRes.workflows || workflowRes.items).map(objectValue);
        state.folders = folders;
        state.loadError = null;
        state.listRetryAttempt = 0;
      } catch (error) {
        if (loadToken !== state.listLoadToken || state.destroyed) return;
        state.loadError = error;
        state.templates = state.templates || [];
        state.themes = state.themes || [];
        scheduleListRetry();
      } finally {
        if (loadToken !== state.listLoadToken || state.destroyed) return;
        state.loading = false;
        render();
      }
    }

    async function templateDefinition(template){
      if (objectValue(template?.definition).pages || objectValue(template?.definition).root) return clone(template.definition);
      try {
        const detail = await api().templates.get(orgId(), template.id);
        const record = objectValue(detail.template || detail);
        if (objectValue(record.definition).pages || objectValue(record.definition).root) return clone(record.definition);
        const version = Number(record.current_version || template.current_version || 0);
        if (version > 0) {
          const res = await api().templates.version(orgId(), template.id, version);
          const versionRecord = objectValue(res.version || res.template_version || res);
          if (objectValue(versionRecord.definition).pages || objectValue(versionRecord.definition).root) return clone(versionRecord.definition);
        }
      } catch (error) { console.warn('Template definition unavailable', error); }
      return null;
    }

    async function themeDefinition(theme){
      if (Object.keys(objectValue(theme?.definition)).length) return clone(theme.definition);
      try {
        const detail = await api().themes.get(orgId(), theme.id);
        const record = objectValue(detail.theme || detail);
        if (Object.keys(objectValue(record.definition)).length) return clone(record.definition);
      } catch (error) { console.warn('Theme definition unavailable', error); }
      return null;
    }

    // -------------------------------------------------------------- render
    function render(){
      if (state.destroyed) return;
      if (state.view === 'workflow' && !capabilityEnabled('documents.workflow_authoring')) { state.view = 'list'; state.tab = 'templates'; }
      if (state.view === 'theme' && !capabilityEnabled('documents.theme_authoring')) { state.view = 'list'; state.tab = 'templates'; }
      if (state.view === 'template') { renderTemplateEditor(); return; }
      if (state.view === 'workflow') { renderWorkflowEditor(); return; }
      if (state.view === 'theme') { renderThemeEditor(); return; }
      if (state.view === 'folder_item') { renderFolderItemEditor(); return; }
      renderLists();
    }

    function isFolderTab(){ return cleanText(state.tab).startsWith('folder:'); }
    function currentFolder(){
      if (!isFolderTab()) return null;
      const id = cleanText(state.tab).slice('folder:'.length);
      return arrayValue(state.folders).find((f) => cleanText(f.id) === id) || null;
    }
    // The "+" (create custom folders) is the only flag-gated surface; only an
    // explicit false denies — capability definitions may not be loaded yet.
    function canCreateFolders(){
      return capabilityEnabled('documents.custom_folders');
    }

    const BRAND_FONTS = ['Montserrat', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Poppins', 'Source Sans 3', 'Arial'];
    const brandBranchId = () => firstText(context.branchId, window.Portal?.cfg?.userBranchId, window.__APP?.userBranchId, 'default');
    const brandHex = (value, fallback) => /^#[0-9a-f]{6}$/i.test(cleanText(value)) ? cleanText(value).toUpperCase() : fallback;
    async function loadBrandKit(){
      const platform = window.PlatformAPI;
      if (!platform?.branches?.get || !platform?.branchModules?.get) throw new Error('Company branding service is unavailable.');
      const [portal, branchRes, styleRes] = await Promise.all([
        platform.orgs.portalState(orgId()),
        platform.branches.get(orgId(), brandBranchId()),
        platform.branchModules.get(orgId(), brandBranchId(), 'presentation_style')
      ]);
      const globalBrand = objectValue(objectValue(objectValue(portal.global).data).branding);
      const orgBrand = objectValue(objectValue(objectValue(portal.organization).data).branding);
      const branchResponse = objectValue(branchRes);
      const branch = objectValue(objectValue(branchResponse.document).data || branchResponse.data);
      const style = objectValue(objectValue(styleRes).data);
      const brand = { ...globalBrand, ...orgBrand, ...objectValue(branch.branding), ...objectValue(style.branding) };
      const colors = { ...objectValue(globalBrand.colors), ...objectValue(orgBrand.colors), ...objectValue(objectValue(branch.branding).colors), ...objectValue(objectValue(style.branding).colors) };
      const typography = { ...objectValue(globalBrand.typography), ...objectValue(orgBrand.typography), ...objectValue(objectValue(branch.branding).typography), ...objectValue(objectValue(style.branding).typography) };
      const primary = brandHex(colors.primary || colors.accent, '#D93025');
      const secondary = brandHex(colors.secondary, '#202124');
      const palette = arrayValue(colors.palette).slice(0, 6).map((color, index) => brandHex(color, index ? secondary : primary));
      while (palette.length < 6) palette.push([primary, secondary, '#E8E8E8', '#A0A0A0', '#666666', '#202124'][palette.length]);
      palette[0] = primary; palette[1] = secondary;
      state.brandKit = { primary, secondary, palette, font: firstText(typography.document_font_family, objectValue(style.proposal_defaults).font_family, style.proposal_font_family, 'Montserrat'), logo: firstText(brand.logo, brand.logo_node_url), branch, style, global: objectValue(objectValue(portal.global).data) };
      if (!state.destroyed && state.tab === 'brand-kit') render();
    }
    function renderBrandKit(body){
      const kit = state.brandKit;
      if (!kit) {
        body.innerHTML = '<div class="fmdx-state"><div class="fmdx-spinner"></div><strong>Loading Brand Kit</strong></div>';
        loadBrandKit().catch((error) => { body.innerHTML = `<div class="fmdx-state"><strong>Could not load Brand Kit</strong><span>${esc(errorMessage(error))}</span><button class="fmdx-btn" data-brand-retry>Retry</button></div>`; body.querySelector('[data-brand-retry]')?.addEventListener('click', () => renderBrandKit(body)); });
        return;
      }
      body.innerHTML = `<div class="fmdx-brand-kit">
        <header class="fmdx-brand-head"><div><h2>Brand Kit</h2><p>Shared with Company Information. These styles are the starting point for new documents and themes.</p></div><button type="button" class="fmdx-btn primary" data-brand-save><i class="fas fa-save"></i> Save</button></header>
        <div class="fmdx-brand-status" role="status"></div>
        <div class="fmdx-brand-grid">
          <section class="fmdx-brand-card"><h3>Color palette</h3><div class="fmdx-brand-card-body"><div class="fmdx-brand-swatches">${kit.palette.map((color, index) => `<label><span>${['Primary · UI','Secondary · UI','Supporting 1','Supporting 2','Supporting 3','Supporting 4'][index]}</span><input type="color" data-brand-color="${index}" value="${esc(color)}"><input class="fmdx-brand-hex" data-brand-hex="${index}" value="${esc(color)}" maxlength="7" spellcheck="false"></label>`).join('')}</div></div></section>
          <section class="fmdx-brand-card"><h3>Logo</h3><div class="fmdx-brand-card-body"><div class="fmdx-brand-logo">${kit.logo ? `<img src="${esc(kit.logo)}" alt="Company logo">` : '<span>No logo uploaded</span>'}</div><label class="fmdx-btn" for="fmdxBrandLogo"><i class="fas fa-upload"></i> Replace logo</label><input id="fmdxBrandLogo" type="file" accept="image/*" hidden><p>Transparent PNG or SVG works best.</p></div></section>
          <section class="fmdx-brand-card"><h3>Company font</h3><div class="fmdx-brand-card-body"><label class="fmdx-field"><span>Font family</span><select data-brand-font>${BRAND_FONTS.map((font) => `<option value="${esc(font)}" ${kit.font === font ? 'selected' : ''}>${esc(font)}</option>`).join('')}</select></label><p>Default font for new documents and templates.</p></div></section>
        </div></div>`;
      const status = body.querySelector('.fmdx-brand-status');
      body.querySelectorAll('[data-brand-color]').forEach((input) => input.addEventListener('input', () => { body.querySelector(`[data-brand-hex="${input.dataset.brandColor}"]`).value = input.value.toUpperCase(); }));
      body.querySelectorAll('[data-brand-hex]').forEach((input) => input.addEventListener('change', () => { const index = Number(input.dataset.brandHex); const color = brandHex(input.value, kit.palette[index]); input.value = color; body.querySelector(`[data-brand-color="${index}"]`).value = color; }));
      body.querySelector('[data-brand-save]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const palette = Array.from(body.querySelectorAll('[data-brand-color]')).map((input) => input.value.toUpperCase());
        const font = body.querySelector('[data-brand-font]').value;
        button.disabled = true; status.textContent = 'Saving…';
        try {
          const colors = { primary:palette[0], secondary:palette[1], accent:palette[0], palette };
          const typography = { document_font_family:font };
          const branch = kit.branch;
          const style = kit.style;
          await window.PlatformAPI.branches.save(orgId(), brandBranchId(), { ...branch, branding:{ ...objectValue(branch.branding), colors:{ ...objectValue(objectValue(branch.branding).colors), ...colors }, typography:{ ...objectValue(objectValue(branch.branding).typography), ...typography } } }, { source:'doc_studio_brand_kit' });
          await window.PlatformAPI.branchModules.save(orgId(), brandBranchId(), 'presentation_style', { ...style, branding:{ ...objectValue(style.branding), colors:{ ...objectValue(objectValue(style.branding).colors), ...colors }, typography:{ ...objectValue(objectValue(style.branding).typography), ...typography } } }, { kind:'branch_presentation_style', source:'doc_studio_brand_kit' });
          kit.primary = palette[0]; kit.secondary = palette[1]; kit.palette = palette; kit.font = font;
          kit.branch = { ...branch, branding:{ ...objectValue(branch.branding), colors, typography } };
          kit.style = { ...style, branding:{ ...objectValue(style.branding), colors, typography } };
          document.documentElement.style.setProperty('--primary', palette[0]);
          document.documentElement.style.setProperty('--fm-primary', palette[0]);
          syncOnPrimaryVar(root);
          status.textContent = 'Saved';
          showToast('Brand Kit', 'Company brand settings saved.');
        } catch (error) { status.textContent = errorMessage(error, 'Could not save Brand Kit.'); showToast('Brand Kit', status.textContent, false); }
        finally { button.disabled = false; }
      });
      body.querySelector('#fmdxBrandLogo').addEventListener('change', async (event) => {
        const file = event.target.files?.[0]; if (!file) return;
        status.textContent = 'Uploading logo…';
        try {
          const uploaded = await window.PlatformAPI.media.upload(orgId(), file, { ownerType:'organization', ownerId:orgId(), slot:'logo', collection:'branding' });
          const mediaId = firstText(objectValue(uploaded.media).id, objectValue(uploaded.media).media_id);
          if (!mediaId) throw new Error('Logo upload returned no media ID.');
          const logo = `/v1/platform/organizations/${encodeURIComponent(orgId())}/media/${encodeURIComponent(mediaId)}/logo`;
          await window.PlatformAPI.orgs.patchGlobal(orgId(), { branding:{ ...kit.global.branding, logo, logo_node_url:logo } });
          await window.PlatformAPI.branches.save(orgId(), brandBranchId(), { ...kit.branch, branding:{ ...objectValue(kit.branch.branding), logo } }, { source:'doc_studio_brand_kit' });
          if (kit.style.branding?.logo) await window.PlatformAPI.branchModules.save(orgId(), brandBranchId(), 'presentation_style', { ...kit.style, branding:{ ...objectValue(kit.style.branding), logo } }, { kind:'branch_presentation_style', source:'doc_studio_brand_kit' });
          kit.logo = logo; kit.branch.branding = { ...objectValue(kit.branch.branding), logo }; kit.global.branding = { ...objectValue(kit.global.branding), logo, logo_node_url:logo };
          renderBrandKit(body);
          showToast('Brand Kit', 'Company logo saved.');
        } catch (error) { status.textContent = errorMessage(error, 'Could not upload logo.'); showToast('Brand Kit', status.textContent, false); }
      });
    }
    async function applyFontToBlankDocument(definition){
      const styleResult = state.brandKit?.style ? null : await window.PlatformAPI.branchModules.get(orgId(), brandBranchId(), 'presentation_style').catch(() => null);
      const style = state.brandKit?.style || objectValue(objectValue(styleResult).data);
      const font = firstText(objectValue(objectValue(style.branding).typography).document_font_family, objectValue(style.proposal_defaults).font_family, style.proposal_font_family, 'Montserrat');
      const styles = objectValue(definition.styles);
      const names = Object.keys(styles).length ? Object.keys(styles) : ['Normal text', 'Title', 'Subtitle', 'Heading 1', 'Heading 2', 'Heading 3'];
      definition.styles = { ...styles };
      names.forEach((name) => { const current = objectValue(styles[name]); definition.styles[name] = { ...current, font:{ ...objectValue(current.font), family:font } }; });
      return definition;
    }

    function renderLists(){
      // A deleted/archived folder can leave a stale folder tab selected.
      if (isFolderTab() && Array.isArray(state.folders) && !currentFolder()) state.tab = 'templates';
      const canAuthorWorkflows = capabilityEnabled('documents.workflow_authoring');
      const canAuthorThemes = capabilityEnabled('documents.theme_authoring');
      if (state.tab === 'workflows' && !canAuthorWorkflows) state.tab = 'templates';
      if (state.tab === 'themes' && !canAuthorThemes) state.tab = 'templates';
      const folders = arrayValue(state.folders).filter((folder) => folder.system === true || canCreateFolders());
      root.innerHTML = `
        <div class="fmdx-shell">
          <header class="fmdx-top">
            <div class="fmdx-top-title">
              <strong><i class="fas fa-pen-ruler" style="color:var(--fmdx-primary)"></i>${(globalThis.PlatformLanguage?.text("documents","m_817205ba789887"," Doc Studio") ?? " Doc Studio")}</strong>
              <span>${(globalThis.PlatformLanguage?.text("documents","m_267b761027be3d","Design the templates and themes behind every document your team sends") ?? "Design the templates and themes behind every document your team sends")}</span>
            </div>
            <div class="fmdx-top-actions">
              ${String(capabilityEnabled('documents.advanced_definition_editing') ? '<button type="button" class="fmdx-btn" data-document-modules>Document modules</button>' : '')}
              ${String(isFolderTab()
                ? '<button type="button" class="fmdx-btn primary" data-new-folder-item><i class="fas fa-plus"></i> New</button>'
                : state.tab === 'templates'
                  ? '<button type="button" class="fmdx-btn primary" data-new-template><i class="fas fa-plus"></i> New template</button>'
                  : state.tab === 'workflows' && canAuthorWorkflows
                    ? '<button type="button" class="fmdx-btn primary" data-new-workflow><i class="fas fa-plus"></i> New workflow</button>'
                    : state.tab === 'themes' && canAuthorThemes
                      ? '<button type="button" class="fmdx-btn primary" data-new-theme><i class="fas fa-plus"></i> New theme</button>'
                      : '')}
            </div>
          </header>
          <div class="fmdx-subtabs">
            <button type="button" class="fmdx-subtab ${String(state.tab === 'templates' ? 'active' : '')}" data-tab="templates"><i class="fas fa-file-invoice"></i>${(globalThis.PlatformLanguage?.text("documents","m_2244ba6af1dcfc"," Templates") ?? " Templates")}</button>
            ${String(canAuthorWorkflows ? `<button type="button" class="fmdx-subtab ${state.tab === 'workflows' ? 'active' : ''}" data-tab="workflows"><i class="fas fa-list-check"></i> Workflows</button>` : '')}
            ${String(canAuthorThemes ? `<button type="button" class="fmdx-subtab ${state.tab === 'themes' ? 'active' : ''}" data-tab="themes"><i class="fas fa-palette"></i> Themes</button>` : '')}
            ${String(folders.map((folder) => `
              <button type="button" class="fmdx-subtab ${state.tab === `folder:${cleanText(folder.id)}` ? 'active' : ''}" data-tab="folder:${esc(folder.id)}">
                <i class="fas ${esc(firstText(folder.icon, 'fa-folder'))}"></i> ${esc(firstText(folder.label, 'Folder'))}
                ${folder.system === true ? '' : `<span class="fmdx-subtab-kebab" role="button" tabindex="0" data-folder-menu="${esc(folder.id)}" title="Folder actions" aria-label="Actions for ${esc(firstText(folder.label, 'folder'))}"><i class="fas fa-ellipsis"></i></span>`}
              </button>`).join(''))}
            <button type="button" class="fmdx-subtab fmdx-brand-tab ${String(state.tab === 'brand-kit' ? 'active' : '')}" data-tab="brand-kit"><i class="fas fa-swatchbook"></i> Brand Kit</button>
            ${String(canCreateFolders() ? '<button type="button" class="fmdx-subtab fmdx-subtab-add" data-new-folder title="New folder" aria-label="New folder"><i class="fas fa-plus"></i></button>' : '')}
          </div>
          <div class="fmdx-body" data-studio-body></div>
        </div>`;
      root.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'brand-kit') state.brandKit = null;
        state.tab = btn.dataset.tab;
        writeStudioRoute(state.tab, {}, { source:'documents-studio-tab' });
        render();
      }));
      root.querySelectorAll('[data-folder-menu]').forEach((el) => {
        const folder = folders.find((f) => cleanText(f.id) === el.dataset.folderMenu);
        if (!folder) return;
        const open = (event) => {
          event.stopPropagation();
          event.preventDefault();
          openFolderActionsMenu(el, folder);
        };
        el.addEventListener('click', open);
        el.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') open(event); });
      });
      root.querySelector('[data-new-folder]')?.addEventListener('click', () => openNewFolderModal());
      root.querySelector('[data-new-folder-item]')?.addEventListener('click', () => { const folder = currentFolder(); if (folder) openNewFolderItemModal(folder); });
      root.querySelector('[data-new-template]')?.addEventListener('click', () => openNewTemplateModal());
      root.querySelector('[data-new-workflow]')?.addEventListener('click', () => openNewWorkflowModal());
      root.querySelector('[data-new-theme]')?.addEventListener('click', () => openNewThemeModal());
      root.querySelector('[data-document-modules]')?.addEventListener('click', async () => {
        try { const modules = await import(new URL('./module-editor.js', SCRIPT_URL).href); await modules.openModuleEditor(orgId()); }
        catch (error) { showToast('Document modules', errorMessage(error), false); }
      });
      const body = root.querySelector('[data-studio-body]');
      if (state.tab === 'brand-kit') { renderBrandKit(body); return; }
      if (state.loading && state.templates === null) {
        body.innerHTML = `<div class="fmdx-state"><div class="fmdx-spinner"></div><strong>${(globalThis.PlatformLanguage?.text("documents","m_c867f3b4567afc","Loading studio") ?? "Loading studio")}</strong></div>`;
        return;
      }
      if (state.loadError?.missing || !api()) {
        body.innerHTML = `<div class="fmdx-state"><i class="fas fa-plug-circle-xmark"></i><strong>${(globalThis.PlatformLanguage?.text("documents","m_ba70ff7085cae0","Documents service unavailable") ?? "Documents service unavailable")}</strong><span>${(globalThis.PlatformLanguage?.text("documents","m_4643897f23dcba","The documents API client is not loaded for this session.") ?? "The documents API client is not loaded for this session.")}</span></div>`;
        return;
      }
      if (state.loadError) {
        body.innerHTML = `<div class="fmdx-state"><i class="fas fa-cloud-bolt"></i><strong>${(globalThis.PlatformLanguage?.text("documents","m_e7ab9059cb9989","Couldn’t load the studio") ?? "Couldn’t load the studio")}</strong><span>${String(esc(errorMessage(state.loadError, '')))}</span><button type="button" class="fmdx-btn" data-retry><i class="fas fa-rotate-right"></i>${(globalThis.PlatformLanguage?.text("documents","m_cbfbb44ff35f0f"," Try again") ?? " Try again")}</button></div>`;
        body.querySelector('[data-retry]')?.addEventListener('click', () => loadLists());
        return;
      }
      if (isFolderTab()) renderFolderItemList(body);
      else if (state.tab === 'templates') renderTemplateList(body);
      else if (state.tab === 'workflows') renderWorkflowList(body);
      else renderThemeList(body);
    }

    function renderTemplateList(body){
      const all = arrayValue(state.templates).filter((t) => cleanText(t.status).toLowerCase() !== 'archived');
      if (!all.length) {
        body.innerHTML = `<div class="fmdx-state"><i class="fas fa-file-circle-plus"></i><strong>${(globalThis.PlatformLanguage?.text("documents","m_01b6cbbf151638","No templates yet") ?? "No templates yet")}</strong><span>${(globalThis.PlatformLanguage?.text("documents","m_620050b9f2a4e1","Create your first document template — proposals, contracts, invoices — and every project can issue from it.") ?? "Create your first document template — proposals, contracts, invoices — and every project can issue from it.")}</span><button type="button" class="fmdx-btn primary" data-empty-new><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("documents","m_fc61a22aa7a62e"," New template") ?? " New template")}</button></div>`;
        body.querySelector('[data-empty-new]')?.addEventListener('click', () => openNewTemplateModal());
        return;
      }
      const typesPresent = [...new Set(all.map((t) => cleanText(t.document_type).toLowerCase() || 'generic'))];
      if (state.typeFilter && !typesPresent.includes(state.typeFilter)) state.typeFilter = '';
      const templates = state.typeFilter
        ? all.filter((t) => (cleanText(t.document_type).toLowerCase() || 'generic') === state.typeFilter)
        : all;
      const groups = new Map();
      templates.forEach((tpl) => {
        const key = cleanText(tpl.document_type).toLowerCase() || 'generic';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(tpl);
      });
      const chipsHtml = `
        <div class="fmdx-filter-chips">
          <button type="button" class="fmdx-filter-chip ${String(state.typeFilter ? '' : 'active')}" data-filter-type="">${(globalThis.PlatformLanguage?.text("documents","m_51faf42a72af3e","All types") ?? "All types")}</button>
          ${String(typesPresent.map((type) => `
            <button type="button" class="fmdx-filter-chip ${state.typeFilter === type ? 'active' : ''}" data-filter-type="${esc(type)}">
              <i class="fas ${esc(typeIcon(type, state.catalog?.types))}"></i> ${esc(typeLabel(type, state.catalog?.types))}
            </button>`).join(''))}
        </div>`;
      body.innerHTML = chipsHtml + [...groups.entries()].map(([type, list]) => `
        <div class="fmdx-group-title"><i class="fas ${esc(typeIcon(type, state.catalog?.types))}"></i> ${esc(typeLabel(type, state.catalog?.types))} <span class="count">${list.length}</span></div>
        <div class="fmdx-card-grid">
          ${list.map((tpl) => {
            const isDefault = objectValue(tpl.metadata).default_for_type === true;
            return `
            <div class="fmdx-tpl-card" data-template-card="${String(esc(tpl.id))}">
              <div class="head" data-tpl-open style="cursor:pointer">
                <span class="icon"><i class="fas ${String(esc(typeIcon(type, state.catalog?.types)))}"></i></span>
                <div style="min-width:0">
                  <strong>${String(esc(firstText(tpl.name, 'Template')))}</strong>
                  <small>${String(esc([`v${tpl.current_version || 0}`, tpl.updated_at ? `updated ${timeAgo(tpl.updated_at)}` : ''].filter(Boolean).join(' · ')))}</small>
                </div>
              </div>
              <div class="foot">
                ${String(statusChip(tpl.status))}
                ${String(isDefault ? '<span class="fmdx-chip plain" style="color:#8a6400"><i class="fas fa-star" style="font-size:9px"></i> Default</span>' : '')}
                ${String(objectValue(tpl.metadata).preset ? '<span class="fmdx-chip plain">Preset</span>' : '')}
                <span style="margin-left:auto;display:inline-flex;gap:5px">
                  <button type="button" class="fmdx-icon-btn" data-tpl-edit title="${(globalThis.PlatformLanguage?.text("documents","m_5b9378df7220c1","Edit") ?? "Edit")}"><i class="fas fa-pen"></i></button>
                  <button type="button" class="fmdx-icon-btn ${String(isDefault ? 'active' : '')}" data-tpl-default title="${String(isDefault ? 'Org default for this type' : 'Set as org default for this type')}" ${String(isDefault ? 'disabled' : '')}><i class="${String(isDefault ? 'fas' : 'far')} fa-star"></i></button>
                  <button type="button" class="fmdx-icon-btn" data-tpl-duplicate title="${(globalThis.PlatformLanguage?.text("documents","m_24fc1d3519ef6a","Duplicate") ?? "Duplicate")}"><i class="fas fa-copy"></i></button>
                  <button type="button" class="fmdx-icon-btn danger" data-tpl-archive title="${(globalThis.PlatformLanguage?.text("documents","m_5546a92389e386","Archive") ?? "Archive")}"><i class="fas fa-box-archive"></i></button>
                </span>
              </div>
            </div>`;
          }).join('')}
        </div>`).join('');
      body.querySelectorAll('[data-filter-type]').forEach((btn) => btn.addEventListener('click', () => {
        state.typeFilter = btn.dataset.filterType || '';
        render();
      }));
      body.querySelectorAll('[data-template-card]').forEach((card) => {
        const tpl = templates.find((t) => cleanText(t.id) === card.dataset.templateCard);
        if (!tpl) return;
        card.querySelector('[data-tpl-open]')?.addEventListener('click', () => openTemplateEditor(tpl));
        card.querySelector('[data-tpl-edit]')?.addEventListener('click', () => openTemplateEditor(tpl));
        card.querySelector('[data-tpl-default]')?.addEventListener('click', (event) => setDefaultTemplate(tpl, event.currentTarget));
        card.querySelector('[data-tpl-duplicate]')?.addEventListener('click', (event) => duplicateTemplate(tpl, event.currentTarget));
        card.querySelector('[data-tpl-archive]')?.addEventListener('click', () => archiveTemplate(tpl));
      });
    }

    async function duplicateTemplate(tpl, button){
      if (button) button.disabled = true;
      try {
        const definition = (await templateDefinition(tpl)) || blankDefinition(tpl.document_type);
        await api().templates.create(orgId(), {
          name: `${firstText(tpl.name, 'Template')} (copy)`,
          document_type: cleanText(tpl.document_type) || 'generic',
          definition
        });
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_a8cfd2d4eacb65","Template duplicated.") ?? "Template duplicated."), true);
        await loadLists();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not duplicate the template.'), false);
      } finally {
        if (button) button.disabled = false;
      }
    }

    async function archiveTemplate(tpl){
      const prompt = `Archive "${firstText(tpl.name, 'this template')}"? Existing documents keep their issued version.`;
      const confirmed = window.Portal?.ui?.confirm ? await window.Portal.ui.confirm(prompt) : window.confirm(prompt);
      if (!confirmed) return;
      try {
        await api().templates.archive(orgId(), tpl.id);
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_1da828e5f6c1ce","Template archived.") ?? "Template archived."), true);
        await loadLists();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not archive the template.'), false);
      }
    }

    // Org default for the type: metadata.default_for_type=true on this one,
    // cleared client-side on its peers (contract leaves the flag to metadata).
    async function setDefaultTemplate(tpl, button){
      if (button) button.disabled = true;
      try {
        await api().templates.patch(orgId(), tpl.id, { metadata: { ...objectValue(tpl.metadata), default_for_type: true } });
        const peers = arrayValue(state.templates).filter((t) => (
          cleanText(t.id) !== cleanText(tpl.id)
          && cleanText(t.document_type).toLowerCase() === cleanText(tpl.document_type).toLowerCase()
          && objectValue(t.metadata).default_for_type === true
        ));
        for (const peer of peers) {
          await api().templates.patch(orgId(), peer.id, { metadata: { ...objectValue(peer.metadata), default_for_type: false } }).catch(() => {});
        }
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), ((v0,v1) => globalThis.PlatformLanguage?.text("documents","m_86def4c38d5939",`"${v0}" is now the default ${v1} template.`,{v0,v1}) ?? `"${v0}" is now the default ${v1} template.`)(firstText(tpl.name, 'Template'),typeLabel(tpl.document_type, state.catalog?.types).toLowerCase()), true);
        await loadLists();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not set the default template.'), false);
      } finally {
        if (button) button.disabled = false;
      }
    }

    function renderThemeList(body){
      const themes = arrayValue(state.themes).filter((t) => cleanText(t.status).toLowerCase() !== 'archived');
      if (!themes.length) {
        body.innerHTML = `<div class="fmdx-state"><i class="fas fa-palette"></i><strong>${(globalThis.PlatformLanguage?.text("documents","m_879da400b922a1","No themes yet") ?? "No themes yet")}</strong><span>${(globalThis.PlatformLanguage?.text("documents","m_ff2de1607328d0","Themes carry your colors, fonts, and page chrome — one theme restyles every document type together.") ?? "Themes carry your colors, fonts, and page chrome — one theme restyles every document type together.")}</span><button type="button" class="fmdx-btn primary" data-empty-new><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("documents","m_015bb33b569839"," New theme") ?? " New theme")}</button></div>`;
        body.querySelector('[data-empty-new]')?.addEventListener('click', () => openNewThemeModal());
        return;
      }
      body.innerHTML = `<div class="fmdx-card-grid">
        ${themes.map((theme) => {
          const colors = objectValue(objectValue(objectValue(theme.definition).tokens).colors);
          const primary = tokenColor(colors.primary, studioBrandColor('primary'));
          const accent = tokenColor(colors.accent, studioBrandColor('secondary'));
          const swatches = ['primary', 'accent', 'text'].map((key) => `<span style="width:18px;height:18px;border-radius:6px;border:1px solid rgba(15,23,42,.12);background:${esc(tokenColor(colors[key], key === 'text' ? '#111827' : studioBrandColor('primary')))}"></span>`).join('');
          return `
            <div class="fmdx-tpl-card" data-theme-card="${String(esc(theme.id))}" style="--fm-primary:${String(esc(primary))};--fm-accent:${String(esc(accent))};position:relative">
              <button type="button" class="fmdx-icon-btn" data-theme-actions title="${(globalThis.PlatformLanguage?.text("documents","m_45b6adab52d821","Theme actions") ?? "Theme actions")}" aria-label="${((v3) => globalThis.PlatformLanguage?.text("documents","m_30396c80099968",`Actions for ${v3}`,{v3}) ?? `Actions for ${v3}`)(esc(firstText(theme.name, 'theme')))}" style="position:absolute;right:10px;top:10px;z-index:2"><i class="fas fa-ellipsis"></i></button>
              <div class="head" data-theme-open style="padding-right:34px">
                <span class="icon" style="background:linear-gradient(135deg,${String(esc(primary))} 0 50%,${String(esc(accent))} 50%);color:${String(esc(readableOnColor(primary)))}"><i class="fas fa-palette"></i></span>
                <div style="min-width:0">
                  <strong>${String(esc(firstText(theme.name, 'Theme')))}</strong>
                  <small>${String(esc([`v${theme.current_version || 0}`, theme.updated_at ? `updated ${timeAgo(theme.updated_at)}` : ''].filter(Boolean).join(' · ')))}</small>
                </div>
              </div>
              <div class="foot">${String(statusChip(theme.status))}<span style="display:inline-flex;gap:4px;margin-left:auto">${String(swatches)}</span></div>
            </div>`;
        }).join('')}
      </div>`;
      body.querySelectorAll('[data-theme-card]').forEach((card) => {
        const theme = themes.find((t) => cleanText(t.id) === card.dataset.themeCard);
        if (!theme) return;
        card.querySelector('[data-theme-open]')?.addEventListener('click', () => openThemeEditor(theme));
        card.querySelector('[data-theme-actions]')?.addEventListener('click', (event) => {
          event.stopPropagation();
          openThemeActionsMenu(event.currentTarget, theme);
        });
      });
    }

    // Shared floating kebab menu (theme cards, folder tabs, folder items) —
    // positioned against the trigger, closed on outside pointerdown / Escape.
    let floatingMenu = null;
    let floatingMenuTrigger = null;

    function closeFloatingMenu(){
      if (!floatingMenu) return;
      floatingMenu.remove();
      floatingMenu = null;
      floatingMenuTrigger = null;
      document.removeEventListener('pointerdown', closeFloatingMenuOutsidePointer, true);
      document.removeEventListener('keydown', closeFloatingMenuOnEscape, true);
    }

    function closeFloatingMenuOutsidePointer(event){
      if (floatingMenu?.contains(event.target) || floatingMenuTrigger?.contains(event.target)) return;
      closeFloatingMenu();
    }

    function closeFloatingMenuOnEscape(event){
      if (event.key === 'Escape') closeFloatingMenu();
    }

    /** items: [{ icon, label, danger?, onSelect }] */
    function openFloatingMenu(trigger, items){
      closeFloatingMenu();
      const menu = document.createElement('div');
      menu.className = 'fmdx-menu';
      menu.setAttribute('role', 'menu');
      menu.style.minWidth = '190px';
      menu.innerHTML = arrayValue(items).map((item, index) => `
        <button type="button" class="fmdx-menu-item" data-menu-index="${index}" ${item.danger ? 'style="color:#b42318"' : ''}>
          <i class="fas ${esc(item.icon)}" ${item.danger ? 'style="color:#b42318"' : ''}></i><span>${esc(item.label)}</span>
        </button>`).join('');
      document.body.appendChild(menu);
      floatingMenu = menu;
      floatingMenuTrigger = trigger;
      const rect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, rect.right - menuRect.width));
      const below = rect.bottom + 6;
      const top = below + menuRect.height <= window.innerHeight - 8
        ? below
        : Math.max(8, rect.top - menuRect.height - 6);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menu.querySelectorAll('[data-menu-index]').forEach((btn) => btn.addEventListener('click', () => {
        const item = arrayValue(items)[Number(btn.dataset.menuIndex)];
        closeFloatingMenu();
        item?.onSelect?.();
      }));
      setTimeout(() => {
        document.addEventListener('pointerdown', closeFloatingMenuOutsidePointer, true);
        document.addEventListener('keydown', closeFloatingMenuOnEscape, true);
      }, 0);
      menu.querySelector('[data-menu-index]')?.focus();
    }

    function openThemeActionsMenu(trigger, theme){
      openFloatingMenu(trigger, [
        { icon: 'fa-pen', label: (globalThis.PlatformLanguage?.text("documents","m_33b3fd936fdbdc","Edit theme") ?? "Edit theme"), onSelect: () => openThemeEditor(theme) },
        { icon: 'fa-copy', label: (globalThis.PlatformLanguage?.text("documents","m_6178df8e88c8e1","Duplicate theme") ?? "Duplicate theme"), onSelect: () => duplicateTheme(theme) },
        { icon: 'fa-box-archive', label: (globalThis.PlatformLanguage?.text("documents","m_d5098c84051c53","Archive theme") ?? "Archive theme"), danger: true, onSelect: () => archiveTheme(theme) }
      ]);
    }

    async function duplicateTheme(theme){
      try {
        const definition = (await themeDefinition(theme)) || defaultThemeDefinition();
        await api().themes.create(orgId(), {
          name: `${firstText(theme.name, 'Theme')} (copy)`,
          definition,
          use_company_defaults: false
        });
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_bf5db74076b288","Theme duplicated.") ?? "Theme duplicated."), true);
        await loadLists();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not duplicate the theme.'), false);
      }
    }

    async function archiveTheme(theme){
      const prompt = `Archive "${firstText(theme.name, 'this theme')}"? Existing documents keep their saved theme version.`;
      const confirmed = window.Portal?.ui?.confirm ? await window.Portal.ui.confirm(prompt) : window.confirm(prompt);
      if (!confirmed) return;
      try {
        await api().themes.archive(orgId(), theme.id);
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_4e2391e59d5a56","Theme archived.") ?? "Theme archived."), true);
        await loadLists();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not archive the theme.'), false);
      }
    }

    // ------------------------------------------- folders (Marketing + custom)
    function mediaRefUrl(mediaRef, variant){
      const ref = typeof mediaRef === 'string' ? { media_id: mediaRef } : objectValue(mediaRef);
      if (ref.url) return ref.url;
      if (!window.PlatformAPI?.media?.fileUrl) return '';
      const id = firstText(ref.media_id, ref.id);
      return id ? window.PlatformAPI.media.fileUrl(orgId(), id, variant || ref.variant || 'original') : '';
    }

    function invalidateFolderItems(folderId){
      delete state.folderItems[cleanText(folderId)];
    }

    function openFolderActionsMenu(trigger, folder){
      openFloatingMenu(trigger, [
        { icon: 'fa-pen', label: (globalThis.PlatformLanguage?.text("documents","m_4fbd57e6fae372","Rename folder") ?? "Rename folder"), onSelect: () => renameFolder(folder) },
        { icon: 'fa-trash-can', label: (globalThis.PlatformLanguage?.text("documents","m_b4a7a9edd9f873","Delete folder") ?? "Delete folder"), danger: true, onSelect: () => deleteFolder(folder) }
      ]);
    }

    function openNameModal({ title, icon, label, value, cta, onSave }){
      const modal = openModal(`
        <h2><i class="fas ${esc(icon || 'fa-pen')}"></i> ${esc(title)}</h2>
        <label class="fmdx-field"><span>${esc(label || 'Name')}</span><input type="text" data-name-input value="${esc(value || '')}"></label>
        <div class="fmdx-modal-foot"><button type="button" class="fmdx-btn primary" data-name-save><i class="fas fa-check"></i> ${esc(cta || 'Save')}</button></div>`);
      const input = modal.el.querySelector('[data-name-input]');
      const save = async () => {
        const name = cleanText(input.value);
        if (!name) { input.focus(); return; }
        const button = modal.el.querySelector('[data-name-save]');
        button.disabled = true;
        try {
          await onSave(name);
          modal.close();
        } catch (error) {
          button.disabled = false;
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Something went wrong.'), false);
        }
      };
      modal.el.querySelector('[data-name-save]').addEventListener('click', save);
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') save(); });
      input.focus();
      input.select();
    }

    function openNewFolderModal(){
      openNameModal({
        title: (globalThis.PlatformLanguage?.text("documents","m_cc38a3691907b3","New folder") ?? "New folder"),
        icon: 'fa-folder-plus',
        label: (globalThis.PlatformLanguage?.text("documents","m_96112ed67bcbac","Folder name") ?? "Folder name"),
        cta: 'Create',
        onSave: async (label) => {
          const res = await api().folders.create(orgId(), { label });
          const folder = objectValue(res.folder || res);
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), ((v0) => globalThis.PlatformLanguage?.text("documents","m_41233ac28bf7ec",`"${v0}" created.`,{v0}) ?? `"${v0}" created.`)(firstText(folder.label, label)), true);
          await loadLists();
          state.tab = `folder:${cleanText(folder.id)}`;
          render();
        }
      });
    }

    function renameFolder(folder){
      openNameModal({
        title: (globalThis.PlatformLanguage?.text("documents","m_4fbd57e6fae372","Rename folder") ?? "Rename folder"),
        label: (globalThis.PlatformLanguage?.text("documents","m_96112ed67bcbac","Folder name") ?? "Folder name"),
        value: firstText(folder.label),
        onSave: async (label) => {
          await api().folders.patch(orgId(), folder.id, { label });
          await loadLists();
          render();
        }
      });
    }

    async function deleteFolder(folder){
      const prompt = `Delete "${firstText(folder.label, 'this folder')}"? Its contents are kept but the folder disappears from the studio.`;
      const confirmed = window.Portal?.ui?.confirm ? await window.Portal.ui.confirm(prompt) : window.confirm(prompt);
      if (!confirmed) return;
      try {
        await api().folders.archive(orgId(), folder.id);
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_98c741a42741d1","Folder deleted.") ?? "Folder deleted."), true);
        if (state.tab === `folder:${cleanText(folder.id)}`) state.tab = 'templates';
        await loadLists();
        render();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not delete the folder.'), false);
      }
    }

    // ----------------------------------------------------- folder item list
    async function loadFolderItems(folderId){
      try {
        const res = await api().folders.items.list(orgId(), folderId);
        state.folderItems[cleanText(folderId)] = arrayValue(res.items).map(objectValue);
      } catch (error) {
        state.folderItems[cleanText(folderId)] = [];
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not load this folder.'), false);
      }
    }

    function renderFolderItemList(body){
      const folder = currentFolder();
      if (!folder) return;
      const folderId = cleanText(folder.id);
      const items = state.folderItems[folderId];
      if (!Array.isArray(items)) {
        body.innerHTML = `<div class="fmdx-state"><div class="fmdx-spinner"></div><strong>${(globalThis.PlatformLanguage?.text("documents","m_ef1731c651caee","Loading folder") ?? "Loading folder")}</strong></div>`;
        loadFolderItems(folderId).then(() => {
          if (!state.destroyed && state.view === 'list' && state.tab === `folder:${folderId}`) render();
        });
        return;
      }
      if (!items.length) {
        body.innerHTML = `<div class="fmdx-state"><i class="fas ${String(esc(firstText(folder.icon, 'fa-folder')))}"></i><strong>${(globalThis.PlatformLanguage?.text("documents","m_2da7c8038631f3","Nothing here yet") ?? "Nothing here yet")}</strong><span>${(globalThis.PlatformLanguage?.text("documents","m_e1d2bb78d22ce9","Upload media or files, or design a document — everything in this folder stays organized in one place.") ?? "Upload media or files, or design a document — everything in this folder stays organized in one place.")}</span><button type="button" class="fmdx-btn primary" data-empty-new><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("documents","m_5fe01108f83039"," New") ?? " New")}</button></div>`;
        body.querySelector('[data-empty-new]')?.addEventListener('click', () => openNewFolderItemModal(folder));
        return;
      }
      body.innerHTML = `<div class="fmdx-card-grid">
        ${items.map((item) => {
          const type = cleanText(item.item_type);
          const meta = ITEM_TYPE_META[type] || ITEM_TYPE_META.file;
          const thumbUrl = type === 'media' ? mediaRefUrl(item.media_ref, 'original') : '';
          return `
            <div class="fmdx-tpl-card" data-folder-item-card="${String(esc(item.id))}" style="position:relative">
              <button type="button" class="fmdx-icon-btn" data-item-actions title="${(globalThis.PlatformLanguage?.text("documents","m_fd0f574164b88e","Item actions") ?? "Item actions")}" aria-label="${((v1) => globalThis.PlatformLanguage?.text("documents","m_4ced6981451d49",`Actions for ${v1}`,{v1}) ?? `Actions for ${v1}`)(esc(firstText(item.name, 'item')))}" style="position:absolute;right:10px;top:10px;z-index:2"><i class="fas fa-ellipsis"></i></button>
              <div class="fmdx-item-thumb" data-item-open>
                ${String(thumbUrl
                  ? `<img src="${esc(thumbUrl)}" alt="" loading="lazy">`
                  : `<i class="fas ${esc(folderItemIcon(item))}"></i>`)}
              </div>
              <div class="head" data-item-open style="cursor:pointer;padding-right:26px">
                <div style="min-width:0">
                  <strong>${String(esc(firstText(item.name, 'Untitled')))}</strong>
                  <small>${String(esc([meta.label, item.updated_at ? `updated ${timeAgo(item.updated_at)}` : ''].filter(Boolean).join(' · ')))}</small>
                </div>
              </div>
            </div>`;
        }).join('')}
      </div>`;
      body.querySelectorAll('[data-folder-item-card]').forEach((card) => {
        const item = items.find((entry) => cleanText(entry.id) === card.dataset.folderItemCard);
        if (!item) return;
        card.querySelectorAll('[data-item-open]').forEach((el) => el.addEventListener('click', () => openFolderItem(item, folder)));
        card.querySelector('[data-item-actions]')?.addEventListener('click', (event) => {
          event.stopPropagation();
          openFolderItemActionsMenu(event.currentTarget, item, folder);
        });
      });
    }

    function isDocItem(item){
      return ['document', 'visual_document'].includes(cleanText(item?.item_type));
    }

    function openFolderItem(item, folder){
      if (isDocItem(item)) { openFolderItemEditor(item, folder); return; }
      if (cleanText(item.item_type) === 'media') { openFolderItemPreview(item); return; }
      downloadFolderItem(item);
    }

    function openFolderItemActionsMenu(trigger, item, folder){
      const entries = [];
      if (isDocItem(item)) entries.push({ icon: 'fa-pen', label: (globalThis.PlatformLanguage?.text("documents","m_5b9378df7220c1","Edit") ?? "Edit"), onSelect: () => openFolderItemEditor(item, folder) });
      entries.push({ icon: 'fa-eye', label: (globalThis.PlatformLanguage?.text("documents","m_afff48796c3165","Preview") ?? "Preview"), onSelect: () => openFolderItemPreview(item) });
      entries.push({ icon: 'fa-download', label: (globalThis.PlatformLanguage?.text("documents","m_871659bb2df660","Download") ?? "Download"), onSelect: () => downloadFolderItem(item) });
      entries.push({ icon: 'fa-i-cursor', label: (globalThis.PlatformLanguage?.text("documents","m_e32e6dab52dcf9","Rename") ?? "Rename"), onSelect: () => renameFolderItem(item) });
      entries.push({ icon: 'fa-box-archive', label: (globalThis.PlatformLanguage?.text("documents","m_5546a92389e386","Archive") ?? "Archive"), danger: true, onSelect: () => archiveFolderItem(item) });
      openFloatingMenu(trigger, entries);
    }

    function renameFolderItem(item){
      openNameModal({
        title: (globalThis.PlatformLanguage?.text("documents","m_22f99c71c3518b","Rename item") ?? "Rename item"),
        value: firstText(item.name),
        onSave: async (name) => {
          await api().folders.items.patch(orgId(), item.folder_id, item.id, { name });
          invalidateFolderItems(item.folder_id);
          render();
        }
      });
    }

    async function archiveFolderItem(item){
      const prompt = `Archive "${firstText(item.name, 'this item')}"? It disappears from the folder but is never truly deleted.`;
      const confirmed = window.Portal?.ui?.confirm ? await window.Portal.ui.confirm(prompt) : window.confirm(prompt);
      if (!confirmed) return;
      try {
        await api().folders.items.archive(orgId(), item.folder_id, item.id);
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_0ecc664a17a7a0","Item archived.") ?? "Item archived."), true);
        invalidateFolderItems(item.folder_id);
        render();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not archive the item.'), false);
      }
    }

    function downloadFolderItem(item){
      if (isDocItem(item)) {
        const url = api().folders.itemPdfUrl?.(orgId(), item.folder_id, item.id);
        if (url) window.open(url, '_blank', 'noopener');
        return;
      }
      const url = mediaRefUrl(item.media_ref, 'original');
      if (!url) { showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_4dd57512381b98","This file has no stored media.") ?? "This file has no stored media."), false); return; }
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = firstText(objectValue(item.media_ref).file_name, item.name, 'download');
      anchor.rel = 'noopener';
      anchor.target = '_blank';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }

    async function openFolderItemPreview(item){
      if (cleanText(item.item_type) === 'media') {
        const url = mediaRefUrl(item.media_ref, 'original');
        openModal(`
          <h2><i class="fas fa-image"></i> ${esc(firstText(item.name, 'Media'))}</h2>
          <div style="display:grid;place-items:center;background:#0f172a;border-radius:12px;overflow:hidden;min-height:200px">
            <img src="${esc(url)}" alt="${esc(firstText(item.name, 'Media'))}" style="max-width:100%;max-height:70vh;display:block">
          </div>`, { className: 'fmdx-modal-wide' });
        return;
      }
      if (!isDocItem(item)) { downloadFolderItem(item); return; }
      const modal = openModal(`
        <h2><i class="fas fa-eye"></i> ${esc(firstText(item.name, 'Preview'))}</h2>
        <div data-item-preview style="background:#39435a;border-radius:12px;min-height:300px;max-height:70vh;overflow:auto;display:flex;justify-content:center;padding:20px">
          <div class="fmdx-state" style="margin:auto;border:0;background:transparent"><div class="fmdx-spinner"></div></div>
        </div>`, { className: 'fmdx-modal-wide' });
      const holder = modal.el.querySelector('[data-item-preview]');
      try {
        const res = await api().folders.items.get(orgId(), item.folder_id, item.id);
        const full = objectValue(res.item || res);
        const definition = objectValue(full.definition);
        if (!Object.keys(definition).length) throw new Error('This item has no content yet.');
        if (!window.FMDocRenderer?.render) throw new Error('The document renderer library is not loaded.');
        await loadCatalog();
        holder.innerHTML = '';
        const available = Math.max(240, holder.clientWidth - 40);
        const baseWidthPt = cleanText(item.item_type) === 'visual_document' ? 720 : 612;
        window.FMDocRenderer.render(holder, {
          document: clone(definition),
          theme: arrayValue(state.catalog?.themes)[0]?.definition || null,
          themeContext: { branding: objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding) },
          mode: 'static',
          widgetData: {},
          scale: Math.min(1, available / (baseWidthPt * (96 / 72)))
        });
      } catch (error) {
        holder.innerHTML = `<div class="fmdx-state" style="margin:auto;border:0;background:transparent"><i class="fas fa-triangle-exclamation" style="color:#f5b357"></i><strong style="color:#e7ecf5">${(globalThis.PlatformLanguage?.text("documents","m_fc865c9558abcb","Preview unavailable") ?? "Preview unavailable")}</strong><span style="color:#9aa6bd">${String(esc(errorMessage(error, '')))}</span></div>`;
      }
    }

    // ------------------------------------------------------ new folder item
    function blankViewDefinition(){
      // kind:"view" DocModel — the same flow-root shape the web editor and
      // websites seeds use (720pt design width, height grows with content).
      if (!window.FMDocModel?.createDocument) return null;
      try {
        const doc = window.FMDocModel.createDocument({ kind: 'view' });
        const rootNode = objectValue(doc.root);
        rootNode.frame = { ...objectValue(rootNode.frame), w: 720, h: 0, layout: 'flow' };
        rootNode.props = {
          ...objectValue(rootNode.props),
          flow: { direction: 'column', gap: 0, padding: [0, 0, 0, 0], align: 'stretch', wrap: false }
        };
        rootNode.children = arrayValue(rootNode.children);
        doc.root = rootNode;
        doc.settings = { ...objectValue(doc.settings), paper: { size: { w_pt: 720 } } };
        return doc;
      } catch (error) {
        console.warn('Could not create a view document', error);
        return null;
      }
    }

    function pickFolderFiles(accept, onFiles){
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      if (accept) input.accept = accept;
      input.onchange = () => {
        const files = [...(input.files || [])];
        if (files.length) onFiles(files);
      };
      input.click();
    }

    async function uploadFolderItemFiles(folder, files, itemType){
      if (!window.PlatformAPI?.media?.upload) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_56c94155d45b25","Media uploads are unavailable in this session.") ?? "Media uploads are unavailable in this session."), false);
        return;
      }
      let uploaded = 0;
      for (const file of files) {
        try {
          const result = await window.PlatformAPI.media.upload(orgId(), file, {
            ownerType: 'document_folder_item',
            ownerId: cleanText(folder.id),
            collection: 'documents'
          });
          const media = objectValue(result.media || result);
          await api().folders.items.create(orgId(), folder.id, {
            item_type: itemType,
            name: firstText(file.name, 'Upload'),
            media_ref: {
              media_id: firstText(media.id, media.media_id),
              variant: 'original',
              file_name: cleanText(file.name),
              content_type: cleanText(file.type)
            }
          });
          uploaded += 1;
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, `Could not upload ${file.name}.`), false);
        }
      }
      if (uploaded) showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), ((v0,v1) => globalThis.PlatformLanguage?.text("documents","m_8a29dd87263426",`${v0} ${v1} added.`,{v0,v1}) ?? `${v0} ${v1} added.`)(uploaded,uploaded === 1 ? 'item' : 'items'), true);
      invalidateFolderItems(folder.id);
      render();
    }

    function openNewFolderItemModal(folder){
      const modal = openModal(`<h2><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("documents","m_5fe01108f83039"," New") ?? " New")}</h2><div data-nfi-body></div>`);
      const body = modal.el.querySelector('[data-nfi-body]');
      function renderChooser(){
        body.innerHTML = `
          <p class="fmdx-data-hint" style="margin-top:0">${((v0) => globalThis.PlatformLanguage?.text("documents","m_8c389572b3287f",`Add to “${v0}”.`,{v0}) ?? `Add to “${v0}”.`)(esc(firstText(folder.label, 'this folder')))}</p>
          <div class="fmdx-pick-grid">
            <button type="button" class="fmdx-pick-card" data-nfi-kind="media">
              <span class="fmdx-pick-icon"><i class="fas fa-image"></i></span>
              <strong>${(globalThis.PlatformLanguage?.text("documents","m_1e937a69c1930d","Media upload") ?? "Media upload")}</strong>
              <small>${(globalThis.PlatformLanguage?.text("documents","m_f2720b2e2418c7","Photos & videos, stored with thumbnails") ?? "Photos & videos, stored with thumbnails")}</small>
            </button>
            <button type="button" class="fmdx-pick-card" data-nfi-kind="file">
              <span class="fmdx-pick-icon"><i class="fas fa-file-arrow-up"></i></span>
              <strong>${(globalThis.PlatformLanguage?.text("documents","m_ac237ff655738b","Document upload") ?? "Document upload")}</strong>
              <small>${(globalThis.PlatformLanguage?.text("documents","m_9098a26abe330f","PDFs & files, stored as-is") ?? "PDFs & files, stored as-is")}</small>
            </button>
            <button type="button" class="fmdx-pick-card" data-nfi-kind="document">
              <span class="fmdx-pick-icon"><i class="fas fa-file-lines"></i></span>
              <strong>${(globalThis.PlatformLanguage?.text("documents","m_9c9b98b1f4e8c9","Document") ?? "Document")}</strong>
              <small>${(globalThis.PlatformLanguage?.text("documents","m_cae6c3227293b0","Page-based, opens in the document editor") ?? "Page-based, opens in the document editor")}</small>
            </button>
            <button type="button" class="fmdx-pick-card" data-nfi-kind="visual_document">
              <span class="fmdx-pick-icon"><i class="fas fa-object-group"></i></span>
              <strong>${(globalThis.PlatformLanguage?.text("documents","m_61a718221ec5f8","Visual document") ?? "Visual document")}</strong>
              <small>${(globalThis.PlatformLanguage?.text("documents","m_24c9fe24d3a98f","Free-flowing canvas, opens in the visual editor") ?? "Free-flowing canvas, opens in the visual editor")}</small>
            </button>
          </div>`;
        body.querySelectorAll('[data-nfi-kind]').forEach((btn) => btn.addEventListener('click', () => {
          const kind = btn.dataset.nfiKind;
          if (kind === 'media' || kind === 'file') {
            modal.close();
            pickFolderFiles(kind === 'media' ? 'image/*,video/*' : '', (files) => uploadFolderItemFiles(folder, files, kind));
            return;
          }
          renderNameStep(kind);
        }));
      }
      function renderNameStep(kind){
        const meta = ITEM_TYPE_META[kind] || ITEM_TYPE_META.document;
        body.innerHTML = `
          <label class="fmdx-field"><span>${((v0) => globalThis.PlatformLanguage?.text("documents","m_52472813510e82",`${v0} name`,{v0}) ?? `${v0} name`)(esc(meta.label))}</span><input type="text" data-nfi-name placeholder="${(globalThis.PlatformLanguage?.text("documents","m_1a03e2f4ec7099","e.g. Company Brochure") ?? "e.g. Company Brochure")}"></label>
          <div class="fmdx-modal-foot">
            <button type="button" class="fmdx-btn" data-nfi-back><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.text("documents","m_206d31a7c795c4"," Back") ?? " Back")}</button>
            <button type="button" class="fmdx-btn primary" data-nfi-create><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("documents","m_93873c9aca2d63"," Create & design") ?? " Create & design")}</button>
          </div>`;
        const input = body.querySelector('[data-nfi-name]');
        body.querySelector('[data-nfi-back]')?.addEventListener('click', () => renderChooser());
        const create = async () => {
          const name = cleanText(input.value);
          if (!name) { input.focus(); return; }
          const button = body.querySelector('[data-nfi-create]');
          button.disabled = true;
          try {
            const definition = kind === 'visual_document'
              ? (blankViewDefinition() || blankDefinition('generic'))
              : blankDefinition('generic');
            if (kind !== 'visual_document') await applyFontToBlankDocument(definition);
            const res = await api().folders.items.create(orgId(), folder.id, { item_type: kind, name, definition });
            const item = objectValue(res.item || res);
            modal.close();
            invalidateFolderItems(folder.id);
            openFolderItemEditor(item, folder);
          } catch (error) {
            button.disabled = false;
            showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not create the item.'), false);
          }
        };
        body.querySelector('[data-nfi-create]')?.addEventListener('click', create);
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') create(); });
        input.focus();
      }
      renderChooser();
    }

    // ------------------------------------------- folder item editor (autosave)
    function destroyFolderItemEditor(){
      clearTimeout(state.folderItemSaveTimer);
      try { state.folderItemAgent?.destroy?.(); } catch (e) {}
      state.folderItemAgent = null;
      state.pendingFolderItemAgentTask = null;
      try { state.itemEditorHandle?.destroy?.(); } catch (e) {}
      state.itemEditorHandle = null;
      window.Portal?.topbar?.releaseLeft?.(folderItemTopbarOwner);
      state.folderItemHeader = null;
    }

    function downloadDocumentData(documentDef, format, name){
      const base = firstText(name, 'Document').replace(/[\\/:*?"<>|]+/g, '-');
      const text = [];
      const visit = (node) => { if (node?.type === 'text') for (const block of arrayValue(node.props?.blocks)) text.push(arrayValue(block.runs).map((run) => cleanText(run.text)).join('')); for (const child of arrayValue(node?.children)) visit(child); };
      for (const page of arrayValue(documentDef?.pages)) visit(page);
      let blob; let ext;
      if (format === 'json') { blob = new Blob([JSON.stringify(documentDef, null, 2)], { type:'application/json' }); ext = 'json'; }
      else if (format === 'txt') { blob = new Blob([text.join('\n')], { type:'text/plain;charset=utf-8' }); ext = 'txt'; }
      else { blob = new Blob([`<!doctype html><meta charset="utf-8"><title>${base}</title><body>${text.map((line) => `<p>${esc(line) || '&nbsp;'}</p>`).join('')}</body>`], { type:'application/msword' }); ext = 'doc'; }
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${base}.${ext}`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function openFolderItemEditor(item, folder, options = {}){
      destroyFolderItemEditor();
      const folderId = firstText(folder?.id, item?.folder_id);
      const itemId = firstText(item?.id);
      const openToken = ++state.folderItemOpenToken;
      state.view = 'folder_item';
      requestEditorSidebar();
      state.folderItem = { ...objectValue(item), folder_id:folderId, id:itemId };
      state.folderItemDef = null;
      state.folderItemDirty = false;
      state.folderItemSaving = false;
      state.folderItemQueued = false;
      if (folderId) state.tab = `folder:${folderId}`;
      if (!options.fromRoute) {
        writeStudioRoute(state.tab, { studioSection:'folder', studioFolder:folderId, studioDocument:itemId }, { source:'documents-studio-document-open' });
      }
      renderFolderItemEditor();
      await loadCatalog();
      if (state.destroyed || openToken !== state.folderItemOpenToken) return;
      try {
        const res = await api().folders.items.get(orgId(), folderId, itemId);
        const full = objectValue(res.item || res);
        state.folderItem = { ...full, folder_id:firstText(full.folder_id, folderId), id:firstText(full.id, itemId) };
        state.folderItemDef = Object.keys(objectValue(full.definition)).length
          ? clone(full.definition)
          : (cleanText(full.item_type) === 'visual_document' ? (blankViewDefinition() || blankDefinition('generic')) : blankDefinition('generic'));
      } catch (error) {
        if (openToken !== state.folderItemOpenToken) return;
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not open the item.'), false);
        closeFolderItemEditor({ fromRoute:options.fromRoute });
        return;
      }
      if (state.destroyed || state.view !== 'folder_item' || openToken !== state.folderItemOpenToken) return;
      renderFolderItemEditor();
      mountFolderItemCanvas();
    }

    async function closeFolderItemEditor(options = {}){
      // Flush a pending autosave so nothing typed in the last second is lost.
      clearTimeout(state.folderItemSaveTimer);
      if (state.folderItemDirty && !state.folderItemSaving) await saveFolderItem();
      if (!options.fromRoute) {
        const folderId = firstText(state.folderItem?.folder_id, cleanText(state.tab).replace(/^folder:/, ''));
        const result = window.Portal?.navigation?.backOrClose?.(
          ['studioDocument'],
          { studioSection:'folder', studioFolder:folderId || null, studioDocument:null },
          { source:'documents-studio-document-close' }
        );
        if (result?.backed) return;
      }
      state.folderItemOpenToken += 1;
      destroyFolderItemEditor();
      state.view = 'list';
      releaseEditorSidebar();
      if (state.folderItem?.folder_id) invalidateFolderItems(state.folderItem.folder_id);
      state.folderItem = null;
      state.folderItemDef = null;
      render();
    }

    function renderFolderItemEditor(){
      if (state.view !== 'folder_item') return;
      const item = state.folderItem || {};
      const meta = ITEM_TYPE_META[cleanText(item.item_type)] || ITEM_TYPE_META.document;
      const existing = root.querySelector('[data-studio-item-screen]');
      if (existing) {
        syncFolderItemHeader(item, meta);
        syncFolderItemHeaderHost();
        return;
      }
      root.innerHTML = `
        <div class="fmdx-shell">
          <div class="fmdx-studio-editor" data-studio-item-screen>
            <header class="fmdx-editor-top">
              <button type="button" class="fmdx-icon-btn" data-item-back title="${(globalThis.PlatformLanguage?.text("documents","m_9a8ae4bb33e74e","Back to folder") ?? "Back to folder")}"><i class="fas fa-arrow-left"></i></button>
              <input class="fmdx-doc-title-input" data-item-name value="${String(esc(firstText(item.name, 'Untitled')))}" spellcheck="false">
              <span class="fmdx-chip plain"><i class="fas ${String(esc(meta.icon))}" style="font-size:9px"></i> ${String(esc(meta.label))}</span>
              <span class="fmdx-save-state" data-item-save-state>${(globalThis.PlatformLanguage?.text("documents","m_8942ebbfe02463","Saves automatically") ?? "Saves automatically")}</span>
            </header>
            <div class="fmdx-editor-main">
              <div class="fmdx-editor-canvas" data-item-canvas>
                <div class="fmdx-state" style="margin:20px"><div class="fmdx-spinner"></div><strong>${((v3) => globalThis.PlatformLanguage?.text("documents","m_b9453f8651aeec",`Opening ${v3}`,{v3}) ?? `Opening ${v3}`)(esc(meta.label.toLowerCase()))}</strong></div>
              </div>
            </div>
          </div>
        </div>`;
      state.folderItemHeader = root.querySelector('[data-studio-item-screen] > .fmdx-editor-top');
      state.folderItemHeader?.querySelector('[data-item-back]')?.addEventListener('click', () => closeFolderItemEditor());
      const titleInput = state.folderItemHeader?.querySelector('[data-item-name]');
      titleInput?.addEventListener('input', (event) => {
        sizeFolderItemTitle(event.target);
        if (state.folderItem) state.folderItem.name = event.target.value;
      });
      titleInput?.addEventListener('change', async (event) => {
        const name = cleanText(event.target.value) || 'Untitled';
        event.target.value = name;
        sizeFolderItemTitle(event.target);
        try {
          await api().folders.items.patch(orgId(), state.folderItem.folder_id, state.folderItem.id, { name });
          state.folderItem = { ...state.folderItem, name };
          invalidateFolderItems(state.folderItem.folder_id);
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not rename the item.'), false);
        }
      });
      syncFolderItemHeader(item, meta);
      syncFolderItemHeaderHost();
    }

    function sizeFolderItemTitle(input){
      if (!input) return;
      const canvas = sizeFolderItemTitle.canvas || (sizeFolderItemTitle.canvas = document.createElement('canvas'));
      const measure = canvas.getContext('2d');
      const style = window.getComputedStyle(input);
      if (measure) measure.font = style.font;
      const textWidth = measure ? measure.measureText(input.value || input.placeholder || (globalThis.PlatformLanguage?.text("documents","m_05017f54f07448","Untitled") ?? "Untitled")).width : String(input.value || '').length * 8;
      const maxWidth = Math.min(340, Math.max(150, window.innerWidth * .38));
      input.style.width = `${Math.max(44, Math.min(maxWidth, Math.ceil(textWidth + 22)))}px`;
    }

    function syncFolderItemHeader(item = state.folderItem || {}, meta = ITEM_TYPE_META[cleanText(state.folderItem?.item_type)] || ITEM_TYPE_META.document){
      const header = state.folderItemHeader;
      if (!header) return;
      const input = header.querySelector('[data-item-name]');
      const name = firstText(item.name, 'Untitled');
      if (input && document.activeElement !== input) input.value = name;
      sizeFolderItemTitle(input);
      const chip = header.querySelector('.fmdx-chip.plain');
      if (chip) chip.innerHTML = `<i class="fas ${esc(meta.icon)}" style="font-size:9px"></i> ${esc(meta.label)}`;
    }

    function syncFolderItemHeaderHost(){
      const header = state.folderItemHeader;
      const screen = root.querySelector('[data-studio-item-screen]');
      const main = screen?.querySelector('.fmdx-editor-main');
      if (!header || !screen || !main) return;
      const topbar = window.Portal?.topbar;
      const injected = state.active !== false && topbar?.isVisible?.() && topbar.mountLeft?.(folderItemTopbarOwner, header);
      header.classList.toggle('platform-topbar-injected', !!injected);
      if (!injected) {
        topbar?.releaseLeft?.(folderItemTopbarOwner);
        if (header.parentElement !== screen) screen.insertBefore(header, main);
      }
      sizeFolderItemTitle(header.querySelector('[data-item-name]'));
    }

    function folderItemDocumentActions(){
      const currentUrl = () => window.location.href;
      return {
        new: async () => { const folder = currentFolder(); await closeFolderItemEditor({ fromRoute:true }); if (!folder) return; writeStudioRoute(`folder:${folder.id}`, { studioSection:'folder', studioFolder:folder.id, studioDocument:null }, { replace:true, source:'documents-studio-document-new' }); requestAnimationFrame(() => openNewFolderItemModal(folder)); },
        open: () => closeFolderItemEditor(),
        copy: async () => {
          const definition = clone(state.itemEditorHandle?.getDocument?.() || state.folderItemDef);
          const res = await api().folders.items.create(orgId(), state.folderItem.folder_id, { item_type: state.folderItem.item_type, name: `${firstText(state.folderItem.name, 'Document')} (copy)`, definition });
          const item = objectValue(res.item || res);
          invalidateFolderItems(state.folderItem.folder_id);
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_a571fd03354b1f","Copy created.") ?? "Copy created."), true);
          if (item.id) openFolderItemEditor(item, currentFolder());
        },
        share: async () => {
          const data = { title: firstText(state.folderItem?.name, 'Document'), url: currentUrl() };
          if (navigator.share) await navigator.share(data);
          else { await navigator.clipboard?.writeText?.(data.url); showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_83b3cddc831f9d","Document link copied.") ?? "Document link copied."), true); }
        },
        email: () => { window.location.href = `mailto:?subject=${encodeURIComponent(firstText(state.folderItem?.name, 'Document'))}&body=${encodeURIComponent(currentUrl())}`; },
        download: async ({ format = 'pdf', document: documentDef } = {}) => { await saveFolderItem(); if (format === 'pdf') downloadFolderItem(state.folderItem); else downloadDocumentData(documentDef || state.folderItemDef, format, state.folderItem?.name); },
        rename: () => { const input = state.folderItemHeader?.querySelector('[data-item-name]'); input?.focus(); input?.select(); },
        move: () => {
          const choices = arrayValue(state.folders).filter((folder) => cleanText(folder.id) !== cleanText(state.folderItem?.folder_id));
          const modal = openModal(`<h2><i class="fas fa-folder-tree"></i>${(globalThis.PlatformLanguage?.text("documents","m_f560ff2bcfdb50"," Move document") ?? " Move document")}</h2><label class="fmdx-field"><span>${(globalThis.PlatformLanguage?.text("documents","m_9636a74fb73e2d","Destination folder") ?? "Destination folder")}</span><select data-move-folder>${String(choices.map((folder) => `<option value="${esc(folder.id)}">${esc(folder.label)}</option>`).join(''))}</select></label><div class="fmdx-modal-actions"><button type="button" class="fmdx-btn" data-move-cancel>${(globalThis.PlatformLanguage?.text("documents","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="button" class="fmdx-btn primary" data-move-save ${String(choices.length ? '' : 'disabled')}>${(globalThis.PlatformLanguage?.text("documents","m_552d55b4b2e140","Move") ?? "Move")}</button></div>`);
          modal.el.querySelector('[data-move-cancel]')?.addEventListener('click', modal.close);
          modal.el.querySelector('[data-move-save]')?.addEventListener('click', async () => {
            const folderId = cleanText(modal.el.querySelector('[data-move-folder]')?.value);
            if (!folderId) return;
            await saveFolderItem();
            const res = await api().folders.items.patch(orgId(), state.folderItem.folder_id, state.folderItem.id, { folder_id: folderId });
            state.folderItem = { ...state.folderItem, ...objectValue(res.item || res), folder_id: folderId };
            invalidateFolderItems(folderId); modal.close(); showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_a6b49c975dfdae","Document moved.") ?? "Document moved."), true);
          });
        },
        versions: async () => {
          const item = state.folderItem || {};
          const modal = openModal(`<h2><i class="fas fa-clock-rotate-left"></i>${(globalThis.PlatformLanguage?.text("documents","m_b5edeb48c05298"," Version history") ?? " Version history")}</h2><div class="fmdx-state" style="margin:0" data-item-versions><div class="fmdx-spinner"></div><strong>${(globalThis.PlatformLanguage?.text("documents","m_086b015c3e8bf8","Loading saved versions") ?? "Loading saved versions")}</strong></div>`);
          const result = await api().folders.items.versions(orgId(), item.folder_id, item.id);
          const versions = arrayValue(result.versions || result.items);
          const host = modal.el.querySelector('[data-item-versions]');
          if (!host) return;
          host.className = '';
          host.innerHTML = `<div class="fmdx-menu-note">${((v0,v1) => globalThis.PlatformLanguage?.text("documents","m_3a1a837e75bcde",`Current revision ${v0} · saved ${v1}`,{v0,v1}) ?? `Current revision ${v0} · saved ${v1}`)(Number(item.revision || 1),esc(item.updated_at ? timeAgo(item.updated_at) : 'just now'))}</div>${String(versions.length ? versions.map((version) => `<div class="fmdx-list-row"><div><strong>Revision ${Number(version.source_revision || 0)}</strong><small>${esc(version.captured_at ? timeAgo(version.captured_at) : '')} · ${esc(firstText(version.updated_by_user_id, 'Autosave'))}</small></div></div>`).join('') : '<div class="fmdx-state" style="margin:0"><strong>No earlier versions yet</strong><span>Earlier revisions appear here after the document is saved.</span></div>')}`;
        },
        trash: async () => { await archiveFolderItem(state.folderItem); await closeFolderItemEditor({ fromRoute:true }); },
        agent: ({ task } = {}) => {
          state.pendingFolderItemAgentTask = firstText(task) || null;
          state.itemEditorHandle?.openSidePanel?.('agent');
          if (state.folderItemAgent && state.pendingFolderItemAgentTask) {
            const prompt = state.pendingFolderItemAgentTask;
            state.pendingFolderItemAgentTask = null;
            state.folderItemAgent.send?.(prompt);
          }
        }
      };
    }

    function mountFolderItemAgent(host){
      try { state.folderItemAgent?.destroy?.(); } catch (e) {}
      state.folderItemAgent = null;
      if (!window.FMDocAgentPanel?.create) {
        host.innerHTML = `<div class="fmdx-state" style="margin:14px"><span>${(globalThis.PlatformLanguage?.text("documents","m_b81cd219469c9b","The document copilot library is not loaded.") ?? "The document copilot library is not loaded.")}</span></div>`;
        return;
      }
      const kickoff = firstText(state.pendingFolderItemAgentTask);
      state.pendingFolderItemAgentTask = null;
      state.folderItemAgent = window.FMDocAgentPanel.create(host, {
        orgId: orgId(),
        subjectId: firstText(state.folderItem?.id),
        title: (globalThis.PlatformLanguage?.text("documents","m_ec99d1d510fb3c","Document copilot") ?? "Document copilot"),
        initialMessage: kickoff,
        placeholder: (globalThis.PlatformLanguage?.text("documents","m_a6794f2378bc40","Describe the change…") ?? "Describe the change…"),
        welcome: 'Tell me what should change on this document — wording, layout, sections — and I’ll edit it in real time.',
        suggestions: [
          'Rewrite the introduction to be warmer',
          'Add a page with our workmanship warranty',
          'Make the totals section more prominent'
        ],
        getInput: () => ({
          mode: 'document',
          subject: {
            id: firstText(state.folderItem?.id),
            name: firstText(state.folderItem?.name),
            status: 'draft',
            document_type: cleanText(state.folderItem?.item_type) || 'document'
          },
          definition: objectValue(state.itemEditorHandle?.getDocument?.() || state.folderItemDef)
        }),
        onAction: (action) => {
          if (cleanText(objectValue(action).type) !== 'document.set_definition') return;
          const docModel = clone(objectValue(objectValue(action).document));
          if (!arrayValue(docModel.pages).length && !docModel.root) return;
          state.itemEditorHandle?.setDocument?.(clone(docModel), { source: 'agent' });
          state.folderItemDef = clone(state.itemEditorHandle?.getDocument?.() || docModel);
          state.folderItemDirty = true;
          setItemSaveState('Unsaved changes', 'dirty');
          scheduleFolderItemAutosave();
        }
      });
    }

    function setItemSaveState(text, cls){
      const el = state.folderItemHeader?.querySelector('[data-item-save-state]') || root.querySelector('[data-item-save-state]');
      if (!el) return;
      el.className = `fmdx-save-state ${cls || ''}`;
      el.textContent = text || '';
    }

    function mountFolderItemCanvas(){
      const canvas = root.querySelector('[data-item-canvas]');
      if (!canvas || !state.folderItemDef) return;
      if (!window.FMDocEditor?.mount) {
        canvas.innerHTML = `<div class="fmdx-state" style="margin:20px"><i class="fas fa-pen-ruler"></i><strong>${(globalThis.PlatformLanguage?.text("documents","m_d08399aef41777","Editor unavailable") ?? "Editor unavailable")}</strong><span>${(globalThis.PlatformLanguage?.text("documents","m_a501de9d8db031","The document editor library is not loaded for this session.") ?? "The document editor library is not loaded for this session.")}</span></div>`;
        return;
      }
      canvas.innerHTML = '';
      // Visual documents use the web editor's "website" profile; if this
      // session ships an older doc-editor library, fall back to designer
      // rather than fail to mount (same guard as the web editor).
      const isVisualDocument = cleanText(state.folderItem?.item_type) === 'visual_document';
      let profile = isVisualDocument ? 'website' : 'designer';
      if (profile === 'website' && typeof window.FMDocEditor.registerProfile !== 'function') {
        profile = 'designer';
        console.warn('Doc Studio: FMDocEditor "website" profile unavailable — falling back to "designer".');
      }
      try {
        // Shared visual-editor chrome (global FMVisualEditor): identical
        // Canva-style rail/panels as the Web Editor, document-flavored
        // defaults. Falls back to the bare doc editor on older loaders.
        const mountEditor = window.FMVisualEditor?.mount || window.FMDocEditor.mount;
        const chromeOpts = window.FMVisualEditor?.mount ? { chrome: {
          contentKind: 'document',
          orgId: orgId(),
          upload: { ownerType: 'document_folder_item', ownerId: firstText(state.folderItem?.id, 'item'), collection: 'documents' }
        } } : {};
        state.itemEditorHandle = mountEditor(canvas, {
          ...chromeOpts,
          document: clone(state.folderItemDef),
          theme: arrayValue(state.catalog?.themes)[0]?.definition || null,
          themeContext: { branding: objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding) },
          profile,
          // Folder documents are word-processing documents, so open them in
          // Doc mode. Visual documents keep the free-form media canvas.
          mode: isVisualDocument ? 'visual' : 'doc',
          agentEnabled: capabilityEnabled('documents.agent'),
          catalog: state.catalog,
          capabilities: objectValue(state.catalog?.capabilities),
          resolveScope: sampleScope(),
          collaboration: { actor: editorActor() },
          documentActions: folderItemDocumentActions(),
          sidePanels: capabilityEnabled('documents.agent')
            ? [{ id: 'agent', label: (globalThis.PlatformLanguage?.text("documents","m_b8071e017821d8","Agent") ?? "Agent"), render: (host) => mountFolderItemAgent(host) }]
            : [],
          onDictate: () => transcribeDocumentDictation(orgId(), state.folderItem?.name),
          media: {
            pick(){
              return pickDocumentMedia({ organizationId: orgId(), ownerType: 'document_folder_item', ownerId: firstText(state.folderItem?.id, 'item') });
            },
            url(mediaRef, variant){ return mediaRefUrl(mediaRef, variant); }
          },
          onChange: (doc) => {
            state.folderItemDef = doc;
            state.folderItemDirty = true;
            setItemSaveState('Unsaved changes', 'dirty');
            scheduleFolderItemAutosave();
          }
        });
      } catch (error) {
        console.warn('FMDocEditor mount failed', error);
        canvas.innerHTML = `<div class="fmdx-state" style="margin:20px"><i class="fas fa-triangle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.text("documents","m_61445ee660b4e6","Editor failed to start") ?? "Editor failed to start")}</strong><span>${String(esc(errorMessage(error, '')))}</span></div>`;
      }
    }

    function scheduleFolderItemAutosave(){
      clearTimeout(state.folderItemSaveTimer);
      state.folderItemSaveTimer = setTimeout(() => saveFolderItem(), 800);
    }

    async function saveFolderItem(){
      if (!state.folderItem?.id) return;
      if (state.folderItemSaving) { state.folderItemQueued = true; return; }
      state.folderItemSaving = true;
      setItemSaveState('Saving…', 'saving');
      try {
        const definition = clone(state.itemEditorHandle?.getDocument?.() || state.folderItemDef);
        const res = await api().folders.items.patch(orgId(), state.folderItem.folder_id, state.folderItem.id, {
          definition,
          expected_revision: Number(state.folderItem.revision || 0) || undefined
        });
        const updated = objectValue(res.item || res);
        if (updated.id) state.folderItem = { ...state.folderItem, ...updated };
        state.folderItemDirty = false;
        setItemSaveState('Saved', 'saved');
      } catch (error) {
        if (Number(error?.status) === 409) {
          setItemSaveState('Conflict — reopen to continue', 'error');
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_8fb661900ff3cb","Someone else saved this item. Go back and reopen it to continue.") ?? "Someone else saved this item. Go back and reopen it to continue."), false);
        } else {
          setItemSaveState('Save failed — retrying on next change', 'error');
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not save the item.'), false);
        }
      } finally {
        state.folderItemSaving = false;
        if (state.folderItemQueued) { state.folderItemQueued = false; scheduleFolderItemAutosave(); }
      }
    }

    // -------------------------------------------------------- new template
    async function openNewTemplateModal(){
      await loadCatalog();
      const types = arrayValue(state.catalog.types).length
        ? state.catalog.types
        : Object.keys(TYPE_ICONS).filter((k) => k !== 'receipt').map((id) => ({ id, label: typeLabel(id), icon: TYPE_ICONS[id] }));
      let selectedType = '';
      const modal = openModal(`<h2><i class="fas fa-file-circle-plus"></i>${(globalThis.PlatformLanguage?.text("documents","m_fc61a22aa7a62e"," New template") ?? " New template")}</h2><div data-nt-body></div>`);
      const body = modal.el.querySelector('[data-nt-body]');
      function renderBody(){
        body.innerHTML = `
          <p class="fmdx-section-label">${(globalThis.PlatformLanguage?.text("documents","m_61cd09102e4af8","Document type") ?? "Document type")}</p>
          <div class="fmdx-pick-grid" style="margin-bottom:14px">
            ${String(types.map((type) => {
              const id = firstText(type.id, type.type);
              return `<button type="button" class="fmdx-pick-card ${selectedType === id ? 'selected' : ''}" data-nt-type="${esc(id)}">
                <span class="fmdx-pick-icon"><i class="fas ${esc(typeIcon(id, types))}"></i></span>
                <strong>${esc(typeLabel(id, types))}</strong>
              </button>`;
            }).join(''))}
          </div>
          <label class="fmdx-field"><span>${(globalThis.PlatformLanguage?.text("documents","m_c4b7cbfdc9b700","Template name") ?? "Template name")}</span><input type="text" data-nt-name placeholder="${(globalThis.PlatformLanguage?.text("documents","m_a3fa22cfb77342","e.g. Roofing Proposal") ?? "e.g. Roofing Proposal")}" value="${String(selectedType ? esc(`${typeLabel(selectedType, types)} Template`) : '')}"></label>
          ${String(capabilityEnabled('documents.agent') ? '<label class="fmdx-field"><span>Describe it to the design copilot (optional)</span><textarea data-nt-brief rows="3" placeholder="Describe the pages and content you want the agent to build"></textarea></label>' : '')}
          ${String(capabilityEnabled('documents.agent') && capabilityEnabled('documents.ingestion') ? '<label class="fmdx-field"><span>Or upload examples (optional — PDFs or photos of your current documents)</span><input type="file" data-nt-files multiple accept="application/pdf,image/jpeg,image/png,image/webp"></label>' : '')}
          <label style="display:${String(capabilityEnabled('documents.agent') && capabilityEnabled('documents.ingestion') ? 'flex' : 'none')};align-items:flex-start;gap:8px;margin:2px 0 8px;font-size:12.5px;color:#344054;cursor:pointer">
            <input type="checkbox" data-nt-upload-intake style="margin-top:2px">
            <span><strong>${(globalThis.PlatformLanguage?.text("documents","m_a8ed0c6ffb232c","Paper-upload template") ?? "Paper-upload template")}</strong>${(globalThis.PlatformLanguage?.text("documents","m_948818a6bffdc0"," — the document stays on paper. Instead of recreating pages, the copilot drafts the ") ?? " — the document stays on paper. Instead of recreating pages, the copilot drafts the ")}<em>${(globalThis.PlatformLanguage?.text("documents","m_52ef509a9e98db","fields to capture") ?? "fields to capture")}</em>${(globalThis.PlatformLanguage?.text("documents","m_d413785abac736"," from each uploaded contract (parties, dates, prices, signatures); you adjust them visually in the editor.") ?? " from each uploaded contract (parties, dates, prices, signatures); you adjust them visually in the editor.")}</span>
          </label>
          ${String(capabilityEnabled('documents.agent') && capabilityEnabled('documents.ingestion') ? '<p class="fmdx-data-hint" style="margin:0">With examples the copilot recreates your existing paperwork as a reusable template and you refine it in the editor.</p>' : '')}
          <div class="fmdx-modal-foot">
            <button type="button" class="fmdx-btn primary" data-nt-create ${String(selectedType ? '' : 'disabled')}><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("documents","m_93873c9aca2d63"," Create & design") ?? " Create & design")}</button>
          </div>`;
        body.querySelectorAll('[data-nt-type]').forEach((btn) => btn.addEventListener('click', () => { selectedType = btn.dataset.ntType; renderBody(); }));
        body.querySelector('[data-nt-create]')?.addEventListener('click', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          const originalHtml = button.innerHTML;
          try {
            const name = firstText(body.querySelector('[data-nt-name]')?.value, `${typeLabel(selectedType, types)} Template`);
            const brief = firstText(body.querySelector('[data-nt-brief]')?.value);
            const exampleFiles = [...(body.querySelector('[data-nt-files]')?.files || [])];
            const uploadIntake = body.querySelector('[data-nt-upload-intake]')?.checked === true;
            if (uploadIntake) {
              // Paper-upload template: draft the FIELD SCHEMA (not pages).
              button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Drafting fields…';
              let created;
              if (exampleFiles.length) {
                const file = exampleFiles[0];
                const res = await api().ingestion.draftTemplate(orgId(), {
                  file_name: file.name,
                  content_type: cleanText(file.type) || undefined,
                  data_base64: await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result || '').split(',').pop() || '');
                    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
                    reader.readAsDataURL(file);
                  }),
                  name,
                  document_type: selectedType
                });
                const draft = objectValue(res.draft);
                if (firstText(draft.notes)) showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), cleanText(draft.notes), true);
                created = await api().templates.create(orgId(), {
                  name: firstText(name, draft.name),
                  document_type: firstText(draft.document_type, selectedType),
                  description: (globalThis.PlatformLanguage?.text("documents","m_a3b3f938c99af0","Paper contract upload with agent-assisted field extraction.") ?? "Paper contract upload with agent-assisted field extraction."),
                  definition: objectValue(draft.definition),
                  metadata: { intake: 'upload' }
                });
              } else {
                // No example: start from the standard contract fields.
                const definition = objectValue(window.FMDocModel?.createDocument?.({ kind: 'document', first_page_role: 'body', metadata: { intake: 'upload' } }));
                definition.params = {
                  customer_name: { type: 'string', label: (globalThis.PlatformLanguage?.text("documents","m_753e7b59d4e9aa","Customer name") ?? "Customer name") },
                  contract_date: { type: 'date', label: (globalThis.PlatformLanguage?.text("documents","m_5d35a4cf804863","Contract date") ?? "Contract date") },
                  total_cents: { type: 'currency', label: (globalThis.PlatformLanguage?.text("documents","m_1e2d8af0f2039b","Contract total") ?? "Contract total") },
                  deposit_cents: { type: 'currency', label: (globalThis.PlatformLanguage?.text("documents","m_894309a0cbf8a4","Deposit") ?? "Deposit") },
                  work_summary: { type: 'text', label: (globalThis.PlatformLanguage?.text("documents","m_655db76de2288c","Work summary") ?? "Work summary") }
                };
                definition.outputs = {
                  sig_customer: { type: 'signature', required: true, signer: 'customer', label: (globalThis.PlatformLanguage?.text("documents","m_043a279788edc3","Customer signature") ?? "Customer signature") },
                  sig_company: { type: 'signature', signer: 'internal', label: (globalThis.PlatformLanguage?.text("documents","m_4f0f06ee7056a5","Company signature") ?? "Company signature") }
                };
                definition.metadata = { ...objectValue(definition.metadata), intake: 'upload' };
                created = await api().templates.create(orgId(), {
                  name,
                  document_type: selectedType,
                  description: (globalThis.PlatformLanguage?.text("documents","m_a3b3f938c99af0","Paper contract upload with agent-assisted field extraction.") ?? "Paper contract upload with agent-assisted field extraction."),
                  definition,
                  metadata: { intake: 'upload' }
                });
              }
              const template = objectValue(created.template || created);
              modal.close();
              await loadLists();
              openTemplateEditor(template);
              return;
            }
            if (exampleFiles.length) {
              // Vision path: the server drafts the template from the examples;
              // the studio opens it beside the agent for refinement.
              button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Designing from your examples…';
              const files = [];
              for (const file of exampleFiles.slice(0, 6)) {
                files.push({
                  file_name: file.name,
                  content_type: cleanText(file.type) || undefined,
                  data_base64: await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result || '').split(',').pop() || '');
                    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
                    reader.readAsDataURL(file);
                  })
                });
              }
              const res = await api().templates.fromExamples(orgId(), {
                name,
                document_type: selectedType,
                ...(brief ? { notes: brief } : {}),
                files
              });
              const template = objectValue(res.template);
              if (firstText(res.notes)) showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), cleanText(res.notes), true);
              modal.close();
              await loadLists();
              openTemplateEditor(template);
              return;
            }
            const catalogType = types.find((t) => firstText(t.id, t.type) === selectedType) || {};
            // Seed from the type's seeded template when available, else blank.
            const seeded = arrayValue(catalogType.seeded_templates)[0];
            const definition = objectValue(seeded?.definition).pages ? clone(seeded.definition) : blankDefinition(selectedType);
            if (!objectValue(seeded?.definition).pages) await applyFontToBlankDocument(definition);
            definition.metadata = { ...objectValue(definition.metadata), document_type: selectedType };
            const res = await api().templates.create(orgId(), { name, document_type: selectedType, definition });
            const template = objectValue(res.template || res);
            state.pendingAgentBrief = brief || null;
            modal.close();
            await loadLists();
            openTemplateEditor({ ...template, definition: template.definition || definition });
          } catch (error) {
            button.disabled = false;
            button.innerHTML = originalHtml;
            showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not create the template.'), false);
          }
        });
      }
      renderBody();
    }

    // ----------------------------------------------------- template editor
    function schemaRowsFromDefs(defs){
      return Object.entries(objectValue(defs)).map(([key, def]) => ({
        key,
        type: firstText(objectValue(def).type, 'string'),
        label: cleanText(objectValue(def).label),
        required: objectValue(def).required === true,
        extra: (() => { const { type, label, required, ...rest } = objectValue(def); return rest; })()
      }));
    }
    function defsFromSchemaRows(rows){
      const defs = {};
      rows.forEach((row) => {
        const key = cleanText(row.key).replace(/[^a-zA-Z0-9_]/g, '_');
        if (!key) return;
        defs[key] = { ...objectValue(row.extra), type: row.type, ...(row.label ? { label: row.label } : {}), ...(row.required ? { required: true } : {}) };
      });
      return defs;
    }

    const TEMPLATE_SCHEDULE_DUE_OPTIONS = [
      { value: 'on_signature', label: (globalThis.PlatformLanguage?.text("documents","m_59188fee8a4092","On signature") ?? "On signature") },
      { value: 'project_completion', label: (globalThis.PlatformLanguage?.text("documents","m_840d3d973229d1","On completion") ?? "On completion") },
      { value: 'on_invoice', label: (globalThis.PlatformLanguage?.text("documents","m_7e182460eb9a7a","When invoiced") ?? "When invoiced") },
      { value: 'on_date', label: (globalThis.PlatformLanguage?.text("documents","m_b05e5c3ce8a9f2","Specific date") ?? "Specific date") }
    ];

    function templateScheduleParamRow(){
      return state.paramRows.find((row) => cleanText(row.key) === 'payment_schedule' || cleanText(row.type) === 'payment_schedule') || null;
    }

    function normalizedTemplateScheduleDefaults(){
      const row = templateScheduleParamRow();
      return arrayValue(objectValue(row?.extra).default).map((entry, index) => {
        const source = objectValue(entry);
        const label = firstText(source.label, source.name, index === 0 ? 'Deposit' : 'Payment');
        return {
          id: firstText(source.id, `template_schedule_${index + 1}`),
          label,
          kind: 'percent',
          percent: Math.max(0, Number(source.percent ?? (Number(source.percent_bps || 0) / 100)) || 0),
          payment_kind: firstText(source.payment_kind, /deposit/i.test(label) ? 'deposit' : (/final|balance/i.test(label) ? 'final' : 'progress')),
          due_rule: firstText(source.due_rule, source.due, index === 0 ? 'on_signature' : 'project_completion')
        };
      });
    }

    function setTemplateScheduleDefaults(rows){
      let param = templateScheduleParamRow();
      if (!param) {
        param = { key: 'payment_schedule', type: 'payment_schedule', label: (globalThis.PlatformLanguage?.text("documents","m_efee8a08306ce6","Payment schedule") ?? "Payment schedule"), required: true, extra: {} };
        state.paramRows.push(param);
      }
      param.key = 'payment_schedule';
      param.type = 'payment_schedule';
      param.extra = { ...objectValue(param.extra), default: clone(rows) };
      state.sampleParams = { ...objectValue(state.sampleParams), payment_schedule: clone(rows) };
      state.dirty = true;
      setTemplateSaveState('Payment schedule staged — save or publish', 'dirty');
    }

    function templateScheduleDefaultsHtml(){
      const param = templateScheduleParamRow();
      const rows = normalizedTemplateScheduleDefaults();
      const percentTotal = rows.reduce((sum, row) => sum + Number(row.percent || 0), 0);
      return `
        <p class="fmdx-section-label">${(globalThis.PlatformLanguage?.text("documents","m_99e59c09f40339","Payment schedule defaults") ?? "Payment schedule defaults")}</p>
        <p class="fmdx-data-hint">${(globalThis.PlatformLanguage?.text("documents","m_09f013bfbb44c0","These percentage milestones are copied into every document created from this template and resolved against that document's contract total.") ?? "These percentage milestones are copied into every document created from this template and resolved against that document's contract total.")}</p>
        <div class="fmdx-rich-card" data-template-schedule>
          ${String(rows.length ? `<div class="fmdx-sched-rows">
            ${rows.map((row, index) => `<div class="fmdx-sched-row" data-template-schedule-row="${index}">
              <input type="text" data-template-schedule-label value="${esc(row.label)}" placeholder="Milestone">
              <span style="display:flex;align-items:center;gap:4px"><input type="number" data-template-schedule-percent min="0" max="100" step="0.5" value="${esc(row.percent)}"><b>%</b></span>
              <select data-template-schedule-due>${TEMPLATE_SCHEDULE_DUE_OPTIONS.map((option) => `<option value="${esc(option.value)}" ${row.due_rule === option.value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>
              <button type="button" class="fmdx-icon-btn" data-template-schedule-remove title="Remove"><i class="fas fa-trash"></i></button>
            </div>`).join('')}
          </div>
          <p class="fmdx-data-hint" style="${Math.abs(percentTotal - 100) > 0.001 ? 'color:#b42318' : ''}">${percentTotal}% scheduled${Math.abs(percentTotal - 100) > 0.001 ? ' — percentages should total 100%' : ' — ready'}</p>`
          : `<p class="fmdx-data-hint">${param ? 'No default schedule is defined, so new documents receive an empty schedule.' : 'This template has no payment schedule param yet.'}</p>`)}
          <div class="fmdx-rich-actions">
            <button type="button" class="fmdx-btn ghost tiny" data-template-schedule-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("documents","m_00a6dac3bb30c9"," Add milestone") ?? " Add milestone")}</button>
            <button type="button" class="fmdx-btn ghost tiny" data-template-schedule-preset><i class="fas fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.text("documents","m_e718d425696681"," 30% deposit / 70% completion") ?? " 30% deposit / 70% completion")}</button>
          </div>
        </div>`;
    }

    function bindTemplateScheduleDefaults(side){
      const rows = normalizedTemplateScheduleDefaults();
      side.querySelectorAll('[data-template-schedule-row]').forEach((rowEl) => {
        const index = Number(rowEl.dataset.templateScheduleRow);
        const commit = () => { setTemplateScheduleDefaults(rows); renderSchemaPanel(); };
        rowEl.querySelector('[data-template-schedule-label]')?.addEventListener('change', (event) => {
          rows[index].label = cleanText(event.target.value) || rows[index].label;
          rows[index].payment_kind = /deposit/i.test(rows[index].label) ? 'deposit' : (/final|balance/i.test(rows[index].label) ? 'final' : 'progress');
          commit();
        });
        rowEl.querySelector('[data-template-schedule-percent]')?.addEventListener('change', (event) => { rows[index].percent = Math.max(0, Number(event.target.value) || 0); commit(); });
        rowEl.querySelector('[data-template-schedule-due]')?.addEventListener('change', (event) => { rows[index].due_rule = cleanText(event.target.value); commit(); });
        rowEl.querySelector('[data-template-schedule-remove]')?.addEventListener('click', () => { rows.splice(index, 1); commit(); });
      });
      side.querySelector('[data-template-schedule-add]')?.addEventListener('click', () => {
        rows.push({ id: `template_schedule_${rows.length + 1}`, label: rows.length ? 'Payment' : 'Deposit', kind: 'percent', percent: 0, payment_kind: rows.length ? 'progress' : 'deposit', due_rule: rows.length ? 'project_completion' : 'on_signature' });
        setTemplateScheduleDefaults(rows);
        renderSchemaPanel();
      });
      side.querySelector('[data-template-schedule-preset]')?.addEventListener('click', () => {
        setTemplateScheduleDefaults([
          { id: 'deposit', label: (globalThis.PlatformLanguage?.text("documents","m_894309a0cbf8a4","Deposit") ?? "Deposit"), kind: 'percent', percent: 30, payment_kind: 'deposit', due_rule: 'on_signature' },
          { id: 'final', label: (globalThis.PlatformLanguage?.text("documents","m_eb3b751277fbeb","Final payment") ?? "Final payment"), kind: 'percent', percent: 70, payment_kind: 'final', due_rule: 'project_completion' }
        ]);
        renderSchemaPanel();
      });
    }

    async function openTemplateEditor(template){
      destroyTemplateEditor();
      state.view = 'template';
      requestEditorSidebar();
      state.template = objectValue(template);
      state.definition = null;
      state.dirty = false;
      renderTemplateEditor();
      await loadCatalog();
      const definition = (await templateDefinition(state.template)) || blankDefinition(state.template.document_type);
      if (state.destroyed || state.view !== 'template') return;
      state.definition = definition;
      state.paramRows = schemaRowsFromDefs(definition.params);
      state.outputRows = schemaRowsFromDefs(definition.outputs);
      state.editPolicy = normalizeEditPolicy(definition.edit_policy);
      state.sampleParams = sampleParamsForDefs(templateParamDefs());
      renderTemplateEditor();
      mountTemplateCanvas();
      renderSchemaPanel();
      // Agent-first creation: jump straight to the Agent tab so the kickoff
      // brief (sent by mountTemplateAgent) is visible from the first second.
      if (state.pendingAgentBrief) state.editorHandle?.openSidePanel?.('agent');
    }

    // Param defs for sample generation: the type's registered schema layered
    // with the template's own param definitions.
    function templateParamDefs(){
      const catalogType = arrayValue(state.catalog?.types).find((t) => firstText(t.id, t.type) === cleanText(state.template?.document_type)) || {};
      return { ...objectValue(catalogType.param_schema), ...defsFromSchemaRows(state.paramRows) };
    }

    function sampleScope(){
      return {
        params: objectValue(state.sampleParams),
        outputs: {},
        project: clone(SAMPLE_PROJECT),
        customer: clone(SAMPLE_CUSTOMER),
        org: { id: orgId(), name: firstText(window.__APP?.orgName, window.Portal?.cfg?.orgName, 'Your Company') }
      };
    }

    function destroyTemplateAgent(){
      try { state.templateAgent?.destroy?.(); } catch (e) {}
      state.templateAgent = null;
    }

    function mountTemplateAgent(host){
      destroyTemplateAgent();
      if (!window.FMDocAgentPanel?.create) {
        host.innerHTML = `<div class="fmdx-state" style="margin:14px"><span>${(globalThis.PlatformLanguage?.text("documents","m_85a6a9fb425b48","The design copilot library is not loaded.") ?? "The design copilot library is not loaded.")}</span></div>`;
        return;
      }
      const kickoffBrief = firstText(state.pendingAgentBrief);
      state.pendingAgentBrief = null;
      state.templateAgent = window.FMDocAgentPanel.create(host, {
        orgId: orgId(),
        subjectId: firstText(state.template?.id),
        title: (globalThis.PlatformLanguage?.text("documents","m_e787439f610290","Design copilot") ?? "Design copilot"),
        initialMessage: kickoffBrief,
        placeholder: (globalThis.PlatformLanguage?.text("documents","m_f40a4b677e19ea","Describe the design change…") ?? "Describe the design change…"),
        welcome: 'Tell me what this template should look like — layout, copy, params — and I’ll edit the canvas in real time.',
        suggestions: [
          'Add a signature block on the last page',
          'Tighten the cover page copy and make the headline bolder',
          'Add a deposit_cents param and bind it under the total'
        ],
        getInput: () => ({
          mode: 'template',
          subject: {
            id: firstText(state.template?.id),
            name: firstText(state.template?.name),
            document_type: cleanText(state.template?.document_type) || 'generic',
            current_version: Number(state.template?.current_version || 0)
          },
          definition: objectValue(currentTemplateDefinition())
        }),
        onAction: (action) => {
          if (cleanText(objectValue(action).type) !== 'document.set_definition') return;
          const doc = clone(objectValue(objectValue(action).document));
          if (!arrayValue(doc.pages).length && !doc.root) return;
          try { state.editorHandle?.setDocument?.(clone(doc), { source: 'agent' }); } catch (error) { console.warn('Agent document apply failed', error); }
          state.definition = clone(state.editorHandle?.getDocument?.() || doc);
          state.paramRows = schemaRowsFromDefs(state.definition.params);
          state.outputRows = schemaRowsFromDefs(state.definition.outputs);
          state.editPolicy = normalizeEditPolicy(state.definition.edit_policy);
          state.dirty = true;
          setTemplateSaveState('Agent changes staged — save or publish', 'dirty');
          renderSchemaPanel();
        }
      });
    }

    function destroyTemplateEditor(){
      destroyTemplateAgent();
      try { state.editorHandle?.destroy?.(); } catch (e) {}
      state.editorHandle = null;
      state.schemaPanelHost = null;
    }

    function currentTemplateDefinition(){
      const fromEditor = state.editorHandle?.getDocument?.();
      const definition = clone(fromEditor || state.definition || blankDefinition(state.template?.document_type));
      definition.params = defsFromSchemaRows(state.paramRows);
      definition.outputs = defsFromSchemaRows(state.outputRows);
      if (state.editPolicy) definition.edit_policy = editPolicyForDefinition(state.editPolicy);
      definition.metadata = { ...objectValue(definition.metadata), document_type: cleanText(state.template?.document_type) || 'generic' };
      return definition;
    }

    function closeTemplateEditor(){
      destroyTemplateEditor();
      state.view = 'list';
      releaseEditorSidebar();
      state.template = null;
      state.definition = null;
      render();
      loadLists();
    }

    async function openTemplateVersionHistory(){
      const template = state.template || {};
      const modal = openModal(`<h2><i class="fas fa-clock-rotate-left"></i>${(globalThis.PlatformLanguage?.text("documents","m_b5edeb48c05298"," Version history") ?? " Version history")}</h2><div class="fmdx-state" style="margin:0" data-template-versions><div class="fmdx-spinner"></div><strong>${(globalThis.PlatformLanguage?.text("documents","m_905104b843270d","Loading published versions") ?? "Loading published versions")}</strong></div>`);
      const host = modal.el.querySelector('[data-template-versions]');
      try {
        const result = await api().templates.versions(orgId(), template.id);
        const versions = arrayValue(result.versions || result.items).map(objectValue)
          .sort((a, b) => Number(b.version || 0) - Number(a.version || 0));
        if (!host?.isConnected) return;
        host.className = '';
        host.innerHTML = versions.length ? versions.map((version) => `
          <div class="fmdx-list-row">
            <div><strong>${((v0) => globalThis.PlatformLanguage?.text("documents","m_1fc6063a32f556",`Version ${v0}`,{v0}) ?? `Version ${v0}`)(Number(version.version || 0))}</strong><small>${String(esc([version.published_at ? timeAgo(version.published_at) : '', firstText(version.published_by_name, version.published_by_user_id)].filter(Boolean).join(' · ') || 'Published'))}</small></div>
            <button type="button" class="fmdx-btn" data-template-version="${String(Number(version.version || 0))}"><i class="fas fa-rotate-left"></i>${(globalThis.PlatformLanguage?.text("documents","m_d13b90e9d4a614"," Restore draft") ?? " Restore draft")}</button>
          </div>`).join('') : `<div class="fmdx-state" style="margin:0"><strong>${(globalThis.PlatformLanguage?.text("documents","m_3367c266935d72","No published versions yet") ?? "No published versions yet")}</strong><span>${(globalThis.PlatformLanguage?.text("documents","m_91d2192179ff34","Publish the template to create its first version.") ?? "Publish the template to create its first version.")}</span></div>`;
        host.querySelectorAll('[data-template-version]').forEach((button) => button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const result = await api().templates.version(orgId(), template.id, Number(button.dataset.templateVersion));
            const record = objectValue(result.version || result.template_version || result);
            const definition = objectValue(record.definition);
            if (!definition.pages && !definition.root) throw new Error('That version has no document definition.');
            state.definition = clone(definition);
            state.editorHandle?.setDocument?.(state.definition);
            state.dirty = true;
            setTemplateSaveState(`Version ${button.dataset.templateVersion} restored as an unpublished draft`, 'dirty');
            modal.close();
          } catch (error) {
            button.disabled = false;
            showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not restore that version.'), false);
          }
        }));
      } catch (error) {
        if (host) host.innerHTML = `<div class="fmdx-state" style="margin:0"><i class="fas fa-triangle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.text("documents","m_6d6adea169cb64","History unavailable") ?? "History unavailable")}</strong><span>${String(esc(errorMessage(error, 'Could not load template versions.')))}</span></div>`;
      }
    }

    function renderTemplateEditor(){
      if (state.view !== 'template') return;
      if (root.querySelector('[data-studio-tpl-screen]')) return;
      const tpl = state.template || {};
      root.innerHTML = `
        <div class="fmdx-shell">
          <div class="fmdx-studio-editor" data-studio-tpl-screen>
            <header class="fmdx-editor-top">
              <button type="button" class="fmdx-icon-btn" data-tpl-back title="${(globalThis.PlatformLanguage?.text("documents","m_9df2e6130a5af3","Back to templates") ?? "Back to templates")}"><i class="fas fa-arrow-left"></i></button>
              <input class="fmdx-doc-title-input" data-tpl-name value="${String(esc(firstText(tpl.name, 'Untitled template')))}" spellcheck="false">
              ${String(statusChip(tpl.status))}
              <span class="fmdx-chip plain">v${String(Number(tpl.current_version || 0))}</span>
              <span class="fmdx-save-state" data-tpl-save-state></span>
              <div style="margin-left:auto;display:flex;gap:7px;align-items:center;flex-wrap:wrap">
                <button type="button" class="fmdx-btn" data-tpl-schema><i class="fas fa-sliders"></i>${(globalThis.PlatformLanguage?.text("documents","m_6b124d14be8596"," Setup") ?? " Setup")}</button>
                ${String(capabilityEnabled('documents.agent') ? '<button type="button" class="fmdx-btn" data-tpl-agent><i class="fas fa-wand-magic-sparkles"></i> Agent</button>' : '')}
                <button type="button" class="fmdx-btn" data-tpl-save><i class="fas fa-floppy-disk"></i>${(globalThis.PlatformLanguage?.text("documents","m_c723e1998b1b0a"," Save draft") ?? " Save draft")}</button>
                <button type="button" class="fmdx-btn primary" data-tpl-publish><i class="fas fa-rocket"></i>${(globalThis.PlatformLanguage?.text("documents","m_920f7e99dda4ea"," Publish") ?? " Publish")}</button>
              </div>
            </header>
            <div class="fmdx-editor-main">
              <div class="fmdx-editor-canvas" data-tpl-canvas>
                <div class="fmdx-state" style="margin:20px"><div class="fmdx-spinner"></div><strong>${(globalThis.PlatformLanguage?.text("documents","m_dbcfeaabac54d0","Opening template") ?? "Opening template")}</strong></div>
              </div>
            </div>
          </div>
        </div>`;
      root.querySelector('[data-tpl-back]')?.addEventListener('click', () => closeTemplateEditor());
      // Setup and the agent live as tabs in the editor's right tray — one
      // right-hand surface with subtabs, never two competing trays.
      root.querySelector('[data-tpl-schema]')?.addEventListener('click', () => state.editorHandle?.openSidePanel?.('setup'));
      root.querySelector('[data-tpl-agent]')?.addEventListener('click', () => state.editorHandle?.openSidePanel?.('agent'));
      root.querySelector('[data-tpl-name]')?.addEventListener('change', async (event) => {
        const name = cleanText(event.target.value) || 'Untitled template';
        try {
          await api().templates.patch(orgId(), state.template.id, { name });
          state.template = { ...state.template, name };
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not rename the template.'), false);
        }
      });
      root.querySelector('[data-tpl-save]')?.addEventListener('click', (event) => saveTemplateDraft(event.currentTarget));
      root.querySelector('[data-tpl-publish]')?.addEventListener('click', (event) => publishTemplate(event.currentTarget));
    }

    function setTemplateSaveState(text, cls){
      const el = root.querySelector('[data-tpl-save-state]');
      if (!el) return;
      el.className = `fmdx-save-state ${cls || ''}`;
      el.textContent = text || '';
    }

    function mountTemplateCanvas(){
      const canvas = root.querySelector('[data-tpl-canvas]');
      if (!canvas || !state.definition) return;
      if (!window.FMDocEditor?.mount) {
        canvas.innerHTML = `<div class="fmdx-state" style="margin:20px"><i class="fas fa-pen-ruler"></i><strong>${(globalThis.PlatformLanguage?.text("documents","m_d08399aef41777","Editor unavailable") ?? "Editor unavailable")}</strong><span>${(globalThis.PlatformLanguage?.text("documents","m_73ce6add79b014","The document editor library is not loaded — the schema panel still works, and Save/Publish persist it.") ?? "The document editor library is not loaded — the schema panel still works, and Save/Publish persist it.")}</span></div>`;
        return;
      }
      canvas.innerHTML = '';
      try {
        // Shared visual-editor chrome for the Visual mode of the template
        // editor (Doc mode / Preview hide it automatically).
        const mountEditor = window.FMVisualEditor?.mount || window.FMDocEditor.mount;
        const chromeOpts = window.FMVisualEditor?.mount ? { chrome: {
          contentKind: 'document',
          orgId: orgId(),
          upload: { ownerType: 'document_template', ownerId: firstText(state.template?.id, 'template'), collection: 'documents' }
        } } : {};
        state.editorHandle = mountEditor(canvas, {
          ...chromeOpts,
          document: clone(state.definition),
          theme: arrayValue(state.catalog?.themes)[0]?.definition || null,
          themeContext: { branding: objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding) },
          profile: capabilityEnabled('documents.designer_profile') ? 'designer' : 'document',
          // Templates are document definitions, so start on the word-processor
          // surface. Designers can still switch to Visual or Preview.
          mode: 'doc',
          allowedModes: capabilityEnabled('documents.designer_profile') ? ['doc', 'visual', 'preview'] : ['doc', 'preview'],
          agentEnabled: capabilityEnabled('documents.agent'),
          editPolicy: {
            features: {
              widget_insert: arrayValue(state.catalog?.widgets).map((widget) => firstText(widget.id, widget.widget_id)).filter(Boolean),
              ...(capabilityEnabled('documents.advanced_definition_editing') ? {} : { bind_edit: false })
            }
          },
          catalog: state.catalog,
          capabilities: objectValue(state.catalog?.capabilities),
          resolveScope: sampleScope(),
          collaboration: { actor: editorActor() },
          documentActions: { versions: () => openTemplateVersionHistory() },
          // Right-tray tabs: Inspect (editor-owned) + Setup + Agent.
          sidePanels: [
            { id: 'setup', label: (globalThis.PlatformLanguage?.text("documents","m_b06faf127e1505","Setup") ?? "Setup"), render: (host) => { state.schemaPanelHost = host; renderSchemaPanel(); } },
            { id: 'program', label: 'Data & behavior', render: async host => {
              const { mountProgramPanel } = await import('/libraries/apps/documents/program-panel.js');
              if (!host.isConnected) return;
              await mountProgramPanel(host, { organizationId: orgId(), getProgram: () => currentTemplateDefinition().program, onChange(program) {
                const definition = clone(currentTemplateDefinition()); definition.program = program;
                state.definition = definition; state.editorHandle?.setDocument?.(definition); state.dirty = true;
                setTemplateSaveState('Unsaved behavior changes', 'dirty');
              } });
            } },
            ...(capabilityEnabled('documents.agent') ? [{ id: 'agent', label: (globalThis.PlatformLanguage?.text("documents","m_b8071e017821d8","Agent") ?? "Agent"), render: (host) => mountTemplateAgent(host) }] : [])
          ],
          onDictate: () => transcribeDocumentDictation(orgId(), state.template?.name),
          media: {
            pick(){
              return pickDocumentMedia({ organizationId: orgId(), ownerType: 'document_template', ownerId: firstText(state.template?.id, 'template') });
            },
            url(mediaRef, variant){
              const ref = typeof mediaRef === 'string' ? { media_id: mediaRef } : objectValue(mediaRef);
              if (ref.url) return ref.url;
              if (!window.PlatformAPI?.media?.fileUrl) return '';
              return window.PlatformAPI.media.fileUrl(orgId(), firstText(ref.media_id, ref.id), variant || ref.variant || 'original');
            }
          },
          onChange: (doc) => {
            state.definition = doc;
            state.dirty = true;
            setTemplateSaveState('Unsaved changes', 'dirty');
          }
        });
      } catch (error) {
        console.warn('FMDocEditor mount failed', error);
        canvas.innerHTML = `<div class="fmdx-state" style="margin:20px"><i class="fas fa-triangle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.text("documents","m_61445ee660b4e6","Editor failed to start") ?? "Editor failed to start")}</strong><span>${String(esc(errorMessage(error, '')))}</span></div>`;
      }
    }

    function schemaTableHtml(rows, kind){
      const types = kind === 'outputs' ? OUTPUT_TYPES() : PARAM_TYPES();
      const typeDisabled = (type) => (type === 'signature' && !capabilityEnabled('documents.esign')) || ((type === 'payment' || type === 'payment_schedule') && !capabilityEnabled('documents.payments'));
      return `
        <table class="fmdx-schema-table">
          <thead><tr><th>${(globalThis.PlatformLanguage?.text("documents","m_76608e0c91e510","Key") ?? "Key")}</th><th>${(globalThis.PlatformLanguage?.text("documents","m_2e88df13ca7101","Type") ?? "Type")}</th><th>${(globalThis.PlatformLanguage?.text("documents","m_9fd79f4276d659","Label") ?? "Label")}</th><th title="${(globalThis.PlatformLanguage?.text("documents","m_db97f048cd99aa","Required") ?? "Required")}">${(globalThis.PlatformLanguage?.text("documents","m_3bea324566aaf7","Req") ?? "Req")}</th><th></th></tr></thead>
          <tbody>
            ${String(rows.map((row, index) => `
              <tr data-schema-row="${index}">
                <td style="width:30%"><input type="text" data-schema-key value="${esc(row.key)}" placeholder="key"></td>
                <td style="width:26%"><select data-schema-type>${types.map((t) => `<option value="${esc(t)}" ${row.type === t ? 'selected' : ''} ${typeDisabled(t) ? 'disabled' : ''}>${esc(t)}${typeDisabled(t) ? ' (disabled)' : ''}</option>`).join('')}</select></td>
                <td><input type="text" data-schema-label value="${esc(row.label)}" placeholder="Label"></td>
                <td style="width:34px;text-align:center"><input type="checkbox" data-schema-required ${row.required ? 'checked' : ''}></td>
                <td style="width:30px"><button type="button" class="fmdx-icon-btn danger" data-schema-remove title="Remove" style="width:24px;height:24px;font-size:9px"><i class="fas fa-xmark"></i></button></td>
              </tr>`).join(''))}
            ${String(rows.length ? '' : `<tr><td colspan="5" style="text-align:center;color:#98a2b3;font-weight:850;padding:12px">No ${kind} defined</td></tr>`)}
          </tbody>
        </table>
        <button type="button" class="fmdx-btn" data-schema-add style="align-self:flex-start;min-height:30px;font-size:10.5px"><i class="fas fa-plus"></i>${((v2) => globalThis.PlatformLanguage?.text("documents","m_1c6236376deabc",` Add ${v2}`,{v2}) ?? ` Add ${v2}`)(kind === 'outputs' ? 'output' : 'param')}</button>`;
    }

    function renderSchemaPanel(){
      const side = state.schemaPanelHost;
      if (!side || !side.isConnected) return;
      if (!state.editPolicy) state.editPolicy = normalizeEditPolicy(null);
      const policy = state.editPolicy;
      const widgets = arrayValue(state.catalog?.widgets);
      const profileOptions = (selected) => PROFILE_OPTIONS.map((p) => `<option value="${esc(p)}" ${selected === p ? 'selected' : ''}>${esc(p)}</option>`).join('');
      side.innerHTML = `
        <div class="fmdx-data-head">
          <strong><i class="fas fa-sliders"></i>${(globalThis.PlatformLanguage?.text("documents","m_0dd25c7f3e2f90"," Template setup") ?? " Template setup")}</strong>
        </div>
        <div class="fmdx-data-body">
          <p class="fmdx-data-hint">${(globalThis.PlatformLanguage?.text("documents","m_40cc89e053e04d","Params are the data a document asks for when it’s issued — they drive bound text and widgets. Outputs are what it produces: signatures, payments, form values.") ?? "Params are the data a document asks for when it’s issued — they drive bound text and widgets. Outputs are what it produces: signatures, payments, form values.")}</p>
          <p class="fmdx-section-label">${(globalThis.PlatformLanguage?.text("documents","m_c1ae131a4dce26","Params") ?? "Params")}</p>
          <div data-schema-params style="display:flex;flex-direction:column;gap:8px"></div>
          ${String(templateScheduleDefaultsHtml())}
          <p class="fmdx-section-label">${(globalThis.PlatformLanguage?.text("documents","m_2fba86d9405c0d","Outputs") ?? "Outputs")}</p>
          <div data-schema-outputs style="display:flex;flex-direction:column;gap:8px"></div>

          <p class="fmdx-section-label">${(globalThis.PlatformLanguage?.text("documents","m_a1006c93fe3cbe","Edit policy") ?? "Edit policy")}</p>
          <p class="fmdx-data-hint">${(globalThis.PlatformLanguage?.text("documents","m_7d6bfc0f2725e2","What downstream editors may touch when a document is issued from this template. The policy travels with the template.") ?? "What downstream editors may touch when a document is issued from this template. The policy travels with the template.")}</p>
          <div class="fmdx-form-grid" style="grid-template-columns:1fr 1fr">
            <label class="fmdx-field"><span>${(globalThis.PlatformLanguage?.text("documents","m_dbc7ded34a0363","Base profile") ?? "Base profile")}</span><select data-policy-base>${String(profileOptions(policy.base_profile))}</select></label>
            <label class="fmdx-field"><span>${(globalThis.PlatformLanguage?.text("documents","m_97b8ded915cbaa","Max profile (unlock)") ?? "Max profile (unlock)")}</span><select data-policy-max>${String(profileOptions(policy.max_profile))}</select></label>
          </div>
          <label class="fmdx-check"><input type="checkbox" data-policy-unlock ${String(policy.unlock.allowed ? 'checked' : '')}>${(globalThis.PlatformLanguage?.text("documents","m_c5050a2ff26fd7"," Allow unlocking up to the max profile") ?? " Allow unlocking up to the max profile")}</label>
          <label class="fmdx-check"><input type="checkbox" data-policy-pages ${String(policy.features.page_manage ? 'checked' : '')}>${(globalThis.PlatformLanguage?.text("documents","m_f88ecce01514b2"," Allow adding / removing pages") ?? " Allow adding / removing pages")}</label>
          <div>
            <p class="fmdx-data-hint" style="margin-bottom:6px">${(globalThis.PlatformLanguage?.text("documents","m_e87692862927f0","Insertable widgets (none checked = all allowed):") ?? "Insertable widgets (none checked = all allowed):")}</p>
            <div style="display:flex;flex-direction:column;gap:4px;max-height:150px;overflow:auto;border:1px solid #eef0f6;border-radius:10px;padding:8px">
              ${String(widgets.length ? widgets.map((widget) => {
                const id = firstText(widget.id, widget.widget_id);
                return `<label class="fmdx-check" style="min-height:0"><input type="checkbox" data-policy-widget="${esc(id)}" ${policy.features.widget_insert.includes(id) ? 'checked' : ''}> ${esc(firstText(widget.title, id))}</label>`;
              }).join('') : '<span class="fmdx-data-hint">Widget catalog unavailable.</span>')}
            </div>
          </div>

          <p class="fmdx-section-label">${(globalThis.PlatformLanguage?.text("documents","m_456f2a38f6360b","Sample data") ?? "Sample data")}</p>
          <p class="fmdx-data-hint">${(globalThis.PlatformLanguage?.text("documents","m_36ffd77f66c8b6","Feeds the canvas’ binding previews (") ?? "Feeds the canvas’ binding previews (")}<code>${(globalThis.PlatformLanguage?.text("documents","m_5cf416ec8739f9","params.*") ?? "params.*")}</code>, <code>${(globalThis.PlatformLanguage?.text("documents","m_f9efec060a8721","customer.*") ?? "customer.*")}</code>${(globalThis.PlatformLanguage?.text("documents","m_46cf5e3f679f8c",") so the design reads like a real issued document.") ?? ") so the design reads like a real issued document.")}</p>
          <textarea data-sample-json spellcheck="false" style="width:100%;min-height:140px;border:1px solid #d4d9e6;border-radius:10px;padding:9px 11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;font-weight:600;line-height:1.5;color:#111827;background:#fbfcfe">${String(esc(JSON.stringify(objectValue(state.sampleParams), null, 2)))}</textarea>
          <div style="display:flex;gap:7px;flex-wrap:wrap">
            <button type="button" class="fmdx-btn" data-sample-regen style="min-height:30px;font-size:10.5px"><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.text("documents","m_8f6f92ef00448a"," Regenerate from schema") ?? " Regenerate from schema")}</button>
            <button type="button" class="fmdx-btn" data-sample-apply style="min-height:30px;font-size:10.5px"><i class="fas fa-eye"></i>${(globalThis.PlatformLanguage?.text("documents","m_d8c6b198f1978f"," Apply to preview") ?? " Apply to preview")}</button>
          </div>
        </div>
        <div class="fmdx-data-foot">
          <button type="button" class="fmdx-btn primary" data-schema-apply><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.text("documents","m_068dadf3cb9dc7"," Apply to draft") ?? " Apply to draft")}</button>
        </div>`;
      side.querySelector('[data-schema-apply]')?.addEventListener('click', () => {
        syncSchemaRows(side);
        state.dirty = true;
        setTemplateSaveState('Changes staged — save the draft', 'dirty');
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_7e6c5a0aac03f9","Schema and policy staged. Save the draft to persist them.") ?? "Schema and policy staged. Save the draft to persist them."), true);
      });
      // Edit-policy wiring — mutate state.editPolicy live; written into the
      // definition by currentTemplateDefinition() on save/publish.
      const markPolicyDirty = () => { state.dirty = true; setTemplateSaveState('Unsaved changes', 'dirty'); };
      side.querySelector('[data-policy-base]')?.addEventListener('change', (e) => { state.editPolicy.base_profile = e.target.value; markPolicyDirty(); });
      side.querySelector('[data-policy-max]')?.addEventListener('change', (e) => { state.editPolicy.max_profile = e.target.value; markPolicyDirty(); });
      side.querySelector('[data-policy-unlock]')?.addEventListener('change', (e) => { state.editPolicy.unlock.allowed = e.target.checked; markPolicyDirty(); });
      side.querySelector('[data-policy-pages]')?.addEventListener('change', (e) => { state.editPolicy.features.page_manage = e.target.checked; markPolicyDirty(); });
      side.querySelectorAll('[data-policy-widget]').forEach((input) => input.addEventListener('change', () => {
        state.editPolicy.features.widget_insert = [...side.querySelectorAll('[data-policy-widget]')]
          .filter((el) => el.checked)
          .map((el) => el.dataset.policyWidget);
        markPolicyDirty();
      }));
      // Sample-data wiring.
      side.querySelector('[data-sample-regen]')?.addEventListener('click', () => {
        state.sampleParams = sampleParamsForDefs(templateParamDefs());
        const textarea = side.querySelector('[data-sample-json]');
        if (textarea) textarea.value = JSON.stringify(state.sampleParams, null, 2);
      });
      side.querySelector('[data-sample-apply]')?.addEventListener('click', () => {
        const textarea = side.querySelector('[data-sample-json]');
        try {
          state.sampleParams = objectValue(JSON.parse(textarea?.value || '{}'));
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_0bb82cab8bc2af","Sample data is not valid JSON.") ?? "Sample data is not valid JSON."), false);
          return;
        }
        // Remount the canvas with the fresh resolveScope, keeping edits.
        const current = state.editorHandle?.getDocument?.();
        if (current) state.definition = current;
        destroyTemplateEditor();
        mountTemplateCanvas();
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_0c14de7824f7ed","Preview refreshed with your sample data.") ?? "Preview refreshed with your sample data."), true);
      });
      mountSchemaTable(side.querySelector('[data-schema-params]'), state.paramRows, 'params');
      mountSchemaTable(side.querySelector('[data-schema-outputs]'), state.outputRows, 'outputs');
      bindTemplateScheduleDefaults(side);
    }

    function mountSchemaTable(holder, rows, kind){
      if (!holder) return;
      function draw(){
        holder.innerHTML = schemaTableHtml(rows, kind);
        holder.querySelectorAll('[data-schema-row]').forEach((tr) => {
          const index = Number(tr.dataset.schemaRow);
          tr.querySelector('[data-schema-key]')?.addEventListener('change', (e) => { rows[index].key = e.target.value; });
          tr.querySelector('[data-schema-type]')?.addEventListener('change', (e) => {
            rows[index].type = e.target.value;
            if (kind === 'params') renderSchemaPanel();
          });
          tr.querySelector('[data-schema-label]')?.addEventListener('change', (e) => { rows[index].label = e.target.value; });
          tr.querySelector('[data-schema-required]')?.addEventListener('change', (e) => { rows[index].required = e.target.checked; });
          tr.querySelector('[data-schema-remove]')?.addEventListener('click', () => { rows.splice(index, 1); draw(); });
        });
        holder.querySelector('[data-schema-add]')?.addEventListener('click', () => {
          const outputDefault = capabilityEnabled('documents.esign') ? 'signature' : capabilityEnabled('documents.payments') ? 'payment' : 'value';
          rows.push({ key: '', type: kind === 'outputs' ? outputDefault : 'string', label: '', required: false, extra: {} });
          draw();
        });
      }
      draw();
    }

    function syncSchemaRows(side){
      // Rows already track edits via change handlers; nothing else to pull.
      return side;
    }

    async function saveTemplateDraft(button){
      if (!state.template?.id) return;
      if (button) button.disabled = true;
      setTemplateSaveState('Saving…', 'saving');
      try {
        const definition = currentTemplateDefinition();
        const res = await api().templates.patch(orgId(), state.template.id, { definition });
        const updated = objectValue(res.template || res);
        if (updated.id) state.template = { ...state.template, ...updated };
        state.definition = definition;
        state.dirty = false;
        setTemplateSaveState('Draft saved', 'saved');
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_d29d3c59e79b1f","Draft saved.") ?? "Draft saved."), true);
      } catch (error) {
        setTemplateSaveState('Save failed', 'error');
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not save the draft.'), false);
      } finally {
        if (button) button.disabled = false;
      }
    }

    async function publishTemplate(button){
      if (!state.template?.id) return;
      if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Publishing…'; }
      try {
        const definition = currentTemplateDefinition();
        const res = await api().templates.publish(orgId(), state.template.id, {
          definition,
          expected_version: Number(state.template.current_version || 0)
        });
        const updated = objectValue(res.template || res);
        state.template = { ...state.template, ...updated, current_version: Number(updated.current_version || (Number(state.template.current_version || 0) + 1)) };
        state.definition = definition;
        state.dirty = false;
        setTemplateSaveState(`Published v${state.template.current_version}`, 'saved');
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), ((v0) => globalThis.PlatformLanguage?.text("documents","m_d5de6f28071537",`Template published as v${v0}.`,{v0}) ?? `Template published as v${v0}.`)(state.template.current_version), true);
        // Refresh version chip in the header.
        const chip = root.querySelector('[data-studio-tpl-screen] .fmdx-chip.plain');
        if (chip) chip.textContent = `v${state.template.current_version}`;
      } catch (error) {
        if (Number(error?.status) === 409) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_0081fbf6463f30","Publish conflict — someone published a newer version of this template. Reopen it to continue.") ?? "Publish conflict — someone published a newer version of this template. Reopen it to continue."), false);
          setTemplateSaveState('Version conflict', 'error');
        } else {
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not publish the template.'), false);
          setTemplateSaveState('Publish failed', 'error');
        }
      } finally {
        if (button) { button.disabled = false; button.innerHTML = '<i class="fas fa-rocket"></i> Publish'; }
      }
    }

    // ----------------------------------------------------------- workflows
    function workflowStepSummary(definition){
      return arrayValue(objectValue(definition).steps).map((stepValue) => {
        const step = objectValue(stepValue);
        const audiences = arrayValue(step.audience).map(cleanText).filter(Boolean);
        const items = (Array.isArray(step.sections) ? workflowSectionItems(step) : arrayValue(step.items)).map((item) => cleanText(objectValue(item).kind)).filter(Boolean);
        return { id: cleanText(step.id), title: firstText(step.title, step.id, 'Step'), audiences: audiences.length ? audiences : ['internal'], items };
      });
    }

    function renderWorkflowList(body){
      const workflows = arrayValue(state.workflows).filter((w) => cleanText(w.status).toLowerCase() !== 'archived');
      if (!workflows.length) {
        body.innerHTML = `<div class="fmdx-state"><i class="fas fa-list-check"></i><strong>${(globalThis.PlatformLanguage?.text("documents","m_a5f2d1a7c197e8","No workflows yet") ?? "No workflows yet")}</strong><span>${(globalThis.PlatformLanguage?.text("documents","m_010acc914dcb68","Workflows are the guided steppers reps and customers walk through — they fill the same params and outputs the document renders.") ?? "Workflows are the guided steppers reps and customers walk through — they fill the same params and outputs the document renders.")}</span><button type="button" class="fmdx-btn primary" data-empty-new><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("documents","m_71fab9f4454614"," New workflow") ?? " New workflow")}</button></div>`;
        body.querySelector('[data-empty-new]')?.addEventListener('click', () => openNewWorkflowModal());
        return;
      }
      body.innerHTML = `<div class="fmdx-card-grid">
        ${workflows.map((workflow) => `
          <div class="fmdx-tpl-card" data-workflow-card="${String(esc(workflow.id))}">
            <div class="head" data-wf-open style="cursor:pointer">
              <span class="icon"><i class="fas fa-list-check"></i></span>
              <div style="min-width:0">
                <strong>${String(esc(firstText(workflow.name, 'Workflow')))}</strong>
                <small>${String(esc([`v${workflow.current_version || 0}`, workflow.updated_at ? `updated ${timeAgo(workflow.updated_at)}` : ''].filter(Boolean).join(' · ')))}</small>
              </div>
            </div>
            <div class="foot">
              ${String(statusChip(workflow.status))}
              ${String(objectValue(workflow.metadata).preset ? '<span class="fmdx-chip plain">Preset</span>' : '')}
              <span style="margin-left:auto;display:inline-flex;gap:5px">
                <button type="button" class="fmdx-icon-btn" data-wf-edit title="${(globalThis.PlatformLanguage?.text("documents","m_5b9378df7220c1","Edit") ?? "Edit")}"><i class="fas fa-pen"></i></button>
                <button type="button" class="fmdx-icon-btn" data-wf-duplicate title="${(globalThis.PlatformLanguage?.text("documents","m_24fc1d3519ef6a","Duplicate") ?? "Duplicate")}"><i class="fas fa-copy"></i></button>
                <button type="button" class="fmdx-icon-btn danger" data-wf-archive title="${(globalThis.PlatformLanguage?.text("documents","m_5546a92389e386","Archive") ?? "Archive")}"><i class="fas fa-box-archive"></i></button>
              </span>
            </div>
          </div>`).join('')}
      </div>`;
      body.querySelectorAll('[data-workflow-card]').forEach((card) => {
        const workflow = workflows.find((w) => cleanText(w.id) === card.dataset.workflowCard);
        if (!workflow) return;
        card.querySelector('[data-wf-open]')?.addEventListener('click', () => openWorkflowEditor(workflow));
        card.querySelector('[data-wf-edit]')?.addEventListener('click', () => openWorkflowEditor(workflow));
        card.querySelector('[data-wf-duplicate]')?.addEventListener('click', (event) => duplicateWorkflow(workflow, event.currentTarget));
        card.querySelector('[data-wf-archive]')?.addEventListener('click', () => archiveWorkflow(workflow));
      });
    }

    async function workflowDefinition(workflow){
      if (arrayValue(objectValue(workflow?.definition).steps).length) return clone(workflow.definition);
      try {
        const detail = await api().workflows.get(orgId(), workflow.id);
        const record = objectValue(detail.workflow || detail);
        if (arrayValue(objectValue(record.definition).steps).length) return clone(record.definition);
      } catch (error) { console.warn('Workflow definition unavailable', error); }
      return null;
    }

    function blankWorkflowDefinition(name){
      return {
        schema_version: 1,
        name: firstText(name, 'New Workflow'),
        contract: { params: {}, outputs: {} },
        steps: [{ id: 'st_page_1', title: (globalThis.PlatformLanguage?.text("documents","m_6bb8069fae869e","Page 1") ?? "Page 1"), audience: ['internal'], sections: [{ id: 'sec_page_1', title: (globalThis.PlatformLanguage?.text("documents","m_2128b09a02a1b0","Field section") ?? "Field section"), items: [], style: {}, transition: { type: 'grow', duration_ms: 220 } }] }]
      };
    }

    async function duplicateWorkflow(workflow, button){
      if (button) button.disabled = true;
      try {
        const definition = (await workflowDefinition(workflow)) || blankWorkflowDefinition(workflow.name);
        await api().workflows.create(orgId(), { name: `${firstText(workflow.name, 'Workflow')} (copy)`, definition });
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_93bd678bd4a810","Workflow duplicated.") ?? "Workflow duplicated."), true);
        await loadLists();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not duplicate the workflow.'), false);
      } finally {
        if (button) button.disabled = false;
      }
    }

    async function archiveWorkflow(workflow){
      const prompt = `Archive "${firstText(workflow.name, 'this workflow')}"? Documents keep the version they were issued with.`;
      const confirmed = window.Portal?.ui?.confirm ? await window.Portal.ui.confirm(prompt) : window.confirm(prompt);
      if (!confirmed) return;
      try {
        await api().workflows.archive(orgId(), workflow.id);
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_f7c07108755d43","Workflow archived.") ?? "Workflow archived."), true);
        await loadLists();
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not archive the workflow.'), false);
      }
    }

    function openNewWorkflowModal(){
      const sources = arrayValue(state.workflows).filter((w) => cleanText(w.status).toLowerCase() !== 'archived');
      let sourceId = '';
      const modal = openModal(`<h2><i class="fas fa-list-check"></i>${(globalThis.PlatformLanguage?.text("documents","m_71fab9f4454614"," New workflow") ?? " New workflow")}</h2><div data-wf-body></div>`, { className: 'narrow' });
      const body = modal.el.querySelector('[data-wf-body]');
      function renderBody(){
        body.innerHTML = `
          <p class="fmdx-section-label">${(globalThis.PlatformLanguage?.text("documents","m_1ceddb8b63f512","Start from") ?? "Start from")}</p>
          <div class="fmdx-filter-chips" style="margin-bottom:14px">
            <button type="button" class="fmdx-filter-chip ${String(sourceId ? '' : 'active')}" data-wf-source="">${(globalThis.PlatformLanguage?.text("documents","m_2416f559649d73","Blank workflow") ?? "Blank workflow")}</button>
            ${String(sources.map((workflow) => `<button type="button" class="fmdx-filter-chip ${sourceId === cleanText(workflow.id) ? 'active' : ''}" data-wf-source="${esc(workflow.id)}">${esc(firstText(workflow.name, 'Workflow'))}</button>`).join(''))}
          </div>
          <label class="fmdx-field"><span>${(globalThis.PlatformLanguage?.text("documents","m_ae07d3959ed6a0","Workflow name") ?? "Workflow name")}</span><input type="text" data-wf-name placeholder="${(globalThis.PlatformLanguage?.text("documents","m_72a0e216fbae38","e.g. HVAC Start-Work Signature") ?? "e.g. HVAC Start-Work Signature")}" value="${String(esc(sourceId ? `${firstText(sources.find((w) => cleanText(w.id) === sourceId)?.name, 'Workflow')} (copy)` : ''))}"></label>
          <label class="fmdx-field"><span>${(globalThis.PlatformLanguage?.text("documents","m_552be4c8c79e7c","Describe it to the copilot (optional)") ?? "Describe it to the copilot (optional)")}</span><textarea data-wf-brief rows="3" placeholder="${(globalThis.PlatformLanguage?.text("documents","m_cf3ea4c7e55f21","e.g. Field rep measures the roof, picks line items, customer reviews, signs, and pays a 25% deposit — the agent builds the steps and you refine together") ?? "e.g. Field rep measures the roof, picks line items, customer reviews, signs, and pays a 25% deposit — the agent builds the steps and you refine together")}"></textarea></label>
          <div class="fmdx-modal-foot"><button type="button" class="fmdx-btn primary" data-wf-create><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("documents","m_b784be7d40f6fd"," Create workflow") ?? " Create workflow")}</button></div>`;
        body.querySelectorAll('[data-wf-source]').forEach((btn) => btn.addEventListener('click', () => {
          sourceId = btn.dataset.wfSource || '';
          renderBody();
        }));
        body.querySelector('[data-wf-create]')?.addEventListener('click', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const source = sources.find((w) => cleanText(w.id) === sourceId) || null;
            const name = firstText(body.querySelector('[data-wf-name]')?.value, source ? `${firstText(source.name, 'Workflow')} (copy)` : 'New Workflow');
            const definition = source ? ((await workflowDefinition(source)) || blankWorkflowDefinition(name)) : blankWorkflowDefinition(name);
            definition.name = name;
            const res = await api().workflows.create(orgId(), { name, definition });
            const workflow = objectValue(res.workflow || res);
            state.pendingAgentBrief = firstText(body.querySelector('[data-wf-brief]')?.value) || null;
            modal.close();
            await loadLists();
            openWorkflowEditor({ ...workflow, definition: workflow.definition || definition });
          } catch (error) {
            button.disabled = false;
            showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not create the workflow.'), false);
          }
        });
      }
      renderBody();
    }

    async function openWorkflowEditor(workflow){
      state.view = 'workflow';
      requestEditorSidebar();
      state.workflow = objectValue(workflow);
      state.workflowDef = null;
      state.workflowDirty = false;
      renderWorkflowEditor(true);
      await loadCatalog();
      state.workflowDef = (await workflowDefinition(state.workflow)) || blankWorkflowDefinition(state.workflow.name);
      if (state.destroyed || state.view !== 'workflow') return;
      renderWorkflowEditor(true);
    }

    function destroyWorkflowAgent(){
      try { state.workflowAgent?.destroy?.(); } catch (e) {}
      state.workflowAgent = null;
    }

    function destroyWorkflowEditorHandle(){
      destroyWorkflowAgent();
      try { state.workflowEditorHandle?.destroy?.(); } catch (e) {}
      state.workflowEditorHandle = null;
    }

    function closeWorkflowEditor(){
      destroyWorkflowEditorHandle();
      state.view = 'list';
      releaseEditorSidebar();
      state.tab = 'workflows';
      state.workflow = null;
      state.workflowDef = null;
      render();
      loadLists();
    }

    // ── Workflow editor: thin host around the shared visual editor ────────────
    function workflowItemKinds(){
      const kinds = arrayValue(state.catalog?.itemKinds)
        .map((entry) => ({
          ...objectValue(entry),
          id: firstText(objectValue(entry).id),
          disabled: objectValue(entry).disabled === true,
          disabled_reason: firstText(objectValue(entry).disabled_reason),
          disabled_capability: firstText(objectValue(entry).disabled_capability)
        }))
        .filter((entry) => entry.id);
      if (kinds.length) return kinds;
      return [
        { id: 'text' }, { id: 'currency' }, { id: 'number' }, { id: 'select' }, { id: 'multi_select' },
        { id: 'boolean' }, { id: 'date' }, { id: 'media_picker' }, { id: 'measurements' }, { id: 'piece_select' },
        { id: 'line_items_review' }, { id: 'content_blocks' }, { id: 'line_item_editor' }, { id: 'choice_group' },
        { id: 'review' }, { id: 'generate_document' },
        { id: 'signature', disabled: !capabilityEnabled('documents.esign'), disabled_reason: 'E-signature is disabled for this organization.', disabled_capability: 'documents.esign' },
        { id: 'payment', disabled: !capabilityEnabled('documents.payments'), disabled_reason: 'Payments is disabled for this organization.', disabled_capability: 'documents.payments' }
      ];
    }

    function setWorkflowSaveState(text, cls){
      const el = root.querySelector('[data-wf-save-state]');
      if (!el) return;
      el.className = `fmdx-save-state ${cls || ''}`;
      el.textContent = text || '';
    }

    function markWorkflowDirty(message){
      state.workflowDirty = true;
      setWorkflowSaveState(message || 'Unpublished changes', 'dirty');
    }

    function currentWorkflowDefinition(){
      if (state.workflowEditorHandle?.getDefinition) state.workflowDef = state.workflowEditorHandle.getDefinition();
      if (state.workflowDef) state.workflowDef.name = firstText(state.workflow?.name, state.workflowDef.name, 'Workflow');
      return state.workflowDef;
    }

    function renderWorkflowDefinitionPanel(host){
      if (!host) return;
      const definition = objectValue(currentWorkflowDefinition());
      host.innerHTML = `
        <div class="fmdx-data-head"><strong><i class="fas fa-code"></i>${(globalThis.PlatformLanguage?.text("documents","m_cb3ffee428ed81"," Workflow definition") ?? " Workflow definition")}</strong></div>
        <div class="fmdx-data-body">
          <p class="fmdx-data-hint">${(globalThis.PlatformLanguage?.text("documents","m_2b7026aa5bda31","The shared visual editor owns page and element design. This JSON contains the same workflow contract, conditions, and the visual page documents.") ?? "The shared visual editor owns page and element design. This JSON contains the same workflow contract, conditions, and the visual page documents.")}</p>
          <textarea class="fmdx-wf-json" data-wf-definition-json spellcheck="false" style="min-height:420px">${String(esc(JSON.stringify(definition, null, 2)))}</textarea>
          <button type="button" class="fmdx-btn primary" data-wf-definition-apply><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.text("documents","m_71b6a6dfb3851c"," Apply definition") ?? " Apply definition")}</button>
        </div>`;
      host.querySelector('[data-wf-definition-apply]')?.addEventListener('click', () => {
        try {
          const next = objectValue(JSON.parse(host.querySelector('[data-wf-definition-json]')?.value || '{}'));
          if (!Array.isArray(next.steps) || !next.steps.length) throw new Error('A workflow needs at least one page.');
          next.name = firstText(state.workflow?.name, next.name, 'Workflow');
          state.workflowDef = next;
          state.workflowEditorHandle?.setDefinition?.(next);
          markWorkflowDirty('Definition changes staged — publish to go live');
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'The definition is not valid JSON.'), false);
        }
      });
    }

    function mountWorkflowAgent(hostEl){
      destroyWorkflowAgent();
      if (!hostEl) return;
      if (!window.FMDocAgentPanel?.create) {
        hostEl.innerHTML = `<div class="fmdx-state" style="margin:14px"><span>${(globalThis.PlatformLanguage?.text("documents","m_85a6a9fb425b48","The design copilot library is not loaded.") ?? "The design copilot library is not loaded.")}</span></div>`;
        return;
      }
      const kickoffBrief = state.workflowDef ? firstText(state.pendingAgentBrief) : '';
      if (state.workflowDef) state.pendingAgentBrief = null;
      state.workflowAgent = window.FMDocAgentPanel.create(hostEl, {
        orgId: orgId(),
        subjectId: firstText(state.workflow?.id),
        title: (globalThis.PlatformLanguage?.text("documents","m_5bf6eed0ca7dde","Workflow copilot") ?? "Workflow copilot"),
        initialMessage: kickoffBrief,
        placeholder: (globalThis.PlatformLanguage?.text("documents","m_6a6106ad2dc7f1","Describe the workflow change…") ?? "Describe the workflow change…"),
        welcome: 'Tell me what this workflow should collect. Changes land directly in the shared visual editor.',
        suggestions: [
          'Add a customer page with a signature and a deposit payment',
          'Add an internal measurements page before the line items',
          'Make every field on the first page required'
        ],
        getInput: () => ({
          mode: 'workflow',
          subject: { id: firstText(state.workflow?.id), name: firstText(state.workflow?.name), current_version: Number(state.workflow?.current_version || 0) },
          definition: objectValue(currentWorkflowDefinition())
        }),
        onAction: (action) => {
          if (cleanText(objectValue(action).type) !== 'workflow.set_definition') return;
          state.workflowDef = clone(objectValue(objectValue(action).definition));
          state.workflowDef.name = firstText(state.workflow?.name, state.workflowDef.name);
          state.workflowEditorHandle?.setDefinition?.(state.workflowDef);
          markWorkflowDirty('Agent changes staged — publish to go live');
        }
      });
    }

    async function publishWorkflow(button){
      const definition = currentWorkflowDefinition();
      if (!definition) return;
      button.disabled = true;
      button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Publishing…';
      try {
        const res = await api().workflows.publish(orgId(), state.workflow.id, {
          definition,
          expected_version: Number(state.workflow.current_version || 0)
        });
        const updated = objectValue(res.workflow || res);
        state.workflow = { ...state.workflow, ...updated, current_version: Number(updated.current_version || (Number(state.workflow.current_version || 0) + 1)) };
        state.workflowDef = definition;
        state.workflowDirty = false;
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), ((v0) => globalThis.PlatformLanguage?.text("documents","m_b704249adc66d7",`Workflow published as v${v0}.`,{v0}) ?? `Workflow published as v${v0}.`)(state.workflow.current_version), true);
        renderWorkflowEditor(true);
      } catch (error) {
        const issues = arrayValue(objectValue(error?.body || error?.data).issues || error?.issues);
        const detail = issues.length
          ? issues.slice(0, 3).map((issue) => `${arrayValue(objectValue(issue).path).join('.')}: ${cleanText(objectValue(issue).message)}`).join(' · ')
          : errorMessage(error, 'Could not publish the workflow.');
        showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), detail, false);
        button.disabled = false;
        button.innerHTML = '<i class="fas fa-rocket"></i> Publish';
      }
    }

    function mountWorkflowCanvas(){
      const canvas = root.querySelector('[data-wf-canvas]');
      if (!canvas || !state.workflowDef) return;
      if (!window.FMWorkflowEditor?.mount) {
        canvas.innerHTML = `<div class="fmdx-state" style="margin:20px"><i class="fas fa-triangle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.text("documents","m_d08399aef41777","Editor unavailable") ?? "Editor unavailable")}</strong><span>${(globalThis.PlatformLanguage?.text("documents","m_effa54f1cbb776","The shared workflow wrapper is not loaded.") ?? "The shared workflow wrapper is not loaded.")}</span></div>`;
        return;
      }
      canvas.innerHTML = '';
      try {
        state.workflowEditorHandle = window.FMWorkflowEditor.mount(canvas, {
          definition: clone(state.workflowDef),
          name: firstText(state.workflow?.name),
          itemKinds: workflowItemKinds(),
          catalog: state.catalog,
          capabilities: objectValue(state.catalog?.capabilities),
          theme: arrayValue(state.catalog?.themes)[0]?.definition || null,
          themeContext: { branding: objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding) },
          profile: capabilityEnabled('documents.designer_profile') ? 'designer' : 'website',
          mode: 'visual',
          allowedModes: ['visual', 'preview'],
          agentEnabled: capabilityEnabled('documents.agent'),
          resolveScope: sampleScope(),
          collaboration: { actor: editorActor() },
          sidePanels: [
            ...(capabilityEnabled('documents.advanced_definition_editing') ? [{ id: 'definition', label: (globalThis.PlatformLanguage?.text("documents","m_1846607b19e14c","Definition") ?? "Definition"), render: renderWorkflowDefinitionPanel }] : []),
            { id: 'program', label: 'Data & behavior', render: async host => {
              const { mountProgramPanel } = await import('/libraries/apps/documents/program-panel.js');
              if (!host.isConnected) return;
              await mountProgramPanel(host, { organizationId: orgId(), getProgram: () => currentWorkflowDefinition().program, onChange(program) {
                const definition = clone(currentWorkflowDefinition()); definition.program = program;
                state.workflowDef = definition; state.workflowEditorHandle?.setDefinition?.(definition); markWorkflowDirty();
              } });
            } },
            ...(capabilityEnabled('documents.agent') ? [{ id: 'agent', label: (globalThis.PlatformLanguage?.text("documents","m_b8071e017821d8","Agent") ?? "Agent"), render: mountWorkflowAgent }] : [])
          ],
          chrome: {
            orgId: orgId(),
            upload: { ownerType: 'document_workflow', ownerId: firstText(state.workflow?.id, 'workflow'), collection: 'documents' }
          },
          media: {
            pick(){ return pickDocumentMedia({ organizationId: orgId(), ownerType: 'document_workflow', ownerId: firstText(state.workflow?.id, 'workflow') }); },
            url(mediaRef, variant){
              const ref = typeof mediaRef === 'string' ? { media_id: mediaRef } : objectValue(mediaRef);
              if (ref.url) return ref.url;
              if (!window.PlatformAPI?.media?.fileUrl) return '';
              return window.PlatformAPI.media.fileUrl(orgId(), firstText(ref.media_id, ref.id), variant || ref.variant || 'original');
            }
          },
          onChange: (definition) => {
            state.workflowDef = definition;
            markWorkflowDirty();
          }
        });
      } catch (error) {
        console.warn('FMWorkflowEditor mount failed', error);
        canvas.innerHTML = `<div class="fmdx-state" style="margin:20px"><i class="fas fa-triangle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.text("documents","m_61445ee660b4e6","Editor failed to start") ?? "Editor failed to start")}</strong><span>${String(esc(errorMessage(error, '')))}</span></div>`;
      }
    }

    function renderWorkflowEditor(force){
      if (state.view !== 'workflow') return;
      if (!capabilityEnabled('documents.workflow_authoring')) { closeWorkflowEditor(); return; }
      if (root.querySelector('[data-studio-workflow-screen]') && !force) return;
      destroyWorkflowEditorHandle();
      const workflow = state.workflow || {};
      root.innerHTML = `
        <div class="fmdx-shell">
          <div class="fmdx-studio-editor" data-studio-workflow-screen>
            <header class="fmdx-editor-top">
              <button type="button" class="fmdx-icon-btn" data-wf-back title="${(globalThis.PlatformLanguage?.text("documents","m_02976e3fab1e2d","Back to workflows") ?? "Back to workflows")}"><i class="fas fa-arrow-left"></i></button>
              <input class="fmdx-doc-title-input" data-wf-name value="${String(esc(firstText(workflow.name, 'Untitled workflow')))}" spellcheck="false">
              ${String(statusChip(workflow.status))}
              <span class="fmdx-chip plain">v${String(Number(workflow.current_version || 0))}</span>
              <span class="fmdx-save-state" data-wf-save-state></span>
              <div style="margin-left:auto;display:flex;gap:7px;align-items:center;flex-wrap:wrap">
                ${String(capabilityEnabled('documents.advanced_definition_editing') ? '<button type="button" class="fmdx-btn" data-wf-definition><i class="fas fa-code"></i> Definition</button>' : '')}
                ${String(capabilityEnabled('documents.agent') ? '<button type="button" class="fmdx-btn" data-wf-agent><i class="fas fa-wand-magic-sparkles"></i> Agent</button>' : '')}
                <button type="button" class="fmdx-btn primary" data-wf-publish><i class="fas fa-rocket"></i>${(globalThis.PlatformLanguage?.text("documents","m_920f7e99dda4ea"," Publish") ?? " Publish")}</button>
              </div>
            </header>
            <div class="fmdx-editor-main">
              <div class="fmdx-editor-canvas" data-wf-canvas>
                <div class="fmdx-state" style="margin:20px"><div class="fmdx-spinner"></div><strong>${(globalThis.PlatformLanguage?.text("documents","m_ea1987b091d45d","Opening shared visual editor") ?? "Opening shared visual editor")}</strong></div>
              </div>
            </div>
          </div>
        </div>`;
      root.querySelector('[data-wf-back]')?.addEventListener('click', closeWorkflowEditor);
      root.querySelector('[data-wf-name]')?.addEventListener('change', async (event) => {
        const name = cleanText(event.target.value) || 'Untitled workflow';
        try {
          await api().workflows.patch(orgId(), state.workflow.id, { name });
          state.workflow = { ...state.workflow, name };
          if (state.workflowDef) state.workflowDef.name = name;
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not rename the workflow.'), false);
        }
      });
      root.querySelector('[data-wf-definition]')?.addEventListener('click', () => state.workflowEditorHandle?.openSidePanel?.('definition'));
      root.querySelector('[data-wf-agent]')?.addEventListener('click', () => state.workflowEditorHandle?.openSidePanel?.('agent'));
      root.querySelector('[data-wf-publish]')?.addEventListener('click', (event) => publishWorkflow(event.currentTarget));
      if (state.workflowDef) mountWorkflowCanvas();
      if (state.workflowDirty) setWorkflowSaveState('Unpublished changes', 'dirty');
    }

    // ----------------------------------------------------------- new theme
    // New themes duplicate an existing (seeded) theme so page masters and
    // widget skins come along — Margin/Triangles/Clean ship as presets.
    function openNewThemeModal(){
      const sources = arrayValue(state.themes).filter((t) => cleanText(t.status).toLowerCase() !== 'archived');
      let sourceId = firstText(sources[0]?.id);
      const modal = openModal(`<h2><i class="fas fa-palette"></i>${(globalThis.PlatformLanguage?.text("documents","m_015bb33b569839"," New theme") ?? " New theme")}</h2><div data-th-body></div>`, { className: 'narrow' });
      const body = modal.el.querySelector('[data-th-body]');
      function renderBody(){
        const branding = objectValue(window.__APP?.orgBranding || window.Portal?.cfg?.branding);
        body.innerHTML = `
          <p class="fmdx-section-label">${(globalThis.PlatformLanguage?.text("documents","m_1ceddb8b63f512","Start from") ?? "Start from")}</p>
          <div class="fmdx-pick-grid" style="margin-bottom:14px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">
            ${String(sources.map((theme) => themeCardHtml({
              definition: objectValue(theme.definition),
              branding,
              attr: 'data-th-source',
              value: theme.id,
              name: firstText(theme.name, 'Theme'),
              sub: `v${Number(theme.current_version || 0)}`,
              current: sourceId === cleanText(theme.id)
            })).join(''))}
            ${String(themeCardHtml({
              definition: defaultThemeDefinition(),
              branding,
              attr: 'data-th-source',
              value: '',
              name: 'Engine default',
              sub: 'Minimal starting tokens',
              current: !sourceId
            }))}
          </div>
          <label class="fmdx-field"><span>${(globalThis.PlatformLanguage?.text("documents","m_4a008c5725873c","Theme name") ?? "Theme name")}</span><input type="text" data-th-name placeholder="${(globalThis.PlatformLanguage?.text("documents","m_c46945258b07c0","e.g. Company Blue") ?? "e.g. Company Blue")}" value="${String(esc(sourceId ? `${firstText(sources.find((t) => cleanText(t.id) === sourceId)?.name, 'Theme')} (copy)` : ''))}"></label>
          <div class="fmdx-modal-foot"><button type="button" class="fmdx-btn primary" data-th-create><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("documents","m_cfb6e8e16b6d82"," Create theme") ?? " Create theme")}</button></div>`;
        body.querySelectorAll('[data-th-source]').forEach((btn) => btn.addEventListener('click', () => {
          sourceId = btn.dataset.thSource || '';
          renderBody();
        }));
        body.querySelector('[data-th-create]')?.addEventListener('click', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const source = sources.find((t) => cleanText(t.id) === sourceId) || null;
            const definition = source ? ((await themeDefinition(source)) || defaultThemeDefinition()) : defaultThemeDefinition();
            const name = firstText(body.querySelector('[data-th-name]')?.value, source ? `${firstText(source.name, 'Theme')} (copy)` : 'New Theme');
            const res = await api().themes.create(orgId(), { name, definition });
            const theme = objectValue(res.theme || res);
            const detail = await api().themes.get(orgId(), theme.id).catch(() => null);
            const createdTheme = objectValue(detail?.theme || detail || theme);
            modal.close();
            await loadLists();
            openThemeEditor({ ...theme, ...createdTheme, definition: createdTheme.definition || theme.definition || definition });
          } catch (error) {
            button.disabled = false;
            showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not create the theme.'), false);
          }
        });
      }
      renderBody();
    }

    // -------------------------------------------------------- theme editor
    async function openThemeEditor(theme){
      state.view = 'theme';
      requestEditorSidebar();
      state.theme = objectValue(theme);
      state.themeDef = null;
      state.themeDirty = false;
      renderThemeEditor();
      await loadCatalog();
      state.themeDef = (await themeDefinition(state.theme)) || defaultThemeDefinition();
      if (state.destroyed || state.view !== 'theme') return;
      renderThemeEditor(true);
    }

    function closeThemeEditor(){
      clearTimeout(state.themePreviewTimer);
      try { state.themePreviewHandle?.destroy?.(); } catch (e) {}
      state.themePreviewHandle = null;
      state.view = 'list';
      releaseEditorSidebar();
      state.tab = 'themes';
      state.theme = null;
      state.themeDef = null;
      render();
      loadLists();
    }

    function renderThemeEditor(force){
      if (state.view !== 'theme') return;
      if (root.querySelector('[data-studio-theme-screen]') && !force) return;
      const theme = state.theme || {};
      const def = state.themeDef;
      root.innerHTML = `
        <div class="fmdx-shell">
          <div class="fmdx-studio-editor" data-studio-theme-screen>
            <header class="fmdx-editor-top">
              <button type="button" class="fmdx-icon-btn" data-theme-back title="${(globalThis.PlatformLanguage?.text("documents","m_c5d5c7818c12b1","Back to themes") ?? "Back to themes")}"><i class="fas fa-arrow-left"></i></button>
              <input class="fmdx-doc-title-input" data-theme-name value="${String(esc(firstText(theme.name, 'Untitled theme')))}" spellcheck="false">
              ${String(statusChip(theme.status))}
              <span class="fmdx-chip plain">v${String(Number(theme.current_version || 0))}</span>
              <span class="fmdx-save-state" data-theme-save-state></span>
              <div style="margin-left:auto;display:flex;gap:7px;align-items:center;flex-wrap:wrap">
                <button type="button" class="fmdx-btn" data-theme-save><i class="fas fa-floppy-disk"></i>${(globalThis.PlatformLanguage?.text("documents","m_c723e1998b1b0a"," Save draft") ?? " Save draft")}</button>
                <button type="button" class="fmdx-btn primary" data-theme-publish><i class="fas fa-rocket"></i>${(globalThis.PlatformLanguage?.text("documents","m_920f7e99dda4ea"," Publish") ?? " Publish")}</button>
              </div>
            </header>
            <div class="fmdx-editor-main" style="padding:16px;gap:16px">
              <div class="fmdx-theme-layout" style="flex:1;min-width:0">
                <div class="fmdx-theme-form" data-theme-form>
                  ${String(def ? '' : '<div class="fmdx-state" style="min-height:140px"><div class="fmdx-spinner"></div></div>')}
                </div>
                <div style="display:flex;flex-direction:column;gap:8px;min-height:0">
                  <div class="fmdx-filter-chips" style="margin:0">
                    ${String(['cover', 'body', 'pricing', 'signature'].map((role) => `
                      <button type="button" class="fmdx-filter-chip ${state.themePreviewRole === role ? 'active' : ''}" data-preview-role="${esc(role)}">${esc(role.replace(/\b\w/, (c) => c.toUpperCase()))} master</button>`).join(''))}
                  </div>
                  <div class="fmdx-theme-preview" data-theme-preview style="flex:1"></div>
                </div>
              </div>
            </div>
          </div>
        </div>`;
      root.querySelector('[data-theme-back]')?.addEventListener('click', () => closeThemeEditor());
      root.querySelector('[data-theme-name]')?.addEventListener('change', async (event) => {
        const name = cleanText(event.target.value) || 'Untitled theme';
        try {
          await api().themes.patch(orgId(), state.theme.id, { name });
          state.theme = { ...state.theme, name };
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, 'Could not rename the theme.'), false);
        }
      });
      root.querySelector('[data-theme-save]')?.addEventListener('click', (event) => saveTheme(event.currentTarget, false));
      root.querySelector('[data-theme-publish]')?.addEventListener('click', (event) => saveTheme(event.currentTarget, true));
      root.querySelectorAll('[data-preview-role]').forEach((btn) => btn.addEventListener('click', () => {
        state.themePreviewRole = btn.dataset.previewRole || 'cover';
        root.querySelectorAll('[data-preview-role]').forEach((el) => el.classList.toggle('active', el === btn));
        renderThemeForm();
        scheduleThemePreview(0);
      }));
      if (def) {
        renderThemeForm();
        scheduleThemePreview(0);
      }
    }

    function themeFonts(){
      const fonts = arrayValue(state.catalog?.fonts)
        .map((font) => typeof font === 'string' ? font : firstText(font.family, font.id, font.label))
        .filter(Boolean);
      return fonts.length ? fonts : DEFAULT_FONTS;
    }

    function renderThemeForm(){
      const form = root.querySelector('[data-theme-form]');
      if (!form || !state.themeDef) return;
      const tokens = state.themeDef.tokens = objectValue(state.themeDef.tokens);
      const colors = tokens.colors = objectValue(tokens.colors);
      const fonts = tokens.fonts = objectValue(tokens.fonts);
      const spacing = tokens.spacing = objectValue(tokens.spacing);
      const typeStyles = state.themeDef.type_styles = objectValue(state.themeDef.type_styles);
      const masters = arrayValue(state.themeDef.page_masters);
      const selectedMaster = masters.find((master) => cleanText(objectValue(master.match).role) === state.themePreviewRole)
        || masters.find((master) => ['*', ''].includes(cleanText(objectValue(master.match).role)))
        || masters[0]
        || null;
      const inset = selectedMaster ? (selectedMaster.content_inset = objectValue(selectedMaster.content_inset)) : null;
      const marginValue = (side) => Number(inset?.[side] ?? spacing[`page_margin_${side}_pt`] ?? spacing.page_margin_pt ?? 40);
      const fontOptions = themeFonts();
      const styleLabel = (key) => ({ h1:'Heading 1', h2:'Heading 2', body:'Body', caption:(globalThis.PlatformLanguage?.text("documents","m_8e5d22e5fc5931","Caption") ?? "Caption"), legal:'Legal' }[key] || key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()));
      const styleValue = (style, key, fallback) => {
        const source = Object.keys(objectValue(style.font)).length ? style.font : style;
        return source[key] ?? fallback;
      };
      const fontSelect = (key, value) => `
        <label class="fmdx-field"><span>${esc(key === 'display' ? 'Display font' : 'Body font')}</span>
          <select data-theme-font="${esc(key)}">
            ${fontOptions.map((font) => `<option value="${esc(font)}" ${cleanText(value) === font ? 'selected' : ''}>${esc(font)}</option>`).join('')}
            ${fontOptions.includes(cleanText(value)) || !cleanText(value) ? '' : `<option value="${esc(value)}" selected>${esc(value)}</option>`}
          </select>
        </label>`;
      form.innerHTML = `
        <div class="fmdx-panel">
          <div class="fmdx-panel-head"><h3><i class="fas fa-droplet"></i>${(globalThis.PlatformLanguage?.text("documents","m_817d950b6e11d1"," Colors") ?? " Colors")}</h3></div>
          <div class="fmdx-panel-body">
            <div class="fmdx-form-grid" style="grid-template-columns:repeat(2,1fr)">
              <label class="fmdx-field"><span>${(globalThis.PlatformLanguage?.text("documents","m_2436076ece8629","Primary") ?? "Primary")}</span><input type="color" data-theme-color="primary" value="${String(esc(tokenColor(colors.primary, studioBrandColor('primary'))))}"></label>
              <label class="fmdx-field"><span>${(globalThis.PlatformLanguage?.text("documents","m_12ab6737efe605","Accent") ?? "Accent")}</span><input type="color" data-theme-color="accent" value="${String(esc(tokenColor(colors.accent, studioBrandColor('secondary'))))}"></label>
              <label class="fmdx-field"><span>${(globalThis.PlatformLanguage?.text("documents","m_124287f184b88b","Text") ?? "Text")}</span><input type="color" data-theme-color="text" value="${String(esc(tokenColor(colors.text, '#111827')))}"></label>
              <label class="fmdx-field"><span>${(globalThis.PlatformLanguage?.text("documents","m_847e8d8b0827a3","Muted") ?? "Muted")}</span><input type="color" data-theme-color="muted" value="${String(esc(tokenColor(colors.muted, '#667085')))}"></label>
            </div>
            <p class="fmdx-data-hint">${(globalThis.PlatformLanguage?.text("documents","m_02accb56c8c3c2","New themes start with the company primary and secondary colors. These values belong to this theme and can be changed independently.") ?? "New themes start with the company primary and secondary colors. These values belong to this theme and can be changed independently.")}</p>
          </div>
        </div>
        <div class="fmdx-panel">
          <div class="fmdx-panel-head"><h3><i class="fas fa-font"></i>${(globalThis.PlatformLanguage?.text("documents","m_2938c2d8b7c6f0"," Typography") ?? " Typography")}</h3></div>
          <div class="fmdx-panel-body">
            ${String(fontSelect('display', fonts.display))}
            ${String(fontSelect('body', fonts.body))}
          </div>
        </div>
        <div class="fmdx-panel">
          <div class="fmdx-panel-head"><h3><i class="fas fa-paragraph"></i>${(globalThis.PlatformLanguage?.text("documents","m_bcdc8639e0042a"," Paragraph styles") ?? " Paragraph styles")}</h3></div>
          <div class="fmdx-panel-body">
            ${String(Object.entries(typeStyles).length ? Object.entries(typeStyles).map(([key, rawStyle]) => {
              const style = objectValue(rawStyle);
              const family = cleanText(styleValue(style, 'family', 'var(--fm-body-font)'));
              const size = Number(styleValue(style, 'size_pt', 11));
              const weight = Number(styleValue(style, 'weight', 400));
              const color = cleanText(styleValue(style, 'color', 'var(--fm-text)'));
              const knownFamilies = ['var(--fm-display-font)', 'var(--fm-body-font)', ...fontOptions];
              return `<div class="fmdx-theme-style" data-theme-style-row="${esc(key)}">
                <strong style="font-family:${esc(family)};font-size:${esc(Math.min(20, Math.max(11, size)))}px;font-weight:${esc(weight)};color:${esc(color)}">${esc(styleLabel(key))}</strong>
                <div class="fmdx-form-grid" style="grid-template-columns:1.35fr .65fr .8fr">
                  <label class="fmdx-field"><span>Font</span><select data-theme-style-family="${esc(key)}"><option value="var(--fm-display-font)" ${family === 'var(--fm-display-font)' ? 'selected' : ''}>Display font</option><option value="var(--fm-body-font)" ${family === 'var(--fm-body-font)' ? 'selected' : ''}>Body font</option>${fontOptions.filter((font) => !['var(--fm-display-font)','var(--fm-body-font)'].includes(font)).map((font) => `<option value="${esc(font)}" ${family === font ? 'selected' : ''}>${esc(font)}</option>`).join('')}${knownFamilies.includes(family) || !family ? '' : `<option value="${esc(family)}" selected>${esc(family)}</option>`}</select></label>
                  <label class="fmdx-field"><span>Size (pt)</span><input type="number" min="5" max="96" step="0.5" data-theme-style-size="${esc(key)}" value="${esc(size)}"></label>
                  <label class="fmdx-field"><span>Weight</span><select data-theme-style-weight="${esc(key)}">${[300,400,500,600,700,800,900].map((value) => `<option value="${value}" ${weight === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
                </div>
                <label class="fmdx-field"><span>Color token or value</span><input type="text" data-theme-style-color="${esc(key)}" value="${esc(color)}"></label>
              </div>`;
            }).join('') : '<p class="fmdx-data-hint">This theme has no named paragraph styles yet.</p>')}
          </div>
        </div>
        <div class="fmdx-panel">
          <div class="fmdx-panel-head"><h3><i class="fas fa-ruler-combined"></i>${(globalThis.PlatformLanguage?.text("documents","m_e88048f2ad0658"," Page margins") ?? " Page margins")}</h3></div>
          <div class="fmdx-panel-body">
            <div class="fmdx-form-grid" style="grid-template-columns:repeat(2,1fr)">
              ${String(['top', 'right', 'bottom', 'left'].map((side) => `<label class="fmdx-field"><span>${esc(side.replace(/^./, (letter) => letter.toUpperCase()))} (pt)</span><input type="number" min="0" step="1" data-theme-margin="${esc(side)}" value="${esc(marginValue(side))}"></label>`).join(''))}
            </div>
            <p class="fmdx-data-hint">${((v8) => globalThis.PlatformLanguage?.text("documents","m_a5a6b1afc4e52a",`Editing margins for the ${v8} page master. Final previews and documents fit page content inside this safe area.`,{v8}) ?? `Editing margins for the ${v8} page master. Final previews and documents fit page content inside this safe area.`)(esc(state.themePreviewRole))}</p>
            <label class="fmdx-field"><span>${(globalThis.PlatformLanguage?.text("documents","m_07ef896042f6e9","Element gap (pt)") ?? "Element gap (pt)")}</span><input type="number" min="0" step="1" data-theme-spacing="gap_pt" value="${String(esc(Number(spacing.gap_pt ?? 12)))}"></label>
          </div>
        </div>`;
      form.querySelectorAll('[data-theme-color]').forEach((input) => input.addEventListener('input', () => {
        const key = input.dataset.themeColor;
        colors[key] = withTokenColor(colors[key], input.value);
        markThemeDirty();
        scheduleThemePreview();
      }));
      form.querySelectorAll('[data-theme-font]').forEach((select) => select.addEventListener('change', () => {
        fonts[select.dataset.themeFont] = select.value;
        markThemeDirty();
        scheduleThemePreview();
      }));
      const setTypeStyleValue = (key, prop, value) => {
        const style = typeStyles[key] = objectValue(typeStyles[key]);
        const target = Object.keys(objectValue(style.font)).length ? style.font : style;
        target[prop] = value;
        markThemeDirty();
        scheduleThemePreview();
      };
      form.querySelectorAll('[data-theme-style-family]').forEach((select) => select.addEventListener('change', () => setTypeStyleValue(select.dataset.themeStyleFamily, 'family', select.value)));
      form.querySelectorAll('[data-theme-style-size]').forEach((input) => input.addEventListener('change', () => setTypeStyleValue(input.dataset.themeStyleSize, 'size_pt', Math.max(5, Number(input.value || 11)))));
      form.querySelectorAll('[data-theme-style-weight]').forEach((select) => select.addEventListener('change', () => setTypeStyleValue(select.dataset.themeStyleWeight, 'weight', Number(select.value || 400))));
      form.querySelectorAll('[data-theme-style-color]').forEach((input) => input.addEventListener('change', () => setTypeStyleValue(input.dataset.themeStyleColor, 'color', firstText(input.value, 'var(--fm-text)'))));
      form.querySelectorAll('[data-theme-spacing]').forEach((input) => input.addEventListener('change', () => {
        spacing[input.dataset.themeSpacing] = Number(input.value || 0);
        markThemeDirty();
        scheduleThemePreview();
      }));
      form.querySelectorAll('[data-theme-margin]').forEach((input) => input.addEventListener('change', () => {
        const side = input.dataset.themeMargin;
        const value = Math.max(0, Number(input.value || 0));
        if (inset) inset[side] = value;
        else spacing[`page_margin_${side}_pt`] = value;
        markThemeDirty();
        scheduleThemePreview();
      }));
    }

    function markThemeDirty(){
      state.themeDirty = true;
      const el = root.querySelector('[data-theme-save-state]');
      if (el) { el.className = 'fmdx-save-state dirty'; el.textContent = (globalThis.PlatformLanguage?.text("documents","m_b3ebdfc21e717e","Unsaved changes") ?? "Unsaved changes"); }
    }

    function scheduleThemePreview(delay = 250){
      clearTimeout(state.themePreviewTimer);
      state.themePreviewTimer = setTimeout(() => renderThemePreview(), delay);
    }

    function renderThemePreview(){
      const holder = root.querySelector('[data-theme-preview]');
      if (!holder || !state.themeDef) return;
      if (!window.FMDocRenderer?.render) {
        holder.innerHTML = `<div class="fmdx-state" style="margin:auto;border:0;background:transparent"><i class="fas fa-eye-slash" style="color:#9aa6bd"></i><strong style="color:#e7ecf5">${(globalThis.PlatformLanguage?.text("documents","m_784a1d2a6595a5","Live preview unavailable") ?? "Live preview unavailable")}</strong><span style="color:#9aa6bd">${(globalThis.PlatformLanguage?.text("documents","m_97e3a8c68504bb","The document renderer library is not loaded.") ?? "The document renderer library is not loaded.")}</span></div>`;
        return;
      }
      try { state.themePreviewHandle?.destroy?.(); } catch (e) {}
      holder.innerHTML = '';
      try {
        const available = Math.max(240, holder.clientWidth - 44);
        const scale = Math.min(1, available / (612 * (96 / 72)));
        state.themePreviewHandle = window.FMDocRenderer.render(holder, {
          document: sampleDocument(state.themePreviewRole),
          theme: clone(state.themeDef),
          themeContext: { branding: {} },
          mode: 'static',
          widgetData: {},
          scale
        });
      } catch (error) {
        holder.innerHTML = `<div class="fmdx-state" style="margin:auto;border:0;background:transparent"><i class="fas fa-triangle-exclamation" style="color:#f5b357"></i><strong style="color:#e7ecf5">${(globalThis.PlatformLanguage?.text("documents","m_9ea764e73f367a","Preview failed") ?? "Preview failed")}</strong><span style="color:#9aa6bd">${String(esc(errorMessage(error, '')))}</span></div>`;
      }
    }

    async function saveTheme(button, publish){
      if (!state.theme?.id || !state.themeDef) return;
      const original = button?.innerHTML;
      if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>'; }
      try {
        const definition = clone(state.themeDef);
        if (publish) {
          const res = await api().themes.publish(orgId(), state.theme.id, {
            definition,
            expected_version: Number(state.theme.current_version || 0)
          });
          const updated = objectValue(res.theme || res);
          state.theme = { ...state.theme, ...updated, current_version: Number(updated.current_version || (Number(state.theme.current_version || 0) + 1)) };
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), ((v0) => globalThis.PlatformLanguage?.text("documents","m_0cbb42af0f25c4",`Theme published as v${v0}.`,{v0}) ?? `Theme published as v${v0}.`)(state.theme.current_version), true);
        } else {
          const res = await api().themes.patch(orgId(), state.theme.id, { definition });
          const updated = objectValue(res.theme || res);
          if (updated.id) state.theme = { ...state.theme, ...updated };
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_f4fe07b788b9bc","Theme draft saved.") ?? "Theme draft saved."), true);
        }
        state.themeDirty = false;
        const el = root.querySelector('[data-theme-save-state]');
        if (el) { el.className = 'fmdx-save-state saved'; el.textContent = publish ? `Published v${state.theme.current_version}` : 'Saved'; }
        const chip = root.querySelector('[data-studio-theme-screen] .fmdx-chip.plain');
        if (chip) chip.textContent = `v${Number(state.theme.current_version || 0)}`;
      } catch (error) {
        if (publish && Number(error?.status) === 409) {
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), (globalThis.PlatformLanguage?.text("documents","m_252d7b5118d9c7","Publish conflict — someone published a newer version of this theme. Reopen it to continue.") ?? "Publish conflict — someone published a newer version of this theme. Reopen it to continue."), false);
        } else {
          showToast((globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"), errorMessage(error, publish ? 'Could not publish the theme.' : 'Could not save the theme.'), false);
        }
      } finally {
        if (button) { button.disabled = false; button.innerHTML = original; }
      }
    }

    async function applyStudioRoute(route){
      if (cleanText(route?.tab) !== 'documents_studio') return;
      const section = ['templates', 'workflows', 'themes', 'brand-kit', 'folder'].includes(cleanText(route?.studioSection))
        ? cleanText(route.studioSection)
        : 'templates';
      const folderId = cleanText(route?.studioFolder);
      const documentId = cleanText(route?.studioDocument);
      const nextTab = section === 'folder' && folderId ? `folder:${folderId}` : section;

      if (documentId && folderId) {
        if (state.view === 'folder_item'
          && cleanText(state.folderItem?.id) === documentId
          && cleanText(state.folderItem?.folder_id) === folderId) return;
        await openFolderItemEditor(
          { id:documentId, folder_id:folderId, item_type:'document', name:'Opening document' },
          { id:folderId },
          { fromRoute:true }
        );
        return;
      }

      if (state.view === 'folder_item') await closeFolderItemEditor({ fromRoute:true });
      state.tab = nextTab;
      if (state.view === 'list') render();
    }

    // ---------------------------------------------------------------- boot
    const unregisterStudioRoute = window.Portal?.navigation?.registerHandler?.(`documents-studio:${context.instanceId || 'main'}`, {
      priority: 420,
      immediate: true,
      apply: applyStudioRoute
    });
    const onPlatformTopbarVisibility = () => { if (!state.destroyed && state.view === 'folder_item') syncFolderItemHeaderHost(); };
    const onCompanyThemeUpdated = () => { if (!state.destroyed) syncOnPrimaryVar(root); };
    window.addEventListener('fm:platform-topbar-visibility', onPlatformTopbarVisibility);
    window.addEventListener('fm:theme:updated', onCompanyThemeUpdated);
    window.addEventListener('resize', onPlatformTopbarVisibility);
    loadCatalog().then(() => { if (!state.destroyed && state.view === 'list') render(); });
    loadLists();

    return {
      setActive(active){
        state.active = active !== false;
        if (!state.active) { closeFloatingMenu(); releaseEditorSidebar(); window.Portal?.topbar?.releaseLeft?.(folderItemTopbarOwner); }
        else if (state.view !== 'list') { requestEditorSidebar(); syncFolderItemHeaderHost(); }
        if (active && state.view === 'list') loadLists();
      },
      update(){},
      destroy(){
        state.destroyed = true;
        unregisterStudioRoute?.();
        window.removeEventListener('fm:platform-topbar-visibility', onPlatformTopbarVisibility);
        window.removeEventListener('fm:theme:updated', onCompanyThemeUpdated);
        window.removeEventListener('resize', onPlatformTopbarVisibility);
        closeFloatingMenu();
        clearTimeout(state.themePreviewTimer);
        clearTimeout(state.folderItemSaveTimer);
        clearTimeout(state.listRetryTimer);
        try { state.themePreviewHandle?.destroy?.(); } catch (e) {}
        destroyWorkflowAgent();
        destroyTemplateEditor();
        destroyFolderItemEditor();
        releaseEditorSidebar();
        root.innerHTML = '';
      }
    };
  }

  runtime.registerApp({
    id: 'documents.studio',
    kind: 'portal_tab',
    portalTabId: 'documents_studio',
    // The manifest pre-registers every app visible:false; the real bundle must
    // re-assert visibility or the merge keeps the placeholder hidden.
    visible: true,
    title: (globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"),
    label: (globalThis.PlatformLanguage?.text("documents","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"),
    icon: 'fa-pen-ruler',
    order: 58,
    fullBleed: true,
    surfaces: ['portal_tab'],
    regions: ['main'],
    mount: (context = {}) => mountStudio(context)
  });
})();
