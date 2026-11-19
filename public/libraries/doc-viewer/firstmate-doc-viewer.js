/* public/libraries/doc-viewer/firstmate-doc-viewer.js
 * The company document viewer (GP-69): one modal that shows any document as it reads, with what can be done with it
 * in a column on the right. The company Documents app (apps/documents/company.js) opens every document in it and the
 * Invoices app (apps/invoices/app.js) opens every invoice in it, adding the invoice's own actions to the column.
 *
 * It is the project Documents viewer, not a second one: it mounts the document engine (apps/documents/project.js,
 * `project.documents`) for the document's project inside the modal and uses its embed API. The page is drawn by the
 * engine's viewer (`mountViewer`: zoom, print, download), and "Edit document" opens the engine's own document screen
 * (steps, layout editor, Send, history) over the modal until its Back. The project window's Documents tab is not
 * involved and is unchanged.
 *
 *   const viewer = FMDocViewer.open({
 *     orgId,
 *     document,                         // a document record (id, project_id, title, status, document_type, ...)
 *     load,                             // or async () => ({ document, title, subtitle, status, facts, notice })
 *     title, subtitle, icon,
 *     status: { key, label },           // the chip in the header (default: the document's own status)
 *     facts: [{ label, value }],        // shown at the top of the column
 *     notice: { icon, text },           // a highlighted line above the facts (a production hold)
 *     actionsTitle, actions: [{ id, label, icon, primary, danger, run(viewer, button) }],
 *     documentActions: { edit, send, pdf, project, void },   // which document actions to offer (all by default)
 *     onChange(document), onClose(reason)    // reason: 'person' (X, Escape, the backdrop), 'navigate' (Open project), 'host'
 *   });
 *   viewer.refresh(); viewer.update({ facts, actions, status, notice, title, subtitle }); viewer.close();
 */
