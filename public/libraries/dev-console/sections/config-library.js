/*
 * Config library (docs/architecture/config-library.md): the platform's defaults as live data on dev. Browse entries
 * by kind, edit an entry's data (the server checks it on save; Check runs the same checks without saving), see its
 * revisions and revert, and reset this organization's copy to the library. The store and its API belong to the
 * config library; this only draws it. Refreshes on the config_library.changed platform event.
 */
const BASE = '/v1/config-library';

export function mount(root, { api, T, esc, orgId, toast }) {
  const view = { kind: '', q: '', entry: null, tab: 'data' };
  let kinds = [], token = 0;
  const when = (iso) => iso ? new Date(iso).toLocaleString() : '';
  const path = (kind, id) => `${BASE}/entries/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
  const kindOf = (name) => kinds.find((k) => k.kind === name) || {};
  const back = `<button type="button" class="fm-dc-btn" data-dc-back><i class="fas fa-arrow-left" aria-hidden="true"></i> ${esc(T('dc_config_back', 'Back'))}</button>`;
  const errorList = (error) => {
    const list = error.body?.details?.errors || [];
    return `<p class="fm-dc-error">${esc(error.message)}</p>${list.length ? `<ul class="fm-dc-error">${list.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}`;
  };

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
      const [entries, changes] = await Promise.all([
        view.kind ? api(`${BASE}/entries?${params}`).then((r) => r.entries || []) : [],
        api(`${BASE}/changes?limit=8`).then((r) => r.changes || [], () => [])
      ]);
      if (mine !== token) return;
      const kind = kindOf(view.kind);
      root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_config_intro', 'Defaults every organization starts from. A change reaches organizations that have not changed their own copy.'))}</p>
        <div class="fm-dc-fields"><label class="fm-dc-field">${esc(T('dc_config_kind', 'Kind'))}<select data-dc-kind>${kinds.map((k) => `<option value="${esc(k.kind)}" ${k.kind === view.kind ? 'selected' : ''}>${esc(k.title || k.kind)} (${Number(k.count) || 0})</option>`).join('')}</select></label>
        <label class="fm-dc-field">${esc(T('dc_config_search', 'Search'))}<input type="search" data-dc-q value="${esc(view.q)}"></label></div>
        ${kind.description ? `<p class="fm-dc-sub">${esc(kind.description)}${kind.append_only ? ' · ' + esc(T('dc_config_append_only', 'entries are only ever added')) : ''}</p>` : ''}
        <ul class="fm-dc-list">${entries.map((e) => `<li class="fm-dc-row"><button type="button" class="fm-dc-link" data-dc-entry="${esc(e.id)}" data-dc-entry-kind="${esc(e.kind)}"><strong>${esc(e.title || e.id)}</strong><small>${esc(e.id)} · r${Number(e.revision) || 0} · ${esc(e.updated_by || '')} ${esc(when(e.updated_at))}</small></button></li>`).join('') || `<li class="fm-dc-empty">${esc(T('dc_config_empty', 'No entries of this kind.'))}</li>`}</ul>
        ${changes.length ? `<h3 class="fm-dc-h">${esc(T('dc_config_recent', 'Recent changes'))}</h3><ul class="fm-dc-list">${changes.map((c) => `<li class="fm-dc-row"><button type="button" class="fm-dc-link" data-dc-entry="${esc(c.id)}" data-dc-entry-kind="${esc(c.kind)}"><strong>${esc(c.title || c.id)}</strong><small>${esc(c.kind)} · r${Number(c.revision) || 0} ${esc(c.action || '')} · ${esc(c.updated_by || '')} ${esc(when(c.updated_at))}${c.note ? ' · ' + esc(c.note) : ''}</small></button></li>`).join('')}</ul>` : ''}`;
    } catch (error) { if (mine === token) unavailable(error); }
  }

  async function open(kind, id, tab = view.tab) {
    const mine = ++token;
    view.tab = tab;
    try {
      const { entry } = await api(path(kind, id));
      if (mine !== token) return;
      view.entry = entry;
      const info = kindOf(entry.kind);
      const tabs = [['data', T('dc_config_tab_value', 'Value')], ['revisions', T('dc_config_tab_revisions', 'Revisions')], ...(info.org_copies ? [['org', T('dc_config_tab_org', 'This organization')]] : [])];
      if (!tabs.some(([key]) => key === view.tab)) view.tab = 'data';
      root.innerHTML = `<div class="fm-dc-actions" style="margin-top:0">${back}</div>
        <p class="fm-dc-intro"><strong>${esc(entry.title || entry.id)}</strong><span class="fm-dc-sub">${esc(info.title || entry.kind)} · ${esc(entry.id)} · r${Number(entry.revision) || 0} · ${esc(entry.updated_by || '')} ${esc(when(entry.updated_at))}</span></p>
        <nav class="fm-dc-tabs">${tabs.map(([key, label]) => `<button type="button" data-dc-tab="${key}" aria-pressed="${key === view.tab}">${esc(label)}</button>`).join('')}</nav>
        <div data-dc-tabpane></div>`;
      const pane = root.querySelector('[data-dc-tabpane]');
      if (view.tab === 'data') {
        pane.innerHTML = `<textarea class="fm-dc-code" spellcheck="false" data-dc-value aria-label="${esc(T('dc_config_value', 'Value'))}">${esc(JSON.stringify(entry.data, null, 2))}</textarea>
          ${info.schema ? `<details style="margin-top:8px"><summary class="fm-dc-sub">${esc(T('dc_config_schema', 'Schema'))}</summary><pre class="fm-dc-code" style="min-height:0">${esc(JSON.stringify(info.schema, null, 2))}</pre></details>` : ''}
          <label class="fm-dc-field" style="margin-top:8px">${esc(T('dc_config_note', 'Note (optional)'))}<input data-dc-note maxlength="2000"></label>
          <div data-dc-errors></div>
          <div class="fm-dc-actions"><button type="button" class="fm-dc-btn fm-dc-primary" data-dc-save>${esc(T('dc_config_save', 'Save to the library'))}</button><button type="button" class="fm-dc-btn" data-dc-check>${esc(T('dc_config_check', 'Check without saving'))}</button></div>`;
      } else if (view.tab === 'revisions') {
        const { revisions = [] } = await api(`${path(entry.kind, entry.id)}/revisions`);
        if (mine !== token) return;
        pane.innerHTML = `<ul class="fm-dc-list">${revisions.map((r) => `<li class="fm-dc-row"><span><strong>r${Number(r.revision)}</strong>${Number(r.revision) === Number(entry.revision) ? ` <span class="fm-dc-badge">${esc(T('dc_config_current', 'current'))}</span>` : ''}<small>${esc(r.action || '')} · ${esc(r.updated_by || '')} · ${esc(when(r.updated_at))}${r.note ? ' · ' + esc(r.note) : ''}</small></span><button type="button" class="fm-dc-btn" data-dc-view-rev="${Number(r.revision)}">${esc(T('dc_config_view', 'View'))}</button>${Number(r.revision) === Number(entry.revision) ? '' : `<button type="button" class="fm-dc-btn" data-dc-revert="${Number(r.revision)}">${esc(T('dc_config_revert', 'Revert to this'))}</button>`}</li>`).join('') || `<li class="fm-dc-empty">${esc(T('dc_config_no_revisions', 'No revisions yet.'))}</li>`}</ul><pre class="fm-dc-code" data-dc-rev-value hidden style="min-height:0"></pre>`;
      } else {
        let copy = null, failure = '';
        try { copy = ((await api(`${BASE}/organizations/${encodeURIComponent(orgId())}/copies?kind=${encodeURIComponent(entry.kind)}`)).copies || []).find((c) => c.id === entry.id) || { state: 'missing' }; }
        catch (error) { failure = error.message; }
        if (mine !== token) return;
        const states = { library: [T('dc_config_follows', 'Follows the library'), 'fm-dc-ok'], behind: [T('dc_config_behind', 'Untouched, upgrades to the library by itself'), ''], changed: [T('dc_config_changed', 'Changed in this organization'), 'fm-dc-changed'], missing: [T('dc_config_none', 'This organization has no copy'), ''] };
        const [label, tone] = failure ? [failure, 'fm-dc-changed'] : states[copy.state] || [copy.state, ''];
        pane.innerHTML = `<p class="fm-dc-row"><span>${esc(T('dc_config_org_copy', "This organization's copy"))}<small>${copy?.copy_revision ? `r${Number(copy.copy_revision)} / r${Number(copy.library_revision)}` : ''}${copy?.detail ? ' · ' + esc(copy.detail) : ''}</small></span><span class="fm-dc-badge ${tone}">${esc(label)}</span></p>
          <div class="fm-dc-actions"><button type="button" class="fm-dc-btn fm-dc-danger" data-dc-reset-org ${copy && copy.state !== 'library' ? '' : 'disabled'}><i class="fas fa-rotate-left" aria-hidden="true"></i> ${esc(T('dc_config_reset_org', "Reset this organization's copy to the library"))}</button></div>`;
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
  const parsed = () => {
    try { return { data: JSON.parse(root.querySelector('[data-dc-value]').value) }; }
    catch (error) { root.querySelector('[data-dc-errors]').innerHTML = `<p class="fm-dc-error">${esc(T('dc_config_bad_json', 'This is not valid JSON:'))} ${esc(error.message)}</p>`; return null; }
  };
  root.addEventListener('click', async (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    const entry = view.entry;
    if (target.dataset.dcEntry) return open(target.dataset.dcEntryKind, target.dataset.dcEntry, 'data');
    if (target.matches('[data-dc-back]')) return home();
    if (target.dataset.dcTab) return open(entry.kind, entry.id, target.dataset.dcTab);
    if (target.matches('[data-dc-check]')) {
      const value = parsed(); if (!value) return;
      const errors = root.querySelector('[data-dc-errors]');
      try {
        const result = await api(`${BASE}/check`, { method: 'POST', body: { kind: entry.kind, id: entry.id, data: value.data } });
        errors.innerHTML = result.errors?.length ? `<ul class="fm-dc-error">${result.errors.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : `<p class="fm-dc-sub">${esc(T('dc_config_check_ok', 'No problems found.'))}</p>`;
      } catch (error) { errors.innerHTML = error.body?.errors ? `<ul class="fm-dc-error">${error.body.errors.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : errorList(error); }
      return;
    }
    if (target.matches('[data-dc-save]')) {
      const value = parsed(); if (!value) return;
      const errors = root.querySelector('[data-dc-errors]');
      target.disabled = true;
      try {
        const result = await api(path(entry.kind, entry.id), { method: 'PUT', body: { data: value.data, expected_revision: entry.revision, note: root.querySelector('[data-dc-note]').value.trim() || undefined } });
        toast(result.changed === false ? T('dc_config_unchanged', 'Nothing changed') : T('dc_config_saved', 'Saved to the library'));
        return open(entry.kind, entry.id, 'data');
      } catch (error) {
        target.disabled = false;
        errors.innerHTML = error.status === 409
          ? `<p class="fm-dc-error">${esc(T('dc_config_conflict', 'Someone saved this entry after you opened it. Reopen it to see their change.'))}</p>`
          : errorList(error);
        return;
      }
    }
    if (target.dataset.dcViewRev) {
      const { revision } = await api(`${path(entry.kind, entry.id)}/revisions/${target.dataset.dcViewRev}`).catch((error) => ({ revision: { data: error.message } }));
      const pre = root.querySelector('[data-dc-rev-value]'); pre.hidden = false; pre.textContent = JSON.stringify(revision?.data, null, 2);
      return;
    }
    if (target.dataset.dcRevert) {
      target.disabled = true;
      try { await api(`${path(entry.kind, entry.id)}/revert`, { method: 'POST', body: { revision: Number(target.dataset.dcRevert), expected_revision: entry.revision } }); toast(T('dc_config_reverted', 'Reverted')); }
      catch (error) { toast(error.message); }
      return open(entry.kind, entry.id, 'revisions');
    }
    if (target.matches('[data-dc-reset-org]')) {
      target.disabled = true;
      try { await api(`${BASE}/organizations/${encodeURIComponent(orgId())}/copies/${encodeURIComponent(entry.kind)}/${encodeURIComponent(entry.id)}/reset`, { method: 'POST', body: {} }); toast(T('dc_config_reset_done', "This organization's copy follows the library again")); }
      catch (error) { toast(error.message); }
      return open(entry.kind, entry.id, 'org');
    }
  });

  const org = orgId();
  if (org && window.PlatformRealtime?.subscribe) {
    window.PlatformRealtime.subscribe(org, 'config_library.', (event) => {
      // An entry being edited here is not redrawn under the person; the list is.
      const payload = event?.payload || {};
      if (!view.entry) home();
      else if (view.tab !== 'data' && payload.kind === view.entry.kind && payload.id === view.entry.id) open(view.entry.kind, view.entry.id);
    });
  }
  home();
  // Edits made from other organizations do not reach this page's event stream: the list reads again when opened.
  return { shown: () => { if (!view.entry) home(); } };
}
