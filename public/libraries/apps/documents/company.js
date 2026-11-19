/* public/libraries/apps/documents/company.js
 * The company Documents app (portal.documents, GP-69): every document of the company, on any project or none, in the
 * gallery the project window's Docs tab uses (GP-112: its cards, densities, Tags and Shown menu, from
 * Portal.ProjectDocsTab.mountDocumentGallery), each document opening in the document viewer (libraries/doc-viewer: the
 * project Documents viewer in a modal, with what can be done with the document in the column on the right). Uploaded
 * expense receipts are there too, as the Receipts category of the Shown menu, opened in the shared file viewer. It is
 * in More apps and not pinned to the left column by default. A document written from an invoice opens in the
 * Invoices app, which shows it in the same viewer with the invoice's actions.
 * The open document is the route's `doc` (global search opens documents here with it).
 */
(function(){
  'use strict';

  const runtime = window.FirstMateEmbeddableApps;
  if (!runtime?.registerApp) return;

  const clean = (...values) => {
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  };
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const array = (value) => Array.isArray(value) ? value : [];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  const money = (cents) => new Intl.NumberFormat((globalThis.PlatformLanguage?.formatLocale?.('en-US') || 'en-US'), { style:'currency', currency:'USD' }).format((Number(cents) || 0) / 100);
  function shortDate(value){
    const date = new Date(clean(value));
    if (Number.isNaN(date.getTime())) return '';
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString([], sameYear ? { month:'short', day:'numeric' } : { month:'short', day:'numeric', year:'numeric' });
  }

  const css = `
    .fmdc{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;color:#101828}
    .fmdc *{box-sizing:border-box}
    .fmdc-gallery{position:relative;flex:1;min-height:0}
    .fmdc-state{margin:18px;border:1px dashed #d0d5dd;border-radius:13px;background:#fff;padding:44px 20px;text-align:center;color:#667085;font-size:13px;font-weight:700}
    .fmdc-state i{display:block;font-size:28px;margin-bottom:10px;color:#98a2b3}
    .fmdc-btn{display:inline-flex;align-items:center;gap:7px;margin-top:12px;min-height:36px;padding:7px 13px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font:inherit;font-size:12px;font-weight:900;cursor:pointer}
  `;

  const COPY = {
    loadFailed:{ message:(globalThis.PlatformLanguage?.text("documents","m_7c79938321b681","Documents could not load.") ?? "Documents could not load.") }, unavailable:{ message:(globalThis.PlatformLanguage?.text("documents","m_0fa485082c90f8","Documents are not available here.") ?? "Documents are not available here.") },
    title:{ label:(globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents") }, searchPlaceholder:{ placeholder:(globalThis.PlatformLanguage?.text("documents","m_e34dbef94952ed","Search documents") ?? "Search documents") },
    noneYet:{ message:(globalThis.PlatformLanguage?.text("documents","m_6009e8cc8c2f4e","Proposals, contracts, invoices and every other document your company makes will be listed here.") ?? "Proposals, contracts, invoices and every other document your company makes will be listed here.") }
  };
  const SHOWN_DESCRIPTION = 'Choose the document categories shown, on every project.';

  function mount(context = {}){
    const root = context.roots?.main || context.root;
    if (!root) return { destroy(){} };
    (window.Portal?.util?.injectCSS || ((id, text) => {
      let style = document.getElementById(`css_${id}`);
      if (!style) { style = document.createElement('style'); style.id = `css_${id}`; document.head.appendChild(style); }
      style.textContent = text;
    }))('documents_company', css);

    const navigation = window.Portal?.navigation;
    const route = navigation?.read?.() || {};
    const state = {
      orgId:clean(context.orgId, context.currentUser?.organization_id, window.Portal?.cfg?.userOrgId, window.__APP?.userOrgId, window.__APP?.orgId),
      docs:[], receipts:[], projects:new Map(), loading:true, error:'', loadedAt:0, loadToken:0, destroyed:false, active:context.active !== false,
      openDocId:clean(route.tab) === 'documents' ? clean(route.doc) : '',
      viewer:null, viewerDocId:'', gallery:null
    };

    const describe = (doc) => window.FMDocViewer?.describe?.(doc) || { type:clean(doc.document_type) || 'document', typeLabel:clean(doc.document_type) || 'Document', icon:'fa-file-lines', color:'#64748b', statusKey:clean(doc.status), statusLabel:clean(doc.status), tone:'muted', totalCents:0, invoiceId:'' };
    // What the person chose to show (the Shown menu) is kept for them in this company, on this device.
    const shownKey = () => `firstmate.documents.company.shown.${state.orgId}.${clean(window.Portal?.cfg?.userId, window.__APP?.userId)}`;
    function savedShown(){
      try { const saved = JSON.parse(localStorage.getItem(shownKey()) || 'null'); return Array.isArray(saved) ? saved : undefined; } catch { return undefined; }
    }

    function routePatch(patch, history = 'replace'){
      navigation?.[history === 'push' ? 'push' : 'replace']?.(patch, { source:'documents-company', ownedKeys:['doc'] });
    }

    // Receipts name their project by id only: the documents' own projects name most of them, the project list the rest.
    async function loadReceiptProjects(receipts){
      state.docs.forEach((doc) => { const project = object(doc.project); if (clean(project.id)) state.projects.set(clean(project.id), project); });
      if (!receipts.some((receipt) => clean(receipt.project_id) && !state.projects.has(clean(receipt.project_id)))) return;
      const result = await window.PlatformAPI?.projects?.list?.(state.orgId).catch(() => null);
      array(result?.documents).map(object).forEach((record) => {
        const data = object(record.data && typeof record.data === 'object' ? record.data : record);
        const id = clean(record.id, data.id);
        if (id) state.projects.set(id, { id, title:clean(data.title, data.name, data.address), address:clean(data.address, data.formatted_address) });
      });
    }

    async function load(options = {}){
      const token = ++state.loadToken;
      if (!options.silent) { state.loading = true; render(); }
      try {
        const api = window.DocumentsAPI?.documents;
        if (!api?.listOrganization) throw new Error(clean(COPY.unavailable.message));
        const [result, receiptResult] = await Promise.all([
          api.listOrganization(state.orgId),
          // Every receipt of the company for people who see every project, else the person's own; none without access.
          window.PaymentsAPI?.receipts?.listFor
            ? window.PaymentsAPI.receipts.listFor(state.orgId, { kind:'organization', id:state.orgId }).catch(() => ({ receipts:[] }))
            : Promise.resolve({ receipts:[] })
        ]);
        if (token !== state.loadToken || state.destroyed) return;
        state.docs = array(result?.documents).map(object).filter((doc) => clean(doc.status).toLowerCase() !== 'void');
        const receipts = array(receiptResult?.receipts).map(object).filter((receipt) => clean(receipt.id) && clean(receipt.status).toLowerCase() !== 'void');
        await loadReceiptProjects(receipts);
        if (token !== state.loadToken || state.destroyed) return;
        state.receipts = receipts;
        state.error = '';
      } catch (error) {
        if (token !== state.loadToken || state.destroyed) return;
        state.error = clean(error?.message, COPY.loadFailed.message);
      }
      state.loading = false;
      state.loadedAt = Date.now();
      render();
      if (state.openDocId && !state.viewer) openDoc(state.openDocId, { fromRoute:true });
    }

    // An uploaded receipt as a document of the gallery: its file, through the receipt (who may see it is the receipt's rule).
    function receiptEntry(receipt){
      const file = object(receipt.file);
      const project = state.projects.get(clean(receipt.project_id));
      const id = clean(receipt.id);
      return {
        id:`receipt:${id}`,
        receipt_id:id,
        document_type:'receipt',
        source:'expense_receipt_upload',
        title:clean(receipt.title, receipt.effective?.title, receipt.extraction?.title, file.file_name, 'Receipt'),
        url:window.PaymentsAPI?.receipts?.fileUrl?.(state.orgId, id, { inline:true }) || clean(receipt.file_url),
        content_type:clean(file.content_type),
        file_name:clean(file.file_name),
        size_bytes:Number(file.size_bytes || 0) || 0,
        uploaded_at:clean(receipt.uploaded_at, receipt.created_at),
        created_at:clean(receipt.created_at, receipt.uploaded_at),
        updated_at:clean(receipt.updated_at, receipt.created_at),
        special:true,
        ...(project ? { project } : {}),
        metadata:{ receipt_id:id, source:'expense_receipt_upload' }
      };
    }

    function render(){
      if (state.destroyed) return;
      let message = '';
      if (state.loading && !state.docs.length && !state.receipts.length) message = `<div class="fmdc-state"><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_475a1617189b85","Loading documents…") ?? "Loading documents…")}</div>`;
      else if (state.error && !state.docs.length) message = `<div class="fmdc-state"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>${esc(state.error)}<div><button type="button" class="fmdc-btn" data-fmdc-retry><i class="fas fa-rotate" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_ef39ad5e614a24","Try again") ?? "Try again")}</button></div></div>`;
      else if (!window.Portal?.ProjectDocsTab?.mountDocumentGallery) message = `<div class="fmdc-state"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>${esc(COPY.unavailable.message)}</div>`;
      if (message) {
        state.gallery?.destroy?.();
        state.gallery = null;
        root.innerHTML = `<div class="fmdc" data-fm-documents-company>${message}</div>`;
        root.querySelector('[data-fmdc-retry]')?.addEventListener('click', () => load());
        return;
      }
      const options = {
        orgId:state.orgId,
        documents:state.docs,
        files:state.receipts.map(receiptEntry),
        receiptsById:new Map(state.receipts.map((receipt) => [clean(receipt.id), receipt])),
        boundsTarget:root
      };
      let holder = root.querySelector('[data-fmdc-gallery]');
      if (state.gallery && holder) { state.gallery.update(options); return; }
      root.innerHTML = '<div class="fmdc" data-fm-documents-company><div class="fmdc-gallery" data-fmdc-gallery></div></div>';
      holder = root.querySelector('[data-fmdc-gallery]');
      state.gallery = window.Portal.ProjectDocsTab.mountDocumentGallery(holder, {
        ...options,
        title:COPY.title.label,
        icon:'fa-file-signature',
        menuDescription:esc(SHOWN_DESCRIPTION),
        searchPlaceholder:'Search documents, projects, or dates',
        emptyMessage:COPY.noneYet.message,
        visibleCategories:savedShown(),
        onCategoriesChange:(ids) => { try { localStorage.setItem(shownKey(), JSON.stringify(ids)); } catch {} },
        onOpenDocument:(record) => { openDoc(clean(record?.id)); return null; }
      });
    }

    function closeViewer(){
      const viewer = state.viewer;
      state.viewer = null;
      state.viewerDocId = '';
      viewer?.close?.();
    }

    function openDoc(docId, { fromRoute = false } = {}){
      const id = clean(docId);
      if (!id) return;
      if (state.viewer && state.viewerDocId === id) return;
      const doc = state.docs.find((entry) => clean(entry.id) === id) || null;
      if (!doc && state.loading) { state.openDocId = id; return; }
      const invoiceId = doc ? describe(doc).invoiceId : '';
      // An invoice is shown by the Invoices app (the same viewer, with the invoice's actions), when the person has it.
      if (invoiceId && window.Portal?.currentUser?.hasApp?.('portal.invoices') !== false && navigation?.navigate) {
        navigation.navigate({ tab:'invoices', invoice:invoiceId }, { source:'documents-company-invoice', ownedKeys:['tab', 'invoice', 'doc'] });
        return;
      }
      if (!window.FMDocViewer?.open) return;
      closeViewer();
      state.openDocId = id;
      if (!fromRoute) routePatch({ doc:id }, 'push');
      const project = object(doc?.project);
      state.viewerDocId = id;
      state.viewer = window.FMDocViewer.open({
        orgId:state.orgId,
        document:doc || { id },
        subtitle:[clean(project.title), clean(project.address)].filter(Boolean).join(' · '),
        // Without the record in the list (opened from a link), read it first.
        load:doc ? undefined : async () => {
          const result = await window.DocumentsAPI.documents.get(state.orgId, id);
          return { document:object(result?.document || result?.doc) };
        },
        facts:doc ? facts(doc) : [],
        onChange:() => load({ silent:true }),
        onClose:(reason) => {
          if (state.viewerDocId === id) { state.viewer = null; state.viewerDocId = ''; }
          state.openDocId = '';
          // Only the person closing it walks the route back; a host close or "Open project" leaves history alone.
          if (reason === 'person' && clean(navigation?.read?.()?.doc) === id) navigation?.backOrClose?.(['doc'], { doc:null }, { source:'documents-company-close' });
        }
      });
    }

    function facts(doc){
      const described = describe(doc);
      const project = object(doc.project);
      return [
        { label:(globalThis.PlatformLanguage?.text("documents","m_2e88df13ca7101","Type") ?? "Type"), value:described.typeLabel },
        { label:(globalThis.PlatformLanguage?.text("documents","m_aaebd7ccba0b30","Project") ?? "Project"), value:clean(project.title, project.address) },
        { label:(globalThis.PlatformLanguage?.text("documents","m_2b8c3448fa87a1","Amount") ?? "Amount"), value:described.totalCents ? money(described.totalCents) : '' },
        { label:(globalThis.PlatformLanguage?.text("documents","m_dc002b01a36e6f","Created") ?? "Created"), value:shortDate(doc.created_at) },
        { label:(globalThis.PlatformLanguage?.text("documents","m_6a171239c315c1","Updated") ?? "Updated"), value:shortDate(doc.updated_at) }
      ];
    }

    const unregisterRoute = navigation?.registerHandler?.(`documents-company-route:${context.instanceId || 'main'}`, {
      priority:415,
      immediate:true,
      apply(nextRoute){
        if (nextRoute.tab !== 'documents') return;
        const nextDoc = clean(nextRoute.doc);
        if (!nextDoc && state.viewer) { state.openDocId = ''; closeViewer(); }
        if (nextDoc && nextDoc !== state.viewerDocId) { state.openDocId = nextDoc; if (!state.loading) openDoc(nextDoc, { fromRoute:true }); }
      }
    });

    const refreshEvents = ['fm:documents:changed', 'fm:money:updated', 'fm:projects:refresh'];
    const scheduleRefresh = () => { if (state.active && !state.loading) load({ silent:true }); };
    refreshEvents.forEach((name) => window.addEventListener(name, scheduleRefresh));
    load();

    return {
      setActive(active){
        state.active = !!active;
        if (!active) closeViewer();
        if (active && Date.now() - state.loadedAt > 60000 && !state.loading) load({ silent:!!state.docs.length });
      },
      update(next = {}){
        const nextOrg = clean(next.orgId);
        if (!nextOrg || nextOrg === state.orgId) return;
        state.orgId = nextOrg;
        state.docs = [];
        state.receipts = [];
        state.projects = new Map();
        state.gallery?.destroy?.();
        state.gallery = null;
        load();
      },
      refresh(){ return load(); },
      destroy(){
        state.destroyed = true;
        state.loadToken += 1;
        closeViewer();
        state.gallery?.destroy?.();
        state.gallery = null;
        unregisterRoute?.();
        refreshEvents.forEach((name) => window.removeEventListener(name, scheduleRefresh));
        root.innerHTML = '';
      }
    };
  }

  runtime.registerApp({
    id:'portal.documents', package:'documents', kind:'portal_tab',
    title:(globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), label:(globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents"), icon:'fa-file-signature', order:41,
    surfaces:['portal_tab'], regions:['main'], visible:true, fullBleed:true,
    mount
  });
})();
