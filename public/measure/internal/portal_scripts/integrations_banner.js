(function(){
  if (!window.Portal) return;

  const OFFSET_VAR = '--portal-integration-banner-offset';
  const state = {
    gmail: null,
    timer: null,
    popupBound: false,
    visibilityBound: false,
    resizeBound: false,
    loading: false,
    statusKnown: false,
  };

  function cfg(){
    return window.Portal?.cfg || window.PORTAL_CFG || {};
  }

  function serverEndpoint(){
    return cfg().endpoints?.server || window.Portal.internalLegacyEndpoint();
  }

  function api(payload){
    return window.Portal.apiPost(serverEndpoint(), payload);
  }

  function cacheKey(){
    const email = String(cfg().user?.email || 'anonymous').trim().toLowerCase();
    return `firstmate:gmail-banner:${email}`;
  }

  function backgroundSyncKey(provider){
    const email = String(cfg().user?.email || 'anonymous').trim().toLowerCase();
    const name = String(provider || 'gmail').trim().toLowerCase() || 'gmail';
    return `firstmate:${name}-background-sync:${email}`;
  }

  function readCachedState(){
    try {
      const raw = window.localStorage.getItem(cacheKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function writeCachedState(){
    try {
      window.localStorage.setItem(cacheKey(), JSON.stringify({
        gmail: state.gmail,
        statusKnown: state.statusKnown,
        savedAt: Date.now(),
      }));
    } catch (err) {
      // Ignore storage failures.
    }
  }

  function hydrateFromCache(){
    const cached = readCachedState();
    if (!cached) return false;
    state.gmail = cached.gmail || null;
    state.statusKnown = !!cached.statusKnown;
    return state.statusKnown;
  }

  function shouldKickoffBackgroundSync(provider){
    const name = String(provider || 'gmail').trim().toLowerCase() || 'gmail';
    if (name === 'gmail' && (!state.gmail || !state.gmail.connected || state.gmail.configured === false)) {
      return false;
    }
    const cooldownMs = name === 'ringcentral' ? 90000 : 45000;
    try {
      const raw = window.localStorage.getItem(backgroundSyncKey(name));
      const lastRun = raw ? Number(raw) : 0;
      return !(lastRun > 0 && (Date.now() - lastRun) < cooldownMs);
    } catch (err) {
      return true;
    }
  }

  function markBackgroundSyncKickoff(provider){
    const name = String(provider || 'gmail').trim().toLowerCase() || 'gmail';
    try {
      window.localStorage.setItem(backgroundSyncKey(name), String(Date.now()));
    } catch (err) {
      // Ignore storage failures.
    }
  }

  function emitBackgroundSyncEvent(provider, result){
    try {
      window.dispatchEvent(new CustomEvent('firstmate-background-sync-complete', {
        detail: {
          provider: String(provider || '').trim().toLowerCase(),
          result: result || null,
          at: Date.now(),
        },
      }));
    } catch (err) {
      // Ignore event dispatch issues.
    }
  }

  function kickoffBackgroundSync(provider, action, delayMs){
    const name = String(provider || '').trim().toLowerCase();
    const nextAction = String(action || '').trim();
    if (!name || !nextAction || !shouldKickoffBackgroundSync(name)) return;
    markBackgroundSyncKickoff(name);
    window.setTimeout(() => {
      api({ action: nextAction })
        .then((result) => {
          emitBackgroundSyncEvent(name, result);
          return result;
        })
        .catch((error) => {
          emitBackgroundSyncEvent(name, { success: false, error: error?.message || '' });
          return null;
        });
    }, Math.max(0, Number(delayMs || 0)));
  }

  function kickoffBackgroundSyncIfConnected(){
    kickoffBackgroundSync('gmail', 'gmail_background_sync', 50);
    kickoffBackgroundSync('ringcentral', 'ringcentral_background_sync', 120);
  }

  function setOffset(value){
    document.documentElement.style.setProperty(OFFSET_VAR, value || '0px');
  }

  function ensureMount(){
    let mount = document.getElementById('portalIntegrationBannerMount');
    if (mount) return mount;
    mount = document.createElement('div');
    mount.id = 'portalIntegrationBannerMount';
    document.body.appendChild(mount);
    return mount;
  }

  function ensureStyles(){
    if (document.getElementById('portalIntegrationBannerStyles')) return;
    const style = document.createElement('style');
    style.id = 'portalIntegrationBannerStyles';
    style.textContent = `
      #portalIntegrationBannerMount{
        position: fixed;
        top: 0;
        left: var(--sidebar-width, 270px);
        right: 0;
        z-index: 48;
        display: none;
        pointer-events: none;
      }
      .portal-integration-banner{
        min-height: 34px;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        padding: 6px 14px;
        border-bottom:1px solid rgba(191, 219, 254, 0.95);
        background: linear-gradient(90deg, rgba(239,246,255,.98) 0%, rgba(255,255,255,.98) 70%);
        color:#1e3a8a;
        backdrop-filter: blur(12px);
        box-shadow: 0 6px 20px rgba(15, 23, 42, 0.05);
        pointer-events: auto;
      }
      .portal-integration-banner__copy{
        display:flex;
        align-items:center;
        gap:10px;
        min-width:0;
        font-size:11px;
        font-weight:700;
        letter-spacing:.01em;
      }
      .portal-integration-banner__copy i{
        font-size:12px;
        color:#2563eb;
      }
      .portal-integration-banner__text{
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }
      .portal-integration-banner__actions{
        display:flex;
        align-items:center;
        gap:8px;
        flex-wrap:wrap;
      }
      .portal-integration-banner__btn{
        border:1px solid #bfdbfe;
        background:#fff;
        color:#1d4ed8;
        border-radius:999px;
        padding:5px 10px;
        font-size:11px;
        font-weight:800;
        cursor:pointer;
        transition:.16s ease;
      }
      .portal-integration-banner__btn:disabled{
        cursor:wait;
        opacity:.68;
      }
      .portal-integration-banner__btn:hover{
        background:#1d4ed8;
        border-color:#1d4ed8;
        color:#fff;
      }
      .portal-integration-banner__btn:disabled:hover{
        background:#fff;
        border-color:#bfdbfe;
        color:#1d4ed8;
      }
      .portal-integration-banner__btn--primary{
        border-color:#2563eb;
        background:#2563eb;
        color:#fff;
      }
      .portal-integration-banner__btn--primary:hover{
        background:#1d4ed8;
        border-color:#1d4ed8;
      }
      .portal-integration-banner__btn--primary:disabled,
      .portal-integration-banner__btn--primary:disabled:hover{
        background:#2563eb;
        border-color:#2563eb;
        color:#fff;
        opacity:.72;
      }
      @media (max-width: 900px){
        #portalIntegrationBannerMount{
          left: 0;
        }
        .portal-integration-banner{
          align-items:flex-start;
          flex-direction:column;
        }
        .portal-integration-banner__copy,
        .portal-integration-banner__text{
          white-space:normal;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function applyMeasuredOffset(){
    const mount = ensureMount();
    if (!mount || mount.style.display === 'none' || !mount.innerHTML.trim()) {
      setOffset('0px');
      return;
    }
    const nextOffset = Math.max(0, mount.offsetHeight || 0);
    setOffset(`${nextOffset}px`);
  }

  function hideBanner(){
    const mount = ensureMount();
    mount.innerHTML = '';
    mount.style.display = 'none';
    setOffset('0px');
  }

  function bannerState(){
    const calendar = state.gmail?.calendar || null;
    if (!state.statusKnown) {
      return {
        visible: false,
        copy: '',
        showConnect: false,
      };
    }
    if (!state.gmail) {
      return {
        visible: true,
        copy: state.loading
          ? 'Refreshing Google connection status...'
          : 'Google connection status could not be confirmed. Refresh or reconnect before relying on CRM email and calendar.',
        showConnect: true,
      };
    }
    if (state.gmail.configured === false) {
      return {
        visible: true,
        copy: state.loading
          ? 'Refreshing Google connection status...'
          : 'Google integrations are not configured on this CRM server yet.',
        showConnect: false,
      };
    }
    if (state.gmail.connected && calendar && calendar.connected) {
      return {
        visible: false,
        copy: '',
        showConnect: false,
      };
    }
    if (!state.gmail.connected && calendar && !calendar.connected) {
      return {
        visible: true,
        copy: state.loading
          ? 'Refreshing Google connection status...'
          : 'Google is not fully connected for your CRM account. Connect it so Gmail send/sync and Google Calendar scheduling stay active.',
        showConnect: true,
      };
    }
    if (!state.gmail.connected) {
      return {
        visible: true,
        copy: state.loading
          ? 'Refreshing Google connection status...'
          : 'Gmail is not connected for your CRM account. Connect Google so lead email send, replies, and inbox sync stay active.',
        showConnect: true,
      };
    }
    return {
      visible: true,
      copy: state.loading
        ? 'Refreshing Google connection status...'
        : 'Google Calendar is not connected for your CRM account. Connect Google so lead scheduling can create real calendar events and invites.',
      showConnect: true,
    };
  }

  function render(){
    const mount = ensureMount();
    if (!mount) return;
    const banner = bannerState();
    if (!banner.visible) {
      hideBanner();
      return;
    }
    mount.style.display = 'block';
    mount.innerHTML = `
      <div class="portal-integration-banner">
        <div class="portal-integration-banner__copy">
          <i class="fas fa-envelope-circle-check"></i>
          <div class="portal-integration-banner__text">${banner.copy}</div>
        </div>
        <div class="portal-integration-banner__actions">
          <button class="portal-integration-banner__btn" type="button" data-google-banner-refresh ${state.loading ? 'disabled' : ''}>${state.loading ? 'Refreshing...' : 'Refresh'}</button>
          ${banner.showConnect ? `<button class="portal-integration-banner__btn portal-integration-banner__btn--primary" type="button" data-google-banner-connect ${state.loading ? 'disabled' : ''}>Connect Google</button>` : ''}
        </div>
      </div>
    `;
    applyMeasuredOffset();
  }

  function openConnectPopup(){
    const url = `${serverEndpoint()}?action=google_begin_connect`;
    window.open(
      url,
      'firstmate_google_connect',
      'width=560,height=760,resizable=yes,scrollbars=yes'
    );
  }

  async function refresh(forceRender){
    if (state.loading) return;
    state.loading = true;
    if (forceRender !== false) render();
    try {
      const data = await api({ action: 'gmail_connection_status' }).catch(() => null);
      if (data && Object.prototype.hasOwnProperty.call(data, 'gmail')) {
        state.gmail = data.gmail || null;
        state.statusKnown = true;
        writeCachedState();
        kickoffBackgroundSyncIfConnected();
      }
    } finally {
      state.loading = false;
      if (forceRender !== false) render();
    }
  }

  function scheduleInitialRefresh(){
    const run = () => refresh(true);
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 1500 });
      return;
    }
    window.setTimeout(run, 180);
  }

  function bindEvents(){
    if (!state.popupBound) {
      window.addEventListener('message', (event) => {
        const type = event?.data?.type || '';
        if (
          type === 'firstmate-gmail-connected' ||
          type === 'firstmate-gmail-disconnected' ||
          type === 'firstmate-gmail-error'
        ) {
          refresh(true);
        }
      });

      document.addEventListener('click', (event) => {
        if (event.target.closest('[data-google-banner-connect]')) {
          openConnectPopup();
          return;
        }
        if (event.target.closest('[data-google-banner-refresh]')) {
          refresh(true);
        }
      });

      state.popupBound = true;
    }

    if (!state.visibilityBound) {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refresh(true);
      });
      window.addEventListener('focus', () => refresh(true));
      state.visibilityBound = true;
    }

    if (!state.resizeBound) {
      window.addEventListener('resize', applyMeasuredOffset);
      state.resizeBound = true;
    }
  }

  function init(){
    ensureStyles();
    ensureMount();
    bindEvents();
    if (hydrateFromCache()) {
      render();
    } else {
      hideBanner();
    }
    scheduleInitialRefresh();
    if (!state.timer) {
      state.timer = setInterval(() => refresh(true), 60000);
    }
    window.PortalIntegrationsBanner = {
      refresh: () => refresh(true),
      getState: () => ({ gmail: state.gmail, statusKnown: state.statusKnown }),
      openConnectPopup,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
