/* public/libraries/apps/scheduling/app.js
 * Dashboard tab: calendar plus branch-configurable appointment groups.
 */
(function(){
  if (!window.Portal) return;

  const cfg = window.Portal.cfg || {};
  const { injectCSS, escapeHtml } = window.Portal.util;
  const { showToast } = window.Portal.ui;
  const SHOW_CALENDAR_STATS = false;
  const SHOW_CALENDAR_STAT_SUMMARIES = false;
  const ENABLE_CALENDAR_DISPLAY_SWITCH = false;

  let rootEl = null;
  let viewMode = 'week';
  let anchorDate = new Date();
  // "scope:YYYY-MM-DD" -> unassigned count from the last auto-route run, so
  // the pane can flag an overbooked day until a later run clears it.
  const routingOverbooked = {};
  let activeDayModal = null;
  let activeCrewSettingsModal = null;
  let pendingRouteDay = '';
  let loading = false;
  let schedulingConfig = null;
  let dashboardConfig = null;
  let branchProjectConfig = { title_mode:'customer_name' };
  let users = [];
  let projects = [];
  let events = [];
  let allEvents = [];
  let floatingEvents = [];
  let collapsedGroups = {};
  let breakdownMode = 'user';
  let breakdownValue = 'all';
  let scheduleMode = 'sales';
  let showSalesSchedule = true;
  let showProductionSchedule = true;
  let showOtherSchedule = true;
  let showMaterialSchedule = true;
  let calendarDisplayMode = 'events';
  let mobileViewMenuOpen = false;
  let mobileMonthMenuOpen = false;
  let mobilePickerYear = new Date().getFullYear();
  let mobilePickerMonth = new Date().getMonth();
  let mobileTrayOpen = false;
  let mobileTrayClosing = false;
  let mobileTrayCloseTimer = null;
  let mobileScheduleMenuOpen = false;
  let mobileCalendarSwipeDirection = '';
  let mobileCalendarSwipeTimer = null;
  let mobileLayout = null;
  let filterMenuOpen = false;
  let modeMenuOpen = false;
  let appointmentScheduleDraft = null;
  let appointmentScheduleProjectId = '';
  let appointmentScheduleEventId = '';
  let appointmentScheduleMenuEventId = '';
  let appointmentScheduleLiveTravel = true;
  let appointmentScheduleLockTime = true;
  let appointmentScheduleScrollLeft = null;
  let appointmentScheduleScrollTop = null;
  let salesRoutingScale = 'hourly';
  let productionRoutingScale = 'daily';
  let productionVehiclesVisible = false;
  let vehiclePlacementUnitId = '';
  let vehiclePlacementDraft = null;
  let productionLiveTravel = false;
  let ganttZoomPxPerDay = 0;
  let ganttGroupBy = 'project';
  let ganttCollapsedGroups = [];
  let ganttVisibleKinds = new Set(['labor', 'equipment', 'deliveries', 'sales', 'other']);
  let ganttShownMenuOpen = false;
  let ganttShownDocHandler = null;
  let ganttZoomPersistTimer = null;
  let schedulePrefsApplied = false;
  let routeSpecifiedView = false;
  let defaultViewApplied = false;
  let mobileRoutingPane = 'sales';
  let scheduleScrollPositions = {};
  let scheduleScrollResetPending = false;
  let productionScheduleDraft = null;
  let productionScheduleBundleKey = '';
  let productionScheduleBundleDrafts = [];
  const expandedProductionBundles = new Set();
  const placementUndoStack = [];
  const placementRedoStack = [];
  let placementHistoryApplying = false;
  let productionScheduleProjectId = '';
  let productionScheduleEventId = '';
  let materialScheduleDraft = null;
  let materialScheduleProjectId = '';
  let materialScheduleEventId = '';
  let focusedScheduleEventId = '';
  let pendingScheduleFocus = null;
  let assignmentMenuEventId = '';
  let assignmentMenuDocHandler = null;
  let expandedMonthDates = [];
  let eventDraftPopoverId = '';
  let eventEditorEventId = '';
  let eventDraftProjectQuery = '';
  let eventDraftDocHandler = null;
  let eventDraftKeyHandler = null;
  let eventDraftProjectUndo = null;
  let eventCustomerDetailsOpen = false;
  let eventAdvancedOpen = false;
  let workforceResources = [];
  let equipmentUnits = [];
  let equipmentTypes = [];
  let workforceTerminology = {};
  let workforceGroupKinds = [];
  let scopeTemplates = [];
  let loadQueued = false;
  let loadTimer = null;
  let lastLoadFailedAt = 0;
  const eventRangeSaveVersions = new Map();
  const eventRangeSaveQueues = new Map();

  function bindOutsidePointerDismiss(surface, onDismiss, insideNodes = []){
    let pointerStartedOutside = false;
    const isInside = (target) => !!target && (surface.contains(target) || target.closest?.('.fm-dialog-backdrop') || insideNodes.some((node) => node?.contains?.(target)));
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

  const css = `
    .dash-shell{height:100%;min-height:0;display:flex;flex-direction:column;background:#eef2f6;color:#101828}
    .dash-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;border-bottom:1px solid rgba(15,23,42,.08);background:#f8fafc}
    .dash-title{margin:0;font-size:22px;font-weight:1000;color:#101828}
    .dash-sub{margin:3px 0 0;font-size:12px;font-weight:800;color:#667085}
    .dash-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .dash-btn{height:36px;border:1px solid rgba(15,23,42,.12);border-radius:11px;background:#fff;color:#344054;padding:0 12px;font-weight:950;display:inline-flex;align-items:center;gap:7px;cursor:pointer}
    .dash-btn:hover{border-color:rgba(15,23,42,.24);background:#f8fafc}
    .dash-btn.active{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
    .dash-btn.segment{height:32px;border-radius:10px;padding:0 10px;font-size:12px}
    .dash-control-group{display:inline-flex;align-items:center;gap:3px;border:1px solid rgba(15,23,42,.10);background:#fff;border-radius:12px;padding:3px}
    .dash-control-label{font-size:10px;font-weight:1000;text-transform:uppercase;color:#667085;padding:0 7px}
    .dash-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 266px;gap:16px;padding:14px 18px 18px;overflow:hidden}
    .dash-body.schedule-mode{grid-template-columns:minmax(0,1fr) 320px}
    .dash-left,.dash-right{min-height:0;overflow:auto}
    .dash-body.schedule-mode .dash-right{overflow:hidden}
    .dash-body.schedule-mode .dash-right>.dash-groups{height:100%;min-height:0}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-rail-title{flex:0 0 auto}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-group{display:flex;flex:1 1 0;min-height:0;flex-direction:column}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-group.empty{flex:0 0 auto}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-group.empty>.dash-group-body{display:none}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-group>.dash-group-head{flex:0 0 auto}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-group>.dash-group-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
    .dash-body.events-mode .dash-left{display:flex;flex-direction:column;overflow:hidden}
    .dash-body.events-mode .dash-stats-row{flex:0 0 auto}
    .dash-body.schedule-mode .dash-left{display:flex;flex-direction:column;overflow:hidden}
    .dash-body.schedule-mode .dash-stats-row{flex:0 0 auto}
    .dash-stats-row{--dash-mode-col:50px;--dash-filter-col:170px;--dash-stat-gap:8px;--dash-stat-count:5;--dash-filter-cols:6;display:grid;grid-template-columns:var(--dash-mode-col) minmax(126px,var(--dash-filter-col)) repeat(var(--dash-stat-count),minmax(92px,1fr));gap:var(--dash-stat-gap);margin-bottom:12px;align-items:stretch;position:relative}
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
    .dash-filter-row{display:grid;grid-template-columns:repeat(var(--dash-filter-cols),minmax(0,1fr));gap:var(--dash-stat-gap);align-items:center;padding:9px 0;border-radius:11px;border:0;background:transparent;color:#344054;text-align:left;font:inherit;cursor:pointer}
    .dash-filter-row.header{cursor:default;color:#667085;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em}
    .dash-filter-row:not(.header):hover{background:#f8fafc}
    .dash-filter-row.active{background:rgba(var(--primary-rgb),.08);color:var(--primary-readable,var(--primary,#d93025))}
    .dash-filter-statcell{min-width:0;display:flex;align-items:center;justify-content:center;gap:8px;padding:0 12px}
    .dash-filter-statcell:first-child{justify-content:flex-start}
    .dash-filter-name{font-weight:1000;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dash-filter-name i{width:16px;text-align:center;margin-right:8px;color:var(--primary-readable,var(--primary,#d93025));flex-shrink:0}
    .dash-filter-cell{font-size:12px;font-weight:950;text-align:center;white-space:nowrap;margin:0 auto}
    .dash-stats{display:contents}
    .dash-stat{border:1px solid rgba(15,23,42,.08);border-radius:14px;background:#fff;padding:9px 10px;display:flex;align-items:center;gap:9px;min-width:0;height:58px;box-sizing:border-box}
    .dash-stat i{width:28px;height:28px;border-radius:10px;background:rgba(var(--primary-rgb),.09);color:var(--primary-readable,var(--primary,#d93025));display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0}
    .dash-stat>div{min-width:0}
    .dash-stat small{display:block;font-size:10px;font-weight:1000;color:#667085;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dash-stat strong{display:block;font-size:16px;font-weight:1000;color:#101828;line-height:1.1;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dash-card{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:18px;overflow:hidden}
    .dash-schedule-card{flex:1;min-height:0;box-sizing:border-box;display:flex;flex-direction:column;background:transparent;border:0;border-radius:0;overflow:hidden}
    .dash-schedule-view{flex:1;min-height:0;min-width:0;overflow:hidden}
    .dash-schedule-split{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;justify-content:flex-start;gap:8px;overflow:hidden}
    .dash-schedule-pane{min-height:0;min-width:0;display:flex;flex:0 1 auto;flex-direction:column;overflow:hidden}
    .dash-schedule-pane-title{flex:0 0 auto;min-height:30px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;font-size:11px;font-weight:1000;text-transform:uppercase;letter-spacing:.06em;color:#667085;padding:0 0 6px}
    .dash-schedule-pane-heading{display:flex;align-items:baseline;gap:8px;min-width:0}
    .dash-routing-date{color:#101828;font-size:12px;font-weight:1000;letter-spacing:0;text-transform:none;white-space:nowrap}
    .dash-routing-scale{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid rgba(15,23,42,.10);border-radius:9px;background:#fff;text-transform:none;letter-spacing:0}
    .dash-routing-pane-controls{display:inline-flex;align-items:center;gap:8px}
    .dash-routing-flag{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;font-size:10px;font-weight:1000;letter-spacing:.02em;text-transform:uppercase;white-space:nowrap}
    .dash-routing-flag.conflict{background:#fee2e2;color:#b42318;border:1px solid #fca5a5}
    .dash-routing-flag.overbooked{background:#fef3c7;color:#92400e;border:1px solid #fcd34d}
    .dash-routing-travel{height:26px;border:1px solid rgba(15,23,42,.10);border-radius:9px;background:#fff;color:#667085;padding:0 9px;display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:10px;font-weight:1000;text-transform:none;letter-spacing:0;cursor:pointer}
    .dash-routing-travel:hover{background:#f8fafc}
    .dash-routing-travel.active{border-color:rgba(var(--primary-rgb,217,48,37),.35);background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025))}
    .dash-gantt-view{display:flex;flex-direction:column;min-height:0}
    .dash-gantt-view .psv-gantt-wrap{flex:1;min-height:0}
    .dash-routing-scale button{height:24px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:#667085;font:inherit;font-size:10px;cursor:pointer}
    .dash-routing-scale button.active{background:var(--primary,#d93025);color:var(--on-primary,#fff)}
    .dash-schedule-view .psv-wrap,.dash-schedule-view .prs-wrap{min-height:0;min-width:0}
    .dash-schedule-view .psv-grid,.dash-schedule-view .prs-resource-grid,.dash-schedule-view .prs-resource-time-grid{min-height:0}
    .dash-schedule-view .psv-surface,.dash-schedule-view .prs-resource-scroll{min-width:0}
    .dash-schedule-view .prs-work-chip.focused{box-shadow:0 0 0 3px rgba(var(--primary-rgb),.24),0 12px 26px rgba(15,23,42,.18);z-index:30}
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
    .dash-month.no-stats{grid-template-columns:repeat(7,minmax(78px,1fr))}
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
    .dash-day-events{display:grid;gap:4px;min-width:0}
    .dash-month-event{height:22px;border-radius:7px;background:#e0ecff;color:#1e3a8a;border-left:3px solid #2563eb;padding:3px 6px;font-size:10px;font-weight:950;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box}
    .dash-month-more{font-size:10px;font-weight:1000;color:var(--primary-readable,var(--primary,#d93025));padding:1px 2px}
    .dash-day-list{display:grid;gap:10px}
    .dash-list-event{border:1px solid rgba(15,23,42,.08);border-radius:16px;background:#fff;padding:14px;display:grid;grid-template-columns:96px 1fr auto;gap:14px;align-items:center;cursor:pointer}
    .dash-list-time{font-size:12px;font-weight:1000;color:#1d4ed8}
    .dash-list-title{font-size:14px;font-weight:1000;color:#101828}
    .dash-list-meta{font-size:12px;font-weight:800;color:#667085;margin-top:2px}
    .dash-empty{border:1px dashed rgba(15,23,42,.18);border-radius:18px;background:#fff;padding:24px;text-align:center;color:#667085;font-weight:850}
    .dash-groups{display:flex;flex-direction:column;gap:12px}
    .dash-rail-title{font-size:12px;font-weight:1000;text-transform:uppercase;letter-spacing:.06em;color:#667085;padding:2px 4px 0}
    .dash-group{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:16px;overflow:hidden}
    .dash-group-head{width:100%;border:0;background:#fff;padding:13px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;color:#101828}
    .dash-group-head strong{font-size:13px;font-weight:1000}
    .dash-group-head span{font-size:11px;font-weight:1000;color:#667085}
    .dash-group-body{padding:0 14px 12px;display:grid;gap:8px;align-content:start}
    .dash-group.collapsed .dash-group-body{display:none}
    .dash-appt-tile{border:0;background:transparent;width:100%;padding:11px 0;border-top:1px solid rgba(15,23,42,.07);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 12px;text-align:left;cursor:pointer;align-items:center}
    .dash-appt-tile.selected{position:relative;color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb),.07);border-radius:12px;padding-left:10px;padding-right:10px}
    .dash-appt-tile.selected:before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:999px;background:var(--primary,#d93025)}
    .dash-appt-tile.selected .dash-appt-title{color:var(--primary-readable,var(--primary,#d93025))}
    .dash-appt-tile.selected .dash-appt-sales,.dash-appt-tile.selected .dash-appt-address{color:#344054}
    .dash-appt-tile.selected .dash-stage-pill{background:rgba(var(--primary-rgb),.14);color:var(--primary-readable,var(--primary,#d93025))}
    .dash-appt-tile.unscheduled{border-top-style:dashed;background:linear-gradient(90deg,rgba(15,23,42,.022),transparent 70%)}
    .dash-appt-tile.unscheduled .dash-appt-title{font-style:italic}
    .dash-appt-tile.unscheduled .dash-stage-pill{background:#f2f4f7;color:#667085;border:1px dashed #98a2b3}
    .dash-appt-tile.missing-address{background:#fff8e8;border-color:#f5c76d}
    .dash-appt-tile.missing-address.selected{background:#fff3d6}
    .dash-missing-address-label{display:inline-flex;align-items:center;gap:4px;width:max-content;max-width:100%;padding:2px 6px;border:1px solid #eaaa35;border-radius:999px;background:#fff1c2;color:#8a4b08;font-size:10px;font-weight:900;font-style:normal;line-height:1.25}
    .dash-appt-tile.has-action{grid-template-columns:minmax(0,1fr) auto 26px;gap:4px 10px;padding:8px 0}
    .dash-appt-tile.has-action.selected{padding-left:10px;padding-right:10px}
    .dash-appt-tile.has-action .dash-appt-sales{grid-column:2/3;justify-self:end;text-align:right;max-width:92px}
    .dash-appt-tile.has-action .dash-appt-address{grid-column:1/3}
    .dash-appt-tile.project-only{grid-template-columns:minmax(0,1fr) auto}
    .dash-appt-tile.material{position:relative;padding-left:10px;border-left:4px solid #f97316}
    .dash-appt-tile.material.unordered{border-left-style:dashed;background:#fffaf5}
    .dash-appt-tile.material.ordered{background:#f0fdf4}
    .dash-appt-tile.unconfirmed{position:relative;padding-left:10px;border-left:3px dashed #f59e0b}
    .dash-appt-tile.confirmation-declined{position:relative;padding-left:10px;border-left:3px dashed #dc2626}
    .dash-appt-confirm-marker{margin-right:5px;font-size:9.5px;color:#b45309}
    .dash-appt-confirm-marker.bad{color:#b42318}
    .dash-event-status-pill.confirm-warn{background:#fef3c7;color:#b45309}
    .dash-event-status-pill.confirm-good{background:#dcfce7;color:#15803d}
    .dash-event-status-pill.confirm-bad{background:#fee4e2;color:#b42318}
    .dash-event-confirm-panel{display:grid;gap:9px;padding:11px;border:1px solid rgba(15,23,42,.10);border-radius:11px;background:#f8fafc}
    .dash-event-confirm-status{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:950;line-height:1.35}
    .dash-event-confirm-status.warn{color:#b45309}
    .dash-event-confirm-status.good{color:#15803d}
    .dash-event-confirm-status.bad{color:#b42318}
    .dash-event-confirm-options{display:none;gap:9px;padding-top:9px;border-top:1px solid rgba(15,23,42,.08)}
    .dash-event-confirm-options.open{display:grid}
    .dash-event-confirm-channels{display:flex;flex-wrap:wrap;gap:10px}
    .dash-event-confirm-detail{display:flex;flex-wrap:wrap;gap:9px}
    .dash-event-confirm-field{display:grid;gap:4px;color:#667085;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}
    .dash-event-confirm-field select,.dash-event-confirm-field input{height:32px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#344054;padding:0 8px;font-size:11.5px;font-weight:900;text-transform:none;letter-spacing:0}
    .dash-reschedule-review{display:grid;gap:9px;padding:11px;border:1px solid #f5c26b;border-radius:10px;background:#fffbeb;color:#7a4b06}.dash-reschedule-review>div:first-child{display:grid;gap:3px}.dash-reschedule-review strong{font-size:12px}.dash-reschedule-review small{font-size:10.5px;line-height:1.45}.dash-reschedule-review>div:last-child{display:flex;justify-content:flex-end;gap:7px}.dash-reschedule-review button{border:1px solid #d9b36c;border-radius:8px;background:#fff;color:#7a4b06;padding:7px 10px;font:900 10px/1 inherit;cursor:pointer}.dash-reschedule-review button.approve{border-color:#1f8a57;background:#1f8a57;color:#fff}.dash-reschedule-review button:disabled{opacity:.55;cursor:wait}
    .dash-schedule-pile{border-top:1px dashed rgba(15,23,42,.18);padding:0 0 8px}
    .dash-schedule-pile>.dash-appt-tile{border-top:0}
    .dash-schedule-pile.selected{margin:4px -6px 0;padding:0 6px 8px;border-radius:12px;background:rgba(var(--primary-rgb),.055)}
    .dash-bundle-items{display:grid;gap:3px;margin:-3px 8px 0 16px;padding-left:10px;border-left:2px solid rgba(15,23,42,.10)}
    .dash-bundle-summary{width:calc(100% - 24px);height:28px;margin:-3px 8px 2px 16px;padding:0 7px;border:0;border-radius:8px;background:transparent;color:#667085;display:flex;align-items:center;gap:7px;text-align:left;font-size:11px;font-weight:950;cursor:pointer}
    .dash-bundle-summary:hover{background:#f8fafc;color:#344054}.dash-bundle-summary i{width:12px;text-align:center}
    .dash-bundle-item{height:27px;border:0;border-radius:8px;background:transparent;color:#475467;padding:0 7px;display:flex;align-items:center;gap:7px;text-align:left;font-size:11px;font-weight:900;cursor:pointer;min-width:0}
    .dash-bundle-item:hover,.dash-bundle-item.selected{background:rgba(var(--primary-rgb),.08);color:var(--primary-readable,var(--primary,#d93025))}
    .dash-bundle-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dash-bundle-item .dash-bundle-child-cancel{margin-left:auto;width:20px;height:20px;flex:0 0 20px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;background:rgba(15,23,42,.07);color:#667085}
    .dash-bundle-cancel{width:22px;height:22px;border:0;border-radius:7px;background:rgba(15,23,42,.06);color:#667085;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
    .dash-appt-title{font-size:13px;font-weight:1000;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dash-appt-kind{font-style:italic;font-weight:800;color:#667085}
    .dash-appt-sales{font-size:11px;font-weight:950;color:#475467;white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis}
    .dash-appt-address{font-size:12px;font-weight:850;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dash-stage-pill{justify-self:end;border-radius:999px;background:rgba(var(--primary-rgb),.09);color:var(--primary-readable,var(--primary,#d93025));font-size:10px;font-weight:1000;padding:4px 8px;white-space:nowrap}
    .dash-appt-actions{grid-row:1/3;grid-column:3/4;justify-self:end;align-self:center;display:flex;flex-direction:column;gap:4px}
    .dash-appt-action{width:23px;height:23px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#667085;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:10px}
    .dash-appt-action:hover{background:#f8fafc;border-color:rgba(15,23,42,.22);color:#344054}
    .dash-assignee-popover{position:fixed;z-index:2600;width:220px;overflow-y:auto;overscroll-behavior:contain;background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:14px;box-shadow:0 22px 60px rgba(15,23,42,.20);padding:6px;box-sizing:border-box}
    .dash-assignee-option{width:100%;height:36px;border:0;border-radius:10px;background:transparent;color:#344054;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 9px;font-size:12px;font-weight:950;cursor:pointer;text-align:left}
    .dash-assignee-option:hover{background:#f8fafc}
    .dash-assignee-option.active{background:rgba(var(--primary-rgb),.09);color:var(--primary-readable,var(--primary,#d93025))}
    .dash-assignee-option.warn i{color:#f59e0b}
    .dash-assignee-option span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dash-event-popover{position:fixed;z-index:2600;width:420px;height:620px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:16px;box-shadow:0 22px 60px rgba(15,23,42,.20);padding:16px;display:flex;flex-direction:column;gap:12px}.dash-event-popover>*{flex-shrink:0}
    .dash-event-title-input{width:100%;height:34px;border:1px solid rgba(15,23,42,.12);border-radius:10px;padding:0 9px;font-size:14px;font-weight:1000;color:#101828;outline:none;box-sizing:border-box}
    .dash-event-title-input:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb),.10)}
    .dash-event-time-options{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:8px}
    .dash-event-switch{display:inline-flex;align-items:center;gap:7px;color:#344054;font-size:11px;font-weight:950;cursor:pointer;white-space:nowrap}
    .dash-event-switch input{position:absolute;opacity:0;pointer-events:none}
    .dash-event-switch-track{position:relative;width:30px;height:18px;flex:0 0 30px;border-radius:999px;background:#d0d5dd;box-shadow:inset 0 0 0 1px rgba(15,23,42,.08);transition:.18s ease}
    .dash-event-switch-track:after{content:"";position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.24);transition:.18s ease}
    .dash-event-switch input:checked+.dash-event-switch-track{background:var(--primary,#d93025)}
    .dash-event-switch input:checked+.dash-event-switch-track:after{transform:translateX(12px)}
    .dash-event-switch input:focus-visible+.dash-event-switch-track{outline:2px solid var(--primary,#d93025);outline-offset:2px}
    .dash-event-recurrence-fields{display:none;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:9px;padding:10px;border:1px solid rgba(15,23,42,.10);border-radius:11px;background:#f8fafc}
    .dash-event-recurrence-fields.open{display:grid}
    .dash-event-recurrence-fields label{display:grid;gap:4px;font-size:10px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;color:#667085}
    .dash-event-recurrence-fields [hidden]{display:none!important}
    .dash-event-recurrence-fields input,.dash-event-recurrence-fields select{width:100%;height:32px;box-sizing:border-box;border:1px solid rgba(15,23,42,.14);border-radius:8px;background:#fff;color:#101828;padding:0 8px;font:inherit;font-size:12px;font-weight:800;text-transform:none;letter-spacing:0}
    .dash-event-recurrence-note{grid-column:1/-1;font-size:11px;line-height:1.35;color:#667085}
    .dash-gantt-groupby{display:flex;align-items:center;gap:6px;flex:1;flex-wrap:wrap;padding:0}
    .dash-gantt-groupby span{font-size:10.5px;font-weight:950;letter-spacing:.05em;text-transform:uppercase;color:#667085}
    .dash-gantt-groupby-btn{appearance:none;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#475467;padding:5px 11px;font:850 11px/1 inherit;cursor:pointer}
    .dash-gantt-groupby-btn.active{background:var(--primary,#d93025);border-color:transparent;color:#fff}
    .dash-gantt-shown-wrap{position:relative}
    .dash-gantt-shown-btn{height:28px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#475467;padding:0 10px;display:inline-flex;align-items:center;gap:7px;font:850 11px/1 inherit;cursor:pointer}
    .dash-gantt-shown-btn.active{border-color:rgba(var(--primary-rgb,217,48,37),.3);background:rgba(var(--primary-rgb,217,48,37),.06);color:var(--primary-readable,var(--primary,#d93025))}
    .dash-gantt-shown-menu{position:absolute;left:0;top:34px;z-index:40;width:260px;border:1px solid #e4e7ec;border-radius:14px;background:#fff;box-shadow:0 20px 55px rgba(15,23,42,.2);padding:8px}
    .dash-gantt-shown-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 7px 9px}
    .dash-gantt-shown-head strong{font-size:13px;color:#101828}.dash-gantt-shown-head button{width:26px;height:26px;border:0;border-radius:8px;background:#f2f4f7;color:#475467;cursor:pointer}
    .dash-gantt-shown-options{display:grid;gap:5px;border-top:1px solid #f2f4f7;padding-top:7px}
    .dash-gantt-shown-option{height:34px;border:1px solid #e4e7ec;border-radius:9px;background:#fff;color:#475467;padding:0 9px;display:grid;grid-template-columns:17px 18px minmax(0,1fr);align-items:center;gap:7px;text-align:left;font:inherit;font-size:11px;font-weight:900;cursor:pointer}
    .dash-gantt-shown-option:hover{background:#f8fafc}.dash-gantt-shown-option.active{border-color:rgba(var(--primary-rgb,217,48,37),.28);background:rgba(var(--primary-rgb,217,48,37),.06);color:#101828}
    .dash-gantt-shown-check{width:15px;height:15px;border:1px solid #d0d5dd;border-radius:5px;background:#fff;display:grid;place-items:center}.dash-gantt-shown-check i{font-size:8px;opacity:0;color:#fff}
    .dash-gantt-shown-option.active .dash-gantt-shown-check{border-color:var(--primary,#d93025);background:var(--primary,#d93025)}.dash-gantt-shown-option.active .dash-gantt-shown-check i{opacity:1}
    .dash-event-equipment{border:1px solid rgba(15,23,42,.12);border-radius:10px;padding:9px 10px;display:grid;gap:8px}
    .dash-event-equipment-head{font-size:11px;font-weight:950;color:#475467;display:flex;align-items:center;gap:7px}
    .dash-event-equipment-head i{color:var(--primary,#d93025);font-size:11px}
    .dash-event-equipment-chips{display:flex;flex-wrap:wrap;gap:6px}
    .dash-event-equipment-chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;background:#f2f4f7;color:#344054;padding:5px 8px;font-size:11px;font-weight:850}
    .dash-event-equipment-chip.warn{background:#fffaeb;color:#93540c}
    .dash-event-equipment-chip.warn .fa-triangle-exclamation{color:#f79009}
    .dash-event-equipment-chip button{appearance:none;border:0;background:transparent;color:inherit;cursor:pointer;padding:0 2px;font-size:10px;opacity:.7}
    .dash-event-equipment-chip button:hover{opacity:1}
    .dash-event-equipment-empty{font-size:11px;font-weight:750;color:#98a2b3}
    .dash-event-equipment-add{border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;padding:7px 9px;font-size:11.5px;font-weight:850;color:#344054;outline:none;font-family:inherit}
    .dash-event-equipment-require{display:grid;grid-template-columns:minmax(0,1fr) 72px 34px;gap:6px;align-items:end}.dash-event-equipment-require input{height:34px;box-sizing:border-box;border:1px solid rgba(15,23,42,.12);border-radius:8px;padding:0 8px;font:850 11px/1 inherit}.dash-event-equipment-require button{height:34px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#475467;cursor:pointer}.dash-event-advanced-note{font-size:10px;font-weight:800;color:#667085;line-height:1.4}.dash-event-advanced-toggle{width:36px;height:34px;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;color:#667085;display:inline-grid;place-items:center;cursor:pointer}.dash-event-advanced-toggle.active{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb),.07);color:var(--primary,#d93025)}
    .dash-event-equipment-allocation{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px;padding:7px;border-radius:9px;background:#f8fafc}.dash-event-equipment-allocation strong{grid-column:1/-1;font-size:10px;color:#475467}.dash-event-equipment-allocation label{display:grid;gap:3px;font-size:8px;font-weight:950;color:#667085;text-transform:uppercase}.dash-event-equipment-allocation input{width:100%;min-width:0;height:30px;box-sizing:border-box;border:1px solid rgba(15,23,42,.12);border-radius:7px;padding:0 6px;font:800 9px/1 inherit;color:#344054}.dash-event-requirement-alert{display:flex;gap:8px;align-items:flex-start;border:1px solid #fda29b;border-radius:10px;background:#fef3f2;color:#b42318;padding:9px 10px;font-size:11px;font-weight:850;line-height:1.35}.dash-event-requirement-alert ul{margin:0;padding-left:16px}.dash-routing-vehicles{height:30px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#667085;padding:0 9px;cursor:pointer}.dash-routing-vehicles.active{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb),.07);color:var(--primary,#d93025)}.dash-vehicle-bank{display:grid;gap:7px;padding:10px 12px;border-top:1px solid rgba(15,23,42,.08)}.dash-vehicle-bank-title{font-size:10px;font-weight:1000;letter-spacing:.06em;text-transform:uppercase;color:#667085}.dash-vehicle-bank-items{display:grid;gap:6px}.dash-vehicle-bank-item{display:flex;align-items:center;gap:8px;text-align:left;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;padding:8px;color:#344054;font-size:11px;font-weight:900;cursor:grab}.dash-vehicle-bank-item.active{border-color:var(--primary,#d93025);box-shadow:0 0 0 2px rgba(var(--primary-rgb),.08)}
    .dash-event-customer-panel{display:grid;border:1px solid rgba(15,23,42,.10);border-radius:11px;background:#f8fafc;overflow:hidden}.dash-event-customer-head{display:grid;grid-template-columns:minmax(0,1fr) 32px;align-items:center}.dash-event-customer-share{display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;align-items:center;padding:11px;cursor:pointer}
    .dash-event-customer-details-toggle{width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:#667085;cursor:pointer}.dash-event-customer-details-toggle:hover{background:#eaecf0;color:#344054}
    .dash-event-customer-share input{position:absolute;opacity:0;pointer-events:none}.dash-event-share-switch{position:relative;width:34px;height:20px;border-radius:999px;background:#d0d5dd;transition:.18s ease}.dash-event-share-switch:after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.22);transition:.18s ease}.dash-event-customer-share input:checked+.dash-event-share-switch{background:var(--primary,#d93025)}.dash-event-customer-share input:checked+.dash-event-share-switch:after{transform:translateX(14px)}.dash-event-customer-share strong{display:block;color:#344054;font-size:12px;font-weight:1000}.dash-event-customer-share small{display:block;margin-top:2px;color:#667085;font-size:10px;font-weight:800;line-height:1.35}
    .dash-event-customer-options{display:none;gap:9px;padding:0 11px 11px;border-top:1px solid rgba(15,23,42,.08)}.dash-event-customer-options.open{display:grid}.dash-event-customer-option{display:flex;align-items:flex-start;gap:8px;color:#344054;font-size:11px;font-weight:900;line-height:1.35}.dash-event-customer-option:first-child{margin-top:10px}.dash-event-customer-option input{margin:1px 0 0;accent-color:var(--primary,#d93025)}.dash-event-customer-note{display:grid;gap:5px;color:#667085;font-size:9px;font-weight:1000;letter-spacing:.05em;text-transform:uppercase}.dash-event-customer-note textarea{min-height:64px;resize:vertical;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;padding:8px 9px;color:#101828;font:inherit;font-size:11px;font-weight:800;line-height:1.45;letter-spacing:0;text-transform:none;outline:none}.dash-event-customer-note textarea:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb),.08)}
    .dash-event-pop-head{position:relative;padding-right:30px}.dash-event-pop-meta{display:grid;gap:7px;margin-top:13px;line-height:1.3}.dash-event-pop-project-name-row{display:flex;align-items:center;gap:7px;min-width:0}.dash-event-pop-project-name{min-width:0;flex:1;font-size:13px;font-weight:1000;color:#344054;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dash-event-project-clear{width:22px;height:22px;flex:0 0 auto;border:0;border-radius:7px;background:#f2f4f7;color:#667085;display:inline-grid;place-items:center;cursor:pointer}.dash-event-project-clear:hover,.dash-event-project-clear:focus-visible{background:#fee4e2;color:#b42318;outline:none}.dash-event-pop-address,.dash-event-pop-time{font-size:12px;font-weight:850;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dash-event-pop-time{color:#475467}.dash-event-time-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;min-width:0;margin-top:11px}.dash-event-time-field{display:grid;gap:4px;min-width:0;color:#667085;font-size:9px;font-weight:1000;letter-spacing:.05em;text-transform:uppercase}.dash-event-time-field input{display:block;width:100%;min-width:0;max-width:100%;height:34px;box-sizing:border-box;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;padding:0 7px;color:#101828;font:inherit;font-size:10.5px;font-weight:900;letter-spacing:0;text-transform:none;outline:none}.dash-event-time-field input:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb),.08)}
    .dash-event-close{position:absolute;right:-3px;top:-3px;width:26px;height:26px;border:0;border-radius:8px;background:#f2f4f7;color:#667085;display:flex;align-items:center;justify-content:center;cursor:pointer}
    .dash-event-close:hover{background:#e4e7ec;color:#101828}
    .dash-event-type-pills{display:flex;align-items:center;flex-wrap:wrap;gap:7px}
    .dash-event-assignees{margin-top:10px;border:1px solid rgba(15,23,42,.08);border-radius:12px;padding:10px;background:#fbfcfe}
    .dash-event-assignees-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}
    .dash-event-assignees-head strong{font-size:11px;font-weight:1000;text-transform:uppercase;letter-spacing:.03em;color:#475467}
    .dash-event-assign-add{height:26px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#344054;padding:0 9px;font-size:11px;font-weight:1000;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
    .dash-event-assign-add:hover{border-color:rgba(15,23,42,.26);background:#f8fafc}
    .dash-event-assignee-chips{display:flex;flex-wrap:wrap;gap:6px}
    .dash-event-assignee-chip{display:inline-flex;align-items:center;gap:6px;height:28px;border-radius:999px;background:#eef2f6;color:#101828;padding:0 6px 0 11px;font-size:11px;font-weight:950}
    .dash-event-assignee-chip.warn{background:#fee2e2;color:#b42318}
    .dash-event-assignee-chip button{width:18px;height:18px;border:0;border-radius:999px;background:rgba(15,23,42,.08);color:inherit;font-size:12px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}
    .dash-event-assignee-chip button:hover{background:rgba(15,23,42,.16)}
    .dash-event-assignee-empty{color:#98a2b3;font-size:11px;font-weight:850}
    .dash-event-assign-menu{margin-top:8px;border:1px solid rgba(15,23,42,.10);border-radius:10px;background:#fff;max-height:180px;overflow:auto;padding:4px}
    .dash-event-assign-menu button{width:100%;border:0;border-radius:8px;background:transparent;color:#344054;text-align:left;padding:7px 9px;font-size:12px;font-weight:950;cursor:pointer}
    .dash-event-assign-menu button:hover{background:#f8fafc}
    .dash-event-assign-menu small{color:#98a2b3;font-weight:800}.dash-event-type-pill{height:30px;border-radius:999px;background:#f2f4f7;color:#344054;padding:0 10px;display:inline-flex;align-items:center;width:max-content;max-width:100%;font-size:11px;font-weight:1000}.dash-event-status-pill{height:30px;border:1px dotted #b54708;border-radius:999px;background:#fffaeb;color:#93370d;padding:0 10px;display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:1000}
    .dash-event-type-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
    .dash-event-type-btn{height:32px;border:1px solid rgba(15,23,42,.10);border-radius:10px;background:#f8fafc;color:#344054;font-size:11px;font-weight:950;cursor:pointer}
    .dash-event-type-btn:hover{border-color:rgba(15,23,42,.22);background:#fff}
    .dash-event-type-btn.active{border-color:var(--primary,#d93025);box-shadow:inset 0 0 0 1px var(--primary,#d93025);background:rgba(var(--primary-rgb),.07);color:#101828}
    .dash-event-project-picker{position:relative;z-index:5}.dash-event-project-picker-row{display:grid;grid-template-columns:minmax(0,1fr) 38px;gap:7px}.dash-event-project-create{width:38px;height:38px;border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#fff;color:#475467;display:grid;place-items:center;cursor:pointer}.dash-event-project-create:hover,.dash-event-project-create:focus-visible{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb),.06);color:var(--primary,#d93025);outline:none}.dash-event-search{width:100%;height:38px;box-sizing:border-box;border:1px solid rgba(15,23,42,.12);border-radius:10px;padding:0 10px;font-size:12px;font-weight:850;color:#101828;outline:none}
    .dash-event-search:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb),.10)}
    .dash-event-desc{min-height:74px;resize:vertical;border:1px solid rgba(15,23,42,.12);border-radius:10px;padding:9px 10px;font-size:12px;font-weight:850;color:#101828;outline:none;font-family:inherit}
    .dash-event-desc:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb),.10)}
    .dash-event-project-list{position:absolute;left:0;right:0;top:calc(100% + 5px);display:grid;gap:4px;max-height:210px;overflow:auto;padding:6px;background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:11px;box-shadow:0 18px 45px rgba(15,23,42,.18)}.dash-event-project-list[hidden]{display:none}
    .dash-event-project-option{border:0;border-radius:9px;background:transparent;color:#344054;text-align:left;padding:8px 9px;display:grid;gap:2px;cursor:pointer}
    .dash-event-project-option:hover{background:#f8fafc}
    .dash-event-project-option strong{font-size:12px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dash-event-project-option span{font-size:10px;font-weight:850;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dash-event-pop-actions{position:sticky;bottom:-16px;z-index:4;display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:auto;padding:10px 0 2px;background:#fff;border-top:1px solid rgba(15,23,42,.07)}
    .dash-event-view-btn{height:34px;border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#fff;color:#344054;padding:0 11px;font-size:12px;font-weight:950;cursor:pointer}
    .dash-event-delete{height:34px;border:1px solid #fecdca;border-radius:10px;background:#fff;color:#b42318;padding:0 11px;font-size:12px;font-weight:950;cursor:pointer}.dash-event-delete:hover{background:#fef3f2}.dash-event-delete:disabled{opacity:.55;cursor:wait}
    .dash-event-save{height:34px;border:0;border-radius:10px;background:var(--primary,#d93025);color:var(--on-primary,#fff);padding:0 13px;font-size:12px;font-weight:1000;cursor:pointer}
    .dash-modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.42);z-index:2400;display:flex;align-items:center;justify-content:center;padding:20px}
    .dash-modal{width:min(760px,94vw);max-height:min(720px,90vh);overflow:auto;background:#fff;border-radius:18px;box-shadow:0 24px 70px rgba(15,23,42,.28);border:1px solid rgba(15,23,42,.12)}
    .dash-modal-head{padding:16px 18px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
    .dash-modal-head h3{margin:0;font-size:18px;font-weight:1000;color:#101828}
    .dash-modal-body{padding:16px 18px 18px}
    .dash-modal-close{border:0;background:#f2f4f7;width:34px;height:34px;border-radius:10px;cursor:pointer;color:#344054}
    .dash-crew-settings-modal{width:min(1280px,96vw);height:min(860px,92vh);max-height:92vh;display:flex;flex-direction:column;overflow:hidden}
    .dash-crew-settings-modal>.dash-modal-body{flex:1;min-height:0;overflow:auto;padding:0}
    .dash-crew-settings-host{min-height:100%;background:#f8fafc}
    .dash-crew-settings-host .cs-wrap.embedded-tab-only{max-width:none;padding:16px}
    .dash-crew-settings-host .cs-wrap.embedded-tab-only>.cs-title,
    .dash-crew-settings-host .cs-wrap.embedded-tab-only>.cs-sub,
    .dash-crew-settings-host .cs-wrap.embedded-tab-only>.cs-tabs{display:none}
    .dash-crew-settings-host .cs-wrap.embedded-tab-only>.cs-card{margin:0}
    .dash-crew-settings-loading{display:flex;align-items:center;justify-content:center;gap:9px;min-height:240px;color:#667085;font-size:13px;font-weight:850}
    .dash-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .dash-settings-field{display:grid;gap:6px;font-size:11px;font-weight:1000;text-transform:uppercase;letter-spacing:.03em;color:#667085}
    .dash-settings-field.full{grid-column:1/-1}
    .dash-settings-field input,.dash-settings-field select,.dash-settings-field textarea{width:100%;box-sizing:border-box;border:1px solid rgba(15,23,42,.12);border-radius:11px;background:#fff;color:#101828;font:inherit;font-size:13px;font-weight:800;text-transform:none;letter-spacing:0;padding:10px 11px;outline:none}
    .dash-settings-field textarea{resize:vertical;min-height:84px}
    .dash-settings-field input:focus,.dash-settings-field select:focus,.dash-settings-field textarea:focus{border-color:rgba(var(--primary-rgb),.42);box-shadow:0 0 0 3px rgba(var(--primary-rgb),.10)}
    .dash-settings-grid.hidden,.dash-settings-field.hidden{display:none}
    .dash-crew-pay-mode{display:flex;align-items:center;gap:6px;border:1px solid rgba(15,23,42,.10);background:#f8fafc;border-radius:12px;padding:4px;width:max-content;max-width:100%;margin:0 0 12px}
    .dash-crew-pay-mode button{height:30px;border:0;border-radius:9px;background:transparent;color:#667085;font-size:11px;font-weight:1000;padding:0 10px;cursor:pointer}
    .dash-crew-pay-mode button.active{background:#fff;color:#101828;box-shadow:0 1px 4px rgba(15,23,42,.10)}
    .dash-crew-members{display:grid;gap:8px;margin-top:12px}
    .dash-crew-member-row{display:grid;grid-template-columns:minmax(150px,1.2fr) minmax(130px,.9fr) auto 34px;gap:8px;align-items:end;border:1px solid rgba(15,23,42,.08);border-radius:12px;padding:10px}
    .dash-crew-member-details{grid-column:1/-1;display:none;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;border-top:1px solid rgba(15,23,42,.08);padding-top:10px}
    .dash-crew-member-row.open .dash-crew-member-details{display:grid}
    .dash-crew-member-row.crew-pay .member-pay-field{display:none}
    .dash-modal-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:16px}
    .dash-modal-actions-right{display:flex;align-items:center;justify-content:flex-end;gap:10px}
    .dash-modal-status{font-size:12px;font-weight:850;color:#667085}
    @media(max-width:1100px){
      .dash-body{grid-template-columns:1fr}.dash-right{overflow:visible}.dash-shell{height:auto}.dash-left{overflow:auto}
      .dash-stats-row{grid-template-columns:var(--dash-mode-col) minmax(126px,var(--dash-filter-col)) repeat(var(--dash-stat-count),minmax(92px,1fr));overflow-x:auto;padding-bottom:2px}
      .dash-filter-menu{left:calc(var(--dash-mode-col) + var(--dash-stat-gap));right:auto;width:650px}
    }
    .dash-mobile-toolbar{display:none}
    @media(max-width:720px){
      .dash-toolbar{display:none}
      .dash-mobile-toolbar{position:relative;z-index:40;display:flex;align-items:center;gap:2px;height:50px;padding:0 6px;background:#fff;border-bottom:0;box-sizing:border-box;white-space:nowrap}
      .dash-mobile-menu-wrap{position:relative;flex:0 0 auto}
      .dash-mobile-control{height:34px;border:0;border-radius:8px;background:transparent;color:#344054;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 8px;font:inherit;font-size:12px;font-weight:1000;cursor:pointer}
      .dash-mobile-control:hover,.dash-mobile-control[aria-expanded="true"]{background:#f2f4f7}
      .dash-mobile-control.view{width:34px;padding:0;font-size:13px}
      .dash-mobile-control.view .fa-chevron-down{font-size:8px;margin-left:1px}
      .dash-mobile-control.month{width:104px;max-width:104px;overflow:hidden;text-overflow:ellipsis}
      .dash-mobile-control.month span{overflow:hidden;text-overflow:ellipsis}
      .dash-mobile-control.today{width:32px;padding:0;margin-left:auto;color:#475467}
      .dash-mobile-today-date{width:19px;height:20px;border:1.5px solid currentColor;border-radius:3px;display:grid;place-items:center;padding-top:4px;box-sizing:border-box;font-size:9px;line-height:1;font-weight:1000;position:relative}
      .dash-mobile-today-date:before{content:"";position:absolute;left:-1.5px;right:-1.5px;top:4px;border-top:1.5px solid currentColor}
      .dash-mobile-nav{width:25px;padding:0;font-size:10px}
      .dash-mobile-type{width:28px;padding:0;color:#667085;font-size:12px}
      .dash-mobile-type.active{background:rgba(var(--primary-rgb),.10);color:var(--primary-readable,var(--primary,#d93025))}
      .dash-mobile-show{width:32px;padding:0;color:#475467}
      .dash-mobile-popover{position:absolute;top:calc(100% + 6px);left:0;width:190px;max-height:min(420px,calc(100vh - 70px));overflow:auto;padding:6px;border:1px solid rgba(15,23,42,.10);border-radius:12px;background:#fff;box-shadow:0 18px 45px rgba(15,23,42,.18);box-sizing:border-box}
      .dash-mobile-popover.months{width:min(334px,calc(100vw - 16px));padding:10px}
      .dash-mobile-popover.schedules{left:auto;right:0}
      .dash-mobile-month-picker{display:grid;grid-template-columns:1fr 1fr;gap:10px;max-height:280px}
      .dash-mobile-month-picker section{min-width:0;overflow:auto;border:1px solid rgba(15,23,42,.08);border-radius:9px;padding:3px}
      .dash-mobile-month-picker button{height:31px;font-size:11px}
      .dash-mobile-popover button{width:100%;height:36px;border:0;border-radius:8px;background:transparent;color:#344054;display:flex;align-items:center;gap:10px;padding:0 9px;font:inherit;font-size:12px;font-weight:950;text-align:left;cursor:pointer}
      .dash-mobile-popover button:hover,.dash-mobile-popover button.active{background:rgba(var(--primary-rgb),.08);color:var(--primary-readable,var(--primary,#d93025))}
      .dash-mobile-popover button i{width:15px;text-align:center}
      .dash-body,.dash-body.schedule-mode{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) auto;gap:0;padding:0;overflow-x:hidden;overflow-y:auto;background:#fff}
      .dash-shell{height:100%;background:#fff}
      .dash-left,.dash-body.events-mode .dash-left{overflow:hidden}
      .dash-right{display:none}
      .dash-mobile-tray-backdrop{position:fixed;z-index:90;inset:0;background:rgba(15,23,42,.24);animation:dash-tray-fade-in .22s ease-out both}
      .dash-mobile-tray-backdrop.closing{animation:dash-tray-fade-out .2s ease-in both}
      .dash-mobile-tray{position:absolute;z-index:91;top:0;right:0;width:min(340px,calc(100vw - 28px));height:100%;padding:12px 10px 20px;background:#fff;box-shadow:-16px 0 42px rgba(15,23,42,.18);overflow:auto;box-sizing:border-box;animation:dash-tray-slide-in .24s cubic-bezier(.2,.8,.2,1) both}
      .dash-mobile-tray-backdrop.closing .dash-mobile-tray{animation:dash-tray-slide-out .2s ease-in both}
      @keyframes dash-tray-fade-in{from{opacity:0}to{opacity:1}}
      @keyframes dash-tray-fade-out{from{opacity:1}to{opacity:0}}
      @keyframes dash-tray-slide-in{from{transform:translateX(100%)}to{transform:translateX(0)}}
      @keyframes dash-tray-slide-out{from{transform:translateX(0)}to{transform:translateX(100%)}}
      .dash-mobile-tray-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 4px 10px;color:#101828}
      .dash-mobile-tray-head strong{font-size:14px;font-weight:1000}
      .dash-mobile-tray-close{width:32px;height:32px;border:0;border-radius:8px;background:#f2f4f7;color:#475467;cursor:pointer}
      .dash-card,.dash-schedule-card{border:0;border-radius:0;box-shadow:none}
      .dash-body.events-mode .dash-schedule-card{min-height:0}
      .dash-schedule-view,.dash-schedule-view .prs-wrap{min-height:0;min-width:0}
      .dash-schedule-view .prs-surface,.dash-schedule-view .prs-resource-scroll{border:0;border-radius:0;box-shadow:none;background:#fff}
      .dash-body.events-mode .dash-schedule-view .prs-surface{touch-action:none;overscroll-behavior:contain}
      .dash-schedule-view.mobile-swipe-next{animation:dash-calendar-enter-next .24s ease-out both}
      .dash-schedule-view.mobile-swipe-prev{animation:dash-calendar-enter-prev .24s ease-out both}
      @keyframes dash-calendar-enter-next{from{opacity:.45;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
      @keyframes dash-calendar-enter-prev{from{opacity:.45;transform:translateX(-20px)}to{opacity:1;transform:translateX(0)}}
      .dash-schedule-view .prs-month,.dash-schedule-view .prs-month-head-row,.dash-schedule-view .prs-month-week,.dash-schedule-view .prs-month-item-track{min-width:100%!important;grid-template-columns:repeat(7,minmax(0,1fr))!important}
      .dash-schedule-view .prs-month-head-row{height:28px}
      .dash-schedule-view .prs-month-head{height:28px;font-size:9px}
      .dash-schedule-view .prs-month-week{min-height:max(84px,calc((100vh - 104px) / 6));flex-basis:max(84px,calc((100vh - 104px) / 6))}
      .dash-schedule-view .prs-month-week .prs-day{min-height:84px;padding:2px}
      .dash-schedule-view .prs-day-num{font-size:10px;line-height:15px;margin-bottom:0}
      .dash-schedule-view .prs-month-item-viewport{height:calc(100% - 17px)}
      .dash-schedule-view .prs-month-bar{margin:17px 1px 0}
      .dash-schedule-view .prs-month-bar .prs-work-chip,.dash-schedule-view .prs-month-day-peek-item .prs-work-chip{height:18px;min-height:18px;border-left-width:2px;border-radius:4px;padding:1px 2px;font-size:7px;line-height:1.1;box-shadow:none}
      .dash-schedule-view .prs-month-bar .prs-chip-bottom,.dash-schedule-view .prs-month-bar .prs-assignee,.dash-schedule-view .prs-month-bar .prs-work-chip:after{display:none}
      .dash-schedule-view .prs-month-overflow{width:calc(100% - 2px);height:13px;margin:0 1px 1px;padding:0 2px;font-size:7px;line-height:13px}
      .dash-body.events-mode .dash-schedule-view .prs-surface{width:100%;max-width:100%;overflow-x:hidden!important}
      .dash-body.events-mode .dash-schedule-view .prs-time-grid,.dash-body.events-mode .dash-schedule-view .prs-all-day-grid{width:100%!important;max-width:100%!important;box-sizing:border-box;grid-template-columns:40px repeat(var(--prs-days),minmax(0,1fr));min-width:100%!important}
      .dash-body.events-mode .dash-schedule-view .prs-time-head,.dash-body.events-mode .dash-schedule-view .prs-day-head,.dash-body.events-mode .dash-schedule-view .prs-all-day-cell{min-width:0;overflow:hidden}
      .dash-body.events-mode .dash-schedule-view .prs-slot{min-width:0;overflow:visible;z-index:1}.dash-body.events-mode .dash-schedule-view .prs-slot.has-chip{z-index:4}.dash-body.events-mode .dash-schedule-view .prs-slot .prs-work-chip{z-index:4}
      .dash-schedule-view .prs-time-grid.prs-time-header-grid{height:48px}
      .dash-schedule-view .prs-time-head,.dash-schedule-view .prs-day-head{height:48px;font-size:10px;line-height:1.1}
      .dash-schedule-view .prs-day-head{flex-direction:column;gap:2px}
      .dash-schedule-view .prs-day-head-desktop{display:none}
      .dash-schedule-view .prs-day-head-mobile{display:flex;flex-direction:column;align-items:center;line-height:1.05}
      .dash-schedule-view .prs-day-head-mobile strong{font-size:12px;color:#101828}
      .dash-schedule-view .prs-all-day-grid{top:48px;min-height:48px!important;height:48px!important;grid-template-rows:48px!important}
      .dash-schedule-view .prs-all-day-label-cell{font-size:8px;line-height:1.05;text-align:center;text-transform:uppercase;padding:3px}
      .dash-schedule-view .prs-all-day-label-desktop{display:none}
      .dash-schedule-view .prs-all-day-label-mobile{display:inline}
      .dash-schedule-view .prs-all-day-cell{min-height:48px}
      .dash-schedule-view .prs-all-day-bar-top{margin:3px 1px 0}
      .dash-schedule-view .prs-all-day-bar-top .prs-work-chip{height:40px;min-height:40px;border-left-width:2px;border-radius:5px;padding:3px;font-size:8px;box-shadow:none}
      .dash-schedule-view .prs-all-day-bar-top .prs-chip-bottom,.dash-schedule-view .prs-all-day-bar-top .prs-assignee{display:none}
      .dash-schedule-view .prs-time-label{height:48px;font-size:9px;padding-top:4px}
      .dash-schedule-view .prs-slot{height:48px}
      .dash-schedule-view .prs-work-chip.timed{border-left-width:2px;border-radius:6px;padding:3px;font-size:8px;box-shadow:none}
      .dash-schedule-view .prs-work-chip.timed .prs-chip-bottom,.dash-schedule-view .prs-work-chip.timed .prs-assignee,.dash-schedule-view .prs-work-chip.timed .prs-address{display:none}
      .dash-routing-tabs{display:flex;align-items:stretch;gap:2px;min-height:40px;padding:4px 6px;background:#fff;border-bottom:1px solid rgba(15,23,42,.08)}
      .dash-routing-tab{flex:1;min-width:0;border:0;border-radius:8px;background:transparent;color:#667085;font:inherit;font-size:12px;font-weight:1000;cursor:pointer}
      .dash-routing-tab.active{background:rgba(var(--primary-rgb),.10);color:var(--primary-readable,var(--primary,#d93025))}
      .dash-schedule-split.mobile-routing{gap:0;height:100%}
      .dash-schedule-split.mobile-routing .dash-schedule-pane{flex:1 1 auto;height:0;min-height:0}
      .dash-schedule-split.mobile-routing .dash-schedule-pane-title{min-height:30px;padding:3px 6px 4px;align-items:center;justify-content:flex-end}
      .dash-schedule-split.mobile-routing .dash-schedule-pane-title>span:first-child{display:none}
      .dash-schedule-split.mobile-routing .dash-routing-scale{border-radius:8px}
      .dash-schedule-split.mobile-routing .dash-routing-scale button{height:23px;padding:0 7px}
      .dash-schedule-split.mobile-routing .prs-resource-scroll{touch-action:pan-x;overscroll-behavior-x:contain}
      .dash-schedule-split.mobile-routing .psv-grid.psv-resource-grid{grid-template-columns:78px repeat(var(--slot-count,16),minmax(42px,1fr));min-width:calc(78px + var(--slot-count,16) * 42px)}
      .dash-schedule-split.mobile-routing .prs-resource-grid.mobile-resource-rows{grid-template-columns:repeat(var(--prs-days,56),minmax(44px,1fr));min-width:calc(var(--prs-days,56) * 44px)}
      .dash-schedule-split.mobile-routing .prs-resource-grid.mobile-resource-rows:before{display:none}
      .dash-schedule-split.mobile-routing .prs-resource-time-grid{grid-template-columns:82px repeat(var(--prs-slots,24),minmax(42px,1fr));min-width:calc(82px + var(--prs-slots,24) * 42px)}
      .dash-schedule-split.mobile-routing .psv-person,.dash-schedule-split.mobile-routing .prs-resource-label{padding:4px;font-size:10px}
      .dash-schedule-split.mobile-routing .psv-person small,.dash-schedule-split.mobile-routing .prs-resource-label small{display:none}
      .dash-schedule-split.mobile-routing .psv-resource-settings-btn{width:18px;height:18px;font-size:10px}
      .dash-schedule-split.mobile-routing .psv-hour{min-height:38px;padding:3px 1px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;font-size:10px;line-height:1}
      .dash-schedule-split.mobile-routing .psv-hour span{display:block}
      .dash-schedule-split.mobile-routing .prs-resource-day-head{padding:2px;font-size:9px;line-height:1.05}
      .dash-schedule-split.mobile-routing .prs-resource-day-head.today span:last-child:after{display:none}
      .dash-schedule-split.mobile-routing .prs-resource-label{position:sticky;left:0;z-index:6;min-height:34px;height:34px;padding:0 8px;flex-direction:row;align-items:center;justify-content:space-between;font-size:12px;border-bottom:1px solid rgba(15,23,42,.08)}
      .dash-schedule-split.mobile-routing .prs-resource-label .psv-resource-label-main{max-width:100%}
      .dash-schedule-split.mobile-routing .prs-resource-cell{min-height:0}
      .dash-routing-placement-dock{flex:0 0 auto;position:relative;z-index:12;min-height:94px;padding:7px 8px 9px;background:#fff;border-top:1px solid rgba(15,23,42,.10);box-shadow:0 -8px 22px rgba(15,23,42,.07)}
      .dash-routing-placement-dock>strong{display:block;margin:0 0 6px;font-size:10px;font-weight:1000;letter-spacing:.06em;text-transform:uppercase;color:#667085}
      .dash-routing-placement-track{display:flex;gap:7px;overflow-x:auto;overscroll-behavior-x:contain;padding-bottom:2px}
      .dash-routing-placement-tile{flex:0 0 108px;min-height:58px;border:1px solid rgba(15,23,42,.10);border-radius:9px;background:#f8fafc;color:#101828;padding:7px;text-align:left;cursor:pointer}
      .dash-routing-placement-tile.selected{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb),.08);color:var(--primary-readable,var(--primary,#d93025))}
      .dash-routing-placement-tile.missing-address{border-color:#eaaa35;background:#fff8e8}
      .dash-routing-placement-tile strong,.dash-routing-placement-tile span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dash-routing-placement-tile strong{font-size:10px;font-weight:1000}
      .dash-routing-placement-tile span{margin-top:4px;font-size:9px;font-weight:850;color:#667085}
      .dash-routing-placement-empty{font-size:11px;font-weight:850;color:#98a2b3;padding:14px 3px}
      .dash-schedule-split.mobile-routing .prs-resource-time-head{font-size:9px;line-height:1.05}
      .dash-event-popover{z-index:2147483000!important;top:var(--portal-mobile-header-height,56px)!important;right:0!important;bottom:0!important;left:0!important;width:100%!important;height:calc(100dvh - var(--portal-mobile-header-height,56px))!important;max-width:none!important;max-height:none!important;border:0;border-radius:0;box-shadow:none;padding:16px;gap:12px}
      .dash-event-pop-head{display:grid;grid-template-columns:minmax(0,1fr) 38px;column-gap:8px;align-items:center;padding-right:0}
      .dash-event-title-input{height:40px;padding:0 11px;font-size:15px}
      .dash-event-close{position:static;width:38px;height:38px}
      .dash-event-pop-meta{grid-column:1/-1;margin-top:10px}
      .dash-event-time-fields{margin-top:10px}
    }
    @media(min-width:721px){.prs-day-head-mobile,.prs-all-day-label-mobile{display:none}}
  `;

  // Install the tab styles as soon as this module is evaluated. The portal
  // runtime mounts apps asynchronously, so waiting until mount() can expose
  // the scheduling markup for a frame (or longer on a busy first load) before
  // its styles exist.
  injectCSS('dashboard_tab', css);

  function orgId(){ return String(cfg.userOrgId || cfg.orgId || '').trim(); }
  function currentUserDoc(){
    const email = String(cfg.userEmail || window.__APP?.userEmail || '').trim().toLowerCase();
    if (!email) return null;
    return users.find((user) => String(user.email || '').trim().toLowerCase() === email) || null;
  }
  function applyUserSchedulePreferences(){
    if (schedulePrefsApplied) return;
    const me = currentUserDoc();
    if (!me) return;
    schedulePrefsApplied = true;
    const prefs = me.preferences?.scheduling || {};
    if (typeof prefs.live_travel === 'boolean') appointmentScheduleLiveTravel = prefs.live_travel;
    if (typeof prefs.production_live_travel === 'boolean') productionLiveTravel = prefs.production_live_travel;
    if (Number(prefs.gantt_zoom) > 0) ganttZoomPxPerDay = Number(prefs.gantt_zoom);
    if (['project', 'resource'].includes(clean(prefs.gantt_group_by))) ganttGroupBy = clean(prefs.gantt_group_by);
  }
  async function persistSchedulePreference(patch = {}){
    const me = currentUserDoc();
    if (!me?.id || !window.PlatformAPI?.documents?.setField) return;
    const preferences = { ...(me.preferences || {}), scheduling: { ...((me.preferences || {}).scheduling || {}), ...patch } };
    me.preferences = preferences;
    try {
      await window.PlatformAPI.documents.setField(orgId(), 'users', me.id, 'preferences', preferences, { kind:'user_preferences' });
    } catch (error) {
      console.warn('Could not save scheduling preference', error);
    }
  }
  function ganttViewEnabled(){
    const has = window.Portal?.appFlags?.has;
    return typeof has === 'function' ? has('scheduling', 'gantt') !== false : true;
  }
  function routingViewEnabled(){
    const has = window.Portal?.appFlags?.has;
    return typeof has === 'function' ? has('scheduling', 'routing') !== false : true;
  }
  function travelTimeEnabled(){
    const has = window.Portal?.appFlags?.has;
    return typeof has === 'function' ? has('scheduling', 'travel_time') !== false : true;
  }
  function branchId(){ return window.Portal.branchModules?.currentBranchId?.() || cfg.userBranchId || cfg.branchId || 'default'; }
  function normalizeProjectConfig(config = {}){
    const mode = clean(config?.title_mode || config?.project_title_mode || 'customer_name');
    return {
      ...(config && typeof config === 'object' ? config : {}),
      title_mode:['customer_name','address','manual'].includes(mode) ? mode : 'customer_name'
    };
  }
  function validDate(value){
    if (value === null || value === undefined || value === '') return null;
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  function startOfDay(date){ const d = validDate(date); if (!d) return null; d.setHours(0,0,0,0); return d; }
  function addDays(date, days){ const d = new Date(date); d.setDate(d.getDate() + days); return d; }
  function sameDay(a, b){ const left = startOfDay(a); const right = startOfDay(b); return !!left && !!right && left.getTime() === right.getTime(); }
  function weekStart(date){ const d = startOfDay(date); d.setDate(d.getDate() - d.getDay()); return d; }
  function monthStart(date){ return new Date(date.getFullYear(), date.getMonth(), 1); }
  function monthEnd(date){ return new Date(date.getFullYear(), date.getMonth() + 1, 1); }
  function routeDate(value = anchorDate){
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function isMobileScheduleLayout(){ return window.matchMedia?.('(max-width: 720px)').matches === true; }
  function openMobileTray(){
    if (mobileTrayCloseTimer) window.clearTimeout(mobileTrayCloseTimer);
    mobileTrayCloseTimer = null;
    mobileTrayClosing = false;
    mobileTrayOpen = true;
  }
  function closeMobileTray(){
    if (!mobileTrayOpen || mobileTrayClosing) return;
    mobileTrayClosing = true;
    if (mobileTrayCloseTimer) window.clearTimeout(mobileTrayCloseTimer);
    mobileTrayCloseTimer = window.setTimeout(() => {
      mobileTrayOpen = false;
      mobileTrayClosing = false;
      mobileTrayCloseTimer = null;
      render();
    }, 210);
  }
  function animateMobileCalendarSwipe(delta){
    if (!isMobileScheduleLayout()) return;
    mobileCalendarSwipeDirection = delta > 0 ? 'next' : 'prev';
    if (mobileCalendarSwipeTimer) window.clearTimeout(mobileCalendarSwipeTimer);
    mobileCalendarSwipeTimer = window.setTimeout(() => {
      mobileCalendarSwipeDirection = '';
      mobileCalendarSwipeTimer = null;
      render();
    }, 260);
  }
  function mobileMonthChoices(){
    return Array.from({ length:25 }, (_, index) => new Date(anchorDate.getFullYear(), anchorDate.getMonth() + index - 12, 1));
  }
  function mobileYearChoices(){
    return Array.from({ length:25 }, (_, index) => mobilePickerYear + index - 12);
  }
  function syncScheduleRoute(patch = {}, options = {}){
    if (window.Portal?.navigation?.applying) return;
    window.Portal?.navigation?.write?.({ tab:'scheduling', ...patch }, {
      history:options.history || 'replace',
      source:options.source || 'scheduling',
      ownedKeys:options.ownedKeys || Object.keys(patch)
    });
  }
  function fmtTime(date){ const value = validDate(date); return value ? value.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) : '' ; }
  function fmtDayTime(date){
    const value = validDate(date);
    if (!value) return '';
    const time = fmtTime(value);
    const today = new Date();
    if (value.getFullYear() === today.getFullYear() && value.getMonth() === today.getMonth() && value.getDate() === today.getDate()) return time;
    return `${value.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' })} · ${time}`;
  }
  function eventStart(event){ return window.PlatformScheduling?.eventStart?.(event) || null; }
  function eventEnd(event){ return window.PlatformScheduling?.eventEnd?.(event) || eventStart(event); }
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
        message: (globalThis.PlatformLanguage?.text("scheduling","m_40cdabf6fe63f1","No slots available for this day because this day is turned off.") ?? "No slots available for this day because this day is turned off.")
      };
    }
    return {
      start: clean(matching.start || matching.start_time || globalStart) || globalStart,
      end: clean(matching.end || matching.end_time || globalEnd) || globalEnd,
    };
  }
  function minutesForClock(value = '', fallback = 0){
    const match = /^(\d{1,2}):(\d{2})/.exec(clean(value));
    if (!match) return fallback;
    return Math.max(0, Math.min(24 * 60, Number(match[1]) * 60 + Number(match[2])));
  }
  const FILTER_TYPES = {
    user: { label: (globalThis.PlatformLanguage?.text("scheduling","m_dfd6687ea85fad","User") ?? "User"), icon: 'fa-user' },
    lead_source: { label: (globalThis.PlatformLanguage?.text("scheduling","m_666e28a29b15b2","Lead Source") ?? "Lead Source"), icon: 'fa-bullhorn' },
    city: { label: (globalThis.PlatformLanguage?.text("scheduling","m_38e1463e6f0488","City") ?? "City"), icon: 'fa-location-dot' },
  };
  function clean(value){ return String(value ?? '').trim(); }
  function norm(value){ return clean(value).toLowerCase(); }
  function eventTypeId(event = {}){
    event = event || {};
    return clean(event.event_type_default_id || event.type_id || event.event_type_id || event.type);
  }
  function eventKind(event = {}){
    event = event || {};
    return clean(window.PlatformScheduling?.eventKind?.(event) || event.kind || event.event_kind || event.schedule_item_kind || eventTypeId(event)).toLowerCase().replace(/[\s-]+/g, '_');
  }
  function productionResourceType(event = {}){
    event = event || {};
    const explicit = clean(event.resource_type || event.metadata?.resource_type).toLowerCase().replace(/[\s-]+/g, '_');
    if (['material', 'labor', 'equipment'].includes(explicit)) return explicit;
    if (clean(event.labor_list_id)) return 'labor';
    if (clean(event.equipment_list_id)) return 'equipment';
    const scheduleKind = clean(event.schedule_item_kind || event.scheduleItemKind).toLowerCase().replace(/[\s-]+/g, '_');
    if (['material_delivery', 'materials_delivery'].includes(scheduleKind)) return 'material';
    if (['labor', 'equipment'].includes(scheduleKind)) return scheduleKind;
    return '';
  }
  function isSalesEvent(event){ return !!event && eventKind(event) === 'sales_appointment'; }
  function isSalesFollowUpEvent(event){ return !!event && eventKind(event) === 'sales_follow_up'; }
  function isProductionEvent(event){
    if (!event) return false;
    const resourceType = productionResourceType(event);
    return resourceType === 'labor' || resourceType === 'equipment' || eventKind(event) === 'project_work';
  }
  function isMaterialEvent(event){
    if (!event) return false;
    const resourceType = productionResourceType(event);
    if (resourceType === 'labor' || resourceType === 'equipment') return false;
    if (resourceType === 'material') return true;
    if (window.PlatformScheduleView?.isMaterialDeliveryEvent?.(event)) return true;
    const kind = eventKind(event);
    const type = eventTypeId(event).toLowerCase().replace(/[\s-]+/g, '_');
    const sourceType = clean(event?.source_ref?.type || event?.source?.type || event?.source_type).toLowerCase().replace(/[\s-]+/g, '_');
    return kind === 'material_delivery' || kind === 'materials_delivery' || type === 'delivery' || type === 'material_delivery' || type.startsWith('material_delivery_') || ['material_list','materials_list'].includes(sourceType);
  }
  function isVehicleBooking(event = {}){
    return event.vehicle_booking === true || eventKind(event) === 'equipment_booking';
  }
  function calendarEventCategory(event = {}){
    if (isSalesEvent(event) || isSalesFollowUpEvent(event)) return 'sales';
    if (isProductionEvent(event) || isMaterialEvent(event)) return 'production';
    return 'other';
  }
  function eventIsScheduled(event){
    if (window.PlatformScheduling?.eventIsScheduled) return window.PlatformScheduling.eventIsScheduled(event);
    return clean(event?.status).toLowerCase() !== 'unscheduled' && !!eventStart(event);
  }
  function eventIsLocked(event){
    return window.PlatformScheduling?.eventIsLocked?.(event) === true
      || window.PlatformScheduleView?.eventIsLocked?.(event) === true
      || event?.schedule_locked === true
      || event?.locked === true;
  }
  function materialEventIsOrdered(event = {}){
    if (window.PlatformScheduleView?.materialDeliveryIsOrdered) return window.PlatformScheduleView.materialDeliveryIsOrdered(event);
    const status = clean(event.order_status || event.material_order_status || event.order?.status).toLowerCase();
    return event.ordered === true || event.is_ordered === true || ['ordered','submitted','confirmed','processing','scheduled','delivering','partially_delivered','delivered'].includes(status);
  }
  function materialDeliveryTitle(event = {}){
    const list = event.material_list && typeof event.material_list === 'object' ? event.material_list : {};
    const title = clean(event.material_list_title || event.material_list_name || list.title || list.name || event.title);
    return title.replace(/\s+delivery$/i, '').trim() || 'Materials';
  }
  function materialDeliveryQueueTitle(event = {}){
    return (String(escapeHtml(materialDeliveryTitle(event))) + "<span class=\"dash-appt-kind\">" + (globalThis.PlatformLanguage?.text("scheduling","m_6450c5cf07510a"," — delivery") ?? " — delivery") + "</span>");
  }
  function eventMaterialListId(event = {}){
    return clean(window.PlatformScheduling?.materialListId?.(event)
      || event.material_list_id
      || event.materialListId
      || event.metadata?.material_list_id
      || event.source_ref?.id
      || event.source?.id);
  }
  function materialScheduleAvailable(){
    return allEvents.some(isMaterialEvent)
      || !!clean(materialScheduleEventId)
      || !!clean(pendingScheduleFocus?.material_list_id || pendingScheduleFocus?.materialListId);
  }
  function activeScheduleTypes(){
    const types = [];
    if (showSalesSchedule) types.push('sales');
    if (showProductionSchedule) types.push('production');
    if (showOtherSchedule) types.push('other');
    return types;
  }
  function scheduleTypeActive(type){
    return activeScheduleTypes().includes(type);
  }
  function eventMatchesMode(event){
    return scheduleTypeActive(calendarEventCategory(event));
  }
  function workAssignmentReferencesEvent(event = {}, resourceId = ''){
    const id = clean(resourceId);
    if (!id) return false;
    return [event.id, event.event_id].map(clean).filter(Boolean).includes(id);
  }
  function workCrewId(event = {}){
    const id = clean(event.work_resource_ref?.id || event.assigned_resource_id || event.resource_id || event.assigned_crew_id || event.crew_id);
    return workAssignmentReferencesEvent(event, id) ? '' : id;
  }
  function workCrewName(event = {}){
    const id = clean(event.work_resource_ref?.id || event.assigned_resource_id || event.resource_id || event.assigned_crew_id || event.crew_id);
    if (workAssignmentReferencesEvent(event, id)) return '';
    const name = clean(event.work_resource_ref?.name || event.assigned_resource_name || event.resource_name || event.assigned_crew_name || event.crew_name || event.assigned_crew?.name || event.crew?.name);
    return workAssignmentReferencesEvent(event, name) ? '' : name;
  }
  function normalizeWorkforceResources(result, groupKinds = workforceGroupKinds){
    const resources = Array.isArray(result?.resources) ? result.resources : (Array.isArray(result?.assignable_resources) ? result.assignable_resources : []);
    return resources.map((resource) => {
      const id = clean(resource?.resource_id || resource?.id);
      const name = clean(resource?.name || resource?.work_resource_ref?.name || id);
      const resourceKind = clean(resource?.resource_kind || resource?.work_resource_ref?.kind || resource?.kind);
      const groupKindId = clean(resource?.group_kind_id || resource?.kind_id);
      const groupKind = (Array.isArray(groupKinds) ? groupKinds : []).find((definition) => clean(definition?.id) === groupKindId) || null;
      return {
        ...resource,
        id,
        name,
        subject_type:clean(resource?.subject_type || resourceKind),
        resource_kind:resourceKind,
        work_resource_ref:id ? { kind:resourceKind, id, name } : null,
        group_kind_id:groupKindId,
        group_kind:groupKind,
        group_kind_name:clean(resource?.group_kind_name || groupKind?.name || groupKind?.label),
        group_kind_icon:clean(resource?.group_kind_icon || groupKind?.icon),
        icon:clean(resource?.icon || groupKind?.icon),
        assignment_tag_ids:Array.isArray(resource?.assignment_tag_ids) ? resource.assignment_tag_ids.map(clean).filter(Boolean) : [],
        capability_scope_ids:Array.isArray(resource?.capability_scope_ids) ? resource.capability_scope_ids.map(clean).filter(Boolean) : []
      };
    }).filter((resource) => resource.id && clean(resource.status || 'active') !== 'archived');
  }
  function workforceTerm(kind, form = 'singular'){
    const defaults = {
      resource_group:{ singular:'Crew', plural:'Crews' },
      organization_connection:{ singular:'Subcontractor', plural:'Subcontractors' }
    };
    const configured = workforceTerminology?.[kind] || {};
    const fallback=clean(configured?.[form] || configured?.singular || defaults[kind]?.[form] || defaults[kind]?.singular || 'Team');
    return window.PlatformTerminology?.get?.(`workforce.${kind}_${form}`, fallback) || fallback;
  }
  function workResourceLabel(form = 'singular'){
    return `${workforceTerm('resource_group', form)} / ${workforceTerm('organization_connection', form)}`;
  }
  function productionWorkResources(scopeTemplateId = '', historical = null){
    const normalizedScopeId = clean(scopeTemplateId);
    const Scheduling = window.PlatformScheduling;
    const eventTypeId = clean(historical?.event_type_default_id || historical?.type_id || 'project_work');
    const eventType = schedulingConfig?.event_types?.[eventTypeId] || {};
    const policy = Scheduling?.assignmentPolicyForEventType?.(eventType, eventTypeId) || eventType.assignment_policy || {};
    const people = users.map((user) => Scheduling?.normalizeAssignableSubject?.({
      ...Scheduling.normalizeUser(user),
      subject_type:'organization_user',
      name:clean(user.name || user.email || user.id),
      user
    }) || user);
    const resources = (Scheduling?.filterAssignableSubjects?.([...people, ...workforceResources], policy) || workforceResources).filter((resource) => {
      const ids = Array.isArray(resource.capability_scope_ids) ? resource.capability_scope_ids.map(clean) : [];
      return resource.subject_type === 'organization_user' || !normalizedScopeId || !ids.length || ids.includes(normalizedScopeId);
    });
    const historicalId = currentAssignmentId(historical || {});
    if (historicalId && !resources.some((resource) => clean(resource.id) === historicalId)) {
      const known = [...people, ...workforceResources].find((resource) => clean(resource.id) === historicalId);
      const kind = clean(historical?.work_resource_ref?.kind || historical?.assigned_resource_kind || known?.resource_kind);
      resources.push(known || {
        id:historicalId,
        name:workCrewName(historical || {}) || clean(historical?.assigned_user_name || historical?.assigned_users?.[0]?.name) || userDisplayName(historicalId),
        subject_type:kind || (historical?.assigned_user_id ? 'organization_user' : 'resource_group'),
        resource_kind:kind || (historical?.assigned_user_id ? 'organization_user' : 'resource_group'),
        work_resource_ref:kind === 'organization_user' ? null : { kind, id:historicalId, name:workCrewName(historical || {}) || historicalId },
        capability_scope_ids:[]
      });
    }
    return resources;
  }
  function workResourcePayload(resource = {}){
    const scheduleEvent = !!clean(resource.event_type_default_id || resource.event_type_id || resource.project_id || resource.event_id || resource.start_at || resource.end_at);
    const identityId = scheduleEvent ? '' : resource.id;
    const candidateId = clean(resource.work_resource_ref?.id || resource.assigned_resource_id || resource.resource_id || resource.assigned_crew_id || resource.crew_id || identityId);
    const resourceId = scheduleEvent && workAssignmentReferencesEvent(resource, candidateId) ? '' : candidateId;
    const candidateName = clean(resource.work_resource_ref?.name || resource.assigned_resource_name || resource.resource_name || resource.name || resource.assigned_crew_name || resource.crew_name);
    const resourceName = resourceId && !(scheduleEvent && workAssignmentReferencesEvent(resource, candidateName)) ? candidateName : '';
    const resourceKind = resourceId ? clean(resource.work_resource_ref?.kind || resource.resource_kind || resource.kind || resource.assigned_resource_kind || 'resource_group') : '';
    return {
      crew_id: resourceId,
      crew_name: resourceName,
      resource_id: resourceId,
      resource_name: resourceName,
      work_resource_ref: resourceId ? { kind: resourceKind || 'resource_group', id: resourceId, name: resourceName } : null,
      assigned_resource_kind: resourceKind,
      assigned_resource_id:resourceId,
      assigned_resource_name:resourceName,
      assigned_crew_id: resourceId,
      assigned_crew_name: resourceName,
      assigned_crew: resourceId ? { id: resourceId, name: resourceName } : null
    };
  }
  function assignmentPayloadForSubject(subject = null){
    const type = clean(subject?.subject_type || subject?.resource_kind);
    if (type === 'organization_user') {
      const id = clean(subject?.id);
      const name = clean(subject?.name || subject?.email || id);
      return {
        ...workResourcePayload({}),
        assigned_user_ids:id ? [id] : [],
        assigned_users:id ? [{ id, name, role_ids:subject?.role_ids || subject?.roles || subject?.user?.roles || [] }] : [],
        assigned_user_id:id,
        assigned_user_name:name
      };
    }
    return {
      assigned_user_ids:[],
      assigned_users:[],
      assigned_user_id:'',
      assigned_user_name:'',
      ...workResourcePayload(subject || {})
    };
  }
  function assignmentPayloadForEvent(event = {}){
    const userId = clean(event.assigned_user_id || event.assigned_user_ids?.[0] || event.assigned_users?.[0]?.id);
    const resourceId = workCrewId(event);
    const resourceKind = clean(event.work_resource_ref?.kind || event.assigned_resource_kind || event.resource_kind);
    if (userId && (!resourceId || resourceKind === 'organization_user')) {
      return assignmentPayloadForSubject({
        id:userId,
        name:clean(event.assigned_user_name || event.assigned_users?.[0]?.name || event.assigned_users?.[0]?.email || userId),
        subject_type:'organization_user',
        resource_kind:'organization_user',
        role_ids:event.assigned_users?.[0]?.role_ids || []
      });
    }
    if (resourceId) {
      return assignmentPayloadForSubject({
        id:resourceId,
        name:workCrewName(event) || resourceId,
        subject_type:resourceKind || 'resource_group',
        resource_kind:resourceKind || 'resource_group'
      });
    }
    return userId
      ? assignmentPayloadForSubject({ id:userId, name:clean(event.assigned_user_name || userId), subject_type:'organization_user', resource_kind:'organization_user' })
      : assignmentPayloadForSubject(null);
  }
  function requirementWarningsForEvent(event = {}){
    return window.PlatformScheduling?.eventRequirementWarnings?.(event, {
      equipmentUnits,
      includeEquipment:equipmentSchedulingOn()
    }) || [];
  }
  function decorateWorkEvent(event = {}){
    return {
      ...event,
      requirement_warnings:requirementWarningsForEvent(event),
      project_title: projectTitle(eventProject(event), event),
      project_address: event.project_address || projectAddress(eventProject(event), event),
      assignee_label: workCrewName(event) || assignedLabel(event) || 'Unassigned',
      ...assignmentPayloadForEvent(event)
    };
  }
  function decorateSalesEvent(event = {}){
    const project = eventProject(event);
    const address = event.project_address || projectAddress(project, event);
    // Auto-titled events render from the type's title_template ("{project} —
    // Sales") with the address as the second line; the type is already shown
    // by color, so the chip spends its two lines on customer + address.
    const autoTitle = shouldAutoTitle(event)
      ? clean(window.PlatformScheduling?.autoEventTitle?.(schedulingConfig, event, project))
      : '';
    return {
      ...event,
      requirement_warnings:requirementWarningsForEvent(event),
      ...(autoTitle ? { title: autoTitle } : {}),
      secondary_label: address,
      project_title: projectTitle(project, event),
      project_address: address,
      assignee_label: assignedLabel(event)
    };
  }
  function salesRoutingEvents(){
    const byId = new Map();
    [...allEvents, ...floatingEvents].forEach((event, index) => {
      if (!isSalesEvent(event) || !eventIsScheduled(event)) return;
      const key = clean(event.id || event.event_id) || `sales_routing_${index}`;
      byId.set(key, decorateSalesEvent(event));
    });
    return Array.from(byId.values()).sort((left, right) => {
      return (eventStart(left)?.getTime() ?? Number.MAX_SAFE_INTEGER) - (eventStart(right)?.getTime() ?? Number.MAX_SAFE_INTEGER);
    });
  }
  function decorateMaterialEvent(event = {}){
    const project = eventProject(event);
    const ordered = materialEventIsOrdered(event);
    return {
      ...event,
      kind: 'material_delivery',
      project_title: projectTitle(project, event),
      project_address: event.project_address || projectAddress(project, event),
      assignee_label: '',
      awaiting_crew: false,
      work_resource_ref: null,
      assigned_resource_kind: '',
      assigned_resource_id: '',
      assigned_resource_name: '',
      assigned_crew_id: '',
      assigned_crew_name: '',
      assigned_crew: null,
      crew_id: '',
      crew_name: '',
      resource_id: '',
      resource_name: '',
      icon: event.icon || 'fa-truck-ramp-box',
      category_color: event.category_color || event.material_delivery_color || event.color || '#0f766e',
      material_list_color: event.material_list_color || event.accent_color || event.material_color || event.sub_color || '#f97316',
      ordered
    };
  }
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
  function subjectUnavailabilityMap(){
    const map = schedulingConfig?.scheduling?.unavailability;
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  }
  /* One availability model: an optional weekly default per subject
   * (availability_weekdays: { "<id>": [1,2,3,4,5] }, missing = every day),
   * and per-date toggles (unavailability) that FLIP the default for that day.
   * So a weekday person toggled on a Saturday becomes available, and an
   * every-day person toggled on a Tuesday becomes unavailable. */
  function subjectUnavailableOn(subjectId, dateValue){
    const id = clean(subjectId);
    const date = clean(dateValue);
    if (!id || !date) return false;
    const weekdayMap = schedulingConfig?.scheduling?.availability_weekdays;
    const days = weekdayMap && typeof weekdayMap === 'object' ? weekdayMap[id] : null;
    let base = false;
    if (Array.isArray(days)) {
      const [year, month, day] = date.split('-').map(Number);
      base = !days.map(Number).includes(new Date(year, month - 1, day).getDay());
    }
    const list = subjectUnavailabilityMap()[id];
    const flipped = Array.isArray(list) && list.map(clean).includes(date);
    return flipped ? !base : base;
  }
  function schedulerResourcesForDay(resources, dateValue){
    return (resources || []).map((resource) => ({ ...resource, unavailable: subjectUnavailableOn(resource.id, dateValue) }));
  }
  async function toggleSubjectAvailability(subjectId, dateValue){
    const id = clean(subjectId);
    const date = clean(dateValue);
    if (!id || !date) return;
    const map = { ...subjectUnavailabilityMap() };
    const list = Array.isArray(map[id]) ? map[id].map(clean).filter(Boolean) : [];
    const next = list.includes(date) ? list.filter((entry) => entry !== date) : [...list, date].sort();
    if (next.length) map[id] = next; else delete map[id];
    if (schedulingConfig?.scheduling) schedulingConfig.scheduling.unavailability = map;
    render();
    try {
      await window.PlatformAPI?.branchModules?.patch?.(orgId(), branchId(), 'scheduling', { unavailability: map });
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_6ac7483c379968","Availability update failed") ?? "Availability update failed"), error?.message || 'Could not save the availability change.', false);
      await loadData({ force: true });
    }
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
      return assigned.length ? assigned : [{ id: 'unassigned', label: (globalThis.PlatformLanguage?.text("scheduling","m_8a993ed9b573b4","Unassigned") ?? "Unassigned") }];
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
    return allEvents.some((event) => String(event.project_id) === String(project.id) && eventMatchesMode(event) && eventMatchesBreakdown(event));
  }
  function visibleEvents(){ return allEvents.filter((event) => eventMatchesMode(event) && eventMatchesBreakdown(event)); }
  function visibleProjects(){ return projects.filter(projectMatchesBreakdown); }
  function userDisplayName(userId){
    const id = clean(userId);
    const user = users.find((item) => clean(item.id) === id);
    return clean(user?.name || user?.email) || id;
  }
  function assignedLabel(event){
    if (workCrewId(event)) return workCrewName(event) || clean(event.assigned_resource_name) || workCrewId(event);
    const assigned = Array.isArray(event.assigned_users) ? event.assigned_users : [];
    if (assigned.length) return assigned.map((user) => user.name || user.email || userDisplayName(user.id)).filter(Boolean).join(', ');
    if (clean(event.assigned_user_name)) return clean(event.assigned_user_name);
    const ids = Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : [];
    return ids.length ? ids.map(userDisplayName).join(', ') : 'Assign later';
  }
  function openProjectFromEvent(event){
    const project = eventProject(event);
    if (!project?.id) return;
    if (window.Portal.modules?.request?.openProject) window.Portal.modules.request.openProject(project);
    else window.dispatchEvent(new CustomEvent('fm:projects:open', { detail: { project } }));
  }
  function visibleTitle(){
    if (viewMode === 'appointment_schedule') return window.Portal?.terminology?.get?.('scheduling.routing_view', 'Routing') || 'Routing';
    if (viewMode === 'gantt') return window.Portal?.terminology?.get?.('scheduling.gantt_view', 'Gantt') || 'Gantt';
    if (viewMode === 'day') return anchorDate.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    if (viewMode === 'month') return anchorDate.toLocaleDateString([], { month:'long', year:'numeric' });
    const start = viewMode === '4day' ? startOfDay(anchorDate) : weekStart(anchorDate);
    const end = addDays(start, viewMode === '4day' ? 3 : 6);
    return `${start.toLocaleDateString([], { month:'short', day:'numeric' })} - ${end.toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' })}`;
  }
  function productionStatDefs(){
    return [
      { id: 'production_scheduled', label: (globalThis.PlatformLanguage?.text("scheduling","m_c2e6380e130020","Production") ?? "Production"), icon: 'fa-helmet-safety' },
      { id: 'production_completed', label: (globalThis.PlatformLanguage?.text("scheduling","m_1a818de238a78e","Completed Work") ?? "Completed Work"), icon: 'fa-circle-check' },
      { id: 'projects_completed', label: (globalThis.PlatformLanguage?.text("scheduling","m_8ab24e0cedffa9","Projects Completed") ?? "Projects Completed"), icon: 'fa-flag-checkered' },
    ];
  }
  function projectLifecycle(project = {}){
    const projection = project.work_projection && typeof project.work_projection === 'object' ? project.work_projection : {};
    if (projection.lifecycle && typeof projection.lifecycle === 'object') return projection.lifecycle;
    return (project.lifecycle && typeof project.lifecycle === 'object') ? project.lifecycle : {};
  }
  function projectActiveInstances(project = {}){
    const projection = project.work_projection && typeof project.work_projection === 'object' ? project.work_projection : {};
    if (Array.isArray(projection.active_instances)) return projection.active_instances.filter((instance) => instance && typeof instance === 'object');
    const instances = Array.isArray(projection.instances) ? projection.instances : [];
    return instances.filter((instance) => instance && typeof instance === 'object' && (instance.status === 'active' || instance.status === 'pending'));
  }
  function projectStagePillLabel(project = {}){
    const instances = projectActiveInstances(project);
    const primary = instances.find((instance) => instance.kind === 'pipeline') || instances[0] || null;
    const label = String(primary?.stage_title || primary?.title || '').trim();
    if (label) return label;
    const status = norm(projectLifecycle(project).status);
    if (status === 'lost') return 'Lost';
    if (status === 'completed') return 'Completed';
    if (status === 'canceled' || status === 'cancelled') return 'Cancelled';
    return '';
  }
  function projectCompletedDate(project = {}){
    const direct = projectLifecycle(project).completed_at;
    if (direct) {
      const date = new Date(direct);
      if (Number.isFinite(date.getTime())) return date;
    }
    return null;
  }
  function projectLooksCompleted(project = {}){
    return norm(projectLifecycle(project).status) === 'completed' || !!projectCompletedDate(project);
  }
  function projectSoldDate(project = {}){
    const direct = projectLifecycle(project).sold_at;
    if (direct) {
      const date = new Date(direct);
      if (Number.isFinite(date.getTime())) return date;
    }
    return null;
  }
  function projectLooksSold(project = {}){
    if (projectSoldDate(project)) return true;
    const proposal = project.proposal || project.active_proposal || project.contract || {};
    const statuses = [
      project.signature_status,
      project.proposal_signature_status,
      project.contract_status,
      project.acceptance_status,
      proposal.signature_status,
      proposal.status,
      proposal.acceptance_status
    ].map(norm);
    if (statuses.some((status) => ['signed', 'accepted', 'approved', 'contract_signed', 'sold', 'won'].includes(status))) return true;
    return project.contract_signed === true
      || project.signed_contract === true
      || project.proposal_signed === true
      || project.has_signed_contract === true
      || project.accepted === true;
  }
  function productionStatsFor(start, end, scopedEvents = visibleEvents(), scopedProjects = visibleProjects()){
    const inRangeEvents = scopedEvents.filter((event) => {
      const startAt = eventStart(event);
      return startAt >= start && startAt < end;
    });
    const completedEvents = inRangeEvents.filter((event) => {
      const status = norm(event.status);
      const endAt = eventEnd(event);
      return ['completed', 'complete', 'done', 'ran', 'finished'].includes(status) || (endAt && endAt <= new Date());
    });
    const completedProjects = scopedProjects.filter((project) => {
      if (!projectLooksCompleted(project)) return false;
      const completedAt = projectCompletedDate(project);
      return !completedAt || (completedAt >= start && completedAt < end);
    });
    return {
      production_scheduled: inRangeEvents.length,
      production_completed: completedEvents.length,
      projects_completed: completedProjects.length
    };
  }
  function statDefs(){ return scheduleMode === 'production' ? productionStatDefs() : window.PlatformAPI.dashboard.normalizeConfig(dashboardConfig || {}).stats; }
  function statsFor(start, end, scopedEvents = visibleEvents(), scopedProjects = visibleProjects()){
    if (scheduleMode === 'production') return productionStatsFor(start, end, scopedEvents, scopedProjects);
    return window.PlatformAPI.dashboard.statsForRange({ projects: scopedProjects, events: scopedEvents, start, end });
  }
  function statValueHtml(stat, stats){
    if (scheduleMode === 'production') return escapeHtml(Number(stats[stat.id] || 0).toLocaleString(globalThis.PlatformLanguage?.formatLocale?.()));
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
    if (scheduleMode === 'production') return Number(stats[stat.id] || 0).toLocaleString(globalThis.PlatformLanguage?.formatLocale?.());
    return window.PlatformAPI.dashboard.formatStatValue(stat.id, stats[stat.id]);
  }
  function rangeEvents(start, end, source = allEvents){
    return source.filter((event) => {
      const d = eventStart(event);
      return d >= start && d < end;
    });
  }
  function dimensionRows(start, end){
    const modeEvents = allEvents.filter(eventMatchesMode);
    const baseEvents = rangeEvents(start, end, modeEvents);
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
      const sortValue = scheduleMode === 'production' ? Number(stats.production_scheduled || 0) : Number(stats.appointments?.total || 0);
      return { ...row, stats, sortValue, defs };
    }).filter((row) => row.sortValue > 0).sort((a, b) => b.sortValue - a.sortValue || a.label.localeCompare(b.label));
  }
  function statTipHtml(stat, start, end){
    const rows = dimensionRows(start, end);
    const title = `${stat.label || stat.id} by ${dimensionLabel()}`;
    if (!rows.length) return `<div class="fm-tip-title">${String(escapeHtml(title))}</div><div>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_1a2168116885d3","No data in this range.") ?? "No data in this range.")}</div>`;
    return `
      <div class="fm-tip-title">${escapeHtml(title)}</div>
      ${rows.slice(0, 12).map((row) => `<div class="fm-tip-row"><span class="fm-tip-name">${escapeHtml(row.label)}</span><span class="fm-tip-value">${escapeHtml(statValueText(stat, row.stats))}</span></div>`).join('')}
    `;
  }
  function filterControlsHtml(start, end){
    const rows = dimensionRows(start, end);
    const selected = rows.find((row) => norm(row.id) === norm(breakdownValue));
    const defs = statDefs();
    const modeEvents = allEvents.filter(eventMatchesMode);
    const allStats = statsFor(start, end, modeEvents, projects);
    const modeMeta = FILTER_TYPES[breakdownMode] || FILTER_TYPES.user;
    const rowCells = (label, stats) => `
      <span class="dash-filter-statcell"><span class="dash-filter-name"><i class="fas ${escapeHtml(modeMeta.icon)}"></i>${escapeHtml(label)}</span></span>
      ${defs.map((stat) => `<span class="dash-filter-statcell"><span class="dash-filter-cell">${escapeHtml(statValueText(stat, stats))}</span></span>`).join('')}
    `;
    return `
      <div class="dash-filter-card">
        <div class="dash-mode-wrap">
          <button type="button" class="dash-mode-btn" data-mode-menu-toggle aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_788258bf9e693f","Choose dashboard breakdown") ?? "Choose dashboard breakdown")}"><i class="fas ${String(escapeHtml(modeMeta.icon))}"></i></button>
          ${String(modeMenuOpen ? `<div class="dash-mode-menu">${Object.entries(FILTER_TYPES).map(([id, meta]) => `<button type="button" class="dash-mode-option ${breakdownMode === id ? 'active' : ''}" data-breakdown-mode="${escapeHtml(id)}"><i class="fas ${escapeHtml(meta.icon)}"></i><span>${escapeHtml(meta.label)}</span></button>`).join('')}</div>` : '')}
        </div>
        <div class="dash-value-wrap">
          <button type="button" class="dash-filter-select" data-filter-menu-toggle><span>${String(escapeHtml(selected?.label || allDimensionLabel()))}</span><i class="fas fa-chevron-${String(filterMenuOpen ? 'up' : 'down')}"></i></button>
        </div>
      </div>
      ${String(filterMenuOpen ? `
        <div class="dash-filter-menu">
          <div class="dash-filter-table">
            <button type="button" class="dash-filter-row ${breakdownValue === 'all' ? 'active' : ''}" data-breakdown-value="all">${rowCells(allDimensionLabel(), allStats)}</button>
            ${rows.map((row) => `<button type="button" class="dash-filter-row ${norm(breakdownValue) === norm(row.id) ? 'active' : ''}" data-breakdown-value="${escapeHtml(row.id)}">${rowCells(row.label, row.stats)}</button>`).join('')}
          </div>
        </div>
      ` : '')}
    `;
  }
  function rangeForView(){
    if (viewMode === 'appointment_schedule') return [startOfDay(anchorDate), addDays(anchorDate, 1)];
    if (viewMode === 'month') return [monthStart(anchorDate), monthEnd(anchorDate)];
    if (viewMode === 'day') return [startOfDay(anchorDate), addDays(anchorDate, 1)];
    if (viewMode === '4day') return [startOfDay(anchorDate), addDays(startOfDay(anchorDate), 4)];
    const start = weekStart(anchorDate);
    return [start, addDays(start, 7)];
  }
  function nav(delta){
    if (viewMode === 'month') anchorDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + delta, 1);
    else anchorDate = addDays(anchorDate, viewMode === 'week' ? delta * 7 : (viewMode === '4day' ? delta * 4 : delta));
    if (viewMode === 'appointment_schedule') resetScheduleScrollPersistence();
    appointmentScheduleDraft = null;
    appointmentScheduleEventId = '';
    appointmentScheduleMenuEventId = '';
    syncScheduleRoute({ date:routeDate() }, { history:'replace', source:'scheduling-date', ownedKeys:['date'] });
    render();
  }
  function goToToday(){
    anchorDate = startOfDay(new Date()) || new Date();
    resetScheduleScrollPersistence();
    appointmentScheduleDraft = null;
    appointmentScheduleEventId = '';
    appointmentScheduleMenuEventId = '';
    syncScheduleRoute({ date:routeDate() }, { history:'replace', source:'scheduling-today', ownedKeys:['date'] });
    render();
  }
  function primaryProjectContact(project = {}){
    const manifest = project.manifest && typeof project.manifest === 'object' && !Array.isArray(project.manifest) ? project.manifest : {};
    const contacts = Array.isArray(project.contacts) ? project.contacts : (Array.isArray(manifest.contacts) ? manifest.contacts : []);
    const contact = contacts.find((entry) => entry?.primary)
      || contacts.find((entry) => clean(entry?.name || entry?.email || entry?.phone))
      || {};
    const customer = project.customer && typeof project.customer === 'object' && !Array.isArray(project.customer)
      ? project.customer
      : (manifest.customer && typeof manifest.customer === 'object' && !Array.isArray(manifest.customer) ? manifest.customer : {});
    const resident = project.resident && typeof project.resident === 'object' && !Array.isArray(project.resident)
      ? project.resident
      : (manifest.resident && typeof manifest.resident === 'object' && !Array.isArray(manifest.resident) ? manifest.resident : {});
    return {
      ...contact,
      name:clean(contact.name
        || project.customer_name
        || project.customerName
        || project.primary_contact_name
        || (typeof project.resident === 'string' ? project.resident : '')
        || project.resident_name
        || project.residentName
        || manifest.customer_name
        || manifest.primary_contact_name
        || manifest.resident_name
        || customer.name
        || resident.name),
      email:clean(contact.email || project.customer_email || project.primary_contact_email || customer.email || resident.email),
      phone:clean(contact.phone || project.customer_phone || project.primary_contact_phone || customer.phone || resident.phone)
    };
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
    const manifest = project.manifest && typeof project.manifest === 'object' && !Array.isArray(project.manifest) ? project.manifest : {};
    const address = clean(project.address || project.project_address || project.property_address || project.formatted_address || manifest.address || event.project_address);
    const savedCandidates = [
      project.project_title,
      project.project_name,
      project.projectName,
      project.title,
      project.name,
      manifest.project_title,
      manifest.project_name,
      manifest.title,
      event.project_title
    ];
    const savedTitle = clean(savedCandidates.find((value) => clean(value)
      && norm(value) !== norm(address)
      && !isEventTypeTitle(value, event)));
    const customerName = clean(contact.name || event.customer_name);
    const mode = branchProjectConfig?.title_mode || 'customer_name';
    if (mode === 'manual') return savedTitle || customerName || address || 'Project';
    if (mode === 'address') return address || customerName || savedTitle || 'Project';
    return customerName || address || savedTitle || 'Project';
  }
  function projectAddress(project, event){
    return projectAddressValue(project, event) || 'No address yet';
  }
  function projectAddressValue(project = {}, event = {}){
    return [project.address, project.project_address, project.property_address, project.formatted_address, project.manifest?.address, event.project_address]
      .map(clean)
      .find((value) => value && !/^(?:no|missing|unknown|n\/?a)(?:\s+address)?(?:\s+yet)?$/i.test(value)) || '';
  }
  function missingAddressLabel(){
    return `<span class="dash-missing-address-label"><i class="fas fa-location-dot"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_d2a739fd3d6c7f"," Missing address") ?? " Missing address")}</span>`;
  }
  function appointmentTile(item){
    const project = item.project || eventProject(item.event);
    const event = item.event || {};
    const confirmation = window.PlatformScheduling?.visibleConfirmationState?.(event) || null;
    const confirmClass = confirmation
      ? `${confirmation.awaiting ? 'unconfirmed' : ''} ${confirmation.declined ? 'confirmation-declined' : ''}`
      : '';
    const confirmMarker = confirmation && (confirmation.awaiting || confirmation.declined)
      ? `<i class="fas ${escapeHtml(confirmation.icon)} dash-appt-confirm-marker ${confirmation.declined ? 'bad' : ''}" title="${escapeHtml(confirmation.label)}"></i>`
      : '';
    return `
      <button type="button" class="dash-appt-tile ${confirmClass}" data-event-id="${escapeHtml(event.id)}">
        <div class="dash-appt-title">${confirmMarker}${escapeHtml(projectTitle(project, event))}</div>
        <div class="dash-appt-sales">${escapeHtml(item.salesperson || assignedLabel(event))}</div>
        <div class="dash-appt-address">${escapeHtml(projectAddress(project, event))}</div>
        <div class="dash-stage-pill">${escapeHtml(projectStagePillLabel(project) || 'Stage')}</div>
      </button>
    `;
  }
  function topStatsHtml(){
    if (!SHOW_CALENDAR_STATS) return '';
    const [start, end] = rangeForView();
    const stats = statsFor(start, end);
    const defs = statDefs();
    return `<div class="dash-stats-row" style="--dash-stat-count:${Math.max(1, defs.length)};--dash-filter-cols:${Math.max(2, defs.length + 1)}">${filterControlsHtml(start, end)}<div class="dash-stats">${defs.map((stat) => `
      <div class="dash-stat" data-stat-tip="${escapeHtml(stat.label || stat.id)}" data-stat-id="${escapeHtml(stat.id)}" data-stat-start="${start.toISOString()}" data-stat-end="${end.toISOString()}" tabindex="0">
        <i class="fas ${escapeHtml(stat.icon || 'fa-chart-simple')}"></i>
        <div><small>${escapeHtml(stat.label || stat.id)}</small><strong>${statValueHtml(stat, stats)}</strong></div>
      </div>
    `).join('')}</div></div>`;
  }
  function miniStatsHtml(stats, start, end){
    if (!SHOW_CALENDAR_STAT_SUMMARIES) return '';
    return statDefs().map((stat) => `<div class="dash-mini-stat" data-stat-tip="${escapeHtml(stat.label || stat.id)}" data-stat-id="${escapeHtml(stat.id)}" data-stat-start="${start.toISOString()}" data-stat-end="${end.toISOString()}" tabindex="0"><i class="fas ${escapeHtml(stat.icon || 'fa-chart-simple')}"></i><span>${statValueHtml(stat, stats)}</span></div>`).join('');
  }
  function dayStatsHtml(day){
    if (!SHOW_CALENDAR_STAT_SUMMARIES) return '';
    const start = startOfDay(day);
    const end = addDays(day, 1);
    const stats = statsFor(start, end);
    return `<div class="dash-day-stats">${statDefs().map((stat) => `<div class="dash-day-stat" data-stat-tip="${escapeHtml(stat.label || stat.id)}" data-stat-id="${escapeHtml(stat.id)}" data-stat-start="${start.toISOString()}" data-stat-end="${end.toISOString()}" tabindex="0"><span>${escapeHtml(stat.label || stat.id)}</span><b>${statValueHtml(stat, stats)}</b></div>`).join('')}</div>`;
  }
  function compactDayEventsHtml(day, limit = 3){
    const dayEvents = events.filter((event) => sameDay(eventStart(event), day)).sort((a, b) => eventStart(a) - eventStart(b));
    const visible = dayEvents.slice(0, limit);
    const more = dayEvents.length - visible.length;
    return `<div class="dash-day-events">${visible.map((event) => `<div class="dash-month-event" data-event-id="${escapeHtml(event.id)}">${escapeHtml(fmtTime(eventStart(event)))} ${escapeHtml(projectTitle(eventProject(event), event))}</div>`).join('')}${more > 0 ? `<div class="dash-month-more">+${more}</div>` : ''}</div>`;
  }
  function headerStatsHtml(day){
    if (!SHOW_CALENDAR_STAT_SUMMARIES) return '';
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
    let html = `<div class="dash-card"><div class="dash-month ${SHOW_CALENDAR_STAT_SUMMARIES ? '' : 'no-stats'}">${SHOW_CALENDAR_STAT_SUMMARIES ? '<div class="dash-week-stat-head"></div>' : ''}${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day) => `<div class="dash-month-head">${day}</div>`).join('')}`;
    weeks.forEach((weekDays) => {
      if (SHOW_CALENDAR_STAT_SUMMARIES) {
        const weekEnd = addDays(weekDays[0], 7);
        const weekStats = statsFor(weekDays[0], weekEnd);
        html += `<div class="dash-week-stat">${miniStatsHtml(weekStats, weekDays[0], weekEnd)}</div>`;
      }
      weekDays.forEach((day) => {
        const active = day.getMonth() === anchorDate.getMonth();
        const future = startOfDay(day) > startOfDay(new Date());
        const count = dayAppointmentCount(day);
        html += `<div class="dash-month-day ${active ? '' : 'muted'}" ${active ? `data-day="${day.toISOString()}"` : ''}>
          <div class="dash-month-num">${day.getDate()}</div>
          ${active && calendarDisplayMode === 'events' ? compactDayEventsHtml(day, 4) : ''}
          ${active && calendarDisplayMode === 'summary' && !future ? dayStatsHtml(day) : ''}
          ${active && calendarDisplayMode === 'summary' && future && count ? `<div class="dash-future-count">${scheduleMode === 'production' ? 'work' : 'appointments'} ${count}</div>` : ''}
        </div>`;
      });
    });
    return `${html}</div></div>`;
  }
  function renderWeek(){
    const dayCount = viewMode === '4day' ? 4 : 7;
    const start = viewMode === '4day' ? startOfDay(anchorDate) : weekStart(anchorDate);
    const days = Array.from({ length: dayCount }, (_, i) => addDays(start, i));
    const hours = Array.from({ length: 11 }, (_, i) => i + 8);
    const layouts = new Map(days.map((day) => [day.toDateString(), weekEventLayout(day, hours)]));
    let html = `<div class="dash-card"><div class="dash-week" style="grid-template-columns:58px repeat(${dayCount},minmax(82px,1fr))"><div class="dash-time-head"></div>`;
    html += days.map((day) => `<div class="dash-week-head"><div class="dash-day-head"><div class="dash-day-head-title">${escapeHtml(day.toLocaleDateString([], { weekday:'short' }))} - ${escapeHtml(day.toLocaleDateString([], { month:'short', day:'numeric' }))}</div>${calendarDisplayMode === 'summary' ? headerStatsHtml(day) : compactDayEventsHtml(day, 2)}</div></div>`).join('');
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
    if (!dayEvents.length) return `<div class="dash-empty">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_42c2c08b6a9c94","No events scheduled for this day.") ?? "No events scheduled for this day.")}</div>`;
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
  function unscheduledProductionProjects(){
    const projectIdsWithWork = new Set(allEvents.filter((event) => isProductionEvent(event) || isMaterialEvent(event)).map((event) => String(event.project_id || '')).filter(Boolean));
    return visibleProjects()
      .filter(projectLooksSold)
      .filter((project) => !projectIdsWithWork.has(String(project.id || '')))
      .sort((a, b) => projectTitle(a).localeCompare(projectTitle(b)));
  }
  function unscheduledEvents(predicate){
    return allEvents
      .filter(predicate)
      .filter(eventMatchesBreakdown)
      .filter((event) => !eventIsScheduled(event))
      .filter((event) => !['cancelled','canceled'].includes(clean(event.status).toLowerCase()))
      .sort((a, b) => clean(a.title).localeCompare(clean(b.title)) || projectTitle(eventProject(a), a).localeCompare(projectTitle(eventProject(b), b)));
  }
  function scheduleBundleDescriptor(event = {}){
    const project = eventProject(event);
    return window.PlatformScheduling?.scheduleBundleDescriptor?.(event, project, scopeTemplates) || {
      key:`${event.project_id || project?.id || ''}:${event.scope_piece_id || event.work_plan_id || event.id || ''}`,
      role:isProductionEvent(event) ? 'primary' : 'dependent',
      item_key:event.id || '',
      rule:{}
    };
  }
  function scheduleBundleGroups(rows = []){
    const groups = new Map();
    rows.forEach((event) => {
      const descriptor = scheduleBundleDescriptor(event);
      const key = descriptor.key || String(event.id || '');
      const group = groups.get(key) || { key, events:[], primary:null, project:eventProject(event) };
      group.events.push(event);
      if (!group.primary || descriptor.role === 'primary' || (isProductionEvent(event) && !isProductionEvent(group.primary))) group.primary = event;
      groups.set(key, group);
    });
    return [...groups.values()].map((group) => ({
      ...group,
      primary:group.primary || group.events[0],
      dependents:group.events.filter((event) => String(event.id || '') !== String((group.primary || group.events[0])?.id || ''))
    })).sort((a, b) => projectTitle(a.project, a.primary).localeCompare(projectTitle(b.project, b.primary)));
  }
  function selectedProductionBundle(){
    if (!productionScheduleBundleKey) return null;
    return scheduleBundleGroups(unscheduledEvents((event) => isProductionEvent(event) || isMaterialEvent(event)))
      .find((group) => group.key === productionScheduleBundleKey) || null;
  }
  function scheduleBundleDrafts(primaryDraft = productionScheduleDraft){
    const bundle = selectedProductionBundle();
    const primary = bundle?.primary || selectedProductionEvent();
    const project = bundle?.project || selectedProductionProject() || eventProject(primary || {});
    if (!primary || !primaryDraft?.start || !window.PlatformScheduling?.interpretScheduleBundle) return primaryDraft?.start ? [primaryDraft] : [];
    return window.PlatformScheduling.interpretScheduleBundle(primary, bundle?.events || [primary], primaryDraft.start, project, scopeTemplates)
      .map((draft) => ({
        ...draft,
        project_title:projectTitle(project, draft),
        project_address:projectAddress(project, draft),
        assignee_label:isMaterialEvent(draft) ? '' : (workCrewName(primaryDraft) || workCrewName(draft) || 'Unassigned'),
        ...(!isMaterialEvent(draft) ? workResourcePayload(primaryDraft) : {})
      }));
  }
  function scheduleAppointmentItems(){
    return allEvents
      .filter(isSalesEvent)
      .filter(eventMatchesBreakdown)
      .filter((event) => !['cancelled','canceled'].includes(clean(event.status).toLowerCase()))
      .map((event) => ({ event, project: eventProject(event), salesperson: assignedLabel(event), assigned: !!currentAssignmentId(event), scheduled: eventIsScheduled(event) }))
      .filter((item) => !item.scheduled || !item.assigned)
      .sort((a, b) => (eventStart(a.event)?.getTime() ?? Number.MAX_SAFE_INTEGER) - (eventStart(b.event)?.getTime() ?? Number.MAX_SAFE_INTEGER));
  }
  function renderScheduleGroups(){
    const items = scheduleAppointmentItems();
    const tile = (item) => {
      const project = item.project || {};
      const selected = String(item.event.id || '') === String(appointmentScheduleEventId || '');
      const missingAddress = !projectAddressValue(project, item.event);
      return `<button type="button" class="dash-appt-tile unscheduled ${missingAddress ? 'missing-address' : ''} ${selected ? 'selected' : ''}" data-schedule-event-id="${escapeHtml(item.event.id || '')}" data-schedule-project-id="${escapeHtml(project.id || '')}">
        <div class="dash-appt-title">${escapeHtml(projectTitle(project, item.event))}</div>
        <div class="dash-appt-sales">${item.scheduled ? escapeHtml(fmtDayTime(eventStart(item.event))) : 'Choose a date and time'}</div>
        <div class="dash-appt-address">${missingAddress ? missingAddressLabel() : escapeHtml(projectAddress(project, item.event))}</div>
        <div class="dash-stage-pill">${item.scheduled ? 'Unassigned' : 'Unscheduled'}</div>
      </button>`;
    };
    const group = (label, rows) => `<div class="dash-group ${rows.length ? '' : 'empty'}">
      <div class="dash-group-head" style="cursor:default"><strong>${escapeHtml(label)}</strong><span>${rows.length}</span></div>
      <div class="dash-group-body">${rows.length ? rows.map(tile).join('') : `<div class="dash-empty" style="padding:16px;">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_9edea1c187a128","No unscheduled sales appointments.") ?? "No unscheduled sales appointments.")}</div>`}</div>
    </div>`;
    return group('Sales', items);
  }
  function renderProductionScheduleGroups(){
    const canonical = unscheduledEvents(isProductionEvent);
    const materials = unscheduledEvents(isMaterialEvent);
    const inferred = unscheduledProductionProjects();
    const eventGroups = scheduleBundleGroups([...canonical, ...materials]);
    const eventTile = (event) => {
      const project = eventProject(event);
      const missingAddress = !projectAddressValue(project, event);
      return `<button type="button" class="dash-appt-tile project-only unscheduled ${String(missingAddress ? 'missing-address' : '')}" data-production-project-id="${String(escapeHtml(project.id || event.project_id || ''))}" data-production-event-id="${String(escapeHtml(event.id || ''))}">
        <div class="dash-appt-title">${String(escapeHtml(event.title || projectTitle(project, event)))}</div>
        <div class="dash-stage-pill">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_c84286da8f58e9","Waiting") ?? "Waiting")}</div>
        <div class="dash-appt-address">${String(escapeHtml(projectTitle(project, event)))}${String(missingAddress ? ` ${missingAddressLabel()}` : '')}</div>
      </button>`;
    };
    const eventPile = (group) => {
      const primary = group.primary;
      const project = group.project || eventProject(primary);
      const selected = group.key === productionScheduleBundleKey || String(primary.id || '') === String(productionScheduleEventId || '');
      const missingAddress = !projectAddressValue(project, primary);
      const childSelected = group.dependents.some((event) => String(event.id || '') === String(materialScheduleEventId || ''));
      const expanded = expandedProductionBundles.has(group.key) || childSelected;
      const deliveryCount = group.dependents.filter(isMaterialEvent).length;
      const dependentLabel = deliveryCount === group.dependents.length
        ? `${deliveryCount} ${deliveryCount === 1 ? 'delivery' : 'deliveries'}`
        : `${group.dependents.length} related item${group.dependents.length === 1 ? '' : 's'}`;
      const cancel = selected ? `<span class="dash-bundle-cancel" data-production-bundle-cancel="${String(escapeHtml(group.key))}" role="button" tabindex="0" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3714e2e80f69ac","Cancel placement") ?? "Cancel placement")}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3714e2e80f69ac","Cancel placement") ?? "Cancel placement")}"><i class="fas fa-xmark"></i></span>` : `<div class="dash-stage-pill">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_c84286da8f58e9","Waiting") ?? "Waiting")}</div>`;
      return `<div class="dash-schedule-pile ${selected ? 'selected' : ''}" data-production-bundle="${escapeHtml(group.key)}">
        <button type="button" class="dash-appt-tile project-only unscheduled ${missingAddress ? 'missing-address' : ''} ${selected ? 'selected' : ''}" data-production-bundle-primary="${escapeHtml(group.key)}" data-production-project-id="${escapeHtml(project.id || primary.project_id || '')}" data-production-event-id="${escapeHtml(primary.id || '')}">
          <div class="dash-appt-title">${escapeHtml(primary.title || projectTitle(project, primary))}</div>
          ${cancel}
          <div class="dash-appt-address">${escapeHtml(projectTitle(project, primary))}${missingAddress ? ` ${missingAddressLabel()}` : ''}</div>
        </button>
        ${group.dependents.length ? `<button type="button" class="dash-bundle-summary" data-production-bundle-toggle="${escapeHtml(group.key)}" aria-expanded="${expanded ? 'true' : 'false'}"><i class="fas fa-chevron-${expanded ? 'up' : 'down'}"></i><span>${expanded ? 'Hide' : 'Show'} ${escapeHtml(dependentLabel)}</span></button>` : ''}
        ${group.dependents.length && expanded ? `<div class="dash-bundle-items">${group.dependents.map((event) => {
          const childSelected = String(event.id || '') === String(materialScheduleEventId || '');
          return `<button type="button" class="dash-bundle-item ${childSelected ? 'selected' : ''}" data-production-bundle-child="${escapeHtml(event.id || '')}" data-material-project-id="${escapeHtml(project.id || event.project_id || '')}" data-material-event-id="${escapeHtml(event.id || '')}"><i class="fas ${isMaterialEvent(event) ? 'fa-truck-ramp-box' : 'fa-calendar-day'}"></i><span>${isMaterialEvent(event) ? (String(escapeHtml(materialDeliveryTitle(event))) + "<span class=\"dash-appt-kind\">" + (globalThis.PlatformLanguage?.htmlText("scheduling","m_658f2deb4256b0"," &mdash; delivery") ?? " &mdash; delivery") + "</span>") : escapeHtml(event.title || (globalThis.PlatformLanguage?.text("scheduling","m_d0a9ffb325f8e6","Schedule item") ?? "Schedule item"))}</span>${childSelected ? `<span class="dash-bundle-child-cancel" data-bundle-child-cancel role="button" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3714e2e80f69ac","Cancel placement") ?? "Cancel placement")}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3714e2e80f69ac","Cancel placement") ?? "Cancel placement")}"><i class="fas fa-xmark"></i></span>` : ''}</button>`;
        }).join('')}</div>` : ''}
      </div>`;
    };
    const unscheduledTile = (project) => {
      const selected = String(project.id || '') === String(productionScheduleProjectId || '') && !productionScheduleEventId;
      const missingAddress = !projectAddressValue(project, {});
      return `<button type="button" class="dash-appt-tile project-only unscheduled ${String(missingAddress ? 'missing-address' : '')} ${String(selected ? 'selected' : '')}" data-production-project-id="${String(escapeHtml(project.id || ''))}">
        <div class="dash-appt-title">${String(escapeHtml(projectTitle(project)))}</div>
        <div class="dash-stage-pill">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2b7432531aba4c","Unscheduled") ?? "Unscheduled")}</div>
        <div class="dash-appt-address">${String(missingAddress ? missingAddressLabel() : escapeHtml(projectAddress(project, {})))}</div>
      </button>`;
    };
    const materialTile = (event) => {
      const project = eventProject(event);
      const selected = String(event.id || '') === String(materialScheduleEventId || '');
      const ordered = materialEventIsOrdered(event);
      const color = clean(event.material_list_color || event.accent_color || event.material_color || event.sub_color || '#f97316');
      const missingAddress = !projectAddressValue(project, event);
      return `<button type="button" class="dash-appt-tile project-only unscheduled material ${String(missingAddress ? 'missing-address' : '')} ${String(ordered ? 'ordered' : 'unordered')} ${String(selected ? 'selected' : '')}" data-material-project-id="${String(escapeHtml(project.id || event.project_id || ''))}" data-material-event-id="${String(escapeHtml(event.id || ''))}" style="--material-list-color:${String(escapeHtml(color))}">
        <div class="dash-appt-title"><i class="fas fa-truck-ramp-box" style="color:${String(escapeHtml(color))};margin-right:6px"></i>${String(materialDeliveryQueueTitle(event))}</div>
        <div class="dash-stage-pill">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_c84286da8f58e9","Waiting") ?? "Waiting")}</div>
        <div class="dash-appt-address">${String(escapeHtml(projectTitle(project, event)))}${String(missingAddress ? ` ${missingAddressLabel()}` : '')}</div>
      </button>`;
    };
    const rows = [...eventGroups.map((group) => ({ kind:'bundle', value:group })), ...inferred.map((project) => ({ kind:'project', value:project }))];
    const group = (label, items) => `<div class="dash-group ${items.length ? '' : 'empty'}">
      <div class="dash-group-head" style="cursor:default"><strong>${escapeHtml(label)}</strong><span>${items.length}</span></div>
      <div class="dash-group-body">${items.length ? items.map((item) => item.kind === 'bundle' ? eventPile(item.value) : unscheduledTile(item.value)).join('') : `<div class="dash-empty" style="padding:16px;">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_75626addb77eff","No unscheduled production projects.") ?? "No unscheduled production projects.")}</div>`}</div>
    </div>`;
    return group('Production', rows);
  }
  function renderMaterialScheduleGroups(){
    const rows = unscheduledEvents(isMaterialEvent);
    const tile = (event) => {
      const project = eventProject(event);
      const selected = String(event.id || '') === String(materialScheduleEventId || '');
      const ordered = materialEventIsOrdered(event);
      const color = clean(event.material_list_color || event.accent_color || event.material_color || event.sub_color || '#f97316');
      return `<button type="button" class="dash-appt-tile project-only unscheduled material ${ordered ? 'ordered' : 'unordered'} ${selected ? 'selected' : ''}" data-material-project-id="${escapeHtml(project.id || event.project_id || '')}" data-material-event-id="${escapeHtml(event.id || '')}" style="--material-list-color:${escapeHtml(color)}">
        <div class="dash-appt-title"><i class="fas fa-truck-ramp-box" style="color:${escapeHtml(color)};margin-right:6px"></i>${materialDeliveryQueueTitle(event)}</div>
        <div class="dash-stage-pill">${ordered ? 'Ordered' : 'Not ordered'}</div>
        <div class="dash-appt-address">${escapeHtml(projectAddress(project, event))}</div>
      </button>`;
    };
    return `<div class="dash-group">
      <div class="dash-group-head" style="cursor:default"><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_b8dfba90769476","Material deliveries") ?? "Material deliveries")}</strong><span>${String(rows.length)}</span></div>
      <div class="dash-group-body">${String(rows.length ? rows.map(tile).join('') : `<div class="dash-empty" style="padding:16px;">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_85c85d8d0ddcb3","No material deliveries waiting to be scheduled.") ?? "No material deliveries waiting to be scheduled.")}</div>`)}</div>
    </div>`;
  }
  function selectedScheduleProject(){
    const visible = visibleProjects().find((project) => String(project.id) === String(appointmentScheduleProjectId));
    if (visible) return visible;
    const event = selectedScheduleEvent();
    const project = event ? eventProject(event) : null;
    return project?.id ? project : null;
  }
  function selectedScheduleEvent(){
    return allEvents.find((event) => String(event.id || '') === String(appointmentScheduleEventId || '')) || null;
  }
  function selectedProductionProject(){
    const visible = visibleProjects().find((project) => String(project.id) === String(productionScheduleProjectId));
    if (visible) return visible;
    const event = selectedProductionEvent();
    const project = event ? eventProject(event) : null;
    return project?.id ? project : null;
  }
  function selectedProductionEvent(){
    return allEvents.find((event) => String(event.id || '') === String(productionScheduleEventId || '')) || null;
  }
  function selectedMaterialProject(){
    const visible = visibleProjects().find((project) => String(project.id) === String(materialScheduleProjectId));
    if (visible) return visible;
    const event = selectedMaterialEvent();
    const project = event ? eventProject(event) : null;
    return project?.id ? project : null;
  }
  function selectedMaterialEvent(){
    return allEvents.find((event) => String(event.id || '') === String(materialScheduleEventId || '')) || null;
  }
  function selectedPlacementKind(){
    if (selectedMaterialEvent()) return 'materials';
    if (selectedProductionEvent() || selectedProductionProject()) return 'production';
    if (selectedScheduleEvent()) return 'sales';
    return '';
  }
  function clonePlacementValue(value){
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(clonePlacementValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clonePlacementValue(entry)]));
    return value;
  }
  function placementStateSnapshot(){
    return clonePlacementValue({
      appointmentScheduleDraft,
      appointmentScheduleProjectId,
      appointmentScheduleEventId,
      productionScheduleDraft,
      productionScheduleBundleKey,
      productionScheduleBundleDrafts,
      productionScheduleProjectId,
      productionScheduleEventId,
      materialScheduleDraft,
      materialScheduleProjectId,
      materialScheduleEventId
    });
  }
  function placementStateKey(state = {}){
    return JSON.stringify(state, (_key, value) => value instanceof Date ? value.toISOString() : value);
  }
  function recordPlacementHistory(){
    if (placementHistoryApplying || viewMode !== 'appointment_schedule') return;
    const snapshot = placementStateSnapshot();
    if (placementStateKey(placementUndoStack[placementUndoStack.length - 1]) === placementStateKey(snapshot)) return;
    placementUndoStack.push(snapshot);
    if (placementUndoStack.length > 50) placementUndoStack.shift();
    placementRedoStack.length = 0;
  }
  function applyPlacementHistory(state){
    if (!state) return;
    placementHistoryApplying = true;
    appointmentScheduleDraft = clonePlacementValue(state.appointmentScheduleDraft);
    appointmentScheduleProjectId = state.appointmentScheduleProjectId || '';
    appointmentScheduleEventId = state.appointmentScheduleEventId || '';
    productionScheduleDraft = clonePlacementValue(state.productionScheduleDraft);
    productionScheduleBundleKey = state.productionScheduleBundleKey || '';
    productionScheduleBundleDrafts = clonePlacementValue(state.productionScheduleBundleDrafts || []);
    productionScheduleProjectId = state.productionScheduleProjectId || '';
    productionScheduleEventId = state.productionScheduleEventId || '';
    materialScheduleDraft = clonePlacementValue(state.materialScheduleDraft);
    materialScheduleProjectId = state.materialScheduleProjectId || '';
    materialScheduleEventId = state.materialScheduleEventId || '';
    render();
    placementHistoryApplying = false;
  }
  function undoPlacement(){
    const previous = placementUndoStack.pop();
    if (!previous) return;
    placementRedoStack.push(placementStateSnapshot());
    applyPlacementHistory(previous);
  }
  function redoPlacement(){
    const next = placementRedoStack.pop();
    if (!next) return;
    placementUndoStack.push(placementStateSnapshot());
    applyPlacementHistory(next);
  }
  function clearPlacementSelection(){
    appointmentScheduleDraft = null;
    appointmentScheduleProjectId = '';
    appointmentScheduleEventId = '';
    appointmentScheduleMenuEventId = '';
    productionScheduleDraft = null;
    productionScheduleBundleKey = '';
    productionScheduleBundleDrafts = [];
    productionScheduleProjectId = '';
    productionScheduleEventId = '';
    materialScheduleDraft = null;
    materialScheduleProjectId = '';
    materialScheduleEventId = '';
  }
  function renderSchedulingRail(){
    const chunks = [];
    if (scheduleTypeActive('sales')) chunks.push(renderScheduleGroups());
    if (scheduleTypeActive('production')) chunks.push(renderProductionScheduleGroups());
    if (scheduleTypeActive('production') && productionVehiclesVisible && equipmentSchedulingOn()) chunks.push(renderVehicleBank());
    return `<div class="dash-groups"><div class="dash-rail-title">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_428e8510d14f87","Waiting to be scheduled") ?? "Waiting to be scheduled")}</div>${String(chunks.join(''))}</div>`;
  }
  function renderVehicleBank(){
    const units = equipmentUnits.filter((unit) => !['down', 'retired'].includes(clean(unit.status).toLowerCase()));
    return `<div class="dash-vehicle-bank"><div class="dash-vehicle-bank-title">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_fc1b55cfc4dfbc","Vehicles") ?? "Vehicles")}</div><div class="dash-vehicle-bank-items">${String(units.map((unit) => `<button type="button" class="dash-vehicle-bank-item ${clean(unit.id) === vehiclePlacementUnitId ? 'active' : ''}" data-vehicle-bank-unit="${escapeHtml(unit.id)}"><i class="fas ${escapeHtml(clean(unit.icon) || 'fa-truck-pickup')}"></i><span>${escapeHtml(unit.name || unit.id)}${unit.type_name ? `<small>${escapeHtml(unit.type_name)}</small>` : ''}</span></button>`).join('') || `<span class="dash-event-equipment-empty">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_788928fd084fda","No available vehicles.") ?? "No available vehicles.")}</span>`)}</div></div>`;
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
  function scheduleScrollNodes(){
    return Array.from(rootEl?.querySelectorAll([
      '#dashScheduleView .psv-scroll',
      '#dashScheduleView .prs-resource-scroll',
      '#dashScheduleViewSales .psv-scroll',
      '#dashScheduleViewSales .prs-resource-scroll',
      '#dashScheduleViewProduction .psv-scroll',
      '#dashScheduleViewProduction .prs-resource-scroll',
      '#dashScheduleViewMaterials .psv-scroll',
      '#dashScheduleViewMaterials .prs-resource-scroll'
    ].join(',')) || []);
  }
  function scheduleScrollKey(scroll){
    const host = scroll?.closest?.('.dash-schedule-view');
    const hostId = host?.id || 'dashScheduleView';
    const kind = scroll?.classList?.contains('prs-resource-scroll') ? 'resource' : 'slot';
    return `${hostId}:${kind}`;
  }
  function captureScheduleScroll(){
    scheduleScrollNodes().forEach((scroll) => {
      const key = scheduleScrollKey(scroll);
      scheduleScrollPositions[key] = {
        left: scroll.scrollLeft || 0,
        top: scroll.scrollTop || 0
      };
      appointmentScheduleScrollLeft = scroll.scrollLeft || 0;
      appointmentScheduleScrollTop = scroll.scrollTop || 0;
    });
  }
  function restoreScheduleScroll(){
    scheduleScrollNodes().forEach((scroll) => {
      const saved = scheduleScrollPositions[scheduleScrollKey(scroll)] || null;
      if (saved) {
        scroll.scrollLeft = saved.left || 0;
        scroll.scrollTop = saved.top || 0;
        return;
      }
      if (scroll.classList?.contains('prs-resource-scroll')) return;
      if (Number.isFinite(appointmentScheduleScrollLeft)) scroll.scrollLeft = appointmentScheduleScrollLeft || 0;
      if (Number.isFinite(appointmentScheduleScrollTop)) scroll.scrollTop = appointmentScheduleScrollTop || 0;
    });
  }
  function resetScheduleScrollPersistence(){
    scheduleScrollPositions = {};
    appointmentScheduleScrollLeft = null;
    appointmentScheduleScrollTop = null;
    scheduleScrollResetPending = true;
  }
  function bindScheduleScrollPersistence(){
    restoreScheduleScroll();
    scheduleScrollNodes().forEach((scroll) => {
      if (scroll.dataset.dashScrollBound === '1') return;
      scroll.dataset.dashScrollBound = '1';
      scroll.addEventListener('scroll', captureScheduleScroll, { passive: true });
    });
  }
  function renderScheduleLibraryViewPreserveScroll(){
    captureScheduleScroll();
    renderScheduleLibraryView();
  }
  /* Re-render whichever scheduling surface is on screen. Event saves happen
   * from the calendar views AND the routing view; refreshing only the
   * calendar mount leaves routing rows with stale lanes and travel bars. */
  function refreshActiveScheduleSurface(){
    if (viewMode === 'appointment_schedule') renderScheduleLibraryViewPreserveScroll();
    else renderEventCalendarView();
  }
  function eventCalendarMode(){
    return ['day','4day','week','month'].includes(viewMode) ? viewMode : 'week';
  }
  function eventTypeMeta(typeId = ''){
    const id = clean(typeId);
    if (id === 'sales_appointment') return { id, label: (globalThis.PlatformLanguage?.text("scheduling","m_f7eaf8f28f8161","Sales appointment") ?? "Sales appointment"), title: (globalThis.PlatformLanguage?.text("scheduling","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment") };
    if (id === 'sales_follow_up') return { id, label: (globalThis.PlatformLanguage?.text("scheduling","m_7369721d2af9d8","Sales follow-up") ?? "Sales follow-up"), title: (globalThis.PlatformLanguage?.text("scheduling","m_0d91fb6ec435fc","Sales Follow-up") ?? "Sales Follow-up") };
    if (id === 'project_work') return { id, label: (globalThis.PlatformLanguage?.text("scheduling","m_222066ef57ae0e","Work") ?? "Work"), title: (globalThis.PlatformLanguage?.text("scheduling","m_222066ef57ae0e","Work") ?? "Work") };
    if (id === 'delivery' || id === 'material_delivery' || id.startsWith('material_delivery_')) return { id, label: (globalThis.PlatformLanguage?.text("scheduling","m_c12b1c3407d059","Material delivery") ?? "Material delivery"), title: (globalThis.PlatformLanguage?.text("scheduling","m_e1abe67a7e3ecb","Material Delivery") ?? "Material Delivery") };
    return { id: '', label: (globalThis.PlatformLanguage?.text("scheduling","m_4960a2c95a5672","Untyped") ?? "Untyped"), title: (globalThis.PlatformLanguage?.text("scheduling","m_90c93de8e3e9de","Untyped Event") ?? "Untyped Event") };
  }
  function defaultEventTitles(){
    return new Set(['New Event', 'Untyped Event', 'Sales Appointment', 'Sales Follow-up', 'Work', 'Project', 'Delivery', 'Material Delivery']);
  }
  function shouldAutoTitle(event = {}){
    if (event.title_is_custom === true) return false;
    const title = clean(event.title);
    const currentTypeDefault = eventTypeMeta(eventTypeId(event)).title;
    if (!title || title === currentTypeDefault || defaultEventTitles().has(title)) return true;
    // A title that matches the type's template output is still an auto title,
    // so it keeps tracking the project if the project is renamed.
    const templated = clean(window.PlatformScheduling?.autoEventTitle?.(schedulingConfig, event, eventProject(event)));
    return !!templated && title === templated;
  }
  function floatingEventId(){
    return `floating_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
  function floatingAssigneeLabel(event = {}){
    if (isProductionEvent(event)) return workCrewName(event) || 'Unassigned';
    if (isSalesEvent(event)) {
      const label = assignedLabel(event);
      return label === 'Assign later' ? 'Unassigned' : label;
    }
    return clean(event.assignee_label || '');
  }
  function decorateFloatingEvent(event = {}){
    const meta = eventTypeMeta(eventTypeId(event));
    return {
      ...event,
      requirement_warnings:requirementWarningsForEvent(event),
      id: event.id || floatingEventId(),
      title: event.title || meta.title,
      project_title: event.project_id ? projectTitle(eventProject(event), event) : '',
      project_address: event.project_address || '',
      assignee_label: floatingAssigneeLabel(event),
      floating_event: true,
      status: event.status || 'draft',
      customer_visible: event.customer_visible === true,
      customer_show_title: event.customer_show_title !== false,
      customer_show_crew: event.customer_show_crew === true,
      customer_description: clean(event.customer_description),
    };
  }
  function eventCalendarItems(){
    return [
      ...events.filter(eventIsScheduled).map((event) => isProductionEvent(event)
        ? decorateWorkEvent(event)
        : isMaterialEvent(event)
          ? decorateMaterialEvent(event)
          : decorateSalesEvent(event)),
      ...floatingEvents.filter((event) => !isVehicleBooking(event)).filter(eventMatchesMode).filter(eventMatchesBreakdown).map(decorateFloatingEvent)
    ];
  }
  function updateFloatingEvent(next = {}){
    const id = String(next.id || eventDraftPopoverId || floatingEventId());
    const existing = floatingEvents.find((item) => String(item.id || '') === id) || {};
    const merged = { ...existing, ...next, id };
    const start = new Date(merged.start || merged.start_at || Date.now());
    const previousStart = new Date(existing.start || existing.start_at || start);
    const previousEnd = new Date(existing.end || existing.end_at || previousStart.getTime() + 60 * 60000);
    const previousDuration = previousEnd > previousStart ? previousEnd.getTime() - previousStart.getTime() : 60 * 60000;
    const end = new Date(merged.end || merged.end_at || start.getTime() + previousDuration);
    const safeEnd = end > start ? end : new Date(start.getTime() + Math.max(15 * 60000, previousDuration || 60 * 60000));
    const hasExplicitStatus = Object.prototype.hasOwnProperty.call(next, 'status');
    const event = decorateFloatingEvent({
      ...merged,
      id,
      start,
      end: safeEnd,
      start_at: start.toISOString(),
      end_at: safeEnd.toISOString(),
      duration_minutes: Math.max(1, Math.round((safeEnd.getTime() - start.getTime()) / 60000)),
      all_day: merged.all_day === true,
      schedule_granularity: merged.schedule_granularity || (merged.all_day === true ? 'date' : 'time'),
      status: hasExplicitStatus ? clean(next.status || 'draft') : clean(existing.status || merged.status || 'draft')
    });
    floatingEvents = [event, ...floatingEvents.filter((item) => String(item.id || '') !== id)];
    return event;
  }
  async function persistFloatingEvent(event = {}){
    const payload = { ...event, branch_id: branchId() };
    const api = window.PlatformAPI;
    if (api?.calendarEvents?.save) {
      const result = await api.calendarEvents.save(orgId(), payload.id || floatingEventId(), payload, { kind: 'calendar_event', branch_id: branchId() });
      if (result?.missing) throw new Error('Calendar events are not available in the platform backend.');
      return normalizePersistedFloatingEvent(result, payload);
    }
    if (api?.calendarEvents?.upsert) return normalizePersistedFloatingEvent(await api.calendarEvents.upsert(orgId(), payload), payload);
    if (api?.calendarEvents?.create) return normalizePersistedFloatingEvent(await api.calendarEvents.create(orgId(), payload), payload);
    if (api?.events?.create) return normalizePersistedFloatingEvent(await api.events.create(orgId(), payload), payload);
    throw new Error('Calendar event persistence is not configured.');
  }
  function projectSearchText(project = {}){
    return [
      projectTitle(project),
      project.address,
      project.project_address,
      project.customer_name,
      project.customer_phone,
      project.phone,
      project.email,
      project.customer_email,
      project.city
    ].map(clean).filter(Boolean).join(' ').toLowerCase();
  }
  function projectSearchResults(query = ''){
    const q = clean(query).toLowerCase();
    if (!q) return [];
    return visibleProjects()
      .filter((project) => projectSearchText(project).includes(q))
      .sort((a, b) => projectTitle(a).localeCompare(projectTitle(b)))
      .slice(0, 8);
  }
  function normalizeFloatingEventList(result){
    const source = Array.isArray(result?.events) ? result.events
      : Array.isArray(result?.documents) ? result.documents
        : Array.isArray(result) ? result
          : [];
    return source.map((entry) => ({ ...(entry?.data || entry || {}), id: entry?.id || entry?.data?.id || entry?.id })).map(decorateFloatingEvent);
  }
  function normalizePersistedFloatingEvent(result, fallback = {}){
    const document = result?.document || result?.event || result?.calendar_event || result;
    const data = document?.data && typeof document.data === 'object' ? document.data : document;
    return decorateFloatingEvent({
      ...fallback,
      ...(data || {}),
      id: data?.id || document?.id || fallback.id
    });
  }
  function selectedEventCalendarDraft(){
    const floatingDraft = floatingEvents.find((event) => String(event.id || '') === String(eventDraftPopoverId || '') && event.status !== 'scheduled');
    if (floatingDraft) return floatingDraft;
    const placementKind = selectedPlacementKind();
    if (placementKind === 'materials') {
      const event = selectedMaterialEvent();
      const project = selectedMaterialProject() || eventProject(event || {});
      if (!event) return null;
      const scheduled = eventIsScheduled(event);
      return {
        ...decorateMaterialEvent(event),
        id: event.id,
        event_id: event.id,
        project_id: project?.id || event.project_id || '',
        start: materialScheduleDraft?.start || (scheduled ? eventStart(event) : null),
        end: materialScheduleDraft?.end || (scheduled ? eventEnd(event) : null),
        all_day: materialScheduleDraft?.all_day ?? event.all_day ?? true,
        schedule_granularity: materialScheduleDraft?.schedule_granularity || event.schedule_granularity || 'date'
      };
    }
    if (placementKind === 'production') {
      const event = selectedProductionEvent();
      const project = selectedProductionProject() || eventProject(event || {});
      if (event) return {
        ...event,
        id: event.id,
        event_id: event.id,
        title: event.title || (globalThis.PlatformLanguage?.text("scheduling","m_2ac9ecd66d638b","New Event") ?? "New Event"),
        project_title: projectTitle(project, event),
        project_address: projectAddress(project, event),
        start: productionScheduleDraft?.start || (eventIsScheduled(event) ? eventStart(event) : null),
        end: productionScheduleDraft?.end || (eventIsScheduled(event) ? eventEnd(event) : null),
        all_day: productionScheduleDraft?.all_day ?? event.all_day ?? true,
        schedule_granularity: productionScheduleDraft?.schedule_granularity || event.schedule_granularity || (event.all_day === false ? 'time' : 'date'),
        assignee_label: workCrewName(event) || 'Unassigned',
        ...workResourcePayload(productionScheduleDraft || event)
      };
      if (project?.id) return productionScheduleDraft || {
        id: '__production_event_draft',
        event_id: '',
        title: projectTitle(project),
        project_title: projectTitle(project),
        project_address: projectAddress(project, {}),
        all_day: eventCalendarMode() === 'month',
        schedule_granularity: eventCalendarMode() === 'month' ? 'date' : 'time',
        ...workResourcePayload({})
      };
      return null;
    }
    const event = selectedScheduleEvent();
    if (!event) return null;
    const project = eventProject(event);
    return {
      id: event.id,
      event_id: event.id,
      title: event.title || (globalThis.PlatformLanguage?.text("scheduling","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment"),
      project_title: projectTitle(project, event),
      project_address: projectAddress(project, event),
      start: appointmentScheduleDraft?.start || eventStart(event),
      end: appointmentScheduleDraft?.start
        ? new Date(new Date(appointmentScheduleDraft.start).getTime() + Number(event.duration_minutes || schedulingConfig?.event_types?.sales_appointment?.duration_minutes || 60) * 60000)
        : eventEnd(event),
      all_day: event.all_day === true,
      schedule_granularity: event.schedule_granularity || 'time',
      assignee_label: assignedLabel(event),
    };
  }
  function eventCalendarDefaultDraftPayload(range = {}, requestedMode = scheduleMode){
    if (!selectedScheduleEvent() && !selectedProductionProject() && !selectedProductionEvent() && !selectedMaterialEvent()) {
      const meta = eventTypeMeta('');
      return {
        id: floatingEventId(),
        event_id: '',
        title: meta.title,
        project_title: '',
        project_address: '',
        assignee_label: '',
        status: 'draft',
        floating_event: true,
      };
    }
    const placementKind = selectedPlacementKind() || requestedMode;
    if (placementKind === 'materials') {
      const event = selectedMaterialEvent();
      const project = selectedMaterialProject() || eventProject(event || {});
      return {
        ...decorateMaterialEvent(event || {}),
        id: materialScheduleEventId || '__material_event_draft',
        event_id: materialScheduleEventId || '',
        project_id: project?.id || event?.project_id || materialScheduleProjectId || '',
        title: materialDeliveryTitle(event || {}),
        project_title: projectTitle(project || {}, event || {}),
        project_address: projectAddress(project || {}, event || {}),
        all_day: eventCalendarMode() === 'month',
        schedule_granularity: eventCalendarMode() === 'month' ? 'date' : 'time',
        default_duration_ms:86400000
      };
    }
    if (placementKind === 'production') {
      const selectedEvent = selectedProductionEvent();
      const project = selectedProductionProject() || eventProject(selectedEvent || {});
      const interpreted = selectedEvent && range?.start && window.PlatformScheduling?.interpretScheduleBundle
        ? window.PlatformScheduling.interpretScheduleBundle(selectedEvent, selectedProductionBundle()?.events || [selectedEvent], range.start, project, scopeTemplates)[0]
        : null;
      return {
        id: productionScheduleEventId || '__production_event_draft',
        event_id: productionScheduleEventId || '',
        project_id: project?.id || productionScheduleProjectId || '',
        title: selectedEvent?.title || projectTitle(project || {}, productionScheduleDraft || {}),
        project_title: projectTitle(project || {}, productionScheduleDraft || {}),
        project_address: projectAddress(project || {}, productionScheduleDraft || {}),
        assignee_label: workCrewName(productionScheduleDraft || {}) || 'Unassigned',
        default_duration_ms: interpreted?.end && interpreted?.start ? new Date(interpreted.end).getTime() - new Date(interpreted.start).getTime() : 86400000,
        ...workResourcePayload(productionScheduleDraft || {})
      };
    }
    const event = selectedScheduleEvent();
    const project = eventProject(event || {});
    return {
      id: appointmentScheduleEventId || '__sales_event_draft',
      event_id: appointmentScheduleEventId || '',
      project_id: project?.id || appointmentScheduleProjectId || event?.project_id || '',
      title: event?.title || (globalThis.PlatformLanguage?.text("scheduling","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment"),
      project_title: projectTitle(project, event || {}),
      project_address: projectAddress(project, event || {}),
      assignee_label: appointmentScheduleDraft?.user?.name || appointmentScheduleDraft?.user?.email || assignedLabel(event || {}),
    };
  }
  function applyEventCalendarDraft(next){
    if (!next?.start) return;
    if (next.floating_event === true || String(next.id || '').startsWith('floating_')) {
      updateFloatingEvent(next);
      return;
    }
    const placementKind = selectedPlacementKind() || scheduleMode;
    if (placementKind === 'materials') {
      applyMaterialScheduleDraft(next);
      return;
    }
    if (placementKind === 'production') {
      productionScheduleProjectId = String(selectedProductionProject()?.id || selectedProductionEvent()?.project_id || productionScheduleProjectId || '');
      productionScheduleEventId = String(next.event_id || productionScheduleEventId || '');
      productionScheduleDraft = {
        ...(productionScheduleDraft || {}),
        ...next,
        id: next.id || productionScheduleEventId || '__production_event_draft',
        event_id: next.event_id || productionScheduleEventId || '',
        title: next.title || (globalThis.PlatformLanguage?.text("scheduling","m_2ac9ecd66d638b","New Event") ?? "New Event"),
        start: next.start,
        end: next.end || addDays(new Date(next.start), 1),
        all_day: next.all_day !== false,
        schedule_granularity: next.schedule_granularity || (next.all_day === false ? 'time' : 'date')
      };
      return;
    }
    const user = appointmentScheduleDraft?.user || null;
    appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), start: next.start, user };
    appointmentScheduleEventId = String(next.event_id || appointmentScheduleEventId || '');
    appointmentScheduleProjectId = String(selectedScheduleEvent()?.project_id || appointmentScheduleProjectId || '');
  }
  function applyMaterialScheduleDraft(next){
    if (!next?.start) return;
    const event = selectedMaterialEvent();
    materialScheduleProjectId = String(event?.project_id || materialScheduleProjectId || '');
    materialScheduleEventId = String(event?.id || next.event_id || next.id || materialScheduleEventId || '');
    materialScheduleDraft = {
      ...(materialScheduleDraft || event || {}),
      ...next,
      id: event?.id || next.id || materialScheduleEventId,
      event_id: event?.id || next.event_id || materialScheduleEventId,
      start: next.start,
      end: next.end || (next.all_day === false ? new Date(new Date(next.start).getTime() + 60 * 60000) : addDays(new Date(next.start), 1)),
      all_day: next.all_day !== false,
      schedule_granularity: next.schedule_granularity || (next.all_day === false ? 'time' : 'date')
    };
  }
  function scheduledRelationshipRescheduleDrafts(event = {}, range = {}){
    const Scheduling = window.PlatformScheduling;
    const project = eventProject(event);
    if (!Scheduling?.relatedScheduleRescheduleDrafts || !project?.id || !range?.start) return [];
    return Scheduling.relatedScheduleRescheduleDrafts(
      event,
      allEvents.filter((item) => String(item.project_id || '') === String(project.id || '') && eventIsScheduled(item)),
      range,
      project,
      scopeTemplates
    );
  }
  async function chooseRelationshipReschedule(event = {}, relatedDrafts = []){
    if (!relatedDrafts.length) return 'no';
    const count = relatedDrafts.length;
    return window.Portal?.ui?.choose?.(
      `This schedule item controls ${count} related event${count === 1 ? '' : 's'}. Would you like to move ${count === 1 ? 'it' : 'them'} using the scope's scheduling rules?`,
      [
        { value:'cancel', label:(globalThis.PlatformLanguage?.text("scheduling","m_cbef679b21abb4","Cancel") ?? "Cancel") },
        { value:'no', label:(globalThis.PlatformLanguage?.text("scheduling","m_2f0222913078f4","No") ?? "No") },
        { value:'yes', label:(globalThis.PlatformLanguage?.text("scheduling","m_549ccd0e27a3d4","Yes") ?? "Yes"), primary:true }
      ],
      { title:(globalThis.PlatformLanguage?.text("scheduling","m_64b37c5695aa34","Move related schedule items") ?? "Move related schedule items") }
    ) || 'cancel';
  }
  async function saveEventCalendarRange(event, range){
    const Scheduling = window.PlatformScheduling;
    const currentEvent = allEvents.find((item) => String(item.id || '') === String(event?.id || '')) || event;
    const project = eventProject(currentEvent);
    if (eventIsLocked(event)) {
      showToast(
        (globalThis.PlatformLanguage?.text("scheduling","m_88e13d64071885","Schedule locked") ?? "Schedule locked"),
        isMaterialEvent(event) && materialEventIsOrdered(event)
          ? 'Unlock this ordered delivery before moving it.'
          : 'Unlock this item before moving it.',
        false
      );
      return;
    }
    if (event?.floating_event === true || String(event?.id || '').startsWith('floating_')) {
      const saveVersion = beginEventRangeSave(event.id);
      const next = updateFloatingEvent({
        ...event,
        ...range,
        start: range.start,
        end: range.end,
        all_day: range.all_day,
        schedule_granularity: range.schedule_granularity || (range.all_day === false ? 'time' : 'date'),
        status: event.status === 'scheduled' ? 'scheduled' : (event.status || 'draft')
      });
      try {
        const saved = await queueEventRangeSave(event.id, () => persistFloatingEvent(next));
        if (eventRangeSaveVersions.get(String(event.id || '')) === saveVersion) {
          updateFloatingEvent({ ...next, ...saved, status: next.status || saved?.status || 'scheduled' });
        }
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_90522d8e2312ca","Event not saved") ?? "Event not saved"), error?.message || 'Could not save the event change.', false);
      }
      return;
    }
    if (!Scheduling || !event?.id || !project?.id || !range?.start) return;
    const relatedDrafts = isProductionEvent(currentEvent) ? scheduledRelationshipRescheduleDrafts(currentEvent, range) : [];
    const relationshipChoice = relatedDrafts.length ? await chooseRelationshipReschedule(currentEvent, relatedDrafts) : 'no';
    if (relationshipChoice === 'cancel' || relationshipChoice === false || relationshipChoice == null) {
      refreshActiveScheduleSurface();
      return;
    }
    const saveVersion = beginEventRangeSave(event.id);
    const payload = {
      start: new Date(range.start),
      end: range.end ? new Date(range.end) : eventEnd(event),
      all_day: range.all_day !== false,
      schedule_granularity: range.schedule_granularity || (range.all_day === false ? 'time' : 'date')
    };
    const assignment = assignmentPayloadForEvent({ ...currentEvent, ...range });
    const next = (isProductionEvent(currentEvent) || isMaterialEvent(currentEvent))
      ? Scheduling.updateProjectEventRange(currentEvent, payload)
      : {
          ...withScheduleHistory(currentEvent, 'rescheduled'),
          ...assignment,
          start_at: payload.start.toISOString(),
          start: payload.start.toISOString(),
          end_at: payload.end.toISOString(),
          end: payload.end.toISOString(),
          all_day: payload.all_day,
          schedule_granularity: payload.schedule_granularity,
          updated_at: new Date().toISOString()
        };
    const relatedChanges = relationshipChoice === 'yes' ? relatedDrafts.map((draft) => {
      const source = allEvents.find((item) => String(item.id || '') === String(draft.id || draft.event_id || '')) || draft;
      return {
        ...Scheduling.updateProjectEventRange(source, {
          start:new Date(draft.start),
          end:new Date(draft.end),
          all_day:draft.all_day !== false,
          schedule_granularity:draft.schedule_granularity || (draft.all_day === false ? 'time' : 'date')
        }),
        status:'scheduled'
      };
    }) : [];
    const changes = [next, ...relatedChanges];
    const changesById = new Map(changes.map((item) => [String(item.id || ''), item]));
    // Keep the untouched originals so a failed save can be reverted locally
    // without a data reload (which could clobber other in-flight drags).
    const previousById = new Map();
    allEvents.forEach((item) => { const id = String(item.id || ''); if (changesById.has(id)) previousById.set(id, item); });
    allEvents = allEvents.map((item) => changesById.has(String(item.id || '')) ? { ...item, ...changesById.get(String(item.id || '')) } : item);
    events = visibleEvents();
    refreshActiveScheduleSurface();
    try {
      const saved = await queueEventRangeSave(event.id, () => Scheduling.saveProjectEvent(orgId(), project, next, schedulingConfig));
      mergeSavedCalendarEvent(saved, next, saveVersion);
      for (const related of relatedChanges) {
        const relatedVersion = beginEventRangeSave(related.id);
        const relatedSaved = await queueEventRangeSave(related.id, () => Scheduling.saveProjectEvent(orgId(), project, related, schedulingConfig));
        mergeSavedCalendarEvent(relatedSaved, related, relatedVersion);
      }
      refreshActiveScheduleSurface();
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_a1da9bcb050cbb","Schedule updated") ?? "Schedule updated"), relatedChanges.length ? `The calendar item and ${relatedChanges.length} related event${relatedChanges.length === 1 ? '' : 's'} were moved.` : 'The calendar item was moved.', true);
    } catch (error) {
      if (eventRangeSaveVersions.get(String(event.id || '')) === saveVersion) {
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), error?.message || 'Could not update this calendar item.', false);
        // Roll the optimistic move back so the view matches storage instead
        // of showing a phantom position.
        allEvents = allEvents.map((item) => previousById.get(String(item.id || '')) || item);
        events = visibleEvents();
        refreshActiveScheduleSurface();
      }
    }
  }
  function salesResources(event = {}){
    const eventTypeId = clean(event.event_type_default_id || event.type_id || 'sales_appointment');
    const eventType = schedulingConfig?.event_types?.[eventTypeId] || {};
    const Scheduling = window.PlatformScheduling;
    const policy = Scheduling?.assignmentPolicyForEventType?.(eventType, eventTypeId) || eventType.assignment_policy || {};
    const people = users.map((user) => ({
      ...Scheduling.normalizeUser(user),
      subject_type:'organization_user',
      id:clean(user.id),
      name:clean(user.name || user.email || user.id),
      user
    }));
    return (Scheduling?.filterAssignableSubjects?.([...people, ...workforceResources], policy) || people)
      .filter((subject) => clean(subject.status || 'active') !== 'disabled')
      .filter((user) => user.id);
  }
  function closeScheduleSettingsModal(){
    document.querySelector('.dash-modal-backdrop[data-schedule-settings-modal]')?.remove();
  }
  function openScheduleSettingsModal({ title = 'Settings', body = '', onSave = null, fullSettingsEvent = '' } = {}){
    closeScheduleSettingsModal();
    const modal = document.createElement('div');
    modal.className = 'dash-modal-backdrop';
    modal.dataset.scheduleSettingsModal = '1';
    modal.innerHTML = `
      <div class="dash-modal dash-settings-modal" role="dialog" aria-modal="true" aria-label="${String(escapeHtml(title))}">
        <div class="dash-modal-head">
          <h3>${String(escapeHtml(title))}</h3>
          <button type="button" class="dash-modal-close" data-modal-close aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="dash-modal-body">
          ${String(body)}
          <div class="dash-modal-actions">
            <button type="button" class="dash-btn" data-full-settings><i class="fas fa-up-right-from-square"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2e1b55e87cf6b3"," Full Settings") ?? " Full Settings")}</button>
            <div class="dash-modal-actions-right">
              <span class="dash-modal-status" data-settings-status></span>
              <button type="button" class="dash-btn" data-modal-close>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
              <button type="button" class="dash-btn active" data-settings-save><i class="fas fa-save"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_13fcb6ceae139c"," Save") ?? " Save")}</button>
            </div>
          </div>
        </div>
      </div>`;
    const close = () => modal.remove();
    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });
    modal.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', close));
    modal.querySelector('[data-full-settings]')?.addEventListener('click', () => {
      if (fullSettingsEvent) window.dispatchEvent(new CustomEvent(fullSettingsEvent));
      close();
    });
    modal.querySelector('[data-settings-save]')?.addEventListener('click', async () => {
      if (typeof onSave !== 'function') return;
      const btn = modal.querySelector('[data-settings-save]');
      const status = modal.querySelector('[data-settings-status]');
      btn.disabled = true;
      if (status) status.textContent = (globalThis.PlatformLanguage?.text("scheduling","m_b82c4e12389843","Saving...") ?? "Saving...");
      try {
        await onSave(modal);
        if (status) status.textContent = (globalThis.PlatformLanguage?.text("scheduling","m_47bbabb50774cf","Saved.") ?? "Saved.");
        setTimeout(close, 350);
      } catch (error) {
        btn.disabled = false;
        if (status) status.textContent = error?.message || 'Could not save.';
      }
    });
    document.body.appendChild(modal);
    window.Portal?.modals?.register?.(modal, { id: 'schedule-settings', closeOnEscape: true, closeOnBackdrop: true, onClose: close });
    modal.querySelector('input,select,textarea')?.focus?.();
  }
  function openScheduleUserSettings(userOrResource = {}){
    const user = userOrResource.user || userOrResource.raw || userOrResource;
    const id = clean(user.id || userOrResource.id);
    if (!id) return;
    const profile = {
      id,
      name: clean(user.name || user.display_name || user.full_name || userOrResource.name || user.email || id),
      email: clean(user.email || user.email_address || ''),
      avatar: clean(user.avatar || user.avatar_url || user.photo_url || user.profile_photo_url || user.image_url || ''),
      raw: user
    };
    const opener = window.Portal?.PhotoFeed?.openUserModal;
    if (typeof opener === 'function') {
      opener(profile, []);
      return;
    }
    window.dispatchEvent(new CustomEvent('fm:open-user-settings', { detail: { user: profile, userId: id } }));
  }
  function openScheduleWorkResourceSettings(resource = {}){
    activeCrewSettingsModal?.close?.();
    const resourceId = clean(resource?.id);
    const resourceKind = clean(resource?.resource_kind || resource?.kind || resource?.resource_type).toLowerCase();
    const settingsView = resourceKind.includes('connection') || resourceKind.includes('organization') ? 'connections' : 'groups';
    const resourceName = clean(resource?.name || resource?.display_name || resource?.label || 'crew');
    const back = document.createElement('div');
    back.className = 'dash-modal-backdrop';
    back.dataset.crewSettingsModal = '1';
    back.innerHTML = `
      <div class="dash-modal dash-crew-settings-modal" role="dialog" aria-modal="true" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_4fb8b80d0a5d90","Crew settings") ?? "Crew settings")}">
        <div class="dash-modal-head">
          <div><h3>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_772109319abfee","Crew Settings") ?? "Crew Settings")}</h3><div class="dash-sub">${((v0) => globalThis.PlatformLanguage?.htmlText("scheduling","m_f6886ec5b464b4",`Editing ${v0} without leaving Production Routing`,{v0}) ?? `Editing ${v0} without leaving Production Routing`)(escapeHtml(resourceName))}</div></div>
          <button type="button" class="dash-modal-close" data-modal-close aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="dash-modal-body">
          <div class="dash-crew-settings-host" data-crew-settings-host><div class="dash-crew-settings-loading"><i class="fas fa-spinner fa-spin"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_7a62a2885f694e"," Loading crew settings...") ?? " Loading crew settings...")}</div></div>
        </div>
      </div>`;
    const host = back.querySelector('[data-crew-settings-host]');
    let modalHandle = null;
    let appHandle = null;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      modalHandle?.unregister?.();
      modalHandle = null;
      appHandle?.destroy?.();
      appHandle = null;
      back.remove();
      if (activeCrewSettingsModal?.element === back) activeCrewSettingsModal = null;
    };
    back.querySelector('[data-modal-close]')?.addEventListener('click', close);
    document.body.appendChild(back);
    activeCrewSettingsModal = { element:back, close };
    modalHandle = window.Portal?.modals?.register?.(back, {
      id:'schedule-crew-settings',
      closeOnEscape:true,
      closeOnBackdrop:true,
      onClose:close
    }) || null;
    const runtime = window.FirstMateEmbeddableApps;
    if (!host || typeof runtime?.mount !== 'function') {
      if (host) host.innerHTML = `<div class="dash-crew-settings-loading">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_76aa8eafe399cb","Crew settings are unavailable.") ?? "Crew settings are unavailable.")}</div>`;
      return;
    }
    Promise.resolve(runtime.mount(host, 'portal.company_settings', {
      surface:'portal_tab',
      source:'scheduling-crew-settings-modal',
      chrome:'modal',
      params:{ embedded:true, settingsTab:'crews', settingsView, settingsEntity:resourceId },
      roots:{ main:host }
    })).then((handle) => {
      if (closed) handle?.destroy?.();
      else appHandle = handle;
    }).catch((error) => {
      if (!closed && host) host.innerHTML = `<div class="dash-crew-settings-loading">${escapeHtml(error?.message || 'Could not load crew settings.')}</div>`;
    });
  }
  function assignmentResourcesForEvent(event){
    if (isMaterialEvent(event)) return [];
    return isProductionEvent(event) ? productionWorkResources(event?.scope_template_id, event) : salesResources(event);
  }
  function currentAssignmentId(event){
    if (isMaterialEvent(event)) return '';
    return workCrewId(event) || clean(event.assigned_user_id || event.assigned_user_ids?.[0] || event.assigned_users?.[0]?.id);
  }
  function assignmentHasConflict(event, resourceId){
    if (isMaterialEvent(event)) return false;
    if (!resourceId || !event?.id) return false;
    const start = eventStart(event);
    const end = eventEnd(event);
    return allEvents.some((other) => {
      if (String(other.id || '') === String(event.id || '')) return false;
      if (isProductionEvent(event) !== isProductionEvent(other)) return false;
      const otherResourceId = currentAssignmentId(other);
      if (String(otherResourceId || '') !== String(resourceId || '')) return false;
      return start < eventEnd(other) && eventStart(other) < end;
    });
  }
  function patchRenderedAssignment(event){
    const id = String(event?.id || '');
    if (!id || !rootEl) return;
    const label = currentAssignmentId(event) ? (workCrewName(event) || assignedLabel(event)) : 'Unassigned';
    rootEl.querySelectorAll('[data-prs-event-id]').forEach((chip) => {
      if (String(chip.dataset.prsEventId || '') !== id) return;
      const assignee = chip.querySelector('[data-prs-assignee]');
      if (!assignee) return;
      assignee.setAttribute('aria-label', ((v0) => globalThis.PlatformLanguage?.text("scheduling","m_2fb2912cfc8c43",`Assign ${v0}`,{v0}) ?? `Assign ${v0}`)(label));
      const text = assignee.querySelector('span');
      if (text) text.textContent = label;
      assignee.classList.toggle('waiting', label === 'Unassigned');
      chip.classList.toggle('awaiting-crew', label === 'Unassigned');
    });
  }
  async function saveAssignment(event, resourceId = ''){
    const Scheduling = window.PlatformScheduling;
    const project = eventProject(event);
    if (!event?.id || isMaterialEvent(event)) return;
    const resource = assignmentResourcesForEvent(event).find((item) => String(item.id || '') === String(resourceId || '')) || null;
    const userSubject = clean(resource?.subject_type || resource?.resource_kind) === 'organization_user';
    const next = userSubject
      ? {
          ...withScheduleHistory(event, resource ? 'assigned' : 'unassigned'),
          ...assignmentPayloadForSubject(resource),
          assignee_label: resource?.name || 'Unassigned',
          updated_at: new Date().toISOString()
        }
      : {
          ...event,
          ...assignmentPayloadForSubject(resource),
          assignee_label: resource?.name || 'Unassigned',
          updated_at: new Date().toISOString()
        };
    closeAssignmentMenu();
    if (event?.floating_event === true || String(event?.id || '').startsWith('floating_')) {
      const saved = updateFloatingEvent(next);
      patchRenderedAssignment(saved);
      try {
        await persistFloatingEvent(saved);
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_2926f24620d13c","Assignment updated") ?? "Assignment updated"), resource ? `${resource.name} is assigned.` : 'The item is unassigned.', true);
      } catch (error) {
        const restored = updateFloatingEvent(event);
        patchRenderedAssignment(restored);
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_d916f201614a78","Assignment failed") ?? "Assignment failed"), error?.message || 'Could not update the assignment.', false);
      }
      return;
    }
    if (!Scheduling || !project?.id) return;
    allEvents = allEvents.map((item) => String(item.id || '') === String(next.id || event.id || '') ? { ...item, ...next } : item);
    events = visibleEvents();
    patchRenderedAssignment(next);
    try {
      await Scheduling.saveProjectEvent(orgId(), project, next, schedulingConfig);
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_2926f24620d13c","Assignment updated") ?? "Assignment updated"), resource ? `${resource.name} is assigned.` : 'The item is unassigned.', true);
    } catch (error) {
      allEvents = allEvents.map((item) => String(item.id || '') === String(event.id || '') ? { ...item, ...event } : item);
      events = visibleEvents();
      patchRenderedAssignment(event);
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_d916f201614a78","Assignment failed") ?? "Assignment failed"), error?.message || 'Could not update the assignment.', false);
    }
  }
  function closeAssignmentMenu(){
    assignmentMenuEventId = '';
    if (assignmentMenuDocHandler) {
      assignmentMenuDocHandler();
      assignmentMenuDocHandler = null;
    }
    document.querySelectorAll('.dash-assignee-popover').forEach((node) => node.remove());
  }
  function openAssignmentMenu(event, anchor){
    if (!event?.id || !anchor) return;
    if (assignmentMenuEventId && String(assignmentMenuEventId) === String(event.id || '') && document.querySelector('.dash-assignee-popover')) {
      closeAssignmentMenu();
      return;
    }
    closeAssignmentMenu();
    assignmentMenuEventId = String(event.id || '');
    const currentId = currentAssignmentId(event);
    const resources = assignmentResourcesForEvent(event);
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'dash-assignee-popover';
    menu.style.left = `${Math.min(window.innerWidth - 236, Math.max(8, rect.left))}px`;
    menu.style.top = `${Math.max(8, rect.bottom + 8)}px`;
    menu.style.maxHeight = `${Math.max(72, window.innerHeight - rect.bottom - 16)}px`;
    const option = (id, label) => {
      const conflict = assignmentHasConflict(event, id);
      return `<button type="button" class="dash-assignee-option ${String(currentId || '') === String(id || '') ? 'active' : ''} ${conflict ? 'warn' : ''}" data-assign-resource="${escapeHtml(id || '')}">
        <span>${escapeHtml(label)}</span>${conflict ? ("<i class=\"fas fa-triangle-exclamation\" title=\"" + (globalThis.PlatformLanguage?.htmlText("scheduling","m_ba1a70707ee55c","Potential conflict") ?? "Potential conflict") + "\"></i>") : ''}
      </button>`;
    };
    menu.innerHTML = `${option('', 'Unassigned')}${resources.map((resource) => option(resource.id, resource.name)).join('')}`;
    menu.querySelectorAll('[data-assign-resource]').forEach((btn) => btn.addEventListener('click', (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      saveAssignment(event, btn.dataset.assignResource || '');
    }));
    document.body.appendChild(menu);
    setTimeout(() => {
      assignmentMenuDocHandler = bindOutsidePointerDismiss(menu, closeAssignmentMenu, [anchor]);
    }, 0);
  }
  /* --- Equipment on events (equipment.scheduling capability) ------------- */
  function equipmentSchedulingOn(){
    const has = window.Portal?.appFlags?.has || window.PlatformAPI?.appFlags?.has;
    return typeof has === 'function' && has('apps', 'equipment') === true && has('equipment', 'scheduling') === true;
  }
  function requirementAlertHtml(event = {}){
    const warnings = requirementWarningsForEvent(event);
    if (!warnings.length) return '';
    return `<div class="dash-event-requirement-alert" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><ul>${warnings.map((warning) => `<li>${escapeHtml(warning.label || warning)}</li>`).join('')}</ul></div>`;
  }
  function eventEquipRefs(event = {}){
    return window.PlatformScheduling?.eventEquipmentRefs?.(event) || [];
  }
  function equipmentUnitConflict(event, unitId){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling?.availabilityForEquipment || !eventStart(event)) return false;
    const availability = Scheduling.availabilityForEquipment({
      units: equipmentUnits.filter((unit) => clean(unit.id) === clean(unitId)),
      events: allEvents,
      start: eventStart(event),
      end: eventEnd(event),
      excludeEventId: clean(event.id)
    });
    return availability.units.some((unit) => !unit.available);
  }
  async function saveEventEquipment(event, nextRefs){
    const Scheduling = window.PlatformScheduling;
    const project = eventProject(event);
    if (!Scheduling || !project?.id || !event?.id) return;
    const otherRefs = (Array.isArray(event.resource_refs) ? event.resource_refs : [])
      .filter((ref) => !['equipment_unit', 'equipment_type'].includes(clean(ref?.kind)));
    const next = { ...event, resource_refs: [...otherRefs, ...nextRefs], updated_at: new Date().toISOString() };
    allEvents = allEvents.map((item) => String(item.id || '') === String(event.id || '') ? { ...item, ...next } : item);
    events = visibleEvents();
    try {
      const saved = await Scheduling.saveProjectEvent(orgId(), project, next, schedulingConfig);
      const conflicts = Array.isArray(saved?.equipment_conflicts) ? saved.equipment_conflicts : [];
      if (conflicts.length) showToast((globalThis.PlatformLanguage?.text("scheduling","m_7ccde50eeb747e","Equipment conflict") ?? "Equipment conflict"), conflicts[0]?.message || 'This equipment is booked elsewhere in that window.', false);
      else showToast((globalThis.PlatformLanguage?.text("scheduling","m_317eee5dd93496","Equipment updated") ?? "Equipment updated"), (globalThis.PlatformLanguage?.text("scheduling","m_2b01dd410f8b30","The equipment assignment is saved.") ?? "The equipment assignment is saved."), true);
    } catch (error) {
      allEvents = allEvents.map((item) => String(item.id || '') === String(event.id || '') ? { ...item, ...event } : item);
      events = visibleEvents();
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_9b1cfa178d2fa4","Equipment update failed") ?? "Equipment update failed"), error?.message || 'Could not update the equipment assignment.', false);
    }
    render();
    setTimeout(() => renderEventDraftPopover(editorAnchorFor(event.id)), 0);
  }
  function eventEquipmentSectionHtml(ctx, draft, project){
    if (!equipmentSchedulingOn()) return '';
    const delivery = isMaterialEvent(draft) || eventTypeId(draft) === 'delivery';
    if (delivery && !eventAdvancedOpen) return '';
    const refs = eventEquipRefs(draft);
    const assignedIds = new Set(refs.map((ref) => clean(ref.id)));
    const options = equipmentUnits.filter((unit) => !assignedIds.has(clean(unit.id)));
    const chips = refs.map((ref) => {
      const unit = equipmentUnits.find((item) => clean(item.id) === clean(ref.id)) || null;
      const conflicted = ref.kind === 'equipment_unit' && equipmentUnitConflict(draft, ref.id);
      return `<span class="dash-event-equipment-chip ${String(conflicted ? 'warn' : '')}">
        <i class="fas ${String(escapeHtml(clean(unit?.icon) || 'fa-truck-pickup'))}"></i>
        <span>${String(escapeHtml(ref.name || unit?.name || ref.id))}</span>
        ${String(conflicted ? `<i class="fas fa-triangle-exclamation" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_c71ee644be52a3","Booked elsewhere in this window") ?? "Booked elsewhere in this window")}"></i>` : '')}
        <button type="button" data-event-equipment-remove="${String(escapeHtml(ref.id))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_e6c8bec001e544","Remove equipment") ?? "Remove equipment")}"><i class="fas fa-xmark"></i></button>
      </span>`;
    }).join('');
    const allocationsHtml = eventAdvancedOpen ? refs.filter((ref) => ref.kind === 'equipment_unit').map((ref) => {
      const unit = equipmentUnits.find((item) => clean(item.id) === clean(ref.id));
      return `<div class="dash-event-equipment-allocation" data-event-equipment-allocation="${String(escapeHtml(ref.id))}"><strong>${((v1) => globalThis.PlatformLanguage?.htmlText("scheduling","m_4cb2d7d95c95f9",`${v1} usage window`,{v1}) ?? `${v1} usage window`)(escapeHtml(ref.name || unit?.name || ref.id))}</strong><label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_c313c42d1f7a10","From") ?? "From")}<input type="datetime-local" data-event-equipment-start value="${String(escapeHtml(dateTimeLocalValue(ref.start_at || eventStart(draft))))}"></label><label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_7a571a426468ff","Until") ?? "Until")}<input type="datetime-local" data-event-equipment-end value="${String(escapeHtml(dateTimeLocalValue(ref.end_at || eventEnd(draft))))}"></label></div>`;
    }).join('') : '';
    const requirements = Array.isArray(draft.resource_requirements) ? draft.resource_requirements : [];
    const requirementsHtml = eventAdvancedOpen ? requirements.map((requirement) => {
      const typeId = clean(requirement?.equipment_type_id);
      const needed = Math.max(1, Number(requirement?.quantity || 1));
      const fulfilledCount = refs.reduce((count, ref) => {
        if (ref.kind === 'equipment_type') return clean(ref.id) === typeId ? count + Math.max(1, Number(ref.quantity || 1)) : count;
        const unit = equipmentUnits.find((item) => clean(item.id) === clean(ref.id));
        return clean(unit?.type_id) === typeId ? count + 1 : count;
      }, 0);
      const fulfilled = !!typeId && fulfilledCount >= needed;
      return `<span class="dash-event-equipment-chip ${String(fulfilled ? '' : 'warn')}" title="${String(fulfilled ? 'Requirement fulfilled' : `${fulfilledCount} of ${needed} assigned`)}">
        <i class="fas ${String(fulfilled ? 'fa-circle-check' : 'fa-circle-exclamation')}"></i>
        <span>${String(escapeHtml(clean(requirement?.label) || 'Equipment'))}${String(needed > 1 ? ` ×${needed}` : '')}</span>
        <button type="button" data-event-equipment-require-remove="${String(escapeHtml(typeId))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_05c9df91246110","Remove equipment requirement") ?? "Remove equipment requirement")}"><i class="fas fa-xmark"></i></button>
      </span>`;
    }).join('') : '';
    const requirementOptions = equipmentTypes.filter((type) => !requirements.some((requirement) => clean(requirement?.equipment_type_id) === clean(type.id)));
    return `<div class="dash-event-equipment" data-event-equipment>
      <div class="dash-event-equipment-head"><i class="fas fa-truck-pickup"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_00ec8ace19ba71"," Equipment") ?? " Equipment")}</div>
      ${String(requirementsHtml ? `<div class="dash-event-equipment-chips">${requirementsHtml}</div>` : '')}
      <div class="dash-event-equipment-chips">${String(chips || `<span class="dash-event-equipment-empty">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_e97309f102e999","No equipment on this event.") ?? "No equipment on this event.")}</span>`)}</div>
      ${String(allocationsHtml)}
      ${String(options.length ? `<select class="dash-event-equipment-add" data-event-equipment-add>
        <option value="">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_c637d35dfeb2ed","Add equipment…") ?? "Add equipment…")}</option>
        ${options.map((unit) => {
          const conflicted = equipmentUnitConflict(draft, unit.id);
          const down = ['down', 'retired'].includes(clean(unit.status));
          return `<option value="${escapeHtml(unit.id)}">${escapeHtml(unit.name)}${unit.type_name ? ` — ${escapeHtml(unit.type_name)}` : ''}${down ? ' (down)' : (conflicted ? ' (booked)' : '')}</option>`;
        }).join('')}
      </select>` : '')}
      ${String(eventAdvancedOpen ? `<div class="dash-event-advanced-note">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_f22c771a404a1e","Require a type without choosing a specific unit. Scope sets can populate the same requirement fields.") ?? "Require a type without choosing a specific unit. Scope sets can populate the same requirement fields.")}</div>
        <div class="dash-event-equipment-require">
          <select class="dash-event-equipment-add" data-event-equipment-require-type><option value="">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_9f3d23d05302f4","Required equipment type…") ?? "Required equipment type…")}</option>${requirementOptions.map((type) => `<option value="${escapeHtml(type.id)}">${escapeHtml(type.name || type.id)}</option>`).join('')}</select>
          <input type="number" min="1" max="99" value="1" data-event-equipment-require-quantity aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_00ee416bc52e89","Required quantity") ?? "Required quantity")}">
          <button type="button" data-event-equipment-require-add aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_1794d866e6d945","Add equipment requirement") ?? "Add equipment requirement")}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_1c69c58f6eed2f","Add requirement") ?? "Add requirement")}"><i class="fas fa-plus"></i></button>
        </div>` : '')}
    </div>`;
  }
  function bindEventEquipmentSection(pop, draft){
    const section = pop.querySelector('[data-event-equipment]');
    if (!section) return;
    section.querySelectorAll('[data-event-equipment-allocation]').forEach((row) => {
      const saveWindow = () => {
        const id = clean(row.dataset.eventEquipmentAllocation);
        const current = eventEditorContext()?.event || draft;
        const startAt = validDate(row.querySelector('[data-event-equipment-start]')?.value);
        const endAt = validDate(row.querySelector('[data-event-equipment-end]')?.value);
        if (startAt && endAt && endAt <= startAt) {
          showToast((globalThis.PlatformLanguage?.text("scheduling","m_18e497ad4151af","Invalid equipment window") ?? "Invalid equipment window"), (globalThis.PlatformLanguage?.text("scheduling","m_a7c91be49bc6e0","Equipment must be released after it is assigned.") ?? "Equipment must be released after it is assigned."), false);
          return;
        }
        const refs = (Array.isArray(current.resource_refs) ? current.resource_refs : []).map((ref) => clean(ref?.kind) === 'equipment_unit' && clean(ref?.id) === id
          ? { ...ref, ...(startAt ? { start_at:startAt.toISOString() } : {}), ...(endAt ? { end_at:endAt.toISOString() } : {}) }
          : ref);
        applyEditorPatch({ resource_refs:refs });
      };
      row.querySelector('[data-event-equipment-start]')?.addEventListener('change', saveWindow);
      row.querySelector('[data-event-equipment-end]')?.addEventListener('change', saveWindow);
    });
    section.querySelectorAll('[data-event-equipment-remove]').forEach((btn) => btn.addEventListener('click', (clickEvent) => {
      clickEvent.preventDefault();
      const id = clean(btn.dataset.eventEquipmentRemove);
      const current = eventEditorContext()?.event || draft;
      applyEditorPatch({ resource_refs:(Array.isArray(current.resource_refs) ? current.resource_refs : []).filter((ref) => !(clean(ref?.kind) === 'equipment_unit' && clean(ref?.id) === id)) });
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(current.id)), 0);
    }));
    section.querySelectorAll('[data-event-equipment-require-remove]').forEach((btn) => btn.addEventListener('click', (clickEvent) => {
      clickEvent.preventDefault();
      const typeId = clean(btn.dataset.eventEquipmentRequireRemove);
      const current = eventEditorContext()?.event || draft;
      applyEditorPatch({ resource_requirements:(Array.isArray(current.resource_requirements) ? current.resource_requirements : []).filter((item) => clean(item?.equipment_type_id) !== typeId) });
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(current.id)), 0);
    }));
    section.querySelector('[data-event-equipment-add]')?.addEventListener('change', (changeEvent) => {
      const id = clean(changeEvent.target.value);
      if (!id) return;
      const unit = equipmentUnits.find((item) => clean(item.id) === id);
      const current = eventEditorContext()?.event || draft;
      const otherRefs = (Array.isArray(current.resource_refs) ? current.resource_refs : []).filter((ref) => !(clean(ref?.kind) === 'equipment_unit' && clean(ref?.id) === id));
      applyEditorPatch({ resource_refs: [
        ...otherRefs,
        { kind: 'equipment_unit', id, name: clean(unit?.name) || id, role: 'equipment', start_at:eventStart(current)?.toISOString?.() || '', end_at:eventEnd(current)?.toISOString?.() || '' }
      ] });
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(current.id)), 0);
    });
    section.querySelector('[data-event-equipment-require-add]')?.addEventListener('click', () => {
      const typeId = clean(section.querySelector('[data-event-equipment-require-type]')?.value);
      if (!typeId) return;
      const quantity = Math.max(1, Math.round(Number(section.querySelector('[data-event-equipment-require-quantity]')?.value || 1)));
      const current = eventEditorContext()?.event || draft;
      const type = equipmentTypes.find((item) => clean(item.id) === typeId);
      const requirements = (Array.isArray(current.resource_requirements) ? current.resource_requirements : []).filter((item) => clean(item?.equipment_type_id) !== typeId);
      applyEditorPatch({ resource_requirements:[...requirements, { kind:'equipment_type', equipment_type_id:typeId, label:clean(type?.name) || typeId, quantity }] });
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(current.id)), 0);
    });
  }

  function closeEventDraftPopover(){
    document.querySelector('.dash-event-popover')?.remove();
    if (eventDraftDocHandler) eventDraftDocHandler();
    eventDraftDocHandler = null;
    if (eventDraftKeyHandler) document.removeEventListener('keydown', eventDraftKeyHandler, true);
    eventDraftKeyHandler = null;
  }
  function floatingProjectSnapshot(event = {}){
    return {
      project_id:clean(event.project_id),
      project_title:clean(event.project_title),
      project_address:clean(event.project_address)
    };
  }
  function rememberFloatingProjectAssignment(event = {}){
    if (!event?.id) return;
    eventDraftProjectUndo = { eventId:String(event.id), snapshot:floatingProjectSnapshot(event) };
  }
  function restoreFloatingProjectAssignment(){
    const undo = eventDraftProjectUndo;
    const current = eventEditorContext();
    if (!undo || current?.kind !== 'floating' || String(current.event?.id || '') !== undo.eventId) return false;
    const next = updateFloatingEvent({ ...current.event, ...undo.snapshot });
    eventDraftProjectUndo = null;
    eventDraftProjectQuery = '';
    render();
    setTimeout(() => renderEventDraftPopover(editorAnchorFor(next.id)), 0);
    return true;
  }
  function eventEditorContext(){
    const floating = floatingEvents.find((event) => String(event.id || '') === String(eventDraftPopoverId || ''));
    if (floating) return { kind: 'floating', event: floating, project: floating.project_id ? (projects.find((project) => String(project.id || '') === String(floating.project_id || '')) || {}) : {} };
    const selectedEditorEvent = eventEditorEventId
      ? (eventCalendarItems().find((event) => String(event.id || '') === String(eventEditorEventId || ''))
        || allEvents.find((event) => String(event.id || '') === String(eventEditorEventId || '')))
      : null;
    if (selectedEditorEvent) {
      const project = eventProject(selectedEditorEvent || {});
      if (isProductionEvent(selectedEditorEvent)) {
        return { kind: 'production', editorOnly: true, event: { ...selectedEditorEvent, event_type_default_id: 'project_work', type_id: 'project_work' }, project };
      }
      if (isMaterialEvent(selectedEditorEvent)) {
        return { kind: 'materials', editorOnly: true, event: selectedEditorEvent, project };
      }
      return { kind: 'sales', editorOnly: true, event: { ...selectedEditorEvent, event_type_default_id: 'sales_appointment', type_id: 'sales_appointment' }, project };
    }
    const placementKind = selectedPlacementKind() || scheduleMode;
    if (placementKind === 'materials') {
      const event = selectedMaterialEvent();
      const project = selectedMaterialProject() || eventProject(event || {});
      const draft = materialScheduleDraft || (event ? selectedEventCalendarDraft() : null);
      if (event?.id) return { kind: 'materials', event: { ...event, ...(draft || {}) }, project };
    } else if (placementKind === 'production') {
      const event = selectedProductionEvent();
      const project = selectedProductionProject() || eventProject(event || {});
      const draft = productionScheduleDraft || (event ? selectedEventCalendarDraft() : null) || { id: '__production_event_draft', title: projectTitle(project), project_id: project?.id || '', project_title: projectTitle(project), project_address: projectAddress(project || {}, {}), description: '' };
      if (project?.id || event?.id) return { kind: 'production', event: { ...draft, event_type_default_id: 'project_work', type_id: 'project_work' }, project };
    } else {
      const event = selectedScheduleEvent();
      const project = eventProject(event || {});
      const draft = event ? selectedEventCalendarDraft() : null;
      if (event?.id) return { kind: 'sales', event: { ...event, ...(draft || {}), event_type_default_id: 'sales_appointment', type_id: 'sales_appointment' }, project };
    }
    return null;
  }
  function editorAnchorFor(id = ''){
    const escaped = window.CSS?.escape ? window.CSS.escape(String(id || '')) : String(id || '').replace(/["\\]/g, '\\$&');
    return rootEl?.querySelector(`[data-prs-event-id="${escaped}"]`);
  }
  function updateLocalCalendarEvent(eventId = '', patch = {}){
    const id = String(eventId || '');
    if (!id) return;
    const apply = (event) => String(event?.id || '') === id ? { ...event, ...patch } : event;
    events = events.map(apply);
    allEvents = allEvents.map(apply);
  }
  function beginEventRangeSave(eventId = ''){
    const id = String(eventId || '');
    const version = (eventRangeSaveVersions.get(id) || 0) + 1;
    eventRangeSaveVersions.set(id, version);
    return version;
  }
  function queueEventRangeSave(eventId = '', save){
    const id = String(eventId || '');
    const previous = eventRangeSaveQueues.get(id) || Promise.resolve();
    const queued = previous.catch(() => null).then(save);
    eventRangeSaveQueues.set(id, queued);
    queued.finally(() => {
      if (eventRangeSaveQueues.get(id) === queued) eventRangeSaveQueues.delete(id);
    }).catch(() => null);
    return queued;
  }
  function mergeSavedCalendarEvent(saved = {}, fallback = {}, version = 0){
    const id = String(fallback.id || saved?.event?.id || '');
    if (!id || eventRangeSaveVersions.get(id) !== version) return false;
    const savedEvent = saved?.event || saved?.project?.events?.find?.((item) => String(item.id || '') === id) || fallback;
    updateLocalCalendarEvent(id, savedEvent);
    if (saved?.project?.id) {
      const { events:ignoredEvents, ...savedProjectFields } = saved.project;
      projects = projects.map((project) => {
        if (String(project.id || '') !== String(saved.project.id || '')) return project;
        const projectEvents = Array.isArray(project.events) ? project.events : [];
        return {
          ...project,
          ...savedProjectFields,
          events:projectEvents.map((item) => String(item.id || '') === id ? { ...item, ...savedEvent } : item)
        };
      });
    }
    events = visibleEvents();
    return true;
  }
  function ownValue(source = {}, key = ''){
    return Object.prototype.hasOwnProperty.call(source || {}, key) ? source[key] : undefined;
  }
  function firstOwnedClean(source = {}, keys = [], fallback = ''){
    for (const key of keys) {
      const value = ownValue(source, key);
      if (value !== undefined) return clean(value);
    }
    return clean(fallback);
  }
  function updateEditorDescription(value = ''){
    const ctx = eventEditorContext();
    if (!ctx) return;
    if (ctx.kind === 'floating') updateFloatingEvent({ ...ctx.event, description: value, notes: value });
    else if (ctx.editorOnly) updateLocalCalendarEvent(ctx.event?.id, { description: value, notes: value });
    else if (ctx.kind === 'materials') materialScheduleDraft = { ...(materialScheduleDraft || ctx.event || {}), description: value, notes: value };
    else if (ctx.kind === 'production') productionScheduleDraft = { ...(productionScheduleDraft || ctx.event || {}), description: value, notes: value };
    else appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), description: value, notes: value };
  }
  function updateEditorTitle(value = ''){
    const title = clean(value) || 'New Event';
    const ctx = eventEditorContext();
    if (!ctx) return;
    if (ctx.kind === 'floating') updateFloatingEvent({ ...ctx.event, title, project_title: ctx.event.project_id ? ctx.event.project_title : '', title_is_custom: true });
    else if (ctx.editorOnly) updateLocalCalendarEvent(ctx.event?.id, { title, title_is_custom: true });
    else if (ctx.kind === 'materials') materialScheduleDraft = { ...(materialScheduleDraft || ctx.event || {}), title, project_title: title, title_is_custom: true };
    else if (ctx.kind === 'production') productionScheduleDraft = { ...(productionScheduleDraft || ctx.event || {}), title, project_title: title, title_is_custom: true };
    else appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), title, project_title: title, title_is_custom: true };
  }
  function dateTimeLocalValue(value){
    const date = validDate(value);
    if (!date) return '';
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function dateInputValue(value){
    const date = validDate(value);
    if (!date) return '';
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  function updateEditorRange(which = 'start', value = ''){
    const ctx = eventEditorContext();
    const current = ctx?.event;
    if (!ctx || !current) return;
    const allDay = current.all_day === true || clean(current.schedule_granularity).toLowerCase() === 'date';
    const dateOnly = allDay && /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    const nextValue = dateOnly
      ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      : validDate(value);
    if (!nextValue) return;
    const previousStart = eventStart(current) || new Date();
    const previousEnd = eventEnd(current) || new Date(previousStart.getTime() + (allDay ? 86400000 : 3600000));
    let start = which === 'start' ? nextValue : previousStart;
    let end = which === 'end' ? nextValue : previousEnd;
    const minimumDuration = allDay ? 86400000 : 15 * 60000;
    const previousDuration = Math.max(minimumDuration, previousEnd.getTime() - previousStart.getTime());
    if (which === 'start' && end <= start) end = new Date(start.getTime() + previousDuration);
    if (which === 'end' && end <= start) end = new Date(start.getTime() + minimumDuration);
    const patch = {
      start,
      end,
      start_at:start.toISOString(),
      end_at:end.toISOString(),
      all_day:allDay,
      schedule_granularity:allDay ? 'date' : 'time'
    };
    if (ctx.kind === 'floating') updateFloatingEvent({ ...current, ...patch });
    else if (ctx.editorOnly) updateLocalCalendarEvent(current.id, patch);
    else if (ctx.kind === 'materials') materialScheduleDraft = { ...(materialScheduleDraft || current), ...patch };
    else if (ctx.kind === 'production') productionScheduleDraft = { ...(productionScheduleDraft || current), ...patch };
    else appointmentScheduleDraft = { ...(appointmentScheduleDraft || current), ...patch };
  }
  /* Stage a patch onto whatever the event editor is currently editing —
   * same dispatch the title/range/customer setters use. */
  function applyEditorPatch(patch = {}){
    const ctx = eventEditorContext();
    if (!ctx) return null;
    if (ctx.kind === 'floating') updateFloatingEvent({ ...ctx.event, ...patch });
    else if (ctx.editorOnly) updateLocalCalendarEvent(ctx.event?.id, patch);
    else if (ctx.kind === 'materials') materialScheduleDraft = { ...(materialScheduleDraft || ctx.event || {}), ...patch };
    else if (ctx.kind === 'production') productionScheduleDraft = { ...(productionScheduleDraft || ctx.event || {}), ...patch };
    else appointmentScheduleDraft = { ...(appointmentScheduleDraft || ctx.event || {}), ...patch };
    return ctx;
  }
  function updateEditorAllDay(nextAllDay = true){
    const current = eventEditorContext()?.event;
    if (!current) return;
    const start = eventStart(current) || new Date();
    let patch;
    if (nextAllDay) {
      const dayStart = startOfDay(start) || start;
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      patch = { start:dayStart, end:dayEnd, start_at:dayStart.toISOString(), end_at:dayEnd.toISOString(), all_day:true, schedule_granularity:'date' };
    } else {
      const timedStart = new Date(start);
      timedStart.setHours(9, 0, 0, 0);
      const duration = Math.max(15, Number(schedulingConfig?.event_types?.[eventTypeId(current)]?.duration_minutes || 60));
      const timedEnd = new Date(timedStart.getTime() + duration * 60000);
      patch = { start:timedStart, end:timedEnd, start_at:timedStart.toISOString(), end_at:timedEnd.toISOString(), all_day:false, schedule_granularity:'time' };
    }
    applyEditorPatch(patch);
  }
  function editorAssignmentUserList(event = {}){
    const ids = Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids.map(clean).filter(Boolean) : [];
    const named = Array.isArray(event.assigned_users) ? event.assigned_users : [];
    return ids.map((id) => ({ id, name: clean(named.find((user) => clean(user?.id) === id)?.name) || userDisplayName(id) }));
  }
  function updateEditorAssignees(list = []){
    const first = list[0] || null;
    applyEditorPatch({
      ...workResourcePayload({}),
      assigned_user_ids: list.map((user) => user.id),
      assigned_users: list.map((user) => ({ id:user.id, name:user.name })),
      assigned_user_id: first?.id || '',
      assigned_user_name: first?.name || ''
    });
  }
  function updateEditorCustomerSetting(field = '', value = false){
    if (!['customer_visible', 'customer_show_title', 'customer_show_crew', 'customer_description'].includes(field)) return;
    const patch = { [field]: field === 'customer_description' ? String(value || '') : value === true };
    const ctx = eventEditorContext();
    if (!ctx) return;
    if (ctx.kind === 'floating') updateFloatingEvent({ ...ctx.event, ...patch });
    else if (ctx.editorOnly) updateLocalCalendarEvent(ctx.event?.id, patch);
    else if (ctx.kind === 'materials') materialScheduleDraft = { ...(materialScheduleDraft || ctx.event || {}), ...patch };
    else if (ctx.kind === 'production') productionScheduleDraft = { ...(productionScheduleDraft || ctx.event || {}), ...patch };
    else appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), ...patch };
  }
  /* ── Appointment confirmation editor ──────────────────────────────────────
   * Per-appointment override of the company default: whether the customer is
   * asked to confirm, over which channels, and when the ask goes out. Merges
   * into the event's `confirmation` block, which the backend reconciles with
   * the send queue on save. */

  function editorConfirmation(draft = {}){
    const Scheduling = window.PlatformScheduling;
    const settings = Scheduling?.confirmationSettings?.() || {};
    const declared = draft?.confirmation && typeof draft.confirmation === 'object' ? draft.confirmation : null;
    const defaults = {
      required: settings.default_required === true,
      channels: { email: settings.channels?.email !== false, sms: settings.channels?.sms !== false },
      include_portal_link: settings.include_portal_link === true,
      schedule: settings.schedule || { mode:'morning_of', time_of_day:'09:00', offset_minutes:120, days_before:1 },
      no_response_action: settings.no_response_action || 'keep_reserved',
      confirmation_deadline_minutes_before: Number(settings.confirmation_deadline_minutes_before) || 0,
    };
    if (!declared) return defaults;
    return {
      required: declared.required === true,
      channels: {
        email: declared.channels?.email !== false,
        sms: declared.channels?.sms !== false,
      },
      include_portal_link: declared.include_portal_link === true,
      schedule: { ...defaults.schedule, ...(declared.schedule || {}) },
      no_response_action: declared.no_response_action || defaults.no_response_action,
      confirmation_deadline_minutes_before: Number(declared.confirmation_deadline_minutes_before ?? defaults.confirmation_deadline_minutes_before) || 0,
      status: declared.status,
    };
  }

  function updateEditorConfirmation(patch = {}){
    const ctx = eventEditorContext();
    if (!ctx) return;
    const current = editorConfirmation(ctx.event || {});
    const next = {
      ...current,
      ...patch,
      channels: { ...current.channels, ...(patch.channels || {}) },
      schedule: { ...current.schedule, ...(patch.schedule || {}) },
    };
    const update = { confirmation: next };
    if (ctx.kind === 'floating') updateFloatingEvent({ ...ctx.event, ...update });
    else if (ctx.editorOnly) updateLocalCalendarEvent(ctx.event?.id, update);
    else if (ctx.kind === 'materials') materialScheduleDraft = { ...(materialScheduleDraft || ctx.event || {}), ...update };
    else if (ctx.kind === 'production') productionScheduleDraft = { ...(productionScheduleDraft || ctx.event || {}), ...update };
    else appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), ...update };
  }

  function confirmationPillHtml(event = {}){
    const state = window.PlatformScheduling?.visibleConfirmationState?.(event);
    if (!state) return '';
    return `<span class="dash-event-status-pill confirm-${escapeHtml(state.tone)}" title="${escapeHtml(state.label)}"><i class="fas ${escapeHtml(state.icon)}"></i> ${escapeHtml(state.short)}</span>`;
  }

  function confirmationEditorHtml(ctx, draft = {}, project = {}){
    const Scheduling = window.PlatformScheduling;
    const settings = Scheduling?.confirmationSettings?.() || {};
    // Nothing to configure when the company hasn't turned confirmations on, or
    // when this viewer isn't allowed to see confirmation state at all.
    if (settings.enabled !== true) return '';
    if (Scheduling?.confirmationVisible && !Scheduling.confirmationVisible(settings)) return '';
    if (!project?.id && ctx.kind !== 'floating') return '';
    if (isMaterialEvent(draft)) return '';
    const confirmation = editorConfirmation(draft);
    const schedule = confirmation.schedule || {};
    const mode = clean(schedule.mode) || 'morning_of';
    const open = confirmation.required === true;
    const modeOption = (value, label) => `<option value="${escapeHtml(value)}" ${mode === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    const state = Scheduling?.confirmationState?.(draft);
    const statusLine = state && state.required && state.status !== 'pending'
      ? `<div class="dash-event-confirm-status ${escapeHtml(state.tone)}"><i class="fas ${escapeHtml(state.icon)}"></i> ${escapeHtml(state.label)}</div>`
      : '';
    return `
      <div class="dash-event-confirm-panel">
        <label class="dash-event-customer-share">
          <input type="checkbox" data-event-confirm-required ${String(open ? 'checked' : '')}>
          <span class="dash-event-share-switch" aria-hidden="true"></span>
          <span><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_ae86d3ed019015","Ask the customer to confirm") ?? "Ask the customer to confirm")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_956b2b7eb54d56","The appointment shows as unconfirmed until they reply.") ?? "The appointment shows as unconfirmed until they reply.")}</small></span>
        </label>
        ${String(statusLine)}
        <div class="dash-event-confirm-options ${String(open ? 'open' : '')}" data-event-confirm-options>
          <div class="dash-event-confirm-channels">
            <label class="dash-event-customer-option"><input type="checkbox" data-event-confirm-email ${String(confirmation.channels.email ? 'checked' : '')}><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_5d2b9327181e33","Email") ?? "Email")}</span></label>
            <label class="dash-event-customer-option"><input type="checkbox" data-event-confirm-sms ${String(confirmation.channels.sms ? 'checked' : '')}><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_def279b4381c15","Text message") ?? "Text message")}</span></label>
            <label class="dash-event-customer-option"><input type="checkbox" data-event-confirm-portal ${String(confirmation.include_portal_link ? 'checked' : '')}><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_0849e172757834","Include a portal link") ?? "Include a portal link")}</span></label>
          </div>
          <label class="dash-event-confirm-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_7a5263d78130e9","Send\n            ") ?? "Send\n            ")}<select data-event-confirm-mode>
              ${String(modeOption('morning_of', 'The morning of'))}
              ${String(modeOption('time_of_day', 'At a set time on the day'))}
              ${String(modeOption('before_offset', 'A set time before the appointment'))}
              ${String(modeOption('days_before', 'A set number of days before'))}
            </select>
          </label>
          <div class="dash-event-confirm-detail" data-event-confirm-detail>
            ${String(mode === 'before_offset'
              ? `<label class="dash-event-confirm-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_e9f168b05e36e6","Hours before") ?? "Hours before")}<input type="number" min="0.25" step="0.25" data-event-confirm-hours value="${escapeHtml(String((Number(schedule.offset_minutes) || 120) / 60))}"></label>`
              : `${mode === 'days_before' ? `<label class="dash-event-confirm-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3955ac79d2d28d","Days before") ?? "Days before")}<input type="number" min="0" max="30" data-event-confirm-days value="${escapeHtml(String(Number(schedule.days_before) || 1))}"></label>` : ''}
                 <label class="dash-event-confirm-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3b546ab0f78697","At") ?? "At")}<input type="time" data-event-confirm-time value="${escapeHtml(clean(schedule.time_of_day) || '09:00')}"></label>`)}
          </div>
          <div class="dash-event-confirm-detail">
            <label class="dash-event-confirm-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_ea811bc50a6ba0","Deadline (minutes before)") ?? "Deadline (minutes before)")}<input type="number" min="0" step="15" data-event-confirm-deadline value="${String(escapeHtml(String(confirmation.confirmation_deadline_minutes_before || 0)))}"></label>
            <label class="dash-event-confirm-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_1abad8244b5357","No reply") ?? "No reply")}<select data-event-confirm-no-response><option value="keep_reserved" ${String(confirmation.no_response_action === 'keep_reserved' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_1a20e8e3d1b803","Keep reserved") ?? "Keep reserved")}</option><option value="notify_staff" ${String(confirmation.no_response_action === 'notify_staff' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_6e2a45391b23f8","Notify staff") ?? "Notify staff")}</option><option value="release_to_unscheduled" ${String(confirmation.no_response_action === 'release_to_unscheduled' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_a35abb5a7521a1","Release slot") ?? "Release slot")}</option><option value="cancel" ${String(confirmation.no_response_action === 'cancel' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_cbef679b21abb4","Cancel") ?? "Cancel")}</option></select></label>
          </div>
        </div>
      </div>
    `;
  }

  function bindConfirmationEditor(pop, draft = {}){
    const rerender = () => setTimeout(() => renderEventDraftPopover(editorAnchorFor(draft.id)), 0);
    pop.querySelector('[data-event-confirm-required]')?.addEventListener('change', (event) => {
      updateEditorConfirmation({ required: event.target.checked === true });
      pop.querySelector('[data-event-confirm-options]')?.classList.toggle('open', event.target.checked === true);
    });
    pop.querySelector('[data-event-confirm-email]')?.addEventListener('change', (event) => {
      updateEditorConfirmation({ channels: { email: event.target.checked === true } });
    });
    pop.querySelector('[data-event-confirm-sms]')?.addEventListener('change', (event) => {
      updateEditorConfirmation({ channels: { sms: event.target.checked === true } });
    });
    pop.querySelector('[data-event-confirm-portal]')?.addEventListener('change', (event) => {
      updateEditorConfirmation({ include_portal_link: event.target.checked === true });
    });
    pop.querySelector('[data-event-confirm-deadline]')?.addEventListener('change', (event) => updateEditorConfirmation({ confirmation_deadline_minutes_before:Math.max(0, Number(event.target.value) || 0) }));
    pop.querySelector('[data-event-confirm-no-response]')?.addEventListener('change', (event) => updateEditorConfirmation({ no_response_action:event.target.value || 'keep_reserved' }));
    pop.querySelector('[data-event-confirm-mode]')?.addEventListener('change', (event) => {
      // The follow-up fields differ per mode, so redraw rather than juggle them.
      updateEditorConfirmation({ schedule: { mode: event.target.value || 'morning_of' } });
      rerender();
    });
    pop.querySelector('[data-event-confirm-time]')?.addEventListener('change', (event) => {
      updateEditorConfirmation({ schedule: { time_of_day: event.target.value || '09:00' } });
    });
    pop.querySelector('[data-event-confirm-days]')?.addEventListener('change', (event) => {
      updateEditorConfirmation({ schedule: { days_before: Math.max(0, Number(event.target.value) || 0) } });
    });
    pop.querySelector('[data-event-confirm-hours]')?.addEventListener('change', (event) => {
      const hours = Math.max(0.25, Number(event.target.value) || 2);
      updateEditorConfirmation({ schedule: { offset_minutes: Math.round(hours * 60) } });
    });
  }

  function editorCustomerScheduling(draft = {}){
    const eventTypeId = clean(draft.event_type_default_id || draft.type_id || draft.event_type_id || 'sales_appointment');
    const typePolicy = schedulingConfig?.event_types?.[eventTypeId]?.customer_scheduling || {};
    const companyPolicy = schedulingConfig?.scheduling?.self_service?.default_policy || schedulingConfig?.self_service?.default_policy || {};
    const declared = draft.customer_scheduling && typeof draft.customer_scheduling === 'object' ? draft.customer_scheduling : {};
    return {
      ...companyPolicy,
      ...typePolicy,
      ...declared,
      enabled:declared.enabled === undefined ? (typePolicy.enabled === true || companyPolicy.enabled === true) : declared.enabled === true,
      actions:Array.isArray(declared.actions) ? declared.actions : Array.isArray(typePolicy.actions) ? typePolicy.actions : ['reschedule'],
      min_notice_minutes:Number(declared.min_notice_minutes ?? typePolicy.min_notice_minutes ?? companyPolicy.min_notice_minutes ?? 120),
      booking_horizon_days:Number(declared.booking_horizon_days ?? typePolicy.booking_horizon_days ?? companyPolicy.booking_horizon_days ?? 45),
      max_reschedules:Number(declared.max_reschedules ?? typePolicy.max_reschedules ?? companyPolicy.max_reschedules ?? 3),
      assignment_mode:clean(declared.assignment_mode || typePolicy.assignment_mode || companyPolicy.assignment_mode || 'best_available'),
      reschedule_approval:clean(declared.reschedule_approval || typePolicy.reschedule_approval || companyPolicy.reschedule_approval || 'automatic'),
      reschedule_staff_notification:(declared.reschedule_staff_notification ?? typePolicy.reschedule_staff_notification ?? companyPolicy.reschedule_staff_notification) === true,
      reschedule_review_todo:(declared.reschedule_review_todo ?? typePolicy.reschedule_review_todo ?? companyPolicy.reschedule_review_todo) !== false,
      reschedule_customer_notification:clean(declared.reschedule_customer_notification || typePolicy.reschedule_customer_notification || companyPolicy.reschedule_customer_notification || 'none')
    };
  }

  function updateEditorCustomerScheduling(patch = {}){
    const ctx = eventEditorContext();
    if (!ctx) return;
    const current = editorCustomerScheduling(ctx.event || {});
    const update = { customer_scheduling:{ ...current, ...patch } };
    if (ctx.kind === 'floating') updateFloatingEvent({ ...ctx.event, ...update });
    else if (ctx.editorOnly) updateLocalCalendarEvent(ctx.event?.id, update);
    else if (ctx.kind === 'materials') materialScheduleDraft = { ...(materialScheduleDraft || ctx.event || {}), ...update };
    else if (ctx.kind === 'production') productionScheduleDraft = { ...(productionScheduleDraft || ctx.event || {}), ...update };
    else appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), ...update };
  }

  function customerSchedulingEditorHtml(ctx, draft = {}, project = {}){
    if (window.Portal?.can?.('scheduling.customer_rescheduling') !== true) return '';
    if (!project?.id || isMaterialEvent(draft)) return '';
    const policy = editorCustomerScheduling(draft);
    const open = policy.enabled === true;
    const request = draft.reschedule_request && typeof draft.reschedule_request === 'object' ? draft.reschedule_request : {};
    const pending = clean(request.status) === 'pending';
    const requestedAt = new Date(request.requested_start_at || '');
    const requestedLabel = Number.isFinite(requestedAt.getTime()) ? requestedAt.toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : clean(request.requested_start_at);
    return `<div class="dash-event-confirm-panel customer-scheduling">
      ${String(pending ? `<div class="dash-reschedule-review"><div><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8af1d7ae3a4dbf","Customer requested a change") ?? "Customer requested a change")}</strong><small>${((v0) => globalThis.PlatformLanguage?.htmlText("scheduling","m_ca28a4d7fe5428",`Requested ${v0}. The current appointment remains reserved until this is reviewed.`,{v0}) ?? `Requested ${v0}. The current appointment remains reserved until this is reviewed.`)(escapeHtml(requestedLabel))}</small></div><div><button type="button" data-event-reschedule-review="declined">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_0bba16c1fd1444","Decline") ?? "Decline")}</button><button type="button" class="approve" data-event-reschedule-review="approved">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_b7af2068fe4024","Approve change") ?? "Approve change")}</button></div></div>` : '')}
      <label class="dash-event-customer-share">
        <input type="checkbox" data-event-self-schedule ${String(open ? 'checked' : '')}>
        <span class="dash-event-share-switch" aria-hidden="true"></span>
        <span><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3917e5ee30f080","Customer can reschedule") ?? "Customer can reschedule")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_cd1d07a489e034","Uses live crew, group, buffer, travel, and capacity rules.") ?? "Uses live crew, group, buffer, travel, and capacity rules.")}</small></span>
      </label>
      <div class="dash-event-confirm-options ${String(open ? 'open' : '')}" data-event-self-schedule-options>
        ${String(draft.customer_visible === true ? '' : `<div class="dash-event-confirm-status warning"><i class="fas fa-eye-slash"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_746250c5372a9a"," Share this appointment with the customer to show the portal action.") ?? " Share this appointment with the customer to show the portal action.")}</div>`)}
        <div class="dash-event-confirm-detail">
          <label class="dash-event-confirm-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3eb3bf7ffda86b","Minimum notice") ?? "Minimum notice")}<input data-event-self-notice type="number" min="0" max="43200" step="15" value="${String(escapeHtml(policy.min_notice_minutes))}"></label>
          <label class="dash-event-confirm-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_5cd440b771cd4f","Book ahead (days)") ?? "Book ahead (days)")}<input data-event-self-horizon type="number" min="1" max="365" value="${String(escapeHtml(policy.booking_horizon_days))}"></label>
          <label class="dash-event-confirm-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_78590ee40f42cc","Maximum changes") ?? "Maximum changes")}<input data-event-self-max type="number" min="0" max="20" value="${String(escapeHtml(policy.max_reschedules))}"></label>
          <label class="dash-event-confirm-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_a4873ee268e55f","Assignment") ?? "Assignment")}<select data-event-self-assignment><option value="best_available" ${String(policy.assignment_mode === 'best_available' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_daeed1c0def75c","Best available") ?? "Best available")}</option><option value="preserve" ${String(policy.assignment_mode === 'preserve' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8b680b11521f7c","Keep current") ?? "Keep current")}</option><option value="customer_choice" ${String(policy.assignment_mode === 'customer_choice' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3f1f47526e44ae","Customer chooses") ?? "Customer chooses")}</option></select></label>
          <label class="dash-event-confirm-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_b0bb1e74e2a6d3","Review") ?? "Review")}<select data-event-self-approval><option value="automatic" ${String(policy.reschedule_approval !== 'required' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_18cf443d1817db","Apply immediately") ?? "Apply immediately")}</option><option value="required" ${String(policy.reschedule_approval === 'required' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_f9c174308ab0b5","Require approval") ?? "Require approval")}</option></select></label>
          <label class="dash-event-confirm-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_0a9031a3a78e3f","Customer update") ?? "Customer update")}<select data-event-self-customer-notification><option value="none" ${String(policy.reschedule_customer_notification === 'none' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_c397a240c1f8c1","Portal only") ?? "Portal only")}</option><option value="sms" ${String(policy.reschedule_customer_notification === 'sms' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_124287f184b88b","Text") ?? "Text")}</option><option value="email" ${String(policy.reschedule_customer_notification === 'email' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_5d2b9327181e33","Email") ?? "Email")}</option><option value="both" ${String(policy.reschedule_customer_notification === 'both' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_bf964384bc8207","Text + email") ?? "Text + email")}</option></select></label>
        </div>
        <div class="dash-event-confirm-channels"><label class="dash-event-customer-option"><input type="checkbox" data-event-self-staff-notification ${String(policy.reschedule_staff_notification ? 'checked' : '')}><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_dbc0e821db2902","Notify staff on changes") ?? "Notify staff on changes")}</span></label><label class="dash-event-customer-option"><input type="checkbox" data-event-self-review-todo ${String(policy.reschedule_review_todo ? 'checked' : '')}><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_85e59d6a0fccc3","Create approval to-do") ?? "Create approval to-do")}</span></label></div>
      </div>
    </div>`;
  }

  function bindCustomerSchedulingEditor(pop){
    pop.querySelector('[data-event-self-schedule]')?.addEventListener('change', (event) => {
      updateEditorCustomerScheduling({ enabled:event.target.checked === true, actions:['reschedule'] });
      pop.querySelector('[data-event-self-schedule-options]')?.classList.toggle('open', event.target.checked === true);
    });
    pop.querySelector('[data-event-self-notice]')?.addEventListener('change', (event) => updateEditorCustomerScheduling({ min_notice_minutes:Math.max(0, Number(event.target.value) || 0) }));
    pop.querySelector('[data-event-self-horizon]')?.addEventListener('change', (event) => updateEditorCustomerScheduling({ booking_horizon_days:Math.max(1, Number(event.target.value) || 45) }));
    pop.querySelector('[data-event-self-max]')?.addEventListener('change', (event) => updateEditorCustomerScheduling({ max_reschedules:Math.max(0, Number(event.target.value) || 0) }));
    pop.querySelector('[data-event-self-assignment]')?.addEventListener('change', (event) => updateEditorCustomerScheduling({ assignment_mode:event.target.value || 'best_available' }));
    pop.querySelector('[data-event-self-approval]')?.addEventListener('change', (event) => updateEditorCustomerScheduling({ reschedule_approval:event.target.value || 'automatic' }));
    pop.querySelector('[data-event-self-customer-notification]')?.addEventListener('change', (event) => updateEditorCustomerScheduling({ reschedule_customer_notification:event.target.value || 'none' }));
    pop.querySelector('[data-event-self-staff-notification]')?.addEventListener('change', (event) => updateEditorCustomerScheduling({ reschedule_staff_notification:event.target.checked === true }));
    pop.querySelector('[data-event-self-review-todo]')?.addEventListener('change', (event) => updateEditorCustomerScheduling({ reschedule_review_todo:event.target.checked === true }));
    pop.querySelectorAll('[data-event-reschedule-review]').forEach((button) => button.addEventListener('click', async () => {
      const ctx = eventEditorContext();
      if (!ctx?.project?.id || !ctx.event?.id) return;
      const decision = button.dataset.eventRescheduleReview;
      pop.querySelectorAll('[data-event-reschedule-review]').forEach((entry) => { entry.disabled = true; });
      try {
        await window.PlatformAPI?.appointments?.reviewReschedule?.(orgId(), ctx.project.id, ctx.event.id, decision);
        closeEventDraftPopover();
        await loadData({ force:true });
        showToast(decision === 'approved' ? 'Appointment change approved' : 'Appointment change declined', decision === 'approved' ? 'The new time is now on the project schedule.' : 'The original appointment remains scheduled.', true);
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_3330f4f8d5af70","Could not review change") ?? "Could not review change"), error?.message || 'Try again.', false);
        pop.querySelectorAll('[data-event-reschedule-review]').forEach((entry) => { entry.disabled = false; });
      }
    }));
  }

  function cancelEventEditor(){
    const ctx = eventEditorContext();
    if (ctx?.kind === 'floating' && ctx.event?.status === 'draft') {
      floatingEvents = floatingEvents.filter((event) => String(event.id || '') !== String(ctx.event.id || ''));
    } else if (ctx) clearPlacementSelection();
    eventDraftPopoverId = '';
    eventEditorEventId = '';
    eventDraftProjectQuery = '';
    eventCustomerDetailsOpen = false;
    eventAdvancedOpen = false;
    closeEventDraftPopover();
    render();
  }
  function eventRecurrenceOptions(popover){
    const enabled = popover?.querySelector('[data-event-recurring]')?.checked === true;
    const endMode = clean(popover?.querySelector('[data-event-recurrence-end-mode]')?.value || 'never');
    const endDate = clean(popover?.querySelector('[data-event-recurrence-end]')?.value || '');
    const occurrenceCount = Math.max(1, Math.min(240, Math.round(Number(popover?.querySelector('[data-event-recurrence-count]')?.value || 1) || 1)));
    const amount = Number.parseFloat(popover?.querySelector('[data-event-billing-amount]')?.value || '');
    const expense = Number.parseFloat(popover?.querySelector('[data-event-expense-amount]')?.value || '');
    return {
      enabled,
      recurrence: {
        frequency: clean(popover?.querySelector('[data-event-recurrence-frequency]')?.value || 'monthly') || 'monthly',
        interval: Math.max(1, Math.round(Number(popover?.querySelector('[data-event-recurrence-interval]')?.value || 1) || 1)),
        end_at: endMode === 'date' && endDate ? new Date(`${endDate}T23:59:59`).toISOString() : '',
        occurrence_count: endMode === 'count' ? occurrenceCount : null
      },
      billing: {
        enabled: Number.isFinite(amount) && amount > 0,
        amount_cents: Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0,
        frequency: clean(popover?.querySelector('[data-event-billing-frequency]')?.value || 'monthly') || 'monthly'
      },
      expenses: {
        enabled: Number.isFinite(expense) && expense > 0,
        amount_cents: Number.isFinite(expense) ? Math.max(0, Math.round(expense * 100)) : 0
      }
    };
  }
  function recurrencePayloadForEvent(event = {}, options = {}){
    const start = eventStart(event);
    const end = eventEnd(event);
    const duration = start && end && end > start ? Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000)) : 60;
    const type = eventTypeId(event) || 'custom';
    return {
      branch_id: branchId(),
      project_id: clean(event.project_id),
      title: clean(event.title || event.project_title) || 'Recurring appointment',
      start_at: start?.toISOString(),
      recurrence: options.recurrence,
      event_template: {
        title: clean(event.title || event.project_title) || 'Recurring appointment',
        description: clean(event.description || event.notes),
        notes: clean(event.notes || event.description),
        event_type_default_id: type,
        type_id: type,
        event_type_id: type,
        duration_minutes: duration,
        assigned_user_ids: Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : [],
        assigned_users: Array.isArray(event.assigned_users) ? event.assigned_users : [],
        resource_refs: Array.isArray(event.resource_refs) ? event.resource_refs : [],
        resource_requirements: Array.isArray(event.resource_requirements) ? event.resource_requirements : [],
        crew_id: clean(event.crew_id),
        crew_name: clean(event.crew_name),
        customer_visible: event.customer_visible === true,
        customer_show_title: event.customer_show_title !== false,
        customer_show_crew: event.customer_show_crew === true,
        customer_description: clean(event.customer_description)
      },
      billing: options.billing,
      expenses: options.expenses
    };
  }
  async function saveEventEditor(recurrenceOptions = {}){
    const ctx = eventEditorContext();
    if (!ctx) return;
    if (ctx.kind === 'floating' && recurrenceOptions.enabled) {
      const payload = recurrencePayloadForEvent(ctx.event, recurrenceOptions);
      if (!payload.start_at) {
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_1de685e881b782","Choose a time first") ?? "Choose a time first"), (globalThis.PlatformLanguage?.text("scheduling","m_52ca64c3f28350","Recurring items need a first calendar date and time.") ?? "Recurring items need a first calendar date and time."), false);
        return;
      }
      closeEventDraftPopover();
      try {
        const seriesId = clean(ctx.event.recurrence_series_id);
        if (seriesId) await window.PlatformAPI?.projects?.updateRecurrenceSeries?.(orgId(), seriesId, payload);
        else await window.PlatformAPI?.projects?.createRecurrenceSeries?.(orgId(), payload);
        floatingEvents = floatingEvents.filter((event) => String(event.id || '') !== String(ctx.event.id || ''));
        eventDraftPopoverId = '';
        eventEditorEventId = '';
        eventDraftProjectQuery = '';
        render();
        await loadData({ force: true });
        showToast(seriesId ? 'Recurring item updated' : 'Recurring item created', (globalThis.PlatformLanguage?.text("scheduling","m_bd00f676f7e893","Its upcoming calendar occurrences are ready.") ?? "Its upcoming calendar occurrences are ready."), true);
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_0c17d9fba77f09","Could not save recurring item") ?? "Could not save recurring item"), error?.message || 'Try again.', false);
        setTimeout(() => renderEventDraftPopover(editorAnchorFor(ctx.event.id)), 0);
      }
      return;
    }
    closeEventDraftPopover();
    if (ctx.kind === 'floating') {
      const next = updateFloatingEvent({
        ...ctx.event,
        __draft: false,
        __activeDraft: false,
        status: 'scheduled'
      });
      eventDraftPopoverId = '';
      eventEditorEventId = '';
      eventDraftProjectQuery = '';
      render();
      try {
        const saved = await persistFloatingEvent(next);
        updateFloatingEvent({
          ...next,
          ...saved,
          __draft: false,
          __activeDraft: false,
          status: 'scheduled'
        });
        render();
      } catch (error) {
        const draft = updateFloatingEvent({
          ...next,
          __draft: true,
          __activeDraft: true,
          status: 'draft'
        });
        eventDraftPopoverId = draft.id;
        eventEditorEventId = '';
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_90522d8e2312ca","Event not saved") ?? "Event not saved"), error?.message || 'Could not save the event.', false);
        render();
        setTimeout(() => renderEventDraftPopover(editorAnchorFor(draft.id)), 0);
      }
      return;
    }
    if (ctx.editorOnly) {
      const next = eventCalendarItems().find((event) => String(event.id || '') === String(ctx.event?.id || ''))
        || allEvents.find((event) => String(event.id || '') === String(ctx.event?.id || ''))
        || ctx.event;
      const Scheduling = window.PlatformScheduling;
      if (!Scheduling || !ctx.project?.id || !next?.id) return;
      closeEventDraftPopover();
      try {
        await Scheduling.saveProjectEvent(orgId(), ctx.project, next, schedulingConfig);
        clearPlacementSelection();
        eventEditorEventId = '';
        eventDraftProjectQuery = '';
        await loadData({ force: true });
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_13c761fb4b644a","Event updated") ?? "Event updated"), next.customer_visible === true ? 'This event is shared with the customer.' : 'This event is internal only.', true);
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_90522d8e2312ca","Event not saved") ?? "Event not saved"), error?.message || 'Could not update the event.', false);
        setTimeout(() => renderEventDraftPopover(editorAnchorFor(next.id)), 0);
      }
      return;
    }
    if (ctx.kind === 'production') {
      if (!productionScheduleDraft?.start && ctx.event?.start) productionScheduleDraft = { ...(productionScheduleDraft || {}), ...ctx.event };
      await confirmProductionDraft();
      return;
    }
    if (ctx.kind === 'materials') {
      if (!materialScheduleDraft?.start && ctx.event?.start) materialScheduleDraft = { ...(materialScheduleDraft || {}), ...ctx.event };
      await confirmMaterialDraft();
      return;
    }
    if (ctx.kind === 'sales') {
      if (!appointmentScheduleDraft?.start && ctx.event?.start) appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), start: ctx.event.start };
      await confirmDashboardDraft();
    }
  }
  async function deleteEventEditor(ctx, draft, button = null){
    const eventId = clean(draft?.id);
    if (!eventId || eventId.startsWith('__')) return;
    const disposableFloatingDraft = ctx.kind === 'floating'
      && (draft.__draft === true || clean(draft.status).toLowerCase() === 'draft');
    const confirmDelete = window.PlatformUI?.confirm;
    if (!confirmDelete) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_fe99e3347c6980","Delete unavailable") ?? "Delete unavailable"), (globalThis.PlatformLanguage?.text("scheduling","m_f60adc85aab1a2","The styled confirmation system is not available.") ?? "The styled confirmation system is not available."), false);
      return;
    }
    const label = clean(draft.title || draft.project_title) || 'this event';
    const approved = await confirmDelete(`Delete “${label}”? This cannot be undone.`, {
      title: (globalThis.PlatformLanguage?.text("scheduling","m_7f5580dbb3d648","Delete event") ?? "Delete event"),
      okLabel: 'Delete',
      cancelLabel: 'Keep event',
      danger: true
    });
    if (!approved) return;
    if (button) button.disabled = true;
    try {
      let savedProject = null;
      if (ctx.kind === 'floating') {
        if (!disposableFloatingDraft) {
          if (!window.PlatformAPI?.calendarEvents?.remove) throw new Error('Calendar event deletion is not configured.');
          await window.PlatformAPI.calendarEvents.remove(orgId(), eventId);
        }
        floatingEvents = floatingEvents.filter((event) => String(event.id || '') !== eventId);
      } else {
        if (!ctx.project?.id || !window.PlatformScheduling?.removeProjectEvent) throw new Error('Project event deletion is not configured.');
        const result = await window.PlatformScheduling.removeProjectEvent(orgId(), ctx.project, eventId, schedulingConfig);
        savedProject = result?.project || null;
      }
      allEvents = allEvents.filter((event) => String(event.id || '') !== eventId);
      events = events.filter((event) => String(event.id || '') !== eventId);
      if (savedProject?.id) {
        projects = projects.map((project) => String(project.id || '') === String(savedProject.id) ? savedProject : project);
      } else if (ctx.project?.id) {
        projects = projects.map((project) => String(project.id || '') === String(ctx.project.id)
          ? { ...project, events:(Array.isArray(project.events) ? project.events : []).filter((event) => String(event.id || '') !== eventId) }
          : project);
      }
      eventDraftPopoverId = '';
      eventEditorEventId = '';
      eventDraftProjectQuery = '';
      clearPlacementSelection();
      closeEventDraftPopover();
      render();
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_2183488d5ed71c","Event deleted") ?? "Event deleted"), disposableFloatingDraft ? `${label} was discarded.` : `${label} was removed from the calendar.`, true);
    } catch (error) {
      if (button) button.disabled = false;
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_ad38658fe6f432","Event not deleted") ?? "Event not deleted"), error?.message || 'Could not delete the event.', false);
    }
  }
  /* Assignee editor inside the event popover: shows every current assignee
   * (a crew/group is ONE chip — a reference, never expanded to its members),
   * with remove buttons and an add-menu of policy-eligible subjects. Only for
   * persisted events and floating items; placement drafts keep their own
   * single-assignee flow. */
  function eventAssigneeSectionHtml(ctx, draft){
    const delivery = isMaterialEvent(draft) || eventTypeId(draft) === 'delivery';
    if (delivery && !eventAdvancedOpen) return '';
    if (ctx.editorOnly !== true && ctx.kind !== 'floating' && !eventAdvancedOpen) return '';
    const crewId = workCrewId(draft);
    const crewName = workCrewName(draft);
    const assignees = crewId ? [] : editorAssignmentUserList(draft);
    const eligible = assignmentResourcesForEvent(draft);
    const eligibleIds = new Set(eligible.map((resource) => clean(resource.id)));
    const chips = crewId
      ? `<span class="dash-event-assignee-chip">${String(escapeHtml(crewName || userDisplayName(crewId)))}<button type="button" data-event-assign-remove="${String(escapeHtml(crewId))}" aria-label="${((v2) => globalThis.PlatformLanguage?.htmlText("scheduling","m_b44c243626b37c",`Remove ${v2}`,{v2}) ?? `Remove ${v2}`)(escapeHtml(crewName || 'assignment'))}">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_dd0c616953d455","&times;") ?? "&times;")}</button></span>`
      : assignees.map((user) => ("<span class=\"dash-event-assignee-chip " + String(eligibleIds.has(user.id) ? '' : 'warn') + "\" " + String(eligibleIds.has(user.id) ? '' : 'title="Not eligible for this event type — saving may be rejected"') + ">" + String(escapeHtml(user.name)) + "<button type=\"button\" data-event-assign-remove=\"" + String(escapeHtml(user.id)) + "\" aria-label=\"" + ((v4) => globalThis.PlatformLanguage?.text("scheduling","m_ab4ce544c27195",`Remove ${v4}`,{v4}) ?? `Remove ${v4}`)(escapeHtml(user.name)) + "\">" + (globalThis.PlatformLanguage?.text("scheduling","m_dd0c616953d455","&times;") ?? "&times;") + "</button></span>")).join('');
    const options = eligible
      .filter((resource) => clean(resource.id) !== crewId && !assignees.some((user) => user.id === clean(resource.id)))
      .map((resource) => `<button type="button" data-event-assign-id="${escapeHtml(resource.id)}">${escapeHtml(resource.name)}${clean(resource.subject_type || resource.resource_kind) === 'organization_user' ? '' : ` <small>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_d3cad057a8d23c","(assigns the whole team as one unit)") ?? "(assigns the whole team as one unit)")}</small>`}</button>`)
      .join('');
    return `<div class="dash-event-assignees">
      <div class="dash-event-assignees-head"><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2f9d72baaebef0","Assigned") ?? "Assigned")}</strong><button type="button" class="dash-event-assign-add" data-event-assign-add aria-expanded="false"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8803dece55359d"," Add") ?? " Add")}</button></div>
      <div class="dash-event-assignee-chips">${String(chips || `<span class="dash-event-assignee-empty">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8a993ed9b573b4","Unassigned") ?? "Unassigned")}</span>`)}</div>
      <div class="dash-event-assign-menu" data-event-assign-menu hidden>${String(options || `<div class="dash-event-assignee-empty" style="padding:7px 9px;">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_0a906f5bfd87a7","Nobody else is eligible for this event type.") ?? "Nobody else is eligible for this event type.")}</div>`)}</div>
    </div>`;
  }
  function renderEventDraftPopover(anchor = null){
    const ctx = eventEditorContext();
    if (!ctx) return;
    const draft = ctx.event || {};
    const project = ctx.project || {};
    closeEventDraftPopover();
    const rect = anchor?.getBoundingClientRect?.() || editorAnchorFor(draft.id)?.getBoundingClientRect?.();
    const pop = document.createElement('div');
    pop.className = 'dash-event-popover';
    const activeType = eventTypeId(draft);
    const typeButton = (id, label) => `<button type="button" class="dash-event-type-btn ${activeType === id ? 'active' : ''}" data-event-type="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
    const results = projectSearchResults(eventDraftProjectQuery);
    const typeMeta = eventTypeMeta(activeType);
    const projectLabel = project?.id ? projectTitle(project) : (draft.project_title && draft.project_title !== draft.title ? draft.project_title : 'No project selected');
    const projectAddressLabel = clean(project?.address || project?.project_address || draft.project_address || draft.address) || 'No project address';
    const projectNameHtml = norm(projectLabel) === norm(projectAddressLabel)
      ? ''
      : `<div class="dash-event-pop-project-name">${escapeHtml(projectLabel)}</div>`;
    const disposableFloatingDraft = ctx.kind === 'floating'
      && (draft.__draft === true || clean(draft.status).toLowerCase() === 'draft');
    const canClearProject = disposableFloatingDraft && !!clean(draft.project_id);
    const clearableProjectNameHtml = projectNameHtml || (canClearProject ? `<div class="dash-event-pop-project-name">${escapeHtml(projectLabel)}</div>` : '');
    const projectNameRowHtml = clearableProjectNameHtml || canClearProject
      ? `<div class="dash-event-pop-project-name-row">${clearableProjectNameHtml}${canClearProject ? `<button type="button" class="dash-event-project-clear" data-event-project-clear aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_998fea4513bf2a","Remove selected project") ?? "Remove selected project")}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_998fea4513bf2a","Remove selected project") ?? "Remove selected project")}"><i class="fas fa-xmark"></i></button>` : ''}</div>`
      : '';
    const materialNotOrdered = isMaterialEvent(draft) && !materialEventIsOrdered(draft);
    const canSave = ctx.kind === 'floating' || ctx.editorOnly === true || !!draft.start || !!productionScheduleDraft?.start || !!appointmentScheduleDraft?.start;
    const persistedFloatingEvent = ctx.kind === 'floating'
      && clean(draft.status).toLowerCase() === 'scheduled'
      && draft.__draft !== true;
    const canDelete = !!clean(draft.id)
      && !clean(draft.id).startsWith('__')
      && (ctx.kind === 'floating' ? (persistedFloatingEvent || disposableFloatingDraft) : !!project?.id);
    const canToggleLock = (!!project?.id || persistedFloatingEvent)
      && !!clean(draft.id)
      && !clean(draft.id).startsWith('__')
      && draft.__draft !== true;
    const editorAllDay = draft.all_day === true || clean(draft.schedule_granularity).toLowerCase() === 'date';
    const timeInputType = editorAllDay ? 'date' : 'datetime-local';
    const timeValue = editorAllDay ? dateInputValue : dateTimeLocalValue;
    const draftRecurrence = draft.recurrence && typeof draft.recurrence === 'object' ? draft.recurrence : {};
    const recurrenceFrequency = clean(draftRecurrence.frequency || 'monthly') || 'monthly';
    const recurrenceInterval = Math.max(1, Math.round(Number(draftRecurrence.interval || 1) || 1));
    const recurrenceEndMode = Number(draftRecurrence.occurrence_count) > 0 ? 'count' : (clean(draftRecurrence.end_at) ? 'date' : 'never');
    const recurrenceEndDate = clean(draftRecurrence.end_at).slice(0, 10);
    const recurrenceCount = Math.max(1, Math.round(Number(draftRecurrence.occurrence_count || 1) || 1));
    const recurrenceEnabled = clean(draft.recurrence_series_id) || draft.__recurrence_enabled === true;
    pop.innerHTML = `
      <div class="dash-event-pop-head">
        <input class="dash-event-title-input" data-event-title value="${String(escapeHtml(draft.title || draft.project_title || 'New Event'))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_e070e90d9c7a33","Event title") ?? "Event title")}">
        <button type="button" class="dash-event-close" data-event-cancel aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_304d419cb3596b","Cancel event") ?? "Cancel event")}"><i class="fas fa-xmark"></i></button>
        <div class="dash-event-pop-meta">
          ${String(projectNameRowHtml)}
          <div class="dash-event-pop-address">${String(escapeHtml(projectAddressLabel))}</div>
          <div class="dash-event-pop-time">${String(escapeHtml(formatEventDraftTime(draft)))}</div>
        </div>
        <div class="dash-event-time-fields">
          <label class="dash-event-time-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_5a35275926b722","Start") ?? "Start")}<input type="${String(timeInputType)}" data-event-start value="${String(escapeHtml(timeValue(eventStart(draft))))}"></label>
          <label class="dash-event-time-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_80cfdb09a78f4b","End") ?? "End")}<input type="${String(timeInputType)}" data-event-end value="${String(escapeHtml(timeValue(eventEnd(draft))))}"></label>
        </div>
        <div class="dash-event-time-options">
          <label class="dash-event-switch"><input type="checkbox" data-event-allday ${String(editorAllDay ? 'checked' : '')}><span class="dash-event-switch-track" aria-hidden="true"></span><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_42b02bf1587e27","All day") ?? "All day")}</span></label>
          ${String(ctx.kind === 'floating' ? `<label class="dash-event-switch"><input type="checkbox" data-event-recurring ${recurrenceEnabled ? 'checked' : ''}><span class="dash-event-switch-track" aria-hidden="true"></span><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_14bec9b094ca21","Recurring") ?? "Recurring")}</span></label>` : '')}
        </div>
        ${String(ctx.kind === 'floating' ? `<div class="dash-event-recurrence-fields ${recurrenceEnabled ? 'open' : ''}" data-event-recurrence-fields>
          <label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_477ebb1c6c5f83","Repeats") ?? "Repeats")}<select data-event-recurrence-frequency><option value="weekly" ${recurrenceFrequency === 'weekly' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_093d55e6272fc0","Weekly") ?? "Weekly")}</option><option value="monthly" ${recurrenceFrequency === 'monthly' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_d7014f792d2583","Monthly") ?? "Monthly")}</option><option value="quarterly" ${recurrenceFrequency === 'quarterly' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_03e59d03617275","Quarterly") ?? "Quarterly")}</option><option value="yearly" ${recurrenceFrequency === 'yearly' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_ef289ba5429ef5","Yearly") ?? "Yearly")}</option><option value="daily" ${recurrenceFrequency === 'daily' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_aa2628166dd6f2","Daily") ?? "Daily")}</option></select></label>
          <label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_b25bba33f32e79","Every") ?? "Every")}<input type="number" min="1" max="120" value="${escapeHtml(recurrenceInterval)}" data-event-recurrence-interval></label>
          <label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_949158d13efad4","Ends") ?? "Ends")}<select data-event-recurrence-end-mode><option value="never" ${recurrenceEndMode === 'never' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_35304e673f218d","Never") ?? "Never")}</option><option value="date" ${recurrenceEndMode === 'date' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_ab4cb92c128c9b","On a date") ?? "On a date")}</option><option value="count" ${recurrenceEndMode === 'count' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_58e24f3e842b25","After a number of times") ?? "After a number of times")}</option></select></label>
          <label data-event-recurrence-end-date ${recurrenceEndMode === 'date' ? '' : 'hidden'}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_75319fcfef3f5e","End date") ?? "End date")}<input type="date" value="${escapeHtml(recurrenceEndDate)}" data-event-recurrence-end></label>
          <label data-event-recurrence-end-count ${recurrenceEndMode === 'count' ? '' : 'hidden'}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_328e02d666e842","Occurrences") ?? "Occurrences")}<input type="number" min="1" max="240" value="${escapeHtml(recurrenceCount)}" data-event-recurrence-count></label>
          ${project?.id ? `<label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_07092d81e20aa1","Charge each time") ?? "Charge each time")}<input type="number" min="0" step="0.01" placeholder="$0.00" data-event-billing-amount></label>
            <label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8392c3fac72956","Bill cadence") ?? "Bill cadence")}<select data-event-billing-frequency><option value="monthly">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_d7014f792d2583","Monthly") ?? "Monthly")}</option><option value="quarterly">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_03e59d03617275","Quarterly") ?? "Quarterly")}</option><option value="yearly">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_ef289ba5429ef5","Yearly") ?? "Yearly")}</option></select></label>
            <label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_1afa80926cecc4","Cost per visit") ?? "Cost per visit")}<input type="number" min="0" step="0.01" placeholder="$0.00" data-event-expense-amount></label>` : `<div class="dash-event-recurrence-note">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_50ffa923d4cef5","Assign a project to add recurring billing and per-visit costs.") ?? "Assign a project to add recurring billing and per-visit costs.")}</div>`}
          ${clean(draft.recurrence_series_id) ? `<div class="dash-event-recurrence-note">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_cea9172cdfbc16","This is part of an existing series. Saving changes updates future occurrences.") ?? "This is part of an existing series. Saving changes updates future occurrences.")}</div>` : ''}
        </div>` : '')}
      </div>
      ${String(ctx.kind === 'floating' ? `<div class="dash-event-type-row">
          ${typeButton('sales_appointment', 'Sales')}
          ${typeButton('project_work', 'Work')}
          ${typeButton('delivery', 'Delivery')}
        </div>` : `<div class="dash-event-type-pills"><span class="dash-event-type-pill">${escapeHtml(typeMeta.label)}</span>${materialNotOrdered ? `<span class="dash-event-status-pill">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_0c10cb9ccabd39","Not ordered yet") ?? "Not ordered yet")}</span>` : ''}${confirmationPillHtml(draft)}</div>`)}
      ${String(requirementAlertHtml(draft))}
      ${String(eventAssigneeSectionHtml(ctx, draft))}
      <textarea class="dash-event-desc" data-event-description placeholder="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_aa136ecb65672f","Description") ?? "Description")}">${String(escapeHtml(draft.description || draft.notes || ''))}</textarea>
      ${String(project?.id ? `<div class="dash-event-customer-panel">
          <div class="dash-event-customer-head">
            <label class="dash-event-customer-share">
              <input type="checkbox" data-event-customer-visible ${draft.customer_visible === true ? 'checked' : ''}>
              <span class="dash-event-share-switch" aria-hidden="true"></span>
              <span><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_a043dc814fd7c4","Share with customer") ?? "Share with customer")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_ab1e5a7c9771dd","Off by default. Choose exactly what appears in the customer portal.") ?? "Off by default. Choose exactly what appears in the customer portal.")}</small></span>
            </label>
            <button type="button" class="dash-event-customer-details-toggle" data-event-customer-details-toggle aria-expanded="${eventCustomerDetailsOpen ? 'true' : 'false'}" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_447a66c6fb0f03","Customer sharing details") ?? "Customer sharing details")}"><i class="fas fa-chevron-${eventCustomerDetailsOpen ? 'up' : 'down'}"></i></button>
          </div>
          <div class="dash-event-customer-options ${eventCustomerDetailsOpen ? 'open' : ''}" data-event-customer-options>
            <label class="dash-event-customer-option"><input type="checkbox" data-event-customer-show-title ${draft.customer_show_title !== false ? 'checked' : ''}><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_aa81c572cfc2fb","Show the event title ") ?? "Show the event title ")}<small>${((v5) => globalThis.PlatformLanguage?.htmlText("scheduling","m_8e8f7e1056f5d2",`(turn off to show only “${v5}”)`,{v5}) ?? `(turn off to show only “${v5}”)`)(escapeHtml(typeMeta.label || 'Schedule item'))}</small></span></label>
            <label class="dash-event-customer-option"><input type="checkbox" data-event-customer-show-crew ${draft.customer_show_crew === true ? 'checked' : ''}><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_0a4066db1bfb68","Show the assigned crew or team member") ?? "Show the assigned crew or team member")}</span></label>
            <label class="dash-event-customer-note">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_413958fd110fa8","Customer-facing note") ?? "Customer-facing note")}<textarea data-event-customer-description placeholder="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3bfd292017bba4","Add details the customer should see when they open this event") ?? "Add details the customer should see when they open this event")}">${escapeHtml(draft.customer_description || '')}</textarea></label>
          </div>
        </div>` : '')}
      ${String(confirmationEditorHtml(ctx, draft, project))}
      ${String(customerSchedulingEditorHtml(ctx, draft, project))}
      ${String(eventEquipmentSectionHtml(ctx, draft, project))}
      ${String(ctx.kind === 'floating' ? `<div class="dash-event-project-picker"><div class="dash-event-project-picker-row"><input class="dash-event-search" data-event-project-search value="${escapeHtml(eventDraftProjectQuery)}" placeholder="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_90a374781263be","Search to assign a project") ?? "Search to assign a project")}" autocomplete="off"><button type="button" class="dash-event-project-create" data-event-project-create aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_89250227eee734","Create a new project") ?? "Create a new project")}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_89250227eee734","Create a new project") ?? "Create a new project")}"><i class="fas fa-plus"></i></button></div>
        <div class="dash-event-project-list" data-event-project-results ${clean(eventDraftProjectQuery) ? '' : 'hidden'}>
          ${results.map((project) => `<button type="button" class="dash-event-project-option" data-event-project-id="${escapeHtml(project.id || '')}">
            <strong>${escapeHtml(projectTitle(project))}</strong>
            <span>${escapeHtml([project.address, project.customer_phone || project.phone].map(clean).filter(Boolean).join(' - ') || 'No address')}</span>
          </button>`).join('') || (clean(eventDraftProjectQuery) ? `<div class="dash-empty" style="padding:12px;">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_0e31fa9fe147f8","No matching projects.") ?? "No matching projects.")}</div>` : '')}
        </div></div>` : '')}
      <div class="dash-event-pop-actions">
        <span style="display:flex;gap:7px"><button type="button" class="dash-event-advanced-toggle ${String(eventAdvancedOpen ? 'active' : '')}" data-event-advanced aria-label="${((v21) => globalThis.PlatformLanguage?.htmlText("scheduling","m_407444280ca9bb",`${v21} advanced event fields`,{v21}) ?? `${v21} advanced event fields`)(eventAdvancedOpen ? 'Hide' : 'Show')}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_bec5274b269a70","Advanced event fields") ?? "Advanced event fields")}" aria-pressed="${String(eventAdvancedOpen ? 'true' : 'false')}"><i class="fas fa-sliders"></i></button>${String(canDelete ? `<button type="button" class="dash-event-delete" data-event-delete><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_90e27d705bee80"," Delete") ?? " Delete")}</button>` : '')}${String(project?.id ? `<button type="button" class="dash-event-view-btn" data-event-view-project>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_438062886ff2f5","View Project") ?? "View Project")}</button>` : '')}${String(canToggleLock ? `<button type="button" class="dash-event-view-btn" data-event-lock-toggle><i class="fas fa-${eventIsLocked(draft) ? 'lock' : 'lock-open'}"></i> ${eventIsLocked(draft) ? 'Unlock' : 'Lock'}</button>` : '')}</span>
        <button type="button" class="dash-event-save" data-event-save ${String(canSave ? '' : 'disabled')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_5bab3e72de1ebf","Save") ?? "Save")}</button>
      </div>
    `;
    document.body.appendChild(pop);
    const schedulingViewport = rootEl?.querySelector('.dash-left')
      || rootEl?.querySelector('#dashEventCalendarView')
      || rootEl?.querySelector('.dash-body')
      || rootEl;
    const rawContentRect = schedulingViewport?.getBoundingClientRect?.()
      || { left: 8, right: window.innerWidth - 8, top: 8, bottom: window.innerHeight - 8 };
    const contentRect = {
      left:Math.max(0, Number(rawContentRect.left || 0)),
      right:Math.min(window.innerWidth, Number(rawContentRect.right || window.innerWidth)),
      top:Math.max(0, Number(rawContentRect.top || 0)),
      bottom:Math.min(window.innerHeight, Number(rawContentRect.bottom || window.innerHeight))
    };
    const width = Math.min(420, Math.max(0, Number(contentRect.right || window.innerWidth) - Number(contentRect.left || 0) - 16), window.innerWidth - 16);
    const height = Math.min(620, Math.max(0, Number(contentRect.bottom || window.innerHeight) - Number(contentRect.top || 0) - 16), window.innerHeight - 16);
    pop.style.width = `${width}px`;
    pop.style.height = `${height}px`;
    const minLeft = Math.max(8, Number(contentRect.left || 8) + 8);
    const maxLeft = Math.max(minLeft, Math.min(window.innerWidth - width - 8, Number(contentRect.right || window.innerWidth) - width - 8));
    let left = maxLeft;
    if (rect) {
      if (eventCalendarMode() === 'day') {
        left = rect.left + (rect.width / 2) - (width / 2);
      } else if (rect.left - width - 10 >= minLeft) {
        left = rect.left - width - 10;
      } else if (rect.right + 10 <= maxLeft) {
        left = rect.right + 10;
      } else {
        left = rect.left + (rect.width / 2) - (width / 2);
      }
      left = Math.max(minLeft, Math.min(maxLeft, left));
    }
    const estimatedHeight = height;
    const centeredTop = rect ? rect.top + (rect.height / 2) - (estimatedHeight / 2) : 90;
    const minTop = Math.max(8, Number(contentRect.top || 8) + 8);
    const maxTop = Math.max(minTop, Math.min(window.innerHeight - estimatedHeight - 8, Number(contentRect.bottom || window.innerHeight) - estimatedHeight - 8));
    const top = Math.max(minTop, Math.min(maxTop, centeredTop));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.querySelectorAll('[data-event-type]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.eventType || '';
      const meta = eventTypeMeta(id);
      const current = eventEditorContext()?.event || draft;
      const next = updateFloatingEvent({
        ...current,
        type_id: id,
        event_type_id: id,
        event_type_default_id: id,
        title: shouldAutoTitle(current) ? meta.title : current.title,
        project_title: current.project_id ? current.project_title : (shouldAutoTitle(current) ? meta.title : current.project_title),
        title_is_custom: current.title_is_custom === true
      });
      render();
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(next.id)), 0);
    }));
    pop.querySelector('[data-event-title]')?.addEventListener('input', (event) => updateEditorTitle(event.target.value || ''));
    pop.querySelector('[data-event-description]')?.addEventListener('input', (event) => updateEditorDescription(event.target.value || ''));
    bindEventEquipmentSection(pop, draft);
    bindConfirmationEditor(pop, draft);
    bindCustomerSchedulingEditor(pop);
    pop.querySelector('[data-event-advanced]')?.addEventListener('click', () => {
      eventAdvancedOpen = !eventAdvancedOpen;
      renderEventDraftPopover(editorAnchorFor(draft.id));
    });
    pop.querySelector('[data-event-start]')?.addEventListener('change', (event) => updateEditorRange('start', event.target.value || ''));
    pop.querySelector('[data-event-end]')?.addEventListener('change', (event) => updateEditorRange('end', event.target.value || ''));
    pop.querySelector('[data-event-allday]')?.addEventListener('change', (event) => {
      const current = eventEditorContext()?.event || draft;
      updateEditorAllDay(event.target.checked === true);
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(current.id)), 0);
    });
    pop.querySelector('[data-event-assign-add]')?.addEventListener('click', (event) => {
      const menu = pop.querySelector('[data-event-assign-menu]');
      if (!menu) return;
      menu.hidden = !menu.hidden;
      event.currentTarget.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
    });
    pop.querySelectorAll('[data-event-assign-id]').forEach((btn) => btn.addEventListener('click', () => {
      const current = eventEditorContext()?.event || draft;
      const resource = assignmentResourcesForEvent(current).find((item) => clean(item.id) === clean(btn.dataset.eventAssignId));
      if (!resource) return;
      if (clean(resource.subject_type || resource.resource_kind) === 'organization_user') {
        // Adding a person: drop any crew reference and append to the list.
        const list = workCrewId(current) ? [] : editorAssignmentUserList(current);
        updateEditorAssignees([...list.filter((user) => user.id !== clean(resource.id)), { id:clean(resource.id), name:clean(resource.name) }]);
      } else {
        // Groups are assigned as one reference, never fanned out to members.
        applyEditorPatch(assignmentPayloadForSubject(resource));
      }
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(current.id)), 0);
    }));
    pop.querySelectorAll('[data-event-assign-remove]').forEach((btn) => btn.addEventListener('click', () => {
      const current = eventEditorContext()?.event || draft;
      const removeId = clean(btn.dataset.eventAssignRemove);
      if (workCrewId(current) === removeId) applyEditorPatch(assignmentPayloadForSubject(null));
      else updateEditorAssignees(editorAssignmentUserList(current).filter((user) => user.id !== removeId));
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(current.id)), 0);
    }));
    pop.querySelector('[data-event-customer-visible]')?.addEventListener('change', (event) => {
      updateEditorCustomerSetting('customer_visible', event.target.checked === true);
    });
    pop.querySelector('[data-event-customer-details-toggle]')?.addEventListener('click', (event) => {
      eventCustomerDetailsOpen = !eventCustomerDetailsOpen;
      const button = event.currentTarget;
      button.setAttribute('aria-expanded', eventCustomerDetailsOpen ? 'true' : 'false');
      button.innerHTML = `<i class="fas fa-chevron-${eventCustomerDetailsOpen ? 'up' : 'down'}"></i>`;
      pop.querySelector('[data-event-customer-options]')?.classList.toggle('open', eventCustomerDetailsOpen);
    });
    pop.querySelector('[data-event-customer-show-title]')?.addEventListener('change', (event) => updateEditorCustomerSetting('customer_show_title', event.target.checked === true));
    pop.querySelector('[data-event-customer-show-crew]')?.addEventListener('change', (event) => updateEditorCustomerSetting('customer_show_crew', event.target.checked === true));
    pop.querySelector('[data-event-customer-description]')?.addEventListener('input', (event) => updateEditorCustomerSetting('customer_description', event.target.value || ''));
    const bindProjectResultOptions = () => pop.querySelectorAll('[data-event-project-id]').forEach((btn) => btn.addEventListener('click', () => {
      const selectedProject = projects.find((item) => String(item.id || '') === String(btn.dataset.eventProjectId || ''));
      if (!selectedProject) return;
      const current = eventEditorContext()?.event || draft;
      rememberFloatingProjectAssignment(current);
      const next = updateFloatingEvent({
        ...current,
        project_id: selectedProject.id || '',
        project_title: projectTitle(selectedProject),
        project_address: projectAddress(selectedProject, {}),
      });
      eventDraftProjectQuery = '';
      render();
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(next.id)), 0);
    }));
    const search = pop.querySelector('[data-event-project-search]');
    search?.addEventListener('input', () => {
      eventDraftProjectQuery = search.value || '';
      const resultList = pop.querySelector('[data-event-project-results]');
      const nextResults = projectSearchResults(eventDraftProjectQuery);
      if (!resultList) return;
      resultList.hidden = !clean(eventDraftProjectQuery);
      resultList.innerHTML = nextResults.map((item) => `<button type="button" class="dash-event-project-option" data-event-project-id="${escapeHtml(item.id || '')}"><strong>${escapeHtml(projectTitle(item))}</strong><span>${escapeHtml([item.address, item.customer_phone || item.phone].map(clean).filter(Boolean).join(' - ') || 'No address')}</span></button>`).join('') || (clean(eventDraftProjectQuery) ? `<div class="dash-empty" style="padding:12px;">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_0e31fa9fe147f8","No matching projects.") ?? "No matching projects.")}</div>` : '');
      bindProjectResultOptions();
    });
    bindProjectResultOptions();
    pop.querySelector('[data-event-project-clear]')?.addEventListener('click', () => {
      const current = eventEditorContext()?.event || draft;
      rememberFloatingProjectAssignment(current);
      const next = updateFloatingEvent({ ...current, project_id:'', project_title:'', project_address:'' });
      eventDraftProjectQuery = '';
      render();
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(next.id)), 0);
    });
    pop.querySelector('[data-event-project-create]')?.addEventListener('click', () => {
      closeEventDraftPopover();
      window.dispatchEvent(new CustomEvent('fm:new-project-workflow', { detail:{ workflow:'project', source:'scheduling-event' } }));
    });
    pop.querySelector('[data-event-view-project]')?.addEventListener('click', () => {
      if (project?.id) openProjectFromEvent({ project_id: project.id });
    });
    pop.querySelector('[data-event-lock-toggle]')?.addEventListener('click', () => {
      closeEventDraftPopover();
      toggleScheduleEventLock(draft);
    });
    pop.querySelector('[data-event-delete]')?.addEventListener('click', (event) => deleteEventEditor(ctx, draft, event.currentTarget));
    pop.querySelector('[data-event-recurring]')?.addEventListener('change', (event) => {
      const enabled = event.target.checked === true;
      const current = eventEditorContext()?.event || draft;
      if (ctx.kind === 'floating') updateFloatingEvent({ ...current, __recurrence_enabled:enabled });
      pop.querySelector('[data-event-recurrence-fields]')?.classList.toggle('open', enabled);
    });
    pop.querySelector('[data-event-recurrence-end-mode]')?.addEventListener('change', (event) => {
      const mode = clean(event.target.value || 'never');
      const dateField = pop.querySelector('[data-event-recurrence-end-date]');
      const countField = pop.querySelector('[data-event-recurrence-end-count]');
      if (dateField) dateField.hidden = mode !== 'date';
      if (countField) countField.hidden = mode !== 'count';
    });
    pop.querySelector('[data-event-save]')?.addEventListener('click', () => saveEventEditor(eventRecurrenceOptions(pop)));
    pop.querySelector('[data-event-cancel]')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      cancelEventEditor();
    });
    if (!isMobileScheduleLayout()) setTimeout(() => {
      eventDraftDocHandler = bindOutsidePointerDismiss(pop, closeEventDraftPopover, [anchor].filter(Boolean));
    }, 0);
    eventDraftKeyHandler = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || String(event.key || '').toLowerCase() !== 'z') return;
      if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      if (!restoreFloatingProjectAssignment()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('keydown', eventDraftKeyHandler, true);
  }
  function formatEventDraftTime(event){
    if (event?.all_day === true || clean(event?.schedule_granularity).toLowerCase() === 'date') return 'All day';
    const start = eventStart(event);
    const end = eventEnd(event);
    if (!start || !end) return 'New event';
    return `${start.toLocaleDateString([], { month:'short', day:'numeric' })}, ${fmtTime(start)} - ${fmtTime(end)}`;
  }
  function openPlacedCalendarEvent(event, meta = {}){
    if (!event?.id) return;
    if (isMaterialEvent(event) && meta.action === 'lock') {
      toggleScheduleEventLock(event);
      return;
    }
    if (meta.action === 'assignee' && meta.element && !isMaterialEvent(event)) {
      openAssignmentMenu(event, meta.element);
      return;
    }
    if (meta.action === 'view') {
      openProjectFromEvent(event);
      return;
    }
    if (event.floating_event === true || String(event.id || '').startsWith('floating_')) {
      if (String(eventDraftPopoverId || '') !== String(event.id || '')) eventDraftProjectUndo = null;
      eventDraftPopoverId = String(event.id || '');
      eventEditorEventId = '';
      eventDraftProjectQuery = '';
      eventCustomerDetailsOpen = false;
      eventAdvancedOpen = requirementWarningsForEvent(event).length > 0;
      renderEventDraftPopover(meta.element || editorAnchorFor(eventDraftPopoverId));
      return;
    }
    eventDraftPopoverId = '';
    eventEditorEventId = String(event.id || '');
    eventDraftProjectQuery = '';
    eventCustomerDetailsOpen = false;
    eventAdvancedOpen = requirementWarningsForEvent(event).length > 0;
    clearPlacementSelection();
    if (isProductionEvent(event)) {
      productionScheduleProjectId = String(event.project_id || '');
      productionScheduleEventId = String(event.id || '');
    } else if (isMaterialEvent(event)) {
      materialScheduleProjectId = String(event.project_id || '');
      materialScheduleEventId = String(event.id || '');
      productionScheduleProjectId = materialScheduleProjectId;
      productionScheduleEventId = materialScheduleEventId;
    } else {
      appointmentScheduleProjectId = String(event.project_id || '');
      appointmentScheduleEventId = String(event.id || '');
    }
    renderEventDraftPopover(meta.element || editorAnchorFor(event.id));
  }
  function renderEventCalendarView(){
    const mount = rootEl?.querySelector('#dashEventCalendarView');
    if (!mount || !window.PlatformScheduleView?.renderProjectRangeScheduler || !schedulingConfig) return;
    const draft = selectedEventCalendarDraft();
    const activeDraft = draft?.start && draft.status !== 'scheduled' ? draft : null;
    const allowCreate = true;
    const placementKind = selectedPlacementKind() || scheduleMode;
    const clickPlacement = !!draft && !draft.start && ['materials','production'].includes(placementKind);
    const bundleDrafts = placementKind === 'production' && productionScheduleBundleDrafts.length
      ? productionScheduleBundleDrafts
      : (activeDraft ? [activeDraft] : []);
    window.PlatformScheduleView.renderProjectRangeScheduler(mount, {
      Scheduling: window.PlatformScheduling,
      config: schedulingConfig,
      project: placementKind === 'production'
        ? (selectedProductionProject() || eventProject(selectedProductionEvent() || {}))
        : placementKind === 'materials'
          ? (selectedMaterialProject() || eventProject(selectedMaterialEvent() || {}))
          : eventProject(selectedScheduleEvent() || {}),
      events: eventCalendarItems(),
      draft: activeDraft,
      drafts: bundleDrafts,
      activeDraftId: activeDraft?.id || '',
      allowCreate,
      allowEdit: true,
      allowEventDrag: false,
      placementMode: clickPlacement ? 'click' : 'drag',
      touchHoldToPlace: isMobileScheduleLayout(),
      touchHoldDelayMs: 360,
      derivePlacementDrafts(primaryDraft){
        return placementKind === 'production' && productionScheduleBundleKey ? scheduleBundleDrafts(primaryDraft) : [primaryDraft];
      },
      onPlacementCancel(){
        clearPlacementSelection();
        if (vehiclePlacementUnitId) {
          vehiclePlacementUnitId = '';
          vehiclePlacementDraft = null;
        }
        render();
      },
      mode: eventCalendarMode(),
      modes: [eventCalendarMode()],
      showModeSwitch: false,
      showToolbar: false,
      mobileLayout: isMobileScheduleLayout(),
      date: anchorDate,
      shortRangeDayCount: isMobileScheduleLayout() ? 3 : 4,
      slotMinutes: 15,
      renderSlotMinutes: 60,
      workStartMinute: 0,
      workEndMinute: 24 * 60,
      initialScrollMinute: 8 * 60,
      defaultDraftPayload: eventCalendarDefaultDraftPayload,
      canEditEvent: (event) => !eventIsLocked(event),
      eventIsEditable: (event) => !eventIsLocked(event),
      onEventLockToggle: (event, nextLocked) => toggleScheduleEventLock(event, nextLocked),
      onNavigate(nextDate, delta, meta = {}){
        anchorDate = nextDate;
        expandedMonthDates = [];
        if (meta.source === 'swipe') animateMobileCalendarSwipe(delta);
        render();
      },
      expandedMonthDates,
      onMonthExpansionChange(nextDates){ expandedMonthDates = Array.isArray(nextDates) ? nextDates : []; },
      onDraftChange(next){
        applyEventCalendarDraft(next);
        if (placementKind === 'production' && productionScheduleBundleKey) productionScheduleBundleDrafts = scheduleBundleDrafts(next);
        if (document.querySelector('.dash-event-popover')) setTimeout(() => renderEventDraftPopover(editorAnchorFor(next?.id || eventDraftPopoverId)), 0);
      },
      onDraftConfirm(next){
        applyEventCalendarDraft(next);
        const kind = selectedPlacementKind() || scheduleMode;
        if (kind === 'materials') confirmMaterialDraft();
        else if (kind === 'production') {
          if (productionScheduleBundleKey) confirmProductionBundleDraft(next);
          else confirmProductionDraft(next);
        }
        else confirmDashboardDraft();
      },
      onDraftCreateComplete(next, meta = {}){
        if (next?.event_id) {
          applyEventCalendarDraft(next);
          return;
        }
        const draft = updateFloatingEvent({ ...next, floating_event: true });
        eventDraftPopoverId = draft.id;
        eventEditorEventId = '';
        eventDraftProjectQuery = '';
        eventCustomerDetailsOpen = false;
        eventAdvancedOpen = false;
        render();
        setTimeout(() => renderEventDraftPopover(rootEl?.querySelector(`[data-prs-event-id="${window.CSS?.escape ? window.CSS.escape(draft.id) : draft.id}"]`) || meta.element), 0);
      },
      onDraftSelect(draft, meta = {}){
        if (!draft?.id) return;
        eventDraftPopoverId = String(draft.id);
        eventEditorEventId = '';
        eventDraftProjectQuery = '';
        eventCustomerDetailsOpen = false;
        eventAdvancedOpen = false;
        renderEventDraftPopover(meta.element || editorAnchorFor(draft.id));
      },
      onEventRangeChange(event, range){ saveEventCalendarRange(event, range); },
      onEventClick(event, meta = {}){ openPlacedCalendarEvent(event, meta); }
    });
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
    if (rerender) {
      render();
    }
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
        work_resource_ref:event.work_resource_ref || null,
        assigned_resource_kind:event.assigned_resource_kind || '',
        assigned_resource_id:event.assigned_resource_id || '',
        assigned_resource_name:event.assigned_resource_name || '',
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
      ...assignmentPayloadForSubject(null),
      updated_at: new Date().toISOString(),
    };
    try {
      await Scheduling.saveProjectEvent(orgId(), project, nextEvent, schedulingConfig);
      appointmentScheduleDraft = null;
      appointmentScheduleProjectId = String(project.id || '');
      appointmentScheduleEventId = String(event.id || '');
      appointmentScheduleMenuEventId = '';
      await loadData({ force: true });
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_b98fb3c2854487","Appointment unassigned") ?? "Appointment unassigned"), (globalThis.PlatformLanguage?.text("scheduling","m_44b8bc6f65b2f3","The appointment is ready to assign again.") ?? "The appointment is ready to assign again."), true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_915800930cfd7e","Unassign failed") ?? "Unassign failed"), error?.message || 'Could not unassign this appointment.', false);
    }
  }
  async function confirmDashboardDraft(){
    const Scheduling = window.PlatformScheduling;
    const project = selectedScheduleProject();
    if (!Scheduling || !project?.id || !appointmentScheduleDraft?.start) return;
    captureScheduleScroll();
    const eventType = schedulingConfig?.event_types?.sales_appointment || {};
    const user = appointmentScheduleDraft.user || null;
    const assignment = assignmentPayloadForSubject(user);
    const existing = selectedScheduleEvent();
    const event = existing
      ? {
          ...withScheduleHistory(existing, 'rescheduled_or_assigned'),
          start_at: new Date(appointmentScheduleDraft.start).toISOString(),
          start: new Date(appointmentScheduleDraft.start).toISOString(),
          duration_minutes: Number(existing.duration_minutes || eventType.duration_minutes || 60),
          ...assignment,
          title: appointmentScheduleDraft.title || existing.title || clean(Scheduling.autoEventTitle?.(schedulingConfig, existing, project)) || 'Sales Appointment',
          project_title: appointmentScheduleDraft.project_title || existing.project_title || projectTitle(project, existing),
          title_is_custom: appointmentScheduleDraft.title_is_custom === true || existing.title_is_custom === true,
          description: appointmentScheduleDraft.description || existing.description || '',
          notes: appointmentScheduleDraft.description || existing.notes || '',
          customer_visible: appointmentScheduleDraft.customer_visible === true,
          customer_show_title: appointmentScheduleDraft.customer_show_title !== false,
          customer_show_crew: appointmentScheduleDraft.customer_show_crew === true,
          customer_description: clean(appointmentScheduleDraft.customer_description),
          updated_at: new Date().toISOString(),
        }
      : Scheduling.createProjectEvent(project, 'sales_appointment', {
          start: appointmentScheduleDraft.start,
          durationMinutes: Number(eventType.duration_minutes || 60),
          ...assignment,
          title: appointmentScheduleDraft.title || clean(Scheduling.autoEventTitle?.(schedulingConfig, { event_type_default_id:'sales_appointment' }, project)) || 'Sales Appointment',
          project_title: appointmentScheduleDraft.project_title || projectTitle(project),
          title_is_custom: appointmentScheduleDraft.title_is_custom === true,
          description: appointmentScheduleDraft.description || '',
          notes: appointmentScheduleDraft.description || '',
          customer_visible: appointmentScheduleDraft.customer_visible === true,
          customer_show_title: appointmentScheduleDraft.customer_show_title !== false,
          customer_show_crew: appointmentScheduleDraft.customer_show_crew === true,
          customer_description: clean(appointmentScheduleDraft.customer_description),
        }, schedulingConfig);
    try {
      await Scheduling.saveProjectEvent(orgId(), project, event, schedulingConfig);
      appointmentScheduleDraft = null;
      appointmentScheduleProjectId = '';
      appointmentScheduleEventId = '';
      appointmentScheduleMenuEventId = '';
      await loadData({ force: true });
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_da42e64e20d9f0","Appointment scheduled") ?? "Appointment scheduled"), (globalThis.PlatformLanguage?.text("scheduling","m_b3e9ab9f7ab3c0","The appointment was added to the project.") ?? "The appointment was added to the project."), true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), error?.message || 'Could not schedule this appointment.', false);
    }
  }
  async function confirmProductionDraft(draft = productionScheduleDraft){
    const Scheduling = window.PlatformScheduling;
    const project = selectedProductionProject();
    if (!Scheduling || !project?.id || !draft?.start) return;
    captureScheduleScroll();
    const resource = productionWorkResources(draft.scope_template_id, draft).find((item) => String(item.id || '') === String(currentAssignmentId(draft))) || null;
    const title = draft.title || draft.project_title || projectTitle(project, draft);
    const address = draft.project_address || projectAddress(project, draft);
    const payload = {
      title: title || draft.title || (globalThis.PlatformLanguage?.text("scheduling","m_2ac9ecd66d638b","New Event") ?? "New Event"),
      project_title: draft.project_title || projectTitle(project, draft),
      project_address: address,
      title_is_custom: draft.title_is_custom === true,
      start: new Date(draft.start),
      end: draft.end ? new Date(draft.end) : addDays(new Date(draft.start), 1),
      all_day: draft.all_day !== false,
      schedule_granularity: draft.schedule_granularity || (draft.all_day === false ? 'time' : 'date'),
      description: draft.description || '',
      notes: draft.description || '',
      customer_visible: draft.customer_visible === true,
      customer_show_title: draft.customer_show_title !== false,
      customer_show_crew: draft.customer_show_crew === true,
      customer_description: clean(draft.customer_description),
      ...(resource ? assignmentPayloadForSubject(resource) : assignmentPayloadForEvent(draft))
    };
    const existing = selectedProductionEvent();
    const event = existing
      ? Scheduling.updateProjectEventRange(existing, payload)
      : Scheduling.createProjectWorkEvent(project, payload, schedulingConfig);
    try {
      await Scheduling.saveProjectEvent(orgId(), project, event, schedulingConfig);
      updateLocalCalendarEvent(event.id, event);
      events = visibleEvents();
      productionScheduleDraft = null;
      productionScheduleEventId = '';
      productionScheduleProjectId = '';
      render();
      await loadData({ force: true });
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_9e8700da1990da","Work scheduled") ?? "Work scheduled"), (globalThis.PlatformLanguage?.text("scheduling","m_c0406f40f63018","The production schedule was updated.") ?? "The production schedule was updated."), true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), error?.message || 'Could not schedule this production work.', false);
    }
  }
  async function confirmProductionBundleDraft(primaryDraft = productionScheduleDraft){
    const Scheduling = window.PlatformScheduling;
    const bundle = selectedProductionBundle();
    const project = bundle?.project || selectedProductionProject();
    if (!Scheduling || !bundle?.primary || !project?.id || !primaryDraft?.start) return;
    const drafts = scheduleBundleDrafts(primaryDraft);
    if (!drafts.length) return;
    captureScheduleScroll();
    let savedCount = 0;
    try {
      for (const draft of drafts) {
        const source = bundle.events.find((event) => String(event.id || '') === String(draft.id || draft.event_id || ''));
        if (!source) continue;
        if (eventIsLocked(source)) throw new Error(`${source.title || (globalThis.PlatformLanguage?.text("scheduling","m_ab2a08d55b6265","A schedule item") ?? "A schedule item")} is locked and could not be placed.`);
        const material = isMaterialEvent(source);
        const next = {
          ...Scheduling.updateProjectEventRange(source, {
            start:new Date(draft.start),
            end:new Date(draft.end),
            all_day:draft.all_day !== false,
            schedule_granularity:draft.schedule_granularity || (draft.all_day === false ? 'time' : 'date'),
            ...(!material ? workResourcePayload(primaryDraft) : {})
          }),
          status:'scheduled'
        };
        await Scheduling.saveProjectEvent(orgId(), project, next, schedulingConfig);
        updateLocalCalendarEvent(next.id, next);
        savedCount += 1;
      }
      clearPlacementSelection();
      render();
      await loadData({ force:true });
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_5f33d082e19857","Project schedule placed") ?? "Project schedule placed"), ((v0,v1) => globalThis.PlatformLanguage?.text("scheduling","m_b1f283577c009d",`${v0} related schedule item${v1} were placed from the project start date.`,{v0,v1}) ?? `${v0} related schedule item${v1} were placed from the project start date.`)(savedCount,savedCount === 1 ? '' : 's'), true);
    } catch (error) {
      await loadData({ force:true });
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_84d1c4fbb42b86","Bundle scheduling failed") ?? "Bundle scheduling failed"), `${error?.message || 'Could not place every schedule item.'}${savedCount ? ` ${savedCount} item${savedCount === 1 ? '' : 's'} were saved before the error.` : ''}`, false);
    }
  }
  async function confirmMaterialDraft(draft = materialScheduleDraft){
    const Scheduling = window.PlatformScheduling;
    const event = selectedMaterialEvent();
    const project = selectedMaterialProject() || eventProject(event || {});
    if (!Scheduling || !event?.id || !project?.id || !draft?.start) return;
    if (eventIsLocked(event)) {
      showToast(
        (globalThis.PlatformLanguage?.text("scheduling","m_88e13d64071885","Schedule locked") ?? "Schedule locked"),
        materialEventIsOrdered(event)
          ? 'Unlock this ordered delivery before rescheduling it.'
          : 'Unlock this delivery before rescheduling it.',
        false
      );
      return;
    }
    const start = new Date(draft.start);
    const allDay = draft.all_day !== false;
    const fallbackEnd = allDay ? addDays(start, 1) : new Date(start.getTime() + Math.max(15, Number(event.duration_minutes || 60)) * 60000);
    const next = {
      ...Scheduling.updateProjectEventRange(event, {
        start,
        end: draft.end ? new Date(draft.end) : fallbackEnd,
        all_day: allDay,
        schedule_granularity: draft.schedule_granularity || (allDay ? 'date' : 'time')
      }),
      status: 'scheduled',
      kind: 'material_delivery',
      customer_visible: draft.customer_visible === true,
      customer_show_title: draft.customer_show_title !== false,
      customer_show_crew: draft.customer_show_crew === true,
      customer_description: clean(draft.customer_description)
    };
    try {
      await Scheduling.saveProjectEvent(orgId(), project, next, schedulingConfig);
      materialScheduleDraft = null;
      materialScheduleEventId = '';
      materialScheduleProjectId = '';
      productionScheduleDraft = null;
      productionScheduleEventId = '';
      productionScheduleProjectId = '';
      focusedScheduleEventId = next.id;
      await loadData({ force: true });
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_0c0a1a5bde2186","Delivery scheduled") ?? "Delivery scheduled"), ((v0) => globalThis.PlatformLanguage?.text("scheduling","m_ffc8470f2fd563",`${v0} was placed on the calendar.`,{v0}) ?? `${v0} was placed on the calendar.`)(event.title || 'Material delivery'), true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), error?.message || 'Could not schedule this material delivery.', false);
      await loadData({ force: true });
    }
  }
  async function toggleScheduleEventLock(event, requestedLocked = null){
    const Scheduling = window.PlatformScheduling;
    const project = eventProject(event || {});
    const floating = event?.floating_event === true
      || String(event?.id || '').startsWith('floating_')
      || floatingEvents.some((item) => String(item.id || '') === String(event?.id || ''));
    if (!event?.id || (!floating && (!Scheduling || !project?.id))) return;
    const material = isMaterialEvent(event);
    const locked = eventIsLocked(event);
    const ordered = material && materialEventIsOrdered(event);
    const nextLocked = typeof requestedLocked === 'boolean' ? requestedLocked : !locked;
    if (nextLocked === locked) return;
    if (locked && !nextLocked && ordered) {
      const confirmed = await window.Portal?.ui?.confirm?.((globalThis.PlatformLanguage?.text("scheduling","m_ad42d2a999c6f8","This item has already been ordered. Are you sure you want to reschedule?") ?? "This item has already been ordered. Are you sure you want to reschedule?"), {
        title: (globalThis.PlatformLanguage?.text("scheduling","m_7fa4cd849f2943","Unlock material delivery") ?? "Unlock material delivery"),
        okLabel: 'Unlock',
        cancelLabel: 'Keep locked',
        danger: true
      });
      if (!confirmed) return;
    }
    const now = new Date().toISOString();
    const next = {
      ...event,
      locked: nextLocked,
      schedule_locked: nextLocked,
      schedule_lock: {
        ...(event.schedule_lock || {}),
        locked: nextLocked,
        reason: ordered ? 'material_order' : 'manual',
        locked_at: nextLocked ? now : '',
        unlocked_at: nextLocked ? '' : now
      },
      unlock_confirmed: locked && !nextLocked,
      updated_at: now
    };
    try {
      if (floating) {
        const saved = updateFloatingEvent(next);
        render();
        await persistFloatingEvent(saved);
      } else {
        await Scheduling.saveProjectEvent(orgId(), project, next, schedulingConfig);
      }
      focusedScheduleEventId = event.id;
      await loadData({ force: true });
      showToast(
        nextLocked ? (material ? 'Delivery locked' : 'Schedule locked') : (material ? 'Delivery unlocked' : 'Schedule unlocked'),
        nextLocked ? 'The scheduled time is protected.' : 'You can move this item now.',
        true
      );
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_b20cc0a5a8b73a","Lock update failed") ?? "Lock update failed"), error?.message || 'Could not update this scheduling lock.', false);
    }
  }
  function routingScaleButtons(scope, active){
    return ("<span class=\"dash-routing-scale\" aria-label=\"" + ((v0) => globalThis.PlatformLanguage?.text("scheduling","m_c2bba87bee1a16",`${v0} schedule detail`,{v0}) ?? `${v0} schedule detail`)(escapeHtml(scope)) + "\">\n      " + String(['daily','hourly'].map((scale) => `<button type="button" class="${active === scale ? 'active' : ''}" data-routing-scale="${scale}" data-routing-scale-scope="${scope.toLowerCase()}">${scale[0].toUpperCase() + scale.slice(1)}</button>`).join('')) + "\n    </span>");
  }
  function routingDateValue(date = anchorDate){
    const value = new Date(date);
    const pad = (part) => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  function routingDateLabel(date = anchorDate){
    return new Date(date).toLocaleDateString([], { weekday:'short', month:'short', day:'numeric', year:'numeric' });
  }
  function routingDayConflicts(scopeId){
    const date = routingDateValue();
    const sameDay = (event) => {
      const start = eventStart(event);
      return start && routingDateValue(start) === date;
    };
    const source = scopeId === 'production'
      ? allEvents.filter((event) => isProductionEvent(event))
      : allEvents.filter(isSalesEvent);
    return source
      .filter((event) => eventIsScheduled(event) && sameDay(event))
      .filter((event) => {
        const assigneeId = currentAssignmentId(event);
        return assigneeId && subjectUnavailableOn(assigneeId, date);
      });
  }
  function routingPane(scope, id, scale){
    const scopeId = scope.toLowerCase();
    const travelOn = scopeId === 'production' ? productionLiveTravel : appointmentScheduleLiveTravel;
    const travelBtn = scale === 'hourly' && travelTimeEnabled()
      ? `<button type="button" class="dash-routing-travel ${String(travelOn ? 'active' : '')}" data-routing-travel="${String(scopeId)}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_b5b71930035fd1","Show live travel time between stops") ?? "Show live travel time between stops")}" aria-pressed="${String(travelOn ? 'true' : 'false')}"><i class="fas fa-route"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_4f79c5c52d9990"," Travel") ?? " Travel")}</button>`
      : '';
    const autoRouteBtn = scale === 'hourly'
      ? `<button type="button" class="dash-routing-travel" data-routing-optimize="${String(scopeId)}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_de861b5028f734","Assign this day's appointments to the best people by travel time") ?? "Assign this day's appointments to the best people by travel time")}"><i class="fas fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_d9a77d0e85805b"," Auto-route") ?? " Auto-route")}</button>`
      : '';
    const conflictCount = scale === 'hourly' ? routingDayConflicts(scopeId).length : 0;
    const overbookedCount = scale === 'hourly' ? Number(routingOverbooked[`${scopeId}:${routingDateValue()}`] || 0) : 0;
    const flagHtml = [
      conflictCount ? `<span class="dash-routing-flag conflict" title="${((v0,v1,v2) => globalThis.PlatformLanguage?.htmlText("scheduling","m_1e000bf8e3efa8",`${v0} appointment${v1} assigned to an unavailable team member and need${v2} rescheduling`,{v0,v1,v2}) ?? `${v0} appointment${v1} assigned to an unavailable team member and need${v2} rescheduling`)(conflictCount,conflictCount === 1 ? ' is' : 's are',conflictCount === 1 ? 's' : '')}"><i class="fas fa-triangle-exclamation"></i>${((v3,v4) => globalThis.PlatformLanguage?.htmlText("scheduling","m_f2fd2f6805fe78",` ${v3} conflict${v4}`,{v3,v4}) ?? ` ${v3} conflict${v4}`)(conflictCount,conflictCount === 1 ? '' : 's')}</span>` : '',
      overbookedCount ? `<span class="dash-routing-flag overbooked" title="${((v0,v1) => globalThis.PlatformLanguage?.htmlText("scheduling","m_6085bc21c921bf",`The day is overbooked: ${v0} appointment${v1} could not be assigned to anyone`,{v0,v1}) ?? `The day is overbooked: ${v0} appointment${v1} could not be assigned to anyone`)(overbookedCount,overbookedCount === 1 ? '' : 's')}"><i class="fas fa-calendar-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_86a7bd113ad386"," Overbooked") ?? " Overbooked")}</span>` : ''
    ].join('');
    const dateLabel = scale === 'hourly'
      ? `<time class="dash-routing-date" datetime="${routingDateValue()}">${escapeHtml(routingDateLabel())}</time>`
      : '';
    const vehicleButton = scopeId === 'production' && equipmentSchedulingOn()
      ? `<button type="button" class="dash-routing-vehicles ${String(productionVehiclesVisible ? 'active' : '')}" data-routing-vehicles aria-pressed="${String(productionVehiclesVisible ? 'true' : 'false')}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_266a463e7e8cbd","Show vehicle assignment lanes") ?? "Show vehicle assignment lanes")}"><i class="fas fa-truck-pickup"></i></button>`
      : '';
    return `<div class="dash-schedule-pane" data-routing-pane="${scopeId}">
      <div class="dash-schedule-pane-title"><span class="dash-schedule-pane-heading"><span>${escapeHtml(scope)}</span>${dateLabel}</span><span class="dash-routing-pane-controls">${flagHtml}${autoRouteBtn}${travelBtn}${vehicleButton}${routingScaleButtons(scope, scale)}</span></div>
      <div id="${id}" class="dash-schedule-view"></div>
    </div>`;
  }
  function renderMobileRoutingPlacementDock(scope){
    const tiles = [];
    if (scope === 'sales') {
      scheduleAppointmentItems().forEach((item) => {
        const project = item.project || {};
        const selected = String(item.event?.id || '') === String(appointmentScheduleEventId || '');
        const missingAddress = !projectAddressValue(project, item.event);
        tiles.push(`<button type="button" class="dash-routing-placement-tile ${missingAddress ? 'missing-address' : ''} ${selected ? 'selected' : ''}" data-routing-dock-tile data-schedule-event-id="${escapeHtml(item.event?.id || '')}" data-schedule-project-id="${escapeHtml(project.id || '')}"><strong>${escapeHtml(projectTitle(project, item.event))}</strong><span>${missingAddress ? 'Missing address' : 'Tap, then hold a date'}</span></button>`);
      });
    } else {
      scheduleBundleGroups(unscheduledEvents((event) => isProductionEvent(event) || isMaterialEvent(event))).forEach((bundle) => {
        const primary = bundle.primary;
        const project = bundle.project || eventProject(primary);
        const selected = bundle.key === productionScheduleBundleKey || String(primary?.id || '') === String(productionScheduleEventId || '');
        const missingAddress = !projectAddressValue(project, primary);
        tiles.push(`<button type="button" class="dash-routing-placement-tile ${missingAddress ? 'missing-address' : ''} ${selected ? 'selected' : ''}" data-routing-dock-tile data-production-bundle-primary="${escapeHtml(bundle.key)}" data-production-project-id="${escapeHtml(project.id || primary?.project_id || '')}" data-production-event-id="${escapeHtml(primary?.id || '')}"><strong>${escapeHtml(primary?.title || projectTitle(project, primary))}</strong><span>${missingAddress ? 'Missing address' : 'Tap, then hold a date'}</span></button>`);
      });
      unscheduledProductionProjects().forEach((project) => {
        const selected = String(project.id || '') === String(productionScheduleProjectId || '') && !productionScheduleEventId;
        const missingAddress = !projectAddressValue(project, {});
        tiles.push(`<button type="button" class="dash-routing-placement-tile ${missingAddress ? 'missing-address' : ''} ${selected ? 'selected' : ''}" data-routing-dock-tile data-production-project-id="${escapeHtml(project.id || '')}"><strong>${escapeHtml(projectTitle(project))}</strong><span>${missingAddress ? 'Missing address' : 'Tap, then hold a date'}</span></button>`);
      });
    }
    return `<div class="dash-routing-placement-dock"><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2e5bd1a487b333","Projects to place") ?? "Projects to place")}</strong><div class="dash-routing-placement-track">${String(tiles.length ? tiles.join('') : `<div class="dash-routing-placement-empty">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8b9aa12deed5b3","No projects waiting to be placed.") ?? "No projects waiting to be placed.")}</div>`)}</div></div>`;
  }
  function renderAppointmentSchedule(){
    const availablePanes = [
      showSalesSchedule ? { id:'sales', label:(globalThis.PlatformLanguage?.text("scheduling","m_2680c31facb03d","Sales") ?? "Sales"), mount:'dashScheduleViewSales', scale:salesRoutingScale } : null,
      showProductionSchedule ? { id:'production', label:(globalThis.PlatformLanguage?.text("scheduling","m_c2e6380e130020","Production") ?? "Production"), mount:'dashScheduleViewProduction', scale:productionRoutingScale } : null
    ].filter(Boolean);
    if (!availablePanes.length) {
      return `<div class="dash-empty">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_1364a554d79704","Turn on Sales or Production to show a routing schedule.") ?? "Turn on Sales or Production to show a routing schedule.")}</div>`;
    }
    if (!isMobileScheduleLayout()) {
      return `<div class="dash-card dash-schedule-card"><div class="dash-schedule-split">${availablePanes.map((pane) => routingPane(pane.label, pane.mount, pane.scale)).join('')}</div></div>`;
    }
    if (!availablePanes.some((pane) => pane.id === mobileRoutingPane)) {
      mobileRoutingPane = availablePanes.some((pane) => pane.id === scheduleMode) ? scheduleMode : availablePanes[0].id;
    }
    const activePane = availablePanes.find((pane) => pane.id === mobileRoutingPane) || availablePanes[0];
    const tabs = ("<div class=\"dash-routing-tabs\" role=\"tablist\" aria-label=\"" + (globalThis.PlatformLanguage?.text("scheduling","m_584e2a4849003b","Routing schedule") ?? "Routing schedule") + "\">" + String(availablePanes.map((pane) => `<button type="button" class="dash-routing-tab ${pane.id === activePane.id ? 'active' : ''}" data-mobile-routing-pane="${pane.id}" role="tab" aria-selected="${pane.id === activePane.id ? 'true' : 'false'}">${escapeHtml(pane.label)}</button>`).join('')) + "</div>");
    return `<div class="dash-card dash-schedule-card">${tabs}<div class="dash-schedule-split mobile-routing">${routingPane(activePane.label, activePane.mount, activePane.scale)}</div>${renderMobileRoutingPlacementDock(activePane.id)}</div>`;
  }
  function renderEventCalendarShell(){
    return `<div class="dash-card dash-schedule-card"><div id="dashEventCalendarView" class="dash-schedule-view ${mobileCalendarSwipeDirection ? `mobile-swipe-${mobileCalendarSwipeDirection}` : ''}"></div></div>`;
  }
  function stackMobileRoutingTimeHeaders(mount){
    if (!isMobileScheduleLayout() || !mount) return;
    mount.querySelectorAll('.psv-hour').forEach((header) => {
      if (header.dataset.mobileTimeStacked === '1') return;
      const parts = clean(header.textContent).split(/\s+/).filter(Boolean);
      if (parts.length !== 2) return;
      header.dataset.mobileTimeStacked = '1';
      header.replaceChildren();
      const time = document.createElement('span');
      time.textContent = parts[0];
      const meridiem = document.createElement('span');
      meridiem.textContent = parts[1];
      header.append(time, meridiem);
    });
  }
  function renderSalesScheduleView(mount){
    if (!mount || !window.PlatformScheduleView || !schedulingConfig) return;
    const selected = selectedScheduleProject();
    const selectedEvent = selectedScheduleEvent();
    const routingEvents = salesRoutingEvents();
    const placementEnabled = !!(selected?.id && selectedEvent && (!eventIsScheduled(selectedEvent) || !currentAssignmentId(selectedEvent)));
    const creationEnabled = !!(selected?.id && selectedEvent && !eventIsScheduled(selectedEvent));
    const assignableResources = salesResources(selectedEvent || { event_type_default_id:'sales_appointment' });
    const salesResourceId = (event = {}) => currentAssignmentId(event);
    const resourcePayload = (resource = {}) => assignmentPayloadForSubject(resource);
    const openAssignmentResourceSettings = (resource, meta = {}) => {
      if (clean(resource?.subject_type || resource?.resource_kind) === 'organization_user') openScheduleUserSettings(resource, meta);
      else openScheduleWorkResourceSettings(resource, meta);
    };
    if (salesRoutingScale === 'daily' && window.PlatformScheduleView.renderResourceDayScheduler) {
      const duration = Number(selectedEvent?.duration_minutes || schedulingConfig?.event_types?.sales_appointment?.duration_minutes || 60);
      const draftStart = appointmentScheduleDraft?.start ? new Date(appointmentScheduleDraft.start) : null;
      const draft = draftStart ? {
        ...appointmentScheduleDraft,
        id:appointmentScheduleEventId || '__sales_routing_draft',
        event_id:appointmentScheduleEventId || '',
        title:appointmentScheduleDraft.title || selectedEvent?.title || (globalThis.PlatformLanguage?.text("scheduling","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment"),
        start:draftStart,
        end:new Date(draftStart.getTime() + duration * 60000),
        all_day:false,
        schedule_granularity:'time',
        ...resourcePayload(appointmentScheduleDraft.user || null)
      } : null;
      const applyDailyDraft = (next = {}) => {
        if (!next?.start) return;
        const originalStart = appointmentScheduleDraft?.start ? new Date(appointmentScheduleDraft.start) : eventStart(selectedEvent);
        const start = new Date(next.start);
        start.setHours(originalStart?.getHours?.() ?? 9, originalStart?.getMinutes?.() ?? 0, 0, 0);
        const user = assignableResources.find((resource) => clean(resource.id) === clean(next.resource_id || next.assigned_user_id || next.assigned_resource_id || '')) || null;
        appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), start, user };
        const btn = rootEl?.querySelector('[data-dash-confirm-schedule]');
        if (btn) btn.disabled = false;
      };
      window.PlatformScheduleView.renderResourceDayScheduler(mount, {
        Scheduling:window.PlatformScheduling,
        config:schedulingConfig,
        project:selected || null,
        events:routingEvents,
        draft,
        activeDraftId:draft?.id || '',
        resources:assignableResources,
        allowCreate:placementEnabled,
        allowEdit:true,
        date:anchorDate,
        mode:'week',
        dayCount:180,
        pastDays:14,
        mobileResourceRows:isMobileScheduleLayout(),
        mobileCompactResourceHeaders:isMobileScheduleLayout(),
        smartScroll:false,
        showToolbar:false,
        modeLabel:'Sales daily view',
        resourceHeader:'Assignee',
        unassignedLabel:'Assign later',
        resourceIdForItem:salesResourceId,
        resourcePayload,
        onResourceSettings:openAssignmentResourceSettings,
        onNavigate(nextDate){ anchorDate = nextDate; render(); },
        onDraftChange(next){ recordPlacementHistory(); applyDailyDraft(next); },
        onDraftConfirm(next){ applyDailyDraft(next); return confirmDashboardDraft(); },
        onEventRangeChange(event, range){
          appointmentScheduleProjectId = String(event?.project_id || '');
          appointmentScheduleEventId = String(event?.id || '');
          applyDailyDraft(range);
          confirmDashboardDraft();
        },
        onEventClick(event, meta = {}){ openPlacedCalendarEvent(event, meta); }
      });
      return;
    }
    if (!window.PlatformScheduleView.renderResourceTimeScheduler) return;
    const eventType = schedulingConfig?.event_types?.sales_appointment || {};
    const duration = Number(selectedEvent?.duration_minutes || eventType.duration_minutes || 60);
    const windowForDay = appointmentWindowForDate(anchorDate);
    const workStartMinutes = minutesForClock(windowForDay.start, 8 * 60);
    const workEndMinutes = Math.max(workStartMinutes + 30, minutesForClock(windowForDay.end, 18 * 60));
    const draftStart = appointmentScheduleDraft?.start ? new Date(appointmentScheduleDraft.start) : null;
    const draftResource = appointmentScheduleDraft?.user || null;
    const draft = creationEnabled ? {
      ...(selectedEvent || {}),
      ...(appointmentScheduleDraft || {}),
      id:appointmentScheduleEventId || selectedEvent?.id || '__sales_routing_draft',
      event_id:selectedEvent?.id || '',
      title:appointmentScheduleDraft?.title || selectedEvent?.title || (globalThis.PlatformLanguage?.text("scheduling","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment"),
      start:draftStart,
      end:draftStart ? new Date(draftStart.getTime() + duration * 60000) : null,
      all_day:false,
      schedule_granularity:'time',
      ...resourcePayload(draftResource)
    } : null;
    window.PlatformScheduleView.renderResourceTimeScheduler(mount, {
      Scheduling:window.PlatformScheduling,
      config:schedulingConfig,
      project:selected || null,
      events:routingEvents,
      draft,
      activeDraftId:draft?.id || '',
      resources:schedulerResourcesForDay(assignableResources, routingDateValue()),
      onResourceAvailabilityToggle(resource, meta = {}){ toggleSubjectAvailability(resource?.id, meta.date || routingDateValue()); },
      allowCreate:creationEnabled,
      allowEdit:true,
      canEditEvent:(event) => !eventIsLocked(event),
      date:anchorDate,
      slotMinutes:30,
      fixedDurationMinutes:creationEnabled ? duration : 0,
      workStartMinutes,
      workEndMinutes,
      liveTravel:appointmentScheduleLiveTravel && travelTimeEnabled(),
      travelTimeCache:dashboardTravelTimeCache(),
      smartScroll:false,
      showToolbar:false,
      modeLabel:'Sales hourly view',
      resourceHeader:'Assignee',
      unassignedLabel:'Unassigned',
      resourceIdForItem:salesResourceId,
      resourcePayload,
      onResourceSettings:openAssignmentResourceSettings,
      onNavigate(nextDate){
        anchorDate = startOfDay(nextDate) || new Date();
        appointmentScheduleDraft = null;
        appointmentScheduleProjectId = '';
        appointmentScheduleEventId = '';
        appointmentScheduleMenuEventId = '';
        resetScheduleScrollPersistence();
        syncScheduleRoute({ date:routeDate() }, { history:'replace', source:'sales-routing-date', ownedKeys:['date'] });
        render();
      },
      onEventRangeChange(event, range){ saveEventCalendarRange(event, range); },
      onEventClick(event, meta = {}){ openPlacedCalendarEvent(event, meta); },
      onTravelTimeResolved(result){ persistTravelTime(result); },
      onDraftChange(selection){
        if (!creationEnabled || !selection?.start) return;
        recordPlacementHistory();
        appointmentScheduleMenuEventId = '';
        const user = assignableResources.find((resource) => clean(resource.id) === clean(currentAssignmentId(selection))) || null;
        appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), ...selection, start:selection.start, user };
        const btn = rootEl?.querySelector('[data-dash-confirm-schedule]');
        if (btn) btn.disabled = false;
      },
      onDraftConfirm(draft){
        if (!creationEnabled || !draft?.start) return;
        const user = assignableResources.find((resource) => clean(resource.id) === clean(currentAssignmentId(draft))) || null;
        appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), ...draft, user };
        return confirmDashboardDraft();
      }
    });
  }
  function fitRoutingScheduleHeights(){
    const split = rootEl?.querySelector('.dash-schedule-split');
    const panes = split ? [...split.querySelectorAll('.dash-schedule-pane')] : [];
    if (!split || !panes.length) return;
    panes.forEach((pane) => { pane.style.height = ''; });
    if (isMobileScheduleLayout() && split.classList.contains('mobile-routing')) return;
    const available = split.clientHeight;
    if (!available) return;
    const gap = panes.length > 1 ? 8 * (panes.length - 1) : 0;
    const usableHeight = Math.max(0, available - gap);
    const desiredHeights = panes.map((pane) => {
      const title = pane.querySelector('.dash-schedule-pane-title');
      const grid = pane.querySelector('.psv-grid,.prs-resource-grid,.prs-resource-time-grid');
      const scroller = pane.querySelector('.psv-scroll,.prs-resource-scroll');
      const scrollbarHeight = scroller ? Math.max(14, scroller.offsetHeight - scroller.clientHeight) : 16;
      return Math.max(120, (title?.offsetHeight || 0) + (grid?.scrollHeight || 0) + scrollbarHeight + 2);
    });
    const heights = Array(panes.length).fill(0);
    let remainingHeight = usableHeight;
    const ordered = desiredHeights.map((height, index) => ({ height, index })).sort((a, b) => a.height - b.height);
    ordered.forEach((item, position) => {
      const remainingPanes = ordered.length - position;
      const height = Math.min(item.height, remainingHeight / remainingPanes);
      heights[item.index] = Math.max(0, height);
      remainingHeight -= height;
    });
    panes.forEach((pane, index) => { pane.style.height = `${Math.floor(heights[index])}px`; });
  }
  function renderScheduleLibraryView(){
    const splitSales = rootEl?.querySelector('#dashScheduleViewSales');
    const splitProduction = rootEl?.querySelector('#dashScheduleViewProduction');
    if (splitSales) renderSalesScheduleView(splitSales);
    if (splitProduction) renderProductionScheduleView(splitProduction);
    bindScheduleScrollPersistence();
    requestAnimationFrame(fitRoutingScheduleHeights);
    return;
    const selected = selectedScheduleProject();
    const selectedEvent = selectedScheduleEvent();
    const placementEnabled = !!(selected?.id && selectedEvent && (!eventIsScheduled(selectedEvent) || !currentAssignmentId(selectedEvent)));
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
      smartScroll: false,
      showToolbar: false,
      readOnly: !placementEnabled,
      assignmentEventId: appointmentScheduleEventId,
      lockPlacementStart: appointmentScheduleLockTime && placementEnabled ? (selectedEvent?.start_at || selectedEvent?.start || '') : '',
      lockPlacementEnd: appointmentScheduleLockTime && placementEnabled ? (eventEnd(selectedEvent)?.toISOString() || '') : '',
      onEventClick({ event, element }){
        const assigned = !!currentAssignmentId(event);
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
          <div class="psv-event-action danger" data-psv-unassign-event><i class="fas fa-user-minus"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_07454f15891016"," Unassign") ?? " Unassign")}</div>
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
        return confirmDashboardDraft();
      },
    });
    bindScheduleScrollPersistence();
  }
  function renderMaterialScheduleView(mount){
    if (!mount || !window.PlatformScheduleView?.renderProjectRangeScheduler || !schedulingConfig) return;
    const selectedEvent = selectedMaterialEvent();
    const selectedProject = selectedMaterialProject() || eventProject(selectedEvent || {});
    const draft = materialScheduleDraft?.start ? {
      ...(selectedEvent || {}),
      ...materialScheduleDraft,
      id: selectedEvent?.id || materialScheduleDraft.id,
      event_id: selectedEvent?.id || materialScheduleDraft.event_id
    } : null;
    window.PlatformScheduleView.renderProjectRangeScheduler(mount, {
      Scheduling: window.PlatformScheduling,
      config: schedulingConfig,
      project: selectedProject || null,
      events: allEvents.filter(isMaterialEvent).filter(eventIsScheduled).map(decorateMaterialEvent),
      draft,
      activeDraftId: draft?.id || '',
      allowCreate: !!selectedEvent && !eventIsScheduled(selectedEvent),
      allowEdit: true,
      canEditEvent: (event) => !eventIsLocked(event),
      eventIsEditable: (event) => !eventIsLocked(event),
      onEventLockToggle: (event, nextLocked) => toggleScheduleEventLock(event, nextLocked),
      mode: 'month',
      modes: ['month'],
      showModeSwitch: false,
      showToolbar: false,
      date: anchorDate,
      defaultDraftPayload: (range) => eventCalendarDefaultDraftPayload(range, 'materials'),
      placementMode: selectedEvent && !eventIsScheduled(selectedEvent) ? 'click' : 'drag',
      onPlacementCancel(){ clearPlacementSelection(); render(); },
      onNavigate(nextDate){ anchorDate = nextDate; expandedMonthDates = []; render(); },
      expandedMonthDates,
      onMonthExpansionChange(nextDates){ expandedMonthDates = Array.isArray(nextDates) ? nextDates : []; },
      onDraftChange(next){ applyMaterialScheduleDraft(next); },
      onDraftCreateComplete(next){ applyMaterialScheduleDraft(next); },
      onDraftConfirm(next){ applyMaterialScheduleDraft(next); confirmMaterialDraft(); },
      onEventRangeChange(event, range){ saveEventCalendarRange(event, range); },
      onEventClick(event, meta = {}){ openPlacedCalendarEvent(event, meta); }
    });
    if (focusedScheduleEventId) {
      const escaped = window.CSS?.escape ? window.CSS.escape(String(focusedScheduleEventId)) : String(focusedScheduleEventId).replace(/["\\]/g, '\\$&');
      mount.querySelectorAll(`[data-prs-event-id="${escaped}"]`).forEach((node) => node.classList.add('focused'));
    }
    bindScheduleScrollPersistence();
  }
  function renderProductionScheduleView(mount){
    const Scheduling = window.PlatformScheduling;
    const selectedProject = selectedProductionProject();
    const selectedEventCandidate = selectedProductionEvent();
    const selectedEvent = isProductionEvent(selectedEventCandidate) ? selectedEventCandidate : null;
    const materialsResourceId = '__materials__';
    const materialsResource = { id:materialsResourceId, name:'Materials', resource_kind:'materials', settings_disabled:true };
    const crews = productionWorkResources(productionScheduleDraft?.scope_template_id || selectedEvent?.scope_template_id, productionScheduleDraft || selectedEvent);
    const vehicleLaneId = (crewId) => `__vehicle__:${clean(crewId)}`;
    const vehicleLaneCrewId = (resourceId) => clean(resourceId).startsWith('__vehicle__:') ? clean(resourceId).slice('__vehicle__:'.length) : '';
    const vehicleLanes = productionVehiclesVisible && equipmentSchedulingOn()
      ? crews.map((crew) => ({ id:vehicleLaneId(crew.id), name:`${crew.name || workResourceLabel()} vehicles`, resource_kind:'vehicle_lane', vehicle_crew_id:clean(crew.id), settings_disabled:true }))
      : [];
    const resources = productionVehiclesVisible && equipmentSchedulingOn()
      ? [...crews.flatMap((crew) => [crew, vehicleLanes.find((lane) => lane.vehicle_crew_id === clean(crew.id))]), materialsResource]
      : [...crews, materialsResource];
    const vehicleBookings = productionVehiclesVisible && equipmentSchedulingOn()
      ? floatingEvents.filter(isVehicleBooking).filter(eventIsScheduled).map(decorateFloatingEvent)
      : [];
    const productionEvents = [
      ...allEvents.filter(isProductionEvent).filter(eventIsScheduled).map(decorateWorkEvent),
      ...allEvents.filter(isMaterialEvent).filter(eventIsScheduled).map(decorateMaterialEvent),
      ...vehicleBookings
    ];
    const projectForEvent = selectedEvent ? eventProject(selectedEvent) : null;
    const selectedVehicle = equipmentUnits.find((unit) => clean(unit.id) === vehiclePlacementUnitId) || null;
    const vehicleDraft = selectedVehicle ? (vehiclePlacementDraft || {
      id:'__vehicle_draft',
      event_type_default_id:'equipment_booking',
      kind:'equipment_booking',
      vehicle_booking:true,
      title:selectedVehicle.name || selectedVehicle.id,
      all_day:productionRoutingScale !== 'hourly',
      schedule_granularity:productionRoutingScale === 'hourly' ? 'time' : 'date',
      resource_refs:[{ kind:'equipment_unit', id:clean(selectedVehicle.id), name:clean(selectedVehicle.name) || clean(selectedVehicle.id), role:'equipment' }]
    }) : null;
    const draft = vehicleDraft || productionScheduleDraft || (selectedEvent ? {
      id: selectedEvent.id,
      event_id: selectedEvent.id,
      title: selectedEvent.title || (globalThis.PlatformLanguage?.text("scheduling","m_2ac9ecd66d638b","New Event") ?? "New Event"),
      project_title: projectTitle(projectForEvent || {}, selectedEvent),
      project_address: projectAddress(projectForEvent || {}, selectedEvent),
      start: eventStart(selectedEvent),
      end: eventEnd(selectedEvent),
      all_day: selectedEvent.all_day !== false,
      schedule_granularity: selectedEvent.schedule_granularity || (selectedEvent.all_day === false ? 'time' : 'date'),
      ...assignmentPayloadForEvent(selectedEvent)
    } : null);
    const resourcePayload = (resource) => clean(resource?.resource_kind) === 'vehicle_lane'
      ? { resource_id:clean(resource.id), vehicle_crew_id:clean(resource.vehicle_crew_id) }
      : clean(resource?.id) === materialsResourceId ? {} : assignmentPayloadForSubject(resource || {});
    const resourceIdForItem = (event) => isVehicleBooking(event)
      ? vehicleLaneId(event.vehicle_crew_id)
      : isMaterialEvent(event) ? materialsResourceId : workCrewId(event || {}) || clean(event?.assigned_user_id || event?.assigned_user_ids?.[0] || event?.assigned_users?.[0]?.id);
    const canPlaceItemInResource = (event, resource) => isVehicleBooking(event) || vehiclePlacementUnitId
      ? clean(resource?.resource_kind) === 'vehicle_lane'
      : isMaterialEvent(event)
      ? clean(resource?.id) === materialsResourceId
      : clean(resource?.id) !== materialsResourceId && clean(resource?.resource_kind) !== 'vehicle_lane';
    const applyDraft = (next) => {
      if (vehiclePlacementUnitId) {
        vehiclePlacementDraft = next?.start ? { ...(vehicleDraft || {}), ...next, vehicle_booking:true, kind:'equipment_booking', event_type_default_id:'equipment_booking', vehicle_crew_id:clean(next.vehicle_crew_id) || vehicleLaneCrewId(next.resource_id) } : null;
        return;
      }
      if (!next?.start) {
        productionScheduleDraft = null;
        const btn = rootEl?.querySelector('[data-dash-confirm-schedule]');
        if (btn) btn.disabled = true;
        return;
      }
      const project = selectedProject || eventProject(selectedEvent || {});
      productionScheduleProjectId = String(project?.id || productionScheduleProjectId || '');
      productionScheduleEventId = String(next.event_id || productionScheduleEventId || '');
      const title = projectTitle(project || {}, next);
      const address = projectAddress(project || {}, next);
      const draftResourceId = currentAssignmentId(next);
      const draftResource = resources.find((resource) => clean(resource.id) === draftResourceId);
      const typedAssignment = draftResource ? assignmentPayloadForSubject(draftResource) : assignmentPayloadForEvent(next);
      productionScheduleDraft = {
        id: next.id || next.event_id || '__production_draft',
        event_id: next.event_id || productionScheduleEventId || '',
        title: next.title || title || 'New Event',
        project_title: next.project_title || title,
        project_address: next.project_address || address,
        start: next.start,
        end: next.end || addDays(new Date(next.start), 1),
        all_day: next.all_day !== false,
        schedule_granularity: next.schedule_granularity || (next.all_day === false ? 'time' : 'date'),
        ...typedAssignment
      };
      const btn = rootEl?.querySelector('[data-dash-confirm-schedule]');
      if (btn) btn.disabled = !productionScheduleDraft?.start;
    };
    const common = {
      Scheduling,
      config: schedulingConfig,
      project: selectedProject || null,
      events: productionEvents,
      draft,
      drafts:productionScheduleBundleDrafts.length ? productionScheduleBundleDrafts : (draft ? [draft] : []),
      activeDraftId: draft?.id || '',
      resources,
      allowCreate: !!vehiclePlacementUnitId || (!!selectedProject && (!selectedEvent || !eventIsScheduled(selectedEvent))),
      placementMode: selectedEvent && !eventIsScheduled(selectedEvent) ? 'click' : 'drag',
      derivePlacementDrafts(primaryDraft){ return scheduleBundleDrafts(primaryDraft); },
      onPlacementCancel(){ clearPlacementSelection(); render(); },
      allowEdit: true,
      date: anchorDate,
      smartScroll: false,
      showToolbar: false,
      modeLabel: productionRoutingScale === 'hourly' ? 'Production hourly view' : 'Production daily view',
      resourceLabel: workResourceLabel(),
      resourceHeader: workResourceLabel(),
      unassignedLabel: 'Unassigned',
      resourcePayload,
      resourceIdForItem,
      compactResourceIds:[materialsResourceId, ...vehicleLanes.map((lane) => lane.id)],
      mobileResourceRows:isMobileScheduleLayout(),
      mobileCompactResourceHeaders:isMobileScheduleLayout(),
      canPlaceItemInResource,
      onResourceSettings(resource, meta){ if (clean(resource?.id) !== materialsResourceId) openScheduleWorkResourceSettings(resource, meta); },
      onNavigate(nextDate){ anchorDate = nextDate; render(); },
      onDraftChange(next){
        recordPlacementHistory();
        applyDraft(next);
        if (vehiclePlacementUnitId) {
          renderScheduleLibraryViewPreserveScroll();
          return;
        }
        productionScheduleBundleDrafts = scheduleBundleDrafts(next);
        renderScheduleLibraryViewPreserveScroll();
      },
      async onDraftConfirm(next){
        if (vehiclePlacementUnitId) {
          if (next) applyDraft(next);
          const pending = vehiclePlacementDraft;
          const unit = equipmentUnits.find((item) => clean(item.id) === vehiclePlacementUnitId);
          if (!pending?.start || !unit) return;
          const booking = updateFloatingEvent({
            ...pending,
            id:floatingEventId(),
            title:unit.name || unit.id,
            kind:'equipment_booking',
            event_type_default_id:'equipment_booking',
            vehicle_booking:true,
            vehicle_crew_id:clean(pending.vehicle_crew_id) || vehicleLaneCrewId(pending.resource_id),
            resource_refs:[{ kind:'equipment_unit', id:clean(unit.id), name:clean(unit.name) || clean(unit.id), role:'equipment', start_at:new Date(pending.start).toISOString(), end_at:new Date(pending.end).toISOString() }],
            status:'scheduled'
          });
          vehiclePlacementDraft = null;
          vehiclePlacementUnitId = '';
          render();
          try {
            await persistFloatingEvent(booking);
            await loadData({ force:true });
            showToast((globalThis.PlatformLanguage?.text("scheduling","m_b2d1b5ccb88ec2","Vehicle scheduled") ?? "Vehicle scheduled"), ((v0) => globalThis.PlatformLanguage?.text("scheduling","m_db094a7481e01d",`${v0} was added to the crew lane.`,{v0}) ?? `${v0} was added to the crew lane.`)(unit.name || 'Vehicle'), true);
          } catch (error) {
            showToast((globalThis.PlatformLanguage?.text("scheduling","m_f9ef6bab2b4dce","Vehicle not scheduled") ?? "Vehicle not scheduled"), error?.message || 'Could not save the vehicle assignment.', false);
          }
          return;
        }
        if (next) applyDraft(next);
        return productionScheduleBundleKey ? confirmProductionBundleDraft(next) : confirmProductionDraft(next);
      },
      onEventRangeChange(event, range){
        if (isVehicleBooking(event)) {
          const rangeStart = validDate(range.start || range.start_at);
          const rangeEnd = validDate(range.end || range.end_at);
          const resourceRefs = (Array.isArray(event.resource_refs) ? event.resource_refs : []).map((ref) => clean(ref?.kind) === 'equipment_unit'
            ? { ...ref, ...(rangeStart ? { start_at:rangeStart.toISOString() } : {}), ...(rangeEnd ? { end_at:rangeEnd.toISOString() } : {}) }
            : ref);
          const next = updateFloatingEvent({ ...event, ...range, resource_refs:resourceRefs, vehicle_crew_id:vehicleLaneCrewId(range.resource_id) || event.vehicle_crew_id, status:'scheduled' });
          renderScheduleLibraryViewPreserveScroll();
          void persistFloatingEvent(next).catch((error) => showToast((globalThis.PlatformLanguage?.text("scheduling","m_fed89027106fe3","Vehicle not moved") ?? "Vehicle not moved"), error?.message || 'Could not update the vehicle assignment.', false));
          return;
        }
        if (isMaterialEvent(event)) {
          saveEventCalendarRange(event, { ...range, all_day:true, schedule_granularity:'date' });
          return;
        }
        productionScheduleProjectId = String(event.project_id || '');
        productionScheduleEventId = String(event.id || '');
        const nextResourceId = firstOwnedClean(range, ['resource_id', 'assigned_crew_id', 'crew_id'], workCrewId(event));
        const nextResourceName = firstOwnedClean(range, ['resource_name', 'assigned_crew_name', 'crew_name'], workCrewName(event));
        const selectedResource = resources.find((resource) => clean(resource.id) === nextResourceId);
        const nextAssignment = selectedResource ? assignmentPayloadForSubject(selectedResource) : assignmentPayloadForSubject(null);
        applyDraft({
          ...range,
          id: event.id,
          event_id: event.id,
          title: event.title || (globalThis.PlatformLanguage?.text("scheduling","m_2ac9ecd66d638b","New Event") ?? "New Event"),
          project_title: projectTitle(eventProject(event), event),
          project_address: event.project_address || projectAddress(eventProject(event), event),
          ...nextAssignment,
          resource_name:nextAssignment.resource_name || nextResourceName
        });
        renderScheduleLibraryViewPreserveScroll();
      },
      onEventClick(event, meta = {}){ openPlacedCalendarEvent(event, meta); }
    };
    if (viewMode === 'appointment_schedule' && productionRoutingScale === 'hourly' && window.PlatformScheduleView.renderResourceTimeScheduler) {
      window.PlatformScheduleView.renderResourceTimeScheduler(mount, {
        ...common,
        resources: schedulerResourcesForDay(resources, routingDateValue()),
        onResourceAvailabilityToggle(resource, meta = {}){ toggleSubjectAvailability(resource?.id, meta.date || routingDateValue()); },
        slotMinutes:30,
        liveTravel: productionLiveTravel && travelTimeEnabled(),
        travelTimeCache: dashboardTravelTimeCache(),
        onLiveTravelToggle(next){ productionLiveTravel = !!next; persistSchedulePreference({ production_live_travel: !!next }); renderScheduleLibraryViewPreserveScroll(); },
        onTravelTimeResolved(result){ persistTravelTime(result); }
      });
    } else if (viewMode === 'appointment_schedule' && window.PlatformScheduleView.renderResourceDayScheduler) {
      window.PlatformScheduleView.renderResourceDayScheduler(mount, { ...common, mode:'week', dayCount:180, pastDays:14 });
    }
    bindScheduleScrollPersistence();
  }
  function ganttVisibleEvents(){
    const Scheduling = window.PlatformScheduling;
    const kindFor = (event) => {
      if (isMaterialEvent(event) || productionResourceType(event) === 'material') return 'deliveries';
      if (productionResourceType(event) === 'equipment' || eventKind(event) === 'equipment') return 'equipment';
      if (isProductionEvent(event) || productionResourceType(event) === 'labor') return 'labor';
      if (isSalesEvent(event) || isSalesFollowUpEvent(event)) return 'sales';
      return 'other';
    };
    const visibleItems = allEvents.filter((event) => !Scheduling?.eventIsGroup?.(event) && ganttVisibleKinds.has(kindFor(event)));
    const visibleIds = new Set(visibleItems.map((event) => String(event.id || '')));
    const visibleParentIds = new Set(visibleItems.map((event) => String(Scheduling?.eventParentId?.(event) || event.parent_event_id || '')).filter(Boolean));
    return allEvents.filter((event) => visibleIds.has(String(event.id || '')) || (Scheduling?.eventIsGroup?.(event) && visibleParentIds.has(String(event.id || ''))));
  }
  function ganttResourceLanes(){
    return [
      ...workforceResources.map((resource) => ({
        kind: clean(resource.subject_type || resource.resource_kind) || 'resource_group',
        id: resource.id,
        name: resource.name,
        icon: clean(resource.icon)
      })),
      ...equipmentUnits.map((unit) => ({
        kind: 'equipment_unit',
        id: clean(unit.id),
        name: clean(unit.name),
        icon: clean(unit.icon) || 'fa-truck-pickup'
      }))
    ];
  }
  function renderGanttShell(){
    return `<div class="dash-card dash-schedule-card"><div id="dashGanttView" class="dash-schedule-view dash-gantt-view"></div></div>`;
  }
  function renderGanttScheduleView(){
    const mount = rootEl?.querySelector('#dashGanttView');
    if (!mount || !window.PlatformScheduleView?.renderGanttScheduler || !schedulingConfig) return;
    if (ganttShownDocHandler) {
      ganttShownDocHandler();
      ganttShownDocHandler = null;
    }
    const ganttEvents = ganttVisibleEvents();
    const projectIds = new Set(ganttEvents.map((event) => String(event.project_id || '')));
    const ganttProjects = projects
      .filter((project) => projectIds.has(String(project.id || '')))
      .map((project) => ({ ...project, display_name:projectTitle(project) }));
    const shownOptions = [
      ['labor', 'Labor', 'fa-helmet-safety'],
      ['equipment', 'Equipment', 'fa-truck-pickup'],
      ['deliveries', 'Deliveries', 'fa-truck-ramp-box'],
      ['sales', 'Sales', 'fa-handshake'],
      ['other', 'Other', 'fa-calendar-plus']
    ];
    const groupControls = `<div class="dash-gantt-groupby"><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8b0eeec3c3b8c8","Group by") ?? "Group by")}</span>${String([
      ['project', 'Project'], ['resource', 'Resource']
    ].map(([id, label]) => `<button type="button" class="dash-gantt-groupby-btn ${ganttGroupBy === id ? 'active' : ''}" data-gantt-group-by="${id}">${label}</button>`).join(''))}
      <div class="dash-gantt-shown-wrap">
        <button type="button" class="dash-gantt-shown-btn ${String(ganttShownMenuOpen || ganttVisibleKinds.size !== shownOptions.length ? 'active' : '')}" data-gantt-shown aria-expanded="${String(ganttShownMenuOpen ? 'true' : 'false')}"><i class="fas fa-sliders"></i><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_092ad4c2ce9c6b","Shown") ?? "Shown")}</span></button>
        ${String(ganttShownMenuOpen ? `<div class="dash-gantt-shown-menu" data-gantt-shown-menu>
          <div class="dash-gantt-shown-head"><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_80fdf3a3a8501b","Items shown") ?? "Items shown")}</strong><button type="button" data-gantt-shown-close aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>
          <div class="dash-gantt-shown-options">${shownOptions.map(([id, label, icon]) => `<button type="button" class="dash-gantt-shown-option ${ganttVisibleKinds.has(id) ? 'active' : ''}" data-gantt-kind="${id}" aria-pressed="${ganttVisibleKinds.has(id) ? 'true' : 'false'}"><span class="dash-gantt-shown-check"><i class="fas fa-check"></i></span><i class="fas ${icon}"></i><span>${label}</span></button>`).join('')}</div>
        </div>` : '')}
      </div>
    </div>`;
    window.PlatformScheduleView.renderGanttScheduler(mount, {
      Scheduling: window.PlatformScheduling,
      config: schedulingConfig,
      projects: ganttProjects,
      groupBy: ganttGroupBy === 'resource' ? 'resource' : '',
      resources: ganttGroupBy === 'resource' ? ganttResourceLanes() : undefined,
      resourceHeader: ganttGroupBy === 'resource' ? 'Resource' : 'Work Item',
      events: ganttEvents,
      date: anchorDate,
      pxPerDay: ganttZoomPxPerDay || undefined,
      collapsedGroupIds: ganttCollapsedGroups,
      modeLabel: window.Portal?.terminology?.get?.('scheduling.gantt_view', 'Gantt') || 'Gantt',
      toolbarLeadingHtml:groupControls,
      onZoomChange(next){
        ganttZoomPxPerDay = Number(next) || 0;
        clearTimeout(ganttZoomPersistTimer);
        ganttZoomPersistTimer = setTimeout(() => persistSchedulePreference({ gantt_zoom:ganttZoomPxPerDay }), 350);
      },
      onGroupToggle(groupId, isCollapsed){
        ganttCollapsedGroups = isCollapsed
          ? [...new Set([...ganttCollapsedGroups, String(groupId)])]
          : ganttCollapsedGroups.filter((id) => id !== String(groupId));
      },
      onEventClick(event, meta = {}){
        if (event.__project_rollup === true) openProjectFromEvent(event);
        else openPlacedCalendarEvent(event, meta);
      },
      onEventRangeChange(event, range, meta = {}){
        if (event.__project_rollup === true) saveGanttProjectRange(event, range);
        else saveGanttEventRange(event, range, meta?.cascade || []);
      },
      onEventSchedule(event, range){ saveGanttEventRange(event, range, []); },
      onDependencyCreate(fromEvent, toEvent){ createGanttDependency(fromEvent, toEvent); },
      onDependencyRemove(event, dependency){ removeGanttDependency(event, dependency); },
      onProjectAddItem(project, meta){ createGanttProjectItem(project, meta, false); },
      onProjectAddGroup(project, meta){ createGanttProjectItem(project, meta, true); }
    });
    mount.querySelectorAll('[data-gantt-group-by]').forEach((btn) => btn.addEventListener('click', () => {
      const next = clean(btn.dataset.ganttGroupBy) || 'project';
      if (next === ganttGroupBy) return;
      ganttGroupBy = next;
      persistSchedulePreference({ gantt_group_by:ganttGroupBy });
      renderGanttScheduleView();
    }));
    mount.querySelectorAll('[data-gantt-kind]').forEach((btn) => btn.addEventListener('click', () => {
      const kind = clean(btn.dataset.ganttKind);
      if (ganttVisibleKinds.has(kind)) ganttVisibleKinds.delete(kind);
      else ganttVisibleKinds.add(kind);
      ganttShownMenuOpen = true;
      renderGanttScheduleView();
    }));
    mount.querySelector('[data-gantt-shown]')?.addEventListener('click', () => {
      ganttShownMenuOpen = !ganttShownMenuOpen;
      renderGanttScheduleView();
    });
    mount.querySelector('[data-gantt-shown-close]')?.addEventListener('click', () => {
      ganttShownMenuOpen = false;
      renderGanttScheduleView();
    });
    const shownMenu = mount.querySelector('[data-gantt-shown-menu]');
    const shownButton = mount.querySelector('[data-gantt-shown]');
    if (shownMenu && shownButton) {
      setTimeout(() => {
        ganttShownDocHandler = bindOutsidePointerDismiss(shownMenu, () => {
          ganttShownMenuOpen = false;
          renderGanttScheduleView();
        }, [shownButton]);
      }, 0);
    }
  }
  async function createGanttProjectItem(project, meta = {}, group = false){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling?.createProjectWorkEvent || !Scheduling?.saveProjectEvent || !project?.id) return;
    const factory = group && Scheduling.createScheduleGroupEvent ? Scheduling.createScheduleGroupEvent : Scheduling.createProjectWorkEvent;
    const item = factory(project, {
      title:group ? 'New Section' : 'New Work Item',
      status:'unscheduled',
      all_day:true,
      schedule_granularity:'date'
    }, schedulingConfig);
    allEvents = [...allEvents, item];
    projects = projects.map((candidate) => String(candidate.id || '') === String(project.id || '')
      ? { ...candidate, events:[...(Array.isArray(candidate.events) ? candidate.events : []), item] }
      : candidate);
    events = visibleEvents();
    renderGanttScheduleView();
    try {
      const saved = await Scheduling.saveProjectEvent(orgId(), project, item, schedulingConfig);
      mergeSavedCalendarEvent(saved, item, beginEventRangeSave(item.id));
      renderGanttScheduleView();
      const escapedId = window.CSS?.escape ? window.CSS.escape(String(item.id)) : String(item.id);
      const anchor = rootEl?.querySelector?.(`[data-psv-gantt-open="${escapedId}"]`);
      openPlacedCalendarEvent(saved?.event || item, { element:anchor || meta.element });
    } catch (error) {
      allEvents = allEvents.filter((event) => String(event.id || '') !== String(item.id || ''));
      projects = projects.map((candidate) => String(candidate.id || '') === String(project.id || '')
        ? { ...candidate, events:(Array.isArray(candidate.events) ? candidate.events : []).filter((event) => String(event.id || '') !== String(item.id || '')) }
        : candidate);
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_39e03ba47e7ee8","Item not added") ?? "Item not added"), error?.message || 'Could not add the project work item.', false);
      renderGanttScheduleView();
    }
  }
  async function saveGanttProjectRange(rollup, range){
    const Scheduling = window.PlatformScheduling;
    const previousStart = eventStart(rollup);
    const nextStart = validDate(range?.start);
    if (!Scheduling?.updateProjectEventRange || !previousStart || !nextStart) return;
    const childIds = new Set((rollup.__project_child_ids || []).map(String));
    const children = allEvents.filter((event) => childIds.has(String(event.id || '')) && !Scheduling.eventIsGroup?.(event) && eventIsScheduled(event) && !eventIsLocked(event));
    const delta = nextStart.getTime() - previousStart.getTime();
    if (!delta || !children.length) return;
    const changes = children.map((event) => {
      const start = eventStart(event);
      const end = eventEnd(event) || addDays(start, 1);
      return Scheduling.updateProjectEventRange(event, {
        start:new Date(start.getTime() + delta),
        end:new Date(end.getTime() + delta),
        all_day:event.all_day !== false,
        schedule_granularity:event.schedule_granularity
      });
    });
    const byId = new Map(changes.map((event) => [String(event.id || ''), event]));
    allEvents = allEvents.map((event) => byId.get(String(event.id || '')) || event);
    events = visibleEvents();
    renderGanttScheduleView();
    try {
      for (const change of changes) {
        const project = eventProject(change);
        if (!project?.id) continue;
        const version = beginEventRangeSave(change.id);
        const saved = await queueEventRangeSave(change.id, () => Scheduling.saveProjectEvent(orgId(), project, change, schedulingConfig));
        mergeSavedCalendarEvent(saved, change, version);
      }
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_77017e64d76f74","Project moved") ?? "Project moved"), ((v0,v1) => globalThis.PlatformLanguage?.text("scheduling","m_c2ee34769a4c38",`${v0} work item${v1} moved together.`,{v0,v1}) ?? `${v0} work item${v1} moved together.`)(changes.length,changes.length === 1 ? '' : 's'), true);
      renderGanttScheduleView();
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_520e15b9c887fd","Project not moved") ?? "Project not moved"), error?.message || 'Could not move all project work items.', false);
      scheduleLoad();
    }
  }
  async function saveGanttEventRange(event, range, cascade = []){
    const Scheduling = window.PlatformScheduling;
    const currentEvent = allEvents.find((item) => String(item.id || '') === String(event?.id || '')) || event;
    const project = eventProject(currentEvent);
    if (eventIsLocked(currentEvent)) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_88e13d64071885","Schedule locked") ?? "Schedule locked"), (globalThis.PlatformLanguage?.text("scheduling","m_0233f74e9faf1e","Unlock this item before moving it.") ?? "Unlock this item before moving it."), false);
      renderGanttScheduleView();
      return;
    }
    if (!Scheduling || !currentEvent?.id || !project?.id || !range?.start) return;
    const drafts = (cascade || []).filter((draft) => String(draft.id || '') !== String(currentEvent.id || ''));
    let moveLinked = false;
    if (drafts.length) {
      const choice = await chooseRelationshipReschedule(currentEvent, drafts);
      if (choice === 'cancel' || choice === false || choice == null) {
        renderGanttScheduleView();
        return;
      }
      moveLinked = choice === 'yes';
    }
    const next = { ...Scheduling.updateProjectEventRange(currentEvent, range), status:'scheduled' };
    const changes = [next, ...(moveLinked ? drafts.map((draft) => ({ ...draft, status:'scheduled' })) : [])];
    const changesById = new Map(changes.map((item) => [String(item.id || ''), item]));
    allEvents = allEvents.map((item) => changesById.has(String(item.id || '')) ? { ...item, ...changesById.get(String(item.id || '')) } : item);
    events = visibleEvents();
    renderGanttScheduleView();
    try {
      for (const change of changes) {
        const changeProject = eventProject(change);
        if (!changeProject?.id) continue;
        const version = beginEventRangeSave(change.id);
        const saved = await queueEventRangeSave(change.id, () => Scheduling.saveProjectEvent(orgId(), changeProject, change, schedulingConfig));
        mergeSavedCalendarEvent(saved, change, version);
      }
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_a1da9bcb050cbb","Schedule updated") ?? "Schedule updated"), changes.length > 1 ? `Moved this item and ${changes.length - 1} linked item${changes.length === 2 ? '' : 's'}.` : 'The schedule item was updated.', true);
      renderGanttScheduleView();
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), error?.message || 'Could not update this schedule item.', false);
      scheduleLoad();
    }
  }
  function ganttDependencyWouldCycle(fromEvent, toEvent){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling?.scheduleGraph) return false;
    const graph = Scheduling.scheduleGraph(allEvents);
    const visited = new Set();
    const queue = [String(toEvent.id || '')];
    while (queue.length) {
      const currentId = queue.shift();
      if (currentId === String(fromEvent.id || '')) return true;
      (graph.dependentsOf.get(currentId) || []).forEach((edge) => {
        if (!visited.has(edge.to)) { visited.add(edge.to); queue.push(edge.to); }
      });
    }
    return false;
  }
  async function createGanttDependency(fromEvent, toEvent){
    const Scheduling = window.PlatformScheduling;
    const scheduledChildren = (rollup) => allEvents.filter((item) => (rollup?.__project_child_ids || []).map(String).includes(String(item.id || '')) && !Scheduling?.eventIsGroup?.(item) && eventIsScheduled(item));
    const source = fromEvent?.__project_rollup === true
      ? scheduledChildren(fromEvent).sort((a, b) => (eventEnd(b)?.getTime() || 0) - (eventEnd(a)?.getTime() || 0))[0]
      : fromEvent;
    const resolvedTarget = toEvent?.__project_rollup === true
      ? scheduledChildren(toEvent).sort((a, b) => (eventStart(a)?.getTime() || Number.MAX_SAFE_INTEGER) - (eventStart(b)?.getTime() || Number.MAX_SAFE_INTEGER))[0]
      : toEvent;
    const target = allEvents.find((item) => String(item.id || '') === String(resolvedTarget?.id || '')) || resolvedTarget;
    if (!Scheduling || !target?.id || !source?.id) return;
    const existing = Scheduling.eventDependencies ? Scheduling.eventDependencies(target) : [];
    if (existing.some((dep) => dep.event_id === String(source.id || ''))) return;
    if (ganttDependencyWouldCycle(source, target)) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_574bea457bf625","Circular link") ?? "Circular link"), (globalThis.PlatformLanguage?.text("scheduling","m_1fda2b3dbe4011","That link would make these items depend on each other.") ?? "That link would make these items depend on each other."), false);
      return;
    }
    const nextDeps = [...existing, {
      id:`dep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      event_id:String(source.id),
      type:'finish_to_start',
      lag_minutes:0
    }];
    await saveGanttDependencies(target, nextDeps, 'Items linked');
  }
  async function removeGanttDependency(event, dependency){
    const Scheduling = window.PlatformScheduling;
    const target = allEvents.find((item) => String(item.id || '') === String(event?.id || '')) || event;
    if (!Scheduling || !target?.id) return;
    const existing = Scheduling.eventDependencies ? Scheduling.eventDependencies(target) : [];
    await saveGanttDependencies(target, existing.filter((dep) => dep.id !== dependency?.id), 'Items unlinked');
  }
  async function saveGanttDependencies(target, dependsOn, label){
    const project = eventProject(target);
    if (!project?.id || !window.PlatformScheduling?.saveProjectEvent) return;
    const next = { ...target, depends_on: dependsOn, updated_at: new Date().toISOString() };
    allEvents = allEvents.map((item) => String(item.id || '') === String(next.id || '') ? { ...item, depends_on: dependsOn } : item);
    renderGanttScheduleView();
    try {
      await window.PlatformScheduling.saveProjectEvent(orgId(), project, next, schedulingConfig);
      showToast(label, label === 'Items linked' ? 'The item now follows the one you connected it to.' : 'The dependency was removed.', true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_250f0841a2c9ea","Link not saved") ?? "Link not saved"), error?.message || 'Could not update the dependency.', false);
      scheduleLoad();
    }
  }
  function renderGroups(){
    return renderSchedulingRail();
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
            return { event, project, salesperson: assignedLabel(event), start_at: eventStart(event)?.toISOString() || '' };
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
        <div class="dash-group-body">${group.items.length ? group.items.map(appointmentTile).join('') : `<div class="dash-empty" style="padding:16px;">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2c20082e994482","No appointments.") ?? "No appointments.")}</div>`}</div>
      </div>`;
    }).join('')}</div>`;
  }
  function toolbarHtml(){
    const routingLabel = window.Portal?.terminology?.get?.(
      'scheduling.routing_view',
      window.PlatformScheduling?.labelFor?.(schedulingConfig, 'ui', 'routing_mode') || 'Routing'
    ) || 'Routing';
    const modeButtons = `
      <span class="dash-control-group">
        <span class="dash-control-label">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_6290719711de40","Show") ?? "Show")}</span>
        <button class="dash-btn segment ${String(showSalesSchedule ? 'active' : '')}" data-schedule-type-toggle="sales">${String(escapeHtml('Sales'))}</button>
        <button class="dash-btn segment ${String(showProductionSchedule ? 'active' : '')}" data-schedule-type-toggle="production">${String(escapeHtml('Production'))}</button>
        <button class="dash-btn segment ${String(showOtherSchedule ? 'active' : '')}" data-schedule-type-toggle="other">${String(escapeHtml('Other'))}</button>
      </span>`;
    const displayButtons = ENABLE_CALENDAR_DISPLAY_SWITCH ? `
      <span class="dash-control-group">
        <span class="dash-control-label">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2b8e4c9b866e80","View") ?? "View")}</span>
        ${String([['summary','Summary'], ['events','Events']].map(([id, label]) => `<button class="dash-btn segment ${calendarDisplayMode === id ? 'active' : ''}" data-calendar-display="${id}">${escapeHtml(label)}</button>`).join(''))}
      </span>` : '';
    const today = new Date();
    const mobileViewChoices = [
      ...(routingViewEnabled() ? [['appointment_schedule', routingLabel, 'fa-route']] : []),
      ...(ganttViewEnabled() ? [['gantt', window.Portal?.terminology?.get?.('scheduling.gantt_view', 'Gantt') || 'Gantt', 'fa-chart-gantt']] : []),
      ['day', window.Portal?.terminology?.get?.('scheduling.day_view', 'Day') || 'Day', 'fa-calendar-day'],
      ['4day', isMobileScheduleLayout() ? '3 Day' : (window.Portal?.terminology?.get?.('scheduling.four_day_view', '4 Day') || '4 Day'), 'fa-calendar-week'],
      ['week', window.Portal?.terminology?.get?.('scheduling.week_view', 'Week') || 'Week', 'fa-table-columns'],
      ['month', window.Portal?.terminology?.get?.('scheduling.month_view', 'Month') || 'Month', 'fa-calendar-days']
    ];
    const mobileToolbarExtras = `<span class="dash-mobile-menu-wrap"><button type="button" class="dash-mobile-control dash-mobile-show" data-mobile-schedule-menu aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2ea71a7fc7dec5","Choose schedules to show") ?? "Choose schedules to show")}" aria-expanded="${String(mobileScheduleMenuOpen ? 'true' : 'false')}"><i class="fas fa-sliders"></i><i class="fas fa-chevron-down" style="font-size:8px"></i></button>${String(mobileScheduleMenuOpen ? `<div class="dash-mobile-popover schedules" role="menu" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_92e47dd97f2a57","Schedules to show") ?? "Schedules to show")}"><button type="button" class="${showSalesSchedule ? 'active' : ''}" data-schedule-type-toggle="sales" role="menuitemcheckbox" aria-checked="${showSalesSchedule ? 'true' : 'false'}"><i class="fas fa-handshake"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2680c31facb03d","Sales") ?? "Sales")}</button><button type="button" class="${showProductionSchedule ? 'active' : ''}" data-schedule-type-toggle="production" role="menuitemcheckbox" aria-checked="${showProductionSchedule ? 'true' : 'false'}"><i class="fas fa-helmet-safety"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_c2e6380e130020","Production") ?? "Production")}</button><button type="button" class="${showOtherSchedule ? 'active' : ''}" data-schedule-type-toggle="other" role="menuitemcheckbox" aria-checked="${showOtherSchedule ? 'true' : 'false'}"><i class="fas fa-calendar-plus"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_4a04382820d2e1","Other") ?? "Other")}</button></div>` : '')}</span><button type="button" class="dash-mobile-control dash-mobile-type" data-mobile-tray-open aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_858d2ae4d1a804","Open projects to schedule") ?? "Open projects to schedule")}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8f66eeaac51322","Projects to schedule") ?? "Projects to schedule")}"><i class="fas fa-inbox"></i></button>`;
    const mobileToolbar = window.PlatformScheduleView?.mobileCalendarToolbarHtml?.({
      view: viewMode,
      date: anchorDate,
      viewChoices: mobileViewChoices,
      viewMenuOpen: mobileViewMenuOpen,
      monthMenuOpen: mobileMonthMenuOpen,
      pickerMonth: mobilePickerMonth,
      pickerYear: mobilePickerYear,
      years: mobileYearChoices(),
      trailingHtml: mobileToolbarExtras,
      attributes: {
        viewMenu:'data-mobile-view-menu',
        view:'data-dash-view',
        monthMenu:'data-mobile-month-menu',
        month:'data-mobile-picker-month',
        year:'data-mobile-picker-year',
        today:'data-dash-today',
        nav:'data-dash-nav'
      }
    }) || '';
    return `
      ${String(mobileToolbar)}<div class="dash-toolbar">
        <div><h2 class="dash-title">${String(escapeHtml(visibleTitle()))}</h2></div>
        <div class="dash-controls">
          <button type="button" class="dash-btn" data-dash-nav="-1"><i class="fas fa-chevron-left"></i></button>
          <button type="button" class="dash-btn" data-dash-today>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_23929ba4ba84dd","Today") ?? "Today")}</button>
          <button type="button" class="dash-btn" data-dash-nav="1"><i class="fas fa-chevron-right"></i></button>
          ${String([
            ['day',window.Portal?.terminology?.get?.('scheduling.day_view', 'Day') || 'Day'],
            ['4day',window.Portal?.terminology?.get?.('scheduling.four_day_view', '4 Day') || '4 Day'],
            ['week',window.Portal?.terminology?.get?.('scheduling.week_view', 'Week') || 'Week'],
            ['month',window.Portal?.terminology?.get?.('scheduling.month_view', 'Month') || 'Month'],
            ...(routingViewEnabled() ? [['appointment_schedule',routingLabel]] : []),
            ...(ganttViewEnabled() ? [['gantt', window.Portal?.terminology?.get?.('scheduling.gantt_view', 'Gantt') || 'Gantt']] : [])
          ].map(([mode,label]) => `<button class="dash-btn ${viewMode === mode ? 'active' : ''}" data-dash-view="${mode}">${escapeHtml(label)}</button>`).join(''))}
          ${String(viewMode === 'gantt' ? '' : modeButtons)}
          ${String(viewMode !== 'appointment_schedule' ? displayButtons : '')}
        </div>
      </div>
    `;
  }
  function openDayModal(dayIso, options = {}){
    const day = new Date(dayIso);
    if (!Number.isFinite(day.getTime())) return;
    const dayKey = routeDate(day);
    if (activeDayModal?.day === dayKey && activeDayModal.element?.isConnected) return;
    activeDayModal?.close?.({ fromRoute:true });
    const dayEvents = events.filter((event) => sameDay(eventStart(event), day));
    const items = dayEvents.map((event) => ({ event, project: eventProject(event), salesperson: assignedLabel(event) }));
    const back = document.createElement('div');
    back.className = 'dash-modal-backdrop';
    back.innerHTML = `
      <div class="dash-modal">
        <div class="dash-modal-head">
          <div><h3>${String(escapeHtml(day.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' })))}</h3><div class="dash-sub">${((v1,v2) => globalThis.PlatformLanguage?.htmlText("scheduling","m_766a1e29082f39",`${v1} appointment${v2}`,{v1,v2}) ?? `${v1} appointment${v2}`)(dayEvents.length,dayEvents.length === 1 ? '' : 's')}</div></div>
          <button type="button" class="dash-modal-close"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="dash-modal-body">
          ${String(topStatsHtmlForDay(day))}
          <div class="dash-groups"><div class="dash-group"><div class="dash-group-body">${String(items.length ? items.map(appointmentTile).join('') : `<div class="dash-empty">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2c20082e994482","No appointments.") ?? "No appointments.")}</div>`)}</div></div></div>
        </div>
      </div>
    `;
    let modalHandle = null;
    const close = (closeOptions = {}) => {
      modalHandle?.unregister?.();
      modalHandle = null;
      back.remove();
      if (activeDayModal?.element === back) activeDayModal = null;
      if (!closeOptions.fromRoute && !window.Portal?.navigation?.applying) {
        window.Portal?.navigation?.backOrClose?.(['day'], { day:null }, { source:'schedule-day-close' });
      }
    };
    back.querySelector('.dash-modal-close')?.addEventListener('click', close);
    back.querySelectorAll('[data-event-id]').forEach((node) => node.addEventListener('click', () => {
      const event = events.find((item) => item.id === node.dataset.eventId);
      if (event) { close({ fromRoute:true }); openProjectFromEvent(event); }
    }));
    document.body.appendChild(back);
    activeDayModal = { day:dayKey, element:back, close };
    if (!options.fromRoute) syncScheduleRoute({ day:dayKey }, { history:'push', source:'schedule-day-open', ownedKeys:['day'] });
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
    if (!SHOW_CALENDAR_STATS) return '';
    const start = startOfDay(day);
    const end = addDays(day, 1);
    const stats = statsFor(start, end);
    const defs = statDefs();
    return `<div class="dash-stats" style="grid-template-columns:repeat(${Math.max(1, defs.length)},minmax(100px,1fr));">${defs.map((stat) => `
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
    rootEl.querySelector('[data-mobile-view-menu]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      mobileViewMenuOpen = !mobileViewMenuOpen;
      mobileMonthMenuOpen = false;
      mobileScheduleMenuOpen = false;
      render();
    });
    rootEl.querySelector('[data-mobile-month-menu]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      mobileMonthMenuOpen = !mobileMonthMenuOpen;
      if (mobileMonthMenuOpen) {
        mobilePickerYear = anchorDate.getFullYear();
        mobilePickerMonth = anchorDate.getMonth();
      }
      mobileViewMenuOpen = false;
      mobileScheduleMenuOpen = false;
      render();
    });
    rootEl.querySelector('[data-mobile-schedule-menu]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      mobileScheduleMenuOpen = !mobileScheduleMenuOpen;
      mobileViewMenuOpen = false;
      mobileMonthMenuOpen = false;
      render();
    });
    rootEl.querySelectorAll('[data-mobile-picker-month]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.stopPropagation();
      mobilePickerMonth = Number(btn.dataset.mobilePickerMonth || 0);
      anchorDate = new Date(mobilePickerYear, mobilePickerMonth, 1);
      expandedMonthDates = [];
      syncScheduleRoute({ date:routeDate() }, { history:'replace', source:'scheduling-month', ownedKeys:['date'] });
      render();
    }));
    rootEl.querySelectorAll('[data-mobile-picker-year]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.stopPropagation();
      mobilePickerYear = Number(btn.dataset.mobilePickerYear || anchorDate.getFullYear());
      anchorDate = new Date(mobilePickerYear, mobilePickerMonth, 1);
      expandedMonthDates = [];
      syncScheduleRoute({ date:routeDate() }, { history:'replace', source:'scheduling-month', ownedKeys:['date'] });
      render();
    }));
    rootEl.querySelector('[data-mobile-tray-open]')?.addEventListener('click', () => {
      openMobileTray();
      mobileViewMenuOpen = false;
      mobileMonthMenuOpen = false;
      mobileScheduleMenuOpen = false;
      render();
    });
    rootEl.querySelector('[data-mobile-tray-close]')?.addEventListener('click', () => {
      closeMobileTray();
      render();
    });
    rootEl.querySelector('[data-mobile-tray-backdrop]')?.addEventListener('click', (event) => {
      if (event.target !== event.currentTarget) return;
      closeMobileTray();
      render();
    });
    rootEl.querySelectorAll('.dash-mobile-tray [data-schedule-project-id],.dash-mobile-tray [data-production-project-id],.dash-mobile-tray [data-production-bundle-primary],.dash-mobile-tray [data-production-event-id],.dash-mobile-tray [data-material-event-id]').forEach((node) => node.addEventListener('click', () => {
      closeMobileTray();
    }));
    if (bind._mobileControlsDocHandler) document.removeEventListener('pointerdown', bind._mobileControlsDocHandler, true);
    bind._mobileControlsDocHandler = (event) => {
      if (!event.target.closest('.dash-mobile-popover,.dash-mobile-control,[data-mobile-tray-open],.dash-mobile-tray')) {
        if (!mobileViewMenuOpen && !mobileMonthMenuOpen && !mobileScheduleMenuOpen && !mobileTrayOpen) return;
        mobileViewMenuOpen = false;
        mobileMonthMenuOpen = false;
        mobileScheduleMenuOpen = false;
        closeMobileTray();
        render();
      }
    };
    document.addEventListener('pointerdown', bind._mobileControlsDocHandler, true);
    rootEl.querySelectorAll('[data-mobile-routing-pane]').forEach((btn) => btn.addEventListener('click', () => {
      const nextPane = btn.dataset.mobileRoutingPane === 'production' ? 'production' : 'sales';
      if (nextPane === mobileRoutingPane) return;
      mobileRoutingPane = nextPane;
      resetScheduleScrollPersistence();
      render();
    }));
    rootEl.querySelectorAll('[data-routing-travel]').forEach((btn) => btn.addEventListener('click', () => {
      const scope = btn.dataset.routingTravel === 'production' ? 'production' : 'sales';
      if (scope === 'production') {
        productionLiveTravel = !productionLiveTravel;
        persistSchedulePreference({ production_live_travel: productionLiveTravel });
      } else {
        appointmentScheduleLiveTravel = !appointmentScheduleLiveTravel;
        persistSchedulePreference({ live_travel: appointmentScheduleLiveTravel });
      }
      render();
    }));
    rootEl.querySelectorAll('[data-routing-optimize]').forEach((btn) => btn.addEventListener('click', async () => {
      const scope = btn.dataset.routingOptimize === 'production' ? 'production' : 'sales';
      const eventTypeId = scope === 'production' ? 'project_work' : 'sales_appointment';
      const id = orgId();
      if (!id || btn.disabled) return;
      btn.disabled = true;
      const originalHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Routing…';
      try {
        const result = await window.PlatformAPI.routing.optimize(id, {
          event_type_id: eventTypeId,
          date: routingDateValue(),
          apply: true
        });
        const routed = Number(result?.applied_count || 0);
        const unrouted = Array.isArray(result?.unassigned) ? result.unassigned.length : 0;
        const missingAddress = Number(result?.skipped_missing_address_count || result?.skipped_missing_address?.length || 0);
        const travelTotal = Number(result?.total_travel_minutes || 0);
        const cleared = Number(result?.cleared_count || 0);
        const clearedNote = cleared ? ` ${cleared} previously assigned appointment${cleared === 1 ? ' was' : 's were'} moved back to Unassigned.` : '';
        const missingAddressNote = missingAddress ? ` ${missingAddress} project${missingAddress === 1 ? ' was' : 's were'} skipped because ${missingAddress === 1 ? 'it has' : 'they have'} no address.` : '';
        const overbookedKey = `${scope}:${routingDateValue()}`;
        if (unrouted) routingOverbooked[overbookedKey] = unrouted; else delete routingOverbooked[overbookedKey];
        if (unrouted) {
          showToast(
            (globalThis.PlatformLanguage?.text("scheduling","m_1a3086087f3e32","Auto-route: day is overbooked") ?? "Auto-route: day is overbooked"),
            ((v0,v1,v2,v3,v4,v5) => globalThis.PlatformLanguage?.text("scheduling","m_968883a1455a5e",`${v0} appointment${v1} assigned (${v2} min total travel), but the day is overbooked — ${v3} could not fit anyone's schedule.${v4}${v5}`,{v0,v1,v2,v3,v4,v5}) ?? `${v0} appointment${v1} assigned (${v2} min total travel), but the day is overbooked — ${v3} could not fit anyone's schedule.${v4}${v5}`)(routed,routed === 1 ? '' : 's',travelTotal,unrouted,missingAddressNote,clearedNote),
            false
          );
        } else {
          showToast(
            missingAddress ? 'Auto-route complete with skipped projects' : 'Auto-route complete',
            ((v0,v1,v2,v3) => globalThis.PlatformLanguage?.text("scheduling","m_bcfe6241b8a874",`${v0} appointment${v1} assigned (${v2} min total travel).${v3}`,{v0,v1,v2,v3}) ?? `${v0} appointment${v1} assigned (${v2} min total travel).${v3}`)(routed,routed === 1 ? '' : 's',travelTotal,missingAddressNote),
            !missingAddress
          );
        }
        await loadData({ force: true });
      } catch (error) {
        const message = error?.data?.error === 'routing_no_events'
          ? `No ${scope} appointments are scheduled on ${routingDateLabel()}. Use the pane's arrows to move to the day you want to route.`
          : (error?.message || 'Could not optimize this day.');
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_7e3392260e8172","Auto-route failed") ?? "Auto-route failed"), message, false);
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }));
    rootEl.querySelectorAll('[data-routing-scale]').forEach((btn) => btn.addEventListener('click', () => {
      const scale = btn.dataset.routingScale === 'daily' ? 'daily' : 'hourly';
      if (btn.dataset.routingScaleScope === 'production') productionRoutingScale = scale;
      else salesRoutingScale = scale;
      resetScheduleScrollPersistence();
      render();
    }));
    rootEl.querySelector('[data-routing-vehicles]')?.addEventListener('click', () => {
      productionVehiclesVisible = !productionVehiclesVisible;
      if (!productionVehiclesVisible) {
        vehiclePlacementUnitId = '';
        vehiclePlacementDraft = null;
      }
      resetScheduleScrollPersistence();
      render();
    });
    rootEl.querySelectorAll('[data-vehicle-bank-unit]').forEach((btn) => btn.addEventListener('click', () => {
      vehiclePlacementUnitId = clean(btn.dataset.vehicleBankUnit);
      vehiclePlacementDraft = null;
      clearPlacementSelection();
      render();
    }));
    rootEl.querySelectorAll('[data-breakdown-mode]').forEach((btn) => btn.addEventListener('click', () => {
      breakdownMode = btn.dataset.breakdownMode || 'user';
      breakdownValue = 'all';
      filterMenuOpen = false;
      modeMenuOpen = false;
      syncScheduleRoute({ scheduleGroup:breakdownMode, scheduleResource:null }, { history:'replace', source:'schedule-filter' });
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
      syncScheduleRoute({ scheduleResource:breakdownValue === 'all' ? null : breakdownValue }, { history:'replace', source:'schedule-filter' });
      render();
    }));
    rootEl.querySelectorAll('[data-dash-view]').forEach((btn) => btn.addEventListener('click', () => {
      const nextView = btn.dataset.dashView || 'week';
      const enteringSchedule = viewMode !== 'appointment_schedule' && nextView === 'appointment_schedule';
      viewMode = nextView;
      if (enteringSchedule) {
        anchorDate = new Date();
        resetScheduleScrollPersistence();
      }
      mobileViewMenuOpen = false;
      mobileMonthMenuOpen = false;
      mobileScheduleMenuOpen = false;
      syncScheduleRoute({ scheduleView:viewMode, date:routeDate() }, { history:'push', source:'schedule-view', ownedKeys:['scheduleView'] });
      render();
    }));
    rootEl.querySelectorAll('[data-schedule-type-toggle]').forEach((btn) => btn.addEventListener('click', () => {
      const next = btn.dataset.scheduleTypeToggle || 'sales';
      if (next === 'production') showProductionSchedule = !showProductionSchedule;
      else if (next === 'other') showOtherSchedule = !showOtherSchedule;
      else showSalesSchedule = !showSalesSchedule;
      scheduleMode = showSalesSchedule ? 'sales' : (showProductionSchedule ? 'production' : 'sales');
      appointmentScheduleDraft = null;
      appointmentScheduleProjectId = '';
      appointmentScheduleEventId = '';
      appointmentScheduleMenuEventId = '';
      productionScheduleDraft = null;
      productionScheduleProjectId = '';
      productionScheduleEventId = '';
      materialScheduleDraft = null;
      materialScheduleProjectId = '';
      materialScheduleEventId = '';
      eventEditorEventId = '';
      breakdownValue = 'all';
      mobileScheduleMenuOpen = false;
      syncScheduleRoute({ scheduleType:scheduleMode }, { history:'push', source:'schedule-type', ownedKeys:['scheduleType'] });
      render();
    }));
    rootEl.querySelectorAll('[data-calendar-display]').forEach((btn) => btn.addEventListener('click', () => {
      calendarDisplayMode = ENABLE_CALENDAR_DISPLAY_SWITCH ? (btn.dataset.calendarDisplay || 'events') : 'events';
      render();
    }));
    rootEl.querySelectorAll('[data-dash-nav]').forEach((btn) => btn.addEventListener('click', () => nav(Number(btn.dataset.dashNav) || 0)));
    rootEl.querySelectorAll('[data-dash-today]').forEach((btn) => btn.addEventListener('click', goToToday));
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
      if (!event) return;
      const deselecting = String(appointmentScheduleEventId || '') === String(event.id || '') && selectedPlacementKind() === 'sales';
      clearPlacementSelection();
      if (deselecting) { render(); return; }
      appointmentScheduleProjectId = String(event.project_id || eventProject(event).id || '');
      appointmentScheduleEventId = String(event.id || '');
      appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), description: event.description || event.notes || '' };
      // Jump the routing pane to the event's day so the selection is visible.
      const scheduledStart = eventIsScheduled(event) ? eventStart(event) : null;
      if (scheduledStart) anchorDate = startOfDay(scheduledStart) || anchorDate;
      eventDraftPopoverId = '';
      eventEditorEventId = '';
      eventDraftProjectQuery = '';
      render();
      if (node.closest('.dash-routing-placement-dock')) return;
      const anchor = [...rootEl.querySelectorAll('[data-schedule-event-id]')].find((item) => String(item.dataset.scheduleEventId || '') === String(event.id || ''));
      renderEventDraftPopover(anchor);
    }));
    rootEl.querySelectorAll('[data-production-project-id]:not([data-production-event-id])').forEach((node) => node.addEventListener('click', () => {
      const projectId = String(node.dataset.productionProjectId || '');
      const deselecting = productionScheduleProjectId === projectId && !productionScheduleEventId && selectedPlacementKind() === 'production';
      clearPlacementSelection();
      if (deselecting) { render(); return; }
      productionScheduleProjectId = projectId;
      productionScheduleEventId = String(node.dataset.productionEventId || '');
      const project = selectedProductionProject();
      productionScheduleDraft = {
        id: '__production_event_draft',
        event_id: '',
        title: projectTitle(project || {}),
        project_id: project?.id || productionScheduleProjectId || '',
        project_title: projectTitle(project || {}),
        project_address: projectAddress(project || {}, {}),
        description: ''
      };
      eventDraftPopoverId = '';
      eventEditorEventId = '';
      eventDraftProjectQuery = '';
      render();
      if (node.closest('.dash-routing-placement-dock')) return;
      const anchor = [...rootEl.querySelectorAll('[data-production-project-id]:not([data-production-event-id])')].find((item) => String(item.dataset.productionProjectId || '') === productionScheduleProjectId);
      renderEventDraftPopover(anchor);
    }));
    rootEl.querySelectorAll('[data-production-bundle-cancel]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearPlacementSelection();
      render();
    }));
    rootEl.querySelectorAll('[data-production-bundle-toggle]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const key = String(node.dataset.productionBundleToggle || '');
      if (!key) return;
      if (expandedProductionBundles.has(key)) expandedProductionBundles.delete(key);
      else expandedProductionBundles.add(key);
      render();
    }));
    rootEl.querySelectorAll('[data-bundle-child-cancel]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearPlacementSelection();
      render();
    }));
    rootEl.querySelectorAll('[data-production-bundle-primary]').forEach((node) => node.addEventListener('click', (event) => {
      if (event.target.closest('[data-production-bundle-cancel]')) return;
      const bundleKey = String(node.dataset.productionBundlePrimary || '');
      const bundle = scheduleBundleGroups(unscheduledEvents((item) => isProductionEvent(item) || isMaterialEvent(item))).find((item) => item.key === bundleKey);
      if (!bundle?.primary) return;
      const deselecting = productionScheduleBundleKey === bundleKey;
      clearPlacementSelection();
      if (deselecting) { render(); return; }
      const primary = bundle.primary;
      productionScheduleBundleKey = bundleKey;
      productionScheduleProjectId = String(primary.project_id || bundle.project?.id || '');
      productionScheduleEventId = String(primary.id || '');
      productionScheduleDraft = {
        ...primary,
        id:primary.id,
        event_id:primary.id,
        title:primary.title || projectTitle(bundle.project, primary),
        project_title:projectTitle(bundle.project, primary),
        project_address:projectAddress(bundle.project, primary),
        start:null,
        end:null,
        all_day:true,
        schedule_granularity:'date',
        ...workResourcePayload(primary)
      };
      productionScheduleBundleDrafts = [];
      render();
    }));
    rootEl.querySelectorAll('[data-production-event-id]:not([data-production-bundle-primary])').forEach((node) => node.addEventListener('click', () => {
      const eventId = String(node.dataset.productionEventId || '');
      const deselecting = productionScheduleEventId === eventId && selectedPlacementKind() === 'production';
      clearPlacementSelection();
      if (deselecting) { render(); return; }
      productionScheduleProjectId = String(node.dataset.productionProjectId || '');
      productionScheduleEventId = eventId;
      const event = selectedProductionEvent();
      productionScheduleDraft = event ? {
        id: event.id,
        event_id: event.id,
        title: event.title || (globalThis.PlatformLanguage?.text("scheduling","m_2ac9ecd66d638b","New Event") ?? "New Event"),
        start: eventStart(event),
        end: eventEnd(event),
        all_day: event.all_day !== false,
        schedule_granularity: event.schedule_granularity || (event.all_day === false ? 'time' : 'date'),
        ...workResourcePayload(event)
      } : null;
      render();
    }));
    rootEl.querySelectorAll('[data-material-event-id]').forEach((node) => node.addEventListener('click', () => {
      const eventId = String(node.dataset.materialEventId || '');
      const deselecting = materialScheduleEventId === eventId && selectedPlacementKind() === 'materials';
      clearPlacementSelection();
      if (deselecting) { render(); return; }
      materialScheduleProjectId = String(node.dataset.materialProjectId || '');
      materialScheduleEventId = eventId;
      const event = selectedMaterialEvent();
      productionScheduleDraft = null;
      materialScheduleDraft = null;
      focusedScheduleEventId = event?.id || '';
      eventDraftPopoverId = '';
      eventEditorEventId = '';
      eventDraftProjectQuery = '';
      render();
    }));
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
    if (!ENABLE_CALENDAR_DISPLAY_SWITCH) calendarDisplayMode = 'events';
    const skipScheduleScrollCapture = scheduleScrollResetPending;
    if (viewMode === 'appointment_schedule' && !skipScheduleScrollCapture) captureScheduleScroll();
    events = visibleEvents();
    const main = viewMode === 'appointment_schedule'
      ? renderAppointmentSchedule()
      : viewMode === 'gantt'
        ? renderGanttShell()
        : (calendarDisplayMode === 'events' ? renderEventCalendarShell() : viewMode === 'month' ? renderMonth() : viewMode === 'day' ? renderDay() : renderWeek());
    const mobileTray = mobileTrayOpen ? `<div class="dash-mobile-tray-backdrop ${String(mobileTrayClosing ? 'closing' : '')}" data-mobile-tray-backdrop><aside class="dash-mobile-tray" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8f66eeaac51322","Projects to schedule") ?? "Projects to schedule")}"><div class="dash-mobile-tray-head"><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_e9f71e12236d72","Projects to Schedule") ?? "Projects to Schedule")}</strong><button type="button" class="dash-mobile-tray-close" data-mobile-tray-close aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_d957e47b7fba31","Close projects to schedule") ?? "Close projects to schedule")}"><i class="fas fa-xmark"></i></button></div>${String(renderGroups())}</aside></div>` : '';
    rootEl.innerHTML = `<div class="dash-shell">${toolbarHtml()}<div class="dash-body ${['appointment_schedule','gantt'].includes(viewMode) ? 'schedule-mode' : ''} ${!['appointment_schedule','gantt'].includes(viewMode) && calendarDisplayMode === 'events' ? 'events-mode' : ''}"><div class="dash-left">${topStatsHtml()}${main}</div><aside class="dash-right">${renderGroups()}</aside></div>${mobileTray}</div>`;
    if (viewMode === 'appointment_schedule') renderScheduleLibraryView();
    else if (viewMode === 'gantt') renderGanttScheduleView();
    else if (calendarDisplayMode === 'events') renderEventCalendarView();
    bind();
    if (skipScheduleScrollCapture) scheduleScrollResetPending = false;
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
  function storedScheduleFocus(){
    try { return JSON.parse(sessionStorage.getItem('fm:scheduling:focus') || 'null'); } catch (error) { return null; }
  }
  function applyScheduleFocus(payload = pendingScheduleFocus || storedScheduleFocus()){
    const eventId = clean(payload?.event_id || payload?.eventId);
    const projectId = clean(payload?.project_id || payload?.projectId);
    const materialListId = clean(payload?.material_list_id || payload?.materialListId);
    if (!eventId && !projectId && !materialListId) return false;
    let event = eventId ? allEvents.find((item) => String(item.id || '') === eventId) : null;
    if (!event && materialListId) event = allEvents.find((item) => isMaterialEvent(item) && eventMaterialListId(item) === materialListId);
    if (!event && projectId) event = allEvents.find((item) => String(item.project_id || '') === projectId && isMaterialEvent(item));
    if (!event) return false;
    breakdownValue = 'all';
    focusedScheduleEventId = String(event.id || '');
    clearPlacementSelection();
    if (isMaterialEvent(event)) {
      showMaterialSchedule = false;
      showSalesSchedule = false;
      showProductionSchedule = true;
      scheduleMode = 'production';
      materialScheduleProjectId = String(event.project_id || projectId || '');
      materialScheduleEventId = String(event.id || '');
      productionScheduleProjectId = materialScheduleProjectId;
      productionScheduleEventId = materialScheduleEventId;
      productionScheduleDraft = null;
      materialScheduleDraft = null;
    } else if (isProductionEvent(event)) {
      showProductionSchedule = true;
      scheduleMode = 'production';
      productionScheduleProjectId = String(event.project_id || projectId || '');
      productionScheduleEventId = String(event.id || '');
    } else {
      showSalesSchedule = true;
      scheduleMode = 'sales';
      appointmentScheduleProjectId = String(event.project_id || projectId || '');
      appointmentScheduleEventId = String(event.id || '');
    }
    const start = eventStart(event);
    if (start) anchorDate = new Date(start);
    if (!['day','4day','week','month'].includes(viewMode)) viewMode = 'week';
    pendingScheduleFocus = null;
    try { sessionStorage.removeItem('fm:scheduling:focus'); } catch (error) {}
    return true;
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
      // Confirmation settings drive both the visibility gate and the editor
      // defaults; a failure here just leaves the feature invisible.
      if (window.PlatformAPI?.appointments?.settings && Scheduling.setConfirmationSettings) {
        const confirmationSettings = await settleValue(
          window.PlatformAPI.appointments.settings(id, branchId()).then((result) => result?.settings || {}),
          Scheduling.confirmationSettings?.() || {},
          'Appointment confirmation settings'
        );
        Scheduling.setConfirmationSettings(confirmationSettings);
      }
      dashboardConfig = await settleValue(
        Dashboard.loadConfig(id, branchId(), { ensureDefaults: true }),
        dashboardConfig || Dashboard.normalizeConfig?.({}) || {},
        'Dashboard config'
      );
      const loadedProjectConfig = await settleValue(
        window.Portal?.branchModules?.get
          ? window.Portal.branchModules.get('project_configuration')
          : window.PlatformAPI?.branchModules?.get?.(id, branchId(), 'project_configuration'),
        branchProjectConfig,
        'Scheduling project title configuration'
      );
      branchProjectConfig = normalizeProjectConfig(loadedProjectConfig?.data || loadedProjectConfig || {});
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
      const loadedWorkforce = await settleValue(
        window.PlatformAPI?.workforce?.assignableResources ? window.PlatformAPI.workforce.assignableResources(id, branchId()) : Promise.resolve({ resources:[] }),
        { resources:workforceResources },
        'Dashboard work resources'
      );
      const loadedWorkforceConfiguration = await settleValue(
        window.PlatformAPI?.workforce?.configuration ? window.PlatformAPI.workforce.configuration(id, branchId()) : Promise.resolve({ configuration:{} }),
        { configuration:{ terminology:workforceTerminology } },
        'Dashboard workforce terminology'
      );
      const loadedEquipmentTypes = await settleValue(
        equipmentSchedulingOn() && window.EquipmentAPI?.types ? window.EquipmentAPI.types(id) : Promise.resolve({ types:[] }),
        { types:equipmentTypes },
        'Dashboard equipment types'
      );
      const loadedFloatingEvents = await settleValue(
        window.PlatformAPI?.calendarEvents?.list ? window.PlatformAPI.calendarEvents.list(id, { branch_id: branchId(), branchId: branchId() }) : Promise.resolve([]),
        [],
        'Dashboard floating events'
      );
      const loadedScopeTemplates = await settleValue(
        window.PlatformAPI?.scopes?.list ? window.PlatformAPI.scopes.list(id, branchId(), { include_disabled:true, includeDisabled:true }) : Promise.resolve({ templates:[] }),
        { templates:scopeTemplates },
        'Dashboard scope scheduling rules'
      );
      users = Array.isArray(loadedUsers) ? loadedUsers : [];
      projects = Array.isArray(loadedProjects) ? loadedProjects : [];
      const workforceConfiguration = loadedWorkforceConfiguration?.configuration || loadedWorkforceConfiguration || loadedWorkforce?.configuration || {};
      workforceTerminology = workforceConfiguration?.terminology || workforceTerminology;
      workforceGroupKinds = Array.isArray(workforceConfiguration?.resource_group_kinds)
        ? workforceConfiguration.resource_group_kinds
        : (Array.isArray(loadedWorkforce?.configuration?.resource_group_kinds) ? loadedWorkforce.configuration.resource_group_kinds : workforceGroupKinds);
      workforceResources = normalizeWorkforceResources(loadedWorkforce, workforceGroupKinds);
      equipmentUnits = Array.isArray(loadedWorkforce?.equipment_units) ? loadedWorkforce.equipment_units : [];
      equipmentTypes = Array.isArray(loadedEquipmentTypes?.types) ? loadedEquipmentTypes.types : equipmentTypes;
      scopeTemplates = Array.isArray(loadedScopeTemplates?.templates) ? loadedScopeTemplates.templates : scopeTemplates;
      const loadedFloatingList = normalizeFloatingEventList(loadedFloatingEvents);
      floatingEvents = loadedFloatingEvents?.missing && !loadedFloatingList.length ? floatingEvents : loadedFloatingList;
      allEvents = Scheduling.eventsFromProjects(projects, schedulingConfig || {}).sort((a, b) => (eventStart(a)?.getTime() ?? Number.MAX_SAFE_INTEGER) - (eventStart(b)?.getTime() ?? Number.MAX_SAFE_INTEGER));
      events = visibleEvents();
      applyUserSchedulePreferences();
      if (!defaultViewApplied) {
        defaultViewApplied = true;
        const configuredDefault = String(schedulingConfig?.scheduling?.default_view || '').trim();
        if (!routeSpecifiedView && ['day','4day','week','month','appointment_schedule','gantt'].includes(configuredDefault)
          && (configuredDefault !== 'gantt' || ganttViewEnabled())
          && (configuredDefault !== 'appointment_schedule' || routingViewEnabled())) {
          viewMode = configuredDefault;
        }
      }
      applyScheduleFocus();
      lastLoadFailedAt = 0;
    } catch (error) {
      lastLoadFailedAt = Date.now();
      if (!loadData._lastToastAt || Date.now() - loadData._lastToastAt > 5000) {
        loadData._lastToastAt = Date.now();
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_59ae500cc30197","Dashboard unavailable") ?? "Dashboard unavailable"), error?.message || 'Could not load dashboard events.', false);
      }
    } finally {
      loading = false;
      render();
      if (pendingRouteDay) {
        const day = pendingRouteDay;
        pendingRouteDay = '';
        openDayModal(`${day}T12:00:00`, { fromRoute:true });
      }
      if (loadQueued) {
        loadQueued = false;
        loadData().catch(() => null);
      }
    }
  }
  function mount(el){
    rootEl = el;
    mobileLayout = isMobileScheduleLayout();
    if (mount._placementKeyHandler) document.removeEventListener('keydown', mount._placementKeyHandler);
    mount._placementKeyHandler = (event) => {
      if (viewMode !== 'appointment_schedule' || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const panel = rootEl?.closest?.('.fm-tabpanel');
      if (panel && !panel.classList.contains('active')) return;
      if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      const key = String(event.key || '').toLowerCase();
      const redo = key === 'y' || (key === 'z' && event.shiftKey);
      if (key !== 'z' && key !== 'y') return;
      if (redo ? !placementRedoStack.length : !placementUndoStack.length) return;
      event.preventDefault();
      event.stopPropagation();
      if (redo) redoPlacement();
      else undoPlacement();
    };
    document.addEventListener('keydown', mount._placementKeyHandler);
    const route = window.Portal?.navigation?.read?.() || {};
    if (['day','4day','week','month','appointment_schedule','gantt'].includes(route.scheduleView)
      && (route.scheduleView !== 'gantt' || ganttViewEnabled())
      && (route.scheduleView !== 'appointment_schedule' || routingViewEnabled())) {
      viewMode = route.scheduleView;
      routeSpecifiedView = true;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(route.date || '')) anchorDate = new Date(`${route.date}T12:00:00`);
    if (['sales','production','materials'].includes(route.scheduleType)) scheduleMode = route.scheduleType;
    breakdownMode = route.scheduleGroup || breakdownMode;
    breakdownValue = route.scheduleResource || 'all';
    pendingRouteDay = /^\d{4}-\d{2}-\d{2}$/.test(route.day || '') ? route.day : '';
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
        window.Portal?.apps?.unregisterPortalApp?.('scheduling');
      }
      return;
    }
    if (!tabRegistered) {
      tabRegistered = true;
      window.Portal.apps.registerPortalApp({ id: 'portal.scheduling', tabId: 'scheduling', title: (globalThis.PlatformLanguage?.text("scheduling","m_4249990706c50e","Scheduling") ?? "Scheduling"), icon: 'fa-calendar-days', order: 18, fullBleed: true, mount, onShow: () => loadData() });
      window.Portal.tabs.renderTabs?.();
    }
  }
  window.Portal?.navigation?.registerHandler?.('scheduling-route', {
    priority:400,
    immediate:true,
    apply:(route) => {
      if (route.tab !== 'scheduling' || !rootEl) return;
      if (['day','4day','week','month','appointment_schedule','gantt'].includes(route.scheduleView)
        && (route.scheduleView !== 'gantt' || ganttViewEnabled())
        && (route.scheduleView !== 'appointment_schedule' || routingViewEnabled())) {
        viewMode = route.scheduleView;
        routeSpecifiedView = true;
      } else viewMode = 'week';
      if (/^\d{4}-\d{2}-\d{2}$/.test(route.date || '')) anchorDate = new Date(`${route.date}T12:00:00`);
      if (['sales','production','materials'].includes(route.scheduleType)) scheduleMode = route.scheduleType;
      breakdownMode = route.scheduleGroup || breakdownMode;
      breakdownValue = route.scheduleResource || 'all';
      const day = /^\d{4}-\d{2}-\d{2}$/.test(route.day || '') ? route.day : '';
      if (!day) activeDayModal?.close?.({ fromRoute:true });
      else if (loading) pendingRouteDay = day;
      else openDayModal(`${day}T12:00:00`, { fromRoute:true });
      render();
    }
  });
  window.addEventListener('fm:calendar:refresh', () => scheduleLoad());
  window.addEventListener('fm:dashboard:refresh', () => scheduleLoad());
  window.addEventListener('fm:projects:refresh', () => scheduleLoad());
  window.addEventListener('fm:project-config:updated', (event) => {
    branchProjectConfig = normalizeProjectConfig(event?.detail || {});
    render();
  });
  window.addEventListener('fm:workforce:updated', () => scheduleLoad());
  window.addEventListener('fm:organization-connections:updated', () => scheduleLoad());
  window.addEventListener('resize', () => {
    const nextMobileLayout = isMobileScheduleLayout();
    if (rootEl && nextMobileLayout !== mobileLayout) {
      mobileLayout = nextMobileLayout;
      mobileViewMenuOpen = false;
      mobileMonthMenuOpen = false;
      mobileScheduleMenuOpen = false;
      mobileTrayOpen = false;
      mobileTrayClosing = false;
      if (mobileTrayCloseTimer) window.clearTimeout(mobileTrayCloseTimer);
      mobileTrayCloseTimer = null;
      render();
    }
    if (viewMode === 'appointment_schedule') requestAnimationFrame(fitRoutingScheduleHeights);
  });
  window.addEventListener('fm:scheduling:focus', (event) => {
    pendingScheduleFocus = event?.detail || storedScheduleFocus();
    if (allEvents.length && applyScheduleFocus(pendingScheduleFocus)) render();
    else scheduleLoad();
  });
  window.addEventListener('fm:app-flags:updated', () => syncSchedulingTab().catch(() => null));
  document.addEventListener('DOMContentLoaded', () => syncSchedulingTab().catch(() => null));
  syncSchedulingTab().catch(() => null);
})();
