/* libraries/lead-intake-api/lead-intake-api.js
 * Browser client for /v1/lead-intake.
 *
 * This owns embeddable website forms and public form submissions. Actual CRM
 * lead records are still created by the Platform API on the server.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl: '', defaultHeaders: {} };

  function cleanText(value){ return String(value ?? '').trim(); }

  function defaultBaseUrl(){
    if (APP.leadIntakeApiBase) return cleanText(APP.leadIntakeApiBase).replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.protocol}//${location.hostname}:3111/v1/lead-intake`;
    return `${location.origin}/v1/lead-intake`;
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
      const error = new Error('Lead Intake API is not configured for this frontend session.');
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
      const error = new Error(cleanText(data?.message || data?.error) || `Lead Intake API request failed (${res.status})`);
      error.status = res.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  const enc = (value) => encodeURIComponent(cleanText(value));

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
      return request(`/organizations/${enc(orgId)}/branch/${enc(branchId || 'default')}/settings`).catch((error) => {
        if (missingFallback(error)) return { ok: true, settings: { enabled: true, forms: [] }, missing: true };
        throw error;
      });
    },
    patch(orgId, branchId = 'default', patch = {}){
      return request(`/organizations/${enc(orgId)}/branch/${enc(branchId || 'default')}/settings`, {
        method: 'PATCH',
        body: patch || {}
      });
    }
  };

  const forms = {
    async list(orgId, branchId = 'default'){
      const result = await settings.get(orgId, branchId);
      return result?.settings?.forms || [];
    },
    async saveAll(orgId, branchId = 'default', list = []){
      const result = await settings.patch(orgId, branchId, { forms: Array.isArray(list) ? list : [] });
      return result?.settings?.forms || [];
    },
    instantEstimatePreview(orgId, branchId = 'default', formId, payload = {}){
      return request(`/organizations/${enc(orgId)}/branch/${enc(branchId || 'default')}/forms/${enc(formId)}/instant-estimate-preview`, {
        method: 'POST',
        body: payload || {}
      });
    },
    publicConfig(formId){
      return request(`/public/forms/${enc(formId)}`, { credentials: 'omit' });
    },
    availability(formId, date = ''){
      const suffix = date ? `?date=${enc(date)}` : '';
      return request(`/public/forms/${enc(formId)}/availability${suffix}`, { credentials: 'omit' });
    },
    submit(formId, payload = {}){
      return request(`/public/forms/${enc(formId)}/submit`, {
        method: 'POST',
        credentials: 'omit',
        body: payload || {}
      });
    }
  };

  const api = { configure, baseUrl, url, request, settings, forms };
  configure({ baseUrl: APP.leadIntakeApiBase || '' });
  root.LeadIntakeAPI = api;
})();
