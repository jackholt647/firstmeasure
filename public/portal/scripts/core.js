/* scripts/core.js (DROP-IN REPLACEMENT)
 * Changes:
 * - Stores permissions from get_credits response into window.Portal.currentUser
 * - Adds window.Portal.util.hasPerm helper
 * - Tab injection UI moved OUTSIDE the credits card
 */


(function(){
  const APP = window.__APP || {};
  const $ = (sel, root=document) => root.querySelector(sel);

  window.Portal = window.Portal || {};
  window.Portal.currentUser = {
    permissions: {}, // populated by refreshCredits
    user: {},
    membership: {},
    identity: {},
    roleIds: [],
    entitlements: {},
    applicationAccess: {
      management: { enabled:true, permissions:{} },
      field: { enabled:false, permissions:{} }
    }
  };
  window.Portal.currentUser.canAccessApplication = (applicationId) => (
    window.Portal.currentUser.applicationAccess?.[canonicalApplicationId(applicationId)]?.enabled === true
  );
  window.Portal.currentUser.hasApplicationPermission = (applicationId, permission) => {
    const entry = window.Portal.currentUser.applicationAccess?.[canonicalApplicationId(applicationId)];
    if (!entry?.enabled) return false;
    if (!permission) return true;
    return String(permission).split('|').some((key) => {
      const item = key.trim();
      return entry.permissions?.[item] === true || (entry.permissions?.[item] !== false && entry.permissions?.['*'] === true);
    });
  };

  function escapeHtml(s){
    return String(s ?? '')
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'","&#039;");
  }

  function injectCSS(id, cssText){
    const elId = `css_${id}`;
    let style = document.getElementById(elId);
    if (!style){
      style = document.createElement('style');
      style.id = elId;
      document.head.appendChild(style);
    }
    style.textContent = cssText || '';
  }

  const SIDEBAR_WIDTH_DEFAULT = 250;
  const SIDEBAR_WIDTH_MIN = 220;
  const SIDEBAR_WIDTH_MAX = 420;
  const GLOBAL_COMPACT_SIDEBAR_OWNER = 'platform.always-collapsible-left-column';
  const SIDEBAR_COMPACT_STATE_STORAGE_KEY = [
    'fm.sidebar.compact-expanded',
    String(APP.userOrgId || APP.orgId || 'organization'),
    String(APP.userId || APP.user_id || 'user')
  ].join(':');
  const sidebarCompactOwners = new Set();
  let sidebarCompactExpanded = loadSidebarCompactExpandedPreference();
  let sidebarGlobalCompactEnabled = false;

  function loadSidebarCompactExpandedPreference(){
    try {
      return window.localStorage?.getItem(SIDEBAR_COMPACT_STATE_STORAGE_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function saveSidebarCompactExpandedPreference(expanded){
    try {
      window.localStorage?.setItem(SIDEBAR_COMPACT_STATE_STORAGE_KEY, expanded ? '1' : '0');
    } catch (_) {
      // Storage can be unavailable in private or embedded browser contexts.
    }
  }

  function sidebarFlagValue(flag, fallback){
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    return flags?.value?.('platform', flag, fallback) ?? fallback;
  }

  function sidebarTemporaryExpansionMode(){
    return String(sidebarFlagValue('left_column_expansion_mode', 'resize')).trim().toLowerCase() === 'overlap'
      ? 'overlap'
      : 'resize';
  }

  function normalizeSidebarWidth(value){
    const width = Math.round(Number(value));
    return Number.isFinite(width)
      ? Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width))
      : SIDEBAR_WIDTH_DEFAULT;
  }

  function applySidebarWidth(value){
    const width = normalizeSidebarWidth(value);
    document.documentElement.style.setProperty('--sidebar', `${width}px`);
    return width;
  }

  async function loadSidebarWidthPreference(){
    const identityPreferences = window.Portal?.currentUser?.identity?.preferences || {};
    applySidebarWidth(identityPreferences.sidebar_width);
    if (!window.PlatformAPI?.preferences?.get) return;
    try {
      const result = await window.PlatformAPI.preferences.get();
      const preferences = result?.preferences || {};
      if (window.Portal?.currentUser?.identity) {
        window.Portal.currentUser.identity.preferences = preferences;
      }
      applySidebarWidth(preferences.sidebar_width);
    } catch (_) {
      // The wider default remains usable when preferences cannot be loaded.
    }
  }

  window.Portal.sidebarWidth = {
    default: SIDEBAR_WIDTH_DEFAULT,
    min: SIDEBAR_WIDTH_MIN,
    max: SIDEBAR_WIDTH_MAX,
    normalize: normalizeSidebarWidth,
    apply: applySidebarWidth
  };

  function syncSidebarMode(){
    const sidebar = document.getElementById('mainSidebar');
    const toggle = document.getElementById('sidebarCompactToggle');
    const compact = sidebarCompactOwners.size > 0;
    if (!sidebar) return compact;
    const wasCompact = sidebar.classList.contains('sidebar-compact');
    if (!compact || sidebarCompactExpanded) sidebar.classList.remove('sidebar-compact-edge-held');
    sidebar.classList.toggle('sidebar-compact', compact);
    sidebar.classList.toggle('sidebar-compact-expanded', compact && sidebarCompactExpanded);
    sidebar.classList.toggle('sidebar-compact-overlap', compact && sidebarTemporaryExpansionMode() === 'overlap');
    if (compact && !wasCompact) setSidebarPanel('apps');
    if (toggle) {
      const expanded = compact && sidebarCompactExpanded;
      toggle.setAttribute('aria-pressed', expanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', expanded ? 'Collapse sidebar' : 'Keep sidebar expanded');
      toggle.title = expanded ? 'Collapse sidebar' : 'Keep sidebar expanded';
    }
    window.dispatchEvent(new CustomEvent('fm:sidebar-mode:changed', {
      detail: {
        mode: compact ? 'compact' : 'expanded',
        pinnedExpanded: compact && sidebarCompactExpanded,
        temporaryExpansion: sidebarTemporaryExpansionMode(),
        global: sidebarGlobalCompactEnabled
      }
    }));
    return compact;
  }

  function requestCompactSidebar(owner = 'portal'){
    const key = String(owner || 'portal');
    sidebarCompactOwners.add(key);
    syncSidebarMode();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      sidebarCompactOwners.delete(key);
      syncSidebarMode();
    };
  }

  function releaseCompactSidebar(owner = 'portal'){
    sidebarCompactOwners.delete(String(owner || 'portal'));
    syncSidebarMode();
  }

  function setSidebarCompactExpanded(expanded){
    sidebarCompactExpanded = expanded === true;
    saveSidebarCompactExpandedPreference(sidebarCompactExpanded);
    syncSidebarMode();
    return sidebarCompactExpanded;
  }

  function applySidebarLayoutFeatureFlags(){
    const nextGlobal = sidebarFlagValue('always_collapsible_left_column', false) === true;
    if (nextGlobal !== sidebarGlobalCompactEnabled) {
      sidebarGlobalCompactEnabled = nextGlobal;
      if (nextGlobal) {
        sidebarCompactOwners.add(GLOBAL_COMPACT_SIDEBAR_OWNER);
      } else {
        sidebarCompactOwners.delete(GLOBAL_COMPACT_SIDEBAR_OWNER);
      }
    }
    syncSidebarMode();
  }

  window.Portal.sidebarMode = {
    requestCompact: requestCompactSidebar,
    releaseCompact: releaseCompactSidebar,
    setExpanded: setSidebarCompactExpanded,
    toggleExpanded(){ return setSidebarCompactExpanded(!sidebarCompactExpanded); },
    current(){ return sidebarCompactOwners.size > 0 ? 'compact' : 'expanded'; },
    expansionMode: sidebarTemporaryExpansionMode
  };
  document.getElementById('sidebarCompactToggle')?.addEventListener('click', () => {
    window.Portal.sidebarMode.toggleExpanded();
  });
  document.getElementById('mainSidebar')?.addEventListener('mouseenter', (event) => {
    event.currentTarget?.classList.remove('sidebar-compact-edge-held');
  });
  document.getElementById('mainSidebar')?.addEventListener('mouseleave', (event) => {
    const sidebar = event.currentTarget;
    if (sidebar?.classList.contains('sidebar-compact') && !sidebar.classList.contains('sidebar-compact-expanded')) {
      const leftEdge = sidebar.getBoundingClientRect().left;
      if (event.relatedTarget === null && event.clientX <= leftEdge) {
        sidebar.classList.add('sidebar-compact-edge-held');
        return;
      }
      sidebar.classList.remove('sidebar-compact-edge-held');
      setSidebarPanel('apps');
    }
  });
  window.addEventListener('fm:user-preferences:updated', (event) => {
    applySidebarWidth(event?.detail?.preferences?.sidebar_width);
  });

  function syncVisualViewportVars(){
    const viewport = window.visualViewport;
    const height = Math.max(320, Math.round(viewport?.height || window.innerHeight || document.documentElement.clientHeight || 0));
    const width = Math.max(320, Math.round(viewport?.width || window.innerWidth || document.documentElement.clientWidth || 0));
    document.documentElement.style.setProperty('--fm-visual-vh', `${height}px`);
    document.documentElement.style.setProperty('--fm-visual-vw', `${width}px`);
  }

  syncVisualViewportVars();
  window.addEventListener('resize', syncVisualViewportVars, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(syncVisualViewportVars, 80), { passive: true });
  window.visualViewport?.addEventListener?.('resize', syncVisualViewportVars, { passive: true });
  window.visualViewport?.addEventListener?.('scroll', syncVisualViewportVars, { passive: true });

  function formatDate(d){
    try{
      const s = String(d ?? '');
      const isoish = s.includes('T') ? s : s.replace(' ', 'T');
      const withZone = (isoish.includes('Z') || isoish.includes('+')) ? isoish : (isoish + 'Z');
      return new Date(withZone).toLocaleString(globalThis.PlatformLanguage?.formatLocale?.());
    }catch(e){
      return String(d ?? '');
    }
  }

  const AUTH_NOTICE_KEY = 'fm_login_notice';
  let authRedirecting = false;
  let focusSessionCheckSuppressedUntil = 0;

  function suppressFocusSessionCheck(durationMs = 1000){
    const duration = Math.max(0, Math.min(5000, Number(durationMs) || 0));
    focusSessionCheckSuppressedUntil = Math.max(focusSessionCheckSuppressedUntil, Date.now() + duration);
  }

  function currentReturnTarget(){
    return `${location.pathname || './'}${location.search || ''}${location.hash || ''}`;
  }

  function loginUrl(reason = 'expired'){
    const url = new URL('login.php', location.href);
    url.searchParams.set('redirect', currentReturnTarget());
    if (reason) url.searchParams.set(reason, '1');
    return url.toString();
  }

  function isAuthFailure(res, data, text = ''){
    const status = Number(res?.status || 0);
    const message = String(
      data?.error
      || data?.message
      // A successful payload may include historical provider errors in a
      // statement or report. Only the current response can expire the session.
      || (data == null && !res?.ok ? text : '')
      || ''
    ).toLowerCase();

    return status === 401
      || message.includes('authentication required')
      || message.includes('not authenticated')
      || message.includes('not logged in')
      || message.includes('login required')
      || message.includes('session expired');
  }

  function redirectToLogin(reason = 'expired'){
    if (authRedirecting || /\/login\.php$/i.test(location.pathname || '')) return;
    authRedirecting = true;
    try {
      sessionStorage.setItem(AUTH_NOTICE_KEY, 'Your session expired. Please log in again.');
    } catch(e) {}
    window.dispatchEvent(new CustomEvent('fm:auth:expired'));
    window.location.href = loginUrl(reason);
  }

  function authRequiredError(){
    const err = new Error('Authentication required.');
    err.code = 'AUTH_REQUIRED';
    return err;
  }

  async function checkSession({ redirect = true } = {}){
    const fd = new FormData();
    fd.append('action', 'auth_status');
    fd.append('actor_email', APP.userEmail || '');
    fd.append('actor_name', APP.userName || '');
    fd.append('actor_org_id', APP.userOrgId || '');
    fd.append('actor_team_id', APP.userTeamId || APP.userBranchId || '');
    const res = await fetch(APP.serverEndpoint, {
      method: 'POST',
      body: fd,
      cache: 'no-store',
      credentials: 'include'
    });
    const data = await res.json().catch(()=>null);
    if (!res.ok || !data || data.success !== true) return true;
    const authenticated = !!data.authenticated;
    if (!authenticated && redirect) redirectToLogin('expired');
    return authenticated;
  }

  function firstMeasureBaseUrl(){
    if (window.FirstMeasureAPI?.baseUrl) return window.FirstMeasureAPI.baseUrl();
    throw new Error('FirstMeasureAPI client is not loaded.');
  }

  function platformApiBaseUrl(){
    if (window.PlatformAPI?.baseUrl) return window.PlatformAPI.baseUrl();
    throw new Error('PlatformAPI client is not loaded.');
  }

  function currentActor(){
    const actor = {};
    const email = String(APP.userEmail || '').trim();
    const name = String(APP.userName || '').trim();
    const organizationId = String(APP.userOrgId || '').trim();
    const teamId = String(APP.userTeamId || '').trim();
    if (email) actor.email = email;
    if (name) actor.name = name;
    if (organizationId) actor.organization_id = organizationId;
    if (teamId) actor.team_id = teamId;
    return actor;
  }

  function fmUrl(path){
    if (window.FirstMeasureAPI?.url) return window.FirstMeasureAPI.url(path);
    throw new Error('FirstMeasureAPI client is not loaded.');
  }

  function platformUrl(path){
    if (window.PlatformAPI?.url) return window.PlatformAPI.url(path);
    throw new Error('PlatformAPI client is not loaded.');
  }

  function currentBranchId(){
    return String(APP.userBranchId || APP.branchId || 'default').trim() || 'default';
  }

  async function platformJson(path, options = {}){
    if (window.PlatformAPI?.request) return await window.PlatformAPI.request(path, options);
    throw new Error('PlatformAPI client is not loaded.');
  }

  async function getBranchModule(moduleId, branchId = currentBranchId()){
    const orgId = String(APP.userOrgId || '').trim();
    if (!orgId) return null;
    if (window.PlatformAPI?.branchModules?.get) return await window.PlatformAPI.branchModules.get(orgId, branchId, moduleId);
    return (await platformJson(`/organizations/${encodeURIComponent(orgId)}/branch/${encodeURIComponent(branchId)}/modules/${encodeURIComponent(moduleId)}`))?.module || null;
  }

  async function saveBranchModule(moduleId, data, metadata = {}, branchId = currentBranchId()){
    const orgId = String(APP.userOrgId || '').trim();
    if (!orgId) return null;
    if (window.PlatformAPI?.branchModules?.save) return await window.PlatformAPI.branchModules.save(orgId, branchId, moduleId, data || {}, metadata || {});
    return (await platformJson(`/organizations/${encodeURIComponent(orgId)}/branch/${encodeURIComponent(branchId)}/modules/${encodeURIComponent(moduleId)}`, {
      method: 'PUT',
      body: { data: data || {}, metadata: metadata || {} },
    }))?.module || null;
  }

  function googleMapsApiKey(){
    const explicit = String(APP.googleMapsApiKey || '').trim();
    if (explicit) return explicit;
    const scripts = Array.from(document.scripts || []);
    for (const script of scripts) {
      const src = String(script?.src || '');
      if (!src.includes('maps.googleapis.com/maps/api/js')) continue;
      try{
        const url = new URL(src, location.href);
        const key = String(url.searchParams.get('key') || '').trim();
        if (key) return key;
      }catch(e){}
    }
    return '';
  }

  function projectTypePrice(type){
    const key = String(type || '').trim().toLowerCase();
    return window.PlatformCommerce.price(key === 'commercial' || key === 'multifamily' ? key : 'residential');
  }

  function gutterReportAddon(){
    const amount = window.PlatformCommerce.price('gutters');
    return Number.isFinite(amount) ? amount : 2;
  }

  function weatherReportAddon(){
    const amount = window.PlatformCommerce.price('weather');
    return Number.isFinite(amount) ? amount : 5;
  }

  function instantReportAddon(projectType){
    const type = String(projectType || 'residential').trim().toLowerCase();
    return window.PlatformCommerce.price('instant_' + (type === 'commercial' || type === 'multifamily' ? type : 'residential'));
  }

  function firstMeasureFlagEnabled(flag, fallback = false){
    const appFlags = window.PlatformAPI?.appFlags;
    if (appFlags?.current?.()) {
      if (appFlags.has?.('firstmeasure', flag)) return true;
      const value = appFlags.value?.('firstmeasure', flag, undefined);
      return value === undefined ? fallback : value !== false;
    }
    return fallback;
  }

  function shouldIncludeGutterMeasurements(projectType, value){
    return firstMeasureFlagEnabled('gutter_reports', false)
      && String(projectType || '').trim().toLowerCase() === 'residential'
      && (value === true || value === '1' || value === 1 || String(value || '').trim().toLowerCase() === 'true');
  }

  function orderAmount(projectType, pinCount, includeGutterMeasurements){
    const base = projectTypePrice(projectType);
    if (projectType === 'commercial' || projectType === 'multifamily') {
      return base * Math.max(1, pinCount);
    }
    return base + (includeGutterMeasurements ? gutterReportAddon() : 0);
  }

  function orderAmountWithWeather(projectType, pinCount, includeGutterMeasurements, includeWeatherReport){
    return orderAmount(projectType, pinCount, includeGutterMeasurements) + (includeWeatherReport ? weatherReportAddon() : 0);
  }

  function moneyAmount(value){
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  function formatMoney(value){
    const amount = moneyAmount(value);
    return amount % 1 === 0 ? String(amount.toFixed(0)) : amount.toFixed(2);
  }

  function activeReferralDiscount(){
    const discount = window.Portal?.referralDiscount;
    if (!discount || typeof discount !== 'object') return null;
    const percent = Math.max(0, Math.min(100, parseInt(String(discount.discount_percent ?? 50), 10) || 0));
    const remaining = parseInt(String(discount.seconds_remaining ?? 0), 10) || 0;
    const status = String(discount.status || '').trim().toLowerCase();
    if (!discount.active || percent <= 0 || remaining <= 0 || (status && status !== 'active')) return null;
    return { ...discount, discount_percent: percent, seconds_remaining: remaining };
  }

  function standardBaseAmountForOrder(projectType, pinCount, reportMode = 'full'){
    const mode = String(reportMode || 'full').trim().toLowerCase();
    const type = String(projectType || 'residential').trim().toLowerCase();
    const count = Math.max(1, parseInt(String(pinCount || 1), 10) || 1);
    const base = projectTypePrice(type);
    if (mode === 'instant' || mode === 'both') {
      const unit = base + instantReportAddon(type);
      return type === 'commercial' || type === 'multifamily' ? unit * count : unit;
    }
    if (type === 'commercial' || type === 'multifamily') {
      return base * count;
    }
    return base;
  }

  function referralDiscountPreview(totalAmount, discountableAmount){
    const original = Math.max(0, moneyAmount(totalAmount));
    const discount = activeReferralDiscount();
    const discountable = Math.max(0, Math.min(original, moneyAmount(discountableAmount)));
    if (!discount || original < 1 || discountable < 1) {
      return {
        active: false,
        original_amount: original,
        final_amount: original,
        discount_amount: 0,
        discountable_amount: discountable,
        discount_percent: discount?.discount_percent || 0,
      };
    }
    const discountAmount = moneyAmount(discountable * (discount.discount_percent / 100));
    return {
      active: discountAmount > 0,
      original_amount: original,
      final_amount: Math.max(0.01, moneyAmount(original - discountAmount)),
      discount_amount: discountAmount,
      discountable_amount: discountable,
      discount_percent: discount.discount_percent,
      offer: discount,
    };
  }

  async function fmJson(path, options = {}){
    try {
      if (!window.FirstMeasureAPI?.request) throw new Error('FirstMeasureAPI client is not loaded.');
      return await window.FirstMeasureAPI.request(path, options);
    } catch (error) {
      const data = error?.data || null;
      const text = error?.responseText || '';
      if (isAuthFailure({ status: error?.status || 0 }, data, text)) {
        redirectToLogin('expired');
        throw authRequiredError();
      }
      throw error;
    }
  }

  async function fmPost(path, payload){
    return await fmJson(path, { method: 'POST', body: /weather\/order/.test(path)?{...payload,commercial_pricing_revision:window.PlatformCommerce.current().pricing_revision}:payload || {} });
  }

  async function portalActionJson(action, fields = {}){
    const actor = currentActor();
    const fd = new FormData();
    fd.append('action', action);
    fd.append('actor_email', actor.email || APP.userEmail || '');
    fd.append('actor_name', actor.name || APP.userName || '');
    fd.append('actor_org_id', actor.organization_id || APP.userOrgId || '');
    fd.append('actor_team_id', actor.team_id || APP.userTeamId || APP.userBranchId || '');
    fd.append('return_base_url', `${location.origin}${location.pathname.replace(/\/[^/]*$/, '')}`);
    for (const [k, v] of Object.entries(fields || {})) fd.append(k, String(v ?? ''));
    try {
      console.log('[PlatformPortalAction]', {
        action,
        actor_email: actor.email || APP.userEmail || '',
        actor_org_id: actor.organization_id || APP.userOrgId || '',
        has_actor: !!(actor.email || APP.userEmail)
      });
    } catch(e) {}
    const csrfName = (APP.platformSessionCookieName || 'fm_platform_session') + '_csrf';
    const csrf = document.cookie.split('; ').find(row => row.startsWith(csrfName+'='))?.slice(csrfName.length+1);
    const res = await fetch(APP.serverEndpoint, { method:'POST', body: fd, credentials:'include', headers: csrf ? {'X-Platform-CSRF':decodeURIComponent(csrf)} : {} });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch(e) {
      data = null;
    }
    if (
      isAuthFailure(res, data, text)
      || (!data && /<title>\s*FirstMate\s*-\s*Login\s*<\/title>|id=["']loginForm["']/i.test(text || ''))
    ) {
      redirectToLogin('expired');
      throw authRequiredError();
    }
    return { res, data };
  }

  function parseJsonMaybe(value, fallback){
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return value;
    const raw = String(value ?? '').trim();
    if (!raw) return fallback;
    try{
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    }catch(e){
      return fallback;
    }
  }

  function asNumberOrNull(value){
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  }

  function cleanText(...values){
    for (const value of values) {
      if (value && typeof value === 'object') continue;
      const text = String(value ?? '').trim();
      if (!text) continue;
      const lowered = text.toLowerCase();
      if (lowered === 'n/a' || lowered === 'na' || lowered === 'none' || lowered === 'null' || lowered === 'undefined' || text === '-' || text === '\u2014') continue;
      return text;
    }
    return '';
  }

  function objectText(source, ...keys){
    if (!source || typeof source !== 'object') return '';
    return cleanText(...keys.map((key) => source?.[key]));
  }

  function syncBoolean(value, fallback = false){
    if (value === undefined || value === null || value === '') return Boolean(fallback);
    if (value === true || value === 1 || value === '1') return true;
    const text = String(value).trim().toLowerCase();
    return text === 'true' || text === 'yes' || text === 'on';
  }

  function firstMeasureRejectionMetadata(source = {}, fallback = {}){
    const sourceReorder = (source.rejection_reorder && typeof source.rejection_reorder === 'object' && !Array.isArray(source.rejection_reorder))
      ? source.rejection_reorder
      : null;
    const fallbackReorder = (fallback.rejection_reorder && typeof fallback.rejection_reorder === 'object' && !Array.isArray(fallback.rejection_reorder))
      ? fallback.rejection_reorder
      : null;
    return {
      rejection_reason: cleanText(source.rejection_reason, fallback.rejection_reason),
      rejection_reason_details: Array.isArray(source.rejection_reason_details)
        ? source.rejection_reason_details
        : (Array.isArray(fallback.rejection_reason_details) ? fallback.rejection_reason_details : []),
      rejection_message: cleanText(source.rejection_message, fallback.rejection_message),
      rejection_note: cleanText(source.rejection_note, source.rejection_notes, fallback.rejection_note, fallback.rejection_notes),
      customer_rejection_title: cleanText(source.customer_rejection_title, fallback.customer_rejection_title),
      customer_rejection_message: cleanText(source.customer_rejection_message, fallback.customer_rejection_message),
      correct_project_type: cleanText(source.correct_project_type, source.rejection_correct_project_type, fallback.correct_project_type, fallback.rejection_correct_project_type),
      rejection_correct_project_type: cleanText(source.rejection_correct_project_type, source.correct_project_type, fallback.rejection_correct_project_type, fallback.correct_project_type),
      reorder_project_type: cleanText(source.reorder_project_type, source.correct_project_type, fallback.reorder_project_type, fallback.correct_project_type),
      reorder_url: cleanText(source.reorder_url, sourceReorder?.url, fallback.reorder_url, fallbackReorder?.url),
      rejection_reorder: sourceReorder || fallbackReorder || null,
      instant_rejection_reason: cleanText(source.instant_rejection_reason, fallback.instant_rejection_reason),
      refund_issued: syncBoolean(source.refund_issued, fallback.refund_issued),
      refund_pending: syncBoolean(source.refund_pending, fallback.refund_pending),
      refund_amount: Number(source.refund_amount ?? fallback.refund_amount ?? 0) || 0,
      refund_reason: cleanText(source.refund_reason, fallback.refund_reason),
      refund_at: cleanText(source.refund_at, fallback.refund_at),
      refund_scope: cleanText(source.refund_scope, fallback.refund_scope),
      refund_to_email: cleanText(source.refund_to_email, fallback.refund_to_email),
      refund_to_organization_id: cleanText(source.refund_to_organization_id, fallback.refund_to_organization_id),
    };
  }

  function contactIdentityKey(contact = {}){
    const email = cleanText(contact.email).toLowerCase();
    if (email) return `email:${email}`;
    const digits = cleanText(contact.phone).replace(/\D+/g, '');
    if (digits.length >= 7) return `phone:${digits}`;
    const id = cleanText(contact.id, contact.contact_id, contact.primary_contact_id);
    if (id) return `id:${id}`;
    const name = cleanText(contact.name).toLowerCase();
    return name ? `name:${name}` : '';
  }

  function contactHasInfo(contact = {}){
    return !!cleanText(contact.name, contact.email, contact.phone);
  }

  function contactCandidates(project = {}){
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    const customer = project.customer && typeof project.customer === 'object' && !Array.isArray(project.customer) ? project.customer : {};
    const resident = project.resident && typeof project.resident === 'object' && !Array.isArray(project.resident) ? project.resident : {};
    const candidates = contacts
      .filter((contact) => contact && typeof contact === 'object')
      .map((contact) => ({
        id: cleanText(contact.id, contact.contact_id),
        contact_id: cleanText(contact.contact_id, contact.id),
        name: cleanText(contact.name, contact.full_name, contact.display_name),
        email: cleanText(contact.email, contact.email_address),
        phone: cleanText(contact.phone, contact.phone_number, contact.mobile),
        address: cleanText(contact.address, contact.default_address),
        default_address: cleanText(contact.default_address, contact.address),
        role: cleanText(contact.role),
        primary: contact.primary === true
      }));

    candidates.push({
      id: cleanText(project.contact_id, project.primary_contact_id, customer.id, resident.id),
      contact_id: cleanText(project.contact_id, project.primary_contact_id, customer.id, resident.id),
      name: cleanText(
        project.customer_name,
        project.customerName,
        project.primary_contact_name,
        project.resident_name,
        project.residentName,
        typeof project.resident === 'string' ? project.resident : '',
        objectText(customer, 'name', 'full_name', 'display_name'),
        objectText(resident, 'name', 'full_name', 'display_name')
      ),
      email: cleanText(
        project.customer_email,
        project.customerEmail,
        project.primary_contact_email,
        project.resident_email,
        project.residentEmail,
        objectText(customer, 'email', 'email_address'),
        objectText(resident, 'email', 'email_address')
      ),
      phone: cleanText(
        project.customer_phone,
        project.customerPhone,
        project.primary_contact_phone,
        project.resident_phone,
        project.residentPhone,
        objectText(customer, 'phone', 'phone_number', 'mobile'),
        objectText(resident, 'phone', 'phone_number', 'mobile')
      ),
      address: cleanText(
        project.contact_address,
        project.customer_address,
        project.primary_contact_address,
        objectText(customer, 'address', 'default_address'),
        objectText(resident, 'address', 'default_address')
      ),
      default_address: cleanText(
        project.contact_address,
        project.customer_address,
        project.primary_contact_address,
        objectText(customer, 'address', 'default_address'),
        objectText(resident, 'address', 'default_address')
      ),
      role: '',
      primary: false
    });

    const byKey = new Map();
    const order = [];
    candidates.filter(contactHasInfo).forEach((contact) => {
      const key = contactIdentityKey(contact);
      if (!key) return;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, contact);
        order.push(key);
        return;
      }
      byKey.set(key, {
        id: cleanText(existing.id, contact.id),
        contact_id: cleanText(existing.contact_id, existing.id, contact.contact_id, contact.id),
        name: cleanText(existing.name, contact.name),
        email: cleanText(existing.email, contact.email),
        phone: cleanText(existing.phone, contact.phone),
        address: cleanText(existing.address, contact.address),
        default_address: cleanText(existing.default_address, contact.default_address, existing.address, contact.address),
        role: cleanText(existing.role, contact.role),
        primary: existing.primary === true || contact.primary === true
      });
    });
    return order.map((key) => byKey.get(key)).filter(Boolean);
  }

  const isPlatformProjectId = (value) => /^(project|base)_/i.test(String(value || '').trim());

  const isGeneratedProjectTitle = (value) => {
    const text = cleanText(value).toLowerCase();
    return !text || text === 'project' || text === 'new project' || /^\d+$/.test(text) || /^(project|base|platform_project)_[a-z0-9_-]+$/i.test(text);
  };

  const firstProjectDisplayText = (...values) => {
    for (const value of values) {
      const text = cleanText(value);
      if (text && !isGeneratedProjectTitle(text)) return text;
    }
    return '';
  };

  const cleanMeasurementText = (...values) => {
    for (const value of values) {
      const text = cleanText(value);
      if (text && !isPlatformProjectId(text)) return text;
    }
    return '';
  };

  const measurementIdFromAssetUrl = (...values) => {
    for (const value of values) {
      const text = cleanText(value);
      if (!text) continue;
      const match = text.match(/\/projects\/([^/?#]+)/i);
      const id = match ? cleanMeasurementText(decodeURIComponent(match[1] || '')) : '';
      if (id) return id;
    }
    return '';
  };

  const isFirstMeasureCompleteStatus = (...values) => values
    .map((value) => cleanText(value).toLowerCase())
    .some((status) => status === 'completed' || status === 'complete');

  const parseReleaseHoldDate = (value) => {
    const text = cleanText(value);
    if (!text) return null;
    const hasExplicitZone = /[zZ]|[+-]\d\d:?\d\d$/.test(text);
    const isoish = text.includes('T') ? text : text.replace(' ', 'T');
    const parsed = Date.parse(hasExplicitZone ? isoish : `${isoish}Z`);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  };

  const reportReleaseHoldIsActive = (...sources) => sources.some((source) => {
    if (!source || typeof source !== 'object') return false;
    const raw = (source.raw && typeof source.raw === 'object') ? source.raw : {};
    const manifest = (source.manifest && typeof source.manifest === 'object')
      ? source.manifest
      : ((raw.manifest && typeof raw.manifest === 'object') ? raw.manifest : source);
    const delivery = (manifest.delivery && typeof manifest.delivery === 'object') ? manifest.delivery : {};
    const hold = (manifest.delivery_release_hold && typeof manifest.delivery_release_hold === 'object')
      ? manifest.delivery_release_hold
      : ((delivery.release_hold && typeof delivery.release_hold === 'object') ? delivery.release_hold : {});
    const status = cleanText(manifest.delivery_hold_status, hold.status).toLowerCase();
    if (status !== 'holding') return false;
    const scheduled = parseReleaseHoldDate(manifest.delivery_hold_scheduled_release_at || hold.scheduled_release_at || '');
    return !!scheduled && scheduled.getTime() > Date.now();
  });

  function projectMediaOptions(){
    return {
      orgId: cleanText(APP.userOrgId, APP.orgId, window.__APP?.userOrgId, window.__APP?.orgId),
      firstMeasureUrlBuilder: (path) => fmUrl(path),
      googleMapsApiKey: googleMapsApiKey(),
      width: 640
    };
  }

  function hydrateProjectMedia(project){
    if (!window.PlatformAPI?.projectMedia?.hydrateProjectPhotos) return project;
    return window.PlatformAPI.projectMedia.hydrateProjectPhotos(project || {}, projectMediaOptions());
  }

  function normalizeProjectRecord(project){
    const p = (project && typeof project === 'object') ? { ...project } : {};
    const cleanText = (value) => {
      if (value && typeof value === 'object') return '';
      const text = String(value ?? '').trim();
      if (!text) return '';
      const lowered = text.toLowerCase();
      if (lowered === 'n/a' || lowered === 'na' || lowered === 'none' || lowered === 'null' || lowered === 'undefined' || text === '-' || text === '\u2014') return '';
      return text;
    };
    const residentObj = (p.resident && typeof p.resident === 'object' && !Array.isArray(p.resident))
      ? p.resident
      : ((p.manifest?.resident && typeof p.manifest.resident === 'object' && !Array.isArray(p.manifest.resident)) ? p.manifest.resident : null);
    const contacts = contactCandidates(p);
    const primaryContact = contacts[0] || {};
    const residentName = cleanText(p.resident) || cleanText(p.resident_name) || cleanText(p.residentName) || cleanText(residentObj?.name) || cleanText(primaryContact.name);
    const residentEmail = cleanText(p.resident_email) || cleanText(p.residentEmail) || cleanText(residentObj?.email) || cleanText(primaryContact.email);
    const residentPhone = cleanText(p.resident_phone) || cleanText(p.residentPhone) || cleanText(residentObj?.phone) || cleanText(primaryContact.phone);
    const projectTitle = firstProjectDisplayText(p.title, p.project_title, p.project_name, p.projectName, p.name, p.address, p.customer_name, p.customerName, p.primary_contact_name, primaryContact.name);
    const releaseHeld = reportReleaseHoldIsActive(p, p.manifest, p.measurement_project, p.measurement);
    const statusComplete = !releaseHeld && isFirstMeasureCompleteStatus(p.status, p.measurement_project?.status, p.measurement?.status);
    const reportUrl = statusComplete ? (p.report_url || p.pdf_url || null) : null;
    return hydrateProjectMedia({
      ...p,
      contacts,
      title: projectTitle || 'New Project',
      project_title: projectTitle || 'New Project',
      resident: residentName,
      resident_email: residentEmail,
      resident_phone: residentPhone,
      issuer: p.issuer || p.owner || '',
      issuer_email: p.issuer_email || p.owner_email || '',
      report_url: reportUrl,
      pdf_url: reportUrl,
      has_report: !!(statusComplete && (p.has_report || reportUrl)),
    });
  }

  function normalizeFirstMeasureProjectRecord(project = {}){
    const normalized = normalizeProjectRecord(project);
    const measurement = (normalized.measurement_project && typeof normalized.measurement_project === 'object')
      ? normalized.measurement_project
      : ((normalized.measurement && typeof normalized.measurement === 'object') ? normalized.measurement : {});
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const measurementId = cleanMeasurementText(
      normalized.project_id,
      normalized.folder,
      normalized.measurement_project_id,
      measurement.id,
      measurement.project_id,
      measurement.folder,
      raw.id,
      raw.project_id,
      raw.folder,
      measurementIdFromAssetUrl(
        normalized.report_url,
        normalized.pdf_url,
        normalized.summary_url,
        normalized.xml_url,
        measurement.report_url,
        measurement.pdf_url,
        measurement.summary_url,
        measurement.xml_url,
        raw.report_url,
        raw.pdf_url,
        raw.summary_url,
        raw.xml_url
      )
    );
    if (!measurementId) return normalized;
    const nextMeasurement = {
      ...measurement,
      id: measurementId,
      project_id: measurementId,
      folder: cleanText(measurement.folder, normalized.folder, measurementId),
      raw: Object.keys(raw).length ? raw : normalized
    };
    return normalizeProjectRecord({
      ...normalized,
      id: projectIdFromMeasurement(nextMeasurement),
      platform_project_id: cleanText(normalized.platform_project_id),
      base_project_id: cleanText(normalized.base_project_id),
      measurement: nextMeasurement,
      measurement_project: nextMeasurement
    });
  }

  const projectDateMs = (project) => {
    const raw = String(
      project?.completed_at
      || project?.uploaded_at
      || project?.created_at
      || project?.queued_at
      || project?.updated_at
      || project?.measurement_project?.submitted_at
      || project?.measurement?.submitted_at
      || ''
    );
    if (!raw) return 0;
    const isoish = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withZone = (isoish.includes('Z') || isoish.includes('+')) ? isoish : `${isoish}Z`;
    const ts = Date.parse(withZone);
    return Number.isFinite(ts) ? ts : 0;
  };

  const measurementKeys = (measurement = {}) => [
    measurement?.id,
    measurement?.project_id,
    measurement?.folder,
    measurement?.measurement_project_id,
    measurement?.raw?.id,
    measurement?.raw?.project_id,
    measurement?.raw?.project?.id,
    measurement?.raw?.project?.project_id,
    measurement?.raw?.folder,
    measurementIdFromAssetUrl(
      measurement?.report_url,
      measurement?.pdf_url,
      measurement?.summary_url,
      measurement?.xml_url,
      measurement?.instant_url,
      measurement?.instant_pdf_url,
      measurement?.raw?.report_url,
      measurement?.raw?.pdf_url,
      measurement?.raw?.summary_url,
      measurement?.raw?.xml_url,
      measurement?.raw?.instant_url,
      measurement?.raw?.instant_pdf_url
    ),
  ].map((value) => String(value || '').trim()).filter(Boolean);

  const hashId = (value) => {
    const input = String(value || '');
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < input.length; i += 1) {
      const ch = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
  };

  const projectIdFromMeasurement = (measurement = {}) => {
    const key = measurementKeys(measurement)[0];
    if (key) return `project_${hashId(`firstmeasure:${key}`)}`;
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    const fallback = [
      cleanText(raw.address, raw.project_address, manifest.address, manifest.project_address, measurement.address, measurement.project_address),
      cleanText(raw.created_at, raw.queued_at, raw.submitted_at, raw.updated_at, measurement.submitted_at),
      cleanText(raw.status, measurement.status)
    ].join('|').toLowerCase();
    if (fallback.replace(/\|/g, '')) return `project_${hashId(`firstmeasure-fallback:${fallback}`)}`;
    return `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  };

  const projectMeasurementKeys = (project = {}) => {
    const measurement = (project?.measurement_project && typeof project.measurement_project === 'object')
      ? project.measurement_project
      : ((project?.measurement && typeof project.measurement === 'object') ? project.measurement : {});
    return [
      ...measurementKeys(measurement),
      project?.measurement_project_id,
      project?.project_id,
      project?.folder,
      measurementIdFromAssetUrl(
        project?.report_url,
        project?.pdf_url,
        project?.summary_url,
        project?.xml_url,
        project?.instant_url,
        project?.instant_pdf_url
      ),
      project?.id && !String(project.id).startsWith('project_') ? project.id : '',
  ].map((value) => cleanText(value)).filter((value) => value && !isPlatformProjectId(value));
  };

  const projectIdentityKey = (project = {}) => {
    const measurementKey = projectMeasurementKeys(project)[0];
    if (measurementKey) return `measurement:${measurementKey}`;
    const platformKey = cleanText(project.platform_project_id, project.base_project_id, project.id);
    if (platformKey) return `platform:${platformKey}`;
    const address = cleanText(project.address).toLowerCase();
    const date = cleanText(project.created_at, project.queued_at, project.updated_at, project.measurement_project?.submitted_at, project.measurement?.submitted_at);
    return `address:${address}|${date}`;
  };

  const dedupeProjectsByIdentity = (projects = []) => {
    const byKey = new Map();
    const order = [];
    (Array.isArray(projects) ? projects : []).forEach((project) => {
      const key = projectIdentityKey(project);
      if (!byKey.has(key)) order.push(key);
      const existing = byKey.get(key);
      if (!existing || projectDateMs(project) >= projectDateMs(existing)) byKey.set(key, project);
    });
    return order.map((key) => byKey.get(key)).filter(Boolean);
  };

  const remoteProjectFromDocument = (document) => {
    const data = document?.data && typeof document.data === 'object' ? document.data : null;
    if (!data) return null;
    const documentId = cleanText(document?.id);
    const platformId = cleanText(data.platform_project_id, data.base_project_id, documentId);
    const projectTitle = firstProjectDisplayText(data.title, data.project_title, data.project_name, data.projectName, data.name, data.address, data.customer_name, data.customerName, data.primary_contact_name);
    return {
      ...data,
      id: platformId || cleanText(data.id, documentId),
      platform_project_id: cleanText(data.platform_project_id, platformId),
      base_project_id: cleanText(data.base_project_id, platformId),
      title: projectTitle || 'New Project',
      project_title: projectTitle || 'New Project'
    };
  };

  const firstContact = (project = {}) => {
    const contact = contactCandidates(project)[0] || {};
    return {
      name: cleanText(contact.name),
      email: cleanText(contact.email),
      phone: cleanText(contact.phone),
    };
  };

  const platformProjectToViewerProject = (base = {}) => {
    const measurement = (base.measurement_project && typeof base.measurement_project === 'object')
      ? base.measurement_project
      : ((base.measurement && typeof base.measurement === 'object') ? base.measurement : {});
    const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    const measurementId = cleanMeasurementText(
      measurement.id,
      measurement.project_id,
      raw.id,
      raw.project_id,
      measurementIdFromAssetUrl(
        base.report_url,
        base.pdf_url,
        base.summary_url,
        base.xml_url,
        measurement.report_url,
        measurement.pdf_url,
        measurement.summary_url,
        measurement.xml_url,
        raw.report_url,
        raw.pdf_url,
        raw.summary_url,
        raw.xml_url
      )
    );
    const hasMeasurementOrder = !!measurementId;
    const contact = firstContact(base);
    const projectTitle = firstProjectDisplayText(base.title, base.project_title, base.project_name, base.projectName, base.name, raw.title, raw.project_title, raw.project_name, raw.name, base.address, raw.address, base.customer_name, base.customerName, base.primary_contact_name, contact.name);
    const display = {
      ...raw,
      ...base,
      id: base.id || measurementId,
      platform_project_id: base.id,
      platform_project: base,
      title: projectTitle || 'New Project',
      project_title: projectTitle || 'New Project',
      measurement,
      measurement_project: measurement,
      address: cleanText(base.address) || cleanText(raw.address),
      project_type: cleanText(base.project_type) || cleanText(raw.project_type) || 'residential',
      status: cleanText(measurement.status) || cleanText(raw.status) || (hasMeasurementOrder ? cleanText(base.status, base.workflow_state, 'queued') : cleanText(base.status)),
      report_mode: cleanText(measurement.report_mode) || cleanText(raw.report_mode) || 'full',
      instant_enabled: measurement.include_instant ?? raw.instant_enabled ?? false,
      measurement_system: measurement.measurement_system || raw.measurement_system || "imperial",
      report_language: measurement.report_language || raw.report_language || "en-US",
      include_gutter_measurements: measurement.include_gutters ?? raw.include_gutter_measurements ?? false,
      is_expedited: Boolean(measurement.is_expedited ?? raw.is_expedited ?? base.is_expedited),
      report_expedite_option: cleanText(measurement.report_expedite_option) || cleanText(raw.report_expedite_option) || cleanText(base.report_expedite_option),
      report_expedite_label: cleanText(measurement.report_expedite_label) || cleanText(raw.report_expedite_label) || cleanText(base.report_expedite_label),
      report_due_window_start: cleanText(measurement.report_due_window_start) || cleanText(raw.report_due_window_start) || cleanText(base.report_due_window_start),
      report_due_window_end: cleanText(measurement.report_due_window_end) || cleanText(raw.report_due_window_end) || cleanText(base.report_due_window_end),
      report_due_window_label: cleanText(measurement.report_due_window_label) || cleanText(raw.report_due_window_label) || cleanText(base.report_due_window_label),
      amount_charged: Number(measurement.amount_charged ?? raw.amount_charged ?? base.amount_charged ?? 0) || 0,
      created_at: cleanText(measurement.submitted_at) || cleanText(raw.created_at) || cleanText(base.created_at) || cleanText(base.updated_at),
      updated_at: cleanText(raw.updated_at) || cleanText(base.updated_at),
      project_notes: cleanText(base.project_notes) || cleanText(raw.project_notes),
      resident: contact.name || cleanText(raw.resident),
      resident_email: contact.email || cleanText(raw.resident_email),
      resident_phone: contact.phone || cleanText(raw.resident_phone),
    };
    if (!measurementId) {
      display.has_report = false;
      display.instant_enabled = false;
      display._detailHydrated = true;
    }
    return normalizeProjectRecord(display);
  };

  const platformProjectStatusGroup = (project = {}) => {
    const status = String(project.status || '').toLowerCase();
    if (status === 'rejected_no_coverage' || status === 'rejected') return 'rejected';
    if (status === 'cancelled') return 'cancelled';
    if (reportReleaseHoldIsActive(project, project.manifest, project.measurement_project, project.measurement)) return 'processing';
    if (isFirstMeasureCompleteStatus(project.status, project.measurement_project?.status, project.measurement?.status)) return 'ready';
    if (project.instant_enabled && String(project.report_mode || '').toLowerCase() === 'instant') return 'ready';
    if (isDraftPlatformProject(project)) return 'draft';
    if (!projectMeasurementKeys(project).length) return isDraftPlatformProject(project) ? 'draft' : 'project';
    const measurementStatus = cleanText(project.measurement_project?.status, project.measurement?.status, project.status, project.workflow_state).toLowerCase();
    if (['submitted', 'queued', 'ready', 'measurement_ordered'].includes(measurementStatus)) return 'processing';
    return 'processing';
  };

  const hasProjectProposals = (project = {}) => {
    if (Array.isArray(project.proposals) && project.proposals.length) return true;
    if (Array.isArray(project.proposal_ids) && project.proposal_ids.length) return true;
    if (cleanText(project.proposal_id, project.active_proposal_id)) return true;
    return cleanText(project.workflow_state).toLowerCase() === 'proposal_only';
  };

  const isSalesAppointmentEvent = (event = {}) => {
    const ids = [
      event.event_type_default_id,
      event.event_type_id,
      event.eventTypeId,
      event.type,
      event.kind,
      event.id
    ].map((value) => cleanText(value).toLowerCase());
    return ids.some((value) => value === 'sales_appointment' || value.includes('sales_appointment'));
  };

  const hasScheduledAppointment = (project = {}) => {
    const events = Array.isArray(project.events) ? project.events : [];
    return events.some((event) => {
      if (!event || typeof event !== 'object' || !isSalesAppointmentEvent(event)) return false;
      const status = cleanText(event.status, event.state).toLowerCase();
      return status !== 'cancelled' && status !== 'canceled' && status !== 'deleted';
    });
  };

  const hasMeaningfulProjectActivity = (project = {}) => {
    if (hasProjectProposals(project) || hasScheduledAppointment(project)) return true;
    if (project.has_meaningful_activity === true || project.meaningful_activity === true) return true;
    const workflow = cleanText(project.workflow_state).toLowerCase();
    if (['proposal_only', 'document_only', 'drafting_proposal', 'proposal_sent', 'newly_sold', 'measurement_ordered'].includes(workflow)) return true;
    const populatedArrays = ['photos', 'documents', 'document_ids', 'material_lists', 'material_list_ids', 'work_plan_ids', 'todos', 'action_items'];
    if (populatedArrays.some((key) => Array.isArray(project[key]) && project[key].length)) return true;
    const scope = project.scope && typeof project.scope === 'object' ? project.scope : {};
    if ((Array.isArray(scope.root_items) && scope.root_items.length) || (Array.isArray(scope.pieces) && scope.pieces.length)) return true;
    const workProjection = project.work_projection && typeof project.work_projection === 'object' ? project.work_projection : {};
    if (Array.isArray(workProjection.plans) && workProjection.plans.length) return true;
    return !!cleanText(project.project_notes, project.notes, project.tech_notes);
  };

  function isDraftPlatformProject(project = {}){
    const status = cleanText(project.status, project.measurement_project?.status, project.measurement?.status, project.workflow_state).toLowerCase();
    if (projectMeasurementKeys(project).length && ['queued', 'processing', 'in_progress', 'awaiting_review', 'awaiting_manager_review', 'pending_rejection'].includes(status)) return false;
    return !projectMeasurementKeys(project).length
      && !hasMeaningfulProjectActivity(project);
  }

  const projectMatchesSearch = (project, search) => {
    const query = cleanText(search).toLowerCase();
    if (!query) return true;
    const contactText = contactCandidates(project)
      .flatMap((contact) => [contact.name, contact.email, contact.phone])
      .map((value) => cleanText(value).toLowerCase())
      .filter(Boolean)
      .join(' ');
    const haystack = [
      project.address,
      project.resident,
      project.resident_email,
      project.resident_phone,
      project.customer_name,
      project.customer_email,
      project.customer_phone,
      project.primary_contact_name,
      project.primary_contact_email,
      project.primary_contact_phone,
      contactText,
      project.project_type,
      project.status,
      project.platform_project_id,
      project.id,
    ].map((value) => String(value || '').toLowerCase()).join(' ');
    return haystack.includes(query);
  };

  const paginateProjects = (projects, fields = {}) => {
    const page = Math.max(1, Number(fields.page || 1));
    const requestedLimit = Number(fields.limit ?? 30);
    const wantsAll = Number.isFinite(requestedLimit) && requestedLimit === 0;
    const limit = wantsAll ? 0 : Math.max(1, Number(fields.limit || 30));
    const statusFilter = String(fields.status_filter || 'all').toLowerCase();
    const hideDrafts = fields.hide_drafts === true || fields.hide_drafts === 1 || String(fields.hide_drafts || '').toLowerCase() === '1' || String(fields.hide_drafts || '').toLowerCase() === 'true';
    const search = fields.search || '';
    const filtered = projects
      .filter((project) => !hideDrafts || !isDraftPlatformProject(project))
      .filter((project) => statusFilter === 'all' || platformProjectStatusGroup(project) === statusFilter)
      .filter((project) => projectMatchesSearch(project, search))
      .sort((a, b) => projectDateMs(b) - projectDateMs(a));
    const totalCount = filtered.length;
    const totalPages = wantsAll ? 1 : Math.max(1, Math.ceil(totalCount / limit));
    const safePage = Math.min(page, totalPages);
    const start = wantsAll ? 0 : (safePage - 1) * limit;
    return {
      projects: wantsAll ? filtered : filtered.slice(start, start + limit),
      platform_total_count: projects.length,
      unfiltered_count: projects.length,
      pagination: {
        current_page: safePage,
        page: safePage,
        limit: wantsAll ? 0 : limit,
        total_count: totalCount,
        total_pages: totalPages,
      }
    };
  };

  async function projectPageFromCandidates(projects = [], fields = {}, options = {}) {
    const page = paginateProjects(projects, fields);
    if (options.hydrateDetails === false) return page;
    page.projects = await Promise.all(page.projects.map(hydratePlatformProjectFromFirstMeasure));
    return page;
  }

  async function hydratePlatformProjectFromFirstMeasure(project = {}){
    const measurementId = cleanMeasurementText(
      project?.measurement_project?.id,
      project?.measurement?.id,
      project?.id,
      measurementIdFromAssetUrl(
        project?.report_url,
        project?.pdf_url,
        project?.summary_url,
        project?.xml_url,
        project?.measurement_project?.report_url,
        project?.measurement_project?.pdf_url,
        project?.measurement_project?.summary_url,
        project?.measurement_project?.xml_url,
        project?.measurement?.report_url,
        project?.measurement?.pdf_url,
        project?.measurement?.summary_url,
        project?.measurement?.xml_url
      )
    );
    if (!measurementId || measurementId === cleanText(project.platform_project_id)) return project;
    try {
      const data = await fmJson(`projects/${encodeURIComponent(measurementId)}`);
      const fmProject = data?.project && typeof data.project === 'object' ? data.project : {};
      const manifest = fmProject?.manifest && typeof fmProject.manifest === 'object' ? fmProject.manifest : {};
      const files = Array.isArray(fmProject.files) ? fmProject.files : [];
      const names = new Set(files.map((file) => String(file?.name || '')));
      const releaseHeld = reportReleaseHoldIsActive(manifest, fmProject, project);
      const isComplete = !releaseHeld && isFirstMeasureCompleteStatus(fmProject.status, manifest.status, project.status);
      const hasReportPdf = isComplete && (names.has('Report.pdf') || names.has('report.pdf'));
      const hasSummaryPdf = isComplete && names.has('Summary.pdf');
      const firstMeasureRejection = firstMeasureRejectionMetadata({ ...fmProject, ...manifest }, project);
      const measurementRejection = firstMeasureRejectionMetadata({ ...fmProject, ...manifest }, project.measurement || {});
      const measurementProjectRejection = firstMeasureRejectionMetadata({ ...fmProject, ...manifest }, project.measurement_project || {});
      return normalizeProjectRecord({
        ...project,
        ...manifest,
        ...firstMeasureRejection,
        id: cleanText(project.platform_project_id, project.id) || measurementId,
        platform_project_id: project.platform_project_id,
        platform_project: project.platform_project,
        measurement: project.measurement,
        measurement_project: project.measurement_project,
        status: cleanText(fmProject.status, manifest.status, project.status),
        is_expedited: Boolean(manifest.is_expedited ?? project.is_expedited),
        report_expedite_option: cleanText(manifest.report_expedite_option, project.report_expedite_option),
        report_expedite_label: cleanText(manifest.report_expedite_label, project.report_expedite_label),
        report_due_window_start: cleanText(manifest.report_due_window_start, project.report_due_window_start),
        report_due_window_end: cleanText(manifest.report_due_window_end, project.report_due_window_end),
        report_due_window_label: cleanText(manifest.report_due_window_label, project.report_due_window_label),
        amount_charged: Number(manifest.amount_charged ?? project.amount_charged ?? 0) || 0,
        include_weather_report: Boolean(manifest.include_weather_report ?? project.include_weather_report ?? project.weather_report_id),
        weather_report_tier: cleanText(manifest.weather_report_tier, project.weather_report_tier, 'history'),
        weather_report_id: cleanText(manifest.weather_report_id, project.weather_report_id),
        weather_report_pdf_url: cleanText(manifest.weather_report_pdf_url, project.weather_report_pdf_url),
        weather_report_status: cleanText(manifest.weather_report_status, project.weather_report_status),
        weather_report_error: cleanText(manifest.weather_report_error, project.weather_report_error),
        weather_report_generated_at: cleanText(manifest.weather_report_generated_at, project.weather_report_generated_at),
        measurement: {
          ...(project.measurement || {}),
          ...measurementRejection,
          is_expedited: Boolean(manifest.is_expedited ?? project.measurement?.is_expedited ?? project.is_expedited),
          report_expedite_option: cleanText(manifest.report_expedite_option, project.measurement?.report_expedite_option),
          report_expedite_label: cleanText(manifest.report_expedite_label, project.measurement?.report_expedite_label),
          report_due_window_start: cleanText(manifest.report_due_window_start, project.measurement?.report_due_window_start),
          report_due_window_end: cleanText(manifest.report_due_window_end, project.measurement?.report_due_window_end),
          report_due_window_label: cleanText(manifest.report_due_window_label, project.measurement?.report_due_window_label),
          amount_charged: Number(manifest.amount_charged ?? project.measurement?.amount_charged ?? 0) || 0,
          include_weather_report: Boolean(manifest.include_weather_report ?? project.measurement?.include_weather_report ?? project.include_weather_report ?? manifest.weather_report_id),
          weather_report_tier: cleanText(manifest.weather_report_tier, project.measurement?.weather_report_tier, 'history'),
          weather_report_id: cleanText(manifest.weather_report_id, project.measurement?.weather_report_id),
          weather_report_pdf_url: cleanText(manifest.weather_report_pdf_url, project.measurement?.weather_report_pdf_url),
          weather_report_status: cleanText(manifest.weather_report_status, project.measurement?.weather_report_status),
          weather_report_error: cleanText(manifest.weather_report_error, project.measurement?.weather_report_error),
          weather_report_generated_at: cleanText(manifest.weather_report_generated_at, project.measurement?.weather_report_generated_at),
        },
        measurement_project: {
          ...(project.measurement_project || {}),
          ...measurementProjectRejection,
          is_expedited: Boolean(manifest.is_expedited ?? project.measurement_project?.is_expedited ?? project.is_expedited),
          report_expedite_option: cleanText(manifest.report_expedite_option, project.measurement_project?.report_expedite_option),
          report_expedite_label: cleanText(manifest.report_expedite_label, project.measurement_project?.report_expedite_label),
          report_due_window_start: cleanText(manifest.report_due_window_start, project.measurement_project?.report_due_window_start),
          report_due_window_end: cleanText(manifest.report_due_window_end, project.measurement_project?.report_due_window_end),
          report_due_window_label: cleanText(manifest.report_due_window_label, project.measurement_project?.report_due_window_label),
          amount_charged: Number(manifest.amount_charged ?? project.measurement_project?.amount_charged ?? 0) || 0,
          include_weather_report: Boolean(manifest.include_weather_report ?? project.measurement_project?.include_weather_report ?? project.include_weather_report ?? manifest.weather_report_id),
          weather_report_tier: cleanText(manifest.weather_report_tier, project.measurement_project?.weather_report_tier, 'history'),
          weather_report_id: cleanText(manifest.weather_report_id, project.measurement_project?.weather_report_id),
          weather_report_pdf_url: cleanText(manifest.weather_report_pdf_url, project.measurement_project?.weather_report_pdf_url),
          weather_report_status: cleanText(manifest.weather_report_status, project.measurement_project?.weather_report_status),
          weather_report_error: cleanText(manifest.weather_report_error, project.measurement_project?.weather_report_error),
          weather_report_generated_at: cleanText(manifest.weather_report_generated_at, project.measurement_project?.weather_report_generated_at),
        },
        created_at: cleanText(manifest.created_at, fmProject.created_at, project.created_at),
        updated_at: cleanText(manifest.updated_at, fmProject.updated_at, project.updated_at),
        uploaded_at: cleanText(manifest.uploaded_at, fmProject.uploaded_at, project.uploaded_at),
        completed_at: cleanText(manifest.completed_at, fmProject.completed_at, project.completed_at),
        has_report: !!(isComplete && (project.has_report || hasReportPdf)),
        report_url: isComplete ? (project.report_url || project.pdf_url || (hasReportPdf ? fmUrl(`projects/${encodeURIComponent(measurementId)}/artifacts/Report.pdf`) : null)) : null,
        summary_url: isComplete ? (project.summary_url || (hasSummaryPdf ? fmUrl(`projects/${encodeURIComponent(measurementId)}/artifacts/Summary.pdf`) : null)) : null,
        xml_url: project.xml_url || (names.has('model_data.xml') ? fmUrl(`projects/${encodeURIComponent(measurementId)}/artifacts/model_data.xml`) : null),
        _detailHydrated: true,
      });
    } catch (error) {
      return project;
    }
  }

  async function listPlatformProjectCandidates(){
    const orgId = cleanText(APP.userOrgId || APP.orgId);
    if (!orgId) return null;
    const result = await window.PlatformAPI.projects.list(orgId);
    const docs = Array.isArray(result?.documents) ? result.documents : [];
    return dedupeProjectsByIdentity(docs.map(remoteProjectFromDocument).filter(Boolean))
      .map(platformProjectToViewerProject);
  }

  async function listPlatformProjects(fields = {}){
    const projects = await listPlatformProjectCandidates();
    return await projectPageFromCandidates(projects || [], fields);
  }

  async function existingPlatformProjectsByMeasurementKey(){
    const orgId = cleanText(APP.userOrgId || APP.orgId);
    const byKey = new Map();
    if (!orgId) return byKey;
    try {
      const result = await window.PlatformAPI.projects.list(orgId);
      const docs = Array.isArray(result?.documents) ? result.documents : [];
      docs.map(remoteProjectFromDocument).filter(Boolean).forEach((project) => {
        [...projectMeasurementKeys(project), ...(project.previous_measurement_ids || [])].forEach((key) => {
          if (!byKey.has(key)) byKey.set(key, project);
        });
      });
    } catch (error) {}
    return byKey;
  }

  function firstMeasureSyncStatus(project = {}){
    return cleanText(project.status, project.measurement_project?.status, project.measurement?.status).toLowerCase();
  }

  function platformSyncStatus(project = {}){
    return cleanText(project.measurement_project?.status, project.measurement?.status, project.status).toLowerCase();
  }

  function platformProjectNeedsFirstMeasureSync(existingProject = {}, firstMeasureProject = {}){
    const firstMeasureStatus = firstMeasureSyncStatus(firstMeasureProject);
    if (!firstMeasureStatus) return false;
    if (firstMeasureStatus !== platformSyncStatus(existingProject)) return true;
    const existingMeasurement = existingProject.measurement_project || existingProject.measurement || {};
    const firstMeasureHeld = reportReleaseHoldIsActive(firstMeasureProject);
    const existingHeld = reportReleaseHoldIsActive(existingProject, existingMeasurement);
    const existingReportUrl = cleanText(existingProject.report_url, existingProject.pdf_url, existingMeasurement.report_url, existingMeasurement.pdf_url);
    if (firstMeasureHeld !== existingHeld) return true;
    if (firstMeasureHeld && (existingProject.has_report || existingReportUrl)) return true;
    const hasFirstMeasureRejection = ['rejected', 'rejected_no_coverage'].includes(firstMeasureStatus)
      || !!cleanText(firstMeasureProject.rejection_reason, firstMeasureProject.customer_rejection_message);
    if (hasFirstMeasureRejection) {
      const firstRejection = firstMeasureRejectionMetadata(firstMeasureProject);
      const existingRejection = firstMeasureRejectionMetadata(existingProject, existingMeasurement);
      for (const key of ['rejection_reason', 'customer_rejection_message', 'reorder_url', 'refund_reason', 'refund_at']) {
        if (firstRejection[key] && firstRejection[key] !== existingRejection[key]) return true;
      }
      if (firstRejection.refund_issued !== existingRejection.refund_issued) return true;
      if (firstRejection.refund_pending !== existingRejection.refund_pending) return true;
      if (firstRejection.refund_amount !== existingRejection.refund_amount) return true;
    }
    const firstMeasureReportUrl = cleanText(firstMeasureProject.report_url, firstMeasureProject.pdf_url);
    if (firstMeasureReportUrl && firstMeasureReportUrl !== existingReportUrl) return true;
    const firstMeasureSummaryUrl = cleanText(firstMeasureProject.summary_url);
    const existingSummaryUrl = cleanText(existingProject.summary_url, existingMeasurement.summary_url);
    if (firstMeasureSummaryUrl && firstMeasureSummaryUrl !== existingSummaryUrl) return true;
    const firstMeasureCompletedAt = cleanText(firstMeasureProject.completed_at);
    const existingCompletedAt = cleanText(existingProject.completed_at, existingMeasurement.completed_at);
    if (firstMeasureCompletedAt && firstMeasureCompletedAt !== existingCompletedAt) return true;
    return false;
  }

  function platformProjectFromFirstMeasure(project = {}, existingProject = {}){
    const measurementId = cleanMeasurementText(
      project.id,
      project.project_id,
      project.folder,
      measurementIdFromAssetUrl(project.report_url, project.pdf_url, project.summary_url, project.xml_url)
    );
    if (!measurementId) return null;
    const existingMeasurement = existingProject.measurement_project || existingProject.measurement || {};
    const rejectionMeta = firstMeasureRejectionMetadata(project, existingProject);
    const measurementRejectionMeta = firstMeasureRejectionMetadata(project, existingMeasurement);
    const measurement = {
      ...existingMeasurement,
      ...measurementRejectionMeta,
      id: measurementId,
      project_id: measurementId,
      folder: cleanMeasurementText(project.folder, measurementId),
      status: cleanText(project.status, 'queued'),
      report_mode: cleanText(project.report_mode, project.instant_enabled ? 'both' : 'full'),
      measurement_system: project.measurement_system || "imperial",
      report_language: project.report_language || "en-US",
      include_gutters: project.include_gutter_measurements === true || project.include_gutter_measurements === 1 || project.include_gutter_measurements === '1',
      include_instant: !!project.instant_enabled || String(project.report_mode || '').trim().toLowerCase() === 'both',
      is_expedited: !!project.is_expedited,
      report_expedite_option: cleanText(project.report_expedite_option),
      report_expedite_label: cleanText(project.report_expedite_label),
      report_due_window_start: cleanText(project.report_due_window_start),
      report_due_window_end: cleanText(project.report_due_window_end),
      report_due_window_label: cleanText(project.report_due_window_label),
      amount_charged: Number(project.amount_charged ?? 0) || 0,
      submitted_at: cleanText(project.created_at, project.queued_at, project.submitted_at),
      completed_at: cleanText(project.completed_at),
      report_url: cleanText(project.report_url, project.pdf_url),
      pdf_url: cleanText(project.report_url, project.pdf_url),
      summary_url: cleanText(project.summary_url),
      xml_url: cleanText(project.xml_url),
      raw: project,
    };
    const contacts = [];
    const residentObj = project.resident && typeof project.resident === 'object' && !Array.isArray(project.resident) ? project.resident : {};
    const contact = {
      name: cleanText(typeof project.resident === 'string' ? project.resident : '', project.resident_name, project.residentName, residentObj.name),
      phone: cleanText(project.resident_phone, project.residentPhone, residentObj.phone),
      email: cleanText(project.resident_email, project.residentEmail, residentObj.email),
    };
    if (contact.name || contact.phone || contact.email) contacts.push(contact);
    const baseId = cleanText(existingProject.platform_project_id, existingProject.base_project_id, existingProject.id) || projectIdFromMeasurement(measurement);
    const releaseHeld = reportReleaseHoldIsActive(project, existingProject, measurement, existingMeasurement);
    const isComplete = !releaseHeld && isFirstMeasureCompleteStatus(measurement.status);
    const reportUrl = isComplete ? cleanText(project.report_url, project.pdf_url, existingProject.report_url, existingProject.pdf_url) : '';
    const summaryUrl = isComplete ? cleanText(project.summary_url, existingProject.summary_url) : '';
    measurement.report_url = reportUrl;
    measurement.pdf_url = reportUrl;
    measurement.summary_url = summaryUrl;
    const base = {
      ...existingProject,
      ...rejectionMeta,
      id: baseId,
      platform_project_id: cleanText(existingProject.platform_project_id, baseId),
      base_project_id: cleanText(existingProject.base_project_id, baseId),
      address: cleanText(project.address),
      project_type: cleanText(project.project_type, existingProject.project_type, 'residential'),
      status: measurement.status,
      contacts: contacts.length ? contacts : (Array.isArray(existingProject.contacts) ? existingProject.contacts : []),
      project_notes: cleanText(project.project_notes, existingProject.project_notes),
      photos: Array.isArray(existingProject.photos) ? existingProject.photos : [],
      workflow_state: cleanText(existingProject.workflow_state, 'measurement_ordered'),
      measurement,
      measurement_project: measurement,
      has_report: !!(isComplete && (project.has_report || existingProject.has_report || reportUrl)),
      report_url: reportUrl || null,
      pdf_url: reportUrl || null,
      summary_url: summaryUrl || null,
      xml_url: cleanText(project.xml_url) || null,
      created_at: cleanText(project.created_at, project.queued_at, project.submitted_at, existingProject.created_at),
      queued_at: cleanText(project.queued_at, existingProject.queued_at),
      uploaded_at: cleanText(project.uploaded_at, existingProject.uploaded_at),
      completed_at: cleanText(project.completed_at, existingProject.completed_at),
      updated_at: new Date().toISOString(),
    };
    return base;
  }

  async function savePlatformProjectFromFirstMeasure(project = {}, existingProject = {}){
    const orgId = cleanText(APP.userOrgId || APP.orgId);
    if (!orgId) return null;
    const base = platformProjectFromFirstMeasure(project, existingProject);
    if (!base) return null;
    await window.PlatformAPI.projects.save(orgId, base.id, base, {
      source: 'firstmeasure_compat_import',
      measurement_keys: measurementKeys(base.measurement),
    });
    return base;
  }

  async function listFirstMeasureProjectCandidates(fields = {}){
    const actor = currentActor();
    const requestedFilter = String(fields.filter || 'org');
    const collected = [];
    const collect = async (filter) => {
      const pageLimit = 200;
      const maxPages = Math.max(1, Math.min(250, Number(fields.max_pages || 250) || 250));
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages && page <= maxPages) {
        const payload = {
          filter,
          page,
          limit: pageLimit,
          include_all: true,
          actor
        };
        if (fields.search) payload.search = String(fields.search);
        if (fields.status_filter) payload.status_filter = String(fields.status_filter);
        if (fields.include_instant_only != null) payload.include_instant_only = String(fields.include_instant_only);
        const data = await fmPost('projects/list', payload);
        const batch = Array.isArray(data?.projects) ? data.projects : [];
        collected.push(...batch);
        const pagination = data && typeof data.pagination === 'object' ? data.pagination : {};
        const reportedTotalPages = Number(pagination.total_pages || 0) || 0;
        if (reportedTotalPages > 0) {
          totalPages = reportedTotalPages;
        } else {
          const totalCount = Number(pagination.total_count || data?.total_count || 0) || 0;
          totalPages = totalCount > 0 ? Math.ceil(totalCount / pageLimit) : page;
        }
        if (!batch.length || page >= totalPages) break;
        page += 1;
      }
    };
    await collect(requestedFilter);
    if (requestedFilter === 'org' && actor.email) {
      await collect('mine');
    }
    const projects = dedupeProjectsByIdentity(collected.map(normalizeFirstMeasureProjectRecord));
    if (projects.length) {
      const existingByMeasurementKey = await existingPlatformProjectsByMeasurementKey();
      projects.forEach((project) => {
        const existingProject = projectMeasurementKeys(project)
          .map((key) => existingByMeasurementKey.get(key))
          .find(Boolean);
        if (existingProject) {
          // A canceled/replaced report remains history of this project. It must
          // never overwrite the current measurement or reappear as a new project.
          const currentKeys = new Set(measurementKeys(existingProject.measurement_project || existingProject.measurement || {}));
          if (!projectMeasurementKeys(project).some((key) => currentKeys.has(key))) return;
          if (platformProjectNeedsFirstMeasureSync(existingProject, project)) {
            savePlatformProjectFromFirstMeasure(project, existingProject).catch((error) => console.warn('FirstMeasure project sync failed', error));
          }
          return;
        }
        savePlatformProjectFromFirstMeasure(project).catch((error) => console.warn('FirstMeasure project import failed', error));
      });
    }
    return projects;
  }

  const withTimeout = (promise, timeoutMs, fallback = null) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    Promise.resolve(promise)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      });
  });

  function truthyField(value){
    const text = String(value ?? '').trim().toLowerCase();
    return text === '1' || text === 'true' || text === 'yes' || text === 'on';
  }

  let firstMeasureSupplementPending = null;
  let firstMeasureSupplementStartedAt = 0;
  function warmFirstMeasureProjectImport(fields = {}){
    const now = Date.now();
    if (firstMeasureSupplementPending || now - firstMeasureSupplementStartedAt < 120000) return;
    firstMeasureSupplementStartedAt = now;
    firstMeasureSupplementPending = listFirstMeasureProjectCandidates({ ...fields, max_pages: 5 })
      .catch((error) => console.warn('FirstMeasure project supplement failed', error))
      .finally(() => { firstMeasureSupplementPending = null; });
  }

  async function listFirstMeasureProjectPage(fields = {}){
    const projects = await listFirstMeasureProjectCandidates(fields);
    const page = await projectPageFromCandidates(projects, fields);
    page.import_source = 'firstmeasure';
    return page;
  }

  async function routeProjectAction(action, fields = {}){
    const actor = currentActor();

    if (action === 'submit_report_rework_request') {
      const data = await platformJson('portal-action', {
        method: 'POST',
        body: {
          ...fields,
          action,
          actor,
          actor_email: actor.email || APP.userEmail || '',
          actor_name: actor.name || APP.userName || '',
          actor_org_id: actor.organization_id || APP.userOrgId || '',
          actor_team_id: actor.team_id || APP.userTeamId || APP.userBranchId || ''
        }
      });
      return { res: { ok: true, status: 200 }, data };
    }

    if (!actor.email) return null;

    if (action === 'list_projects') {
      const platformProjects = await listPlatformProjectCandidates().catch((error) => {
        console.warn('Platform project list failed; falling back to FirstMeasure', error);
        return null;
      });
      const platformList = Array.isArray(platformProjects) ? platformProjects : [];
      if (platformList.length) {
        const includeFirstMeasure = truthyField(fields.include_firstmeasure) || truthyField(fields.duplicate_check);
        let candidates = platformList;
        if (includeFirstMeasure) {
          const firstMeasureProjects = await withTimeout(
            listFirstMeasureProjectCandidates({ ...fields, max_pages: Number(fields.max_pages || 5) || 5 }),
            10000,
            []
          );
          const firstMeasureList = Array.isArray(firstMeasureProjects) ? firstMeasureProjects : [];
          candidates = dedupeProjectsByIdentity([...platformList, ...firstMeasureList]);
        } else {
          warmFirstMeasureProjectImport(fields);
        }
        const data = await projectPageFromCandidates(candidates, fields);
        return {
          res: { ok: true, status: 200 },
          data: { ok: true, source: includeFirstMeasure ? 'platform_firstmeasure' : 'platform', ...data }
        };
      }
      const firstMeasureProjects = await withTimeout(
        listFirstMeasureProjectCandidates({ ...fields, max_pages: 5 }),
        10000,
        []
      );
      const firstMeasureList = Array.isArray(firstMeasureProjects) ? firstMeasureProjects : [];
      let data;
      data = await projectPageFromCandidates(firstMeasureList, fields, { hydrateDetails: false });
      data.import_source = 'firstmeasure';
      data.firstmeasure_only = true;
      return { res: { ok: true, status: 200 }, data };
    }

    if (action === 'queue') {
      const googleApiKey = googleMapsApiKey();
      if (!googleApiKey) {
        return {
          res: { ok: false, status: 400 },
          data: { success: false, error: 'Google Maps API key is unavailable for project processing.' }
        };
      }
      return await portalActionJson('queue', {
        ...fields,
        google_api_key: googleApiKey,
      });
    }

    return null;
  }

  async function postAction(action, fields={}){
    if(['queue','submit_report_rework_request','expedite_queued_report'].includes(action))fields={...fields,commercial_pricing_revision:window.PlatformCommerce.current().pricing_revision};
    const routed = await routeProjectAction(action, fields);
    if (routed) return routed;
    return await portalActionJson(action, fields);
  }

  function diagnosticDateMs(...values){
    for (const value of values) {
      const raw = cleanText(value);
      if (!raw) continue;
      const isoish = raw.includes('T') ? raw : raw.replace(' ', 'T');
      const withZone = (isoish.includes('Z') || /[+-]\d\d:?\d\d$/.test(isoish)) ? isoish : `${isoish}Z`;
      const ts = Date.parse(withZone);
      if (Number.isFinite(ts)) return ts;
    }
    return 0;
  }

  function projectCreditUsageAmount(project = {}){
    const measurement = (project.measurement_project && typeof project.measurement_project === 'object')
      ? project.measurement_project
      : ((project.measurement && typeof project.measurement === 'object') ? project.measurement : {});
    const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    const value = Number(
      project.amount_charged
      ?? measurement.amount_charged
      ?? raw.amount_charged
      ?? project.charged_amount
      ?? project.charge_amount
      ?? 0
    );
    return Number.isFinite(value) ? Math.abs(Math.round(value * 100) / 100) : 0;
  }

  function projectCreditUsageDateMs(project = {}){
    const measurement = (project.measurement_project && typeof project.measurement_project === 'object')
      ? project.measurement_project
      : ((project.measurement && typeof project.measurement === 'object') ? project.measurement : {});
    const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    const manifest = (project.manifest && typeof project.manifest === 'object') ? project.manifest : {};
    const timestamps = (raw.timestamps && typeof raw.timestamps === 'object') ? raw.timestamps : {};
    return diagnosticDateMs(
      measurement.submitted_at,
      measurement.queued_at,
      measurement.created_at,
      raw.submitted_at,
      raw.queued_at,
      raw.created_at,
      manifest.created_at,
      timestamps.created_at,
      timestamps.queued_at,
      project.submitted_at,
      project.queued_at,
      project.completed_at,
      project.uploaded_at,
      project.created_at,
      project.updated_at
    );
  }

  async function bonusDiagnosticsLoadOrg(){
    const fromPlatform = async () => {
      const orgId = cleanText(APP.userOrgId, APP.orgId);
      if (!orgId || !window.PlatformAPI?.organizations?.get) return null;
      const result = await window.PlatformAPI.organizations.get(orgId);
      return result?.organization || result?.document?.data || result?.data || result || null;
    };
    const fromPortalAction = async () => {
      const { data } = await postAction('org_get_my');
      return data?.org || null;
    };
    return (await fromPlatform().catch(() => null)) || (await fromPortalAction().catch(() => null)) || null;
  }

  async function bonusDiagnosticsLoadProjects(){
    const [platformProjects, firstMeasureProjects] = await Promise.all([
      listPlatformProjectCandidates().catch((error) => {
        console.warn('[BonusUsageDiagnostics] Platform project list failed', error);
        return [];
      }),
      listFirstMeasureProjectCandidates({ filter: 'org' }).catch((error) => {
        console.warn('[BonusUsageDiagnostics] FirstMeasure project list failed', error);
        return [];
      })
    ]);
    return dedupeProjectsByIdentity([
      ...(Array.isArray(firstMeasureProjects) ? firstMeasureProjects : []),
      ...(Array.isArray(platformProjects) ? platformProjects : [])
    ].map(normalizeProjectRecord));
  }

  function bonusDiagnosticBaseRoundingIncrement(twoMonthValue){
    const value = Math.abs(Number(twoMonthValue || 0));
    if (value < 500) return 100;
    if (value < 1000) return 250;
    return 500;
  }

  function anchoredBonusDiagnosticTier(monthlyUsage, months, bonusPercent, roundedCustomerPays, roundingIncrement){
    const rawCustomerPays = Math.abs(Math.round((Number(monthlyUsage || 0) * months) * 100) / 100);
    const rawBonus = Math.round(rawCustomerPays * (bonusPercent / 100) * 100) / 100;
    const roundedBonus = Math.round(roundedCustomerPays * (bonusPercent / 100) * 100) / 100;
    return {
      months,
      bonus_percent: bonusPercent,
      absolute_customer_pays: rawCustomerPays,
      absolute_bonus_dollars: rawBonus,
      absolute_total_account_value: Math.round((rawCustomerPays + rawBonus) * 100) / 100,
      rounded_customer_pays: roundedCustomerPays,
      rounded_bonus_dollars: roundedBonus,
      rounded_total_account_value: Math.round((roundedCustomerPays + roundedBonus) * 100) / 100,
      rounding_increment: roundingIncrement
    };
  }

  async function previewCreditUsageBonusOffer(options = {}){
    const nowMs = diagnosticDateMs(options.now) || Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const org = await bonusDiagnosticsLoadOrg();
    const projects = await bonusDiagnosticsLoadProjects();
    const allOrderEvents = projects.map((project) => ({
      project,
      amount: projectCreditUsageAmount(project),
      date_ms: projectCreditUsageDateMs(project)
    })).filter((event) => event.date_ms > 0 && event.date_ms <= nowMs);
    const usageEvents = allOrderEvents.filter((event) => event.amount > 0);

    const firstOrderMs = usageEvents.reduce((min, event) => Math.min(min, event.date_ms), Infinity);
    const signupMs = diagnosticDateMs(
      org?.created_at,
      org?.createdAt,
      org?.signup_at,
      org?.signed_up_at,
      org?.created,
      org?.metadata?.created_at,
      org?.metadata?.signup_at
    ) || (Number.isFinite(firstOrderMs) ? firstOrderMs : 0);
    const accountAgeDays = signupMs ? Math.max(0, (nowMs - signupMs) / (24 * 60 * 60 * 1000)) : 0;
    const useLastMonth = accountAgeDays > 30;
    const windowStartMs = useLastMonth ? nowMs - thirtyDaysMs : (signupMs || (Number.isFinite(firstOrderMs) ? firstOrderMs : nowMs));
    const windowLabel = useLastMonth ? 'last_30_days' : 'lifetime_prorated';
    const windowEvents = usageEvents.filter((event) => event.date_ms >= windowStartMs && event.date_ms <= nowMs);
    const windowCreditUsage = Math.round(windowEvents.reduce((sum, event) => sum + event.amount, 0) * 100) / 100;
    const observedDays = useLastMonth
      ? 30
      : Math.max(1, Math.min(30, accountAgeDays || ((nowMs - windowStartMs) / (24 * 60 * 60 * 1000)) || 1));
    const monthlyUsage = useLastMonth
      ? windowCreditUsage
      : Math.round((windowCreditUsage / observedDays) * 30 * 100) / 100;
    const twoMonthValue = Math.round(monthlyUsage * 2 * 100) / 100;
    const roundingIncrement = bonusDiagnosticBaseRoundingIncrement(twoMonthValue);
    const roundedTwoMonthValue = Math.max(0, Math.round(twoMonthValue / roundingIncrement) * roundingIncrement);
    const tiers = [
      anchoredBonusDiagnosticTier(monthlyUsage, 2, 25, roundedTwoMonthValue, roundingIncrement),
      anchoredBonusDiagnosticTier(monthlyUsage, 4, 50, roundedTwoMonthValue * 2, roundingIncrement),
      anchoredBonusDiagnosticTier(monthlyUsage, 8, 50, roundedTwoMonthValue * 4, roundingIncrement)
    ];
    const referenceUsage = {
      one_month: monthlyUsage,
      three_months: Math.round(monthlyUsage * 3 * 100) / 100,
      twelve_months: Math.round(monthlyUsage * 12 * 100) / 100
    };
    const result = {
      ok: true,
      diagnostic_only: true,
      org: {
        id: cleanText(org?.id, APP.userOrgId, APP.orgId),
        name: cleanText(org?.name, APP.userCompany),
        signup_at: signupMs ? new Date(signupMs).toISOString() : '',
        signup_date_source: signupMs && Number.isFinite(firstOrderMs) && signupMs === firstOrderMs ? 'first_charged_order_fallback' : 'organization'
      },
      basis: {
        window: windowLabel,
        account_age_days: Math.round(accountAgeDays * 10) / 10,
        observed_days: Math.round(observedDays * 10) / 10,
        window_start: new Date(windowStartMs).toISOString(),
        window_end: new Date(nowMs).toISOString(),
        charged_order_count: windowEvents.length,
        lifetime_charged_order_count: usageEvents.length,
        visible_order_count: allOrderEvents.length,
        visible_orders_missing_amount: allOrderEvents.filter((event) => event.amount <= 0).length,
        visible_orders_missing_date: projects.length - allOrderEvents.length,
        window_credit_usage: windowCreditUsage,
        monthly_credit_usage_estimate: monthlyUsage,
        average_order_value: windowEvents.length ? Math.round((windowCreditUsage / windowEvents.length) * 100) / 100 : 0,
        rounding_increment: roundingIncrement
      },
      reference_usage: referenceUsage,
      tiers
    };

    if (options.log !== false) {
      console.log('[BonusUsageDiagnostics] Customized credit usage bonus offer preview', result);
      console.table(tiers.map((tier) => ({
        months: tier.months,
        bonus: `${tier.bonus_percent}%`,
        absolute_customer_pays: tier.absolute_customer_pays,
        absolute_bonus: tier.absolute_bonus_dollars,
        absolute_total: tier.absolute_total_account_value,
        rounded_customer_pays: tier.rounded_customer_pays,
        rounded_bonus: tier.rounded_bonus_dollars,
        rounded_total: tier.rounded_total_account_value
      })));
    }
    return result;
  }

  /**
   * Check if current user has a specific permission.
   * Handles wildcard '*' permission (admin).
   */
  function hasPerm(key) {
    const p = window.Portal.currentUser.permissions || {};
    if (p['*']) return true;
    return !!p[key];
  }

  function frontendFallbackPermissions(){
    if (!String(APP.userOrgId || '').trim()) return {};
    return {
      manage_company_settings: true,
      manage_company_users: true,
      manage_report_settings: true,
      manage_billing: true,
      order_reports: true,
      view_reports: true,
      view_projects: true,
      manage_projects: true
    };
  }

  function stableJson(value){
    if (!value || typeof value !== 'object') return String(value ?? '');
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }

  function uniqueTextList(...values){
    const items = values.flatMap((value) => Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]));
    return [...new Set(items.map((item) => cleanText(item?.id, item)).filter(Boolean))];
  }

  function normalizedAppEntitlements(...values){
    const sources = values.filter((value) => value && typeof value === 'object');
    return sources.reduce((result, source) => {
      if (Array.isArray(source)) {
        source.forEach((entry) => {
          const id = cleanText(entry?.id, entry?.app_id, entry?.appId, entry?.key);
          if (id) result[id] = entry;
        });
        return result;
      }
      Object.entries(source).forEach(([key, value]) => {
        if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
          result[key] = { ...result[key], ...value };
        } else {
          result[key] = value;
        }
      });
      return result;
    }, {});
  }

  function setCurrentPermissions(nextPermissions){
    const next = (nextPermissions && typeof nextPermissions === 'object') ? nextPermissions : {};
    const prevKey = stableJson(window.Portal.currentUser.permissions || {});
    const nextKey = stableJson(next);
    if (prevKey === nextKey) return false;
    window.Portal.currentUser.permissions = next;
    window.dispatchEvent(new CustomEvent('fm:perms:updated'));
    window.dispatchEvent(new CustomEvent('fm:app-entitlements:updated', { detail: { source: 'permissions' } }));
    return true;
  }

  let platformSessionPromise = null;
  function normalizedApplicationAccess(value){
    const raw = value && typeof value === 'object' ? value : {};
    const entry = (input, fallback) => {
      if (typeof input === 'boolean') return { enabled:input, role_id:'', permissions:{} };
      const record = input && typeof input === 'object' ? input : {};
      return {
        ...record,
        enabled: record.enabled == null ? fallback : record.enabled === true,
        role_id: cleanText(record.role_id, record.role),
        permissions: record.permissions && typeof record.permissions === 'object' ? record.permissions : {}
      };
    };
    return {
      ...raw,
      management: entry(raw.management ?? raw.main ?? raw.portal, true),
      field: entry(raw.field ?? raw.crew ?? raw.workforce, false)
    };
  }

  function syncManagementApplicationNotice(access){
    const enabled = access?.management?.enabled === true || access?.field?.enabled === true;
    document.documentElement.toggleAttribute('data-fm-management-access-denied', !enabled);
    const existing = document.getElementById('fmManagementAccessDenied');
    if (enabled) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const notice = document.createElement('div');
    notice.id = 'fmManagementAccessDenied';
    notice.setAttribute('role', 'alert');
    notice.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;background:#f8fafc;color:#101828;font-family:inherit';
    notice.innerHTML = `<div style="width:min(520px,100%);padding:28px;border:1px solid #e4e7ec;border-radius:18px;background:#fff;box-shadow:0 24px 70px rgba(15,23,42,.14);text-align:center"><div style="font-size:34px;margin-bottom:12px"><i class="fas fa-lock"></i></div><h1 style="margin:0 0 8px;font-size:22px">${(globalThis.PlatformLanguage?.text("platform","m_b126ae2c9d98e9","App access is not enabled") ?? "App access is not enabled")}</h1><p style="margin:0 0 20px;color:#667085;line-height:1.5">${(globalThis.PlatformLanguage?.text("platform","m_9281c219072ec2","Your account is active, but no FirstMate application is enabled for it. Ask a company administrator to update your app access.") ?? "Your account is active, but no FirstMate application is enabled for it. Ask a company administrator to update your app access.")}</p><a href="/logout.php" style="display:inline-flex;padding:10px 16px;border-radius:10px;background:#111827;color:#fff;text-decoration:none;font-weight:900">${(globalThis.PlatformLanguage?.text("platform","m_4a4225b26dcc30","Sign out") ?? "Sign out")}</a></div>`;
    document.body.appendChild(notice);
  }

  function canonicalApplicationId(value){
    const id = cleanText(value).toLowerCase();
    if (['main', 'portal'].includes(id)) return 'management';
    if (['crew', 'workforce'].includes(id)) return 'field';
    return id;
  }

  async function syncPlatformSession(){
    if (platformSessionPromise) return platformSessionPromise;
    platformSessionPromise = (async () => {
      if (!window.PlatformAPI?.auth?.me) return null;
      const session = await window.PlatformAPI.auth.me().catch(() => null);
      if (!session?.authenticated && !session?.membership && !session?.user) return session;

      const membership = session.membership || {};
      const user = session.user || {};
      const identity = session.identity || {};
      const accessProfile = session.access_profile || membership.access_profile || user.access_profile || {};
      const nextOrgId = cleanText(
        membership.organization_id,
        membership.org_id,
        session.session?.organization_id,
        user.organization_id,
        APP.userOrgId
      );
      const nextBranchId = cleanText(
        membership.branch_id,
        membership.branchId,
        session.session?.branch_id,
        user.branch_id,
        APP.userBranchId,
        'default'
      ) || 'default';
      const nextName = cleanText(user.name, identity.name, APP.userName);
      const nextEmail = cleanText(user.email, identity.email, APP.userEmail);
      const nextCompany = cleanText(session.organization?.name, APP.userCompany);
      const nextUserId = cleanText(user.id, membership.user_id, membership.userId, APP.userId, APP.user_id);
      const applicationAccess = normalizedApplicationAccess({
        ...(user.application_access && typeof user.application_access === 'object' ? user.application_access : {}),
        ...(membership.application_access && typeof membership.application_access === 'object' ? membership.application_access : {}),
        ...(accessProfile.application_access && typeof accessProfile.application_access === 'object' ? accessProfile.application_access : {})
      });
      const roleIds = uniqueTextList(accessProfile.access_role_ids, accessProfile.role_ids, user.roles, user.role_ids, membership.roles, membership.role_ids, user.role, membership.role, user.org_permissions?.level, membership.org_permissions?.level);
      const entitlements = normalizedAppEntitlements(
        accessProfile.app_entitlements,
        accessProfile.entitlements,
        membership.effective_app_access,
        membership.app_entitlements,
        membership.entitlements,
        membership.tab_access,
        user.effective_app_access,
        user.app_entitlements,
        user.entitlements,
        user.tab_access,
        applicationAccess.management?.entitlements,
        applicationAccess.field?.entitlements,
        session.app_entitlements,
        session.entitlements
      );

      if (nextOrgId) {
        APP.userOrgId = nextOrgId;
        APP.orgId = nextOrgId;
      }
      APP.userBranchId = nextBranchId;
      APP.branchId = nextBranchId;
      if (nextUserId) {
        APP.userId = nextUserId;
        APP.user_id = nextUserId;
        window.Portal.currentUser.id = nextUserId;
        window.Portal.currentUser.user_id = nextUserId;
      }
      if (nextName) APP.userName = nextName;
      if (nextEmail) APP.userEmail = nextEmail;
      if (nextCompany) APP.userCompany = nextCompany;

      window.__APP = APP;
      window.Portal.cfg = APP;
      window.Portal.currentUser.user = user;
      window.Portal.currentUser.membership = membership;
      window.Portal.currentUser.identity = identity;
      window.Portal.currentUser.accessProfile = accessProfile;
      window.Portal.currentUser.role = cleanText(user.role, membership.role, user.org_permissions?.level, membership.org_permissions?.level);
      window.Portal.currentUser.roleIds = roleIds;
      window.Portal.currentUser.roles = roleIds;
      window.Portal.currentUser.entitlements = entitlements;
      window.Portal.currentUser.appEntitlements = entitlements;
      window.Portal.currentUser.applicationAccess = applicationAccess;
      window.Portal.currentUser.canAccessApplication = (applicationId) => applicationAccess?.[canonicalApplicationId(applicationId)]?.enabled === true;
      window.Portal.currentUser.hasApplicationPermission = (applicationId, permission) => {
        const entry = applicationAccess?.[canonicalApplicationId(applicationId)];
        if (!entry?.enabled) return false;
        if (!permission) return true;
        return String(permission).split('|').some((key) => {
          const item = key.trim();
          return entry.permissions?.[item] === true || (entry.permissions?.[item] !== false && entry.permissions?.['*'] === true);
        });
      };
      syncManagementApplicationNotice(applicationAccess);
      if (accessProfile.permissions || accessProfile.effective_permissions || membership.permissions || user.permissions || user.org_permissions?.items) {
        setCurrentPermissions(accessProfile.permissions || accessProfile.effective_permissions || membership.permissions || user.permissions || user.org_permissions.items || {});
      }
      window.dispatchEvent(new CustomEvent('fm:app-entitlements:updated', {
        detail: { source: 'session', entitlements, applicationAccess, roleIds }
      }));
      window.dispatchEvent(new CustomEvent('fm:platform-session:updated', {
        detail: { orgId: APP.userOrgId || '', branchId: APP.userBranchId || 'default', session }
      }));
      return session;
    })().finally(() => { platformSessionPromise = null; });
    return platformSessionPromise;
  }

  // Toast (unchanged, sleek, universal)
  function ensureToast(){
    let el = $('#fmToast');
    if (el) return el;

    injectCSS('toast', `
      .fm-toast{
        position:fixed; right:18px; bottom:18px; z-index:2147483600;
        background:rgba(255,255,255,0.96);
        border:1px solid rgba(0,0,0,0.08);
        box-shadow:0 18px 50px rgba(0,0,0,0.16);
        border-radius:16px;
        padding:12px 12px;
        display:none;
        min-width:280px;
        max-width:min(520px, calc(100vw - 36px));
        backdrop-filter: blur(10px);
      }
      .fm-toast.show{display:flex; gap:10px; align-items:center; animation:fmFade .16s ease-out}
      .fm-toast .ic{
        width:36px; height:36px; border-radius:14px;
        display:flex; align-items:center; justify-content:center;
        border:1px solid rgba(0,0,0,0.06);
        flex-shrink:0;
      }
      .fm-toast .tx{display:flex; flex:1; flex-direction:column; min-width:0}
      .fm-toast .t1{font-weight:1000; font-size:13px; color:#111}
      .fm-toast .t2{font-weight:800; font-size:12px; color:#666; margin-top:2px; line-height:1.35; overflow:hidden; overflow-wrap:anywhere; white-space:normal; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3}
      .fm-toast .x{
        flex-shrink:0; margin-left:auto;
        width:36px; height:36px; border-radius:14px;
        border:1px solid rgba(0,0,0,0.08);
        background:#fff;
        cursor:pointer;
        transition:.16s ease;
      }
      .fm-toast .x:hover{transform:translateY(-1px)}
      @keyframes fmFade{from{opacity:0; transform:translateY(6px)}to{opacity:1; transform:translateY(0)}}
    `);

    el = document.createElement('div');
    el.id = 'fmToast';
    el.className = 'fm-toast';
    el.innerHTML = `
      <div class="ic" id="fmToastIc"><i class="fas fa-check"></i></div>
      <div class="tx">
        <div class="t1" id="fmToastT1">${(globalThis.PlatformLanguage?.text("platform","m_8cb6b086a0e69c","Done") ?? "Done")}</div>
        <div class="t2" id="fmToastT2">—</div>
      </div>
      <button class="x" id="fmToastX" data-fm-tooltip="Dismiss"><i class="fas fa-times"></i></button>
    `;
    document.body.appendChild(el);
    $('#fmToastX').addEventListener('click', hideToast);
    return el;
  }

  let toastTimer = null;
  function showToast(t1, t2, ok=true){
    if (window.FirstMateSettingsPages?.consumeAutosaveToast?.(t1, t2, ok)) return;
    if (window.PlatformUI?.showToast) return window.PlatformUI.showToast(t1, t2, ok);
    ensureToast();
    $('#fmToastT1').textContent = t1 || 'Done';
    $('#fmToastT2').textContent = t2 || '';
    const ic = $('#fmToastIc');
    ic.style.background = ok ? '#e6f4ea' : '#fce8e6';
    ic.style.borderColor = ok ? '#b7e1c1' : '#f4b4ae';
    ic.style.color = ok ? '#137333' : '#c5221f';
    ic.innerHTML = ok ? '<i class="fas fa-check"></i>' : '<i class="fas fa-triangle-exclamation"></i>';

    const el = $('#fmToast');
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 4200);
  }

  function hideToast(){
    if (window.PlatformUI?.hideToast) return window.PlatformUI.hideToast();
    const el = $('#fmToast');
    if (el) el.classList.remove('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
  }

  function enableSafeBackdropClose(overlayEl, closeFn){
    if (!overlayEl) return;
    let downOnBackdrop = false;
    overlayEl.addEventListener('mousedown', (e)=>{ downOnBackdrop = (e.target === overlayEl); });
    overlayEl.addEventListener('mouseup', (e)=>{
      if (downOnBackdrop && e.target === overlayEl) closeFn();
      downOnBackdrop = false;
    });
    window.addEventListener('blur', ()=>{ downOnBackdrop = false; });
  }

  // ----------------------------
  // Tabs / Plugin system
  // ----------------------------
  const TabRegistry = {
    tabs: new Map(),
    activeId: null,
    mounted: new Set(),
    handles: new Map(),
    preferDefaultHome: false,
    routesReady: false,
  };

  function terminologyLabel(key, fallback = ''){
    if (!String(key || '').trim()) return String(fallback || '').trim();
    return window.PlatformTerminology?.get?.(key, fallback) || String(fallback || '').trim();
  }

  function appTerminologyLabel(app = {}, fallback = ''){
    return window.PlatformTerminology?.appLabel?.(app, fallback) || String(fallback || app?.title || app?.label || '').trim();
  }

  function advancedAppMenuEnabled(){
    const capabilities = window.Portal?.capabilities || window.PlatformAPI?.capabilities;
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    return capabilities?.current?.()
      ? capabilities.value?.('platform.advanced_app_menu', false) === true
      : (flags?.current?.() && flags.value?.('platform', 'advanced_app_menu', false) === true);
  }

  function setPortalTabEntry(def){
    if (!def || !def.id) throw new Error('setPortalTabEntry: missing id');
    const runtimeAppId = def.appId || `portal.${def.id}`;
    TabRegistry.tabs.set(def.id, {
      id: def.id,
      appId: runtimeAppId,
      title: def.title || def.id,
      terminologyKey: def.terminologyKey || '',
      icon: def.icon || 'fa-circle',
      order: Number.isFinite(def.order) ? def.order : 1000,
      placement: def.placement || 'main',
      settingsTabId: cleanText(def.settingsTabId),
      css: def.css || '',
      fullBleed: def.fullBleed === true,
      mount: def.mount || null,
      onShow: def.onShow || null,
      onHide: def.onHide || null,
      params: def.params && typeof def.params === 'object' ? { ...def.params } : {},
      layout: def.layout && typeof def.layout === 'object' ? { ...def.layout } : {},
      presentation: def.presentation && typeof def.presentation === 'object' ? { ...def.presentation } : {},
      defaultHome: def.defaultHome === true,
      access: def.access && typeof def.access === 'object' ? { ...def.access } : {},
      entitlement: def.entitlement,
      eligibilityReasons: Array.isArray(def.reasons) ? [...def.reasons] : [],
      runtimeManaged: def.runtimeManaged !== false,
    });
  }

  function removePortalTabEntry(id, options = {}){
    if (!id || !TabRegistry.tabs.has(id)) return;
    const wasActive = TabRegistry.activeId === id;
    const tab = TabRegistry.tabs.get(id);
    if (wasActive) tab?.onHide && tab.onHide();
    const handle = TabRegistry.handles.get(id);
    if (handle?.destroy) {
      try { handle.destroy(); } catch(e) {}
    }
    TabRegistry.handles.delete(id);
    if (options.unregisterRuntime !== false) window.FirstMateEmbeddableApps?.unregisterApp?.(tab?.appId);
    TabRegistry.tabs.delete(id);
    TabRegistry.mounted.delete(id);
    if (wasActive) {
      const next = [...TabRegistry.tabs.values()].sort((a,b)=>a.order-b.order)[0];
      TabRegistry.activeId = next?.id || null;
    }
    if (!options.skipRender) renderTabs();
  }

  function portalTabIdFromApp(app = {}){
    const explicit = cleanText(app.portalTabId, app.tabId);
    if (explicit) return explicit;
    const appId = cleanText(app.id);
    return appId.startsWith('portal.') ? appId.slice('portal.'.length) : appId;
  }

  function portalAppPlacement(app = {}, fallback = 'sidebar'){
    const appId = cleanText(app.id, app.appId).toLowerCase();
    const configured = window.PlatformAPI?.appFlags?.current?.()?.app_placements?.[appId];
    // Settings is shell chrome, never an ordinary app-list item. It may be
    // removed for an org with no settings surface, but every visible form is
    // permanently docked in the bottom launcher.
    if (appId === 'portal.company_settings') return configured === 'hidden' ? 'hidden' : 'settings';
    const requested = cleanText(configured || app.placement || fallback).toLowerCase();
    // The advanced launcher revives `more` as an app-menu-only placement. With
    // the experiment off, preserve the legacy projection back to the sidebar.
    if (requested === 'more') return appId === 'portal.assistant' || advancedAppMenuEnabled() ? 'more' : 'sidebar';
    return ['sidebar', 'more', 'settings', 'hidden'].includes(requested) ? requested : fallback;
  }

  function syncPortalTabsFromRuntime(){
    const runtime = window.FirstMateEmbeddableApps;
    if (!runtime?.listApps) return;
    const metas = runtime.listApps({ surface: 'portal_tab', source: 'portal_shell', chrome: 'tab' })
      .filter((meta) => meta?.app?.kind === 'portal_tab' || meta?.surfaces?.includes?.('portal_tab'));
    const nextIds = new Set();
    metas.forEach((meta) => {
      const app = meta.app || {};
      const tabId = portalTabIdFromApp(app);
      if (!tabId) return;
      nextIds.add(tabId);
      setPortalTabEntry({
        id: tabId,
        appId: meta.id,
        title: appTerminologyLabel(app, meta.title || meta.label || app.title || app.label || tabId),
        terminologyKey: app.terminologyKey || meta.terminologyKey || '',
        icon: meta.icon || app.icon || 'fa-circle',
        order: Number.isFinite(meta.order) ? meta.order : (Number.isFinite(app.order) ? app.order : 1000),
        placement: portalAppPlacement(app),
        settingsTabId: cleanText(app.settingsTabId),
        css: app.css || '',
        fullBleed: app.fullBleed === true,
        onShow: app.onShow || null,
        onHide: app.onHide || null,
        params: meta.params || {},
        layout: meta.layout || {},
        presentation: meta.presentation || {},
        defaultHome: meta.defaultHome === true,
        access: meta.access || {},
        entitlement: meta.entitlement,
        reasons: meta.reasons || [],
        runtimeManaged: true
      });
    });
    [...TabRegistry.tabs.values()].forEach((tab) => {
      if (tab.runtimeManaged && !nextIds.has(tab.id)) removePortalTabEntry(tab.id, { unregisterRuntime: false, skipRender: true });
    });
  }

  function registerPortalApp(def = {}){
    const tabId = cleanText(def.tabId, def.portalTabId, def.id);
    if (!tabId) throw new Error('registerPortalApp: missing tabId');
    const appId = cleanText(def.appId, def.runtimeAppId, def.id && String(def.id).startsWith('portal.') ? def.id : '', `portal.${tabId}`);
    if (!window.FirstMateEmbeddableApps?.registerApp) return null;
    const app = window.FirstMateEmbeddableApps.registerApp({
      ...def,
      id: appId,
      portalTabId: tabId,
      kind: 'portal_tab',
      title: def.title || def.label || tabId,
      label: def.label || def.title || tabId,
      icon: def.icon || 'fa-circle',
      order: Number.isFinite(def.order) ? def.order : 1000,
      surfaces: ['portal_tab'],
      regions: ['main'],
      visible: def.visible,
      enabled: def.enabled,
      disabled: def.disabled,
      pending: def.pending,
      mount(context = {}){
        const panel = context.roots?.main || context.root || null;
        if (def.css) injectCSS(`tab_${tabId}`, def.css);
        const result = typeof def.mount === 'function' ? def.mount(panel, context) : null;
        if (result && typeof result === 'object') return result;
        return {
          destroy(){
            if (typeof def.destroy === 'function') def.destroy(panel, context);
          }
        };
      }
    });
    renderTabs();
    return app;
  }

  function unregisterPortalApp(id){
    const tabId = cleanText(id);
    if (!tabId) return;
    const entry = TabRegistry.tabs.get(tabId) || [...TabRegistry.tabs.values()].find((tab) => tab.appId === tabId || tab.appId === `portal.${tabId}`);
    const appId = entry?.appId || (tabId.startsWith('portal.') ? tabId : `portal.${tabId}`);
    window.FirstMateEmbeddableApps?.unregisterApp?.(appId);
    removePortalTabEntry(entry?.id || tabId.replace(/^portal\./, ''), { unregisterRuntime: false });
  }

  let sidebarTodoController = null;
  let sidebarTodoLoadedAt = 0;
  let sidebarChannelsController = null;
  let sidebarModeUserSelected = false;

  function ensureSidebarLinksContainer(){
    let links = document.getElementById('sidebarLinks');
    if (links) return links;

    const creditsCard = document.getElementById('creditsCard') || document.querySelector('.credits-card');
    const sidebarAppsPanel = document.getElementById('sidebarAppsPanel');
    const sidebarScroll = sidebarAppsPanel || document.querySelector('.sidebar-scroll') || document.querySelector('.sidebar-content') || document.querySelector('.sidebar');
    if (!sidebarScroll) return null;

    links = document.createElement('div');
    links.id = 'sidebarLinks';

    if (creditsCard && creditsCard.parentElement === sidebarScroll){
      creditsCard.insertAdjacentElement('afterend', links);
    } else {
      sidebarScroll.appendChild(links);
    }
    return links;
  }

  function setSidebarPanel(panelName){
    const requestedMode = ['apps', 'todo', 'channels', 'agents'].includes(panelName) ? panelName : 'apps';
    const sidebar = document.getElementById('mainSidebar');
    const appsTab = document.getElementById('sidebarAppsTab');
    const todoTab = document.getElementById('sidebarTodoTab');
    const channelsTab = document.getElementById('sidebarChannelsTab');
    const agentsTab = document.getElementById('sidebarAgentsTab');
    const appsPanel = document.getElementById('sidebarAppsPanel');
    const todoPanel = document.getElementById('sidebarTodoPanel');
    const channelsPanel = document.getElementById('sidebarChannelsPanel');
    const agentsPanel = document.getElementById('sidebarAgentsPanel');
    if (!appsTab || !todoTab || !appsPanel || !todoPanel) return;

    const panes = [
      { key: 'apps', enabledClass: 'apps-list-enabled', tab: appsTab, panel: appsPanel },
      { key: 'todo', enabledClass: 'todo-list-enabled', tab: todoTab, panel: todoPanel },
      ...(channelsTab && channelsPanel ? [{ key: 'channels', enabledClass: 'channels-tab-enabled', tab: channelsTab, panel: channelsPanel }] : []),
      ...(agentsTab && agentsPanel ? [{ key: 'agents', enabledClass: 'agents-tab-enabled', tab: agentsTab, panel: agentsPanel }] : [])
    ];
    const available = panes.filter((pane) => sidebar?.classList.contains(pane.enabledClass));
    const mode = available.some((pane) => pane.key === requestedMode) ? requestedMode : (available[0]?.key || '');
    for (const pane of panes) {
      const active = pane.key === mode;
      pane.tab.classList.toggle('active', active);
      pane.tab.setAttribute('aria-selected', active ? 'true' : 'false');
      pane.panel.classList.toggle('active', active);
      pane.panel.hidden = !active;
    }
    if (mode === 'todo') mountSidebarTodo();
    if (mode === 'channels') mountSidebarChannels();
    if (mode === 'agents') mountSidebarAgents();
  }

  function sidebarDefaultMode(){
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    const configured = String(flags?.value?.('platform', 'left_column_default_mode', 'apps') || 'apps').trim().toLowerCase();
    return ['apps', 'todo', 'channels', 'agents'].includes(configured) ? configured : 'apps';
  }

  function sidebarAppsFeatureEnabled(){
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (!flags?.current?.()) return true;
    return !!flags.has?.('platform', 'left_column_apps', true);
  }

  function applySidebarAppsFeatureFlag(){
    const sidebar = document.getElementById('mainSidebar');
    const enabled = sidebarAppsFeatureEnabled();
    sidebar?.classList.toggle('apps-list-enabled', enabled);
    return enabled;
  }

  function sidebarTodoFeatureEnabled(){
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (!flags?.current?.()) return false;
    const currentUser = window.Portal?.currentUser;
    const hasManagementAccess = currentUser?.canAccessApplication?.('management') === true;
    const canViewProjects = window.Portal?.util?.hasPerm?.('view_projects') === true;
    return hasManagementAccess
      && canViewProjects
      && !!flags.has?.('platform', 'left_column_todo_list');
  }

  function applySidebarTodoFeatureFlag(){
    const sidebar = document.getElementById('mainSidebar');
    const enabled = sidebarTodoFeatureEnabled();
    sidebar?.classList.toggle('todo-list-enabled', enabled);
    if (!enabled) {
      sidebarTodoController?.destroy?.();
      sidebarTodoController = null;
      sidebarTodoLoadedAt = 0;
    }
    return enabled;
  }

  function mountSidebarTodo(force = false){
    const container = document.getElementById('sidebarTodoList');
    if (!container) return;
    const orgId = cleanText(APP.userOrgId, APP.orgId, window.__APP?.userOrgId, window.__APP?.orgId);
    if (!orgId || !window.PlatformActionItems?.renderTodayList) {
      container.innerHTML = `<div class="pai-today-list"><div class="pai-state">${(globalThis.PlatformLanguage?.text("platform","m_b46ce5290a86bd","To-dos are not available.") ?? "To-dos are not available.")}</div></div>`;
      return;
    }
    if (!sidebarTodoController) {
      sidebarTodoController = window.PlatformActionItems.renderTodayList(container, {
        orgId,
        branchId: currentBranchId(),
        userId: cleanText(APP.userId, APP.user_id, window.Portal?.currentUser?.id),
        completedOpen: true,
        showProjectContext: true,
        showUpcoming: false,
        showFuture: false,
        scrollItemsOnly: true,
        query: { includeAll: true, serverFilterDueBefore: true }
      });
      sidebarTodoLoadedAt = Date.now();
      return;
    }
    if (force || Date.now() - sidebarTodoLoadedAt > 60000) {
      sidebarTodoLoadedAt = Date.now();
      sidebarTodoController.load().catch(() => null);
    }
  }

  function sidebarChannelsFeatureEnabled(){
    // On phones the sidebar is a pop-out drawer, so the left-column channels
    // integration only adds indirection: mobile always uses the standalone
    // channels tab, as if the sidebar_tab toggle were off.
    if (window.matchMedia?.('(max-width: 820px)')?.matches) return false;
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (!flags?.current?.()) return false;
    return !!flags.has?.('channels', 'sidebar_tab');
  }

  function applySidebarChannelsFeatureFlag(){
    const sidebar = document.getElementById('mainSidebar');
    const enabled = sidebarChannelsFeatureEnabled();
    sidebar?.classList.toggle('channels-tab-enabled', enabled);
    if (!enabled) {
      sidebarChannelsController?.destroy?.();
      sidebarChannelsController = null;
    }
    return enabled;
  }

  function sidebarAgentsFeatureEnabled(){
    if (window.matchMedia?.('(max-width: 820px)')?.matches) return false;
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (!flags?.current?.()) return false;
    if (window.Portal?.can?.('apps.assistant') === false) return false;
    const user = window.Portal?.currentUser;
    if (user?.canAccessApplication && !user.canAccessApplication('management') && !user.canAccessApplication('field')) return false;
    if (!['use_assistant', 'view_projects', 'manage_projects', 'manage_company_settings'].some((permission) => window.Portal?.util?.hasPerm?.(permission))) return false;
    return !!flags.has?.('assistant', 'sidebar_tab');
  }

  function applySidebarAgentsFeatureFlag(){
    const enabled = sidebarAgentsFeatureEnabled();
    document.getElementById('mainSidebar')?.classList.toggle('agents-tab-enabled', enabled);
    if (!enabled) window.PlatformAssistant?.unmountSidebar?.();
    return enabled;
  }

  function mountSidebarAgents(){
    const container = document.getElementById('sidebarAgentsList');
    if (!container) return;
    if (!window.PlatformAssistant?.mountSidebar) {
      container.textContent = 'Agent conversations are loading…';
      return;
    }
    window.PlatformAssistant.mountSidebar(container);
  }

  function mountSidebarChannels(){
    const container = document.getElementById('sidebarChannelsList');
    if (!container) return;
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (sidebarChannelsController) {
      sidebarChannelsController.refresh?.();
      return;
    }
    const orgId = cleanText(APP.userOrgId, APP.orgId, window.__APP?.userOrgId, window.__APP?.orgId);
    if (!orgId || !window.FirstMateChannels?.create || !window.ChannelsAPI) {
      container.innerHTML = `<div style="padding:14px 8px;color:#667085;font-size:12px;font-weight:850">${(globalThis.PlatformLanguage?.text("platform","m_ab82fba58e1b16","Channels are not available.") ?? "Channels are not available.")}</div>`;
      return;
    }
    container.innerHTML = '';
    sidebarChannelsController = window.FirstMateChannels.create(container, {
      mode: 'list',
      orgId,
      currentUser: {
        id: cleanText(APP.userId, APP.user_id, window.Portal?.currentUser?.id),
        name: cleanText(APP.userName, APP.userEmail),
        email: cleanText(APP.userEmail).toLowerCase()
      },
      realtime: true,
      features: {
        saved: false,
        search: false,
        threads: !!flags.has?.('channels', 'threads', true),
        reactions: !!flags.has?.('channels', 'reactions', true),
        dms: !!flags.has?.('channels', 'dms', true),
        attachments: !!flags.has?.('channels', 'attachments', true),
        pins: !!flags.has?.('channels', 'pins', true),
        attention: !!flags.has?.('channels', 'attention_v2', true),
        richMessages: !!flags.has?.('channels', 'rich_messages', true),
        resources: !!flags.has?.('channels', 'resources', true),
        clips: !!flags.has?.('channels', 'clips', true),
        workflows: !!flags.has?.('channels', 'workflows', true),
        ai: !!flags.has?.('channels', 'ai', true),
        huddles: !!flags.has?.('channels', 'huddles', true),
        recording: !!flags.has?.('channels', 'recording', false),
        recordVideo: !!flags.has?.('channels', 'record_video', true)
      },
      onOpenChannel(channelId){
        window.FirstMateChannelsOverlay?.open?.(channelId);
        window.__mobileSidebar?.close?.();
      },
      onOpenView(view){
        window.FirstMateChannelsOverlay?.openView?.(view);
        window.__mobileSidebar?.close?.();
      }
    });
  }

  function applySidebarFeatureFlags(){
    applySidebarLayoutFeatureFlags();
    const sidebar = document.getElementById('mainSidebar');
    const modes = [
      { key: 'apps', enabled: applySidebarAppsFeatureFlag(), tab: document.getElementById('sidebarAppsTab') },
      { key: 'todo', enabled: applySidebarTodoFeatureFlag(), tab: document.getElementById('sidebarTodoTab') },
      { key: 'channels', enabled: applySidebarChannelsFeatureFlag(), tab: document.getElementById('sidebarChannelsTab') },
      { key: 'agents', enabled: applySidebarAgentsFeatureFlag(), tab: document.getElementById('sidebarAgentsTab') }
    ];
    const available = modes.filter((mode) => mode.enabled);
    sidebar?.classList.toggle('sidebar-modes-switchable', available.length > 1);
    for (const mode of modes) {
      if (mode.tab) mode.tab.hidden = !mode.enabled;
    }
    const active = modes.find((mode) => mode.tab?.classList.contains('active'))?.key || '';
    const preferred = available.some((mode) => mode.key === 'agents') && window.PlatformAssistant?.isFull?.()
      ? 'agents'
      : sidebarModeUserSelected && available.some((mode) => mode.key === active)
        ? active
        : sidebarDefaultMode();
    setSidebarPanel(available.some((mode) => mode.key === preferred) ? preferred : (available[0]?.key || ''));
  }

  function initializeSidebarModes(){
    const appsTab = document.getElementById('sidebarAppsTab');
    const todoTab = document.getElementById('sidebarTodoTab');
    const channelsTab = document.getElementById('sidebarChannelsTab');
    const agentsTab = document.getElementById('sidebarAgentsTab');
    if (!appsTab || !todoTab) return;
    appsTab.addEventListener('click', () => {
      if (sidebarAppsFeatureEnabled()) {
        sidebarModeUserSelected = true;
        setSidebarPanel('apps');
      }
    });
    todoTab.addEventListener('click', () => {
      if (sidebarTodoFeatureEnabled()) {
        sidebarModeUserSelected = true;
        setSidebarPanel('todo');
      }
    });
    channelsTab?.addEventListener('click', () => {
      if (sidebarChannelsFeatureEnabled()) {
        sidebarModeUserSelected = true;
        setSidebarPanel('channels');
      }
    });
    agentsTab?.addEventListener('click', () => {
      if (sidebarAgentsFeatureEnabled()) {
        sidebarModeUserSelected = true;
        setSidebarPanel('agents');
      }
    });
    window.addEventListener('fm:assistant:ready', () => {
      if (document.getElementById('sidebarAgentsTab')?.classList.contains('active')) mountSidebarAgents();
    });
    window.addEventListener('resize', applySidebarFeatureFlags, { passive:true });
    window.addEventListener('fm:app-flags:updated', applySidebarFeatureFlags);
    window.addEventListener('fm:perms:updated', applySidebarFeatureFlags);
    window.addEventListener('fm:platform-session:updated', applySidebarFeatureFlags);
    window.addEventListener('fm:app-flags:failed', applySidebarFeatureFlags);
    // Closing the conversation overlay clears the rail's active highlight.
    window.addEventListener('fm:channels-overlay:closed', () => {
      sidebarChannelsController?.setChannel?.('');
    });
    applySidebarFeatureFlags();
  }

  window.Portal.sidebarModes = { activate:setSidebarPanel, agentsEnabled:sidebarAgentsFeatureEnabled };

  function updateMobileTabTitle(tab){
    const topbar = document.querySelector('.mobile-topbar');
    const title = document.getElementById('mobTabTitle');
    if (!topbar || !title) return;
    const text = terminologyLabel(tab?.terminologyKey, tab?.title || '');
    title.textContent = text;
    topbar.classList.toggle('has-tab-title', !!text);
  }

  function defaultPortalTab(list = []){
    // With no explicit route, the sidebar order is the navigation contract.
    // Entitlement `defaultHome` hints are useful inside embedded/project
    // surfaces, but must not jump the top-level portal past its first app.
    return list[0]?.id || null;
  }

  // --- App catalog ----------------------------------------------------------
  // The org-facing "add apps" surface. Catalog entries are capability app
  // nodes (kind:"app") that the registry marks discoverable, joined with the
  // apps manifest for presentation (icon, portal tab). An app is *addable*
  // when it is available to the org but its capability currently resolves
  // off; the More Apps menu and the Manage My Apps settings view both render
  // from this list.
  const appSetupHandlers = new Map();
  const appSetupDefinitions = new Map();

  function appSetupDescription(capabilityKey){
    const key = cleanText(capabilityKey);
    const source = appSetupDefinitions.get(key) || {};
    let status = cleanText(source.status) || 'not_started';
    if (typeof source.getStatus === 'function') {
      try { status = cleanText(source.getStatus()) || status; } catch (error) {}
    }
    if (!['not_started', 'in_progress', 'complete', 'blocked'].includes(status)) status = 'not_started';
    return {
      ...source,
      key,
      mode: ['required', 'optional', 'none'].includes(cleanText(source.mode)) ? cleanText(source.mode) : 'none',
      status,
      external: source.external === true,
      summary: cleanText(source.summary),
      actionLabel: cleanText(source.actionLabel),
      launchable: appSetupHandlers.has(key)
    };
  }

  function manifestAppForCapability(capabilityKey){
    const apps = window.FirstMateAppsManifest?.apps || [];
    const matches = apps.filter((app) => app?.access?.capability === capabilityKey);
    return matches.find((app) => app.kind === 'portal_tab') || matches[0] || null;
  }

  function normalizeAppStatusPills(...sources){
    return sources.flatMap((source) => Array.isArray(source) ? source : [])
      .map((pill, index) => {
        const source = typeof pill === 'string' ? { label:pill } : (pill || {});
        const label = cleanText(source.label, source.text);
        if (!label) return null;
        const tone = cleanText(source.tone).toLowerCase();
        return {
          id: cleanText(source.id) || `status-${index}`,
          label,
          tone: ['neutral', 'info', 'success', 'warning', 'danger'].includes(tone) ? tone : 'neutral'
        };
      })
      .filter(Boolean);
  }

  function appCatalogEntries(){
    const capState = window.PlatformAPI?.capabilities?.current?.();
    if (!capState || window.PlatformAPI?.capabilities?.value?.("platform.more_apps", false) !== true) return [];
    return (capState.definitions || [])
      .filter((node) => node.kind === 'app' && node.discoverable !== false)
      .map((node) => {
        const manifestApp = manifestAppForCapability(node.key);
        // Icons usually arrive when the app bundle registers itself; the
        // runtime definition is available (getApp) even while the capability
        // resolves off, so disabled apps still present with their real icon.
        const runtimeApp = manifestApp ? window.FirstMateEmbeddableApps?.getApp?.(manifestApp.id) : null;
        const enabled = capState.effective_by_key?.[node.key] === true;
        const appId = cleanText(manifestApp?.id);
        const tabId = manifestApp?.kind === 'portal_tab' ? cleanText(manifestApp.portalTabId) : '';
        const configuredPlacement = cleanText(window.PlatformAPI?.appFlags?.current?.()?.app_placements?.[appId.toLowerCase()]).toLowerCase();
        const placement = cleanText(TabRegistry.tabs.get(tabId)?.placement)
          || (manifestApp ? portalAppPlacement(manifestApp) : (configuredPlacement || 'more'));
        return {
          key: node.key,
          appId,
          label: node.label || node.key,
          description: node.description || '',
          stub: node.catalog_stub || node.description || '',
          category: node.category || '',
          icon: cleanText(node.icon) || cleanText(runtimeApp?.icon) || cleanText(manifestApp?.icon) || 'fa-circle',
          tabId,
          placement,
          pinnable: !!(appId && tabId),
          pinned: !!(appId && tabId && placement === 'sidebar'),
          statusPills: normalizeAppStatusPills(node.status_pills, manifestApp?.statusPills, runtimeApp?.statusPills),
          enabled,
          addable: !enabled,
          setup: appSetupDescription(node.key)
        };
      });
  }

  // Enabling an app also enables any parent/required capabilities that are
  // currently off — "Add to Platform" must land the app in a working state.
  function appCatalogEnableValues(capabilityKey){
    const capState = window.PlatformAPI?.capabilities?.current?.();
    const byKey = capState?.definitions_by_key || {};
    const values = {};
    const visit = (nodeKey, stack) => {
      const node = byKey[nodeKey];
      if (!node || stack.includes(nodeKey)) return;
      const storesBoolean = node.stores_value !== false && (node.type || 'boolean') === 'boolean';
      if (storesBoolean && capState.effective_by_key?.[nodeKey] !== true) values[nodeKey] = true;
      [...(node.parent ? [node.parent] : []), ...(Array.isArray(node.requires) ? node.requires : [])]
        .forEach((dependency) => visit(dependency, [...stack, nodeKey]));
    };
    visit(cleanText(capabilityKey), []);
    return values;
  }

  async function addCatalogApp(capabilityKey){
    const values = appCatalogEnableValues(capabilityKey);
    if (!Object.keys(values).length) return window.PlatformAPI?.capabilities?.current?.() || null;
    return window.Portal.capabilities.update(values);
  }

  async function removeCatalogApp(capabilityKey){
    return window.Portal.capabilities.update({ [cleanText(capabilityKey)]: false });
  }

  // Post-add hand-off: a registered setup workflow wins (apps that need
  // configuration register one via Portal.appSetup); otherwise land the user
  // in the app's freshly enabled portal tab.
  function launchCatalogApp(entry, context = {}){
    if (!entry) return;
    const handler = appSetupHandlers.get(entry.key);
    const setup = appSetupDescription(entry.key);
    if (handler && setup.mode === 'required' && setup.status !== 'complete') {
      Promise.resolve(handler({ mode: 'post_add', entry, ...context })).catch(() => null);
      return;
    }
    if (entry.tabId && TabRegistry.tabs.has(entry.tabId)) {
      activateTab(entry.tabId, false, { history: 'push', source: 'app-catalog' });
    }
  }

  function ensureAppCatalogModalStyles(){
    injectCSS('app_catalog_modal', `
      .fm-app-catalog-overlay{position:fixed;inset:0;background:rgba(15,23,42,.44);display:grid;place-items:center;padding:14px;z-index:2147483200}
      .fm-app-catalog-overlay.is-over-advanced-apps{inset:0 0 0 var(--fm-app-catalog-sidebar-edge,0px);background:rgba(3,8,18,.58)}
      .fm-app-catalog-modal{position:relative;z-index:1;width:min(1120px,100%);height:min(760px,calc(100dvh - 28px));min-height:min(620px,calc(100dvh - 28px));background:#fff;border-radius:18px;box-shadow:0 28px 80px rgba(15,23,42,.3);display:grid;grid-template-rows:auto minmax(0,1fr) auto;overflow:hidden}
      .fm-app-catalog-modal header{display:flex;align-items:flex-start;gap:12px;padding:20px 22px 16px;border-bottom:1px solid #eaecf0}
      .fm-app-catalog-icon{width:52px;height:52px;border-radius:13px;background:#f1f3f5;display:grid;place-items:center;font-size:22px;color:#667085;flex:0 0 52px}
      .fm-app-catalog-heading h3{margin:2px 0 0;color:#101828;font-size:20px}
      .fm-app-catalog-category{display:inline-block;margin-top:3px;color:#98a2b3;font-size:10px;font-weight:850;text-transform:uppercase;letter-spacing:.04em}
      .fm-app-catalog-close{margin-left:auto;width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:#667085;cursor:pointer;flex:0 0 32px}
      .fm-app-catalog-close:hover{background:#f1f3f5}
      .fm-app-catalog-body{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(280px,.75fr);gap:0;min-height:0;overflow:auto}
      .fm-app-catalog-preview{position:relative;display:grid;place-items:center;min-height:420px;overflow:hidden;background:linear-gradient(145deg,#f8fafc 0%,#eef2f6 100%);border-right:1px solid #eaecf0;color:#98a2b3}
      .fm-app-catalog-preview:before,.fm-app-catalog-preview:after{position:absolute;border-radius:999px;background:rgba(var(--primary-rgb,217,48,37),.07);content:""}
      .fm-app-catalog-preview:before{width:360px;height:360px;top:-190px;right:-100px}.fm-app-catalog-preview:after{width:260px;height:260px;bottom:-150px;left:-80px}
      .fm-app-catalog-preview-icon{position:relative;z-index:1;display:grid;place-items:center;width:132px;height:132px;border:1px solid rgba(16,24,40,.08);border-radius:30px;background:#fff;box-shadow:0 22px 55px rgba(16,24,40,.12);font-size:52px;color:var(--primary-readable,var(--primary,#d93025))}
      .fm-app-catalog-details{align-self:start;padding:32px 30px}
      .fm-app-catalog-details h4{margin:0 0 12px;color:#101828;font-size:22px;line-height:1.25}
      .fm-app-catalog-body p{margin:0 0 18px;color:#475467;font-size:14px;font-weight:650;line-height:1.65}
      .fm-app-catalog-state{padding:13px 14px;border-radius:10px;background:#f8fafc;color:#667085!important;font-size:11px!important;font-weight:850!important}
      .fm-app-catalog-modal footer{display:flex;align-items:center;gap:10px;padding:16px 22px;border-top:1px solid #eaecf0;background:#fff}
      .fm-app-catalog-status{flex:1;min-height:14px;color:#667085;font-size:11px;font-weight:800}
      .fm-app-catalog-btn{border:0;border-radius:10px;padding:10px 16px;font:inherit;font-size:12px;font-weight:900;cursor:pointer}
      .fm-app-catalog-btn.ghost{background:#f2f4f7;color:#475467}
      .fm-app-catalog-btn.primary{background:var(--primary,#d93025);color:#fff}
      .fm-app-catalog-btn.danger{background:#fee4e2;color:#b42318}
      .fm-app-catalog-btn:disabled{opacity:.6;cursor:default}
      @media(max-width:720px){
        .fm-app-catalog-overlay{padding:0}
        .fm-app-catalog-modal{width:100%;height:100dvh;min-height:0;border-radius:0}
        .fm-app-catalog-modal header{padding:14px 16px 12px}.fm-app-catalog-heading h3{font-size:18px}
        .fm-app-catalog-body{grid-template-columns:1fr;align-content:start}
        .fm-app-catalog-preview{min-height:210px;border-right:0;border-bottom:1px solid #eaecf0}.fm-app-catalog-preview-icon{width:96px;height:96px;border-radius:24px;font-size:38px}
        .fm-app-catalog-details{padding:22px 18px}.fm-app-catalog-details h4{font-size:19px}
        .fm-app-catalog-modal footer{padding:12px 14px;flex-wrap:wrap}.fm-app-catalog-status{flex-basis:100%;order:-1;min-height:0}.fm-app-catalog-btn{flex:1;white-space:nowrap}
      }
    `);
  }

  function openAppCatalogModal(capabilityKey, options = {}){
    const entry = appCatalogEntries().find((item) => item.key === cleanText(capabilityKey));
    if (!entry) return null;
    ensureAppCatalogModalStyles();
    const overlay = document.createElement('div');
    const overAdvancedApps = options.preserveAdvancedMenu === true && advancedAppMenuOpen && advancedAppMenuOverlay;
    overlay.className = `fm-app-catalog-overlay${overAdvancedApps ? ' is-over-advanced-apps' : ''}`;
    if (overAdvancedApps) {
      overlay.style.setProperty(
        '--fm-app-catalog-sidebar-edge',
        advancedAppMenuOverlay.style.getPropertyValue('--fm-advanced-sidebar-edge') || '0px'
      );
    }
    const setup = entry.setup || appSetupDescription(entry.key);
    const setupNeeded = entry.enabled && setup.mode !== 'none' && setup.launchable;
    const setupStateCopy = setup.mode === 'required' && setup.status !== 'complete'
      ? (setup.status === 'in_progress' ? 'Setup is in progress. Continue before relying on this app.' : 'This app needs setup before it is ready to use.')
      : (setup.mode === 'optional' && setup.status !== 'complete'
        ? 'This app works now. Optional setup can tailor it to your organization.'
        : (setup.status === 'complete' ? 'Setup is complete. You can review it at any time.' : 'This app is ready to use.'));
    const setupActionLabel = setup.actionLabel || (setup.status === 'in_progress' ? 'Continue Setup' : (setup.status === 'complete' ? 'Review Setup' : 'Set Up'));
    overlay.innerHTML = `
      <div class="fm-app-catalog-modal" role="dialog" aria-modal="true" aria-label="${String(escapeHtml(entry.label))}">
        <header>
          <span class="fm-app-catalog-icon"><i class="fas ${String(escapeHtml(entry.icon))}" aria-hidden="true"></i></span>
          <div class="fm-app-catalog-heading">
            <h3>${String(escapeHtml(entry.label))}</h3>
            ${String(entry.category ? `<span class="fm-app-catalog-category">${escapeHtml(entry.category)}</span>` : '')}
          </div>
          <button type="button" class="fm-app-catalog-close" data-app-catalog-close aria-label="${(globalThis.PlatformLanguage?.text("platform","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark" aria-hidden="true"></i></button>
        </header>
        <div class="fm-app-catalog-body">
          <div class="fm-app-catalog-preview" aria-hidden="true">
            <span class="fm-app-catalog-preview-icon"><i class="fas ${String(escapeHtml(entry.icon))}"></i></span>
          </div>
          <div class="fm-app-catalog-details">
            <h4>${((v5) => globalThis.PlatformLanguage?.text("platform","m_661c04e299660b",`About ${v5}`,{v5}) ?? `About ${v5}`)(escapeHtml(entry.label))}</h4>
            <p>${String(escapeHtml(entry.description || 'No description yet.'))}</p>
          <p class="fm-app-catalog-state">${String(entry.enabled ? escapeHtml(setupStateCopy) : 'Included with your FirstMate plan — add it to start using it.')}</p>
          </div>
        </div>
        <footer>
          <span class="fm-app-catalog-status" data-app-catalog-status></span>
          <button type="button" class="fm-app-catalog-btn ghost" data-app-catalog-close>${(globalThis.PlatformLanguage?.text("platform","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
          ${String(entry.enabled
            ? `${setupNeeded ? `<button type="button" class="fm-app-catalog-btn primary" data-app-catalog-setup><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> ${escapeHtml(setupActionLabel)}</button>` : ''}<button type="button" class="fm-app-catalog-btn danger" data-app-catalog-remove>Turn Off</button>`
            : `<button type="button" class="fm-app-catalog-btn primary" data-app-catalog-add><i class="fas fa-plus" aria-hidden="true"></i> ${setup.mode === 'required' ? 'Add & Set Up' : 'Add to Platform'}</button>`)}
        </footer>
      </div>`;
    document.body.appendChild(overlay);
    const handle = window.Portal?.modals?.register?.(overlay, {
      id: `app-catalog:${entry.key}`,
      closeOnEscape: true,
      closeOnBackdrop: true,
      onClose: () => overlay.remove()
    });
    const close = () => { if (!handle || handle.close() === false) overlay.remove(); };
    overlay.querySelectorAll('[data-app-catalog-close]').forEach((button) => button.addEventListener('click', close));
    const status = overlay.querySelector('[data-app-catalog-status]');
    overlay.querySelector('[data-app-catalog-setup]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      if (status) status.textContent = (globalThis.PlatformLanguage?.text("platform","m_283f5d2773ab22","Opening setup…") ?? "Opening setup…");
      try {
        close();
        await window.Portal?.appSetup?.run?.(entry.key, { mode:'manage', entry, source:options.source || 'app-catalog' });
      } catch (error) {
        button.disabled = false;
        if (status) status.textContent = error?.message || 'Could not open setup.';
      }
    });
    overlay.querySelector('[data-app-catalog-add]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      if (status) status.textContent = (globalThis.PlatformLanguage?.text("platform","m_b946036e58d1b2","Adding…") ?? "Adding…");
      try {
        await addCatalogApp(entry.key);
        close();
        window.PlatformUI?.showToast?.(((v0) => globalThis.PlatformLanguage?.text("platform","m_e2b1a9b22bb595",`${v0} added to your platform.`,{v0}) ?? `${v0} added to your platform.`)(entry.label));
        options.onChange?.('added', entry);
        launchCatalogApp(entry, { source: options.source || 'app-catalog' });
      } catch (error) {
        button.disabled = false;
        if (status) status.textContent = error?.message || 'Could not add this app.';
      }
    });
    overlay.querySelector('[data-app-catalog-remove]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      if (status) status.textContent = (globalThis.PlatformLanguage?.text("platform","m_a22c1eb370c1d8","Turning off…") ?? "Turning off…");
      try {
        await removeCatalogApp(entry.key);
        close();
        window.PlatformUI?.showToast?.(((v0) => globalThis.PlatformLanguage?.text("platform","m_28e5cf2a88847a",`${v0} turned off.`,{v0}) ?? `${v0} turned off.`)(entry.label));
        options.onChange?.('removed', entry);
      } catch (error) {
        button.disabled = false;
        if (status) status.textContent = error?.message || 'Could not turn this app off.';
      }
    });
    return handle;
  }

  let preservedSidebarAccountButton = document.getElementById('accountSwitcherButton');
  let advancedAppMenuOpen = false;
  let advancedAppMenuOverlay = null;
  let advancedAppMenuAbort = null;
  let advancedAppMenuLauncher = null;

  async function updateAdvancedAppPin(appId, pinned){
    const normalizedId = cleanText(appId).toLowerCase();
    if (!normalizedId) return null;
    const placements = { ...(window.Portal?.appFlags?.current?.()?.app_placements || {}) };
    placements[normalizedId] = pinned ? 'sidebar' : 'more';
    return window.Portal?.appFlags?.updatePlacements?.(placements);
  }

  function closeAdvancedAppMenu(options = {}){
    if (!advancedAppMenuOpen && !advancedAppMenuOverlay) return;
    advancedAppMenuOpen = false;
    advancedAppMenuAbort?.abort?.();
    advancedAppMenuAbort = null;
    const overlay = advancedAppMenuOverlay;
    advancedAppMenuOverlay = null;
    const launcher = advancedAppMenuLauncher;
    advancedAppMenuLauncher = null;
    document.body.classList.remove('fm-advanced-app-menu-open');
    document.querySelector('.sidebar')?.classList.remove('sidebar-advanced-apps-open');
    document.querySelectorAll('[data-launcher="more"]').forEach((button) => {
      button.classList.remove('active');
      button.setAttribute('aria-expanded', 'false');
    });
    if (overlay) {
      overlay.classList.add('closing');
      window.setTimeout(() => overlay.remove(), 230);
    }
    if (options.restoreFocus !== false) window.setTimeout(() => launcher?.focus?.(), 0);
  }

  function renderAdvancedAppMenu(launcher = advancedAppMenuLauncher){
    if (!advancedAppMenuOpen || !advancedAppMenuEnabled()) {
      if (advancedAppMenuOpen) closeAdvancedAppMenu({ restoreFocus:false });
      return;
    }
    if (launcher) advancedAppMenuLauncher = launcher;
    advancedAppMenuAbort?.abort?.();
    advancedAppMenuAbort = new AbortController();
    const signal = advancedAppMenuAbort.signal;
    const sidebar = document.querySelector('.sidebar');
    sidebar?.classList.add('sidebar-advanced-apps-open');
    document.body.classList.add('fm-advanced-app-menu-open');
    document.querySelectorAll('[data-launcher="more"]').forEach((button) => {
      button.classList.add('active');
      button.setAttribute('aria-expanded', 'true');
    });

    const entries = appCatalogEntries().sort((a, b) => a.label.localeCompare(b.label));
    const enabled = entries
      .filter((entry) => entry.enabled)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.label.localeCompare(b.label));
    const appTile = (entry) => {
      const setupRequired = entry.enabled && entry.setup?.mode === 'required' && entry.setup?.status !== 'complete';
      const statusPills = entry.statusPills || [];
      return `
      <article class="fm-advanced-app-tile${entry.pinned ? ' is-pinned' : ' is-unpinned'}" data-advanced-app-tile="${escapeHtml(entry.key)}">
        ${!entry.pinnable ? '' : `<button type="button" class="fm-advanced-app-pin${String(entry.pinned ? ' is-pinned' : '')}" data-advanced-app-pin="${String(escapeHtml(entry.appId))}" aria-label="${((v2,v3,v4) => globalThis.PlatformLanguage?.text("platform","m_be9d2ffc499cb4",`${v2} ${v3} ${v4} the sidebar`,{v2,v3,v4}) ?? `${v2} ${v3} ${v4} the sidebar`)(entry.pinned ? 'Unpin' : 'Pin',escapeHtml(entry.label),entry.pinned ? 'from' : 'to')}" title="${String(entry.pinned ? 'Unpin from sidebar' : 'Pin to sidebar')}"><i class="fas fa-thumbtack" aria-hidden="true"></i></button>`}
        ${statusPills.length ? ("<div class=\"fm-advanced-app-status-pills\" aria-label=\"" + (globalThis.PlatformLanguage?.text("platform","m_bd09496c83ccd1","App status") ?? "App status") + "\">" + String(statusPills.map((pill) => `<span class="fm-advanced-app-status-pill is-${escapeHtml(pill.tone)}" data-status-pill="${escapeHtml(pill.id)}">${escapeHtml(pill.label)}</span>`).join('')) + "</div>") : ''}
        <div class="fm-advanced-app-icon-wrap">
          <button type="button" class="fm-advanced-app-icon-button" data-advanced-app-open="${escapeHtml(entry.key)}" aria-label="${setupRequired ? 'Set up' : 'Open'} ${escapeHtml(entry.label)}">
            <span class="fm-advanced-app-icon"><i class="fas ${escapeHtml(entry.icon)}" aria-hidden="true"></i></span>
          </button>
        </div>
        <button type="button" class="fm-advanced-app-open" data-advanced-app-open="${escapeHtml(entry.key)}" aria-label="${setupRequired ? 'Set up' : 'Open'} ${escapeHtml(entry.label)}"><strong>${escapeHtml(entry.label)}</strong></button>
      </article>`;
    };

    let overlay = advancedAppMenuOverlay;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'fm-advanced-apps-overlay';
      document.body.appendChild(overlay);
      advancedAppMenuOverlay = overlay;
    }
    const setSidebarEdge = () => {
      const edge = Math.max(0, Math.round(sidebar?.getBoundingClientRect?.().right || 0));
      overlay.style.setProperty('--fm-advanced-sidebar-edge', `${edge}px`);
    };
    setSidebarEdge();
    window.setTimeout(setSidebarEdge, 210);
    overlay.innerHTML = `
      <section class="fm-advanced-apps-panel" aria-label="${(globalThis.PlatformLanguage?.text("platform","m_a151b65da51bfd","All apps") ?? "All apps")}">
        <button type="button" class="fm-advanced-apps-close" data-advanced-apps-close aria-label="${(globalThis.PlatformLanguage?.text("platform","m_0838136c759dc3","Close apps") ?? "Close apps")}"><i class="fas fa-xmark" aria-hidden="true"></i></button>
        <div class="fm-advanced-apps-scroll">
          <nav class="fm-advanced-apps-grid" aria-label="${(globalThis.PlatformLanguage?.text("platform","m_290b7f9d844e1e","Active apps") ?? "Active apps")}">${String(enabled.map((entry) => appTile(entry)).join(''))}</nav>
        </div>
        <footer><button type="button" data-advanced-apps-manage><i class="fas fa-sliders" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.text("platform","m_1575b4a4cbcb3d"," Manage apps and features") ?? " Manage apps and features")}</button></footer>
      </section>`;

    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) closeAdvancedAppMenu();
    }, { signal });
    overlay.querySelector('[data-advanced-apps-close]')?.addEventListener('click', () => closeAdvancedAppMenu(), { signal });
    overlay.querySelector('[data-advanced-apps-manage]')?.addEventListener('click', () => {
      closeAdvancedAppMenu({ restoreFocus:false });
      window.Portal?.navigation?.navigate?.(
        { tab:'company_settings', sub:'app_flags', settingsView:'manage_apps', settingsEntity:'' },
        { source:'advanced-app-menu', ownedKeys:['tab', 'sub', 'settingsView'] }
      );
    }, { signal });
    overlay.querySelectorAll('[data-advanced-app-pin]').forEach((button) => button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const pinned = !button.classList.contains('is-pinned');
      button.disabled = true;
      try {
        await updateAdvancedAppPin(button.dataset.advancedAppPin, pinned);
        window.PlatformUI?.showToast?.(((v0) => globalThis.PlatformLanguage?.text("platform","m_3619e3a723d857",`${v0} the sidebar.`,{v0}) ?? `${v0} the sidebar.`)(pinned ? 'Pinned to' : 'Removed from'));
      } catch (error) {
        button.disabled = false;
        window.PlatformUI?.showToast?.(error?.message || 'Could not update the sidebar.');
      }
    }, { signal }));
    overlay.querySelectorAll('[data-advanced-app-open]').forEach((button) => button.addEventListener('click', () => {
      const entry = entries.find((item) => item.key === button.dataset.advancedAppOpen);
      const setupRequired = entry?.enabled && entry.setup?.mode === 'required' && entry.setup?.status !== 'complete';
      if (entry?.enabled && entry.tabId && !setupRequired) {
        closeAdvancedAppMenu({ restoreFocus:false });
        activateTab(entry.tabId, false, { history:'push', source:'advanced-app-menu' });
      } else if (entry) {
        openAppCatalogModal(entry.key, { source:'advanced-app-menu', preserveAdvancedMenu:true });
      }
    }, { signal }));
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAdvancedAppMenu();
    }, { signal });
    const fitAppGrid = () => {
      const viewport = overlay.querySelector('.fm-advanced-apps-scroll');
      const grid = overlay.querySelector('.fm-advanced-apps-grid');
      const count = enabled.length;
      const width = Math.max(0, viewport?.clientWidth || 0);
      const height = Math.max(0, viewport?.clientHeight || 0);
      if (!grid || !count || !width || !height) return;
      const gapRatio = 0.5;
      const edgeRatio = 1;
      let best = { columns:1, rows:count, tile:0 };
      for (let columns = 1; columns <= count; columns += 1) {
        const rows = Math.ceil(count / columns);
        const tile = Math.min(
          width / (columns + gapRatio * Math.max(0, columns - 1) + edgeRatio * 2),
          height / (rows + gapRatio * Math.max(0, rows - 1) + edgeRatio * 2)
        );
        const fill = count / (columns * rows);
        const score = tile * Math.pow(fill, 0.12);
        if (score > best.score || best.score == null) best = { columns, rows, tile, score };
      }
      const tileCap = Math.max(84, Math.min(width, height) * 0.28);
      const tile = Math.max(1, Math.floor(Math.min(best.tile, tileCap)));
      const gap = Math.max(1, Math.round(tile * gapRatio));
      grid.style.setProperty('--fm-advanced-columns', String(best.columns));
      grid.style.setProperty('--fm-advanced-tile-size', `${tile}px`);
      grid.style.setProperty('--fm-advanced-grid-gap', `${gap}px`);
      grid.style.setProperty('--fm-advanced-icon-size', `${Math.round(tile * 0.54)}px`);
      grid.style.setProperty('--fm-advanced-icon-font', `${Math.round(tile * 0.25)}px`);
      grid.style.setProperty('--fm-advanced-label-size', `${Math.max(9, Math.min(14, Math.round(tile * 0.075)))}px`);
      const controlSize = Math.max(22, Math.min(34, Math.round(tile * 0.18)));
      grid.style.setProperty('--fm-advanced-control-size', `${controlSize}px`);
      grid.style.setProperty('--fm-advanced-tile-radius', `${Math.max(12, Math.round(tile * 0.13))}px`);
      grid.style.setProperty('--fm-advanced-icon-radius', `${Math.max(10, Math.round(tile * 0.1))}px`);
      grid.style.setProperty('--fm-advanced-tile-padding', `${Math.max(5, Math.round(tile * 0.055))}px`);
      grid.style.setProperty('--fm-advanced-tile-gap', `${Math.max(2, Math.round(tile * 0.025))}px`);
      grid.style.setProperty('--fm-advanced-control-inset', `${Math.max(5, Math.round(tile * 0.055))}px`);
      grid.style.setProperty('--fm-advanced-control-radius', `${Math.max(6, Math.round(controlSize * 0.3))}px`);
      grid.style.setProperty('--fm-advanced-control-font', `${Math.max(9, Math.round(controlSize * 0.42))}px`);
      grid.style.setProperty('--fm-advanced-pill-height', `${Math.max(16, Math.round(controlSize * 0.72))}px`);
      grid.style.setProperty('--fm-advanced-pill-padding', `${Math.max(6, Math.round(controlSize * 0.3))}px`);
      grid.style.setProperty('--fm-advanced-pill-font', `${Math.max(8, Math.round(tile * 0.061))}px`);
    };
    const syncAdvancedAppLayout = () => window.requestAnimationFrame(() => {
      setSidebarEdge();
      fitAppGrid();
    });
    window.addEventListener('resize', syncAdvancedAppLayout, { signal });
    if (window.ResizeObserver) {
      const resizeObserver = new ResizeObserver(syncAdvancedAppLayout);
      resizeObserver.observe(overlay.querySelector('.fm-advanced-apps-scroll'));
      signal.addEventListener('abort', () => resizeObserver.disconnect(), { once:true });
    }
    syncAdvancedAppLayout();
    window.setTimeout(syncAdvancedAppLayout, 220);
    window.setTimeout(() => overlay.querySelector('[data-advanced-app-open]')?.focus(), 0);
  }

  function openAdvancedAppMenu(launcher){
    if (advancedAppMenuOpen) {
      closeAdvancedAppMenu();
      return;
    }
    window.FirstMateAccountSwitcher?.close?.();
    advancedAppMenuOpen = true;
    advancedAppMenuLauncher = launcher;
    renderAdvancedAppMenu(launcher);
  }

  function initSidebarAppScrolling(){
    const panel = document.getElementById('sidebarAppsPanel');
    const list = document.getElementById('sidebarMainLinks');
    const up = document.getElementById('sidebarAppsScrollUp');
    const down = document.getElementById('sidebarAppsScrollDown');
    if (!panel || !list || !up || !down) return;

    if (panel.__appScrollList !== list) {
      panel.__appScrollAbort?.abort?.();
      panel.__appScrollResizeObserver?.disconnect?.();
      panel.__appScrollMutationObserver?.disconnect?.();

      const abort = new AbortController();
      const update = () => {
        const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
        const overflowing = maxScroll > 1;
        const canScrollUp = overflowing && list.scrollTop > 1;
        const canScrollDown = overflowing && list.scrollTop < maxScroll - 1;
        panel.classList.toggle('sidebar-apps-overflowing', overflowing);
        panel.classList.toggle('sidebar-apps-can-scroll-up', canScrollUp);
        panel.classList.toggle('sidebar-apps-can-scroll-down', canScrollDown);
        up.hidden = !canScrollUp;
        down.hidden = !canScrollDown;
      };
      const scrollByPage = (direction) => {
        const distance = Math.max(64, Math.min(240, list.clientHeight * .72));
        list.scrollBy({ top:direction * distance, behavior:'smooth' });
      };

      up.addEventListener('click', () => scrollByPage(-1), { signal:abort.signal });
      down.addEventListener('click', () => scrollByPage(1), { signal:abort.signal });
      list.addEventListener('scroll', update, { signal:abort.signal, passive:true });

      const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
      resizeObserver?.observe(panel);
      resizeObserver?.observe(list);
      const mutationObserver = typeof MutationObserver === 'function' ? new MutationObserver(update) : null;
      mutationObserver?.observe(list, { childList:true, subtree:true });

      panel.__appScrollList = list;
      panel.__appScrollAbort = abort;
      panel.__appScrollResizeObserver = resizeObserver;
      panel.__appScrollMutationObserver = mutationObserver;
      panel.__updateAppScrollControls = update;
    }

    requestAnimationFrame(() => panel.__updateAppScrollControls?.());
  }

  function renderSidebarLaunchers(container, list = []){
    if (!container) return;
    container.__launcherAbort?.abort?.();
    const launcherAbort = new AbortController();
    container.__launcherAbort = launcherAbort;
    const accountButton = preservedSidebarAccountButton || document.getElementById('accountSwitcherButton');
    if (accountButton) preservedSidebarAccountButton = accountButton;
    const accountFooter = document.querySelector('.sidebar-footer');
    if (accountButton && accountFooter && container.contains(accountButton)) accountFooter.appendChild(accountButton);
    container.innerHTML = '';
    container.classList.remove('sidebar-launchers-single', 'sidebar-launchers-split', 'sidebar-launchers-integrated');
    // The More Apps menu is the add-apps catalog: every discoverable app the
    // org has not enabled yet. Once that catalog is empty, this launcher
    // becomes a direct Apps Settings shortcut instead of opening an empty menu.
    const catalogApps = appCatalogEntries().filter((entry) => entry.addable);
    const assistantApp = list.find((tab) => tab.id === 'assistant');
    const hasMoreApps = catalogApps.length > 0 || !!assistantApp;
    const advancedMenu = advancedAppMenuEnabled();
    if (!advancedMenu && advancedAppMenuOpen) closeAdvancedAppMenu({ restoreFocus:false });
    const settingsTabId = ['company', 'settings'].join('_');
    const settingsTab = list.find((tab) => tab.id === settingsTabId && tab.placement === 'settings');
    const capabilities = window.Portal?.capabilities || window.PlatformAPI?.capabilities;
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    const separateUserSection = capabilities?.current?.()
      ? capabilities.value?.('platform.separate_user_section', false) === true
      : (flags?.current?.() && flags.value?.('platform', 'separate_user_section', false) === true);
    const integratedUser = !separateUserSection && !!accountButton;
    if (accountButton && !accountButton.querySelector('.fm-account-launcher-user')) {
      accountButton.insertAdjacentHTML('afterbegin', '<i class="fas fa-user fm-account-launcher-user" aria-hidden="true"></i>');
    }
    accountFooter?.classList.toggle('sidebar-user-integrated', integratedUser);
    accountButton?.classList.toggle('sidebar-launcher-icon', integratedUser);
    if (!integratedUser && accountButton && accountFooter && accountButton.parentElement !== accountFooter) accountFooter.appendChild(accountButton);
    const split = !!settingsTab;
    const iconRow = split || integratedUser;
    container.classList.add(integratedUser ? 'sidebar-launchers-integrated' : (split ? 'sidebar-launchers-split' : 'sidebar-launchers-single'));
    let closeMoreApps = () => {};
    let moreButtonRef = null;
    let morePopoverRef = null;
    let settingsButtonRef = null;

    const makeSingleLink = (icon, label) => {
      const item = document.createElement('div');
      item.className = 'fm-link bottom';
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      const iconHtml = icon === 'fm-nine-dot-icon'
        ? '<span class="fm-nine-dot-icon" aria-hidden="true"></span>'
        : `<i class="fas ${icon}" aria-hidden="true"></i>`;
      item.innerHTML = `<div class="ic">${iconHtml}</div><div class="tx">${label}</div>`;
      return item;
    };
    const catalogEnabled = capabilities?.current?.()
      ? capabilities.value?.('platform.more_apps', false) === true
      : flags?.value?.('platform', 'more_apps', false) === true;
    if (catalogEnabled) {
      const launcherLabel = hasMoreApps ? 'More apps' : 'Apps';
      const resolvedLauncherLabel = advancedMenu ? 'Apps' : launcherLabel;
      const moreButton = iconRow ? document.createElement('button') : makeSingleLink('fm-nine-dot-icon', resolvedLauncherLabel);
      if (iconRow) moreButton.type = 'button';
      if (iconRow) moreButton.className = 'sidebar-launcher-icon';
      moreButton.dataset.launcher = 'more';
      moreButton.setAttribute('aria-label', resolvedLauncherLabel);
      if (hasMoreApps || advancedMenu) {
        moreButton.setAttribute('aria-haspopup', 'menu');
        moreButton.setAttribute('aria-expanded', 'false');
      }
      moreButton.title = resolvedLauncherLabel;
      if (iconRow) moreButton.innerHTML = '<span class="fm-nine-dot-icon" aria-hidden="true"></span>';

      const popover = document.createElement('section');
      popover.className = 'fm-more-apps-popover';
      popover.setAttribute('role', 'menu');
      popover.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("platform","m_cba67dfaef4579","More FirstMate apps") ?? "More FirstMate apps"));
      popover.hidden = true;
      const preferredCatalogColumns = (count) => {
        if (count <= 3) return Math.max(1, count);
        if (count === 4) return 2;
        if (count <= 9) return 3;
        if (count <= 16) return 4;
        if (count <= 19) return 5;
        if (count <= 23) return 6;
        return 7;
      };
      const assistantTile = assistantApp ? `<div style="position:relative"><button type="button" class="fm-more-app" role="menuitem" data-active-app="assistant"><span class="fm-more-app-icon"><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i></span><span class="fm-more-app-name">FirstMate Assistant</span></button><button type="button" data-assistant-pin="${assistantApp.placement === 'sidebar' ? 'unpin' : 'pin'}" aria-label="${assistantApp.placement === 'sidebar' ? 'Unpin' : 'Pin'} FirstMate Assistant" title="${assistantApp.placement === 'sidebar' ? 'Unpin' : 'Pin'} FirstMate Assistant" style="position:absolute;top:0;right:0;border:0;background:transparent;padding:8px;cursor:pointer;color:#667085"><i class="fas fa-thumbtack" aria-hidden="true"></i></button></div>` : '';
      const catalogGrid = (catalogApps.length || assistantApp) ? `<nav class="fm-more-apps-grid">${assistantTile}${catalogApps.map((entry) => `
        <button type="button" class="fm-more-app" role="menuitem" data-catalog-app="${escapeHtml(entry.key)}">
          <span class="fm-more-app-icon"><i class="fas ${escapeHtml(entry.icon)}" aria-hidden="true"></i></span>
          <span class="fm-more-app-name">${escapeHtml(entry.label)}</span>
          <span class="fm-more-app-desc">${escapeHtml(entry.stub)}</span>
        </button>`).join('')}</nav>` : `<div class="fm-more-apps-empty">${(globalThis.PlatformLanguage?.text("platform","m_5f329f8bb1c9f0","Every available app is already on your platform.") ?? "Every available app is already on your platform.")}</div>`;
      popover.innerHTML = `<header class="fm-more-apps-head"><strong class="fm-more-apps-title">${(globalThis.PlatformLanguage?.text("platform","m_cba67dfaef4579","More FirstMate apps") ?? "More FirstMate apps")}</strong><button type="button" data-more-apps-close aria-label="${(globalThis.PlatformLanguage?.text("platform","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark" aria-hidden="true"></i></button></header>${String(catalogGrid)}<footer class="fm-more-apps-foot"><button type="button" data-more-apps-manage role="menuitem"><i class="fas fa-sliders" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.text("platform","m_c2d1b0f24c343f"," Manage my apps") ?? " Manage my apps")}</button></footer>`;
      let closeTimer = 0;
      const finishClose = () => {
        window.clearTimeout(closeTimer);
        closeTimer = 0;
        popover.hidden = true;
        popover.classList.remove('closing');
      };
      const close = () => {
        if (popover.hidden || popover.classList.contains('closing')) return;
        popover.classList.add('closing');
        moreButton.setAttribute('aria-expanded', 'false');
        closeTimer = window.setTimeout(finishClose, 220);
      };
      const positionPopover = () => {
        if (window.innerWidth <= 820) return;
        const anchor = moreButton.getBoundingClientRect();
        const viewportMargin = 16;
        const anchorGap = 12;
        const tileWidth = 124;
        const tileHeight = 116;
        const gridGap = 10;
        const horizontalChrome = 48;
        const verticalChrome = 146;
        const availableWidth = window.innerWidth - (viewportMargin * 2);
        const availableHeight = Math.max(240, anchor.top - anchorGap - viewportMargin);
        const maximumColumns = Math.max(1, Math.floor((availableWidth - horizontalChrome + gridGap) / (tileWidth + gridGap)));
        const tileCount = catalogApps.length + (assistantApp ? 1 : 0);
        const columns = Math.min(preferredCatalogColumns(tileCount), maximumColumns);
        const rows = Math.max(1, Math.ceil(tileCount / columns));
        const width = Math.min(960, availableWidth, Math.max(300, (columns * tileWidth) + ((columns - 1) * gridGap) + horizontalChrome));
        const height = Math.min(640, availableHeight, (rows * tileHeight) + ((rows - 1) * gridGap) + verticalChrome);
        const anchorCenter = anchor.left + (anchor.width / 2);
        const left = Math.max(viewportMargin, Math.min(anchorCenter - 32, window.innerWidth - viewportMargin - width));
        popover.style.setProperty('--fm-more-app-columns', String(columns));
        popover.style.setProperty('--fm-more-apps-left', `${Math.round(left)}px`);
        popover.style.setProperty('--fm-more-apps-bottom', `${Math.round(window.innerHeight - anchor.top + anchorGap)}px`);
        popover.style.setProperty('--fm-more-apps-width', `${Math.round(width)}px`);
        popover.style.setProperty('--fm-more-apps-height', `${Math.round(height)}px`);
        popover.style.setProperty('--fm-more-apps-caret-left', `${Math.round(anchorCenter - left)}px`);
      };
      closeMoreApps = advancedMenu ? () => closeAdvancedAppMenu({ restoreFocus:false }) : close;
      moreButtonRef = moreButton;
      morePopoverRef = popover;
      moreButton.addEventListener('click', (event) => {
        event.stopPropagation();
        window.FirstMateAccountSwitcher?.close?.();
        if (advancedMenu) {
          openAdvancedAppMenu(moreButton);
          return;
        }
        if (!hasMoreApps) {
          if (window.Portal?.navigation?.navigate) {
            window.Portal.navigation.navigate(
              { tab: settingsTabId, sub:'app_flags', settingsView:'manage_apps', settingsEntity:'' },
              { source:'apps-launcher', ownedKeys:['tab', 'sub', 'settingsView'] }
            );
          } else activateTab(settingsTabId, false, { history:'push', source:'apps-launcher' });
          return;
        }
        const opening = popover.hidden || popover.classList.contains('closing');
        if (opening) {
          window.clearTimeout(closeTimer);
          popover.classList.remove('closing');
          positionPopover();
          popover.hidden = false;
        } else close();
        moreButton.setAttribute('aria-expanded', opening ? 'true' : 'false');
        if (opening) (popover.querySelector('.fm-more-app') || popover.querySelector('[data-more-apps-manage]'))?.focus();
      });
      moreButton.addEventListener('keydown', (event) => {
        if (!iconRow && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); moreButton.click(); }
      });
      popover.querySelector('[data-more-apps-close]')?.addEventListener('click', () => { close(); moreButton.focus(); });
      popover.addEventListener('click', (event) => {
        const pin = event.target.closest?.('[data-assistant-pin]');
        if (pin) {
          pin.disabled = true;
          updateAdvancedAppPin('portal.assistant', pin.dataset.assistantPin === 'pin')
            .catch((error) => { pin.disabled = false; window.PlatformUI?.showToast?.(error?.message || 'Could not update the sidebar.'); });
          return;
        }
        if (event.target.closest?.('[data-active-app="assistant"]')) {
          close();
          activateTab('assistant', false, {history:'push', source:'more-apps'});
          return;
        }
        if (event.target.closest?.('[data-more-apps-manage]')) {
          close();
          if (window.Portal?.navigation?.navigate) {
            window.Portal.navigation.navigate(
              { tab: settingsTabId, sub:'app_flags', settingsView:'manage_apps', settingsEntity:'' },
              { source:'more-apps', ownedKeys:['tab', 'sub', 'settingsView'] }
            );
          } else activateTab(settingsTabId, false, { history:'push', source:'more-apps' });
          return;
        }
        const item = event.target.closest?.('[data-catalog-app]');
        if (!item) return;
        close();
        openAppCatalogModal(item.dataset.catalogApp, { source:'more-apps' });
      });
      popover.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { close(); moreButton.focus(); }
      });
      document.addEventListener('click', (event) => {
        if (!container.contains(event.target)) close();
      }, { signal: launcherAbort.signal });
      window.addEventListener('resize', () => {
        if (!popover.hidden) positionPopover();
      }, { signal: launcherAbort.signal });
      container.append(moreButton, popover);
      if (advancedMenu && advancedAppMenuOpen) renderAdvancedAppMenu(moreButton);
    }
    if (split && !integratedUser) {
      const divider = document.createElement('span');
      divider.className = 'sidebar-launcher-divider';
      divider.setAttribute('aria-hidden', 'true');
      container.appendChild(divider);
    }
    if (settingsTab) {
      const settingsButton = iconRow ? document.createElement('button') : makeSingleLink('fa-gear', 'Settings');
      if (iconRow) settingsButton.type = 'button';
      if (iconRow) settingsButton.className = 'sidebar-launcher-icon';
      settingsButton.dataset.tab = settingsTab.id;
      settingsButton.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("platform","m_7d461dc7d355cc","Settings") ?? "Settings"));
      settingsButton.title = (globalThis.PlatformLanguage?.text("platform","m_7d461dc7d355cc","Settings") ?? "Settings");
      if (iconRow) settingsButton.innerHTML = '<i class="fas fa-gear" aria-hidden="true"></i>';
      settingsButton.addEventListener('click', () => {
        closeMoreApps();
        activateTab(settingsTab.id, false, { history:'push', source:'settings-launcher' });
      });
      settingsButton.addEventListener('keydown', (event) => {
        if (!iconRow && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); settingsButton.click(); }
      });
      container.appendChild(settingsButton);
      settingsButtonRef = settingsButton;
      if (split && !integratedUser) {
        const moreButton = container.querySelector('[data-launcher="more"]');
        const divider = container.querySelector('.sidebar-launcher-divider');
        const popover = container.querySelector('.fm-more-apps-popover');
        container.append(settingsButton, divider, moreButton, popover);
      }
    }
    if (integratedUser && accountButton) {
      accountButton.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("platform","m_5daff8195c98c2","User and accounts") ?? "User and accounts"));
      accountButton.title = (globalThis.PlatformLanguage?.text("platform","m_5daff8195c98c2","User and accounts") ?? "User and accounts");
      accountButton.addEventListener('click', closeMoreApps, { signal: launcherAbort.signal });
      const launchers = [settingsButtonRef, moreButtonRef, accountButton].filter(Boolean);
      const row = [];
      launchers.forEach((launcher, index) => {
        if (index) {
          const divider = document.createElement('span');
          divider.className = 'sidebar-launcher-divider';
          divider.setAttribute('aria-hidden', 'true');
          row.push(divider);
        }
        row.push(launcher);
      });
      document.getElementById('sidebarLogoutLow')?.remove();
      container.append(...row, ...(morePopoverRef ? [morePopoverRef] : []));
    } else if (accountButton) {
      accountButton.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("platform","m_306d6be0a27c61","Choose account") ?? "Choose account"));
      accountButton.removeAttribute('title');
    }
  }

  function renderTabs(){
    if (!TabRegistry.routesReady) return;
    syncPortalTabsFromRuntime();
    const links = ensureSidebarLinksContainer();
    const panels = document.getElementById('mainPanels');
    if (!links || !panels) return;

    const placementOrder = { sidebar:0, more:1, settings:2 };
    const list = [...TabRegistry.tabs.values()].filter((tab) => (
      tab.placement !== 'hidden' && (tab.placement !== 'settings' || tab.id === 'company_settings')
    )).sort((a,b) => (
      (placementOrder[a.placement] ?? 3) - (placementOrder[b.placement] ?? 3) || a.order - b.order
    ));
    const availableIds = new Set(list.map((tab) => tab.id));
    let currentRoute = routeState();
    // A tab we do not recognise yet may belong to a project modal — but not
    // when the route points at a global-scope viewer, where the tab is a
    // portal tab whose app simply has not registered yet.
    const globalScopeRoute = String(currentRoute.photoScope || '').toLowerCase() === 'feed';
    if (currentRoute.project && currentRoute.tab && !availableIds.has(currentRoute.tab) && !currentRoute.projectTab && !globalScopeRoute) {
      setRouteState({ projectTab: currentRoute.tab, tab: null });
    }

    injectCSS('sidebar_links', `
      #sidebarLinks{
        margin-top: 0;
        display:flex;
        flex-direction:column;
        flex:1;
        min-height:0;
        overflow:hidden;
        gap: 10px;
        padding: 0 6px;
      }
      #sidebarMainLinks,
      #sidebarBottomLinks{
        display:flex;
        flex-direction:column;
        gap: 10px;
      }
      #sidebarMainLinks{
        flex:1 1 auto;
        min-height:0;
        overflow-x:hidden;
        overflow-y:auto;
        overscroll-behavior:contain;
        scrollbar-width:none;
        scroll-behavior:smooth;
      }
      #sidebarMainLinks::-webkit-scrollbar{display:none}
      #sidebarBottomLinks{
        margin-top:auto!important;
        flex:0 0 auto;
        position:relative;
      }
      #sidebarBottomLinks.sidebar-launchers-split{display:grid;grid-template-columns:minmax(0,1fr) 1px minmax(0,1fr);align-items:center;gap:0}
      .sidebar-scroll:has(#sidebarBottomLinks.sidebar-launchers-integrated){padding-bottom:var(--fm-sidebar-safe-bottom,env(safe-area-inset-bottom,0px))}
      #sidebarBottomLinks.sidebar-launchers-integrated{display:flex;flex-direction:row;align-items:center;gap:0;border-top:1px solid rgba(0,0,0,.06);padding:7px 0}
      #sidebarBottomLinks.sidebar-launchers-integrated>.sidebar-launcher-icon{flex:1 1 0;width:auto}
      #sidebarBottomLinks.sidebar-launchers-single{flex-direction:column;align-items:stretch}
      #sidebarBottomLinks>.fm-link{width:100%;text-align:left}
      .sidebar-launcher-icon{display:grid;place-items:center;justify-self:center;width:28px;height:32px;padding:0;border:0;background:transparent;color:#6b7280;font:inherit;font-size:15px;line-height:1;text-align:center;cursor:pointer}
      #sidebarBottomLinks .sidebar-launcher-icon.active{color:#6b7280}
      .sidebar-launcher-divider{width:1px;height:22px;background:#e3e6eb;flex:0 0 1px}
      #sidebarBottomLinks.sidebar-launchers-split + .sidebar-footer{margin-top:-6px;padding-top:7px}
      .sidebar-footer.sidebar-user-integrated{display:none!important}
      #sidebarBottomLinks .fm-account-switcher-trigger.sidebar-launcher-icon{display:grid;min-width:0;border-radius:0;background:transparent!important;text-align:center!important}
      #sidebarBottomLinks .fm-account-switcher-trigger.sidebar-launcher-icon .fm-account-avatar,#sidebarBottomLinks .fm-account-switcher-trigger.sidebar-launcher-icon .fm-account-trigger-copy,#sidebarBottomLinks .fm-account-switcher-trigger.sidebar-launcher-icon .fm-account-trigger-chevron{display:none}
      .fm-account-launcher-user{display:none}.fm-account-switcher-trigger.sidebar-launcher-icon .fm-account-launcher-user{display:inline-block}
      @keyframes fmAdvancedAppsReveal{from{opacity:0}to{opacity:1}}
      @keyframes fmAdvancedAppsPanelIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
      @keyframes fmAdvancedAppsDismiss{to{opacity:0}}
      @keyframes fmSidebarPinIn{from{opacity:0;transform:translate(-10px,-50%) rotate(-18deg)}to{opacity:1;transform:translate(0,-50%) rotate(0)}}
      @media(min-width:821px){.sidebar.sidebar-compact.sidebar-advanced-apps-open{width:var(--sidebar);margin-right:0}.sidebar.sidebar-compact.sidebar-compact-overlap.sidebar-advanced-apps-open{margin-right:0}}
      .fm-sidebar-app-pin{position:absolute;top:50%;left:0;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:#98a2b3;opacity:0;pointer-events:none;cursor:pointer;transform:translate(-10px,-50%) rotate(-18deg);transition:opacity .16s ease,background .16s ease,color .16s ease,transform .22s ease}
      .sidebar-advanced-apps-open .fm-link{padding-left:32px}
      .sidebar-advanced-apps-open .fm-sidebar-app-pin{opacity:1;pointer-events:auto;animation:fmSidebarPinIn .28s cubic-bezier(.2,.9,.25,1) both}
      .sidebar-advanced-apps-open .fm-link .ic{transform:translateX(3px);transition:transform .24s cubic-bezier(.2,.8,.2,1),color .14s ease}
      .fm-sidebar-app-pin:hover,.fm-sidebar-app-pin:focus-visible{background:#f1f3f5;color:var(--primary-readable,var(--primary,#d93025));outline:none;transform:translate(0,-50%) rotate(-12deg)}
      .fm-sidebar-app-pin:disabled{opacity:.45;cursor:wait}
      .fm-advanced-apps-overlay{position:fixed;z-index:2147483003;inset:0 0 0 var(--fm-advanced-sidebar-edge,var(--sidebar));display:block;padding:clamp(20px,2.5vw,40px);box-sizing:border-box;background:rgba(3,8,18,.86);animation:fmAdvancedAppsReveal .2s ease both}
      body.has-attention-topbar .fm-advanced-apps-overlay{top:var(--attention-topbar-offset,48px)}
      body:has(#impersonationBanner) .fm-advanced-apps-overlay{top:max(44px,var(--attention-topbar-offset,0px))}
      .fm-advanced-apps-overlay.closing{pointer-events:none;animation:fmAdvancedAppsDismiss .2s ease both}
      .fm-advanced-apps-panel{position:relative;width:100%;height:100%;min-height:0;display:block;overflow:visible;border:0;border-radius:0;background:transparent;box-shadow:none;animation:fmAdvancedAppsPanelIn .32s cubic-bezier(.16,1,.3,1) both}
      .fm-advanced-apps-close{position:absolute;z-index:3;top:calc(-1 * clamp(10px,1.5vw,24px));right:calc(-1 * clamp(10px,1.5vw,24px));width:40px;height:40px;border:1px solid rgba(255,255,255,.18);border-radius:50%;background:rgba(255,255,255,.08);color:rgba(255,255,255,.82);cursor:pointer;transition:transform .18s ease,background .18s ease,color .18s ease}.fm-advanced-apps-close:hover,.fm-advanced-apps-close:focus-visible{background:rgba(255,255,255,.18);color:#fff;transform:rotate(5deg) scale(1.06);outline:none}
      .fm-advanced-apps-scroll{width:100%;height:100%;min-height:0;overflow:hidden;padding:0;box-sizing:border-box}.fm-advanced-apps-grid{width:100%;height:100%;display:grid;grid-template-columns:repeat(var(--fm-advanced-columns,1),var(--fm-advanced-tile-size,120px));grid-auto-rows:var(--fm-advanced-tile-size,120px);gap:var(--fm-advanced-grid-gap,60px);justify-content:center;align-content:center;padding:var(--fm-advanced-tile-size,120px);box-sizing:border-box}.fm-advanced-app-tile{position:relative;width:var(--fm-advanced-tile-size,120px);height:var(--fm-advanced-tile-size,120px);min-width:0;overflow:hidden;border:1px solid #dfe3e8;border-radius:var(--fm-advanced-tile-radius,16px);background:#f2f4f7;box-shadow:0 9px 22px rgba(0,0,0,.14);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--fm-advanced-tile-gap,3px);padding:var(--fm-advanced-tile-padding,7px);box-sizing:border-box;transition:transform .24s cubic-bezier(.2,.8,.2,1),background .2s ease,border-color .2s ease,box-shadow .2s ease}.fm-advanced-app-tile:hover,.fm-advanced-app-tile:focus-within{z-index:1;border-color:#fff;background:#fff;box-shadow:0 14px 29px rgba(0,0,0,.24);transform:translateY(-4px)}.fm-advanced-app-icon-wrap{display:grid;place-items:center;width:var(--fm-advanced-icon-size,65px);height:var(--fm-advanced-icon-size,65px);flex:0 0 auto}.fm-advanced-app-icon-button{width:100%;height:100%;padding:0;border:0;border-radius:var(--fm-advanced-icon-radius,12px);background:transparent;color:inherit;font:inherit;cursor:pointer}.fm-advanced-app-icon-button:focus-visible{outline:2px solid rgba(53,56,205,.42);outline-offset:2px}.fm-advanced-app-open{max-width:92%;min-width:0;min-height:1.4em;display:grid;place-items:center;padding:1px 3px;border:0;border-radius:7px;background:transparent;color:#344054;font:inherit;cursor:pointer;transition:color .18s ease}.fm-advanced-app-open:hover{color:#101828}.fm-advanced-app-open:focus-visible{outline:2px solid rgba(53,56,205,.42);outline-offset:1px}.fm-advanced-app-icon{width:100%;height:100%;display:grid;place-items:center;border-radius:inherit;background:transparent;color:#344054;font-size:var(--fm-advanced-icon-font,30px);line-height:1;transition:transform .26s cubic-bezier(.2,.9,.2,1),color .2s ease}.fm-advanced-app-tile:hover .fm-advanced-app-icon,.fm-advanced-app-tile:focus-within .fm-advanced-app-icon{color:#101828;transform:scale(1.06) rotate(-2deg)}.fm-advanced-app-open strong{max-width:100%;white-space:normal;overflow-wrap:anywhere;text-align:center;font-size:var(--fm-advanced-label-size,10px);line-height:1.15;font-weight:900;text-shadow:none}
      .fm-advanced-app-pin{position:absolute;z-index:4;top:var(--fm-advanced-control-inset,7px);left:var(--fm-advanced-control-inset,7px);display:grid;place-items:center;width:var(--fm-advanced-control-size,24px);height:var(--fm-advanced-control-size,24px);margin:0;padding:0;border:0;border-radius:var(--fm-advanced-control-radius,7px);background:transparent;color:#667085;font-size:var(--fm-advanced-control-font,10px);visibility:hidden;opacity:0;pointer-events:none;cursor:pointer;transform:translateY(3px) rotate(-8deg) scale(.88);box-shadow:none;transition:visibility 0s linear .12s,opacity .12s ease,transform .18s cubic-bezier(.2,.9,.2,1),background .16s ease,color .16s ease}.fm-advanced-app-pin.is-pinned{visibility:visible;opacity:1;pointer-events:auto;background:#344054;color:#fff;box-shadow:0 4px 10px rgba(15,23,42,.22);transform:rotate(-12deg);transition-delay:0s}.fm-advanced-app-tile.is-unpinned:hover>.fm-advanced-app-pin,.fm-advanced-app-tile.is-unpinned:focus-within>.fm-advanced-app-pin{visibility:visible;opacity:1;pointer-events:auto;background:transparent;color:#667085;box-shadow:none;transform:rotate(-12deg) scale(1);transition-delay:0s}.fm-advanced-app-pin:not(.is-pinned):hover,.fm-advanced-app-pin:not(.is-pinned):focus-visible{background:transparent;color:#475467;outline:none;transform:rotate(-12deg) scale(1.1)!important}.fm-advanced-app-pin.is-pinned:hover,.fm-advanced-app-pin.is-pinned:focus-visible{background:var(--primary-readable,var(--primary,#d93025));color:#fff;outline:none;transform:rotate(-12deg) scale(1.1)!important}.fm-advanced-app-pin:disabled{opacity:.45;cursor:wait}
      .fm-advanced-app-status-pills{position:absolute;z-index:4;top:var(--fm-advanced-control-inset,7px);right:var(--fm-advanced-control-inset,7px);max-width:58%;display:flex;justify-content:flex-end;gap:4px;pointer-events:none}.fm-advanced-app-status-pill{display:inline-flex;align-items:center;min-height:var(--fm-advanced-pill-height,18px);padding:0 var(--fm-advanced-pill-padding,7px);border-radius:999px;background:#667085;color:#fff;font-size:var(--fm-advanced-pill-font,8px);font-weight:950;line-height:1;white-space:nowrap;box-shadow:0 3px 9px rgba(15,23,42,.18)}.fm-advanced-app-status-pill.is-info{background:#175cd3}.fm-advanced-app-status-pill.is-success{background:#067647}.fm-advanced-app-status-pill.is-warning{background:#b54708}.fm-advanced-app-status-pill.is-danger{background:#b42318}
      .fm-advanced-apps-panel>footer{position:absolute;z-index:3;right:calc(-1 * clamp(10px,1.5vw,24px));bottom:calc(-1 * clamp(10px,1.5vw,24px));display:block;padding:0}.fm-advanced-apps-panel>footer button{border:1px solid rgba(255,255,255,.14);border-radius:10px;background:rgba(255,255,255,.07);padding:9px 13px;color:rgba(255,255,255,.72);font:inherit;font-size:10px;font-weight:900;cursor:pointer;transition:background .16s ease,color .16s ease,transform .16s ease}.fm-advanced-apps-panel>footer button:hover,.fm-advanced-apps-panel>footer button:focus-visible{background:rgba(255,255,255,.15);color:#fff;transform:translateY(-1px);outline:none}
      @media(max-width:820px){.fm-advanced-apps-overlay{inset:0;padding:20px;z-index:2147483100}.fm-advanced-apps-panel{width:100%;height:100%;min-height:0}.fm-advanced-apps-close{top:-10px;right:-10px}.fm-advanced-apps-scroll{padding:2px}.fm-advanced-apps-panel>footer{right:-8px;bottom:-12px}}
      @media(prefers-reduced-motion:reduce){.fm-advanced-apps-overlay,.fm-advanced-apps-panel,.sidebar-advanced-apps-open .fm-sidebar-app-pin{animation:none}.fm-advanced-app-tile,.fm-advanced-app-icon,.fm-advanced-app-pin{transition:none}}
      @keyframes fmMoreAppsOpen{from{opacity:0;transform:translateY(10px) scale(.92)}to{opacity:1;transform:translateY(0) scale(1)}}
      @keyframes fmMoreAppsClose{from{opacity:1;transform:translateY(0) scale(1)}to{opacity:0;transform:translateY(8px) scale(.94)}}
      .sidebar:has(.fm-more-apps-popover:not([hidden])),.sidebar-scroll:has(.fm-more-apps-popover:not([hidden])){overflow:visible}
      .fm-more-apps-popover{position:absolute;z-index:2600;left:0;bottom:calc(100% + 8px);width:340px;border:1px solid #dfe3e8;border-radius:14px;background:#fff;box-shadow:0 16px 38px rgba(15,23,42,.18);padding:15px;transform-origin:75% 100%}
      .fm-more-apps-popover:not([hidden]){animation:fmMoreAppsOpen .2s cubic-bezier(.2,.8,.2,1)}
      .fm-more-apps-popover.closing{animation:fmMoreAppsClose .18s cubic-bezier(.4,0,1,1) forwards}
      .fm-more-apps-popover[hidden]{display:none}
      .fm-nine-dot-icon{display:inline-block;width:15px;height:15px;background-image:radial-gradient(circle,currentColor 1.5px,transparent 1.7px);background-size:5px 5px;background-position:0 0}
      .fm-more-apps-head{display:flex;align-items:center;gap:8px;padding:0 0 10px 3px}.fm-more-apps-title{display:block;flex:1;color:#344054;font-size:13px;font-weight:1000}.fm-more-apps-head button{width:30px;height:30px;border:0;border-radius:50%;background:transparent;color:#667085;cursor:pointer}.fm-more-apps-head button:hover{background:#f1f3f5}
      .fm-more-apps-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:420px;overflow-y:auto}
      .fm-more-app{min-width:0;border:0;border-radius:10px;background:transparent;color:#344054;display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 8px;font:inherit;font-size:11px;font-weight:850;cursor:pointer;text-align:center}
      .fm-more-app:hover,.fm-more-app:focus-visible{background:#f5f6f8;color:var(--primary-readable,var(--primary,#d93025));outline:none}
      .fm-more-app-icon{width:52px;height:52px;border-radius:13px;background:#f1f3f5;display:grid;place-items:center;font-size:22px;color:#667085}
      .fm-more-app-name{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fm-more-app-desc{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:#98a2b3;font-size:9px;font-weight:750;line-height:1.35}
      .fm-more-apps-empty{padding:14px 6px;color:#667085;font-size:11px;font-weight:800;text-align:center}
      .fm-more-apps-foot{display:block;margin-top:10px;padding-top:10px;border-top:1px solid #eef0f3}
      .fm-more-apps-foot button{width:100%;border:0;border-radius:9px;background:transparent;padding:8px 6px;color:#475467;font:inherit;font-size:11px;font-weight:900;cursor:pointer;text-align:center}
      .fm-more-apps-foot button:hover,.fm-more-apps-foot button:focus-visible{background:#f5f6f8;color:var(--primary-readable,var(--primary,#d93025));outline:none}
      @media(prefers-reduced-motion:reduce){.fm-more-apps-popover:not([hidden]),.fm-more-apps-popover.closing{animation:none}}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #sidebarBottomLinks.sidebar-launchers-split{grid-template-columns:1fr;grid-template-rows:auto 1px auto;gap:4px}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #sidebarBottomLinks.sidebar-launchers-integrated{flex-direction:column;gap:4px;padding-bottom:15px}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) #sidebarBottomLinks.sidebar-launchers-integrated>.sidebar-launcher-icon{flex:none;width:28px}
      .sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .sidebar-launcher-divider{justify-self:center;width:22px;height:1px;flex-basis:1px}
      @media(max-width:820px){.sidebar.sidebar-compact:not(:hover):not(.sidebar-compact-edge-held):not(.sidebar-compact-expanded):not(.sidebar-advanced-apps-open) .fm-more-apps-popover{right:auto;left:42px;bottom:0;width:min(340px,calc(100vw - 56px));transform-origin:0 100%}}
      @media(min-width:821px){
        .fm-more-apps-popover{position:fixed;left:var(--fm-more-apps-left,16px);right:auto;bottom:var(--fm-more-apps-bottom,70px);width:var(--fm-more-apps-width,min(960px,calc(100vw - 32px)));height:var(--fm-more-apps-height,640px);max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);box-sizing:border-box;flex-direction:column;padding:clamp(16px,1.5vw,24px);border-radius:20px;transform-origin:var(--fm-more-apps-caret-left,32px) 100%}
        .fm-more-apps-popover:not([hidden]){display:flex}
        .fm-more-apps-popover:before,.fm-more-apps-popover:after{position:absolute;left:clamp(18px,var(--fm-more-apps-caret-left,32px),calc(100% - 18px));width:0;height:0;content:"";pointer-events:none;transform:translateX(-50%)}
        .fm-more-apps-popover:before{bottom:-10px;border-left:10px solid transparent;border-right:10px solid transparent;border-top:10px solid #dfe3e8}.fm-more-apps-popover:after{bottom:-8px;border-left:9px solid transparent;border-right:9px solid transparent;border-top:9px solid #fff}
        .fm-more-apps-head{padding:0 0 14px 2px}.fm-more-apps-title{font-size:16px}.fm-more-apps-grid{flex:1;grid-template-columns:repeat(var(--fm-more-app-columns,7),minmax(0,1fr));grid-auto-rows:minmax(116px,1fr);gap:10px;max-height:none;min-height:0;overflow-y:auto;padding:1px 2px 4px}.fm-more-app{min-height:116px;padding:6px 8px}.fm-more-apps-foot{display:flex;justify-content:flex-end;margin-top:12px;padding-top:12px}.fm-more-apps-foot button{width:auto;padding:9px 14px}
      }
      .fm-link{
        position:relative;
        display:flex;
        align-items:center;
        gap: 10px;
        cursor:pointer;
        user-select:none;
        color: #333;
        font-weight: 950;
        font-size: 13px;
        padding: 6px 2px;
        line-height: 1.1;
        border-radius: 10px;
        transition: .14s ease;
      }
      .fm-link .ic{
        width: 18px;
        text-align:center;
        color:#6b7280;
        font-size: 14px;
        flex-shrink:0;
      }
      .fm-link:hover{ color: var(--primary-readable, var(--primary, #d93025)); }
      .fm-link:hover .ic{ color: var(--primary-readable, var(--primary, #d93025)); }
      .fm-link.active{ color: var(--primary-readable, var(--primary, #d93025)); }
      .fm-link.active .ic{ color: var(--primary-readable, var(--primary, #d93025)); }
      #sidebarBottomLinks>.fm-link.active,#sidebarBottomLinks>.fm-link.active .ic{color:#333}
      .fm-link.bottom{ padding-top:12px; }
      .fm-tabpanel{display:none;min-height:100%}
      .fm-tabpanel.active{display:block;height:100%}
      .main-panels:has(>.fm-tabpanel.active.full-bleed){padding:0;overflow:hidden}
      .fm-tabpanel.full-bleed{height:100%;min-height:0;overflow:hidden}
    `);

    links.innerHTML = '';
    const mainLinks = document.createElement('div');
    mainLinks.id = 'sidebarMainLinks';
    const bottomLinks = document.getElementById('sidebarBottomLinks');
    links.append(mainLinks);
    const wantedPanelIds = new Set(list.map((t) => `tab_${t.id}`));
    panels.querySelectorAll('.fm-tabpanel').forEach((panel) => {
      if (!wantedPanelIds.has(panel.id)) {
        const oldId = String(panel.id || '').replace(/^tab_/, '');
        TabRegistry.mounted.delete(oldId);
        panel.remove();
      }
    });

    for (const t of list){
      const title = terminologyLabel(t.terminologyKey, t.title);
      const item = document.createElement('div');
      item.className = 'fm-link';
      item.dataset.tab = t.id;
      item.innerHTML = `
        ${advancedAppMenuEnabled() && t.placement === 'sidebar' ? `<button type="button" class="fm-sidebar-app-pin is-pinned" data-sidebar-app-pin="${String(escapeHtml(t.appId))}" aria-label="${((v1) => globalThis.PlatformLanguage?.text("platform","m_db4217ef113961",`Unpin ${v1} from the sidebar`,{v1}) ?? `Unpin ${v1} from the sidebar`)(escapeHtml(title))}" title="${(globalThis.PlatformLanguage?.text("platform","m_faf31575fe991d","Unpin from sidebar") ?? "Unpin from sidebar")}"><i class="fas fa-thumbtack" aria-hidden="true"></i></button>` : ''}
        <div class="ic"><i class="fas ${escapeHtml(t.icon)}"></i></div>
        <div class="tx">${escapeHtml(title)}</div>
      `;
      item.addEventListener('click', ()=>activateTab(t.id, false, { history:'push', source:'portal-tab' }));
      item.querySelector('[data-sidebar-app-pin]')?.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await updateAdvancedAppPin(button.dataset.sidebarAppPin, false);
          window.PlatformUI?.showToast?.(((v0) => globalThis.PlatformLanguage?.text("platform","m_48dd38adcaba37",`${v0} removed from the sidebar.`,{v0}) ?? `${v0} removed from the sidebar.`)(title));
        } catch (error) {
          button.disabled = false;
          window.PlatformUI?.showToast?.(error?.message || 'Could not update the sidebar.');
        }
      });
      if (t.placement === 'sidebar') mainLinks.appendChild(item);

      let panel = document.getElementById(`tab_${t.id}`);
      if (!panel) {
        panel = document.createElement('div');
        panel.className = 'fm-tabpanel';
        panel.id = `tab_${t.id}`;
      }
      panel.classList.toggle('full-bleed', !!t.fullBleed);
      panels.appendChild(panel);
    }
    renderSidebarLaunchers(bottomLinks, list);
    initSidebarAppScrolling();

    let routeTab = currentRoute.tab && availableIds.has(currentRoute.tab) ? currentRoute.tab : '';
    if (!routeTab && currentRoute.tab && TabRegistry.routesReady) {
      const fallbackTab = (TabRegistry.activeId && availableIds.has(TabRegistry.activeId))
        ? TabRegistry.activeId
        : defaultPortalTab(list);
      if (fallbackTab) {
        currentRoute = setRouteState({ tab:fallbackTab }, { history:'replace', source:'unavailable-tab-fallback', ownedKeys:['tab'] });
        routeTab = fallbackTab;
      }
    }
    // App bundles register incrementally. With no explicit route, do not let an
    // early registration (commonly Settings) become durable URL state before
    // the complete accessible sidebar order is known.
    if (!currentRoute.tab && !TabRegistry.routesReady) {
      TabRegistry.activeId = null;
      updateMobileTabTitle(null);
      return;
    }
    // Apps such as Scheduling register after their feature flags load.  Do not
    // replace a requested portal tab with the default tab while that happens.
    const hasUnresolvedRouteTab = !!(currentRoute.tab && !routeTab);
    if (routeTab && TabRegistry.activeId !== routeTab) {
      TabRegistry.activeId = routeTab;
    }
    if (!routeTab && !currentRoute.tab && TabRegistry.routesReady) {
      TabRegistry.activeId = defaultPortalTab(list);
      TabRegistry.preferDefaultHome = false;
    }
    if (!TabRegistry.activeId || !availableIds.has(TabRegistry.activeId)){
      TabRegistry.activeId = routeTab || defaultPortalTab(list);
    }
    if (TabRegistry.activeId) {
      const alreadyMounted = TabRegistry.mounted.has(TabRegistry.activeId);
      activateTab(TabRegistry.activeId, true, { skipOnShow: alreadyMounted, skipRoute: hasUnresolvedRouteTab });
    } else {
      updateMobileTabTitle(null);
    }
  }

  function ensurePortalTabLoadingStyles(){
    injectCSS('portal_tab_loading', `
      .fm-tab-loading{width:100%;height:100%;min-height:220px;display:grid;place-content:center;justify-items:center;gap:10px;background:#fff;color:#475467;text-align:center;box-sizing:border-box}
      .fm-tab-loading.is-overlay{position:absolute;inset:0;z-index:3;min-height:0}
      .fm-tab-loading-spinner{font-size:24px;color:var(--primary-readable,var(--primary,#d93025))}
      .fm-tab-loading-title{font-size:14px;font-weight:1000;color:#101828}
      .fm-tab-loading-detail{font-size:12px;font-weight:750;color:#667085}
    `);
  }

  function portalTabLoadingMarkup(options = {}){
    ensurePortalTabLoadingStyles();
    const title = String(options.title || (globalThis.PlatformLanguage?.text("platform","m_d2da77452877dd","Loading…") ?? "Loading…"));
    const detail = String(options.detail || 'Opening this app.');
    const dataName = String(options.dataName || '').trim().toLowerCase();
    const titleDataName = String(options.titleDataName || '').trim().toLowerCase();
    const dataAttribute = /^[a-z0-9-]+$/.test(dataName) ? ` data-${dataName}` : '';
    const titleDataAttribute = /^[a-z0-9-]+$/.test(titleDataName) ? ` data-${titleDataName}` : '';
    return `<div class="fm-tab-loading ${options.overlay ? 'is-overlay' : ''}" role="status" aria-live="polite"${dataAttribute}><i class="fas fa-circle-notch fa-spin fm-tab-loading-spinner" aria-hidden="true"></i><strong class="fm-tab-loading-title"${titleDataAttribute}>${escapeHtml(title)}</strong><span class="fm-tab-loading-detail">${escapeHtml(detail)}</span></div>`;
  }

  function showPortalTabLoading(panel, options = {}){
    if (!panel) return;
    panel.innerHTML = portalTabLoadingMarkup(options);
  }

  function activateTab(id, isInitial=false, options = {}){
    if (!TabRegistry.tabs.has(id)) return;
    if (TabRegistry.tabs.get(id)?.placement === 'hidden') return;
    if (TabRegistry.tabs.get(id)?.placement === 'settings' && id !== 'company_settings') return;

    const prevId = TabRegistry.activeId;
    if (prevId && prevId !== id){
      const prev = TabRegistry.tabs.get(prevId);
      prev?.onHide && prev.onHide();
      try { TabRegistry.handles.get(prevId)?.setActive?.(false); }
      catch (error) { console.warn(`Embeddable portal tab deactivation failed: ${prevId}`, error); }
    }

    TabRegistry.activeId = id;

    document.querySelectorAll('.fm-link').forEach(el=>{
      el.classList.toggle('active', el.dataset.tab === id);
    });

    document.querySelectorAll('.fm-tabpanel').forEach(p=>{
      p.classList.toggle('active', p.id === `tab_${id}`);
    });

    const t = TabRegistry.tabs.get(id);
    updateMobileTabTitle(t);
    if (t.css) injectCSS(`tab_${id}`, t.css);

    const panelEl = document.getElementById(`tab_${id}`);
    if (panelEl && !TabRegistry.mounted.has(id)){
      TabRegistry.mounted.add(id);
      showPortalTabLoading(panelEl, { title:((v0) => globalThis.PlatformLanguage?.text("platform","m_be9d536e280edc",`Loading ${v0}…`,{v0}) ?? `Loading ${v0}…`)(terminologyLabel(t.terminologyKey, t.title)), detail:'Opening your workspace.' });
      if (window.FirstMateEmbeddableApps?.mount && t.appId) {
        window.FirstMateEmbeddableApps.mount(panelEl, t.appId, {
          surface: 'portal_tab',
          source: `portal_tab_${id}`,
          chrome: 'tab',
          appId: t.appId,
          params: t.params || {},
          layout: t.layout || {},
          presentation: t.presentation || {},
          entitlement: t.entitlement,
          defaultHome: t.defaultHome === true,
          currentUser: window.Portal.currentUser,
          host: window.FirstMateEmbeddableApps.createHostBridge?.({
            surface: 'portal_tab',
            onSetActiveApp: (appId) => {
              const tab = [...TabRegistry.tabs.values()].find((entry) => entry.appId === appId || entry.id === appId);
              if (tab) activateTab(tab.id);
            },
            onSetRoute: (patch, routeOptions = {}) => setRouteState(patch, routeOptions),
            showToast
          })
        }).then((handle) => {
          TabRegistry.handles.set(id, handle);
        }).catch((error) => {
          console.warn(`Embeddable portal tab mount failed: ${id}`, error);
          if (t.mount) t.mount(panelEl);
        });
      } else if (t.mount) t.mount(panelEl);
    } else if (panelEl && TabRegistry.mounted.has(id)) {
      const handle = TabRegistry.handles.get(id);
      try {
        handle?.update?.({
          active: true,
          params: t.params || {},
          layout: t.layout || {},
          presentation: t.presentation || {},
          entitlement: t.entitlement,
          defaultHome: t.defaultHome === true,
          currentUser: window.Portal.currentUser
        });
        handle?.setActive?.(true);
      } catch (error) {
        console.warn(`Embeddable portal tab update failed: ${id}`, error);
      }
    }

    if (!options.skipRoute) setRouteState({ tab: id }, {
      history: options.history || (isInitial ? 'replace' : 'push'),
      source: options.source || (isInitial ? 'portal-initial' : 'portal-tab'),
      ownedKeys: ['tab']
    });
    if (!options.skipOnShow) t?.onShow && t.onShow(isInitial);
    // Overlays riding on top of the viewport (e.g. the channels conversation
    // pop-over) listen for this: choosing an app must bring that app forward.
    window.dispatchEvent(new CustomEvent('fm:portal-tab:activated', {
      detail: { id, isInitial, source: options.source || (isInitial ? 'portal-initial' : 'portal-tab') }
    }));
  }

  // Credits helper
  let lastCredits = null;
  let creditsRefreshPromise = null;
  let appFlagsPromise = null;
  let lastAppFlagsKey = '';
  async function loadAppFlags(options = {}){
    if (!APP.userOrgId || !window.PlatformAPI?.appFlags?.load) return null;
    if (appFlagsPromise && !options.refresh) return appFlagsPromise;
    appFlagsPromise = window.PlatformAPI.appFlags.load(APP.userOrgId, options)
      .then((flags) => {
        const key = stableJson(flags || {});
        if (options.refresh || key !== lastAppFlagsKey) {
          lastAppFlagsKey = key;
          window.dispatchEvent(new CustomEvent('fm:app-flags:updated', { detail: flags || {} }));
        }
        return flags;
      })
      .catch((error) => {
        window.dispatchEvent(new CustomEvent('fm:app-flags:failed', { detail: { error } }));
        return null;
      })
      .finally(() => { appFlagsPromise = null; });
    return appFlagsPromise;
  }
  let capabilitiesPromise = null;
  async function loadCapabilities(options = {}){
    if (!APP.userOrgId || !window.PlatformAPI?.capabilities?.load) return null;
    if (capabilitiesPromise && !options.refresh) return capabilitiesPromise;
    capabilitiesPromise = window.PlatformAPI.capabilities.load(APP.userOrgId, options)
      .then((state) => {
        window.dispatchEvent(new CustomEvent('fm:capabilities:updated', { detail: state || {} }));
        return state;
      })
      .catch((error) => {
        window.dispatchEvent(new CustomEvent('fm:capabilities:failed', { detail: { error } }));
        return null;
      })
      .finally(() => { capabilitiesPromise = null; });
    return capabilitiesPromise;
  }
  async function refreshCredits(){
    if (creditsRefreshPromise) return creditsRefreshPromise;

    creditsRefreshPromise = (async ()=>{
      let data = null;
      const orgId = String(APP.userOrgId || '').trim();
      if (orgId && window.PlatformAPI?.credits?.get) {
        const [directCredits, session] = await Promise.all([
          window.PlatformAPI.credits.get(orgId).catch(() => null),
          window.PlatformAPI.auth?.me ? window.PlatformAPI.auth.me().catch(() => null) : Promise.resolve(null)
        ]);
        const creditsMissing = directCredits?.missing === true;
        const hasDirectBalance = directCredits
          && directCredits.ok !== false
          && !creditsMissing
          && (
            directCredits.balance !== undefined
            || directCredits.credits_balance !== undefined
            || directCredits.organization?.credits_balance !== undefined
          );
        if (hasDirectBalance) {
          data = {
            success: true,
            commerce: directCredits.commerce,
            credits_balance: directCredits.balance ?? directCredits.credits_balance ?? directCredits.organization?.credits_balance ?? 0,
            free_expedite_uses: directCredits.free_expedite_uses ?? directCredits.organization?.free_expedite_uses ?? 0,
            permissions: session?.membership?.permissions || session?.membership?.org_permissions?.items || session?.user?.permissions || session?.user?.org_permissions?.items || null,
            referral_discount: null
          };
          if (!data.permissions) data.permissions = frontendFallbackPermissions();
        } else {
          const portalActionCredits = await postAction('get_credits').catch(() => null);
          data = portalActionCredits?.data || null;
        }
      } else {
        const portalActionCredits = await postAction('get_credits').catch(() => null);
        data = portalActionCredits?.data || null;
      }
      if (!data || !data.success) {
        const permissions = frontendFallbackPermissions();
        if (!Object.keys(permissions).length) return { ok:false };
        setCurrentPermissions(permissions);
        return { ok:false, balance: lastCredits };
      }

      if (data.commerce) window.PlatformCommerce.set({...window.PlatformCommerce.current(), ...data.commerce});
      const bal = moneyAmount(data.credits_balance ?? 0);
      lastCredits = bal;
      window.Portal.freeExpediteUses = Math.max(0, parseInt(String(data.free_expedite_uses ?? 0), 10) || 0);

      // Capture permissions from server
      if (data.permissions && typeof data.permissions === 'object') setCurrentPermissions(data.permissions);
      window.Portal.referralDiscount = data.referral_discount || null;

      document.querySelectorAll('.credits-val-target').forEach(el => el.textContent = window.PlatformCommerce.credit(bal));
      document.querySelectorAll('#creditsSub,.credits-sub-target').forEach((sub) => {
        sub.textContent = '';
        sub.style.display = 'none';
      });

      return { ok:true, balance: bal };
    })();

    try{
      return await creditsRefreshPromise;
    }finally{
      creditsRefreshPromise = null;
    }
  }

  function routeState(){
    if (window.Portal?.navigation?.read) return window.Portal.navigation.read();
    const params = new URLSearchParams(window.location.search || '');
    let tab = cleanText(params.get('tab'));
    // Scheduling used the dashboard tab ID before it was given its own portal tab.
    // Keep existing bookmarked URLs working and rewrite them on the next route update.
    if (tab === 'dashboard') tab = 'scheduling';
    return {
      tab,
      projectTab: cleanText(params.get('projectTab')),
      project: cleanText(params.get('project')),
      photo: cleanText(params.get('photo')),
      photoScope: cleanText(params.get('photoScope')),
      projectFullscreen: cleanText(params.get('projectFullscreen'))
    };
  }

  function setRouteState(patch = {}, options = {}){
    if (window.Portal?.navigation?.write) return window.Portal.navigation.write(patch, {
      ...options,
      history: options.history || (options.push ? 'push' : 'replace')
    });
    const url = new URL(window.location.href);
    Object.entries(patch || {}).forEach(([key, value]) => {
      const text = cleanText(value);
      if (text) url.searchParams.set(key, text);
      else url.searchParams.delete(key);
    });
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return routeState();
    const method = options.push || options.history === 'push' ? 'pushState' : 'replaceState';
    try { window.history?.[method]?.({ ...(window.history.state || {}), fmRoute: true }, '', next); } catch(e) {}
    const state = routeState();
    window.dispatchEvent(new CustomEvent('fm:route-state:updated', { detail: state }));
    return state;
  }

  function clearRouteState(keys = []){
    const patch = {};
    (Array.isArray(keys) ? keys : [keys]).forEach((key) => { if (key) patch[key] = null; });
    return setRouteState(patch, { history:'replace', source:'route-clear' });
  }

  function createModalManager(){
    const stack = [];
    let serial = 0;
    const baseZ = 2147483200;
    const step = 20;

    const normalizeEl = (target) => {
      if (!target) return null;
      if (target instanceof Element) return target;
      if (typeof target === 'string') return document.getElementById(target) || document.querySelector(target);
      if (target.el instanceof Element) return target.el;
      return null;
    };

    const findEntry = (target) => {
      const el = normalizeEl(target);
      if (el) return stack.find((entry) => entry.el === el) || null;
      const id = String(target || '');
      return stack.find((entry) => entry.id === id) || null;
    };

    const refresh = () => {
      stack.forEach((entry, index) => {
        const z = baseZ + (index * step);
        entry.el.style.setProperty('--fm-modal-z', String(z));
        entry.el.style.zIndex = String(z);
        entry.el.dataset.fmModalIndex = String(index);
        entry.el.dataset.fmModalTop = index === stack.length - 1 ? 'true' : 'false';
      });
    };

    const unregister = (target) => {
      const entry = findEntry(target);
      if (!entry) return false;
      entry.cleanup.forEach((fn) => {
        try { fn(); } catch(e) {}
      });
      const idx = stack.indexOf(entry);
      if (idx >= 0) stack.splice(idx, 1);
      entry.el.removeAttribute('data-fm-modal-id');
      entry.el.removeAttribute('data-fm-modal-index');
      entry.el.removeAttribute('data-fm-modal-top');
      entry.el.style.removeProperty('--fm-modal-z');
      refresh();
      window.dispatchEvent(new CustomEvent('fm:modal-stack:changed', { detail: { stack: snapshot() } }));
      return true;
    };

    const closeEntry = (entry, reason = 'programmatic') => {
      if (!entry || entry.closing) return false;
      if (entry.closePredicate && entry.closePredicate(reason) === false) return false;
      entry.closing = true;
      try {
        const route = entry.options?.route;
        if (route && reason !== 'route' && !window.Portal?.navigation?.applying) {
          const key = String(route.key || 'modal');
          window.Portal?.navigation?.backOrClose?.([key], route.clear || { [key]:null }, { source:`modal-close:${entry.id}` });
        }
        if (typeof entry.onClose === 'function') entry.onClose(reason, entry);
        else entry.el.remove();
      } finally {
        unregister(entry.el);
        entry.closing = false;
      }
      return true;
    };

    const top = () => stack[stack.length - 1] || null;
    const isTop = (target) => {
      const entry = findEntry(target);
      return !!entry && top() === entry;
    };
    const bringToFront = (target) => {
      const entry = findEntry(target);
      if (!entry) return null;
      const idx = stack.indexOf(entry);
      if (idx >= 0) stack.splice(idx, 1);
      stack.push(entry);
      const options = entry.options || {};
      if (options.route && !window.Portal?.navigation?.applying && options.fromRoute !== true) {
        const key = String(options.route.key || 'modal');
        const value = String(options.route.value || entry.id);
        window.Portal?.navigation?.push?.({ ...(options.route.patch || {}), [key]:value }, {
          source:`modal-open:${entry.id}`,
          ownedKeys:options.route.ownedKeys || [key]
        });
      }
      refresh();
      window.dispatchEvent(new CustomEvent('fm:modal-stack:changed', { detail: { stack: snapshot() } }));
      return entry.handle;
    };
    const snapshot = () => stack.map((entry, index) => ({ id: entry.id, index, zIndex: entry.el.style.zIndex, top: index === stack.length - 1 }));

    const register = (el, options = {}) => {
      const node = normalizeEl(el);
      if (!node) return null;
      const existing = findEntry(node);
      if (existing) {
        existing.options = { ...existing.options, ...options };
        existing.onClose = options.onClose ?? existing.onClose;
        existing.closePredicate = options.closePredicate ?? existing.closePredicate;
        return bringToFront(node);
      }
      const entry = {
        id: String(options.id || node.id || `modal-${++serial}`),
        el: node,
        options: { ...options },
        onClose: options.onClose,
        closePredicate: options.closePredicate,
        cleanup: [],
        closing: false,
        handle: null
      };
      const handle = {
        id: entry.id,
        el: node,
        close: (reason = 'programmatic') => closeEntry(entry, reason),
        unregister: () => unregister(node),
        bringToFront: () => bringToFront(node),
        isTop: () => isTop(node)
      };
      entry.handle = handle;
      node.dataset.fmModalId = entry.id;
      const onFocusDown = () => bringToFront(node);
      node.addEventListener('mousedown', onFocusDown, true);
      entry.cleanup.push(() => node.removeEventListener('mousedown', onFocusDown, true));
      if (options.closeOnBackdrop) {
        let downOnBackdrop = false;
        const onDown = (event) => {
          downOnBackdrop = event.target === node;
        };
        const onUp = (event) => {
          const shouldClose = downOnBackdrop && event.target === node && isTop(node);
          downOnBackdrop = false;
          if (shouldClose) closeEntry(entry, 'backdrop');
        };
        node.addEventListener('mousedown', onDown);
        node.addEventListener('mouseup', onUp);
        entry.cleanup.push(() => node.removeEventListener('mousedown', onDown));
        entry.cleanup.push(() => node.removeEventListener('mouseup', onUp));
      }
      stack.push(entry);
      refresh();
      window.dispatchEvent(new CustomEvent('fm:modal-stack:changed', { detail: { stack: snapshot() } }));
      return handle;
    };

    const closeTop = (reason = 'escape') => {
      const entry = top();
      if (!entry) return false;
      if (entry.options.closeOnEscape === false && reason === 'escape') return false;
      return closeEntry(entry, reason);
    };

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (closeTop('escape')) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
      }
    }, true);

    const applyRoute = (route = {}) => {
      [...stack].reverse().forEach((entry) => {
        const config = entry.options?.route;
        if (!config) return;
        const key = String(config.key || 'modal');
        const value = String(config.value || entry.id);
        if (String(route[key] || '') !== value) closeEntry(entry, 'route');
      });
    };

    return { register, unregister, bringToFront, top, isTop, closeTop, snapshot, applyRoute };
  }

  function projectRouteId(project = {}){
    return cleanText(project?.platform_project_id, project?.base_project_id, project?.id);
  }

  function mediaRouteId(media = {}){
    return cleanText(media?.media_id, media?.mediaId, media?.photo_id, media?.id, media?.src, media?.url, media?.thumb);
  }

  function projectFromDocument(document){
    const data = document?.data && typeof document.data === 'object' ? document.data : null;
    if (!data) return null;
    const documentId = cleanText(document.id);
    const platformId = cleanText(data.platform_project_id, data.base_project_id, documentId);
    const projectTitle = firstProjectDisplayText(data.title, data.project_title, data.project_name, data.projectName, data.name, data.address, data.customer_name, data.customerName, data.primary_contact_name);
    return {
      ...data,
      id: platformId || cleanText(data.id, documentId),
      platform_project_id: cleanText(data.platform_project_id, platformId),
      base_project_id: cleanText(data.base_project_id, platformId),
      title: projectTitle || 'New Project',
      project_title: projectTitle || 'New Project'
    };
  }

  function projectFromCrewResponse(response){
    if (!response || typeof response !== 'object') return null;
    const nested = response.project && typeof response.project === 'object' ? response.project : {};
    const id = cleanText(nested.id, response.project_id, response.id);
    if (!id) return null;
    const customer = response.customer && typeof response.customer === 'object' ? response.customer : {};
    const projectTitle = firstProjectDisplayText(
      nested.title,
      nested.project_title,
      response.title,
      response.project_title,
      nested.address,
      response.address,
      nested.customer_name,
      response.customer_name,
      customer.name
    );
    return {
      ...response,
      ...nested,
      id,
      platform_project_id: id,
      base_project_id: id,
      title: projectTitle || 'Project',
      project_title: projectTitle || 'Project',
      address: cleanText(nested.address, response.address),
      customer_name: cleanText(nested.customer_name, response.customer_name, customer.name),
      customer_phone: cleanText(nested.customer_phone, response.customer_phone, customer.phone),
      project_notes: cleanText(nested.project_notes, nested.notes, response.project_notes, response.notes),
      contacts: Array.isArray(response.contacts) ? response.contacts : (Array.isArray(nested.contacts) ? nested.contacts : []),
      events: Array.isArray(response.assigned_events) ? response.assigned_events : (Array.isArray(nested.events) ? nested.events : [])
    };
  }

  function mergeResolvedProject(base = {}, incoming = {}){
    if (!base || base === incoming) return base || incoming;
    const merged = { ...base };
    const keepIncoming = (key) => {
      const value = incoming?.[key];
      if (value === undefined || value === null || value === '') return;
      merged[key] = value;
    };
    const keepBetterArray = (key) => {
      const baseValue = Array.isArray(base?.[key]) ? base[key] : [];
      const incomingValue = Array.isArray(incoming?.[key]) ? incoming[key] : [];
      if (incomingValue.length) merged[key] = incomingValue;
      else if (baseValue.length) merged[key] = baseValue;
      else if (Object.prototype.hasOwnProperty.call(incoming || {}, key)) merged[key] = incomingValue;
    };
    [
      'title',
      'project_title',
      'project_name',
      'projectName',
      'customer_name',
      'customerName',
      'primary_contact_name',
      'customer_email',
      'primary_contact_email',
      'customer_phone',
      'primary_contact_phone',
      'address',
      'project_type',
      'work_projection',
      'lifecycle',
      'workflow_state',
      'status'
    ].forEach(keepIncoming);
    ['contacts', 'photos', 'proposals', 'events'].forEach(keepBetterArray);
    const baseMeasurement = (base.measurement_project && typeof base.measurement_project === 'object')
      ? base.measurement_project
      : ((base.measurement && typeof base.measurement === 'object') ? base.measurement : {});
    const incomingMeasurement = (incoming.measurement_project && typeof incoming.measurement_project === 'object')
      ? incoming.measurement_project
      : ((incoming.measurement && typeof incoming.measurement === 'object') ? incoming.measurement : {});
    const measurement = { ...baseMeasurement, ...incomingMeasurement };
    if (Object.keys(measurement).length) {
      merged.measurement = measurement;
      merged.measurement_project = measurement;
    }
    merged.id = cleanText(base.id, incoming.id, merged.id);
    merged.platform_project_id = cleanText(base.platform_project_id, incoming.platform_project_id, merged.id);
    merged.base_project_id = cleanText(base.base_project_id, incoming.base_project_id, merged.id);
    return merged;
  }

  function routeProjectMediaOwnerId(item = {}){
    const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    const owner = item.owner && typeof item.owner === 'object'
      ? item.owner
      : (metadata.owner && typeof metadata.owner === 'object' ? metadata.owner : {});
    const ownerType = cleanText(owner.type, item.owner_type, item.ownerType, metadata.owner_type, metadata.ownerType).toLowerCase();
    const collection = cleanText(owner.collection, item.collection, metadata.collection).toLowerCase();
    const slot = cleanText(owner.slot, item.slot, metadata.slot).toLowerCase();
    const projectOwned = ownerType === 'project' || collection === 'projects' || (slot === 'photos' && ownerType !== 'organization');
    return projectOwned ? cleanText(owner.id, item.owner_id, item.ownerId, metadata.owner_id, metadata.ownerId) : '';
  }

  function routeProjectMediaReference(item = {}){
    const mediaId = cleanText(item.media_id, item.mediaId, item.id);
    if (!mediaId) return null;
    if (window.PlatformAPI?.media?.referenceFromUpload) {
      return window.PlatformAPI.media.referenceFromUpload(item, { field:'photos', variant:'original' });
    }
    return {
      kind:'media_reference',
      id:mediaId,
      media_id:mediaId,
      field:'photos',
      variant:'original',
      file_name:cleanText(item.file_name, item.fileName),
      content_type:cleanText(item.content_type, item.contentType),
      size_bytes:Number(item.size_bytes || item.sizeBytes || 0),
      uploaded_at:cleanText(item.created_at, item.uploaded_at, item.updated_at),
      updated_at:cleanText(item.updated_at, item.created_at),
      metadata:item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
      owner:item.owner && typeof item.owner === 'object' ? item.owner : {}
    };
  }

  function routeProjectMediaIdentity(item = {}){
    return cleanText(item.media_id, item.mediaId, item.id, item.photo_id, item.src, item.url, item.thumb);
  }

  async function hydrateRouteProjectMedia(project, projectId, orgId){
    const id = cleanText(projectId);
    const existing = Array.isArray(project?.photos) ? project.photos : [];
    if (!id || !window.PlatformAPI?.media?.list) return project;
    const result = await window.PlatformAPI.media.list(orgId).catch(() => null);
    const owned = (Array.isArray(result?.media) ? result.media : [])
      .filter((item) => routeProjectMediaOwnerId(item) === id)
      .map(routeProjectMediaReference)
      .filter(Boolean);
    if (!owned.length) return project;
    const photos = [];
    const photoIds = new Set();
    [...existing, ...owned].forEach((photo) => {
      const photoId = routeProjectMediaIdentity(photo);
      if (photoId && photoIds.has(photoId)) return;
      if (photoId) photoIds.add(photoId);
      photos.push(photo);
    });
    return {
      ...(project || {}),
      id:cleanText(project?.id, id),
      platform_project_id:cleanText(project?.platform_project_id, id),
      base_project_id:cleanText(project?.base_project_id, id),
      photos
    };
  }

  async function resolveRouteProject(projectId){
    const id = cleanText(projectId);
    if (!id) return null;
    const cached = window.Portal.ProjectStore?.get?.(id);
    const orgId = cleanText(APP.userOrgId, APP.orgId, window.__APP?.userOrgId, window.__APP?.orgId);
    if (!orgId) return null;
    const managementEnabled = window.Portal.currentUser?.applicationAccess?.management?.enabled === true;
    const direct = window.PlatformAPI?.projects?.get
      ? await window.PlatformAPI.projects.get(orgId, id).catch(() => null)
      : null;
    const directProject = projectFromDocument(direct?.document);
    if (directProject) {
      const merged = cached ? mergeResolvedProject(directProject, cached) : directProject;
      const hydrated = await hydrateRouteProjectMedia(merged, id, orgId);
      return window.Portal.ProjectStore?.cache?.(hydrated) || window.Portal.ProjectStore?.save?.(hydrated) || hydrated;
    }

    // Field-only users cannot use the management Platform project collection.
    // Re-resolve through the assignment-scoped Crew endpoint before trusting any
    // browser cache so a prior user's cached project cannot bypass authorization.
    if (!managementEnabled) {
      const crewResult = window.CrewAPI?.projects?.get
        ? await window.CrewAPI.projects.get(orgId, id).catch(() => null)
        : null;
      const crewProject = projectFromCrewResponse(crewResult);
      const hydrated = await hydrateRouteProjectMedia(crewProject, id, orgId);
      return hydrated ? (window.Portal.ProjectStore?.cache?.(hydrated) || hydrated) : null;
    }

    if (cached) {
      const hydrated = await hydrateRouteProjectMedia(cached, id, orgId);
      return window.Portal.ProjectStore?.cache?.(hydrated) || hydrated;
    }
    const result = window.PlatformAPI?.projects?.list
      ? await window.PlatformAPI.projects.list(orgId).catch(() => null)
      : null;
    const docs = Array.isArray(result?.documents) ? result.documents : [];
    const found = docs.map(projectFromDocument).find((project) => project && cleanText(project.id) === id) || null;
    const hydrated = await hydrateRouteProjectMedia(found, id, orgId);
    return hydrated ? (window.Portal.ProjectStore?.cache?.(hydrated) || window.Portal.ProjectStore?.save?.(hydrated) || hydrated) : null;
  }

  // Export
  window.Portal.cfg = APP;
  window.Portal.util = { $, escapeHtml, injectCSS, formatDate, postAction, enableSafeBackdropClose, hasPerm, fmUrl, fmJson, fmPost, platformUrl, platformJson, currentActor, googleMapsApiKey };
  window.Portal.commerce = window.PlatformCommerce;
  window.Portal.pricing = { projectTypePrice, gutterReportAddon, weatherReportAddon, instantReportAddon, orderAmount, orderAmountWithWeather, activeReferralDiscount, standardBaseAmountForOrder, referralDiscountPreview, moneyAmount, formatMoney };
  window.Portal.ui = {
    showToast,
    hideToast,
    tabLoading: {
      markup: portalTabLoadingMarkup,
      show: showPortalTabLoading
    },
    showTooltip: (...args) => window.PlatformUI?.showTooltip?.(...args),
    hideTooltip: (...args) => window.PlatformUI?.hideTooltip?.(...args),
    initTooltips: (...args) => window.PlatformUI?.initTooltips?.(...args),
    alert: (...args) => window.PlatformUI?.alert?.(...args) || Promise.resolve((window.PlatformUI?.native?.alert || window.alert)(args[0] || '')),
    confirm: (...args) => window.PlatformUI?.confirm?.(...args) || Promise.resolve((window.PlatformUI?.native?.confirm || window.confirm)(args[0] || '')),
    choose: (...args) => window.PlatformUI?.choose?.(...args) || Promise.resolve(null),
    prompt: (...args) => window.PlatformUI?.prompt?.(...args) || Promise.resolve((window.PlatformUI?.native?.prompt || window.prompt)(args[0] || '', args[1] || '')),
  };
  window.Portal.auth = { checkSession, redirectToLogin, isAuthFailure, syncPlatformSession, suppressFocusSessionCheck };
  window.Portal.branchModules = { get: getBranchModule, save: saveBranchModule, currentBranchId };
  window.Portal.bonusDiagnostics = { previewCreditUsageOffer: previewCreditUsageBonusOffer };
  window.previewCreditUsageBonusOffer = previewCreditUsageBonusOffer;
  window.Portal.apps = {
    ...(window.Portal.apps || {}),
    registerPortalApp,
    unregisterPortalApp,
    syncPortalTabs: syncPortalTabsFromRuntime
  };
  window.Portal.tabs = { renderTabs, activateTab };
  window.Portal.language = window.PlatformLanguage;
  window.Portal.terminology = {
    get: terminologyLabel,
    appLabel: appTerminologyLabel,
    load: (options = {}) => window.PlatformTerminology?.load?.(
      cleanText(APP.userOrgId, APP.orgId, window.__APP?.userOrgId, window.__APP?.orgId),
      currentBranchId(),
      options
    ),
    current: () => window.PlatformTerminology?.current?.() || null,
    sections: (...args) => window.PlatformTerminology?.sections?.(...args) || []
  };
  window.Portal.modals = window.Portal.modals || createModalManager();
  window.Portal.navigation?.registerHandler?.('managed-modals', {
    priority:900,
    apply:(route) => window.Portal.modals?.applyRoute?.(route)
  });
  window.Portal.navigation?.registerSchema?.('tab', { normalize:(value) => value === 'dashboard' ? 'scheduling' : value });
  window.Portal.navigation?.registerHandler?.('portal-tabs', {
    priority: 100,
    apply: (route) => {
      const tab = cleanText(route?.tab);
      if (!tab) return;
      if (!TabRegistry.tabs.has(tab)) {
        // Feature-gated apps may register after their bundles or permissions
        // arrive. renderTabs() will re-read the unchanged route at that point.
        return;
      }
      if (TabRegistry.activeId === tab && document.getElementById(`tab_${tab}`)?.classList.contains('active')) return;
      activateTab(tab, false, { skipRoute:true, source:'history' });
    }
  });
  window.Portal.routeState = {
    get: routeState,
    set: setRouteState,
    clear: clearRouteState,
    push: (patch, options = {}) => setRouteState(patch, { ...options, history:'push' }),
    replace: (patch, options = {}) => setRouteState(patch, { ...options, history:'replace' }),
    backOrClose: (...args) => window.Portal.navigation?.backOrClose?.(...args),
    registerHandler: (...args) => window.Portal.navigation?.registerHandler?.(...args),
    projectId: projectRouteId,
    mediaId: mediaRouteId,
    resolveProject: resolveRouteProject
  };
  window.Portal.appFlags = {
    load: loadAppFlags,
    has: (group, flag, fallback = false)=>{
      if (window.PlatformAPI?.appFlags?.has?.(group, flag)) return true;
      const value = window.PlatformAPI?.appFlags?.value?.(group, flag, undefined);
      return typeof value === 'boolean' ? value : !!fallback;
    },
    value: (group, flag, fallback = null)=>window.PlatformAPI?.appFlags?.value?.(group, flag, fallback) ?? fallback,
    reason: (group, flag)=>window.PlatformAPI?.appFlags?.reason?.(group, flag) || null,
    variant: (family, fallback = null)=>window.PlatformAPI?.appFlags?.variant?.(family, fallback) ?? fallback,
    variantReason: (family)=>window.PlatformAPI?.appFlags?.variantReason?.(family) || null,
    update: async (flags = {}) => {
      if (!APP.userOrgId || !window.PlatformAPI?.appFlags?.update) return null;
      const result = await window.PlatformAPI.appFlags.update(APP.userOrgId, flags);
      lastAppFlagsKey = stableJson(result || {});
      window.dispatchEvent(new CustomEvent('fm:app-flags:updated', { detail: result || {} }));
      return result;
    },
    updatePlacements: async (placements = {}) => {
      if (!APP.userOrgId || !window.PlatformAPI?.appFlags?.updatePlacements) return null;
      const result = await window.PlatformAPI.appFlags.updatePlacements(APP.userOrgId, placements);
      lastAppFlagsKey = stableJson(result || {});
      window.dispatchEvent(new CustomEvent('fm:app-placements:updated', { detail: result || {} }));
      return result;
    },
    current: ()=>window.PlatformAPI?.appFlags?.current?.() || null
  };
  window.Portal.capabilities = {
    load: loadCapabilities,
    current: ()=>window.PlatformAPI?.capabilities?.current?.() || null,
    can: (key)=>window.PlatformAPI?.capabilities?.can?.(key) === true,
    value: (key, fallback = null)=>window.PlatformAPI?.capabilities?.value?.(key, fallback) ?? fallback,
    reason: (key)=>window.PlatformAPI?.capabilities?.reason?.(key) || null,
    definition: (key)=>window.PlatformAPI?.capabilities?.definition?.(key) || null,
    update: async (values = {}) => {
      if (!APP.userOrgId || !window.PlatformAPI?.capabilities?.update) return null;
      const result = await window.PlatformAPI.capabilities.update(APP.userOrgId, values);
      window.dispatchEvent(new CustomEvent('fm:capabilities:updated', { detail: result || {} }));
      // Capability writes change app-flag resolution too; refresh that cache.
      loadAppFlags({ refresh: true }).catch(()=>null);
      return result;
    },
    validate: (values = {}) => window.PlatformAPI?.capabilities?.validate?.(APP.userOrgId, values),
    resolveDraft: (definitions, values) => window.PlatformAPI?.capabilities?.resolveDraft?.(definitions, values) || { effective_by_key: {}, reasons: {} },
    presets: {
      create: (payload = {}) => window.PlatformAPI?.capabilities?.createPreset?.(APP.userOrgId, payload),
      update: (presetId, payload = {}) => window.PlatformAPI?.capabilities?.updatePreset?.(APP.userOrgId, presetId, payload),
      remove: (presetId) => window.PlatformAPI?.capabilities?.deletePreset?.(APP.userOrgId, presetId),
      apply: async (presetId) => {
        const result = await window.PlatformAPI?.capabilities?.applyPreset?.(APP.userOrgId, presetId);
        window.dispatchEvent(new CustomEvent('fm:capabilities:updated', { detail: result || {} }));
        loadAppFlags({ refresh: true }).catch(()=>null);
        return result;
      },
      setSignup: (presetId) => window.PlatformAPI?.capabilities?.setSignupPreset?.(APP.userOrgId, presetId)
    }
  };
  window.Portal.can = (key)=>window.Portal.capabilities.can(key);
  // Org-facing add-apps catalog: discoverable capability app nodes joined
  // with manifest presentation. Backs the More Apps menu and Manage My Apps.
  window.Portal.appCatalog = {
    list: appCatalogEntries,
    entry: (key) => appCatalogEntries().find((item) => item.key === cleanText(key)) || null,
    add: addCatalogApp,
    remove: removeCatalogApp,
    open: (key, options = {}) => openAppCatalogModal(key, options)
  };
  // Per-app setup workflows. Apps that need configuration after being added
  // (e.g. SMS registration, channels rollout to existing users) register a
  // handler keyed by their capability key; it runs instead of the default
  // "jump to the new tab" hand-off and typically opens a wizard modal.
  window.Portal.appSetup = {
    declare: (key, definition = {}) => {
      const normalizedKey = cleanText(key);
      if (!normalizedKey || !definition || typeof definition !== 'object') return null;
      appSetupDefinitions.set(normalizedKey, { ...definition, key:normalizedKey });
      return appSetupDescription(normalizedKey);
    },
    register: (key, handler, definition) => {
      const normalizedKey = cleanText(key);
      if (typeof handler === 'function' && normalizedKey) appSetupHandlers.set(normalizedKey, handler);
      if (definition && typeof definition === 'object' && normalizedKey) appSetupDefinitions.set(normalizedKey, { ...definition, key:normalizedKey });
    },
    unregister: (key) => appSetupHandlers.delete(cleanText(key)),
    has: (key) => appSetupHandlers.has(cleanText(key)),
    describe: (key) => appSetupDescription(key),
    list: () => [...new Set([...appSetupDefinitions.keys(), ...appSetupHandlers.keys()])].map(appSetupDescription),
    run: (key, context = {}) => {
      const handler = appSetupHandlers.get(cleanText(key));
      return handler ? Promise.resolve(handler(context)) : Promise.resolve(null);
    }
  };
  // Money setup workflow: adding Money from the catalog also switches on
  // merchant processing (the person adding apps holds the org-admin
  // capability write) and lands the user in the Money onboarding wizard at
  // step 1 (Company Settings -> Payments). Registered here, next to the
  // appSetup seam itself, because core.js is guaranteed to be parsed before
  // any catalog surface can run a handler (payments-api.js loads earlier in
  // the shell, before window.Portal exists).
  window.Portal.appSetup.register('platform.money', async () => {
    try {
      if (window.Portal.capabilities.value('money.merchant_processing', false) !== true) {
        await window.Portal.capabilities.update({ 'money.merchant_processing': true });
      }
      // The wizard pane gates on the derived app flag; make sure the refresh
      // triggered by the capability write has landed before navigating.
      await loadAppFlags({ refresh: true }).catch(() => null);
    } catch (error) {
      console.warn('Money app setup could not enable merchant processing', error);
    }
    try {
      if (await window.FirstMatePaymentsSetup?.open?.()) return;
    } catch (error) {
      console.warn('Forward hosted setup could not open', error);
    }
    window.Portal.navigation?.navigate?.(
      { tab: 'company_settings', sub: 'money', settingsView: 'payments', workflow: 'money_onboarding', workflow_step: 'business' },
      { source: 'money-app-setup', ownedKeys: ['tab', 'sub', 'workflow', 'workflow_step'] }
    );
  });
  window.Portal.credits = { refreshCredits, get lastCredits(){ return lastCredits; } };

  window.addEventListener('fm:embeddable-apps:app-registered', (event) => {
    const app = event?.detail?.app || {};
    if (app.kind === 'portal_tab' || app.surfaces?.includes?.('portal_tab')) renderTabs();
  });
  window.addEventListener('fm:embeddable-apps:app-unregistered', renderTabs);

  // Boot
  document.addEventListener('DOMContentLoaded', async ()=>{
    // Manifests are registered synchronously above. Prune stale nested route
    // state before session, flags, or lazy app bundles can react to it.
    window.Portal?.navigation?.reconcile?.({ source:'portal-boot' });
    await syncPlatformSession().catch(()=>null);
    await window.PlatformLanguage?.refresh?.().catch(error => console.warn("Language initialization failed", error));
    loadSidebarWidthPreference().catch(()=>null);
    window.FirstMateStatsig?.init?.({ source: 'platform' }).catch(()=>null);
    const appFlagsReady = loadAppFlags().catch(()=>null);
    const capabilitiesReady = loadCapabilities().catch(()=>null);
    const terminologyReady = Promise.resolve(window.Portal.terminology.load()).catch(()=>null);
    initializeSidebarModes();
    await Promise.all([appFlagsReady, capabilitiesReady, terminologyReady]);
    try {
      const orgId=String(APP.userOrgId || '').trim();
      const commerce=await window.PlatformAPI.request(`${window.PlatformAPI.baseUrl()}/organizations/${encodeURIComponent(orgId)}/commerce`);
      window.PlatformCommerce.set(commerce.commerce || commerce);
    } catch(error) {
      const cover=document.getElementById('fmPlatformBootCover');
      if(cover){cover.textContent='Billing settings could not be loaded. ';const retry=document.createElement('button');retry.textContent='Retry';retry.onclick=()=>location.reload();cover.appendChild(retry);}
      console.error('Billing initialization failed',error);return;
    }
    TabRegistry.routesReady = true;
    renderTabs();
    await refreshCredits().catch(()=>null);
    document.body.classList.remove('platform-booting');
    document.getElementById('fmPlatformBootCover')?.remove();
    setTimeout(()=>checkSession().catch(()=>null), 1000);
    setInterval(()=>checkSession().catch(()=>null), 240000);
  });

  document.addEventListener('visibilitychange', ()=>{
    if (document.visibilityState === 'visible') {
      checkSession().catch(()=>null);
    }
  });

  window.addEventListener('focus', ()=>{
    if (Date.now() < focusSessionCheckSuppressedUntil) return;
    checkSession().catch(()=>null);
  });

  window.addEventListener('fm:perms:updated', () => renderTabs());
  window.addEventListener('fm:app-flags:updated', () => renderTabs());
  window.addEventListener('fm:app-placements:updated', () => renderTabs());
  window.addEventListener('fm:capabilities:updated', () => {
    const expanded = window.Portal?.capabilities?.value?.('platform.expanded_access', false) === true;
    if (typeof APP.platformExpandedAssets === 'boolean' && expanded !== APP.platformExpandedAssets) {
      window.location.reload();
      return;
    }
    renderTabs();
  });
  window.addEventListener('fm:terminology:updated', () => renderTabs());
  window.addEventListener('fm:branch-module:updated', (event) => {
    if (cleanText(event?.detail?.moduleId) !== 'variable_mappings') return;
    if (event?.detail?.config) {
      window.PlatformTerminology?.setConfig?.(event.detail.config);
      return;
    }
    Promise.resolve(window.Portal.terminology.load({ refresh:true })).catch(()=>null);
  });
  window.addEventListener('fm:app-entitlements:updated', (event) => {
    if (event?.detail?.source === 'session') TabRegistry.preferDefaultHome = true;
    renderTabs();
  });
})();
