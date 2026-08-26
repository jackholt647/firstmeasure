/* libraries/payments-api/payments-api.js
 * Browser client for /v1/payments.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl: '', defaultHeaders: {} };

  function cleanText(value){ return String(value ?? '').trim(); }
  function enc(value){ return encodeURIComponent(cleanText(value)); }

  function defaultBaseUrl(){
    if (APP.paymentsApiBase) return cleanText(APP.paymentsApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return cleanText(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/payments').replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.protocol}//${location.hostname}:3111/v1/payments`;
    return `${location.origin}/v1/payments`;
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
      const error = new Error('Payments API is not configured for this frontend session.');
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
      const error = new Error(cleanText(data?.message || data?.error) || `Payments API request failed (${res.status})`);
      error.status = res.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  function orgPath(orgId, suffix = ''){
    return `/organizations/${enc(orgId)}${suffix}`;
  }

  const projects = {
    summary(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/money-summary`)); },
    schedules(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/payment-schedules`)); },
    obligations(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/obligations`)); },
    payments(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/payments`)); }
  };

  const payments = {
    create(orgId, payload = {}){ return request(orgPath(orgId, '/payments'), { method: 'POST', body: payload || {} }); },
    get(orgId, paymentId){ return request(orgPath(orgId, `/payments/${enc(paymentId)}`)); },
    refund(orgId, paymentId, payload = {}){ return request(orgPath(orgId, `/payments/${enc(paymentId)}/refunds`), { method: 'POST', body: payload || {} }); },
    reallocate(orgId, paymentId, payload = {}){ return request(orgPath(orgId, `/payments/${enc(paymentId)}/reallocate`), { method: 'POST', body: payload || {} }); }
  };

  const intents = {
    create(orgId, payload = {}){ return request(orgPath(orgId, '/payment-intents'), { method: 'POST', body: payload || {} }); },
    cancel(orgId, intentId){ return request(orgPath(orgId, `/payment-intents/${enc(intentId)}/cancel`), { method: 'POST', body: {} }); }
  };

  const payables = {
    list(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.project_id || options.projectId) params.set('project_id', cleanText(options.project_id || options.projectId));
      const qs = params.toString();
      return request(orgPath(orgId, `/payables${qs ? `?${qs}` : ''}`));
    },
    create(orgId, payload = {}){ return request(orgPath(orgId, '/payables'), { method: 'POST', body: payload || {} }); }
  };

  const disbursements = {
    create(orgId, payload = {}){ return request(orgPath(orgId, '/disbursements'), { method: 'POST', body: payload || {} }); }
  };

  const ledger = {
    list(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.project_id || options.projectId) params.set('project_id', cleanText(options.project_id || options.projectId));
      const qs = params.toString();
      return request(orgPath(orgId, `/ledger${qs ? `?${qs}` : ''}`));
    }
  };

  const events = {
    list(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.project_id || options.projectId) params.set('project_id', cleanText(options.project_id || options.projectId));
      const qs = params.toString();
      return request(orgPath(orgId, `/events${qs ? `?${qs}` : ''}`));
    }
  };

  const proposals = {
    syncSchedule(orgId, proposalId, payload = {}){ return request(orgPath(orgId, `/proposals/${enc(proposalId)}/sync-schedule`), { method: 'POST', body: payload || {} }); }
  };

  const api = { configure, baseUrl, url, request, projects, payments, intents, payables, disbursements, ledger, events, proposals };
  configure({ baseUrl: APP.paymentsApiBase || '' });
  root.PaymentsAPI = api;
})();
