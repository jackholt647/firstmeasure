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
  let scheduleCachedConfig = null;
  let scheduleCachedWorkResources = [];
  let scheduleCachedEquipmentUnits = [];
  let scheduleCachedEquipmentTypes = [];
  let scheduleEquipmentConflictMode = null;
  let scheduleCachedUsers = [];
  let scheduleCachedProjects = [];
  let scheduleWorkResourceDataLoaded = false;
  let scheduleWorkforceTerminology = {};
  let scheduleWorkforceTerminologyLoaded = false;
  let scheduleCrewMenuEventId = '';
  let scheduleCrewMenuDocHandler = null;
  let scheduleEventPopoverId = '';
  // The calendar item / row the details popover was opened from.
  let scheduleEventPopoverAnchor = null;
  let scheduleEventPopoverDocHandler = null;
  let scheduleRecurringSeries = [];
  let scheduleRecurrenceLoading = false;
  let scheduleRecurrenceLoaded = false;
  let scheduleRecurrenceProjectId = '';
  let scheduleDialogHandle = null;
  const scheduleTravelCache = new Map();
  const scheduleEventSaveVersions = new Map();
  const scheduleEventSaveQueues = new Map();
  const state = {
    mounted: false,
    active: false,
    host: null,
    model: null,
    panelRoot: null,
    sidebarRoot: null,
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
    defineHostAccessor('branchProjectConfig', () => callHost('getBranchProjectConfig') || state.model?.state?.branchProjectConfig || { title_mode: 'all_contacts' });
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
.r-schedule-range-label{margin-left:10px;font-size:13px;font-weight:900;color:#667085;letter-spacing:0;vertical-align:middle}
      .r-schedule-panel .r-schedule-head{flex-wrap:wrap;align-items:flex-start;row-gap:10px}.r-schedule-panel .r-schedule-head>div:first-child{flex:1 1 220px;min-width:0}.r-schedule-panel .r-schedule-sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.r-schedule-panel .r-schedule-head-actions{flex:0 1 auto;min-width:0;max-width:100%}
      .r-schedule-panel .r-schedule-calendar{min-width:0;-webkit-user-select:none;user-select:none}
      .r-schedule-panel.work-mode .r-schedule-calendar.work-calendar{container-type:inline-size}
      @container (max-width:980px){.r-schedule-panel .prs-wrap:not(.mobile-layout) .prs-time-grid,.r-schedule-panel .prs-wrap:not(.mobile-layout) .prs-all-day-grid{min-width:100%!important;grid-template-columns:56px repeat(var(--prs-days,7),minmax(0,1fr))}.r-schedule-panel .prs-wrap:not(.mobile-layout) .prs-day-head,.r-schedule-panel .prs-wrap:not(.mobile-layout) .prs-all-day-cell,.r-schedule-panel .prs-wrap:not(.mobile-layout) .prs-slot{min-width:0}.r-schedule-panel .prs-wrap:not(.mobile-layout) .prs-day-head{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.r-schedule-panel .prs-wrap:not(.mobile-layout) .prs-day-head-desktop{display:none}.r-schedule-panel .prs-wrap:not(.mobile-layout) .prs-day-head-mobile{display:flex;flex-direction:column;align-items:center;gap:1px;font-size:10px;line-height:1.05}.r-schedule-panel .prs-wrap:not(.mobile-layout) .prs-day-head-mobile strong{font-size:12px}}.r-schedule-panel .r-schedule-calendar input,.r-schedule-panel .r-schedule-calendar textarea{-webkit-user-select:text;user-select:text}
      .r-schedule-view-switch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .r-schedule-view-group{display:inline-flex;align-items:center;gap:3px;border:1px solid rgba(15,23,42,.10);background:#fff;border-radius:12px;padding:3px}
      .r-schedule-view-group.scheduling{border-color:rgba(var(--primary-rgb,217,48,37),.18);background:rgba(var(--primary-rgb,217,48,37),.04)}
      .r-schedule-view-group.surface{background:#f8fafc}
      .r-schedule-view-group.target{border-color:rgba(37,99,235,.18);background:#eef5ff}
      .r-schedule-view-group.navigation{gap:2px}.r-schedule-anchor-nav{min-width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:#475467;padding:0 8px;font-size:11px;font-weight:1000;cursor:pointer}.r-schedule-anchor-nav:hover{background:#f2f4f7;color:#101828}.r-schedule-anchor-nav.today{padding:0 10px}
      .r-schedule-view-label{font-size:10px;font-weight:1000;text-transform:uppercase;color:#667085;padding:0 7px}
      .r-schedule-left-shell{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;min-width:0;max-width:100%}
      .r-schedule-left-scroll{display:flex;flex:1;flex-direction:column;gap:12px;min-height:0;max-height:100%;overflow:auto;overflow-x:hidden;min-width:0}
      .r-overlay.schedule-workspace .r-proposal-section.visible,
      .r-overlay.schedule-workspace .r-proposal-listing{min-height:0}
      .r-overlay.schedule-workspace .r-proposal-listing{flex:1;height:100%;overflow:hidden}
      .r-overlay.schedule-workspace .r-step-shell,
      .r-overlay.schedule-workspace .r-step-inner,
      .r-overlay.schedule-workspace .r-step-body{min-height:0}
      .r-schedule-section{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:14px;padding:13px;box-shadow:0 10px 24px rgba(15,23,42,.04);min-width:0}
      .r-schedule-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
      .r-schedule-section-title{font-size:13px;font-weight:1000;color:#101828;display:flex;align-items:center;gap:8px;min-width:0}.r-schedule-section-head>.r-schedule-mini-action{flex:none}
      .r-schedule-mini-action{height:30px;border:1px solid rgba(15,23,42,.10);border-radius:10px;background:#fff;color:#344054;display:inline-flex;align-items:center;gap:7px;padding:0 9px;font-size:11px;font-weight:1000;cursor:pointer}
      .r-schedule-mini-action.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
      .r-schedule-mini-action:disabled{opacity:.45;cursor:not-allowed}
      .r-schedule-tile-list{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;min-width:0}
      .r-schedule-tile{border:1px solid rgba(15,23,42,.08);border-radius:12px;background:#f8fafc;padding:10px;text-align:left;color:#344054}
      .r-schedule-tile-title{font-size:12px;font-weight:1000;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .r-schedule-tile-kind{font-style:italic;font-weight:800;color:#667085}
      button.r-schedule-tile.r-sales-tile{display:block;width:100%;box-sizing:border-box;font:inherit;cursor:pointer}button.r-schedule-tile.r-sales-tile:hover,.r-production-resource-main:hover .r-schedule-tile-title{color:var(--primary-readable,var(--primary,#d93025))}
      .r-schedule-tile-meta{margin-top:4px;font-size:11px;font-weight:850;color:#667085;line-height:1.35}
      .r-material-tile{--material-list-color:#64748b;border-left:4px solid var(--material-list-color);display:block;width:100%;cursor:pointer}
      .r-material-tile.incomplete{border-left-style:dashed}.r-material-tile.active{background:color-mix(in srgb,var(--material-list-color) 9%,#fff);box-shadow:0 0 0 2px color-mix(in srgb,var(--material-list-color) 18%,transparent)}
      .r-material-tile .r-schedule-tile-title{display:flex;align-items:center;gap:7px}.r-material-tile .r-schedule-tile-title i{color:var(--material-list-color)}.r-schedule-tile:not(.r-material-tile) .r-schedule-tile-title i{margin-right:7px;color:#475467}
      .r-production-resource-tile{display:grid;grid-template-columns:minmax(0,1fr);align-items:center;gap:8px;width:100%;box-sizing:border-box}
      .r-production-resource-tile.no-assignment{grid-template-columns:1fr}
      .r-production-resource-main{min-width:0;border:0;background:transparent;padding:0;text-align:left;color:inherit;cursor:pointer}
      .r-production-resource-assignment{display:flex;align-items:center;gap:8px;min-width:0;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em;color:#667085}
      .r-production-resource-assignment>span{flex:0 0 auto}
      .r-production-resource-crew-button{flex:1 1 auto;min-width:0;width:auto;height:30px;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;color:#344054;padding:0 8px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;font-weight:900;text-transform:none;letter-spacing:0;cursor:pointer}
      .r-production-resource-crew-button span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.r-production-resource-crew-button i{flex:0 0 auto;font-size:9px;color:#98a2b3}.r-production-resource-crew-button.unassigned{font-style:italic;color:#667085}
      .r-schedule-crew-popover{position:fixed;z-index:3400;pointer-events:auto;width:220px;max-height:280px;overflow:auto;display:grid;gap:4px;padding:7px;border:1px solid rgba(15,23,42,.12);border-radius:12px;background:#fff;box-shadow:0 20px 50px rgba(15,23,42,.22)}
      .r-schedule-crew-option{height:34px;border:0;border-radius:8px;background:#fff;color:#344054;padding:0 10px;text-align:left;font-size:12px;font-weight:900;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .r-schedule-crew-option:hover,.r-schedule-crew-option.active{background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025))}
      .r-schedule-event-popover{position:fixed;z-index:3390;pointer-events:auto;width:min(330px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;display:grid;gap:12px;padding:14px;border:1px solid rgba(15,23,42,.12);border-radius:14px;background:#fff;box-shadow:0 22px 60px rgba(15,23,42,.24)}
      .r-schedule-event-popover-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.r-schedule-event-popover-title{min-width:0;font-size:15px;font-weight:1000;color:#101828;line-height:1.25}.r-schedule-event-popover-kind{display:inline-flex;align-items:center;gap:6px;margin-bottom:5px;color:#667085;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.055em}.r-schedule-event-popover-close{flex:0 0 auto;width:28px;height:28px;border:0;border-radius:8px;background:#f2f4f7;color:#475467;cursor:pointer}.r-schedule-event-popover-details{display:grid;gap:8px}.r-schedule-event-popover-row{display:grid;grid-template-columns:18px minmax(0,1fr);align-items:start;gap:8px;color:#475467;font-size:12px;font-weight:850;line-height:1.4}.r-schedule-event-popover-row i{margin-top:2px;color:#98a2b3;text-align:center}.r-schedule-event-popover-field{display:grid;gap:5px;padding-top:2px;color:#667085;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.r-schedule-event-popover-field select{width:100%;height:34px;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;color:#344054;padding:0 9px;font-size:12px;font-weight:900;text-transform:none;letter-spacing:0;cursor:pointer}
      .r-schedule-event-customer[hidden]{display:none}.r-schedule-event-customer{display:grid;border:1px solid rgba(15,23,42,.10);border-radius:10px;background:#f8fafc;overflow:hidden}.r-schedule-event-share{display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;align-items:center;padding:10px;cursor:pointer}.r-schedule-event-share input{position:absolute;opacity:0;pointer-events:none}.r-schedule-event-share-toggle{position:relative;width:34px;height:20px;border-radius:999px;background:#d0d5dd;transition:.18s ease}.r-schedule-event-share-toggle:after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.22);transition:.18s ease}.r-schedule-event-share input:checked+.r-schedule-event-share-toggle{background:var(--primary,#d93025)}.r-schedule-event-share input:checked+.r-schedule-event-share-toggle:after{transform:translateX(14px)}.r-schedule-event-share strong{display:block;color:#344054;font-size:11px;font-weight:1000}.r-schedule-event-share small{display:block;margin-top:2px;color:#667085;font-size:9px;font-weight:800;line-height:1.35}.r-schedule-event-customer-options{display:none;gap:8px;padding:0 10px 10px;border-top:1px solid rgba(15,23,42,.08)}.r-schedule-event-customer-options.open{display:grid}.r-schedule-event-customer-option{display:flex;align-items:flex-start;gap:7px;color:#344054;font-size:10px;font-weight:900;line-height:1.35}.r-schedule-event-customer-option:first-child{margin-top:9px}.r-schedule-event-customer-option input{margin:1px 0 0;accent-color:var(--primary,#d93025)}.r-schedule-event-customer-note{display:grid;gap:5px;color:#667085;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.r-schedule-event-customer-note textarea{min-height:66px;resize:vertical;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;padding:8px;color:#101828;font:inherit;font-size:11px;font-weight:800;line-height:1.45;text-transform:none;letter-spacing:0}.r-schedule-event-customer-save{height:32px;margin:0 10px 10px;border:0;border-radius:8px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font-size:11px;font-weight:1000;cursor:pointer}
      .r-schedule-slots.checking{opacity:.55;pointer-events:none;transition:opacity .12s ease}
      .r-schedule-event-popover-actions{display:flex;gap:6px;flex-wrap:wrap}.r-schedule-event-popover-action{height:30px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#344054;padding:0 10px;display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:11px;font-weight:1000;cursor:pointer}.r-schedule-event-popover-action:hover{background:#f2f4f7;color:#101828}
      .r-schedule-event-popover .r-schedule-confirm{height:auto;width:auto;box-shadow:none;color:inherit}
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
      .r-schedule-left-status.r-schedule-view-only{border-color:rgba(15,23,42,.1);background:#f8fafc;color:#475467}
      #rSchedulePanel .prs-mobile-control.month{width:auto;max-width:none;min-width:0;flex:0 1 auto}
      .r-schedule-left-status strong{display:block;color:#101828;font-size:12px;font-weight:1000;margin-bottom:2px}
      .r-schedule-placement-banner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px 8px 12px;border:1px solid rgba(37,99,235,.24);border-radius:12px;background:#eff6ff;color:#1e3a8a;font-size:12px;font-weight:850;line-height:1.35}.r-schedule-placement-banner>i{color:#2563eb}.r-schedule-placement-banner>span{flex:1 1 200px;min-width:0}.r-schedule-placement-banner strong{font-weight:1000;color:#172554}.r-schedule-placement-banner .warn{display:block;color:#b45309;font-weight:900}.r-schedule-placement-cancel{flex:0 0 auto;height:30px;border:1px solid rgba(37,99,235,.28);border-radius:9px;background:#fff;color:#1d4ed8;padding:0 10px;font:inherit;font-size:11px;font-weight:1000;cursor:pointer}.r-schedule-placement-cancel:hover{background:#dbeafe}.r-schedule-placement-cancel kbd{font:inherit;font-size:10px;opacity:.7}
      .r-schedule-panel.work-mode.scheduling-mode .r-schedule-placement-banner{margin:8px 12px 0}.r-schedule-panel:not(.work-mode) .r-schedule-placement-banner{margin:0 0 10px}
      .r-schedule-panel.r-schedule-saving{cursor:progress}.r-schedule-panel.r-schedule-saving [data-prs-confirm],.r-schedule-panel.r-schedule-saving [data-psv-draft-confirm],.r-schedule-panel.r-schedule-saving [data-schedule-draft-confirm]{pointer-events:none;opacity:.5}
      .r-schedule-panel.r-schedule-view-only .prs-assignee{cursor:default}.r-schedule-panel.r-schedule-view-only .prs-assignee:after{display:none}.r-schedule-panel.r-schedule-view-only .prs-assignee:hover{background:transparent}
      .r-schedule-panel .r-schedule-sub{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
      .r-schedule-dialog .r-schedule-card.loading .r-schedule-grid,.r-schedule-dialog .r-schedule-card.loading .r-schedule-allday,.r-schedule-dialog .r-schedule-card.loading #rScheduleRecurringWrap{opacity:.62;transition:opacity .15s}.r-schedule-dialog .r-schedule-card.loading input,.r-schedule-dialog .r-schedule-card.loading select{cursor:progress}
      .r-schedule-dialog .r-schedule-card{overscroll-behavior:contain}.r-schedule-dialog .r-schedule-card .r-schedule-advanced-actions{position:sticky;bottom:-22px;z-index:3;margin:14px -22px -22px;padding:12px 22px 18px;background:#fff;border-top:1px solid rgba(15,23,42,.08);border-radius:0 0 24px 24px}
      .r-schedule-dialog .r-schedule-action:disabled,.r-schedule-dialog .r-schedule-action[aria-busy="true"]{opacity:.5;cursor:not-allowed;box-shadow:none;filter:saturate(.6)}.r-schedule-dialog .r-schedule-action[aria-busy="true"]{cursor:progress}
      .r-schedule-dialog .r-schedule-slots-note{display:inline-flex;align-items:center;gap:7px;color:#667085;font-size:12px;font-weight:850}
      .r-schedule-dialog .r-schedule-allday{display:flex;align-items:center;gap:8px;margin:12px 0 0;color:#344054;font-size:12px;font-weight:900;cursor:pointer}.r-schedule-dialog [hidden]{display:none!important}
      .r-schedule-assignees{display:grid;gap:6px}.r-schedule-assignee-chips{display:flex;flex-wrap:wrap;gap:5px}.r-schedule-assignee-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;height:26px;padding:0 4px 0 9px;border-radius:999px;background:#f2f4f7;color:#344054;font-size:11px;font-weight:900;text-transform:none;letter-spacing:0}.r-schedule-assignee-chip span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.r-schedule-assignee-chip button{width:20px;height:20px;border:0;border-radius:50%;background:transparent;color:#667085;cursor:pointer;font-size:10px}.r-schedule-assignee-chip button:hover{background:#e4e7ec;color:#b42318}.r-schedule-assignee-empty{color:#667085;font-size:11px;font-style:italic;font-weight:850;text-transform:none;letter-spacing:0}
      .r-schedule-event-popover-action.danger{color:#b42318}.r-schedule-event-popover-action.danger:hover{background:#fef3f2;color:#912018}
      .r-schedule-crew-option{display:flex;align-items:center;gap:8px}.r-schedule-crew-option .check{width:12px;flex:0 0 12px;color:var(--primary,#d93025);font-size:10px}.r-schedule-crew-option span{min-width:0;overflow:hidden;text-overflow:ellipsis}.r-schedule-crew-option:disabled{cursor:progress;color:#98a2b3;font-style:italic}.r-schedule-crew-hint{padding:2px 10px 4px;color:#667085;font-size:10px;font-weight:850}.r-schedule-crew-more{height:30px;border:0;border-top:1px solid rgba(15,23,42,.08);border-radius:0 0 8px 8px;background:#fff;color:#475467;font:inherit;font-size:11px;font-weight:950;text-align:left;padding:0 10px;cursor:pointer}.r-schedule-crew-more:hover{background:#f2f4f7}
      .r-schedule-panel .prs-month-bar>.prs-work-chip{container-type:inline-size}@container (max-width:120px){.r-schedule-panel .prs-month-bar .prs-work-chip .prs-assignee{display:none}}
      .r-schedule-other-tile{display:block;width:100%;box-sizing:border-box;font:inherit;cursor:pointer}.r-schedule-other-tile:hover .r-schedule-tile-title{color:var(--primary-readable,var(--primary,#d93025))}
      .r-recurrence-tile{width:100%;min-width:0;max-width:100%;box-sizing:border-box;overflow:hidden;text-align:left;cursor:pointer}.r-recurrence-tile.cancelled{opacity:.62}.r-recurrence-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}.r-recurrence-meta>.r-schedule-tile-title{flex:1 1 auto;min-width:0}.r-recurrence-tile .r-schedule-tile-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.r-recurrence-pill{flex:none;border-radius:999px;padding:3px 7px;background:#eef4ff;color:#175cd3;font-size:9px;font-weight:1000;text-transform:uppercase}.r-recurrence-pill.cancelled{background:#f2f4f7;color:#667085}

      @media(max-width:720px){
        .r-overlay.schedule-workspace .r-preview-panel[data-panel="schedule"]>.r-tab-content{flex-direction:column}
        .r-overlay.schedule-workspace .r-preview-panel[data-panel="schedule"]>.r-tab-content>.r-tab-sidebar{flex:0 0 auto;width:auto!important;min-width:0!important;max-width:none!important;max-height:36%;overflow:auto;border-right:0;border-bottom:1px solid rgba(15,23,42,.10)}
        .r-overlay.schedule-workspace .r-preview-panel[data-panel="schedule"]>.r-tab-content>.r-tab-sidebar .r-step-shell{width:auto;min-width:0}
        .r-overlay.schedule-workspace .r-preview-panel[data-panel="schedule"]>.r-tab-content>.r-tab-main{flex:1 1 auto;min-height:0;width:100%!important;min-width:0}
        .r-schedule-left-shell{height:auto}.r-schedule-left-scroll{max-height:none;overflow:visible}
        .r-schedule-panel.work-mode.scheduling-mode .r-schedule-head{padding:8px 10px;row-gap:6px}.r-schedule-panel.work-mode.scheduling-mode .r-schedule-sub{display:none}.r-schedule-panel.work-mode.scheduling-mode .r-schedule-title{font-size:17px}.r-schedule-panel.work-mode.scheduling-mode .r-schedule-view-switch{justify-content:flex-start;flex-wrap:nowrap;overflow-x:auto;max-width:100%;padding:2px;scrollbar-width:none}.r-schedule-panel.work-mode.scheduling-mode .r-schedule-view-group{flex:0 0 auto}.r-schedule-panel.work-mode.scheduling-mode .r-schedule-head-actions{width:100%}
        .r-schedule-panel.work-mode{padding:0;gap:0;min-width:0;background:#fff}
        .r-schedule-panel.work-mode:not(.scheduling-mode) .r-schedule-head,.r-schedule-panel:not(.work-mode) .r-schedule-head{display:none}
        .r-schedule-panel .r-schedule-placement-banner{margin:6px 8px}
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

  // View-only sessions (no manage_schedule) can open every schedule view but
  // cannot create, move, assign, lock or share items. Mirrors the global
  // Scheduling tab's canEditSchedule().
  function canEditSchedule(){
    const permissions = window.Portal?.currentUser?.permissions;
    if (!permissions || typeof permissions !== 'object' || !Object.keys(permissions).length) return true;
    return permissions.manage_schedule === true || (permissions['*'] === true && permissions.manage_schedule !== false);
  }

  function scheduleReadOnlyMessage(){
    return (globalThis.PlatformLanguage?.text("scheduling","m_readonly_schedule","You can view the schedule, but you don't have permission to change it.") ?? "You can view the schedule, but you don't have permission to change it.");
  }

  function requireScheduleEdit(){
    if (canEditSchedule()) return true;
    showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), scheduleReadOnlyMessage(), 'info');
    if (state.active) renderSchedulePanelPreservingScroll();
    return false;
  }

  function workforceTerm(kind, form = 'singular'){
    const defaults = {
      resource_group: { singular:'Crew', plural:'Crews' },
      organization_connection: { singular:'Subcontractor', plural:'Subcontractors' }
    };
    const configured = scheduleWorkforceTerminology?.[kind] || {};
    const fallback=String(configured?.[form] || configured?.singular || defaults[kind]?.[form] || defaults[kind]?.singular || 'Team').trim();
    return window.PlatformTerminology?.get?.(`workforce.${kind}_${form}`,fallback) || fallback;
  }

  function workResourceLabel(form = 'singular'){
    return `${workforceTerm('resource_group', form)} / ${workforceTerm('organization_connection', form)}`;
  }

  function ensureProposalOnlyBaseProject(){
    return callHost('ensureProposalOnlyBaseProject') || activeBaseProject;
  }

  // Schedule changes are saved through the event endpoints, which return the
  // authoritative project document. Only refresh the local project cache here:
  // rebuilding the whole project from the Overview form (the host's
  // persistProject) on schedule renders overwrote projects with blank drafts.
  function cacheActiveBaseProject(){
    if (!activeBaseProject) return null;
    // Never replace a cached project with a still-loading placeholder.
    const loaded = !activeBaseProject.__projectShellLoading
      && !!String(activeBaseProject.title || activeBaseProject.customer_name || activeBaseProject.address || '').trim();
    if (loaded) {
      const store = window.Portal?.ProjectStore;
      let project = activeBaseProject;
      // An item this window still holds at an older revision never replaces
      // a newer stored copy (from the server or another window): the stale
      // copy's revision would otherwise be sent on every later save.
      try {
        const cached = store?.get?.(project.id);
        const cachedById = new Map((Array.isArray(cached?.events) ? cached.events : []).map((event) => [String(event?.id || ''), event]));
        if (Array.isArray(project.events) && (cachedById.size || scheduleServerEvents.size)) {
          project = { ...project, events:project.events.map((event) => {
            const id = String(event?.id || '');
            return [cachedById.get(id), latestServerEventCopy(id)].filter(Boolean)
              .reduce((best, candidate) => scheduleEventRevision(candidate) > scheduleEventRevision(best) ? candidate : best, event);
          }) };
        }
      } catch (_) {}
      try { store?.cache?.(project); } catch (_) {}
    }
    return activeBaseProject;
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
    // Stored assignees can carry only an id; resolve it to the loaded user
    // instead of showing the raw id.
    const nameFor = (id) => {
      const user = scheduleCachedUsers.find((candidate) => String(candidate?.id || '') === String(id || ''));
      return String(user?.name || user?.email || '').trim();
    };
    const users = Array.isArray(event.assigned_users) ? event.assigned_users : [];
    const named = users.map((user) => user.name || user.email || nameFor(user.id)).filter(Boolean);
    if (named.length) return named.join(', ');
    const ids = Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : [];
    const resolved = ids.map(nameFor).filter(Boolean);
    if (resolved.length) return resolved.join(', ');
    if (ids.length) return ids.length === 1 ? '1 assignee' : `${ids.length} assignees`;
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

  // Read-only view of the project being scheduled. Rendering must never create
  // or save a project record.
  function currentSchedulingProject(){
    if (!activeBaseProject) return null;
    if (!Array.isArray(activeBaseProject.events)) activeBaseProject.events = [];
    return activeBaseProject;
  }

  // Only explicit schedule saves may create the draft project they belong to.
  function ensureSchedulingProject(){
    if (!activeBaseProject) ensureProposalOnlyBaseProject();
    return currentSchedulingProject();
  }

  async function ensureRemoteSchedulingProject(){
    return ensureSchedulingProject();
  }

  // Event saves go straight to the event endpoint, which answers with the saved
  // project document. The API client reports a project that is not on the
  // server yet (a brand-new draft) as a document-less result; create that
  // draft once, then retry, and never adopt the placeholder as the project.
  // Optimistic concurrency: PlatformScheduling.saveProjectEvent sends the
  // revision of the copy being edited, and the server refuses the save
  // (409 stale_event) when someone else saved the item since. Every local
  // save bumps this serial so a read that raced it is not adopted.
  let scheduleMutationSerial = 0;
  /* A save the server refused because the item changed since it was read. */
  function isStaleSaveError(error){
    if (!error) return false;
    if (error.stale === true || error.staleSchedule === true) return true;
    if (window.PlatformAPI?.isStaleError?.(error) === true || window.PlatformScheduling?.isStaleSaveError?.(error) === true) return true;
    const code = String(error.code || error.data?.code || error.data?.error || error.name || '').trim().toLowerCase();
    return (Number(error.status) === 409 || code.includes('stale')) && /stale|revision|version|changed_elsewhere|concurrent|modified/.test(code);
  }
  function scheduleEventRevision(event = {}){
    const revision = Number(event?.event_revision);
    return Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : 0;
  }
  /* The stored copies of this project's items that this window read from (or
   * wrote to) the server, by id and revision. A refused (409) save compares
   * the copy it edited with the newer stored one to see which fields each
   * side changed. */
  const scheduleServerEvents = new Map();
  function rememberServerEvents(events = []){
    const projectId = String(activeBaseProject?.id || '');
    (Array.isArray(events) ? events : []).forEach((event) => {
      const id = String(event?.id || '');
      if (!id || !event || typeof event !== 'object') return;
      const key = `${projectId}:${id}`;
      const copies = scheduleServerEvents.get(key) || new Map();
      copies.set(scheduleEventRevision(event), event);
      // A few recent revisions are enough to find the copy an edit started from.
      while (copies.size > 6) copies.delete(Math.min(...copies.keys()));
      scheduleServerEvents.set(key, copies);
    });
  }
  function serverEventCopy(id = '', revision = 0){
    return scheduleServerEvents.get(`${String(activeBaseProject?.id || '')}:${String(id || '')}`)?.get(Number(revision) || 0) || null;
  }
  function latestServerEventCopy(id = ''){
    const copies = scheduleServerEvents.get(`${String(activeBaseProject?.id || '')}:${String(id || '')}`);
    return copies?.size ? copies.get(Math.max(...copies.keys())) : null;
  }
  /* Field groups a refused save compares, as in the global Scheduling tab: a
   * save only conflicts with a change made elsewhere when both touched the
   * same group; otherwise only this window's own changes are written on top
   * of the stored copy. */
  const SCHEDULE_TIME_KEYS = ['start', 'end', 'start_at', 'end_at', 'duration_minutes', 'all_day', 'schedule_granularity', 'start_date', 'end_date'];
  const SCHEDULE_ASSIGNMENT_KEYS = ['assigned_user_ids', 'assigned_users', 'assigned_user_id', 'assigned_user_name', 'work_resource_ref', 'assigned_resource_kind', 'assigned_resource_id', 'assigned_resource_name', 'assigned_crew_id', 'assigned_crew_name', 'assigned_crew', 'crew_id', 'crew_name', 'resource_id', 'resource_name', 'assignee_label', 'crew_label'];
  const SCHEDULE_LOCK_KEYS = ['locked', 'schedule_locked', 'schedule_lock', 'unlock_confirmed'];
  const SCHEDULE_COMPARE_IGNORED = new Set(['id', 'updated_at', 'created_at', 'updated_by', 'schedule_history', 'requirement_warnings', 'project_title', 'project_address', 'resource_refs', 'floating_event', 'type_id', 'event_type_id', 'event_type_default_id', 'title_is_custom', 'revision', 'version', 'event_revision', 'expected_event_revision', 'awaiting_crew', 'project_id']);
  const SCHEDULE_CREW_REF_KINDS = ['resource_group', 'organization_connection', 'organization_user'];
  function scheduleEmptyValue(value){
    return value === undefined || value === null || value === '' || value === false
      || (Array.isArray(value) && !value.length)
      || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);
  }
  function scheduleEventGroupValue(event = {}, group = ''){
    const Scheduling = window.PlatformScheduling;
    const time = (value) => { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.getTime() : 0; };
    if (group === 'time') {
      const unscheduled = !String(event?.start_at || event?.start || '').trim();
      return unscheduled ? '[]' : JSON.stringify([Scheduling?.eventStart?.(event)?.getTime?.() || 0, Scheduling?.eventEnd?.(event)?.getTime?.() || 0, event?.all_day === true || String(event?.schedule_granularity || '').toLowerCase() === 'date']);
    }
    if (group === 'assignment') return JSON.stringify(eventWorkAssignees(event || {}).map((ref) => ref.id).sort());
    if (group === 'equipment') return JSON.stringify((Scheduling?.eventEquipmentRefs?.(event || {}) || []).map((ref) => [ref.kind, ref.id, ref.quantity, time(ref.start_at), time(ref.end_at)]).sort());
    if (group === 'lock') return materialEventIsLocked(event || {}) ? '1' : '0';
    const value = event?.[group];
    return scheduleEmptyValue(value) ? '' : JSON.stringify(value);
  }
  function scheduleEventChangeGroups(before = {}, after = {}){
    const grouped = new Set([...SCHEDULE_TIME_KEYS, ...SCHEDULE_ASSIGNMENT_KEYS, ...SCHEDULE_LOCK_KEYS]);
    const groups = new Set(['time', 'assignment', 'equipment', 'lock']);
    [...Object.keys(before || {}), ...Object.keys(after || {})].forEach((key) => {
      if (!key.startsWith('__') && !grouped.has(key) && !SCHEDULE_COMPARE_IGNORED.has(key)) groups.add(key);
    });
    return [...groups].filter((group) => scheduleEventGroupValue(before, group) !== scheduleEventGroupValue(after, group));
  }
  function scheduleMergeEventChanges(fresh = {}, edited = {}, groups = []){
    const merged = { ...fresh };
    const crewRefs = (event) => (Array.isArray(event?.resource_refs) ? event.resource_refs : []).filter((ref) => SCHEDULE_CREW_REF_KINDS.includes(String(ref?.kind || '')));
    const otherRefs = (event) => (Array.isArray(event?.resource_refs) ? event.resource_refs : []).filter((ref) => !SCHEDULE_CREW_REF_KINDS.includes(String(ref?.kind || '')));
    groups.forEach((group) => {
      if (group === 'time') SCHEDULE_TIME_KEYS.forEach((key) => { if (Object.prototype.hasOwnProperty.call(edited, key)) merged[key] = edited[key]; });
      else if (group === 'assignment') {
        SCHEDULE_ASSIGNMENT_KEYS.forEach((key) => { if (Object.prototype.hasOwnProperty.call(edited, key)) merged[key] = edited[key]; });
        merged.resource_refs = [...crewRefs(edited), ...otherRefs(merged)];
      } else if (group === 'equipment') merged.resource_refs = [...crewRefs(merged), ...otherRefs(edited)];
      else if (group === 'lock') SCHEDULE_LOCK_KEYS.forEach((key) => { if (Object.prototype.hasOwnProperty.call(edited, key)) merged[key] = edited[key]; });
      else merged[group] = edited[group];
    });
    return merged;
  }
  /* A refused save whose change doesn't touch what someone else changed:
   * the stored copy with this window's changes on top, at the stored
   * revision. Null when both changed the same thing (or the copy the edit
   * started from is unknown) — the save is then refused. */
  function mergeStaleScheduleSave(edited = {}, error = null){
    if (!isStaleSaveError(error) || error?.deleted === true) return null;
    const current = error?.currentEvent || error?.data?.details?.current_event || null;
    if (!current?.id || String(current.id) !== String(edited?.id || '')) return null;
    // The stored copy is the base of the retry (and of a further merge if
    // yet another change lands meanwhile).
    rememberServerEvents([current]);
    const base = serverEventCopy(edited.id, scheduleEventRevision(edited));
    if (!base) return null;
    const ownGroups = scheduleEventChangeGroups(base, edited);
    const remoteGroups = scheduleEventChangeGroups(base, current);
    if (!ownGroups.length || ownGroups.some((group) => remoteGroups.includes(group))) return null;
    const merged = scheduleMergeEventChanges(current, edited, ownGroups);
    // History entries this save added go on top of the stored history.
    const baseHistory = Array.isArray(base.schedule_history) ? base.schedule_history : [];
    const editedHistory = Array.isArray(edited.schedule_history) ? edited.schedule_history : [];
    if (editedHistory.length > baseHistory.length) merged.schedule_history = [...(Array.isArray(current.schedule_history) ? current.schedule_history : []), ...editedHistory.slice(baseHistory.length)];
    merged.event_revision = scheduleEventRevision(current);
    merged.updated_at = new Date().toISOString();
    return merged;
  }
  /* A refused save shows (and caches) the stored copy right away, so the
   * next change is made on the current revision instead of being refused
   * again. */
  function adoptStaleScheduleCopy(error = null){
    if (!activeBaseProject || !isStaleSaveError(error)) return;
    const current = error?.currentEvent || error?.data?.details?.current_event || null;
    const deletedId = String(error?.data?.details?.event_id || error?.event?.id || '');
    const events = Array.isArray(activeBaseProject.events) ? [...activeBaseProject.events] : [];
    if (error?.deleted === true && deletedId) {
      activeBaseProject = { ...activeBaseProject, events:events.filter((item) => String(item.id || '') !== deletedId) };
    } else if (current?.id) {
      rememberServerEvents([current]);
      const idx = events.findIndex((item) => String(item.id || '') === String(current.id));
      if (idx >= 0) events[idx] = current;
      else events.push(current);
      activeBaseProject = { ...activeBaseProject, events };
    } else return;
    cacheActiveBaseProject();
    rememberScheduleProject(activeBaseProject);
  }
  // Stays up until dismissed (or replaced), as in the global Scheduling tab:
  // it asks the user to redo work.
  const SCHEDULE_STALE_TOAST = { tone:'warning', duration:600000 };
  function scheduleStaleErrorDeleted(error = null){
    return error?.deleted === true || error?.data?.details?.deleted === true || error?.data?.deleted === true;
  }
  // deletedBody replaces the "changes were not saved" wording when the
  // user's own action was a delete.
  function showStaleScheduleToast(error = null, body = '', deletedBody = ''){
    if (scheduleStaleErrorDeleted(error)) {
      showToast(
        (globalThis.PlatformLanguage?.text("scheduling","m_deleted_elsewhere","Deleted by someone else") ?? "Deleted by someone else"),
        deletedBody || (globalThis.PlatformLanguage?.text("scheduling","m_deleted_elsewhere_body","This item was deleted in another window, so your changes were not saved.") ?? "This item was deleted in another window, so your changes were not saved."),
        SCHEDULE_STALE_TOAST
      );
      return;
    }
    showToast(
      (globalThis.PlatformLanguage?.text("scheduling","m_changed_elsewhere","Changed by someone else") ?? "Changed by someone else"),
      body || (globalThis.PlatformLanguage?.text("scheduling","m_changed_elsewhere_body","Someone else changed this item. The latest schedule is shown — apply your change again if it is still needed.") ?? "Someone else changed this item. The latest schedule is shown — apply your change again if it is still needed."),
      SCHEDULE_STALE_TOAST
    );
  }
  // Someone else saved the item first: say so and show the stored schedule.
  function handleStaleScheduleSave(error = null, deletedBody = ''){
    showStaleScheduleToast(error, '', deletedBody);
    adoptStaleScheduleCopy(error);
    if (state.active) renderSchedulePanelPreservingScroll();
    let attempts = 0;
    const reload = async () => {
      attempts += 1;
      const refreshed = await refreshProjectFromServer({ render:true });
      if (!refreshed && scheduleEventSaveQueues.size && attempts < 12) setTimeout(reload, 400);
      else if (state.active) renderSchedulePanelPreservingScroll();
    };
    setTimeout(reload, 0);
  }

  // Saves one item. A save refused because someone else changed the item
  // (409) is retried once on top of the stored copy when the two changes
  // touch different fields; a same-field conflict is refused (the stored copy
  // is shown) and the caller reports it.
  async function saveScheduleEventRemote(orgId, project, event, config){
    const Scheduling = window.PlatformScheduling;
    let payload = event;
    let saved = null;
    for (let attempt = 0; ; attempt += 1) {
      scheduleMutationSerial += 1;
      try {
        saved = await Scheduling.saveProjectEvent(orgId, project, payload, config);
      } catch (error) {
        scheduleMutationSerial += 1;
        const merged = attempt < 2 ? mergeStaleScheduleSave(payload, error) : null;
        if (merged) {
          payload = merged;
          continue;
        }
        adoptStaleScheduleCopy(error);
        throw error;
      }
      scheduleMutationSerial += 1;
      break;
    }
    // A project this window read from the server that is gone now was
    // deleted elsewhere: say so (and show the window's lasting notice) rather
    // than trying to create it again or blaming the connection.
    if (!saved?.document && window.PlatformAPI?.projects?.baseline?.(project?.id)) {
      const stored = await window.PlatformAPI.projects.get?.(orgId, project.id).catch(() => null);
      if (stored && (stored.missing || !stored.document)) {
        try { window.dispatchEvent(new CustomEvent('fm:project:deleted', { detail:{ projectId:project.id } })); } catch (_) {}
        const error = new Error(globalThis.PlatformLanguage?.text("project-schedule","m_project_deleted_not_saved","This project was deleted by someone else, so this item was not saved.") ?? "This project was deleted by someone else, so this item was not saved.");
        error.code = 'project_deleted';
        error.deleted = true;
        error.status = 404;
        throw error;
      }
    }
    if (!saved?.document) {
      const created = window.Portal?.ProjectStore?.saveRemote ? await window.Portal.ProjectStore.saveRemote(project) : null;
      if (created) {
        activeBaseProject = { ...activeBaseProject, ...created, events: Array.isArray(activeBaseProject?.events) ? activeBaseProject.events : (created.events || []) };
        saved = await Scheduling.saveProjectEvent(orgId, activeBaseProject, payload, config);
      }
    }
    if (!saved?.document) {
      const error = new Error('The schedule could not be saved. Check your connection and try again.');
      error.status = 0;
      throw error;
    }
    rememberServerEvents([...(Array.isArray(saved.project?.events) ? saved.project.events : []), ...(saved.event ? [saved.event] : [])]);
    // Callers merge what was actually written (the merged copy after a
    // refused save), never their pre-merge edit.
    if (payload !== event) saved = { ...saved, merged:payload };
    return saved;
  }

  function scheduleProjectEvents(){
    return Array.isArray(activeBaseProject?.events) ? activeBaseProject.events : [];
  }

  // Stored items with auto-rollup groups spanning their members, for display.
  function scheduleDisplayEvents(){
    const events = scheduleProjectEvents();
    return typeof window.PlatformScheduling?.applyGroupRollups === 'function' ? window.PlatformScheduling.applyGroupRollups(events) : events;
  }

  // After items move, save their parent groups' rolled-up ranges so every
  // surface that reads stored group ranges agrees.
  async function persistGroupRollups(items = []){
    const Scheduling = window.PlatformScheduling;
    if (typeof Scheduling?.groupRollupUpdates !== 'function' || typeof Scheduling?.eventAncestorGroupIds !== 'function') return;
    const events = scheduleProjectEvents();
    const groupIds = Scheduling.eventAncestorGroupIds(events, items);
    if (!groupIds.length) return;
    for (const update of Scheduling.groupRollupUpdates(events, groupIds)) {
      const mutationVersion = beginScheduleEventSave(update.id);
      upsertLocalProjectEvent(update);
      await saveProjectEventQuiet(update, { successTitle:'', failureTitle:'Section dates not updated', broadcast:false, preserveLocalEvents:true, mutationVersion });
    }
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

  // Branch config, people and the org's projects change rarely while a project
  // window is open; re-renders reuse them for a minute instead of refetching
  // everything (and showing "Loading calendar…") on every click.
  const SCHEDULE_DATA_TTL_MS = 60000;
  let scheduleDataLoadedAt = 0;
  // The session's permission flags, as the global Scheduling tab reads them
  // (no flags known yet = allowed; the server still decides).
  function scheduleSessionHasPermission(keys = ''){
    const wanted = String(keys || '').split('|').map((key) => key.trim()).filter(Boolean);
    const permissions = window.Portal?.currentUser?.permissions;
    if (!permissions || typeof permissions !== 'object' || !Object.keys(permissions).length) return true;
    return wanted.some((key) => permissions[key] === true || (permissions['*'] === true && permissions[key] !== false));
  }
  // The org user directory is an admin list; other sessions read people from
  // the assignable-resources list instead of getting a 403 on every open.
  let scheduleUsersLoaded = false;
  let scheduleWorkforceUserEntries = [];
  async function loadScheduleUsers(config){
    const Scheduling = window.PlatformScheduling;
    if (scheduleSessionHasPermission('manage_company_users|manage_company_user_permissions|manage_users|manage_sales_users')) {
      const users = await Promise.resolve().then(() => Scheduling.listUsers(scheduleOrgId(), config)).catch(() => null);
      if (!Array.isArray(users)) return scheduleCachedUsers;
      scheduleUsersLoaded = true;
      return users;
    }
    await loadWorkforceResources();
    scheduleUsersLoaded = true;
    return scheduleWorkforceUserEntries
      .map((entry) => entry?.user && typeof entry.user === 'object'
        ? { ...entry.user, id:String(entry.user.id || entry.id || '').trim(), ...(Array.isArray(entry.role_ids) && !Array.isArray(entry.user.role_ids) ? { role_ids:entry.role_ids } : {}) }
        : { id:String(entry?.id || '').trim(), name:String(entry?.name || '').trim(), status:String(entry?.status || '').trim(), role_ids:Array.isArray(entry?.role_ids) ? entry.role_ids : [] })
      .filter((user) => user.id)
      .map((user) => (Scheduling.normalizeUser ? Scheduling.normalizeUser(user, config) : user));
  }
  async function loadScheduleData({ force = false } = {}){
    const Scheduling = window.PlatformScheduling;
    if (!force && scheduleCachedConfig && (scheduleCachedUsers.length || scheduleUsersLoaded) && Date.now() - scheduleDataLoadedAt < SCHEDULE_DATA_TTL_MS) {
      await loadWorkforceResources();
      return { config:scheduleCachedConfig, users:scheduleCachedUsers, projects:mergeScheduleActiveProject(scheduleCachedProjects) };
    }
    const config = await Scheduling.loadBranchConfig(scheduleOrgId(), scheduleBranchId());
    const users = await loadScheduleUsers(config);
    let projects;
    try {
      projects = await Scheduling.listProjects(scheduleOrgId(), config);
    } catch (error) {
      // The org's projects couldn't be read (other bookings feed the
      // availability checks): keep the last good list and say so, instead
      // of treating every crew as free. Nothing loaded yet = a real error.
      if (!scheduleCachedProjects.length) throw error;
      scheduleSourceNotice();
      scheduleCachedConfig = config;
      await loadWorkforceResources();
      return { config, users:users.length ? users : scheduleCachedUsers, projects:mergeScheduleActiveProject(scheduleCachedProjects) };
    }
    rememberScheduleData(config, users, projects);
    scheduleDataLoadedAt = Date.now();
    await loadWorkforceResources();
    return { config, users, projects:mergeScheduleActiveProject(projects) };
  }
  let scheduleSourceNoticeAt = 0;
  function scheduleSourceNotice(){
    if (Date.now() - scheduleSourceNoticeAt < 60000) return;
    scheduleSourceNoticeAt = Date.now();
    showToast("Couldn't refresh the schedule", 'Other projects’ bookings are from the last successful load, so availability may be out of date. Try again in a moment.', false);
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
    // Loaded once per window (an org without crews is loaded too, not
    // re-requested on every render); a refresh asks again.
    if (scheduleWorkforceLoaded && scheduleWorkforceTerminologyLoaded && !options.refresh) return scheduleCachedWorkResources;
    if (scheduleWorkforceLoading && !options.refresh) return scheduleWorkforceLoading;
    scheduleWorkforceLoading = loadWorkforceResourcesNow().finally(() => { scheduleWorkforceLoading = null; });
    return scheduleWorkforceLoading;
  }
  let scheduleWorkforceLoaded = false;
  let scheduleWorkforceLoading = null;
  async function loadWorkforceResourcesNow(){
    // Equipment types are an equipment-admin list; schedule viewers name
    // types from the units the resource list already carries.
    const canReadEquipmentTypes = scheduleSessionHasPermission('equipment.view|equipment.manage|equipment.service|manage_company_settings|manage_schedule');
    try {
      const [result, configurationResult, equipmentTypesResult] = await Promise.all([
        window.PlatformAPI.workforce.assignableResources(scheduleOrgId(), scheduleBranchId()),
        window.PlatformAPI.workforce.configuration?.(scheduleOrgId(), scheduleBranchId()).catch(() => ({ configuration:{} })) || Promise.resolve({ configuration:{} }),
        equipmentSchedulingEnabled() && canReadEquipmentTypes && window.EquipmentAPI?.types
          ? window.EquipmentAPI.types(scheduleOrgId()).catch(() => ({ types:scheduleCachedEquipmentTypes }))
          : Promise.resolve({ types:[] })
      ]);
      const configuration = configurationResult?.configuration || configurationResult?.settings || configurationResult || {};
      scheduleWorkforceTerminology = configuration.terminology || scheduleWorkforceTerminology;
      scheduleWorkforceTerminologyLoaded = true;
      scheduleWorkforceLoaded = true;
      scheduleWorkforceUserEntries = Array.isArray(result?.users) ? result.users : scheduleWorkforceUserEntries;
      const resources = Array.isArray(result?.resources) ? result.resources : (Array.isArray(result?.assignable_resources) ? result.assignable_resources : []);
      scheduleCachedEquipmentUnits = Array.isArray(result?.equipment_units) ? result.equipment_units : [];
      scheduleCachedEquipmentTypes = Array.isArray(equipmentTypesResult?.types) && equipmentTypesResult.types.length ? equipmentTypesResult.types : scheduleCachedEquipmentTypes;
      if (!scheduleCachedEquipmentTypes.length && scheduleCachedEquipmentUnits.length) {
        const seenTypes = new Map();
        scheduleCachedEquipmentUnits.forEach((unit) => {
          const id = String(unit?.type_id || unit?.equipment_type_id || '').trim();
          if (id && !seenTypes.has(id)) seenTypes.set(id, { id, name:String(unit?.type_name || unit?.equipment_type_name || id).trim() });
        });
        scheduleCachedEquipmentTypes = [...seenTypes.values()];
      }
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
      else {
        // Not permitted: asking again on every render only repeats the 403.
        scheduleWorkforceLoaded = true;
        scheduleWorkforceTerminologyLoaded = true;
      }
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

  // The Overview pill: the earliest appointment still on the calendar (a
  // cancelled or unscheduled one is never shown as the appointment).
  function currentProjectSalesAppointment(){
    return projectSalesAppointmentEvents()
      .filter(materialEventIsScheduled)
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
  // The company's equipment conflict mode ('block' | 'warn' | 'off'), read
  // once per window; the server treats a missing setting as 'warn'.
  async function loadEquipmentConflictMode(){
    if (scheduleEquipmentConflictMode !== null) return scheduleEquipmentConflictMode;
    try {
      const result = window.EquipmentAPI?.settings ? await window.EquipmentAPI.settings(scheduleOrgId()) : null;
      scheduleEquipmentConflictMode = String(result?.settings?.conflict_mode || result?.conflict_mode || '').trim() || 'warn';
    } catch (_) {
      scheduleEquipmentConflictMode = 'warn';
    }
    return scheduleEquipmentConflictMode;
  }
  /* Why a unit can't simply be booked in a window, from the server's
   * availability report — worded as in the global editor's equipment picker
   * ("Down until Oct 3", "Reserved until …", "Booked: … (until …)"). In
   * 'block' mode the server refuses these bookings, so they are marked
   * Unavailable. */
  function equipmentAvailabilityNote(report = {}, conflictMode = 'warn'){
    const name = String(report.name || report.id || 'This unit').trim();
    const unit = scheduleCachedEquipmentUnits.find((item) => String(item.id || '') === String(report.id || '')) || {};
    const type = scheduleCachedEquipmentTypes.find((item) => String(item.id || '') === String(report.type_id || unit.type_id || ''));
    const bookings = Array.isArray(report.bookings) ? report.bookings : [];
    const status = String(report.status || '').trim().toLowerCase();
    const endOf = (booking) => { const date = new Date(booking?.end_at || ''); return Number.isFinite(date.getTime()) ? date : null; };
    const maintenance = bookings.find((booking) => String(booking?.kind || '') === 'equipment_maintenance');
    if (status === 'retired') return { label:'Retired', reason:`${name} is retired and can't be booked.`, blocked:true, down:true };
    if (maintenance || (status === 'down' && report.available === false && !bookings.length)) {
      const until = maintenance && endOf(maintenance) ? endOf(maintenance).toLocaleDateString([], { month:'short', day:'numeric' }) : '';
      return {
        label:until ? `Down until ${until}` : 'Down for service',
        reason:until ? `${name} is down for service until ${until}, during this item.` : `${name} is down for service.`,
        blocked:conflictMode === 'block',
        down:true
      };
    }
    if (!bookings.length || type?.allow_double_booking === true) return null;
    const booking = bookings.find((item) => ['equipment_reservation', 'equipment_booking'].includes(String(item?.kind || ''))) || bookings[0];
    const end = endOf(booking);
    // A booking ending at midnight is a whole-day one: name its last day.
    const endsAtMidnight = !!end && end.getHours() === 0 && end.getMinutes() === 0;
    const until = end
      ? (endsAtMidnight ? new Date(end.getTime() - 1).toLocaleDateString([], { month:'short', day:'numeric' }) : end.toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }))
      : '';
    const title = String(booking?.title || booking?.project_title || '').trim();
    const reserved = ['equipment_reservation', 'equipment_booking'].includes(String(booking?.kind || ''));
    const label = reserved
      ? (until ? `Reserved until ${until}` : 'Reserved')
      : (title ? `Booked: ${title}${until ? ` (until ${until})` : ''}` : 'Booked elsewhere in this window');
    const reason = reserved
      ? `${name} is reserved${until ? ` until ${until}` : ''}, during this item.`
      : (title ? `${name} is already booked on “${title}”${until ? ` until ${until}` : ''}.` : `${name} is already booked during this window.`);
    return { label, reason, blocked:conflictMode === 'block', down:false };
  }
  // A refused save's equipment conflicts, named unit by unit (as the global
  // editor words them).
  function equipmentConflictSaveText(conflicts = []){
    // Whole-day bookings read as dates, not "12:00 AM".
    const when = (item = {}) => {
      const date = new Date(item?.start_at || '');
      if (!Number.isFinite(date.getTime())) return '';
      return date.getHours() === 0 && date.getMinutes() === 0
        ? date.toLocaleDateString([], { month:'short', day:'numeric' })
        : date.toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    };
    return conflicts.map((conflict) => {
      const booked = (Array.isArray(conflict?.events) ? conflict.events : []).slice(0, 2)
        .map((item) => [String(item?.title || item?.project_title || '').trim(), when(item)].filter(Boolean).join(' · '))
        .filter(Boolean);
      return [String(conflict?.message || '').trim() || `${String(conflict?.ref_name || 'Equipment').trim()} is not available.`, booked.length ? `Booked: ${booked.join('; ')}.` : ''].filter(Boolean).join(' ');
    }).join(' ');
  }

  function projectWorkEvents(){
    return scheduleDisplayEvents()
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
    if (type !== 'material' && isProjectWorkEvent(event) && !isMaterialDeliveryEvent(event)) return (globalThis.PlatformLanguage?.text("project-schedule","m_c2e6380e130020","Production") ?? "Production");
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

  function scheduleEventIsGroup(event = {}){
    return window.PlatformScheduling?.eventIsGroup?.(event) === true || event.is_schedule_group === true;
  }

  // Production items listed in the sidebar and placeable on the calendar:
  // generated scope resources (labor, equipment, deliveries) plus the
  // project's own production work items. Schedule groups roll up their
  // members and are managed in the Timeline.
  function projectProductionEvents(){
    const Scheduling = window.PlatformScheduling;
    const resourceIds = new Set(projectMaterialEvents().map((event) => String(event.id || '')));
    const workItems = scheduleProjectEvents()
      // Recurring occurrences are managed from their series under Recurring.
      .filter((event) => isProjectWorkEvent(event) && !scheduleEventIsGroup(event) && !String(event.recurrence_series_id || '').trim() && !resourceIds.has(String(event.id || '')))
      .map((event) => {
        const start = materialEventIsScheduled(event) ? (Scheduling?.eventStart?.(event) || null) : null;
        const end = start ? (Scheduling?.eventEnd?.(event) || new Date(start.getTime() + 60 * 60000)) : null;
        return { ...event, __start: start, __end: end };
      });
    return [...projectMaterialEvents(), ...workItems]
      .sort((a, b) => (a.__start?.getTime?.() ?? Number.MAX_SAFE_INTEGER) - (b.__start?.getTime?.() ?? Number.MAX_SAFE_INTEGER));
  }

  function selectedMaterialEvent(){
    const byId = materialScheduleEventId
      ? projectProductionEvents().find((event) => String(event.id || '') === String(materialScheduleEventId))
      : null;
    if (byId) return byId;
    return materialScheduleListId
      ? projectMaterialEvents().find((event) => String(event.scope_resource_list_id || event.material_list_id || event.materialListId || '') === String(materialScheduleListId)) || null
      : null;
  }

  function focusMaterialDelivery(payload = {}){
    const eventId = String(payload.event_id || payload.eventId || '').trim();
    const listId = String(payload.scope_resource_list_id || payload.material_list_id || payload.materialListId || '').trim();
    const event = (eventId ? projectProductionEvents().find((item) => String(item.id || '') === eventId) : null)
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

  function scheduleDayStart(value){
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date;
  }
  /* Where a waiting item lands when it is placed by one click (a day in
   * Month or the all-day band, a time slot, a Timeline lane day), as in the
   * global Scheduling tab: the item keeps its own planned length and nature.
   * All-day work gets its planned number of days; timed work keeps the
   * clicked time (a day click starts it at its usual time or the start of
   * the working day) with its own duration. Its duration_minutes is never
   * rewritten from the clicked cell. */
  function schedulePlacementNaturalRange(source = {}, next = {}){
    const Scheduling = window.PlatformScheduling;
    const start = new Date(next?.start);
    if (!source?.id || !Number.isFinite(start.getTime())) return next;
    const clickedAllDay = next.all_day !== false && String(next.schedule_granularity || '').toLowerCase() !== 'time';
    let interpreted = null;
    if (typeof Scheduling?.interpretScheduleBundle === 'function') {
      try { interpreted = Scheduling.interpretScheduleBundle(source, [source], scheduleDayStart(start), activeBaseProject || {}, [], { config:scheduleCachedConfig || null })?.[0] || null; } catch (_) { interpreted = null; }
    }
    const interpretedStart = interpreted?.start ? new Date(interpreted.start) : null;
    const interpretedEnd = interpreted?.end ? new Date(interpreted.end) : null;
    const validInterpreted = interpretedStart && interpretedEnd && Number.isFinite(interpretedStart.getTime()) && Number.isFinite(interpretedEnd.getTime()) && interpretedEnd > interpretedStart;
    const sourceTimed = source.all_day === false || String(source.schedule_granularity || '').toLowerCase() === 'time';
    const naturalAllDay = validInterpreted ? interpreted.all_day !== false : !sourceTimed;
    const sourceMinutes = Number(source.duration_minutes || 0);
    const durationMs = validInterpreted
      ? interpretedEnd.getTime() - interpretedStart.getTime()
      : (sourceMinutes > 0 ? sourceMinutes * 60000 : (naturalAllDay ? 86400000 : 60 * 60000));
    if (naturalAllDay) {
      const day = scheduleDayStart(start);
      return { ...next, start:day, end:scheduleAddDays(day, Math.max(1, Math.round(durationMs / 86400000))), all_day:true, schedule_granularity:'date' };
    }
    let timedStart = start;
    if (clickedAllDay) {
      // A timed item that already has a time of day keeps it on the new day.
      const ownStart = sourceTimed && materialEventIsScheduled(source) ? Scheduling?.eventStart?.(source) : null;
      timedStart = scheduleDayStart(start);
      if (ownStart) timedStart.setHours(ownStart.getHours(), ownStart.getMinutes(), 0, 0);
      else if (validInterpreted && scheduleLocalDate(interpretedStart) === scheduleLocalDate(start)) timedStart = new Date(interpretedStart);
      else {
        const workWindow = Scheduling?.availabilityWindow?.(scheduleCachedConfig || {}, scheduleLocalDate(start), 'project_work') || null;
        const [hour, minute] = String(workWindow?.start || '08:00').split(':').map((part) => Number(part) || 0);
        timedStart.setHours(hour, minute, 0, 0);
      }
    }
    return { ...next, start:timedStart, end:new Date(timedStart.getTime() + durationMs), all_day:false, schedule_granularity:'time' };
  }

  function setMaterialScheduleDraft(next = null){
    const event = selectedMaterialEvent();
    // A fresh click on the calendar (not a drag of the placed draft) lands
    // the item with its own planned length.
    const clicked = next;
    if (next?.__schedule_natural_range && event && next.start) next = schedulePlacementNaturalRange(event, next);
    if (next) delete next.__schedule_natural_range;
    if (clicked) delete clicked.__schedule_natural_range;
    // The calendar drew the clicked cell; show the item's real span instead.
    const reshaped = next !== clicked && !!next?.start
      && (new Date(next.start).getTime() !== new Date(clicked.start).getTime() || new Date(next.end).getTime() !== new Date(clicked.end || 0).getTime() || (next.all_day !== false) !== (clicked.all_day !== false));
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
    // Redrawn once the calendar's own pointer handler has finished.
    if (reshaped) queueMicrotask(() => { if (state.active && materialScheduleDraft?.start) renderSchedulePanelPreservingScroll(); });
    else renderScheduleLeft();
  }

  async function persistMaterialScheduleEvent(event){
    const Scheduling = window.PlatformScheduling;
    const project = await ensureRemoteSchedulingProject();
    if (!Scheduling || !project?.id || !event?.id) return null;
    const saved = await saveScheduleEventRemote(scheduleOrgId(), project, event, scheduleCachedConfig || null);
    activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project?.events || activeBaseProject?.events || [] };
    cacheActiveBaseProject();
    rememberScheduleProject(activeBaseProject);
    window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
    window.dispatchEvent(new CustomEvent('fm:projects:refresh'));
    return saved;
  }

  async function saveMaterialScheduleDraft(next = materialScheduleDraft){
    if (!requireScheduleEdit()) return null;
    const Scheduling = window.PlatformScheduling;
    const event = selectedMaterialEvent();
    if (!Scheduling || !event?.id || !next?.start) return;
    if (materialEventIsLocked(event)) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_88e13d64071885","Schedule locked") ?? "Schedule locked"), (globalThis.PlatformLanguage?.text("project-schedule","m_2896561e271b21","Unlock this delivery before rescheduling it.") ?? "Unlock this delivery before rescheduling it."), false);
      return;
    }
    if (schedulePlacementSaving || schedulePlacementBusy) return;
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
    // Busy (not "Saving…") while the past-day and linked-item questions are
    // open; the banner says Saving only once the save itself runs.
    schedulePlacementBusy = true;
    try {
      if (!(await confirmPastPlacement(event, start))) return;
      const related = await resolveProjectRelatedReschedule(event, { start, end }, { verb:materialEventIsScheduled(event) ? 'Moving' : 'Scheduling' });
      if (related.cancelled) return;
      setSchedulePlacementSaving(true);
      await persistMaterialScheduleEvent(updated);
      // The item is placed: leave placement and show it (and the linked
      // items' new dates) right away; the linked saves continue behind it.
      materialScheduleDraft = null;
      materialScheduleModeActive = false;
      materialScheduleEventId = '';
      materialScheduleListId = '';
      scheduleAnchorDate = start;
      setSchedulePlacementSaving(false);
      showRelatedChangesLocally(related);
      renderSchedulePanel();
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_165bc3ab3937ae","Production scheduled") ?? "Production scheduled"), `${((v0) => globalThis.PlatformLanguage?.text("project-schedule","m_d30ad66a8eab41",`${v0} was placed on the project schedule.`,{v0}) ?? `${v0} was placed on the project schedule.`)(event.title || productionResourceLabel(event))}${relatedMoveNote(related)}`, true);
      await saveRelatedRescheduleChanges(related);
      await persistGroupRollups([updated, ...related.changes]);
      renderSchedulePanelPreservingScroll();
    } catch (error) {
      if (isStaleSaveError(error)) handleStaleScheduleSave(error);
      else showToast((globalThis.PlatformLanguage?.text("project-schedule","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), error?.message || 'Could not schedule this production item.', false);
    } finally {
      schedulePlacementBusy = false;
      setSchedulePlacementSaving(false);
    }
  }

  /* ── Placement (Sales + New, a selected sidebar item, a work draft) ─────
   * A banner names what is being placed with a Cancel (Esc); Escape cancels
   * the placement instead of closing the project window. */
  let schedulePlacementSaving = false;
  // A placement confirm is running (its questions may be open): a second ✓
  // is ignored, but nothing says "Saving…" until the save starts.
  let schedulePlacementBusy = false;
  let schedulePlacementReturn = null;
  function setSchedulePlacementSaving(saving){
    schedulePlacementSaving = !!saving;
    const panel = $('#rSchedulePanel');
    panel?.classList.toggle('r-schedule-saving', schedulePlacementSaving);
    panel?.querySelectorAll('[data-schedule-placement-state]').forEach((node) => {
      node.textContent = schedulePlacementSaving ? 'Saving…' : '';
    });
  }
  function scheduleIsPastDay(value){
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date < today;
  }
  // Placing an item on a day that has already passed is allowed (catching
  // up records) but never silent.
  // Same wording as the global Scheduling tab.
  // Enter keeps the safe answer (another date / Cancel); going ahead takes a
  // deliberate click.
  async function confirmPastPlacement(event = {}, start, { move = false } = {}){
    if (!scheduleIsPastDay(start)) return true;
    const day = new Date(start).toLocaleDateString([], { weekday:'long', month:'short', day:'numeric' });
    const label = `“${scheduleEventDisplayTitle(event) || 'This item'}”`;
    return !!(await scheduleConfirmUi(move
      ? `${label} would move to ${day}, which is in the past. Move it anyway?`
      : `${label} would be placed on ${day}, which is in the past. Place it anyway?`, move
      ? { title:'Move into the past?', okLabel:'Move anyway', cancelLabel:(globalThis.PlatformLanguage?.text("scheduling","m_cbef679b21abb4","Cancel") ?? "Cancel"), defaultFocus:'cancel' }
      : { title:'Place in the past?', okLabel:'Place anyway', cancelLabel:'Choose another date', defaultFocus:'cancel' }));
  }
  // A move of a placed item onto a day that has passed asks first (a move
  // within the same day, e.g. a resize, never does).
  async function confirmPastMove(source = {}, start){
    if (!materialEventIsScheduled(source) || !scheduleIsPastDay(start)) return true;
    const before = window.PlatformScheduling?.eventStart?.(source);
    if (before && scheduleLocalDate(before) === scheduleLocalDate(new Date(start))) return true;
    return confirmPastPlacement(source, start, { move:true });
  }
  // Touch screens tap; a mouse clicks. Phones have no Escape key to mention.
  // By the pointer, not the width: a narrow floating or docked window on a
  // desktop still has a mouse and an Escape key.
  function scheduleTouchLayout(){
    return window.matchMedia?.('(pointer:coarse)').matches === true;
  }
  // Phone calendars place on touch-and-hold (a plain tap scrolls and
  // swipes), so the banner says so.
  function schedulePointerVerb(){
    if (!scheduleTouchLayout()) return 'Click';
    return window.matchMedia?.('(max-width:720px)').matches === true ? 'Touch and hold' : 'Tap';
  }
  function schedulePlacementState(){
    if (scheduleModeActive) {
      const existing = projectSalesAppointmentEvents().find((item) => String(item.id || '') === String(scheduleAssignmentEventId || scheduleSelectedEventId || ''));
      const subject = existing ? scheduleEventDisplayTitle(existing) : 'a new sales appointment';
      return {
        subject,
        text:scheduleDraft?.start
          ? `${scheduleDraft.label || 'Time chosen'}${scheduleDraft.userLabel ? ` with ${scheduleDraft.userLabel}` : ''}. Confirm it with ✓, or pick another time.`
          : `${schedulePointerVerb()} an open time on the calendar.`,
        past:scheduleDraft?.start && scheduleIsPastDay(scheduleDraft.start)
      };
    }
    const workDraft = workScheduleModeActive ? activeWorkDraft() : null;
    if (workDraft) {
      return {
        subject:workDraft.title || 'new work',
        text:workDraft.start ? `${workRangeLabel({ ...workDraft, __start:new Date(workDraft.start), __end:new Date(workDraft.end) })}. Confirm it with ✓, or place it somewhere else.` : `${schedulePointerVerb()} a day or time on the calendar.`,
        past:workDraft.start && scheduleIsPastDay(workDraft.start)
      };
    }
    if (materialScheduleModeActive) {
      const event = selectedMaterialEvent();
      if (!event) return null;
      const scheduled = materialEventIsScheduled(event);
      return {
        subject:isMaterialDeliveryEvent(event) ? `${materialDeliveryTitle(event)} delivery` : (event.title || productionResourceLabel(event)),
        text:materialScheduleDraft?.start
          ? 'Review the date on the calendar and confirm it with ✓.'
          : (scheduled ? 'Drag it on the calendar to reschedule it.' : (scheduleViewMode === 'gantt' ? 'Drag it from the unscheduled row onto the timeline.' : `${schedulePointerVerb()} a day on the calendar.`)),
        past:materialScheduleDraft?.start && scheduleIsPastDay(materialScheduleDraft.start)
      };
    }
    return null;
  }
  function schedulePlacementActive(){
    return !!schedulePlacementState();
  }
  function schedulePlacementBannerHtml(){
    const placement = schedulePlacementState();
    if (!placement || !canEditSchedule()) return '';
    return `<div class="r-schedule-placement-banner" role="status"><i class="fas fa-location-crosshairs" aria-hidden="true"></i><span><strong>Placing ${escapeHtml(placement.subject)}</strong> — ${escapeHtml(placement.text)}${placement.past ? '<span class="warn">That day is in the past.</span>' : ''} <em data-schedule-placement-state>${schedulePlacementSaving ? 'Saving…' : ''}</em></span><button type="button" class="r-schedule-placement-cancel" data-schedule-placement-cancel>Cancel${scheduleTouchLayout() ? '' : ' <kbd>(Esc)</kbd>'}</button></div>`;
  }
  function refreshSchedulePlacementBanner(){
    const panel = $('#rSchedulePanel');
    if (!panel || !state.active) return;
    const current = panel.querySelector('.r-schedule-placement-banner');
    const html = schedulePlacementBannerHtml();
    if (!current && !html) return;
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const next = holder.firstElementChild;
    if (current && next) current.replaceWith(next);
    else if (current) current.remove();
    else panel.querySelector('.r-schedule-calendar')?.before(next);
    bindSchedulePlacementBanner(panel);
  }
  function bindSchedulePlacementBanner(rootEl){
    rootEl?.querySelector('[data-schedule-placement-cancel]')?.addEventListener('click', (event) => {
      event.preventDefault();
      cancelSchedulePlacement();
    });
  }
  function cancelSchedulePlacement(){
    if (scheduleModeActive || scheduleDraft || scheduleAssignmentEventId || scheduleSelectedEventId) {
      scheduleModeActive = false;
      scheduleDraft = null;
      scheduleAssignmentEventId = '';
      scheduleSelectedEventId = '';
      // Sales + New returns to the view it started from.
      if (schedulePlacementReturn) {
        scheduleViewMode = schedulePlacementReturn.view;
        scheduleSchedulingTarget = schedulePlacementReturn.target;
        scheduleAnchorDate = schedulePlacementReturn.date;
      }
      schedulePlacementReturn = null;
      updateScheduleChoiceCard();
    }
    if (workScheduleModeActive) {
      const id = activeWorkScheduleDraftId;
      if (id) workScheduleDrafts.delete(String(id));
      setActiveWorkDraftId(lastWorkDraft()?.id || '');
    }
    if (materialScheduleModeActive) {
      materialScheduleModeActive = false;
      materialScheduleEventId = '';
      materialScheduleListId = '';
      materialScheduleDraft = null;
    }
    renderSchedulePanelPreservingScroll();
  }
  // Switching to another sidebar item while a placed-but-unconfirmed draft
  // exists asks before dropping it.
  async function confirmDiscardPlacementDraft(nextEventId = ''){
    const material = materialScheduleModeActive && materialScheduleDraft?.start && String(materialScheduleEventId || '') !== String(nextEventId || '') ? selectedMaterialEvent() : null;
    const work = !material && workScheduleModeActive ? activeWorkDraft() : null;
    const pending = material || (work?.start ? work : null);
    if (!pending) return true;
    const title = material ? (isMaterialDeliveryEvent(material) ? `${materialDeliveryTitle(material)} delivery` : material.title) : pending.title;
    const approved = await scheduleConfirmUi(`“${title || 'This item'}” has a date placed on the calendar that isn't confirmed yet. Discard it?`, { title:'Discard placement', okLabel:'Discard', cancelLabel:'Keep placing', defaultFocus:'cancel' });
    if (!approved) return false;
    if (material) materialScheduleDraft = null;
    if (work) {
      workScheduleDrafts.delete(String(work.id || ''));
      setActiveWorkDraftId(lastWorkDraft()?.id || '');
    }
    return true;
  }

  async function saveMaterialScheduleRange(event, range, options = {}){
    if (!requireScheduleEdit()) return null;
    const Scheduling = window.PlatformScheduling;
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(event?.id || '')) || event;
    if (!Scheduling || !source?.id) return null;
    if (materialEventIsLocked(source)) {
      renderSchedulePanelPreservingScroll();
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_a1c7a5d9f83613","Delivery locked") ?? "Delivery locked"), (globalThis.PlatformLanguage?.text("project-schedule","m_6bf220dddda83e","Unlock this ordered delivery before moving it.") ?? "Unlock this ordered delivery before moving it."), false);
      return null;
    }
    const next = {
      ...Scheduling.updateProjectEventRange(source, range),
      status: 'scheduled',
      updated_at: new Date().toISOString()
    };
    if (!options.skipRelated && !options.pastConfirmed && !(await confirmPastMove(source, next.start_at))) {
      renderSchedulePanelPreservingScroll();
      return null;
    }
    // Linked items are settled before anything is saved.
    const related = options.skipRelated ? null : await resolveProjectRelatedReschedule(source, { start:next.start_at, end:next.end_at });
    if (related?.cancelled) {
      renderSchedulePanelPreservingScroll();
      return null;
    }
    const mutationVersion = beginScheduleEventSave(next.id);
    upsertLocalProjectEvent(next);
    if (!options.skipRelated) renderSchedulePanelPreservingScroll();
    const saved = await saveProjectEventQuiet(next, {
      successTitle: options.quiet ? '' : 'Delivery updated',
      successMessage: `The material delivery schedule was saved.${relatedMoveNote(related)}`,
      failureTitle: 'Scheduling failed',
      broadcast: false,
      preserveLocalEvents: true,
      mutationVersion
    });
    if (!saved) {
      if (scheduleEventSaveVersions.get(String(next.id || '')) === mutationVersion) {
        upsertLocalProjectEvent(source);
        renderSchedulePanelPreservingScroll();
      }
      return null;
    }
    saved.related = related;
    options.afterSave?.(saved, related);
    await saveRelatedRescheduleChanges(related);
    await persistGroupRollups([next, ...(related?.changes || [])]);
    if (!options.skipRelated) renderSchedulePanelPreservingScroll();
    return saved;
  }

  async function toggleMaterialScheduleLock(event, requestedLocked = null){
    if (!requireScheduleEdit()) return null;
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

  async function toggleWorkScheduleLock(event, requestedLocked = null){
    if (!requireScheduleEdit()) return null;
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(event?.id || '')) || event;
    if (!source?.id) return;
    const locked = materialEventIsLocked(source);
    const nextLocked = typeof requestedLocked === 'boolean' ? requestedLocked : !locked;
    if (nextLocked === locked) return;
    const now = new Date().toISOString();
    const next = {
      ...source,
      locked: nextLocked,
      schedule_locked: nextLocked,
      schedule_lock: {
        ...(source.schedule_lock || {}),
        locked: nextLocked,
        reason: source.schedule_lock?.reason || 'manual',
        locked_at: nextLocked ? now : '',
        unlocked_at: nextLocked ? '' : now
      },
      unlock_confirmed: locked && !nextLocked,
      updated_at: now
    };
    const mutationVersion = beginScheduleEventSave(next.id);
    upsertLocalProjectEvent(next);
    renderSchedulePanelPreservingScroll();
    const saved = await saveProjectEventQuiet(next, {
      successTitle: nextLocked ? 'Date locked' : 'Date unlocked',
      successMessage: nextLocked ? `${scheduleEventDisplayTitle(next)} can no longer be moved until it is unlocked.` : `${scheduleEventDisplayTitle(next)} can be moved again.`,
      failureTitle: 'Lock update failed',
      broadcast: false,
      preserveLocalEvents: true,
      mutationVersion
    });
    if (!saved) {
      upsertLocalProjectEvent(source);
      renderSchedulePanelPreservingScroll();
    }
  }

  function allProjectWorkEvents(){
    const Scheduling = window.PlatformScheduling;
    const projects = mergeScheduleActiveProject(scheduleCachedProjects);
    const projectById = new Map(projects.map((project) => [String(project.id || ''), project]));
    const rawEvents = Scheduling?.eventsFromProjects?.(projects, scheduleCachedConfig || null) || [];
    return rawEvents
      .filter(isProjectWorkEvent)
      // Groups roll up their members; Routing rows hold the members themselves.
      .filter((event) => !scheduleEventIsGroup(event))
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

  /* ── Several work assignees (crews, subcontractors, people) ─────────────
   * resource_refs holds every crew-role assignee; work_resource_ref and its
   * legacy mirrors name only the primary (the first). A two-crew item keeps
   * both crews whichever surface edits it. */
  const EQUIPMENT_REF_KINDS = ['equipment_unit', 'equipment_type'];
  function workRefKind(kind){
    const value = String(kind || '').trim().toLowerCase();
    return ({ crew:'resource_group', team:'resource_group', person:'organization_user', user:'organization_user', subcontractor:'organization_connection' })[value] || value;
  }
  function workResourceName(id = ''){
    const key = String(id || '');
    const resource = scheduleCachedWorkResources.find((item) => String(item.id || '') === key);
    if (resource?.name) return String(resource.name);
    const user = scheduleCachedUsers.find((item) => String(item?.id || '') === key);
    return String(user?.name || user?.email || '').trim();
  }
  function eventWorkAssignees(event = {}){
    const Scheduling = window.PlatformScheduling;
    if (typeof Scheduling?.eventWorkAssignees === 'function') {
      try {
        // -> { crews:[{kind,id,name}], people:[{id,name}] }
        const shared = Scheduling.eventWorkAssignees(event);
        if (shared && (Array.isArray(shared.crews) || Array.isArray(shared.people))) {
          const primaryId = workCrewId(event);
          const list = [
            ...(Array.isArray(shared.crews) ? shared.crews : []).map((ref) => ({ kind:workRefKind(ref?.kind) || 'resource_group', id:String(ref?.id || '').trim(), name:String(ref?.name || '').trim() })),
            ...(Array.isArray(shared.people) ? shared.people : []).map((ref) => ({ kind:'organization_user', id:String(ref?.id || '').trim(), name:String(ref?.name || '').trim() }))
          ].filter((ref, index, all) => ref.id && ref.id !== String(event?.id || '') && all.findIndex((other) => other.id === ref.id) === index);
          // The primary (first) assignee leads.
          list.sort((a, b) => (b.id === primaryId) - (a.id === primaryId));
          return list.map((ref) => ({ ...ref, name:ref.name || workResourceName(ref.id) || ref.id }));
        }
      } catch (_) {}
    }
    const eventId = String(event?.id || '');
    const list = [];
    const add = (ref = {}) => {
      const id = String(ref?.id || '').trim();
      const kind = workRefKind(ref?.kind) || 'resource_group';
      if (!id || id === eventId || EQUIPMENT_REF_KINDS.includes(kind) || list.some((item) => item.id === id)) return;
      list.push({ kind, id, name:String(ref?.name || '').trim() });
    };
    const primaryId = workCrewId(event);
    if (primaryId) add({ kind:workResourceKind(event) || 'resource_group', id:primaryId, name:workCrewName(event) });
    (Array.isArray(event?.resource_refs) ? event.resource_refs : []).forEach((ref) => add(ref));
    (Array.isArray(event?.assigned_user_ids) ? event.assigned_user_ids : []).forEach((id) => add({
      kind:'organization_user',
      id,
      name:(Array.isArray(event?.assigned_users) ? event.assigned_users : []).find((user) => String(user?.id || '') === String(id))?.name || ''
    }));
    return list.map((ref) => ({ ...ref, name:ref.name || workResourceName(ref.id) || ref.id }));
  }
  function workAssigneesLabel(list = []){
    if (!list.length) return '';
    return list.length === 1 ? list[0].name : `${list[0].name} +${list.length - 1}`;
  }
  // The save payload for an explicit assignee list: primary mirrors for the
  // first crew (or person) plus the full crew-role list in resource_refs.
  function workAssigneesPayload(event = {}, assignees = []){
    const list = [];
    assignees.forEach((ref) => {
      const id = String(ref?.id || '').trim();
      if (id && !list.some((item) => item.id === id)) list.push({ kind:workRefKind(ref.kind) || 'resource_group', id, name:String(ref.name || '').trim() || workResourceName(id) || id });
    });
    const resources = workAssignmentResources(event);
    const subjects = list.map((ref) => {
      const known = resources.find((resource) => String(resource.id || '') === ref.id);
      return known || { id:ref.id, name:ref.name, subject_type:ref.kind, resource_kind:ref.kind };
    });
    const Scheduling = window.PlatformScheduling;
    if (typeof Scheduling?.assigneeSetPayload === 'function') {
      // Shared writer: crews in resource_refs (first = primary, mirrored in
      // the singular fields), people in assigned_user_ids, equipment kept.
      const crews = list.filter((ref) => ref.kind !== 'organization_user');
      const people = subjects.filter((subject) => String(subject.subject_type || subject.resource_kind) === 'organization_user').map((subject) => ({ id:subject.id, name:subject.name || subject.email || subject.id, role_ids:subject.role_ids || subject.roles || [] }));
      return { ...Scheduling.assigneeSetPayload(event, { crews, people }), crew_label:workAssigneesLabel(list) || 'Unassigned', awaiting_crew:false };
    }
    const base = subjects.length ? assignmentPayloadForSubjects(subjects) : crewPayloadForSelection('', resources);
    const equipment = (Array.isArray(event?.resource_refs) ? event.resource_refs : []).filter((ref) => EQUIPMENT_REF_KINDS.includes(workRefKind(ref?.kind)));
    return {
      ...base,
      crew_label:workAssigneesLabel(list) || 'Unassigned',
      assignee_label:list.map((ref) => ref.name).filter(Boolean).join(', ') || 'Unassigned',
      resource_refs:[...list.map((ref) => ({ kind:ref.kind, id:ref.id, name:ref.name, role:'crew' })), ...equipment]
    };
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
    document.querySelectorAll('.r-schedule-event-popover').forEach((node) => {
      node.__resizeObserver?.disconnect?.();
      node.remove();
    });
  }

  /* Keyboard focus back on an item of this schedule (looked up again: a
   * re-render replaces its element), unless something else (a dialog, a
   * field) has it. Falls back to the given element, then to Today. */
  function focusScheduleItem(eventId = '', fallback = null){
    const id = String(eventId || '');
    const find = () => {
      const panel = $('#rSchedulePanel');
      if (!panel) return null;
      const key = cssEscape(id);
      const item = id ? panel.querySelector(`[data-psv-gantt-open="${key}"],[data-psv-gantt-bar="${key}"],.prs-work-chip[data-prs-event-id="${key}"],[data-prs-event-id="${key}"],[data-production-resource-event="${key}"]`) : null;
      return item || (fallback?.isConnected ? fallback : null) || panel.querySelector('[data-schedule-anchor-nav="0"],[data-project-mobile-today]');
    };
    const focus = () => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      try { find()?.focus?.({ preventScroll:true }); } catch (_) {}
    };
    focus();
    requestAnimationFrame(focus);
  }
  // The item that takes a deleted one's place in the Timeline (the next
  // row, else the one before it).
  function scheduleNeighborFocusId(eventId = ''){
    const ids = [...($('#rSchedulePanel')?.querySelectorAll('[data-psv-gantt-open]') || [])].map((node) => String(node.dataset.psvGanttOpen || ''));
    const index = ids.indexOf(String(eventId || ''));
    if (index < 0) return '';
    return ids.slice(index + 1).find((id) => id && id !== String(eventId)) || ids.slice(0, index).reverse().find(Boolean) || '';
  }

  function schedulePopoverHost(anchor = null){
    const modalRoot = anchor?.closest?.('[data-fm-modal-id], #rOverlay, .r-overlay');
    if (modalRoot) return modalRoot;
    const contextRoot = state.context?.overlayRoot || state.context?.roots?.overlay || null;
    if (contextRoot instanceof Element && (!anchor || !(anchor instanceof Node) || contextRoot.contains(anchor))) return contextRoot;
    return document.body;
  }

  function scheduleEventKind(event = {}){
    if (isMaterialDeliveryEvent(event)) return { label:(globalThis.PlatformLanguage?.text("project-schedule","m_b73185deef6d79","Delivery") ?? "Delivery"), icon:'fa-truck-ramp-box' };
    if (isSalesAppointmentEvent(event)) return { label:(globalThis.PlatformLanguage?.text("project-schedule","m_f7eaf8f28f8161","Sales appointment") ?? "Sales appointment"), icon:'fa-calendar-check' };
    if (scheduleEventIsGroup(event)) return { label:'Section', icon:'fa-layer-group' };
    if (productionResourceType(event) === 'labor' || isProjectWorkEvent(event)) return { label:(globalThis.PlatformLanguage?.text("project-schedule","m_7acfa5ed3b7739","Labor") ?? "Labor"), icon:'fa-hammer' };
    const typeId = String(event.event_type_default_id || event.type_id || event.event_type_id || '').trim();
    const typeLabel = String(scheduleCachedConfig?.event_types?.[typeId]?.label || '').trim();
    return { label:typeLabel && typeId !== 'custom' ? typeLabel : (globalThis.PlatformLanguage?.text("project-schedule","m_0b0eba838f2956","Event") ?? "Event"), icon:'fa-calendar' };
  }

  function scheduleEventDisplayTitle(event = {}){
    const title = isMaterialDeliveryEvent(event)
      ? materialDeliveryTitle(event)
      : String(event.title || event.project_title || 'Scheduled event').trim();
    return title || 'Scheduled event';
  }

  // Every crew/person on the item as a removable chip, plus an Add menu of
  // the remaining eligible resources (a crew is one unit, never expanded).
  function scheduleEventAssignmentField(event = {}){
    if (productionResourceType(event) !== 'labor' && !isProjectWorkEvent(event)) return '';
    const assigned = eventWorkAssignees(event);
    const assignedIds = new Set(assigned.map((ref) => ref.id));
    const ready = scheduleResourcesReady();
    const resources = workAssignmentResources(event).filter((resource) => !assignedIds.has(String(resource.id || '')));
    const label = `${workforceTerm('resource_group', 'plural')} / people`;
    const chips = assigned.length
      ? assigned.map((ref) => `<span class="r-schedule-assignee-chip"><span>${escapeHtml(ref.name || ref.id)}</span><button type="button" data-schedule-assignee-remove="${escapeHtml(ref.id)}" aria-label="${escapeHtml(`Remove ${ref.name || 'assignee'}`)}" title="${escapeHtml(`Remove ${ref.name || 'assignee'}`)}"><i class="fas fa-xmark"></i></button></span>`).join('')
      : `<span class="r-schedule-assignee-empty">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_8a993ed9b573b4","Unassigned") ?? "Unassigned")}</span>`;
    const options = ready
      ? `<option value="">${escapeHtml(assigned.length ? '+ Add another…' : '+ Assign…')}</option>${resources.map((resource) => `<option value="${escapeHtml(resource.id || '')}">${escapeHtml(resource.name || resource.id || '')}</option>`).join('')}`
      : `<option value="">${escapeHtml(`Loading ${workforceTerm('resource_group', 'plural').toLowerCase()}…`)}</option>`;
    return `<div class="r-schedule-event-popover-field r-schedule-assignees" data-schedule-event-crew="${escapeHtml(event.id || '')}">${escapeHtml(label)}<div class="r-schedule-assignee-chips">${chips}</div><select data-schedule-assignee-add aria-label="${escapeHtml(`Add a ${workforceTerm('resource_group').toLowerCase()} or person`)}" ${ready ? '' : 'disabled aria-busy="true"'}>${options}</select></div>`;
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

  function scheduleConfirmationBlock(event = {}, { actions:showActions = true } = {}){
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
      ? `<button type="button" class="r-schedule-confirm-action" data-schedule-confirm-set="reset">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_80ae2923b672d0","Mark unconfirmed") ?? "Mark unconfirmed")}</button>`
      : `<button type="button" class="r-schedule-confirm-action primary" data-schedule-confirm-set="confirmed">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_617e25cc0ca1b3","Mark confirmed") ?? "Mark confirmed")}</button>
         <button type="button" class="r-schedule-confirm-action" data-schedule-confirm-send>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_b495e5473c85e0","Send now") ?? "Send now")}</button>`;
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
        ${showActions ? `<div class="r-schedule-confirm-actions">${actions}</div>` : ''}
      </div>
    `;
  }

  async function applyScheduleConfirmation(event = {}, outcome = 'confirmed'){
    if (!requireScheduleEdit()) return null;
    const orgId = scheduleOrgId();
    const projectId = String(event.project_id || activeBaseProject?.id || '');
    if (!orgId || !projectId || !event.id) return;
    const client = window.PlatformAPI?.appointments;
    if (!client) return;
    try {
      if (outcome === 'send') await client.sendConfirmation(orgId, projectId, event.id);
      else await client.setConfirmation(orgId, projectId, event.id, outcome);
      // Show the new confirmation state here, then tell other surfaces.
      await refreshProjectFromServer({ render:true });
      notifyScheduleChanged();
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      const messages = {
        send:['Confirmation sent', 'The customer was asked to confirm this appointment.'],
        confirmed:['Marked confirmed', 'This appointment is confirmed.'],
        reset:['Marked unconfirmed', 'This appointment is waiting for confirmation again.']
      };
      const [title, message] = messages[outcome] || ['Confirmation updated', 'The appointment confirmation was updated.'];
      showToast(title, message, true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_cac0219c86a9cb","Confirmation update failed") ?? "Confirmation update failed"), String(error?.message || error), false);
    }
  }

  function openScheduleEventPopover(event = {}, anchor = null){
    if (!event?.id || !anchor) return;
    closeWorkAssignmentMenu();
    closeScheduleEventPopover();
    scheduleEventPopoverId = String(event.id || '');
    if (anchor instanceof Element) scheduleEventPopoverAnchor = anchor;
    const kind = scheduleEventKind(event);
    const address = event.location_mode==='none'?'':String(['company_office','custom'].includes(event.location_mode)?(event.location?.address||event.address||(event.location_mode==='company_office'?'Company office':'')):(event.project_address || activeBaseProject?.address || event.address || '')).trim();
    const deliveryStatus = isMaterialDeliveryEvent(event)
      ? `<div class="r-schedule-event-popover-row"><i class="fas fa-box"></i><span>${materialEventIsOrdered(event) ? 'Materials ordered' : 'Materials not ordered'}${materialEventIsLocked(event) ? ' · Date locked' : ''}</span></div>`
      : '';
    const confirmationBlock = scheduleConfirmationBlock(event, { actions:canEditSchedule() });
    const storedEvent = scheduleProjectEvents().find((item) => String(item.id || '') === String(event.id || '')) || event;
    const scheduled = materialEventIsScheduled(storedEvent);
    const locked = materialEventIsLocked(storedEvent);
    const canEdit = canEditSchedule();
    const assignmentField = canEdit ? scheduleEventAssignmentField(event) : '';
    const assigneeRow = !assignmentField && !isMaterialDeliveryEvent(event) && !scheduleEventIsGroup(event)
      ? `<div class="r-schedule-event-popover-row"><i class="fas fa-user"></i><span>${escapeHtml(eventAssignedLabel(storedEvent))}</span></div>`
      : '';
    const equipmentNames = (Array.isArray(storedEvent.resource_refs) ? storedEvent.resource_refs : [])
      .filter((ref) => String(ref?.kind || '') === 'equipment_unit')
      .map((ref) => String(ref.name || scheduleCachedEquipmentUnits.find((unit) => String(unit.id || '') === String(ref.id || ''))?.name || ref.id || '').trim())
      .filter(Boolean);
    const equipmentRow = equipmentSchedulingEnabled() && equipmentNames.length
      ? `<div class="r-schedule-event-popover-row"><i class="fas fa-truck-pickup"></i><span>${escapeHtml(equipmentNames.join(', '))}</span></div>`
      : '';
    const lockRow = locked && !isMaterialDeliveryEvent(event)
      ? `<div class="r-schedule-event-popover-row"><i class="fas fa-lock"></i><span>Date locked${storedEvent.schedule_lock?.reason && storedEvent.schedule_lock.reason !== 'manual' ? ` · ${escapeHtml(String(storedEvent.schedule_lock.reason).replace(/_/g, ' '))}` : ''}</span></div>`
      : '';
    const canToggleLock = canEdit && !!storedEvent.id && scheduled && !scheduleEventIsGroup(storedEvent) && (!isMaterialDeliveryEvent(storedEvent) || storedEvent.lock_toggle_visible !== false);
    const occurrence = !!String(storedEvent.recurrence_series_id || '').trim();
    const series = occurrence ? scheduleRecurringSeries.find((item) => String(item.id || '') === String(storedEvent.recurrence_series_id || '')) : null;
    const persisted = !!storedEvent.id && !String(storedEvent.id).startsWith('__') && scheduleProjectEvents().some((item) => String(item.id || '') === String(storedEvent.id || ''));
    const editable = canEdit && persisted && !scheduleEventIsGroup(storedEvent);
    const action = (attr, icon, label, extra = '') => `<button type="button" class="r-schedule-event-popover-action ${extra}" ${attr}><i class="fas ${icon}"></i>${escapeHtml(label)}</button>`;
    const actionButtons = [
      editable && isMaterialDeliveryEvent(storedEvent) ? action('data-schedule-event-reschedule', 'fa-calendar-day', scheduled ? 'Reschedule' : 'Schedule') : '',
      editable && !isMaterialDeliveryEvent(storedEvent) && !occurrence ? action('data-schedule-event-edit', 'fa-pen', 'Edit') : '',
      editable && occurrence && series ? action('data-schedule-event-edit-series', 'fa-repeat', 'Edit series') : '',
      canToggleLock ? action('data-schedule-event-lock', locked ? 'fa-lock-open' : 'fa-lock', locked ? 'Unlock date' : 'Lock date') : '',
      editable && scheduled && !occurrence ? action('data-schedule-event-unschedule', 'fa-calendar-xmark', 'Unschedule') : '',
      editable && occurrence && scheduled ? action('data-schedule-event-skip', 'fa-forward', 'Skip this one', 'danger') : '',
      editable && !occurrence ? action('data-schedule-event-delete', 'fa-trash', 'Delete', 'danger') : ''
    ].filter(Boolean);
    const lockAction = actionButtons.length ? `<div class="r-schedule-event-popover-actions">${actionButtons.join('')}</div>` : '';
    const requirementWarnings = window.PlatformScheduling?.eventRequirementWarnings?.(event, {
      equipmentUnits:scheduleCachedEquipmentUnits,
      includeEquipment:equipmentSchedulingEnabled()
    }) || [];
    const requirementAlert = requirementWarnings.length
      ? `<div class="r-schedule-requirement-alert" role="alert"><i class="fas fa-triangle-exclamation"></i><ul>${requirementWarnings.map((warning) => `<li>${escapeHtml(warning.label || warning)}</li>`).join('')}</ul></div>`
      : '';
    // Sections get their own popover (name, Rename, Delete), not a work item's.
    const sectionPopover = scheduleEventIsGroup(storedEvent) ? openScheduleSectionPopover(storedEvent, anchor) : null;
    const popover = sectionPopover || document.createElement('div');
    if (!sectionPopover) {
    popover.className = 'r-schedule-event-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', ((v0) => globalThis.PlatformLanguage?.text("project-schedule","m_3a90498db63efc",`${v0} details`,{v0}) ?? `${v0} details`)(kind.label));
    popover.innerHTML = `
      <div class="r-schedule-event-popover-head">
        <div class="r-schedule-event-popover-title"><span class="r-schedule-event-popover-kind"><i class="fas ${String(kind.icon)}"></i>${String(escapeHtml(kind.label))}</span><br>${String(escapeHtml(scheduleEventDisplayTitle(event)))}</div>
        <button type="button" class="r-schedule-event-popover-close" data-schedule-event-close aria-label="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-times"></i></button>
      </div>
      <div class="r-schedule-event-popover-details">
        <div class="r-schedule-event-popover-row"><i class="fas fa-calendar-day"></i><span>${String(escapeHtml(scheduled ? workRangeLabel(storedEvent) : 'Not scheduled yet'))}</span></div>
        ${String(address ? `<div class="r-schedule-event-popover-row"><i class="fas fa-location-dot"></i><span>${escapeHtml(address)}</span></div>` : '')}
        ${String(assigneeRow)}
        ${String(equipmentRow)}
        ${String(lockRow)}
        ${String(deliveryStatus)}
      </div>
      ${String(requirementAlert)}
      ${String(confirmationBlock)}
      ${String(assignmentField)}
      ${String(lockAction)}
      <div class="r-schedule-event-customer" ${canEdit ? '' : 'hidden'}>
        <label class="r-schedule-event-share">
          <input type="checkbox" data-schedule-event-customer-visible ${String(event.customer_visible === true ? 'checked' : '')}>
          <span class="r-schedule-event-share-toggle" aria-hidden="true"></span>
          <span><strong>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_a043dc814fd7c4","Share with customer") ?? "Share with customer")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_e2fe6c0dc1bf57","Choose exactly what appears in the customer portal.") ?? "Choose exactly what appears in the customer portal.")}</small></span>
        </label>
        <div class="r-schedule-event-customer-options ${String(event.customer_visible === true ? 'open' : '')}" data-schedule-event-customer-options>
          <label class="r-schedule-event-customer-option"><input type="checkbox" data-schedule-event-customer-show-title ${String(event.customer_show_title !== false ? 'checked' : '')}><span>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_aa81c572cfc2fb","Show the event title ") ?? "Show the event title ")}<small>${((v12) => globalThis.PlatformLanguage?.htmlText("project-schedule","m_16cc20f54509eb",`(otherwise show only “${v12}”)`,{v12}) ?? `(otherwise show only “${v12}”)`)(escapeHtml(kind.label))}</small></span></label>
          <label class="r-schedule-event-customer-option"><input type="checkbox" data-schedule-event-customer-show-crew ${String(event.customer_show_crew === true ? 'checked' : '')}><span>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_0a4066db1bfb68","Show the assigned crew or team member") ?? "Show the assigned crew or team member")}</span></label>
          <label class="r-schedule-event-customer-note">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_413958fd110fa8","Customer-facing note") ?? "Customer-facing note")}<textarea data-schedule-event-customer-description placeholder="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_f75a0e40848c45","What should the customer see when they open this event?") ?? "What should the customer see when they open this event?")}">${String(escapeHtml(event.customer_description || ''))}</textarea></label>
          ${String(window.Portal?.can?.('scheduling.customer_rescheduling') === true ? `<label class="r-schedule-event-customer-option"><input type="checkbox" data-schedule-event-customer-reschedule ${event.customer_scheduling?.enabled === true ? 'checked' : ''}><span>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_afdcb90e88cf30","Allow the customer to choose another live available time") ?? "Allow the customer to choose another live available time")}</span></label>` : '')}
        </div>
        <button type="button" class="r-schedule-event-customer-save" data-schedule-event-customer-save>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_d2ad3eac5a7c69","Save customer view") ?? "Save customer view")}</button>
      </div>
    `;
    }
    schedulePopoverHost(anchor).appendChild(popover);
    // Keep the popover inside the window as it grows (customer sharing
    // options, confirmation state): flip above the anchor or pin to the
    // viewport and scroll inside it.
    const anchorRect = anchor.getBoundingClientRect();
    const pinned = anchor.__pinnedPopover || null;
    const placePopover = () => {
      if (!popover.isConnected) return;
      popover.style.maxHeight = `${Math.max(160, window.innerHeight - 16)}px`;
      const popoverRect = popover.getBoundingClientRect();
      if (pinned) {
        // Re-opened after an in-place change: stay where it was.
        popover.style.left = `${Math.max(8, Math.min(window.innerWidth - popoverRect.width - 8, pinned.left))}px`;
        popover.style.top = `${Math.max(8, Math.min(window.innerHeight - popoverRect.height - 8, pinned.top))}px`;
        return;
      }
      const left = Math.min(window.innerWidth - popoverRect.width - 8, Math.max(8, anchorRect.left));
      const below = anchorRect.bottom + 8;
      const above = anchorRect.top - popoverRect.height - 8;
      const top = below + popoverRect.height <= window.innerHeight - 8
        ? below
        : (above >= 8 ? above : Math.max(8, window.innerHeight - popoverRect.height - 8));
      popover.style.left = `${Math.max(8, left)}px`;
      popover.style.top = `${top}px`;
    };
    placePopover();
    if (typeof ResizeObserver === 'function') {
      popover.__resizeObserver = new ResizeObserver(() => placePopover());
      popover.__resizeObserver.observe(popover);
    }
    // After an action (and any question it asks) keyboard focus goes back to
    // the item it was opened from, or to a neighbour when the item is gone.
    const returnAnchor = anchor instanceof Element ? anchor : null;
    const focusBack = () => focusScheduleItem(storedEvent.id, returnAnchor);
    popover.querySelector('[data-schedule-event-lock]')?.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      closeScheduleEventPopover();
      Promise.resolve(isMaterialDeliveryEvent(storedEvent) ? toggleMaterialScheduleLock(storedEvent, !locked) : toggleWorkScheduleLock(storedEvent, !locked)).finally(focusBack);
    });
    popover.querySelector('[data-schedule-event-close]')?.addEventListener('click', (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      closeScheduleEventPopover();
    });
    const reopenRect = () => {
      const box = popover.getBoundingClientRect();
      return { left:box.left, top:box.top, anchor:{ left:anchorRect.left, top:anchorRect.top, right:anchorRect.right, bottom:anchorRect.bottom, width:anchorRect.width, height:anchorRect.height } };
    };
    popover.__reopenPlacement = reopenRect;
    popover.querySelectorAll('[data-schedule-assignee-remove]').forEach((button) => button.addEventListener('click', (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      const removeId = String(button.dataset.scheduleAssigneeRemove || '');
      saveWorkAssignees(storedEvent, eventWorkAssignees(storedEvent).filter((ref) => ref.id !== removeId), { reopenAt:reopenRect() });
    }));
    popover.querySelector('[data-schedule-assignee-add]')?.addEventListener('change', async (changeEvent) => {
      changeEvent.stopPropagation();
      const select = changeEvent.currentTarget;
      const addId = String(select.value || '');
      if (!addId) return;
      const resource = workAssignmentResources(storedEvent).find((item) => String(item.id || '') === addId) || {};
      const name = resource.name || addId;
      // A crew or person already booked then is never double-booked
      // silently (the Edit dialog blocks it; here it asks).
      const start = materialEventIsScheduled(storedEvent) ? window.PlatformScheduling?.eventStart?.(storedEvent) : null;
      const end = start ? window.PlatformScheduling?.eventEnd?.(storedEvent) : null;
      const busy = start && end ? scheduleCrewConflicts([addId], start, end, { excludeId:storedEvent.id, excludeSeriesId:storedEvent.recurrence_series_id || '', includePeople:true }) : [];
      if (busy.length) {
        const first = busy[0].event;
        const more = busy.length > 1 ? ` and ${busy.length - 1} other item${busy.length === 2 ? '' : 's'}` : '';
        const placement = reopenRect();
        const approved = await scheduleConfirmUi(`${name} is already booked on “${scheduleEventDisplayTitle(first)}” (${workRangeLabel(first)})${more}. Assign ${name} here anyway?`, { title:'Already booked', okLabel:'Assign anyway', cancelLabel:(globalThis.PlatformLanguage?.text("scheduling","m_cbef679b21abb4","Cancel") ?? "Cancel"), defaultFocus:'cancel' });
        if (!approved) {
          if (select.isConnected) {
            select.value = '';
            try { select.focus({ preventScroll:true }); } catch (_) {}
          }
          return;
        }
        const current = scheduleProjectEvents().find((item) => String(item.id || '') === String(storedEvent.id || '')) || storedEvent;
        await saveWorkAssignees(current, [...eventWorkAssignees(current), { kind:workRefKind(resource.subject_type || resource.resource_kind) || 'resource_group', id:addId, name }], { reopenAt:placement, busyNote:`${name} is also booked on another item then.` });
        return;
      }
      saveWorkAssignees(storedEvent, [...eventWorkAssignees(storedEvent), { kind:workRefKind(resource.subject_type || resource.resource_kind) || 'resource_group', id:addId, name }], { reopenAt:reopenRect() });
    });
    if (popover.querySelector('[data-schedule-assignee-add][disabled]')) {
      // Opened before crews loaded: fill the Add menu once they arrive.
      ensureScheduleResources().then(() => {
        if (!popover.isConnected || scheduleEventPopoverId !== String(storedEvent.id || '')) return;
        // Keyboard focus stays on the same control of the redrawn popover.
        const focused = popover.contains(document.activeElement) ? document.activeElement : null;
        const focusKey = focused ? ['data-schedule-assignee-add', 'data-schedule-assignee-remove', 'data-schedule-event-close', 'data-schedule-event-edit', 'data-schedule-event-lock', 'data-schedule-event-unschedule', 'data-schedule-event-delete'].find((name) => focused.hasAttribute(name)) : '';
        const focusValue = focusKey ? focused.getAttribute(focusKey) : '';
        const hadFocus = !!focused;
        reopenScheduleEventPopover(storedEvent, reopenRect());
        if (!hadFocus) return;
        const next = document.querySelector('.r-schedule-event-popover');
        const target = (focusKey && next?.querySelector(focusValue ? `[${focusKey}="${cssEscape(focusValue)}"]` : `[${focusKey}]`)) || next?.querySelector('[data-schedule-assignee-add]') || next?.querySelector('[data-schedule-event-close]');
        try { target?.focus?.({ preventScroll:true }); } catch (_) {}
      });
    }
    popover.querySelector('[data-schedule-event-edit]')?.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      closeScheduleEventPopover();
      // The dialog hands focus back to the item (not the removed button).
      focusBack();
      openScheduleDialog(scheduleEventTypeId(storedEvent), null, { event:storedEvent });
    });
    popover.querySelector('[data-schedule-section-edit]')?.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      closeScheduleEventPopover();
      openCreateGanttGroupDialog(storedEvent, { onClose:focusBack });
    });
    popover.querySelector('[data-schedule-section-delete]')?.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      closeScheduleEventPopover();
      const neighbor = scheduleNeighborFocusId(storedEvent.id);
      deleteProjectScheduleSection(storedEvent).then((deleted) => focusScheduleItem(deleted ? neighbor : storedEvent.id, deleted ? null : returnAnchor));
    });
    popover.querySelector('[data-schedule-event-edit-series]')?.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      closeScheduleEventPopover();
      focusBack();
      if (series) openScheduleDialog(String(series.event_template?.event_type_default_id || 'project_work'), series);
    });
    popover.querySelector('[data-schedule-event-reschedule]')?.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      closeScheduleEventPopover();
      const start = materialEventIsScheduled(storedEvent) ? window.PlatformScheduling?.eventStart?.(storedEvent) : null;
      if (start && !scheduleDateVisible(start)) scheduleAnchorDate = start;
      focusMaterialDelivery({ event_id:storedEvent.id });
    });
    popover.querySelector('[data-schedule-event-unschedule]')?.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      closeScheduleEventPopover();
      unscheduleProjectItem(storedEvent).finally(focusBack);
    });
    popover.querySelector('[data-schedule-event-delete]')?.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      closeScheduleEventPopover();
      const neighbor = scheduleNeighborFocusId(storedEvent.id);
      deleteProjectItem(storedEvent).then((deleted) => focusScheduleItem(deleted ? neighbor : storedEvent.id, deleted ? null : returnAnchor));
    });
    popover.querySelector('[data-schedule-event-skip]')?.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      closeScheduleEventPopover();
      skipRecurringOccurrence(storedEvent).finally(focusBack);
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

  // Re-open the details popover for an item at the place it was shown
  // (its original anchor was replaced by a re-render).
  function reopenScheduleEventPopover(event = {}, placement = {}){
    const rect = placement.anchor || placement;
    const box = { left:Number(rect.left) || 0, top:Number(rect.top) || 0, right:Number(rect.right ?? rect.left) || 0, bottom:Number(rect.bottom ?? rect.top) || 0, width:Number(rect.width) || 0, height:Number(rect.height) || 0 };
    const anchor = {
      __pinnedPopover:Number.isFinite(Number(placement.left)) && Number.isFinite(Number(placement.top)) && placement.anchor ? { left:Number(placement.left), top:Number(placement.top) } : null,
      getBoundingClientRect:() => box,
      closest:() => null,
      contains:() => false
    };
    const stored = scheduleProjectEvents().find((item) => String(item.id || '') === String(event.id || '')) || event;
    openScheduleEventPopover(stored, anchor);
  }

  function scheduleEventTypeId(event = {}){
    return String(event.event_type_default_id || event.type_id || event.event_type_id || 'project_work').trim() || 'project_work';
  }

  function scheduleConfirmUi(message, options = {}){
    const confirm = window.PlatformUI?.confirm || window.Portal?.ui?.confirm;
    return confirm ? confirm(message, options) : Promise.resolve(window.confirm(message));
  }

  // Takes a placed item off the calendar; it waits to be scheduled again.
  async function unscheduleProjectItem(event = {}){
    if (!requireScheduleEdit()) return null;
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(event.id || '')) || event;
    if (!source?.id) return null;
    if (materialEventIsLocked(source)) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_88e13d64071885","Schedule locked") ?? "Schedule locked"), 'Unlock this item before taking it off the calendar.', false);
      return null;
    }
    const title = scheduleEventDisplayTitle(source);
    const approved = await scheduleConfirmUi(`Take “${title}” off the calendar? It stays on the project and waits to be scheduled again.`, { title:'Unschedule item', okLabel:'Unschedule', cancelLabel:'Keep it scheduled' });
    if (!approved) return null;
    const next = {
      ...source,
      status:'unscheduled',
      start_at:'',
      start:'',
      end_at:'',
      end:'',
      start_date:'',
      end_date:'',
      schedule_history:[...(Array.isArray(source.schedule_history) ? source.schedule_history : []), scheduleHistoryEntry(source, 'unscheduled')].filter(Boolean),
      updated_at:new Date().toISOString()
    };
    const mutationVersion = beginScheduleEventSave(next.id);
    upsertLocalProjectEvent(next);
    renderSchedulePanelPreservingScroll();
    const saved = await saveProjectEventQuiet(next, {
      successTitle:'Item unscheduled',
      successMessage:`${title} is waiting to be scheduled.`,
      failureTitle:'Item not unscheduled',
      broadcast:true,
      preserveLocalEvents:true,
      mutationVersion
    });
    if (!saved) {
      upsertLocalProjectEvent(source);
      renderSchedulePanelPreservingScroll();
      return null;
    }
    await persistGroupRollups([source]);
    renderSchedulePanelPreservingScroll();
    return saved;
  }

  /* The stored copy of an item, compared with the copy shown here.
   * -> { current, changed, deleted } (nothing known when the read fails). */
  async function scheduleStoredEventCheck(source = {}){
    const projectId = String(activeBaseProject?.id || '');
    const orgId = scheduleOrgId();
    if (!source?.id || !projectId || !orgId || typeof window.PlatformAPI?.projects?.get !== 'function') return { current:null, changed:false, deleted:false };
    try {
      const result = await window.PlatformAPI.projects.get(orgId, projectId);
      const events = result?.document?.data?.events;
      if (!Array.isArray(events) || result?.missing) return { current:null, changed:false, deleted:false };
      const current = events.find((item) => String(item?.id || '') === String(source.id)) || null;
      if (!current) return { current:null, changed:false, deleted:true };
      // A newer stored revision = saved elsewhere since this copy was read.
      const changed = scheduleEventRevision(source) > 0 && scheduleEventRevision(current) > scheduleEventRevision(source);
      return { current, changed, deleted:false };
    } catch (_) {
      return { current:null, changed:false, deleted:false };
    }
  }

  async function deleteProjectItem(event = {}){
    if (!requireScheduleEdit()) return null;
    const Scheduling = window.PlatformScheduling;
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(event.id || '')) || event;
    const project = currentSchedulingProject();
    if (!source?.id || !project?.id || typeof Scheduling?.removeProjectEvent !== 'function') return null;
    if (materialEventIsLocked(source)) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_88e13d64071885","Schedule locked") ?? "Schedule locked"), 'Unlock this item before deleting it.', false);
      return null;
    }
    const title = scheduleEventDisplayTitle(source);
    const approved = await scheduleConfirmUi(`Delete “${title}”? This cannot be undone.`, { title:(globalThis.PlatformLanguage?.text("scheduling","m_7f5580dbb3d648","Delete event") ?? "Delete event"), okLabel:'Delete', cancelLabel:'Keep event', danger:true });
    if (!approved) return null;
    // Like any other change, a delete never silently discards what someone
    // else changed meanwhile: it says so and asks again.
    const remote = await scheduleStoredEventCheck(source);
    if (remote.deleted) {
      adoptStaleScheduleCopy({ stale:true, deleted:true, event:source });
      renderSchedulePanelPreservingScroll();
      showStaleScheduleToast({ deleted:true }, '', `“${title}” was already deleted by someone else.`);
      return null;
    }
    if (remote.changed) {
      rememberServerEvents([remote.current]);
      upsertLocalProjectEvent(remote.current);
      renderSchedulePanelPreservingScroll();
      const again = await scheduleConfirmUi(`“${title}” was changed by someone else since it was shown here. Delete it anyway?`, { title:(globalThis.PlatformLanguage?.text("scheduling","m_changed_elsewhere_delete","Changed by someone else — delete anyway?") ?? "Changed by someone else — delete anyway?"), okLabel:'Delete anyway', cancelLabel:'Keep event', danger:true, defaultFocus:'cancel' });
      if (!again) return null;
    }
    try {
      scheduleMutationSerial += 1;
      const result = await Scheduling.removeProjectEvent(scheduleOrgId(), project, source.id, scheduleCachedConfig || null);
      scheduleMutationSerial += 1;
      const savedProject = result?.project || null;
      activeBaseProject = savedProject?.id
        ? { ...activeBaseProject, ...savedProject, events:Array.isArray(savedProject.events) ? savedProject.events : scheduleProjectEvents().filter((item) => String(item.id || '') !== String(source.id)) }
        : { ...activeBaseProject, events:scheduleProjectEvents().filter((item) => String(item.id || '') !== String(source.id)) };
      cacheActiveBaseProject();
      rememberScheduleProject(activeBaseProject);
      workScheduleDrafts.delete(String(source.id));
      if (String(materialScheduleEventId || '') === String(source.id)) {
        materialScheduleModeActive = false;
        materialScheduleEventId = '';
        materialScheduleDraft = null;
      }
      await persistGroupRollups([source]);
      renderSchedulePanelPreservingScroll();
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      window.dispatchEvent(new CustomEvent('fm:projects:refresh'));
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_2183488d5ed71c","Event deleted") ?? "Event deleted"), `${title} was removed from the schedule.`, true);
      return result;
    } catch (error) {
      if (isStaleSaveError(error)) { handleStaleScheduleSave(error, `“${title}” was already deleted by someone else.`); return null; }
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_ad38658fe6f432","Event not deleted") ?? "Event not deleted"), error?.message || 'Could not delete the item.', false);
      return null;
    }
  }

  async function skipRecurringOccurrence(event = {}){
    if (!requireScheduleEdit()) return null;
    const seriesId = String(event.recurrence_series_id || '').trim();
    const api = window.PlatformAPI?.projects;
    if (!seriesId || !event.id || typeof api?.updateRecurrenceOccurrence !== 'function') return null;
    const title = scheduleEventDisplayTitle(event);
    const approved = await scheduleConfirmUi(`Skip “${title}” on ${workRangeLabel(event)}? The rest of the series stays as it is.`, { title:'Skip this occurrence', okLabel:'Skip', cancelLabel:'Keep it' });
    if (!approved) return null;
    try {
      await api.updateRecurrenceOccurrence(scheduleOrgId(), seriesId, event.id, 'skipped');
      upsertLocalProjectEvent({ ...event, status:'cancelled' });
      renderSchedulePanelPreservingScroll();
      await refreshProjectFromServer({ render:true });
      notifyScheduleChanged();
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      showToast('Occurrence skipped', 'The rest of the series is unchanged.', true);
    } catch (error) {
      showToast('Could not skip occurrence', error?.message || 'Try again.', false);
    }
    return null;
  }

  async function saveScheduleEventCustomerSettings(event = {}, settings = {}){
    if (!requireScheduleEdit()) return null;
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

  // Replaces the primary assignee (other crews of a multi-crew item stay);
  // an empty id unassigns every crew.
  async function saveWorkCrewAssignment(event = {}, crewId = '', options = {}){
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(event.id || '')) || event;
    const current = eventWorkAssignees(source);
    const id = String(crewId || '').trim();
    if (!id) return saveWorkAssignees(source, [], options);
    const resource = workAssignmentResources(source).find((item) => String(item.id || '') === id) || { id, name:workResourceName(id) || id, resource_kind:'resource_group' };
    const chosen = { kind:workRefKind(resource.subject_type || resource.resource_kind) || 'resource_group', id, name:String(resource.name || id) };
    const rest = current.slice(1).filter((ref) => ref.id !== id);
    return saveWorkAssignees(source, [chosen, ...rest], options);
  }

  async function saveWorkAssignees(event = {}, assignees = [], options = {}){
    if (!requireScheduleEdit()) return null;
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(event.id || '')) || event;
    if (!source?.id || productionResourceType(source) === 'material') return;
    const payload = workAssigneesPayload(source, assignees);
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
    // Editing assignees from the details popover keeps it open on the item.
    if (options.reopenAt) {
      reopenScheduleEventPopover(next, options.reopenAt);
      // Keyboard focus stays in the redrawn popover (on its Add menu).
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) {
        try { document.querySelector('.r-schedule-event-popover [data-schedule-assignee-add]')?.focus({ preventScroll:true }); } catch (_) {}
      }
    }
    const names = eventWorkAssignees(next).map((ref) => ref.name).filter(Boolean);
    const saved = await saveProjectEventQuiet(next, {
      successTitle: 'Crew updated',
      successMessage: `${names.length ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} assigned.` : 'The work item is unassigned.'}${options.busyNote ? ` ${options.busyNote}` : ''}`,
      failureTitle: 'Crew update failed'
    });
    if (!saved) {
      upsertLocalProjectEvent(source);
      renderSchedulePanelPreservingScroll();
    }
    return saved;
  }

  // Resources load with the rest of the schedule data; a menu opened before
  // that finishes shows a loading row instead of a partial list.
  let scheduleResourcesPromise = null;
  let scheduleResourcesSettled = false;
  function scheduleResourcesReady(){
    return !!scheduleCachedConfig && (scheduleCachedUsers.length > 0 || scheduleUsersLoaded) && (scheduleWorkforceTerminologyLoaded || !window.PlatformAPI?.workforce?.assignableResources);
  }
  function ensureScheduleResources(){
    if (scheduleResourcesReady()) return Promise.resolve(true);
    if (!scheduleResourcesPromise) {
      scheduleResourcesPromise = loadScheduleData().then(() => true).catch(() => false).finally(() => { scheduleResourcesPromise = null; scheduleResourcesSettled = true; });
    }
    return scheduleResourcesPromise;
  }

  function openWorkAssignmentMenu(event = {}, anchor = null){
    if (!requireScheduleEdit()) return null;
    if (!event?.id || !anchor) return;
    if (scheduleCrewMenuEventId === String(event.id || '') && document.querySelector('.r-schedule-crew-popover')) {
      closeWorkAssignmentMenu();
      return;
    }
    closeWorkAssignmentMenu();
    const eventId = String(event.id || '');
    scheduleCrewMenuEventId = eventId;
    anchor.setAttribute?.('aria-expanded', 'true');
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'r-schedule-crew-popover';
    menu.setAttribute('role', 'listbox');
    menu.style.left = `${Math.min(window.innerWidth - 228, Math.max(8, rect.left))}px`;
    menu.style.top = `${Math.min(window.innerHeight - 288, Math.max(8, rect.bottom + 7))}px`;
    const fill = () => {
      const source = scheduleProjectEvents().find((item) => String(item.id || '') === eventId) || event;
      const assigned = eventWorkAssignees(source);
      const assignedIds = new Set(assigned.map((ref) => ref.id));
      const multi = assigned.length > 1;
      const resources = workAssignmentResources(source);
      const option = (id, label) => {
        const active = id ? assignedIds.has(String(id)) : !assigned.length;
        return `<button type="button" class="r-schedule-crew-option ${active ? 'active' : ''}" role="option" aria-selected="${active ? 'true' : 'false'}" data-work-crew-option="${escapeHtml(id || '')}"><i class="fas fa-check check" style="visibility:${active ? 'visible' : 'hidden'}"></i><span>${escapeHtml(label)}</span></button>`;
      };
      menu.innerHTML = `${multi ? `<div class="r-schedule-crew-hint">${escapeHtml(`${assigned.length} assigned — click to add or remove`)}</div>` : ''}${option('', 'Unassigned')}${resources.map((resource) => option(resource.id, resource.name || resource.id)).join('')}<button type="button" class="r-schedule-crew-more" data-work-crew-more><i class="fas fa-users"></i> ${escapeHtml(multi ? 'Edit crews…' : 'Assign several…')}</button>`;
      menu.querySelectorAll('[data-work-crew-option]').forEach((button) => button.addEventListener('click', (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        const id = String(button.dataset.workCrewOption || '');
        if (multi && id) {
          // Several crews: toggle this one, keeping the others.
          const next = assignedIds.has(id)
            ? assigned.filter((ref) => ref.id !== id)
            : [...assigned, { kind:workRefKind(resources.find((item) => String(item.id || '') === id)?.subject_type || resources.find((item) => String(item.id || '') === id)?.resource_kind) || 'resource_group', id, name:resources.find((item) => String(item.id || '') === id)?.name || id }];
          saveWorkAssignees(source, next);
          return;
        }
        saveWorkCrewAssignment(source, id);
      }));
      menu.querySelector('[data-work-crew-more]')?.addEventListener('click', (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        closeWorkAssignmentMenu();
        openScheduleEventPopover(source, anchor);
      });
    };
    if (scheduleResourcesReady()) fill();
    else {
      menu.innerHTML = `<button type="button" class="r-schedule-crew-option" disabled aria-busy="true"><i class="fas fa-circle-notch fa-spin check"></i><span>${escapeHtml(`Loading ${workforceTerm('resource_group', 'plural').toLowerCase()}…`)}</span></button>`;
      ensureScheduleResources().then(() => {
        if (menu.isConnected && scheduleCrewMenuEventId === eventId) fill();
      });
    }
    schedulePopoverHost(anchor).appendChild(menu);
    setTimeout(() => {
      scheduleCrewMenuDocHandler = bindOutsidePointerDismiss(menu, closeWorkAssignmentMenu, [anchor]);
    }, 0);
  }

  function decorateWorkEventForCalendar(event, crews = scheduleWorkResources(scheduleCachedConfig, scheduleCachedUsers, event?.scope_template_id)){
    // A schedule group rolls up its members; it has no crew of its own.
    if (scheduleEventIsGroup(event)) return { ...event, requirement_warnings:[], crew_label:'', assignee_label:'', awaiting_crew:false };
    const payload = workCrewCalendarPayload(event, crews);
    // Several crews show as "Alpha Crew +1" instead of only the first.
    const assignees = eventWorkAssignees(event);
    const multi = assignees.length > 1 || (assignees.length === 1 && !workCrewId(event));
    return {
      ...event,
      requirement_warnings:window.PlatformScheduling?.eventRequirementWarnings?.(event, {
        equipmentUnits:scheduleCachedEquipmentUnits,
        includeEquipment:equipmentSchedulingEnabled()
      }) || [],
      ...payload,
      // The chip label comes from the current assignees, not a stored label.
      assignee_label:'',
      ...(multi ? { crew_label:workAssigneesLabel(assignees), awaiting_crew:false } : {})
    };
  }

  function salesAssignmentSelectHtml(){
    const salespeople = cachedSalesAppointmentUsers();
    if (salespeople.length <= 1) return '';
    const selected = String(scheduleDraft?.user?.id || schedulePreferredSalesUserId || '').trim();
    return `<label class="r-assignment-field">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_4aff7f0b72fb1d","Assignee") ?? "Assignee")}<select id="rSalesAssignment" class="r-assignment-select ${String(selected ? '' : 'waiting')}">
      <option value="" ${String(selected ? '' : 'selected')}>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_8a993ed9b573b4","Unassigned") ?? "Unassigned")}</option>
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
    const mode = branchProjectConfig?.title_mode || 'all_contacts';
    const address = ($('#rAddress')?.value || activeBaseProject?.address || reportOrderState?.address || '').trim();
    const primary = primaryContact();
    const customerName = ((mode === 'all_contacts' ? window.Portal?.modules?.request?.formatProjectContactNames?.(activeBaseProject?.contacts) : '') || primary.name || '').trim();
    if (mode === 'manual') return activeBaseProject?.title || manualProjectTitle() || customerName || address || 'Project';
    if (mode === 'address') return address || customerName || 'Project';
    return customerName || address || 'Project';
  }

  // The dates the current view shows, next to the heading (the Routing and
  // hourly views otherwise show no date at all).
  function scheduleRangeLabel(){
    if (scheduleViewMode === 'gantt') return '';
    const anchor = new Date(scheduleAnchorDate);
    if (!Number.isFinite(anchor.getTime())) return '';
    const short = { month:'short', day:'numeric' };
    if (scheduleViewMode === 'month') return anchor.toLocaleDateString([], { month:'long', year:'numeric' });
    if (scheduleViewMode === 'day' || scheduleViewMode === 'scheduling-day') return anchor.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric', year:'numeric' });
    const start = scheduleViewMode === '4day' ? scheduleAddDays(anchor, 0) : scheduleStartOfWeek(anchor);
    const end = scheduleAddDays(start, scheduleViewMode === '4day' ? 3 : 6);
    return `${start.toLocaleDateString([], short)} – ${end.toLocaleDateString([], { ...short, year:'numeric' })}`;
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
    if (!requireScheduleEdit()) return null;
    if (!schedulingEnabled()) return;
    if (!scheduleModeActive) schedulePlacementReturn = { view:scheduleViewMode, target:scheduleSchedulingTarget, date:new Date(scheduleAnchorDate) };
    materialScheduleModeActive = false;
    materialScheduleEventId = '';
    materialScheduleListId = '';
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
    currentSchedulingProject();
    setActivePreviewTab('schedule');
    renderSchedulePanel();
  }

  function projectMobileViewChoices(){
    const terminology = (key, fallback) => window.Portal?.terminology?.get?.(key, fallback) || fallback;
    return [
      ['day', 'Day', 'fa-calendar-day'],
      ['4day', '3 Day', 'fa-calendar-week'],
      ['week', 'Week', 'fa-table-columns'],
      ['month', 'Month', 'fa-calendar-days'],
      // Routing and Timeline are reachable on a phone too.
      ...(projectRoutingViewEnabled() ? [['scheduling-week', terminology('scheduling.routing_view', 'Routing'), 'fa-route']] : []),
      ...(projectGanttViewEnabled() ? [['gantt', terminology('scheduling.gantt_view', 'Timeline'), 'fa-bars-staggered']] : [])
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
      if (!projectMobileViewChoices().some(([id]) => id === next)) return;
      projectMobileViewMenuOpen = false;
      scheduleViewMode = next;
      if (next === 'gantt' || next === 'scheduling-week') {
        scheduleModeActive = false;
        scheduleDraft = null;
        scheduleSelectedEventId = '';
        scheduleAssignmentEventId = '';
      }
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
      // Today brings today's week into view again.
      forgetScheduleMonthScroll();
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
    const ganttLabel = terminology('scheduling.gantt_view', 'Timeline');
    const surfaceActive = (id) => id === 'gantt' ? isGantt : (id === 'scheduling' ? isScheduling && !isGantt : !isScheduling && !isGantt);
    const surfaceButton = (id, label) => `<button type="button" class="r-schedule-view-btn ${surfaceActive(id) ? 'active' : ''}" data-schedule-surface="${id}">${label}</button>`;
    const targetButton = (id, label) => `<button type="button" class="r-schedule-view-btn ${scheduleSchedulingTarget === id ? 'active' : ''}" data-schedule-target="${id}">${label}</button>`;
    const button = ([id, label]) => `<button type="button" class="r-schedule-view-btn ${scheduleViewMode === id || (id === 'scheduling-week' && scheduleViewMode === 'scheduling') ? 'active' : ''}" data-schedule-view="${id}">${escapeHtml(label)}</button>`;
    const modes = isScheduling ? schedulingModes : calendarModes;
    return `<div class="r-schedule-view-switch">
      ${canEditSchedule()?'<button type="button" data-project-new-appointment style="background:#d93025;color:white;border:0;border-radius:7px;padding:10px 14px;font:inherit;font-weight:700;cursor:pointer">+ Appointment</button>':''}
      <span class="r-schedule-view-group surface">${String(surfaceButton('calendar', escapeHtml(terminology('scheduling.calendar_view', 'Calendar'))))}${String(projectRoutingViewEnabled() ? surfaceButton('scheduling', escapeHtml(routingLabel)) : '')}${String(projectGanttViewEnabled() ? surfaceButton('gantt', escapeHtml(ganttLabel)) : '')}</span>
      <span class="r-schedule-view-group navigation"><button type="button" class="r-schedule-anchor-nav" data-schedule-anchor-nav="-1" aria-label="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_bb31fd73cbfe3b","Previous") ?? "Previous")}" title="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_bb31fd73cbfe3b","Previous") ?? "Previous")}"><i class="fas fa-chevron-left"></i></button><button type="button" class="r-schedule-anchor-nav today" data-schedule-anchor-nav="0">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_23929ba4ba84dd","Today") ?? "Today")}</button><button type="button" class="r-schedule-anchor-nav" data-schedule-anchor-nav="1" aria-label="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_5e03a7c216f500","Next") ?? "Next")}" title="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_5e03a7c216f500","Next") ?? "Next")}"><i class="fas fa-chevron-right"></i></button></span>
      ${String(isScheduling && !isGantt ? `<span class="r-schedule-view-group target"><span class="r-schedule-view-label">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_fc05a804bd034c","Schedule") ?? "Schedule")}</span>${targetButton('production', escapeHtml(terminology('scheduling.production_view', 'Production')))}${targetButton('sales', escapeHtml(terminology('scheduling.sales_view', 'Sales')))}</span>` : '')}
      ${String(isGantt ? (!canEditSchedule() ? '' : `<span class="r-schedule-view-group"><button type="button" class="r-schedule-view-btn" data-gantt-add-group><i class="fas fa-layer-group"></i> Add section</button></span>`) : `<span class="r-schedule-view-group ${isScheduling ? 'scheduling' : ''}"><span class="r-schedule-view-label">${isScheduling ? escapeHtml(routingLabel) : 'Calendar'}</span>${modes.map(button).join('')}</span>`)}
    </div>`;
  }

  let bookingBundle;
  const bookingSource=new URL('../../appointment-booking/booking.js',document.currentScript?.src||new URL('/libraries/apps/project-schedule/panel.js',location.href)).href;
  async function openProjectBooking(){
    if(!(await confirmDiscardPlacementDraft()))return;
    if(!window.FirstMateBooking)await (bookingBundle ||= new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=bookingSource;script.onload=resolve;script.onerror=()=>{bookingBundle=null;reject(new Error('Could not load booking.'));};document.head.append(script);}));
    const project=await ensureRemoteSchedulingProject();
    if(!project?.id)throw new Error('Save this project before booking.');
    await window.FirstMateBooking.open({orgId:cfg.userOrgId,projectId:project.id,lockProject:true,onBooked:async()=>{await refreshProjectFromServer({render:false});scheduleRecurringSeries=[];await loadRecurringSeries({refresh:true});renderSchedulePanel();}});
  }
  function bindScheduleViewSwitch(rootEl){
    rootEl.querySelector('[data-project-new-appointment]')?.addEventListener('click',()=>openProjectBooking().catch(error=>showToast('Could not open booking',error.message,false)));
    rootEl.querySelectorAll('[data-schedule-anchor-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = Number(btn.dataset.scheduleAnchorNav || 0);
        const timeline = scheduleViewMode === 'gantt'
          ? window.PlatformScheduleView?.ganttControls?.(rootEl.querySelector('.psv-gantt-wrap')?.parentElement)
          : null;
        if (timeline) {
          if (delta === 0) timeline.today();
          else timeline.page(delta);
          return;
        }
        if (delta === 0) forgetScheduleMonthScroll();
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
    return scheduleDisplayEvents()
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
      target.innerHTML = `<div class="r-schedule-empty"><i class="fas fa-calendar"></i>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_1d683425be9eb5","Calendar tools are unavailable.") ?? "Calendar tools are unavailable.")}</div>`;
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

  function scheduleWorkdayStartMinute(){
    const window_ = window.PlatformScheduling?.availabilityWindow?.(scheduleCachedConfig || {}, scheduleLocalDate(scheduleAnchorDate), 'project_work') || null;
    const [hour, minute] = String(window_?.start || '07:00').split(':').map((part) => Number(part) || 0);
    return Math.max(0, Math.min(20 * 60, hour * 60 + minute - 30));
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
    return `<div class="r-cal-appointment draft has-confirm" style="--span:${String(span)}"><div class="r-cal-appt-top"><span>${String(escapeHtml(title))}</span><span>${String(escapeHtml(time))}</span></div><div class="r-cal-appt-address">${String(escapeHtml(address))}</div><span class="r-cal-draft-confirm" data-schedule-draft-confirm role="button" aria-label="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_3eb4bd5c2b685c","Confirm appointment") ?? "Confirm appointment")}"><i class="fas fa-check"></i></span></div>`;
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
        return `<div class="r-cal-travel" data-travel-key="${String(escapeHtml(key))}" data-origin="${String(escapeHtml(origin))}" data-destination="${String(escapeHtml(destination))}"><i class="far fa-clock"></i>${((v3) => globalThis.PlatformLanguage?.htmlText("project-schedule","m_805a0136c68cf7",`&nbsp;${v3}`,{v3}) ?? `&nbsp;${v3}`)(escapeHtml(label))}</div>`;
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
      ? `<strong>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_22e746d02726ea","Scheduling appointment") ?? "Scheduling appointment")}</strong>${String(escapeHtml(scheduleDraft.label))}${String(scheduleDraft.userLabel ? ` with ${escapeHtml(scheduleDraft.userLabel)}` : ' - assign later')}.`
      : `<strong>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_a0fb70645df93b","Schedule appointment") ?? "Schedule appointment")}</strong>Use the Schedule tab to choose an appointment time for this project.`;
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

  function upsertLocalProjectEvent(input){
    if (!input?.id || !activeBaseProject) return;
    const { expected_event_revision:ignoredRevisionToken, ...event } = input;
    const events = Array.isArray(activeBaseProject.events) ? [...activeBaseProject.events] : [];
    const idx = events.findIndex((item) => String(item.id || '') === String(event.id || ''));
    // A copy older than the one shown (e.g. restoring the pre-save copy after
    // a refused save that already brought in the stored one) is not applied.
    if (idx >= 0 && scheduleEventRevision(event) && scheduleEventRevision(events[idx]) > scheduleEventRevision(event)) return;
    if (idx >= 0) events[idx] = { ...events[idx], ...event };
    else events.push(event);
    activeBaseProject = { ...activeBaseProject, events, updated_at: new Date().toISOString() };
    cacheActiveBaseProject();
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
      const saved = await queueScheduleEventSave(event.id, () => saveScheduleEventRemote(orgId, project, event, config));
      const isCurrentMutation = !mutationVersion || scheduleEventSaveVersions.get(String(event.id || '')) === mutationVersion;
      if (isCurrentMutation && preserveLocalEvents) {
        const { events:ignoredEvents, ...savedProjectFields } = saved.project || {};
        activeBaseProject = { ...activeBaseProject, ...savedProjectFields };
        upsertLocalProjectEvent({ ...(saved.merged || event), ...(saved.event || {}) });
      } else if (isCurrentMutation) {
        activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project.events || activeBaseProject?.events || [] };
        cacheActiveBaseProject();
        rememberScheduleProject(activeBaseProject);
      }
      if (broadcast && isCurrentMutation) {
        window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
        window.dispatchEvent(new CustomEvent('fm:projects:refresh'));
      } else if (isCurrentMutation) notifyScheduleChanged();
      // A save merged onto someone else's newer copy shows that copy's
      // changes (their new time, description…) right away.
      if (saved.merged && isCurrentMutation && state.active) renderSchedulePanelPreservingScroll();
      if (successTitle && isCurrentMutation) showToast(successTitle, saved.merged ? `${successMessage} Changes someone else made to this item meanwhile were kept.` : successMessage, true);
      return saved;
    } catch (error) {
      if (isStaleSaveError(error)) {
        handleStaleScheduleSave(error);
        return null;
      }
      if (!mutationVersion || scheduleEventSaveVersions.get(String(event.id || '')) === mutationVersion) {
        showToast(failureTitle, error?.message || 'Could not save this schedule change.', false);
      }
      return null;
    }
  }

  // Quiet saves skip this window's own calendar reload but still tell other
  // surfaces (the portal's Scheduling tab, other project windows) that this
  // project's schedule changed; the project window host relays it.
  function notifyScheduleChanged(){
    window.dispatchEvent(new CustomEvent('fm:project-schedule:changed', { detail:{ projectId:String(activeBaseProject?.id || '') } }));
  }

  // Re-read the project's schedule items after changes made elsewhere (the
  // global Scheduling tab, another window, a recurring series). Only events are
  // adopted: the Overview form stays the owner of the project details, and a
  // read never saves anything.
  let scheduleServerRefresh = null;
  let scheduleLastServerRefreshAt = 0;
  // What a viewer can see of the items; ignores client-side normalization.
  function scheduleEventsSignature(events = []){
    return JSON.stringify((Array.isArray(events) ? events : []).map((event) => {
      const entry = {
        id:String(event?.id || ''),
        start:String(event?.start_at || event?.start || ''),
        end:String(event?.end_at || event?.end || ''),
        status:String(event?.status || ''),
        allDay:event?.all_day === true,
        crew:workCrewId(event || {}),
        users:(Array.isArray(event?.assigned_user_ids) ? event.assigned_user_ids : []).join(','),
        locked:materialEventIsLocked(event || {}),
        title:String(event?.title || ''),
        parent:String(event?.parent_event_id || ''),
        shared:event?.customer_visible === true,
        // The stored revision: a newer server copy (someone else's
        // description, notes, equipment…) is always adopted, so the next
        // save is made on it instead of being refused again.
        revision:scheduleEventRevision(event || {}),
        description:String(event?.description || ''),
        notes:String(event?.notes || ''),
        assignees:eventWorkAssignees(event || {}).map((ref) => ref.id).join(','),
        equipment:JSON.stringify(window.PlatformScheduling?.eventEquipmentRefs?.(event || {}) || []),
        deps:JSON.stringify(Array.isArray(event?.depends_on) ? event.depends_on : [])
      };
      Object.keys(event || {}).filter((key) => key.includes('confirm')).sort().forEach((key) => { entry[key] = event[key]; });
      return entry;
    }).sort((a, b) => a.id.localeCompare(b.id)));
  }
  async function refreshProjectFromServer({ render = true } = {}){
    const id = String(activeBaseProject?.id || '');
    const orgId = scheduleOrgId();
    if (!id || !orgId || typeof window.PlatformAPI?.projects?.get !== 'function') return null;
    if (scheduleEventSaveQueues.size) return null;
    if (scheduleServerRefresh?.id === id) return scheduleServerRefresh.promise;
    // A read that raced one of this window's saves is older than the local
    // copy; adopting it would put moved items back (and skip their group
    // rollups).
    const serial = scheduleMutationSerial;
    const promise = (async () => {
      await Promise.resolve();
      try {
        const result = await window.PlatformAPI.projects.get(orgId, id);
        const data = result?.document?.data;
        scheduleLastServerRefreshAt = Date.now();
        if (data && !result?.missing && String(activeBaseProject?.id || '') === id) rememberServerEvents(Array.isArray(data.events) ? data.events : []);
        if (!data || result?.missing || String(activeBaseProject?.id || '') !== id || scheduleEventSaveQueues.size || serial !== scheduleMutationSerial) return null;
        const events = Array.isArray(data.events) ? data.events : [];
        const changed = scheduleEventsSignature(events) !== scheduleEventsSignature(scheduleProjectEvents());
        if (!changed) return activeBaseProject;
        activeBaseProject = { ...activeBaseProject, events };
        cacheActiveBaseProject();
        rememberScheduleProject(activeBaseProject);
        if (render && state.active) renderSchedulePanelPreservingScroll();
        return activeBaseProject;
      } catch (_) {
        return null;
      } finally {
        if (scheduleServerRefresh?.promise === promise) scheduleServerRefresh = null;
      }
    })();
    scheduleServerRefresh = { id, promise };
    return promise;
  }

  // Placing an appointment over the assignee's existing appointment is allowed
  // (people double-book on purpose) but never silent.
  let lastSalesConflictKey = '';
  function warnSalesDraftConflict(events = [], draft = null){
    const userId = String(draft?.user?.id || '').trim();
    const start = draft?.start ? new Date(draft.start) : null;
    if (!userId || !start || !Number.isFinite(start.getTime())) return;
    const end = draft?.end ? new Date(draft.end) : new Date(start.getTime() + Math.max(1, Number(draft.duration_minutes) || 60) * 60000);
    const Scheduling = window.PlatformScheduling;
    const ownId = String(draft.event_id || '');
    const conflict = (Array.isArray(events) ? events : []).find((event) => {
      if (!event?.id || String(event.id) === ownId || ['cancelled', 'canceled'].includes(String(event.status || '').toLowerCase())) return false;
      if (workCrewId(event) !== userId && !(Array.isArray(event.assigned_user_ids) && event.assigned_user_ids.map(String).includes(userId))) return false;
      const eventStart = Scheduling?.eventStart?.(event);
      const eventEnd = Scheduling?.eventEnd?.(event);
      return eventStart && eventEnd && eventStart < end && eventEnd > start;
    });
    const key = conflict ? `${userId}:${start.toISOString()}:${conflict.id}` : '';
    if (!conflict || key === lastSalesConflictKey) { lastSalesConflictKey = key; return; }
    lastSalesConflictKey = key;
    showToast('Double booking', `${draft.user?.name || 'This person'} already has "${conflict.title || conflict.project_title || 'an appointment'}" at that time.`, false);
  }

  function commitSalesAppointmentRange(event, range, user = null, durationMinutes = 60){
    if (!requireScheduleEdit()) return null;
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

  async function saveCalendarAppointment(options = {}){
    if (!requireScheduleEdit()) return null;
    // ✓ can be clicked again while the (slow) save runs; only one goes out.
    if (schedulePlacementSaving) return null;
    setSchedulePlacementSaving(true);
    try {
      return await saveCalendarAppointmentNow(options);
    } finally {
      setSchedulePlacementSaving(false);
    }
  }

  async function saveCalendarAppointmentNow({ start = null, user = null, eventTypeId = 'sales_appointment' } = {}){
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
      const saved = await saveScheduleEventRemote(orgId, project, event, config);
      activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project.events || [] };
      cacheActiveBaseProject();
      rememberScheduleProject(activeBaseProject);
      scheduleDraft = null;
      scheduleSelectedEventId = '';
      scheduleAssignmentEventId = '';
      scheduleModeActive = false;
      schedulePlacementReturn = null;
      setSchedulePlacementSaving(false);
      updateScheduleChoiceCard();
      const scrollPosition = captureScheduleScroll();
      setActivePreviewTab('schedule');
      renderWorkflowState();
      setActivePreviewTab('schedule');
      restoreScheduleScroll(scrollPosition);
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      showToast(existing ? 'Appointment updated' : 'Appointment scheduled', ((v0) => globalThis.PlatformLanguage?.text("project-schedule","m_b8e410fbacfc29",`${v0} was saved.`,{v0}) ?? `${v0} was saved.`)(event.title || 'Appointment'), true);
    } catch (error) {
      if (isStaleSaveError(error)) handleStaleScheduleSave(error);
      else showToast((globalThis.PlatformLanguage?.text("project-schedule","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), error?.message || 'Could not save the appointment.', false);
    }
  }

  async function unassignCurrentAppointment(event){
    if (!requireScheduleEdit()) return null;
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
      const saved = await saveScheduleEventRemote(orgId, project, next, config);
      activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project.events || [] };
      cacheActiveBaseProject();
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
    const allDay = typeof window.PlatformScheduling?.eventIsAllDay === 'function'
      ? window.PlatformScheduling.eventIsAllDay({ ...event, start_at:event.start_at || start.toISOString(), end_at:event.end_at || end.toISOString() })
      : event.all_day !== false && event.schedule_granularity !== 'time';
    if (allDay) {
      const lastDay = scheduleAddDays(end, -1);
      const endDisplay = lastDay < start ? start : lastDay;
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
    return String(activeWorkDraft()?.title || '').trim() || 'Work';
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
    if (!requireScheduleEdit()) return null;
    // One confirm at a time: a second ✓ (double click) would create the item
    // twice.
    if (schedulePlacementSaving || schedulePlacementBusy) return;
    const Scheduling = window.PlatformScheduling;
    const orgId = scheduleOrgId();
    schedulePlacementBusy = true;
    const project = await ensureRemoteSchedulingProject();
    const workScheduleDraft = activeWorkDraft();
    if (!Scheduling || !orgId || !project?.id || !workScheduleDraft?.start || !workScheduleDraft?.end) {
      schedulePlacementBusy = false;
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_15fa17332ed5c6","Work schedule unavailable") ?? "Work schedule unavailable"), (globalThis.PlatformLanguage?.text("project-schedule","m_9eaf6c129707cd","Choose a work start and end before confirming.") ?? "Choose a work start and end before confirming."), false);
      return;
    }
    try {
      if (!(await confirmPastPlacement(workScheduleDraft, workScheduleDraft.start))) return;
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
      // New ad hoc work gets production defaults; an existing item keeps its
      // own kind, lock, confirmation and scope-resource settings.
      const creationDefaults = existing ? {} : {
        kind: 'project_work',
        schedule_item_kind: 'production',
        resource_type: '',
        scope_resource_list_id: '',
        locked: false,
        schedule_locked: false,
        lock_toggle_visible: false,
        confirmation_required: false
      };
      const event = {
        ...base,
        title: existing ? (base.title || workDraftTitle()) : workDraftTitle(),
        ...creationDefaults,
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
        metadata: existing ? (base.metadata || {}) : { ...(base.metadata || {}), ad_hoc_production: true },
        updated_at: new Date().toISOString()
      };
      const related = existing ? await resolveProjectRelatedReschedule(existing, { start, end }, { verb:materialEventIsScheduled(existing) ? 'Moving' : 'Scheduling' }) : null;
      if (related?.cancelled) return;
      setSchedulePlacementSaving(true);
      const saved = await saveScheduleEventRemote(orgId, project, event, config);
      activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project.events || [] };
      cacheActiveBaseProject();
      rememberScheduleProject(activeBaseProject);
      // Placed: leave placement and show the result (linked items at their
      // new dates) now; their saves continue behind it.
      workScheduleDrafts.delete(String(workScheduleDraft.id || ''));
      const remaining = lastWorkDraft();
      setActiveWorkDraftId(remaining?.id || '');
      showRelatedChangesLocally(related);
      const scrollPosition = captureScheduleScroll();
      setSchedulePlacementSaving(false);
      setActivePreviewTab('schedule');
      renderSchedulePanel();
      restoreScheduleScroll(scrollPosition);
      showToast(existing ? 'Work schedule updated' : 'Work scheduled', `${((v0) => globalThis.PlatformLanguage?.text("project-schedule","m_b8e410fbacfc29",`${v0} was saved.`,{v0}) ?? `${v0} was saved.`)(event.title || 'Work')}${relatedMoveNote(related)}`, true);
      await saveRelatedRescheduleChanges(related);
      if (existing || related?.changes?.length) await persistGroupRollups([event, ...(related?.changes || [])]);
      if (related?.changes?.length) renderSchedulePanelPreservingScroll();
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      window.dispatchEvent(new CustomEvent('fm:projects:refresh'));
    } catch (error) {
      if (isStaleSaveError(error)) handleStaleScheduleSave(error);
      else showToast((globalThis.PlatformLanguage?.text("project-schedule","m_f1b40620f12653","Work scheduling failed") ?? "Work scheduling failed"), error?.message || 'Could not save this work.', false);
    } finally {
      schedulePlacementBusy = false;
      setSchedulePlacementSaving(false);
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
    if (!appointments.length) return `<div class="r-schedule-empty-small">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_3f4558f856c78e","No sales appointments scheduled.") ?? "No sales appointments scheduled.")}</div>`;
    return `<div class="r-schedule-tile-list">${appointments.map((event) => `
      <button type="button" class="r-schedule-tile r-sales-tile" data-sales-appointment-event="${escapeHtml(event.id || '')}">
        <div class="r-schedule-tile-title">${escapeHtml(event.title || (globalThis.PlatformLanguage?.text("project-schedule","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment"))}</div>
        <div class="r-schedule-tile-meta">${escapeHtml(formatEventTime(event))}</div>
        <div class="r-schedule-tile-meta">${escapeHtml(eventAssignedLabel(event))}</div>
      </button>
    `).join('')}</div>`;
  }

  // Whether a date falls inside the range the calendar currently shows.
  function scheduleDateVisible(value){
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return true;
    if (scheduleViewMode === 'gantt') return true;
    const anchor = new Date(scheduleAnchorDate);
    if (scheduleViewMode === 'month') return date.getFullYear() === anchor.getFullYear() && date.getMonth() === anchor.getMonth();
    if (scheduleViewMode === 'day' || scheduleViewMode === 'scheduling-day') return scheduleLocalDate(date) === scheduleLocalDate(anchor);
    const days = scheduleViewMode === '4day' ? 4 : 7;
    const start = scheduleViewMode === '4day' ? scheduleAddDays(anchor, 0) : scheduleStartOfWeek(anchor);
    const end = scheduleAddDays(start, days);
    return date >= start && date < end;
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
    const type = productionResourceType(event);
    if (type !== 'labor' && (type || !isProjectWorkEvent(event) || isMaterialDeliveryEvent(event))) return '';
    const draft = workScheduleDrafts.get(String(event.id || '')) || null;
    const assignmentSource = draft ? { ...event, ...draft } : event;
    const resources = workAssignmentResources(assignmentSource);
    const assignees = eventWorkAssignees(assignmentSource);
    const selectedId = workCrewId(assignmentSource);
    const shownId = selectedId || assignees[0]?.id || '';
    const selectedResource = resources.find((resource) => String(resource.id || '') === shownId) || null;
    // Several crews read "Alpha Crew +1".
    const selectedName = assignees.length > 1 ? workAssigneesLabel(assignees) : (selectedResource?.name || workCrewName(assignmentSource) || assignees[0]?.name || 'Unassigned');
    if (!canEditSchedule()) return `<div class="r-production-resource-assignment"><span>${escapeHtml(workforceTerm('resource_group'))}</span><span class="r-production-resource-crew-button ${shownId ? '' : 'unassigned'}" aria-disabled="true"><span>${escapeHtml(selectedName)}</span></span></div>`;
    return `<div class="r-production-resource-assignment"><span>${escapeHtml(workforceTerm('resource_group'))}</span><button type="button" class="r-production-resource-crew-button ${shownId ? '' : 'unassigned'}" data-production-resource-crew="${escapeHtml(event.id || '')}" aria-haspopup="listbox" aria-expanded="false"><span>${escapeHtml(selectedName)}</span><i class="fas fa-chevron-down"></i></button></div>`;
  }

  function productionResourceTilesHtml(){
    const events = projectProductionEvents()
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
        : (scheduled ? `${workRangeLabel(event)}${materialEventIsLocked(event) ? ' · Locked' : ''}` : 'Waiting to be scheduled');
      const assignment = productionCrewSelectHtml(event);
      return `<div class="r-schedule-tile r-material-tile r-production-resource-tile ${assignment ? '' : 'no-assignment'} ${complete ? 'complete' : 'incomplete'} ${active ? 'active' : ''}" style="--material-list-color:${escapeHtml(materialListIdentityColor(event))}">
        <button type="button" class="r-production-resource-main" data-production-resource-event="${escapeHtml(event.id || '')}">
          <div class="r-schedule-tile-title"><i class="fas ${escapeHtml(productionResourceIcon(event))}"></i>${material ? (String(escapeHtml(materialDeliveryTitle(event))) + "<span class=\"r-schedule-tile-kind\">" + (globalThis.PlatformLanguage?.htmlText("project-schedule","m_6450c5cf07510a"," — delivery") ?? " — delivery") + "</span>") : escapeHtml(event.title || productionResourceLabel(event))}</div>
          <div class="r-schedule-tile-meta">${escapeHtml(stateLabel)}</div>
        </button>
        ${assignment}
      </div>`;
    }).join('');
  }

  function productionTilesHtml(){
    const tiles = productionResourceTilesHtml();
    return tiles ? `<div class="r-schedule-tile-list">${tiles}</div>` : `<div class="r-schedule-empty-small">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_eb671826d74670","No production items for this project.") ?? "No production items for this project.")}</div>`;
  }

  function leftContentRoot(){
    if (!state.sidebarRoot) return null;
    let list = state.sidebarRoot.querySelector('#psSidebarList');
    if (!list) {
      state.sidebarRoot.innerHTML = `
        <div class="r-step-shell" style="grid-template-rows:1fr"><div class="r-step-inner"><div class="r-step-body">
          <label id="psSidebarLabel">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_fc05a804bd034c","Schedule") ?? "Schedule")}</label>
          <div class="r-proposal-listing" id="psSidebarList"></div>
        </div></div></div>
      `;
      list = state.sidebarRoot.querySelector('#psSidebarList');
    }
    return list;
  }

  function setScheduleWorkspaceChrome(active){
    const overlay=state.context?.overlayRoot || state.context?.roots?.overlay || document.getElementById('rOverlay');
    overlay?.classList.toggle('schedule-workspace',active);
  }

  function clearScheduleLeft(){
    const list = state.sidebarRoot?.querySelector?.('#psSidebarList');
    list?.querySelector?.('.r-schedule-left-shell')?.remove();
    const tab = String(state.host?.getActivePreviewTab?.() || state.context?.activeTab || '');
    const keepSharedRail = tab === 'proposal' || tab === 'materials' || tab === 'money';
    if (!keepSharedRail && list && !list.innerHTML.trim()) {
      state.sidebarRoot.classList.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
    }
  }

  function contextScheduleActive(context = {}){
    if (context.active !== undefined) return context.active !== false;
    if (context.activeTab !== undefined) return String(context.activeTab || '') === 'schedule';
    return false;
  }

  function leftStatusHtml(){
    // A selected production item or delivery is described by the placement
    // banner above the calendar.
    if (materialScheduleModeActive) return '';
    if (scheduleModeActive) {
      const assignment = salesAssignmentSelectHtml();
      return `<section class="r-schedule-section">
        <div class="r-schedule-section-head">
          <div class="r-schedule-section-title"><i class="fas fa-calendar-check"></i>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_da2084e4486b76"," Sales Appointment") ?? " Sales Appointment")}</div>
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
    const frequency = String(recurrence.frequency || 'monthly').toLowerCase();
    const units = { daily:'days', weekly:'weeks', monthly:'months', quarterly:'quarters', yearly:'years' };
    const readable = frequency.replace(/_/g, ' ');
    const cadence = every === 1 ? readable.charAt(0).toUpperCase() + readable.slice(1) : `Every ${every} ${units[frequency] || readable}`;
    const count = Number(recurrence.occurrence_count || 0);
    const ending = count > 0
      ? ` · ${count} occurrence${count === 1 ? '' : 's'}`
      : (recurrence.end_at ? ` · until ${new Date(recurrence.end_at).toLocaleDateString(globalThis.PlatformLanguage?.formatLocale?.())}` : ' · ongoing');
    return `${cadence}${ending}`;
  }

  function recurringTilesHtml(){
    if (scheduleRecurrenceLoading && !scheduleRecurringSeries.length) return `<div class="r-schedule-empty-small">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_0d5c49d331e456","Loading recurring items…") ?? "Loading recurring items…")}</div>`;
    if (!scheduleRecurringSeries.length) return `<div class="r-schedule-empty-small">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_0763a6948a13e2","No recurring items yet.") ?? "No recurring items yet.")}</div>`;
    return `<div class="r-schedule-tile-list">${scheduleRecurringSeries.map((series) => `
      <button type="button" class="r-schedule-tile r-recurrence-tile ${String(series.status || '') === 'cancelled' ? 'cancelled' : ''}" data-edit-recurrence="${escapeHtml(series.id || '')}" title="${escapeHtml(series.title || 'Recurring item')}">
        <div class="r-recurrence-meta"><div class="r-schedule-tile-title"><i class="fas fa-repeat"></i>${escapeHtml(series.title || (globalThis.PlatformLanguage?.text("project-schedule","m_e5d043f205f6a6","Recurring item") ?? "Recurring item"))}</div><span class="r-recurrence-pill ${String(series.status || '') === 'cancelled' ? 'cancelled' : ''}">${escapeHtml(series.status || 'active')}</span></div>
        <div class="r-schedule-tile-meta">${escapeHtml(recurrenceLabel(series))}</div>
      </button>`).join('')}</div>`;
  }

  async function loadRecurringSeries({ refresh = false } = {}){
    const project = currentSchedulingProject();
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


  /* ── Linked items (dependencies and scope rules) ───────────────────────
   * The same flow as the global Scheduling tab: work out what a move does to
   * linked items, ask once BEFORE saving (Cancel keeps everything where it
   * was), then save the move and the linked moves together. Locked or
   * completed items are never moved; moving past them asks first. */
  function projectRelatedRescheduleImpact(event = {}, range = {}){
    const Scheduling = window.PlatformScheduling;
    if (!event?.id || !range?.start || typeof Scheduling?.relatedScheduleRescheduleImpact !== 'function') return { drafts:[], blocked:[] };
    const related = scheduleProjectEvents().filter((item) => materialEventIsScheduled(item) || String(item.id || '') === String(event.id || ''));
    try {
      return Scheduling.relatedScheduleRescheduleImpact(event, related, range, activeBaseProject || {}, [], { config:scheduleCachedConfig || null });
    } catch (error) {
      console.warn('Linked schedule items could not be checked.', error);
      return { drafts:[], blocked:[] };
    }
  }
  function scheduleItemNames(items = [], { dates = false } = {}){
    const names = items.map((item) => {
      const name = `“${String(item?.title || '').trim() || 'Untitled item'}”`;
      if (!dates) return name;
      // Where a linked item would go, e.g. “Tear-off” (to Tue, Sep 29).
      const start = new Date(item?.start || item?.start_at || 0);
      if (!Number.isFinite(start.getTime()) || !start.getTime()) return name;
      const allDay = item?.all_day !== false && String(item?.schedule_granularity || '') !== 'time';
      const when = allDay
        ? start.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' })
        : start.toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
      return `${name} (to ${when})`;
    });
    if (names.length <= 1) return names.join('');
    if (names.length > 3) return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  async function chooseProjectRelatedReschedule(event = {}, drafts = [], blocked = [], verb = 'Moving'){
    const fixed = (Array.isArray(blocked) ? blocked : []).map((entry) => entry?.event || entry).filter(Boolean);
    const count = drafts.length;
    if (!count && !fixed.length) return 'no';
    const choose = window.Portal?.ui?.choose || window.PlatformUI?.choose;
    if (typeof choose !== 'function') return 'no';
    const subject = `“${scheduleEventDisplayTitle(event) || 'This item'}”`;
    const fixedNote = fixed.length
      ? ` ${scheduleItemNames(fixed)} ${fixed.length === 1 ? 'is' : 'are'} locked or completed and won't move, so ${fixed.length === 1 ? 'its' : 'their'} dependency will be out of order.`
      : '';
    const cancelLabel = (globalThis.PlatformLanguage?.text("scheduling","m_cbef679b21abb4","Cancel") ?? "Cancel");
    if (!count) {
      return await choose(`${verb} ${subject} breaks a dependency.${fixedNote}`, [
        { value:'cancel', label:cancelLabel },
        { value:'no', label:'Move anyway', primary:true }
      ], { title:'Dependency conflict', defaultFocus:'cancel' }) || 'cancel';
    }
    return await choose(`${verb} ${subject} affects ${count} linked item${count === 1 ? '' : 's'}: ${scheduleItemNames(drafts, { dates:true })}. Move ${count === 1 ? 'it' : 'them'} too so dependencies and scheduling rules stay in order?${fixedNote}`, [
      { value:'cancel', label:cancelLabel },
      { value:'no', label:(globalThis.PlatformLanguage?.text("scheduling","m_2f0222913078f4","No") ?? "No") },
      { value:'yes', label:(globalThis.PlatformLanguage?.text("scheduling","m_549ccd0e27a3d4","Yes") ?? "Yes"), primary:true }
    ], { title:(globalThis.PlatformLanguage?.text("scheduling","m_64b37c5695aa34","Move related schedule items") ?? "Move related schedule items") }) || 'cancel';
  }
  /* Placing an item that isn't on the calendar yet, as in the global tab:
   * linked work the placement puts out of order is flagged before saving —
   * Cancel / Place anyway / Move them too (only later, scheduled successors
   * move; predecessors are never pulled earlier by a placement). */
  async function resolveProjectPlacementConflicts(event = {}, range = {}){
    const Scheduling = window.PlatformScheduling;
    const none = { cancelled:false, choice:'no', changes:[], leftOutOfOrder:0 };
    if (!Scheduling?.dependencyViolations || !Scheduling?.updateProjectEventRange || !event?.id || !range?.start) return none;
    const placed = { ...Scheduling.updateProjectEventRange(event, { start:new Date(range.start), end:new Date(range.end || range.start), all_day:range.all_day, schedule_granularity:range.schedule_granularity }), status:'scheduled' };
    const placedId = String(event.id);
    const effective = scheduleProjectEvents().map((item) => String(item.id || '') === placedId ? { ...item, ...placed } : item);
    let violations = [];
    try { violations = Scheduling.dependencyViolations(effective, { config:scheduleCachedConfig || null }); } catch (_) { return none; }
    violations = violations.filter((edge) => (String(edge.from || '') === placedId) !== (String(edge.to || '') === placedId));
    if (!violations.length) return none;
    const byId = new Map(effective.map((item) => [String(item.id || ''), item]));
    const fixed = (item) => materialEventIsLocked(item) || Scheduling.eventIsFixed?.(item) === true || ['completed', 'complete', 'done'].includes(String(item?.status || '').toLowerCase());
    const movable = new Map();
    violations.forEach((edge) => {
      const successor = byId.get(String(edge.to || ''));
      if (!successor || String(successor.id || '') === placedId || fixed(successor)) return;
      const earliest = new Date(edge.earliest_start || 0);
      const start = Scheduling.eventStart?.(successor);
      if (!Number.isFinite(earliest.getTime()) || !earliest.getTime() || !start) return;
      const previous = movable.get(String(successor.id || ''));
      if (previous && new Date(previous.start_at || previous.start) >= earliest) return;
      const end = Scheduling.eventEnd?.(successor) || scheduleAddDays(start, 1);
      const allDay = successor.all_day === true || String(successor.schedule_granularity || '').toLowerCase() === 'date';
      const nextStart = allDay ? (earliest.getHours() || earliest.getMinutes() ? scheduleAddDays(earliest, 1) : earliest) : earliest;
      movable.set(String(successor.id || ''), { ...Scheduling.updateProjectEventRange(successor, { start:nextStart, end:new Date(nextStart.getTime() + (end.getTime() - start.getTime())), all_day:allDay, schedule_granularity:allDay ? 'date' : 'time' }), status:'scheduled', updated_at:new Date().toISOString() });
    });
    const describe = violations.slice(0, 3).map((edge) => {
      const from = byId.get(String(edge.from || ''));
      const to = byId.get(String(edge.to || ''));
      return `“${String(to?.title || '').trim() || 'An item'}” would start before “${String(from?.title || '').trim() || 'the item'}” it follows`;
    });
    const more = violations.length > 3 ? ` and ${violations.length - 3} more` : '';
    const choices = [
      { value:'cancel', label:(globalThis.PlatformLanguage?.text("scheduling","m_cbef679b21abb4","Cancel") ?? "Cancel") },
      { value:'anyway', label:'Place anyway', primary:!movable.size },
      ...(movable.size ? [{ value:'move', label:`Move ${movable.size === 1 ? 'it' : 'them'} too`, primary:true }] : [])
    ];
    const message = `Placing “${scheduleEventDisplayTitle(event) || 'this item'}” puts linked work out of order: ${describe.join('; ')}${more}.${movable.size ? ` Move the ${movable.size === 1 ? 'later item' : `${movable.size} later items`}, ${scheduleItemNames([...movable.values()], { dates:true })}, so the order holds?` : ''}`;
    const choose = window.Portal?.ui?.choose || window.PlatformUI?.choose;
    const choice = typeof choose === 'function'
      ? await choose(message, choices, { title:'Dependency conflict', defaultFocus:'cancel' })
      : ((await scheduleConfirmUi(message, { title:'Dependency conflict', okLabel:'Place anyway', cancelLabel:'Cancel', defaultFocus:'cancel' })) ? 'anyway' : 'cancel');
    if (!choice || choice === 'cancel') return { ...none, cancelled:true, choice:'cancel' };
    if (choice === 'move') return { cancelled:false, choice:'yes', changes:[...movable.values()], leftOutOfOrder:Math.max(0, violations.length - movable.size) };
    return { cancelled:false, choice:'no', changes:[], leftOutOfOrder:violations.length };
  }
  // Linked items a move would put on a day that has already passed are
  // named and confirmed, like placing an item there directly.
  async function confirmPastRelatedChanges(changes = []){
    const past = (Array.isArray(changes) ? changes : []).filter((item) => scheduleIsPastDay(item.start_at || item.start));
    if (!past.length) return true;
    return !!(await scheduleConfirmUi(`Moving the linked items puts ${scheduleItemNames(past, { dates:true })} in the past. Place ${past.length === 1 ? 'it' : 'them'} there anyway?`, { title:'Place in the past?', okLabel:'Place anyway', cancelLabel:'Choose another date', defaultFocus:'cancel' }));
  }
  // -> { cancelled, choice, changes, leftOutOfOrder }
  async function resolveProjectRelatedReschedule(event = {}, range = {}, { verb = 'Moving' } = {}){
    const Scheduling = window.PlatformScheduling;
    // An item placed for the first time only checks its dependency order.
    if (!materialEventIsScheduled(scheduleProjectEvents().find((item) => String(item.id || '') === String(event?.id || '')) || event)) {
      return resolveProjectPlacementConflicts(event, range);
    }
    const impact = projectRelatedRescheduleImpact(event, range);
    const asked = impact.drafts.length || impact.blocked.length;
    const choice = asked ? await chooseProjectRelatedReschedule(event, impact.drafts, impact.blocked, verb) : 'no';
    let cancelled = choice === 'cancel' || choice === false || choice == null;
    if (!cancelled && choice === 'yes' && !(await confirmPastRelatedChanges(impact.drafts))) cancelled = true;
    const changes = !cancelled && choice === 'yes' && Scheduling?.updateProjectEventRange ? impact.drafts.map((draft) => {
      const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(draft.id || draft.event_id || '')) || draft;
      return {
        ...Scheduling.updateProjectEventRange(source, {
          start:new Date(draft.start || draft.start_at),
          end:new Date(draft.end || draft.end_at),
          all_day:draft.all_day !== false,
          schedule_granularity:draft.schedule_granularity || (draft.all_day === false ? 'time' : 'date')
        }),
        status:'scheduled',
        updated_at:new Date().toISOString()
      };
    }) : [];
    const leftOutOfOrder = cancelled ? 0 : impact.blocked.length + (choice === 'yes' ? 0 : impact.drafts.length);
    return { cancelled, choice:cancelled ? 'cancel' : choice, changes, leftOutOfOrder };
  }
  function relatedMoveNote(related = null){
    if (!related) return '';
    const moved = related.changes?.length || 0;
    const left = related.leftOutOfOrder || 0;
    return `${moved ? ` ${moved} linked item${moved === 1 ? ' was' : 's were'} moved too.` : ''}${left ? ` ${left} linked item${left === 1 ? ' is' : 's are'} now out of dependency order.` : ''}`;
  }
  // Shows the linked items at their new dates at once (before their saves),
  // remembering the stored copies so a failed save puts one back.
  function showRelatedChangesLocally(related = null){
    if (!related?.changes?.length) return;
    related.sources = related.sources || new Map();
    related.changes.forEach((change) => {
      const id = String(change.id || '');
      if (!related.sources.has(id)) related.sources.set(id, scheduleProjectEvents().find((item) => String(item.id || '') === id) || null);
      upsertLocalProjectEvent(change);
    });
  }
  async function saveRelatedRescheduleChanges(related = null){
    for (const change of related?.changes || []) {
      const source = related.sources?.get(String(change.id || '')) || scheduleProjectEvents().find((item) => String(item.id || '') === String(change.id || '')) || change;
      const version = beginScheduleEventSave(change.id);
      upsertLocalProjectEvent(change);
      const saved = await saveProjectEventQuiet(change, { successTitle:'', failureTitle:'Linked item not moved', broadcast:false, preserveLocalEvents:true, mutationVersion:version });
      if (!saved && scheduleEventSaveVersions.get(String(change.id || '')) === version) upsertLocalProjectEvent(source);
    }
  }

  /* A recurring occurrence moved on a calendar: only this one (kept as an
   * exception), this and the following ones, or the whole series. */
  // Same question as the global tab: "Move to <time> — which events?", with
  // "This event" the safe default and short labels that fit one row.
  async function chooseRecurringMoveScope(event = {}, next = {}){
    const choose = window.Portal?.ui?.choose || window.PlatformUI?.choose;
    if (typeof choose !== 'function') return 'this';
    const text = (key, fallback) => globalThis.PlatformLanguage?.text("scheduling", key, fallback) ?? fallback;
    const nextStart = new Date(next.start_at || next.start || 0);
    const when = nextStart.getTime() && Number.isFinite(nextStart.getTime()) ? `Move to ${workRangeLabel(next)} — which events?` : 'Which events should move?';
    const choice = await choose(`“${scheduleEventDisplayTitle(event)}” repeats. ${when}`, [
      { value:'cancel', label:text('m_cbef679b21abb4', 'Cancel') },
      { value:'all', label:text('m_scope_all', 'All events') },
      { value:'following', label:text('m_scope_following_short', 'This & following') },
      { value:'this', label:text('m_scope_this', 'This event'), primary:true, default:true }
    ], { title:text('m_scope_move_title', 'Move recurring event'), defaultFocus:'this' });
    return ['this', 'following', 'all'].includes(choice) ? choice : 'cancel';
  }
  async function saveRecurringSeriesMove(source = {}, next = {}, scope = 'all'){
    const api = window.PlatformAPI?.projects;
    const seriesId = String(source.recurrence_series_id || '').trim();
    if (!seriesId || typeof api?.updateRecurrenceSeries !== 'function') {
      renderSchedulePanelPreservingScroll();
      showToast('Could not move the series', 'Recurring series are not available.', false);
      return null;
    }
    try {
      scheduleMutationSerial += 1;
      await api.updateRecurrenceSeries(scheduleOrgId(), seriesId, {
        scope:scope === 'following' ? 'following' : 'all',
        event_id:String(source.id || ''),
        occurrence_key:String(source.recurrence_occurrence_key || ''),
        occurrence_start_at:String(next.start_at || next.start || ''),
        occurrence_end_at:String(next.end_at || next.end || '')
      });
      scheduleMutationSerial += 1;
      upsertLocalProjectEvent(next);
      renderSchedulePanelPreservingScroll();
      await loadRecurringSeries({ refresh:true });
      await refreshProjectFromServer({ render:true });
      notifyScheduleChanged();
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      showToast(scope === 'following' ? 'This and following events moved' : 'All events moved', 'Occurrences you changed on their own keep their own times.', true);
      return true;
    } catch (error) {
      upsertLocalProjectEvent(source);
      renderSchedulePanelPreservingScroll();
      showToast('Could not move the series', error?.message || 'Try again.', false);
      return null;
    }
  }
  function scheduleRangeMoved(source = {}, next = {}){
    const Scheduling = window.PlatformScheduling;
    const before = [Scheduling?.eventStart?.(source), Scheduling?.eventEnd?.(source)].map((date) => date?.getTime?.() || 0);
    const after = [new Date(next.start_at || next.start || 0).getTime(), new Date(next.end_at || next.end || 0).getTime()];
    return !materialEventIsScheduled(source) || before[0] !== after[0] || before[1] !== after[1];
  }

  // Saves a moved or resized item straight away, like the global Scheduling
  // tab. Only Routing rows carry a resource: other surfaces keep the item's
  // existing assignment and schedule flags. Routing lanes of a multi-crew
  // item pass the explicit assignee list (options.assignees).
  async function commitWorkScheduleRange(event = {}, range = {}, options = {}){
    if (!requireScheduleEdit()) return null;
    const Scheduling = window.PlatformScheduling;
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(event.id || '')) || event;
    if (!Scheduling?.updateProjectEventRange || !source?.id || !range?.start || !range?.end) return null;
    if (materialEventIsLocked(source)) {
      renderSchedulePanelPreservingScroll();
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_88e13d64071885","Schedule locked") ?? "Schedule locked"), (globalThis.PlatformLanguage?.text("scheduling","m_0233f74e9faf1e","Unlock this item before moving it.") ?? "Unlock this item before moving it."), false);
      return null;
    }
    const resourceKeys = ['resource_id', 'assigned_resource_id', 'assigned_crew_id', 'crew_id'];
    const rangeAssigns = resourceKeys.some((key) => Object.prototype.hasOwnProperty.call(range, key));
    const rangeResourceId = String(range.resource_id || range.assigned_resource_id || range.assigned_crew_id || range.crew_id || '').trim();
    const rangeResource = scheduleCachedWorkResources.find((resource) => String(resource.id || '') === rangeResourceId) || null;
    const scopeId = String(source.scope_template_id || '').trim();
    const capabilityIds = Array.isArray(rangeResource?.capability_scope_ids) ? rangeResource.capability_scope_ids.map(String) : [];
    if (rangeAssigns && scopeId && rangeResourceId && capabilityIds.length && !capabilityIds.includes(scopeId)) {
      renderSchedulePanelPreservingScroll();
      showToast(((v0) => globalThis.PlatformLanguage?.text("project-schedule","m_20b9cbe18eee54",`${v0} unavailable`,{v0}) ?? `${v0} unavailable`)(workResourceLabel()), ((v0) => globalThis.PlatformLanguage?.text("project-schedule","m_e3160ab68875db",`That ${v0} is not configured for this scope.`,{v0}) ?? `That ${v0} is not configured for this scope.`)(workResourceLabel()), false);
      return null;
    }
    const assignment = Array.isArray(options.assignees)
      ? workAssigneesPayload(source, options.assignees)
      : (rangeAssigns ? workAssigneesPayload(source, rangeResourceId ? [{ id:rangeResourceId, kind:rangeResource?.subject_type || rangeResource?.resource_kind || 'resource_group', name:rangeResource?.name || '' }, ...eventWorkAssignees(source).slice(1).filter((ref) => ref.id !== rangeResourceId)] : []) : {});
    const moved = Scheduling.updateProjectEventRange(source, { ...range, ...assignment });
    const allDay = moved.all_day !== false && moved.schedule_granularity !== 'time';
    const next = {
      ...moved,
      ...assignment,
      start_date:allDay ? scheduleLocalDate(new Date(moved.start_at)) : '',
      end_date:allDay ? scheduleLocalDate(scheduleAddDays(new Date(moved.end_at), -1)) : '',
      schedule_history:[...(Array.isArray(source.schedule_history) ? source.schedule_history : []), scheduleHistoryEntry(source, 'rescheduled')].filter(Boolean),
      status:'scheduled',
      updated_at:new Date().toISOString()
    };
    const moved_ = scheduleRangeMoved(source, next);
    // Moving a placed item onto a day that has passed asks first.
    if (moved_ && !options.skipRelated && !options.pastConfirmed && !(await confirmPastMove(source, next.start_at))) {
      renderSchedulePanelPreservingScroll();
      return null;
    }
    // A recurring occurrence asks which part of its series moves.
    if (moved_ && !options.skipRelated && String(source.recurrence_series_id || '').trim() && materialEventIsScheduled(source)) {
      const scope = await chooseRecurringMoveScope(source, next);
      if (scope === 'cancel') {
        renderSchedulePanelPreservingScroll();
        return null;
      }
      if (scope === 'following' || scope === 'all') return saveRecurringSeriesMove(source, next, scope);
    }
    const related = moved_ && !options.skipRelated ? await resolveProjectRelatedReschedule(source, { start:next.start_at, end:next.end_at }, { verb:materialEventIsScheduled(source) ? 'Moving' : 'Scheduling' }) : null;
    if (related?.cancelled) {
      renderSchedulePanelPreservingScroll();
      return null;
    }
    const mutationVersion = beginScheduleEventSave(next.id);
    upsertLocalProjectEvent(next);
    // Linked items show at their new dates together with the moved item.
    showRelatedChangesLocally(related);
    workScheduleDrafts.delete(String(source.id || ''));
    if (activeWorkScheduleDraftId === String(source.id || '')) setActiveWorkDraftId('');
    if (options.skipRelated) renderScheduleLeft();
    else renderSchedulePanelPreservingScroll();
    const title = scheduleEventDisplayTitle(next);
    // One edge kept in place (the other dragged) is a resize, not a move.
    const edgeTime = (value) => { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.getTime() : NaN; };
    const sameEdge = (before, after) => (edgeTime(before.start_at || before.start) === edgeTime(after.start_at || after.start)) !== (edgeTime(before.end_at || before.end) === edgeTime(after.end_at || after.end));
    const assignedNames = eventWorkAssignees(next).map((ref) => ref.name).filter(Boolean);
    const saved = await saveProjectEventQuiet(next, {
      successTitle: options.quiet ? '' : (isSalesAppointmentEvent(next) ? 'Appointment updated' : 'Schedule updated'),
      successMessage: (rangeAssigns || Array.isArray(options.assignees)) && !moved_
        ? (assignedNames.length ? `${assignedNames.join(', ')} ${assignedNames.length === 1 ? 'is' : 'are'} assigned.` : 'The production item is unassigned.')
        : `“${title}” ${!materialEventIsScheduled(source) ? 'is scheduled for' : (sameEdge(source, next) ? 'was resized to' : 'moved to')} ${workRangeLabel(next)}.${relatedMoveNote(related)}`,
      failureTitle: 'Schedule not updated',
      broadcast: false,
      preserveLocalEvents: true,
      mutationVersion
    });
    if (!saved && (!mutationVersion || scheduleEventSaveVersions.get(String(next.id || '')) === mutationVersion)) {
      upsertLocalProjectEvent(source);
      // The move wasn't saved, so the linked items stay where they were.
      related?.sources?.forEach((original) => { if (original) upsertLocalProjectEvent(original); });
      renderSchedulePanelPreservingScroll();
    }
    if (saved) {
      // The caller's follow-up (e.g. Undo on the toast just shown) comes
      // with the item's own save, not after the linked items' saves.
      saved.related = related;
      options.afterSave?.(saved, related);
      await saveRelatedRescheduleChanges(related);
      await persistGroupRollups([next, ...(related?.changes || [])]);
      if (related?.changes?.length || scheduleEventIsGroup(scheduleProjectEvents().find((item) => String(item.id || '') === String(next.parent_event_id || '')) || {})) renderSchedulePanelPreservingScroll();
    }
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
  // Timeline moves use the same linked-item flow as the calendar (asked
  // before saving, with Cancel and the locked-predecessor conflict).
  async function saveProjectGanttRange(event, range, options = {}){
    if (!requireScheduleEdit()) return null;
    const Scheduling = window.PlatformScheduling;
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(event?.id || '')) || event;
    if (!Scheduling || !source?.id || !range?.start) return;
    if (!isMaterialDeliveryEvent(source) && (Scheduling.eventIsLocked?.(source) || source.schedule_locked === true || source.locked === true)) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_88e13d64071885","Schedule locked") ?? "Schedule locked"), (globalThis.PlatformLanguage?.text("scheduling","m_0233f74e9faf1e","Unlock this item before moving it.") ?? "Unlock this item before moving it."), false);
      renderSchedulePanelPreservingScroll();
      return;
    }
    // A section bar moves the items inside it together.
    if (scheduleEventIsGroup(source) && await moveProjectScheduleGroup(source, range)) return;
    const placing = !materialEventIsScheduled(source);
    // A day on a waiting item's lane places it with its own planned length
    // and nature (a timed job keeps its hours, a 2-day job gets 2 days); a
    // drag across days keeps the days it covered.
    if (placing && options.placing && !isMaterialDeliveryEvent(source)) {
      const natural = schedulePlacementNaturalRange(source, range);
      const draggedDays = options.meta?.source === 'lane-drag' && range.all_day !== false
        && Math.round((new Date(range.end) - new Date(range.start)) / 86400000) > 1;
      if (!draggedDays || natural.all_day === false) range = { ...range, start:natural.start, end:natural.end, all_day:natural.all_day, schedule_granularity:natural.schedule_granularity };
    }
    if (options.placing && placing && !(await confirmPastPlacement(source, range.start))) {
      renderSchedulePanelPreservingScroll();
      return;
    }
    // Moving a placed item onto a day that has passed asks first.
    if (!placing && !(await confirmPastMove(source, range.start))) {
      renderSchedulePanelPreservingScroll();
      return;
    }
    // What the linked items looked like before, so Undo can put them back.
    const before = new Map(scheduleProjectEvents().map((item) => [String(item.id || ''), item]));
    // One click on a waiting item's lane placed it: the toast that says so
    // offers a one-click Undo (added with that toast, not after the linked
    // items' saves).
    const afterSave = placing && options.undo
      ? (saved, related) => appendScheduleToastAction('Undo', () => undoProjectPlacement(source, (related?.changes || []).map((change) => ({ change, original:before.get(String(change.id || '')) })).filter((entry) => entry.original)))
      : undefined;
    const saved = isMaterialDeliveryEvent(source)
      ? await saveMaterialScheduleRange(source, { ...range, all_day:true, schedule_granularity:'date' }, { pastConfirmed:true, afterSave })
      : await commitWorkScheduleRange(source, range, { pastConfirmed:true, afterSave });
    renderSchedulePanelPreservingScroll();
    // The Undo is on the toast still showing (re-add it if a later toast,
    // e.g. about the linked items, replaced it).
    if (saved && afterSave && document.querySelector('#fmToast.show') && !document.querySelector('#fmToast.show .r-schedule-toast-action')) afterSave(saved, saved.related);
  }
  /* Adds one action button (e.g. Undo) to the toast just shown; the next
   * toast replaces the text and the button with it. */
  function appendScheduleToastAction(label, onAction){
    const holder = document.getElementById('fmToastT2');
    if (!holder || typeof onAction !== 'function') return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'r-schedule-toast-action';
    button.textContent = label;
    button.style.cssText = 'margin-left:8px;border:0;background:none;padding:0;color:var(--primary-readable,var(--primary,#d93025));font:inherit;font-weight:950;text-decoration:underline;cursor:pointer';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      window.PlatformUI?.hideToast?.();
      document.getElementById('fmToast')?.classList.remove('show');
      onAction();
    }, { once:true });
    holder.appendChild(button);
  }
  // Back to exactly how it was before the lane click: no date again.
  // Linked items that "Move it too" pushed later go back too (only those
  // still where the placement put them).
  async function undoProjectPlacement(previous = {}, linked = []){
    const stored = scheduleProjectEvents().find((item) => String(item.id || '') === String(previous.id || ''));
    if (!stored || !materialEventIsScheduled(stored)) return;
    const restoreSchedule = (current, original) => ({
      ...current,
      all_day:original.all_day,
      schedule_granularity:original.schedule_granularity || '',
      start:original.start || '', end:original.end || '',
      start_at:original.start_at || '', end_at:original.end_at || '',
      start_date:original.start_date || '', end_date:original.end_date || '',
      ...(original.duration_minutes !== undefined ? { duration_minutes:original.duration_minutes } : {}),
      status:String(original.status || '').trim() || (materialEventIsScheduled(original) ? 'scheduled' : 'unscheduled'),
      updated_at:new Date().toISOString()
    });
    const restored = restoreSchedule(stored, previous);
    const startOf = (item) => window.PlatformScheduling?.eventStart?.(item)?.getTime?.() || 0;
    const linkedRestores = (Array.isArray(linked) ? linked : []).map(({ change, original }) => {
      const current = scheduleProjectEvents().find((item) => String(item.id || '') === String(change?.id || ''));
      if (!current || !original || startOf(current) !== startOf(change)) return null;
      return { current, next:restoreSchedule(current, original) };
    }).filter(Boolean);
    const mutationVersion = beginScheduleEventSave(restored.id);
    upsertLocalProjectEvent(restored);
    linkedRestores.forEach(({ next }) => upsertLocalProjectEvent(next));
    renderSchedulePanelPreservingScroll();
    const saved = await saveProjectEventQuiet(restored, {
      successTitle:'',
      failureTitle:'Undo failed',
      broadcast:false,
      preserveLocalEvents:true,
      mutationVersion
    });
    if (!saved) {
      upsertLocalProjectEvent(stored);
      linkedRestores.forEach(({ current }) => upsertLocalProjectEvent(current));
      renderSchedulePanelPreservingScroll();
      return;
    }
    let movedBack = 0;
    for (const { current, next } of linkedRestores) {
      const version = beginScheduleEventSave(next.id);
      const linkedSaved = await saveProjectEventQuiet(next, { successTitle:'', failureTitle:'Linked item not moved back', broadcast:false, preserveLocalEvents:true, mutationVersion:version });
      if (linkedSaved) movedBack += 1;
      else if (scheduleEventSaveVersions.get(String(next.id || '')) === version) upsertLocalProjectEvent(current);
    }
    await persistGroupRollups([restored, ...linkedRestores.map(({ next }) => next)]);
    renderSchedulePanelPreservingScroll();
    showToast('Scheduling undone', `“${scheduleEventDisplayTitle(restored)}” is waiting to be scheduled again.${movedBack ? ` ${movedBack} linked item${movedBack === 1 ? ' was' : 's were'} moved back.` : ''}`, true);
  }
  /* Dragging a section (auto-rollup group) bar moves the items in it by the
   * same offset. False when the caller should save the section record itself
   * (manual sections, or sections without placed items). */
  async function moveProjectScheduleGroup(group = {}, range = {}){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling?.groupMoveDrafts || Scheduling.groupRollupMode?.(group) === 'manual') return false;
    const move = Scheduling.groupMoveDrafts(scheduleProjectEvents(), group, range);
    if (!move.items?.length) return false;
    const refuse = (title, message) => {
      showToast(title, message, false);
      renderSchedulePanelPreservingScroll();
      return true;
    };
    if (move.resized) return refuse('Section not resized', 'A section spans its items. Resize or move the items inside it instead.');
    if (!move.delta) { renderSchedulePanelPreservingScroll(); return true; }
    if (move.blocked?.length) return refuse('Section not moved', `${scheduleItemNames(move.blocked)} ${move.blocked.length === 1 ? 'is' : 'are'} locked or completed, so this section can't move as a whole. Move its other items individually.`);
    const changes = move.drafts.map((draft) => ({ ...draft, status:'scheduled', updated_at:new Date().toISOString() }));
    if (changes.some((item) => scheduleIsPastDay(item.start_at || item.start)) && !(await confirmPastRelatedChanges(changes))) {
      renderSchedulePanelPreservingScroll();
      return true;
    }
    const related = { changes };
    showRelatedChangesLocally(related);
    renderSchedulePanelPreservingScroll();
    await saveRelatedRescheduleChanges(related);
    await persistGroupRollups(changes);
    renderSchedulePanelPreservingScroll();
    showToast('Section moved', `${changes.length} item${changes.length === 1 ? '' : 's'} in “${scheduleEventDisplayTitle(group)}” moved together.`, true);
    notifyScheduleChanged();
    return true;
  }
  function scheduleSectionChildren(group = {}){
    const Scheduling = window.PlatformScheduling;
    return scheduleProjectEvents().filter((item) => String(Scheduling?.eventParentId?.(item) || item.parent_event_id || '') === String(group.id || ''));
  }
  /* A section (schedule group) is a named container whose dates follow its
   * items: its popover names it and offers Rename and Delete (the items stay
   * on the schedule, outside the section). No crew or customer sharing. */
  function openScheduleSectionPopover(group = {}, anchor = null){
    const stored = scheduleProjectEvents().find((item) => String(item.id || '') === String(group.id || '')) || group;
    const display = scheduleDisplayEvents().find((item) => String(item.id || '') === String(stored.id || '')) || stored;
    const children = scheduleSectionChildren(stored);
    const canEdit = canEditSchedule();
    const scheduled = materialEventIsScheduled(display);
    const popover = document.createElement('div');
    popover.className = 'r-schedule-event-popover r-schedule-section-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', `${scheduleEventDisplayTitle(stored)} section`);
    const datesNote = children.length
      ? `Its dates follow its ${children.length} item${children.length === 1 ? '' : 's'}.${canEdit && scheduled ? ' Drag the section bar to move them together.' : (scheduled ? '' : ' None of them is on the calendar yet.')}`
      : 'It has no items yet; its dates will follow the items put in it.';
    popover.innerHTML = `
      <div class="r-schedule-event-popover-head">
        <div class="r-schedule-event-popover-title"><span class="r-schedule-event-popover-kind"><i class="fas fa-layer-group"></i>Section</span><br>${escapeHtml(scheduleEventDisplayTitle(stored))}</div>
        <button type="button" class="r-schedule-event-popover-close" data-schedule-event-close aria-label="Close"><i class="fas fa-times"></i></button>
      </div>
      <div class="r-schedule-event-popover-details">
        <div class="r-schedule-event-popover-row"><i class="fas fa-calendar-day"></i><span>${escapeHtml(scheduled ? workRangeLabel(display) : 'Not scheduled yet')}</span></div>
        <div class="r-schedule-event-popover-row"><i class="fas fa-list"></i><span>${escapeHtml(datesNote)}</span></div>
        ${canEdit ? '' : `<div class="r-schedule-event-popover-row"><i class="fas fa-eye"></i><span>${escapeHtml(scheduleReadOnlyMessage())}</span></div>`}
      </div>
      ${canEdit ? `<div class="r-schedule-event-popover-actions">
        <button type="button" class="r-schedule-event-popover-action" data-schedule-section-edit><i class="fas fa-pen"></i>Edit section</button>
        <button type="button" class="r-schedule-event-popover-action danger" data-schedule-section-delete><i class="fas fa-trash"></i>Delete section</button>
      </div>` : ''}
    `;
    return popover;
  }
  // A section's items leave it for good: every alias of the parent link
  // (parent_event_id, parentEventId, metadata.parent_event_id) is cleared,
  // as in the global Scheduling tab, so nothing still points at it.
  function scheduleUngroupedItem(item = {}){
    return {
      ...item,
      parent_event_id:'',
      parentEventId:'',
      ...(item.metadata && typeof item.metadata === 'object' ? { metadata:{ ...item.metadata, parent_event_id:'' } } : {}),
      updated_at:new Date().toISOString()
    };
  }
  // Deleting a section keeps its items: they stay on the schedule, no longer
  // grouped, and the empty section is removed.
  async function deleteProjectScheduleSection(group = {}){
    if (!requireScheduleEdit()) return false;
    const Scheduling = window.PlatformScheduling;
    const stored = scheduleProjectEvents().find((item) => String(item.id || '') === String(group.id || '')) || group;
    const project = currentSchedulingProject();
    if (!stored?.id || !project?.id || typeof Scheduling?.removeProjectEvent !== 'function') return false;
    const children = scheduleSectionChildren(stored);
    const title = scheduleEventDisplayTitle(stored);
    const approved = await scheduleConfirmUi(children.length
      ? `Delete section “${title}”? Its ${children.length} item${children.length === 1 ? ' stays' : 's stay'} on the schedule and ${children.length === 1 ? 'is' : 'are'} no longer grouped.`
      : `Delete section “${title}”? It has no items.`, { title:'Delete section', okLabel:'Delete section', cancelLabel:'Keep section', danger:true, defaultFocus:'cancel' });
    if (!approved) return false;
    const parentId = String(stored.parent_event_id || '');
    for (const child of children) {
      const next = scheduleUngroupedItem(child);
      const mutationVersion = beginScheduleEventSave(next.id);
      upsertLocalProjectEvent(next);
      const saved = await saveProjectEventQuiet(next, { successTitle:'', failureTitle:'Section not deleted', broadcast:false, preserveLocalEvents:true, mutationVersion });
      if (!saved) {
        upsertLocalProjectEvent(child);
        renderSchedulePanelPreservingScroll();
        return false;
      }
    }
    try {
      scheduleMutationSerial += 1;
      const result = await Scheduling.removeProjectEvent(scheduleOrgId(), project, stored.id, scheduleCachedConfig || null);
      scheduleMutationSerial += 1;
      const savedProject = result?.project || null;
      activeBaseProject = savedProject?.id
        ? { ...activeBaseProject, ...savedProject, events:Array.isArray(savedProject.events) ? savedProject.events : scheduleProjectEvents().filter((item) => String(item.id || '') !== String(stored.id)) }
        : { ...activeBaseProject, events:scheduleProjectEvents().filter((item) => String(item.id || '') !== String(stored.id)) };
      cacheActiveBaseProject();
      rememberScheduleProject(activeBaseProject);
      // A section inside another one: that one's dates follow what is left.
      if (parentId) await persistGroupRollups([stored]);
      renderSchedulePanelPreservingScroll();
      notifyScheduleChanged();
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      showToast('Section deleted', children.length ? `${children.length} item${children.length === 1 ? ' is' : 's are'} no longer grouped.` : `“${title}” was removed.`, true);
      return true;
    } catch (error) {
      if (isStaleSaveError(error)) { handleStaleScheduleSave(error, `“${title}” was already deleted by someone else.`); return false; }
      showToast('Section not deleted', error?.message || 'Could not delete the section.', false);
      renderSchedulePanelPreservingScroll();
      return false;
    }
  }
  async function saveProjectGanttDependencies(event, dependsOn, label, outOfOrder = false){
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(event?.id || '')) || event;
    if (!source?.id) return;
    const next = { ...source, depends_on:dependsOn, updated_at:new Date().toISOString() };
    const mutationVersion = beginScheduleEventSave(next.id);
    upsertLocalProjectEvent(next);
    renderSchedulePanelPreservingScroll();
    await saveProjectEventQuiet(next, {
      successTitle: label,
      successMessage: label === 'Items linked' ? `The item now follows the one you connected it to.${outOfOrder ? ' The link is out of order until one of them moves.' : ''}` : 'The dependency was removed.',
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
    if (!requireScheduleEdit()) return null;
    const Scheduling = window.PlatformScheduling;
    const target = scheduleProjectEvents().find((item) => String(item.id || '') === String(toEvent?.id || '')) || toEvent;
    if (!Scheduling || !target?.id || !fromEvent?.id) return;
    const existing = Scheduling.eventDependencies ? Scheduling.eventDependencies(target) : [];
    if (existing.some((dep) => dep.event_id === String(fromEvent.id || ''))) return;
    if (projectGanttDependencyWouldCycle(fromEvent, target)) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_574bea457bf625","Circular link") ?? "Circular link"), (globalThis.PlatformLanguage?.text("project-schedule","m_1fda2b3dbe4011","That link would make these items depend on each other.") ?? "That link would make these items depend on each other."), false);
      return;
    }
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === String(fromEvent.id || '')) || fromEvent;
    const nextDeps = [...existing, {
      id:`dep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      event_id:String(fromEvent.id),
      type:'finish_to_start',
      lag_minutes:0
    }];
    // A link that is out of order from the start (the later item begins
    // before the earlier one finishes) is flagged before it is saved, as in
    // the global Timeline: Cancel / Link anyway / Link and move it later.
    let moveTarget = null;
    const sourceEnd = Scheduling.eventEnd?.(source) || Scheduling.eventStart?.(source);
    const targetStart = Scheduling.eventStart?.(target);
    const targetEnd = Scheduling.eventEnd?.(target) || targetStart;
    const outOfOrder = materialEventIsScheduled(source) && materialEventIsScheduled(target) && sourceEnd && targetStart && targetStart < sourceEnd;
    if (outOfOrder) {
      const fixed = materialEventIsLocked(target) || Scheduling.eventIsFixed?.(target) === true || ['completed', 'complete', 'done'].includes(String(target.status || '').toLowerCase());
      const sourceLabel = `“${scheduleEventDisplayTitle(source) || 'the first item'}”`;
      const targetLabel = `“${scheduleEventDisplayTitle(target) || 'the second item'}”`;
      // Where the later item would go: the earliest start the new link allows
      // (keeps a timed item's working hours).
      let earliest = null;
      try {
        const linked = scheduleProjectEvents().map((item) => String(item.id || '') === String(target.id) ? { ...item, depends_on:nextDeps } : item);
        const edge = (Scheduling.dependencyViolations?.(linked, { config:scheduleCachedConfig || null }) || []).find((entry) => String(entry.to || '') === String(target.id) && String(entry.from || '') === String(source.id || ''));
        earliest = edge?.earliest_start ? new Date(edge.earliest_start) : null;
      } catch (_) {}
      if (!earliest || !Number.isFinite(earliest.getTime())) earliest = new Date(sourceEnd);
      const allDay = typeof Scheduling.eventIsAllDay === 'function' ? Scheduling.eventIsAllDay(target) : (target.all_day !== false && String(target.schedule_granularity || '') !== 'time');
      const nextStart = allDay && (earliest.getHours() || earliest.getMinutes()) ? scheduleAddDays(new Date(earliest.getFullYear(), earliest.getMonth(), earliest.getDate()), 1) : earliest;
      const whenLabel = allDay ? nextStart.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' }) : nextStart.toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
      const message = `${targetLabel} starts before ${sourceLabel} finishes, so this link would be out of order right away.${fixed ? ` ${targetLabel} is locked or completed and can't move.` : ''}`;
      const choose = window.Portal?.ui?.choose || window.PlatformUI?.choose;
      const choice = typeof choose === 'function'
        ? await choose(message, [
          { value:'cancel', label:(globalThis.PlatformLanguage?.text("scheduling","m_cbef679b21abb4","Cancel") ?? "Cancel") },
          { value:'link', label:'Link anyway', primary:fixed },
          ...(fixed ? [] : [{ value:'move', label:`Link and move ${scheduleEventDisplayTitle(target) || 'it'} later (to ${whenLabel})`, primary:true }])
        ], { title:'Link out of order' })
        : ((await scheduleConfirmUi(message, { title:'Link out of order', okLabel:'Link anyway', cancelLabel:'Cancel' })) ? 'link' : 'cancel');
      if (!choice || choice === 'cancel') { renderSchedulePanelPreservingScroll(); return; }
      if (choice === 'move' && targetStart && targetEnd) {
        moveTarget = { start:nextStart, end:new Date(nextStart.getTime() + (targetEnd.getTime() - targetStart.getTime())), all_day:allDay, schedule_granularity:allDay ? 'date' : 'time' };
      }
    }
    await saveProjectGanttDependencies(target, nextDeps, 'Items linked', outOfOrder && !moveTarget);
    if (moveTarget) {
      const linked = scheduleProjectEvents().find((item) => String(item.id || '') === String(target.id || '')) || { ...target, depends_on:nextDeps };
      if (isMaterialDeliveryEvent(linked)) await saveMaterialScheduleRange(linked, { ...moveTarget, all_day:true, schedule_granularity:'date' });
      else await commitWorkScheduleRange(linked, moveTarget);
      renderSchedulePanelPreservingScroll();
    }
  }
  async function removeProjectGanttDependency(event, dependency){
    if (!requireScheduleEdit()) return null;
    const Scheduling = window.PlatformScheduling;
    const target = scheduleProjectEvents().find((item) => String(item.id || '') === String(event?.id || '')) || event;
    if (!Scheduling || !target?.id) return;
    const existing = Scheduling.eventDependencies ? Scheduling.eventDependencies(target) : [];
    // Unlinking is explicit: a stray click on a connector must not drop it.
    const predecessor = scheduleProjectEvents().find((item) => String(item.id || '') === String(dependency?.event_id || ''));
    const message = `Remove the link so “${scheduleEventDisplayTitle(target) || 'this item'}” no longer follows “${predecessor ? scheduleEventDisplayTitle(predecessor) : 'its predecessor'}”?`;
    const approved = window.PlatformUI?.confirm
      ? await window.PlatformUI.confirm(message, { title:'Remove dependency', okLabel:'Unlink', cancelLabel:'Keep link', danger:true })
      : (await window.Portal?.ui?.choose?.(message, [{ value:'cancel', label:'Keep link' }, { value:'unlink', label:'Unlink', primary:true }], { title:'Remove dependency' })) === 'unlink';
    if (!approved) {
      renderSchedulePanelPreservingScroll();
      return;
    }
    await saveProjectGanttDependencies(target, existing.filter((dep) => dep.id !== dependency?.id), 'Items unlinked');
  }
  /* Add section / Edit section (same words as the global Timeline): the
   * section's name and which of the project's work items are in it. A
   * section's dates follow its items; one left with no items becomes
   * unscheduled until items are put back in it. */
  function openCreateGanttGroupDialog(section = null, { onClose = null } = {}){
    if (!requireScheduleEdit()) return null;
    const Scheduling = window.PlatformScheduling;
    if (!activeBaseProject || (!section && !Scheduling?.createScheduleGroupEvent)) return;
    document.querySelector('.r-gantt-group-backdrop')?.remove();
    const stored = section?.id ? (scheduleProjectEvents().find((item) => String(item.id || '') === String(section.id)) || section) : null;
    const sectionId = String(stored?.id || '');
    const parentOf = (event) => String(Scheduling?.eventParentId?.(event) || event.parent_event_id || '').trim();
    // Production items only, once each: recurring occurrences belong to their
    // series (not a section), and cancelled items and appointments stay out.
    // Items already in another section are moved from there in its own dialog.
    const candidates = scheduleProjectEvents()
      .filter((event) => !Scheduling?.eventIsGroup?.(event) && String(event.id || '') !== sectionId && (!parentOf(event) || (sectionId && parentOf(event) === sectionId)))
      .filter((event) => !String(event.recurrence_series_id || '').trim() && !isSalesAppointmentEvent(event))
      .filter((event) => !['cancelled', 'canceled'].includes(String(event.status || '').toLowerCase()))
      .sort((a, b) => (Scheduling?.eventStart?.(a)?.getTime?.() ?? Number.MAX_SAFE_INTEGER) - (Scheduling?.eventStart?.(b)?.getTime?.() ?? Number.MAX_SAFE_INTEGER));
    const heading = stored ? 'Edit section' : 'Add section';
    const backdrop = document.createElement('div');
    backdrop.className = 'fm-dialog-backdrop r-gantt-group-backdrop';
    backdrop.innerHTML = `
      <div class="fm-dialog r-gantt-group-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(heading)}" style="width:min(480px,calc(100vw - 32px));max-width:480px">
        <div class="fm-dialog-head" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px 0"><h3 style="margin:0;font-size:15px;font-weight:1000">${escapeHtml(heading)}</h3><button type="button" class="r-gantt-group-close" aria-label="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_3742924668fb10","Close") ?? "Close")}" style="border:0;background:transparent;cursor:pointer;font-size:14px"><i class="fas fa-xmark"></i></button></div>
        <div style="display:grid;gap:10px;padding:12px 16px 16px">
          <label style="display:grid;gap:5px;font-size:11px;font-weight:900;color:#475467">Section name<input type="text" class="r-gantt-group-title" aria-describedby="r-gantt-group-title-error" value="${escapeHtml(stored ? String(stored.title || '') : '')}" placeholder="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_5f3f0233d1109b","e.g. Rough In") ?? "e.g. Rough In")}" style="height:36px;border:1px solid rgba(15,23,42,.14);border-radius:9px;padding:0 10px;font:inherit">
          </label>
          <p id="r-gantt-group-title-error" class="r-gantt-group-title-error" role="alert" hidden style="margin:-4px 0 0;font-size:11px;font-weight:850;color:#b42318">Enter a section name.</p>
          ${String(candidates.length ? `<div style="display:grid;gap:4px;max-height:220px;overflow:auto;border:1px solid rgba(15,23,42,.08);border-radius:10px;padding:8px" role="group" aria-label="Items in this section">
            <span style="font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#98a2b3">Items in this section</span>
            ${candidates.map((event) => `<label style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:850;color:#101828"><input type="checkbox" value="${escapeHtml(event.id || '')}" class="r-gantt-group-item" ${sectionId && parentOf(event) === sectionId ? 'checked' : ''}><span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(scheduleEventDisplayTitle(event) || (globalThis.PlatformLanguage?.text("project-schedule","m_05017f54f07448","Untitled") ?? "Untitled"))}</span><small style="flex:0 1 auto;max-width:55%;min-width:0;overflow:hidden;text-overflow:ellipsis;color:#667085;font-weight:800;white-space:nowrap" title="${escapeHtml(materialEventIsScheduled(event) ? workRangeLabel(event) : 'Not scheduled')}">${escapeHtml(materialEventIsScheduled(event) ? workRangeLabel(event) : 'Not scheduled')}</small></label>`).join('')}
          </div>` : `<p style="margin:0;font-size:12px;font-weight:750;color:#667085">No work items can be put in a section yet.</p>`)}
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" class="r-schedule-view-btn r-gantt-group-close">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
            <button type="button" class="r-schedule-view-btn active r-gantt-group-save"><i class="fas ${stored ? 'fa-check' : 'fa-layer-group'}"></i> ${stored ? 'Save' : 'Add section'}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    let groupDialogHandle = null;
    const closeGroupDialog = () => {
      if (!backdrop.isConnected) return;
      backdrop.remove();
      const handle = groupDialogHandle;
      groupDialogHandle = null;
      handle?.unregister?.();
      onClose?.();
    };
    groupDialogHandle = registerScheduleLayer(backdrop, 'project-schedule-group-dialog', closeGroupDialog);
    backdrop.addEventListener('mousedown', (event) => { backdrop.__downBackdrop = event.target === backdrop; });
    backdrop.addEventListener('mouseup', (event) => {
      if (backdrop.__downBackdrop && event.target === backdrop) closeGroupDialog();
      backdrop.__downBackdrop = false;
    });
    const titleInput = backdrop.querySelector('.r-gantt-group-title');
    const titleError = backdrop.querySelector('.r-gantt-group-title-error');
    // A save with no name says why instead of doing nothing; typing clears it.
    const setTitleInvalid = (invalid) => {
      if (!titleInput) return;
      if (invalid) titleInput.setAttribute('aria-invalid', 'true');
      else titleInput.removeAttribute('aria-invalid');
      titleInput.style.borderColor = invalid ? '#d92d20' : '';
      titleInput.style.boxShadow = invalid ? '0 0 0 3px rgba(217,45,32,.14)' : '';
      if (titleError) titleError.hidden = !invalid;
    };
    titleInput?.focus();
    titleInput?.addEventListener('input', () => { if (String(titleInput.value || '').trim()) setTitleInvalid(false); });
    titleInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') backdrop.querySelector('.r-gantt-group-save')?.click();
    });
    backdrop.querySelectorAll('.r-gantt-group-close').forEach((btn) => btn.addEventListener('click', closeGroupDialog));
    backdrop.querySelector('.r-gantt-group-save')?.addEventListener('click', async () => {
      const title = String(titleInput?.value || '').trim();
      if (!title) { setTitleInvalid(true); titleInput?.focus(); return; }
      const memberIds = new Set([...backdrop.querySelectorAll('.r-gantt-group-item:checked')].map((input) => String(input.value || '')).filter(Boolean));
      // Saved below; focus then goes to the section's row, not the opener.
      onClose = null;
      closeGroupDialog();
      if (stored) await saveProjectScheduleSection(stored, title, memberIds);
      else await createProjectScheduleSection(title, memberIds);
    });
  }
  // Puts an item into a section (every alias of the parent link agrees).
  function scheduleSectionMember(item = {}, sectionId = ''){
    return {
      ...scheduleUngroupedItem(item),
      parent_event_id:String(sectionId),
      parentEventId:String(sectionId),
      ...(item.metadata && typeof item.metadata === 'object' ? { metadata:{ ...item.metadata, parent_event_id:String(sectionId) } } : {})
    };
  }
  async function createProjectScheduleSection(title = '', memberIds = new Set()){
    const Scheduling = window.PlatformScheduling;
    const group = Scheduling.createScheduleGroupEvent(activeBaseProject, { title }, scheduleCachedConfig);
    const groupVersion = beginScheduleEventSave(group.id);
    upsertLocalProjectEvent(group);
    const created = await saveProjectEventQuiet(group, { successTitle:'Section added', successMessage:`“${title}” was added to the schedule.`, failureTitle:'Section not saved', broadcast:false, preserveLocalEvents:true, mutationVersion:groupVersion });
    if (!created) { renderSchedulePanelPreservingScroll(); return; }
    for (const memberId of memberIds) {
      const member = scheduleProjectEvents().find((item) => String(item.id || '') === memberId);
      if (!member) continue;
      const nextMember = scheduleSectionMember(member, group.id);
      const memberVersion = beginScheduleEventSave(nextMember.id);
      upsertLocalProjectEvent(nextMember);
      await saveProjectEventQuiet(nextMember, { successTitle:'', failureTitle:'Section not saved', broadcast:false, preserveLocalEvents:true, mutationVersion:memberVersion });
    }
    // Save the section's range rolled up from its new members, then show the
    // stored result.
    await persistGroupRollups(scheduleSectionChildren(group));
    await refreshProjectFromServer({ render:false });
    renderSchedulePanelPreservingScroll();
    focusScheduleItem(group.id);
    window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
  }
  async function saveProjectScheduleSection(section = {}, title = '', memberIds = new Set()){
    const Scheduling = window.PlatformScheduling;
    const stored = scheduleProjectEvents().find((item) => String(item.id || '') === String(section.id || '')) || section;
    const sectionId = String(stored.id || '');
    const renamed = !!title && title !== String(stored.title || '').trim();
    const current = scheduleSectionChildren(stored);
    const currentIds = new Set(current.map((item) => String(item.id || '')));
    const added = [...memberIds].filter((id) => !currentIds.has(id)).map((id) => scheduleProjectEvents().find((item) => String(item.id || '') === id)).filter(Boolean);
    const removed = current.filter((item) => !memberIds.has(String(item.id || '')));
    if (!renamed && !added.length && !removed.length) { focusScheduleItem(sectionId); return; }
    const changes = [...added.map((item) => scheduleSectionMember(item, sectionId)), ...removed.map((item) => scheduleUngroupedItem(item))];
    if (renamed) {
      const next = { ...stored, title, title_is_custom:true, updated_at:new Date().toISOString() };
      const version = beginScheduleEventSave(next.id);
      upsertLocalProjectEvent(next);
      renderSchedulePanelPreservingScroll();
      const saved = await saveProjectEventQuiet(next, { successTitle:'', failureTitle:'Section not saved', broadcast:false, preserveLocalEvents:true, mutationVersion:version });
      if (!saved) { upsertLocalProjectEvent(stored); renderSchedulePanelPreservingScroll(); focusScheduleItem(sectionId); return; }
    }
    let failed = 0;
    for (const change of changes) {
      const before = scheduleProjectEvents().find((item) => String(item.id || '') === String(change.id || ''));
      const version = beginScheduleEventSave(change.id);
      upsertLocalProjectEvent(change);
      const saved = await saveProjectEventQuiet(change, { successTitle:'', failureTitle:'Section not saved', broadcast:false, preserveLocalEvents:true, mutationVersion:version });
      if (!saved) { failed += 1; if (before && scheduleEventSaveVersions.get(String(change.id || '')) === version) upsertLocalProjectEvent(before); }
    }
    // Its dates (and its parent sections' dates) follow what is in it now.
    await persistGroupRollups([...changes, { id:'', parent_event_id:sectionId }]);
    const latest = scheduleProjectEvents().find((item) => String(item.id || '') === sectionId) || stored;
    if (!scheduleSectionChildren(latest).length && materialEventIsScheduled(latest) && Scheduling?.groupRollupMode?.(latest) !== 'manual') {
      // Emptied: no dates to follow, so no bar until items are put back.
      const cleared = { ...latest, status:'unscheduled', start:'', end:'', start_at:'', end_at:'', start_date:'', end_date:'', updated_at:new Date().toISOString() };
      const version = beginScheduleEventSave(cleared.id);
      upsertLocalProjectEvent(cleared);
      await saveProjectEventQuiet(cleared, { successTitle:'', failureTitle:'Section not saved', broadcast:false, preserveLocalEvents:true, mutationVersion:version });
    }
    renderSchedulePanelPreservingScroll();
    focusScheduleItem(sectionId);
    window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
    const parts = [
      renamed ? `The section is now “${title}”.` : '',
      added.length ? `${added.length} item${added.length === 1 ? '' : 's'} moved into it.` : '',
      removed.length ? `${removed.length} item${removed.length === 1 ? '' : 's'} taken out of it.` : '',
      failed ? `${failed} item${failed === 1 ? ' was' : 's were'} not saved.` : ''
    ].filter(Boolean);
    showToast(renamed && !changes.length ? 'Section renamed' : 'Section updated', parts.join(' '), !failed);
  }
  function renderScheduleLeft(){
    if(!state.sidebarRoot)return;
    state.sidebarRoot.replaceChildren();
    state.sidebarRoot.classList.remove('visible');
    state.sidebarRoot.style.display='none';
  }

  function renderWorkScheduler(target){
    const Scheduling = window.PlatformScheduling;
    const mobileLayout = window.matchMedia?.('(max-width:720px)').matches === true;
    if (!target) return;
    if (!window.PlatformScheduleView?.renderProjectRangeScheduler || !Scheduling) {
      target.innerHTML = `<div class="r-schedule-empty"><i class="fas fa-calendar"></i>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_8d14608b5ea70e","Work scheduling tools are unavailable.") ?? "Work scheduling tools are unavailable.")}</div>`;
      return;
    }
    if (scheduleViewMode === 'gantt' && projectGanttViewEnabled() && window.PlatformScheduleView?.renderGanttScheduler) {
      window.PlatformScheduleView.renderGanttScheduler(target, {
        readOnly: !canEditSchedule(),
        Scheduling,
        config: scheduleCachedConfig || null,
        project: activeBaseProject || null,
        events: scheduleDisplayEvents().filter((event) => !equipmentEventHidden(event)),
        date: scheduleAnchorDate,
        pxPerDay: projectGanttZoom || undefined,
        zoom: 'fit',
        collapsedGroupIds: projectGanttCollapsedGroups,
        modeLabel: window.Portal?.terminology?.get?.('scheduling.gantt_view', 'Timeline') || 'Timeline',
        stateKey: `project:${activeBaseProject?.id || ''}`,
        showTodayButton: false,
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
        // Section bars move their items together (moveProjectScheduleGroup).
        allowGroupMove: canEditSchedule(),
        onReadOnlyDragAttempt: canEditSchedule() ? undefined : () => showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), scheduleReadOnlyMessage(), 'info'),
        onEventRangeChange(event, range){ saveProjectGanttRange(event, range); },
        onEventSchedule(event, range, meta = {}){ saveProjectGanttRange(event, range, { placing:true, meta }); },
        // A click on a waiting item's lane: past days ask first, linked work
        // is checked, and the toast offers Undo.
        onUnscheduledLaneSchedule(event, range, meta = {}){ saveProjectGanttRange(event, range, { placing:true, undo:true, meta }); },
        onDependencyCreate(fromEvent, toEvent){ createProjectGanttDependency(fromEvent, toEvent); },
        onDependencyRemove(event, dependency){ removeProjectGanttDependency(event, dependency); }
      });
      // "Fit" is worked out once; later renders (after scheduling an item
      // from its lane) keep that zoom instead of re-fitting to a new span.
      if (!projectGanttZoom && Number(target.__psvGanttPxPerDay) > 0) projectGanttZoom = Number(target.__psvGanttPxPerDay);
      return;
    }
    const forceCrewScheduler = scheduleIsSchedulingView() && !materialScheduleModeActive;
    // Crew lanes wait for the crews: drawn without them, crew work would sit
    // in Unassigned and a drag from there would unassign it.
    if (forceCrewScheduler && !scheduleResourcesReady() && !scheduleResourcesSettled) {
      target.innerHTML = `<div class="r-schedule-loading"><i class="fas fa-circle-notch fa-spin"></i>&nbsp; ${escapeHtml(`Loading ${workforceTerm('resource_group', 'plural').toLowerCase()}…`)}</div>`;
      ensureScheduleResources().then(() => { if (state.active && scheduleIsSchedulingView()) renderSchedulePanelPreservingScroll(); });
      return;
    }
    const crews = scheduleWorkResources(scheduleCachedConfig, scheduleCachedUsers);
    const crewRows = crews.length ? crews : (forceCrewScheduler ? [{ id: 'default_work_resource', name: workResourceLabel() }] : []);
    const currentWorkEvents = projectWorkEvents();
    const calendarWorkEvents = currentWorkEvents.map((event) => decorateWorkEventForCalendar(event, crews));
    const calendarMaterialEvents = projectMaterialEvents()
      .filter(isMaterialDeliveryEvent)
      .filter(materialEventIsScheduled);
    const calendarEvents = [...calendarWorkEvents, ...calendarMaterialEvents, ...projectSalesAppointmentEvents()];
    // Meetings, inspections and custom project events show here too.
    calendarEvents.push(...projectOtherEvents());
    const materialEvent = materialScheduleModeActive ? selectedMaterialEvent() : null;
    const materialDraft = materialEvent && materialScheduleDraft?.start
      ? { ...materialEvent, ...materialScheduleDraft, id:materialEvent.id, event_id:materialEvent.id }
      : null;
    const calendarDrafts = [...workDraftList(), ...(materialDraft ? [materialDraft] : [])];
    const calendarActiveDraftId = materialDraft?.id || activeWorkScheduleDraftId;
    const allowProjectMobileCreate = canEditSchedule() && mobileLayout && !scheduleIsSchedulingView() && !materialScheduleModeActive;
    const draftIsMaterial = (draft = {}) => isMaterialDeliveryEvent(draft)
      || (!!materialScheduleEventId && String(draft.id || '') === String(materialScheduleEventId));
    // Routing lanes: an item with several crews sits in every crew's lane.
    const schedulerWorkEvents = forceCrewScheduler ? routingLaneEvents(allProjectWorkEvents()) : currentWorkEvents;
    const currentIds = new Set(currentWorkEvents.map((event) => String(event.id || '')).filter(Boolean));
    const editableWorkEventIds = forceCrewScheduler
      ? schedulerWorkEvents.filter((event) => currentIds.has(routingLaneSourceId(event))).map((event) => String(event.id || ''))
      : Array.from(currentIds);
    const routingEventRangeChange = (event, range) => {
      const lane = routingLaneInfo(event);
      if (!lane) return commitWorkScheduleRange(event, range);
      const resourceKeys = ['resource_id', 'assigned_resource_id', 'assigned_crew_id', 'crew_id'];
      const assigns = resourceKeys.some((key) => Object.prototype.hasOwnProperty.call(range || {}, key));
      const targetId = String(range?.resource_id || range?.assigned_resource_id || range?.assigned_crew_id || range?.crew_id || '').trim();
      const { resource_id, assigned_resource_id, assigned_crew_id, crew_id, ...timeRange } = range || {};
      if (!assigns || targetId === lane.laneId) return commitWorkScheduleRange(lane.source, timeRange);
      // Dragged from one crew's lane to another: that crew is replaced, the
      // other crews stay.
      const current = eventWorkAssignees(lane.source);
      const target = targetId ? (crews.find((crew) => String(crew.id || '') === targetId) || { id:targetId, name:targetId }) : null;
      const next = current.flatMap((ref) => ref.id === lane.laneId ? (target ? [{ id:target.id, kind:target.subject_type || target.resource_kind || 'resource_group', name:target.name || target.id }] : []) : [ref]);
      return commitWorkScheduleRange(lane.source, timeRange, { assignees:next });
    };
    const routingEventClick = (event, meta = {}) => {
      const source = routingLaneInfo(event)?.source || event;
      if (!source?.id) return;
      if (meta.action === 'assignee' && meta.element) {
        if (canEditSchedule()) openWorkAssignmentMenu(source, meta.element);
        else openScheduleEventPopover(source, meta.element);
        return;
      }
      openScheduleEventPopover(source, meta.element);
    };
    if (forceCrewScheduler && scheduleSchedulingMode() === 'day' && crewRows.length && window.PlatformScheduleView?.renderResourceTimeScheduler) {
      window.PlatformScheduleView.renderResourceTimeScheduler(target, {
        Scheduling,
        config: scheduleCachedConfig || null,
        project: activeBaseProject || null,
        events: schedulerWorkEvents,
        drafts: workDraftList(),
        activeDraftId: activeWorkScheduleDraftId,
        resources: crewRows,
        allowCreate: canEditSchedule() && workScheduleModeActive && !activeWorkDraft()?.event_id,
        allowEdit: canEditSchedule(),
        editableEventIds: editableWorkEventIds,
        date: scheduleAnchorDate,
        slotMinutes: 30,
        smartScroll: scheduleSmartScroll,
        showToolbar: false,
        modeLabel: 'Production hourly view',
        resourceHeader: workResourceLabel(),
        unassignedLabel: 'Unassigned',
        // Person-assigned work sits on that person's row, not Unassigned.
        resourceIdForItem: (item) => routingLaneInfo(item)?.laneId ?? workCrewId(item),
        onSmartScrollToggle(next){
          scheduleSmartScroll = !!next;
          const scrollPosition = captureScheduleScroll();
          renderSchedulePanel();
          restoreScheduleScroll(scrollPosition);
        },
        onNavigate(nextDate){ scheduleAnchorDate = nextDate; renderSchedulePanel(); },
        onDraftChange(next){ setWorkScheduleDraft(next, { render: false, renderLeft: true }); },
        onDraftConfirm(){ saveWorkScheduleDraft(); },
        onEventRangeChange: routingEventRangeChange,
        onEventClick: routingEventClick,
        onReadOnlyDragAttempt: canEditSchedule() ? undefined : () => showToast((globalThis.PlatformLanguage?.text('scheduling','m_view_only','View only') ?? 'View only'), scheduleReadOnlyMessage(), 'info'),
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
        allowCreate: canEditSchedule() && workScheduleModeActive && !activeWorkDraft()?.event_id,
        allowEdit: canEditSchedule(),
        editableEventIds: editableWorkEventIds,
        mode: scheduleSchedulingMode(),
        dayCount: 180,
        date: scheduleStartOfWeek(scheduleAnchorDate),
        smartScroll: false,
        showToolbar: false,
        modeLabel: 'Production daily view',
        resourceHeader: workResourceLabel(),
        unassignedLabel: 'Unassigned',
        // Person-assigned work sits on that person's row, not Unassigned.
        resourceIdForItem: (item) => routingLaneInfo(item)?.laneId ?? workCrewId(item),
        onNavigate(nextDate){ scheduleAnchorDate = nextDate; renderSchedulePanel(); },
        onDraftChange(next){ setWorkScheduleDraft(next, { render: false, renderLeft: true }); },
        onDraftConfirm(){ saveWorkScheduleDraft(); },
        onEventRangeChange: routingEventRangeChange,
        onEventClick: routingEventClick,
        onReadOnlyDragAttempt: canEditSchedule() ? undefined : () => showToast((globalThis.PlatformLanguage?.text('scheduling','m_view_only','View only') ?? 'View only'), scheduleReadOnlyMessage(), 'info'),
        onDraftSelect(draft){
          if (!draft?.id) return;
          setActiveWorkDraftId(draft.id);
          renderScheduleLeft();
        }
      });
      alignRoutingWeek(target);
      return;
    }
    const clickToCreate = canEditSchedule() && !mobileLayout && !materialScheduleModeActive && !workScheduleModeActive && !scheduleIsSchedulingView();
    const renderedMode = scheduleIsSchedulingView() ? scheduleSchedulingMode() : (['day','4day','week','month'].includes(scheduleViewMode) ? scheduleViewMode : workScheduleViewMode);
    window.PlatformScheduleView.renderProjectRangeScheduler(target, {
      Scheduling,
      config: scheduleCachedConfig || null,
      project: activeBaseProject || null,
      events: calendarEvents,
      drafts: calendarDrafts,
      activeDraftId: calendarActiveDraftId,
      allowCreate: materialScheduleModeActive
        ? !!materialEvent && !materialEventIsScheduled(materialEvent) && canEditSchedule()
        : (canEditSchedule() && workScheduleModeActive && !activeWorkDraft()?.event_id) || allowProjectMobileCreate || clickToCreate,
      allowEdit: canEditSchedule(),
      allowAssign: canEditSchedule(),
      onReadOnlyDragAttempt: canEditSchedule() ? undefined : () => showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), scheduleReadOnlyMessage(), 'info'),
      stateKey: `project-schedule:${activeBaseProject?.id || ''}`,
      // Locked items and schedule groups (which roll up their members) are not dragged here.
      canEditEvent: (event) => !materialEventIsLocked(event) && !scheduleEventIsGroup(event),
      eventIsEditable: (event) => !materialEventIsLocked(event) && !scheduleEventIsGroup(event),
      // View-only sessions get the passive lock badge (no toggle).
      onEventLockToggle: canEditSchedule() ? (event, nextLocked) => {
        if (isMaterialDeliveryEvent(event)) toggleMaterialScheduleLock(event, nextLocked);
      } : undefined,
      mode: renderedMode,
      showModeSwitch: false,
      showToolbar: false,
      mobileLayout,
      shortRangeDayCount: mobileLayout ? 3 : 4,
      touchHoldToPlace: mobileLayout,
      touchHoldDelayMs: 360,
      date: scheduleAnchorDate,
      slotMinutes: 30,
      // Timed views open at the start of the working day (or the first item
      // shown, when it starts earlier), not midnight.
      initialScrollMinute: scheduleInitialScrollMinute(calendarEvents, renderedMode),
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
          schedule_granularity: 'date',
          // A click places it with its own planned length (never the
          // clicked cell's one day or one slot).
          __schedule_natural_range: true
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
        else if (clickToCreate && !workScheduleModeActive && next?.start) {
          // Click (or drag) on an empty day/time: the schedule dialog opens
          // with that date and time filled in.
          const start = new Date(next.start);
          const end = next.end ? new Date(next.end) : null;
          const allDay = next.all_day !== false && next.schedule_granularity !== 'time';
          renderSchedulePanelPreservingScroll();
          openScheduleDialog('project_work', null, {
            start,
            allDay,
            days:allDay && end ? Math.max(1, Math.round((scheduleAddDays(end, 0) - scheduleAddDays(start, 0)) / 86400000)) : 1,
            durationMinutes:!allDay && end && end > start ? Math.round((end - start) / 60000) : 0
          });
        }
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
        // Moves and resizes save on drop, as in the global Scheduling tab.
        commitWorkScheduleRange(event, range);
      },
      onEventClick(event, meta = {}){
        if (!event?.id) return;
        if (meta.action === 'assignee' && meta.element && !isMaterialDeliveryEvent(event) && canEditSchedule()) {
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
    if (renderedMode === 'month') revealMonthAnchor(target);
  }

  // Timed views open at the working day's start, or earlier when a shown
  // item starts before it.
  function scheduleInitialScrollMinute(events = [], mode = 'week'){
    const workdayStart = scheduleWorkdayStartMinute();
    if (!['day', '4day', 'week'].includes(mode)) return workdayStart;
    const Scheduling = window.PlatformScheduling;
    const anchor = new Date(scheduleAnchorDate);
    const rangeStart = mode === 'week' ? scheduleStartOfWeek(anchor) : scheduleAddDays(anchor, 0);
    const rangeEnd = scheduleAddDays(rangeStart, mode === 'week' ? 7 : (mode === '4day' ? (window.matchMedia?.('(max-width:720px)').matches ? 3 : 4) : 1));
    const minutes = events.filter((event) => {
      const allDay = typeof Scheduling?.eventIsAllDay === 'function' ? Scheduling.eventIsAllDay(event) : event.all_day !== false && event.schedule_granularity !== 'time';
      if (allDay) return false;
      const start = Scheduling?.eventStart?.(event);
      return start && start >= rangeStart && start < rangeEnd;
    }).map((event) => {
      const start = Scheduling.eventStart(event);
      return start.getHours() * 60 + start.getMinutes();
    });
    return minutes.length ? Math.min(workdayStart, Math.max(0, Math.min(...minutes) - 30)) : workdayStart;
  }

  // The first time a month is shown, bring today's (or the anchor's) week
  // into view instead of leaving it below the fold at smaller heights; after
  // that the month keeps the position it was left at across re-renders.
  // Only a position the user scrolled to is kept; until then (and after
  // Today) the month keeps today's week in view, also when the pane gets
  // shorter (a floating or docked window, the placement banner).
  const scheduleMonthScroll = new Map();
  function forgetScheduleMonthScroll(){
    scheduleMonthScroll.clear();
  }
  function revealMonthAnchor(target){
    const surface = target?.querySelector?.('.prs-surface');
    if (!surface) return;
    const anchor = new Date(scheduleAnchorDate);
    const key = `${activeBaseProject?.id || ''}|${anchor.getFullYear()}-${anchor.getMonth()}`;
    const today = new Date();
    const day = today.getFullYear() === anchor.getFullYear() && today.getMonth() === anchor.getMonth() ? today : anchor;
    let revealedTop = null;
    const reveal = () => {
      if (!surface.isConnected || scheduleMonthScroll.has(key)) return;
      if (surface.scrollHeight <= surface.clientHeight + 2) return;
      // The shared month helper scrolls to a row boundary (never leaving a
      // row's date numbers under the sticky weekday header) and does
      // nothing when the whole row already shows.
      if (typeof window.PlatformScheduleView?.revealMonthDate === 'function') window.PlatformScheduleView.revealMonthDate(target, day);
      else {
        const cell = surface.querySelector(`[data-prs-date="${scheduleLocalDate(day)}"]`);
        if (!cell) return;
        const cellBox = cell.getBoundingClientRect();
        const surfaceBox = surface.getBoundingClientRect();
        if (cellBox.bottom > surfaceBox.bottom - 2) surface.scrollTop += cellBox.bottom - surfaceBox.bottom + 8;
      }
      revealedTop = surface.scrollTop;
    };
    // Only a scroll the user made (wheel, touch, keys, the scrollbar) is
    // their choice of position; our own reveal, or the browser keeping the
    // content in place while the pane resizes, is not.
    let userScrollAt = 0;
    const markUserScroll = () => { userScrollAt = Date.now(); };
    ['wheel', 'touchmove', 'keydown', 'pointerdown'].forEach((type) => surface.addEventListener(type, markUserScroll, { passive:true }));
    surface.addEventListener('scroll', () => {
      if (!surface.isConnected) return;
      if (revealedTop !== null && Math.abs(surface.scrollTop - revealedTop) <= 1) return;
      if (Date.now() - userScrollAt > 1500) return;
      revealedTop = null;
      scheduleMonthScroll.set(key, surface.scrollTop);
    }, { passive:true });
    if (scheduleMonthScroll.has(key)) {
      const top = scheduleMonthScroll.get(key);
      if (Math.abs(surface.scrollTop - top) > 1) surface.scrollTop = top;
      return;
    }
    reveal();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        if (!surface.isConnected) { observer.disconnect(); return; }
        reveal();
      });
      observer.observe(surface);
    }
  }

  // Routing (daily) starts its columns at the week the heading names, just
  // right of the sticky resource column.
  function alignRoutingWeek(target){
    const scroll = target?.querySelector?.('.prs-resource-scroll');
    if (!scroll || !scheduleIsSchedulingView() || scheduleSchedulingMode() !== 'week') return;
    const weekStart = scheduleLocalDate(scheduleStartOfWeek(scheduleAnchorDate));
    const cell = scroll.querySelector(`.prs-resource-cell[data-prs-date="${weekStart}"]`);
    if (!cell) return;
    const label = scroll.querySelector('.prs-resource-label:not(.mobile-resource-rows), .prs-resource-corner');
    const sticky = label && getComputedStyle(label).position === 'sticky' ? label.getBoundingClientRect().width : 0;
    scroll.scrollLeft = Math.max(0, Math.round(scroll.scrollLeft + cell.getBoundingClientRect().left - scroll.getBoundingClientRect().left - sticky));
  }

  // One copy of a multi-crew item per crew lane, with its own id so the
  // lanes can be told apart; routingLaneInfo() maps a copy back.
  const ROUTING_LANE_SEPARATOR = '::lane::';
  function routingLaneEvents(events = []){
    return events.flatMap((event) => {
      const assignees = eventWorkAssignees(event);
      if (assignees.length <= 1) return [event];
      return assignees.map((ref) => ({ ...event, id:`${event.id}${ROUTING_LANE_SEPARATOR}${ref.id}`, event_id:event.id, __lane_resource_id:ref.id, __lane_source_id:String(event.id || ''), crew_label:workAssigneesLabel(assignees) }));
    });
  }
  function routingLaneSourceId(event = {}){
    return String(event.__lane_source_id || String(event.id || '').split(ROUTING_LANE_SEPARATOR)[0] || '');
  }
  function routingLaneInfo(event = {}){
    const id = String(event?.id || '');
    if (!id.includes(ROUTING_LANE_SEPARATOR)) return null;
    const [sourceId, laneId] = id.split(ROUTING_LANE_SEPARATOR);
    const source = scheduleProjectEvents().find((item) => String(item.id || '') === sourceId)
      || allProjectWorkEvents().find((item) => String(item.id || '') === sourceId)
      || { ...event, id:sourceId };
    return { source, laneId:String(event.__lane_resource_id || laneId || '') };
  }

  // Project items other than sales, production and deliveries (meetings,
  // inspections, custom events) still belong on the project's schedule.
  function projectOtherEvents(){
    return scheduleDisplayEvents()
      .filter((event) => !isSalesAppointmentEvent(event) && !isProjectWorkEvent(event) && !isScopeResourceEvent(event) && !isMaterialDeliveryEvent(event) && !scheduleEventIsGroup(event))
      .filter((event) => !equipmentEventHidden(event) && !/^equipment_/.test(String(event.event_type_default_id || event.type_id || '')))
      .filter((event) => !['cancelled', 'canceled'].includes(String(event.status || '').toLowerCase()))
      .filter(materialEventIsScheduled)
      .sort((a, b) => (window.PlatformScheduling?.eventStart?.(a) || 0) - (window.PlatformScheduling?.eventStart?.(b) || 0));
  }
  function otherEventTilesHtml(){
    const events = projectOtherEvents();
    if (!events.length) return '';
    return `<section class="r-schedule-section">
        <div class="r-schedule-section-head"><div class="r-schedule-section-title"><i class="fas fa-calendar"></i> ${escapeHtml('Other events')}</div></div>
        <div class="r-schedule-tile-list">${events.map((event) => `
          <button type="button" class="r-schedule-tile r-schedule-other-tile" data-other-event="${escapeHtml(event.id || '')}">
            <div class="r-schedule-tile-title"><i class="fas fa-calendar"></i>${escapeHtml(scheduleEventDisplayTitle(event))}</div>
            <div class="r-schedule-tile-meta">${escapeHtml(workRangeLabel(event))}</div>
            <div class="r-schedule-tile-meta">${escapeHtml(eventAssignedLabel(event))}</div>
          </button>`).join('')}</div>
      </section>`;
  }

  function renderProjectScheduleHome(){
    const panel = $('#rSchedulePanel');
    if (!panel) return;
    // A sales calendar still loading for an earlier render must not draw
    // into this one (e.g. Escape right after Sales + New).
    scheduleCalendarGen += 1;
    panel.classList.add('work-mode');
    setScheduleWorkspaceChrome(state.active);
    renderScheduleLeft();
    const isScheduling = scheduleIsSchedulingView();
    panel.classList.toggle('scheduling-mode', isScheduling);
    panel.classList.toggle('r-schedule-view-only', !canEditSchedule());
    const sub = isScheduling
      ? `Assign production by ${workResourceLabel()} and date.`
      : (canEditSchedule() && scheduleViewMode !== 'gantt' ? 'Project calendar views show scheduled production and appointments. Click an empty day or time to add work.' : 'Project calendar views show scheduled production and appointments.');
    panel.innerHTML = `
      <div class="r-schedule-head">
        <div>
          <h2 class="r-schedule-title">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_fc05a804bd034c","Schedule") ?? "Schedule")}${String(scheduleRangeLabel() ? `<span class="r-schedule-range-label">${escapeHtml(scheduleRangeLabel())}</span>` : '')}</h2>
          <div class="r-schedule-sub" title="${escapeHtml(sub)}">${String(escapeHtml(sub))}</div>
        </div>
        <div class="r-schedule-head-actions">${String(scheduleViewSwitchHtml())}</div>
      </div>
      ${String(isScheduling ? '' : projectMobileToolbarHtml())}
      ${String(schedulePlacementBannerHtml())}
      <div class="r-schedule-calendar work-calendar ${String(projectMobileCalendarSwipeDirection ? `mobile-swipe-${projectMobileCalendarSwipeDirection}` : '')}"></div>
    `;
    bindScheduleViewSwitch(panel);
    bindSchedulePlacementBanner(panel);
    // Closing without adding hands focus back to the (possibly redrawn) button.
    panel.querySelector('[data-gantt-add-group]')?.addEventListener('click', () => openCreateGanttGroupDialog(null, { onClose:() => {
      try { panel.querySelector('[data-gantt-add-group]')?.focus?.({ preventScroll:true }); } catch (_) {}
    } }));
    if (isScheduling) clearProjectMobileControls();
    else bindProjectMobileToolbar(panel);
    renderWorkScheduler(panel.querySelector('.work-calendar'));
    if (scheduleWorkResourceDataLoaded) return;
    scheduleWorkResourceDataLoaded = true;
    if (!window.PlatformScheduling || !scheduleOrgId()) return;
    // Menus opened meanwhile wait for this same load (ensureScheduleResources).
    scheduleResourcesPromise = (async () => {
      try {
        const config = await window.PlatformScheduling.loadBranchConfig(scheduleOrgId(), scheduleBranchId());
        const users = await loadScheduleUsers(config);
        // A failed read keeps the last good list (rememberScheduleData skips
        // an empty one) and says so.
        const projects = await window.PlatformScheduling.listProjects(scheduleOrgId(), config).catch(() => { scheduleSourceNotice(); return []; });
        rememberScheduleData(config, users, projects);
        await loadWorkforceResources();
        if (scheduleUsersLoaded) scheduleDataLoadedAt = Date.now();
        if (state.active) renderSchedulePanelPreservingScroll();
        return true;
      } catch (_) {
        return false;
      }
    })().finally(() => { scheduleResourcesPromise = null; scheduleResourcesSettled = true; });
  }

  function renderSchedulePanel(){
    // A details popover that is open while data arrives (crews loading, a
    // refresh from another surface) stays open on its item and is redrawn
    // with the new data; actions that close it do so before rendering.
    const openPopover = document.querySelector('.r-schedule-event-popover');
    const keepPopover = openPopover?.isConnected && scheduleEventPopoverId && typeof openPopover.__reopenPlacement === 'function'
      ? { id:scheduleEventPopoverId, placement:openPopover.__reopenPlacement() }
      : null;
    closeScheduleEventPopover();
    if (!state.active) {
      setScheduleWorkspaceChrome(false);
      clearScheduleLeft();
      return;
    }
    const recurrenceProjectId = String(currentSchedulingProject()?.id || '');
    if (recurrenceProjectId && recurrenceProjectId !== scheduleRecurrenceProjectId) scheduleRecurrenceLoaded = false;
    if (recurrenceProjectId && !scheduleRecurrenceLoading && !scheduleRecurrenceLoaded) {
      loadRecurringSeries().then(() => { if (state.active) renderSchedulePanel(); });
    }
    syncScheduleRoute();
    if ((scheduleIsSchedulingView() && scheduleSchedulingTarget === 'sales') || scheduleModeActive || scheduleDraft || scheduleAssignmentEventId || scheduleSelectedEventId) {
      renderAppointmentSchedulePanel();
    } else renderProjectScheduleHome();
    if (keepPopover) {
      const item = scheduleProjectEvents().find((candidate) => String(candidate.id || '') === String(keepPopover.id));
      if (item) reopenScheduleEventPopover(item, keepPopover.placement);
    }
  }

  // The shown view, target and date live in the route (the project window
  // mirrors them to the browser address), so a reload or shared link opens
  // the same schedule.
  function syncScheduleRoute(){
    const navigation = window.Portal?.navigation;
    if (!navigation?.replace || navigation.applying || !state.mounted || activeBaseProject?.__projectShellLoading) return;
    const route = navigation.read?.() || {};
    if (!route.project || route.projectTab !== 'schedule') return;
    const patch = {
      projectScheduleView:scheduleViewMode,
      projectScheduleTarget:scheduleIsSchedulingView() ? scheduleSchedulingTarget : null,
      projectScheduleDate:scheduleViewMode === 'gantt' ? null : scheduleLocalDate(scheduleAnchorDate)
    };
    if (Object.entries(patch).every(([key, value]) => String(route[key] || '') === String(value || ''))) return;
    try { navigation.replace(patch, { source:'project-schedule-sync', ownedKeys:Object.keys(patch) }); } catch (_) {}
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
    // Routing keeps its heading (date, prev/today/next, views) on a phone too.
    panel.classList.toggle('scheduling-mode', scheduleIsSchedulingView());
    panel.classList.toggle('r-schedule-view-only', !canEditSchedule());
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
          <h2 class="r-schedule-title">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_fc05a804bd034c","Schedule") ?? "Schedule")}${String(scheduleRangeLabel() ? `<span class="r-schedule-range-label">${escapeHtml(scheduleRangeLabel())}</span>` : '')}</h2>
          <div class="r-schedule-sub" title="${escapeHtml(scheduleSub)}">${String(escapeHtml(scheduleSub))}</div>
        </div>
        <div class="r-schedule-head-actions">${String(scheduleViewSwitchHtml())}</div>
      </div>
      ${String(scheduleIsSchedulingView() ? '' : projectMobileToolbarHtml())}
      ${String(schedulePlacementBannerHtml())}
      <div class="r-schedule-calendar"><div class="r-schedule-loading"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_1d56a895701e1c","&nbsp; Loading calendar...") ?? "&nbsp; Loading calendar...")}</div></div>
    `;
    bindScheduleViewSwitch(panel);
    bindSchedulePlacementBanner(panel);
    if (scheduleIsSchedulingView()) clearProjectMobileControls();
    else bindProjectMobileToolbar(panel);
    updateSchedulePanelConfirm();
    // Browsing an appointment stays on the read-only project calendar. Placing
    // one (Sales + New) waits for the assignee list below, then opens the
    // single-person week or the team routing view.
    if (!scheduleIsSchedulingView() && !scheduleModeActive) {
      renderProjectScheduleView(panel.querySelector('.r-schedule-calendar'), scheduleCachedConfig?.event_types?.sales_appointment || {}, scheduleCachedConfig || {});
      return;
    }
    (async () => {
      if (!Scheduling || !scheduleOrgId()) {
        panel.querySelector('.r-schedule-calendar').innerHTML = `<div class="r-schedule-empty"><i class="fas fa-calendar"></i>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_576d28ec106963","Scheduling tools are unavailable.") ?? "Scheduling tools are unavailable.")}</div>`;
        return;
      }
      let config = null;
      let users = [];
      let projects = [];
      try {
        ({ config, users, projects } = await loadScheduleData());
      } catch (error) {
        if (gen !== scheduleCalendarGen) return;
        console.warn('Project scheduling data refresh failed; using last known data when available.', error);
        if (scheduleCachedConfig && scheduleCachedUsers.length) {
          config = scheduleCachedConfig;
          users = scheduleCachedUsers;
          projects = mergeScheduleActiveProject(scheduleCachedProjects);
        } else {
          panel.querySelector('.r-schedule-calendar').innerHTML = `<div class="r-schedule-empty"><i class="fas fa-calendar"></i>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_162d3a1aa54d57","Could not load scheduling data.") ?? "Could not load scheduling data.")}</div>`;
          return;
        }
      }
      if (gen !== scheduleCalendarGen) return;
      const eventType = config.event_types?.sales_appointment || {};
      const salespeople = scheduleAssignableSubjects('sales_appointment', '', config, users);
      const target = panel.querySelector('.r-schedule-calendar');
      if (!salespeople.length) {
        target.innerHTML = `<div class="r-schedule-empty"><i class="fas fa-user-slash"></i>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_281fa370fae5c5","No eligible assignees are available for sales appointments. Update this event type's assignment rules or add a matching person or resource group.") ?? "No eligible assignees are available for sales appointments. Update this event type's assignment rules or add a matching person or resource group.")}</div>`;
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
          allowCreate: canEditSchedule() && scheduleModeActive,
          allowEdit: canEditSchedule(),
          editableEventIds: Array.from(appointmentEventIds),
          mode: 'week',
          dayCount: 180,
          date: scheduleStartOfWeek(scheduleAnchorDate),
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
            warnSalesDraftConflict(allSalesEvents, scheduleDraft);
            updateSchedulePanelConfirm();
            // Show the placed draft with its sales title and refresh the rail's assignee and status.
            renderSchedulePanelPreservingScroll();
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
        alignRoutingWeek(target);
        return;
      }
      if (scheduleIsSchedulingView() && scheduleSchedulingMode() === 'day' && window.PlatformScheduleView?.renderResourceTimeScheduler) {
        const allSalesEvents = (Scheduling.eventsFromProjects?.(projects, config) || []).filter(isSalesAppointmentEvent);
        const draftStart = scheduleDraft?.start ? new Date(scheduleDraft.start) : null;
        const draftAssignment = userPayload(scheduleDraft?.user || null);
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
          allowCreate: canEditSchedule() && scheduleModeActive,
          allowEdit: canEditSchedule(),
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
            warnSalesDraftConflict(allSalesEvents, scheduleDraft);
            updateSchedulePanelConfirm();
            // Show the placed draft with its sales title and refresh the rail's assignee and status.
            renderSchedulePanelPreservingScroll();
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
            return `<div class="psv-event-menu"><div class="psv-event-action danger" data-psv-event-action="unassign"><i class="fas fa-user-minus"></i>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_07454f15891016"," Unassign") ?? " Unassign")}</div></div>`;
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
            ${String(currentEvent ? `<button type="button" class="r-travel-toggle ${scheduleLockTime ? 'active' : ''}" data-schedule-lock-time><span class="dot"></span>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_6af109c4fd5ab7"," Lock appointment time") ?? " Lock appointment time")}</button>` : '')}
            <button type="button" class="r-travel-toggle ${String(scheduleSmartScroll ? 'active' : '')}" data-schedule-smart-scroll><span class="dot"></span>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_87d3f1a9ae9c3e"," Smart scroll") ?? " Smart scroll")}</button>
            <button type="button" class="r-travel-toggle ${String(scheduleUseLiveTravel ? 'active' : '')}" data-schedule-live-travel><span class="dot"></span>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_821a653a1f79f2"," Live travel time") ?? " Live travel time")}</button>
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
          allowCreate: canEditSchedule() && scheduleModeActive,
          allowEdit: canEditSchedule(),
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
            warnSalesDraftConflict((Scheduling.eventsFromProjects?.(projects, config) || []).filter(isSalesAppointmentEvent), scheduleDraft);
            updateSchedulePanelConfirm();
            // Show the placed draft with its sales title and refresh the rail's assignee and status.
            renderSchedulePanelPreservingScroll();
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
      <div class="r-schedule-card" role="dialog" aria-modal="true" aria-labelledby="rScheduleDialogTitle">
        <h3 id="rScheduleDialogTitle">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_e5aee059bf2f35","Schedule Appointment") ?? "Schedule Appointment")}</h3>
        <p id="rScheduleDialogSub">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_b90dbdb90ce3a1","Choose a time and assign one or more eligible resources.") ?? "Choose a time and assign one or more eligible resources.")}</p>
        <div class="r-schedule-grid">
          <div class="r-schedule-field"><label for="rScheduleItemTitle">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_29dbd3d8b69f55","Title") ?? "Title")}</label><input type="text" id="rScheduleItemTitle" placeholder="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_5a654ad9b6d2e3","Appointment") ?? "Appointment")}"></div>
          <div class="r-schedule-field"><label for="rScheduleDate">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_2a0b11100c22a4","Date") ?? "Date")}</label><input type="date" id="rScheduleDate"></div>
          <div class="r-schedule-field" id="rScheduleTimeWrap"><label for="rScheduleTime">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_727840a47c2e4c","Time") ?? "Time")}</label><input type="time" id="rScheduleTime" step="900"></div>
          <div class="r-schedule-field" id="rScheduleDurationWrap"><label for="rScheduleDuration">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_bd8fd6e973f6e8","Duration") ?? "Duration")}</label><input type="number" id="rScheduleDuration" min="15" step="15"></div>
          <div class="r-schedule-field" id="rScheduleDaysWrap" hidden><label for="rScheduleDays">Days</label><input type="number" id="rScheduleDays" min="1" max="365" step="1" value="1"></div>
          <div class="r-schedule-field" id="rScheduleUsersWrap"><label for="rScheduleUsers">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_ef1dde5e6d8239","Assign People / Crews") ?? "Assign People / Crews")}</label><select id="rScheduleUsers" multiple size="4"></select></div>
          <div class="r-schedule-field" id="rScheduleEquipmentWrap"><label for="rScheduleEquipment">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_09d7f821d4f1df","Assign Vehicles / Equipment") ?? "Assign Vehicles / Equipment")}</label><select id="rScheduleEquipment" multiple size="4"></select></div>
        </div>
        <label class="r-schedule-allday" id="rScheduleAllDayWrap"><input type="checkbox" id="rScheduleAllDay"> All day</label>
        <label class="r-schedule-override" style="display:flex" id="rScheduleRecurringWrap"><input type="checkbox" id="rScheduleRecurring">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_fe2abf52e30aa8"," Make this item recur") ?? " Make this item recur")}</label>
        <div class="r-schedule-grid" id="rScheduleRecurringFields" hidden>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_ff7bb68b2b05a8","Frequency") ?? "Frequency")}</label><select id="rScheduleFrequency"><option value="weekly">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_093d55e6272fc0","Weekly") ?? "Weekly")}</option><option value="monthly" selected>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_d7014f792d2583","Monthly") ?? "Monthly")}</option><option value="quarterly">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_03e59d03617275","Quarterly") ?? "Quarterly")}</option><option value="yearly">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_ef289ba5429ef5","Yearly") ?? "Yearly")}</option></select></div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_b25bba33f32e79","Every") ?? "Every")}</label><input type="number" id="rScheduleInterval" min="1" max="120" value="1"></div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_949158d13efad4","Ends") ?? "Ends")}</label><select id="rScheduleEndMode"><option value="never">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_35304e673f218d","Never") ?? "Never")}</option><option value="date">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_ab4cb92c128c9b","On a date") ?? "On a date")}</option><option value="count">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_58e24f3e842b25","After a number of times") ?? "After a number of times")}</option></select></div>
          <div class="r-schedule-field" id="rScheduleEndDateWrap" hidden><label>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_75319fcfef3f5e","End date") ?? "End date")}</label><input type="date" id="rScheduleEndDate"></div>
          <div class="r-schedule-field" id="rScheduleCountWrap" hidden><label>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_328e02d666e842","Occurrences") ?? "Occurrences")}</label><input type="number" id="rScheduleCount" min="1" max="240" value="1"></div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_767fe02ce7276a","Bill each cycle") ?? "Bill each cycle")}</label><input type="number" id="rScheduleBillingAmount" min="0" step="0.01" placeholder="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_a3f9a6b065b2d8","Optional") ?? "Optional")}"></div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_d0aa9ef5b7f01c","Billing cadence") ?? "Billing cadence")}</label><select id="rScheduleBillingFrequency"><option value="weekly">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_093d55e6272fc0","Weekly") ?? "Weekly")}</option><option value="monthly">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_d7014f792d2583","Monthly") ?? "Monthly")}</option><option value="quarterly">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_03e59d03617275","Quarterly") ?? "Quarterly")}</option><option value="yearly">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_ef289ba5429ef5","Yearly") ?? "Yearly")}</option></select></div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_768d0068b06fa1","Expense per visit") ?? "Expense per visit")}</label><input type="number" id="rScheduleExpenseAmount" min="0" step="0.01" placeholder="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_a3f9a6b065b2d8","Optional") ?? "Optional")}"></div>
        </div>
        <div class="r-schedule-slots" id="rScheduleSlots"></div>
        <div class="r-schedule-status" id="rScheduleStatus" role="status"></div>
        <label class="r-schedule-override" id="rScheduleOverrideWrap"><input type="checkbox" id="rScheduleOverride">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_2ae9d90aead238"," Schedule anyway") ?? " Schedule anyway")}</label>
        <div class="r-schedule-advanced" id="rScheduleAdvancedFields" hidden>
          <div class="r-schedule-grid">
            <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_08f74e6b15e4cb","Equipment needed from") ?? "Equipment needed from")}</label><input type="datetime-local" id="rScheduleEquipmentStart"></div>
            <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_5a9e2da3c9a9db","Equipment needed until") ?? "Equipment needed until")}</label><input type="datetime-local" id="rScheduleEquipmentEnd"></div>
          </div>
          <div class="r-schedule-field"><label>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_37e79a797ef736","Equipment type requirements") ?? "Equipment type requirements")}</label><div class="r-schedule-equipment-requirements" id="rScheduleEquipmentRequirements"></div></div>
        </div>
        <div class="r-schedule-advanced-actions">
          <button type="button" class="r-schedule-advanced-toggle" id="rScheduleAdvanced" aria-label="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_c8cf170a6999a6","Show advanced event fields") ?? "Show advanced event fields")}" title="${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_bec5274b269a70","Advanced event fields") ?? "Advanced event fields")}" aria-pressed="false"><i class="fas fa-sliders"></i></button>
          <button type="button" class="r-schedule-action secondary r-schedule-series-cancel" id="rScheduleSeriesCancel" hidden>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_6c097c79cef08a","Cancel series") ?? "Cancel series")}</button>
          <div class="r-schedule-actions">
            <button type="button" class="r-schedule-action secondary" id="rScheduleCancel">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
            <button type="button" class="r-schedule-action" id="rScheduleSave">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_fc05a804bd034c","Schedule") ?? "Schedule")}</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.addEventListener('mousedown', (event) => { dialog.__downBackdrop = event.target === dialog; });
    dialog.addEventListener('mouseup', (event) => {
      if (dialog.__downBackdrop && event.target === dialog) closeScheduleDialog();
      dialog.__downBackdrop = false;
    });
    $('#rScheduleCancel')?.addEventListener('click', () => closeScheduleDialog());
    return dialog;
  }

  // Schedule dialogs join the portal modal stack so they paint above the
  // project window in every placement and Escape closes them before it.
  function registerScheduleLayer(element, id, onClose){
    const handle = window.Portal?.modals?.register?.(element, { id, closeOnEscape:true, closeOnBackdrop:false, onClose }) || null;
    if (!handle) element.style.zIndex = '2147483600';
    return handle;
  }

  let scheduleDialogReturnFocus = null;
  let scheduleDialogReturnSelector = '';
  function showScheduleDialog(dialog){
    // Last in the document so it also wins against an equal stacking level.
    if (dialog.parentElement !== document.body || dialog.nextElementSibling) document.body.appendChild(dialog);
    const active = document.activeElement;
    if (!dialog.classList.contains('active')) {
      scheduleDialogReturnFocus = active && active !== document.body && !dialog.contains(active) ? active : null;
      // The sidebar may re-render while the dialog is open; remember how to
      // find the same control again.
      const attr = scheduleDialogReturnFocus ? ['data-new-production', 'data-new-recurrence', 'data-new-appointment', 'data-edit-recurrence', 'data-production-resource-event', 'data-other-event', 'data-prs-event-id', 'data-psv-gantt-open', 'data-psv-gantt-bar'].find((name) => scheduleDialogReturnFocus.hasAttribute?.(name)) : '';
      scheduleDialogReturnSelector = attr ? `[${attr}="${cssEscape(scheduleDialogReturnFocus.getAttribute(attr) || '')}"]` : '';
    }
    dialog.classList.add('active');
    dialog.querySelector('.r-schedule-card')?.scrollTo?.(0, 0);
    scheduleDialogHandle?.unregister?.();
    scheduleDialogHandle = registerScheduleLayer(dialog, 'project-schedule-dialog', () => closeScheduleDialog());
  }

  function closeScheduleDialog(){
    const dialog = $('#rScheduleDialog');
    const wasOpen = !!dialog?.classList.contains('active');
    if (dialog?.contains(document.querySelector('fm-date-time-picker'))) window.FirstMateDateTimePicker?.close?.(false);
    dialog?.classList.remove('active');
    const handle = scheduleDialogHandle;
    scheduleDialogHandle = null;
    handle?.unregister?.();
    // Focus returns to what opened the dialog (when it is still there).
    const returnTo = scheduleDialogReturnFocus?.isConnected ? scheduleDialogReturnFocus : (scheduleDialogReturnSelector ? document.querySelector(scheduleDialogReturnSelector) : null);
    scheduleDialogReturnFocus = null;
    scheduleDialogReturnSelector = '';
    if (wasOpen && returnTo?.isConnected && typeof returnTo.focus === 'function') {
      try { returnTo.focus({ preventScroll:true }); } catch (_) {}
    }
  }

  function scheduleDialogOpen(){
    return !!$('#rScheduleDialog')?.classList.contains('active');
  }

  // One name per item type for the whole life of the dialog (the loaded
  // configuration's own labels, e.g. "Project Work", never replace it).
  function scheduleDialogTypeLabel(eventTypeId = '', eventType = {}){
    if (eventTypeId === 'project_work') return window.Portal?.terminology?.get?.('scheduling.production_view', 'Production') || (globalThis.PlatformLanguage?.text("project-schedule","m_c2e6380e130020","Production") ?? "Production");
    if (eventTypeId === 'sales_appointment') return 'Sales Appointment';
    return String(eventType?.label || '').trim() || 'Appointment';
  }

  function scheduleDialogHeading(eventTypeId = '', eventType = {}, recurring = false, existingSeries = false, editing = false){
    if (existingSeries) return 'Edit recurring item';
    const label = scheduleDialogTypeLabel(eventTypeId, eventType);
    if (editing) return `Edit ${label.toLowerCase()}`;
    return recurring ? `New recurring ${label.toLowerCase()}` : `Schedule ${label}`;
  }

  // Defaults land on the next working-hour slot that fits the item's length
  // (a full-day job starts the next morning, not at 3 PM).
  function defaultScheduleStart(windowStart = '08:00', windowEnd = '17:00', durationMinutes = 60){
    const [startHour, startMinute] = String(windowStart || '08:00').split(':').map((part) => Number(part) || 0);
    const [endHour, endMinute] = String(windowEnd || '17:00').split(':').map((part) => Number(part) || 0);
    const next = new Date(Date.now() + 60 * 60000);
    next.setMinutes(0, 0, 0);
    const minutes = next.getHours() * 60 + next.getMinutes();
    const open = startHour * 60 + startMinute;
    const close = endHour * 60 + endMinute;
    const length = Math.max(15, Math.min(Math.max(60, close - open), Number(durationMinutes) || 60));
    if (minutes < open) next.setHours(startHour, startMinute, 0, 0);
    else if (minutes + length > close) {
      next.setDate(next.getDate() + 1);
      next.setHours(startHour, startMinute, 0, 0);
    }
    return next;
  }

  // Crews/subcontractors already booked on another scheduled item (any
  // project) for the chosen time. People are checked by availability.
  function scheduleCrewConflicts(resourceIds = [], start, end, { excludeId = '', excludeSeriesId = '', includePeople = false } = {}){
    const Scheduling = window.PlatformScheduling;
    const ids = new Set(resourceIds.map(String).filter(Boolean));
    if (!ids.size || !(start instanceof Date) || !(end instanceof Date) || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return [];
    const projects = mergeScheduleActiveProject(scheduleCachedProjects);
    const events = (Scheduling?.eventsFromProjects?.(projects, scheduleCachedConfig || null) || [])
      .filter((event) => String(event.id || '') !== String(excludeId || '') && (!excludeSeriesId || String(event.recurrence_series_id || '') !== String(excludeSeriesId)))
      .filter((event) => !scheduleEventIsGroup(event) && materialEventIsScheduled(event))
      .filter((event) => !['cancelled', 'canceled', 'completed', 'done'].includes(String(event.status || '').toLowerCase()));
    const conflicts = [];
    events.forEach((event) => {
      const eventStart = Scheduling?.eventStart?.(event);
      const eventEnd = Scheduling?.eventEnd?.(event);
      if (!eventStart || !eventEnd || !(eventStart < end && eventEnd > start)) return;
      eventWorkAssignees(event).filter((ref) => (includePeople || ref.kind !== 'organization_user') && ids.has(ref.id)).forEach((ref) => {
        conflicts.push({ resource:ref, event });
      });
    });
    return conflicts;
  }

  // The dialog element is reused; answers that arrive for an earlier opening
  // (availability checks) must not touch the current one.
  let scheduleDialogSession = 0;
  async function openScheduleDialog(eventTypeId = 'sales_appointment', recurringSeries = null, options = {}){
    if (!requireScheduleEdit()) return null;
    const session = ++scheduleDialogSession;
    const isCurrentSession = () => session === scheduleDialogSession;
    const Scheduling = window.PlatformScheduling;
    const orgId = scheduleOrgId();
    let project = currentSchedulingProject();
    if (!Scheduling || !orgId) {
      showToast((globalThis.PlatformLanguage?.text("project-schedule","m_9cae930e9e6682","Scheduling unavailable") ?? "Scheduling unavailable"), (globalThis.PlatformLanguage?.text("project-schedule","m_467e6db386c0e7","Could not load the scheduling tools for this project.") ?? "Could not load the scheduling tools for this project."), false);
      return;
    }
    // Editing a placed item (the details popover's Edit).
    // The copy being edited (replaced by the stored copy when someone else
    // saved the item meanwhile, so a second Save builds on it).
    let editEvent = !recurringSeries && options.event?.id
      ? (scheduleProjectEvents().find((item) => String(item.id || '') === String(options.event.id)) || options.event)
      : null;
    const dialog = ensureScheduleDialog();
    const dateInput = $('#rScheduleDate');
    const timeInput = $('#rScheduleTime');
    const itemTitleInput = $('#rScheduleItemTitle');
    const durationInput = $('#rScheduleDuration');
    const daysInput = $('#rScheduleDays');
    const allDayInput = $('#rScheduleAllDay');
    const allDayWrap = $('#rScheduleAllDayWrap');
    const timeWrap = $('#rScheduleTimeWrap');
    const durationWrap = $('#rScheduleDurationWrap');
    const daysWrap = $('#rScheduleDaysWrap');
    const usersInput = $('#rScheduleUsers');
    const slotsEl = $('#rScheduleSlots');
    const statusEl = $('#rScheduleStatus');
    const saveBtn = $('#rScheduleSave');
    const overrideWrap = $('#rScheduleOverrideWrap');
    const overrideInput = $('#rScheduleOverride');
    const titleEl = $('#rScheduleDialogTitle');
    const subEl = $('#rScheduleDialogSub');
    const recurringInput = $('#rScheduleRecurring');
    const recurringWrap = $('#rScheduleRecurringWrap');
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
    const seriesCancelButton = $('#rScheduleSeriesCancel');
    const wantsRecurring = !!recurringSeries || options.recurring === true;

    titleEl.textContent = scheduleDialogHeading(eventTypeId, scheduleCachedConfig?.event_types?.[eventTypeId] || {}, wantsRecurring, !!recurringSeries, !!editEvent);
    subEl.textContent = 'Loading who can be assigned…';
    recurringInput.checked = wantsRecurring;
    recurringFields.hidden = !wantsRecurring;
    // An existing item is edited as itself; repeating it is a new series.
    if (recurringWrap) recurringWrap.hidden = !!editEvent;
    if (seriesCancelButton) seriesCancelButton.hidden = !recurringSeries?.id || String(recurringSeries?.status || '') === 'cancelled';
    saveBtn.disabled = true;
    saveBtn.removeAttribute('aria-busy');
    delete saveBtn.dataset.saving;
    // Editing an item or a series saves it; only a new item is "scheduled".
    const saveLabel = editEvent || recurringSeries ? 'Save' : 'Schedule';
    saveBtn.textContent = saveLabel;
    overrideInput.checked = false;
    overrideWrap?.classList.remove('visible');
    // Until the branch settings and people are loaded the form shows what is
    // already known (title, date, time) but can't be edited, so nothing typed
    // meanwhile is overwritten when the data arrives.
    const dialogCard = dialog.querySelector('.r-schedule-card');
    const setDialogLoading = (loading) => {
      dialogCard?.classList.toggle('loading', loading);
      if (loading) dialogCard?.setAttribute('aria-busy', 'true');
      else dialogCard?.removeAttribute('aria-busy');
      dialogCard?.querySelectorAll('.r-schedule-grid input, .r-schedule-grid select, .r-schedule-allday input, #rScheduleRecurringWrap input, #rScheduleOverride, #rScheduleAdvanced').forEach((control) => { control.disabled = loading; });
    };
    {
      const knownEvent = recurringSeries?.event_template || editEvent || {};
      const knownStart = recurringSeries?.start_at ? new Date(recurringSeries.start_at) : (editEvent ? (Scheduling.eventStart?.(editEvent) || null) : (options.start ? new Date(options.start) : null));
      itemTitleInput.value = recurringSeries?.title || knownEvent.title || '';
      itemTitleInput.placeholder = eventTypeId === 'project_work' ? 'e.g. Gutter install' : scheduleDialogTypeLabel(eventTypeId, scheduleCachedConfig?.event_types?.[eventTypeId] || {});
      if (knownStart && Number.isFinite(knownStart.getTime())) {
        const knownAllDay = editEvent ? (typeof Scheduling.eventIsAllDay === 'function' ? Scheduling.eventIsAllDay(editEvent) : editEvent.all_day !== false) : options.allDay === true;
        dateInput.value = scheduleLocalDate(knownStart);
        timeInput.value = knownAllDay ? '' : `${String(knownStart.getHours()).padStart(2, '0')}:${String(knownStart.getMinutes()).padStart(2, '0')}`;
      } else {
        dateInput.value = '';
        timeInput.value = '';
      }
    }
    setDialogLoading(true);
    showScheduleDialog(dialog);
    statusEl.textContent = (globalThis.PlatformLanguage?.text("project-schedule","m_e936b49093ae54","Loading availability...") ?? "Loading availability...");
    statusEl.classList.remove('bad');
    usersInput.innerHTML = '';
    slotsEl.innerHTML = '';

    let config = null;
    let users = [];
    let projects = [];
    try {
      ({ config, users, projects } = await loadScheduleData());
    } catch (error) {
      if (!isCurrentSession()) return;
      setDialogLoading(false);
      statusEl.textContent = (globalThis.PlatformLanguage?.text("project-schedule","m_162d3a1aa54d57","Could not load scheduling data.") ?? "Could not load scheduling data.");
      statusEl.classList.add('bad');
      return;
    }
    if (!isCurrentSession()) return;
    setDialogLoading(false);

    // The item (or series template) being edited supplies every field.
    const seriesEvent = recurringSeries?.event_template || editEvent || {};
    const seriesRule = recurringSeries?.recurrence || {};
    const seriesBilling = recurringSeries?.billing || {};
    const seriesExpenses = recurringSeries?.expenses || {};
    eventTypeId = recurringSeries ? String(seriesEvent.event_type_default_id || eventTypeId) : (editEvent ? scheduleEventTypeId(editEvent) : eventTypeId);
    const eventType = config.event_types?.[eventTypeId] || {};
    const requiredRoleIds = Array.isArray(eventType.required_role_ids) ? eventType.required_role_ids : (Array.isArray(eventType.role_ids) ? eventType.role_ids : []);
    const allowedRoleIds = Array.isArray(eventType.allowed_role_ids) ? eventType.allowed_role_ids : (Array.isArray(eventType.role_ids) ? eventType.role_ids : requiredRoleIds);
    const roleIds = Array.from(new Set([...requiredRoleIds, ...allowedRoleIds]));
    const assignableSubjects = scheduleAssignableSubjects(eventTypeId, String(seriesEvent.scope_template_id || ''), config, users);
    // Whoever is already assigned stays selected (and listed) when editing.
    const initialAssignees = eventWorkAssignees(seriesEvent);
    initialAssignees.forEach((ref) => {
      if (!assignableSubjects.some((subject) => String(subject.id) === ref.id)) assignableSubjects.push({ id:ref.id, name:ref.name, subject_type:ref.kind, resource_kind:ref.kind });
    });
    const duration = Number(eventType.duration_minutes || 60);
    const typeLabel = scheduleDialogTypeLabel(eventTypeId, eventType);
    titleEl.textContent = scheduleDialogHeading(eventTypeId, eventType, wantsRecurring, !!recurringSeries, !!editEvent);
    const subjectCounts = assignableSubjects.reduce((counts, subject) => {
      if (String(subject.subject_type || subject.resource_kind || 'organization_user') === 'organization_user') counts.people += 1;
      else counts.groups += 1;
      return counts;
    }, { people:0, groups:0 });
    const countParts = [
      subjectCounts.groups ? `${subjectCounts.groups} ${workforceTerm('resource_group', subjectCounts.groups === 1 ? 'singular' : 'plural').toLowerCase()}` : '',
      subjectCounts.people ? `${subjectCounts.people} ${subjectCounts.people === 1 ? 'person' : 'people'}` : ''
    ].filter(Boolean);
    subEl.textContent = countParts.length
      ? `Choose a time, then assign any of the ${countParts.join(' and ')} this event type allows.`
      : 'Choose a time. Nobody is eligible for this event type yet, so it will be left unassigned.';
    const seriesStart = recurringSeries?.start_at
      ? new Date(recurringSeries.start_at)
      : (editEvent ? (Scheduling.eventStart?.(editEvent) || null) : (options.start ? new Date(options.start) : null));
    const workWindow = Scheduling.availabilityWindow ? Scheduling.availabilityWindow(config, Scheduling.localDateInput(seriesStart && Number.isFinite(seriesStart.getTime()) ? seriesStart : new Date()), eventTypeId) : null;
    const defaultStart = defaultScheduleStart(workWindow?.start || '08:00', workWindow?.end || '17:00', Number(options.durationMinutes || seriesEvent.duration_minutes || duration));
    // A new item with no chosen time opens on the first time that is
    // actually open (checked with the availability service below), not on a
    // default that is immediately "not available".
    let autoPickDays = !editEvent && !recurringSeries && !options.start ? 14 : 0;
    const editAllDay = editEvent ? (typeof Scheduling.eventIsAllDay === 'function' ? Scheduling.eventIsAllDay(editEvent) : editEvent.all_day !== false && editEvent.schedule_granularity !== 'time') : false;
    const startsAllDay = editEvent ? editAllDay : (!recurringSeries && options.allDay === true);
    dateInput.value = seriesStart && Number.isFinite(seriesStart.getTime()) ? Scheduling.localDateInput(seriesStart) : Scheduling.localDateInput(defaultStart);
    // A whole-day click keeps the working day's start as its time.
    const seedTime = seriesStart && Number.isFinite(seriesStart.getTime()) && !startsAllDay
      ? seriesStart
      : (() => { const [h, m] = String(workWindow?.start || '08:00').split(':').map(Number); const date = new Date(defaultStart); if (seriesStart) date.setHours(Number(h) || 8, Number(m) || 0, 0, 0); return date; })();
    timeInput.value = `${String(seedTime.getHours()).padStart(2, '0')}:${String(seedTime.getMinutes()).padStart(2, '0')}`;
    const editDuration = editEvent ? Math.max(15, Math.round(((Scheduling.eventEnd?.(editEvent) || seedTime) - (Scheduling.eventStart?.(editEvent) || seedTime)) / 60000) || duration) : 0;
    durationInput.value = editEvent ? (editAllDay ? duration : editDuration) : Number(options.durationMinutes || seriesEvent.duration_minutes || duration);
    if (editEvent && editAllDay) {
      const start = Scheduling.eventStart?.(editEvent);
      const end = Scheduling.eventEnd?.(editEvent);
      daysInput.value = String(start && end ? Math.max(1, Math.round((scheduleAddDays(end, 0) - scheduleAddDays(start, 0)) / 86400000) || 1) : 1);
    } else daysInput.value = String(Math.max(1, Number(options.days) || 1));
    allDayInput.checked = startsAllDay;
    if (allDayWrap) allDayWrap.hidden = !!recurringSeries || wantsRecurring;
    itemTitleInput.placeholder = eventTypeId === 'project_work' ? 'e.g. Gutter install' : typeLabel;
    itemTitleInput.value = recurringSeries?.title || seriesEvent.title || '';
    recurringInput.checked = wantsRecurring;
    frequencyInput.value = String(seriesRule.frequency || 'monthly');
    intervalInput.value = String(seriesRule.interval || 1);
    endModeInput.value = Number(seriesRule.occurrence_count) > 0 ? 'count' : (seriesRule.end_at ? 'date' : 'never');
    endDateInput.value = String(seriesRule.end_at || '').slice(0, 10);
    countInput.value = String(Math.max(1, Number(seriesRule.occurrence_count || 1)));
    billingAmountInput.value = seriesBilling.amount_cents ? (Number(seriesBilling.amount_cents) / 100).toFixed(2) : '';
    billingFrequencyInput.value = String(seriesBilling.frequency || seriesRule.frequency || 'monthly');
    if (!billingFrequencyInput.value) billingFrequencyInput.value = 'monthly';
    // Billing follows the visit cadence until it is chosen separately.
    let billingEdited = !!seriesBilling.frequency && String(seriesBilling.frequency) !== String(seriesRule.frequency || '');
    billingFrequencyInput.onchange = () => { billingEdited = true; };
    frequencyInput.onchange = () => {
      if (!billingEdited && [...billingFrequencyInput.options].some((option) => option.value === frequencyInput.value)) billingFrequencyInput.value = frequencyInput.value;
    };
    expenseAmountInput.value = seriesExpenses.amount_cents ? (Number(seriesExpenses.amount_cents) / 100).toFixed(2) : '';
    const selectedEquipmentIds = new Set((Array.isArray(seriesEvent.resource_refs) ? seriesEvent.resource_refs : [])
      .filter((ref) => String(ref?.kind || '') === 'equipment_unit').map((ref) => String(ref.id || '')));
    if (equipmentInput) equipmentInput.innerHTML = scheduleCachedEquipmentUnits.map((unit) => {
      const label = `${unit.name || unit.id}${unit.type_name ? ` — ${unit.type_name}` : ''}`;
      return `<option value="${escapeHtml(unit.id || '')}" data-equipment-label="${escapeHtml(label)}" data-equipment-name="${escapeHtml(unit.name || unit.id || '')}" ${selectedEquipmentIds.has(String(unit.id || '')) ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    const firstEquipmentRef = (Array.isArray(seriesEvent.resource_refs) ? seriesEvent.resource_refs : []).find((ref) => String(ref?.kind || '') === 'equipment_unit') || {};
    const localDateTime = (value) => {
      const date = value instanceof Date ? value : new Date(value);
      if (!Number.isFinite(date.getTime())) return '';
      const pad = (part) => String(part).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    // The equipment window follows the appointment time until someone edits it.
    // (An item being edited whose equipment window matches its own time keeps
    // following it; only a window set separately stays put.)
    const followsEditedItem = !!editEvent && (() => {
      const refStart = Date.parse(firstEquipmentRef.start_at || '');
      const refEnd = Date.parse(firstEquipmentRef.end_at || '');
      const itemStart = Scheduling.eventStart?.(editEvent)?.getTime?.();
      const itemEnd = Scheduling.eventEnd?.(editEvent)?.getTime?.();
      return (!Number.isFinite(refStart) || refStart === itemStart) && (!Number.isFinite(refEnd) || refEnd === itemEnd);
    })();
    let equipmentWindowEdited = !followsEditedItem && !!(firstEquipmentRef.start_at || firstEquipmentRef.end_at);
    const syncEquipmentWindow = () => {
      if (equipmentWindowEdited) return;
      const { start, end } = selectedRange();
      if (!Number.isFinite(start.getTime())) return;
      if (equipmentStartInput) equipmentStartInput.value = localDateTime(start);
      if (equipmentEndInput) equipmentEndInput.value = localDateTime(end);
    };
    if (equipmentStartInput) equipmentStartInput.value = localDateTime(firstEquipmentRef.start_at || selectedRange().start);
    if (equipmentEndInput) equipmentEndInput.value = localDateTime(firstEquipmentRef.end_at || selectedRange().end);
    [equipmentStartInput, equipmentEndInput].forEach((input) => {
      if (input) input.onchange = () => { equipmentWindowEdited = true; void renderEquipmentAvailability(); };
    });
    // Units that are down or booked during the equipment window say so (as
    // in the global editor's picker) and, when the company blocks equipment
    // conflicts, can't be picked. A unit already selected stays selectable
    // so it can be removed; Save names it instead.
    let equipmentAvailabilityGeneration = 0;
    let equipmentAvailability = { key:'', notes:new Map() };
    const equipmentAvailabilityWindow = () => {
      const { start, end } = selectedRange();
      const from = new Date(equipmentStartInput?.value || start);
      const until = new Date(equipmentEndInput?.value || end);
      return Number.isFinite(from.getTime()) && Number.isFinite(until.getTime()) && until > from ? { start:from, end:until } : null;
    };
    const equipmentAvailabilityKey = () => {
      const range = equipmentAvailabilityWindow();
      return range ? `${range.start.toISOString()}|${range.end.toISOString()}` : '';
    };
    const applyEquipmentNotes = () => {
      Array.from(equipmentInput?.options || []).forEach((option) => {
        const note = equipmentAvailability.notes.get(String(option.value || '')) || null;
        const base = option.dataset.equipmentLabel || option.textContent;
        // The list is narrow: with a note the unit name and its status fit
        // (the type is dropped); a greyed, disabled row reads as unavailable
        // and the full reason is on hover.
        option.textContent = note ? `${option.dataset.equipmentName || base} · ${note.label}` : base;
        option.disabled = !!note?.blocked && !option.selected;
        if (note) option.title = `${note.reason}${note.blocked ? ' Unavailable for this time.' : ''}`;
        else option.removeAttribute('title');
      });
    };
    async function renderEquipmentAvailability(){
      if (!equipmentInput || !equipmentSchedulingEnabled() || !scheduleCachedEquipmentUnits.length || typeof window.EquipmentAPI?.request !== 'function') return;
      const generation = ++equipmentAvailabilityGeneration;
      const range = equipmentAvailabilityWindow();
      const key = equipmentAvailabilityKey();
      if (!range) {
        equipmentAvailability = { key:'', notes:new Map() };
        applyEquipmentNotes();
        return;
      }
      if (key === equipmentAvailability.key) return;
      try {
        const query = new URLSearchParams({ start:range.start.toISOString(), end:range.end.toISOString() });
        if (editEvent?.id) query.set('exclude_event_id', String(editEvent.id));
        const [mode, result] = await Promise.all([
          loadEquipmentConflictMode(),
          window.EquipmentAPI.request(`/organizations/${encodeURIComponent(orgId)}/availability?${query.toString()}`)
        ]);
        if (generation !== equipmentAvailabilityGeneration || !scheduleDialogOpen() || !isCurrentSession()) return;
        const notes = new Map();
        (Array.isArray(result?.units) ? result.units : []).forEach((report) => {
          const note = mode === 'off' ? null : equipmentAvailabilityNote(report, mode);
          if (note) notes.set(String(report.id || ''), note);
        });
        equipmentAvailability = { key, notes };
      } catch (_) {
        if (generation !== equipmentAvailabilityGeneration) return;
        equipmentAvailability = { key:'', notes:new Map() };
      }
      applyEquipmentNotes();
    }
    if (equipmentInput) equipmentInput.onchange = () => {
      applyEquipmentNotes();
      // A refusal about the equipment no longer applies once the pick changes.
      if (statusEl?.classList.contains('bad')) { statusEl.textContent = ''; statusEl.classList.remove('bad'); }
    };
    const existingRequirements = Array.isArray(seriesEvent.resource_requirements) ? seriesEvent.resource_requirements : [];
    if (equipmentRequirements) equipmentRequirements.innerHTML = scheduleCachedEquipmentTypes.length
      ? scheduleCachedEquipmentTypes.map((type) => {
          const requirement = existingRequirements.find((item) => String(item?.equipment_type_id || '') === String(type.id || ''));
          return `<label class="r-schedule-equipment-requirement"><input type="checkbox" data-equipment-requirement="${String(escapeHtml(type.id || ''))}" ${String(requirement ? 'checked' : '')}><span>${String(escapeHtml(type.name || type.id))}</span><input type="number" min="1" max="99" value="${String(escapeHtml(requirement?.quantity || 1))}" data-equipment-requirement-quantity="${String(escapeHtml(type.id || ''))}" aria-label="${((v5) => globalThis.PlatformLanguage?.htmlText("project-schedule","m_138872c73d447c",`${v5} quantity`,{v5}) ?? `${v5} quantity`)(escapeHtml(type.name || 'Equipment'))}"></label>`;
        }).join('')
      : `<div class="r-schedule-status">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_80651b68bcfcb3","No equipment types have been configured yet.") ?? "No equipment types have been configured yet.")}</div>`;
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

    function allDaySelected(){
      return allDayInput.checked === true && !recurringInput.checked;
    }
    function renderAllDay(){
      const allDay = allDaySelected();
      if (timeWrap) timeWrap.hidden = allDay;
      if (durationWrap) durationWrap.hidden = allDay;
      if (daysWrap) daysWrap.hidden = !allDay;
      if (allDayWrap) allDayWrap.hidden = !!recurringSeries || recurringInput.checked;
    }
    renderAllDay();

    function selectedStart(){
      if (allDaySelected()) return new Date(`${dateInput.value}T00:00:00`);
      return new Date(`${dateInput.value}T${timeInput.value || '09:00'}:00`);
    }
    function selectedRange(){
      const start = selectedStart();
      if (allDaySelected()) return { start, end:scheduleAddDays(start, Math.max(1, Math.round(Number(daysInput.value) || 1))) };
      return { start, end:new Date(start.getTime() + Math.max(1, Number(durationInput.value || duration)) * 60000) };
    }

    // The first crew is the primary: whoever is already assigned keeps their
    // order (primary first), then newly added ones in list order — so an
    // edit that doesn't touch the crew never swaps the primary.
    function selectedUserIds(){
      const ids = Array.from(usersInput.selectedOptions || []).map((option) => option.value).filter(Boolean);
      const rank = (id) => { const index = initialAssignees.findIndex((ref) => ref.id === id); return index < 0 ? initialAssignees.length : index; };
      return ids.map((id, index) => ({ id, index })).sort((a, b) => (rank(a.id) - rank(b.id)) || (a.index - b.index)).map((entry) => entry.id);
    }

    function assignedUsersForIds(ids){
      return ids.map((id) => {
        const user = assignableSubjects.find((item) => item.id === id && item.subject_type === 'organization_user');
        if (!user) return null;
        return { id, name: user?.name || user?.email || id, role_ids: user?.roles?.length ? user.roles : roleIds };
      }).filter(Boolean);
    }

    // Seed the list with the current assignees selected, so the first
    // availability pass keeps them.
    usersInput.innerHTML = initialAssignees.map((ref) => `<option value="${escapeHtml(ref.id)}" selected>${escapeHtml(ref.name || ref.id)}</option>`).join('');

    // What decides availability (date, time, length, crew): an edit that
    // keeps all of it isn't re-checked.
    const schedulingKey = () => JSON.stringify([dateInput.value, allDaySelected() ? '' : timeInput.value, allDaySelected() ? '' : String(durationInput.value), allDaySelected() ? String(daysInput.value) : '', allDaySelected(), recurringInput.checked, selectedUserIds().slice().sort()]);
    let originalSchedulingKey = null;
    const schedulingUnchanged = () => !!editEvent && materialEventIsScheduled(editEvent) && originalSchedulingKey !== null && schedulingKey() === originalSchedulingKey;
    let availabilityGeneration = 0;
    let authoritativeSlots = [];
    const authoritativeAvailability = () => window.PlatformAPI?.appointments?.availability?.(orgId, {
      project_id:project?.id || '',
      event_id:String(editEvent?.id || scheduleAssignmentEventId || scheduleSelectedEventId || ''),
      event_type_id:eventTypeId,
      start_date:dateInput.value,
      end_date:dateInput.value,
      duration_minutes:Number(durationInput.value || duration),
      limit:500
    });
    const selectedResourceKeys = () => assignableSubjects
      .filter((subject) => selectedUserIds().includes(subject.id))
      .map((subject) => `${subject.subject_type || subject.resource_kind || 'organization_user'}:${subject.id}`.toLowerCase());
    // The routed availability service reports people and equipment units. A
    // selected crew or subcontractor has no candidate key there; those are
    // checked against the items they are already booked on instead.
    let reportedCandidateKinds = new Set();
    const resourceKeyKind = (key) => String(key || '').split(':')[0];
    const slotSupportsSelection = (slot) => {
      const selectedKeys = selectedResourceKeys().filter((key) => reportedCandidateKinds.has(resourceKeyKind(key)));
      if (!selectedKeys.length) return slot?.available === true;
      const candidateKeys = new Set((Array.isArray(slot?.candidates) ? slot.candidates : []).map((candidate) => String(candidate.resource_key || '').toLowerCase()));
      return slot?.available === true && selectedKeys.every((key) => candidateKeys.has(key));
    };
    const crewConflictText = () => {
      const { start, end } = selectedRange();
      const crewIds = assignableSubjects.filter((subject) => selectedUserIds().includes(subject.id) && subject.subject_type !== 'organization_user').map((subject) => subject.id);
      const conflicts = scheduleCrewConflicts(crewIds, start, end, { excludeId:editEvent?.id || '', excludeSeriesId:recurringSeries?.id || '' });
      if (!conflicts.length) return '';
      const first = conflicts[0];
      const more = conflicts.length > 1 ? ` and ${conflicts.length - 1} other item${conflicts.length === 2 ? '' : 's'}` : '';
      return `${first.resource.name || 'That crew'} is already booked on “${scheduleEventDisplayTitle(first.event)}” (${workRangeLabel(first.event)})${more}.`;
    };
    const applyOutcome = (available, message) => {
      // Editing only the title, description or equipment of a placed item
      // keeps its time and crew: nothing to check, Save stays available.
      const unchanged = schedulingUnchanged();
      const conflict = unchanged ? '' : crewConflictText();
      const ok = unchanged || (available && !conflict);
      if (unchanged && !available) message = 'The time and crew stay as they are.';
      statusEl.classList.toggle('bad', !ok);
      statusEl.textContent = conflict ? `${conflict} Pick another time or check “Schedule anyway”.` : message;
      if (overrideWrap) overrideWrap.classList.toggle('visible', !ok || !!overrideInput?.checked);
      saveBtn.disabled = !ok && !overrideInput?.checked;
      saveBtn.textContent = saveLabel === 'Save' ? (ok || !overrideInput?.checked ? 'Save' : 'Save anyway') : (ok ? 'Schedule' : (overrideInput?.checked ? 'Schedule Anyway' : 'Schedule'));
    };

    // The inputs the last availability pass used: a change event that only
    // repeats an input event (e.g. the field losing focus to a click on
    // Schedule anyway) doesn't redraw the status under the pointer.
    let renderedInputsKey = '';
    const inputsKey = () => `${schedulingKey()}|${overrideInput?.checked === true}`;
    function renderAvailability(){
      renderedInputsKey = inputsKey();
      renderAllDay();
      const start = selectedStart();
      const durationMinutes = Number(durationInput.value || duration);
      const selectedIds = selectedUserIds();
      const selectedAssignedUsers = assignedUsersForIds(selectedIds);
      const selectedResourceSubjects = assignableSubjects.filter((subject) => selectedIds.includes(subject.id) && subject.subject_type !== 'organization_user');
      const allDay = allDaySelected();
      // A series being edited never clashes with its own occurrences.
      const availabilityProjects = recurringSeries?.id
        ? projects.map((item) => ({ ...item, events:(Array.isArray(item?.events) ? item.events : []).filter((entry) => String(entry?.recurrence_series_id || '') !== String(recurringSeries.id)) }))
        : projects;
      const eventAvailability = Scheduling.availabilityForEventType({
        users,
        projects:availabilityProjects,
        eventType,
        eventTypeId,
        start,
        durationMinutes,
        assignedUserIds: selectedAssignedUsers.map((user) => user.id),
        assignedUsers: selectedAssignedUsers,
        excludeEventId: editEvent?.id || ''
      });
      // Everyone this event type allows is listed (the heading counts them);
      // crews and people already booked on another item then are marked
      // instead of hidden.
      const range = selectedRange();
      const booked = new Set(scheduleCrewConflicts(assignableSubjects.map((subject) => subject.id), range.start, range.end, { excludeId:editEvent?.id || '', excludeSeriesId:recurringSeries?.id || '', includePeople:true }).map((entry) => entry.resource.id));
      usersInput.innerHTML = `<option value="">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_f63dccd2774d7e","Assign later") ?? "Assign later")}</option>` + assignableSubjects.map((user) => {
        const roleLabel = (user.mapped_roles || []).map((role) => role.label).join(', ');
        const selected = selectedIds.includes(user.id) ? 'selected' : '';
        return `<option value="${escapeHtml(user.id)}" ${selected}>${escapeHtml(user.name || user.email || user.id)}${roleLabel ? ` - ${escapeHtml(roleLabel)}` : ''}${booked.has(String(user.id)) ? ' — booked then' : ''}</option>`;
      }).join('');
      const hasAvailability = allDay || eventAvailability.hasAvailability || selectedResourceSubjects.length > 0 || (!selectedIds.length && eventType.assignment_policy?.allow_unassigned !== false);
      const assignedBusy = (eventAvailability.assignedStatus || []).filter((entry) => entry.busy).map((entry) => entry.user.name || entry.user.email || entry.user.id);
      applyOutcome(hasAvailability, allDay
        ? `All day, ${selectedRange().start.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' })}${Number(daysInput.value) > 1 ? ` for ${Math.round(Number(daysInput.value))} days` : ''}.`
        : hasAvailability
          ? `${assignableSubjects.length} eligible for ${start.toLocaleString([], { weekday:'short', hour:'numeric', minute:'2-digit' })}.`
          : assignedBusy.length
            ? `${assignedBusy.join(', ')} is already booked at that time.`
            : 'Required roles are not fully available at that time.');
      syncEquipmentWindow();
      void renderEquipmentAvailability();
      void renderSlots();
    }

    async function renderSlots(){
      const generation = ++availabilityGeneration;
      // Whole days and series are not limited to appointment slots.
      if (allDaySelected() || recurringInput.checked) {
        slotsEl.classList.remove('checking');
        slotsEl.removeAttribute('aria-busy');
        slotsEl.innerHTML = '';
        return;
      }
      saveBtn.disabled = true;
      // Keep the previous times on screen while re-checking so the centered
      // dialog does not jump under the pointer mid-click.
      if (slotsEl.querySelector('[data-time]')) {
        slotsEl.classList.add('checking');
        slotsEl.setAttribute('aria-busy', 'true');
      } else slotsEl.innerHTML = `<span class="r-schedule-slots-note" aria-busy="true"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_e3f33bfdf56cf1","Checking availability…") ?? "Checking availability…")}</span>`;
      let result;
      try {
        result = await authoritativeAvailability();
      } catch (error) {
        if (generation !== availabilityGeneration || !isCurrentSession()) return;
        slotsEl.classList.remove('checking');
        slotsEl.removeAttribute('aria-busy');
        authoritativeSlots = [];
        slotsEl.innerHTML = `<span class="r-schedule-slots-note">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_f40ba07aaa433a","Availability unavailable") ?? "Availability unavailable")}</span>`;
        if (schedulingUnchanged()) {
          applyOutcome(true, 'The time and crew stay as they are.');
          return;
        }
        statusEl.textContent = error?.message || 'Could not check authoritative availability.';
        statusEl.classList.add('bad');
        overrideWrap?.classList.add('visible');
        saveBtn.disabled = !overrideInput?.checked;
        return;
      }
      if (generation !== availabilityGeneration || !isCurrentSession()) return;
      slotsEl.classList.remove('checking');
      slotsEl.removeAttribute('aria-busy');
      reportedCandidateKinds = new Set((Array.isArray(result?.slots) ? result.slots : [])
        .flatMap((slot) => (Array.isArray(slot?.candidates) ? slot.candidates : []).map((candidate) => resourceKeyKind(String(candidate.resource_key || '').toLowerCase())))
        .filter(Boolean));
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
      if (autoPickDays > 0) {
        const selectedIso = selectedStart().toISOString();
        const chosen = slots.find((slot) => slot.start_at === selectedIso || slot.start === selectedIso);
        if (chosen?.hasAvailability) autoPickDays = 0;
        else {
          const now = Date.now();
          const firstOpen = slots.find((slot) => slot.hasAvailability && slot.time && new Date(slot.start_at || slot.start).getTime() > now);
          if (firstOpen) {
            autoPickDays = 0;
            timeInput.value = firstOpen.time;
            renderAvailability();
            return;
          }
          // Nothing open that day: try the next one.
          autoPickDays -= 1;
          if (autoPickDays > 0) {
            const nextDay = scheduleAddDays(new Date(`${dateInput.value}T00:00:00`), 1);
            if (Number.isFinite(nextDay.getTime())) {
              dateInput.value = Scheduling.localDateInput(nextDay);
              renderAvailability();
              return;
            }
          }
        }
      }
      const current = timeInput.value;
      slotsEl.innerHTML = slots.map((slot) => `
        <button type="button" class="r-schedule-slot ${slot.hasAvailability ? 'available' : 'unavailable'} ${slot.time === current ? 'active' : ''}" data-time="${escapeHtml(slot.time)}" ${slot.hasAvailability ? '' : 'disabled'}>${escapeHtml(slot.label)}</button>
      `).join('');
      slotsEl.querySelectorAll('.r-schedule-slot.available').forEach((btn) => {
        btn.addEventListener('click', () => {
          autoPickDays = 0;
          timeInput.value = btn.dataset.time || timeInput.value;
          renderAvailability();
        });
      });
      const selectedIso = selectedStart().toISOString();
      const selectedSlot = slots.find((slot) => slot.start_at === selectedIso || slot.start === selectedIso);
      const available = slotSupportsSelection(selectedSlot);
      applyOutcome(available, available
        ? `${Number(selectedSlot.available_count || 0)} routed assignment${Number(selectedSlot.available_count || 0) === 1 ? '' : 's'} available for this time.`
        : 'This time is not available under the routed scheduling rules. Choose another time or check “Schedule anyway”.');
    }

    // Anything the user chooses stops the first-open-time search.
    const userChange = (event) => {
      autoPickDays = 0;
      if (event?.type === 'change' && inputsKey() === renderedInputsKey) return;
      renderAvailability();
    };
    [dateInput, timeInput, durationInput, daysInput, usersInput, overrideInput, allDayInput].forEach((input) => {
      if (input) input.oninput = userChange;
      if (input) input.onchange = userChange;
    });
    recurringInput.onchange = () => {
      recurringFields.hidden = !recurringInput.checked;
      renderAvailability();
    };
    endModeInput.onchange = renderRecurrenceEnd;
    if (seriesCancelButton) seriesCancelButton.onclick = async () => {
      if (!recurringSeries?.id) return;
      const confirmed = await (Portal?.ui?.confirm?.((globalThis.PlatformLanguage?.text("project-schedule","m_91303d517f39fa","Cancel this recurring series and its future appointments?") ?? "Cancel this recurring series and its future appointments?"), {
        title:(globalThis.PlatformLanguage?.text("project-schedule","m_6c097c79cef08a","Cancel series") ?? "Cancel series"),
        okLabel:'Cancel series',
        cancelLabel:'Keep series',
        danger:true
      }) ?? Promise.resolve(window.confirm('Cancel this recurring series and its future appointments?')));
      if (!confirmed) return;
      seriesCancelButton.disabled = true;
      try {
        await window.PlatformAPI.projects.cancelRecurrenceSeries(orgId, recurringSeries.id);
        await loadRecurringSeries({ refresh: true });
        closeScheduleDialog();
        await refreshProjectFromServer({ render:false });
        renderSchedulePanel();
        window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
        showToast((globalThis.PlatformLanguage?.text("project-schedule","m_444d3d72c440e4","Recurring series cancelled") ?? "Recurring series cancelled"), (globalThis.PlatformLanguage?.text("project-schedule","m_d673dcfa6aee57","Future appointments and open future charges were cancelled.") ?? "Future appointments and open future charges were cancelled."), true);
      } catch (error) {
        statusEl.textContent = error?.message || 'Could not cancel the recurring series.';
        statusEl.classList.add('bad');
      } finally {
        seriesCancelButton.disabled = false;
      }
    };
    saveBtn.onclick = async () => {
      if (saveBtn.dataset.saving === 'true') return;
      project = ensureSchedulingProject();
      if (!project?.id) {
        statusEl.textContent = 'Save the project details before scheduling it.';
        statusEl.classList.add('bad');
        return;
      }
      const allDay = allDaySelected();
      const { start:rangeStart, end:rangeEnd } = selectedRange();
      if (!Number.isFinite(rangeStart.getTime()) || !Number.isFinite(rangeEnd.getTime())) {
        statusEl.textContent = 'Choose a date first.';
        statusEl.classList.add('bad');
        return;
      }
      const selectedIds = selectedUserIds();
      const selectedSubjects = selectedIds.map((id) => assignableSubjects.find((subject) => subject.id === id)).filter(Boolean);
      // Every selected crew and person is assigned (not only the first).
      const assignment = workAssigneesPayload({}, selectedSubjects.map((subject) => ({ id:subject.id, kind:subject.subject_type || subject.resource_kind || 'organization_user', name:subject.name || subject.email || subject.id })));
      const selectedUnitIds = Array.from(equipmentInput?.selectedOptions || []).map((option) => String(option.value || '')).filter(Boolean);
      const equipmentWindowStart = new Date(equipmentStartInput?.value || rangeStart);
      const equipmentWindowEnd = new Date(equipmentEndInput?.value || rangeEnd);
      if (selectedUnitIds.length && Number.isFinite(equipmentWindowStart.getTime()) && Number.isFinite(equipmentWindowEnd.getTime()) && equipmentWindowEnd <= equipmentWindowStart) {
        statusEl.textContent = (globalThis.PlatformLanguage?.text("project-schedule","m_a7c91be49bc6e0","Equipment must be released after it is assigned.") ?? "Equipment must be released after it is assigned.");
        statusEl.classList.add('bad');
        return;
      }
      // A unit the company won't let be booked then is named before saving
      // (the server would refuse it); one down for service otherwise asks
      // first, as in the global editor.
      if (selectedUnitIds.length && equipmentAvailability.key && equipmentAvailability.key === equipmentAvailabilityKey()) {
        const unitNotes = selectedUnitIds.map((id) => equipmentAvailability.notes.get(id)).filter(Boolean);
        const blockedNotes = unitNotes.filter((note) => note.blocked);
        if (blockedNotes.length) {
          statusEl.textContent = `${blockedNotes.map((note) => note.reason).join(' ')} ${blockedNotes.length === 1 ? 'Remove it' : 'Remove them'} or choose another time.`;
          statusEl.classList.add('bad');
          return;
        }
        const downNotes = unitNotes.filter((note) => note.down);
        if (downNotes.length) {
          saveBtn.dataset.saving = 'true';
          const assignAnyway = await scheduleConfirmUi(`${downNotes.map((note) => note.reason).join(' ')} Are you sure you want to assign this equipment to the event?`, { title:'Equipment down for service', okLabel:'Assign anyway', cancelLabel:'Keep editing' });
          delete saveBtn.dataset.saving;
          if (!assignAnyway || !scheduleDialogOpen() || !isCurrentSession()) return;
        }
      }
      const equipmentRefs = selectedUnitIds.map((id) => {
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
      const title = String(itemTitleInput.value || '').trim() || (editEvent ? scheduleEventDisplayTitle(editEvent) : typeLabel);
      const timing = allDay
        ? { start:rangeStart, end:rangeEnd, all_day:true, schedule_granularity:'date', start_date:scheduleLocalDate(rangeStart), end_date:scheduleLocalDate(scheduleAddDays(rangeEnd, -1)) }
        : { start:rangeStart, end:rangeEnd, all_day:false, schedule_granularity:'time', start_date:'', end_date:'' };
      const crewRefs = (assignment.resource_refs || []).filter((ref) => !EQUIPMENT_REF_KINDS.includes(workRefKind(ref.kind)));
      const resourceRefs = [...crewRefs, ...equipmentRefs];
      const event = editEvent
        ? {
            ...Scheduling.updateProjectEventRange(editEvent, timing),
            ...assignment,
            title,
            start_date:timing.start_date,
            end_date:timing.end_date,
            status:materialEventIsScheduled(editEvent) ? (editEvent.status || 'scheduled') : 'scheduled',
            resource_refs:resourceRefs,
            resource_requirements:resourceRequirements,
            availability_override:!!overrideInput?.checked,
            schedule_history:[...(Array.isArray(editEvent.schedule_history) ? editEvent.schedule_history : []), scheduleHistoryEntry(editEvent, 'edited')].filter(Boolean),
            updated_at:new Date().toISOString()
          }
        : Scheduling.createProjectEvent(project, eventTypeId, {
            ...timing,
            durationMinutes: Math.max(1, Math.round((rangeEnd - rangeStart) / 60000)),
            ...assignment,
            title,
            availability_override: !!overrideInput?.checked,
            resource_refs:resourceRefs,
            resource_requirements:resourceRequirements,
          }, config);
      // A day that has already passed is allowed (catching up records) but
      // never silent — asked when the item is new or its date changed.
      const originalStart = recurringSeries?.start_at ? new Date(recurringSeries.start_at) : (editEvent && materialEventIsScheduled(editEvent) ? Scheduling.eventStart?.(editEvent) : null);
      const dateChanged = !originalStart || !Number.isFinite(originalStart.getTime()) || scheduleLocalDate(originalStart) !== scheduleLocalDate(rangeStart);
      if (dateChanged && scheduleIsPastDay(rangeStart)) {
        saveBtn.dataset.saving = 'true';
        const placeInPast = await confirmPastPlacement({ ...event, title }, rangeStart);
        delete saveBtn.dataset.saving;
        if (!placeInPast || !scheduleDialogOpen() || !isCurrentSession()) return;
      }
      saveBtn.dataset.saving = 'true';
      saveBtn.disabled = true;
      saveBtn.setAttribute('aria-busy', 'true');
      const idleLabel = saveBtn.textContent;
      saveBtn.textContent = 'Saving…';
      let related = null;
      let mergedSave = false;
      let createdOccurrenceCount = null;
      try {
        if (!recurringInput.checked && !recurringSeries && !overrideInput?.checked && !allDay && !schedulingUnchanged()) {
          const latest = await authoritativeAvailability();
          const selectedIso = selectedStart().toISOString();
          const slot = (Array.isArray(latest?.slots) ? latest.slots : []).find((entry) => entry.start_at === selectedIso && slotSupportsSelection(entry));
          if (!slot) throw new Error('That time is no longer available under the routed scheduling rules. Choose another time or explicitly schedule anyway.');
        }
        if (editEvent && scheduleRangeMoved(editEvent, event)) {
          related = await resolveProjectRelatedReschedule(editEvent, { start:event.start_at, end:event.end_at });
          if (related.cancelled) return;
        }
        if (recurringInput.checked || recurringSeries) {
          const billingAmount = Math.max(0, Math.round(Number(billingAmountInput.value || 0) * 100));
          const expenseAmount = Math.max(0, Math.round(Number(expenseAmountInput.value || 0) * 100));
          const payload = {
            title: title || (globalThis.PlatformLanguage?.text("project-schedule","m_e5d043f205f6a6","Recurring item") ?? "Recurring item"),
            start_at: selectedStart().toISOString(),
            recurrence: {
              frequency: frequencyInput.value || 'monthly',
              interval: Math.max(1, Number(intervalInput.value || 1)),
              end_at: endModeInput.value === 'date' && endDateInput.value ? new Date(`${endDateInput.value}T23:59:59`).toISOString() : '',
              occurrence_count: endModeInput.value === 'count' ? Math.max(1, Math.min(240, Math.round(Number(countInput.value || 1)))) : null
            },
            event_template: { ...event, id: undefined, title: title || (globalThis.PlatformLanguage?.text("project-schedule","m_e5d043f205f6a6","Recurring item") ?? "Recurring item") },
            billing: { enabled: billingAmount > 0, amount_cents: billingAmount, frequency: billingFrequencyInput.value || frequencyInput.value || 'monthly', label: title || (globalThis.PlatformLanguage?.text("project-schedule","m_e5d043f205f6a6","Recurring item") ?? "Recurring item") },
            expenses: { enabled: expenseAmount > 0, amount_cents: expenseAmount, kind: 'recurring_expense' }
          };
          if (!window.PlatformAPI?.projects?.createRecurrenceSeries) throw new Error('Recurring scheduling is not available.');
          scheduleMutationSerial += 1;
          if (recurringSeries?.id) await window.PlatformAPI.projects.updateRecurrenceSeries(orgId, recurringSeries.id, payload);
          else {
            const created = await window.PlatformAPI.projects.createRecurrenceSeries(orgId, { ...payload, project_id: project.id });
            createdOccurrenceCount = Array.isArray(created?.occurrences) ? created.occurrences.length : null;
          }
          scheduleMutationSerial += 1;
          scheduleRecurringSeries = [];
          await loadRecurringSeries({ refresh: true });
        } else {
          const saved = await saveScheduleEventRemote(orgId, project, event, config);
          mergedSave = !!saved.merged;
          activeBaseProject = { ...activeBaseProject, ...saved.project, events: saved.project?.events || [] };
          if (editEvent) {
            await saveRelatedRescheduleChanges(related);
            await persistGroupRollups([event, ...(related?.changes || [])]);
          }
        }
        const wasRecurring = recurringInput.checked || !!recurringSeries;
        if (wasRecurring) await refreshProjectFromServer({ render:false });
        cacheActiveBaseProject();
        rememberScheduleProject(activeBaseProject);
        closeScheduleDialog();
        const eventStart = selectedStart();
        if (Number.isFinite(eventStart.getTime()) && !scheduleDateVisible(eventStart)) scheduleAnchorDate = eventStart;
        renderSchedulePanelPreservingScroll();
        window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
        window.dispatchEvent(new CustomEvent('fm:projects:refresh'));
        // A new series says what it scheduled; an edited one that its
        // future occurrences follow.
        const newSeries = wasRecurring && !recurringSeries;
        const newSeriesBody = createdOccurrenceCount > 0
          ? `${createdOccurrenceCount} occurrence${createdOccurrenceCount === 1 ? '' : 's'} scheduled.`
          : `${title || 'The recurring item'} was added to the project.`;
        showToast(
          wasRecurring ? (newSeries ? 'Recurring item added' : 'Recurring item saved') : (editEvent ? `${typeLabel} updated` : (eventTypeId === 'project_work' ? 'Production scheduled' : 'Appointment scheduled')),
          wasRecurring ? (newSeries ? newSeriesBody : 'Its future occurrences were updated.') : `${event.title} ${editEvent ? 'was saved' : 'was added to the project'}.${relatedMoveNote(related)}${mergedSave ? ' Changes someone else made to this item meanwhile were kept.' : ''}`,
          true
        );
      } catch (error) {
        if (isStaleSaveError(error)) {
          // Someone else changed the same thing meanwhile. The dialog stays
          // open with this user's edits; the next Save builds on the stored
          // copy (deleted items close it).
          const latest = editEvent && !scheduleStaleErrorDeleted(error)
            ? (scheduleProjectEvents().find((item) => String(item.id || '') === String(editEvent.id || '')) || error?.currentEvent || error?.data?.details?.current_event || null)
            : null;
          if (!latest || !scheduleDialogOpen() || !isCurrentSession()) {
            closeScheduleDialog();
            handleStaleScheduleSave(error);
            return;
          }
          editEvent = latest;
          showStaleScheduleToast(error, 'Your edits are still in the dialog. Review them and save again.');
          statusEl.textContent = `Someone else changed this item meanwhile (it is now “${scheduleEventDisplayTitle(latest)}”, ${materialEventIsScheduled(latest) ? workRangeLabel(latest) : 'not scheduled'}). Your edits are kept here — review them and save again.`;
          statusEl.classList.add('bad');
          if (state.active) renderSchedulePanelPreservingScroll();
          return;
        }
        // Refused equipment: name each unit and what holds it, and show the
        // picker's current availability.
        const equipmentConflicts = Array.isArray(error?.data?.details?.conflicts) ? error.data.details.conflicts : [];
        if (equipmentConflicts.length) {
          const conflictText = equipmentConflictSaveText(equipmentConflicts);
          statusEl.textContent = `${conflictText} Remove the equipment or choose another time.`;
          statusEl.classList.add('bad');
          showToast('Equipment conflict', conflictText, false);
          equipmentAvailability = { key:'', notes:new Map() };
          void renderEquipmentAvailability();
          return;
        }
        statusEl.textContent = error?.message || 'Could not save the appointment.';
        statusEl.classList.add('bad');
      } finally {
        delete saveBtn.dataset.saving;
        saveBtn.removeAttribute('aria-busy');
        if (saveBtn.textContent === 'Saving…') saveBtn.textContent = idleLabel;
        if (scheduleDialogOpen()) saveBtn.disabled = false;
      }
    };

    originalSchedulingKey = schedulingKey();
    renderAvailability();
    // Keyboard users start in the first field.
    setTimeout(() => { if (scheduleDialogOpen() && !dialog.contains(document.activeElement)) itemTitleInput.focus({ preventScroll:true }); }, 0);
  }


  function mount(context = {}){
    injectProjectScheduleCss();
    state.context = context;
    state.host = hostFor(context);
    state.model = modelFromContext(context);
    state.panelRoot = resolveRoot(context);
    state.sidebarRoot = context.sidebarRoot || context.roots?.sidebar || state.sidebarRoot;
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
    // A retained window or cached project may be behind the server; re-read
    // its items (re-rendering only when something changed).
    if (Date.now() - scheduleLastServerRefreshAt > 15000) refreshProjectFromServer({ render:true });
  }

  function deactivate(context = {}){
    if (context && Object.keys(context).length) {
      state.context = { ...(state.context || {}), ...context };
      state.host = hostFor(state.context);
      state.sidebarRoot = context.sidebarRoot || context.roots?.sidebar || state.sidebarRoot;
    }
    setActive(false);
  }

  function setActive(active){
    state.active = !!active;
    setScheduleWorkspaceChrome(state.active);
    if (state.active) {
      renderSchedulePanel();
      if (Date.now() - scheduleLastServerRefreshAt > 15000) refreshProjectFromServer({ render:true });
    } else {
      closeWorkAssignmentMenu();
      closeScheduleEventPopover();
      clearScheduleLeft();
    }
  }

  function reset(){
    closeWorkAssignmentMenu();
    closeScheduleEventPopover();
    closeScheduleDialog();
    scheduleDataLoadedAt = 0;
    clearProjectMobileControls();
    scheduleModeActive = false;
    scheduleCalendarGen = 0;
    scheduleAnchorDate = new Date();
    scheduleViewMode = 'month';
    // Each project opens its timeline fitted to its own work.
    projectGanttZoom = 0;
    projectGanttCollapsedGroups = [];
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
    scheduleWorkResourceDataLoaded = false;
    scheduleResourcesSettled = false;
    scheduleWorkforceTerminology = {};
    scheduleWorkforceTerminologyLoaded = false;
    scheduleWorkforceLoaded = false;
    scheduleServerEvents.clear();
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

  // Escape closes the topmost schedule layer (menu, popover) before the portal
  // modal stack's document-capture handler closes the whole project window.
  // Registered dialogs are closed by that modal stack; open pickers are closed
  // first by the project host.
  function handleScheduleEscape(event){
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (document.querySelector('fm-date-time-picker[popover]')) return;
    if (scheduleDialogOpen() || document.querySelector('.r-gantt-group-backdrop')) return;
    let handled = false;
    if (document.querySelector('.r-schedule-crew-popover')) {
      closeWorkAssignmentMenu();
      handled = true;
    } else if (document.querySelector('.r-schedule-event-popover')) {
      const popoverItemId = scheduleEventPopoverId;
      closeScheduleEventPopover();
      // Keyboard focus goes back to the item the popover belongs to.
      focusScheduleItem(popoverItemId, scheduleEventPopoverAnchor);
      handled = true;
    } else if (state.active && (projectMobileViewMenuOpen || projectMobileMonthMenuOpen)) {
      projectMobileViewMenuOpen = false;
      projectMobileMonthMenuOpen = false;
      renderSchedulePanel();
      handled = true;
    } else if (state.active && !document.querySelector('.fm-dialog-backdrop') && schedulePlacementActive()) {
      // Placing something: Escape cancels the placement, not the window.
      cancelSchedulePlacement();
      handled = true;
    }
    if (!handled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  window.addEventListener('keydown', handleScheduleEscape, true);

  // After a tap, the browser's compatibility mouse events land on whatever
  // control the tap re-rendered into place (e.g. the next "Next" button) and
  // open its hover tooltip, which then never closes without a mouse.
  // Schedule controls show no hover tooltips right after a touch.
  let scheduleLastTouchAt = 0;
  document.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') scheduleLastTouchAt = Date.now();
  }, true);
  document.addEventListener('mouseover', (event) => {
    if (Date.now() - scheduleLastTouchAt > 1500) return;
    if (!event.target?.closest?.('#rSchedulePanel, .r-schedule-left-shell, .r-schedule-event-popover, .r-schedule-crew-popover')) return;
    event.stopPropagation();
    window.PlatformUI?.hideTooltip?.();
  }, true);

  // Changes saved on another surface (the portal's Scheduling tab or another
  // project window) arrive as a relayed refresh; re-read this project's items.
  const refreshFromOtherSurface = () => {
    scheduleDataLoadedAt = 0;
    if (!state.mounted || !activeBaseProject?.id) return;
    refreshProjectFromServer({ render:state.active });
  };
  window.addEventListener('fm:project-schedule:external', refreshFromOtherSurface);
  // Not every surface announces its saves, so returning to this window
  // re-reads the project's items (re-rendering only when they changed).
  window.addEventListener('focus', () => {
    if (!state.active || !activeBaseProject?.id || Date.now() - scheduleLastServerRefreshAt < 4000) return;
    if (scheduleDialogOpen() || document.querySelector('.r-schedule-event-popover,.r-schedule-crew-popover')) return;
    refreshProjectFromServer({ render:true });
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
