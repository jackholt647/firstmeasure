/* public/libraries/stats-api/stats-api.js
 * Browser client for the FirstMate Stats v1 API: schema, cached metric
 * queries, dashboard views, presets, sync, and the stats agent.
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
    if (APP.statsApiBase) return clean(APP.statsApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return clean(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/stats').replace(/\/+$/, '');
    const host = clean(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/stats`;
    return `${location.origin}/v1/stats`;
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

  function queryString(values = {}){
    const params = new URLSearchParams();
    Object.entries(object(values)).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : clean(value));
    });
    const query = params.toString();
    return query ? `?${query}` : '';
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
      const error = new Error(clean(data?.message || data?.error) || `Stats API request failed (${response.status})`);
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
    schema(orgId){ return request(orgPath(orgId, '/schema')); },
    // queries: { name: metricSpec, ... } — results come back cached when possible.
    query(orgId, queries, options = {}){
      return request(orgPath(orgId, '/query'), { method:'POST', body:{ queries, ...object(options) } });
    },
    views:{
      list(orgId){ return request(orgPath(orgId, '/views')); },
      get(orgId, viewId){ return request(orgPath(orgId, `/views/${enc(viewId)}`)); },
      create(orgId, body){ return request(orgPath(orgId, '/views'), { method:'POST', body:object(body) }); },
      save(orgId, viewId, body){ return request(orgPath(orgId, `/views/${enc(viewId)}`), { method:'PUT', body:object(body) }); },
      remove(orgId, viewId){ return request(orgPath(orgId, `/views/${enc(viewId)}`), { method:'DELETE' }); },
      fromPreset(orgId, presetId){ return request(orgPath(orgId, '/views'), { method:'POST', body:{ preset_id:presetId } }); }
    },
    presets(orgId){ return request(orgPath(orgId, '/presets')); },
    sync:{
      status(orgId){ return request(orgPath(orgId, '/sync')); },
      refresh(orgId){ return request(orgPath(orgId, '/sync'), { method:'POST' }); }
    },
    agent:{
      threads(orgId, options = {}){ return request(`${orgPath(orgId, '/agent/threads')}${queryString(options)}`); },
      createThread(orgId, body){ return request(orgPath(orgId, '/agent/threads'), { method:'POST', body:object(body) }); },
      thread(orgId, threadId){ return request(orgPath(orgId, `/agent/threads/${enc(threadId)}`)); },
      send(orgId, threadId, body, options = {}){
        return request(orgPath(orgId, `/agent/threads/${enc(threadId)}/messages`), { method:'POST', body:object(body), signal:options.signal });
      }
    }
  };

  configure({ baseUrl:APP.statsApiBase || '' });
  root.StatsAPI = api;
})();
