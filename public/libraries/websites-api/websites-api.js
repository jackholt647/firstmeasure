/* libraries/websites-api/websites-api.js
 * Browser client for /v1/websites — the website builder ("Web Editor").
 *
 * Covers site + page CRUD, draft/publish/version lifecycle, live resolution
 * for editor previews, and the public (unauthenticated) site + customer
 * portal payload endpoints. See docs/web-builder-spec.md §2.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl: '', defaultHeaders: {} };

  function cleanText(value){ return String(value ?? '').trim(); }
  function enc(value){ return encodeURIComponent(cleanText(value)); }

  function defaultBaseUrl(){
    if (APP.websitesApiBase) return cleanText(APP.websitesApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return cleanText(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/websites').replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/websites`;
    return `${location.origin}/v1/websites`;
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
      const error = new Error('Websites API is not configured for this frontend session.');
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
      const error = new Error(cleanText(data?.message || data?.error) || `Websites API request failed (${res.status})`);
      error.status = res.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  function sitePath(orgId, siteId, suffix = ''){
    return `/organizations/${enc(orgId)}/sites/${enc(siteId)}${suffix}`;
  }
  function pagePath(orgId, siteId, pageId, suffix = ''){
    return sitePath(orgId, siteId, `/pages/${enc(pageId)}${suffix}`);
  }

  const sites = {
    list(orgId){ return request(`/organizations/${enc(orgId)}/sites`); },
    create(orgId, body = {}){ return request(`/organizations/${enc(orgId)}/sites`, { method: 'POST', body }); },
    get(orgId, siteId){ return request(sitePath(orgId, siteId)); },
    patch(orgId, siteId, patch = {}){ return request(sitePath(orgId, siteId), { method: 'PATCH', body: patch }); },
    archive(orgId, siteId){ return request(sitePath(orgId, siteId), { method: 'DELETE' }); },
    catalog(orgId, siteId){ return request(sitePath(orgId, siteId, '/catalog')); }
  };

  const pages = {
    create(orgId, siteId, body = {}){ return request(sitePath(orgId, siteId, '/pages'), { method: 'POST', body }); },
    get(orgId, siteId, pageId){ return request(pagePath(orgId, siteId, pageId)); },
    patch(orgId, siteId, pageId, patch = {}){ return request(pagePath(orgId, siteId, pageId), { method: 'PATCH', body: patch }); },
    remove(orgId, siteId, pageId){ return request(pagePath(orgId, siteId, pageId), { method: 'DELETE' }); },
    saveDraft(orgId, siteId, pageId, body = {}){ return request(pagePath(orgId, siteId, pageId, '/draft'), { method: 'PUT', body }); },
    publish(orgId, siteId, pageId, body = {}){ return request(pagePath(orgId, siteId, pageId, '/publish'), { method: 'POST', body }); },
    discardDraft(orgId, siteId, pageId, body = {}){ return request(pagePath(orgId, siteId, pageId, '/discard-draft'), { method: 'POST', body }); },
    restore(orgId, siteId, pageId, body = {}){ return request(pagePath(orgId, siteId, pageId, '/restore'), { method: 'POST', body }); },
    versions(orgId, siteId, pageId){ return request(pagePath(orgId, siteId, pageId, '/versions')); },
    version(orgId, siteId, pageId, version){ return request(pagePath(orgId, siteId, pageId, `/versions/${enc(version)}`)); },
    resolve(orgId, siteId, pageId, body = {}){ return request(pagePath(orgId, siteId, pageId, '/resolve'), { method: 'POST', body }); }
  };

  // Public site payloads (no auth; served by site_key from the host registry).
  const publicSite = {
    manifest(siteKey){ return request(`/public/site/${enc(siteKey)}/manifest`, { credentials: 'omit' }); },
    page(siteKey, slugOrRole){ return request(`/public/site/${enc(siteKey)}/page/${enc(slugOrRole)}`, { credentials: 'omit' }); }
  };

  // Customer-portal page injection payloads (no auth; keyed by portal uuid).
  const publicPortal = {
    pages(portalUuid){ return request(`/public/portal/${enc(portalUuid)}/pages`, { credentials: 'omit' }); },
    page(portalUuid, pageId){ return request(`/public/portal/${enc(portalUuid)}/pages/${enc(pageId)}`, { credentials: 'omit' }); }
  };

  const api = {
    configure,
    baseUrl,
    url,
    request,
    sites,
    pages,
    publicSite,
    publicPortal
  };

  root.WebsitesAPI = api;
})();
