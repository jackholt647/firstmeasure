(function(root){
  'use strict';
  function readPlatformCsrfToken(){
    const sessionName = String(window.__APP?.platformSessionCookieName || 'fm_platform_session').trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionName)) return '';
    const prefix = sessionName + '_csrf=';
    const value = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
    try { return value ? decodeURIComponent(value.slice(prefix.length)) : ''; }
    catch { return ''; }
  }

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
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const CADENCE_UNITS = [['day', 'day', 'days'], ['week', 'week', 'weeks'], ['month', 'month', 'months'], ['quarter', 'quarter', 'quarters'], ['year', 'year', 'years']];
  const CADENCE_KEYS = ['frequency', 'interval', 'weekday', 'weekdays', 'day', 'days', 'nth_weekdays', 'months', 'adjust', 'anchor_date'];
  const CADENCE_PRESETS = [['weekly', 'Weekly'], ['biweekly', 'Every two weeks'], ['twice_monthly', 'Twice a month'], ['monthly', 'Monthly']];
  const WEEKEND_ADJUSTMENTS = [['none', 'Pay on that day anyway'], ['previous_weekday', 'Pay the Friday before'], ['next_weekday', 'Pay the Monday after']];
  const POSITION_CHOICES = [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [5, '5th'], [-1, 'Last'], [-2, '2nd to last'], [-3, '3rd to last'], [-4, '4th to last'], [-5, '5th to last']];
  // What happens to a change in an earning after part of it has been in a pay run (schedule metadata.correction_policy).
  const CORRECTION_CHOICES = {
    increase:[['next_run', 'Pay it on the next run'], ['off_cycle', 'Ask for an off-cycle run'], ['hold', 'Hold it for review']],
    decrease:[['hold', 'Hold it for review'], ['next_run', 'Take it back on the next run'], ['off_cycle', 'Ask for an off-cycle run']]
  };
  const CORRECTION_DEFAULTS = { increase:'next_run', decrease:'hold' };
  const PAY_RULE_KINDS = [['hourly', 'Hourly'], ['salary', 'Salary'], ['piece_rate', 'Piece rate'], ['commission', 'Commission'], ['reimbursement', 'Reimbursement'], ['adjustment', 'Adjustment']];
  const PAY_PERIODS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']];
  // The shared condition operators (work/conditions.ts): id, label, and the kind of value each takes.
  const CONDITION_OPERATORS = [
    ['equals', 'is', 'one'], ['not_equals', 'is not', 'one'], ['in', 'is any of', 'list'], ['not_in', 'is none of', 'list'],
    ['contains', 'contains', 'one'], ['not_contains', 'does not contain', 'one'], ['starts_with', 'starts with', 'one'], ['ends_with', 'ends with', 'one'],
    ['is_present', 'has a value', 'none'], ['is_missing', 'is empty', 'none'],
    ['greater_than', 'is greater than', 'number'], ['greater_or_equal', 'is at least', 'number'], ['less_than', 'is less than', 'number'], ['less_or_equal', 'is at most', 'number'],
    ['before', 'is before', 'time'], ['after', 'is after', 'time']
  ];
  const PAY_SOURCE_HINTS = ['time_shifts', 'project_records', 'labor_commitments'];
  let mountSequence = 0;

  const esc =(value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
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
  const localToday = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  };
  function parseDay(value){
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value).slice(0, 10));
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const dayKey = (date) => date.toISOString().slice(0, 10);
  const addDays = (date, days) => {
    const next = new Date(date.getTime());
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  };
  function formatDay(value, options){
    const date = parseDay(value);
    if (!date) return text(value);
    try {
      return new Intl.DateTimeFormat(globalThis.PlatformLanguage?.formatLocale?.() || undefined, { timeZone:'UTC', ...(options || { month:'short', day:'numeric', year:'numeric' }) }).format(date);
    } catch(e) { return text(value); }
  }
  const ordinal = (value) => {
    const number = Math.abs(Math.trunc(Number(value) || 0));
    const tail = number % 100;
    return `${number}${tail >= 11 && tail <= 13 ? 'th' : ({ 1:'st', 2:'nd', 3:'rd' })[number % 10] || 'th'}`;
  };
  const joinList = (items) => items.length <= 1 ? text(items[0]) : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  const uniqueNumbers = (value, min, max) => [...new Set(array(value).map((entry) => Math.trunc(Number(entry))).filter((entry) => Number.isFinite(entry) && entry >= min && entry <= max))];
  const monthDayOrder = (day) => day > 0 ? day : 100 + day;
  const monthDayLabel = (day) => day > 0 ? `the ${ordinal(day)}` : day === -1 ? 'the last day' : `the ${ordinal(day)} to last day`;
  const positionLabel = (position) => `the ${position.nth > 0 ? ordinal(position.nth) : position.nth === -1 ? 'last' : `${ordinal(position.nth)} to last`} ${WEEKDAYS[position.weekday] || 'day'}`;
  const optionsMarkup = (entries, selected) => entries.map(([value, label]) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`).join('');
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
    const csrf = readPlatformCsrfToken();
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
      .pycfg-cadence{grid-column:1/-1;border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:11px;display:grid;gap:11px;min-width:0}.pycfg-cadence-group{display:grid;gap:6px;min-width:0}.pycfg-cadence-group>span:first-child,.pycfg-cadence-preview>span{color:#475467;font-size:9.5px;font-weight:1000;text-transform:uppercase;letter-spacing:.035em}.pycfg-chips{display:flex;flex-wrap:wrap;gap:5px}.pycfg-chip{appearance:none;min-height:30px;min-width:34px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#475467;padding:6px 9px;font:900 10.5px/1 inherit;cursor:pointer}.pycfg-chip:hover:not(:disabled){background:#f9fafb}.pycfg-chip.active{border-color:#84adff;background:#eff4ff;color:#3538cd}.pycfg-chip:disabled{opacity:.55;cursor:default}.pycfg-chips.days .pycfg-chip{width:34px;padding:6px 0}.pycfg-chips.days .pycfg-chip.text{width:auto;padding:6px 9px}.pycfg-cadence-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;color:#344054;font-size:11px;font-weight:850}.pycfg-cadence-row .pycfg-input,.pycfg-cadence-row .pycfg-select{width:auto;min-width:0}.pycfg-cadence-row .pycfg-input[type=number]{width:72px}.pycfg-cadence-summary{border:1px solid #b2ddff;border-radius:9px;background:#f5faff;color:#175cd3;padding:9px 11px;font-size:11.5px;font-weight:900;line-height:1.45}.pycfg-cadence-summary.bad{border-color:#fecdca;background:#fef3f2;color:#b42318}.pycfg-cadence-preview{display:grid;gap:6px}.pycfg-cadence-preview ol{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:5px}.pycfg-cadence-preview li{border:1px solid #e4e7ec;border-radius:999px;background:#f9fafb;color:#344054;padding:5px 9px;font-size:10px;font-weight:900}
      .pycfg-stack{display:grid;gap:12px}.pycfg-section{display:grid;gap:10px;margin-bottom:22px}.pycfg-textarea{width:100%;min-height:64px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#101828;padding:8px 9px;font:800 11.5px/1.45 inherit;outline:none;resize:vertical}.pycfg-textarea:focus{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.07)}.pycfg-textarea.code{min-height:230px;font:500 12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:2;white-space:pre;overflow:auto}.pycfg-textarea.json{min-height:90px;font:500 11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre}.pycfg-pre{margin:0;border:1px solid #1d2939;border-radius:9px;background:#101828;color:#f2f4f7;padding:11px;font:500 11px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:auto;max-height:340px;white-space:pre;tab-size:2}.pycfg-dl{display:grid;grid-template-columns:150px minmax(0,1fr);gap:8px 12px;margin:0;font-size:11px}.pycfg-dl dt{color:#475467;font-size:9.5px;font-weight:1000;text-transform:uppercase;letter-spacing:.035em;padding-top:2px}.pycfg-dl dd{margin:0;color:#182230;font-weight:750;line-height:1.5;min-width:0;overflow-wrap:anywhere}.pycfg-dl dd>div+div{margin-top:5px}.pycfg-dl code,.pycfg-help code{font:600 10.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f2f4f7;border-radius:4px;padding:1px 4px;color:#344054}.pycfg-block{border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:11px;display:grid;gap:10px;min-width:0}.pycfg-block.nested{background:#fcfcfd}.pycfg-block-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.pycfg-block-head strong{font-size:11.5px}.pycfg-block-head small{display:block;color:#667085;font-size:9.5px;font-weight:750;margin-top:2px}.pycfg-rowgrid{display:grid;gap:7px;align-items:end}.pycfg-rowgrid.cond{grid-template-columns:minmax(0,1.2fr) minmax(0,.9fr) minmax(0,1.2fr) 30px}.pycfg-rowgrid.kv{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 30px}.pycfg-rowgrid.param{grid-template-columns:minmax(0,.9fr) minmax(0,1.5fr) 110px minmax(0,.8fr) 30px}.pycfg-rowgrid .pycfg-icon-btn{align-self:end;height:38px}.pycfg-warn{color:#93370d;background:#fffaeb;border:1px solid #fedf89;border-radius:9px;padding:9px 11px;font-size:10.5px;font-weight:800;line-height:1.5}.pycfg-plan-rule{border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:10px;display:grid;gap:10px}.pycfg-plan-rule.on{border-color:#b2ddff;background:#f5faff}.pycfg-check{display:flex;align-items:flex-start;gap:9px;cursor:pointer;font-size:11px;font-weight:850;color:#344054}.pycfg-check input{margin:2px 0 0}.pycfg-check strong{display:block;font-size:11.5px;color:#182230}.pycfg-check small{display:block;color:#667085;font-size:10px;font-weight:750;margin-top:2px}.pycfg-card-detail{display:grid;gap:12px}.pycfg-card-detail .pycfg-actions{margin-top:0}
      @media(max-width:660px){.pycfg-grid>[style*="span 2"]{grid-column:auto!important}.pycfg-rowgrid.cond,.pycfg-rowgrid.kv,.pycfg-rowgrid.param{grid-template-columns:1fr}.pycfg-dl{grid-template-columns:1fr}.pycfg-card>summary{grid-template-columns:38px minmax(0,1fr)}.pycfg-card-meta{grid-column:1/-1;justify-content:flex-start}}
      @media(max-width:980px){.pycfg-workspace{grid-template-columns:1fr}.pycfg-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pycfg-assignments-body{max-height:none}.pycfg-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pycfg-rule{grid-template-columns:repeat(2,minmax(0,1fr))}.pycfg-rule-actions{align-self:end}}@media(max-width:660px){.pycfg-head,.pycfg-toolbar{align-items:stretch;flex-direction:column}.pycfg-head-actions{justify-content:flex-start}.pycfg-detail-grid,.pycfg-add-grid,.pycfg-assignment-fields,.pycfg-advanced-grid{grid-template-columns:1fr}.pycfg-assignment-fields{padding-left:0}.pycfg-add-grid .wide{grid-column:auto}.pycfg-schedule-choice{min-width:205px}.pycfg-panel-head{align-items:flex-start}.pycfg-panel-head-actions{flex-wrap:wrap;justify-content:flex-end}.pycfg-grid,.pycfg-grid.two,.pycfg-rule{grid-template-columns:1fr}.pycfg-search{min-width:100%}}
    `;
    document.head.appendChild(style);
  }

  // The pay days of a recurrence between two dates, both inclusive. Mirrors payrollPayDates in v1/payroll/schedule.ts; keep the two in step.
  function payDates(recurrenceValue, fromValue, throughValue){
    const from = parseDay(fromValue);
    const through = parseDay(throughValue);
    if (!from || !through || from > through) return [];
    const recurrence = object(recurrenceValue);
    const frequency = text(recurrence.frequency);
    const numbers = (value) => array(value).map((entry) => Math.trunc(Number(entry))).filter(Number.isFinite);
    const daysBetween = (left, right) => Math.round((right.getTime() - left.getTime()) / 86400000);
    const anchor = parseDay(recurrence.anchor_date);
    const months = new Set(numbers(recurrence.months));
    const interval = Math.max(1, Math.trunc(Number(recurrence.interval || 0)) || (frequency === 'biweekly' ? 2 : 1));
    const adjust = text(recurrence.adjust);
    const start = addDays(from, -3);
    const end = addDays(through, 3);
    const dates = new Set();
    const add = (date) => {
      if (months.size && !months.has(date.getUTCMonth() + 1)) return;
      const weekday = date.getUTCDay();
      const moved = weekday !== 0 && weekday !== 6 ? date
        : adjust === 'previous_weekday' ? addDays(date, weekday === 6 ? -1 : -2)
          : adjust === 'next_weekday' ? addDays(date, weekday === 6 ? 2 : 1) : date;
      if (moved >= from && moved <= through) dates.add(dayKey(moved));
    };
    if (frequency === 'daily') {
      for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
        if (interval === 1 || (anchor && ((daysBetween(anchor, cursor) % interval) + interval) % interval === 0)) add(cursor);
      }
    } else if (frequency === 'weekly' || frequency === 'biweekly') {
      const weekdays = new Set(numbers(recurrence.weekdays).length ? numbers(recurrence.weekdays) : [Math.max(0, Math.min(6, Math.floor(Number(recurrence.weekday || 0))))]);
      const weekOf = (date) => addDays(date, -date.getUTCDay());
      const anchorWeek = anchor ? weekOf(anchor) : null;
      for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
        if (!weekdays.has(cursor.getUTCDay())) continue;
        const weeks = anchorWeek ? Math.round(daysBetween(anchorWeek, weekOf(cursor)) / 7) : 0;
        if (interval === 1 || !anchorWeek || ((weeks % interval) + interval) % interval === 0) add(cursor);
      }
    } else {
      const step = interval * (frequency === 'quarterly' ? 3 : frequency === 'yearly' ? 12 : 1);
      const anchorMonth = anchor ? anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() : 0;
      const positions = array(recurrence.nth_weekdays).map((entry) => ({ nth:Math.trunc(Number(object(entry).nth)), weekday:Math.trunc(Number(object(entry).weekday)) }))
        .filter((entry) => entry.nth && entry.weekday >= 0 && entry.weekday <= 6);
      const listed = numbers(recurrence.days).length ? numbers(recurrence.days) : recurrence.day !== undefined ? [Math.trunc(Number(recurrence.day))] : [];
      const days = [...new Set(listed.length || positions.length ? listed : frequency === 'semi_monthly' ? [1, 15] : [1])].filter((day) => day !== 0);
      const monthCursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      const finalMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
      for (; monthCursor <= finalMonth; monthCursor.setUTCMonth(monthCursor.getUTCMonth() + 1)) {
        const year = monthCursor.getUTCFullYear();
        const month = monthCursor.getUTCMonth();
        if (frequency === 'yearly') {
          const years = year - (anchor ? anchor.getUTCFullYear() : 0);
          if (((years % interval) + interval) % interval !== 0 || (!months.size && month !== (anchor ? anchor.getUTCMonth() : 0))) continue;
        } else {
          const index = year * 12 + month - anchorMonth;
          if (step > 1 && ((index % step) + step) % step !== 0) continue;
        }
        const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        for (const day of days) add(new Date(Date.UTC(year, month, Math.max(1, Math.min(last, Math.floor(day > 0 ? day : last + 1 + day))))));
        for (const position of positions) {
          const matches = Array.from({ length:last }, (_value, offset) => new Date(Date.UTC(year, month, offset + 1))).filter((date) => date.getUTCDay() === position.weekday);
          const chosen = position.nth > 0 ? matches[position.nth - 1] : matches[matches.length + position.nth];
          if (chosen) add(chosen);
        }
      }
    }
    return [...dates].sort();
  }

  function nextPayDates(recurrence, fromValue, count){
    const from = parseDay(fromValue);
    if (!from) return [];
    let found = [];
    for (const horizon of [120, 800, 4000, 20000]) {
      found = payDates(recurrence, dayKey(from), dayKey(addDays(from, horizon)));
      if (found.length >= count) break;
    }
    return found.slice(0, count);
  }

  // The editor's working copy of a recurrence: one repeating unit and interval, and the pay days picked within it.
  function cadenceFromRecurrence(value){
    const recurrence = object(value);
    const frequency = text(recurrence.frequency, 'weekly');
    const unit = frequency === 'daily' ? 'day' : frequency === 'quarterly' ? 'quarter' : frequency === 'yearly' ? 'year' : (frequency === 'weekly' || frequency === 'biweekly') ? 'week' : 'month';
    const monthBased = unit === 'month' || unit === 'quarter' || unit === 'year';
    const weekdays = uniqueNumbers(recurrence.weekdays, 0, 6);
    const positions = array(recurrence.nth_weekdays).map((entry) => ({ nth:Math.trunc(Number(object(entry).nth)), weekday:Math.trunc(Number(object(entry).weekday)) }))
      .filter((entry) => entry.nth && entry.nth >= -5 && entry.nth <= 5 && entry.weekday >= 0 && entry.weekday <= 6);
    const listed = uniqueNumbers(array(recurrence.days).length ? recurrence.days : recurrence.day === undefined ? [] : [recurrence.day], -31, 31).filter((day) => day !== 0);
    const extras = { ...recurrence };
    CADENCE_KEYS.forEach((key) => { delete extras[key]; });
    return {
      unit,
      interval:Math.round(clampNumber(recurrence.interval || (frequency === 'biweekly' ? 2 : 1), 1, 52, 1)),
      weekdays:weekdays.length ? weekdays : [Math.round(clampNumber(recurrence.weekday ?? 5, 0, 6, 5))],
      days:listed.length || positions.length || !monthBased ? listed : frequency === 'semi_monthly' ? [1, 15] : [1],
      positions,
      months:uniqueNumbers(recurrence.months, 1, 12),
      adjust:WEEKEND_ADJUSTMENTS.some(([id]) => id === recurrence.adjust) ? recurrence.adjust : 'none',
      anchor:parseDay(recurrence.anchor_date) ? text(recurrence.anchor_date).slice(0, 10) : '',
      extras
    };
  }

  // The recurrence the API stores for a working copy. Throws a sentence the form can show when something is missing.
  function recurrenceFromCadence(cadence){
    const interval = Math.round(clampNumber(cadence.interval, 1, 52, 1));
    const recurrence = { ...object(cadence.extras) };
    const months = [...new Set(cadence.months)].sort((left, right) => left - right);
    if (cadence.unit === 'day') {
      recurrence.frequency = 'daily';
      if (interval > 1) recurrence.interval = interval;
    } else if (cadence.unit === 'week') {
      const weekdays = [...new Set(cadence.weekdays)].sort((left, right) => left - right);
      if (!weekdays.length) throw new Error('Choose at least one weekday to pay on.');
      // Every two weeks keeps its own name, which already means an interval of two.
      recurrence.frequency = interval === 2 ? 'biweekly' : 'weekly';
      if (weekdays.length === 1) recurrence.weekday = weekdays[0];
      else recurrence.weekdays = weekdays;
      if (interval > 2) recurrence.interval = interval;
    } else {
      const days = [...new Set(cadence.days)].sort((left, right) => monthDayOrder(left) - monthDayOrder(right));
      const positions = cadence.positions.filter((position, index, all) => all.findIndex((other) => other.nth === position.nth && other.weekday === position.weekday) === index);
      if (!days.length && !positions.length) throw new Error('Choose a day of the month, or a position such as the 3rd Thursday.');
      if (cadence.unit === 'year' && !months.length) throw new Error('Choose the month a yearly schedule pays in.');
      const twiceMonthly = cadence.unit === 'month' && interval === 1 && days.length === 2 && !positions.length;
      recurrence.frequency = cadence.unit === 'quarter' ? 'quarterly' : cadence.unit === 'year' ? 'yearly' : twiceMonthly ? 'semi_monthly' : 'monthly';
      if (days.length === 1 && !positions.length) recurrence.day = days[0];
      else if (days.length) recurrence.days = days;
      if (positions.length) recurrence.nth_weekdays = positions.map((position) => ({ nth:position.nth, weekday:position.weekday }));
      if (interval > 1) recurrence.interval = interval;
    }
    if (months.length && (months.length < 12 || cadence.unit === 'year')) recurrence.months = months;
    if (cadence.adjust && cadence.adjust !== 'none') recurrence.adjust = cadence.adjust;
    if (interval > 1) {
      if (!parseDay(cadence.anchor)) throw new Error('Choose the date to count from.');
      recurrence.anchor_date = cadence.anchor;
    } else if (cadence.unit === 'quarter' && parseDay(cadence.anchor)) {
      // With no skipped quarters the anchor only says which months the quarters fall on.
      recurrence.anchor_date = cadence.anchor;
    }
    return recurrence;
  }

  function cadencePreset(cadence){
    if (cadence.months.length) return '';
    if (cadence.unit === 'week') return cadence.interval === 1 ? 'weekly' : cadence.interval === 2 ? 'biweekly' : '';
    if (cadence.unit !== 'month' || cadence.interval !== 1) return '';
    return cadence.days.length === 2 && !cadence.positions.length ? 'twice_monthly' : 'monthly';
  }

  function quarterMonths(cadence){
    const first = (parseDay(cadence.anchor)?.getUTCMonth() || 0) % 3;
    return [0, 3, 6, 9].map((offset) => first + offset);
  }

  // A recurrence in plain language. `brief` leaves out the anchor and the weekend rule, for tight spaces.
  function recurrenceSummary(value, options = {}){
    if (!text(object(value).frequency)) return 'Payroll schedule';
    const cadence = cadenceFromRecurrence(value);
    const count = cadence.interval;
    const weekdays = joinList([...cadence.weekdays].sort((left, right) => left - right).map((day) => WEEKDAYS[day]));
    const picked = joinList([
      ...[...cadence.days].sort((left, right) => monthDayOrder(left) - monthDayOrder(right)).map(monthDayLabel),
      ...cadence.positions.map(positionLabel)
    ]) || 'the 1st';
    const monthNames = (list, short) => joinList([...list].sort((left, right) => left - right).map((month) => short ? MONTHS[month - 1].slice(0, 3) : MONTHS[month - 1]));
    let summary = '';
    if (cadence.unit === 'day') summary = count === 1 ? 'Every day' : `Every ${count} days`;
    else if (cadence.unit === 'week') summary = count === 1 ? `Weekly on ${weekdays}` : count === 2 ? (cadence.weekdays.length === 1 ? `Every other ${weekdays}` : `Every other week on ${weekdays}`) : `Every ${count} weeks on ${weekdays}`;
    else if (cadence.unit === 'month') summary = `${count === 1 ? 'Monthly' : `Every ${count} months`} on ${picked}`;
    else if (cadence.unit === 'quarter') summary = count === 1 ? `Quarterly on ${picked} (${monthNames(quarterMonths(cadence).map((month) => month + 1), true)})` : `Every ${count} quarters on ${picked}`;
    else summary = `${count === 1 ? 'Yearly' : `Every ${count} years`} in ${monthNames(cadence.months.length ? cadence.months : [(parseDay(cadence.anchor)?.getUTCMonth() || 0) + 1])} on ${picked}`;
    if (cadence.months.length && cadence.unit !== 'year') summary += `, only in ${monthNames(cadence.months, true)}`;
    if (options.brief) return summary;
    if (count > 1 && cadence.anchor) summary += `, counting from ${formatDay(cadence.anchor)}`;
    if (cadence.adjust === 'previous_weekday') summary += '. A pay day on a weekend moves to the Friday before';
    if (cadence.adjust === 'next_weekday') summary += '. A pay day on a weekend moves to the Monday after';
    return summary;
  }

  function frequencyLabel(schedule){
    return recurrenceSummary(schedule?.recurrence, { brief:true });
  }

  function correctionPolicy(schedule){
    const policy = object(object(schedule?.metadata).correction_policy);
    const pick = (direction) => CORRECTION_CHOICES[direction].some(([id]) => id === policy[direction]) ? policy[direction] : CORRECTION_DEFAULTS[direction];
    return { increase:pick('increase'), decrease:pick('decrease') };
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

  function cadenceOutcomeMarkup(cadence){
    let recurrence;
    try { recurrence = recurrenceFromCadence(cadence); }
    catch(error) { return `<div class="pycfg-cadence-summary bad" data-cadence-summary>${esc(error?.message || 'This pattern is not complete.')}</div>`; }
    const dates = nextPayDates(recurrence, localToday(), 6);
    return `<div class="pycfg-cadence-summary" data-cadence-summary>${esc(recurrenceSummary(recurrence))}.</div>
      <div class="pycfg-cadence-preview"><span>Next pay dates</span><ol data-cadence-preview>${dates.length ? dates.map((date) => `<li data-pay-date="${esc(date)}">${esc(formatDay(date, { weekday:'short', month:'short', day:'numeric', year:'numeric' }))}</li>`).join('') : '<li>This pattern has no pay dates coming up.</li>'}</ol></div>`;
  }

  // The controls for when a schedule pays. Every control edits the working copy held by the form and this is drawn again.
  function cadenceMarkup(cadence){
    const unit = cadence.unit;
    const monthBased = unit === 'month' || unit === 'quarter' || unit === 'year';
    const preset = cadencePreset(cadence);
    const chip = (attribute, value, label, active, extra = '') => `<button class="pycfg-chip ${active ? 'active' : ''} ${extra}" type="button" ${attribute}="${esc(value)}" aria-pressed="${active ? 'true' : 'false'}">${esc(label)}</button>`;
    const unitOptions = CADENCE_UNITS.map(([id, one, many]) => [id, cadence.interval > 1 ? many : one]);
    const anchorLabel = unit === 'week' ? 'counting from the week of' : unit === 'year' ? 'counting from the year of' : 'counting from';
    const endDays = cadence.days.filter((day) => day < -1).sort((left, right) => right - left);
    const quarterStart = (parseDay(cadence.anchor)?.getUTCMonth() || 0) % 3;
    const quarterChoices = [0, 1, 2].map((first) => [first, [0, 3, 6, 9].map((offset) => MONTHS[first + offset]).join(', ')]);
    return `
      <div class="pycfg-cadence-group"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_ff7bb68b2b05a8","Frequency") ?? "Frequency")}</span><div class="pycfg-chips">${CADENCE_PRESETS.map(([id, label]) => chip('data-cadence-preset', id, label, preset === id)).join('')}</div></div>
      <div class="pycfg-cadence-row"><span>Repeats every</span><input class="pycfg-input" type="number" min="1" max="52" step="1" data-cadence-interval value="${esc(cadence.interval)}" aria-label="How many"><select class="pycfg-select" data-cadence-unit aria-label="Unit">${optionsMarkup(unitOptions, unit)}</select>${cadence.interval > 1 ? `<span>${anchorLabel}</span><input class="pycfg-input" type="date" data-cadence-anchor value="${esc(cadence.anchor)}" aria-label="Date to count from" required>` : ''}</div>
      ${unit === 'week' ? `<div class="pycfg-cadence-group"><span>Pay on</span><div class="pycfg-chips">${WEEKDAYS.map((day, index) => chip('data-cadence-weekday', index, day.slice(0, 3), cadence.weekdays.includes(index))).join('')}</div></div>` : ''}
      ${monthBased ? `
        ${unit === 'quarter' && cadence.interval === 1 ? `<label class="pycfg-cadence-group"><span>Quarters fall on</span><select class="pycfg-select" data-cadence-quarter>${optionsMarkup(quarterChoices, quarterStart)}</select></label>` : ''}
        <div class="pycfg-cadence-group"><span>Days of the month</span><div class="pycfg-chips days">${Array.from({ length:31 }, (_value, index) => chip('data-cadence-day', index + 1, String(index + 1), cadence.days.includes(index + 1))).join('')}${chip('data-cadence-day', -1, 'Last day', cadence.days.includes(-1), 'text')}${endDays.map((day) => chip('data-cadence-day', day, `${-day - 1} before the last`, true, 'text')).join('')}</div>
          <div class="pycfg-cadence-row"><input class="pycfg-input" type="number" min="1" max="30" step="1" data-cadence-end-offset placeholder="2" aria-label="Days before the last day"><span>days before the last day</span><button class="pycfg-btn" type="button" data-cadence-add-end-day><i class="fas fa-plus"></i> Add</button></div>
          <small class="pycfg-help">A month that is too short for a day pays on its last day.</small></div>
        <div class="pycfg-cadence-group"><span>Or a position in the month</span>${cadence.positions.map((position, index) => `<div class="pycfg-cadence-row" data-cadence-position="${index}"><span>The</span><select class="pycfg-select" data-cadence-nth aria-label="Which one">${optionsMarkup(POSITION_CHOICES, position.nth)}</select><select class="pycfg-select" data-cadence-position-weekday aria-label="Weekday">${optionsMarkup(WEEKDAYS.map((day, weekday) => [weekday, day]), position.weekday)}</select><button class="pycfg-icon-btn danger" type="button" data-cadence-remove-position title="Remove" aria-label="Remove this position"><i class="fas fa-xmark"></i></button></div>`).join('')}
          <div class="pycfg-cadence-row"><button class="pycfg-btn" type="button" data-cadence-add-position ${cadence.positions.length >= 12 ? 'disabled' : ''}><i class="fas fa-plus"></i> ${cadence.positions.length ? 'Add another position' : 'Add a position, such as the 3rd Thursday'}</button></div></div>` : ''}
      <div class="pycfg-cadence-group"><span>${unit === 'year' ? 'In' : 'Only in these months'}</span><div class="pycfg-chips">${MONTHS.map((month, index) => chip('data-cadence-month', index + 1, month.slice(0, 3), cadence.months.includes(index + 1))).join('')}</div>${unit === 'year' ? '' : '<small class="pycfg-help">Leave every month unselected to pay all year.</small>'}</div>
      <label class="pycfg-cadence-group"><span>When a pay day lands on a weekend</span><select class="pycfg-select" data-cadence-adjust>${optionsMarkup(WEEKEND_ADJUSTMENTS, cadence.adjust)}</select></label>
      ${cadenceOutcomeMarkup(cadence)}`;
  }

  function applyCadencePreset(cadence, preset){
    cadence.months = [];
    cadence.interval = preset === 'biweekly' ? 2 : 1;
    if (preset === 'weekly' || preset === 'biweekly') {
      cadence.unit = 'week';
      if (!cadence.weekdays.length) cadence.weekdays = [5];
    } else {
      cadence.unit = 'month';
      cadence.positions = [];
      cadence.days = preset === 'twice_monthly' ? [1, 15] : [1];
    }
  }

  // An anchor is only asked for when periods are skipped; start it on the next pay day the pattern would have anyway.
  function ensureCadenceAnchor(cadence){
    if (cadence.interval <= 1 || parseDay(cadence.anchor)) return;
    let first = '';
    try { first = nextPayDates(recurrenceFromCadence({ ...cadence, interval:1, anchor:'' }), localToday(), 1)[0] || ''; } catch(e) {}
    cadence.anchor = first || localToday();
  }

  // Wires the cadence controls of one schedule form to its working copy.
  function bindCadence(form, schedule){
    const target = form.querySelector('[data-recurrence-fields]');
    if (!target) return;
    const cadence = cadenceFromRecurrence(object(schedule?.recurrence));
    form._pycfgCadence = cadence;
    const paint = (focus = '') => {
      target.innerHTML = cadenceMarkup(cadence);
      if (focus) target.querySelector(focus)?.focus();
    };
    const toggle = (list, value) => list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
    target.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button || !target.contains(button) || button.disabled) return;
      const data = button.dataset;
      if (data.cadencePreset) {
        applyCadencePreset(cadence, data.cadencePreset);
        ensureCadenceAnchor(cadence);
        paint(`[data-cadence-preset="${data.cadencePreset}"]`);
      } else if (data.cadenceWeekday !== undefined) {
        cadence.weekdays = toggle(cadence.weekdays, Number(data.cadenceWeekday));
        paint(`[data-cadence-weekday="${data.cadenceWeekday}"]`);
      } else if (data.cadenceDay !== undefined) {
        cadence.days = toggle(cadence.days, Number(data.cadenceDay));
        paint(`[data-cadence-day="${data.cadenceDay}"]`);
      } else if (data.cadenceMonth !== undefined) {
        cadence.months = toggle(cadence.months, Number(data.cadenceMonth));
        paint(`[data-cadence-month="${data.cadenceMonth}"]`);
      } else if (data.cadenceAddEndDay !== undefined) {
        const offset = Math.round(Number(target.querySelector('[data-cadence-end-offset]')?.value));
        if (offset >= 1 && offset <= 30 && !cadence.days.includes(-offset - 1)) cadence.days = [...cadence.days, -offset - 1];
        paint('[data-cadence-end-offset]');
      } else if (data.cadenceAddPosition !== undefined) {
        cadence.positions = [...cadence.positions, { nth:3, weekday:4 }];
        paint(`[data-cadence-position="${cadence.positions.length - 1}"] [data-cadence-nth]`);
      } else if (data.cadenceRemovePosition !== undefined) {
        const index = Number(button.closest('[data-cadence-position]')?.dataset.cadencePosition);
        cadence.positions = cadence.positions.filter((_position, position) => position !== index);
        paint('[data-cadence-add-position]');
      }
    });
    target.addEventListener('change', (event) => {
      const control = event.target;
      if (control.matches('[data-cadence-interval]')) {
        cadence.interval = Math.round(clampNumber(control.value, 1, 52, 1));
        ensureCadenceAnchor(cadence);
        paint('[data-cadence-interval]');
      } else if (control.matches('[data-cadence-unit]')) {
        const before = cadence.unit;
        cadence.unit = CADENCE_UNITS.some(([id]) => id === control.value) ? control.value : 'week';
        const monthBased = cadence.unit === 'month' || cadence.unit === 'quarter' || cadence.unit === 'year';
        if (cadence.unit === 'week' && !cadence.weekdays.length) cadence.weekdays = [5];
        if (monthBased && !cadence.days.length && !cadence.positions.length) cadence.days = [1];
        if (before === 'year' && cadence.unit !== 'year') cadence.months = [];
        if (cadence.unit === 'year' && !cadence.months.length) cadence.months = [1];
        // A quarterly anchor only names the quarter months; it means nothing to another unit.
        if (cadence.interval === 1) cadence.anchor = '';
        ensureCadenceAnchor(cadence);
        paint('[data-cadence-unit]');
      } else if (control.matches('[data-cadence-anchor]')) {
        cadence.anchor = parseDay(control.value) ? control.value : '';
        paint('[data-cadence-anchor]');
      } else if (control.matches('[data-cadence-quarter]')) {
        const first = Math.round(clampNumber(control.value, 0, 2, 0));
        cadence.anchor = first ? `${localToday().slice(0, 4)}-0${first + 1}-01` : '';
        paint('[data-cadence-quarter]');
      } else if (control.matches('[data-cadence-adjust]')) {
        cadence.adjust = control.value;
        paint('[data-cadence-adjust]');
      } else if (control.matches('[data-cadence-nth],[data-cadence-position-weekday]')) {
        const row = control.closest('[data-cadence-position]');
        const position = cadence.positions[Number(row?.dataset.cadencePosition)];
        if (!position) return;
        position.nth = Number(row.querySelector('[data-cadence-nth]').value);
        position.weekday = Number(row.querySelector('[data-cadence-position-weekday]').value);
        paint(`[data-cadence-position="${row.dataset.cadencePosition}"] ${control.matches('[data-cadence-nth]') ? '[data-cadence-nth]' : '[data-cadence-position-weekday]'}`);
      }
    });
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
    const corrections = correctionPolicy(schedule);
    const scheduleId = text(schedule.id, '__new__');
    const name = text(schedule.name, 'New pay schedule');
    const timing = text(schedule.timing_basis, 'worked');
    const delay = object(schedule.delay);
    const timezone = text(schedule.timezone, browserTimezone(), 'UTC');
    return `<section class="pycfg-panel pycfg-details-panel ${String(isNew ? 'new' : '')}">
      <header class="pycfg-panel-head"><span><small>${(globalThis.PlatformLanguage?.htmlText("settings","m_9d0b9f0ccddeeb","Schedule details") ?? "Schedule details")}</small><strong>${String(esc(name))}</strong></span>${String(isNew ? `<span class="pycfg-pill">${(globalThis.PlatformLanguage?.htmlText("settings","m_96834d2fc9c9a5","New") ?? "New")}</span>` : `<span class="pycfg-pill ${schedule.status === 'archived' ? 'off' : ''}">${esc(schedule.status || 'active')}</span>`)}</header>
      <form class="pycfg-panel-body" data-schedule-form data-schedule-id="${String(esc(scheduleId))}">
        <div class="pycfg-detail-grid">
          <label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_9abccb09d5d19a","Schedule name") ?? "Schedule name")}</span><input class="pycfg-input" data-schedule-name value="${String(esc(isNew ? '' : schedule.name))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("settings","m_6e26b31256545b","Weekly crew payroll") ?? "Weekly crew payroll")}" required></label>
          <label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_e293c8fccb7de8","Default recognition") ?? "Default recognition")}</span><select class="pycfg-select" data-schedule-timing><option value="worked" ${String(timing === 'worked' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("settings","m_12ee42c07782b8","When work is performed") ?? "When work is performed")}</option><option value="completed" ${String(timing === 'completed' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("settings","m_60d38c1d5a3e58","When the job is completed") ?? "When the job is completed")}</option></select></label>
          <div class="pycfg-cadence" data-recurrence-fields>${String(cadenceMarkup(cadenceFromRecurrence(recurrence)))}</div>
          <label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_34500407fc8794","Delay — periods") ?? "Delay — periods")}</span><input class="pycfg-input" type="number" min="0" max="26" data-delay-periods value="${String(esc(Number(delay.periods || 0)))}"><small class="pycfg-help">${(globalThis.PlatformLanguage?.htmlText("settings","m_e71ff6fb318f0e","One period is common for weekly payroll.") ?? "One period is common for weekly payroll.")}</small></label>
          <label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_74b3b541b7b255","Extra delay — days") ?? "Extra delay — days")}</span><input class="pycfg-input" type="number" min="0" max="365" data-delay-days value="${String(esc(Number(delay.days || 0)))}"></label>
          <label class="pycfg-field"><span>If a paid earning goes up</span><select class="pycfg-select" data-correction-increase>${optionsMarkup(CORRECTION_CHOICES.increase, corrections.increase)}</select></label>
          <label class="pycfg-field"><span>If a paid earning goes down</span><select class="pycfg-select" data-correction-decrease>${optionsMarkup(CORRECTION_CHOICES.decrease, corrections.decrease)}</select></label>
          <small class="pycfg-help" style="grid-column:1/-1">These apply when an earning changes after it has been in a pay run. A change before then simply joins the same run. Held changes wait as projected entries until someone accepts or declines them; nothing already paid is edited.</small>
        </div>
        <details class="pycfg-advanced"><summary><span><i class="fas fa-sliders"></i><strong>${(globalThis.PlatformLanguage?.htmlText("settings","m_eac1a2ef5e4c32","Advanced settings") ?? "Advanced settings")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("settings","m_f03565669d0bd9","Timezone and clawback limits") ?? "Timezone and clawback limits")}</small></span><i class="fas fa-chevron-down"></i></summary><div class="pycfg-advanced-grid"><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_4a5d83497b6e10","Timezone") ?? "Timezone")}</span><input class="pycfg-input" list="pycfgTimezoneOptions" data-schedule-timezone value="${String(esc(timezone))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("settings","m_1cf50d801bfa46","America/Los_Angeles") ?? "America/Los_Angeles")}" required><datalist id="pycfgTimezoneOptions">${String(timezoneOptions(timezone))}</datalist></label><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_f5ccb81445da5a","Clawback cap / check") ?? "Clawback cap / check")}</span><div class="pycfg-percent"><input class="pycfg-input" type="number" min="0" max="100" step="0.01" data-schedule-clawback value="${String(esc(Number(schedule.clawback_cap_percent ?? 100)))}"><span>%</span></div></label></div></details>
        <div class="pycfg-actions"><span class="pycfg-form-status" data-form-status></span>${String(isNew ? `<button class="pycfg-btn" type="button" data-cancel-new>${(globalThis.PlatformLanguage?.htmlText("settings","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>` : `<button class="pycfg-btn danger" type="button" data-archive-schedule ${schedule.status === 'archived' ? 'disabled' : ''}><i class="fas fa-box-archive"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_d248c450100477"," Archive") ?? " Archive")}</button>`)}<button class="pycfg-btn primary" type="submit"><i class="fas fa-floppy-disk"></i> ${String(isNew ? 'Create schedule' : 'Save changes')}</button></div>
      </form>
    </section>`;
  }

  function schedulePayload(form, existing = {}){
    const recurrence = recurrenceFromCadence(form._pycfgCadence || cadenceFromRecurrence(existing.recurrence));
    const defaults = correctionPolicy(existing);
    const correction = (direction) => {
      const chosen = text(form.querySelector(`[data-correction-${direction}]`)?.value, defaults[direction]);
      return CORRECTION_CHOICES[direction].some(([id]) => id === chosen) ? chosen : defaults[direction];
    };
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
      metadata:{ ...object(existing.metadata), correction_policy:{ ...object(object(existing.metadata).correction_policy), increase:correction('increase'), decrease:correction('decrease') } },
      ...(Number(existing.revision || 0) > 0 ? { expected_revision:Number(existing.revision) } : {})
    };
  }

  function assignmentRuleMarkup(subject, policy = {}){
    const earningKind = text(policy.earning_kind, '*');
    return `<form class="pycfg-assignment" data-policy-form data-subject-type="${String(esc(subject.type))}" data-subject-id="${String(esc(subject.id))}" data-policy-kind="${String(esc(earningKind))}" data-policy-revision="${String(esc(policy.revision || ''))}" data-schedule-id="${String(esc(policy.schedule_id))}">
      <header class="pycfg-assignment-head"><span class="pycfg-subject-icon"><i class="fas ${String(subjectIcon(subject.type))}"></i></span><span class="pycfg-subject-copy"><strong>${String(esc(subject.label))}</strong><span>${String(esc(subjectTypeLabel(subject.type)))} · ${String(esc(earningKindLabel(earningKind)))}</span></span><button class="pycfg-icon-btn danger" type="button" data-delete-policy title="${(globalThis.PlatformLanguage?.htmlText("settings","m_c1ddc7495a6c43","Remove assignment") ?? "Remove assignment")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("settings","m_c1ddc7495a6c43","Remove assignment") ?? "Remove assignment")}"><i class="fas fa-trash"></i></button></header>
      <div class="pycfg-assignment-fields"><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_48cacd50d701d8","Recognition") ?? "Recognition")}</span><select class="pycfg-select" data-policy-timing><option value="">${(globalThis.PlatformLanguage?.htmlText("settings","m_e8b95430c3cd30","Schedule default") ?? "Schedule default")}</option><option value="worked" ${String(policy.timing_basis === 'worked' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("settings","m_12ee42c07782b8","When work is performed") ?? "When work is performed")}</option><option value="completed" ${String(policy.timing_basis === 'completed' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("settings","m_5eda8826a44a2d","When job is completed") ?? "When job is completed")}</option></select></label><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_57c29b3ae2c29b","Clawback cap") ?? "Clawback cap")}</span><div class="pycfg-percent"><input class="pycfg-input" data-policy-clawback type="number" min="0" max="100" step="0.01" value="${String(policy.clawback_cap_percent == null ? '' : esc(policy.clawback_cap_percent))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("settings","m_f59e6b09f14267","Default") ?? "Default")}"><span>%</span></div></label><button class="pycfg-btn" type="submit"><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_13fcb6ceae139c"," Save") ?? " Save")}</button></div>
      <span class="pycfg-rule-status" data-policy-status></span>
    </form>`;
  }

  // ---- Pay rules and pay plans (docs/architecture/pay-rules.md) ----

  // The version in effect on a day: the latest that starts on or before it.
  function versionOn(versions, date){
    let found = null;
    for (const version of array(versions)) {
      if (text(version?.effective_from) <= date && (!found || text(version.effective_from) >= text(found.effective_from))) found = version;
    }
    return found;
  }

  function versionInfo(item){
    const versions = [...array(item?.versions)].sort((left, right) => text(left?.effective_from).localeCompare(text(right?.effective_from)));
    const day = localToday();
    const current = versionOn(versions, day);
    const upcoming = versions.filter((version) => text(version?.effective_from) > day);
    return { versions, current, upcoming, shown:current || upcoming[0] || null };
  }

  // Values typed into a plain text box: true and false, numbers, quoted or bracketed JSON, otherwise the text itself.
  function looseParse(value){
    const raw = text(value);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return Number(raw);
    if (/^["\[{]/.test(raw)) { try { return JSON.parse(raw); } catch(e) {} }
    return raw;
  }

  function looseFormat(value){
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return looseParse(value) === value ? value : JSON.stringify(value);
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  const isPlainValue = (value) => ['string', 'number', 'boolean'].includes(typeof value);
  const operatorEntry = (id) => CONDITION_OPERATORS.find(([operator]) => operator === id);

  // A filter as editable rows when it is one flat group; null when it nests and has to be edited as JSON.
  function flatWhere(where){
    if (where === undefined || where === null) return { match:'all', rules:[] };
    if (typeof where !== 'object' || Array.isArray(where) || !Array.isArray(where.rules)) return null;
    if (Object.keys(where).some((key) => key !== 'match' && key !== 'rules')) return null;
    const flat = where.rules.every((rule) => rule && typeof rule === 'object' && !Array.isArray(rule) && typeof rule.field === 'string'
      && Object.keys(rule).every((key) => ['field', 'operator', 'value'].includes(key))
      && (rule.value === undefined || isPlainValue(rule.value) || (Array.isArray(rule.value) && rule.value.every(isPlainValue))));
    if (!flat) return null;
    return {
      match:where.match === 'any' ? 'any' : 'all',
      rules:where.rules.map((rule) => ({ field:rule.field, operator:text(rule.operator, 'equals'), value:Array.isArray(rule.value) ? rule.value.map(looseFormat).join(', ') : looseFormat(rule.value) }))
    };
  }

  function whereText(where){
    const group = object(where);
    const rules = array(group.rules);
    if (!rules.length) return 'every row';
    return rules.map((rule) => Array.isArray(rule?.rules)
      ? `(${whereText(rule)})`
      : `${text(rule?.field)} ${operatorEntry(rule?.operator)?.[1] || text(rule?.operator)}${rule?.value === undefined ? '' : ` ${Array.isArray(rule.value) ? rule.value.map(looseFormat).join(', ') : looseFormat(rule.value)}`}`
    ).join(group.match === 'any' ? ' or ' : ' and ');
  }

  function grainLabel(definition){
    const value = object(definition);
    if (value.grain === 'period') return `Once per ${text(value.period, 'period')}`;
    const primary = Object.entries(object(value.inputs)).find(([, input]) => input?.primary)?.[0];
    return primary ? `Once per row of ${primary}` : 'Once per record';
  }

  function blankRuleInput(primary = false){
    return { name:'', provider:'payroll', export:'', args:[], date:'', limit:'', primary, whereMode:'rules', match:'all', rules:[], whereJson:'' };
  }

  function ruleInputDraft(name, value){
    const input = object(value);
    const flat = flatWhere(input.where);
    return {
      name,
      provider:text(object(input.source).provider),
      export:text(object(input.source).export),
      args:Object.entries(object(object(input.source).args)).map(([key, entry]) => ({ key, value:looseFormat(entry) })),
      date:text(input.date),
      limit:input.limit === undefined ? '' : String(input.limit),
      primary:input.primary === true,
      whereMode:flat ? 'rules' : 'json',
      match:flat?.match || 'all',
      rules:flat?.rules || [],
      whereJson:flat ? '' : JSON.stringify(input.where, null, 2)
    };
  }

  // The form's working copy of a rule, started from one of its versions. A new version takes effect today unless changed.
  function ruleDraft(rule, version){
    const definition = object(version?.definition);
    const fresh = !rule;
    return {
      id:text(rule?.id),
      revision:Number(rule?.revision || 0),
      status:text(rule?.status, 'active'),
      name:text(rule?.name),
      description:text(rule?.description),
      effective_from:localToday(),
      based_on:text(version?.effective_from),
      grain:text(definition.grain, 'record'),
      period:text(definition.period, 'week'),
      week_starts:Math.round(clampNumber(definition.week_starts ?? 1, 0, 6, 1)),
      always:definition.always === true,
      timezone:text(definition.timezone),
      kind:text(definition.kind, 'commission'),
      earned_at:text(definition.earned_at),
      project:text(definition.project),
      inputs:fresh ? [blankRuleInput(true)] : Object.entries(object(definition.inputs)).map(([name, input]) => ruleInputDraft(name, input)),
      parameters:Object.entries(object(definition.parameters)).map(([key, parameter]) => ({
        key,
        label:text(parameter?.label),
        type:typeof parameter?.default === 'boolean' ? 'boolean' : typeof parameter?.default === 'string' ? 'text' : 'number',
        default:parameter?.default === undefined ? '' : String(parameter.default)
      })),
      code:String(definition.code ?? '')
    };
  }

  function ruleInputWhere(input, label){
    if (input.whereMode === 'json') {
      const raw = text(input.whereJson);
      if (!raw) return undefined;
      try { return JSON.parse(raw); } catch(e) { throw new Error(`${label}: the filter is not valid JSON.`); }
    }
    const rules = input.rules.filter((rule) => text(rule.field)).map((rule) => {
      const kind = operatorEntry(rule.operator)?.[2] || 'one';
      if (kind === 'none') return { field:text(rule.field), operator:rule.operator };
      if (text(rule.value) === '') throw new Error(`${label}: give ${text(rule.field)} a value to compare with.`);
      if (kind === 'list') return { field:text(rule.field), operator:rule.operator, value:text(rule.value).split(',').map((entry) => entry.trim()).filter(Boolean).map(looseParse) };
      if (kind === 'number') {
        if (!Number.isFinite(Number(rule.value))) throw new Error(`${label}: ${text(rule.field)} needs a number.`);
        return { field:text(rule.field), operator:rule.operator, value:Number(rule.value) };
      }
      return { field:text(rule.field), operator:rule.operator, value:kind === 'time' ? text(rule.value) : looseParse(rule.value) };
    });
    return rules.length ? { ...(input.match === 'any' ? { match:'any' } : {}), rules } : undefined;
  }

  // The definition the API stores for a working copy. Throws a sentence the form can show.
  function ruleDefinition(draft){
    const nameRule = /^[a-z][a-z0-9_]{0,59}$/;
    const pathRule = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
    const record = draft.grain !== 'period';
    const inputs = {};
    draft.inputs.forEach((input, index) => {
      const name = text(input.name);
      const label = name ? `Input ${name}` : `Input ${index + 1}`;
      if (!nameRule.test(name)) throw new Error(`${label}: name it with lowercase letters, digits and underscores, starting with a letter.`);
      if (inputs[name]) throw new Error(`Two inputs are named ${name}.`);
      if (!text(input.provider) || !text(input.export)) throw new Error(`${label}: say which published collection it reads.`);
      const args = {};
      input.args.forEach((entry) => { if (text(entry.key)) args[text(entry.key)] = looseParse(entry.value); });
      const where = ruleInputWhere(input, label);
      const date = text(input.date);
      if (date && !pathRule.test(date)) throw new Error(`${label}: the date field is a dot path such as clocked_out_at.`);
      const limit = text(input.limit) ? Math.round(Number(input.limit)) : 0;
      if (text(input.limit) && !(limit >= 1 && limit <= 5000)) throw new Error(`${label}: the row limit is between 1 and 5000.`);
      inputs[name] = {
        source:{ provider:text(input.provider), export:text(input.export), ...(Object.keys(args).length ? { args } : {}) },
        ...(where === undefined ? {} : { where }),
        ...(date ? { date } : {}),
        ...(limit ? { limit } : {}),
        ...(record && input.primary ? { primary:true } : {})
      };
    });
    if (Object.keys(inputs).length > 8) throw new Error('A rule reads at most eight inputs.');
    const parameters = {};
    draft.parameters.forEach((parameter) => {
      const key = text(parameter.key);
      if (!key && !text(parameter.label) && text(parameter.default) === '') return;
      if (!nameRule.test(key)) throw new Error(`Parameter ${key || '(unnamed)'}: name it with lowercase letters, digits and underscores, starting with a letter.`);
      if (parameters[key]) throw new Error(`Two parameters are named ${key}.`);
      const raw = text(parameter.default);
      let fallback;
      if (parameter.type === 'boolean') fallback = raw === 'true' ? true : raw === 'false' ? false : undefined;
      else if (parameter.type === 'text') fallback = raw === '' ? undefined : raw;
      else if (raw !== '') {
        if (!Number.isFinite(Number(raw))) throw new Error(`Parameter ${key}: the default is a number.`);
        fallback = Number(raw);
      }
      parameters[key] = { ...(text(parameter.label) ? { label:text(parameter.label) } : {}), ...(fallback === undefined ? {} : { default:fallback }) };
    });
    if (!String(draft.code || '').trim()) throw new Error('Write the formula.');
    const definition = { grain:record ? 'record' : 'period' };
    if (record) {
      if (Object.values(inputs).filter((input) => input.primary).length !== 1) throw new Error('Mark exactly one input as the one each earning comes from.');
      if (!pathRule.test(text(draft.earned_at))) throw new Error('Name the field of that input that holds the date the earning was earned.');
      definition.earned_at = text(draft.earned_at);
      if (text(draft.project)) {
        if (!pathRule.test(text(draft.project))) throw new Error('The project field is a dot path such as project_id.');
        definition.project = text(draft.project);
      }
    } else {
      if (!PAY_PERIODS.some(([id]) => id === draft.period)) throw new Error('Choose the period this rule pays by.');
      definition.period = draft.period;
      if (draft.period === 'week') definition.week_starts = Math.round(clampNumber(draft.week_starts, 0, 6, 1));
      if (draft.always) definition.always = true;
      else if (!Object.values(inputs).some((input) => input.date)) throw new Error('A rule that pays by period needs an input with a date field, or to pay every period.');
    }
    if (text(draft.timezone)) definition.timezone = text(draft.timezone);
    definition.kind = PAY_RULE_KINDS.some(([id]) => id === draft.kind) ? draft.kind : 'commission';
    definition.inputs = inputs;
    definition.parameters = parameters;
    definition.code = String(draft.code);
    return definition;
  }

  function effectiveDate(draft){
    const day = text(draft.effective_from);
    if (!parseDay(day)) throw new Error('Choose the date this version takes effect.');
    return day;
  }

  function rulePayload(draft){
    const name = text(draft.name);
    if (!name) throw new Error('Name the pay rule.');
    const definition = ruleDefinition(draft);
    return {
      ...(draft.id ? { id:draft.id } : {}),
      name,
      description:text(draft.description),
      effective_from:effectiveDate(draft),
      definition,
      ...(draft.id && draft.revision > 0 ? { expected_revision:draft.revision } : {})
    };
  }

  function planDraft(plan, version){
    return {
      id:text(plan?.id),
      revision:Number(plan?.revision || 0),
      status:text(plan?.status, 'active'),
      name:text(plan?.name),
      description:text(plan?.description),
      effective_from:localToday(),
      based_on:text(version?.effective_from),
      rules:array(version?.rules).map((reference) => ({ rule_id:text(reference?.rule_id), params:{ ...object(reference?.params) } })).filter((reference) => reference.rule_id)
    };
  }

  function planPayload(draft){
    const name = text(draft.name);
    if (!name) throw new Error('Name the pay plan.');
    if (draft.rules.length > 64) throw new Error('A plan holds at most 64 rules.');
    return {
      ...(draft.id ? { id:draft.id } : {}),
      name,
      description:text(draft.description),
      effective_from:effectiveDate(draft),
      rules:draft.rules.map((reference) => ({ rule_id:reference.rule_id, ...(Object.keys(reference.params).length ? { params:reference.params } : {}) })),
      ...(draft.id && draft.revision > 0 ? { expected_revision:draft.revision } : {})
    };
  }

  // What saving on this date means, said plainly: a past date backdates, and earnings follow at the next refresh.
  function effectiveNoteMarkup(draft, item){
    const day = text(draft.effective_from);
    const todayKey = localToday();
    if (!parseDay(day)) return '<small class="pycfg-help" data-effective-note>Choose the first day this version applies to.</small>';
    const replaces = array(item?.versions).some((version) => text(version?.effective_from) === day) ? ` It replaces the version already dated ${esc(formatDay(day))}.` : '';
    if (day < todayKey) return `<div class="pycfg-warn" data-effective-note data-backdated><i class="fas fa-clock-rotate-left"></i> ${esc(formatDay(day))} is in the past, so this is backdated. Earnings earned from that day are worked out again at the next refresh, and any difference is posted as a correction. Nothing already paid is edited.${replaces}</div>`;
    return `<small class="pycfg-help" data-effective-note>${day === todayKey ? 'Applies to earnings earned from today.' : `Takes effect on ${esc(formatDay(day))}. Earnings earned before then keep the version before it.`} Earnings change at the next refresh.${replaces}</small>`;
  }

  function versionPickerMarkup(draft, item){
    const info = versionInfo(item);
    if (!info.versions.length) return '';
    const choices = [...info.versions].reverse().map((version) => [text(version.effective_from), `From ${formatDay(version.effective_from)}${version === info.current ? ' (in effect)' : text(version.effective_from) > localToday() ? ' (upcoming)' : ''}`]);
    return `<label class="pycfg-field"><span>Start from version</span><select class="pycfg-select" data-pay-base>${optionsMarkup(choices, draft.based_on)}</select><small class="pycfg-help">The form is filled from this version. Saving never changes it unless the dates match.</small></label>`;
  }

  function versionPills(item){
    const info = versionInfo(item);
    const pills = [];
    if (info.current) pills.push(`<span class="pycfg-pill">In effect since ${esc(formatDay(info.current.effective_from))}</span>`);
    else if (info.shown) pills.push(`<span class="pycfg-pill off">Starts ${esc(formatDay(info.shown.effective_from))}</span>`);
    if (info.current && info.upcoming.length) pills.push(`<span class="pycfg-pill">Changes ${esc(formatDay(info.upcoming[0].effective_from))}</span>`);
    if (info.versions.length > 1) pills.push(`<span class="pycfg-pill">${info.versions.length} versions</span>`);
    if (item?.status === 'archived') pills.push('<span class="pycfg-pill off">Archived</span>');
    return pills.join('');
  }

  function versionHistoryMarkup(item){
    const info = versionInfo(item);
    return [...info.versions].reverse().map((version) => `<div>From ${esc(formatDay(version.effective_from))}${version === info.current ? ' · in effect' : text(version.effective_from) > localToday() ? ' · upcoming' : ''}${version.version ? ` · <code>${esc(text(version.version).slice(0, 8))}</code>` : ''}${version.entered_at ? ` · entered ${esc(formatDay(version.entered_at))}` : ''}</div>`).join('');
  }

  function payCardActions(kind, item){
    const attributes = `data-pay-kind="${kind}" data-pay-id="${esc(item.id)}"`;
    return `<div class="pycfg-actions"><button class="pycfg-btn danger" type="button" data-pay-archive ${attributes} ${item.status === 'archived' ? 'disabled' : ''}><i class="fas fa-box-archive"></i> Archive</button>${kind === 'rule' ? `<button class="pycfg-btn" type="button" data-pay-copy ${attributes}><i class="fas fa-copy"></i> Duplicate</button>` : ''}<button class="pycfg-btn primary" type="button" data-pay-edit ${attributes}><i class="fas fa-pen"></i> ${item.status === 'archived' ? 'Edit and restore' : 'Edit'}</button></div>`;
  }

  function ruleCardMarkup(rule, open){
    const info = versionInfo(rule);
    const definition = object(info.shown?.definition);
    const record = definition.grain !== 'period';
    const inputs = Object.entries(object(definition.inputs));
    const parameters = Object.entries(object(definition.parameters));
    const kind = PAY_RULE_KINDS.find(([id]) => id === definition.kind)?.[1] || text(definition.kind);
    return `<details class="pycfg-card" data-pay-card="rule:${esc(rule.id)}" ${open ? 'open' : ''}>
      <summary><span class="pycfg-card-icon"><i class="fas fa-calculator"></i></span><span class="pycfg-card-title"><strong>${esc(text(rule.name, rule.id))}</strong><span>${esc(text(rule.description, grainLabel(definition)))}</span></span><span class="pycfg-card-meta">${kind ? `<span class="pycfg-pill">${esc(kind)}</span>` : ''}<span class="pycfg-pill">${esc(grainLabel(definition))}</span>${versionPills(rule)}</span></summary>
      <div class="pycfg-editor pycfg-card-detail"><dl class="pycfg-dl">
        <dt>Pays</dt><dd>${esc(grainLabel(definition))}${!record && definition.period === 'week' ? `, weeks starting ${esc(WEEKDAYS[Number(definition.week_starts ?? 1)] || 'Monday')}` : ''}${definition.always ? ', every period even when no input has a row in it' : ''}</dd>
        <dt>Earned on</dt><dd>${record ? `The date in <code>${esc(text(definition.earned_at))}</code>. A row without it has not been earned.` : 'The last day of each period, once that day is over.'}</dd>
        ${definition.project ? `<dt>Project</dt><dd><code>${esc(definition.project)}</code></dd>` : ''}
        ${definition.timezone ? `<dt>Timezone</dt><dd>${esc(definition.timezone)}</dd>` : ''}
        <dt>Inputs</dt><dd>${inputs.length ? inputs.map(([name, input]) => `<div><code>${esc(name)}</code>${input?.primary ? ' (each earning comes from one of these)' : ''}: ${esc(text(object(input?.source).provider))}.${esc(text(object(input?.source).export))}${Object.keys(object(object(input?.source).args)).length ? ` with ${esc(Object.entries(object(input.source.args)).map(([key, value]) => `${key} = ${looseFormat(value)}`).join(', '))}` : ''}, where ${esc(whereText(input?.where))}${input?.date ? `, dated by <code>${esc(input.date)}</code>` : ''}${input?.limit ? `, at most ${esc(input.limit)} rows` : ''}</div>`).join('') : 'None. It reads no data.'}</dd>
        <dt>Parameters</dt><dd>${parameters.length ? parameters.map(([key, parameter]) => `<div><code>${esc(key)}</code>${parameter?.label ? ` ${esc(parameter.label)}` : ''}: ${parameter?.default === undefined ? 'no default, a plan or a payee sets it' : `default ${esc(looseFormat(parameter.default))}`}</div>`).join('') : 'None'}</dd>
        <dt>Versions</dt><dd>${versionHistoryMarkup(rule) || 'None'}</dd>
      </dl><pre class="pycfg-pre" data-rule-code>${esc(definition.code)}</pre>${payCardActions('rule', rule)}</div>
    </details>`;
  }

  function planCardMarkup(plan, rules, open){
    const info = versionInfo(plan);
    const references = array(info.shown?.rules);
    const lines = references.map((reference) => {
      const rule = rules.find((item) => item.id === reference?.rule_id);
      const declared = object(object(versionInfo(rule).shown?.definition).parameters);
      const set = object(reference?.params);
      const parts = [...new Set([...Object.keys(declared), ...Object.keys(set)])].map((key) => `${esc(text(declared[key]?.label, key))}: ${set[key] !== undefined ? `<strong>${esc(looseFormat(set[key]))}</strong>` : declared[key]?.default !== undefined ? `${esc(looseFormat(declared[key].default))} (rule default)` : 'not set'}`);
      return `<div><strong>${esc(text(rule?.name, reference?.rule_id))}</strong>${rule ? '' : ' (this rule no longer exists)'}${rule?.status === 'archived' ? ' (archived)' : ''}${parts.length ? `<br>${parts.join(' · ')}` : ''}</div>`;
    });
    return `<details class="pycfg-card" data-pay-card="plan:${esc(plan.id)}" ${open ? 'open' : ''}>
      <summary><span class="pycfg-card-icon"><i class="fas fa-layer-group"></i></span><span class="pycfg-card-title"><strong>${esc(text(plan.name, plan.id))}</strong><span>${esc(text(plan.description, 'Pay plan'))}</span></span><span class="pycfg-card-meta"><span class="pycfg-pill">${references.length} ${references.length === 1 ? 'rule' : 'rules'}</span>${versionPills(plan)}</span></summary>
      <div class="pycfg-editor pycfg-card-detail"><dl class="pycfg-dl"><dt>Rules</dt><dd>${lines.join('') || 'No rules yet.'}</dd><dt>Versions</dt><dd>${versionHistoryMarkup(plan) || 'None'}</dd></dl>${payCardActions('plan', plan)}</div>
    </details>`;
  }

  function payParameterType(declared, value){
    const sample = declared?.default !== undefined ? declared.default : value;
    return typeof sample === 'boolean' ? 'boolean' : typeof sample === 'number' ? 'number' : typeof sample === 'string' ? 'text' : 'loose';
  }

  function planEditorMarkup(draft, plan, rules){
    const isNew = !draft.id;
    const included = new Map(draft.rules.map((reference) => [reference.rule_id, reference]));
    const known = new Set(rules.map((rule) => rule.id));
    const candidates = [
      ...draft.rules.map((reference) => rules.find((rule) => rule.id === reference.rule_id) || { id:reference.rule_id, name:reference.rule_id, missing:true }),
      ...rules.filter((rule) => !included.has(rule.id) && rule.status !== 'archived').sort((left, right) => text(left.name).localeCompare(text(right.name)))
    ];
    const ruleRows = candidates.map((rule) => {
      const reference = included.get(rule.id);
      const definition = object((versionOn(rule.versions, text(draft.effective_from)) || versionInfo(rule).shown)?.definition);
      const declared = object(definition.parameters);
      const keys = reference ? [...new Set([...Object.keys(declared), ...Object.keys(reference.params)])] : [];
      const fields = keys.map((key) => {
        const value = reference.params[key];
        const type = payParameterType(declared[key], value);
        const fallback = declared[key]?.default;
        const attributes = `data-plan-param="${esc(key)}" data-param-type="${type}"`;
        const control = type === 'boolean'
          ? `<select class="pycfg-select" ${attributes}>${optionsMarkup([['', fallback === undefined ? 'Not set' : `Rule default (${fallback ? 'Yes' : 'No'})`], ['true', 'Yes'], ['false', 'No']], value === undefined ? '' : String(value))}</select>`
          : `<input class="pycfg-input" ${type === 'number' ? 'type="number" step="any"' : type === 'loose' ? 'inputmode="decimal"' : ''} ${attributes} value="${esc(value === undefined ? '' : type === 'loose' ? looseFormat(value) : value)}" placeholder="${esc(fallback === undefined ? 'Not set' : `Rule default: ${looseFormat(fallback)}`)}">`;
        return `<label class="pycfg-field"><span>${esc(text(declared[key]?.label, key))}</span>${control}<small class="pycfg-help">${declared[key] ? (fallback === undefined ? 'The rule has no default. Set it here, or leave it for each payee.' : 'Leave empty to use the rule default.') : 'The rule no longer declares this. Clear it to remove it.'}</small></label>`;
      }).join('');
      return `<div class="pycfg-plan-rule ${reference ? 'on' : ''}" data-plan-rule="${esc(rule.id)}"><label class="pycfg-check"><input type="checkbox" data-plan-include ${reference ? 'checked' : ''}><span><strong>${esc(text(rule.name, rule.id))}</strong><small>${rule.missing ? 'This rule no longer exists. Take it out to save the plan.' : `${esc(text(rule.description, grainLabel(definition)))}${rule.status === 'archived' ? ' · archived' : ''}`}</small></span></label>${fields ? `<div class="pycfg-grid two">${fields}</div>` : ''}</div>`;
    }).join('');
    return `<section class="pycfg-panel ${isNew ? 'new' : ''}"><header class="pycfg-panel-head"><span><small>${isNew ? 'New pay plan' : 'Pay plan'}</small><strong>${esc(text(draft.name, 'New pay plan'))}</strong></span><div class="pycfg-panel-head-actions"><button class="pycfg-btn" type="button" data-pay-close><i class="fas fa-arrow-left"></i> Plans and rules</button></div></header>
      <form class="pycfg-panel-body pycfg-stack" data-pay-form="plan">
        <div class="pycfg-grid two"><label class="pycfg-field"><span>Plan name</span><input class="pycfg-input" data-plan="name" value="${esc(draft.name)}" placeholder="Estimator" maxlength="200" required></label><label class="pycfg-field"><span>Description</span><input class="pycfg-input" data-plan="description" value="${esc(draft.description)}" placeholder="Who this plan is for and what it pays" maxlength="2000"></label></div>
        <div class="pycfg-block"><div class="pycfg-block-head"><span><strong>Rules in this plan</strong><small>Tick the rules the plan pays by, and set the numbers the plan fixes for each.</small></span><span class="pycfg-pill" data-plan-count>${draft.rules.length} selected</span></div>${ruleRows || '<div class="pycfg-help">There are no pay rules yet. Create a pay rule first.</div>'}</div>
        <div class="pycfg-block"><div class="pycfg-block-head"><span><strong>When this version takes effect</strong><small>Plans keep every version. People on the plan follow it from this date.</small></span></div><div class="pycfg-grid two"><label class="pycfg-field"><span>Effective from</span><input class="pycfg-input" type="date" data-plan="effective_from" data-pay-rerender value="${esc(draft.effective_from)}" required></label>${isNew ? '' : versionPickerMarkup(draft, plan)}</div>${effectiveNoteMarkup(draft, plan)}</div>
        <div class="pycfg-actions"><span class="pycfg-form-status" data-form-status></span><button class="pycfg-btn" type="button" data-pay-close>${(globalThis.PlatformLanguage?.htmlText("settings","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button class="pycfg-btn primary" type="submit"><i class="fas fa-floppy-disk"></i> ${isNew ? 'Create plan' : 'Save as a version'}</button></div>
      </form></section>`;
  }

  function ruleEditorMarkup(draft, rule){
    const isNew = !draft.id;
    const record = draft.grain !== 'period';
    const removeButton = (attribute, label) => `<button class="pycfg-icon-btn danger" type="button" ${attribute} title="${label}" aria-label="${label}"><i class="fas fa-xmark"></i></button>`;
    const inputBlocks = draft.inputs.map((input, index) => {
      const conditions = input.whereMode === 'json'
        ? `<label class="pycfg-field"><span>Filter (JSON)</span><textarea class="pycfg-textarea json" data-in="whereJson" spellcheck="false">${esc(input.whereJson)}</textarea><small class="pycfg-help">This filter has nested groups, so it is edited as written. <code>$payee.key</code>, <code>$payee.type</code> and <code>$payee.id</code> stand for the payee.</small></label><div><button class="pycfg-btn" type="button" data-in-where-mode="rules"><i class="fas fa-list"></i> Edit as rows</button></div>`
        : `${input.rules.map((rule) => {
          const kind = operatorEntry(rule.operator)?.[2] || 'one';
          return `<div class="pycfg-rowgrid cond" data-in-cond><label class="pycfg-field"><span>Field</span><input class="pycfg-input" data-c="field" value="${esc(rule.field)}" placeholder="assignee_key" spellcheck="false"></label><label class="pycfg-field"><span>Condition</span><select class="pycfg-select" data-c="operator" data-pay-rerender>${optionsMarkup(CONDITION_OPERATORS.map(([id, label]) => [id, label]), rule.operator)}</select></label>${kind === 'none' ? '<span></span>' : `<label class="pycfg-field"><span>${kind === 'list' ? 'Values, comma separated' : 'Value'}</span><input class="pycfg-input" data-c="value" value="${esc(rule.value)}" placeholder="${kind === 'time' ? 'now-30d' : '$payee.key'}" spellcheck="false"></label>`}${removeButton('data-in-remove-cond', 'Remove this condition')}</div>`;
        }).join('')}<div class="pycfg-cadence-row"><button class="pycfg-btn" type="button" data-in-add-cond><i class="fas fa-plus"></i> Add a condition</button>${input.rules.length > 1 ? `<select class="pycfg-select" data-in="match" aria-label="How conditions combine">${optionsMarkup([['all', 'Rows must match every condition'], ['any', 'Rows may match any condition']], input.match)}</select>` : ''}<button class="pycfg-btn" type="button" data-in-where-mode="json"><i class="fas fa-code"></i> Edit as JSON</button></div>`;
      return `<div class="pycfg-block nested" data-rule-input="${index}">
        <div class="pycfg-block-head"><span><strong>${esc(text(input.name, `Input ${index + 1}`))}</strong></span>${removeButton('data-rule-remove-input', 'Remove this input')}</div>
        <div class="pycfg-grid"><label class="pycfg-field"><span>Name in the formula</span><input class="pycfg-input" data-in="name" value="${esc(input.name)}" placeholder="projects" spellcheck="false" maxlength="60"></label><label class="pycfg-field"><span>Published by</span><input class="pycfg-input" data-in="provider" value="${esc(input.provider)}" placeholder="payroll" spellcheck="false"></label><label class="pycfg-field"><span>Collection</span><input class="pycfg-input" data-in="export" list="pycfgPaySources" value="${esc(input.export)}" placeholder="project_records" spellcheck="false"></label><label class="pycfg-field"><span>Most rows it may read</span><input class="pycfg-input" type="number" min="1" max="5000" step="1" data-in="limit" value="${esc(input.limit)}" placeholder="Default"></label>
          <label class="pycfg-field"><span>Date field</span><input class="pycfg-input" data-in="date" value="${esc(input.date)}" placeholder="${record ? 'Optional' : 'clocked_out_at'}" spellcheck="false"><small class="pycfg-help">${record ? 'Not needed for the input each earning comes from.' : 'Rows are grouped into periods by this date. Without one the input arrives whole as shared.'}</small></label>
          ${record ? `<label class="pycfg-check" style="align-self:center"><input type="radio" name="pycfgRulePrimary" data-in="primary" ${input.primary ? 'checked' : ''}><span><strong>One earning per row</strong><small>Other inputs arrive whole as <code>shared</code>.</small></span></label>` : ''}</div>
        <div class="pycfg-cadence-group"><span>Which rows</span>${conditions}</div>
        <div class="pycfg-cadence-group"><span>Options the collection takes</span>${input.args.map((entry) => `<div class="pycfg-rowgrid kv" data-in-arg><label class="pycfg-field"><span>Option</span><input class="pycfg-input" data-a="key" value="${esc(entry.key)}" placeholder="facts" spellcheck="false"></label><label class="pycfg-field"><span>Value</span><input class="pycfg-input" data-a="value" value="${esc(entry.value)}" placeholder="true" spellcheck="false"></label>${removeButton('data-in-remove-arg', 'Remove this option')}</div>`).join('')}<div><button class="pycfg-btn" type="button" data-in-add-arg><i class="fas fa-plus"></i> Add an option</button></div></div>
      </div>`;
    }).join('');
    const parameterRows = draft.parameters.map((parameter) => `<div class="pycfg-rowgrid param" data-rule-param><label class="pycfg-field"><span>Name in the formula</span><input class="pycfg-input" data-p="key" value="${esc(parameter.key)}" placeholder="rate_bps" spellcheck="false" maxlength="60"></label><label class="pycfg-field"><span>Label people see</span><input class="pycfg-input" data-p="label" value="${esc(parameter.label)}" placeholder="Share of contract (basis points)" maxlength="200"></label><label class="pycfg-field"><span>Kind</span><select class="pycfg-select" data-p="type" data-pay-rerender>${optionsMarkup([['number', 'Number'], ['boolean', 'Yes or no'], ['text', 'Text']], parameter.type)}</select></label><label class="pycfg-field"><span>Default</span>${parameter.type === 'boolean' ? `<select class="pycfg-select" data-p="default">${optionsMarkup([['', 'No default'], ['true', 'Yes'], ['false', 'No']], parameter.default)}</select>` : `<input class="pycfg-input" ${parameter.type === 'number' ? 'type="number" step="any"' : ''} data-p="default" value="${esc(parameter.default)}" placeholder="No default">`}</label>${removeButton('data-rule-remove-param', 'Remove this parameter')}</div>`).join('');
    return `<section class="pycfg-panel ${isNew ? 'new' : ''}"><header class="pycfg-panel-head"><span><small>${isNew ? 'New pay rule' : 'Pay rule'}</small><strong>${esc(text(draft.name, 'New pay rule'))}</strong></span><div class="pycfg-panel-head-actions"><button class="pycfg-btn" type="button" data-pay-close><i class="fas fa-arrow-left"></i> Plans and rules</button></div></header>
      <form class="pycfg-panel-body pycfg-stack" data-pay-form="rule">
        <div class="pycfg-grid"><label class="pycfg-field" style="grid-column:span 2"><span>Rule name</span><input class="pycfg-input" data-rule="name" value="${esc(draft.name)}" placeholder="Estimator commission when sold" maxlength="200" required></label><label class="pycfg-field"><span>Earning type</span><select class="pycfg-select" data-rule="kind">${optionsMarkup(PAY_RULE_KINDS, draft.kind)}</select></label><label class="pycfg-field"><span>Pays</span><select class="pycfg-select" data-rule="grain" data-pay-rerender>${optionsMarkup([['record', 'Once per record'], ['period', 'Once per period']], record ? 'record' : 'period')}</select></label>
          <label class="pycfg-field wide"><span>Description</span><input class="pycfg-input" data-rule="description" value="${esc(draft.description)}" placeholder="What this pays, for whom, and when it is earned" maxlength="2000"></label>
          ${record
            ? `<label class="pycfg-field" style="grid-column:span 2"><span>Earned-date field</span><input class="pycfg-input" data-rule="earned_at" value="${esc(draft.earned_at)}" placeholder="sold_at" spellcheck="false"><small class="pycfg-help">The field of the one-per-row input holding the day the earning was earned. A row without it has not been earned yet.</small></label><label class="pycfg-field" style="grid-column:span 2"><span>Project field</span><input class="pycfg-input" data-rule="project" value="${esc(draft.project)}" placeholder="Optional, such as project_id" spellcheck="false"><small class="pycfg-help">Carries the row's project onto the earning.</small></label>`
            : `<label class="pycfg-field"><span>Period</span><select class="pycfg-select" data-rule="period" data-pay-rerender>${optionsMarkup(PAY_PERIODS, draft.period)}</select><small class="pycfg-help">Earned on the period's last day, once that day is over.</small></label>${draft.period === 'week' ? `<label class="pycfg-field"><span>Weeks start on</span><select class="pycfg-select" data-rule="week_starts">${optionsMarkup(WEEKDAYS.map((day, index) => [index, day]), draft.week_starts)}</select></label>` : ''}<label class="pycfg-check" style="grid-column:span 2;align-self:center"><input type="checkbox" data-rule="always" ${draft.always ? 'checked' : ''}><span><strong>Pay every period</strong><small>Even when no input has a row in it, as a salary does.</small></span></label>`}
          <label class="pycfg-field" style="grid-column:span 2"><span>Timezone for period boundaries</span><input class="pycfg-input" list="pycfgTimezoneOptions" data-rule="timezone" value="${esc(draft.timezone)}" placeholder="The payee's pay schedule decides"><datalist id="pycfgTimezoneOptions">${timezoneOptions(draft.timezone)}</datalist></label></div>
        <div class="pycfg-block"><div class="pycfg-block-head"><span><strong>Inputs</strong><small>The published data the formula may read. It can read nothing that is not declared here, and reads it with the permissions of whoever last saved the rule.</small></span><button class="pycfg-btn" type="button" data-rule-add-input ${draft.inputs.length >= 8 ? 'disabled' : ''}><i class="fas fa-plus"></i> Add input</button></div>${inputBlocks || '<div class="pycfg-help">No inputs. The rule reads no data, which suits a fixed amount paid every period.</div>'}<datalist id="pycfgPaySources">${PAY_SOURCE_HINTS.map((name) => `<option value="${name}"></option>`).join('')}</datalist></div>
        <div class="pycfg-block"><div class="pycfg-block-head"><span><strong>Parameters</strong><small>Numbers and switches a plan or a payee sets without touching the formula, such as a rate.</small></span><button class="pycfg-btn" type="button" data-rule-add-param><i class="fas fa-plus"></i> Add parameter</button></div>${parameterRows}</div>
        <div class="pycfg-block"><div class="pycfg-block-head"><span><strong>Formula</strong><small>The body of a function, run once per ${record ? 'record' : 'period'}.</small></span></div><textarea class="pycfg-textarea code" data-rule="code" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="return Math.round(unit.record.contract_cents * params.rate_bps / 10000);">${esc(draft.code)}</textarea><small class="pycfg-help">It sees <code>unit</code> (${record ? '<code>{ record, earned_at }</code>' : '<code>{ period: { key, from, through }, rows: { input: [...] } }</code>'}), <code>params</code>, <code>payee</code> and <code>shared</code>. Return whole cents, <code>{ amount_cents, key?, description?, details? }</code>, a list of those, or <code>null</code> for nothing. It cannot read the clock or fetch. If it throws, that ${record ? 'record' : 'period'} is left unresolved with the reason; it is never paid as zero.</small></div>
        <div class="pycfg-block"><div class="pycfg-block-head"><span><strong>When this version takes effect</strong><small>Rules keep every version. An earning is worked out with the version in effect on the day it was earned.</small></span></div><div class="pycfg-grid two"><label class="pycfg-field"><span>Effective from</span><input class="pycfg-input" type="date" data-rule="effective_from" data-pay-rerender value="${esc(draft.effective_from)}" required></label>${isNew ? '' : versionPickerMarkup(draft, rule)}</div>${effectiveNoteMarkup(draft, rule)}</div>
        <div class="pycfg-actions"><span class="pycfg-form-status" data-form-status></span><button class="pycfg-btn" type="button" data-pay-close>${(globalThis.PlatformLanguage?.htmlText("settings","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button class="pycfg-btn primary" type="submit"><i class="fas fa-floppy-disk"></i> ${isNew ? 'Create rule' : 'Save as a version'}</button></div>
      </form></section>`;
  }

  const controlValue = (scope, selector, current) => {
    const control = scope?.querySelector(selector);
    if (!control) return current;
    return control.type === 'checkbox' || control.type === 'radio' ? control.checked : control.value;
  };

  // Reads what is on screen back into the working copy, so the form can be drawn again without losing typing.
  function collectRuleDraft(form, draft){
    ['name', 'description', 'effective_from', 'grain', 'period', 'timezone', 'kind', 'earned_at', 'project', 'code'].forEach((key) => { draft[key] = controlValue(form, `[data-rule="${key}"]`, draft[key]); });
    draft.week_starts = Number(controlValue(form, '[data-rule="week_starts"]', draft.week_starts));
    draft.always = controlValue(form, '[data-rule="always"]', draft.always) === true;
    draft.inputs = [...form.querySelectorAll('[data-rule-input]')].map((block, index) => {
      const current = draft.inputs[index] || blankRuleInput();
      return {
        name:controlValue(block, '[data-in="name"]', current.name),
        provider:controlValue(block, '[data-in="provider"]', current.provider),
        export:controlValue(block, '[data-in="export"]', current.export),
        date:controlValue(block, '[data-in="date"]', current.date),
        limit:controlValue(block, '[data-in="limit"]', current.limit),
        primary:controlValue(block, '[data-in="primary"]', current.primary) === true,
        whereMode:current.whereMode,
        match:controlValue(block, '[data-in="match"]', current.match),
        whereJson:controlValue(block, '[data-in="whereJson"]', current.whereJson),
        rules:current.whereMode === 'json' ? current.rules : [...block.querySelectorAll('[data-in-cond]')].map((row) => ({ field:controlValue(row, '[data-c="field"]', ''), operator:controlValue(row, '[data-c="operator"]', 'equals'), value:controlValue(row, '[data-c="value"]', '') })),
        args:[...block.querySelectorAll('[data-in-arg]')].map((row) => ({ key:controlValue(row, '[data-a="key"]', ''), value:controlValue(row, '[data-a="value"]', '') }))
      };
    });
    draft.parameters = [...form.querySelectorAll('[data-rule-param]')].map((row) => ({ key:controlValue(row, '[data-p="key"]', ''), label:controlValue(row, '[data-p="label"]', ''), type:controlValue(row, '[data-p="type"]', 'number'), default:controlValue(row, '[data-p="default"]', '') }));
    return draft;
  }

  function collectPlanDraft(form, draft){
    ['name', 'description', 'effective_from'].forEach((key) => { draft[key] = controlValue(form, `[data-plan="${key}"]`, draft[key]); });
    const before = new Map(draft.rules.map((reference) => [reference.rule_id, reference]));
    draft.rules = [...form.querySelectorAll('[data-plan-rule]')].filter((row) => row.querySelector('[data-plan-include]')?.checked).map((row) => {
      const ruleId = text(row.dataset.planRule);
      if (!before.has(ruleId)) return { rule_id:ruleId, params:{} };
      const params = {};
      row.querySelectorAll('[data-plan-param]').forEach((control) => {
        const raw = text(control.value);
        if (raw === '') return;
        const type = control.dataset.paramType;
        const value = type === 'boolean' ? raw === 'true' : type === 'number' ? Number(raw) : type === 'text' ? raw : looseParse(raw);
        if (type === 'number' && !Number.isFinite(value)) return;
        params[control.dataset.planParam] = typeof value === 'object' ? raw : value;
      });
      return { rule_id:ruleId, params };
    });
    return draft;
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
      assignmentType:'all',
      section:'schedules',
      pay:{ loaded:false, loading:false, error:'', rules:[], plans:[] },
      payOpen:new Set(),
      payEditor:null
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
      return `<section class="pycfg-schedule-bar"><div class="pycfg-schedule-bar-head"><strong>${(globalThis.PlatformLanguage?.htmlText("settings","m_9cbe6bfc19fa8f","Pay schedules") ?? "Pay schedules")}</strong><button class="pycfg-btn primary pycfg-add-schedule" type="button" data-add-schedule ${String(state.addingSchedule ? 'disabled' : '')}><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_2503a15c876890"," New schedule") ?? " New schedule")}</button></div><div class="pycfg-schedule-scroll">${String(schedules.map((schedule) => `<button class="pycfg-schedule-choice ${!state.addingSchedule && schedule.id === state.selectedScheduleId ? 'active' : ''} ${schedule.status === 'archived' ? 'archived' : ''}" type="button" data-select-schedule="${esc(schedule.id)}"><i class="fas fa-calendar-days"></i><span><strong>${esc(schedule.name)}</strong><small>${esc(frequencyLabel(schedule))} · ${esc(delayLabel(schedule))}</small></span><span class="pycfg-count" title="${((v6) => globalThis.PlatformLanguage?.htmlText("settings","m_7ee15b229eba08",`${v6} assignments`,{v6}) ?? `${v6} assignments`)(schedulePolicyCount(schedule.id))}">${schedulePolicyCount(schedule.id)}</span></button>`).join(''))}</div></section>`;
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
        return `<button class="pycfg-picker-result ${key === selectedKey ? 'selected' : ''}" type="button" data-select-subject="${esc(key)}" ${fullyAssigned ? 'disabled' : ''}><span class="pycfg-subject-icon"><i class="fas ${subjectIcon(subject.type)}"></i></span><span class="pycfg-picker-copy"><strong>${esc(subject.label)}</strong><small>${esc(subjectTypeLabel(subject.type))}${subject.subtitle ? ` · ${esc(subject.subtitle)}` : ''}</small></span>${fullyAssigned ? `<span class="pycfg-picker-state">${(globalThis.PlatformLanguage?.htmlText("settings","m_38dd0cd687c5de","Fully assigned") ?? "Fully assigned")}</span>` : (key === selectedKey ? '<span class="pycfg-picker-check"><i class="fas fa-check"></i></span>' : '')}</button>`;
      }).join('');
      return `<div class="pycfg-picker"><input type="hidden" data-new-policy-subject value="${String(esc(selectedKey))}"><div class="pycfg-picker-selected"><span class="pycfg-subject-icon"><i class="fas ${String(subjectIcon(selectedSubject.type))}"></i></span><span><small>${(globalThis.PlatformLanguage?.htmlText("settings","m_ecefc9f177951e","Selected") ?? "Selected")}</small><strong>${String(esc(selectedSubject.label))}</strong></span><em>${String(esc(subjectTypeLabel(selectedSubject.type)))}</em></div><label class="pycfg-picker-search"><i class="fas fa-magnifying-glass"></i><input class="pycfg-input" data-assignment-search value="${String(esc(state.assignmentQuery))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("settings","m_6b61f6c918bae3","Search by name, email, role, crew, or company") ?? "Search by name, email, role, crew, or company")}"></label><div class="pycfg-picker-filters">${String(filters)}</div><div class="pycfg-picker-results">${String(results || `<div class="pycfg-picker-empty"><i class="fas fa-magnifying-glass"></i><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_4182a9b15ec365","No matching people or groups") ?? "No matching people or groups")}</span></div>`)}</div>${String(matches.length > visible.length ? `<div class="pycfg-picker-more">${((v0,v1) => globalThis.PlatformLanguage?.htmlText("settings","m_3d1fdecac7eb00",`Showing the first ${v0} of ${v1}. Refine your search to narrow the list.`,{v0,v1}) ?? `Showing the first ${v0} of ${v1}. Refine your search to narrow the list.`)(visible.length,matches.length)}</div>` : '')}</div>`;
    }

    function newAssignmentMarkup(schedule){
      const subject = availableSubject();
      if (!subject) return `<div class="pycfg-assignment-empty"><i class="fas fa-user-slash"></i><strong>${(globalThis.PlatformLanguage?.htmlText("settings","m_04ecac3086270f","No assignable people or groups") ?? "No assignable people or groups")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_fc7f9797b2eeb3","Workforce directories must be available before an assignment can be added.") ?? "Workforce directories must be available before an assignment can be added.")}</span></div>`;
      const selectedKey = subjectKey(subject.type, subject.id);
      state.newAssignmentSubjectKey = selectedKey;
      const usedKinds = usedKindsForSubject(subject);
      const firstKind = EARNING_KINDS.find(([kind]) => !usedKinds.has(kind))?.[0] || '*';
      return `<form class="pycfg-add-box" data-new-policy data-schedule-id="${String(esc(schedule.id))}"><div class="pycfg-add-box-head"><strong>${((v1) => globalThis.PlatformLanguage?.htmlText("settings","m_33a54b5d181801",`Add to ${v1}`,{v1}) ?? `Add to ${v1}`)(esc(schedule.name))}</strong><button class="pycfg-icon-btn" type="button" data-cancel-policy aria-label="${(globalThis.PlatformLanguage?.htmlText("settings","m_cbef679b21abb4","Cancel") ?? "Cancel")}"><i class="fas fa-xmark"></i></button></div>${String(assignmentPickerMarkup(subject))}<div class="pycfg-add-grid"><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_52a6d3b60d5b9d","Earning type") ?? "Earning type")}</span><select class="pycfg-select" data-policy-earning>${String(EARNING_KINDS.map(([kind,label]) => `<option value="${esc(kind)}" ${kind === firstKind ? 'selected' : ''} ${usedKinds.has(kind) ? 'disabled' : ''}>${esc(label)}${usedKinds.has(kind) ? ' · already assigned' : ''}</option>`).join(''))}</select></label><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_48cacd50d701d8","Recognition") ?? "Recognition")}</span><select class="pycfg-select" data-policy-timing><option value="">${(globalThis.PlatformLanguage?.htmlText("settings","m_e8b95430c3cd30","Schedule default") ?? "Schedule default")}</option><option value="worked">${(globalThis.PlatformLanguage?.htmlText("settings","m_12ee42c07782b8","When work is performed") ?? "When work is performed")}</option><option value="completed">${(globalThis.PlatformLanguage?.htmlText("settings","m_5eda8826a44a2d","When job is completed") ?? "When job is completed")}</option></select></label><label class="pycfg-field"><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_57c29b3ae2c29b","Clawback cap") ?? "Clawback cap")}</span><div class="pycfg-percent"><input class="pycfg-input" data-policy-clawback type="number" min="0" max="100" step="0.01" placeholder="${(globalThis.PlatformLanguage?.htmlText("settings","m_e8b95430c3cd30","Schedule default") ?? "Schedule default")}"><span>%</span></div></label></div><div class="pycfg-add-actions"><span class="pycfg-form-status" data-policy-status></span><button class="pycfg-btn" type="button" data-cancel-policy>${(globalThis.PlatformLanguage?.htmlText("settings","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button class="pycfg-btn primary" type="submit"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_d45b3331bcd9fc"," Add assignment") ?? " Add assignment")}</button></div></form>`;
    }

    function assignmentsPanelMarkup(schedule){
      const policies = state.policies.filter((policy) => policy.schedule_id === schedule.id).sort((left,right) => {
        const leftSubject = subjectForPolicy(left);
        const rightSubject = subjectForPolicy(right);
        return text(leftSubject.label).localeCompare(text(rightSubject.label)) || earningKindLabel(left.earning_kind).localeCompare(earningKindLabel(right.earning_kind));
      });
      return `<section class="pycfg-panel pycfg-assignments-panel"><header class="pycfg-panel-head"><span><small>${(globalThis.PlatformLanguage?.htmlText("settings","m_e426de72d66b56","Assigned to this schedule") ?? "Assigned to this schedule")}</small><strong>${String(policies.length)} ${String(policies.length === 1 ? 'assignment' : 'assignments')}</strong></span><div class="pycfg-panel-head-actions"><button class="pycfg-btn" type="button" data-add-assignment ${String(state.addingAssignment || schedule.status === 'archived' ? 'disabled' : '')}><i class="fas fa-user-plus"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_8803dece55359d"," Add") ?? " Add")}</button></div></header><div class="pycfg-assignments-body">${String(state.addingAssignment ? newAssignmentMarkup(schedule) : '')}${String(policies.length ? policies.map((policy) => assignmentRuleMarkup(subjectForPolicy(policy), policy)).join('') : (!state.addingAssignment ? `<div class="pycfg-assignment-empty"><i class="fas fa-users"></i><strong>${(globalThis.PlatformLanguage?.htmlText("settings","m_a14385e683eb0e","No one is assigned yet") ?? "No one is assigned yet")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_4db70f96e6fe6c","Add the company default, a person, role, crew, or subcontractor to use this pay schedule.") ?? "Add the company default, a person, role, crew, or subcontractor to use this pay schedule.")}</span></div>` : ''))}</div>${String(state.directoryWarning ? `<div class="pycfg-directory-warning"><i class="fas fa-triangle-exclamation"></i> ${esc(state.directoryWarning)}</div>` : '')}</section>`;
    }

    function workspaceMarkup(){
      if (state.addingSchedule) return `<div class="pycfg-workspace">${String(scheduleEditorMarkup({}, true))}<section class="pycfg-panel"><div class="pycfg-assignment-empty"><i class="fas fa-user-plus"></i><strong>${(globalThis.PlatformLanguage?.htmlText("settings","m_9e655b4d61d736","Create the schedule first") ?? "Create the schedule first")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("settings","m_80f9c4047bc4d9","Assignments can be added as soon as this pay schedule is saved.") ?? "Assignments can be added as soon as this pay schedule is saved.")}</span></div></section></div>`;
      const schedule = selectedSchedule();
      if (!schedule) return `<div class="pycfg-empty"><i class="fas fa-calendar-plus"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_ff3ff2e43e60cd","Create your first pay schedule, then assign the company, people, roles, crews, or subcontractors that should use it.") ?? "Create your first pay schedule, then assign the company, people, roles, crews, or subcontractors that should use it.")}<div style="margin-top:12px"><button class="pycfg-btn primary" type="button" data-add-schedule><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_759ca83743fa9e"," Create pay schedule") ?? " Create pay schedule")}</button></div></div>`;
      return `<div class="pycfg-workspace">${scheduleEditorMarkup(schedule)}${assignmentsPanelMarkup(schedule)}</div>`;
    }

    function headerMarkup(){
      return `<header class="pycfg-head"><div><h3>${(globalThis.PlatformLanguage?.htmlText("settings","m_8c72678ac87916","Payroll setup") ?? "Payroll setup")}</h3><p>${(globalThis.PlatformLanguage?.htmlText("settings","m_7566916532f7f0","Create each pay schedule, then choose exactly who and which earnings should use it.") ?? "Create each pay schedule, then choose exactly who and which earnings should use it.")}</p></div><div class="pycfg-head-actions">${String(onBack ? `<button class="pycfg-btn" type="button" data-payroll-settings-back><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_a1209799a6f896"," Back to payroll") ?? " Back to payroll")}</button>` : '')}<button class="pycfg-btn" type="button" data-refresh ${String(state.loading ? 'disabled' : '')}><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_4f524800833039"," Refresh") ?? " Refresh")}</button></div></header>`;
    }

    function render(){
      if (destroyed) return;
      if (!orgId) {
        host.innerHTML = `<div class="pycfg">${String(headerMarkup())}<div class="pycfg-empty"><i class="fas fa-building-circle-exclamation"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_662d9ef90761e2","An organization is required to configure payroll.") ?? "An organization is required to configure payroll.")}</div></div>`;
        bind();
        return;
      }
      if (state.loading) {
        host.innerHTML = `<div class="pycfg">${String(headerMarkup())}<div class="pycfg-loading"><i class="fas fa-spinner fa-spin"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_27a9f695941148"," Loading payroll configuration...") ?? " Loading payroll configuration...")}</div></div>`;
        bind();
        return;
      }
      if (state.error) {
        host.innerHTML = `<div class="pycfg">${String(headerMarkup())}<div class="pycfg-empty"><i class="fas fa-triangle-exclamation"></i>${String(esc(state.error))}<div style="margin-top:12px"><button class="pycfg-btn" type="button" data-retry><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_cbfbb44ff35f0f"," Try again") ?? " Try again")}</button></div></div></div>`;
        bind();
        host.querySelector('[data-retry]')?.addEventListener('click', () => load(true));
        return;
      }
      ensureSelectedSchedule();
      const notice = state.notice ? `<div class="pycfg-notice ${state.noticeTone === 'bad' ? 'bad' : ''}">${esc(state.notice)}</div>` : '';
      host.innerHTML = `<div class="pycfg">${headerMarkup()}${sectionNavMarkup()}${state.section === 'pay' ? `${notice}<main>${paySectionMarkup()}</main>` : `${scheduleBarMarkup()}${notice}<main>${workspaceMarkup()}</main>`}</div>`;
      bind();
      if (state.section === 'pay') bindPay();
    }

    function sectionNavMarkup(){
      return `<nav class="pycfg-nav" aria-label="Payroll setup">${[['schedules', 'Pay schedules'], ['pay', 'Pay plans and rules']].map(([id, label]) => `<button class="${state.section === id ? 'active' : ''}" type="button" data-pay-section="${id}" aria-current="${state.section === id ? 'page' : 'false'}">${label}</button>`).join('')}</nav>`;
    }

    function payItem(kind, id){
      return (kind === 'plan' ? state.pay.plans : state.pay.rules).find((item) => item.id === id) || null;
    }

    function sortedPayItems(items){
      return [...items].sort((left, right) => (left.status === 'archived') - (right.status === 'archived') || text(left.name).localeCompare(text(right.name)));
    }

    function paySectionMarkup(){
      if (state.pay.loading && !state.pay.loaded) return `<div class="pycfg-loading"><i class="fas fa-spinner fa-spin"></i> Loading pay plans and pay rules...</div>`;
      if (state.pay.error && !state.pay.loaded) return `<div class="pycfg-empty"><i class="fas fa-triangle-exclamation"></i>${esc(state.pay.error)}<div style="margin-top:12px"><button class="pycfg-btn" type="button" data-pay-retry><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_cbfbb44ff35f0f"," Try again") ?? " Try again")}</button></div></div>`;
      const editor = state.payEditor;
      if (editor) return editor.kind === 'plan' ? planEditorMarkup(editor.draft, payItem('plan', editor.draft.id), state.pay.rules) : ruleEditorMarkup(editor.draft, payItem('rule', editor.draft.id));
      const plans = sortedPayItems(state.pay.plans);
      const rules = sortedPayItems(state.pay.rules);
      return `${state.pay.error ? `<div class="pycfg-notice bad">${esc(state.pay.error)}</div>` : ''}
        <section class="pycfg-section" data-pay-list="plans"><div class="pycfg-toolbar"><div class="pycfg-toolbar-copy"><strong>Pay plans</strong><span>A plan is a named group of pay rules with the rates it sets, so the same pay can be given to many people. Who is on which plan is set up separately.</span></div><button class="pycfg-btn primary" type="button" data-pay-new="plan"><i class="fas fa-plus"></i> New plan</button></div>
          <div class="pycfg-list">${plans.map((plan) => planCardMarkup(plan, state.pay.rules, state.payOpen.has(`plan:${plan.id}`))).join('') || '<div class="pycfg-empty"><i class="fas fa-layer-group"></i>No pay plans yet. Group pay rules into a plan to pay the same way for many people.</div>'}</div></section>
        <section class="pycfg-section" data-pay-list="rules"><div class="pycfg-toolbar"><div class="pycfg-toolbar-copy"><strong>Pay rules</strong><span>A rule is one formula over published data. It says what was earned and on which day. Earnings are worked out from the rules at each refresh.</span></div><button class="pycfg-btn primary" type="button" data-pay-new="rule"><i class="fas fa-plus"></i> New rule</button></div>
          <div class="pycfg-list">${rules.map((rule) => ruleCardMarkup(rule, state.payOpen.has(`rule:${rule.id}`))).join('') || '<div class="pycfg-empty"><i class="fas fa-calculator"></i>No pay rules yet. A rule pays hours, a commission, a salary or committed labor.</div>'}</div></section>`;
    }

    function collectPayEditor(){
      const editor = state.payEditor;
      const form = host.querySelector('[data-pay-form]');
      if (!editor || !form) return null;
      if (editor.kind === 'plan') collectPlanDraft(form, editor.draft);
      else collectRuleDraft(form, editor.draft);
      return form;
    }

    function openPayEditor(kind, item, copy = false){
      const version = versionInfo(item).shown;
      const draft = kind === 'plan' ? planDraft(item, version) : ruleDraft(item, version);
      if (copy) Object.assign(draft, { id:'', revision:0, status:'active', based_on:'', name:`Copy of ${draft.name}` });
      state.payEditor = { kind, draft };
      setNotice('');
      render();
      host.querySelector('[data-pay-form] input')?.focus();
    }

    async function loadPay(force = false){
      if (destroyed || !orgId) return;
      if (state.pay.loading || (state.pay.loaded && !force)) return;
      const pay = root.PayrollAPI?.pay;
      state.pay.loading = true;
      state.pay.error = '';
      if (!state.pay.loaded && state.section === 'pay' && !state.loading) render();
      try {
        if (typeof pay?.rules !== 'function' || typeof pay?.plans !== 'function') throw new Error('Pay rules and pay plans are not available here.');
        const [rules, plans] = await Promise.all([pay.rules(orgId), pay.plans(orgId)]);
        state.pay.rules = rows(rules, 'rules', 'pay_rules').map((item) => ({ ...object(item) })).filter((item) => item.id);
        state.pay.plans = rows(plans, 'plans', 'pay_plans').map((item) => ({ ...object(item) })).filter((item) => item.id);
        state.pay.loaded = true;
      } catch(error) {
        state.pay.error = error?.message || 'Could not load pay plans and pay rules.';
      }
      state.pay.loading = false;
      if (!destroyed && state.section === 'pay' && !state.loading) render();
    }

    async function savePayEditor(form){
      const editor = state.payEditor;
      if (!editor) return;
      const plan = editor.kind === 'plan';
      const noun = plan ? 'Pay plan' : 'Pay rule';
      collectPayEditor();
      let payload;
      try {
        payload = plan ? planPayload(editor.draft) : rulePayload(editor.draft);
        if (plan) {
          const missing = editor.draft.rules.find((reference) => !payItem('rule', reference.rule_id));
          if (missing) throw new Error(`Take ${missing.rule_id} out of the plan. That rule no longer exists.`);
        }
      } catch(error) {
        formBusy(form, false, error?.message || 'This cannot be saved yet.', true);
        return;
      }
      try {
        const pay = root.PayrollAPI?.pay;
        if (typeof pay?.saveRule !== 'function' || typeof pay?.savePlan !== 'function') throw new Error('Pay rules and pay plans cannot be saved here.');
        formBusy(form, true, `Saving ${noun.toLowerCase()}...`);
        const saved = await (plan ? pay.savePlan(orgId, payload) : pay.saveRule(orgId, payload));
        const backdated = payload.effective_from < localToday();
        state.payEditor = null;
        if (saved?.id) state.payOpen.add(`${editor.kind}:${saved.id}`);
        setNotice(`${noun} saved from ${formatDay(payload.effective_from)}. ${backdated ? 'That date is in the past: the next earnings refresh works those earnings out again and posts any difference as a correction.' : 'Earnings follow it at the next earnings refresh.'}`);
        await loadPay(true);
        toast((globalThis.PlatformLanguage?.text("settings","m_4bb4688766e904","Saved") ?? "Saved"), `${noun} saved.`, true);
      } catch(error) {
        if (state.payEditor) formBusy(form, false, error?.message || `Could not save this ${noun.toLowerCase()}.`, true);
        else { setNotice(error?.message || 'Could not reload pay plans and pay rules.', 'bad'); render(); }
      }
    }

    async function archivePayItem(kind, id, button){
      const item = payItem(kind, id);
      const pay = root.PayrollAPI?.pay;
      if (!item) return;
      const noun = kind === 'plan' ? 'pay plan' : 'pay rule';
      if (!root.confirm(`Archive ${text(item.name, id)}? It is no longer offered for new ${kind === 'plan' ? 'pay setups' : 'plans and pay setups'}. Anyone already paid by it keeps being paid by it until it is taken off them.`)) return;
      try {
        button.disabled = true;
        const archive = kind === 'plan' ? pay?.archivePlan : pay?.archiveRule;
        if (typeof archive !== 'function') throw new Error(`A ${noun} cannot be archived here.`);
        await archive(orgId, id, Number(item.revision || 0) || undefined);
        setNotice(`${kind === 'plan' ? 'Pay plan' : 'Pay rule'} archived.`);
        await loadPay(true);
        toast((globalThis.PlatformLanguage?.text("settings","m_26b28a86126a93","Archived") ?? "Archived"), `${kind === 'plan' ? 'Pay plan' : 'Pay rule'} archived.`, true);
      } catch(error) {
        setNotice(error?.message || `Could not archive this ${noun}.`, 'bad');
        render();
      }
    }

    function bindPay(){
      host.querySelector('[data-pay-retry]')?.addEventListener('click', () => loadPay(true));
      host.querySelectorAll('[data-pay-card]').forEach((card) => card.addEventListener('toggle', () => {
        if (card.open) state.payOpen.add(card.dataset.payCard);
        else state.payOpen.delete(card.dataset.payCard);
      }));
      host.querySelectorAll('[data-pay-new]').forEach((button) => button.addEventListener('click', () => openPayEditor(button.dataset.payNew, null)));
      host.querySelectorAll('[data-pay-edit]').forEach((button) => button.addEventListener('click', () => openPayEditor(button.dataset.payKind, payItem(button.dataset.payKind, button.dataset.payId))));
      host.querySelectorAll('[data-pay-copy]').forEach((button) => button.addEventListener('click', () => openPayEditor(button.dataset.payKind, payItem(button.dataset.payKind, button.dataset.payId), true)));
      host.querySelectorAll('[data-pay-archive]').forEach((button) => button.addEventListener('click', () => archivePayItem(button.dataset.payKind, button.dataset.payId, button)));
      host.querySelectorAll('[data-pay-close]').forEach((button) => button.addEventListener('click', () => { state.payEditor = null; render(); }));
      const form = host.querySelector('[data-pay-form]');
      const editor = state.payEditor;
      if (!form || !editor) return;
      const draft = editor.draft;
      // Anything that adds, removes or reshapes controls reads the form into the working copy first, then draws it again.
      const redraw = (change) => { collectPayEditor(); change?.(); render(); };
      form.addEventListener('submit', (event) => { event.preventDefault(); savePayEditor(form); });
      form.addEventListener('change', (event) => {
        const control = event.target;
        if (control.matches('[data-pay-base]')) {
          const item = payItem(editor.kind, draft.id);
          const version = array(item?.versions).find((entry) => text(entry?.effective_from) === control.value);
          if (!version) return;
          const effective = controlValue(form, `[data-${editor.kind}="effective_from"]`, draft.effective_from);
          editor.draft = { ...(editor.kind === 'plan' ? planDraft(item, version) : ruleDraft(item, version)), effective_from:effective };
          render();
        } else if (control.matches('[data-plan-include]')) {
          redraw();
        } else if (control.matches('[data-pay-rerender]')) {
          redraw(() => {
            if (editor.kind === 'rule' && draft.grain !== 'period' && draft.inputs.length && !draft.inputs.some((input) => input.primary)) draft.inputs[0].primary = true;
          });
        }
      });
      form.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button || !form.contains(button) || editor.kind !== 'rule') return;
        const data = button.dataset;
        const inputIndex = Number(button.closest('[data-rule-input]')?.dataset.ruleInput);
        const indexIn = (selector) => [...(button.closest('[data-rule-input]') || form).querySelectorAll(selector)].indexOf(button.closest(selector));
        if (data.ruleAddInput !== undefined) redraw(() => { if (draft.inputs.length < 8) draft.inputs.push(blankRuleInput(draft.grain !== 'period' && !draft.inputs.some((input) => input.primary))); });
        else if (data.ruleRemoveInput !== undefined) redraw(() => { draft.inputs.splice(inputIndex, 1); });
        else if (data.inAddCond !== undefined) redraw(() => { draft.inputs[inputIndex]?.rules.push({ field:'', operator:'equals', value:'' }); });
        else if (data.inRemoveCond !== undefined) { const index = indexIn('[data-in-cond]'); redraw(() => { draft.inputs[inputIndex]?.rules.splice(index, 1); }); }
        else if (data.inAddArg !== undefined) redraw(() => { draft.inputs[inputIndex]?.args.push({ key:'', value:'' }); });
        else if (data.inRemoveArg !== undefined) { const index = indexIn('[data-in-arg]'); redraw(() => { draft.inputs[inputIndex]?.args.splice(index, 1); }); }
        else if (data.ruleAddParam !== undefined) redraw(() => { draft.parameters.push({ key:'', label:'', type:'number', default:'' }); });
        else if (data.ruleRemoveParam !== undefined) { const index = indexIn('[data-rule-param]'); redraw(() => { draft.parameters.splice(index, 1); }); }
        else if (data.inWhereMode) {
          collectPayEditor();
          const input = draft.inputs[inputIndex];
          if (!input) return;
          try {
            if (data.inWhereMode === 'json') {
              const where = ruleInputWhere(input, 'Filter');
              Object.assign(input, { whereMode:'json', whereJson:where === undefined ? '' : JSON.stringify(where, null, 2) });
            } else {
              const flat = flatWhere(ruleInputWhere(input, 'Filter'));
              if (!flat) throw new Error('This filter has nested groups, so it stays as JSON.');
              Object.assign(input, { whereMode:'rules', match:flat.match, rules:flat.rules, whereJson:'' });
            }
            render();
          } catch(error) {
            formBusy(form, false, error?.message || 'That filter cannot be converted.', true);
          }
        }
      });
    }

    function formBusy(form, busy, message = '', bad = false){
      form.querySelectorAll('input,select,textarea,button').forEach((control) => {
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
      host.querySelector('[data-refresh]')?.addEventListener('click', () => { collectPayEditor(); load(true); });
      host.querySelectorAll('[data-pay-section]').forEach((button) => button.addEventListener('click', () => {
        const next = button.dataset.paySection === 'pay' ? 'pay' : 'schedules';
        if (next === state.section) return;
        // Typing in an open rule or plan form survives a look at the schedules.
        collectPayEditor();
        state.section = next;
        state.addingSchedule = false;
        state.addingAssignment = false;
        setNotice('');
        render();
        if (next === 'pay') loadPay();
      }));
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
        bindCadence(form, state.schedules.find((schedule) => schedule.id === scheduleId));
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
      const directory=(await platform.publication.invoke(orgId,'payroll.directory.read',{scope:'organization',organizationId:orgId},{})).value;
      const accessResult={status:'fulfilled',value:{roles:directory.roles}},usersResult={status:'fulfilled',value:{users:directory.users}},groupsResult={status:'fulfilled',value:{resource_groups:directory.resource_groups}},connectionsResult={status:'fulfilled',value:{connections:directory.connections}};
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
      // Pay plans and rules load beside the schedules and fail on their own, so one never hides the other.
      loadPay(force);
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

  // payDates and describeRecurrence are exposed so tests can hold them against the server's payrollPayDates.
  root.FirstMatePayrollSettings = { mount, payDates, describeRecurrence:recurrenceSummary };
})(window);
