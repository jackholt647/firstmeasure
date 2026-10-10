const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dividers = new WeakMap();
const scopeTypes = new Set(['proposal','estimate','quote','contract','subcontract','amendment','change_order','contractor_change_order','work_order','scope_of_work','scope']);

export function definesScope(doc) {
  const type = String(doc.document_type || doc.type || '').toLowerCase().replace(/[ -]+/g, '_');
  return !['archived','void','voided'].includes(doc.status) && (scopeTypes.has(type) || /(?:^|_)(proposal|estimate|contract|change_order)(?:_|$)/.test(type)
    || doc.metadata?.defines_scope === true || !!doc.content?.scope || !!doc.scope
    || !!doc.definition?.deliverables?.length || !!doc.definition?.scope);
}

export async function loadDocuments(orgId, projectId) {
  const api = window.PlatformAPI;
  const base = api.baseUrl().replace(/\/platform\/?$/, '');
  const org = encodeURIComponent(orgId), project = encodeURIComponent(projectId);
  const results = await Promise.allSettled([
    api.request(`${base}/documents/organizations/${org}/projects/${project}/documents`),
    api.request(`${base}/document-modules/organizations/${org}/instances?projectId=${project}`)
  ]);
  const documents = [];
  if (results[0].status === 'fulfilled') {
    for (const doc of results[0].value.documents || results[0].value.items || []) {
      if (definesScope(doc)) documents.push({...doc, source:'document'});
    }
  }
  if (results[1].status === 'fulfilled') {
    for (const instance of results[1].value.instances || []) {
      if (!['archived','void'].includes(instance.status)) documents.push({...instance,
        title:instance.title || instance.name || instance.moduleId, source:'module'});
    }
  }
  for (const doc of documents) {
    const mediaId = doc.preview_media_ref?.media_id || doc.preview_media_ref?.id || doc.pdf?.latest_media_id;
    if (mediaId) doc.thumbnail = api.media?.thumbnailUrl?.(orgId, mediaId, 320);
  }
  return {documents, error:results.some(result => result.status === 'rejected') ? 'Some scope documents could not load.' : ''};
}

export function renderDocuments(documents = [], error = '') {
  return `<section class="mt-scope-documents" aria-label="Scope documents"><div class="mt-scope-document-strip">${documents.map(doc => `<button type="button" class="mt-scope-document" data-scope-document="${esc(doc.id)}" data-scope-source="${esc(doc.source)}" data-scope-module="${esc(doc.moduleId || '')}" title="Open ${esc(doc.title || doc.name || 'Scope document')}">
    <span class="mt-scope-document-sheet">${doc.thumbnail ? `<img src="${esc(doc.thumbnail)}" alt="" loading="lazy">` : `<i class="fas ${doc.source === 'module' ? 'fa-diagram-project' : 'fa-file-signature'}"></i><strong>${esc(doc.title || doc.name || 'Scope document')}</strong><hr><hr><hr>`}</span>
    <strong>${esc(doc.title || doc.name || 'Scope document')}</strong><small>${esc(doc.status || doc.kind || doc.document_type || 'Document')}</small></button>`).join('') || `<span class="mt-small">${error ? '' : 'No scope documents yet'}</span>`}</div>${error ? `<p class="mt-small" role="status">${esc(error)}</p>` : ''}</section>`;
}

export function bindDocuments(root, orgId, projectId) {
  root.querySelectorAll('.mt-scope-document-sheet img').forEach(image => {
    const fallback = () => { if (image.parentElement) image.parentElement.innerHTML = '<i class="fas fa-file-signature"></i><hr><hr><hr>'; };
    image.addEventListener('error', fallback, {once:true});
    if (image.complete && !image.naturalWidth) fallback();
  });
  root.querySelectorAll('[data-scope-document]').forEach(button => button.addEventListener('click', async () => {
    if (button.dataset.scopeSource === 'module') {
      button.disabled = true;
      try {
        const {openModuleInstances} = await import('../documents/program-panel.js');
        await openModuleInstances(orgId, projectId, button.dataset.scopeModule, button.dataset.scopeDocument);
      } catch (error) {
        const status = root.querySelector('.mt-scope-documents [role="status"]') || document.createElement('p');
        status.className = 'mt-small'; status.setAttribute('role', 'status');
        status.textContent = error?.message || 'This document module could not open.';
        root.querySelector('.mt-scope-documents')?.append(status);
      } finally { button.disabled = false; }
    } else {
      window.Portal?.navigation?.push?.({project:projectId, projectTab:'docs', document:button.dataset.scopeDocument}, {source:'scope-document'});
    }
  }));
}

export function installDivider(sidebar) {
  const parent = sidebar?.parentElement;
  if (!parent || dividers.has(sidebar)) return;
  const divider = document.createElement('button');
  divider.className = 'mt-scope-divider';
  divider.type = 'button';
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', 'Resize project widgets and scope of work');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-valuemin', '20');
  divider.setAttribute('aria-valuemax', '65');
  let ratio = 100 / 3;
  try { ratio = Number(localStorage.getItem('firstmate.scope.widgetWidth')) || ratio; } catch {}
  const set = value => {
    ratio = Math.min(65, Math.max(20, value));
    sidebar.style.setProperty('--scope-sidebar-width', `${ratio}%`);
    divider.setAttribute('aria-valuenow', String(Math.round(ratio)));
  };
  const save = () => { try { localStorage.setItem('firstmate.scope.widgetWidth', String(ratio)); } catch {} };
  set(ratio);
  let dragging = false;
  divider.addEventListener('pointerdown', event => { dragging = true; divider.setPointerCapture(event.pointerId); event.preventDefault(); });
  divider.addEventListener('pointermove', event => {
    if (!dragging) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width) set((event.clientX - rect.left) / rect.width * 100);
  });
  const stop = () => { if (dragging) { dragging = false; save(); window.dispatchEvent(new Event('resize')); } };
  divider.addEventListener('pointerup', stop);
  divider.addEventListener('pointercancel', stop);
  divider.addEventListener('lostpointercapture', stop);
  divider.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    set(event.key === 'Home' ? 20 : event.key === 'End' ? 65 : ratio + (event.key === 'ArrowRight' ? 2 : -2));
    save(); window.dispatchEvent(new Event('resize'));
  });
  sidebar.after(divider);
  dividers.set(sidebar, divider);
}

export function removeDivider(sidebar) {
  dividers.get(sidebar)?.remove();
  if (sidebar) dividers.delete(sidebar);
}
