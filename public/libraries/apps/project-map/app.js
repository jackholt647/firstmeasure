/* public/libraries/apps/project-map/app.js
 * Embeddable project map pane.
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

  const MAX_PINS_RESIDENTIAL = 5;
  const MAX_PINS_PER_STRUCTURE_REPORT = 10;
  const DEFAULT_US_MAP_CENTER = { lat: 39.8283, lng: -98.5795 };
  const DEFAULT_US_MAP_ZOOM = 4;
  const ICON_PATHS = {
    residential: 'M8 1.5L0.5 7.5H3V14h4v-4h2v4h4V7.5h2.5L8 1.5z',
    commercial: 'M3 0h10v16H3z M5 2.5h2v2H5z M9 2.5h2v2H9z M5 6.5h2v2H5z M9 6.5h2v2H9z M5 10.5h2v2H5z M9 10.5h2v2H9z M7 13.5h2v2.5H7z',
    multifamily: 'M0 6h4v10H0z M1 7.5h2v1.5H1z M1 10.5h2v1.5H1z M5 2h6v14H5z M6.5 3.5h1.2v1.2H6.5z M8.3 3.5h1.2v1.2H8.3z M6.5 6h1.2v1.2H6.5z M8.3 6h1.2v1.2H8.3z M6.5 8.5h1.2v1.2H6.5z M8.3 8.5h1.2v1.2H8.3z M6.5 11h1.2v1.2H6.5z M8.3 11h1.2v1.2H8.3z M12 6h4v10h-4z M13 7.5h2v1.5h-2z M13 10.5h2v1.5h-2z',
  };

  const state = {
    mounted: false,
    active: false,
    host: null,
    model: null,
    panelRoot: null,
    map: null,
    geocoder: null,
    maxZoomService: null,
    markers: [],
    forwardGeocoding: false,
    placeLoadGen: 0,
    mapExpandedManual: null,
    lastDefaultExpandedMap: false,
    geocodingAddressKey: '',
    lastGeocodedAddressKey: '',
    failedGeocodeAddressKey: '',
    syncingPins: false,
    markerSignature: '',
    focusedPinSignature: '',
    focusedLocation: null,
    focusedZoom: null,
    mapResizeFrame: 0,
    initRetryTimer: 0,
    deferredInitTimer: 0,
    renderRecoveryTimer: 0,
    renderRecoveryCount: 0,
    materialSummary: { loadedFor: '', loading: false, lists: [], orders: [], error: '' }
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

  function project(){
    if (state.host && typeof state.host.getProject === 'function') return state.host.getProject() || null;
    return state.model?.state?.activeBaseProject || window.activeBaseProject || {};
  }

  function selectedType(){
    return String(callHost('getSelectedType') || project()?.project_type || 'residential').trim() || 'residential';
  }

  function normalizedProjectType(type){
    return String(type || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function isPerStructureType(type){
    const normalized = normalizedProjectType(type);
    return normalized === 'commercial' || normalized === 'multifamily' || normalized === 'multi_family';
  }

  function maxPinsForType(type){
    const normalized = normalizedProjectType(type);
    if (normalized === 'residential') return MAX_PINS_RESIDENTIAL;
    if (isPerStructureType(normalized)) return MAX_PINS_PER_STRUCTURE_REPORT;
    return 0;
  }

  function pinLimitMessage(maxPins){
    return `Maximum of ${maxPins} pins per report. Remove a pin to place a new one.`;
  }

  function viewingExistingProject(){
    const hosted = callHost('isViewingExistingProject');
    return hosted !== undefined ? !!hosted : !!window.viewingExistingProject;
  }

  function reorderMeasurementProjectId(){
    return String(callHost('getReorderMeasurementProjectId') || window.reorderMeasurementProjectId || '').trim();
  }

  function hasSelectedAddons(){
    const hosted = callHost('hasSelectedAddons');
    if (hosted !== undefined) return !!hosted;
    return true;
  }

  function appFeatureEnabled(group, flag, fallback = false){
    const appFlags = Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (appFlags?.current?.()) {
      if (appFlags.has?.(group, flag)) return true;
      const value = appFlags.value?.(group, flag, undefined);
      return typeof value === 'boolean' ? value : fallback;
    }
    return fallback;
  }

  function hostEnabled(name, fallback = false){
    const hosted = callHost(name);
    return hosted === undefined ? fallback : !!hosted;
  }

  function materialsEnabled(){ return hostEnabled('materialsEnabled', appFeatureEnabled('platform', 'materials', false)); }
  function proposalsEnabled(){ return hostEnabled('proposalsEnabled', appFeatureEnabled('platform', 'proposals', false)); }
  function schedulingEnabled(){ return hostEnabled('schedulingEnabled', appFeatureEnabled('platform', 'scheduling', false)); }
  function reportsEnabled(){
    const hosted = callHost('reportsEnabled');
    if (hosted !== undefined) return !!hosted;
    return appFeatureEnabled('firstmeasure', 'report_orders', true);
  }

  function visibleOverviewCards(){
    return overviewCardData().filter((card) => {
      if (card.feature === 'materials') return materialsEnabled();
      if (card.feature === 'proposals') return proposalsEnabled();
      if (card.feature === 'reports') return reportsEnabled();
      if (card.feature === 'scheduling') return schedulingEnabled();
      return true;
    });
  }

  function shouldForceExpandedMap(){
    return visibleOverviewCards().length <= 1;
  }

  function shouldDefaultExpandedMap(){
    if (shouldForceExpandedMap()) return true;
    const hosted = callHost('shouldUseExpandedOverviewMap');
    if (hosted !== undefined) return !!hosted;
    return hasSelectedAddons() && !reportOrderState()?.ordered;
  }

  function overviewMapExpanded(){
    if (shouldForceExpandedMap()) return true;
    return state.mapExpandedManual == null ? shouldDefaultExpandedMap() : !!state.mapExpandedManual;
  }

  function scheduleMapResize(){
    if (state.mapResizeFrame) cancelAnimationFrame(state.mapResizeFrame);
    state.mapResizeFrame = requestAnimationFrame(() => {
      state.mapResizeFrame = 0;
      try { google?.maps?.event?.trigger(state.map, 'resize'); } catch (e) {}
    });
  }

  function applyOverviewMapMode(){
    const root = state.panelRoot || currentMapPanelRoot();
    const overview = root?.querySelector?.('[data-project-overview]');
    if (!overview) return;
    const forceExpanded = shouldForceExpandedMap();
    const defaultExpanded = shouldDefaultExpandedMap();
    if (forceExpanded) state.mapExpandedManual = null;
    if (defaultExpanded && !state.lastDefaultExpandedMap && state.mapExpandedManual === false) {
      state.mapExpandedManual = null;
    }
    state.lastDefaultExpandedMap = defaultExpanded;
    const expanded = overviewMapExpanded();
    overview.classList.toggle('is-map-expanded', expanded);
    overview.classList.toggle('is-map-only', forceExpanded);
    const toggle = overview.querySelector('[data-overview-map-toggle]');
    if (toggle) {
      toggle.hidden = forceExpanded;
      toggle.disabled = forceExpanded;
      toggle.setAttribute('aria-label', expanded ? 'Shrink map' : 'Expand map');
      toggle.innerHTML = expanded
        ? '<i class="fas fa-compress"></i><span>Shrink</span>'
        : '<i class="fas fa-expand"></i><span>Expand</span>';
    }
    scheduleMapResize();
  }

  function setOverviewMapExpanded(expanded, options = {}){
    if (shouldForceExpandedMap()) {
      state.mapExpandedManual = null;
      applyOverviewMapMode();
      return;
    }
    if (options.manual !== false) state.mapExpandedManual = !!expanded;
    applyOverviewMapMode();
  }

  function resetOverviewMapExpansion(){
    state.mapExpandedManual = null;
    applyOverviewMapMode();
  }

  function syncOverviewMapMode(){
    applyOverviewMapMode();
  }

  function cleanText(value){ return String(value ?? '').trim(); }

  function firstText(...values){
    for (const value of values) {
      if (value && typeof value === 'object') continue;
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }

  function arrayValue(...values){
    for (const value of values) {
      if (Array.isArray(value)) return value;
    }
    return [];
  }

  function orgId(){
    return cleanText(cfg.userOrgId || cfg.orgId || window.__APP?.userOrgId || window.__APP?.orgId);
  }

  function projectId(inputProject = project()){
    return firstText(inputProject?.platform_project_id, inputProject?.base_project_id, inputProject?.id);
  }

  function setActivePreviewTab(tab){
    callHost('setActivePreviewTab', tab);
  }

  function projectProposals(inputProject = project()){
    const hosted = callHost('getProposals');
    return arrayValue(hosted, inputProject?.proposals);
  }

  function projectEvents(inputProject = project()){
    return arrayValue(inputProject?.events, inputProject?.schedule_events, inputProject?.appointments);
  }

  function reportOrderState(){
    return callHost('getReportOrderState') || null;
  }

  function projectHasReportOrder(inputProject = project()){
    const measurement = inputProject?.measurement_project && typeof inputProject.measurement_project === 'object'
      ? inputProject.measurement_project
      : ((inputProject?.measurement && typeof inputProject.measurement === 'object') ? inputProject.measurement : {});
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    return !!(
      inputProject?.workflow_state === 'measurement_ordered'
      || measurement.id
      || measurement.project_id
      || measurement.folder
      || inputProject?.measurement_project_id
      || inputProject?.has_report
      || inputProject?.report_url
      || inputProject?.pdf_url
      || inputProject?.summary_url
      || inputProject?.xml_url
      || measurement.report_url
      || measurement.pdf_url
      || raw.report_url
      || raw.pdf_url
    );
  }

  function shouldShowPinPlacementHint(){
    return hasSelectedAddons() && !reportOrderState()?.ordered && !projectHasReportOrder();
  }

  function syncPinPlacementHint(){
    const hint = $('#rMapHint');
    if (!hint || hint.dataset.kind !== 'pin-placement') return;
    const show = shouldShowPinPlacementHint() && callHost('getActivePreviewTab') === 'map';
    hint.classList.toggle('visible', show);
    hint.style.display = show ? 'block' : 'none';
  }

  function setAddressSelected(value){
    callHost('setAddressSelected', !!value);
  }

  function setLocationConfirmed(value){
    callHost('setLocationConfirmed', !!value);
  }

  function invalidateReportExpediteOptions(){
    callHost('invalidateReportExpediteOptions');
  }

  function notifyPinsChanged({ persist = true } = {}){
    callHost('renderPinInfo');
    callHost('renderConfirm');
    callHost('renderWorkflowState');
    if (persist) callHost('autosaveSoon');
  }

  function injectOverviewCss(){
    const css = `
      .r-overview{height:100%;min-height:0;overflow:auto;background:#f3f6f9;color:#101828;padding:18px;box-sizing:border-box}
      .r-overview-shell{max-width:1320px;margin:0 auto;display:grid;grid-template-columns:minmax(360px,.92fr) minmax(420px,1.08fr);gap:16px;align-items:start}
      .r-overview-map-section,.r-overview-panel{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:8px;box-shadow:0 10px 28px rgba(15,23,42,.06);overflow:hidden}
      .r-overview-map-section{position:sticky;top:0;min-height:520px}
      .r-overview-map-head,.r-overview-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 15px;border-bottom:1px solid rgba(15,23,42,.08);background:#fff}
      .r-overview-map-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
      .r-overview-map-toggle{height:34px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#344054;padding:0 11px;display:inline-flex;align-items:center;justify-content:center;gap:7px;font-size:11px;font-weight:1000;cursor:pointer;box-shadow:0 8px 18px rgba(15,23,42,.08);transition:border-color .16s ease,color .16s ease,background .16s ease}
      .r-overview-map-toggle:hover{border-color:rgba(var(--primary-rgb,217,48,37),.28);color:var(--primary-readable,var(--primary,#d93025));background:#fff}
      .r-overview-kicker{display:block;font-size:10px;font-weight:1000;text-transform:uppercase;color:#667085;letter-spacing:.08em}
      .r-overview-title{display:block;margin-top:3px;font-size:15px;font-weight:1000;color:#101828;line-height:1.2}
      .r-overview-sub{margin-top:3px;font-size:12px;font-weight:850;color:#667085;line-height:1.35}
      .r-overview-map-frame{position:relative;height:456px;min-height:320px;background:#dbe3ec}
      .r-overview-map-frame #rMap{position:absolute;inset:0}
      .r-overview-map-frame #rMapHint{top:14px}
      .r-overview-panel{display:flex;flex-direction:column;min-height:520px}
      .r-overview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:12px}
      .r-overview-card{width:100%;border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;text-align:left;padding:12px;display:flex;flex-direction:column;gap:10px;min-height:138px;color:#344054;cursor:pointer;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}
      .r-overview-card:hover{border-color:rgba(var(--primary-rgb,217,48,37),.22);box-shadow:0 12px 24px rgba(15,23,42,.08);transform:translateY(-1px)}
      .r-overview-card[disabled]{cursor:default;transform:none;box-shadow:none}
      .r-overview-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
      .r-overview-card-title{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;font-weight:1000;color:#101828}
      .r-overview-card-title i{color:var(--primary-readable,var(--primary,#d93025));width:16px;text-align:center}
      .r-overview-count{height:24px;min-width:24px;padding:0 8px;border-radius:999px;background:#f2f4f7;color:#475467;font-size:11px;font-weight:1000;display:inline-flex;align-items:center;justify-content:center}
      .r-overview-card.has-items .r-overview-count{background:rgba(21,128,61,.10);color:#15803d}
      .r-overview-status{font-size:12px;font-weight:900;color:#667085;line-height:1.35}
      .r-overview-list{display:grid;gap:6px;margin-top:auto}
      .r-overview-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;font-size:11px;font-weight:850;color:#475467;min-width:0}
      .r-overview-row span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .r-overview-pill{border-radius:999px;background:#f2f4f7;color:#475467;padding:4px 7px;font-size:10px;font-weight:1000;text-transform:uppercase;white-space:nowrap}
      .r-overview-pill.good{background:#ecfdf3;color:#067647}
      .r-overview-pill.warn{background:#fffaeb;color:#93370d}
      .r-overview-pill.info{background:#eff8ff;color:#175cd3}
      .r-overview-empty{font-size:12px;font-weight:850;color:#98a2b3;margin-top:auto}
      .r-overview.is-map-expanded{height:100%;overflow:hidden;padding:0;background:#dbe3ec}
      .r-overview.is-map-expanded .r-overview-shell{max-width:none;height:100%;display:block}
      .r-overview.is-map-expanded .r-overview-map-section{position:relative;height:100%;min-height:0;border:0;border-radius:0;box-shadow:none;display:flex;flex-direction:column}
      .r-overview.is-map-expanded .r-overview-map-head{position:absolute;top:14px;left:14px;z-index:8;padding:0;border:0;background:transparent}
      .r-overview.is-map-expanded .r-overview-map-copy{display:none}
      .r-overview.is-map-expanded .r-overview-map-toggle{height:38px;border-radius:10px;background:rgba(255,255,255,.94);backdrop-filter:blur(12px)}
      .r-overview.is-map-expanded .r-overview-map-frame{height:100%;min-height:0;flex:1}
      .r-overview.is-map-expanded .r-overview-panel{display:none}
      .r-overview.is-map-only .r-overview-map-toggle{display:none}
      @media(max-width:980px){.r-overview-shell{grid-template-columns:1fr}.r-overview-map-section{position:relative}.r-overview-grid{grid-template-columns:1fr}.r-overview-map-frame{height:380px}}
    `;
    if (util.injectCSS) util.injectCSS('project-overview', css);
    else if (!document.getElementById('project-overview')) {
      const style = document.createElement('style');
      style.id = 'project-overview';
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  function panelHtml(){
    return `
      <div class="r-overview" data-project-overview>
        <div class="r-overview-shell">
          <section class="r-overview-map-section">
            <div class="r-overview-map-head">
              <div class="r-overview-map-copy">
                <span class="r-overview-kicker">Property</span>
                <strong class="r-overview-title">Map</strong>
                <div class="r-overview-sub" data-overview-address></div>
              </div>
              <div class="r-overview-map-actions">
                <button type="button" class="r-overview-map-toggle" data-overview-map-toggle aria-label="Expand map"><i class="fas fa-expand"></i><span>Expand</span></button>
              </div>
            </div>
            <div class="r-overview-map-frame">
              <div class="r-map-hint${shouldShowPinPlacementHint() ? ' visible' : ''}" id="rMapHint" data-kind="pin-placement"><i class="fas fa-crosshairs"></i> Click the map to place a pin. Click a pin to remove it.</div>
              <div id="rMap"></div>
            </div>
          </section>
          <section class="r-overview-panel">
            <div class="r-overview-panel-head">
              <div>
                <span class="r-overview-kicker">Project</span>
                <strong class="r-overview-title">Overview</strong>
                <div class="r-overview-sub">Current work, orders, documents, reports, and scheduling.</div>
              </div>
            </div>
            <div class="r-overview-grid" data-overview-summary></div>
          </section>
        </div>
      </div>`;
  }

  function currentMapPanelRoot(){
    return document.querySelector('#rOverlay .r-preview-panel[data-panel="map"]');
  }

  function resetDetachedMap(root = null){
    const mapDiv = state.map?.getDiv?.();
    if (!mapDiv || (mapDiv.isConnected && (!root || root.contains(mapDiv)))) return;
    state.markers.forEach((marker) => marker.setMap?.(null));
    state.markers = [];
    state.map = null;
    state.geocoder = null;
    state.maxZoomService = null;
  }

  function resolveRoot(context = {}){
    const explicitRoot = context.panelRoot || context.roots?.main || null;
    let root = explicitRoot || (state.panelRoot?.isConnected ? state.panelRoot : null);
    if (!root || root.isConnected === false) {
      root = currentMapPanelRoot() || root || (state.panelRoot?.isConnected ? state.panelRoot : null);
    }
    if (!root) return null;
    if (!root.querySelector?.('#rMap')) root.innerHTML = panelHtml();
    resetDetachedMap(root);
    return root;
  }

  function humanize(value, fallback = 'Unknown'){
    const text = cleanText(value);
    if (!text) return fallback;
    return text.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function dateLabel(value){
    const date = value instanceof Date ? value : new Date(value || '');
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function statusClass(status){
    const value = cleanText(status).toLowerCase();
    if (['complete', 'completed', 'ready', 'delivered', 'signed', 'viewed', 'sent'].includes(value)) return 'good';
    if (['pending', 'queued', 'processing', 'review', 'draft', 'scheduled', 'ordered', 'planning'].includes(value)) return value === 'draft' || value === 'planning' ? 'warn' : 'info';
    if (['cancelled', 'rejected', 'failed', 'void', 'discarded'].includes(value)) return 'warn';
    return '';
  }

  function proposalTitle(proposal = {}, index = 0){
    return firstText(proposal.title, proposal.name, proposal.proposal_title, `Proposal ${index + 1}`);
  }

  function proposalStatus(proposal = {}){
    return humanize(firstText(proposal.status, proposal.delivery_status, proposal.deliveryStatus), 'Draft');
  }

  function reportSummary(inputProject = project()){
    const order = reportOrderState();
    const measurement = inputProject?.measurement_project && typeof inputProject.measurement_project === 'object'
      ? inputProject.measurement_project
      : ((inputProject?.measurement && typeof inputProject.measurement === 'object') ? inputProject.measurement : {});
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    const status = firstText(order?.status, measurement.status, raw.status, manifest.status, inputProject?.status);
    const hasReport = !!(
      order?.ordered
      || measurement.id
      || measurement.project_id
      || measurement.folder
      || inputProject?.measurement_project_id
      || inputProject?.report_url
      || inputProject?.pdf_url
      || inputProject?.summary_url
      || inputProject?.xml_url
      || measurement.report_url
      || measurement.pdf_url
      || raw.report_url
      || raw.pdf_url
    );
    return {
      count: hasReport ? 1 : 0,
      status: hasReport ? humanize(status, order?.hasReadyReport ? 'Ready' : 'Ordered') : 'No reports ordered',
      rows: hasReport ? [{
        title: order?.includeInspection ? 'Standard + instant report' : 'Measurement report',
        status: humanize(status, order?.hasReadyReport ? 'Ready' : 'Ordered')
      }] : []
    };
  }

  function eventStart(event = {}){
    return window.PlatformScheduling?.eventStart?.(event) || new Date(event.start_at || event.start || event.scheduled_at || '');
  }

  function eventTypeText(event = {}){
    return cleanText(event.event_type_default_id || event.event_type_id || event.type_id || event.type || event.title).toLowerCase();
  }

  function isAppointmentEvent(event = {}){
    const type = eventTypeText(event);
    return type.includes('appointment') || type.includes('sales') || type.includes('consult');
  }

  function isWorkEvent(event = {}){
    const type = eventTypeText(event);
    return type.includes('work') || type.includes('production') || type.includes('install') || type.includes('crew') || type.includes('job');
  }

  function eventAssignedLabel(event = {}){
    const users = Array.isArray(event.assigned_users) ? event.assigned_users : [];
    if (users.length) return users.map((user) => firstText(user.name, user.email, user.id)).filter(Boolean).join(', ');
    const crew = firstText(event.assigned_crew_name, event.crew_name, event.assigned_crew?.name);
    if (crew) return crew;
    const ids = Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : [];
    return ids.length ? ids.join(', ') : 'Unassigned';
  }

  function scheduleRows(kind, inputProject = project()){
    const events = projectEvents(inputProject)
      .filter((event) => kind === 'work' ? isWorkEvent(event) : isAppointmentEvent(event))
      .sort((a, b) => eventStart(a) - eventStart(b));
    return events.map((event) => ({
      title: firstText(event.title, kind === 'work' ? 'Scheduled work' : 'Appointment'),
      status: dateLabel(eventStart(event)) || humanize(event.status, 'Scheduled'),
      meta: eventAssignedLabel(event)
    }));
  }

  function materialProjectFallback(inputProject = project()){
    const lists = arrayValue(inputProject?.material_lists, inputProject?.materials?.lists, inputProject?.materials);
    const orders = arrayValue(inputProject?.material_orders, inputProject?.materials?.orders);
    return { lists, orders };
  }

  async function loadMaterialSummary(){
    const pid = projectId();
    const oid = orgId();
    const key = `${oid}:${pid}`;
    if (!pid || !oid || !window.MaterialsAPI?.projects?.list) {
      if (state.materialSummary.loadedFor !== key) state.materialSummary = { loadedFor: key, loading: false, lists: [], orders: [], error: '' };
      return;
    }
    if (state.materialSummary.loading || state.materialSummary.loadedFor === key) return;
    state.materialSummary = { loadedFor: key, loading: true, lists: [], orders: [], error: '' };
    renderOverview();
    try {
      const result = await window.MaterialsAPI.projects.list(oid, pid);
      const lists = Array.isArray(result?.material_lists) ? result.material_lists : [];
      const orderLoader = window.MaterialsAPI?.lists?.orders;
      const orderGroups = orderLoader
        ? await Promise.all(lists.slice(0, 4).map((list) => (
          list?.id ? orderLoader(oid, list.id).catch(() => ({ orders: [] })) : Promise.resolve({ orders: [] })
        )))
        : [];
      const orders = orderGroups.flatMap((group) => Array.isArray(group?.orders) ? group.orders : []);
      state.materialSummary = { loadedFor: key, loading: false, lists, orders, error: '' };
    } catch (error) {
      state.materialSummary = { loadedFor: key, loading: false, lists: [], orders: [], error: error?.message || 'Could not load materials.' };
    }
    renderOverview();
  }

  function materialSummary(inputProject = project()){
    const fallback = materialProjectFallback(inputProject);
    const key = `${orgId()}:${projectId(inputProject)}`;
    const useLoaded = state.materialSummary.loadedFor === key;
    const lists = useLoaded && state.materialSummary.lists.length ? state.materialSummary.lists : fallback.lists;
    const orders = useLoaded && state.materialSummary.orders.length ? state.materialSummary.orders : fallback.orders;
    const rows = orders.slice(0, 3).map((order) => ({
      title: firstText(order.title, order.vendor?.name, 'Material order'),
      status: humanize(firstText(order.delivery_status, order.status), 'Ordered')
    }));
    if (!rows.length && lists.length) {
      rows.push(...lists.slice(0, 2).map((list) => ({
        title: firstText(list.title, 'Material list'),
        status: humanize(firstText(list.status, list.delivery_status), 'Planning')
      })));
    }
    return {
      count: orders.length || lists.length,
      loading: useLoaded && state.materialSummary.loading,
      status: useLoaded && state.materialSummary.loading
        ? 'Checking material orders'
        : (orders.length ? `${orders.length} material order${orders.length === 1 ? '' : 's'}` : (lists.length ? 'Materials started' : 'No material orders')),
      rows
    };
  }

  function summaryCard({ tab, icon, title, count, status, rows = [], empty = '' } = {}){
    const hasItems = Number(count || 0) > 0;
    const rowHtml = rows.slice(0, 3).map((row) => `
      <div class="r-overview-row">
        <span>${escapeHtml(row.title || '')}${row.meta ? ` - ${escapeHtml(row.meta)}` : ''}</span>
        <em class="r-overview-pill ${escapeHtml(statusClass(row.status))}">${escapeHtml(row.status || '')}</em>
      </div>
    `).join('');
    return `
      <button type="button" class="r-overview-card ${hasItems ? 'has-items' : ''}" data-overview-tab="${escapeHtml(tab || '')}">
        <div class="r-overview-card-head">
          <div class="r-overview-card-title"><i class="fas ${escapeHtml(icon || 'fa-circle-info')}"></i><span>${escapeHtml(title || '')}</span></div>
          <span class="r-overview-count">${escapeHtml(String(count || 0))}</span>
        </div>
        <div class="r-overview-status">${escapeHtml(status || '')}</div>
        ${rowHtml ? `<div class="r-overview-list">${rowHtml}</div>` : `<div class="r-overview-empty">${escapeHtml(empty || 'Nothing yet')}</div>`}
      </button>
    `;
  }

  function overviewCardData(){
    const current = project() || {};
    const proposals = projectProposals(current);
    const reports = reportSummary(current);
    const materials = materialSummary(current);
    const appointments = scheduleRows('appointment', current);
    const work = scheduleRows('work', current);
    return [
      {
        feature: 'materials',
        tab: 'materials',
        icon: 'fa-truck-ramp-box',
        title: 'Materials',
        count: materials.count,
        status: materials.status,
        rows: materials.rows,
        empty: 'No material orders'
      },
      {
        feature: 'proposals',
        tab: 'proposal',
        icon: 'fa-file-signature',
        title: 'Proposals',
        count: proposals.length,
        status: proposals.length ? `${proposals.length} proposal${proposals.length === 1 ? '' : 's'} saved` : 'No proposals',
        rows: proposals.slice(0, 3).map((proposal, index) => ({ title: proposalTitle(proposal, index), status: proposalStatus(proposal) })),
        empty: 'No proposals'
      },
      {
        feature: 'reports',
        tab: 'measurements',
        icon: 'fa-ruler-combined',
        title: 'Reports',
        count: reports.count,
        status: reports.status,
        rows: reports.rows,
        empty: 'No measurements or reports'
      },
      {
        feature: 'scheduling',
        tab: 'schedule',
        icon: 'fa-calendar-check',
        title: 'Appointments',
        count: appointments.length,
        status: appointments.length ? `${appointments.length} scheduled appointment${appointments.length === 1 ? '' : 's'}` : 'No appointments scheduled',
        rows: appointments,
        empty: 'No appointments scheduled'
      },
      {
        feature: 'scheduling',
        tab: 'schedule',
        icon: 'fa-helmet-safety',
        title: 'Scheduled Work',
        count: work.length,
        status: work.length ? `${work.length} work event${work.length === 1 ? '' : 's'} scheduled` : 'No work scheduled',
        rows: work,
        empty: 'No work scheduled'
      }
    ];
  }

  function overviewCards(){
    return visibleOverviewCards().map(summaryCard).join('');
  }

  function bindOverview(root){
    if (!root || root.__overviewBound) return;
    root.__overviewBound = true;
    root.addEventListener('click', (event) => {
      const toggle = event.target.closest?.('[data-overview-map-toggle]');
      if (toggle) {
        event.preventDefault();
        event.stopPropagation();
        setOverviewMapExpanded(!overviewMapExpanded());
        return;
      }
      const card = event.target.closest?.('[data-overview-tab]');
      const tab = card?.dataset?.overviewTab || '';
      if (!tab) return;
      setActivePreviewTab(tab);
    });
  }

  function renderOverview(){
    const root = state.panelRoot?.isConnected ? state.panelRoot : currentMapPanelRoot();
    if (!root) return;
    const summary = root.querySelector('[data-overview-summary]');
    const address = root.querySelector('[data-overview-address]');
    const current = project() || {};
    if (address) address.textContent = firstText(current.address, current.project_address, current.customer_address, 'No address yet');
    if (summary) summary.innerHTML = overviewCards();
    bindOverview(root);
    applyOverviewMapMode();
  }

  function googleMapsReady(){
    return !!(window.google?.maps?.Map && window.google?.maps?.Geocoder);
  }

  function buildPinIcon(options = {}){
    const type = selectedType();
    const iconPath = ICON_PATHS[type] || ICON_PATHS.residential;
    const fill = options.fill || '#d93025';
    const stroke = options.stroke || '#fff';
    const glyph = options.glyph || '#fff';
    const opacity = options.opacity == null ? 1 : Number(options.opacity) || 1;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="42" height="56" viewBox="0 0 42 56">
        <defs><filter id="ds" x="-20%" y="-10%" width="140%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000" flood-opacity="0.35"/></filter></defs>
        <path d="M21 2C10.507 2 2 10.507 2 21c0 7.35 4.2 14.7 10.5 21 2.1 2.1 4.2 4.2 5.6 6.3.7.7 1.4 1.4 1.9 2.1.2.3.5.6.7.9.1-.1.2-.3.3-.5.2-.3.5-.6.7-.9.5-.7 1.2-1.4 1.9-2.1 1.4-2.1 3.5-4.2 5.6-6.3C35.8 35.7 40 28.35 40 21 40 10.507 31.493 2 21 2z" fill="${fill}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="2.5" filter="url(#ds)"/>
        <circle cx="21" cy="20" r="13" fill="rgba(255,255,255,0.22)"/>
        <g transform="translate(13,12)"><path d="${iconPath}" fill="${glyph}" fill-rule="evenodd"/></g>
      </svg>`;
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg.trim());
  }

  function refreshMarkerIcons(){
    if (!window.google?.maps) return;
    const iconData = { url: buildPinIcon(), scaledSize: new google.maps.Size(42, 56), anchor: new google.maps.Point(21, 54) };
    state.markers.forEach((marker) => marker.setIcon(iconData));
  }

  function clearAllPins(options = {}){
    state.markers.forEach((marker) => marker.setMap(null));
    state.markers = [];
    state.markerSignature = '';
    state.focusedPinSignature = '';
    state.focusedLocation = null;
    state.focusedZoom = null;
    invalidateReportExpediteOptions();
    if (!options.silent) notifyPinsChanged();
  }

  function removePin(marker){
    marker.setMap(null);
    state.markers = state.markers.filter((item) => item !== marker);
    state.markerSignature = pinsSignature(getMarkersData());
    invalidateReportExpediteOptions();
    setLocationConfirmed(false);
    notifyPinsChanged();
  }

  function addPin(latLng, draggable = true, options = {}){
    if (!state.map || !window.google?.maps) return null;
    const type = normalizedProjectType(selectedType());
    const maxPins = maxPinsForType(type);
    if (!options.silent && maxPins && state.markers.length >= maxPins) {
      callHost('showStructurePinLimitNotice', maxPins) || showToast('Pin limit', pinLimitMessage(maxPins), false);
      return null;
    }
    const marker = new google.maps.Marker({
      map: state.map,
      position: latLng,
      draggable,
      icon: { url: buildPinIcon(), scaledSize: new google.maps.Size(42, 56), anchor: new google.maps.Point(21, 54) },
      title: 'Click to remove. Drag to reposition.',
    });
    marker.addListener('click', () => removePin(marker));
    marker.addListener('dragend', () => {
      state.markerSignature = pinsSignature(getMarkersData());
      setLocationConfirmed(false);
      callHost('renderConfirm');
      callHost('renderWorkflowState');
      callHost('autosaveSoon');
    });
    state.markers.push(marker);
    state.markerSignature = pinsSignature(getMarkersData());
    invalidateReportExpediteOptions();
    if (!options.silent && !state.syncingPins) notifyPinsChanged();
    return marker;
  }

  function getMarkersData(){
    return state.markers.map((marker) => {
      const point = marker.getPosition();
      return { lat: point.lat(), lng: point.lng() };
    });
  }

  function pinsSignature(pins = []){
    return (Array.isArray(pins) ? pins : [])
      .map((pin) => {
        const lat = finiteCoord(pin?.lat ?? pin?.latitude);
        const lng = finiteCoord(pin?.lng ?? pin?.longitude);
        return lat != null && lng != null ? `${lat.toFixed(7)},${lng.toFixed(7)}` : '';
      })
      .filter(Boolean)
      .join('|');
  }

  function finiteCoord(value){
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function isPlaceholderCoord(lat, lng){
    return lat === 0 && lng === 0;
  }

  function validProjectCoord(lat, lng){
    return lat != null && lng != null && !isPlaceholderCoord(lat, lng);
  }

  function normalizeProjectPins(inputProject = {}){
    const measurement = (inputProject.measurement_project && typeof inputProject.measurement_project === 'object')
      ? inputProject.measurement_project
      : ((inputProject.measurement && typeof inputProject.measurement === 'object') ? inputProject.measurement : {});
    const measurementRaw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    const measurementManifest = (measurement.manifest && typeof measurement.manifest === 'object')
      ? measurement.manifest
      : ((measurementRaw.manifest && typeof measurementRaw.manifest === 'object') ? measurementRaw.manifest : {});
    const pinCandidates = [
      inputProject.pins,
      measurement.pins,
      measurementManifest.pins,
      measurementRaw.pins
    ];
    const rawPins = pinCandidates.find((pins) => Array.isArray(pins) && pins.length)
      || (() => {
        let emptyPins = null;
        for (const pins of pinCandidates) {
          if (Array.isArray(pins)) {
            if (pins.length) return pins;
            if (!emptyPins) emptyPins = pins;
            continue;
          }
          try {
            const parsed = JSON.parse(String(pins || '[]'));
            if (Array.isArray(parsed)) {
              if (parsed.length) return parsed;
              if (!emptyPins) emptyPins = parsed;
            }
          } catch (e) {}
        }
        return emptyPins || [];
      })();
    const pins = rawPins.map((pin) => {
      const lat = finiteCoord(pin?.lat ?? pin?.latitude);
      const lng = finiteCoord(pin?.lng ?? pin?.longitude);
      return validProjectCoord(lat, lng) ? { lat, lng } : null;
    }).filter(Boolean);
    const lat = finiteCoord(inputProject.lat ?? inputProject.latitude ?? measurement.lat ?? measurement.latitude ?? measurementManifest.lat ?? measurementManifest.latitude ?? measurementRaw.lat ?? measurementRaw.latitude);
    const lng = finiteCoord(inputProject.lng ?? inputProject.longitude ?? measurement.lng ?? measurement.longitude ?? measurementManifest.lng ?? measurementManifest.longitude ?? measurementRaw.lng ?? measurementRaw.longitude);
    if (!pins.length && validProjectCoord(lat, lng)) pins.push({ lat, lng });
    return pins;
  }

  function syncProjectPins(pins = []){
    const signature = pinsSignature(pins);
    if (signature && signature === state.markerSignature && state.markers.length === pins.length) return false;
    try {
      state.syncingPins = true;
      clearAllPins({ silent: true });
      pins.forEach((pin) => addPin(pin, true, { silent: true }));
      state.markerSignature = signature;
    } finally {
      state.syncingPins = false;
    }
    return true;
  }

  function setCoords(lat, lng, custom){
    const latInput = $('#rLat');
    const lngInput = $('#rLng');
    const customInput = $('#rCustom');
    if (latInput) latInput.value = String(lat);
    if (lngInput) lngInput.value = String(lng);
    if (customInput) customInput.value = custom ? '1' : '0';
  }

  function parseAddressComponents(components){
    const out = { street_number: '', route: '', city: '', state: '', state_short: '', zip: '', country: '' };
    (components || []).forEach((item) => {
      if (item.types?.includes('street_number')) out.street_number = item.long_name;
      if (item.types?.includes('route')) out.route = item.long_name;
      if (item.types?.includes('locality')) out.city = item.long_name;
      if (item.types?.includes('administrative_area_level_1')) {
        out.state = item.long_name;
        out.state_short = item.short_name;
      }
      if (item.types?.includes('postal_code')) out.zip = item.long_name;
    });
    return out;
  }

  function reverseGeocode(latLng){
    if (!state.geocoder) state.geocoder = new google.maps.Geocoder();
    const input = $('#rAddress');
    input?.classList.add('loading');
    state.geocoder.geocode({ location: latLng }, (results, status) => {
      input?.classList.remove('loading');
      if (status === 'OK' && results && results[0]) {
        const place = results[0];
        if (input) input.value = place.formatted_address || '';
        if (place.address_components && $('#rComps')) $('#rComps').value = JSON.stringify(parseAddressComponents(place.address_components));
      } else if (input) {
        input.value = `${latLng.lat().toFixed(6)}, ${latLng.lng().toFixed(6)}`;
      }
      setAddressSelected(true);
      callHost('setTypePickerExpanded', false);
      setCoords(latLng.lat(), latLng.lng(), true);
      setLocationConfirmed(false);
      callHost('persistProject');
      callHost('renderConfirm');
      callHost('renderWorkflowState');
      callHost('revealInLeftColumnIfBelow', '#rStepType');
      callHost('autosaveSoon');
    });
  }

  function loadPlaceResult(location, addressComponents, formattedAddress){
    state.placeLoadGen += 1;
    clearTimeout(state.initRetryTimer);
    clearTimeout(state.deferredInitTimer);
    state.initRetryTimer = 0;
    state.deferredInitTimer = 0;
    clearAllPins();
    if (addressComponents && $('#rComps')) $('#rComps').value = JSON.stringify(parseAddressComponents(addressComponents));
    if (formattedAddress && $('#rAddress')) $('#rAddress').value = formattedAddress;
    setAddressSelected(true);
    callHost('setTypePickerExpanded', false);
    setLocationConfirmed(false);
    addPin(location, true);
    setCoords(location.lat(), location.lng(), false);
    state.focusedPinSignature = state.markerSignature;
    focusMapOnLocation(location, viewingExistingProject() ? 18 : 20);
    callHost('persistProject');
    callHost('renderConfirm');
    callHost('renderWorkflowState');
    callHost('revealInLeftColumnIfBelow', '#rStepType');
    callHost('autosaveSoon');
  }

  function forwardGeocode(addressText){
    if (!addressText || state.forwardGeocoding) return;
    if (!state.geocoder) state.geocoder = new google.maps.Geocoder();
    state.forwardGeocoding = true;
    const input = $('#rAddress');
    input?.classList.add('loading');
    state.geocoder.geocode({ address: addressText }, (results, status) => {
      input?.classList.remove('loading');
      state.forwardGeocoding = false;
      if (status === 'OK' && results && results[0]) {
        const best = results[0];
        loadPlaceResult(best.geometry.location, best.address_components, best.formatted_address);
      } else {
        showToast('Address not found', 'Could not locate that address. Try being more specific.', false);
      }
    });
  }

  function latLngLiteral(point){
    if (!point) return null;
    if (typeof point.lat === 'function' && typeof point.lng === 'function') return { lat: point.lat(), lng: point.lng() };
    const lat = finiteCoord(point.lat ?? point.latitude);
    const lng = finiteCoord(point.lng ?? point.longitude);
    return lat != null && lng != null ? { lat, lng } : null;
  }

  function setSafeMapZoom(point, desiredZoom, after){
    if (!state.map) return;
    const location = latLngLiteral(point);
    const maxDesiredZoom = viewingExistingProject() ? 18 : 20;
    const targetZoom = Math.min(Number(desiredZoom) || maxDesiredZoom, maxDesiredZoom);
    const fallbackZoom = Math.min(targetZoom, maxDesiredZoom);
    const finish = (zoom) => {
      state.map.setZoom(Math.max(4, Math.min(Number(zoom) || fallbackZoom, targetZoom)));
      if (typeof after === 'function') after();
    };
    if (!location || !window.google?.maps?.MaxZoomService) {
      finish(fallbackZoom);
      return;
    }
    state.maxZoomService = state.maxZoomService || new google.maps.MaxZoomService();
    state.maxZoomService.getMaxZoomAtLatLng(location, (result) => {
      const status = String(result?.status || '').toUpperCase();
      const maxZoom = status === 'OK' && Number.isFinite(Number(result?.zoom)) ? Number(result.zoom) : fallbackZoom;
      finish(Math.min(targetZoom, maxZoom));
    });
  }

  function focusMapOnLocation(point, desiredZoom = 20){
    if (!state.map) return;
    const location = latLngLiteral(point);
    if (!location) return;
    state.focusedLocation = location;
    state.focusedZoom = desiredZoom;
    const applyFocus = () => {
      if (!state.map) return;
      try { google?.maps?.event?.trigger(state.map, 'resize'); } catch (e) {}
      state.map.setMapTypeId('hybrid');
      state.map.setTilt(0);
      state.map.setHeading(0);
      state.map.setCenter(location);
      setSafeMapZoom(location, desiredZoom);
    };
    applyFocus();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(applyFocus);
    setTimeout(applyFocus, 180);
  }

  function hasLiveLocationSelection(){
    return !!callHost('getAddressSelected') || !!cleanText($('#rAddress')?.value);
  }

  function focusMapOnLiveSelection(){
    const pins = getMarkersData();
    if (pins.length) {
      fitMapToPins(pins);
      state.focusedPinSignature = state.markerSignature;
      return true;
    }
    if (!hasLiveLocationSelection()) return false;
    if (state.focusedLocation) {
      focusMapOnLocation(state.focusedLocation, state.focusedZoom || (viewingExistingProject() ? 18 : 20));
      return true;
    }
    const lat = finiteCoord($('#rLat')?.value);
    const lng = finiteCoord($('#rLng')?.value);
    if (validProjectCoord(lat, lng)) {
      focusMapOnLocation({ lat, lng }, viewingExistingProject() ? 18 : 20);
      return true;
    }
    return false;
  }

  function applyDefaultMapView(){
    if (!state.map) return;
    state.map.setTilt(0);
    state.map.setHeading(0);
    state.map.setCenter(DEFAULT_US_MAP_CENTER);
    state.map.setZoom(DEFAULT_US_MAP_ZOOM);
    state.map.setMapTypeId('satellite');
    applyMapControlsForMode();
  }

  function applyMapControlsForMode(){
    if (!state.map) return;
    state.map.setOptions({
      zoomControl: true,
      rotateControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      cameraControl: false,
      mapTypeControl: false,
      panControl: false
    });
  }

  function fitMapToPins(pins){
    if (!state.map || !pins.length) return;
    applyMapControlsForMode();
    state.map.setMapTypeId('hybrid');
    state.map.setTilt(viewingExistingProject() ? 45 : 0);
    state.map.setHeading(0);
    if (pins.length > 1) {
      const bounds = new google.maps.LatLngBounds();
      pins.forEach((pin) => bounds.extend(pin));
      state.map.fitBounds(bounds, 70);
      if (viewingExistingProject()) {
        setTimeout(() => {
          try {
            applyMapControlsForMode();
            state.map.setTilt(45);
            setSafeMapZoom(pins[0], state.map.getZoom() || 18);
          } catch (e) {}
        }, 120);
      }
      return;
    }
    focusMapOnLocation(pins[0], viewingExistingProject() ? 18 : 20);
    if (viewingExistingProject()) {
      try {
        applyMapControlsForMode();
        setTimeout(() => {
          try {
            state.map.setTilt(45);
            state.map.setHeading(0);
          } catch (e) {}
        }, 120);
      } catch (e) {}
    }
  }

  function focusMapOnProject(inputProject){
    const current = inputProject || project();
    if (!state.map || !current) return false;
    const pins = normalizeProjectPins(current);
    if (pins.length) {
      const signature = pinsSignature(pins);
      const changed = syncProjectPins(pins);
      setCoords(pins[0].lat, pins[0].lng, pins.length > 0);
      if (changed || state.focusedPinSignature !== signature) {
        fitMapToPins(pins);
        state.focusedPinSignature = signature;
      }
      if (current.address) setAddressSelected(true);
      if (viewingExistingProject() || reorderMeasurementProjectId()) setLocationConfirmed(true);
      callHost('renderPinInfo');
      callHost('renderConfirm');
      return true;
    }

    const address = String(current.address || '').trim();
    if (!address || !window.google?.maps) return false;
    const addressKey = `${projectId(current) || 'project'}::${address}`;
    if (state.lastGeocodedAddressKey === addressKey) return true;
    if (state.geocodingAddressKey === addressKey) return true;
    if (state.failedGeocodeAddressKey === addressKey) return false;
    if (!state.geocoder) state.geocoder = new google.maps.Geocoder();
    state.geocodingAddressKey = addressKey;
    state.forwardGeocoding = true;
    $('#rAddress')?.classList.add('loading');
    state.geocoder.geocode({ address }, (results, status) => {
      $('#rAddress')?.classList.remove('loading');
      state.forwardGeocoding = false;
      state.geocodingAddressKey = '';
      if (status !== 'OK' || !results?.[0]?.geometry?.location) {
        state.failedGeocodeAddressKey = addressKey;
        return;
      }
      state.lastGeocodedAddressKey = addressKey;
      state.failedGeocodeAddressKey = '';
      const best = results[0];
      try {
        state.syncingPins = true;
        const pin = { lat: best.geometry.location.lat(), lng: best.geometry.location.lng() };
        syncProjectPins([pin]);
      } finally {
        state.syncingPins = false;
      }
      setCoords(best.geometry.location.lat(), best.geometry.location.lng(), false);
      setAddressSelected(true);
      state.focusedPinSignature = state.markerSignature;
      focusMapOnLocation(best.geometry.location, viewingExistingProject() ? 18 : 20);
      if (viewingExistingProject()) {
        try {
          applyMapControlsForMode();
          state.map.setMapTypeId('hybrid');
          state.map.setTilt(45);
          state.map.setHeading(0);
        } catch (e) {}
      }
      setLocationConfirmed(true);
      callHost('renderConfirm');
      callHost('renderWorkflowState');
    });
    return true;
  }

  function setMapHint(message){
    const hint = $('#rMapHint');
    if (!hint || !message) return;
    hint.dataset.kind = 'message';
    hint.classList.add('visible');
    hint.style.display = callHost('getActivePreviewTab') === 'map' ? 'block' : 'none';
    hint.innerHTML = `<i class="fas fa-location-dot"></i> ${escapeHtml(message)}`;
  }

  function initMapOnce(){
    const root = resolveRoot();
    if (state.map) return true;
    const mapEl = root?.querySelector?.('#rMap');
    const input = document.getElementById('rAddress');
    if (!mapEl || !googleMapsReady()) {
      return false;
    }
    try {
      state.map = new google.maps.Map(mapEl, {
        center: DEFAULT_US_MAP_CENTER,
        zoom: DEFAULT_US_MAP_ZOOM,
        mapTypeId: 'satellite',
        tilt: 0,
        heading: 0,
        mapTypeControl: false,
        streetViewControl: false,
        rotateControl: false,
        fullscreenControl: false,
        cameraControl: false,
        panControl: false,
        gestureHandling: 'greedy',
      });
    } catch (error) {
      setMapHint('Google Maps could not initialize. Check the Maps API key and allowed referrers.');
      console.warn('Google Maps initialization failed', error);
      return false;
    }
    applyMapControlsForMode();
    state.map.addListener('click', (event) => {
      if (!hasSelectedAddons()) return;
      if (!callHost('getAddressSelected')) {
        if (!addPin(event.latLng, true)) return;
        setCoords(event.latLng.lat(), event.latLng.lng(), true);
        state.map.setCenter(event.latLng);
        if (state.map.getZoom() < 18) setSafeMapZoom(event.latLng, 20);
        state.map.setMapTypeId('hybrid');
        applyMapControlsForMode();
        state.map.setTilt(0);
        reverseGeocode(event.latLng);
        setLocationConfirmed(false);
        callHost('renderWorkflowState');
        return;
      }
      if (!addPin(event.latLng, true)) return;
      setCoords(event.latLng.lat(), event.latLng.lng(), true);
      setLocationConfirmed(false);
      callHost('renderWorkflowState');
    });

    if (input && window.google?.maps?.places?.Autocomplete) {
      const ac = new google.maps.places.Autocomplete(input, { fields: ['formatted_address', 'geometry', 'address_components'], strictBounds: false });
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const text = (input.value || '').trim();
        if (!text) return;
        const genBefore = state.placeLoadGen;
        setTimeout(() => { if (state.placeLoadGen === genBefore) forwardGeocode(text); }, 220);
      });

      ac.addListener('place_changed', () => {
        const place = ac.getPlace();
        if (!place?.geometry?.location) {
          const text = (input.value || '').trim();
          if (text) forwardGeocode(text);
          return;
        }
        loadPlaceResult(place.geometry.location, place.address_components, place.formatted_address);
      });
    }
    return true;
  }

  function initializeMapView(inputProject = null, attempt = 0){
    clearTimeout(state.initRetryTimer);
    state.initRetryTimer = 0;
    initMapOnce();
    if (!state.map && attempt < 80) {
      state.initRetryTimer = setTimeout(() => initializeMapView(inputProject, attempt + 1), 150);
      return;
    }
    if (!state.map) return;
    try { google?.maps?.event?.trigger(state.map, 'resize'); } catch (e) {}
    const current = inputProject || project();
    if (current && focusMapOnProject(current)) {
      verifyVisibleMapRendered(current);
      return;
    }
    if (focusMapOnLiveSelection()) {
      verifyVisibleMapRendered(current);
      return;
    }
    applyDefaultMapView();
    verifyVisibleMapRendered(inputProject || current);
  }

  function visibleMapElement(){
    const root = state.panelRoot?.isConnected ? state.panelRoot : currentMapPanelRoot();
    return root?.querySelector?.('#rMap') || null;
  }

  function verifyVisibleMapRendered(inputProject = null){
    clearTimeout(state.renderRecoveryTimer);
    state.renderRecoveryTimer = setTimeout(() => {
      state.renderRecoveryTimer = 0;
      const mapEl = visibleMapElement();
      if (!mapEl || !state.map) return;
      const rect = mapEl.getBoundingClientRect?.();
      if (!rect || rect.width < 20 || rect.height < 20) {
        if (state.renderRecoveryCount < 3) {
          state.renderRecoveryCount += 1;
          verifyVisibleMapRendered(inputProject);
        }
        return;
      }
      const mapDiv = state.map.getDiv?.();
      const rendered = mapEl.contains(mapDiv) && !!mapEl.querySelector('.gm-style');
      if (rendered) {
        state.renderRecoveryCount = 0;
        try { google?.maps?.event?.trigger(state.map, 'resize'); } catch (e) {}
        if (inputProject) focusMapOnProject(inputProject);
        return;
      }
      if (state.renderRecoveryCount >= 2) return;
      state.renderRecoveryCount += 1;
      state.markers.forEach((marker) => marker.setMap?.(null));
      state.markers = [];
      state.map = null;
      state.geocoder = null;
      initializeMapView(inputProject);
    }, 500);
  }

  function deferInitializeMapView(inputProject = null, delay = 80){
    clearTimeout(state.deferredInitTimer);
    state.deferredInitTimer = setTimeout(() => {
      state.deferredInitTimer = 0;
      initializeMapView(inputProject);
    }, Math.max(0, Number(delay) || 0));
  }

  function mount(context = {}){
    injectOverviewCss();
    state.host = hostFor(context);
    state.model = modelFromContext(context);
    state.panelRoot = resolveRoot(context);
    state.mounted = !!state.panelRoot;
    state.active = context.active !== false;
    if (state.model && window.FirstMateAppContext?.installProjectContextAccessors) {
      window.FirstMateAppContext.installProjectContextAccessors(state.model, { overwrite: false });
    }
    renderOverview();
    syncPinPlacementHint();
    if (materialsEnabled()) loadMaterialSummary().catch(() => null);
    deferInitializeMapView(context.project || context.activeProject || null);
    return api;
  }

  function activate(context = {}){
    if (context.host || context.projectWorkspace || context.panelRoot) mount(context);
    state.active = true;
    renderOverview();
    syncPinPlacementHint();
    if (materialsEnabled()) loadMaterialSummary().catch(() => null);
    deferInitializeMapView(context.project || context.activeProject || null);
  }

  function reset(){
    clearTimeout(state.initRetryTimer);
    clearTimeout(state.deferredInitTimer);
    clearTimeout(state.renderRecoveryTimer);
    if (state.mapResizeFrame) cancelAnimationFrame(state.mapResizeFrame);
    state.initRetryTimer = 0;
    state.deferredInitTimer = 0;
    state.renderRecoveryTimer = 0;
    state.renderRecoveryCount = 0;
    state.mapResizeFrame = 0;
    clearAllPins({ silent: true });
    state.map = null;
    state.geocoder = null;
    state.maxZoomService = null;
    state.forwardGeocoding = false;
    state.placeLoadGen = 0;
    state.mapExpandedManual = null;
    state.lastDefaultExpandedMap = false;
    state.focusedPinSignature = '';
    state.focusedLocation = null;
    state.focusedZoom = null;
  }

  function invoke(name, args = []){
    const fn = api[name];
    return typeof fn === 'function' ? fn(...(Array.isArray(args) ? args : [])) : undefined;
  }

  const api = {
    mount,
    activate,
    reset,
    destroy: reset,
    unmount: reset,
    invoke,
    buildPinIcon,
    refreshMarkerIcons,
    clearAllPins,
    removePin,
    addPin,
    getMarkersData,
    finiteCoord,
    normalizeProjectPins,
    setCoords,
    parseAddressComponents,
    reverseGeocode,
    loadPlaceResult,
    forwardGeocode,
    latLngLiteral,
    setSafeMapZoom,
    focusMapOnLocation,
    applyMapControlsForMode,
    fitMapToPins,
    focusMapOnProject,
    googleMapsReady,
    setMapHint,
    overviewMapExpanded,
    setOverviewMapExpanded,
    resetOverviewMapExpansion,
    syncOverviewMapMode,
    renderOverview,
    initMapOnce,
    initializeMapView,
    context: () => ({ mounted: state.mounted, active: state.active, markerCount: state.markers.length })
  };

  const definition = {
    id: 'project.map',
    kind: 'project_modal_app',
    title: 'Project Overview',
    label: 'Overview',
    icon: 'fa-table-columns',
    order: 10,
    visible: true,
    surfaces: ['project_modal'],
    regions: ['main'],
    requiresContext: ['project'],
    panelHtml,
    mount
  };

  Portal.modules = Portal.modules || {};
  Portal.modules.projectMap = api;
  Portal.ProjectMapApp = api;

  runtime?.registerApp?.(definition);
})();
