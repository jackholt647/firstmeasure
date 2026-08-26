/* libraries/materials-api/materials-api.js
 * Browser client for /v1/materials.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl: '', defaultHeaders: {} };

  function cleanText(value){ return String(value ?? '').trim(); }
  function enc(value){ return encodeURIComponent(cleanText(value)); }

  function defaultBaseUrl(){
    if (APP.materialsApiBase) return cleanText(APP.materialsApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return cleanText(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/materials').replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.protocol}//${location.hostname}:3111/v1/materials`;
    return `${location.origin}/v1/materials`;
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
      const error = new Error('Materials API is not configured for this frontend session.');
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
      const error = new Error(cleanText(data?.message || data?.error) || `Materials API request failed (${res.status})`);
      error.status = res.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  function listPath(orgId, listId, suffix = ''){
    return `/organizations/${enc(orgId)}/material-lists/${enc(listId)}${suffix}`;
  }

  function orderPath(orgId, orderId, suffix = ''){
    return `/organizations/${enc(orgId)}/material-orders/${enc(orderId)}${suffix}`;
  }

  const projects = {
    list(orgId, projectId){
      return request(`/organizations/${enc(orgId)}/projects/${enc(projectId)}/material-lists`);
    },
    create(orgId, projectId, materialList = {}){
      return request(`/organizations/${enc(orgId)}/projects/${enc(projectId)}/material-lists`, {
        method: 'POST',
        body: materialList || {}
      });
    }
  };

  const lists = {
    get(orgId, listId){ return request(listPath(orgId, listId)); },
    patch(orgId, listId, patch = {}){ return request(listPath(orgId, listId), { method: 'PATCH', body: patch || {} }); },
    archive(orgId, listId, options = {}){ return request(listPath(orgId, listId), { method: 'DELETE', body: options || {} }); },
    versions(orgId, listId){ return request(listPath(orgId, listId, '/versions')); },
    createVersion(orgId, listId, version = {}){ return request(listPath(orgId, listId, '/versions'), { method: 'POST', body: version || {} }); },
    orders(orgId, listId){ return request(listPath(orgId, listId, '/orders')); },
    createOrder(orgId, listId, order = {}){ return request(listPath(orgId, listId, '/orders'), { method: 'POST', body: order || {} }); },
    events(orgId, listId){ return request(listPath(orgId, listId, '/events')); }
  };

  const orders = {
    get(orgId, orderId){ return request(orderPath(orgId, orderId)); },
    patch(orgId, orderId, patch = {}){ return request(orderPath(orgId, orderId), { method: 'PATCH', body: patch || {} }); },
    deliveries(orgId, orderId){ return request(orderPath(orgId, orderId, '/deliveries')); },
    recordDelivery(orgId, orderId, delivery = {}){ return request(orderPath(orgId, orderId, '/deliveries'), { method: 'POST', body: delivery || {} }); }
  };

  const deliveries = {
    patch(orgId, deliveryId, patch = {}){
      return request(`/organizations/${enc(orgId)}/material-deliveries/${enc(deliveryId)}`, { method: 'PATCH', body: patch || {} });
    }
  };

  const api = { configure, baseUrl, url, request, projects, lists, orders, deliveries };
  configure({ baseUrl: APP.materialsApiBase || '' });
  root.MaterialsAPI = api;
})();
