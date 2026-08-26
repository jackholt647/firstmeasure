/* scripts/dev_overlay.js
 * Local testing harness for quickly mutating test org state from the browser.
 * Open with Ctrl+Alt+Shift+D or window.PlatformDevOverlay.open().
 */
(function(){
  const root = window;
  const Portal = root.Portal || {};
  const cfg = Portal.cfg || root.__APP || {};
  const API = root.PlatformAPI;
  const STYLE_ID = 'fm-dev-overlay-style';
  const OVERLAY_ID = 'fmDevOverlay';

  function orgId(){
    return String(cfg.userOrgId || cfg.orgId || root.__APP?.userOrgId || root.__APP?.orgId || '').trim();
  }

  function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, (match) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[match]));
  }

  function userData(doc){
    const data = doc?.data || doc || {};
    return { ...data, id: doc?.id || data.id || data.user_id || data.email || '' };
  }

  function userLabel(user){
    return user.name || user.full_name || user.email || user.id || 'Unnamed user';
  }

  function isDisabled(user){
    return String(user.status || '').toLowerCase() === 'disabled';
  }

  function injectStyle(){
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID}{position:fixed;inset:0;z-index:99999;display:none;background:rgba(15,23,42,.42);backdrop-filter:blur(3px);align-items:flex-start;justify-content:flex-end;padding:18px;box-sizing:border-box}
      #${OVERLAY_ID}.active{display:flex}
      .fm-dev-panel{width:min(520px,calc(100vw - 36px));max-height:calc(100vh - 36px);overflow:auto;background:#111827;color:#f9fafb;border:1px solid rgba(255,255,255,.12);border-radius:18px;box-shadow:0 28px 90px rgba(0,0,0,.42);font-family:Inter,Montserrat,system-ui,sans-serif}
      .fm-dev-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px 16px 12px;border-bottom:1px solid rgba(255,255,255,.10)}
      .fm-dev-title{font-size:15px;font-weight:1000;margin:0}
      .fm-dev-sub{margin:4px 0 0;font-size:11px;font-weight:750;color:#a7b0c0;line-height:1.4}
      .fm-dev-close{width:34px;height:34px;border-radius:11px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#fff;cursor:pointer}
      .fm-dev-body{padding:14px 16px 16px;display:grid;gap:12px}
      .fm-dev-row{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.05);border-radius:14px;padding:10px}
      .fm-dev-user-name{font-size:13px;font-weight:1000}
      .fm-dev-user-meta{margin-top:3px;font-size:10px;font-weight:800;color:#a7b0c0}
      .fm-dev-pill{display:inline-flex;align-items:center;justify-content:center;min-width:74px;height:28px;border-radius:999px;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;background:#064e3b;color:#a7f3d0}
      .fm-dev-pill.disabled{background:#4b1020;color:#fecdd3}
      .fm-dev-btn{height:32px;border:1px solid rgba(255,255,255,.14);border-radius:11px;background:rgba(255,255,255,.08);color:#fff;font-size:11px;font-weight:1000;cursor:pointer;padding:0 10px}
      .fm-dev-btn:hover{background:rgba(255,255,255,.14)}
      .fm-dev-btn.primary{background:#2563eb;border-color:#2563eb}
      .fm-dev-actions{display:flex;flex-wrap:wrap;gap:8px}
      .fm-dev-note{font-size:11px;line-height:1.45;color:#cbd5e1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:10px}
      .fm-dev-error{color:#fecdd3}
    `;
    document.head.appendChild(style);
  }

  function ensureOverlay(){
    injectStyle();
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
      <div class="fm-dev-panel" role="dialog" aria-label="Developer overlay">
        <div class="fm-dev-head">
          <div>
            <h2 class="fm-dev-title">Developer Overlay</h2>
            <div class="fm-dev-sub">Testing harness for local Platform state. Shortcut: Ctrl+Alt+Shift+D.</div>
          </div>
          <button type="button" class="fm-dev-close" data-dev-close aria-label="Close"><i class="fas fa-times"></i></button>
        </div>
        <div class="fm-dev-body" id="fmDevBody"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('[data-dev-close]')?.addEventListener('click', close);
    overlay.addEventListener('mousedown', (event) => { overlay.__downBackdrop = event.target === overlay; });
    overlay.addEventListener('mouseup', (event) => {
      if (overlay.__downBackdrop && event.target === overlay) close();
      overlay.__downBackdrop = false;
    });
    return overlay;
  }

  function body(){
    return ensureOverlay().querySelector('#fmDevBody');
  }

  function setBody(html){
    const el = body();
    if (el) el.innerHTML = html;
  }

  async function listUsers(){
    if (!API?.users?.list) throw new Error('PlatformAPI users library is not loaded.');
    const oid = orgId();
    if (!oid) throw new Error('No organization id found for this session.');
    const result = await API.users.list(oid);
    return (result?.documents || result?.users || result || []).map(userData).filter((user) => user.id);
  }

  async function patchUser(user, data){
    if (!API?.users?.patch) throw new Error('PlatformAPI users patch helper is not loaded.');
    return API.users.patch(orgId(), user.id, data, { kind: 'dev_overlay_user_status' });
  }

  async function setUserDisabled(user, disabled){
    const next = disabled
      ? { status: 'disabled', dev_overlay_disabled: true, dev_overlay_previous_status: user.status || 'active' }
      : { status: user.dev_overlay_previous_status && user.dev_overlay_previous_status !== 'disabled' ? user.dev_overlay_previous_status : 'active', dev_overlay_disabled: false };
    await patchUser(user, next);
  }

  async function setSoloActive(targetId){
    const users = await listUsers();
    await Promise.all(users.map((user) => setUserDisabled(user, user.id !== targetId)));
  }

  async function enableAll(){
    const users = await listUsers();
    await Promise.all(users.map((user) => setUserDisabled(user, false)));
  }

  function renderUsers(users){
    const activeCount = users.filter((user) => !isDisabled(user)).length;
    setBody(`
      <div class="fm-dev-note">
        <strong>Sales team testing:</strong> disabling users writes <code>status: disabled</code> to the Platform users collection.
        Scheduling ignores disabled users, so refresh after changes to test single-person versus team scheduling.
      </div>
      <div class="fm-dev-actions">
        <button type="button" class="fm-dev-btn primary" data-dev-refresh>Refresh</button>
        <button type="button" class="fm-dev-btn" data-dev-enable-all>Enable all users</button>
      </div>
      <div class="fm-dev-note">${activeCount} active user${activeCount === 1 ? '' : 's'} in org <code>${escapeHtml(orgId())}</code>.</div>
      ${users.map((user) => `
        <div class="fm-dev-row">
          <div>
            <div class="fm-dev-user-name">${escapeHtml(userLabel(user))}</div>
            <div class="fm-dev-user-meta">${escapeHtml(user.email || user.id)}${Array.isArray(user.roles) && user.roles.length ? ` · ${escapeHtml(user.roles.join(', '))}` : ''}</div>
          </div>
          <span class="fm-dev-pill ${isDisabled(user) ? 'disabled' : ''}">${isDisabled(user) ? 'Disabled' : 'Active'}</span>
          <div class="fm-dev-actions">
            <button type="button" class="fm-dev-btn" data-dev-toggle="${escapeHtml(user.id)}">${isDisabled(user) ? 'Enable' : 'Disable'}</button>
            <button type="button" class="fm-dev-btn" data-dev-solo="${escapeHtml(user.id)}">Solo</button>
          </div>
        </div>
      `).join('')}
    `);
    const el = body();
    el.querySelector('[data-dev-refresh]')?.addEventListener('click', refresh);
    el.querySelector('[data-dev-enable-all]')?.addEventListener('click', async () => { await enableAll(); await refresh(); });
    el.querySelectorAll('[data-dev-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const user = users.find((entry) => entry.id === btn.dataset.devToggle);
        if (!user) return;
        await setUserDisabled(user, !isDisabled(user));
        await refresh();
      });
    });
    el.querySelectorAll('[data-dev-solo]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await setSoloActive(btn.dataset.devSolo);
        await refresh();
      });
    });
  }

  async function refresh(){
    setBody('<div class="fm-dev-note">Loading users...</div>');
    try {
      renderUsers(await listUsers());
    } catch (error) {
      setBody(`<div class="fm-dev-note fm-dev-error">${escapeHtml(error?.message || error)}</div>`);
    }
  }

  async function open(){
    ensureOverlay().classList.add('active');
    await refresh();
  }

  function close(){
    ensureOverlay().classList.remove('active');
  }

  function toggle(){
    const overlay = ensureOverlay();
    if (overlay.classList.contains('active')) close();
    else open();
  }

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.altKey && event.shiftKey && String(event.key || '').toLowerCase() === 'd') {
      event.preventDefault();
      toggle();
    }
  });

  root.PlatformDevOverlay = {
    open,
    close,
    toggle,
    refresh,
    listUsers,
    enableAll,
    setSoloActive,
  };
})();
