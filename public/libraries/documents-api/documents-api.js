/* libraries/documents-api/documents-api.js
 * Browser client for /v1/documents — the document engine.
 *
 * Covers template + theme management, document instances, resolution for
 * live preview, snapshots/sending, PDFs, output recording, ingestion, and
 * the public (token) portal endpoints. See docs/document-engine-contracts.md.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl: '', defaultHeaders: {} };

  function cleanText(value){ return String(value ?? '').trim(); }
  function enc(value){ return encodeURIComponent(cleanText(value)); }

  function defaultBaseUrl(){
    if (APP.documentsApiBase) return cleanText(APP.documentsApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return cleanText(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/documents').replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/documents`;
    return `${location.origin}/v1/documents`;
  }

  function configure(options = {}){
    if (options.baseUrl) state.baseUrl = cleanText(options.baseUrl).replace(/\/+$/, '');
    if (options.headers && typeof options.headers === 'object') state.defaultHeaders = { ...state.defaultHeaders, ...options.headers };
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

  function cookieValue(name){
    const target = `${encodeURIComponent(name)}=`;
    return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(target))?.slice(target.length) || '';
  }

  function csrfToken(){
    return decodeURIComponent(cookieValue('fm_platform_session_csrf') || '');
  }

  function jsonBody(body){
    if (body == null || body instanceof FormData || typeof body === 'string') return body;
    return JSON.stringify(body);
  }

  function requestHeaders(options, body){
    const method = cleanText(options.method || 'GET').toUpperCase();
    const headers = {
      Accept: 'application/json',
      ...state.defaultHeaders,
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    };
    const csrf = csrfToken();
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers['X-Platform-CSRF']) headers['X-Platform-CSRF'] = csrf;
    return headers;
  }

  async function request(path, options = {}){
    const requestUrl = url(path);
    if (!requestUrl) {
      const error = new Error('Documents API is not configured for this frontend session.');
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
      const error = new Error(cleanText(data?.message || data?.error) || `Documents API request failed (${res.status})`);
      error.status = res.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  function query(params = {}){
    const pairs = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${enc(key)}=${enc(value)}`);
    return pairs.length ? `?${pairs.join('&')}` : '';
  }

  const templates = {
    list(orgId, filters = {}){ return request(`/organizations/${enc(orgId)}/templates${query(filters)}`); },
    create(orgId, template = {}){ return request(`/organizations/${enc(orgId)}/templates`, { method: 'POST', body: template }); },
    get(orgId, templateId){ return request(`/organizations/${enc(orgId)}/templates/${enc(templateId)}`); },
    patch(orgId, templateId, patch = {}){ return request(`/organizations/${enc(orgId)}/templates/${enc(templateId)}`, { method: 'PATCH', body: patch }); },
    archive(orgId, templateId){ return request(`/organizations/${enc(orgId)}/templates/${enc(templateId)}`, { method: 'DELETE' }); },
    versions(orgId, templateId){ return request(`/organizations/${enc(orgId)}/templates/${enc(templateId)}/versions`); },
    version(orgId, templateId, version){ return request(`/organizations/${enc(orgId)}/templates/${enc(templateId)}/versions/${enc(version)}`); },
    publish(orgId, templateId, body = {}){ return request(`/organizations/${enc(orgId)}/templates/${enc(templateId)}/publish`, { method: 'POST', body }); },
    // Vision template generation: { name?, document_type?, notes?, files:
    // [{file_name, content_type?, data_base64}] } → { template, notes }.
    fromExamples(orgId, body = {}){ return request(`/organizations/${enc(orgId)}/templates/from-examples`, { method: 'POST', body }); }
  };

  const themes = {
    list(orgId){ return request(`/organizations/${enc(orgId)}/themes`); },
    create(orgId, theme = {}){ return request(`/organizations/${enc(orgId)}/themes`, { method: 'POST', body: theme }); },
    get(orgId, themeId){ return request(`/organizations/${enc(orgId)}/themes/${enc(themeId)}`); },
    patch(orgId, themeId, patch = {}){ return request(`/organizations/${enc(orgId)}/themes/${enc(themeId)}`, { method: 'PATCH', body: patch }); },
    archive(orgId, themeId){ return request(`/organizations/${enc(orgId)}/themes/${enc(themeId)}`, { method: 'DELETE' }); },
    publish(orgId, themeId, body = {}){ return request(`/organizations/${enc(orgId)}/themes/${enc(themeId)}/publish`, { method: 'POST', body }); }
  };

  function documentPath(orgId, documentId, suffix = ''){
    return `/organizations/${enc(orgId)}/documents/${enc(documentId)}${suffix}`;
  }

  const documents = {
    listForProject(orgId, projectId, filters = {}){ return request(`/organizations/${enc(orgId)}/projects/${enc(projectId)}/documents${query(filters)}`); },
    createForProject(orgId, projectId, body = {}){ return request(`/organizations/${enc(orgId)}/projects/${enc(projectId)}/documents`, { method: 'POST', body }); },
    // Standalone documents (doc-first flows): no project yet; attach later via
    // patch(orgId, documentId, { project_id }). listStandalone powers the
    // My Projects "Drafts" view.
    listStandalone(orgId){ return request(`/organizations/${enc(orgId)}/documents`); },
    createStandalone(orgId, body = {}){ return request(`/organizations/${enc(orgId)}/documents`, { method: 'POST', body }); },
    get(orgId, documentId){ return request(documentPath(orgId, documentId)); },
    patch(orgId, documentId, patch = {}){ return request(documentPath(orgId, documentId), { method: 'PATCH', body: patch }); },
    archive(orgId, documentId){ return request(documentPath(orgId, documentId), { method: 'DELETE' }); },
    resolve(orgId, documentId, body = {}){ return request(documentPath(orgId, documentId, '/resolve'), { method: 'POST', body }); },
    issue(orgId, documentId, body = {}){ return request(documentPath(orgId, documentId, '/issue'), { method: 'POST', body }); },
    send(orgId, documentId, body = {}){ return request(documentPath(orgId, documentId, '/send'), { method: 'POST', body }); },
    snapshots(orgId, documentId){ return request(documentPath(orgId, documentId, '/snapshots')); },
    createSnapshot(orgId, documentId, body = {}){ return request(documentPath(orgId, documentId, '/snapshots'), { method: 'POST', body }); },
    generatePdf(orgId, documentId, body = {}){ return request(documentPath(orgId, documentId, '/pdf'), { method: 'POST', body }); },
    pdfUrl(orgId, documentId, options = {}){
      const mediaId = cleanText(options.media_id || options.mediaId);
      return url(documentPath(orgId, documentId, `/pdf${mediaId ? `?media_id=${enc(mediaId)}` : ''}`));
    },
    recordOutput(orgId, documentId, key, body = {}){ return request(documentPath(orgId, documentId, `/outputs/${enc(key)}`), { method: 'POST', body }); },
    events(orgId, documentId){ return request(documentPath(orgId, documentId, '/events')); },
    // Workflow runtime (contract §8): the workflow attached to an instance and
    // its persisted step state. Routes are being built in parallel — callers
    // must treat failures as "no workflow" (see doc-workflow integration).
    workflow(orgId, documentId){ return request(documentPath(orgId, documentId, '/workflow')); },
    workflowState(orgId, documentId, body = {}){ return request(documentPath(orgId, documentId, '/workflow/state'), { method: 'POST', body }); }
  };

  // Workflow definitions (collection `document_workflows`, versioned like
  // templates — contract §8).
  const workflows = {
    list(orgId, filters = {}){ return request(`/organizations/${enc(orgId)}/workflows${query(filters)}`); },
    create(orgId, workflow = {}){ return request(`/organizations/${enc(orgId)}/workflows`, { method: 'POST', body: workflow }); },
    get(orgId, workflowId){ return request(`/organizations/${enc(orgId)}/workflows/${enc(workflowId)}`); },
    patch(orgId, workflowId, patch = {}){ return request(`/organizations/${enc(orgId)}/workflows/${enc(workflowId)}`, { method: 'PATCH', body: patch }); },
    archive(orgId, workflowId){ return request(`/organizations/${enc(orgId)}/workflows/${enc(workflowId)}`, { method: 'DELETE' }); },
    publish(orgId, workflowId, body = {}){ return request(`/organizations/${enc(orgId)}/workflows/${enc(workflowId)}/publish`, { method: 'POST', body }); }
  };

  // Doc Studio folders (Marketing + custom tabs) and their items. Items are
  // unversioned: doc kinds autosave `definition` via patch { expected_revision }.
  const folders = {
    list(orgId, filters = {}){ return request(`/organizations/${enc(orgId)}/folders${query(filters)}`); },
    create(orgId, folder = {}){ return request(`/organizations/${enc(orgId)}/folders`, { method: 'POST', body: folder }); },
    patch(orgId, folderId, patch = {}){ return request(`/organizations/${enc(orgId)}/folders/${enc(folderId)}`, { method: 'PATCH', body: patch }); },
    archive(orgId, folderId){ return request(`/organizations/${enc(orgId)}/folders/${enc(folderId)}`, { method: 'DELETE' }); },
    items: {
      list(orgId, folderId, filters = {}){ return request(`/organizations/${enc(orgId)}/folders/${enc(folderId)}/items${query(filters)}`); },
      create(orgId, folderId, item = {}){ return request(`/organizations/${enc(orgId)}/folders/${enc(folderId)}/items`, { method: 'POST', body: item }); },
      get(orgId, folderId, itemId){ return request(`/organizations/${enc(orgId)}/folders/${enc(folderId)}/items/${enc(itemId)}`); },
      versions(orgId, folderId, itemId){ return request(`/organizations/${enc(orgId)}/folders/${enc(folderId)}/items/${enc(itemId)}/versions`); },
      patch(orgId, folderId, itemId, patch = {}){ return request(`/organizations/${enc(orgId)}/folders/${enc(folderId)}/items/${enc(itemId)}`, { method: 'PATCH', body: patch }); },
      archive(orgId, folderId, itemId){ return request(`/organizations/${enc(orgId)}/folders/${enc(folderId)}/items/${enc(itemId)}`, { method: 'DELETE' }); }
    },
    itemPdfUrl(orgId, folderId, itemId){ return url(`/organizations/${enc(orgId)}/folders/${enc(folderId)}/items/${enc(itemId)}/pdf`); }
  };

  const catalog = {
    get(orgId){ return request(`/organizations/${enc(orgId)}/catalog`); }
  };

  // Version-history checkpoints (compact routes — org comes from the session).
  // "current" is a valid checkpoint id meaning the live working definition.
  const checkpoints = {
    list(documentId){ return request(`/${enc(documentId)}/checkpoints`); },
    create(documentId, body = {}){ return request(`/${enc(documentId)}/checkpoints`, { method: 'POST', body }); },
    get(documentId, checkpointId){ return request(`/${enc(documentId)}/checkpoints/${enc(checkpointId)}`); },
    diff(documentId, a, b){ return request(`/${enc(documentId)}/checkpoints/${enc(a)}/diff/${enc(b)}`); }
  };

  // Phase-1 realtime collaboration: SSE stream + serialized command log.
  // send() resolves the 409 stale envelope ({ok:false, stale, revision,
  // missed}) instead of throwing so callers can replay and retry.
  const collab = {
    connect(documentId, handlers = {}){
      const source = new EventSource(url(`/${enc(documentId)}/collab/stream`), { withCredentials: true });
      const parse = (raw) => { try { return JSON.parse(raw); } catch (e) { return null; } };
      source.addEventListener('hello', (ev) => handlers.onHello?.(parse(ev.data)));
      source.addEventListener('presence', (ev) => handlers.onPresence?.(parse(ev.data)));
      source.addEventListener('commands', (ev) => handlers.onCommands?.(parse(ev.data)));
      source.onerror = () => handlers.onError?.();
      return {
        close(){ source.close(); },
        send(base_revision, commands, actor_cursor){
          return request(`/${enc(documentId)}/collab/commands`, { method: 'POST', body: { base_revision, commands, ...(actor_cursor ? { actor_cursor } : {}) } })
            .catch((error) => { if (error?.status === 409 && error.data?.stale) return error.data; throw error; });
        },
        presence(body = {}){ return request(`/${enc(documentId)}/collab/presence`, { method: 'POST', body }).catch(() => null); }
      };
    }
  };

  const ingestion = {
    upload(orgId, formData){ return request(`/organizations/${enc(orgId)}/documents/ingest`, { method: 'POST', body: formData }); },
    // Paper-upload review: field-definition/value edits and the reviewer
    // confirm that re-records outputs through the standard machinery.
    updateFields(orgId, documentId, body = {}){ return request(`/organizations/${enc(orgId)}/documents/${enc(documentId)}/upload-fields`, { method: 'POST', body }); },
    confirm(orgId, documentId, body = {}){ return request(`/organizations/${enc(orgId)}/documents/${enc(documentId)}/confirm-upload`, { method: 'POST', body }); },
    draftTemplate(orgId, body = {}){ return request(`/organizations/${enc(orgId)}/templates/upload-intake/draft`, { method: 'POST', body }); },
    saveTemplateFromDocument(orgId, documentId, body = {}){ return request(`/organizations/${enc(orgId)}/templates/upload-intake/from-document/${enc(documentId)}`, { method: 'POST', body }); }
  };

  const pub = {
    get(token){ return request(`/public/${enc(token)}`, { credentials: 'omit' }); },
    view(token, body = {}){ return request(`/public/${enc(token)}/view`, { method: 'POST', body, credentials: 'omit' }); },
    recordOutput(token, key, body = {}){ return request(`/public/${enc(token)}/outputs/${enc(key)}`, { method: 'POST', body, credentials: 'omit' }); },
    // Authoritative conditional-pricing preview (spec §10.4): re-evaluates
    // the snapshot's rows/totals server-side for a checkout state, e.g.
    // pricing(token, { checkout: { payment_method: 'ach' } }).
    pricing(token, body = {}){ return request(`/public/${enc(token)}/pricing`, { method: 'POST', body, credentials: 'omit' }); },
    pdfUrl(token){ return url(`/public/${enc(token)}/pdf`); },
    // Provider payment intake over the document token. paymentIntakeConfig
    // answers provider:null when the org has no processor (legacy flow);
    // createPaymentMethodIntent tokenizes card/bank fields for the mock
    // provider (real providers tokenize in-browser through their SDK).
    paymentIntakeConfig(token){ return request(`/public/${enc(token)}/payments/intake-config`, { credentials: 'omit' }); },
    createPaymentMethodIntent(token, body = {}){ return request(`/public/${enc(token)}/payments/payment-method-intent`, { method: 'POST', body, credentials: 'omit' }); },
    // Customer-audience workflow attached to the shared document (contract
    // §8). Callers must treat any failure as "no workflow".
    workflow(token){ return request(`/public/${enc(token)}/workflow`, { credentials: 'omit' }); }
  };

  const api = {
    configure,
    baseUrl,
    url,
    request,
    templates,
    themes,
    documents,
    workflows,
    folders,
    catalog,
    checkpoints,
    collab,
    ingestion,
    public: pub
  };

  root.DocumentsAPI = api;
})();
