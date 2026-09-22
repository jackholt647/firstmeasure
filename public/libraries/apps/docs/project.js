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
  const DOCUMENT_CATEGORIES = [
    { id:'receipt', label:(globalThis.PlatformLanguage?.text("docs","m_fc54001a0cc000","Receipts") ?? "Receipts"), icon:'fa-receipt' },
    { id:'invoice', label:(globalThis.PlatformLanguage?.text("docs","m_74b68c454b06a0","Invoices") ?? "Invoices"), icon:'fa-file-invoice-dollar' },
    { id:'proposal_report', label:(globalThis.PlatformLanguage?.text("docs","m_ada47216ef90f3","Proposals & Reports") ?? "Proposals & Reports"), icon:'fa-file-signature' },
    { id:'other', label:(globalThis.PlatformLanguage?.text("docs","m_4a04382820d2e1","Other") ?? "Other"), icon:'fa-folder-open' }
  ];

  const TYPE_META = {
    proposal: { label: (globalThis.PlatformLanguage?.text("docs","m_1d8655e967c464","Proposal") ?? "Proposal"), icon: 'fa-file-signature', color: '#2563eb' },
    change_order: { label: (globalThis.PlatformLanguage?.text("docs","m_4c17910c74a05e","Change Order") ?? "Change Order"), icon: 'fa-file-contract', color: '#7c3aed' },
    roof_report: { label: (globalThis.PlatformLanguage?.text("docs","m_51ac44c5f2e0fc","Roof Report") ?? "Roof Report"), icon: 'fa-ruler-combined', color: '#059669' },
    customer_report: { label: (globalThis.PlatformLanguage?.text("docs","m_d7e9bec617183b","Customer Report") ?? "Customer Report"), icon: 'fa-file-lines', color: '#0891b2' },
    instant_report: { label: (globalThis.PlatformLanguage?.text("docs","m_f8f58e81f3e5f9","Instant Report") ?? "Instant Report"), icon: 'fa-bolt', color: '#ca8a04' },
    weather_report: { label: (globalThis.PlatformLanguage?.text("docs","m_e2f688300156b9","Weather Report") ?? "Weather Report"), icon: 'fa-cloud-sun-rain', color: '#0d9488' },
    invoice: { label: (globalThis.PlatformLanguage?.text("docs","m_1d5ea39cc421fc","Invoice") ?? "Invoice"), icon: 'fa-file-invoice-dollar', color: '#175cd3' },
    receipt: { label: (globalThis.PlatformLanguage?.text("docs","m_ab3df34a8730df","Receipt") ?? "Receipt"), icon: 'fa-receipt', color: '#b54708' },
    required: { label: (globalThis.PlatformLanguage?.text("docs","m_db97f048cd99aa","Required") ?? "Required"), icon: 'fa-clipboard-check', color: '#dc2626' },
    contract: { label: (globalThis.PlatformLanguage?.text("docs","m_06c8cfa66b1dbc","Contract") ?? "Contract"), icon: 'fa-file-pen', color: '#0f766e' },
    work_order: { label: (globalThis.PlatformLanguage?.text("docs","m_338a7c0bfabed0","Work Order") ?? "Work Order"), icon: 'fa-clipboard-list', color: '#b45309' },
    completion_certificate: { label: (globalThis.PlatformLanguage?.text("docs","m_a8e9d925687a1e","Completion Certificate") ?? "Completion Certificate"), icon: 'fa-award', color: '#16a34a' },
    report: { label: (globalThis.PlatformLanguage?.text("docs","m_c47c2ce6bb05c0","Report") ?? "Report"), icon: 'fa-file-lines', color: '#0891b2' },
    generic: { label: (globalThis.PlatformLanguage?.text("docs","m_9c9b98b1f4e8c9","Document") ?? "Document"), icon: 'fa-file-lines', color: '#64748b' },
    document: { label: (globalThis.PlatformLanguage?.text("docs","m_9c9b98b1f4e8c9","Document") ?? "Document"), icon: 'fa-file-lines', color: '#64748b' }
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
    invoices: [],
    requiredDocs: [],
    loading: false,
    visibleDocumentCategories: new Set(['receipt', 'invoice', 'proposal_report', 'other']),
    categoryMenuOpen: false,
    viewMode: 'tiles',
    galleryDensity: 'comfortable',
    tileSize: 128,
    viewerOpen: false,
    viewerIndex: 0,
    activeViewer: null,
    loadedForProjectId: '',
    loadPromise: null,
    // Embedded document engine (project.documents mounted hidden): the create
    // wizard + SmartDoc editor live there; this tab lists everything.
    engineHost: null,
    engineHandle: null,
    engineApi: null,
    enginePromise: null,
    engineProjectId: '',
    engineDenied: false,
    engineEntries: [],
    // Inline create surface (doc-first flows): the wizard rendered into the
    // right panel instead of a floating modal.
    createHost: null
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
    if (!flags?.current?.()) return false;
    const current = flags.current?.() || {};
    // Consolidated tab: on when either the legacy project-docs flag or the
    // document engine (platform.documents) is on.
    return ['project_docs', 'documents'].some((flag) => (
      current.raw?.platform?.[flag] === true
      || current.effective?.platform?.[flag] === true
      || flags.value?.('platform', flag, undefined) === true
    ));
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
      markup: doc.markup && typeof doc.markup === 'object' ? doc.markup : {},
      interactive: doc.interactive !== false
    };
  }
  function isReceiptDoc(doc = {}){
    const metadata = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
    return docType(doc) === 'receipt'
      || cleanText(doc.source || metadata.source).toLowerCase() === 'expense_receipt_upload'
      || !!firstText(doc.receipt_id, metadata.receipt_id);
  }
  function documentCategory(doc = {}){
    const type = docType(doc);
    if (isReceiptDoc(doc)) return 'receipt';
    if (type === 'invoice' || firstText(doc.invoice_id, doc.metadata?.invoice_id)) return 'invoice';
    if (type === 'proposal' || type === 'change_order' || type.includes('report')) return 'proposal_report';
    return 'other';
  }
  // ------------------------------------------------- embedded document engine
  // The document engine (SmartDocs — apps/documents/project.js) is mounted
  // hidden inside this tab's panel. It supplies the engine document list, the
  // "New document" create wizard, and the full editor screen; this tab stays
  // the single browsing surface. When the platform.documents capability is off
  // the mount is denied and the tab silently behaves as the legacy Docs tab.
  function engineStatusLabel(status){
    const key = cleanText(status).toLowerCase();
    if (!key) return '';
    return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  function engineDocEntry(record = {}, index = 0){
    const type = docType(record);
    const meta = typeMeta(type);
    const status = cleanText(record.status).toLowerCase();
    const uploaded = cleanText(record.source).toLowerCase() === 'uploaded';
    return normalizeDoc({
      id: `engine:${firstText(record.id, index + 1)}`,
      engine_document: true,
      engine_open: (uploaded || type === 'receipt') ? 'preview' : 'editor',
      document_type: type,
      title: firstText(record.title, meta.label),
      label: firstText(record.title, meta.label),
      status,
      status_label: engineStatusLabel(status),
      special: true,
      interactive: true,
      created_at: firstText(record.created_at),
      updated_at: firstText(record.updated_at, record.created_at),
      uploaded_at: firstText(record.updated_at, record.created_at),
      metadata: { source: 'document_engine', engine_status: status },
      __engineDoc: record
    }, index);
  }
  function syncEngineEntries(records){
    state.engineEntries = (Array.isArray(records) ? records : [])
      .map((record) => (record && typeof record === 'object' ? record : null))
      .filter(Boolean)
      .filter((record) => cleanText(record.status).toLowerCase() !== 'void')
      .map(engineDocEntry);
  }
  function openEngineDoc(entry = {}){
    const api = state.engineApi;
    const record = entry.__engineDoc;
    if (!api || !record) return;
    if (entry.engine_open === 'preview') api.openPreview(record);
    else api.openDocument(record);
  }
  function engineHostVisible(visible){
    const host = state.engineHost;
    if (!host) return;
    host.hidden = !visible;
    host.style.display = visible ? 'block' : 'none';
  }
  function removeCreateHost(){
    state.createHost?.remove();
    state.createHost = null;
  }
  function destroyEngine(){
    try { state.engineHandle?.destroy?.(); } catch (error) { console.warn('Docs engine destroy failed', error); }
    removeCreateHost();
    state.engineHost?.remove();
    state.engineHost = null;
    state.engineHandle = null;
    state.engineApi = null;
    state.enginePromise = null;
    state.engineProjectId = '';
    state.engineEntries = [];
  }
  function ensureEngine(options = {}){
    if (!runtime?.mount || state.engineDenied) return state.enginePromise;
    const pid = projectId();
    // Standalone mode (doc-first flows): mount the engine with no project so
    // documents can be created org-scoped and attached to a project later.
    // Only hosts that explicitly ask get it — a plain new-project Docs tab
    // keeps its legacy no-engine behavior until the project exists.
    const standalone = !pid && options.standalone === true;
    if ((!pid && !standalone) || !orgId()) return null;
    const engineKey = pid || '__standalone__';
    if (state.engineProjectId && state.engineProjectId !== engineKey) destroyEngine();
    if (state.enginePromise) return state.enginePromise;
    const wrap = resolveRoot();
    if (!wrap) return null;
    const host = document.createElement('div');
    host.dataset.docsEngineHost = '';
    host.hidden = true;
    host.style.cssText = 'position:absolute;inset:0;z-index:40;background:#fff;display:none;overflow:hidden;';
    wrap.appendChild(host);
    state.engineHost = host;
    state.engineProjectId = engineKey;
    state.enginePromise = runtime.mount(host, 'project.documents', {
      surface: 'project_modal',
      chrome: 'project_modal',
      orgId: orgId(),
      // Standalone: an empty project object satisfies requiresContext while
      // keeping projectId blank so the engine creates org-scoped documents.
      project: pid ? project() : {},
      projectId: pid,
      active: state.active,
      params: {
        embed: {
          enabled: true,
          onReady: (api) => { state.engineApi = api; render(); },
          onDocsChanged: (docs) => {
            syncEngineEntries(docs);
            if (!state.viewerOpen) render();
          },
          onDocScreen: () => engineHostVisible(true),
          onListView: () => engineHostVisible(false)
        }
      }
    }).then((handle) => {
      if (handle?.denied) {
        // Only latch the denial once capability state has actually resolved —
        // capability-gated mounts fail closed during startup, and we retry on
        // the next activation / fm:app-flags:updated otherwise.
        const capsLoaded = !!(window.Portal?.capabilities?.current?.()?.definitions_by_key);
        if (capsLoaded && (handle.reasons || []).includes('capability')) state.engineDenied = true;
        destroyEngine();
        return null;
      }
      state.engineHandle = handle;
      return handle;
    }).catch((error) => {
      console.warn('Docs tab could not mount the document engine', error);
      destroyEngine();
      return null;
    });
    return state.enginePromise;
  }

  function invoiceDocument(invoice = {}, index = 0){
    const id = firstText(invoice.id, `invoice_${index + 1}`);
    const pdfUrl = window.PaymentsAPI?.invoices?.pdfUrl?.(orgId(), id) || '';
    return normalizeDoc({
      id:`invoice:${id}`,
      invoice_id:id,
      title:firstText(invoice.invoice_number, invoice.title, `Invoice ${index + 1}`),
      label:firstText(invoice.invoice_number, invoice.title, 'Invoice'),
      document_type:'invoice',
      type_label:'Invoice',
      icon:'fa-file-invoice-dollar',
      color:'#175cd3',
      url:pdfUrl,
      content_type:'application/pdf',
      file_name:`${firstText(invoice.invoice_number, 'invoice')}.pdf`,
      created_at:firstText(invoice.created_at, invoice.issue_date),
      updated_at:firstText(invoice.updated_at, invoice.created_at, invoice.issue_date),
      special:true,
      interactive:!!pdfUrl,
      can_markup:false,
      metadata:{
        source:'payments_invoice',
        invoice_id:id,
        status:firstText(invoice.status),
        total_cents:Number(invoice.total_cents || 0),
        balance_due_cents:Number(invoice.balance_due_cents || 0)
      }
    }, index);
  }
  function mergeInvoiceDocuments(documents = [], invoices = []){
    const known = new Set((Array.isArray(documents) ? documents : []).map((doc) => firstText(doc.invoice_id, doc.metadata?.invoice_id, docType(doc) === 'invoice' ? docId(doc) : '')).filter(Boolean));
    return normalizeList([
      ...(Array.isArray(documents) ? documents : []),
      ...(Array.isArray(invoices) ? invoices : []).filter((invoice) => !known.has(firstText(invoice.id))).map(invoiceDocument)
    ]);
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
    if (state.loadedForProjectId && state.loadedForProjectId !== pid) {
      state.visibleDocumentCategories = new Set(['receipt', 'invoice', 'proposal_report', 'other']);
      state.categoryMenuOpen = false;
    }
    state.loading = true;
    render();
    ensureEngine();
    await loadRequiredDocs();
    try {
      if (!oid || !pid || !window.PlatformAPI?.projectDocuments?.list) throw new Error('Project documents API is unavailable.');
      const [result, invoiceResult] = await Promise.all([
        window.PlatformAPI.projectDocuments.list(oid, pid),
        window.PaymentsAPI?.invoices?.list
          ? window.PaymentsAPI.invoices.list(oid, pid).catch((error) => {
            console.warn('Unable to load project invoices for Docs', error);
            return { invoices:[] };
          })
          : Promise.resolve({ invoices:[] })
      ]);
      state.uploadedDocs = normalizeList(result.uploaded_documents || []);
      state.invoices = Array.isArray(invoiceResult?.invoices) ? invoiceResult.invoices : [];
      setProjectUploadedDocs(state.uploadedDocs);
      state.docs = mergeInvoiceDocuments(result.documents || [], state.invoices);
      state.loadedForProjectId = pid;
    } catch (error) {
      if (options.quiet !== true) console.warn('Unable to load project documents', error);
      state.uploadedDocs = uploadedProjectDocs();
      state.invoices = [];
      state.docs = normalizeList([...state.uploadedDocs]);
    } finally {
      state.docs = normalizeList([...state.docs, ...requiredPlaceholders()]);
      state.loading = false;
      applyDocumentRoute();
      render();
    }
  }

  function injectStyles(){
    util.injectCSS?.('project_docs_tab', `
      .fm-docs-wrap{position:relative;height:100%;min-height:0;background:#f8fafc;border-radius:0;padding:18px;box-sizing:border-box;display:flex;flex-direction:column;color:#111827;overflow:hidden}
      .fm-docs-wrap.shared-media{padding:18px;background:#f8fafc}
      .fm-docs-gallery{flex:1 1 auto;min-height:0}.fm-docs-gallery>.pf-wrap{height:100%;min-height:0}
      .fm-docs-gallery [data-photo-feed-dynamic]{min-height:0;flex:1;display:flex;flex-direction:column}
      .fm-docs-gallery .pf-wrap{max-width:none}
      .fm-doc-requirements{flex:0 0 auto;margin:0 0 12px;padding:11px 12px;border:1px solid #fecaca;border-radius:8px;background:#fff7f7;display:flex;align-items:center;gap:10px;overflow-x:auto}
      .fm-doc-requirements>i{color:#b42318}.fm-doc-requirements>strong{font-size:11px;white-space:nowrap}.fm-doc-requirement{border:1px solid #fecaca;border-radius:999px;background:#fff;color:#991b1b;padding:5px 8px;font-size:10px;font-weight:1000;white-space:nowrap}
      .fm-doc-filter-menu{position:absolute;z-index:30;right:18px;top:66px;width:min(430px,calc(100% - 36px));max-height:min(620px,calc(100% - 84px));overflow:auto;border:1px solid #e4e7ec;border-radius:16px;background:#fff;box-shadow:0 24px 70px rgba(15,23,42,.22);padding:8px}
      .fm-doc-filter-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 10px 12px}.fm-doc-filter-head strong{display:block;font-size:15px;color:#101828}.fm-doc-filter-head span{display:block;margin-top:2px;color:#667085;font-size:12px}.fm-doc-filter-head button{width:32px;height:32px;border:0;border-radius:9px;background:#f2f4f7;color:#475467;cursor:pointer}
      .fm-doc-filter-section{padding:12px 10px;border-top:1px solid #f2f4f7}.fm-doc-filter-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px}.fm-doc-filter-section-head>span{display:flex;align-items:center;gap:7px;color:#344054}.fm-doc-filter-section-head>span>i{width:20px;color:#667085;text-align:center}.fm-doc-filter-section-head strong{font-size:12px}.fm-doc-filter-section-head em{font-size:10px;color:#98a2b3;font-style:normal;font-weight:900}.fm-doc-filter-section-head button{border:0;background:transparent;color:var(--primary-readable,var(--primary,#d93025));font-size:11px;font-weight:1000;cursor:pointer;padding:4px}
      .fm-doc-filter-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.fm-doc-filter-option{min-width:0;height:38px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#475467;padding:0 9px;display:grid;grid-template-columns:18px 18px minmax(0,1fr) auto;align-items:center;gap:7px;text-align:left;font:inherit;font-size:11px;font-weight:900;cursor:pointer}.fm-doc-filter-option:hover{background:#f8fafc}.fm-doc-filter-option.active{border-color:rgba(var(--primary-rgb,217,48,37),.28);background:rgba(var(--primary-rgb,217,48,37),.06);color:#101828}.fm-doc-filter-check{width:16px;height:16px;border:1px solid #d0d5dd;border-radius:5px;background:#fff;display:flex;align-items:center;justify-content:center}.fm-doc-filter-check i{font-size:8px;opacity:0;color:#fff}.fm-doc-filter-option.active .fm-doc-filter-check{border-color:var(--primary,#d93025);background:var(--primary,#d93025)}.fm-doc-filter-option.active .fm-doc-filter-check i{opacity:1}.fm-doc-filter-count{color:#98a2b3;font-size:9px}.fm-doc-filter-option.active .fm-doc-filter-count{color:inherit}
      @media(max-width:700px){.fm-doc-filter-menu{left:12px;right:12px;top:62px;width:auto;max-height:calc(100% - 74px)}.fm-doc-filter-options{grid-template-columns:1fr}}
      .fm-docs-gallery [data-gallery-toolbar-action="new_document"]{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
      .fm-docs-gallery [data-gallery-toolbar-action="new_document"]:hover{filter:brightness(.95)}
      .pf-thumb.fm-document-tile{background:#eef2f6}
      .pf-thumb.fm-document-tile.loaded::before{display:none}
      .fm-doc-thumb{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:9px;background:linear-gradient(145deg,#f8fafc,#e9eef5);color:var(--doc-color,#64748b)}
      .fm-doc-thumb i{font-size:40px}.fm-doc-thumb small{max-width:84%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#475467;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.06em}
      .fm-doc-type-badge{position:absolute;left:7px;top:7px;z-index:3;border-radius:999px;padding:4px 7px;background:rgba(255,255,255,.92);color:var(--doc-color,#475467);border:1px solid color-mix(in srgb,var(--doc-color,#64748b) 24%,transparent);font-size:9px;font-weight:1000}
      .fm-docs-gallery .pf-wrap[data-density="list"] .pf-grid{grid-template-columns:1fr}
      .fm-docs-gallery .pf-wrap[data-density="list"] .pf-thumb{height:68px;aspect-ratio:auto}
      .fm-docs-gallery .pf-wrap[data-density="list"] .pf-thumb>img{width:68px;height:68px;object-fit:cover}
      .fm-docs-gallery .pf-wrap[data-density="list"] .fm-doc-thumb{right:auto;width:68px}
      .fm-docs-gallery .pf-wrap[data-density="list"] .fm-doc-thumb i{font-size:24px}.fm-docs-gallery .pf-wrap[data-density="list"] .fm-doc-thumb small{display:none}
      .fm-docs-gallery .pf-wrap[data-density="list"] .fm-doc-type-badge{left:76px;top:9px}
      .fm-docs-gallery .pf-wrap[data-density="list"] .pf-thumb-meta{left:68px;top:0;bottom:0;padding:30px 10px 6px;background:#fff;color:#344054;opacity:1}
      .fm-docs-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
      .fm-docs-title{min-width:0;display:flex;flex-direction:column;gap:2px}
      .fm-docs-title strong{font-size:16px;font-weight:1000}
      .fm-docs-title span{font-size:11px;font-weight:850;color:#667085}
      .fm-docs-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .fm-docs-controls button,.fm-doc-upload{height:36px;border:1px solid rgba(15,23,42,.12);border-radius:11px;background:#fff;color:#344054;padding:0 11px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font-size:12px;font-weight:1000;text-decoration:none;cursor:pointer}
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
      @media(max-width:760px){.fm-docs-toolbar{display:flex;align-items:stretch;flex-direction:column}.fm-docs-controls{justify-content:flex-start}.fm-doc-special-row{grid-auto-columns:minmax(112px,132px)}}
      @media(max-width:720px){.fm-docs-wrap,.fm-docs-wrap.shared-media{padding:20px}}
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
    const routedView = window.Portal?.navigation?.read?.().documentView;
    if (['tiles','list'].includes(routedView)) state.viewMode = routedView;
    render();
    if (state.active) loadDocs({ quiet: true });
    return api;
  }
  function setActive(active, context = {}){
    state.active = !!active;
    if (context.panelRoot || !state.mounted) mount({ ...context, active: state.active });
    // Forward tab activation to the embedded engine so it can release its
    // fullscreen/editor focus treatment when the user leaves this tab.
    try { state.engineHandle?.setActive?.(state.active); } catch (error) { /* engine optional */ }
    if (!state.active) closeViewer(false, { fromRoute:true });
    else if (state.loadedForProjectId !== projectId()) loadDocs({ quiet: true });
    else {
      ensureEngine();
      render();
    }
  }
  function setDocumentViewerFocus(active, viewer = null){
    const win = (state.context?.overlayRoot || $('#rOverlay'))?.querySelector?.('.r-win');
    win?.classList.toggle('photo-focus', !!active);
    callHost(active ? 'onFocus' : 'onBlur', viewer);
    if (!active || !viewer) return;
    const refresh = () => {
      viewer.updateBounds?.();
      viewer.updateMarkupLayerBounds?.();
    };
    requestAnimationFrame(refresh);
    [90, 180, 300, 500, 560].forEach((delay) => setTimeout(refresh, delay));
  }
  function closeViewer(renderAfter = true, options = {}){
    const viewer = state.activeViewer;
    state.activeViewer = null;
    state.viewerOpen = false;
    viewer?.close?.();
    setDocumentViewerFocus(false);
    if (!options.fromRoute && !window.Portal?.navigation?.applying) window.Portal?.navigation?.backOrClose?.(['document'], { document:null }, { source:'document-close' });
    if (renderAfter) render();
  }
  function openViewer(index, options = {}){
    const docs = viewableDocs();
    if (!docs.length) return;
    if (state.activeViewer) closeViewer(false, { fromRoute:true });
    state.viewerIndex = Math.max(0, Math.min(index, docs.length - 1));
    state.viewerOpen = true;
    if (!options.fromRoute) window.Portal?.navigation?.push?.({ document:docId(docs[state.viewerIndex]), documentView:state.viewMode }, { source:'document-open', ownedKeys:['document'] });
    const factory = window.FirstMateMarkup?.openMediaViewer || window.FirstMateMarkup?.openPhotoViewer;
    if (!factory) {
      state.viewerOpen = false;
      showToast((globalThis.PlatformLanguage?.text("docs","m_2d5ffa19f00fcf","Viewer unavailable") ?? "Viewer unavailable"), (globalThis.PlatformLanguage?.text("docs","m_028ddfd4209b60","The shared file viewer is not loaded.") ?? "The shared file viewer is not loaded."), false);
      return null;
    }
    const media = docs.map(documentPhoto);
    let viewer = null;
    viewer = factory({
      photos: media,
      index: state.viewerIndex,
      project: project(),
      boundsTarget: resolveRoot(),
      projectLinkEnabled: false,
      itemNoun: 'document',
      collectionNoun: 'documents',
      actions: [{
        id:'open_original',
        label:(globalThis.PlatformLanguage?.text("docs","m_237716bb3d8498","Open Original") ?? "Open Original"),
        icon:'up-right-from-square',
        visible:({ photo }) => !!fileUrl(photo.__document || photo),
        onClick:({ photo }) => window.open(fileUrl(photo.__document || photo), '_blank', 'noopener')
      }, {
        id:'document_details',
        label:({ photo }) => relatedActionLabel(photo.__document || photo),
        icon:'arrow-up-right-from-square',
        visible:({ photo }) => !!(photo.__document || photo).related,
        onClick:({ photo }) => openRelated(photo.__document || photo)
      }],
      canDelete: ({ photo }) => {
        const doc = photo.__document || photo;
        return !doc.special && !!doc.media_id;
      },
      onDeletePhoto: async (photo) => removeDoc(photo.__document || photo, { keepViewer:true }),
      onChange: ({ photo }) => {
        const nextIndex = docs.findIndex((doc) => docId(doc) === docId(photo.__document || photo));
        if (nextIndex < 0) return;
        state.viewerIndex = nextIndex;
        const requested = docId(docs[nextIndex]);
        if (!window.Portal?.navigation?.applying && firstText(window.Portal?.navigation?.read?.().document) !== requested) {
          window.Portal?.navigation?.replace?.({ document:requested }, { source:'document-page', ownedKeys:['document'] });
        }
      },
      onClose: () => {
        if (state.activeViewer !== viewer) return;
        state.activeViewer = null;
        state.viewerOpen = false;
        setDocumentViewerFocus(false);
        if (!window.Portal?.navigation?.applying) window.Portal?.navigation?.backOrClose?.(['document'], { document:null }, { source:'document-close' });
        render();
      }
    });
    state.activeViewer = viewer;
    setDocumentViewerFocus(true, viewer);
    return viewer;
  }
  function viewableDocs(){
    return allViewableDocs().filter((doc) => state.visibleDocumentCategories.has(documentCategory(doc)));
  }
  function allViewableDocs(){
    return state.docs.filter((doc) => doc.interactive !== false && (doc.url || doc.media_id));
  }
  // Everything the gallery shows: engine documents (opened through the engine
  // editor/preview, never the media viewer) + viewable media references.
  function galleryEntries(){
    return [...state.engineEntries, ...allViewableDocs()];
  }
  function visibleGalleryEntries(){
    return galleryEntries().filter((doc) => state.visibleDocumentCategories.has(documentCategory(doc)));
  }
  function openRelated(doc){
    const related = doc.related && typeof doc.related === 'object' ? doc.related : {};
    const tab = firstText(related.tab, doc.document_type === 'proposal' || doc.document_type === 'change_order' ? 'proposal' : '');
    if (!tab) return;
    closeViewer(false, { fromRoute:true });
    callHost('setActivePreviewTab', tab, { history:'push', source:'document-related' });
  }
  async function addFiles(files){
    const oid = orgId();
    const pid = projectId();
    if (!oid || !pid || !window.PlatformAPI?.projectDocuments?.upload) {
      showToast((globalThis.PlatformLanguage?.text("docs","m_920aa9d1b0216a","Upload unavailable") ?? "Upload unavailable"), (globalThis.PlatformLanguage?.text("docs","m_546d652f15f847","Save the project before uploading documents.") ?? "Save the project before uploading documents."), false);
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
        showToast((globalThis.PlatformLanguage?.text("docs","m_eba695c553b0b3","Upload failed") ?? "Upload failed"), error?.message || `Could not upload ${file.name || 'document'}.`, false);
      }
    }
    callHost('persistProject');
    await window.PlatformAPI?.mediaStorage?.usage?.(oid).catch(() => null);
    await loadDocs({ quiet: true });
  }
  async function removeDoc(doc, options = {}){
    if (!doc?.media_id || doc.special) return { count:0 };
    if (!window.confirm(((v0) => globalThis.PlatformLanguage?.text("docs","m_bd3178edcda733",`Remove ${v0} from the project?`,{v0}) ?? `Remove ${v0} from the project?`)(doc.title || 'this document'))) return { count:0 };
    try {
      const result = await window.PlatformAPI.projectDocuments.remove(orgId(), projectId(), docId(doc));
      state.uploadedDocs = normalizeList(result.uploaded_documents || []);
      state.docs = normalizeList(result.documents || []);
      setProjectUploadedDocs(state.uploadedDocs);
      callHost('persistProject');
      if (!options.keepViewer && state.viewerOpen) closeViewer(false);
      render();
      return { count:1 };
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("docs","m_16f422ba4271fa","Remove failed") ?? "Remove failed"), error?.message || 'Could not remove this document.', false);
      return { count:0 };
    }
  }
  function formatBytes(bytes){
    const n = Number(bytes || 0);
    if (!n) return '';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  function documentPhoto(doc = {}){
    const meta = typeMeta(doc.document_type);
    const url = fileUrl(doc);
    // Engine documents carry no media; a synthetic src keeps them in the
    // shared gallery pipeline (normalizePhotos drops src-less entries). Tiles
    // render through documentThumbnailHtml and opens are intercepted before
    // the media viewer, so the marker URL is never fetched.
    const src = url || (doc.engine_document ? `fm-doc://${docId(doc)}` : '');
    return {
      ...doc,
      id: docId(doc),
      media_id: firstText(doc.media_id, doc.mediaId),
      src,
      url,
      media_type: isPdfDoc(doc, url) ? 'pdf' : (isImageDoc(doc, url) ? 'image' : (/^video\//i.test(firstText(doc.content_type, doc.contentType, doc.mime_type, doc.mimeType)) || /\.(?:mp4|mov|m4v|webm|ogv)(?:$|[?#])/i.test(firstText(doc.file_name, doc.fileName, doc.title, url)) ? 'video' : 'document')),
      label: doc.title,
      alt: doc.title,
      uploaded_at: firstText(doc.uploaded_at, doc.created_at, doc.updated_at, doc.metadata?.uploaded_at, doc.metadata?.created_at, project()?.updated_at, project()?.created_at, new Date().toISOString()),
      tags: [doc.type_label || meta.label, doc.document_type].filter(Boolean),
      __document: doc
    };
  }
  function documentFromItem(item = {}){
    return item.photo?.__document
      || galleryEntries().find((doc) => docId(doc) === docId(item.photo))
      || state.docs.find((doc) => docId(doc) === docId(item.photo))
      || {};
  }
  function isImageDoc(doc = {}, url = fileUrl(doc)){
    const contentType = firstText(doc.content_type, doc.contentType, doc.mime_type, doc.mimeType).toLowerCase();
    const name = firstText(doc.file_name, doc.fileName, doc.title, url).toLowerCase();
    return contentType.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|avif|heic)(?:$|[?#])/i.test(name);
  }
  function documentThumbnailHtml(item = {}){
    const doc = documentFromItem(item);
    const meta = typeMeta(doc.document_type);
    const url = fileUrl(doc);
    const thumb = doc.media_id && window.PlatformAPI?.media?.thumbnailUrl
      ? window.PlatformAPI.media.thumbnailUrl(orgId(), doc.media_id, 320)
      : url;
    return `${isImageDoc(doc, url) && thumb
      ? `<img loading="lazy" draggable="false" src="${escapeHtml(thumb)}" alt="${escapeHtml(doc.title || (globalThis.PlatformLanguage?.text("docs","m_9c9b98b1f4e8c9","Document") ?? "Document"))}">`
      : `<span class="fm-doc-thumb" style="--doc-color:${escapeHtml(doc.color || meta.color)}"><i class="fas ${escapeHtml(doc.icon || meta.icon)}"></i><small>${escapeHtml(doc.type_label || meta.label)}</small></span>`}
      <span class="fm-doc-type-badge" style="--doc-color:${escapeHtml(doc.color || meta.color)}">${escapeHtml(doc.type_label || meta.label)}</span>`;
  }
  function documentTileMeta(item = {}){
    const doc = documentFromItem(item);
    const date = firstText(doc.uploaded_at, doc.created_at, doc.updated_at);
    const detail = [
      firstText(doc.status_label),
      doc.size_bytes ? formatBytes(doc.size_bytes) : '',
      date ? (window.FirstMateMarkup?.formatDateTime?.(date) || '') : ''
    ].filter(Boolean).join(' · ');
    return `${escapeHtml(doc.title || (globalThis.PlatformLanguage?.text("docs","m_9c9b98b1f4e8c9","Document") ?? "Document"))}${detail ? `<br>${escapeHtml(detail)}` : ''}`;
  }
  function setDocumentView(view, options = {}){
    const nextView = view === 'list' ? 'list' : 'tiles';
    const changed = state.viewMode !== nextView;
    state.viewMode = nextView;
    if (changed && !window.Portal?.navigation?.applying) window.Portal?.navigation?.replace?.({ documentView:state.viewMode }, { source:'document-view', ownedKeys:['documentView'] });
    if (options.render !== false) render();
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
        ${doc.required && disabled ? `<span class="fm-doc-required">${(globalThis.PlatformLanguage?.text("docs","m_a9849df346c95d","Needed") ?? "Needed")}</span>` : ''}
        ${!doc.special && doc.media_id ? `<span class="fm-doc-remove" data-doc-remove="${String(escapeHtml(docId(doc)))}" aria-label="${(globalThis.PlatformLanguage?.text("docs","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-trash"></i></span>` : ''}
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
    const required = state.docs.filter((doc) => doc.required && doc.interactive === false);
    const availableDocs = galleryEntries();
    const categoryCounts = Object.fromEntries(DOCUMENT_CATEGORIES.map((category) => [category.id, availableDocs.filter((doc) => documentCategory(doc) === category.id).length]));
    const galleryDocs = visibleGalleryEntries();
    // The embedded engine's editor + inline-create surfaces live inside this
    // wrapper — detach them before rewriting the gallery markup and re-attach
    // afterwards.
    [state.engineHost, state.createHost].forEach((el) => { if (el && root.contains(el)) el.remove(); });
    const reattachHosts = () => {
      if (state.createHost) root.appendChild(state.createHost);
      if (state.engineHost) root.appendChild(state.engineHost);
    };
    if (state.loading) {
      root.classList.remove('shared-media');
      root.innerHTML = `<div class="fm-doc-empty"><i class="fas fa-circle-notch fa-spin"></i><strong>${(globalThis.PlatformLanguage?.text("docs","m_34768a8382fa48","Loading documents") ?? "Loading documents")}</strong></div>`;
      reattachHosts();
      return;
    }
    root.classList.add('shared-media');
    const allCategoriesShown = DOCUMENT_CATEGORIES.every((category) => state.visibleDocumentCategories.has(category.id));
    root.innerHTML = `${required.length ? `<div class="fm-doc-requirements"><i class="fas fa-circle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.text("docs","m_aaf584b78a6e0d","Required documents") ?? "Required documents")}</strong>${String(required.map((doc) => `<span class="fm-doc-requirement">${escapeHtml(doc.title)}</span>`).join(''))}</div>` : ''}<div class="fm-docs-gallery" data-doc-gallery></div><input type="file" data-doc-upload-input multiple accept="${escapeHtml(ACCEPT)}" hidden>${state.categoryMenuOpen ? `<div class="fm-doc-filter-menu" data-doc-filter-menu><div class="fm-doc-filter-head"><div><strong>${(globalThis.PlatformLanguage?.text("docs","m_80fdf3a3a8501b","Items shown") ?? "Items shown")}</strong><span>${(globalThis.PlatformLanguage?.text("docs","m_db1efbf4b2ef87","Choose the document categories in this project.") ?? "Choose the document categories in this project.")}</span></div><button type="button" data-doc-category-close aria-label="${(globalThis.PlatformLanguage?.text("docs","m_05f07e7d7b5c38","Close filters") ?? "Close filters")}"><i class="fas fa-xmark"></i></button></div><section class="fm-doc-filter-section"><div class="fm-doc-filter-section-head"><span><i class="fas fa-folder-open"></i><strong>${(globalThis.PlatformLanguage?.text("docs","m_5d7c7ad6033624","Documents") ?? "Documents")}</strong><em>${((v0,v1) => globalThis.PlatformLanguage?.text("docs","m_1e1c07222eea9e",`${v0} of ${v1}`,{v0,v1}) ?? `${v0} of ${v1}`)(state.visibleDocumentCategories.size,DOCUMENT_CATEGORIES.length)}</em></span><button type="button" data-doc-category-all data-doc-category-action="${String(allCategoriesShown ? 'none' : 'all')}">${String(allCategoriesShown ? 'Hide all' : 'Show all')}</button></div><div class="fm-doc-filter-options">${String(DOCUMENT_CATEGORIES.map((category) => `<button type="button" class="fm-doc-filter-option${state.visibleDocumentCategories.has(category.id) ? ' active' : ''}" data-doc-category-toggle="${category.id}" aria-pressed="${state.visibleDocumentCategories.has(category.id) ? 'true' : 'false'}"><span class="fm-doc-filter-check"><i class="fas fa-check"></i></span><i class="fas ${category.icon}"></i><span>${escapeHtml(category.label)}</span><small class="fm-doc-filter-count">${categoryCounts[category.id] || 0}</small></button>`).join(''))}</div></section></div>` : ''}`;
    reattachHosts();
    const gallery = root.querySelector('[data-doc-gallery]');
    const input = root.querySelector('[data-doc-upload-input]');
    if (!Portal.PhotoFeed?.mountProjectGallery) {
      gallery.innerHTML = `<div class="fm-doc-empty"><i class="fas fa-folder-open"></i><strong>${(globalThis.PlatformLanguage?.text("docs","m_78c1804ef2f854","Document browser unavailable") ?? "Document browser unavailable")}</strong><span>${(globalThis.PlatformLanguage?.text("docs","m_353ae41f38fb1a","The shared media gallery is not loaded.") ?? "The shared media gallery is not loaded.")}</span></div>`;
      return;
    }
    Portal.PhotoFeed.mountProjectGallery(gallery, {
      project:{ ...project(), photos:galleryDocs.map(documentPhoto) },
      photos:galleryDocs.map(documentPhoto),
      title:'',
      icon:'fa-folder-open',
      itemNoun:'document',
      uploadLabel:'Upload',
      initialDensity:state.viewMode === 'list' ? 'list' : (state.galleryDensity === 'list' ? 'comfortable' : state.galleryDensity),
      extraDensityModes:[{ id:'list', label:(globalThis.PlatformLanguage?.text("docs","m_db473980ea71b2","List") ?? "List"), icon:'list' }],
      searchPlaceholder:'Search documents, types, or dates',
      emptyIcon:'fa-file-medical',
      emptyTitle:availableDocs.length ? 'No matching documents' : 'No documents yet',
      emptyMessage:availableDocs.length
        ? 'Choose another document category from the Shown menu.'
        : (state.engineApi ? 'Create a proposal, invoice, or contract — or upload existing files.' : 'Upload PDFs or project files here.'),
      enableProjectLinks:false,
      projectLinkEnabled:false,
      includeReceipts:state.visibleDocumentCategories.has('receipt'),
      selectionEnabled:false,
      tileClass:'fm-document-tile loaded',
      renderThumbnail:documentThumbnailHtml,
      renderTileMeta:documentTileMeta,
      renderGroupUploaders:(group) => `<i class="fas fa-folder-open"></i> ${group.items.length} document${group.items.length === 1 ? '' : 's'}`,
      itemIdentity:(item) => docId(documentFromItem(item)),
      initialItemId:state.viewerOpen ? firstText(window.Portal?.navigation?.read?.().document) : '',
      onOpenItem:({ item, fromRoute }) => {
        const doc = documentFromItem(item);
        // SmartDoc instances open through the embedded engine (editor for live
        // documents, rendered preview for uploads/receipts) — never the media
        // viewer. Media references keep the existing markup viewer.
        if (doc.engine_document) return openEngineDoc(doc);
        const index = viewableDocs().findIndex((entry) => docId(entry) === docId(doc));
        if (index >= 0) return openViewer(index, { fromRoute });
        return null;
      },
      onUpload:() => input?.click(),
      toolbarActions:[{
        id:'shown',
        label:(globalThis.PlatformLanguage?.text("docs","m_092ad4c2ce9c6b","Shown") ?? "Shown"),
        icon:'fa-sliders',
        tooltip:(globalThis.PlatformLanguage?.text("docs","m_13e4411a7a8b4f","Choose documents shown") ?? "Choose documents shown"),
        showLabel:true,
        active:state.categoryMenuOpen || state.visibleDocumentCategories.size < DOCUMENT_CATEGORIES.length,
        onClick:() => { state.categoryMenuOpen = !state.categoryMenuOpen; render(); }
      }, ...(state.engineApi ? [{
        id:'new_document',
        label:(globalThis.PlatformLanguage?.text("docs","m_96834d2fc9c9a5","New") ?? "New"),
        icon:'fa-plus',
        tooltip:(globalThis.PlatformLanguage?.text("docs","m_4e93753901b18e","New document") ?? "New document"),
        showLabel:true,
        onClick:() => state.engineApi?.openCreateModal()
      }] : [])],
      onDensityChange:(density) => {
        state.galleryDensity = density;
        setDocumentView(density === 'list' ? 'list' : 'tiles', { render:false });
      }
    });
  }
  function bind(root){
    root.querySelector('[data-doc-refresh]')?.addEventListener('click', () => loadDocs());
    root.querySelector('.fm-doc-upload input')?.addEventListener('change', (event) => {
      addFiles(event.target.files);
      event.target.value = '';
    });
    root.querySelector('[data-doc-upload-input]')?.addEventListener('change', (event) => {
      addFiles(event.target.files);
      event.target.value = '';
    });
    root.querySelectorAll('[data-doc-category-toggle]').forEach((button) => button.addEventListener('click', () => {
      const category = button.dataset.docCategoryToggle || '';
      if (!DOCUMENT_CATEGORIES.some((entry) => entry.id === category)) return;
      if (state.visibleDocumentCategories.has(category)) state.visibleDocumentCategories.delete(category);
      else state.visibleDocumentCategories.add(category);
      render();
    }));
    root.querySelector('[data-doc-category-all]')?.addEventListener('click', () => {
      state.visibleDocumentCategories = root.querySelector('[data-doc-category-all]')?.dataset.docCategoryAction === 'none'
        ? new Set()
        : new Set(DOCUMENT_CATEGORIES.map((category) => category.id));
      render();
    });
    root.querySelector('[data-doc-category-close]')?.addEventListener('click', () => {
      state.categoryMenuOpen = false;
      render();
    });
    root.querySelector('.fm-doc-size input')?.addEventListener('input', (event) => {
      state.tileSize = Number(event.target.value || 128) || 128;
      render();
    });
    root.querySelectorAll('[data-doc-view]').forEach((button) => {
      button.addEventListener('click', () => setDocumentView(button.dataset.docView));
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
  }
  function render(){
    if (!state.active && !state.viewerOpen && !state.loading) return;
    const root = resolveRoot();
    if (!root) return;
    if (state.activeViewer) return;
    renderGrid(root);
    bind(root);
  }
  function reset(){
    closeViewer(false, { fromRoute:true });
    destroyEngine();
    state.docs = [];
    state.uploadedDocs = [];
    state.invoices = [];
    state.visibleDocumentCategories = new Set(DOCUMENT_CATEGORIES.map((category) => category.id));
    state.categoryMenuOpen = false;
    state.loadedForProjectId = '';
    render();
  }
  function unmount(){
    closeViewer(false, { fromRoute:true });
    destroyEngine();
    state.mounted = false;
    state.panelRoot = null;
  }
  function context(){
    return { ...state, docs: [...state.docs] };
  }

  function applyDocumentRoute(route = window.Portal?.navigation?.read?.() || {}){
    if (!route.project || route.projectTab !== 'docs' || !state.mounted) return;
    state.viewMode = route.documentView === 'list' ? 'list' : 'tiles';
    const requested = firstText(route.document);
    if (!requested) {
      if (state.viewerOpen) closeViewer(false, { fromRoute:true });
    } else {
      const index = viewableDocs().findIndex((doc) => docId(doc) === requested);
      if (index >= 0 && (!state.viewerOpen || state.viewerIndex !== index)) openViewer(index, { fromRoute:true });
    }
    render();
  }

  // Doc-first workflows (global New button → "New Proposal"/"New Invoice"/…):
  // mount the embedded engine if needed, then open its create wizard with the
  // requested prefill ({ document_type }). options.standalone allows mounting
  // with no project (org-scoped documents attached to a project later).
  // Returns false when the engine is unavailable (capability off).
  async function openNewDocument(prefill = {}, options = {}){
    try { await ensureEngine({ standalone: options.standalone === true }); } catch (error) { /* denied or unavailable */ }
    if (!state.engineApi) return false;
    state.engineApi.openCreateModal(prefill && typeof prefill === 'object' ? prefill : {});
    return true;
  }

  /** Doc-first flows: render the create wizard INLINE into the right panel
   *  (over the gallery) instead of a floating modal. Typed prefills land on
   *  the params step; generic opens the type selector. */
  async function openNewDocumentInline(prefill = {}, options = {}){
    try { await ensureEngine({ standalone: options.standalone === true }); } catch (error) { /* denied or unavailable */ }
    if (!state.engineApi?.openCreateInline) return openNewDocument(prefill, options);
    const wrap = resolveRoot();
    if (!wrap) return false;
    removeCreateHost();
    const host = document.createElement('div');
    host.dataset.docsCreateHost = '';
    host.style.cssText = 'position:absolute;inset:0;z-index:30;background:#fff;overflow:hidden;';
    wrap.appendChild(host);
    state.createHost = host;
    state.engineApi.openCreateInline(host, prefill && typeof prefill === 'object' ? prefill : {}, {
      onClose: () => {
        if (state.createHost === host) state.createHost = null;
        host.remove();
        if (!state.viewerOpen) render();
      }
    });
    return true;
  }

  /** The engine document currently open in the embedded editor (or null). */
  function currentEngineDoc(){
    return state.engineApi?.getCurrentDoc?.() || null;
  }

  /** Documents created this session that have no project yet (standalone
   *  doc-first mode) — the set adoptProject() attaches when a project lands. */
  function standaloneEngineDocs(){
    return (state.engineApi?.getDocs?.() || []).filter((doc) => doc && doc.id && !firstText(doc.project_id));
  }

  /** Open a specific engine document in the embedded editor. options.standalone
   *  mounts the engine with no project (draft resume flows). */
  async function openEngineDocument(record, options = {}){
    if (!record || typeof record !== 'object') return false;
    try { await ensureEngine({ standalone: options.standalone === true }); } catch (error) { /* denied or unavailable */ }
    if (!state.engineApi) return false;
    state.engineApi.openDocument(record);
    return true;
  }

  /** Doc-first handoff: the tab's project just got established (picked or
   *  created). Remount the engine under the project, attach the standalone
   *  document that was being worked on (options.document overrides the live
   *  capture for flows that reopen the whole modal), and reopen it in the
   *  editor. Returns the adopted document, or null when there was none. */
  async function adoptProject(options = {}){
    const current = (options.document && typeof options.document === 'object' ? options.document : null) || currentEngineDoc();
    // Every standalone doc from this session attaches — not only the one open
    // in the editor (the user may have backed out to the list first).
    const captured = Array.isArray(options.documents) ? options.documents.filter((doc) => doc && doc.id) : [];
    const adoptList = [...(captured.length ? captured : standaloneEngineDocs())];
    if (current?.id && !adoptList.some((doc) => cleanText(doc.id) === cleanText(current.id))) adoptList.push(current);
    const pid = projectId();
    if (!pid) return null;
    if (state.engineProjectId !== pid || !state.engineApi) {
      destroyEngine();
      try { await ensureEngine(); } catch (error) { /* denied or unavailable */ }
    }
    if (!state.engineApi) return null;
    for (const doc of adoptList) {
      if (firstText(doc.project_id)) continue;
      try {
        await window.DocumentsAPI?.documents?.patch?.(orgId(), doc.id, { project_id: pid });
        doc.project_id = pid;
      } catch (error) {
        console.warn('Could not attach the document to the project', error);
      }
    }
    state.engineApi.refresh?.();
    const reopen = (current?.id ? current : adoptList[adoptList.length - 1]) || null;
    if (reopen?.id) state.engineApi.openDocument({ ...reopen, project_id: pid });
    return reopen?.id ? reopen : null;
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
    openNewDocument,
    openNewDocumentInline,
    currentEngineDoc,
    standaloneEngineDocs,
    openEngineDocument,
    adoptProject,
    panelHtml
  };

  Portal.modules = Portal.modules || {};
  Portal.modules.projectDocsTab = api;
  Portal.ProjectDocsTab = api;
  window.Portal?.navigation?.registerHandler?.('project-documents-route', { priority:600, apply:applyDocumentRoute });

  let registered = false;

  function registerDocsApp(){
    if (registered || !runtime?.registerApp || !projectDocsEnabled()) return;
    runtime.registerApp({
      id: 'project.docs',
      kind: 'project_modal_app',
      title: (globalThis.PlatformLanguage?.text("docs","m_87d1844aa0e8e0","Project Docs") ?? "Project Docs"),
      label: (globalThis.PlatformLanguage?.text("docs","m_e1f126038d5b27","Docs") ?? "Docs"),
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
    // Capability flips can re-enable the embedded engine mount; retry it for
    // an already-active tab (the first attempt may have failed closed while
    // capability state was still loading).
    state.engineDenied = false;
    if (projectDocsEnabled()) {
      registerDocsApp();
      if (state.mounted && state.active && !state.engineApi) {
        const pending = ensureEngine();
        if (pending?.then) pending.then(() => { if (!state.viewerOpen) render(); });
      }
      return;
    }
    if (!registered) return;
    runtime?.unregisterApp?.('project.docs');
    registered = false;
    state.active = false;
    closeViewer(false, { fromRoute:true });
  }

  syncRegistration();
  window.addEventListener('fm:app-flags:updated', syncRegistration);
})();
