/* Mobile field document workflows: quote, payment and in-person signature. */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  if (!runtime?.registerApp) return;
  const clean = (value) => String(value ?? '').trim();
  const esc = (value) => clean(value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const projectId = (context) => clean(context.project?.id || context.projectId || context.entityId);
  const orgId = (context) => clean(context.organizationId || context.orgId || window.__APP?.organizationId);
  const access = { applicationsAny:['field'], devices:['mobile','desktop'], permissionsAny:['crew.signatures.present'], requireEntitlement:true };
  const presentation = { projectModal:{ desktopLeft:'none', mobileLeft:'none', mobileInfo:'none', mobileTabs:'icons', mobileFullscreenControl:false } };
  const evidence = () => ({ path:location.pathname, href:location.href, timezone:Intl.DateTimeFormat(globalThis.PlatformLanguage?.formatLocale?.()).resolvedOptions().timeZone });

  function setPath(target, path, value){
    const parts = clean(path).split('.').filter(Boolean);
    let cursor = target;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) cursor[part] = value;
      else cursor = cursor[part] = object(cursor[part]);
    });
  }
  function panel(){ return '<div class="fm-field-signatures" data-field-signatures></div>'; }

  function mount(context = {}){
    const outer = context.roots?.main || context.mainRoot || context.root;
    const root = outer?.querySelector?.('[data-field-signatures]') || outer;
    if (!root) return {};
    let destroyed = false;
    let items = [];
    let library = [];
    let canAddWork = false;
    let detail = null;
    let renderer = null;
    let workflow = null;
    let saveQueue = Promise.resolve();

    const style = document.createElement('style');
    style.textContent = `
      .fm-field-signatures{height:100%;min-height:0;overflow:auto;background:#f5f7fa;padding:12px;box-sizing:border-box;color:#101828;-webkit-overflow-scrolling:touch}
      .fm-field-signatures *{box-sizing:border-box}.fm-sig-head{position:sticky;z-index:8;top:-12px;display:flex;align-items:center;gap:10px;margin:-12px -12px 12px;padding:12px;background:rgba(245,247,250,.96);backdrop-filter:blur(10px);border-bottom:1px solid #e4e7ec}.fm-sig-head button{width:42px;height:42px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;color:#344054}.fm-sig-head h2{margin:0;font-size:18px}.fm-sig-list{display:grid;gap:10px}.fm-sig-card{width:100%;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:11px;border:1px solid #e4e7ec;border-radius:16px;background:#fff;padding:14px;text-align:left;color:inherit;box-shadow:0 8px 22px rgba(15,23,42,.05)}.fm-sig-card>i{width:42px;height:42px;border-radius:13px;display:grid;place-items:center;background:#fff4ed;color:#c4320a}.fm-sig-card strong,.fm-sig-card span{display:block}.fm-sig-card span{margin-top:3px;color:#667085;font-size:11px;font-weight:750}.fm-sig-count{border-radius:999px;background:#fff4ed;color:#b54708;padding:5px 8px;font-size:10px;font-weight:900}.fm-sig-empty{min-height:220px;padding:32px 22px;display:grid;place-items:center;text-align:center;color:#667085}.fm-sig-empty i{display:block;margin-bottom:10px;font-size:30px;color:#12b76a}.fm-sig-stage{overflow:visible;border-radius:14px;background:#e9edf2;padding:10px}.fm-sig-stage .fmdoc-page{margin:0 auto 10px}.fm-sig-help{margin:0 0 10px;border:1px solid #b2ddff;border-radius:12px;background:#eff8ff;color:#175cd3;padding:10px 12px;font-size:12px;font-weight:750;line-height:1.45}.fm-field-workflow{min-height:calc(100% - 58px)}.fm-field-workflow .fmdw{min-height:calc(100vh - 150px)}.fm-doc-handoff{display:flex;align-items:center;gap:10px;margin:0 0 10px;padding:12px;border:1px solid #a6f4c5;border-radius:12px;background:#ecfdf3;color:#067647;font-size:12px;font-weight:800}.fm-doc-edit{margin-left:auto;border:1px solid #75e0a7!important;color:#067647!important;background:#fff!important;width:auto!important;padding:0 11px}
      .fm-field-signatures.is-workflow{width:100%;max-width:100%;min-width:0;padding:0;overflow:hidden;display:flex;flex-direction:column}.fm-field-signatures.is-workflow .fm-sig-head{position:relative;top:auto;flex:none;min-width:0;margin:0;padding:12px}.fm-field-signatures.is-workflow .fm-sig-head h2{min-width:0;overflow-wrap:anywhere}.fm-field-signatures.is-workflow .fm-field-workflow{flex:1;width:100%;max-width:100%;min-width:0;min-height:0;overflow:hidden;display:flex}.fm-field-signatures.is-workflow .fm-field-workflow>.fmdw{flex:1;width:100%;max-width:100%;height:100%;min-width:0;min-height:0;overflow:hidden}
      .fm-workflow-add{margin-left:auto;width:auto!important;padding:0 13px!important;background:#1769aa!important;border-color:#1769aa!important;color:#fff!important;font-weight:800}.fm-workflow-summary{margin:0 0 12px;color:#667085;font-size:12px}.fm-sig-card:not(button){cursor:default}.fm-sig-card[data-signature-document]{cursor:pointer}.fm-sig-card.is-completed>i{background:#ecfdf3;color:#067647}.fm-sig-card.is-upcoming>i{background:#f2f4f7;color:#667085}.fm-workflow-meta{display:flex!important;flex-wrap:wrap;gap:5px 9px}.fm-workflow-status{text-transform:capitalize}.fm-workflow-picker{position:fixed;inset:0;z-index:10020;display:flex;flex-direction:column;background:#f8fafc;color:#101828}.fm-workflow-picker-head{display:flex;align-items:center;gap:10px;padding:14px;border-bottom:1px solid #e4e7ec;background:#fff}.fm-workflow-picker-head h3{margin:0;font-size:19px}.fm-workflow-picker-head button{width:42px;height:42px;border:1px solid #d0d5dd;border-radius:12px;background:#fff}.fm-workflow-search{margin:14px;width:calc(100% - 28px);height:46px;border:1px solid #cfd7e6;border-radius:12px;padding:0 14px;font:inherit}.fm-workflow-library{display:grid;gap:10px;overflow:auto;padding:0 14px 24px}.fm-library-heading{margin:8px 0 0;color:#667085;font-size:11px;text-transform:uppercase;letter-spacing:.08em}.fm-library-item{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:12px;width:100%;padding:14px;border:1px solid #e4e7ec;border-radius:15px;background:#fff;text-align:left;color:#101828}.fm-library-item>i{width:42px;height:42px;display:grid;place-items:center;border-radius:12px;background:#eef4ff;color:#3538cd}.fm-library-item strong,.fm-library-item small{display:block}.fm-library-item small{margin-top:3px;color:#667085;line-height:1.35}.fm-doc-actions{display:flex;gap:8px;margin-left:auto}.fm-doc-portal{border:1px solid #75e0a7;border-radius:9px;background:#fff;color:#067647;padding:8px 10px;font-weight:800}
      .fm-chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;background:#fffaeb;color:#b54708;border:1px solid #fedf89;padding:3px 8px;font-size:10px;font-weight:800;white-space:nowrap}.fm-chip i{font-size:9px}.fm-chip-info{background:#eff8ff;color:#175cd3;border-color:#b2ddff}.fm-chip-muted{background:#f2f4f7;color:#667085;border-color:#e4e7ec}.fm-chip-danger{background:#fef3f2;color:#d92d20;border-color:#fecdca}.fm-chip-success{background:#ecfdf3;color:#067647;border-color:#a6f4c5}
      .fm-sig-card.is-canceled,.fm-sig-card.is-declined{opacity:.72}.fm-sig-card.is-canceled>i{background:#f2f4f7;color:#667085}.fm-sig-card.is-declined>i{background:#fef3f2;color:#d92d20}
      .fm-sig-card-side{display:flex;align-items:center;gap:6px}.fm-work-menu-btn{width:34px;height:38px;border:none;background:transparent;color:#667085;border-radius:10px;display:grid;place-items:center}.fm-work-menu-btn:active{background:#f2f4f7}
      .fm-work-sheet{position:fixed;inset:0;z-index:10040;display:flex;flex-direction:column;justify-content:flex-end;background:rgba(16,24,40,.45)}.fm-work-sheet-panel{background:#fff;border-radius:18px 18px 0 0;padding:10px 14px calc(14px + env(safe-area-inset-bottom));display:grid;gap:4px;max-height:78vh;overflow:auto}.fm-work-sheet-panel h4{margin:6px 2px 8px;font-size:15px;color:#101828}.fm-work-sheet-panel small{color:#667085;display:block;margin:-6px 2px 8px}.fm-work-action{display:flex;align-items:center;gap:11px;width:100%;border:none;background:transparent;text-align:left;font:inherit;font-weight:750;color:#101828;padding:13px 6px;border-radius:12px}.fm-work-action:active{background:#f2f4f7}.fm-work-action i{width:20px;text-align:center;color:#475467}.fm-work-action.is-danger,.fm-work-action.is-danger i{color:#d92d20}.fm-work-action[disabled]{opacity:.5}
      .fm-cancel-form{display:grid;gap:10px;padding:4px 2px}.fm-cancel-form label{font-size:12px;font-weight:800;color:#344054}.fm-cancel-form textarea{border:1px solid #d0d5dd;border-radius:12px;padding:10px 12px;font:inherit;min-height:64px;resize:vertical}.fm-cancel-choice{display:flex;align-items:flex-start;gap:10px;border:1px solid #e4e7ec;border-radius:12px;padding:11px 12px}.fm-cancel-choice input{margin-top:3px}.fm-cancel-choice strong{display:block;font-size:13px}.fm-cancel-choice small{display:block;margin-top:2px;color:#667085;line-height:1.35}.fm-cancel-actions{display:flex;gap:8px;margin-top:4px}.fm-cancel-actions button{flex:1;height:46px;border-radius:12px;font:inherit;font-weight:800;border:1px solid #d0d5dd;background:#fff;color:#344054}.fm-cancel-actions .is-danger{background:#d92d20;border-color:#d92d20;color:#fff}
      @media(max-width:720px){.fm-field-signatures{padding:10px}.fm-sig-head{top:-10px;margin:-10px -10px 10px;padding:10px}.fm-field-workflow .fmdw{min-height:0}.fm-field-workflow .fmdw-rail{position:relative;top:auto}.fm-sig-stage{margin:0 -10px;border-radius:0;padding:8px}.fm-sig-stage .fmdoc-page{box-shadow:0 4px 18px rgba(15,23,42,.12)}}`;
    document.head.appendChild(style);

    function cleanup(){ try { renderer?.destroy?.(); } catch (_) {} try { workflow?.destroy?.(); } catch (_) {} renderer = null; workflow = null; }
    function loading(message = 'Loading customer agreements…'){
      cleanup();
      root.innerHTML = `<div class="fm-sig-empty"><div><i class="fa-solid fa-spinner fa-spin"></i><strong>${esc(message)}</strong></div></div>`;
    }
    function renderLibrary(query = ''){
      cleanup();
      if (context.active !== false) context.setHeaderAction?.(null);
      const needle = clean(query).toLowerCase();
      const matches = library.filter((entry) => !needle || [entry.title, entry.description, entry.category, ...(entry.keywords || [])].join(' ').toLowerCase().includes(needle));
      root.innerHTML = `<div class="fm-workflow-picker"><div class="fm-workflow-picker-head"><button type="button" data-library-close aria-label="${(globalThis.PlatformLanguage?.text("signatures","m_121372231b5699","Back") ?? "Back")}"><i class="fa-solid fa-arrow-left"></i></button><h3>${(globalThis.PlatformLanguage?.text("signatures","m_2ebfdc1730afd2","Add Work") ?? "Add Work")}</h3></div><input class="fm-workflow-search" data-library-search type="search" value="${String(esc(query))}" placeholder="${(globalThis.PlatformLanguage?.text("signatures","m_721025547915c1","Search job types and workflows") ?? "Search job types and workflows")}" aria-label="${(globalThis.PlatformLanguage?.text("signatures","m_531c49ff18ea3b","Search job types") ?? "Search job types")}"><div class="fm-workflow-library">${String(matches.length ? matches.map((entry, index) => `${(index === 0 || matches[index - 1]?.category !== entry.category) ? `<h4 class="fm-library-heading">${esc(entry.frequent ? 'Frequently used' : entry.category)}</h4>` : ''}<button type="button" class="fm-library-item" data-library-scope="${esc(entry.id)}"><i class="fa-solid ${esc(entry.icon || 'fa-list-check')}"></i><span><strong>${esc(entry.title)}</strong><small>${esc(entry.description)}</small></span><i class="fa-solid fa-chevron-right"></i></button>`).join('') : '<div class="fm-sig-empty"><div><i class="fa-solid fa-magnifying-glass"></i><strong>No available workflows match that search.</strong></div></div>')}</div></div>`;
      root.querySelector('[data-library-close]')?.addEventListener('click', renderList);
      root.querySelector('[data-library-search]')?.addEventListener('input', (event) => {
        const value = event.target.value;
        renderLibrary(value);
        const next = root.querySelector('[data-library-search]');
        next?.focus();
        next?.setSelectionRange?.(value.length, value.length);
      });
      root.querySelectorAll('[data-library-scope]').forEach((button) => button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const before = new Set(items.filter((item) => item.kind === 'document').map((item) => clean(item.document_id)));
          const response = await window.CrewAPI.projects.addWorkflowScope(orgId(context), projectId(context), button.dataset.libraryScope, {});
          if (Array.isArray(response?.items)) items = response.items;
          else await loadList();
          window.PortalToast?.success?.('Work added to this project.');
          renderList();
          const added = items.find((item) => item.kind === 'document' && !before.has(clean(item.document_id)));
          if (added) openDeliverySheet(added);
        } catch (error) {
          button.disabled = false;
          window.PortalToast?.error?.(error?.message || 'Could not add this work.');
        }
      }));
    }
    function waitingChips(item){
      const status = clean(item.status);
      if (status === 'canceled') return [`<span class="fm-chip fm-chip-muted"><i class="fa-solid fa-ban"></i>${(globalThis.PlatformLanguage?.text("signatures","m_43290aaa17806c","Canceled") ?? "Canceled")}</span>`];
      if (status === 'declined') return [`<span class="fm-chip fm-chip-danger"><i class="fa-solid fa-circle-xmark"></i>${(globalThis.PlatformLanguage?.text("signatures","m_bf5390659e3677","Declined") ?? "Declined")}</span>`];
      if (item.kind !== 'document') return [];
      if (status === 'completed') return [`<span class="fm-chip fm-chip-success"><i class="fa-solid fa-circle-check"></i>${(globalThis.PlatformLanguage?.text("signatures","m_8cb6b086a0e69c","Done") ?? "Done")}</span>`];
      const labels = { customer_signature:'Customer signature', company_signature:'Company signature', payment:'Payment', customer_response:'Customer response' };
      const waiting = Array.isArray(object(item.requirements_status).waiting_on) ? object(item.requirements_status).waiting_on : [];
      const chips = waiting.filter((key) => labels[key]).map((key) => `<span class="fm-chip"><i class="fa-solid fa-clock"></i>${esc(labels[key])}</span>`);
      if (item.sent === false && status === 'ready') chips.unshift(`<span class="fm-chip fm-chip-info"><i class="fa-solid fa-paper-plane"></i>${(globalThis.PlatformLanguage?.text("signatures","m_9fcfa20f91b853","Not sent") ?? "Not sent")}</span>`);
      return chips;
    }
    function closeSheet(){ root.querySelector('.fm-work-sheet')?.remove(); }
    function openSheet(html){
      closeSheet();
      const sheet = document.createElement('div');
      sheet.className = 'fm-work-sheet';
      sheet.innerHTML = `<div class="fm-work-sheet-panel">${html}</div>`;
      sheet.addEventListener('click', (event) => { if (event.target === sheet) closeSheet(); });
      root.appendChild(sheet);
      return sheet;
    }
    function openCancelSheet(item, { onCanceled } = {}){
      const sheet = openSheet(`
        <h4>${((v0) => globalThis.PlatformLanguage?.text("signatures","m_3199eb11d1297f",`Cancel “${v0}”?`,{v0}) ?? `Cancel “${v0}”?`)(esc(item.title || 'this work'))}</h4>
        <small>${(globalThis.PlatformLanguage?.text("signatures","m_e570dab38a72a6","The customer's link stops working immediately. The item stays in this list as canceled.") ?? "The customer's link stops working immediately. The item stays in this list as canceled.")}</small>
        <div class="fm-cancel-form">
          <label>${(globalThis.PlatformLanguage?.text("signatures","m_fa4eab36ffa898","Reason ") ?? "Reason ")}<span style="font-weight:600;color:#98a2b3">${(globalThis.PlatformLanguage?.text("signatures","m_82710819dd8da8","(optional)") ?? "(optional)")}</span></label>
          <textarea data-cancel-reason placeholder="${(globalThis.PlatformLanguage?.text("signatures","m_2c2da875072dfa","Why is this being canceled?") ?? "Why is this being canceled?")}"></textarea>
          <label class="fm-cancel-choice"><input type="radio" name="fm-cancel-visibility" value="visible" checked><span><strong>${(globalThis.PlatformLanguage?.text("signatures","m_58ca9f8d152659","Keep visible to the customer") ?? "Keep visible to the customer")}</strong><small>${(globalThis.PlatformLanguage?.text("signatures","m_609fe38989726c","The customer portal shows it as canceled.") ?? "The customer portal shows it as canceled.")}</small></span></label>
          <label class="fm-cancel-choice"><input type="radio" name="fm-cancel-visibility" value="hidden"><span><strong>${(globalThis.PlatformLanguage?.text("signatures","m_0ca52809b79e3b","Hide from the customer") ?? "Hide from the customer")}</strong><small>${(globalThis.PlatformLanguage?.text("signatures","m_3f7d5d03469573","It disappears from the customer portal entirely.") ?? "It disappears from the customer portal entirely.")}</small></span></label>
          <div class="fm-cancel-actions"><button type="button" data-cancel-dismiss>${(globalThis.PlatformLanguage?.text("signatures","m_226649e4dd2138","Keep it") ?? "Keep it")}</button><button type="button" class="is-danger" data-cancel-confirm>${(globalThis.PlatformLanguage?.text("signatures","m_20ee63ef8d3df1","Cancel work") ?? "Cancel work")}</button></div>
        </div>`);
      sheet.querySelector('[data-cancel-dismiss]')?.addEventListener('click', closeSheet);
      sheet.querySelector('[data-cancel-confirm]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await window.CrewAPI.projects.voidSignatureDocument(orgId(context), projectId(context), item.document_id, {
            reason: clean(sheet.querySelector('[data-cancel-reason]')?.value),
            customer_visibility: clean(sheet.querySelector('input[name="fm-cancel-visibility"]:checked')?.value) || 'visible'
          });
          closeSheet();
          window.PortalToast?.success?.('Work canceled.');
          if (onCanceled) await onCanceled(); else await loadList();
        } catch (error) {
          button.disabled = false;
          window.PortalToast?.error?.(error?.message || 'Could not cancel this work.');
        }
      });
    }
    /** After creating new work: choose delivery (on-device vs portal) and
     *  offer to cancel earlier work it replaces. */
    function openDeliverySheet(added){
      const replaced = items.filter((item) => item.kind === 'document'
        && clean(item.document_id) !== clean(added.document_id)
        && !['completed','canceled','skipped','declined'].includes(clean(item.status)));
      const sheet = openSheet(`
        <h4>${((v0) => globalThis.PlatformLanguage?.text("signatures","m_637eb6c5af9bc1",`“${v0}” is ready`,{v0}) ?? `“${v0}” is ready`)(esc(added.title || 'New work'))}</h4>
        <small>${(globalThis.PlatformLanguage?.text("signatures","m_b8b40bb59c4daa","How should the customer complete it?") ?? "How should the customer complete it?")}</small>
        <button type="button" class="fm-work-action" data-delivery-device><i class="fa-solid fa-mobile-alt"></i>${(globalThis.PlatformLanguage?.text("signatures","m_ecd62f5abc6beb","Open on this device now") ?? "Open on this device now")}</button>
        <button type="button" class="fm-work-action" data-delivery-portal><i class="fa-solid fa-paper-plane"></i>${(globalThis.PlatformLanguage?.text("signatures","m_9402bccd71676d","Send to the customer portal") ?? "Send to the customer portal")}</button>
        <button type="button" class="fm-work-action" data-delivery-later><i class="fa-solid fa-clock"></i>${(globalThis.PlatformLanguage?.text("signatures","m_fdcf5a3ea78fe1","Decide later") ?? "Decide later")}</button>
        ${String(replaced.length ? `<small style="margin-top:8px">Does this replace earlier work?</small>${replaced.map((item, index) => `<button type="button" class="fm-work-action is-danger" data-delivery-replace="${index}"><i class="fa-solid fa-ban"></i>Cancel “${esc(item.title || 'earlier work')}”…</button>`).join('')}` : '')}`);
      sheet.querySelector('[data-delivery-later]')?.addEventListener('click', closeSheet);
      sheet.querySelector('[data-delivery-device]')?.addEventListener('click', () => { closeSheet(); loadDocument(added.document_id); });
      sheet.querySelector('[data-delivery-portal]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await window.CrewAPI.projects.sendSignatureDocumentToPortal(orgId(context), projectId(context), added.document_id);
          closeSheet();
          window.PortalToast?.success?.('Sent to the customer portal.');
          await loadList();
        } catch (error) {
          button.disabled = false;
          window.PortalToast?.error?.(error?.message || 'Could not send this to the portal.');
        }
      });
      sheet.querySelectorAll('[data-delivery-replace]').forEach((button) => button.addEventListener('click', () => {
        const item = replaced[Number(button.dataset.deliveryReplace)];
        if (item) openCancelSheet(item);
      }));
    }
    function openManageSheet(item, { includeOpen = true, onCanceled } = {}){
      const active = item.kind === 'document' && !['completed','canceled','skipped','declined'].includes(clean(item.status));
      const sheet = openSheet(`
        <h4>${String(esc(item.title || 'Project work'))}</h4>
        ${String(includeOpen ? '<button type="button" class="fm-work-action" data-manage-open><i class="fa-solid fa-arrow-up-right-from-square"></i>Open</button>' : '')}
        ${String(active ? '<button type="button" class="fm-work-action" data-manage-portal><i class="fa-solid fa-paper-plane"></i>Send to customer portal</button>' : '')}
        ${String(active ? '<button type="button" class="fm-work-action is-danger" data-manage-cancel><i class="fa-solid fa-ban"></i>Cancel this work…</button>' : '')}
        <button type="button" class="fm-work-action" data-manage-close><i class="fa-solid fa-xmark"></i>${(globalThis.PlatformLanguage?.text("signatures","m_3742924668fb10","Close") ?? "Close")}</button>`);
      sheet.querySelector('[data-manage-close]')?.addEventListener('click', closeSheet);
      sheet.querySelector('[data-manage-open]')?.addEventListener('click', () => { closeSheet(); loadDocument(item.document_id); });
      sheet.querySelector('[data-manage-portal]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await window.CrewAPI.projects.sendSignatureDocumentToPortal(orgId(context), projectId(context), item.document_id);
          closeSheet();
          window.PortalToast?.success?.('This work is now available in the customer portal.');
          await loadList();
        } catch (error) {
          button.disabled = false;
          window.PortalToast?.error?.(error?.message || 'Could not send this to the portal.');
        }
      });
      sheet.querySelector('[data-manage-cancel]')?.addEventListener('click', () => openCancelSheet(item, { onCanceled }));
    }
    function renderList(){
      cleanup();
      detail = null;
      root.classList.remove('is-workflow');
      if (context.active !== false) context.setHeaderAction?.(canAddWork ? { label:(globalThis.PlatformLanguage?.text("signatures","m_2ebfdc1730afd2","Add Work") ?? "Add Work"), icon:'fa-plus', onClick:() => renderLibrary() } : null);
      root.innerHTML = `${items.length ? `<div class="fm-sig-list">${items.map((item, index) => {
        const openable = item.kind === 'document' && !['skipped'].includes(clean(item.status));
        const manageable = item.kind === 'document';
        const tag = openable ? 'button' : 'div';
        const icon = item.kind === 'document' ? (item.has_workflow ? 'fa-list-check' : 'fa-file-signature') : 'fa-clock';
        const chips = waitingChips(item);
        return `<${tag}${openable ? ' type="button" data-signature-document="'+esc(item.document_id)+'"' : ''} class="fm-sig-card is-${esc(item.status)}"><i class="fa-solid ${icon}"></i><span><strong>${esc(item.title || (globalThis.PlatformLanguage?.text("signatures","m_ddc7736f7b2933","Project workflow") ?? "Project workflow"))}</strong><span class="fm-workflow-meta"><span>${esc(item.scope || 'Project')}</span><span>${esc(item.trigger || '')}</span></span>${chips.length ? `<span class="fm-workflow-meta" style="margin-top:5px">${chips.join('')}</span>` : ''}</span><span class="fm-sig-card-side"><b class="fm-sig-count fm-workflow-status">${esc(item.status || 'upcoming')}</b>${manageable ? `<span class="fm-work-menu-btn" role="button" tabindex="0" aria-label="${(globalThis.PlatformLanguage?.text("signatures","m_0e74f1bca1ead4","Manage") ?? "Manage")}" data-work-menu="${String(index)}"><i class="fa-solid fa-ellipsis-vertical"></i></span>` : ''}</span></${tag}>`;
      }).join('')}</div>` : `<div class="fm-sig-empty"><div><i class="fa-solid fa-diagram-project"></i><strong>${(globalThis.PlatformLanguage?.text("signatures","m_a7bbb152d094bf","No work has been added yet.") ?? "No work has been added yet.")}</strong><p>${(globalThis.PlatformLanguage?.text("signatures","m_f9937090c41f91","Add work to start an authorized field workflow.") ?? "Add work to start an authorized field workflow.")}</p></div></div>`}`;
      root.querySelectorAll('[data-signature-document]').forEach((button) => button.addEventListener('click', () => loadDocument(button.dataset.signatureDocument)));
      root.querySelectorAll('[data-work-menu]').forEach((button) => button.addEventListener('click', (event) => {
        event.stopPropagation();
        const item = items[Number(button.dataset.workMenu)];
        if (item) openManageSheet(item, { includeOpen: item.kind === 'document' });
      }));
    }
    async function loadList(){
      loading();
      try {
        const response = await window.CrewAPI.projects.workflows(orgId(context), projectId(context));
        items = Array.isArray(response?.items) ? response.items : [];
        library = Array.isArray(response?.library) ? response.library : [];
        canAddWork = response?.can_add_work === true;
        if (!destroyed) renderList();
      } catch (error) {
        if (!destroyed) root.innerHTML = `<div class="fm-sig-empty"><div><i class="fa-solid fa-triangle-exclamation" style="color:#d92d20"></i><strong>${esc(error?.message || 'Could not load customer agreements.')}</strong></div></div>`;
      }
    }
    async function loadDocument(id, phase = ''){
      if (context.active !== false) context.setHeaderAction?.(null);
      loading('Preparing the on-site workflow…');
      try {
        detail = await window.CrewAPI.projects.signatureDocument(orgId(context), projectId(context), id);
        if (!destroyed) (phase === 'document' || !detail?.workflow ? renderDocument() : renderWorkflow());
      } catch (error) {
        if (!destroyed) root.innerHTML = `<div class="fm-sig-head"><button type="button" data-signature-back aria-label="${(globalThis.PlatformLanguage?.text("signatures","m_121372231b5699","Back") ?? "Back")}"><i class="fa-solid fa-arrow-left"></i></button><h2>${(globalThis.PlatformLanguage?.text("signatures","m_c711e170be0c5a","Customer agreement") ?? "Customer agreement")}</h2></div><div class="fm-sig-empty"><strong>${String(esc(error?.message || 'Could not open this agreement.'))}</strong></div>`;
        root.querySelector('[data-signature-back]')?.addEventListener('click', loadList);
      }
    }
    function queueParamWrite(path, value){
      const doc = object(detail?.document);
      const relative = clean(path).replace(/^params\./, '');
      setPath(doc.params = object(doc.params), relative, value);
      const topKey = relative.split('.')[0];
      saveQueue = saveQueue.then(async () => {
        const response = await window.CrewAPI.projects.updateSignatureParams(orgId(context), projectId(context), doc.id, { [topKey]:doc.params[topKey] });
        detail.document = response.document || detail.document;
        return response;
      });
      return saveQueue;
    }
    function detailItem(doc){
      const status = clean(doc.status);
      return {
        kind:'document',
        document_id: clean(doc.id),
        title: clean(doc.title),
        status: status === 'void' ? 'canceled' : status === 'declined' ? 'declined' : ['signed','completed'].includes(status) ? 'completed' : 'ready'
      };
    }
    function renderWorkflow(){
      cleanup();
      if (context.active !== false) context.setHeaderAction?.(null);
      root.classList.add('is-workflow');
      const doc = object(detail?.document);
      const flow = object(detail?.workflow);
      root.innerHTML = `<div class="fm-sig-head"><button type="button" data-signature-back aria-label="${(globalThis.PlatformLanguage?.text("signatures","m_121372231b5699","Back") ?? "Back")}"><i class="fa-solid fa-arrow-left"></i></button><h2>${String(esc(doc.title || 'On-site quote'))}</h2><button type="button" data-detail-menu aria-label="${(globalThis.PlatformLanguage?.text("signatures","m_a0c3b163769e12","Manage this work") ?? "Manage this work")}" style="margin-left:auto"><i class="fa-solid fa-ellipsis-vertical"></i></button></div><div class="fm-field-workflow" data-field-workflow></div>`;
      root.querySelector('[data-signature-back]')?.addEventListener('click', loadList);
      root.querySelector('[data-detail-menu]')?.addEventListener('click', () => openManageSheet(detailItem(doc), { includeOpen:false, onCanceled: loadList }));
      const host = root.querySelector('[data-field-workflow]');
      if (!host || !window.FMDocWorkflow?.mount) return;
      workflow = window.FMDocWorkflow.mount(host, {
        workflow: flow.definition,
        audience: clean(flow.audience || 'field'),
        showWorkflowTitle: false,
        contract: flow.contract,
        state: { params:object(doc.params), outputs:object(doc.outputs), ...object(flow.state) },
        scope: { ...(object(detail.scope)), sources:object(flow.sources) },
        services: { api:{} },
        labels: { finish:'Review agreement' },
        onWrite: (path, value) => {
          if (clean(path).startsWith('params.')) void queueParamWrite(path, value).catch((error) => window.PortalToast?.error?.(error?.message || 'Could not save the quote.'));
        },
        onStepState: (state) => { void window.CrewAPI.projects.updateSignatureWorkflow(orgId(context), projectId(context), doc.id, state).catch(() => null); },
        onComplete: async () => {
          await saveQueue;
          if (clean(flow.audience) === 'field' && Array.isArray(flow.customer_definition?.steps) && flow.customer_definition.steps.length) {
            flow.definition = flow.customer_definition;
            flow.audience = 'customer';
            renderWorkflow();
            return;
          }
          if (clean(object(doc.metadata).customer_presentation?.mode) === 'workflow') {
            window.PortalToast?.success?.('Customer workflow completed.');
            await loadList();
            return;
          }
          await loadDocument(doc.id, 'document');
        }
      });
    }
    function paymentMethod(payload){
      const method = clean(payload?.method || payload?.savedMethodId).toLowerCase();
      if (method === 'ach') return { kind:'ach', processor:'demo_field_checkout', last4:clean(payload?.accountLast4).slice(-4) };
      return { kind:'card', processor:'demo_field_checkout', brand:'Visa', last4:clean(payload?.fields?.cardNumber).replace(/\D/g,'').slice(-4) || '4242' };
    }
    // ── Provider payment intake (org-scoped, same resolution as the staff
    // Money take-payment mount). Cached per mount; best-effort — any failure
    // (or no configured provider) resolves null and the on-site checkout
    // keeps the legacy demo flow byte-identical.
    let intakeConfigEntry; // undefined = unresolved, otherwise { config }
    async function resolveIntakeConfig(){
      if (intakeConfigEntry !== undefined) return intakeConfigEntry.config;
      let config = null;
      try {
        if (window.PaymentsAPI?.intake?.config) {
          const contact = (Array.isArray(context.project?.contacts) ? context.project.contacts : []).find((entry) => entry && (entry.primary || entry.id || entry.email)) || null;
          const result = await window.PaymentsAPI.intake.config(orgId(context), {
            contact_ref: clean(contact?.id || contact?.contact_id || String(contact?.email || '').toLowerCase())
          });
          config = result?.provider ? result : null;
        }
      } catch (_) { config = null; }
      intakeConfigEntry = { config };
      return config;
    }
    function providerIntakeOptions(config){
      if (!config || !config.provider) return {};
      // No surcharge options on purpose: the document's own pricing carries
      // any processing-fee rows and the server validates the exact amount.
      return {
        savedMethods: Array.isArray(config.saved_methods) ? config.saved_methods : [],
        tokenization: {
          mode: clean(config.tokenization?.mode) || 'mock',
          sdkUrl: clean(config.tokenization?.sdk_url),
          createPaymentMethod: (request) => window.PaymentsAPI.intake.createPaymentMethodIntent(orgId(context), request)
        }
      };
    }
    function tokenizedMethod(payload){
      return {
        kind: clean(payload?.method).toLowerCase() === 'ach' ? 'ach' : 'card',
        ...(clean(payload?.brand) ? { brand:clean(payload.brand) } : {}),
        ...(clean(payload?.last4) ? { last4:clean(payload.last4) } : {})
      };
    }
    function openPayment(doc, options = {}){
      return new Promise((resolve, reject) => {
        const amount = Number(options.amountCents || 0);
        const openModal = (config) => window.FirstMatePaymentIntake.open({
          ...providerIntakeOptions(config),
          title: options.title || (globalThis.PlatformLanguage?.text("signatures","m_7d7defd098e64b","Pay on site") ?? "Pay on site"), description:options.description || 'Complete payment securely on this device.', amountLabel:'Amount due', amountCents:amount, allowCustomAmount:false,
          methods:['card','ach'], submitLabel:'Pay', successTitle:'Payment received', successDescription:'The payment is recorded on this project.',
          onSubmit: async (payload) => {
            try {
              // Tokenized submissions carry the provider token; the server
              // charges through the processor before recording the output.
              // Without a token the request body is byte-identical to legacy.
              const tokenized = !!(clean(payload?.payment_method_id) || clean(payload?.saved_method_id));
              const result = await window.CrewAPI.projects.paySignatureDocument(orgId(context), projectId(context), doc.id, options.outputKey || 'payment', {
                amount_cents:payload.amountCents,
                method: tokenized ? tokenizedMethod(payload) : paymentMethod(payload),
                evidence:evidence(),
                ...(tokenized ? {
                  ...(clean(payload.payment_method_id) ? { payment_method_id:clean(payload.payment_method_id) } : {}),
                  ...(clean(payload.saved_method_id) ? { saved_method_id:clean(payload.saved_method_id) } : {}),
                  save_payment_method: payload.save_method === true
                } : {})
              });
              if (tokenized) intakeConfigEntry = undefined; // saved cards may have changed
              detail.document = result.document || detail.document;
              resolve(result); return result;
            } catch (error) { reject(error); throw error; }
          },
          onSuccess: async () => { await loadDocument(doc.id, 'document'); }
        });
        resolveIntakeConfig().then(openModal, () => openModal(null));
      });
    }
    function renderDocument(){
      cleanup();
      if (context.active !== false) context.setHeaderAction?.(null);
      root.classList.remove('is-workflow');
      const doc = object(detail?.document);
      root.innerHTML = `<div class="fm-sig-head"><button type="button" data-signature-back aria-label="${(globalThis.PlatformLanguage?.text("signatures","m_121372231b5699","Back") ?? "Back")}"><i class="fa-solid fa-arrow-left"></i></button><h2>${String(esc(doc.title || 'Customer agreement'))}</h2><button type="button" data-detail-menu aria-label="${(globalThis.PlatformLanguage?.text("signatures","m_a0c3b163769e12","Manage this work") ?? "Manage this work")}" style="margin-left:auto"><i class="fa-solid fa-ellipsis-vertical"></i></button></div><div class="fm-doc-handoff"><i class="fa-solid fa-circle-check"></i><span>${String(detail?.workflow ? 'Workflow prepared. Complete it on this device or send it to the customer portal.' : 'Complete this document on this device or send it to the customer portal.')}</span><span class="fm-doc-actions">${String(detail?.workflow ? '<button type="button" class="fm-doc-edit" data-edit-workflow>Edit</button>' : '')}<button type="button" class="fm-doc-portal" data-send-portal>${(globalThis.PlatformLanguage?.text("signatures","m_649dd47ec9c618","Send to portal") ?? "Send to portal")}</button></span></div><div class="fm-sig-stage" data-signature-stage></div>`;
      root.querySelector('[data-signature-back]')?.addEventListener('click', loadList);
      root.querySelector('[data-detail-menu]')?.addEventListener('click', () => openManageSheet(detailItem(doc), { includeOpen:false, onCanceled: loadList }));
      root.querySelector('[data-edit-workflow]')?.addEventListener('click', renderWorkflow);
      root.querySelector('[data-send-portal]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await window.CrewAPI.projects.sendSignatureDocumentToPortal(orgId(context), projectId(context), doc.id);
          button.textContent = (globalThis.PlatformLanguage?.text("signatures","m_962095051f86a1","Sent to portal") ?? "Sent to portal");
          window.PortalToast?.success?.('This workflow is now available in the customer portal.');
        } catch (error) {
          button.disabled = false;
          window.PortalToast?.error?.(error?.message || 'Could not send this workflow to the portal.');
        }
      });
      const stage = root.querySelector('[data-signature-stage]');
      const definition = detail?.resolved_definition;
      if (!stage || !definition || !window.FMDocRenderer || !window.FMDocModel) return;
      const paper = window.FMDocModel.paperDimensions(definition);
      const width = Math.max(280, stage.clientWidth - 16);
      const scale = Math.min(1, width / (paper.w_pt * (96 / 72)));
      renderer = window.FMDocRenderer.render(stage, {
        document:definition, theme:detail.theme || null, themeContext:{ overrides:detail.theme_vars || {} }, mode:'interactive', widgetData:detail.widget_data || {}, scale,
        widgetContext: {
          outputs:object(doc.outputs),
          api:{ openPayment:(options) => openPayment(doc, options) },
          submitOutput:async (key, value) => {
            await window.CrewAPI.projects.recordSignature(orgId(context), projectId(context), doc.id, key, { value, evidence:evidence() });
            await loadDocument(doc.id, 'document');
            return true;
          }
        }
      });
      try { window.FMDocWidgets?.installLightboxDelegate?.(); } catch (_) {}
    }
    void loadList();
    return {
      activate(nextContext = {}){ context = { ...context, ...nextContext, active:true }; if (!detail) context.setHeaderAction?.(canAddWork ? { label:(globalThis.PlatformLanguage?.text("signatures","m_2ebfdc1730afd2","Add Work") ?? "Add Work"), icon:'fa-plus', onClick:() => renderLibrary() } : null); },
      deactivate(){ context.active = false; },
      destroy(){ destroyed = true; cleanup(); style.remove(); root.innerHTML = ''; }
    };
  }

  runtime.registerApp({
    id:'project.crew_signatures', package:'signatures', kind:'project_modal_app', title:(globalThis.PlatformLanguage?.text("signatures","m_9acd909e2fe732","Project work") ?? "Project work"), label:(globalThis.PlatformLanguage?.text("signatures","m_222066ef57ae0e","Work") ?? "Work"), icon:'fa-diagram-project', order:70,
    visible:true,
    surfaces:['project_modal'], regions:['main'], requiresContext:['project'], access, presentation, panelHtml:panel, mount
  });
})();
