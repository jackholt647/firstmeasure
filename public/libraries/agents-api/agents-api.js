/* public/libraries/agents-api/agents-api.js
 * Browser client for the centralized agent framework (/v1/agents): the agent
 * catalog, per-agent settings, usage, and the uniform thread surface every
 * registered agent shares.
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
    if (APP.agentsApiBase) return clean(APP.agentsApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return clean(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/agents').replace(/\/+$/, '');
    const host = clean(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/agents`;
    return `${location.origin}/v1/agents`;
  }

  function baseUrl(){
    if (!state.baseUrl) state.baseUrl = defaultBaseUrl();
    return state.baseUrl;
  }

  function csrfToken(){
    const sessionName = clean(APP.platformSessionCookieName || 'fm_platform_session');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionName)) return '';
    const cookieName = `${encodeURIComponent(sessionName + '_csrf')}=`;
    const cookie = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(cookieName));
    try { return cookie ? decodeURIComponent(cookie.slice(cookieName.length)) : ''; }
    catch (_) { return ''; }
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
      const error = new Error(clean(data?.message || data?.error) || `Agents API request failed (${response.status})`);
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
    baseUrl,
    catalog(orgId){ return request(orgPath(orgId, '/agents')); },
    participants(orgId){ return request(orgPath(orgId, '/participants')); },
    usage(orgId){ return request(orgPath(orgId, '/usage')); },
    settings:{
      load(orgId, agentId){ return request(orgPath(orgId, `/agents/${enc(agentId)}/settings`)); },
      save(orgId, agentId, settings){ return request(orgPath(orgId, `/agents/${enc(agentId)}/settings`), { method:'PUT', body:{ settings:object(settings) } }); }
    },
    threads(orgId, agentId, options = {}){
      const params = new URLSearchParams();
      if (options.subjectId !== undefined) params.set('subject_id', clean(options.subjectId));
      const query = params.toString();
      return request(orgPath(orgId, `/agents/${enc(agentId)}/threads${query ? `?${query}` : ''}`));
    },
    createThread(orgId, agentId, body){ return request(orgPath(orgId, `/agents/${enc(agentId)}/threads`), { method:'POST', body:object(body) }); },
    thread(orgId, agentId, threadId){ return request(orgPath(orgId, `/agents/${enc(agentId)}/threads/${enc(threadId)}`)); },
    send(orgId, agentId, threadId, body, options = {}){
      return request(orgPath(orgId, `/agents/${enc(agentId)}/threads/${enc(threadId)}/messages`), { method:'POST', body:object(body), signal:options.signal });
    }
  };

  root.AgentsAPI = api;
})();
