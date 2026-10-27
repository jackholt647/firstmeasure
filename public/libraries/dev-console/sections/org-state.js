/*
 * Flags and settings for this test organization, and Restore initial state (docs/architecture/config-library.md,
 * "Test organizations"). A sandbox test organization records the state it started with; after "Get Started" or a
 * setup flips some flags, Restore puts them back so it can be tried again. A full restore also clears the
 * organization's guided experience progress, so every tour and setup plays as new. Refreshes on org_state.changed.
 */
export function mount(root, { api, T, esc, orgId, toast }) {
  const base = () => `/v1/config-library/organizations/${encodeURIComponent(orgId())}/state`;
  let data = null, filter = '', busy = false, token = 0;
  const show = (value) => value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value);
  const rows = (map, area) => Object.entries(map || {}).map(([key, value]) => ({ path: `${area}.${key}`, value }));

  async function load() {
    const mine = ++token;
    if (!orgId()) { root.innerHTML = `<p class="fm-dc-empty">${esc(T('dc_org_state_no_org', 'Open the portal to see this organization.'))}</p>`; return; }
    try { data = await api(base()); }
    catch (error) {
      if (mine !== token) return;
      root.innerHTML = error.status === 404 && /^Route /.test(String(error.body?.message || ''))
        ? `<p class="fm-dc-note">${esc(T('dc_org_state_later', 'Flags and initial-state restore arrive with the config library. Nothing to show on dev yet.'))}</p>`
        : `<p class="fm-dc-note fm-dc-warn">${esc(error.message)}</p>`;
      return;
    }
    if (mine === token) render();
  }

  function render() {
    const changed = data.changed || [], initial = data.initial;
    const all = [...rows(data.flags, 'flags'), ...rows(data.scope_flags, 'scope_flags'), ...rows(data.settings, 'settings')]
      .filter((row) => !filter || row.path.toLowerCase().includes(filter))
      .sort((a, b) => a.path.localeCompare(b.path));
    root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_org_state_intro', 'What this organization has switched on now, beside what it started with.'))}</p>
      <h3 class="fm-dc-h">${esc(T('dc_org_state_changed', 'Changed since it started'))} · ${changed.length}</h3>
      ${initial ? '' : `<p class="fm-dc-note fm-dc-warn">${esc(T('dc_org_state_no_initial', 'This organization has no recorded start, so there is nothing to restore yet. Record how it is now as its start.'))}</p><div class="fm-dc-actions"><button type="button" class="fm-dc-btn" data-dc-capture>${esc(T('dc_org_state_capture', 'Record the current state as the start'))}</button></div>`}
      ${changed.length ? `<ul class="fm-dc-list">${changed.map((row) => `<li class="fm-dc-row"><span><strong>${esc(row.path)}</strong><small>${esc(show(row.initial))} → ${esc(show(row.current))}</small></span><button type="button" class="fm-dc-btn" data-dc-restore="${esc(row.path)}">${esc(T('dc_org_state_restore_one', 'Restore'))}</button></li>`).join('')}</ul>` : initial ? `<p class="fm-dc-empty">${esc(T('dc_org_state_same', 'Everything is as it started.'))}</p>` : ''}
      ${initial ? `<div class="fm-dc-actions"><button type="button" class="fm-dc-btn fm-dc-primary" data-dc-restore-all><i class="fas fa-rotate-left" aria-hidden="true"></i> ${esc(T('dc_org_state_restore_all', 'Restore initial state'))}</button><button type="button" class="fm-dc-btn" data-dc-reload><i class="fas fa-arrows-rotate" aria-hidden="true"></i> ${esc(T('dc_org_state_reload', 'Reload page'))}</button></div>
      <p class="fm-dc-sub">${esc(T('dc_org_state_restore_all_note', 'Restore initial state also replays every Get Started tour and setup as new. Projects and documents stay.'))}</p>
      <p class="fm-dc-sub">${esc(T('dc_org_state_captured', 'Start recorded'))} ${esc(new Date(initial.captured_at).toLocaleString())}${initial.restores ? ` · ${esc(T('dc_org_state_restores', 'restored'))} ${Number(initial.restores)}×` : ''}</p>` : ''}
      <h3 class="fm-dc-h">${esc(T('dc_org_state_all', 'All flags and settings'))}</h3>
      <input type="search" class="fm-dc-input" data-dc-filter placeholder="${esc(T('dc_org_state_filter', 'Filter by name'))}" value="${esc(filter)}">
      <ul class="fm-dc-list">${all.map((row) => `<li class="fm-dc-row"><span><strong>${esc(row.path)}</strong>${typeof row.value === 'boolean' ? '' : `<small>${esc(show(row.value))}</small>`}</span>${typeof row.value === 'boolean' ? `<input type="checkbox" class="fm-dc-switch" role="switch" aria-label="${esc(row.path)}" data-dc-flag="${esc(row.path)}" ${row.value ? 'checked' : ''}>` : ''}</li>`).join('') || `<li class="fm-dc-empty">${esc(T('dc_org_state_none', 'Nothing matches.'))}</li>`}</ul>`;
  }

  async function write(run, done) {
    if (busy) return;
    busy = true;
    try { data = await run(); render(); if (done) toast(done(data)); }
    catch (error) { toast(error.message); await load(); }
    finally { busy = false; }
  }
  const restored = () => T('dc_org_state_restored', 'Restored. Reload the page to see it.');
  root.addEventListener('click', (event) => {
    const one = event.target.closest('[data-dc-restore]');
    if (one) write(() => api(base() + '/restore', { method: 'POST', body: { paths: [one.dataset.dcRestore] } }), restored);
    if (event.target.closest('[data-dc-restore-all]')) write(() => api(base() + '/restore', { method: 'POST', body: {} }), restored);
    if (event.target.closest('[data-dc-capture]')) write(() => api(base() + '/capture', { method: 'POST', body: {} }), () => T('dc_org_state_captured_now', 'Recorded as the start'));
    if (event.target.closest('[data-dc-reload]')) location.reload();
  });
  root.addEventListener('change', (event) => {
    const flag = event.target.closest('[data-dc-flag]');
    if (flag) write(() => api(base(), { method: 'PATCH', body: { path: flag.dataset.dcFlag, value: flag.checked } }));
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
