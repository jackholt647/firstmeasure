/* libraries/forms-staff/forms-staff.js
 * Staff entry (docs/architecture/forms.md, "Staff entry"): a published form an organization offers in
 * the New menu, filled in by a signed-in person for a caller or walk-in. The form renders with the
 * public renderer (libraries/forms-embed) over a transport that calls the authenticated staff routes,
 * so its blocks, conditions, booking and field mapping are the website form's own. Saving makes the
 * lead through receiveLead, recorded as entered by that person; the lead then opens.
 *
 *   FirstMateStaffForms.list(orgId)   // [{ id, name, label, branch_id, features }], cached briefly
 *   FirstMateStaffForms.open(formId)  // the form in a modal
 */
(function(){
  const root = window;
  if (root.FirstMateStaffForms) return;
  const SCRIPT_SRC = document.currentScript?.src || '';
  const clean = (value) => String(value ?? '').trim();
  const esc = (value) => clean(value).replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
  const orgId = () => clean(root.__APP?.userOrgId || root.__APP?.orgId);
  const api = () => root.FormsAPI?.staff;
  const toast = (message, kind = 'success') => root.Portal?.ui?.showToast?.(message, kind);

  let cache = { org: '', at: 0, forms: [], pending: null };
  /** Forms this person is offered. Anyone who may not create projects is offered none. */
  function list(org = orgId(), options = {}){
    if (!org || !api()) return Promise.resolve([]);
    if (!options.fresh && cache.org === org && Date.now() - cache.at < 60_000) return Promise.resolve(cache.forms);
    if (cache.pending && cache.org === org) return cache.pending;
    cache.org = org;
    cache.pending = api().list(org).then((forms) => {
      cache = { org, at: Date.now(), forms: Array.isArray(forms) ? forms : [], pending: null };
      return cache.forms;
    }).catch(() => { cache = { org, at: Date.now(), forms: [], pending: null }; return []; });
    return cache.pending;
  }
  const cached = () => cache.org === orgId() ? cache.forms : [];

  let renderer = null;
  function loadRenderer(){
    if (root.FirstMateForms?.render) return Promise.resolve(root.FirstMateForms);
    if (renderer) return renderer;
    renderer = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let src = '/libraries/forms-embed/firstmate-forms-embed.js';
      try { src = new URL('../forms-embed/firstmate-forms-embed.js', SCRIPT_SRC || location.href).href; } catch {}
      script.src = src;
      // The renderer mounts itself only for a tag that names a form; this one names none.
      script.dataset.auto = 'false';
      script.onload = () => root.FirstMateForms?.render ? resolve(root.FirstMateForms) : reject(new Error('The form renderer did not load.'));
      script.onerror = () => { renderer = null; reject(new Error('The form renderer could not be loaded.')); };
      document.head.appendChild(script);
    });
    return renderer;
  }

  function transport(org, formId){
    const staff = api();
    return {
      load: () => staff.get(org, formId),
      availability: (item, date, address) => staff.availability(org, formId, { item_id: item.id, date, ...(address ? { address } : {}) }),
      measure: (item, address) => staff.measurement(org, formId, { item_id: item.id, address }),
      submit: (payload) => {
        const { page_url: _page, referrer: _referrer, website_url: _honeypot, ...body } = payload || {};
        return staff.submit(org, formId, body);
      }
    };
  }

  function ensureStyles(){
    if (document.getElementById('fm-staff-form-styles')) return;
    const style = document.createElement('style');
    style.id = 'fm-staff-form-styles';
    style.textContent = `
      .fm-staff-form{position:fixed;inset:0;z-index:2147482000;display:grid;place-items:center;background:rgba(15,23,42,.55);padding:16px}
      .fm-staff-form-shell{width:min(720px,100%);max-height:calc(100vh - 32px);display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:#fff;border-radius:12px;box-shadow:0 24px 80px rgba(15,23,42,.3);color:#101828;overflow:hidden}
      .fm-staff-form-head{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #eaecf0}
      .fm-staff-form-head h2{margin:0;font-size:17px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fm-staff-form-close{border:0;background:transparent;width:34px;height:34px;border-radius:8px;cursor:pointer;color:#475467;font-size:16px}
      .fm-staff-form-close:hover{background:#f2f4f7}
      .fm-staff-form-body{overflow:auto;padding:4px 4px 8px}
      .fm-staff-form-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #eaecf0}
      .fm-staff-form-foot[hidden]{display:none}
      .fm-staff-form-btn{height:36px;padding:0 14px;border-radius:8px;border:1px solid #d0d5dd;background:#fff;font:inherit;font-weight:700;cursor:pointer;color:#101828}
      .fm-staff-form-btn.primary{background:var(--primary,#111827);border-color:var(--primary,#111827);color:var(--on-primary,#fff)}
      @media(max-width:600px){.fm-staff-form{padding:0}.fm-staff-form-shell{max-height:100vh;height:100%;border-radius:0}}`;
    document.head.appendChild(style);
  }

  async function open(formId, options = {}){
    const org = orgId();
    if (!org || !api()) { toast('Forms are not available here.', 'error'); return null; }
    const entry = cached().find((form) => form.id === formId) || {};
    ensureStyles();
    const modal = document.createElement('div');
    modal.className = 'fm-staff-form';
    modal.dataset.staffForm = formId;
    modal.innerHTML = `<div class="fm-staff-form-shell" role="dialog" aria-modal="true" aria-label="${esc(options.label || entry.label || 'New lead')}">
        <div class="fm-staff-form-head"><h2>${esc(options.label || entry.label || entry.name || 'New lead')}</h2><button type="button" class="fm-staff-form-close" data-staff-form-close aria-label="Close"><i class="fas fa-xmark" aria-hidden="true"></i></button></div>
        <div class="fm-staff-form-body"><div data-staff-form-mount></div></div>
        <div class="fm-staff-form-foot" data-staff-form-done hidden><button type="button" class="fm-staff-form-btn" data-staff-form-again>Enter another</button><button type="button" class="fm-staff-form-btn primary" data-staff-form-open>Open the lead</button></div>
      </div>`;
    document.body.appendChild(modal);
    let controller = null;
    const remove = () => { controller?.destroy?.(); modal.remove(); };
    const handle = root.Portal?.modals?.register?.(modal, { id: `staff-form-${formId}`, closeOnBackdrop: false, onClose: remove });
    const close = () => (handle?.close ? handle.close('close') : remove());
    modal.querySelector('[data-staff-form-close]').addEventListener('click', close);
    if (!handle) modal.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
    const mount = modal.querySelector('[data-staff-form-mount]');
    const done = modal.querySelector('[data-staff-form-done]');
    let projectId = '';
    mount.addEventListener('fm-form:submitted', (event) => {
      projectId = clean(event.detail?.project_id);
      done.hidden = !projectId;
      toast('Lead saved.');
      root.dispatchEvent(new CustomEvent('fm:lead-created', { detail: { project_id: projectId, form_id: formId } }));
    });
    modal.querySelector('[data-staff-form-again]').addEventListener('click', () => { done.hidden = true; projectId = ''; controller?.reset?.(); });
    modal.querySelector('[data-staff-form-open]').addEventListener('click', () => {
      if (!projectId) return;
      const id = projectId;
      close();
      if (root.FirstMateProjectWindows?.open) root.FirstMateProjectWindows.open(id);
      else root.Portal?.modules?.projects?.open?.(id);
    });
    try {
      const forms = await loadRenderer();
      controller = forms.render({ key: formId, target: mount, transport: transport(org, formId) });
      await controller.ready;
    } catch (error) {
      mount.innerHTML = `<p style="padding:16px;color:#b42318">${esc(error?.message || 'This form could not be loaded.')}</p>`;
    }
    return { close, modal };
  }

  root.addEventListener('fm:app-flags:updated', () => { cache.at = 0; });
  root.FirstMateStaffForms = { list, cached, open };
})();
