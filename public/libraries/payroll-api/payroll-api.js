/* public/libraries/payroll-api/payroll-api.js
 * Browser client for the FirstMate Payroll v1 API.
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
    if (APP.payrollApiBase) return clean(APP.payrollApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return clean(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/payroll').replace(/\/+$/, '');
    const host = clean(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/payroll`;
    return `${location.origin}/v1/payroll`;
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
    try { return decodeURIComponent(cookieValue('fm_platform_session_csrf') || ''); }
    catch (_) { return cookieValue('fm_platform_session_csrf') || ''; }
  }

  function queryString(values = {}){
    const params = new URLSearchParams();
    Object.entries(object(values)).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      if (Array.isArray(value)) value.forEach((item) => params.append(key, clean(item)));
      else params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : clean(value));
    });
    const query = params.toString();
    return query ? `?${query}` : '';
  }

  function requestHeaders(options, originalBody){
    const method = clean(options.method || 'GET').toUpperCase();
    const headers = {
      Accept:'application/json',
      ...state.defaultHeaders,
      ...(originalBody != null && !(originalBody instanceof FormData) ? { 'Content-Type':'application/json' } : {}),
      ...object(options.headers)
    };
    const csrf = csrfToken();
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers['X-Platform-CSRF']) headers['X-Platform-CSRF'] = csrf;
    return headers;
  }

  async function request(path, options = {}){
    const originalBody = options.body;
    const body = originalBody == null || originalBody instanceof FormData || typeof originalBody === 'string'
      ? originalBody
      : JSON.stringify(originalBody);
    const response = await fetch(url(path), {
      ...options,
      body,
      cache:options.cache || 'no-store',
      credentials:options.credentials || 'include',
      headers:requestHeaders(options, originalBody)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!response.ok || data?.ok === false) {
      const error = new Error(clean(data?.message || data?.error) || `Payroll API request failed (${response.status})`);
      error.status = response.status;
      error.code = clean(data?.error);
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  function orgPath(orgId, suffix = ''){
    return `/organizations/${enc(orgId)}${suffix}`;
  }

  const dashboard = (orgId, options = {}) => request(orgPath(orgId, `/dashboard${queryString(options)}`));
  const upcoming = (orgId, options = {}) => request(orgPath(orgId, `/upcoming${queryString(options)}`));

  const earnings = {
    me(orgId, options = {}){
      return request(orgPath(orgId, `/earnings/me${queryString(options)}`));
    },
    forPayee(orgId, payeeType, payeeId, options = {}){
      return request(orgPath(orgId, `/earnings/payees/${enc(payeeType)}/${enc(payeeId)}${queryString(options)}`));
    },
    list(orgId, payees = [], options = {}){
      const values = (Array.isArray(payees) ? payees : [payees]).map((payee) => {
        const source = object(payee);
        const type = clean(source.type || 'organization_user');
        const id = clean(source.id || payee);
        return type && id ? `${type}:${id}` : '';
      }).filter(Boolean);
      return request(orgPath(orgId, `/earnings${queryString({ ...options, payee:values })}`));
    }
  };

  const schedules = {
    list(orgId, options = {}){ return request(orgPath(orgId, `/schedules${queryString({ include_archived:options.includeArchived })}`)); },
    get(orgId, scheduleId){ return request(orgPath(orgId, `/schedules/${enc(scheduleId)}`)); },
    create(orgId, payload = {}){ return request(orgPath(orgId, '/schedules'), { method:'POST', body:payload }); },
    update(orgId, scheduleId, patch = {}){ return request(orgPath(orgId, `/schedules/${enc(scheduleId)}`), { method:'PATCH', body:patch }); },
    archive(orgId, scheduleId, expectedRevision){
      return request(orgPath(orgId, `/schedules/${enc(scheduleId)}${queryString({ expected_revision:expectedRevision })}`), { method:'DELETE' });
    }
  };

  const policies = {
    list(orgId){ return request(orgPath(orgId, '/policies')); },
    effective(orgId, payeeType, payeeId, options = {}){
      return request(orgPath(orgId, `/policies/effective/${enc(payeeType)}/${enc(payeeId)}${queryString(options)}`));
    },
    save(orgId, subjectType, subjectId, payload = {}){
      return request(orgPath(orgId, `/policies/${enc(subjectType)}/${enc(subjectId)}`), { method:'PUT', body:payload });
    },
    remove(orgId, subjectType, subjectId, earningKind = '*'){
      return request(orgPath(orgId, `/policies/${enc(subjectType)}/${enc(subjectId)}${queryString({ earning_kind:earningKind })}`), { method:'DELETE' });
    }
  };

  const projects = {
    payees(orgId, projectId){ return request(orgPath(orgId, `/projects/${enc(projectId)}/payees`)); },
    setPayeeRole(orgId, projectId, roleKey, payload = {}){
      return request(orgPath(orgId, `/projects/${enc(projectId)}/payees/${enc(roleKey)}`), { method:'PUT', body:payload });
    },
    commissionEvent(orgId, projectId, payload = {}){
      return request(orgPath(orgId, `/projects/${enc(projectId)}/commission-events`), { method:'POST', body:payload });
    },
    overrideCommission(orgId, projectId, payload = {}){
      return request(orgPath(orgId, `/projects/${enc(projectId)}/commission-overrides`), { method:'POST', body:payload });
    }
  };

  const ledger = {
    list(orgId, options = {}){ return request(orgPath(orgId, `/ledger${queryString(options)}`)); },
    get(orgId, entryId){ return request(orgPath(orgId, `/ledger/${enc(entryId)}`)); },
    create(orgId, payload = {}){ return request(orgPath(orgId, '/ledger'), { method:'POST', body:payload }); },
    reverse(orgId, entryId, payload = {}){ return request(orgPath(orgId, `/ledger/${enc(entryId)}/reverse`), { method:'POST', body:payload }); },
    project(orgId, payload = {}){ return request(orgPath(orgId, '/projections'), { method:'POST', body:payload }); },
    accrueProjection(orgId, entryId){ return request(orgPath(orgId, `/projections/${enc(entryId)}/accrue`), { method:'POST', body:{} }); }
  };

  const batches = {
    list(orgId, options = {}){ return request(orgPath(orgId, `/batches${queryString(options)}`)); },
    get(orgId, batchId){ return request(orgPath(orgId, `/batches/${enc(batchId)}`)); },
    create(orgId, payload = {}){ return request(orgPath(orgId, '/batches'), { method:'POST', body:payload }); },
    updateItem(orgId, batchId, itemId, patch = {}){
      return request(orgPath(orgId, `/batches/${enc(batchId)}/items/${enc(itemId)}`), { method:'PATCH', body:patch });
    },
    action(orgId, batchId, action, options = {}){
      return request(orgPath(orgId, `/batches/${enc(batchId)}/actions`), {
        method:'POST',
        body:{ action, ...(options.payment_reference ? { payment_reference:options.payment_reference } : {}),
          ...(Array.isArray(options.approvers) ? { approvers:options.approvers } : {}), ...(options.note ? { note:options.note } : {}), metadata:object(options.metadata) }
      });
    }
  };

  const artifacts = {
    catalog(orgId){ return request(orgPath(orgId, '/exports/catalog')); },
    list(orgId, options = {}){ return request(orgPath(orgId, `/artifacts${queryString(options)}`)); },
    create(orgId, payload = {}){ return request(orgPath(orgId, '/artifacts'), { method:'POST', body:payload }); },
    downloadUrl(orgId, artifactId){ return url(orgPath(orgId, `/artifacts/${enc(artifactId)}/download`)); }
  };

  const timesheets = {
    list(orgId, options = {}){ return request(orgPath(orgId, `/timesheets${queryString(options)}`)); },
    update(orgId, shiftId, patch = {}){ return request(orgPath(orgId, `/timesheets/${enc(shiftId)}`), { method:'PATCH', body:patch }); },
    approve(orgId, shiftId, payload = {}){ return request(orgPath(orgId, `/timesheets/${enc(shiftId)}/approve`), { method:'POST', body:payload }); },
    reject(orgId, shiftId, payload = {}){ return request(orgPath(orgId, `/timesheets/${enc(shiftId)}/reject`), { method:'POST', body:payload }); }
  };

  const api = {
    version:1,
    configure,
    baseUrl,
    url,
    request,
    queryString,
    dashboard,
    upcoming,
    earnings,
    schedules,
    policies,
    projects,
    ledger,
    batches,
    timesheets,
    artifacts
  };

  configure({ baseUrl:APP.payrollApiBase || '' });
  root.PayrollAPI = api;
})();
