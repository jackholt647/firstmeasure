/*
 * Config library (docs/architecture/dev-lanes.md, "Config lane"): the platform's defaults as live data on dev.
 * Browse entries by kind, edit an entry's value (validated on save by the server), see its revisions and revert,
 * and reset this organization's copy to the library. The store and its API belong to the config library; this only
 * draws it. Refreshes on the config_library.changed platform event.
 */
const BASE = '/v1/config-library';

export function mount(root, { api, T, esc, orgId, toast }) {
  const view = { kind: '', q: '', entry: null, tab: 'value' };
  let kinds = [], token = 0;
  const when = (iso) => iso ? new Date(iso).toLocaleString() : '';
  const back = `<button type="button" class="fm-dc-btn" data-dc-back><i class="fas fa-arrow-left" aria-hidden="true"></i> ${esc(T('dc_config_back', 'Back'))}</button>`;

  function unavailable(error) {
    root.innerHTML = error.status === 404
      ? `<p class="fm-dc-note">${esc(T('dc_config_later', 'The config library is not on dev yet. Its entries show here once it is.'))}</p>`
      : `<p class="fm-dc-error">${esc(error.message)}</p>`;
  }

  async function home() {
    const mine = ++token;
    view.entry = null;
    try {
      kinds = (await api(BASE + '/kinds')).kinds || [];
      if (!view.kind && kinds[0]) view.kind = kinds[0].kind;
      const params = new URLSearchParams({ kind: view.kind, q: view.q });
      const entries = view.kind ? (await api(`${BASE}/entries?${params}`)).entries || [] : [];
      if (mine !== token) return;
      root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_config_intro', 'Defaults every organization starts from. A change reaches organizations that have not changed their own copy.'))}</p>
        <div class="fm-dc-fields"><label class="fm-dc-field">${esc(T('dc_config_kind', 'Kind'))}<select data-dc-kind>${kinds.map((k) => `<option value="${esc(k.kind)}" ${k.kind === view.kind ? 'selected' : ''}>${esc(k.label || k.kind)} (${Number(k.count) || 0})</option>`).join('')}</select></label>
        <label class="fm-dc-field">${esc(T('dc_config_search', 'Search'))}<input type="search" data-dc-q value="${esc(view.q)}"></label></div>
        <ul class="fm-dc-list">${entries.map((e) => `<li class="fm-dc-row"><button type="button" class="fm-dc-link" data-dc-entry="${esc(e.id)}"><strong>${esc(e.title || e.key)}</strong><small>${esc(e.key)} · r${Number(e.revision) || 0} · ${esc(e.updated_by || '')} ${esc(when(e.updated_at))}</small></button></li>`).join('') || `<li class="fm-dc-empty">${esc(T('dc_config_empty', 'No entries of this kind.'))}</li>`}</ul>`;
    } catch (error) { if (mine === token) unavailable(error); }
  }

  async function open(id, tab = view.tab) {
    const mine = ++token;
    view.tab = tab;
    try {
      const { entry, schema } = await api(`${BASE}/entries/${encodeURIComponent(id)}`);
      if (mine !== token) return;
      view.entry = entry;
      const tabs = [['value', T('dc_config_tab_value', 'Value')], ['revisions', T('dc_config_tab_revisions', 'Revisions')], ['org', T('dc_config_tab_org', 'This organization')]];
      root.innerHTML = `<div class="fm-dc-actions" style="margin-top:0">${back}</div>
        <p class="fm-dc-intro"><strong>${esc(entry.title || entry.key)}</strong><span class="fm-dc-sub">${esc(entry.kind)} · ${esc(entry.key)} · r${Number(entry.revision) || 0}</span></p>
        <nav class="fm-dc-tabs">${tabs.map(([key, label]) => `<button type="button" data-dc-tab="${key}" aria-pressed="${key === view.tab}">${esc(label)}</button>`).join('')}</nav>
        <div data-dc-tabpane></div>`;
      const pane = root.querySelector('[data-dc-tabpane]');
      if (view.tab === 'value') {
        pane.innerHTML = `<textarea class="fm-dc-code" spellcheck="false" data-dc-value aria-label="${esc(T('dc_config_value', 'Value'))}">${esc(JSON.stringify(entry.value, null, 2))}</textarea>
          ${schema ? `<details style="margin-top:8px"><summary class="fm-dc-sub">${esc(T('dc_config_schema', 'Schema'))}</summary><pre class="fm-dc-code" style="min-height:0">${esc(JSON.stringify(schema, null, 2))}</pre></details>` : ''}
          <label class="fm-dc-field" style="margin-top:8px">${esc(T('dc_config_note', 'Note (optional)'))}<input data-dc-note></label>
          <div data-dc-errors></div>
          <div class="fm-dc-actions"><button type="button" class="fm-dc-btn fm-dc-primary" data-dc-save>${esc(T('dc_config_save', 'Save to the library'))}</button></div>`;
      } else if (view.tab === 'revisions') {
        const { revisions = [] } = await api(`${BASE}/entries/${encodeURIComponent(id)}/revisions`);
        if (mine !== token) return;
        pane.innerHTML = `<ul class="fm-dc-list">${revisions.map((r) => `<li class="fm-dc-row"><span><strong>r${Number(r.revision)}</strong>${Number(r.revision) === Number(entry.revision) ? ` <span class="fm-dc-badge">${esc(T('dc_config_current', 'current'))}</span>` : ''}<small>${esc(r.author || '')} · ${esc(when(r.created_at))}${r.note ? ' · ' + esc(r.note) : ''}</small></span><button type="button" class="fm-dc-btn" data-dc-view-rev="${Number(r.revision)}">${esc(T('dc_config_view', 'View'))}</button>${Number(r.revision) === Number(entry.revision) ? '' : `<button type="button" class="fm-dc-btn" data-dc-revert="${Number(r.revision)}">${esc(T('dc_config_revert', 'Revert to this'))}</button>`}</li>`).join('') || `<li class="fm-dc-empty">${esc(T('dc_config_no_revisions', 'No revisions yet.'))}</li>`}</ul><pre class="fm-dc-code" data-dc-rev-value hidden style="min-height:0"></pre>`;
      } else {
        let copy;
        try { copy = await api(`${BASE}/entries/${encodeURIComponent(id)}/org-copy`); } catch (error) { copy = { error: error.message }; }
        if (mine !== token) return;
        const states = { follows_library: [T('dc_config_follows', 'Follows the library'), 'fm-dc-ok'], changed: [T('dc_config_changed', 'Changed in this organization'), 'fm-dc-changed'], none: [T('dc_config_none', 'Not used by this organization'), ''] };
        const [label, tone] = states[copy.state] || [copy.error || copy.state || '', ''];
        pane.innerHTML = `<p class="fm-dc-row"><span>${esc(T('dc_config_org_copy', "This organization's copy"))}${copy.changed_at ? `<small>${esc(copy.changed_by || '')} · ${esc(when(copy.changed_at))}</small>` : ''}</span><span class="fm-dc-badge ${tone}">${esc(label)}</span></p>
          <div class="fm-dc-actions"><button type="button" class="fm-dc-btn fm-dc-danger" data-dc-reset-org ${copy.state === 'changed' ? '' : 'disabled'}><i class="fas fa-rotate-left" aria-hidden="true"></i> ${esc(T('dc_config_reset_org', "Reset this organization's copy to the library"))}</button></div>`;
      }
    } catch (error) { if (mine === token) unavailable(error); }
  }

  root.addEventListener('change', (event) => {
    if (event.target.matches('[data-dc-kind]')) { view.kind = event.target.value; home(); }
  });
  let typing = 0;
  root.addEventListener('input', (event) => {
    if (!event.target.matches('[data-dc-q]')) return;
    view.q = event.target.value.trim();
    clearTimeout(typing); typing = setTimeout(async () => { await home(); const input = root.querySelector('[data-dc-q]'); input?.focus(); input?.setSelectionRange(view.q.length, view.q.length); }, 300);
  });
  root.addEventListener('click', async (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    const entry = view.entry;
    if (target.dataset.dcEntry) return open(target.dataset.dcEntry, 'value');
    if (target.matches('[data-dc-back]')) return home();
    if (target.dataset.dcTab) return open(entry.id, target.dataset.dcTab);
    if (target.matches('[data-dc-save]')) {
      const errors = root.querySelector('[data-dc-errors]');
      let value;
      try { value = JSON.parse(root.querySelector('[data-dc-value]').value); }
      catch (error) { errors.innerHTML = `<p class="fm-dc-error">${esc(T('dc_config_bad_json', 'This is not valid JSON:'))} ${esc(error.message)}</p>`; return; }
      target.disabled = true;
      try {
        await api(`${BASE}/entries/${encodeURIComponent(entry.id)}`, { method: 'PUT', body: { value, expected_revision: entry.revision, note: root.querySelector('[data-dc-note]').value.trim() || undefined } });
        toast(T('dc_config_saved', 'Saved to the library'));
        return open(entry.id, 'value');
      } catch (error) {
        target.disabled = false;
        const list = error.body?.errors || [];
        errors.innerHTML = error.status === 409
          ? `<p class="fm-dc-error">${esc(T('dc_config_conflict', 'Someone saved this entry after you opened it. Reopen it to see their change.'))}</p>`
          : `<p class="fm-dc-error">${esc(error.message)}</p>${list.length ? `<ul class="fm-dc-error">${list.map((e) => `<li><code>${esc(e.path || '/')}</code> ${esc(e.message)}</li>`).join('')}</ul>` : ''}`;
        return;
      }
    }
    if (target.dataset.dcViewRev) {
      const { revision } = await api(`${BASE}/entries/${encodeURIComponent(entry.id)}/revisions/${target.dataset.dcViewRev}`).catch((error) => ({ revision: { value: error.message } }));
      const pre = root.querySelector('[data-dc-rev-value]'); pre.hidden = false; pre.textContent = JSON.stringify(revision?.value, null, 2);
      return;
    }
    if (target.dataset.dcRevert) {
      target.disabled = true;
      try { await api(`${BASE}/entries/${encodeURIComponent(entry.id)}/revert`, { method: 'POST', body: { revision: Number(target.dataset.dcRevert) } }); toast(T('dc_config_reverted', 'Reverted')); }
      catch (error) { toast(error.message); }
      return open(entry.id, 'revisions');
    }
    if (target.matches('[data-dc-reset-org]')) {
      target.disabled = true;
      try { await api(`${BASE}/entries/${encodeURIComponent(entry.id)}/org-copy/reset`, { method: 'POST' }); toast(T('dc_config_reset_done', "This organization's copy follows the library again")); }
      catch (error) { toast(error.message); }
      return open(entry.id, 'org');
    }
  });

  const org = orgId();
  if (org && window.PlatformRealtime?.subscribe) {
    window.PlatformRealtime.subscribe(org, 'config_library.', (event) => {
      // An entry being edited here is not redrawn under the person; the list is.
      if (!view.entry) home();
      else if (view.tab !== 'value' && String(event?.payload?.entry_id || '') === String(view.entry.id)) open(view.entry.id);
    });
  }
  home();
}
