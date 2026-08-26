/* libraries/canvassing-api/canvassing-api.js
 * Browser client for /v1/canvassing.
 *
 * Use this for every frontend call to the Canvassing API. Platform projects are
 * created only by promotePin(), which calls the Canvassing API; the Canvassing
 * API then uses the Platform generic lead endpoint internally.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl: '', defaultHeaders: {} };

  function cleanText(value){ return String(value ?? '').trim(); }

  function defaultBaseUrl(){
    if (APP.canvassingApiBase) return cleanText(APP.canvassingApiBase).replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return '';
    return `${location.origin}/v1/canvassing`;
  }

  function configure(options = {}){
    if (options.baseUrl) state.baseUrl = cleanText(options.baseUrl).replace(/\/+$/, '');
    if (options.headers && typeof options.headers === 'object') state.defaultHeaders = { ...state.defaultHeaders, ...options.headers };
    return api;
  }

  function baseUrl(){
    if (!state.baseUrl) state.baseUrl = defaultBaseUrl();
    return state.baseUrl;
  }

  function url(path = ''){
    const raw = cleanText(path);
    if (/^https?:\/\//i.test(raw)) return raw;
    const base = baseUrl();
    if (!base) return '';
    return `${base}/${raw.replace(/^\/+/, '')}`;
  }

  function cookieValue(name){
    const target = `${encodeURIComponent(name)}=`;
    return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(target))?.slice(target.length) || '';
  }

  function csrfToken(){
    return decodeURIComponent(cookieValue('fm_platform_session_csrf') || '');
  }

  function jsonBody(body){
    if (body == null || body instanceof FormData || typeof body === 'string') return body;
    return JSON.stringify(body);
  }

  function requestHeaders(options, body){
    const method = cleanText(options.method || 'GET').toUpperCase();
    const headers = {
      Accept: 'application/json',
      ...state.defaultHeaders,
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    };
    const csrf = csrfToken();
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers['X-Platform-CSRF']) headers['X-Platform-CSRF'] = csrf;
    return headers;
  }

  async function request(path, options = {}){
    const requestUrl = url(path);
    if (!requestUrl) {
      const error = new Error('Canvassing API is not configured for this frontend session.');
      error.status = 0;
      error.data = { ok: false, missing: true };
      throw error;
    }
    const body = jsonBody(options.body);
    const res = await fetch(requestUrl, {
      ...options,
      body,
      cache: options.cache || 'no-store',
      credentials: options.credentials || 'include',
      headers: requestHeaders(options, body)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch(e) {}
    if (!res.ok || data?.ok === false) {
      const error = new Error(cleanText(data?.message || data?.error) || `Canvassing API request failed (${res.status})`);
      error.status = res.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  const enc = (value) => encodeURIComponent(cleanText(value));
  const branchPath = (orgId, branchId, suffix = '') => `/organizations/${enc(orgId)}/branch/${enc(branchId || 'default')}${suffix}`;

  function defaultSettings(patch = {}){
    return {
      schema_version: 1,
      enabled: patch.enabled !== false,
      canvasser_role_id: cleanText(patch.canvasser_role_id || 'canvasser'),
      default_status_id: cleanText(patch.default_status_id || 'new'),
      lead_stage_id: cleanText(patch.lead_stage_id || 'new_lead'),
      statuses: Array.isArray(patch.statuses) && patch.statuses.length ? patch.statuses : [
        { id: 'new', color: '#2563eb', order: 10, lead_eligible: true, label: 'New' },
        { id: 'no_answer', color: '#f59e0b', order: 20, lead_eligible: false, label: 'No Answer' },
        { id: 'not_interested', color: '#64748b', order: 30, lead_eligible: false, label: 'Not Interested' },
        { id: 'follow_up', color: '#8b5cf6', order: 40, lead_eligible: true, label: 'Follow Up' },
        { id: 'appointment_set', color: '#16a34a', order: 50, lead_eligible: true, label: 'Appointment Set' },
        { id: 'lead_created', color: '#0f766e', order: 60, lead_eligible: false, label: 'Lead Created' },
        { id: 'deleted', color: '#991b1b', order: 999, lead_eligible: false, label: 'Deleted' }
      ],
      labels: {
        ...(patch.labels || {}),
        pin_statuses: {
          new: 'New',
          no_answer: 'No Answer',
          not_interested: 'Not Interested',
          follow_up: 'Follow Up',
          appointment_set: 'Appointment Set',
          lead_created: 'Lead Created',
          deleted: 'Deleted',
          ...((patch.labels || {}).pin_statuses || {})
        }
      }
    };
  }

  function missingFallback(error){
    const status = Number(error?.status || 0);
    const message = cleanText(error?.message || error?.data?.message || error?.data?.error || error?.responseText).toLowerCase();
    return status === 0
      || status === 404
      || message.includes('requested platform record was not found')
      || message.includes('record was not found');
  }

  const settings = {
    get(orgId, branchId = 'default'){
      return request(branchPath(orgId, branchId, '/settings')).catch((error) => {
        if (missingFallback(error)) return { ok: true, settings: defaultSettings(), missing: true };
        throw error;
      });
    },
    save(orgId, branchId = 'default', data = {}){
      return request(branchPath(orgId, branchId, '/settings'), { method: 'PUT', body: { data } }).catch((error) => {
        if (missingFallback(error)) return { ok: true, settings: defaultSettings(data || {}), missing: true };
        throw error;
      });
    }
  };

  const pins = {
    list(orgId, branchId = 'default'){
      return request(branchPath(orgId, branchId, '/pins')).catch((error) => {
        if (missingFallback(error)) return { ok: true, pins: [], settings: defaultSettings(), missing: true };
        throw error;
      });
    },
    create(orgId, branchId = 'default', pin = {}){
      return request(branchPath(orgId, branchId, '/pins'), { method: 'POST', body: pin || {} });
    },
    get(orgId, branchId = 'default', pinId){
      return request(branchPath(orgId, branchId, `/pins/${enc(pinId)}`));
    },
    patch(orgId, branchId = 'default', pinId, patch = {}){
      return request(branchPath(orgId, branchId, `/pins/${enc(pinId)}`), { method: 'PATCH', body: patch || {} });
    },
    remove(orgId, branchId = 'default', pinId){
      return request(branchPath(orgId, branchId, `/pins/${enc(pinId)}`), { method: 'DELETE' });
    },
    promote(orgId, branchId = 'default', pinId, lead = {}){
      return request(branchPath(orgId, branchId, `/pins/${enc(pinId)}/promote`), { method: 'POST', body: lead || {} });
    }
  };

  const users = {
    list(orgId, branchId = 'default'){
      return request(branchPath(orgId, branchId, '/users'));
    },
    create(orgId, branchId = 'default', user = {}){
      return request(branchPath(orgId, branchId, '/users'), { method: 'POST', body: user || {} });
    }
  };

  const geocode = {
    reverse(lat, lng){
      return request(`/geocode/reverse?lat=${enc(lat)}&lng=${enc(lng)}`);
    }
  };

  const api = { configure, baseUrl, url, request, settings, pins, users, geocode };
  configure({ baseUrl: APP.canvassingApiBase || '' });
  root.CanvassingAPI = api;
})();
