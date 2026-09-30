const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const request = (org, path = '', method = 'GET', body) => {
  const options = { method, ...(body === undefined ? {} : { body }) };
  const resource = `/organizations/${encodeURIComponent(org)}/tags${path}`;
  if (window.DocumentsAPI?.request) return window.DocumentsAPI.request(resource, options);
  const base = new URL(window.PlatformAPI.baseUrl().replace(/\/platform\/?$/, '/documents'), location.href).href.replace(/\/$/, '');
  return window.PlatformAPI.request(`${base}${resource}`, options);
};

/** Shared picker for templates, workflows, modules and document instances. */
export async function openTagManager(org, options = {}) {
  const selected = new Set(options.tags || []);
  const picker = typeof options.save === 'function';
  const dialog = document.createElement('dialog');
  dialog.style.cssText = 'width:min(560px,92vw);max-height:85vh;overflow:auto;border:1px solid #dce1e8;border-radius:18px;padding:24px;background:var(--surface,#fff);color:inherit';
  dialog.className='fmdx-tag-manager';
  dialog.setAttribute('aria-labelledby','fmdx-tag-manager-title');
  const styles=document.createElement('style'); styles.textContent='.fmdx-tag-manager{font:14px system-ui;box-shadow:0 24px 80px #0f172a30}.fmdx-tag-manager::backdrop{background:#0f172a66}.fmdx-tag-manager h2{font-size:22px;margin:0 0 12px}.fmdx-tag-manager p{color:#64748b;line-height:1.55}.fmdx-tag-manager button,.fmdx-tag-manager input:not([type=checkbox]){font:inherit;padding:8px 12px;border:1px solid #cbd5e1;border-radius:9px;background:white;color:#1e293b}.fmdx-tag-manager button{cursor:pointer}.fmdx-tag-manager [data-save]{background:#2563eb;color:white;border-color:#2563eb}.fmdx-tag-manager [data-status]{color:#b91c1c}.fmdx-tag-manager input[type=checkbox]{width:18px;height:18px;accent-color:#2563eb}'; document.head.append(styles);
  dialog.addEventListener('close', () => { dialog.remove(); styles.remove(); }, { once:true });
  let tags = [];
  const status = text => { const target=dialog.querySelector('[data-status]'); if(target) target.textContent=text; };
  const run = task => async () => { try { await task(); } catch (error) { status(error.message || 'Could not save tags.'); } };
  function render() {
    dialog.innerHTML = `<form method="dialog"><button style="float:right" aria-label="Close tag manager">Close</button></form><h2>${picker ? 'Document tags' : 'Tag manager'}</h2><p>${picker ? 'Choose all tags that apply. New documents inherit their template and workflow tags.' : 'Rename labels or archive tags. Stable tag keys, existing assignments and notification rules are preserved.'}</p><div data-status role="status"></div><div data-list style="display:grid;gap:10px;margin:18px 0">${tags.filter(t => !picker || !t.archived || selected.has(t.id)).map(t => `<div style="display:flex;gap:10px;align-items:center">${picker ? `<input type="checkbox" aria-label="${esc(t.label)}" data-tag="${esc(t.id)}" ${selected.has(t.id) ? 'checked' : ''}>` : ''}<span style="flex:1">${esc(t.label)}${t.archived ? ' (archived)' : ''}<small style="display:block;color:#64748b">${esc(t.id)}</small></span>${picker ? '' : `<button data-rename="${esc(t.id)}">Rename</button><button data-archive="${esc(t.id)}">${t.archived ? 'Restore' : 'Archive'}</button>`}</div>`).join('') || '<p>No tags yet. Add one below.</p>'}</div><form data-new style="display:flex;gap:8px"><input name="label" aria-label="New tag name" maxlength="80" required placeholder="New tag name" style="flex:1"><button>Add tag</button></form>${picker ? '<button data-save style="margin-top:20px">Save tags</button>' : ''}`;
    dialog.querySelectorAll('[data-tag]').forEach(el => el.onchange = () => el.checked ? selected.add(el.dataset.tag) : selected.delete(el.dataset.tag));
    dialog.querySelector('[data-new]').onsubmit = event => { event.preventDefault(); run(async () => { const { tag } = await request(org,'','POST',{ label:new FormData(event.target).get('label') }); selected.add(tag.id); await load(); })(); };
    dialog.querySelectorAll('[data-archive]').forEach(el => el.onclick = run(async () => { const t = tags.find(t => t.id === el.dataset.archive); await request(org,`/${encodeURIComponent(t.id)}`,'PATCH',{ archived:!t.archived, expected_revision:t.revision }); await load(); }));
    dialog.querySelectorAll('[data-rename]').forEach(el => el.onclick = () => {
      const t = tags.find(t => t.id === el.dataset.rename); const input = document.createElement('input'); input.value=t.label; input.maxLength=80; input.setAttribute('aria-label','Tag label'); el.before(input); el.textContent='Save'; el.onclick=run(async () => { await request(org,`/${encodeURIComponent(t.id)}`,'PATCH',{ label:input.value, expected_revision:t.revision }); await load(); }); input.focus();
    });
    dialog.querySelector('[data-save]')?.addEventListener('click', run(async () => { await options.save([...selected]); dialog.close(); }));
  }
  async function load() { ({ tags } = await request(org)); if(!dialog.isConnected) return; for (const id of selected) if (!tags.some(t => t.id === id)) tags.push({ id,label:id,revision:0 }); render(); dialog.querySelector('h2')?.setAttribute('id','fmdx-tag-manager-title'); }
  dialog.innerHTML=`<form method="dialog"><button aria-label="Close tag manager" autofocus>Close</button></form><h2 id="fmdx-tag-manager-title">${picker ? 'Document tags' : 'Tag manager'}</h2><p data-status role="status">Loading tags…</p><button data-retry>Retry</button>`;
  dialog.querySelector('[data-retry]').onclick=run(load);
  document.body.append(dialog); dialog.showModal();
  await run(load)();
}
