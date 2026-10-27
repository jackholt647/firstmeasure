/*
 * Flags and settings for this organization, and Restore initial state (docs/architecture/dev-console.md). Every test
 * organization keeps the flags and settings it started with (the config library, docs/architecture/dev-lanes.md
 * "Config lane"); after "Get Started" or a setup flips some, Restore puts them back so it can be tried again.
 * Refreshes on the org_state.changed platform event.
 */
const BASE = '/v1/config-library/org-state';

export function mount(root, { api, T, esc, orgId, toast }) {
  let data = null, filter = '', busy = false, token = 0;
  const show = (value) => value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value);
  const rows = (map, prefix) => Object.entries(map || {}).map(([key, value]) => ({ path: `${prefix}.${key}`, key, value }));

  async function load() {
    const mine = ++token;
    try { data = await api(BASE); }
    catch (error) {
      if (mine !== token) return;
      root.innerHTML = error.status === 404
        ? `<p class="fm-dc-note">${esc(T('dc_org_state_later', 'Flags and initial-state restore arrive with the config library. Nothing to show on dev yet.'))}</p>`
        : `<p class="fm-dc-error">${esc(error.message)}</p>`;
      return;
    }
    if (mine === token) render();
  }

  function render() {
    const changed = data.changed || [];
    const all = [...rows(data.flags, 'flags'), ...rows(data.settings, 'settings')]
      .filter((row) => !filter || row.path.toLowerCase().includes(filter))
      .sort((a, b) => a.path.localeCompare(b.path));
    const initial = data.initial;
    root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_org_state_intro', 'What this organization has switched on now, beside what it started with.'))}</p>
      <h3 class="fm-dc-h">${esc(T('dc_org_state_changed', 'Changed since it started'))} · ${changed.length}</h3>
      ${initial ? '' : `<p class="fm-dc-note fm-dc-warn">${esc(T('dc_org_state_no_initial', 'No initial state was kept for this organization, so there is nothing to restore.'))}</p>`}
      ${changed.length ? `<ul class="fm-dc-list">${changed.map((row) => `<li class="fm-dc-row"><span><strong>${esc(row.path)}</strong><small>${esc(show(row.initial))} → ${esc(show(row.current))}</small></span><button type="button" class="fm-dc-btn" data-dc-restore="${esc(row.path)}">${esc(T('dc_org_state_restore_one', 'Restore'))}</button></li>`).join('')}</ul>` : `<p class="fm-dc-empty">${esc(T('dc_org_state_same', 'Everything is as it started.'))}</p>`}
      <div class="fm-dc-actions"><button type="button" class="fm-dc-btn fm-dc-primary" data-dc-restore-all ${changed.length && initial ? '' : 'disabled'}><i class="fas fa-rotate-left" aria-hidden="true"></i> ${esc(T('dc_org_state_restore_all', 'Restore initial state'))}</button><button type="button" class="fm-dc-btn" data-dc-reload><i class="fas fa-arrows-rotate" aria-hidden="true"></i> ${esc(T('dc_org_state_reload', 'Reload page'))}</button></div>
      ${initial?.captured_at ? `<p class="fm-dc-sub">${esc(T('dc_org_state_captured', 'Initial state kept'))} ${esc(new Date(initial.captured_at).toLocaleString())}</p>` : ''}
      <h3 class="fm-dc-h">${esc(T('dc_org_state_all', 'All flags and settings'))}</h3>
      <input type="search" class="fm-dc-input" data-dc-filter placeholder="${esc(T('dc_org_state_filter', 'Filter by name'))}" value="${esc(filter)}">
      <ul class="fm-dc-list">${all.map((row) => `<li class="fm-dc-row"><span><strong>${esc(row.path)}</strong>${typeof row.value === 'boolean' ? '' : `<small>${esc(show(row.value))}</small>`}</span>${typeof row.value === 'boolean' ? `<input type="checkbox" class="fm-dc-switch" role="switch" aria-label="${esc(row.path)}" data-dc-flag="${esc(row.path)}" ${row.value ? 'checked' : ''}>` : ''}</li>`).join('') || `<li class="fm-dc-empty">${esc(T('dc_org_state_none', 'Nothing matches.'))}</li>`}</ul>`;
  }

  async function write(run, done) {
    if (busy) return;
    busy = true;
    try { data = await run(); render(); if (done) toast(done); }
    catch (error) { toast(error.message); await load(); }
    finally { busy = false; }
  }
  root.addEventListener('click', (event) => {
    const one = event.target.closest('[data-dc-restore]');
    if (one) write(() => api(BASE + '/restore', { method: 'POST', body: { paths: [one.dataset.dcRestore] } }), T('dc_org_state_restored', 'Restored. Reload the page to see it.'));
    if (event.target.closest('[data-dc-restore-all]')) write(() => api(BASE + '/restore', { method: 'POST', body: {} }), T('dc_org_state_restored', 'Restored. Reload the page to see it.'));
    if (event.target.closest('[data-dc-reload]')) location.reload();
  });
  root.addEventListener('change', (event) => {
    const flag = event.target.closest('[data-dc-flag]');
    if (flag) write(() => api(BASE, { method: 'PATCH', body: { path: flag.dataset.dcFlag, value: flag.checked } }));
  });
  root.addEventListener('input', (event) => {
    if (!event.target.matches('[data-dc-filter]')) return;
    filter = event.target.value.trim().toLowerCase();
    const at = event.target.selectionStart;
    render();
    const input = root.querySelector('[data-dc-filter]'); input.focus(); input.setSelectionRange(at, at);
  });
  const org = orgId();
  if (org && window.PlatformRealtime?.subscribe) window.PlatformRealtime.subscribe(org, 'org_state.', () => { if (!busy) load(); }, { onResync: load });
  load();
  return { shown: load };
}
