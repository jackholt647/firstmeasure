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
    permissions: {} // populated by refreshCredits
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
      return new Date(withZone).toLocaleString();
    }catch(e){
      return String(d ?? '');
    }
  }

  const AUTH_NOTICE_KEY = 'fm_login_notice';
  let authRedirecting = false;

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
      || text
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
      cache: 'no-store'
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
    if (key === 'commercial' || key === 'multifamily') return 12;
    return 7;
  }

  function gutterReportAddon(){
    const amount = Number(APP.gutterReportAddon ?? 2);
    return Number.isFinite(amount) ? amount : 2;
  }

  function weatherReportAddon(){
    const amount = Number(APP.weatherReportAddon ?? 5);
    return Number.isFinite(amount) ? amount : 5;
  }

  function instantReportAddon(projectType){
    const type = String(projectType || 'residential').trim().toLowerCase();
    return type === 'commercial' || type === 'multifamily' ? 4 : 2;
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
    return await fmJson(path, { method: 'POST', body: payload || {} });
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
    const res = await fetch(APP.serverEndpoint, { method:'POST', body: fd });
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

  function isDraftPlatformProject(project = {}){
    const status = cleanText(project.status, project.measurement_project?.status, project.measurement?.status, project.workflow_state).toLowerCase();
    if (projectMeasurementKeys(project).length && ['queued', 'processing', 'in_progress', 'awaiting_review', 'awaiting_manager_review', 'pending_rejection'].includes(status)) return false;
    return !projectMeasurementKeys(project).length
      && !hasProjectProposals(project)
      && !hasScheduledAppointment(project);
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
        projectMeasurementKeys(project).forEach((key) => {
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
      return await portalActionJson('queue', fields);
    }

    return null;
  }

  async function postAction(action, fields={}){
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

  function setCurrentPermissions(nextPermissions){
    const next = (nextPermissions && typeof nextPermissions === 'object') ? nextPermissions : {};
    const prevKey = stableJson(window.Portal.currentUser.permissions || {});
    const nextKey = stableJson(next);
    if (prevKey === nextKey) return false;
    window.Portal.currentUser.permissions = next;
    window.dispatchEvent(new CustomEvent('fm:perms:updated'));
    return true;
  }

  let platformSessionPromise = null;
  async function syncPlatformSession(){
    if (platformSessionPromise) return platformSessionPromise;
    platformSessionPromise = (async () => {
      if (!window.PlatformAPI?.auth?.me) return null;
      const session = await window.PlatformAPI.auth.me().catch(() => null);
      if (!session?.authenticated && !session?.membership && !session?.user) return session;

      const membership = session.membership || {};
      const user = session.user || {};
      const identity = session.identity || {};
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
      if (membership.permissions || user.permissions || user.org_permissions?.items) {
        setCurrentPermissions(membership.permissions || user.permissions || user.org_permissions.items || {});
      }
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
      .fm-toast .tx{display:flex; flex-direction:column; min-width:0}
      .fm-toast .t1{font-weight:1000; font-size:13px; color:#111}
      .fm-toast .t2{font-weight:800; font-size:12px; color:#666; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
      .fm-toast .x{
        margin-left:auto;
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
        <div class="t1" id="fmToastT1">Done</div>
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
  };

  function setPortalTabEntry(def){
    if (!def || !def.id) throw new Error('setPortalTabEntry: missing id');
    const runtimeAppId = def.appId || `portal.${def.id}`;
    TabRegistry.tabs.set(def.id, {
      id: def.id,
      appId: runtimeAppId,
      title: def.title || def.id,
      icon: def.icon || 'fa-circle',
      order: Number.isFinite(def.order) ? def.order : 1000,
      placement: def.placement || 'main',
      css: def.css || '',
      fullBleed: def.fullBleed === true,
      mount: def.mount || null,
      onShow: def.onShow || null,
      onHide: def.onHide || null,
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
        title: meta.title || meta.label || app.title || app.label || tabId,
        icon: meta.icon || app.icon || 'fa-circle',
        order: Number.isFinite(meta.order) ? meta.order : (Number.isFinite(app.order) ? app.order : 1000),
        placement: app.placement || 'main',
        css: app.css || '',
        fullBleed: app.fullBleed === true,
        onShow: app.onShow || null,
        onHide: app.onHide || null,
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
    const mode = panelName === 'todo' ? 'todo' : 'apps';
    const appsTab = document.getElementById('sidebarAppsTab');
    const todoTab = document.getElementById('sidebarTodoTab');
    const appsPanel = document.getElementById('sidebarAppsPanel');
    const todoPanel = document.getElementById('sidebarTodoPanel');
    if (!appsTab || !todoTab || !appsPanel || !todoPanel) return;

    appsTab.classList.toggle('active', mode === 'apps');
    todoTab.classList.toggle('active', mode === 'todo');
    appsTab.setAttribute('aria-selected', mode === 'apps' ? 'true' : 'false');
    todoTab.setAttribute('aria-selected', mode === 'todo' ? 'true' : 'false');
    appsPanel.classList.toggle('active', mode === 'apps');
    todoPanel.classList.toggle('active', mode === 'todo');
    appsPanel.hidden = mode !== 'apps';
    todoPanel.hidden = mode !== 'todo';
    if (mode === 'todo') mountSidebarTodo();
  }

  function sidebarTodoFeatureEnabled(){
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (!flags?.current?.()) return false;
    return !!flags.has?.('platform', 'left_column_todo_list');
  }

  function applySidebarTodoFeatureFlag(){
    const sidebar = document.getElementById('mainSidebar');
    const enabled = sidebarTodoFeatureEnabled();
    sidebar?.classList.toggle('todo-list-enabled', enabled);
    if (!enabled) setSidebarPanel('apps');
    return enabled;
  }

  function mountSidebarTodo(force = false){
    const container = document.getElementById('sidebarTodoList');
    if (!container) return;
    const orgId = cleanText(APP.userOrgId, APP.orgId, window.__APP?.userOrgId, window.__APP?.orgId);
    if (!orgId || !window.PlatformActionItems?.renderTodayList) {
      container.innerHTML = '<div class="pai-today-list"><div class="pai-state">To-dos are not available.</div></div>';
      return;
    }
    if (!sidebarTodoController) {
      sidebarTodoController = window.PlatformActionItems.renderTodayList(container, {
        orgId,
        branchId: currentBranchId(),
        userId: cleanText(APP.userId, APP.user_id, window.Portal?.currentUser?.id),
        completedOpen: true
      });
      sidebarTodoLoadedAt = Date.now();
      return;
    }
    if (force || Date.now() - sidebarTodoLoadedAt > 60000) {
      sidebarTodoLoadedAt = Date.now();
      sidebarTodoController.load().catch(() => null);
    }
  }

  function initializeSidebarModes(){
    const appsTab = document.getElementById('sidebarAppsTab');
    const todoTab = document.getElementById('sidebarTodoTab');
    if (!appsTab || !todoTab) return;
    appsTab.addEventListener('click', () => setSidebarPanel('apps'));
    todoTab.addEventListener('click', () => {
      if (applySidebarTodoFeatureFlag()) setSidebarPanel('todo');
    });
    window.addEventListener('fm:app-flags:updated', applySidebarTodoFeatureFlag);
    window.addEventListener('fm:app-flags:failed', () => setSidebarPanel('apps'));
    applySidebarTodoFeatureFlag();
    setSidebarPanel('apps');
  }

  function updateMobileTabTitle(tab){
    const topbar = document.querySelector('.mobile-topbar');
    const title = document.getElementById('mobTabTitle');
    if (!topbar || !title) return;
    const text = String(tab?.title || '').trim();
    title.textContent = text;
    topbar.classList.toggle('has-tab-title', !!text);
  }

  function renderTabs(){
    syncPortalTabsFromRuntime();
    const links = ensureSidebarLinksContainer();
    const panels = document.getElementById('mainPanels');
    if (!links || !panels) return;

    const list = [...TabRegistry.tabs.values()].sort((a,b)=>a.order-b.order);
    const currentRoute = routeState();
    if (currentRoute.project && currentRoute.tab && !TabRegistry.tabs.has(currentRoute.tab) && !currentRoute.projectTab) {
      setRouteState({ projectTab: currentRoute.tab, tab: null });
    }

    injectCSS('sidebar_links', `
      #sidebarLinks{
        margin-top: 10px;
        display:flex;
        flex-direction:column;
        flex:1;
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
        flex:0 0 auto;
      }
      #sidebarBottomLinks{
        margin-top:auto;
        flex:0 0 auto;
      }
      .fm-link{
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
      .fm-link.bottom{ padding-top:12px; }
      .fm-tabpanel{display:none;min-height:100%}
      .fm-tabpanel.active{display:block;height:100%}
      .main-panels:has(>.fm-tabpanel.active.full-bleed){padding:0;overflow:hidden}
      .fm-tabpanel.full-bleed{height:100%;min-height:0;overflow:hidden}
    `);

    links.innerHTML = '';
    const mainLinks = document.createElement('div');
    mainLinks.id = 'sidebarMainLinks';
    const bottomLinks = document.createElement('div');
    bottomLinks.id = 'sidebarBottomLinks';
    links.append(mainLinks, bottomLinks);
    const wantedPanelIds = new Set(list.map((t) => `tab_${t.id}`));
    panels.querySelectorAll('.fm-tabpanel').forEach((panel) => {
      if (!wantedPanelIds.has(panel.id)) {
        const oldId = String(panel.id || '').replace(/^tab_/, '');
        TabRegistry.mounted.delete(oldId);
        panel.remove();
      }
    });

    for (const t of list){
      const item = document.createElement('div');
      item.className = `fm-link${t.placement === 'bottom' ? ' bottom' : ''}`;
      item.dataset.tab = t.id;
      item.innerHTML = `
        <div class="ic"><i class="fas ${escapeHtml(t.icon)}"></i></div>
        <div class="tx">${escapeHtml(t.title)}</div>
      `;
      item.addEventListener('click', ()=>activateTab(t.id));
      (t.placement === 'bottom' ? bottomLinks : mainLinks).appendChild(item);

      let panel = document.getElementById(`tab_${t.id}`);
      if (!panel) {
        panel = document.createElement('div');
        panel.className = 'fm-tabpanel';
        panel.id = `tab_${t.id}`;
      }
      panel.classList.toggle('full-bleed', !!t.fullBleed);
      panels.appendChild(panel);
    }

    if (!TabRegistry.activeId || !TabRegistry.tabs.has(TabRegistry.activeId)){
      const routeTab = currentRoute.tab && TabRegistry.tabs.has(currentRoute.tab) ? currentRoute.tab : '';
      TabRegistry.activeId = routeTab || (TabRegistry.tabs.has('dashboard') ? 'dashboard' : (list[0]?.id || null));
    }
    if (TabRegistry.activeId) {
      const alreadyMounted = TabRegistry.mounted.has(TabRegistry.activeId);
      activateTab(TabRegistry.activeId, true, { skipOnShow: alreadyMounted });
    } else {
      updateMobileTabTitle(null);
    }
  }

  function activateTab(id, isInitial=false, options = {}){
    if (!TabRegistry.tabs.has(id)) return;

    const prevId = TabRegistry.activeId;
    if (prevId && prevId !== id){
      const prev = TabRegistry.tabs.get(prevId);
      prev?.onHide && prev.onHide();
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
      if (window.FirstMateEmbeddableApps?.mount && t.appId) {
        window.FirstMateEmbeddableApps.mount(panelEl, t.appId, {
          surface: 'portal_tab',
          source: `portal_tab_${id}`,
          chrome: 'tab',
          appId: t.appId,
          host: window.FirstMateEmbeddableApps.createHostBridge?.({
            surface: 'portal_tab',
            onSetActiveApp: (appId) => {
              const tab = [...TabRegistry.tabs.values()].find((entry) => entry.appId === appId || entry.id === appId);
              if (tab) activateTab(tab.id);
            },
            onSetRoute: (patch) => setRouteState(patch),
            showToast
          })
        }).then((handle) => {
          TabRegistry.handles.set(id, handle);
        }).catch((error) => {
          console.warn(`Embeddable portal tab mount failed: ${id}`, error);
          if (t.mount) t.mount(panelEl);
        });
      } else if (t.mount) t.mount(panelEl);
    }

    if (!options.skipRoute) setRouteState({ tab: id });
    if (!options.skipOnShow) t?.onShow && t.onShow(isInitial);
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

      const bal = moneyAmount(data.credits_balance ?? 0);
      lastCredits = bal;
      window.Portal.freeExpediteUses = Math.max(0, parseInt(String(data.free_expedite_uses ?? 0), 10) || 0);

      // Capture permissions from server
      if (data.permissions && typeof data.permissions === 'object') setCurrentPermissions(data.permissions);
      window.Portal.referralDiscount = data.referral_discount || null;

      document.querySelectorAll('.credits-val-target').forEach(el => el.textContent = `$${formatMoney(bal)}`);
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
    const params = new URLSearchParams(window.location.search || '');
    return {
      tab: cleanText(params.get('tab')),
      projectTab: cleanText(params.get('projectTab')),
      project: cleanText(params.get('project')),
      photo: cleanText(params.get('photo')),
      photoScope: cleanText(params.get('photoScope'))
    };
  }

  function setRouteState(patch = {}, options = {}){
    const url = new URL(window.location.href);
    Object.entries(patch || {}).forEach(([key, value]) => {
      const text = cleanText(value);
      if (text) url.searchParams.set(key, text);
      else url.searchParams.delete(key);
    });
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return routeState();
    const method = options.push ? 'pushState' : 'replaceState';
    try { window.history?.[method]?.({ ...(window.history.state || {}), fmRoute: true }, '', next); } catch(e) {}
    const state = routeState();
    window.dispatchEvent(new CustomEvent('fm:route-state:updated', { detail: state }));
    return state;
  }

  function clearRouteState(keys = []){
    const patch = {};
    (Array.isArray(keys) ? keys : [keys]).forEach((key) => { if (key) patch[key] = null; });
    return setRouteState(patch);
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

    return { register, unregister, bringToFront, top, isTop, closeTop, snapshot };
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
      'stage',
      'stage_id',
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

  async function resolveRouteProject(projectId){
    const id = cleanText(projectId);
    if (!id) return null;
    const cached = window.Portal.ProjectStore?.get?.(id);
    const orgId = cleanText(APP.userOrgId, APP.orgId, window.__APP?.userOrgId, window.__APP?.orgId);
    if (!orgId || !window.PlatformAPI?.projects) return cached || null;
    const direct = await window.PlatformAPI.projects.get(orgId, id).catch(() => null);
    const directProject = projectFromDocument(direct?.document);
    if (directProject) {
      const merged = cached ? mergeResolvedProject(directProject, cached) : directProject;
      return window.Portal.ProjectStore?.cache?.(merged) || window.Portal.ProjectStore?.save?.(merged) || merged;
    }
    if (cached) return cached;
    const result = await window.PlatformAPI.projects.list(orgId).catch(() => null);
    const docs = Array.isArray(result?.documents) ? result.documents : [];
    const found = docs.map(projectFromDocument).find((project) => project && cleanText(project.id) === id) || null;
    return found ? (window.Portal.ProjectStore?.cache?.(found) || window.Portal.ProjectStore?.save?.(found) || found) : null;
  }

  // Export
  window.Portal.cfg = APP;
  window.Portal.util = { $, escapeHtml, injectCSS, formatDate, postAction, enableSafeBackdropClose, hasPerm, fmUrl, fmJson, fmPost, platformUrl, platformJson, currentActor, googleMapsApiKey };
  window.Portal.pricing = { projectTypePrice, gutterReportAddon, weatherReportAddon, instantReportAddon, orderAmount, orderAmountWithWeather, activeReferralDiscount, standardBaseAmountForOrder, referralDiscountPreview, moneyAmount, formatMoney };
  window.Portal.ui = {
    showToast,
    hideToast,
    showTooltip: (...args) => window.PlatformUI?.showTooltip?.(...args),
    hideTooltip: (...args) => window.PlatformUI?.hideTooltip?.(...args),
    initTooltips: (...args) => window.PlatformUI?.initTooltips?.(...args),
    alert: (...args) => window.PlatformUI?.alert?.(...args) || Promise.resolve((window.PlatformUI?.native?.alert || window.alert)(args[0] || '')),
    confirm: (...args) => window.PlatformUI?.confirm?.(...args) || Promise.resolve((window.PlatformUI?.native?.confirm || window.confirm)(args[0] || '')),
    prompt: (...args) => window.PlatformUI?.prompt?.(...args) || Promise.resolve((window.PlatformUI?.native?.prompt || window.prompt)(args[0] || '', args[1] || '')),
  };
  window.Portal.auth = { checkSession, redirectToLogin, isAuthFailure, syncPlatformSession };
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
  window.Portal.modals = window.Portal.modals || createModalManager();
  window.Portal.routeState = {
    get: routeState,
    set: setRouteState,
    clear: clearRouteState,
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
    current: ()=>window.PlatformAPI?.appFlags?.current?.() || null
  };
  window.Portal.credits = { refreshCredits, get lastCredits(){ return lastCredits; } };

  window.addEventListener('fm:embeddable-apps:app-registered', (event) => {
    const app = event?.detail?.app || {};
    if (app.kind === 'portal_tab' || app.surfaces?.includes?.('portal_tab')) renderTabs();
  });
  window.addEventListener('fm:embeddable-apps:app-unregistered', renderTabs);

  // Boot
  document.addEventListener('DOMContentLoaded', async ()=>{
    await syncPlatformSession().catch(()=>null);
    window.FirstMateStatsig?.init?.({ source: 'platform' }).catch(()=>null);
    const appFlagsReady = loadAppFlags().catch(()=>null);
    initializeSidebarModes();
    await appFlagsReady;
    renderTabs();
    refreshCredits().catch(()=>null);
    setTimeout(()=>checkSession().catch(()=>null), 1000);
    setInterval(()=>checkSession().catch(()=>null), 240000);
  });

  document.addEventListener('visibilitychange', ()=>{
    if (document.visibilityState === 'visible') {
      checkSession().catch(()=>null);
    }
  });

  window.addEventListener('focus', ()=>{
    checkSession().catch(()=>null);
  });

  window.addEventListener('fm:perms:updated', () => renderTabs());
  window.addEventListener('fm:app-flags:updated', () => renderTabs());
})();
