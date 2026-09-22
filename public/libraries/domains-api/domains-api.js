/* Browser client for /v1/domains. Provider credentials never enter the browser. */
(function(){
  if (window.DomainsAPI) return;
  const state = { baseUrl:'' };
  const clean = (value) => String(value ?? '').trim();
  const enc = (value) => encodeURIComponent(clean(value));

  function baseUrl(){
    if (state.baseUrl) return state.baseUrl;
    const configured = clean(window.__APP?.domainsApiBase);
    const platform = clean(window.PlatformAPI?.baseUrl?.() || window.__APP?.platformApiBase);
    if (configured) state.baseUrl = configured.replace(/\/+$/, '');
    else if (platform) state.baseUrl = platform.replace(/\/+$/, '').replace(/\/v1\/platform$/i, '/v1/domains');
    else if (['localhost', '127.0.0.1', '10.0.2.2'].includes(clean(location.hostname).toLowerCase())) {
      state.baseUrl = `${location.origin}/v1/domains`;
    } else state.baseUrl = `${location.origin}/v1/domains`;
    return state.baseUrl;
  }

  function cookieValue(name){
    const target = `${encodeURIComponent(name)}=`;
    return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(target))?.slice(target.length) || '';
  }

  async function request(path, options = {}){
    const method = clean(options.method || 'GET').toUpperCase();
    const body = options.body == null || typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    const headers = {
      Accept:'application/json',
      ...(body ? { 'Content-Type':'application/json' } : {}),
      ...(options.headers || {})
    };
    const csrf = decodeURIComponent(cookieValue('fm_platform_session_csrf') || '');
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-Platform-CSRF'] = csrf;
    const response = await fetch(`${baseUrl()}/${clean(path).replace(/^\/+/, '')}`, {
      method,
      body,
      headers,
      cache:'no-store',
      credentials:'include'
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_error) {}
    if (!response.ok || data?.ok === false) {
      const error = new Error(clean(data?.message || data?.error) || `Domain request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  const orgPath = (orgId, suffix = '') => `organizations/${enc(orgId)}${suffix}`;
  window.DomainsAPI = {
    configure(options = {}) {
      if (options.baseUrl) state.baseUrl = clean(options.baseUrl).replace(/\/+$/, '');
      return this;
    },
    config:() => request('config'),
    list:(orgId) => request(orgPath(orgId)),
    quote:(orgId, domains, period = 1, acquisitionType = 'register') => request(orgPath(orgId, '/quotes'), {
      method:'POST',
      body:{ domains, period, acquisition_type:acquisitionType }
    }),
    register:(orgId, payload) => request(orgPath(orgId, '/registrations'), {
      method:'POST',
      body:payload
    }),
    transfer:(orgId, payload) => request(orgPath(orgId, '/transfers'), { method:'POST', body:payload }),
    connect:(orgId, domain) => request(orgPath(orgId, '/connections'), {
      method:'POST',
      body:{ domain, attestation:true }
    }),
    checkVerification:(orgId, domain) => request(orgPath(orgId, `/domains/${enc(domain)}/verification/check`), { method:'POST', body:{} }),
    resendVerification:(orgId, domain) => request(orgPath(orgId, `/domains/${enc(domain)}/verification/resend`), { method:'POST', body:{} }),
    attachResources:(orgId, domain, payload) => request(orgPath(orgId, `/domains/${enc(domain)}/resources`), { method:'POST', body:payload }),
    updateManagement:(orgId, domain, payload) => request(orgPath(orgId, `/domains/${enc(domain)}/management`), { method:'PATCH', body:payload }),
    requestTransferOut:(orgId, domain) => request(orgPath(orgId, `/domains/${enc(domain)}/transfer-out`), { method:'POST', body:{attestation:true} }),
    disconnect:(orgId, domain) => request(orgPath(orgId, `/domains/${enc(domain)}/disconnect`), { method:'POST', body:{attestation:true} })
  };
})();
