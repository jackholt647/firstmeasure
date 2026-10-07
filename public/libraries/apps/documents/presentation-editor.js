/**
 * Opens a presentation module's layout in the presentation editor.
 *
 *   const result = await FMPresentationEditorHost.open({ orgId, moduleId });
 *   // -> { saved, module } once the editor is closed
 *
 * The layout is the module definition's `renderer` (a paged DocModel). Save
 * publishes the whole definition again with the edited layout, as a new
 * version of the same module, through /v1/document-modules (see
 * docs/architecture/presentation-modules.md). Publishing needs
 * manage_company_settings; the server decides.
 */
(function (global) {
  'use strict';

  const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const text = (value) => String(value ?? '').trim();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STYLE_ID = 'fm-presentation-editor-host-styles';
  const CSS = `
.fmpeh{position:fixed;inset:0;z-index:9000;display:flex;flex-direction:column;background:#f4f6f8;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.fmpeh-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.fmpeh-wait{margin:auto;display:flex;align-items:center;gap:10px;color:#475467;font-size:13px;font-weight:600}
.fmpeh-wait button{height:30px;padding:0 12px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font:inherit;cursor:pointer}
.fmpeh-ask{position:absolute;inset:0;z-index:9600;display:grid;place-items:center;background:rgba(16,24,40,.42)}
.fmpeh-ask>div{width:min(400px,calc(100vw - 32px));padding:20px;border-radius:14px;background:#fff;box-shadow:0 24px 60px rgba(16,24,40,.28);color:#101828}
.fmpeh-ask h2{margin:0 0 6px;font-size:16px;font-weight:800}
.fmpeh-ask p{margin:0 0 16px;color:#475467;font-size:13px;line-height:1.45}
.fmpeh-ask footer{display:flex;justify-content:flex-end;gap:8px}
.fmpeh-ask button{height:34px;padding:0 14px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font:700 12.5px/1 inherit;cursor:pointer}
.fmpeh-ask button.danger{color:#b42318;border-color:#fecdca}
.fmpeh-ask button.primary{border-color:var(--primary,#2563eb);background:var(--primary,#2563eb);color:#fff}
`;
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /** The document-modules API for one organization (the same base program-panel.js derives). */
  function moduleRequest(orgId) {
    const api = global.PlatformAPI;
    const base = new URL(api.baseUrl().replace(/\/platform\/?$/, '/document-modules'), location.href).href.replace(/\/$/, '');
    return (path, method = 'GET', body) => api.request(`${base}/organizations/${encodeURIComponent(orgId)}${path}`, { method, ...(body === undefined ? {} : { body }) });
  }
  const toast = (message, ok) => { try { global.Portal?.ui?.showToast?.('Presentation', message, ok !== false); } catch (e) { /* no portal chrome */ } };

  let active = null;

  /**
   * options: { orgId, moduleId, container?, request?, scope?, sampleState?, priceSample?, onSaved?(module) }
   * `request(path, method, body)` replaces the default API client (tests, other hosts).
   */
  function open(options) {
    const opts = obj(options);
    const orgId = text(opts.orgId) || text(global.Portal?.cfg?.userOrgId) || text(global.__APP?.userOrgId);
    const moduleId = text(opts.moduleId);
    if (!moduleId) return Promise.reject(new Error('FMPresentationEditorHost.open: moduleId required'));
    if (!global.FMPresentationEditor) return Promise.reject(new Error('The presentation editor is not loaded.'));
    if (active) return active.done;
    ensureStyles();
    const request = typeof opts.request === 'function' ? opts.request : moduleRequest(orgId);
    const overlay = document.createElement('div');
    overlay.className = 'fmpeh';
    overlay.setAttribute('data-fm-presentation-editor', moduleId);
    overlay.innerHTML = '<div class="fmpeh-body"><div class="fmpeh-wait" role="status">Opening the presentation…</div></div>';
    (opts.container || document.body).appendChild(overlay);
    const body = overlay.firstChild;

    let editor = null;
    let definition = null;
    let published = null;
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const beforeUnload = (event) => { if (editor && editor.isDirty()) { event.preventDefault(); event.returnValue = ''; } };
    const finish = () => {
      global.removeEventListener('beforeunload', beforeUnload);
      try { editor?.destroy(); } catch (e) { /* already gone */ }
      overlay.remove();
      active = null;
      settle({ saved: !!published, module: published });
    };
    /** Publish the definition with the edited layout as a new version of this module. */
    const save = async (layout) => {
      const response = await request('/presentation-modules', 'POST', { moduleId, definition: { ...definition, renderer: layout } });
      published = obj(response).module || published || {};
      definition = { ...definition, renderer: layout };
      editor?.markSaved();
      toast('Saved as a new version. Presentations started from now on use it.', true);
      try { opts.onSaved?.(published); } catch (e) { /* host callback */ }
    };
    const close = () => {
      if (!editor || !editor.isDirty()) { finish(); return; }
      const ask = document.createElement('div');
      ask.className = 'fmpeh-ask';
      ask.innerHTML = `<div role="alertdialog" aria-modal="true" aria-labelledby="fmpeh-ask-title"><h2 id="fmpeh-ask-title">Save your changes?</h2><p>${esc(text(definition.name) || 'This presentation')} has changes that are not saved yet.</p>
        <footer><button type="button" class="danger" data-fmpeh="discard">Discard</button><button type="button" data-fmpeh="stay">Keep editing</button><button type="button" class="primary" data-fmpeh="save">Save and close</button></footer></div>`;
      ask.addEventListener('click', async (event) => {
        const choice = event.target.closest('[data-fmpeh]')?.dataset.fmpeh;
        if (!choice) return;
        if (choice === 'save') {
          try { await save(editor.getDocument()); } catch (error) { ask.remove(); toast(text(obj(error).message) || 'Could not save.', false); return; }
        }
        ask.remove();
        if (choice !== 'stay') finish();
      });
      body.appendChild(ask);
      ask.querySelector('[data-fmpeh="save"]').focus();
    };

    active = { done, close };
    global.addEventListener('beforeunload', beforeUnload);
    Promise.resolve().then(() => request(`/modules/${encodeURIComponent(moduleId)}`)).then((response) => {
      definition = obj(obj(obj(response).module).definition);
      const layout = obj(definition.renderer);
      if (definition.kind !== 'presentation' || !Array.isArray(layout.pages)) throw new Error('This module is not a slide presentation.');
      body.innerHTML = '';
      editor = global.FMPresentationEditor.mount(body, {
        document: layout,
        themeContext: { branding: obj(global.__APP?.orgBranding || global.Portal?.cfg?.branding) },
        media: global.PlatformAPI?.media?.fileUrl ? { url: (ref, variant) => { const media = typeof ref === 'string' ? { media_id: ref } : obj(ref); return media.url || (text(media.media_id || media.id) ? global.PlatformAPI.media.fileUrl(orgId, text(media.media_id || media.id), variant || media.variant || 'original') : ''); } } : undefined,
        scope: opts.scope, sampleState: opts.sampleState, priceSample: opts.priceSample,
        chrome: { orgId },
        onSave: save,
        onClose: close
      });
    }).catch((error) => {
      body.innerHTML = `<div class="fmpeh-wait" role="alert"><span>${esc(text(obj(error).message) || 'The presentation could not be opened.')}</span><button type="button">Close</button></div>`;
      body.querySelector('button').addEventListener('click', finish);
    });
    return done;
  }

  global.FMPresentationEditorHost = { open, close() { active?.close(); }, isOpen: () => !!active };
})(window);
