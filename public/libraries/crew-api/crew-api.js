/* public/libraries/crew-api/crew-api.js
 * Browser client for the assigned-work Crew facade under /v1/workforce.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl:'', defaultHeaders:{} };

  const clean = (value) => String(value ?? '').trim();
  const enc = (value) => encodeURIComponent(clean(value));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  function defaultBaseUrl(){
    if (APP.workforceApiBase) return clean(APP.workforceApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return clean(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/workforce').replace(/\/+$/, '');
    const host = clean(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/workforce`;
    return `${location.origin}/v1/workforce`;
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

  function url(path = ''){
    const raw = clean(path);
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${baseUrl()}/${raw.replace(/^\/+/, '')}`;
  }

  function cookieValue(name){
    const target = `${encodeURIComponent(name)}=`;
    return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(target))?.slice(target.length) || '';
  }

  function csrfToken(){
    return decodeURIComponent(cookieValue('fm_platform_session_csrf') || '');
  }

  function requestHeaders(options, body){
    const method = clean(options.method || 'GET').toUpperCase();
    const headers = {
      Accept:'application/json',
      ...state.defaultHeaders,
      ...(body != null && !(body instanceof FormData) ? { 'Content-Type':'application/json' } : {}),
      ...object(options.headers)
    };
    const csrf = csrfToken();
    if (csrf && !['GET','HEAD','OPTIONS'].includes(method) && !headers['X-Platform-CSRF']) headers['X-Platform-CSRF'] = csrf;
    return headers;
  }

  async function request(path, options = {}){
    const inputBody = options.body;
    const body = inputBody == null || inputBody instanceof FormData || typeof inputBody === 'string'
      ? inputBody
      : JSON.stringify(inputBody);
    const response = await fetch(url(path), {
      ...options,
      body,
      cache:options.cache || 'no-store',
      credentials:options.credentials || 'include',
      headers:requestHeaders(options, inputBody)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!response.ok || data?.ok === false) {
      const error = new Error(clean(data?.message || data?.error) || `Crew API request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  function orgPath(orgId, suffix = ''){
    return `/organizations/${enc(orgId)}${suffix}`;
  }

  function queryString(values = {}){
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      if (Array.isArray(value)) value.forEach((item) => params.append(key, clean(item)));
      else params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : clean(value));
    });
    const query = params.toString();
    return query ? `?${query}` : '';
  }

  const access = {
    catalog(orgId){ return request(orgPath(orgId, '/access/catalog')); },
    me(orgId){ return request(orgPath(orgId, '/access/me')); },
    user(orgId, userId){ return request(orgPath(orgId, `/access/users/${enc(userId)}`)); },
    roles(orgId, options = {}){ return request(orgPath(orgId, `/access/roles${queryString({ include_archived:options.includeArchived })}`)); },
    createRole(orgId, role = {}){ return request(orgPath(orgId, '/access/roles'), { method:'POST', body:role }); },
    updateRole(orgId, roleId, patch = {}){ return request(orgPath(orgId, `/access/roles/${enc(roleId)}`), { method:'PATCH', body:patch }); },
    archiveRole(orgId, roleId, expectedRevision = 0){
      return request(orgPath(orgId, `/access/roles/${enc(roleId)}${queryString({ expected_revision:expectedRevision })}`), { method:'DELETE' });
    }
  };

  const me = {
    dashboard(orgId, date){ return request(orgPath(orgId, `/crew/me/dashboard${queryString({ date })}`)); },
    projects(orgId, options = {}){
      return request(orgPath(orgId, `/crew/me/projects${queryString({
        search:options.search,
        range:options.range,
         status:options.status,
         from:options.from,
         to:options.to,
         date:options.date,
         limit:options.limit
       })}`));
    },
    payouts(orgId, options = {}){ return request(orgPath(orgId, `/crew/me/payouts${queryString(options)}`)); },
    todos(orgId, options = {}){ return request(orgPath(orgId, `/crew/me/todos${queryString(options)}`)); },
    completeTodo(orgId, nodeId, input = {}){
      return request(orgPath(orgId, `/crew/me/todos/${enc(nodeId)}/complete`), { method:'POST', body:input });
    },
    timeClock(orgId){ return request(orgPath(orgId, '/crew/me/time-clock')); },
    timeAction(orgId, action, payload = {}){
      return request(orgPath(orgId, '/crew/me/time-clock/actions'), { method:'POST', body:{ action, ...payload } });
    }
  };

  function projectPath(orgId, projectId, suffix = ''){
    return orgPath(orgId, `/crew/projects/${enc(projectId)}${suffix}`);
  }

  const projects = {
      get(orgId, projectId){ return request(projectPath(orgId, projectId)); },
      visit(orgId, projectId, eventId = ''){ return request(projectPath(orgId, projectId, `/visit${queryString({ event_id:eventId })}`)); },
      visitAction(orgId, projectId, stepId, body = {}){
        return request(projectPath(orgId, projectId, `/visit/steps/${enc(stepId)}/actions`), { method:'POST', body });
      },
      workflows(orgId, projectId){ return request(projectPath(orgId, projectId, '/workflows')); },
      addWorkflowScope(orgId, projectId, templateId, body = {}){
        return request(projectPath(orgId, projectId, `/workflows/scopes/${enc(templateId)}`), { method:'POST', body });
      },
      signatures(orgId, projectId){ return request(projectPath(orgId, projectId, '/signatures')); },
    signatureDocument(orgId, projectId, documentId){ return request(projectPath(orgId, projectId, `/signatures/${enc(documentId)}`)); },
    updateSignatureParams(orgId, projectId, documentId, params = {}){
      return request(projectPath(orgId, projectId, `/signatures/${enc(documentId)}/params`), { method:'PATCH', body:{ params } });
    },
    updateSignatureWorkflow(orgId, projectId, documentId, body = {}){
      return request(projectPath(orgId, projectId, `/signatures/${enc(documentId)}/workflow`), { method:'PATCH', body });
    },
    recordSignature(orgId, projectId, documentId, key, body = {}){
      return request(projectPath(orgId, projectId, `/signatures/${enc(documentId)}/outputs/${enc(key)}`), { method:'POST', body });
    },
      paySignatureDocument(orgId, projectId, documentId, key, body = {}){
        return request(projectPath(orgId, projectId, `/signatures/${enc(documentId)}/payments/${enc(key)}`), { method:'POST', body });
      },
      sendSignatureDocumentToPortal(orgId, projectId, documentId){
        return request(projectPath(orgId, projectId, `/signatures/${enc(documentId)}/portal`), { method:'POST', body:{} });
      },
      voidSignatureDocument(orgId, projectId, documentId, body = {}){
        return request(projectPath(orgId, projectId, `/signatures/${enc(documentId)}/void`), { method:'POST', body });
      },
    materials(orgId, projectId){ return request(projectPath(orgId, projectId, '/materials')); },
    addMaterialItem(orgId, projectId, input = {}){
      return request(projectPath(orgId, projectId, '/materials/items'), { method:'POST', body:input });
    },
    addMaterialsFromReceipt(orgId, projectId, input = {}){
      return request(projectPath(orgId, projectId, '/materials/from-receipt'), { method:'POST', body:input });
    },
    payouts(orgId, projectId){ return request(projectPath(orgId, projectId, '/payouts')); },
    payments(orgId, projectId){ return request(projectPath(orgId, projectId, '/payments')); },
    takePayment(orgId, projectId, input = {}){
      return request(projectPath(orgId, projectId, '/payments'), { method:'POST', body:input });
    },
    changeOrders(orgId, projectId){ return request(projectPath(orgId, projectId, '/change-orders')); },
    createChangeOrder(orgId, projectId, input = {}){
      return request(projectPath(orgId, projectId, '/change-orders'), { method:'POST', body:input });
    },
    sendChangeOrder(orgId, projectId, changeOrderId, input = {}){
      return request(orgPath(orgId, `/crew/change-orders/${enc(changeOrderId)}/send`), { method:'POST', body:{ project_id:projectId, ...input } });
    },
    todos(orgId, projectId){ return request(projectPath(orgId, projectId, '/todos')); },
    completeTodo(orgId, projectId, nodeId, input = {}){
      return request(projectPath(orgId, projectId, `/todos/${enc(nodeId)}/complete`), { method:'POST', body:input });
    },
    checklists(orgId, projectId){ return request(projectPath(orgId, projectId, '/checklists')); },
    createChecklist(orgId, projectId, input = {}){
      return request(projectPath(orgId, projectId, '/checklists'), { method:'POST', body:input });
    },
    voiceChecklistUrl(orgId, projectId){
      return url(projectPath(orgId, projectId, '/checklists/voice'));
    },
    applyChecklistVoice(orgId, projectId, form){
      return request(projectPath(orgId, projectId, '/checklists/voice'), { method:'POST', body:form });
    },
    updateChecklist(orgId, projectId, checklistId, patch = {}){
      return request(projectPath(orgId, projectId, `/checklists/${enc(checklistId)}`), { method:'PATCH', body:patch });
    },
    removeChecklist(orgId, projectId, checklistId){
      return request(projectPath(orgId, projectId, `/checklists/${enc(checklistId)}`), { method:'DELETE' });
    },
    addItemToChecklist(orgId, projectId, checklistId, input = {}){
      return request(projectPath(orgId, projectId, `/checklists/${enc(checklistId)}/items`), { method:'POST', body:input });
    },
    updateItemInChecklist(orgId, projectId, checklistId, itemId, patch = {}){
      return request(projectPath(orgId, projectId, `/checklists/${enc(checklistId)}/items/${enc(itemId)}`), { method:'PATCH', body:patch });
    },
    attachChecklistEvidence(orgId, projectId, checklistId, itemId, file, requirementId = ''){
      const form = new FormData();
      form.append('file', file, file.name || 'checklist-evidence');
      if (requirementId) form.append('requirement_id', requirementId);
      return request(projectPath(orgId, projectId, `/checklists/${enc(checklistId)}/items/${enc(itemId)}/attachments`), { method:'POST', body:form });
    },
    removeItemFromChecklist(orgId, projectId, checklistId, itemId){
      return request(projectPath(orgId, projectId, `/checklists/${enc(checklistId)}/items/${enc(itemId)}`), { method:'DELETE' });
    },
    checklist(orgId, projectId){ return request(projectPath(orgId, projectId, '/checklist')); },
    addChecklistItem(orgId, projectId, input = {}){
      return request(projectPath(orgId, projectId, '/checklist/items'), { method:'POST', body:input });
    },
    updateChecklistItem(orgId, projectId, itemId, patch = {}){
      return request(projectPath(orgId, projectId, `/checklist/items/${enc(itemId)}`), { method:'PATCH', body:patch });
    },
    removeChecklistItem(orgId, projectId, itemId, options = {}){
      return request(projectPath(orgId, projectId, `/checklist/items/${enc(itemId)}${queryString({ expected_revision:options.expectedRevision })}`), { method:'DELETE' });
    }
  };

  const api = { configure, baseUrl, url, request, access, me, projects };
  configure({ baseUrl:APP.workforceApiBase || '' });
  root.CrewAPI = api;
})();
