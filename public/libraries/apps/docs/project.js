/* public/libraries/apps/docs/project.js
 * Project modal Docs tab.
 */
(function(){
  if (!window.Portal) return;

  const Portal = window.Portal;
  const runtime = window.FirstMateEmbeddableApps;
  const util = Portal.util || {};
  const $ = util.$ || ((sel, root = document) => root.querySelector(sel));
  const showToast = Portal.ui?.showToast || (() => {});
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match])));

  const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.png,.jpg,.jpeg,.webp,image/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv';
  const SETTINGS_MODULE_ID = 'document_settings';
  const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  let pdfJsLoading = null;
  const pdfDocumentCache = new Map();

  const TYPE_META = {
    proposal: { label: 'Proposal', icon: 'fa-file-signature', color: '#2563eb' },
    change_order: { label: 'Change Order', icon: 'fa-file-contract', color: '#7c3aed' },
    roof_report: { label: 'Roof Report', icon: 'fa-ruler-combined', color: '#059669' },
    customer_report: { label: 'Customer Report', icon: 'fa-file-lines', color: '#0891b2' },
    instant_report: { label: 'Instant Report', icon: 'fa-bolt', color: '#ca8a04' },
    weather_report: { label: 'Weather Report', icon: 'fa-cloud-sun-rain', color: '#0d9488' },
    required: { label: 'Required', icon: 'fa-clipboard-check', color: '#dc2626' },
    document: { label: 'Document', icon: 'fa-file-lines', color: '#64748b' }
  };

  const state = {
    mounted: false,
    active: false,
    host: null,
    model: null,
    context: null,
    panelRoot: null,
    docs: [],
    uploadedDocs: [],
    requiredDocs: [],
    loading: false,
    viewMode: 'tiles',
    tileSize: 128,
    viewerOpen: false,
    viewerIndex: 0,
    markup: null,
    loadedForProjectId: '',
    loadPromise: null
  };

  function cleanText(value){ return String(value ?? '').trim(); }
  function firstText(...values){
    for (const value of values) {
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }
  function callHost(name, ...args){
    const fn = state.host && state.host[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
  }
  function orgId(){
    return firstText(callHost('projectOrgId'), state.context?.orgId, window.projectOrgId?.(), Portal.cfg?.userOrgId, window.__APP?.userOrgId, Portal.cfg?.orgId, window.__APP?.orgId);
  }
  function project(){
    return callHost('getProject') || state.context?.project || state.model?.state?.activeBaseProject || window.activeBaseProject || {};
  }
  function projectId(){
    return firstText(project()?.id, project()?.platform_project_id, project()?.base_project_id, state.context?.projectId);
  }
  function branchId(){
    return firstText(state.context?.branchId, window.Portal?.branchModules?.currentBranchId?.(), window.__APP?.userBranchId, project()?.branch_id, 'default') || 'default';
  }
  function projectDocsEnabled(context = state.context || {}){
    if (context.projectDocsEnabled === false) return false;
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (flags?.current?.()) {
      const current = flags.current?.() || {};
      if (current.raw?.platform?.project_docs === true || current.effective?.platform?.project_docs === true) return true;
      const value = flags.value?.('platform', 'project_docs', undefined);
      return value === true;
    }
    return false;
  }
  function typeMeta(type){
    return TYPE_META[cleanText(type).toLowerCase().replace(/[\s-]+/g, '_')] || TYPE_META.document;
  }
  function docId(doc = {}, fallback = ''){
    return firstText(doc.id, doc.document_id, doc.media_id, doc.mediaId, doc.url, doc.href, fallback);
  }
  function fileUrl(doc = {}){
    const mediaId = firstText(doc.media_id, doc.mediaId);
    if (mediaId && window.PlatformAPI?.media?.fileUrl) return window.PlatformAPI.media.fileUrl(orgId(), mediaId, 'original');
    return firstText(doc.url, doc.href, doc.src);
  }
  function isPdfDoc(doc = {}, url = fileUrl(doc)){
    const contentType = firstText(doc.content_type, doc.contentType, doc.mime_type, doc.mimeType).toLowerCase();
    const name = firstText(doc.file_name, doc.fileName, doc.title, url).toLowerCase();
    return contentType.includes('pdf') || /\.pdf(?:$|[?#])/i.test(name) || /\.pdf(?:$|[?#])/i.test(url);
  }
  function docType(doc = {}){
    return cleanText(doc.document_type || doc.type || 'document').toLowerCase().replace(/[\s-]+/g, '_') || 'document';
  }
  function relatedActionLabel(doc = {}){
    const type = docType(doc);
    const supplied = firstText(doc.related?.label);
    if (supplied && !/^more details$/i.test(supplied) && !/^details$/i.test(supplied)) return supplied;
    if (type === 'proposal') return 'View Proposal';
    if (type === 'change_order') return 'View Change Order';
    if (type === 'roof_report' || type === 'measurement_report') return 'View Roof Report';
    if (type === 'customer_report') return 'View Customer Report';
    if (type === 'instant_report') return 'View Instant Report';
    if (type === 'weather_report') return 'View Weather Report';
    if (type.includes('report')) return 'View Report';
    return 'View Document';
  }
  function normalizeDoc(doc = {}, index = 0){
    const type = docType(doc);
    const meta = typeMeta(type);
    return {
      ...doc,
      id: docId(doc, `doc_${index + 1}`),
      document_type: type,
      type,
      type_label: firstText(doc.type_label, meta.label),
      icon: firstText(doc.icon, meta.icon),
      color: firstText(doc.color, meta.color),
      title: firstText(doc.title, doc.label, doc.file_name, doc.name, meta.label),
      label: firstText(doc.label, doc.title, doc.file_name, doc.name, meta.label),
      url: fileUrl(doc),
      media_id: firstText(doc.media_id, doc.mediaId),
      size_bytes: Number(doc.size_bytes || doc.sizeBytes || 0) || 0,
      special: !!doc.special,
      required: !!doc.required,
      interactive: doc.interactive !== false
    };
  }
  function normalizeList(list = []){
    const seen = new Set();
    return (Array.isArray(list) ? list : [])
      .map(normalizeDoc)
      .filter((doc) => {
        const id = docId(doc);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  }
  function uploadedProjectDocs(){
    return normalizeList(project()?.documents || []);
  }
  function requiredPlaceholders(){
    const existingTypes = new Set(state.docs.map((doc) => cleanText(doc.required_key || doc.document_type || doc.type).toLowerCase()));
    return (Array.isArray(state.requiredDocs) ? state.requiredDocs : [])
      .filter((entry) => entry?.enabled !== false)
      .filter((entry) => !existingTypes.has(cleanText(entry.key || entry.id || entry.document_type).toLowerCase()))
      .map((entry, index) => normalizeDoc({
        id: `required_${firstText(entry.key, entry.id, index + 1)}`,
        title: firstText(entry.label, entry.name, 'Required Document'),
        document_type: firstText(entry.document_type, entry.type, 'required'),
        required_key: firstText(entry.key, entry.id),
        required: true,
        interactive: false,
        special: true,
        metadata: { source: 'document_settings' }
      }));
  }
  function setProjectUploadedDocs(uploaded){
    const p = project();
    if (!p) return;
    p.documents = normalizeList(uploaded);
    callHost('setProject', p);
  }
  async function loadRequiredDocs(){
    if (!window.PlatformAPI?.branchModules?.get || !orgId()) return [];
    try {
      const result = await window.PlatformAPI.branchModules.get(orgId(), branchId(), SETTINGS_MODULE_ID);
      const data = result?.module?.data || result?.data || {};
      state.requiredDocs = Array.isArray(data.required_documents) ? data.required_documents : [];
    } catch (error) {
      if (Number(error?.status || 0) !== 404) console.warn('Unable to load document settings', error);
      state.requiredDocs = [];
    }
    return state.requiredDocs;
  }
  async function loadDocs(options = {}){
    if (!state.active && options.force !== true) return;
    if (state.loadPromise && options.force !== true) return state.loadPromise;
    state.loadPromise = loadDocsOnce(options);
    try { return await state.loadPromise; }
    finally { state.loadPromise = null; }
  }
  async function loadDocsOnce(options = {}){
    const oid = orgId();
    const pid = projectId();
    state.loading = true;
    render();
    await loadRequiredDocs();
    try {
      if (!oid || !pid || !window.PlatformAPI?.projectDocuments?.list) throw new Error('Project documents API is unavailable.');
      const result = await window.PlatformAPI.projectDocuments.list(oid, pid);
      state.uploadedDocs = normalizeList(result.uploaded_documents || []);
      setProjectUploadedDocs(state.uploadedDocs);
      state.docs = normalizeList(result.documents || []);
      state.loadedForProjectId = pid;
    } catch (error) {
      if (options.quiet !== true) console.warn('Unable to load project documents', error);
      state.uploadedDocs = uploadedProjectDocs();
      state.docs = normalizeList([...state.uploadedDocs]);
    } finally {
      state.docs = normalizeList([...state.docs, ...requiredPlaceholders()]);
      state.loading = false;
      render();
    }
  }

  function injectStyles(){
    util.injectCSS?.('project_docs_tab', `
      .fm-docs-wrap{height:100%;min-height:0;background:#f8fafc;border-radius:24px;padding:16px;box-sizing:border-box;display:flex;flex-direction:column;color:#111827;overflow:hidden}
      .fm-docs-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
      .fm-docs-title{min-width:0;display:flex;flex-direction:column;gap:2px}
      .fm-docs-title strong{font-size:16px;font-weight:1000}
      .fm-docs-title span{font-size:11px;font-weight:850;color:#667085}
      .fm-docs-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .fm-docs-controls button,.fm-doc-viewer-top button,.fm-doc-viewer-actions a,.fm-doc-upload{height:36px;border:1px solid rgba(15,23,42,.12);border-radius:11px;background:#fff;color:#344054;padding:0 11px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font-size:12px;font-weight:1000;text-decoration:none;cursor:pointer}
      .fm-docs-controls button.active{background:#111827;border-color:#111827;color:#fff}
      .fm-doc-upload{position:relative;background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
      .fm-doc-upload input{position:absolute;inset:0;opacity:0;cursor:pointer}
      .fm-doc-size{height:36px;border:1px solid rgba(15,23,42,.12);border-radius:11px;background:#fff;display:inline-flex;align-items:center;gap:8px;padding:0 10px;color:#667085}
      .fm-doc-size input{width:84px;accent-color:var(--primary,#d93025)}
      .fm-doc-special-row{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(118px,144px);gap:10px;overflow-x:auto;padding:2px 0 12px;margin-bottom:2px;flex:0 0 auto}
      .fm-doc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--doc-tile,128px),1fr));grid-auto-rows:minmax(118px,auto);gap:10px;overflow:auto;padding:2px 4px 4px 0;min-height:0}
      .fm-doc-tile{position:relative;min-width:0;border:1px solid rgba(15,23,42,.09);border-top:4px solid var(--doc-color,#64748b);border-radius:8px;background:#fff;padding:12px 10px 10px;text-align:left;display:flex;flex-direction:column;gap:7px;cursor:pointer;box-shadow:0 12px 26px rgba(15,23,42,.055);transition:.14s ease;overflow:hidden}
      .fm-doc-tile:hover{transform:translateY(-1px);box-shadow:0 16px 30px rgba(15,23,42,.09)}
      .fm-doc-tile[aria-disabled="true"]{cursor:default;opacity:.72}
      .fm-doc-icon{width:34px;height:34px;border-radius:8px;background:color-mix(in srgb,var(--doc-color,#64748b) 13%,#fff);color:var(--doc-color,#64748b);display:inline-flex;align-items:center;justify-content:center;font-size:15px;flex:0 0 auto}
      .fm-doc-title{font-size:12px;line-height:1.25;font-weight:1000;color:#111827;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
      .fm-doc-meta{font-size:10px;line-height:1.25;font-weight:850;color:#667085;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      .fm-doc-required{position:absolute;right:8px;top:8px;border-radius:999px;background:#fee2e2;color:#991b1b;padding:3px 6px;font-size:9px;font-weight:1000}
      .fm-doc-remove{position:absolute;right:8px;bottom:8px;width:26px;height:26px;border-radius:8px;background:#fff;color:#b42318;border:1px solid rgba(180,35,24,.18);display:flex;align-items:center;justify-content:center;opacity:0;transition:.14s ease}
      .fm-doc-tile:hover .fm-doc-remove{opacity:1}
      .fm-doc-list{display:flex;flex-direction:column;gap:8px;overflow:auto;min-height:0;padding-right:4px}
      .fm-doc-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;border:1px solid rgba(15,23,42,.08);border-left:4px solid var(--doc-color,#64748b);border-radius:8px;background:#fff;padding:8px}
      .fm-doc-row-main{border:0;background:transparent;display:flex;align-items:center;gap:10px;min-width:0;text-align:left;cursor:pointer}
      .fm-doc-row-main strong{display:block;font-size:13px;font-weight:1000;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .fm-doc-row-main em{display:block;font-style:normal;font-size:11px;font-weight:850;color:#667085;margin-top:2px}
      .fm-doc-row-action{height:32px;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;color:#344054;font-size:11px;font-weight:1000;padding:0 10px;cursor:pointer}
      .fm-doc-row-action.danger{color:#b42318}
      .fm-doc-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border:1px dashed rgba(15,23,42,.16);border-radius:18px;background:#fff;color:#667085;text-align:center;font-weight:850}
      .fm-doc-empty i{font-size:26px;color:#98a2b3}
      .fm-doc-empty strong{color:#111827}
      .fm-doc-viewer{height:100%;min-height:0;display:flex;flex-direction:column;gap:10px}
      .fm-doc-viewer-top{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px}
      .fm-doc-viewer-title{text-align:center;min-width:0}
      .fm-doc-viewer-title strong{display:block;font-size:13px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .fm-doc-viewer-title span{display:block;font-size:10px;font-weight:850;color:#667085;margin-top:2px}
      .fm-doc-viewer-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end}
      .fm-doc-stage{position:relative;flex:1;min-height:0;border:1px solid rgba(15,23,42,.1);border-radius:18px;background:#e5e7eb;overflow:hidden}
      .fm-doc-stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}
      .fm-doc-pdf-pages{position:absolute;inset:0;overflow:auto;padding:18px;display:flex;flex-direction:column;align-items:center;gap:14px;background:#d1d5db}
      .fm-doc-pdf-page{flex:0 0 auto;width:min(100%,920px);aspect-ratio:var(--pdf-page-aspect,8.5/11);background:#fff;border-radius:4px;box-shadow:0 14px 34px rgba(15,23,42,.16);overflow:hidden}
      .fm-doc-pdf-page canvas{display:block;width:100%;height:auto;flex:0 0 auto}
      .fm-doc-pdf-status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:#475467;font-size:12px;font-weight:900}
      .fm-doc-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:40;width:40px;height:40px;border-radius:999px;border:1px solid rgba(15,23,42,.12);background:rgba(255,255,255,.94);color:#344054;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 12px 24px rgba(15,23,42,.12)}
      .fm-doc-nav.prev{left:12px}.fm-doc-nav.next{right:12px}
      .fm-doc-markup-note{position:absolute;left:12px;bottom:12px;z-index:25;border-radius:999px;background:rgba(17,24,39,.76);color:#fff;padding:7px 10px;font-size:10px;font-weight:900}
      @media(max-width:760px){.fm-docs-toolbar,.fm-doc-viewer-top{grid-template-columns:1fr;display:flex;align-items:stretch;flex-direction:column}.fm-docs-controls,.fm-doc-viewer-actions{justify-content:flex-start}.fm-doc-special-row{grid-auto-columns:minmax(112px,132px)}}
    `);
  }

  function panelHtml(){
    return '<div class="fm-docs-wrap" data-docs-root></div>';
  }
  function resolveRoot(root = null){
    const candidate = root || state.panelRoot || document.querySelector('#rOverlay .r-preview-panel[data-panel="docs"]');
    if (!candidate) return null;
    if (!candidate.querySelector('[data-docs-root]')) candidate.innerHTML = panelHtml();
    return candidate.querySelector('[data-docs-root]');
  }
  function mount(context = {}){
    injectStyles();
    state.context = context;
    state.model = context.projectModel || context.model || state.model || window.FirstMateAppContext?.modelFromContext?.(context) || null;
    if (state.model && window.FirstMateAppContext?.installProjectContextAccessors) {
      window.FirstMateAppContext.installProjectContextAccessors(state.model, { overwrite: false });
    }
    state.host = context.host || (state.model && window.FirstMateAppContext?.createProjectHost?.(state.model)) || state.host || null;
    state.panelRoot = context.panelRoot || context.roots?.main || state.panelRoot;
    state.mounted = !!resolveRoot(state.panelRoot);
    state.active = context.active === true;
    render();
    if (state.active) loadDocs({ quiet: true });
    return api;
  }
  function setActive(active, context = {}){
    state.active = !!active;
    if (context.panelRoot || !state.mounted) mount({ ...context, active: state.active });
    if (!state.active) closeViewer(false);
    else if (state.loadedForProjectId !== projectId()) loadDocs({ quiet: true });
    else render();
  }
  function destroyMarkup(){
    state.markup?.destroy?.();
    state.markup = null;
  }
  function closeViewer(renderAfter = true){
    destroyMarkup();
    state.viewerOpen = false;
    if (renderAfter) render();
  }
  function openViewer(index){
    const docs = viewableDocs();
    if (!docs.length) return;
    state.viewerIndex = Math.max(0, Math.min(index, docs.length - 1));
    state.viewerOpen = true;
    render();
  }
  function viewableDocs(){
    return state.docs.filter((doc) => doc.interactive !== false && (doc.url || doc.media_id));
  }
  function currentDoc(){
    return viewableDocs()[state.viewerIndex] || {};
  }
  function showRelative(delta){
    const docs = viewableDocs();
    if (!docs.length) return;
    destroyMarkup();
    state.viewerIndex = (state.viewerIndex + docs.length + delta) % docs.length;
    render();
  }
  async function attachMarkup(){
    destroyMarkup();
    const root = resolveRoot();
    const stage = root?.querySelector('[data-doc-stage]');
    const doc = currentDoc();
    const mediaId = firstText(doc.media_id, doc.mediaId);
    if (!stage || !mediaId || !window.FirstMateMarkup?.PhotoMarkup) return;
    state.markup = new window.FirstMateMarkup.PhotoMarkup(stage, {
      dock: { position: 'dock-bottom-right', expand: 'expand-left' },
      size: 1.4,
      onChange: (items) => window.FirstMateMarkup?.saveMarkup?.(orgId(), mediaId, items)
    });
    const items = await window.FirstMateMarkup.loadMarkup?.(orgId(), mediaId).catch(() => []);
    if (docId(currentDoc()) === docId(doc)) state.markup?.setItems?.(Array.isArray(items) ? items : []);
  }
  async function ensurePdfJs(){
    if (window.pdfjsLib || window['pdfjs-dist/build/pdf']) return window.pdfjsLib || window['pdfjs-dist/build/pdf'];
    if (!pdfJsLoading) {
      pdfJsLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = PDFJS_URL;
        script.onload = () => {
          const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
          if (!lib) {
            reject(new Error('PDF.js loaded but did not expose a runtime.'));
            return;
          }
          lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
          resolve(lib);
        };
        script.onerror = () => reject(new Error('Unable to load PDF.js.'));
        document.head.appendChild(script);
      }).catch((error) => {
        pdfJsLoading = null;
        throw error;
      });
    }
    return pdfJsLoading;
  }
  async function pdfDocument(url){
    const cleanUrl = cleanText(url);
    if (!cleanUrl) return null;
    if (pdfDocumentCache.has(cleanUrl)) return pdfDocumentCache.get(cleanUrl);
    const lib = await ensurePdfJs();
    const loadingTask = lib.getDocument({
      url: cleanUrl,
      withCredentials: true,
      disableAutoFetch: false,
      disableStream: false
    });
    const promise = loadingTask.promise.catch((error) => {
      pdfDocumentCache.delete(cleanUrl);
      throw error;
    });
    pdfDocumentCache.set(cleanUrl, promise);
    return promise;
  }
  async function renderPdfIntoStage(stage, doc, url){
    if (!stage || !url) return;
    const key = `${docId(doc)}::${url}`;
    stage.dataset.pdfRenderKey = key;
    const mount = stage.querySelector('[data-doc-pdf-pages]');
    if (!mount) return;
    try {
      const pdf = await pdfDocument(url);
      if (!pdf || stage.dataset.pdfRenderKey !== key) return;
      mount.innerHTML = '';
      const maxWidth = Math.max(280, Math.min(stage.clientWidth - 36, 920));
      const pixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (stage.dataset.pdfRenderKey !== key) return;
        const page = await pdf.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const cssScale = maxWidth / base.width;
        const viewport = page.getViewport({ scale: cssScale * pixelRatio });
        const cssViewport = page.getViewport({ scale: cssScale });
        const shell = document.createElement('div');
        shell.className = 'fm-doc-pdf-page';
        shell.style.width = `${Math.round(cssViewport.width)}px`;
        shell.style.height = `${Math.round(cssViewport.height)}px`;
        shell.style.aspectRatio = `${base.width} / ${base.height}`;
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${Math.round(cssViewport.width)}px`;
        canvas.style.height = `${Math.round(cssViewport.height)}px`;
        shell.appendChild(canvas);
        mount.appendChild(shell);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }
    } catch (error) {
      if (stage.dataset.pdfRenderKey !== key) return;
      mount.innerHTML = `<div class="fm-doc-pdf-status"><span>Could not render this PDF in the browser. Use Open Original to view or download it.</span></div>`;
      console.warn('Docs PDF render failed', error);
    }
  }
  async function afterViewerRender(doc, url){
    const root = resolveRoot();
    const stage = root?.querySelector('[data-doc-stage]');
    if (isPdfDoc(doc, url)) await renderPdfIntoStage(stage, doc, url);
    await attachMarkup();
  }
  function openRelated(doc = currentDoc()){
    const related = doc.related && typeof doc.related === 'object' ? doc.related : {};
    const tab = firstText(related.tab, doc.document_type === 'proposal' || doc.document_type === 'change_order' ? 'proposal' : '');
    if (!tab) return;
    closeViewer(false);
    callHost('setActivePreviewTab', tab);
  }
  async function addFiles(files){
    const oid = orgId();
    const pid = projectId();
    if (!oid || !pid || !window.PlatformAPI?.projectDocuments?.upload) {
      showToast('Upload unavailable', 'Save the project before uploading documents.', false);
      return;
    }
    const list = [...(files || [])].filter(Boolean);
    if (!list.length) return;
    for (const file of list) {
      try {
        const result = await window.PlatformAPI.projectDocuments.upload(oid, pid, file, {
          title: file.name,
          document_type: 'document'
        });
        state.uploadedDocs = normalizeList(result.uploaded_documents || [...state.uploadedDocs, result.document]);
        setProjectUploadedDocs(state.uploadedDocs);
        state.docs = normalizeList(result.documents || [...state.docs, result.document]);
      } catch (error) {
        showToast('Upload failed', error?.message || `Could not upload ${file.name || 'document'}.`, false);
      }
    }
    callHost('persistProject');
    await window.PlatformAPI?.mediaStorage?.usage?.(oid).catch(() => null);
    await loadDocs({ quiet: true });
  }
  async function removeDoc(doc){
    if (!doc?.media_id || doc.special) return;
    if (!window.confirm(`Remove ${doc.title || 'this document'} from the project?`)) return;
    try {
      const result = await window.PlatformAPI.projectDocuments.remove(orgId(), projectId(), docId(doc));
      state.uploadedDocs = normalizeList(result.uploaded_documents || []);
      state.docs = normalizeList(result.documents || []);
      setProjectUploadedDocs(state.uploadedDocs);
      callHost('persistProject');
      render();
    } catch (error) {
      showToast('Remove failed', error?.message || 'Could not remove this document.', false);
    }
  }
  function formatBytes(bytes){
    const n = Number(bytes || 0);
    if (!n) return '';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  function tileHtml(doc, index){
    const meta = typeMeta(doc.document_type);
    const viewIndex = viewableDocs().findIndex((item) => docId(item) === docId(doc));
    const disabled = doc.interactive === false || (!doc.url && !doc.media_id);
    return `
      <button type="button" class="fm-doc-tile ${doc.special ? 'special' : ''} ${doc.required ? 'required' : ''}" data-doc-index="${index}" ${disabled ? 'aria-disabled="true"' : ''} style="--doc-color:${escapeHtml(doc.color || meta.color)}">
        <span class="fm-doc-icon"><i class="fas ${escapeHtml(doc.icon || meta.icon)}"></i></span>
        <span class="fm-doc-title">${escapeHtml(doc.title)}</span>
        <span class="fm-doc-meta">${escapeHtml(doc.type_label || meta.label)}${doc.size_bytes ? ` · ${escapeHtml(formatBytes(doc.size_bytes))}` : ''}</span>
        ${doc.required && disabled ? '<span class="fm-doc-required">Needed</span>' : ''}
        ${!doc.special && doc.media_id ? `<span class="fm-doc-remove" data-doc-remove="${escapeHtml(docId(doc))}" aria-label="Remove"><i class="fas fa-trash"></i></span>` : ''}
        <span hidden data-doc-view-index="${viewIndex}"></span>
      </button>`;
  }
  function listRowHtml(doc, index){
    const meta = typeMeta(doc.document_type);
    const relatedLabel = relatedActionLabel(doc);
    return `
      <div class="fm-doc-row" data-doc-index="${index}" style="--doc-color:${escapeHtml(doc.color || meta.color)}">
        <button type="button" class="fm-doc-row-main">
          <span class="fm-doc-icon"><i class="fas ${escapeHtml(doc.icon || meta.icon)}"></i></span>
          <span><strong>${escapeHtml(doc.title)}</strong><em>${escapeHtml(doc.type_label || meta.label)}${doc.size_bytes ? ` · ${escapeHtml(formatBytes(doc.size_bytes))}` : ''}</em></span>
        </button>
        ${doc.related ? `<button type="button" class="fm-doc-row-action" data-doc-related>${escapeHtml(relatedLabel)}</button>` : ''}
        ${!doc.special && doc.media_id ? `<button type="button" class="fm-doc-row-action danger" data-doc-remove="${escapeHtml(docId(doc))}"><i class="fas fa-trash"></i></button>` : ''}
      </div>`;
  }
  function renderGrid(root){
    const special = state.docs.filter((doc) => doc.special || doc.required);
    const regular = state.docs.filter((doc) => !doc.special && !doc.required);
    root.innerHTML = `
      <div class="fm-docs-toolbar">
        <div class="fm-docs-title"><strong>Docs</strong><span>${state.docs.length} document${state.docs.length === 1 ? '' : 's'}</span></div>
        <div class="fm-docs-controls">
          <button type="button" class="${state.viewMode === 'tiles' ? 'active' : ''}" data-doc-view="tiles" data-fm-tooltip="Tiles"><i class="fas fa-grip"></i></button>
          <button type="button" class="${state.viewMode === 'list' ? 'active' : ''}" data-doc-view="list" data-fm-tooltip="List"><i class="fas fa-list"></i></button>
          <label class="fm-doc-size"><i class="fas fa-magnifying-glass"></i><input type="range" min="104" max="220" step="8" value="${state.tileSize}"></label>
          <label class="fm-doc-upload"><i class="fas fa-upload"></i><span>Upload</span><input type="file" multiple accept="${escapeHtml(ACCEPT)}"></label>
          <button type="button" data-doc-refresh data-fm-tooltip="Refresh"><i class="fas fa-rotate"></i></button>
        </div>
      </div>
      ${state.loading ? '<div class="fm-doc-empty"><i class="fas fa-circle-notch fa-spin"></i><strong>Loading documents</strong></div>' : ''}
      ${!state.loading && !state.docs.length ? '<div class="fm-doc-empty"><i class="fas fa-file-circle-plus"></i><strong>No documents yet</strong><span>Upload PDFs or project files here.</span></div>' : ''}
      ${special.length > 0 && state.viewMode === 'tiles' ? `<div class="fm-doc-special-row">${special.map((doc) => tileHtml(doc, state.docs.indexOf(doc))).join('')}</div>` : ''}
      ${state.docs.length ? (state.viewMode === 'list'
        ? `<div class="fm-doc-list">${state.docs.map(listRowHtml).join('')}</div>`
        : `<div class="fm-doc-grid" style="--doc-tile:${state.tileSize}px">${regular.map((doc) => tileHtml(doc, state.docs.indexOf(doc))).join('')}</div>`) : ''}
    `;
  }
  function renderViewer(root){
    const docs = viewableDocs();
    const doc = currentDoc();
    const url = fileUrl(doc);
    const canMarkup = !!doc.media_id;
    const relatedLabel = relatedActionLabel(doc);
    const pdf = isPdfDoc(doc, url);
    root.innerHTML = `
      <div class="fm-doc-viewer">
        <div class="fm-doc-viewer-top">
          <button type="button" data-doc-back><i class="fas fa-arrow-left"></i> Back</button>
          <div class="fm-doc-viewer-title"><strong>${escapeHtml(doc.title || 'Document')}</strong><span>${state.viewerIndex + 1} / ${docs.length}${canMarkup ? '' : ' · View only'}</span></div>
          <div class="fm-doc-viewer-actions">
            ${doc.related ? `<button type="button" data-doc-details>${escapeHtml(relatedLabel)}</button>` : ''}
            ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><i class="fas fa-up-right-from-square"></i> Open Original</a>` : ''}
          </div>
        </div>
        <div class="fm-doc-stage" data-doc-stage>
          ${pdf
            ? '<div class="fm-doc-pdf-pages" data-doc-pdf-pages><div class="fm-doc-pdf-status"><span>Rendering PDF...</span></div></div>'
            : `<iframe src="${escapeHtml(url)}#view=FitH" title="${escapeHtml(doc.title || 'Document')}"></iframe>`}
          <button type="button" class="fm-doc-nav prev" data-doc-prev aria-label="Previous document"><i class="fas fa-chevron-left"></i></button>
          <button type="button" class="fm-doc-nav next" data-doc-next aria-label="Next document"><i class="fas fa-chevron-right"></i></button>
          ${canMarkup ? '' : '<div class="fm-doc-markup-note">Markup is available for uploaded documents stored in FirstMate.</div>'}
        </div>
      </div>`;
    requestAnimationFrame(() => afterViewerRender(doc, url));
  }
  function bind(root){
    root.querySelector('[data-doc-refresh]')?.addEventListener('click', () => loadDocs());
    root.querySelector('.fm-doc-upload input')?.addEventListener('change', (event) => {
      addFiles(event.target.files);
      event.target.value = '';
    });
    root.querySelector('.fm-doc-size input')?.addEventListener('input', (event) => {
      state.tileSize = Number(event.target.value || 128) || 128;
      render();
    });
    root.querySelectorAll('[data-doc-view]').forEach((button) => {
      button.addEventListener('click', () => {
        state.viewMode = button.dataset.docView || 'tiles';
        render();
      });
    });
    root.querySelectorAll('[data-doc-index]').forEach((el) => {
      el.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-doc-remove]');
        if (remove) return removeDoc(state.docs.find((doc) => docId(doc) === remove.dataset.docRemove));
        const doc = state.docs[Number(el.dataset.docIndex || 0)];
        if (event.target.closest('[data-doc-related]')) return openRelated(doc);
        const index = viewableDocs().findIndex((item) => docId(item) === docId(doc));
        if (index >= 0) openViewer(index);
      });
    });
    root.querySelector('[data-doc-back]')?.addEventListener('click', () => closeViewer());
    root.querySelector('[data-doc-prev]')?.addEventListener('click', () => showRelative(-1));
    root.querySelector('[data-doc-next]')?.addEventListener('click', () => showRelative(1));
    root.querySelector('[data-doc-details]')?.addEventListener('click', () => openRelated());
  }
  function render(){
    if (!state.active && !state.viewerOpen && !state.loading) return;
    const root = resolveRoot();
    if (!root) return;
    destroyMarkup();
    if (state.viewerOpen) renderViewer(root);
    else renderGrid(root);
    bind(root);
  }
  function reset(){
    closeViewer(false);
    state.docs = [];
    state.uploadedDocs = [];
    state.loadedForProjectId = '';
    render();
  }
  function unmount(){
    destroyMarkup();
    state.mounted = false;
    state.panelRoot = null;
  }
  function context(){
    return { ...state, docs: [...state.docs] };
  }

  const api = {
    mount,
    setActive,
    activate: (context = {}) => setActive(true, context),
    deactivate: (context = {}) => setActive(false, context),
    render,
    reset,
    unmount,
    context,
    loadDocs,
    panelHtml
  };

  Portal.modules = Portal.modules || {};
  Portal.modules.projectDocsTab = api;
  Portal.ProjectDocsTab = api;

  let registered = false;

  function registerDocsApp(){
    if (registered || !runtime?.registerApp || !projectDocsEnabled()) return;
    runtime.registerApp({
      id: 'project.docs',
      kind: 'project_modal_app',
      title: 'Project Docs',
      label: 'Docs',
      icon: 'fa-folder-open',
      order: 25,
      visible: true,
      surfaces: ['project_modal'],
      regions: ['main'],
      requiresContext: ['project'],
      enabled: projectDocsEnabled,
      panelHtml,
      mount: (context = {}) => mount(context)
    });
    registered = true;
  }

  function syncRegistration(){
    if (projectDocsEnabled()) {
      registerDocsApp();
      return;
    }
    if (!registered) return;
    runtime?.unregisterApp?.('project.docs');
    registered = false;
    state.active = false;
    closeViewer(false);
  }

  syncRegistration();
  window.addEventListener('fm:app-flags:updated', syncRegistration);
})();
