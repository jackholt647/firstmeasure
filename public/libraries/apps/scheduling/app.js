/* public/libraries/apps/scheduling/app.js
 * Dashboard tab: calendar plus branch-configurable appointment groups.
 */
(function(){
  if (!window.Portal) return;

  const cfg = window.Portal.cfg || {};
  const { injectCSS, escapeHtml } = window.Portal.util;
  const { showToast } = window.Portal.ui;

  let rootEl = null;
  let viewMode = 'week';
  let anchorDate = new Date();
  let loading = false;
  let schedulingConfig = null;
  let dashboardConfig = null;
  let users = [];
  let projects = [];
  let events = [];
  let allEvents = [];
  let collapsedGroups = {};
  let breakdownMode = 'user';
  let breakdownValue = 'all';
  let filterMenuOpen = false;
  let modeMenuOpen = false;
  let appointmentScheduleDraft = null;
  let appointmentScheduleProjectId = '';
  let appointmentScheduleEventId = '';
  let appointmentScheduleMenuEventId = '';
  let appointmentScheduleLiveTravel = true;
  let appointmentScheduleLockTime = true;
  let appointmentScheduleScrollLeft = 0;
  let appointmentScheduleScrollTop = 0;
  let loadQueued = false;
  let loadTimer = null;
  let lastLoadFailedAt = 0;

  const css = `
    .dash-shell{height:100%;min-height:0;display:flex;flex-direction:column;background:#eef2f6;color:#101828}
    .dash-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;border-bottom:1px solid rgba(15,23,42,.08);background:#f8fafc}
    .dash-title{margin:0;font-size:22px;font-weight:1000;color:#101828}
    .dash-sub{margin:3px 0 0;font-size:12px;font-weight:800;color:#667085}
    .dash-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .dash-btn{height:36px;border:1px solid rgba(15,23,42,.12);border-radius:11px;background:#fff;color:#344054;padding:0 12px;font-weight:950;display:inline-flex;align-items:center;gap:7px;cursor:pointer}
    .dash-btn:hover{border-color:rgba(15,23,42,.24);background:#f8fafc}
    .dash-btn.active{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
    .dash-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 266px;gap:16px;padding:14px 18px 18px;overflow:hidden}
    .dash-body.schedule-mode{grid-template-columns:minmax(0,1fr) 320px}
    .dash-left,.dash-right{min-height:0;overflow:auto}
    .dash-body.schedule-mode .dash-left{display:flex;flex-direction:column;overflow:hidden}
    .dash-body.schedule-mode .dash-stats-row{flex:0 0 auto}
    .dash-stats-row{--dash-mode-col:58px;--dash-stat-gap:10px;display:grid;grid-template-columns:var(--dash-mode-col) repeat(5,minmax(0,1fr));gap:var(--dash-stat-gap);margin-bottom:12px;align-items:stretch;position:relative}
    .dash-filter-card{display:contents}
    .dash-mode-wrap,.dash-value-wrap{position:relative;min-width:0}
    .dash-mode-btn{width:100%;aspect-ratio:1/1;border:1px solid rgba(15,23,42,.10);border-radius:14px;background:#fff;color:#344054;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:15px}
    .dash-mode-btn:hover,.dash-filter-select:hover{border-color:rgba(15,23,42,.22);background:#f8fafc}
    .dash-mode-menu{position:absolute;left:0;top:calc(100% + 8px);width:180px;background:#fff;border:1px solid rgba(15,23,42,.10);border-radius:14px;box-shadow:0 20px 50px rgba(15,23,42,.16);z-index:35;padding:6px}
    .dash-mode-option{width:100%;height:36px;border:0;border-radius:10px;background:transparent;color:#344054;display:flex;align-items:center;gap:10px;padding:0 10px;font-size:12px;font-weight:1000;cursor:pointer;text-align:left}
    .dash-mode-option i{width:16px;text-align:center;color:var(--primary-readable,var(--primary,#d93025))}
    .dash-mode-option:hover{background:#f8fafc}
    .dash-mode-option.active{background:rgba(var(--primary-rgb),.08);color:var(--primary-readable,var(--primary,#d93025))}
    .dash-filter-select{height:100%;min-height:58px;width:100%;border:1px solid rgba(15,23,42,.12);border-radius:14px;background:#fff;color:#101828;font-size:12px;font-weight:1000;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 12px;cursor:pointer;min-width:0}
    .dash-filter-select span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dash-filter-menu{position:absolute;left:calc(var(--dash-mode-col) + var(--dash-stat-gap));top:calc(100% + 8px);right:0;max-height:360px;overflow:auto;background:#fff;border:1px solid rgba(15,23,42,.10);border-radius:16px;box-shadow:0 24px 70px rgba(15,23,42,.18);z-index:30;padding:8px 0}
    .dash-filter-table{display:grid;gap:2px;min-width:640px}
    .dash-filter-row{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:var(--dash-stat-gap);align-items:center;padding:9px 0;border-radius:11px;border:0;background:transparent;color:#344054;text-align:left;font:inherit;cursor:pointer}
    .dash-filter-row.header{cursor:default;color:#667085;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em}
    .dash-filter-row:not(.header):hover{background:#f8fafc}
    .dash-filter-row.active{background:rgba(var(--primary-rgb),.08);color:var(--primary-readable,var(--primary,#d93025))}
    .dash-filter-statcell{min-width:0;display:flex;align-items:center;justify-content:center;gap:8px;padding:0 12px}
    .dash-filter-statcell:first-child{justify-content:flex-start}
    .dash-filter-name{font-weight:1000;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dash-filter-name i{width:16px;text-align:center;margin-right:8px;color:var(--primary-readable,var(--primary,#d93025));flex-shrink:0}
    .dash-filter-cell{font-size:12px;font-weight:950;text-align:center;white-space:nowrap;margin:0 auto}
    .dash-stats{display:contents}
    .dash-stat{border:1px solid rgba(15,23,42,.08);border-radius:14px;background:#fff;padding:10px 12px;display:flex;align-items:center;gap:10px;min-width:0;min-height:58px}
    .dash-stat i{width:28px;height:28px;border-radius:10px;background:rgba(var(--primary-rgb),.09);color:var(--primary-readable,var(--primary,#d93025));display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0}
    .dash-stat small{display:block;font-size:10px;font-weight:1000;color:#667085;text-transform:uppercase;letter-spacing:.04em}
    .dash-stat strong{display:block;font-size:16px;font-weight:1000;color:#101828;line-height:1.1;margin-top:2px}
    .dash-card{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:18px;overflow:hidden}
    .dash-schedule-card{flex:1;min-height:0;padding:12px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px}
    .dash-schedule-view{flex:1;min-height:0}
    .dash-schedule-view .psv-wrap{min-height:0}
    .dash-schedule-actions{flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;gap:12px}
    .dash-week{display:grid;grid-template-columns:58px repeat(7,minmax(82px,1fr));width:100%;min-width:0}
    .dash-week-head,.dash-time-head{min-height:92px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:stretch;justify-content:center;background:#fff;min-width:0}
    .dash-day-head{display:flex;flex-direction:column;text-align:center;padding:8px 6px;min-width:0;width:100%}
    .dash-day-head-title{font-size:12px;font-weight:1000;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-bottom:7px;border-bottom:1px solid rgba(15,23,42,.10)}
    .dash-head-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0;margin-top:7px;min-width:0}
    .dash-head-stat{display:flex;align-items:center;justify-content:center;gap:5px;font-size:10px;font-weight:1000;color:#475467;min-width:0;padding:2px 3px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:1px solid rgba(15,23,42,.10)}
    .dash-head-stat:nth-child(2n+1){border-left:0}
    .dash-head-stat i{font-size:10px;color:var(--primary-readable,var(--primary,#d93025));flex-shrink:0}
    .dash-head-stat span{min-width:0;overflow:hidden;text-overflow:ellipsis}
    .dash-time-cell{height:72px;border-right:1px solid rgba(15,23,42,.08);border-bottom:1px solid rgba(15,23,42,.06);font-size:11px;font-weight:900;color:#98a2b3;display:flex;align-items:flex-start;justify-content:center;padding-top:7px;background:#fff}
    .dash-day-cell{height:72px;border-right:1px solid rgba(15,23,42,.06);border-bottom:1px solid rgba(15,23,42,.06);position:relative;background:#fff;overflow:visible}
    .dash-day-cell:nth-child(8n){border-right:0}
    .dash-event{position:absolute;left:5px;right:5px;z-index:8;border-radius:10px;background:#e0ecff;border-left:4px solid #2563eb;color:#1e3a8a;padding:5px 7px;font-size:11px;font-weight:900;line-height:1.22;overflow:hidden;cursor:pointer;box-shadow:0 8px 16px rgba(37,99,235,.12);box-sizing:border-box}
    .dash-event-title,.dash-event-assigned,.dash-event-address{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dash-event-assigned{color:#344054;font-weight:900;margin-top:2px}
    .dash-event-address{color:#667085;font-weight:800;margin-top:2px}
    .dash-month{display:grid;grid-template-columns:54px repeat(7,minmax(78px,1fr));width:100%;min-width:0}
    .dash-month-head,.dash-week-stat-head{height:38px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid rgba(15,23,42,.08);font-size:12px;font-weight:1000;color:#667085;background:#fff}
    .dash-week-stat{min-height:122px;border-right:1px solid rgba(15,23,42,.08);border-bottom:1px solid rgba(15,23,42,.06);background:#fbfcfe;padding:8px 4px;display:flex;flex-direction:column;justify-content:center;gap:7px;min-width:0}
    .dash-mini-stat{display:flex;align-items:center;justify-content:center;gap:5px;font-size:11px;font-weight:1000;color:#344054;position:relative}
    .dash-mini-stat i{font-size:10px;color:var(--primary-readable,var(--primary,#d93025))}
    .dash-month-day{min-height:122px;border-right:1px solid rgba(15,23,42,.06);border-bottom:1px solid rgba(15,23,42,.06);padding:8px;background:#fff;position:relative;cursor:pointer}
    .dash-month-day:nth-child(8n){border-right:0}
    .dash-month-day.muted{background:#f8fafc;cursor:default}
    .dash-month-num{font-size:12px;font-weight:1000;color:#344054;margin-bottom:8px}
    .dash-month-day.muted .dash-month-num{color:#c0c7d1}
    .dash-day-stats{display:grid;gap:5px}
    .dash-day-stat{display:flex;align-items:center;justify-content:space-between;gap:5px;font-size:10px;font-weight:900;color:#475467;min-width:0}
    .dash-day-stat span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
    .dash-day-stat b{font-weight:1000;color:#101828}
    .dash-future-count{position:absolute;right:9px;bottom:8px;color:var(--primary-readable,var(--primary,#d93025));font-size:12px;font-weight:1000}
    .dash-day-list{display:grid;gap:10px}
    .dash-list-event{border:1px solid rgba(15,23,42,.08);border-radius:16px;background:#fff;padding:14px;display:grid;grid-template-columns:96px 1fr auto;gap:14px;align-items:center;cursor:pointer}
    .dash-list-time{font-size:12px;font-weight:1000;color:#1d4ed8}
    .dash-list-title{font-size:14px;font-weight:1000;color:#101828}
    .dash-list-meta{font-size:12px;font-weight:800;color:#667085;margin-top:2px}
    .dash-empty{border:1px dashed rgba(15,23,42,.18);border-radius:18px;background:#fff;padding:24px;text-align:center;color:#667085;font-weight:850}
    .dash-groups{display:flex;flex-direction:column;gap:12px}
    .dash-group{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:16px;overflow:hidden}
    .dash-group-head{width:100%;border:0;background:#fff;padding:13px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;color:#101828}
    .dash-group-head strong{font-size:13px;font-weight:1000}
    .dash-group-head span{font-size:11px;font-weight:1000;color:#667085}
    .dash-group-body{padding:0 14px 12px}
    .dash-group.collapsed .dash-group-body{display:none}
    .dash-appt-tile{border:0;background:transparent;width:100%;padding:11px 0;border-top:1px solid rgba(15,23,42,.07);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 12px;text-align:left;cursor:pointer;align-items:center}
    .dash-appt-tile.selected{position:relative;color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb),.07);border-radius:12px;padding-left:10px;padding-right:10px}
    .dash-appt-tile.selected:before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:999px;background:var(--primary,#d93025)}
    .dash-appt-tile.selected .dash-appt-title{color:var(--primary-readable,var(--primary,#d93025))}
    .dash-appt-tile.selected .dash-appt-sales,.dash-appt-tile.selected .dash-appt-address{color:#344054}
    .dash-appt-tile.selected .dash-stage-pill{background:rgba(var(--primary-rgb),.14);color:var(--primary-readable,var(--primary,#d93025))}
    .dash-appt-tile.unscheduled .dash-stage-pill{background:#f2f4f7;color:#667085}
    .dash-appt-tile.has-action{grid-template-columns:minmax(0,1fr) auto 26px;gap:4px 10px;padding:8px 0}
    .dash-appt-tile.has-action.selected{padding-left:10px;padding-right:10px}
    .dash-appt-tile.has-action .dash-appt-sales{grid-column:2/3;justify-self:end;text-align:right;max-width:92px}
    .dash-appt-tile.has-action .dash-appt-address{grid-column:1/3}
    .dash-appt-title{font-size:13px;font-weight:1000;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dash-appt-sales{font-size:11px;font-weight:950;color:#475467;white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis}
    .dash-appt-address{font-size:12px;font-weight:850;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dash-stage-pill{justify-self:end;border-radius:999px;background:rgba(var(--primary-rgb),.09);color:var(--primary-readable,var(--primary,#d93025));font-size:10px;font-weight:1000;padding:4px 8px;white-space:nowrap}
    .dash-appt-actions{grid-row:1/3;grid-column:3/4;justify-self:end;align-self:center;display:flex;flex-direction:column;gap:4px}
    .dash-appt-action{width:23px;height:23px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#667085;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:10px}
    .dash-appt-action:hover{background:#f8fafc;border-color:rgba(15,23,42,.22);color:#344054}
    .dash-modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.42);z-index:2400;display:flex;align-items:center;justify-content:center;padding:20px}
    .dash-modal{width:min(760px,94vw);max-height:min(720px,90vh);overflow:auto;background:#fff;border-radius:18px;box-shadow:0 24px 70px rgba(15,23,42,.28);border:1px solid rgba(15,23,42,.12)}
    .dash-modal-head{padding:16px 18px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
    .dash-modal-head h3{margin:0;font-size:18px;font-weight:1000;color:#101828}
    .dash-modal-body{padding:16px 18px 18px}
    .dash-modal-close{border:0;background:#f2f4f7;width:34px;height:34px;border-radius:10px;cursor:pointer;color:#344054}
    @media(max-width:1100px){
      .dash-body{grid-template-columns:1fr}.dash-right{overflow:visible}.dash-shell{height:auto}.dash-left{overflow:auto}
      .dash-stats-row{grid-template-columns:var(--dash-mode-col) repeat(5,minmax(110px,1fr));overflow-x:auto;padding-bottom:2px}
      .dash-filter-menu{left:calc(var(--dash-mode-col) + var(--dash-stat-gap));right:auto;width:650px}
    }
  `;

  function orgId(){ return String(cfg.userOrgId || cfg.orgId || '').trim(); }
  function branchId(){ return window.Portal.branchModules?.currentBranchId?.() || cfg.userBranchId || cfg.branchId || 'default'; }
  function startOfDay(date){ const d = new Date(date); d.setHours(0,0,0,0); return d; }
  function addDays(date, days){ const d = new Date(date); d.setDate(d.getDate() + days); return d; }
  function sameDay(a, b){ return startOfDay(a).getTime() === startOfDay(b).getTime(); }
  function weekStart(date){ const d = startOfDay(date); d.setDate(d.getDate() - d.getDay()); return d; }
  function monthStart(date){ return new Date(date.getFullYear(), date.getMonth(), 1); }
  function monthEnd(date){ return new Date(date.getFullYear(), date.getMonth() + 1, 1); }
  function fmtTime(date){ return date.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }); }
  function eventStart(event){ return window.PlatformScheduling.eventStart(event) || new Date(event.start_at || Date.now()); }
  function eventEnd(event){ return window.PlatformScheduling.eventEnd(event) || eventStart(event); }
  function eventProject(event){ return projects.find((project) => String(project.id) === String(event.project_id)) || {}; }
  function dayNumber(dateValue){
    const date = new Date(`${dateValue}T12:00:00`);
    return Number.isFinite(date.getTime()) ? date.getDay() : new Date().getDay();
  }
  function appointmentWindowForDate(dateValue){
    const availability = schedulingConfig?.availability || schedulingConfig?.scheduling?.availability || {};
    if (!availability.apply_limits_to_internal_users) return { start: '08:00', end: '18:00' };
    const globalStart = clean(availability.sales_appointment_start_time || '09:00') || '09:00';
    const globalEnd = clean(availability.sales_appointment_end_time || '17:00') || '17:00';
    const targetDay = dayNumber(dateValue);
    const workingHours = Array.isArray(availability.working_hours) ? availability.working_hours : [];
    const matching = workingHours.find((entry) => Array.isArray(entry?.days) && entry.days.map(Number).includes(targetDay));
    if (!matching) {
      return {
        start: globalStart,
        end: globalEnd,
        disabled: true,
        message: 'No slots available for this day because this day is turned off.'
      };
    }
    return {
      start: clean(matching.start || matching.start_time || globalStart) || globalStart,
      end: clean(matching.end || matching.end_time || globalEnd) || globalEnd,
    };
  }
  const FILTER_TYPES = {
    user: { label: 'User', icon: 'fa-user' },
    lead_source: { label: 'Lead Source', icon: 'fa-bullhorn' },
    city: { label: 'City', icon: 'fa-location-dot' },
  };
  function clean(value){ return String(value ?? '').trim(); }
  function norm(value){ return clean(value).toLowerCase(); }
  function addressKey(value){
    return clean(value).toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s#-]/g, '').trim();
  }
  function travelKey(origin, destination){
    return `${addressKey(origin)}=>${addressKey(destination)}`;
  }
  function projectTravelTimes(project){
    return (project && typeof project.travel_times === 'object' && project.travel_times) || {};
  }
  function dashboardTravelTimeCache(){
    const cache = {};
    projects.forEach((project) => {
      Object.entries(projectTravelTimes(project)).forEach(([key, value]) => {
        const minutes = Number(typeof value === 'object' && value ? value.minutes : value);
        if (key && Number.isFinite(minutes) && minutes > 0) cache[key] = minutes;
      });
    });
    return cache;
  }
  function projectMatchesAddress(project, address){
    return addressKey(project?.address || project?.project_address || '') === addressKey(address);
  }
  async function persistTravelTime({ key, origin, destination, minutes } = {}){
    const id = orgId();
    const mins = Math.max(1, Math.ceil(Number(minutes) || 0));
    if (!id || !key || !mins) return;
    const entry = {
      key,
      origin: clean(origin),
      destination: clean(destination),
      minutes: mins,
      source: 'google_distance_matrix',
      updated_at: new Date().toISOString(),
    };
    const candidates = projects.filter((project) => projectMatchesAddress(project, origin) || projectMatchesAddress(project, destination));
    const targetProjects = candidates.length ? candidates : (selectedScheduleProject() ? [selectedScheduleProject()] : []);
    await Promise.all(targetProjects.filter((project) => project?.id).map(async (project) => {
      const next = { ...projectTravelTimes(project), [key]: entry };
      project.travel_times = next;
      try {
        await window.PlatformAPI?.documents?.setField?.(id, 'projects', project.id, 'travel_times', next, {
          kind: 'project_travel_times',
          updated_by: 'dashboard_schedule',
        });
      } catch (error) {
        console.warn('Could not persist travel time cache', error);
      }
    }));
  }
  function userById(id){
    const key = norm(id);
    return users.find((user) => [user.id, user.user_id, user.email, user.name].some((value) => norm(value) === key)) || null;
  }
  function eventAssignedUsers(event){
    const rows = [];
    (Array.isArray(event.assigned_users) ? event.assigned_users : []).forEach((user) => {
      const id = clean(user.id || user.user_id || user.email || user.name);
      if (!id) return;
      rows.push({ id, label: clean(user.name || user.email || user.id) || id });
    });
    (Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : []).forEach((id) => {
      const text = clean(id);
      if (!text || rows.some((row) => norm(row.id) === norm(text))) return;
      const user = userById(text);
      rows.push({ id: text, label: clean(user?.name || user?.email || text) });
    });
    return rows;
  }
  function leadSource(project){
    const source = project?.lead_source || project?.leadSource || project?.source || project?.source_name || project?.lead?.source || project?.intake?.source || project?.origin?.source;
    return clean(source) || 'Unknown';
  }
  function projectCity(project){
    const comps = project?.components || project?.address_components || project?.addressComponents || {};
    const city = comps.locality || comps.city || comps.town || comps.municipality || project?.city;
    if (clean(city)) return clean(city);
    const parts = clean(project?.address).split(',').map((part) => part.trim()).filter(Boolean);
    return parts.length >= 2 ? parts[1] : 'Unknown';
  }
  function dimensionEntriesForEvent(event, type = breakdownMode){
    const project = eventProject(event);
    if (type === 'user') {
      const assigned = eventAssignedUsers(event);
      return assigned.length ? assigned : [{ id: 'unassigned', label: 'Unassigned' }];
    }
    if (type === 'lead_source') {
      const label = leadSource(project);
      return [{ id: norm(label) || 'unknown', label }];
    }
    const label = projectCity(project);
    return [{ id: norm(label) || 'unknown', label }];
  }
  function eventMatchesBreakdown(event){
    if (breakdownValue === 'all') return true;
    return dimensionEntriesForEvent(event, breakdownMode).some((entry) => norm(entry.id) === norm(breakdownValue));
  }
  function projectMatchesBreakdown(project){
    if (breakdownValue === 'all') return true;
    if (breakdownMode === 'lead_source') return norm(leadSource(project)) === norm(breakdownValue);
    if (breakdownMode === 'city') return norm(projectCity(project)) === norm(breakdownValue);
    return allEvents.some((event) => String(event.project_id) === String(project.id) && eventMatchesBreakdown(event));
  }
  function visibleEvents(){ return allEvents.filter(eventMatchesBreakdown); }
  function visibleProjects(){ return projects.filter(projectMatchesBreakdown); }
  function assignedLabel(event){
    const assigned = Array.isArray(event.assigned_users) ? event.assigned_users : [];
    if (assigned.length) return assigned.map((user) => user.name || user.email || user.id).filter(Boolean).join(', ');
    const ids = Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : [];
    return ids.length ? ids.join(', ') : 'Assign later';
  }
  function openProjectFromEvent(event){
    const project = eventProject(event);
    if (!project?.id) return;
    if (window.Portal.modules?.request?.openProject) window.Portal.modules.request.openProject(project);
    else window.dispatchEvent(new CustomEvent('fm:projects:open', { detail: { project } }));
  }
  function visibleTitle(){
    if (viewMode === 'day') return anchorDate.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    if (viewMode === 'month') return anchorDate.toLocaleDateString([], { month:'long', year:'numeric' });
    const start = weekStart(anchorDate);
    const end = addDays(start, 6);
    return `${start.toLocaleDateString([], { month:'short', day:'numeric' })} - ${end.toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' })}`;
  }
  function statDefs(){ return window.PlatformAPI.dashboard.normalizeConfig(dashboardConfig || {}).stats; }
  function statsFor(start, end, scopedEvents = visibleEvents(), scopedProjects = visibleProjects()){
    return window.PlatformAPI.dashboard.statsForRange({ projects: scopedProjects, events: scopedEvents, start, end });
  }
  function statValueHtml(stat, stats){
    return escapeHtml(window.PlatformAPI.dashboard.formatStatValue(stat.id, stats[stat.id]));
  }
  function dimensionLabel(){
    return FILTER_TYPES[breakdownMode]?.label || 'User';
  }
  function allDimensionLabel(){
    if (breakdownMode === 'lead_source') return 'All Lead Sources';
    if (breakdownMode === 'city') return 'All Cities';
    return 'All Users';
  }
  function dimensionIcon(){
    return FILTER_TYPES[breakdownMode]?.icon || 'fa-user';
  }
  function statValueText(stat, stats){
    return window.PlatformAPI.dashboard.formatStatValue(stat.id, stats[stat.id]);
  }
  function rangeEvents(start, end, source = allEvents){
    return source.filter((event) => {
      const d = eventStart(event);
      return d >= start && d < end;
    });
  }
  function dimensionRows(start, end){
    const baseEvents = rangeEvents(start, end, allEvents);
    const rows = new Map();
    baseEvents.forEach((event) => {
      dimensionEntriesForEvent(event, breakdownMode).forEach((entry) => {
        const id = clean(entry.id) || norm(entry.label) || 'unknown';
        if (!rows.has(id)) rows.set(id, { id, label: entry.label || id, events: [] });
        rows.get(id).events.push(event);
      });
    });
    const defs = statDefs();
    return [...rows.values()].map((row) => {
      const scopedProjectIds = new Set(row.events.map((event) => String(event.project_id)));
      const scopedProjects = projects.filter((project) => scopedProjectIds.has(String(project.id)) || (
        breakdownMode !== 'user' && row.events.some((event) => String(event.project_id) === String(project.id))
      ));
      const stats = statsFor(start, end, row.events, scopedProjects);
      return { ...row, stats, sortValue: Number(stats.appointments?.total || 0), defs };
    }).filter((row) => row.sortValue > 0).sort((a, b) => b.sortValue - a.sortValue || a.label.localeCompare(b.label));
  }
  function statTipHtml(stat, start, end){
    const rows = dimensionRows(start, end);
    const title = `${stat.label || stat.id} by ${dimensionLabel()}`;
    if (!rows.length) return `<div class="fm-tip-title">${escapeHtml(title)}</div><div>No data in this range.</div>`;
    return `
      <div class="fm-tip-title">${escapeHtml(title)}</div>
      ${rows.slice(0, 12).map((row) => `<div class="fm-tip-row"><span class="fm-tip-name">${escapeHtml(row.label)}</span><span class="fm-tip-value">${escapeHtml(statValueText(stat, row.stats))}</span></div>`).join('')}
    `;
  }
  function filterControlsHtml(start, end){
    const rows = dimensionRows(start, end);
    const selected = rows.find((row) => norm(row.id) === norm(breakdownValue));
    const defs = statDefs();
    const allStats = statsFor(start, end, allEvents, projects);
    const modeMeta = FILTER_TYPES[breakdownMode] || FILTER_TYPES.user;
    const rowCells = (label, stats) => `
      <span class="dash-filter-statcell"><span class="dash-filter-name"><i class="fas ${escapeHtml(modeMeta.icon)}"></i>${escapeHtml(label)}</span></span>
      ${defs.map((stat) => `<span class="dash-filter-statcell"><span class="dash-filter-cell">${escapeHtml(statValueText(stat, stats))}</span></span>`).join('')}
    `;
    return `
      <div class="dash-filter-card">
        <div class="dash-mode-wrap">
          <button type="button" class="dash-mode-btn" data-mode-menu-toggle aria-label="Choose dashboard breakdown"><i class="fas ${escapeHtml(modeMeta.icon)}"></i></button>
          ${modeMenuOpen ? `<div class="dash-mode-menu">${Object.entries(FILTER_TYPES).map(([id, meta]) => `<button type="button" class="dash-mode-option ${breakdownMode === id ? 'active' : ''}" data-breakdown-mode="${escapeHtml(id)}"><i class="fas ${escapeHtml(meta.icon)}"></i><span>${escapeHtml(meta.label)}</span></button>`).join('')}</div>` : ''}
        </div>
        <div class="dash-value-wrap">
          <button type="button" class="dash-filter-select" data-filter-menu-toggle><span>${escapeHtml(selected?.label || allDimensionLabel())}</span><i class="fas fa-chevron-${filterMenuOpen ? 'up' : 'down'}"></i></button>
        </div>
      </div>
      ${filterMenuOpen ? `
        <div class="dash-filter-menu">
          <div class="dash-filter-table">
            <button type="button" class="dash-filter-row ${breakdownValue === 'all' ? 'active' : ''}" data-breakdown-value="all">${rowCells(allDimensionLabel(), allStats)}</button>
            ${rows.map((row) => `<button type="button" class="dash-filter-row ${norm(breakdownValue) === norm(row.id) ? 'active' : ''}" data-breakdown-value="${escapeHtml(row.id)}">${rowCells(row.label, row.stats)}</button>`).join('')}
          </div>
        </div>
      ` : ''}
    `;
  }
  function rangeForView(){
    if (viewMode === 'appointment_schedule') return [startOfDay(anchorDate), addDays(anchorDate, 1)];
    if (viewMode === 'month') return [monthStart(anchorDate), monthEnd(anchorDate)];
    if (viewMode === 'day') return [startOfDay(anchorDate), addDays(anchorDate, 1)];
    const start = weekStart(anchorDate);
    return [start, addDays(start, 7)];
  }
  function nav(delta){
    if (viewMode === 'month') anchorDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + delta, 1);
    else anchorDate = addDays(anchorDate, viewMode === 'week' ? delta * 7 : delta);
    appointmentScheduleDraft = null;
    appointmentScheduleEventId = '';
    appointmentScheduleMenuEventId = '';
    render();
  }
  function primaryProjectContact(project = {}){
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    return contacts.find((contact) => contact?.primary) || contacts[0] || {};
  }
  function isEventTypeTitle(value, event = {}){
    const text = norm(value);
    if (!text) return false;
    return text === 'sales appointment'
      || text === 'sales_appointment'
      || text === norm(event.title)
      || text === norm(event.mapped_type?.label)
      || text === norm(event.event_type_id)
      || text === norm(event.type_id);
  }
  function projectTitle(project = {}, event = {}){
    const contact = primaryProjectContact(project);
    const candidates = [
      project.title,
      project.name,
      contact.name,
      project.customer_name,
      project.customer?.name,
      project.primary_contact_name,
      event.customer_name,
      event.project_title,
      project.address,
      event.project_address,
    ];
    const title = candidates.find((value) => clean(value) && !isEventTypeTitle(value, event));
    return clean(title) || 'Project';
  }
  function projectAddress(project, event){
    return project.address || event.project_address || 'No address yet';
  }
  function appointmentTile(item){
    const project = item.project || eventProject(item.event);
    const event = item.event || {};
    const stage = item.stage || project.mapped_stage || {};
    return `
      <button type="button" class="dash-appt-tile" data-event-id="${escapeHtml(event.id)}">
        <div class="dash-appt-title">${escapeHtml(projectTitle(project, event))}</div>
        <div class="dash-appt-sales">${escapeHtml(item.salesperson || assignedLabel(event))}</div>
        <div class="dash-appt-address">${escapeHtml(projectAddress(project, event))}</div>
        <div class="dash-stage-pill">${escapeHtml(stage.label || project.mapped_stage?.label || project.stage || 'Stage')}</div>
      </button>
    `;
  }
  function topStatsHtml(){
    const [start, end] = rangeForView();
    const stats = statsFor(start, end);
    return `<div class="dash-stats-row">${filterControlsHtml(start, end)}<div class="dash-stats">${statDefs().map((stat) => `
      <div class="dash-stat" data-stat-tip="${escapeHtml(stat.label || stat.id)}" data-stat-id="${escapeHtml(stat.id)}" data-stat-start="${start.toISOString()}" data-stat-end="${end.toISOString()}" tabindex="0">
        <i class="fas ${escapeHtml(stat.icon || 'fa-chart-simple')}"></i>
        <div><small>${escapeHtml(stat.label || stat.id)}</small><strong>${statValueHtml(stat, stats)}</strong></div>
      </div>
    `).join('')}</div></div>`;
  }
  function miniStatsHtml(stats, start, end){
    return statDefs().map((stat) => `<div class="dash-mini-stat" data-stat-tip="${escapeHtml(stat.label || stat.id)}" data-stat-id="${escapeHtml(stat.id)}" data-stat-start="${start.toISOString()}" data-stat-end="${end.toISOString()}" tabindex="0"><i class="fas ${escapeHtml(stat.icon || 'fa-chart-simple')}"></i><span>${statValueHtml(stat, stats)}</span></div>`).join('');
  }
  function dayStatsHtml(day){
    const start = startOfDay(day);
    const end = addDays(day, 1);
    const stats = statsFor(start, end);
    return `<div class="dash-day-stats">${statDefs().map((stat) => `<div class="dash-day-stat" data-stat-tip="${escapeHtml(stat.label || stat.id)}" data-stat-id="${escapeHtml(stat.id)}" data-stat-start="${start.toISOString()}" data-stat-end="${end.toISOString()}" tabindex="0"><span>${escapeHtml(stat.label || stat.id)}</span><b>${statValueHtml(stat, stats)}</b></div>`).join('')}</div>`;
  }
  function headerStatsHtml(day){
    const start = startOfDay(day);
    const end = addDays(day, 1);
    const stats = statsFor(start, end);
    const defs = statDefs();
    return `<div class="dash-head-stats">${defs.map((stat) => `<span class="dash-head-stat" data-stat-tip="${escapeHtml(stat.label || stat.id)}" data-stat-id="${escapeHtml(stat.id)}" data-stat-start="${start.toISOString()}" data-stat-end="${end.toISOString()}" tabindex="0"><i class="fas ${escapeHtml(stat.icon || 'fa-chart-simple')}"></i><span>${statValueHtml(stat, stats)}</span></span>`).join('')}</div>`;
  }
  function dayAppointmentCount(day){
    return visibleEvents().filter((event) => sameDay(eventStart(event), day)).length;
  }
  function weekEventLayout(day, hours){
    const firstHour = hours[0] || 8;
    const lastHour = hours[hours.length - 1] || 18;
    const visibleStart = firstHour * 60;
    const visibleEnd = (lastHour + 1) * 60;
    const items = events
      .filter((event) => sameDay(eventStart(event), day))
      .map((event) => {
        const start = eventStart(event);
        const end = eventEnd(event);
        const startMinute = start.getHours() * 60 + start.getMinutes();
        const fallbackEndMinute = startMinute + Math.max(15, Number(event.duration_minutes || 60));
        const endMinute = Number.isFinite(end.getTime()) && end > start
          ? end.getHours() * 60 + end.getMinutes()
          : fallbackEndMinute;
        return {
          event,
          startMinute,
          endMinute: Math.max(startMinute + 15, endMinute)
        };
      })
      .filter((item) => item.endMinute > visibleStart && item.startMinute < visibleEnd)
      .sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute);
    const layout = new Map();
    const flushCluster = (cluster) => {
      if (!cluster.length) return;
      const columns = [];
      cluster.forEach((item) => {
        let column = columns.findIndex((endMinute) => endMinute <= item.startMinute);
        if (column < 0) {
          column = columns.length;
          columns.push(0);
        }
        columns[column] = item.endMinute;
        item.column = column;
      });
      const columnCount = Math.max(1, columns.length);
      cluster.forEach((item) => layout.set(String(item.event.id || ''), { ...item, columnCount }));
    };
    let cluster = [];
    let clusterEnd = 0;
    items.forEach((item) => {
      if (!cluster.length || item.startMinute < clusterEnd) {
        cluster.push(item);
        clusterEnd = Math.max(clusterEnd, item.endMinute);
      } else {
        flushCluster(cluster);
        cluster = [item];
        clusterEnd = item.endMinute;
      }
    });
    flushCluster(cluster);
    return layout;
  }
  function renderMonth(){
    const first = monthStart(anchorDate);
    const gridStart = addDays(first, -first.getDay());
    const weeks = Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (_, day) => addDays(gridStart, week * 7 + day)));
    let html = `<div class="dash-card"><div class="dash-month"><div class="dash-week-stat-head"></div>${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day) => `<div class="dash-month-head">${day}</div>`).join('')}`;
    weeks.forEach((weekDays) => {
      const weekStats = statsFor(weekDays[0], addDays(weekDays[0], 7));
      html += `<div class="dash-week-stat">${miniStatsHtml(weekStats, weekDays[0], addDays(weekDays[0], 7))}</div>`;
      weekDays.forEach((day) => {
        const active = day.getMonth() === anchorDate.getMonth();
        const future = startOfDay(day) > startOfDay(new Date());
        const count = dayAppointmentCount(day);
        html += `<div class="dash-month-day ${active ? '' : 'muted'}" ${active ? `data-day="${day.toISOString()}"` : ''}>
          <div class="dash-month-num">${day.getDate()}</div>
          ${active && !future ? dayStatsHtml(day) : ''}
          ${active && future && count ? `<div class="dash-future-count">appointments ${count}</div>` : ''}
        </div>`;
      });
    });
    return `${html}</div></div>`;
  }
  function renderWeek(){
    const start = weekStart(anchorDate);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const hours = Array.from({ length: 11 }, (_, i) => i + 8);
    const layouts = new Map(days.map((day) => [day.toDateString(), weekEventLayout(day, hours)]));
    let html = `<div class="dash-card"><div class="dash-week"><div class="dash-time-head"></div>`;
    html += days.map((day) => `<div class="dash-week-head"><div class="dash-day-head"><div class="dash-day-head-title">${escapeHtml(day.toLocaleDateString([], { weekday:'short' }))} - ${escapeHtml(day.toLocaleDateString([], { month:'short', day:'numeric' }))}</div>${headerStatsHtml(day)}</div></div>`).join('');
    hours.forEach((hour) => {
      html += `<div class="dash-time-cell">${hour > 12 ? hour - 12 : hour}${hour >= 12 ? 'p' : 'a'}</div>`;
      days.forEach((day) => {
        const layout = layouts.get(day.toDateString()) || new Map();
        const dayEvents = events.filter((event) => sameDay(eventStart(event), day) && eventStart(event).getHours() === hour);
        html += `<div class="dash-day-cell">${dayEvents.map((event) => {
          const startTime = eventStart(event);
          const details = layout.get(String(event.id || '')) || {};
          const top = Math.max(0, Math.min(70, startTime.getMinutes() * 1.2));
          const startMinute = details.startMinute ?? (startTime.getHours() * 60 + startTime.getMinutes());
          const endMinute = details.endMinute ?? (startMinute + Math.max(15, Number(event.duration_minutes || 60)));
          const height = Math.max(28, ((endMinute - startMinute) / 60) * 72 - 4);
          const columnCount = Math.max(1, Number(details.columnCount || 1));
          const column = Math.max(0, Number(details.column || 0));
          const left = (column / columnCount) * 100;
          const width = 100 / columnCount;
          const project = eventProject(event);
          return `<div class="dash-event" style="top:${top}px;height:${height}px;left:calc(${left}% + 5px);width:calc(${width}% - 10px);right:auto" data-event-id="${escapeHtml(event.id)}">
            <span class="dash-event-title">${escapeHtml(projectTitle(project, event))}</span>
            <span class="dash-event-assigned">${escapeHtml(assignedLabel(event))}</span>
            <span class="dash-event-address">${escapeHtml(projectAddress(project, event))}</span>
          </div>`;
        }).join('')}</div>`;
      });
    });
    return `${html}</div></div>`;
  }
  function renderDay(){
    const dayEvents = events.filter((event) => sameDay(eventStart(event), anchorDate));
    if (!dayEvents.length) return `<div class="dash-empty">No events scheduled for this day.</div>`;
    return `<div class="dash-day-list">${dayEvents.map((event) => `
      <div class="dash-list-event" data-event-id="${escapeHtml(event.id)}">
        <div class="dash-list-time">${escapeHtml(fmtTime(eventStart(event)))}<br>${escapeHtml(fmtTime(eventEnd(event)))}</div>
        <div><div class="dash-list-title">${escapeHtml(projectTitle(eventProject(event), event))}</div><div class="dash-list-meta">${escapeHtml(event.project_address || eventProject(event).address || 'Project')} - ${escapeHtml(assignedLabel(event))}</div></div>
        <div class="r-viewer-type-tag">${escapeHtml((event.mapped_roles || []).map((role) => role.label).join(', ') || 'Event')}</div>
      </div>
    `).join('')}</div>`;
  }
  function projectHasSalesAppointment(project){
    return allEvents.some((event) => String(event.project_id) === String(project.id) && String(event.event_type_id || event.type_id || '').includes('sales_appointment'));
  }
  function scheduleAppointmentItems(){
    return events
      .filter((event) => sameDay(eventStart(event), anchorDate))
      .map((event) => ({ event, project: eventProject(event), salesperson: assignedLabel(event), stage: eventProject(event).mapped_stage, assigned: eventAssignedUsers(event).length > 0 }))
      .sort((a, b) => eventStart(a.event) - eventStart(b.event));
  }
  function renderScheduleGroups(){
    const items = scheduleAppointmentItems();
    const assigned = items.filter((item) => item.assigned);
    const unassigned = items.filter((item) => !item.assigned);
    const tile = (item, assignedTile = false) => {
      const project = item.project || {};
      const selected = String(item.event.id || '') === String(appointmentScheduleEventId || '');
      return `<button type="button" class="dash-appt-tile ${assignedTile ? 'has-action' : 'unscheduled'} ${selected ? 'selected' : ''}" data-schedule-event-id="${escapeHtml(item.event.id || '')}" data-schedule-project-id="${escapeHtml(project.id || '')}">
        <div class="dash-appt-title">${escapeHtml(projectTitle(project, item.event))}</div>
        <div class="dash-appt-sales">${escapeHtml(assignedTile ? item.salesperson : fmtTime(eventStart(item.event)))}</div>
        <div class="dash-appt-address">${escapeHtml(projectAddress(project, item.event))}</div>
        ${assignedTile ? '' : '<div class="dash-stage-pill">Unassigned</div>'}
        ${assignedTile ? `<span class="dash-appt-actions">
          <span class="dash-appt-action" data-schedule-unassign-event="${escapeHtml(item.event.id || '')}" title="Unassign appointment"><i class="fas fa-user-minus"></i></span>
          <span class="dash-appt-action view" data-schedule-view-event="${escapeHtml(item.event.id || '')}" title="View project"><i class="fas fa-eye"></i></span>
        </span>` : ''}
      </button>`;
    };
    const group = (label, rows, assignedTile) => `<div class="dash-group">
      <div class="dash-group-head" style="cursor:default"><strong>${escapeHtml(label)}</strong><span>${rows.length}</span></div>
      <div class="dash-group-body">${rows.length ? rows.map((item) => tile(item, assignedTile)).join('') : `<div class="dash-empty" style="padding:16px;">No ${escapeHtml(label.toLowerCase())}.</div>`}</div>
    </div>`;
    return `<div class="dash-groups">${group('Unassigned Appointments', unassigned, false)}${group('Assigned Appointments', assigned, true)}</div>`;
  }
  function selectedScheduleProject(){
    return visibleProjects().find((project) => String(project.id) === String(appointmentScheduleProjectId)) || null;
  }
  function selectedScheduleEvent(){
    return events.find((event) => String(event.id || '') === String(appointmentScheduleEventId || '')) || null;
  }
  function clearScheduleSelectionDom(){
    rootEl?.querySelectorAll('.dash-appt-tile.selected').forEach((node) => node.classList.remove('selected'));
    rootEl?.querySelectorAll('.psv-appt.moving').forEach((node) => node.classList.remove('moving'));
    rootEl?.querySelectorAll('.psv-appt.open').forEach((node) => node.classList.remove('open'));
    rootEl?.querySelectorAll('.psv-event-menu').forEach((node) => node.remove());
  }
  function markScheduleSelectionDom(eventId){
    clearScheduleSelectionDom();
    if (!eventId) return;
    const escaped = window.CSS?.escape ? window.CSS.escape(String(eventId)) : String(eventId).replace(/["\\]/g, '\\$&');
    rootEl?.querySelectorAll(`[data-schedule-event-id="${escaped}"]`).forEach((node) => node.classList.add('selected'));
    rootEl?.querySelectorAll(`.psv-appt[data-psv-event-id="${escaped}"]`).forEach((node) => node.classList.add('moving'));
  }
  function captureScheduleScroll(){
    const scroll = rootEl?.querySelector('#dashScheduleView .psv-scroll');
    if (!scroll) return;
    appointmentScheduleScrollLeft = scroll.scrollLeft || 0;
    appointmentScheduleScrollTop = scroll.scrollTop || 0;
  }
  function restoreScheduleScroll(){
    const scroll = rootEl?.querySelector('#dashScheduleView .psv-scroll');
    if (!scroll) return;
    scroll.scrollLeft = appointmentScheduleScrollLeft || 0;
    scroll.scrollTop = appointmentScheduleScrollTop || 0;
  }
  function bindScheduleScrollPersistence(){
    const scroll = rootEl?.querySelector('#dashScheduleView .psv-scroll');
    if (!scroll) return;
    restoreScheduleScroll();
    scroll.addEventListener('scroll', captureScheduleScroll, { passive: true });
  }
  function renderScheduleLibraryViewPreserveScroll(){
    captureScheduleScroll();
    renderScheduleLibraryView();
  }
  function toggleScheduleSelection(event, { rerender = false } = {}){
    if (!event?.id) return;
    const same = String(appointmentScheduleEventId || '') === String(event.id || '');
    appointmentScheduleDraft = null;
    if (same) {
      appointmentScheduleProjectId = '';
      appointmentScheduleEventId = '';
      appointmentScheduleMenuEventId = '';
      clearScheduleSelectionDom();
    } else {
      appointmentScheduleProjectId = String(event.project_id || eventProject(event).id || '');
      appointmentScheduleEventId = String(event.id || '');
      appointmentScheduleMenuEventId = '';
      markScheduleSelectionDom(appointmentScheduleEventId);
    }
    const btn = rootEl?.querySelector('[data-dash-confirm-schedule]');
    if (btn) btn.disabled = true;
    if (rerender) renderScheduleLibraryViewPreserveScroll();
  }
  function scheduleHistoryEntry(event, reason){
    if (!event?.id) return null;
    return {
      id: `history_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      reason: reason || 'schedule_updated',
      changed_at: new Date().toISOString(),
      previous: {
        start_at: event.start_at || event.start || '',
        end_at: event.end_at || event.end || '',
        duration_minutes: Number(event.duration_minutes || 60),
        assigned_user_ids: Array.isArray(event.assigned_user_ids) ? [...event.assigned_user_ids] : [],
        assigned_users: Array.isArray(event.assigned_users) ? event.assigned_users.map((user) => ({ ...user })) : [],
        assigned_user_id: event.assigned_user_id || '',
        assigned_user_name: event.assigned_user_name || '',
        status: event.status || '',
      },
    };
  }
  function withScheduleHistory(event, reason){
    const entry = scheduleHistoryEntry(event, reason);
    if (!entry) return event;
    return { ...event, schedule_history: [...(Array.isArray(event.schedule_history) ? event.schedule_history : []), entry] };
  }
  async function unassignScheduleEvent(event){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling || !event?.id) return;
    const project = eventProject(event);
    if (!project?.id) return;
    const nextEvent = {
      ...withScheduleHistory(event, 'unassigned'),
      assigned_user_ids: [],
      assigned_users: [],
      assigned_user_id: '',
      assigned_user_name: '',
      updated_at: new Date().toISOString(),
    };
    try {
      await Scheduling.saveProjectEvent(orgId(), project, nextEvent, schedulingConfig);
      appointmentScheduleDraft = null;
      appointmentScheduleProjectId = String(project.id || '');
      appointmentScheduleEventId = String(event.id || '');
      appointmentScheduleMenuEventId = '';
      await loadData({ force: true });
      showToast('Appointment unassigned', 'The appointment is ready to assign again.', true);
    } catch (error) {
      showToast('Unassign failed', error?.message || 'Could not unassign this appointment.', false);
    }
  }
  async function confirmDashboardDraft(){
    const Scheduling = window.PlatformScheduling;
    const project = selectedScheduleProject();
    if (!Scheduling || !project?.id || !appointmentScheduleDraft?.start) return;
    captureScheduleScroll();
    const eventType = schedulingConfig?.event_types?.sales_appointment || {};
    const user = appointmentScheduleDraft.user || null;
    const existing = selectedScheduleEvent();
    const event = existing
      ? {
          ...withScheduleHistory(existing, 'rescheduled_or_assigned'),
          start_at: new Date(appointmentScheduleDraft.start).toISOString(),
          start: new Date(appointmentScheduleDraft.start).toISOString(),
          duration_minutes: Number(existing.duration_minutes || eventType.duration_minutes || 60),
          assigned_user_ids: user?.id ? [user.id] : [],
          assigned_users: user?.id ? [{ id: user.id, name: user.name || user.email || user.id, role_ids: user.roles || ['sales_appointments'] }] : [],
          assigned_user_id: user?.id || '',
          assigned_user_name: user?.id ? (user.name || user.email || user.id) : '',
          updated_at: new Date().toISOString(),
        }
      : Scheduling.createProjectEvent(project, 'sales_appointment', {
          start: appointmentScheduleDraft.start,
          durationMinutes: Number(eventType.duration_minutes || 60),
          assignedUserIds: user?.id ? [user.id] : [],
          assignedUsers: user?.id ? [{ id: user.id, name: user.name || user.email || user.id, role_ids: user.roles || ['sales_appointments'] }] : [],
        }, schedulingConfig);
    try {
      await Scheduling.saveProjectEvent(orgId(), project, event, schedulingConfig);
      appointmentScheduleDraft = null;
      appointmentScheduleProjectId = '';
      appointmentScheduleEventId = '';
      appointmentScheduleMenuEventId = '';
      await loadData({ force: true });
      showToast('Appointment scheduled', 'The appointment was added to the project.', true);
    } catch (error) {
      showToast('Scheduling failed', error?.message || 'Could not schedule this appointment.', false);
    }
  }
  function renderAppointmentSchedule(){
    return `<div class="dash-card dash-schedule-card">
      <div id="dashScheduleView" class="dash-schedule-view"></div>
      <div class="dash-schedule-actions">
        <button class="dash-btn active" data-dash-confirm-schedule ${appointmentScheduleDraft?.start ? '' : 'disabled'}><i class="fas fa-check"></i> Confirm Appointment</button>
      </div>
    </div>`;
  }
  function renderScheduleLibraryView(){
    const mount = rootEl?.querySelector('#dashScheduleView');
    if (!mount || !window.PlatformScheduleView || !schedulingConfig) return;
    const selected = selectedScheduleProject();
    const selectedEvent = selectedScheduleEvent();
    const placementEnabled = !!(selected && selectedEvent && !eventAssignedUsers(selectedEvent).length);
    window.PlatformScheduleView.renderDailyTeam(mount, {
      Scheduling: window.PlatformScheduling,
      config: schedulingConfig,
      users,
      projects,
      date: anchorDate,
      eventTypeId: 'sales_appointment',
      windowForDate: appointmentWindowForDate,
      placementProject: placementEnabled ? selected : null,
      draft: appointmentScheduleDraft,
      liveTravel: appointmentScheduleLiveTravel,
      travelTimeCache: dashboardTravelTimeCache(),
      lockTime: appointmentScheduleLockTime,
      readOnly: !placementEnabled,
      assignmentEventId: appointmentScheduleEventId,
      lockPlacementStart: appointmentScheduleLockTime && placementEnabled ? (selectedEvent?.start_at || selectedEvent?.start || '') : '',
      lockPlacementEnd: appointmentScheduleLockTime && placementEnabled ? eventEnd(selectedEvent).toISOString() : '',
      onEventClick({ event, element }){
        const assigned = eventAssignedUsers(event).length > 0;
        if (!assigned) {
          toggleScheduleSelection(event, { rerender: true });
          return;
        }
        if (!element) return;
        rootEl?.querySelectorAll('.psv-appt.open').forEach((node) => node.classList.remove('open'));
        rootEl?.querySelectorAll('.psv-event-menu').forEach((node) => node.remove());
        element.classList.add('open');
        const menu = document.createElement('div');
        menu.className = 'psv-event-menu';
        menu.innerHTML = `
          <div class="psv-event-action danger" data-psv-unassign-event><i class="fas fa-user-minus"></i> Unassign</div>
        `;
        menu.querySelector('[data-psv-unassign-event]')?.addEventListener('click', (clickEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
          unassignScheduleEvent(event);
        });
        element.appendChild(menu);
      },
      onNavigate(delta){ anchorDate = addDays(anchorDate, delta); appointmentScheduleDraft = null; appointmentScheduleProjectId = ''; appointmentScheduleEventId = ''; appointmentScheduleMenuEventId = ''; render(); },
      onLockTimeToggle(next){ appointmentScheduleLockTime = !!next; appointmentScheduleDraft = null; renderScheduleLibraryViewPreserveScroll(); },
      onLiveTravelToggle(next){ appointmentScheduleLiveTravel = !!next; renderScheduleLibraryViewPreserveScroll(); },
      onTravelTimeResolved(result){ persistTravelTime(result); },
      onDraftChange(selection){
        if (!placementEnabled) return;
        appointmentScheduleMenuEventId = '';
        appointmentScheduleDraft = selection?.start ? { start: selection.start, user: selection.user, laneIndex: selection.laneIndex } : null;
        window.PlatformScheduleView?.updateDraft?.(mount, appointmentScheduleDraft);
        const btn = rootEl?.querySelector('[data-dash-confirm-schedule]');
        if (btn) btn.disabled = !appointmentScheduleDraft?.start;
      },
      onDraftConfirm(draft){
        if (!placementEnabled || !draft?.start) return;
        appointmentScheduleDraft = draft;
        confirmDashboardDraft();
      },
    });
    bindScheduleScrollPersistence();
  }
  function renderGroups(){
    if (viewMode === 'appointment_schedule') return renderScheduleGroups();
    const groups = window.PlatformAPI.dashboard.getDashboardProjectGroups({ projects, events, dashboardConfig, schedulingConfig, now: new Date() })
      .map((group) => {
        if (Array.isArray(group.items) && group.items.length) return group;
        const key = String(group.preset || group.id || group.label || '').toLowerCase();
        const targetDay = key.includes('today') ? new Date() : key.includes('tomorrow') ? addDays(new Date(), 1) : null;
        if (!targetDay) return group;
        const items = events
          .filter((event) => sameDay(eventStart(event), targetDay))
          .sort((a, b) => eventStart(a) - eventStart(b))
          .map((event) => {
            const project = eventProject(event);
            return { event, project, stage: project.mapped_stage || {}, salesperson: assignedLabel(event), start_at: eventStart(event)?.toISOString() || '' };
          });
        return items.length ? { ...group, items } : group;
      });
    return `<div class="dash-groups">${groups.map((group) => {
      const collapsed = collapsedGroups[group.id] ?? group.collapsed_by_default;
      return `<div class="dash-group ${collapsed ? 'collapsed' : ''}" data-group-id="${escapeHtml(group.id)}" data-collapsed="${collapsed ? '1' : '0'}">
        <button type="button" class="dash-group-head" data-toggle-group="${escapeHtml(group.id)}">
          <strong>${escapeHtml(group.label || 'Appointments')}</strong>
          <span>${group.items.length} <i class="fas fa-chevron-${collapsed ? 'down' : 'up'}"></i></span>
        </button>
        <div class="dash-group-body">${group.items.length ? group.items.map(appointmentTile).join('') : `<div class="dash-empty" style="padding:16px;">No appointments.</div>`}</div>
      </div>`;
    }).join('')}</div>`;
  }
  function toolbarHtml(){
    return `
      <div class="dash-toolbar">
        <div><h2 class="dash-title">${escapeHtml(visibleTitle())}</h2><div class="dash-sub">${loading ? 'Loading dashboard...' : `${events.length} scheduled event${events.length === 1 ? '' : 's'}`}</div></div>
        <div class="dash-controls">
          <button class="dash-btn" data-dash-nav="-1"><i class="fas fa-chevron-left"></i></button>
          <button class="dash-btn" data-dash-today>Today</button>
          <button class="dash-btn" data-dash-nav="1"><i class="fas fa-chevron-right"></i></button>
          ${[
            ['day','Day'],
            ['week','Week'],
            ['month','Month'],
            ['appointment_schedule','Appointment Schedule']
          ].map(([mode,label]) => `<button class="dash-btn ${viewMode === mode ? 'active' : ''}" data-dash-view="${mode}">${escapeHtml(label)}</button>`).join('')}
        </div>
      </div>
    `;
  }
  function openDayModal(dayIso){
    const day = new Date(dayIso);
    if (!Number.isFinite(day.getTime())) return;
    const dayEvents = events.filter((event) => sameDay(eventStart(event), day));
    const items = dayEvents.map((event) => ({ event, project: eventProject(event), salesperson: assignedLabel(event), stage: eventProject(event).mapped_stage }));
    const back = document.createElement('div');
    back.className = 'dash-modal-backdrop';
    back.innerHTML = `
      <div class="dash-modal">
        <div class="dash-modal-head">
          <div><h3>${escapeHtml(day.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' }))}</h3><div class="dash-sub">${dayEvents.length} appointment${dayEvents.length === 1 ? '' : 's'}</div></div>
          <button type="button" class="dash-modal-close"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="dash-modal-body">
          ${topStatsHtmlForDay(day)}
          <div class="dash-groups"><div class="dash-group"><div class="dash-group-body">${items.length ? items.map(appointmentTile).join('') : `<div class="dash-empty">No appointments.</div>`}</div></div></div>
        </div>
      </div>
    `;
    let modalHandle = null;
    const close = () => {
      modalHandle?.unregister?.();
      modalHandle = null;
      back.remove();
    };
    back.querySelector('.dash-modal-close')?.addEventListener('click', close);
    back.querySelectorAll('[data-event-id]').forEach((node) => node.addEventListener('click', () => {
      const event = events.find((item) => item.id === node.dataset.eventId);
      if (event) { close(); openProjectFromEvent(event); }
    }));
    document.body.appendChild(back);
    modalHandle = window.Portal?.modals?.register?.(back, {
      id: 'schedule-day',
      closeOnEscape: true,
      closeOnBackdrop: true,
      onClose: close
    }) || null;
    back.querySelectorAll('[data-stat-tip]').forEach((node) => {
      node.addEventListener('mouseenter', () => showStatTooltip(node));
      node.addEventListener('mousemove', () => showStatTooltip(node));
      node.addEventListener('mouseleave', hideStatTooltip);
      node.addEventListener('focus', () => showStatTooltip(node));
      node.addEventListener('blur', hideStatTooltip);
    });
  }
  function topStatsHtmlForDay(day){
    const start = startOfDay(day);
    const end = addDays(day, 1);
    const stats = statsFor(start, end);
    return `<div class="dash-stats" style="grid-template-columns:repeat(4,minmax(100px,1fr));">${statDefs().map((stat) => `
      <div class="dash-stat" data-stat-tip="${escapeHtml(stat.label || stat.id)}" data-stat-id="${escapeHtml(stat.id)}" data-stat-start="${start.toISOString()}" data-stat-end="${end.toISOString()}" tabindex="0"><i class="fas ${escapeHtml(stat.icon || 'fa-chart-simple')}"></i><div><small>${escapeHtml(stat.label || stat.id)}</small><strong>${statValueHtml(stat, stats)}</strong></div></div>
    `).join('')}</div>`;
  }
  function showStatTooltip(target){
    const text = String(target?.dataset?.statTip || '').trim();
    if (!text) return;
    const statId = String(target?.dataset?.statId || '').trim();
    const stat = statDefs().find((entry) => entry.id === statId) || { id: statId, label: text };
    const start = new Date(target?.dataset?.statStart || '');
    const end = new Date(target?.dataset?.statEnd || '');
    const html = Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())
      ? statTipHtml(stat, start, end)
      : escapeHtml(text);
    window.PlatformUI?.showTooltip?.(target, { html });
  }
  function hideStatTooltip(){
    window.PlatformUI?.hideTooltip?.();
  }
  function bind(){
    rootEl.querySelectorAll('[data-breakdown-mode]').forEach((btn) => btn.addEventListener('click', () => {
      breakdownMode = btn.dataset.breakdownMode || 'user';
      breakdownValue = 'all';
      filterMenuOpen = false;
      modeMenuOpen = false;
      render();
    }));
    rootEl.querySelector('[data-mode-menu-toggle]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      modeMenuOpen = !modeMenuOpen;
      filterMenuOpen = false;
      render();
    });
    rootEl.querySelector('[data-filter-menu-toggle]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      filterMenuOpen = !filterMenuOpen;
      modeMenuOpen = false;
      render();
    });
    rootEl.querySelectorAll('[data-breakdown-value]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.stopPropagation();
      breakdownValue = btn.dataset.breakdownValue || 'all';
      filterMenuOpen = false;
      modeMenuOpen = false;
      render();
    }));
    rootEl.querySelectorAll('[data-dash-view]').forEach((btn) => btn.addEventListener('click', () => { viewMode = btn.dataset.dashView || 'week'; render(); }));
    rootEl.querySelectorAll('[data-dash-nav]').forEach((btn) => btn.addEventListener('click', () => nav(Number(btn.dataset.dashNav) || 0)));
    rootEl.querySelector('[data-dash-today]')?.addEventListener('click', () => { anchorDate = new Date(); render(); });
    rootEl.querySelectorAll('[data-schedule-unassign-event]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const target = events.find((item) => String(item.id || '') === String(node.dataset.scheduleUnassignEvent || ''));
      unassignScheduleEvent(target);
    }));
    rootEl.querySelectorAll('[data-schedule-view-event]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const target = events.find((item) => String(item.id || '') === String(node.dataset.scheduleViewEvent || ''));
      if (target) openProjectFromEvent(target);
    }));
    rootEl.querySelectorAll('[data-event-id]').forEach((node) => node.addEventListener('click', () => {
      const event = events.find((item) => item.id === node.dataset.eventId);
      if (event) openProjectFromEvent(event);
    }));
    rootEl.querySelectorAll('[data-toggle-group]').forEach((node) => node.addEventListener('click', () => {
      const id = node.dataset.toggleGroup || '';
      const groupEl = node.closest('.dash-group');
      collapsedGroups[id] = groupEl?.dataset.collapsed !== '1';
      render();
    }));
    rootEl.querySelectorAll('[data-schedule-project-id]').forEach((node) => node.addEventListener('click', () => {
      const event = events.find((item) => String(item.id || '') === String(node.dataset.scheduleEventId || ''));
      if (eventAssignedUsers(event).length > 0) return;
      toggleScheduleSelection(event, { rerender: true });
    }));
    rootEl.querySelector('[data-dash-confirm-schedule]')?.addEventListener('click', () => confirmDashboardDraft());
    rootEl.querySelectorAll('[data-day]').forEach((node) => node.addEventListener('click', () => openDayModal(node.dataset.day)));
    rootEl.querySelectorAll('[data-stat-tip]').forEach((node) => {
      node.addEventListener('mouseenter', () => showStatTooltip(node));
      node.addEventListener('mousemove', () => showStatTooltip(node));
      node.addEventListener('mouseleave', hideStatTooltip);
      node.addEventListener('focus', () => showStatTooltip(node));
      node.addEventListener('blur', hideStatTooltip);
    });
  }
  function render(){
    if (!rootEl) return;
    if (viewMode === 'appointment_schedule') captureScheduleScroll();
    events = visibleEvents();
    const main = viewMode === 'appointment_schedule' ? renderAppointmentSchedule() : viewMode === 'month' ? renderMonth() : viewMode === 'day' ? renderDay() : renderWeek();
    rootEl.innerHTML = `<div class="dash-shell">${toolbarHtml()}<div class="dash-body ${viewMode === 'appointment_schedule' ? 'schedule-mode' : ''}"><div class="dash-left">${topStatsHtml()}${main}</div><aside class="dash-right">${renderGroups()}</aside></div></div>`;
    if (viewMode === 'appointment_schedule') renderScheduleLibraryView();
    bind();
  }
  function withTimeout(promise, ms, label){
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label || 'Dashboard request'} timed out.`)), ms))
    ]);
  }
  async function settleValue(promise, fallback, label){
    try {
      const value = await withTimeout(promise, 8000, label);
      return value ?? fallback;
    } catch (error) {
      console.warn(label || 'Dashboard request failed', error);
      return fallback;
    }
  }
  async function loadData({ force = false } = {}){
    if (!rootEl) return;
    if (loading) {
      loadQueued = true;
      return;
    }
    if (!force && lastLoadFailedAt && Date.now() - lastLoadFailedAt < 1500) {
      loadQueued = true;
      if (!loadTimer) {
        loadTimer = setTimeout(() => {
          loadTimer = null;
          if (loadQueued) {
            loadQueued = false;
            loadData().catch(() => null);
          }
        }, 1500);
      }
      return;
    }
    const Scheduling = window.PlatformScheduling;
    const Dashboard = window.PlatformAPI?.dashboard;
    const id = orgId();
    if (!Scheduling || !Dashboard || !id) return;
    loadQueued = false;
    loading = true;
    render();
    try {
      schedulingConfig = await settleValue(
        Scheduling.loadBranchConfig(id, branchId(), { ensureDefaults: true }),
        schedulingConfig || {},
        'Dashboard scheduling config'
      );
      dashboardConfig = await settleValue(
        Dashboard.loadConfig(id, branchId(), { ensureDefaults: true }),
        dashboardConfig || Dashboard.normalizeConfig?.({}) || {},
        'Dashboard config'
      );
      const loadedUsers = await settleValue(
        Scheduling.listUsers(id, schedulingConfig),
        [],
        'Dashboard users'
      );
      const loadedProjects = await settleValue(
        Scheduling.listProjects(id, schedulingConfig),
        [],
        'Dashboard projects'
      );
      users = Array.isArray(loadedUsers) ? loadedUsers : [];
      projects = Array.isArray(loadedProjects) ? loadedProjects : [];
      allEvents = Scheduling.eventsFromProjects(projects, schedulingConfig || {}).sort((a, b) => eventStart(a) - eventStart(b));
      events = visibleEvents();
      lastLoadFailedAt = 0;
    } catch (error) {
      lastLoadFailedAt = Date.now();
      if (!loadData._lastToastAt || Date.now() - loadData._lastToastAt > 5000) {
        loadData._lastToastAt = Date.now();
        showToast('Dashboard unavailable', error?.message || 'Could not load dashboard events.', false);
      }
    } finally {
      loading = false;
      render();
      if (loadQueued) {
        loadQueued = false;
        loadData().catch(() => null);
      }
    }
  }
  function mount(el){
    rootEl = el;
    injectCSS('dashboard_tab', css);
    render();
    loadData();
  }

  function scheduleLoad(){
    if (loadTimer) return;
    loadTimer = setTimeout(() => {
      loadTimer = null;
      loadData().catch(() => null);
    }, 120);
  }
  let tabRegistered = false;
  async function syncSchedulingTab(){
    if (window.Portal?.appFlags?.load) await window.Portal.appFlags.load().catch(() => null);
    const enabled = window.Portal?.appFlags?.has ? window.Portal.appFlags.has('platform', 'scheduling') : false;
    if (!enabled) {
      if (tabRegistered) {
        tabRegistered = false;
        window.Portal?.apps?.unregisterPortalApp?.('dashboard');
      }
      return;
    }
    if (!tabRegistered) {
      tabRegistered = true;
      window.Portal.apps.registerPortalApp({ id: 'portal.dashboard', tabId: 'dashboard', title: 'Scheduling', icon: 'fa-calendar-days', order: 18, fullBleed: true, mount, onShow: () => loadData() });
      window.Portal.tabs.renderTabs?.();
    }
  }
  window.addEventListener('fm:calendar:refresh', () => scheduleLoad());
  window.addEventListener('fm:dashboard:refresh', () => scheduleLoad());
  window.addEventListener('fm:projects:refresh', () => scheduleLoad());
  window.addEventListener('fm:app-flags:updated', () => syncSchedulingTab().catch(() => null));
  document.addEventListener('DOMContentLoaded', () => syncSchedulingTab().catch(() => null));
  syncSchedulingTab().catch(() => null);
})();
