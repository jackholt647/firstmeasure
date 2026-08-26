/* public/libraries/apps/project-schedule/panel.js
 * Embeddable project schedule pane.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  const Portal = window.Portal;
  const util = Portal?.util || {};
  const cfg = Portal?.cfg || window.__APP || {};
  const $ = util.$ || ((sel, root = document) => root.querySelector(sel));
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match])));
  const showToast = Portal?.ui?.showToast || window.showToast || (() => {});

  let scheduleModeActive = false;
  let scheduleCalendarGen = 0;
  let scheduleAnchorDate = new Date();
  let scheduleViewMode = 'month';
  let scheduleDraft = null;
  let schedulePreferredSalesUserId = '';
  let workScheduleDrafts = new Map();
  let activeWorkScheduleDraftId = '';
  let workScheduleDraftSerial = 0;
  let workScheduleViewMode = 'month';
  let workScheduleModeActive = false;
  let scheduleUseLiveTravel = true;
  let scheduleLockTime = true;
  let scheduleSmartScroll = false;
  let scheduleSchedulingTarget = 'production';
  let scheduleSelectedEventId = '';
  let scheduleAssignmentEventId = '';
  let scheduleCrewSettingsOpen = false;
  let scheduleCachedConfig = null;
  let scheduleCachedLaborSettings = null;
  let scheduleCachedUsers = [];
  let scheduleCachedProjects = [];
  let scheduleWorkResourceDataLoaded = false;
  const scheduleTravelCache = new Map();
  const state = {
    mounted: false,
    active: false,
    host: null,
    model: null,
    panelRoot: null,
    leftRoot: null,
    context: null
  };

  function hostFor(context = {}){
    return context.projectWorkspace || context.host?.projectWorkspace || context.host || state.host || {};
  }

  function callHost(name, ...args){
    const fn = state.host && state.host[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
  }

  function modelFromContext(context = {}){
    return context.projectModel || context.model || window.FirstMateAppContext?.modelFromContext?.(context) || state.model || null;
  }

  function defineHostAccessor(name, get, set = null){
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get,
        set: set || (() => {})
      });
    } catch (_) {}
  }

  function installHostGlobals(){
    defineHostAccessor('activeBaseProject', () => callHost('getProject') || state.model?.state?.activeBaseProject || null, (value) => {
      if (state.model?.state) state.model.state.activeBaseProject = value || null;
      callHost('setProject', value || null);
    });
    defineHostAccessor('branchProjectConfig', () => callHost('getBranchProjectConfig') || state.model?.state?.branchProjectConfig || { title_mode: 'customer_name' });
    defineHostAccessor('reportOrderState', () => callHost('getReportOrderState') || state.model?.state?.reportOrderState || null, (value) => {
      if (state.model?.state) state.model.state.reportOrderState = value || null;
      callHost('setReportOrderState', value || null);
    });
  }

  function panelHtml(){
    return '<div class="r-schedule-panel" id="rSchedulePanel"></div>';
  }

  function injectProjectScheduleCss(){
    const css = `
      .r-schedule-panel.work-mode{padding:18px;background:#eef2f6;display:flex;flex-direction:column;gap:12px}
      .r-schedule-panel.work-mode .r-schedule-calendar.work-calendar{flex:1;height:auto;min-height:0}
      .r-schedule-view-switch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .r-schedule-view-group{display:inline-flex;align-items:center;gap:3px;border:1px solid rgba(15,23,42,.10);background:#fff;border-radius:12px;padding:3px}
      .r-schedule-view-group.scheduling{border-color:rgba(var(--primary-rgb,217,48,37),.18);background:rgba(var(--primary-rgb,217,48,37),.04)}
      .r-schedule-view-group.surface{background:#f8fafc}
      .r-schedule-view-group.target{border-color:rgba(37,99,235,.18);background:#eef5ff}
      .r-schedule-view-label{font-size:10px;font-weight:1000;text-transform:uppercase;color:#667085;padding:0 7px}
      .r-schedule-left-shell{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0}
      .r-schedule-left-scroll{display:flex;flex:1;flex-direction:column;gap:12px;min-height:0;max-height:100%;overflow:auto}
      .r-overlay.schedule-workspace .r-proposal-section.visible,
      .r-overlay.schedule-workspace .r-proposal-listing{min-height:0}
      .r-overlay.schedule-workspace .r-proposal-listing{flex:1;height:100%;overflow:hidden}
      .r-overlay.schedule-workspace .r-step-shell,
      .r-overlay.schedule-workspace .r-step-inner,
      .r-overlay.schedule-workspace .r-step-body{min-height:0}
      .r-schedule-section{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:14px;padding:13px;box-shadow:0 10px 24px rgba(15,23,42,.04)}
      .r-schedule-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
      .r-schedule-section-title{font-size:13px;font-weight:1000;color:#101828;display:flex;align-items:center;gap:8px}
      .r-schedule-mini-action{height:30px;border:1px solid rgba(15,23,42,.10);border-radius:10px;background:#fff;color:#344054;display:inline-flex;align-items:center;gap:7px;padding:0 9px;font-size:11px;font-weight:1000;cursor:pointer}
      .r-schedule-mini-action.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
      .r-schedule-mini-action:disabled{opacity:.45;cursor:not-allowed}
      .r-schedule-tile-list{display:grid;gap:8px}
      .r-schedule-tile{border:1px solid rgba(15,23,42,.08);border-radius:12px;background:#f8fafc;padding:10px;text-align:left;color:#344054}
      .r-schedule-tile-title{font-size:12px;font-weight:1000;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .r-schedule-tile-meta{margin-top:4px;font-size:11px;font-weight:850;color:#667085;line-height:1.35}
      .r-schedule-empty-small{border:1px dashed rgba(15,23,42,.16);border-radius:12px;background:#fbfcfe;padding:12px;color:#667085;font-size:12px;font-weight:850;text-align:center}
      .r-work-draft-card{display:grid;gap:9px}
      .r-work-title-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(104px,auto);align-items:end;gap:8px}
      .r-work-title-row.no-assignment{grid-template-columns:1fr}
      .r-crew-settings-list{display:grid;gap:12px;min-height:0;overflow:auto;padding-right:2px}
      .r-crew-settings-status{min-height:18px;color:#667085;font-size:12px;font-weight:850}
      .r-crew-settings-card.archived{opacity:.72}
      .r-crew-settings-grid{display:grid;grid-template-columns:minmax(160px,1fr) minmax(140px,.7fr) repeat(2,minmax(110px,.45fr));gap:10px;align-items:end}
      .r-crew-field{display:grid;gap:5px;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#667085}
      .r-crew-field.wide{grid-column:span 2}
      .r-crew-field input,.r-crew-field select,.r-crew-member-row input,.r-crew-member-row select{height:34px;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;padding:0 9px;color:#101828;font-size:12px;font-weight:850;text-transform:none;min-width:0}
      .r-crew-member-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:4px 0 8px}
      .r-crew-member-row{display:grid;grid-template-columns:minmax(120px,1fr) minmax(150px,1fr) minmax(110px,.7fr) minmax(80px,.45fr) 36px;gap:8px;margin-top:8px;align-items:center}
      .r-crew-settings-actions{display:flex;justify-content:flex-end;gap:8px}
      .r-schedule-section-title.archived-title{margin-top:8px;color:#667085}
      .r-work-draft-card label{display:grid;gap:5px;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#667085}
      .r-work-draft-card input,.r-assignment-select{height:36px;border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#fff;color:#101828;padding:0 10px;font-size:12px;font-weight:900;min-width:0}
      .r-assignment-field{display:grid;gap:5px;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#667085}
      .r-assignment-select.waiting{font-style:italic;color:#92400e;border-color:rgba(245,158,11,.30);background:#fff7ed}
      .r-work-confirm-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:2px}
      .r-schedule-calendar.work-calendar{flex:1;min-height:0}
      .r-schedule-left-status{border:1px solid rgba(var(--primary-rgb,217,48,37),.18);background:rgba(var(--primary-rgb,217,48,37),.06);border-radius:12px;padding:10px;color:#344054;font-size:12px;font-weight:850;line-height:1.4}
      .r-schedule-left-status strong{display:block;color:#101828;font-size:12px;font-weight:1000;margin-bottom:2px}
    `;
    if (util.injectCSS) util.injectCSS('project_schedule_work', css);
    else if (!document.getElementById('project_schedule_work')) {
      const style = document.createElement('style');
      style.id = 'project_schedule_work';
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  function resolveRoot(context = {}){
    const root = context.panelRoot || context.roots?.main || state.panelRoot || document.querySelector('#rOverlay .r-preview-panel[data-panel="schedule"]');
    if (!root) return null;
    if (root.id === 'rSchedulePanel') return root;
    if (!root.querySelector?.('#rSchedulePanel')) root.innerHTML = panelHtml();
    return root.querySelector?.('#rSchedulePanel') || root;
  }

  function schedulingEnabled(){
    const hosted = callHost('schedulingEnabled');
    if (hosted !== undefined) return !!hosted;
    return window.schedulingEnabled?.() !== false;
  }

  function ensureProposalOnlyBaseProject(){
    return callHost('ensureProposalOnlyBaseProject') || activeBaseProject;
  }

  function persistActiveBaseProject(){
    return callHost('persistProject');
  }

  function setActivePreviewTab(tab){
    return callHost('setActivePreviewTab', tab);
  }

  function renderRoofChoice(){
    return callHost('renderRoofChoice');
  }

  function updateSubmitLabel(){
    return callHost('updateSubmitLabel');
  }

  function renderWorkflowState(){
    return callHost('renderWorkflowState');
  }

  function primaryContact(){
    return callHost('primaryContact') || {};
  }

  function collectContacts(){
    const contacts = callHost('collectContacts');
    return Array.isArray(contacts) ? contacts : [];
  }

  function manualProjectTitle(){
    return callHost('manualProjectTitle') || '';
  }

  function scheduleOrgId(){
    return String(cfg.userOrgId || cfg.orgId || '').trim();
  }

  function scheduleBranchId(){
    return window.Portal.branchModules?.currentBranchId?.() || cfg.userBranchId || cfg.branchId || 'default';
  }

  function formatEventTime(event){
    const start = window.PlatformScheduling?.eventStart?.(event) || new Date(event.start_at || event.start || Date.now());
    const end = window.PlatformScheduling?.eventEnd?.(event) || new Date(start.getTime() + (Number(event.duration_minutes) || 60) * 60000);
    const day = start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const from = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const to = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${day}, ${from} - ${to}`;
  }

  function eventAssignedLabel(event){
    const users = Array.isArray(event.assigned_users) ? event.assigned_users : [];
    if (users.length) return users.map((user) => user.name || user.email || user.id).filter(Boolean).join(', ');
    const ids = Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : [];
    return ids.length ? ids.join(', ') : 'Assign later';
  }

  function appointmentSummaryLabel(event){
    if (!event) return '';
    const Scheduling = window.PlatformScheduling;
    const start = Scheduling?.eventStart?.(event) || new Date(event.start_at || event.start || Date.now());
    const when = Number.isFinite(start.getTime())
      ? start.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : 'Scheduled';
    return `${when} - ${eventAssignedLabel(event)}`;
  }

  function ensureSchedulingProject(){
    if (!activeBaseProject) ensureProposalOnlyBaseProject();
    if (!activeBaseProject) return null;
    activeBaseProject.events = Array.isArray(activeBaseProject.events) ? activeBaseProject.events : [];
    persistActiveBaseProject();
    return activeBaseProject;
  }

  async function ensureRemoteSchedulingProject(){
    const project = ensureSchedulingProject();
    if (!project) return null;
    if (window.Portal.ProjectStore?.saveRemote) {
      try {
        activeBaseProject = await window.Portal.ProjectStore.saveRemote(project) || activeBaseProject;
      } catch (error) {
        console.warn('Platform project save before scheduling failed', error);
      }
    }
    activeBaseProject.events = Array.isArray(activeBaseProject.events) ? activeBaseProject.events : [];
    return activeBaseProject;
  }

  function scheduleProjectEvents(){
    return Array.isArray(activeBaseProject?.events) ? activeBaseProject.events : [];
  }

  function mergeScheduleActiveProject(projects = []){
    if (!activeBaseProject?.id) return Array.isArray(projects) ? projects : [];
    const list = Array.isArray(projects) ? [...projects] : [];
    if (!list.some((project) => String(project.id) === String(activeBaseProject.id))) {
      return [...list, activeBaseProject];
    }
    return list.map((project) => String(project.id) === String(activeBaseProject.id)
      ? { ...project, ...activeBaseProject, events: activeBaseProject.events || project.events || [] }
      : project);
  }

  function rememberScheduleData(config, users, projects){
    if (config) scheduleCachedConfig = config;
    if (Array.isArray(users) && users.length) scheduleCachedUsers = users;
    if (Array.isArray(projects) && projects.length) scheduleCachedProjects = projects;
  }

  function crewManagementEnabled(){
    if (!window.PlatformAPI?.appFlags?.current?.()) return false;
    if (window.PlatformAPI?.appFlags?.has?.('platform', 'crew_management')) return true;
    return window.PlatformAPI?.appFlags?.value?.('platform', 'crew_management', false) === true;
  }

  async function loadLaborCrewSettings(options = {}){
    if (!crewManagementEnabled() || !window.PlatformAPI?.labor?.crews || !scheduleOrgId()) {
      scheduleCachedLaborSettings = null;
      return null;
    }
    if (scheduleCachedLaborSettings && !options.refresh) return scheduleCachedLaborSettings;
    try {
      const result = await window.PlatformAPI.labor.crews(scheduleOrgId(), scheduleBranchId());
      scheduleCachedLaborSettings = result?.settings || null;
      return scheduleCachedLaborSettings;
    } catch (error) {
      if (Number(error?.status || 0) !== 403) console.warn('Labor crew settings unavailable.', error);
      scheduleCachedLaborSettings = null;
      return null;
    }
  }

  function activeLaborCrews(settings = scheduleCachedLaborSettings){
    return (Array.isArray(settings?.crews) ? settings.crews : [])
      .filter((crew) => String(crew?.status || 'active') !== 'archived' && !crew?.archived_at)
      .map((crew, index) => ({
        id: String(crew.id || `crew_${index + 1}`).trim(),
        name: String(crew.name || `Crew ${index + 1}`).trim(),
        color: crew.color || crew.attributes?.color || '',
        foreman_member_id: crew.foreman_member_id || crew.default_contact_member_id || ''
      }))
      .filter((crew) => crew.id);
  }

  function rememberScheduleProject(project){
    if (!project?.id) return;
    scheduleCachedProjects = mergeScheduleActiveProject(scheduleCachedProjects).map((item) => (
      String(item.id) === String(project.id) ? { ...item, ...project, events: project.events || item.events || [] } : item
    ));
    if (!scheduleCachedProjects.some((item) => String(item.id) === String(project.id))) {
      scheduleCachedProjects.push(project);
    }
  }

  function isSalesAppointmentEvent(event){
    const id = String(event?.event_type_default_id || event?.type_id || event?.event_type_id || '').trim();
    return id === 'sales_appointment' || id.includes('sales_appointment');
  }

  function currentProjectSalesAppointment(){
    return projectSalesAppointmentEvents()
      .sort((a, b) => (window.PlatformScheduling?.eventStart?.(a) || new Date(a.start_at || 0)) - (window.PlatformScheduling?.eventStart?.(b) || new Date(b.start_at || 0)))[0] || null;
  }

  function projectSalesAppointmentEvents(){
    return scheduleProjectEvents()
      .filter(isSalesAppointmentEvent)
      .sort((a, b) => (window.PlatformScheduling?.eventStart?.(a) || new Date(a.start_at || 0)) - (window.PlatformScheduling?.eventStart?.(b) || new Date(b.start_at || 0)));
  }

  function isProjectWorkEvent(event){
    const id = String(event?.event_type_default_id || event?.type_id || event?.event_type_id || '').trim();
    return id === 'project_work';
  }

  function projectWorkEvents(){
    return scheduleProjectEvents()
      .filter(isProjectWorkEvent)
      .map((event) => {
        const start = window.PlatformScheduling?.eventStart?.(event) || new Date(event.start_at || event.start || 0);
        const end = window.PlatformScheduling?.eventEnd?.(event) || new Date(event.end_at || event.end || start.getTime() + (Number(event.duration_minutes) || 480) * 60000);
        return { ...event, __start: start, __end: end };
      })
      .filter((event) => Number.isFinite(event.__start.getTime()) && Number.isFinite(event.__end.getTime()))
      .sort((a, b) => a.__start - b.__start);
  }

  function allProjectWorkEvents(){
    const Scheduling = window.PlatformScheduling;
    const projects = mergeScheduleActiveProject(scheduleCachedProjects);
    const projectById = new Map(projects.map((project) => [String(project.id || ''), project]));
    const rawEvents = Scheduling?.eventsFromProjects?.(projects, scheduleCachedConfig || null) || [];
    return rawEvents
      .filter(isProjectWorkEvent)
      .map((event) => {
        const project = projectById.get(String(event.project_id || '')) || null;
        const start = Scheduling?.eventStart?.(event) || new Date(event.start_at || event.start || 0);
        const end = Scheduling?.eventEnd?.(event) || new Date(event.end_at || event.end || start.getTime() + (Number(event.duration_minutes) || 480) * 60000);
        const projectTitle = project?.title || project?.customer_name || project?.customerName || project?.address || event.project_title || '';
        return {
          ...event,
          title: event.title && event.title !== 'Work Section' ? event.title : (projectTitle || event.title || 'Work Section'),
          project_title: projectTitle,
          __start: start,
          __end: end
        };
      })
      .filter((event) => Number.isFinite(event.__start.getTime()) && Number.isFinite(event.__end.getTime()))
      .sort((a, b) => a.__start - b.__start);
  }

  function scheduleUserFromEvent(event, users = []){
    const id = (Array.isArray(event?.assigned_user_ids) ? event.assigned_user_ids : [event?.assigned_user_id]).filter(Boolean)[0] || event?.assigned_users?.[0]?.id || '';
    return users.find((user) => String(user.id) === String(id)) || event?.assigned_users?.[0] || null;
  }

  function scheduleEventAssigned(event){
    return !!((Array.isArray(event?.assigned_user_ids) && event.assigned_user_ids.filter(Boolean).length)
      || (Array.isArray(event?.assigned_users) && event.assigned_users.filter((user) => user?.id).length)
      || event?.assigned_user_id);
  }

  function workCrewId(event = {}){
    if (Object.prototype.hasOwnProperty.call(event, 'assigned_crew_id')) return String(event.assigned_crew_id || '').trim();
    if (Object.prototype.hasOwnProperty.call(event, 'crew_id')) return String(event.crew_id || '').trim();
    return String(event.resource_id || '').trim();
  }

  function workCrewName(event = {}){
    if (Object.prototype.hasOwnProperty.call(event, 'assigned_crew_name')) return String(event.assigned_crew_name || '').trim();
    return String(event.crew_name || event.assigned_crew?.name || event.crew?.name || '').trim();
  }

  function defaultWorkCrewResource(crews = scheduleCrewResources(scheduleCachedConfig, scheduleCachedUsers)){
    if (crews.length > 1) return null;
    return crews[0] || { id: 'default_crew', name: 'Default crew', default: true };
  }

  function crewPayloadForSelection(crewId, crews = scheduleCrewResources(scheduleCachedConfig, scheduleCachedUsers)){
    const selectedId = String(crewId || '').trim();
    const crew = selectedId ? crews.find((item) => String(item.id || '') === selectedId) : null;
    if (crew) {
      return {
        crew_id: crew.id,
        crew_name: crew.name,
        resource_id: crew.id,
        resource_name: crew.name,
        assigned_crew_id: crew.id,
        assigned_crew_name: crew.name,
        assigned_crew: { id: crew.id, name: crew.name },
        crew_label: crew.name,
        awaiting_crew: false
      };
    }
    return {
      crew_id: '',
      crew_name: '',
      resource_id: '',
      resource_name: '',
      assigned_crew_id: '',
      assigned_crew_name: '',
      assigned_crew: null,
      crew_label: crews.length > 1 ? 'Waiting for crew' : '',
      awaiting_crew: crews.length > 1
    };
  }

  function workCrewCalendarPayload(event = {}, crews = scheduleCrewResources(scheduleCachedConfig, scheduleCachedUsers)){
    const existingId = workCrewId(event);
    const existingName = workCrewName(event);
    const activeCrew = existingId ? crews.find((crew) => String(crew.id || '') === String(existingId)) : null;
    if (activeCrew) {
      return {
        crew_id: activeCrew.id,
        crew_name: activeCrew.name,
        resource_id: activeCrew.id,
        resource_name: activeCrew.name,
        assigned_crew_id: activeCrew.id,
        assigned_crew_name: activeCrew.name,
        assigned_crew: event.assigned_crew || { id: activeCrew.id, name: activeCrew.name },
        crew_label: activeCrew.name,
        awaiting_crew: false
      };
    }
    if (existingId || existingName) {
      return {
        crew_id: existingId,
        crew_name: existingName,
        resource_id: '',
        resource_name: '',
        assigned_crew_id: existingId,
        assigned_crew_name: existingName,
        assigned_crew: event.assigned_crew || (existingId ? { id: existingId, name: existingName } : null),
        crew_label: 'Waiting for crew',
        awaiting_crew: true
      };
    }
    const fallback = defaultWorkCrewResource(crews);
    if (fallback) {
      return {
        crew_id: fallback.id,
        crew_name: fallback.name,
        resource_id: fallback.id,
        resource_name: fallback.name,
        assigned_crew_id: fallback.id,
        assigned_crew_name: fallback.name,
        assigned_crew: { id: fallback.id, name: fallback.name },
        crew_label: fallback.name,
        awaiting_crew: false
      };
    }
    return {
      crew_id: '',
      crew_name: '',
      resource_id: '',
      resource_name: '',
      assigned_crew_id: '',
      assigned_crew_name: '',
      assigned_crew: null,
      crew_label: 'Waiting for crew',
      awaiting_crew: true
    };
  }

  function decorateWorkEventForCalendar(event, crews = scheduleCrewResources(scheduleCachedConfig, scheduleCachedUsers)){
    return { ...event, ...workCrewCalendarPayload(event, crews) };
  }

  function workAssignmentSelectHtml(workScheduleDraft){
    const crews = scheduleCrewResources(scheduleCachedConfig, scheduleCachedUsers);
    if (crews.length <= 1) return '';
    const selected = String(workScheduleDraft?.assigned_crew_id || workScheduleDraft?.crew_id || '').trim();
    return `<label class="r-assignment-field">Crew<select id="rWorkAssignment" class="r-assignment-select ${selected ? '' : 'waiting'}">
      <option value="" ${selected ? '' : 'selected'}>Waiting</option>
      ${crews.map((crew) => `<option value="${escapeHtml(crew.id)}" ${String(crew.id) === selected ? 'selected' : ''}>${escapeHtml(crew.name)}</option>`).join('')}
    </select></label>`;
  }

  function salesAssignmentSelectHtml(){
    const salespeople = cachedSalesAppointmentUsers();
    if (salespeople.length <= 1) return '';
    const selected = String(scheduleDraft?.user?.id || schedulePreferredSalesUserId || '').trim();
    return `<label class="r-assignment-field">Salesperson<select id="rSalesAssignment" class="r-assignment-select ${selected ? '' : 'waiting'}">
      <option value="" ${selected ? '' : 'selected'}>Unassigned</option>
      ${salespeople.map((user) => `<option value="${escapeHtml(user.id)}" ${String(user.id) === selected ? 'selected' : ''}>${escapeHtml(user.name || user.email || user.id)}</option>`).join('')}
    </select></label>`;
  }

  function scheduleCrewResources(config = scheduleCachedConfig, users = scheduleCachedUsers){
    if (!crewManagementEnabled()) return [];
    const laborCrews = activeLaborCrews();
    if (laborCrews.length) return laborCrews;
    const explicit = [
      ...(Array.isArray(config?.crews) ? config.crews : []),
      ...(Array.isArray(config?.scheduling?.crews) ? config.scheduling.crews : []),
      ...(Array.isArray(config?.resources?.crews) ? config.resources.crews : []),
      ...(Array.isArray(config?.production_crews) ? config.production_crews : [])
    ];
    const fromConfig = explicit.map((crew, index) => ({
      id: String(crew.id || crew.crew_id || crew.key || `crew_${index + 1}`).trim(),
      name: String(crew.name || crew.label || crew.title || `Crew ${index + 1}`).trim(),
      color: crew.color || ''
    })).filter((crew) => crew.id);
    const crewRoleIds = new Set(['crew', 'crews', 'field_crew', 'install_crew', 'installation', 'installer', 'production', 'production_crew', 'project_work']);
    const fromUsers = (Array.isArray(users) ? users : []).filter((user) => {
      if (user.status === 'disabled') return false;
      const roles = Array.isArray(user.roles) ? user.roles : [];
      return roles.some((role) => crewRoleIds.has(String(role || '').toLowerCase()));
    }).map((user) => ({ id: String(user.id || '').trim(), name: String(user.name || user.email || user.id || '').trim() }));
    const byId = new Map();
    [...fromConfig, ...fromUsers].forEach((crew) => {
      if (crew.id && !byId.has(crew.id)) byId.set(crew.id, crew);
    });
    return Array.from(byId.values());
  }

  function projectScheduleTitle(){
    const mode = branchProjectConfig?.title_mode || 'customer_name';
    const address = ($('#rAddress')?.value || activeBaseProject?.address || reportOrderState?.address || '').trim();
    const primary = primaryContact();
    const customerName = (primary.name || '').trim();
    if (mode === 'manual') return activeBaseProject?.title || manualProjectTitle() || customerName || address || 'Project';
    if (mode === 'address') return address || customerName || 'Project';
    return customerName || address || 'Project';
  }

  function scheduleIsSchedulingView(){
    return scheduleViewMode === 'scheduling' || scheduleViewMode === 'scheduling-week' || scheduleViewMode === 'scheduling-day';
  }

  function scheduleSchedulingMode(){
    return scheduleViewMode === 'scheduling-day' ? 'day' : 'week';
  }

  function cachedSalesAppointmentUsers(){
    const Scheduling = window.PlatformScheduling;
    const config = scheduleCachedConfig || {};
    const eventType = config.event_types?.sales_appointment || {};
    const roleIds = Array.from(new Set([...(eventType.required_role_ids || []), ...(eventType.allowed_role_ids || []), ...(eventType.role_ids || []), 'sales_appointments']));
    return (Array.isArray(scheduleCachedUsers) ? scheduleCachedUsers : []).filter((user) => (
      user.status !== 'disabled' && roleIds.some((roleId) => Scheduling?.userHasRole?.(user, roleId) || (Array.isArray(user.roles) && user.roles.includes(roleId)))
    ));
  }

  function startAppointmentScheduling(){
    if (!schedulingEnabled()) return;
    scheduleModeActive = true;
    workScheduleModeActive = false;
    scheduleSchedulingTarget = 'sales';
    scheduleViewMode = cachedSalesAppointmentUsers().length > 1 ? 'scheduling-day' : 'week';
    activeWorkScheduleDraftId = '';
    schedulePreferredSalesUserId = scheduleDraft?.user?.id || schedulePreferredSalesUserId || '';
    scheduleLockTime = true;
    scheduleSmartScroll = false;
    scheduleAnchorDate = new Date();
    scheduleDraft = null;
    scheduleSelectedEventId = '';
    scheduleAssignmentEventId = '';
    ensureSchedulingProject();
    setActivePreviewTab('schedule');
    renderSchedulePanel();
  }

  function scheduleViewSwitchHtml(){
    const calendarModes = [['month', 'Month'], ['week', 'Week'], ['day', 'Day']];
    const schedulingModes = [['scheduling-week', 'Week'], ['scheduling-day', 'Day']];
    const isScheduling = scheduleIsSchedulingView();
    const surfaceButton = (id, label) => `<button type="button" class="r-schedule-view-btn ${(id === 'scheduling') === isScheduling ? 'active' : ''}" data-schedule-surface="${id}">${label}</button>`;
    const targetButton = (id, label) => `<button type="button" class="r-schedule-view-btn ${scheduleSchedulingTarget === id ? 'active' : ''}" data-schedule-target="${id}">${label}</button>`;
    const button = ([id, label]) => `<button type="button" class="r-schedule-view-btn ${scheduleViewMode === id || (id === 'scheduling-week' && scheduleViewMode === 'scheduling') ? 'active' : ''}" data-schedule-view="${id}">${label}</button>`;
    const modes = isScheduling ? schedulingModes : calendarModes;
    return `<div class="r-schedule-view-switch">
      <span class="r-schedule-view-group surface">${surfaceButton('calendar', 'Calendar')}${surfaceButton('scheduling', 'Scheduling')}</span>
      ${isScheduling ? `<span class="r-schedule-view-group target"><span class="r-schedule-view-label">Schedule</span>${targetButton('production', 'Production')}${targetButton('sales', 'Sales')}</span>` : ''}
      <span class="r-schedule-view-group ${isScheduling ? 'scheduling' : ''}"><span class="r-schedule-view-label">${isScheduling ? 'Scheduling' : 'Calendar'}</span>${modes.map(button).join('')}</span>
      ${crewManagementEnabled() ? `<button type="button" class="r-schedule-mini-action" data-crew-settings><i class="fas fa-helmet-safety"></i> Crew Settings</button>` : ''}
    </div>`;
  }

  function bindScheduleViewSwitch(rootEl){
    rootEl.querySelector('[data-crew-settings]')?.addEventListener('click', openCrewSettings);
    rootEl.querySelectorAll('[data-schedule-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.scheduleTarget || 'production';
        if (next === scheduleSchedulingTarget) return;
        scheduleSchedulingTarget = next;
        if (next === 'sales') {
          workScheduleModeActive = false;
          activeWorkScheduleDraftId = '';
        } else {
          scheduleModeActive = false;
          scheduleDraft = null;
          scheduleSelectedEventId = '';
          scheduleAssignmentEventId = '';
        }
        renderSchedulePanel();
      });
    });
    rootEl.querySelectorAll('[data-schedule-surface]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.scheduleSurface || 'calendar';
        const isScheduling = scheduleIsSchedulingView();
        if ((next === 'scheduling') === isScheduling) return;
        if (next === 'scheduling') {
          scheduleViewMode = scheduleViewMode === 'day' ? 'scheduling-day' : 'scheduling-week';
        } else {
          scheduleViewMode = 'month';
          scheduleSchedulingTarget = 'production';
          scheduleModeActive = false;
          scheduleDraft = null;
          scheduleSelectedEventId = '';
          scheduleAssignmentEventId = '';
          workScheduleModeActive = false;
          activeWorkScheduleDraftId = '';
        }
        renderSchedulePanel();
      });
    });
    rootEl.querySelectorAll('[data-schedule-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.scheduleView || 'week';
        if (next === scheduleViewMode) return;
        scheduleViewMode = next;
        if (next === 'scheduling' || next.startsWith('scheduling-')) {
          // Keep any active placement; this switch only changes the calendar surface.
        } else if (scheduleModeActive && (next === 'week' || next === 'day')) {
          // A single-person appointment can be placed in the simple calendar week/day view.
        } else {
          scheduleModeActive = false;
          scheduleDraft = null;
          scheduleSelectedEventId = '';
          scheduleAssignmentEventId = '';
        }
        renderSchedulePanel();
      });
    });
  }

  function projectScheduleEvents(){
    const Scheduling = window.PlatformScheduling;
    return scheduleProjectEvents()
      .map((event) => {
        const start = Scheduling?.eventStart?.(event) || new Date(event.start_at || event.start || 0);
        const end = Scheduling?.eventEnd?.(event) || new Date(start.getTime() + (Number(event.duration_minutes) || 60) * 60000);
        return { ...event, __start: start, __end: end };
      })
      .filter((event) => Number.isFinite(event.__start.getTime()))
      .sort((a, b) => a.__start - b.__start);
  }

  function projectEventHtml(event, slotMinutes){
    const span = Math.max(1, Math.ceil(((event.__end || new Date(event.__start.getTime() + 3600000)) - event.__start) / (Math.max(1, slotMinutes) * 60000)));
    const title = projectScheduleTitle();
    return `<div class="r-project-event" style="--rowspan:${span}">
      <div class="r-project-event-title">${escapeHtml(title)}</div>
      <div class="r-project-event-meta">${escapeHtml(eventAssignedLabel(event))}</div>
      <div class="r-project-event-meta">${escapeHtml(($('#rAddress')?.value || activeBaseProject?.address || '').trim())}</div>
    </div>`;
  }

  function scheduleMonthShift(date, months){
    const next = new Date(date);
    next.setMonth(next.getMonth() + months);
    next.setDate(1);
    next.setHours(0, 0, 0, 0);
    return next;
  }

  function renderProjectScheduleView(target, eventType = {}, config = {}){
    if (!target) return;
    const slotMinutes = Number(eventType.slot_minutes || config?.availability?.sales_appointment_slot_minutes || 30);
    const events = projectScheduleEvents();
    const times = [];
    for (let m = scheduleMinutes('08:00'); m < scheduleMinutes('18:00'); m += slotMinutes) times.push(scheduleTime(m));
    const toolbar = (label) => `
      <div class="r-schedule-toolbar">
        <div class="r-schedule-nav">
          <button type="button" data-project-schedule-nav="-1"><i class="fas fa-chevron-left"></i></button>
          <button type="button" data-project-schedule-nav="1"><i class="fas fa-chevron-right"></i></button>
          <div class="r-schedule-range">${escapeHtml(label)}</div>
        </div>
        <div class="r-schedule-toolbar-right"><span class="r-schedule-mode-pill"><i class="fas fa-calendar-days"></i>${escapeHtml(scheduleViewMode === 'month' ? 'Monthly project view' : (scheduleViewMode === 'day' ? 'Daily project view' : 'Weekly project view'))}</span></div>
      </div>`;
    const title = projectScheduleTitle();
    if (scheduleViewMode === 'day') {
      const day = new Date(scheduleAnchorDate);
      day.setHours(0, 0, 0, 0);
      const dateValue = scheduleLocalDate(day);
      target.innerHTML = `<div class="r-project-cal">${toolbar(day.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' }))}
        <div class="r-project-cal-scroll"><div class="r-project-day">
          <div class="r-project-hour-head"></div><div class="r-project-day-head">${escapeHtml(title)}</div>
          ${times.map((time) => {
            const slotEvents = events.filter((event) => scheduleLocalDate(event.__start) === dateValue && scheduleTime(scheduleMinutes(event.__start.toTimeString().slice(0,5))) === time);
            return `<div class="r-project-time">${escapeHtml(scheduleDisplayTime(time))}</div><div class="r-project-slot">${slotEvents.map((event) => projectEventHtml(event, slotMinutes)).join('')}</div>`;
          }).join('')}
        </div></div></div>`;
    } else if (scheduleViewMode === 'month') {
      const month = new Date(scheduleAnchorDate);
      month.setDate(1);
      month.setHours(0, 0, 0, 0);
      const start = scheduleStartOfWeek(month);
      const days = Array.from({ length: 42 }, (_, i) => scheduleAddDays(start, i));
      target.innerHTML = `<div class="r-project-cal">${toolbar(month.toLocaleDateString([], { month:'long', year:'numeric' }))}
        <div class="r-project-cal-scroll"><div class="r-project-month">
          ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day) => `<div class="r-project-month-head">${day}</div>`).join('')}
          ${days.map((day) => {
            const dateValue = scheduleLocalDate(day);
            const dayEvents = events.filter((event) => scheduleLocalDate(event.__start) === dateValue);
            return `<div class="r-project-month-day ${day.getMonth() === month.getMonth() ? '' : 'muted'}">
              <div class="r-project-month-num">${day.getDate()}</div>
              ${dayEvents.map((event) => `<button type="button" class="r-project-month-chip">${escapeHtml(event.__start.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }))} ${escapeHtml(title)}</button>`).join('')}
            </div>`;
          }).join('')}
        </div></div></div>`;
    } else {
      const weekStart = scheduleStartOfWeek(scheduleAnchorDate);
      const days = Array.from({ length: 7 }, (_, i) => scheduleAddDays(weekStart, i));
      const label = `${days[0].toLocaleDateString([], { month:'short', day:'numeric' })} - ${days[6].toLocaleDateString([], { month:'short', day:'numeric' })}`;
      target.innerHTML = `<div class="r-project-cal">${toolbar(label)}
        <div class="r-project-cal-scroll"><div class="r-project-week">
          <div class="r-project-hour-head"></div>
          ${days.map((day) => `<div class="r-project-day-head">${escapeHtml(day.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' }))}</div>`).join('')}
          ${times.map((time) => `
            <div class="r-project-time">${escapeHtml(scheduleDisplayTime(time))}</div>
            ${days.map((day) => {
              const dateValue = scheduleLocalDate(day);
              const slotEvents = events.filter((event) => scheduleLocalDate(event.__start) === dateValue && scheduleTime(scheduleMinutes(event.__start.toTimeString().slice(0,5))) === time);
              return `<div class="r-project-slot">${slotEvents.map((event) => projectEventHtml(event, slotMinutes)).join('')}</div>`;
            }).join('')}
          `).join('')}
        </div></div></div>`;
    }
    target.querySelectorAll('[data-project-schedule-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = Number(btn.dataset.projectScheduleNav || 0);
        scheduleAnchorDate = scheduleViewMode === 'month'
          ? scheduleMonthShift(scheduleAnchorDate, delta)
          : scheduleAddDays(scheduleAnchorDate, delta * (scheduleViewMode === 'week' ? 7 : 1));
        renderSchedulePanel();
      });
    });
  }

  function scheduleLocalDate(date){
    const Scheduling = window.PlatformScheduling;
    if (Scheduling?.localDateInput) return Scheduling.localDateInput(date);
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function scheduleMinutes(time){
    const [h, m] = String(time || '09:00').split(':').map((part) => Number(part) || 0);
    return h * 60 + m;
  }

  function scheduleTime(minutes){
    const clamped = Math.max(0, Math.min(23 * 60 + 59, Number(minutes) || 0));
    return `${String(Math.floor(clamped / 60)).padStart(2,'0')}:${String(clamped % 60).padStart(2,'0')}`;
  }

  function scheduleDisplayTime(time){
    const date = new Date(`2026-01-01T${time}:00`);
    return date.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  }

  function cssEscape(value){
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function scheduleAddDays(date, days){
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    next.setHours(0, 0, 0, 0);
    return next;
  }

  function scheduleStartOfWeek(date){
    const next = new Date(date);
    next.setHours(0, 0, 0, 0);
    next.setDate(next.getDate() - next.getDay());
    return next;
  }

  function scheduleEventsForDate(projects, dateValue, userId = null){
    const Scheduling = window.PlatformScheduling;
    const events = Scheduling?.eventsFromProjects?.(projects) || [];
    return events.filter((event) => {
      const start = Scheduling?.eventStart?.(event) || new Date(event.start_at || event.start || 0);
      if (scheduleLocalDate(start) !== dateValue) return false;
      if (!userId) return true;
      const ids = new Set([...(event.assigned_user_ids || []), ...(event.assigned_users || []).map((user) => user.id)].filter(Boolean));
      return ids.has(userId);
    });
  }

  function scheduleEventBlock(event){
    const Scheduling = window.PlatformScheduling;
    const start = Scheduling?.eventStart?.(event) || new Date(event.start_at || event.start || Date.now());
    const project = event.project_id ? scheduleRenderProjects?.find?.((item) => item.id === event.project_id) : null;
    const contact = Array.isArray(project?.contacts) ? (project.contacts.find((item) => item?.primary) || project.contacts[0]) : null;
    const title = contact?.name || project?.customer_name || event.customer_name || event.project_title || event.title || 'Appointment';
    const address = event.project_address || project?.address || '';
    const time = start.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
    const span = Math.max(1, Math.ceil((Number(event.duration_minutes) || 60) / Math.max(1, Number(scheduleRenderSlotMinutes) || 30)));
    const foreign = scheduleRenderFocusProjectId && String(event.project_id || '') !== String(scheduleRenderFocusProjectId);
    return `<div class="r-cal-appointment ${foreign ? 'foreign' : ''}" style="--span:${span}"><div class="r-cal-appt-top"><span>${escapeHtml(title)}</span><span>${escapeHtml(time)}</span></div><div class="r-cal-appt-address">${escapeHtml(address)}</div></div>`;
  }

  let scheduleRenderProjects = [];
  let scheduleRenderSlotMinutes = 30;
  let scheduleRenderFocusProjectId = '';

  function scheduleDraftBlock(start, userId, duration, slotMinutes){
    if (!scheduleDraft?.start) return '';
    const draftStart = new Date(scheduleDraft.start);
    if (Math.abs(draftStart.getTime() - start.getTime()) > 1000) return '';
    if (String(scheduleDraft.user?.id || '') !== String(userId || '')) return '';
    const contact = primaryContact();
    const title = contact?.name || manualProjectTitle() || 'Appointment';
    const address = ($('#rAddress')?.value || '').trim();
    const time = draftStart.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
    const span = Math.max(1, Math.ceil((Number(duration) || 60) / Math.max(1, Number(slotMinutes) || 30)));
    return `<div class="r-cal-appointment draft has-confirm" style="--span:${span}"><div class="r-cal-appt-top"><span>${escapeHtml(title)}</span><span>${escapeHtml(time)}</span></div><div class="r-cal-appt-address">${escapeHtml(address)}</div><span class="r-cal-draft-confirm" data-schedule-draft-confirm role="button" aria-label="Confirm appointment"><i class="fas fa-check"></i></span></div>`;
  }

  function setScheduleDraft(start, user, extra = {}){
    const durationMinutes = Math.max(1, Number(extra.duration_minutes || extra.durationMinutes || 60));
    scheduleDraft = {
      ...(scheduleDraft || {}),
      ...(extra || {}),
      start: start.toISOString(),
      end: extra.end ? new Date(extra.end).toISOString() : new Date(start.getTime() + durationMinutes * 60000).toISOString(),
      duration_minutes: durationMinutes,
      user: user?.id ? { id: user.id, name: user.name || user.email || user.id, email: user.email || '', roles: user.roles || ['sales_appointments'] } : null,
      label: `${start.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' })}, ${start.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}`,
      userLabel: user?.name || user?.email || '',
    };
    updateScheduleChoiceCard();
  }

  function scheduleTravelBlockForSlot(events, start, bufferMinutes, slotMinutes){
    if (!scheduleUseLiveTravel || !events?.length || !bufferMinutes) return '';
    const Scheduling = window.PlatformScheduling;
    const slotStart = start.getTime();
    const slotEnd = slotStart + (Number(slotMinutes) || 30) * 60000;
    const currentAddress = ($('#rAddress')?.value || '').trim();
    if (!currentAddress) return '';
    for (const event of events) {
      const eventStart = (Scheduling?.eventStart?.(event) || new Date(event.start_at || 0)).getTime();
      const eventEnd = (Scheduling?.eventEnd?.(event) || new Date(event.end_at || 0)).getTime();
      const beforeStart = eventStart - bufferMinutes * 60000;
      const afterEnd = eventEnd + bufferMinutes * 60000;
      const isBeforeTravel = slotStart >= beforeStart && slotEnd <= eventStart;
      const isAfterTravel = slotStart >= eventEnd && slotEnd <= afterEnd;
      const otherAddress = event.project_address || '';
      if ((isBeforeTravel || isAfterTravel) && otherAddress) {
        const origin = isBeforeTravel ? currentAddress : otherAddress;
        const destination = isBeforeTravel ? otherAddress : currentAddress;
        const key = `${origin}=>${destination}`;
        const cached = scheduleTravelCache.get(key);
        const label = cached ? `${cached} min` : '...';
        return `<div class="r-cal-travel" data-travel-key="${escapeHtml(key)}" data-origin="${escapeHtml(origin)}" data-destination="${escapeHtml(destination)}"><i class="far fa-clock"></i>&nbsp;${escapeHtml(label)}</div>`;
      }
    }
    return '';
  }

  function hydrateLiveTravelLabels(rootEl){
    if (!scheduleUseLiveTravel || !window.google?.maps?.DistanceMatrixService || !rootEl) return;
    const nodes = Array.from(rootEl.querySelectorAll('.r-cal-travel[data-travel-key]'));
    const pending = nodes.filter((node) => !scheduleTravelCache.has(node.dataset.travelKey));
    if (!pending.length) {
      nodes.forEach((node) => {
        const value = scheduleTravelCache.get(node.dataset.travelKey);
        if (value) node.innerHTML = `<i class="far fa-clock"></i>&nbsp;${escapeHtml(value)} min`;
      });
      return;
    }
    const service = new window.google.maps.DistanceMatrixService();
    pending.slice(0, 16).forEach((node) => {
      const key = node.dataset.travelKey;
      service.getDistanceMatrix({
        origins: [node.dataset.origin],
        destinations: [node.dataset.destination],
        travelMode: window.google.maps.TravelMode.DRIVING,
      }, (response, status) => {
        const seconds = response?.rows?.[0]?.elements?.[0]?.duration?.value;
        if (status === 'OK' && Number.isFinite(seconds)) {
          scheduleTravelCache.set(key, Math.max(1, Math.ceil(seconds / 60)));
          rootEl.querySelectorAll(`.r-cal-travel[data-travel-key="${cssEscape(key)}"]`).forEach((item) => {
            item.innerHTML = `<i class="far fa-clock"></i>&nbsp;${escapeHtml(scheduleTravelCache.get(key))} min`;
          });
        }
      });
    });
  }

  function updateScheduleChoiceCard(){
    const card = $('#rScheduleChoiceCard');
    if (!card) return;
    const text = scheduleDraft
      ? `<strong>Scheduling appointment</strong>${escapeHtml(scheduleDraft.label)}${scheduleDraft.userLabel ? ` with ${escapeHtml(scheduleDraft.userLabel)}` : ' - assign later'}.`
      : '<strong>Schedule appointment</strong>Use the Schedule tab to choose an appointment time for this project.';
    card.innerHTML = `<i class="fas fa-calendar-week"></i><div>${text}</div>`;
  }

  function scheduleHistoryEntry(event, reason){
    if (!event?.id) return null;
    return {
      reason: reason || 'rescheduled',
      changed_at: new Date().toISOString(),
      start_at: event.start_at || event.start || '',
      end_at: event.end_at || event.end || '',
      duration_minutes: Number(event.duration_minutes || 60),
      assigned_user_ids: Array.isArray(event.assigned_user_ids) ? [...event.assigned_user_ids] : [],
      assigned_users: Array.isArray(event.assigned_users) ? event.assigned_users.map((user) => ({ ...user })) : [],
      status: event.status || ''
    };
  }

  function upsertLocalProjectEvent(event){
    if (!event?.id || !activeBaseProject) return;
    const events = Array.isArray(activeBaseProject.events) ? [...activeBaseProject.events] : [];
    const idx = events.findIndex((item) => String(item.id || '') === String(event.id || ''));
    if (idx >= 0) events[idx] = { ...events[idx], ...event };
    else events.push(event);
    activeBaseProject = { ...activeBaseProject, events, updated_at: new Date().toISOString() };
    persistActiveBaseProject();
    rememberScheduleProject(activeBaseProject);
  }

  async function saveProjectEventQuiet(event, { successTitle = 'Schedule updated', successMessage = 'The schedule was saved.', failureTitle = 'Scheduling failed' } = {}){
    const Scheduling = window.PlatformScheduling;
    const orgId = scheduleOrgId();
    const project = await ensureRemoteSchedulingProject();
    if (!Scheduling || !orgId || !project?.id || !event?.id) return;
    try {
      const config = scheduleCachedConfig || await Scheduling.loadBranchConfig(orgId, scheduleBranchId());
      const saved = await Scheduling.saveProjectEvent(orgId, project, event, config);
      activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project.events || activeBaseProject?.events || [] };
      persistActiveBaseProject();
      rememberScheduleProject(activeBaseProject);
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      window.dispatchEvent(new CustomEvent('fm:projects:refresh'));
      if (successTitle) showToast(successTitle, successMessage, true);
    } catch (error) {
      showToast(failureTitle, error?.message || 'Could not save this schedule change.', false);
    }
  }

  function commitSalesAppointmentRange(event, range, user = null, durationMinutes = 60){
    if (!event?.id || !range?.start) return;
    const start = new Date(range.start);
    const rangeEnd = range.end ? new Date(range.end) : null;
    const end = rangeEnd && rangeEnd > start ? rangeEnd : new Date(start.getTime() + Math.max(1, Number(durationMinutes) || 60) * 60000);
    const assignedUserIds = user?.id ? [user.id] : [];
    const assignedUsers = user?.id ? [{ id: user.id, name: user.name || user.email || user.id, role_ids: user.roles || ['sales_appointments'] }] : [];
    const next = {
      ...event,
      schedule_history: [...(Array.isArray(event.schedule_history) ? event.schedule_history : []), scheduleHistoryEntry(event, 'rescheduled')].filter(Boolean),
      start_at: start.toISOString(),
      start: start.toISOString(),
      end_at: end.toISOString(),
      end: end.toISOString(),
      duration_minutes: Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000)),
      assigned_user_ids: assignedUserIds,
      assigned_users: assignedUsers,
      assigned_user_id: assignedUserIds[0] || '',
      assigned_user_name: assignedUsers[0]?.name || '',
      updated_at: new Date().toISOString()
    };
    upsertLocalProjectEvent(next);
    scheduleDraft = null;
    scheduleSelectedEventId = '';
    scheduleAssignmentEventId = '';
    scheduleModeActive = false;
    updateScheduleChoiceCard();
    renderScheduleLeft();
    saveProjectEventQuiet(next, {
      successTitle: 'Appointment updated',
      successMessage: `${next.title || 'Appointment'} was saved.`
    });
  }

  async function saveCalendarAppointment({ start = null, user = null, eventTypeId = 'sales_appointment' } = {}){
    const Scheduling = window.PlatformScheduling;
    const orgId = scheduleOrgId();
    const project = await ensureRemoteSchedulingProject();
    if (!start && scheduleDraft?.start) {
      start = new Date(scheduleDraft.start);
      user = scheduleDraft.user || null;
    }
    if (!Scheduling || !orgId || !project?.id || !start) {
      showToast('Scheduling unavailable', 'Could not save this appointment.', false);
      return;
    }
    let config = null;
    try {
      config = await Scheduling.loadBranchConfig(orgId, scheduleBranchId());
      const eventType = config.event_types?.[eventTypeId] || {};
      const existing = scheduleAssignmentEventId
        ? projectSalesAppointmentEvents().find((event) => String(event.id || '') === String(scheduleAssignmentEventId))
        : null;
      const duration = Number(scheduleDraft?.duration_minutes || existing?.duration_minutes || eventType.duration_minutes || 60);
      const assignedUserIds = user?.id ? [user.id] : [];
      const assignedUsers = user?.id ? [{ id: user.id, name: user.name || user.email || user.id, role_ids: user.roles || ['sales_appointments'] }] : [];
      const event = existing
        ? {
            ...existing,
            schedule_history: [...(Array.isArray(existing.schedule_history) ? existing.schedule_history : []), scheduleHistoryEntry(existing, 'rescheduled')].filter(Boolean),
            start_at: start.toISOString(),
            start: start.toISOString(),
            duration_minutes: duration,
            assigned_user_ids: assignedUserIds,
            assigned_users: assignedUsers,
            assigned_user_id: assignedUserIds[0] || '',
            assigned_user_name: assignedUsers[0]?.name || '',
            updated_at: new Date().toISOString()
          }
        : Scheduling.createProjectEvent(project, eventTypeId, {
            start,
            durationMinutes: duration,
            assignedUserIds,
            assignedUsers,
          }, config);
      const saved = await Scheduling.saveProjectEvent(orgId, project, event, config);
      activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project.events || [] };
      persistActiveBaseProject();
      rememberScheduleProject(activeBaseProject);
      scheduleDraft = null;
      scheduleSelectedEventId = '';
      scheduleAssignmentEventId = '';
      scheduleModeActive = false;
      updateScheduleChoiceCard();
      const scrollPosition = captureScheduleScroll();
      setActivePreviewTab('schedule');
      renderWorkflowState();
      setActivePreviewTab('schedule');
      restoreScheduleScroll(scrollPosition);
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      showToast(existing ? 'Appointment updated' : 'Appointment scheduled', `${event.title || 'Appointment'} was saved.`, true);
    } catch (error) {
      showToast('Scheduling failed', error?.message || 'Could not save the appointment.', false);
    }
  }

  async function unassignCurrentAppointment(event){
    const Scheduling = window.PlatformScheduling;
    const orgId = scheduleOrgId();
    const project = await ensureRemoteSchedulingProject();
    if (!Scheduling || !orgId || !project?.id || !event?.id) return;
    try {
      const config = await Scheduling.loadBranchConfig(orgId, scheduleBranchId());
      const next = {
        ...event,
        schedule_history: [...(Array.isArray(event.schedule_history) ? event.schedule_history : []), scheduleHistoryEntry(event, 'unassigned')].filter(Boolean),
        assigned_user_ids: [],
        assigned_users: [],
        assigned_user_id: '',
        assigned_user_name: '',
        updated_at: new Date().toISOString()
      };
      const saved = await Scheduling.saveProjectEvent(orgId, project, next, config);
      activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project.events || [] };
      persistActiveBaseProject();
      rememberScheduleProject(activeBaseProject);
      scheduleDraft = null;
      scheduleSelectedEventId = event.id || '';
      scheduleAssignmentEventId = event.id || '';
      scheduleModeActive = true;
      scheduleLockTime = true;
      const scrollPosition = captureScheduleScroll();
      renderWorkflowState();
      restoreScheduleScroll(scrollPosition);
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      showToast('Appointment unassigned', 'The appointment can be assigned again.', true);
    } catch (error) {
      showToast('Unassign failed', error?.message || 'Could not unassign this appointment.', false);
    }
  }

  function updateSchedulePanelConfirm(){
    const button = $('#rScheduleConfirm');
    if (!button) return;
    button.disabled = !scheduleDraft?.start;
  }

  function workRangeLabel(event){
    const start = event.__start || window.PlatformScheduling?.eventStart?.(event) || new Date(event.start_at || event.start || Date.now());
    const end = event.__end || window.PlatformScheduling?.eventEnd?.(event) || new Date(event.end_at || event.end || start.getTime() + (Number(event.duration_minutes) || 480) * 60000);
    const allDay = event.all_day !== false && event.schedule_granularity !== 'time';
    if (allDay) {
      const endDisplay = scheduleAddDays(end, -1);
      if (scheduleLocalDate(start) === scheduleLocalDate(endDisplay)) return start.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' });
      return `${start.toLocaleDateString([], { month:'short', day:'numeric' })} - ${endDisplay.toLocaleDateString([], { month:'short', day:'numeric' })}`;
    }
    return `${start.toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })} - ${end.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}`;
  }

  function newWorkDraftId(){
    workScheduleDraftSerial += 1;
    return `__work_draft_${Date.now()}_${workScheduleDraftSerial}`;
  }

  function activeWorkDraft(){
    return activeWorkScheduleDraftId ? (workScheduleDrafts.get(String(activeWorkScheduleDraftId)) || null) : null;
  }

  function workDraftList(){
    return Array.from(workScheduleDrafts.values());
  }

  function lastWorkDraft(){
    const drafts = workDraftList();
    return drafts.length ? drafts[drafts.length - 1] : null;
  }

  function setActiveWorkDraftId(id){
    activeWorkScheduleDraftId = id ? String(id) : '';
    workScheduleModeActive = !!activeWorkScheduleDraftId;
  }

  function clearAllWorkDrafts(){
    workScheduleDrafts = new Map();
    activeWorkScheduleDraftId = '';
    workScheduleModeActive = false;
  }

  function workDraftTitle(){
    return String($('#rWorkDraftTitle')?.value || activeWorkDraft()?.title || '').trim() || 'Work Section';
  }

  function startNewWorkSchedule(){
    const id = newWorkDraftId();
    workScheduleDrafts.set(id, { id, title: 'Work Section' });
    setActiveWorkDraftId(id);
    scheduleModeActive = false;
    scheduleSchedulingTarget = 'production';
    scheduleAssignmentEventId = '';
    scheduleSelectedEventId = '';
    workScheduleViewMode = 'month';
    scheduleAnchorDate = new Date();
    scheduleViewMode = scheduleCrewResources(scheduleCachedConfig, scheduleCachedUsers).length > 1 ? 'scheduling-week' : 'week';
    renderSchedulePanel();
  }

  function openCrewSettings(){
    if (!crewManagementEnabled()) return;
    scheduleCrewSettingsOpen = true;
    scheduleModeActive = false;
    renderSchedulePanel();
  }

  function setWorkScheduleDraft(next, options = {}){
    const shouldRender = options.render !== false;
    const shouldRenderLeft = options.renderLeft === true || !shouldRender;
    const current = activeWorkDraft();
    const id = String(next?.id || current?.id || newWorkDraftId());
    if (!next?.start || !next?.end) {
      workScheduleDrafts.delete(id);
      if (activeWorkScheduleDraftId === id) {
        const remaining = lastWorkDraft();
          setActiveWorkDraftId(remaining?.id || '');
      }
      if (shouldRender) renderSchedulePanelPreservingScroll();
      else if (shouldRenderLeft) renderScheduleLeft();
      return;
    }
    const previous = workScheduleDrafts.get(id) || current || {};
    const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
    const firstExplicit = (...entries) => {
      for (const [obj, key] of entries) {
        if (has(obj, key)) return obj[key];
      }
      return undefined;
    };
    const nextCrewId = firstExplicit([next, 'assigned_crew_id'], [next, 'crew_id'], [next, 'resource_id']);
    const nextCrewName = firstExplicit([next, 'assigned_crew_name'], [next, 'crew_name'], [next, 'resource_name']);
    const crewWasExplicit = nextCrewId !== undefined || nextCrewName !== undefined || has(next, 'assigned_crew');
    const assignedCrewId = nextCrewId !== undefined ? String(nextCrewId || '').trim() : (previous.assigned_crew_id || previous.crew_id || '');
    const assignedCrewName = nextCrewName !== undefined ? String(nextCrewName || '').trim() : (previous.assigned_crew_name || previous.crew_name || '');
    workScheduleDrafts.set(id, {
      ...previous,
      ...next,
      id,
      event_id: next.event_id || previous.event_id || (projectWorkEvents().some((event) => String(event.id || '') === id) ? id : ''),
      title: next.title || previous.title || 'Work Section',
      start: new Date(next.start).toISOString(),
      end: new Date(next.end).toISOString(),
      all_day: next.all_day !== false,
      schedule_granularity: next.schedule_granularity || (next.all_day === false ? 'time' : 'date'),
      crew_id: assignedCrewId,
      crew_name: assignedCrewName,
      resource_id: assignedCrewId,
      resource_name: assignedCrewName,
      assigned_crew_id: assignedCrewId,
      assigned_crew_name: assignedCrewName,
      assigned_crew: has(next, 'assigned_crew')
        ? next.assigned_crew
        : (assignedCrewId ? (crewWasExplicit ? { id: assignedCrewId, name: assignedCrewName } : (previous.assigned_crew || { id: assignedCrewId, name: assignedCrewName })) : null)
    });
    setActiveWorkDraftId(id);
    if (shouldRender) renderSchedulePanelPreservingScroll();
    else if (shouldRenderLeft) renderScheduleLeft();
  }

  async function saveWorkScheduleDraft(){
    const Scheduling = window.PlatformScheduling;
    const orgId = scheduleOrgId();
    const project = await ensureRemoteSchedulingProject();
    const workScheduleDraft = activeWorkDraft();
    if (!Scheduling || !orgId || !project?.id || !workScheduleDraft?.start || !workScheduleDraft?.end) {
      showToast('Work schedule unavailable', 'Choose a work start and end before confirming.', false);
      return;
    }
    try {
      const config = await Scheduling.loadBranchConfig(orgId, scheduleBranchId());
      scheduleCachedConfig = config;
      await loadLaborCrewSettings();
      const start = new Date(workScheduleDraft.start);
      const end = new Date(workScheduleDraft.end);
      const existingId = workScheduleDraft.event_id || workScheduleDraft.id || '';
      const existing = existingId ? scheduleProjectEvents().find((event) => String(event.id || '') === String(existingId)) : null;
      const crews = scheduleCrewResources(config, scheduleCachedUsers);
      const fallbackCrew = defaultWorkCrewResource(crews);
      const assignedCrewId = workScheduleDraft.assigned_crew_id || workScheduleDraft.crew_id || fallbackCrew?.id || '';
      const assignedCrewName = workScheduleDraft.assigned_crew_name || workScheduleDraft.crew_name || fallbackCrew?.name || '';
      const assignedCrew = assignedCrewId ? (workScheduleDraft.assigned_crew || { id: assignedCrewId, name: assignedCrewName }) : null;
      const base = existing
        ? Scheduling.updateProjectEventRange(existing, {
            start,
            end,
            all_day: workScheduleDraft.all_day,
            schedule_granularity: workScheduleDraft.schedule_granularity,
            assigned_crew_id: assignedCrewId,
            assigned_crew_name: assignedCrewName,
            assigned_crew: assignedCrew
          })
        : Scheduling.createProjectWorkEvent(project, {
            title: workDraftTitle(),
            start,
            end,
            all_day: workScheduleDraft.all_day,
            schedule_granularity: workScheduleDraft.schedule_granularity,
            assigned_crew_id: assignedCrewId,
            assigned_crew_name: assignedCrewName,
            assigned_crew: assignedCrew,
          }, config);
      const event = {
        ...base,
        title: workDraftTitle(),
        start_date: workScheduleDraft.all_day !== false ? scheduleLocalDate(start) : '',
        end_date: workScheduleDraft.all_day !== false ? scheduleLocalDate(scheduleAddDays(end, -1)) : '',
        assigned_crew_id: assignedCrewId,
        assigned_crew_name: assignedCrewName,
        assigned_crew: assignedCrew,
        updated_at: new Date().toISOString()
      };
      const saved = await Scheduling.saveProjectEvent(orgId, project, event, config);
      activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project.events || [] };
      persistActiveBaseProject();
      rememberScheduleProject(activeBaseProject);
      workScheduleDrafts.delete(String(workScheduleDraft.id || ''));
      const remaining = lastWorkDraft();
      setActiveWorkDraftId(remaining?.id || '');
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      window.dispatchEvent(new CustomEvent('fm:projects:refresh'));
      const scrollPosition = captureScheduleScroll();
      setActivePreviewTab('schedule');
      renderSchedulePanel();
      restoreScheduleScroll(scrollPosition);
      showToast(existing ? 'Work schedule updated' : 'Work scheduled', `${event.title || 'Work Section'} was saved.`, true);
    } catch (error) {
      showToast('Work scheduling failed', error?.message || 'Could not save this work section.', false);
    }
  }

  function cancelWorkDraft(){
    const id = activeWorkScheduleDraftId;
    if (id) workScheduleDrafts.delete(String(id));
    const remaining = lastWorkDraft();
    setActiveWorkDraftId(remaining?.id || '');
    renderSchedulePanel();
  }

  function scheduleAppointmentTilesHtml(){
    const appointments = projectSalesAppointmentEvents();
    if (!appointments.length) return `<div class="r-schedule-empty-small">No sales appointments scheduled.</div>`;
    return `<div class="r-schedule-tile-list">${appointments.map((event) => `
      <div class="r-schedule-tile">
        <div class="r-schedule-tile-title">${escapeHtml(event.title || 'Sales Appointment')}</div>
        <div class="r-schedule-tile-meta">${escapeHtml(formatEventTime(event))}</div>
        <div class="r-schedule-tile-meta">${escapeHtml(eventAssignedLabel(event))}</div>
      </div>
    `).join('')}</div>`;
  }

  function workTilesHtml(){
    const events = projectWorkEvents();
    if (!events.length) return `<div class="r-schedule-empty-small">No work sections scheduled.</div>`;
    return `<div class="r-schedule-tile-list">${events.map((event) => `
      <button type="button" class="r-schedule-tile" data-edit-work="${escapeHtml(event.id || '')}">
        <div class="r-schedule-tile-title">${escapeHtml(event.title || 'Work Section')}</div>
        <div class="r-schedule-tile-meta">${escapeHtml(workRangeLabel(event))}</div>
      </button>
    `).join('')}</div>`;
  }

  function workDraftCardHtml(){
    const workScheduleDraft = activeWorkDraft();
    if (!workScheduleDraft?.start || !workScheduleDraft?.end) {
      return `<div class="r-schedule-empty-small">Click or drag on the calendar to place a work section.</div>`;
    }
    const assignment = workAssignmentSelectHtml(workScheduleDraft);
    return `<div class="r-work-draft-card">
      <div class="r-work-title-row ${assignment ? '' : 'no-assignment'}">
        <label>Title<input id="rWorkDraftTitle" type="text" value="${escapeHtml(workScheduleDraft.title || 'Work Section')}"></label>
        ${assignment}
      </div>
      <div class="r-schedule-tile-meta">${escapeHtml(workRangeLabel({
        ...workScheduleDraft,
        __start: new Date(workScheduleDraft.start),
        __end: new Date(workScheduleDraft.end)
      }))}</div>
      <div class="r-work-confirm-row">
        <button type="button" class="r-schedule-mini-action" data-work-cancel>Cancel</button>
        <button type="button" class="r-schedule-mini-action primary" data-work-confirm><i class="fas fa-check"></i> Confirm</button>
      </div>
    </div>`;
  }

  function updateVisibleWorkAssignment(workId, payload = {}){
    const id = String(workId || '');
    if (!id) return;
    document.querySelectorAll(`.prs-work-chip[data-prs-event-id="${cssEscape(id)}"]`).forEach((chip) => {
      chip.classList.toggle('awaiting-crew', payload.awaiting_crew === true);
      let crew = chip.querySelector('.prs-crew');
      const label = payload.awaiting_crew ? 'Waiting for crew' : (payload.assigned_crew_name || payload.crew_name || payload.crew_label || '');
      if (!label) {
        crew?.remove();
        return;
      }
      if (!crew) {
        crew = document.createElement('span');
        crew.className = 'prs-crew';
        const title = chip.querySelector('.prs-title');
        title?.insertAdjacentElement('afterend', crew);
      }
      crew.classList.toggle('waiting', payload.awaiting_crew === true);
      crew.textContent = label;
    });
  }

  function leftContentRoot(){
    if (!state.leftRoot) return null;
    let list = state.leftRoot.querySelector('#rProposalList');
    if (!list) {
      state.leftRoot.innerHTML = `
        <div class="r-step-shell" style="grid-template-rows:1fr"><div class="r-step-inner"><div class="r-step-body">
          <label id="rProposalLabel">Schedule</label>
          <div class="r-proposal-listing" id="rProposalList"></div>
        </div></div></div>
      `;
      list = state.leftRoot.querySelector('#rProposalList');
    }
    return list;
  }

  function setScheduleWorkspaceChrome(active){
    const overlay = state.context?.overlayRoot || state.context?.roots?.overlay || $('#rOverlay');
    if (!overlay) return;
    const hasHostOverride = typeof state.host?.setLeftColumnOverride === 'function';
    if (active) {
      overlay.classList.add('schedule-workspace');
      if (hasHostOverride) callHost('setLeftColumnOverride', true, 'schedule');
      else {
        overlay.classList.add('left-override');
        overlay.dataset.leftOverrideTab = 'schedule';
      }
      if (state.context?.activeTab !== 'proposal' && !state.context?.proposalWorkspaceOpen) overlay.classList.remove('proposal-workspace');
    } else {
      overlay.classList.remove('schedule-workspace');
      if (hasHostOverride) callHost('setLeftColumnOverride', false, 'schedule');
      else if (overlay.dataset.leftOverrideTab === 'schedule') {
        overlay.classList.remove('left-override');
        delete overlay.dataset.leftOverrideTab;
      }
      if (state.context?.activeTab !== 'proposal' && !state.context?.proposalWorkspaceOpen) overlay.classList.remove('proposal-workspace');
    }
  }

  function clearScheduleLeft(){
    const list = state.leftRoot?.querySelector?.('#rProposalList');
    list?.querySelector?.('.r-schedule-left-shell')?.remove();
    const tab = String(state.context?.activeTab || '');
    const keepSharedRail = tab === 'proposal' || tab === 'materials';
    if (!keepSharedRail && list && !list.innerHTML.trim()) {
      state.leftRoot.classList.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
    }
  }

  function contextScheduleActive(context = {}){
    if (context.active !== undefined) return context.active !== false;
    if (context.activeTab !== undefined) return String(context.activeTab || '') === 'schedule';
    return false;
  }

  function leftStatusHtml(){
    if (scheduleModeActive) {
      const assignment = salesAssignmentSelectHtml();
      return `<section class="r-schedule-section">
        <div class="r-schedule-section-head">
          <div class="r-schedule-section-title"><i class="fas fa-calendar-check"></i> Sales Appointment</div>
          ${assignment}
        </div>
        <div class="r-schedule-left-status"><strong>${scheduleDraft?.start ? escapeHtml(scheduleDraft.label || 'Appointment selected') : 'Scheduling appointment'}</strong>${scheduleDraft?.start ? 'Place, adjust, or confirm this appointment on the calendar.' : 'Choose an available appointment slot on the calendar.'}</div>
      </section>`;
    }
    const workScheduleDraft = activeWorkDraft();
    if (workScheduleDraft?.start && workScheduleDraft?.end) {
      return `<section class="r-schedule-section">
        <div class="r-schedule-section-head"><div class="r-schedule-section-title"><i class="fas fa-pen-to-square"></i> Work Section</div></div>
        ${workDraftCardHtml()}
      </section>`;
    }
    if (workScheduleModeActive) {
      return `<div class="r-schedule-left-status"><strong>Scheduling work</strong>Click a start and end date, or drag across the calendar.</div>`;
    }
    return '';
  }

  function renderScheduleLeft(){
    if (!state.leftRoot || !state.active) return;
    const target = leftContentRoot();
    if (!target) return;
    state.leftRoot.classList.add('visible', 'mode-edit');
    state.leftRoot.classList.remove('mode-list', 'mode-send');
    const label = state.leftRoot.querySelector('#rProposalLabel');
    if (label) {
      label.textContent = 'Schedule';
      label.hidden = true;
    }
    target.innerHTML = `<div class="r-schedule-left-shell"><div class="r-schedule-left-scroll">
      <section class="r-schedule-section">
        <div class="r-schedule-section-head">
          <div class="r-schedule-section-title"><i class="fas fa-calendar-check"></i> Sales Appointments</div>
          <button type="button" class="r-schedule-mini-action primary" data-new-appointment><i class="fas fa-plus"></i> New</button>
        </div>
        ${scheduleAppointmentTilesHtml()}
      </section>
      <section class="r-schedule-section">
        <div class="r-schedule-section-head">
          <div class="r-schedule-section-title"><i class="fas fa-hammer"></i> Schedule Work</div>
          <button type="button" class="r-schedule-mini-action" data-new-work><i class="fas fa-plus"></i> New</button>
        </div>
        ${workTilesHtml()}
      </section>
      ${leftStatusHtml()}
    </div></div>`;
    target.querySelector('[data-new-appointment]')?.addEventListener('click', startAppointmentScheduling);
    target.querySelector('[data-new-work]')?.addEventListener('click', startNewWorkSchedule);
    target.querySelector('[data-work-confirm]')?.addEventListener('click', saveWorkScheduleDraft);
    target.querySelector('[data-work-cancel]')?.addEventListener('click', cancelWorkDraft);
    target.querySelector('#rWorkDraftTitle')?.addEventListener('input', (event) => {
      const draft = activeWorkDraft();
      if (draft) {
        draft.title = event.target.value || 'Work Section';
        workScheduleDrafts.set(String(draft.id || ''), draft);
      }
    });
    target.querySelector('#rWorkAssignment')?.addEventListener('change', (event) => {
      const draft = activeWorkDraft();
      if (!draft?.start || !draft?.end) return;
      const crews = scheduleCrewResources(scheduleCachedConfig, scheduleCachedUsers);
      const payload = crewPayloadForSelection(event.target.value, crews);
      setWorkScheduleDraft({ ...draft, ...payload }, { render: false, renderLeft: true });
      updateVisibleWorkAssignment(draft.id, payload);
    });
    target.querySelector('#rSalesAssignment')?.addEventListener('change', (event) => {
      const salespeople = cachedSalesAppointmentUsers();
      const user = salespeople.find((item) => String(item.id || '') === String(event.target.value || '')) || null;
      schedulePreferredSalesUserId = user?.id || '';
      if (scheduleDraft?.start) {
        setScheduleDraft(new Date(scheduleDraft.start), user, {
          ...scheduleDraft,
          user: undefined,
          userLabel: undefined
        });
      }
      renderScheduleLeft();
    });
    target.querySelectorAll('[data-edit-work]').forEach((btn) => btn.addEventListener('click', () => {
      const event = projectWorkEvents().find((item) => String(item.id || '') === String(btn.dataset.editWork || ''));
      if (!event) return;
      workScheduleModeActive = true;
      scheduleModeActive = false;
      scheduleAssignmentEventId = '';
      scheduleSelectedEventId = '';
      const id = String(event.id || '');
      workScheduleDrafts.set(id, {
        id: event.id,
        event_id: event.id,
        title: event.title || 'Work Section',
        start: event.__start.toISOString(),
        end: event.__end.toISOString(),
        all_day: event.all_day !== false,
        schedule_granularity: event.schedule_granularity || (event.all_day === false ? 'time' : 'date'),
        crew_id: workCrewId(event),
        crew_name: workCrewName(event),
        assigned_crew_id: workCrewId(event),
        assigned_crew_name: workCrewName(event),
        assigned_crew: event.assigned_crew || (workCrewId(event) ? { id: workCrewId(event), name: workCrewName(event) } : null)
      });
      setActiveWorkDraftId(id);
      scheduleAnchorDate = event.__start;
      renderSchedulePanel();
    }));
  }

  function renderWorkScheduler(target){
    const Scheduling = window.PlatformScheduling;
    if (!target) return;
    if (!window.PlatformScheduleView?.renderProjectRangeScheduler || !Scheduling) {
      target.innerHTML = `<div class="r-schedule-empty"><i class="fas fa-calendar"></i>Work scheduling tools are unavailable.</div>`;
      return;
    }
    const forceCrewScheduler = scheduleIsSchedulingView();
    const crews = scheduleCrewResources(scheduleCachedConfig, scheduleCachedUsers);
    const crewRows = crews.length ? crews : (forceCrewScheduler ? [{ id: 'default_crew', name: 'Crew' }] : []);
    const currentWorkEvents = projectWorkEvents();
    const calendarWorkEvents = currentWorkEvents.map((event) => decorateWorkEventForCalendar(event, crews));
    const calendarEvents = [...calendarWorkEvents, ...projectSalesAppointmentEvents()];
    const schedulerWorkEvents = forceCrewScheduler ? allProjectWorkEvents() : currentWorkEvents;
    const editableWorkEventIds = currentWorkEvents.map((event) => String(event.id || '')).filter(Boolean);
    if (forceCrewScheduler && scheduleSchedulingMode() === 'day' && crewRows.length && window.PlatformScheduleView?.renderResourceTimeScheduler) {
      window.PlatformScheduleView.renderResourceTimeScheduler(target, {
        Scheduling,
        config: scheduleCachedConfig || null,
        project: activeBaseProject || null,
        events: schedulerWorkEvents,
        drafts: workDraftList(),
        activeDraftId: activeWorkScheduleDraftId,
        resources: crewRows,
        allowCreate: workScheduleModeActive && !activeWorkDraft()?.event_id,
        allowEdit: true,
        editableEventIds: editableWorkEventIds,
        date: scheduleAnchorDate,
        slotMinutes: 30,
        smartScroll: scheduleSmartScroll,
        modeLabel: 'Production daily view',
        onSmartScrollToggle(next){
          scheduleSmartScroll = !!next;
          const scrollPosition = captureScheduleScroll();
          renderSchedulePanel();
          restoreScheduleScroll(scrollPosition);
        },
        onNavigate(nextDate){ scheduleAnchorDate = nextDate; renderSchedulePanel(); },
        onDraftChange(next){ setWorkScheduleDraft(next, { render: false, renderLeft: true }); },
        onDraftConfirm(){ saveWorkScheduleDraft(); },
        onEventRangeChange(event, range){
          setWorkScheduleDraft({
            id: event.id,
            event_id: event.event_id || event.id,
            title: event.title || 'Work Section',
            start: range.start,
            end: range.end,
            all_day: false,
            schedule_granularity: 'time',
            crew_id: range.crew_id || range.assigned_crew_id || '',
            crew_name: range.crew_name || range.assigned_crew_name || '',
            assigned_crew_id: range.assigned_crew_id || range.crew_id || '',
            assigned_crew_name: range.assigned_crew_name || range.crew_name || '',
            assigned_crew: range.assigned_crew || null
          }, { render: false, renderLeft: true });
        },
        onEventClick(event){
          if (!event?.id) return;
          setWorkScheduleDraft({
            id: event.id,
            event_id: event.event_id || event.id,
            title: event.title || 'Work Section',
            start: window.PlatformScheduling?.eventStart?.(event) || event.start_at,
            end: window.PlatformScheduling?.eventEnd?.(event) || event.end_at,
            all_day: false,
            schedule_granularity: 'time',
            crew_id: workCrewId(event),
            crew_name: workCrewName(event),
            assigned_crew_id: workCrewId(event),
            assigned_crew_name: workCrewName(event),
            assigned_crew: event.assigned_crew || (workCrewId(event) ? { id: workCrewId(event), name: workCrewName(event) } : null)
          }, { render: false, renderLeft: true });
        },
        onDraftSelect(draft){
          if (!draft?.id) return;
          setActiveWorkDraftId(draft.id);
          renderScheduleLeft();
        }
      });
      return;
    }
    if (forceCrewScheduler && crewRows.length && window.PlatformScheduleView?.renderResourceDayScheduler) {
      window.PlatformScheduleView.renderResourceDayScheduler(target, {
        Scheduling,
        config: scheduleCachedConfig || null,
        project: activeBaseProject || null,
        events: schedulerWorkEvents,
        drafts: workDraftList(),
        activeDraftId: activeWorkScheduleDraftId,
        resources: crewRows,
        allowCreate: workScheduleModeActive && !activeWorkDraft()?.event_id,
        allowEdit: true,
        editableEventIds: editableWorkEventIds,
        mode: scheduleSchedulingMode(),
        dayCount: 180,
        date: scheduleAnchorDate,
        smartScroll: false,
        modeLabel: 'Production weekly view',
        onNavigate(nextDate){ scheduleAnchorDate = nextDate; renderSchedulePanel(); },
        onDraftChange(next){ setWorkScheduleDraft(next, { render: false, renderLeft: true }); },
        onDraftConfirm(){ saveWorkScheduleDraft(); },
        onEventRangeChange(event, range){
          setWorkScheduleDraft({
            id: event.id,
            event_id: event.event_id || event.id,
            title: event.title || 'Work Section',
            start: range.start,
            end: range.end,
            all_day: range.all_day !== false,
            schedule_granularity: range.schedule_granularity || (range.all_day === false ? 'time' : 'date'),
            crew_id: range.crew_id || range.assigned_crew_id || '',
            crew_name: range.crew_name || range.assigned_crew_name || '',
            assigned_crew_id: range.assigned_crew_id || range.crew_id || '',
            assigned_crew_name: range.assigned_crew_name || range.crew_name || '',
            assigned_crew: range.assigned_crew || null
          }, { render: false, renderLeft: true });
        },
        onEventClick(event){
          if (!event?.id) return;
          setWorkScheduleDraft({
            id: event.id,
            event_id: event.event_id || event.id,
            title: event.title || 'Work Section',
            start: window.PlatformScheduling?.eventStart?.(event) || event.start_at,
            end: window.PlatformScheduling?.eventEnd?.(event) || event.end_at,
            all_day: event.all_day !== false,
            schedule_granularity: event.schedule_granularity || (event.all_day === false ? 'time' : 'date'),
            crew_id: workCrewId(event),
            crew_name: workCrewName(event),
            assigned_crew_id: workCrewId(event),
            assigned_crew_name: workCrewName(event),
            assigned_crew: event.assigned_crew || (workCrewId(event) ? { id: workCrewId(event), name: workCrewName(event) } : null)
          }, { render: false, renderLeft: true });
        },
        onDraftSelect(draft){
          if (!draft?.id) return;
          setActiveWorkDraftId(draft.id);
          renderScheduleLeft();
        }
      });
      return;
    }
    window.PlatformScheduleView.renderProjectRangeScheduler(target, {
      Scheduling,
      config: scheduleCachedConfig || null,
      project: activeBaseProject || null,
      events: calendarEvents,
      drafts: workDraftList(),
      activeDraftId: activeWorkScheduleDraftId,
      allowCreate: workScheduleModeActive && !activeWorkDraft()?.event_id,
      allowEdit: true,
      mode: scheduleIsSchedulingView() ? scheduleSchedulingMode() : (['month','week','day'].includes(scheduleViewMode) ? scheduleViewMode : workScheduleViewMode),
      showModeSwitch: false,
      date: scheduleAnchorDate,
      slotMinutes: 30,
      defaultDraftPayload(){ return workCrewCalendarPayload({}, crews); },
      onNavigate(nextDate){ scheduleAnchorDate = nextDate; renderSchedulePanel(); },
      onModeChange(nextMode){
        if (scheduleIsSchedulingView()) scheduleViewMode = nextMode === 'day' ? 'scheduling-day' : 'scheduling-week';
        else scheduleViewMode = ['month','week','day'].includes(nextMode) ? nextMode : 'month';
        workScheduleViewMode = ['month','week','day'].includes(nextMode) ? nextMode : workScheduleViewMode;
        renderSchedulePanel();
      },
      onDraftChange(next){ setWorkScheduleDraft(next, { render: false, renderLeft: true }); },
      onDraftConfirm(){ saveWorkScheduleDraft(); },
      onEventRangeChange(event, range){
        const crewPayload = workCrewCalendarPayload(event, crews);
        setWorkScheduleDraft({
          id: event.id,
          event_id: event.event_id || event.id,
          title: event.title || 'Work Section',
          start: range.start,
          end: range.end,
          all_day: range.all_day,
          schedule_granularity: range.schedule_granularity,
          ...crewPayload
        }, { render: false, renderLeft: true });
      },
      onEventClick(event){
        if (!event?.id) return;
        const crewPayload = workCrewCalendarPayload(event, crews);
        setWorkScheduleDraft({
          id: event.id,
          event_id: event.event_id || event.id,
          title: event.title || 'Work Section',
          start: window.PlatformScheduling?.eventStart?.(event) || event.start_at,
          end: window.PlatformScheduling?.eventEnd?.(event) || event.end_at,
          all_day: event.all_day !== false,
          schedule_granularity: event.schedule_granularity || (event.all_day === false ? 'time' : 'date'),
          ...crewPayload
        }, { render: false, renderLeft: true });
      },
      onDraftSelect(draft){
        if (!draft?.id) return;
        setActiveWorkDraftId(draft.id);
        renderScheduleLeft();
      }
    });
  }

  function renderProjectScheduleHome(){
    const panel = $('#rSchedulePanel');
    if (!panel) return;
    panel.classList.add('work-mode');
    setScheduleWorkspaceChrome(state.active);
    renderScheduleLeft();
    const isScheduling = scheduleIsSchedulingView();
    panel.innerHTML = `
      <div class="r-schedule-head">
        <div>
          <h2 class="r-schedule-title">Schedule</h2>
          <div class="r-schedule-sub">${escapeHtml(isScheduling ? 'Assign work by crew and date.' : 'Project calendar views show scheduled work and appointments.')}</div>
        </div>
        <div class="r-schedule-head-actions">${scheduleViewSwitchHtml()}</div>
      </div>
      <div class="r-schedule-calendar work-calendar"></div>
    `;
    bindScheduleViewSwitch(panel);
    renderWorkScheduler(panel.querySelector('.work-calendar'));
    if (scheduleWorkResourceDataLoaded) return;
    scheduleWorkResourceDataLoaded = true;
    (async () => {
      if (!window.PlatformScheduling || !scheduleOrgId()) return;
      try {
        const config = await window.PlatformScheduling.loadBranchConfig(scheduleOrgId(), scheduleBranchId());
        const users = await window.PlatformScheduling.listUsers(scheduleOrgId(), config).catch(() => []);
        const projects = await window.PlatformScheduling.listProjects(scheduleOrgId(), config).catch(() => []);
        rememberScheduleData(config, users, projects);
        await loadLaborCrewSettings();
        let promotedToScheduling = false;
        if (workScheduleModeActive && !scheduleModeActive && !scheduleIsSchedulingView() && scheduleCrewResources(config, users).length > 1) {
          scheduleViewMode = 'scheduling-week';
          promotedToScheduling = true;
        }
        if (state.active) renderSchedulePanel();
      } catch (_) {}
    })();
  }

  function renderCrewSettingsPanel(){
    const panel = $('#rSchedulePanel');
    if (!panel) return;
    panel.classList.add('work-mode');
    setScheduleWorkspaceChrome(state.active);
    renderScheduleLeft();
    const orgId = scheduleOrgId();
    const branchId = scheduleBranchId();
    const money = (cents) => {
      const value = Number(cents || 0) / 100;
      return value ? value.toFixed(2) : '';
    };
    const cents = (value) => Math.max(0, Math.round(Number(value || 0) * 100));
    const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
    const memberRowHtml = (member = {}) => `
      <div class="r-crew-member-row" data-member-id="${escapeHtml(member.id || uid('member'))}">
        <input data-member-name value="${escapeHtml(member.name || '')}" placeholder="Name">
        <input data-member-email value="${escapeHtml(member.email || '')}" placeholder="Email">
        <select data-member-pay-type>${['hourly','piece_rate','salary','hybrid'].map((type) => `<option value="${type}" ${String(member.compensation_plan?.type || 'hourly') === type ? 'selected' : ''}>${type.replace('_', ' ')}</option>`).join('')}</select>
        <input data-member-hourly type="number" step="0.01" value="${escapeHtml(money(member.compensation_plan?.hourly_rate_cents))}" placeholder="Hourly">
        <button type="button" class="r-schedule-mini-action" data-remove-member><i class="fas fa-xmark"></i></button>
      </div>`;
    const collectCrew = (card, existing = {}) => {
      const members = Array.from(card.querySelectorAll('.r-crew-member-row')).map((row) => ({
        id: row.dataset.memberId || uid('member'),
        name: row.querySelector('[data-member-name]')?.value || 'Crew member',
        email: row.querySelector('[data-member-email]')?.value || '',
        role: 'laborer',
        active: true,
        compensation_plan: {
          type: row.querySelector('[data-member-pay-type]')?.value || 'hourly',
          hourly_rate_cents: cents(row.querySelector('[data-member-hourly]')?.value),
          salary_rate_cents: 0,
          salary_period: 'week',
          piece_rates: []
        }
      }));
      const foremanId = card.querySelector('[data-crew-foreman]')?.value || '';
      return {
        ...existing,
        id: existing.id || card.dataset.crewId || uid('crew'),
        name: card.querySelector('[data-crew-name]')?.value || 'Crew',
        foreman_member_id: foremanId,
        default_contact_member_id: foremanId,
        project_types: String(card.querySelector('[data-project-types]')?.value || '').split(',').map((item) => item.trim()).filter(Boolean),
        compensation_plan: {
          type: card.querySelector('[data-crew-pay-type]')?.value || 'hourly',
          hourly_rate_cents: cents(card.querySelector('[data-crew-hourly]')?.value),
          salary_rate_cents: cents(card.querySelector('[data-crew-salary]')?.value),
          salary_period: 'week',
          piece_rates: [],
          notes: card.querySelector('[data-crew-notes]')?.value || ''
        },
        members
      };
    };
    const draw = (settings = {}, statusText = '') => {
      const crews = Array.isArray(settings.crews) ? settings.crews : [];
      const cardHtml = (crew = {}) => {
        const members = Array.isArray(crew.members) ? crew.members : [];
        const archived = String(crew.status || 'active') === 'archived' || crew.archived_at;
        const foremanId = crew.foreman_member_id || crew.default_contact_member_id || '';
        return `<section class="r-schedule-section r-crew-settings-card ${archived ? 'archived' : ''}" data-crew-id="${escapeHtml(crew.id || '')}">
          <div class="r-crew-settings-grid">
            <label class="r-crew-field">Crew<input data-crew-name value="${escapeHtml(crew.name || '')}" placeholder="Install Crew A"></label>
            <label class="r-crew-field">Foreman<select data-crew-foreman><option value="">No foreman</option>${members.map((member) => `<option value="${escapeHtml(member.id)}" ${String(member.id) === String(foremanId) ? 'selected' : ''}>${escapeHtml(member.name || member.email || 'Member')}</option>`).join('')}</select></label>
            <label class="r-crew-field wide">Project types<input data-project-types value="${escapeHtml((crew.project_types || []).join(', '))}" placeholder="roofing, gutters, siding"></label>
            <label class="r-crew-field">Plan<select data-crew-pay-type>${['hourly','piece_rate','salary','hybrid'].map((type) => `<option value="${type}" ${String(crew.compensation_plan?.type || 'hourly') === type ? 'selected' : ''}>${type.replace('_', ' ')}</option>`).join('')}</select></label>
            <label class="r-crew-field">Hourly<input data-crew-hourly type="number" step="0.01" value="${escapeHtml(money(crew.compensation_plan?.hourly_rate_cents))}"></label>
            <label class="r-crew-field">Salary<input data-crew-salary type="number" step="0.01" value="${escapeHtml(money(crew.compensation_plan?.salary_rate_cents))}"></label>
            <label class="r-crew-field wide">Notes<input data-crew-notes value="${escapeHtml(crew.compensation_plan?.notes || '')}"></label>
          </div>
          <div class="r-crew-member-head"><strong>Laborers</strong><button type="button" class="r-schedule-mini-action" data-add-member><i class="fas fa-user-plus"></i> Add member</button></div>
          <div data-member-list>${members.map(memberRowHtml).join('') || '<div class="r-schedule-empty-small">No laborers yet.</div>'}</div>
          <div class="r-crew-settings-actions">
            ${archived ? '<button type="button" class="r-schedule-mini-action" data-restore-crew><i class="fas fa-rotate-left"></i> Restore</button>' : '<button type="button" class="r-schedule-mini-action" data-archive-crew><i class="fas fa-box-archive"></i> Archive</button>'}
            <button type="button" class="r-schedule-mini-action primary" data-save-crew><i class="fas fa-save"></i> Save</button>
          </div>
        </section>`;
      };
      const active = crews.filter((crew) => String(crew.status || 'active') !== 'archived' && !crew.archived_at);
      const archived = crews.filter((crew) => String(crew.status || 'active') === 'archived' || crew.archived_at);
      panel.innerHTML = `<div class="r-schedule-head">
          <div>
            <h2 class="r-schedule-title">Crew Settings</h2>
            <div class="r-schedule-sub">Manage crews, foremen, capabilities, and compensation plans.</div>
          </div>
          <div class="r-schedule-head-actions"><button type="button" class="r-schedule-mini-action" data-back-schedule><i class="fas fa-chevron-left"></i> Back</button><button type="button" class="r-schedule-mini-action primary" data-add-crew><i class="fas fa-plus"></i> New Crew</button></div>
        </div>
        <div class="r-crew-settings-status">${escapeHtml(statusText)}</div>
        <div class="r-crew-settings-list">${active.map(cardHtml).join('') || '<div class="r-schedule-empty-small">No active crews yet.</div>'}${archived.length ? `<div class="r-schedule-section-title archived-title">Archived crews</div>${archived.map(cardHtml).join('')}` : ''}</div>`;
      const status = panel.querySelector('.r-crew-settings-status');
      panel.querySelector('[data-back-schedule]')?.addEventListener('click', () => {
        scheduleCrewSettingsOpen = false;
        renderSchedulePanel();
      });
      panel.querySelector('[data-add-crew]')?.addEventListener('click', async () => {
        if (status) status.textContent = 'Creating crew...';
        try {
          const result = await window.PlatformAPI.labor.upsertCrew(orgId, branchId, { name: 'New Crew', members: [] });
          scheduleCachedLaborSettings = result.settings || null;
          window.dispatchEvent(new CustomEvent('fm:labor-crews:updated', { detail: { settings: result.settings } }));
          draw(result.settings || {}, 'Crew created.');
        } catch (error) {
          if (status) status.textContent = error?.message || 'Could not create crew.';
        }
      });
      panel.querySelectorAll('.r-crew-settings-card').forEach((card) => {
        const existing = crews.find((crew) => String(crew.id || '') === String(card.dataset.crewId || '')) || {};
        card.querySelector('[data-add-member]')?.addEventListener('click', () => {
          const list = card.querySelector('[data-member-list]');
          if (!list) return;
          list.querySelector('.r-schedule-empty-small')?.remove();
          list.insertAdjacentHTML('beforeend', memberRowHtml({ id: uid('member'), name: 'Crew member' }));
          list.lastElementChild?.querySelector('[data-remove-member]')?.addEventListener('click', (event) => event.currentTarget.closest('.r-crew-member-row')?.remove());
        });
        card.querySelectorAll('[data-remove-member]').forEach((btn) => btn.addEventListener('click', () => btn.closest('.r-crew-member-row')?.remove()));
        card.querySelector('[data-save-crew]')?.addEventListener('click', async () => {
          if (status) status.textContent = 'Saving crew...';
          try {
            const result = await window.PlatformAPI.labor.upsertCrew(orgId, branchId, collectCrew(card, existing));
            scheduleCachedLaborSettings = result.settings || null;
            window.dispatchEvent(new CustomEvent('fm:labor-crews:updated', { detail: { settings: result.settings } }));
            draw(result.settings || {}, 'Crew saved.');
          } catch (error) {
            if (status) status.textContent = error?.message || 'Could not save crew.';
          }
        });
        card.querySelector('[data-archive-crew]')?.addEventListener('click', async () => {
          if (!existing.id) return;
          if (status) status.textContent = 'Archiving crew...';
          try {
            const result = await window.PlatformAPI.labor.archiveCrew(orgId, branchId, existing.id);
            scheduleCachedLaborSettings = result.settings || null;
            window.dispatchEvent(new CustomEvent('fm:labor-crews:updated', { detail: { settings: result.settings } }));
            draw(result.settings || {}, 'Crew archived.');
          } catch (error) {
            if (status) status.textContent = error?.message || 'Could not archive crew.';
          }
        });
        card.querySelector('[data-restore-crew]')?.addEventListener('click', async () => {
          if (status) status.textContent = 'Restoring crew...';
          try {
            const result = await window.PlatformAPI.labor.upsertCrew(orgId, branchId, { ...collectCrew(card, existing), status: 'active', archived_at: '', archived_by: '' });
            scheduleCachedLaborSettings = result.settings || null;
            window.dispatchEvent(new CustomEvent('fm:labor-crews:updated', { detail: { settings: result.settings } }));
            draw(result.settings || {}, 'Crew restored.');
          } catch (error) {
            if (status) status.textContent = error?.message || 'Could not restore crew.';
          }
        });
      });
    };
    panel.innerHTML = `<div class="r-schedule-loading"><i class="fas fa-circle-notch fa-spin"></i>&nbsp; Loading crew settings...</div>`;
    loadLaborCrewSettings({ refresh: true }).then((settings) => draw(settings || scheduleCachedLaborSettings || {})).catch((error) => {
      panel.innerHTML = `<div class="r-schedule-empty"><i class="fas fa-helmet-safety"></i>${escapeHtml(error?.message || 'Could not load crew settings.')}</div>`;
    });
  }

  function renderSchedulePanel(){
    if (!state.active) {
      setScheduleWorkspaceChrome(false);
      clearScheduleLeft();
      return;
    }
    if (scheduleCrewSettingsOpen && crewManagementEnabled()) {
      renderCrewSettingsPanel();
      return;
    }
    if ((scheduleIsSchedulingView() && scheduleSchedulingTarget === 'sales') || scheduleModeActive || scheduleDraft || scheduleAssignmentEventId || scheduleSelectedEventId) {
      renderAppointmentSchedulePanel();
      return;
    }
    renderProjectScheduleHome();
  }

  function captureScheduleScroll(){
    const scroll = $('#rSchedulePanel .psv-scroll') || $('#rSchedulePanel .prs-resource-scroll') || $('#rSchedulePanel .r-cal-scroll') || $('#rSchedulePanel .r-project-cal-scroll');
    return scroll ? { left: scroll.scrollLeft || 0, top: scroll.scrollTop || 0 } : null;
  }

  function restoreScheduleScroll(position){
    if (!position) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const scroll = $('#rSchedulePanel .psv-scroll') || $('#rSchedulePanel .prs-resource-scroll') || $('#rSchedulePanel .r-cal-scroll') || $('#rSchedulePanel .r-project-cal-scroll');
      if (!scroll) return;
      scroll.scrollLeft = position.left || 0;
      scroll.scrollTop = position.top || 0;
    }));
  }

  function renderSchedulePanelPreservingScroll(){
    const scrollPosition = captureScheduleScroll();
    renderSchedulePanel();
    restoreScheduleScroll(scrollPosition);
  }

  function renderAppointmentSchedulePanel(){
    const panel = $('#rSchedulePanel');
    if (!panel) return;
    panel.classList.toggle('work-mode', scheduleIsSchedulingView());
    setScheduleWorkspaceChrome(state.active);
    renderScheduleLeft();
    const Scheduling = window.PlatformScheduling;
    const gen = ++scheduleCalendarGen;
    const appointmentEvents = projectSalesAppointmentEvents();
    const existingEvent = appointmentEvents.find((event) => String(event.id || '') === String(scheduleAssignmentEventId || ''))
      || appointmentEvents.find((event) => String(event.id || '') === String(scheduleSelectedEventId || ''))
      || null;
    const scheduleSub = scheduleIsSchedulingView()
      ? (scheduleModeActive
          ? (existingEvent ? 'Move or assign this project appointment.' : 'Click a calendar slot to place a new sales appointment.')
          : 'Select an appointment to move it, or use New to add another sales appointment.')
      : 'Project-only calendar views show events for this project.';
    panel.innerHTML = `
      <div class="r-schedule-head">
        <div>
          <h2 class="r-schedule-title">Schedule</h2>
          <div class="r-schedule-sub">${escapeHtml(scheduleSub)}</div>
        </div>
        <div class="r-schedule-head-actions">${scheduleViewSwitchHtml()}</div>
      </div>
      <div class="r-schedule-calendar"><div class="r-schedule-loading"><i class="fas fa-circle-notch fa-spin"></i>&nbsp; Loading calendar...</div></div>
    `;
    bindScheduleViewSwitch(panel);
    updateSchedulePanelConfirm();
    if (!scheduleIsSchedulingView()) {
      renderProjectScheduleView(panel.querySelector('.r-schedule-calendar'), scheduleCachedConfig?.event_types?.sales_appointment || {}, scheduleCachedConfig || {});
      return;
    }
    (async () => {
      if (!Scheduling || !scheduleOrgId()) {
        panel.querySelector('.r-schedule-calendar').innerHTML = `<div class="r-schedule-empty"><i class="fas fa-calendar"></i>Scheduling tools are unavailable.</div>`;
        return;
      }
      let config = null;
      let users = [];
      let projects = [];
      try {
        config = await Scheduling.loadBranchConfig(scheduleOrgId(), scheduleBranchId());
        users = await Scheduling.listUsers(scheduleOrgId(), config);
        projects = await Scheduling.listProjects(scheduleOrgId(), config);
        projects = mergeScheduleActiveProject(projects);
        rememberScheduleData(config, users, projects);
        await loadLaborCrewSettings();
      } catch (error) {
        if (gen !== scheduleCalendarGen) return;
        console.warn('Project scheduling data refresh failed; using last known data when available.', error);
        if (scheduleCachedConfig && scheduleCachedUsers.length) {
          config = scheduleCachedConfig;
          users = scheduleCachedUsers;
          projects = mergeScheduleActiveProject(scheduleCachedProjects);
        } else {
          panel.querySelector('.r-schedule-calendar').innerHTML = `<div class="r-schedule-empty"><i class="fas fa-calendar"></i>Could not load scheduling data.</div>`;
          return;
        }
      }
      if (gen !== scheduleCalendarGen) return;
      const eventType = config.event_types?.sales_appointment || {};
      const roleIds = Array.from(new Set([...(eventType.required_role_ids || []), ...(eventType.allowed_role_ids || []), ...(eventType.role_ids || []), 'sales_appointments']));
      const salespeople = users.filter((user) => roleIds.some((roleId) => Scheduling.userHasRole(user, roleId)) && user.status !== 'disabled');
      const target = panel.querySelector('.r-schedule-calendar');
      if (!salespeople.length) {
        target.innerHTML = `<div class="r-schedule-empty"><i class="fas fa-user-slash"></i>No sales appointment users are available. Add a user with the Sales Appointments role to schedule here.</div>`;
        return;
      }
      const singleUser = salespeople.length === 1;
      if (!singleUser && scheduleModeActive && !scheduleIsSchedulingView()) {
        scheduleViewMode = 'scheduling-day';
        renderSchedulePanel();
        return;
      }
      const duration = Number(eventType.duration_minutes || 60);
      const slotMinutes = Number(eventType.slot_minutes || config?.availability?.sales_appointment_slot_minutes || 30);
      const bufferMinutes = Number(eventType.buffer_minutes || config?.availability?.sales_appointment_buffer_minutes || 30);
      const durationSpan = Math.max(1, Math.ceil(duration / Math.max(1, slotMinutes)));
      const appointmentEvents = projectSalesAppointmentEvents();
      const appointmentEventIds = new Set(appointmentEvents.map((event) => String(event.id || '')).filter(Boolean));
      const currentEvent = appointmentEvents.find((event) => String(event.id || '') === String(scheduleAssignmentEventId || ''))
        || appointmentEvents.find((event) => String(event.id || '') === String(scheduleSelectedEventId || ''))
        || null;
      const currentEventStart = currentEvent ? (Scheduling.eventStart?.(currentEvent) || new Date(currentEvent.start_at || currentEvent.start || 0)) : null;
      scheduleRenderProjects = projects;
      scheduleRenderSlotMinutes = slotMinutes;
      scheduleRenderFocusProjectId = activeBaseProject?.id || '';
      const internalWindow = (dateValue) => {
        const limited = !!(config?.availability?.apply_limits_to_internal_users || config?.scheduling?.availability?.apply_limits_to_internal_users);
        return limited && Scheduling.availabilityWindow ? Scheduling.availabilityWindow(config, dateValue, 'sales_appointment') : { start: '08:00', end: '18:00' };
      };
      const userPayload = (user) => ({
        resource_id: user?.id || '',
        resource_name: user?.name || user?.email || '',
        assigned_user_ids: user?.id ? [user.id] : [],
        assigned_users: user?.id ? [{ id: user.id, name: user.name || user.email || user.id, role_ids: user.roles || ['sales_appointments'] }] : [],
        assigned_user_id: user?.id || '',
        assigned_user_name: user?.name || user?.email || ''
      });
      const eventUserId = (event) => String(event.assigned_user_id || event.assigned_user_ids?.[0] || event.assigned_users?.[0]?.id || event.resource_id || '');
      if (scheduleIsSchedulingView() && scheduleSchedulingMode() === 'week' && window.PlatformScheduleView?.renderResourceDayScheduler) {
        const allSalesEvents = (Scheduling.eventsFromProjects?.(projects, config) || []).filter(isSalesAppointmentEvent);
        const draftStart = scheduleDraft?.start ? new Date(scheduleDraft.start) : null;
        const salesDraft = draftStart ? {
          id: scheduleAssignmentEventId || '__sales_week_draft',
          event_id: scheduleAssignmentEventId || '',
          title: 'Sales Appointment',
          start: draftStart,
          end: new Date(draftStart.getTime() + duration * 60000),
          all_day: false,
          schedule_granularity: 'time',
          resource_id: scheduleDraft?.user?.id || ''
        } : null;
        window.PlatformScheduleView.renderResourceDayScheduler(target, {
          Scheduling,
          config,
          project: activeBaseProject || null,
          events: allSalesEvents,
          draft: salesDraft,
          activeDraftId: salesDraft?.id || '',
          resources: salespeople,
          allowCreate: scheduleModeActive,
          allowEdit: true,
          editableEventIds: Array.from(appointmentEventIds),
          mode: 'week',
          dayCount: 180,
          date: scheduleAnchorDate,
          smartScroll: false,
          modeLabel: 'Sales weekly view',
          resourceLabel: 'Salesperson',
          unassignedLabel: 'Assign later',
          resourceIdForItem: eventUserId,
          resourcePayload: userPayload,
          onNavigate(nextDate){ scheduleAnchorDate = nextDate; renderSchedulePanel(); },
          onDraftChange(next){
            if (!scheduleModeActive && !next?.event_id) return;
            const user = salespeople.find((item) => String(item.id || '') === String(next.resource_id || next.assigned_user_id || '')) || null;
            const base = next.event_id
              ? (appointmentEvents.find((event) => String(event.id || '') === String(next.event_id)) || null)
              : null;
            const baseStart = base ? (Scheduling.eventStart?.(base) || new Date(base.start_at || base.start || Date.now())) : (scheduleDraft?.start ? new Date(scheduleDraft.start) : null);
            const windowStart = internalWindow(scheduleLocalDate(new Date(next.start))).start || '09:00';
            const [h, m] = baseStart ? [baseStart.getHours(), baseStart.getMinutes()] : windowStart.split(':').map(Number);
            const start = new Date(next.start);
            start.setHours(Number(h) || 9, Number(m) || 0, 0, 0);
            setScheduleDraft(start, user, {
              id: next.id || salesDraft?.id || '__sales_week_draft',
              event_id: next.event_id || scheduleAssignmentEventId || '',
              duration_minutes: duration,
              title: 'Sales Appointment'
            });
            if (next.event_id) {
              scheduleAssignmentEventId = String(next.event_id);
              scheduleSelectedEventId = String(next.event_id);
            }
            updateSchedulePanelConfirm();
          },
          onDraftConfirm(draft){
            const start = scheduleDraft?.start ? new Date(scheduleDraft.start) : (draft?.start ? new Date(draft.start) : null);
            if (!start) return;
            saveCalendarAppointment({ start, user: scheduleDraft?.user || null, eventTypeId: 'sales_appointment' });
          },
          onEventRangeChange(event, range){
            const baseStart = Scheduling.eventStart?.(event) || new Date(event.start_at || event.start || Date.now());
            const start = new Date(range.start);
            start.setHours(baseStart.getHours(), baseStart.getMinutes(), 0, 0);
            const eventDuration = Number(event.duration_minutes || duration);
            const user = salespeople.find((item) => String(item.id || '') === String(range.assigned_user_id || range.resource_id || eventUserId(event))) || null;
            commitSalesAppointmentRange(event, {
              ...range,
              start,
              end: new Date(start.getTime() + eventDuration * 60000)
            }, user, eventDuration);
          },
          onEventClick(event){
            if (!event?.id || !appointmentEventIds.has(String(event.id || ''))) return;
            scheduleModeActive = true;
            scheduleAssignmentEventId = String(event.id || '');
            scheduleSelectedEventId = String(event.id || '');
            const user = salespeople.find((item) => String(item.id || '') === eventUserId(event)) || null;
            setScheduleDraft(Scheduling.eventStart?.(event) || new Date(event.start_at || event.start || Date.now()), user, { id:event.id, event_id:event.id, duration_minutes:Number(event.duration_minutes || duration), title:event.title || 'Sales Appointment' });
            renderSchedulePanel();
          }
        });
        return;
      }
      if (scheduleIsSchedulingView() && scheduleSchedulingMode() === 'day' && window.PlatformScheduleView?.renderResourceTimeScheduler) {
        const allSalesEvents = (Scheduling.eventsFromProjects?.(projects, config) || []).filter(isSalesAppointmentEvent);
        const draftStart = scheduleDraft?.start ? new Date(scheduleDraft.start) : null;
        const salesDraft = draftStart ? {
          id: scheduleAssignmentEventId || '__sales_day_draft',
          event_id: scheduleAssignmentEventId || '',
          title: 'Sales Appointment',
          start: draftStart,
          end: new Date(draftStart.getTime() + duration * 60000),
          all_day: false,
          schedule_granularity: 'time',
          resource_id: scheduleDraft?.user?.id || '',
          assigned_user_id: scheduleDraft?.user?.id || '',
          assigned_user_ids: scheduleDraft?.user?.id ? [scheduleDraft.user.id] : [],
          assigned_users: scheduleDraft?.user?.id ? [scheduleDraft.user] : []
        } : null;
        const windowForDay = internalWindow(scheduleLocalDate(scheduleAnchorDate));
        const [startHour, startMinute] = String(windowForDay.start || '08:00').split(':').map(Number);
        const [endHour, endMinute] = String(windowForDay.end || '18:00').split(':').map(Number);
        window.PlatformScheduleView.renderResourceTimeScheduler(target, {
          Scheduling,
          config,
          project: activeBaseProject || null,
          events: allSalesEvents,
          draft: salesDraft,
          activeDraftId: salesDraft?.id || '',
          resources: salespeople,
          allowCreate: scheduleModeActive,
          allowEdit: true,
          editableEventIds: Array.from(appointmentEventIds),
          date: scheduleAnchorDate,
          slotMinutes,
          workStartMinutes: (Number(startHour) || 8) * 60 + (Number(startMinute) || 0),
          workEndMinutes: (Number(endHour) || 18) * 60 + (Number(endMinute) || 0),
          fixedDurationMinutes: duration,
          smartScroll: scheduleSmartScroll,
          modeLabel: 'Sales daily view',
          resourceLabel: 'Salesperson',
          unassignedLabel: 'Assign later',
          resourceIdForItem: eventUserId,
          resourcePayload: userPayload,
          onSmartScrollToggle(next){
            scheduleSmartScroll = !!next;
            const scrollPosition = captureScheduleScroll();
            renderSchedulePanel();
            restoreScheduleScroll(scrollPosition);
          },
          onNavigate(nextDate){ scheduleAnchorDate = nextDate; renderSchedulePanel(); },
          onDraftChange(next){
            if (!scheduleModeActive && !next?.event_id) return;
            const user = salespeople.find((item) => String(item.id || '') === String(next.resource_id || next.assigned_user_id || '')) || null;
            setScheduleDraft(new Date(next.start), user, {
              id: next.id || salesDraft?.id || '__sales_day_draft',
              event_id: next.event_id || scheduleAssignmentEventId || '',
              duration_minutes: duration,
              title: 'Sales Appointment'
            });
            if (next.event_id) {
              scheduleAssignmentEventId = String(next.event_id);
              scheduleSelectedEventId = String(next.event_id);
            }
            updateSchedulePanelConfirm();
          },
          onDraftConfirm(draft){
            const start = scheduleDraft?.start ? new Date(scheduleDraft.start) : (draft?.start ? new Date(draft.start) : null);
            if (!start) return;
            saveCalendarAppointment({ start, user: scheduleDraft?.user || null, eventTypeId: 'sales_appointment' });
          },
          onEventRangeChange(event, range){
            const user = salespeople.find((item) => String(item.id || '') === String(range.assigned_user_id || range.resource_id || eventUserId(event))) || null;
            commitSalesAppointmentRange(event, range, user, Number(event.duration_minutes || duration));
          },
          onEventClick(event){
            if (!event?.id || !appointmentEventIds.has(String(event.id || ''))) return;
            scheduleModeActive = true;
            scheduleLockTime = true;
            scheduleAssignmentEventId = String(event.id || '');
            scheduleSelectedEventId = String(event.id || '');
            const user = salespeople.find((item) => String(item.id || '') === eventUserId(event)) || null;
            setScheduleDraft(Scheduling.eventStart?.(event) || new Date(event.start_at || event.start || Date.now()), user, {
              id: event.id,
              event_id: event.id,
              duration_minutes: Number(event.duration_minutes || duration),
              title: event.title || 'Sales Appointment'
            });
            renderSchedulePanel();
          }
        });
        return;
      }
      if (!singleUser && window.PlatformScheduleView?.renderDailyTeam) {
        const placementProject = scheduleModeActive
          ? {
              id: activeBaseProject?.id || '',
              title: manualProjectTitle(),
              address: ($('#rAddress')?.value || '').trim(),
              contacts: collectContacts(),
            }
          : null;
        const activeAssignmentEventId = placementProject && scheduleAssignmentEventId ? scheduleAssignmentEventId : '';
        const lockedStart = scheduleLockTime && placementProject && currentEvent ? (currentEvent.start_at || currentEvent.start || '') : '';
        const lockedEnd = scheduleLockTime && placementProject && currentEvent
          ? (Scheduling.eventEnd?.(currentEvent)?.toISOString?.() || currentEvent.end_at || currentEvent.end || '')
          : '';
        window.PlatformScheduleView.renderDailyTeam(target, {
          Scheduling,
          config,
          users,
          projects,
          date: scheduleAnchorDate,
          eventTypeId: 'sales_appointment',
          placementProject,
          focusProjectId: activeBaseProject?.id || '',
          readOnly: !placementProject,
          draft: scheduleDraft,
          liveTravel: scheduleUseLiveTravel,
          lockTime: scheduleLockTime,
          smartScroll: scheduleSmartScroll,
          assignmentEventId: activeAssignmentEventId,
          lockPlacementStart: lockedStart,
          lockPlacementEnd: lockedEnd,
          selectedEventId: scheduleSelectedEventId || '',
          interactiveEventIds: Array.from(appointmentEventIds),
          eventMenuHtml({ event }) {
            if (!event?.id || !appointmentEventIds.has(String(event.id || ''))) return '';
            if (!scheduleEventAssigned(event)) return '';
            return `<div class="psv-event-menu"><div class="psv-event-action danger" data-psv-event-action="unassign"><i class="fas fa-user-minus"></i> Unassign</div></div>`;
          },
          onEventClick({ event }) {
            if (!event?.id || !appointmentEventIds.has(String(event.id || ''))) return;
            const scrollPosition = captureScheduleScroll();
            const isAssigned = scheduleEventAssigned(event);
            scheduleModeActive = true;
            scheduleLockTime = true;
            scheduleDraft = null;
            scheduleAssignmentEventId = String(event.id || '');
            scheduleSelectedEventId = String(event.id || '');
            renderSchedulePanel();
            restoreScheduleScroll(scrollPosition);
          },
          onEventAction(action, { event }) {
            if (action === 'unassign' && event?.id && appointmentEventIds.has(String(event.id || ''))) unassignCurrentAppointment(event);
          },
          onNavigate(delta){
            scheduleAnchorDate = scheduleAddDays(scheduleAnchorDate, delta);
            renderSchedulePanel();
          },
          onLiveTravelToggle(next){
            scheduleUseLiveTravel = !!next;
            const scrollPosition = captureScheduleScroll();
            renderSchedulePanel();
            restoreScheduleScroll(scrollPosition);
          },
          onLockTimeToggle(next){
            scheduleLockTime = !!next;
            scheduleDraft = null;
            updateScheduleChoiceCard();
            const scrollPosition = captureScheduleScroll();
            renderSchedulePanel();
            restoreScheduleScroll(scrollPosition);
          },
          onSmartScrollToggle(next){
            scheduleSmartScroll = !!next;
            const scrollPosition = captureScheduleScroll();
            renderSchedulePanel();
            restoreScheduleScroll(scrollPosition);
          },
          onDraftChange(selection){
            if (selection?.start) {
              setScheduleDraft(selection.start, selection.user);
              if (scheduleDraft) scheduleDraft.laneIndex = selection.laneIndex;
            }
            else {
              scheduleDraft = null;
              updateScheduleChoiceCard();
            }
            window.PlatformScheduleView?.updateDraft?.(target, scheduleDraft);
            updateSchedulePanelConfirm();
            updateSubmitLabel();
          },
          onDraftConfirm(draft){
            if (!draft?.start) return;
            scheduleDraft = draft;
            saveCalendarAppointment();
          },
        });
        return;
      }
      const renderToolbar = (label, modeLabel) => `
        <div class="r-schedule-toolbar">
          <div class="r-schedule-nav">
            <button type="button" data-schedule-nav="-1"><i class="fas fa-chevron-left"></i></button>
            <button type="button" data-schedule-nav="1"><i class="fas fa-chevron-right"></i></button>
            <div class="r-schedule-range">${escapeHtml(label)}</div>
          </div>
          <div class="r-schedule-toolbar-right">
            ${currentEvent ? `<button type="button" class="r-travel-toggle ${scheduleLockTime ? 'active' : ''}" data-schedule-lock-time><span class="dot"></span> Lock appointment time</button>` : ''}
            <button type="button" class="r-travel-toggle ${scheduleSmartScroll ? 'active' : ''}" data-schedule-smart-scroll><span class="dot"></span> Smart scroll</button>
            <button type="button" class="r-travel-toggle ${scheduleUseLiveTravel ? 'active' : ''}" data-schedule-live-travel><span class="dot"></span> Live travel time</button>
            <span class="r-schedule-mode-pill"><i class="fas ${singleUser ? 'fa-calendar-week' : 'fa-table-cells'}"></i>${escapeHtml(modeLabel)}</span>
          </div>
        </div>
      `;
      if (singleUser && window.PlatformScheduleView?.renderProjectRangeScheduler) {
        const salesperson = salespeople[0];
        const draftStart = scheduleDraft?.start ? new Date(scheduleDraft.start) : null;
        const salesDraft = draftStart ? {
          id: scheduleAssignmentEventId || '__sales_draft',
          event_id: scheduleAssignmentEventId || '',
          title: 'Sales Appointment',
          start: draftStart,
          end: new Date(draftStart.getTime() + duration * 60000),
          all_day: false,
          schedule_granularity: 'time'
        } : null;
        const appointmentMode = scheduleIsSchedulingView() ? scheduleSchedulingMode() : (scheduleViewMode === 'day' ? 'day' : 'week');
        window.PlatformScheduleView.renderProjectRangeScheduler(target, {
          Scheduling,
          config,
          project: activeBaseProject || null,
          events: appointmentEvents,
          draft: salesDraft,
          activeDraftId: salesDraft?.id || '',
          allowCreate: scheduleModeActive,
          allowEdit: true,
          mode: appointmentMode,
          modes: scheduleIsSchedulingView() ? ['week','day'] : [appointmentMode],
          showModeSwitch: false,
          date: scheduleAnchorDate,
          slotMinutes,
          onNavigate(nextDate){ scheduleAnchorDate = nextDate; renderSchedulePanel(); },
          onModeChange(nextMode){
            scheduleViewMode = nextMode === 'day' ? 'scheduling-day' : 'scheduling-week';
            renderSchedulePanel();
          },
          onDraftChange(next){
            if (!scheduleModeActive && !next?.event_id) return;
            const start = new Date(next.start);
            setScheduleDraft(start, salesperson, {
              id: next.id || salesDraft?.id || '__sales_draft',
              event_id: next.event_id || scheduleAssignmentEventId || '',
              duration_minutes: duration,
              title: 'Sales Appointment'
            });
            if (next.event_id) {
              scheduleAssignmentEventId = String(next.event_id);
              scheduleSelectedEventId = String(next.event_id);
            }
            updateSchedulePanelConfirm();
          },
          onDraftConfirm(draft){
            if (!draft?.start && !scheduleDraft?.start) return;
            saveCalendarAppointment({ start: new Date(scheduleDraft?.start || draft.start), user: salesperson, eventTypeId: 'sales_appointment' });
          },
          onEventRangeChange(event, range){
            commitSalesAppointmentRange(event, range, salesperson, Number(event.duration_minutes || duration));
          },
          onEventClick(event){
            if (!event?.id) return;
            scheduleModeActive = true;
            scheduleLockTime = true;
            scheduleAssignmentEventId = String(event.id || '');
            scheduleSelectedEventId = String(event.id || '');
            setScheduleDraft(Scheduling.eventStart?.(event) || new Date(event.start_at || event.start || Date.now()), salesperson, {
              id: event.id,
              event_id: event.id,
              duration_minutes: Number(event.duration_minutes || duration),
              title: event.title || 'Sales Appointment'
            });
            renderSchedulePanel();
          }
        });
        return;
      }
      if (singleUser) {
        const weekStart = scheduleStartOfWeek(scheduleAnchorDate);
        const days = Array.from({ length: 7 }, (_, i) => scheduleAddDays(weekStart, i));
        const windowForWeek = internalWindow(scheduleLocalDate(days[0]));
        const startMin = scheduleMinutes(windowForWeek.start || '08:00');
        const endMin = scheduleMinutes(windowForWeek.end || '18:00');
        const times = [];
        for (let m = startMin; m < endMin; m += slotMinutes) times.push(scheduleTime(m));
        const label = `${days[0].toLocaleDateString([], { month:'short', day:'numeric' })} - ${days[6].toLocaleDateString([], { month:'short', day:'numeric' })}`;
        target.innerHTML = renderToolbar(label, `Weekly view - ${salespeople[0].name || salespeople[0].email}`) + `
          <div class="r-cal-scroll"><div class="r-cal-week">
            <div class="r-cal-day"></div>
            ${days.map((day) => `<div class="r-cal-day">${escapeHtml(day.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' }))}</div>`).join('')}
            ${times.map((time) => `
              <div class="r-cal-time">${escapeHtml(scheduleDisplayTime(time))}</div>
              ${days.map((day) => {
                const dateValue = scheduleLocalDate(day);
                const start = new Date(`${dateValue}T${time}:00`);
                const lockedOut = !!(currentEvent && scheduleModeActive && scheduleLockTime && currentEventStart && Math.abs(currentEventStart.getTime() - start.getTime()) >= 1000);
                const availability = Scheduling.availabilityForEventType({ users, projects, eventType, eventTypeId:'sales_appointment', start, durationMinutes: duration, assignedUserIds:[salespeople[0].id], assignedUsers:[salespeople[0]], excludeEventId: currentEvent?.id || '' });
                const dayEvents = scheduleEventsForDate(projects, dateValue, salespeople[0].id);
                const events = dayEvents.filter((event) => scheduleTime(scheduleMinutes((Scheduling.eventStart(event)).toTimeString().slice(0,5))) === time);
                const enabled = availability.hasAvailability && !lockedOut;
                return `<button type="button" class="r-cal-slot ${enabled ? '' : 'unavailable'}" style="--span:${durationSpan}" data-start="${escapeHtml(start.toISOString())}" data-user="${escapeHtml(salespeople[0].id)}" ${enabled ? '' : 'disabled'}>${scheduleTravelBlockForSlot(dayEvents, start, bufferMinutes, slotMinutes)}${events.map(scheduleEventBlock).join('')}${scheduleDraftBlock(start, salespeople[0].id, duration, slotMinutes)}</button>`;
              }).join('')}
            `).join('')}
          </div></div>
        `;
      } else {
        const day = new Date(scheduleAnchorDate);
        day.setHours(0, 0, 0, 0);
        const dateValue = scheduleLocalDate(day);
        const windowForDay = internalWindow(dateValue);
        const times = [];
        for (let m = scheduleMinutes(windowForDay.start || '08:00'); m < scheduleMinutes(windowForDay.end || '18:00'); m += slotMinutes) times.push(scheduleTime(m));
        target.innerHTML = renderToolbar(day.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' }), 'Daily team view') + `
          <div class="r-cal-scroll"><div class="r-cal-daily" style="--slot-count:${times.length}">
            <div class="r-cal-person"></div>
            ${times.map((time) => `<div class="r-cal-hour">${escapeHtml(scheduleDisplayTime(time))}</div>`).join('')}
            ${[{ id:'', name:'Unassigned', unassigned:true }, ...salespeople].map((user) => `
              <div class="r-cal-person ${user.unassigned ? 'unassigned' : ''}">${escapeHtml(user.name || user.email || 'Unassigned')}<small>${user.unassigned ? 'At least one salesperson available' : 'Assigned directly'}</small></div>
              ${times.map((time) => {
                const start = new Date(`${dateValue}T${time}:00`);
                const lockedOut = !!(currentEvent && scheduleModeActive && scheduleLockTime && currentEventStart && Math.abs(currentEventStart.getTime() - start.getTime()) >= 1000);
                const availability = user.unassigned
                  ? Scheduling.availabilityForEventType({ users, projects, eventType, eventTypeId:'sales_appointment', start, durationMinutes: duration, excludeEventId: currentEvent?.id || '' })
                  : Scheduling.availabilityForEventType({ users, projects, eventType, eventTypeId:'sales_appointment', start, durationMinutes: duration, assignedUserIds:[user.id], assignedUsers:[user], excludeEventId: currentEvent?.id || '' });
                const rowEvents = user.unassigned ? scheduleEventsForDate(projects, dateValue) : scheduleEventsForDate(projects, dateValue, user.id);
                const events = user.unassigned ? [] : rowEvents.filter((event) => scheduleTime(scheduleMinutes((Scheduling.eventStart(event)).toTimeString().slice(0,5))) === time);
                const enabled = availability.hasAvailability && !lockedOut;
                return `<button type="button" class="r-cal-day-slot ${user.unassigned ? 'unassigned' : ''} ${enabled ? '' : 'unavailable'}" style="--span:${durationSpan}" data-start="${escapeHtml(start.toISOString())}" data-user="${escapeHtml(user.id || '')}" ${enabled ? '' : 'disabled'}>${scheduleTravelBlockForSlot(rowEvents, start, bufferMinutes, slotMinutes)}${events.map(scheduleEventBlock).join('')}${scheduleDraftBlock(start, user.id || '', duration, slotMinutes)}</button>`;
              }).join('')}
            `).join('')}
          </div></div>
        `;
      }
      target.querySelectorAll('[data-schedule-nav]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const delta = Number(btn.dataset.scheduleNav || 0);
          scheduleAnchorDate = scheduleAddDays(scheduleAnchorDate, delta * (singleUser ? 7 : 1));
          renderSchedulePanel();
        });
      });
      target.querySelector('[data-schedule-live-travel]')?.addEventListener('click', () => {
        scheduleUseLiveTravel = !scheduleUseLiveTravel;
        renderSchedulePanel();
      });
      target.querySelector('[data-schedule-lock-time]')?.addEventListener('click', () => {
        scheduleLockTime = !scheduleLockTime;
        scheduleDraft = null;
        updateScheduleChoiceCard();
        renderSchedulePanel();
      });
      target.querySelector('[data-schedule-smart-scroll]')?.addEventListener('click', () => {
        scheduleSmartScroll = !scheduleSmartScroll;
        const scrollPosition = captureScheduleScroll();
        renderSchedulePanel();
        restoreScheduleScroll(scrollPosition);
      });
      if (scheduleSmartScroll && window.PlatformScheduleView?.installPointerSmartScroll) {
        window.PlatformScheduleView.installPointerSmartScroll({
          scroller: target.querySelector('.r-cal-scroll'),
          content: target.querySelector('.r-cal-week,.r-cal-daily'),
          itemSelector: singleUser ? '.r-cal-day' : '.r-cal-hour',
          axis: 'x',
          deadZoneItems: 1
        });
      }
      if (!scheduleSmartScroll && scheduleModeActive && window.PlatformScheduleView?.installWheelHorizontalScroll) {
        window.PlatformScheduleView.installWheelHorizontalScroll({
          scroller: target.querySelector('.r-cal-scroll')
        });
      }
      target.querySelectorAll('[data-schedule-draft-confirm]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          saveCalendarAppointment();
        });
      });
      target.querySelectorAll('[data-start]').forEach((slot) => {
        slot.addEventListener('click', () => {
          const user = salespeople.find((item) => item.id === slot.dataset.user) || null;
          const start = new Date(slot.dataset.start);
          if (!scheduleModeActive) return;
          const sameDraft = scheduleDraft?.start
            && Math.abs(new Date(scheduleDraft.start).getTime() - start.getTime()) < 1000
            && String(scheduleDraft.user?.id || '') === String(user?.id || '');
          if (sameDraft) {
            scheduleDraft = null;
            updateScheduleChoiceCard();
          } else {
            setScheduleDraft(start, user);
          }
          renderSchedulePanel();
          updateSubmitLabel();
        });
      });
      hydrateLiveTravelLabels(target);
    })();
  }

  function ensureScheduleDialog(){
    let dialog = $('#rScheduleDialog');
    if (dialog) return dialog;
    dialog = document.createElement('div');
    dialog.id = 'rScheduleDialog';
    dialog.className = 'r-schedule-dialog';
    dialog.innerHTML = `
      <div class="r-schedule-card">
        <h3 id="rScheduleDialogTitle">Schedule Appointment</h3>
        <p id="rScheduleDialogSub">Choose a time and assign one or more available users.</p>
        <div class="r-schedule-grid">
          <div class="r-schedule-field"><label>Date</label><input type="date" id="rScheduleDate"></div>
          <div class="r-schedule-field"><label>Time</label><input type="time" id="rScheduleTime" step="900"></div>
          <div class="r-schedule-field"><label>Duration</label><input type="number" id="rScheduleDuration" min="15" step="15"></div>
          <div class="r-schedule-field"><label>Assign Users</label><select id="rScheduleUsers" multiple size="4"></select></div>
        </div>
        <div class="r-schedule-slots" id="rScheduleSlots"></div>
        <div class="r-schedule-status" id="rScheduleStatus"></div>
        <label class="r-schedule-override" id="rScheduleOverrideWrap"><input type="checkbox" id="rScheduleOverride"> Schedule anyway</label>
        <div class="r-schedule-actions">
          <button type="button" class="r-schedule-action secondary" id="rScheduleCancel">Cancel</button>
          <button type="button" class="r-schedule-action" id="rScheduleSave">Schedule</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.addEventListener('mousedown', (event) => { dialog.__downBackdrop = event.target === dialog; });
    dialog.addEventListener('mouseup', (event) => {
      if (dialog.__downBackdrop && event.target === dialog) dialog.classList.remove('active');
      dialog.__downBackdrop = false;
    });
    $('#rScheduleCancel')?.addEventListener('click', () => dialog.classList.remove('active'));
    return dialog;
  }

  async function openScheduleDialog(eventTypeId = 'sales_appointment'){
    const Scheduling = window.PlatformScheduling;
    const orgId = scheduleOrgId();
    const project = ensureSchedulingProject();
    if (!Scheduling || !orgId || !project?.id) {
      showToast('Scheduling unavailable', 'Could not load the scheduling tools for this project.', false);
      return;
    }
    const dialog = ensureScheduleDialog();
    const dateInput = $('#rScheduleDate');
    const timeInput = $('#rScheduleTime');
    const durationInput = $('#rScheduleDuration');
    const usersInput = $('#rScheduleUsers');
    const slotsEl = $('#rScheduleSlots');
    const statusEl = $('#rScheduleStatus');
    const saveBtn = $('#rScheduleSave');
    const overrideWrap = $('#rScheduleOverrideWrap');
    const overrideInput = $('#rScheduleOverride');
    const titleEl = $('#rScheduleDialogTitle');
    const subEl = $('#rScheduleDialogSub');

    dialog.classList.add('active');
    statusEl.textContent = 'Loading availability...';
    statusEl.classList.remove('bad');
    usersInput.innerHTML = '';
    slotsEl.innerHTML = '';

    let config = null;
    let users = [];
    let projects = [];
    try {
      config = await Scheduling.loadBranchConfig(orgId, scheduleBranchId());
      users = await Scheduling.listUsers(orgId, config);
      projects = await Scheduling.listProjects(orgId, config);
    } catch (error) {
      statusEl.textContent = 'Could not load scheduling data.';
      statusEl.classList.add('bad');
      return;
    }

    const eventType = config.event_types?.[eventTypeId] || {};
    const requiredRoleIds = Array.isArray(eventType.required_role_ids) ? eventType.required_role_ids : (Array.isArray(eventType.role_ids) ? eventType.role_ids : []);
    const allowedRoleIds = Array.isArray(eventType.allowed_role_ids) ? eventType.allowed_role_ids : (Array.isArray(eventType.role_ids) ? eventType.role_ids : requiredRoleIds);
    const roleIds = Array.from(new Set([...requiredRoleIds, ...allowedRoleIds]));
    const primaryRoleId = requiredRoleIds[0] || allowedRoleIds[0] || 'sales_appointments';
    const duration = Number(eventType.duration_minutes || 60);
    titleEl.textContent = eventType.label ? `Schedule ${eventType.label}` : 'Schedule Appointment';
    subEl.textContent = roleIds.length
      ? `Find availability for ${roleIds.map((roleId) => Scheduling.labelFor(config, 'roles', roleId)).join(' or ')}.`
      : 'Find an available time and assign users if needed.';
    const now = new Date();
    const nextHour = new Date(now.getTime() + 60 * 60 * 1000);
    nextHour.setMinutes(0, 0, 0);
    dateInput.value = Scheduling.localDateInput(nextHour);
    const internalLimitsEnabled = !!(config?.availability?.apply_limits_to_internal_users || config?.scheduling?.availability?.apply_limits_to_internal_users);
    const internalWindowForDate = (dateValue) => {
      if (internalLimitsEnabled) return Scheduling.availabilityWindow ? Scheduling.availabilityWindow(config, dateValue, eventTypeId) : { start: '09:00', end: '17:00' };
      return { start: '00:00', end: '23:59' };
    };
    const initialWindow = internalWindowForDate(dateInput.value);
    timeInput.value = internalLimitsEnabled ? (initialWindow.start || `${String(nextHour.getHours()).padStart(2, '0')}:00`) : `${String(nextHour.getHours()).padStart(2, '0')}:00`;
    durationInput.value = duration;

    function selectedStart(){
      return new Date(`${dateInput.value}T${timeInput.value || '09:00'}:00`);
    }

    function selectedUserIds(){
      return Array.from(usersInput.selectedOptions || []).map((option) => option.value).filter(Boolean);
    }

    function assignedUsersForIds(ids){
      return ids.map((id) => {
        const user = users.find((item) => item.id === id);
        return { id, name: user?.name || user?.email || id, role_ids: user?.roles?.length ? user.roles : roleIds };
      });
    }

    function renderAvailability(){
      const start = selectedStart();
      const durationMinutes = Number(durationInput.value || duration);
      const selectedIds = selectedUserIds();
      const selectedAssignedUsers = assignedUsersForIds(selectedIds);
      const availability = Scheduling.availabilityForRole({
        users,
        projects,
        roleId: primaryRoleId,
        start,
        durationMinutes,
      });
      const eventAvailability = Scheduling.availabilityForEventType({
        users,
        projects,
        eventType,
        eventTypeId,
        start,
        durationMinutes,
        assignedUserIds: selectedIds,
        assignedUsers: selectedAssignedUsers,
      });
      const eligibleUsers = eventAvailability.eligibleUsers?.length ? eventAvailability.eligibleUsers : availability.availableUsers;
      usersInput.innerHTML = `<option value="">Assign later</option>` + eligibleUsers.map((user) => {
        const roleLabel = (user.mapped_roles || []).map((role) => role.label).join(', ');
        const selected = selectedIds.includes(user.id) ? 'selected' : '';
        return `<option value="${escapeHtml(user.id)}" ${selected}>${escapeHtml(user.name || user.email || user.id)}${roleLabel ? ` - ${escapeHtml(roleLabel)}` : ''}</option>`;
      }).join('');
      statusEl.classList.toggle('bad', !eventAvailability.hasAvailability);
      const assignedBusy = (eventAvailability.assignedStatus || []).filter((entry) => entry.busy).map((entry) => entry.user.name || entry.user.email || entry.user.id);
      statusEl.textContent = eventAvailability.hasAvailability
        ? `${eligibleUsers.length} eligible for ${start.toLocaleString([], { weekday:'short', hour:'numeric', minute:'2-digit' })}.`
        : assignedBusy.length
          ? `${assignedBusy.join(', ')} is already booked at that time.`
          : 'Required roles are not fully available at that time.';
      if (overrideWrap) overrideWrap.classList.toggle('visible', !eventAvailability.hasAvailability);
      saveBtn.disabled = !eventAvailability.hasAvailability && !overrideInput?.checked;
      saveBtn.textContent = eventAvailability.hasAvailability ? 'Schedule' : (overrideInput?.checked ? 'Schedule Anyway' : 'Schedule');
      renderSlots();
    }

    function renderSlots(){
      const windowForDay = internalWindowForDate(dateInput.value);
      const slots = Scheduling.availableEventTypeTimeSlots({
        users,
        projects,
        eventType,
        eventTypeId,
        date: dateInput.value,
        durationMinutes: Number(durationInput.value || duration),
        stepMinutes: Number(eventType.slot_minutes || config?.availability?.sales_appointment_slot_minutes || 30),
        workdayStart: windowForDay.start,
        workdayEnd: windowForDay.end,
        assignedUserIds: selectedUserIds(),
        assignedUsers: assignedUsersForIds(selectedUserIds()),
      });
      const current = timeInput.value;
      slotsEl.innerHTML = slots.map((slot) => `
        <button type="button" class="r-schedule-slot ${slot.hasAvailability ? 'available' : 'unavailable'} ${slot.time === current ? 'active' : ''}" data-time="${escapeHtml(slot.time)}" ${slot.hasAvailability ? '' : 'disabled'}>${escapeHtml(slot.label)}</button>
      `).join('');
      slotsEl.querySelectorAll('.r-schedule-slot.available').forEach((btn) => {
        btn.addEventListener('click', () => {
          timeInput.value = btn.dataset.time || timeInput.value;
          renderAvailability();
        });
      });
    }

    [dateInput, timeInput, durationInput, usersInput, overrideInput].forEach((input) => {
      if (input) input.oninput = renderAvailability;
      if (input) input.onchange = renderAvailability;
    });
    saveBtn.onclick = async () => {
      const selectedIds = selectedUserIds();
      const assignedUsers = assignedUsersForIds(selectedIds);
      const event = Scheduling.createProjectEvent(project, eventTypeId, {
        start: selectedStart(),
        durationMinutes: Number(durationInput.value || duration),
        assignedUserIds: selectedIds,
        assignedUsers,
        availability_override: !!overrideInput?.checked,
      }, config);
      try {
        const saved = await Scheduling.saveProjectEvent(orgId, project, event, config);
        activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project.events || [] };
        persistActiveBaseProject();
        renderSchedulePanel();
        dialog.classList.remove('active');
        window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
        showToast('Appointment scheduled', `${event.title} was added to the project.`, true);
      } catch (error) {
        statusEl.textContent = error?.message || 'Could not save the appointment.';
        statusEl.classList.add('bad');
      }
    };

    renderAvailability();
  }


  function mount(context = {}){
    injectProjectScheduleCss();
    state.context = context;
    state.host = hostFor(context);
    state.model = modelFromContext(context);
    state.panelRoot = resolveRoot(context);
    state.leftRoot = context.leftRoot || context.roots?.left || state.leftRoot;
    state.mounted = !!state.panelRoot;
    state.active = contextScheduleActive(context);
    if (state.model && window.FirstMateAppContext?.installProjectContextAccessors) {
      window.FirstMateAppContext.installProjectContextAccessors(state.model, { overwrite: false });
    }
    installHostGlobals();
    if (state.active) renderSchedulePanel();
    else {
      setScheduleWorkspaceChrome(false);
      clearScheduleLeft();
    }
    return api;
  }

  function activate(context = {}){
    if (context.host || context.projectWorkspace || context.panelRoot) mount({ ...context, active: true, activeTab: 'schedule' });
    state.active = true;
    setScheduleWorkspaceChrome(true);
    renderSchedulePanel();
  }

  function deactivate(context = {}){
    if (context && Object.keys(context).length) {
      state.context = { ...(state.context || {}), ...context };
      state.leftRoot = context.leftRoot || context.roots?.left || state.leftRoot;
    }
    setActive(false);
  }

  function setActive(active){
    state.active = !!active;
    setScheduleWorkspaceChrome(state.active);
    if (state.active) renderSchedulePanel();
    else clearScheduleLeft();
  }

  function reset(){
    scheduleModeActive = false;
    scheduleCalendarGen = 0;
    scheduleAnchorDate = new Date();
    scheduleViewMode = 'month';
    scheduleDraft = null;
    clearAllWorkDrafts();
    workScheduleModeActive = false;
    workScheduleViewMode = 'month';
    scheduleUseLiveTravel = true;
    scheduleLockTime = true;
    scheduleSmartScroll = false;
    scheduleSelectedEventId = '';
    scheduleAssignmentEventId = '';
    scheduleCrewSettingsOpen = false;
    scheduleWorkResourceDataLoaded = false;
    setScheduleWorkspaceChrome(false);
  }

  function unmount(){
    reset();
    clearScheduleLeft();
  }

  function hasDraft(){
    return !!scheduleDraft?.start;
  }

  function prepareFromEvent(event){
    const start = window.PlatformScheduling?.eventStart?.(event) || new Date(event?.start_at || event?.start || Date.now());
    if (Number.isFinite(start.getTime())) scheduleAnchorDate = start;
    scheduleViewMode = 'month';
    scheduleModeActive = false;
    return api;
  }

  window.addEventListener('fm:labor-crews:updated', async () => {
    const scrollPosition = captureScheduleScroll();
    await loadLaborCrewSettings({ refresh: true });
    if (state.active) {
      renderSchedulePanel();
      restoreScheduleScroll(scrollPosition);
    }
  });

  function invoke(name, args = []){
    const fn = api[name];
    return typeof fn === 'function' ? fn(...(Array.isArray(args) ? args : [])) : undefined;
  }

  const api = {
    mount,
    activate,
    deactivate,
    setActive,
    reset,
    destroy: unmount,
    unmount,
    invoke,
    renderSchedulePanel,
    currentProjectSalesAppointment,
    appointmentSummaryLabel,
    startAppointmentScheduling,
    updateScheduleChoiceCard,
    openScheduleDialog,
    saveCalendarAppointment,
    ensureSchedulingProject,
    ensureRemoteSchedulingProject,
    hasDraft,
    prepareFromEvent,
    context: () => ({ mounted: state.mounted, active: state.active, mode: scheduleViewMode, hasDraft: hasDraft() })
  };

  const definition = {
    id: 'project.schedule',
    kind: 'project_modal_app',
    title: 'Project Schedule',
    label: 'Schedule',
    icon: 'fa-calendar-days',
    order: 40,
    visible: true,
    surfaces: ['project_modal'],
    regions: ['main'],
    requiresContext: ['project'],
    dependencies: [],
    enabled: (context = {}) => context.schedulePreviewAvailable !== false,
    panelHtml,
    mount
  };

  Portal.modules = Portal.modules || {};
  Portal.modules.projectSchedule = api;
  Portal.ProjectScheduleApp = api;

  runtime?.registerApp?.(definition);
})();