(function(root){
  'use strict';
  if (root.FMDocViewer) return;

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
  const toast = (title, message, ok = true) => { try { root.Portal?.ui?.showToast?.(title, message, ok); } catch (_) {} };

  const READ_ONLY = ['signed', 'completed', 'declined', 'expired', 'void'];
  const STATUS = {
    draft:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_9ce407c87de615","Draft") ?? "Draft"), tone:'muted' }, issued:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_103d1f897eea51","Issued") ?? "Issued"), tone:'info' }, sent:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_3468b446cb1456","Sent") ?? "Sent"), tone:'info' },
    viewed:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_e863cf0aead394","Viewed") ?? "Viewed"), tone:'warn' }, in_progress:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_813568092a909a","In progress") ?? "In progress"), tone:'warn' }, needs_review:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_00c9ae159a1656","Needs review") ?? "Needs review"), tone:'warn' },
    signed:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_ab7ec8db303996","Signed") ?? "Signed"), tone:'good' }, paid:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_956173c8527121","Paid") ?? "Paid"), tone:'good' }, completed:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_3c4d2141b2fa1c","Completed") ?? "Completed"), tone:'good' },
    declined:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_bf5390659e3677","Declined") ?? "Declined"), tone:'bad' }, expired:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_e685fe954b1758","Expired") ?? "Expired"), tone:'bad' }, void:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_ce16922c5208b8","Void") ?? "Void"), tone:'bad' },
    due:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_3dac4d5769efeb","Due") ?? "Due"), tone:'info' }, overdue:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_cda60f7c71e465","Overdue") ?? "Overdue"), tone:'bad' }, partially_paid:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_81cd143ded343f","Partly paid") ?? "Partly paid"), tone:'warn' }
  };
  const TYPES = {
    proposal:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_1d8655e967c464","Proposal") ?? "Proposal"), icon:'fa-file-signature', color:'#2563eb' },
    invoice:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_1d5ea39cc421fc","Invoice") ?? "Invoice"), icon:'fa-file-invoice-dollar', color:'#175cd3' },
    change_order:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_599f4215bbaccf","Change order") ?? "Change order"), icon:'fa-file-contract', color:'#7c3aed' },
    contract:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_06c8cfa66b1dbc","Contract") ?? "Contract"), icon:'fa-file-contract', color:'#0f766e' },
    work_order:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_371de1af006ef4","Work order") ?? "Work order"), icon:'fa-clipboard-list', color:'#b45309' },
    checklist:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"), icon:'fa-list-check', color:'#0e7490' },
    receipt:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_ab3df34a8730df","Receipt") ?? "Receipt"), icon:'fa-receipt', color:'#b54708' },
    report:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_c47c2ce6bb05c0","Report") ?? "Report"), icon:'fa-file-lines', color:'#475467' }
  };

  // What the viewer says itself (label: entries, so the language build catalogues them).
  const COPY = {
    edit:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_a1340a56589d26","Edit document") ?? "Edit document") }, open:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_1085da75347e01","Open document") ?? "Open document") }, send:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_c23a056552a09f","Send") ?? "Send") }, pdf:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_4944e59816b60a","Download PDF") ?? "Download PDF") },
    project:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_27136d1254783a","Open project") ?? "Open project") }, void:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_ce16922c5208b8","Void") ?? "Void") }, documentGroup:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_9c9b98b1f4e8c9","Document") ?? "Document") }, actionsGroup:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_6067958dea3386","Actions") ?? "Actions") },
    opening:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_b86508131600f7","Opening document") ?? "Opening document") }, unavailable:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_fc865c9558abcb","Preview unavailable") ?? "Preview unavailable") }, nothing:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_a481ec5c1b6d4f","This has no document to show yet.") ?? "This has no document to show yet.") },
    noEngine:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_0fa485082c90f8","Documents are not available here.") ?? "Documents are not available here.") }, failed:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_db0ea2ce3e1da9","This document could not be opened.") ?? "This document could not be opened.") },
    retry:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_420a128ff60dbe","That did not work. Try again.") ?? "That did not work. Try again.") }, toastTitle:{ label:(globalThis.PlatformLanguage?.text("doc-viewer","m_5d7c7ad6033624","Documents") ?? "Documents") }
  };
  const say = (key) => clean(COPY[key]?.label);

  function prettify(key){ return clean(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }

  /** What a list shows about a document: its kind, status and amount, read from the record alone. */
  function describe(doc = {}){
    const record = object(doc);
    const type = clean(record.document_type).toLowerCase() || 'document';
    const meta = TYPES[type] || { label:prettify(type) || 'Document', icon:'fa-file-lines', color:'#64748b' };
    const statusKey = clean(root.FMDocModel?.documentProgress?.(record), record.status).toLowerCase() || 'draft';
    const status = STATUS[statusKey] || { label:prettify(statusKey), tone:'muted' };
    const params = object(record.params);
    let totalCents = Number(object(record.summary).total_cents);
    if (!(Number.isFinite(totalCents) && totalCents > 0)) {
      totalCents = 0;
      for (const key of ['amount_cents', 'total_cents', 'amount_due_cents']) {
        const value = Number(params[key]);
        if (Number.isFinite(value) && value > 0) { totalCents = Math.round(value); break; }
      }
    }
    return { type, typeLabel:meta.label, icon:meta.icon, color:meta.color, statusKey, statusLabel:status.label, tone:status.tone, totalCents, invoiceId:invoiceIdOf(record) };
  }

  /** The Money invoice a document was written from, or ''. Invoices open in the Invoices app. */
  function invoiceIdOf(doc = {}){
    const meta = object(object(doc).metadata);
    if (meta.payment_invoice === true || clean(meta.source_invoice_id)) return clean(meta.source_invoice_id);
    const match = /^doc_invoice_(.+)$/.exec(clean(object(doc).id));
    return match ? match[1] : '';
  }

  const CSS = `
    .fmdv-shade{position:fixed;inset:0;z-index:2147483100;background:rgba(15,23,42,.55);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box}
    .fmdv-shade *{box-sizing:border-box}
    .fmdv-modal{position:relative;width:min(1240px,100%);height:min(900px,100%);display:flex;flex-direction:column;border-radius:16px;background:#fff;box-shadow:0 28px 80px rgba(15,23,42,.42);overflow:hidden;color:#101828}
    .fmdv-head{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:12px 14px 12px 16px;border-bottom:1px solid #eaecf0;min-width:0}
    .fmdv-icon{flex:0 0 auto;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025));font-size:14px}
    .fmdv-titles{flex:1;min-width:0;display:grid;gap:1px}
    .fmdv-titles strong{font-size:15px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .fmdv-titles span{color:#667085;font-size:11.5px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .fmdv-titles span:empty{display:none}
    .fmdv-pill{flex:0 0 auto;display:inline-flex;align-items:center;border-radius:999px;padding:4px 10px;background:#f2f4f7;color:#475467;font-size:10.5px;font-weight:1000;white-space:nowrap}
    .fmdv-pill:empty{display:none}
    .fmdv-pill.info{background:#eff8ff;color:#175cd3}.fmdv-pill.warn{background:#fffaeb;color:#93370d}.fmdv-pill.good{background:#ecfdf3;color:#067647}.fmdv-pill.bad{background:#fef3f2;color:#b42318}
    .fmdv-close{flex:0 0 auto;width:34px;height:34px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;cursor:pointer;font-size:14px}
    .fmdv-close:hover{background:#f9fafb}
    .fmdv-body{position:relative;flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 300px}
    .fmdv-stage{position:relative;min-width:0;min-height:0;background:#525a66;overflow:hidden}
    .fmdv-view{position:absolute;inset:0}
    .fmdv-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;color:#e7ecf5;text-align:center;font-size:13px}
    .fmdv-state strong{font-size:14px;font-weight:1000}
    .fmdv-state span{color:#c4cbd8;font-size:12px;font-weight:700;max-width:360px}
    .fmdv-state>i{font-size:22px;color:#c4cbd8}
    .fmdv-spin{width:26px;height:26px;border-radius:50%;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;animation:fmdv-spin .8s linear infinite}
    @keyframes fmdv-spin{to{transform:rotate(360deg)}}
    .fmdv-view>.fmdx-state{margin:24px auto!important;max-width:360px}
    .fmdv-rail{min-height:0;overflow:auto;border-left:1px solid #eaecf0;background:#fcfcfd;padding:14px;display:flex;flex-direction:column;gap:14px}
    .fmdv-notice{display:flex;gap:9px;align-items:flex-start;border:1px solid #fedf89;border-radius:11px;background:#fffaeb;color:#93370d;padding:10px 11px;font-size:12px;font-weight:800;line-height:1.4}
    .fmdv-facts{display:grid;gap:9px;margin:0}
    .fmdv-facts div{display:grid;gap:2px;min-width:0}
    .fmdv-facts dt{color:#667085;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}
    .fmdv-facts dd{margin:0;font-size:13px;font-weight:850;overflow-wrap:anywhere}
    .fmdv-group{display:grid;gap:6px}
    .fmdv-group h3{margin:0 0 2px;color:#667085;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}
    .fmdv-btn{display:flex;align-items:center;gap:9px;width:100%;min-height:38px;padding:8px 12px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;font:inherit;font-size:12.5px;font-weight:900;text-align:left;text-decoration:none;cursor:pointer}
    .fmdv-btn i{width:16px;text-align:center;flex:0 0 auto}
    .fmdv-btn:hover{background:#f9fafb;border-color:#98a2b3}
    .fmdv-btn:disabled{opacity:.5;cursor:default}
    .fmdv-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
    .fmdv-btn.primary:hover{filter:brightness(.96)}
    .fmdv-btn.danger{color:#b42318}
    .fmdv-engine{position:absolute;inset:0;z-index:20;background:#fff;overflow:hidden}
    .fmdv-engine[hidden]{display:none}
    .fmdv-modal.is-editing .fmdv-rail{visibility:hidden}
    @media(max-width:820px){
      .fmdv-shade{padding:0}
      .fmdv-modal{width:100%;height:100%;border-radius:0}
      .fmdv-head{padding:calc(10px + var(--fm-window-safe-top,0px)) 12px 10px}
      .fmdv-body{display:flex;flex-direction:column;overflow:auto}
      .fmdv-stage{flex:0 0 auto;height:62dvh}
      .fmdv-rail{flex:0 0 auto;overflow:visible;border-left:0;border-top:1px solid #eaecf0;padding-bottom:calc(14px + var(--fm-window-safe-bottom,0px))}
      .fmdv-engine{position:fixed;inset:0;z-index:2147483110}
    }
  `;

  function ensureStyles(){
    if (document.getElementById('fmdv-styles')) return;
    const style = document.createElement('style');
    style.id = 'fmdv-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // A dialog of the engine, Preview, "Edit manually" or a host's own dialog is above the viewer: Escape is theirs.
  const ABOVE = '.fmdx-modal-back,.fmdx-preview-overlay,.fmse-overlay,.fmdx-menu,.inv-shade';

  function open(options = {}){
    ensureStyles();
    const orgId = clean(options.orgId, root.Portal?.cfg?.userOrgId, root.__APP?.userOrgId, root.__APP?.orgId);
    const view = {
      document: object(options.document),
      title: clean(options.title), subtitle: clean(options.subtitle), icon: clean(options.icon),
      status: options.status || null, facts: array(options.facts), notice: options.notice || null,
      actionsTitle: clean(options.actionsTitle), actions: array(options.actions),
      documentActions: { edit:true, send:true, pdf:true, project:true, void:true, ...object(options.documentActions) },
      loading: false, error: ''
    };
    let closed = false;
    let engine = null;          // { handle, api, projectId } once the document engine is mounted
    let enginePromise = null;
    let viewer = null;          // the engine's viewer in the stage
    let editing = false;

    const shade = document.createElement('div');
    shade.className = 'fmdv-shade';
    shade.setAttribute('data-fm-doc-viewer', '');
    shade.innerHTML = `<div class="fmdv-modal" role="dialog" aria-modal="true">
      <header class="fmdv-head">
        <span class="fmdv-icon"><i class="fas fa-file-lines" aria-hidden="true" data-fmdv-icon></i></span>
        <div class="fmdv-titles"><strong data-fmdv-title></strong><span data-fmdv-subtitle></span></div>
        <span class="fmdv-pill" data-fmdv-status></span>
        <button type="button" class="fmdv-close" data-fmdv-close aria-label="${(globalThis.PlatformLanguage?.htmlText("doc-viewer","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark" aria-hidden="true"></i></button>
      </header>
      <div class="fmdv-body">
        <div class="fmdv-stage"><div class="fmdv-view" data-fmdv-view></div></div>
        <aside class="fmdv-rail" data-fmdv-rail aria-label="${(globalThis.PlatformLanguage?.htmlText("doc-viewer","m_6067958dea3386","Actions") ?? "Actions")}"></aside>
        <div class="fmdv-engine" data-fmdv-engine hidden></div>
      </div>
    </div>`;
    const modal = shade.querySelector('.fmdv-modal');
    const viewHost = shade.querySelector('[data-fmdv-view]');
    const rail = shade.querySelector('[data-fmdv-rail]');
    const engineHost = shade.querySelector('[data-fmdv-engine]');
    document.body.appendChild(shade);

    const handle = { close, refresh, update, get document(){ return view.document; }, element: shade };

    function docProjectId(){ return clean(view.document.project_id); }
    function readOnly(){ return READ_ONLY.includes(clean(view.document.status).toLowerCase()); }

    function renderHead(){
      const described = describe(view.document);
      shade.querySelector('[data-fmdv-title]').textContent = clean(view.title, view.document.title, described.typeLabel);
      shade.querySelector('[data-fmdv-subtitle]').textContent = view.subtitle;
      shade.querySelector('[data-fmdv-icon]').className = `fas ${clean(view.icon, described.icon)}`;
      modal.setAttribute('aria-label', clean(view.title, view.document.title, described.typeLabel));
      const pill = shade.querySelector('[data-fmdv-status]');
      const status = view.status || (view.document.id ? { key:described.statusKey, label:described.statusLabel } : null);
      const tone = status ? (STATUS[clean(status.key).toLowerCase()]?.tone || clean(status.tone) || 'muted') : '';
      pill.className = `fmdv-pill ${tone}`;
      pill.textContent = status ? clean(status.label, prettify(status.key)) : '';
    }

    function documentActionList(){
      const has = view.documentActions;
      const ready = !!engine?.api && !!view.document.id;
      const list = [];
      if (has.edit && view.document.id) list.push({ id:'doc-edit', label:say(readOnly() ? 'open' : 'edit'), icon:readOnly() ? 'fa-up-right-from-square' : 'fa-pen-to-square', primary:!view.actions.some((action) => action.primary), needsEngine:true, run:() => openEditor() });
      if (has.send && view.document.id && !readOnly()) list.push({ id:'doc-send', label:say('send'), icon:'fa-paper-plane', needsEngine:true, run:() => engine.api.openSendModal(view.document) });
      if (has.pdf && view.document.id) list.push({ id:'doc-pdf', label:say('pdf'), icon:'fa-download', needsEngine:true, run:(button) => engine.api.downloadPdf(view.document, button) });
      if (has.project && docProjectId()) list.push({ id:'doc-project', label:say('project'), icon:'fa-folder-open', run:() => openProject() });
      if (has.void && view.document.id && !readOnly() && root.FirstMateEmbeddableApps) list.push({ id:'doc-void', label:say('void'), icon:'fa-ban', danger:true, needsEngine:true, run:() => voidDocument() });
      return list.map((action) => ({ ...action, disabled:action.needsEngine && !ready }));
    }

    function buttonHtml(action){
      const classes = ['fmdv-btn', action.primary ? 'primary' : '', action.danger ? 'danger' : ''].filter(Boolean).join(' ');
      if (action.href) return `<a class="${classes}" data-fmdv-action="${esc(action.id)}" href="${esc(action.href)}" target="_blank" rel="noopener"><i class="fas ${esc(clean(action.icon, 'fa-circle'))}" aria-hidden="true"></i><span>${esc(action.label)}</span></a>`;
      return `<button type="button" class="${classes}" data-fmdv-action="${esc(action.id)}"${action.disabled ? ' disabled' : ''}><i class="fas ${esc(clean(action.icon, 'fa-circle'))}" aria-hidden="true"></i><span>${esc(action.label)}</span></button>`;
    }

    function renderRail(){
      const docActions = documentActionList();
      const hostActions = view.actions.filter((action) => action && action.hidden !== true);
      const facts = view.facts.filter((fact) => fact && clean(fact.value));
      rail.innerHTML = `
        ${view.notice ? `<div class="fmdv-notice"><i class="fas ${esc(clean(view.notice.icon, 'fa-circle-info'))}" aria-hidden="true"></i><span>${esc(view.notice.text)}</span></div>` : ''}
        ${facts.length ? `<dl class="fmdv-facts">${facts.map((fact) => `<div><dt>${esc(fact.label)}</dt><dd>${esc(fact.value)}</dd></div>`).join('')}</dl>` : ''}
        ${hostActions.length ? `<section class="fmdv-group">${view.actionsTitle ? `<h3>${esc(view.actionsTitle)}</h3>` : ''}${hostActions.map(buttonHtml).join('')}</section>` : ''}
        ${docActions.length ? `<section class="fmdv-group" data-fmdv-document-actions><h3>${esc(say(hostActions.length ? 'documentGroup' : 'actionsGroup'))}</h3>${docActions.map(buttonHtml).join('')}</section>` : ''}`;
      const byId = new Map([...hostActions, ...docActions].map((action) => [clean(action.id), action]));
      rail.querySelectorAll('button[data-fmdv-action]').forEach((button) => button.addEventListener('click', async () => {
        const action = byId.get(button.dataset.fmdvAction);
        if (!action || typeof action.run !== 'function' || button.disabled) return;
        try { await action.run(button.dataset.fmdvAction.startsWith('doc-') ? button : handle, button); }
        catch (error) { toast(say('toastTitle'), clean(error?.message, say('retry')), false); }
      }));
    }

    function renderStage(){
      try { viewer?.destroy?.(); } catch (_) {}
      viewer = null;
      const opening = `<div class="fmdv-state"><div class="fmdv-spin"></div><strong>${esc(say('opening'))}</strong></div>`;
      if (view.loading) { viewHost.innerHTML = opening; return; }
      if (view.error || !view.document.id) {
        viewHost.innerHTML = `<div class="fmdv-state" data-fmdv-unavailable><i class="fas fa-eye-slash" aria-hidden="true"></i><strong>${esc(say('unavailable'))}</strong><span>${esc(clean(view.error, say('nothing')))}</span></div>`;
        return;
      }
      if (!engine?.api?.mountViewer) { viewHost.innerHTML = opening; return; }
      viewer = engine.api.mountViewer(viewHost, view.document, { initialZoom:'width' });
    }

    function renderAll(){ if (closed) return; renderHead(); renderRail(); renderStage(); }

    // ---- the document engine (apps/documents/project.js), mounted for the document's project
    function setEditing(on){
      editing = !!on;
      engineHost.hidden = !editing;
      modal.classList.toggle('is-editing', editing);
    }
    function destroyEngine(){
      try { viewer?.destroy?.(); } catch (_) {}
      viewer = null;
      try { engine?.handle?.destroy?.(); } catch (_) {}
      engine = null;
      enginePromise = null;
      engineHost.innerHTML = '';
      setEditing(false);
    }
    async function projectContext(projectId){
      if (!projectId) return {};
      const record = await root.PlatformAPI?.projects?.get?.(orgId, projectId).catch?.(() => null);
      const data = object(object(record?.document).data);
      return { ...data, id:projectId, organization_id:orgId };
    }
    function ensureEngine(){
      const projectId = docProjectId();
      if (engine && engine.projectId === projectId) return Promise.resolve(engine);
      if (enginePromise && enginePromise.projectId === projectId) return enginePromise;
      if (engine || enginePromise) destroyEngine();
      const runtime = root.FirstMateEmbeddableApps;
      if (!runtime?.mount) return Promise.resolve(null);
      const promise = (async () => {
        const project = await projectContext(projectId);
        if (closed) return null;
        let api = null;
        const mounted = await runtime.mount(engineHost, 'project.documents', {
          surface:'project_modal', chrome:'project_modal', orgId, project, projectId, active:true,
          params:{ embed:{
            enabled:true,
            // The modal is the document's frame: the engine leaves the page's windows as they are.
            focus:false,
            onReady:(ready) => { api = ready; },
            onDocScreen:() => setEditing(true),
            onListView:() => { if (editing) finishEditing(); }
          } }
        });
        if (closed || promise !== enginePromise) { try { mounted?.destroy?.(); } catch (_) {} return null; }
        if (!mounted || mounted.denied || !api) {
          try { mounted?.destroy?.(); } catch (_) {}
          enginePromise = null;
          return null;
        }
        engine = { handle:mounted, api, projectId };
        return engine;
      })().catch((error) => { console.warn('The document viewer could not mount the document engine', error); enginePromise = null; return null; });
      promise.projectId = projectId;
      enginePromise = promise;
      return promise;
    }
    async function startEngine(){
      if (!view.document.id) return;
      const ready = await ensureEngine();
      if (closed) return;
      if (!ready) view.error = view.error || say('noEngine');
      renderRail();
      renderStage();
    }
    async function openEditor(){
      if (!engine?.api) return;
      setEditing(true);
      await engine.api.openDocument(view.document);
    }
    async function finishEditing(){
      setEditing(false);
      await reloadDocument();
      options.onChange?.(view.document);
    }
    async function reloadDocument(){
      const id = clean(view.document.id);
      if (!id || !root.DocumentsAPI?.documents?.get) return;
      const result = await root.DocumentsAPI.documents.get(orgId, id).catch(() => null);
      const next = object(result?.document || result?.doc);
      if (next.id) view.document = { ...view.document, ...next };
      if (!closed) renderAll();
    }
    async function voidDocument(){
      const before = clean(view.document.status);
      await engine.api.archiveDoc(view.document);
      await reloadDocument();
      if (clean(view.document.status) !== before) { options.onChange?.(view.document); if (clean(view.document.status) === 'void') close('person'); }
    }
    function openProject(){
      const projectId = docProjectId();
      close('navigate');
      root.Portal?.navigation?.navigate?.({ project:projectId, projectTab:'docs' }, { source:'document-viewer-project', ownedKeys:['project', 'projectTab'] });
    }

    // ---- loading what to show
    async function refresh(){
      if (typeof options.load !== 'function') { await reloadDocument(); await startEngine(); return; }
      view.loading = true;
      view.error = '';
      renderAll();
      try {
        const loaded = object(await options.load(handle));
        if (closed) return;
        apply(loaded);
      } catch (error) {
        if (closed) return;
        view.error = clean(error?.message, say('failed'));
      }
      view.loading = false;
      renderAll();
      await startEngine();
    }
    function apply(next = {}){
      if (next.document !== undefined) view.document = object(next.document);
      for (const key of ['title', 'subtitle', 'icon', 'actionsTitle']) if (next[key] !== undefined) view[key] = clean(next[key]);
      if (next.status !== undefined) view.status = next.status || null;
      if (next.notice !== undefined) view.notice = next.notice || null;
      if (next.facts !== undefined) view.facts = array(next.facts);
      if (next.actions !== undefined) view.actions = array(next.actions);
    }
    function update(next = {}){
      const before = clean(view.document.id);
      apply(object(next));
      if (closed) return;
      renderHead();
      renderRail();
      if (clean(view.document.id) !== before) { renderStage(); startEngine(); }
    }

    // ---- closing
    function onKey(event){
      if (event.key !== 'Escape' || closed || editing || event.defaultPrevented) return;
      if (document.querySelector(ABOVE)) return;
      close('person');
    }
    function close(reason = 'host'){
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      destroyEngine();
      shade.remove();
      try { options.onClose?.(reason); } catch (error) { console.warn('Closing the document viewer failed', error); }
    }
    document.addEventListener('keydown', onKey);
    shade.querySelector('[data-fmdv-close]').addEventListener('click', () => close('person'));
    shade.addEventListener('mousedown', (event) => { if (event.target === shade && !editing) close('person'); });

    renderAll();
    if (typeof options.load === 'function') refresh();
    else startEngine();
    return handle;
  }

  root.FMDocViewer = { open, describe, invoiceIdOf, statusTone:(key) => STATUS[clean(key).toLowerCase()]?.tone || 'muted' };
})(typeof window !== 'undefined' ? window : globalThis);
