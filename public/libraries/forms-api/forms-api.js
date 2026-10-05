/* libraries/forms-api/forms-api.js
 * Authenticated browser client for /v1/forms: the forms library, the form
 * editor's draft preview transport, publishing and submissions.
 *
 * The public embed (libraries/forms-embed) talks to /v1/forms/public/* on its
 * own and never loads this file.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl: '' };

  function cleanText(value){ return String(value ?? '').trim(); }

  function baseUrl(){
    if (!state.baseUrl) state.baseUrl = cleanText(APP.formsApiBase || `${location.origin}/v1/forms`).replace(/\/+$/, '');
    return state.baseUrl;
  }

  function configure(options = {}){
    if (options.baseUrl) state.baseUrl = cleanText(options.baseUrl).replace(/\/+$/, '');
    return api;
  }

  function cookieValue(name){
    const target = `${encodeURIComponent(name)}=`;
    return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(target))?.slice(target.length) || '';
  }

  function csrfToken(){
    const sessionName = cleanText(APP.platformSessionCookieName || 'fm_platform_session');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionName)) return '';
    try {
      return decodeURIComponent(cookieValue(sessionName + '_csrf') || '');
    } catch {
      return '';
    }
  }

  async function request(path, options = {}){
    const method = cleanText(options.method || 'GET').toUpperCase();
    const headers = { Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    const csrf = csrfToken();
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-Platform-CSRF'] = csrf;
    const res = await fetch(`${baseUrl()}/${cleanText(path).replace(/^\/+/, '')}`, {
      method,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      credentials: 'include',
      headers
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch(e) {}
    if (!res.ok || data?.ok === false) {
      const error = new Error(cleanText(data?.message || data?.error) || `Forms request failed (${res.status})`);
      error.status = res.status;
      error.code = cleanText(data?.error);
      error.data = data;
      throw error;
    }
    return data;
  }

  const enc = (value) => encodeURIComponent(cleanText(value));
  const org = (orgId) => `organizations/${enc(orgId)}`;

  const api = {
    configure,
    baseUrl,
    request,
    context: (orgId) => request(`${org(orgId)}/context`),
    list: (orgId) => request(`${org(orgId)}/forms`).then((data) => data.forms || []),
    get: (orgId, formId) => request(`${org(orgId)}/forms/${enc(formId)}`).then((data) => data.form),
    create: (orgId, input = {}) => request(`${org(orgId)}/forms`, { method: 'POST', body: input }).then((data) => data.form),
    update: (orgId, formId, patch = {}) => request(`${org(orgId)}/forms/${enc(formId)}`, { method: 'PATCH', body: patch }).then((data) => data.form),
    publish: (orgId, formId, expectedRevision) => request(`${org(orgId)}/forms/${enc(formId)}/publish`, { method: 'POST', body: expectedRevision ? { expected_revision: expectedRevision } : {} }).then((data) => data.form),
    duplicate: (orgId, formId) => request(`${org(orgId)}/forms/${enc(formId)}/duplicate`, { method: 'POST', body: {} }).then((data) => data.form),
    remove: (orgId, formId) => request(`${org(orgId)}/forms/${enc(formId)}`, { method: 'DELETE' }),
    rotateKey: (orgId, formId) => request(`${org(orgId)}/forms/${enc(formId)}/rotate-key`, { method: 'POST', body: {} }).then((data) => data.form),
    submissions: (orgId, formId) => request(`${org(orgId)}/forms/${enc(formId)}/submissions`).then((data) => data.submissions || []),
    /** Transport the embed uses to run an unsaved draft inside the editor. */
    preview: {
      measurement: (orgId, input) => request(`${org(orgId)}/preview/measurement`, { method: 'POST', body: input }),
      availability: (orgId, input) => request(`${org(orgId)}/preview/availability`, { method: 'POST', body: input }),
      submit: (orgId, input) => request(`${org(orgId)}/preview/submit`, { method: 'POST', body: input })
    }
  };

  root.FormsAPI = api;
})();
