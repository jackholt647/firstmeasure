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
  let projectGanttZoom = 0;
  let projectGanttCollapsedGroups = [];
  let projectGanttDefaultApplied = false;
  let projectMobileViewMenuOpen = false;
  let projectMobileMonthMenuOpen = false;
  let projectMobilePickerMonth = scheduleAnchorDate.getMonth();
  let projectMobilePickerYear = scheduleAnchorDate.getFullYear();
  let projectMobileControlsDocHandler = null;
  let projectMobileCalendarSwipeDirection = '';
  let projectMobileCalendarSwipeTimer = null;
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
  let materialScheduleModeActive = false;
  let materialScheduleEventId = '';
  let materialScheduleListId = '';
  let materialScheduleDraft = null;
  let scheduleCrewSettingsOpen = false;
  let scheduleCachedConfig = null;
  let scheduleCachedWorkResources = [];
  let scheduleCachedEquipmentUnits = [];
  let scheduleCachedEquipmentTypes = [];
  let scheduleCachedUsers = [];
  let scheduleCachedProjects = [];
  let scheduleWorkResourceDataLoaded = false;
  let scheduleWorkforceTerminology = {};
  let scheduleWorkforceTerminologyLoaded = false;
  let scheduleCrewMenuEventId = '';
  let scheduleCrewMenuDocHandler = null;
  let scheduleEventPopoverId = '';
  let scheduleEventPopoverDocHandler = null;
  let scheduleRecurringSeries = [];
  let scheduleRecurrenceLoading = false;
  let scheduleRecurrenceLoaded = false;
  let scheduleRecurrenceProjectId = '';
  const scheduleTravelCache = new Map();
  const scheduleEventSaveVersions = new Map();
  const scheduleEventSaveQueues = new Map();
  const state = {
    mounted: false,
    active: false,
    host: null,
    model: null,
    panelRoot: null,
    leftRoot: null,
    context: null
  };

  function bindOutsidePointerDismiss(surface, onDismiss, insideNodes = []){
    let pointerStartedOutside = false;
    const isInside = (target) => !!target && (surface.contains(target) || insideNodes.some((node) => node?.contains?.(target)));
    const pointerTarget = (event) => document.elementFromPoint?.(Number(event.clientX), Number(event.clientY)) || event.target;
    const onPointerDown = (event) => { pointerStartedOutside = !isInside(pointerTarget(event)); };
    const onPointerUp = (event) => {
      const pointerEndedOutside = !isInside(pointerTarget(event));
      if (pointerStartedOutside && pointerEndedOutside) onDismiss();
      pointerStartedOutside = false;
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
    };
  }

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
      .r-schedule-panel.work-mode.scheduling-mode{padding:0;gap:0}
      .r-schedule-panel.work-mode.scheduling-mode .r-schedule-head{padding:14px 16px;margin:0;background:#f8fafc;border-bottom:1px solid rgba(15,23,42,.08)}
      .r-schedule-card .r-schedule-advanced{display:grid;gap:12px;margin-top:14px;padding:14px;border:1px solid rgba(15,23,42,.10);border-radius:14px;background:#f8fafc}.r-schedule-card .r-schedule-advanced[hidden]{display:none}.r-schedule-equipment-requirements{display:grid;gap:7px;grid-column:1/-1}.r-schedule-equipment-requirement{display:grid;grid-template-columns:22px minmax(0,1fr) 76px;gap:8px;align-items:center;font-size:12px;font-weight:850;color:#344054}.r-schedule-equipment-requirement input[type="number"]{height:36px}.r-schedule-advanced-actions{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:18px}.r-schedule-advanced-toggle{width:42px;height:42px;border:1px solid rgba(15,23,42,.14);border-radius:13px;background:#fff;color:#667085;cursor:pointer}.r-schedule-advanced-toggle.active{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.07);color:var(--primary,#d93025)}.r-schedule-advanced-actions .r-schedule-actions{display:flex;margin:0}.r-schedule-card select[multiple]{height:auto;min-height:94px;padding:7px 10px}
      .r-schedule-requirement-alert{display:flex;gap:8px;align-items:flex-start;margin:8px 0;border:1px solid #fda29b;border-radius:10px;background:#fef3f2;color:#b42318;padding:9px 10px;font-size:11px;font-weight:850}.r-schedule-requirement-alert ul{margin:0;padding-left:16px}
      .r-schedule-panel.work-mode .r-schedule-calendar.work-calendar{flex:1;height:auto;min-height:0}
      .r-schedule-view-switch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .r-schedule-view-group{display:inline-flex;align-items:center;gap:3px;border:1px solid rgba(15,23,42,.10);background:#fff;border-radius:12px;padding:3px}
      .r-schedule-view-group.scheduling{border-color:rgba(var(--primary-rgb,217,48,37),.18);background:rgba(var(--primary-rgb,217,48,37),.04)}
      .r-schedule-view-group.surface{background:#f8fafc}
      .r-schedule-view-group.target{border-color:rgba(37,99,235,.18);background:#eef5ff}
      .r-schedule-view-group.navigation{gap:2px}.r-schedule-anchor-nav{min-width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:#475467;padding:0 8px;font-size:11px;font-weight:1000;cursor:pointer}.r-schedule-anchor-nav:hover{background:#f2f4f7;color:#101828}.r-schedule-anchor-nav.today{padding:0 10px}
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
      .r-schedule-tile-kind{font-style:italic;font-weight:800;color:#667085}
      .r-schedule-tile-meta{margin-top:4px;font-size:11px;font-weight:850;color:#667085;line-height:1.35}
      .r-material-tile{--material-list-color:#64748b;border-left:4px solid var(--material-list-color);display:block;width:100%;cursor:pointer}
      .r-material-tile.incomplete{border-left-style:dashed}.r-material-tile.active{background:color-mix(in srgb,var(--material-list-color) 9%,#fff);box-shadow:0 0 0 2px color-mix(in srgb,var(--material-list-color) 18%,transparent)}
      .r-material-tile .r-schedule-tile-title{display:flex;align-items:center;gap:7px}.r-material-tile .r-schedule-tile-title i{color:var(--material-list-color)}.r-schedule-tile:not(.r-material-tile) .r-schedule-tile-title i{margin-right:7px;color:#475467}
      .r-production-resource-tile{display:grid;grid-template-columns:minmax(0,1fr) minmax(120px,42%);align-items:center;gap:10px;width:100%}
      .r-production-resource-tile.no-assignment{grid-template-columns:1fr}
      .r-production-resource-main{min-width:0;border:0;background:transparent;padding:0;text-align:left;color:inherit;cursor:pointer}
      .r-production-resource-assignment{display:grid;gap:4px;min-width:0;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em;color:#667085}
      .r-production-resource-crew-button{width:100%;height:32px;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;color:#344054;padding:0 8px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;font-weight:900;text-transform:none;letter-spacing:0;cursor:pointer}
      .r-production-resource-crew-button span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.r-production-resource-crew-button i{flex:0 0 auto;font-size:9px;color:#98a2b3}.r-production-resource-crew-button.unassigned{font-style:italic;color:#667085}
      .r-schedule-crew-popover{position:fixed;z-index:3400;width:220px;max-height:280px;overflow:auto;display:grid;gap:4px;padding:7px;border:1px solid rgba(15,23,42,.12);border-radius:12px;background:#fff;box-shadow:0 20px 50px rgba(15,23,42,.22)}
      .r-schedule-crew-option{height:34px;border:0;border-radius:8px;background:#fff;color:#344054;padding:0 10px;text-align:left;font-size:12px;font-weight:900;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .r-schedule-crew-option:hover,.r-schedule-crew-option.active{background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025))}
      .r-schedule-event-popover{position:fixed;z-index:3390;width:min(330px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;display:grid;gap:12px;padding:14px;border:1px solid rgba(15,23,42,.12);border-radius:14px;background:#fff;box-shadow:0 22px 60px rgba(15,23,42,.24)}
      .r-schedule-event-popover-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.r-schedule-event-popover-title{min-width:0;font-size:15px;font-weight:1000;color:#101828;line-height:1.25}.r-schedule-event-popover-kind{display:inline-flex;align-items:center;gap:6px;margin-bottom:5px;color:#667085;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.055em}.r-schedule-event-popover-close{flex:0 0 auto;width:28px;height:28px;border:0;border-radius:8px;background:#f2f4f7;color:#475467;cursor:pointer}.r-schedule-event-popover-details{display:grid;gap:8px}.r-schedule-event-popover-row{display:grid;grid-template-columns:18px minmax(0,1fr);align-items:start;gap:8px;color:#475467;font-size:12px;font-weight:850;line-height:1.4}.r-schedule-event-popover-row i{margin-top:2px;color:#98a2b3;text-align:center}.r-schedule-event-popover-field{display:grid;gap:5px;padding-top:2px;color:#667085;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.r-schedule-event-popover-field select{width:100%;height:34px;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;color:#344054;padding:0 9px;font-size:12px;font-weight:900;text-transform:none;letter-spacing:0;cursor:pointer}
      .r-schedule-event-customer{display:grid;border:1px solid rgba(15,23,42,.10);border-radius:10px;background:#f8fafc;overflow:hidden}.r-schedule-event-share{display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;align-items:center;padding:10px;cursor:pointer}.r-schedule-event-share input{position:absolute;opacity:0;pointer-events:none}.r-schedule-event-share-toggle{position:relative;width:34px;height:20px;border-radius:999px;background:#d0d5dd;transition:.18s ease}.r-schedule-event-share-toggle:after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.22);transition:.18s ease}.r-schedule-event-share input:checked+.r-schedule-event-share-toggle{background:var(--primary,#d93025)}.r-schedule-event-share input:checked+.r-schedule-event-share-toggle:after{transform:translateX(14px)}.r-schedule-event-share strong{display:block;color:#344054;font-size:11px;font-weight:1000}.r-schedule-event-share small{display:block;margin-top:2px;color:#667085;font-size:9px;font-weight:800;line-height:1.35}.r-schedule-event-customer-options{display:none;gap:8px;padding:0 10px 10px;border-top:1px solid rgba(15,23,42,.08)}.r-schedule-event-customer-options.open{display:grid}.r-schedule-event-customer-option{display:flex;align-items:flex-start;gap:7px;color:#344054;font-size:10px;font-weight:900;line-height:1.35}.r-schedule-event-customer-option:first-child{margin-top:9px}.r-schedule-event-customer-option input{margin:1px 0 0;accent-color:var(--primary,#d93025)}.r-schedule-event-customer-note{display:grid;gap:5px;color:#667085;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.r-schedule-event-customer-note textarea{min-height:66px;resize:vertical;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;padding:8px;color:#101828;font:inherit;font-size:11px;font-weight:800;line-height:1.45;text-transform:none;letter-spacing:0}.r-schedule-event-customer-save{height:32px;margin:0 10px 10px;border:0;border-radius:8px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font-size:11px;font-weight:1000;cursor:pointer}
      .r-schedule-confirm{display:grid;gap:8px;padding:11px;border:1px solid rgba(15,23,42,.10);border-radius:10px;background:#f8fafc}
      .r-schedule-confirm.warn{border-color:rgba(245,158,11,.34);background:#fffbeb}
      .r-schedule-confirm.good{border-color:rgba(22,163,74,.30);background:#f0fdf4}
      .r-schedule-confirm.bad{border-color:rgba(220,38,38,.32);background:#fef2f2}
      .r-schedule-confirm-head{display:grid;grid-template-columns:18px minmax(0,1fr);align-items:start;gap:8px}
      .r-schedule-confirm-head i{margin-top:2px;text-align:center;color:#98a2b3}
      .r-schedule-confirm.warn .r-schedule-confirm-head i{color:#b45309}
      .r-schedule-confirm.good .r-schedule-confirm-head i{color:#15803d}
      .r-schedule-confirm.bad .r-schedule-confirm-head i{color:#b42318}
      .r-schedule-confirm-head strong{display:block;color:#101828;font-size:11.5px;font-weight:1000;line-height:1.3}
      .r-schedule-confirm-head small{display:block;margin-top:2px;color:#667085;font-size:9.5px;font-weight:850}
      .r-schedule-confirm-meta{color:#667085;font-size:9.5px;font-weight:850;line-height:1.4}
      .r-schedule-confirm-reply{border-left:2px solid rgba(15,23,42,.14);padding-left:8px;color:#475467;font-size:11px;font-weight:800;line-height:1.45;font-style:italic}
      .r-schedule-confirm-reply.error{border-left-color:rgba(220,38,38,.5);color:#b42318;font-style:normal}
      .r-schedule-confirm-actions{display:flex;flex-wrap:wrap;gap:6px}
      .r-schedule-confirm-action{height:28px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#344054;padding:0 10px;font-size:10.5px;font-weight:1000;cursor:pointer}
      .r-schedule-confirm-action.primary{border-color:transparent;background:var(--primary,#d93025);color:var(--on-primary,#fff)}
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
      .r-project-mobile-toolbar{display:none}
      .r-schedule-left-status{border:1px solid rgba(var(--primary-rgb,217,48,37),.18);background:rgba(var(--primary-rgb,217,48,37),.06);border-radius:12px;padding:10px;color:#344054;font-size:12px;font-weight:850;line-height:1.4}
      .r-schedule-left-status strong{display:block;color:#101828;font-size:12px;font-weight:1000;margin-bottom:2px}
      .r-recurrence-tile{width:100%;text-align:left;cursor:pointer}.r-recurrence-tile.cancelled{opacity:.62}.r-recurrence-meta{display:flex;align-items:center;justify-content:space-between;gap:8px}.r-recurrence-pill{border-radius:999px;padding:3px 7px;background:#eef4ff;color:#175cd3;font-size:9px;font-weight:1000;text-transform:uppercase}.r-recurrence-pill.cancelled{background:#f2f4f7;color:#667085}
      .r-recurrence-modal{position:fixed;inset:0;z-index:3200;background:rgba(16,24,40,.48);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:18px}.r-recurrence-dialog{width:min(700px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#fff;border-radius:16px;box-shadow:0 28px 90px rgba(15,23,42,.32)}.r-recurrence-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 17px;border-bottom:1px solid rgba(15,23,42,.09)}.r-recurrence-head strong{font-size:16px}.r-recurrence-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:16px}.r-recurrence-form label{display:grid;gap:5px;font-size:10px;font-weight:1000;text-transform:uppercase;color:#667085}.r-recurrence-form label.wide{grid-column:1/-1}.r-recurrence-form input,.r-recurrence-form select{height:36px;border:1px solid rgba(15,23,42,.14);border-radius:9px;padding:0 10px;font:inherit;color:#101828;background:#fff}.r-recurrence-form .r-recurrence-check{display:flex;align-items:center;gap:8px;text-transform:none;font-size:12px;color:#344054}.r-recurrence-form .r-recurrence-check input{height:auto}.r-recurrence-actions{grid-column:1/-1;display:flex;justify-content:space-between;gap:8px;padding-top:5px}.r-recurrence-actions div{display:flex;gap:8px}
      @media(max-width:720px){
        .r-schedule-panel.work-mode{padding:0;gap:0;min-width:0;background:#fff}
        .r-schedule-panel.work-mode:not(.scheduling-mode) .r-schedule-head{display:none}
        .r-project-mobile-toolbar{position:relative;z-index:40;display:flex;align-items:center;gap:2px;height:50px;padding:0 6px;background:#fff;box-sizing:border-box;white-space:nowrap}
        .r-project-mobile-menu{position:relative;flex:0 0 auto}
        .r-project-mobile-control{height:34px;border:0;border-radius:8px;background:transparent;color:#344054;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 8px;font:inherit;font-size:12px;font-weight:1000;cursor:pointer}
        .r-project-mobile-control:hover,.r-project-mobile-control[aria-expanded="true"]{background:#f2f4f7}.r-project-mobile-control.view{width:34px;padding:0;font-size:13px}.r-project-mobile-control.view .fa-chevron-down{font-size:8px;margin-left:1px}.r-project-mobile-control.month{width:112px;max-width:112px;overflow:hidden;text-overflow:ellipsis}.r-project-mobile-control.month span{overflow:hidden;text-overflow:ellipsis}.r-project-mobile-control.today{width:32px;padding:0;margin-left:auto;color:#475467}.r-project-mobile-control.nav{width:25px;padding:0;font-size:10px}
        .r-project-mobile-today-date{width:19px;height:20px;border:1.5px solid currentColor;border-radius:3px;display:grid;place-items:center;padding-top:5px;box-sizing:border-box;font-size:9px;line-height:1;font-weight:1000;position:relative}.r-project-mobile-today-date:before{content:"";position:absolute;left:-1.5px;right:-1.5px;top:4px;border-top:1.5px solid currentColor}
        .r-project-mobile-popover{position:absolute;top:calc(100% + 6px);left:0;width:190px;max-height:min(420px,calc(100vh - 70px));overflow:auto;padding:6px;border:1px solid rgba(15,23,42,.10);border-radius:12px;background:#fff;box-shadow:0 18px 45px rgba(15,23,42,.18);box-sizing:border-box}.r-project-mobile-popover.months{width:min(334px,calc(100vw - 16px));padding:10px}.r-project-mobile-month-picker{display:grid;grid-template-columns:1fr 1fr;gap:10px;max-height:280px}.r-project-mobile-month-picker section{min-width:0;overflow:auto;border:1px solid rgba(15,23,42,.08);border-radius:9px;padding:3px}.r-project-mobile-month-picker button{height:31px;font-size:11px}.r-project-mobile-popover button{width:100%;height:36px;border:0;border-radius:8px;background:transparent;color:#344054;display:flex;align-items:center;gap:10px;padding:0 9px;font:inherit;font-size:12px;font-weight:950;text-align:left;cursor:pointer}.r-project-mobile-popover button:hover,.r-project-mobile-popover button.active{background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025))}.r-project-mobile-popover button i{width:15px;text-align:center}
        .r-schedule-panel.work-mode .r-schedule-calendar{min-width:0;overflow:hidden;background:#fff}.r-schedule-panel.work-mode .r-schedule-calendar.mobile-swipe-next{animation:r-project-calendar-enter-next .24s ease-out both}.r-schedule-panel.work-mode .r-schedule-calendar.mobile-swipe-prev{animation:r-project-calendar-enter-prev .24s ease-out both}@keyframes r-project-calendar-enter-next{from{opacity:.45;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}@keyframes r-project-calendar-enter-prev{from{opacity:.45;transform:translateX(-20px)}to{opacity:1;transform:translateX(0)}}
        .r-schedule-panel.work-mode .prs-wrap.mobile-layout{min-width:0;height:100%}
        .r-schedule-panel.work-mode .prs-wrap.mobile-layout .prs-surface{width:100%;max-width:100%;overflow-x:hidden!important}
        .r-schedule-panel.work-mode .prs-wrap.mobile-layout .prs-time-grid,.r-schedule-panel.work-mode .prs-wrap.mobile-layout .prs-all-day-grid{width:100%!important;max-width:100%!important;box-sizing:border-box;grid-template-columns:40px repeat(var(--prs-days),minmax(0,1fr));min-width:100%!important}
        .r-schedule-panel.work-mode .prs-wrap.mobile-layout .prs-time-head,.r-schedule-panel.work-mode .prs-wrap.mobile-layout .prs-day-head,.r-schedule-panel.work-mode .prs-wrap.mobile-layout .prs-all-day-cell{min-width:0;overflow:hidden}
        .r-schedule-panel.work-mode .prs-wrap.mobile-layout .prs-slot{min-width:0;overflow:visible;z-index:1}.r-schedule-panel.work-mode .prs-wrap.mobile-layout .prs-slot.has-chip{z-index:4}.r-schedule-panel.work-mode .prs-wrap.mobile-layout .prs-slot .prs-work-chip{z-index:4}
      }
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

  function workforceManagementEnabled(){
    const hosted = callHost('workforceManagementEnabled');
    if (hosted !== undefined) return !!hosted;
    return typeof window.PlatformAPI?.workforce?.assignableResources === 'function';
  }

  function workforceTerm(kind, form = 'singular'){
    const defaults = {
      resource_group: { singular:'Crew', plural:'Crews' },
      organization_connection: { singular:'Subcontractor', plural:'Subcontractors' }
    };
    const configured = scheduleWorkforceTerminology?.[kind] || {};
    return String(configured?.[form] || configured?.singular || defaults[kind]?.[form] || defaults[kind]?.singular || 'Team').trim();
  }

  function workResourceLabel(form = 'singular'){
    return `${workforceTerm('resource_group', form)} / ${workforceTerm('organization_connection', form)}`;
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
    if (ids.length) return ids.join(', ');
    return String(event?.work_resource_ref?.name || event?.assigned_resource_name || event?.assigned_crew_name || event?.resource_name || '').trim() || 'Assign later';
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

  let scheduleConfirmationSettingsLoaded = false;

  /* Confirmation settings gate whether this viewer sees confirmation state at
   * all, so they load once alongside the panel's other branch configuration. */
  async function loadConfirmationSettings(){
    const Scheduling = window.PlatformScheduling;
    const client = window.PlatformAPI?.appointments;
    if (scheduleConfirmationSettingsLoaded || !Scheduling?.setConfirmationSettings || !client || !scheduleOrgId()) return;
    scheduleConfirmationSettingsLoaded = true;
    try {
      const result = await client.settings(scheduleOrgId(), scheduleBranchId());
      Scheduling.setConfirmationSettings(result?.settings || {});
    } catch {
      // Leaving the cache empty keeps confirmation UI hidden, which is the
      // safe default when we can't confirm the company's visibility rule.
    }
  }

  async function loadWorkforceResources(options = {}){
    loadConfirmationSettings().catch(() => null);
    if (!window.PlatformAPI?.workforce?.assignableResources || !scheduleOrgId()) {
      scheduleCachedWorkResources = [];
      return scheduleCachedWorkResources;
    }
    if (scheduleCachedWorkResources.length && scheduleWorkforceTerminologyLoaded && !options.refresh) return scheduleCachedWorkResources;
    try {
      const [result, configurationResult, equipmentTypesResult] = await Promise.all([
        window.PlatformAPI.workforce.assignableResources(scheduleOrgId(), scheduleBranchId()),
        window.PlatformAPI.workforce.configuration?.(scheduleOrgId(), scheduleBranchId()).catch(() => ({ configuration:{} })) || Promise.resolve({ configuration:{} }),
        equipmentSchedulingEnabled() && window.EquipmentAPI?.types
          ? window.EquipmentAPI.types(scheduleOrgId()).catch(() => ({ types:scheduleCachedEquipmentTypes }))
          : Promise.resolve({ types:[] })
      ]);
      const configuration = configurationResult?.configuration || configurationResult?.settings || configurationResult || {};
      scheduleWorkforceTerminology = configuration.terminology || scheduleWorkforceTerminology;
      scheduleWorkforceTerminologyLoaded = true;
      const resources = Array.isArray(result?.resources) ? result.resources : (Array.isArray(result?.assignable_resources) ? result.assignable_resources : []);
      scheduleCachedEquipmentUnits = Array.isArray(result?.equipment_units) ? result.equipment_units : [];
      scheduleCachedEquipmentTypes = Array.isArray(equipmentTypesResult?.types) ? equipmentTypesResult.types : scheduleCachedEquipmentTypes;
      scheduleCachedWorkResources = resources.map((resource) => {
        const id = String(resource?.resource_id || resource?.id || '').trim();
        const name = String(resource?.name || resource?.work_resource_ref?.name || id).trim();
        const resourceKind = String(resource?.resource_kind || resource?.work_resource_ref?.kind || resource?.kind || '').trim();
        return {
          ...resource,
          id,
          name,
          subject_type:String(resource?.subject_type || resourceKind || '').trim(),
          resource_kind:resourceKind,
          group_kind_id:String(resource?.group_kind_id || resource?.kind_id || '').trim(),
          kind_ids:Array.isArray(resource?.kind_ids) ? resource.kind_ids.map(String).filter(Boolean) : [],
          assignment_tag_ids:Array.isArray(resource?.assignment_tag_ids) ? resource.assignment_tag_ids.map(String).filter(Boolean) : [],
          work_resource_ref:id ? { kind:resourceKind, id, name } : null,
          capability_scope_ids:Array.isArray(resource?.capability_scope_ids) ? resource.capability_scope_ids.map((scopeId) => String(scopeId || '').trim()).filter(Boolean) : []
        };
      }).filter((resource) => resource.id && String(resource.status || 'active') !== 'archived');
      return scheduleCachedWorkResources;
    } catch (error) {
      if (Number(error?.status || 0) !== 403) console.warn('Workforce resources unavailable.', error);
      return scheduleCachedWorkResources;
    }
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

  // Equipment events stay hidden until the org runs equipment scheduling.
  function equipmentSchedulingEnabled(){
    const has = window.Portal?.appFlags?.has || window.PlatformAPI?.appFlags?.has;
    return typeof has === 'function' && has('apps', 'equipment') === true && has('equipment', 'scheduling') === true;
  }
  function projectRoutingViewEnabled(){
    const has = window.Portal?.appFlags?.has || window.PlatformAPI?.appFlags?.has;
    return typeof has === 'function' ? has('scheduling', 'routing') !== false : true;
  }
  function projectGanttViewEnabled(){
    const has = window.Portal?.appFlags?.has || window.PlatformAPI?.appFlags?.has;
    return typeof has === 'function' ? has('scheduling', 'gantt') !== false : true;
  }

  function equipmentEventHidden(event){
    return !equipmentSchedulingEnabled() && productionResourceType(event) === 'equipment';
  }

  function projectWorkEvents(){
    return scheduleProjectEvents()
      .filter(isProjectWorkEvent)
      .filter((event) => !equipmentEventHidden(event))
      .filter(materialEventIsScheduled)
      .map((event) => {
        const start = window.PlatformScheduling?.eventStart?.(event) || new Date(event.start_at || event.start || 0);
        const end = window.PlatformScheduling?.eventEnd?.(event) || new Date(event.end_at || event.end || start.getTime() + (Number(event.duration_minutes) || 480) * 60000);
        return { ...event, __start: start, __end: end };
      })
      .filter((event) => Number.isFinite(event.__start.getTime()) && Number.isFinite(event.__end.getTime()))
      .sort((a, b) => a.__start - b.__start);
  }

  function isMaterialDeliveryEvent(event = {}){
    const resourceType = productionResourceType(event);
    if (resourceType === 'labor' || resourceType === 'equipment') return false;
    if (resourceType === 'material') return true;
    if (window.PlatformScheduleView?.isMaterialDeliveryEvent?.(event)) return true;
    return window.PlatformScheduling?.eventKind?.(event) === 'material_delivery'
      || (!!String(event.material_list_id || event.materialListId || '').trim() && !String(event.scope_resource_list_id || '').trim());
  }

  function productionResourceType(event = {}){
    const explicit = String(event.resource_type || event.metadata?.resource_type || '').trim().toLowerCase();
    if (['material', 'labor', 'equipment'].includes(explicit)) return explicit;
    if (String(event.labor_list_id || '').trim()) return 'labor';
    if (String(event.equipment_list_id || '').trim()) return 'equipment';
    const kind = String(event.kind || event.schedule_item_kind || '').trim().toLowerCase();
    if (kind === 'material_delivery' || kind === 'materials_delivery') return 'material';
    return '';
  }

  function isScopeResourceEvent(event = {}){
    return !!productionResourceType(event)
      || !!String(event.scope_resource_list_id || event.labor_list_id || event.equipment_list_id || '').trim();
  }

  function productionResourceIcon(event = {}){
    const type = productionResourceType(event);
    if (type === 'labor') return 'fa-hammer';
    if (type === 'equipment') return 'fa-truck-pickup';
    if (type === 'material') return 'fa-truck-ramp-box';
    return String(event.icon || 'fa-hammer').trim();
  }

  function productionResourceLabel(event = {}){
    const type = productionResourceType(event);
    if (type === 'labor') return 'Labor';
    if (type === 'equipment') return 'Equipment';
    return 'Material delivery';
  }

  function materialEventIsScheduled(event = {}){
    if (window.PlatformScheduling?.eventIsScheduled) return window.PlatformScheduling.eventIsScheduled(event);
    return !['unscheduled', 'cancelled', 'canceled'].includes(String(event.status || '').toLowerCase())
      && !!String(event.start_at || event.start || '').trim();
  }

  function materialEventIsLocked(event = {}){
    return window.PlatformScheduling?.eventIsLocked?.(event) === true
      || window.PlatformScheduleView?.eventIsLocked?.(event) === true
      || event.locked === true
      || event.schedule_locked === true;
  }

  function materialEventIsOrdered(event = {}){
    if (window.PlatformScheduleView?.materialDeliveryIsOrdered) return window.PlatformScheduleView.materialDeliveryIsOrdered(event);
    return event.ordered === true || ['ordered', 'submitted', 'confirmed', 'processing', 'scheduled', 'delivering', 'partially_delivered', 'delivered']
      .includes(String(event.order_status || event.material_order_status || '').toLowerCase());
  }

  function projectMaterialEvents(){
    const Scheduling = window.PlatformScheduling;
    return scheduleProjectEvents()
      .filter(isScopeResourceEvent)
      .map((event) => {
        const start = Scheduling?.eventStart?.(event) || null;
        const end = start ? (Scheduling?.eventEnd?.(event) || new Date(start.getTime() + 60 * 60000)) : null;
        return { ...event, __start: start, __end: end };
      })
      .sort((a, b) => (a.__start?.getTime?.() ?? Number.MAX_SAFE_INTEGER) - (b.__start?.getTime?.() ?? Number.MAX_SAFE_INTEGER));
  }

  function selectedMaterialEvent(){
    const byId = materialScheduleEventId
      ? projectMaterialEvents().find((event) => String(event.id || '') === String(materialScheduleEventId))
      : null;
    if (byId) return byId;
    return materialScheduleListId
      ? projectMaterialEvents().find((event) => String(event.scope_resource_list_id || event.material_list_id || event.materialListId || '') === String(materialScheduleListId)) || null
      : null;
  }

  function focusMaterialDelivery(payload = {}){
    const eventId = String(payload.event_id || payload.eventId || '').trim();
    const listId = String(payload.scope_resource_list_id || payload.material_list_id || payload.materialListId || '').trim();
    const event = (eventId ? projectMaterialEvents().find((item) => String(item.id || '') === eventId) : null)
      || (listId ? projectMaterialEvents().find((item) => String(item.scope_resource_list_id || item.material_list_id || item.materialListId || '') === listId) : null)
      || null;
    const sameSelection = materialScheduleModeActive
      && String(materialScheduleEventId || '') === String(event?.id || eventId || '')
      && !materialScheduleDraft?.start;
    if (sameSelection) {
      materialScheduleModeActive = false;
      materialScheduleEventId = '';
      materialScheduleListId = '';
      materialScheduleDraft = null;
      if (state.active) renderSchedulePanel();
      return !!event;
    }
    materialScheduleModeActive = true;
    materialScheduleEventId = String(event?.id || eventId || '');
    materialScheduleListId = String(event?.scope_resource_list_id || event?.material_list_id || event?.materialListId || listId || '');
    materialScheduleDraft = null;
    scheduleModeActive = false;
    workScheduleModeActive = false;
    scheduleSchedulingTarget = 'materials';
    scheduleSelectedEventId = '';
    scheduleAssignmentEventId = '';
    setActivePreviewTab('schedule');
    if (state.active) renderSchedulePanel();
    return !!event;
  }

  function setMaterialScheduleDraft(next = null){
    const event = selectedMaterialEvent();
    if (!next?.start || !event) {
      materialScheduleDraft = null;
    } else {
      const start = new Date(next.start);
      const fallbackEnd = next.all_day === false ? new Date(start.getTime() + 60 * 60000) : scheduleAddDays(start, 1);
      materialScheduleDraft = {
        ...event,
        ...next,
        id: event.id,
        event_id: event.id,
        start,
        end: next.end ? new Date(next.end) : fallbackEnd,
        all_day: next.all_day !== false,
        schedule_granularity: next.schedule_granularity || (next.all_day === false ? 'time' : 'date')
      };
    }
    renderScheduleLeft();
  }

  async function persistMaterialScheduleEvent(event){
    const Scheduling = window.PlatformScheduling;
    const project = await ensureRemoteSchedulingProject();
    if (!Scheduling || !project?.id || !event?.id) return null;
    const saved = await Scheduling.saveProjectEvent(scheduleOrgId(), project, event, scheduleCachedConfig || null);
    activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project?.events || activeBaseProject?.events || [] };
    persistActiveBaseProject();
    rememberScheduleProject(activeBaseProject);
    window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
    window.dispatchEvent(new CustomEvent('fm:projects:refresh'));
    return saved;
  }

  async function saveMaterialScheduleDraft(next = materialScheduleDraft){
    const Scheduling = window.PlatformScheduling;
    const event = selectedMaterialEvent();
    if (!Scheduling || !event?.id || !next?.start) return;
    if (materialEventIsLocked(event)) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_88e13d64071885","Schedule locked") ?? "Schedule locked"), (globalThis.PlatformLanguage?.text("project-schedule","m_2896561e271b21","Unlock this delivery before rescheduling it.") ?? "Unlock this delivery before rescheduling it."), false);
      return;
    }
    const start = new Date(next.start);
    const end = next.end ? new Date(next.end) : (next.all_day === false ? new Date(start.getTime() + 60 * 60000) : scheduleAddDays(start, 1));
    const updated = {
      ...Scheduling.updateProjectEventRange(event, {
        start,
        end,
        all_day: next.all_day !== false,
        schedule_granularity: next.schedule_granularity || (next.all_day === false ? 'time' : 'date')
      }),
      status: 'scheduled',
      schedule_item_kind: event.schedule_item_kind || productionResourceType(event) || 'production',
      scope_resource_list_id: event.scope_resource_list_id || materialScheduleListId,
      material_list_id: event.material_list_id || materialScheduleListId,
      updated_at: new Date().toISOString()
    };
    try {
      await persistMaterialScheduleEvent(updated);
      materialScheduleDraft = null;
      scheduleAnchorDate = start;
      renderSchedulePanel();
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_165bc3ab3937ae","Production scheduled") ?? "Production scheduled"), ((v0) => globalThis.PlatformLanguage?.text("project-schedule","m_d30ad66a8eab41",`${v0} was placed on the project schedule.`,{v0}) ?? `${v0} was placed on the project schedule.`)(event.title || productionResourceLabel(event)), true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), error?.message || 'Could not schedule this production item.', false);
    }
  }

  async function saveMaterialScheduleRange(event, range){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling || !event?.id || materialEventIsLocked(event)) return;
    const next = {
      ...Scheduling.updateProjectEventRange(event, range),
      status: 'scheduled',
      updated_at: new Date().toISOString()
    };
    const mutationVersion = beginScheduleEventSave(next.id);
    upsertLocalProjectEvent(next);
    materialScheduleEventId = String(event.id || materialScheduleEventId);
    await saveProjectEventQuiet(next, {
      successTitle: 'Delivery updated',
      successMessage: 'The material delivery schedule was saved.',
      failureTitle: 'Scheduling failed',
      broadcast: false,
      preserveLocalEvents: true,
      mutationVersion
    });
  }

  async function toggleMaterialScheduleLock(event, requestedLocked = null){
    if (!event?.id) return;
    const locked = materialEventIsLocked(event);
    const nextLocked = typeof requestedLocked === 'boolean' ? requestedLocked : !locked;
    if (nextLocked === locked) return;
    if (locked && !nextLocked && materialEventIsOrdered(event)) {
      const confirmed = await Portal?.ui?.confirm?.((globalThis.PlatformLanguage?.text("project-schedule","m_ad42d2a999c6f8","This item has already been ordered. Are you sure you want to reschedule?") ?? "This item has already been ordered. Are you sure you want to reschedule?"), {
        title: (globalThis.PlatformLanguage?.text("project-schedule","m_7fa4cd849f2943","Unlock material delivery") ?? "Unlock material delivery"),
        okLabel: 'Unlock',
        cancelLabel: 'Keep locked',
        danger: true
      });
      if (!confirmed) return;
    }
    const now = new Date().toISOString();
    try {
      await persistMaterialScheduleEvent({
        ...event,
        locked: nextLocked,
        schedule_locked: nextLocked,
        schedule_lock: {
          ...(event.schedule_lock || {}),
          locked: nextLocked,
          reason: materialEventIsOrdered(event) ? 'material_order' : 'manual',
          locked_at: nextLocked ? now : '',
          unlocked_at: nextLocked ? '' : now
        },
        unlock_confirmed: locked && !nextLocked,
        updated_at: now
      });
      renderSchedulePanel();
      showToast(nextLocked ? 'Delivery locked' : 'Delivery unlocked', nextLocked ? 'The delivery date is protected.' : 'You can move the delivery now.', true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_b20cc0a5a8b73a","Lock update failed") ?? "Lock update failed"), error?.message || 'Could not update this delivery lock.', false);
    }
  }

  function allProjectWorkEvents(){
    const Scheduling = window.PlatformScheduling;
    const projects = mergeScheduleActiveProject(scheduleCachedProjects);
    const projectById = new Map(projects.map((project) => [String(project.id || ''), project]));
    const rawEvents = Scheduling?.eventsFromProjects?.(projects, scheduleCachedConfig || null) || [];
    return rawEvents
      .filter(isProjectWorkEvent)
      .filter((event) => !equipmentEventHidden(event))
      .filter(materialEventIsScheduled)
      .map((event) => {
        const project = projectById.get(String(event.project_id || '')) || null;
        const start = Scheduling?.eventStart?.(event) || new Date(event.start_at || event.start || 0);
        const end = Scheduling?.eventEnd?.(event) || new Date(event.end_at || event.end || start.getTime() + (Number(event.duration_minutes) || 480) * 60000);
        const projectTitle = project?.title || project?.customer_name || project?.customerName || project?.address || event.project_title || '';
        return {
          ...event,
          requirement_warnings:window.PlatformScheduling?.eventRequirementWarnings?.(event, {
            equipmentUnits:scheduleCachedEquipmentUnits,
            includeEquipment:equipmentSchedulingEnabled()
          }) || [],
          title: event.title && event.title !== (globalThis.PlatformLanguage?.text("project-schedule","m_f2b5ece6200fa2","Work Section") ?? "Work Section") ? event.title : (projectTitle || event.title || (globalThis.PlatformLanguage?.text("project-schedule","m_222066ef57ae0e","Work") ?? "Work")),
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
      || event?.assigned_user_id
      || workCrewId(event));
  }

  function workAssignmentReferencesEvent(event = {}, resourceId = ''){
    const id = String(resourceId || '').trim();
    if (!id) return false;
    return [event?.id, event?.event_id].map((value) => String(value || '').trim()).filter(Boolean).includes(id);
  }

  function workCrewId(event = {}){
    let id = '';
    if (event?.work_resource_ref?.id) id = String(event.work_resource_ref.id).trim();
    else if (Object.prototype.hasOwnProperty.call(event, 'assigned_resource_id')) id = String(event.assigned_resource_id || '').trim();
    else if (Object.prototype.hasOwnProperty.call(event, 'resource_id')) id = String(event.resource_id || '').trim();
    else if (Object.prototype.hasOwnProperty.call(event, 'assigned_crew_id')) id = String(event.assigned_crew_id || '').trim();
    else if (Object.prototype.hasOwnProperty.call(event, 'crew_id')) id = String(event.crew_id || '').trim();
    if (workAssignmentReferencesEvent(event, id)) id = '';
    return id || String(event?.assigned_user_id || event?.assigned_user_ids?.[0] || event?.assigned_users?.[0]?.id || '').trim();
  }

  function workCrewName(event = {}){
    if (!workCrewId(event)) return '';
    let name = '';
    if (event?.work_resource_ref?.name) name = String(event.work_resource_ref.name).trim();
    else if (Object.prototype.hasOwnProperty.call(event, 'assigned_resource_name')) name = String(event.assigned_resource_name || '').trim();
    else if (Object.prototype.hasOwnProperty.call(event, 'resource_name')) name = String(event.resource_name || '').trim();
    else if (Object.prototype.hasOwnProperty.call(event, 'assigned_crew_name')) name = String(event.assigned_crew_name || '').trim();
    else name = String(event.crew_name || event.assigned_crew?.name || event.crew?.name || '').trim();
    if (workAssignmentReferencesEvent(event, name)) name = '';
    return name || String(event?.assigned_user_name || event?.assigned_users?.[0]?.name || event?.assigned_users?.[0]?.email || '').trim();
  }

  function workResourceKind(event = {}){
    const hasUser = !!String(event?.assigned_user_id || event?.assigned_user_ids?.[0] || event?.assigned_users?.[0]?.id || '').trim();
    return String(event?.work_resource_ref?.kind || event.assigned_resource_kind || event.resource_kind || (hasUser ? 'organization_user' : (workCrewId(event) ? 'resource_group' : ''))).trim();
  }

  function crewPayloadForSelection(crewId, crews = scheduleWorkResources(scheduleCachedConfig, scheduleCachedUsers)){
    const selectedId = String(crewId || '').trim();
    const crew = selectedId ? crews.find((item) => String(item.id || '') === selectedId) : null;
    if (crew) {
      const subjectType = String(crew.subject_type || crew.resource_kind || '').trim();
      if (subjectType === 'organization_user') {
        return {
          crew_id: '',
          crew_name: '',
          resource_id: crew.id,
          resource_name: crew.name,
          work_resource_ref: null,
          assigned_resource_kind: '',
          assigned_resource_id:'',
          assigned_resource_name:'',
          assigned_crew_id: '',
          assigned_crew_name: '',
          assigned_crew: null,
          assigned_user_ids:[crew.id],
          assigned_users:[{ id:crew.id, name:crew.name, role_ids:crew.role_ids || crew.roles || [] }],
          assigned_user_id:crew.id,
          assigned_user_name:crew.name,
          crew_label: crew.name,
          awaiting_crew: false
        };
      }
      return {
        crew_id: crew.id,
        crew_name: crew.name,
        resource_id: crew.id,
        resource_name: crew.name,
        work_resource_ref: { kind: crew.resource_kind || 'resource_group', id: crew.id, name: crew.name },
        assigned_resource_kind: crew.resource_kind || 'resource_group',
        assigned_resource_id:crew.id,
        assigned_resource_name:crew.name,
        assigned_crew_id: crew.id,
        assigned_crew_name: crew.name,
        assigned_crew: { id: crew.id, name: crew.name },
        assigned_user_ids:[],
        assigned_users:[],
        assigned_user_id:'',
        assigned_user_name:'',
        crew_label: crew.name,
        awaiting_crew: false
      };
    }
    return {
      crew_id: '',
      crew_name: '',
      resource_id: '',
      resource_name: '',
      work_resource_ref: null,
      assigned_resource_kind: '',
      assigned_resource_id:'',
      assigned_resource_name:'',
      assigned_crew_id: '',
      assigned_crew_name: '',
      assigned_crew: null,
      assigned_user_ids:[],
      assigned_users:[],
      assigned_user_id:'',
      assigned_user_name:'',
      crew_label: 'Unassigned',
      awaiting_crew: crews.length > 1
    };
  }

  function workCrewCalendarPayload(event = {}, crews = scheduleWorkResources(scheduleCachedConfig, scheduleCachedUsers)){
    const existingId = workCrewId(event);
    const existingName = workCrewName(event);
    const activeCrew = existingId ? crews.find((crew) => String(crew.id || '') === String(existingId)) : null;
    if (activeCrew) {
      return crewPayloadForSelection(activeCrew.id, crews);
    }
    if (existingId || existingName) {
      if (workResourceKind(event) === 'organization_user') {
        return {
          ...crewPayloadForSelection('', crews),
          resource_id:existingId,
          resource_name:existingName,
          assigned_user_ids:existingId ? [existingId] : [],
          assigned_users:existingId ? [{ id:existingId, name:existingName || existingId, role_ids:event?.assigned_users?.[0]?.role_ids || [] }] : [],
          assigned_user_id:existingId,
          assigned_user_name:existingName,
          crew_label:existingName || 'Unassigned',
          awaiting_crew:true
        };
      }
      return {
        crew_id: existingId,
        crew_name: existingName,
        resource_id: existingId,
        resource_name: existingName,
        work_resource_ref: existingId ? { kind:workResourceKind(event), id:existingId, name:existingName } : null,
        assigned_resource_kind: workResourceKind(event),
        assigned_resource_id:existingId,
        assigned_resource_name:existingName,
        assigned_crew_id: existingId,
        assigned_crew_name: existingName,
        assigned_crew: event.assigned_crew || (existingId ? { id: existingId, name: existingName } : null),
        assigned_user_ids:[],
        assigned_users:[],
        assigned_user_id:'',
        assigned_user_name:'',
        crew_label: existingName || 'Unassigned',
        awaiting_crew: true
      };
    }
    return {
      crew_id: '',
      crew_name: '',
      resource_id: '',
      resource_name: '',
      work_resource_ref: null,
      assigned_resource_kind: '',
      assigned_resource_id:'',
      assigned_resource_name:'',
      assigned_crew_id: '',
      assigned_crew_name: '',
      assigned_crew: null,
      assigned_user_ids:[],
      assigned_users:[],
      assigned_user_id:'',
      assigned_user_name:'',
      crew_label: 'Unassigned',
      awaiting_crew: true
    };
  }

  function workAssignmentResources(event = {}){
    const crews = scheduleWorkResources(scheduleCachedConfig, scheduleCachedUsers, event.scope_template_id);
    const currentId = workCrewId(event);
    if (currentId && !crews.some((crew) => String(crew.id || '') === currentId)) {
      const known = scheduleCachedWorkResources.find((crew) => String(crew.id || '') === currentId);
      crews.push(known || {
        id: currentId,
        name: workCrewName(event) || currentId,
        resource_kind: workResourceKind(event) || 'resource_group'
      });
    }
    return crews;
  }

  function closeWorkAssignmentMenu(){
    scheduleCrewMenuEventId = '';
    document.querySelectorAll('[data-production-resource-crew][aria-expanded="true"]').forEach((node) => node.setAttribute('aria-expanded', 'false'));
    if (scheduleCrewMenuDocHandler) {
      scheduleCrewMenuDocHandler();
      scheduleCrewMenuDocHandler = null;
    }
    document.querySelectorAll('.r-schedule-crew-popover').forEach((node) => node.remove());
  }

  function closeScheduleEventPopover(){
    scheduleEventPopoverId = '';
    if (scheduleEventPopoverDocHandler) {
      scheduleEventPopoverDocHandler();
      scheduleEventPopoverDocHandler = null;
    }
    document.querySelectorAll('.r-schedule-event-popover').forEach((node) => node.remove());
  }

  function schedulePopoverHost(anchor = null){
    const modalRoot = anchor?.closest?.('[data-fm-modal-id], #rOverlay, .r-overlay');
    if (modalRoot) return modalRoot;
    const contextRoot = state.context?.overlayRoot || state.context?.roots?.overlay || null;
    if (contextRoot instanceof Element && (!anchor || contextRoot.contains(anchor))) return contextRoot;
    return document.body;
  }

  function scheduleEventKind(event = {}){
    if (isMaterialDeliveryEvent(event)) return { label:(globalThis.PlatformLanguage?.text("project-schedule","m_b73185deef6d79","Delivery") ?? "Delivery"), icon:'fa-truck-ramp-box' };
    if (productionResourceType(event) === 'labor' || isProjectWorkEvent(event)) return { label:(globalThis.PlatformLanguage?.text("project-schedule","m_7acfa5ed3b7739","Labor") ?? "Labor"), icon:'fa-hammer' };
    return { label:(globalThis.PlatformLanguage?.text("project-schedule","m_0b0eba838f2956","Event") ?? "Event"), icon:'fa-calendar' };
  }

  function scheduleEventDisplayTitle(event = {}){
    const title = isMaterialDeliveryEvent(event)
      ? materialDeliveryTitle(event)
      : String(event.title || event.project_title || 'Scheduled event').trim();
    return title || 'Scheduled event';
  }

  function scheduleEventAssignmentField(event = {}){
    if (productionResourceType(event) !== 'labor' && !isProjectWorkEvent(event)) return '';
    const resources = workAssignmentResources(event);
    const selectedId = workCrewId(event);
    const options = [
      ("<option value=\"\" " + String(selectedId ? '' : 'selected') + ">" + (globalThis.PlatformLanguage?.text("project-schedule","m_8a993ed9b573b4","Unassigned") ?? "Unassigned") + "</option>"),
      ...resources.map((resource) => `<option value="${escapeHtml(resource.id || '')}" ${String(resource.id || '') === selectedId ? 'selected' : ''}>${escapeHtml(resource.name || resource.id || '')}</option>`)
    ];
    return `<label class="r-schedule-event-popover-field">${escapeHtml(workforceTerm('resource_group'))}<select data-schedule-event-crew="${escapeHtml(event.id || '')}">${options.join('')}</select></label>`;
  }

  /* ── Appointment confirmation panel ───────────────────────────────────────
   * Shows where the customer's confirmation stands, and lets staff resend it
   * or mark it confirmed when the customer calls instead of replying. Renders
   * nothing at all when the viewer can't see confirmation state. */

  function scheduleConfirmationState(event = {}){
    const scheduling = window.PlatformScheduling;
    if (!scheduling || typeof scheduling.visibleConfirmationState !== 'function') return null;
    try {
      return scheduling.visibleConfirmationState(event);
    } catch {
      return null;
    }
  }

  function confirmationTimingLabel(state = {}){
    const stamp = state.confirmed_at || state.declined_at || state.sent_at || state.scheduled_send_at;
    if (!stamp) return '';
    const when = new Date(stamp);
    if (!Number.isFinite(when.getTime())) return '';
    const formatted = when.toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    if (state.confirmed_at) return `Confirmed ${formatted}`;
    if (state.declined_at) return `Reschedule requested ${formatted}`;
    if (state.sent_at) return `Asked ${formatted}`;
    return `Sending ${formatted}`;
  }

  function scheduleConfirmationBlock(event = {}){
    const state = scheduleConfirmationState(event);
    if (!state) return '';
    const channels = [];
    if (state.channels?.email === true) channels.push('email');
    if (state.channels?.sms === true) channels.push('text');
    const timing = confirmationTimingLabel(state);
    const reply = state.response_text
      ? `<div class="r-schedule-confirm-reply">“${escapeHtml(String(state.response_text).slice(0, 180))}”</div>`
      : '';
    const error = state.last_error
      ? `<div class="r-schedule-confirm-reply error">${escapeHtml(state.last_error)}</div>`
      : '';
    const actions = state.confirmed
      ? `<button type="button" class="r-schedule-confirm-action" data-schedule-confirm-set="reset">${(globalThis.PlatformLanguage?.text("project-schedule","m_80ae2923b672d0","Mark unconfirmed") ?? "Mark unconfirmed")}</button>`
      : `<button type="button" class="r-schedule-confirm-action primary" data-schedule-confirm-set="confirmed">${(globalThis.PlatformLanguage?.text("project-schedule","m_617e25cc0ca1b3","Mark confirmed") ?? "Mark confirmed")}</button>
         <button type="button" class="r-schedule-confirm-action" data-schedule-confirm-send>${(globalThis.PlatformLanguage?.text("project-schedule","m_b495e5473c85e0","Send now") ?? "Send now")}</button>`;
    return `
      <div class="r-schedule-confirm ${escapeHtml(state.tone)}">
        <div class="r-schedule-confirm-head">
          <i class="fas ${escapeHtml(state.icon)}"></i>
          <div>
            <strong>${escapeHtml(state.label)}</strong>
            ${timing ? `<small>${escapeHtml(timing)}</small>` : ''}
          </div>
        </div>
        ${channels.length ? `<div class="r-schedule-confirm-meta">Requested by ${escapeHtml(channels.join(' and '))}${state.confirmed_via ? ` · answered by ${escapeHtml(state.confirmed_via)}` : ''}</div>` : ''}
        ${reply}
        ${error}
        <div class="r-schedule-confirm-actions">${actions}</div>
      </div>
    `;
  }

  async function applyScheduleConfirmation(event = {}, outcome = 'confirmed'){
    const orgId = scheduleOrgId();
    const projectId = String(event.project_id || activeBaseProject?.id || '');
    if (!orgId || !projectId || !event.id) return;
    const client = window.PlatformAPI?.appointments;
    if (!client) return;
    try {
      if (outcome === 'send') await client.sendConfirmation(orgId, projectId, event.id);
      else await client.setConfirmation(orgId, projectId, event.id, outcome);
      document.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
    } catch (error) {
      window.Portal?.toast?.((globalThis.PlatformLanguage?.text("project-schedule","m_cac0219c86a9cb","Confirmation update failed") ?? "Confirmation update failed"), String(error?.message || error), 'error');
    }
  }

  function openScheduleEventPopover(event = {}, anchor = null){
    if (!event?.id || !anchor) return;
    closeWorkAssignmentMenu();
    closeScheduleEventPopover();
    scheduleEventPopoverId = String(event.id || '');
    const kind = scheduleEventKind(event);
    const address = String(event.project_address || activeBaseProject?.address || '').trim();
    const deliveryStatus = isMaterialDeliveryEvent(event)
      ? `<div class="r-schedule-event-popover-row"><i class="fas fa-box"></i><span>${materialEventIsOrdered(event) ? 'Materials ordered' : 'Materials not ordered'}${materialEventIsLocked(event) ? ' · Date locked' : ''}</span></div>`
      : '';
    const confirmationBlock = scheduleConfirmationBlock(event);
    const requirementWarnings = window.PlatformScheduling?.eventRequirementWarnings?.(event, {
      equipmentUnits:scheduleCachedEquipmentUnits,
      includeEquipment:equipmentSchedulingEnabled()
    }) || [];
    const requirementAlert = requirementWarnings.length
      ? `<div class="r-schedule-requirement-alert" role="alert"><i class="fas fa-triangle-exclamation"></i><ul>${requirementWarnings.map((warning) => `<li>${escapeHtml(warning.label || warning)}</li>`).join('')}</ul></div>`
      : '';
    const popover = document.createElement('div');
    popover.className = 'r-schedule-event-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', ((v0) => globalThis.PlatformLanguage?.text("project-schedule","m_3a90498db63efc",`${v0} details`,{v0}) ?? `${v0} details`)(kind.label));
    popover.innerHTML = `
      <div class="r-schedule-event-popover-head">
        <div class="r-schedule-event-popover-title"><span class="r-schedule-event-popover-kind"><i class="fas ${String(kind.icon)}"></i>${String(escapeHtml(kind.label))}</span><br>${String(escapeHtml(scheduleEventDisplayTitle(event)))}</div>
        <button type="button" class="r-schedule-event-popover-close" data-schedule-event-close aria-label="${(globalThis.PlatformLanguage?.text("project-schedule","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-times"></i></button>
      </div>
      <div class="r-schedule-event-popover-details">
        <div class="r-schedule-event-popover-row"><i class="fas fa-calendar-day"></i><span>${String(escapeHtml(workRangeLabel(event)))}</span></div>
        ${String(address ? `<div class="r-schedule-event-popover-row"><i class="fas fa-location-dot"></i><span>${escapeHtml(address)}</span></div>` : '')}
        ${String(deliveryStatus)}
      </div>
      ${String(requirementAlert)}
      ${String(confirmationBlock)}
      ${String(scheduleEventAssignmentField(event))}
      <div class="r-schedule-event-customer">
        <label class="r-schedule-event-share">
          <input type="checkbox" data-schedule-event-customer-visible ${String(event.customer_visible === true ? 'checked' : '')}>
          <span class="r-schedule-event-share-toggle" aria-hidden="true"></span>
          <span><strong>${(globalThis.PlatformLanguage?.text("project-schedule","m_a043dc814fd7c4","Share with customer") ?? "Share with customer")}</strong><small>${(globalThis.PlatformLanguage?.text("project-schedule","m_e2fe6c0dc1bf57","Choose exactly what appears in the customer portal.") ?? "Choose exactly what appears in the customer portal.")}</small></span>
        </label>
        <div class="r-schedule-event-customer-options ${String(event.customer_visible === true ? 'open' : '')}" data-schedule-event-customer-options>
          <label class="r-schedule-event-customer-option"><input type="checkbox" data-schedule-event-customer-show-title ${String(event.customer_show_title !== false ? 'checked' : '')}><span>${(globalThis.PlatformLanguage?.text("project-schedule","m_aa81c572cfc2fb","Show the event title ") ?? "Show the event title ")}<small>${((v12) => globalThis.PlatformLanguage?.text("project-schedule","m_16cc20f54509eb",`(otherwise show only “${v12}”)`,{v12}) ?? `(otherwise show only “${v12}”)`)(escapeHtml(kind.label))}</small></span></label>
          <label class="r-schedule-event-customer-option"><input type="checkbox" data-schedule-event-customer-show-crew ${String(event.customer_show_crew === true ? 'checked' : '')}><span>${(globalThis.PlatformLanguage?.text("project-schedule","m_0a4066db1bfb68","Show the assigned crew or team member") ?? "Show the assigned crew or team member")}</span></label>
          <label class="r-schedule-event-customer-note">${(globalThis.PlatformLanguage?.text("project-schedule","m_413958fd110fa8","Customer-facing note") ?? "Customer-facing note")}<textarea data-schedule-event-customer-description placeholder="${(globalThis.PlatformLanguage?.text("project-schedule","m_f75a0e40848c45","What should the customer see when they open this event?") ?? "What should the customer see when they open this event?")}">${String(escapeHtml(event.customer_description || ''))}</textarea></label>
          ${String(window.Portal?.can?.('scheduling.customer_rescheduling') === true ? `<label class="r-schedule-event-customer-option"><input type="checkbox" data-schedule-event-customer-reschedule ${event.customer_scheduling?.enabled === true ? 'checked' : ''}><span>Allow the customer to choose another live available time</span></label>` : '')}
        </div>
        <button type="button" class="r-schedule-event-customer-save" data-schedule-event-customer-save>${(globalThis.PlatformLanguage?.text("project-schedule","m_d2ad3eac5a7c69","Save customer view") ?? "Save customer view")}</button>
      </div>
    `;
    schedulePopoverHost(anchor).appendChild(popover);
    const rect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const left = Math.min(window.innerWidth - popoverRect.width - 8, Math.max(8, rect.left));
    const preferredTop = rect.bottom + 8;
    const top = preferredTop + popoverRect.height <= window.innerHeight - 8
      ? preferredTop
      : Math.max(8, rect.top - popoverRect.height - 8);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.querySelector('[data-schedule-event-close]')?.addEventListener('click', (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      closeScheduleEventPopover();
    });
    popover.querySelector('[data-schedule-event-crew]')?.addEventListener('change', (changeEvent) => {
      changeEvent.stopPropagation();
      saveWorkCrewAssignment(event, changeEvent.currentTarget.value || '');
      closeScheduleEventPopover();
    });
    popover.querySelectorAll('[data-schedule-confirm-set]').forEach((button) => {
      button.addEventListener('click', (clickEvent) => {
        clickEvent.stopPropagation();
        applyScheduleConfirmation(event, button.dataset.scheduleConfirmSet || 'confirmed');
        closeScheduleEventPopover();
      });
    });
    popover.querySelector('[data-schedule-confirm-send]')?.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      applyScheduleConfirmation(event, 'send');
      closeScheduleEventPopover();
    });
    popover.querySelector('[data-schedule-event-customer-visible]')?.addEventListener('change', (changeEvent) => {
      changeEvent.stopPropagation();
      popover.querySelector('[data-schedule-event-customer-options]')?.classList.toggle('open', changeEvent.currentTarget.checked === true);
    });
    popover.querySelector('[data-schedule-event-customer-save]')?.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      saveScheduleEventCustomerSettings(event, {
        customer_visible: popover.querySelector('[data-schedule-event-customer-visible]')?.checked === true,
        customer_show_title: popover.querySelector('[data-schedule-event-customer-show-title]')?.checked !== false,
        customer_show_crew: popover.querySelector('[data-schedule-event-customer-show-crew]')?.checked === true,
        customer_description: popover.querySelector('[data-schedule-event-customer-description]')?.value || '',
        customer_scheduling:{ ...(event.customer_scheduling || {}), enabled:popover.querySelector('[data-schedule-event-customer-reschedule]')?.checked === true, actions:['reschedule'] }
      });
      closeScheduleEventPopover();
    });
    setTimeout(() => {
      scheduleEventPopoverDocHandler = bindOutsidePointerDismiss(popover, closeScheduleEventPopover, [anchor]);
    }, 0);
  }

  async function saveScheduleEventCustomerSettings(event = {}, settings = {}){
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(event.id || '')) || event;
    if (!source?.id) return;
    const next = {
      ...source,
      customer_visible: settings.customer_visible === true,
      customer_show_title: settings.customer_show_title !== false,
      customer_show_crew: settings.customer_show_crew === true,
      customer_description: String(settings.customer_description || '').trim(),
      customer_scheduling: settings.customer_scheduling && typeof settings.customer_scheduling === 'object' ? settings.customer_scheduling : source.customer_scheduling,
      updated_at:new Date().toISOString()
    };
    upsertLocalProjectEvent(next);
    renderSchedulePanel();
    const saved = await saveProjectEventQuiet(next, {
      successTitle: next.customer_visible ? 'Customer view saved' : 'Event made internal',
      successMessage: next.customer_visible ? 'The customer-facing event details were updated.' : 'This event is no longer visible in the customer portal.',
      failureTitle: 'Customer view update failed'
    });
    if (!saved) {
      upsertLocalProjectEvent(source);
      renderSchedulePanel();
    }
  }

  async function saveWorkCrewAssignment(event = {}, crewId = ''){
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(event.id || '')) || event;
    if (!source?.id || productionResourceType(source) === 'material') return;
    const resources = workAssignmentResources(source);
    const payload = crewPayloadForSelection(crewId, resources);
    const next = { ...source, ...payload, updated_at:new Date().toISOString() };
    closeWorkAssignmentMenu();
    upsertLocalProjectEvent(next);
    const draftId = String(source.id || '');
    if (workScheduleDrafts.has(draftId)) {
      workScheduleDrafts.set(draftId, { ...workScheduleDrafts.get(draftId), ...payload });
    }
    const scrollPosition = captureScheduleScroll();
    renderSchedulePanel();
    restoreScheduleScroll(scrollPosition);
    const saved = await saveProjectEventQuiet(next, {
      successTitle: 'Crew updated',
      successMessage: payload.work_resource_ref?.name ? `${payload.work_resource_ref.name} is assigned.` : 'The work item is unassigned.',
      failureTitle: 'Crew update failed'
    });
    if (!saved) {
      upsertLocalProjectEvent(source);
      renderSchedulePanelPreservingScroll();
    }
  }

  function openWorkAssignmentMenu(event = {}, anchor = null){
    if (!event?.id || !anchor) return;
    if (scheduleCrewMenuEventId === String(event.id || '') && document.querySelector('.r-schedule-crew-popover')) {
      closeWorkAssignmentMenu();
      return;
    }
    closeWorkAssignmentMenu();
    scheduleCrewMenuEventId = String(event.id || '');
    anchor.setAttribute?.('aria-expanded', 'true');
    const currentId = workCrewId(event);
    const resources = workAssignmentResources(event);
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'r-schedule-crew-popover';
    menu.style.left = `${Math.min(window.innerWidth - 228, Math.max(8, rect.left))}px`;
    menu.style.top = `${Math.min(window.innerHeight - 288, Math.max(8, rect.bottom + 7))}px`;
    const option = (id, label) => `<button type="button" class="r-schedule-crew-option ${String(currentId || '') === String(id || '') ? 'active' : ''}" data-work-crew-option="${escapeHtml(id || '')}">${escapeHtml(label)}</button>`;
    menu.innerHTML = `${option('', 'Unassigned')}${resources.map((resource) => option(resource.id, resource.name || resource.id)).join('')}`;
    menu.querySelectorAll('[data-work-crew-option]').forEach((button) => button.addEventListener('click', (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      saveWorkCrewAssignment(event, button.dataset.workCrewOption || '');
    }));
    schedulePopoverHost(anchor).appendChild(menu);
    setTimeout(() => {
      scheduleCrewMenuDocHandler = bindOutsidePointerDismiss(menu, closeWorkAssignmentMenu, [anchor]);
    }, 0);
  }

  function decorateWorkEventForCalendar(event, crews = scheduleWorkResources(scheduleCachedConfig, scheduleCachedUsers, event?.scope_template_id)){
    return {
      ...event,
      requirement_warnings:window.PlatformScheduling?.eventRequirementWarnings?.(event, {
        equipmentUnits:scheduleCachedEquipmentUnits,
        includeEquipment:equipmentSchedulingEnabled()
      }) || [],
      ...workCrewCalendarPayload(event, crews)
    };
  }

  function workAssignmentSelectHtml(workScheduleDraft){
    const crews = scheduleWorkResources(scheduleCachedConfig, scheduleCachedUsers, workScheduleDraft?.scope_template_id);
    const selected = workCrewId(workScheduleDraft);
    const historical = selected && !crews.some((crew) => String(crew.id || '') === selected)
      ? (scheduleWorkResources(scheduleCachedConfig, scheduleCachedUsers).find((crew) => String(crew.id || '') === selected) || { id:selected, name:workCrewName(workScheduleDraft) || selected, resource_kind:workResourceKind(workScheduleDraft), work_resource_ref:{ kind:workResourceKind(workScheduleDraft), id:selected, name:workCrewName(workScheduleDraft) || selected }, capability_scope_ids:[] })
      : null;
    if (historical) crews.push(historical);
    if (crews.length <= 1) return '';
    return `<label class="r-assignment-field">${String(escapeHtml(workResourceLabel()))}<select id="rWorkAssignment" class="r-assignment-select ${String(selected ? '' : 'waiting')}">
      <option value="" ${String(selected ? '' : 'selected')}>${(globalThis.PlatformLanguage?.text("project-schedule","m_8a993ed9b573b4","Unassigned") ?? "Unassigned")}</option>
      ${String(crews.map((crew) => `<option value="${escapeHtml(crew.id)}" ${String(crew.id) === selected ? 'selected' : ''}>${escapeHtml(crew.name)}</option>`).join(''))}
    </select></label>`;
  }

  function salesAssignmentSelectHtml(){
    const salespeople = cachedSalesAppointmentUsers();
    if (salespeople.length <= 1) return '';
    const selected = String(scheduleDraft?.user?.id || schedulePreferredSalesUserId || '').trim();
    return `<label class="r-assignment-field">${(globalThis.PlatformLanguage?.text("project-schedule","m_4aff7f0b72fb1d","Assignee") ?? "Assignee")}<select id="rSalesAssignment" class="r-assignment-select ${String(selected ? '' : 'waiting')}">
      <option value="" ${String(selected ? '' : 'selected')}>${(globalThis.PlatformLanguage?.text("project-schedule","m_8a993ed9b573b4","Unassigned") ?? "Unassigned")}</option>
      ${String(salespeople.map((user) => `<option value="${escapeHtml(user.id)}" ${String(user.id) === selected ? 'selected' : ''}>${escapeHtml(user.name || user.email || user.id)}</option>`).join(''))}
    </select></label>`;
  }

  function normalizeScheduleUser(user = {}){
    const id = String(user.id || user.user_id || '').trim();
    const roles = Array.from(new Set([
      ...(Array.isArray(user.roles) ? user.roles : []),
      ...(Array.isArray(user.role_ids) ? user.role_ids : []),
      ...(Array.isArray(user.access_role_ids) ? user.access_role_ids : [])
    ].map(String).filter(Boolean)));
    return {
      ...user,
      id,
      name:String(user.name || user.display_name || user.email || id).trim(),
      subject_type:'organization_user',
      resource_kind:'organization_user',
      role_ids:roles,
      kind_ids:roles,
      assignment_tag_ids:Array.isArray(user.assignment_tag_ids) ? user.assignment_tag_ids.map(String).filter(Boolean) : [],
      capability_scope_ids:Array.isArray(user.capability_scope_ids) ? user.capability_scope_ids.map(String).filter(Boolean) : []
    };
  }

  function assignmentPayloadForSubjects(subjects = []){
    const selected = Array.isArray(subjects) ? subjects.filter((subject) => subject?.id) : [];
    const selectedUsers = selected.filter((subject) => String(subject.subject_type || subject.resource_kind) === 'organization_user');
    const selectedResource = selected.find((subject) => String(subject.subject_type || subject.resource_kind) !== 'organization_user') || null;
    const base = selectedResource
      ? crewPayloadForSelection(selectedResource.id, selected)
      : crewPayloadForSelection(selectedUsers[0]?.id || '', selected);
    return {
      ...base,
      assigned_user_ids:selectedUsers.map((subject) => subject.id),
      assigned_users:selectedUsers.map((subject) => ({ id:subject.id, name:subject.name || subject.email || subject.id, role_ids:subject.role_ids || subject.roles || [] })),
      assigned_user_id:selectedUsers[0]?.id || '',
      assigned_user_name:selectedUsers[0]?.name || selectedUsers[0]?.email || ''
    };
  }

  function scheduleAssignableSubjects(eventTypeId = 'project_work', scopeTemplateId = '', config = scheduleCachedConfig, users = scheduleCachedUsers){
    const Scheduling = window.PlatformScheduling;
    const normalizedScopeId = String(scopeTemplateId || '').trim();
    const subjects = [
      ...(Array.isArray(users) ? users : []).filter((user) => String(user.status || 'active') !== 'disabled').map(normalizeScheduleUser),
      ...scheduleCachedWorkResources
    ].filter((subject, index, list) => subject.id && list.findIndex((item) => `${item.subject_type}:${item.id}` === `${subject.subject_type}:${subject.id}`) === index);
    const eventType = config?.event_types?.[eventTypeId] || { id:eventTypeId };
    const policy = Scheduling?.assignmentPolicyForEventType?.(eventType, eventTypeId);
    const eligible = Scheduling?.filterAssignableSubjects ? Scheduling.filterAssignableSubjects(subjects, policy) : subjects;
    return eligible.filter((resource) => {
      const ids = Array.isArray(resource.capability_scope_ids) ? resource.capability_scope_ids.map((id) => String(id || '').trim()) : [];
      return resource.subject_type === 'organization_user' || !normalizedScopeId || !ids.length || ids.includes(normalizedScopeId);
    });
  }

  function scheduleWorkResources(config = scheduleCachedConfig, users = scheduleCachedUsers, scopeTemplateId = ''){
    return scheduleAssignableSubjects('project_work', scopeTemplateId, config, users);
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
    return scheduleAssignableSubjects('sales_appointment');
  }

  function startAppointmentScheduling(){
    if (!schedulingEnabled()) return;
    materialScheduleModeActive = false;
    materialScheduleDraft = null;
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

  function projectMobileViewChoices(){
    return [
      ['day', 'Day', 'fa-calendar-day'],
      ['4day', '3 Day', 'fa-calendar-week'],
      ['week', 'Week', 'fa-table-columns'],
      ['month', 'Month', 'fa-calendar-days']
    ];
  }

  function projectMobileYearChoices(){
    const year = scheduleAnchorDate.getFullYear();
    return Array.from({ length:11 }, (_, index) => year - 5 + index);
  }

  function projectMobileToolbarHtml(){
    const choices = projectMobileViewChoices();
    return window.PlatformScheduleView?.mobileCalendarToolbarHtml?.({
      view: scheduleViewMode,
      date: scheduleAnchorDate,
      viewChoices: choices,
      viewMenuOpen: projectMobileViewMenuOpen,
      monthMenuOpen: projectMobileMonthMenuOpen,
      pickerMonth: projectMobilePickerMonth,
      pickerYear: projectMobilePickerYear,
      years: projectMobileYearChoices(),
      attributes: {
        viewMenu:'data-project-mobile-view-menu',
        view:'data-project-mobile-view',
        monthMenu:'data-project-mobile-month-menu',
        month:'data-project-mobile-month',
        year:'data-project-mobile-year',
        today:'data-project-mobile-today',
        nav:'data-project-mobile-nav'
      }
    }) || '';
  }

  function clearProjectMobileControls(){
    if (projectMobileControlsDocHandler) document.removeEventListener('pointerdown', projectMobileControlsDocHandler, true);
    projectMobileControlsDocHandler = null;
  }

  function bindProjectMobileToolbar(rootEl){
    rootEl.querySelector('[data-project-mobile-view-menu]')?.addEventListener('click', () => {
      projectMobileViewMenuOpen = !projectMobileViewMenuOpen;
      projectMobileMonthMenuOpen = false;
      renderSchedulePanel();
    });
    rootEl.querySelector('[data-project-mobile-month-menu]')?.addEventListener('click', () => {
      projectMobileMonthMenuOpen = !projectMobileMonthMenuOpen;
      projectMobileViewMenuOpen = false;
      projectMobilePickerMonth = scheduleAnchorDate.getMonth();
      projectMobilePickerYear = scheduleAnchorDate.getFullYear();
      renderSchedulePanel();
    });
    rootEl.querySelectorAll('[data-project-mobile-view]').forEach((button) => button.addEventListener('click', () => {
      const next = button.dataset.projectMobileView || 'month';
      if (!['day','4day','week','month'].includes(next)) return;
      projectMobileViewMenuOpen = false;
      scheduleViewMode = next;
      window.Portal?.navigation?.push?.({ projectScheduleView:scheduleViewMode }, { source:'project-schedule-mobile-view', ownedKeys:['projectScheduleView'] });
      renderSchedulePanel();
    }));
    const setPickerDate = () => {
      projectMobileMonthMenuOpen = false;
      setScheduleAnchorDate(new Date(projectMobilePickerYear, projectMobilePickerMonth, 1));
    };
    rootEl.querySelectorAll('[data-project-mobile-month]').forEach((button) => button.addEventListener('click', () => {
      projectMobilePickerMonth = Number(button.dataset.projectMobileMonth);
      setPickerDate();
    }));
    rootEl.querySelectorAll('[data-project-mobile-year]').forEach((button) => button.addEventListener('click', () => {
      projectMobilePickerYear = Number(button.dataset.projectMobileYear);
      setPickerDate();
    }));
    rootEl.querySelector('[data-project-mobile-today]')?.addEventListener('click', () => {
      setScheduleAnchorDate(new Date());
    });
    rootEl.querySelectorAll('[data-project-mobile-nav]').forEach((button) => button.addEventListener('click', () => {
      const delta = Number(button.dataset.projectMobileNav || 0);
      const next = scheduleViewMode === 'month'
        ? scheduleMonthShift(scheduleAnchorDate, delta)
        : scheduleAddDays(scheduleAnchorDate, delta * (scheduleViewMode === 'week' ? 7 : (scheduleViewMode === '4day' ? 3 : 1)));
      setScheduleAnchorDate(next);
    }));
    clearProjectMobileControls();
    projectMobileControlsDocHandler = (event) => {
      if (!event.target.closest('.prs-mobile-popover,.prs-mobile-control')) {
        if (!projectMobileViewMenuOpen && !projectMobileMonthMenuOpen) return;
        projectMobileViewMenuOpen = false;
        projectMobileMonthMenuOpen = false;
        renderSchedulePanel();
      }
    };
    document.addEventListener('pointerdown', projectMobileControlsDocHandler, true);
  }

  function scheduleViewSwitchHtml(){
    const terminology = (key, fallback) => window.Portal?.terminology?.get?.(key, fallback) || fallback;
    const calendarModes = [['day', terminology('scheduling.day_view', 'Day')], ['4day', terminology('scheduling.four_day_view', '4 Day')], ['week', terminology('scheduling.week_view', 'Week')], ['month', terminology('scheduling.month_view', 'Month')]];
    const schedulingModes = [['scheduling-week', 'Daily'], ['scheduling-day', 'Hourly']];
    const isScheduling = scheduleIsSchedulingView();
    const isGantt = scheduleViewMode === 'gantt';
    const routingLabel = terminology('scheduling.routing_view', window.PlatformScheduling?.labelFor?.(scheduleCachedConfig, 'ui', 'routing_mode') || 'Routing');
    const ganttLabel = terminology('scheduling.gantt_view', 'Gantt');
    const surfaceActive = (id) => id === 'gantt' ? isGantt : (id === 'scheduling' ? isScheduling && !isGantt : !isScheduling && !isGantt);
    const surfaceButton = (id, label) => `<button type="button" class="r-schedule-view-btn ${surfaceActive(id) ? 'active' : ''}" data-schedule-surface="${id}">${label}</button>`;
    const targetButton = (id, label) => `<button type="button" class="r-schedule-view-btn ${scheduleSchedulingTarget === id ? 'active' : ''}" data-schedule-target="${id}">${label}</button>`;
    const button = ([id, label]) => `<button type="button" class="r-schedule-view-btn ${scheduleViewMode === id || (id === 'scheduling-week' && scheduleViewMode === 'scheduling') ? 'active' : ''}" data-schedule-view="${id}">${escapeHtml(label)}</button>`;
    const modes = isScheduling ? schedulingModes : calendarModes;
    return `<div class="r-schedule-view-switch">
      <span class="r-schedule-view-group surface">${String(surfaceButton('calendar', escapeHtml(terminology('scheduling.calendar_view', 'Calendar'))))}${String(projectRoutingViewEnabled() ? surfaceButton('scheduling', escapeHtml(routingLabel)) : '')}${String(projectGanttViewEnabled() ? surfaceButton('gantt', escapeHtml(ganttLabel)) : '')}</span>
      <span class="r-schedule-view-group navigation"><button type="button" class="r-schedule-anchor-nav" data-schedule-anchor-nav="-1" aria-label="${(globalThis.PlatformLanguage?.text("project-schedule","m_bb31fd73cbfe3b","Previous") ?? "Previous")}" title="${(globalThis.PlatformLanguage?.text("project-schedule","m_bb31fd73cbfe3b","Previous") ?? "Previous")}"><i class="fas fa-chevron-left"></i></button><button type="button" class="r-schedule-anchor-nav today" data-schedule-anchor-nav="0">${(globalThis.PlatformLanguage?.text("project-schedule","m_23929ba4ba84dd","Today") ?? "Today")}</button><button type="button" class="r-schedule-anchor-nav" data-schedule-anchor-nav="1" aria-label="${(globalThis.PlatformLanguage?.text("project-schedule","m_5e03a7c216f500","Next") ?? "Next")}" title="${(globalThis.PlatformLanguage?.text("project-schedule","m_5e03a7c216f500","Next") ?? "Next")}"><i class="fas fa-chevron-right"></i></button></span>
      ${String(isScheduling && !isGantt ? `<span class="r-schedule-view-group target"><span class="r-schedule-view-label">Schedule</span>${targetButton('production', escapeHtml(terminology('scheduling.production_view', 'Production')))}${targetButton('sales', escapeHtml(terminology('scheduling.sales_view', 'Sales')))}</span>` : '')}
      ${String(isGantt ? `<span class="r-schedule-view-group"><button type="button" class="r-schedule-view-btn" data-gantt-add-group><i class="fas fa-layer-group"></i> New Group</button></span>` : `<span class="r-schedule-view-group ${isScheduling ? 'scheduling' : ''}"><span class="r-schedule-view-label">${isScheduling ? escapeHtml(routingLabel) : 'Calendar'}</span>${modes.map(button).join('')}</span>`)}
    </div>`;
  }

  function bindScheduleViewSwitch(rootEl){
    rootEl.querySelectorAll('[data-schedule-anchor-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = Number(btn.dataset.scheduleAnchorNav || 0);
        const next = delta === 0
          ? new Date()
          : (scheduleViewMode === 'month'
            ? scheduleMonthShift(scheduleAnchorDate, delta)
            : scheduleAddDays(scheduleAnchorDate, delta * (['week', 'scheduling-week', 'gantt'].includes(scheduleViewMode) ? 7 : (scheduleViewMode === '4day' ? 4 : 1))));
        setScheduleAnchorDate(next);
      });
    });
    rootEl.querySelectorAll('[data-schedule-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.scheduleTarget || 'production';
        if (next === scheduleSchedulingTarget) return;
        scheduleSchedulingTarget = next;
        if (next === 'sales') {
          workScheduleModeActive = false;
          activeWorkScheduleDraftId = '';
        } else {
          scheduleViewMode = 'scheduling-week';
          scheduleModeActive = false;
          scheduleDraft = null;
          scheduleSelectedEventId = '';
          scheduleAssignmentEventId = '';
        }
        window.Portal?.navigation?.push?.({ projectScheduleTarget:scheduleSchedulingTarget, projectScheduleView:scheduleViewMode }, { source:'project-schedule-target', ownedKeys:['projectScheduleTarget','projectScheduleView'] });
        renderSchedulePanel();
      });
    });
    rootEl.querySelectorAll('[data-schedule-surface]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.scheduleSurface || 'calendar';
        const isScheduling = scheduleIsSchedulingView();
        if (next === 'gantt' ? scheduleViewMode === 'gantt' : ((next === 'scheduling') === isScheduling && scheduleViewMode !== 'gantt')) return;
        if (next === 'gantt') {
          scheduleViewMode = 'gantt';
          scheduleModeActive = false;
          scheduleDraft = null;
          scheduleSelectedEventId = '';
          scheduleAssignmentEventId = '';
          workScheduleModeActive = false;
          activeWorkScheduleDraftId = '';
        } else if (next === 'scheduling') {
          scheduleViewMode = 'scheduling-week';
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
        window.Portal?.navigation?.push?.({ projectScheduleView:scheduleViewMode, projectScheduleTarget:scheduleSchedulingTarget }, { source:'project-schedule-surface', ownedKeys:['projectScheduleView'] });
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
        } else if (scheduleModeActive && ['day','4day','week'].includes(next)) {
          // A single-person appointment can be placed in the simple calendar week/day view.
        } else {
          scheduleModeActive = false;
          scheduleDraft = null;
          scheduleSelectedEventId = '';
          scheduleAssignmentEventId = '';
        }
        window.Portal?.navigation?.push?.({ projectScheduleView:scheduleViewMode }, { source:'project-schedule-view', ownedKeys:['projectScheduleView'] });
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

  function scheduleDateFromRoute(value){
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isFinite(date.getTime()) && scheduleLocalDate(date) === match[0] ? date : null;
  }

  function setScheduleAnchorDate(value, { syncRoute = true } = {}){
    const next = new Date(value || Date.now());
    if (!Number.isFinite(next.getTime())) return;
    next.setHours(0, 0, 0, 0);
    scheduleAnchorDate = next;
    if (syncRoute && !window.Portal?.navigation?.applying) {
      window.Portal?.navigation?.replace?.({ projectScheduleDate:scheduleLocalDate(next) }, { source:'project-schedule-date', ownedKeys:['projectScheduleDate'] });
    }
    renderSchedulePanel();
  }

  function animateProjectMobileCalendarSwipe(delta){
    if (window.matchMedia?.('(max-width:720px)').matches !== true) return;
    projectMobileCalendarSwipeDirection = delta > 0 ? 'next' : 'prev';
    if (projectMobileCalendarSwipeTimer) window.clearTimeout(projectMobileCalendarSwipeTimer);
    projectMobileCalendarSwipeTimer = window.setTimeout(() => {
      projectMobileCalendarSwipeDirection = '';
      projectMobileCalendarSwipeTimer = null;
      renderSchedulePanel();
    }, 260);
  }

  function renderProjectScheduleView(target, eventType = {}, config = {}){
    if (!target) return;
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling || !window.PlatformScheduleView?.renderProjectRangeScheduler) {
      target.innerHTML = `<div class="r-schedule-empty"><i class="fas fa-calendar"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_1d683425be9eb5","Calendar tools are unavailable.") ?? "Calendar tools are unavailable.")}</div>`;
      return;
    }
    const mobileLayout = window.matchMedia?.('(max-width:720px)').matches === true;
    const project = activeBaseProject || {};
    const eventTitle = projectScheduleTitle();
    const events = projectScheduleEvents().map((event) => ({
      ...event,
      project_id: event.project_id || project.id || '',
      project_title: event.project_title || project.title || project.name || project.customer_name || eventTitle,
      project_address: event.project_address || project.address || '',
      title: event.title || event.event_title || eventTitle
    }));
    window.PlatformScheduleView.renderProjectRangeScheduler(target, {
      Scheduling,
      config,
      project,
      events,
      mode: ['day','4day','week','month'].includes(scheduleViewMode) ? scheduleViewMode : 'month',
      modes: ['day','4day','week','month'],
      showModeSwitch: false,
      showToolbar: false,
      readOnly: true,
      mobileLayout,
      shortRangeDayCount: mobileLayout ? 3 : 4,
      touchHoldToPlace: mobileLayout,
      touchHoldDelayMs: 360,
      slotMinutes: Number(eventType.slot_minutes || config?.availability?.sales_appointment_slot_minutes || 30),
      renderSlotMinutes: 60,
      workStartMinute: 0,
      workEndMinute: 24 * 60,
      initialScrollMinute: 8 * 60,
      date: scheduleAnchorDate,
      onNavigate(nextDate, delta, meta = {}){
        scheduleAnchorDate = nextDate;
        if (meta.source === 'swipe') animateProjectMobileCalendarSwipe(delta);
        renderSchedulePanel();
      }
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
    const title = contact?.name || project?.customer_name || event.customer_name || event.project_title || event.title || (globalThis.PlatformLanguage?.text("project-schedule","m_5a654ad9b6d2e3","Appointment") ?? "Appointment");
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
    return `<div class="r-cal-appointment draft has-confirm" style="--span:${String(span)}"><div class="r-cal-appt-top"><span>${String(escapeHtml(title))}</span><span>${String(escapeHtml(time))}</span></div><div class="r-cal-appt-address">${String(escapeHtml(address))}</div><span class="r-cal-draft-confirm" data-schedule-draft-confirm role="button" aria-label="${(globalThis.PlatformLanguage?.text("project-schedule","m_3eb4bd5c2b685c","Confirm appointment") ?? "Confirm appointment")}"><i class="fas fa-check"></i></span></div>`;
  }

  function setScheduleDraft(start, user, extra = {}){
    const durationMinutes = Math.max(1, Number(extra.duration_minutes || extra.durationMinutes || 60));
    scheduleDraft = {
      ...(scheduleDraft || {}),
      ...(extra || {}),
      start: start.toISOString(),
      end: extra.end ? new Date(extra.end).toISOString() : new Date(start.getTime() + durationMinutes * 60000).toISOString(),
      duration_minutes: durationMinutes,
      user: user?.id ? {
        ...user,
        id:user.id,
        name:user.name || user.email || user.id,
        email:user.email || '',
        subject_type:user.subject_type || user.resource_kind || 'organization_user',
        resource_kind:user.resource_kind || user.subject_type || 'organization_user',
        roles:user.roles || user.role_ids || ['sales_appointments'],
        role_ids:user.role_ids || user.roles || []
      } : null,
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
        return `<div class="r-cal-travel" data-travel-key="${String(escapeHtml(key))}" data-origin="${String(escapeHtml(origin))}" data-destination="${String(escapeHtml(destination))}"><i class="far fa-clock"></i>${((v3) => globalThis.PlatformLanguage?.text("project-schedule","m_805a0136c68cf7",`&nbsp;${v3}`,{v3}) ?? `&nbsp;${v3}`)(escapeHtml(label))}</div>`;
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
      ? `<strong>${(globalThis.PlatformLanguage?.text("project-schedule","m_22e746d02726ea","Scheduling appointment") ?? "Scheduling appointment")}</strong>${String(escapeHtml(scheduleDraft.label))}${String(scheduleDraft.userLabel ? ` with ${escapeHtml(scheduleDraft.userLabel)}` : ' - assign later')}.`
      : `<strong>${(globalThis.PlatformLanguage?.text("project-schedule","m_a0fb70645df93b","Schedule appointment") ?? "Schedule appointment")}</strong>Use the Schedule tab to choose an appointment time for this project.`;
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
      work_resource_ref:event.work_resource_ref || null,
      assigned_resource_kind:event.assigned_resource_kind || '',
      assigned_resource_id:event.assigned_resource_id || '',
      assigned_resource_name:event.assigned_resource_name || '',
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

  function beginScheduleEventSave(eventId = ''){
    const id = String(eventId || '');
    const version = (scheduleEventSaveVersions.get(id) || 0) + 1;
    scheduleEventSaveVersions.set(id, version);
    return version;
  }

  function queueScheduleEventSave(eventId = '', save){
    const id = String(eventId || '');
    const previous = scheduleEventSaveQueues.get(id) || Promise.resolve();
    const queued = previous.catch(() => null).then(save);
    scheduleEventSaveQueues.set(id, queued);
    queued.finally(() => {
      if (scheduleEventSaveQueues.get(id) === queued) scheduleEventSaveQueues.delete(id);
    }).catch(() => null);
    return queued;
  }

  async function saveProjectEventQuiet(event, { successTitle = 'Schedule updated', successMessage = 'The schedule was saved.', failureTitle = 'Scheduling failed', broadcast = true, preserveLocalEvents = false, mutationVersion = 0 } = {}){
    const Scheduling = window.PlatformScheduling;
    const orgId = scheduleOrgId();
    const project = await ensureRemoteSchedulingProject();
    if (!Scheduling || !orgId || !project?.id || !event?.id) return;
    try {
      const config = scheduleCachedConfig || await Scheduling.loadBranchConfig(orgId, scheduleBranchId());
      const saved = await queueScheduleEventSave(event.id, () => Scheduling.saveProjectEvent(orgId, project, event, config));
      const isCurrentMutation = !mutationVersion || scheduleEventSaveVersions.get(String(event.id || '')) === mutationVersion;
      if (isCurrentMutation && preserveLocalEvents) {
        const { events:ignoredEvents, ...savedProjectFields } = saved.project || {};
        activeBaseProject = { ...activeBaseProject, ...savedProjectFields };
        upsertLocalProjectEvent({ ...event, ...(saved.event || {}) });
      } else if (isCurrentMutation) {
        activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project.events || activeBaseProject?.events || [] };
        persistActiveBaseProject();
        rememberScheduleProject(activeBaseProject);
      }
      if (broadcast && isCurrentMutation) {
        window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
        window.dispatchEvent(new CustomEvent('fm:projects:refresh'));
      }
      if (successTitle && isCurrentMutation) showToast(successTitle, successMessage, true);
      return saved;
    } catch (error) {
      if (!mutationVersion || scheduleEventSaveVersions.get(String(event.id || '')) === mutationVersion) {
        showToast(failureTitle, error?.message || 'Could not save this schedule change.', false);
      }
      return null;
    }
  }

  function commitSalesAppointmentRange(event, range, user = null, durationMinutes = 60){
    if (!event?.id || !range?.start) return;
    const start = new Date(range.start);
    const rangeEnd = range.end ? new Date(range.end) : null;
    const end = rangeEnd && rangeEnd > start ? rangeEnd : new Date(start.getTime() + Math.max(1, Number(durationMinutes) || 60) * 60000);
    const assignment = crewPayloadForSelection(user?.id || '', cachedSalesAppointmentUsers());
    const next = {
      ...event,
      schedule_history: [...(Array.isArray(event.schedule_history) ? event.schedule_history : []), scheduleHistoryEntry(event, 'rescheduled')].filter(Boolean),
      start_at: start.toISOString(),
      start: start.toISOString(),
      end_at: end.toISOString(),
      end: end.toISOString(),
      duration_minutes: Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000)),
      ...assignment,
      updated_at: new Date().toISOString()
    };
    const mutationVersion = beginScheduleEventSave(next.id);
    upsertLocalProjectEvent(next);
    scheduleDraft = null;
    scheduleSelectedEventId = '';
    scheduleAssignmentEventId = '';
    scheduleModeActive = false;
    updateScheduleChoiceCard();
    renderScheduleLeft();
    saveProjectEventQuiet(next, {
      successTitle: 'Appointment updated',
      successMessage: `${next.title || (globalThis.PlatformLanguage?.text("project-schedule","m_5a654ad9b6d2e3","Appointment") ?? "Appointment")} was saved.`,
      broadcast: false,
      preserveLocalEvents: true,
      mutationVersion
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
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_9cae930e9e6682","Scheduling unavailable") ?? "Scheduling unavailable"), (globalThis.PlatformLanguage?.text("project-schedule","m_8ef78f050c490a","Could not save this appointment.") ?? "Could not save this appointment."), false);
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
      const assignment = crewPayloadForSelection(user?.id || '', scheduleAssignableSubjects(eventTypeId, '', config));
      const event = existing
        ? {
            ...existing,
            schedule_history: [...(Array.isArray(existing.schedule_history) ? existing.schedule_history : []), scheduleHistoryEntry(existing, 'rescheduled')].filter(Boolean),
            start_at: start.toISOString(),
            start: start.toISOString(),
            duration_minutes: duration,
            ...assignment,
            updated_at: new Date().toISOString()
          }
        : Scheduling.createProjectEvent(project, eventTypeId, {
            start,
            durationMinutes: duration,
            assignedUserIds:assignment.assigned_user_ids,
            assignedUsers:assignment.assigned_users,
            ...assignment,
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
      showToast(existing ? 'Appointment updated' : 'Appointment scheduled', ((v0) => globalThis.PlatformLanguage?.text("project-schedule","m_b8e410fbacfc29",`${v0} was saved.`,{v0}) ?? `${v0} was saved.`)(event.title || 'Appointment'), true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), error?.message || 'Could not save the appointment.', false);
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
        ...crewPayloadForSelection('', cachedSalesAppointmentUsers()),
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
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_b98fb3c2854487","Appointment unassigned") ?? "Appointment unassigned"), (globalThis.PlatformLanguage?.text("project-schedule","m_ee4bec4f7f67c8","The appointment can be assigned again.") ?? "The appointment can be assigned again."), true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_915800930cfd7e","Unassign failed") ?? "Unassign failed"), error?.message || 'Could not unassign this appointment.', false);
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
    return String($('#rWorkDraftTitle')?.value || activeWorkDraft()?.title || '').trim() || 'Work';
  }

  function startNewWorkSchedule(){
    materialScheduleModeActive = false;
    materialScheduleDraft = null;
    const id = newWorkDraftId();
    workScheduleDrafts.set(id, { id, title: (globalThis.PlatformLanguage?.text("project-schedule","m_222066ef57ae0e","Work") ?? "Work") });
    setActiveWorkDraftId(id);
    scheduleModeActive = false;
    scheduleSchedulingTarget = 'production';
    scheduleAssignmentEventId = '';
    scheduleSelectedEventId = '';
    workScheduleViewMode = 'month';
    scheduleAnchorDate = new Date();
    scheduleViewMode = 'week';
    renderSchedulePanel();
  }

  function openCrewSettings(){
    if (!workforceManagementEnabled()) return;
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
    const candidates = scheduleWorkResources(scheduleCachedConfig, scheduleCachedUsers, next.scope_template_id || previous.scope_template_id);
    const nextRef = has(next, 'work_resource_ref') ? next.work_resource_ref : undefined;
    const nextUserIds = firstExplicit([next, 'assigned_user_ids']);
    const nextUserId = firstExplicit([next, 'assigned_user_id']);
    const nextResourceId = nextRef !== undefined ? nextRef?.id : firstExplicit([next, 'assigned_resource_id'], [next, 'resource_id'], [next, 'assigned_crew_id'], [next, 'crew_id']);
    const assignmentWasExplicit = nextRef !== undefined
      || nextResourceId !== undefined
      || nextUserIds !== undefined
      || nextUserId !== undefined
      || has(next, 'assigned_users')
      || has(next, 'assigned_crew');
    const explicitUserId = Array.isArray(nextUserIds) ? nextUserIds.find(Boolean) : nextUserId;
    const explicitSubjectId = String(explicitUserId || nextResourceId || '').trim();
    const assignment = assignmentWasExplicit
      ? crewPayloadForSelection(explicitSubjectId, candidates)
      : workCrewCalendarPayload(previous, candidates);
    workScheduleDrafts.set(id, {
      ...previous,
      ...next,
      id,
      event_id: next.event_id || previous.event_id || (projectWorkEvents().some((event) => String(event.id || '') === id) ? id : ''),
      title: next.title || previous.title || (globalThis.PlatformLanguage?.text("project-schedule","m_222066ef57ae0e","Work") ?? "Work"),
      start: new Date(next.start).toISOString(),
      end: new Date(next.end).toISOString(),
      all_day: next.all_day !== false,
      schedule_granularity: next.schedule_granularity || (next.all_day === false ? 'time' : 'date'),
      ...assignment
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
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_15fa17332ed5c6","Work schedule unavailable") ?? "Work schedule unavailable"), (globalThis.PlatformLanguage?.text("project-schedule","m_9eaf6c129707cd","Choose a work start and end before confirming.") ?? "Choose a work start and end before confirming."), false);
      return;
    }
    try {
      const config = await Scheduling.loadBranchConfig(orgId, scheduleBranchId());
      scheduleCachedConfig = config;
      await loadWorkforceResources();
      const start = new Date(workScheduleDraft.start);
      const end = new Date(workScheduleDraft.end);
      const existingId = workScheduleDraft.event_id || workScheduleDraft.id || '';
      const existing = existingId ? scheduleProjectEvents().find((event) => String(event.id || '') === String(existingId)) : null;
      const subjects = scheduleWorkResources(config, scheduleCachedUsers, workScheduleDraft.scope_template_id);
      const assignment = workCrewCalendarPayload(workScheduleDraft, subjects);
      const assignedCrewId = assignment.assigned_crew_id || '';
      const assignedCrewName = assignment.assigned_crew_name || '';
      const assignedCrew = assignment.assigned_crew || null;
      const workResourceRef = assignment.work_resource_ref || null;
      const base = existing
        ? Scheduling.updateProjectEventRange(existing, {
            start,
            end,
            all_day: workScheduleDraft.all_day,
            schedule_granularity: workScheduleDraft.schedule_granularity,
            ...assignment,
            assigned_crew_id: assignedCrewId,
            assigned_crew_name: assignedCrewName,
            assigned_crew: assignedCrew,
            work_resource_ref: workResourceRef,
            assigned_resource_kind: workResourceRef?.kind || '',
            assigned_resource_id:workResourceRef?.id || '',
            assigned_resource_name:workResourceRef?.name || ''
          })
        : Scheduling.createProjectWorkEvent(project, {
            title: workDraftTitle(),
            start,
            end,
            all_day: workScheduleDraft.all_day,
            schedule_granularity: workScheduleDraft.schedule_granularity,
            ...assignment,
            assigned_crew_id: assignedCrewId,
            assigned_crew_name: assignedCrewName,
            assigned_crew: assignedCrew,
            work_resource_ref: workResourceRef,
            assigned_resource_kind: workResourceRef?.kind || '',
            assigned_resource_id:workResourceRef?.id || '',
            assigned_resource_name:workResourceRef?.name || '',
          }, config);
      const event = {
        ...base,
        title: workDraftTitle(),
        kind: 'project_work',
        schedule_item_kind: 'production',
        resource_type: '',
        scope_resource_list_id: '',
        locked: false,
        schedule_locked: false,
        lock_toggle_visible: false,
        confirmation_required: false,
        start_date: workScheduleDraft.all_day !== false ? scheduleLocalDate(start) : '',
        end_date: workScheduleDraft.all_day !== false ? scheduleLocalDate(scheduleAddDays(end, -1)) : '',
        ...assignment,
        assigned_crew_id: assignedCrewId,
        assigned_crew_name: assignedCrewName,
        assigned_crew: assignedCrew,
        work_resource_ref: workResourceRef,
        assigned_resource_kind: workResourceRef?.kind || '',
        assigned_resource_id:workResourceRef?.id || '',
        assigned_resource_name:workResourceRef?.name || '',
        metadata: { ...(base.metadata || {}), ad_hoc_production: true },
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
      showToast(existing ? 'Work schedule updated' : 'Work scheduled', ((v0) => globalThis.PlatformLanguage?.text("project-schedule","m_b8e410fbacfc29",`${v0} was saved.`,{v0}) ?? `${v0} was saved.`)(event.title || 'Work'), true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_f1b40620f12653","Work scheduling failed") ?? "Work scheduling failed"), error?.message || 'Could not save this work.', false);
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
    if (!appointments.length) return `<div class="r-schedule-empty-small">${(globalThis.PlatformLanguage?.text("project-schedule","m_3f4558f856c78e","No sales appointments scheduled.") ?? "No sales appointments scheduled.")}</div>`;
    return `<div class="r-schedule-tile-list">${appointments.map((event) => `
      <div class="r-schedule-tile">
        <div class="r-schedule-tile-title">${escapeHtml(event.title || (globalThis.PlatformLanguage?.text("project-schedule","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment"))}</div>
        <div class="r-schedule-tile-meta">${escapeHtml(formatEventTime(event))}</div>
        <div class="r-schedule-tile-meta">${escapeHtml(eventAssignedLabel(event))}</div>
      </div>
    `).join('')}</div>`;
  }

  function workTilesHtml(){
    const events = projectWorkEvents().filter((event) => !isScopeResourceEvent(event));
    return events.map((event) => `
      <button type="button" class="r-schedule-tile" data-edit-work="${escapeHtml(event.id || '')}">
        <div class="r-schedule-tile-title"><i class="fas fa-hammer"></i>${escapeHtml(event.title || (globalThis.PlatformLanguage?.text("project-schedule","m_c2e6380e130020","Production") ?? "Production"))}</div>
        <div class="r-schedule-tile-meta">${escapeHtml(workRangeLabel(event))}</div>
      </button>
    `).join('');
  }

  function materialListIdentityColor(event = {}){
    const color = String(event.material_list_color || event.accent_color || event.sub_color || '').trim();
    return /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#64748b';
  }

  function materialDeliveryTitle(event = {}){
    const list = event.material_list && typeof event.material_list === 'object' ? event.material_list : {};
    const title = String(event.material_list_title || event.material_list_name || list.title || list.name || event.title || '').trim();
    return title.replace(/\s+delivery$/i, '').trim() || 'Materials';
  }

  function productionCrewSelectHtml(event = {}){
    if (productionResourceType(event) !== 'labor') return '';
    const draft = workScheduleDrafts.get(String(event.id || '')) || null;
    const assignmentSource = draft ? { ...event, ...draft } : event;
    const resources = workAssignmentResources(assignmentSource);
    const selectedId = workCrewId(assignmentSource);
    const selectedResource = resources.find((resource) => String(resource.id || '') === selectedId) || null;
    const selectedName = selectedResource?.name || workCrewName(assignmentSource) || 'Unassigned';
    return `<div class="r-production-resource-assignment"><span>${escapeHtml(workforceTerm('resource_group'))}</span><button type="button" class="r-production-resource-crew-button ${selectedId ? '' : 'unassigned'}" data-production-resource-crew="${escapeHtml(event.id || '')}" aria-haspopup="listbox" aria-expanded="false"><span>${escapeHtml(selectedName)}</span><i class="fas fa-chevron-down"></i></button></div>`;
  }

  function productionResourceTilesHtml(){
    const events = projectMaterialEvents()
      .filter((event) => !equipmentEventHidden(event))
      .filter((event) => !['cancelled', 'canceled'].includes(String(event.status || '').toLowerCase()));
    return events.map((event) => {
      const type = productionResourceType(event);
      const material = type === 'material';
      const ordered = material && materialEventIsOrdered(event);
      const scheduled = materialEventIsScheduled(event);
      const active = String(event.id || '') === String(materialScheduleEventId || '');
      const complete = scheduled && (!material || ordered);
      const stateLabel = material
        ? (ordered ? (materialEventIsLocked(event) ? 'Ordered and locked' : (scheduled ? 'Scheduled and ordered' : 'Ordered · Not scheduled')) : (scheduled ? 'Scheduled · Not ordered' : 'Waiting to be scheduled'))
        : (scheduled ? 'Scheduled' : 'Waiting to be scheduled');
      const assignment = productionCrewSelectHtml(event);
      return `<div class="r-schedule-tile r-material-tile r-production-resource-tile ${assignment ? '' : 'no-assignment'} ${complete ? 'complete' : 'incomplete'} ${active ? 'active' : ''}" style="--material-list-color:${escapeHtml(materialListIdentityColor(event))}">
        <button type="button" class="r-production-resource-main" data-production-resource-event="${escapeHtml(event.id || '')}">
          <div class="r-schedule-tile-title"><i class="fas ${escapeHtml(productionResourceIcon(event))}"></i>${material ? (String(escapeHtml(materialDeliveryTitle(event))) + "<span class=\"r-schedule-tile-kind\">" + (globalThis.PlatformLanguage?.text("project-schedule","m_6450c5cf07510a"," — delivery") ?? " — delivery") + "</span>") : escapeHtml(event.title || productionResourceLabel(event))}</div>
          <div class="r-schedule-tile-meta">${escapeHtml(stateLabel)}</div>
        </button>
        ${assignment}
      </div>`;
    }).join('');
  }

  function productionTilesHtml(){
    const tiles = productionResourceTilesHtml();
    return tiles ? `<div class="r-schedule-tile-list">${tiles}</div>` : `<div class="r-schedule-empty-small">${(globalThis.PlatformLanguage?.text("project-schedule","m_eb671826d74670","No production items for this project.") ?? "No production items for this project.")}</div>`;
  }

  function workDraftCardHtml(){
    const workScheduleDraft = activeWorkDraft();
    if (!workScheduleDraft?.start || !workScheduleDraft?.end) {
      return `<div class="r-schedule-empty-small">${(globalThis.PlatformLanguage?.text("project-schedule","m_5f010df5b92a9b","Click or drag on the calendar to place work.") ?? "Click or drag on the calendar to place work.")}</div>`;
    }
    const assignment = workAssignmentSelectHtml(workScheduleDraft);
    return `<div class="r-work-draft-card">
      <div class="r-work-title-row ${String(assignment ? '' : 'no-assignment')}">
        <label>${(globalThis.PlatformLanguage?.text("project-schedule","m_29dbd3d8b69f55","Title") ?? "Title")}<input id="rWorkDraftTitle" type="text" value="${String(escapeHtml(workScheduleDraft.title || 'Work'))}"></label>
        ${String(assignment)}
      </div>
      <div class="r-schedule-tile-meta">${String(escapeHtml(workRangeLabel({
        ...workScheduleDraft,
        __start: new Date(workScheduleDraft.start),
        __end: new Date(workScheduleDraft.end)
      })))}</div>
      <div class="r-work-confirm-row">
        <button type="button" class="r-schedule-mini-action" data-work-cancel>${(globalThis.PlatformLanguage?.text("project-schedule","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
        <button type="button" class="r-schedule-mini-action primary" data-work-confirm><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_4b699ce463481b"," Confirm") ?? " Confirm")}</button>
      </div>
    </div>`;
  }

  function updateVisibleWorkAssignment(workId, payload = {}){
    const id = String(workId || '');
    if (!id) return;
    document.querySelectorAll(`.prs-work-chip[data-prs-event-id="${cssEscape(id)}"]`).forEach((chip) => {
      chip.classList.toggle('awaiting-crew', payload.awaiting_crew === true);
      let crew = chip.querySelector('.prs-crew');
      const label = payload.work_resource_ref?.name || payload.resource_name || payload.assigned_crew_name || payload.crew_name || payload.crew_label || 'Unassigned';
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
          <label id="rProposalLabel">${(globalThis.PlatformLanguage?.text("project-schedule","m_fc05a804bd034c","Schedule") ?? "Schedule")}</label>
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
    const tab = String(state.host?.getActivePreviewTab?.() || state.context?.activeTab || '');
    const keepSharedRail = tab === 'proposal' || tab === 'materials' || tab === 'money';
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
    if (materialScheduleModeActive) {
      const event = selectedMaterialEvent();
      const selected = materialScheduleDraft?.start;
      const material = productionResourceType(event || {}) === 'material';
      return `<div class="r-schedule-left-status"><strong>${escapeHtml(event?.title || productionResourceLabel(event || {}))}</strong>${selected ? 'Review the date on the calendar and confirm this production item.' : (materialEventIsScheduled(event || {}) ? `Drag it to reschedule${material ? ', or use its lock control' : ''}.` : 'Choose a date on the calendar.')}</div>`;
    }
    if (scheduleModeActive) {
      const assignment = salesAssignmentSelectHtml();
      return `<section class="r-schedule-section">
        <div class="r-schedule-section-head">
          <div class="r-schedule-section-title"><i class="fas fa-calendar-check"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_da2084e4486b76"," Sales Appointment") ?? " Sales Appointment")}</div>
          ${String(assignment)}
        </div>
        <div class="r-schedule-left-status"><strong>${String(scheduleDraft?.start ? escapeHtml(scheduleDraft.label || 'Appointment selected') : 'Scheduling appointment')}</strong>${String(scheduleDraft?.start ? 'Place, adjust, or confirm this appointment on the calendar.' : 'Choose an available appointment slot on the calendar.')}</div>
      </section>`;
    }
    return '';
  }

  function recurrenceLabel(series = {}){
    const recurrence = series.recurrence || {};
    const every = Math.max(1, Number(recurrence.interval || 1));
    const frequency = String(recurrence.frequency || 'monthly').replace(/_/g, ' ');
    return `Every ${every === 1 ? '' : `${every} `}${frequency}${recurrence.end_at ? ` until ${new Date(recurrence.end_at).toLocaleDateString(globalThis.PlatformLanguage?.formatLocale?.())}` : ' · ongoing'}`;
  }

  function recurringTilesHtml(){
    if (scheduleRecurrenceLoading && !scheduleRecurringSeries.length) return `<div class="r-schedule-empty-small">${(globalThis.PlatformLanguage?.text("project-schedule","m_0d5c49d331e456","Loading recurring items…") ?? "Loading recurring items…")}</div>`;
    if (!scheduleRecurringSeries.length) return `<div class="r-schedule-empty-small">${(globalThis.PlatformLanguage?.text("project-schedule","m_0763a6948a13e2","No recurring items yet.") ?? "No recurring items yet.")}</div>`;
    return `<div class="r-schedule-tile-list">${scheduleRecurringSeries.map((series) => `
      <button type="button" class="r-schedule-tile r-recurrence-tile ${String(series.status || '') === 'cancelled' ? 'cancelled' : ''}" data-edit-recurrence="${escapeHtml(series.id || '')}">
        <div class="r-recurrence-meta"><div class="r-schedule-tile-title"><i class="fas fa-repeat"></i>${escapeHtml(series.title || (globalThis.PlatformLanguage?.text("project-schedule","m_e5d043f205f6a6","Recurring item") ?? "Recurring item"))}</div><span class="r-recurrence-pill ${String(series.status || '') === 'cancelled' ? 'cancelled' : ''}">${escapeHtml(series.status || 'active')}</span></div>
        <div class="r-schedule-tile-meta">${escapeHtml(recurrenceLabel(series))}</div>
      </button>`).join('')}</div>`;
  }

  async function loadRecurringSeries({ refresh = false } = {}){
    const project = ensureSchedulingProject();
    const client = window.PlatformAPI?.projects;
    if (!project?.id || !scheduleOrgId() || typeof client?.recurrenceSeries !== 'function' || scheduleRecurrenceLoading) return scheduleRecurringSeries;
    if (scheduleRecurrenceProjectId !== String(project.id)) {
      scheduleRecurrenceProjectId = String(project.id);
      scheduleRecurringSeries = [];
      scheduleRecurrenceLoaded = false;
    }
    if (scheduleRecurrenceLoaded && !refresh) return scheduleRecurringSeries;
    scheduleRecurrenceLoading = true;
    try {
      const result = await client.recurrenceSeries(scheduleOrgId(), { project_id: project.id, include_cancelled: true });
      scheduleRecurringSeries = Array.isArray(result?.series) ? result.series : [];
      scheduleRecurrenceLoaded = true;
    } catch (error) {
      console.warn('Could not load recurring schedule items.', error);
    } finally {
      scheduleRecurrenceLoaded = true;
      scheduleRecurrenceLoading = false;
    }
    return scheduleRecurringSeries;
  }

  function datetimeLocal(value){
    const date = new Date(value || Date.now());
    if (!Number.isFinite(date.getTime())) return '';
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }

  function openRecurrenceDialog(series = null){
    const existing = series || {};
    const recurrence = existing.recurrence || {};
    const event = existing.event_template || {};
    const billing = existing.billing || {};
    const expenses = existing.expenses || {};
    const selectedEventTypeId = String(event.event_type_default_id || 'project_work');
    const crews = scheduleAssignableSubjects(selectedEventTypeId, existing.scope_template_id || '');
    const selectedCrew = workCrewId(event);
    const modal = document.createElement('div');
    modal.className = 'r-recurrence-modal';
    modal.innerHTML = `<div class="r-recurrence-dialog" role="dialog" aria-modal="true">
      <div class="r-recurrence-head"><strong>${String(existing.id ? 'Edit recurring item' : 'New recurring item')}</strong><button type="button" class="r-schedule-mini-action" data-recurrence-close><i class="fas fa-xmark"></i></button></div>
      <form class="r-recurrence-form">
        <label class="wide">${(globalThis.PlatformLanguage?.text("project-schedule","m_29dbd3d8b69f55","Title") ?? "Title")}<input name="title" required value="${String(escapeHtml(existing.title || ''))}" placeholder="${(globalThis.PlatformLanguage?.text("project-schedule","m_2e62e58b504501","Monthly maintenance") ?? "Monthly maintenance")}"></label>
        <label>${(globalThis.PlatformLanguage?.text("project-schedule","m_8554cf3361046a","First appointment") ?? "First appointment")}<input name="start_at" type="datetime-local" required value="${String(escapeHtml(datetimeLocal(existing.start_at)))}"></label>
        <label>${(globalThis.PlatformLanguage?.text("project-schedule","m_f22e688833733c","Appointment type") ?? "Appointment type")}<select name="event_type"><option value="project_work" ${String(String(event.event_type_default_id || '') === 'project_work' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("project-schedule","m_ff54ed216fbe2f","Production / work") ?? "Production / work")}</option><option value="sales_appointment" ${String(String(event.event_type_default_id || '') === 'sales_appointment' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("project-schedule","m_f7eaf8f28f8161","Sales appointment") ?? "Sales appointment")}</option><option value="delivery" ${String(String(event.event_type_default_id || '') === 'delivery' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.text("project-schedule","m_b73185deef6d79","Delivery") ?? "Delivery")}</option><option value="custom">${(globalThis.PlatformLanguage?.text("project-schedule","m_6edcf7d7d41112","Custom") ?? "Custom")}</option></select></label>
        <label>${(globalThis.PlatformLanguage?.text("project-schedule","m_ff7bb68b2b05a8","Frequency") ?? "Frequency")}<select name="frequency">${String(['daily','weekly','monthly','quarterly','yearly'].map((value) => `<option value="${value}" ${String(recurrence.frequency || 'monthly') === value ? 'selected' : ''}>${value[0].toUpperCase() + value.slice(1)}</option>`).join(''))}</select></label>
        <label>${(globalThis.PlatformLanguage?.text("project-schedule","m_b25bba33f32e79","Every") ?? "Every")}<input name="interval" type="number" min="1" max="120" value="${String(escapeHtml(recurrence.interval || 1))}"></label>
        <label>${(globalThis.PlatformLanguage?.text("project-schedule","m_96601ab236e446","Duration (minutes)") ?? "Duration (minutes)")}<input name="duration" type="number" min="1" value="${String(escapeHtml(event.duration_minutes || 60))}"></label>
        <label>${(globalThis.PlatformLanguage?.text("project-schedule","m_38f8ab5bb6ef24","Ends on (optional)") ?? "Ends on (optional)")}<input name="end_at" type="date" value="${String(escapeHtml(String(recurrence.end_at || '').slice(0, 10)))}"></label>
        <label>${(globalThis.PlatformLanguage?.text("project-schedule","m_efdb53da64e1aa","Scope template (optional)") ?? "Scope template (optional)")}<input name="scope_template_id" value="${String(escapeHtml(existing.scope_template_id || ''))}" placeholder="${(globalThis.PlatformLanguage?.text("project-schedule","m_513ee206ccb8da","maintenance") ?? "maintenance")}"></label>
        <label>${(globalThis.PlatformLanguage?.text("project-schedule","m_711ce0290d78f6","Scope piece (optional)") ?? "Scope piece (optional)")}<input name="scope_piece_id" value="${String(escapeHtml(existing.scope_piece_id || ''))}" placeholder="${(globalThis.PlatformLanguage?.text("project-schedule","m_83fe1ce05f034b","maintenance_scope") ?? "maintenance_scope")}"></label>
        <label class="wide">${String(escapeHtml(workResourceLabel()))}<select name="crew"><option value="">${(globalThis.PlatformLanguage?.text("project-schedule","m_f63dccd2774d7e","Assign later") ?? "Assign later")}</option>${String(crews.map((crew) => `<option value="${escapeHtml(crew.id)}" ${String(crew.id) === String(selectedCrew) ? 'selected' : ''}>${escapeHtml(crew.name || crew.id)}</option>`).join(''))}</select></label>
        <label class="wide r-recurrence-check"><input name="bill_enabled" type="checkbox" ${String(billing.enabled === true ? 'checked' : '')}>${(globalThis.PlatformLanguage?.text("project-schedule","m_710450cda200a8"," Bill the customer on a separate recurring cadence") ?? " Bill the customer on a separate recurring cadence")}</label>
        <label>${(globalThis.PlatformLanguage?.text("project-schedule","m_a605313561dfab","Billing amount") ?? "Billing amount")}<input name="bill_amount" type="number" min="0" step="0.01" value="${String(escapeHtml(billing.amount_cents ? (Number(billing.amount_cents) / 100).toFixed(2) : ''))}" placeholder="0.00"></label>
        <label>${(globalThis.PlatformLanguage?.text("project-schedule","m_71ac82dafe263e","Billing frequency") ?? "Billing frequency")}<select name="bill_frequency">${String(['monthly','quarterly','yearly'].map((value) => `<option value="${value}" ${String(billing.frequency || recurrence.frequency || 'monthly') === value ? 'selected' : ''}>${value[0].toUpperCase() + value.slice(1)}</option>`).join(''))}</select></label>
        <label class="wide r-recurrence-check"><input name="expense_enabled" type="checkbox" ${String(expenses.enabled === true ? 'checked' : '')}>${(globalThis.PlatformLanguage?.text("project-schedule","m_69b25971120f55"," Track a recurring projected expense") ?? " Track a recurring projected expense")}</label>
        <label>${(globalThis.PlatformLanguage?.text("project-schedule","m_91c9b753132340","Expense per service") ?? "Expense per service")}<input name="expense_amount" type="number" min="0" step="0.01" value="${String(escapeHtml(expenses.amount_cents ? (Number(expenses.amount_cents) / 100).toFixed(2) : ''))}" placeholder="0.00"></label>
        <label>${(globalThis.PlatformLanguage?.text("project-schedule","m_2fa6abb915bd45","Expense type") ?? "Expense type")}<select name="expense_kind"><option value="recurring_expense">${(globalThis.PlatformLanguage?.text("project-schedule","m_4a04382820d2e1","Other") ?? "Other")}</option><option value="labor">${(globalThis.PlatformLanguage?.text("project-schedule","m_7acfa5ed3b7739","Labor") ?? "Labor")}</option><option value="material">${(globalThis.PlatformLanguage?.text("project-schedule","m_613d6b4084975e","Material") ?? "Material")}</option><option value="equipment">${(globalThis.PlatformLanguage?.text("project-schedule","m_2813f320a63b94","Equipment") ?? "Equipment")}</option></select></label>
        <div class="r-recurrence-actions"><div>${String(existing.id ? '<button type="button" class="r-schedule-mini-action" data-recurrence-cancel>Cancel series</button>' : '')}</div><div><button type="button" class="r-schedule-mini-action" data-recurrence-close>${(globalThis.PlatformLanguage?.text("project-schedule","m_3742924668fb10","Close") ?? "Close")}</button><button type="submit" class="r-schedule-mini-action primary">${String(existing.id ? 'Save' : 'Create')}</button></div></div>
      </form>
    </div>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelectorAll('[data-recurrence-close]').forEach((button) => button.addEventListener('click', close));
    modal.querySelector('[name="event_type"]')?.addEventListener('change', (changeEvent) => {
      const select = modal.querySelector('[name="crew"]');
      if (!select) return;
      const candidates = scheduleAssignableSubjects(String(changeEvent.currentTarget.value || 'custom'), modal.querySelector('[name="scope_template_id"]')?.value || '');
      select.innerHTML = `<option value="">${(globalThis.PlatformLanguage?.text("project-schedule","m_f63dccd2774d7e","Assign later") ?? "Assign later")}</option>${String(candidates.map((subject) => `<option value="${escapeHtml(subject.id)}">${escapeHtml(subject.name || subject.id)}</option>`).join(''))}`;
    });
    modal.querySelector('[data-recurrence-cancel]')?.addEventListener('click', async () => {
      if (!confirm((globalThis.PlatformLanguage?.text("project-schedule","m_91303d517f39fa","Cancel this recurring series and its future appointments?") ?? "Cancel this recurring series and its future appointments?"))) return;
      try {
        await window.PlatformAPI.projects.cancelRecurrenceSeries(scheduleOrgId(), existing.id);
        await loadRecurringSeries({ refresh: true });
        close(); renderSchedulePanel(); window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
        showToast((globalThis.PlatformLanguage?.text("project-schedule","m_444d3d72c440e4","Recurring series cancelled") ?? "Recurring series cancelled"), (globalThis.PlatformLanguage?.text("project-schedule","m_d673dcfa6aee57","Future appointments and open future charges were cancelled.") ?? "Future appointments and open future charges were cancelled."), true);
      } catch (error) { showToast((globalThis.PlatformLanguage?.text("project-schedule","m_298cdee921f1fd","Could not cancel recurring series") ?? "Could not cancel recurring series"), error?.message || 'Try again.', false); }
    });
    modal.querySelector('form')?.addEventListener('submit', async (submitEvent) => {
      submitEvent.preventDefault();
      const form = new FormData(submitEvent.currentTarget);
      const amount = Math.round(Number(form.get('bill_amount') || 0) * 100);
      const expenseAmount = Math.round(Number(form.get('expense_amount') || 0) * 100);
      const assignmentCandidates = scheduleAssignableSubjects(String(form.get('event_type') || 'custom'), String(form.get('scope_template_id') || ''));
      const crewPayload = crewPayloadForSelection(form.get('crew'), assignmentCandidates);
      const payload = {
        title: String(form.get('title') || '').trim(), start_at: new Date(String(form.get('start_at'))).toISOString(),
        scope_template_id: String(form.get('scope_template_id') || '').trim(), scope_piece_id: String(form.get('scope_piece_id') || '').trim(),
        recurrence: { frequency: form.get('frequency'), interval: Number(form.get('interval') || 1), end_at: form.get('end_at') ? new Date(`${form.get('end_at')}T23:59:59`).toISOString() : '' },
        event_template: { title: String(form.get('title') || '').trim(), event_type_default_id: form.get('event_type'), duration_minutes: Number(form.get('duration') || 60), schedule_item_kind: form.get('event_type') === 'project_work' ? 'production' : '', ...crewPayload },
        billing: { enabled: form.get('bill_enabled') === 'on' && amount > 0, amount_cents: amount, frequency: form.get('bill_frequency'), label: String(form.get('title') || '').trim() },
        expenses: { enabled: form.get('expense_enabled') === 'on' && expenseAmount > 0, amount_cents: expenseAmount, kind: form.get('expense_kind') }
      };
      try {
        if (existing.id) await window.PlatformAPI.projects.updateRecurrenceSeries(scheduleOrgId(), existing.id, payload);
        else await window.PlatformAPI.projects.createRecurrenceSeries(scheduleOrgId(), { ...payload, project_id: ensureSchedulingProject()?.id });
        scheduleRecurringSeries = [];
        await loadRecurringSeries({ refresh: true });
        close(); renderSchedulePanel(); window.dispatchEvent(new CustomEvent('fm:calendar:refresh')); window.dispatchEvent(new CustomEvent('fm:projects:refresh'));
        showToast(existing.id ? 'Recurring item saved' : 'Recurring item created', (globalThis.PlatformLanguage?.text("project-schedule","m_b3232ffa2c08d8","Future appointments and recurring billing were created.") ?? "Future appointments and recurring billing were created."), true);
      } catch (error) { showToast((globalThis.PlatformLanguage?.text("project-schedule","m_0c17d9fba77f09","Could not save recurring item") ?? "Could not save recurring item"), error?.message || 'Check the details and try again.', false); }
    });
  }

  async function commitWorkScheduleRange(event = {}, range = {}){
    const Scheduling = window.PlatformScheduling;
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(event.id || '')) || event;
    if (!Scheduling?.updateProjectEventRange || !source?.id || !range?.start || !range?.end) return null;
    const rangeResourceId = String(range.resource_id || range.assigned_resource_id || range.assigned_crew_id || range.crew_id || '').trim();
    const rangeResource = scheduleCachedWorkResources.find((resource) => String(resource.id || '') === rangeResourceId) || null;
    const scopeId = String(source.scope_template_id || '').trim();
    const capabilityIds = Array.isArray(rangeResource?.capability_scope_ids) ? rangeResource.capability_scope_ids.map(String) : [];
    if (scopeId && rangeResourceId && capabilityIds.length && !capabilityIds.includes(scopeId)) {
      renderSchedulePanelPreservingScroll();
      showToast(((v0) => globalThis.PlatformLanguage?.text("project-schedule","m_20b9cbe18eee54",`${v0} unavailable`,{v0}) ?? `${v0} unavailable`)(workResourceLabel()), ((v0) => globalThis.PlatformLanguage?.text("project-schedule","m_e3160ab68875db",`That ${v0} is not configured for this scope.`,{v0}) ?? `That ${v0} is not configured for this scope.`)(workResourceLabel()), false);
      return null;
    }
    const assignment = crewPayloadForSelection(rangeResourceId, workAssignmentResources(source));
    const next = {
      ...Scheduling.updateProjectEventRange(source, { ...range, ...assignment }),
      ...assignment,
      schedule_history:[...(Array.isArray(source.schedule_history) ? source.schedule_history : []), scheduleHistoryEntry(source, 'rescheduled')].filter(Boolean),
      status:'scheduled',
      updated_at:new Date().toISOString()
    };
    const mutationVersion = beginScheduleEventSave(next.id);
    upsertLocalProjectEvent(next);
    workScheduleDrafts.delete(String(source.id || ''));
    if (activeWorkScheduleDraftId === String(source.id || '')) setActiveWorkDraftId('');
    renderScheduleLeft();
    const saved = await saveProjectEventQuiet(next, {
      successTitle: 'Production updated',
      successMessage: rangeResourceId ? `${rangeResource?.name || workCrewName(next) || workResourceLabel()} is assigned.` : 'The production item is unassigned.',
      failureTitle: 'Production update failed',
      broadcast: false,
      preserveLocalEvents: true,
      mutationVersion
    });
    return saved;
  }

  function projectPrefersGantt(){
    const Scheduling = window.PlatformScheduling;
    return scheduleProjectEvents().some((event) => (
      Scheduling?.eventIsGroup?.(event)
      || String(event?.parent_event_id || '').trim()
      || (Array.isArray(event?.depends_on) && event.depends_on.length)
      || String(event?.schedule_view_hint || '').trim().toLowerCase() === 'gantt'
    ));
  }
  async function saveProjectGanttRange(event, range, cascade = []){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling || !event?.id || !range?.start) return;
    if (isMaterialDeliveryEvent(event)) {
      if (materialEventIsLocked(event)) {
        showToast((globalThis.PlatformLanguage?.text("project-schedule","m_a1c7a5d9f83613","Delivery locked") ?? "Delivery locked"), (globalThis.PlatformLanguage?.text("project-schedule","m_6bf220dddda83e","Unlock this ordered delivery before moving it.") ?? "Unlock this ordered delivery before moving it."), false);
        renderSchedulePanelPreservingScroll();
        return;
      }
      await saveMaterialScheduleRange(event, { ...range, all_day:true, schedule_granularity:'date' });
    } else {
      await commitWorkScheduleRange(event, range);
    }
    let drafts = (cascade || []).filter((draft) => String(draft.id || '') !== String(event.id || ''));
    drafts = drafts.filter((draft) => !window.PlatformScheduling?.eventIsLocked?.(draft));
    if (drafts.length) {
      const choice = await (window.Portal?.ui?.choose?.(
        `This item drives ${drafts.length} linked item${drafts.length === 1 ? '' : 's'}. Move ${drafts.length === 1 ? 'it' : 'them'} to match?`,
        [
          { value:'no', label:(globalThis.PlatformLanguage?.text("project-schedule","m_9b37e2ebc66fc3","Just this item") ?? "Just this item") },
          { value:'yes', label:(globalThis.PlatformLanguage?.text("project-schedule","m_da2afe8f031395","Move linked items") ?? "Move linked items"), primary:true }
        ],
        { title:(globalThis.PlatformLanguage?.text("project-schedule","m_da2afe8f031395","Move linked items") ?? "Move linked items") }
      ) || 'no');
      if (choice === 'yes') {
        for (const draft of drafts) {
          const draftRange = { start:draft.start_at || draft.start, end:draft.end_at || draft.end, all_day:draft.all_day, schedule_granularity:draft.schedule_granularity };
          if (isMaterialDeliveryEvent(draft)) await saveMaterialScheduleRange(draft, { ...draftRange, all_day:true, schedule_granularity:'date' });
          else await commitWorkScheduleRange(draft, draftRange);
        }
      }
    }
    renderSchedulePanelPreservingScroll();
  }
  async function saveProjectGanttDependencies(event, dependsOn, label){
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(event?.id || '')) || event;
    if (!source?.id) return;
    const next = { ...source, depends_on:dependsOn, updated_at:new Date().toISOString() };
    const mutationVersion = beginScheduleEventSave(next.id);
    upsertLocalProjectEvent(next);
    renderSchedulePanelPreservingScroll();
    await saveProjectEventQuiet(next, {
      successTitle: label,
      successMessage: label === 'Items linked' ? 'The item now follows the one you connected it to.' : 'The dependency was removed.',
      failureTitle: 'Link not saved',
      broadcast: false,
      preserveLocalEvents: true,
      mutationVersion
    });
  }
  function projectGanttDependencyWouldCycle(fromEvent, toEvent){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling?.scheduleGraph) return false;
    const graph = Scheduling.scheduleGraph(scheduleProjectEvents());
    const visited = new Set();
    const queue = [String(toEvent?.id || '')];
    while (queue.length) {
      const currentId = queue.shift();
      if (currentId === String(fromEvent?.id || '')) return true;
      (graph.dependentsOf.get(currentId) || []).forEach((edge) => {
        if (!visited.has(edge.to)) { visited.add(edge.to); queue.push(edge.to); }
      });
    }
    return false;
  }
  async function createProjectGanttDependency(fromEvent, toEvent){
    const Scheduling = window.PlatformScheduling;
    const target = scheduleProjectEvents().find((item) => String(item.id || '') === String(toEvent?.id || '')) || toEvent;
    if (!Scheduling || !target?.id || !fromEvent?.id) return;
    const existing = Scheduling.eventDependencies ? Scheduling.eventDependencies(target) : [];
    if (existing.some((dep) => dep.event_id === String(fromEvent.id || ''))) return;
    if (projectGanttDependencyWouldCycle(fromEvent, target)) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_574bea457bf625","Circular link") ?? "Circular link"), (globalThis.PlatformLanguage?.text("project-schedule","m_1fda2b3dbe4011","That link would make these items depend on each other.") ?? "That link would make these items depend on each other."), false);
      return;
    }
    await saveProjectGanttDependencies(target, [...existing, {
      id:`dep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      event_id:String(fromEvent.id),
      type:'finish_to_start',
      lag_minutes:0
    }], 'Items linked');
  }
  async function removeProjectGanttDependency(event, dependency){
    const Scheduling = window.PlatformScheduling;
    const target = scheduleProjectEvents().find((item) => String(item.id || '') === String(event?.id || '')) || event;
    if (!Scheduling || !target?.id) return;
    const existing = Scheduling.eventDependencies ? Scheduling.eventDependencies(target) : [];
    await saveProjectGanttDependencies(target, existing.filter((dep) => dep.id !== dependency?.id), 'Items unlinked');
  }
  function openCreateGanttGroupDialog(){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling?.createScheduleGroupEvent || !activeBaseProject) return;
    document.querySelector('.r-gantt-group-backdrop')?.remove();
    const candidates = scheduleProjectEvents().filter((event) => !Scheduling.eventIsGroup?.(event) && !String(event.parent_event_id || '').trim());
    const backdrop = document.createElement('div');
    backdrop.className = 'fm-dialog-backdrop r-gantt-group-backdrop';
    backdrop.innerHTML = `
      <div class="fm-dialog r-gantt-group-dialog" role="dialog" aria-modal="true" aria-label="${(globalThis.PlatformLanguage?.text("project-schedule","m_0bb2928b65051a","New schedule group") ?? "New schedule group")}" style="max-width:420px">
        <div class="fm-dialog-head" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px 0"><h3 style="margin:0;font-size:15px;font-weight:1000">${(globalThis.PlatformLanguage?.text("project-schedule","m_1f78bb8e6f5d66","New Schedule Group") ?? "New Schedule Group")}</h3><button type="button" class="r-gantt-group-close" aria-label="${(globalThis.PlatformLanguage?.text("project-schedule","m_3742924668fb10","Close") ?? "Close")}" style="border:0;background:transparent;cursor:pointer;font-size:14px"><i class="fas fa-xmark"></i></button></div>
        <div style="display:grid;gap:10px;padding:12px 16px 16px">
          <label style="display:grid;gap:5px;font-size:11px;font-weight:900;color:#475467">${(globalThis.PlatformLanguage?.text("project-schedule","m_ddd01aa61b6e8e","Group name\n            ") ?? "Group name\n            ")}<input type="text" class="r-gantt-group-title" placeholder="${(globalThis.PlatformLanguage?.text("project-schedule","m_5f3f0233d1109b","e.g. Rough In") ?? "e.g. Rough In")}" style="height:36px;border:1px solid rgba(15,23,42,.14);border-radius:9px;padding:0 10px;font:inherit">
          </label>
          ${String(candidates.length ? `<div style="display:grid;gap:4px;max-height:220px;overflow:auto;border:1px solid rgba(15,23,42,.08);border-radius:10px;padding:8px">
            <span style="font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#98a2b3">Include items</span>
            ${candidates.map((event) => `<label style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:850;color:#101828"><input type="checkbox" value="${escapeHtml(event.id || '')}" class="r-gantt-group-item">${escapeHtml(event.title || 'Untitled')}</label>`).join('')}
          </div>` : '')}
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="r-schedule-view-btn r-gantt-group-close">${(globalThis.PlatformLanguage?.text("project-schedule","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
            <button type="button" class="r-schedule-view-btn active r-gantt-group-save"><i class="fas fa-layer-group"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_96122e368ef466"," Create Group") ?? " Create Group")}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.querySelectorAll('.r-gantt-group-close').forEach((btn) => btn.addEventListener('click', () => backdrop.remove()));
    backdrop.querySelector('.r-gantt-group-save')?.addEventListener('click', async () => {
      const title = String(backdrop.querySelector('.r-gantt-group-title')?.value || '').trim();
      if (!title) { backdrop.querySelector('.r-gantt-group-title')?.focus(); return; }
      const memberIds = [...backdrop.querySelectorAll('.r-gantt-group-item:checked')].map((input) => String(input.value || '')).filter(Boolean);
      backdrop.remove();
      const group = Scheduling.createScheduleGroupEvent(activeBaseProject, { title }, scheduleCachedConfig);
      const groupVersion = beginScheduleEventSave(group.id);
      upsertLocalProjectEvent(group);
      await saveProjectEventQuiet(group, { successTitle:'Group created', successMessage:`${title} was added to the schedule.`, failureTitle:'Group not saved', broadcast:false, preserveLocalEvents:true, mutationVersion:groupVersion });
      for (const memberId of memberIds) {
        const member = scheduleProjectEvents().find((item) => String(item.id || '') === memberId);
        if (!member) continue;
        const nextMember = { ...member, parent_event_id:group.id, updated_at:new Date().toISOString() };
        const memberVersion = beginScheduleEventSave(nextMember.id);
        upsertLocalProjectEvent(nextMember);
        await saveProjectEventQuiet(nextMember, { successTitle:'Group updated', successMessage:'Item added to the group.', failureTitle:'Group not saved', broadcast:false, preserveLocalEvents:true, mutationVersion:memberVersion });
      }
      renderSchedulePanelPreservingScroll();
    });
  }
  function renderScheduleLeft(){
    if (!state.leftRoot || !state.active) return;
    const target = leftContentRoot();
    if (!target) return;
    target.querySelector?.('.mt-left')?.remove();
    target.querySelector?.('.mn-left')?.remove();
    state.leftRoot.classList.add('visible', 'mode-edit');
    state.leftRoot.classList.remove('mode-list', 'mode-send');
    const label = state.leftRoot.querySelector('#rProposalLabel');
    if (label) {
      label.textContent = (globalThis.PlatformLanguage?.text("project-schedule","m_fc05a804bd034c","Schedule") ?? "Schedule");
      label.hidden = true;
    }
    target.innerHTML = `<div class="r-schedule-left-shell"><div class="r-schedule-left-scroll">
      <section class="r-schedule-section">
        <div class="r-schedule-section-head">
          <div class="r-schedule-section-title"><i class="fas fa-calendar-check"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_fc4a079f9b76e3"," Sales") ?? " Sales")}</div>
          <button type="button" class="r-schedule-mini-action primary" data-new-appointment><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_5fe01108f83039"," New") ?? " New")}</button>
        </div>
        ${String(scheduleAppointmentTilesHtml())}
      </section>
      <section class="r-schedule-section">
        <div class="r-schedule-section-head">
          <div class="r-schedule-section-title"><i class="fas fa-hammer"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_60694fdb9845ef"," Production") ?? " Production")}</div>
          <button type="button" class="r-schedule-mini-action primary" data-new-production><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_5fe01108f83039"," New") ?? " New")}</button>
        </div>
        ${String(productionTilesHtml())}
      </section>
      <section class="r-schedule-section">
        <div class="r-schedule-section-head">
          <div class="r-schedule-section-title"><i class="fas fa-repeat"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_5585bec15a89f3"," Recurring") ?? " Recurring")}</div>
          <button type="button" class="r-schedule-mini-action" data-new-recurrence><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_5fe01108f83039"," New") ?? " New")}</button>
        </div>
        ${String(recurringTilesHtml())}
      </section>
      ${String(leftStatusHtml())}
    </div></div>`;
    target.querySelector('[data-new-appointment]')?.addEventListener('click', startAppointmentScheduling);
    target.querySelector('[data-new-production]')?.addEventListener('click', () => openScheduleDialog('project_work'));
    target.querySelector('[data-new-recurrence]')?.addEventListener('click', () => openScheduleDialog('project_work'));
    target.querySelectorAll('[data-edit-recurrence]').forEach((button) => button.addEventListener('click', () => {
      const series = scheduleRecurringSeries.find((item) => String(item.id || '') === String(button.dataset.editRecurrence || ''));
      if (series) openScheduleDialog(String(series.event_template?.event_type_default_id || 'project_work'), series);
    }));
    target.querySelectorAll('[data-production-resource-event]').forEach((button) => button.addEventListener('click', () => {
      focusMaterialDelivery({ event_id: button.dataset.productionResourceEvent });
    }));
    target.querySelectorAll('[data-production-resource-crew]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const item = scheduleProjectEvents().find((candidate) => String(candidate.id || '') === String(button.dataset.productionResourceCrew || ''));
        if (item) openWorkAssignmentMenu(item, button);
      });
    });
    target.querySelector('[data-work-confirm]')?.addEventListener('click', saveWorkScheduleDraft);
    target.querySelector('[data-work-cancel]')?.addEventListener('click', cancelWorkDraft);
    target.querySelector('#rWorkDraftTitle')?.addEventListener('input', (event) => {
      const draft = activeWorkDraft();
      if (draft) {
        draft.title = event.target.value || 'Work';
        workScheduleDrafts.set(String(draft.id || ''), draft);
      }
    });
    target.querySelector('#rWorkAssignment')?.addEventListener('change', (event) => {
      const draft = activeWorkDraft();
      if (!draft?.start || !draft?.end) return;
      const crews = scheduleWorkResources(scheduleCachedConfig, scheduleCachedUsers);
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
    const recurrenceProjectId = String(ensureSchedulingProject()?.id || '');
    if (recurrenceProjectId && recurrenceProjectId !== scheduleRecurrenceProjectId) scheduleRecurrenceLoaded = false;
    if (recurrenceProjectId && !scheduleRecurrenceLoading && !scheduleRecurrenceLoaded) {
      loadRecurringSeries().then(() => { if (state.active) renderScheduleLeft(); });
    }
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
        title: event.title || (globalThis.PlatformLanguage?.text("project-schedule","m_222066ef57ae0e","Work") ?? "Work"),
        start: event.__start.toISOString(),
        end: event.__end.toISOString(),
        all_day: event.all_day !== false,
        schedule_granularity: event.schedule_granularity || (event.all_day === false ? 'time' : 'date'),
        crew_id: workCrewId(event),
        crew_name: workCrewName(event),
        assigned_crew_id: workCrewId(event),
        assigned_crew_name: workCrewName(event),
        assigned_crew: event.assigned_crew || (workCrewId(event) ? { id: workCrewId(event), name: workCrewName(event) } : null),
        assigned_resource_id:workCrewId(event),
        assigned_resource_name:workCrewName(event),
        assigned_resource_kind:workResourceKind(event),
        work_resource_ref:workCrewId(event) ? { kind:workResourceKind(event), id:workCrewId(event), name:workCrewName(event) } : null
      });
      setActiveWorkDraftId(id);
      scheduleAnchorDate = event.__start;
      renderSchedulePanel();
    }));
  }

  function renderWorkScheduler(target){
    const Scheduling = window.PlatformScheduling;
    const mobileLayout = window.matchMedia?.('(max-width:720px)').matches === true;
    if (!target) return;
    if (!window.PlatformScheduleView?.renderProjectRangeScheduler || !Scheduling) {
      target.innerHTML = `<div class="r-schedule-empty"><i class="fas fa-calendar"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_8d14608b5ea70e","Work scheduling tools are unavailable.") ?? "Work scheduling tools are unavailable.")}</div>`;
      return;
    }
    if (scheduleViewMode === 'gantt' && projectGanttViewEnabled() && window.PlatformScheduleView?.renderGanttScheduler) {
      window.PlatformScheduleView.renderGanttScheduler(target, {
        Scheduling,
        config: scheduleCachedConfig || null,
        project: activeBaseProject || null,
        events: scheduleProjectEvents(),
        date: scheduleAnchorDate,
        pxPerDay: projectGanttZoom || undefined,
        collapsedGroupIds: projectGanttCollapsedGroups,
        modeLabel: window.Portal?.terminology?.get?.('scheduling.gantt_view', 'Gantt') || 'Gantt',
        resourceHeader: 'Work Item',
        emptyLabel: 'No schedule items yet. Scheduled items from the scope, production work, and deliveries will appear here.',
        onZoomChange(next){ projectGanttZoom = Number(next) || 0; },
        onGroupToggle(groupId, isCollapsed){
          projectGanttCollapsedGroups = isCollapsed
            ? [...new Set([...projectGanttCollapsedGroups, String(groupId)])]
            : projectGanttCollapsedGroups.filter((id) => id !== String(groupId));
        },
        onEventClick(event, meta = {}){
          if (!event?.id) return;
          openScheduleEventPopover(event, meta.element);
        },
        onEventRangeChange(event, range, meta = {}){ saveProjectGanttRange(event, range, meta?.cascade || []); },
        onEventSchedule(event, range){ saveProjectGanttRange(event, range, []); },
        onDependencyCreate(fromEvent, toEvent){ createProjectGanttDependency(fromEvent, toEvent); },
        onDependencyRemove(event, dependency){ removeProjectGanttDependency(event, dependency); }
      });
      return;
    }
    const forceCrewScheduler = scheduleIsSchedulingView() && !materialScheduleModeActive;
    const crews = scheduleWorkResources(scheduleCachedConfig, scheduleCachedUsers);
    const crewRows = crews.length ? crews : (forceCrewScheduler ? [{ id: 'default_work_resource', name: workResourceLabel() }] : []);
    const currentWorkEvents = projectWorkEvents();
    const calendarWorkEvents = currentWorkEvents.map((event) => decorateWorkEventForCalendar(event, crews));
    const calendarMaterialEvents = projectMaterialEvents()
      .filter(isMaterialDeliveryEvent)
      .filter(materialEventIsScheduled);
    const calendarEvents = [...calendarWorkEvents, ...calendarMaterialEvents, ...projectSalesAppointmentEvents()];
    const materialEvent = materialScheduleModeActive ? selectedMaterialEvent() : null;
    const materialDraft = materialEvent && materialScheduleDraft?.start
      ? { ...materialEvent, ...materialScheduleDraft, id:materialEvent.id, event_id:materialEvent.id }
      : null;
    const calendarDrafts = [...workDraftList(), ...(materialDraft ? [materialDraft] : [])];
    const calendarActiveDraftId = materialDraft?.id || activeWorkScheduleDraftId;
    const allowProjectMobileCreate = mobileLayout && !scheduleIsSchedulingView() && !materialScheduleModeActive;
    const draftIsMaterial = (draft = {}) => isMaterialDeliveryEvent(draft)
      || (!!materialScheduleEventId && String(draft.id || '') === String(materialScheduleEventId));
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
        showToolbar: false,
        modeLabel: 'Production hourly view',
        resourceHeader: workResourceLabel(),
        unassignedLabel: 'Unassigned',
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
          commitWorkScheduleRange(event, range);
        },
        onEventClick(event, meta = {}){
          if (!event?.id) return;
          if (meta.action === 'assignee' && meta.element) {
            openWorkAssignmentMenu(event, meta.element);
            return;
          }
          openScheduleEventPopover(event, meta.element);
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
        showToolbar: false,
        modeLabel: 'Production daily view',
        resourceHeader: workResourceLabel(),
        unassignedLabel: 'Unassigned',
        onNavigate(nextDate){ scheduleAnchorDate = nextDate; renderSchedulePanel(); },
        onDraftChange(next){ setWorkScheduleDraft(next, { render: false, renderLeft: true }); },
        onDraftConfirm(){ saveWorkScheduleDraft(); },
        onEventRangeChange(event, range){
          commitWorkScheduleRange(event, range);
        },
        onEventClick(event, meta = {}){
          if (!event?.id) return;
          if (meta.action === 'assignee' && meta.element) {
            openWorkAssignmentMenu(event, meta.element);
            return;
          }
          openScheduleEventPopover(event, meta.element);
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
      drafts: calendarDrafts,
      activeDraftId: calendarActiveDraftId,
      allowCreate: materialScheduleModeActive
        ? !!materialEvent && !materialEventIsScheduled(materialEvent)
        : (workScheduleModeActive && !activeWorkDraft()?.event_id) || allowProjectMobileCreate,
      allowEdit: true,
      canEditEvent: (event) => !isMaterialDeliveryEvent(event) || !materialEventIsLocked(event),
      eventIsEditable: (event) => !isMaterialDeliveryEvent(event) || !materialEventIsLocked(event),
      onEventLockToggle: (event, nextLocked) => {
        if (isMaterialDeliveryEvent(event)) toggleMaterialScheduleLock(event, nextLocked);
      },
      mode: scheduleIsSchedulingView() ? scheduleSchedulingMode() : (['day','4day','week','month'].includes(scheduleViewMode) ? scheduleViewMode : workScheduleViewMode),
      showModeSwitch: false,
      showToolbar: false,
      mobileLayout,
      shortRangeDayCount: mobileLayout ? 3 : 4,
      touchHoldToPlace: mobileLayout,
      touchHoldDelayMs: 360,
      date: scheduleAnchorDate,
      slotMinutes: 30,
      resourceHeader: workResourceLabel(),
      unassignedLabel: 'Unassigned',
      defaultDraftPayload(){
        if (!materialScheduleModeActive || !materialEvent) return workCrewCalendarPayload({}, crews);
        return {
          ...materialEvent,
          id: materialEvent.id,
          event_id: materialEvent.id,
          project_id: activeBaseProject?.id || materialEvent.project_id || '',
          project_title: activeBaseProject?.title || activeBaseProject?.name || activeBaseProject?.customer_name || activeBaseProject?.customer?.name || activeBaseProject?.address || materialEvent.project_title || '',
          project_address: activeBaseProject?.address || materialEvent.project_address || '',
          title: materialDeliveryTitle(materialEvent),
          all_day: true,
          schedule_granularity: 'date'
        };
      },
      onNavigate(nextDate, delta, meta = {}){
        scheduleAnchorDate = nextDate;
        if (meta.source === 'swipe') animateProjectMobileCalendarSwipe(delta);
        renderSchedulePanel();
      },
      onModeChange(nextMode){
        if (scheduleIsSchedulingView()) scheduleViewMode = nextMode === 'day' ? 'scheduling-day' : 'scheduling-week';
        else scheduleViewMode = ['day','4day','week','month'].includes(nextMode) ? nextMode : 'month';
        workScheduleViewMode = ['day','4day','week','month'].includes(nextMode) ? nextMode : workScheduleViewMode;
        renderSchedulePanel();
      },
      onDraftChange(next){
        if (draftIsMaterial(next)) setMaterialScheduleDraft(next);
        else setWorkScheduleDraft(next, { render: false, renderLeft: true });
      },
      onDraftConfirm(next){
        if (draftIsMaterial(next)) saveMaterialScheduleDraft(next);
        else saveWorkScheduleDraft();
      },
      onEventRangeChange(event, range){
        if (isMaterialDeliveryEvent(event)) {
          saveMaterialScheduleRange(event, range);
          return;
        }
        const crewPayload = workCrewCalendarPayload(event, crews);
        setWorkScheduleDraft({
          id: event.id,
          event_id: event.event_id || event.id,
          title: event.title || (globalThis.PlatformLanguage?.text("project-schedule","m_222066ef57ae0e","Work") ?? "Work"),
          start: range.start,
          end: range.end,
          all_day: range.all_day,
          schedule_granularity: range.schedule_granularity,
          ...crewPayload
        }, { render: false, renderLeft: true });
      },
      onEventClick(event, meta = {}){
        if (!event?.id) return;
        if (meta.action === 'assignee' && meta.element && !isMaterialDeliveryEvent(event)) {
          openWorkAssignmentMenu(event, meta.element);
          return;
        }
        openScheduleEventPopover(event, meta.element);
      },
      onDraftSelect(draft){
        if (!draft?.id) return;
        if (draftIsMaterial(draft)) {
          renderScheduleLeft();
          return;
        }
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
    panel.classList.toggle('scheduling-mode', isScheduling);
    panel.innerHTML = `
      <div class="r-schedule-head">
        <div>
          <h2 class="r-schedule-title">${(globalThis.PlatformLanguage?.text("project-schedule","m_fc05a804bd034c","Schedule") ?? "Schedule")}</h2>
          <div class="r-schedule-sub">${String(escapeHtml(isScheduling ? `Assign production by ${workResourceLabel()} and date.` : 'Project calendar views show scheduled production and appointments.'))}</div>
        </div>
        <div class="r-schedule-head-actions">${String(scheduleViewSwitchHtml())}</div>
      </div>
      ${String(isScheduling ? '' : projectMobileToolbarHtml())}
      <div class="r-schedule-calendar work-calendar ${String(projectMobileCalendarSwipeDirection ? `mobile-swipe-${projectMobileCalendarSwipeDirection}` : '')}"></div>
    `;
    bindScheduleViewSwitch(panel);
    panel.querySelector('[data-gantt-add-group]')?.addEventListener('click', () => openCreateGanttGroupDialog());
    if (isScheduling) clearProjectMobileControls();
    else bindProjectMobileToolbar(panel);
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
        await loadWorkforceResources();
        if (state.active) renderSchedulePanel();
      } catch (_) {}
    })();
  }

  function renderCrewSettingsPanel(){
    window.dispatchEvent(new CustomEvent('fm:open-crew-settings'));
  }

  function renderSchedulePanel(){
    closeScheduleEventPopover();
    if (!state.active) {
      setScheduleWorkspaceChrome(false);
      clearScheduleLeft();
      return;
    }
    if (scheduleCrewSettingsOpen && workforceManagementEnabled()) {
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
          <h2 class="r-schedule-title">${(globalThis.PlatformLanguage?.text("project-schedule","m_fc05a804bd034c","Schedule") ?? "Schedule")}</h2>
          <div class="r-schedule-sub">${String(escapeHtml(scheduleSub))}</div>
        </div>
        <div class="r-schedule-head-actions">${String(scheduleViewSwitchHtml())}</div>
      </div>
      <div class="r-schedule-calendar"><div class="r-schedule-loading"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_1d56a895701e1c","&nbsp; Loading calendar...") ?? "&nbsp; Loading calendar...")}</div></div>
    `;
    bindScheduleViewSwitch(panel);
    updateSchedulePanelConfirm();
    if (!scheduleIsSchedulingView()) {
      renderProjectScheduleView(panel.querySelector('.r-schedule-calendar'), scheduleCachedConfig?.event_types?.sales_appointment || {}, scheduleCachedConfig || {});
      return;
    }
    (async () => {
      if (!Scheduling || !scheduleOrgId()) {
        panel.querySelector('.r-schedule-calendar').innerHTML = `<div class="r-schedule-empty"><i class="fas fa-calendar"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_576d28ec106963","Scheduling tools are unavailable.") ?? "Scheduling tools are unavailable.")}</div>`;
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
        await loadWorkforceResources();
      } catch (error) {
        if (gen !== scheduleCalendarGen) return;
        console.warn('Project scheduling data refresh failed; using last known data when available.', error);
        if (scheduleCachedConfig && scheduleCachedUsers.length) {
          config = scheduleCachedConfig;
          users = scheduleCachedUsers;
          projects = mergeScheduleActiveProject(scheduleCachedProjects);
        } else {
          panel.querySelector('.r-schedule-calendar').innerHTML = `<div class="r-schedule-empty"><i class="fas fa-calendar"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_162d3a1aa54d57","Could not load scheduling data.") ?? "Could not load scheduling data.")}</div>`;
          return;
        }
      }
      if (gen !== scheduleCalendarGen) return;
      const eventType = config.event_types?.sales_appointment || {};
      const salespeople = scheduleAssignableSubjects('sales_appointment', '', config, users);
      const target = panel.querySelector('.r-schedule-calendar');
      if (!salespeople.length) {
        target.innerHTML = `<div class="r-schedule-empty"><i class="fas fa-user-slash"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_281fa370fae5c5","No eligible assignees are available for sales appointments. Update this event type's assignment rules or add a matching person or resource group.") ?? "No eligible assignees are available for sales appointments. Update this event type's assignment rules or add a matching person or resource group.")}</div>`;
        return;
      }
      const singleUser = salespeople.length === 1
        && String(salespeople[0]?.subject_type || salespeople[0]?.resource_kind || 'organization_user') === 'organization_user';
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
      const userPayload = (user) => crewPayloadForSelection(user?.id || '', salespeople);
      const eventUserId = (event) => workCrewId(event);
      if (scheduleIsSchedulingView() && scheduleSchedulingMode() === 'week' && window.PlatformScheduleView?.renderResourceDayScheduler) {
        const allSalesEvents = (Scheduling.eventsFromProjects?.(projects, config) || []).filter(isSalesAppointmentEvent);
        const draftStart = scheduleDraft?.start ? new Date(scheduleDraft.start) : null;
        const draftAssignment = userPayload(scheduleDraft?.user || null);
        const salesDraft = draftStart ? {
          id: scheduleAssignmentEventId || '__sales_week_draft',
          event_id: scheduleAssignmentEventId || '',
          title: (globalThis.PlatformLanguage?.text("project-schedule","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment"),
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
          showToolbar: false,
          modeLabel: 'Sales weekly view',
          resourceLabel: 'Assignee',
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
              title: (globalThis.PlatformLanguage?.text("project-schedule","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment")
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
            setScheduleDraft(Scheduling.eventStart?.(event) || new Date(event.start_at || event.start || Date.now()), user, { id:event.id, event_id:event.id, duration_minutes:Number(event.duration_minutes || duration), title:event.title || (globalThis.PlatformLanguage?.text("project-schedule","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment") });
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
          title: (globalThis.PlatformLanguage?.text("project-schedule","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment"),
          start: draftStart,
          end: new Date(draftStart.getTime() + duration * 60000),
          all_day: false,
          schedule_granularity: 'time',
          ...draftAssignment
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
          showToolbar: false,
          modeLabel: 'Sales daily view',
          resourceLabel: 'Assignee',
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
              title: (globalThis.PlatformLanguage?.text("project-schedule","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment")
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
              title: event.title || (globalThis.PlatformLanguage?.text("project-schedule","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment")
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
          showToolbar: false,
          assignmentEventId: activeAssignmentEventId,
          lockPlacementStart: lockedStart,
          lockPlacementEnd: lockedEnd,
          selectedEventId: scheduleSelectedEventId || '',
          interactiveEventIds: Array.from(appointmentEventIds),
          eventMenuHtml({ event }) {
            if (!event?.id || !appointmentEventIds.has(String(event.id || ''))) return '';
            if (!scheduleEventAssigned(event)) return '';
            return `<div class="psv-event-menu"><div class="psv-event-action danger" data-psv-event-action="unassign"><i class="fas fa-user-minus"></i>${(globalThis.PlatformLanguage?.text("project-schedule","m_07454f15891016"," Unassign") ?? " Unassign")}</div></div>`;
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
            <div class="r-schedule-range">${String(escapeHtml(label))}</div>
          </div>
          <div class="r-schedule-toolbar-right">
            ${String(currentEvent ? `<button type="button" class="r-travel-toggle ${scheduleLockTime ? 'active' : ''}" data-schedule-lock-time><span class="dot"></span> Lock appointment time</button>` : '')}
            <button type="button" class="r-travel-toggle ${String(scheduleSmartScroll ? 'active' : '')}" data-schedule-smart-scroll><span class="dot"></span>${(globalThis.PlatformLanguage?.text("project-schedule","m_87d3f1a9ae9c3e"," Smart scroll") ?? " Smart scroll")}</button>
            <button type="button" class="r-travel-toggle ${String(scheduleUseLiveTravel ? 'active' : '')}" data-schedule-live-travel><span class="dot"></span>${(globalThis.PlatformLanguage?.text("project-schedule","m_821a653a1f79f2"," Live travel time") ?? " Live travel time")}</button>
            <span class="r-schedule-mode-pill"><i class="fas ${String(singleUser ? 'fa-calendar-week' : 'fa-table-cells')}"></i>${String(escapeHtml(modeLabel))}</span>
          </div>
        </div>
      `;
      if (singleUser && window.PlatformScheduleView?.renderProjectRangeScheduler) {
        const salesperson = salespeople[0];
        const draftStart = scheduleDraft?.start ? new Date(scheduleDraft.start) : null;
        const salesDraft = draftStart ? {
          id: scheduleAssignmentEventId || '__sales_draft',
          event_id: scheduleAssignmentEventId || '',
          title: (globalThis.PlatformLanguage?.text("project-schedule","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment"),
          start: draftStart,
          end: new Date(draftStart.getTime() + duration * 60000),
          all_day: false,
          schedule_granularity: 'time'
        } : null;
        const appointmentMode = scheduleIsSchedulingView() ? scheduleSchedulingMode() : (['day','4day','week'].includes(scheduleViewMode) ? scheduleViewMode : 'week');
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
          showToolbar: false,
          mobileLayout: window.matchMedia?.('(max-width:720px)').matches === true,
          shortRangeDayCount: window.matchMedia?.('(max-width:720px)').matches === true ? 3 : 4,
          touchHoldToPlace: window.matchMedia?.('(max-width:720px)').matches === true,
          touchHoldDelayMs: 360,
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
              title: (globalThis.PlatformLanguage?.text("project-schedule","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment")
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
              title: event.title || (globalThis.PlatformLanguage?.text("project-schedule","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment")
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
        <h3 id="rScheduleDialogTitle">${(globalThis.PlatformLanguage?.text("project-schedule","m_e5aee059bf2f35","Schedule Appointment") ?? "Schedule Appointment")}</h3>
        <p id="rScheduleDialogSub">${(globalThis.PlatformLanguage?.text("project-schedule","m_b90dbdb90ce3a1","Choose a time and assign one or more eligible resources.") ?? "Choose a time and assign one or more eligible resources.")}</p>
        <div class="r-schedule-grid">
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_29dbd3d8b69f55","Title") ?? "Title")}</label><input type="text" id="rScheduleItemTitle" placeholder="${(globalThis.PlatformLanguage?.text("project-schedule","m_5a654ad9b6d2e3","Appointment") ?? "Appointment")}"></div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_2a0b11100c22a4","Date") ?? "Date")}</label><input type="date" id="rScheduleDate"></div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_727840a47c2e4c","Time") ?? "Time")}</label><input type="time" id="rScheduleTime" step="900"></div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_bd8fd6e973f6e8","Duration") ?? "Duration")}</label><input type="number" id="rScheduleDuration" min="15" step="15"></div>
          <div class="r-schedule-field" id="rScheduleUsersWrap"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_ef1dde5e6d8239","Assign People / Crews") ?? "Assign People / Crews")}</label><select id="rScheduleUsers" multiple size="4"></select></div>
          <div class="r-schedule-field" id="rScheduleEquipmentWrap"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_09d7f821d4f1df","Assign Vehicles / Equipment") ?? "Assign Vehicles / Equipment")}</label><select id="rScheduleEquipment" multiple size="4"></select></div>
        </div>
        <label class="r-schedule-override" style="display:flex" id="rScheduleRecurringWrap"><input type="checkbox" id="rScheduleRecurring">${(globalThis.PlatformLanguage?.text("project-schedule","m_fe2abf52e30aa8"," Make this item recur") ?? " Make this item recur")}</label>
        <div class="r-schedule-grid" id="rScheduleRecurringFields" hidden>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_ff7bb68b2b05a8","Frequency") ?? "Frequency")}</label><select id="rScheduleFrequency"><option value="weekly">${(globalThis.PlatformLanguage?.text("project-schedule","m_093d55e6272fc0","Weekly") ?? "Weekly")}</option><option value="monthly" selected>${(globalThis.PlatformLanguage?.text("project-schedule","m_d7014f792d2583","Monthly") ?? "Monthly")}</option><option value="quarterly">${(globalThis.PlatformLanguage?.text("project-schedule","m_03e59d03617275","Quarterly") ?? "Quarterly")}</option><option value="yearly">${(globalThis.PlatformLanguage?.text("project-schedule","m_ef289ba5429ef5","Yearly") ?? "Yearly")}</option></select></div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_b25bba33f32e79","Every") ?? "Every")}</label><input type="number" id="rScheduleInterval" min="1" max="120" value="1"></div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_949158d13efad4","Ends") ?? "Ends")}</label><select id="rScheduleEndMode"><option value="never">${(globalThis.PlatformLanguage?.text("project-schedule","m_35304e673f218d","Never") ?? "Never")}</option><option value="date">${(globalThis.PlatformLanguage?.text("project-schedule","m_ab4cb92c128c9b","On a date") ?? "On a date")}</option><option value="count">${(globalThis.PlatformLanguage?.text("project-schedule","m_58e24f3e842b25","After a number of times") ?? "After a number of times")}</option></select></div>
          <div class="r-schedule-field" id="rScheduleEndDateWrap" hidden><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_75319fcfef3f5e","End date") ?? "End date")}</label><input type="date" id="rScheduleEndDate"></div>
          <div class="r-schedule-field" id="rScheduleCountWrap" hidden><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_328e02d666e842","Occurrences") ?? "Occurrences")}</label><input type="number" id="rScheduleCount" min="1" max="240" value="1"></div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_767fe02ce7276a","Bill each cycle") ?? "Bill each cycle")}</label><input type="number" id="rScheduleBillingAmount" min="0" step="0.01" placeholder="${(globalThis.PlatformLanguage?.text("project-schedule","m_a3f9a6b065b2d8","Optional") ?? "Optional")}"></div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_d0aa9ef5b7f01c","Billing cadence") ?? "Billing cadence")}</label><select id="rScheduleBillingFrequency"><option value="monthly">${(globalThis.PlatformLanguage?.text("project-schedule","m_d7014f792d2583","Monthly") ?? "Monthly")}</option><option value="quarterly">${(globalThis.PlatformLanguage?.text("project-schedule","m_03e59d03617275","Quarterly") ?? "Quarterly")}</option><option value="yearly">${(globalThis.PlatformLanguage?.text("project-schedule","m_ef289ba5429ef5","Yearly") ?? "Yearly")}</option></select></div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_768d0068b06fa1","Expense per visit") ?? "Expense per visit")}</label><input type="number" id="rScheduleExpenseAmount" min="0" step="0.01" placeholder="${(globalThis.PlatformLanguage?.text("project-schedule","m_a3f9a6b065b2d8","Optional") ?? "Optional")}"></div>
        </div>
        <div class="r-schedule-slots" id="rScheduleSlots"></div>
        <div class="r-schedule-status" id="rScheduleStatus"></div>
        <label class="r-schedule-override" id="rScheduleOverrideWrap"><input type="checkbox" id="rScheduleOverride">${(globalThis.PlatformLanguage?.text("project-schedule","m_2ae9d90aead238"," Schedule anyway") ?? " Schedule anyway")}</label>
        <div class="r-schedule-advanced" id="rScheduleAdvancedFields" hidden>
          <div class="r-schedule-grid">
            <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_08f74e6b15e4cb","Equipment needed from") ?? "Equipment needed from")}</label><input type="datetime-local" id="rScheduleEquipmentStart"></div>
            <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_5a9e2da3c9a9db","Equipment needed until") ?? "Equipment needed until")}</label><input type="datetime-local" id="rScheduleEquipmentEnd"></div>
          </div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.text("project-schedule","m_37e79a797ef736","Equipment type requirements") ?? "Equipment type requirements")}</label><div class="r-schedule-equipment-requirements" id="rScheduleEquipmentRequirements"></div></div>
        </div>
        <div class="r-schedule-advanced-actions">
          <button type="button" class="r-schedule-advanced-toggle" id="rScheduleAdvanced" aria-label="${(globalThis.PlatformLanguage?.text("project-schedule","m_c8cf170a6999a6","Show advanced event fields") ?? "Show advanced event fields")}" title="${(globalThis.PlatformLanguage?.text("project-schedule","m_bec5274b269a70","Advanced event fields") ?? "Advanced event fields")}" aria-pressed="false"><i class="fas fa-sliders"></i></button>
          <div class="r-schedule-actions">
            <button type="button" class="r-schedule-action secondary" id="rScheduleCancel">${(globalThis.PlatformLanguage?.text("project-schedule","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
            <button type="button" class="r-schedule-action" id="rScheduleSave">${(globalThis.PlatformLanguage?.text("project-schedule","m_fc05a804bd034c","Schedule") ?? "Schedule")}</button>
          </div>
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

  async function openScheduleDialog(eventTypeId = 'sales_appointment', recurringSeries = null){
    const Scheduling = window.PlatformScheduling;
    const orgId = scheduleOrgId();
    const project = ensureSchedulingProject();
    if (!Scheduling || !orgId || !project?.id) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_9cae930e9e6682","Scheduling unavailable") ?? "Scheduling unavailable"), (globalThis.PlatformLanguage?.text("project-schedule","m_467e6db386c0e7","Could not load the scheduling tools for this project.") ?? "Could not load the scheduling tools for this project."), false);
      return;
    }
    const dialog = ensureScheduleDialog();
    const dateInput = $('#rScheduleDate');
    const timeInput = $('#rScheduleTime');
    const itemTitleInput = $('#rScheduleItemTitle');
    const durationInput = $('#rScheduleDuration');
    const usersInput = $('#rScheduleUsers');
    const slotsEl = $('#rScheduleSlots');
    const statusEl = $('#rScheduleStatus');
    const saveBtn = $('#rScheduleSave');
    const overrideWrap = $('#rScheduleOverrideWrap');
    const overrideInput = $('#rScheduleOverride');
    const titleEl = $('#rScheduleDialogTitle');
    const subEl = $('#rScheduleDialogSub');
    const recurringInput = $('#rScheduleRecurring');
    const recurringFields = $('#rScheduleRecurringFields');
    const frequencyInput = $('#rScheduleFrequency');
    const intervalInput = $('#rScheduleInterval');
    const endModeInput = $('#rScheduleEndMode');
    const endDateInput = $('#rScheduleEndDate');
    const endDateWrap = $('#rScheduleEndDateWrap');
    const countInput = $('#rScheduleCount');
    const countWrap = $('#rScheduleCountWrap');
    const billingAmountInput = $('#rScheduleBillingAmount');
    const billingFrequencyInput = $('#rScheduleBillingFrequency');
    const expenseAmountInput = $('#rScheduleExpenseAmount');
    const equipmentInput = $('#rScheduleEquipment');
    const equipmentWrap = $('#rScheduleEquipmentWrap');
    const usersWrap = $('#rScheduleUsersWrap');
    const advancedButton = $('#rScheduleAdvanced');
    const advancedFields = $('#rScheduleAdvancedFields');
    const equipmentRequirements = $('#rScheduleEquipmentRequirements');
    const equipmentStartInput = $('#rScheduleEquipmentStart');
    const equipmentEndInput = $('#rScheduleEquipmentEnd');

    dialog.classList.add('active');
    statusEl.textContent = (globalThis.PlatformLanguage?.text("project-schedule","m_e936b49093ae54","Loading availability...") ?? "Loading availability...");
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
      rememberScheduleData(config, users, projects);
      await loadWorkforceResources();
    } catch (error) {
      statusEl.textContent = (globalThis.PlatformLanguage?.text("project-schedule","m_162d3a1aa54d57","Could not load scheduling data.") ?? "Could not load scheduling data.");
      statusEl.classList.add('bad');
      return;
    }

    const seriesEvent = recurringSeries?.event_template || {};
    const seriesRule = recurringSeries?.recurrence || {};
    const seriesBilling = recurringSeries?.billing || {};
    const seriesExpenses = recurringSeries?.expenses || {};
    eventTypeId = recurringSeries ? String(seriesEvent.event_type_default_id || eventTypeId) : eventTypeId;
    const eventType = config.event_types?.[eventTypeId] || {};
    const requiredRoleIds = Array.isArray(eventType.required_role_ids) ? eventType.required_role_ids : (Array.isArray(eventType.role_ids) ? eventType.role_ids : []);
    const allowedRoleIds = Array.isArray(eventType.allowed_role_ids) ? eventType.allowed_role_ids : (Array.isArray(eventType.role_ids) ? eventType.role_ids : requiredRoleIds);
    const roleIds = Array.from(new Set([...requiredRoleIds, ...allowedRoleIds]));
    const primaryRoleId = requiredRoleIds[0] || allowedRoleIds[0] || 'sales_appointments';
    const assignableSubjects = scheduleAssignableSubjects(eventTypeId, String(seriesEvent.scope_template_id || ''), config, users);
    const duration = Number(eventType.duration_minutes || 60);
    titleEl.textContent = recurringSeries ? 'Edit recurring item' : (eventType.label ? `Schedule ${eventType.label}` : 'Schedule Appointment');
    subEl.textContent = ((v0,v1) => globalThis.PlatformLanguage?.text("project-schedule","m_d9a86fd7f6df2c",`Choose from ${v0} eligible ${v1} allowed by this event type.`,{v0,v1}) ?? `Choose from ${v0} eligible ${v1} allowed by this event type.`)(assignableSubjects.length,assignableSubjects.length === 1 ? 'assignee' : 'assignees');
    const now = new Date();
    const nextHour = new Date(now.getTime() + 60 * 60 * 1000);
    nextHour.setMinutes(0, 0, 0);
    const seriesStart = recurringSeries?.start_at ? new Date(recurringSeries.start_at) : null;
    dateInput.value = seriesStart && Number.isFinite(seriesStart.getTime()) ? Scheduling.localDateInput(seriesStart) : Scheduling.localDateInput(nextHour);
    const internalLimitsEnabled = !!(config?.availability?.apply_limits_to_internal_users || config?.scheduling?.availability?.apply_limits_to_internal_users);
    const internalWindowForDate = (dateValue) => {
      if (internalLimitsEnabled) return Scheduling.availabilityWindow ? Scheduling.availabilityWindow(config, dateValue, eventTypeId) : { start: '09:00', end: '17:00' };
      return { start: '00:00', end: '23:59' };
    };
    const initialWindow = internalWindowForDate(dateInput.value);
    const seedTime = seriesStart || nextHour;
    timeInput.value = `${String(seedTime.getHours()).padStart(2, '0')}:${String(seedTime.getMinutes()).padStart(2, '0')}`;
    durationInput.value = Number(seriesEvent.duration_minutes || duration);
    itemTitleInput.value = recurringSeries?.title || seriesEvent.title || eventType.label || 'Appointment';
    recurringInput.checked = !!recurringSeries;
    frequencyInput.value = String(seriesRule.frequency || 'monthly');
    intervalInput.value = String(seriesRule.interval || 1);
    endModeInput.value = Number(seriesRule.occurrence_count) > 0 ? 'count' : (seriesRule.end_at ? 'date' : 'never');
    endDateInput.value = String(seriesRule.end_at || '').slice(0, 10);
    countInput.value = String(Math.max(1, Number(seriesRule.occurrence_count || 1)));
    billingAmountInput.value = seriesBilling.amount_cents ? (Number(seriesBilling.amount_cents) / 100).toFixed(2) : '';
    billingFrequencyInput.value = String(seriesBilling.frequency || seriesRule.frequency || 'monthly');
    expenseAmountInput.value = seriesExpenses.amount_cents ? (Number(seriesExpenses.amount_cents) / 100).toFixed(2) : '';
    const selectedEquipmentIds = new Set((Array.isArray(seriesEvent.resource_refs) ? seriesEvent.resource_refs : [])
      .filter((ref) => String(ref?.kind || '') === 'equipment_unit').map((ref) => String(ref.id || '')));
    if (equipmentInput) equipmentInput.innerHTML = scheduleCachedEquipmentUnits.map((unit) => `<option value="${escapeHtml(unit.id || '')}" ${selectedEquipmentIds.has(String(unit.id || '')) ? 'selected' : ''}>${escapeHtml(unit.name || unit.id)}${unit.type_name ? ` — ${escapeHtml(unit.type_name)}` : ''}</option>`).join('');
    const firstEquipmentRef = (Array.isArray(seriesEvent.resource_refs) ? seriesEvent.resource_refs : []).find((ref) => String(ref?.kind || '') === 'equipment_unit') || {};
    const localDateTime = (value) => {
      const date = value instanceof Date ? value : new Date(value);
      if (!Number.isFinite(date.getTime())) return '';
      const pad = (part) => String(part).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    if (equipmentStartInput) equipmentStartInput.value = localDateTime(firstEquipmentRef.start_at || selectedStart());
    if (equipmentEndInput) equipmentEndInput.value = localDateTime(firstEquipmentRef.end_at || new Date(selectedStart().getTime() + Number(durationInput.value || duration) * 60000));
    const existingRequirements = Array.isArray(seriesEvent.resource_requirements) ? seriesEvent.resource_requirements : [];
    if (equipmentRequirements) equipmentRequirements.innerHTML = scheduleCachedEquipmentTypes.length
      ? scheduleCachedEquipmentTypes.map((type) => {
          const requirement = existingRequirements.find((item) => String(item?.equipment_type_id || '') === String(type.id || ''));
          return `<label class="r-schedule-equipment-requirement"><input type="checkbox" data-equipment-requirement="${String(escapeHtml(type.id || ''))}" ${String(requirement ? 'checked' : '')}><span>${String(escapeHtml(type.name || type.id))}</span><input type="number" min="1" max="99" value="${String(escapeHtml(requirement?.quantity || 1))}" data-equipment-requirement-quantity="${String(escapeHtml(type.id || ''))}" aria-label="${((v5) => globalThis.PlatformLanguage?.text("project-schedule","m_138872c73d447c",`${v5} quantity`,{v5}) ?? `${v5} quantity`)(escapeHtml(type.name || 'Equipment'))}"></label>`;
        }).join('')
      : `<div class="r-schedule-status">${(globalThis.PlatformLanguage?.text("project-schedule","m_80651b68bcfcb3","No equipment types have been configured yet.") ?? "No equipment types have been configured yet.")}</div>`;
    let advancedOpen = false;
    const deliveryDefaultsHidden = () => String(eventTypeId || '').toLowerCase() === 'delivery';
    const renderAdvanced = () => {
      if (advancedFields) advancedFields.hidden = !advancedOpen || !equipmentSchedulingEnabled();
      if (advancedButton) {
        advancedButton.classList.toggle('active', advancedOpen);
        advancedButton.setAttribute('aria-pressed', advancedOpen ? 'true' : 'false');
        advancedButton.setAttribute('aria-label', advancedOpen ? 'Hide advanced event fields' : 'Show advanced event fields');
      }
      if (usersWrap) usersWrap.hidden = deliveryDefaultsHidden() && !advancedOpen;
      if (equipmentWrap) equipmentWrap.hidden = !equipmentSchedulingEnabled() || (deliveryDefaultsHidden() && !advancedOpen);
    };
    if (advancedButton) advancedButton.onclick = () => { advancedOpen = !advancedOpen; renderAdvanced(); };
    renderAdvanced();
    recurringFields.hidden = !recurringInput.checked;
    const renderRecurrenceEnd = () => {
      endDateWrap.hidden = endModeInput.value !== 'date';
      countWrap.hidden = endModeInput.value !== 'count';
    };
    renderRecurrenceEnd();

    function selectedStart(){
      return new Date(`${dateInput.value}T${timeInput.value || '09:00'}:00`);
    }

    function selectedUserIds(){
      return Array.from(usersInput.selectedOptions || []).map((option) => option.value).filter(Boolean);
    }

    function assignedUsersForIds(ids){
      return ids.map((id) => {
        const user = assignableSubjects.find((item) => item.id === id && item.subject_type === 'organization_user');
        if (!user) return null;
        return { id, name: user?.name || user?.email || id, role_ids: user?.roles?.length ? user.roles : roleIds };
      }).filter(Boolean);
    }

    let availabilityGeneration = 0;
    let authoritativeSlots = [];
    const authoritativeAvailability = () => window.PlatformAPI?.appointments?.availability?.(orgId, {
      project_id:project.id,
      event_id:String(scheduleAssignmentEventId || scheduleSelectedEventId || ''),
      event_type_id:eventTypeId,
      start_date:dateInput.value,
      end_date:dateInput.value,
      duration_minutes:Number(durationInput.value || duration),
      limit:500
    });
    const selectedResourceKeys = () => assignableSubjects
      .filter((subject) => selectedUserIds().includes(subject.id))
      .map((subject) => `${subject.subject_type || subject.resource_kind || 'organization_user'}:${subject.id}`.toLowerCase());
    const slotSupportsSelection = (slot) => {
      const selectedKeys = selectedResourceKeys();
      if (!selectedKeys.length) return slot?.available === true;
      const candidateKeys = new Set((Array.isArray(slot?.candidates) ? slot.candidates : []).map((candidate) => String(candidate.resource_key || '').toLowerCase()));
      return slot?.available === true && selectedKeys.every((key) => candidateKeys.has(key));
    };

    function renderAvailability(){
      const start = selectedStart();
      const durationMinutes = Number(durationInput.value || duration);
      const selectedIds = selectedUserIds();
      const selectedAssignedUsers = assignedUsersForIds(selectedIds);
      const selectedResourceSubjects = assignableSubjects.filter((subject) => selectedIds.includes(subject.id) && subject.subject_type !== 'organization_user');
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
        assignedUserIds: selectedAssignedUsers.map((user) => user.id),
        assignedUsers: selectedAssignedUsers,
      });
      const availableUserIds = new Set((eventAvailability.eligibleUsers?.length ? eventAvailability.eligibleUsers : availability.availableUsers).map((user) => String(user.id)));
      const eligibleUsers = assignableSubjects.filter((subject) => subject.subject_type !== 'organization_user' || availableUserIds.has(String(subject.id)) || selectedIds.includes(subject.id));
      usersInput.innerHTML = `<option value="">${(globalThis.PlatformLanguage?.text("project-schedule","m_f63dccd2774d7e","Assign later") ?? "Assign later")}</option>` + eligibleUsers.map((user) => {
        const roleLabel = (user.mapped_roles || []).map((role) => role.label).join(', ');
        const selected = selectedIds.includes(user.id) ? 'selected' : '';
        return `<option value="${escapeHtml(user.id)}" ${selected}>${escapeHtml(user.name || user.email || user.id)}${roleLabel ? ` - ${escapeHtml(roleLabel)}` : ''}</option>`;
      }).join('');
      const hasAvailability = eventAvailability.hasAvailability || selectedResourceSubjects.length > 0 || (!selectedIds.length && eventType.assignment_policy?.allow_unassigned !== false);
      statusEl.classList.toggle('bad', !hasAvailability);
      const assignedBusy = (eventAvailability.assignedStatus || []).filter((entry) => entry.busy).map((entry) => entry.user.name || entry.user.email || entry.user.id);
      statusEl.textContent = hasAvailability
        ? `${eligibleUsers.length} eligible for ${start.toLocaleString([], { weekday:'short', hour:'numeric', minute:'2-digit' })}.`
        : assignedBusy.length
          ? `${assignedBusy.join(', ')} is already booked at that time.`
          : 'Required roles are not fully available at that time.';
      if (overrideWrap) overrideWrap.classList.toggle('visible', !hasAvailability);
      saveBtn.disabled = !hasAvailability && !overrideInput?.checked;
      saveBtn.textContent = hasAvailability ? 'Schedule' : (overrideInput?.checked ? 'Schedule Anyway' : 'Schedule');
      void renderSlots();
    }

    async function renderSlots(){
      const generation = ++availabilityGeneration;
      saveBtn.disabled = true;
      slotsEl.innerHTML = `<span class="r-schedule-slot unavailable">${(globalThis.PlatformLanguage?.text("project-schedule","m_e3f33bfdf56cf1","Checking availability…") ?? "Checking availability…")}</span>`;
      let result;
      try {
        result = await authoritativeAvailability();
      } catch (error) {
        if (generation !== availabilityGeneration) return;
        authoritativeSlots = [];
        slotsEl.innerHTML = `<span class="r-schedule-slot unavailable">${(globalThis.PlatformLanguage?.text("project-schedule","m_f40ba07aaa433a","Availability unavailable") ?? "Availability unavailable")}</span>`;
        statusEl.textContent = error?.message || 'Could not check authoritative availability.';
        statusEl.classList.add('bad');
        saveBtn.disabled = !overrideInput?.checked;
        return;
      }
      if (generation !== availabilityGeneration) return;
      authoritativeSlots = (Array.isArray(result?.slots) ? result.slots : []).map((slot) => {
        const instant = new Date(slot.start_at || slot.start);
        return {
          ...slot,
          time:Number.isFinite(instant.getTime()) ? `${String(instant.getHours()).padStart(2, '0')}:${String(instant.getMinutes()).padStart(2, '0')}` : '',
          label:slot.label || (Number.isFinite(instant.getTime()) ? instant.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) : '') ,
          hasAvailability:slotSupportsSelection(slot)
        };
      });
      const slots = authoritativeSlots;
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
      const selectedIso = selectedStart().toISOString();
      const selectedSlot = slots.find((slot) => slot.start_at === selectedIso || slot.start === selectedIso);
      const available = slotSupportsSelection(selectedSlot);
      statusEl.classList.toggle('bad', !available);
      statusEl.textContent = available
        ? `${Number(selectedSlot.available_count || 0)} routed assignment${Number(selectedSlot.available_count || 0) === 1 ? '' : 's'} available for this time.`
        : 'This time is not available under the routed scheduling rules.';
      saveBtn.disabled = !available && !overrideInput?.checked;
      saveBtn.textContent = available ? 'Schedule' : (overrideInput?.checked ? 'Schedule Anyway' : 'Schedule');
    }

    [dateInput, timeInput, durationInput, usersInput, overrideInput].forEach((input) => {
      if (input) input.oninput = renderAvailability;
      if (input) input.onchange = renderAvailability;
    });
    recurringInput.onchange = () => {
      recurringFields.hidden = !recurringInput.checked;
      renderAvailability();
    };
    endModeInput.onchange = renderRecurrenceEnd;
    saveBtn.onclick = async () => {
      const selectedIds = selectedUserIds();
      const selectedSubjects = assignableSubjects.filter((subject) => selectedIds.includes(subject.id));
      const assignment = assignmentPayloadForSubjects(selectedSubjects);
      const selectedUnitIds = Array.from(equipmentInput?.selectedOptions || []).map((option) => String(option.value || '')).filter(Boolean);
      const equipmentWindowStart = new Date(equipmentStartInput?.value || selectedStart());
      const equipmentWindowEnd = new Date(equipmentEndInput?.value || (selectedStart().getTime() + Number(durationInput.value || duration) * 60000));
      if (selectedUnitIds.length && Number.isFinite(equipmentWindowStart.getTime()) && Number.isFinite(equipmentWindowEnd.getTime()) && equipmentWindowEnd <= equipmentWindowStart) {
        statusEl.textContent = (globalThis.PlatformLanguage?.text("project-schedule","m_a7c91be49bc6e0","Equipment must be released after it is assigned.") ?? "Equipment must be released after it is assigned.");
        statusEl.classList.add('bad');
        return;
      }
      const resourceRefs = selectedUnitIds.map((id) => {
        const unit = scheduleCachedEquipmentUnits.find((item) => String(item.id || '') === id);
        const existingRef = (Array.isArray(seriesEvent.resource_refs) ? seriesEvent.resource_refs : []).find((ref) => String(ref?.kind || '') === 'equipment_unit' && String(ref?.id || '') === id) || {};
        const startAt = new Date(equipmentStartInput?.value || existingRef.start_at || equipmentWindowStart);
        const endAt = new Date(equipmentEndInput?.value || existingRef.end_at || equipmentWindowEnd);
        return { kind:'equipment_unit', id, name:String(unit?.name || id), role:'equipment', ...(Number.isFinite(startAt.getTime()) ? { start_at:startAt.toISOString() } : {}), ...(Number.isFinite(endAt.getTime()) ? { end_at:endAt.toISOString() } : {}) };
      });
      const resourceRequirements = Array.from(equipmentRequirements?.querySelectorAll('[data-equipment-requirement]:checked') || []).map((checkbox) => {
        const typeId = String(checkbox.dataset.equipmentRequirement || '');
        const type = scheduleCachedEquipmentTypes.find((item) => String(item.id || '') === typeId);
        const quantity = Math.max(1, Math.round(Number(equipmentRequirements.querySelector(`[data-equipment-requirement-quantity="${window.CSS?.escape ? window.CSS.escape(typeId) : typeId}"]`)?.value || 1)));
        return { kind:'equipment_type', equipment_type_id:typeId, label:String(type?.name || typeId), quantity };
      });
      const event = Scheduling.createProjectEvent(project, eventTypeId, {
        start: selectedStart(),
        durationMinutes: Number(durationInput.value || duration),
        ...assignment,
        title: itemTitleInput.value || eventType.label || 'Appointment',
        availability_override: !!overrideInput?.checked,
        resource_refs:resourceRefs,
        resource_requirements:resourceRequirements,
      }, config);
      try {
        if (!recurringInput.checked && !recurringSeries && !overrideInput?.checked) {
          const latest = await authoritativeAvailability();
          const selectedIso = selectedStart().toISOString();
          const slot = (Array.isArray(latest?.slots) ? latest.slots : []).find((entry) => entry.start_at === selectedIso && slotSupportsSelection(entry));
          if (!slot) throw new Error('That time is no longer available under the routed scheduling rules. Choose another time or explicitly schedule anyway.');
        }
        if (recurringInput.checked || recurringSeries) {
          const billingAmount = Math.max(0, Math.round(Number(billingAmountInput.value || 0) * 100));
          const expenseAmount = Math.max(0, Math.round(Number(expenseAmountInput.value || 0) * 100));
          const payload = {
            title: itemTitleInput.value || event.title || (globalThis.PlatformLanguage?.text("project-schedule","m_e5d043f205f6a6","Recurring item") ?? "Recurring item"),
            start_at: selectedStart().toISOString(),
            recurrence: {
              frequency: frequencyInput.value || 'monthly',
              interval: Math.max(1, Number(intervalInput.value || 1)),
              end_at: endModeInput.value === 'date' && endDateInput.value ? new Date(`${endDateInput.value}T23:59:59`).toISOString() : '',
              occurrence_count: endModeInput.value === 'count' ? Math.max(1, Math.min(240, Math.round(Number(countInput.value || 1)))) : null
            },
            event_template: { ...event, id: undefined, title: itemTitleInput.value || event.title || (globalThis.PlatformLanguage?.text("project-schedule","m_e5d043f205f6a6","Recurring item") ?? "Recurring item") },
            billing: { enabled: billingAmount > 0, amount_cents: billingAmount, frequency: billingFrequencyInput.value || frequencyInput.value || 'monthly', label: itemTitleInput.value || event.title || (globalThis.PlatformLanguage?.text("project-schedule","m_e5d043f205f6a6","Recurring item") ?? "Recurring item") },
            expenses: { enabled: expenseAmount > 0, amount_cents: expenseAmount, kind: 'recurring_expense' }
          };
          if (!window.PlatformAPI?.projects?.createRecurrenceSeries) throw new Error('Recurring scheduling is not available.');
          if (recurringSeries?.id) await window.PlatformAPI.projects.updateRecurrenceSeries(orgId, recurringSeries.id, payload);
          else await window.PlatformAPI.projects.createRecurrenceSeries(orgId, { ...payload, project_id: project.id });
          scheduleRecurringSeries = [];
          await loadRecurringSeries({ refresh: true });
        } else {
          const saved = await Scheduling.saveProjectEvent(orgId, project, event, config);
          activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project?.events || [] };
        }
        persistActiveBaseProject();
        renderSchedulePanel();
        dialog.classList.remove('active');
        window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
        showToast(recurringInput.checked || recurringSeries ? 'Recurring item saved' : 'Appointment scheduled', recurringInput.checked || recurringSeries ? 'Its future occurrences were updated.' : `${event.title} was added to the project.`, true);
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
    const route = window.Portal?.navigation?.read?.() || {};
    if (['day','4day','week','month','scheduling-week','scheduling-day','gantt'].includes(route.projectScheduleView)
      && (route.projectScheduleView !== 'gantt' || projectGanttViewEnabled())
      && (!String(route.projectScheduleView).startsWith('scheduling') || projectRoutingViewEnabled())) scheduleViewMode = route.projectScheduleView;
    else if (!projectGanttDefaultApplied && projectGanttViewEnabled() && projectPrefersGantt()) { scheduleViewMode = 'gantt'; projectGanttDefaultApplied = true; }
    if (['production','sales'].includes(route.projectScheduleTarget)) scheduleSchedulingTarget = route.projectScheduleTarget;
    const routeDate = scheduleDateFromRoute(route.projectScheduleDate);
    if (routeDate) scheduleAnchorDate = routeDate;
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
      state.host = hostFor(state.context);
      state.leftRoot = context.leftRoot || context.roots?.left || state.leftRoot;
    }
    setActive(false);
  }

  function setActive(active){
    state.active = !!active;
    setScheduleWorkspaceChrome(state.active);
    if (state.active) renderSchedulePanel();
    else {
      closeWorkAssignmentMenu();
      closeScheduleEventPopover();
      clearScheduleLeft();
    }
  }

  function reset(){
    closeWorkAssignmentMenu();
    closeScheduleEventPopover();
    clearProjectMobileControls();
    scheduleModeActive = false;
    scheduleCalendarGen = 0;
    scheduleAnchorDate = new Date();
    scheduleViewMode = 'month';
    projectMobileViewMenuOpen = false;
    projectMobileMonthMenuOpen = false;
    projectMobilePickerMonth = scheduleAnchorDate.getMonth();
    projectMobilePickerYear = scheduleAnchorDate.getFullYear();
    projectMobileCalendarSwipeDirection = '';
    if (projectMobileCalendarSwipeTimer) window.clearTimeout(projectMobileCalendarSwipeTimer);
    projectMobileCalendarSwipeTimer = null;
    scheduleDraft = null;
    clearAllWorkDrafts();
    workScheduleModeActive = false;
    workScheduleViewMode = 'month';
    scheduleUseLiveTravel = true;
    scheduleLockTime = true;
    scheduleSmartScroll = false;
    scheduleSelectedEventId = '';
    scheduleAssignmentEventId = '';
    materialScheduleModeActive = false;
    materialScheduleEventId = '';
    materialScheduleListId = '';
    materialScheduleDraft = null;
    scheduleCrewSettingsOpen = false;
    scheduleWorkResourceDataLoaded = false;
    scheduleWorkforceTerminology = {};
    scheduleWorkforceTerminologyLoaded = false;
    scheduleRecurringSeries = [];
    scheduleRecurrenceLoading = false;
    scheduleRecurrenceLoaded = false;
    scheduleRecurrenceProjectId = '';
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

  const refreshWorkforceResources = async () => {
    const scrollPosition = captureScheduleScroll();
    await loadWorkforceResources({ refresh: true });
    if (state.active) {
      renderSchedulePanel();
      restoreScheduleScroll(scrollPosition);
    }
  };
  window.addEventListener('fm:workforce:updated', refreshWorkforceResources);
  window.addEventListener('fm:organization-connections:updated', refreshWorkforceResources);

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
    focusMaterialDelivery,
    context: () => ({ mounted: state.mounted, active: state.active, mode: materialScheduleModeActive ? 'materials' : scheduleViewMode, hasDraft: hasDraft() || !!materialScheduleDraft?.start })
  };

  const definition = {
    id: 'project.schedule',
    kind: 'project_modal_app',
    title: (globalThis.PlatformLanguage?.text("project-schedule","m_a47e2e5f42303b","Project Schedule") ?? "Project Schedule"),
    label: (globalThis.PlatformLanguage?.text("project-schedule","m_fc05a804bd034c","Schedule") ?? "Schedule"),
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
  window.Portal?.navigation?.registerSchema?.('projectScheduleDate', { history:'replace', scope:{ project:true, projectTab:'schedule' }, normalize:(value) => scheduleDateFromRoute(value) ? String(value) : '' });
  window.Portal?.navigation?.registerHandler?.('project-schedule-route', {
    priority:600,
    apply:(route) => {
      if (!route.project || route.projectTab !== 'schedule' || !state.mounted) return;
      const requestedView = String(route.projectScheduleView || '');
      const requestedAvailable = ['day','4day','week','month','scheduling-week','scheduling-day','gantt'].includes(requestedView)
        && (requestedView !== 'gantt' || projectGanttViewEnabled())
        && (!requestedView.startsWith('scheduling') || projectRoutingViewEnabled());
      scheduleViewMode = requestedAvailable
        ? requestedView
        : (!projectGanttDefaultApplied && projectGanttViewEnabled() && projectPrefersGantt() ? (projectGanttDefaultApplied = true, 'gantt') : 'month');
      scheduleSchedulingTarget = ['production','sales'].includes(route.projectScheduleTarget) ? route.projectScheduleTarget : 'production';
      const routeDate = scheduleDateFromRoute(route.projectScheduleDate);
      if (routeDate) scheduleAnchorDate = routeDate;
      if (state.active) renderSchedulePanel();
    }
  });

  runtime?.registerApp?.(definition);
})();
