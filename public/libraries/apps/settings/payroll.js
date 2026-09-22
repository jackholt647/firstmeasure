(function(root){
  'use strict';

  const APP = root.__APP || {};
  const EARNING_KINDS = [
    ['*', 'All earnings'],
    ['hourly', 'Hourly'],
    ['salary', 'Salary'],
    ['piece_rate', 'Piece rate'],
    ['commission', 'Commission'],
    ['adjustment', 'Adjustments'],
    ['clawback', 'Clawbacks']
  ];
  const SUBJECT_FILTERS = [
    ['all', 'All'],
    ['organization', 'Company'],
    ['access_role', 'Roles'],
    ['organization_user', 'People'],
    ['resource_group', 'Crews'],
    ['organization_connection', 'Subcontractors']
  ];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const COMMON_TIMEZONES = [
    'America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago',
    'America/New_York', 'America/Anchorage', 'Pacific/Honolulu', 'UTC'
  ];
  let mountSequence = 0;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[char]));
  const text = (...values) => {
    for (const value of values) {
      const result = String(value ?? '').trim();
      if (result) return result;
    }
    return '';
  };
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const array = (value) => Array.isArray(value) ? value : [];
  const rows = (value, ...keys) => {
    for (const key of keys) {
      if (Array.isArray(value?.[key])) return value[key];
    }
    return Array.isArray(value) ? value : [];
  };
  const enc = (value) => encodeURIComponent(text(value));
  const today = () => new Date().toISOString().slice(0, 10);
  const policyKey = (subjectType, subjectId, earningKind = '*') => `${subjectType}:${subjectId}:${earningKind || '*'}`;
  const subjectKey = (subjectType, subjectId) => `${subjectType}:${subjectId}`;
  const clampNumber = (value, min, max, fallback = min) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };

  function cookieValue(name){
    const target = `${encodeURIComponent(name)}=`;
    return document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(target))?.slice(target.length) || '';
  }

  function payrollBaseUrl(){
    const configured = text(APP.payrollApiBase, root.PayrollAPI?.baseUrl?.());
    if (configured) return configured.replace(/\/+$/, '');
    const platform = text(root.PlatformAPI?.baseUrl?.());
    if (platform) return platform.replace(/\/v1\/platform\/?$/i, '/v1/payroll').replace(/\/+$/, '');
    const host = text(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') return `${location.origin}/v1/payroll`;
    return `${location.origin}/v1/payroll`;
  }

  async function rawRequest(path, options = {}){
    const method = text(options.method, 'GET').toUpperCase();
    const body = options.body == null || typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    const headers = {
      Accept:'application/json',
      ...(body ? {'Content-Type':'application/json'} : {}),
      ...(options.headers || {})
    };
    const csrf = decodeURIComponent(cookieValue('fm_platform_session_csrf') || '');
    if (csrf && !['GET','HEAD','OPTIONS'].includes(method)) headers['X-Platform-CSRF'] = csrf;
    const response = await fetch(`${payrollBaseUrl()}/${String(path || '').replace(/^\/+/, '')}`, {
      method,
      body,
      headers,
      credentials:'include',
      cache:'no-store'
    });
    const responseText = await response.text();
    let data = null;
    try { data = responseText ? JSON.parse(responseText) : null; } catch(e) {}
    if (!response.ok || data?.ok === false) {
      const issue = array(data?.issues)[0];
      const error = new Error(text(data?.message, issue?.message, data?.error, `Payroll request failed (${response.status})`));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data || {};
  }

  function payrollClient(orgId){
    const api = root.PayrollAPI || {};
    const schedules = object(api.schedules);
    const policies = object(api.policies);
    return {
      listSchedules(options = {}){
        if (typeof schedules.list === 'function') return schedules.list(orgId, options);
        if (typeof api.listSchedules === 'function') return api.listSchedules(orgId, options);
        return rawRequest(`organizations/${enc(orgId)}/schedules?include_archived=${options.includeArchived === false ? '0' : '1'}`);
      },
      createSchedule(payload){
        if (typeof schedules.create === 'function') return schedules.create(orgId, payload);
        if (typeof api.createSchedule === 'function') return api.createSchedule(orgId, payload);
        return rawRequest(`organizations/${enc(orgId)}/schedules`, { method:'POST', body:payload });
      },
      updateSchedule(scheduleId, payload){
        if (typeof schedules.update === 'function') return schedules.update(orgId, scheduleId, payload);
        if (typeof schedules.patch === 'function') return schedules.patch(orgId, scheduleId, payload);
        if (typeof api.updateSchedule === 'function') return api.updateSchedule(orgId, scheduleId, payload);
        return rawRequest(`organizations/${enc(orgId)}/schedules/${enc(scheduleId)}`, { method:'PATCH', body:payload });
      },
      archiveSchedule(scheduleId, revision){
        if (typeof schedules.archive === 'function') return schedules.archive(orgId, scheduleId, revision);
        if (typeof api.archiveSchedule === 'function') return api.archiveSchedule(orgId, scheduleId, revision);
        return rawRequest(`organizations/${enc(orgId)}/schedules/${enc(scheduleId)}?expected_revision=${enc(revision)}`, { method:'DELETE' });
      },
      listPolicies(){
        if (typeof policies.list === 'function') return policies.list(orgId);
        if (typeof api.listPolicies === 'function') return api.listPolicies(orgId);
        return rawRequest(`organizations/${enc(orgId)}/policies`);
      },
      savePolicy(subjectType, subjectId, payload){
        if (typeof policies.save === 'function') return policies.save(orgId, subjectType, subjectId, payload);
        if (typeof policies.put === 'function') return policies.put(orgId, subjectType, subjectId, payload);
        if (typeof api.savePolicy === 'function') return api.savePolicy(orgId, subjectType, subjectId, payload);
        return rawRequest(`organizations/${enc(orgId)}/policies/${enc(subjectType)}/${enc(subjectId)}`, { method:'PUT', body:payload });
      },
      deletePolicy(subjectType, subjectId, earningKind){
        if (typeof policies.remove === 'function') return policies.remove(orgId, subjectType, subjectId, earningKind);
        if (typeof policies.delete === 'function') return policies.delete(orgId, subjectType, subjectId, earningKind);
        if (typeof api.deletePolicy === 'function') return api.deletePolicy(orgId, subjectType, subjectId, earningKind);
        return rawRequest(`organizations/${enc(orgId)}/policies/${enc(subjectType)}/${enc(subjectId)}?earning_kind=${enc(earningKind || '*')}`, { method:'DELETE' });
      }
    };
  }

  function injectCss(){
    if (document.getElementById('fmPayrollSettingsCss')) return;
    const style = document.createElement('style');
    style.id = 'fmPayrollSettingsCss';
    style.textContent = `
      .pycfg{min-height:620px;color:#182230}.pycfg *{box-sizing:border-box}.pycfg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:3px 1px 18px}.pycfg-head h3{font-size:23px;line-height:1.15;margin:0 0 6px;font-weight:1000}.pycfg-head p{max-width:720px;margin:0;color:#667085;font-size:12px;line-height:1.5}.pycfg-head-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.pycfg-nav{display:flex;gap:4px;border-bottom:1px solid #e4e7ec;margin-bottom:18px}.pycfg-nav button{appearance:none;border:0;border-bottom:3px solid transparent;background:transparent;padding:11px 14px 10px;color:#667085;font:900 12px/1 inherit;cursor:pointer}.pycfg-nav button.active{color:#101828;border-bottom-color:var(--primary-readable,var(--primary,#d93025))}.pycfg-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:16px}.pycfg-stat{border:1px solid #e4e7ec;border-radius:12px;background:#fff;padding:13px 14px;display:flex;align-items:center;gap:11px}.pycfg-stat i{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:#f2f4f7;color:#475467}.pycfg-stat strong{display:block;font-size:19px}.pycfg-stat span{display:block;color:#667085;font-size:9px;font-weight:950;text-transform:uppercase;letter-spacing:.04em;margin-top:2px}.pycfg-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:13px}.pycfg-toolbar-copy strong{display:block;font-size:14px}.pycfg-toolbar-copy span{display:block;color:#667085;font-size:10.5px;line-height:1.4;margin-top:3px}.pycfg-btn{appearance:none;min-height:36px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;padding:8px 12px;font:950 11px/1 inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px}.pycfg-btn:hover{background:#f9fafb}.pycfg-btn.primary{border-color:var(--primary-readable,var(--primary,#d93025));background:var(--primary-readable,var(--primary,#d93025));color:#fff}.pycfg-btn.danger{color:#b42318}.pycfg-btn:disabled{opacity:.55;cursor:default}.pycfg-list{display:grid;gap:10px}.pycfg-card{border:1px solid #e4e7ec;border-radius:13px;background:#fff;overflow:hidden}.pycfg-card.new{border-color:#b2ddff;box-shadow:0 0 0 3px #eff8ff}.pycfg-card>summary{list-style:none;display:grid;grid-template-columns:38px minmax(0,1fr) auto;align-items:center;gap:11px;padding:12px 14px;cursor:pointer}.pycfg-card>summary::-webkit-details-marker{display:none}.pycfg-card-icon{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:#f2f4f7;color:#475467}.pycfg-card.new .pycfg-card-icon{background:#eff8ff;color:#175cd3}.pycfg-card-title{min-width:0}.pycfg-card-title strong{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pycfg-card-title span{display:block;color:#667085;font-size:10px;font-weight:750;margin-top:3px}.pycfg-card-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}.pycfg-pill{display:inline-flex;align-items:center;border:1px solid #e4e7ec;border-radius:999px;background:#f9fafb;color:#475467;padding:4px 7px;font-size:9px;font-weight:950}.pycfg-pill.off{background:#f2f4f7;color:#667085}.pycfg-editor{border-top:1px solid #eaecf0;background:#f9fafb;padding:15px}.pycfg-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.pycfg-grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.pycfg-field{display:grid;align-content:start;gap:6px;min-width:0}.pycfg-field.wide{grid-column:1/-1}.pycfg-field>span{color:#475467;font-size:9.5px;font-weight:1000;text-transform:uppercase;letter-spacing:.035em}.pycfg-input,.pycfg-select{width:100%;min-height:38px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#101828;padding:8px 9px;font:800 11.5px/1.2 inherit;outline:none}.pycfg-input:focus,.pycfg-select:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.07)}.pycfg-recurrence-fields{display:contents}.pycfg-help{color:#667085;font-size:9.5px;line-height:1.45}.pycfg-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;margin-top:13px;flex-wrap:wrap}.pycfg-form-status{margin-right:auto;color:#667085;font-size:10px;font-weight:850}.pycfg-form-status.bad{color:#b42318}.pycfg-notice{border:1px solid #b2ddff;border-radius:10px;background:#eff8ff;color:#175cd3;padding:10px 12px;font-size:10.5px;font-weight:850;margin-bottom:13px}.pycfg-notice.bad{border-color:#fecdca;background:#fef3f2;color:#b42318}.pycfg-empty{border:1px dashed #d0d5dd;border-radius:13px;background:#fcfcfd;padding:30px;text-align:center;color:#667085;font-size:11px;font-weight:800}.pycfg-empty i{display:block;font-size:22px;margin-bottom:8px;color:#98a2b3}.pycfg-loading{padding:54px;text-align:center;color:#667085;font-size:12px;font-weight:900}.pycfg-loading i{margin-right:7px}.pycfg-filters{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:12px}.pycfg-search{position:relative;min-width:230px;flex:1}.pycfg-search i{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:#98a2b3;font-size:11px}.pycfg-search input{padding-left:32px}.pycfg-filter{appearance:none;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;padding:7px 10px;font:900 10px/1 inherit;cursor:pointer}.pycfg-filter.active{border-color:#84adff;background:#eff4ff;color:#3538cd}.pycfg-subject{border:1px solid #e4e7ec;border-radius:12px;background:#fff;overflow:hidden}.pycfg-subject-head{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:10px;align-items:center;padding:11px 12px;background:#fff}.pycfg-subject-icon{width:34px;height:34px;border-radius:9px;background:#f2f4f7;color:#475467;display:grid;place-items:center}.pycfg-subject-copy strong{display:block;font-size:12px}.pycfg-subject-copy span{display:block;color:#667085;font-size:9.5px;margin-top:3px}.pycfg-rules{border-top:1px solid #eaecf0;background:#f9fafb;padding:10px;display:grid;gap:7px}.pycfg-rule{display:grid;grid-template-columns:minmax(125px,.8fr) minmax(160px,1.2fr) minmax(140px,1fr) 108px auto;gap:7px;align-items:end;border:1px solid #e4e7ec;border-radius:9px;background:#fff;padding:9px}.pycfg-rule .pycfg-field>span{font-size:8.5px}.pycfg-rule-actions{display:flex;gap:5px}.pycfg-rule-actions .pycfg-btn{width:35px;height:35px;min-height:35px;padding:0}.pycfg-rule-status{grid-column:1/-1;color:#667085;font-size:9.5px;font-weight:850;min-height:0}.pycfg-rule-status.bad{color:#b42318}.pycfg-inherit{color:#667085;font-size:9.5px;font-style:italic}.pycfg-directory-warning{margin-top:12px;color:#93370d;background:#fffaeb;border:1px solid #fedf89;border-radius:9px;padding:9px 11px;font-size:10px;font-weight:800}
      .pycfg{max-width:1380px;margin:0 auto}.pycfg-head{padding:2px 0 16px;border-bottom:1px solid #eaecf0;margin-bottom:16px;align-items:center}.pycfg-head h3{font-size:20px}.pycfg-head p{max-width:640px}.pycfg-schedule-bar{display:grid;gap:9px;margin-bottom:14px}.pycfg-schedule-bar-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.pycfg-schedule-bar-head strong{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#475467}.pycfg-schedule-scroll{display:flex;gap:8px;overflow-x:auto;padding:1px 1px 4px;scrollbar-width:thin}.pycfg-schedule-choice{appearance:none;display:grid;grid-template-columns:32px minmax(130px,1fr) auto;align-items:center;gap:9px;min-width:225px;max-width:310px;border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:9px 10px;color:#344054;text-align:left;cursor:pointer}.pycfg-schedule-choice:hover{border-color:#b9c0cc;background:#fcfcfd}.pycfg-schedule-choice.active{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.08)}.pycfg-schedule-choice.archived{opacity:.68}.pycfg-schedule-choice>i{width:32px;height:32px;border-radius:8px;background:#f2f4f7;display:grid;place-items:center}.pycfg-schedule-choice.active>i{background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025))}.pycfg-schedule-choice span{min-width:0}.pycfg-schedule-choice strong,.pycfg-schedule-choice small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pycfg-schedule-choice strong{font-size:11px}.pycfg-schedule-choice small{font-size:9px;color:#667085;margin-top:3px}.pycfg-count{min-width:23px;height:23px;border-radius:999px;background:#f2f4f7;color:#475467;display:grid;place-items:center;font-size:9px;font-weight:1000}.pycfg-add-schedule{flex:0 0 auto;min-width:120px}.pycfg-workspace{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(380px,.92fr);gap:14px;align-items:start}.pycfg-panel{border:1px solid #e4e7ec;border-radius:14px;background:#fff;overflow:hidden;box-shadow:0 2px 7px rgba(16,24,40,.025)}.pycfg-panel.new{border-color:#b2ddff;box-shadow:0 0 0 3px #eff8ff}.pycfg-panel-head{min-height:58px;padding:11px 13px;border-bottom:1px solid #eaecf0;display:flex;align-items:center;justify-content:space-between;gap:12px;background:#fcfcfd}.pycfg-panel-head>span:first-child{min-width:0}.pycfg-panel-head small,.pycfg-panel-head strong{display:block}.pycfg-panel-head small{font-size:8.5px;font-weight:1000;text-transform:uppercase;letter-spacing:.055em;color:#667085;margin-bottom:3px}.pycfg-panel-head strong{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pycfg-panel-head-actions{display:flex;align-items:center;gap:7px}.pycfg-panel-body{padding:14px}.pycfg-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.pycfg-assignments-body{padding:10px;display:grid;gap:8px;max-height:650px;overflow:auto}.pycfg-assignment{border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:10px;display:grid;gap:9px}.pycfg-assignment-head{display:grid;grid-template-columns:34px minmax(0,1fr) 30px;gap:9px;align-items:center}.pycfg-icon-btn{appearance:none;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:#667085;cursor:pointer}.pycfg-icon-btn:hover{background:#f2f4f7}.pycfg-icon-btn.danger:hover{background:#fef3f2;color:#b42318}.pycfg-assignment-fields{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(100px,.75fr) auto;gap:7px;align-items:end;padding-left:43px}.pycfg-assignment-fields .pycfg-btn{height:38px}.pycfg-percent{position:relative}.pycfg-percent .pycfg-input{padding-right:25px}.pycfg-percent>span{position:absolute;right:9px;top:12px;color:#667085;font-size:10px;font-weight:900}.pycfg-add-box{border:1px solid #b2ddff;border-radius:11px;background:#f5faff;padding:11px;display:grid;gap:10px}.pycfg-add-box-head{display:flex;justify-content:space-between;align-items:center;gap:10px}.pycfg-add-box-head strong{font-size:11px}.pycfg-add-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(110px,.65fr);gap:8px}.pycfg-add-grid .wide{grid-column:1/-1}.pycfg-add-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px}.pycfg-assignment-empty{padding:34px 20px;text-align:center;color:#667085}.pycfg-assignment-empty i{width:40px;height:40px;border-radius:12px;background:#f2f4f7;display:grid;place-items:center;margin:0 auto 10px;color:#98a2b3}.pycfg-assignment-empty strong,.pycfg-assignment-empty span{display:block}.pycfg-assignment-empty strong{font-size:12px;color:#344054}.pycfg-assignment-empty span{font-size:10px;line-height:1.5;margin-top:4px}.pycfg-directory-warning{margin:0 10px 10px}.pycfg-notice{margin-bottom:12px}
      .pycfg-advanced{border:1px solid #e4e7ec;border-radius:10px;margin-top:12px;background:#fcfcfd;overflow:hidden}.pycfg-advanced>summary{list-style:none;min-height:43px;padding:9px 11px;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;color:#475467}.pycfg-advanced>summary::-webkit-details-marker{display:none}.pycfg-advanced>summary>span{display:grid;grid-template-columns:22px auto;grid-template-rows:auto auto;align-items:center}.pycfg-advanced>summary>span>i{grid-row:1/3}.pycfg-advanced>summary strong{font-size:10.5px}.pycfg-advanced>summary small{font-size:9px;color:#667085;margin-top:2px}.pycfg-advanced>summary>i{font-size:9px;transition:transform .16s}.pycfg-advanced[open]>summary>i{transform:rotate(180deg)}.pycfg-advanced-grid{border-top:1px solid #eaecf0;padding:11px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;background:#fff}.pycfg-picker{border:1px solid #d0d5dd;border-radius:10px;background:#fff;overflow:hidden}.pycfg-picker-search{position:relative;display:block;padding:9px}.pycfg-picker-search>i{position:absolute;left:20px;top:22px;color:#98a2b3;font-size:10px}.pycfg-picker-search .pycfg-input{padding-left:31px}.pycfg-picker-filters{display:flex;gap:5px;padding:0 9px 8px;overflow-x:auto;scrollbar-width:thin}.pycfg-picker-filter{appearance:none;flex:0 0 auto;border:1px solid #e4e7ec;border-radius:999px;background:#fff;color:#667085;padding:5px 7px;font:900 8.5px/1 inherit;cursor:pointer}.pycfg-picker-filter span{display:inline-grid;place-items:center;min-width:16px;height:16px;margin-left:4px;border-radius:999px;background:#f2f4f7;color:#475467}.pycfg-picker-filter.active{border-color:#84adff;background:#eff4ff;color:#3538cd}.pycfg-picker-results{max-height:250px;overflow:auto;border-top:1px solid #eaecf0;padding:5px;display:grid;gap:3px}.pycfg-picker-result{appearance:none;width:100%;border:0;border-radius:8px;background:#fff;color:#344054;padding:7px;display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:8px;align-items:center;text-align:left;cursor:pointer}.pycfg-picker-result:hover:not(:disabled){background:#f9fafb}.pycfg-picker-result.selected{background:#eff8ff;box-shadow:inset 0 0 0 1px #b2ddff}.pycfg-picker-result:disabled{opacity:.5;cursor:default}.pycfg-picker-copy{min-width:0}.pycfg-picker-copy strong,.pycfg-picker-copy small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pycfg-picker-copy strong{font-size:10.5px}.pycfg-picker-copy small{font-size:8.5px;color:#667085;margin-top:3px}.pycfg-picker-check{width:22px;height:22px;border-radius:999px;background:#1570ef;color:#fff;display:grid;place-items:center;font-size:9px}.pycfg-picker-state{font-size:8px;font-weight:900;color:#667085}.pycfg-picker-empty{padding:24px;text-align:center;color:#667085;font-size:10px}.pycfg-picker-empty i{display:block;margin-bottom:6px;color:#98a2b3}.pycfg-picker-more{border-top:1px solid #eaecf0;padding:7px 10px;color:#667085;font-size:8.5px;font-weight:750;background:#fcfcfd}
      .pycfg-picker-selected{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:8px;align-items:center;margin:9px 9px 0;padding:7px;border:1px solid #b2ddff;border-radius:9px;background:#eff8ff}.pycfg-picker-selected small,.pycfg-picker-selected strong{display:block}.pycfg-picker-selected small{font-size:7.5px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#175cd3}.pycfg-picker-selected strong{font-size:10.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pycfg-picker-selected em{font-size:8px;font-weight:900;font-style:normal;color:#475467}
      @media(max-width:980px){.pycfg-workspace{grid-template-columns:1fr}.pycfg-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pycfg-assignments-body{max-height:none}.pycfg-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pycfg-rule{grid-template-columns:repeat(2,minmax(0,1fr))}.pycfg-rule-actions{align-self:end}}@media(max-width:660px){.pycfg-head,.pycfg-toolbar{align-items:stretch;flex-direction:column}.pycfg-head-actions{justify-content:flex-start}.pycfg-detail-grid,.pycfg-add-grid,.pycfg-assignment-fields,.pycfg-advanced-grid{grid-template-columns:1fr}.pycfg-assignment-fields{padding-left:0}.pycfg-add-grid .wide{grid-column:auto}.pycfg-schedule-choice{min-width:205px}.pycfg-panel-head{align-items:flex-start}.pycfg-panel-head-actions{flex-wrap:wrap;justify-content:flex-end}.pycfg-grid,.pycfg-grid.two,.pycfg-rule{grid-template-columns:1fr}.pycfg-search{min-width:100%}}
    `;
    document.head.appendChild(style);
  }

  function frequencyLabel(schedule){
    const recurrence = object(schedule?.recurrence);
    const weekday = WEEKDAYS[Number(recurrence.weekday)] || 'day';
    if (recurrence.frequency === 'weekly') return `Weekly on ${weekday}`;
    if (recurrence.frequency === 'biweekly') return `Every other ${weekday}`;
    if (recurrence.frequency === 'semi_monthly') return `Monthly on ${array(recurrence.days).join(' & ') || '1 & 15'}`;
    if (recurrence.frequency === 'monthly') return `Monthly on day ${Number(recurrence.day || 1)}`;
    return 'Payroll schedule';
  }

  function delayLabel(schedule){
    const delay = object(schedule?.delay);
    const parts = [];
    if (Number(delay.periods || 0)) parts.push(`${Number(delay.periods)} period${Number(delay.periods) === 1 ? '' : 's'}`);
    if (Number(delay.days || 0)) parts.push(`${Number(delay.days)} day${Number(delay.days) === 1 ? '' : 's'}`);
    return parts.length ? `${parts.join(' + ')} delay` : 'No delay';
  }

  function earningKindLabel(value){
    return EARNING_KINDS.find(([id]) => id === text(value, '*'))?.[1] || text(value).replace(/_/g, ' ');
  }

  function subjectTypeLabel(value){
    return ({ organization:'Company', access_role:'Role', organization_user:'Person', resource_group:'Crew', organization_connection:'Subcontractor' })[value] || value;
  }

  function subjectIcon(value){
    return ({ organization:'fa-building', access_role:'fa-user-shield', organization_user:'fa-user', resource_group:'fa-people-group', organization_connection:'fa-handshake' })[value] || 'fa-circle';
  }

  function recurrenceFieldsMarkup(frequency, recurrence = {}){
    if (frequency === 'weekly' || frequency === 'biweekly') {
      return `
        <label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_4e3a8284908d02","Pay weekday") ?? "Pay weekday")}</span><select class="pycfg-select" data-recurrence-weekday>${String(WEEKDAYS.map((day, index) => `<option value="${index}" ${Number(recurrence.weekday ?? 5) === index ? 'selected' : ''}>${esc(day)}</option>`).join(''))}</select></label>
        ${String(frequency === 'biweekly' ? `<label class="pycfg-field"><span>Anchor pay date</span><input class="pycfg-input" type="date" data-recurrence-anchor value="${esc(recurrence.anchor_date || today())}" required></label>` : '')}`;
    }
    if (frequency === 'semi_monthly') {
      return `<label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_d21d347eb225a6","Pay days") ?? "Pay days")}</span><input class="pycfg-input" data-recurrence-days value="${String(esc(array(recurrence.days).length ? recurrence.days.join(', ') : '1, 15'))}" placeholder="1, 15"><small class="pycfg-help">${(globalThis.PlatformLanguage?.text("settings","m_6c17accab12e73","Use up to four month days, separated by commas.") ?? "Use up to four month days, separated by commas.")}</small></label>`;
    }
    return `<label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_2ce914dfcc342d","Month day") ?? "Month day")}</span><input class="pycfg-input" type="number" min="1" max="31" data-recurrence-day value="${String(esc(Number(recurrence.day || 1)))}"></label>`;
  }

  function timezoneOptions(current){
    const browserZone = browserTimezone();
    return [...new Set([current, browserZone, ...COMMON_TIMEZONES].filter(Boolean))]
      .map((zone) => `<option value="${esc(zone)}"></option>`).join('');
  }

  function browserTimezone(){
    try { return Intl.DateTimeFormat(globalThis.PlatformLanguage?.formatLocale?.()).resolvedOptions().timeZone || ''; } catch(e) { return ''; }
  }

  function scheduleEditorMarkup(schedule = {}, isNew = false){
    const recurrence = object(schedule.recurrence);
    const frequency = text(recurrence.frequency, 'weekly');
    const scheduleId = text(schedule.id, '__new__');
    const name = text(schedule.name, 'New pay schedule');
    const timing = text(schedule.timing_basis, 'worked');
    const delay = object(schedule.delay);
    const timezone = text(schedule.timezone, browserTimezone(), 'UTC');
    return `<section class="pycfg-panel pycfg-details-panel ${String(isNew ? 'new' : '')}">
      <header class="pycfg-panel-head"><span><small>${(globalThis.PlatformLanguage?.text("settings","m_9d0b9f0ccddeeb","Schedule details") ?? "Schedule details")}</small><strong>${String(esc(name))}</strong></span>${String(isNew ? '<span class="pycfg-pill">New</span>' : `<span class="pycfg-pill ${schedule.status === 'archived' ? 'off' : ''}">${esc(schedule.status || 'active')}</span>`)}</header>
      <form class="pycfg-panel-body" data-schedule-form data-schedule-id="${String(esc(scheduleId))}">
        <div class="pycfg-detail-grid">
          <label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_9abccb09d5d19a","Schedule name") ?? "Schedule name")}</span><input class="pycfg-input" data-schedule-name value="${String(esc(isNew ? '' : schedule.name))}" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_6e26b31256545b","Weekly crew payroll") ?? "Weekly crew payroll")}" required></label>
          <label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_ff7bb68b2b05a8","Frequency") ?? "Frequency")}</span><select class="pycfg-select" data-schedule-frequency><option value="weekly" ${String(frequency === 'weekly' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("settings","m_093d55e6272fc0","Weekly") ?? "Weekly")}</option><option value="biweekly" ${String(frequency === 'biweekly' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("settings","m_364b57ed00593d","Biweekly") ?? "Biweekly")}</option><option value="semi_monthly" ${String(frequency === 'semi_monthly' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("settings","m_39716bce428ab1","Semi-monthly") ?? "Semi-monthly")}</option><option value="monthly" ${String(frequency === 'monthly' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("settings","m_d7014f792d2583","Monthly") ?? "Monthly")}</option></select></label>
          <span class="pycfg-recurrence-fields" data-recurrence-fields>${String(recurrenceFieldsMarkup(frequency, recurrence))}</span>
          <label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_34500407fc8794","Delay — periods") ?? "Delay — periods")}</span><input class="pycfg-input" type="number" min="0" max="26" data-delay-periods value="${String(esc(Number(delay.periods || 0)))}"><small class="pycfg-help">${(globalThis.PlatformLanguage?.text("settings","m_e71ff6fb318f0e","One period is common for weekly payroll.") ?? "One period is common for weekly payroll.")}</small></label>
          <label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_74b3b541b7b255","Extra delay — days") ?? "Extra delay — days")}</span><input class="pycfg-input" type="number" min="0" max="365" data-delay-days value="${String(esc(Number(delay.days || 0)))}"></label>
          <label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_e293c8fccb7de8","Default recognition") ?? "Default recognition")}</span><select class="pycfg-select" data-schedule-timing><option value="worked" ${String(timing === 'worked' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("settings","m_12ee42c07782b8","When work is performed") ?? "When work is performed")}</option><option value="completed" ${String(timing === 'completed' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("settings","m_60d38c1d5a3e58","When the job is completed") ?? "When the job is completed")}</option></select></label>
        </div>
        <details class="pycfg-advanced"><summary><span><i class="fas fa-sliders"></i><strong>${(globalThis.PlatformLanguage?.text("settings","m_eac1a2ef5e4c32","Advanced settings") ?? "Advanced settings")}</strong><small>${(globalThis.PlatformLanguage?.text("settings","m_f03565669d0bd9","Timezone and clawback limits") ?? "Timezone and clawback limits")}</small></span><i class="fas fa-chevron-down"></i></summary><div class="pycfg-advanced-grid"><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_4a5d83497b6e10","Timezone") ?? "Timezone")}</span><input class="pycfg-input" list="pycfgTimezoneOptions" data-schedule-timezone value="${String(esc(timezone))}" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_1cf50d801bfa46","America/Los_Angeles") ?? "America/Los_Angeles")}" required><datalist id="pycfgTimezoneOptions">${String(timezoneOptions(timezone))}</datalist></label><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_f5ccb81445da5a","Clawback cap / check") ?? "Clawback cap / check")}</span><div class="pycfg-percent"><input class="pycfg-input" type="number" min="0" max="100" step="0.01" data-schedule-clawback value="${String(esc(Number(schedule.clawback_cap_percent ?? 100)))}"><span>%</span></div></label></div></details>
        <div class="pycfg-actions"><span class="pycfg-form-status" data-form-status></span>${String(isNew ? '<button class="pycfg-btn" type="button" data-cancel-new>Cancel</button>' : `<button class="pycfg-btn danger" type="button" data-archive-schedule ${schedule.status === 'archived' ? 'disabled' : ''}><i class="fas fa-box-archive"></i> Archive</button>`)}<button class="pycfg-btn primary" type="submit"><i class="fas fa-floppy-disk"></i> ${String(isNew ? 'Create schedule' : 'Save changes')}</button></div>
      </form>
    </section>`;
  }

  function schedulePayload(form, existing = {}){
    const frequency = text(form.querySelector('[data-schedule-frequency]')?.value, 'weekly');
    const recurrence = { frequency };
    if (frequency === 'weekly' || frequency === 'biweekly') recurrence.weekday = Number(form.querySelector('[data-recurrence-weekday]')?.value ?? 5);
    if (frequency === 'biweekly') recurrence.anchor_date = text(form.querySelector('[data-recurrence-anchor]')?.value);
    if (frequency === 'semi_monthly') {
      recurrence.days = [...new Set(text(form.querySelector('[data-recurrence-days]')?.value).split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value >= 1 && value <= 31))].slice(0, 4);
      if (!recurrence.days.length) throw new Error('Enter at least one valid semi-monthly pay day.');
    }
    if (frequency === 'monthly') recurrence.day = Math.round(clampNumber(form.querySelector('[data-recurrence-day]')?.value, 1, 31, 1));
    if (frequency === 'biweekly' && !recurrence.anchor_date) throw new Error('Choose an anchor pay date for the biweekly schedule.');
    const name = text(form.querySelector('[data-schedule-name]')?.value);
    if (!name) throw new Error('Enter a schedule name.');
    const timezone = text(form.querySelector('[data-schedule-timezone]')?.value);
    if (!timezone) throw new Error('Enter an IANA timezone.');
    return {
      name,
      status:text(existing.status, 'active'),
      currency:text(existing.currency, 'USD'),
      timezone,
      recurrence,
      delay:{
        periods:Math.round(clampNumber(form.querySelector('[data-delay-periods]')?.value, 0, 26, 0)),
        days:Math.round(clampNumber(form.querySelector('[data-delay-days]')?.value, 0, 365, 0))
      },
      timing_basis:text(form.querySelector('[data-schedule-timing]')?.value, 'worked'),
      clawback_cap_percent:clampNumber(form.querySelector('[data-schedule-clawback]')?.value, 0, 100, 100),
      metadata:object(existing.metadata),
      ...(Number(existing.revision || 0) > 0 ? { expected_revision:Number(existing.revision) } : {})
    };
  }

  function assignmentRuleMarkup(subject, policy = {}){
    const earningKind = text(policy.earning_kind, '*');
    return `<form class="pycfg-assignment" data-policy-form data-subject-type="${String(esc(subject.type))}" data-subject-id="${String(esc(subject.id))}" data-policy-kind="${String(esc(earningKind))}" data-policy-revision="${String(esc(policy.revision || ''))}" data-schedule-id="${String(esc(policy.schedule_id))}">
      <header class="pycfg-assignment-head"><span class="pycfg-subject-icon"><i class="fas ${String(subjectIcon(subject.type))}"></i></span><span class="pycfg-subject-copy"><strong>${String(esc(subject.label))}</strong><span>${String(esc(subjectTypeLabel(subject.type)))} · ${String(esc(earningKindLabel(earningKind)))}</span></span><button class="pycfg-icon-btn danger" type="button" data-delete-policy title="${(globalThis.PlatformLanguage?.text("settings","m_c1ddc7495a6c43","Remove assignment") ?? "Remove assignment")}" aria-label="${(globalThis.PlatformLanguage?.text("settings","m_c1ddc7495a6c43","Remove assignment") ?? "Remove assignment")}"><i class="fas fa-trash"></i></button></header>
      <div class="pycfg-assignment-fields"><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_48cacd50d701d8","Recognition") ?? "Recognition")}</span><select class="pycfg-select" data-policy-timing><option value="">${(globalThis.PlatformLanguage?.text("settings","m_e8b95430c3cd30","Schedule default") ?? "Schedule default")}</option><option value="worked" ${String(policy.timing_basis === 'worked' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("settings","m_12ee42c07782b8","When work is performed") ?? "When work is performed")}</option><option value="completed" ${String(policy.timing_basis === 'completed' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("settings","m_5eda8826a44a2d","When job is completed") ?? "When job is completed")}</option></select></label><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_57c29b3ae2c29b","Clawback cap") ?? "Clawback cap")}</span><div class="pycfg-percent"><input class="pycfg-input" data-policy-clawback type="number" min="0" max="100" step="0.01" value="${String(policy.clawback_cap_percent == null ? '' : esc(policy.clawback_cap_percent))}" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_f59e6b09f14267","Default") ?? "Default")}"><span>%</span></div></label><button class="pycfg-btn" type="submit"><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.text("settings","m_13fcb6ceae139c"," Save") ?? " Save")}</button></div>
      <span class="pycfg-rule-status" data-policy-status></span>
    </form>`;
  }

  function mount(host, options = {}){
    if (!host) return null;
    if (host._firstMatePayrollSettings?.destroy) return host._firstMatePayrollSettings;
    injectCss();
    host.dataset.payrollSettingsMounted = '1';
    const orgId = text(options.orgId, APP.userOrgId);
    const branchId = text(options.branchId, APP.userBranchId, 'default');
    const toast = typeof options.showToast === 'function' ? options.showToast : (() => {});
    const onBack = typeof options.onBack === 'function' ? options.onBack : null;
    const routeTab = text(options.routeTab, 'company_settings');
    const routeHandlerId = text(options.routeHandlerId, `payroll-settings-view:${routeTab}:${++mountSequence}`);
    const client = payrollClient(orgId);
    let destroyed = false;
    let unregisterRoute = null;
    const initialRoute = object(root.Portal?.navigation?.read?.());
    const state = {
      loading:true,
      schedules:[],
      policies:[],
      subjects:[],
      directoryWarning:'',
      error:'',
      notice:'',
      noticeTone:'',
      addingSchedule:false,
      addingAssignment:false,
      selectedScheduleId:text(initialRoute.settingsEntity),
      newAssignmentSubjectKey:'',
      assignmentQuery:'',
      assignmentType:'all'
    };

    const controller = {
      destroy(){
        destroyed = true;
        unregisterRoute?.();
        delete host.dataset.payrollSettingsMounted;
        delete host._firstMatePayrollSettings;
      },
      refresh(){ return load(true); }
    };
    host._firstMatePayrollSettings = controller;

    function setNotice(message, tone = ''){
      state.notice = text(message);
      state.noticeTone = tone;
    }

    function sortedSchedules(){
      return [...state.schedules].sort((left,right) => (left.status === 'archived') - (right.status === 'archived') || text(left.name).localeCompare(text(right.name)));
    }

    function ensureSelectedSchedule(preferredId = ''){
      const requested = text(preferredId, state.selectedScheduleId);
      const schedules = sortedSchedules();
      state.selectedScheduleId = schedules.some((schedule) => schedule.id === requested)
        ? requested
        : text(schedules.find((schedule) => schedule.status !== 'archived')?.id, schedules[0]?.id);
      return state.schedules.find((schedule) => schedule.id === state.selectedScheduleId) || null;
    }

    function selectedSchedule(){
      return state.addingSchedule ? null : ensureSelectedSchedule();
    }

    function subjectForPolicy(policy){
      return state.subjects.find((subject) => subject.type === policy.subject_type && subject.id === policy.subject_id)
        || { type:text(policy.subject_type, 'organization_user'), id:text(policy.subject_id), label:text(policy.subject_name, policy.subject_id, 'Unknown assignment'), subtitle:subjectTypeLabel(policy.subject_type) };
    }

    function schedulePolicyCount(scheduleId){
      return state.policies.filter((policy) => policy.schedule_id === scheduleId).length;
    }

    function scheduleBarMarkup(){
      const schedules = sortedSchedules();
      return `<section class="pycfg-schedule-bar"><div class="pycfg-schedule-bar-head"><strong>${(globalThis.PlatformLanguage?.text("settings","m_9cbe6bfc19fa8f","Pay schedules") ?? "Pay schedules")}</strong><button class="pycfg-btn primary pycfg-add-schedule" type="button" data-add-schedule ${String(state.addingSchedule ? 'disabled' : '')}><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("settings","m_2503a15c876890"," New schedule") ?? " New schedule")}</button></div><div class="pycfg-schedule-scroll">${String(schedules.map((schedule) => `<button class="pycfg-schedule-choice ${!state.addingSchedule && schedule.id === state.selectedScheduleId ? 'active' : ''} ${schedule.status === 'archived' ? 'archived' : ''}" type="button" data-select-schedule="${esc(schedule.id)}"><i class="fas fa-calendar-days"></i><span><strong>${esc(schedule.name)}</strong><small>${esc(frequencyLabel(schedule))} · ${esc(delayLabel(schedule))}</small></span><span class="pycfg-count" title="${schedulePolicyCount(schedule.id)} assignments">${schedulePolicyCount(schedule.id)}</span></button>`).join(''))}</div></section>`;
    }

    function availableSubject(){
      const requested = state.subjects.find((subject) => subjectKey(subject.type, subject.id) === state.newAssignmentSubjectKey);
      const candidates = requested ? [requested, ...state.subjects.filter((subject) => subject !== requested)] : state.subjects;
      return candidates.find((subject) => {
        const used = new Set(state.policies.filter((policy) => policy.subject_type === subject.type && policy.subject_id === subject.id).map((policy) => text(policy.earning_kind, '*')));
        return EARNING_KINDS.some(([kind]) => !used.has(kind));
      }) || state.subjects[0] || null;
    }

    function usedKindsForSubject(subject){
      return new Set(state.policies.filter((policy) => policy.subject_type === subject.type && policy.subject_id === subject.id).map((policy) => text(policy.earning_kind, '*')));
    }

    function assignmentPickerMarkup(selectedSubject){
      const query = state.assignmentQuery.trim().toLowerCase();
      const matches = state.subjects.filter((subject) => state.assignmentType === 'all' || subject.type === state.assignmentType)
        .filter((subject) => !query || `${subject.label} ${subject.subtitle} ${subjectTypeLabel(subject.type)}`.toLowerCase().includes(query));
      const visible = matches.slice(0, 50);
      const selectedKey = subjectKey(selectedSubject.type, selectedSubject.id);
      const filters = SUBJECT_FILTERS.map(([type,label]) => {
        const count = type === 'all' ? state.subjects.length : state.subjects.filter((subject) => subject.type === type).length;
        return `<button class="pycfg-picker-filter ${state.assignmentType === type ? 'active' : ''}" type="button" data-assignment-type="${esc(type)}">${esc(label)}<span>${count}</span></button>`;
      }).join('');
      const results = visible.map((subject) => {
        const key = subjectKey(subject.type, subject.id);
        const fullyAssigned = usedKindsForSubject(subject).size >= EARNING_KINDS.length;
        return `<button class="pycfg-picker-result ${key === selectedKey ? 'selected' : ''}" type="button" data-select-subject="${esc(key)}" ${fullyAssigned ? 'disabled' : ''}><span class="pycfg-subject-icon"><i class="fas ${subjectIcon(subject.type)}"></i></span><span class="pycfg-picker-copy"><strong>${esc(subject.label)}</strong><small>${esc(subjectTypeLabel(subject.type))}${subject.subtitle ? ` · ${esc(subject.subtitle)}` : ''}</small></span>${fullyAssigned ? `<span class="pycfg-picker-state">${(globalThis.PlatformLanguage?.text("settings","m_38dd0cd687c5de","Fully assigned") ?? "Fully assigned")}</span>` : (key === selectedKey ? '<span class="pycfg-picker-check"><i class="fas fa-check"></i></span>' : '')}</button>`;
      }).join('');
      return `<div class="pycfg-picker"><input type="hidden" data-new-policy-subject value="${String(esc(selectedKey))}"><div class="pycfg-picker-selected"><span class="pycfg-subject-icon"><i class="fas ${String(subjectIcon(selectedSubject.type))}"></i></span><span><small>${(globalThis.PlatformLanguage?.text("settings","m_ecefc9f177951e","Selected") ?? "Selected")}</small><strong>${String(esc(selectedSubject.label))}</strong></span><em>${String(esc(subjectTypeLabel(selectedSubject.type)))}</em></div><label class="pycfg-picker-search"><i class="fas fa-magnifying-glass"></i><input class="pycfg-input" data-assignment-search value="${String(esc(state.assignmentQuery))}" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_6b61f6c918bae3","Search by name, email, role, crew, or company") ?? "Search by name, email, role, crew, or company")}"></label><div class="pycfg-picker-filters">${String(filters)}</div><div class="pycfg-picker-results">${String(results || '<div class="pycfg-picker-empty"><i class="fas fa-magnifying-glass"></i><span>No matching people or groups</span></div>')}</div>${String(matches.length > visible.length ? `<div class="pycfg-picker-more">Showing the first ${visible.length} of ${matches.length}. Refine your search to narrow the list.</div>` : '')}</div>`;
    }

    function newAssignmentMarkup(schedule){
      const subject = availableSubject();
      if (!subject) return `<div class="pycfg-assignment-empty"><i class="fas fa-user-slash"></i><strong>${(globalThis.PlatformLanguage?.text("settings","m_04ecac3086270f","No assignable people or groups") ?? "No assignable people or groups")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_fc7f9797b2eeb3","Workforce directories must be available before an assignment can be added.") ?? "Workforce directories must be available before an assignment can be added.")}</span></div>`;
      const selectedKey = subjectKey(subject.type, subject.id);
      state.newAssignmentSubjectKey = selectedKey;
      const usedKinds = usedKindsForSubject(subject);
      const firstKind = EARNING_KINDS.find(([kind]) => !usedKinds.has(kind))?.[0] || '*';
      return `<form class="pycfg-add-box" data-new-policy data-schedule-id="${String(esc(schedule.id))}"><div class="pycfg-add-box-head"><strong>${((v1) => globalThis.PlatformLanguage?.text("settings","m_33a54b5d181801",`Add to ${v1}`,{v1}) ?? `Add to ${v1}`)(esc(schedule.name))}</strong><button class="pycfg-icon-btn" type="button" data-cancel-policy aria-label="${(globalThis.PlatformLanguage?.text("settings","m_cbef679b21abb4","Cancel") ?? "Cancel")}"><i class="fas fa-xmark"></i></button></div>${String(assignmentPickerMarkup(subject))}<div class="pycfg-add-grid"><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_52a6d3b60d5b9d","Earning type") ?? "Earning type")}</span><select class="pycfg-select" data-policy-earning>${String(EARNING_KINDS.map(([kind,label]) => `<option value="${esc(kind)}" ${kind === firstKind ? 'selected' : ''} ${usedKinds.has(kind) ? 'disabled' : ''}>${esc(label)}${usedKinds.has(kind) ? ' · already assigned' : ''}</option>`).join(''))}</select></label><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_48cacd50d701d8","Recognition") ?? "Recognition")}</span><select class="pycfg-select" data-policy-timing><option value="">${(globalThis.PlatformLanguage?.text("settings","m_e8b95430c3cd30","Schedule default") ?? "Schedule default")}</option><option value="worked">${(globalThis.PlatformLanguage?.text("settings","m_12ee42c07782b8","When work is performed") ?? "When work is performed")}</option><option value="completed">${(globalThis.PlatformLanguage?.text("settings","m_5eda8826a44a2d","When job is completed") ?? "When job is completed")}</option></select></label><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.text("settings","m_57c29b3ae2c29b","Clawback cap") ?? "Clawback cap")}</span><div class="pycfg-percent"><input class="pycfg-input" data-policy-clawback type="number" min="0" max="100" step="0.01" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_e8b95430c3cd30","Schedule default") ?? "Schedule default")}"><span>%</span></div></label></div><div class="pycfg-add-actions"><span class="pycfg-form-status" data-policy-status></span><button class="pycfg-btn" type="button" data-cancel-policy>${(globalThis.PlatformLanguage?.text("settings","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button class="pycfg-btn primary" type="submit"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("settings","m_d45b3331bcd9fc"," Add assignment") ?? " Add assignment")}</button></div></form>`;
    }

    function assignmentsPanelMarkup(schedule){
      const policies = state.policies.filter((policy) => policy.schedule_id === schedule.id).sort((left,right) => {
        const leftSubject = subjectForPolicy(left);
        const rightSubject = subjectForPolicy(right);
        return text(leftSubject.label).localeCompare(text(rightSubject.label)) || earningKindLabel(left.earning_kind).localeCompare(earningKindLabel(right.earning_kind));
      });
      return `<section class="pycfg-panel pycfg-assignments-panel"><header class="pycfg-panel-head"><span><small>${(globalThis.PlatformLanguage?.text("settings","m_e426de72d66b56","Assigned to this schedule") ?? "Assigned to this schedule")}</small><strong>${String(policies.length)} ${String(policies.length === 1 ? 'assignment' : 'assignments')}</strong></span><div class="pycfg-panel-head-actions"><button class="pycfg-btn" type="button" data-add-assignment ${String(state.addingAssignment || schedule.status === 'archived' ? 'disabled' : '')}><i class="fas fa-user-plus"></i>${(globalThis.PlatformLanguage?.text("settings","m_8803dece55359d"," Add") ?? " Add")}</button></div></header><div class="pycfg-assignments-body">${String(state.addingAssignment ? newAssignmentMarkup(schedule) : '')}${String(policies.length ? policies.map((policy) => assignmentRuleMarkup(subjectForPolicy(policy), policy)).join('') : (!state.addingAssignment ? '<div class="pycfg-assignment-empty"><i class="fas fa-users"></i><strong>No one is assigned yet</strong><span>Add the company default, a person, role, crew, or subcontractor to use this pay schedule.</span></div>' : ''))}</div>${String(state.directoryWarning ? `<div class="pycfg-directory-warning"><i class="fas fa-triangle-exclamation"></i> ${esc(state.directoryWarning)}</div>` : '')}</section>`;
    }

    function workspaceMarkup(){
      if (state.addingSchedule) return `<div class="pycfg-workspace">${String(scheduleEditorMarkup({}, true))}<section class="pycfg-panel"><div class="pycfg-assignment-empty"><i class="fas fa-user-plus"></i><strong>${(globalThis.PlatformLanguage?.text("settings","m_9e655b4d61d736","Create the schedule first") ?? "Create the schedule first")}</strong><span>${(globalThis.PlatformLanguage?.text("settings","m_80f9c4047bc4d9","Assignments can be added as soon as this pay schedule is saved.") ?? "Assignments can be added as soon as this pay schedule is saved.")}</span></div></section></div>`;
      const schedule = selectedSchedule();
      if (!schedule) return `<div class="pycfg-empty"><i class="fas fa-calendar-plus"></i>${(globalThis.PlatformLanguage?.text("settings","m_ff3ff2e43e60cd","Create your first pay schedule, then assign the company, people, roles, crews, or subcontractors that should use it.") ?? "Create your first pay schedule, then assign the company, people, roles, crews, or subcontractors that should use it.")}<div style="margin-top:12px"><button class="pycfg-btn primary" type="button" data-add-schedule><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("settings","m_759ca83743fa9e"," Create pay schedule") ?? " Create pay schedule")}</button></div></div>`;
      return `<div class="pycfg-workspace">${scheduleEditorMarkup(schedule)}${assignmentsPanelMarkup(schedule)}</div>`;
    }

    function headerMarkup(){
      return `<header class="pycfg-head"><div><h3>${(globalThis.PlatformLanguage?.text("settings","m_8c72678ac87916","Payroll setup") ?? "Payroll setup")}</h3><p>${(globalThis.PlatformLanguage?.text("settings","m_7566916532f7f0","Create each pay schedule, then choose exactly who and which earnings should use it.") ?? "Create each pay schedule, then choose exactly who and which earnings should use it.")}</p></div><div class="pycfg-head-actions">${String(onBack ? '<button class="pycfg-btn" type="button" data-payroll-settings-back><i class="fas fa-arrow-left"></i> Back to payroll</button>' : '')}<button class="pycfg-btn" type="button" data-refresh ${String(state.loading ? 'disabled' : '')}><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.text("settings","m_4f524800833039"," Refresh") ?? " Refresh")}</button></div></header>`;
    }

    function render(){
      if (destroyed) return;
      if (!orgId) {
        host.innerHTML = `<div class="pycfg">${String(headerMarkup())}<div class="pycfg-empty"><i class="fas fa-building-circle-exclamation"></i>${(globalThis.PlatformLanguage?.text("settings","m_662d9ef90761e2","An organization is required to configure payroll.") ?? "An organization is required to configure payroll.")}</div></div>`;
        bind();
        return;
      }
      if (state.loading) {
        host.innerHTML = `<div class="pycfg">${String(headerMarkup())}<div class="pycfg-loading"><i class="fas fa-spinner fa-spin"></i>${(globalThis.PlatformLanguage?.text("settings","m_27a9f695941148"," Loading payroll configuration...") ?? " Loading payroll configuration...")}</div></div>`;
        bind();
        return;
      }
      if (state.error) {
        host.innerHTML = `<div class="pycfg">${String(headerMarkup())}<div class="pycfg-empty"><i class="fas fa-triangle-exclamation"></i>${String(esc(state.error))}<div style="margin-top:12px"><button class="pycfg-btn" type="button" data-retry><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.text("settings","m_cbfbb44ff35f0f"," Try again") ?? " Try again")}</button></div></div></div>`;
        bind();
        host.querySelector('[data-retry]')?.addEventListener('click', () => load(true));
        return;
      }
      ensureSelectedSchedule();
      host.innerHTML = `<div class="pycfg">${headerMarkup()}${scheduleBarMarkup()}${state.notice ? `<div class="pycfg-notice ${state.noticeTone === 'bad' ? 'bad' : ''}">${esc(state.notice)}</div>` : ''}<main>${workspaceMarkup()}</main></div>`;
      bind();
    }

    function formBusy(form, busy, message = '', bad = false){
      form.querySelectorAll('input,select,button').forEach((control) => {
        if (busy) {
          control.dataset.pycfgWasDisabled = control.disabled ? '1' : '0';
          control.disabled = true;
        } else if (Object.prototype.hasOwnProperty.call(control.dataset, 'pycfgWasDisabled')) {
          control.disabled = control.dataset.pycfgWasDisabled === '1';
          delete control.dataset.pycfgWasDisabled;
        }
      });
      const status = form.querySelector('[data-form-status],[data-policy-status]');
      if (status) {
        status.textContent = message;
        status.classList.toggle('bad', bad);
      }
    }

    function routePatch(scheduleId){
      return { tab:routeTab, ...(routeTab === 'company_settings' ? { sub:'payroll' } : { payrollView:'settings' }), settingsView:null, settingsEntity:text(scheduleId) || null };
    }

    function syncSelectedRoute(history = 'replace'){
      if (root.Portal?.navigation?.applying) return;
      root.Portal?.navigation?.[history]?.(routePatch(state.selectedScheduleId), { source:'payroll-schedule-selection', ownedKeys:['settingsEntity'] });
    }

    async function refreshPayrollData(message = '', preferredScheduleId = ''){
      const [scheduleResult, policyResult] = await Promise.all([client.listSchedules({ includeArchived:true }), client.listPolicies()]);
      state.schedules = rows(scheduleResult, 'schedules').map((item) => ({ ...object(item) }));
      state.policies = rows(policyResult, 'policies').map((item) => ({ ...object(item), earning_kind:text(item?.earning_kind, '*') }));
      ensureSelectedSchedule(preferredScheduleId);
      setNotice(message);
      render();
    }

    async function saveSchedule(form, scheduleId){
      const existing = state.schedules.find((schedule) => schedule.id === scheduleId) || {};
      try {
        const payload = schedulePayload(form, existing);
        formBusy(form, true, scheduleId === '__new__' ? 'Creating schedule...' : 'Saving schedule...');
        let savedScheduleId = scheduleId;
        if (scheduleId === '__new__') {
          const result = await client.createSchedule(payload);
          savedScheduleId = text(result?.schedule?.id, result?.id);
        } else await client.updateSchedule(scheduleId, payload);
        state.addingSchedule = false;
        await refreshPayrollData(scheduleId === '__new__' ? 'Pay schedule created. Add the people or groups who should use it.' : 'Pay schedule updated.', savedScheduleId || scheduleId);
        syncSelectedRoute('replace');
        toast((globalThis.PlatformLanguage?.text("settings","m_4bb4688766e904","Saved") ?? "Saved"), scheduleId === '__new__' ? 'Pay schedule created.' : 'Pay schedule updated.', true);
      } catch(error) {
        formBusy(form, false, error?.message || 'Could not save this schedule.', true);
      }
    }

    async function archiveSchedule(form, scheduleId){
      const schedule = state.schedules.find((item) => item.id === scheduleId);
      if (!schedule) return;
      if (!root.confirm(((v0) => globalThis.PlatformLanguage?.text("settings","m_abc4218ecdab35",`Archive ${v0}? Existing payroll history will remain available.`,{v0}) ?? `Archive ${v0}? Existing payroll history will remain available.`)(schedule.name))) return;
      try {
        formBusy(form, true, 'Archiving schedule...');
        await client.archiveSchedule(scheduleId, Number(schedule.revision || 0));
        const nextScheduleId = text(sortedSchedules().find((item) => item.id !== scheduleId && item.status !== 'archived')?.id, sortedSchedules().find((item) => item.id !== scheduleId)?.id);
        await refreshPayrollData('Pay schedule archived.', nextScheduleId);
        syncSelectedRoute('replace');
        toast((globalThis.PlatformLanguage?.text("settings","m_26b28a86126a93","Archived") ?? "Archived"), (globalThis.PlatformLanguage?.text("settings","m_d52d5fc1df6aa4","Pay schedule archived.") ?? "Pay schedule archived."), true);
      } catch(error) {
        formBusy(form, false, error?.message || 'Could not archive this schedule.', true);
      }
    }

    async function savePolicy(form){
      const isNew = form.hasAttribute('data-new-policy');
      const selectedSubjectKey = text(form.querySelector('[data-new-policy-subject]')?.value);
      const separator = selectedSubjectKey.indexOf(':');
      const subjectType = isNew ? selectedSubjectKey.slice(0, separator) : text(form.dataset.subjectType);
      const subjectId = isNew ? selectedSubjectKey.slice(separator + 1) : text(form.dataset.subjectId);
      const originalKind = text(form.dataset.policyKind, '*');
      const earningKind = text(form.querySelector('[data-policy-earning]')?.value, originalKind);
      const scheduleId = text(form.dataset.scheduleId, state.selectedScheduleId);
      if (!subjectType || !subjectId || !scheduleId) {
        formBusy(form, false, 'Choose who should use this schedule.', true);
        return;
      }
      const timingBasis = text(form.querySelector('[data-policy-timing]')?.value);
      const capValue = text(form.querySelector('[data-policy-clawback]')?.value);
      const revision = Number(form.dataset.policyRevision || 0);
      const payload = {
        schedule_id:scheduleId,
        earning_kind:earningKind,
        ...(timingBasis ? { timing_basis:timingBasis } : {}),
        ...(capValue !== '' ? { clawback_cap_percent:clampNumber(capValue, 0, 100, 100) } : {}),
        ...(revision > 0 ? { expected_revision:revision } : {})
      };
      try {
        formBusy(form, true, 'Saving assignment rule...');
        await client.savePolicy(subjectType, subjectId, payload);
        state.addingAssignment = false;
        await refreshPayrollData(isNew ? 'Assignment added.' : 'Assignment updated.', scheduleId);
        toast((globalThis.PlatformLanguage?.text("settings","m_4bb4688766e904","Saved") ?? "Saved"), isNew ? 'Assignment added to this pay schedule.' : 'Assignment updated.', true);
      } catch(error) {
        formBusy(form, false, error?.message || 'Could not save this assignment rule.', true);
      }
    }

    async function deletePolicy(form){
      const subjectType = text(form.dataset.subjectType);
      const subjectId = text(form.dataset.subjectId);
      const earningKind = text(form.dataset.policyKind, '*');
      if (!root.confirm(((v0) => globalThis.PlatformLanguage?.text("settings","m_0cab5b84039beb",`Remove the ${v0} payroll rule? This subject will inherit its next available default.`,{v0}) ?? `Remove the ${v0} payroll rule? This subject will inherit its next available default.`)(earningKindLabel(earningKind).toLowerCase()))) return;
      try {
        formBusy(form, true, 'Removing rule...');
        await client.deletePolicy(subjectType, subjectId, earningKind);
        await refreshPayrollData('Payroll assignment rule removed.');
        toast((globalThis.PlatformLanguage?.text("settings","m_ab76f11570a1be","Removed") ?? "Removed"), (globalThis.PlatformLanguage?.text("settings","m_2ecb390fdb9725","Payroll assignment rule removed.") ?? "Payroll assignment rule removed."), true);
      } catch(error) {
        formBusy(form, false, error?.message || 'Could not remove this assignment rule.', true);
      }
    }

    function bind(){
      host.querySelector('[data-payroll-settings-back]')?.addEventListener('click', onBack);
      host.querySelector('[data-refresh]')?.addEventListener('click', () => load(true));
      host.querySelectorAll('[data-select-schedule]').forEach((button) => button.addEventListener('click', () => {
        state.selectedScheduleId = text(button.dataset.selectSchedule);
        state.addingSchedule = false;
        state.addingAssignment = false;
        setNotice('');
        syncSelectedRoute('push');
        render();
      }));
      host.querySelectorAll('[data-add-schedule]').forEach((button) => button.addEventListener('click', () => { state.addingSchedule = true; state.addingAssignment = false; setNotice(''); render(); }));
      host.querySelector('[data-cancel-new]')?.addEventListener('click', () => { state.addingSchedule = false; render(); });
      host.querySelectorAll('[data-schedule-form]').forEach((form) => {
        const scheduleId = text(form.dataset.scheduleId);
        form.querySelector('[data-schedule-frequency]')?.addEventListener('change', (event) => {
          const target = form.querySelector('[data-recurrence-fields]');
          if (target) target.innerHTML = recurrenceFieldsMarkup(event.currentTarget.value, {});
        });
        form.addEventListener('submit', (event) => { event.preventDefault(); saveSchedule(form, scheduleId); });
        form.querySelector('[data-archive-schedule]')?.addEventListener('click', () => archiveSchedule(form, scheduleId));
      });
      host.querySelector('[data-add-assignment]')?.addEventListener('click', () => { state.addingAssignment = true; state.assignmentQuery = ''; state.assignmentType = 'all'; setNotice(''); render(); });
      host.querySelectorAll('[data-cancel-policy]').forEach((button) => button.addEventListener('click', () => { state.addingAssignment = false; state.assignmentQuery = ''; render(); }));
      const newPolicyForm = host.querySelector('[data-new-policy]');
      newPolicyForm?.querySelectorAll('[data-select-subject]').forEach((button) => button.addEventListener('click', () => { state.newAssignmentSubjectKey = text(button.dataset.selectSubject); render(); }));
      newPolicyForm?.querySelectorAll('[data-assignment-type]').forEach((button) => button.addEventListener('click', () => {
        state.assignmentType = text(button.dataset.assignmentType, 'all');
        const nextSubject = state.subjects.find((subject) => (state.assignmentType === 'all' || subject.type === state.assignmentType) && usedKindsForSubject(subject).size < EARNING_KINDS.length);
        if (nextSubject) state.newAssignmentSubjectKey = subjectKey(nextSubject.type, nextSubject.id);
        render();
      }));
      newPolicyForm?.querySelector('[data-assignment-search]')?.addEventListener('input', (event) => {
        state.assignmentQuery = event.currentTarget.value;
        clearTimeout(bind.assignmentSearchTimer);
        bind.assignmentSearchTimer = setTimeout(() => {
          render();
          const input = host.querySelector('[data-assignment-search]');
          input?.focus();
          input?.setSelectionRange?.(input.value.length, input.value.length);
        }, 120);
      });
      newPolicyForm?.addEventListener('submit', (event) => { event.preventDefault(); savePolicy(newPolicyForm); });
      host.querySelectorAll('[data-policy-form]').forEach((form) => {
        form.addEventListener('submit', (event) => { event.preventDefault(); savePolicy(form); });
        form.querySelector('[data-delete-policy]')?.addEventListener('click', () => deletePolicy(form));
      });
    }

    async function loadDirectory(){
      const platform = root.PlatformAPI;
      const subjects = [{ type:'organization', id:orgId, label:(globalThis.PlatformLanguage?.text("settings","m_4072ee4e7867cd","Company default") ?? "Company default"), subtitle:(globalThis.PlatformLanguage?.text("settings","m_1b29e22b1e5092","Fallback for every payee and earning type") ?? "Fallback for every payee and earning type") }];
      if (!platform?.workforce) return { subjects, warning:'Workforce directories are unavailable. Company-default policies can still be managed.' };
      const [accessResult, usersResult, groupsResult, connectionsResult] = await Promise.allSettled([
        platform.workforce.accessCatalog?.(orgId),
        platform.workforce.users?.(orgId, branchId, { includeDisabled:false }),
        platform.workforce.resourceGroups?.(orgId, branchId, { includeArchived:false }),
        platform.connections?.list?.(orgId, { branchId, includeArchived:false })
      ]);
      if (accessResult.status === 'fulfilled') {
        rows(accessResult.value, 'roles', 'access_roles').filter((role) => role.status !== 'archived').forEach((role) => subjects.push({ type:'access_role', id:text(role.id, role.role_id), label:text(role.name, role.id), subtitle:`Access role · ${array(role.application_ids).join(' + ') || text(role.application_id, 'workforce')}` }));
      }
      if (usersResult.status === 'fulfilled') {
        rows(usersResult.value, 'users', 'profiles', 'workforce_users').filter((user) => !['disabled','deleted'].includes(text(user.status).toLowerCase())).forEach((user) => subjects.push({ type:'organization_user', id:text(user.id, user.user_id), label:text(user.name, user.email, user.id), subtitle:text(user.email, 'Organization user') }));
      }
      if (groupsResult.status === 'fulfilled') {
        rows(groupsResult.value, 'resource_groups', 'groups').filter((group) => group.status !== 'archived').forEach((group) => subjects.push({ type:'resource_group', id:text(group.id), label:text(group.name, group.id), subtitle:((v0,v1) => globalThis.PlatformLanguage?.text("settings","m_9372c96aec8f22",`Crew · ${v0} member${v1}`,{v0,v1}) ?? `Crew · ${v0} member${v1}`)(array(group.members).length,array(group.members).length === 1 ? '' : 's') }));
      }
      if (connectionsResult.status === 'fulfilled') {
        rows(connectionsResult.value, 'organization_connections', 'connections').filter((connection) => connection.status !== 'archived').forEach((connection) => subjects.push({ type:'organization_connection', id:text(connection.id), label:text(connection.name, connection.legal_name, connection.id), subtitle:text(connection.legal_name, 'Subcontractor organization') }));
      }
      const failures = [accessResult, usersResult, groupsResult, connectionsResult].filter((result) => result.status === 'rejected').length;
      return { subjects:subjects.filter((subject) => subject.id), warning:failures ? `${failures} workforce ${failures === 1 ? 'directory' : 'directories'} could not be loaded. Existing policy data remains unchanged.` : '' };
    }

    async function load(force = false){
      if (destroyed) return;
      if (!force && !state.loading && state.schedules.length) return;
      state.loading = true;
      state.error = '';
      render();
      try {
        const [scheduleResult, policyResult, directory] = await Promise.all([
          client.listSchedules({ includeArchived:true }),
          client.listPolicies(),
          loadDirectory()
        ]);
        if (destroyed) return;
        state.schedules = rows(scheduleResult, 'schedules').map((item) => ({ ...object(item) }));
        state.policies = rows(policyResult, 'policies').map((item) => ({ ...object(item), earning_kind:text(item?.earning_kind, '*') }));
        state.subjects = directory.subjects;
        state.directoryWarning = directory.warning;
        ensureSelectedSchedule();
        state.loading = false;
        setNotice(force ? 'Payroll configuration refreshed.' : '');
        render();
      } catch(error) {
        if (destroyed) return;
        state.loading = false;
        state.error = error?.message || 'Could not load payroll configuration.';
        render();
      }
    }

    unregisterRoute = root.Portal?.navigation?.registerHandler?.(routeHandlerId, {
      priority:450,
      apply:(route) => {
        const active = routeTab === 'company_settings'
          ? route.tab === 'company_settings' && route.sub === 'payroll'
          : route.tab === routeTab && route.payrollView === 'settings';
        if (!active) return;
        const nextScheduleId = text(route.settingsEntity);
        if (nextScheduleId !== state.selectedScheduleId) {
          state.selectedScheduleId = nextScheduleId;
          state.addingSchedule = false;
          state.addingAssignment = false;
          ensureSelectedSchedule();
          setNotice('');
          render();
        }
      }
    });
    load();
    return controller;
  }

  root.FirstMatePayrollSettings = { mount };
})(window);
