/* Reusable browser client for the FirstMate Calls control plane. */
(function(){
  const root = window;
  if (root.CallsAPI) return;
  const APP = root.__APP || {};
  const state = { baseUrl:'' };
  const clean = (value) => String(value ?? '').trim();
  const enc = (value) => encodeURIComponent(clean(value));

  function defaultBaseUrl(){
    if (APP.callsApiBase) return clean(APP.callsApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return clean(APP.platformApiBase).replace(/\/+$/, '').replace(/\/v1\/platform$/, '/v1/calls');
    const host = clean(location.hostname).toLowerCase();
    if (['127.0.0.1', 'localhost', '10.0.2.2'].includes(host)) {
      return `${location.origin}/v1/calls`;
    }
    return `${location.origin}/v1/calls`;
  }

  function baseUrl(){
    if (!state.baseUrl) state.baseUrl = defaultBaseUrl();
    return state.baseUrl;
  }

  function csrfToken(){
    const prefix = 'fm_platform_session_csrf=';
    const value = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
    return value ? decodeURIComponent(value.slice(prefix.length)) : '';
  }

  async function request(path, options = {}){
    const method = clean(options.method || 'GET').toUpperCase();
    const headers = { Accept:'application/json', ...(options.body == null ? {} : { 'Content-Type':'application/json' }) };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken()) headers['X-Platform-CSRF'] = csrfToken();
    const response = await fetch(`${baseUrl()}/${clean(path).replace(/^\/+/, '')}`, {
      method,
      headers,
      body: options.body == null ? undefined : JSON.stringify(options.body),
      credentials:'include',
      cache:'no-store'
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!response.ok || data?.ok === false) {
      const error = new Error(clean(data?.message || data?.error) || `Calls API request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  const orgPath = (orgId, suffix = '') => `organizations/${enc(orgId)}${suffix}`;
  const api = {
    configure(options = {}){
      if (options.baseUrl) state.baseUrl = clean(options.baseUrl).replace(/\/+$/, '');
      return api;
    },
    status: () => request('provider-status'),
    rooms: {
      create: (orgId, input) => request(orgPath(orgId, '/rooms'), { method:'POST', body:input }),
      get: (orgId, roomId) => request(orgPath(orgId, `/rooms/${enc(roomId)}`)),
      join: (orgId, roomId) => request(orgPath(orgId, `/rooms/${enc(roomId)}/join`), { method:'POST', body:{} }),
      leave: (orgId, roomId) => request(orgPath(orgId, `/rooms/${enc(roomId)}/leave`), { method:'POST', body:{} }),
      end: (orgId, roomId) => request(orgPath(orgId, `/rooms/${enc(roomId)}/end`), { method:'POST', body:{} }),
      mediaState: (orgId, roomId, input) => request(orgPath(orgId, `/rooms/${enc(roomId)}/media-state`), { method:'PATCH', body:input }),
      artifacts: (orgId, roomId) => request(orgPath(orgId, `/rooms/${enc(roomId)}/artifacts`)),
      saveArtifact: (orgId, roomId, input) => request(orgPath(orgId, `/rooms/${enc(roomId)}/artifacts`), { method:'POST', body:input }),
      signal: (orgId, roomId, input) => request(orgPath(orgId, `/rooms/${enc(roomId)}/signals`), { method:'POST', body:input }),
      signals: (orgId, roomId, peerId, after = 0) => request(orgPath(orgId, `/rooms/${enc(roomId)}/signals?peer_id=${enc(peerId)}&after=${Number(after) || 0}`))
    },
    events: (orgId, options = {}) => {
      const query = new URLSearchParams();
      if (options.roomId) query.set('room_id', clean(options.roomId));
      if (options.limit) query.set('limit', String(options.limit));
      return request(orgPath(orgId, `/events${query.size ? `?${query}` : ''}`));
    }
  };

  root.CallsAPI = api;
})();
