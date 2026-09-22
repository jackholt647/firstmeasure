/* libraries/communications-api/communications-api.js
 * Browser client for the organization-scoped Communications API.
 * Delivery transport is a backend concern; callers use the same surface in capture and live modes.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl:'', defaultHeaders:{} };

  function cleanText(value){ return String(value ?? '').trim(); }
  function enc(value){ return encodeURIComponent(cleanText(value)); }
  function defaultBaseUrl(){
    if (APP.messagingApiBase) return cleanText(APP.messagingApiBase).replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') return `${location.origin}/v1/messaging`;
    return `${location.origin}/v1/messaging`;
  }
  function configure(options = {}){
    if (options.baseUrl) state.baseUrl = cleanText(options.baseUrl).replace(/\/+$/, '');
    if (options.headers && typeof options.headers === 'object') state.defaultHeaders = { ...state.defaultHeaders, ...options.headers };
    return api;
  }
  function baseUrl(){ if (!state.baseUrl) state.baseUrl = defaultBaseUrl(); return state.baseUrl; }
  function url(path = ''){ return `${baseUrl()}/${cleanText(path).replace(/^\/+/, '')}`; }
  function cookieValue(name){
    const target = `${encodeURIComponent(name)}=`;
    return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(target))?.slice(target.length) || '';
  }
  function csrfToken(){ return decodeURIComponent(cookieValue('fm_platform_session_csrf') || ''); }
  function queryString(options = {}){
    const query = new URLSearchParams();
    Object.entries(options || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      query.set(key, String(value));
    });
    return query.toString();
  }
  async function request(path, options = {}){
    const method = cleanText(options.method || 'GET').toUpperCase();
    const body = options.body == null || typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    const csrf = csrfToken();
    const response = await fetch(url(path), {
      ...options,
      method,
      body,
      cache:options.cache || 'no-store',
      credentials:options.credentials || 'include',
      headers:{
        Accept:'application/json',
        ...state.defaultHeaders,
        ...(body ? {'Content-Type':'application/json'} : {}),
        ...(csrf && !['GET','HEAD','OPTIONS'].includes(method) ? {'X-Platform-CSRF':csrf} : {}),
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch(e) {}
    if (!response.ok || data?.ok === false) {
      const error = new Error(cleanText(data?.message || data?.error) || `Communications API request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  const capabilities = {
    get(orgId){ return request(`/organizations/${enc(orgId)}/capabilities`); }
  };
  const messages = {
    list(orgId, options = {}){
      const query = queryString(options);
      return request(`/organizations/${enc(orgId)}/messages${query ? `?${query}` : ''}`);
    },
    get(orgId, messageId){ return request(`/organizations/${enc(orgId)}/messages/${enc(messageId)}`); },
    send(orgId, input = {}){
      return request(`/organizations/${enc(orgId)}/messages`, { method:'POST', body:input });
    },
    sendSms(orgId, input = {}){
      return messages.send(orgId, {
        ...input,
        channel:'sms',
        recipients:Array.isArray(input.recipients) ? input.recipients : [{ address:input.to }],
        content:input.content || { text:input.text || input.body || '' }
      });
    },
    sendEmail(orgId, input = {}){
      return messages.send(orgId, {
        ...input,
        channel:'email',
        recipients:Array.isArray(input.recipients) ? input.recipients : [{ address:input.to }],
        content:input.content || { subject:input.subject || '', text:input.text || input.body || '', html:input.html || '' }
      });
    }
  };
  const conversations = {
    list(orgId, options = {}){
      const query = queryString(options);
      return request(`/organizations/${enc(orgId)}/conversations${query ? `?${query}` : ''}`);
    },
    get(orgId, conversationId){ return request(`/organizations/${enc(orgId)}/conversations/${enc(conversationId)}`); },
    create(orgId, input = {}){ return request(`/organizations/${enc(orgId)}/conversations`, { method:'POST', body:input }); },
    send(orgId, conversationId, input = {}){
      return request(`/organizations/${enc(orgId)}/conversations/${enc(conversationId)}/messages`, { method:'POST', body:input });
    }
  };
  const sms = {
    consents: {
      list(orgId, options = {}){
        const query = queryString(options);
        return request(`/organizations/${enc(orgId)}/sms/consents${query ? `?${query}` : ''}`);
      },
      record(orgId, input = {}){
        return request(`/organizations/${enc(orgId)}/sms/consents`, { method:'POST', body:input });
      }
    },
    usage(orgId, options = {}){
      const query = queryString(options);
      return request(`/organizations/${enc(orgId)}/sms/usage${query ? `?${query}` : ''}`);
    }
  };
  const developer = {
    testLogUrl(){ return url('/developer/test-messages'); }
  };

  const api = { configure, baseUrl, url, request, capabilities, messages, conversations, sms, developer };
  configure({ baseUrl:APP.messagingApiBase || '' });
  root.CommunicationsAPI = api;
})();
