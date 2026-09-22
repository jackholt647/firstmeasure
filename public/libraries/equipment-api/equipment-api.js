/* public/libraries/equipment-api/equipment-api.js
 * Browser client for the Equipment domain under /v1/equipment.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl:'', defaultHeaders:{} };

  const clean = (value) => String(value ?? '').trim();
  const enc = (value) => encodeURIComponent(clean(value));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  function defaultBaseUrl(){
    if (APP.equipmentApiBase) return clean(APP.equipmentApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return clean(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/equipment').replace(/\/+$/, '');
    const host = clean(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/equipment`;
    return `${location.origin}/v1/equipment`;
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
      const error = new Error(clean(data?.message || data?.error) || `Equipment API request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
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
      params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : clean(value));
    });
    const query = params.toString();
    return query ? `?${query}` : '';
  }

  const api = {
    configure,
    baseUrl,
    url,
    request,

    categories(orgId, options = {}){ return request(orgPath(orgId, `/categories${queryString({ include_archived:options.includeArchived })}`)); },
    createCategory(orgId, input = {}){ return request(orgPath(orgId, '/categories'), { method:'POST', body:input }); },
    saveCategory(orgId, categoryId, input = {}){ return request(orgPath(orgId, `/categories/${enc(categoryId)}`), { method:'PATCH', body:input }); },
    archiveCategory(orgId, categoryId){ return request(orgPath(orgId, `/categories/${enc(categoryId)}`), { method:'DELETE' }); },

    types(orgId, options = {}){ return request(orgPath(orgId, `/types${queryString({ include_archived:options.includeArchived, category_id:options.categoryId })}`)); },
    type(orgId, typeId){ return request(orgPath(orgId, `/types/${enc(typeId)}`)); },
    createType(orgId, input = {}){ return request(orgPath(orgId, '/types'), { method:'POST', body:input }); },
    saveType(orgId, typeId, input = {}){ return request(orgPath(orgId, `/types/${enc(typeId)}`), { method:'PATCH', body:input }); },
    archiveType(orgId, typeId){ return request(orgPath(orgId, `/types/${enc(typeId)}`), { method:'DELETE' }); },

    yards(orgId, options = {}){ return request(orgPath(orgId, `/yards${queryString({ include_archived:options.includeArchived })}`)); },
    createYard(orgId, input = {}){ return request(orgPath(orgId, '/yards'), { method:'POST', body:input }); },
    saveYard(orgId, yardId, input = {}){ return request(orgPath(orgId, `/yards/${enc(yardId)}`), { method:'PATCH', body:input }); },
    archiveYard(orgId, yardId){ return request(orgPath(orgId, `/yards/${enc(yardId)}`), { method:'DELETE' }); },

    units(orgId, options = {}){
      return request(orgPath(orgId, `/units${queryString({
        include_archived:options.includeArchived,
        type_id:options.typeId,
        branch_id:options.branchId,
        status:options.status,
        ownership:options.ownership,
        contact_id:options.contactId,
        q:options.query
      })}`));
    },
    unit(orgId, unitId){ return request(orgPath(orgId, `/units/${enc(unitId)}`)); },
    createUnit(orgId, input = {}){ return request(orgPath(orgId, '/units'), { method:'POST', body:input }); },
    saveUnit(orgId, unitId, input = {}){ return request(orgPath(orgId, `/units/${enc(unitId)}`), { method:'PATCH', body:input }); },
    archiveUnit(orgId, unitId){ return request(orgPath(orgId, `/units/${enc(unitId)}`), { method:'DELETE' }); },
    recordMeterEntry(orgId, unitId, input = {}){ return request(orgPath(orgId, `/units/${enc(unitId)}/meter-entries`), { method:'POST', body:input }); },
    unitHistory(orgId, unitId){ return request(orgPath(orgId, `/units/${enc(unitId)}/history`)); },

    servicePrograms(orgId, options = {}){ return request(orgPath(orgId, `/service-programs${queryString({ include_archived:options.includeArchived, unit_id:options.unitId, type_id:options.typeId })}`)); },
    createProgram(orgId, input = {}){ return request(orgPath(orgId, '/service-programs'), { method:'POST', body:input }); },
    saveProgram(orgId, programId, input = {}){ return request(orgPath(orgId, `/service-programs/${enc(programId)}`), { method:'PATCH', body:input }); },
    workOrders(orgId, options = {}){ return request(orgPath(orgId, `/work-orders${queryString({ unit_id:options.unitId, status:options.status, program_id:options.programId })}`)); },
    workOrder(orgId, workOrderId){ return request(orgPath(orgId, `/work-orders/${enc(workOrderId)}`)); },
    createWorkOrder(orgId, input = {}){ return request(orgPath(orgId, '/work-orders'), { method:'POST', body:input }); },
    patchWorkOrder(orgId, workOrderId, input = {}){ return request(orgPath(orgId, `/work-orders/${enc(workOrderId)}`), { method:'PATCH', body:input }); },
    scheduleWorkOrder(orgId, workOrderId, input = {}){ return request(orgPath(orgId, `/work-orders/${enc(workOrderId)}/schedule`), { method:'POST', body:input }); },
    completeWorkOrder(orgId, workOrderId, input = {}){ return request(orgPath(orgId, `/work-orders/${enc(workOrderId)}/complete`), { method:'POST', body:input }); },
    cancelWorkOrder(orgId, workOrderId){ return request(orgPath(orgId, `/work-orders/${enc(workOrderId)}/cancel`), { method:'POST', body:{} }); },
    dueService(orgId, options = {}){ return request(orgPath(orgId, `/due-service${queryString({ horizon_days:options.horizonDays })}`)); },
    checkOutUnit(orgId, unitId, input = {}){ return request(orgPath(orgId, `/units/${enc(unitId)}/check-out`), { method:'POST', body:input }); },
    checkInUnit(orgId, unitId){ return request(orgPath(orgId, `/units/${enc(unitId)}/check-in`), { method:'POST', body:{} }); },
    utilization(orgId, options = {}){ return request(orgPath(orgId, `/utilization${queryString({ start:options.start, end:options.end })}`)); },
    dashboard(orgId){ return request(orgPath(orgId, '/dashboard')); },
    settings(orgId){ return request(orgPath(orgId, '/settings')); },
    saveSettings(orgId, input = {}){ return request(orgPath(orgId, '/settings'), { method:'PUT', body:input }); }
  };
  configure({ baseUrl:APP.equipmentApiBase || '' });
  root.EquipmentAPI = api;
})();
