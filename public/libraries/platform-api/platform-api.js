/* libraries/platform-api/platform-api.js
 * Browser client for /v1/platform.
 *
 * Keep all frontend Platform API URL construction and JSON request handling here.
 * UI code should call PlatformAPI directly or use thin local wrappers that delegate here.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};

  const state = {
    baseUrl: '',
    defaultHeaders: {}
  };

  function cleanText(value){
    return String(value ?? '').trim();
  }

  function defaultBaseUrl(){
    if (APP.platformApiBase) return cleanText(APP.platformApiBase).replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return '';
    if (host === '10.0.2.2') return `${location.protocol}//${location.hostname}:3111/v1/platform`;
    return `${location.origin}/v1/platform`;
  }

  function configure(options = {}){
    if (options.baseUrl) state.baseUrl = cleanText(options.baseUrl).replace(/\/+$/, '');
    if (options.headers && typeof options.headers === 'object') {
      state.defaultHeaders = { ...state.defaultHeaders, ...options.headers };
    }
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

  function jsonBody(body){
    if (body == null || body instanceof FormData || typeof body === 'string') return body;
    return JSON.stringify(body);
  }

  function requestHeaders(options, body){
    const headers = {
      Accept: 'application/json',
      ...state.defaultHeaders,
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    };
    const method = cleanText(options.method || 'GET').toUpperCase();
    const csrf = csrfToken();
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers['X-Platform-CSRF']) {
      headers['X-Platform-CSRF'] = csrf;
    }
    return headers;
  }

  function cookieValue(name){
    const target = `${encodeURIComponent(name)}=`;
    return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(target))?.slice(target.length) || '';
  }

  function csrfToken(){
    return decodeURIComponent(cookieValue('fm_platform_session_csrf') || '');
  }

  async function request(path, options = {}){
    const requestUrl = url(path);
    if (!requestUrl) {
      const error = new Error('Platform API is not configured for this frontend session.');
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
      const error = new Error(cleanText(data?.message || data?.error) || `Platform API request failed (${res.status})`);
      error.status = res.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  const enc = (value) => encodeURIComponent(cleanText(value));
  const orgPath = (orgId, suffix = '') => `/organizations/${enc(orgId)}${suffix}`;
  const GB_BYTES = 1024 * 1024 * 1024;
  const collectionPath = (orgId, collection, id = '') => {
    const base = orgPath(orgId, `/${enc(collection)}`);
    return id ? `${base}/${enc(id)}` : base;
  };
  const CORE_COLLECTIONS = {
    project: 'projects',
    projects: 'projects',
    customer: 'customers',
    customers: 'customers',
    user: 'users',
    users: 'users',
    branch: 'branch',
    branches: 'branch',
    notification: 'notifications',
    notifications: 'notifications',
    action_item: 'action_items',
    action_items: 'action_items',
    activity: 'activity',
    activities: 'activity',
    user_activity: 'activity',
    customer_portal: 'customer_portals',
    customer_portals: 'customer_portals'
  };

  function normalizeCollection(collection){
    const key = cleanText(collection).toLowerCase();
    return CORE_COLLECTIONS[key] || key;
  }

  function ownerTypeForCollection(collection){
    const normalized = normalizeCollection(collection);
    if (normalized === 'projects') return 'project';
    if (normalized === 'customers') return 'customer';
    if (normalized === 'users') return 'user';
    if (normalized === 'branch') return 'branch';
    if (normalized === 'notifications') return 'notification';
    if (normalized === 'action_items') return 'action_item';
    if (normalized === 'activity') return 'activity';
    return normalized.replace(/s$/, '') || 'document';
  }

  function nowIso(){
    return new Date().toISOString();
  }

  function isNotFound(error){
    return Number(error?.status || 0) === 404;
  }

  function isMissingRecord(error){
    const message = cleanText(error?.message || error?.data?.message || error?.data?.error || error?.responseText).toLowerCase();
    return Number(error?.status || 0) === 0
      || isNotFound(error)
      || message.includes('requested platform record was not found')
      || message.includes('platform record was not found')
      || message.includes('record was not found');
  }

  function isMissingActionItemsEndpoint(error){
    const status = Number(error?.status || 0);
    const message = cleanText(error?.message || error?.data?.message || error?.data?.error || error?.data?.code || error?.responseText).toLowerCase();
    return isMissingRecord(error)
      || (status === 400 && (
        message.includes('invalid_collection')
        || message.includes('collection must be one of')
        || message.includes('action-items')
        || message.includes('action items')
      ));
  }

  function emptyCollectionResult(collection){
    return {
      ok: true,
      documents: [],
      [normalizeCollection(collection)]: []
    };
  }

  function localModule(moduleId, data = {}, metadata = {}){
    return {
      id: cleanText(moduleId),
      module_id: cleanText(moduleId),
      data: data && typeof data === 'object' ? data : {},
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      missing: true,
      local: true
    };
  }

  function localDocument(id, data = {}, metadata = {}){
    return {
      id: cleanText(id),
      data: data && typeof data === 'object' ? data : {},
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      missing: true,
      local: true
    };
  }

  function objectValue(value){
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  }

  function splitFieldPath(field){
    return cleanText(field).split('.').map((part) => part.trim()).filter(Boolean);
  }

  function fieldPathIsNested(field){
    return splitFieldPath(field).length > 1;
  }

  function getByPath(source, field, fallback = undefined){
    const parts = splitFieldPath(field);
    let value = source;
    for (const part of parts) {
      if (!value || typeof value !== 'object') return fallback;
      value = value[part];
    }
    return value === undefined ? fallback : value;
  }

  function setByPath(source, field, value){
    const parts = splitFieldPath(field);
    if (!parts.length) return { ...(source || {}) };
    const rootObj = { ...(source || {}) };
    let target = rootObj;
    parts.slice(0, -1).forEach((part) => {
      target[part] = objectValue(target[part]);
      target = target[part];
    });
    target[parts[parts.length - 1]] = value;
    return rootObj;
  }

  function removeByPath(source, field){
    const parts = splitFieldPath(field);
    if (!parts.length) return { ...(source || {}) };
    const rootObj = { ...(source || {}) };
    let target = rootObj;
    parts.slice(0, -1).forEach((part) => {
      target[part] = objectValue(target[part]);
      target = target[part];
    });
    delete target[parts[parts.length - 1]];
    return rootObj;
  }

  const orgs = {
    create(payload){ return request('/organizations', { method: 'POST', body: payload }); },
    list(){ return request('/organizations'); },
    get(orgId){
      return request(orgPath(orgId)).catch((error) => {
        if (isMissingRecord(error)) return { ok: true, organization: { id: cleanText(orgId), name: APP.userCompany || '', missing: true } };
        throw error;
      });
    },
    portalState(orgId){
      return request(orgPath(orgId, '/portal-state')).catch((error) => {
        if (isMissingRecord(error)) {
          return {
            ok: true,
            organization: { id: cleanText(orgId), name: APP.userCompany || '', missing: true },
            branch: localDocument(APP.userBranchId || 'default'),
            global: localDocument('global'),
            billing: {},
            missing: true
          };
        }
        throw error;
      });
    },
    patch(orgId, data){ return request(orgPath(orgId), { method: 'PATCH', body: data || {} }); },
    getGlobal(orgId){
      return request(orgPath(orgId, '/global')).catch((error) => {
        if (isMissingRecord(error)) return { ok: true, document: localDocument('global'), global: localDocument('global'), missing: true };
        throw error;
      });
    },
    saveGlobal(orgId, data, metadata = {}){
      return request(orgPath(orgId, '/global'), { method: 'PUT', body: { data: data || {}, metadata: metadata || {} } }).catch((error) => {
        if (isMissingRecord(error)) return { ok: true, document: localDocument('global', data || {}, metadata || {}), missing: true };
        throw error;
      });
    },
    patchGlobal(orgId, data){
      return request(orgPath(orgId, '/global'), { method: 'PATCH', body: { data } }).catch((error) => {
        if (isMissingRecord(error)) return { ok: true, document: localDocument('global', data || {}), missing: true };
        throw error;
      });
    }
  };

  const identities = {
    create(data = {}){ return request('/identities', { method: 'POST', body: { data } }); },
    get(identityId){ return request(`/identities/${enc(identityId)}`); },
    patch(identityId, data = {}){ return request(`/identities/${enc(identityId)}`, { method: 'PATCH', body: { data } }); }
  };

  const auth = {
    login(payload = {}){ return request('/auth/login', { method: 'POST', body: payload }); },
    logout(){ return request('/auth/logout', { method: 'POST' }); },
    session(){
      return request('/auth/session').catch((error) => {
        if (isMissingRecord(error)) return { ok: false, authenticated: false, missing: true };
        throw error;
      });
    },
    async me(){
      const result = await auth.session();
      const membership = result?.membership || result?.session?.membership || null;
      const user = result?.user || result?.session?.user || membership?.user || null;
      return {
        ...result,
        membership,
        user,
        identity: result?.identity || result?.session?.identity || null
      };
    },
    resolve(payload = {}){ return request('/auth/resolve', { method: 'POST', body: payload }); },
    register(payload = {}){ return request('/auth/register', { method: 'POST', body: payload }); },
    touchLogin(payload = {}){ return request('/auth/touch-login', { method: 'POST', body: payload }); }
  };

  const credits = {
    get(orgId, options = {}){
      const params = new URLSearchParams();
      const limit = Number(options.limit);
      if (Number.isFinite(limit) && limit > 0) params.set('limit', String(Math.floor(limit)));
      const qs = params.toString();
      return request(orgPath(orgId, `/credits${qs ? `?${qs}` : ''}`)).catch((error) => {
        if (isMissingRecord(error)) return { ok: true, balance: 0, credits_balance: 0, ledger: [], missing: true };
        throw error;
      });
    },
    charge(orgId, payload = {}){ return request(orgPath(orgId, '/credits/charge'), { method: 'POST', body: payload || {} }); },
    refund(orgId, payload = {}){ return request(orgPath(orgId, '/credits/refund'), { method: 'POST', body: payload || {} }); },
    adjust(orgId, payload = {}){ return request(orgPath(orgId, '/credits/adjust'), { method: 'POST', body: payload || {} }); }
  };

  function normalizeUserDocument(doc = {}){
    const data = doc?.data && typeof doc.data === 'object' ? doc.data : doc;
    const orgPermissions = data?.org_permissions && typeof data.org_permissions === 'object' ? data.org_permissions : {};
    const level = orgPermissions.level || data?.org_permission_level || data?.permission_level || data?.role || 'viewer';
    const items = orgPermissions.items || data?.permissions || {};
    return {
      id: doc?.id || data?.id || '',
      ...data,
      org_permissions: { level, items },
      org_permission_level: level,
      permissions: data?.permissions || {},
      disabled: data?.disabled === true || data?.status === 'disabled'
    };
  }

  const orgUsers = {
    async list(orgId){
      const result = await request(collectionPath(orgId, 'users')).catch((error) => {
        if (isMissingRecord(error)) return emptyCollectionResult('users');
        throw error;
      });
      return {
        ...result,
        users: (Array.isArray(result?.documents) ? result.documents : []).map(normalizeUserDocument)
      };
    },
    async get(orgId, userId){
      const result = await request(collectionPath(orgId, 'users', userId));
      return { ...result, user: normalizeUserDocument(result?.document || {}) };
    },
    create(orgId, user = {}){
      return request(collectionPath(orgId, 'users'), {
        method: 'POST',
        body: user?.data ? user : { data: user || {} }
      });
    },
    resendInvite(orgId, userId){
      return request(orgPath(orgId, `/users/${enc(userId)}/invite`), { method: 'POST', body: {} });
    },
    save(orgId, userId, user = {}, metadata = {}){
      return request(collectionPath(orgId, 'users', userId), {
        method: 'PUT',
        body: {
          data: user || {},
          metadata: { kind: 'organization_user', ...(metadata || {}) }
        }
      });
    },
    patch(orgId, userId, patch = {}, metadata = {}){
      return request(collectionPath(orgId, 'users', userId), {
        method: 'PATCH',
        body: { data: patch || {}, metadata: metadata || {} }
      });
    },
    setDisabled(orgId, userId, disabled){
      return orgUsers.patch(orgId, userId, { status: disabled ? 'disabled' : 'active' }, { source: 'org_users_set_disabled' });
    },
    setPermissions(orgId, userId, role, permissions = {}){
      const level = role || 'viewer';
      return orgUsers.patch(orgId, userId, {
        role: level,
        org_permissions: { level, items: permissions || {} },
        permissions: permissions || {}
      }, { source: 'org_users_set_permissions' });
    },
    remove(orgId, userId){ return request(collectionPath(orgId, 'users', userId), { method: 'DELETE' }); },
    normalize: normalizeUserDocument
  };

  const notifications = {
    list(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.branchId || options.branch_id) params.set('branch_id', options.branchId || options.branch_id);
      if (options.includeDismissed) params.set('include_dismissed', '1');
      const qs = params.toString();
      return request(orgPath(orgId, `/notifications${qs ? `?${qs}` : ''}`)).catch((error) => {
        if (isMissingRecord(error)) return { ok: true, notifications: [], documents: [], unread_count: 0, missing: true };
        throw error;
      });
    },
    create(orgId, notification = {}){
      return request(orgPath(orgId, '/notifications'), { method: 'POST', body: notification || {} });
    },
    get(orgId, notificationId){
      return request(orgPath(orgId, `/notifications/${enc(notificationId)}`));
    },
    setUserState(orgId, notificationId, state = {}){
      return request(orgPath(orgId, `/notifications/${enc(notificationId)}/user-state`), { method: 'PATCH', body: state || {} });
    },
    markSeen(orgId, notificationId){ return notifications.setUserState(orgId, notificationId, { seen: true }); },
    dismiss(orgId, notificationId){ return notifications.setUserState(orgId, notificationId, { dismissed: true }); },
    complete(orgId, notificationId){ return notifications.setUserState(orgId, notificationId, { completed: true }); },
  };

  const search = {
    projectsAndContacts(orgId, options = {}){
      const params = new URLSearchParams();
      const query = cleanText(options.q || options.query || options.search);
      const types = cleanText(options.types || 'projects,contacts');
      const limit = Number(options.limit || 40);
      if (query) params.set('q', query);
      if (types) params.set('types', types);
      if (Number.isFinite(limit) && limit > 0) params.set('limit', String(Math.floor(limit)));
      const qs = params.toString();
      return request(orgPath(orgId, `/search${qs ? `?${qs}` : ''}`), {
        ...(options.signal ? { signal: options.signal } : {})
      }).catch((error) => {
        if (isMissingRecord(error)) return { ok: true, results: [], count: 0, missing: true };
        throw error;
      });
    }
  };

  const actionItems = {
    list(orgId, options = {}){
      const params = new URLSearchParams();
      if (options.branchId || options.branch_id) params.set('branch_id', options.branchId || options.branch_id);
      if (options.projectId || options.project_id) params.set('project_id', options.projectId || options.project_id);
      if (options.contact) params.set('contact', options.contact);
      if (options.kind) params.set('kind', options.kind);
      if (options.status) params.set('status', options.status);
      if (options.dueBefore || options.due_before) params.set('due_before', options.dueBefore || options.due_before);
      if (options.dueAfter || options.due_after) params.set('due_after', options.dueAfter || options.due_after);
      if (options.includeCompleted) params.set('include_completed', '1');
      if (options.includeCanceled) params.set('include_canceled', '1');
      if (options.includeHidden) params.set('include_hidden', '1');
      if (options.includeAll) params.set('include_all', '1');
      const qs = params.toString();
      return request(orgPath(orgId, `/action-items${qs ? `?${qs}` : ''}`)).catch((error) => {
        if (isMissingActionItemsEndpoint(error)) return { ok: true, action_items: [], items: [], active_count: 0, unread_count: 0, missing: true };
        throw error;
      });
    },
    create(orgId, item = {}){
      return request(orgPath(orgId, '/action-items'), { method: 'POST', body: item || {} });
    },
    get(orgId, actionItemId){
      return request(orgPath(orgId, `/action-items/${enc(actionItemId)}`));
    },
    patch(orgId, actionItemId, patch = {}){
      return request(orgPath(orgId, `/action-items/${enc(actionItemId)}`), { method: 'PATCH', body: patch || {} });
    },
    claim(orgId, actionItemId, payload = {}){
      return request(orgPath(orgId, `/action-items/${enc(actionItemId)}/claim`), { method: 'POST', body: payload || {} });
    },
    complete(orgId, actionItemId, payload = {}){
      return request(orgPath(orgId, `/action-items/${enc(actionItemId)}/complete`), { method: 'POST', body: payload || {} });
    },
    cancel(orgId, actionItemId, payload = {}){
      return request(orgPath(orgId, `/action-items/${enc(actionItemId)}/cancel`), { method: 'POST', body: payload || {} });
    },
    setUserState(orgId, actionItemId, state = {}){
      return request(orgPath(orgId, `/action-items/${enc(actionItemId)}/user-state`), { method: 'PATCH', body: state || {} });
    },
    markSeen(orgId, actionItemId){ return actionItems.setUserState(orgId, actionItemId, { seen: true }); },
    hide(orgId, actionItemId){ return actionItems.setUserState(orgId, actionItemId, { hidden: true }); },
    dismiss(orgId, actionItemId){ return actionItems.setUserState(orgId, actionItemId, { dismissed: true }); },
    pin(orgId, actionItemId, pinned = true){ return actionItems.setUserState(orgId, actionItemId, { pinned }); },
    snooze(orgId, actionItemId, snoozedUntil){ return actionItems.setUserState(orgId, actionItemId, { snoozed_until: snoozedUntil || '' }); },
  };

  const userActivity = (() => {
    function eventData(doc = {}) {
      const data = doc?.data && typeof doc.data === 'object' ? doc.data : doc;
      return {
        id: doc?.id || data.id || '',
        ...data
      };
    }
    function actorMatches(event = {}, user = {}) {
      const keys = [user.id, user.email, user.name, user.key].map(cleanText).filter(Boolean).map((value) => value.toLowerCase());
      if (!keys.length) return true;
      return [event.actor_user_id, event.actor_email, event.actor_name, event.actor?.id, event.actor?.email, event.actor?.name]
        .map(cleanText)
        .filter(Boolean)
        .map((value) => value.toLowerCase())
        .some((value) => keys.includes(value));
    }
    function targetMatches(event = {}, target = {}) {
      const targetObj = event.target && typeof event.target === 'object' ? event.target : {};
      return Object.entries(target || {}).every(([key, value]) => {
        const expected = cleanText(value);
        if (!expected) return true;
        return cleanText(targetObj[key] || event[key]).toLowerCase() === expected.toLowerCase();
      });
    }
    function normalizeList(result = {}) {
      return (Array.isArray(result?.documents) ? result.documents : [])
        .map(eventData)
        .sort((a, b) => cleanText(b.occurred_at || b.created_at).localeCompare(cleanText(a.occurred_at || a.created_at)));
    }
    function normalizeEvent(event = {}) {
      const now = nowIso();
      const target = event.target && typeof event.target === 'object' ? event.target : {};
      return {
        type: cleanText(event.type || 'activity'),
        occurred_at: cleanText(event.occurred_at || event.created_at || now),
        actor_user_id: cleanText(event.actor_user_id || event.actorUserId || event.actor?.id),
        actor_name: cleanText(event.actor_name || event.actorName || event.actor?.name),
        actor_email: cleanText(event.actor_email || event.actorEmail || event.actor?.email),
        summary: cleanText(event.summary),
        target,
        metadata: event.metadata && typeof event.metadata === 'object' ? event.metadata : {},
        ...event
      };
    }
    return {
      async track(orgId, event = {}, metadata = {}) {
        const data = normalizeEvent(event);
        return request(collectionPath(orgId, 'activity'), {
          method: 'POST',
          body: {
            data,
            metadata: { kind: 'user_activity', source: 'platform_user_activity', ...(metadata || {}) }
          }
        }).catch((error) => {
          if (isMissingRecord(error)) return { ok: true, document: localDocument(data.id || '', data, metadata), missing: true };
          throw error;
        });
      },
      async list(orgId, options = {}) {
        const result = await request(collectionPath(orgId, 'activity')).catch((error) => {
          if (isMissingRecord(error)) return emptyCollectionResult('activity');
          throw error;
        });
        let events = normalizeList(result);
        if (options.user) events = events.filter((event) => actorMatches(event, options.user));
        if (options.target) events = events.filter((event) => targetMatches(event, options.target));
        if (options.types && Array.isArray(options.types) && options.types.length) {
          const types = new Set(options.types.map(cleanText).filter(Boolean));
          events = events.filter((event) => types.has(event.type));
        }
        const limit = Math.max(0, Math.round(Number(options.limit || 0)));
        return { ...result, events: limit ? events.slice(0, limit) : events };
      },
      listForUser(orgId, user = {}, options = {}) {
        return userActivity.list(orgId, { ...options, user });
      },
      listForProject(orgId, projectId, options = {}) {
        return userActivity.list(orgId, { ...options, target: { ...(options.target || {}), project_id: projectId } });
      },
      listForMedia(orgId, mediaId, options = {}) {
        return userActivity.list(orgId, { ...options, target: { ...(options.target || {}), media_id: mediaId } });
      }
    };
  })();

  const tagging = {
    mentionEvent(orgId, event = {}){
      return request(orgPath(orgId, '/tagging/mention-events'), {
        method: 'POST',
        body: event || {}
      });
    }
  };

  /*
   * Generic lead creation endpoint.
   *
   * Server: POST /v1/platform/organizations/:orgId/leads
   * Body fields are intentionally schema-light:
   *   branch_id, source_kind, address, title, summary, contacts[],
   *   provider, confidence, provider_fields, raw, lead_source, notification.
   * The API creates the Platform project/notification pair, stores contacts on
   * the project, and keeps
   * every source (email, canvassing, embedded forms, future API imports) on
   * the same data path.
   */
  const leads = {
    create(orgId, lead = {}){
      return request(orgPath(orgId, '/leads'), { method: 'POST', body: lead || {} });
    }
  };

  /*
   * Core document collections are intentionally schema-light during development.
   *
   * Server contract:
   *   GET    /organizations/:orgId/:collection/:documentId
   *          -> { ok, document: { id, collection, data, metadata, revision, ... } }
   *   PUT    /organizations/:orgId/:collection/:documentId
   *          body { data, metadata } replaces document.data and document.metadata.
   *   PATCH  /organizations/:orgId/:collection/:documentId
   *          body { data, metadata } shallow-merges top-level fields into the record.
   *
   * Accepted collections today: projects, users, branch, notifications, action_items. The server stores
   * unknown data keys as-is, so project.end_date or project.any_new_variable can be
   * added without a schema migration. Use documents.setField() for one-off fields and
   * documents.uploadFieldFile() when a field should point at a stored file/media item.
   */
  function collectionMethods(collection, metadataKind){
    const normalizedCollection = normalizeCollection(collection);
    return {
      list(orgId){
        return request(collectionPath(orgId, normalizedCollection)).catch((error) => {
          if (isMissingRecord(error)) return emptyCollectionResult(normalizedCollection);
          throw error;
        });
      },
      listForContact(orgId, contact = {}, options = {}) {
        if (normalizedCollection !== 'projects') throw new Error('listForContact is only available for projects.');
        const params = new URLSearchParams();
        const contactData = contact && typeof contact === 'object' ? contact : {};
        const projectIds = [
          contactData.project_id,
          contactData.primary_project_id,
          ...(Array.isArray(contactData.project_ids) ? contactData.project_ids : []),
          ...(Array.isArray(options.projectIds) ? options.projectIds : []),
          ...(Array.isArray(options.project_ids) ? options.project_ids : [])
        ].map(cleanText).filter(Boolean);
        if (projectIds.length) params.set('project_ids', Array.from(new Set(projectIds)).join(','));
        const contactId = cleanText(contactData.id || contactData.contact_id || options.contactId || options.contact_id);
        if (contactId) params.set('contact_id', contactId);
        const email = cleanText(contactData.email || options.email);
        if (email) params.set('email', email);
        const phone = cleanText(contactData.phone || options.phone);
        if (phone) params.set('phone', phone);
        const name = cleanText(contactData.name || options.name);
        if (name) params.set('name', name);
        const qs = params.toString();
        return request(orgPath(orgId, `/projects/contact-projects${qs ? `?${qs}` : ''}`)).catch((error) => {
          if (isMissingRecord(error)) return { ok: true, documents: [], projects: [], missing: true };
          throw error;
        });
      },
      get(orgId, id){
        return request(collectionPath(orgId, normalizedCollection, id)).catch((error) => {
          if (isMissingRecord(error)) return { ok: true, document: null, missing: true };
          throw error;
        });
      },
      save(orgId, id, data, metadata = {}) {
        return request(collectionPath(orgId, normalizedCollection, id), {
          method: 'PUT',
          body: {
            data: data || {},
            metadata: { kind: metadataKind || normalizedCollection, ...(metadata || {}) }
          }
        }).catch((error) => {
          if (isMissingRecord(error)) return { ok: true, document: localDocument(id, data || {}, { kind: metadataKind || normalizedCollection, ...(metadata || {}) }), missing: true };
          throw error;
        });
      },
      patch(orgId, id, data, metadata = {}) {
        return request(collectionPath(orgId, normalizedCollection, id), {
          method: 'PATCH',
          body: { data: data || {}, metadata: metadata || {} }
        }).catch((error) => {
          if (isMissingRecord(error)) return { ok: true, document: localDocument(id, data || {}, metadata || {}), missing: true };
          throw error;
        });
      },
      remove(orgId, id){
        return request(collectionPath(orgId, normalizedCollection, id), { method: 'DELETE' }).catch((error) => {
          if (isMissingRecord(error)) return { ok: true, deleted: false, missing: true };
          throw error;
        });
      },
      scheduleEvent(orgId, id, event, options = {}) {
        if (normalizedCollection !== 'projects') throw new Error('scheduleEvent is only available for projects.');
        return request(orgPath(orgId, `/projects/${enc(id)}/events`), {
          method: 'POST',
          body: {
            event: event || {},
            branch_id: options.branchId || options.branch_id || ''
          }
        }).catch((error) => {
          if (isMissingRecord(error)) return { ok: true, project: localDocument(id, { events: [event || {}] }), event: event || {}, missing: true };
          throw error;
        });
      },
      async getData(orgId, id){
        return (await request(collectionPath(orgId, normalizedCollection, id)))?.document?.data || null;
      },
      setField(orgId, id, field, value, metadata = {}) {
        return documents.setField(orgId, normalizedCollection, id, field, value, metadata);
      },
      patchFields(orgId, id, fields, metadata = {}) {
        return documents.patchFields(orgId, normalizedCollection, id, fields, metadata);
      },
      removeField(orgId, id, field, metadata = {}) {
        return documents.removeField(orgId, normalizedCollection, id, field, metadata);
      },
      uploadFieldFile(orgId, id, field, file, options = {}) {
        return documents.uploadFieldFile(orgId, normalizedCollection, id, field, file, options);
      }
    };
  }

  const branches = {
    list(orgId){
      return request(orgPath(orgId, '/branch')).catch((error) => {
        if (isMissingRecord(error)) return { ok: true, documents: [], branches: [], missing: true };
        throw error;
      });
    },
    get(orgId, branchId){
      return request(orgPath(orgId, `/branch/${enc(branchId)}`)).catch((error) => {
        if (isMissingRecord(error)) return { ok: true, document: localDocument(branchId || 'default'), data: {}, missing: true };
        throw error;
      });
    },
    save(orgId, branchId, data, metadata = {}) {
      return request(orgPath(orgId, `/branch/${enc(branchId)}`), {
        method: 'PUT',
        body: { data: data || {}, metadata: { kind: 'branch', ...(metadata || {}) } }
      }).catch((error) => {
        if (isMissingRecord(error)) return { ok: true, document: localDocument(branchId || 'default', data || {}, { kind: 'branch', ...(metadata || {}) }), missing: true };
        throw error;
      });
    },
    patch(orgId, branchId, data, metadata = {}) {
      return request(orgPath(orgId, `/branch/${enc(branchId)}`), {
        method: 'PATCH',
        body: { data: data || {}, metadata: metadata || {} }
      }).catch((error) => {
        if (isMissingRecord(error)) return { ok: true, document: localDocument(branchId || 'default', data || {}, metadata || {}), missing: true };
        throw error;
      });
    },
    triggers: {
      get(orgId, branchId){
        return request(orgPath(orgId, `/branch/${enc(branchId || 'default')}/triggers`));
      },
      save(orgId, branchId, data, metadata = {}){
        return request(orgPath(orgId, `/branch/${enc(branchId || 'default')}/triggers`), {
          method: 'PUT',
          body: { data: data || {}, metadata: metadata || {} }
        });
      },
      emit(orgId, branchId, event, context = {}){
        return request(orgPath(orgId, `/branch/${enc(branchId || 'default')}/triggers/emit`), {
          method: 'POST',
          body: { event, context }
        });
      }
    },
    modules: {
      get(orgId, branchId, moduleId){
        return request(orgPath(orgId, `/branch/${enc(branchId)}/modules/${enc(moduleId)}`)).catch((error) => {
          if (isMissingRecord(error)) {
            return { ok: true, module: localModule(moduleId) };
          }
          throw error;
        });
      },
      list(orgId, branchId){
        return request(orgPath(orgId, `/branch/${enc(branchId)}/modules`)).catch((error) => {
          if (isMissingRecord(error)) return { ok: true, modules: [], documents: [], missing: true };
          throw error;
        });
      },
      save(orgId, branchId, moduleId, data, metadata = {}) {
        return request(orgPath(orgId, `/branch/${enc(branchId)}/modules/${enc(moduleId)}`), {
          method: 'PUT',
          body: { data: data || {}, metadata: metadata || {} }
        }).catch((error) => {
          if (isMissingRecord(error)) return { ok: true, module: localModule(moduleId, data || {}, metadata || {}) };
          throw error;
        });
      }
    }
  };

  const media = {
    list(orgId){ return request(orgPath(orgId, '/media')); },
    get(orgId, mediaId){ return request(orgPath(orgId, `/media/${enc(mediaId)}`)); },
    upload(orgId, file, options = {}){
      const fd = new FormData();
      fd.append(options.fileField || 'file', file);
      const appendText = (key, value) => {
        if (value === undefined || value === null || value === '') return;
        fd.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      };
      appendText('id', options.id);
      appendText('owner_type', options.ownerType || options.owner_type);
      appendText('owner_id', options.ownerId || options.owner_id);
      appendText('slot', options.slot);
      appendText('collection', options.collection);
      appendText('scope', options.scope);
      appendText('replace_slot', options.replaceSlot ?? options.replace_slot);
      appendText('thumbnails', options.thumbnails);
      appendText('compression', options.compression);
      appendText('markup', options.markup);
      appendText('metadata', options.metadata);
      appendText('processing', options.processing);
      return request(orgPath(orgId, '/media'), { method: 'POST', body: fd });
    },
    /*
     * Build a storable document field reference from a media upload response.
     *
     * Field reference shape:
     *   {
     *     kind: 'media_reference',
     *     media_id,
     *     variant: 'original',
     *     field,
     *     owner: { collection, id, field },
     *     file_name,
     *     content_type,
     *     size_bytes,
     *     variants: ['original', 'thumb_320', ...],
     *     metadata,
     *     uploaded_at,
     *     updated_at
     *   }
     *
     * Store this object directly on any core document field for single files, or
     * inside an array for repeatable file fields. Use media.fileUrlFromReference()
     * to turn it back into a downloadable URL.
     */
    referenceFromUpload(uploadResult, extra = {}){
      const item = uploadResult?.media || uploadResult || {};
      const variants = item.variants && typeof item.variants === 'object' ? item.variants : {};
      return media.normalizeReference({
        kind: 'media_reference',
        media_id: item.id || item.media_id,
        variant: extra.variant || 'original',
        file_name: item.file_name || extra.file_name || '',
        content_type: item.content_type || extra.content_type || '',
        size_bytes: item.size_bytes || extra.size_bytes || 0,
        variants: Object.keys(variants),
        owner: item.owner || extra.owner || {},
        field: extra.field || item.owner?.slot || '',
        uploaded_at: item.created_at || nowIso(),
        updated_at: item.updated_at || nowIso(),
        metadata: { ...(item.metadata || {}), ...(extra.metadata || {}) },
        ...extra
      });
    },
    fileUrl(orgId, mediaId, variant = 'original'){
      return url(orgPath(orgId, `/media/${enc(mediaId)}/file?variant=${enc(variant)}`));
    },
    fileUrlFromReference(orgId, reference, variant = null){
      const ref = media.normalizeReference(reference);
      return media.fileUrl(orgId, ref.media_id, variant || ref.variant || 'original');
    },
    fetchReference(orgId, reference, variant = null, options = {}){
      return fetch(media.fileUrlFromReference(orgId, reference, variant), {
        ...options,
        credentials: options.credentials || 'include',
        headers: { Accept: '*/*', ...(options.headers || {}) }
      });
    },
    originalUrl(orgId, mediaId){ return media.fileUrl(orgId, mediaId, 'original'); },
    variantUrl(orgId, mediaId, variant){ return media.fileUrl(orgId, mediaId, variant); },
    thumbnailUrl(orgId, mediaId, size = 320){
      return media.fileUrl(orgId, mediaId, `thumb_${parseInt(size, 10) || 320}`);
    },
    markupLayerId(slot = 'default'){
      return `markup_${cleanText(slot || 'default').toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'default'}`;
    },
    emptyReference(mediaId, extra = {}){
      return {
        media_id: cleanText(mediaId),
        variant: 'original',
        markup: {},
        renditions: {},
        metadata: {},
        ...extra
      };
    },
    normalizeReference(reference = {}){
      const mediaId = cleanText(reference.media_id || reference.mediaId || reference.id);
      return media.emptyReference(mediaId, {
        ...reference,
        media_id: mediaId,
        markup: reference.markup && typeof reference.markup === 'object' ? reference.markup : {},
        renditions: reference.renditions && typeof reference.renditions === 'object' ? reference.renditions : {},
        metadata: reference.metadata && typeof reference.metadata === 'object' ? reference.metadata : {}
      });
    },
    getMarkup(orgId, mediaId, layerId = 'default'){
      return request(orgPath(orgId, `/media/${enc(mediaId)}/markup/${enc(media.markupLayerId(layerId))}`));
    },
    saveMarkup(orgId, mediaId, layerId = 'default', data = {}, metadata = {}){
      return request(orgPath(orgId, `/media/${enc(mediaId)}/markup/${enc(media.markupLayerId(layerId))}`), {
        method: 'PUT',
        body: { data: data || {}, metadata: metadata || {} }
      });
    }
  };

  function isBrandingMediaItem(item = {}){
    const owner = objectValue(item.owner);
    const meta = objectValue(item.metadata);
    const scope = cleanText(item.scope).toLowerCase();
    const collection = cleanText(item.collection).toLowerCase();
    const slot = cleanText(owner.slot || item.slot).toLowerCase();
    const purpose = cleanText(meta.purpose || meta.branding_purpose || meta.type).toLowerCase();
    return cleanText(owner.type).toLowerCase() === 'organization'
      && (
        scope === 'branding'
        || collection === 'branding'
        || slot.includes('logo')
        || slot.includes('brand')
        || purpose.includes('brand')
        || purpose.includes('logo')
      );
  }

  const brandingMedia = {
    async list(orgId, options = {}){
      const result = await media.list(orgId);
      const items = Array.isArray(result?.media) ? result.media : [];
      const imageOnly = options.imageOnly !== false;
      const filtered = items.filter((item) => {
        const kind = cleanText(item.kind || item.media_type || item.type).toLowerCase();
        const contentType = cleanText(item.content_type || item.mime_type).toLowerCase();
        return isBrandingMediaItem(item)
          && (!imageOnly || kind === 'image' || contentType.startsWith('image/'));
      });
      return { ok: true, media: filtered };
    },
    upload(orgId, file, options = {}){
      return media.upload(orgId, file, {
        ...options,
        ownerType: 'organization',
        ownerId: orgId,
        collection: 'branding',
        scope: 'branding',
        slot: options.slot || 'branding_media',
        thumbnails: options.thumbnails ?? true,
        compression: options.compression,
        metadata: {
          purpose: options.purpose || 'branding_asset',
          ...(options.metadata || {})
        }
      });
    },
    imageRef(orgId, item = {}, extra = {}){
      const ref = media.referenceFromUpload({ media: item }, extra);
      const variants = item.variants && typeof item.variants === 'object' ? item.variants : {};
      const label = cleanText(item.metadata?.label || item.file_name || extra.label || extra.alt || 'Branding image');
      return {
        ...ref,
        id: ref.media_id,
        media_id: ref.media_id,
        src: media.fileUrl(orgId, ref.media_id, 'original'),
        thumb: media.fileUrl(orgId, ref.media_id, variants.thumb_320 ? 'thumb_320' : 'original'),
        alt: label,
        label
      };
    }
  };

  const mediaStorage = (() => {
    const listeners = new Set();
    const cache = new Map();
    const fallbackKey = (orgId) => `fm_media_storage_usage_v1:${cleanText(orgId)}`;
    const toBytes = (value) => Math.max(0, Math.round(Number(value || 0)));
    const toSignedBytes = (value) => Math.round(Number(value || 0));
    function normalizeUsage(result = {}, orgId = ''){
      const source = result?.usage && typeof result.usage === 'object' ? result.usage : result;
      return {
        ok: result?.ok !== false,
        org_id: cleanText(source.org_id || source.orgId || orgId),
        used_bytes: toBytes(source.used_bytes || source.usedBytes || source.media_bytes || source.total_bytes || source.bytes),
        updated_at: cleanText(source.updated_at || source.updatedAt || nowIso()),
        source: cleanText(result?.source || source.source || '')
      };
    }
    function localUsage(orgId){
      let parsed = {};
      try { parsed = JSON.parse(root.localStorage?.getItem(fallbackKey(orgId)) || '{}') || {}; } catch (_) {}
      return normalizeUsage({ ...parsed, source: parsed.source || 'local' }, orgId);
    }
    function saveLocalUsage(orgId, usage){
      const normalized = normalizeUsage(usage, orgId);
      try { root.localStorage?.setItem(fallbackKey(orgId), JSON.stringify(normalized)); } catch (_) {}
      cache.set(cleanText(orgId), normalized);
      notify(normalized);
      return normalized;
    }
    function notify(usage){
      listeners.forEach((fn) => {
        try { fn(usage); } catch (_) {}
      });
      try { root.dispatchEvent(new CustomEvent('fm:media-storage:updated', { detail: usage })); } catch (_) {}
    }
    return {
      GB_BYTES,
      bytesFromGB(gb){ return Math.max(0, Number(gb || 0) * GB_BYTES); },
      formatBytes(bytes = 0){
        const value = Number(bytes || 0);
        if (value >= GB_BYTES) return `${(value / GB_BYTES).toFixed(value >= 10 * GB_BYTES ? 1 : 2).replace(/\.0+$/, '')} GB`;
        if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
        if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
        return `${Math.max(0, Math.round(value))} B`;
      },
      current(orgId){ return cache.get(cleanText(orgId)) || localUsage(orgId); },
      async get(orgId, options = {}){
        const oid = cleanText(orgId);
        if (!oid) return normalizeUsage({}, oid);
        if (cache.has(oid) && !options.refresh) return cache.get(oid);
        try {
          const result = await request(orgPath(oid, '/media/storage'));
          const usage = normalizeUsage(result, oid);
          cache.set(oid, usage);
          saveLocalUsage(oid, usage);
          return usage;
        } catch (error) {
          if (!isMissingRecord(error) && Number(error?.status || 0) !== 0) console.warn('Media storage usage unavailable; using local estimate.', error);
          const usage = localUsage(oid);
          cache.set(oid, usage);
          return usage;
        }
      },
      async increment(orgId, deltaBytes = 0, metadata = {}){
        const oid = cleanText(orgId);
        const delta = toSignedBytes(deltaBytes);
        if (!oid || !delta) return this.current(oid);
        try {
          const result = await request(orgPath(oid, '/media/storage'), {
            method: 'POST',
            body: { delta_bytes: delta, metadata: metadata || {} }
          });
          const usage = normalizeUsage(result, oid);
          saveLocalUsage(oid, usage);
          return usage;
        } catch (error) {
          if (!isMissingRecord(error) && Number(error?.status || 0) !== 0) console.warn('Media storage increment unavailable; using local estimate.', error);
          const current = localUsage(oid);
          return saveLocalUsage(oid, {
            ...current,
            used_bytes: Math.max(0, current.used_bytes + delta),
            updated_at: nowIso(),
            source: 'local_estimate'
          });
        }
      },
      onChange(fn){
        if (typeof fn !== 'function') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
      }
    };
  })();

  const appFlags = (() => {
    let cache = null;
    let cacheOrgId = '';
    let pending = null;
    let pendingOrgId = '';
    function normalizeEnabled(value){
      const enabled = {};
      const source = value && typeof value === 'object' ? value : {};
      Object.entries(source).forEach(([group, flags]) => {
        enabled[group] = Array.isArray(flags) ? flags.map(cleanText).filter(Boolean) : [];
      });
      return enabled;
    }
    function hasIn(enabled, group, flag){
      return (enabled?.[group] || []).includes(flag);
    }
    function assertSubmittedFlagsAccepted(result = {}, submitted = {}) {
      const raw = result?.raw && typeof result.raw === 'object' ? result.raw : {};
      const effective = result?.effective && typeof result.effective === 'object' ? result.effective : {};
      const definitions = Array.isArray(result?.definitions) ? result.definitions : [];
      const knownKeys = new Set(definitions.map((definition) => cleanText(definition.key || `${definition.group}.${definition.flag}`)).filter(Boolean));
      const source = submitted && typeof submitted === 'object' ? submitted : {};
      const rejected = [];
      const valuesMatch = (expected, actual) => {
        if (typeof expected === 'number') return Number(actual) === expected;
        return String(actual ?? '') === String(expected ?? '');
      };
      Object.entries(source).forEach(([group, flags]) => {
        if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return;
        Object.entries(flags).forEach(([flag, value]) => {
          const rawValue = raw?.[group]?.[flag];
          const effectiveValue = effective?.[group]?.[flag];
          if (typeof value === 'boolean') {
            if (value === true && rawValue !== true) rejected.push(`${group}.${flag}`);
            if (value === false && (rawValue === true || effectiveValue === true)) rejected.push(`${group}.${flag}`);
            return;
          }
          if (!valuesMatch(value, rawValue) && !valuesMatch(value, effectiveValue)) rejected.push(`${group}.${flag}`);
        });
      });
      if (rejected.length) {
        const missingDefinition = rejected.find((key) => !knownKeys.has(key));
        if (missingDefinition) {
          throw new Error(`The running API does not know the ${missingDefinition} feature flag yet. Restart the v1 API server so it loads the latest app flag registry, then reload Feature Flags and save again.`);
        }
        throw new Error(`Feature flag was not saved by the API: ${rejected[0]}. Reload Feature Flags and try again.`);
      }
    }
    return {
      current(){ return cache; },
      async load(orgId, options = {}){
        const normalizedOrgId = cleanText(orgId);
        if (!normalizedOrgId) return null;
        if (cache && cacheOrgId === normalizedOrgId && !options.refresh) return cache;
        if (pending && pendingOrgId === normalizedOrgId && !options.refresh) return pending;
        pendingOrgId = normalizedOrgId;
        pending = request(orgPath(normalizedOrgId, '/app-flags')).catch((error) => {
          if (isMissingRecord(error)) {
            return {
              ok: true,
              enabled: {
                platform: ['lead_import', 'website_embed_import', 'settings_forms', 'scheduling', 'project_photos', 'proposals', 'materials', 'top_bar', 'user_modals', 'storage_limits', 'customer_portal', 'customer_portal_media', 'purchasable_storage'],
                email: ['inbound_lead_import'],
                canvassing: ['app'],
                firstmeasure: ['bonus_upfront_match', 'gutter_reports', 'report_orders', 'report_cancellations', 'report_followup', 'instant_reports']
              },
              raw: {
                platform: {
                  storage_limits: true,
                  customer_portal: true,
                  customer_portal_media: true,
                  purchasable_storage: true,
                  free_storage_gb: 1
                }
              },
              missing: true
            };
          }
          throw error;
        }).then((result) => {
          cacheOrgId = normalizedOrgId;
          cache = {
            org_id: normalizedOrgId,
            enabled: normalizeEnabled(result?.enabled),
            raw: result?.raw && typeof result.raw === 'object' ? result.raw : {},
            raw_variants: result?.raw_variants && typeof result.raw_variants === 'object' ? result.raw_variants : {},
            effective: result?.effective && typeof result.effective === 'object' ? result.effective : {},
            effective_variants: result?.effective_variants && typeof result.effective_variants === 'object' ? result.effective_variants : {},
            definitions: Array.isArray(result?.definitions) ? result.definitions : [],
            variant_definitions: Array.isArray(result?.variant_definitions) ? result.variant_definitions : [],
            disabled_reasons: result?.disabled_reasons && typeof result.disabled_reasons === 'object' ? result.disabled_reasons : {},
            variant_disabled_reasons: result?.variant_disabled_reasons && typeof result.variant_disabled_reasons === 'object' ? result.variant_disabled_reasons : {},
            missing: result?.missing === true,
            test_admin: result?.test_admin === true,
            loaded_at: new Date().toISOString()
          };
          return cache;
        }).finally(() => {
          pending = null;
          pendingOrgId = '';
        });
        return pending;
      },
      async update(orgId, flags = {}){
        const normalizedOrgId = cleanText(orgId);
        if (!normalizedOrgId) return null;
        const result = await request(orgPath(normalizedOrgId, '/app-flags'), {
          method: 'PUT',
          body: { app_flags: flags || {} }
        });
        assertSubmittedFlagsAccepted(result, flags);
        cacheOrgId = normalizedOrgId;
        cache = {
          org_id: normalizedOrgId,
          enabled: normalizeEnabled(result?.enabled),
          raw: result?.raw && typeof result.raw === 'object' ? result.raw : {},
          raw_variants: result?.raw_variants && typeof result.raw_variants === 'object' ? result.raw_variants : {},
          effective: result?.effective && typeof result.effective === 'object' ? result.effective : {},
          effective_variants: result?.effective_variants && typeof result.effective_variants === 'object' ? result.effective_variants : {},
          definitions: Array.isArray(result?.definitions) ? result.definitions : [],
          variant_definitions: Array.isArray(result?.variant_definitions) ? result.variant_definitions : [],
          disabled_reasons: result?.disabled_reasons && typeof result.disabled_reasons === 'object' ? result.disabled_reasons : {},
          variant_disabled_reasons: result?.variant_disabled_reasons && typeof result.variant_disabled_reasons === 'object' ? result.variant_disabled_reasons : {},
          missing: result?.missing === true,
          test_admin: result?.test_admin === true,
          loaded_at: new Date().toISOString()
        };
        return cache;
      },
      has(group, flag){
        const groupKey = cleanText(group);
        const flagKey = cleanText(flag);
        const effective = cache?.effective?.[groupKey]?.[flagKey];
        if (typeof effective === 'boolean') return effective;
        const raw = cache?.raw?.[groupKey]?.[flagKey];
        if (typeof raw === 'boolean') return raw;
        if (hasIn(cache?.enabled, groupKey, flagKey)) return true;
        return false;
      },
      value(group, flag, fallback = null){
        const groupKey = cleanText(group);
        const flagKey = cleanText(flag);
        const effective = cache?.effective?.[groupKey]?.[flagKey];
        if (effective !== undefined) return effective;
        const raw = cache?.raw?.[groupKey]?.[flagKey];
        return raw !== undefined ? raw : fallback;
      },
      reason(group, flag){
        return cache?.disabled_reasons?.[`${cleanText(group)}.${cleanText(flag)}`] || null;
      },
      variant(family, fallback = null){
        const key = cleanText(family);
        const effective = cache?.effective_variants?.[key];
        if (effective !== undefined && effective !== null && effective !== '') return effective;
        const raw = cache?.raw_variants?.[key];
        return raw !== undefined && raw !== null && raw !== '' ? raw : fallback;
      },
      variantReason(family){
        return cache?.variant_disabled_reasons?.[cleanText(family)] || null;
      },
      any(pairs = []){
        return pairs.some((pair) => Array.isArray(pair) && hasIn(cache?.enabled, cleanText(pair[0]), cleanText(pair[1])));
      }
    };
  })();

  const mediaFields = {
    list(doc, field = 'media'){
      const list = doc?.[field];
      return Array.isArray(list) ? list.map(media.normalizeReference).filter((item) => item.media_id) : [];
    },
    setList(doc, field, references){
      return {
        ...(doc || {}),
        [field]: (Array.isArray(references) ? references : []).map(media.normalizeReference).filter((item) => item.media_id),
        updated_at: new Date().toISOString()
      };
    },
    upsert(doc, field, reference){
      const next = media.normalizeReference(reference);
      const list = mediaFields.list(doc, field);
      const idx = list.findIndex((item) => item.media_id === next.media_id);
      if (idx >= 0) list[idx] = { ...list[idx], ...next };
      else list.push(next);
      return mediaFields.setList(doc, field, list);
    },
    remove(doc, field, mediaId){
      const id = cleanText(mediaId);
      return mediaFields.setList(doc, field, mediaFields.list(doc, field).filter((item) => item.media_id !== id));
    },
    setMarkup(doc, field, mediaId, layerId, markup){
      const id = cleanText(mediaId);
      const layer = media.markupLayerId(layerId);
      const list = mediaFields.list(doc, field).map((item) => {
        if (item.media_id !== id) return item;
        return {
          ...item,
          markup: {
            ...(item.markup || {}),
            [layer]: {
              layer_id: layer,
              data: markup || {},
              updated_at: new Date().toISOString()
            }
          }
        };
      });
      return mediaFields.setList(doc, field, list);
    }
  };

  const documents = {
    collectionName: normalizeCollection,
    ownerTypeForCollection,
    list(orgId, collection){
      return collectionMethods(normalizeCollection(collection)).list(orgId);
    },
    get(orgId, collection, id){
      return collectionMethods(normalizeCollection(collection)).get(orgId, id);
    },
    async getData(orgId, collection, id){
      return (await documents.get(orgId, collection, id))?.document?.data || null;
    },
    save(orgId, collection, id, data, metadata = {}) {
      return collectionMethods(normalizeCollection(collection)).save(orgId, id, data || {}, metadata || {});
    },
    patch(orgId, collection, id, data, metadata = {}) {
      return collectionMethods(normalizeCollection(collection)).patch(orgId, id, data || {}, metadata || {});
    },
    remove(orgId, collection, id){
      return collectionMethods(normalizeCollection(collection)).remove(orgId, id);
    },
    /*
     * Save arbitrary loose fields to a core document.
     *
     * Top-level fields use PATCH, so this is cheap:
     *   await PlatformAPI.documents.setField(orgId, 'projects', projectId, 'end_date', '2026-06-01')
     *
     * Dot paths are supported for convenience. Dot paths fetch the current document
     * and PUT the full data object because the server only shallow-merges PATCH.
     */
    async setField(orgId, collection, id, field, value, metadata = {}) {
      if (!fieldPathIsNested(field)) {
        return documents.patch(orgId, collection, id, { [cleanText(field)]: value }, metadata);
      }
      const current = await documents.getData(orgId, collection, id) || {};
      return documents.save(orgId, collection, id, setByPath(current, field, value), metadata);
    },
    async patchFields(orgId, collection, id, fields, metadata = {}) {
      const patch = objectValue(fields);
      const nestedKeys = Object.keys(patch).filter(fieldPathIsNested);
      if (!nestedKeys.length) return documents.patch(orgId, collection, id, patch, metadata);
      let current = await documents.getData(orgId, collection, id) || {};
      Object.entries(patch).forEach(([field, value]) => {
        current = setByPath(current, field, value);
      });
      return documents.save(orgId, collection, id, current, metadata);
    },
    async removeField(orgId, collection, id, field, metadata = {}) {
      const current = await documents.getData(orgId, collection, id) || {};
      return documents.save(orgId, collection, id, removeByPath(current, field), metadata);
    },
    getField(dataOrDocument, field, fallback = undefined) {
      const data = dataOrDocument?.data && typeof dataOrDocument.data === 'object' ? dataOrDocument.data : dataOrDocument;
      return getByPath(data, field, fallback);
    },
    fieldFileReference(dataOrDocument, field){
      const value = documents.getField(dataOrDocument, field, null);
      if (Array.isArray(value)) return value.map(media.normalizeReference).filter((item) => item.media_id);
      return value && typeof value === 'object' ? media.normalizeReference(value) : null;
    },
    fieldFileUrl(orgId, dataOrReference, fieldOrVariant = null, variant = null){
      const isDocumentLike = fieldOrVariant && typeof dataOrReference === 'object' && !dataOrReference.media_id;
      let reference = isDocumentLike ? documents.fieldFileReference(dataOrReference, fieldOrVariant) : dataOrReference;
      if (Array.isArray(reference)) reference = reference[0] || null;
      const selectedVariant = isDocumentLike ? variant : (fieldOrVariant || variant);
      return reference ? media.fileUrlFromReference(orgId, reference, selectedVariant) : '';
    },
    /*
     * Upload a file and save its media reference onto a document field.
     *
     * Server upload fields generated here:
     *   owner_type: singular collection name, e.g. project/user/branch
     *   owner_id: document id
     *   slot: the field name, e.g. supplier_materials_pdf
     *   collection: projects/users/branch
     *   replace_slot: true for single-file fields, false for append-list fields
     *
     * options.mode:
     *   'single'       -> field = reference
     *   'append'       -> field = [...existingReferences, reference]
     *   'replace_list' -> field = [reference]
     */
    async uploadFieldFile(orgId, collection, id, field, file, options = {}) {
      const normalizedCollection = normalizeCollection(collection);
      const mode = options.mode || (options.append || options.multiple ? 'append' : 'single');
      const owner = {
        collection: normalizedCollection,
        id,
        field: cleanText(field)
      };
      const upload = await media.upload(orgId, file, {
        ownerType: options.ownerType || ownerTypeForCollection(normalizedCollection),
        ownerId: id,
        slot: cleanText(field),
        collection: normalizedCollection,
        scope: options.scope || normalizedCollection,
        replaceSlot: options.replaceSlot ?? mode === 'single',
        thumbnails: options.thumbnails,
        compression: options.compression,
        markup: options.markup,
        metadata: {
          field: cleanText(field),
          document_collection: normalizedCollection,
          document_id: id,
          ...(options.mediaMetadata || options.metadata || {})
        },
        processing: options.processing,
        fileField: options.fileField
      });
      const reference = media.referenceFromUpload(upload, {
        owner,
        field: cleanText(field),
        metadata: options.referenceMetadata || {}
      });
      const current = await documents.getData(orgId, normalizedCollection, id) || {};
      let nextValue = reference;
      if (mode === 'append') {
        const currentValue = documents.getField(current, field, null);
        const currentList = Array.isArray(currentValue)
          ? currentValue.map(media.normalizeReference).filter((item) => item.media_id)
          : currentValue && typeof currentValue === 'object'
            ? [media.normalizeReference(currentValue)].filter((item) => item.media_id)
            : [];
        nextValue = [...currentList, reference];
      } else if (mode === 'replace_list') {
        nextValue = [reference];
      }
      const saved = await documents.setField(orgId, normalizedCollection, id, field, nextValue, {
        kind: `${ownerTypeForCollection(normalizedCollection)}_file_reference`,
        field: cleanText(field),
        ...(options.documentMetadata || {})
      });
      return { ok: true, upload, media: upload.media, reference, document: saved.document };
    }
  };

  async function readDocumentData(collectionApi, orgId, id){
    const result = await collectionApi.get(orgId, id);
    return result?.document?.data || null;
  }

  function firstText(...values){
    for (const value of values) {
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }

  function measurementProjectId(project = {}){
    const measurement = project?.measurement_project && typeof project.measurement_project === 'object'
      ? project.measurement_project
      : (project?.measurement && typeof project.measurement === 'object' ? project.measurement : {});
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    return firstText(measurement.id, measurement.project_id, raw.id, raw.project_id, project.measurement_project_id, project.project_id, project.folder);
  }

  function firstMeasurePath(options, path){
    if (typeof options.firstMeasureUrlBuilder === 'function') return options.firstMeasureUrlBuilder(path);
    const base = cleanText(options.firstMeasureBaseUrl).replace(/\/+$/, '');
    return base ? `${base}/${String(path || '').replace(/^\/+/, '')}` : '';
  }

  function firstMeasureTopDownSource(project = {}){
    const measurement = project?.measurement_project && typeof project.measurement_project === 'object'
      ? project.measurement_project
      : (project?.measurement && typeof project.measurement === 'object' ? project.measurement : {});
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const artifacts = raw?.artifacts && typeof raw.artifacts === 'object' ? raw.artifacts : {};
    const assets = raw?.assets && typeof raw.assets === 'object' ? raw.assets : {};
    const direct = firstText(raw.thumbnail_source, raw.thumbnail_artifact_name, project.thumbnail_source, project.thumbnail_artifact_name);
    if (direct) return direct;
    if (artifacts.has_azure_image || assets.azure) return 'azure.png';
    if (artifacts.has_apple_image || assets.apple) return 'apple.png';
    if (artifacts.has_google_image || assets.google) return 'google.png';
    return 'google.png';
  }

  function finiteCoord(value){
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function projectThumbnailPoint(project = {}){
    const measurement = project?.measurement_project && typeof project.measurement_project === 'object'
      ? project.measurement_project
      : (project?.measurement && typeof project.measurement === 'object' ? project.measurement : {});
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const candidates = [project, raw, measurement];
    for (const candidate of candidates) {
      const lat = finiteCoord(candidate?.lat ?? candidate?.latitude);
      const lng = finiteCoord(candidate?.lng ?? candidate?.longitude);
      if (lat != null && lng != null) return { lat, lng };
    }
    const pinSources = [project.pins, raw.pins, measurement.pins];
    for (const pins of pinSources) {
      if (!Array.isArray(pins)) continue;
      for (const pin of pins) {
        const lat = finiteCoord(pin?.lat ?? pin?.latitude);
        const lng = finiteCoord(pin?.lng ?? pin?.longitude);
        if (lat != null && lng != null) return { lat, lng };
      }
    }
    return null;
  }

  function projectThumbnailAddress(project = {}){
    const measurement = project?.measurement_project && typeof project.measurement_project === 'object'
      ? project.measurement_project
      : (project?.measurement && typeof project.measurement === 'object' ? project.measurement : {});
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    return firstText(project.address, project.project_address, raw.address, raw.project_address, measurement.address);
  }

  function googleStaticMapUrl(project = {}, options = {}){
    const key = firstText(options.googleMapsApiKey, options.googleMapsKey);
    if (!key) return '';
    const point = projectThumbnailPoint(project);
    const address = projectThumbnailAddress(project);
    if (!point && !address) return '';
    const width = Math.max(160, Math.min(640, Number(options.staticMapWidth || options.width || 640) || 640));
    const height = Math.max(120, Math.min(640, Number(options.staticMapHeight || Math.round(width * 0.62)) || 400));
    const center = point ? `${point.lat},${point.lng}` : address;
    const marker = point ? `${point.lat},${point.lng}` : address;
    const params = new URLSearchParams({
      center,
      zoom: String(options.staticMapZoom || 20),
      size: `${Math.round(width)}x${Math.round(height)}`,
      scale: String(options.staticMapScale || 2),
      maptype: options.staticMapType || 'satellite',
      markers: `color:red|${marker}`,
      key
    });
    return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
  }

  function photoIdentity(photo = {}, fallback = '') {
    const ref = photo && typeof photo === 'object' ? photo : {};
    return cleanText(ref.id, ref.photo_id, ref.media_id, ref.src, ref.url, fallback);
  }
  function mediaKind(ref = {}, file = null){
    const metadata = ref?.metadata && typeof ref.metadata === 'object' ? ref.metadata : {};
    const explicit = firstText(ref.media_type, ref.mediaType, ref.type, metadata.media_type, metadata.mediaType, metadata.type).toLowerCase();
    if (explicit.startsWith('video')) return 'video';
    if (explicit.startsWith('image')) return 'image';
    const mime = firstText(file?.type, ref.mime_type, ref.mimeType, ref.content_type, ref.contentType, metadata.mime_type, metadata.mimeType, metadata.content_type, metadata.contentType).toLowerCase();
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('image/')) return 'image';
    const name = firstText(file?.name, ref.name, ref.label, ref.src, ref.url, metadata.file_name, metadata.name).toLowerCase();
    if (/\.(mp4|mov|m4v|webm|avi|mkv|ogv)(?:[?#].*)?$/.test(name)) return 'video';
    return 'image';
  }

  const projectDocuments = {
    list(orgId, projectId){
      return request(orgPath(orgId, `/projects/${enc(projectId)}/documents`));
    },
    upload(orgId, projectId, file, options = {}){
      const fd = new FormData();
      fd.append('file', file);
      fd.append('metadata', JSON.stringify({
        title: options.title || file?.name || '',
        label: options.label || options.title || file?.name || '',
        document_type: options.document_type || options.type || 'document',
        source: options.source || 'project_document_upload',
        ...(options.metadata || {})
      }));
      if (options.id) fd.append('id', options.id);
      return request(orgPath(orgId, `/projects/${enc(projectId)}/documents`), {
        method: 'POST',
        body: fd
      });
    },
    patch(orgId, projectId, documentId, patch = {}){
      return request(orgPath(orgId, `/projects/${enc(projectId)}/documents/${enc(documentId)}`), {
        method: 'PATCH',
        body: patch || {}
      });
    },
    remove(orgId, projectId, documentId){
      return request(orgPath(orgId, `/projects/${enc(projectId)}/documents/${enc(documentId)}`), {
        method: 'DELETE'
      });
    }
  };

  const projectMedia = {
    TOP_DOWN_THUMBNAIL_ID: 'top_down_thumbnail',
    TOP_DOWN_THUMBNAIL_DESIGNATOR: 'top_down_thumbnail',
    mediaKind,
    isVideo(reference = {}){ return mediaKind(reference) === 'video'; },
    isImage(reference = {}){ return mediaKind(reference) !== 'video'; },
    normalizePhoto(photo = {}, options = {}) {
      const index = Number.isFinite(options.index) ? options.index : 0;
      if (typeof File !== 'undefined' && photo instanceof File) {
        const src = URL.createObjectURL(photo);
        const kind = mediaKind({}, photo);
        return {
          id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          kind: 'local_file',
          media_type: kind,
          mime_type: photo.type || '',
          src,
          thumb: src,
          alt: photo.name || `${kind === 'video' ? 'Video' : 'Photo'} ${index + 1}`,
          label: photo.name || `${kind === 'video' ? 'Video' : 'Photo'} ${index + 1}`,
          file: photo,
          metadata: { source: 'local_file', media_type: kind, mime_type: photo.type || '' }
        };
      }
      if (typeof photo === 'string') {
        return {
          id: photo,
          kind: 'external_image',
          src: photo,
          thumb: photo,
          alt: `Photo ${index + 1}`,
          label: `Photo ${index + 1}`,
          metadata: {}
        };
      }
      const ref = photo && typeof photo === 'object' ? photo : {};
      const orgId = cleanText(options.orgId);
      const metadata = ref.metadata && typeof ref.metadata === 'object' ? ref.metadata : {};
      const mediaId = cleanText(ref.media_id || ref.mediaId);
      const type = mediaKind(ref);
      const src = firstText(ref.src, ref.url, mediaId && orgId ? media.fileUrl(orgId, mediaId, ref.variant || 'original') : '');
      const thumb = firstText(
        ref.thumb,
        ref.thumbnail,
        mediaId && orgId ? media.fileUrl(orgId, mediaId, metadata.thumbnail_variant || 'thumb_320') : '',
        src
      );
      const id = firstText(ref.id, ref.photo_id, mediaId, src, `photo_${index + 1}`);
      return {
        ...ref,
        id,
        photo_id: id,
        media_id: mediaId || ref.media_id,
        media_type: type,
        mime_type: firstText(ref.mime_type, ref.mimeType, ref.content_type, ref.contentType, metadata.mime_type, metadata.mimeType, metadata.content_type, metadata.contentType),
        kind: ref.kind || (mediaId ? 'media_reference' : 'external_image'),
        src,
        thumb,
        alt: firstText(ref.alt, ref.label, metadata.alt, metadata.label, `${type === 'video' ? 'Video' : 'Photo'} ${index + 1}`),
        label: firstText(ref.label, ref.alt, metadata.label, metadata.alt, `${type === 'video' ? 'Video' : 'Photo'} ${index + 1}`),
        designator: firstText(ref.designator, metadata.designator),
        role: firstText(ref.role, metadata.role),
        source: firstText(ref.source, metadata.source),
        is_thumbnail: !!(ref.is_thumbnail || ref.is_default_thumbnail || metadata.is_thumbnail || metadata.is_default_thumbnail),
        is_top_down_thumbnail: !!(ref.is_top_down_thumbnail || metadata.is_top_down_thumbnail || firstText(ref.designator, metadata.designator) === projectMedia.TOP_DOWN_THUMBNAIL_DESIGNATOR),
        markup: ref.markup && typeof ref.markup === 'object' ? ref.markup : {},
        metadata: { ...metadata, media_type: firstText(metadata.media_type, type) }
      };
    },
    normalizePhotos(photos = [], options = {}) {
      return (Array.isArray(photos) ? photos : [])
        .map((photo, index) => projectMedia.normalizePhoto(photo, { ...options, index }))
        .filter((photo) => photo.src || photo.thumb || photo.media_id);
    },
    firstMeasureTopDownPhoto(project = {}, options = {}) {
      const firstMeasureId = measurementProjectId(project);
      if (!firstMeasureId) return null;
      const source = firstMeasureTopDownSource(project);
      const thumb = firstMeasurePath(options, `projects/${enc(firstMeasureId)}/thumbnail?w=${enc(options.width || 640)}&source=${enc(source)}`);
      const src = firstMeasurePath(options, `projects/${enc(firstMeasureId)}/artifacts/${enc(source)}`);
      if (!thumb && !src) return null;
      return projectMedia.normalizePhoto({
        id: projectMedia.TOP_DOWN_THUMBNAIL_ID,
        kind: 'external_image',
        source: 'firstmeasure',
        designator: projectMedia.TOP_DOWN_THUMBNAIL_DESIGNATOR,
        role: 'thumbnail',
        is_thumbnail: true,
        is_default_thumbnail: true,
        is_top_down_thumbnail: true,
        firstmeasure_project_id: firstMeasureId,
        source_artifact: source,
        src: src || thumb,
        thumb: src || thumb,
        alt: 'Top-down satellite image',
        label: 'Top-down satellite',
        metadata: {
          source: 'firstmeasure',
          designator: projectMedia.TOP_DOWN_THUMBNAIL_DESIGNATOR,
          role: 'thumbnail',
          is_thumbnail: true,
          is_default_thumbnail: true,
          is_top_down_thumbnail: true,
          firstmeasure_project_id: firstMeasureId,
          source_artifact: source
        }
      }, options);
    },
    googleStaticMapPhoto(project = {}, options = {}) {
      const src = googleStaticMapUrl(project, options);
      if (!src) return null;
      return projectMedia.normalizePhoto({
        id: projectMedia.TOP_DOWN_THUMBNAIL_ID,
        kind: 'external_image',
        source: 'google_static_map',
        designator: projectMedia.TOP_DOWN_THUMBNAIL_DESIGNATOR,
        role: 'thumbnail',
        is_thumbnail: true,
        is_default_thumbnail: true,
        is_top_down_thumbnail: true,
        src,
        thumb: src,
        alt: 'Property satellite image',
        label: 'Property satellite',
        metadata: {
          source: 'google_static_map',
          designator: projectMedia.TOP_DOWN_THUMBNAIL_DESIGNATOR,
          role: 'thumbnail',
          is_thumbnail: true,
          is_default_thumbnail: true,
          is_top_down_thumbnail: true
        }
      }, options);
    },
    withFirstMeasureTopDown(project = {}, options = {}) {
      const photos = projectMedia.normalizePhotos(project.photos || [], options);
      const topDown = projectMedia.firstMeasureTopDownPhoto(project, options) || projectMedia.googleStaticMapPhoto(project, options);
      if (!topDown) return photos;
      const existingIndex = photos.findIndex((photo) => (
        photo.is_top_down_thumbnail
        || photo.designator === projectMedia.TOP_DOWN_THUMBNAIL_DESIGNATOR
        || photo.id === projectMedia.TOP_DOWN_THUMBNAIL_ID
      ));
      if (existingIndex >= 0) {
        photos[existingIndex] = { ...photos[existingIndex], ...topDown, is_top_down_thumbnail: true, designator: projectMedia.TOP_DOWN_THUMBNAIL_DESIGNATOR };
      } else {
        photos.unshift(topDown);
      }
      return projectMedia.ensureThumbnail(photos, project.thumbnail_photo_id || project.thumbnailPhotoId || project.thumbnail_id);
    },
    ensureThumbnail(photos = [], thumbnailId = '') {
      const normalized = projectMedia.normalizePhotos(photos);
      if (!normalized.length) return normalized;
      const targetId = cleanText(thumbnailId)
        || photoIdentity(normalized.find((photo) => photo.is_thumbnail || photo.is_default_thumbnail), '')
        || photoIdentity(normalized.find((photo) => photo.is_top_down_thumbnail), '')
        || photoIdentity(normalized[0], '');
      return normalized.map((photo) => {
        const isTarget = photoIdentity(photo) === targetId;
        return { ...photo, is_thumbnail: isTarget, is_default_thumbnail: isTarget };
      });
    },
    thumbnailPhoto(photos = [], thumbnailId = '') {
      const normalized = projectMedia.ensureThumbnail(photos, thumbnailId);
      return normalized.find((photo) => photo.is_thumbnail || photo.is_default_thumbnail)
        || normalized.find((photo) => photo.is_top_down_thumbnail)
        || normalized[0]
        || null;
    },
    setThumbnail(photos = [], photoId = '') {
      return projectMedia.ensureThumbnail(photos, photoId);
    },
    hydrateProjectPhotos(project = {}, options = {}) {
      const photos = projectMedia.withFirstMeasureTopDown(project, options);
      const thumbnail = projectMedia.thumbnailPhoto(photos, project.thumbnail_photo_id || project.thumbnailPhotoId || project.thumbnail_id);
      return {
        ...(project || {}),
        photos,
        thumbnail_photo_id: photoIdentity(thumbnail),
        thumbnail_photo: thumbnail || null
      };
    },
    async listPhotos(orgId, projectId){
      return projectMedia.normalizePhotos((await readDocumentData(api.projects, orgId, projectId))?.photos || [], { orgId });
    },
    async savePhotos(orgId, projectId, project, photos, metadata = {}){
      const normalized = projectMedia.ensureThumbnail(photos, project?.thumbnail_photo_id || project?.thumbnailPhotoId || project?.thumbnail_id);
      const thumbnail = projectMedia.thumbnailPhoto(normalized);
      return api.projects.save(orgId, projectId, {
        ...(project || {}),
        photos: normalized,
        thumbnail_photo_id: photoIdentity(thumbnail),
        thumbnail_photo: thumbnail || null,
        updated_at: new Date().toISOString()
      }, metadata);
    },
    async upsertPhoto(orgId, projectId, project, reference, metadata = {}){
      const current = projectMedia.normalizePhotos(project?.photos || [], { orgId });
      const next = projectMedia.normalizePhoto(reference, { orgId, index: current.length });
      const idx = current.findIndex((item) => photoIdentity(item) === photoIdentity(next));
      if (idx >= 0) current[idx] = { ...current[idx], ...next };
      else current.push(next);
      return projectMedia.savePhotos(orgId, projectId, project, current, metadata);
    },
    async uploadMedia(orgId, projectId, project, file, options = {}) {
      const type = mediaKind({}, file);
      const upload = await media.upload(orgId, file, {
        ownerType: 'project',
        ownerId: projectId,
        slot: 'photos',
        collection: 'projects',
        scope: 'projects',
        replaceSlot: false,
        thumbnails: options.thumbnails ?? true,
        compression: type === 'video' ? undefined : options.compression,
        markup: options.markup,
        metadata: {
          field: 'photos',
          document_collection: 'projects',
          document_id: projectId,
          source: options.source || (type === 'video' ? 'project_video_upload' : 'project_photo_upload'),
          media_type: type,
          mime_type: file?.type || '',
          uploaded_by_name: cleanText(APP.userName || root.Portal?.cfg?.userName || ''),
          uploaded_by_email: cleanText(APP.userEmail || root.Portal?.cfg?.userEmail || ''),
          uploaded_by_user_id: cleanText(APP.userId || APP.user_id || root.Portal?.currentUser?.id || ''),
          uploaded_at: new Date().toISOString(),
          ...(options.mediaMetadata || options.metadata || {})
        },
        processing: options.processing,
        fileField: options.fileField
      });
      const reference = media.referenceFromUpload(upload, {
        owner: { collection: 'projects', id: projectId, field: 'photos' },
        field: 'photos',
        metadata: {
          source: options.source || (type === 'video' ? 'project_video_upload' : 'project_photo_upload'),
          media_type: type,
          mime_type: file?.type || '',
          uploaded_by_name: cleanText(APP.userName || root.Portal?.cfg?.userName || ''),
          uploaded_by_email: cleanText(APP.userEmail || root.Portal?.cfg?.userEmail || ''),
          uploaded_by_user_id: cleanText(APP.userId || APP.user_id || root.Portal?.currentUser?.id || ''),
          uploaded_at: new Date().toISOString(),
          ...(options.referenceMetadata || {})
        }
      });
      const storageBytes = Number(upload?.media?.size_bytes || upload?.size_bytes || file?.size || 0);
      if (storageBytes > 0 && options.trackStorage !== false) {
        await mediaStorage.increment(orgId, storageBytes, {
          source: options.source || (type === 'video' ? 'project_video_upload' : 'project_photo_upload'),
          project_id: projectId,
          media_id: upload?.media?.id || upload?.media?.media_id || upload?.id || '',
          file_name: file?.name || ''
        }).catch(() => null);
      }
      const photo = projectMedia.normalizePhoto({
        ...reference,
        id: reference.media_id,
        media_type: type,
        mime_type: file?.type || '',
        label: options.label || file?.name || (type === 'video' ? 'Project video' : 'Project photo'),
        alt: options.alt || file?.name || (type === 'video' ? 'Project video' : 'Project photo'),
      }, { orgId });
      const saved = await projectMedia.upsertPhoto(orgId, projectId, project, photo, {
        source: options.source || (type === 'video' ? 'project_video_upload' : 'project_photo_upload'),
        ...(options.documentMetadata || {})
      });
      return { ok: true, upload, media: upload.media, reference, photo, document: saved.document };
    },
    async uploadPhoto(orgId, projectId, project, file, options = {}) {
      return projectMedia.uploadMedia(orgId, projectId, project, file, options);
    },
    async uploadVideo(orgId, projectId, project, file, options = {}) {
      const safeOptions = options && typeof options === 'object' ? options : {};
      return projectMedia.uploadMedia(orgId, projectId, project, file, { ...safeOptions, source: safeOptions.source || 'project_video_upload' });
    },
    listMedia(orgId, projectId){ return projectMedia.listPhotos(orgId, projectId); },
    saveMedia(orgId, projectId, project, mediaItems, metadata = {}){ return projectMedia.savePhotos(orgId, projectId, project, mediaItems, metadata); },
    upsertMedia(orgId, projectId, project, reference, metadata = {}){ return projectMedia.upsertPhoto(orgId, projectId, project, reference, metadata); },
    removeMedia(orgId, projectId, project, mediaId, metadata = {}){ return projectMedia.removePhoto(orgId, projectId, project, mediaId, metadata); },
    async removePhoto(orgId, projectId, project, mediaId, metadata = {}){
      const id = cleanText(mediaId);
      return projectMedia.savePhotos(orgId, projectId, project, projectMedia.normalizePhotos(project?.photos || [], { orgId }).filter((item) => photoIdentity(item) !== id && item.media_id !== id), metadata);
    },
    async savePhotoMarkup(orgId, projectId, project, mediaId, layerId, markup, metadata = {}){
      const id = cleanText(mediaId);
      const layer = media.markupLayerId(layerId);
      const photos = projectMedia.normalizePhotos(project?.photos || [], { orgId }).map((item) => {
        if (photoIdentity(item) !== id && item.media_id !== id) return item;
        return {
          ...item,
          markup: {
            ...(item.markup || {}),
            [layer]: {
              layer_id: layer,
              data: markup || {},
              updated_at: new Date().toISOString()
            }
          }
        };
      });
      return projectMedia.savePhotos(orgId, projectId, project, photos, metadata);
    }
  };

  const dashboard = (() => {
    const MODULE_ID = 'dashboard';
    const DEFAULT_STATS = [
      { id: 'sales_made', label: 'Sales', icon: 'fa-handshake' },
      { id: 'revenue', label: 'Revenue', icon: 'fa-dollar-sign' },
      { id: 'appointments', label: 'Appointments', icon: 'fa-calendar-check' },
      { id: 'close_percentage', label: 'Close', icon: 'fa-chart-line' },
    ];
    const DEFAULT_GROUPS = [
      { id: 'tomorrow', label: "Tomorrow's Appointments", preset: 'tomorrow', collapsed_by_default: false },
      { id: 'today', label: "Today's Appointments", preset: 'today', collapsed_by_default: false },
    ];
    function toDate(value){
      const date = value instanceof Date ? value : new Date(value);
      return Number.isFinite(date.getTime()) ? date : null;
    }
    function startOfDay(date){
      const d = toDate(date) || new Date();
      d.setHours(0,0,0,0);
      return d;
    }
    function addDays(date, days){
      const d = startOfDay(date);
      d.setDate(d.getDate() + Number(days || 0));
      return d;
    }
    function localDayKey(date){
      const d = toDate(date);
      if (!d) return '';
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function utcDayKey(date){
      const d = toDate(date);
      return d ? d.toISOString().slice(0, 10) : '';
    }
    function sameDay(a, b){
      const aLocal = localDayKey(a);
      const bLocal = localDayKey(b);
      if (aLocal && bLocal && aLocal === bLocal) return true;
      const aUtc = utcDayKey(a);
      const bUtc = utcDayKey(b);
      return !!(aUtc && bUtc && aUtc === bUtc);
    }
    function inRange(date, start, end){
      const d = toDate(date); const s = toDate(start); const e = toDate(end);
      return !!(d && s && e && d >= s && d < e);
    }
    function money(value){
      const n = Number(String(value ?? '').replace(/[^0-9.-]+/g, ''));
      return Number.isFinite(n) ? n : 0;
    }
    function labelFromConfig(config, namespace, id){
      const value = cleanText(config?.mappings?.labels?.[namespace]?.[id]);
      return value || cleanText(id).replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
    }
    function eventStart(event){ return toDate(event?.start_at || event?.start || event?.starts_at); }
    function eventEnd(event){
      const start = eventStart(event);
      if (!start) return null;
      return toDate(event?.end_at || event?.end) || new Date(start.getTime() + (Number(event?.duration_minutes || event?.duration || 60) * 60000));
    }
    function projectStage(project, config){
      const id = cleanText(project?.stage || project?.stage_id || 'new_lead') || 'new_lead';
      return { id, label: project?.mapped_stage?.label || labelFromConfig(config, 'stages', id) };
    }
    function assignedLabel(event){
      const assigned = Array.isArray(event?.assigned_users) ? event.assigned_users : [];
      if (assigned.length) return assigned.map((user) => user.name || user.email || user.id).filter(Boolean).join(', ');
      const ids = Array.isArray(event?.assigned_user_ids) ? event.assigned_user_ids : [];
      return ids.length ? ids.join(', ') : 'Assign later';
    }
    function projectRevenue(project = {}){
      return money(project.revenue || project.sold_amount || project.contract_value || project.project_value || project.total || project.amount);
    }
    function soldDate(project = {}){
      return toDate(project.sold_at || project.closed_at || project.sale_date || project.completed_sale_at)
        || (Array.isArray(project.stage_history)
          ? toDate((project.stage_history || []).find((item) => /sold|closed|won/i.test(String(item?.to || item?.stage || '')))?.at)
          : null);
    }
    function isSold(project = {}){
      const stage = cleanText(project.stage || project.stage_id || project.status || '').toLowerCase();
      return /sold|closed_won|won|job_sold/.test(stage) || !!soldDate(project);
    }
    function appointmentRan(event, now = new Date()){
      const end = eventEnd(event);
      const status = cleanText(event?.status).toLowerCase();
      return ['completed','complete','done','ran','finished'].includes(status) || (end && end <= now);
    }
    function normalizeConfig(raw = {}){
      const data = objectValue(raw);
      const groups = Array.isArray(data.appointment_groups) && data.appointment_groups.length ? data.appointment_groups : DEFAULT_GROUPS;
      return {
        schema_version: 1,
        ...data,
        stats: Array.isArray(data.stats) && data.stats.length ? data.stats : DEFAULT_STATS,
        appointment_groups: groups.map(normalizeAppointmentGroup),
      };
    }
    function inferGroupPreset(group = {}){
      const key = cleanText(group.preset || group.id || group.label || group.title).toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (key.includes("tomorrow")) return "tomorrow";
      if (key.includes("today")) return "today";
      if (key.includes("future")) return "future";
      if (key.includes("past_due") || key.includes("pastdue")) return "past_due";
      return cleanText(group.preset);
    }
    function normalizeAppointmentGroup(group = {}){
      const preset = inferGroupPreset(group);
      return {
        ...group,
        id: cleanText(group.id || preset || group.label),
        label: cleanText(group.label || group.title || group.id || preset),
        preset,
        collapsed_by_default: group.collapsed_by_default === true,
      };
    }
    async function loadConfig(orgId, branchId = 'default', options = {}){
      let raw = null;
      let listedModules = false;
      if (options.ensureDefaults !== false && api.branchModules?.list) {
        try {
          const modules = await api.branchModules.list(orgId, branchId);
          listedModules = true;
          const listed = (Array.isArray(modules) ? modules : []).find((module) => cleanText(module?.module || module?.id) === MODULE_ID);
          raw = listed?.data || listed || null;
        } catch (error) {}
      }
      if (!raw && !listedModules) {
        try {
          const module = await api.branchModules.get(orgId, branchId, MODULE_ID);
          raw = module?.data || module || null;
        } catch (error) {}
      }
      const config = normalizeConfig(raw || {});
      if (!raw && options.ensureDefaults !== false) {
        api.branchModules.save(orgId, branchId, MODULE_ID, config, { kind: 'branch_dashboard' }).catch(() => null);
      }
      return config;
    }
    function eventProject(event, projects){
      return (Array.isArray(projects) ? projects : []).find((project) => String(project.id) === String(event?.project_id)) || {};
    }
    function eventTile(event, projects, schedulingConfig = null){
      const project = eventProject(event, projects);
      const stage = projectStage(project, schedulingConfig);
      return { event, project, stage, salesperson: assignedLabel(event), start_at: eventStart(event)?.toISOString() || '' };
    }
    function groupEventsForPreset(events, preset, now = new Date()){
      if (preset === 'today') return events.filter((event) => sameDay(eventStart(event), now));
      if (preset === 'tomorrow') return events.filter((event) => sameDay(eventStart(event), addDays(now, 1)));
      if (preset === 'future') return events.filter((event) => (eventStart(event) || 0) >= addDays(now, 2));
      if (preset === 'past_due') return events.filter((event) => (eventEnd(event) || 0) < startOfDay(now) && !appointmentRan(event, now));
      return [];
    }
    function getDashboardProjectGroups({ projects = [], events = [], dashboardConfig = {}, schedulingConfig = {}, now = new Date() } = {}){
      const config = normalizeConfig(dashboardConfig);
      return config.appointment_groups.map((group) => {
        let groupEvents = [];
        if (group.preset) groupEvents = groupEventsForPreset(events, group.preset, now);
        else if (group.start_offset_days != null || group.end_offset_days != null) {
          const start = addDays(now, Number(group.start_offset_days || 0));
          const end = addDays(now, Number(group.end_offset_days ?? Number(group.start_offset_days || 0) + 1));
          groupEvents = events.filter((event) => inRange(eventStart(event), start, end));
        }
        groupEvents = groupEvents.sort((a, b) => (eventStart(a) || 0) - (eventStart(b) || 0));
        return {
          ...group,
          id: cleanText(group.id || group.preset || group.label),
          label: cleanText(group.label || group.title || group.id),
          collapsed_by_default: group.collapsed_by_default === true,
          items: groupEvents.map((event) => eventTile(event, projects, schedulingConfig)),
        };
      });
    }
    function statsForRange({ projects = [], events = [], start, end, now = new Date() } = {}){
      const rangeEvents = (Array.isArray(events) ? events : []).filter((event) => inRange(eventStart(event), start, end));
      const ranEvents = rangeEvents.filter((event) => appointmentRan(event, now));
      const soldProjects = (Array.isArray(projects) ? projects : []).filter((project) => {
        const date = soldDate(project);
        return isSold(project) && (!date || inRange(date, start, end));
      });
      const sales = soldProjects.length;
      const revenue = soldProjects.reduce((sum, project) => sum + projectRevenue(project), 0);
      const close = ranEvents.length ? Math.round((sales / ranEvents.length) * 100) : 0;
      return {
        sales_made: sales,
        revenue,
        appointments: { ran: ranEvents.length, total: rangeEvents.length },
        close_percentage: close,
      };
    }
    function formatStatValue(statId, value){
      if (statId === 'revenue') return `$${Math.round(Number(value || 0)).toLocaleString()}`;
      if (statId === 'appointments') return `${Number(value?.ran || 0)}/${Number(value?.total || 0)}`;
      if (statId === 'close_percentage') return `${Number(value || 0)}%`;
      return String(value ?? 0);
    }
    return {
      defaultStats(){ return DEFAULT_STATS.map((item) => ({ ...item })); },
      defaultGroups(){ return DEFAULT_GROUPS.map((item) => ({ ...item })); },
      loadConfig,
      normalizeConfig,
      getDashboardProjectGroups,
      statsForRange,
      formatStatValue,
      appointmentRan,
    };
  })();

  const branchModuleListCache = new Map();
  const branchModuleListPending = new Map();
  const customerPortals = {
    get(orgId, projectId){
      return request(orgPath(orgId, `/projects/${enc(projectId)}/customer-portal`));
    },
    ensure(orgId, projectId, data = {}){
      return request(orgPath(orgId, `/projects/${enc(projectId)}/customer-portal`), {
        method: 'POST',
        body: data || {}
      });
    },
    update(orgId, projectId, data = {}){
      return request(orgPath(orgId, `/projects/${enc(projectId)}/customer-portal`), {
        method: 'PATCH',
        body: data || {}
      });
    },
    shareMedia(orgId, projectId, mediaIds = []){
      return customerPortals.update(orgId, projectId, { share_media_ids: Array.isArray(mediaIds) ? mediaIds : [mediaIds] });
    },
    unshareMedia(orgId, projectId, mediaIds = []){
      return customerPortals.update(orgId, projectId, { unshare_media_ids: Array.isArray(mediaIds) ? mediaIds : [mediaIds] });
    },
    activity(orgId, projectId){
      return request(orgPath(orgId, `/projects/${enc(projectId)}/customer-portal/activity`));
    },
    publicGet(portalUuid, options = {}){
      const preview = options.preview === true;
      const path = preview ? `/customer-portals/preview/${enc(portalUuid)}` : `/customer-portals/${enc(portalUuid)}`;
      return request(path, { credentials: preview ? 'include' : 'same-origin' });
    },
    publicTrack(portalUuid, event = {}){
      return request(`/customer-portals/${enc(portalUuid)}/events`, {
        method: 'POST',
        credentials: 'same-origin',
        body: event || {}
      });
    },
    publicMediaUrl(portalUuid, mediaId, options = {}){
      const preview = options.preview === true;
      const variant = cleanText(options.variant || 'original') || 'original';
      const prefix = preview ? '/customer-portals/preview' : '/customer-portals';
      return url(`${prefix}/${enc(portalUuid)}/media/${enc(mediaId)}/file?variant=${enc(variant)}`);
    }
  };
  function branchModuleListKey(orgId, branchId){
    return `${cleanText(orgId)}::${cleanText(branchId || 'default')}`;
  }
  function normalizeBranchModuleList(result){
    return Array.isArray(result?.modules) ? result.modules : (Array.isArray(result?.documents) ? result.documents : []);
  }

  function laborBaseUrl(){
    const platformBase = baseUrl();
    if (platformBase) return platformBase.replace(/\/v1\/platform\/?$/i, '/v1/labor').replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') return `${location.protocol}//${location.hostname}:3111/v1/labor`;
    return `${location.origin}/v1/labor`;
  }

  function laborPath(path = ''){
    return `${laborBaseUrl()}/${cleanText(path).replace(/^\/+/, '')}`;
  }

  const labor = {
    async crews(orgId, branchId = 'default'){
      return request(laborPath(`/organizations/${enc(orgId)}/branch/${enc(branchId || 'default')}/crews`));
    },
    async saveCrews(orgId, branchId = 'default', settings = {}){
      return request(laborPath(`/organizations/${enc(orgId)}/branch/${enc(branchId || 'default')}/crews`), {
        method: 'PUT',
        body: { settings }
      });
    },
    async upsertCrew(orgId, branchId = 'default', crew = {}){
      const id = cleanText(crew?.id);
      return request(laborPath(`/organizations/${enc(orgId)}/branch/${enc(branchId || 'default')}/crews${id ? `/${enc(id)}` : ''}`), {
        method: id ? 'PATCH' : 'POST',
        body: { crew }
      });
    },
    async archiveCrew(orgId, branchId = 'default', crewId){
      return request(laborPath(`/organizations/${enc(orgId)}/branch/${enc(branchId || 'default')}/crews/${enc(crewId)}`), {
        method: 'DELETE'
      });
    }
  };

  const api = {
    configure,
    baseUrl,
    url,
    request,
    auth,
    identities,
    orgs,
    credits,
    leads,
    tagging,
    search,
    notifications,
    actionItems,
    userActivity,
    customerPortals,
    branches,
    documents,
    projects: collectionMethods('projects', 'platform_project'),
    customers: collectionMethods('customers', 'customer'),
    users: {
      ...collectionMethods('users', 'organization_user'),
      ...orgUsers
    },
    notificationDocuments: collectionMethods('notifications', 'platform_notification'),
    actionItemDocuments: collectionMethods('action_items', 'platform_action_item'),
    activityDocuments: collectionMethods('activity', 'user_activity'),
    customerPortalDocuments: collectionMethods('customer_portals', 'customer_portal_access'),
    collection: collectionMethods,
    media,
    brandingMedia,
    mediaStorage,
    appFlags,
    mediaFields,
    labor,
    dashboard,
    projectDocuments,
    projectMedia,
    branchModules: {
      async list(orgId, branchId){
        const key = branchModuleListKey(orgId, branchId);
        if (branchModuleListCache.has(key)) return branchModuleListCache.get(key);
        if (branchModuleListPending.has(key)) return branchModuleListPending.get(key);
        const pending = branches.modules.list(orgId, branchId).then((result) => {
          const modules = normalizeBranchModuleList(result);
          branchModuleListCache.set(key, modules);
          return modules;
        }).finally(() => {
          branchModuleListPending.delete(key);
        });
        branchModuleListPending.set(key, pending);
        return pending;
      },
      async get(orgId, branchId, moduleId){
        if (api.branchModules?.list) {
          try {
            const modules = await api.branchModules.list(orgId, branchId);
            const found = modules.find((module) => cleanText(module?.module || module?.id) === cleanText(moduleId));
            if (!found) return null;
            return found;
          } catch (error) {
            return null;
          }
        }
        const data = await branches.modules.get(orgId, branchId, moduleId);
        return data?.module || null;
      },
      async save(orgId, branchId, moduleId, data, metadata = {}){
        const result = await branches.modules.save(orgId, branchId, moduleId, data, metadata);
        const module = result?.module || null;
        const key = branchModuleListKey(orgId, branchId);
        if (module && branchModuleListCache.has(key)) {
          const modules = branchModuleListCache.get(key).filter((item) => cleanText(item?.module || item?.id) !== cleanText(moduleId));
          modules.push(module);
          branchModuleListCache.set(key, modules);
        } else {
          branchModuleListCache.delete(key);
        }
        return module;
      }
    }
  };

  configure({ baseUrl: APP.platformApiBase || '' });
  root.PlatformAPI = api;
})();
