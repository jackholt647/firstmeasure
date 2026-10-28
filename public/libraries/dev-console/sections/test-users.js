/*
 * Test users (moved from the portal's hidden developer overlay): turn this organization's users on and off to test
 * as a smaller team, or leave one user on ("Solo"; the person using the console always stays on). Writes through PlatformAPI.users as the person; a user turned
 * off here remembers the status it had.
 */
export function mount(root, { T, esc, toast }) {
  const API = window.PlatformAPI;
  const org = () => String(window.__APP?.userOrgId || window.Portal?.currentUser?.orgId || '');
  const off = (user) => String(user.status || '').toLowerCase() === 'disabled';
  const label = (user) => user.name || user.full_name || user.email || user.id;
  // Never turn off the person using the console: they would lose this session.
  const me = (user) => [window.__APP?.userId, window.Portal?.currentUser?.id, window.Portal?.currentUser?.email, window.__APP?.userEmail].filter(Boolean).map(String).some((id) => id === String(user.id) || id === String(user.email || ''));
  let busy = false;

  async function list() {
    const result = await API.users.list(org());
    return (result?.documents || result?.users || result || []).map((doc) => {
      const data = doc?.data || doc || {};
      return { ...data, id: doc?.id || data.id || data.user_id || data.email || '' };
    }).filter((user) => user.id);
  }
  const set = (user, disabled) => API.users.patch(org(), user.id, disabled
    ? { status: 'disabled', dev_overlay_disabled: true, dev_overlay_previous_status: user.status || 'active' }
    : { status: user.dev_overlay_previous_status && user.dev_overlay_previous_status !== 'disabled' ? user.dev_overlay_previous_status : 'active', dev_overlay_disabled: false },
  { kind: 'dev_overlay_user_status' });

  async function render() {
    if (!API?.users?.list || !org()) { root.innerHTML = `<p class="fm-dc-empty">${esc(T('dc_users_unavailable', 'Users can be switched from the portal.'))}</p>`; return; }
    root.innerHTML = `<p class="fm-dc-empty">${esc(T('dc_loading', 'Loading…'))}</p>`;
    let users;
    try { users = await list(); } catch (error) { root.innerHTML = `<p class="fm-dc-error">${esc(error?.message || error)}</p>`; return; }
    const active = users.filter((user) => !off(user)).length;
    root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_users_intro', 'Turn users off to test as a smaller team, or Solo to leave one user on.'))}</p>
      <div class="fm-dc-actions"><button type="button" class="fm-dc-btn" data-dc-users-all>${esc(T('dc_users_all', 'Turn every user on'))}</button></div>
      <h3 class="fm-dc-h">${esc(T('dc_users_active', 'On'))} · ${active}/${users.length}</h3>
      <ul class="fm-dc-list">${users.map((user) => `<li class="fm-dc-row"><span><strong>${esc(label(user))}</strong><small>${esc(user.email || user.id)}${Array.isArray(user.roles) && user.roles.length ? ' · ' + esc(user.roles.join(', ')) : ''}</small></span>${me(user) ? `<span class="fm-dc-badge">${esc(T('dc_users_you', 'You'))}</span>` : `<input type="checkbox" class="fm-dc-switch" role="switch" aria-label="${esc(label(user))}" data-dc-user="${esc(user.id)}" ${off(user) ? '' : 'checked'}>`}<button type="button" class="fm-dc-btn" data-dc-solo="${esc(user.id)}">${esc(T('dc_users_solo', 'Solo'))}</button></li>`).join('')}</ul>`;
    root.onchange = (event) => { const user = users.find((u) => u.id === event.target.dataset.dcUser); if (user) run(() => set(user, !event.target.checked)); };
    root.onclick = (event) => {
      if (event.target.closest('[data-dc-users-all]')) run(() => Promise.all(users.map((user) => set(user, false))));
      const solo = event.target.closest('[data-dc-solo]');
      if (solo) run(() => Promise.all(users.map((user) => set(user, user.id !== solo.dataset.dcSolo && !me(user)))));
    };
  }
  async function run(work) {
    if (busy) return;
    busy = true;
    try { await work(); } catch (error) { toast(String(error?.message || error)); }
    finally { busy = false; }
    render();
  }
  render();
  return { shown: render };
}
