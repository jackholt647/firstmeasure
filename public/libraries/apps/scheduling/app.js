/* public/libraries/apps/scheduling/app.js
 * Dashboard tab: calendar plus branch-configurable appointment groups.
 */
(function(){
  if (!window.Portal) return;

  const cfg = window.Portal.cfg || {};
  const { injectCSS, escapeHtml } = window.Portal.util;
  const portalShowToast = window.Portal.ui.showToast;
  // Scheduling toasts are compact (as wide as the rail at desktop widths), so
  // one waiting to be dismissed never covers grid cells or the placement
  // banner's Cancel.
  function showToast(title, message, ok = true){
    const options = ok && typeof ok === 'object' ? ok : { tone:ok === false ? 'error' : (ok === true || ok === undefined ? 'success' : ok) };
    return portalShowToast(title, message, { ...options, compact:true });
  }
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
  // False until the first data load settles: views and the waiting rail show
  // a loading state instead of a false "nothing here" empty state.
  let dataLoaded = false;
  // Unsaved edits of the open event editor. Edits never touch the live
  // collections until Save succeeds, so Cancel / outside click / a failed save
  // leave the calendar showing the stored event. { id, patch }
  let eventEditorDraft = null;
  let equipmentConflictMode = '';
  let lastDataRefreshAt = 0;
  let pendingGanttScrollDate = null;
  let schedulingConfig = null;
  let dashboardConfig = null;
  let branchProjectConfig = { title_mode:'all_contacts' };
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
  // Production detail filter inside Timeline; Sales/Production/Other come
  // from the shared header toggles like every other view.
  let ganttVisibleKinds = new Set(['labor', 'equipment', 'deliveries']);
  let ganttVisibleRange = null;
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
  // One placement commit at a time (see runPlacementSave); the banner keeps
  // "Saving…" through re-renders while it runs.
  let placementSaveInFlight = false;
  let placementSavingShown = false;
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
  // Projects / company calendar items that could not be fetched. Before the
  // first good load this is an error state with Retry; after it, the last
  // good data stays on screen with a "Couldn't refresh" notice.
  let scheduleLoadError = '';
  let scheduleRefreshFailedAt = 0;
  // "View only" explains a permission, it is not an error: neutral info toast.
  const VIEW_ONLY_TOAST = { tone:'info' };
  const eventRangeSaveVersions = new Map();
  const eventRangeSaveQueues = new Map();

  /* A transient layer (date/time picker, assignee menu, confirm dialog) that
   * sits above an editor owns the next outside gesture: it closes itself and
   * the editor underneath stays open. */
  function openTransientLayer(surface = null){
    if (document.querySelector('fm-date-time-picker')) return true;
    if (document.querySelector('.fm-dialog-backdrop')) return true;
    if (surface && !surface.classList?.contains('dash-assignee-popover') && document.querySelector('.dash-assignee-popover')) return true;
    return false;
  }
  function bindOutsidePointerDismiss(surface, onDismiss, insideNodes = []){
    let pointerStartedOutside = false;
    const isInside = (target) => !!target && (surface.contains(target) || target.closest?.('.fm-dialog-backdrop') || insideNodes.some((node) => node?.contains?.(target)));
    const pointerTarget = (event) => document.elementFromPoint?.(Number(event.clientX), Number(event.clientY)) || event.target;
    const onPointerDown = (event) => { pointerStartedOutside = !isInside(pointerTarget(event)) && !openTransientLayer(surface); };
    const onPointerUp = (event) => {
      const pointerEndedOutside = !isInside(pointerTarget(event));
      if (pointerStartedOutside && pointerEndedOutside) onDismiss(pointerTarget(event));
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
    .dash-toolbar>.dash-title-wrap{flex:0 1 250px;min-width:min(210px,34%)}
    .dash-controls{flex:1 1 auto}
    .dash-title{margin:0;font-size:22px;font-weight:1000;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.25}
    .dash-title-wrap:focus-visible{outline:none}
    .dash-title-wrap{position:relative;min-width:0}
    .dash-title-status{position:absolute;left:0;top:100%;display:flex;align-items:center;gap:6px;max-width:100%;min-width:0;height:18px;overflow:hidden}
    .dash-view-only-note{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;height:18px;padding:0 8px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;font-size:10.5px;font-weight:950;white-space:nowrap;cursor:default}
    .dash-view-only-note{font-family:inherit;line-height:1;cursor:help}
    .dash-view-only-note i{font-size:10.5px}
    .dash-view-only-note:focus-visible,.dash-mobile-view-only:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
    .dash-title-status{box-sizing:border-box;height:26px;padding:4px;margin:-4px;max-width:calc(100% + 8px);pointer-events:none}.dash-title-status>*{pointer-events:auto}
    .dash-view-only-note{position:relative}
    body:has(.dash-body){--fm-toast-compact-width:266px}body:has(.dash-body.schedule-mode){--fm-toast-compact-width:320px}
    .dash-refreshing{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;height:18px;color:#667085;font-size:10.5px;font-weight:850;white-space:nowrap;animation:dash-refreshing-in .2s ease 1.2s both}.dash-refreshing i{font-size:9.5px}
    @keyframes dash-refreshing-in{from{opacity:0}to{opacity:1}}
    /* Only the spinner shows (the text is for screen readers and the tooltip)
     * so the filter pills never lose width to it. */
    .dash-refreshing-text{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
    @media(pointer:coarse){.dash-title-status{height:34px;padding:8px;margin:-8px;max-width:calc(100% + 16px)}.dash-view-only-note::after{content:"";position:absolute;inset:-8px -4px}}
    @media(max-width:1100px){.dash-title-status:has(.dash-filter-indicator) .dash-view-only-note{font-size:0;gap:0;padding:0 6px}}
    .dash-mobile-view-only{flex:0 0 auto;height:30px;display:inline-flex;align-items:center;gap:4px;padding:0 7px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;font:inherit;font-size:11px;font-weight:900;cursor:pointer}
    .dash-filter-indicator{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;height:18px;padding:0 3px 0 8px;border:1px solid rgba(var(--primary-rgb,217,48,37),.28);border-radius:999px;background:rgba(var(--primary-rgb,217,48,37),.07);color:var(--primary-readable,var(--primary,#d93025));font-size:11px;font-weight:950;white-space:nowrap}
    .dash-filter-indicator span{overflow:hidden;text-overflow:ellipsis}
    .dash-filter-indicator button{width:14px;height:14px;flex:0 0 auto;border:0;border-radius:999px;background:rgba(15,23,42,.08);color:inherit;display:inline-grid;place-items:center;cursor:pointer;font-size:10px;padding:0}
    .dash-loading-state{height:100%;min-height:220px;display:flex;align-items:center;justify-content:center;gap:10px;color:#667085;font-size:13px;font-weight:900;background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:14px}
    .dash-loading-rail{display:flex;align-items:center;gap:9px;padding:14px;border:1px dashed rgba(15,23,42,.14);border-radius:14px;background:#fff;color:#667085;font-size:12px;font-weight:900}
    .dash-empty-hint{flex:0 0 auto;margin:0 0 10px;padding:12px;border:1px dashed rgba(15,23,42,.16);border-radius:12px;background:#fff;color:#667085;font-size:12px;font-weight:850;line-height:1.4}
    .dash-load-error{height:100%;min-height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:20px;text-align:center;color:#475467;font-size:13px;font-weight:800;background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:14px}
    .dash-load-error>i{font-size:22px;color:#b54708}
    .dash-load-error strong{font-size:15px;font-weight:1000;color:#101828}
    .dash-refresh-notice{flex:0 0 auto;display:flex;align-items:center;gap:9px;margin:0 0 10px;padding:7px 8px 7px 12px;border:1px solid #fedf89;border-radius:12px;background:#fffaeb;color:#93370d;font-size:12px;font-weight:850;line-height:1.35}
    .dash-refresh-notice>span{flex:1 1 auto;min-width:0}
    .dash-load-retry{flex:0 0 auto;height:30px;display:inline-flex;align-items:center;gap:6px;padding:0 12px;border:1px solid rgba(15,23,42,.16);border-radius:10px;background:#fff;color:#344054;font-size:12px;font-weight:950;cursor:pointer}
    .dash-load-retry:hover:not(:disabled){border-color:rgba(15,23,42,.3);background:#f8fafc}
    .dash-load-retry:disabled{cursor:progress;opacity:.75}
    .dash-shell .prs-mobile-toolbar{display:none}
    @media(max-width:720px){.dash-shell .prs-mobile-toolbar{display:flex}}
    /* Month/year lists scroll on their own (and open centred on the current
     * choice) instead of the whole popover scrolling. */
    .dash-shell .prs-mobile-month-picker{height:min(280px,calc(100vh - 150px));grid-template-rows:minmax(0,1fr)}
    .dash-shell .prs-mobile-month-picker section{min-height:0}
    .dash-sub{margin:3px 0 0;font-size:12px;font-weight:800;color:#667085}
    .dash-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .dash-btn{height:36px;border:1px solid rgba(15,23,42,.12);border-radius:11px;background:#fff;color:#344054;padding:0 12px;font-weight:950;display:inline-flex;align-items:center;gap:7px;cursor:pointer}
    .dash-btn:hover{border-color:rgba(15,23,42,.24);background:#f8fafc}
    .dash-btn.active{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
    .dash-btn.segment{height:32px;border-radius:10px;padding:0 10px;font-size:12px}
    .dash-control-group{display:inline-flex;align-items:center;gap:3px;border:1px solid rgba(15,23,42,.10);background:#fff;border-radius:12px;padding:3px}
    .dash-control-label{font-size:10px;font-weight:1000;text-transform:uppercase;color:#667085;padding:0 7px}
    .dash-segmented{display:inline-flex;align-items:center;gap:2px;height:36px;box-sizing:border-box;border:1px solid rgba(15,23,42,.10);background:#fff;border-radius:12px;padding:3px}
    .dash-segmented>button{height:28px;border:0;border-radius:9px;background:transparent;color:#475467;padding:0 10px;font:inherit;font-size:12px;font-weight:950;display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap}
    .dash-segmented>button i{font-size:11px}
    .dash-segmented>button:hover{background:#f2f4f7;color:#101828}
    .dash-segmented>button.active{background:rgba(var(--primary-rgb,217,48,37),.10);color:var(--primary-readable,var(--primary,#d93025))}
    .dash-segmented>button:focus-visible,.dash-type-chip:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
    .dash-nav-group>button[data-dash-nav]{width:30px;padding:0;justify-content:center}
    .dash-segmented-label{font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em;color:#98a2b3;padding:0 6px 0 5px}
    .dash-type-chips{display:inline-flex;align-items:center;gap:5px;height:36px;box-sizing:border-box;padding:0 3px 0 0}
    .dash-type-chips .dash-control-label{padding:0 2px 0 4px;color:#98a2b3;letter-spacing:.04em}
    .dash-type-chip{--dash-chip-color:#64748b;height:30px;border:1px solid rgba(15,23,42,.12);border-radius:999px;background:#fff;color:#667085;padding:0 11px 0 6px;font:inherit;font-size:12px;font-weight:950;display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap}
    .dash-type-chip.sales{--dash-chip-color:#16a34a}
    .dash-type-chip.production{--dash-chip-color:#d97706}
    .dash-type-chip.other{--dash-chip-color:#64748b}
    .dash-type-chip-box{width:16px;height:16px;border-radius:5px;border:1.5px solid var(--dash-chip-color);box-sizing:border-box;display:grid;place-items:center;color:#fff;font-size:9px}
    .dash-type-chip-box i{opacity:0}
    .dash-type-chip:hover{border-color:rgba(15,23,42,.24);color:#344054}
    .dash-type-chip:disabled{opacity:.45;cursor:not-allowed}
    .dash-type-chip.active{color:#101828;border-color:color-mix(in srgb,var(--dash-chip-color) 45%,#fff);background:color-mix(in srgb,var(--dash-chip-color) 8%,#fff)}
    .dash-type-chip.active .dash-type-chip-box{background:var(--dash-chip-color)}
    .dash-type-chip.active .dash-type-chip-box i{opacity:1}
    .dash-body.schedule-mode.gantt-mode{grid-template-columns:minmax(0,1fr)}
    /* Narrower desktops keep the toolbar on one row: Routing/Timeline become
     * icon buttons (named by their tooltip) and the chips tighten. */
    @media(max-width:1320px){
      .dash-segmented>button.has-icon .dash-view-label{display:none}
      .dash-segmented>button.has-icon{padding:0 9px}
      .dash-type-chips>.dash-control-label{display:none}
      .dash-type-chip{padding:0 9px 0 5px}
      .dash-toolbar{gap:12px}
    }
    .dash-body.schedule-mode.gantt-mode .dash-right{display:none}
    .dash-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 266px;gap:16px;padding:14px 18px 18px;overflow:hidden}
    .dash-body.schedule-mode{grid-template-columns:minmax(0,1fr) 320px}
    .dash-left,.dash-right{min-height:0;overflow:auto}
    .dash-body.schedule-mode .dash-right{overflow:hidden}
    .dash-body.schedule-mode .dash-right>.dash-groups{height:100%;min-height:0}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-rail-title{flex:0 0 auto}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-group{display:flex;flex:0 1 auto;min-height:min(118px,100%);flex-direction:column}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-group.empty{flex:0 0 auto}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-group.empty,.dash-body.schedule-mode .dash-right>.dash-groups>.dash-group:has(>.dash-rail-loading){min-height:0}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-group:has(>.dash-group-head[aria-expanded="false"]){flex:0 0 auto;min-height:0}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-vehicle-bank{flex:0 1 auto;min-height:min(96px,100%);overflow-y:auto;overscroll-behavior:contain}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-group.empty>.dash-group-body{flex:0 0 auto;overflow:visible}
    .dash-body.schedule-mode .dash-right>.dash-groups>.dash-group.empty>.dash-group-body>.dash-empty{padding:2px 0 10px!important;font-size:12px}
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
    .dash-day-list .dash-list-event{width:100%;box-sizing:border-box;min-width:0;text-align:left;font:inherit;color:inherit;padding:12px 14px;grid-template-columns:132px minmax(0,1fr) auto}
    @media(max-width:640px){.dash-day-list .dash-list-event{grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:10px 12px}.dash-day-list .dash-list-time{grid-column:1 / -1}.dash-day-list .dash-list-title,.dash-day-list .dash-list-meta{overflow-wrap:anywhere}}.dash-day-list .dash-list-event:hover,.dash-day-list .dash-list-event:focus-visible{border-color:rgba(var(--primary-rgb,217,48,37),.35);background:#fcfcfd;outline:none}.dash-day-list .dash-list-title,.dash-day-list .dash-list-meta{display:block}
    .dash-schedule-view .prs-month .prs-day-num{cursor:pointer;position:relative;z-index:12;border-radius:999px}.dash-schedule-view .prs-month .prs-day-num:hover{text-decoration:underline}.dash-schedule-view .prs-month .prs-day-num:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
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
    .dash-appt-tile.selected .dash-appt-title,.dash-appt-tile.selected .dash-appt-address{white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .dash-appt-tile.selected .dash-stage-pill{background:rgba(var(--primary-rgb),.14);color:var(--primary-readable,var(--primary,#d93025))}
    .dash-appt-tile.selected:not(.project-only):not(.has-action) .dash-appt-title,.dash-appt-tile.selected:not(.project-only):not(.has-action) .dash-appt-sales{grid-column:1/-1;max-width:none;justify-self:stretch}
    .dash-appt-tile.selected:not(.project-only):not(.has-action) .dash-stage-pill{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;justify-self:end}
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
    .dash-event-confirm-channels{display:flex;flex-wrap:wrap;gap:10px}.dash-event-confirm-channels .dash-event-customer-option,.dash-event-confirm-channels .dash-event-customer-option:first-child{margin-top:0;align-items:center}
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
    .dash-bundle-item{height:auto;min-height:27px;padding-top:4px;padding-bottom:4px}.dash-bundle-item>span:not(.dash-bundle-item-pill){white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.3}
    .dash-bundle-item-row{display:flex;align-items:center;gap:4px;min-width:0}.dash-bundle-item-row>.dash-bundle-item{flex:1 1 auto}
    .dash-bundle-item-pill{margin-left:auto;flex:0 0 auto;border-radius:999px;padding:2px 6px;background:#f2f4f7;color:#667085;font-size:9.5px;font-weight:1000}.dash-bundle-item-pill.ordered{background:#dcfce7;color:#15803d}
    .dash-bundle-child-cancel{width:22px;height:22px;flex:0 0 22px;border:0;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;background:rgba(15,23,42,.07);color:#667085;cursor:pointer}
    .dash-bundle-cancel{width:22px;height:22px;border:0;border-radius:7px;background:rgba(15,23,42,.06);color:#667085;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
    .dash-bundle-cancel:hover,.dash-bundle-child-cancel:hover{background:#fee4e2;color:#b42318}
    .dash-schedule-pile{position:relative}.dash-schedule-pile>.dash-bundle-cancel{position:absolute;top:10px;right:10px;z-index:1}.dash-bundle-cancel-slot{width:22px;height:22px;justify-self:end}
    .dash-group-head .fa-chevron-up,.dash-group-head .fa-chevron-down{margin-left:6px;font-size:9px}
    .dash-group-head[aria-expanded="false"]+.dash-group-body{display:none}
    .dash-group-head:focus-visible,.dash-appt-tile:focus-visible,.dash-bundle-item:focus-visible,.dash-bundle-summary:focus-visible,.dash-bundle-cancel:focus-visible,.dash-bundle-child-cancel:focus-visible,.dash-vehicle-bank-item:focus-visible,.dash-placement-cancel:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:-2px}
    .dash-appt-draft-time{color:var(--primary-readable,var(--primary,#d93025))}
    .dash-rail-loading,.dash-schedule-loading{display:flex;align-items:center;justify-content:center;gap:9px;min-height:120px;border:1px dashed rgba(15,23,42,.14);border-radius:14px;background:#fff;color:#667085;font-size:12px;font-weight:900}
    .dash-placement-banner{flex:0 0 auto;display:flex;align-items:center;gap:10px;margin:0 0 8px;padding:7px 8px 7px 12px;border:1px solid rgba(var(--primary-rgb,217,48,37),.28);border-radius:11px;background:rgba(var(--primary-rgb,217,48,37),.06);color:#344054;font-size:12px;font-weight:850;line-height:1.35}
    .dash-placement-banner>i{color:var(--primary-readable,var(--primary,#d93025))}.dash-placement-banner>span{flex:1;min-width:0}.dash-placement-banner strong{color:#101828;font-weight:1000}
    .dash-placement-banner.past{border-color:#f5c26b;background:#fffbeb}.dash-placement-banner-warn{color:#b45309;font-weight:950;white-space:nowrap}
    .dash-rail-viewonly{display:flex;align-items:center;gap:7px;margin:0 0 8px;padding:7px 10px;border:1px dashed rgba(15,23,42,.18);border-radius:10px;background:#fff;color:#667085;font-size:11px;font-weight:900;line-height:1.35}
    .dash-groups.view-only .dash-appt-tile,.dash-groups.view-only .dash-bundle-item,.dash-groups.view-only .dash-vehicle-bank-item{cursor:default}
    .dash-groups.view-only .dash-appt-tile:hover,.dash-groups.view-only .dash-bundle-item:hover{transform:none;box-shadow:none;border-color:rgba(15,23,42,.08)}
    .dash-groups .dash-group-body>.dash-empty{padding:9px 12px!important;font-size:12px;font-weight:850;color:#667085}
    @media(min-width:721px){.dash-schedule-card:has(>.dash-placement-banner){position:relative}.dash-schedule-card>.dash-placement-banner{position:absolute;z-index:40;left:50%;bottom:14px;transform:translateX(-50%);width:max-content;max-width:min(760px,calc(100% - 32px));margin:0;background:#fff7f6;box-shadow:0 10px 28px rgba(15,23,42,.18)}.dash-schedule-card>.dash-placement-banner.past{background:#fffbeb}.dash-schedule-card:has(>.dash-placement-banner) :is(.prs-surface,.dash-schedule-pane:last-child .prs-resource-scroll){padding-bottom:var(--dash-banner-space,68px);scroll-padding-bottom:var(--dash-banner-space,68px);box-sizing:border-box}}
    @media(max-width:720px){#dashEventCalendarView .prs-month-bar .prs-work-chip.has-confirm .prs-confirm{top:-10px;right:-6px;transform:none;width:24px;height:24px;z-index:3}#dashEventCalendarView .prs-work-chip.has-confirm .prs-confirm::after{content:"";position:absolute;inset:-5px;border-radius:999px}}
    .dash-placement-busy [data-prs-confirm],.dash-placement-busy .prs-draft-confirm{pointer-events:none;opacity:.5;cursor:progress}
    [data-dash-key-place]:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:-2px}
    .dash-placement-banner[data-saving]>span{color:#475467}.dash-placement-banner[data-saving]>span i{margin-right:4px}
    .dash-placement-cancel{height:28px;flex:0 0 auto;border:1px solid rgba(15,23,42,.14);border-radius:8px;background:#fff;color:#344054;padding:0 10px;font:inherit;font-size:11px;font-weight:950;cursor:pointer;white-space:nowrap}.dash-placement-cancel:hover{background:#f8fafc}.dash-placement-cancel:disabled{opacity:.5;cursor:not-allowed;background:#fff}
    .dash-routing-flag.double-booked{background:#fee2e2;color:#b42318;border:1px solid #fca5a5}
    .dash-schedule-view .prs-work-chip.dash-double-booked{outline:2px solid #f04438;outline-offset:-2px}
    .dash-schedule-view .prs-work-chip.compact-resource-item{display:flex;align-items:center;gap:6px}.dash-schedule-view .prs-work-chip.compact-resource-item>.prs-chip-top{flex:1 1 auto;min-width:0}.dash-schedule-view .prs-work-chip.compact-resource-item>.prs-chip-bottom{flex:0 1 auto;min-width:0;max-width:45%;margin:0}.dash-schedule-view .prs-work-chip.compact-resource-item>.prs-chip-bottom>.prs-project-title,.dash-schedule-view .prs-work-chip.compact-resource-item>.prs-chip-bottom>.prs-time{display:none}
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
    .dash-assignee-option .dash-assignee-check{flex:0 0 auto;color:#98a2b3;font-size:13px}
    .dash-assignee-option.active .dash-assignee-check{color:inherit}
    .dash-assignee-option .dash-assignee-check+span{flex:1 1 auto}
    .dash-assignee-head{padding:4px 9px 6px;color:#667085;font-size:10.5px;font-weight:900;text-transform:uppercase;letter-spacing:.04em}
    .dash-event-popover{position:fixed;z-index:2600;width:420px;height:620px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:16px;box-shadow:0 22px 60px rgba(15,23,42,.20);padding:16px;display:flex;flex-direction:column;gap:12px}.dash-event-popover>*{flex-shrink:0}
    .dash-event-popover.dash-event-saving{cursor:progress}.dash-event-popover.dash-event-saving :is(input,textarea,select,button,label,[role="button"]){pointer-events:none}.dash-event-popover.dash-event-saving :is(input,textarea,select){opacity:.72}
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
    .dash-gantt-shown-menu{position:absolute;left:0;top:34px;z-index:40;width:260px;max-width:calc(100vw - 16px);box-sizing:border-box;border:1px solid #e4e7ec;border-radius:14px;background:#fff;box-shadow:0 20px 55px rgba(15,23,42,.2);padding:8px}
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
    .dash-equipment-picker summary{cursor:pointer;display:flex;align-items:center;gap:8px;list-style:none}.dash-equipment-picker summary::-webkit-details-marker{display:none}.dash-equipment-picker summary .fa-chevron-down{margin-left:auto}
    .dash-equipment-options[hidden],.dash-equipment-confirm[hidden]{display:none}.dash-equipment-options{display:grid;gap:4px;max-height:240px;overflow:auto;margin-top:6px;padding:4px;border:1px solid #e4e7ec;border-radius:9px}
    .dash-equipment-option{display:flex;align-items:center;gap:10px;width:100%;padding:9px;border:0;border-radius:6px;background:#fff;text-align:left;color:#344054;font:inherit;cursor:pointer}.dash-equipment-option:hover,.dash-equipment-option:focus-visible{background:#f2f4f7}.dash-equipment-option>i{width:22px;text-align:center}.dash-equipment-option span{min-width:0;display:grid;gap:3px;overflow-wrap:anywhere}.dash-equipment-option strong{font-size:12px}.dash-equipment-option small{font-size:11px;color:#667085}
    .dash-equipment-option.down,.dash-event-equipment-chip.down{color:#b42318;background:#fef3f2}.dash-equipment-option.down small{color:#b42318}.dash-equipment-option.down strong,.dash-event-equipment-chip.down .dash-equipment-name{text-decoration:line-through}
    .dash-equipment-confirm{padding:10px;border:1px solid #fda29b;border-radius:8px;background:#fef3f2;color:#b42318;font-size:12px}.dash-equipment-confirm p{margin:0 0 8px}.dash-equipment-confirm button{padding:7px 10px;border:1px solid #fda29b;border-radius:6px;background:#fff;color:#b42318;font:inherit;cursor:pointer}.dash-equipment-confirm button+button{margin-left:6px}.dash-equipment-confirm [data-equipment-confirm]{background:#b42318;color:#fff}
    .dash-event-equipment-require{display:grid;grid-template-columns:minmax(0,1fr) 72px 34px;gap:6px;align-items:end}.dash-event-equipment-require input{height:34px;box-sizing:border-box;border:1px solid rgba(15,23,42,.12);border-radius:8px;padding:0 8px;font:850 11px/1 inherit}.dash-event-equipment-require button{height:34px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#475467;cursor:pointer}.dash-event-advanced-note{font-size:10px;font-weight:800;color:#667085;line-height:1.4}.dash-event-advanced-toggle{width:36px;height:34px;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;color:#667085;display:inline-grid;place-items:center;cursor:pointer}.dash-event-advanced-toggle.active{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb),.07);color:var(--primary,#d93025)}
    .dash-event-equipment-allocation{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;padding:7px;border-radius:9px;background:#f8fafc}.dash-event-equipment-allocation strong{grid-column:1/-1;font-size:10px;color:#475467}.dash-event-equipment-allocation label{display:grid;gap:3px;font-size:8px;font-weight:950;color:#667085;text-transform:uppercase}.dash-event-equipment-allocation input{width:100%;min-width:0;height:30px;box-sizing:border-box;border:1px solid rgba(15,23,42,.12);border-radius:7px;padding:0 6px;font:800 11px/1 inherit;color:#344054}.dash-event-requirement-alert{display:flex;gap:8px;align-items:flex-start;border:1px solid #fda29b;border-radius:10px;background:#fef3f2;color:#b42318;padding:9px 10px;font-size:11px;font-weight:850;line-height:1.35}.dash-event-requirement-alert ul{margin:0;padding-left:16px}.dash-routing-vehicles{height:30px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#667085;padding:0 9px;cursor:pointer}.dash-routing-vehicles.active{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb),.07);color:var(--primary,#d93025)}.dash-vehicle-bank{display:grid;gap:7px;padding:10px 12px;border-top:1px solid rgba(15,23,42,.08)}.dash-vehicle-bank-title{font-size:10px;font-weight:1000;letter-spacing:.06em;text-transform:uppercase;color:#667085}.dash-vehicle-bank-items{display:grid;gap:6px}.dash-vehicle-bank-item{display:flex;align-items:center;gap:8px;text-align:left;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;padding:8px;color:#344054;font-size:11px;font-weight:900;cursor:pointer}.dash-vehicle-bank-item>span{min-width:0;display:grid;gap:1px}.dash-vehicle-bank-item small{font-size:10px;font-weight:800;color:#667085}.dash-vehicle-bank-item.reserved{border-style:dashed;background:#fffbeb}.dash-vehicle-bank-flag{margin-left:auto;flex:0 0 auto;border-radius:999px;padding:2px 6px;background:#fef3c7;color:#b45309;font-size:9.5px;font-weight:1000}.dash-routing-vehicles{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:10px;font-weight:1000;text-transform:none;letter-spacing:0}.dash-vehicle-bank-item.active{border-color:var(--primary,#d93025);box-shadow:0 0 0 2px rgba(var(--primary-rgb),.08)}
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
    .dash-event-type-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
    .dash-event-type-btn{height:32px;border:1px solid rgba(15,23,42,.10);border-radius:10px;background:#f8fafc;color:#344054;font-size:11px;font-weight:950;cursor:pointer}
    .dash-event-type-btn:hover{border-color:rgba(15,23,42,.22);background:#fff}
    .dash-event-type-btn.active{border-color:var(--primary,#d93025);box-shadow:inset 0 0 0 1px var(--primary,#d93025);background:rgba(var(--primary-rgb),.07);color:#101828}
    .dash-event-project-picker{position:relative;z-index:3}.dash-event-project-picker:has(.dash-event-project-list:not([hidden])){z-index:7}.dash-event-project-picker-row{display:grid;grid-template-columns:minmax(0,1fr) 38px;gap:7px}.dash-event-project-create{width:38px;height:38px;border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#fff;color:#475467;display:grid;place-items:center;cursor:pointer}.dash-event-project-create:hover,.dash-event-project-create:focus-visible{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb),.06);color:var(--primary,#d93025);outline:none}.dash-event-search{width:100%;height:38px;box-sizing:border-box;border:1px solid rgba(15,23,42,.12);border-radius:10px;padding:0 10px;font-size:12px;font-weight:850;color:#101828;outline:none}
    .dash-event-search:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb),.10)}
    .dash-event-desc{min-height:74px;resize:vertical;border:1px solid rgba(15,23,42,.12);border-radius:10px;padding:9px 10px;font-size:12px;font-weight:850;color:#101828;outline:none;font-family:inherit}
    .dash-event-desc:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb),.10)}
    .dash-event-project-list{position:absolute;left:0;right:0;top:calc(100% + 5px);display:grid;gap:4px;max-height:210px;overflow:auto;padding:6px;background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:11px;box-shadow:0 18px 45px rgba(15,23,42,.18)}.dash-event-project-list[hidden]{display:none}
    .dash-event-project-option{border:0;border-radius:9px;background:transparent;color:#344054;text-align:left;padding:8px 9px;display:grid;gap:2px;cursor:pointer}
    .dash-event-project-option:hover{background:#f8fafc}
    .dash-event-project-option strong{font-size:12px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dash-event-project-option span{font-size:10px;font-weight:850;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dash-event-pop-actions{position:sticky;bottom:-16px;z-index:6;display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:auto;padding:10px 0 2px;background:#fff;border-top:1px solid rgba(15,23,42,.07)}
    .dash-event-view-btn{height:34px;border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#fff;color:#344054;padding:0 11px;font-size:12px;font-weight:950;cursor:pointer}
    .dash-event-delete{height:34px;border:1px solid #fecdca;border-radius:10px;background:#fff;color:#b42318;padding:0 11px;font-size:12px;font-weight:950;cursor:pointer}.dash-event-delete:hover{background:#fef3f2}.dash-event-delete:disabled{opacity:.55;cursor:wait}
    .dash-event-save{height:34px;border:0;border-radius:10px;background:var(--primary,#d93025);color:var(--on-primary,#fff);padding:0 13px;font-size:12px;font-weight:1000;cursor:pointer}
    .dash-event-save:disabled{background:#d0d5dd;color:#667085;cursor:not-allowed}.dash-event-view-btn:disabled{opacity:.55;cursor:wait}
    .dash-event-notice{display:flex;align-items:flex-start;gap:8px;padding:9px 10px;border-radius:10px;font-size:11px;font-weight:850;line-height:1.4;border:1px solid #d0d5dd;background:#f8fafc;color:#475467}.dash-event-notice i{margin-top:2px}.dash-event-notice.locked{border-color:#fedf89;background:#fffaeb;color:#93370d}.dash-event-notice.error{border-color:#fda29b;background:#fef3f2;color:#b42318}.dash-event-notice ul{margin:4px 0 0;padding-left:16px}
    .dash-event-popover.read-only input:disabled,.dash-event-popover.read-only textarea:disabled,.dash-event-popover.read-only select:disabled,.dash-event-popover .dash-event-time-field input:disabled{background:#f8fafc;color:#475467;cursor:default}
    .dash-event-popover.read-only [data-event-assign-add],.dash-event-popover.read-only [data-event-assign-remove],.dash-event-popover.read-only [data-event-equipment-remove],.dash-event-popover.read-only [data-event-equipment-require-remove]{display:none}.dash-event-popover.read-only button:disabled{opacity:.5;cursor:default}
    .dash-event-popover .dash-event-switch input:disabled+.dash-event-switch-track{opacity:.5}.dash-event-popover .dash-event-switch:has(input:disabled){cursor:default}
    .dash-event-title-input.invalid,.dash-event-title-input.invalid:focus{border-color:#d92d20;background:#fef3f2 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%23d92d20'/%3E%3Cpath d='M8 4v5' stroke='%23fff' stroke-width='1.8' stroke-linecap='round'/%3E%3Ccircle cx='8' cy='11.6' r='1' fill='%23fff'/%3E%3C/svg%3E") no-repeat right 10px center/15px;padding-right:32px;box-shadow:0 0 0 3px rgba(217,45,32,.18)}
    .dash-event-title-input.invalid::placeholder{color:#b42318}
    #dashEventCalendarView .prs-work-chip.dash-dep-conflict{box-shadow:inset 0 0 0 1.5px #d92d20}
    #dashEventCalendarView .dash-dep-conflict-marker{position:relative;display:inline-grid;vertical-align:-2px;margin-right:3px;flex:0 0 auto;width:13px;height:13px;border-radius:999px;background:#d92d20;color:#fff;place-items:center;font-size:7px;line-height:1;pointer-events:auto;cursor:pointer}
    .dash-assignee-popover.above{box-shadow:0 -18px 50px rgba(15,23,42,.18)}
    .dash-event-confirm-actions{display:flex;flex-wrap:wrap;gap:6px}.dash-event-confirm-actions button{height:28px;border:1px solid rgba(15,23,42,.14);border-radius:8px;background:#fff;color:#344054;padding:0 9px;font:inherit;font-size:11px;font-weight:950;cursor:pointer}.dash-event-confirm-actions button.primary{border-color:#1f8a57;background:#1f8a57;color:#fff}.dash-event-confirm-actions button:disabled{opacity:.55;cursor:wait}
    .dash-event-equipment-meta{display:grid;gap:4px;padding:9px 10px;border:1px solid rgba(15,23,42,.10);border-radius:10px;background:#f8fafc;font-size:12px;font-weight:850;color:#344054}.dash-event-equipment-meta small{color:#667085;font-weight:800}
    .dash-equipment-option:disabled{cursor:not-allowed;opacity:.75}
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
    .dash-section-modal{width:min(520px,94vw)}.dash-section-modal h3{margin:0;font-size:17px;font-weight:1000;color:#101828}
    .dash-section-name{display:grid;gap:6px;color:#475467;font-size:12px;font-weight:950}.dash-section-name input{height:38px;border:1px solid rgba(15,23,42,.14);border-radius:10px;padding:0 10px;font:inherit;font-size:14px;font-weight:850;color:#101828;outline:none}.dash-section-name input:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.1)}
    .dash-section-note{margin:8px 0 14px;color:#667085;font-size:12px;font-weight:800;line-height:1.4}
    .dash-section-items-head{margin:0 0 6px;color:#475467;font-size:11px;font-weight:1000;letter-spacing:.04em;text-transform:uppercase}
    .dash-section-items{display:grid;gap:4px;max-height:min(320px,40vh);overflow:auto;padding:4px;border:1px solid rgba(15,23,42,.08);border-radius:12px;background:#f8fafc}
    .dash-section-item{display:flex;align-items:flex-start;gap:9px;padding:7px 8px;border-radius:9px;background:#fff;cursor:pointer}.dash-section-item:hover{background:#f2f4f7}.dash-section-item input{margin-top:2px;flex:0 0 auto}
    .dash-section-item span{display:grid;gap:2px;min-width:0}.dash-section-item strong{font-size:13px;font-weight:950;color:#101828;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dash-section-item small{font-size:11px;font-weight:800;color:#667085}
    .dash-section-empty{padding:10px;color:#667085;font-size:12px;font-weight:800}
    .dash-section-delete{color:#b42318;border-color:#fecdca}.dash-section-delete:hover{background:#fef3f2}
    [data-section-status]:empty{display:none}[data-section-status]{margin-top:8px;color:#b42318;font-size:12px;font-weight:900}
    .dash-modal-status{font-size:12px;font-weight:850;color:#667085}
    @media(max-width:1100px){
      /* The shell keeps the tab's height: the toolbar stays put, the calendar
       * fills the visible body and scrolls inside itself, and the waiting rail
       * sits below it, reached by scrolling the body. */
      .dash-body,.dash-body.schedule-mode{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(360px,calc(100% - 4px)) auto;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}
      .dash-body.schedule-mode.gantt-mode{grid-template-rows:minmax(0,1fr)}
      .dash-right,.dash-body.schedule-mode .dash-right{overflow:visible;min-height:0}
      .dash-body.schedule-mode .dash-right>.dash-groups{height:auto}
      .dash-body.schedule-mode .dash-right>.dash-groups>.dash-group{flex:0 0 auto}
      .dash-body.schedule-mode .dash-right>.dash-groups>.dash-group>.dash-group-body{max-height:420px}
      .dash-left{overflow:hidden;min-height:0}
      .dash-title{font-size:19px}.dash-toolbar{gap:12px}
      .dash-stats-row{grid-template-columns:var(--dash-mode-col) minmax(126px,var(--dash-filter-col)) repeat(var(--dash-stat-count),minmax(92px,1fr));overflow-x:auto;padding-bottom:2px}
      .dash-filter-menu{left:calc(var(--dash-mode-col) + var(--dash-stat-gap));right:auto;width:650px}
    }
      .dash-new-appointment{background:#d93025!important;color:#fff!important;border:0!important;border-radius:8px;padding:9px 13px;font:inherit;font-weight:700;cursor:pointer;white-space:nowrap}
    .dash-mobile-toolbar{display:none}
    @media(max-width:720px){
      /* Phone Routing lanes: the person's name gets the full label width and
       * the lane actions sit on a line below it instead of truncating it. */
      .dash-schedule-view .psv-resource-label-main{flex-wrap:wrap;row-gap:2px;justify-content:flex-start}
      .dash-schedule-view .psv-resource-label-name{flex:1 1 100%;font-size:10.5px;line-height:1.2;letter-spacing:-.1px}
      .dash-schedule-view .psv-resource-label-actions:empty{display:none}
      /* Timeline "Items shown" opens toward the screen's middle. */
      .dash-gantt-shown-menu{left:auto;right:0}
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
      .dash-mobile-popover button:disabled{opacity:.45;cursor:default;background:transparent}
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
      .dash-body.events-mode .dash-schedule-view .prs-slot{min-width:0;overflow:visible}.dash-body.events-mode .dash-schedule-view .prs-slot .prs-work-chip{z-index:4}
      /* Slots stay free of z-index (no stacking context, as on desktop): a
       * later slot's white background never paints over a longer chip that
       * starts in an earlier slot, and never takes its taps. */
      .dash-schedule-view .prs-time-grid.prs-time-header-grid{height:48px}
      .dash-schedule-view .prs-time-head,.dash-schedule-view .prs-day-head{height:48px;font-size:10px;line-height:1.1}
      .dash-schedule-view .prs-day-head{flex-direction:column;gap:2px}
      .dash-schedule-view .prs-day-head-desktop{display:none}
      .dash-schedule-view .prs-day-head-mobile{display:flex;flex-direction:column;align-items:center;line-height:1.05}
      .dash-schedule-view .prs-day-head-mobile strong{font-size:12px;color:#101828}
      .dash-schedule-view .prs-all-day-grid,.dash-schedule-view .prs-wrap.mobile-layout .prs-all-day-grid{top:48px}
      .dash-schedule-view .prs-all-day-grid:not(.week-overflow),.dash-schedule-view .prs-wrap.mobile-layout .prs-all-day-grid:not(.week-overflow){min-height:48px!important;height:auto!important;max-height:118px;grid-template-rows:auto!important;padding-bottom:4px;box-sizing:border-box}
      .dash-schedule-view .prs-all-day-label-cell{font-size:8px;line-height:1.05;text-align:center;text-transform:uppercase;padding:3px}
      .dash-schedule-view .prs-all-day-label-desktop{display:none}
      .dash-schedule-view .prs-all-day-label-mobile{display:inline}
      .dash-schedule-view .prs-all-day-cell{min-height:48px}
      .dash-schedule-view .prs-all-day-bar-top{margin:3px 1px 0}
      .dash-schedule-view .prs-all-day-bar-top .prs-work-chip{height:24px;min-height:24px;border-left-width:2px;border-radius:5px;padding:2px 3px;font-size:8px;box-shadow:none}
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
      .dash-schedule-split.mobile-routing .prs-resource-label{position:sticky;left:0;z-index:6;min-height:34px;height:34px;padding:0 4px 0 6px;flex-direction:row;align-items:center;justify-content:space-between;font-size:12px;border-bottom:1px solid rgba(15,23,42,.08)}
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
      .dash-event-popover{z-index:2147483000!important;top:0!important;right:0!important;bottom:0!important;left:0!important;width:100%!important;height:100dvh!important;max-width:none!important;max-height:none!important;border:0;border-radius:0;box-shadow:none;padding:16px;padding-top:max(16px,env(safe-area-inset-top));gap:12px}
      .dash-event-time-options{gap:10px 14px}.dash-event-switch{white-space:normal;min-width:0}
      .dash-event-pop-head>.dash-event-time-fields,.dash-event-pop-head>.dash-event-time-options,.dash-event-pop-head>.dash-event-recurrence-fields{grid-column:1/-1}
      .dash-shell .prs-mobile-control.month{width:auto;max-width:min(150px,40vw)}
      .dash-mobile-toolbar-placeholder{height:50px;background:#fff}
      .dash-event-time-fields{grid-template-columns:minmax(0,1fr)}
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
  /* Session permission gate. Reads the signed-in user's effective permission
   * flags (Portal.currentUser.permissions); any of the '|'-separated keys
   * grants. Unknown sessions (permissions not loaded) stay permissive because
   * the API enforces the same rule on every write. */
  function sessionHasPermission(keys = ''){
    const wanted = String(keys || '').split('|').map((key) => key.trim()).filter(Boolean);
    const permissions = window.Portal?.currentUser?.permissions;
    if (!permissions || typeof permissions !== 'object' || !Object.keys(permissions).length) return true;
    return wanted.some((key) => permissions[key] === true || (permissions['*'] === true && permissions[key] !== false));
  }
  /* Whether this session may change the schedule (create, move, resize,
   * edit, lock or delete schedule items). Every renderer call and editor
   * surface in this app derives allowCreate/allowEdit/allowEventDrag and
   * read-only states from this one helper. */
  function canEditSchedule(){
    return sessionHasPermission('manage_schedule');
  }
  function scheduleReadOnlyMessage(){
    return (globalThis.PlatformLanguage?.text("scheduling","m_readonly_schedule","You can view the schedule, but you don't have permission to change it.") ?? "You can view the schedule, but you don't have permission to change it.");
  }
  function currentUserDoc(){
    const email = String(cfg.userEmail || window.__APP?.userEmail || '').trim().toLowerCase();
    const sessionUser = window.Portal?.currentUser?.user || {};
    const sessionId = clean(sessionUser.id || sessionUser.user_id);
    return (email ? users.find((user) => String(user.email || '').trim().toLowerCase() === email) : null)
      || (sessionId ? users.find((user) => clean(user.id) === sessionId) : null)
      || (sessionId ? sessionUser : null);
  }
  const SCHEDULE_USER_PREFS_KEY = 'fm:scheduling:user-preferences';
  function localSchedulePreferences(){
    try { return JSON.parse(window.localStorage?.getItem(SCHEDULE_USER_PREFS_KEY) || '{}') || {}; } catch (error) { return {}; }
  }
  function applyUserSchedulePreferences(){
    if (schedulePrefsApplied) return;
    const me = currentUserDoc();
    const local = localSchedulePreferences();
    if (!me && !Object.keys(local).length) return;
    schedulePrefsApplied = true;
    // The account copy wins; this browser's copy covers settings the account
    // could not store.
    const prefs = { ...local, ...(me?.preferences?.scheduling || {}) };
    if (typeof prefs.live_travel === 'boolean') appointmentScheduleLiveTravel = prefs.live_travel;
    if (typeof prefs.production_live_travel === 'boolean') productionLiveTravel = prefs.production_live_travel;
    if (typeof prefs.production_vehicles === 'boolean') productionVehiclesVisible = prefs.production_vehicles;
    if (Number(prefs.gantt_zoom) > 0) ganttZoomPxPerDay = Number(prefs.gantt_zoom);
    if (['project', 'resource'].includes(clean(prefs.gantt_group_by))) ganttGroupBy = clean(prefs.gantt_group_by);
  }
  /* Saves the signed-in person's own scheduling view settings (their own
   * user record's preferences — every member may write those), and keeps a
   * copy in this browser. A refused save is not retried for the session. */
  async function persistSchedulePreference(patch = {}){
    try { window.localStorage?.setItem(SCHEDULE_USER_PREFS_KEY, JSON.stringify({ ...localSchedulePreferences(), ...patch })); } catch (error) {}
    const me = currentUserDoc();
    if (!me?.id || !window.PlatformAPI?.documents?.setField || persistSchedulePreference._refused) return;
    const preferences = { ...(me.preferences || {}), scheduling: { ...((me.preferences || {}).scheduling || {}), ...patch } };
    me.preferences = preferences;
    try {
      await window.PlatformAPI.documents.setField(orgId(), 'users', me.id, 'preferences', preferences, { kind:'user_preferences' });
    } catch (error) {
      if ([401, 403].includes(Number(error?.status))) persistSchedulePreference._refused = true;
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
    const mode = clean(config?.title_mode || config?.project_title_mode || 'all_contacts');
    return {
      ...(config && typeof config === 'object' ? config : {}),
      title_mode:['all_contacts','customer_name','address','manual'].includes(mode) ? mode : 'all_contacts'
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
  function weekStart(date){ const d = startOfDay(date) || startOfDay(new Date()); d.setDate(d.getDate() - d.getDay()); return d; }
  function monthStart(date){ return new Date(date.getFullYear(), date.getMonth(), 1); }
  function monthEnd(date){ return new Date(date.getFullYear(), date.getMonth() + 1, 1); }
  function routeDate(value = anchorDate){
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  /* date=YYYY-MM-DD from a link; anything that is not a real calendar date
   * (2026-13-45, 2026-00-10, garbage) is ignored instead of crashing. */
  // Links can open at most ten years either side of today: far-off dates
  // would make the Timeline lay out every day in between.
  const ROUTE_YEAR_MIN = new Date().getFullYear() - 10;
  const ROUTE_YEAR_MAX = new Date().getFullYear() + 10;
  function parseRouteDate(value){
    const text = clean(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return null;
    // Years outside that range are clamped (0000-01-01 → the earliest year).
    const year = Math.max(ROUTE_YEAR_MIN, Math.min(ROUTE_YEAR_MAX, Number(match[1])));
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(year, month, day, 12, 0, 0, 0);
    // A day that doesn't exist in its month (2026-02-30) is not rolled over.
    if (!Number.isFinite(date.getTime()) || date.getMonth() !== month || date.getDate() !== day) return null;
    return date;
  }
  const SCHEDULE_TYPE_KEYS = ['sales', 'production', 'other'];
  /* scheduleType= carries the Show chips: one type (sales | production |
   * materials, as documented) or a comma list; "none" hides everything. */
  function scheduleTypesFromRoute(value){
    const text = clean(value).toLowerCase();
    if (!text) return null;
    if (text === 'none') return [];
    const list = [...new Set(text.split(',').map((item) => item.trim()).map((item) => item === 'materials' ? 'production' : item).filter((item) => SCHEDULE_TYPE_KEYS.includes(item)))];
    return list.length ? list : null;
  }
  function applyScheduleTypes(list = SCHEDULE_TYPE_KEYS){
    showSalesSchedule = list.includes('sales');
    showProductionSchedule = list.includes('production');
    showOtherSchedule = list.includes('other');
    scheduleMode = showSalesSchedule ? 'sales' : (showProductionSchedule ? 'production' : 'sales');
  }
  function scheduleTypeRouteValue(){
    const active = activeScheduleTypes();
    if (active.length === SCHEDULE_TYPE_KEYS.length) return null;
    return active.length ? active.join(',') : 'none';
  }
  const SCHEDULE_VIEW_PREF_KEY = 'fm:scheduling:view';
  const SCHEDULE_TYPES_PREF_KEY = 'fm:scheduling:types';
  function readSchedulePref(key){
    try { return window.localStorage?.getItem(key) || ''; } catch (error) { return ''; }
  }
  function writeSchedulePref(key, value){
    try {
      if (value === null || value === undefined || value === '') window.localStorage?.removeItem(key);
      else window.localStorage?.setItem(key, String(value));
    } catch (error) {}
  }
  function scheduleViewAllowed(view = ''){
    return ['day','4day','week','month','appointment_schedule','gantt'].includes(view)
      && (view !== 'gantt' || ganttViewEnabled())
      && (view !== 'appointment_schedule' || routingViewEnabled());
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
  /* A project's schedule section (Timeline group): production-side, but
   * never a placement of its own. */
  function isProjectSection(event){
    return !!event && !!clean(event.project_id) && event.floating_event !== true
      && (window.PlatformScheduling?.eventIsGroup?.(event) === true || ['group', 'schedule_group'].includes(eventKind(event)));
  }
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
    // A project's schedule group (e.g. "Roof Replacement") is production
    // work, so it follows the Production chip rather than Other.
    if (clean(event.project_id) && (window.PlatformScheduling?.eventIsGroup?.(event) || ['group', 'schedule_group'].includes(eventKind(event)))) return 'production';
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
    // A section/group bar only spans its items: it has no assignee picker.
    const group = window.PlatformScheduling?.eventIsGroup?.(event) === true;
    const assigneeNames = group ? [] : workAssigneeNames(event);
    return {
      ...event,
      requirement_warnings:requirementWarningsForEvent(event),
      project_title: projectTitle(eventProject(event), event),
      project_address: event.project_address || projectAddress(eventProject(event), event),
      ...assignmentPayloadForEvent(event),
      // Every crew/person, in the same form the assignee picker stores
      // ("Alpha Crew, Bravo Crew"), so a save of this copy never trims the
      // label to the first crew. The pill shows the compact "Alpha Crew +1".
      assignee_label: group ? '' : (assigneeNames.length > 1 ? assigneeNames.join(', ') : (workCrewName(event) || assignedLabel(event) || 'Unassigned')),
      __assignee_names: assigneeNames,
      __assignee_short_label: assigneeNames.length > 1 ? `${assigneeNames[0]} +${assigneeNames.length - 1}` : ''
    };
  }
  /* Names of every crew and person on a work item, crews first. */
  function workAssigneeNames(event = {}){
    const crewNames = eventCrewRefs(event).map((ref) => {
      const known = workforceResources.find((resource) => clean(resource.id) === ref.id);
      return clean(ref.name && ref.name !== ref.id ? ref.name : (known?.name || ref.name));
    });
    const people = (Array.isArray(event.assigned_users) ? event.assigned_users : [])
      .map((user) => clean(user?.name || user?.email || userDisplayName(user?.id)));
    return [...new Set([...crewNames, ...people].filter(Boolean))];
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
  /* Routing lanes under a person filter: that person's lane plus any lane
   * (e.g. their crew) that holds one of the filtered items. */
  function routingLanesForFilter(resources = [], items = [], resourceIdFn = currentAssignmentId){
    if (breakdownValue === 'all' || breakdownMode !== 'user') return resources;
    const used = new Set(items.map((item) => norm(resourceIdFn(item))).filter(Boolean));
    const kept = new Set(resources.filter((resource) => norm(resource.id) === norm(breakdownValue) || used.has(norm(resource.id))).map((resource) => norm(resource.id)));
    return resources.filter((resource) => kept.has(norm(resource.id))
      || clean(resource.resource_kind) === 'materials'
      || (clean(resource.resource_kind) === 'vehicle_lane' && kept.has(norm(resource.vehicle_crew_id))));
  }
  function salesRoutingEvents(){
    const byId = new Map();
    [...allEvents, ...floatingEvents].forEach((event, index) => {
      // Routing honours the header's person/lead-source/city filter too.
      if (!isSalesEvent(event) || !eventIsScheduled(event) || !eventMatchesBreakdown(event)) return;
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
    // A timed delivery shows its window ("7:00 AM – 9:00 AM") under the title.
    const windowStart = event.all_day === false || clean(event.schedule_granularity).toLowerCase() === 'time' ? eventStart(event) : null;
    const windowEnd = windowStart ? eventEnd(event) : null;
    const deliveryWindow = windowStart && windowEnd && sameDay(windowStart, windowEnd) ? `${fmtTime(windowStart)} – ${fmtTime(windowEnd)}` : '';
    return {
      ...event,
      ...(deliveryWindow && !clean(event.secondary_label) ? { secondary_label:deliveryWindow } : {}),
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
    if (!canEditSchedule()) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), scheduleReadOnlyMessage(), VIEW_ONLY_TOAST);
      return;
    }
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
    return ids.length ? ids.map(userDisplayName).join(', ') : 'Unassigned';
  }
  function openProjectFromEvent(event){
    const project = eventProject(event);
    if (!project?.id) return;
    // Land on the event itself: the project's Schedule tab, on the week that
    // contains it. A project's summary bar (Timeline) opens the project's own
    // Timeline at its next upcoming work instead of an arbitrary week.
    const pad = (value) => String(value).padStart(2, '0');
    const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    if (event?.__project_rollup === true) {
      const today = startOfDay(new Date());
      const upcoming = projectScheduleItems(project.id).filter(eventIsScheduled)
        .map((item) => ({ start:eventStart(item), end:eventEnd(item) }))
        .filter((item) => item.start && (item.end || item.start) >= today)
        .sort((a, b) => a.start - b.start)[0];
      const target = upcoming ? (upcoming.start < today ? today : upcoming.start) : (eventStart(event) || today);
      const rollupOptions = { tab:'schedule', projectScheduleView:'gantt', projectScheduleDate:dateKey(target) };
      if (window.Portal.modules?.request?.openProject) window.Portal.modules.request.openProject(project, rollupOptions);
      else window.dispatchEvent(new CustomEvent('fm:projects:open', { detail: { project, ...rollupOptions } }));
      return;
    }
    const start = eventStart(event);
    const options = start
      ? { tab:'schedule', projectScheduleView:'week', projectScheduleDate:dateKey(start) }
      : { tab:'schedule' };
    if (window.Portal.modules?.request?.openProject) window.Portal.modules.request.openProject(project, options);
    else window.dispatchEvent(new CustomEvent('fm:projects:open', { detail: { project, ...options } }));
  }
  function visibleTitle(){
    // Compact formats keep the title on one line so the toolbar height (and
    // the calendar under it) never jumps between views.
    if (viewMode === 'appointment_schedule') return `${window.Portal?.terminology?.get?.('scheduling.routing_view', 'Routing') || 'Routing'} · ${anchorDate.toLocaleDateString([], anchorDate.getFullYear() === new Date().getFullYear() ? { weekday:'short', month:'short', day:'numeric' } : { weekday:'short', month:'short', day:'numeric', year:'numeric' })}`;
    if (viewMode === 'gantt') return ganttRangeTitle() || window.Portal?.terminology?.get?.('scheduling.gantt_view', 'Timeline') || 'Timeline';
    if (viewMode === 'day') return anchorDate.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric', year:'numeric' });
    if (viewMode === 'month') return anchorDate.toLocaleDateString([], { month:'long', year:'numeric' });
    const start = viewMode === '4day' ? startOfDay(anchorDate) : weekStart(anchorDate);
    const end = addDays(start, viewMode === '4day' ? 3 : 6);
    return `${start.toLocaleDateString([], { month:'short', day:'numeric' })} - ${end.toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' })}`;
  }
  function ganttRangeTitle(range = ganttVisibleRange){
    const start = validDate(range?.start);
    const end = validDate(range?.end);
    if (!start || !end) return '';
    const sameYear = start.getFullYear() === end.getFullYear();
    if (sameYear && start.getMonth() === end.getMonth()) return start.toLocaleDateString([], { month:'long', year:'numeric' });
    return `${start.toLocaleDateString([], sameYear ? { month:'short' } : { month:'short', year:'numeric' })} – ${end.toLocaleDateString([], { month:'short', year:'numeric' })}`;
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
  function ganttControls(){
    return window.PlatformScheduleView?.ganttControls?.(rootEl?.querySelector('#dashGanttView')) || null;
  }
  /* Timeline paging scrolls smoothly; once it settles, date= follows the
   * middle of what is on screen so reloads and shared links land there. */
  function syncGanttRouteDate(options = {}){
    // Back/Forward just scrolled the Timeline to the entry's date: that
    // scroll must not rewrite the entry it came from.
    if (options.history !== 'push' && !syncGanttRouteDate._push && Date.now() < ganttRouteSyncHoldUntil) return;
    clearTimeout(syncGanttRouteDate._timer);
    syncGanttRouteDate._timer = setTimeout(() => {
      if (viewMode !== 'gantt') return;
      const range = ganttControls()?.visibleRange?.() || ganttVisibleRange;
      const start = validDate(range?.start);
      const end = validDate(range?.end);
      if (!start || !end) return;
      // The left edge of the visible range; a reload scrolls it back there.
      // A manual scroll only records it in the link (the date other views
      // open on stays the one picked with the header).
      const leftEdge = startOfDay(start) || anchorDate;
      // A header page keeps moving the anchor (and its "push") even when the
      // smooth scroll's viewport callbacks re-arm the timer.
      if (syncGanttRouteDate._moveAnchor === true) anchorDate = leftEdge;
      syncGanttRouteDate._moveAnchor = false;
      // Prev/Next/Today are their own history entries (like the other
      // views); plain scrolling only updates the current one.
      const push = syncGanttRouteDate._push === true;
      syncGanttRouteDate._push = false;
      syncScheduleRoute({ date:routeDate(leftEdge) }, { history:push ? 'push' : 'replace', source:'scheduling-date', ownedKeys:['date'] });
    }, 450);
    if (options.history === 'push') syncGanttRouteDate._push = true;
    if (options.moveAnchor !== false) syncGanttRouteDate._moveAnchor = true;
  }
  let ganttRouteSyncHoldUntil = 0;
  /* Rapid Prev/Next clicks add up: each page moves on from where the
   * previous (still animating) page is heading, not from the current
   * scroll position. */
  let ganttPageTarget = null;
  function pageGantt(delta){
    const controls = ganttControls();
    if (!controls) return;
    const range = controls.visibleRange?.();
    const start = validDate(range?.start);
    const end = validDate(range?.end);
    if (!start || !end || typeof controls.scrollToTime !== 'function') {
      controls.page?.(delta);
      return;
    }
    const span = (end.getTime() - start.getTime()) * 0.8;
    const base = ganttPageTarget && Date.now() - ganttPageTarget.at < 900 ? ganttPageTarget.time : start.getTime();
    const target = base + (delta < 0 ? -1 : 1) * span;
    ganttPageTarget = { time:target, at:Date.now() };
    // The page's date is known now; Back/Forward compare against it even
    // before the smooth scroll settles.
    anchorDate = startOfDay(new Date(target)) || anchorDate;
    controls.scrollToTime(target, 0, 'smooth');
  }
  function nav(delta){
    if (viewMode === 'gantt') {
      pageGantt(delta);
      syncGanttRouteDate({ history:'push' });
      return;
    }
    if (viewMode === 'month') anchorDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + delta, 1);
    else anchorDate = addDays(anchorDate, viewMode === 'week' ? delta * 7 : (viewMode === '4day' ? delta * 4 : delta));
    if (viewMode === 'appointment_schedule') resetScheduleScrollPersistence();
    // Paging keeps a rail selection (and its staged draft) like production
    // placement does; the banner keeps saying where the draft sits.
    appointmentScheduleMenuEventId = '';
    // Each page is its own history entry: Back returns to the previous
    // range instead of leaving Scheduling.
    syncScheduleRoute({ date:routeDate() }, { history:'push', source:'scheduling-date', ownedKeys:['date'] });
    render();
  }
  function goToToday(){
    anchorDate = startOfDay(new Date()) || new Date();
    if (viewMode === 'gantt' && ganttControls()) {
      ganttPageTarget = null;
      ganttControls().today();
      syncScheduleRoute({ date:routeDate() }, { history:'push', source:'scheduling-today', ownedKeys:['date'] });
      return;
    }
    resetScheduleScrollPersistence();
    appointmentScheduleMenuEventId = '';
    // Today always brings today's week back into view, also in the month
    // already shown.
    scrollMonthToToday._key = '';
    syncScheduleRoute({ date:routeDate() }, { history:'push', source:'scheduling-today', ownedKeys:['date'] });
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
    const customerName = clean((branchProjectConfig?.title_mode === 'all_contacts' ? window.Portal?.modules?.request?.formatProjectContactNames?.(project.contacts) : '') || contact.name || event.customer_name);
    const mode = branchProjectConfig?.title_mode || 'all_contacts';
    if (mode === 'manual') return savedTitle || customerName || address || 'Project';
    if (mode === 'address') return address || customerName || savedTitle || 'Project';
    return customerName || address || savedTitle || 'Project';
  }
  /* Title for new work created from a project with no schedule items yet
   * ("sold, unscheduled"): the job's own title, never the customer's name
   * (the chip's second line already shows the customer). */
  function projectWorkTitle(project = {}){
    const manifest = project?.manifest && typeof project.manifest === 'object' && !Array.isArray(project.manifest) ? project.manifest : {};
    const address = clean(project?.address || project?.project_address || manifest.address);
    const customer = clean(primaryProjectContact(project || {})?.name);
    const saved = [project?.project_title, project?.project_name, project?.projectName, project?.title, project?.name, manifest.project_title, manifest.project_name, manifest.title]
      .map(clean)
      .find((value) => value && norm(value) !== norm(address) && norm(value) !== norm(customer));
    return saved || (globalThis.PlatformLanguage?.text("scheduling","m_222066ef57ae0e","Work") ?? "Work");
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
      // Schedule groups take their dates from their items; they are never
      // placed themselves, so they must not queue as waiting work.
      .filter((event) => !window.PlatformScheduling?.eventIsGroup?.(event))
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
      groups.set(key, group);
    });
    const Scheduling = window.PlatformScheduling;
    return [...groups.values()].map((group) => {
      // Items list in dependency order, and the bundle is placed from its
      // first work item that nothing else in the bundle waits on.
      const dependencyOrdered = Scheduling?.orderByDependencies ? Scheduling.orderByDependencies(group.events) : group.events;
      const ids = new Set(dependencyOrdered.map((event) => String(event.id || '')));
      // A waiting item is a chain start only when nothing waiting comes before
      // it, also through already-scheduled work in between (tear-off →
      // [scheduled install] → gutters: gutters is not a start).
      const byId = new Map(allEvents.map((event) => [String(event.id || ''), event]));
      const depsOf = (event) => (Scheduling?.eventDependencies ? Scheduling.eventDependencies(event) : []);
      const hasWaitingAncestor = (event, seen = new Set()) => depsOf(event).some((dep) => {
        const id = String(dep.event_id || '');
        if (!id || seen.has(id)) return false;
        seen.add(id);
        if (ids.has(id)) return true;
        const predecessor = byId.get(id);
        return predecessor ? hasWaitingAncestor(predecessor, seen) : false;
      });
      const isRoot = (event) => !hasWaitingAncestor(event);
      const ordered = [...dependencyOrdered.filter(isRoot), ...dependencyOrdered.filter((event) => !isRoot(event))];
      const isPrimaryRole = (event) => scheduleBundleDescriptor(event).role === 'primary';
      const primary = ordered.find((event) => isPrimaryRole(event) && isRoot(event))
        || ordered.find(isPrimaryRole)
        || ordered.find(isProductionEvent)
        || ordered[0];
      return {
        ...group,
        events:ordered,
        primary,
        dependents:ordered.filter((event) => String(event.id || '') !== String(primary?.id || ''))
      };
    }).sort((a, b) => projectTitle(a.project, a.primary).localeCompare(projectTitle(b.project, b.primary)));
  }
  function selectedProductionBundle(){
    if (!productionScheduleBundleKey) return null;
    return scheduleBundleGroups(unscheduledEvents((event) => isProductionEvent(event) || isMaterialEvent(event)))
      .find((group) => group.key === productionScheduleBundleKey) || null;
  }
  /* Bundle drafts that follow already-scheduled work (or an earlier draft)
   * start no earlier than their links allow, using the shared dependency
   * layout (whole days on the next free day, timed work keeps its time of
   * day). The primary keeps the day the user picked. */
  function layoutAfterScheduledPredecessors(drafts = [], sources = [], scheduled = [], primaryId = ''){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling?.dependencyEarliestStart || !Scheduling?.scheduleItemSpan || !Scheduling?.eventDependencies) return drafts;
    const ranges = new Map(scheduled.map((item) => [String(item.id || ''), { start:eventStart(item), end:eventEnd(item) }]));
    const sourceById = new Map(sources.map((item) => [String(item.id || ''), item]));
    return drafts.map((draft) => {
      const id = String(draft.id || draft.event_id || '');
      const source = sourceById.get(id) || draft;
      let start = validDate(draft.start);
      let end = validDate(draft.end);
      if (start && id !== primaryId) {
        const span = Scheduling.scheduleItemSpan(source, { start, end:end || start });
        let earliest = null;
        Scheduling.eventDependencies(source).forEach((dep) => {
          const predecessor = ranges.get(String(dep.event_id || ''));
          if (!predecessor?.start) return;
          const allowed = validDate(Scheduling.dependencyEarliestStart(dep, predecessor, span, { config:schedulingConfig }));
          if (allowed && (!earliest || allowed > earliest)) earliest = allowed;
        });
        if (earliest && earliest > start) {
          start = earliest;
          end = span.allDay ? addDays(startOfDay(start), Math.max(1, span.days)) : new Date(start.getTime() + span.minutes * 60000);
          draft = { ...draft, start, end, start_at:start.toISOString(), end_at:end.toISOString() };
        }
      }
      if (start) ranges.set(id, { start, end:end || start });
      return draft;
    });
  }
  function scheduleBundleDrafts(primaryDraft = productionScheduleDraft){
    const bundle = selectedProductionBundle();
    const primary = bundle?.primary || selectedProductionEvent();
    const project = bundle?.project || selectedProductionProject() || eventProject(primary || {});
    if (!primary || !primaryDraft?.start || !window.PlatformScheduling?.interpretScheduleBundle) return primaryDraft?.start ? [primaryDraft] : [];
    // Already-scheduled project items constrain bundle items that depend on them.
    const projectId = String(project?.id || primary.project_id || '');
    const scheduledProjectEvents = allEvents.filter((item) => String(item.project_id || '') === projectId && eventIsScheduled(item));
    // The primary keeps its own staged span (End / duration set in its editor,
    // a bottom-edge resize, all-day on or off); dependents are laid out after
    // that span instead of the template length.
    const primaryId = String(primary.id || '');
    const ownStart = validDate(primaryDraft.start);
    const ownEnd = validDate(primaryDraft.end);
    const ownRange = !!ownStart && !!ownEnd && ownEnd > ownStart;
    const interpreted = window.PlatformScheduling.interpretScheduleBundle(primary, bundle?.events || [primary], primaryDraft.start, project, scopeTemplates, { config:schedulingConfig, events:scheduledProjectEvents, ...(ownRange ? { primaryEnd:ownEnd } : {}) })
      .map((draft) => (!ownRange || String(draft.id || draft.event_id || '') !== primaryId) ? draft : {
        ...draft,
        start:ownStart,
        end:ownEnd,
        all_day:primaryDraft.all_day !== false,
        schedule_granularity:primaryDraft.schedule_granularity || (primaryDraft.all_day === false ? 'time' : 'date')
      });
    return layoutAfterScheduledPredecessors(interpreted, bundle?.events || [primary], scheduledProjectEvents, primaryId)
      .map((draft) => ({
        ...draft,
        project_title:projectTitle(project, draft),
        project_address:projectAddress(project, draft),
        assignee_label:isMaterialEvent(draft) ? '' : (workCrewName(primaryDraft) || workCrewName(draft) || 'Unassigned'),
        ...(!isMaterialEvent(draft) ? workResourcePayload(primaryDraft) : {}),
        // The primary shows the title/notes typed in its draft editor.
        ...(String(draft.id || draft.event_id || '') === primaryId ? stagedDraftText(primaryDraft) : {})
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
  /* Rail group heads collapse their group (state kept per session in
   * collapsedGroups under a "rail:" key). The expanded state lives on the head
   * so CSS can hide the body and release the group's rail height. */
  // Rail group collapse is remembered per viewer and organization.
  function railCollapseStorageKey(){ return `fm.scheduling.rail.collapsed:${orgId() || 'org'}`; }
  function restoreRailCollapsed(){
    if (restoreRailCollapsed.done) return;
    restoreRailCollapsed.done = true;
    try {
      const saved = JSON.parse(window.localStorage?.getItem(railCollapseStorageKey()) || '{}');
      if (saved && typeof saved === 'object') Object.entries(saved).forEach(([key, value]) => { if (key.startsWith('rail:') && !(key in collapsedGroups)) collapsedGroups[key] = value === true; });
    } catch (error) {}
  }
  function persistRailCollapsed(){
    try {
      const rail = Object.fromEntries(Object.entries(collapsedGroups).filter(([key, value]) => key.startsWith('rail:') && value === true));
      window.localStorage?.setItem(railCollapseStorageKey(), JSON.stringify(rail));
    } catch (error) {}
  }
  function railGroupHeadHtml(id, label, count){
    restoreRailCollapsed();
    const key = `rail:${id}`;
    const collapsed = collapsedGroups[key] === true;
    return `<button type="button" class="dash-group-head" data-toggle-group="${escapeHtml(key)}" aria-expanded="${collapsed ? 'false' : 'true'}"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(count)}<i class="fas fa-chevron-${collapsed ? 'down' : 'up'}" aria-hidden="true"></i></span></button>`;
  }
  function salesRailWhenHtml(item, selected){
    const draftStart = selected && appointmentScheduleDraft?.start ? validDate(appointmentScheduleDraft.start) : null;
    if (draftStart) return `<span class="dash-appt-draft-time">${escapeHtml(`Draft · ${fmtDayTime(draftStart)}`)}</span>`;
    return item.scheduled ? escapeHtml(fmtDayTime(eventStart(item.event))) : 'Choose a date and time';
  }
  // Keeps the selected sales tile's time in step with a draft that is dragged
  // on the calendar without re-rendering the whole tab.
  function refreshRailDraftLabel(){
    const item = scheduleAppointmentItems().find((entry) => String(entry.event?.id || '') === String(appointmentScheduleEventId || ''));
    if (!item || !rootEl) return;
    rootEl.querySelectorAll('[data-schedule-event-id]').forEach((tile) => {
      if (String(tile.dataset.scheduleEventId || '') !== String(item.event.id || '')) return;
      const label = tile.querySelector('.dash-appt-sales');
      if (label) label.innerHTML = salesRailWhenHtml(item, true);
      const pill = tile.querySelector('.dash-stage-pill');
      if (pill) pill.textContent = salesRailPillText(item, true);
    });
  }
  // The selected tile's pill follows the draft: the salesperson picked for
  // it (not "Unassigned" once someone is chosen).
  function salesRailPillText(item, selected){
    if (selected && appointmentScheduleDraft) {
      const assignment = salesDraftAssignment(appointmentScheduleDraft, item.event);
      if (currentAssignmentId(assignment)) return salesAssignmentLabel(assignment);
    }
    return item.scheduled ? 'Unassigned' : 'Unscheduled';
  }
  /* An empty rail group while a person/filter is active says so: waiting
   * items may be hidden by the filter, not absent. */
  function railEmptyHtml(emptyHtml = ''){
    if (breakdownValue === 'all') return emptyHtml;
    return (globalThis.PlatformLanguage?.htmlText("scheduling","m_rail_empty_filtered","Nothing waiting matches the active filter. Clear the filter to see everything.") ?? "Nothing waiting matches the active filter. Clear the filter to see everything.");
  }
  function renderScheduleGroups(){
    const items = scheduleAppointmentItems();
    const tile = (item) => {
      const project = item.project || {};
      const selected = String(item.event.id || '') === String(appointmentScheduleEventId || '');
      const missingAddress = !projectAddressValue(project, item.event);
      return `<button type="button" class="dash-appt-tile unscheduled ${missingAddress ? 'missing-address' : ''} ${selected ? 'selected' : ''}" data-schedule-event-id="${escapeHtml(item.event.id || '')}" data-schedule-project-id="${escapeHtml(project.id || '')}" aria-pressed="${selected ? 'true' : 'false'}">
        <div class="dash-appt-title">${escapeHtml(projectTitle(project, item.event))}</div>
        <div class="dash-appt-sales">${salesRailWhenHtml(item, selected)}</div>
        <div class="dash-appt-address">${missingAddress ? missingAddressLabel() : escapeHtml(projectAddress(project, item.event))}</div>
        <div class="dash-stage-pill">${escapeHtml(salesRailPillText(item, selected))}</div>
      </button>`;
    };
    const group = (label, rows) => `<div class="dash-group ${rows.length ? '' : 'empty'}">
      ${railGroupHeadHtml('sales', label, rows.length)}
      <div class="dash-group-body">${rows.length ? rows.map(tile).join('') : `<div class="dash-empty" style="padding:16px;">${railEmptyHtml((globalThis.PlatformLanguage?.htmlText("scheduling","m_9edea1c187a128","No unscheduled sales appointments.") ?? "No unscheduled sales appointments."))}</div>`}</div>
    </div>`;
    return group('Sales', items);
  }
  function bundleChildIsSelected(event = {}){
    const id = String(event.id || '');
    if (!id) return false;
    return isMaterialEvent(event)
      ? id === String(materialScheduleEventId || '')
      : !productionScheduleBundleKey && id === String(productionScheduleEventId || '');
  }
  function renderProductionScheduleGroups(){
    const canonical = unscheduledEvents(isProductionEvent);
    const materials = unscheduledEvents(isMaterialEvent);
    const inferred = unscheduledProductionProjects();
    const eventGroups = scheduleBundleGroups([...canonical, ...materials]);
    const cancelLabel = (globalThis.PlatformLanguage?.htmlText("scheduling","m_3714e2e80f69ac","Cancel placement") ?? "Cancel placement");
    const orderedPill = (event, className = 'dash-bundle-item-pill') => {
      const ordered = materialEventIsOrdered(event);
      return `<span class="${className} ${ordered ? 'ordered' : ''}">${ordered ? 'Ordered' : 'Not ordered'}</span>`;
    };
    // Children keep their real kind: work items place as production work and
    // deliveries as deliveries (a work child must never be saved as a delivery).
    const childRow = (event, project) => {
      const material = isMaterialEvent(event);
      const selected = bundleChildIsSelected(event);
      const label = material
        ? (String(escapeHtml(materialDeliveryTitle(event))) + "<span class=\"dash-appt-kind\">" + (globalThis.PlatformLanguage?.htmlText("scheduling","m_658f2deb4256b0"," &mdash; delivery") ?? " &mdash; delivery") + "</span>")
        : escapeHtml(event.title || (globalThis.PlatformLanguage?.text("scheduling","m_d0a9ffb325f8e6","Schedule item") ?? "Schedule item"));
      return `<div class="dash-bundle-item-row"><button type="button" class="dash-bundle-item ${selected ? 'selected' : ''}" data-production-bundle-child="${escapeHtml(event.id || '')}" data-bundle-child-project-id="${escapeHtml(project.id || event.project_id || '')}" data-bundle-child-kind="${material ? 'materials' : 'production'}" aria-pressed="${selected ? 'true' : 'false'}" title="${escapeHtml(material ? `${materialDeliveryTitle(event)} — delivery` : clean(event.title) || 'Schedule item')}" aria-label="${escapeHtml(material ? `${materialDeliveryTitle(event)} — delivery, ${materialEventIsOrdered(event) ? 'ordered' : 'not ordered'}` : clean(event.title) || 'Schedule item')}"><i class="fas ${material ? 'fa-truck-ramp-box' : 'fa-calendar-day'}" aria-hidden="true"></i><span>${label}</span>${material ? orderedPill(event) : ''}</button>${selected ? `<button type="button" class="dash-bundle-child-cancel" data-bundle-child-cancel aria-label="${cancelLabel}" title="${cancelLabel}"><i class="fas fa-xmark" aria-hidden="true"></i></button>` : ''}</div>`;
    };
    const eventPile = (group) => {
      const primary = group.primary;
      const project = group.project || eventProject(primary);
      const primaryIsMaterial = isMaterialEvent(primary);
      const selected = group.key === productionScheduleBundleKey
        || (!primaryIsMaterial && String(primary.id || '') === String(productionScheduleEventId || ''))
        || (primaryIsMaterial && String(primary.id || '') === String(materialScheduleEventId || ''));
      const missingAddress = !projectAddressValue(project, primary);
      const childSelected = group.dependents.some(bundleChildIsSelected);
      const expanded = expandedProductionBundles.has(group.key) || childSelected;
      const deliveryCount = group.dependents.filter(isMaterialEvent).length;
      const dependentLabel = deliveryCount === group.dependents.length
        ? `${deliveryCount} ${deliveryCount === 1 ? 'delivery' : 'deliveries'}`
        : `${group.dependents.length} related item${group.dependents.length === 1 ? '' : 's'}`;
      const status = selected
        ? '<span class="dash-bundle-cancel-slot" aria-hidden="true"></span>'
        : (primaryIsMaterial ? orderedPill(primary, 'dash-stage-pill') : `<div class="dash-stage-pill">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_c84286da8f58e9","Waiting") ?? "Waiting")}</div>`);
      return `<div class="dash-schedule-pile ${selected ? 'selected' : ''}" data-production-bundle="${escapeHtml(group.key)}">
        <button type="button" class="dash-appt-tile project-only unscheduled ${missingAddress ? 'missing-address' : ''} ${selected ? 'selected' : ''}" data-production-bundle-primary="${escapeHtml(group.key)}" data-production-project-id="${escapeHtml(project.id || primary.project_id || '')}" data-production-event-id="${escapeHtml(primary.id || '')}" aria-pressed="${selected ? 'true' : 'false'}">
          <div class="dash-appt-title">${primaryIsMaterial ? `<i class="fas fa-truck-ramp-box" aria-hidden="true" style="margin-right:6px"></i>${materialDeliveryQueueTitle(primary)}` : escapeHtml(primary.title || projectTitle(project, primary))}</div>
          ${status}
          <div class="dash-appt-address">${escapeHtml(projectTitle(project, primary))}${missingAddress ? ` ${missingAddressLabel()}` : ''}</div>
        </button>
        ${selected ? `<button type="button" class="dash-bundle-cancel" data-production-bundle-cancel="${escapeHtml(group.key)}" aria-label="${cancelLabel}" title="${cancelLabel}"><i class="fas fa-xmark" aria-hidden="true"></i></button>` : ''}
        ${group.dependents.length ? `<button type="button" class="dash-bundle-summary" data-production-bundle-toggle="${escapeHtml(group.key)}" aria-expanded="${expanded ? 'true' : 'false'}"><i class="fas fa-chevron-${expanded ? 'up' : 'down'}"></i><span>${expanded ? 'Hide' : 'Show'} ${escapeHtml(dependentLabel)}</span></button>` : ''}
        ${group.dependents.length && expanded ? `<div class="dash-bundle-items">${group.dependents.map((event) => childRow(event, project)).join('')}</div>` : ''}
      </div>`;
    };
    const unscheduledTile = (project) => {
      const selected = String(project.id || '') === String(productionScheduleProjectId || '') && !productionScheduleEventId;
      const missingAddress = !projectAddressValue(project, {});
      return `<button type="button" class="dash-appt-tile project-only unscheduled ${String(missingAddress ? 'missing-address' : '')} ${String(selected ? 'selected' : '')}" data-production-project-id="${String(escapeHtml(project.id || ''))}" aria-pressed="${selected ? 'true' : 'false'}">
        <div class="dash-appt-title">${String(escapeHtml(projectTitle(project)))}</div>
        <div class="dash-stage-pill">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2b7432531aba4c","Unscheduled") ?? "Unscheduled")}</div>
        <div class="dash-appt-address">${String(missingAddress ? missingAddressLabel() : escapeHtml(projectAddress(project, {})))}</div>
      </button>`;
    };
    // Decision (RAIL-27): the rail lists work that has no date yet. A
    // production item leaves it once it is dated even without a crew — it then
    // shows in Routing's "Unassigned" lane and flags "Unassigned" on its chip.
    // A sales appointment only counts as scheduled once it has both a time and
    // a salesperson, so dated-but-unassigned appointments stay in the rail.
    const rows = [...eventGroups.map((group) => ({ kind:'bundle', value:group })), ...inferred.map((project) => ({ kind:'project', value:project }))];
    const group = (label, items) => `<div class="dash-group ${items.length ? '' : 'empty'}">
      ${railGroupHeadHtml('production', label, items.length)}
      <div class="dash-group-body">${items.length ? items.map((item) => item.kind === 'bundle' ? eventPile(item.value) : unscheduledTile(item.value)).join('') : `<div class="dash-empty" style="padding:16px;">${railEmptyHtml((globalThis.PlatformLanguage?.htmlText("scheduling","m_75626addb77eff","No unscheduled production projects.") ?? "No unscheduled production projects."))}</div>`}</div>
    </div>`;
    return group('Production', rows);
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
    // The placement's own draft editor (no stored/floating id behind it) has
    // nothing to edit once the placement is committed or cancelled.
    if (placementWaitingItem() && !eventEditorEventId && !eventDraftPopoverId && document.querySelector('.dash-event-popover')) {
      discardEventEditorDraft?.();
      closeEventDraftPopover();
    }
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
  /* A placed-but-unsaved rail item keeps its real event id on the calendar,
   * so the renderers can't tell it from the stored (unscheduled) item by id.
   * Drafts handed to a renderer are flagged __draft so clicks, drags and ✓
   * route to the draft callbacks (onDraftSelect / onDraftChange), never to
   * the stored item's editor or an immediate save. */
  function renderedPlacementDraft(draft){
    if (!draft || draft.floating_event === true || String(draft.id || '').startsWith('floating_')) return draft || null;
    return { ...draft, __draft:true };
  }
  function placementDraftIds(){
    const ids = new Set();
    const add = (value) => { const id = clean(value); if (id) ids.add(id); };
    if (productionScheduleDraft?.start) { add(productionScheduleDraft.id); add(productionScheduleDraft.event_id); }
    productionScheduleBundleDrafts.forEach((draft) => { if (draft?.start) { add(draft.id); add(draft.event_id); } });
    if (materialScheduleDraft?.start) { add(materialScheduleDraft.id); add(materialScheduleDraft.event_id); }
    if (appointmentScheduleDraft?.start) add(appointmentScheduleEventId);
    if (vehiclePlacementDraft?.start) add(vehiclePlacementDraft.id || '__vehicle_draft');
    return ids;
  }
  /* A waiting item moved straight on the calendar (e.g. an unassigned
   * appointment dropped into a rep's Routing row) is saved by that move. When
   * that leaves it scheduled and assigned, placing it is finished: clear the
   * selection so the rail tile, banner and chip update at once (the rail and
   * banner live outside the calendar surface, so the tab re-renders). */
  function settlePlacementSelectionAfterSave(saved = {}){
    const id = String(saved?.id || '');
    if (!id || id !== String(appointmentScheduleEventId || '')) return false;
    if (eventIsScheduled(saved) && currentAssignmentId(saved)) clearPlacementSelection();
    render();
    return true;
  }
  function isPlacementDraftEvent(event = null){
    if (!event?.id || event.floating_event === true || String(event.id || '').startsWith('floating_')) return false;
    return event.__draft === true || placementDraftIds().has(clean(event.id));
  }
  /* Opens the editor for the placement draft (its staged time, crew, notes);
   * Save there commits the placement exactly like the draft's ✓. */
  /* A placement draft's editor edits of dates, times, crew or assignee show
   * on the staged draft at once: its chip (and the bundle that follows it),
   * the rail label and the banner update without waiting for Save. */
  function placementDraftEdited(ctx = null, patch = {}){
    if (!ctx || ctx.editorOnly === true || ctx.kind === 'floating' || !placementWaitingItem()) return;
    const keys = Object.keys(patch || {});
    const visible = ['start', 'end', 'start_at', 'end_at', 'all_day', 'schedule_granularity', 'resource_refs', 'work_resource_ref', 'assigned_crew_id', 'assigned_resource_id', 'assigned_user_id', 'assigned_user_ids', 'crew_id', 'resource_id', 'title', 'description'];
    if (!keys.some((key) => visible.includes(key))) return;
    // Routing keeps its chip copies here for single items too, so the copy
    // follows the editor whenever there is one.
    if (ctx.kind === 'production' && (productionScheduleBundleKey || productionScheduleBundleDrafts.length) && productionScheduleDraft?.start) productionScheduleBundleDrafts = scheduleBundleDrafts(productionScheduleDraft);
    // Typing (title / notes) redraws the draft once the user pauses.
    const typing = keys.every((key) => ['title', 'description'].includes(key));
    clearTimeout(placementDraftEdited.timer);
    placementDraftEdited.timer = setTimeout(() => {
      if (!placementWaitingItem()) return;
      refreshActiveScheduleSurface();
      refreshRailDraftLabel();
      refreshPlacementBanner();
      if (keys.some((key) => ['start', 'start_at'].includes(key))) revealPlacementDraft();
    }, typing ? 250 : 0);
  }
  /* A draft moved (in its editor) to a day outside the shown range: go to
   * that day so the draft and its ✓ are on screen, as the banner says. */
  function revealPlacementDraft(){
    const item = placementWaitingItem();
    const start = validDate(item?.start);
    if (!start || item.kind === 'vehicle') return;
    const id = clean(item.kind === 'materials' ? (materialScheduleDraft?.id || materialScheduleEventId) : item.kind === 'sales' ? appointmentScheduleEventId : (productionScheduleDraft?.id || productionScheduleEventId));
    if (!id || editorAnchorFor(id)) return;
    anchorDate = startOfDay(start) || anchorDate;
    syncScheduleRoute({ date:routeDate() }, { history:'replace', source:'scheduling-date', ownedKeys:['date'] });
    render();
    // The open editor moves beside the draft on its new day.
    refreshPlacementEditor();
  }
  /* The placement editor always shows the staged draft: when the draft moves
   * (click, drag, lane drop) an open placement editor is rebuilt from it, so
   * Save commits exactly what the editor shows. */
  function refreshPlacementEditor(){
    if (!document.querySelector('.dash-event-popover') || eventEditorEventId || eventDraftPopoverId || !placementWaitingItem()) return;
    const ctx = eventEditorContext();
    if (!ctx || ctx.editorOnly === true || ctx.kind === 'floating') return;
    const id = String(ctx.event?.id || '');
    setTimeout(() => {
      const pop = document.querySelector('.dash-event-popover');
      if (!pop || eventEditorEventId || eventDraftPopoverId || !placementWaitingItem()) return;
      renderEventDraftPopover(editorAnchorFor(id) || null);
    }, 0);
  }
  function openPlacementDraftEditor(draft = {}, anchor = null){
    if (!placementWaitingItem()) return false;
    // Mid-save the draft is not editable: the banner keeps "Saving…".
    if (placementSaveInFlight) { placementSaveBusy('save'); return true; }
    closeAssignmentMenu();
    discardEventEditorDraft();
    eventDraftPopoverId = '';
    eventEditorEventId = '';
    eventDraftProjectQuery = '';
    eventCustomerDetailsOpen = false;
    eventAdvancedOpen = false;
    renderEventDraftPopover(anchor || editorAnchorFor(draft?.id));
    return true;
  }
  // The first load has not produced any data yet: rail and Routing show a
  // loading state instead of "0 / nothing waiting".
  function scheduleInitialLoading(){
    return !dataLoaded;
  }
  /* The waiting item currently being placed (rail selection or vehicle), or
   * null. An already-placed event that is merely open in the editor is not a
   * placement. */
  function placementWaitingItem(){
    // Vehicle lanes only exist in Routing; elsewhere a vehicle pick waits.
    if (vehiclePlacementUnitId && viewMode !== 'appointment_schedule') return null;
    if (vehiclePlacementUnitId) {
      const unit = equipmentUnits.find((item) => clean(item.id) === vehiclePlacementUnitId);
      return unit ? { kind:'vehicle', label:clean(unit.name || unit.id), start:vehiclePlacementDraft?.start || null } : null;
    }
    const kind = selectedPlacementKind();
    if (kind === 'materials') {
      const event = selectedMaterialEvent();
      return event && !eventIsScheduled(event) ? { kind, label:clean(stagedDraftText(materialScheduleDraft).title) || `${materialDeliveryTitle(event)} delivery`, start:materialScheduleDraft?.start || null, click:true } : null;
    }
    if (kind === 'production') {
      const bundle = selectedProductionBundle();
      if (bundle?.primary) {
        const extra = Math.max(0, (bundle.events || []).length - 1);
        return { kind, label:`${clean(stagedDraftText(productionScheduleDraft).title) || clean(bundle.primary.title) || projectTitle(bundle.project, bundle.primary)}${extra ? ` + ${extra} related item${extra === 1 ? '' : 's'}` : ''}`, start:productionScheduleDraft?.start || null, click:true };
      }
      const event = selectedProductionEvent();
      if (event) return !eventIsScheduled(event) ? { kind, label:clean(stagedDraftText(productionScheduleDraft).title) || clean(event.title) || projectTitle(eventProject(event), event), start:productionScheduleDraft?.start || null, click:true } : null;
      const project = selectedProductionProject();
      return project ? { kind, label:clean(stagedDraftText(productionScheduleDraft).title) || projectTitle(project), start:productionScheduleDraft?.start || null, click:true } : null;
    }
    if (kind === 'sales') {
      const event = selectedScheduleEvent();
      if (!event || (eventIsScheduled(event) && currentAssignmentId(event))) return null;
      return { kind, label:clean(stagedDraftText(appointmentScheduleDraft).title) || projectTitle(eventProject(event), event), start:appointmentScheduleDraft?.start || null, scheduled:eventIsScheduled(event) };
    }
    return null;
  }
  function placementDateIsPast(start){
    const day = startOfDay(start);
    const today = startOfDay(new Date());
    return !!day && !!today && day < today;
  }
  function placementBannerHtml(surface = 'calendar'){
    if (scheduleInitialLoading()) return '';
    const item = placementWaitingItem();
    if (!item) return '';
    const name = `<strong>${escapeHtml(item.label)}</strong>`;
    const start = validDate(item.start);
    let text = '';
    // Phones: touch wording, and no keyboard hint on Cancel.
    const touch = isMobileScheduleLayout();
    const confirmVerb = touch ? 'tap' : 'click';
    if (item.kind === 'vehicle') {
      text = start ? `${name} is booked as a draft. Drag it to adjust, then ${confirmVerb} ✓ to save.` : `${touch ? 'Touch and hold' : 'Click'} a crew's vehicle lane to book ${name}.`;
    } else if (start) {
      text = `${name} is placed as a draft on ${escapeHtml(start.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' }))}. Drag it to adjust, then ${confirmVerb} ✓ on it to save.`;
    } else if (item.kind === 'sales' && item.scheduled && placementHasUnsavedEdits(item)) {
      const who = draftAssigneeNames(appointmentScheduleDraft);
      text = `${name} has unsaved changes${who ? ` (assigned to ${escapeHtml(who)})` : ''}. ${touch ? 'Tap' : 'Click'} ✓ on it to save, or drag it to a new time.`;
    } else if (item.kind === 'sales' && item.scheduled) {
      text = surface === 'routing'
        ? `${name} has no salesperson. Drag it into a salesperson's row to assign it (or to a new time), then ${confirmVerb} ✓ to save.`
        : `${name} has no salesperson. ${touch ? 'Tap' : 'Click'} it on the calendar to assign someone, or drag it to a new time.`;
    } else if (isMobileScheduleLayout()) {
      // Phones place with a touch-and-hold (a tap scrolls or opens items).
      text = surface === 'routing' ? `Touch and hold a cell in a row to place ${name}.` : `Touch and hold a day to place ${name}.`;
    } else if (surface === 'routing') {
      text = `Click a cell in a row to place ${name}.`;
    } else if (item.click) {
      text = `Click a day to place ${name}. Other items can't be moved until you finish or cancel.`;
    } else {
      text = `Click or drag on the calendar to place ${name}.`;
    }
    // A save in flight keeps saying so through any re-render (a click on the
    // draft, a reload), with Cancel disabled.
    if (placementSaveInFlight && placementSavingShown) {
      return `<div class="dash-placement-banner" data-placement-banner data-saving="1" role="status" aria-busy="true"><i class="fas fa-location-crosshairs" aria-hidden="true"></i><span><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(globalThis.PlatformLanguage?.text("scheduling","m_placement_saving","Saving…") ?? "Saving…")}</span><button type="button" class="dash-placement-cancel" data-placement-cancel disabled title="${escapeHtml(globalThis.PlatformLanguage?.text("scheduling","m_placement_saving_no_cancel_short","Saving — can’t cancel now") ?? "Saving — can’t cancel now")}">Cancel</button></div>`;
    }
    const past = !!start && placementDateIsPast(start);
    return `<div class="dash-placement-banner ${past ? 'past' : ''}" data-placement-banner role="status"><i class="fas fa-location-crosshairs" aria-hidden="true"></i><span>${text}</span>${past ? '<span class="dash-placement-banner-warn"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> Date is in the past</span>' : ''}<button type="button" class="dash-placement-cancel" data-placement-cancel title="${touch ? 'Stop placing' : 'Stop placing (Esc)'}">Cancel${touch ? '' : ' <span aria-hidden="true">· Esc</span>'}</button></div>`;
  }
  function bindPlacementBanner(scope = rootEl){
    scope?.querySelectorAll?.('[data-placement-cancel]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      cancelPlacement();
    }));
    // The floating banner must not cover the calendar's last row: the
    // calendar scrollers get that much room at the bottom (CSS var).
    const banner = (scope?.matches?.('[data-placement-banner]') ? scope : scope?.querySelector?.('.dash-schedule-card>[data-placement-banner]')) || null;
    const card = banner?.closest?.('.dash-schedule-card');
    if (card && banner) requestAnimationFrame(() => { if (banner.isConnected) card.style.setProperty('--dash-banner-space', `${Math.ceil(banner.offsetHeight + 24)}px`); });
  }
  // Updates the banner in place after a draft changes without a full render.
  function refreshPlacementBanner(){
    const current = rootEl?.querySelector('[data-placement-banner]');
    const html = placementBannerHtml(viewMode === 'appointment_schedule' ? 'routing' : 'calendar');
    if (!current || !html) return;
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const next = holder.firstElementChild;
    if (!next) return;
    current.replaceWith(next);
    bindPlacementBanner(next);
  }
  // The rail control of the item being placed, so focus can go back to it
  // when placing ends (instead of dropping to <body>).
  function placementRailFocusSelector(){
    if (vehiclePlacementUnitId) return railAttrSelector('data-vehicle-bank-unit', vehiclePlacementUnitId);
    if (productionScheduleBundleKey) return railAttrSelector('data-production-bundle-primary', productionScheduleBundleKey);
    const kind = selectedPlacementKind();
    if (kind === 'materials' && materialScheduleEventId) return `${railAttrSelector('data-production-bundle-child', materialScheduleEventId)},${railAttrSelector('data-production-event-id', materialScheduleEventId)}`;
    if (kind === 'production' && productionScheduleEventId) return railAttrSelector('data-production-bundle-child', productionScheduleEventId);
    if (kind === 'production' && productionScheduleProjectId) return `[data-production-project-id="${window.CSS?.escape ? window.CSS.escape(productionScheduleProjectId) : productionScheduleProjectId}"]:not([data-production-event-id])`;
    if (kind === 'sales' && appointmentScheduleEventId) return railAttrSelector('data-schedule-event-id', appointmentScheduleEventId);
    return '';
  }
  function cancelPlacement(){
    const focusSelector = placementRailFocusSelector();
    clearPlacementSelection();
    vehiclePlacementUnitId = '';
    vehiclePlacementDraft = null;
    if (!eventEditorEventId && !eventDraftPopoverId) closeEventDraftPopover();
    render();
    if (focusSelector) focusRailControl(`.dash-right ${focusSelector.split(',').join(',.dash-right ')}`);
  }
  // Escape stops placing when nothing is layered above the calendar; open
  // popovers and dialogs handle their own Escape first. A draft that was
  // already placed is only discarded after confirmation.
  function placementEscapeHandler(event){
    if (event.key !== 'Escape' || event.defaultPrevented || !rootEl?.isConnected) return;
    const panel = rootEl.closest?.('.fm-tabpanel');
    if (panel && !panel.classList.contains('active')) return;
    const item = placementWaitingItem();
    if (!item) return;
    if (document.querySelector('.dash-event-popover,.dash-assignee-popover,.dash-modal-backdrop,.fm-dialog-backdrop')) return;
    if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    event.preventDefault();
    requestCancelPlacement();
  }
  // Stop placing; a placed-but-unsaved draft asks before it is discarded.
  function requestCancelPlacement(){
    const item = placementWaitingItem();
    if (!item) return;
    // A save already on its way can't be taken back: say so instead.
    if (placementSaveBusy()) return;
    if (!item.start && !placementHasUnsavedEdits(item)) { cancelPlacement(); return; }
    if (requestCancelPlacement.pending) return;
    requestCancelPlacement.pending = true;
    confirmDiscardPendingPlacement()
      .then((discard) => { if (discard && placementWaitingItem() && !placementSaveBusy()) cancelPlacement(); })
      .finally(() => { requestCancelPlacement.pending = false; });
  }
  /* True (and tells the user) while a placement save is in flight: Esc,
   * Cancel, Discard and switching the rail selection wait for it. */
  function placementSaveBusy(reason = 'cancel'){
    if (!placementSaveInFlight) return false;
    const now = Date.now();
    if (now - (placementSaveBusy._last || 0) > 2500) {
      placementSaveBusy._last = now;
      // Another Save / ✓ / edit while one runs: nothing is lost, it's just busy.
      if (reason === 'save') {
        showToast(globalThis.PlatformLanguage?.text("scheduling","m_placement_saving","Saving…") ?? "Saving…", globalThis.PlatformLanguage?.text("scheduling","m_placement_saving_wait","This placement is already being saved. Wait for it to finish.") ?? "This placement is already being saved. Wait for it to finish.", { tone:'info', duration:3500 });
        return true;
      }
      showToast(globalThis.PlatformLanguage?.text("scheduling","m_placement_saving","Saving…") ?? "Saving…", globalThis.PlatformLanguage?.text("scheduling","m_placement_saving_no_cancel","This placement is being saved, so it can’t be cancelled now. Wait for it to finish.") ?? "This placement is being saved, so it can’t be cancelled now. Wait for it to finish.", { tone:'info', duration:3500 });
    }
    return true;
  }
  function placementOverlayOpen(){
    return !!document.querySelector('.dash-event-popover,.dash-assignee-popover,.dash-modal-backdrop,.fm-dialog-backdrop');
  }
  /* Moving a stored item onto an earlier day than today asks first, the
   * same way placing a waiting item there does. Items already in the past
   * that stay on their own day (a time tweak) don't ask. */
  async function confirmPastMove(event = {}, range = {}){
    const start = validDate(range.start);
    if (!start || !placementDateIsPast(start)) return true;
    const stored = allEvents.find((item) => String(item.id || '') === String(event.id || ''))
      || floatingEvents.find((item) => String(item.id || '') === String(event.id || ''))
      || event;
    const before = eventStart(stored);
    if (before && startOfDay(before)?.getTime() === startOfDay(start)?.getTime()) return true;
    return confirmPastPlacement(start, clean(event.title || event.project_title) ? `“${clean(event.title || event.project_title)}”` : 'This item', { move:true });
  }
  async function confirmPastPlacement(start, label = 'This item', options = {}){
    if (!placementDateIsPast(start)) return true;
    const confirmPlacement = window.Portal?.ui?.confirm || window.PlatformUI?.confirm;
    if (typeof confirmPlacement !== 'function') return true;
    const day = startOfDay(start);
    const dayLabel = day.toLocaleDateString([], { weekday:'long', month:'short', day:'numeric' });
    return !!(await confirmPlacement(options.move
      ? `${label} would move to ${dayLabel}, which is in the past. Move it anyway?`
      : `${label} would be placed on ${dayLabel}, which is in the past. Place it anyway?`, {
      title:options.move ? 'Move into the past?' : 'Place in the past?',
      okLabel:options.move ? 'Move anyway' : 'Place anyway',
      cancelLabel:options.move ? 'Cancel' : 'Choose another date',
      defaultFocus:'cancel'
    }));
  }
  // Switching the rail selection discards an unsaved draft; ask first.
  /* A dated sales item selected from the rail has no staged start until it
   * is moved, but an assignee or text chosen in its editor is still work. */
  function placementHasUnsavedEdits(item = placementWaitingItem()){
    if (!item || item.kind !== 'sales' || !appointmentScheduleDraft) return false;
    const draft = appointmentScheduleDraft;
    const event = selectedScheduleEvent() || {};
    const ids = (value) => (Array.isArray(value) ? value : []).map(clean).filter(Boolean).sort().join('|');
    if ((draft.user && clean(draft.user.id || draft.user) !== clean(currentAssignmentId(event))) || (Array.isArray(draft.assigned_user_ids) && ids(draft.assigned_user_ids) !== ids(event.assigned_user_ids))) return true;
    if (draft.title_is_custom && clean(draft.title) !== clean(event.title)) return true;
    return Object.prototype.hasOwnProperty.call(draft, 'description') && clean(draft.description) !== clean(event.description);
  }
  function draftAssigneeNames(draft){
    if (!draft) return '';
    const people = Array.isArray(draft.assigned_users) && draft.assigned_users.length ? draft.assigned_users : (draft.user ? [draft.user] : []);
    const names = people.map((user) => clean(user?.name || user?.display_name || user?.full_name)).filter(Boolean);
    return names.length ? names.join(', ') : clean(draft.assigned_user_name);
  }
  async function confirmDiscardPendingPlacement(){
    const item = placementWaitingItem();
    if (!item?.start && !placementHasUnsavedEdits(item)) return true;
    const confirmDiscard = window.Portal?.ui?.confirm || window.PlatformUI?.confirm;
    if (typeof confirmDiscard !== 'function') return true;
    // The control that asked keeps focus after the dialog, even when the
    // answer re-renders it.
    const focusSelector = scheduleFocusSelector(document.activeElement);
    const discard = !!(await confirmDiscard(item.start ? `${item.label} is placed as a draft but not saved yet. Discard that placement?` : `${item.label} has changes that are not saved yet. Discard them?`, {
      title:'Discard unsaved placement?',
      okLabel:'Discard',
      cancelLabel:'Keep it',
      danger:true,
      // Enter keeps the draft; discarding takes a deliberate click.
      defaultFocus:'cancel'
    }));
    if (focusSelector) requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) focusRailControl(focusSelector);
    });
    return discard;
  }
  function focusRailControl(selector = ''){
    if (!selector) return;
    try { rootEl?.querySelector(selector)?.focus?.({ preventScroll:true }); } catch (error) {}
  }
  function railAttrSelector(attr, value){
    const escaped = window.CSS?.escape ? window.CSS.escape(String(value || '')) : String(value || '').replace(/["\\]/g, '\\$&');
    return `[${attr}="${escaped}"]`;
  }
  /* Assignment a sales placement will save: an explicit lane/menu choice, then
   * an assignee edited in the popover, otherwise the appointment keeps its
   * current salesperson (a placement never silently unassigns). */
  function salesDraftAssignment(draft = null, existing = null){
    if (draft?.assignment && typeof draft.assignment === 'object') return draft.assignment;
    if (draft && (Array.isArray(draft.assigned_user_ids) || Object.prototype.hasOwnProperty.call(draft, 'assigned_user_id') || draft.work_resource_ref)) return assignmentPayloadForEvent(draft);
    return assignmentPayloadForEvent(existing || {});
  }
  function salesAssignmentLabel(assignment = {}){
    return clean(assignment.assigned_user_name || assignment.assigned_users?.[0]?.name || assignment.assigned_resource_name) || 'Unassigned';
  }
  // People who already hold sales appointments, used as Routing rows when the
  // user directory could not be read (e.g. a viewer without /users access), so
  // their appointments stay in their own rows instead of "Unassigned".
  function salesAssigneesFromEvents(){
    const byId = new Map();
    allEvents.filter((event) => isSalesEvent(event) || isSalesFollowUpEvent(event)).forEach((event) => {
      (Array.isArray(event.assigned_users) ? event.assigned_users : []).forEach((user) => {
        const id = clean(user?.id);
        if (id && !byId.has(id)) byId.set(id, { id, name:clean(user?.name || user?.email || id), email:clean(user?.email), roles:user?.role_ids || [] });
      });
      const id = clean(event.assigned_user_id);
      if (id && !byId.has(id)) byId.set(id, { id, name:clean(event.assigned_user_name || id) });
    });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  function doubleBookedEventIds(items = [], resourceIdFn = currentAssignmentId){
    const ids = new Set();
    const byResource = new Map();
    items.forEach((item) => {
      if (item?.__draft === true || ['cancelled','canceled'].includes(clean(item?.status).toLowerCase())) return;
      const resourceId = clean(resourceIdFn(item));
      const start = eventStart(item);
      const end = eventEnd(item);
      if (!resourceId || !start || !end) return;
      if (!byResource.has(resourceId)) byResource.set(resourceId, []);
      byResource.get(resourceId).push({ id:String(item.id || ''), start:start.getTime(), end:end.getTime() });
    });
    byResource.forEach((list) => {
      list.sort((a, b) => a.start - b.start);
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length && list[j].start < list[i].end; j += 1) {
          if (list[j].id === list[i].id) continue;
          ids.add(list[i].id);
          ids.add(list[j].id);
        }
      }
    });
    return ids;
  }
  function markDoubleBookedChips(mount, ids = new Set(), message = 'Double-booked: this person has another appointment at the same time'){
    if (!mount) return;
    mount.querySelectorAll('[data-prs-event-id]').forEach((chip) => {
      const booked = ids.has(String(chip.dataset.prsEventId || ''));
      chip.classList.toggle('dash-double-booked', booked);
      if (booked) chip.setAttribute('title', message);
    });
  }
  /* " X is double-booked with Y." when a moved/placed item now overlaps
   * another item of the same salesperson or crew; '' otherwise. */
  function scheduleOverlapNote(event = {}){
    if (isSalesEvent(event)) return salesOverlapWarning(event);
    if (!isProductionEvent(event) || window.PlatformScheduling?.eventIsGroup?.(event)) return '';
    const crewId = clean(workCrewId(event));
    const start = eventStart(event);
    const end = eventEnd(event);
    if (!crewId || !start || !end) return '';
    const clash = allEvents.find((other) => String(other.id || '') !== String(event.id || '')
      && isProductionEvent(other) && eventIsScheduled(other) && !window.PlatformScheduling?.eventIsGroup?.(other)
      && !['cancelled', 'canceled', 'completed', 'complete', 'done'].includes(clean(other.status).toLowerCase())
      && eventCrewRefs(other).some((ref) => clean(ref.id) === crewId)
      && eventStart(other) < end && start < eventEnd(other));
    return clash ? ` ${workCrewName(event) || 'This crew'} is double-booked with ${clean(clash.title) || 'another job'} (${projectTitle(eventProject(clash), clash)}).` : '';
  }
  function salesOverlapWarning(event = {}){
    const assigneeId = currentAssignmentId(event);
    const start = eventStart(event);
    const end = eventEnd(event);
    if (!assigneeId || !start || !end) return '';
    const clash = allEvents.find((other) => String(other.id || '') !== String(event.id || '')
      && isSalesEvent(other) && eventIsScheduled(other)
      && !['cancelled','canceled'].includes(clean(other.status).toLowerCase())
      && currentAssignmentId(other) === assigneeId
      && eventStart(other) < end && start < eventEnd(other));
    return clash ? ` ${assignedLabel(event)} is double-booked with ${projectTitle(eventProject(clash), clash)} at ${fmtTime(eventStart(clash))}.` : '';
  }
  function equipmentTypeKind(unit = {}){
    const type = equipmentTypes.find((entry) => clean(entry?.id) === clean(unit.type_id));
    return clean(type?.kind || unit.type_kind).toLowerCase();
  }
  // The vehicle bank offers vehicle-type units only; units that are down or
  // retired are left out and reserved/in-use units are marked.
  // The Routing day the vehicle bank describes (flags are for that day, not
  // for "right now").
  function vehicleBankDayRange(){
    const start = startOfDay(anchorDate) || startOfDay(new Date());
    return { id:'__vehicle_bank_day', start, end:addDays(start, 1), all_day:true };
  }
  function vehicleBankUnits(){
    const day = vehicleBankDayRange();
    // Retired units never; a unit that is down is left out only when its
    // maintenance window covers the Routing day.
    const usable = equipmentUnits.filter((unit) => {
      const status = clean(unit.status).toLowerCase();
      if (status === 'retired') return false;
      if (status !== 'down') return true;
      return !equipmentDownDetail(unit, day);
    });
    const kindsKnown = usable.some((unit) => equipmentTypeKind(unit));
    // The type list can be missing (slow load) or kind-less; fetch the kinds
    // once so trailers, tools and dumpsters stay out of the vehicle bank.
    if (!kindsKnown && usable.length && !vehicleBankUnits.requested && window.EquipmentAPI?.types) {
      vehicleBankUnits.requested = true;
      Promise.resolve(window.EquipmentAPI.types(orgId())).then((result) => {
        const types = Array.isArray(result?.types) ? result.types : [];
        if (!types.some((type) => clean(type?.kind))) return;
        const byId = new Map(types.map((type) => [clean(type.id), type]));
        equipmentTypes = equipmentTypes.length
          ? equipmentTypes.map((type) => ({ ...(byId.get(clean(type.id)) || {}), ...type, kind:clean(type.kind || byId.get(clean(type.id))?.kind) }))
          : types;
        if (rootEl?.querySelector('.dash-vehicle-bank')) render();
      }).catch(() => { vehicleBankUnits.requested = false; });
    }
    return usable
      .filter((unit) => !kindsKnown || equipmentTypeKind(unit) === 'vehicle')
      .sort((a, b) => clean(a.name || a.id).localeCompare(clean(b.name || b.id)));
  }
  function renderSchedulingRail(){
    const title = `<div class="dash-rail-title">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_428e8510d14f87","Waiting to be scheduled") ?? "Waiting to be scheduled")}</div>`;
    if (scheduleInitialLoading()) return `<div class="dash-groups">${title}<div class="dash-rail-loading" role="status"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i>Loading waiting work…</div></div>`;
    const chunks = [];
    if (scheduleTypeActive('sales')) chunks.push(renderScheduleGroups());
    if (scheduleTypeActive('production')) chunks.push(renderProductionScheduleGroups());
    // Vehicles are booked into crews' vehicle lanes, which only Routing's
    // Production pane shows. Booking one needs schedule edit, and view-only
    // sessions can't read the equipment types that tell vehicles apart from
    // trailers and tools, so they get no bank.
    if (scheduleTypeActive('production') && productionVehiclesVisible && equipmentSchedulingOn() && viewMode === 'appointment_schedule' && showProductionSchedule && canEditSchedule()) chunks.push(renderVehicleBank());
    if (!chunks.length) chunks.push('<div class="dash-empty" style="padding:16px;">Turn on Sales or Production to see work waiting to be scheduled.</div>');
    // View-only sessions see what is waiting, but nothing here is actionable.
    const viewOnly = !canEditSchedule();
    const viewOnlyNote = viewOnly ? '<div class="dash-rail-viewonly" role="note"><i class="fas fa-eye" aria-hidden="true"></i><span>View only — you can see waiting work but not schedule it.</span></div>' : '';
    return `<div class="dash-groups ${viewOnly ? 'view-only' : ''}">${title}${viewOnlyNote}${String(chunks.join(''))}</div>`;
  }
  // Scrolls Routing's Production pane so the first crew vehicle lane shows.
  function revealVehicleLanes(){
    const mount = rootEl?.querySelector('#dashScheduleViewProduction');
    const lane = mount?.querySelector('[data-prs-resource^="__vehicle__:"]');
    if (!lane) return;
    mount.closest('.dash-schedule-pane')?.scrollIntoView?.({ block:'nearest' });
    const scroller = lane.closest('.prs-resource-scroll,.psv-scroll,.prs-surface');
    if (!scroller) return;
    const laneRect = lane.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const header = scroller.querySelector('.prs-resource-head,.prs-resource-header,thead')?.getBoundingClientRect?.().height || 40;
    if (laneRect.top < scrollerRect.top + header || laneRect.bottom > scrollerRect.bottom) {
      scroller.scrollTop += laneRect.top - scrollerRect.top - header - 8;
    }
    // The bank button's tooltip would stay where the button was.
    window.PlatformUI?.hideTooltip?.();
  }
  function renderVehicleBank(){
    const units = vehicleBankUnits();
    const day = vehicleBankDayRange();
    const dayLabel = day.start.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' });
    const unitButton = (unit) => {
      const active = clean(unit.id) === vehiclePlacementUnitId;
      // Flags describe the Routing day shown: booked (job, reservation or
      // another booking) or partly out of service that day.
      const down = equipmentDownDetail(unit, day);
      const booked = !down && equipmentUnitConflict(day, unit.id);
      const flag = down ? 'Down' : booked ? 'Booked' : '';
      const flagTitle = down ? down.reason : booked ? `${clean(unit.name) || 'This vehicle'} already has a booking on ${dayLabel} — check its schedule before booking.` : '';
      return `<button type="button" class="dash-vehicle-bank-item ${active ? 'active' : ''} ${flag ? 'reserved' : ''}" data-vehicle-bank-unit="${escapeHtml(unit.id)}" aria-pressed="${active ? 'true' : 'false'}" title="${escapeHtml(flagTitle || `${clean(unit.name) || 'Vehicle'} — free on ${dayLabel}. Pick it, then click a crew's vehicle lane.`)}"><i class="fas ${escapeHtml(equipmentIconClass(unit))}" aria-hidden="true"></i><span>${escapeHtml(unit.name || unit.id)}${unit.type_name ? `<small>${escapeHtml(unit.type_name)}</small>` : ''}</span>${flag ? `<span class="dash-vehicle-bank-flag">${escapeHtml(flag)}</span>` : ''}</button>`;
    };
    return `<div class="dash-vehicle-bank"><div class="dash-vehicle-bank-title">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_fc1b55cfc4dfbc","Vehicles") ?? "Vehicles")}</div><div class="dash-vehicle-bank-items">${String(units.map(unitButton).join('') || `<span class="dash-event-equipment-empty">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_788928fd084fda","No available vehicles.") ?? "No available vehicles.")}</span>`)}</div></div>`;
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
    else if (viewMode === 'gantt') renderGanttScheduleView();
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
    if (id === 'equipment_maintenance') return { id, label: (globalThis.PlatformLanguage?.text("scheduling","m_type_equipment_maintenance","Equipment maintenance") ?? "Equipment maintenance"), title: (globalThis.PlatformLanguage?.text("scheduling","m_type_equipment_maintenance","Equipment maintenance") ?? "Equipment maintenance") };
    if (id === 'equipment_reservation') return { id, label: (globalThis.PlatformLanguage?.text("scheduling","m_type_equipment_reservation","Equipment reservation") ?? "Equipment reservation"), title: (globalThis.PlatformLanguage?.text("scheduling","m_type_equipment_reservation","Equipment reservation") ?? "Equipment reservation") };
    if (id === 'equipment_booking') return { id, label: (globalThis.PlatformLanguage?.text("scheduling","m_type_vehicle_booking","Vehicle booking") ?? "Vehicle booking"), title: (globalThis.PlatformLanguage?.text("scheduling","m_type_vehicle_booking","Vehicle booking") ?? "Vehicle booking") };
    if (id) {
      // Company-defined and "other" types keep their configured name.
      const configured = schedulingConfig?.event_types?.[id] || schedulingConfig?.scheduling?.event_types?.[id] || {};
      const humanized = id.replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
      const label = clean(configured.label || configured.name || configured.title) || (id === 'custom' ? (globalThis.PlatformLanguage?.text("scheduling","m_4a04382820d2e1","Other") ?? "Other") : humanized);
      return { id, label, title: label };
    }
    return { id: '', label: (globalThis.PlatformLanguage?.text("scheduling","m_type_event","Event") ?? "Event"), title: (globalThis.PlatformLanguage?.text("scheduling","m_2ac9ecd66d638b","New Event") ?? "New Event") };
  }
  /* Equipment windows hold a unit for a time: maintenance, reservations and
   * Routing vehicle bookings. Their editor edits only the window (no type
   * conversion, project, assignee or customer sections). */
  function isEquipmentWindowEvent(event = {}){
    const kind = eventKind(event);
    const type = eventTypeId(event);
    return ['equipment_maintenance', 'equipment_reservation', 'equipment_booking'].includes(kind) || ['equipment_maintenance', 'equipment_reservation', 'equipment_booking'].includes(type) || event?.vehicle_booking === true;
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
      // Sections (schedule groups) decorate as work: no assignee pill.
      ...withGroupRollups(events).filter(eventIsScheduled).map((event) => isProductionEvent(event) || window.PlatformScheduling?.eventIsGroup?.(event) === true
        ? decorateWorkEvent(event)
        : isMaterialEvent(event)
          ? decorateMaterialEvent(event)
          : decorateSalesEvent(event)),
      ...floatingEvents.filter((event) => !isVehicleBooking(event) && !['cancelled', 'canceled'].includes(clean(event.status).toLowerCase())).filter(eventMatchesMode).filter(eventMatchesBreakdown).map(decorateFloatingEvent)
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
  /* The stored form of a company calendar item: start_at/end_at are the
   * times; the in-memory Date shadows (start/end) and __ working flags are
   * never written, so a later edit can't write an old time back. */
  function floatingEventStoragePayload(event = {}){
    const shared = window.PlatformScheduling?.persistableEvent;
    if (typeof shared === 'function') return shared(event);
    const payload = {};
    Object.keys(event || {}).forEach((key) => {
      if (key === 'start' || key === 'end' || key.startsWith('__')) return;
      payload[key] = event[key];
    });
    return payload;
  }
  async function persistFloatingEvent(event = {}){
    const payload = { ...floatingEventStoragePayload(event), branch_id: branchId() };
    const api = window.PlatformAPI;
    // Saves of a stored event carry its revision, so the server refuses a
    // stale copy (typed stale error) instead of overwriting a newer change.
    if (window.PlatformScheduling?.saveCalendarEvent && api?.calendarEvents?.save) {
      const id = payload.id || floatingEventId();
      const result = await window.PlatformScheduling.saveCalendarEvent(orgId(), { ...payload, id }, { isNew:!(Number(payload.event_revision) > 0), branchId:branchId() });
      return normalizePersistedFloatingEvent(result, { ...payload, id });
    }
    if (api?.calendarEvents?.save) {
      const result = await api.calendarEvents.save(orgId(), payload.id || floatingEventId(), payload, { kind: 'calendar_event', branch_id: branchId() });
      if (result?.missing) throw new Error('The event could not be saved: the server could not be reached. Check your connection and try again.');
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
    return source.map((entry) => storedFloatingTimes({ ...(entry?.data || entry || {}), id: entry?.id || entry?.data?.id || entry?.id })).map(decorateFloatingEvent);
  }
  /* A stored copy's times come from start_at/end_at; an old copy that still
   * carries start/end shadows (written by earlier versions) can't override a
   * newer start_at set by another writer. */
  function storedFloatingTimes(data = {}){
    const next = { ...data };
    ['__start', '__end'].forEach((key) => { delete next[key]; });
    if (validDate(next.start_at)) delete next.start;
    if (validDate(next.end_at)) delete next.end;
    return next;
  }
  function normalizePersistedFloatingEvent(result, fallback = {}){
    const document = result?.document || result?.event || result?.calendar_event || result;
    const data = document?.data && typeof document.data === 'object' ? document.data : document;
    return decorateFloatingEvent({
      ...fallback,
      ...storedFloatingTimes(data || {}),
      id: data?.id || document?.id || fallback.id
    });
  }
  function selectedEventCalendarDraft(){
    // Only a never-saved floating event is a draft; a stored one (scheduled,
    // or an equipment window with its own status) keeps its normal styling
    // while its editor is open.
    const floatingDraft = floatingEvents.find((event) => String(event.id || '') === String(eventDraftPopoverId || '') && floatingEventIsDisposableDraft(event));
    if (floatingDraft) return floatingDraft;
    const placementKind = selectedPlacementKind();
    if (placementKind === 'materials') {
      const event = selectedMaterialEvent();
      const project = selectedMaterialProject() || eventProject(event || {});
      if (!event) return null;
      const scheduled = eventIsScheduled(event);
      return draftWithIsoRange({
        ...decorateMaterialEvent(event),
        id: event.id,
        event_id: event.id,
        project_id: project?.id || event.project_id || '',
        start: materialScheduleDraft?.start || (scheduled ? eventStart(event) : null),
        end: materialScheduleDraft?.end || (scheduled ? eventEnd(event) : null),
        all_day: materialScheduleDraft?.all_day ?? event.all_day ?? true,
        schedule_granularity: materialScheduleDraft?.schedule_granularity || event.schedule_granularity || 'date',
        ...stagedDraftText(materialScheduleDraft)
      });
    }
    if (placementKind === 'production') {
      const event = selectedProductionEvent();
      const project = selectedProductionProject() || eventProject(event || {});
      if (event) return draftWithIsoRange({
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
        // The draft editor's crew/people choice shows on the draft chip.
        assignee_label: (productionScheduleDraft ? (clean(productionScheduleDraft.assignee_label) || workCrewName(productionScheduleDraft)) : '') || workCrewName(event) || 'Unassigned',
        ...workResourcePayload(productionScheduleDraft || event),
        ...(Array.isArray(productionScheduleDraft?.resource_refs) ? { resource_refs:productionScheduleDraft.resource_refs } : {}),
        ...(Array.isArray(productionScheduleDraft?.assigned_user_ids) ? { assigned_user_ids:productionScheduleDraft.assigned_user_ids, assigned_users:productionScheduleDraft.assigned_users || [], assigned_user_id:productionScheduleDraft.assigned_user_id || '', assigned_user_name:productionScheduleDraft.assigned_user_name || '' } : {}),
        // Title/notes typed in the draft editor show on the draft chip.
        ...stagedDraftText(productionScheduleDraft)
      });
      if (project?.id) return (productionScheduleDraft ? draftWithIsoRange(productionScheduleDraft) : null) || {
        id: '__production_event_draft',
        event_id: '',
        event_type_default_id: 'project_work',
        type_id: 'project_work',
        title: projectWorkTitle(project),
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
    // The draft carries the assignee picked in the popover or a lane so the
    // editor shows it and the confirm saves it.
    const assignment = salesDraftAssignment(appointmentScheduleDraft, event);
    return draftWithIsoRange({
      id: event.id,
      event_id: event.id,
      event_type_default_id: eventTypeId(event) || 'sales_appointment',
      type_id: eventTypeId(event) || 'sales_appointment',
      title: event.title || (globalThis.PlatformLanguage?.text("scheduling","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment"),
      project_title: projectTitle(project, event),
      project_address: projectAddress(project, event),
      start: appointmentScheduleDraft?.start || eventStart(event),
      end: appointmentScheduleDraft?.start ? salesDraftEnd(event) : eventEnd(event),
      all_day: appointmentScheduleDraft?.start ? false : event.all_day === true,
      schedule_granularity: appointmentScheduleDraft?.start ? 'time' : (event.schedule_granularity || 'time'),
      ...assignment,
      assignee_label: salesAssignmentLabel(assignment),
      // The chip/tooltip names the salesperson (never a raw user id).
      __assignee_names: currentAssignmentId(assignment) ? [salesAssignmentLabel(assignment)] : [],
      ...stagedDraftText(appointmentScheduleDraft),
    });
  }
  /* Title and notes typed in a placement draft's editor: they belong to the
   * staged draft (not the stored item), so every rebuilt draft, chip and
   * editor keeps showing them until ✓ / Save commits them. */
  function stagedDraftText(staged = null){
    if (!staged || typeof staged !== 'object') return {};
    const own = (key) => Object.prototype.hasOwnProperty.call(staged, key) && staged[key] !== undefined;
    return {
      ...(staged.title_is_custom === true && own('title') ? { title:staged.title, title_is_custom:true } : {}),
      ...(own('description') ? { description:staged.description, notes:staged.description } : {}),
      ...Object.fromEntries(['customer_visible', 'customer_show_title', 'customer_show_crew', 'customer_description'].filter(own).map((key) => [key, staged[key]]))
    };
  }
  /* A staged draft carries start_at/end_at matching its start/end: editors
   * and chips that read the stored item's fields then show the draft's time
   * (never the stored item's old one). */
  function draftWithIsoRange(draft = null){
    if (!draft) return draft;
    const start = validDate(draft.start);
    const end = validDate(draft.end);
    return { ...draft, ...(start ? { start_at:start.toISOString() } : {}), ...(end ? { end_at:end.toISOString() } : {}) };
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
        event_type_default_id: eventTypeId(selectedEvent || {}) || 'project_work',
        type_id: eventTypeId(selectedEvent || {}) || 'project_work',
        project_id: project?.id || productionScheduleProjectId || '',
        title: selectedEvent?.title || clean(productionScheduleDraft?.title) || projectWorkTitle(project || {}),
        project_title: projectTitle(project || {}, productionScheduleDraft || {}),
        project_address: projectAddress(project || {}, productionScheduleDraft || {}),
        assignee_label: workCrewName(productionScheduleDraft || {}) || 'Unassigned',
        default_duration_ms: interpreted?.end && interpreted?.start ? new Date(interpreted.end).getTime() - new Date(interpreted.start).getTime() : 86400000,
        ...workResourcePayload(productionScheduleDraft || {})
      };
    }
    const event = selectedScheduleEvent();
    const project = eventProject(event || {});
    const assignment = salesDraftAssignment(appointmentScheduleDraft, event);
    return {
      id: appointmentScheduleEventId || '__sales_event_draft',
      event_id: appointmentScheduleEventId || '',
      event_type_default_id: eventTypeId(event || {}) || 'sales_appointment',
      type_id: eventTypeId(event || {}) || 'sales_appointment',
      project_id: project?.id || appointmentScheduleProjectId || event?.project_id || '',
      title: event?.title || (globalThis.PlatformLanguage?.text("scheduling","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment"),
      project_title: projectTitle(project, event || {}),
      project_address: projectAddress(project, event || {}),
      ...assignment,
      assignee_label: salesAssignmentLabel(assignment),
    };
  }
  /* Where a click/drop places a waiting item. The calendar reports the spot
   * (a day in the band or month, a time in the grid); the item keeps its own
   * nature: all-day work, deliveries and project-only placements become
   * all-day on that day (never a 24-hour timed block), timed work keeps the
   * clicked time with its own length (a band click starts it at its usual
   * time), and a sales appointment dropped on the all-day band starts at the
   * day's booking window instead of midnight. */
  function placementNaturalRange(next = null, { drag = false } = {}){
    const start = validDate(next?.start);
    if (!start || !placementWaitingItem() || vehiclePlacementUnitId) return next;
    const clickedAllDay = next.all_day !== false && clean(next.schedule_granularity).toLowerCase() !== 'time';
    const kind = selectedPlacementKind();
    const unchanged = (result) => {
      const same = validDate(result.start)?.getTime() === start.getTime()
        && validDate(result.end)?.getTime() === validDate(next.end)?.getTime()
        && (result.all_day !== false) === (next.all_day !== false);
      return same ? next : result;
    };
    if (kind === 'sales') {
      if (!clickedAllDay) return next;
      const event = selectedScheduleEvent() || {};
      // A dated appointment (e.g. scheduled but unassigned) keeps its own
      // time of day; otherwise it starts at the day's booking window.
      const ownStart = event.all_day !== true ? eventStart(event) : null;
      const minutes = ownStart ? ownStart.getHours() * 60 + ownStart.getMinutes() : minutesForClock(appointmentWindowForDate(routeDate(start)).start, 9 * 60);
      const timedStart = startOfDay(start);
      timedStart.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      const duration = Math.max(15, Number(event.duration_minutes || schedulingConfig?.event_types?.sales_appointment?.duration_minutes || 60));
      return unchanged({ ...next, start:timedStart, end:new Date(timedStart.getTime() + duration * 60000), all_day:false, schedule_granularity:'time' });
    }
    // A drag of a staged draft is the user's explicit choice of day/time.
    if (drag || !['production', 'materials'].includes(kind)) return next;
    const source = kind === 'materials' ? selectedMaterialEvent() : selectedProductionEvent();
    const project = kind === 'materials' ? (selectedMaterialProject() || eventProject(source || {})) : (selectedProductionProject() || eventProject(source || {}));
    let interpreted = null;
    if (source && kind === 'production' && window.PlatformScheduling?.interpretScheduleBundle) {
      try { interpreted = window.PlatformScheduling.interpretScheduleBundle(source, [source], startOfDay(start), project, scopeTemplates, { config:schedulingConfig })[0] || null; } catch (error) { interpreted = null; }
    }
    const interpretedStart = validDate(interpreted?.start);
    const interpretedEnd = validDate(interpreted?.end);
    const sourceTimed = source && (source.all_day === false || clean(source.schedule_granularity).toLowerCase() === 'time');
    const naturalAllDay = interpreted ? interpreted.all_day !== false : !sourceTimed;
    const sourceMinutes = Number(source?.duration_minutes || 0);
    const durationMs = interpretedStart && interpretedEnd && interpretedEnd > interpretedStart
      ? interpretedEnd.getTime() - interpretedStart.getTime()
      : (sourceMinutes > 0 ? sourceMinutes * 60000 : (naturalAllDay ? 86400000 : 60 * 60000));
    if (naturalAllDay) {
      const day = startOfDay(start);
      const days = Math.max(1, Math.round(durationMs / 86400000));
      return unchanged({ ...next, start:day, end:addDays(day, days), all_day:true, schedule_granularity:'date' });
    }
    let timedStart = start;
    if (clickedAllDay) {
      // A timed item that already has a time of day keeps it on the new day.
      const ownStart = sourceTimed ? eventStart(source) : null;
      if (ownStart) {
        timedStart = startOfDay(start);
        timedStart.setHours(ownStart.getHours(), ownStart.getMinutes(), 0, 0);
      } else {
        timedStart = interpretedStart && sameDay(interpretedStart, start) ? interpretedStart : startOfDay(start);
        if (!(interpretedStart && sameDay(interpretedStart, start))) timedStart.setHours(8, 0, 0, 0);
      }
    }
    return unchanged({ ...next, start:timedStart, end:new Date(timedStart.getTime() + durationMs), all_day:false, schedule_granularity:'time' });
  }
  /* Click placement on a day/slot that is covered by existing items: find the
   * day (or time slot) under the last pointer press and stage the draft
   * there, exactly as a click on an empty spot would. */
  function placeOnPointerDay(mount){
    const pointer = mount?.__dashLastPointer;
    if (!pointer || !placementWaitingItem() || !document.elementsFromPoint) return false;
    const cell = document.elementsFromPoint(pointer.x, pointer.y)
      .find((node) => node.matches?.('.prs-slot[data-prs-date][data-prs-time],.prs-all-day-cell[data-prs-date],.prs-day[data-prs-date]') && mount.contains(node));
    return placeOnCalendarCell(cell);
  }
  /* Stage the waiting item on a calendar cell (a day in Month / the all-day
   * band, or a time slot), exactly as a click there would. */
  /* Keyboard placement: while a waiting item is being placed, the day cells
   * (Month days, the Week/Day all-day band) are Tab stops; Enter or Space
   * stages the draft there, and focus moves to the placed draft (its ✓
   * saves it). */
  function enableKeyboardPlacement(mount){
    const item = placementWaitingItem();
    if (!mount || !item || item.kind === 'vehicle' || !canEditSchedule()) return;
    mount.querySelectorAll('.prs-month-week .prs-day[data-prs-date],.prs-all-day-cell[data-prs-date]').forEach((cell) => {
      const day = parseRouteDate(cell.dataset.prsDate);
      if (!day || cell.dataset.dashKeyPlace === '1') return;
      cell.dataset.dashKeyPlace = '1';
      cell.tabIndex = 0;
      cell.setAttribute('role', 'button');
      cell.setAttribute('aria-label', `Place ${item.label} on ${day.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' })}`);
      cell.addEventListener('keydown', (keyEvent) => {
        if (!['Enter', ' '].includes(keyEvent.key) || keyEvent.target !== cell || !placementWaitingItem()) return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        if (!placeOnCalendarCell(cell)) return;
        const placedId = String(productionScheduleDraft?.id || materialScheduleDraft?.id || appointmentScheduleEventId || '');
        requestAnimationFrame(() => {
          const chip = placedId ? editorAnchorFor(placedId) : null;
          try { (chip || rootEl?.querySelector(`[data-prs-date="${cell.dataset.prsDate}"][data-dash-key-place]`))?.focus?.({ preventScroll:false }); } catch (error) {}
        });
      });
    });
  }
  function placeOnCalendarCell(cell){
    const day = parseRouteDate(cell?.dataset?.prsDate);
    if (!cell || !day || !placementWaitingItem()) return false;
    const timed = cell.matches('.prs-slot') && /^\d{1,2}:\d{2}$/.test(clean(cell.dataset.prsTime));
    const start = startOfDay(day);
    if (timed) {
      const [hours, minutes] = clean(cell.dataset.prsTime).split(':').map(Number);
      start.setHours(hours, minutes, 0, 0);
    }
    const range = { start, end:timed ? new Date(start.getTime() + 60 * 60000) : addDays(start, 1), allDay:!timed };
    const base = eventCalendarDefaultDraftPayload(range);
    const next = placementNaturalRange({ ...base, start:range.start, end:range.end, all_day:!timed, schedule_granularity:timed ? 'time' : 'date' });
    applyEventCalendarDraft(next);
    if (selectedPlacementKind() === 'production' && productionScheduleBundleKey) productionScheduleBundleDrafts = scheduleBundleDrafts(productionScheduleDraft || next);
    render();
    refreshPlacementEditor();
    return true;
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
        schedule_granularity: next.schedule_granularity || (next.all_day === false ? 'time' : 'date'),
        // A calendar move never drops what was typed in the draft editor.
        ...stagedDraftText(productionScheduleDraft)
      };
      return;
    }
    // Only the time comes from the calendar; any assignee already chosen for
    // the draft (popover, chip menu) is kept, and so is a length set in the
    // draft editor.
    appointmentScheduleDraft = salesDraftAtStart(next.start, next.all_day === false ? next.end : null);
    appointmentScheduleEventId = String(next.event_id || appointmentScheduleEventId || '');
    appointmentScheduleProjectId = String(selectedScheduleEvent()?.project_id || appointmentScheduleProjectId || '');
  }
  /* The sales placement draft's end: the one set in its editor (or by the
   * calendar) when it follows the start, else start + the appointment length. */
  function salesDraftEnd(event = selectedScheduleEvent() || {}){
    const start = validDate(appointmentScheduleDraft?.start);
    if (!start) return eventEnd(event);
    const end = validDate(appointmentScheduleDraft?.end);
    if (end && end > start) return end;
    const storedStart = eventStart(event);
    const storedEnd = eventEnd(event);
    const minutes = storedStart && storedEnd && storedEnd > storedStart && event.all_day !== true
      ? Math.round((storedEnd.getTime() - storedStart.getTime()) / 60000)
      : Number(event.duration_minutes || schedulingConfig?.event_types?.sales_appointment?.duration_minutes || 60);
    return new Date(start.getTime() + Math.max(15, minutes) * 60000);
  }
  // Moves the sales draft to `start`, keeping its length unless `end` is given.
  function salesDraftAtStart(start, end = null){
    const nextStart = validDate(start);
    if (!nextStart) return appointmentScheduleDraft;
    const previousStart = validDate(appointmentScheduleDraft?.start);
    const previousEnd = previousStart ? salesDraftEnd() : null;
    const nextEnd = validDate(end) && validDate(end) > nextStart
      ? validDate(end)
      : (previousStart && previousEnd ? new Date(nextStart.getTime() + (previousEnd.getTime() - previousStart.getTime())) : null);
    const { end:_previous, end_at:_previousAt, start_at:_previousStartAt, ...rest } = appointmentScheduleDraft || {};
    return { ...rest, start:nextStart, ...(nextEnd ? { end:nextEnd } : {}) };
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
      schedule_granularity: next.schedule_granularity || (next.all_day === false ? 'time' : 'date'),
      ...stagedDraftText(materialScheduleDraft)
    };
  }
  function projectScheduleItems(projectId = ''){
    const id = String(projectId || '');
    return id ? allEvents.filter((item) => String(item.project_id || '') === id) : [];
  }
  /* Linked items a move of `event` to `range` displaces: depends_on links in
   * both directions (successors pushed later only when violated, predecessors
   * pulled earlier only when needed) plus scope-template bundle rules.
   * Returns { drafts, blocked } — blocked are locked/completed items whose
   * link would break. */
  function scheduledRelationshipRescheduleImpact(event = {}, range = {}){
    const Scheduling = window.PlatformScheduling;
    const project = eventProject(event);
    if (!project?.id || !range?.start || !event?.id) return { drafts:[], blocked:[] };
    const related = projectScheduleItems(project.id).filter((item) => eventIsScheduled(item) || String(item.id || '') === String(event.id || ''));
    if (Scheduling?.relatedScheduleRescheduleImpact) return Scheduling.relatedScheduleRescheduleImpact(event, related, range, project, scopeTemplates, { config:schedulingConfig });
    if (Scheduling?.relatedScheduleRescheduleDrafts) return { drafts:Scheduling.relatedScheduleRescheduleDrafts(event, related, range, project, scopeTemplates), blocked:[] };
    return { drafts:[], blocked:[] };
  }
  function scheduledRelationshipRescheduleDrafts(event = {}, range = {}){
    return scheduledRelationshipRescheduleImpact(event, range).drafts;
  }
  function scheduleItemNames(items = []){
    const names = items.map((item) => `“${clean(item?.title) || 'Untitled item'}”`);
    if (names.length <= 1) return names.join('');
    if (names.length > 3) return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  async function chooseRelationshipReschedule(event = {}, relatedDrafts = [], blocked = []){
    const drafts = Array.isArray(relatedDrafts) ? relatedDrafts : [];
    const fixed = (Array.isArray(blocked) ? blocked : []).map((entry) => entry?.event || entry).filter(Boolean);
    if (!drafts.length && !fixed.length) return 'no';
    const count = drafts.length;
    const subject = `“${clean(event?.title) || 'This item'}”`;
    const fixedNote = fixed.length
      ? ` ${scheduleItemNames(fixed)} ${fixed.length === 1 ? 'is' : 'are'} locked or completed and won't move, so ${fixed.length === 1 ? 'its' : 'their'} dependency will be out of order.`
      : '';
    if (!count) {
      return window.Portal?.ui?.choose?.(
        `Moving ${subject} breaks a dependency.${fixedNote}`,
        [
          { value:'cancel', label:(globalThis.PlatformLanguage?.text("scheduling","m_cbef679b21abb4","Cancel") ?? "Cancel") },
          { value:'no', label:'Move anyway', primary:true, danger:true }
        ],
        // Enter must not break the dependency: Cancel takes focus.
        { title:'Dependency conflict', defaultFocus:'cancel' }
      ) || 'cancel';
    }
    return window.Portal?.ui?.choose?.(
      `Moving ${subject} affects ${count} linked item${count === 1 ? '' : 's'}: ${scheduleItemNames(drafts)}. Move ${count === 1 ? 'it' : 'them'} too so dependencies and scheduling rules stay in order?${fixedNote}`,
      [
        { value:'cancel', label:(globalThis.PlatformLanguage?.text("scheduling","m_cbef679b21abb4","Cancel") ?? "Cancel") },
        { value:'no', label:(globalThis.PlatformLanguage?.text("scheduling","m_2f0222913078f4","No") ?? "No") },
        { value:'yes', label:(globalThis.PlatformLanguage?.text("scheduling","m_549ccd0e27a3d4","Yes") ?? "Yes"), primary:true }
      ],
      { title:(globalThis.PlatformLanguage?.text("scheduling","m_64b37c5695aa34","Move related schedule items") ?? "Move related schedule items") }
    ) || 'cancel';
  }
  /* Single entry point for any surface that reschedules a placed project item
   * (calendar drags, Routing ✓ confirm, editor saves, Timeline): computes the
   * linked items, asks once, and returns the related changes to save.
   * -> { cancelled, choice, changes, impact } */
  async function resolveRelatedReschedule(event = {}, range = {}){
    const Scheduling = window.PlatformScheduling;
    const impact = scheduledRelationshipRescheduleImpact(event, range);
    const asked = impact.drafts.length || impact.blocked.length;
    const choice = asked ? await chooseRelationshipReschedule(event, impact.drafts, impact.blocked) : 'no';
    const cancelled = choice === 'cancel' || choice === false || choice == null;
    const changes = !cancelled && choice === 'yes' && Scheduling?.updateProjectEventRange ? impact.drafts.map((draft) => {
      const source = allEvents.find((item) => String(item.id || '') === String(draft.id || draft.event_id || '')) || draft;
      return {
        ...Scheduling.updateProjectEventRange(source, {
          start:new Date(draft.start || draft.start_at),
          end:new Date(draft.end || draft.end_at),
          all_day:draft.all_day !== false,
          schedule_granularity:draft.schedule_granularity || (draft.all_day === false ? 'time' : 'date')
        }),
        status:'scheduled'
      };
    }) : [];
    const leftOutOfOrder = cancelled ? 0 : impact.blocked.length + (choice === 'yes' ? 0 : impact.drafts.length);
    return { cancelled, choice:cancelled ? 'cancel' : choice, changes, impact, leftOutOfOrder };
  }
  // Save related changes one by one (after the moved item) and merge results.
  /* Save the linked items of a move. They go one at a time (they usually
   * share one project record, so parallel writes would race on it), with a
   * progress note for longer chains. The chain keeps going when one item
   * fails and does not depend on the view staying open, so moving around the
   * app never leaves it half-applied; failures are reported at the end. */
  async function saveRelatedRescheduleChanges(project = {}, changes = []){
    const Scheduling = window.PlatformScheduling;
    const list = Array.isArray(changes) ? changes : [];
    const failed = [];
    // Saved one after another (writes to one project must not race); a
    // running count shows the cascade is progressing.
    const progress = list.length > 1;
    for (const [index, related] of list.entries()) {
      if (progress) showToast('Moving linked items…', `${index + 1} of ${list.length}: ${clean(related.title) || 'schedule item'}`, { tone:'info', duration:15000 });
      const relatedProject = eventProject(related)?.id ? eventProject(related) : project;
      const relatedVersion = beginEventRangeSave(related.id);
      try {
        const relatedSaved = await queueEventRangeSave(related.id, () => Scheduling.saveProjectEvent(orgId(), relatedProject, withExplicitAssignees(related), schedulingConfig));
        mergeSavedCalendarEvent(relatedSaved, related, relatedVersion);
      } catch (error) {
        failed.push({ item:related, error });
      }
    }
    if (failed.length) {
      scheduleLoad();
      const error = new Error(`${scheduleItemNames(failed.map((entry) => entry.item))} ${failed.length === 1 ? 'was' : 'were'} not moved: ${scheduleSaveErrorMessage(failed[0].error, 'Could not save.')}`);
      error.relatedFailures = failed;
      throw error;
    }
  }
  function outOfOrderNote(count = 0){
    return count ? ` ${count} linked item${count === 1 ? ' is' : 's are'} now out of dependency order.` : '';
  }
  /* Auto-rollup groups display the span of their items in every view; the
   * stored group range can lag behind item moves made elsewhere. */
  function withGroupRollups(list = []){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling?.applyGroupRollups || !Scheduling?.eventIsGroup || !list.some((event) => Scheduling.eventIsGroup(event))) return list;
    const rolled = new Map(Scheduling.applyGroupRollups(allEvents)
      .filter((event) => event.__rollup_derived === true)
      .map((event) => [String(event.id || ''), event]));
    return list.map((event) => {
      const rollup = rolled.get(String(event.id || ''));
      return rollup ? {
        ...event,
        start_at:rollup.start_at,
        start:rollup.start_at,
        end_at:rollup.end_at,
        end:rollup.end_at,
        duration_minutes:rollup.duration_minutes,
        status:rollup.status,
        __rollup_derived:true
      } : event;
    });
  }
  /* Persist parent groups whose stored range/status no longer matches their
   * items (after items were placed or moved), so every surface agrees. */
  async function persistGroupRollups(project = {}, changedItems = []){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling?.groupRollupUpdates || !Scheduling?.eventAncestorGroupIds || !project?.id) return [];
    const projectEvents = projectScheduleItems(project.id);
    const groupIds = Scheduling.eventAncestorGroupIds(projectEvents, changedItems);
    if (!groupIds.length) return [];
    const updates = Scheduling.groupRollupUpdates(projectEvents, groupIds).filter((group) => !eventIsLocked(group));
    for (const update of updates) {
      updateLocalCalendarEvent(update.id, update);
      const version = beginEventRangeSave(update.id);
      try {
        const saved = await queueEventRangeSave(update.id, () => Scheduling.saveProjectEvent(orgId(), project, update, schedulingConfig));
        mergeSavedCalendarEvent(saved, update, version);
      } catch (error) {
        // The rollup is re-derived on every render, so a failed sync of the
        // stored group range is not user-visible; the next change retries it.
      }
    }
    if (updates.length) events = visibleEvents();
    return updates;
  }
  /* Dragging an auto-rollup group bar moves the items inside it together.
   * Returns false when the caller should save the group record itself
   * (manual groups, or groups without placed items). */
  async function moveScheduleGroup(group = {}, range = {}){
    const Scheduling = window.PlatformScheduling;
    const project = eventProject(group);
    if (!Scheduling?.groupMoveDrafts || !project?.id || Scheduling.groupRollupMode?.(group) === 'manual') return false;
    const move = Scheduling.groupMoveDrafts(projectScheduleItems(project.id), group, range);
    if (!move.items.length) return false;
    const refuse = (title, message) => {
      showToast(title, message, false);
      refreshActiveScheduleSurface();
      return true;
    };
    if (move.resized) return refuse('Section not resized', 'A section spans its items. Resize or move the items inside it instead.');
    if (!move.delta) { refreshActiveScheduleSurface(); return true; }
    if (move.blocked.length) {
      return refuse('Section not moved', `${scheduleItemNames(move.blocked)} ${move.blocked.length === 1 ? 'is' : 'are'} locked or completed, so this section can't move as a whole. Move its other items individually.`);
    }
    const changes = move.drafts.map((draft) => ({ ...draft, status:'scheduled' }));
    const changesById = new Map(changes.map((item) => [String(item.id || ''), item]));
    const previousById = new Map();
    allEvents.forEach((item) => { const id = String(item.id || ''); if (changesById.has(id)) previousById.set(id, item); });
    allEvents = allEvents.map((item) => changesById.has(String(item.id || '')) ? { ...item, ...changesById.get(String(item.id || '')) } : item);
    events = visibleEvents();
    refreshActiveScheduleSurface();
    try {
      await saveRelatedRescheduleChanges(project, changes);
      await persistGroupRollups(project, changes);
      refreshActiveScheduleSurface();
      showToast('Section moved', `${changes.length} item${changes.length === 1 ? '' : 's'} moved together.`, true);
    } catch (error) {
      showToast('Section not moved', error?.message || 'Could not move every item in this section.', false);
      allEvents = allEvents.map((item) => previousById.get(String(item.id || '')) || item);
      events = visibleEvents();
      refreshActiveScheduleSurface();
      scheduleLoad();
    }
    return true;
  }
  /* An editor open on a moved item shows its new time. */
  function refreshOpenEditorFor(eventId = ''){
    const pop = document.querySelector('.dash-event-popover');
    if (!pop || pop.dataset.eventId !== String(eventId || '')) return;
    if (String(eventEditorEventId || '') !== String(eventId || '') && String(eventDraftPopoverId || '') !== String(eventId || '')) return;
    renderEventDraftPopover(editorAnchorFor(eventId));
  }
  /* Toast body for a finished move/resize. */
  function scheduleMoveMessage(before = {}, after = {}){
    const sameStart = eventStart(before)?.getTime() === eventStart(after)?.getTime();
    const sameEnd = eventEnd(before)?.getTime() === eventEnd(after)?.getTime();
    // A drop into another lane (Routing) reassigns: say who has it now.
    // Work items compare their whole crew/person set (a multi-crew item can
    // change a non-primary crew).
    const workSet = (item) => isProductionEvent(item) && !isMaterialEvent(item)
      ? [...eventCrewRefs(item), ...editorAssignmentUserList(item)]
      : null;
    const setBefore = workSet(before);
    const setAfter = workSet(after);
    const assigned = setBefore && setAfter
      ? (setBefore.map((item) => item.id).join('|') !== setAfter.map((item) => item.id).join('|')
        ? (setAfter.length ? ` Assigned to ${setAfter.map((item) => clean(item.name) || item.id).join(', ')}.` : ' It is now unassigned.')
        : '')
      : (clean(currentAssignmentId(before)) !== clean(currentAssignmentId(after))
        ? (clean(currentAssignmentId(after)) ? ` Assigned to ${workCrewName(after) || salesAssignmentLabel(assignmentPayloadForEvent(after))}.` : ' It is now unassigned.')
        : '');
    // Dropping onto a slot the same person/crew already holds is allowed but
    // said out loud (the lane also marks both chips double-booked).
    const overlap = scheduleOverlapNote(after);
    if (sameStart && sameEnd && assigned) return `${assigned.trim()}${overlap}`;
    // Either edge: a start-edge resize keeps the end and changes the length.
    if (sameStart !== sameEnd) return `The calendar item was resized: ${formatEventDraftTime(after)}.${assigned}${overlap}`;
    return `The calendar item was moved to ${formatEventDraftTime(after)}.${assigned}${overlap}`;
  }
  /* Moving an occurrence of a recurring series asks which occurrences move
   * (This event / This and following / All events) — same as the editor.
   * -> 'this' | 'following' | 'all' | 'cancel' */
  async function chooseRecurringMoveScope(event = {}, range = {}){
    if (!clean(event?.recurrence_series_id) || !window.PlatformAPI?.projects?.updateRecurrenceSeries) return 'this';
    const choose = window.Portal?.ui?.choose;
    if (typeof choose !== 'function') return 'this';
    const text = (key, fallback) => globalThis.PlatformLanguage?.text("scheduling", key, fallback) ?? fallback;
    const label = clean(event.title || event.project_title) || 'This event';
    // "This event" is the safe default (focused, primary): Enter never moves
    // the whole series by accident. Short labels keep the four buttons on
    // one row.
    const choice = await choose(
      `“${label}” repeats. Move to ${formatEventDraftTime({ ...event, start:range.start, end:range.end, start_at:validDate(range.start)?.toISOString(), end_at:validDate(range.end)?.toISOString(), all_day:range.all_day === true || (range.all_day === undefined && event.all_day === true) })} — which events?`,
      [
        { value:'cancel', label:text('m_cbef679b21abb4', 'Cancel') },
        { value:'all', label:text('m_scope_all', 'All events') },
        { value:'following', label:text('m_scope_following_short', 'This & following') },
        { value:'this', label:text('m_scope_this', 'This event'), primary:true, default:true }
      ],
      { title:text('m_scope_move_title', 'Move recurring event'), defaultFocus:'this' }
    );
    return ['this', 'following', 'all'].includes(choice) ? choice : 'cancel';
  }
  async function saveRecurringMove(event = {}, range = {}, scope = 'all'){
    const seriesId = clean(event.recurrence_series_id);
    const start = validDate(range.start);
    const end = validDate(range.end) || (start ? new Date(start.getTime() + Math.max(15 * 60000, (eventEnd(event)?.getTime() || 0) - (eventStart(event)?.getTime() || 0))) : null);
    if (!seriesId || !start || !end) return;
    const moved = { ...event, start:start.toISOString(), end:end.toISOString(), start_at:start.toISOString(), end_at:end.toISOString(), all_day:range.all_day ?? event.all_day, schedule_granularity:range.schedule_granularity || event.schedule_granularity };
    try {
      await window.PlatformAPI.projects.updateRecurrenceSeries(orgId(), seriesId, recurrencePayloadForEvent(moved, { scope, hasRecurrenceFields:false }));
      await loadData({ force:true });
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      showToast(scope === 'following' ? 'This and following events moved' : 'All events moved', 'Occurrences you changed on their own keep their own changes.', true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), scheduleSaveErrorMessage(error, 'Could not move the recurring events.'), false);
      refreshActiveScheduleSurface();
    }
  }
  /* A drag has nothing focused; when it asked something (past day, series,
   * dependencies) focus lands on the moved item afterwards instead of the
   * page body, so keyboard users keep their place. */
  async function saveEventCalendarRange(event, range){
    let asked = false;
    const onDialogClosed = () => { asked = true; };
    window.addEventListener('fm:dialog:closed', onDialogClosed);
    try {
      return await saveEventCalendarRangeNow(event, range);
    } finally {
      window.removeEventListener('fm:dialog:closed', onDialogClosed);
      const active = document.activeElement;
      if (asked && event?.id && (!active || active === document.body || !active.isConnected) && !document.querySelector('.fm-dialog-backdrop,.dash-event-popover')) {
        const anchor = editorAnchorFor(event.id);
        if (anchor && !anchor.matches('button,a,[tabindex]')) anchor.setAttribute('tabindex', '-1');
        anchor?.focus?.({ preventScroll:true });
        // Focus must not pop the item's hover card over its neighbours.
        window.PlatformUI?.hideTooltip?.();
      }
    }
  }
  async function saveEventCalendarRangeNow(event, range){
    const Scheduling = window.PlatformScheduling;
    const currentEvent = allEvents.find((item) => String(item.id || '') === String(event?.id || '')) || event;
    const project = eventProject(currentEvent);
    range = rangeKeepingLaneAssignment(currentEvent, range, event);
    if (!canEditSchedule()) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), scheduleReadOnlyMessage(), VIEW_ONLY_TOAST);
      refreshActiveScheduleSurface();
      return;
    }
    // A drag replaces any unsaved time edits for the same item in the editor.
    if (eventEditorDraft && String(eventEditorDraft.id || '') === String(event?.id || '')) {
      const { start, end, start_at, end_at, all_day, schedule_granularity, ...rest } = eventEditorDraft.patch || {};
      eventEditorDraft = { ...eventEditorDraft, patch:rest };
    }
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
    if (!(await confirmPastMove(currentEvent, range))) { refreshActiveScheduleSurface(); return; }
    // An occurrence of a recurring series asks which occurrences move, the
    // same choice the editor offers.
    const recurrenceScope = await chooseRecurringMoveScope(currentEvent, range);
    if (recurrenceScope === 'cancel') { refreshActiveScheduleSurface(); return; }
    if (recurrenceScope === 'following' || recurrenceScope === 'all') {
      await saveRecurringMove(currentEvent, range, recurrenceScope);
      return;
    }
    if (event?.floating_event === true || String(event?.id || '').startsWith('floating_')) {
      const saveVersion = beginEventRangeSave(event.id);
      const originalFloating = floatingEvents.find((item) => String(item.id || '') === String(event.id || '')) || null;
      const persistedFloating = !!originalFloating && !floatingEventIsDisposableDraft(originalFloating);
      const next = updateFloatingEvent({
        ...event,
        ...range,
        start: range.start,
        end: range.end,
        all_day: range.all_day,
        schedule_granularity: range.schedule_granularity || (range.all_day === false ? 'time' : 'date'),
        status: event.status === 'scheduled' ? 'scheduled' : (event.status || 'draft'),
        ...equipmentWindowPatch(originalFloating || event, { start:eventStart(originalFloating || event), end:eventEnd(originalFloating || event) }, { start:range.start, end:range.end })
      });
      try {
        const saved = await queueEventRangeSave(event.id, async () => {
          let toSave = next;
          if (persistedFloating) {
            // Only the time is this move's change: anything else changed
            // elsewhere (title, notes, equipment) is kept.
            const ownGroups = eventChangeGroups(originalFloating, next).filter((group) => group !== 'equipment');
            const check = await checkStoredScheduleEvent(originalFloating, ownGroups);
            if (check.conflict) {
              await reloadAfterStaleChange();
              throw staleScheduleError();
            }
            if (check.fresh && check.remoteGroups.length) {
              const merged = mergeEventChanges(check.fresh, next, ownGroups);
              toSave = decorateFloatingEvent({ ...merged, ...equipmentWindowPatch(check.fresh, { start:eventStart(check.fresh), end:eventEnd(check.fresh) }, { start:eventStart(next), end:eventEnd(next) }) });
            }
          }
          return persistFloatingEvent(toSave);
        });
        if (eventRangeSaveVersions.get(String(event.id || '')) === saveVersion) {
          updateFloatingEvent({ ...next, ...saved, status: next.status || saved?.status || 'scheduled' });
          refreshOpenEditorFor(event.id);
          if (persistedFloating) {
            refreshActiveScheduleSurface();
            showToast((globalThis.PlatformLanguage?.text("scheduling","m_a1da9bcb050cbb","Schedule updated") ?? "Schedule updated"), scheduleMoveMessage(originalFloating, next), true);
          }
        }
      } catch (error) {
        if (error?.staleSchedule) return;
        if (isStaleSaveError(error)) {
          if (originalFloating) floatingEvents = [originalFloating, ...floatingEvents.filter((item) => String(item.id || '') !== String(originalFloating.id || ''))];
          await reloadAfterStaleChange(error);
          return;
        }
        if (eventRangeSaveVersions.get(String(event.id || '')) === saveVersion) {
          showToast((globalThis.PlatformLanguage?.text("scheduling","m_90522d8e2312ca","Event not saved") ?? "Event not saved"), scheduleSaveErrorMessage(error, 'Could not save the event change.'), false);
          // Put the item back where storage has it instead of leaving it at
          // the unsaved position.
          if (originalFloating) floatingEvents = [originalFloating, ...floatingEvents.filter((item) => String(item.id || '') !== String(originalFloating.id || ''))];
          refreshActiveScheduleSurface();
        }
      }
      return;
    }
    if (!Scheduling || !event?.id || !project?.id || !range?.start) return;
    // A group bar carries its items with it (or is refused when some are locked).
    if (Scheduling.eventIsGroup?.(currentEvent) && await moveScheduleGroup(currentEvent, range)) return;
    // depends_on links and scope rules decide which linked items move too.
    const related = await resolveRelatedReschedule(currentEvent, range);
    if (related.cancelled) {
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
    // A work item's lane drop carries its whole new assignee set (see
    // rangeKeepingLaneAssignment): applied before the range so the crew list
    // is replaced, not merged with the old crew.
    const laneAssignees = isProductionEvent(currentEvent) && rangeCarriesAssignment(range)
      ? Object.fromEntries(Object.entries(range).filter(([key]) => !['start', 'end', 'start_at', 'end_at', 'all_day', 'schedule_granularity', 'status'].includes(key)))
      : null;
    const assignedEvent = laneAssignees ? { ...currentEvent, ...laneAssignees } : currentEvent;
    const next = (isProductionEvent(currentEvent) || isMaterialEvent(currentEvent))
      ? Scheduling.updateProjectEventRange(assignedEvent, payload)
      : {
          ...withScheduleHistory(currentEvent, 'rescheduled'),
          // Only a lane drop changes who is assigned; a plain move keeps every
          // crew and person on the item.
          ...(rangeCarriesAssignment(range) ? assignment : {}),
          start_at: payload.start.toISOString(),
          start: payload.start.toISOString(),
          end_at: payload.end.toISOString(),
          end: payload.end.toISOString(),
          all_day: payload.all_day,
          schedule_granularity: payload.schedule_granularity,
          // A resize changes the length; a stored duration follows it.
          ...(payload.all_day === false && currentEvent.duration_minutes != null
            ? { duration_minutes: Math.max(1, Math.round((payload.end - payload.start) / 60000)) }
            : {}),
          updated_at: new Date().toISOString()
        };
    // Equipment usage windows move with the item.
    Object.assign(next, equipmentWindowPatch(assignedEvent, { start:eventStart(currentEvent), end:eventEnd(currentEvent) }, { start:payload.start, end:payload.end }));
    const relatedChanges = related.changes;
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
      const known = previousById.get(String(event.id || ''));
      const saved = await queueEventRangeSave(event.id, async () => {
        // Never overwrite a newer change from another window with this
        // view's older copy: only the moved fields (time, and the lane's
        // assignment) are this save's; anything else changed elsewhere since
        // this view loaded the item (description, equipment…) is kept.
        let toSave = next;
        if (known) {
          const ownGroups = eventChangeGroups(known, next).filter((group) => group !== 'equipment');
          const check = await checkStoredScheduleEvent(known, ownGroups);
          if (check.conflict) {
            await reloadAfterStaleChange();
            throw staleScheduleError();
          }
          if (check.fresh && check.remoteGroups.length) {
            toSave = mergeEventChanges(check.fresh, next, ownGroups);
            Object.assign(toSave, equipmentWindowPatch(check.fresh, { start:eventStart(check.fresh), end:eventEnd(check.fresh) }, { start:payload.start, end:payload.end }));
          }
        }
        return Scheduling.saveProjectEvent(orgId(), project, withExplicitAssignees(toSave), schedulingConfig);
      });
      mergeSavedCalendarEvent(saved, next, saveVersion);
      refreshOpenEditorFor(event.id);
      await saveRelatedRescheduleChanges(project, relatedChanges);
      await persistGroupRollups(project, changes);
      settlePlacementSelectionAfterSave(next);
      refreshActiveScheduleSurface();
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_a1da9bcb050cbb","Schedule updated") ?? "Schedule updated"), `${relatedChanges.length ? `The calendar item and ${relatedChanges.length} linked item${relatedChanges.length === 1 ? '' : 's'} were moved.` : scheduleMoveMessage(known || currentEvent, next)}${outOfOrderNote(related.leftOutOfOrder)}`, !related.leftOutOfOrder);
    } catch (error) {
      // A stale copy was refused before writing; the view already reloaded.
      if (error?.staleSchedule) return;
      if (isStaleSaveError(error)) {
        allEvents = allEvents.map((item) => previousById.get(String(item.id || '')) || item);
        events = visibleEvents();
        await reloadAfterStaleChange(error);
        return;
      }
      // The item itself was saved; some linked items were not (the view
      // reloads the stored state).
      if (error?.relatedFailures) {
        showToast('Some linked items were not moved', error.message, false);
        return;
      }
      if (eventRangeSaveVersions.get(String(event.id || '')) === saveVersion) {
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), scheduleSaveErrorMessage(error, 'Could not update this calendar item.'), false);
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
    const person = (user) => ({
      ...(Scheduling?.normalizeUser ? Scheduling.normalizeUser(user) : user),
      subject_type:'organization_user',
      id:clean(user.id),
      name:clean(user.name || user.email || user.id),
      user
    });
    const people = users.map(person);
    const eligible = (Scheduling?.filterAssignableSubjects?.([...people, ...workforceResources], policy) || people)
      .filter((subject) => clean(subject.status || 'active') !== 'disabled')
      .filter((user) => user.id);
    // Without a readable user directory the assignment policy cannot be
    // evaluated; fall back to the people already holding appointments so a
    // drag keeps them in their own row instead of saving "Unassigned".
    if (users.length) return eligible;
    const known = new Set(eligible.map((subject) => clean(subject.id)));
    return [...eligible, ...salesAssigneesFromEvents().filter((user) => !known.has(user.id)).map(person)];
  }
  function rangeCarriesAssignment(range = {}){
    return ['assigned_user_id', 'assigned_user_ids', 'assigned_resource_id', 'work_resource_ref'].some((key) => Object.prototype.hasOwnProperty.call(range || {}, key));
  }
  /* A lane drop reassigns only when the lanes can represent the item:
   * - an item whose assignee has no row of its own (unknown/unloaded person)
   *   is drawn in "Unassigned"; moving it within that row keeps the assignee;
   * - a work item's dropped copy hands its lane over to the target lane: the
   *   dragged crew/person is REPLACED (never added), other crews of a
   *   multi-crew item stay, and "Unassigned" removes every crew and person.
   *   `dragged` is the lane copy that was moved (a multi-crew item is drawn
   *   once per crew). Production drops return the item's whole assignee set
   *   (resource_refs included) so the save writes exactly that set. */
  function rangeKeepingLaneAssignment(event = {}, range = {}, dragged = event){
    if (!range || !rangeCarriesAssignment(range)) return range;
    const stripAssignment = () => Object.fromEntries(Object.entries(range).filter(([key]) => ![
      'assigned_user_id', 'assigned_user_ids', 'assigned_users', 'assigned_user_name', 'work_resource_ref', 'assigned_resource_kind', 'assigned_resource_id', 'assigned_resource_name',
      'assigned_crew_id', 'assigned_crew_name', 'assigned_crew', 'crew_id', 'crew_name', 'resource_id', 'resource_name'
    ].includes(key)));
    const currentId = currentAssignmentId(event);
    const nextId = currentAssignmentId({ ...event, ...range });
    if (isProductionEvent(event) && !isMaterialEvent(event)) {
      // The dragged copy's own lane (the renderer has already rewritten the
      // copy's assignment to the drop lane); single-crew items have one lane.
      const fromId = clean(dragged?.__lane_crew_id) || currentId;
      // Moved within its own lane: only the dates change.
      if (fromId === nextId) return stripAssignment();
      const laneIds = new Set(productionWorkResources(event?.scope_template_id, event).map((resource) => clean(resource.id)));
      // Drawn in "Unassigned" because its assignee has no lane: kept.
      if (!nextId && fromId && !laneIds.has(fromId)) return stripAssignment();
      const crews = eventCrewRefs(event);
      const people = editorAssignmentUserList(event);
      let nextCrews = [];
      let nextPeople = [];
      if (nextId) {
        const target = productionWorkResources(event?.scope_template_id, event).find((resource) => clean(resource.id) === nextId)
          || { id:nextId, name:clean(range.assigned_resource_name || range.assigned_crew_name || range.assigned_user_name) || nextId, subject_type:clean(range.assigned_resource_kind) || (clean(range.assigned_user_id) ? 'organization_user' : 'resource_group') };
        const targetIsPerson = clean(target.subject_type || target.resource_kind) === 'organization_user';
        const targetCrew = { id:nextId, name:clean(target.name) || nextId, kind:clean(target.resource_kind || target.work_resource_ref?.kind) || 'resource_group' };
        const targetPerson = { id:nextId, name:clean(target.name) || userDisplayName(nextId) };
        const fromIsCrew = crews.some((crew) => crew.id === fromId);
        nextCrews = crews.flatMap((crew) => crew.id === fromId ? (targetIsPerson ? [] : [targetCrew]) : [crew]);
        nextPeople = people.filter((person) => person.id !== fromId);
        if (targetIsPerson) nextPeople = [targetPerson, ...nextPeople];
        else if (!fromIsCrew) nextCrews = [targetCrew, ...nextCrews];
      }
      const dedupe = (list) => list.filter((item, index) => item.id && list.findIndex((other) => other.id === item.id) === index);
      return { ...stripAssignment(), ...assigneeSetPatch(event, dedupe(nextCrews), dedupe(nextPeople)) };
    }
    if (!currentId || nextId) return range;
    const laneIds = new Set(salesResources(event).map((resource) => clean(resource.id)));
    return laneIds.has(currentId) ? range : stripAssignment();
  }
  // Crews/teams referenced by a work item (a multi-crew job lists several).
  function eventCrewRefs(event = {}){
    const refs = (Array.isArray(event.resource_refs) ? event.resource_refs : [])
      .filter((ref) => ['resource_group', 'organization_connection'].includes(clean(ref?.kind)))
      .map((ref) => ({ id:clean(ref.id), name:clean(ref.name || ref.id), kind:clean(ref.kind) }))
      .filter((ref) => ref.id);
    const primaryId = workCrewId(event);
    if (primaryId && !refs.some((ref) => ref.id === primaryId)) refs.unshift({ id:primaryId, name:workCrewName(event) || primaryId, kind:clean(event.work_resource_ref?.kind || event.assigned_resource_kind) || 'resource_group' });
    return refs.filter((ref, index) => refs.findIndex((other) => other.id === ref.id) === index);
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
    const names = isProductionEvent(event) ? workAssigneeNames(event) : [];
    const label = names.length > 1 ? `${names[0]} +${names.length - 1}` : (currentAssignmentId(event) ? (workCrewName(event) || assignedLabel(event)) : 'Unassigned');
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
  /* The people on an item as { id, name } (assigned_users, else ids). */
  function eventAssignedPeople(event = {}){
    const listed = Array.isArray(event.assigned_users) && event.assigned_users.length
      ? event.assigned_users.map((user) => ({ id:clean(user?.id), name:clean(user?.name || user?.email) || userDisplayName(user?.id) }))
      : (Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : []).map((id) => ({ id:clean(id), name:userDisplayName(id) }));
    return listed.filter((user, index) => user.id && listed.findIndex((other) => other.id === user.id) === index);
  }
  /* Every crew and person on an item (ids) — the pill's picker marks them all. */
  function eventAssigneeIds(event = {}){
    return [...new Set([...eventCrewRefs(event).map((ref) => ref.id), ...eventAssignedPeople(event).map((user) => user.id)].filter(Boolean))];
  }
  async function saveAssignment(event, resourceId = ''){
    return saveAssignmentChange(event, resourceId);
  }
  // options.toggle: add/remove this one crew or person and keep the others
  // (the picker of an item with several assignees); otherwise the pick
  // replaces the whole assignment.
  async function saveAssignmentChange(event, resourceId = '', options = {}){
    const Scheduling = window.PlatformScheduling;
    if (!event?.id || isMaterialEvent(event)) return;
    closeAssignmentMenu();
    if (!canEditSchedule()) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), scheduleReadOnlyMessage(), VIEW_ONLY_TOAST);
      return;
    }
    const floating = event?.floating_event === true || String(event?.id || '').startsWith('floating_');
    // Work from the stored item, not the chip's decorated copy.
    const known = floating
      ? (floatingEvents.find((item) => String(item.id || '') === String(event.id || '')) || event)
      : (allEvents.find((item) => String(item.id || '') === String(event.id || '')) || event);
    const project = eventProject(known);
    // An assignee that is on the item but not in the pickable list (e.g. a
    // crew outside this scope) can still be removed.
    const onItem = options.toggle === true ? (eventCrewRefs(known).find((ref) => ref.id === clean(resourceId))
      || eventAssignedPeople(known).map((user) => ({ ...user, subject_type:'organization_user' })).find((user) => user.id === clean(resourceId))) : null;
    const resource = assignmentResourcesForEvent(known).find((item) => String(item.id || '') === String(resourceId || ''))
      || (onItem ? { ...onItem, resource_kind:onItem.subject_type || onItem.kind } : null);
    const userSubject = clean(resource?.subject_type || resource?.resource_kind) === 'organization_user';
    const toggle = options.toggle === true && !!resource;
    if (options.toggle === true && !resource) return;
    let toggledOff = false;
    // Toggling one assignee of a multi-assignee item keeps every other crew
    // and person; the result is written as the explicit set.
    const toggledAssignmentFor = (base = {}) => {
      const id = clean(resource.id);
      let crews = eventCrewRefs(base);
      let people = eventAssignedPeople(base);
      if (userSubject) {
        toggledOff = people.some((user) => user.id === id);
        people = toggledOff ? people.filter((user) => user.id !== id) : [...people, { id, name:clean(resource.name || resource.email || id) }];
      } else {
        toggledOff = crews.some((crew) => crew.id === id);
        crews = toggledOff ? crews.filter((crew) => crew.id !== id) : [...crews, { id, name:clean(resource.name), kind:clean(resource.work_resource_ref?.kind || resource.resource_kind || resource.subject_type) || 'resource_group' }];
      }
      return {
        ...(userSubject ? withScheduleHistory(base, toggledOff ? 'unassigned' : 'assigned') : base),
        ...assigneeSetPatch(base, crews, people),
        updated_at: new Date().toISOString()
      };
    };
    // The picked assignee replaces the whole assignment (every crew and
    // person), written as an explicit set so no old crew reference lingers.
    const assignmentFor = (base = {}) => toggle ? toggledAssignmentFor(base) : ({
      ...(userSubject ? withScheduleHistory(base, resource ? 'assigned' : 'unassigned') : base),
      ...assigneeSetPatch(
        base,
        resource && !userSubject ? [{ id:clean(resource.id), name:clean(resource.name), kind:clean(resource.work_resource_ref?.kind || resource.resource_kind || resource.subject_type) || 'resource_group' }] : [],
        resource && userSubject ? [{ id:clean(resource.id), name:clean(resource.name || resource.email || resource.id) }] : []
      ),
      ...(resource && userSubject ? { assigned_users:[{ id:clean(resource.id), name:clean(resource.name || resource.email || resource.id), role_ids:resource.role_ids || resource.roles || resource.user?.roles || [] }] } : {}),
      assignee_label: resource?.name || 'Unassigned',
      updated_at: new Date().toISOString()
    });
    if (!floating && (!Scheduling || !project?.id)) return;
    const next = assignmentFor(known);
    if (floating) updateFloatingEvent(next);
    else {
      allEvents = allEvents.map((item) => String(item.id || '') === String(known.id || '') ? { ...item, ...next } : item);
      events = visibleEvents();
    }
    patchRenderedAssignment(next);
    const revert = () => {
      if (floating) floatingEvents = [known, ...floatingEvents.filter((item) => String(item.id || '') !== String(known.id || ''))];
      else {
        allEvents = allEvents.map((item) => String(item.id || '') === String(known.id || '') ? known : item);
        events = visibleEvents();
      }
      patchRenderedAssignment(event);
    };
    try {
      // Re-read first: only the assignment is written, on top of whatever is
      // stored now; an assignment changed elsewhere refuses the save.
      const check = await checkStoredScheduleEvent(known, ['assignment']);
      if (check.conflict) throw staleScheduleError();
      const payload = check.fresh ? assignmentFor(floating ? decorateFloatingEvent(check.fresh) : check.fresh) : next;
      if (floating) {
        const saved = await persistFloatingEvent(updateFloatingEvent(payload));
        updateFloatingEvent({ ...payload, ...(saved || {}) });
      } else {
        const saved = await Scheduling.saveProjectEvent(orgId(), project, payload, schedulingConfig);
        updateLocalCalendarEvent(known.id, saved?.event || payload);
        events = visibleEvents();
      }
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_2926f24620d13c","Assignment updated") ?? "Assignment updated"), toggle ? `${resource.name} ${toggledOff ? 'was removed' : 'was added'}.` : (resource ? `${resource.name} is assigned.` : 'The item is unassigned.'), true);
    } catch (error) {
      revert();
      if (isStaleSaveError(error)) {
        await reloadAfterStaleChange(error);
        return;
      }
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_d916f201614a78","Assignment failed") ?? "Assignment failed"), scheduleSaveErrorMessage(error, 'Could not update the assignment.'), false);
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
  // onSelect lets an unsaved placement draft pick its assignee without saving.
  function openAssignmentMenu(event, anchor, onSelect = null){
    if (!event?.id || !anchor) return;
    if (assignmentMenuEventId && String(assignmentMenuEventId) === String(event.id || '') && document.querySelector('.dash-assignee-popover')) {
      closeAssignmentMenu();
      return;
    }
    closeAssignmentMenu();
    // A chip keeps the copy it was rendered with; an earlier pick from this
    // menu already changed the stored item, so read the assignment from it.
    if (typeof onSelect !== 'function') {
      const eventId = String(event.id || '');
      const stored = (event.floating_event === true || eventId.startsWith('floating_') ? floatingEvents : allEvents).find((item) => String(item.id || '') === eventId);
      if (stored) event = { ...event, ...stored };
    }
    assignmentMenuEventId = String(event.id || '');
    const currentId = currentAssignmentId(event);
    // Work items list crews first, other items people first; each group
    // alphabetical (same order as the editor's Add menu).
    const crewsFirst = isProductionEvent(event);
    const isPerson = (resource) => clean(resource.subject_type || resource.resource_kind) === 'organization_user';
    const resources = assignmentResourcesForEvent(event).slice()
      .sort((a, b) => ((isPerson(a) === crewsFirst ? 1 : 0) - (isPerson(b) === crewsFirst ? 1 : 0)) || clean(a.name).localeCompare(clean(b.name), undefined, { sensitivity:'base' }));
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'dash-assignee-popover';
    menu.style.left = `${Math.min(window.innerWidth - 236, Math.max(8, rect.left))}px`;
    menu.style.top = `${Math.max(8, rect.bottom + 8)}px`;
    menu.style.maxHeight = `${Math.max(72, window.innerHeight - rect.bottom - 16)}px`;
    // The chip's hover tooltip would sit over the menu.
    window.PlatformUI?.hideTooltip?.();
    // An item with several crews/people shows every one of them selected;
    // a pick adds or removes that one and keeps the rest.
    const assignedIds = typeof onSelect === 'function' || isMaterialEvent(event) ? [] : eventAssigneeIds(event);
    const multi = assignedIds.length > 1;
    const option = (id, label) => {
      const conflict = assignmentHasConflict(event, id);
      const selected = multi ? assignedIds.includes(String(id || '')) : String(currentId || '') === String(id || '');
      const checkable = multi && id;
      return `<button type="button" class="dash-assignee-option ${selected ? 'active' : ''} ${conflict ? 'warn' : ''}" data-assign-resource="${escapeHtml(id || '')}"${checkable ? ` role="menuitemcheckbox" aria-checked="${selected ? 'true' : 'false'}"` : ''}>
        ${checkable ? `<i class="${selected ? 'fas fa-square-check' : 'far fa-square'} dash-assignee-check" aria-hidden="true"></i>` : ''}<span>${escapeHtml(label)}</span>${conflict ? ("<i class=\"fas fa-triangle-exclamation\" title=\"" + (globalThis.PlatformLanguage?.htmlText("scheduling","m_ba1a70707ee55c","Potential conflict") ?? "Potential conflict") + "\"></i>") : ''}
      </button>`;
    };
    const multiHead = multi ? `<div class="dash-assignee-head">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_assignee_toggle_hint","Pick to add or remove") ?? "Pick to add or remove")}</div>` : '';
    const offList = multi
      ? [...eventCrewRefs(event), ...eventAssignedPeople(event)].filter((item) => !resources.some((resource) => String(resource.id || '') === item.id))
      : [];
    menu.innerHTML = `${multiHead}${option('', multi ? 'Unassign all' : 'Unassigned')}${offList.map((item) => option(item.id, item.name || item.id)).join('')}${resources.map((resource) => option(resource.id, resource.name)).join('')}`;
    menu.querySelectorAll('[data-assign-resource]').forEach((btn) => btn.addEventListener('click', (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      if (typeof onSelect === 'function') {
        closeAssignmentMenu();
        onSelect(resources.find((resource) => String(resource.id || '') === String(btn.dataset.assignResource || '')) || null);
        return;
      }
      saveAssignmentChange(event, btn.dataset.assignResource || '', { toggle:multi && !!btn.dataset.assignResource });
    }));
    document.body.appendChild(menu);
    // Open upward when the list doesn't fit below the chip and there is
    // more room above (bottom-row chips).
    // Upward it stops at the top of Scheduling, never under the app's top bar.
    const topLimit = Math.max(8, Math.round(rootEl?.getBoundingClientRect?.().top || 0) + 4);
    const spaceBelow = window.innerHeight - rect.bottom - 16;
    const spaceAbove = rect.top - 8 - topLimit;
    const contentHeight = menu.scrollHeight;
    if (contentHeight > spaceBelow && spaceAbove > spaceBelow) {
      const height = Math.min(contentHeight, spaceAbove);
      menu.style.maxHeight = `${Math.max(72, spaceAbove)}px`;
      menu.style.top = `${Math.max(topLimit, rect.top - 8 - height)}px`;
      menu.classList.add('above');
    }
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
  /* Why a unit is taken during the event: "Reserved until …", "In
   * maintenance until …", or a generic booking note. */
  function equipmentUnitBookingNote(event, unitId){
    const Scheduling = window.PlatformScheduling;
    const generic = (globalThis.PlatformLanguage?.text("scheduling","m_c71ee644be52a3","Booked elsewhere in this window") ?? "Booked elsewhere in this window");
    if (!Scheduling?.availabilityForEquipment || !eventStart(event)) return generic;
    const availability = Scheduling.availabilityForEquipment({
      units: equipmentUnits.filter((unit) => clean(unit.id) === clean(unitId)),
      events: [...allEvents, ...floatingEvents.filter((item) => (isVehicleBooking(item) ? eventIsScheduled(item) : !floatingEventIsDisposableDraft(item)))],
      start: eventStart(event),
      end: eventEnd(event),
      excludeEventId: clean(event.id)
    });
    const bookings = availability.units[0]?.bookings || [];
    if (!bookings.length) return generic;
    const untilOf = (booking) => {
      const ref = eventEquipRefs(booking).find((item) => clean(item.id) === clean(unitId));
      return validDate(ref?.end_at) || eventEnd(booking);
    };
    const describe = (booking) => {
      const until = untilOf(booking);
      const allDay = booking.all_day === true || clean(booking.schedule_granularity) === 'date';
      // An all-day window ends at midnight: name its last day.
      const shown = until && allDay ? new Date(until.getTime() - 1) : until;
      return shown ? shown.toLocaleString([], allDay ? { month:'short', day:'numeric' } : { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';
    };
    const kindOf = (booking) => {
      const kind = eventKind(booking);
      const type = eventTypeId(booking);
      if (kind === 'equipment_maintenance' || type === 'equipment_maintenance') return 'maintenance';
      if (['equipment_reservation', 'equipment_booking'].includes(kind) || ['equipment_reservation', 'equipment_booking'].includes(type) || isVehicleBooking(booking)) return 'reserved';
      return 'booked';
    };
    const booking = bookings.find((item) => kindOf(item) === 'maintenance') || bookings.find((item) => kindOf(item) === 'reserved') || bookings[0];
    const until = describe(booking);
    const kind = kindOf(booking);
    if (kind === 'maintenance') return until ? `In maintenance until ${until}` : 'In maintenance';
    // Another crew's vehicle booking names that crew.
    if (isVehicleBooking(booking)) {
      const crew = clean(booking.vehicle_crew_name) || clean(workforceResources.find((resource) => clean(resource.id) === clean(booking.vehicle_crew_id))?.name);
      if (crew) return until ? `Booked by ${crew} until ${until}` : `Booked by ${crew}`;
    }
    if (kind === 'reserved') return until ? `Reserved until ${until}` : 'Reserved';
    const title = clean(booking.title);
    return title ? `Booked: ${title}${until ? ` (until ${until})` : ''}` : generic;
  }
  function equipmentUnitConflict(event, unitId){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling?.availabilityForEquipment || !eventStart(event)) return false;
    // Company calendar items (equipment reservations, maintenance windows,
    // vehicle bookings) hold units too, not only project events.
    const availability = Scheduling.availabilityForEquipment({
      units: equipmentUnits.filter((unit) => clean(unit.id) === clean(unitId)),
      // Saved vehicle bookings always hold their unit (older ones were stored
      // with a leftover draft flag).
      events: [...allEvents, ...floatingEvents.filter((item) => (isVehicleBooking(item) ? eventIsScheduled(item) : !floatingEventIsDisposableDraft(item)))],
      start: eventStart(event),
      end: eventEnd(event),
      excludeEventId: clean(event.id)
    });
    // Only real bookings count here; a unit's down/retired state is judged
    // against the event's own window by equipmentDownDetail().
    return availability.units.some((unit) => Array.isArray(unit.bookings) ? unit.bookings.length > 0 : !unit.available);
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
  function equipmentUnitDown(unit){
    return ['down', 'retired'].includes(clean(unit?.status).toLowerCase());
  }
  function equipmentTypeLabel(unit = {}, type = null){
    const typeId = clean(unit?.type_id);
    const candidates = [type?.name, unit?.type_name].map(clean).filter((value) => value && value !== typeId);
    if (candidates.length) return candidates[0];
    return typeId ? typeId.replace(/^eqt_/, '').replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase()) : 'Equipment';
  }
  /* The unit's known out-of-service windows (maintenance calendar items that
   * reference it), latest first. */
  function equipmentUnitMaintenanceWindows(unit, excludeEventId = ''){
    const id = clean(unit?.id);
    if (!id) return [];
    return floatingEvents
      .filter((item) => !['cancelled', 'canceled'].includes(clean(item.status).toLowerCase()))
      .filter((item) => clean(item.id) !== clean(excludeEventId))
      .filter((item) => isEquipmentWindowEvent(item) && (eventKind(item) === 'equipment_maintenance' || eventTypeId(item) === 'equipment_maintenance'))
      .filter((item) => eventEquipRefs(item).some((ref) => clean(ref.id) === id))
      .map((item) => ({ start:eventStart(item), end:eventEnd(item), title:clean(item.title) }))
      .filter((item) => item.end)
      .sort((a, b) => b.end - a.end);
  }
  function equipmentUnitMaintenanceWindow(unit){
    return equipmentUnitMaintenanceWindows(unit)[0] || null;
  }
  /* Down/retired units for the event's own window. A unit that is down
   * because of a scheduled maintenance window is only out of service during
   * that window: an event entirely before or after it can book the unit
   * (the server checks the windows the same way). The server rejects
   * bookings of an out-of-service unit when the company blocks equipment
   * conflicts, so the picker never offers "Assign anyway" in that mode. */
  function equipmentDownDetail(unit, draft = {}){
    if (!equipmentUnitDown(unit)) return null;
    const retired = clean(unit?.status).toLowerCase() === 'retired';
    // A maintenance item never counts as a booking of its own unit.
    const windows = retired ? [] : equipmentUnitMaintenanceWindows(unit, isEquipmentWindowEvent(draft) ? draft.id : '');
    if (!retired && isEquipmentWindowEvent(draft) && eventEquipRefs(draft).some((ref) => clean(ref.id) === clean(unit?.id)) && !windows.length) return null;
    const eventStartAt = eventStart(draft);
    const eventEndAt = eventEnd(draft) || eventStartAt;
    if (!retired && windows.length && eventStartAt && eventEndAt) {
      const overlapping = windows.find((item) => (item.start || item.end) < eventEndAt && item.end > eventStartAt);
      // Outside every known window the "down" badge does not apply here.
      if (!overlapping) return null;
      const until = overlapping.end.toLocaleDateString([], { month:'short', day:'numeric' });
      return {
        label:`Down until ${until}`,
        reason:`${unit.name || unit.id} is down for service until ${until}, during this event.`,
        blocked:equipmentConflictMode === 'block'
      };
    }
    const maintenance = windows[0] || null;
    const until = maintenance?.end ? maintenance.end.toLocaleDateString([], { month:'short', day:'numeric' }) : '';
    const label = retired ? 'Retired' : (until ? `Down until ${until}` : 'Down for service');
    const reason = retired
      ? `${unit.name || unit.id} is retired and can't be booked.`
      : `${unit.name || unit.id} is down for service${until ? ` until ${until}` : ''}.`;
    return { label, reason, blocked:equipmentConflictMode === 'block' || retired };
  }
  /* Font Awesome class for a unit: its own icon, else its type's, when the
   * loaded icon font has it; otherwise a generic truck / toolbox (an icon the
   * font lacks would leave an empty gap). */
  function equipmentIconClass(unit = null, type = null){
    const unitType = type || (unit ? equipmentTypes.find((item) => clean(item.id) === clean(unit.type_id)) : null);
    const fallback = clean(unitType?.kind || unit?.type_kind).toLowerCase() === 'vehicle' || !unit ? 'fa-truck-pickup' : 'fa-toolbox';
    const candidate = [clean(unit?.icon), clean(unitType?.icon)].find((value) => /^fa-[a-z0-9-]+$/.test(value) && fontIconAvailable(value));
    return candidate || fallback;
  }
  function fontIconAvailable(name = ''){
    const cache = fontIconAvailable.cache || (fontIconAvailable.cache = new Map());
    if (cache.has(name)) return cache.get(name);
    if (!document.body || typeof getComputedStyle !== 'function') return true;
    const probe = (cls) => {
      const node = document.createElement('i');
      node.className = `fas ${cls}`;
      node.setAttribute('aria-hidden', 'true');
      node.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden';
      document.body.appendChild(node);
      const content = getComputedStyle(node, '::before').content;
      node.remove();
      return !!content && !['none', 'normal', '""', "''"].includes(content);
    };
    // Until the icon font's CSS is loaded nothing can be told: keep the icon.
    if (!probe('fa-truck')) return true;
    const available = probe(name);
    cache.set(name, available);
    return available;
  }
  function eventEquipmentSectionHtml(ctx, draft, project){
    if (!equipmentSchedulingOn()) return '';
    const delivery = isMaterialEvent(draft) || eventTypeId(draft) === 'delivery';
    if (delivery && !eventAdvancedOpen) return '';
    const refs = eventEquipRefs(draft);
    const assignedIds = new Set(refs.map((ref) => clean(ref.id)));
    // A vehicle booking, reservation or maintenance window is about its own
    // unit: that unit can't be removed or swapped here (a booking with no
    // vehicle would look booked while freeing the truck). Book another
    // vehicle from the Vehicles bank / lane instead.
    const ownUnitWindow = isEquipmentWindowEvent(draft);
    const options = ownUnitWindow ? [] : equipmentUnits.filter((unit) => !assignedIds.has(clean(unit.id)));
    const chips = refs.map((ref) => {
      const unit = equipmentUnits.find((item) => clean(item.id) === clean(ref.id)) || null;
      const conflicted = ref.kind === 'equipment_unit' && equipmentUnitConflict(draft, ref.id);
      const downDetail = equipmentDownDetail(unit, draft);
      const type = unit ? equipmentTypes.find((item) => clean(item.id) === clean(unit.type_id)) : null;
      return `<span class="dash-event-equipment-chip ${String(downDetail ? 'down' : conflicted ? 'warn' : '')}" ${downDetail ? `title="${escapeHtml(downDetail.reason)}"` : ''}>
        <i class="fas ${String(escapeHtml(equipmentIconClass(unit, type)))}"></i>
        <span class="dash-equipment-name">${String(escapeHtml(ref.name || unit?.name || ref.id))}</span>${downDetail ? `<small>${escapeHtml(downDetail.label)}</small>` : ''}
        ${String(conflicted ? `<i class="fas fa-triangle-exclamation" title="${escapeHtml(equipmentUnitBookingNote(draft, ref.id))}"></i>` : '')}
        ${ownUnitWindow ? '' : `<button type="button" data-event-equipment-remove="${String(escapeHtml(ref.id))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_e6c8bec001e544","Remove equipment") ?? "Remove equipment")}"><i class="fas fa-xmark"></i></button>`}
      </span>`;
    }).join('');
    if (ownUnitWindow) {
      const note = isVehicleBooking(draft)
        ? 'This booking is for this vehicle. To use a different vehicle, delete this booking and book the other one from the Vehicles bank in Routing.'
        : 'This window is for this unit. To cover another unit, create a separate window for it.';
      return `<div class="dash-event-equipment" data-event-equipment>
      <div class="dash-event-equipment-head"><i class="fas fa-truck-pickup"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_00ec8ace19ba71"," Equipment") ?? " Equipment")}</div>
      <div class="dash-event-equipment-chips">${String(chips || `<span class="dash-event-equipment-empty">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_e97309f102e999","No equipment on this event.") ?? "No equipment on this event.")}</span>`)}</div>
      <div class="dash-event-advanced-note" data-event-equipment-locked>${escapeHtml(note)}</div>
    </div>`;
    }
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
      ${String(options.length ? `<details class="dash-equipment-picker" data-equipment-picker>
        <summary class="dash-event-equipment-add"><i class="fas fa-plus" aria-hidden="true"></i>Add equipment…<i class="fas fa-chevron-down" aria-hidden="true"></i></summary>
        <div class="dash-equipment-options" role="group" aria-label="Equipment to assign">${options.map((unit) => {
          const type = equipmentTypes.find((item) => clean(item.id) === clean(unit.type_id));
          const downDetail = equipmentDownDetail(unit, draft);
          const down = !!downDetail;
          const conflicted = !down && equipmentUnitConflict(draft, unit.id);
          // In "block" mode the server rejects these bookings outright, so
          // they are listed (with the reason) but can't be picked.
          const blocked = (down && downDetail.blocked) || (conflicted && equipmentConflictMode === 'block' && type?.allow_double_booking !== true);
          const note = down ? downDetail.label : (conflicted ? equipmentUnitBookingNote(draft, unit.id) : '');
          return `<button type="button" class="dash-equipment-option ${down ? 'down' : ''}" data-event-equipment-add="${escapeHtml(unit.id)}" ${blocked ? `disabled aria-disabled="true" title="${escapeHtml(down ? downDetail.reason : `${note}. This unit can't be booked during this window.`)}"` : ''}><i class="fas ${escapeHtml(equipmentIconClass(unit, type))}" aria-hidden="true"></i><span><strong>${escapeHtml(unit.name || unit.id)}</strong><small>${escapeHtml(equipmentTypeLabel(unit, type))}${note ? ` · ${escapeHtml(note)}` : ''}${blocked ? ' · Unavailable' : ''}</small></span></button>`;
        }).join('')}</div>
        <div class="dash-equipment-confirm" data-equipment-warning hidden role="alert"><p data-equipment-warning-text></p><button type="button" data-equipment-cancel>Cancel</button><button type="button" data-equipment-confirm>Assign anyway</button></div>
      </details>` : '')}
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
    const picker = section.querySelector('[data-equipment-picker]');
    // The opened list scrolls into view above the editor's sticky footer.
    picker?.addEventListener('toggle', () => {
      if (!picker.open) return;
      requestAnimationFrame(() => {
        const pop = picker.closest('.dash-event-popover');
        if (!pop) return;
        const footer = pop.querySelector('.dash-event-pop-actions');
        const popRect = pop.getBoundingClientRect();
        const rect = picker.getBoundingClientRect();
        const visibleBottom = popRect.bottom - (footer?.offsetHeight || 0) - 8;
        const overflow = rect.bottom - visibleBottom;
        if (overflow > 0) pop.scrollTop += Math.min(overflow, Math.max(0, rect.top - popRect.top - 8));
      });
    });
    const warning = section.querySelector('[data-equipment-warning]');
    let pendingUnit = null;
    let pendingButton = null;
    const resetWarning = () => {
      pendingUnit = null;
      if (warning) warning.hidden = true;
      const options = section.querySelector('.dash-equipment-options');
      if (options) options.hidden = false;
    };
    const assignUnit = (unit) => {
      const id = clean(unit.id);
      const current = eventEditorContext()?.event || draft;
      const otherRefs = (Array.isArray(current.resource_refs) ? current.resource_refs : []).filter((ref) => !(clean(ref?.kind) === 'equipment_unit' && clean(ref?.id) === id));
      applyEditorPatch({ resource_refs: [
        ...otherRefs,
        { kind: 'equipment_unit', id, name: clean(unit.name) || id, role: 'equipment', start_at:eventStart(current)?.toISOString?.() || '', end_at:eventEnd(current)?.toISOString?.() || '' }
      ] });
      resetWarning();
      setTimeout(() => {
        renderEventDraftPopover(editorAnchorFor(current.id));
        document.querySelector('[data-equipment-picker] summary')?.focus();
      }, 0);
    };
    section.querySelectorAll('[data-event-equipment-add]').forEach((button) => button.addEventListener('click', () => {
      const unit = equipmentUnits.find((item) => clean(item.id) === clean(button.dataset.eventEquipmentAdd));
      if (!unit) return;
      if (!equipmentDownDetail(unit, eventEditorContext()?.event || draft)) return assignUnit(unit);
      pendingUnit = unit;
      pendingButton = button;
      section.querySelector('[data-equipment-warning-text]').textContent = `${equipmentDownDetail(unit, eventEditorContext()?.event || draft)?.reason || `${unit.name || unit.id} is down.`} Are you sure you want to assign this equipment to the event?`;
      warning.hidden = false;
      section.querySelector('[data-equipment-cancel]').focus();
      section.querySelector('.dash-equipment-options').hidden = true;
    }));
    section.querySelector('[data-equipment-confirm]')?.addEventListener('click', () => {
      if (pendingUnit) assignUnit(pendingUnit);
    });
    section.querySelector('[data-equipment-cancel]')?.addEventListener('click', () => {
      section.querySelector('.dash-equipment-options').hidden = false;
      pendingButton?.focus();
      resetWarning();
    });
    picker?.addEventListener('toggle', () => { if (!picker.open) resetWarning(); });
    picker?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      resetWarning();
      picker.open = false;
      picker.querySelector('summary')?.focus();
    });
    picker?.addEventListener('focusout', (event) => {
      if (event.relatedTarget && !picker.contains(event.relatedTarget)) { picker.open = false; resetWarning(); }
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
    stageEditorEdit(current, undo.snapshot);
    eventDraftProjectUndo = null;
    eventDraftProjectQuery = '';
    if (!editorUsesDraftCopy(current)) render();
    setTimeout(() => renderEventDraftPopover(editorAnchorFor(current.event.id)), 0);
    return true;
  }
  function floatingEventIsDisposableDraft(event = {}){
    return event?.__draft === true || clean(event?.status).toLowerCase() === 'draft';
  }
  function editorUsesDraftCopy(ctx){
    return !!ctx && (ctx.editorOnly === true || (ctx.kind === 'floating' && !floatingEventIsDisposableDraft(ctx.event)));
  }
  /* The editor context with any unsaved edits layered over the stored event. */
  function eventEditorContext(){
    const ctx = baseEventEditorContext();
    if (!ctx || !eventEditorDraft || !editorUsesDraftCopy(ctx)) return ctx;
    if (String(eventEditorDraft.id || '') !== String(ctx.event?.id || '')) return ctx;
    const event = { ...ctx.event, ...eventEditorDraft.patch };
    if (ctx.kind !== 'floating') return { ...ctx, event, dirty:true };
    const project = event.project_id ? (projects.find((item) => String(item.id || '') === String(event.project_id || '')) || {}) : {};
    return { ...ctx, event:decorateFloatingEvent(event), project, dirty:true };
  }
  /* Route an editor edit: persisted events collect it on the draft copy; a
   * brand-new floating draft (discarded on cancel anyway) updates in place so
   * its calendar chip follows the editor. */
  function stageEditorEdit(ctx, patch = {}){
    const id = String(ctx?.event?.id || '');
    if (!id) return;
    if (ctx.kind === 'floating' && !editorUsesDraftCopy(ctx)) {
      updateFloatingEvent({ ...ctx.event, ...patch });
      return;
    }
    const previous = eventEditorDraft && String(eventEditorDraft.id || '') === id ? eventEditorDraft.patch : {};
    eventEditorDraft = { id, patch:{ ...previous, ...patch } };
  }
  // With an id, only that item's pending edits go: a save that finishes after
  // the user already opened another item leaves the new editor alone.
  function discardEventEditorDraft(eventId = ''){
    if (eventId && eventEditorDraft && String(eventEditorDraft.id || '') !== String(eventId)) return;
    eventEditorDraft = null;
  }
  /* True while the editor still shows `eventId` (or nothing at all): only
   * then may a finished save close it and clear its placement. */
  function editorStillShows(eventId = ''){
    const id = String(eventId || '');
    const open = String(eventEditorEventId || eventDraftPopoverId || '');
    return !open || open === id;
  }
  function baseEventEditorContext(){
    const floating = floatingEvents.find((event) => String(event.id || '') === String(eventDraftPopoverId || ''));
    if (floating) return { kind: 'floating', event: floating, project: floating.project_id ? (projects.find((project) => String(project.id || '') === String(floating.project_id || '')) || {}) : {} };
    const selectedEditorEvent = eventEditorEventId
      ? (eventCalendarItems().find((event) => String(event.id || '') === String(eventEditorEventId || ''))
        || allEvents.find((event) => String(event.id || '') === String(eventEditorEventId || '')))
      : null;
    if (selectedEditorEvent) {
      const project = eventProject(selectedEditorEvent || {});
      if (isProductionEvent(selectedEditorEvent) || isProjectSection(selectedEditorEvent)) {
        // Keep the item's own type (sections, custom work types); only
        // untyped production rows read as generic work.
        const typeId = eventTypeId(selectedEditorEvent) || 'project_work';
        return { kind: 'production', editorOnly: true, event: { ...selectedEditorEvent, event_type_default_id: typeId, type_id: typeId }, project };
      }
      if (isMaterialEvent(selectedEditorEvent)) {
        return { kind: 'materials', editorOnly: true, event: selectedEditorEvent, project };
      }
      // Sales appointments, follow-ups and custom project meetings keep their
      // real type so the editor labels them correctly.
      const salesLike = isSalesEvent(selectedEditorEvent) || isSalesFollowUpEvent(selectedEditorEvent);
      const typeId = eventTypeId(selectedEditorEvent) || (salesLike ? eventKind(selectedEditorEvent) : '') || 'sales_appointment';
      return { kind: salesLike ? 'sales' : 'appointment', editorOnly: true, event: { ...selectedEditorEvent, event_type_default_id: typeId, type_id: typeId }, project };
    }
    const placementKind = selectedPlacementKind() || scheduleMode;
    if (placementKind === 'materials') {
      const event = selectedMaterialEvent();
      const project = selectedMaterialProject() || eventProject(event || {});
      // start_at/end_at are rebuilt from start/end so a drag after an
      // editor edit shows the new dates when the editor reopens.
      const draft = draftWithIsoRange(materialScheduleDraft) || (event ? selectedEventCalendarDraft() : null);
      if (event?.id) return { kind: 'materials', event: { ...event, ...(draft || {}) }, project };
    } else if (placementKind === 'production') {
      const event = selectedProductionEvent();
      const project = selectedProductionProject() || eventProject(event || {});
      const draft = draftWithIsoRange(productionScheduleDraft) || (event ? selectedEventCalendarDraft() : null) || { id: '__production_event_draft', title: projectWorkTitle(project), project_id: project?.id || '', project_title: projectTitle(project), project_address: projectAddress(project || {}, {}), description: '' };
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
    return rootEl?.querySelector(`[data-prs-event-id="${escaped}"]`)
      || rootEl?.querySelector(`[data-psv-gantt-bar="${escaped}"]`)
      || rootEl?.querySelector(`[data-psv-gantt-open="${escaped}"]`);
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
    if (ctx.kind === 'floating' || ctx.editorOnly) stageEditorEdit(ctx, { description: value, notes: value });
    else if (ctx.kind === 'materials') materialScheduleDraft = { ...(materialScheduleDraft || ctx.event || {}), description: value, notes: value };
    else if (ctx.kind === 'production') productionScheduleDraft = { ...(productionScheduleDraft || ctx.event || {}), description: value, notes: value };
    else appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), description: value, notes: value };
    placementDraftEdited(ctx, { description: value });
  }
  function updateEditorTitle(value = ''){
    // An emptied title stays empty on the draft; Save asks for one instead of
    // silently storing a placeholder.
    const title = clean(value);
    const ctx = eventEditorContext();
    if (!ctx) return;
    if (ctx.kind === 'floating') stageEditorEdit(ctx, { title, project_title: ctx.event.project_id ? ctx.event.project_title : '', title_is_custom: !!title });
    else if (ctx.editorOnly) stageEditorEdit(ctx, { title, title_is_custom: !!title });
    // A placement draft keeps its project name: only the item title changes
    // (it shows on the draft chip and banner at once).
    else if (ctx.kind === 'materials') materialScheduleDraft = { ...(materialScheduleDraft || ctx.event || {}), title, title_is_custom: true };
    else if (ctx.kind === 'production') productionScheduleDraft = { ...(productionScheduleDraft || ctx.event || {}), title, title_is_custom: true };
    else appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), title, title_is_custom: true };
    placementDraftEdited(ctx, { title });
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
    let nextValue = dateOnly
      ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      : validDate(value);
    if (!nextValue) return false;
    // All-day End is shown as the last included day; storage keeps the
    // exclusive midnight boundary after it.
    if (allDay && which === 'end') nextValue = addDays(nextValue, 1);
    const previousStart = eventStart(current) || new Date();
    const previousEnd = eventEnd(current) || new Date(previousStart.getTime() + (allDay ? 86400000 : 3600000));
    let start = which === 'start' ? nextValue : previousStart;
    let end = which === 'end' ? nextValue : previousEnd;
    const minimumDuration = allDay ? 86400000 : 15 * 60000;
    const previousDuration = Math.max(minimumDuration, previousEnd.getTime() - previousStart.getTime());
    // Moving Start keeps the length (like dragging the item); an End before
    // Start moves the item so it ends there, still keeping its length.
    const previousDays = Math.max(1, Math.round(previousDuration / 86400000));
    if (which === 'start') end = allDay ? addDays(start, previousDays) : new Date(start.getTime() + previousDuration);
    if (which === 'end' && end <= start) start = allDay ? addDays(end, -previousDays) : new Date(end.getTime() - previousDuration);
    const patch = {
      start,
      end,
      start_at:start.toISOString(),
      end_at:end.toISOString(),
      all_day:allDay,
      schedule_granularity:allDay ? 'date' : 'time',
      ...equipmentWindowPatch(current, { start:previousStart, end:previousEnd }, { start, end })
    };
    if (ctx.kind === 'floating' || ctx.editorOnly) stageEditorEdit(ctx, patch);
    else if (ctx.kind === 'materials') materialScheduleDraft = { ...(materialScheduleDraft || current), ...patch };
    else if (ctx.kind === 'production') productionScheduleDraft = { ...(productionScheduleDraft || current), ...patch };
    else appointmentScheduleDraft = { ...(appointmentScheduleDraft || current), ...patch };
    placementDraftEdited(ctx, patch);
    return true;
  }
  /* Equipment usage windows ride along when the event's time changes: a
   * window that matched the event's start/end follows it exactly, a custom
   * window keeps its offset. Otherwise the server would still hold (and check
   * conflicts against) the unit on the old dates. -> { resource_refs } or {} */
  function equipmentWindowPatch(event = {}, previous = {}, next = {}){
    const refs = Array.isArray(event?.resource_refs) ? event.resource_refs : [];
    const windowed = refs.some((ref) => ['equipment_unit', 'equipment_type'].includes(clean(ref?.kind)) && (clean(ref?.start_at) || clean(ref?.end_at)));
    if (!windowed) return {};
    const helper = window.PlatformScheduling?.shiftEquipmentWindows;
    if (typeof helper === 'function') {
      const shifted = helper(event, previous, next);
      const list = Array.isArray(shifted) ? shifted : shifted?.resource_refs;
      if (Array.isArray(list)) return { resource_refs:list };
    }
    const prevStart = validDate(previous.start);
    const prevEnd = validDate(previous.end);
    const nextStart = validDate(next.start);
    const nextEnd = validDate(next.end);
    if (!prevStart || !nextStart) return {};
    const delta = nextStart.getTime() - prevStart.getTime();
    return { resource_refs:refs.map((ref) => {
      if (!['equipment_unit', 'equipment_type'].includes(clean(ref?.kind))) return ref;
      const refStart = validDate(ref.start_at);
      const refEnd = validDate(ref.end_at);
      if (!refStart && !refEnd) return ref;
      const start = !refStart || refStart.getTime() === prevStart.getTime() ? nextStart : new Date(refStart.getTime() + delta);
      let end = nextEnd && (!refEnd || (prevEnd && refEnd.getTime() === prevEnd.getTime())) ? nextEnd : new Date((refEnd || prevEnd || prevStart).getTime() + delta);
      if (end <= start) end = nextEnd && nextEnd > start ? nextEnd : new Date(start.getTime() + 3600000);
      return { ...ref, start_at:start.toISOString(), end_at:end.toISOString() };
    }) };
  }
  /* Redraw the editor's equipment list so conflict/down states follow a time
   * change without rebuilding (and refocusing) the whole editor. */
  function refreshEditorEquipmentSection(pop){
    const section = pop?.querySelector?.('[data-event-equipment]');
    const ctx = eventEditorContext();
    if (!section || !ctx?.event) return;
    const openPicker = !!section.querySelector('[data-equipment-picker][open]');
    const holder = document.createElement('div');
    holder.innerHTML = eventEquipmentSectionHtml(ctx, ctx.event, ctx.project || {});
    const next = holder.firstElementChild;
    if (!next) return;
    section.replaceWith(next);
    if (openPicker) next.querySelector('[data-equipment-picker]')?.setAttribute('open', '');
    bindEventEquipmentSection(pop, ctx.event);
    if (pop.classList.contains('read-only')) {
      next.querySelectorAll('input,textarea,select,button').forEach((field) => { field.disabled = true; });
      next.querySelectorAll('[data-equipment-picker]').forEach((picker) => { picker.hidden = true; });
    }
  }
  /* Keep the editor's time fields and summary line in step with the draft
   * after an edit (the stored end can move when Start moves past it). */
  function syncEditorTimeFields(pop){
    const current = eventEditorContext()?.event;
    if (!pop || !current) return;
    const allDay = current.all_day === true || clean(current.schedule_granularity).toLowerCase() === 'date';
    const format = allDay ? dateInputValue : dateTimeLocalValue;
    const startInput = pop.querySelector('[data-event-start]');
    const endInput = pop.querySelector('[data-event-end]');
    if (startInput) startInput.value = format(eventStart(current));
    if (endInput) endInput.value = format(editorDisplayEnd(current));
    const line = pop.querySelector('.dash-event-pop-time');
    if (line) line.textContent = formatEventDraftTime(current);
    refreshEditorEquipmentSection(pop);
  }
  /* All-day items store an exclusive end (midnight after the last day); the
   * editor shows the last included day. */
  function editorDisplayEnd(event = {}){
    const end = eventEnd(event);
    const allDay = event?.all_day === true || clean(event?.schedule_granularity).toLowerCase() === 'date';
    if (!allDay || !end) return end;
    const start = eventStart(event);
    const atMidnight = end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0;
    const inclusive = atMidnight ? addDays(end, -1) : end;
    return start && inclusive < start ? start : inclusive;
  }
  /* Stage a patch onto whatever the event editor is currently editing —
   * same dispatch the title/range/customer setters use. */
  function applyEditorPatch(patch = {}){
    const ctx = eventEditorContext();
    if (!ctx) return null;
    if (ctx.kind === 'floating' || ctx.editorOnly) stageEditorEdit(ctx, patch);
    else if (ctx.kind === 'materials') materialScheduleDraft = { ...(materialScheduleDraft || ctx.event || {}), ...patch };
    else if (ctx.kind === 'production') productionScheduleDraft = { ...(productionScheduleDraft || ctx.event || {}), ...patch };
    else appointmentScheduleDraft = { ...(appointmentScheduleDraft || ctx.event || {}), ...patch };
    placementDraftEdited(ctx, patch);
    return ctx;
  }
  function updateEditorAllDay(nextAllDay = true){
    const current = eventEditorContext()?.event;
    if (!current) return;
    const start = eventStart(current) || new Date();
    const currentId = String(current.id || '');
    const wasTimed = current.all_day !== true && clean(current.schedule_granularity) !== 'date';
    let patch;
    if (nextAllDay) {
      // Remember the times so turning All day off again restores them.
      if (wasTimed) updateEditorAllDay.remembered = { id:currentId, minutes:start.getHours() * 60 + start.getMinutes(), duration:Math.round(((eventEnd(current) || start).getTime() - start.getTime()) / 60000) };
      const dayStart = startOfDay(start) || start;
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      patch = { start:dayStart, end:dayEnd, start_at:dayStart.toISOString(), end_at:dayEnd.toISOString(), all_day:true, schedule_granularity:'date' };
    } else {
      const remembered = updateEditorAllDay.remembered?.id === currentId ? updateEditorAllDay.remembered : null;
      const timedStart = new Date(start);
      if (remembered) timedStart.setHours(Math.floor(remembered.minutes / 60), remembered.minutes % 60, 0, 0);
      else timedStart.setHours(9, 0, 0, 0);
      const duration = remembered ? Math.max(15, remembered.duration) : Math.max(15, Number(schedulingConfig?.event_types?.[eventTypeId(current)]?.duration_minutes || 60));
      const timedEnd = new Date(timedStart.getTime() + duration * 60000);
      patch = { start:timedStart, end:timedEnd, start_at:timedStart.toISOString(), end_at:timedEnd.toISOString(), all_day:false, schedule_granularity:'time' };
    }
    applyEditorPatch({ ...patch, ...equipmentWindowPatch(current, { start, end:eventEnd(current) }, { start:patch.start, end:patch.end }) });
  }
  function editorAssignmentUserList(event = {}){
    const ids = Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids.map(clean).filter(Boolean) : [];
    const named = Array.isArray(event.assigned_users) ? event.assigned_users : [];
    return ids.map((id) => ({ id, name: clean(named.find((user) => clean(user?.id) === id)?.name) || userDisplayName(id) }));
  }
  function updateEditorAssignees(list = []){
    const current = eventEditorContext()?.event || {};
    applyEditorPatch(assigneeSetPatch(current, eventCrewRefs(current), list));
  }
  /* The editor's explicit assignee set: every crew/team reference plus every
   * person. Saving writes exactly this set — crews as crew-role
   * resource_refs, people as assigned_user_ids — so a removed crew never
   * lingers in resource_refs and multi-crew items keep all of their crews. */
  function assigneeSetPatch(event = {}, crews = [], people = []){
    const helper = window.PlatformScheduling?.assigneeSetPayload;
    if (typeof helper === 'function') {
      const result = helper(event, { crews, people });
      if (result && typeof result === 'object') return result;
    }
    const crewRefs = crews.map((crew) => ({ kind:clean(crew.kind) || 'resource_group', id:clean(crew.id), name:clean(crew.name) || clean(crew.id), role:'crew' })).filter((ref) => ref.id);
    const primary = crewRefs[0] || null;
    const single = workResourcePayload(primary ? { id:primary.id, name:primary.name, resource_kind:primary.kind } : {});
    const names = [...crewRefs.map((ref) => ref.name), ...people.map((user) => clean(user.name))].filter(Boolean);
    return {
      ...single,
      // Several crews: the list is authoritative; the server mirrors the first
      // crew into the legacy single-crew fields.
      ...(crewRefs.length > 1 ? { work_resource_ref:null } : {}),
      resource_refs:[...crewRefs, ...equipmentRefsOf(event)],
      assigned_user_ids:people.map((user) => clean(user.id)).filter(Boolean),
      assigned_users:people.map((user) => ({ id:clean(user.id), name:clean(user.name) })).filter((user) => user.id),
      assigned_user_id:clean(people[0]?.id),
      assigned_user_name:clean(people[0]?.name),
      assignee_label:names.join(', ') || 'Unassigned'
    };
  }
  /* Saves of a multi-crew item send the crew list without a singular
   * work_resource_ref, so the server keeps every crew instead of rebuilding
   * the list from the first one. Single-crew items are sent unchanged. */
  function withExplicitAssignees(event = {}){
    const helper = window.PlatformScheduling?.explicitAssigneePayload;
    if (typeof helper === 'function') {
      const result = helper(event);
      if (result && typeof result === 'object') return result;
    }
    const crews = eventCrewRefs(event);
    if (crews.length < 2) return event;
    const crewRefs = crews.map((crew) => ({ kind:crew.kind || 'resource_group', id:crew.id, name:crew.name || crew.id, role:'crew' }));
    const otherRefs = (Array.isArray(event.resource_refs) ? event.resource_refs : []).filter((ref) => !['resource_group', 'organization_connection'].includes(clean(ref?.kind)));
    return { ...event, work_resource_ref:null, resource_refs:[...crewRefs, ...otherRefs] };
  }
  function updateEditorCustomerSetting(field = '', value = false){
    if (!['customer_visible', 'customer_show_title', 'customer_show_crew', 'customer_description'].includes(field)) return;
    const patch = { [field]: field === 'customer_description' ? String(value || '') : value === true };
    const ctx = eventEditorContext();
    if (!ctx) return;
    if (ctx.kind === 'floating' || ctx.editorOnly) stageEditorEdit(ctx, patch);
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
    if (ctx.kind === 'floating' || ctx.editorOnly) stageEditorEdit(ctx, update);
    else if (ctx.kind === 'materials') materialScheduleDraft = { ...(materialScheduleDraft || ctx.event || {}), ...update };
    else if (ctx.kind === 'production') productionScheduleDraft = { ...(productionScheduleDraft || ctx.event || {}), ...update };
    else appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), ...update };
  }

  /* Status line for the editor: a staff member marking the outcome is not
   * the customer answering. */
  function confirmationStatusLabel(state = {}){
    if (clean(state?.confirmed_via).toLowerCase() === 'manual' && (state.confirmed || state.declined)) {
      const by = clean(state.confirmed_by);
      if (state.confirmed) return by ? `Marked confirmed by ${by}` : 'Marked confirmed by staff';
      return by ? `Marked declined by ${by}` : 'Marked declined by staff';
    }
    return clean(state?.label);
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
    // Customer confirmation is an appointment feature: it needs a project
    // (a customer to ask) and does not apply to crew work, deliveries or
    // equipment windows.
    if (!project?.id) return '';
    // Sections/groups are containers of work, not appointments.
    if (isMaterialEvent(draft) || isProductionEvent(draft) || isEquipmentWindowEvent(draft) || window.PlatformScheduling?.eventIsGroup?.(draft) === true) return '';
    const confirmation = editorConfirmation(draft);
    const schedule = confirmation.schedule || {};
    const mode = clean(schedule.mode) || 'morning_of';
    const open = confirmation.required === true;
    const modeOption = (value, label) => `<option value="${escapeHtml(value)}" ${mode === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    const state = Scheduling?.confirmationState?.(draft);
    const statusLine = state && state.required && state.status !== 'pending'
      ? `<div class="dash-event-confirm-status ${escapeHtml(state.tone)}"><i class="fas ${escapeHtml(state.icon)}"></i> ${escapeHtml(state.label)}</div>`
      : '';
    // Manual outcome controls for a saved appointment that asks for a reply
    // (same actions as the project Schedule tab).
    const storedEvent = ctx.editorOnly ? allEvents.find((item) => String(item.id || '') === String(draft.id || '')) : null;
    const storedState = storedEvent ? Scheduling?.confirmationState?.(storedEvent) : null;
    const confirmActions = storedState?.required && window.PlatformAPI?.appointments?.setConfirmation && canEditSchedule()
      ? `<div class="dash-event-confirm-actions" data-event-confirm-actions>${storedState.confirmed || storedState.declined
          ? `<button type="button" data-event-confirm-set="reset">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_80ae2923b672d0","Mark unconfirmed") ?? "Mark unconfirmed")}</button>`
          : `<button type="button" class="primary" data-event-confirm-set="confirmed">${(globalThis.PlatformLanguage?.htmlText("project-schedule","m_617e25cc0ca1b3","Mark confirmed") ?? "Mark confirmed")}</button><button type="button" data-event-confirm-set="declined">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_mark_declined","Mark declined") ?? "Mark declined")}</button>`}${window.PlatformAPI?.appointments?.sendConfirmation && !storedState.confirmed ? `<button type="button" data-event-confirm-send>${storedState.sent_at ? (globalThis.PlatformLanguage?.htmlText("scheduling","m_resend_confirmation","Resend request") ?? "Resend request") : (globalThis.PlatformLanguage?.htmlText("project-schedule","m_b495e5473c85e0","Send now") ?? "Send now")}</button>` : ''}</div>`
      : '';
    return `
      <div class="dash-event-confirm-panel">
        ${storedState?.required ? `<div class="dash-event-confirm-status ${escapeHtml(storedState.tone)}"><i class="fas ${escapeHtml(storedState.icon)}"></i> ${escapeHtml(confirmationStatusLabel(storedState) || 'Awaiting confirmation')}</div>${confirmActions}` : ''}
        <label class="dash-event-customer-share">
          <input type="checkbox" data-event-confirm-required ${String(open ? 'checked' : '')}>
          <span class="dash-event-share-switch" aria-hidden="true"></span>
          <span><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_ae86d3ed019015","Ask the customer to confirm") ?? "Ask the customer to confirm")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_956b2b7eb54d56","The appointment shows as unconfirmed until they reply.") ?? "The appointment shows as unconfirmed until they reply.")}</small></span>
        </label>
        ${String(storedState?.required ? '' : statusLine)}
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
    const runConfirmationAction = async (outcome, button) => {
      const ctx = eventEditorContext();
      const projectId = clean(ctx?.project?.id || draft.project_id);
      const eventId = clean(ctx?.event?.id || draft.id);
      const client = window.PlatformAPI?.appointments;
      if (!projectId || !eventId || !client) return;
      pop.querySelectorAll('[data-event-confirm-actions] button').forEach((entry) => { entry.disabled = true; });
      try {
        if (outcome === 'send') await client.sendConfirmation(orgId(), projectId, eventId);
        else await client.setConfirmation(orgId(), projectId, eventId, outcome);
        await loadData({ force:true });
        showToast(
          outcome === 'send' ? 'Confirmation request sent' : outcome === 'confirmed' ? 'Marked confirmed' : outcome === 'declined' ? 'Marked declined' : 'Marked unconfirmed',
          outcome === 'send' ? 'The customer was asked to confirm this appointment.' : 'The appointment confirmation was updated.',
          true
        );
        rerender();
      } catch (error) {
        pop.querySelectorAll('[data-event-confirm-actions] button').forEach((entry) => { entry.disabled = false; });
        showToast((globalThis.PlatformLanguage?.text("project-schedule","m_cac0219c86a9cb","Confirmation update failed") ?? "Confirmation update failed"), scheduleSaveErrorMessage(error, 'Could not update the confirmation.'), false);
      }
    };
    pop.querySelectorAll('[data-event-confirm-set]').forEach((button) => button.addEventListener('click', () => runConfirmationAction(button.dataset.eventConfirmSet || 'confirmed', button)));
    pop.querySelector('[data-event-confirm-send]')?.addEventListener('click', (event) => runConfirmationAction('send', event.currentTarget));
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
    if (ctx.kind === 'floating' || ctx.editorOnly) stageEditorEdit(ctx, update);
    else if (ctx.kind === 'materials') materialScheduleDraft = { ...(materialScheduleDraft || ctx.event || {}), ...update };
    else if (ctx.kind === 'production') productionScheduleDraft = { ...(productionScheduleDraft || ctx.event || {}), ...update };
    else appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), ...update };
  }

  function customerSchedulingEditorHtml(ctx, draft = {}, project = {}){
    if (window.Portal?.can?.('scheduling.customer_rescheduling') !== true) return '';
    if (!project?.id || isMaterialEvent(draft) || isProductionEvent(draft) || isEquipmentWindowEvent(draft) || window.PlatformScheduling?.eventIsGroup?.(draft) === true) return '';
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
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_3330f4f8d5af70","Could not review change") ?? "Could not review change"), scheduleSaveErrorMessage(error, 'Try again.'), false);
        pop.querySelectorAll('[data-event-reschedule-review]').forEach((entry) => { entry.disabled = false; });
      }
    }));
  }

  /* ── Save errors and stale-data checks ─────────────────────────────────── */
  function scheduleSaveErrorLines(error){
    const conflicts = Array.isArray(error?.data?.details?.conflicts) ? error.data.details.conflicts : [];
    const issues = Array.isArray(error?.data?.details?.issues) ? error.data.details.issues : [];
    // All-day bookings read as dates, not "12:00 AM".
    const when = (item = {}) => {
      const date = validDate(item?.start_at);
      if (!date) return '';
      const allDay = item?.all_day === true || clean(item?.schedule_granularity).toLowerCase() === 'date' || (date.getHours() === 0 && date.getMinutes() === 0);
      return allDay ? date.toLocaleDateString([], { month:'short', day:'numeric' }) : date.toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    };
    return [
      ...conflicts.map((conflict) => {
        const booked = (Array.isArray(conflict?.events) ? conflict.events : []).slice(0, 2)
          .map((item) => [clean(item?.title || item?.project_title), when(item)].filter(Boolean).join(' · '))
          .filter(Boolean);
        return [clean(conflict?.message) || `${clean(conflict?.ref_name) || 'Equipment'} is not available.`, booked.length ? `Booked: ${booked.join('; ')}` : ''].filter(Boolean).join(' ');
      }),
      ...issues.map((issue) => clean(issue?.message || issue?.label || issue)).filter(Boolean)
    ];
  }
  function scheduleSaveErrorMessage(error, fallback = 'Could not save the change.'){
    if (Number(error?.status) === 403) return scheduleReadOnlyMessage();
    // A request that never reached the server (offline, dropped connection).
    if (!Number(error?.status) && /failed to fetch|networkerror|network request failed|load failed/i.test(clean(error?.message))) {
      return 'The server could not be reached, so nothing was changed. Check your connection and try again.';
    }
    // A timed-out save may still land on the server; say so rather than claim it failed.
    if (window.PlatformScheduling?.isSaveTimeoutError?.(error) === true) {
      return 'The server did not answer in time. The change may still be saved — refresh the schedule before trying again.';
    }
    const lines = scheduleSaveErrorLines(error);
    return lines.length ? lines.join(' ') : (clean(error?.message) || fallback);
  }
  /* Field groups a stale-save check compares. A save only conflicts with a
   * change made elsewhere when both touch the same group; otherwise the
   * other change (a colleague's description, equipment, lock…) is kept and
   * only this view's own changes are written on top of the stored copy. */
  const EVENT_TIME_KEYS = ['start', 'end', 'start_at', 'end_at', 'duration_minutes', 'all_day', 'schedule_granularity', 'start_date', 'end_date'];
  const EVENT_ASSIGNMENT_KEYS = ['assigned_user_ids', 'assigned_users', 'assigned_user_id', 'assigned_user_name', 'work_resource_ref', 'assigned_resource_kind', 'assigned_resource_id', 'assigned_resource_name', 'assigned_crew_id', 'assigned_crew_name', 'assigned_crew', 'crew_id', 'crew_name', 'resource_id', 'resource_name', 'assignee_label'];
  const EVENT_LOCK_KEYS = ['locked', 'schedule_locked', 'schedule_lock', 'unlock_confirmed'];
  const EVENT_COMPARE_IGNORED = new Set(['id', 'updated_at', 'created_at', 'schedule_history', 'requirement_warnings', 'project_title', 'project_address', 'resource_refs', 'floating_event', 'type_id', 'event_type_id', 'event_type_default_id', 'title_is_custom', 'revision', 'version']);
  const CREW_REF_KINDS = ['resource_group', 'organization_connection', 'organization_user'];
  function crewRefsOf(event = {}){
    return (Array.isArray(event?.resource_refs) ? event.resource_refs : []).filter((ref) => CREW_REF_KINDS.includes(clean(ref?.kind)));
  }
  function equipmentRefsOf(event = {}){
    return (Array.isArray(event?.resource_refs) ? event.resource_refs : []).filter((ref) => !CREW_REF_KINDS.includes(clean(ref?.kind)));
  }
  function emptyEventValue(value){
    return value === undefined || value === null || value === '' || value === false
      || (Array.isArray(value) && !value.length)
      || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);
  }
  function eventGroupValue(event = {}, group = ''){
    const time = (value) => validDate(value)?.getTime() || 0;
    if (group === 'time') return JSON.stringify([eventStart(event)?.getTime() || 0, eventEnd(event)?.getTime() || 0, event?.all_day === true || clean(event?.schedule_granularity).toLowerCase() === 'date']);
    if (group === 'assignment') {
      const people = [...new Set([clean(event?.assigned_user_id), ...(Array.isArray(event?.assigned_user_ids) ? event.assigned_user_ids : []).map(clean)].filter(Boolean))].sort();
      return JSON.stringify([eventCrewRefs(event || {}).map((ref) => ref.id).sort(), people]);
    }
    if (group === 'equipment') return JSON.stringify(eventEquipRefs(event || {}).map((ref) => [ref.kind, ref.id, ref.quantity, time(ref.start_at), time(ref.end_at)]).sort());
    if (group === 'lock') return eventIsLocked(event || {}) ? '1' : '0';
    const value = event?.[group];
    return emptyEventValue(value) ? '' : JSON.stringify(value);
  }
  /* The groups that differ between two copies of one schedule item. */
  function eventChangeGroups(before = {}, after = {}){
    const grouped = new Set([...EVENT_TIME_KEYS, ...EVENT_ASSIGNMENT_KEYS, ...EVENT_LOCK_KEYS]);
    const groups = new Set(['time', 'assignment', 'equipment', 'lock']);
    [...Object.keys(before || {}), ...Object.keys(after || {})].forEach((key) => {
      if (!key.startsWith('__') && !grouped.has(key) && !EVENT_COMPARE_IGNORED.has(key)) groups.add(key);
    });
    return [...groups].filter((group) => eventGroupValue(before, group) !== eventGroupValue(after, group));
  }
  /* The stored copy with this view's changes (the groups it edited) on top. */
  function mergeEventChanges(fresh = {}, edited = {}, groups = []){
    const merged = { ...fresh };
    groups.forEach((group) => {
      if (group === 'time') EVENT_TIME_KEYS.forEach((key) => { if (Object.prototype.hasOwnProperty.call(edited, key)) merged[key] = edited[key]; });
      else if (group === 'assignment') {
        EVENT_ASSIGNMENT_KEYS.forEach((key) => { merged[key] = edited[key]; });
        merged.resource_refs = [...crewRefsOf(edited), ...equipmentRefsOf(merged)];
      } else if (group === 'equipment') merged.resource_refs = [...crewRefsOf(merged), ...equipmentRefsOf(edited)];
      else if (group === 'lock') EVENT_LOCK_KEYS.forEach((key) => { if (Object.prototype.hasOwnProperty.call(edited, key)) merged[key] = edited[key]; });
      else merged[group] = edited[group];
    });
    return merged;
  }
  /* A save the server refused because the item changed since it was read
   * (typed stale error from the API), or this view's own pre-save check. */
  function isStaleSaveError(error){
    if (!error) return false;
    if (error.staleSchedule === true || error.stale === true) return true;
    if (window.PlatformAPI?.isStaleError?.(error) === true || window.PlatformScheduling?.isStaleSaveError?.(error) === true) return true;
    const code = clean(error.code || error.data?.code || error.data?.error || error.name).toLowerCase();
    return (Number(error.status) === 409 || code.includes('stale')) && /stale|revision|version|changed_elsewhere|concurrent|modified/.test(code);
  }
  function scheduleEventFingerprint(event = {}){
    return ['time', 'assignment', 'equipment', 'lock', 'title', 'status', 'description', 'notes'].map((group) => eventGroupValue(event, group)).join('|');
  }
  /* Read the stored copy of a schedule item straight from the server. */
  // With reportGone, a project read that no longer holds the item returns
  // STORED_EVENT_GONE (deleted elsewhere) instead of null (couldn't tell).
  const STORED_EVENT_GONE = Object.freeze({ gone:true });
  async function fetchStoredScheduleEvent(event = {}, { reportGone = false } = {}){
    const id = clean(event.id);
    const api = window.PlatformAPI;
    if (!id || !api) return null;
    const floating = event.floating_event === true || id.startsWith('floating_') || floatingEvents.some((item) => clean(item.id) === id);
    if (floating) {
      const result = await api.calendarEvents?.get?.(orgId(), id);
      const document = result?.document;
      if (!document) return null;
      return decorateFloatingEvent({ ...(document.data || {}), id:document.id || id });
    }
    const projectId = clean(event.project_id);
    if (!projectId || !api.projects?.get) return null;
    const result = await api.projects.get(orgId(), projectId);
    if (!result?.document) return null;
    const freshEvents = window.PlatformScheduling?.eventsFromProjects?.([result.document], schedulingConfig || {}) || [];
    return freshEvents.find((item) => clean(item.id) === id) || (reportGone ? STORED_EVENT_GONE : null);
  }
  /* Before writing, make sure nobody else changed the item since this view
   * loaded it. On a mismatch the calendar reloads and the caller aborts, so a
   * stale copy never silently overwrites a newer change. */
  /* Read the stored copy and compare it with the copy this view loaded
   * (`known`). `ownGroups` are the groups this save changes: it conflicts
   * only when the other change touched one of them. -> { fresh, conflict,
   * remoteGroups } — fresh is null when the stored copy can't be read (the
   * server's own stale check then decides). */
  async function checkStoredScheduleEvent(known, ownGroups = []){
    if (!known?.id) return { fresh:null, conflict:false, remoteGroups:[] };
    let fresh = null;
    try {
      fresh = await withTimeout(fetchStoredScheduleEvent(known, { reportGone:true }), 6000, 'Schedule freshness check');
    } catch (error) {
      return { fresh:null, conflict:false, remoteGroups:[] };
    }
    if (fresh === STORED_EVENT_GONE) return { fresh:null, gone:true, conflict:false, remoteGroups:[] };
    if (!fresh) return { fresh:null, conflict:false, remoteGroups:[] };
    const remoteGroups = eventChangeGroups(known, fresh);
    return { fresh, remoteGroups, conflict:remoteGroups.some((group) => ownGroups.includes(group)) };
  }
  /* A refused stale save: say so and reload the latest stored schedule. */
  // The toast says the calendar "now shows the latest version", so it only
  // appears once the reload has finished.
  async function reloadAfterStaleChange(error = null){
    await loadData({ force:true });
    if (error?.deleted === true) deletedElsewhereToast();
    else changedElsewhereToast();
  }
  function deletedElsewhereToast(){
    showToast(
      (globalThis.PlatformLanguage?.text("scheduling","m_deleted_elsewhere","Deleted by someone else") ?? "Deleted by someone else"),
      (globalThis.PlatformLanguage?.text("scheduling","m_deleted_elsewhere_body","This item was deleted in another window, so your changes were not saved.") ?? "This item was deleted in another window, so your changes were not saved."),
      STALE_TOAST
    );
  }
  // Stays up until dismissed (or replaced): it asks the user to redo work.
  const STALE_TOAST = { tone:'warning', duration:600000 };
  function changedElsewhereToast(error = null){
    if (error?.deleted === true) { deletedElsewhereToast(); return; }
    showToast(
      (globalThis.PlatformLanguage?.text("scheduling","m_changed_elsewhere","Changed by someone else") ?? "Changed by someone else"),
      (globalThis.PlatformLanguage?.text("scheduling","m_changed_elsewhere_body","This item was changed in another window. The calendar now shows the latest version; review it and apply your change again.") ?? "This item was changed in another window. The calendar now shows the latest version; review it and apply your change again."),
      STALE_TOAST
    );
  }
  function scheduleItemExists(eventId = ''){
    const id = String(eventId || '');
    return !!id && (allEvents.some((event) => String(event.id || '') === id) || floatingEvents.some((event) => String(event.id || '') === id));
  }
  /* The item being saved was deleted elsewhere: drop it, close its editor
   * (never reopen it as an empty placement) and say what happened. */
  function closeEditorForDeletedItem(eventId = ''){
    const id = String(eventId || '');
    allEvents = allEvents.filter((event) => String(event.id || '') !== id);
    floatingEvents = floatingEvents.filter((event) => String(event.id || '') !== id);
    events = visibleEvents();
    discardEventEditorDraft(id);
    if (String(eventEditorEventId || '') === id || String(eventDraftPopoverId || '') === id) {
      eventDraftPopoverId = '';
      eventEditorEventId = '';
      eventDraftProjectQuery = '';
      if (productionScheduleEventId === id || appointmentScheduleEventId === id || materialScheduleEventId === id) clearPlacementSelection();
      closeEventDraftPopover();
    }
    render();
    showToast(
      (globalThis.PlatformLanguage?.text("scheduling","m_deleted_elsewhere","Deleted by someone else") ?? "Deleted by someone else"),
      (globalThis.PlatformLanguage?.text("scheduling","m_deleted_elsewhere_body","This item was deleted in another window, so your changes were not saved.") ?? "This item was deleted in another window, so your changes were not saved."),
      STALE_TOAST
    );
  }
  /* Before writing, make sure nobody else changed what this save changes
   * since this view loaded the item. On a conflict the calendar reloads and
   * the caller aborts, so a stale copy never overwrites a newer change. */
  async function eventChangedElsewhere(edited, stored){
    if (!stored?.id) return false;
    const check = await checkStoredScheduleEvent(stored, eventChangeGroups(stored, edited || stored));
    if (!check.conflict) return false;
    await reloadAfterStaleChange();
    return true;
  }
  function staleScheduleError(){
    const error = new Error('This item was changed in another window.');
    error.staleSchedule = true;
    return error;
  }
  /* After a refused stale save: reload, then reopen the editor on the latest
   * stored copy with the user's pending edits still layered on top. */
  /* The open editor while its save is on the way: fields locked, Save says
   * "Saving…" (a re-render of the editor clears it). */
  function setEventEditorSaving(saving = true){
    const pop = document.querySelector('.dash-event-popover');
    if (!pop) return;
    pop.classList.toggle('dash-event-saving', saving);
    pop.setAttribute('aria-busy', saving ? 'true' : 'false');
    const save = pop.querySelector('[data-event-save]');
    if (!save) return;
    if (saving) {
      if (!save.dataset.idleLabel) save.dataset.idleLabel = save.innerHTML;
      save.textContent = (globalThis.PlatformLanguage?.text("scheduling","m_saving","Saving…") ?? "Saving…");
      save.disabled = true;
    } else {
      if (save.dataset.idleLabel) save.innerHTML = save.dataset.idleLabel;
      delete save.dataset.idleLabel;
      save.disabled = false;
    }
  }
  async function handleStaleEditorSave(eventId = '', error = null){
    // Say so right away: the reload can take a while on a busy server.
    showToast(
      error?.deleted === true
        ? (globalThis.PlatformLanguage?.text("scheduling","m_deleted_elsewhere","Deleted by someone else") ?? "Deleted by someone else")
        : (globalThis.PlatformLanguage?.text("scheduling","m_changed_elsewhere","Changed by someone else") ?? "Changed by someone else"),
      (globalThis.PlatformLanguage?.text("scheduling","m_loading_latest","Loading the latest version…") ?? "Loading the latest version…"),
      STALE_TOAST
    );
    await loadData({ force:true });
    // Refused because the item no longer exists (or the reload shows it gone).
    if (error?.deleted === true || (dataLoaded && !scheduleRefreshFailedAt && eventId && !scheduleItemExists(eventId))) {
      closeEditorForDeletedItem(eventId);
      return;
    }
    changedElsewhereToast();
    reopenEventEditorAfterConflict(eventId, { stale:true });
  }
  function reopenEventEditorAfterConflict(eventId = '', options = {}){
    const id = String(eventId || '');
    if (!id || (String(eventEditorEventId || '') !== id && String(eventDraftPopoverId || '') !== id)) return;
    setTimeout(() => renderEventDraftPopover(editorAnchorFor(id), options.stale ? { stale:true } : {}), 0);
  }
  /* Close the editor and throw away its unsaved edits. The stored event was
   * never touched, so nothing needs restoring; a brand-new floating draft is
   * removed. A rail placement keeps its selection (placing continues on the
   * calendar) — only the popover closes. */
  function cancelEventEditor({ deferRender = false, restoreFocus = false } = {}){
    const ctx = eventEditorContext();
    discardEventEditorDraft();
    window.PlatformUI?.hideTooltip?.();
    // Keyboard close (Escape / ×) returns focus to the item it was opened from
    // (or to the day list it was opened from).
    const returnTo = dayListReturn && ctx?.event?.id && dayListReturn.eventId === String(ctx.event.id) ? dayListReturn.day : '';
    dayListReturn = null;
    const focusItem = () => {
      if (!restoreFocus || !ctx?.event?.id) return;
      if (returnTo) { openDayModal(`${returnTo}T12:00:00`); return; }
      if (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) return;
      const anchor = editorAnchorFor(ctx.event.id);
      if (anchor && !anchor.hasAttribute('tabindex') && !anchor.matches('button,a,[tabindex]')) anchor.setAttribute('tabindex', '-1');
      anchor?.focus?.({ preventScroll:true });
    };
    if (ctx && ctx.kind !== 'floating' && !ctx.editorOnly) {
      closeEventDraftPopover();
      focusItem();
      return;
    }
    if (ctx?.kind === 'floating' && floatingEventIsDisposableDraft(ctx.event)) {
      floatingEvents = floatingEvents.filter((event) => String(event.id || '') !== String(ctx.event.id || ''));
    } else if (ctx) clearPlacementSelection();
    eventDraftPopoverId = '';
    eventEditorEventId = '';
    eventDraftProjectQuery = '';
    eventCustomerDetailsOpen = false;
    eventAdvancedOpen = false;
    closeEventDraftPopover();
    // An outside click can land on another calendar item; redraw after that
    // click is delivered so it still opens.
    if (deferRender) setTimeout(() => { render(); focusItem(); }, 0);
    else { render(); focusItem(); }
  }
  /* The date on screen: the Timeline's left edge (it scrolls freely), else
   * the anchor. */
  function shownScheduleDate(){
    if (viewMode === 'gantt') return startOfDay(validDate(ganttVisibleRange?.start)) || anchorDate;
    return anchorDate;
  }
  /* History depth of the entry on screen, so a Back/Forward can be undone
   * ("Keep editing") by stepping the other way. */
  let scheduleNavDepth = null;
  function currentNavDepth(){
    const depth = Number(window.history?.state?.fmNavigation?.depth);
    return Number.isFinite(depth) ? depth : null;
  }
  function rememberScheduleNavDepth(){ scheduleNavDepth = currentNavDepth(); }
  window.addEventListener('fm:route-state:updated', (event) => {
    const detail = event?.detail || {};
    // Writes (push/replace) and finished route applications; not the start
    // of a Back/Forward, whose depth is the one being decided on.
    if (detail.history !== 'apply' || detail.applying === false) rememberScheduleNavDepth();
  });
  function editorHasUnsavedEdits(){
    if (!document.querySelector('.dash-event-popover')) return false;
    const ctx = eventEditorContext();
    if (!ctx || (ctx.kind !== 'floating' && !ctx.editorOnly)) return false;
    const id = String(ctx.event?.id || '');
    const disposable = ctx.kind === 'floating' && floatingEventIsDisposableDraft(ctx.event);
    return disposable || (!!eventEditorDraft && String(eventEditorDraft.id || '') === id && Object.keys(eventEditorDraft.patch || {}).length > 0);
  }
  /* Back/Forward with unsaved edits: ask before the calendar moves.
   * Discard closes the editor and lets the route apply; Keep editing steps
   * history back to the entry the editor belongs to (the calendar never
   * moved, so the editor stays anchored) and focus returns into it.
   * -> true when the route may apply. */
  async function confirmRouteLeavesEditor(){
    if (!editorHasUnsavedEdits()) return true;
    const ctx = eventEditorContext();
    const id = String(ctx?.event?.id || '');
    const fromDepth = scheduleNavDepth;
    const arrivedDepth = currentNavDepth();
    const label = clean(ctx?.event?.title) || 'this event';
    settleEditorAfterRouteChange.pending = true;
    let discard = true;
    try {
      discard = window.PlatformUI?.confirm
        ? await window.PlatformUI.confirm(`You have unsaved changes to “${label}”. Discard them?`, { title:'Unsaved changes', okLabel:'Discard', cancelLabel:'Keep editing', danger:true, defaultFocus:'cancel' })
        : true;
    } finally {
      settleEditorAfterRouteChange.pending = false;
    }
    if (!editorStillShows(id)) return true;
    if (discard) {
      cancelEventEditor();
      return true;
    }
    const steps = fromDepth !== null && arrivedDepth !== null ? fromDepth - arrivedDepth : 0;
    if (steps) window.history.go(steps);
    else setTimeout(() => syncScheduleRoute({ scheduleView:viewMode, date:routeDate(shownScheduleDate()) }, { history:'replace', source:'scheduling-date', ownedKeys:['scheduleView','date'] }), 0);
    const pop = document.querySelector('.dash-event-popover');
    if (pop && !pop.contains(document.activeElement)) {
      (pop.querySelector('[data-event-title]:not([disabled])') || pop.querySelector('input:not([disabled]),textarea:not([disabled]),button:not([disabled])'))?.focus?.({ preventScroll:true });
    }
    return false;
  }
  /* A link with a date/view/chips value that can't be used falls back to a
   * working one; the URL is corrected to what is shown. */
  function normalizeScheduleRoute(route = {}){
    const patch = {};
    const rawDate = clean(route.date);
    if (rawDate) {
      const parsed = parseRouteDate(rawDate);
      const shown = routeDate(parsed || shownScheduleDate());
      if (shown !== rawDate) patch.date = shown;
    }
    if (clean(route.scheduleView) && clean(route.scheduleView) !== viewMode) patch.scheduleView = viewMode;
    if (clean(route.scheduleType) && !scheduleTypesFromRoute(route.scheduleType)) patch.scheduleType = scheduleTypeRouteValue();
    if (clean(route.day) && !parseRouteDate(route.day)) patch.day = null;
    if (!Object.keys(patch).length) return;
    setTimeout(() => syncScheduleRoute(patch, { history:'replace', source:'schedule-restore', ownedKeys:Object.keys(patch) }), 0);
  }
  /* Browser Back/Forward moved the calendar under an open editor: a clean
   * editor closes; unsaved edits ask before they are thrown away (Keep
   * editing leaves the editor open on the new range). Rail placements keep
   * their selection, as paging does. */
  async function settleEditorAfterRouteChange(){
    if (!document.querySelector('.dash-event-popover')) return;
    const ctx = eventEditorContext();
    if (!ctx || (ctx.kind !== 'floating' && !ctx.editorOnly)) return;
    const id = String(ctx.event?.id || '');
    const disposable = ctx.kind === 'floating' && floatingEventIsDisposableDraft(ctx.event);
    const unsaved = disposable || (!!eventEditorDraft && String(eventEditorDraft.id || '') === id && Object.keys(eventEditorDraft.patch || {}).length > 0);
    if (!unsaved) { cancelEventEditor(); return; }
    if (settleEditorAfterRouteChange.pending) return;
    settleEditorAfterRouteChange.pending = true;
    try {
      const label = clean(ctx.event?.title) || 'this event';
      const discard = window.PlatformUI?.confirm
        ? await window.PlatformUI.confirm(`You have unsaved changes to “${label}”. Discard them?`, { title:'Unsaved changes', okLabel:'Discard', cancelLabel:'Keep editing', danger:true, defaultFocus:'cancel' })
        : true;
      if (!editorStillShows(id)) return;
      if (discard) cancelEventEditor();
      else renderEventDraftPopover(editorAnchorFor(id));
    } finally {
      settleEditorAfterRouteChange.pending = false;
    }
  }
  /* Outside click: same as Cancel for an event being edited; a rail
   * placement only closes its popover and keeps the selection. */
  /* Header navigation (Prev/Today/Next, views, Show chips) moves the calendar
   * away from the item being edited: with typed edits it asks first, like
   * browser Back does. The click is held and replayed only on Discard. */
  const EDITOR_GUARDED_CONTROLS = ['data-dash-nav', 'data-dash-today', 'data-dash-view', 'data-schedule-type-toggle'];
  function dismissEventEditor(target){
    const draftChip = target?.closest?.('[data-prs-event-id],[data-psv-gantt-bar]');
    if (draftChip && placementWaitingItem() && !eventEditorEventId && !eventDraftPopoverId
      && placementDraftIds().has(clean(draftChip.getAttribute('data-prs-event-id') || draftChip.getAttribute('data-psv-gantt-bar')))) return;
    const control = target?.closest?.(EDITOR_GUARDED_CONTROLS.map((attr) => `[${attr}]`).join(','));
    const typedEdits = !!eventEditorDraft && Object.keys(eventEditorDraft.patch || {}).length > 0 && editorHasUnsavedEdits();
    if (!control || !typedEdits || !window.PlatformUI?.confirm) {
      cancelEventEditor({ deferRender:true });
      return;
    }
    const attr = EDITOR_GUARDED_CONTROLS.find((name) => control.hasAttribute(name));
    const selector = `[${attr}="${String(control.getAttribute(attr) || "").replace(/"/g, "\\\"")}"]`;
    const hold = (clickEvent) => {
      if (!control.contains(clickEvent.target)) return;
      clickEvent.preventDefault();
      clickEvent.stopImmediatePropagation();
    };
    document.addEventListener("click", hold, true);
    setTimeout(() => document.removeEventListener("click", hold, true), 600);
    const ctx = eventEditorContext();
    const id = String(ctx?.event?.id || "");
    // Name the item as saved, not with the title being typed.
    const label = clean(baseEventEditorContext()?.event?.title) || clean(ctx?.event?.title) || "this event";
    window.PlatformUI.confirm(`You have unsaved changes to “${label}”. Discard them?`, { title:"Unsaved changes", okLabel:"Discard", cancelLabel:"Keep editing", danger:true, defaultFocus:"cancel" }).then((discard) => {
      if (!editorStillShows(id)) return;
      if (!discard) {
        document.querySelector(".dash-event-popover [data-event-title]")?.focus();
        return;
      }
      cancelEventEditor();
      (control.isConnected ? control : rootEl?.querySelector(selector))?.click();
    });
  }
  /* Keyboard activation (Enter/Space, detail 0) of a header control never
   * passes the pointer check above: guard it the same way. */
  document.addEventListener('click', (event) => {
    if (event.detail !== 0 || !rootEl?.contains?.(event.target)) return;
    const control = event.target?.closest?.(EDITOR_GUARDED_CONTROLS.map((attr) => `[${attr}]`).join(','));
    const pop = document.querySelector('.dash-event-popover');
    if (!control || !pop || pop.contains(control) || (!eventEditorEventId && !eventDraftPopoverId)) return;
    const typedEdits = !!eventEditorDraft && Object.keys(eventEditorDraft.patch || {}).length > 0 && editorHasUnsavedEdits();
    if (!typedEdits) { cancelEventEditor({ deferRender:true }); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    dismissEventEditor(control);
  }, true);
  /* Escape closes only the topmost layer: an open date/time picker or dialog
   * handles its own Escape, then the assignee menus, the project results and
   * the equipment picker inside the editor, and only then the editor. */
  function handleEventEditorEscape(pop, event){
    if (!pop?.isConnected) return false;
    if (document.querySelector('fm-date-time-picker') || document.querySelector('.fm-dialog-backdrop')) return false;
    const consume = () => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.(); return true; };
    if (document.querySelector('.dash-assignee-popover')) { closeAssignmentMenu(); return consume(); }
    const assignMenu = pop.querySelector('[data-event-assign-menu]:not([hidden])');
    if (assignMenu) {
      assignMenu.hidden = true;
      pop.querySelector('[data-event-assign-add]')?.setAttribute('aria-expanded', 'false');
      pop.querySelector('[data-event-assign-add]')?.focus();
      return consume();
    }
    const results = pop.querySelector('[data-event-project-results]:not([hidden])');
    if (results) {
      results.hidden = true;
      eventDraftProjectQuery = '';
      return consume();
    }
    const equipmentPicker = pop.querySelector('[data-equipment-picker][open]');
    if (equipmentPicker) {
      equipmentPicker.open = false;
      equipmentPicker.querySelector('summary')?.focus();
      return consume();
    }
    // The "apply to which events?" choice: Escape is its Back button, the
    // edit stays in the editor.
    const scopeBack = pop.querySelector('[data-event-recurrence-scope] [data-event-scope-back]');
    if (scopeBack) {
      scopeBack.click();
      return consume();
    }
    cancelEventEditor({ deferRender:true, restoreFocus:true });
    return consume();
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
    const payload = {
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
    if (!clean(event.recurrence_series_id)) return payload;
    // Editing an existing series from one of its occurrences: name the
    // occurrence and its edited times instead of re-anchoring the series on it.
    delete payload.start_at;
    delete payload.project_id;
    payload.scope = options.scope === 'following' ? 'following' : 'all';
    payload.event_id = clean(event.id);
    payload.occurrence_key = clean(event.recurrence_occurrence_key);
    payload.occurrence_start_at = start?.toISOString() || '';
    payload.occurrence_end_at = end?.toISOString() || '';
    // Only send what the editor actually shows: project occurrences have no
    // cadence fields and the charge/cost inputs start empty.
    if (!options.hasRecurrenceFields) delete payload.recurrence;
    if (!options.billing?.enabled) delete payload.billing;
    if (!options.expenses?.enabled) delete payload.expenses;
    if (options.stopRepeating) {
      const day = start || new Date();
      return {
        scope: 'all',
        event_id: payload.event_id,
        occurrence_key: payload.occurrence_key,
        recurrence: { end_at: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59).toISOString(), occurrence_count: null }
      };
    }
    return payload;
  }
  function recurrenceSummaryText(recurrence = {}){
    const rule = recurrence && typeof recurrence === 'object' ? recurrence : {};
    const frequency = clean(rule.frequency || 'monthly').toLowerCase();
    const interval = Math.max(1, Math.round(Number(rule.interval || 1) || 1));
    const units = { daily:['day', 'days', 'daily'], weekly:['week', 'weeks', 'weekly'], monthly:['month', 'months', 'monthly'], quarterly:['quarter', 'quarters', 'quarterly'], yearly:['year', 'years', 'yearly'] }[frequency] || ['month', 'months', 'monthly'];
    const cadence = interval === 1 ? `Repeats ${units[2]}` : `Repeats every ${interval} ${units[1]}`;
    const count = Math.round(Number(rule.occurrence_count) || 0);
    const endAt = clean(rule.end_at) ? new Date(rule.end_at) : null;
    // An end date (set when the series was ended or split) is the effective
    // limit even if the original rule also counted occurrences.
    const ending = endAt && Number.isFinite(endAt.getTime())
      ? `until ${endAt.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' })}`
      : count > 0
        ? `${count} time${count === 1 ? '' : 's'}`
        : 'no end date';
    return (globalThis.PlatformLanguage?.text("scheduling","m_recurrence_summary",`${cadence} · ${ending}`,{ cadence, ending }) ?? `${cadence} · ${ending}`);
  }
  // Saving an occurrence asks which part of the series the change is for.
  function showRecurrenceScopeChoice(options = {}){
    const pop = document.querySelector('.dash-event-popover');
    const actions = pop?.querySelector('.dash-event-pop-actions');
    if (!pop || !actions) return;
    pop.querySelector('[data-event-recurrence-scope]')?.remove();
    const toggle = pop.querySelector('[data-event-recurring]');
    const stopping = !!toggle && !toggle.checked;
    const text = (key, fallback) => globalThis.PlatformLanguage?.text("scheduling", key, fallback) ?? fallback;
    const choices = stopping
      ? [['this', text('m_scope_this_only', 'Keep repeating, save this event')], ['stop', text('m_scope_stop', 'End the series after this event')]]
      : [['this', text('m_scope_this', 'This event')], ['following', text('m_scope_following', 'This and following')], ['all', text('m_scope_all', 'All events')]];
    const box = document.createElement('div');
    box.className = 'dash-event-notice';
    box.setAttribute('data-event-recurrence-scope', '');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', text('m_scope_label', 'Apply changes to'));
    box.style.cssText = 'order:-1;flex:1 1 100%;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 2px';
    box.innerHTML = `<span style="flex:1 1 0;min-width:0">${escapeHtml(stopping ? text('m_scope_stop_label', 'Recurring is off for this event. What should happen to the series?') : text('m_scope_prompt', 'This event repeats. Apply your changes to:'))}</span><button type="button" class="dash-event-view-btn" data-event-scope-back style="height:28px">${escapeHtml(text('m_scope_back', 'Back'))}</button><span style="flex-basis:100%;height:0" aria-hidden="true"></span>${choices.map(([scope, label], index) => `<button type="button" class="${index === 0 ? 'dash-event-save' : 'dash-event-view-btn'}" data-event-scope="${scope}">${escapeHtml(label)}</button>`).join('')}`;
    actions.style.flexWrap = 'wrap';
    actions.insertBefore(box, actions.firstChild);
    // The choice sits in the sticky footer; keep the title and time (what is
    // being saved) in view above it.
    pop.scrollTop = 0;
    box.querySelectorAll('[data-event-scope]').forEach((button) => button.addEventListener('click', () => {
      const scope = button.getAttribute('data-event-scope');
      box.remove();
      saveEventEditor({ ...options, scope: scope === 'stop' ? 'all' : scope, stopRepeating: scope === 'stop' });
    }));
    box.querySelector('[data-event-scope-back]')?.addEventListener('click', () => {
      box.remove();
      pop.querySelector('[data-event-save]')?.focus();
    });
    box.querySelector('[data-event-scope]')?.focus();
  }
  async function saveRecurrenceSeriesEdit(ctx, seriesId, options = {}){
    const event = ctx.event || {};
    const api = window.PlatformAPI?.projects;
    if (!api?.updateRecurrenceSeries) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_0c17d9fba77f09","Could not save recurring item") ?? "Could not save recurring item"), 'Recurring series are not available.', false);
      return;
    }
    const payload = recurrencePayloadForEvent(event, options);
    closeEventDraftPopover();
    try {
      await api.updateRecurrenceSeries(orgId(), seriesId, payload);
      discardEventEditorDraft();
      if (ctx.editorOnly) clearPlacementSelection();
      eventDraftPopoverId = '';
      eventEditorEventId = '';
      eventDraftProjectQuery = '';
      render();
      await loadData({ force: true });
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
      const title = options.stopRepeating ? 'Series ended' : payload.scope === 'following' ? 'This and following events updated' : 'All events updated';
      const body = options.stopRepeating ? 'Occurrences after this event were removed.' : 'Occurrences you changed on their own keep their own changes.';
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_series_saved_title",title) ?? title), (globalThis.PlatformLanguage?.text("scheduling","m_series_saved_body",body) ?? body), true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_0c17d9fba77f09","Could not save recurring item") ?? "Could not save recurring item"), scheduleSaveErrorMessage(error, 'Try again.'), false);
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(event.id), { error }), 0);
    }
  }
  async function skipRecurrenceOccurrence(ctx, draft = {}, button = null){
    const seriesId = clean(draft.recurrence_series_id);
    const eventId = clean(draft.id);
    if (!seriesId || !eventId) return;
    if (!canEditSchedule()) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), scheduleReadOnlyMessage(), VIEW_ONLY_TOAST);
      return;
    }
    const api = window.PlatformAPI?.projects;
    if (!api?.updateRecurrenceOccurrence) return;
    const label = clean(draft.title || draft.project_title) || 'this occurrence';
    const approved = window.PlatformUI?.confirm
      ? await window.PlatformUI.confirm(`Skip “${label}” on ${formatEventDraftTime(draft)}? The rest of the series stays as it is.`, { title: 'Skip this occurrence', okLabel: 'Skip', cancelLabel: 'Keep it', danger:true, defaultFocus:'cancel' })
      : true;
    if (!approved) return;
    if (button) button.disabled = true;
    try {
      await api.updateRecurrenceOccurrence(orgId(), seriesId, eventId, 'skipped');
      discardEventEditorDraft();
      closeEventDraftPopover();
      if (ctx?.editorOnly) clearPlacementSelection();
      const hide = (item) => String(item?.id || '') === eventId ? { ...item, status:'cancelled' } : item;
      floatingEvents = floatingEvents.map(hide);
      allEvents = allEvents.map(hide);
      events = events.map(hide);
      eventDraftPopoverId = '';
      eventEditorEventId = '';
      eventDraftProjectQuery = '';
      render();
      await loadData({ force: true });
      showToast('Occurrence skipped', 'The rest of the series is unchanged.', true);
    } catch (error) {
      if (button) button.disabled = false;
      showToast('Could not skip occurrence', scheduleSaveErrorMessage(error, 'Try again.'), false);
    }
  }
  async function saveEventEditor(recurrenceOptions = {}){
    const ctx = eventEditorContext();
    if (!ctx) return;
    if (!canEditSchedule()) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), scheduleReadOnlyMessage(), VIEW_ONLY_TOAST);
      return;
    }
    // The title field is what the user sees: a company item's stored copy
    // falls back to its type name ("Other"), so an emptied field would
    // otherwise save that placeholder silently.
    const shownTitleInput = document.querySelector('.dash-event-popover [data-event-title]');
    const titleMissing = shownTitleInput && !shownTitleInput.disabled ? !clean(shownTitleInput.value) : !clean(ctx.event?.title);
    if (titleMissing && (ctx.kind === 'floating' || ctx.editorOnly)) {
      const titleInput = shownTitleInput;
      titleInput?.classList.add('invalid');
      titleInput?.setAttribute('aria-invalid', 'true');
      titleInput?.focus();
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_title_required","Add a title") ?? "Add a title"), (globalThis.PlatformLanguage?.text("scheduling","m_title_required_body","Give this event a title before saving.") ?? "Give this event a title before saving."), false);
      return;
    }
    const recurrenceSeriesId = clean(ctx.event?.recurrence_series_id);
    if (recurrenceSeriesId) {
      // An occurrence of a series: "This event" is an ordinary save of this
      // occurrence (kept as an exception); the other scopes edit the series.
      const options = { ...recurrenceOptions, hasRecurrenceFields: recurrenceOptions.hasRecurrenceFields ?? !!document.querySelector('.dash-event-popover [data-event-recurrence-frequency]') };
      if (!options.scope) {
        showRecurrenceScopeChoice(options);
        return;
      }
      if (options.scope === 'following' || options.scope === 'all') {
        await saveRecurrenceSeriesEdit(ctx, recurrenceSeriesId, options);
        return;
      }
    }
    if (ctx.kind === 'floating' && recurrenceOptions.enabled && !recurrenceSeriesId) {
      const payload = recurrencePayloadForEvent(ctx.event, recurrenceOptions);
      if (!payload.start_at) {
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_1de685e881b782","Choose a time first") ?? "Choose a time first"), (globalThis.PlatformLanguage?.text("scheduling","m_52ca64c3f28350","Recurring items need a first calendar date and time.") ?? "Recurring items need a first calendar date and time."), false);
        return;
      }
      closeEventDraftPopover();
      try {
        await window.PlatformAPI?.projects?.createRecurrenceSeries?.(orgId(), payload);
        floatingEvents = floatingEvents.filter((event) => String(event.id || '') !== String(ctx.event.id || ''));
        discardEventEditorDraft();
        eventDraftPopoverId = '';
        eventEditorEventId = '';
        eventDraftProjectQuery = '';
        render();
        await loadData({ force: true });
        showToast('Recurring item created', (globalThis.PlatformLanguage?.text("scheduling","m_bd00f676f7e893","Its upcoming calendar occurrences are ready.") ?? "Its upcoming calendar occurrences are ready."), true);
      } catch (error) {
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_0c17d9fba77f09","Could not save recurring item") ?? "Could not save recurring item"), scheduleSaveErrorMessage(error, 'Try again.'), false);
        setTimeout(() => renderEventDraftPopover(editorAnchorFor(ctx.event.id)), 0);
      }
      return;
    }
    if (ctx.kind === 'floating') {
      const disposable = floatingEventIsDisposableDraft(baseEventEditorContext()?.event || {});
      const original = floatingEvents.find((event) => String(event.id || '') === String(ctx.event?.id || '')) || null;
      const saveButton = document.querySelector('.dash-event-popover [data-event-save]');
      if (saveButton) saveButton.disabled = true;
      // Write only this editor's changes on top of the latest stored copy; a
      // change elsewhere to the same fields refuses the save and reopens the
      // editor on the latest version with the pending edits kept.
      let editedFloating = ctx.event;
      if (!disposable && original) {
        const ownGroups = eventChangeGroups(original, ctx.event);
        const check = await checkStoredScheduleEvent(original, ownGroups);
        if (check.conflict) { await handleStaleEditorSave(ctx.event.id); return; }
        if (check.fresh && check.remoteGroups.length) editedFloating = decorateFloatingEvent(mergeEventChanges(check.fresh, ctx.event, ownGroups));
      }
      // Another item opened while the check ran keeps its editor.
      const savedId = String(ctx.event?.id || '');
      const stillShown = editorStillShows(savedId);
      if (stillShown) closeEventDraftPopover();
      // An event saved without picking a type is stored as "Other" (custom),
      // never with an undefined type.
      const typeFields = eventTypeId(editedFloating) ? {} : { type_id:'custom', event_type_id:'custom', event_type_default_id:'custom' };
      const next = updateFloatingEvent({
        ...editedFloating,
        ...typeFields,
        __draft: false,
        __activeDraft: false,
        status: 'scheduled'
      });
      if (stillShown) {
        eventDraftPopoverId = '';
        eventEditorEventId = '';
        eventDraftProjectQuery = '';
      }
      render();
      try {
        const saved = await persistFloatingEvent(next);
        discardEventEditorDraft(savedId);
        updateFloatingEvent({
          ...next,
          ...saved,
          __draft: false,
          __activeDraft: false,
          status: 'scheduled'
        });
        render();
        const savedTitle = clean(next.title) || 'The event';
        showToast(
          disposable ? ((globalThis.PlatformLanguage?.text("scheduling","m_event_added","Event added") ?? "Event added")) : ((globalThis.PlatformLanguage?.text("scheduling","m_13c761fb4b644a","Event updated") ?? "Event updated")),
          disposable ? `${savedTitle} is on the calendar.` : 'Your changes are saved.',
          true
        );
      } catch (error) {
        // A failed save reopens its editor only if no other item was opened
        // in the meantime.
        const reopen = editorStillShows(savedId);
        if (!disposable && original && isStaleSaveError(error)) {
          floatingEvents = [original, ...floatingEvents.filter((event) => String(event.id || '') !== String(original.id || ''))];
          if (reopen) {
            eventDraftPopoverId = String(original.id || '');
            eventEditorEventId = '';
          }
          await handleStaleEditorSave(original.id, error);
          return;
        }
        // A persisted event goes back to its stored state; the edits stay on
        // the editor's draft copy so the user can retry or cancel them. A new
        // draft stays a draft.
        const draft = disposable || !original
          ? updateFloatingEvent({ ...next, __draft: true, __activeDraft: true, status: 'draft' })
          : original;
        if (!disposable && original) floatingEvents = [original, ...floatingEvents.filter((event) => String(event.id || '') !== String(original.id || ''))];
        if (reopen) {
          eventDraftPopoverId = draft.id;
          eventEditorEventId = '';
        }
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_90522d8e2312ca","Event not saved") ?? "Event not saved"), scheduleSaveErrorMessage(error, 'Could not save the event.'), false);
        render();
        if (reopen) setTimeout(() => renderEventDraftPopover(editorAnchorFor(draft.id), { error }), 0);
      }
      return;
    }
    if (ctx.editorOnly) {
      const next = ctx.event;
      let savePayload = next;
      const Scheduling = window.PlatformScheduling;
      if (!Scheduling || !ctx.project?.id || !next?.id) return;
      const saveButton = document.querySelector('.dash-event-popover [data-event-save]');
      if (saveButton) saveButton.disabled = true;
      // The editor stays open ("Saving…") until the server answers; a refused
      // save reopens it on the latest version with the edits kept.
      setEventEditorSaving(true);
      const stored = allEvents.find((event) => String(event.id || '') === String(next.id || '')) || null;
      // Only this editor's own changes are written, on top of the latest
      // stored copy (a colleague's new description or equipment survives).
      // A change elsewhere to the same fields refuses the save instead.
      if (stored) {
        const ownGroups = eventChangeGroups(stored, next);
        const check = await checkStoredScheduleEvent(stored, ownGroups);
        if (check.conflict) {
          await handleStaleEditorSave(next.id);
          return;
        }
        if (check.fresh && check.remoteGroups.length) savePayload = mergeEventChanges(check.fresh, next, ownGroups);
      }
      savePayload = withExplicitAssignees(savePayload);
      // A time change moves linked items the same way a drag does: the
      // dependency/scope rules compare the stored range with the new one.
      const rangeChanged = !!stored && (eventStart(stored)?.getTime() !== eventStart(next)?.getTime() || eventEnd(stored)?.getTime() !== eventEnd(next)?.getTime());
      const related = rangeChanged && typeof resolveRelatedReschedule === 'function'
        ? await resolveRelatedReschedule(stored, {
          start:eventStart(next),
          end:eventEnd(next),
          all_day:next.all_day === true || clean(next.schedule_granularity) === 'date',
          schedule_granularity:next.schedule_granularity || (next.all_day === true ? 'date' : 'time')
        })
        : { cancelled:false, changes:[], leftOutOfOrder:0 };
      if (related.cancelled) {
        setEventEditorSaving(false);
        return;
      }
      try {
        await Scheduling.saveProjectEvent(orgId(), ctx.project, savePayload, schedulingConfig);
        // Another item opened while the save ran keeps its editor.
        if (editorStillShows(next.id)) closeEventDraftPopover();
        discardEventEditorDraft(next.id);
        if (related.changes?.length && typeof saveRelatedRescheduleChanges === 'function') await saveRelatedRescheduleChanges(ctx.project, related.changes);
        if (rangeChanged && typeof persistGroupRollups === 'function') await persistGroupRollups(ctx.project, [next, ...(related.changes || [])]);
        // Only reset the editor if it still shows this item: the user may
        // have opened another one while the save was running.
        if (editorStillShows(next.id)) {
          clearPlacementSelection();
          eventEditorEventId = '';
          eventDraftProjectQuery = '';
        }
        await loadData({ force: true });
        const movedNote = related.changes?.length ? ` ${related.changes.length} linked item${related.changes.length === 1 ? ' was' : 's were'} moved too.` : '';
        // Mention customer sharing only when it actually changed.
        const sharingChanged = !!stored && (stored.customer_visible === true) !== (next.customer_visible === true);
        const savedNote = sharingChanged
          ? (next.customer_visible === true ? 'This event is now shared with the customer.' : 'This event is no longer shared with the customer.')
          : 'Your changes are saved.';
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_13c761fb4b644a","Event updated") ?? "Event updated"), `${savedNote}${movedNote}${typeof outOfOrderNote === 'function' ? outOfOrderNote(related.leftOutOfOrder) : ''}`, true);
      } catch (error) {
        if (isStaleSaveError(error)) { await handleStaleEditorSave(next.id, error); return; }
        if (error?.relatedFailures) {
          // The item itself was saved; only some linked items were not.
          if (editorStillShows(next.id)) closeEventDraftPopover();
          discardEventEditorDraft(next.id);
          if (editorStillShows(next.id)) eventEditorEventId = '';
          showToast('Some linked items were not moved', error.message, false);
          await loadData({ force:true });
          return;
        }
        // Nothing was applied to the live calendar; reopen the editor on the
        // same draft with the server's reason next to the fields.
        showToast((globalThis.PlatformLanguage?.text("scheduling","m_90522d8e2312ca","Event not saved") ?? "Event not saved"), scheduleSaveErrorMessage(error, 'Could not update the event.'), false);
        setTimeout(() => renderEventDraftPopover(editorAnchorFor(next.id), { error }), 0);
      }
      return;
    }
    // A placement draft: Save commits exactly like the draft's ✓. The editor
    // stays open with a busy Save until that finishes; a cancelled, failed or
    // timed-out save leaves it open on the kept draft.
    if (placementSaveBusy('save')) return;
    const placementPop = document.querySelector('.dash-event-popover');
    const placementSaveButton = placementPop?.querySelector('[data-event-save]');
    const placementSaveLabel = placementSaveButton?.innerHTML || '';
    if (placementSaveButton) {
      placementSaveButton.disabled = true;
      placementSaveButton.setAttribute('aria-busy', 'true');
      placementSaveButton.innerHTML = `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(globalThis.PlatformLanguage?.text("scheduling","m_placement_saving","Saving…") ?? "Saving…")}`;
    }
    try {
      if (ctx.kind === 'production') {
        if (!productionScheduleDraft?.start && ctx.event?.start) productionScheduleDraft = { ...(productionScheduleDraft || {}), ...ctx.event };
        // Same commit as the draft's ✓: a bundle places all of its items.
        if (productionScheduleBundleKey) await confirmProductionBundleDraft(productionScheduleDraft);
        else await confirmProductionDraft();
      } else if (ctx.kind === 'materials') {
        if (!materialScheduleDraft?.start && ctx.event?.start) materialScheduleDraft = { ...(materialScheduleDraft || {}), ...ctx.event };
        await confirmMaterialDraft();
      } else if (ctx.kind === 'sales') {
        if (!appointmentScheduleDraft?.start && ctx.event?.start) appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), start: ctx.event.start };
        await confirmDashboardDraft();
      }
    } finally {
      if (placementPop?.isConnected) {
        if (!placementWaitingItem()?.start) closeEventDraftPopover();
        else if (placementSaveButton?.isConnected) {
          placementSaveButton.disabled = false;
          placementSaveButton.removeAttribute('aria-busy');
          placementSaveButton.innerHTML = placementSaveLabel;
        }
      }
    }
  }
  /* Sections (schedule groups). Shared by the editor's Delete and the
   * Timeline's section delete: deleting a section keeps its items on the
   * schedule and ungroups them (parent_event_id cleared) so none points at a
   * section that no longer exists. */
  function sectionItems(sectionId = ''){
    const Scheduling = window.PlatformScheduling;
    const id = String(sectionId || '');
    return id ? allEvents.filter((item) => String(Scheduling?.eventParentId?.(item) || item.parent_event_id || '') === id) : [];
  }
  function sectionDeleteMessage(section = {}){
    const count = sectionItems(section.id).length;
    const label = clean(section.title) || 'this section';
    return count
      ? `Delete the section “${label}”? Its ${count} item${count === 1 ? '' : 's'} stay${count === 1 ? 's' : ''} on the schedule and ${count === 1 ? 'is' : 'are'} no longer grouped. This cannot be undone.`
      : `Delete the section “${label}”? It has no items. This cannot be undone.`;
  }
  // -> number of items ungrouped; throws when one of them could not be saved.
  async function ungroupSectionItems(project, sectionId = ''){
    const Scheduling = window.PlatformScheduling;
    const items = sectionItems(sectionId);
    let done = 0;
    for (const item of items) {
      const next = { ...item, parent_event_id:'', parentEventId:'', ...(item.metadata && typeof item.metadata === 'object' ? { metadata:{ ...item.metadata, parent_event_id:'' } } : {}), updated_at:new Date().toISOString() };
      await Scheduling.saveProjectEvent(orgId(), project, withExplicitAssignees(next), schedulingConfig);
      allEvents = allEvents.map((event) => String(event.id || '') === String(item.id || '') ? next : event);
      done += 1;
    }
    events = visibleEvents();
    return done;
  }
  /* Delete a section after confirmation; its items stay and are ungrouped.
   * -> true when deleted. */
  async function deleteScheduleSection(section = {}, project = null, options = {}){
    const Scheduling = window.PlatformScheduling;
    const sectionProject = project?.id ? project : eventProject(section);
    if (!section?.id || !sectionProject?.id || !Scheduling?.removeProjectEvent) return false;
    if (!canEditSchedule()) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), scheduleReadOnlyMessage(), { tone:'info' });
      return false;
    }
    // options.confirmed: the caller already asked (e.g. over the Timeline's
    // Edit section dialog).
    const approved = options.confirmed === true || (window.PlatformUI?.confirm
      ? await window.PlatformUI.confirm(sectionDeleteMessage(section), { title:'Delete section', okLabel:'Delete section', cancelLabel:'Keep section', danger:true, defaultFocus:'cancel' })
      : false);
    if (!approved) return false;
    try {
      const count = await ungroupSectionItems(sectionProject, section.id);
      await Scheduling.removeProjectEvent(orgId(), sectionProject, section.id, schedulingConfig);
      allEvents = allEvents.filter((event) => String(event.id || '') !== String(section.id));
      events = visibleEvents();
      await loadData({ force:true });
      showToast('Section deleted', count ? `${count} item${count === 1 ? ' is' : 's are'} no longer grouped.` : `${clean(section.title) || 'The section'} was removed.`, true);
      return true;
    } catch (error) {
      await loadData({ force:true });
      if (isStaleSaveError(error)) { changedElsewhereToast(error); return false; }
      showToast('Section not deleted', scheduleSaveErrorMessage(error, 'Could not delete the section.'), false);
      return false;
    }
  }
  async function deleteEventEditor(ctx, draft, button = null){
    const eventId = clean(draft?.id);
    if (!eventId || eventId.startsWith('__')) return;
    if (ctx.kind !== 'floating' && window.PlatformScheduling?.eventIsGroup?.(draft) === true) {
      // A section: its items stay and are ungrouped (shared with Timeline).
      if (button) button.disabled = true;
      const deleted = await deleteScheduleSection(allEvents.find((event) => String(event.id || '') === eventId) || draft, ctx.project);
      if (button) button.disabled = false;
      if (deleted && editorStillShows(eventId)) {
        discardEventEditorDraft(eventId);
        eventDraftPopoverId = '';
        eventEditorEventId = '';
        eventDraftProjectQuery = '';
        clearPlacementSelection();
        closeEventDraftPopover();
        render();
      }
      return;
    }
    const disposableFloatingDraft = ctx.kind === 'floating'
      && (draft.__draft === true || clean(draft.status).toLowerCase() === 'draft');
    const confirmDelete = window.PlatformUI?.confirm;
    if (!confirmDelete) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_fe99e3347c6980","Delete unavailable") ?? "Delete unavailable"), (globalThis.PlatformLanguage?.text("scheduling","m_f60adc85aab1a2","The styled confirmation system is not available.") ?? "The styled confirmation system is not available."), false);
      return;
    }
    const label = clean(draft.title || draft.project_title) || 'this event';
    // An occurrence of a series: only this one goes; the rest stay.
    const occurrence = !!clean(draft.recurrence_series_id);
    const approved = await confirmDelete(occurrence
      ? `Delete only this occurrence of “${label}” (${formatEventDraftTime(draft)})? The other events in the series stay. This cannot be undone.`
      : `Delete “${label}”? This cannot be undone.`, {
      title: (globalThis.PlatformLanguage?.text("scheduling","m_7f5580dbb3d648","Delete event") ?? "Delete event"),
      okLabel: 'Delete',
      cancelLabel: 'Keep event',
      danger: true
    });
    if (!approved) return;
    if (button) button.disabled = true;
    // Someone else changed the item since this view loaded it: deleting
    // would throw their change away unseen, so ask again.
    const loaded = disposableFloatingDraft ? null : (ctx.kind === 'floating' ? floatingEvents : allEvents).find((event) => String(event.id || '') === eventId);
    if (loaded) {
      const check = await checkStoredScheduleEvent(loaded, []);
      // Already deleted in another window: say so, as every other surface does.
      if (check.gone) {
        eventDraftPopoverId = '';
        eventEditorEventId = '';
        clearPlacementSelection();
        closeEventDraftPopover();
        await loadData({ force:true });
        showToast(
          (globalThis.PlatformLanguage?.text("scheduling","m_deleted_elsewhere","Deleted by someone else") ?? "Deleted by someone else"),
          `“${label}” was already deleted in another window.`,
          true
        );
        return;
      }
      if (check.fresh && check.remoteGroups.length) {
        const stillDelete = await confirmDelete(`“${label}” was changed by someone else since it was shown here. Delete it anyway?`, {
          title: (globalThis.PlatformLanguage?.text("scheduling","m_changed_elsewhere_delete","Changed by someone else — delete anyway?") ?? "Changed by someone else — delete anyway?"),
          okLabel: 'Delete anyway',
          cancelLabel: 'Keep event',
          danger: true,
          defaultFocus: 'cancel'
        });
        if (!stillDelete) {
          if (button) button.disabled = false;
          await loadData({ force:true });
          return;
        }
      }
    }
    try {
      let savedProject = null;
      if (ctx.kind === 'floating') {
        if (!disposableFloatingDraft) {
          if (!window.PlatformAPI?.calendarEvents?.remove) throw new Error('Calendar event deletion is not configured.');
          const removed = await window.PlatformAPI.calendarEvents.remove(orgId(), eventId);
          // A request that never reached the server reports "missing".
          if (removed?.missing) throw new Error('The event could not be deleted: the server could not be reached. Check your connection and try again.');
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
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_ad38658fe6f432","Event not deleted") ?? "Event not deleted"), scheduleSaveErrorMessage(error, 'Could not delete the event.'), false);
    }
  }
  /* Assignee editor inside the event popover: shows every current assignee
   * (a crew/group is ONE chip — a reference, never expanded to its members),
   * with remove buttons and an add-menu of policy-eligible subjects. Only for
   * persisted events and floating items; placement drafts keep their own
   * single-assignee flow. */
  function eventAssigneeSectionHtml(ctx, draft){
    // Equipment reservation/maintenance windows hold a unit, not people.
    if (isEquipmentWindowEvent(draft)) return '';
    const delivery = isMaterialEvent(draft) || eventTypeId(draft) === 'delivery';
    if (delivery && !eventAdvancedOpen) return '';
    // Rail placements (sales/production) show the assignee too: an unassigned
    // appointment is the reason it is still waiting (RAIL-15).
    if (ctx.editorOnly !== true && ctx.kind !== 'floating' && !['sales', 'production'].includes(ctx.kind) && !eventAdvancedOpen) return '';
    // Every crew/team and every person on the item is its own chip (a crew is
    // one reference, never expanded to its members).
    const crews = eventCrewRefs(draft);
    const assignees = editorAssignmentUserList(draft);
    const eligible = assignmentResourcesForEvent(draft);
    const eligibleIds = new Set(eligible.map((resource) => clean(resource.id)));
    const assigneeChip = (id, name, icon = '') => ("<span class=\"dash-event-assignee-chip " + String(eligibleIds.has(id) ? '' : 'warn') + "\" " + String(eligibleIds.has(id) ? '' : 'title="Not eligible for this event type — saving may be rejected"') + ">" + (icon ? `<i class="fas ${icon}" aria-hidden="true"></i> ` : '') + String(escapeHtml(name)) + "<button type=\"button\" data-event-assign-remove=\"" + String(escapeHtml(id)) + "\" aria-label=\"" + ((v4) => globalThis.PlatformLanguage?.text("scheduling","m_ab4ce544c27195",`Remove ${v4}`,{v4}) ?? `Remove ${v4}`)(escapeHtml(name)) + "\">" + (globalThis.PlatformLanguage?.text("scheduling","m_dd0c616953d455","&times;") ?? "&times;") + "</button></span>");
    const chips = [
      ...crews.map((crew) => assigneeChip(crew.id, crew.name || userDisplayName(crew.id), 'fa-users')),
      ...assignees.map((user) => assigneeChip(user.id, user.name))
    ].join('');
    // Work items list crews first, other items people first; each group
    // alphabetical.
    const isPerson = (resource) => clean(resource.subject_type || resource.resource_kind) === 'organization_user';
    const crewsFirst = isProductionEvent(draft);
    const options = eligible
      .filter((resource) => !crews.some((crew) => crew.id === clean(resource.id)) && !assignees.some((user) => user.id === clean(resource.id)))
      .slice()
      .sort((a, b) => ((isPerson(a) === crewsFirst ? 1 : 0) - (isPerson(b) === crewsFirst ? 1 : 0)) || clean(a.name).localeCompare(clean(b.name), undefined, { sensitivity:'base' }))
      .map((resource) => `<button type="button" data-event-assign-id="${escapeHtml(resource.id)}">${escapeHtml(resource.name)}${clean(resource.subject_type || resource.resource_kind) === 'organization_user' ? '' : ` <small>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_d3cad057a8d23c","(assigns the whole team as one unit)") ?? "(assigns the whole team as one unit)")}</small>`}</button>`)
      .join('');
    return `<div class="dash-event-assignees">
      <div class="dash-event-assignees-head"><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2f9d72baaebef0","Assigned") ?? "Assigned")}</strong><button type="button" class="dash-event-assign-add" data-event-assign-add aria-expanded="false"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8803dece55359d"," Add") ?? " Add")}</button></div>
      <div class="dash-event-assignee-chips">${String(chips || `<span class="dash-event-assignee-empty">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8a993ed9b573b4","Unassigned") ?? "Unassigned")}</span>`)}</div>
      <div class="dash-event-assign-menu" data-event-assign-menu hidden>${String(options || `<div class="dash-event-assignee-empty" style="padding:7px 9px;">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_0a906f5bfd87a7","Nobody else is eligible for this event type.") ?? "Nobody else is eligible for this event type.")}</div>`)}</div>
    </div>`;
  }
  function renderEventDraftPopover(anchor = null, renderOptions = {}){
    const ctx = eventEditorContext();
    if (!ctx) return;
    const draft = ctx.event || {};
    const project = ctx.project || {};
    // Re-rendering the same editor keeps its scroll position so a change
    // deep in the form (equipment, confirmation) stays in view.
    const previousPop = document.querySelector('.dash-event-popover');
    const previousScrollTop = previousPop && previousPop.dataset.eventId === String(draft.id || '') ? previousPop.scrollTop : 0;
    closeEventDraftPopover();
    const rect = anchor?.getBoundingClientRect?.() || editorAnchorFor(draft.id)?.getBoundingClientRect?.();
    const pop = document.createElement('div');
    pop.className = 'dash-event-popover';
    pop.dataset.eventId = String(draft.id || '');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("scheduling","m_event_editor","Event details") ?? "Event details"));
    // A cancelled item (shown greyed on the Timeline) is history: read-only.
    const cancelledItem = ['cancelled', 'canceled'].includes(clean(draft.status).toLowerCase());
    const readOnly = !canEditSchedule() || cancelledItem;
    const equipmentWindow = isEquipmentWindowEvent(draft);
    const saveError = renderOptions.error || null;
    const SchedulingLib = window.PlatformScheduling;
    // A section/group row spans its items, so its dates follow them: they are
    // shown read-only here (move the section bar or its items instead).
    const groupRow = !equipmentWindow && SchedulingLib?.eventIsGroup?.(draft) === true;
    const groupDerivedDates = groupRow && SchedulingLib?.groupRollupMode?.(draft) !== 'manual'
      && (SchedulingLib?.eventChildren?.(projectScheduleItems(draft.project_id), draft.id) || []).length > 0;
    const groupHasBar = groupDerivedDates && !!eventStart(draft);
    // A rail placement edits an unsaved draft: it never offers Delete/Lock of
    // the stored record behind it.
    const placementContext = ctx.kind !== 'floating' && ctx.editorOnly !== true;
    if (readOnly) pop.classList.add('read-only');
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
    // A never-saved event has nothing to delete (Close discards it).
    // A work item/section just added from the Timeline is not stored until
    // Save: nothing to delete or lock yet (Close discards it).
    const unsavedTimelineItem = !!ganttPendingNewItem && ganttPendingNewItem.id === String(draft.id || '');
    const canDelete = !!clean(draft.id)
      && !clean(draft.id).startsWith('__')
      && !unsavedTimelineItem
      && (ctx.kind === 'floating' ? persistedFloatingEvent : (!!project?.id && !placementContext));
    // Equipment reservation/maintenance windows are not locked like work.
    const canToggleLock = (!!project?.id || persistedFloatingEvent)
      && !placementContext
      && !unsavedTimelineItem
      && !equipmentWindow
      && !!clean(draft.id)
      && !clean(draft.id).startsWith('__')
      && draft.__draft !== true;
    // Locked items keep their time: the time fields stay read-only until the
    // item is unlocked (the server rejects time changes on locked items).
    const lockedTime = eventIsLocked(draft) && !disposableFloatingDraft;
    const rawLockReason = clean(draft.schedule_lock?.reason) === 'material_order' || (isMaterialEvent(draft) && materialEventIsOrdered(draft))
      ? 'Materials are ordered for this delivery'
      : clean(draft.locked_reason || draft.schedule_lock?.note || '');
    const lockReason = rawLockReason ? `${rawLockReason.replace(/[.\s]+$/, '')}.` : '';
    const titleEdited = (!!eventEditorDraft && String(eventEditorDraft.id || '') === String(draft.id || '') && Object.prototype.hasOwnProperty.call(eventEditorDraft.patch || {}, 'title'))
      // A placement draft's retyped title (even emptied) stays in the field.
      || (placementContext && draft.title_is_custom === true && typeof draft.title === 'string');
    const titleValue = titleEdited ? clean(draft.title) : clean(draft.title || draft.project_title || '');
    const errorLines = saveError ? scheduleSaveErrorLines(saveError) : [];
    const noticeHtml = [
      readOnly ? `<div class="dash-event-notice" role="note"><i class="fas fa-${cancelledItem ? 'ban' : 'eye'}" aria-hidden="true"></i><span>${escapeHtml(cancelledItem ? 'This item was cancelled. It is shown for reference and can’t be changed.' : scheduleReadOnlyMessage())}</span></div>` : '',
      !readOnly && lockedTime ? `<div class="dash-event-notice locked" role="note"><i class="fas fa-lock" aria-hidden="true"></i><span>${escapeHtml(isMaterialEvent(draft) ? 'This delivery date is locked.' : 'This schedule item is locked.')} ${escapeHtml(lockReason)} ${escapeHtml('Unlock it to change the time.')}</span></div>` : '',
      renderOptions.stale ? `<div class="dash-event-notice locked" role="alert" data-event-stale-notice><i class="fas fa-rotate" aria-hidden="true"></i><span>${escapeHtml(globalThis.PlatformLanguage?.text("scheduling","m_changed_elsewhere_editor","Changed by someone else. This shows the latest saved version with your unsaved changes on top. Review them and Save again.") ?? "Changed by someone else. This shows the latest saved version with your unsaved changes on top. Review them and Save again.")}</span></div>` : '',
      !readOnly && groupDerivedDates ? `<div class="dash-event-notice" role="note" data-event-group-dates><i class="fas fa-layer-group" aria-hidden="true"></i><span>${escapeHtml(groupHasBar ? (globalThis.PlatformLanguage?.text("scheduling","m_group_dates_derived","This section's dates come from the items in it. Drag the section bar on the calendar to move them all, or change the items themselves.") ?? "This section's dates come from the items in it. Drag the section bar on the calendar to move them all, or change the items themselves.") : "This section's dates come from the items in it. Schedule its items to give it dates.")}</span></div>` : '',
      saveError ? `<div class="dash-event-notice error" role="alert" data-event-save-error><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><span>${escapeHtml(errorLines.length ? 'Not saved:' : `Not saved: ${scheduleSaveErrorMessage(saveError)}`)}${errorLines.length ? `<ul>${errorLines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : ''}</span></div>` : ''
    ].join('');
    const equipmentNames = equipmentWindow ? eventEquipRefs(draft).map((ref) => clean(ref.name) || clean(equipmentUnits.find((unit) => clean(unit.id) === clean(ref.id))?.name) || clean(ref.id)).filter(Boolean) : [];
    const equipmentWindowHtml = equipmentWindow
      ? `<div class="dash-event-equipment-meta"><span><i class="fas fa-truck-pickup" aria-hidden="true"></i> ${escapeHtml(equipmentNames.join(', ') || 'Equipment')}</span><small>${escapeHtml(isVehicleBooking(draft) ? `Booked for ${clean(draft.vehicle_crew_name) || clean(workforceResources.find((resource) => clean(resource.id) === clean(draft.vehicle_crew_id))?.name) || 'a crew'} — shown in that crew's vehicle lane in Routing.` : eventTypeId(draft) === 'equipment_reservation' || eventKind(draft) === 'equipment_reservation' ? 'Reserved — not available for other bookings in this window.' : 'Out of service — not available for bookings in this window.')}</small></div>`
      : '';
    const editorAllDay = draft.all_day === true || clean(draft.schedule_granularity).toLowerCase() === 'date';
    const timeInputType = editorAllDay ? 'date' : 'datetime-local';
    const timeValue = editorAllDay ? dateInputValue : dateTimeLocalValue;
    const draftRecurrence = draft.recurrence && typeof draft.recurrence === 'object' ? draft.recurrence : {};
    const recurrenceFrequency = clean(draftRecurrence.frequency || 'monthly') || 'monthly';
    const recurrenceInterval = Math.max(1, Math.round(Number(draftRecurrence.interval || 1) || 1));
    const recurrenceEndMode = Number(draftRecurrence.occurrence_count) > 0 ? 'count' : (clean(draftRecurrence.end_at) ? 'date' : 'never');
    const recurrenceEndDate = clean(draftRecurrence.end_at).slice(0, 10);
    const recurrenceCount = Math.max(1, Math.round(Number(draftRecurrence.occurrence_count || 1) || 1));
    const recurrenceEnabled = draft.__recurrence_enabled === false ? false : (clean(draft.recurrence_series_id) || draft.__recurrence_enabled === true);
    const recurrenceSeriesInfoHtml = clean(draft.recurrence_series_id)
      ? `<div class="dash-event-recurrence-note" data-event-recurrence-summary><i class="fas fa-repeat" aria-hidden="true"></i> ${escapeHtml(recurrenceSummaryText(draftRecurrence))}. ${(globalThis.PlatformLanguage?.htmlText("scheduling","m_series_save_hint","Saving asks whether to change this event, this and following, or all events.") ?? "Saving asks whether to change this event, this and following, or all events.")}</div>${canEditSchedule() && !clean(draft.id).startsWith('__') ? `<button type="button" class="dash-event-view-btn" data-event-occurrence-skip style="grid-column:1/-1;justify-self:start"><i class="fas fa-forward" aria-hidden="true"></i> ${(globalThis.PlatformLanguage?.htmlText("scheduling","m_skip_occurrence","Skip this occurrence") ?? "Skip this occurrence")}</button>` : ''}`
      : '';
    pop.innerHTML = `
      <div class="dash-event-pop-head">
        <input class="dash-event-title-input" data-event-title value="${String(escapeHtml(titleValue))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_e070e90d9c7a33","Event title") ?? "Event title")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_e070e90d9c7a33","Event title") ?? "Event title")}">
        <button type="button" class="dash-event-close" data-event-cancel aria-label="${!readOnly && (ctx.kind === 'floating' || ctx.editorOnly) ? (globalThis.PlatformLanguage?.htmlText("scheduling","m_close_discard","Close without saving") ?? "Close without saving") : (globalThis.PlatformLanguage?.htmlText("scheduling","m_close","Close") ?? "Close")}" title="${!readOnly && (ctx.kind === 'floating' || ctx.editorOnly) ? (globalThis.PlatformLanguage?.htmlText("scheduling","m_close_discard","Close without saving") ?? "Close without saving") : (globalThis.PlatformLanguage?.htmlText("scheduling","m_close","Close") ?? "Close")} (Esc)"><i class="fas fa-xmark"></i></button>
        <div class="dash-event-pop-meta">
          ${String(equipmentWindow ? '' : projectNameRowHtml)}
          ${String(equipmentWindow ? '' : `<div class="dash-event-pop-address">${escapeHtml(projectAddressLabel)}</div>`)}
          <div class="dash-event-pop-time">${String(escapeHtml(formatEventDraftTime(draft)))}</div>
        </div>
        <div class="dash-event-time-fields">
          <label class="dash-event-time-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_5a35275926b722","Start") ?? "Start")}<input type="${String(timeInputType)}" data-event-start value="${String(escapeHtml(timeValue(eventStart(draft))))}"></label>
          <label class="dash-event-time-field">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_80cfdb09a78f4b","End") ?? "End")}<input type="${String(timeInputType)}" data-event-end value="${String(escapeHtml(timeValue(editorDisplayEnd(draft))))}"></label>
        </div>
        <div class="dash-event-time-options">
          ${String(equipmentWindow && !editorAllDay ? '' : `<label class="dash-event-switch"><input type="checkbox" data-event-allday ${String(editorAllDay ? 'checked' : '')}><span class="dash-event-switch-track" aria-hidden="true"></span><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_42b02bf1587e27","All day") ?? "All day")}</span></label>`)}
          ${String(ctx.kind === 'floating' && !equipmentWindow ? `<label class="dash-event-switch"><input type="checkbox" data-event-recurring ${recurrenceEnabled ? 'checked' : ''}><span class="dash-event-switch-track" aria-hidden="true"></span><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_14bec9b094ca21","Recurring") ?? "Recurring")}</span></label>` : '')}
        </div>
        ${String(ctx.kind === 'floating' ? `<div class="dash-event-recurrence-fields ${recurrenceEnabled ? 'open' : ''}" data-event-recurrence-fields>
          <label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_477ebb1c6c5f83","Repeats") ?? "Repeats")}<select data-event-recurrence-frequency><option value="weekly" ${recurrenceFrequency === 'weekly' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_093d55e6272fc0","Weekly") ?? "Weekly")}</option><option value="monthly" ${recurrenceFrequency === 'monthly' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_d7014f792d2583","Monthly") ?? "Monthly")}</option><option value="quarterly" ${recurrenceFrequency === 'quarterly' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_03e59d03617275","Quarterly") ?? "Quarterly")}</option><option value="yearly" ${recurrenceFrequency === 'yearly' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_ef289ba5429ef5","Yearly") ?? "Yearly")}</option><option value="daily" ${recurrenceFrequency === 'daily' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_aa2628166dd6f2","Daily") ?? "Daily")}</option></select></label>
          <label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_b25bba33f32e79","Every") ?? "Every")}<input type="number" min="1" max="120" value="${escapeHtml(recurrenceInterval)}" data-event-recurrence-interval></label>
          <label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_949158d13efad4","Ends") ?? "Ends")}<select data-event-recurrence-end-mode><option value="never" ${recurrenceEndMode === 'never' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_35304e673f218d","Never") ?? "Never")}</option><option value="date" ${recurrenceEndMode === 'date' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_ab4cb92c128c9b","On a date") ?? "On a date")}</option><option value="count" ${recurrenceEndMode === 'count' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_after_n_times","After N times") ?? "After N times")}</option></select></label>
          <label data-event-recurrence-end-date ${recurrenceEndMode === 'date' ? '' : 'hidden'}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_75319fcfef3f5e","End date") ?? "End date")}<input type="date" value="${escapeHtml(recurrenceEndDate)}" data-event-recurrence-end></label>
          <label data-event-recurrence-end-count ${recurrenceEndMode === 'count' ? '' : 'hidden'}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_328e02d666e842","Occurrences") ?? "Occurrences")}<input type="number" min="1" max="240" value="${escapeHtml(recurrenceCount)}" data-event-recurrence-count></label>
          ${project?.id ? `<label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_07092d81e20aa1","Charge each time") ?? "Charge each time")}<input type="number" min="0" step="0.01" placeholder="$0.00" data-event-billing-amount></label>
            <label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8392c3fac72956","Bill cadence") ?? "Bill cadence")}<select data-event-billing-frequency><option value="monthly">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_d7014f792d2583","Monthly") ?? "Monthly")}</option><option value="quarterly">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_03e59d03617275","Quarterly") ?? "Quarterly")}</option><option value="yearly">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_ef289ba5429ef5","Yearly") ?? "Yearly")}</option></select></label>
            <label>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_1afa80926cecc4","Cost per visit") ?? "Cost per visit")}<input type="number" min="0" step="0.01" placeholder="$0.00" data-event-expense-amount></label>` : `<div class="dash-event-recurrence-note">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_50ffa923d4cef5","Assign a project to add recurring billing and per-visit costs.") ?? "Assign a project to add recurring billing and per-visit costs.")}</div>`}
          ${recurrenceSeriesInfoHtml}
        </div>` : (recurrenceSeriesInfoHtml ? `<div class="dash-event-recurrence-fields open" data-event-recurrence-series>${recurrenceSeriesInfoHtml}</div>` : ''))}
      </div>
      ${String(noticeHtml)}
      ${String(ctx.kind === 'floating' && !equipmentWindow ? `<div class="dash-event-type-row" role="group" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_event_type","Event type") ?? "Event type")}">
          ${typeButton('sales_appointment', 'Sales')}
          ${typeButton('project_work', 'Work')}
          ${typeButton('delivery', 'Delivery')}
          ${['', 'sales_appointment', 'project_work', 'delivery'].includes(activeType) ? typeButton('custom', 'Other') : `<button type="button" class="dash-event-type-btn active" data-event-type="${escapeHtml(activeType)}">${escapeHtml(typeMeta.label)}</button>`}
        </div>` : `${equipmentWindowHtml}<div class="dash-event-type-pills"><span class="dash-event-type-pill">${escapeHtml(typeMeta.label)}</span>${materialNotOrdered ? `<span class="dash-event-status-pill">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_0c10cb9ccabd39","Not ordered yet") ?? "Not ordered yet")}</span>` : ''}${confirmationPillHtml(draft)}</div>`)}
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
      ${String(ctx.kind === 'floating' && !equipmentWindow && !readOnly ? `<div class="dash-event-project-picker"><div class="dash-event-project-picker-row"><input class="dash-event-search" data-event-project-search value="${escapeHtml(eventDraftProjectQuery)}" placeholder="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_90a374781263be","Search to assign a project") ?? "Search to assign a project")}" autocomplete="off"><button type="button" class="dash-event-project-create" data-event-project-create aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_89250227eee734","Create a new project") ?? "Create a new project")}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_89250227eee734","Create a new project") ?? "Create a new project")}"><i class="fas fa-plus"></i></button></div>
        <div class="dash-event-project-list" data-event-project-results ${clean(eventDraftProjectQuery) ? '' : 'hidden'}>
          ${results.map((project) => `<button type="button" class="dash-event-project-option" data-event-project-id="${escapeHtml(project.id || '')}">
            <strong>${escapeHtml(projectTitle(project))}</strong>
            <span>${escapeHtml([project.address, project.customer_phone || project.phone].map(clean).filter(Boolean).join(' - ') || 'No address')}</span>
          </button>`).join('') || (clean(eventDraftProjectQuery) ? `<div class="dash-empty" style="padding:12px;">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_0e31fa9fe147f8","No matching projects.") ?? "No matching projects.")}</div>` : '')}
        </div></div>` : '')}
      <div class="dash-event-pop-actions">
        <span style="display:flex;gap:7px"><button type="button" class="dash-event-advanced-toggle ${String(eventAdvancedOpen ? 'active' : '')}" data-event-advanced aria-label="${((v21) => globalThis.PlatformLanguage?.htmlText("scheduling","m_407444280ca9bb",`${v21} advanced event fields`,{v21}) ?? `${v21} advanced event fields`)(eventAdvancedOpen ? 'Hide' : 'Show')}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_bec5274b269a70","Advanced event fields") ?? "Advanced event fields")}" aria-pressed="${String(eventAdvancedOpen ? 'true' : 'false')}"><i class="fas fa-sliders"></i></button>${String(canDelete && !readOnly ? `<button type="button" class="dash-event-delete" data-event-delete><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_90e27d705bee80"," Delete") ?? " Delete")}</button>` : '')}${String(project?.id ? `<button type="button" class="dash-event-view-btn" data-event-view-project>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_438062886ff2f5","View Project") ?? "View Project")}</button>` : '')}${String(canToggleLock && !readOnly ? `<button type="button" class="dash-event-view-btn" data-event-lock-toggle aria-pressed="${eventIsLocked(draft) ? 'true' : 'false'}" title="${eventIsLocked(draft) ? 'Unlock to allow time changes' : 'Protect the scheduled time from changes'}"><i class="fas fa-${eventIsLocked(draft) ? 'lock' : 'lock-open'}"></i> ${eventIsLocked(draft) ? 'Unlock' : 'Lock'}</button>` : '')}</span>
        ${String(readOnly ? '' : `<button type="button" class="dash-event-save" data-event-save ${String(canSave ? '' : 'disabled')}>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_5bab3e72de1ebf","Save") ?? "Save")}</button>`)}
      </div>
    `;
    document.body.appendChild(pop);
    // The editor may use the whole scheduling body (calendar and rail) so it
    // can sit beside the item it edits instead of covering it.
    const schedulingViewport = rootEl?.querySelector('.dash-body')
      || rootEl?.querySelector('.dash-left')
      || rootEl?.querySelector('#dashEventCalendarView')
      || rootEl;
    const rawContentRect = schedulingViewport?.getBoundingClientRect?.()
      || { left: 8, right: window.innerWidth - 8, top: 8, bottom: window.innerHeight - 8 };
    const contentRect = {
      left:Math.max(0, Number(rawContentRect.left || 0)),
      right:Math.min(window.innerWidth, Number(rawContentRect.right || window.innerWidth)),
      top:Math.max(0, Number(rawContentRect.top || 0)),
      bottom:Math.min(window.innerHeight, Number(rawContentRect.bottom || window.innerHeight))
    };
    // A floating placement banner (bottom of the calendar) stays readable:
    // the editor keeps above it instead of covering its text and Cancel.
    const bannerRect = rootEl?.querySelector?.('[data-placement-banner]')?.getBoundingClientRect?.();
    if (bannerRect && bannerRect.height > 0 && bannerRect.top > contentRect.top + (contentRect.bottom - contentRect.top) / 2) {
      contentRect.bottom = Math.min(contentRect.bottom, bannerRect.top - 6);
    }
    const width = Math.min(420, Math.max(0, Number(contentRect.right || window.innerWidth) - Number(contentRect.left || 0) - 16), window.innerWidth - 16);
    const height = Math.min(620, Math.max(0, Number(contentRect.bottom || window.innerHeight) - Number(contentRect.top || 0) - 16), window.innerHeight - 16);
    pop.style.width = `${width}px`;
    pop.style.height = `${height}px`;
    const minLeft = Math.max(8, Number(contentRect.left || 8) + 8);
    const maxLeft = Math.max(minLeft, Math.min(window.innerWidth - width - 8, Number(contentRect.right || window.innerWidth) - width - 8));
    const minTop = Math.max(8, Number(contentRect.top || 8) + 8);
    const maxTop = Math.max(minTop, Math.min(window.innerHeight - height - 8, Number(contentRect.bottom || window.innerHeight) - height - 8));
    // The visible part of the item (a tall bar can extend past the screen).
    const itemRect = rect ? {
      left:Math.max(0, rect.left), right:Math.min(window.innerWidth, rect.right),
      top:Math.max(0, rect.top), bottom:Math.min(window.innerHeight, rect.bottom)
    } : null;
    const overlapWith = (x, y) => {
      if (!itemRect) return 0;
      const w = Math.max(0, Math.min(x + width, itemRect.right) - Math.max(x, itemRect.left));
      const h = Math.max(0, Math.min(y + height, itemRect.bottom) - Math.max(y, itemRect.top));
      return w * h;
    };
    let left = maxLeft;
    let top = Math.max(minTop, Math.min(maxTop, 90));
    if (itemRect) {
      const centeredTop = Math.max(minTop, Math.min(maxTop, itemRect.top + ((itemRect.bottom - itemRect.top) / 2) - (height / 2)));
      // Beside the item (left first, then right); otherwise the spot that
      // covers the least of it, including above/below it.
      const candidates = [
        { x:itemRect.left - width - 10, y:centeredTop },
        { x:itemRect.right + 10, y:centeredTop },
        { x:minLeft, y:centeredTop },
        { x:maxLeft, y:centeredTop },
        { x:Math.max(minLeft, Math.min(maxLeft, itemRect.left)), y:itemRect.bottom + 10 },
        { x:Math.max(minLeft, Math.min(maxLeft, itemRect.left)), y:itemRect.top - height - 10 }
      ].map((spot) => ({ x:Math.max(minLeft, Math.min(maxLeft, spot.x)), y:Math.max(minTop, Math.min(maxTop, spot.y)) }));
      const best = candidates.reduce((winner, spot) => (overlapWith(spot.x, spot.y) < overlapWith(winner.x, winner.y) ? spot : winner), candidates[0]);
      left = best.x;
      top = best.y;
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.querySelectorAll('[data-event-type]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.eventType || '';
      const meta = eventTypeMeta(id);
      const editCtx = eventEditorContext();
      const current = editCtx?.event || draft;
      stageEditorEdit(editCtx || ctx, {
        type_id: id,
        event_type_id: id,
        event_type_default_id: id,
        title: shouldAutoTitle(current) ? meta.title : current.title,
        project_title: current.project_id ? current.project_title : (shouldAutoTitle(current) ? meta.title : current.project_title),
        title_is_custom: current.title_is_custom === true
      });
      if (!editorUsesDraftCopy(editCtx || ctx)) render();
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(current.id)), 0);
    }));
    pop.querySelector('[data-event-title]')?.addEventListener('input', (event) => updateEditorTitle(event.target.value || ''));
    pop.querySelector('[data-event-description]')?.addEventListener('input', (event) => updateEditorDescription(event.target.value || ''));
    bindEventEquipmentSection(pop, draft);
    bindConfirmationEditor(pop, draft);
    bindCustomerSchedulingEditor(pop);
    pop.querySelector('[data-event-advanced]')?.addEventListener('click', () => {
      eventAdvancedOpen = !eventAdvancedOpen;
      renderEventDraftPopover(editorAnchorFor(draft.id));
      // The redrawn button (still under the pointer, and refocused) would
      // show its tooltip again over the fields it just revealed: keep it
      // quiet until the pointer leaves or focus moves on.
      window.PlatformUI?.hideTooltip?.();
      const next = document.querySelector('.dash-event-popover [data-event-advanced]');
      const tip = next?.getAttribute('data-fm-tooltip') || next?.getAttribute('title') || '';
      if (next && tip) {
        ['title', 'data-fm-tooltip', 'data-fm-native-title'].forEach((name) => next.removeAttribute(name));
        const restore = () => { if (next.isConnected && !next.hasAttribute('data-fm-tooltip')) next.setAttribute('title', tip); };
        next.addEventListener('mouseleave', restore, { once:true });
        next.addEventListener('blur', restore, { once:true });
      }
    });
    // Every accepted edit re-syncs both fields and the summary line; a cleared
    // or invalid value snaps back to the stored time instead of drifting.
    pop.querySelector('[data-event-start]')?.addEventListener('change', (event) => { updateEditorRange('start', event.target.value || ''); syncEditorTimeFields(pop); });
    pop.querySelector('[data-event-end]')?.addEventListener('change', (event) => { updateEditorRange('end', event.target.value || ''); syncEditorTimeFields(pop); });
    pop.querySelector('[data-event-title]')?.addEventListener('input', (event) => { event.target.classList.toggle('invalid', false); event.target.removeAttribute('aria-invalid'); });
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
      // Adding appends to the explicit set; groups are one reference each,
      // never fanned out to their members.
      const id = clean(resource.id);
      const crews = eventCrewRefs(current).filter((crew) => crew.id !== id);
      const people = editorAssignmentUserList(current).filter((user) => user.id !== id);
      if (clean(resource.subject_type || resource.resource_kind) === 'organization_user') people.push({ id, name:clean(resource.name) || userDisplayName(id) });
      else crews.push({ id, name:clean(resource.name) || id, kind:clean(resource.work_resource_ref?.kind || resource.resource_kind || resource.subject_type) || 'resource_group' });
      applyEditorPatch(assigneeSetPatch(current, crews, people));
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(current.id)), 0);
    }));
    pop.querySelectorAll('[data-event-assign-remove]').forEach((btn) => btn.addEventListener('click', () => {
      const current = eventEditorContext()?.event || draft;
      const removeId = clean(btn.dataset.eventAssignRemove);
      applyEditorPatch(assigneeSetPatch(current, eventCrewRefs(current).filter((crew) => crew.id !== removeId), editorAssignmentUserList(current).filter((user) => user.id !== removeId)));
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
      const editCtx = eventEditorContext();
      const current = editCtx?.event || draft;
      rememberFloatingProjectAssignment(current);
      stageEditorEdit(editCtx || ctx, {
        project_id: selectedProject.id || '',
        project_title: projectTitle(selectedProject),
        project_address: projectAddress(selectedProject, {}),
      });
      eventDraftProjectQuery = '';
      if (!editorUsesDraftCopy(editCtx || ctx)) render();
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(current.id)), 0);
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
      const editCtx = eventEditorContext();
      const current = editCtx?.event || draft;
      rememberFloatingProjectAssignment(current);
      stageEditorEdit(editCtx || ctx, { project_id:'', project_title:'', project_address:'' });
      eventDraftProjectQuery = '';
      if (!editorUsesDraftCopy(editCtx || ctx)) render();
      setTimeout(() => renderEventDraftPopover(editorAnchorFor(current.id)), 0);
    });
    pop.querySelector('[data-event-project-create]')?.addEventListener('click', () => {
      closeEventDraftPopover();
      window.dispatchEvent(new CustomEvent('fm:new-project-workflow', { detail:{ workflow:'project', source:'scheduling-event' } }));
    });
    // View Project opens the project window on this item's week and closes
    // the editor (it would otherwise stay open underneath and catch Escape).
    pop.querySelector('[data-event-view-project]')?.addEventListener('click', async () => {
      window.PlatformUI?.hideTooltip?.();
      if (!project?.id) return;
      const current = eventEditorContext()?.event || draft;
      const dirty = !readOnly && ((!!eventEditorDraft && String(eventEditorDraft.id || '') === String(current.id || '') && Object.keys(eventEditorDraft.patch || {}).length > 0)
        || (ctx.kind === 'floating' && floatingEventIsDisposableDraft(current)));
      if (dirty && window.PlatformUI?.confirm) {
        const discard = await window.PlatformUI.confirm('You have unsaved changes to this event. Discard them and open the project?', { title:'Unsaved changes', okLabel:'Discard and open', cancelLabel:'Keep editing', danger:true, defaultFocus:'cancel' });
        if (!discard) return;
      }
      cancelEventEditor();
      openProjectFromEvent({ ...current, project_id:project.id });
    });
    // Lock/unlock applies to the stored item right away and keeps the editor
    // (and any unsaved edits on its draft) open with the new lock state.
    pop.querySelector('[data-event-lock-toggle]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const stored = floatingEvents.find((item) => String(item.id || '') === String(draft.id || ''))
        || allEvents.find((item) => String(item.id || '') === String(draft.id || ''))
        || draft;
      button.disabled = true;
      button.innerHTML = `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ${eventIsLocked(stored) ? 'Unlocking…' : 'Locking…'}`;
      await toggleScheduleEventLock(stored);
      if (document.querySelector('.dash-event-popover') === pop || !document.querySelector('.dash-event-popover')) {
        renderEventDraftPopover(editorAnchorFor(draft.id));
      }
    });
    pop.querySelector('[data-event-delete]')?.addEventListener('click', (event) => deleteEventEditor(ctx, draft, event.currentTarget));
    pop.querySelector('[data-event-recurring]')?.addEventListener('change', (event) => {
      const enabled = event.target.checked === true;
      const current = eventEditorContext()?.event || draft;
      if (ctx.kind === 'floating') stageEditorEdit(eventEditorContext() || ctx, { __recurrence_enabled:enabled });
      pop.querySelector('[data-event-recurrence-fields]')?.classList.toggle('open', enabled);
    });
    pop.querySelector('[data-event-occurrence-skip]')?.addEventListener('click', (event) => skipRecurrenceOccurrence(ctx, draft, event.currentTarget));
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
      cancelEventEditor({ restoreFocus:true });
    });
    if (readOnly) {
      // View-only sessions see every field but can't change any of them.
      pop.querySelectorAll('input,textarea,select').forEach((field) => { field.disabled = true; });
      pop.querySelectorAll('button').forEach((button) => {
        if (!button.matches('[data-event-cancel],[data-event-view-project],[data-event-advanced],[data-event-customer-details-toggle]')) button.disabled = true;
      });
      pop.querySelectorAll('[data-equipment-picker]').forEach((picker) => { picker.hidden = true; });
    } else if (lockedTime) {
      pop.querySelectorAll('[data-event-start],[data-event-end],[data-event-allday],[data-event-recurring],[data-event-equipment-start],[data-event-equipment-end]').forEach((field) => {
        field.disabled = true;
        field.title = 'Unlock this item to change its time.';
      });
    } else if (groupDerivedDates) {
      pop.querySelectorAll('[data-event-start],[data-event-end],[data-event-allday]').forEach((field) => {
        field.disabled = true;
        field.title = groupHasBar ? 'A section spans its items: move the section bar or its items to change these dates.' : 'A section spans its items: schedule its items to give it dates.';
      });
    }
    if (previousScrollTop) pop.scrollTop = previousScrollTop;
    // A freshly opened editor takes keyboard focus (title, or Close when
    // view-only); a re-render keeps whatever field the user was in.
    if (!previousPop && !isMobileScheduleLayout()) {
      (pop.querySelector('[data-event-title]:not(:disabled)') || pop.querySelector('[data-event-cancel]'))?.focus({ preventScroll:true });
    }
    if (saveError && scheduleSaveErrorLines(saveError).length && Array.isArray(saveError?.data?.details?.conflicts)) {
      // Equipment conflicts: bring the equipment list into view next to the
      // server's per-unit explanation.
      requestAnimationFrame(() => pop.querySelector('[data-event-equipment]')?.scrollIntoView?.({ block:'nearest' }));
    }
    if (!isMobileScheduleLayout()) setTimeout(() => {
      if (!pop.isConnected || eventDraftDocHandler) return;
      eventDraftDocHandler = bindOutsidePointerDismiss(pop, dismissEventEditor, [anchor].filter(Boolean));
    }, 0);
    eventDraftKeyHandler = (event) => {
      if (event.key === 'Escape') {
        handleEventEditorEscape(pop, event);
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || String(event.key || '').toLowerCase() !== 'z') return;
      if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      if (!restoreFloatingProjectAssignment()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('keydown', eventDraftKeyHandler, true);
  }
  function formatEventDraftTime(event){
    const start = eventStart(event);
    const dayLabel = (date) => date.toLocaleDateString([], { month:'short', day:'numeric' });
    if (event?.all_day === true || clean(event?.schedule_granularity).toLowerCase() === 'date') {
      const allDayLabel = (globalThis.PlatformLanguage?.text("scheduling","m_42b02bf1587e27","All day") ?? "All day");
      if (!start) return allDayLabel;
      const last = editorDisplayEnd(event) || start;
      return sameDay(start, last) ? `${dayLabel(start)} · ${allDayLabel}` : `${dayLabel(start)} – ${dayLabel(last)} · ${allDayLabel}`;
    }
    const end = eventEnd(event);
    if (!start || !end) return 'New event';
    if (!sameDay(start, end)) return `${dayLabel(start)}, ${fmtTime(start)} – ${dayLabel(end)}, ${fmtTime(end)}`;
    return `${dayLabel(start)}, ${fmtTime(start)} - ${fmtTime(end)}`;
  }
  function openPlacedCalendarEvent(event, meta = {}){
    if (!event?.id) return;
    // Opened from a day list: closing the editor goes back to that list.
    dayListReturn = meta.fromDayList ? { day:String(meta.fromDayList), eventId:String(event.id || '') } : null;
    // A narrow chip is mostly its assignee control; a click there opens the
    // editor (which has the assignee section) instead of the quick menu.
    // View-only sessions never get the quick assign / lock actions.
    if (['assignee', 'lock'].includes(meta.action)) {
      const chip = meta.element?.closest?.('[data-prs-event-id]') || null;
      const chipWidth = chip?.getBoundingClientRect?.().width || 0;
      if (!canEditSchedule() || (meta.action === 'assignee' && ((chipWidth > 0 && chipWidth < 96) || eventIsLocked(event)))) {
        meta = { ...meta, action:'', element:chip || meta.element };
      }
    }
    if (!meta.action && eventEditorDraft && String(eventEditorDraft.id || '') !== String(event.id || '')) discardEventEditorDraft();
    // A placed-but-unsaved rail item is a draft everywhere: its assignee is
    // picked locally, a click opens the draft editor (✓ / Save commit it) and
    // never the stored unscheduled item.
    if (isPlacementDraftEvent(event)) {
      if (meta.action === 'view') { openProjectFromEvent(event); return; }
      if (meta.action === 'assignee' && meta.element && canEditSchedule()) {
        openDraftAssignmentMenu(event, meta.element);
        return;
      }
      if (openPlacementDraftEditor(event, meta.element?.closest?.('[data-prs-event-id]') || meta.element || null)) return;
    }
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
    // Opening another item ends the placement: an unsaved placed draft is
    // only dropped after confirmation (as when switching rail items).
    const pendingPlacement = placementWaitingItem();
    if (pendingPlacement?.start && !meta.placementDiscardConfirmed) {
      confirmDiscardPendingPlacement().then((discard) => {
        if (!discard) return;
        vehiclePlacementUnitId = '';
        vehiclePlacementDraft = null;
        clearPlacementSelection();
        render();
        openPlacedCalendarEvent(event, { ...meta, element:editorAnchorFor(event.id) || null, placementDiscardConfirmed:true });
      });
      return;
    }
    eventDraftPopoverId = '';
    eventEditorEventId = String(event.id || '');
    eventDraftProjectQuery = '';
    eventCustomerDetailsOpen = false;
    eventAdvancedOpen = requirementWarningsForEvent(event).length > 0;
    if (pendingPlacement) {
      // Placing stopped: drop its banner and rail highlight in place (a full
      // render would detach the chip the editor is anchored to).
      rootEl?.querySelector('[data-placement-banner]')?.remove();
      rootEl?.querySelectorAll('.dash-right .selected[aria-pressed]').forEach((node) => { node.classList.remove('selected'); node.setAttribute('aria-pressed', 'false'); });
      vehiclePlacementUnitId = '';
      vehiclePlacementDraft = null;
    }
    clearPlacementSelection();
    // A project section is edited, never placed: it selects nothing in the
    // rail (no salesperson / crew placement banner).
    if (isProjectSection(event)) {
      // editor only
    } else if (isProductionEvent(event)) {
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
  /* Renderer callback (onLockedDragAttempt): a refused drag says why. Other
   * renderers in this app can pass the same function. */
  function scheduleLockedDragAttempt(event = {}, detail = {}){
    if (detail.locked === false) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), canEditSchedule() ? 'This item can’t be moved.' : scheduleReadOnlyMessage(), VIEW_ONLY_TOAST);
      return;
    }
    showToast(
      (globalThis.PlatformLanguage?.text("scheduling","m_88e13d64071885","Schedule locked") ?? "Schedule locked"),
      isMaterialEvent(event) && materialEventIsOrdered(event) ? 'Unlock this ordered delivery before moving it.' : 'Unlock this item before moving it.',
      false
    );
  }
  /* Renderer callback (onReadOnlyDragAttempt): throttled so a drag gesture
   * doesn't stack toasts. */
  function scheduleReadOnlyDragAttempt(){
    const now = Date.now();
    if (now - (scheduleReadOnlyDragAttempt._last || 0) < 2500) return;
    scheduleReadOnlyDragAttempt._last = now;
    showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), scheduleReadOnlyMessage(), VIEW_ONLY_TOAST);
  }
  function renderEventCalendarView(){
    const mount = rootEl?.querySelector('#dashEventCalendarView');
    if (!mount || !window.PlatformScheduleView?.renderProjectRangeScheduler || !schedulingConfig) return;
    const draft = selectedEventCalendarDraft();
    const activeDraft = draft?.start && draft.status !== 'scheduled' ? draft : null;
    // View-only sessions get a read-only calendar: no drag-create, no moving
    // or resizing (clicks still open the read-only editor).
    const scheduleEditable = canEditSchedule();
    const allowCreate = scheduleEditable;
    const placementKind = selectedPlacementKind() || scheduleMode;
    const clickPlacement = !!draft && !draft.start && ['materials','production'].includes(placementKind);
    const bundleDrafts = placementKind === 'production' && productionScheduleBundleDrafts.length
      ? productionScheduleBundleDrafts
      : (activeDraft ? [activeDraft] : []);
    // Moving a placement draft only restages it (nothing is saved until ✓ or
    // the editor's Save). A dragged bundle item carries the whole bundle.
    const handlePlacementDraftChange = (rawNext) => {
      let next = placementNaturalRange(rawNext, { drag:true });
      if (placementKind === 'production' && productionScheduleBundleKey && next?.start) {
        const primaryId = clean(productionScheduleDraft?.id || productionScheduleEventId);
        const nextId = clean(next.id || next.event_id);
        if (nextId && primaryId && nextId !== primaryId && productionScheduleDraft?.start) {
          const before = productionScheduleBundleDrafts.find((item) => clean(item.id || item.event_id) === nextId);
          const delta = before?.start ? new Date(next.start).getTime() - new Date(before.start).getTime() : 0;
          const primaryStart = new Date(new Date(productionScheduleDraft.start).getTime() + delta);
          const primaryEnd = productionScheduleDraft.end ? new Date(new Date(productionScheduleDraft.end).getTime() + delta) : null;
          next = { ...productionScheduleDraft, start:primaryStart, ...(primaryEnd ? { end:primaryEnd } : {}) };
        }
      }
      applyEventCalendarDraft(next);
      if (placementKind === 'production' && productionScheduleBundleKey) {
        productionScheduleBundleDrafts = scheduleBundleDrafts(productionScheduleDraft || next);
        // Related bundle items follow the moved primary draft.
        setTimeout(() => refreshActiveScheduleSurface(), 0);
      } else if (next !== rawNext) setTimeout(() => refreshActiveScheduleSurface(), 0);
      refreshRailDraftLabel();
      refreshPlacementBanner();
      if (document.querySelector('.dash-event-popover')) setTimeout(() => renderEventDraftPopover(editorAnchorFor(next?.id || eventDraftPopoverId)), 0);
    };
    window.PlatformScheduleView.renderProjectRangeScheduler(mount, {
      Scheduling: window.PlatformScheduling,
      config: schedulingConfig,
      project: placementKind === 'production'
        ? (selectedProductionProject() || eventProject(selectedProductionEvent() || {}))
        : placementKind === 'materials'
          ? (selectedMaterialProject() || eventProject(selectedMaterialEvent() || {}))
          : eventProject(selectedScheduleEvent() || {}),
      events: eventCalendarItems(),
      draft: renderedPlacementDraft(activeDraft),
      drafts: bundleDrafts.map(renderedPlacementDraft),
      activeDraftId: activeDraft?.id || '',
      allowCreate,
      allowEdit: scheduleEditable,
      readOnly: !scheduleEditable,
      // Placed events move and resize in place; locked events are refused by the renderer.
      allowEventDrag: scheduleEditable && !clickPlacement,
      placementMode: clickPlacement ? 'click' : 'drag',
      touchHoldToPlace: isMobileScheduleLayout(),
      touchHoldDelayMs: 360,
      derivePlacementDrafts(primaryDraft){
        // Month rows grow to fit multi-item hover previews, which moves the
        // day under the pointer; month previews only the primary item (the
        // staged draft still shows the whole bundle).
        const placed = placementNaturalRange(primaryDraft);
        if (eventCalendarMode() === 'month') return [placed];
        return placementKind === 'production' && productionScheduleBundleKey ? scheduleBundleDrafts(placed) : [placed];
      },
      onPlacementCancel(){
        // Escape inside an open popover or dialog closes only that layer.
        if (placementOverlayOpen() || !placementWaitingItem()) return;
        requestCancelPlacement();
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
      onLockedDragAttempt: scheduleLockedDragAttempt,
      // View-only sessions: a drag or drag-create attempt says why nothing moves.
      onReadOnlyDragAttempt: scheduleReadOnlyDragAttempt,
      onNavigate(nextDate, delta, meta = {}){
        anchorDate = validDate(nextDate) || anchorDate;
        expandedMonthDates = [];
        if (meta.source === 'swipe') animateMobileCalendarSwipe(delta);
        // Swipes and in-calendar paging keep date= in step like the header.
        syncScheduleRoute({ date:routeDate() }, { history:'replace', source:'scheduling-date', ownedKeys:['date'] });
        render();
      },
      expandedMonthDates,
      onMonthExpansionChange(nextDates){ expandedMonthDates = Array.isArray(nextDates) ? nextDates : []; },
      onDraftChange(next){
        if (next?.floating_event === true || String(next?.id || '').startsWith('floating_') || !placementWaitingItem()) {
          applyEventCalendarDraft(next);
          if (document.querySelector('.dash-event-popover')) setTimeout(() => renderEventDraftPopover(editorAnchorFor(next?.id || eventDraftPopoverId)), 0);
          return;
        }
        handlePlacementDraftChange(next);
      },
      onDraftConfirm(rawNext, meta = {}){
        const next = meta?.sourceEvent ? placementNaturalRange(rawNext) : rawNext;
        applyEventCalendarDraft(next);
        const kind = selectedPlacementKind() || scheduleMode;
        // A click in placement mode only stages the item as a draft; the ✓ on
        // the draft saves it. Same draft + ✓ model as sales placement and
        // Routing, so a stray click can never commit a placement.
        if (meta?.sourceEvent) {
          if (kind === 'production' && productionScheduleBundleKey) productionScheduleBundleDrafts = scheduleBundleDrafts(productionScheduleDraft || next);
          render();
          refreshPlacementEditor();
          return;
        }
        if (kind === 'materials') confirmMaterialDraft();
        else if (kind === 'production') {
          if (productionScheduleBundleKey) confirmProductionBundleDraft(next);
          else confirmProductionDraft(next);
        }
        else confirmDashboardDraft();
      },
      onDraftCreateComplete(rawNext, meta = {}){
        if (rawNext?.event_id || placementWaitingItem()) {
          const next = placementNaturalRange(rawNext);
          applyEventCalendarDraft(next);
          if (next !== rawNext && !meta?.drafts) setTimeout(() => refreshActiveScheduleSurface(), 0);
          refreshRailDraftLabel();
          refreshPlacementBanner();
          // A placed sales appointment opens its editor beside the draft (never
          // over it) so a salesperson can be picked before saving.
          if (selectedPlacementKind() === 'sales' && !isMobileScheduleLayout()) {
            eventDraftPopoverId = '';
            eventEditorEventId = '';
            eventCustomerDetailsOpen = false;
            eventAdvancedOpen = false;
            setTimeout(() => renderEventDraftPopover(editorAnchorFor(next.id) || meta.element), 0);
          }
          return;
        }
        const draft = updateFloatingEvent({ ...rawNext, floating_event: true });
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
        if (isPlacementDraftEvent(draft) && openPlacementDraftEditor(draft, meta.element || null)) return;
        eventDraftPopoverId = String(draft.id);
        eventEditorEventId = '';
        eventDraftProjectQuery = '';
        eventCustomerDetailsOpen = false;
        eventAdvancedOpen = false;
        renderEventDraftPopover(meta.element || editorAnchorFor(draft.id));
      },
      onEventRangeChange(event, range){
        // A placement draft is never saved by a drag, only restaged.
        if (isPlacementDraftEvent(event)) { handlePlacementDraftChange({ ...event, ...range }); return; }
        saveEventCalendarRange(event, range);
      },
      onEventClick(event, meta = {}){
        // While placing, a click on a day that already holds items places the
        // waiting item on that day (as Routing does) instead of opening one.
        if (clickPlacement && !isPlacementDraftEvent(event) && placeOnPointerDay(mount)) return;
        openPlacedCalendarEvent(event, meta);
      }
    });
    if (!mount.__dashPointerTracked) {
      mount.__dashPointerTracked = true;
      mount.addEventListener('pointerdown', (pointerEvent) => { mount.__dashLastPointer = { x:pointerEvent.clientX, y:pointerEvent.clientY }; }, true);
    }
    markDependencyConflicts(mount);
    labelDraftConfirms(mount);
    scrollMonthToToday(mount);
    enableKeyboardPlacement(mount);
  }
  /* A draft's ✓ names what it saves ("Save “Tear-off”") for screen readers
   * and as its tooltip, instead of a generic "Confirm New Event". */
  function labelDraftConfirms(mount){
    mount?.querySelectorAll?.('[data-prs-confirm]').forEach((button) => {
      const chip = button.closest('[data-prs-event-id]');
      const title = clean(chip?.querySelector('.prs-title-text')?.textContent || chip?.querySelector('.prs-title')?.textContent || chip?.getAttribute('aria-label'));
      if (!title) return;
      const label = `Save “${title.slice(0, 80)}”`;
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    });
  }
  /* Items that start before a dependency allows (left out of order) carry a
   * marker on the calendar too, not only on the Timeline. */
  function markDependencyConflicts(mount){
    const Scheduling = window.PlatformScheduling;
    if (!mount || !Scheduling?.dependencyViolations) return;
    let violations = [];
    try { violations = Scheduling.dependencyViolations(allEvents, { config:schedulingConfig }); } catch (error) { return; }
    if (!violations.length) return;
    const byTarget = new Map();
    violations.forEach((violation) => {
      const id = clean(violation.to);
      if (!id) return;
      const predecessor = allEvents.find((item) => clean(item.id) === clean(violation.from));
      const earliest = validDate(violation.earliest_start);
      const line = `Starts before “${clean(predecessor?.title) || 'a linked item'}” allows${earliest ? ` (earliest ${earliest.toLocaleDateString([], { month:'short', day:'numeric' })})` : ''}.`;
      byTarget.set(id, [...(byTarget.get(id) || []), line]);
    });
    mount.querySelectorAll('[data-prs-event-id]').forEach((chip) => {
      const lines = byTarget.get(clean(chip.dataset.prsEventId));
      if (!lines || chip.querySelector('.dash-dep-conflict-marker')) return;
      chip.classList.add('dash-dep-conflict');
      const marker = document.createElement('span');
      marker.className = 'dash-dep-conflict-marker';
      marker.setAttribute('role', 'img');
      marker.setAttribute('aria-label', `Out of dependency order. ${lines.join(' ')}`);
      marker.title = `Out of dependency order. ${lines.join(' ')} Open the item to fix its dates.`;
      marker.innerHTML = '<i class="fas fa-link-slash" aria-hidden="true"></i>';
      // Inline at the start of the title (like the lock/requirement marks),
      // so it never sits over the crew pill; a click opens the item.
      const title = chip.querySelector('.prs-title');
      if (title) title.insertBefore(marker, title.querySelector('.prs-title-text') || title.firstChild);
      else chip.appendChild(marker);
      marker.addEventListener('pointerdown', (event) => event.stopPropagation());
      marker.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const item = eventCalendarItems().find((entry) => clean(entry.id) === clean(chip.dataset.prsEventId));
        if (item) openPlacedCalendarEvent(item, { element:chip });
      });
    });
  }
  /* Month view (short screens): open with today's week in view the first
   * time a month containing today is shown, without fighting later scrolls. */
  function scrollMonthToToday(mount){
    if (!mount || eventCalendarMode() !== 'month') return;
    const todayKey = routeDate(new Date());
    const key = `${routeDate(monthStart(anchorDate))}`;
    if (scrollMonthToToday._key === key) return;
    scrollMonthToToday._key = key;
    const cell = mount.querySelector(`[data-prs-date="${todayKey}"]`);
    if (!cell) return;
    // The shared helper lands on a row boundary under the weekday header and
    // doesn't move when today's row already shows (R3-MOB-4).
    const reveal = window.PlatformScheduleView?.revealMonthDate;
    if (typeof reveal === 'function') {
      requestAnimationFrame(() => reveal(mount, new Date()));
      return;
    }
    requestAnimationFrame(() => {
      const scroller = cell.closest('.prs-surface') || mount;
      const cellRect = cell.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      if (cellRect.bottom > scrollerRect.bottom || cellRect.top < scrollerRect.top) {
        scroller.scrollTop += cellRect.top - scrollerRect.top - Math.max(0, (scroller.clientHeight - cellRect.height) / 3);
      }
    });
  }
  // Assignee menu for an unsaved placement draft: the choice is kept on the
  // draft (shown on its chip) and saved with ✓ / Save.
  function openDraftAssignmentMenu(draft = {}, anchor = null){
    const kind = selectedPlacementKind();
    if (kind === 'sales') {
      const event = selectedScheduleEvent();
      if (!event) return;
      openAssignmentMenu({ ...event, ...draft, id:event.id }, anchor, (resource) => {
        appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), assignment:assignmentPayloadForSubject(resource), user:resource };
        refreshActiveScheduleSurface();
        refreshRailDraftLabel();
        refreshPlacementBanner();
      });
      return;
    }
    if (kind === 'production') {
      openAssignmentMenu({ ...draft, id:draft.id || productionScheduleEventId || '__production_event_draft' }, anchor, (resource) => {
        productionScheduleDraft = { ...(productionScheduleDraft || draft), ...assignmentPayloadForSubject(resource) };
        if (productionScheduleBundleKey) productionScheduleBundleDrafts = scheduleBundleDrafts(productionScheduleDraft);
        refreshActiveScheduleSurface();
      });
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
  async function confirmDashboardDraftNow(){
    const Scheduling = window.PlatformScheduling;
    const project = selectedScheduleProject();
    if (!Scheduling || !project?.id || !appointmentScheduleDraft?.start) return;
    const existing = selectedScheduleEvent();
    const wasScheduled = !!existing && eventIsScheduled(existing);
    const draftStart = new Date(appointmentScheduleDraft.start);
    const timeChanged = !wasScheduled || eventStart(existing)?.getTime() !== draftStart.getTime();
    if (timeChanged && !(await confirmPastPlacement(draftStart, projectTitle(project, existing || {})))) return;
    captureScheduleScroll();
    const eventType = schedulingConfig?.event_types?.sales_appointment || {};
    // Lane/menu/popover choice, else the appointment keeps its salesperson.
    const assignment = salesDraftAssignment(appointmentScheduleDraft, existing);
    // Exactly what the draft (and its editor) shows: start and end.
    const draftEnd = salesDraftEnd(existing || {});
    const draftMinutes = Math.max(15, Math.round((draftEnd.getTime() - draftStart.getTime()) / 60000));
    const event = existing
      ? {
          ...withScheduleHistory(existing, 'rescheduled_or_assigned'),
          start_at: draftStart.toISOString(),
          start: draftStart.toISOString(),
          end_at: draftEnd.toISOString(),
          end: draftEnd.toISOString(),
          all_day: false,
          schedule_granularity: 'time',
          duration_minutes: draftMinutes,
          ...assignment,
          title: appointmentScheduleDraft.title || existing.title || clean(Scheduling.autoEventTitle?.(schedulingConfig, existing, project)) || 'Sales Appointment',
          project_title: appointmentScheduleDraft.project_title || existing.project_title || projectTitle(project, existing),
          title_is_custom: appointmentScheduleDraft.title_is_custom === true || existing.title_is_custom === true,
          // Notes cleared in the draft editor stay cleared.
          description: (typeof appointmentScheduleDraft.description === 'string' ? appointmentScheduleDraft.description : existing.description) || '',
          notes: (typeof appointmentScheduleDraft.description === 'string' ? appointmentScheduleDraft.description : existing.notes) || '',
          customer_visible: appointmentScheduleDraft.customer_visible === true,
          customer_show_title: appointmentScheduleDraft.customer_show_title !== false,
          customer_show_crew: appointmentScheduleDraft.customer_show_crew === true,
          customer_description: clean(appointmentScheduleDraft.customer_description),
          updated_at: new Date().toISOString(),
        }
      : Scheduling.createProjectEvent(project, 'sales_appointment', {
          id: placementNewItemId(appointmentScheduleDraft),
          start: appointmentScheduleDraft.start,
          durationMinutes: draftMinutes || Number(eventType.duration_minutes || 60),
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
    showPlacementSaving();
    try {
      await placementSaveRequest(Scheduling.saveProjectEvent(orgId(), project, event, schedulingConfig));
      appointmentScheduleDraft = null;
      appointmentScheduleProjectId = '';
      appointmentScheduleEventId = '';
      appointmentScheduleMenuEventId = '';
      if (eventDraftPopoverId === String(event.id || '') || (!eventEditorEventId && !eventDraftPopoverId)) closeEventDraftPopover();
      // Placed: draft, banner and rail tile update before the reload.
      if (existing) {
        updateLocalCalendarEvent(event.id, event);
        events = visibleEvents();
      }
      render();
      await loadData({ force: true });
      const assigneeName = currentAssignmentId(event) ? salesAssignmentLabel(event) : '';
      const when = fmtDayTime(eventStart(event));
      const overlap = salesOverlapWarning(event);
      showToast(
        wasScheduled ? (timeChanged ? 'Appointment rescheduled' : 'Appointment updated') : (globalThis.PlatformLanguage?.text("scheduling","m_da42e64e20d9f0","Appointment scheduled") ?? "Appointment scheduled"),
        `${when ? `${projectTitle(project, event)} · ${when}.` : 'The appointment was saved.'}${assigneeName ? ` Assigned to ${assigneeName}.` : ' No salesperson assigned yet.'}${overlap}`,
        !overlap
      );
    } catch (error) {
      if (isStaleSaveError(error)) { await reloadAfterStalePlacement(error, event.id); return; }
      if (placementSaveFailureToast(error)) return;
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), error?.message || 'Could not schedule this appointment.', false);
    }
  }
  /* One placement commit at a time: the draft's ✓ and its editor's Save both
   * come through these wrappers, so a double-click (or ✓ while Save runs) never
   * saves twice. ✓ badges are disabled at once and the banner says "Saving…"
   * as soon as the save itself starts. */
  // (placementSaveInFlight / placementSavingShown are declared with the other
  // placement state at the top.)
  async function runPlacementSave(task){
    if (placementSaveInFlight) { placementSaveBusy('save'); return undefined; }
    placementSaveInFlight = true;
    rootEl?.classList.add('dash-placement-busy');
    suppressPlacementFollowUpClick();
    try {
      return await task();
    } finally {
      placementSaveInFlight = false;
      placementSavingShown = false;
      rootEl?.classList.remove('dash-placement-busy');
      if (rootEl?.querySelector('[data-placement-banner][data-saving]')) refreshPlacementBanner();
    }
  }
  function showPlacementSaving(){
    placementSavingShown = true;
    const banner = rootEl?.querySelector('[data-placement-banner]');
    const text = banner?.querySelector(':scope > span');
    if (!banner || !text) return;
    banner.dataset.saving = '1';
    banner.setAttribute('aria-busy', 'true');
    text.innerHTML = `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(globalThis.PlatformLanguage?.text("scheduling","m_placement_saving","Saving…") ?? "Saving…")}`;
    const cancel = banner.querySelector('[data-placement-cancel]');
    if (cancel) {
      cancel.setAttribute('disabled', '');
      cancel.title = 'Saving — can’t cancel now';
      cancel.textContent = 'Cancel';
    }
  }
  /* The second click of a double-click on ✓ lands on whatever replaced the
   * draft (the saved chip, a "+N" button after the banner went): swallow it
   * briefly so it doesn't open that item or start a new one. */
  function suppressPlacementFollowUpClick(){
    const scope = rootEl;
    if (!scope) return;
    const until = Date.now() + 900;
    const swallow = (event) => {
      if (Date.now() > until) { stop(); return; }
      if (event.type === 'dblclick' || Number(event.detail || 0) >= 2) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // The second press of a double-click also starts the calendar's own
    // click-to-create gesture on pointerdown, so presses right after ✓ are
    // swallowed too (a real next action comes later than this).
    const pressUntil = Date.now() + 500;
    const swallowPress = (event) => {
      if (Date.now() > pressUntil) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const stop = () => {
      scope.removeEventListener('click', swallow, true);
      scope.removeEventListener('dblclick', swallow, true);
      scope.removeEventListener('pointerdown', swallowPress, true);
      scope.removeEventListener('mousedown', swallowPress, true);
    };
    scope.addEventListener('click', swallow, true);
    scope.addEventListener('dblclick', swallow, true);
    scope.addEventListener('pointerdown', swallowPress, true);
    scope.addEventListener('mousedown', swallowPress, true);
    setTimeout(stop, 950);
  }
  /* A placement save that gets no answer gives up after a while with a
   * plain message; the draft stays so ✓ can be tried again (a new item keeps
   * its client id, so a late first save and the retry write the same item).
   * A typed timeout error from the platform API is treated the same way. */
  // Backstop only: PlatformScheduling.saveProjectEvent rejects with its own
  // typed timeout (isSaveTimeoutError) after 30 s.
  const PLACEMENT_SAVE_TIMEOUT_MS = 35000;
  function placementSaveRequest(promise){
    let timer = null;
    return Promise.race([
      Promise.resolve(promise).finally(() => clearTimeout(timer)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('The server did not answer in time.'), { code:'save_timeout', placementTimeout:true })), PLACEMENT_SAVE_TIMEOUT_MS); })
    ]);
  }
  function placementSaveTimedOut(error = null){
    if (!error) return false;
    const code = clean(error.code || error.error || error.details?.code).toLowerCase();
    return error.placementTimeout === true || window.PlatformScheduling?.isSaveTimeoutError?.(error) === true || error.timeout === true || /timeout|timed_out/.test(code) || /timeout/i.test(clean(error.name)) || [408, 504].includes(Number(error.status || error.statusCode || 0));
  }
  /* A placement refused as stale: reload, then say whether the item was
   * deleted elsewhere (it is gone after the reload) or changed. */
  async function reloadAfterStalePlacement(error = null, eventId = ''){
    await loadData({ force:true });
    const deleted = error?.deleted === true || (!!eventId && dataLoaded && !scheduleItemExists(eventId));
    if (deleted) {
      if (eventId && placementDraftIds().has(clean(eventId))) { clearPlacementSelection(); render(); }
      deletedElsewhereToast();
    } else changedElsewhereToast(error);
  }
  function placementNetworkFailed(error = null){
    return !!error && (error.name === 'TypeError' || /failed to fetch|networkerror|network request failed|load failed/i.test(clean(error.message)));
  }
  // -> true when the failure was a timeout / lost connection (toast shown).
  function placementSaveFailureToast(error = null){
    if (placementSaveTimedOut(error)) {
      showToast('Not saved yet', 'The server didn’t answer in time. Your draft is kept — check your connection, then click ✓ on it to try again.', { tone:'warning', duration:12000 });
      return true;
    }
    if (placementNetworkFailed(error)) {
      showToast('Not saved', 'Couldn’t reach the server. Your draft is kept — check your connection, then click ✓ on it to try again.', { tone:'warning', duration:12000 });
      return true;
    }
    return false;
  }
  /* One stable client id per staged new item: stored on the live draft (and
   * on the object passed in), reused by every save attempt of it. */
  function placementNewItemId(draft = null){
    const holders = [draft, productionScheduleDraft && clean(productionScheduleDraft.id) === clean(draft?.id) ? productionScheduleDraft : null, appointmentScheduleDraft === draft ? appointmentScheduleDraft : null].filter((item) => item && typeof item === 'object');
    const existing = holders.map((item) => clean(item.__new_event_id)).find(Boolean);
    const id = existing || `event_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    holders.forEach((item) => { item.__new_event_id = id; });
    return id;
  }
  function editorFieldsFromDraft(draft = {}){
    return Object.fromEntries(['title', 'title_is_custom', 'description', 'notes', 'customer_visible', 'customer_show_title', 'customer_show_crew', 'customer_description']
      .filter((key) => Object.prototype.hasOwnProperty.call(draft || {}, key) && draft[key] !== undefined && !(key === 'title' && !clean(draft.title)))
      .map((key) => [key, draft[key]]));
  }
  // -> true when the stored project already has work this view doesn't know
  // about (the view is reloaded and the user told; nothing is created).
  async function projectGotWorkElsewhere(project = {}){
    const api = window.PlatformAPI;
    if (!project?.id || !api?.projects?.get) return false;
    let fresh = [];
    try {
      const result = await withTimeout(api.projects.get(orgId(), project.id), 6000, 'Project check');
      fresh = result?.document ? (window.PlatformScheduling?.eventsFromProjects?.([result.document], schedulingConfig || {}) || []) : [];
    } catch (error) { return false; }
    const known = new Set(allEvents.map((item) => clean(item.id)));
    const added = fresh.filter((item) => (isProductionEvent(item) || isMaterialEvent(item)) && !known.has(clean(item.id)) && !['cancelled', 'canceled'].includes(clean(item.status).toLowerCase()));
    if (!added.length) return false;
    clearPlacementSelection();
    await loadData({ force:true });
    render();
    showToast('Already scheduled by someone else', `${projectTitle(project)} got ${scheduleItemNames(added)} while you were placing it. The calendar now shows it — nothing new was created.`, STALE_TOAST);
    return true;
  }
  function confirmProductionDraft(draft = productionScheduleDraft){ return runPlacementSave(() => confirmProductionDraftNow(draft)); }
  function confirmProductionBundleDraft(primaryDraft = productionScheduleDraft){ return runPlacementSave(() => confirmProductionBundleDraftNow(primaryDraft)); }
  function confirmMaterialDraft(draft = materialScheduleDraft){ return runPlacementSave(() => confirmMaterialDraftNow(draft)); }
  function confirmDashboardDraft(){ return runPlacementSave(() => confirmDashboardDraftNow()); }
  async function confirmProductionDraftNow(draft = productionScheduleDraft){
    const Scheduling = window.PlatformScheduling;
    const project = selectedProductionProject();
    if (!Scheduling || !project?.id || !draft?.start) return;
    const placing = !selectedProductionEvent() || !eventIsScheduled(selectedProductionEvent());
    if (placing && !(await confirmPastPlacement(draft.start, clean(draft.title) || projectTitle(project, draft)))) return;
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
    // New work for a sold, unscheduled project: someone else may have placed
    // it meanwhile. Check the stored project first so two people placing the
    // same project don't both create an item.
    if (!existing && await projectGotWorkElsewhere(project)) return;
    // A placed waiting item becomes scheduled locally too, so its parent
    // group's rollup (dates + status) follows right away.
    // What was typed in the draft editor (title, notes, customer sharing) is
    // saved with the placement, as the bundle path does.
    // A crew/people set chosen in the draft editor (several crews, or crews
    // plus people) is saved as that exact set; a single lane/primary choice
    // replaces the primary crew.
    const draftCrewIds = (Array.isArray(draft.resource_refs) ? draft.resource_refs : []).filter((ref) => ['resource_group', 'organization_connection'].includes(clean(ref?.kind))).map((ref) => clean(ref.id));
    const draftSet = existing && draftCrewIds.length && (!workCrewId(draft) || draftCrewIds.includes(workCrewId(draft)))
      ? assigneeSetPatch(existing, eventCrewRefs(draft), editorAssignmentUserList(draft))
      : null;
    const rangePayload = draftSet
      ? Object.fromEntries(Object.entries(payload).filter(([key]) => !['work_resource_ref', 'assigned_resource_kind', 'assigned_resource_id', 'assigned_resource_name', 'assigned_crew_id', 'assigned_crew_name', 'assigned_crew', 'crew_id', 'crew_name', 'resource_id', 'resource_name', 'assigned_user_id', 'assigned_user_ids', 'assigned_users', 'assigned_user_name'].includes(key)))
      : payload;
    const event = existing
      ? { ...Scheduling.updateProjectEventRange(draftSet ? { ...existing, ...draftSet } : existing, rangePayload), ...editorFieldsFromDraft(draft), ...(placing ? { status:'scheduled' } : {}) }
      // A new item keeps one client id for this placement, so a retried or
      // repeated ✓ writes the same item instead of a second one.
      // Its notes are stored as the description too (not only as notes).
      : { ...Scheduling.createProjectWorkEvent(project, { ...payload, id:placementNewItemId(draft) }, schedulingConfig), ...(clean(payload.description) ? { description:payload.description, notes:payload.description } : {}) };
    // Rescheduling a placed item follows its depends_on links (shared prompt);
    // placing a waiting one checks it against already-scheduled linked work.
    const related = existing && eventIsScheduled(existing)
      ? await resolveRelatedReschedule(existing, { start:payload.start, end:payload.end })
      : (existing ? await resolvePlacementDependencyConflicts(project, [event], title) : null);
    if (related?.cancelled) { refreshActiveScheduleSurface(); return; }
    // Predecessors that have no date yet: the placement can't be checked
    // against them, so say so.
    const waitingPredecessors = existing && Scheduling.eventDependencies
      ? Scheduling.eventDependencies(existing).map((dep) => allEvents.find((item) => String(item.id || '') === String(dep.event_id || ''))).filter((item) => item && !eventIsScheduled(item))
      : [];
    // Placing onto a crew that already has work then says so (the lane also
    // marks both chips double-booked).
    const overlap = scheduleOverlapNote(event);
    showPlacementSaving();
    try {
      await placementSaveRequest(Scheduling.saveProjectEvent(orgId(), project, withExplicitAssignees(event), schedulingConfig));
      // The placement is done: the draft, banner and rail tile go at once;
      // linked moves and group rollups finish behind it.
      updateLocalCalendarEvent(event.id, event);
      events = visibleEvents();
      clearPlacementSelection();
      render();
      if (related?.changes?.length) await saveRelatedRescheduleChanges(project, related.changes);
      await persistGroupRollups(project, [event, ...(related?.changes || [])]);
      await loadData({ force: true });
      const when = eventStart(event) ? eventStart(event).toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' }) : '';
      const movedNote = related?.changes?.length ? ` ${related.changes.length} linked item${related.changes.length === 1 ? ' was' : 's were'} moved too.` : '';
      const waitingNote = waitingPredecessors.length ? ` It follows ${scheduleItemNames(waitingPredecessors)}, which ${waitingPredecessors.length === 1 ? 'has' : 'have'} no date yet.` : '';
      showToast(
        (globalThis.PlatformLanguage?.text("scheduling","m_9e8700da1990da","Work scheduled") ?? "Work scheduled"),
        `${placing ? `“${clean(event.title) || 'The work'}” was placed${when ? ` on ${when}` : ''}.` : (globalThis.PlatformLanguage?.text("scheduling","m_c0406f40f63018","The production schedule was updated.") ?? "The production schedule was updated.")}${movedNote}${waitingNote}${outOfOrderNote(related?.leftOutOfOrder || 0)}${overlap}`,
        !(related?.leftOutOfOrder) && !overlap
      );
    } catch (error) {
      if (isStaleSaveError(error)) { await reloadAfterStalePlacement(error, existing ? event.id : ''); return; }
      if (placementSaveFailureToast(error)) return;
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), error?.message || 'Could not schedule this production work.', false);
    }
  }
  async function confirmProductionBundleDraftNow(primaryDraft = productionScheduleDraft){
    const Scheduling = window.PlatformScheduling;
    const bundle = selectedProductionBundle();
    const project = bundle?.project || selectedProductionProject();
    if (!Scheduling || !bundle?.primary || !project?.id || !primaryDraft?.start) return;
    const drafts = scheduleBundleDrafts(primaryDraft);
    if (!drafts.length) return;
    if (!(await confirmPastPlacement(primaryDraft.start, clean(bundle.primary.title) || projectTitle(project, bundle.primary)))) return;
    captureScheduleScroll();
    let savedCount = 0;
    const placedItems = [];
    // Refuse up front so a locked item never leaves the bundle half placed.
    const lockedSource = drafts
      .map((draft) => bundle.events.find((event) => String(event.id || '') === String(draft.id || draft.event_id || '')))
      .find((source) => source && eventIsLocked(source));
    if (lockedSource) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_84d1c4fbb42b86","Bundle scheduling failed") ?? "Bundle scheduling failed"), `${lockedSource.title || (globalThis.PlatformLanguage?.text("scheduling","m_ab2a08d55b6265","A schedule item") ?? "A schedule item")} is locked and could not be placed. Nothing was placed.`, false);
      return;
    }
    // Drafts arrive in dependency order, so predecessors are saved first.
    // The primary keeps what was typed in its draft editor.
    const primaryId = String(bundle.primary.id || '');
    const editorFields = (draft) => String(draft.id || draft.event_id || '') !== primaryId ? {} : Object.fromEntries(['title', 'title_is_custom', 'description', 'notes', 'customer_visible', 'customer_show_title', 'customer_show_crew', 'customer_description']
      .filter((key) => Object.prototype.hasOwnProperty.call(primaryDraft, key) && primaryDraft[key] !== undefined && !(key === 'title' && !clean(primaryDraft.title)))
      .map((key) => [key, primaryDraft[key]]));
    drafts.forEach((draft) => {
      const source = bundle.events.find((event) => String(event.id || '') === String(draft.id || draft.event_id || ''));
      if (!source) return;
      const material = isMaterialEvent(source);
      placedItems.push({
        ...Scheduling.updateProjectEventRange(source, {
          start:new Date(draft.start),
          end:new Date(draft.end),
          all_day:draft.all_day !== false,
          schedule_granularity:draft.schedule_granularity || (draft.all_day === false ? 'time' : 'date'),
          ...(!material ? workResourcePayload(primaryDraft) : {})
        }),
        ...editorFields(draft),
        status:'scheduled'
      });
    });
    // Already-scheduled work outside the bundle that the placement puts out
    // of dependency order: ask before placing (move them / place anyway).
    const conflicts = await resolvePlacementDependencyConflicts(project, placedItems, clean(bundle.primary.title) || projectTitle(project, bundle.primary));
    if (conflicts.cancelled) { refreshActiveScheduleSurface(); return; }
    const linkedMoves = conflicts.changes;
    const originals = new Map([...placedItems, ...linkedMoves].map((item) => [String(item.id || ''), allEvents.find((event) => String(event.id || '') === String(item.id || '')) || null]));
    // Placing onto a crew that already has work then says so, as a single
    // placement does (checked before the bundle's own items count as booked).
    const busyCrewNote = [...new Set(placedItems.map((item) => scheduleOverlapNote(item)).filter(Boolean))].slice(0, 2).join('');
    // Show the placed bundle right away; the saves run in order behind it,
    // with progress, and leaving the page mid-save asks first.
    [...placedItems, ...linkedMoves].forEach((next) => updateLocalCalendarEvent(next.id, next));
    events = visibleEvents();
    // Kept so a failed save (nothing stored) can put the staged bundle back.
    const stagedPlacement = placementStateSnapshot();
    clearPlacementSelection();
    render();
    const toSave = [...placedItems, ...linkedMoves];
    const guardUnload = (event) => { event.preventDefault(); event.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', guardUnload);
    // Stays up (info, not a success tick) until the result toast replaces it.
    const savingToast = { tone:'info', duration:PLACEMENT_SAVE_TIMEOUT_MS };
    if (toSave.length > 1) showToast('Placing schedule', `Saving ${toSave.length} items in dependency order… Keep this page open until it finishes.`, savingToast);
    else showToast('Placing schedule', `Saving “${clean(toSave[0]?.title) || 'the item'}”…`, savingToast);
    const savedItems = [];
    try {
      for (const next of toSave) {
        const result = await placementSaveRequest(Scheduling.saveProjectEvent(orgId(), project, next, schedulingConfig));
        savedItems.push(result?.event?.id ? result.event : next);
        savedCount += 1;
      }
      // The parent group takes its dates (and scheduled status) from its items.
      await persistGroupRollups(project, toSave);
      await loadData({ force:true });
      const firstStart = placedItems.map((item) => eventStart(item)).filter(Boolean).sort((a, b) => a - b)[0];
      const startLabel = firstStart ? firstStart.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' }) : '';
      const placedCount = placedItems.length;
      const movedNote = linkedMoves.length ? ` ${linkedMoves.length} linked item${linkedMoves.length === 1 ? ' was' : 's were'} moved to keep the order.` : '';
      showToast(
        (globalThis.PlatformLanguage?.text("scheduling","m_5f33d082e19857","Project schedule placed") ?? "Project schedule placed"),
        `${placedCount === 1 ? `“${clean(placedItems[0].title) || 'The item'}” was placed` : `${placedCount} schedule items were placed in dependency order`}${startLabel ? `${placedCount === 1 ? ' on' : ', starting'} ${startLabel}` : ''}.${movedNote}${outOfOrderNote(conflicts.leftOutOfOrder)}${busyCrewNote}`,
        !conflicts.leftOutOfOrder && !busyCrewNote
      );
    } catch (error) {
      // Keep the bundle all-or-nothing where possible: put the items that
      // were already saved back the way they were.
      let restored = 0;
      for (const saved of savedItems.reverse()) {
        const original = originals.get(String(saved.id || ''));
        if (!original) continue;
        // Put the schedule fields back on the copy just saved (its revision).
        const restore = {
          ...saved,
          status:original.status, all_day:original.all_day, schedule_granularity:original.schedule_granularity || '',
          start:original.start || '', end:original.end || '', start_at:original.start_at || '', end_at:original.end_at || '',
          duration_minutes:original.duration_minutes
        };
        try { await Scheduling.saveProjectEvent(orgId(), project, restore, schedulingConfig); restored += 1; } catch (restoreError) {}
      }
      await loadData({ force:true });
      const kept = savedItems.length - restored;
      if (isStaleSaveError(error) && !kept) { changedElsewhereToast(error); return; }
      // Nothing stored (timeout, lost connection): the staged bundle comes back
      // as a draft so ✓ can be tried again.
      if (!kept && !isStaleSaveError(error) && (placementSaveTimedOut(error) || placementNetworkFailed(error))) {
        const bundleStillWaiting = scheduleBundleGroups(unscheduledEvents((item) => isProductionEvent(item) || isMaterialEvent(item))).some((group) => group.key === stagedPlacement.productionScheduleBundleKey);
        if (bundleStillWaiting && !placementWaitingItem()) applyPlacementHistory(stagedPlacement);
        placementSaveFailureToast(error);
        return;
      }
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_84d1c4fbb42b86","Bundle scheduling failed") ?? "Bundle scheduling failed"), `${scheduleSaveErrorMessage(error, 'Could not place every schedule item.')}${kept ? ` ${kept} item${kept === 1 ? ' was' : 's were'} saved before the error and could not be undone.` : ' Nothing was placed.'}`, false);
    } finally {
      window.removeEventListener('beforeunload', guardUnload);
    }
  }
  /* Dependency links between the items being placed and already-scheduled
   * work that the placement would put out of order. Asks once:
   *   Cancel / Place anyway / Move linked items (scheduled successors that can
   *   move are pushed to the earliest start the link allows).
   * -> { cancelled, changes, leftOutOfOrder } */
  async function resolvePlacementDependencyConflicts(project = {}, placedItems = [], label = 'This item'){
    const Scheduling = window.PlatformScheduling;
    const none = { cancelled:false, changes:[], leftOutOfOrder:0 };
    if (!Scheduling?.dependencyViolations || !project?.id || !placedItems.length) return none;
    const placedById = new Map(placedItems.map((item) => [String(item.id || ''), item]));
    const effective = projectScheduleItems(project.id).map((item) => placedById.get(String(item.id || '')) || item);
    let violations = [];
    try { violations = Scheduling.dependencyViolations(effective, { config:schedulingConfig }); } catch (error) { return none; }
    violations = violations.filter((edge) => placedById.has(String(edge.from || '')) !== placedById.has(String(edge.to || '')));
    if (!violations.length) return none;
    const byId = new Map(effective.map((item) => [String(item.id || ''), item]));
    const fixed = (event) => eventIsLocked(event) || Scheduling.eventIsFixed?.(event) === true || ['completed', 'complete', 'done'].includes(clean(event?.status).toLowerCase());
    const movable = new Map();
    violations.forEach((edge) => {
      const successor = byId.get(String(edge.to || ''));
      if (!successor || placedById.has(String(successor.id || '')) || fixed(successor)) return;
      const earliest = validDate(edge.earliest_start);
      const start = eventStart(successor);
      if (!earliest || !start) return;
      const previous = movable.get(String(successor.id || ''));
      if (previous && validDate(previous.start) >= earliest) return;
      const end = eventEnd(successor) || addDays(start, 1);
      const allDay = successor.all_day === true || clean(successor.schedule_granularity).toLowerCase() === 'date';
      const nextStart = allDay ? (earliest.getHours() || earliest.getMinutes() ? addDays(startOfDay(earliest), 1) : earliest) : earliest;
      movable.set(String(successor.id || ''), { ...Scheduling.updateProjectEventRange(successor, { start:nextStart, end:new Date(nextStart.getTime() + (end.getTime() - start.getTime())), all_day:allDay, schedule_granularity:allDay ? 'date' : 'time' }), status:'scheduled' });
    });
    const describe = violations.slice(0, 3).map((edge) => {
      const from = byId.get(String(edge.from || ''));
      const to = byId.get(String(edge.to || ''));
      return `“${clean(to?.title) || 'An item'}” would start before “${clean(from?.title) || 'the item'}” it follows`;
    });
    const more = violations.length > 3 ? ` and ${violations.length - 3} more` : '';
    const choices = [
      { value:'cancel', label:(globalThis.PlatformLanguage?.text("scheduling","m_cbef679b21abb4","Cancel") ?? "Cancel") },
      { value:'anyway', label:'Place anyway' },
      ...(movable.size ? [{ value:'move', label:`Move ${movable.size === 1 ? 'it' : 'them'} too`, primary:true }] : [])
    ];
    const message = `Placing “${clean(label) || 'this item'}” puts linked work out of order: ${describe.join('; ')}${more}.${movable.size ? ` Move the ${movable.size === 1 ? 'later item' : `${movable.size} later items`} so the order holds?` : ''}`;
    const choice = window.Portal?.ui?.choose
      ? await window.Portal.ui.choose(message, movable.size ? choices : choices.map((item) => item.value === 'anyway' ? { ...item, danger:true } : item), { title:'Dependency conflict', defaultFocus:'cancel' })
      : ((await (window.PlatformUI?.confirm?.(message, { title:'Dependency conflict', okLabel:'Place anyway', cancelLabel:'Cancel', danger:true, defaultFocus:'cancel' }))) ? 'anyway' : 'cancel');
    if (!choice || choice === 'cancel') return { ...none, cancelled:true };
    if (choice === 'move') return { cancelled:false, changes:[...movable.values()], leftOutOfOrder:Math.max(0, violations.length - movable.size) };
    return { cancelled:false, changes:[], leftOutOfOrder:violations.length };
  }
  async function confirmMaterialDraftNow(draft = materialScheduleDraft){
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
    if (!eventIsScheduled(event) && !(await confirmPastPlacement(start, `${materialDeliveryTitle(event)} delivery`))) return;
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
      // Title (when retyped) and notes from the draft editor are saved too.
      ...stagedDraftText(draft),
      customer_visible: draft.customer_visible === true,
      customer_show_title: draft.customer_show_title !== false,
      customer_show_crew: draft.customer_show_crew === true,
      customer_description: clean(draft.customer_description)
    };
    showPlacementSaving();
    try {
      await placementSaveRequest(Scheduling.saveProjectEvent(orgId(), project, next, schedulingConfig));
      materialScheduleDraft = null;
      materialScheduleEventId = '';
      materialScheduleProjectId = '';
      productionScheduleDraft = null;
      productionScheduleEventId = '';
      productionScheduleProjectId = '';
      focusedScheduleEventId = next.id;
      // Placed: draft, banner and rail tile update before the reload.
      updateLocalCalendarEvent(next.id, next);
      events = visibleEvents();
      render();
      await loadData({ force: true });
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_0c0a1a5bde2186","Delivery scheduled") ?? "Delivery scheduled"), ((v0) => globalThis.PlatformLanguage?.text("scheduling","m_ffc8470f2fd563",`${v0} was placed on the calendar.`,{v0}) ?? `${v0} was placed on the calendar.`)(event.title || 'Material delivery'), true);
    } catch (error) {
      if (isStaleSaveError(error)) { await reloadAfterStalePlacement(error, next.id); return; }
      if (placementSaveFailureToast(error)) return;
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
    if (!canEditSchedule()) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), scheduleReadOnlyMessage(), VIEW_ONLY_TOAST);
      return false;
    }
    // Lock the stored item (never an editor's unsaved draft copy), as it is
    // stored right now: only the lock fields change, so a move or edit made
    // elsewhere since this view loaded is never reverted by the lock save.
    const knownEvent = floating
      ? (floatingEvents.find((item) => String(item.id || '') === String(event.id || '')) || event)
      : (allEvents.find((item) => String(item.id || '') === String(event.id || '')) || event);
    const material = isMaterialEvent(knownEvent);
    const locked = eventIsLocked(knownEvent);
    const ordered = material && materialEventIsOrdered(knownEvent);
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
    const lockFieldsFor = (base = {}) => ({
      locked: nextLocked,
      schedule_locked: nextLocked,
      schedule_lock: {
        ...(base.schedule_lock || {}),
        locked: nextLocked,
        reason: ordered ? 'material_order' : 'manual',
        locked_at: nextLocked ? now : '',
        unlocked_at: nextLocked ? '' : now
      },
      unlock_confirmed: locked && !nextLocked,
      updated_at: now
    });
    // The chip and editor show the new lock state right away; a failed or
    // refused save puts the stored state back.
    const revertLocal = () => {
      if (floating) floatingEvents = [knownEvent, ...floatingEvents.filter((item) => String(item.id || '') !== String(knownEvent.id || ''))];
      else updateLocalCalendarEvent(knownEvent.id, { locked:knownEvent.locked, schedule_locked:knownEvent.schedule_locked, schedule_lock:knownEvent.schedule_lock, unlock_confirmed:knownEvent.unlock_confirmed });
      events = visibleEvents();
      refreshActiveScheduleSurface();
    };
    if (floating) updateFloatingEvent({ ...knownEvent, ...lockFieldsFor(knownEvent) });
    else updateLocalCalendarEvent(knownEvent.id, lockFieldsFor(knownEvent));
    events = visibleEvents();
    refreshActiveScheduleSurface();
    try {
      const lockCheck = await checkStoredScheduleEvent(knownEvent, ['lock']);
      if (lockCheck.conflict) throw staleScheduleError();
      const base = lockCheck.fresh || knownEvent;
      const next = { ...base, ...lockFieldsFor(base) };
      if (floating) {
        const saved = await persistFloatingEvent(decorateFloatingEvent(next));
        updateFloatingEvent({ ...next, ...(saved || {}) });
      } else {
        const saved = await Scheduling.saveProjectEvent(orgId(), project, withExplicitAssignees(next), schedulingConfig);
        updateLocalCalendarEvent(knownEvent.id, saved?.event ? { locked:saved.event.locked, schedule_locked:saved.event.schedule_locked, schedule_lock:saved.event.schedule_lock } : {});
      }
      events = visibleEvents();
      refreshActiveScheduleSurface();
      focusedScheduleEventId = knownEvent.id;
      loadData({ force: true }).catch(() => null);
      showToast(
        nextLocked ? (material ? 'Delivery locked' : 'Schedule locked') : (material ? 'Delivery unlocked' : 'Schedule unlocked'),
        nextLocked ? 'The scheduled time is protected.' : 'You can move this item now.',
        true
      );
      return true;
    } catch (error) {
      revertLocal();
      if (isStaleSaveError(error)) {
        await reloadAfterStaleChange();
        return false;
      }
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_b20cc0a5a8b73a","Lock update failed") ?? "Lock update failed"), scheduleSaveErrorMessage(error, 'Could not update this scheduling lock.'), false);
      return false;
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
    // Auto-route changes assignments, so view-only sessions don't get it. In
    // Production it only orders timed single-crew jobs by travel (crews stay).
    const autoRouteTitle = scopeId === 'production'
      ? 'Order this day’s timed single-crew jobs by travel time. Crews stay as assigned; all-day, multi-crew and unassigned work is left alone.'
      : (globalThis.PlatformLanguage?.text("scheduling","m_de861b5028f734","Assign this day's appointments to the best people by travel time") ?? "Assign this day's appointments to the best people by travel time");
    const autoRouteBtn = scale === 'hourly' && canEditSchedule()
      ? `<button type="button" class="dash-routing-travel" data-routing-optimize="${String(scopeId)}" title="${escapeHtml(autoRouteTitle)}"><i class="fas fa-wand-magic-sparkles"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_d9a77d0e85805b"," Auto-route") ?? " Auto-route")}</button>`
      : '';
    const conflictCount = scale === 'hourly' ? routingDayConflicts(scopeId).length : 0;
    const overbookedCount = scale === 'hourly' ? Number(routingOverbooked[`${scopeId}:${routingDateValue()}`] || 0) : 0;
    const doubleBookedCount = scale === 'hourly' && scopeId === 'sales' ? routingDoubleBookedIds().size : 0;
    const flagHtml = [
      doubleBookedCount ? `<span class="dash-routing-flag double-booked" title="${escapeHtml(`${doubleBookedCount} appointments overlap another appointment for the same salesperson`)}"><i class="fas fa-user-clock" aria-hidden="true"></i> ${escapeHtml(`${doubleBookedCount} double-booked`)}</span>` : '',
      conflictCount ? `<span class="dash-routing-flag conflict" title="${((v0,v1,v2) => globalThis.PlatformLanguage?.htmlText("scheduling","m_1e000bf8e3efa8",`${v0} appointment${v1} assigned to an unavailable team member and need${v2} rescheduling`,{v0,v1,v2}) ?? `${v0} appointment${v1} assigned to an unavailable team member and need${v2} rescheduling`)(conflictCount,conflictCount === 1 ? ' is' : 's are',conflictCount === 1 ? 's' : '')}"><i class="fas fa-triangle-exclamation"></i>${((v3,v4) => globalThis.PlatformLanguage?.htmlText("scheduling","m_f2fd2f6805fe78",` ${v3} conflict${v4}`,{v3,v4}) ?? ` ${v3} conflict${v4}`)(conflictCount,conflictCount === 1 ? '' : 's')}</span>` : '',
      overbookedCount ? `<span class="dash-routing-flag overbooked" title="${((v0,v1) => globalThis.PlatformLanguage?.htmlText("scheduling","m_6085bc21c921bf",`The day is overbooked: ${v0} appointment${v1} could not be assigned to anyone`,{v0,v1}) ?? `The day is overbooked: ${v0} appointment${v1} could not be assigned to anyone`)(overbookedCount,overbookedCount === 1 ? '' : 's')}"><i class="fas fa-calendar-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_86a7bd113ad386"," Overbooked") ?? " Overbooked")}</span>` : ''
    ].join('');
    const dateLabel = scale === 'hourly'
      ? `<time class="dash-routing-date" datetime="${routingDateValue()}">${escapeHtml(routingDateLabel())}</time>`
      : '';
    const vehicleButton = scopeId === 'production' && equipmentSchedulingOn()
      ? `<button type="button" class="dash-routing-vehicles ${String(productionVehiclesVisible ? 'active' : '')}" data-routing-vehicles aria-pressed="${String(productionVehiclesVisible ? 'true' : 'false')}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_266a463e7e8cbd","Show vehicle assignment lanes") ?? "Show vehicle assignment lanes")}"><i class="fas fa-truck-pickup" aria-hidden="true"></i><span>Vehicles</span></button>`
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
      return `<div class="dash-card dash-schedule-card">${placementBannerHtml('routing')}<div class="dash-schedule-split">${availablePanes.map((pane) => routingPane(pane.label, pane.mount, pane.scale)).join('')}</div></div>`;
    }
    if (!availablePanes.some((pane) => pane.id === mobileRoutingPane)) {
      mobileRoutingPane = availablePanes.some((pane) => pane.id === scheduleMode) ? scheduleMode : availablePanes[0].id;
    }
    const activePane = availablePanes.find((pane) => pane.id === mobileRoutingPane) || availablePanes[0];
    const tabs = ("<div class=\"dash-routing-tabs\" role=\"tablist\" aria-label=\"" + (globalThis.PlatformLanguage?.text("scheduling","m_584e2a4849003b","Routing schedule") ?? "Routing schedule") + "\">" + String(availablePanes.map((pane) => `<button type="button" class="dash-routing-tab ${pane.id === activePane.id ? 'active' : ''}" data-mobile-routing-pane="${pane.id}" role="tab" aria-selected="${pane.id === activePane.id ? 'true' : 'false'}">${escapeHtml(pane.label)}</button>`).join('')) + "</div>");
    return `<div class="dash-card dash-schedule-card">${tabs}${placementBannerHtml('routing')}<div class="dash-schedule-split mobile-routing">${routingPane(activePane.label, activePane.mount, activePane.scale)}</div>${renderMobileRoutingPlacementDock(activePane.id)}</div>`;
  }
  function renderEventCalendarShell(){
    return `<div class="dash-card dash-schedule-card">${placementBannerHtml('calendar')}<div id="dashEventCalendarView" class="dash-schedule-view ${mobileCalendarSwipeDirection ? `mobile-swipe-${mobileCalendarSwipeDirection}` : ''}"></div></div>`;
  }
  // Sales appointments on the Routing day that overlap another appointment
  // of the same salesperson.
  function routingDoubleBookedIds(){
    const day = routingDateValue();
    return doubleBookedEventIds(salesRoutingEvents().filter((event) => {
      const start = eventStart(event);
      return start && routingDateValue(start) === day;
    }));
  }
  // Brings a selected, already-dated appointment into view in the Sales pane.
  function scrollRoutingToEvent(eventId = ''){
    const pane = rootEl?.querySelector('#dashScheduleViewSales');
    const chip = pane?.querySelector(`[data-prs-event-id="${window.CSS?.escape ? window.CSS.escape(String(eventId)) : String(eventId)}"]`);
    const scroll = chip?.closest('.prs-resource-scroll');
    if (!chip || !scroll) return;
    const chipRect = chip.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const label = scroll.querySelector('.prs-resource-label');
    const labelWidth = label?.getBoundingClientRect?.().width || 0;
    const visibleLeft = scrollRect.left + labelWidth;
    if (chipRect.left < visibleLeft + 8 || chipRect.right > scrollRect.right - 8) {
      scroll.scrollLeft += Math.round(chipRect.left - visibleLeft - Math.max(24, (scrollRect.width - labelWidth - chipRect.width) / 2));
    }
    if (chipRect.top < scrollRect.top || chipRect.bottom > scrollRect.bottom) {
      scroll.scrollTop += Math.round(chipRect.top - scrollRect.top - 40);
    }
    captureScheduleScroll();
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
    const scheduleEditable = canEditSchedule();
    const placementEnabled = scheduleEditable && !!(selected?.id && selectedEvent && (!eventIsScheduled(selectedEvent) || !currentAssignmentId(selectedEvent)));
    const creationEnabled = scheduleEditable && !!(selected?.id && selectedEvent && !eventIsScheduled(selectedEvent));
    // A waiting appointment that is being placed shows as its draft only (the
    // stored copy in "Unassigned" steps aside while the draft is staged).
    const stagedSalesId = placementEnabled && appointmentScheduleDraft?.start ? String(selectedEvent?.id || '') : '';
    const routingEvents = salesRoutingEvents();
    if (stagedSalesId) routingEvents.splice(0, routingEvents.length, ...routingEvents.filter((event) => String(event.id || '') !== stagedSalesId));
    // Dragging the waiting appointment itself (dated but unassigned) stages a
    // draft + ✓ as in Week/Month instead of saving at once.
    const isWaitingSalesItem = (event = {}) => placementEnabled && !!selectedEvent && String(event?.id || '') === String(selectedEvent.id || '') && event?.__draft !== true;
    const stageWaitingSalesMove = (range = {}) => {
      if (!range?.start) return;
      recordPlacementHistory();
      const user = assignableResources.find((resource) => clean(resource.id) === clean(currentAssignmentId(range))) || null;
      const assignment = user ? assignmentPayloadForSubject(user) : assignmentPayloadForEvent({ ...selectedEvent, ...range });
      appointmentScheduleEventId = String(selectedEvent.id || '');
      appointmentScheduleProjectId = String(selectedEvent.project_id || selected?.id || '');
      appointmentScheduleDraft = { ...salesDraftAtStart(range.start, range.all_day === false ? range.end : null), user, assignment };
      render();
      refreshPlacementEditor();
    };
    const assignableResources = salesResources(selectedEvent || { event_type_default_id:'sales_appointment' });
    const salesResourceId = (event = {}) => currentAssignmentId(event);
    const resourcePayload = (resource = {}) => assignmentPayloadForSubject(resource);
    // Row the draft sits in: a lane chosen for it, else the appointment's own
    // salesperson (never silently "Unassigned").
    const draftAssignment = salesDraftAssignment(appointmentScheduleDraft, selectedEvent);
    const laneAssignment = (next = {}) => {
      const user = assignableResources.find((resource) => clean(resource.id) === clean(currentAssignmentId(next))) || null;
      return { user, assignment:user ? assignmentPayloadForSubject(user) : assignmentPayloadForEvent(next) };
    };
    // Lane settings (profile, crew settings) are for schedule managers only.
    const openAssignmentResourceSettings = scheduleEditable ? (resource, meta = {}) => {
      if (clean(resource?.subject_type || resource?.resource_kind) === 'organization_user') openScheduleUserSettings(resource, meta);
      else openScheduleWorkResourceSettings(resource, meta);
    } : undefined;
    if (salesRoutingScale === 'daily' && window.PlatformScheduleView.renderResourceDayScheduler) {
      const duration = Number(selectedEvent?.duration_minutes || schedulingConfig?.event_types?.sales_appointment?.duration_minutes || 60);
      const draftStart = appointmentScheduleDraft?.start ? new Date(appointmentScheduleDraft.start) : null;
      // Before it has a day the draft is still passed (without a start) so the
      // hover preview and first placement look like this appointment, not a
      // grey untyped "New Event".
      const draft = draftStart || placementEnabled ? {
        ...(selectedEvent || {}),
        ...(appointmentScheduleDraft || {}),
        id:appointmentScheduleEventId || '__sales_routing_draft',
        event_id:appointmentScheduleEventId || '',
        event_type_default_id:eventTypeId(selectedEvent || {}) || 'sales_appointment',
        type_id:eventTypeId(selectedEvent || {}) || 'sales_appointment',
        title:appointmentScheduleDraft?.title || selectedEvent?.title || (globalThis.PlatformLanguage?.text("scheduling","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment"),
        project_title:projectTitle(selected || {}, selectedEvent || {}),
        start:draftStart,
        end:draftStart ? new Date(draftStart.getTime() + duration * 60000) : null,
        all_day:false,
        schedule_granularity:'time',
        ...draftAssignment
      } : null;
      const applyDailyDraft = (next = {}) => {
        if (!next?.start) return;
        const start = new Date(next.start);
        // A day cell only carries the date: keep the draft's (or the
        // appointment's) time of day, else start of the booking window.
        if (next.all_day !== false && next.schedule_granularity !== 'time') {
          const originalStart = appointmentScheduleDraft?.start ? new Date(appointmentScheduleDraft.start) : eventStart(selectedEvent);
          const fallbackMinutes = minutesForClock(appointmentWindowForDate(routeDate(start)).start, 9 * 60);
          start.setHours(originalStart ? originalStart.getHours() : Math.floor(fallbackMinutes / 60), originalStart ? originalStart.getMinutes() : fallbackMinutes % 60, 0, 0);
        }
        const { user, assignment } = laneAssignment(next);
        appointmentScheduleDraft = { ...salesDraftAtStart(start), user, assignment };
        refreshRailDraftLabel();
        refreshPlacementBanner();
        refreshPlacementEditor();
      };
      window.PlatformScheduleView.renderResourceDayScheduler(mount, {
        Scheduling:window.PlatformScheduling,
        config:schedulingConfig,
        project:selected || null,
        events:routingEvents,
        draft:renderedPlacementDraft(draft),
        activeDraftId:draft?.id || '',
        resources:routingLanesForFilter(assignableResources, routingEvents, salesResourceId),
        allowCreate:placementEnabled,
        // View-only sessions can look but not move appointments; every chip
        // (locked ones too) still opens its read-only/locked editor, and the
        // renderer refuses drags of locked chips.
        allowEdit:scheduleEditable,
        canEditEvent:() => true,
        onLockedDragAttempt:scheduleLockedDragAttempt,
        onReadOnlyDragAttempt:scheduleReadOnlyDragAttempt,
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
        unassignedLabel:'Unassigned',
        resourceIdForItem:salesResourceId,
        resourcePayload,
        onResourceSettings:openAssignmentResourceSettings,
        // Paging the lanes keeps date= (and the title) in step.
        onNavigate(nextDate){ anchorDate = validDate(nextDate) || anchorDate; syncScheduleRoute({ date:routeDate() }, { history:'replace', source:'sales-routing-date', ownedKeys:['date'] }); render(); },
        onDraftChange(next){ recordPlacementHistory(); applyDailyDraft(next); },
        // Clicking the staged draft opens its editor beside it (Save = ✓).
        onDraftSelect(draft){ if (isPlacementDraftEvent(draft)) openPlacementDraftEditor(draft); },
        onDraftConfirm(next){ applyDailyDraft(next); return confirmDashboardDraft(); },
        // Moving a placed appointment saves right away like every other view;
        // the renderer keeps its time of day on a day-to-day move. The waiting
        // appointment being placed is staged as a draft instead.
        onEventRangeChange(event, range){
          if (isWaitingSalesItem(event)) { stageWaitingSalesMove(range); return; }
          saveEventCalendarRange(event, range);
        },
        onEventClick(event, meta = {}){ openPlacedCalendarEvent(event, meta); }
      });
      markDoubleBookedChips(mount, doubleBookedEventIds(routingEvents));
      labelDraftConfirms(mount);
      return;
    }
    if (!window.PlatformScheduleView.renderResourceTimeScheduler) return;
    const eventType = schedulingConfig?.event_types?.sales_appointment || {};
    const duration = Number(selectedEvent?.duration_minutes || eventType.duration_minutes || 60);
    const windowForDay = appointmentWindowForDate(anchorDate);
    const workStartMinutes = minutesForClock(windowForDay.start, 8 * 60);
    const workEndMinutes = Math.max(workStartMinutes + 30, minutesForClock(windowForDay.end, 18 * 60));
    const draftStart = appointmentScheduleDraft?.start ? new Date(appointmentScheduleDraft.start) : null;
    const draft = creationEnabled || (placementEnabled && draftStart) ? {
      ...(selectedEvent || {}),
      ...(appointmentScheduleDraft || {}),
      id:appointmentScheduleEventId || selectedEvent?.id || '__sales_routing_draft',
      event_id:selectedEvent?.id || '',
      event_type_default_id:eventTypeId(selectedEvent || {}) || 'sales_appointment',
      title:appointmentScheduleDraft?.title || selectedEvent?.title || (globalThis.PlatformLanguage?.text("scheduling","m_600f41e7dca79d","Sales Appointment") ?? "Sales Appointment"),
      start:draftStart,
      end:draftStart ? salesDraftEnd(selectedEvent || {}) : null,
      all_day:false,
      schedule_granularity:'time',
      ...draftAssignment
    } : null;
    window.PlatformScheduleView.renderResourceTimeScheduler(mount, {
      Scheduling:window.PlatformScheduling,
      config:schedulingConfig,
      project:selected || null,
      events:routingEvents,
      draft:renderedPlacementDraft(draft),
      activeDraftId:draft?.id || '',
      resources:schedulerResourcesForDay(routingLanesForFilter(assignableResources, routingEvents, salesResourceId), routingDateValue()),
      // View-only sessions see availability but can't change it.
      ...(scheduleEditable ? { onResourceAvailabilityToggle(resource, meta = {}){ toggleSubjectAvailability(resource?.id, meta.date || routingDateValue()); } } : {}),
      allowCreate:creationEnabled,
      allowEdit:scheduleEditable,
      canEditEvent:() => true,
      onLockedDragAttempt:scheduleLockedDragAttempt,
      onReadOnlyDragAttempt:scheduleReadOnlyDragAttempt,
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
        // Paging days keeps the rail selection; a staged draft stays on its day.
        appointmentScheduleMenuEventId = '';
        resetScheduleScrollPersistence();
        syncScheduleRoute({ date:routeDate() }, { history:'replace', source:'sales-routing-date', ownedKeys:['date'] });
        render();
      },
      onEventRangeChange(event, range){
        // The waiting appointment being placed is staged (draft + ✓), as in
        // Week/Month; other appointments save right away.
        if (isWaitingSalesItem(event)) { stageWaitingSalesMove(range); return; }
        saveEventCalendarRange(event, range);
      },
      onEventClick(event, meta = {}){ openPlacedCalendarEvent(event, meta); },
      onTravelTimeResolved(result){ persistTravelTime(result); },
      onDraftSelect(draft){ if (isPlacementDraftEvent(draft)) openPlacementDraftEditor(draft); },
      onDraftChange(selection){
        if (!placementEnabled || !selection?.start) return;
        recordPlacementHistory();
        appointmentScheduleMenuEventId = '';
        const { user, assignment } = laneAssignment(selection);
        appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), ...selection, start:selection.start, user, assignment };
        refreshRailDraftLabel();
        refreshPlacementBanner();
        refreshPlacementEditor();
      },
      onDraftConfirm(draft){
        if (!placementEnabled || !draft?.start) return;
        const { user, assignment } = laneAssignment(draft);
        appointmentScheduleDraft = { ...(appointmentScheduleDraft || {}), ...draft, user, assignment };
        return confirmDashboardDraft();
      }
    });
    markDoubleBookedChips(mount, routingDoubleBookedIds());
    labelDraftConfirms(mount);
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
    // First load: show a loading state rather than empty lanes.
    if (scheduleInitialLoading()) {
      [splitSales, splitProduction].filter(Boolean).forEach((mount) => {
        mount.innerHTML = '<div class="dash-schedule-loading" role="status"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i>Loading schedule…</div>';
      });
      requestAnimationFrame(fitRoutingScheduleHeights);
      return;
    }
    if (splitSales) renderSalesScheduleView(splitSales);
    if (splitProduction) renderProductionScheduleView(splitProduction);
    bindScheduleScrollPersistence();
    requestAnimationFrame(fitRoutingScheduleHeights);
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
      draft: renderedPlacementDraft(draft),
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
      onPlacementCancel(){ if (!placementOverlayOpen() && placementWaitingItem()) requestCancelPlacement(); },
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
    const scheduleEditable = canEditSchedule();
    const selectedProject = selectedProductionProject();
    const selectedEventCandidate = selectedProductionEvent();
    const selectedEvent = isProductionEvent(selectedEventCandidate) ? selectedEventCandidate : null;
    // A delivery picked in the rail is placed into the Materials lane.
    const selectedMaterial = selectedPlacementKind() === 'materials' ? selectedMaterialEvent() : null;
    const placingMaterial = !!selectedMaterial && !eventIsScheduled(selectedMaterial);
    const materialsResourceId = '__materials__';
    const materialsResource = { id:materialsResourceId, name:'Materials', resource_kind:'materials', settings_disabled:true, availability_disabled:true };
    // Crews and teams first, then individual people, each alphabetical.
    const personLane = (resource) => clean(resource?.subject_type || resource?.resource_kind) === 'organization_user' ? 1 : 0;
    const crews = productionWorkResources(productionScheduleDraft?.scope_template_id || selectedEvent?.scope_template_id, productionScheduleDraft || selectedEvent)
      .slice()
      .sort((a, b) => personLane(a) - personLane(b) || clean(a.name).localeCompare(clean(b.name)));
    const vehicleLaneId = (crewId) => `__vehicle__:${clean(crewId)}`;
    const vehicleLaneCrewId = (resourceId) => clean(resourceId).startsWith('__vehicle__:') ? clean(resourceId).slice('__vehicle__:'.length) : '';
    // A booking stores the crew it travels with (id + name) and the unit as an
    // equipment ref; the lane's internal "__vehicle__:<crew>" id is only a
    // renderer row id and never saved as the booking's resource/assignee.
    const vehicleBookingFields = (item = {}) => {
      const { resource_id, resource_name, ...rest } = item || {};
      const crewId = clean(rest.vehicle_crew_id) || vehicleLaneCrewId(resource_id);
      const crew = crews.find((resource) => clean(resource.id) === crewId) || workforceResources.find((resource) => clean(resource.id) === crewId);
      const keep = clean(resource_id) && !clean(resource_id).startsWith('__vehicle__:') ? { resource_id, resource_name } : {};
      return { ...rest, ...keep, vehicle_crew_id:crewId, vehicle_crew_name:clean(crew?.name) || clean(rest.vehicle_crew_name) || crewId };
    };
    // Vehicles travel with crews/teams, so only they get a vehicle lane.
    const vehicleLanes = productionVehiclesVisible && equipmentSchedulingOn()
      ? crews.filter((crew) => !personLane(crew)).map((crew) => ({ id:vehicleLaneId(crew.id), name:`${crew.name || workResourceLabel()} vehicles`, resource_kind:'vehicle_lane', vehicle_crew_id:clean(crew.id), settings_disabled:true, availability_disabled:true }))
      : [];
    const resources = productionVehiclesVisible && equipmentSchedulingOn()
      ? [...crews.flatMap((crew) => [crew, vehicleLanes.find((lane) => lane.vehicle_crew_id === clean(crew.id))].filter(Boolean)), materialsResource]
      : [...crews, materialsResource];
    const vehicleBookings = productionVehiclesVisible && equipmentSchedulingOn()
      ? floatingEvents.filter(isVehicleBooking).filter(eventIsScheduled).map((event) => ({ ...vehicleBookingFields(decorateFloatingEvent(event)), __draft:false, __activeDraft:false }))
      : [];
    // A job worked by several crews shows in each crew's lane.
    const workItems = allEvents.filter(isProductionEvent).filter(eventIsScheduled).map(decorateWorkEvent).flatMap((item) => {
      const refs = eventCrewRefs(item);
      if (refs.length < 2) return [item];
      const label = refs.map((ref) => ref.name).join(' + ');
      // __lane_crew_id remembers which crew's copy this is (the renderer
      // rewrites the copy's assignment fields to the drop lane).
      return refs.map((ref) => ({ ...item, ...workResourcePayload({ id:ref.id, name:ref.name, resource_kind:ref.kind }), assignee_label:label, __lane_crew_id:ref.id }));
    });
    // The header's person/lead-source/city filter applies here as in Week.
    const productionEvents = [
      ...workItems,
      ...allEvents.filter(isMaterialEvent).filter(eventIsScheduled).map(decorateMaterialEvent),
      ...vehicleBookings
    ].filter(eventMatchesBreakdown);
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
    const materialDraft = placingMaterial ? {
      ...decorateMaterialEvent(selectedMaterial),
      id:selectedMaterial.id,
      event_id:selectedMaterial.id,
      start:materialScheduleDraft?.start || null,
      end:materialScheduleDraft?.end || null,
      all_day:materialScheduleDraft?.all_day ?? selectedMaterial.all_day ?? true,
      schedule_granularity:materialScheduleDraft?.schedule_granularity || selectedMaterial.schedule_granularity || 'date'
    } : null;
    const draft = vehicleDraft || materialDraft || productionScheduleDraft || (selectedEvent ? {
      id: selectedEvent.id,
      event_id: selectedEvent.id,
      event_type_default_id: eventTypeId(selectedEvent) || 'project_work',
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
      if (placingMaterial) {
        if (!next?.start) { materialScheduleDraft = null; return; }
        applyMaterialScheduleDraft({ ...next, id:selectedMaterial.id, event_id:selectedMaterial.id });
        return;
      }
      if (!next?.start) {
        productionScheduleDraft = null;
        return;
      }
      // Moving one item of a staged bundle carries the whole bundle (by the
      // same shift, into the lane it was dropped in): the primary draft moves.
      if (productionScheduleBundleKey && productionScheduleDraft?.start) {
        const primaryId = clean(productionScheduleDraft.id || productionScheduleEventId);
        const nextId = clean(next.id || next.event_id);
        if (nextId && primaryId && nextId !== primaryId) {
          const before = productionScheduleBundleDrafts.find((item) => clean(item.id || item.event_id) === nextId);
          const delta = before?.start ? new Date(next.start).getTime() - new Date(before.start).getTime() : 0;
          next = {
            ...productionScheduleDraft,
            ...assignmentPayloadForEvent(next),
            start:new Date(new Date(productionScheduleDraft.start).getTime() + delta),
            end:productionScheduleDraft.end ? new Date(new Date(productionScheduleDraft.end).getTime() + delta) : null
          };
        }
      }
      const project = selectedProject || eventProject(selectedEvent || {});
      productionScheduleProjectId = String(project?.id || productionScheduleProjectId || '');
      productionScheduleEventId = String(next.event_id || productionScheduleEventId || '');
      const title = projectTitle(project || {}, next);
      const address = projectAddress(project || {}, next);
      const draftResourceId = currentAssignmentId(next);
      const draftResource = resources.find((resource) => clean(resource.id) === draftResourceId);
      const typedAssignment = draftResource ? assignmentPayloadForSubject(draftResource) : assignmentPayloadForEvent(next);
      // Notes and customer sharing typed in the draft editor survive a move.
      const { title:_editedTitle, ...editedFields } = clean(productionScheduleDraft?.event_id || productionScheduleDraft?.id) === clean(next.event_id || next.id) ? editorFieldsFromDraft(productionScheduleDraft) : {};
      productionScheduleDraft = {
        ...editedFields,
        ...(productionScheduleDraft?.__new_event_id ? { __new_event_id:productionScheduleDraft.__new_event_id } : {}),
        id: next.id || next.event_id || '__production_draft',
        event_id: next.event_id || productionScheduleEventId || '',
        // Typed like the item it places so the draft keeps its category color.
        event_type_default_id: eventTypeId(selectedEvent || next) || 'project_work',
        // New work for a project with nothing scheduled is titled from the job.
        title: (clean(next.title) && !(!selectedEvent && ['New Event', title].includes(clean(next.title))) ? next.title : '') || (selectedEvent ? (selectedEvent.title || title) : projectWorkTitle(project || {})) || 'New Event',
        project_title: next.project_title || title,
        project_address: next.project_address || address,
        start: next.start,
        end: next.end || addDays(new Date(next.start), 1),
        all_day: next.all_day !== false,
        schedule_granularity: next.schedule_granularity || (next.all_day === false ? 'time' : 'date'),
        ...typedAssignment
      };
    };
    const common = {
      Scheduling,
      config: schedulingConfig,
      project: selectedProject || (selectedMaterial ? eventProject(selectedMaterial) : null) || null,
      events: productionEvents,
      // Only a waiting item being placed is a draft (✓ saves it); an already
      // scheduled item that is merely selected moves and saves directly.
      draft: placementWaitingItem() ? renderedPlacementDraft(draft) : draft,
      drafts:(productionScheduleBundleDrafts.length ? productionScheduleBundleDrafts : (draft ? [draft] : [])).map((item) => placementWaitingItem() ? renderedPlacementDraft(item) : item),
      activeDraftId: draft?.id || '',
      resources:routingLanesForFilter(resources, productionEvents, resourceIdForItem),
      allowCreate: scheduleEditable && (!!vehiclePlacementUnitId || placingMaterial || (!!selectedProject && (!selectedEvent || !eventIsScheduled(selectedEvent)))),
      placementMode: (selectedEvent && !eventIsScheduled(selectedEvent)) || placingMaterial ? 'click' : 'drag',
      derivePlacementDrafts(primaryDraft){ return placingMaterial || vehiclePlacementUnitId ? [primaryDraft] : scheduleBundleDrafts(primaryDraft); },
      onPlacementCancel(){ if (!placementOverlayOpen() && placementWaitingItem()) requestCancelPlacement(); },
      // Clicking a staged draft opens its editor beside it (Save = ✓).
      onDraftSelect(draft){ if (isPlacementDraftEvent(draft) && !vehiclePlacementUnitId) openPlacementDraftEditor(draft); },
      // View-only sessions and locked items still open (read-only / locked
      // editor); moves are refused by allowEdit / the renderer's lock check.
      allowEdit: scheduleEditable,
      canEditEvent:() => true,
      onLockedDragAttempt:scheduleLockedDragAttempt,
      onReadOnlyDragAttempt:scheduleReadOnlyDragAttempt,
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
      // Why a drop into a row is refused, in that row's own terms.
      placementRefusalReason(item = {}, resource = null){
        const laneKind = clean(resource?.resource_kind);
        const intoMaterials = clean(resource?.id) === materialsResourceId;
        if (isVehicleBooking(item) || (vehiclePlacementUnitId && (item?.__draft === true || clean(item?.id) === '__vehicle_draft'))) return 'Vehicles go in a crew’s vehicle lane (the row under the crew).';
        if (isMaterialEvent(item)) return 'Deliveries go in the Materials row.';
        if (intoMaterials) return 'Only deliveries go in the Materials row. Drop work in a crew or person row.';
        if (laneKind === 'vehicle_lane') return 'Vehicle lanes hold vehicle bookings only. Drop work in the crew’s own row.';
        return '';
      },
      ...(scheduleEditable ? { onResourceSettings(resource, meta){ if (clean(resource?.id) !== materialsResourceId) openScheduleWorkResourceSettings(resource, meta); } } : {}),
      onNavigate(nextDate){ anchorDate = validDate(nextDate) || anchorDate; syncScheduleRoute({ date:routeDate() }, { history:'replace', source:'production-routing-date', ownedKeys:['date'] }); render(); },
      onDraftChange(next){
        recordPlacementHistory();
        // A daily-lane cell always stages a whole day. The first placement
        // takes the item's natural span (a timed job keeps its hours, as in
        // Week/Month); a later daily move of a timed draft only changes its day.
        let incoming = next;
        if (next?.start && !vehiclePlacementUnitId && !placingMaterial) {
          const staged = productionScheduleDraft?.start ? productionScheduleDraft : null;
          if (!staged) incoming = placementNaturalRange(next);
          else if (next.all_day !== false && staged.all_day === false) {
            const stagedStart = new Date(staged.start);
            const stagedEnd = new Date(staged.end || stagedStart.getTime() + 60 * 60000);
            const movedStart = startOfDay(new Date(next.start));
            movedStart.setHours(stagedStart.getHours(), stagedStart.getMinutes(), 0, 0);
            incoming = { ...next, start:movedStart, end:new Date(movedStart.getTime() + Math.max(15 * 60000, stagedEnd - stagedStart)), all_day:false, schedule_granularity:'time' };
          }
        }
        applyDraft(incoming);
        if (vehiclePlacementUnitId || placingMaterial) {
          renderScheduleLibraryViewPreserveScroll();
          refreshPlacementBanner();
          // A vehicle that is already booked (or out of service) then is
          // flagged as soon as it is staged, not only at ✓.
          const unit = vehiclePlacementUnitId ? equipmentUnits.find((item) => clean(item.id) === vehiclePlacementUnitId) : null;
          const staged = vehiclePlacementDraft?.start ? { id:'__vehicle_draft', start:new Date(vehiclePlacementDraft.start), end:new Date(vehiclePlacementDraft.end || addDays(new Date(vehiclePlacementDraft.start), 1)) } : null;
          if (unit && staged) {
            const down = typeof equipmentDownDetail === 'function' ? equipmentDownDetail(unit, staged) : null;
            const booked = equipmentUnitConflict(staged, unit.id);
            if (down || booked) showToast('Vehicle not free then', `${clean(unit.name) || 'This vehicle'} is ${down ? 'out of service' : 'already booked'} at that time. Pick another time or vehicle.`, { tone:'warning', duration:6000 });
          }
          return;
        }
        productionScheduleBundleDrafts = scheduleBundleDrafts(productionScheduleDraft || next);
        renderScheduleLibraryViewPreserveScroll();
        refreshPlacementBanner();
        refreshPlacementEditor();
      },
      async onDraftConfirm(next){
        if (vehiclePlacementUnitId) {
          if (next) applyDraft(next);
          const pending = vehiclePlacementDraft;
          const unit = equipmentUnits.find((item) => clean(item.id) === vehiclePlacementUnitId);
          if (!pending?.start || !unit) return;
          // A vehicle is equipment: it can't be booked over another booking,
          // reservation or maintenance window (conflict mode "block"), and
          // otherwise only after confirming the double booking.
          const pendingRange = { id:'__vehicle_draft', start:new Date(pending.start), end:new Date(pending.end || addDays(new Date(pending.start), 1)) };
          const downDetail = typeof equipmentDownDetail === 'function' ? equipmentDownDetail(unit, pendingRange) : null;
          const unitType = equipmentTypes.find((type) => clean(type?.id) === clean(unit.type_id)) || null;
          const conflicted = equipmentUnitConflict(pendingRange, unit.id);
          if ((downDetail && downDetail.blocked) || (conflicted && equipmentConflictMode === 'block' && unitType?.allow_double_booking !== true)) {
            showToast((globalThis.PlatformLanguage?.text("scheduling","m_f9ef6bab2b4dce","Vehicle not scheduled") ?? "Vehicle not scheduled"), downDetail?.blocked ? `${downDetail.reason || `${clean(unit.name) || 'This vehicle'} is out of service then.`} Pick another time or vehicle.` : `${clean(unit.name) || 'This vehicle'} is already booked at that time. Pick another time or vehicle.`, false);
            return;
          }
          if (conflicted || downDetail) {
            const confirmBooking = window.Portal?.ui?.confirm || window.PlatformUI?.confirm;
            if (typeof confirmBooking === 'function' && !(await confirmBooking(`${clean(unit.name) || 'This vehicle'} is ${conflicted ? 'already booked' : 'marked unavailable'} at that time. Book it anyway?`, { title:'Vehicle double-booked', okLabel:'Book anyway', cancelLabel:'Keep editing' }))) return;
          }
          const booking = updateFloatingEvent({
            ...vehicleBookingFields(pending),
            id:floatingEventId(),
            title:unit.name || unit.id,
            kind:'equipment_booking',
            event_type_default_id:'equipment_booking',
            vehicle_booking:true,
            resource_refs:[{ kind:'equipment_unit', id:clean(unit.id), name:clean(unit.name) || clean(unit.id), role:'equipment', start_at:new Date(pending.start).toISOString(), end_at:new Date(pending.end).toISOString() }],
            // The staged draft's renderer flags must not be stored with the
            // booking (a stored "__draft" booking is ignored by conflicts).
            __draft:false,
            __activeDraft:false,
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
            // Nothing was stored: drop the optimistic booking from the lane.
            floatingEvents = floatingEvents.filter((item) => String(item.id || '') !== String(booking.id || ''));
            renderScheduleLibraryViewPreserveScroll();
            if (isStaleSaveError(error)) { await reloadAfterStaleChange(); return; }
            showToast((globalThis.PlatformLanguage?.text("scheduling","m_f9ef6bab2b4dce","Vehicle not scheduled") ?? "Vehicle not scheduled"), scheduleSaveErrorMessage(error, 'Could not save the vehicle assignment.'), false);
          }
          return;
        }
        if (placingMaterial) {
          if (next) applyDraft(next);
          return confirmMaterialDraft();
        }
        // A bundle is committed from its primary draft whichever item's ✓
        // was clicked.
        if (productionScheduleBundleKey && productionScheduleDraft?.start) return confirmProductionBundleDraft(productionScheduleDraft);
        // The chip copy still carries the stored title; a title typed in the
        // draft editor wins on confirm (drags keep it the same way).
        // The staged draft already holds what the editor set (End, times,
        // title); ✓ confirms it as staged rather than the chip's copy.
        const sameDraft = !!next && !!productionScheduleDraft?.start && clean(productionScheduleDraft?.event_id || productionScheduleDraft?.id) === clean(next.event_id || next.id);
        if (next && !sameDraft) applyDraft(next);
        return productionScheduleBundleKey ? confirmProductionBundleDraft(productionScheduleDraft || next) : confirmProductionDraft(productionScheduleDraft || next);
      },
      // Moving an already-placed item saves right away (as in every other
      // view); only waiting items from the rail are staged as ✓ drafts.
      onEventRangeChange(event, range){
        if (isVehicleBooking(event)) {
          const rangeStart = validDate(range.start || range.start_at);
          const rangeEnd = validDate(range.end || range.end_at);
          // A changed length is a resize; word the toasts to match. The
          // renderer hands over the booking with the new range already on it,
          // so the length is compared with the stored copy.
          const storedBooking = floatingEvents.find((item) => String(item.id || '') === String(event.id || '')) || event;
          const bookedStart = eventStart(storedBooking), bookedEnd = eventEnd(storedBooking);
          const resized = !!(rangeStart && rangeEnd && bookedStart && bookedEnd && Math.abs((rangeEnd - rangeStart) - (bookedEnd - bookedStart)) > 60000);
          const vehicleNotChanged = resized ? 'Vehicle booking not resized' : (globalThis.PlatformLanguage?.text("scheduling","m_fed89027106fe3","Vehicle not moved") ?? "Vehicle not moved");
          // Moving a booking onto a time the vehicle is already booked is
          // refused in "block" mode, like booking it there would be.
          const movedUnitId = clean(eventEquipRefs(event).find((ref) => clean(ref?.kind) === 'equipment_unit')?.id);
          const movedUnit = equipmentUnits.find((item) => clean(item.id) === movedUnitId);
          const movedType = equipmentTypes.find((type) => clean(type?.id) === clean(movedUnit?.type_id)) || null;
          if (movedUnitId && rangeStart && rangeEnd && equipmentConflictMode === 'block' && movedType?.allow_double_booking !== true
            && equipmentUnitConflict({ id:event.id, start:rangeStart, end:rangeEnd }, movedUnitId)) {
            showToast(vehicleNotChanged, `${clean(event.title) || 'This vehicle'} is already booked at that time.`, false);
            renderScheduleLibraryViewPreserveScroll();
            return;
          }
          const resourceRefs = (Array.isArray(event.resource_refs) ? event.resource_refs : []).map((ref) => clean(ref?.kind) === 'equipment_unit'
            ? { ...ref, ...(rangeStart ? { start_at:rangeStart.toISOString() } : {}), ...(rangeEnd ? { end_at:rangeEnd.toISOString() } : {}) }
            : ref);
          const previousBooking = floatingEvents.find((item) => String(item.id || '') === String(event.id || '')) || null;
          const next = updateFloatingEvent(vehicleBookingFields({ ...event, ...range, resource_refs:resourceRefs, vehicle_crew_id:vehicleLaneCrewId(range.resource_id) || clean(range.vehicle_crew_id) || event.vehicle_crew_id, status:'scheduled' }));
          renderScheduleLibraryViewPreserveScroll();
          void persistFloatingEvent(next)
            .then(() => showToast(resized ? 'Vehicle booking resized' : 'Vehicle moved', `${clean(next.title) || 'The vehicle'} booking was updated.`, true))
            .catch(async (error) => {
              // A refused move puts the booking back where it was at once.
              if (previousBooking) floatingEvents = floatingEvents.map((item) => String(item.id || '') === String(previousBooking.id || '') ? previousBooking : item);
              renderScheduleLibraryViewPreserveScroll();
              // Deleted / changed elsewhere: reload and use the same wording
              // as every other surface ("Deleted by someone else").
              const gone = error?.deleted === true || Number(error?.status) === 404 || /not[_\s-]?found/i.test(clean(error?.code || error?.error));
              if (gone) { await reloadAfterStaleChange({ deleted:true }); return; }
              if (isStaleSaveError(error)) { await reloadAfterStaleChange(error); return; }
              showToast(vehicleNotChanged, scheduleSaveErrorMessage(error, 'Could not update the vehicle assignment.'), false);
            });
          return;
        }
        // Timed deliveries keep their time; all-day ones stay all-day. A
        // multi-crew job's drop replaces the crew of the lane it was dragged
        // from (the lane under the pointer when the drag started).
        const startLane = clean(mount.__dashPointerLane);
        const stored = allEvents.find((item) => String(item.id || '') === String(event?.id || '')) || event;
        const dragged = startLane && isProductionEvent(stored) && eventCrewRefs(stored).some((ref) => ref.id === startLane) ? { ...event, __lane_crew_id:startLane } : event;
        saveEventCalendarRange(dragged, range);
      },
      onEventClick(event, meta = {}){
        if (placeIntoOccupiedCell(event)) return;
        openPlacedCalendarEvent(event, meta);
      }
    };
    // While placing, a click on a cell that already holds a job places the
    // waiting item in that cell (as an empty cell would) instead of opening
    // the job that happens to sit there.
    const placeIntoOccupiedCell = (event) => {
      const placing = !!vehiclePlacementUnitId || placingMaterial || (!!placementWaitingItem() && !!selectedProject && (!selectedEvent || !eventIsScheduled(selectedEvent)));
      const pointer = mount.__dashLastPointer;
      if (!placing || !pointer || event?.__draft === true) return false;
      const cell = [...mount.querySelectorAll('.prs-resource-cell[data-prs-resource],.prs-resource-time-cell[data-prs-resource]')].find((node) => {
        const rect = node.getBoundingClientRect();
        return pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom;
      });
      if (!cell) return false;
      const resource = resources.find((item) => clean(item.id) === clean(cell.dataset.prsResource)) || { id:'', name:'Unassigned', unassigned:true };
      const base = draft || {};
      if (!canPlaceItemInResource(base, resource)) return false;
      const baseStart = validDate(base.start);
      const baseEnd = validDate(base.end);
      let start;
      let end;
      let allDay = true;
      if (cell.dataset.prsDate) {
        start = new Date(`${cell.dataset.prsDate}T00:00:00`);
        end = addDays(start, baseStart && baseEnd ? Math.max(1, Math.round((baseEnd - baseStart) / 86400000)) : 1);
      } else {
        start = startOfDay(anchorDate) || new Date();
        start.setMinutes(Number(cell.dataset.prsMinute || 0));
        const timedSpan = baseStart && baseEnd && base.all_day === false ? Math.max(30 * 60000, baseEnd - baseStart) : 60 * 60000;
        end = new Date(start.getTime() + timedSpan);
        allDay = false;
      }
      common.onDraftChange({ ...base, ...resourcePayload(resource), id:base.id || '__draft', start, end, all_day:allDay, schedule_granularity:allDay ? 'date' : 'time' });
      return true;
    };
    if (!mount.__dashPointerTracked) {
      mount.__dashPointerTracked = true;
      mount.addEventListener('pointerdown', (pointerEvent) => {
        mount.__dashLastPointer = { x:pointerEvent.clientX, y:pointerEvent.clientY };
        // The lane (row) a drag starts in: a multi-crew job is drawn once per
        // crew, and a drop replaces only the crew whose copy was dragged.
        const x = pointerEvent.clientX;
        const y = pointerEvent.clientY;
        const cell = [...mount.querySelectorAll('.prs-resource-cell[data-prs-resource],.prs-resource-time-cell[data-prs-resource]')].find((node) => {
          const rect = node.getBoundingClientRect();
          return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        });
        mount.__dashPointerLane = cell ? clean(cell.dataset.prsResource) : null;
      }, true);
    }
    if (viewMode === 'appointment_schedule' && productionRoutingScale === 'hourly' && window.PlatformScheduleView.renderResourceTimeScheduler) {
      window.PlatformScheduleView.renderResourceTimeScheduler(mount, {
        ...common,
        resources: schedulerResourcesForDay(resources, routingDateValue()),
        // Materials and vehicle lanes are not people or crews: no availability.
        ...(scheduleEditable ? { onResourceAvailabilityToggle(resource, meta = {}){ if (resource?.availability_disabled !== true) toggleSubjectAvailability(resource?.id, meta.date || routingDateValue()); } } : {}),
        slotMinutes:30,
        liveTravel: productionLiveTravel && travelTimeEnabled(),
        travelTimeCache: dashboardTravelTimeCache(),
        onLiveTravelToggle(next){ productionLiveTravel = !!next; persistSchedulePreference({ production_live_travel: !!next }); renderScheduleLibraryViewPreserveScroll(); },
        onTravelTimeResolved(result){ persistTravelTime(result); }
      });
    } else if (viewMode === 'appointment_schedule' && window.PlatformScheduleView.renderResourceDayScheduler) {
      window.PlatformScheduleView.renderResourceDayScheduler(mount, { ...common, mode:'week', dayCount:180, pastDays:14 });
    }
    // Flag lanes that are double-booked: a crew/person on two overlapping
    // jobs, or one vehicle booked twice at the same time.
    const vehicleUnitId = (event) => clean(eventEquipRefs(event).find((ref) => clean(ref?.kind) === 'equipment_unit')?.id);
    const crewBooked = doubleBookedEventIds(workItems.filter((item) => !['completed', 'complete', 'done'].includes(clean(item.status).toLowerCase())), (item) => workCrewId(item) || clean(item?.assigned_user_id || item?.assigned_user_ids?.[0]));
    const vehicleBooked = doubleBookedEventIds(vehicleBookings, vehicleUnitId);
    markDoubleBookedChips(mount, new Set([...crewBooked, ...vehicleBooked]), 'Double-booked: this crew or vehicle has another booking at the same time');
    labelDraftConfirms(mount);
    // A staged vehicle draft on a time its unit is already taken stays
    // flagged (not only by the passing toast): marked chip, and its ✓ says why.
    if (selectedVehicle && vehiclePlacementDraft?.start) {
      const staged = { id:'__vehicle_draft', start:new Date(vehiclePlacementDraft.start), end:new Date(vehiclePlacementDraft.end || addDays(new Date(vehiclePlacementDraft.start), 1)) };
      const down = equipmentDownDetail(selectedVehicle, staged);
      const booked = equipmentUnitConflict(staged, selectedVehicle.id);
      if (down || booked) {
        const reason = `${clean(selectedVehicle.name) || 'This vehicle'} is ${down ? 'out of service' : 'already booked'} then. Drag the draft to a free time or pick another vehicle.`;
        mount.querySelectorAll(railAttrSelector('data-prs-event-id', vehiclePlacementDraft.id || '__vehicle_draft')).forEach((chip) => {
          chip.classList.add('dash-double-booked', 'dash-vehicle-draft-conflict');
          chip.setAttribute('title', reason);
          chip.querySelectorAll('[data-prs-confirm]').forEach((check) => { check.setAttribute('title', reason); check.setAttribute('aria-label', `Can't book: ${reason}`); });
        });
      }
    }
    bindScheduleScrollPersistence();
  }
  // Timeline collapse state is remembered per viewer and organization.
  let ganttCollapsedRestored = false;
  // A work item/section added from the Timeline stays local until the editor
  // saves it; closing the editor any other way discards it.
  let ganttPendingNewItem = null;
  function ganttCollapseStorageKey(){
    return `fm.scheduling.timeline.collapsed:${orgId() || 'org'}`;
  }
  function restoreGanttCollapsed(){
    if (ganttCollapsedRestored) return;
    ganttCollapsedRestored = true;
    try {
      const saved = JSON.parse(window.localStorage?.getItem(ganttCollapseStorageKey()) || '[]');
      if (Array.isArray(saved)) ganttCollapsedGroups = [...new Set([...ganttCollapsedGroups, ...saved.map((id) => String(id || '')).filter(Boolean)])];
    } catch (error) {}
  }
  function persistGanttCollapsed(){
    try { window.localStorage?.setItem(ganttCollapseStorageKey(), JSON.stringify(ganttCollapsedGroups.slice(-300))); } catch (error) {}
  }
  function ganttCanEdit(){
    return typeof canEditSchedule === 'function' ? canEditSchedule() : true;
  }
  // Legacy items without an all_day flag: an off-midnight start lasting
  // under a day is timed (same inference as the calendar renderers).
  function ganttItemIsTimed(event = {}){
    const granularity = clean(event.schedule_granularity).toLowerCase();
    if (typeof event.all_day === 'boolean' || granularity) return event.all_day === false || granularity === 'time';
    const start = eventStart(event);
    if (!start) return false;
    const end = eventEnd(event);
    const minutes = end && end > start ? (end.getTime() - start.getTime()) / 60000 : Number(event.duration_minutes || 0);
    return (start.getHours() !== 0 || start.getMinutes() !== 0) && minutes > 0 && minutes < 1440;
  }
  // Rows keep a stable order across saves and reloads: projects by name,
  // items in creation order (the server may re-append a saved item).
  function ganttStableOrder(list = []){
    const position = new Map(list.map((event, index) => [String(event.id || ''), index]));
    const created = (event) => Date.parse(event.created_at || '') || 0;
    return [...list].sort((a, b) => (created(a) - created(b)) || (position.get(String(a.id || '')) - position.get(String(b.id || ''))));
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
    const visibleItems = allEvents.filter((event) => {
      if (Scheduling?.eventIsGroup?.(event) || !eventMatchesMode(event) || !eventMatchesBreakdown(event)) return false;
      const kind = kindFor(event);
      return !['labor', 'equipment', 'deliveries'].includes(kind) || ganttVisibleKinds.has(kind);
    });
    const visibleIds = new Set(visibleItems.map((event) => String(event.id || '')));
    const visibleParentIds = new Set(visibleItems.map((event) => String(Scheduling?.eventParentId?.(event) || event.parent_event_id || '')).filter(Boolean));
    // A section with nothing in it yet (e.g. just added) still shows, so work
    // can be added to it; sections whose items are all filtered out do not.
    const parentIds = new Set(allEvents.map((event) => String(Scheduling?.eventParentId?.(event) || event.parent_event_id || '')).filter(Boolean));
    const emptySection = (event) => !parentIds.has(String(event.id || ''))
      && !['cancelled', 'canceled'].includes(clean(event.status).toLowerCase())
      && eventMatchesBreakdown(event)
      && (scheduleTypeActive('production') || eventMatchesMode(event));
    const projectItems = allEvents.filter((event) => visibleIds.has(String(event.id || '')) || (Scheduling?.eventIsGroup?.(event) && (visibleParentIds.has(String(event.id || '')) || emptySection(event))));
    // Company and equipment calendar events (no project) share the board, as
    // they do in the calendar views.
    const calendarItems = floatingEvents
      .filter((event) => !isVehicleBooking(event) && eventIsScheduled(event) && eventMatchesMode(event) && eventMatchesBreakdown(event))
      .map(decorateFloatingEvent)
      .sort((a, b) => (eventStart(a)?.getTime() || 0) - (eventStart(b)?.getTime() || 0) || String(a.id || '').localeCompare(String(b.id || '')));
    return [...ganttStableOrder(projectItems), ...calendarItems];
  }
  function ganttResourceLanes(){
    const workforceKeys = new Set(workforceResources.map((resource) => `${clean(resource.subject_type || resource.resource_kind) || 'resource_group'}:${clean(resource.id)}`));
    // People who hold visible appointments get their own lane even when they
    // are not workforce resources (sales reps), instead of piling into Unassigned.
    const assignedUserIds = new Set(ganttVisibleEvents().flatMap((event) => (Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : []).map(clean)).filter(Boolean));
    const peopleLanes = users
      .filter((user) => assignedUserIds.has(clean(user.id)) && !workforceKeys.has(`organization_user:${clean(user.id)}`))
      .map((user) => ({ kind:'organization_user', id:clean(user.id), name:clean(user.name || user.email) || clean(user.id), icon:'fa-user' }));
    return [
      ...workforceResources.map((resource) => ({
        kind: clean(resource.subject_type || resource.resource_kind) || 'resource_group',
        id: resource.id,
        name: resource.name,
        icon: clean(resource.icon)
      })),
      ...peopleLanes,
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
    restoreGanttCollapsed();
    const canEdit = ganttCanEdit();
    const ganttEvents = ganttVisibleEvents();
    const projectIds = new Set(ganttEvents.map((event) => String(event.project_id || '')));
    const ganttProjects = projects
      .filter((project) => projectIds.has(String(project.id || '')))
      .map((project) => ({ ...project, display_name:projectTitle(project) }))
      .sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || ''), undefined, { sensitivity:'base' }) || String(a.id || '').localeCompare(String(b.id || '')));
    const shownOptions = [
      ['labor', 'Labor', 'fa-helmet-safety'],
      ['equipment', 'Equipment', 'fa-truck-pickup'],
      ['deliveries', 'Deliveries', 'fa-truck-ramp-box']
    ];
    const productionDetailAvailable = scheduleTypeActive('production');
    const groupControls = `<div class="dash-gantt-groupby"><span class="dash-segmented" role="group" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8b0eeec3c3b8c8","Group by") ?? "Group by")}"><span class="dash-segmented-label">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8b0eeec3c3b8c8","Group by") ?? "Group by")}</span>${String([
      ['project', 'Project'], ['resource', 'Resource']
    ].map(([id, label]) => `<button type="button" class="dash-gantt-groupby-btn ${ganttGroupBy === id ? 'active' : ''}" data-gantt-group-by="${id}" aria-pressed="${ganttGroupBy === id ? 'true' : 'false'}"${id === 'resource' ? ' title="One row per crew, person or unit. Dragging a bar changes its dates; open the item to change who it is assigned to."' : ''}>${label}</button>`).join(''))}</span>
      ${productionDetailAvailable ? `<div class="dash-gantt-shown-wrap">
        <button type="button" class="dash-gantt-shown-btn ${String(ganttShownMenuOpen || ganttVisibleKinds.size !== shownOptions.length ? 'active' : '')}" data-gantt-shown aria-expanded="${String(ganttShownMenuOpen ? 'true' : 'false')}" aria-haspopup="true"${ganttShownMenuOpen ? '' : ' title="Choose which production work is shown"'}><i class="fas fa-sliders"></i><span>${ganttVisibleKinds.size === shownOptions.length ? 'All production' : `${ganttVisibleKinds.size} of ${shownOptions.length} production`}</span></button>
        ${String(ganttShownMenuOpen ? `<div class="dash-gantt-shown-menu" data-gantt-shown-menu>
          <div class="dash-gantt-shown-head"><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_80fdf3a3a8501b","Items shown") ?? "Items shown")}</strong><button type="button" data-gantt-shown-close aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>
          <div class="dash-gantt-shown-options">${shownOptions.map(([id, label, icon]) => `<button type="button" class="dash-gantt-shown-option ${ganttVisibleKinds.has(id) ? 'active' : ''}" data-gantt-kind="${id}" aria-pressed="${ganttVisibleKinds.has(id) ? 'true' : 'false'}"><span class="dash-gantt-shown-check"><i class="fas fa-check"></i></span><i class="fas ${icon}"></i><span>${label}</span></button>`).join('')}</div>
        </div>` : '')}
      </div>` : ''}
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
      modeLabel: window.Portal?.terminology?.get?.('scheduling.gantt_view', 'Timeline') || 'Timeline',
      toolbarLeadingHtml:groupControls,
      stateKey:`scheduling:${ganttGroupBy}`,
      showTodayButton:false,
      readOnly: !canEdit,
      onReadOnlyDragAttempt: scheduleReadOnlyDragAttempt,
      // Section bars move their items through the shared group move.
      allowGroupMove: typeof moveScheduleGroup === 'function',
      otherEventsLabel: (globalThis.PlatformLanguage?.text("scheduling","m_timeline_other_events","Company & equipment events") ?? "Company & equipment events"),
      emptyLabel: activeScheduleTypes().length ? 'Nothing matches the schedules shown. Turn on more schedule types above.' : 'Turn on Sales, Production, or Other above to see the timeline.',
      onViewportChange(range){
        ganttVisibleRange = range;
        const title = rootEl?.querySelector('.dash-toolbar .dash-title');
        if (title && viewMode === 'gantt') { title.textContent = visibleTitle(); title.title = title.textContent; }
        // The phone header's month button follows the scrolled Timeline too.
        const phoneMonth = rootEl?.querySelector('[data-mobile-month-menu] > span');
        const rangeStart = validDate(range?.start);
        const rangeEnd = validDate(range?.end);
        if (phoneMonth && viewMode === 'gantt' && rangeStart && rangeEnd) {
          phoneMonth.textContent = new Date((rangeStart.getTime() + rangeEnd.getTime()) / 2).toLocaleDateString([], { month:'long', year:'numeric' });
        }
        // Wheel/scrollbar scrolling keeps date= in step like Prev/Next.
        if (viewMode === 'gantt') syncGanttRouteDate({ moveAnchor:false });
      },
      onZoomChange(next){
        ganttZoomPxPerDay = Number(next) || 0;
        clearTimeout(ganttZoomPersistTimer);
        ganttZoomPersistTimer = setTimeout(() => persistSchedulePreference({ gantt_zoom:ganttZoomPxPerDay }), 350);
      },
      onGroupToggle(groupId, isCollapsed){
        ganttCollapsedGroups = isCollapsed
          ? [...new Set([...ganttCollapsedGroups, String(groupId)])]
          : ganttCollapsedGroups.filter((id) => id !== String(groupId));
        persistGanttCollapsed();
      },
      onEventClick(event, meta = {}){
        if (event.__project_rollup === true) openGanttProject(event);
        // Sections are named containers whose dates follow their items.
        else if (window.PlatformScheduling?.eventIsGroup?.(event) && event.floating_event !== true) openGanttSectionEditor(event, meta);
        else {
          openPlacedCalendarEvent(event, meta);
          returnFocusAfterEditor(event.id);
        }
      },
      onEventRangeChange(event, range, meta = {}){
        if (event.__project_rollup === true) saveGanttProjectRange(event, range, meta);
        else saveGanttEventRange(event, range, meta);
      },
      onEventSchedule(event, range){ saveGanttEventRange(event, range, { action:'schedule' }); },
      // A click/drag on a waiting item's lane: past days ask first, linked
      // work is checked, and the toast offers Undo (saveGanttEventRange).
      onUnscheduledLaneSchedule(event, range, meta = {}){ saveGanttEventRange(event, range, { action:'schedule', source:meta.source || '' }); },
      onDependencyCreate(fromEvent, toEvent){ createGanttDependency(fromEvent, toEvent); },
      onDependencyRemove(event, dependency){ removeGanttDependency(event, dependency); },
      ...(canEdit ? {
        onProjectAddItem(project, meta){ createGanttProjectItem(project, meta, false); },
        onProjectAddGroup(project, meta){ createGanttSection(project, meta); }
      } : {})
    });
    // One delegated listener per mount: the timeline keeps its toolbar DOM
    // across re-renders, so per-render binding would stack handlers.
    if (!mount.__dashGanttControlsBound) {
      mount.__dashGanttControlsBound = true;
      mount.addEventListener('click', (clickEvent) => {
        const groupBtn = clickEvent.target.closest?.('[data-gantt-group-by]');
        if (groupBtn && mount.contains(groupBtn)) {
          const next = clean(groupBtn.dataset.ganttGroupBy) || 'project';
          if (next === ganttGroupBy) return;
          ganttGroupBy = next;
          persistSchedulePreference({ gantt_group_by:ganttGroupBy });
          renderGanttScheduleView();
          return;
        }
        const kindBtn = clickEvent.target.closest?.('[data-gantt-kind]');
        if (kindBtn && mount.contains(kindBtn)) {
          const kind = clean(kindBtn.dataset.ganttKind);
          if (ganttVisibleKinds.has(kind)) ganttVisibleKinds.delete(kind);
          else ganttVisibleKinds.add(kind);
          ganttShownMenuOpen = true;
          renderGanttScheduleView();
          return;
        }
        if (clickEvent.target.closest?.('[data-gantt-shown-close]')) {
          ganttShownMenuOpen = false;
          renderGanttScheduleView();
          return;
        }
        if (clickEvent.target.closest?.('[data-gantt-shown]')) {
          ganttShownMenuOpen = !ganttShownMenuOpen;
          renderGanttScheduleView();
        }
      });
    }
    const shownMenu = mount.querySelector('[data-gantt-shown-menu]');
    const shownButton = mount.querySelector('[data-gantt-shown]');
    if (shownMenu && shownButton) {
      setTimeout(() => {
        if (!shownMenu.isConnected) return;
        const dismiss = () => {
          ganttShownMenuOpen = false;
          renderGanttScheduleView();
        };
        const removePointer = bindOutsidePointerDismiss(shownMenu, dismiss, [shownButton]);
        // Escape closes only this menu (the topmost layer) and returns focus
        // to its button.
        const onKey = (keyEvent) => {
          if (keyEvent.key !== 'Escape' || document.querySelector('.dash-event-popover, .fm-dialog-backdrop')) return;
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          dismiss();
          rootEl?.querySelector('#dashGanttView [data-gantt-shown]')?.focus();
        };
        document.addEventListener('keydown', onKey, true);
        ganttShownDocHandler = () => {
          removePointer();
          document.removeEventListener('keydown', onKey, true);
        };
      }, 0);
    }
  }
  /* When the editor opened from a Timeline bar closes (Save, Cancel, Esc,
   * outside click), keyboard focus goes back to that bar instead of <body>. */
  function returnFocusAfterEditor(eventId = ''){
    const id = String(eventId || '');
    if (!id || !document.querySelector('.dash-event-popover')) return;
    const escaped = window.CSS?.escape ? window.CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    const observer = new MutationObserver(() => {
      if (document.querySelector('.dash-event-popover')) return;
      observer.disconnect();
      setTimeout(() => {
        // Re-rendered (not closed): keep watching.
        if (document.querySelector('.dash-event-popover')) { returnFocusAfterEditor(id); return; }
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        const target = rootEl?.querySelector(`[data-psv-gantt-open="${escaped}"],[data-psv-gantt-bar="${escaped}"],[data-prs-event-id="${escaped}"]`);
        try { target?.focus?.({ preventScroll:true }); } catch (error) {}
      }, 60);
    });
    observer.observe(document.body, { childList:true });
    setTimeout(() => observer.disconnect(), 10 * 60 * 1000);
  }
  /* Adds one action button (e.g. Undo) to the toast that was just shown; the
   * next toast replaces the text and with it the button. */
  function appendToastAction(label, onAction){
    const holder = document.getElementById('fmToastT2');
    if (!holder || typeof onAction !== 'function') return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dash-toast-action';
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
  /* The project title bar opens the project on its own Timeline, at its next
   * upcoming work (or its first item when everything is in the past). */
  function openGanttProject(rollup = {}){
    const project = projects.find((candidate) => String(candidate.id || '') === String(rollup.project_id || '')) || eventProject(rollup);
    if (!project?.id) return;
    const Scheduling = window.PlatformScheduling;
    const today = startOfDay(new Date());
    const items = allEvents
      .filter((item) => String(item.project_id || '') === String(project.id) && eventIsScheduled(item) && !Scheduling?.eventIsGroup?.(item))
      .sort((a, b) => (eventStart(a)?.getTime() || 0) - (eventStart(b)?.getTime() || 0));
    const next = items.find((item) => (eventEnd(item) || eventStart(item)) > today) || items[0] || null;
    const start = next ? eventStart(next) : today;
    const pad = (value) => String(value).padStart(2, '0');
    const options = { tab:'schedule', projectScheduleView:'gantt', projectScheduleDate:`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}` };
    if (window.Portal.modules?.request?.openProject) window.Portal.modules.request.openProject(project, options);
    else window.dispatchEvent(new CustomEvent('fm:projects:open', { detail: { project, ...options } }));
  }
  /* A section (schedule group) is a named container; its dates follow the
   * items in it, so its editor only names it. */
  async function openGanttSectionEditor(group = {}, meta = {}){
    const Scheduling = window.PlatformScheduling;
    const stored = allEvents.find((item) => String(item.id || '') === String(group.id || '')) || group;
    const project = eventProject(stored);
    const focusBack = () => focusGanttRow(stored.id, meta.element);
    const members = allEvents.filter((item) => String(Scheduling?.eventParentId?.(item) || item.parent_event_id || '') === String(stored.id || ''));
    const itemCount = members.length;
    const scheduledCount = members.filter(eventIsScheduled).length;
    // Only a section with scheduled items has a bar to move.
    const datesNote = !itemCount
      ? 'It has no items yet; its dates will follow the items you put in it.'
      : scheduledCount
        ? `Its dates follow its ${itemCount} item${itemCount === 1 ? '' : 's'}; drag the section bar to move ${scheduledCount === 1 ? 'it' : 'them'} together.`
        : `Its dates will follow its ${itemCount} item${itemCount === 1 ? '' : 's'} once ${itemCount === 1 ? 'it is' : 'they are'} scheduled.`;
    if (!ganttCanEdit() || !project?.id) {
      showToast(clean(stored.title) || 'Section', `${datesNote}${ganttCanEdit() ? '' : ` ${typeof scheduleReadOnlyMessage === 'function' ? scheduleReadOnlyMessage() : 'View only.'}`}`, { tone:'info' });
      focusBack();
      return;
    }
    const result = await openGanttSectionDialog(stored, project, datesNote);
    focusGanttRow(stored.id, meta.element);
    if (!result) return;
    if (result.action === 'delete') {
      // Focus goes to the row that takes the deleted section's place (the
      // next row, else the one before it), not to <body>.
      const rowIds = [...(rootEl?.querySelectorAll('#dashGanttView [data-psv-gantt-open]') || [])].map((node) => String(node.dataset.psvGanttOpen || ''));
      const index = rowIds.indexOf(String(stored.id));
      const neighborId = index >= 0 ? (rowIds.slice(index + 1).find((id) => id && id !== String(stored.id)) || rowIds.slice(0, index).reverse().find(Boolean) || '') : '';
      const deleted = typeof deleteScheduleSection === 'function' && await deleteScheduleSection(stored, project, { confirmed:result.confirmed === true });
      if (deleted) {
        renderGanttScheduleView();
        focusGanttRow(neighborId);
      } else focusGanttRow(stored.id);
      return;
    }
    const title = clean(result.title);
    const renamed = title && title !== clean(stored.title);
    // Items put into (or taken out of) this section: parent_event_id links
    // them; the section's dates then follow its items.
    const moved = result.changes.map(({ item, inSection }) => ({
      ...item,
      parent_event_id:inSection ? String(stored.id) : '',
      parentEventId:inSection ? String(stored.id) : '',
      ...(item.metadata && typeof item.metadata === 'object' ? { metadata:{ ...item.metadata, parent_event_id:inSection ? String(stored.id) : '' } } : {}),
      updated_at:new Date().toISOString()
    }));
    if (!renamed && !moved.length) return;
    const next = renamed ? { ...stored, title, title_is_custom:true, updated_at:new Date().toISOString() } : stored;
    const previous = new Map([stored, ...result.changes.map(({ item }) => item)].map((item) => [String(item.id || ''), item]));
    const applied = new Map([next, ...moved].map((item) => [String(item.id || ''), item]));
    allEvents = allEvents.map((item) => applied.get(String(item.id || '')) || item);
    events = visibleEvents();
    renderGanttScheduleView();
    focusGanttRow(stored.id);
    const saveKeepingRevision = async (item) => {
      const version = beginEventRangeSave(item.id);
      const saved = await Scheduling.saveProjectEvent(orgId(), project, withExplicitAssignees(item), schedulingConfig);
      mergeSavedCalendarEvent(saved, item, version);
    };
    try {
      if (renamed) await saveKeepingRevision(next);
      for (const item of moved) await saveKeepingRevision(item);
      if (moved.length && typeof persistGroupRollups === 'function') await persistGroupRollups(project, [...moved, ...result.changes.map(({ item }) => item)]);
      // A section left with no items has no dates to follow: it becomes
      // unscheduled (no bar) until items are put back in it.
      const emptied = moved.length && !allEvents.some((item) => String(Scheduling?.eventParentId?.(item) || item.parent_event_id || '') === String(stored.id));
      const current = allEvents.find((item) => String(item.id || '') === String(stored.id)) || next;
      if (emptied && eventIsScheduled(current) && Scheduling?.groupRollupMode?.(current) !== 'manual') {
        const cleared = { ...current, status:'unscheduled', start:'', end:'', start_at:'', end_at:'', updated_at:new Date().toISOString() };
        allEvents = allEvents.map((item) => String(item.id || '') === String(cleared.id) ? cleared : item);
        events = visibleEvents();
        await saveKeepingRevision(cleared);
      }
      renderGanttScheduleView();
      focusGanttRow(stored.id);
      const added = result.changes.filter((change) => change.inSection).length;
      const removed = result.changes.length - added;
      const parts = [
        renamed ? `The section is now “${title}”.` : '',
        added ? `${added} item${added === 1 ? '' : 's'} moved into it.` : '',
        removed ? `${removed} item${removed === 1 ? '' : 's'} taken out of it.` : ''
      ].filter(Boolean);
      showToast(renamed && !moved.length ? 'Section renamed' : 'Section updated', parts.join(' '), true);
    } catch (error) {
      allEvents = allEvents.map((item) => previous.get(String(item.id || '')) || item);
      events = visibleEvents();
      renderGanttScheduleView();
      if (isStaleSaveError(error)) { await reloadAfterStaleChange(); return; }
      showToast('Section not saved', scheduleSaveErrorMessage(error, 'Could not save the section.'), false);
      scheduleLoad();
    }
  }
  /* Keyboard focus goes back to a Timeline row after its dialog closes (the
   * row is looked up again: a re-render replaces the element). */
  function focusGanttRow(eventId = '', fallback = null){
    const id = String(eventId || '');
    const find = () => {
      const escaped = window.CSS?.escape ? window.CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
      return id ? rootEl?.querySelector(`[data-psv-gantt-open="${escaped}"],[data-psv-gantt-bar="${escaped}"]`) : null;
    };
    const focus = () => { try { (find() || (fallback?.isConnected ? fallback : null))?.focus?.({ preventScroll:true }); } catch (error) {} };
    focus();
    requestAnimationFrame(focus);
  }
  /* The Timeline section dialog: name, which of the project's work items are
   * in the section, and Delete section.
   * -> null (cancel) | { action:'delete' } | { action:'save', title, changes:[{ item, inSection }] } */
  function openGanttSectionDialog(section = {}, project = {}, datesNote = ''){
    const Scheduling = window.PlatformScheduling;
    const sectionId = String(section.id || '');
    const parentOf = (item) => String(Scheduling?.eventParentId?.(item) || item.parent_event_id || '');
    const candidates = projectScheduleItems(project.id)
      // Sections group production work (and its deliveries), not appointments.
      .filter((item) => !Scheduling?.eventIsGroup?.(item) && (isProductionEvent(item) || isMaterialEvent(item)) && String(item.id || '') !== sectionId && !['cancelled', 'canceled'].includes(clean(item.status).toLowerCase()))
      .sort((a, b) => (eventStart(a)?.getTime() ?? Number.MAX_SAFE_INTEGER) - (eventStart(b)?.getTime() ?? Number.MAX_SAFE_INTEGER) || clean(a.title).localeCompare(clean(b.title)));
    const sectionTitle = (id) => clean(allEvents.find((item) => String(item.id || '') === id)?.title) || 'another section';
    const when = (item) => eventIsScheduled(item) ? formatEventDraftTime(item) : 'Unscheduled';
    const rows = candidates.map((item) => {
      const parent = parentOf(item);
      const elsewhere = parent && parent !== sectionId ? ` · now in “${escapeHtml(sectionTitle(parent))}”` : '';
      return `<label class="dash-section-item"><input type="checkbox" value="${escapeHtml(item.id)}" ${parent === sectionId ? 'checked' : ''}><span><strong>${escapeHtml(clean(item.title) || 'Untitled item')}</strong><small>${escapeHtml(when(item))}${elsewhere}</small></span></label>`;
    }).join('');
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'dash-modal-backdrop';
      backdrop.dataset.ganttSectionDialog = '1';
      backdrop.innerHTML = `
        <div class="dash-modal dash-section-modal" role="dialog" aria-modal="true" aria-labelledby="dashSectionDialogTitle">
          <div class="dash-modal-head"><h3 id="dashSectionDialogTitle">Edit section</h3><button type="button" class="dash-modal-close" data-section-cancel aria-label="Close"><i class="fas fa-xmark"></i></button></div>
          <div class="dash-modal-body">
            <label class="dash-section-name"><span>Section name</span><input type="text" data-section-name value="${escapeHtml(clean(section.title))}" autocomplete="off"></label>
            <p class="dash-section-note">${escapeHtml(datesNote)}</p>
            <div class="dash-section-items-head">Work items in this section</div>
            <div class="dash-section-items" role="group" aria-label="Work items in this section">${rows || '<div class="dash-section-empty">This project has no work items yet. Add work items to the project first.</div>'}</div>
            <div class="dash-modal-status" data-section-status role="alert"></div>
            <div class="dash-modal-actions">
              <button type="button" class="dash-btn dash-section-delete" data-section-delete><i class="fas fa-trash"></i> Delete section</button>
              <div class="dash-modal-actions-right">
                <button type="button" class="dash-btn" data-section-cancel>Cancel</button>
                <button type="button" class="dash-btn active" data-section-save>Save</button>
              </div>
            </div>
          </div>
        </div>`;
      const finish = (value) => {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        resolve(value);
      };
      const save = () => {
        const title = clean(backdrop.querySelector('[data-section-name]')?.value);
        if (!title) {
          const status = backdrop.querySelector('[data-section-status]');
          if (status) status.textContent = 'A section needs a name.';
          backdrop.querySelector('[data-section-name]')?.focus();
          return;
        }
        const checked = new Set([...backdrop.querySelectorAll('.dash-section-items input[type="checkbox"]')].filter((box) => box.checked).map((box) => box.value));
        const changes = candidates
          .filter((item) => (parentOf(item) === sectionId) !== checked.has(String(item.id || '')))
          .map((item) => ({ item, inSection:checked.has(String(item.id || '')) }));
        finish({ action:'save', title, changes });
      };
      const onKey = (keyEvent) => {
        if (!backdrop.isConnected || document.querySelector('.fm-dialog-backdrop')) return;
        if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); keyEvent.stopPropagation(); finish(null); return; }
        if (keyEvent.key === 'Enter' && keyEvent.target?.matches?.('[data-section-name]')) { keyEvent.preventDefault(); save(); return; }
        if (keyEvent.key === 'Tab') {
          const focusable = [...backdrop.querySelectorAll('button,input')].filter((node) => !node.disabled && node.getClientRects().length);
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (keyEvent.shiftKey && document.activeElement === first) { keyEvent.preventDefault(); last.focus(); }
          else if (!keyEvent.shiftKey && document.activeElement === last) { keyEvent.preventDefault(); first.focus(); }
        }
      };
      backdrop.addEventListener('click', (clickEvent) => {
        if (clickEvent.target === backdrop || clickEvent.target.closest('[data-section-cancel]')) { finish(null); return; }
        if (clickEvent.target.closest('[data-section-save]')) { save(); return; }
        const deleteButton = clickEvent.target.closest('[data-section-delete]');
        if (deleteButton) {
          // Asked over this dialog: "Keep section" returns to it with the
          // edits intact; only a confirmed delete closes it.
          const confirmDelete = window.PlatformUI?.confirm || window.Portal?.ui?.confirm;
          if (typeof confirmDelete !== 'function') { finish({ action:'delete' }); return; }
          deleteButton.disabled = true;
          Promise.resolve(confirmDelete(sectionDeleteMessage(section), { title:'Delete section', okLabel:'Delete section', cancelLabel:'Keep section', danger:true, defaultFocus:'cancel' }))
            .then((approved) => {
              if (!backdrop.isConnected) return;
              if (approved) { finish({ action:'delete', confirmed:true }); return; }
              deleteButton.disabled = false;
              try { deleteButton.focus({ preventScroll:true }); } catch (error) {}
            });
        }
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(backdrop);
      const input = backdrop.querySelector('[data-section-name]');
      input?.focus();
      input?.select?.();
    });
  }
  async function createGanttSection(project, meta = {}){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling?.createScheduleGroupEvent || !Scheduling?.saveProjectEvent || !project?.id) return;
    if (!ganttCanEdit()) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), typeof scheduleReadOnlyMessage === 'function' ? scheduleReadOnlyMessage() : 'You do not have permission to change the schedule.', VIEW_ONLY_TOAST);
      return;
    }
    const prompt = window.PlatformUI?.prompt || window.Portal?.ui?.prompt;
    const name = typeof prompt === 'function'
      ? await prompt('Name the new section. Its dates will follow the work items in it.', 'New Section', { title:'Add section', okLabel:'Add section', cancelLabel:'Cancel' })
      : 'New Section';
    try { meta.element?.focus?.({ preventScroll:true }); } catch (error) {}
    if (name == null) return;
    const title = clean(name) || 'New Section';
    const item = Scheduling.createScheduleGroupEvent(project, { title, title_is_custom:true, status:'unscheduled', all_day:true, schedule_granularity:'date' }, schedulingConfig);
    allEvents = [...allEvents, item];
    projects = projects.map((candidate) => String(candidate.id || '') === String(project.id || '')
      ? { ...candidate, events:[...(Array.isArray(candidate.events) ? candidate.events : []), item] }
      : candidate);
    events = visibleEvents();
    renderGanttScheduleView();
    // Keyboard focus lands on the new section's row.
    try { rootEl?.querySelector(`[data-psv-gantt-open="${window.CSS?.escape ? window.CSS.escape(String(item.id)) : item.id}"]`)?.focus?.({ preventScroll:false }); } catch (error) {}
    try {
      // Keep the stored copy (with its revision) so the next edit of the new
      // section is not refused as stale.
      const version = beginEventRangeSave(item.id);
      const saved = await Scheduling.saveProjectEvent(orgId(), project, item, schedulingConfig);
      mergeSavedCalendarEvent(saved, item, version);
      showToast('Section added', `“${title}” was added to ${projectTitle(project)}.`, true);
    } catch (error) {
      removeLocalGanttItem(item.id, project.id);
      renderGanttScheduleView();
      showToast('Section not added', scheduleSaveErrorMessage(error, 'Could not save the section.'), false);
    }
  }
  function removeLocalGanttItem(itemId = '', projectId = ''){
    const id = String(itemId || '');
    allEvents = allEvents.filter((event) => String(event.id || '') !== id);
    projects = projects.map((candidate) => String(candidate.id || '') === String(projectId || '')
      ? { ...candidate, events:(Array.isArray(candidate.events) ? candidate.events : []).filter((event) => String(event.id || '') !== id) }
      : candidate);
    events = visibleEvents();
  }
  function settleGanttPendingItem({ discard = false } = {}){
    const pending = ganttPendingNewItem;
    if (!pending) return;
    ganttPendingNewItem = null;
    pending.stop();
    if (!discard) return;
    removeLocalGanttItem(pending.id, pending.projectId);
    if (String(eventEditorEventId || '') === pending.id && !document.querySelector('.dash-event-popover')) eventEditorEventId = '';
    renderGanttScheduleView();
  }
  // Watches the editor opened for a Timeline-added item: Save persists it
  // (the editor's own save), any other close discards the local draft.
  function watchGanttPendingItem(pending){
    const editorOpen = () => !!document.querySelector(`.dash-event-popover[data-event-id="${window.CSS?.escape ? window.CSS.escape(pending.id) : pending.id}"]`);
    let seen = false;
    let timer = 0;
    const onClick = (clickEvent) => {
      if (clickEvent.target?.closest?.('.dash-event-popover [data-event-save]') && editorOpen()) pending.saving = true;
    };
    const check = () => {
      if (ganttPendingNewItem !== pending) return;
      if (editorOpen()) { seen = true; pending.saving = false; return; }
      if (!seen) return;
      settleGanttPendingItem({ discard:!pending.saving });
    };
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(check, 80);
    });
    observer.observe(document.body, { childList:true });
    document.addEventListener('click', onClick, true);
    pending.stop = () => {
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('click', onClick, true);
    };
    setTimeout(check, 0);
  }
  function createGanttProjectItem(project, meta = {}, group = false){
    const Scheduling = window.PlatformScheduling;
    if (!Scheduling?.createProjectWorkEvent || !Scheduling?.saveProjectEvent || !project?.id) return;
    if (!ganttCanEdit()) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), typeof scheduleReadOnlyMessage === 'function' ? scheduleReadOnlyMessage() : 'You do not have permission to change the schedule.', VIEW_ONLY_TOAST);
      return;
    }
    settleGanttPendingItem({ discard:true });
    const factory = group && Scheduling.createScheduleGroupEvent ? Scheduling.createScheduleGroupEvent : Scheduling.createProjectWorkEvent;
    const item = factory(project, {
      title:group ? 'New Section' : 'New Work Item',
      status:'unscheduled',
      all_day:true,
      schedule_granularity:'date'
    }, schedulingConfig);
    // Local draft only: the editor's Save persists it, Cancel/close drops it.
    allEvents = [...allEvents, item];
    projects = projects.map((candidate) => String(candidate.id || '') === String(project.id || '')
      ? { ...candidate, events:[...(Array.isArray(candidate.events) ? candidate.events : []), item] }
      : candidate);
    events = visibleEvents();
    const pending = { id:String(item.id || ''), projectId:String(project.id || ''), saving:false, stop(){} };
    ganttPendingNewItem = pending;
    renderGanttScheduleView();
    const escapedId = window.CSS?.escape ? window.CSS.escape(String(item.id)) : String(item.id);
    const anchor = rootEl?.querySelector?.(`[data-psv-gantt-open="${escapedId}"]`);
    anchor?.scrollIntoView?.({ block:'nearest' });
    openPlacedCalendarEvent(item, { element:anchor || meta.element });
    watchGanttPendingItem(pending);
  }
  async function saveGanttProjectRange(rollup, range, meta = {}){
    const Scheduling = window.PlatformScheduling;
    if (!ganttCanEdit()) { renderGanttScheduleView(); return; }
    const previousStart = eventStart(rollup);
    const nextStart = validDate(range?.start);
    if (!Scheduling?.updateProjectEventRange || !previousStart || !nextStart) return;
    // Whole calendar days (DST-safe): every item keeps its time of day.
    const days = Math.round(Number(meta?.dayDelta) || ((nextStart.getTime() - previousStart.getTime()) / 86400000));
    if (!days) { renderGanttScheduleView(); return; }
    const childIds = new Set((rollup.__project_child_ids || []).map(String));
    const fixed = (event) => eventIsLocked(event) || Scheduling.eventIsFixed?.(event) === true || ['completed', 'complete', 'done'].includes(clean(event.status).toLowerCase());
    const placed = allEvents.filter((event) => childIds.has(String(event.id || '')) && !Scheduling.eventIsGroup?.(event) && eventIsScheduled(event));
    const children = placed.filter((event) => !fixed(event));
    const stayed = placed.length - children.length;
    if (!children.length) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_520e15b9c887fd","Project not moved") ?? "Project not moved"), 'Every scheduled item in this project is locked or completed.', false);
      renderGanttScheduleView();
      return;
    }
    const changes = children.map((event) => {
      const start = eventStart(event);
      const end = eventEnd(event) && eventEnd(event) > start ? eventEnd(event) : addDays(start, 1);
      const timed = ganttItemIsTimed(event);
      return Scheduling.updateProjectEventRange(event, {
        start:addDays(start, days),
        end:addDays(end, days),
        all_day:!timed,
        schedule_granularity:timed ? 'time' : 'date'
      });
    });
    const previousById = new Map(children.map((event) => [String(event.id || ''), event]));
    const byId = new Map(changes.map((event) => [String(event.id || ''), event]));
    allEvents = allEvents.map((event) => byId.get(String(event.id || '')) || event);
    events = visibleEvents();
    renderGanttScheduleView();
    const project = projects.find((candidate) => String(candidate.id || '') === String(rollup.project_id || '')) || eventProject(changes[0]);
    const stayedNote = stayed ? ` ${stayed} locked or completed item${stayed === 1 ? '' : 's'} stayed in place.` : '';
    try {
      if (changes.length > 1) showToast('Moving project', `Saving ${changes.length} work items…`, true);
      for (const change of changes) {
        const changeProject = eventProject(change)?.id ? eventProject(change) : project;
        if (!changeProject?.id) continue;
        const version = beginEventRangeSave(change.id);
        const saved = await queueEventRangeSave(change.id, () => Scheduling.saveProjectEvent(orgId(), changeProject, change, schedulingConfig));
        mergeSavedCalendarEvent(saved, change, version);
      }
      if (project?.id && typeof persistGroupRollups === 'function') await persistGroupRollups(project, changes);
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_77017e64d76f74","Project moved") ?? "Project moved"), `${((v0,v1) => globalThis.PlatformLanguage?.text("scheduling","m_c2ee34769a4c38",`${v0} work item${v1} moved together.`,{v0,v1}) ?? `${v0} work item${v1} moved together.`)(changes.length,changes.length === 1 ? '' : 's')}${stayedNote}`, true);
      renderGanttScheduleView();
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_520e15b9c887fd","Project not moved") ?? "Project not moved"), error?.message || 'Could not move all project work items.', false);
      allEvents = allEvents.map((event) => previousById.get(String(event.id || '')) || event);
      events = visibleEvents();
      renderGanttScheduleView();
      scheduleLoad();
    }
  }
  async function saveGanttEventRange(event, range, meta = {}){
    const Scheduling = window.PlatformScheduling;
    const floating = event?.floating_event === true || String(event?.id || '').startsWith('floating_');
    const currentEvent = floating ? event : (allEvents.find((item) => String(item.id || '') === String(event?.id || '')) || event);
    if (!ganttCanEdit()) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), typeof scheduleReadOnlyMessage === 'function' ? scheduleReadOnlyMessage() : 'You do not have permission to change the schedule.', VIEW_ONLY_TOAST);
      renderGanttScheduleView();
      return;
    }
    if (eventIsLocked(currentEvent)) {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_88e13d64071885","Schedule locked") ?? "Schedule locked"), (globalThis.PlatformLanguage?.text("scheduling","m_0233f74e9faf1e","Unlock this item before moving it.") ?? "Unlock this item before moving it."), false);
      renderGanttScheduleView();
      return;
    }
    if (!currentEvent?.id || !range?.start || ['cancelled', 'canceled'].includes(clean(currentEvent.status).toLowerCase())) return;
    // Placed items and company events take the shared reschedule path, so
    // linked items, scope rules, locked successors and group rollups behave
    // exactly as in the calendar views.
    if (floating) {
      const saving = saveEventCalendarRange(currentEvent, range);
      renderGanttScheduleView();
      await saving;
      renderGanttScheduleView();
      return;
    }
    if (eventIsScheduled(currentEvent)) {
      await saveEventCalendarRange(currentEvent, range);
      return;
    }
    // Scheduling an unplaced item from its lane.
    const project = eventProject(currentEvent);
    if (!Scheduling?.updateProjectEventRange || !project?.id) return;
    // Same protections as placing from the rail: a past day asks first, and
    // linked work the placement puts out of order is flagged before saving.
    const itemLabel = clean(currentEvent.title) || 'This item';
    // A day click on a timed item (e.g. a 4-hour job) keeps it timed at its
    // usual start and length instead of turning it into an all-day bar.
    if (range.all_day !== false && Scheduling.interpretScheduleBundle) {
      try {
        const interpreted = Scheduling.interpretScheduleBundle(currentEvent, [currentEvent], startOfDay(range.start), project, scopeTemplates, { config:schedulingConfig })[0];
        const interpretedStart = validDate(interpreted?.start);
        const interpretedEnd = validDate(interpreted?.end);
        if (interpreted && interpreted.all_day === false && interpretedStart && interpretedEnd && sameDay(interpretedStart, range.start)) {
          range = { ...range, start:interpretedStart, end:interpretedEnd, all_day:false, schedule_granularity:'time' };
        }
      } catch (error) {}
    }
    // A single click books an all-day item for its planned length (e.g. a
    // 2-day job gets 2 days), not just the clicked day; a drag keeps the
    // days it covered.
    if (meta.source === 'lane-click' && range.all_day !== false) {
      let days = 0;
      try {
        const interpreted = Scheduling.interpretScheduleBundle?.(currentEvent, [currentEvent], startOfDay(range.start), project, scopeTemplates, { config:schedulingConfig })?.[0];
        const iStart = validDate(interpreted?.start);
        const iEnd = validDate(interpreted?.end);
        if (interpreted && interpreted.all_day !== false && iStart && iEnd && iEnd > iStart) days = Math.round((iEnd.getTime() - iStart.getTime()) / 86400000);
      } catch (error) {}
      if (!days) days = Math.round(Number(currentEvent.duration_minutes || 0) / 1440);
      if (days > 1) {
        const dayStart = startOfDay(range.start);
        range = { ...range, start:dayStart, end:addDays(dayStart, days), all_day:true, schedule_granularity:'date' };
      }
    }
    // (On touch the renderer only schedules a lane after a touch-and-hold.)
    const quotedLabel = clean(currentEvent.title) ? `“${clean(currentEvent.title)}”` : 'This item';
    if (!(await confirmPastPlacement(range.start, quotedLabel))) { renderGanttScheduleView(); return; }
    const next = { ...Scheduling.updateProjectEventRange(currentEvent, range), status:'scheduled' };
    const conflicts = await resolvePlacementDependencyConflicts(project, [next], itemLabel);
    if (conflicts.cancelled) { renderGanttScheduleView(); return; }
    // Linked items "Move it too" pushes later: Undo puts them back as well.
    const linkedBefore = conflicts.changes
      .map((change) => ({ change, original:allEvents.find((item) => String(item.id || '') === String(change.id || '')) }))
      .filter((entry) => entry.original);
    if (ganttPendingNewItem?.id === String(currentEvent.id || '')) settleGanttPendingItem();
    const previous = currentEvent;
    allEvents = allEvents.map((item) => String(item.id || '') === String(next.id || '') ? { ...item, ...next } : item);
    events = visibleEvents();
    renderGanttScheduleView();
    const version = beginEventRangeSave(next.id);
    try {
      const saved = await queueEventRangeSave(next.id, () => Scheduling.saveProjectEvent(orgId(), project, next, schedulingConfig));
      mergeSavedCalendarEvent(saved, next, version);
      if (conflicts.changes.length) await saveRelatedRescheduleChanges(project, conflicts.changes);
      if (typeof persistGroupRollups === 'function') await persistGroupRollups(project, [next, ...conflicts.changes]);
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_a1da9bcb050cbb","Schedule updated") ?? "Schedule updated"), `“${clean(next.title) || 'Item'}” is scheduled for ${formatEventDraftTime(next)}.${conflicts.changes.length ? ` ${conflicts.changes.length} linked item${conflicts.changes.length === 1 ? ' was' : 's were'} moved too.` : ''}${outOfOrderNote(conflicts.leftOutOfOrder)}`, !conflicts.leftOutOfOrder);
      // A single click placed it: offer a one-click undo in the toast.
      appendToastAction('Undo', async () => {
        const stored = allEvents.find((item) => String(item.id || '') === String(next.id || ''));
        if (!stored || eventStart(stored)?.getTime() !== eventStart(next)?.getTime()) return;
        // Back to exactly how it was: no date (every start/end alias
        // cleared, or the scheduler re-derives a date from a leftover one).
        // Built on the copy just saved (its current revision), with the
        // schedule fields put back.
        const restored = {
          ...stored,
          all_day:previous.all_day,
          schedule_granularity:previous.schedule_granularity || '',
          start:previous.start || '', end:previous.end || '',
          start_at:previous.start_at || '', end_at:previous.end_at || '',
          status:clean(previous.status) || 'unscheduled',
          updated_at:new Date().toISOString()
        };
        allEvents = allEvents.map((item) => String(item.id || '') === String(restored.id || '') ? restored : item);
        events = visibleEvents();
        renderGanttScheduleView();
        // Linked items moved with it go back to where they were (only those
        // still where this placement put them).
        const linkedRestores = linkedBefore.map(({ change, original }) => {
          const current = allEvents.find((item) => String(item.id || '') === String(change.id || ''));
          if (!current || eventStart(current)?.getTime() !== eventStart(change)?.getTime()) return null;
          return {
            ...current,
            all_day:original.all_day,
            schedule_granularity:original.schedule_granularity || '',
            start:original.start || '', end:original.end || '',
            start_at:original.start_at || '', end_at:original.end_at || '',
            duration_minutes:original.duration_minutes,
            status:original.status,
            ...equipmentWindowPatch(current, { start:eventStart(current), end:eventEnd(current) }, { start:eventStart(original), end:eventEnd(original) }),
            updated_at:new Date().toISOString()
          };
        }).filter(Boolean);
        linkedRestores.forEach((item) => { allEvents = allEvents.map((event) => String(event.id || '') === String(item.id || '') ? item : event); });
        events = visibleEvents();
        renderGanttScheduleView();
        try {
          const undoVersion = beginEventRangeSave(restored.id);
          const undone = await queueEventRangeSave(restored.id, () => Scheduling.saveProjectEvent(orgId(), project, restored, schedulingConfig));
          mergeSavedCalendarEvent(undone, restored, undoVersion);
          for (const item of linkedRestores) {
            const linkedVersion = beginEventRangeSave(item.id);
            const saved = await queueEventRangeSave(item.id, () => Scheduling.saveProjectEvent(orgId(), project, withExplicitAssignees(item), schedulingConfig));
            mergeSavedCalendarEvent(saved, item, linkedVersion);
          }
          if (typeof persistGroupRollups === 'function') await persistGroupRollups(project, [restored, ...linkedRestores]);
          showToast('Scheduling undone', `“${clean(restored.title) || 'Item'}” is waiting to be scheduled again.${linkedRestores.length ? ` ${linkedRestores.length} linked item${linkedRestores.length === 1 ? ' was' : 's were'} moved back.` : ''}`, true);
        } catch (undoError) {
          if (isStaleSaveError(undoError)) changedElsewhereToast(undoError);
          else showToast('Undo failed', scheduleSaveErrorMessage(undoError, 'Could not undo the scheduling.'), false);
          scheduleLoad();
        }
        renderGanttScheduleView();
      });
      renderGanttScheduleView();
    } catch (error) {
      if (isStaleSaveError(error)) {
        allEvents = allEvents.map((item) => String(item.id || '') === String(previous.id || '') ? previous : item);
        events = visibleEvents();
        await reloadAfterStaleChange();
        return;
      }
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_84ef35ed03b1c5","Scheduling failed") ?? "Scheduling failed"), error?.message || 'Could not update this schedule item.', false);
      if (eventRangeSaveVersions.get(String(next.id || '')) === version) {
        allEvents = allEvents.map((item) => String(item.id || '') === String(previous.id || '') ? previous : item);
        events = visibleEvents();
        renderGanttScheduleView();
      }
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
    // A project bar as the target resolves to its first item that can still
    // move (not a completed or locked one).
    const fixedItem = (item) => eventIsLocked(item) || Scheduling?.eventIsFixed?.(item) === true || ['completed', 'complete', 'done'].includes(clean(item?.status).toLowerCase());
    const targetCandidates = toEvent?.__project_rollup === true
      ? scheduledChildren(toEvent).sort((a, b) => (eventStart(a)?.getTime() || Number.MAX_SAFE_INTEGER) - (eventStart(b)?.getTime() || Number.MAX_SAFE_INTEGER))
      : [];
    const resolvedTarget = toEvent?.__project_rollup === true
      ? (targetCandidates.find((item) => !fixedItem(item)) || targetCandidates[0])
      : toEvent;
    const target = allEvents.find((item) => String(item.id || '') === String(resolvedTarget?.id || '')) || resolvedTarget;
    if (!Scheduling || !target?.id || !source?.id || !ganttCanEdit()) return;
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
    // A link that is already out of order (the later item starts before the
    // earlier one finishes) is flagged before it is saved.
    const sourceEnd = eventEnd(source) || eventStart(source);
    const targetStart = eventStart(target);
    const targetEnd = eventEnd(target) || targetStart;
    const outOfOrder = eventIsScheduled(source) && eventIsScheduled(target) && sourceEnd && targetStart && targetStart < sourceEnd;
    let moveTarget = null;
    if (outOfOrder) {
      const sourceLabel = `“${clean(source.title) || 'the first item'}”`;
      const targetLabel = `“${clean(target.title) || 'the second item'}”`;
      const canMove = !fixedItem(target);
      const crossProject = String(source.project_id || '') !== String(target.project_id || '');
      const message = `${targetLabel} starts before ${sourceLabel} finishes, so this link would be out of order right away.${fixedItem(target) ? ` ${targetLabel} is locked or completed and can't move.` : ''}${crossProject ? ' The two items belong to different projects.' : ''}`;
      const choice = window.Portal?.ui?.choose
        ? await window.Portal.ui.choose(message, [
          { value:'cancel', label:(globalThis.PlatformLanguage?.text("scheduling","m_cbef679b21abb4","Cancel") ?? "Cancel") },
          { value:'link', label:'Link anyway', primary:!canMove },
          ...(canMove ? [{ value:'move', label:`Link and move ${clean(target.title) || 'it'} later`, primary:true }] : [])
        ], { title:'Link out of order' })
        : ((await window.PlatformUI?.confirm?.(message, { title:'Link out of order', okLabel:'Link anyway', cancelLabel:'Cancel' })) ? 'link' : 'cancel');
      if (!choice || choice === 'cancel') { renderGanttScheduleView(); return; }
      if (choice === 'move' && targetStart && targetEnd) {
        const allDay = !ganttItemIsTimed(target);
        // The shared dependency layout: whole days start on the next free
        // day, timed work keeps its own time of day (never midnight).
        const span = Scheduling.scheduleItemSpan?.(target) || null;
        const laidOut = span && Scheduling.dependencyEarliestStart
          ? validDate(Scheduling.dependencyEarliestStart({ type:'finish_to_start', lag_minutes:0 }, { start:eventStart(source), end:sourceEnd }, span, { config:schedulingConfig }))
          : null;
        const nextStart = laidOut || (allDay && (sourceEnd.getHours() || sourceEnd.getMinutes()) ? addDays(startOfDay(sourceEnd), 1) : new Date(sourceEnd));
        const nextEnd = span?.allDay ? addDays(nextStart, Math.max(1, span.days)) : new Date(nextStart.getTime() + (targetEnd.getTime() - targetStart.getTime()));
        moveTarget = { start:nextStart, end:nextEnd, all_day:allDay, schedule_granularity:allDay ? 'date' : 'time' };
      }
    }
    await saveGanttDependencies(target, nextDeps, 'Items linked', outOfOrder && !moveTarget);
    if (moveTarget) {
      const linked = allEvents.find((item) => String(item.id || '') === String(target.id || '')) || { ...target, depends_on:nextDeps };
      await saveEventCalendarRange(linked, moveTarget);
      renderGanttScheduleView();
    }
  }
  async function removeGanttDependency(event, dependency){
    const Scheduling = window.PlatformScheduling;
    const target = allEvents.find((item) => String(item.id || '') === String(event?.id || '')) || event;
    if (!Scheduling || !target?.id) return;
    if (!ganttCanEdit()) return;
    const existing = Scheduling.eventDependencies ? Scheduling.eventDependencies(target) : [];
    // Unlinking is explicit: a stray click on a connector must not drop it.
    const source = allEvents.find((item) => String(item.id || '') === String(dependency?.event_id || ''));
    const message = `Remove the link so “${clean(target.title) || 'this item'}” no longer follows “${clean(source?.title) || 'its predecessor'}”?`;
    const approved = window.PlatformUI?.confirm
      ? await window.PlatformUI.confirm(message, { title:'Remove dependency', okLabel:'Unlink', cancelLabel:'Keep link', danger:true })
      : (await window.Portal?.ui?.choose?.(message, [{ value:'cancel', label:'Keep link' }, { value:'unlink', label:'Unlink', primary:true }], { title:'Remove dependency' })) === 'unlink';
    if (!approved) return;
    await saveGanttDependencies(target, existing.filter((dep) => dep.id !== dependency?.id), 'Items unlinked');
  }
  async function saveGanttDependencies(target, dependsOn, label, outOfOrder = false){
    const project = eventProject(target);
    if (!project?.id || !window.PlatformScheduling?.saveProjectEvent) return;
    const next = { ...target, depends_on: dependsOn, updated_at: new Date().toISOString() };
    allEvents = allEvents.map((item) => String(item.id || '') === String(next.id || '') ? { ...item, depends_on: dependsOn } : item);
    renderGanttScheduleView();
    try {
      await window.PlatformScheduling.saveProjectEvent(orgId(), project, next, schedulingConfig);
      showToast(label, label === 'Items linked' ? `The item now follows the one you connected it to.${outOfOrder ? ' The link is out of order until one of them moves.' : ''}` : 'The dependency was removed.', !outOfOrder);
    } catch (error) {
      if (isStaleSaveError(error)) { await reloadAfterStaleChange(); return; }
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
    // Category filters are checkable chips, visually distinct from the view
    // switch, and shown in every view so the header never shifts.
    const typeChip = (type, label, on) => `<button type="button" class="dash-type-chip ${type} ${on ? 'active' : ''}" data-schedule-type-toggle="${type}" aria-pressed="${on ? 'true' : 'false'}"><span class="dash-type-chip-box" aria-hidden="true"><i class="fas fa-check"></i></span>${escapeHtml(label)}</button>`;
    const modeButtons = `
      <span class="dash-type-chips" role="group" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_92e47dd97f2a57","Schedules to show") ?? "Schedules to show")}">
        <span class="dash-control-label">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_6290719711de40","Show") ?? "Show")}</span>
        ${typeChip('sales', (globalThis.PlatformLanguage?.text("scheduling","m_2680c31facb03d","Sales") ?? "Sales"), showSalesSchedule)}
        ${typeChip('production', (globalThis.PlatformLanguage?.text("scheduling","m_c2e6380e130020","Production") ?? "Production"), showProductionSchedule)}
        ${viewMode === 'appointment_schedule'
          // Routing has only Sales and Production lanes: "Other" can't apply
          // there, so it stays in place (no header shift) but is disabled.
          ? typeChip('other', (globalThis.PlatformLanguage?.text("scheduling","m_4a04382820d2e1","Other") ?? "Other"), showOtherSchedule).replace('<button type="button"', `<button type="button" disabled aria-disabled="true" title="${escapeHtml(globalThis.PlatformLanguage?.text("scheduling","m_other_not_in_routing","Routing shows sales and production lanes only") ?? "Routing shows sales and production lanes only")}"`)
          : typeChip('other', (globalThis.PlatformLanguage?.text("scheduling","m_4a04382820d2e1","Other") ?? "Other"), showOtherSchedule)}
      </span>`;
    const displayButtons = ENABLE_CALENDAR_DISPLAY_SWITCH ? `
      <span class="dash-control-group">
        <span class="dash-control-label">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2b8e4c9b866e80","View") ?? "View")}</span>
        ${String([['summary','Summary'], ['events','Events']].map(([id, label]) => `<button class="dash-btn segment ${calendarDisplayMode === id ? 'active' : ''}" data-calendar-display="${id}">${escapeHtml(label)}</button>`).join(''))}
      </span>` : '';
    const today = new Date();
    const mobileViewChoices = [
      ...(routingViewEnabled() ? [['appointment_schedule', routingLabel, 'fa-route']] : []),
      ...(ganttViewEnabled() ? [['gantt', window.Portal?.terminology?.get?.('scheduling.gantt_view', 'Timeline') || 'Timeline', 'fa-chart-gantt']] : []),
      ['day', window.Portal?.terminology?.get?.('scheduling.day_view', 'Day') || 'Day', 'fa-calendar-day'],
      ['4day', isMobileScheduleLayout() ? '3 Day' : (window.Portal?.terminology?.get?.('scheduling.four_day_view', '4 Day') || '4 Day'), 'fa-calendar-week'],
      ['week', window.Portal?.terminology?.get?.('scheduling.week_view', 'Week') || 'Week', 'fa-table-columns'],
      ['month', window.Portal?.terminology?.get?.('scheduling.month_view', 'Month') || 'Month', 'fa-calendar-days']
    ];
    const appointmentButton = canEditSchedule() && window.Portal?.appFlags?.has?.('scheduling', 'appointment_slots') !== false ? '<button type="button" class="dash-new-appointment" data-new-appointment><i class="fas fa-plus" aria-hidden="true"></i> Appointment</button>' : '';
    const mobileToolbarExtras = `${canEditSchedule() ? '' : `<button type="button" class="dash-mobile-view-only" data-view-only-info aria-label="${escapeHtml(`${(globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only")}: ${scheduleReadOnlyMessage()}`)}" title="${escapeHtml(scheduleReadOnlyMessage())}"><i class="fas fa-eye" aria-hidden="true"></i><span>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_view_short","View") ?? "View")}</span></button>`}<span class="dash-mobile-menu-wrap"><button type="button" class="dash-mobile-control dash-mobile-show" data-mobile-schedule-menu aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2ea71a7fc7dec5","Choose schedules to show") ?? "Choose schedules to show")}" aria-expanded="${String(mobileScheduleMenuOpen ? 'true' : 'false')}"><i class="fas fa-sliders"></i><i class="fas fa-chevron-down" style="font-size:8px"></i></button>${String(mobileScheduleMenuOpen ? `<div class="dash-mobile-popover schedules" role="menu" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_92e47dd97f2a57","Schedules to show") ?? "Schedules to show")}"><button type="button" class="${showSalesSchedule ? 'active' : ''}" data-schedule-type-toggle="sales" role="menuitemcheckbox" aria-checked="${showSalesSchedule ? 'true' : 'false'}"><i class="fas fa-handshake"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_2680c31facb03d","Sales") ?? "Sales")}</button><button type="button" class="${showProductionSchedule ? 'active' : ''}" data-schedule-type-toggle="production" role="menuitemcheckbox" aria-checked="${showProductionSchedule ? 'true' : 'false'}"><i class="fas fa-helmet-safety"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_c2e6380e130020","Production") ?? "Production")}</button><button type="button" class="${showOtherSchedule ? 'active' : ''}" data-schedule-type-toggle="other" role="menuitemcheckbox" aria-checked="${showOtherSchedule ? 'true' : 'false'}"${viewMode === 'appointment_schedule' ? ` disabled aria-disabled="true" title="${escapeHtml(globalThis.PlatformLanguage?.text("scheduling","m_other_not_in_routing","Routing shows sales and production lanes only") ?? "Routing shows sales and production lanes only")}"` : ''}><i class="fas fa-calendar-plus"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_4a04382820d2e1","Other") ?? "Other")}</button></div>` : '')}</span><button type="button" class="dash-mobile-control dash-mobile-type" data-mobile-tray-open aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_858d2ae4d1a804","Open projects to schedule") ?? "Open projects to schedule")}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8f66eeaac51322","Projects to schedule") ?? "Projects to schedule")}"><i class="fas fa-inbox"></i></button>`;
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
    // The phone toolbar exists only at phone width, and only once the shared
    // schedule styles are on the page (they install with the first calendar
    // render in this same pass), so it never flashes as unstyled buttons.
    const mobileToolbarReady = isMobileScheduleLayout() && (document.getElementById('platform_schedule_view_css') || (dataLoaded && schedulingConfig));
    const mobileToolbarMarkup = isMobileScheduleLayout() ? (mobileToolbarReady ? mobileToolbar : '<div class="dash-mobile-toolbar-placeholder" aria-hidden="true"></div>') : '';
    // Links can carry a person/lead-source/city filter (scheduleGroup +
    // scheduleResource). Its controls are hidden, so show what is applied
    // and let it be cleared.
    // View-only sessions (no manage_schedule) see why nothing can be moved.
    // A focusable button: keyboard and touch users get the explanation too
    // (click/tap shows it), not only a mouse hover tooltip.
    const viewOnlyNote = canEditSchedule() ? '' : `<button type="button" class="dash-view-only-note" data-view-only-info aria-label="${escapeHtml(`${(globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only")}: ${scheduleReadOnlyMessage()}`)}" title="${escapeHtml(scheduleReadOnlyMessage())}"><i class="fas fa-eye" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_view_only","View only") ?? "View only")}</button>`;
    const filterText = breakdownValue !== 'all' ? `${(FILTER_TYPES[breakdownMode]?.label || 'Filter')}: ${breakdownMode === 'user' ? (!dataLoaded || !users.length || users.some((user) => clean(user.id) === clean(breakdownValue)) ? userDisplayName(breakdownValue) : 'Unknown person') : breakdownValue}` : '';
    // A background refresh of data already on screen: a quiet hint (it only
    // fades in when the refresh takes a moment), never a loading state.
    const refreshingNote = loading && dataLoaded ? `<span class="dash-refreshing" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_refreshing","Refreshing…") ?? "Refreshing…")}"><i class="fas fa-rotate fa-spin" aria-hidden="true"></i><span class="dash-refreshing-text">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_refreshing","Refreshing…") ?? "Refreshing…")}</span></span>` : '';
    const filterIndicator = breakdownValue !== 'all'
      ? `<span class="dash-filter-indicator" role="status" title="${escapeHtml(filterText)}"><span>${escapeHtml(filterText)}</span><button type="button" data-clear-schedule-filter aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_clear_filter","Clear filter") ?? "Clear filter")}" title="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_clear_filter","Clear filter") ?? "Clear filter")}"><i class="fas fa-xmark"></i></button></span>`
      : '';
    return `
      ${isMobileScheduleLayout() ? appointmentButton : ''}${String(mobileToolbarMarkup)}<div class="dash-toolbar">
        ${!isMobileScheduleLayout() ? appointmentButton : ''}
        <div class="dash-title-wrap"><h2 class="dash-title" title="${escapeHtml(visibleTitle())}">${String(escapeHtml(visibleTitle()))}</h2>${viewOnlyNote || filterIndicator || refreshingNote ? `<div class="dash-title-status">${viewOnlyNote}${filterIndicator}${refreshingNote}</div>` : ''}</div>
        <div class="dash-controls">
          <span class="dash-segmented dash-nav-group">
            <button type="button" data-dash-nav="-1" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_bb31fd73cbfe3b","Previous") ?? "Previous")}" title="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_bb31fd73cbfe3b","Previous") ?? "Previous")}"><i class="fas fa-chevron-left"></i></button>
            <button type="button" data-dash-today>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_23929ba4ba84dd","Today") ?? "Today")}</button>
            <button type="button" data-dash-nav="1" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_5e03a7c216f500","Next") ?? "Next")}" title="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_5e03a7c216f500","Next") ?? "Next")}"><i class="fas fa-chevron-right"></i></button>
          </span>
          ${[
            [
              ['day',window.Portal?.terminology?.get?.('scheduling.day_view', 'Day') || 'Day'],
              ['4day',window.Portal?.terminology?.get?.('scheduling.four_day_view', '4 Day') || '4 Day'],
              ['week',window.Portal?.terminology?.get?.('scheduling.week_view', 'Week') || 'Week'],
              ['month',window.Portal?.terminology?.get?.('scheduling.month_view', 'Month') || 'Month']
            ],
            [
              ...(routingViewEnabled() ? [['appointment_schedule',routingLabel, 'fa-route']] : []),
              ...(ganttViewEnabled() ? [['gantt', window.Portal?.terminology?.get?.('scheduling.gantt_view', 'Timeline') || 'Timeline', 'fa-chart-gantt']] : [])
            ]
          ].filter((group) => group.length).map((group) => `<span class="dash-segmented" role="group">${group.map(([mode, label, icon]) => `<button type="button" class="${viewMode === mode ? 'active' : ''} ${icon ? 'has-icon' : ''}" data-dash-view="${mode}" aria-pressed="${viewMode === mode ? 'true' : 'false'}"${icon ? ` aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"` : ''}>${icon ? `<i class="fas ${icon}" aria-hidden="true"></i>` : ''}<span class="dash-view-label">${escapeHtml(label)}</span></button>`).join('')}</span>`).join('')}
          ${String(modeButtons)}
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
    // Everything on the calendar that touches this day: timed and all-day
    // items, multi-day items passing through it, and company calendar items.
    const dayStart = startOfDay(day);
    const dayEnd = addDays(dayStart, 1);
    const touchesDay = (event) => {
      const start = eventStart(event);
      if (!start || !eventIsScheduled(event)) return false;
      const end = eventEnd(event) || start;
      return start < dayEnd && (end > dayStart || (end.getTime() === start.getTime() && start >= dayStart));
    };
    // Vehicle bookings live only in Routing's vehicle lanes, but they are
    // part of the day too.
    const vehicleBookings = showProductionSchedule
      ? floatingEvents.filter((event) => isVehicleBooking(event) && !['cancelled', 'canceled'].includes(clean(event.status).toLowerCase())).map(decorateFloatingEvent)
      : [];
    const dayEvents = [...eventCalendarItems(), ...vehicleBookings]
      .filter(touchesDay)
      .sort((a, b) => {
        const allDayA = a.all_day === true || clean(a.schedule_granularity) === 'date' || eventStart(a) < dayStart;
        const allDayB = b.all_day === true || clean(b.schedule_granularity) === 'date' || eventStart(b) < dayStart;
        if (allDayA !== allDayB) return allDayA ? -1 : 1;
        return (eventStart(a)?.getTime() || 0) - (eventStart(b)?.getTime() || 0);
      });
    const itemTime = (event) => {
      const start = eventStart(event);
      const end = eventEnd(event) || start;
      if (event.all_day === true || clean(event.schedule_granularity) === 'date') return (globalThis.PlatformLanguage?.text("scheduling","m_42b02bf1587e27","All day") ?? "All day");
      if (start < dayStart && end > dayEnd) return 'All day (continues)';
      if (start < dayStart) return `Until ${fmtTime(end)}`;
      if (end > dayEnd) return `${fmtTime(start)} onward`;
      return `${fmtTime(start)} – ${fmtTime(end)}`;
    };
    const itemRow = (event) => {
      const project = event.project_id ? eventProject(event) : {};
      const vehicleCrew = isVehicleBooking(event) ? (clean(event.vehicle_crew_name) || clean(workforceResources.find((resource) => clean(resource.id) === clean(event.vehicle_crew_id))?.name)) : '';
      const meta = isVehicleBooking(event)
        // The title already names the vehicle: the meta line adds the crew.
        ? [eventEquipRefs(event).map((ref) => clean(ref.name || equipmentUnits.find((unit) => clean(unit.id) === clean(ref.id))?.name)).filter((name) => name && name !== clean(event.title)).join(', '), vehicleCrew ? `Booked for ${vehicleCrew}` : ''].filter(Boolean)
        : [project?.id ? projectTitle(project, event) : '', event.assignee_label || (currentAssignmentId(event) ? assignedLabel(event) : '')].map(clean).filter((value) => value && value !== 'Assign later' && !(value === 'Unassigned' && !event.assignee_label));
      const kind = isEquipmentWindowEvent(event) ? eventTypeMeta(eventTypeId(event) || eventKind(event)).label : calendarEventCategory(event) === 'sales' ? eventTypeMeta(eventKind(event) === 'sales_follow_up' ? 'sales_follow_up' : 'sales_appointment').label : isMaterialEvent(event) ? eventTypeMeta('delivery').label : isProductionEvent(event) ? eventTypeMeta(eventTypeId(event) || 'project_work').label : eventTypeMeta(eventTypeId(event)).label;
      return `<button type="button" class="dash-list-event" data-day-event-id="${escapeHtml(event.id)}"><span class="dash-list-time">${escapeHtml(itemTime(event))}</span><span><span class="dash-list-title">${escapeHtml(clean(event.title) || eventTypeMeta(eventTypeId(event)).title)}</span><span class="dash-list-meta">${escapeHtml(meta.join(' · '))}</span></span><span class="dash-stage-pill">${escapeHtml(kind)}</span></button>`;
    };
    const back = document.createElement('div');
    back.className = 'dash-modal-backdrop';
    back.innerHTML = `
      <div class="dash-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(day.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' }))}">
        <div class="dash-modal-head">
          <div><h3>${String(escapeHtml(day.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' })))}</h3><div class="dash-sub">${escapeHtml(`${dayEvents.length} scheduled item${dayEvents.length === 1 ? '' : 's'}`)}</div></div>
          <button type="button" class="dash-modal-close" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_close","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="dash-modal-body">
          ${String(topStatsHtmlForDay(day))}
          <div class="dash-day-list">${String(dayEvents.length ? dayEvents.map(itemRow).join('') : `<div class="dash-empty">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_nothing_scheduled_day","Nothing is scheduled on this day.") ?? "Nothing is scheduled on this day.")}</div>`)}</div>
        </div>
      </div>
    `;
    let modalHandle = null;
    // Focus moves into the list and returns to the date that opened it.
    const returnFocusDate = dayKey;
    const close = (closeOptions = {}) => {
      modalHandle?.unregister?.();
      modalHandle = null;
      const hadFocus = back.contains(document.activeElement);
      back.remove();
      if (activeDayModal?.element === back) activeDayModal = null;
      if (!closeOptions.skipFocusReturn && (hadFocus || document.activeElement === document.body)) {
        // Closing may navigate back and redraw the calendar; the redraw
        // (render) puts focus back on this date's number.
        pendingDayNumberFocus = returnFocusDate;
        focusPendingDayNumber();
        setTimeout(() => { pendingDayNumberFocus = ''; }, 1500);
      }
      if (!closeOptions.fromRoute && !window.Portal?.navigation?.applying) {
        window.Portal?.navigation?.backOrClose?.(['day'], { day:null }, { source:'schedule-day-close' });
      }
    };
    back.querySelector('.dash-modal-close')?.addEventListener('click', close);
    back.querySelectorAll('[data-day-event-id]').forEach((node) => node.addEventListener('click', () => {
      const event = dayEvents.find((item) => String(item.id || '') === String(node.dataset.dayEventId || ''));
      if (!event) return;
      // Leaving the list clears day= so the modal doesn't come back. Focus
      // goes into the editor (not back to the date number and its tooltip);
      // closing the editor with Cancel / × / Escape returns to this list.
      close({ skipFocusReturn:true });
      window.PlatformUI?.hideTooltip?.();
      openPlacedCalendarEvent(event, { element:editorAnchorFor(event.id), fromDayList:dayKey });
      requestAnimationFrame(() => {
        const pop = document.querySelector('.dash-event-popover');
        if (!pop || pop.contains(document.activeElement)) return;
        (pop.querySelector('[data-event-title]:not([disabled])') || pop.querySelector('input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])'))?.focus?.({ preventScroll:true });
        window.PlatformUI?.hideTooltip?.();
      });
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
    // Keyboard focus stays inside the dialog while it is open.
    back.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const focusable = [...back.querySelectorAll('button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])')].filter((node) => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      else if (!back.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    });
    (back.querySelector('.dash-list-event') || back.querySelector('.dash-modal-close'))?.focus?.({ preventScroll:true });
  }
  let pendingDayNumberFocus = '';
  // { day, eventId } while an editor opened from a day list is open.
  let dayListReturn = null;
  function focusPendingDayNumber(){
    if (!pendingDayNumberFocus || activeDayModal?.element?.isConnected) return;
    const dateNumber = rootEl?.querySelector(`#dashEventCalendarView [data-prs-date="${pendingDayNumberFocus}"] .prs-day-num`);
    if (!dateNumber) return;
    // It becomes its week's Tab stop (month date numbers use a roving stop).
    dateNumber.closest('.prs-month-week')?.querySelectorAll('.prs-day-num[tabindex="0"]').forEach((node) => node.setAttribute('tabindex', '-1'));
    if (dateNumber.hasAttribute('tabindex')) dateNumber.setAttribute('tabindex', '0');
    bind._monthFocusDate = pendingDayNumberFocus;
    dateNumber.focus({ preventScroll:true });
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
      // Picking a month completes the choice; the year list only adjusts it.
      mobileMonthMenuOpen = false;
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
    // Keyboard: one date number per week is a Tab stop (arrow keys move
    // between dates), so Tab reaches each week's items right after its date
    // instead of passing all seven date numbers first.
    const monthDayNums = [...rootEl.querySelectorAll('#dashEventCalendarView .prs-month .prs-day-num')];
    const todayKey = routeDate(new Date());
    monthDayNums.forEach((node) => {
      const date = parseRouteDate(node.closest('[data-prs-date]')?.dataset?.prsDate);
      if (!date) return;
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '-1');
      node.setAttribute('aria-label', `Show everything on ${date.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' })}`);
      node.title = 'Show everything on this day';
    });
    rootEl.querySelectorAll('#dashEventCalendarView .prs-month-week').forEach((week) => {
      const nums = [...week.querySelectorAll('.prs-day-num')];
      const keyOf = (node) => node.closest('[data-prs-date]')?.dataset?.prsDate || '';
      const stop = nums.find((node) => keyOf(node) === bind._monthFocusDate) || nums.find((node) => keyOf(node) === todayKey) || nums[0];
      stop?.setAttribute('tabindex', '0');
    });
    monthDayNums.forEach((node, index) => node.addEventListener('keydown', (event) => {
      const step = { ArrowRight:1, ArrowLeft:-1, ArrowDown:7, ArrowUp:-7 }[event.key];
      if (!step) return;
      const target = monthDayNums[index + step];
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const week = node.closest('.prs-month-week');
      const targetWeek = target.closest('.prs-month-week');
      if (week === targetWeek) node.setAttribute('tabindex', '-1');
      targetWeek?.querySelectorAll('.prs-day-num[tabindex="0"]').forEach((other) => other.setAttribute('tabindex', '-1'));
      target.setAttribute('tabindex', '0');
      bind._monthFocusDate = target.closest('[data-prs-date]')?.dataset?.prsDate || '';
      target.focus();
    }));
    // Open month/year lists start at the current choice, not January/-12y.
    rootEl.querySelectorAll('.prs-mobile-month-picker section').forEach((section) => {
      const active = section.querySelector('button.active');
      if (active) section.scrollTop = Math.max(0, active.getBoundingClientRect().top - section.getBoundingClientRect().top + section.scrollTop - section.clientHeight / 2 + active.offsetHeight / 2);
    });
    rootEl.querySelector('[data-clear-schedule-filter]')?.addEventListener('click', () => {
      breakdownValue = 'all';
      syncScheduleRoute({ scheduleGroup:null, scheduleResource:null }, { history:'replace', source:'schedule-filter', ownedKeys:['scheduleGroup','scheduleResource'] });
      render();
      // The cleared chip is gone: keep keyboard focus in the toolbar.
      rootEl.querySelector('.dash-toolbar [data-dash-today]')?.focus({ preventScroll:true });
    });
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
      // The shared mobile toolbar renders prs-* menus; taps inside them must
      // reach their buttons instead of closing and re-rendering first.
      if (!event.target.closest('.dash-mobile-popover,.dash-mobile-control,.prs-mobile-popover,.prs-mobile-control,[data-mobile-tray-open],.dash-mobile-tray')) {
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
      if (!canEditSchedule()) { showToast('View only', scheduleReadOnlyMessage(), VIEW_ONLY_TOAST); return; }
      // Sales auto-route reassigns the day's appointments (including ones
      // already assigned), so it asks first.
      if (scope === 'sales') {
        const ask = window.Portal?.ui?.confirm || window.PlatformUI?.confirm;
        const go = typeof ask === 'function'
          ? await ask(`Reassign the sales appointments on ${routingDateLabel()} to cut travel? Appointments that are already assigned can move to another salesperson.`, { title:'Auto-route sales appointments?', okLabel:'Auto-route', cancelLabel:'Cancel', defaultFocus:'cancel' })
          : true;
        if (!go || btn.disabled) return;
      }
      btn.disabled = true;
      const originalHtml = btn.innerHTML;
      const salesOwnersBefore = new Map(allEvents.filter((item) => !isProductionEvent(item) && !isMaterialEvent(item)).map((item) => [String(item.id || ''), clean(currentAssignmentId(item))]));
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Routing…';
      const startsBefore = new Map(allEvents.filter(isProductionEvent).map((item) => [String(item.id || ''), eventStart(item)?.getTime() || 0]));
      try {
        const result = await window.PlatformAPI.routing.optimize(id, {
          event_type_id: eventTypeId,
          date: routingDateValue(),
          apply: true
        });
        let routed = Number(result?.applied_count || 0);
        const unrouted = Array.isArray(result?.unassigned) ? result.unassigned.length : 0;
        const missingAddress = Number(result?.skipped_missing_address_count || result?.skipped_missing_address?.length || 0);
        const travelTotal = Number(result?.total_travel_minutes || 0);
        const cleared = Number(result?.cleared_count || 0);
        const clearedNote = cleared ? ` ${cleared} previously assigned appointment${cleared === 1 ? ' was' : 's were'} moved back to Unassigned.` : '';
        const missingAddressNote = missingAddress ? ` ${missingAddress} project${missingAddress === 1 ? ' was' : 's were'} skipped because ${missingAddress === 1 ? 'it has' : 'they have'} no address.` : '';
        if (scope === 'production' || clean(result?.mode) === 'sequence_only') {
          // Production only re-orders timed single-crew jobs; crews stay put.
          const skipped = Array.isArray(result?.skipped_production) ? result.skipped_production.length : 0;
          const skippedNote = skipped ? ` ${skipped} item${skipped === 1 ? ' was' : 's were'} left as scheduled (all-day, several crews, no crew, or assigned to a person).` : '';
          // Say what actually moved: the server counts every job it sequenced,
          // including ones already in the best order.
          await loadData({ force: true });
          const moved = allEvents.filter((item) => isProductionEvent(item) && startsBefore.has(String(item.id || '')) && startsBefore.get(String(item.id || '')) !== (eventStart(item)?.getTime() || 0));
          const movedNames = moved.slice(0, 3).map((item) => clean(item.title) || 'Job').join(', ') + (moved.length > 3 ? ` +${moved.length - 3} more` : '');
          showToast(
            moved.length ? 'Jobs re-timed by travel' : 'Nothing to reorder',
            `${moved.length ? `${moved.length} job${moved.length === 1 ? '' : 's'} re-timed to cut travel (${movedNames}); crews unchanged.` : (routed ? 'Timed jobs are already in the best order; nothing moved.' : 'No timed single-crew jobs needed reordering.')}${skippedNote}${missingAddressNote}`,
            true
          );
          return;
        }
        // Count what actually changed hands: the server counts every
        // appointment it routed, including ones that kept their salesperson.
        await loadData({ force: true });
        routed = allEvents.filter((item) => salesOwnersBefore.has(String(item.id || '')) && clean(currentAssignmentId(item)) && salesOwnersBefore.get(String(item.id || '')) !== clean(currentAssignmentId(item))).length;
        const overbookedKey = `${scope}:${routingDateValue()}`;
        if (unrouted) routingOverbooked[overbookedKey] = unrouted; else delete routingOverbooked[overbookedKey];
        if (unrouted) {
          showToast(
            (globalThis.PlatformLanguage?.text("scheduling","m_1a3086087f3e32","Auto-route: day is overbooked") ?? "Auto-route: day is overbooked"),
            ((v0,v1,v2,v3,v4,v5) => globalThis.PlatformLanguage?.text("scheduling","m_968883a1455a5e",`${v0} appointment${v1} assigned (${v2} min total travel), but the day is overbooked — ${v3} could not fit anyone's schedule.${v4}${v5}`,{v0,v1,v2,v3,v4,v5}) ?? `${v0} appointment${v1} assigned (${v2} min total travel), but the day is overbooked — ${v3} could not fit anyone's schedule.${v4}${v5}`)(routed,routed === 1 ? '' : 's',travelTotal,unrouted,missingAddressNote,clearedNote).replace(travelTotal > 0 ? '' : ' (0 min total travel)', travelTotal > 0 ? '' : ' (no travel times available)'),
            false
          );
        } else if (!routed && !cleared) {
          showToast('Already routed', `Every appointment on ${routingDateLabel()} already has the salesperson with the least travel; nothing changed.${missingAddressNote}`, !missingAddress);
        } else {
          showToast(
            missingAddress ? 'Auto-route complete with skipped projects' : 'Auto-route complete',
            ((v0,v1,v2,v3) => globalThis.PlatformLanguage?.text("scheduling","m_bcfe6241b8a874",`${v0} appointment${v1} assigned (${v2} min total travel).${v3}`,{v0,v1,v2,v3}) ?? `${v0} appointment${v1} assigned (${v2} min total travel).${v3}`)(routed,routed === 1 ? '' : 's',travelTotal,missingAddressNote).replace(travelTotal > 0 ? '' : ' (0 min total travel)', travelTotal > 0 ? '' : ' (no travel times available)'),
            !missingAddress
          );
        }
      } catch (error) {
        const message = error?.data?.error === 'routing_no_events'
          ? (scope === 'production'
            ? `No timed single-crew jobs are scheduled on ${routingDateLabel()}, so there is nothing to order. All-day and multi-crew work is never re-routed.`
            : `No ${scope} appointments are scheduled on ${routingDateLabel()}. Use the pane's arrows to move to the day you want to route.`)
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
      persistSchedulePreference({ production_vehicles: productionVehiclesVisible });
      if (!productionVehiclesVisible) {
        vehiclePlacementUnitId = '';
        vehiclePlacementDraft = null;
      }
      resetScheduleScrollPersistence();
      render();
    });
    rootEl.querySelectorAll('[data-vehicle-bank-unit]').forEach((btn) => btn.addEventListener('click', async () => {
      const unitId = clean(btn.dataset.vehicleBankUnit);
      const deselecting = vehiclePlacementUnitId === unitId;
      if (!canEditSchedule()) { showToast('View only', scheduleReadOnlyMessage(), VIEW_ONLY_TOAST); return; }
      if (!(await confirmDiscardPendingPlacement())) return;
      if (placementSaveBusy()) return;
      clearPlacementSelection();
      vehiclePlacementUnitId = deselecting ? '' : unitId;
      vehiclePlacementDraft = null;
      // The bank's hover tooltip must not stay behind after the re-render.
      window.PlatformUI?.hideTooltip?.();
      render();
      focusRailControl(railAttrSelector('data-vehicle-bank-unit', unitId));
      // Picking a vehicle brings the crews' vehicle lanes into view (on short
      // screens the Production pane may be scrolled to the people rows).
      if (!deselecting) requestAnimationFrame(() => revealVehicleLanes());
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
      // Every view (Routing included) keeps the date being looked at.
      if (enteringSchedule) resetScheduleScrollPersistence();
      if (viewMode === 'gantt') pendingGanttScrollDate = { date:anchorDate, fraction:0.25 };
      // Entering Month shows today's week again (a fresh Month view).
      if (nextView === 'month') scrollMonthToToday._key = '';
      writeSchedulePref(SCHEDULE_VIEW_PREF_KEY, viewMode);
      mobileViewMenuOpen = false;
      mobileMonthMenuOpen = false;
      mobileScheduleMenuOpen = false;
      syncScheduleRoute({ scheduleView:viewMode, date:routeDate() }, { history:'push', source:'schedule-view', ownedKeys:['scheduleView'] });
      render();
    }));
    rootEl.querySelectorAll('[data-schedule-type-toggle]').forEach((btn) => btn.addEventListener('click', async () => {
      const next = btn.dataset.scheduleTypeToggle || 'sales';
      // Hiding the type being placed ends the placement: a placed draft is
      // only discarded after confirmation (Keep it leaves the chip on).
      const placing = placementWaitingItem();
      const turningOff = next === 'production' ? showProductionSchedule : next === 'other' ? showOtherSchedule : showSalesSchedule;
      const hidesPlacement = !!placing && turningOff && (next === 'sales' ? placing.kind === 'sales' : next === 'production' ? ['production', 'materials', 'vehicle'].includes(placing.kind) : false);
      if (hidesPlacement && !(await confirmDiscardPendingPlacement())) return;
      if (next === 'production') showProductionSchedule = !showProductionSchedule;
      else if (next === 'other') showOtherSchedule = !showOtherSchedule;
      else showSalesSchedule = !showSalesSchedule;
      scheduleMode = showSalesSchedule ? 'sales' : (showProductionSchedule ? 'production' : 'sales');
      const typesValue = scheduleTypeRouteValue();
      writeSchedulePref(SCHEDULE_TYPES_PREF_KEY, typesValue || '');
      appointmentScheduleMenuEventId = '';
      if (hidesPlacement || !placing) {
        clearPlacementSelection();
        vehiclePlacementUnitId = '';
        vehiclePlacementDraft = null;
        if (hidesPlacement) closeEventDraftPopover();
      }
      eventEditorEventId = '';
      // A person/lead-source/city filter is independent of the Show chips: it
      // stays applied (on screen and in the URL) while types are toggled.
      // The phone Schedules menu stays open so several types can be toggled.
      // The URL records exactly which chips are on (and survives reloads);
      // toggling a filter replaces the entry instead of stacking history.
      syncScheduleRoute({ scheduleType:typesValue }, { history:'replace', source:'schedule-type', ownedKeys:['scheduleType'] });
      render();
    }));
    rootEl.querySelectorAll('[data-new-appointment]').forEach(button => button.addEventListener('click', async () => {
      if (!canEditSchedule()) return;
      try { await window.FirstMateBooking.open({orgId:orgId(), onBooked:() => scheduleLoad()}); }
      catch (error) { showToast('Appointment booking', error.message, false); }
    }));
    rootEl.querySelectorAll('[data-calendar-display]').forEach((btn) => btn.addEventListener('click', () => {
      calendarDisplayMode = ENABLE_CALENDAR_DISPLAY_SWITCH ? (btn.dataset.calendarDisplay || 'events') : 'events';
      render();
    }));
    rootEl.querySelectorAll('[data-dash-nav]').forEach((btn) => btn.addEventListener('click', () => nav(Number(btn.dataset.dashNav) || 0)));
    rootEl.querySelectorAll('[data-dash-today]').forEach((btn) => btn.addEventListener('click', goToToday));
    rootEl.querySelectorAll('[data-view-only-info]').forEach((btn) => btn.addEventListener('click', () => {
      showToast((globalThis.PlatformLanguage?.text("scheduling","m_view_only","View only") ?? "View only"), scheduleReadOnlyMessage(), VIEW_ONLY_TOAST);
    }));
    rootEl.querySelectorAll('[data-schedule-retry]').forEach((btn) => btn.addEventListener('click', () => {
      if (loading) return;
      loadData({ force:true }).catch(() => null);
    }));
    rootEl.querySelectorAll('[data-event-id]').forEach((node) => node.addEventListener('click', () => {
      const event = events.find((item) => item.id === node.dataset.eventId);
      if (event) openProjectFromEvent(event);
    }));
    bindPlacementBanner(rootEl);
    // Rail group heads collapse/expand their group.
    rootEl.querySelectorAll('[data-toggle-group]').forEach((node) => node.addEventListener('click', () => {
      const id = node.dataset.toggleGroup || '';
      if (!id) return;
      collapsedGroups[id] = node.getAttribute('aria-expanded') !== 'false';
      persistRailCollapsed();
      render();
      focusRailControl(railAttrSelector('data-toggle-group', id));
    }));
    /* Selecting a waiting item starts placement mode (banner + previews). The
     * editor is not opened over the calendar: it opens beside the placed
     * draft, or beside the appointment when it already has a time. An unsaved
     * draft is only discarded after confirmation. */
    const beginRailSelection = async () => {
      if (!canEditSchedule()) {
        showToast('View only', scheduleReadOnlyMessage(), VIEW_ONLY_TOAST);
        return false;
      }
      // A placement being saved can't be switched away from mid-save.
      if (placementSaveBusy()) return false;
      if (!(await confirmDiscardPendingPlacement())) return false;
      if (placementSaveBusy()) return false;
      closeAssignmentMenu();
      if (!eventEditorEventId) closeEventDraftPopover();
      clearPlacementSelection();
      vehiclePlacementUnitId = '';
      vehiclePlacementDraft = null;
      eventDraftPopoverId = '';
      eventEditorEventId = '';
      eventDraftProjectQuery = '';
      eventCustomerDetailsOpen = false;
      eventAdvancedOpen = false;
      return true;
    };
    rootEl.querySelectorAll('[data-schedule-project-id]').forEach((node) => node.addEventListener('click', async () => {
      const event = events.find((item) => String(item.id || '') === String(node.dataset.scheduleEventId || ''));
      if (!event) return;
      const focusSelector = railAttrSelector('data-schedule-event-id', event.id);
      const deselecting = String(appointmentScheduleEventId || '') === String(event.id || '') && selectedPlacementKind() === 'sales';
      if (!(await beginRailSelection())) return;
      if (deselecting) { render(); focusRailControl(focusSelector); return; }
      appointmentScheduleProjectId = String(event.project_id || eventProject(event).id || '');
      appointmentScheduleEventId = String(event.id || '');
      appointmentScheduleDraft = { description: event.description || event.notes || '' };
      // Jump to the appointment's day so the selection is visible.
      const scheduledStart = eventIsScheduled(event) ? eventStart(event) : null;
      if (scheduledStart) anchorDate = startOfDay(scheduledStart) || anchorDate;
      render();
      if (node.closest('.dash-routing-placement-dock')) return;
      focusRailControl(focusSelector);
      if (viewMode === 'appointment_schedule') {
        if (scheduledStart) requestAnimationFrame(() => scrollRoutingToEvent(event.id));
        return;
      }
      // Already dated but unassigned: nothing to place, so open its editor
      // beside it on the calendar to pick a salesperson.
      // (Not on phones: the full-screen editor would cover the calendar and
      // the banner; the chip there can be dragged or tapped instead.)
      if (scheduledStart && viewMode !== 'gantt' && !isMobileScheduleLayout()) {
        setTimeout(() => {
          const anchor = editorAnchorFor(event.id);
          if (anchor) renderEventDraftPopover(anchor);
        }, 0);
      }
    }));
    rootEl.querySelectorAll('[data-production-project-id]:not([data-production-event-id])').forEach((node) => node.addEventListener('click', async () => {
      const projectId = String(node.dataset.productionProjectId || '');
      const focusSelector = `[data-production-project-id="${window.CSS?.escape ? window.CSS.escape(projectId) : projectId}"]:not([data-production-event-id])`;
      const deselecting = productionScheduleProjectId === projectId && !productionScheduleEventId && selectedPlacementKind() === 'production';
      if (!(await beginRailSelection())) return;
      if (deselecting) { render(); focusRailControl(focusSelector); return; }
      productionScheduleProjectId = projectId;
      productionScheduleEventId = '';
      const project = selectedProductionProject();
      productionScheduleDraft = {
        id: '__production_event_draft',
        event_id: '',
        event_type_default_id: 'project_work',
        type_id: 'project_work',
        title: projectWorkTitle(project || {}),
        project_id: project?.id || productionScheduleProjectId || '',
        project_title: projectTitle(project || {}),
        project_address: projectAddress(project || {}, {}),
        description: ''
      };
      render();
      if (!node.closest('.dash-routing-placement-dock')) focusRailControl(focusSelector);
    }));
    const cancelRailPlacement = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (placementSaveBusy()) return;
      cancelPlacement();
    };
    rootEl.querySelectorAll('[data-production-bundle-cancel]').forEach((node) => node.addEventListener('click', cancelRailPlacement));
    rootEl.querySelectorAll('[data-bundle-child-cancel]').forEach((node) => node.addEventListener('click', cancelRailPlacement));
    rootEl.querySelectorAll('[data-production-bundle-toggle]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const key = String(node.dataset.productionBundleToggle || '');
      if (!key) return;
      if (expandedProductionBundles.has(key)) expandedProductionBundles.delete(key);
      else expandedProductionBundles.add(key);
      render();
      focusRailControl(railAttrSelector('data-production-bundle-toggle', key));
    }));
    const selectMaterialForPlacement = (event) => {
      materialScheduleProjectId = String(event.project_id || '');
      materialScheduleEventId = String(event.id || '');
      materialScheduleDraft = null;
      productionScheduleDraft = null;
      focusedScheduleEventId = String(event.id || '');
    };
    rootEl.querySelectorAll('[data-production-bundle-primary]').forEach((node) => node.addEventListener('click', async () => {
      const bundleKey = String(node.dataset.productionBundlePrimary || '');
      const bundle = scheduleBundleGroups(unscheduledEvents((item) => isProductionEvent(item) || isMaterialEvent(item))).find((item) => item.key === bundleKey);
      if (!bundle?.primary) return;
      const primary = bundle.primary;
      // A lone delivery is placed as a delivery, not as a work bundle.
      const loneDelivery = isMaterialEvent(primary) && !bundle.dependents.length;
      const deselecting = loneDelivery ? materialScheduleEventId === String(primary.id || '') : productionScheduleBundleKey === bundleKey;
      if (!(await beginRailSelection())) return;
      const focusSelector = railAttrSelector('data-production-bundle-primary', bundleKey);
      if (deselecting) { render(); focusRailControl(focusSelector); return; }
      if (loneDelivery) {
        selectMaterialForPlacement(primary);
      } else {
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
      }
      render();
      if (!node.closest('.dash-routing-placement-dock')) focusRailControl(focusSelector);
    }));
    // Bundle children place by their real kind: work as production work,
    // deliveries as deliveries.
    rootEl.querySelectorAll('[data-production-bundle-child]').forEach((node) => node.addEventListener('click', async () => {
      const eventId = String(node.dataset.productionBundleChild || '');
      const event = allEvents.find((item) => String(item.id || '') === eventId);
      if (!event) return;
      const deselecting = bundleChildIsSelected(event);
      if (!(await beginRailSelection())) return;
      const focusSelector = railAttrSelector('data-production-bundle-child', eventId);
      if (deselecting) { render(); focusRailControl(focusSelector); return; }
      if (isMaterialEvent(event)) {
        selectMaterialForPlacement(event);
      } else {
        productionScheduleProjectId = String(node.dataset.bundleChildProjectId || event.project_id || '');
        productionScheduleEventId = eventId;
        productionScheduleDraft = {
          id: event.id,
          event_id: event.id,
          event_type_default_id: eventTypeId(event) || 'project_work',
          type_id: eventTypeId(event) || 'project_work',
          title: event.title || (globalThis.PlatformLanguage?.text("scheduling","m_2ac9ecd66d638b","New Event") ?? "New Event"),
          start: null,
          end: null,
          all_day: event.all_day !== false,
          schedule_granularity: event.schedule_granularity || (event.all_day === false ? 'time' : 'date'),
          ...workResourcePayload(event)
        };
      }
      render();
      focusRailControl(focusSelector);
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
    // Keyboard users keep their place: the control that had focus is found
    // again (by its data attribute) after the markup is rebuilt.
    const focusSelector = scheduleFocusSelector(document.activeElement);
    // Until the first load settles, show loading states instead of an empty
    // calendar and a false "nothing waiting" rail.
    const showLoading = !dataLoaded;
    const loadingText = (globalThis.PlatformLanguage?.htmlText("scheduling","m_loading_schedule","Loading schedule…") ?? "Loading schedule…");
    const loadNotice = scheduleLoadNoticeHtml();
    const firstLoadFailed = showLoading && !!scheduleLoadError;
    const main = firstLoadFailed
      ? loadNotice
      : showLoading
      ? `<div class="dash-loading-state" role="status" aria-live="polite"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i>${loadingText}</div>`
      : viewMode === 'appointment_schedule'
        ? renderAppointmentSchedule()
        : viewMode === 'gantt'
          ? renderGanttShell()
          : (calendarDisplayMode === 'events' ? renderEventCalendarShell() : viewMode === 'month' ? renderMonth() : viewMode === 'day' ? renderDay() : renderWeek());
    const allTypesHidden = !activeScheduleTypes().length;
    const hiddenHint = allTypesHidden && !showLoading
      ? `<div class="dash-empty-hint" role="status">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_all_types_hidden","Every schedule is hidden. Turn on Sales, Production or Other to see items here.") ?? "Every schedule is hidden. Turn on Sales, Production or Other to see items here.")}</div>`
      : '';
    const railHtml = showLoading
      ? `<div class="dash-groups"><div class="dash-rail-title">${(globalThis.PlatformLanguage?.htmlText("scheduling","m_waiting_title","Waiting to be scheduled") ?? "Waiting to be scheduled")}</div><div class="dash-loading-rail" role="status">${firstLoadFailed ? `<i class="fas fa-triangle-exclamation" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_schedule_load_error","Couldn't load the schedule") ?? "Couldn't load the schedule")}` : `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i>${loadingText}`}</div></div>`
      : renderGroups();
    // Calendar views explain an empty grid when every Show chip is off
    // (Routing and Timeline render their own empty messages).
    const calendarHint = ['appointment_schedule', 'gantt'].includes(viewMode) ? '' : hiddenHint;
    const mobileTray = mobileTrayOpen ? `<div class="dash-mobile-tray-backdrop ${String(mobileTrayClosing ? 'closing' : '')}" data-mobile-tray-backdrop><aside class="dash-mobile-tray" aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_8f66eeaac51322","Projects to schedule") ?? "Projects to schedule")}"><div class="dash-mobile-tray-head"><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_e9f71e12236d72","Projects to Schedule") ?? "Projects to Schedule")}</strong><button type="button" class="dash-mobile-tray-close" data-mobile-tray-close aria-label="${(globalThis.PlatformLanguage?.htmlText("scheduling","m_d957e47b7fba31","Close projects to schedule") ?? "Close projects to schedule")}"><i class="fas fa-xmark"></i></button></div>${String(railHtml)}</aside></div>` : '';
    rootEl.innerHTML = `<div class="dash-shell">${toolbarHtml()}<div class="dash-body ${['appointment_schedule','gantt'].includes(viewMode) ? 'schedule-mode' : ''} ${viewMode === 'gantt' ? 'gantt-mode' : ''} ${!['appointment_schedule','gantt'].includes(viewMode) && calendarDisplayMode === 'events' ? 'events-mode' : ''}" aria-busy="${showLoading && !firstLoadFailed ? 'true' : 'false'}"><div class="dash-left">${topStatsHtml()}${firstLoadFailed ? '' : loadNotice}${calendarHint}${main}</div><aside class="dash-right">${railHtml}</aside></div>${mobileTray}</div>`;
    if (!showLoading) {
      if (viewMode === 'appointment_schedule') renderScheduleLibraryView();
      else if (viewMode === 'gantt') {
        renderGanttScheduleView();
        if (pendingGanttScrollDate && ganttControls()?.scrollToTime) {
          const target = pendingGanttScrollDate;
          pendingGanttScrollDate = null;
          ganttControls().scrollToTime(target.date.getTime(), target.fraction);
        }
      }
      else if (calendarDisplayMode === 'events') renderEventCalendarView();
    }
    bind();
    if (skipScheduleScrollCapture) scheduleScrollResetPending = false;
    if (focusSelector) {
      const target = rootEl.querySelector(focusSelector);
      if (target && typeof target.focus === 'function') target.focus({ preventScroll:true });
    }
    focusPendingDayNumber();
  }
  function scheduleFocusSelector(element){
    if (!element || !rootEl?.contains?.(element) || element === document.body) return '';
    if (!element.matches?.('button,[tabindex],a,input,select,textarea')) return '';
    const attribute = [...(element.attributes || [])].find((attr) => attr.name.startsWith('data-') && !attr.name.startsWith('data-prs-') && !attr.name.startsWith('data-psv-'));
    if (!attribute) return '';
    const value = window.CSS?.escape ? window.CSS.escape(attribute.value) : String(attribute.value).replace(/["\\]/g, '\\$&');
    return attribute.value ? `[${attribute.name}="${value}"]` : `[${attribute.name}]`;
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
  /* The schedule itself (projects, company calendar items): a failed or slow
   * request is reported as a failure, never as "no items", so the caller
   * keeps the last good data. A slow server gets a generous wait. */
  async function settleScheduleSource(promise, label, deadline = 0){
    try {
      const value = await withTimeout(promise, deadline ? Math.max(1000, deadline - Date.now()) : 45000, label);
      if (value == null) throw new Error(`${label || 'Schedule request'} returned nothing.`);
      return { ok:true, value };
    } catch (error) {
      console.warn(label || 'Schedule request failed', error);
      return { ok:false, error };
    }
  }
  function scheduleLoadErrorMessage(error){
    const text = `${clean(error?.message)} ${clean(error?.cause?.message)}`;
    if ((typeof navigator !== 'undefined' && navigator.onLine === false) || /failed to fetch|networkerror|load failed/i.test(text)) return (globalThis.PlatformLanguage?.text("scheduling","m_schedule_load_offline","The server could not be reached. Check your connection.") ?? "The server could not be reached. Check your connection.");
    if (/timed out/i.test(text)) return (globalThis.PlatformLanguage?.text("scheduling","m_schedule_load_slow","The server is taking too long to respond.") ?? "The server is taking too long to respond.");
    return (globalThis.PlatformLanguage?.text("scheduling","m_schedule_load_failed","The server could not return the schedule.") ?? "The server could not return the schedule.");
  }
  function scheduleLoadNoticeHtml(){
    const retry = `<button type="button" class="dash-load-retry" data-schedule-retry ${loading ? 'disabled aria-busy="true"' : ''}>${loading ? `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_retrying","Retrying…") ?? "Retrying…")}` : (globalThis.PlatformLanguage?.htmlText("scheduling","m_retry","Retry") ?? "Retry")}</button>`;
    if (!dataLoaded && scheduleLoadError) {
      return `<div class="dash-load-error" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><strong>${(globalThis.PlatformLanguage?.htmlText("scheduling","m_schedule_load_error","Couldn't load the schedule") ?? "Couldn't load the schedule")}</strong><span>${escapeHtml(scheduleLoadError)}</span>${retry}</div>`;
    }
    if (!scheduleRefreshFailedAt) return '';
    const shownAt = lastDataRefreshAt ? fmtTime(new Date(lastDataRefreshAt)) : '';
    return `<div class="dash-refresh-notice" role="status"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><span>${escapeHtml(shownAt ? `Couldn't refresh — showing the schedule as of ${shownAt}.` : "Couldn't refresh the schedule.")}</span>${retry}</div>`;
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
  /* A refresh redraws every chip, so one that lands between a press and the
   * drag threshold (the window focus handler fires on that very press when
   * focus was in the project window) would drop the drag. Refreshes wait
   * for the release instead. */
  let schedulePointerPressedAt = 0;
  let loadAfterRelease = false;
  let renderAfterRelease = false;
  function schedulePointerHeld(){
    return !!schedulePointerPressedAt && Date.now() - schedulePointerPressedAt < 30000;
  }
  document.addEventListener('pointerdown', (event) => {
    if (event.button === 0 && rootEl?.contains?.(event.target)) schedulePointerPressedAt = Date.now();
  }, true);
  const releaseSchedulePointer = () => {
    if (!schedulePointerPressedAt) return;
    schedulePointerPressedAt = 0;
    // After the drag's own pointerup handlers have committed it.
    setTimeout(() => {
      if (schedulePointerHeld()) return;
      if (loadAfterRelease) {
        loadAfterRelease = false;
        renderAfterRelease = false;
        loadData().catch(() => null);
      } else if (renderAfterRelease) {
        renderAfterRelease = false;
        render();
      }
    }, 0);
  };
  window.addEventListener('pointerup', releaseSchedulePointer, true);
  window.addEventListener('pointercancel', releaseSchedulePointer, true);
  async function loadData({ force = false } = {}){
    if (!rootEl) return;
    if (loading) {
      loadQueued = true;
      return;
    }
    if (!force && schedulePointerHeld()) {
      loadAfterRelease = true;
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
      // Every source is requested at once (the ones that need the scheduling
      // config right after it) under one deadline, so a slow server reports
      // "Couldn't refresh" after one wait, not the sum of them.
      const scheduleDeadline = Date.now() + 45000;
      // Same failure contract as projects: a failed list rejects, it never
      // reads as "no company items".
      const floatingPromise = settleScheduleSource(
        typeof Scheduling.listCalendarEvents === 'function'
          ? Promise.resolve().then(() => Scheduling.listCalendarEvents(id, { branch_id: branchId(), branchId: branchId() }))
          : (window.PlatformAPI?.calendarEvents?.list ? window.PlatformAPI.calendarEvents.list(id, { branch_id: branchId(), branchId: branchId() }) : Promise.resolve([])),
        'Dashboard floating events',
        scheduleDeadline
      );
      const [loadedSchedulingConfig, confirmationSettings, loadedDashboardConfig, loadedProjectConfig] = await Promise.all([
        settleValue(
          Scheduling.loadBranchConfig(id, branchId(), { ensureDefaults: true }),
          schedulingConfig || {},
          'Dashboard scheduling config'
        ),
        // Confirmation settings drive both the visibility gate and the editor
        // defaults; a failure here just leaves the feature invisible.
        window.PlatformAPI?.appointments?.settings && Scheduling.setConfirmationSettings
          ? settleValue(
            Promise.resolve().then(() => window.PlatformAPI.appointments.settings(id, branchId())).then((result) => result?.settings || {}),
            Scheduling.confirmationSettings?.() || {},
            'Appointment confirmation settings'
          )
          : Promise.resolve(null),
        settleValue(
          Dashboard.loadConfig(id, branchId(), { ensureDefaults: true }),
          dashboardConfig || Dashboard.normalizeConfig?.({}) || {},
          'Dashboard config'
        ),
        settleValue(
          window.Portal?.branchModules?.get
            ? window.Portal.branchModules.get('project_configuration')
            : window.PlatformAPI?.branchModules?.get?.(id, branchId(), 'project_configuration'),
          branchProjectConfig,
          'Scheduling project title configuration'
        )
      ]);
      schedulingConfig = loadedSchedulingConfig;
      if (confirmationSettings) Scheduling.setConfirmationSettings(confirmationSettings);
      dashboardConfig = loadedDashboardConfig;
      branchProjectConfig = normalizeProjectConfig(loadedProjectConfig?.data || loadedProjectConfig || {});
      // The org user directory is an admin list; sessions without user-admin
      // permission read people from the assignable-resources list below
      // instead of triggering a 403 on every load.
      const canListUsers = sessionHasPermission('manage_company_users|manage_company_user_permissions|manage_users|manage_sales_users');
      const usersPromise = canListUsers ? settleValue(
        Scheduling.listUsers(id, schedulingConfig),
        users,
        'Dashboard users'
      ) : Promise.resolve([]);
      const projectsPromise = settleScheduleSource(
        Promise.resolve().then(() => Scheduling.listProjects(id, schedulingConfig)).then(async (value) => {
          if (!Array.isArray(value)) throw new Error('Projects could not be read.');
          // The list helper rejects on failure (ScheduleSourceError). An older
          // helper turned a failure into "no projects": confirm an empty list
          // before showing an empty schedule.
          if (!value.length && typeof Scheduling.isScheduleSourceError !== 'function' && window.PlatformAPI?.projects?.list) {
            const check = await window.PlatformAPI.projects.list(id);
            const docs = check?.documents || check?.projects || check;
            if (!Array.isArray(docs) || docs.length) throw new Error('Projects could not be read.');
          }
          return value;
        }),
        'Dashboard projects',
        scheduleDeadline
      );
      // Schedule editors may read equipment types and the conflict mode too,
      // so reserved/down units are flagged before saving instead of by a 409.
      const canReadEquipment = sessionHasPermission('equipment.view|equipment.manage|equipment.service|manage_company_settings|manage_schedule');
      const [loadedUsers, projectsResult, loadedWorkforce, loadedWorkforceConfiguration, loadedEquipmentTypes, equipmentSettings, floatingResult, loadedScopeTemplates] = await Promise.all([
        usersPromise,
        projectsPromise,
        settleValue(
          window.PlatformAPI?.workforce?.assignableResources ? window.PlatformAPI.workforce.assignableResources(id, branchId()) : Promise.resolve({ resources:[] }),
          { resources:workforceResources, equipment_units:equipmentUnits },
          'Dashboard work resources'
        ),
        settleValue(
          window.PlatformAPI?.workforce?.configuration ? window.PlatformAPI.workforce.configuration(id, branchId()) : Promise.resolve({ configuration:{} }),
          { configuration:{ terminology:workforceTerminology } },
          'Dashboard workforce terminology'
        ),
        settleValue(
          equipmentSchedulingOn() && canReadEquipment && window.EquipmentAPI?.types ? window.EquipmentAPI.types(id) : Promise.resolve({ types:[] }),
          { types:equipmentTypes },
          'Dashboard equipment types'
        ),
        equipmentSchedulingOn() && canReadEquipment && !equipmentConflictMode && window.EquipmentAPI?.settings
          ? settleValue(window.EquipmentAPI.settings(id), null, 'Equipment settings')
          : Promise.resolve(null),
        floatingPromise,
        settleValue(
          window.PlatformAPI?.scopes?.list ? window.PlatformAPI.scopes.list(id, branchId(), { include_disabled:true, includeDisabled:true }) : Promise.resolve({ templates:[] }),
          { templates:scopeTemplates },
          'Dashboard scope scheduling rules'
        )
      ]);
      if (equipmentSettings) equipmentConflictMode = clean(equipmentSettings?.settings?.conflict_mode || equipmentSettings?.conflict_mode) || '';
      const loadedFloatingEvents = floatingResult.ok ? floatingResult.value : null;
      users = Array.isArray(loadedUsers) ? loadedUsers : [];
      if (!users.length && Array.isArray(loadedWorkforce?.users)) {
        users = loadedWorkforce.users
          .map((entry) => entry?.user && typeof entry.user === 'object'
            ? { ...entry.user, id:clean(entry.user.id || entry.id), ...(Array.isArray(entry.role_ids) && !Array.isArray(entry.user.role_ids) ? { role_ids:entry.role_ids } : {}) }
            : { id:clean(entry?.id), name:clean(entry?.name), status:clean(entry?.status), role_ids:Array.isArray(entry?.role_ids) ? entry.role_ids : [] })
          .filter((user) => user.id)
          .map((user) => (Scheduling.normalizeUser ? Scheduling.normalizeUser(user, schedulingConfig) : user));
      }
      const scheduleSourceFailure = !projectsResult.ok ? projectsResult.error : (!floatingResult.ok ? floatingResult.error : null);
      if (scheduleSourceFailure && !dataLoaded) {
        // Nothing good to show yet: an error state with Retry, never an
        // empty calendar that looks like "no work scheduled".
        scheduleLoadError = scheduleLoadErrorMessage(scheduleSourceFailure);
        lastLoadFailedAt = Date.now();
        return;
      }
      if (projectsResult.ok) projects = projectsResult.value;
      scheduleLoadError = '';
      scheduleRefreshFailedAt = scheduleSourceFailure ? Date.now() : 0;
      const workforceConfiguration = loadedWorkforceConfiguration?.configuration || loadedWorkforceConfiguration || loadedWorkforce?.configuration || {};
      workforceTerminology = workforceConfiguration?.terminology || workforceTerminology;
      workforceGroupKinds = Array.isArray(workforceConfiguration?.resource_group_kinds)
        ? workforceConfiguration.resource_group_kinds
        : (Array.isArray(loadedWorkforce?.configuration?.resource_group_kinds) ? loadedWorkforce.configuration.resource_group_kinds : workforceGroupKinds);
      workforceResources = normalizeWorkforceResources(loadedWorkforce, workforceGroupKinds);
      equipmentUnits = Array.isArray(loadedWorkforce?.equipment_units) ? loadedWorkforce.equipment_units : [];
      equipmentTypes = Array.isArray(loadedEquipmentTypes?.types) && loadedEquipmentTypes.types.length ? loadedEquipmentTypes.types : equipmentTypes;
      if (!equipmentTypes.length && equipmentUnits.length) {
        // Without equipment-admin access, the unit list still names each type.
        const seenTypes = new Map();
        equipmentUnits.forEach((unit) => {
          const typeId = clean(unit.type_id);
          if (typeId && !seenTypes.has(typeId)) seenTypes.set(typeId, { id:typeId, name:equipmentTypeLabel(unit, null), icon:clean(unit.icon) });
        });
        equipmentTypes = [...seenTypes.values()];
      }
      scopeTemplates = Array.isArray(loadedScopeTemplates?.templates) ? loadedScopeTemplates.templates : scopeTemplates;
      if (floatingResult.ok) {
        const loadedFloatingList = normalizeFloatingEventList(loadedFloatingEvents);
        floatingEvents = loadedFloatingEvents?.missing && !loadedFloatingList.length ? floatingEvents : loadedFloatingList;
      }
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
      lastLoadFailedAt = scheduleRefreshFailedAt ? Date.now() : 0;
      if (!scheduleRefreshFailedAt) lastDataRefreshAt = Date.now();
    } catch (error) {
      lastLoadFailedAt = Date.now();
      if (!dataLoaded) scheduleLoadError = scheduleLoadErrorMessage(error);
      else scheduleRefreshFailedAt = Date.now();
      // The error state / "Couldn't refresh" notice on screen reports it.
      console.warn('Scheduling load failed', error);
    } finally {
      loading = false;
      if (!scheduleLoadError) dataLoaded = true;
      if (schedulePointerHeld()) renderAfterRelease = true;
      else render();
      if (pendingRouteDay && dataLoaded) {
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
    if (mount._escapeHandler) document.removeEventListener('keydown', mount._escapeHandler);
    // Escape closes the topmost scheduling layer that has no handler of its
    // own: a quick assignee menu, the phone menus, then the phone tray.
    mount._escapeHandler = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const panel = rootEl?.closest?.('.fm-tabpanel');
      if (panel && !panel.classList.contains('active')) return;
      if (document.querySelector('.dash-event-popover') || document.querySelector('fm-date-time-picker') || document.querySelector('.fm-dialog-backdrop')) return;
      if (document.querySelector('.dash-assignee-popover')) {
        closeAssignmentMenu();
      } else if (mobileViewMenuOpen || mobileMonthMenuOpen || mobileScheduleMenuOpen) {
        mobileViewMenuOpen = false;
        mobileMonthMenuOpen = false;
        mobileScheduleMenuOpen = false;
        render();
      } else if (mobileTrayOpen) {
        closeMobileTray();
        render();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('keydown', mount._escapeHandler, true);
    if (!rootEl.__dayListBound) {
      // Month view: the date number opens that day's full list (day modal).
      rootEl.__dayListBound = true;
      const dayNumberFrom = (target) => eventCalendarMode() === 'month' && !['appointment_schedule','gantt'].includes(viewMode)
        ? target?.closest?.('#dashEventCalendarView .prs-day-num')
        : null;
      const openFromDayNumber = (event) => {
        const node = dayNumberFrom(event.target);
        const date = node?.closest?.('[data-prs-date]')?.dataset?.prsDate;
        if (!date) return;
        event.preventDefault();
        event.stopPropagation();
        // While placing, the date number is part of the day: a click there
        // places the waiting item on that day (the day list waits).
        const placingItem = placementWaitingItem();
        if (placingItem && placingItem.kind !== 'vehicle' && canEditSchedule() && event.type === 'click' && !placementSaveInFlight) {
          placeOnCalendarCell(node.closest('[data-prs-date]'));
          return;
        }
        openDayModal(`${date}T12:00:00`);
      };
      rootEl.addEventListener('pointerdown', (event) => { if (dayNumberFrom(event.target)) event.stopPropagation(); }, true);
      rootEl.addEventListener('click', openFromDayNumber, true);
      rootEl.addEventListener('keydown', (event) => {
        // An open day list owns the keyboard; Enter behind it never stacks a second one.
        if (activeDayModal?.element?.isConnected) return;
        if (event.key === 'Enter' || event.key === ' ') openFromDayNumber(event);
      }, true);
    }
    const route = window.Portal?.navigation?.read?.() || {};
    let restoredFromPreference = false;
    if (scheduleViewAllowed(route.scheduleView)) {
      viewMode = route.scheduleView;
      routeSpecifiedView = true;
    } else {
      // No view in the link: reopen the view this person used last.
      const remembered = readSchedulePref(SCHEDULE_VIEW_PREF_KEY);
      if (scheduleViewAllowed(remembered)) {
        viewMode = remembered;
        routeSpecifiedView = true;
        restoredFromPreference = true;
      }
    }
    const routeDateValue = parseRouteDate(route.date);
    if (routeDateValue) {
      anchorDate = routeDateValue;
      if (viewMode === 'gantt') pendingGanttScrollDate = { date:routeDateValue, fraction:0 };
    }
    const routeTypes = scheduleTypesFromRoute(route.scheduleType);
    const rememberedTypes = routeTypes ? null : scheduleTypesFromRoute(readSchedulePref(SCHEDULE_TYPES_PREF_KEY));
    if (routeTypes) applyScheduleTypes(routeTypes);
    else if (rememberedTypes) {
      applyScheduleTypes(rememberedTypes);
      restoredFromPreference = true;
    }
    // Only known filter kinds apply; an unknown scheduleGroup is ignored.
    breakdownMode = FILTER_TYPES[clean(route.scheduleGroup)] ? clean(route.scheduleGroup) : 'user';
    breakdownValue = !clean(route.scheduleGroup) || FILTER_TYPES[clean(route.scheduleGroup)] ? (clean(route.scheduleResource) || 'all') : 'all';
    pendingRouteDay = parseRouteDate(route.day) ? route.day : '';
    render();
    normalizeScheduleRoute(route);
    if (restoredFromPreference) syncScheduleRoute({ scheduleView:viewMode, date:routeDate(), scheduleType:scheduleTypeRouteValue() }, { history:'replace', source:'schedule-preferences', ownedKeys:['scheduleView','date','scheduleType'] });
    loadData();
  }

  function scheduleLoad(){
    if (loadTimer) return;
    loadTimer = setTimeout(() => {
      loadTimer = null;
      loadData().catch(() => null);
    }, 120);
  }
  /* Coming back through the left nav lands on bare ?tab=scheduling: put the
   * view/date/types on screen back into the URL so it matches. */
  function restoreScheduleRouteIfBare(){
    if (!rootEl) return;
    setTimeout(() => {
      const route = window.Portal?.navigation?.read?.() || {};
      if (route.tab !== 'scheduling' || clean(route.scheduleView)) return;
      syncScheduleRoute({ scheduleView:viewMode, date:routeDate(), scheduleType:scheduleTypeRouteValue() }, { history:'replace', source:'schedule-restore', ownedKeys:['scheduleView','date','scheduleType'] });
    }, 0);
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
      window.Portal.apps.registerPortalApp({ id: 'portal.scheduling', tabId: 'scheduling', title: (globalThis.PlatformLanguage?.text("scheduling","m_4249990706c50e","Scheduling") ?? "Scheduling"), icon: 'fa-calendar-days', order: 18, fullBleed: true, mount, onShow: () => { restoreScheduleRouteIfBare(); loadData(); } });
      window.Portal.tabs.renderTabs?.();
    }
  }
  window.Portal?.navigation?.registerHandler?.('scheduling-route', {
    priority:400,
    immediate:true,
    apply:async (route, context = {}) => {
      if (route.tab !== 'scheduling' || !rootEl) { rememberScheduleNavDepth(); return; }
      const bareRoute = !['scheduleView', 'date', 'scheduleType', 'day', 'scheduleGroup', 'scheduleResource'].some((key) => clean(route[key]));
      if (bareRoute) {
        // Returning through the left nav (?tab=scheduling): keep what is on
        // screen and put it back in the URL.
        activeDayModal?.close?.({ fromRoute:true });
        setTimeout(() => syncScheduleRoute({ scheduleView:viewMode, date:routeDate(), scheduleType:scheduleTypeRouteValue() }, { history:'replace', source:'schedule-restore', ownedKeys:['scheduleView','date','scheduleType'] }), 0);
        render();
        return;
      }
      const shownBefore = `${viewMode}|${routeDate(shownScheduleDate())}`;
      const routeViewValid = ['day','4day','week','month','appointment_schedule','gantt'].includes(route.scheduleView) && scheduleViewAllowed(route.scheduleView);
      const routeView = routeViewValid ? route.scheduleView : (clean(route.scheduleView) ? 'week' : viewMode);
      const nextRouteDate = parseRouteDate(route.date);
      // Back/Forward with unsaved edits in the editor asks BEFORE the
      // calendar moves; "Keep editing" puts the history back on the range
      // the editor belongs to and nothing else changes.
      if (context?.source === 'popstate' && `${routeView}|${routeDate(nextRouteDate || anchorDate)}` !== shownBefore && !(await confirmRouteLeavesEditor())) return;
      viewMode = routeView;
      if (routeViewValid) routeSpecifiedView = true;
      if (nextRouteDate) {
        // Back/Forward always scroll the Timeline to the entry's date (the
        // anchor alone can't tell whether the Timeline was scrolled since).
        if (viewMode === 'gantt' && (context?.source === 'popstate' || routeDate(nextRouteDate) !== routeDate(anchorDate))) {
          pendingGanttScrollDate = { date:nextRouteDate, fraction:0 };
          ganttRouteSyncHoldUntil = Date.now() + 1200;
        }
        anchorDate = nextRouteDate;
      }
      // An entry without scheduleType shows the remembered chips, exactly as
      // a reload of that entry would.
      applyScheduleTypes(scheduleTypesFromRoute(route.scheduleType) || scheduleTypesFromRoute(readSchedulePref(SCHEDULE_TYPES_PREF_KEY)) || SCHEDULE_TYPE_KEYS);
      breakdownMode = FILTER_TYPES[clean(route.scheduleGroup)] ? clean(route.scheduleGroup) : 'user';
      breakdownValue = !clean(route.scheduleGroup) || FILTER_TYPES[clean(route.scheduleGroup)] ? (clean(route.scheduleResource) || 'all') : 'all';
      const day = parseRouteDate(route.day) ? route.day : '';
      if (!day) activeDayModal?.close?.({ fromRoute:true });
      else if (loading) pendingRouteDay = day;
      else openDayModal(`${day}T12:00:00`, { fromRoute:true });
      render();
      rememberScheduleNavDepth();
      normalizeScheduleRoute(route);
      if (`${viewMode}|${routeDate(anchorDate)}` !== shownBefore) settleEditorAfterRouteChange().catch(() => null);
    }
  });
  document.addEventListener('keydown', placementEscapeHandler);
  /* Keep the schedule current without a manual reload: refetch when the tab
   * comes back into view or the window regains focus, and every couple of
   * minutes while it stays open and idle. Never while an editor is open or
   * a drag is running, so in-progress work is not disturbed. */
  function schedulingSurfaceIdle(){
    if (!rootEl?.isConnected || document.hidden) return false;
    const panel = rootEl.closest?.('.fm-tabpanel');
    if (panel && !panel.classList.contains('active')) return false;
    if (document.querySelector('.dash-event-popover,.dash-assignee-popover,.fm-dialog-backdrop,fm-date-time-picker')) return false;
    if (rootEl.querySelector('.prs-work-chip.dragging,.prs-work-chip.moving,.live-preview')) return false;
    // A first load that failed retries with the same triggers.
    return !loading && (dataLoaded || !!scheduleLoadError);
  }
  function refreshScheduleIfStale(maxAgeMs = 20000){
    if (!schedulingSurfaceIdle()) return;
    if (Date.now() - lastDataRefreshAt < maxAgeMs) return;
    scheduleLoad();
  }
  window.addEventListener('focus', () => refreshScheduleIfStale());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshScheduleIfStale(); });
  setInterval(() => refreshScheduleIfStale(110000), 30000);
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
    // A Month view made shorter keeps today's week in view (the reveal
    // leaves the scroll alone when that row already shows).
    if (rootEl && eventCalendarMode() === 'month') {
      clearTimeout(scrollMonthToToday._resizeTimer);
      scrollMonthToToday._resizeTimer = setTimeout(() => {
        const mount = rootEl?.querySelector('#dashEventCalendarView');
        if (!mount || eventCalendarMode() !== 'month') return;
        scrollMonthToToday._key = '';
        scrollMonthToToday(mount);
      }, 250);
    }
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
