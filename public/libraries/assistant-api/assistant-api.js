/* public/libraries/assistant-api/assistant-api.js
 * Browser client for the FirstMate Assistant v1 API: the global AI agent's
 * conversation threads and the company assistant settings.
 */
(function(){
  'use strict';

  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl:'', defaultHeaders:{} };
  const clean = (value) => String(value ?? '').trim();
  const enc = (value) => encodeURIComponent(clean(value));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  function defaultBaseUrl(){
    if (APP.assistantApiBase) return clean(APP.assistantApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return clean(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/assistant').replace(/\/+$/, '');
    const host = clean(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/assistant`;
    return `${location.origin}/v1/assistant`;
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

  function csrfToken(){
    const match = document.cookie.match(/(?:^|;\s*)fm_platform_session_csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  async function request(path, options = {}){
    const method = clean(options.method || 'GET').toUpperCase();
    const headers = { Accept:'application/json', ...state.defaultHeaders, ...object(options.headers) };
    let body = options.body;
    if (body !== undefined && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    if (method !== 'GET') {
      const token = csrfToken();
      if (token) headers['X-Platform-CSRF'] = token;
    }
    const response = await fetch(`${baseUrl()}/${clean(path).replace(/^\/+/, '')}`, {
      ...options,
      method,
      body,
      cache:options.cache || 'no-store',
      credentials:options.credentials || 'include',
      headers
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!response.ok || data?.ok === false) {
      const error = new Error(clean(data?.message || data?.error) || `Assistant API request failed (${response.status})`);
      error.status = response.status;
      error.code = clean(data?.error);
      error.data = data;
      throw error;
    }
    return data;
  }

  function orgPath(orgId, suffix){ return `organizations/${enc(orgId)}${suffix}`; }

  const api = {
    version:1,
    configure,
    baseUrl,
    context(orgId){ return request(orgPath(orgId, '/context')); },
    settings:{
      load(orgId){ return request(orgPath(orgId, '/settings')); },
      save(orgId, settings){ return request(orgPath(orgId, '/settings'), { method:'PUT', body:{ settings:object(settings) } }); }
    },
    threads(orgId){ return request(orgPath(orgId, '/threads')); },
    createThread(orgId, body){ return request(orgPath(orgId, '/threads'), { method:'POST', body:object(body) }); },
    thread(orgId, threadId){ return request(orgPath(orgId, `/threads/${enc(threadId)}`)); },
    send(orgId, threadId, body, options = {}){
      return request(orgPath(orgId, `/threads/${enc(threadId)}/messages`), { method:'POST', body:object(body), signal:options.signal });
    }
  };

  configure({ baseUrl:APP.assistantApiBase || '' });
  root.AssistantAPI = api;
})();
