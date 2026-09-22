/* public/libraries/sales-api/sales-api.js
 * Browser client for the salesperson Sales facade under /v1/workforce.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl:'', defaultHeaders:{} };

  const clean = (value) => String(value ?? '').trim();
  const enc = (value) => encodeURIComponent(clean(value));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  function defaultBaseUrl(){
    if (APP.workforceApiBase) return clean(APP.workforceApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return clean(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/workforce').replace(/\/+$/, '');
    const host = clean(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/workforce`;
    return `${location.origin}/v1/workforce`;
  }

  function configure(options = {}){
    if (options.baseUrl) state.baseUrl = clean(options.baseUrl).replace(/\/+$/, '');
    if (object(options.headers)) state.defaultHeaders = { ...state.defaultHeaders, ...options.headers };
    return api;
  }

  function baseUrl(){
    if (!state.baseUrl) state.baseUrl = defaultBaseUrl();
    return state.baseUrl;
  }

  function url(path = ''){
    const raw = clean(path);
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${baseUrl()}/${raw.replace(/^\/+/, '')}`;
  }

  function cookieValue(name){
    const target = `${encodeURIComponent(name)}=`;
    return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(target))?.slice(target.length) || '';
  }

  function csrfToken(){
    return decodeURIComponent(cookieValue('fm_platform_session_csrf') || '');
  }

  function requestHeaders(options, body){
    const method = clean(options.method || 'GET').toUpperCase();
    const headers = {
      Accept:'application/json',
      ...state.defaultHeaders,
      ...(body != null && !(body instanceof FormData) ? { 'Content-Type':'application/json' } : {}),
      ...object(options.headers)
    };
    const csrf = csrfToken();
    if (csrf && !['GET','HEAD','OPTIONS'].includes(method) && !headers['X-Platform-CSRF']) headers['X-Platform-CSRF'] = csrf;
    return headers;
  }

  async function request(path, options = {}){
    const inputBody = options.body;
    const body = inputBody == null || inputBody instanceof FormData || typeof inputBody === 'string'
      ? inputBody
      : JSON.stringify(inputBody);
    const response = await fetch(url(path), {
      ...options,
      body,
      cache:options.cache || 'no-store',
      credentials:options.credentials || 'include',
      headers:requestHeaders(options, inputBody)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!response.ok || data?.ok === false) {
      const error = new Error(clean(data?.message || data?.error) || `Sales API request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  function orgPath(orgId, suffix = ''){
    return `/organizations/${enc(orgId)}${suffix}`;
  }

  function queryString(values = {}){
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      if (Array.isArray(value)) value.forEach((item) => params.append(key, clean(item)));
      else params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : clean(value));
    });
    const query = params.toString();
    return query ? `?${query}` : '';
  }

  const me = {
    dashboard(orgId, date){ return request(orgPath(orgId, `/sales/me/dashboard${queryString({ date })}`)); },
    appointments(orgId, options = {}){
      return request(orgPath(orgId, `/sales/me/appointments${queryString({
        search:options.search,
        from:options.from,
        to:options.to
      })}`));
    },
    project(orgId, projectId){ return request(orgPath(orgId, `/sales/me/projects/${enc(projectId)}`)); }
  };

  const followups = {
    create(orgId, input = {}){ return request(orgPath(orgId, '/sales/me/followups'), { method:'POST', body:input }); },
    claim(orgId, nodeId){ return request(orgPath(orgId, `/sales/me/followups/${enc(nodeId)}/claim`), { method:'POST', body:{} }); },
    outcome(orgId, nodeId, input = {}){
      return request(orgPath(orgId, `/sales/me/followups/${enc(nodeId)}/outcome`), { method:'POST', body:input });
    }
  };

  const api = { configure, baseUrl, url, request, me, followups };
  configure({ baseUrl:APP.workforceApiBase || '' });
  root.SalesAPI = api;
})();
