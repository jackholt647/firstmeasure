/* public/libraries/apps/documents/company.js
 * The company Documents app (portal.documents, GP-69): every document of the company, on any project or none, in one
 * list, each opening in the document viewer (libraries/doc-viewer: the project Documents viewer in a modal, with what
 * can be done with the document in the column on the right). It is in More apps and not pinned to the left column by
 * default. A document written from an invoice opens in the Invoices app, which shows it in the same viewer with the
 * invoice's actions. The project window's Documents tab is separate and unchanged.
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
    .fmdc-top{flex:0 0 auto;display:flex;align-items:center;gap:14px;padding:18px 22px 0;flex-wrap:wrap}
    .fmdc-heading{display:flex;align-items:center;gap:11px;min-width:0}
    .fmdc-heading>i{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;background:var(--primary,#d93025);color:#fff}
    .fmdc-heading h1{margin:0;font-size:26px;line-height:36px;font-weight:1000;letter-spacing:-.3px}
    .fmdc-heading span{color:#667085;font-size:12px;font-weight:800}
    .fmdc-search{margin-left:auto;display:flex;align-items:center;gap:8px;min-width:min(320px,100%);height:38px;padding:0 12px;border:1px solid #d0d5dd;border-radius:10px;background:#fff}
    .fmdc-search i{color:#98a2b3;font-size:12px}
    .fmdc-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:13px}
    .fmdc-filters{flex:0 0 auto;display:flex;gap:6px;flex-wrap:wrap;padding:14px 22px 0}
    .fmdc-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;padding:6px 12px;font:inherit;font-size:11px;font-weight:900;cursor:pointer}
    .fmdc-chip:hover{border-color:rgba(var(--primary-rgb,217,48,37),.35);color:var(--primary-readable,var(--primary,#d93025))}
    .fmdc-chip.active{border-color:rgba(var(--primary-rgb,217,48,37),.35);background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}
    .fmdc-chip em{font-style:normal;color:#98a2b3}
    .fmdc-body{flex:1;min-height:0;overflow:auto;padding:14px 22px 24px}
    .fmdc-table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid #e4e7ec;border-radius:13px;overflow:hidden}
    .fmdc-table th{position:sticky;top:0;z-index:1;background:#f9fafb;color:#475467;text-align:left;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;padding:11px 12px;border-bottom:1px solid #e4e7ec}
    .fmdc-table td{padding:11px 12px;border-bottom:1px solid #f2f4f7;font-size:12.5px;vertical-align:middle}
    .fmdc-table tr:last-child td{border-bottom:0}
    .fmdc-table tr[data-doc]{cursor:pointer}
    .fmdc-table tr[data-doc]:hover td,.fmdc-table tr[data-doc]:focus-visible td{background:#f9fafb;outline:none}
    .fmdc-table .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
    .fmdc-doc{display:flex;align-items:center;gap:10px;min-width:0}
    .fmdc-doc>i{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;flex:0 0 auto;font-size:13px}
    .fmdc-doc strong,.fmdc-proj strong{display:block;font-weight:900;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:380px}
    .fmdc-doc span,.fmdc-proj span{display:block;margin-top:1px;color:#667085;font-size:11px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:380px}
    .fmdc-pill{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;background:#f2f4f7;color:#475467;font-size:10.5px;font-weight:1000;white-space:nowrap}
    .fmdc-pill.info{background:#eff8ff;color:#175cd3}.fmdc-pill.warn{background:#fffaeb;color:#93370d}.fmdc-pill.good{background:#ecfdf3;color:#067647}.fmdc-pill.bad{background:#fef3f2;color:#b42318}
    .fmdc-state,.fmdc-empty{border:1px dashed #d0d5dd;border-radius:13px;background:#fff;padding:44px 20px;text-align:center;color:#667085;font-size:13px;font-weight:700}
    .fmdc-empty i,.fmdc-state i{display:block;font-size:28px;margin-bottom:10px;color:#98a2b3}
    .fmdc-empty strong{display:block;color:#101828;font-size:15px;margin-bottom:4px}
    .fmdc-btn{display:inline-flex;align-items:center;gap:7px;margin-top:12px;min-height:36px;padding:7px 13px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font:inherit;font-size:12px;font-weight:900;cursor:pointer}
    @media(max-width:820px){
      .fmdc-top{padding:12px 12px 0}
      .fmdc-heading{display:none}
      .fmdc-search{margin-left:0;flex:1}
      .fmdc-filters{padding:10px 12px 0;flex-wrap:nowrap;overflow-x:auto}
      .fmdc-chip{flex:0 0 auto}
      .fmdc-body{padding:10px 12px 18px}
      .fmdc-table,.fmdc-table tbody{display:block;border:0;background:transparent}
      .fmdc-table thead{display:none}
      .fmdc-table tr[data-doc]{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 10px;margin-bottom:8px;padding:11px 12px;border:1px solid #e4e7ec;border-radius:12px;background:#fff}
      .fmdc-table td{display:block;padding:0;border:0}
      .fmdc-table tr[data-doc]:hover td{background:transparent}
      .fmdc-table td.fmdc-c-doc{grid-column:1/-1}
      .fmdc-table td.fmdc-c-updated{display:none}
      .fmdc-doc strong,.fmdc-doc span,.fmdc-proj strong,.fmdc-proj span{max-width:none}
    }
  `;

  // The kinds the list can be narrowed to, in this order; anything else is "Other".
  const KIND_ORDER = ['proposal', 'contract', 'change_order', 'invoice', 'work_order', 'checklist', 'receipt', 'report'];
  const COPY = {
    all:{ label:(globalThis.PlatformLanguage?.text("documents","m_61df468d92e238","All") ?? "All") }, other:{ label:(globalThis.PlatformLanguage?.text("documents","m_4a04382820d2e1","Other") ?? "Other") }, searchPlaceholder:{ placeholder:(globalThis.PlatformLanguage?.text("documents","m_e34dbef94952ed","Search documents") ?? "Search documents") },
    loadFailed:{ message:(globalThis.PlatformLanguage?.text("documents","m_7c79938321b681","Documents could not load.") ?? "Documents could not load.") }, unavailable:{ message:(globalThis.PlatformLanguage?.text("documents","m_0fa485082c90f8","Documents are not available here.") ?? "Documents are not available here.") },
    title:{ label:(globalThis.PlatformLanguage?.text("documents","m_5d7c7ad6033624","Documents") ?? "Documents") }, noMatch:{ message:(globalThis.PlatformLanguage?.text("documents","m_806ec4a95f7a29","Nothing matches what you searched for.") ?? "Nothing matches what you searched for.") },
    noneYet:{ message:(globalThis.PlatformLanguage?.text("documents","m_6009e8cc8c2f4e","Proposals, contracts, invoices and every other document your company makes will be listed here.") ?? "Proposals, contracts, invoices and every other document your company makes will be listed here.") }
  };

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
      docs:[], loading:true, error:'', loadedAt:0, loadToken:0, destroyed:false, active:context.active !== false,
      query:'', kind:clean(route.documentsKind),
      openDocId:clean(route.tab) === 'documents' ? clean(route.doc) : '',
      viewer:null, viewerDocId:''
    };

    const describe = (doc) => window.FMDocViewer?.describe?.(doc) || { type:clean(doc.document_type) || 'document', typeLabel:clean(doc.document_type) || 'Document', icon:'fa-file-lines', color:'#64748b', statusKey:clean(doc.status), statusLabel:clean(doc.status), tone:'muted', totalCents:0, invoiceId:'' };
    const kindOf = (doc) => { const type = describe(doc).type; return KIND_ORDER.includes(type) ? type : 'other'; };

    function routePatch(patch, history = 'replace'){
      navigation?.[history === 'push' ? 'push' : 'replace']?.(patch, { source:'documents-company', ownedKeys:['doc', 'documentsKind'] });
    }

    async function load(options = {}){
      const token = ++state.loadToken;
      if (!options.silent) { state.loading = true; render(); }
      try {
        const api = window.DocumentsAPI?.documents;
        if (!api?.listOrganization) throw new Error(clean(COPY.unavailable.message));
        const result = await api.listOrganization(state.orgId);
        if (token !== state.loadToken || state.destroyed) return;
        state.docs = array(result?.documents).map(object).filter((doc) => clean(doc.status).toLowerCase() !== 'void');
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

    function visibleDocs(){
      const tokens = state.query.toLowerCase().split(/\s+/).filter(Boolean);
      return state.docs.filter((doc) => {
        if (state.kind && kindOf(doc) !== state.kind) return false;
        if (!tokens.length) return true;
        const described = describe(doc);
        const project = object(doc.project);
        const text = [doc.title, described.typeLabel, described.statusLabel, project.title, project.address, doc.id].map(clean).join(' ').toLowerCase();
        return tokens.every((token) => text.includes(token));
      });
    }

    function kindChipsHtml(){
      const counts = new Map();
      state.docs.forEach((doc) => counts.set(kindOf(doc), (counts.get(kindOf(doc)) || 0) + 1));
      const kinds = [...KIND_ORDER, 'other'].filter((kind) => counts.get(kind));
      if (kinds.length < 2) return '';
      const label = (kind) => kind === 'other' ? COPY.other.label : describe({ document_type:kind }).typeLabel;
      return `<div class="fmdc-filters" role="toolbar" aria-label="${(globalThis.PlatformLanguage?.htmlText("documents","m_4410394a2d9ee5","Document kinds") ?? "Document kinds")}">
        <button type="button" class="fmdc-chip ${state.kind ? '' : 'active'}" data-fmdc-kind="" aria-pressed="${String(!state.kind)}">${esc(COPY.all.label)} <em>${state.docs.length}</em></button>
        ${kinds.map((kind) => `<button type="button" class="fmdc-chip ${state.kind === kind ? 'active' : ''}" data-fmdc-kind="${esc(kind)}" aria-pressed="${String(state.kind === kind)}">${esc(label(kind))} <em>${counts.get(kind)}</em></button>`).join('')}
      </div>`;
    }

    function rowsHtml(docs){
      if (!docs.length) {
        return `<div class="fmdc-empty"><i class="fas fa-file-signature" aria-hidden="true"></i><strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_0be72ce2dfe4ce","No documents here") ?? "No documents here")}</strong><div>${esc(state.docs.length ? COPY.noMatch.message : COPY.noneYet.message)}</div></div>`;
      }
      return `<table class="fmdc-table">
        <thead><tr><th>${(globalThis.PlatformLanguage?.htmlText("documents","m_9c9b98b1f4e8c9","Document") ?? "Document")}</th><th>${(globalThis.PlatformLanguage?.htmlText("documents","m_aaebd7ccba0b30","Project") ?? "Project")}</th><th>${(globalThis.PlatformLanguage?.htmlText("documents","m_1352cafa75b8da","Status") ?? "Status")}</th><th class="num">${(globalThis.PlatformLanguage?.htmlText("documents","m_2b8c3448fa87a1","Amount") ?? "Amount")}</th><th>${(globalThis.PlatformLanguage?.htmlText("documents","m_6a171239c315c1","Updated") ?? "Updated")}</th></tr></thead>
        <tbody>${docs.map((doc) => {
          const described = describe(doc);
          const project = object(doc.project);
          return `<tr data-doc="${esc(doc.id)}" tabindex="0">
            <td class="fmdc-c-doc"><div class="fmdc-doc"><i class="fas ${esc(described.icon)}" style="background:${esc(described.color)}1a;color:${esc(described.color)}" aria-hidden="true"></i><div style="min-width:0"><strong>${esc(clean(doc.title, described.typeLabel))}</strong><span>${esc(described.typeLabel)}</span></div></div></td>
            <td class="fmdc-proj">${clean(project.title, project.address) ? `<strong>${esc(clean(project.title, project.address))}</strong>${project.title && project.address ? `<span>${esc(project.address)}</span>` : ''}` : '<span>—</span>'}</td>
            <td><span class="fmdc-pill ${esc(described.tone)}">${esc(described.statusLabel)}</span></td>
            <td class="num">${described.totalCents ? esc(money(described.totalCents)) : ''}</td>
            <td class="fmdc-c-updated">${esc(shortDate(doc.updated_at || doc.created_at))}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    }

    function render(){
      if (state.destroyed) return;
      const focused = document.activeElement?.matches?.('[data-fmdc-search]');
      let body;
      if (state.loading && !state.docs.length) body = `<div class="fmdc-state"><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_475a1617189b85","Loading documents…") ?? "Loading documents…")}</div>`;
      else if (state.error && !state.docs.length) body = `<div class="fmdc-state"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>${esc(state.error)}<div><button type="button" class="fmdc-btn" data-fmdc-retry><i class="fas fa-rotate" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("documents","m_ef39ad5e614a24","Try again") ?? "Try again")}</button></div></div>`;
      else body = rowsHtml(visibleDocs());
      root.innerHTML = `<div class="fmdc" data-fm-documents-company>
        <header class="fmdc-top" data-app-header>
          <div class="fmdc-heading"><i class="fas fa-file-signature" aria-hidden="true"></i><h1>${esc(COPY.title.label)}</h1>${state.docs.length ? `<span>${state.docs.length}</span>` : ''}</div>
          <label class="fmdc-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-fmdc-search value="${esc(state.query)}" placeholder="${esc(COPY.searchPlaceholder.placeholder)}" aria-label="${esc(COPY.searchPlaceholder.placeholder)}"></label>
        </header>
        ${kindChipsHtml()}
        <div class="fmdc-body" data-fmdc-body>${body}</div>
      </div>`;
      const search = root.querySelector('[data-fmdc-search]');
      search?.addEventListener('input', () => {
        state.query = search.value;
        const holder = root.querySelector('[data-fmdc-body]');
        if (holder) { holder.innerHTML = rowsHtml(visibleDocs()); bindRows(); }
      });
      if (focused && search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
      root.querySelectorAll('[data-fmdc-kind]').forEach((button) => button.addEventListener('click', () => {
        state.kind = clean(button.dataset.fmdcKind);
        routePatch({ documentsKind:state.kind || null });
        render();
      }));
      root.querySelector('[data-fmdc-retry]')?.addEventListener('click', () => load());
      bindRows();
    }

    function bindRows(){
      root.querySelectorAll('tr[data-doc]').forEach((row) => {
        row.addEventListener('click', () => openDoc(row.dataset.doc));
        row.addEventListener('keydown', (event) => { if (event.key === 'Enter') openDoc(row.dataset.doc); });
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
        const nextKind = clean(nextRoute.documentsKind);
        if (nextKind !== state.kind) { state.kind = nextKind; if (!state.loading) render(); }
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
        if (nextOrg && nextOrg !== state.orgId) { state.orgId = nextOrg; state.docs = []; load(); }
      },
      refresh(){ return load(); },
      destroy(){
        state.destroyed = true;
        state.loadToken += 1;
        closeViewer();
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
