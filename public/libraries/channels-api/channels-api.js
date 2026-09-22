/* libraries/channels-api/channels-api.js
 * Browser client for /v1/channels — internal team messaging (channels, threads,
 * reactions, DMs, project messages).
 *
 * Keep all channels URL construction and JSON request handling here; UI code
 * (channels-ui, apps) should call ChannelsAPI rather than fetch directly.
 */
(function(){
  const root = window;
  if (root.ChannelsAPI) return;
  const APP = root.__APP || {};

  const state = { baseUrl: '' };

  function cleanText(value){
    return String(value ?? '').trim();
  }

  function defaultBaseUrl(){
    if (APP.channelsApiBase) return cleanText(APP.channelsApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return cleanText(APP.platformApiBase).replace(/\/+$/, '').replace(/\/v1\/platform$/, '/v1/channels');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
      return `${location.origin}/v1/channels`;
    }
    return `${location.origin}/v1/channels`;
  }

  function baseUrl(){
    if (!state.baseUrl) state.baseUrl = defaultBaseUrl();
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
    return decodeURIComponent(cookieValue('fm_platform_session_csrf') || '');
  }

  async function request(path, options = {}){
    const method = cleanText(options.method || 'GET').toUpperCase();
    const isForm = options.body instanceof FormData;
    const body = options.body == null || isForm || typeof options.body === 'string'
      ? options.body
      : JSON.stringify(options.body);
    const headers = {
      Accept: 'application/json',
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    };
    const csrf = csrfToken();
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-Platform-CSRF'] = csrf;
    const res = await fetch(`${baseUrl()}/${cleanText(path).replace(/^\/+/, '')}`, {
      method,
      body,
      headers,
      cache: 'no-store',
      credentials: 'include'
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok || data?.ok === false) {
      const error = new Error(cleanText(data?.message || data?.error) || `Channels API request failed (${res.status})`);
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  const enc = (value) => encodeURIComponent(cleanText(value));
  const orgPath = (orgId, suffix = '') => `organizations/${enc(orgId)}${suffix}`;

  function queryString(params = {}){
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
    const encoded = search.toString();
    return encoded ? `?${encoded}` : '';
  }

  const api = {
    configure,
    baseUrl,
    request,

    directory: {
      list: (orgId) => request(orgPath(orgId, '/directory'))
    },

    channels: {
      list: (orgId, params = {}) => request(orgPath(orgId, `/channels${queryString(params)}`)),
      create: (orgId, input) => request(orgPath(orgId, '/channels'), { method: 'POST', body: input }),
      get: (orgId, channelId) => request(orgPath(orgId, `/channels/${enc(channelId)}`)),
      update: (orgId, channelId, patch) => request(orgPath(orgId, `/channels/${enc(channelId)}`), { method: 'PATCH', body: patch }),
      archive: (orgId, channelId) => request(orgPath(orgId, `/channels/${enc(channelId)}/archive`), { method: 'POST' }),
      unarchive: (orgId, channelId) => request(orgPath(orgId, `/channels/${enc(channelId)}/unarchive`), { method: 'POST' }),
      ensureProject: (orgId, projectId) => request(orgPath(orgId, `/channels/project/${enc(projectId)}`), { method: 'POST' }),
      addMembers: (orgId, channelId, userIds) => request(orgPath(orgId, `/channels/${enc(channelId)}/members`), { method: 'POST', body: { user_ids: userIds } }),
      removeMember: (orgId, channelId, userId) => request(orgPath(orgId, `/channels/${enc(channelId)}/members/${enc(userId)}`), { method: 'DELETE' }),
      setNotifyLevel: (orgId, channelId, userId, level) => request(orgPath(orgId, `/channels/${enc(channelId)}/members/${enc(userId)}`), { method: 'PATCH', body: { notify_level: level } })
    },

    messages: {
      list: (orgId, channelId, params = {}) => request(orgPath(orgId, `/channels/${enc(channelId)}/messages${queryString(params)}`)),
      post: (orgId, channelId, input) => request(orgPath(orgId, `/channels/${enc(channelId)}/messages`), { method: 'POST', body: input }),
      get: (orgId, messageId) => request(orgPath(orgId, `/messages/${enc(messageId)}`)),
      edit: (orgId, messageId, input) => request(orgPath(orgId, `/messages/${enc(messageId)}`), { method: 'PATCH', body: input }),
      remove: (orgId, messageId) => request(orgPath(orgId, `/messages/${enc(messageId)}`), { method: 'DELETE' }),
      restore: (orgId, messageId) => request(orgPath(orgId, `/messages/${enc(messageId)}/restore`), { method: 'POST' }),
      revisions: (orgId, messageId) => request(orgPath(orgId, `/messages/${enc(messageId)}/revisions`)),
      translate: (orgId, messageId) => request(orgPath(orgId, `/messages/${enc(messageId)}/translation`), { method: 'POST' }),
      thread: (orgId, messageId, params = {}) => request(orgPath(orgId, `/messages/${enc(messageId)}/thread${queryString(params)}`)),
      react: (orgId, messageId, emoji, on = true) => request(orgPath(orgId, `/messages/${enc(messageId)}/reactions`), { method: 'PUT', body: { emoji, on } }),
      pin: (orgId, messageId) => request(orgPath(orgId, `/messages/${enc(messageId)}/pin`), { method: 'POST' }),
      unpin: (orgId, messageId) => request(orgPath(orgId, `/messages/${enc(messageId)}/unpin`), { method: 'POST' })
    },

    preferences: {
      get: (orgId) => request(orgPath(orgId, '/preferences')),
      collaboration: (orgId) => request(orgPath(orgId, '/collaboration-preferences')),
      updateCollaboration: (orgId, patch) => request(orgPath(orgId, '/collaboration-preferences'), { method: 'PATCH', body: patch })
    },

    pins: {
      list: (orgId, channelId) => request(orgPath(orgId, `/channels/${enc(channelId)}/pins`))
    },

    saved: {
      list: (orgId) => request(orgPath(orgId, '/saved')),
      add: (orgId, messageId) => request(orgPath(orgId, `/saved/${enc(messageId)}`), { method: 'PUT' }),
      remove: (orgId, messageId) => request(orgPath(orgId, `/saved/${enc(messageId)}`), { method: 'DELETE' })
    },

    readState: {
      markRead: (orgId, channelId, lastReadSeq) => request(orgPath(orgId, `/channels/${enc(channelId)}/read`), { method: 'POST', body: { last_read_seq: lastReadSeq } }),
      markUnread: (orgId, channelId, seq) => request(orgPath(orgId, `/channels/${enc(channelId)}/unread`), { method: 'POST', body: { seq } }),
      markAllRead: (orgId) => request(orgPath(orgId, '/read-all'), { method: 'POST', body: {} }),
      undo: (orgId, operationId) => request(orgPath(orgId, `/read-operations/${enc(operationId)}/undo`), { method: 'POST', body: {} }),
      unreads: (orgId) => request(orgPath(orgId, '/unreads')),
      messages: (orgId, params = {}) => request(orgPath(orgId, `/unreads/messages${queryString(params)}`)),
      inbox: (orgId, params = {}) => request(orgPath(orgId, `/inbox${params.limit ? `?limit=${encodeURIComponent(params.limit)}` : ''}`)),
      inboxSeen: (orgId) => request(orgPath(orgId, '/inbox/seen'), { method:'POST', body:{} })
    },

    activity: {
      list: (orgId, params = {}) => request(orgPath(orgId, `/activity${queryString(params)}`)),
      update: (orgId, itemId, patch) => request(orgPath(orgId, `/activity/${enc(itemId)}`), { method:'PATCH', body:patch }),
      readAll: (orgId) => request(orgPath(orgId, '/activity/read-all'), { method:'POST', body:{} })
    },

    threads: {
      list: (orgId) => request(orgPath(orgId, '/threads')),
      subscribe: (orgId, rootMessageId, following = true, notifyLevel = 'all') => request(
        orgPath(orgId, `/threads/${enc(rootMessageId)}/subscription`),
        { method:'PUT', body:{ following, notify_level:notifyLevel } }
      ),
      markRead: (orgId, rootMessageId, lastReplySeq) => request(
        orgPath(orgId, `/threads/${enc(rootMessageId)}/read`),
        { method:'POST', body:{ last_reply_seq:lastReplySeq } }
      )
    },

    drafts: {
      get: (orgId, draftKey) => request(orgPath(orgId, `/drafts/${enc(draftKey)}`)),
      save: (orgId, draftKey, input) => request(orgPath(orgId, `/drafts/${enc(draftKey)}`), { method:'PUT', body:input }),
      remove: (orgId, draftKey) => request(orgPath(orgId, `/drafts/${enc(draftKey)}`), { method:'DELETE' })
    },

    scheduled: {
      list: (orgId) => request(orgPath(orgId, '/scheduled-messages')),
      create: (orgId, input) => request(orgPath(orgId, '/scheduled-messages'), { method:'POST', body:input }),
      update: (orgId, scheduledId, patch) => request(orgPath(orgId, `/scheduled-messages/${enc(scheduledId)}`), { method:'PATCH', body:patch }),
      remove: (orgId, scheduledId) => request(orgPath(orgId, `/scheduled-messages/${enc(scheduledId)}`), { method:'DELETE' })
    },

    reminders: {
      list: (orgId) => request(orgPath(orgId, '/reminders')),
      create: (orgId, messageId, remindAt) => request(orgPath(orgId, `/messages/${enc(messageId)}/reminders`), { method:'POST', body:{ remind_at:remindAt } }),
      remove: (orgId, reminderId) => request(orgPath(orgId, `/reminders/${enc(reminderId)}`), { method:'DELETE' })
    },

    tabs: {
      list: (orgId, channelId) => request(orgPath(orgId, `/channels/${enc(channelId)}/tabs`)),
      create: (orgId, channelId, input) => request(orgPath(orgId, `/channels/${enc(channelId)}/tabs`), { method:'POST', body:input }),
      update: (orgId, channelId, tabId, patch) => request(orgPath(orgId, `/channels/${enc(channelId)}/tabs/${enc(tabId)}`), { method:'PATCH', body:patch }),
      remove: (orgId, channelId, tabId) => request(orgPath(orgId, `/channels/${enc(channelId)}/tabs/${enc(tabId)}`), { method:'DELETE' })
    },

    folders: {
      list: (orgId, channelId) => request(orgPath(orgId, `/channels/${enc(channelId)}/folders`)),
      create: (orgId, channelId, input) => request(orgPath(orgId, `/channels/${enc(channelId)}/folders`), { method:'POST', body:input }),
      update: (orgId, channelId, folderId, patch) => request(orgPath(orgId, `/channels/${enc(channelId)}/folders/${enc(folderId)}`), { method:'PATCH', body:patch }),
      remove: (orgId, channelId, folderId) => request(orgPath(orgId, `/channels/${enc(channelId)}/folders/${enc(folderId)}`), { method:'DELETE' })
    },

    resources: {
      list: (orgId, channelId, params = {}) => request(orgPath(orgId, `/channels/${enc(channelId)}/resources${queryString(params)}`)),
      add: (orgId, channelId, input) => request(orgPath(orgId, `/channels/${enc(channelId)}/resources`), { method:'POST', body:input }),
      remove: (orgId, channelId, refId) => request(orgPath(orgId, `/channels/${enc(channelId)}/resources/${enc(refId)}`), { method:'DELETE' })
    },

    todos: {
      fromMessage: (orgId, messageId, input = {}) => request(orgPath(orgId, `/messages/${enc(messageId)}/action-items`), { method:'POST', body:input })
    },

    sidebarSections: {
      list: (orgId) => request(orgPath(orgId, '/sidebar-sections')),
      save: (orgId, sectionId, input) => request(orgPath(orgId, `/sidebar-sections/${enc(sectionId)}`), { method:'PUT', body:input }),
      remove: (orgId, sectionId) => request(orgPath(orgId, `/sidebar-sections/${enc(sectionId)}`), { method:'DELETE' })
    },

    huddles: {
      removeParticipant: (orgId, huddleId, userId) => request(orgPath(orgId, `/huddles/${enc(huddleId)}/participants/${enc(userId)}`), { method:'DELETE' }),
      create: (orgId, channelId, input = {}) => request(orgPath(orgId, `/channels/${enc(channelId)}/huddles`), { method:'POST', body:input }),
      get: (orgId, huddleId) => request(orgPath(orgId, `/huddles/${enc(huddleId)}`)),
      join: (orgId, huddleId) => request(orgPath(orgId, `/huddles/${enc(huddleId)}/join`), { method:'POST', body:{} }),
      leave: (orgId, huddleId) => request(orgPath(orgId, `/huddles/${enc(huddleId)}/leave`), { method:'POST', body:{} }),
      end: (orgId, huddleId) => request(orgPath(orgId, `/huddles/${enc(huddleId)}/end`), { method:'POST', body:{} }),
      mediaState: (orgId, huddleId, input) => request(orgPath(orgId, `/huddles/${enc(huddleId)}/media-state`), { method:'PATCH', body:input }),
      recording: (orgId, huddleId, attachmentId) => request(orgPath(orgId, `/huddles/${enc(huddleId)}/recording`), { method:'POST', body:{ attachment_id:attachmentId } }),
      signals: (orgId, huddleId, peerId, after = 0) => request(orgPath(orgId, `/huddles/${enc(huddleId)}/signals${queryString({ peer_id:peerId, after })}`)),
      signal: (orgId, huddleId, input) => request(orgPath(orgId, `/huddles/${enc(huddleId)}/signals`), { method:'POST', body:input })
    },

    typing: {
      note: (orgId, channelId) => request(orgPath(orgId, `/channels/${enc(channelId)}/typing`), { method: 'POST', body: {} })
    },

    search: (orgId, q, params = {}) => request(orgPath(orgId, `/search${queryString({ q, ...params })}`)),

    uploads: {
      send: (orgId, file, channelId) => {
        const form = new FormData();
        form.append('file', file, file.name || 'upload');
        if (channelId) form.append('channel_id', channelId);
        return request(orgPath(orgId, '/uploads'), { method: 'POST', body: form });
      }
    },

    mediaFileUrl: (orgId, mediaId) => {
      const platformBase = APP.platformApiBase
        ? cleanText(APP.platformApiBase).replace(/\/+$/, '')
        : baseUrl().replace(/\/v1\/channels$/, '/v1/platform');
      return `${platformBase}/organizations/${enc(orgId)}/media/${enc(mediaId)}/file`;
    }
  };

  root.ChannelsAPI = api;
})();
