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
    const sessionName = String(window.__APP?.platformSessionCookieName || 'fm_platform_session').trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionName)) return '';
    const prefix = sessionName + '_csrf=';
    const value = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
    try { return value ? decodeURIComponent(value.slice(prefix.length)) : ''; }
    catch { return ''; }
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
    const publication=root.PlatformAPI?.publication;
    if(publication?.invoke && /^\/organizations\//.test(path))return publishedRequest(path,options);
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

  // Keep the browser contract while using the same typed operations as agents/modules.
  async function publishedRequest(path,options){
    const parsed=new URL(path,'https://payroll.invalid'),parts=parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent),orgId=parts[1],p=parts.slice(2),method=(options.method||'GET').toUpperCase();
    const target={scope:'organization',organizationId:orgId};let action,input={...object(options.body)},wrap=value=>({ok:true,...value});
    const query={};for(const [key,value]of parsed.searchParams){if(key==='payee')continue;query[key]=['include_projected','include_archived','open_only'].includes(key)?['1','true'].includes(value):['limit','history_limit','entry_limit','payment_limit','expected_revision'].includes(key)?Number(value):value;}
    if(p[0]==='dashboard'){action='payroll.dashboard.read';input=query;}
    else if(p[0]==='upcoming'){action='payroll.upcoming.read';input=query;}
    else if(p[0]==='earnings'){
      action=p[1]==='me'?'payroll.earnings.me':'payroll.earnings.read';input=query;
      if(p[1]==='payees')input.payees=[{type:p[2],id:p[3]}];
      else if(p[1]!=='me')input.payees=parsed.searchParams.getAll('payee').map(value=>{const at=value.indexOf(':');return {type:value.slice(0,at),id:value.slice(at+1)};});
      wrap=value=>({ok:true,...value,...(p[1]==='me'?{earnings:value.earnings[0]}:{})});
    }else if(p[0]==='schedules'){
      if(p[1])target.id=p[1];action=method==='POST'?'payroll.schedule.create':method==='PATCH'?'payroll.schedule.update':method==='DELETE'?'payroll.schedule.archive':p[1]?'payroll.schedule.read':'payroll.schedules.list';if(method==='GET'||method==='DELETE')input=query;
      wrap=value=>({ok:true,[p[1]||method==='POST'?'schedule':'schedules']:value});
    }else if(p[0]==='policies'){
      if(p[1]==='effective'){action='payroll.policy.resolve';input={payee:{type:p[2],id:p[3],...(query.worker_type?{worker_type:query.worker_type}:{}),...(query.access_role_ids?{access_role_ids:query.access_role_ids.split(',')}:{}),...(query.resource_group_ids?{resource_group_ids:query.resource_group_ids.split(',')}: {})},earning_kind:query.earning_kind};}
      else if(method==='PUT'){action='payroll.policy.save';input={subject_type:p[1],subject_id:p[2],values:input};}
      else if(method==='DELETE'){action='payroll.policy.remove';input={subject_type:p[1],subject_id:p[2],earning_kind:query.earning_kind};}
      else{action='payroll.policies.list';input={};}wrap=value=>({ok:true,[method==='GET'&&!p[1]?'policies':'policy']:value});
    }else if(p[0]==='projects'){
      target.scope='project';target.projectId=p[1];
      action=p[2]==='payees'?(method==='GET'?'payroll.projectPayees.read':'payroll.projectPayees.set'):p[2]==='commission-events'?'payroll.commission.post':'payroll.commission.override';
      if(p[3])target.id=p[3];if(method==='GET')input={};wrap=value=>({ok:true,...(p[2]==='payees'?{[method==='GET'?'payee_roles':'payee_role']:value}:value)});
    }else if(p[0]==='ledger'||p[0]==='projections'){
      if(p[1])target.id=p[1];action=p[2]==='reverse'?'payroll.ledger.reverse':p[2]==='accrue'?'payroll.projection.accrue':method==='POST'?'payroll.ledger.post':p[1]?'payroll.ledger.read':'payroll.ledger.list';
      if(method==='GET')input=query;else if(action==='payroll.ledger.post')input={entries:Array.isArray(input.entries)?input.entries:[{...input,...(p[0]==='projections'?{state:'projected'}:{})}]};
      wrap=value=>({ok:true,...(p[0]==='projections'&&!p[1]?{projection:value[0]}:Array.isArray(value)?{entries:value}:{entry:value})});
    }else if(p[0]==='batches'){
      if(p[1])target.id=p[1];action=p[2]==='items'?'payroll.batch.item.update':p[2]==='actions'?'payroll.batch.action':method==='POST'?'payroll.batch.create':p[1]?'payroll.batch.read':'payroll.batches.list';if(p[2]==='items')input.item_id=p[3];if(method==='GET')input=query;wrap=value=>({ok:true,...(method==='GET'?{[p[1]?'batch':'batches']:value}:value)});
    }else if(p[0]==='timesheets'){
      if(p[1])target.id=p[1];action=p[2]==='approve'?'payroll.timesheet.approve':p[2]==='reject'?'payroll.timesheet.reject':method==='PATCH'?'payroll.timesheet.correct':'payroll.timesheets.list';if(method==='GET')input=query;wrap=value=>({ok:true,...(p[1]?{timesheet:value}:value)});
    }else if(p[0]==='exports'){action='payroll.exports.catalog';input={};wrap=value=>({ok:true,exports:value});}
    else if(p[0]==='artifacts'){action=method==='POST'?'payroll.artifact.generate':'payroll.artifacts.list';if(method==='GET')input=query;wrap=value=>({ok:true,[method==='POST'?'artifact':'artifacts']:value});}
    if(!action)throw Error('This payroll operation is unavailable.');
    const result=await root.PlatformAPI.publication.invoke(orgId,action,target,input,{...(method!=='GET'?{idempotencyKey:'payroll-'+root.crypto.randomUUID()}:{})});
    if(result.receipt&&result.receipt.status!=='succeeded')throw Error(result.message||'The payroll operation did not complete.');
    if(method!=='GET')root.dispatchEvent(new Event('fm:payroll:updated'));
    return wrap(result.value);
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
