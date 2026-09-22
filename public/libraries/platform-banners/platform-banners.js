/* libraries/platform-banners/platform-banners.js
 * Org-wide attention banner feed with three render surfaces:
 *   - "topbar": ONE fixed bar above the app (single highest-priority entry).
 *     Owns the layout shift via body.has-attention-topbar +
 *     --attention-topbar-offset, replacing the old promo bar's bespoke offset.
 *   - "sidebar": compact card in #sidebarAttentionSlot (single entry).
 *   - "notification": pinned rows rendered by scripts/topbar.js from this
 *     library's state (never dismissible there).
 *
 * Entries come from the server feed (PlatformAPI.attention.list — computed
 * sources + stored org banners with per-user dismissal already resolved) and
 * from client sources registered with registerClientSource(key, fn) (e.g. the
 * FirstMeasure promo). Client entries may carry an onCta callback; server
 * entries navigate through their frontend_action route patch.
 */
(function(){
  const root = window;
  const CLIENT_DISMISS_KEY = 'fm_attention_client_dismissed_v1';
  const SURFACES = ['topbar', 'sidebar', 'notification'];
  const POLL_MS = 10000; // same cadence as the notifications poll in topbar.js

  const listeners = new Set();
  const clientSources = new Map();
  const clientSeen = new Set();
  let serverEntries = [];
  let mergedEntries = [];
  let loadedAt = null;
  let currentOrgId = '';
  let pollTimer = null;
  let layoutListenerBound = false;
  let renderedTopbarSignature = '';
  let renderedSidebarSignature = '';

  function cleanText(value){ return String(value ?? '').trim(); }

  function escapeHtml(value){
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function readClientDismissals(){
    try {
      const raw = localStorage.getItem(CLIENT_DISMISS_KEY);
      const data = raw ? JSON.parse(raw) : {};
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) { return {}; }
  }

  function rememberClientDismissal(entryId){
    try {
      const data = readClientDismissals();
      data[entryId] = new Date().toISOString();
      localStorage.setItem(CLIENT_DISMISS_KEY, JSON.stringify(data));
    } catch (error) {}
  }

  function normalizeClientEntry(entry, sourceKey){
    const raw = entry && typeof entry === 'object' ? entry : {};
    const surfaces = (Array.isArray(raw.surfaces) ? raw.surfaces : [])
      .map((surface) => cleanText(surface).toLowerCase())
      .filter((surface) => SURFACES.includes(surface));
    const dismissibleInput = raw.dismissible && typeof raw.dismissible === 'object' ? raw.dismissible : {};
    const dismissible = {
      topbar: dismissibleInput.topbar === true,
      sidebar: dismissibleInput.sidebar === true,
      notification: false
    };
    const id = cleanText(raw.id) || `attention_client_${sourceKey}`;
    const dismissedAt = readClientDismissals()[id] || '';
    return {
      id,
      source: cleanText(raw.source) || sourceKey,
      key: cleanText(raw.key),
      priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 0,
      surfaces: surfaces.length ? surfaces : SURFACES.slice(),
      title: cleanText(raw.title) || 'Attention',
      body: cleanText(raw.body),
      cta_label: cleanText(raw.cta_label || raw.ctaLabel),
      tone: ['orange', 'primary', 'danger', 'neutral'].includes(cleanText(raw.tone)) ? cleanText(raw.tone) : 'orange',
      frontend_action: raw.frontend_action && typeof raw.frontend_action === 'object' ? raw.frontend_action : {},
      state: ['active', 'waiting', 'done'].includes(cleanText(raw.state)) ? cleanText(raw.state) : 'active',
      dismissible,
      client: true,
      onCta: typeof raw.onCta === 'function' ? raw.onCta : null,
      user_state: { seen_at: clientSeen.has(id) ? new Date().toISOString() : '', dismissed_at: dismissedAt },
      visible_surfaces: surfaces.length
        ? surfaces.filter((surface) => !dismissedAt || dismissible[surface] !== true)
        : SURFACES.filter((surface) => !dismissedAt || dismissible[surface] !== true)
    };
  }

  function collectClientEntries(){
    const entries = [];
    clientSources.forEach((fn, key) => {
      try {
        const produced = fn();
        (Array.isArray(produced) ? produced : []).forEach((entry) => {
          entries.push(normalizeClientEntry(entry, key));
        });
      } catch (error) {}
    });
    return entries;
  }

  function mergeEntries(){
    const merged = [...serverEntries, ...collectClientEntries()]
      .filter((entry) => entry && entry.state !== 'done')
      .filter((entry) => Array.isArray(entry.visible_surfaces) && entry.visible_surfaces.length > 0);
    merged.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0)
      || String(b.created_at || '').localeCompare(String(a.created_at || ''))
      || String(a.id).localeCompare(String(b.id)));
    mergedEntries = merged;
  }

  function notify(){
    listeners.forEach((fn) => {
      try { fn(getState()); } catch (error) {}
    });
  }

  function getState(){
    return {
      entries: mergedEntries.slice(),
      loaded_at: loadedAt,
      org_id: currentOrgId
    };
  }

  function entriesForSurface(surface){
    return mergedEntries.filter((entry) => entry.visible_surfaces.includes(surface));
  }

  function topEntryForSurface(surface){
    return entriesForSurface(surface)[0] || null;
  }

  function findEntry(entryId){
    return mergedEntries.find((entry) => String(entry.id) === String(entryId)) || null;
  }

  async function load(orgId, options = {}){
    const org = cleanText(orgId) || currentOrgId;
    if (!org || !root.PlatformAPI?.attention) {
      mergeEntries();
      renderSurfaces();
      notify();
      return getState();
    }
    currentOrgId = org;
    try {
      const data = await root.PlatformAPI.attention.list(org, options);
      serverEntries = Array.isArray(data?.entries) ? data.entries : [];
      loadedAt = new Date().toISOString();
    } catch (error) {}
    mergeEntries();
    renderSurfaces();
    notify();
    return getState();
  }

  function refresh(){
    mergeEntries();
    renderSurfaces();
    notify();
  }

  function registerClientSource(key, fn){
    const sourceKey = cleanText(key);
    if (!sourceKey || typeof fn !== 'function') return () => {};
    clientSources.set(sourceKey, fn);
    refresh();
    return () => { clientSources.delete(sourceKey); refresh(); };
  }

  function notifySourceChanged(){
    refresh();
  }

  function subscribe(fn){
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    try { fn(getState()); } catch (error) {}
    return () => listeners.delete(fn);
  }

  function markSeen(entryId){
    const entry = findEntry(entryId);
    if (!entry) return Promise.resolve(null);
    if (entry.client) {
      clientSeen.add(String(entry.id));
      entry.user_state = { ...(entry.user_state || {}), seen_at: new Date().toISOString() };
      return Promise.resolve(entry.user_state);
    }
    if (entry.user_state?.seen_at) return Promise.resolve(entry.user_state);
    entry.user_state = { ...(entry.user_state || {}), seen_at: new Date().toISOString() };
    if (currentOrgId && root.PlatformAPI?.attention) {
      return root.PlatformAPI.attention.markSeen(currentOrgId, entry.id).catch(() => null);
    }
    return Promise.resolve(entry.user_state);
  }

  async function dismiss(entryId, surface = 'topbar'){
    const entry = findEntry(entryId);
    if (!entry || entry.dismissible?.[surface] !== true) return getState();
    if (entry.client) {
      rememberClientDismissal(String(entry.id));
      refresh();
      return getState();
    }
    if (currentOrgId && root.PlatformAPI?.attention) {
      await root.PlatformAPI.attention.dismiss(currentOrgId, entry.id).catch(() => null);
      return await load(currentOrgId);
    }
    return getState();
  }

  function applyEntryAction(entry){
    if (!entry) return false;
    markSeen(entry.id);
    if (typeof entry.onCta === 'function') {
      try { entry.onCta(entry); } catch (error) {}
      return true;
    }
    const action = entry.frontend_action && typeof entry.frontend_action === 'object' ? entry.frontend_action : {};
    const route = action.route && typeof action.route === 'object'
      ? action.route
      : (!action.kind && Object.keys(action).length ? action : null);
    if (route && root.Portal?.navigation?.navigate) {
      root.Portal.navigation.navigate(route, { source: 'attention-banner' });
      return true;
    }
    return false;
  }

  // --- topbar surface --------------------------------------------------------

  const css = `
    body.has-attention-topbar .main{
      margin-top:var(--attention-topbar-offset, 48px);
      height:calc(100vh - var(--attention-topbar-offset, 48px));
    }
    body.has-attention-topbar .sidebar{
      margin-top:var(--attention-topbar-offset, 48px);
      height:calc(100vh - var(--attention-topbar-offset, 48px));
    }
    body.has-attention-topbar .mobile-topbar{ margin-top:var(--attention-topbar-offset, 48px); }
    .fm-attention-topbar{
      position:fixed; top:0; left:0; right:0; z-index:95000;
      min-height:48px;
      display:flex; align-items:center; justify-content:center;
      padding:8px 16px;
      color:#fff;
    }
    .fm-attention-topbar.tone-orange{
      background:linear-gradient(90deg, #d93025 0%, #f05a28 45%, #f59e0b 100%);
      box-shadow:0 10px 26px rgba(217,48,37,0.28);
    }
    .fm-attention-topbar.tone-primary{
      background:var(--primary, #d93025);
      box-shadow:0 10px 26px rgba(var(--primary-rgb, 217, 48, 37), 0.28);
    }
    .fm-attention-topbar.tone-danger{
      background:linear-gradient(90deg, #b42318 0%, #d92d20 100%);
      box-shadow:0 10px 26px rgba(180,35,24,0.30);
    }
    .fm-attention-topbar.tone-neutral{
      background:#1f2937;
      box-shadow:0 10px 26px rgba(15,23,42,0.28);
    }
    .fm-attention-topbar-inner{
      width:min(1280px, 100%);
      display:flex; align-items:center; justify-content:space-between; gap:14px;
      min-width:0;
    }
    .fm-attention-topbar-copy{
      display:flex; align-items:center; gap:10px; min-width:0;
    }
    .fm-attention-topbar-copy i.fm-attention-wait{ font-size:13px; opacity:.85; flex:0 0 auto; }
    .fm-attention-topbar-title{
      font-size:14px; font-weight:1000; letter-spacing:-0.2px; line-height:1.15;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .fm-attention-topbar-body{
      font-size:13px; font-weight:800; opacity:.92; line-height:1.15;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .fm-attention-topbar-right{ display:flex; align-items:center; gap:10px; flex:0 0 auto; }
    .fm-attention-topbar-cta{
      height:34px; padding:0 16px; border-radius:999px; border:none;
      background:#fff; color:#b42318; font-weight:1000; font-size:12.5px; cursor:pointer;
      box-shadow:0 8px 18px rgba(0,0,0,0.16);
      transition:.16s ease;
      white-space:nowrap;
    }
    .fm-attention-topbar.tone-neutral .fm-attention-topbar-cta,
    .fm-attention-topbar.tone-primary .fm-attention-topbar-cta{ color:#1f2937; }
    .fm-attention-topbar-cta:hover{ transform:translateY(-1px); }
    .fm-attention-topbar-dismiss{
      width:30px; height:30px; border-radius:10px; border:1px solid rgba(255,255,255,0.35);
      background:rgba(255,255,255,0.12); color:#fff; cursor:pointer;
      display:flex; align-items:center; justify-content:center; font-size:12px;
      transition:.16s ease; flex:0 0 auto;
    }
    .fm-attention-topbar-dismiss:hover{ background:rgba(255,255,255,0.22); }
    @media (max-width: 820px){
      .fm-attention-topbar{ padding:6px 10px; }
      .fm-attention-topbar-body{ display:none; }
      .fm-attention-topbar-title{ white-space:normal; font-size:12px; }
      .fm-attention-topbar-cta{ height:30px; padding:0 10px; font-size:11px; }
    }
  `;

  function injectCss(){
    if (document.getElementById('fmAttentionBannerCss')) return;
    const style = document.createElement('style');
    style.id = 'fmAttentionBannerCss';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function setLayoutVar(value){
    document.documentElement.style.setProperty('--attention-topbar-offset', value);
    document.body.style.setProperty('--attention-topbar-offset', value);
  }

  function clearLayoutVar(){
    document.documentElement.style.removeProperty('--attention-topbar-offset');
    document.body.style.removeProperty('--attention-topbar-offset');
  }

  function updateLayoutOffset(){
    const bar = document.getElementById('fmAttentionTopbar');
    if (!bar) { clearLayoutVar(); return; }
    const height = Math.ceil(bar.getBoundingClientRect().height || 0);
    setLayoutVar(`${height}px`);
  }

  function scheduleLayoutUpdate(){
    if (root.requestAnimationFrame) root.requestAnimationFrame(updateLayoutOffset);
    else setTimeout(updateLayoutOffset, 0);
  }

  function bindLayoutListener(){
    if (layoutListenerBound) return;
    layoutListenerBound = true;
    root.addEventListener('resize', scheduleLayoutUpdate);
    root.addEventListener('orientationchange', scheduleLayoutUpdate);
  }

  function entrySignature(entry){
    return entry ? [entry.id, entry.tone, entry.state, !!entry.cta_label, entry.dismissible?.topbar === true].join('|') : '';
  }

  function removeTopbar(){
    const bar = document.getElementById('fmAttentionTopbar');
    if (bar) bar.remove();
    document.body.classList.remove('has-attention-topbar');
    clearLayoutVar();
    renderedTopbarSignature = '';
  }

  function renderTopbar(){
    if (!document.body) return;
    injectCss();
    const entry = topEntryForSurface('topbar');
    if (!entry) { removeTopbar(); return; }
    const signature = entrySignature(entry);
    let bar = document.getElementById('fmAttentionTopbar');
    if (!bar || signature !== renderedTopbarSignature) {
      if (bar) bar.remove();
      bar = document.createElement('div');
      bar.id = 'fmAttentionTopbar';
      bar.className = `fm-attention-topbar tone-${entry.tone}`;
      bar.innerHTML = `
        <div class="fm-attention-topbar-inner">
          <div class="fm-attention-topbar-copy">
            ${entry.state === 'waiting' ? '<i class="fas fa-hourglass-half fm-attention-wait" aria-hidden="true"></i>' : ''}
            <span class="fm-attention-topbar-title" data-attention-title></span>
            <span class="fm-attention-topbar-body" data-attention-body></span>
          </div>
          <div class="fm-attention-topbar-right">
            ${entry.cta_label ? '<button type="button" class="fm-attention-topbar-cta" data-attention-cta></button>' : ''}
            ${entry.dismissible?.topbar === true ? `<button type="button" class="fm-attention-topbar-dismiss" data-attention-dismiss aria-label="${(globalThis.PlatformLanguage?.text("platform-banners","m_54fe29d1908de6","Dismiss") ?? "Dismiss")}"><i class="fas fa-times" aria-hidden="true"></i></button>` : ''}
          </div>
        </div>
      `;
      document.body.prepend(bar);
      bar.querySelector('[data-attention-cta]')?.addEventListener('click', (event) => {
        event.stopPropagation();
        applyEntryAction(findEntry(bar.dataset.attentionId));
      });
      bar.querySelector('[data-attention-dismiss]')?.addEventListener('click', (event) => {
        event.stopPropagation();
        dismiss(bar.dataset.attentionId, 'topbar');
      });
      renderedTopbarSignature = signature;
    }
    bar.dataset.attentionId = String(entry.id);
    const title = bar.querySelector('[data-attention-title]');
    const body = bar.querySelector('[data-attention-body]');
    const cta = bar.querySelector('[data-attention-cta]');
    if (title) title.textContent = entry.title;
    if (body) body.textContent = entry.body;
    if (cta) cta.textContent = entry.cta_label;
    document.body.classList.add('has-attention-topbar');
    bindLayoutListener();
    scheduleLayoutUpdate();
    setTimeout(updateLayoutOffset, 250);
  }

  // --- sidebar surface -------------------------------------------------------

  function renderSidebar(){
    const slot = document.getElementById('sidebarAttentionSlot');
    if (!slot) { renderedSidebarSignature = ''; return; }
    const entry = topEntryForSurface('sidebar');
    if (!entry) {
      slot.hidden = true;
      slot.innerHTML = '';
      renderedSidebarSignature = '';
      return;
    }
    const signature = [entrySignature(entry), entry.title, entry.body].join('|');
    if (signature !== renderedSidebarSignature) {
      slot.innerHTML = `
        <button type="button" class="sidebar-attention-card tone-${escapeHtml(entry.tone)}" data-attention-id="${escapeHtml(entry.id)}">
          <span class="sidebar-attention-copy">
            <strong>${entry.state === 'waiting' ? '<i class="fas fa-hourglass-half" aria-hidden="true"></i> ' : ''}${escapeHtml(entry.title)}</strong>
            ${entry.body ? `<small>${escapeHtml(entry.body)}</small>` : ''}
          </span>
          <i class="fas fa-chevron-right sidebar-attention-chevron" aria-hidden="true"></i>
        </button>
      `;
      slot.querySelector('[data-attention-id]')?.addEventListener('click', () => {
        applyEntryAction(findEntry(entry.id));
      });
      renderedSidebarSignature = signature;
    }
    slot.hidden = false;
  }

  function renderSurfaces(){
    if (!document.body) return;
    renderTopbar();
    renderSidebar();
  }

  // --- boot ------------------------------------------------------------------

  function portalOrgId(){
    const cfg = root.Portal?.cfg || {};
    return cleanText(cfg.userOrgId || cfg.orgId);
  }

  function startPolling(){
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      const org = portalOrgId() || currentOrgId;
      if (org) load(org).catch(() => null);
    }, POLL_MS);
  }

  function boot(){
    injectCss();
    const org = portalOrgId();
    if (org) load(org).catch(() => null);
    startPolling();
  }

  root.PlatformBanners = {
    subscribe,
    getState,
    load,
    refresh,
    registerClientSource,
    notifySourceChanged,
    entriesForSurface,
    topEntryForSurface,
    markSeen,
    dismiss,
    applyEntryAction
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 400));
  } else {
    setTimeout(boot, 400);
  }
})();
