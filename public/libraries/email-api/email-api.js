/* libraries/email-api/email-api.js
 * Browser client for /v1/email.
 *
 * Use this for Email API calls only. Platform-owned data still goes through
 * PlatformAPI; this library owns email sending/inbound/import routing endpoints.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl: '', defaultHeaders: {} };

  function cleanText(value){ return String(value ?? '').trim(); }

  function defaultBaseUrl(){
    if (APP.emailApiBase) return cleanText(APP.emailApiBase).replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return '';
    return `${location.origin}/v1/email`;
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
      const error = new Error('Email API is not configured for this frontend session.');
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
      const error = new Error(cleanText(data?.message || data?.error) || `Email API request failed (${res.status})`);
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

  const leadImport = {
    get(orgId, branchId = 'default'){
      return request(`/organizations/${enc(orgId)}/branch/${enc(branchId || 'default')}/lead-import`).catch((error) => {
        if (missingFallback(error)) return { ok: true, settings: { enabled: true, website_forms: [] }, missing: true };
        throw error;
      });
    },
    patch(orgId, branchId = 'default', patch = {}){
      return request(`/organizations/${enc(orgId)}/branch/${enc(branchId || 'default')}/lead-import`, {
        method: 'PATCH',
        body: patch || {}
      }).catch((error) => {
        if (missingFallback(error)) return { ok: true, settings: { enabled: true, ...(patch || {}) }, missing: true };
        throw error;
      });
    },
    regenerate(orgId, branchId = 'default'){
      return leadImport.patch(orgId, branchId, { regenerate: true });
    },
    setEnabled(orgId, branchId = 'default', enabled = true){
      return leadImport.patch(orgId, branchId, { enabled: enabled !== false });
    },
    async saveWebsiteForms(orgId, branchId = 'default', forms = []){
      if (root.LeadIntakeAPI?.forms?.saveAll) return root.LeadIntakeAPI.forms.saveAll(orgId, branchId, forms);
      return leadImport.patch(orgId, branchId, { website_forms: Array.isArray(forms) ? forms : [] });
    }
  };

  const websiteForms = {
    publicConfig(formId){
      if (root.LeadIntakeAPI?.forms?.publicConfig) return root.LeadIntakeAPI.forms.publicConfig(formId);
      return request(`/public/forms/${enc(formId)}`, { credentials: 'omit' });
    },
    availability(formId, date = ''){
      if (root.LeadIntakeAPI?.forms?.availability) return root.LeadIntakeAPI.forms.availability(formId, date);
      const suffix = date ? `?date=${enc(date)}` : '';
      return request(`/public/forms/${enc(formId)}/availability${suffix}`, { credentials: 'omit' });
    },
    submit(formId, payload = {}){
      if (root.LeadIntakeAPI?.forms?.submit) return root.LeadIntakeAPI.forms.submit(formId, payload);
      return request(`/public/forms/${enc(formId)}/submit`, {
        method: 'POST',
        credentials: 'omit',
        body: payload || {}
      });
    },
    async list(orgId, branchId = 'default'){
      if (root.LeadIntakeAPI?.forms?.list) return root.LeadIntakeAPI.forms.list(orgId, branchId);
      const result = await leadImport.get(orgId, branchId);
      return result?.settings?.website_forms || [];
    },
    async saveAll(orgId, branchId = 'default', forms = []){
      if (root.LeadIntakeAPI?.forms?.saveAll) return root.LeadIntakeAPI.forms.saveAll(orgId, branchId, forms);
      const result = await leadImport.patch(orgId, branchId, { website_forms: Array.isArray(forms) ? forms : [] });
      return result?.settings?.website_forms || [];
    }
  };

  const inbound = {
    postmark(payload = {}, options = {}){
      return request('/inbound/postmark', {
        method: 'POST',
        body: payload || {},
        headers: options.token ? { 'X-Email-Webhook-Token': options.token } : {}
      });
    }
  };

  const api = { configure, baseUrl, url, request, leadImport, websiteForms, inbound };
  configure({ baseUrl: APP.emailApiBase || '' });
  root.EmailAPI = api;
})();
