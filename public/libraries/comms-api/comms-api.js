/* public/libraries/comms-api/comms-api.js
 * Browser client for the Project Comms v1 API: the unified per-project
 * communications hub (email, SMS, portal chat, search, AI agent).
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
    if (APP.commsApiBase) return clean(APP.commsApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return clean(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/comms').replace(/\/+$/, '');
    const host = clean(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/comms`;
    return `${location.origin}/v1/comms`;
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
      const error = new Error(clean(data?.message || data?.error) || `Comms API request failed (${response.status})`);
      error.status = response.status;
      error.code = clean(data?.error);
      error.data = data;
      throw error;
    }
    return data;
  }

  function query(params){
    const usable = Object.entries(object(params)).filter(([, value]) => clean(value));
    if (!usable.length) return '';
    return `?${usable.map(([key, value]) => `${enc(key)}=${enc(value)}`).join('&')}`;
  }

  function projectPath(orgId, projectId, suffix = ''){
    return `organizations/${enc(orgId)}/projects/${enc(projectId)}${suffix}`;
  }

  const api = {
    version:1,
    configure,
    baseUrl,
    customer(orgId, path, body, method){
      return request(`organizations/${enc(orgId)}/${path}`, { method:method || (body === undefined ? 'GET' : 'POST'), ...(body === undefined ? {} : { body }) });
    },
    customerUrl(orgId, path){ return `${baseUrl()}/organizations/${enc(orgId)}/${path}`; },
    overview(orgId, projectId){ return request(projectPath(orgId, projectId, '/overview')); },
    feed(orgId, projectId, params){ return request(projectPath(orgId, projectId, '/feed') + query(params)); },
    // Org-wide (the global communications center)
    inbox(orgId, params){ return request(`organizations/${enc(orgId)}/inbox${query(params)}`); },
    orgFeed(orgId, params){ return request(`organizations/${enc(orgId)}/feed${query(params)}`); },
    conversation(orgId, conversationId){ return request(`organizations/${enc(orgId)}/conversations/${enc(conversationId)}`); },
    reply(orgId, conversationId, body){ return request(`organizations/${enc(orgId)}/conversations/${enc(conversationId)}/reply`, { method:'POST', body:object(body) }); },
    email:{
      threads(orgId, projectId){ return request(projectPath(orgId, projectId, '/email/threads')); },
      thread(orgId, projectId, conversationId){ return request(projectPath(orgId, projectId, `/email/threads/${enc(conversationId)}`)); },
      send(orgId, projectId, body){ return request(projectPath(orgId, projectId, '/email/send'), { method:'POST', body:object(body) }); }
    },
    sms:{
      conversation(orgId, projectId, conversationId){
        return request(projectPath(orgId, projectId, '/sms') + query({ conversation_id:conversationId }));
      },
      send(orgId, projectId, body){ return request(projectPath(orgId, projectId, '/sms/send'), { method:'POST', body:object(body) }); }
    },
    chat:{
      conversations(orgId, projectId){ return request(projectPath(orgId, projectId, '/chat')); },
      send(orgId, projectId, conversationId, body){
        return request(projectPath(orgId, projectId, `/chat/${enc(conversationId)}/messages`), { method:'POST', body:object(body) });
      }
    },
    search(orgId, params){ return request(`organizations/${enc(orgId)}/search${query(params)}`); },
    settings:{
      load(orgId){ return request(`organizations/${enc(orgId)}/settings`); },
      save(orgId, settings){ return request(`organizations/${enc(orgId)}/settings`, { method:'PUT', body:{ settings:object(settings) } }); },
      loadProject(orgId, projectId){ return request(projectPath(orgId, projectId, '/settings')); },
      saveProject(orgId, projectId, overrides){ return request(projectPath(orgId, projectId, '/settings'), { method:'PUT', body:{ overrides:object(overrides) } }); }
    },
    templates:{
      list(orgId, params){ return request(`organizations/${enc(orgId)}/templates${query(params)}`); },
      create(orgId, body){ return request(`organizations/${enc(orgId)}/templates`, { method:'POST', body:object(body) }); },
      update(orgId, templateId, body){ return request(`organizations/${enc(orgId)}/templates/${enc(templateId)}`, { method:'PUT', body:object(body) }); },
      remove(orgId, templateId){ return request(`organizations/${enc(orgId)}/templates/${enc(templateId)}`, { method:'DELETE' }); }
    },
    agent:{
      threads(orgId, projectId){ return request(projectPath(orgId, projectId, '/agent/threads')); },
      createThread(orgId, projectId){ return request(projectPath(orgId, projectId, '/agent/threads'), { method:'POST', body:{} }); },
      thread(orgId, projectId, threadId){ return request(projectPath(orgId, projectId, `/agent/threads/${enc(threadId)}`)); },
      send(orgId, projectId, threadId, body, options = {}){
        return request(projectPath(orgId, projectId, `/agent/threads/${enc(threadId)}/messages`), { method:'POST', body:object(body), signal:options.signal });
      }
    },
    autoReplies:{
      list(orgId, projectId, params){ return request(projectPath(orgId, projectId, '/auto-replies') + query(params)); },
      send(orgId, projectId, autoReplyId){ return request(projectPath(orgId, projectId, `/auto-replies/${enc(autoReplyId)}/send`), { method:'POST', body:{} }); },
      dismiss(orgId, projectId, autoReplyId){ return request(projectPath(orgId, projectId, `/auto-replies/${enc(autoReplyId)}/dismiss`), { method:'POST', body:{} }); }
    },
    simulateInbound(orgId, projectId, body){ return request(projectPath(orgId, projectId, '/simulate-inbound'), { method:'POST', body:object(body) }); }
  };

  configure({ baseUrl:APP.commsApiBase || '' });
  root.CommsAPI = api;
})();
