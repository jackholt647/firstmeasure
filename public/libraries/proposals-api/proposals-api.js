/* libraries/proposals-api/proposals-api.js
 * Browser client for /v1/proposals.
 *
 * Proposal UI should use this client for proposal records, snapshots,
 * sending, signing, and generated PDFs. Project/customer/media data remains
 * Platform-owned and is referenced by id/media references.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl: '', defaultHeaders: {} };

  function cleanText(value){ return String(value ?? '').trim(); }
  function enc(value){ return encodeURIComponent(cleanText(value)); }

  function defaultBaseUrl(){
    if (APP.proposalsApiBase) return cleanText(APP.proposalsApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return cleanText(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/proposals').replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.protocol}//${location.hostname}:3111/v1/proposals`;
    return `${location.origin}/v1/proposals`;
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
      const error = new Error('Proposals API is not configured for this frontend session.');
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
      const error = new Error(cleanText(data?.message || data?.error) || `Proposals API request failed (${res.status})`);
      error.status = res.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  function proposalPath(orgId, proposalId, suffix = ''){
    return `/organizations/${enc(orgId)}/proposals/${enc(proposalId)}${suffix}`;
  }

  const projects = {
    list(orgId, projectId){
      return request(`/organizations/${enc(orgId)}/projects/${enc(projectId)}/proposals`);
    },
    create(orgId, projectId, proposal = {}){
      return request(`/organizations/${enc(orgId)}/projects/${enc(projectId)}/proposals`, {
        method: 'POST',
        body: proposal || {}
      });
    }
  };

  const proposals = {
    get(orgId, proposalId){ return request(proposalPath(orgId, proposalId)); },
    patch(orgId, proposalId, patch = {}){ return request(proposalPath(orgId, proposalId), { method: 'PATCH', body: patch || {} }); },
    duplicate(orgId, proposalId, options = {}){ return request(proposalPath(orgId, proposalId, '/duplicate'), { method: 'POST', body: options || {} }); },
    archive(orgId, proposalId, options = {}){ return request(proposalPath(orgId, proposalId), { method: 'DELETE', body: options || {} }); },
    delete(orgId, proposalId, options = {}){ return proposals.archive(orgId, proposalId, options); },
    snapshots(orgId, proposalId){ return request(proposalPath(orgId, proposalId, '/snapshots')); },
    createSnapshot(orgId, proposalId, snapshot = {}){ return request(proposalPath(orgId, proposalId, '/snapshots'), { method: 'POST', body: snapshot || {} }); },
    send(orgId, proposalId, options = {}){ return request(proposalPath(orgId, proposalId, '/send'), { method: 'POST', body: options || {} }); },
    generatePdf(orgId, proposalId, options = {}){ return request(proposalPath(orgId, proposalId, '/pdf'), { method: 'POST', body: options || {} }); },
    pdfUrl(orgId, proposalId, options = {}){
      const mediaId = cleanText(options.media_id || options.mediaId);
      const suffix = mediaId ? `?media_id=${enc(mediaId)}` : '';
      return url(proposalPath(orgId, proposalId, `/pdf${suffix}`));
    },
    events(orgId, proposalId){ return request(proposalPath(orgId, proposalId, '/events')); }
  };

  const publicAccess = {
    get(token){ return request(`/public/${enc(token)}`, { credentials: 'same-origin' }); },
    appUrl(token){ return url(`/public/${enc(token)}/app`); },
    pdfUrl(token){ return url(`/public/${enc(token)}/pdf`); },
    view(token, event = {}){ return request(`/public/${enc(token)}/view`, { method: 'POST', credentials: 'same-origin', body: event || {} }); },
    adopt(token, payload = {}){ return request(`/public/${enc(token)}/esign/adopt`, { method: 'POST', credentials: 'same-origin', body: payload || {} }); },
    signSlot(token, payload = {}){ return request(`/public/${enc(token)}/esign/slot`, { method: 'POST', credentials: 'same-origin', body: payload || {} }); },
    complete(token, payload = {}){ return request(`/public/${enc(token)}/esign/complete`, { method: 'POST', credentials: 'same-origin', body: payload || {} }); },
    payLater(token, payload = {}){ return request(`/public/${enc(token)}/pay-later`, { method: 'POST', credentials: 'same-origin', body: payload || {} }); },
    mockDeposit(token, payload = {}){ return request(`/public/${enc(token)}/payments/mock-deposit`, { method: 'POST', credentials: 'same-origin', body: payload || {} }); },
    sign(token, payload = {}){ return request(`/public/${enc(token)}/sign`, { method: 'POST', credentials: 'same-origin', body: payload || {} }); }
  };

  const api = { configure, baseUrl, url, request, projects, proposals, public: publicAccess };
  configure({ baseUrl: APP.proposalsApiBase || '' });
  root.ProposalsAPI = api;
})();
