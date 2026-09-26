/* public/libraries/apps/materials/project.js
 * Project modal Materials tab.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  const Portal = window.Portal;
  const util = Portal?.util || {};
  const cfg = Portal?.cfg || window.__APP || {};
  const $ = util.$ || ((sel, root = document) => root.querySelector(sel));
  const fmUrl = util.fmUrl || ((path) => String(path || ''));
  const fmJson = util.fmJson || null;
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match])));
  const injectCSS = util.injectCSS || function(id, css){
    const styleId = `fm-style-${id}`;
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      document.head.appendChild(style);
    }
    style.textContent = css || '';
    return style;
  };
  const showToast = Portal?.ui?.showToast || window.showToast || (() => {});
  const rootWindow = window;

  const SECTION_DEFS = [
    { key: 'shingles', title: (globalThis.PlatformLanguage?.text("materials","m_c44abe253b114a","Shingles") ?? "Shingles"), icon: 'fa-house-chimney' },
    { key: 'flat_roofing', title: (globalThis.PlatformLanguage?.text("materials","m_2d953436a59003","Flat Roofing") ?? "Flat Roofing"), icon: 'fa-layer-group' },
    { key: 'metal', title: (globalThis.PlatformLanguage?.text("materials","m_5e12568a3f2b10","Metal") ?? "Metal"), icon: 'fa-grip-lines' },
    { key: 'underlayments', title: (globalThis.PlatformLanguage?.text("materials","m_e55a1d6e0abb11","Underlayments") ?? "Underlayments"), icon: 'fa-scroll' },
    { key: 'accessories', title: (globalThis.PlatformLanguage?.text("materials","m_9704d38f3e857e","Accessories") ?? "Accessories"), icon: 'fa-screwdriver-wrench' }
  ];
  const CATEGORY_TO_SECTION = {
    shingle_roofs: 'shingles',
    flat_roofs: 'flat_roofing',
    flat_roof_accessories: 'flat_roofing',
    leak_barriers: 'underlayments',
    underlayments: 'underlayments',
    flashing: 'metal',
    accessories: 'accessories',
    gutters: 'accessories',
    disposal: 'accessories',
    misc: 'accessories'
  };
  const PRIMARY_LIST_TITLE = 'Materials';
  const MATERIAL_LIST_COLORS = ['#d93025', '#f97316', '#f59e0b', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#64748b'];
  const SCHEDULING_FOCUS_KEY = 'fm:scheduling:focus';

  const state = {
    mounted: false,
    active: false,
    loading: false,
    saving: false,
    host: null,
    context: null,
    project: null,
    panelRoot: null,
    leftRoot: null,
    lists: [],
    activeListId: '',
    activeList: null,
    visibleListIds: new Set(),
    leftSections: { lists: true, measurements: true, custom_fields: true, notes: true },
    noteVisibility: ['office', 'crew', 'sales'],
    pendingAudioNote: null,
    noteVisibilityOpen: false,
    editingNoteId: '',
    versions: [],
    orders: [],
    deliveriesByOrderId: {},
    crews: [],
    crewsLoading: false,
    workforceTerms: {},
    expenseSummary: null,
    expenseLoading: false,
    expenseError: '',
    pricebookItems: [],
    selectedStructureIds: new Set(),
    structuresConfirmed: false,
    activeStructureId: 'total',
    roofScope: 'full_roof',
    measurementOverrides: {},
    measurementExtraSource: {},
    roofMeasurements: null,
    measurementLoadingId: '',
    measurementLoadedId: '',
    measurementRefreshing: false,
    generatingMaterials: false,
    regeneratingLaborListId: '',
    flashingColor: 'black',
    pricebookOpen: false,
    pricebookSearch: '',
    colorMenu: null,
    listMenu: null,
    search: '',
    selectedSection: 'all',
    unitsMode: 'measured',
    orderProvider: 'manual',
    orderSelectedListIds: new Set(),
    orderTimingChoice: '',
    orderScheduleDrafts: {},
    orderDatesConfirmed: false,
    orderCalendarOpen: false,
    orderScheduleFocusListId: '',
    orderCalendarMode: 'week',
    orderCalendarDate: new Date(),
    orderDraft: {},
    orderDraftFresh: false,
    schedulingListId: '',
    creatingList: false,
    lastError: '',
    contextGeneration: 0,
    loadGeneration: 0,
    detailsRequestGeneration: 0,
    expenseRequestGeneration: 0,
    workforceRequestGeneration: 0
  };
  let stylesInjected = false;
  let arrangeFrame = 0;
  let timingProbeInstalled = false;
  let noteVisibilityOutsideBound = false;

  function timingEnabled(){
    try {
      return /(?:[?&])fmTiming=1(?:&|$)/.test(rootWindow.location?.search || '') || rootWindow.localStorage?.getItem?.('fm_materials_timing') === '1';
    } catch (_) {
      return false;
    }
  }

  function timingStore(){
    if (!timingEnabled()) return null;
    const store = rootWindow.FirstMateMaterialsTiming || {
      entries: [],
      lastClick: null,
      clear(){ this.entries = []; this.lastClick = null; },
      summary(){ return this.entries.slice(-80); }
    };
    rootWindow.FirstMateMaterialsTiming = store;
    return store;
  }

  function timingLabel(target){
    if (!target || target === document) return 'document';
    const el = target.closest?.('button,[data-mt-open-pricebook],[data-mt-add-custom],[data-mt-remove],[data-mt-generate-materials],[data-mt-item-option],[data-preview-tab],.r-preview-tab,.mt-btn,.mt-icon-btn');
    if (!el) return cleanText(target.textContent || target.tagName || 'unknown').slice(0, 80);
    const attrs = ['data-mt-open-pricebook', 'data-mt-add-custom', 'data-mt-remove', 'data-mt-generate-materials', 'data-preview-tab', 'data-panel'];
    const attr = attrs.find((name) => el.hasAttribute?.(name));
    const attrText = attr ? `${attr}=${el.getAttribute(attr) || '1'}` : '';
    const text = cleanText(el.textContent || el.getAttribute?.('title') || el.tagName || '');
    return [el.tagName?.toLowerCase?.() || 'node', attrText, text].filter(Boolean).join(' ');
  }

  function timingMark(name, detail = {}, start){
    const store = timingStore();
    if (!store) return null;
    const now = performance.now();
    const entry = {
      name,
      at: Math.round(now * 10) / 10,
      duration: start != null ? Math.round((now - start) * 10) / 10 : undefined,
      detail
    };
    store.entries.push(entry);
    if (store.entries.length > 300) store.entries.splice(0, store.entries.length - 300);
    try {
      let node = document.getElementById('fm-materials-timing-log');
      if (!node) {
        node = document.createElement('script');
        node.type = 'application/json';
        node.id = 'fm-materials-timing-log';
        document.head.appendChild(node);
      }
      node.textContent = JSON.stringify(store.entries.slice(-160));
    } catch (_) {}
    return entry;
  }

  function installTimingProbe(){
    if (timingProbeInstalled || !timingEnabled()) return;
    timingProbeInstalled = true;
    const store = timingStore();
    if (!store) return;
    document.addEventListener('pointerdown', (event) => {
      store.lastClick = { at: performance.now(), label: timingLabel(event.target), mutationLogged: false };
      timingMark('pointerdown', { target: store.lastClick.label });
    }, true);
    document.addEventListener('click', (event) => {
      const sincePointer = store.lastClick ? performance.now() - store.lastClick.at : null;
      timingMark('click', { target: timingLabel(event.target), sincePointer: sincePointer == null ? null : Math.round(sincePointer * 10) / 10 });
    }, true);
    try {
      const observer = new MutationObserver((mutations) => {
        if (!store.lastClick || store.lastClick.mutationLogged) return;
        store.lastClick.mutationLogged = true;
        timingMark('first-dom-mutation-after-click', {
          target: store.lastClick.label,
          sincePointer: Math.round((performance.now() - store.lastClick.at) * 10) / 10,
          mutations: mutations.length
        });
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    } catch (_) {}
    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => timingMark('longtask', { duration: Math.round(entry.duration * 10) / 10, start: Math.round(entry.startTime * 10) / 10 }));
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch (_) {}
    timingMark('timing-probe-installed');
  }

  function cleanText(value){ return String(value ?? '').trim(); }
  function number(value, fallback = 0){
    const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function money(value){
    const parsed = number(value, 0);
    return `$${parsed.toLocaleString(undefined, { minimumFractionDigits: parsed % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
  }
  function titleFromKey(value){
    return cleanText(value)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }
  function todayIso(){ return new Date().toISOString(); }
  function uid(prefix){
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
  function orgId(){
    return cleanText(state.context?.orgId || cfg.userOrgId || cfg.orgId || window.__APP?.userOrgId || '');
  }
  function branchId(){
    return cleanText(state.context?.branchId || window.Portal?.branchModules?.currentBranchId?.() || cfg.userBranchId || window.__APP?.userBranchId || 'default') || 'default';
  }
  function projectId(){
    return cleanText(state.project?.id || state.context?.projectId || state.context?.entityId || '');
  }
  function beginLoadContext(){
    return {
      generation: ++state.loadGeneration,
      orgId: orgId(),
      projectId: projectId(),
      branchId: branchId()
    };
  }
  function loadContextIsCurrent(loadContext){
    return !loadContext || (
      state.mounted
      && loadContext.generation === state.loadGeneration
      && loadContext.orgId === orgId()
      && loadContext.projectId === projectId()
      && loadContext.branchId === branchId()
    );
  }
  function captureProjectOperation(listId = ''){
    return {
      contextGeneration: state.contextGeneration,
      orgId: orgId(),
      projectId: projectId(),
      listId: cleanText(listId)
    };
  }
  function projectOperationIsCurrent(operation){
    return !!operation
      && operation.contextGeneration === state.contextGeneration
      && operation.orgId === orgId()
      && operation.projectId === projectId();
  }
  function apiReady(){
    return !!(window.MaterialsAPI?.projects && orgId() && projectId());
  }
  function pricebook(){
    return window.FirstMatePricebook || window.Portal?.modules?.pricebook || null;
  }
  function projectHost(){
    return state.context?.projectWorkspace || state.context?.host || state.host || {};
  }
  function callHost(name, ...args){
    const fn = projectHost()[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
  }

  async function confirmAction(message, options = {}){
    const confirmUi = window.PlatformUI?.confirm || Portal?.ui?.confirm || rootWindow.confirm?.bind(rootWindow);
    if (typeof confirmUi !== 'function') return true;
    return !!(await confirmUi(message, options));
  }
  function normalizeColor(value, fallback = '#64748b'){
    const color = cleanText(value);
    if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(color)) return `#${color.slice(1).split('').map((part) => `${part}${part}`).join('')}`.toLowerCase();
    return fallback;
  }
  function companyPrimaryColor(){
    const configured = cleanText(cfg.primaryColor || cfg.primary_color || window.__APP?.primaryColor || window.__APP?.primary_color);
    if (/^#[0-9a-f]{3,6}$/i.test(configured)) return normalizeColor(configured, MATERIAL_LIST_COLORS[0]);
    try {
      const computed = cleanText(getComputedStyle(document.documentElement).getPropertyValue('--primary'));
      if (/^#[0-9a-f]{3,6}$/i.test(computed)) return normalizeColor(computed, MATERIAL_LIST_COLORS[0]);
    } catch (_) {}
    return MATERIAL_LIST_COLORS[0];
  }
  function materialListColor(list, index = 0){
    return normalizeColor(list?.color || list?.metadata?.color || list?.metadata?.list_color || list?.metadata?.scope_color, [companyPrimaryColor(), ...MATERIAL_LIST_COLORS][index] || '#64748b');
  }
  function materialListOrdered(list){
    return ['ordered', 'partially_delivered', 'delivered'].includes(cleanText(list?.status).toLowerCase()) || !!cleanText(list?.ordered_at);
  }
  function materialListScheduleLocked(list){
    const event = linkedScheduleEvent(list);
    return event?.locked === true
      || event?.schedule_locked === true
      || event?.schedule_lock?.locked === true
      || list?.schedule?.locked === true;
  }
  function materialListById(listId){
    return state.lists.find((list) => cleanText(list?.id) === cleanText(listId)) || null;
  }
  function resourceType(list = state.activeList){
    const value = cleanText(list?.resource_type).toLowerCase();
    return ['labor', 'equipment'].includes(value) ? value : 'material';
  }
  function resourceTerms(type = resourceType(), list = state.activeList){
    const configured = list?.terminology && typeof list.terminology === 'object' ? list.terminology : {};
    const defaults = {
      material: { singular: 'Material', plural: 'Materials', list: 'Material list', icon: 'fa-boxes-stacked' },
      labor: { singular: 'Labor item', plural: 'Labor', list: 'Labor work order', icon: 'fa-helmet-safety' },
      equipment: { singular: 'Equipment item', plural: 'Equipment', list: 'Equipment list', icon: 'fa-truck-pickup' }
    }[type] || {};
    return { ...defaults, ...configured };
  }
  function resourceScheduleEnabled(list = state.activeList){
    return list?.schedule?.enabled === true || (resourceType(list) === 'material' && list?.schedule?.enabled !== false);
  }
  function resourceSchedulePending(list = state.activeList){
    return resourceScheduleEnabled(list) && !eventDateParts(linkedScheduleEvent(list)).date;
  }
  function resourceListIncomplete(list = state.activeList){
    return (resourceType(list) === 'material' && !materialListOrdered(list)) || resourceSchedulePending(list);
  }
  function workResourceById(id){ return state.crews.find((resource) => cleanText(resource?.id) === cleanText(id)) || null; }
  function assignmentWorkResourceRef(list = {}){
    const assignment = list?.assignment && typeof list.assignment === 'object' ? list.assignment : {};
    const ref = assignment.work_resource_ref && typeof assignment.work_resource_ref === 'object' ? assignment.work_resource_ref : {};
    const id = cleanText(ref.id || assignment.resource_id || assignment.crew_id);
    return id ? { kind:cleanText(ref.kind || assignment.resource_kind || 'resource_group'), id, name:cleanText(ref.name || assignment.resource_name || assignment.crew_name) } : null;
  }
  function workResourcesForScopeList(list){
    const templateId = cleanText(list?.scope_template_id || list?.template_id);
    const selectedRef = assignmentWorkResourceRef(list);
    const selectedId = selectedRef?.id || '';
    const resources = state.crews.filter((resource) => {
      const ids = Array.isArray(resource?.capability_scope_ids) ? resource.capability_scope_ids : [];
      return !templateId || cleanText(resource.id) === selectedId || ids.map(cleanText).includes(templateId);
    });
    if (selectedId && !resources.some((resource) => cleanText(resource.id) === selectedId)) {
      resources.push({ id:selectedId, name:selectedRef.name || selectedId, resource_kind:selectedRef.kind, work_resource_ref:selectedRef, capability_scope_ids:[] });
    }
    return resources;
  }
  function workforceLabel(kind, form = 'singular'){
    const configured = state.workforceTerms?.[kind];
    const fallback=cleanText(configured?.[form] || configured?.singular || (kind === 'organization_connection' ? 'Partner' : 'Team'));
    return window.PlatformTerminology?.get?.(`workforce.${kind}_${form}`,fallback) || fallback;
  }
  function workResourceLabel(){
    return `${workforceLabel('resource_group')} / ${workforceLabel('organization_connection')}`;
  }
  function workResourceCompensationMode(resource){
    const plans = [resource?.compensation_plan, ...(Array.isArray(resource?.members) ? resource.members.map((member) => member?.compensation_plan) : [])].filter(Boolean);
    const hourly = plans.some((plan) => plan.default_hourly === true || ['hourly','hybrid'].includes(cleanText(plan.type)));
    const salary = plans.some((plan) => plan.default_salary === true || ['salary','hybrid'].includes(cleanText(plan.type)));
    const piece = plans.some((plan) => plan.default_piece_rate === true || ['piece_rate','hybrid'].includes(cleanText(plan.type)));
    if ((hourly || salary) && piece) return 'hybrid';
    if (piece) return 'piece_rate';
    if (hourly) return 'hourly';
    if (salary) return 'salary';
    return 'none';
  }
  function visibleMaterialLists(){
    return state.lists.filter((list) => state.visibleListIds.has(cleanText(list?.id)));
  }
  function firstUnusedListColor(){
    const used = new Set(state.lists.map((list, index) => materialListColor(list, index).toLowerCase()));
    const palette = [companyPrimaryColor(), ...MATERIAL_LIST_COLORS].map((color) => normalizeColor(color));
    return palette.find((color) => !used.has(color.toLowerCase())) || palette[state.lists.length % palette.length] || companyPrimaryColor();
  }
  function normalizeOrderSource(source, index = 0){
    const value = source && typeof source === 'object' ? source : {};
    const id = cleanText(value.id || value.provider || `order_source_${index + 1}`);
    return {
      ...value,
      id,
      name: cleanText(value.name || value.title || id) || 'Order source',
      kind: cleanText(value.kind || (value.provider ? 'integration' : 'manual')).toLowerCase() || 'manual',
      status: cleanText(value.status || 'active').toLowerCase() || 'active',
      provider: cleanText(value.provider)
    };
  }
  function projectOrderSources(){
    const byId = new Map();
    state.lists.forEach((list) => {
      (Array.isArray(list?.order_sources) ? list.order_sources : []).forEach((source, index) => {
        const normalized = normalizeOrderSource(source, index);
        if (normalized.id && !byId.has(normalized.id)) byId.set(normalized.id, normalized);
      });
    });
    return [...byId.values()];
  }
  function orderSourcesForList(list = state.activeList){
    const configured = (Array.isArray(list?.order_sources) ? list.order_sources : []).map(normalizeOrderSource).filter((source) => source.id);
    if (configured.length) return configured;
    const projectSources = projectOrderSources();
    return projectSources.length ? projectSources : [{ id: 'manual', name: 'Manual Order', kind: 'manual', status: 'active', provider: '' }];
  }
  function defaultOrderSourceId(list = state.activeList){
    const sources = orderSourcesForList(list);
    return cleanText(sources.find((source) => source.kind === 'manual' && source.status === 'active')?.id
      || sources.find((source) => source.status === 'active')?.id
      || sources[0]?.id
      || 'manual');
  }
  function orderSourceIcon(source){
    const identity = `${cleanText(source?.id)} ${cleanText(source?.provider)} ${cleanText(source?.name)}`.toLowerCase();
    if (source?.kind === 'manual') return 'fa-envelope';
    if (identity.includes('convoy')) return 'fa-truck';
    if (identity.includes('srs')) return 'fa-building';
    return 'fa-plug-circle-bolt';
  }
  function scopeForMaterials(){
    const project = state.project || {};
    const hasMeasurements = (measurements) => Object.values(measurements && typeof measurements === 'object' ? measurements : {})
      .some((value) => typeof value !== 'object' && Number(value) > 0);
    const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const projectScopes = [project.scope, project.project_scope].map(asObject);
    const projectScope = projectScopes.find((scope) => hasMeasurements(scope.measurements))
      || projectScopes.find((scope) => Object.keys(scope).length)
      || {};
    const proposals = Array.isArray(project.proposals) ? [...project.proposals].reverse() : [];

    // A signed proposal is frozen in a snapshot.  The project summary commonly
    // contains only delivery metadata for that proposal, while the measurements
    // remain nested in its content/scope.  Material generation already receives
    // this snapshot, so include the same sources when rendering the sidebar.
    const proposalMeasurementSources = (proposal) => {
      const item = asObject(proposal);
      const content = asObject(item.content);
      const editable = asObject(item.editable);
      const snapshot = asObject(item.snapshot);
      const snapshotContent = asObject(snapshot.content);
      return [
        item.measurements,
        asObject(item.scope).measurements,
        content.measurements,
        asObject(content.scope).measurements,
        editable.measurements,
        asObject(editable.scope).measurements,
        snapshotContent.measurements,
        asObject(snapshotContent.scope).measurements
      ].map(asObject);
    };
    const proposal = proposals.find((item) => proposalMeasurementSources(item).some(hasMeasurements));
    const proposalMeasurements = proposal
      ? proposalMeasurementSources(proposal).reduce((merged, source) => ({ ...merged, ...source }), {})
      : {};
    const measurements = { ...asObject(project.measurements), ...asObject(projectScope.measurements), ...proposalMeasurements };
    const sourceScope = projectScope && Object.keys(projectScope).length
      ? projectScope
      : asObject(proposal?.scope || proposal?.content?.scope || proposal?.editable?.scope || proposal?.snapshot?.content?.scope);
    const pieces = Array.isArray(sourceScope.pieces) ? sourceScope.pieces.map((piece) => {
      const pieceMeasurements = piece?.measurements && typeof piece.measurements === 'object' ? piece.measurements : {};
      return hasMeasurements(pieceMeasurements) ? piece : { ...piece, measurements: { ...pieceMeasurements, ...measurements } };
    }) : [];
    return { ...sourceScope, measurements, pieces };
  }
  function scopeMeasurements(){
    const scope = scopeForMaterials();
    const hasMeasurements = (measurements) => Object.values(measurements && typeof measurements === 'object' ? measurements : {})
      .some((value) => typeof value !== 'object' && Number(value) > 0);
    if (scope.measurements && typeof scope.measurements === 'object' && hasMeasurements(scope.measurements)) return scope.measurements;
    const pieces = Array.isArray(scope.pieces) ? scope.pieces : [];
    const pieceMeasurements = pieces.reduce((merged, piece) => ({
      ...merged,
      ...(piece?.measurements && typeof piece.measurements === 'object' ? piece.measurements : {})
    }), {});
    if (hasMeasurements(pieceMeasurements)) return pieceMeasurements;

    // Generated lists retain the measurements from the signed proposal snapshot.
    // Use them only as a display fallback: an editable project scope with actual
    // values must always remain the source of truth for regeneration.
    const listMeasurements = state.lists.reduce((merged, list) => ({
      ...merged,
      ...(list?.measurements && typeof list.measurements === 'object' ? list.measurements : {})
    }), {});
    if (hasMeasurements(listMeasurements)) return listMeasurements;
    return scope.measurements && typeof scope.measurements === 'object' ? scope.measurements : pieceMeasurements;
  }
  function linkedScheduleEvent(list = state.activeList){
    const listId = cleanText(list?.id);
    const eventId = cleanText(list?.schedule_event_id || list?.delivery_event_id || list?.metadata?.schedule_event_id || list?.metadata?.delivery_event_id);
    const events = Array.isArray(state.project?.events) ? state.project.events : [];
    const event = events.find((event) => cleanText(event?.id) === eventId)
      || events.find((event) => cleanText(event?.material_list_id || event?.metadata?.material_list_id) === listId)
      || null;
    const schedule = list?.schedule && typeof list.schedule === 'object' ? list.schedule : {};
    if (!event && !eventId && !cleanText(schedule.start_at || schedule.start || schedule.date)) return null;
    const startAt = cleanText(event?.start_at || event?.start || schedule.start_at || schedule.start || schedule.date);
    const endAt = cleanText(event?.end_at || event?.end || schedule.end_at || schedule.end);
    return {
      ...schedule,
      ...(event || {}),
      id: cleanText(event?.id || eventId || schedule.event_id),
      material_list_id: cleanText(event?.material_list_id || listId),
      start_at: startAt,
      end_at: endAt,
      status: startAt ? cleanText(event?.status) === 'cancelled' ? 'cancelled' : 'scheduled' : cleanText(event?.status || schedule.status || 'unscheduled')
    };
  }
  function eventDateParts(event){
    const raw = cleanText(event?.start_at || event?.start || event?.scheduled_at || event?.date);
    const parsed = raw ? new Date(raw) : null;
    if (!parsed || !Number.isFinite(parsed.getTime())) return { date: '', time: '', iso: '' };
    const localDate = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
    const localTime = `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
    return { date: localDate, time: localTime, iso: parsed.toISOString() };
  }
  function materialOrderLists(){
    return state.lists.filter((list) => resourceType(list) === 'material' && listItems(list).length);
  }
  function selectedOrderLists(){
    const selected = materialOrderLists().filter((list) => state.orderSelectedListIds.has(cleanText(list.id)));
    return selected.length ? selected : (state.activeList && resourceType(state.activeList) === 'material' ? [state.activeList] : []);
  }
  function scheduleDraftForList(list){
    const id = cleanText(list?.id);
    return state.orderScheduleDrafts[id] || { date: '', time: '' };
  }
  function seedOrderSchedule(list){
    const id = cleanText(list?.id);
    if (!id || state.orderScheduleDrafts[id]) return;
    const event = linkedScheduleEvent(list);
    const parts = eventDateParts(event);
    state.orderScheduleDrafts[id] = {
      date: parts.date,
      time: event?.all_day === false && parts.time && parts.time !== '00:00' ? parts.time : '',
      start: cleanText(event?.start_at || event?.start),
      end: cleanText(event?.end_at || event?.end),
      all_day: event?.all_day !== false,
      dirty: false
    };
  }
  function initializeOrderComposer(preferredListId = state.activeListId, options = {}){
    const lists = materialOrderLists();
    let preferred = lists.find((list) => cleanText(list.id) === cleanText(preferredListId)) || lists[0] || null;
    if (options.preferUnordered && materialListOrdered(preferred)) preferred = lists.find((list) => !materialListOrdered(list)) || preferred;
    state.orderSelectedListIds = new Set(preferred ? [cleanText(preferred.id)] : []);
    state.orderTimingChoice = '';
    state.orderScheduleDrafts = {};
    lists.forEach(seedOrderSchedule);
    const preferredDraft = preferred ? state.orderScheduleDrafts[cleanText(preferred.id)] : null;
    if (preferredDraft?.date) state.orderTimingChoice = 'scheduled';
    state.orderDatesConfirmed = !!preferredDraft?.date;
    state.orderCalendarOpen = false;
    state.orderScheduleFocusListId = cleanText(preferred?.id);
    state.orderCalendarMode = 'week';
    state.orderCalendarDate = preferredDraft?.date ? dateFromOrderSchedule(preferredDraft) : new Date();
    state.orderDraft = {
      title: cleanText(preferred?.title || (globalThis.PlatformLanguage?.text("materials","m_d7bad661a9f673","Material order") ?? "Material order")),
      vendor: '',
      vendor_email: '',
      quoted_price: '',
      paid_price: ''
    };
    state.orderDraftFresh = true;
    state.orderProvider = defaultOrderSourceId(preferred || state.activeList);
  }
  function captureOrderDraft(dialog){
    const form = dialog?.querySelector?.('[data-mt-order-form]');
    if (!form) return;
    ['title','vendor','vendor_email','quoted_price','paid_price'].forEach((name) => {
      const input = form.elements?.namedItem?.(name);
      if (input) state.orderDraft[name] = input.value;
    });
  }
  function orderScheduleDatesComplete(){
    const lists = selectedOrderLists();
    return !!lists.length && lists.every((list) => cleanText(scheduleDraftForList(list).date));
  }
  function orderScheduleComplete(){
    if (state.orderTimingChoice === 'without_dates') return true;
    if (state.orderTimingChoice !== 'scheduled') return false;
    return orderScheduleDatesComplete() && state.orderDatesConfirmed;
  }
  function projectFromContext(context = {}){
    return context.project || context.activeProject || context.projectModel?.state?.activeBaseProject || state.project || null;
  }

  function css(){
    return `
      .mt-app{height:100%;min-height:0;display:flex;flex-direction:column;background:#f7f8fb;color:#111827;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;container-type:inline-size;container-name:materials-workspace}
      .r-overlay.materials-workspace #rProposalSection.visible{min-height:0}
      .r-overlay.materials-workspace #rProposalList{min-height:0;gap:0}
      .mt-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(15,23,42,.08);background:#fff}
      .mt-title{display:flex;align-items:center;gap:10px;min-width:0}
      .mt-title i{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:rgba(var(--primary-rgb,217,48,37),.10);color:var(--primary-readable,var(--primary,#d93025))}
      .mt-title strong{display:block;font-size:14px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-title span,.mt-top [data-mt-add-custom]{display:none}
      .mt-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .mt-btn,.mt-icon-btn{border:1px solid rgba(15,23,42,.12);background:#fff;color:#344054;border-radius:8px;min-height:34px;font-size:12px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;transition:.16s ease}
      .mt-btn{padding:8px 11px}.mt-icon-btn{width:34px;padding:0}
      .mt-btn:hover:not(:disabled),.mt-icon-btn:hover:not(:disabled){border-color:rgba(var(--primary-rgb,217,48,37),.28);color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 6px 16px rgba(15,23,42,.08)}
      .mt-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff);box-shadow:0 12px 24px rgba(var(--primary-rgb,217,48,37),.18)}
      .mt-btn.primary:hover:not(:disabled){background:var(--primary-dark,var(--primary,#d93025));border-color:var(--primary-dark,var(--primary,#d93025));color:var(--on-primary,#fff);box-shadow:0 14px 28px rgba(var(--primary-rgb,217,48,37),.22)}
      .mt-btn.success{background:#067647;border-color:#067647;color:#fff}
      .mt-btn.warn{background:#fffaeb;border-color:#fedf89;color:#93370d}
      .mt-btn:disabled,.mt-icon-btn:disabled{opacity:.55;cursor:not-allowed}
      .mt-body{flex:1;min-height:0;display:flex;overflow:hidden}
      .mt-status{display:inline-flex;align-items:center;width:max-content;gap:6px;padding:4px 7px;border-radius:999px;background:#f2f4f7;color:#344054;font-size:10px;font-weight:1000;text-transform:capitalize}
      .mt-status.ordered,.mt-status.scheduled{background:#eff8ff;color:#175cd3}.mt-status.delivered{background:#ecfdf3;color:#067647}.mt-status.planning{background:#fffaeb;color:#93370d}
      .mt-main{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;padding:14px;display:flex;flex-direction:column;gap:12px}
      .mt-toolbar{display:grid;grid-template-columns:minmax(180px,1fr) auto;gap:10px;align-items:center}
      .mt-search{width:100%;border:1px solid rgba(15,23,42,.12);border-radius:8px;padding:9px 11px;font-size:12px;font-weight:800;outline:none;background:#fff}
      .mt-search:focus,.mt-input:focus,.mt-select:focus{border-color:rgba(var(--primary-rgb,217,48,37),.36);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.1)}
      .mt-section-tabs{display:flex;align-items:center;gap:7px;overflow:auto;scrollbar-width:none}
      .mt-section-tabs::-webkit-scrollbar{display:none}
      .mt-section-tab{border:1px solid transparent;background:transparent;color:#667085;min-height:32px;padding:6px 9px;border-radius:8px;font-size:11px;font-weight:950;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer}
      .mt-section-tab.active{background:#fff;border-color:rgba(15,23,42,.1);color:#101828;box-shadow:0 5px 14px rgba(15,23,42,.06)}
      .mt-material-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
      .mt-material-scroll{flex:1;min-height:0;overflow:auto}
      .mt-material-column{display:flex;flex-direction:column;gap:14px;min-width:0}
      .mt-material-empty{grid-column:1/-1}
      .mt-section{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:8px;overflow:hidden}
      .mt-section.needs-data{border-color:#fedf89;background:#fffcf5}
      .mt-section-head{min-height:40px;padding:8px 10px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:10px}
      .mt-section-head h3{margin:0;font-size:13px;color:#101828;display:flex;align-items:center;gap:8px}
      .mt-section-head-actions{display:flex;align-items:center;gap:7px}.mt-section-head-actions>span{font-size:11px;font-weight:900;color:#667085}.mt-section-head .mt-warn{color:#93370d;background:#fffaeb;border:1px solid #fedf89;border-radius:999px;padding:3px 7px}.mt-section-add{width:27px;height:27px;min-height:27px;border-radius:7px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#667085;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}.mt-section-add:hover{color:var(--primary-readable,var(--primary,#d93025));border-color:rgba(var(--primary-rgb,217,48,37),.3);background:rgba(var(--primary-rgb,217,48,37),.05)}
      .mt-units-toggle{display:inline-flex;align-items:center;gap:5px;min-height:27px;padding:3px 9px;border-radius:999px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#667085;font-size:10px;font-weight:900;cursor:pointer;white-space:nowrap}
      .mt-units-toggle.order{color:var(--primary-readable,var(--primary,#d93025));border-color:rgba(var(--primary-rgb,217,48,37),.3);background:rgba(var(--primary-rgb,217,48,37),.05)}
      .mt-order-qty-cell{display:flex;flex-direction:column;gap:1px}
      .mt-order-qty-cell strong{font-size:12px;color:#101828}
      .mt-order-qty-cell span{font-size:9px;font-weight:800;color:#98a2b3;white-space:nowrap}
      .mt-table{width:100%;border-collapse:collapse;table-layout:fixed}
      .mt-table th,.mt-table td{box-sizing:border-box;padding:7px 10px;border-bottom:1px solid rgba(15,23,42,.06);text-align:left;font-size:12px;vertical-align:middle}
      .mt-table th{font-size:10px;text-transform:uppercase;letter-spacing:0;color:#667085;background:#f9fafb;height:26px}
      .mt-table th:last-child,.mt-table td:last-child{padding-left:10px;padding-right:10px;text-align:center}
      .mt-table .mt-icon-btn{width:28px;min-width:28px;min-height:28px;border-radius:7px}
      .mt-table tr:last-child td{border-bottom:0}
      .mt-line-main{min-width:0;display:flex;flex-direction:column;gap:3px}.mt-line-title{display:flex;align-items:center;gap:6px;min-width:0}.mt-line-main strong{display:block;min-width:0;font-size:12px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-line-main span{display:block;font-size:10px;font-weight:800;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-line-name{min-width:0!important;width:100%;font-weight:950}.mt-list-dot{display:inline-block!important;width:9px;height:9px;min-width:9px;border:0;padding:0;border-radius:999px;background:var(--list-color,#64748b);box-shadow:0 0 0 2px color-mix(in srgb,var(--list-color,#64748b) 16%,transparent);flex:0 0 auto;cursor:pointer}.mt-list-dot:hover,.mt-list-dot[aria-expanded="true"]{box-shadow:0 0 0 4px color-mix(in srgb,var(--list-color,#64748b) 18%,transparent)}
      .mt-input,.mt-select{width:100%;border:1px solid rgba(15,23,42,.12);border-radius:8px;padding:8px 9px;font-size:12px;font-weight:800;background:#fff;color:#101828;outline:none}
      .mt-cell-input{border:0;border-radius:0;background:transparent;padding:3px 2px;min-height:28px;box-shadow:none}
      .mt-cell-input:disabled,.mt-variant-select:disabled{opacity:1;color:inherit;cursor:default}
      .mt-cell-input:focus{border:0!important;box-shadow:inset 0 -2px 0 rgba(var(--primary-rgb,217,48,37),.32)!important;background:rgba(var(--primary-rgb,217,48,37),.035)}
      .mt-number{max-width:100%}.mt-qty-input{width:100%!important;min-width:0;text-align:right;font-variant-numeric:tabular-nums}.mt-small{font-size:11px;color:#667085;font-weight:800}.mt-empty{padding:18px 12px;text-align:center;color:#667085;font-size:12px;font-weight:850}
      .mt-variant-select{width:min(100%,190px);border:0;background:transparent;color:#344054;font-size:11px;font-weight:900;outline:none;padding:0}
      .mt-color-trigger{border:0;background:transparent;padding:0;display:inline-flex;align-items:center;max-width:100%;cursor:pointer}
      .mt-color-current{display:inline-flex;align-items:center;gap:5px;max-width:100%}.mt-color-current em{display:none}
      .mt-color-swatch{width:22px;height:22px;border-radius:7px;border:1px solid rgba(15,23,42,.18);box-shadow:inset 0 0 0 1px rgba(255,255,255,.45);display:inline-flex;background-size:cover;background-position:center}
      .mt-color-options{position:absolute;z-index:14;top:30px;left:0;display:flex;width:max-content;min-width:max-content;gap:8px;padding:8px;border-radius:10px;background:#fff;border:1px solid rgba(15,23,42,.12);box-shadow:0 14px 34px rgba(15,23,42,.18)}
      .mt-color-portal{position:fixed;z-index:2147482600}
      .mt-color-portal .mt-color-options{position:static;top:auto;left:auto}
      .mt-color-portal.rich .mt-color-options{display:grid;width:250px;min-width:250px;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}
      .mt-color-option{width:30px;height:30px;border-radius:8px;border:2px solid transparent;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(255,255,255,.45),0 0 0 1px rgba(15,23,42,.12);background-size:cover;background-position:center}
      .mt-color-option.rich{width:100%;height:58px;display:flex;align-items:flex-end;justify-content:flex-start;padding:5px;text-align:left}.mt-color-option span{display:none}.mt-color-option.rich span{display:block;background:rgba(255,255,255,.9);border-radius:6px;padding:2px 5px;color:#101828;font-size:10px;font-weight:950;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mt-color-option.active{border-color:var(--primary,#d93025)}
      .mt-list-portal{position:fixed;z-index:2147482601;width:220px;padding:6px;border-radius:10px;background:#fff;border:1px solid rgba(15,23,42,.12);box-shadow:0 16px 38px rgba(15,23,42,.2);display:flex;flex-direction:column;gap:3px}.mt-list-option{width:100%;border:0;background:#fff;border-radius:7px;padding:8px;display:grid;grid-template-columns:12px minmax(0,1fr) auto;align-items:center;gap:8px;text-align:left;color:#344054;font-size:11px;font-weight:950;cursor:pointer}.mt-list-option:hover{background:#f2f4f7;color:#101828}.mt-list-option.active{background:color-mix(in srgb,var(--option-color,#64748b) 8%,#fff)}.mt-list-option-dot{width:9px;height:9px;border-radius:999px;background:var(--option-color,#64748b)}.mt-list-option i{color:#98a2b3}
      .mt-card{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px}
      .mt-card h3{margin:0;font-size:13px;color:#101828;display:flex;align-items:center;gap:8px}.mt-card p{margin:0;color:#667085;font-size:12px;font-weight:800;line-height:1.45}
      dialog.mt-card:not([open]){display:none!important}
      dialog.mt-card[open]{display:flex}
      .mt-pricebook-panel{position:absolute;right:14px;top:6px;z-index:9;width:min(390px,calc(100% - 28px));max-height:calc(100% - 12px);background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:8px;box-shadow:0 24px 70px rgba(15,23,42,.22);display:flex;flex-direction:column;overflow:hidden}
      .mt-pricebook-head{padding:10px 11px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:10px}.mt-pricebook-head strong{font-size:13px;color:#101828}.mt-pricebook-body{padding:10px;display:flex;flex-direction:column;gap:9px;min-height:0}
      .mt-suggest-list{display:flex;flex-direction:column;gap:7px;max-height:420px;overflow:auto}
      .mt-suggest{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:9px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
      .mt-suggest strong{display:block;font-size:12px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-suggest span{font-size:10px;font-weight:800;color:#667085}
      .mt-summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
      .mt-stat{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:10px}.mt-stat span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.04em;font-weight:1000;color:#667085}.mt-stat strong{display:block;margin-top:4px;font-size:15px;color:#101828}
      .mt-footer{flex:0 0 auto;background:rgba(255,255,255,.96);border:1px solid rgba(15,23,42,.08);border-radius:8px;padding:8px;box-shadow:0 14px 32px rgba(15,23,42,.10);backdrop-filter:blur(8px)}
      .mt-footer .mt-summary-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.mt-footer .mt-stat{padding:7px 9px}.mt-footer .mt-stat strong{font-size:13px}
      .mt-labor-estimate{flex:0 0 auto;border:1px solid rgba(37,99,235,.18);border-radius:8px;background:#fff;overflow:hidden}.mt-labor-estimate-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 12px;background:#f8faff;border-bottom:1px solid rgba(37,99,235,.12)}.mt-labor-estimate-head>div{min-width:0}.mt-labor-estimate-head strong{font-size:12px}.mt-labor-estimate-head>strong{font-size:17px;color:#175cd3}.mt-labor-estimate-head span{display:block;margin-top:2px;font-size:10px;font-weight:750;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-labor-breakdown{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0}.mt-labor-breakdown-group{min-width:0;padding:9px 11px}.mt-labor-breakdown-group+.mt-labor-breakdown-group{border-left:1px solid #eaecf0}.mt-labor-breakdown-title,.mt-labor-breakdown-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.mt-labor-breakdown-title{padding-bottom:6px;border-bottom:1px solid #f0f2f5}.mt-labor-breakdown-title span{font-size:9px;font-weight:1000;color:#475467;text-transform:uppercase}.mt-labor-breakdown-title i{margin-right:5px;color:#2563eb}.mt-labor-breakdown-title strong,.mt-labor-breakdown-row>strong{font-size:11px;white-space:nowrap}.mt-labor-breakdown-row{padding:7px 0 0}.mt-labor-breakdown-row div{min-width:0}.mt-labor-breakdown-row div strong{display:block;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-labor-breakdown-row div span{display:block;margin-top:1px;font-size:9px;color:#667085}
      .mt-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.mt-form-grid .wide{grid-column:1/-1}
      .mt-orders{display:flex;flex-direction:column;gap:8px}.mt-order{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:10px;display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.mt-order strong{font-size:12px;color:#101828}.mt-order span{display:block;font-size:11px;font-weight:800;color:#667085;margin-top:3px}
      .mt-left{height:auto;min-height:0;background:#fff;display:flex;flex-direction:column;color:#101828}
      .mt-left-head{padding:0 0 8px;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:8px}
      .mt-left-head strong{font-size:14px}.mt-left-body{padding:10px 0 0;min-height:0;overflow:visible;display:flex;flex-direction:column;gap:10px}
      .mt-prompt{font-size:11px;font-weight:950;color:#344054;text-transform:uppercase;letter-spacing:0}.mt-toggle{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
      .mt-toggle button,.mt-structure{border:1px solid rgba(15,23,42,.12);background:#fff;border-radius:8px;min-height:32px;padding:6px;font-size:12px;font-weight:950;color:#344054;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px}
      .mt-toggle button.active,.mt-structure.active{border-color:rgba(var(--primary-rgb,217,48,37),.3);background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025))}
      .mt-structure-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.mt-structure-grid.many{grid-template-columns:repeat(3,minmax(0,1fr))}
      .mt-structure-img{width:100%;aspect-ratio:4/3;border-radius:8px;object-fit:cover;background:#f2f4f7;border:1px solid rgba(15,23,42,.08)}
      .mt-measure-card{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:9px;display:flex;flex-direction:column;gap:8px}
      .mt-measure-card.loading{position:relative;overflow:hidden;border-color:rgba(var(--primary-rgb,217,48,37),.24);box-shadow:inset 0 0 0 1px rgba(var(--primary-rgb,217,48,37),.08)}
      .mt-measure-card.loading:after{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,transparent,var(--primary,#d93025),transparent);animation:mt-loadbar 1s linear infinite}
      .mt-measure-loading{position:absolute;inset:3px 0 0;background:rgba(255,255,255,.78);backdrop-filter:blur(1px);display:flex;align-items:center;justify-content:center;gap:8px;color:#344054;font-size:11px;font-weight:1000;z-index:2}
      .mt-spin{animation:mt-spin .75s linear infinite}
      @keyframes mt-spin{to{transform:rotate(360deg)}}@keyframes mt-loadbar{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
      .mt-measure-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.mt-measure-card h3{margin:0;font-size:12px;color:#101828;display:flex;align-items:center;gap:7px}.mt-measure-card p{margin:0;color:#667085;font-size:11px;font-weight:800;line-height:1.35}
      .mt-subtle-btn{border:0;background:transparent;color:#667085;width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
      .mt-subtle-btn:hover{background:rgba(15,23,42,.05);color:#344054}
      .mt-measure-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.mt-measure-lines{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
      .mt-measure-field{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:6px;display:flex;flex-direction:column;gap:3px}
      .mt-measure-field.missing{background:#fffaeb;border-color:#fedf89}.mt-measure-field label{font-size:10px;font-weight:1000;color:#667085;text-transform:uppercase;letter-spacing:0}
      .mt-measure-value{display:flex;align-items:center;gap:4px}.mt-measure-value input{width:100%;min-width:0;border:0;background:transparent;padding:0;font-size:15px;font-weight:950;color:#101828;outline:none}.mt-measure-value span{font-size:10px;font-weight:900;color:#667085}
      .mt-left .mt-btn{width:100%;min-height:32px}
      .mt-detail-card{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:9px;display:flex;flex-direction:column;gap:8px}.mt-choice-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.mt-swatch-row{display:flex;gap:8px}.mt-swatch-btn{width:32px;height:32px;border-radius:8px;border:2px solid rgba(15,23,42,.12);cursor:pointer}.mt-swatch-btn.active{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
      .mt-list-state{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:1000;color:#667085}.mt-list-state i{font-size:7px}.mt-list-state.ordered{color:#067647}.mt-list-state.unordered{color:#b54708}
      .mt-table tr.mt-list-row td:first-child{border-left:4px solid var(--list-color,#64748b);padding-left:7px}.mt-table tr.mt-list-row.incomplete td:first-child{border-left-style:dashed}.mt-table tr.mt-list-row.incomplete{background:linear-gradient(90deg,color-mix(in srgb,var(--list-color,#64748b) 4%,#fff),#fff 42%)}
      .mt-left-group{border:1px solid rgba(15,23,42,.09);border-radius:9px;background:#fff;overflow:hidden}.mt-left-group-head{width:100%;border:0;background:#fff;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;padding:10px;text-align:left;cursor:pointer}.mt-left-group-head strong{font-size:11px;font-weight:1000;color:#344054;text-transform:uppercase;letter-spacing:.035em}.mt-left-group-head span{font-size:10px;font-weight:900;color:#667085;display:flex;align-items:center;gap:7px}.mt-left-group-body{border-top:1px solid rgba(15,23,42,.07);padding:8px;display:flex;flex-direction:column;gap:7px;background:#f8fafc}.mt-left-group.collapsed .mt-left-group-body{display:none}
      .mt-list-card{--list-color:#64748b;width:100%;border:1px solid rgba(15,23,42,.09);border-left:4px solid var(--list-color);border-radius:8px;background:#fff;padding:8px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center;text-align:left;color:#101828;cursor:pointer}.mt-list-card.incomplete{border-left-style:dashed}.mt-list-card.active{box-shadow:0 0 0 2px color-mix(in srgb,var(--list-color) 20%,transparent);border-top-color:color-mix(in srgb,var(--list-color) 30%,#d0d5dd);border-right-color:color-mix(in srgb,var(--list-color) 30%,#d0d5dd);border-bottom-color:color-mix(in srgb,var(--list-color) 30%,#d0d5dd)}.mt-list-card-copy{min-width:0}.mt-list-card-copy strong{display:block;font-size:12px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-list-card-copy span{display:flex;align-items:center;gap:5px;margin-top:3px;font-size:9px;font-weight:900;color:#667085;text-transform:uppercase}.mt-list-card-actions{display:flex;align-items:center;gap:4px}.mt-list-eye,.mt-list-schedule{width:30px;height:30px;border:1px solid rgba(15,23,42,.1);border-radius:7px;background:#fff;color:#98a2b3;cursor:pointer}.mt-list-eye.visible{color:var(--list-color);background:color-mix(in srgb,var(--list-color) 8%,#fff);border-color:color-mix(in srgb,var(--list-color) 25%,#d0d5dd)}.mt-list-schedule{color:#475467}.mt-list-schedule:hover{color:var(--list-color);border-color:color-mix(in srgb,var(--list-color) 25%,#d0d5dd)}
      .mt-list-add{width:100%;border:1px dashed rgba(15,23,42,.18);border-radius:8px;background:#fff;color:#475467;min-height:34px;font-size:11px;font-weight:1000;display:flex;align-items:center;justify-content:center;gap:7px;cursor:pointer}.mt-list-add:hover{border-color:rgba(var(--primary-rgb,217,48,37),.35);color:var(--primary-readable,var(--primary,#d93025))}
      .mt-resource-group{display:flex;flex-direction:column;gap:6px}.mt-resource-group+.mt-resource-group{margin-top:5px;padding-top:9px;border-top:1px solid #e4e7ec}.mt-resource-group-title{display:flex;align-items:center;gap:6px;padding:0 2px;font-size:9px;font-weight:1000;color:#667085;text-transform:uppercase;letter-spacing:.06em}.mt-list-wrap{border-radius:8px}.mt-list-wrap.with-controls{overflow:hidden;border:1px solid rgba(15,23,42,.09);background:#fff}.mt-list-wrap.with-controls .mt-list-card{border-top:0;border-right:0;border-bottom:0;border-radius:0;box-shadow:none}.mt-list-wrap.with-controls .mt-list-card.active{background:color-mix(in srgb,var(--list-color) 5%,#fff)}.mt-list-secondary{margin:0;padding:4px 7px;border:0;border-top:1px solid #e4e7ec;border-radius:0;background:#f8fafc;display:flex;align-items:center;gap:4px;flex-wrap:nowrap;min-height:32px}.mt-list-secondary button{min-height:24px;height:24px;border:1px solid #d0d5dd;border-radius:5px;background:#fff;color:#475467;padding:0 7px;font-size:8px;font-weight:950;cursor:pointer;white-space:nowrap}.mt-labor-controls{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;align-items:center;gap:4px}.mt-labor-controls label{min-width:0;height:24px;border:1px solid #d0d5dd;border-radius:5px;background:#fff;display:flex;align-items:center;gap:3px;padding-left:5px;overflow:hidden}.mt-labor-controls label span{display:block;margin:0;font-size:7px;font-weight:1000;color:#667085;text-transform:uppercase;flex:0 0 auto}.mt-labor-controls select,.mt-labor-controls input{width:100%;min-width:0;height:22px;border:0;border-radius:0;background:#fff;color:#344054;padding:0 2px;font-size:8px;font-weight:850;outline:none}.mt-labor-actions{grid-column:3;grid-row:1 / span 2;align-self:stretch;display:flex;flex-direction:column;gap:4px}.mt-labor-actions button{min-height:24px;height:auto;flex:1}
      .mt-scope-measures{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.mt-scope-measure{border:1px solid rgba(15,23,42,.07);border-radius:7px;background:#fff;padding:7px;min-width:0}.mt-scope-measure span{display:block;font-size:9px;font-weight:950;color:#667085;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-scope-measure strong{display:block;margin-top:3px;font-size:12px;font-weight:1000;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .mt-project-notes{display:flex;flex-direction:column;gap:7px}.mt-note-compose{position:relative;display:flex;flex-direction:column;gap:6px}.mt-note-compose textarea{width:100%;min-height:68px;box-sizing:border-box;resize:vertical;border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:8px;font:inherit;font-size:11px;line-height:1.4;color:#344054}.mt-note-compose-foot{display:flex;align-items:center;justify-content:space-between;gap:6px}.mt-note-visibility{width:28px;height:28px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;color:#667085;cursor:pointer}.mt-note-save{border:0;border-radius:7px;background:#111827;color:#fff;height:28px;padding:0 9px;font-size:9px;font-weight:1000;cursor:pointer}.mt-note-visibility-pop{position:absolute;right:0;top:72px;z-index:2147483000;width:max-content;min-width:170px;min-height:34px;padding:5px;display:grid;grid-auto-rows:minmax(30px,auto);gap:2px;overflow:visible;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;color:#344054;box-shadow:0 12px 32px rgba(15,23,42,.18)}.mt-note-visibility-pop[hidden]{display:none!important}.mt-note-visibility-pop button{width:100%;min-height:30px;border:0;border-radius:6px;background:#fff;padding:7px;display:flex;align-items:center;gap:7px;text-align:left;white-space:nowrap;font-size:10px;font-weight:900;color:#344054;cursor:pointer}.mt-note-visibility-pop button:hover{background:#f2f4f7}.mt-note-list{display:flex;flex-direction:column;gap:6px}.mt-note-card{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:7px;display:flex;flex-direction:column;gap:5px}.mt-note-card p{margin:0;white-space:pre-wrap;font-size:10px;line-height:1.4;color:#344054}.mt-note-meta{display:flex;align-items:center;justify-content:space-between;gap:5px;color:#667085;font-size:8px;font-weight:850}.mt-note-meta>span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-note-actions{display:flex}.mt-note-actions button{width:20px;height:20px;border:0;background:transparent;color:#98a2b3;padding:0;cursor:pointer}.mt-note-empty{padding:8px;text-align:center;color:#98a2b3;font-size:9px;font-weight:850}
      dialog.mt-modal{border:0!important;padding:0!important;background:transparent!important;overflow:visible;max-width:none!important;max-height:none!important}dialog.mt-modal[open]{inset:0!important;width:100vw!important;height:100vh!important;margin:0!important;display:grid;place-items:center}dialog.mt-modal::backdrop{background:rgba(15,23,42,.48);backdrop-filter:blur(5px)}.mt-modal-backdrop-hit{position:absolute;inset:0;z-index:0}.mt-modal-shell{position:relative;z-index:1;background:#fff;border:1px solid rgba(15,23,42,.1);border-radius:16px;box-shadow:0 30px 90px rgba(15,23,42,.3);overflow:hidden}.mt-modal-head{min-height:62px;padding:13px 16px;border-bottom:1px solid #eaecf0;display:flex;align-items:center;justify-content:space-between;gap:14px}.mt-modal-title{display:flex;align-items:center;gap:10px;min-width:0}.mt-modal-title i{width:34px;height:34px;border-radius:10px;background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025));display:grid;place-items:center}.mt-modal-title strong{display:block;font-size:15px;font-weight:1000;color:#101828}.mt-modal-title span{display:block;margin-top:2px;font-size:10px;font-weight:850;color:#667085}.mt-modal-close{width:34px;height:34px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#475467;cursor:pointer}.mt-modal-foot{padding:12px 16px;border-top:1px solid #eaecf0;display:flex;align-items:center;justify-content:space-between;gap:10px;background:#f8fafc}
      .mt-new-list-modal{width:min(470px,calc(100vw - 28px))}.mt-new-list-body{padding:16px;display:grid;gap:13px}.mt-color-field{display:grid;grid-template-columns:44px minmax(0,1fr);gap:9px}.mt-color-field input[type="color"]{width:44px;height:38px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:3px}
      .mt-order-modal{width:min(1120px,calc(100vw - 28px));height:min(720px,calc(100vh - 28px));display:grid;grid-template-rows:auto minmax(0,1fr) auto}.mt-order-layout{min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr)}.mt-order-providers{padding:0 16px;border-bottom:1px solid #eaecf0;background:#f8fafc;display:flex;align-items:stretch;gap:4px;overflow-x:auto}.mt-provider{width:auto;min-width:150px;border:0;border-bottom:3px solid transparent;background:transparent;padding:9px 12px 8px;text-align:left;color:#344054;cursor:pointer;display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px;align-items:center}.mt-provider i{width:28px;height:28px;border-radius:8px;background:#fff;border:1px solid #e4e7ec;display:grid;place-items:center}.mt-provider strong{display:block;font-size:11px;font-weight:1000}.mt-provider span{display:block;margin-top:2px;font-size:9px;font-weight:850;color:#98a2b3}.mt-provider:hover{background:rgba(255,255,255,.7)}.mt-provider.active{background:#fff;border-bottom-color:var(--primary-readable,var(--primary,#d93025));color:var(--primary-readable,var(--primary,#d93025))}.mt-order-content{min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:13px}.mt-order-content.manual{overflow:hidden;display:grid;grid-template-columns:minmax(280px,.72fr) minmax(0,1.28fr);gap:16px}.mt-order-details{min-width:0;min-height:0;overflow:auto;padding-right:2px;display:flex;flex-direction:column;gap:13px}.mt-order-coming{height:100%;min-height:280px;display:grid;place-items:center;text-align:center;color:#667085}.mt-order-coming i{font-size:30px;color:#98a2b3}.mt-order-coming strong{display:block;margin-top:10px;font-size:15px;color:#344054}.mt-order-summary{display:grid;grid-template-columns:1fr;gap:8px}.mt-order-summary > div{border:1px solid #eaecf0;border-radius:9px;padding:9px;background:#f8fafc}.mt-order-summary span{display:block;font-size:9px;font-weight:1000;color:#667085;text-transform:uppercase}.mt-order-summary strong{display:block;margin-top:4px;font-size:12px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-email-preview{min-width:0;min-height:0;border:1px solid #d0d5dd;border-radius:11px;background:#fff;overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr)}.mt-email-preview-head{padding:10px 12px;border-bottom:1px solid #eaecf0;background:#f8fafc;display:flex;align-items:center;justify-content:space-between;gap:10px}.mt-email-preview-head strong{min-width:0;font-size:11px;color:#344054;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-email-copy{flex:0 0 auto;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;height:32px;padding:0 10px;font-size:10px;font-weight:1000;display:inline-flex;align-items:center;gap:6px;cursor:pointer;transition:.16s ease}.mt-email-copy.copied{border-color:#75e0a7;background:#ecfdf3;color:#067647}.mt-email-copy.failed{border-color:#fda29b;background:#fef3f2;color:#b42318}.mt-email-body{min-height:0;overflow:auto;padding:12px;font-size:11px;line-height:1.5;color:#344054}.mt-email-body p{margin:0 0 10px}.mt-order-table{width:100%;border-collapse:collapse}.mt-order-table th,.mt-order-table td{border:1px solid #e4e7ec;padding:7px;text-align:left;font-size:10px;vertical-align:top}.mt-order-table th{background:#f8fafc;color:#667085;text-transform:uppercase}.mt-order-table th:nth-child(1){width:35%}.mt-order-table th:nth-child(2){width:35%}.mt-order-table td:nth-child(3),.mt-order-table td:nth-child(4){white-space:nowrap}.mt-order-detail{display:block}.mt-order-detail+.mt-order-detail{margin-top:2px}.mt-order-detail strong{font-size:9px;color:#667085}.mt-order-lock-note{display:flex;align-items:flex-start;gap:8px;border:1px solid #fedf89;border-radius:9px;background:#fffaeb;color:#93370d;padding:9px;font-size:10px;font-weight:850;line-height:1.4}.mt-order-lock-note.ordered{border-color:#abefc6;background:#ecfdf3;color:#067647}
      .mt-order-modal{width:min(1440px,calc(100vw - 48px));height:calc(100vh - 48px);max-height:920px}.mt-order-layout{grid-template-rows:auto auto minmax(0,1fr)}.mt-order-workflow-tabs{min-height:44px;padding:0 16px;border-bottom:1px solid #eaecf0;background:#fff;display:flex;align-items:end;gap:18px}.mt-order-workflow-tabs button{height:44px;border:0;border-bottom:2px solid transparent;background:transparent;color:#667085;padding:0 2px;display:flex;align-items:center;gap:7px;font-size:11px;font-weight:950;cursor:pointer}.mt-order-workflow-tabs button.active{border-bottom-color:#101828;color:#101828}.mt-order-workflow-tabs .required{border-radius:999px;background:#fff3e0;color:#b54708;padding:2px 6px;font-size:8px;text-transform:uppercase}.mt-order-workflow-tabs .complete{width:17px;height:17px;border-radius:999px;background:#ecfdf3;color:#067647;display:grid;place-items:center;font-size:8px}.mt-order-section-head{display:flex;align-items:end;justify-content:space-between;gap:8px}.mt-order-section-head>div span{display:block;font-size:9px;font-weight:1000;color:#667085;text-transform:uppercase}.mt-order-section-head>div strong{display:block;margin-top:2px;font-size:12px;color:#101828}.mt-order-section-head>span{font-size:9px;color:#98a2b3}.mt-order-list-picker{display:flex;flex-direction:column;gap:7px}.mt-order-list-options{display:flex;flex-direction:column;gap:5px}.mt-order-list-option{min-width:0;border:1px solid #e4e7ec;border-radius:9px;background:#fff;padding:7px 8px;display:grid;grid-template-columns:18px 9px minmax(0,1fr) auto;align-items:center;gap:7px;cursor:pointer}.mt-order-list-option.selected{border-color:rgba(var(--primary-rgb,217,48,37),.3);background:rgba(var(--primary-rgb,217,48,37),.035)}.mt-order-list-option input{position:absolute;opacity:0;pointer-events:none}.mt-order-list-check{width:16px;height:16px;border:1px solid #d0d5dd;border-radius:5px;background:#fff;color:transparent;display:grid;place-items:center;font-size:8px}.mt-order-list-option.selected .mt-order-list-check{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}.mt-order-list-option>span:nth-of-type(3){min-width:0}.mt-order-list-option strong{display:block;font-size:10px;color:#344054;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-order-list-option small{display:block;margin-top:2px;font-size:8px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-order-list-option em{font-style:normal;font-size:8px;font-weight:950;color:#667085;white-space:nowrap}.mt-order-list-option em.ordered{color:#067647}.mt-request-list-dot{width:9px;height:9px;border-radius:999px;background:var(--list-color,#667085);box-shadow:0 0 0 2px color-mix(in srgb,var(--list-color,#667085) 15%,transparent)}.mt-order-summary>button{width:100%;border:1px solid #eaecf0;border-radius:9px;padding:9px;background:#f8fafc;display:grid;grid-template-columns:minmax(0,1fr) auto;text-align:left;cursor:pointer}.mt-order-summary>button span,.mt-order-summary>button strong{grid-column:1}.mt-order-summary>button i{grid-column:2;grid-row:1 / span 2;align-self:center;color:#98a2b3}.mt-request-group{margin:12px 0 18px}.mt-request-delivery{border-radius:8px 8px 0 0;background:#f2f4f7;color:#344054;padding:8px 10px;display:flex;align-items:center;gap:7px}.mt-request-delivery strong{font-size:10px}.mt-request-list-head{padding:8px 2px 6px;display:grid;grid-template-columns:9px minmax(0,1fr) auto;align-items:center;gap:7px}.mt-request-list-head strong{font-size:11px}.mt-request-list-head>span:last-child{font-size:9px;color:#667085}.mt-order-content.schedule{overflow:hidden;display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1fr);gap:0;padding:0}.mt-order-schedule-side{min-height:0;overflow:auto;padding:16px;border-right:1px solid #eaecf0;background:#f8fafc;display:flex;flex-direction:column;gap:14px}.mt-order-schedule-tip{border:1px solid #d1e9ff;border-radius:9px;background:#eff8ff;color:#175cd3;padding:9px;display:flex;align-items:flex-start;gap:7px;font-size:9px;line-height:1.4}.mt-order-scheduler{min-width:0;min-height:0;overflow:auto;padding:18px 20px;background:#fff}.mt-order-scheduler-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.mt-order-scheduler-head span{display:block;font-size:9px;font-weight:1000;color:#667085;text-transform:uppercase}.mt-order-scheduler-head strong{display:block;margin-top:3px;font-size:15px;color:#101828}.mt-order-scheduler-head button{border:0;background:transparent;color:#475467;font-size:10px;font-weight:950;cursor:pointer}.mt-order-timing-choices{margin-top:16px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.mt-order-timing-choices>button{min-height:72px;border:1px solid #d0d5dd;border-radius:11px;background:#fff;color:#475467;padding:12px;text-align:left;display:grid;grid-template-columns:30px minmax(0,1fr);gap:10px;align-items:center;cursor:pointer}.mt-order-timing-choices>button>i{width:30px;height:30px;border-radius:9px;background:#f2f4f7;display:grid;place-items:center}.mt-order-timing-choices>button strong,.mt-order-timing-choices>button small{display:block}.mt-order-timing-choices>button strong{font-size:11px;color:#344054}.mt-order-timing-choices>button small{margin-top:3px;font-size:9px;color:#667085}.mt-order-timing-choices>button.active{border-color:rgba(var(--primary-rgb,217,48,37),.38);background:rgba(var(--primary-rgb,217,48,37),.045);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.08)}.mt-order-timing-choices>button.active>i{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}.mt-order-schedule-mode{margin-top:16px;padding:3px;border:1px solid #e4e7ec;border-radius:9px;background:#f2f4f7;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px}.mt-order-schedule-mode button{height:32px;border:0;border-radius:7px;background:transparent;color:#667085;font-size:9px;font-weight:950;cursor:pointer}.mt-order-schedule-mode button.active{background:#fff;color:#101828;box-shadow:0 2px 6px rgba(15,23,42,.08)}.mt-order-schedule-cards{margin-top:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.mt-order-schedule-card{border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:12px;display:flex;flex-direction:column;gap:11px}.mt-order-schedule-card.shared{grid-column:1/-1}.mt-order-schedule-card-title{display:flex;align-items:center;gap:9px}.mt-order-schedule-card-title>i{width:30px;height:30px;border-radius:9px;background:#eff8ff;color:#175cd3;display:grid;place-items:center}.mt-order-schedule-card-title>div{min-width:0}.mt-order-schedule-card-title strong,.mt-order-schedule-card-title span{display:block}.mt-order-schedule-card-title strong{font-size:11px;color:#344054}.mt-order-schedule-card-title span{margin-top:2px;font-size:9px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-order-date-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.7fr);gap:8px}.mt-order-date-fields label>span{display:block;margin-bottom:4px;font-size:9px;font-weight:950;color:#475467}.mt-order-date-fields em{font-style:normal;color:#b54708}.mt-order-date-fields small{font-weight:800;color:#98a2b3}.mt-order-date-fields input{width:100%;box-sizing:border-box;height:36px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:0 9px;color:#344054;font:inherit;font-size:10px}.mt-order-no-dates,.mt-order-timing-empty{margin-top:18px;min-height:150px;border:1px dashed #d0d5dd;border-radius:11px;background:#f8fafc;color:#667085;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:18px}.mt-order-no-dates>i,.mt-order-timing-empty>i{font-size:24px;color:#98a2b3}.mt-order-no-dates strong,.mt-order-timing-empty strong{margin-top:9px;font-size:12px;color:#344054}.mt-order-no-dates p,.mt-order-timing-empty span{max-width:420px;margin:5px 0 0;font-size:10px;line-height:1.45}
      @container materials-workspace (max-width:900px){.mt-material-grid{grid-template-columns:1fr}.mt-toolbar{grid-template-columns:1fr}.mt-top{align-items:flex-start;flex-direction:column}.mt-top .mt-actions{justify-content:flex-start;width:100%}.mt-summary-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media (max-width:980px){.mt-material-grid{grid-template-columns:1fr}.mt-toolbar{grid-template-columns:1fr}.mt-summary-grid{grid-template-columns:1fr}.mt-form-grid{grid-template-columns:1fr}.mt-labor-breakdown{grid-template-columns:1fr}.mt-labor-breakdown-group+.mt-labor-breakdown-group{border-left:0;border-top:1px solid #eaecf0}.mt-top{align-items:flex-start;flex-direction:column}.mt-actions{justify-content:flex-start}.mt-order-content.manual{grid-template-columns:minmax(240px,.7fr) minmax(0,1.3fr)}.mt-order-content.schedule{grid-template-columns:240px minmax(0,1fr)}.mt-order-schedule-cards{grid-template-columns:1fr}.mt-order-modal{height:calc(100vh - 24px);width:calc(100vw - 24px)}}
      @media (max-width:720px){.mt-order-content.manual{overflow:auto;display:flex}.mt-order-details{overflow:visible}.mt-email-preview{min-height:360px;flex:0 0 auto}.mt-email-body{overflow:auto}.mt-provider{min-width:132px}.mt-order-content.schedule{overflow:auto;display:flex}.mt-order-schedule-side{overflow:visible;border-right:0;border-bottom:1px solid #eaecf0}.mt-order-scheduler{overflow:visible}.mt-order-timing-choices{grid-template-columns:1fr}.mt-order-schedule-mode{grid-template-columns:1fr}.mt-order-date-fields{grid-template-columns:1fr}}
      @media (max-width:620px){.mt-top{padding:10px}.mt-main{padding:9px}.mt-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));width:100%}.mt-actions .mt-icon-btn{width:100%}.mt-order-providers{padding:0 8px}.mt-provider{min-width:120px;padding-inline:8px}.mt-order-modal{width:calc(100vw - 12px);height:calc(100vh - 12px)}.mt-modal-foot{align-items:stretch;flex-direction:column-reverse}.mt-modal-foot .mt-actions{grid-template-columns:1fr 1fr}.mt-scope-measures{grid-template-columns:1fr 1fr}}
      .mt-order-layout{grid-template-rows:auto minmax(0,1fr)}.mt-order-content.manual{grid-template-columns:minmax(330px,.72fr) minmax(0,1.28fr);padding:14px;gap:14px}.mt-order-details{gap:11px}
      .mt-order-list-options{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(142px,1fr);grid-template-rows:1fr;gap:6px;overflow-x:auto;padding:3px 3px 7px;scrollbar-width:thin}.mt-order-list-option{appearance:none;width:100%;min-width:0;min-height:64px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#344054;padding:8px;display:grid;grid-template-columns:9px minmax(0,1fr);grid-template-rows:auto auto;align-items:center;gap:3px 7px;text-align:left;cursor:pointer}.mt-order-list-option>.mt-request-list-dot{grid-column:1;grid-row:1/span 2}.mt-order-list-option>span:nth-of-type(2){grid-column:2;grid-row:1;min-width:0}.mt-order-list-option>em{grid-column:2;grid-row:2;justify-self:start}.mt-order-list-option:hover{border-color:#b8c0cc;background:#f8fafc}.mt-order-list-option.selected{border-color:color-mix(in srgb,var(--primary,#d93025) 42%,#d0d5dd);background:color-mix(in srgb,var(--primary,#d93025) 5%,#fff);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--primary,#d93025) 12%,transparent)}.mt-order-list-option.focused{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.11)}.mt-order-list-picker.scheduling .mt-order-list-option:not(.focused){opacity:.78}.mt-order-section-head>button{border:0;background:transparent;color:#475467;padding:2px;font-size:9px;font-weight:950;cursor:pointer}.mt-order-section-head>button:hover{color:var(--primary-readable,var(--primary,#d93025))}
      .mt-order-delivery-choice{border:1px solid #e4e7ec;border-radius:11px;background:#f8fafc;padding:10px}.mt-required-pill{border-radius:999px;background:#fff3e0;color:#b54708!important;padding:3px 7px;font-size:8px!important;font-weight:1000;text-transform:uppercase}.mt-order-delivery-choice .mt-order-timing-choices{margin-top:8px;gap:7px}.mt-order-delivery-choice .mt-order-timing-choices>button{min-height:60px;padding:8px;grid-template-columns:26px minmax(0,1fr);gap:8px;border-radius:9px}.mt-order-delivery-choice .mt-order-timing-choices>button>i{width:26px;height:26px;border-radius:7px}.mt-order-delivery-choice .mt-order-timing-choices>button strong{font-size:10px}.mt-order-delivery-choice .mt-order-timing-choices>button small{font-size:8px}.mt-order-no-date-note{margin-top:8px;border-radius:8px;background:#fff;color:#667085;padding:8px;display:flex;align-items:flex-start;gap:7px;font-size:9px;line-height:1.4}.mt-order-no-date-note i{color:#175cd3;margin-top:1px}
      .mt-request-instructions{margin:12px 0 16px;border:1px solid #d1e9ff;border-radius:9px;background:#eff8ff;padding:10px;color:#1849a9}.mt-request-instructions>strong{font-size:10px}.mt-request-instructions ul{list-style:none;margin:7px 0 0;padding:0;display:grid;gap:7px}.mt-request-instructions li{display:grid;grid-template-columns:9px minmax(0,1fr);align-items:start;gap:7px;font-size:10px;line-height:1.45}.mt-request-instructions .mt-request-list-dot{margin-top:3px}.mt-request-list-instruction{margin:0 0 8px!important;border-left:3px solid #d0d5dd;padding:6px 8px;background:#f8fafc;color:#344054;font-weight:850}.mt-request-group{margin:15px 0 20px}.mt-request-list-head{padding-top:0}
      .mt-order-calendar-panel{min-width:0;min-height:0;border:1px solid #d0d5dd;border-radius:11px;background:#fff;overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr)}.mt-order-calendar-head{padding:10px 12px;border-bottom:1px solid #eaecf0;background:#f8fafc;display:flex;align-items:center;justify-content:space-between;gap:12px}.mt-order-calendar-head>div{min-width:0}.mt-order-calendar-head span,.mt-order-calendar-head strong,.mt-order-calendar-head small{display:block}.mt-order-calendar-head span{font-size:8px;font-weight:1000;color:#667085;text-transform:uppercase}.mt-order-calendar-head strong{margin-top:2px;font-size:13px;color:#101828}.mt-order-calendar-head small{margin-top:2px;font-size:9px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-order-calendar-head button{flex:0 0 auto;height:31px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;padding:0 9px;font-size:9px;font-weight:950;cursor:pointer}.mt-order-calendar{min-width:0;min-height:0;overflow:auto;background:#fff}.mt-order-calendar>.prs-wrap{min-height:100%;border:0;border-radius:0;box-shadow:none}.mt-order-calendar .prs-toolbar{position:sticky;top:0;z-index:8}.mt-order-calendar-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#667085}.mt-order-calendar-empty i{font-size:25px}.mt-order-calendar-empty strong{margin-top:8px;color:#344054}.mt-order-calendar-empty span{margin-top:4px;font-size:10px}
      .mt-order-content.manual.calendar-mode{padding:14px 0 0 14px;gap:14px}.mt-order-content.manual.calendar-mode .mt-order-details{padding-bottom:14px}.mt-order-calendar-panel{width:100%;max-width:100%;box-sizing:border-box;border-width:0 0 0 1px;border-radius:0}.mt-order-calendar-head{padding:13px 16px;box-sizing:border-box}.mt-order-calendar-head>div:first-child{flex:1 1 auto}.mt-order-calendar-actions{flex:0 0 auto;display:flex;align-items:center;gap:7px}.mt-order-calendar-head button.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:var(--on-primary,#fff)}.mt-order-calendar-head button:disabled{opacity:.5;cursor:not-allowed}.mt-order-calendar{width:100%;max-width:100%;box-sizing:border-box;overflow:hidden}.mt-order-calendar>.prs-wrap{width:100%;max-width:100%;min-width:0;box-sizing:border-box;gap:0}.mt-order-calendar .prs-toolbar{width:100%;max-width:100%;box-sizing:border-box;padding:10px 14px;background:#fff;border-bottom:1px solid #eaecf0}.mt-order-calendar .prs-surface{width:100%;max-width:100%;box-sizing:border-box;border:0;border-radius:0;box-shadow:none;overflow:auto;scrollbar-gutter:stable}.mt-order-calendar .prs-time-grid,.mt-order-calendar .prs-all-day-grid,.mt-order-calendar .prs-month{box-sizing:border-box}
      .mt-order-date-summary{margin-top:8px;display:grid;gap:5px}.mt-order-date-summary>div{min-width:0;border:1px solid #e4e7ec;border-radius:7px;background:#fff;padding:6px 8px;display:grid;grid-template-columns:minmax(80px,.65fr) minmax(0,1.35fr);gap:8px;align-items:center}.mt-order-date-summary strong{font-size:9px;color:#344054;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-order-date-summary span{font-size:8px;color:#667085;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-required-pill.ready{background:#ecfdf3;color:#067647!important}.mt-order-timing-actions{margin-top:8px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.mt-order-timing-actions>button{min-height:50px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#475467;padding:8px;text-align:left;display:grid;grid-template-columns:24px minmax(0,1fr);gap:7px;align-items:center;cursor:pointer}.mt-order-timing-actions>button>i{width:24px;height:24px;border-radius:7px;background:#f2f4f7;display:grid;place-items:center}.mt-order-timing-actions strong,.mt-order-timing-actions small{display:block}.mt-order-timing-actions strong{font-size:9px;color:#344054}.mt-order-timing-actions small{margin-top:2px;font-size:8px;color:#667085}.mt-order-text-action{margin-top:8px;border:0;background:transparent;color:#667085;padding:2px;font-size:9px;font-weight:950;cursor:pointer}.mt-order-schedule-targets{border:1px solid #d1e9ff;border-radius:10px;background:#eff8ff;padding:10px}.mt-order-target-options{margin-top:8px;display:flex;gap:6px;overflow-x:auto;padding:2px}.mt-order-target{flex:1 0 132px;min-width:132px;border:1px solid #b2ddff;border-radius:8px;background:#fff;color:#344054;padding:7px;display:grid;grid-template-columns:9px minmax(0,1fr);grid-template-rows:auto auto;gap:2px 7px;text-align:left;cursor:pointer}.mt-order-target>.mt-request-list-dot{grid-row:1/span 2;align-self:center}.mt-order-target>span:nth-of-type(2){min-width:0}.mt-order-target strong,.mt-order-target small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-order-target strong{font-size:9px}.mt-order-target small{margin-top:2px;font-size:8px;color:#667085}.mt-order-target em{grid-column:2;font-size:8px;font-style:normal;font-weight:950;color:#175cd3}.mt-order-target.active{border-color:#1570ef;background:#eff8ff;box-shadow:0 0 0 2px #d1e9ff}.mt-email-instruction-list{margin:0 0 16px;padding-left:20px}.mt-email-instruction-list li+li{margin-top:6px}
      @media (max-width:900px){.mt-order-content.manual{overflow:auto;display:flex}.mt-order-details{overflow:visible}.mt-email-preview,.mt-order-calendar-panel{min-height:430px;flex:0 0 auto}.mt-order-list-options{grid-auto-columns:minmax(150px,220px)}}
      @media (max-width:620px){.mt-order-delivery-choice .mt-order-timing-choices{grid-template-columns:1fr}.mt-order-list-options{grid-auto-columns:minmax(145px,76vw)}.mt-order-calendar-head{align-items:flex-start}.mt-order-calendar-head small{white-space:normal}.mt-order-calendar-head button span{display:none}}
    `;
  }

  function panelHtml(){
    return `<div class="mt-app" data-materials-root><div class="mt-empty">${(globalThis.PlatformLanguage?.htmlText("materials","m_9d3e82ecfd10ec","Scope") ?? "Scope")}</div></div>`;
  }

  function defaultSections(){
    return SECTION_DEFS.map((section) => ({ id: section.key, key: section.key, title: section.title }));
  }

  function structureName(structure, index){
    return cleanText(structure.name || structure.label || structure.title || structure.id || structure.structure_id) || `Structure ${index + 1}`;
  }

  function projectStructures(){
    const project = state.project || {};
    const direct = Array.isArray(project.structures) ? project.structures : [];
    const measurement = project.measurement_project || project.measurement || {};
    const measured = Array.isArray(measurement.structures) ? measurement.structures : [];
    const pins = Array.isArray(project.pins) ? project.pins : Array.isArray(project.markers) ? project.markers : [];
    const source = direct.length ? direct : (measured.length ? measured : pins);
    const normalized = source.map((entry, index) => ({
      ...(entry && typeof entry === 'object' ? entry : {}),
      id: cleanText(entry?.id || entry?.structure_id || entry?.pin_id || `structure_${index + 1}`),
      name: structureName(entry || {}, index),
      index
    }));
    if (normalized.length) return normalized;
    return [{ id: 'main', name: 'Main Structure', index: 0 }];
  }

  function structureImage(){
    const photos = Array.isArray(state.project?.photos) ? state.project.photos : [];
    const found = photos.find((photo) => photo?.is_top_down_thumbnail || photo?.designator === 'top_down_thumbnail')
      || photos.find((photo) => /structure|top|roof|map/i.test(`${photo?.label || ''} ${photo?.alt || ''} ${photo?.designator || ''}`))
      || photos[0];
    return cleanText(found?.src || found?.url || found?.thumb || found?.thumbnail || found?.media_url);
  }

  function measurementSource(){
    const project = state.project || {};
    const reportOrderState = state.host?.getReportOrderState?.() || state.context?.reportOrderState || {};
    const reportData = reportOrderState?.data && typeof reportOrderState.data === 'object' ? reportOrderState.data : {};
    const measurement = project.measurement && typeof project.measurement === 'object' ? project.measurement : {};
    const measurementProject = project.measurement_project && typeof project.measurement_project === 'object' ? project.measurement_project : {};
    const raw = {
      ...(reportData.raw && typeof reportData.raw === 'object' ? reportData.raw : {}),
      ...(measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {}),
      ...(measurementProject.raw && typeof measurementProject.raw === 'object' ? measurementProject.raw : {})
    };
    return {
      ...raw,
      ...reportData,
      ...measurement,
      ...measurementProject,
      measurement,
      measurement_project: measurementProject,
      raw,
      manifest: raw.manifest || measurementProject.manifest || measurement.manifest || reportData.manifest,
      report: measurement.report || measurementProject.report || reportData.report,
      result: measurement.result || measurementProject.result || reportData.result,
      results: measurement.results || measurementProject.results || reportData.results,
      data: measurement.data || measurementProject.data || reportData.data,
      measurements: measurement.measurements || measurementProject.measurements || reportData.measurements,
      summary: measurement.summary || measurementProject.summary || reportData.summary,
      insights: measurement.insights || measurementProject.insights || reportData.insights,
      ...(state.measurementExtraSource && typeof state.measurementExtraSource === 'object' ? state.measurementExtraSource : {}),
      project
    };
  }

  function measurementIdFromAssetUrl(...values){
    for (const value of values) {
      const text = cleanText(value);
      if (!text) continue;
      const match = text.match(/\/projects\/([^/?#]+)/i);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
    return '';
  }

  function activeMeasurementProjectId(){
    const project = state.project || {};
    const reportOrderState = state.host?.getReportOrderState?.() || state.context?.reportOrderState || {};
    const measurement = project.measurement_project || project.measurement || {};
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    return cleanText(
      measurement.id
      || measurement.project_id
      || measurement.folder
      || measurement.measurement_project_id
      || raw.folder
      || raw.id
      || raw.project_id
      || reportOrderState?.data?.folder
      || reportOrderState?.data?.project?.id
      || reportOrderState?.data?.project?.project_id
      || project.measurement_project_id
      || measurementIdFromAssetUrl(
        project.report_url,
        project.pdf_url,
        project.summary_url,
        project.xml_url,
        measurement.report_url,
        measurement.pdf_url,
        measurement.summary_url,
        measurement.xml_url,
        raw.report_url,
        raw.pdf_url,
        raw.summary_url,
        raw.xml_url,
        reportOrderState?.reportUrl,
        reportOrderState?.summaryUrl,
        reportOrderState?.xmlUrl
      )
    );
  }

  function numericValue(value){
    if (value == null || value === '') return NaN;
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    if (typeof value === 'object') {
      for (const key of ['value', 'amount', 'total', 'measurement', 'quantity', 'number', 'area', 'length', 'count']) {
        const parsed = numericValue(value[key]);
        if (Number.isFinite(parsed)) return parsed;
      }
      return NaN;
    }
    const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function pitchRiseValue(value){
    if (value == null || value === '') return NaN;
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    if (typeof value === 'object') {
      for (const key of ['pitchRise', 'pitch_rise', 'rise', 'value', 'pitch']) {
        const parsed = pitchRiseValue(value[key]);
        if (Number.isFinite(parsed)) return parsed;
      }
      return NaN;
    }
    const text = String(value).trim();
    const fraction = text.match(/(\d+(?:\.\d+)?)\s*\/\s*12/);
    if (fraction) return Number(fraction[1]);
    const degrees = text.match(/(\d+(?:\.\d+)?)\s*(?:deg|degree|degrees|°)/i);
    if (degrees) return pitchDegreesToRise12(Number(degrees[1]));
    const parsed = Number(text.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) && parsed > 0 && parsed < 40 ? parsed : NaN;
  }

  function firstPitchRise(source){
    const keys = ['pitchRise', 'pitch_rise', 'dominantPitch', 'dominant_pitch', 'averagePitch', 'average_pitch', 'roofPitch', 'roof_pitch', 'pitch'];
    for (const key of keys) {
      const direct = key.split('.').reduce((item, part) => item && typeof item === 'object' ? item[part] : undefined, source);
      const parsed = pitchRiseValue(direct);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  function firstNumber(source, keys){
    const normalizeKey = (key) => String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const aliases = new Set();
    keys.map(normalizeKey).filter(Boolean).forEach((key) => {
      aliases.add(key);
      aliases.add(`${key}sum`);
      aliases.add(`${key}total`);
      aliases.add(`${key}value`);
    });
    for (const key of keys) {
      const direct = String(key).split('.').reduce((item, part) => item && typeof item === 'object' ? item[part] : undefined, source);
      const parsed = numericValue(direct);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    const seen = new Set();
    const scan = (value) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return null;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = scan(item);
          if (found != null) return found;
        }
        return null;
      }
      for (const [key, item] of Object.entries(value)) {
        const normalized = normalizeKey(key);
        if (aliases.has(normalized)) {
          const parsed = numericValue(item);
          if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
      }
      const label = normalizeKey(value.key || value.name || value.label || value.title || value.type || value.field || value.metric);
      if (label && aliases.has(label)) {
        const parsed = numericValue(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
        for (const key of ['value', 'amount', 'total', 'measurement', 'quantity', 'number', 'area', 'length', 'count']) {
          const next = numericValue(value[key]);
          if (Number.isFinite(next) && next > 0) return next;
        }
      }
      for (const item of Object.values(value)) {
        const found = scan(item);
        if (found != null) return found;
      }
      return null;
    };
    return scan(source);
  }

  function sqftToSquares(value){
    const parsed = numericValue(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round((parsed / 100) * 10) / 10 : null;
  }

  function meters2ToSquares(value){
    const parsed = numericValue(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(((parsed * 10.7639104167) / 100) * 10) / 10 : null;
  }

  function pitchDegreesToRise12(degrees){
    const parsed = numericValue(degrees);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(Math.tan((parsed * Math.PI) / 180) * 12)) : null;
  }

  function pitchBucketForRise(rise){
    const parsed = numericValue(rise);
    if (!Number.isFinite(parsed)) return 'pitch4to6Squares';
    if (parsed <= 2) return 'flatRoofSquares';
    if (parsed <= 4) return 'pitch2to4Squares';
    if (parsed <= 6) return 'pitch4to6Squares';
    if (parsed <= 8) return 'pitch6to8Squares';
    if (parsed <= 12) return 'pitch9to12Squares';
    return 'pitch13PlusSquares';
  }

  function dominantPitchRiseFromBuckets(measurements = {}){
    const buckets = [
      ['pitch2to4Squares', 3],
      ['pitch4to6Squares', 5],
      ['pitch6to8Squares', 7],
      ['pitch9to12Squares', 10],
      ['pitch13PlusSquares', 13]
    ];
    const dominant = buckets
      .map(([key, rise]) => ({ rise, squares: number(measurements[key], 0) }))
      .sort((a, b) => b.squares - a.squares)[0];
    return dominant?.squares > 0 ? dominant.rise : 0;
  }

  function pitchLabel(measurements = {}){
    const rise = number(measurements.pitchRise, 0);
    if (rise > 0) return `${Math.round(rise)}/12`;
    return '-';
  }

  function measurementsFromRoofSegments(source){
    const found = [];
    const seen = new Set();
    const visit = (value) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const areaMeters = numericValue(value.roof_area_meters2 ?? value.area_meters2 ?? value.area_m2 ?? value.roofAreaMeters2);
      const areaSqft = numericValue(value.roof_area_sqft ?? value.area_sqft ?? value.roofAreaSqft);
      const areaSquares = numericValue(value.roof_squares ?? value.squares ?? value.roofSquares);
      const pitchRise = numericValue(value.pitch_rise ?? value.pitchRise ?? value.pitch);
      const pitchDegrees = numericValue(value.pitch_degrees ?? value.pitchDegrees ?? value.slope_degrees);
      const squares = Number.isFinite(areaSquares) && areaSquares > 0
        ? areaSquares
        : (Number.isFinite(areaSqft) && areaSqft > 0 ? sqftToSquares(areaSqft) : meters2ToSquares(areaMeters));
      if (squares && (Number.isFinite(pitchRise) || Number.isFinite(pitchDegrees) || Number.isFinite(areaMeters) || Number.isFinite(areaSqft))) {
        found.push({ squares, rise: Number.isFinite(pitchRise) ? pitchRise : pitchDegreesToRise12(pitchDegrees) });
      }
      Object.values(value).forEach(visit);
    };
    visit(source);
    if (!found.length) return {};
    return found.reduce((totals, segment) => {
      const key = pitchBucketForRise(segment.rise);
      totals[key] = Math.round((number(totals[key], 0) + number(segment.squares, 0)) * 10) / 10;
      return totals;
    }, {});
  }

  function xmlTextToMeasurementObject(xmlText){
    const text = cleanText(xmlText);
    if (!text || typeof DOMParser === 'undefined') return {};
    try {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) return {};
      const out = {};
      const addValue = (key, value) => {
        const cleanKey = cleanText(key);
        const parsed = numericValue(value);
        if (!cleanKey || !Number.isFinite(parsed) || parsed <= 0) return;
        if (out[cleanKey] == null) out[cleanKey] = parsed;
        else out[`${cleanKey}_sum`] = number(out[`${cleanKey}_sum`] ?? out[cleanKey], 0) + parsed;
      };
      const walk = (el, path = []) => {
        if (!el || el.nodeType !== 1) return;
        const tag = el.tagName || '';
        const nextPath = [...path, tag].filter(Boolean);
        const children = Array.from(el.children || []);
        const rawText = children.length ? '' : cleanText(el.textContent);
        if (rawText) {
          addValue(tag, rawText);
          addValue(nextPath.join('_'), rawText);
        }
        const label = el.getAttribute?.('name') || el.getAttribute?.('label') || el.getAttribute?.('type') || el.getAttribute?.('key');
        if (label && rawText) addValue(label, rawText);
        Array.from(el.attributes || []).forEach((attr) => {
          addValue(`${tag}_${attr.name}`, attr.value);
          if (label) addValue(`${label}_${attr.name}`, attr.value);
        });
        children.forEach((child) => walk(child, nextPath));
      };
      walk(doc.documentElement);
      return out;
    } catch (error) {
      return {};
    }
  }

  async function fetchMeasurementArtifact(projectId, fileName, type = 'json'){
    if (!projectId || !fileName || !fmUrl) return null;
    try {
      const response = await fetch(fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(fileName)}`));
      if (!response.ok) return null;
      return type === 'text' ? response.text() : response.json();
    } catch (error) {
      return null;
    }
  }

  async function loadMeasurementArtifactSource(projectId){
    if (!projectId || !fmJson) return {};
    const data = await fmJson(`projects/${encodeURIComponent(projectId)}`).catch(() => null);
    const project = data?.project && typeof data.project === 'object' ? data.project : {};
    const manifest = project?.manifest && typeof project.manifest === 'object' ? project.manifest : {};
    const files = Array.isArray(project.files) ? project.files : [];
    const byLower = new Map(files.map((file) => [cleanText(file?.name).toLowerCase(), cleanText(file?.name)]));
    const artifactName = (name) => byLower.get(cleanText(name).toLowerCase()) || '';
    const source = { detail: data, firstmeasure_project: project, firstmeasure_manifest: manifest };
    const xmlName = artifactName('model_data.xml') || 'model_data.xml';
    if (xmlName) {
      const xml = await fetchMeasurementArtifact(projectId, xmlName, 'text');
      source.model_data_xml = xmlTextToMeasurementObject(xml);
    }
    for (const fileName of ['measurements.json', 'measurement.json', 'insights.json', 'instant-structures.json']) {
      const matchedName = artifactName(fileName) || fileName;
      if (!matchedName) continue;
      const json = await fetchMeasurementArtifact(projectId, matchedName, 'json');
      if (json) source[fileName.replace(/[^a-z0-9]/gi, '_')] = json;
    }
    return source;
  }

  function measurementsHaveValues(measurements = projectMeasurements()){
    return ['slopeSquares', 'shingleSquares', 'flatRoofSquares', 'roofSquares', 'eavesLf', 'rakesLf', 'hipsLf', 'ridgesLf', 'valleyLf']
      .some((key) => number(measurements[key], 0) > 0);
  }

  async function requestMeasurementHydration(force = false){
    const measurementId = activeMeasurementProjectId();
    if (!measurementId || state.measurementLoadingId === measurementId || (!force && state.measurementLoadedId === measurementId)) return null;
    if (!force && measurementsHaveValues(reportMeasurements())) return null;
    state.measurementLoadingId = measurementId;
    const reportOrderState = state.host?.getReportOrderState?.() || state.context?.reportOrderState || {};
    const sharedMeasurements = window.FirstMeasureAPI?.roofMeasurements;
    const load = sharedMeasurements?.load
      ? sharedMeasurements.load(state.project || {}, { reportOrderState, force })
      : loadMeasurementArtifactSource(measurementId).then((source) => ({ source, measurements: null }));
    return load.then((result) => {
      state.measurementLoadedId = measurementId;
      state.measurementLoadingId = '';
      if (!result || typeof result !== 'object') return;
      state.measurementExtraSource = result.source || {};
      state.roofMeasurements = result.measurements || null;
      if (state.active) {
        renderLeft();
        syncMaterialsGrid();
      }
    }).catch(() => {
      state.measurementLoadedId = measurementId;
      state.measurementLoadingId = '';
      return null;
    });
  }

  async function regenerateMeasurementsFromReport(){
    state.measurementRefreshing = true;
    state.measurementOverrides = {};
    state.measurementExtraSource = {};
    state.roofMeasurements = null;
    state.measurementLoadedId = '';
    renderLeft();
    const minimumFeedback = new Promise((resolve) => setTimeout(resolve, 650));
    await Promise.all([requestMeasurementHydration(true), minimumFeedback]);
    state.measurementRefreshing = false;
    renderLeft();
    syncMaterialsGrid();
  }

  function reportMeasurements(){
    if (window.FirstMeasureAPI?.roofMeasurements?.fromProject) {
      const reportOrderState = state.host?.getReportOrderState?.() || state.context?.reportOrderState || {};
      const canonical = window.FirstMeasureAPI.roofMeasurements.fromProject(state.project || {}, {
        reportOrderState,
        source: state.measurementExtraSource
      });
      const measurements = state.roofMeasurements || canonical.measurements;
      if (window.FirstMeasureAPI.roofMeasurements.hasValues?.(measurements)) {
        return { ...measurements, structures: projectStructures().length };
      }
    }
    const source = measurementSource();
    const squaresFromSqft = (keys) => {
      const value = firstNumber(source, keys);
      return value == null ? null : sqftToSquares(value);
    };
    const squaresFromMeters2 = (keys) => meters2ToSquares(firstNumber(source, keys));
    const segmentMeasurements = measurementsFromRoofSegments(source);
    const flatRoofSquares = firstNumber(source, ['flatRoofSquares', 'flat_roof_squares', 'flat_squares', 'flat', 'low_slope', 'low_slope_squares'])
      ?? squaresFromSqft(['flat_roof_sqft', 'flat_roof_area_sqft', 'flat_area_sqft'])
      ?? squaresFromMeters2(['flat_roof_meters2', 'flat_roof_area_meters2'])
      ?? segmentMeasurements.flatRoofSquares
      ?? 0;
    const pitch2to4Squares = firstNumber(source, ['pitch2to4Squares', 'pitch_2_4_squares', 'pitch_2to4_squares', '2_4_squares', '2to4', '2-4'])
      ?? squaresFromSqft(['pitch_2_4_sqft', 'pitch_2to4_sqft'])
      ?? segmentMeasurements.pitch2to4Squares
      ?? 0;
    const pitch4to6Squares = firstNumber(source, ['pitch4to6Squares', 'pitch_4_6_squares', 'pitch_4to6_squares', '4_6_squares', '4to6', '4-6'])
      ?? squaresFromSqft(['pitch_4_6_sqft', 'pitch_4to6_sqft'])
      ?? segmentMeasurements.pitch4to6Squares
      ?? 0;
    const pitch6to8Squares = firstNumber(source, ['pitch6to8Squares', 'pitch_6_8_squares', 'pitch_6to8_squares', '6_8_squares', '6to8', '6-8'])
      ?? squaresFromSqft(['pitch_6_8_sqft', 'pitch_6to8_sqft'])
      ?? segmentMeasurements.pitch6to8Squares
      ?? 0;
    const pitch9to12Squares = firstNumber(source, ['pitch9to12Squares', 'pitch_9_12_squares', 'pitch_9to12_squares', '9_12_squares', '9to12', '9-12'])
      ?? squaresFromSqft(['pitch_9_12_sqft', 'pitch_9to12_sqft'])
      ?? segmentMeasurements.pitch9to12Squares
      ?? 0;
    const pitch13PlusSquares = firstNumber(source, ['pitch13PlusSquares', 'pitch_13_plus_squares', 'pitch_13plus_squares', '13_plus_squares', '13plus', '13+'])
      ?? squaresFromSqft(['pitch_13_plus_sqft', 'pitch_13plus_sqft'])
      ?? segmentMeasurements.pitch13PlusSquares
      ?? 0;
    const pitchedSquares = Math.round((pitch2to4Squares + pitch4to6Squares + pitch6to8Squares + pitch9to12Squares + pitch13PlusSquares) * 10) / 10;
    const pitchRise = firstPitchRise(source) ?? dominantPitchRiseFromBuckets({
      pitch2to4Squares,
      pitch4to6Squares,
      pitch6to8Squares,
      pitch9to12Squares,
      pitch13PlusSquares
    });
    const totalSquares = firstNumber(source, ['roofSquares', 'roof_squares', 'totalSquares', 'total_squares', 'total_roof_squares'])
      ?? squaresFromSqft(['roof_sqft', 'roof_area_sqft', 'total_roof_area_sqft', 'total_roof_sqft', 'total_area_sqft', 'area_sqft', 'roof_area', 'roofarea', 'total_roof_area', 'total_area'])
      ?? squaresFromMeters2(['total_roof_area_meters2', 'whole_roof_area_meters2', 'roof_area_meters2']);
    const shingleSquares = firstNumber(source, ['shingleSquares', 'shingle_squares', 'slopeSquares', 'slope_squares', 'steep_slope_squares'])
      ?? (pitchedSquares > 0 ? pitchedSquares : null)
      ?? (totalSquares ? Math.max(0, Math.round((totalSquares - flatRoofSquares) * 10) / 10) : 0);
    const roofSquares = totalSquares || Math.round((shingleSquares + flatRoofSquares) * 10) / 10;
    return {
      roofSquares,
      slopeSquares: shingleSquares,
      shingleSquares,
      flatRoofSquares,
      pitch2to4Squares,
      pitch4to6Squares,
      pitch6to8Squares,
      pitch9to12Squares,
      pitch13PlusSquares,
      pitchRise,
      eavesLf: firstNumber(source, ['eavesLf', 'eaves_lf', 'eave_length']) || 0,
      rakesLf: firstNumber(source, ['rakesLf', 'rakes_lf', 'rake_length', 'rakes', 'rake']) || 0,
      hipsLf: firstNumber(source, ['hipsLf', 'hips_lf', 'hip_length', 'hips', 'hip']) || 0,
      ridgesLf: firstNumber(source, ['ridgesLf', 'ridges_lf', 'ridge_length', 'ridges', 'ridge']) || 0,
      valleyLf: firstNumber(source, ['valleyLf', 'valley_lf', 'valleys_lf', 'valley_length', 'valleys', 'valley']) || 0,
      wastePercent: firstNumber(source, ['wastePercent', 'waste_percent']) || 10,
      structures: projectStructures().length
    };
  }

  function projectMeasurements(){
    const base = reportMeasurements();
    const overrides = state.measurementOverrides || {};
    const customFields = rootWindow.FirstMateCustomFields?.valuesForFormula?.(state.project || {}) || {};
    const merged = { ...base, ...customFields, ...overrides };
    const roundMeasurement = (value, fallback = 0) => Math.round(number(value, fallback));
    merged.slopeSquares = roundMeasurement(merged.slopeSquares ?? merged.shingleSquares, 0);
    merged.shingleSquares = merged.slopeSquares;
    merged.flatRoofSquares = roundMeasurement(merged.flatRoofSquares, 0);
    merged.eavesLf = roundMeasurement(merged.eavesLf, 0);
    merged.rakesLf = roundMeasurement(merged.rakesLf, 0);
    merged.hipsLf = roundMeasurement(merged.hipsLf, 0);
    merged.ridgesLf = roundMeasurement(merged.ridgesLf, 0);
    merged.valleyLf = roundMeasurement(merged.valleyLf, 0);
    merged.wastePercent = roundMeasurement(merged.wastePercent, 10);
    merged.pitchRise = roundMeasurement(merged.pitchRise || dominantPitchRiseFromBuckets(merged), 0);
    return merged;
  }

  function loadPricebookItems(loadContext){
    const pb = pricebook();
    if (!pb) {
      if (loadContextIsCurrent(loadContext)) state.pricebookItems = [];
      return Promise.resolve([]);
    }
    return Promise.resolve(pb.loadState?.()).catch(() => null).then(() => {
      const items = Array.isArray(pb.getState?.().items) ? pb.getState().items : [];
      if (loadContextIsCurrent(loadContext)) state.pricebookItems = items;
      return items;
    });
  }

  function pricebookId(){
    return cleanText(cfg.pricebookId || window.__APP?.pricebookId || 'branch_pricebook');
  }

  function defaultPricebookItemsForGeneration(){
    const pb = pricebook();
    if (typeof pb?.defaultItemsForGeneration === 'function') return uniqueGenerationCatalogItems(pb.defaultItemsForGeneration());
    const byType = new Map();
    state.pricebookItems.filter((item) => item.autoAdd).forEach((item) => {
      const typeId = cleanText(item.itemTypeId || item.item_type_id || item.id);
      const current = byType.get(typeId);
      if (!current || item.isDefaultVariant || (!current.isDefaultVariant && item.variantRole === 'generic')) byType.set(typeId, item);
    });
    return [...byType.values()];
  }

  function catalogItemTypeId(item){
    return cleanText(item?.itemTypeId || item?.item_type_id || item?.itemType?.id || item?.id);
  }

  function lineItemTypeId(item){
    const direct = cleanText(item?.item_type_id
      || item?.product_selection?.item_type_id
      || item?.pricebook_ref?.item_type_id
      || item?.pricebook_snapshot?.item_type?.id
      || item?.pricebook_snapshot?.item?.itemTypeId);
    if (direct) return direct;
    const catalog = variantCatalogItemForLine(item);
    if (catalogItemTypeId(catalog)) return catalogItemTypeId(catalog);
    return inferLineItemTypeId(item);
  }

  function linePricebookItemId(item){
    return cleanText(item?.pricebook_ref?.item_id || item?.pricebookItemId || item?.product_selection?.variant_item_id);
  }

  function inferLineItemTypeId(item){
    const text = `${item?.name || ''} ${item?.description || ''} ${item?.product_selection?.variant_name || ''} ${item?.pricebook_snapshot?.variant?.name || ''}`.toLowerCase();
    const category = cleanText(item?.category || item?.pricebook_snapshot?.item?.category);
    if (/ridge\s*vent/.test(text)) return 'ridge_vent';
    if (/ridge\s*cap/.test(text)) return 'ridge_cap';
    if (/starter/.test(text)) return 'starter';
    if (/underlayment|feltbuster|tiger\s*paw|shinglemate|roof deck protection/.test(text)) return 'underlayment';
    if (/ice\s*&?\s*water|weatherwatch|weatherlock|leak barrier|ice barrier/.test(text)) return 'leak_barrier';
    if (/drip\s*edge/.test(text)) return 'drip_edge';
    if (/valley/.test(text)) return 'valley_metal';
    if (/timberline|duration|malarkey|vista|architectural|3[-\s]?tab|presidential|shingle/.test(text)) return 'field_shingles';
    if (category === 'leak_barriers') return 'leak_barrier';
    if (category === 'underlayments') return 'underlayment';
    if (category === 'shingle_roofs') return 'field_shingles';
    if (category === 'flat_roofs') return 'flat_roof_membrane';
    return '';
  }

  function canonicalCategoryForType(typeId, fallback = ''){
    const id = cleanText(typeId);
    if (id === 'field_shingles' || id === 'starter' || id === 'ridge_cap' || id === 'steep_slope') return 'shingle_roofs';
    if (id === 'underlayment') return 'underlayments';
    if (id === 'leak_barrier') return 'leak_barriers';
    if (id === 'drip_edge' || id === 'valley_metal' || /flashing|metal/.test(id)) return 'flashing';
    if (id === 'flat_roof_membrane') return 'flat_roofs';
    return cleanText(fallback);
  }

  function sectionForMaterialType(typeId, fallbackCategory = '', fallbackSection = ''){
    const category = canonicalCategoryForType(typeId, fallbackCategory);
    return CATEGORY_TO_SECTION[category] || cleanText(fallbackSection) || 'accessories';
  }

  function lineSectionKey(item){
    const type = cleanText(item?.__resource_type || materialListById(item?.__material_list_id)?.resource_type).toLowerCase();
    if (type === 'labor' || type === 'equipment') return type;
    const typeId = lineItemTypeId(item);
    if (typeId) return sectionForMaterialType(typeId, item?.category || item?.pricebook_snapshot?.item?.category, item?.section);
    return cleanText(item?.section || CATEGORY_TO_SECTION[item?.category] || 'accessories') || 'accessories';
  }

  function uniqueGenerationCatalogItems(items = []){
    const byType = new Map();
    (Array.isArray(items) ? items : []).filter(Boolean).forEach((item) => {
      const typeId = catalogItemTypeId(item);
      const key = typeId || cleanText(item.id);
      if (!key) return;
      const current = byType.get(key);
      if (!current
        || item.isDefaultVariant
        || (!current.isDefaultVariant && item.variantRole === 'generic')
        || (!current.isDefaultVariant && current.variantRole !== 'generic' && item.autoAdd)) {
        byType.set(key, item);
      }
    });
    return [...byType.values()];
  }

  function integerQuantity(value, fallback = 0){
    const parsed = number(value, fallback);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.ceil(parsed);
  }

  function preciseQuantity(value, fallback = 0){
    const parsed = number(value, fallback);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.round(parsed * 10000) / 10000;
  }

  function optionDefinitionsForItem(item){
    const snapshot = item?.pricebook_snapshot || {};
    const catalogItem = variantCatalogItemForLine(item);
    const source = Array.isArray(item?.optionDefinitions) ? item.optionDefinitions
      : Array.isArray(snapshot.option_definitions) ? snapshot.option_definitions
        : Array.isArray(snapshot.item?.optionDefinitions) ? snapshot.item.optionDefinitions
          : Array.isArray(catalogItem?.optionDefinitions) ? catalogItem.optionDefinitions
          : [];
    return source;
  }

  function optionDefinition(item, optionId){
    return optionDefinitionsForItem(item).find((definition) => cleanText(definition.id) === optionId) || null;
  }

  function optionValues(definition){
    return Array.isArray(definition?.values) ? definition.values : [];
  }

  function colorForValue(value){
    const key = cleanText(value).toLowerCase();
    if (key === 'brown' || key === 'barkwood') return '#6b442e';
    if (key === 'charcoal' || key === 'black') return '#16181d';
    if (key === 'white') return '#f8fafc';
    if (key === 'tan') return '#c7a678';
    if (key === 'gray' || key === 'grey') return '#737b84';
    if (key === 'weathered_wood') return '#8a8175';
    if (key === 'shakewood') return '#a8794d';
    if (key === 'driftwood') return '#7d7468';
    return key || '#98a2b3';
  }

  function selectedOptionsFor(item){
    return {
      ...(item?.pricebook_snapshot?.selected_options || {}),
      ...(item?.product_selection?.selected_options || {}),
      ...(item?.selected_options || {})
    };
  }

  function variantCatalogItemForLine(item){
    const id = cleanText(item?.pricebook_ref?.item_id || item?.pricebookItemId || item?.product_selection?.variant_item_id);
    return state.pricebookItems.find((entry) => cleanText(entry.id) === id) || item?.pricebook_snapshot?.item || null;
  }

  function orderPackagingForLine(item){
    const snapshotItem = item?.pricebook_snapshot?.item || {};
    const catalogItem = variantCatalogItemForLine(item) || {};
    return item?.order_packaging
      || snapshotItem.order_packaging || snapshotItem.orderPackaging
      || catalogItem.order_packaging || catalogItem.orderPackaging
      || null;
  }

  function orderInfoForLine(item, quantity = item?.quantity){
    const pb = pricebook();
    const packaging = orderPackagingForLine(item);
    if (!packaging || !pb?.computeOrderQuantity) return null;
    return pb.computeOrderQuantity(packaging, number(quantity, 0));
  }

  function orderFieldsForLine(item, quantity = item?.quantity){
    const info = orderInfoForLine(item, quantity);
    if (!info) return {};
    return {
      order_packaging: info.packaging,
      order_quantity: info.order_quantity,
      order_unit: info.order_unit,
      order_covered_quantity: info.covered_quantity
    };
  }

  function variantsForLine(item){
    const typeId = lineItemTypeId(item);
    if (!typeId) return [];
    return state.pricebookItems.filter((entry) => cleanText(entry.itemTypeId) === typeId);
  }

  function variantGroupName(variant){
    return cleanText(variant?.variantGroupName || variant?.variant_group_name || variant?.variantGroup?.name || variant?.product_selection?.variant_group_name)
      || titleFromKey(cleanText(variant?.manufacturer && variant.manufacturer !== 'generic' ? variant.manufacturer : ''))
      || (variant?.variantRole === 'generic' ? 'Unbranded' : 'Other');
  }

  function groupedVariantsForLine(item){
    const groups = new Map();
    variantsForLine(item).forEach((variant) => {
      const groupId = cleanText(variant.variantGroupId || variant.variant_group_id || variant.variantGroup?.id || variant.manufacturer || variant.variantRole || 'other');
      const groupName = variantGroupName(variant);
      const key = `${groupId}:${groupName}`;
      if (!groups.has(key)) groups.set(key, { id: groupId, name: groupName, variants: [] });
      groups.get(key).variants.push(variant);
    });
    return [...groups.values()];
  }

  function materialPrimaryName(item){
    if (item?.metadata?.name_overridden === true && cleanText(item.name)) return cleanText(item.name);
    return cleanText(item.product_selection?.item_type_name || item.pricebook_snapshot?.item_type?.name || item.item_type_name)
      || cleanText(item.name)
      || 'Material';
  }

  function materialSecondaryText(item, hasVariants){
    const parts = [];
    if (!hasVariants) {
      const variant = cleanText(item.product_selection?.variant_name || item.pricebook_snapshot?.variant?.name);
      if (variant && variant !== item.name && variant !== materialPrimaryName(item)) parts.push(variant);
    }
    if (item.code) parts.push(item.code);
    return parts.join(' / ');
  }

  function optionValueBackground(value){
    const image = cleanText(value?.metadata?.image || value?.metadata?.imageUrl || value?.metadata?.swatchImage || value?.image || value?.imageUrl);
    if (image) return `background-image:url('${image.replaceAll("'", "\\'")}')`;
    return `background:${colorForValue(value?.value)}`;
  }

  function richColorPicker(item){
    const typeId = lineItemTypeId(item);
    const category = cleanText(item?.category || item?.pricebook_snapshot?.item?.category);
    return ['field_shingles', 'ridge_cap', 'flat_roof_membrane'].includes(typeId) || ['shingle_roofs', 'flat_roofs'].includes(category);
  }

  function defaultOptionsForCatalogItem(item, overrides = {}){
    const options = { ...(item?.defaultOptions || {}) };
    const definition = Array.isArray(item?.optionDefinitions) ? item.optionDefinitions.find((entry) => cleanText(entry.id) === 'color') : null;
    if (definition && ['flashing', 'flat_roof_accessories'].includes(cleanText(item.category))) options.color = state.flashingColor || options.color || definition.defaultValue || 'black';
    const merged = { ...options, ...overrides };
    (Array.isArray(item?.optionDefinitions) ? item.optionDefinitions : []).forEach((option) => {
      if (!Array.isArray(option.values) || !option.values.length) return;
      const selected = cleanText(merged[option.id]);
      if (!option.values.some((value) => cleanText(value.value) === selected)) {
        merged[option.id] = cleanText(option.defaultValue || option.values[0]?.value);
      }
    });
    return merged;
  }

  function lineFromPricebookItem(item, overrides = {}){
    const measurements = { ...projectMeasurements(), ...(overrides.measurements || {}) };
    const pb = pricebook();
    const derived = pb?.lineItemFromPricebook?.(item.id, measurements) || null;
    const derivedQuantity = number(derived?.quantity, 0);
    const quantity = integerQuantity(overrides.quantity ?? (derivedQuantity > 0 ? derivedQuantity : defaultMaterialQuantity(item, measurements)), 0);
    const unitPrice = number(overrides.unitPrice ?? derived?.unitPrice ?? item.unitPrice, 0);
    const section = overrides.section || CATEGORY_TO_SECTION[item.category] || 'accessories';
    const selectedOptions = defaultOptionsForCatalogItem(item, overrides.selectedOptions || {});
    return {
      id: uid('material_item'),
      section,
      structure_id: state.activeStructureId !== 'total' ? state.activeStructureId : '',
      item_type_id: cleanText(item.itemTypeId),
      variant_id: cleanText(item.variantId),
      selected_options: selectedOptions,
      product_selection: {
        item_type_id: cleanText(item.itemTypeId),
        item_type_name: cleanText(item.itemTypeName),
        variant_group_id: cleanText(item.variantGroupId),
        variant_group_name: cleanText(item.variantGroupName),
        variant_item_id: item.id,
        variant_id: cleanText(item.variantId),
        variant_name: cleanText(item.variantName),
        selected_options: selectedOptions
      },
      pricebook_ref: {
        pricebook_id: pricebookId(),
        item_id: item.id,
        item_type_id: cleanText(item.itemTypeId),
        variant_id: cleanText(item.variantId),
        variant_group_id: cleanText(item.variantGroupId),
        selected_options: selectedOptions,
        source: 'materials_tab'
      },
      pricebook_snapshot: {
        pricebook_id: pricebookId(),
        captured_at: todayIso(),
        item: { ...item },
        item_type: {
          id: cleanText(item.itemTypeId),
          name: cleanText(item.itemTypeName),
          default_variant_item_id: item.isDefaultVariant ? item.id : ''
        },
        variant: {
          id: cleanText(item.variantId),
          name: cleanText(item.variantName),
          role: cleanText(item.variantRole),
          group_id: cleanText(item.variantGroupId),
          group_name: cleanText(item.variantGroupName),
          item_id: item.id,
          is_default: !!item.isDefaultVariant
        },
        option_definitions: Array.isArray(item.optionDefinitions) ? item.optionDefinitions : [],
        selected_options: selectedOptions,
        currency: 'USD'
      },
      name: cleanText(item.name || derived?.label) || 'Material',
      code: cleanText(item.code),
      category: cleanText(item.category),
      manufacturer: cleanText(item.manufacturer || 'generic'),
      segment: cleanText(item.segment || 'all'),
      description: cleanText(item.description),
      quantity,
      unit: cleanText(item.unit || derived?.unit || 'ea'),
      ...orderFieldsForLine({ pricebook_snapshot: { item } }, quantity),
      projected_unit_price: unitPrice,
      projected_total: Math.round(quantity * unitPrice * 100) / 100,
      currency: 'USD',
      measurements,
      metadata: overrides.metadata || undefined
    };
  }

  function measurementValueForFormula(key, measurements = projectMeasurements()){
    const direct = number(measurements[key], NaN);
    if (Number.isFinite(direct)) return direct;
    const slope = number(measurements.slopeSquares ?? measurements.shingleSquares, 0);
    const flat = number(measurements.flatRoofSquares, 0);
    const aliases = {
      shingleSquares: slope,
      slopeSquares: slope,
      steepSlopeSquares: slope,
      roofSquares: number(measurements.roofSquares, slope + flat),
      totalSquares: number(measurements.roofSquares, slope + flat),
      flatSquares: flat,
      flatRoofSquares: flat,
      eavesLf: number(measurements.eavesLf, 0),
      rakesLf: number(measurements.rakesLf, 0),
      hipsLf: number(measurements.hipsLf, 0),
      ridgesLf: number(measurements.ridgesLf, 0),
      valleyLf: number(measurements.valleyLf, 0),
      valleysLf: number(measurements.valleyLf, 0),
      structures: Math.max(1, number(measurements.structures, 1))
    };
    return number(aliases[key], 0);
  }

  function evaluateMaterialFormula(item, measurements){
    const config = item?.formulaConfig && typeof item.formulaConfig === 'object' ? item.formulaConfig : null;
    const tokens = Array.isArray(config?.tokens) ? config.tokens : [];
    if (!tokens.length) return 0;
    const expression = tokens.map((token) => {
      if (token.type === 'measurement' || token.type === 'custom_field') return String(measurementValueForFormula(token.value, measurements));
      if (token.type === 'number') return String(number(token.value, 0));
      if (token.type === 'operator' && /^[+\-*/]$/.test(token.value)) return token.value;
      if (token.type === 'paren' && /^[()]$/.test(token.value)) return token.value;
      return '';
    }).join(' ');
    if (!/^[\d\s.+\-*/()]+$/.test(expression)) return 0;
    try {
      const value = Number(new Function(`return Number(${expression}) || 0;`)());
      const waste = config.includeWaste ? 1 + (number(measurements.wastePercent, 10) / 100) : 1;
      return Number.isFinite(value) ? value * waste : 0;
    } catch (error) {
      return 0;
    }
  }

  function defaultMaterialQuantity(item, measurements = projectMeasurements()){
    const formulaQuantity = evaluateMaterialFormula(item, measurements);
    if (formulaQuantity > 0) return roundMaterialQuantity(formulaQuantity);
    const config = item?.formulaConfig && typeof item.formulaConfig === 'object' ? item.formulaConfig : null;
    if (Array.isArray(config?.tokens) && config.tokens.length) return 0;
    const category = cleanText(item?.category);
    const unit = cleanText(item?.unit);
    const name = `${item?.name || ''} ${item?.description || ''}`.toLowerCase();
    const slope = number(measurements.slopeSquares ?? measurements.shingleSquares, 0);
    const flat = number(measurements.flatRoofSquares, 0);
    const roof = number(measurements.roofSquares, slope + flat);
    const wasteFactor = 1 + (number(measurements.wastePercent, 10) / 100);
    let quantity = 0;
    if (unit === 'sq') {
      if (category === 'flat_roofs' || category === 'flat_roof_accessories') quantity = flat * wasteFactor;
      else if (category === 'disposal') quantity = roof;
      else if (category === 'shingle_roofs' || category === 'leak_barriers' || category === 'underlayments') quantity = slope * wasteFactor;
      else quantity = roof;
    } else if (unit === 'lf') {
      if (/ridge vent/.test(name)) quantity = number(measurements.ridgesLf, 0);
      else if (/ridge|cap/.test(name)) quantity = number(measurements.hipsLf, 0) + number(measurements.ridgesLf, 0);
      else if (/valley/.test(name)) quantity = number(measurements.valleyLf, 0);
      else if (/starter|drip|edge|perimeter/.test(name)) quantity = number(measurements.eavesLf, 0) + number(measurements.rakesLf, 0);
      else quantity = number(measurements.eavesLf, 0) + number(measurements.rakesLf, 0) + number(measurements.valleyLf, 0);
    } else if (unit === 'ea' && /structure|drain/.test(name)) {
      quantity = Math.max(1, number(measurements.structures, 1));
    }
    return roundMaterialQuantity(quantity);
  }

  function roundMaterialQuantity(value){
    return integerQuantity(value, 0);
  }

  function blankLine(section = 'accessories'){
    return {
      id: uid('material_item'),
      section,
      name: 'Custom material',
      quantity: 1,
      unit: 'ea',
      projected_unit_price: undefined,
      projected_total: undefined,
      currency: 'USD'
    };
  }

  function generatedBlankLine(section, name, quantity, unit){
    return {
      ...blankLine(section),
      name,
      quantity,
      unit,
      projected_unit_price: undefined,
      projected_total: undefined,
      metadata: { source: 'measurement_generation' }
    };
  }

  function listItems(list = state.activeList){
    return Array.isArray(list?.current_items) ? list.current_items : [];
  }

  function replaceActiveItems(items){
    if (!state.activeList) return;
    state.activeList = {
      ...state.activeList,
      current_items: Array.isArray(items) ? items : []
    };
    state.lists = state.lists.map((list) => list.id === state.activeList.id ? state.activeList : list);
  }

  function replaceListItems(listId, items){
    const list = materialListById(listId);
    if (!list) return null;
    const next = { ...list, current_items: Array.isArray(items) ? items : [] };
    updateMaterialListState(next);
    return next;
  }

  function listTotals(list = state.activeList){
    if (resourceType(list) === 'labor') {
      const target = expenseTargetForList(list);
      if (target) return { projected:number(target.projected_cents, 0) / 100, quoted:0, paid:0 };
    }
    const items = listItems(list);
    return items.reduce((totals, item) => {
      totals.projected += number(item.projected_total, 0);
      totals.quoted += number(item.quoted_total, 0);
      totals.paid += number(item.paid_total, 0);
      return totals;
    }, { projected: 0, quoted: 0, paid: 0 });
  }

  function visibleListTotals(){
    return visibleMaterialLists().reduce((totals, list) => {
      const next = listTotals(list);
      totals.projected += next.projected;
      totals.quoted += next.quoted;
      totals.paid += next.paid;
      return totals;
    }, { projected: 0, quoted: 0, paid: 0 });
  }

  function primaryListFrom(lists = []){
    const usable = lists.filter(Boolean);
    return usable.find((list) => list.metadata?.primary === true || list.metadata?.role === 'primary_materials')
      || usable.find((list) => /^materials$/i.test(cleanText(list.title)))
      || usable.find((list) => /^roof materials$/i.test(cleanText(list.title)))
      || usable[0]
      || null;
  }

  function applyMaterialLists(lists = []){
    const next = (Array.isArray(lists) ? lists : []).filter((list) => (
      list
      && cleanText(list.id)
      && cleanText(list.status).toLowerCase() !== 'archived'
    ));
    const previousVisible = new Set(state.visibleListIds);
    const previousIds = new Set(state.lists.map((list) => cleanText(list?.id)).filter(Boolean));
    const validIds = new Set(next.map((list) => cleanText(list.id)));
    state.lists = next;
    state.visibleListIds = new Set([
      ...[...previousVisible].filter((id) => validIds.has(id)),
      ...next.map((list) => cleanText(list.id)).filter((id) => !previousIds.has(id))
    ]);
    if (!previousIds.size) state.visibleListIds = new Set(validIds);
    const routedListId = cleanText(rootWindow.Portal?.navigation?.read?.().materialList);
    const active = materialListById(routedListId) || materialListById(state.activeListId) || primaryListFrom(next);
    state.activeListId = cleanText(active?.id);
    state.activeList = active || null;
    return next;
  }

  async function initializeMaterialListsFromScope(options = {}){
    const loadContext = options.loadContext;
    if (!loadContextIsCurrent(loadContext) || !apiReady() || !window.MaterialsAPI?.projects?.initializeFromScope) return null;
    const requestOrgId = loadContext?.orgId || orgId();
    const requestProjectId = loadContext?.projectId || projectId();
    const requestBranchId = loadContext?.branchId || branchId();
    const scope = scopeForMaterials();
    const payload = {
      branch_id: requestBranchId,
      scope,
      force_regenerate: options.force === true,
      ...(options.resourceType ? { resource_type: options.resourceType } : {}),
      ...(options.scopePieceId ? { scope_piece_id: options.scopePieceId } : {}),
      ...(options.resourceOverrides ? { resource_overrides: options.resourceOverrides } : {}),
      source: 'materials_tab'
    };
    try {
      const result = await window.MaterialsAPI.projects.initializeFromScope(requestOrgId, requestProjectId, payload);
      if (!loadContextIsCurrent(loadContext)) return null;
      const lists = Array.isArray(result?.material_lists) ? result.material_lists : Array.isArray(result?.lists) ? result.lists : null;
      if (lists) {
        if (options.mergeLists) {
          const byId = new Map(state.lists.map((list) => [cleanText(list.id), list]));
          lists.forEach((list) => byId.set(cleanText(list.id), list));
          applyMaterialLists([...byId.values()]);
        } else applyMaterialLists(lists);
      }
      return result;
    } catch (error) {
      // Read-only project users can view existing lists but cannot run the
      // idempotent scope initializer.  A 403 here must not hide the GET data.
      if ([403, 404, 405, 501].includes(Number(error?.status || 0))) return null;
      throw error;
    }
  }

  function localFallbackList(){
    const items = defaultPricebookItemsForGeneration()
      .slice(0, 6)
      .map((item) => lineFromPricebookItem(item, { metadata: { source: 'measurement_generation' } }))
      .filter((item) => item && number(item.quantity, 0) > 0);
    if (!items.length) {
      items.push({
        ...blankLine('shingles'),
        metadata: { source: 'local_placeholder' }
      });
    }
    return {
      id: 'local_material_list',
      title: PRIMARY_LIST_TITLE,
      status: 'planning',
      delivery_status: 'unscheduled',
      revision: 1,
      sections: defaultSections(),
      current_items: items,
      version_number: 1,
      metadata: { primary: true, role: 'primary_materials', source: 'materials_tab' },
      local: true
    };
  }

  async function loadData(){
    const timingStart = performance.now();
    timingMark('loadData:start');
    if (!state.mounted) return;
    const loadContext = beginLoadContext();
    state.loading = true;
    state.lastError = '';
    render();
    try {
      await Promise.all([loadPricebookItems(loadContext), loadWorkResources(loadContext)]);
      if (!loadContextIsCurrent(loadContext)) return;
      if (!apiReady()) throw new Error('materials_api_unavailable');
      const result = await window.MaterialsAPI.projects.list(loadContext.orgId, loadContext.projectId);
      if (!loadContextIsCurrent(loadContext)) return;
      applyMaterialLists(Array.isArray(result.material_lists) ? result.material_lists : []);
      const initialized = await initializeMaterialListsFromScope({ loadContext });
      if (!loadContextIsCurrent(loadContext)) return;
      if (initialized) {
        const reconciled = await window.MaterialsAPI.projects.list(loadContext.orgId, loadContext.projectId);
        if (!loadContextIsCurrent(loadContext)) return;
        applyMaterialLists(Array.isArray(reconciled.material_lists) ? reconciled.material_lists : []);
      }
      await loadActiveListDetails(loadContext);
      if (!loadContextIsCurrent(loadContext)) return;
      await loadExpenseProjection(loadContext);
    } catch (error) {
      if (!loadContextIsCurrent(loadContext)) return;
      state.lastError = error?.message === 'materials_api_unavailable' ? '' : (error?.message || 'Could not load materials.');
      applyMaterialLists([]);
      state.versions = [];
      state.orders = [];
      state.deliveriesByOrderId = {};
      state.expenseSummary = null;
    } finally {
      if (loadContextIsCurrent(loadContext)) {
        state.loading = false;
        render();
        renderLeft();
        timingMark('loadData:end', { lists: state.lists.length, items: listItems().length }, timingStart);
      }
    }
  }

  async function createInitialList(){
    const autoItems = defaultPricebookItemsForGeneration()
      .slice(0, 12)
      .map((item) => lineFromPricebookItem(item))
      .filter(Boolean);
    const items = autoItems.length ? autoItems : [];
    const payload = {
      title: PRIMARY_LIST_TITLE,
      branch_id: branchId(),
      sections: defaultSections(),
      items,
      resources: {
        proposal_ids: Array.isArray(state.project?.proposal_ids) ? state.project.proposal_ids : [],
        measurement_project_ids: [cleanText(state.project?.measurement_project?.id || state.project?.measurement?.id)].filter(Boolean)
      },
      metadata: { source: 'materials_tab', primary: true, role: 'primary_materials' }
    };
    const result = await window.MaterialsAPI.projects.create(orgId(), projectId(), payload);
    return result.material_list || null;
  }

  async function loadActiveListDetails(loadContext){
    if (!loadContextIsCurrent(loadContext) || !apiReady() || !state.activeListId || state.activeList?.local) return;
    const requestGeneration = ++state.detailsRequestGeneration;
    const requestOrgId = loadContext?.orgId || orgId();
    const requestProjectId = loadContext?.projectId || projectId();
    const requestListId = cleanText(state.activeListId);
    const requestIsCurrent = () => (
      requestGeneration === state.detailsRequestGeneration
      && requestOrgId === orgId()
      && requestProjectId === projectId()
      && requestListId === cleanText(state.activeListId)
      && loadContextIsCurrent(loadContext)
    );
    const [versionsResult, ordersResult] = await Promise.all([
      window.MaterialsAPI.lists.versions(requestOrgId, requestListId).catch(() => ({ versions: [] })),
      window.MaterialsAPI.lists.orders(requestOrgId, requestListId).catch(() => ({ orders: [] }))
    ]);
    if (!requestIsCurrent()) return;
    const nextVersions = Array.isArray(versionsResult.versions) ? versionsResult.versions : [];
    const nextOrders = Array.isArray(ordersResult.orders) ? ordersResult.orders : [];
    const deliveryPairs = await Promise.all(nextOrders.map((order) => {
      return window.MaterialsAPI.orders.deliveries(requestOrgId, order.id)
        .then((result) => [order.id, Array.isArray(result.deliveries) ? result.deliveries : []])
        .catch(() => [order.id, []]);
    }));
    if (!requestIsCurrent()) return;
    state.versions = nextVersions;
    state.orders = nextOrders;
    state.deliveriesByOrderId = Object.fromEntries(deliveryPairs);
  }

  async function loadExpenseProjection(loadContext){
    const requestGeneration = ++state.expenseRequestGeneration;
    const requestOrgId = loadContext?.orgId || orgId();
    const requestProjectId = loadContext?.projectId || projectId();
    const requestIsCurrent = () => (
      requestGeneration === state.expenseRequestGeneration
      && requestOrgId === orgId()
      && requestProjectId === projectId()
      && loadContextIsCurrent(loadContext)
    );
    if (!requestIsCurrent()) return null;
    if (!window.PaymentsAPI?.projects?.expenses || !requestOrgId || !requestProjectId) {
      if (requestIsCurrent()) {
        state.expenseSummary = null;
        state.expenseError = 'Expense projection API is unavailable.';
      }
      return null;
    }
    state.expenseLoading = true;
    state.expenseError = '';
    try {
      const result = await window.PaymentsAPI.projects.expenses(requestOrgId, requestProjectId);
      if (!requestIsCurrent()) return null;
      state.expenseSummary = result?.expense_summary || null;
      return state.expenseSummary;
    } catch (error) {
      if (!requestIsCurrent()) return null;
      state.expenseSummary = null;
      state.expenseError = error?.message || 'Could not load the labor expense estimate.';
      return null;
    } finally {
      if (requestIsCurrent()) state.expenseLoading = false;
    }
  }

  async function loadWorkResources(loadContext){
    const requestGeneration = ++state.workforceRequestGeneration;
    const requestOrgId = loadContext?.orgId || orgId();
    const requestProjectId = loadContext?.projectId || projectId();
    const requestBranchId = loadContext?.branchId || branchId();
    const requestIsCurrent = () => (
      requestGeneration === state.workforceRequestGeneration
      && requestOrgId === orgId()
      && requestProjectId === projectId()
      && requestBranchId === branchId()
      && loadContextIsCurrent(loadContext)
    );
    if (!window.PlatformAPI?.workforce?.assignableResources || !requestOrgId || !requestIsCurrent()) return [];
    state.crewsLoading = true;
    try {
      const [result, configurationResult] = await Promise.all([
        window.PlatformAPI.workforce.assignableResources(requestOrgId, requestBranchId),
        window.PlatformAPI.workforce.configuration?.(requestOrgId, requestBranchId).catch(() => ({ configuration:{} })) || Promise.resolve({ configuration:{} })
      ]);
      if (!requestIsCurrent()) return [];
      state.workforceTerms = configurationResult?.configuration?.terminology || configurationResult?.terminology || {};
      const resources = Array.isArray(result?.resources) ? result.resources : (Array.isArray(result?.assignable_resources) ? result.assignable_resources : []);
      state.crews = resources.map((resource) => {
        const id = cleanText(resource?.resource_id || resource?.id);
        const kind = cleanText(resource?.resource_kind || resource?.work_resource_ref?.kind || resource?.kind);
        const name = cleanText(resource?.name || resource?.work_resource_ref?.name || id);
        return { ...resource, id, name, resource_kind:kind, work_resource_ref:id ? { kind, id, name } : null, capability_scope_ids:Array.isArray(resource?.capability_scope_ids) ? resource.capability_scope_ids.map(cleanText).filter(Boolean) : [] };
      }).filter((resource) => resource.id && cleanText(resource.status || 'active') !== 'archived');
    } catch (_) {
      if (requestIsCurrent()) state.crews = [];
    } finally {
      if (requestIsCurrent()) state.crewsLoading = false;
    }
    return requestIsCurrent() ? state.crews : [];
  }

  async function patchScopeResourceList(listId, patch, operation = captureProjectOperation(listId)){
    const list = materialListById(listId);
    if (!list || !apiReady() || !projectOperationIsCurrent(operation)) return null;
    const result = await window.MaterialsAPI.lists.patch(operation.orgId, operation.listId, {
      expected_revision: Number(list.revision || 0) || undefined,
      ...patch
    });
    if (!projectOperationIsCurrent(operation)) return null;
    return updateMaterialListState(result?.material_list || result?.list || result);
  }

  async function assignWorkResource(listId, resourceId){
    const resource = workResourceById(resourceId);
    const list = materialListById(listId);
    if (!list || state.saving) return;
    const operation = captureProjectOperation(listId);
    state.saving = true;
    renderLeft();
    const currentMode = cleanText(list?.compensation?.mode || list?.compensation?.default_mode || 'crew_default');
    const currentAssignment = list.assignment && typeof list.assignment === 'object' ? list.assignment : {};
    const { crew_id:_legacyCrewId, crew_name:_legacyCrewName, ...assignment } = currentAssignment;
    try {
      const updatedList = await patchScopeResourceList(listId, {
        assignment: {
          ...assignment,
          work_resource_ref: resource ? {
            kind: cleanText(resource.resource_kind || resource.kind),
            id: cleanText(resource.id),
            name: cleanText(resource.name || resource.label)
          } : null,
          resource_kind: cleanText(resource?.resource_kind || resource?.kind),
          resource_id: cleanText(resource?.id),
          resource_name: cleanText(resource?.name || resource?.label)
        },
        compensation: {
          ...(list.compensation || {}),
          mode: currentMode === 'crew_default' ? 'crew_default' : currentMode,
          resolved_mode: currentMode === 'crew_default' ? workResourceCompensationMode(resource) : currentMode,
          resource_plan: resource?.compensation_plan || {}
        }
      }, operation);
      if (!updatedList || !projectOperationIsCurrent(operation)) return;
      await loadExpenseProjection();
      if (!projectOperationIsCurrent(operation)) return;
      render();
      renderLeft();
      showToast(((v0) => globalThis.PlatformLanguage?.text("materials","m_aa4c58a1bd25c6",`${v0} assigned`,{v0}) ?? `${v0} assigned`)(workResourceLabel()), resource ? `${cleanText(resource.name || resource.label)} is assigned to ${cleanText(list.title)}.` : `${workResourceLabel()} assignment cleared.`, true);
    } catch (error) {
      if (!projectOperationIsCurrent(operation)) return;
      syncScopeListCard(listId);
      showToast(((v0) => globalThis.PlatformLanguage?.text("materials","m_58fe2fb4fde16a",`Could not assign ${v0}`,{v0}) ?? `Could not assign ${v0}`)(workResourceLabel()), error?.message || 'Please try again.', false);
    } finally {
      if (projectOperationIsCurrent(operation)) {
        state.saving = false;
        renderLeft();
      }
    }
  }

  async function setLaborCompensationMode(listId, mode){
    const list = materialListById(listId);
    if (!list || state.saving) return;
    const operation = captureProjectOperation(listId);
    state.saving = true;
    renderLeft();
    const resource = workResourceById(assignmentWorkResourceRef(list)?.id);
    try {
      const updatedList = await patchScopeResourceList(listId, { compensation: { ...(list.compensation || {}), mode, resolved_mode: mode === 'crew_default' ? workResourceCompensationMode(resource) : mode, user_overridden: true } }, operation);
      if (!updatedList || !projectOperationIsCurrent(operation)) return;
      await loadExpenseProjection();
      if (!projectOperationIsCurrent(operation)) return;
      render();
      renderLeft();
    } catch (error) {
      if (!projectOperationIsCurrent(operation)) return;
      syncScopeListCard(listId);
      showToast((globalThis.PlatformLanguage?.text("materials","m_aa4dc7a92f455a","Could not update project pay") ?? "Could not update project pay"), error?.message || 'Please try again.', false);
    } finally {
      if (projectOperationIsCurrent(operation)) {
        state.saving = false;
        renderLeft();
      }
    }
  }

  async function setLaborExpenseSettings(listId, patch){
    const list = materialListById(listId);
    if (!list || state.saving) return;
    const operation = captureProjectOperation(listId);
    state.saving = true;
    renderLeft();
    try {
      const updatedList = await patchScopeResourceList(listId, {
        compensation: {
          ...(list.compensation || {}),
          ...patch,
          user_overridden: true
        }
      }, operation);
      if (!updatedList || !projectOperationIsCurrent(operation)) return;
      await loadExpenseProjection();
      if (!projectOperationIsCurrent(operation)) return;
      render();
      renderLeft();
    } catch (error) {
      if (!projectOperationIsCurrent(operation)) return;
      syncScopeListCard(listId);
      showToast((globalThis.PlatformLanguage?.text("materials","m_dc750affa8acf1","Could not update labor estimate") ?? "Could not update labor estimate"), error?.message || 'Please try again.', false);
    } finally {
      if (projectOperationIsCurrent(operation)) {
        state.saving = false;
        renderLeft();
      }
    }
  }

  function updateMaterialListState(nextList){
    if (!nextList?.id) return null;
    const id = cleanText(nextList.id);
    const existing = materialListById(id);
    const merged = { ...(existing || {}), ...nextList };
    state.lists = existing
      ? state.lists.map((list) => cleanText(list.id) === id ? merged : list)
      : [...state.lists, merged];
    state.visibleListIds.add(id);
    if (state.activeListId === id || !state.activeListId) {
      state.activeListId = id;
      state.activeList = merged;
    }
    return merged;
  }

  async function selectMaterialList(listId, options = {}){
    const list = materialListById(listId);
    if (!list) return;
    const previousListId = state.activeListId;
    const previousType = resourceType(state.activeList);
    state.activeListId = cleanText(list.id);
    state.activeList = list;
    if (!options.fromRoute && !rootWindow.Portal?.navigation?.applying) rootWindow.Portal?.navigation?.push?.({ materialList:state.activeListId }, { source:'scope-list', ownedKeys:['materialList'] });
    state.pricebookOpen = false;
    state.colorMenu = null;
    state.orders = [];
    state.versions = [];
    state.deliveriesByOrderId = {};
    syncScopeListCard(previousListId);
    syncScopeListCard(state.activeListId);
    syncTopBar();
    syncPricebookPanel();
    syncOrderDialog(false);
    await loadActiveListDetails();
    if (previousType !== resourceType(list)) {
      render({ preserveScroll:true });
      renderLeft();
      return;
    }
    syncTopBar();
    syncOrderDialog(false);
  }

  async function createMaterialListFromForm(form, scheduleAfterCreate = false){
    if (!apiReady() || state.creatingList) return;
    const data = new FormData(form);
    const type = ['labor', 'equipment'].includes(cleanText(data.get('resource_type'))) ? cleanText(data.get('resource_type')) : 'material';
    const terms = resourceTerms(type, null);
    const title = cleanText(data.get('title')) || terms.list;
    const color = normalizeColor(data.get('color'), firstUnusedListColor());
    state.creatingList = true;
    form.querySelectorAll('button,input,select').forEach((control) => { control.disabled = true; });
    try {
      const result = await window.MaterialsAPI.projects.create(orgId(), projectId(), {
        title,
        resource_type: type,
        terminology: { singular: terms.singular, plural: terms.plural, list: terms.list },
        color,
        branch_id: branchId(),
        order_sources: projectOrderSources(),
        sections: [],
        items: [],
        resources: {
          proposal_ids: Array.isArray(state.project?.proposal_ids) ? state.project.proposal_ids : []
        },
        metadata: {
          source: 'scope_tab',
          role: `custom_${type}`,
          list_key: title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
          color,
          manually_created: true
        }
      });
      const list = updateMaterialListState(result?.material_list || result?.list);
      if (!list) throw new Error('The material list was not returned by the server.');
      state.activeListId = cleanText(list.id);
      state.activeList = list;
      showToast(((v0) => globalThis.PlatformLanguage?.text("materials","m_57bf162f8c95fa",`${v0} created`,{v0}) ?? `${v0} created`)(terms.list), ((v0) => globalThis.PlatformLanguage?.text("materials","m_c5a12269eee264",`${v0} is ready.`,{v0}) ?? `${v0} is ready.`)(title), true);
      renderLeft();
      syncMaterialsGrid();
      syncTopBar();
      syncOrderDialog(false);
      if (scheduleAfterCreate) await scheduleMaterialList(list.id);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("materials","m_6eeba7da0da9ea","Could not create list") ?? "Could not create list"), error?.message || 'Please try again.', false);
    } finally {
      state.creatingList = false;
      form.querySelectorAll('button,input,select').forEach((control) => { control.disabled = false; });
    }
  }

  function schedulingFocusPayload(list, event){
    return {
      project_id: projectId(),
      event_id: cleanText(event?.id || list?.schedule_event_id || list?.metadata?.schedule_event_id),
      scope_resource_list_id: cleanText(list?.id),
      resource_type: resourceType(list),
      material_list_id: cleanText(list?.id),
      source: 'scope',
      created_at: todayIso()
    };
  }

  function openProjectScheduling(list, event){
    const payload = schedulingFocusPayload(list, event);
    const host = projectHost();
    if (typeof host?.setActivePreviewTab === 'function') {
      host.setActivePreviewTab('schedule');
      const focus = () => window.Portal?.modules?.projectSchedule?.focusMaterialDelivery?.(payload);
      focus();
      setTimeout(focus, 0);
      return;
    }
    // Compatibility fallback for hosts without the project-modal Schedule app.
    try { sessionStorage.setItem(SCHEDULING_FOCUS_KEY, JSON.stringify(payload)); } catch (_) {}
    window.dispatchEvent(new CustomEvent('fm:scheduling:focus', { detail: payload }));
    window.Portal?.tabs?.activateTab?.('dashboard');
    window.Portal?.routeState?.set?.({ tab: 'dashboard' });
  }

  async function ensureScheduleEventForList(list, source = 'scope_tab'){
    let currentList = materialListById(list?.id) || list;
    let event = linkedScheduleEvent(currentList);
    if (!currentList || !apiReady() || !window.MaterialsAPI?.lists?.scheduleEvent) return { list: currentList, event };
    const type = resourceType(currentList);
    const terms = resourceTerms(type, currentList);
    const workResourceRef = type === 'labor' ? assignmentWorkResourceRef(currentList) : null;
    const schedule = currentList.schedule || {};
    const result = await window.MaterialsAPI.lists.scheduleEvent(orgId(), currentList.id, {
      project_id: projectId(),
      branch_id: branchId(),
      event: {
        title: cleanText(schedule.title || currentList.title) || terms.list,
        kind: cleanText(schedule.kind) || (type === 'material' ? 'material_delivery' : type === 'labor' ? 'project_work' : 'equipment'),
        icon: cleanText(schedule.icon) || terms.icon,
        resource_type: type,
        work_resource_ref:workResourceRef,
        assigned_resource_kind:cleanText(workResourceRef?.kind),
        assigned_resource_id:cleanText(workResourceRef?.id),
        assigned_resource_name:cleanText(workResourceRef?.name)
      },
      source
    });
    currentList = updateMaterialListState(result?.material_list || result?.list || currentList) || currentList;
    event = result?.event || result?.schedule_event || event;
    if (event) {
      const projectEvents = Array.isArray(state.project?.events) ? state.project.events : [];
      const index = projectEvents.findIndex((item) => cleanText(item?.id) === cleanText(event.id));
      const nextEvents = [...projectEvents];
      if (index >= 0) nextEvents[index] = { ...nextEvents[index], ...event };
      else nextEvents.push(event);
      state.project = { ...(state.project || {}), events: nextEvents };
      callHost('setProject', state.project);
    }
    return { list: currentList, event };
  }

  async function scheduleMaterialList(listId = state.activeListId){
    const list = materialListById(listId);
    if (!list || state.schedulingListId) return;
    state.schedulingListId = cleanText(list.id);
    syncTopBar();
    syncScopeListCard(list.id);
    try {
      const ensured = await ensureScheduleEventForList(list);
      const event = ensured.event;
      showToast((globalThis.PlatformLanguage?.text("materials","m_09fff77730df63","Ready to schedule") ?? "Ready to schedule"), ((v0) => globalThis.PlatformLanguage?.text("materials","m_7d04249fc5bd59",`${v0} is highlighted in Scheduling.`,{v0}) ?? `${v0} is highlighted in Scheduling.`)(cleanText(list.title) || resourceTerms(resourceType(list), list).list), true);
      openProjectScheduling(ensured.list || list, event);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("materials","m_03121687ac9e0e","Could not open scheduling") ?? "Could not open scheduling"), error?.message || 'Please try again.', false);
    } finally {
      state.schedulingListId = '';
      syncTopBar();
      syncScopeListCard(list.id);
    }
  }

  async function persistVersion(payload, options = {}){
    const timingStart = performance.now();
    const targetList = options.list || state.activeList;
    timingMark('persistVersion:start', { reason: payload?.reason || '', local: !apiReady() || !!targetList?.local });
    if (!targetList) return null;
    if (!apiReady() || targetList.local) {
      const nextItems = Array.isArray(payload.items) ? payload.items : applyLocalVersion(options.baseItems || listItems(targetList), payload);
      const nextList = {
        ...targetList,
        current_items: nextItems,
        revision: Number(targetList.revision || 0) + 1,
        version_number: Number(targetList.version_number || 0) + 1
      };
      updateMaterialListState(nextList);
      const localResult = { material_list: nextList, version: { id: uid('local_version'), reason: payload.reason || 'manual' } };
      timingMark('persistVersion:end', { reason: payload?.reason || '', local: true, items: listItems(nextList).length }, timingStart);
      return localResult;
    }
    const result = await window.MaterialsAPI.lists.createVersion(orgId(), targetList.id, {
      expected_revision: targetList.revision,
      ...payload
    });
    const nextList = updateMaterialListState(result.material_list || result.list || targetList);
    if (cleanText(nextList?.id) === state.activeListId) await loadActiveListDetails();
    timingMark('persistVersion:end', { reason: payload?.reason || '', local: false, items: listItems(nextList).length }, timingStart);
    return result;
  }

  function applyLocalVersion(currentItems, payload){
    if (Array.isArray(payload.items)) return payload.items;
    const removed = new Set(Array.isArray(payload.remove_item_ids) ? payload.remove_item_ids : []);
    let next = currentItems.filter((item) => !removed.has(item.id));
    (Array.isArray(payload.update_items) ? payload.update_items : []).forEach((update) => {
      next = next.map((item) => item.id === update.id ? { ...item, ...update } : item);
    });
    (Array.isArray(payload.add_items) ? payload.add_items : []).forEach((item) => next.push(item));
    return next;
  }

  function resourceTypeForSection(section){
    if (section === 'labor' || section === 'equipment') return section;
    return 'material';
  }

  function destinationListForSection(section, requestedListId = ''){
    const type = resourceTypeForSection(section);
    const requested = materialListById(requestedListId);
    if (requested && resourceType(requested) === type) return requested;
    if (state.activeList && resourceType(state.activeList) === type) return state.activeList;
    return state.lists.find((list) => resourceType(list) === type && state.visibleListIds.has(cleanText(list.id)))
      || state.lists.find((list) => resourceType(list) === type)
      || null;
  }

  async function addItem(item, requestedSection = '', requestedListId = ''){
    const timingStart = performance.now();
    timingMark('addItem:start', { pricebook: !!item?.id });
    const fallbackSection = state.selectedSection === 'all' ? '' : state.selectedSection;
    const section = cleanText(requestedSection || fallbackSection || (item?.id ? sectionForMaterialType(item.itemTypeId, item.category, '') : ''));
    const targetList = destinationListForSection(section || 'accessories', requestedListId);
    if (!targetList) {
      showToast((globalThis.PlatformLanguage?.text("materials","m_a4269cbe0fe144","No matching list") ?? "No matching list"), ((v0) => globalThis.PlatformLanguage?.text("materials","m_0331e26e6a5102",`Create or enable a ${v0} list before adding this item.`,{v0}) ?? `Create or enable a ${v0} list before adding this item.`)(resourceTypeForSection(section)), false);
      return;
    }
    const type = resourceType(targetList);
    const terms = resourceTerms(type, targetList);
    const resolvedSection = type === 'material' ? (section || 'accessories') : type;
    const line = item?.id
      ? lineFromPricebookItem(item, { section: resolvedSection })
      : { ...blankLine(resolvedSection), id: uid(`${type}_item`), name: `New ${terms.singular.toLowerCase()}`, unit: type === 'labor' ? 'hour' : 'ea', metadata: { resource_type: type, ...(type === 'labor' ? { compensation_kind:'hourly' } : {}) } };
    const baseItems = listItems(targetList);
    state.saving = true;
    replaceListItems(targetList.id, [...baseItems, line]);
    state.activeListId = cleanText(targetList.id);
    state.activeList = materialListById(targetList.id);
    state.visibleListIds.add(cleanText(targetList.id));
    setWorkspaceSaving(true);
    syncMaterialSection(resolvedSection);
    try {
      await persistVersion({ reason: 'supplement', add_items: [line] }, { baseItems, list: targetList });
      showToast(((v0) => globalThis.PlatformLanguage?.text("materials","m_a19c8c64e9f329",`${v0} added`,{v0}) ?? `${v0} added`)(terms.singular), line.name, true);
    } catch (error) {
      replaceListItems(targetList.id, baseItems);
      syncMaterialSection(resolvedSection);
      showToast(((v0) => globalThis.PlatformLanguage?.text("materials","m_6b20ad5f8a56d9",`Could not add ${v0}`,{v0}) ?? `Could not add ${v0}`)(terms.singular.toLowerCase()), error?.message || 'Please try again.', false);
    } finally {
      state.saving = false;
      if (type === 'labor') {
        await loadExpenseProjection();
        render();
        renderLeft();
      }
      setWorkspaceSaving(false);
      syncFooterTotals();
      timingMark('addItem:end', { items: listItems().length }, timingStart);
    }
  }

  function markGenerateButtonLoading(button){
    if (!button) return;
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-rotate mt-spin"></i> Regenerating';
  }

  async function regenerateMaterialListsFromScope(){
    if (!apiReady() || !window.MaterialsAPI?.projects?.initializeFromScope) {
      showToast((globalThis.PlatformLanguage?.text("materials","m_d9e2e6ecf3e384","Scope regeneration unavailable") ?? "Scope regeneration unavailable"), (globalThis.PlatformLanguage?.text("materials","m_6ae9948e2fd11a","Materials API is not ready for this project.") ?? "Materials API is not ready for this project."), false);
      return;
    }
    const confirmed = await confirmAction(
      'Regenerate material lists from the project scope? This will replace generated planning lists with the current scope output. Ordered lists are protected.',
      {
        title: (globalThis.PlatformLanguage?.text("materials","m_71d2e615b972f0","Regenerate materials") ?? "Regenerate materials"),
        okLabel: 'Regenerate',
        cancelLabel: 'Keep edits',
        danger: true
      }
    );
    if (!confirmed) {
      state.generatingMaterials = false;
      renderLeft();
      return;
    }
    state.generatingMaterials = true;
    renderLeft();
    render({ preserveScroll: true });
    const minimumFeedback = new Promise((resolve) => setTimeout(resolve, 650));
    try {
      await initializeMaterialListsFromScope({ force: true });
      const refreshed = await window.MaterialsAPI.projects.list(orgId(), projectId());
      applyMaterialLists(Array.isArray(refreshed.material_lists) ? refreshed.material_lists : []);
      await loadActiveListDetails();
      showToast((globalThis.PlatformLanguage?.text("materials","m_3f229715aaee07","Materials regenerated") ?? "Materials regenerated"), (globalThis.PlatformLanguage?.text("materials","m_58a415d1c7298e","Generated planning lists now match the project scope.") ?? "Generated planning lists now match the project scope."), true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("materials","m_d07b6717c1ad28","Could not regenerate materials") ?? "Could not regenerate materials"), error?.message || 'Please try again.', false);
    } finally {
      await minimumFeedback;
      state.generatingMaterials = false;
      renderLeft();
      render({ preserveScroll: true });
    }
  }

  function laborItemsForRegeneration(list){
    return listItems(list).map((item) => ({
      id: cleanText(item.id),
      name: cleanText(item.name) || 'Labor item',
      unit: cleanText(item.unit) || 'ea',
      quantity: number(item.quantity, 0),
      projected_unit_price: number(item.projected_unit_price ?? item.unit_price, 0),
      metadata: {
        ...(item.metadata || {}),
        compensation_kind: cleanText(item.metadata?.compensation_kind || item.metadata?.pay_type || item.metadata?.estimate_mode || 'piece_rate'),
        estimate_mode: cleanText(item.metadata?.estimate_mode || item.metadata?.compensation_kind || 'piece_rate')
      }
    }));
  }

  async function regenerateLaborListFromScope(listId){
    const list = materialListById(listId);
    if (!list || resourceType(list) !== 'labor' || state.saving || state.regeneratingLaborListId) return;
    const confirmed = await confirmAction(
      `Regenerate ${cleanText(list.title) || 'this labor scope'} using its current crew, pay structure, rates, and scope measurements?`,
      { title: (globalThis.PlatformLanguage?.text("materials","m_0a668f910f0602","Regenerate labor") ?? "Regenerate labor"), okLabel: 'Regenerate', cancelLabel: 'Keep current labor' }
    );
    if (!confirmed) return;
    const definitionId = cleanText(list.metadata?.material_list_definition_id || list.resource_subtype || 'roofing_labor');
    state.regeneratingLaborListId = cleanText(list.id);
    renderLeft();
    try {
      await initializeMaterialListsFromScope({
        force: true,
        resourceType: 'labor',
        scopePieceId: cleanText(list.scope_piece_id),
        mergeLists: true,
        resourceOverrides: {
          [definitionId]: {
            assignment: { ...(list.assignment || {}) },
            compensation: { ...(list.compensation || {}), user_overridden: true },
            items: laborItemsForRegeneration(list)
          }
        }
      });
      const refreshed = await window.MaterialsAPI.projects.list(orgId(), projectId());
      applyMaterialLists(Array.isArray(refreshed.material_lists) ? refreshed.material_lists : []);
      await loadExpenseProjection();
      render({ preserveScroll: true });
      showToast((globalThis.PlatformLanguage?.text("materials","m_23ae57b4dee22d","Labor regenerated") ?? "Labor regenerated"), ((v0) => globalThis.PlatformLanguage?.text("materials","m_78ea5eebacfbe6",`${v0} now matches the current scope measurements and labor configuration.`,{v0}) ?? `${v0} now matches the current scope measurements and labor configuration.`)(cleanText(list.title) || 'Labor'), true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("materials","m_b59e0f7b83d2dc","Could not regenerate labor") ?? "Could not regenerate labor"), error?.message || 'Please try again.', false);
    } finally {
      state.regeneratingLaborListId = '';
      renderLeft();
    }
  }

  async function generateMaterialsFromMeasurements(){
    state.generatingMaterials = true;
    renderLeft();
    const minimumFeedback = new Promise((resolve) => setTimeout(resolve, 650));
    await nextPaint();
    if (!measurementsHaveValues(projectMeasurements())) {
      await requestMeasurementHydration(true);
    }
    const measures = projectMeasurements();
    const slopeSquares = number(measures.slopeSquares ?? measures.shingleSquares, 0);
    const flatSquares = number(measures.flatRoofSquares, 0);
    const existingItems = listItems();
    const existingByPricebookId = new Map(existingItems
      .map((item) => [linePricebookItemId(item), item])
      .filter(([id]) => id));
    const existingByTypeId = new Map();
    existingItems.forEach((item) => {
      const typeId = lineItemTypeId(item);
      if (typeId && !existingByTypeId.has(typeId)) existingByTypeId.set(typeId, item);
    });
    const existingIds = new Set(existingByPricebookId.keys());
    const candidates = uniqueGenerationCatalogItems(defaultPricebookItemsForGeneration())
      .filter((item) => {
        const section = CATEGORY_TO_SECTION[item.category] || 'accessories';
        if (section === 'shingles' && slopeSquares <= 0) return false;
        if (section === 'flat_roofing' && flatSquares <= 0) return false;
        return true;
      })
      .slice(0, 14);
    const candidateTypeIds = new Set(candidates.map((item) => catalogItemTypeId(item)).filter(Boolean));
    const candidateLines = candidates
      .map((item) => lineFromPricebookItem(item, { measurements: measures, metadata: { source: 'measurement_generation' } }))
      .filter((line) => number(line.quantity, 0) > 0)
      .reduce((lines, line) => {
        const typeId = lineItemTypeId(line);
        if (!typeId || !lines.some((existing) => lineItemTypeId(existing) === typeId)) lines.push(line);
        return lines;
      }, []);
    const generatedByPricebookId = new Map(candidateLines.map((line) => [linePricebookItemId(line), line]).filter(([id]) => id));
    const generatedByTypeId = new Map(candidateLines.map((line) => [lineItemTypeId(line), line]).filter(([id]) => id));
    const updateItems = candidateLines
      .map((line) => {
        const existing = existingByPricebookId.get(linePricebookItemId(line)) || existingByTypeId.get(lineItemTypeId(line));
        if (!existing) return null;
        return mergeGeneratedLineIntoExisting(existing, line, measures);
      })
      .filter(Boolean);
    const newCandidateLines = candidateLines.filter((line) => !existingIds.has(linePricebookItemId(line)) && !existingByTypeId.has(lineItemTypeId(line)));
    const fallback = [];
    if (!candidateLines.some((item) => item.section === 'shingles') && slopeSquares > 0) {
      fallback.push(generatedBlankLine('shingles', 'Slope roofing material', slopeSquares, 'sq'));
    }
    if (!candidateLines.some((item) => item.section === 'flat_roofing') && flatSquares > 0) {
      fallback.push(generatedBlankLine('flat_roofing', 'Flat roofing material', flatSquares, 'sq'));
    }
    if (!candidateLines.some((item) => item.section === 'underlayments') && slopeSquares > 0) {
      fallback.push(generatedBlankLine('underlayments', 'Underlayment', slopeSquares, 'sq'));
    }
    if (!candidateLines.some((item) => item.section === 'metal') && (number(measures.valleyLf, 0) || number(measures.ridgesLf, 0))) {
      fallback.push(generatedBlankLine('metal', 'Metal flashing', number(measures.valleyLf, 0) + number(measures.ridgesLf, 0), 'lf'));
    }
    const addItems = [...newCandidateLines, ...fallback];
    if (!addItems.length && !updateItems.length) {
      showToast((globalThis.PlatformLanguage?.text("materials","m_1ce72e89199ff2","Nothing generated") ?? "Nothing generated"), (globalThis.PlatformLanguage?.text("materials","m_6c1f00f987b4f2","No usable report measurements or price book mappings were found yet.") ?? "No usable report measurements or price book mappings were found yet."), false);
      state.generatingMaterials = false;
      renderLeft();
      syncMaterialsGrid();
      return;
    }
    const replacementItems = buildGeneratedMaterialList(existingItems, generatedByPricebookId, generatedByTypeId, addItems, measures, candidateTypeIds);
    applyOptimisticItems(replacementItems);
    state.saving = true;
    setWorkspaceSaving(true);
    syncMaterialsGrid();
    try {
      await persistVersion({ reason: 'measurement_import', items: replacementItems });
      applyOptimisticItems(mergeGeneratedItems(listItems(), replacementItems));
      const changed = addItems.length + updateItems.length;
      showToast((globalThis.PlatformLanguage?.text("materials","m_7b862b1f8a1c47","Materials generated") ?? "Materials generated"), ((v0,v1) => globalThis.PlatformLanguage?.text("materials","m_4f78632d99e836",`${v0} line item${v1} updated.`,{v0,v1}) ?? `${v0} line item${v1} updated.`)(changed,changed === 1 ? '' : 's'), true);
    } catch (error) {
      applyOptimisticItems(replacementItems);
      showToast((globalThis.PlatformLanguage?.text("materials","m_824a93827d7302","Materials generated locally") ?? "Materials generated locally"), (globalThis.PlatformLanguage?.text("materials","m_30e4db25b31d3c","The quantities were calculated, but the save did not finish. Try again after reviewing them.") ?? "The quantities were calculated, but the save did not finish. Try again after reviewing them."), false);
    } finally {
      await minimumFeedback;
      state.saving = false;
      state.generatingMaterials = false;
      setWorkspaceSaving(false);
      syncMaterialsGrid();
      renderLeft();
    }
  }

  function nextFrame(){
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
  }

  function nextPaint(){
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  function applyOptimisticItems(items){
    if (!state.activeList) return;
    state.activeList = { ...state.activeList, current_items: items };
    state.lists = state.lists.map((list) => list.id === state.activeList.id ? state.activeList : list);
  }

  function mergeGeneratedItems(currentItems, generatedItems){
    const currentById = new Map((currentItems || []).map((item) => [cleanText(item.id), item]).filter(([id]) => id));
    return (generatedItems || []).map((generated) => {
      const current = currentById.get(cleanText(generated.id));
      if (!current) return generated;
      if (number(current.quantity, 0) <= 0 && number(generated.quantity, 0) > 0) {
        return { ...current, quantity: generated.quantity, projected_total: generated.projected_total, measurements: generated.measurements };
      }
      return current;
    });
  }

  function mergeGeneratedLineIntoExisting(existing, generated, measurements){
    const quantity = number(generated.quantity, 0);
    const unitPrice = number(existing.projected_unit_price ?? existing.unit_price ?? generated.projected_unit_price, 0);
    const typeId = lineItemTypeId(generated) || lineItemTypeId(existing);
    const category = canonicalCategoryForType(typeId, generated.category || existing.category);
    const section = sectionForMaterialType(typeId, category, generated.section || existing.section);
    return {
      ...existing,
      quantity,
      unit: existing.unit || generated.unit,
      section,
      category,
      structure_id: existing.structure_id || generated.structure_id,
      item_type_id: existing.item_type_id || generated.item_type_id || typeId,
      projected_unit_price: unitPrice,
      projected_total: Math.round(quantity * unitPrice * 100) / 100,
      measurements,
      metadata: {
        ...(existing.metadata || {}),
        source: cleanText(existing.metadata?.source) || 'measurement_generation'
      }
    };
  }

  function buildGeneratedMaterialList(existingItems, generatedByPricebookId, generatedByTypeId, addItems, measurements, candidateTypeIds = new Set()){
    const generatedIds = new Set(generatedByPricebookId.keys());
    const generatedTypeIds = new Set(generatedByTypeId.keys());
    const keptTypeIds = new Set();
    const next = existingItems.map((item) => {
      const pricebookId = linePricebookItemId(item);
      const typeId = lineItemTypeId(item);
      const generated = generatedByPricebookId.get(pricebookId) || generatedByTypeId.get(typeId);
      if (typeId && (generatedTypeIds.has(typeId) || candidateTypeIds.has(typeId))) {
        if (keptTypeIds.has(typeId)) return null;
        if (!generated && candidateTypeIds.has(typeId)) return null;
        keptTypeIds.add(typeId);
      }
      if (!generated) return ensureGeneratedQuantity(item, measurements);
      return mergeGeneratedLineIntoExisting(item, generated, measurements);
    }).filter(Boolean);
    addItems.forEach((item) => {
      const pricebookId = linePricebookItemId(item);
      const typeId = lineItemTypeId(item);
      if (pricebookId && generatedIds.has(pricebookId) && next.some((existing) => linePricebookItemId(existing) === pricebookId)) return;
      if (typeId && generatedTypeIds.has(typeId) && next.some((existing) => lineItemTypeId(existing) === typeId)) return;
      next.push(item);
    });
    return next
      .map((item) => ensureGeneratedQuantity(item, measurements))
      .filter((item) => !isGenerationPlaceholder(item, generatedTypeIds))
      .filter((item) => !shouldPruneGeneratedSectionItem(item, measurements));
  }

  function isGenerationPlaceholder(item, generatedTypeIds = new Set()){
    if (!generatedTypeIds.size) return false;
    if (cleanText(item.metadata?.source) === 'local_placeholder') return true;
    return !linePricebookItemId(item)
      && !lineItemTypeId(item)
      && cleanText(item.name).toLowerCase() === 'custom material'
      && cleanText(item.unit) === 'ea'
      && number(item.quantity, 0) === 1;
  }

  function ensureGeneratedQuantity(item, measurements){
    if (number(item.quantity, 0) > 0) return item;
    const catalogItem = state.pricebookItems.find((entry) => cleanText(entry.id) === cleanText(item.pricebook_ref?.item_id || item.pricebookItemId))
      || { ...item, id: cleanText(item.pricebook_ref?.item_id || item.pricebookItemId), category: item.category, unit: item.unit, formulaConfig: item.pricebook_snapshot?.item?.formulaConfig };
    const quantity = defaultMaterialQuantity(catalogItem, measurements);
    if (quantity <= 0) return item;
    const unitPrice = number(item.projected_unit_price ?? item.unit_price ?? catalogItem.unitPrice, 0);
    return {
      ...item,
      quantity,
      projected_unit_price: unitPrice,
      projected_total: Math.round(quantity * unitPrice * 100) / 100,
      measurements
    };
  }

  function shouldPruneGeneratedSectionItem(item, measurements){
    const section = cleanText(item.section || CATEGORY_TO_SECTION[item.category] || 'accessories') || 'accessories';
    const isGenerated = cleanText(item.metadata?.source) === 'measurement_generation'
      || !!item.pricebook_ref?.item_id
      || !!item.pricebookItemId;
    if (!isGenerated || number(item.quantity, 0) > 0) return false;
    if (section === 'flat_roofing') return number(measurements.flatRoofSquares, 0) <= 0;
    if (section === 'shingles') return number(measurements.slopeSquares ?? measurements.shingleSquares, 0) <= 0;
    return false;
  }

  async function removeItem(itemId, listId = state.activeListId){
    const timingStart = performance.now();
    timingMark('removeItem:start', { itemId });
    const targetList = materialListById(listId) || state.activeList;
    if (!targetList) return;
    const baseItems = listItems(targetList);
    const removedItem = baseItems.find((item) => cleanText(item.id) === cleanText(itemId));
    const sectionKey = removedItem ? lineSectionKey(decoratedLineItem(removedItem, targetList)) : 'accessories';
    state.saving = true;
    replaceListItems(targetList.id, baseItems.filter((item) => item.id !== itemId));
    setWorkspaceSaving(true);
    syncMaterialSection(sectionKey);
    try {
      await persistVersion({ reason: 'removal', remove_item_ids: [itemId] }, { baseItems, list: targetList });
      showToast((globalThis.PlatformLanguage?.text("materials","m_c61c9f62b64abc","Material removed") ?? "Material removed"), (globalThis.PlatformLanguage?.text("materials","m_4890c8a393768a","The list was amended.") ?? "The list was amended."), true);
    } catch (error) {
      replaceListItems(targetList.id, baseItems);
      syncMaterialSection(sectionKey);
      showToast((globalThis.PlatformLanguage?.text("materials","m_15f323bc463e38","Could not remove material") ?? "Could not remove material"), error?.message || 'Please try again.', false);
    } finally {
      state.saving = false;
      setWorkspaceSaving(false);
      syncFooterTotals();
      timingMark('removeItem:end', { items: listItems(materialListById(targetList.id)).length }, timingStart);
    }
  }

  async function updateItem(itemId, patch, listId = state.activeListId){
    const targetList = materialListById(listId) || state.activeList;
    const discreteMaterial = resourceType(targetList) === 'material';
    const laborItem = resourceType(targetList) === 'labor';
    const baseItems = listItems(targetList);
    const current = baseItems.find((item) => item.id === itemId);
    if (!current) return;
    const quantity = patch.quantity != null
      ? (discreteMaterial ? integerQuantity(patch.quantity, current.quantity) : preciseQuantity(patch.quantity, current.quantity))
      : (discreteMaterial ? integerQuantity(current.quantity, 0) : preciseQuantity(current.quantity, 0));
    const unitPrice = patch.projected_unit_price != null ? number(patch.projected_unit_price, current.projected_unit_price) : number(current.projected_unit_price, NaN);
    const nextPatch = {
      ...patch,
      id: itemId,
      ...(patch.name != null ? { metadata: { ...(current.metadata || {}), name_overridden: true } } : {}),
      quantity,
      ...(discreteMaterial ? orderFieldsForLine({ ...current, ...patch }, quantity) : {}),
      projected_unit_price: Number.isFinite(unitPrice) ? unitPrice : undefined,
      projected_total: Number.isFinite(unitPrice) ? Math.round(quantity * unitPrice * 100) / 100 : current.projected_total
    };
    state.saving = true;
    replaceListItems(targetList.id, baseItems.map((item) => item.id === itemId ? { ...item, ...nextPatch } : item));
    setWorkspaceSaving(true);
    const immediateRowSync = !!(nextPatch.selected_options || nextPatch.product_selection || nextPatch.pricebook_ref || nextPatch.pricebook_snapshot || nextPatch.item_type_id || nextPatch.variant_id);
    if (immediateRowSync) syncLineRow(itemId, targetList.id);
    let updateFailed = false;
    try {
      await persistVersion({ reason: 'revision', update_items: [nextPatch] }, { list: targetList, baseItems });
    } catch (error) {
      updateFailed = true;
      replaceListItems(targetList.id, baseItems);
      showToast((globalThis.PlatformLanguage?.text("materials","m_9747f0d8655351","Could not update material") ?? "Could not update material"), error?.message || 'Please try again.', false);
    } finally {
      state.saving = false;
      if (laborItem) {
        await loadExpenseProjection();
        render();
        renderLeft();
      } else if (!immediateRowSync || updateFailed) syncLineRow(itemId, targetList.id);
      setWorkspaceSaving(false);
      syncFooterTotals();
    }
  }

  async function moveItemToList(itemId, sourceListId, targetListId){
    closeListMenu();
    const source = materialListById(sourceListId);
    const target = materialListById(targetListId);
    if (!source || !target || source.id === target.id || resourceType(source) !== resourceType(target)) return;
    const sourceItems = listItems(source);
    const targetItems = listItems(target);
    const item = sourceItems.find((entry) => cleanText(entry.id) === cleanText(itemId));
    if (!item) return;
    state.saving = true;
    replaceListItems(target.id, [...targetItems, item]);
    replaceListItems(source.id, sourceItems.filter((entry) => cleanText(entry.id) !== cleanText(itemId)));
    setWorkspaceSaving(true);
    syncLineRow(itemId, target.id);
    try {
      await persistVersion({ reason: 'supplement', add_items: [item] }, { list: target, baseItems: targetItems });
      const currentSource = materialListById(source.id) || source;
      await persistVersion({ reason: 'removal', remove_item_ids: [item.id] }, { list: currentSource, baseItems: sourceItems });
      state.visibleListIds.add(cleanText(target.id));
      showToast((globalThis.PlatformLanguage?.text("materials","m_599de4dbc508a0","List changed") ?? "List changed"), ((v0,v1) => globalThis.PlatformLanguage?.text("materials","m_dc3174ff4c2ae4",`${v0} moved to ${v1}.`,{v0,v1}) ?? `${v0} moved to ${v1}.`)(item.name || 'Item',target.title || resourceTerms(resourceType(target), target).list), true);
    } catch (error) {
      replaceListItems(source.id, sourceItems);
      replaceListItems(target.id, targetItems);
      syncLineRow(itemId, source.id);
      try {
        const currentTarget = materialListById(target.id);
        if (listItems(currentTarget).some((entry) => cleanText(entry.id) === cleanText(item.id))) {
          await persistVersion({ reason: 'removal', remove_item_ids: [item.id] }, { list: currentTarget, baseItems: listItems(currentTarget) });
        }
      } catch (_) {}
      showToast((globalThis.PlatformLanguage?.text("materials","m_90625e9a36ebcb","Could not change list") ?? "Could not change list"), error?.message || 'Please try again.', false);
    } finally {
      state.saving = false;
      setWorkspaceSaving(false);
      syncFooterTotals();
    }
  }

  async function updateItemVariant(itemId, variantItemId, listId = state.activeListId){
    const targetList = materialListById(listId) || state.activeList;
    const current = listItems(targetList).find((item) => item.id === itemId);
    const catalogItem = state.pricebookItems.find((item) => item.id === variantItemId);
    if (!current || !catalogItem) return;
    const next = lineFromPricebookItem(catalogItem, {
      quantity: integerQuantity(current.quantity, 0),
      measurements: current.measurements || projectMeasurements(),
      selectedOptions: selectedOptionsFor(current)
    });
    await updateItem(itemId, {
      ...next,
      id: itemId,
      section: current.section || next.section,
      structure_id: current.structure_id || next.structure_id
    }, targetList?.id);
  }

  async function updateItemOption(itemId, optionId, value, listId = state.activeListId){
    const targetList = materialListById(listId) || state.activeList;
    const current = listItems(targetList).find((item) => item.id === itemId);
    if (!current) return;
    closeColorMenu();
    const selectedOptions = { ...selectedOptionsFor(current), [optionId]: value };
    const pricebookRef = { ...(current.pricebook_ref || {}), selected_options: selectedOptions };
    if (!(number(pricebookRef.catalog_revision, 0) > 0)) delete pricebookRef.catalog_revision;
    if (!(number(pricebookRef.item_revision, 0) > 0)) delete pricebookRef.item_revision;
    await updateItem(itemId, {
      selected_options: selectedOptions,
      product_selection: {
        ...(current.product_selection || {}),
        selected_options: selectedOptions
      },
      pricebook_ref: pricebookRef,
      pricebook_snapshot: {
        ...(current.pricebook_snapshot || {}),
        selected_options: selectedOptions
      }
    }, targetList?.id);
  }

  function dateFromOrderSchedule(draft = {}){
    const date = cleanText(draft.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const [year, month, day] = date.split('-').map(Number);
    const time = cleanText(draft.time);
    const [hour, minute] = /^\d{2}:\d{2}$/.test(time) ? time.split(':').map(Number) : [0, 0];
    const result = new Date(year, month - 1, day, hour, minute, 0, 0);
    return Number.isFinite(result.getTime()) ? result : null;
  }

  function orderScheduleFocusList(){
    const selected = selectedOrderLists();
    return selected.find((list) => cleanText(list.id) === cleanText(state.orderScheduleFocusListId)) || selected[0] || null;
  }

  function orderScheduleDraftId(list){
    return cleanText(linkedScheduleEvent(list)?.id) || `order_delivery_${cleanText(list?.id)}`;
  }

  function orderCalendarDraft(list){
    const draft = scheduleDraftForList(list);
    const existing = linkedScheduleEvent(list) || {};
    if (cleanText(existing.id) && draft.dirty !== true) return null;
    const start = draft.start ? new Date(draft.start) : dateFromOrderSchedule(draft);
    if (!start || !Number.isFinite(start.getTime())) return null;
    const allDay = draft.all_day !== false && !cleanText(draft.time);
    const fallbackEnd = new Date(start.getTime() + (allDay ? 24 * 60 : 60) * 60000);
    const parsedEnd = draft.end ? new Date(draft.end) : fallbackEnd;
    const end = Number.isFinite(parsedEnd.getTime()) && parsedEnd > start ? parsedEnd : fallbackEnd;
    return {
      ...existing,
      id: orderScheduleDraftId(list),
      event_id: cleanText(existing.id),
      material_list_id: cleanText(list?.id),
      scope_resource_list_id: cleanText(list?.id),
      resource_type: 'material',
      kind: 'material_delivery',
      schedule_item_kind: 'material_delivery',
      title: ((v0) => globalThis.PlatformLanguage?.text("materials","m_20094abf6017fb",`${v0} delivery`,{v0}) ?? `${v0} delivery`)(cleanText(list?.title) || 'Materials'),
      project_id: cleanText(state.project?.id),
      project_title: cleanText(state.project?.title || state.project?.name || state.project?.customer_name || state.project?.address),
      project_address: cleanText(state.project?.address),
      scope_color: materialListColor(list, Math.max(0, state.lists.indexOf(list))),
      color: materialListColor(list, Math.max(0, state.lists.indexOf(list))),
      start: start.toISOString(),
      end: end.toISOString(),
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      all_day: allDay,
      schedule_granularity: allDay ? 'date' : 'time',
      status: 'draft'
    };
  }

  function updateOrderScheduleFromCalendar(next, fallbackList = orderScheduleFocusList()){
    const listId = cleanText(next?.material_list_id || next?.scope_resource_list_id || fallbackList?.id);
    const list = materialListById(listId) || fallbackList;
    const start = next?.start ? new Date(next.start) : next?.start_at ? new Date(next.start_at) : null;
    if (!list || !start || !Number.isFinite(start.getTime())) return null;
    const allDay = next?.all_day !== false && next?.schedule_granularity !== 'time';
    const end = next?.end ? new Date(next.end) : next?.end_at ? new Date(next.end_at) : new Date(start.getTime() + (allDay ? 24 * 60 : 60) * 60000);
    const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    const time = allDay ? '' : `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
    state.orderScheduleDrafts[cleanText(list.id)] = {
      date,
      time,
      start: start.toISOString(),
      end: Number.isFinite(end.getTime()) ? end.toISOString() : '',
      all_day: allDay,
      dirty: true
    };
    state.orderDatesConfirmed = false;
    state.orderScheduleFocusListId = cleanText(list.id);
    state.orderCalendarDate = start;
    return list;
  }

  function renderOrderDeliveryCalendar(dialog = materialRoot()?.querySelector?.('[data-mt-order-dialog]')){
    const target = dialog?.querySelector?.('[data-mt-order-calendar]');
    const Scheduling = window.PlatformScheduling;
    const ScheduleView = window.PlatformScheduleView;
    const focusList = orderScheduleFocusList();
    if (!target) return;
    if (!focusList || !Scheduling || !ScheduleView?.renderProjectRangeScheduler) {
      target.innerHTML = `<div class="mt-order-calendar-empty"><i class="fas fa-calendar-xmark"></i><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_34f144e14d85d9","Calendar unavailable") ?? "Calendar unavailable")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_ce68b66a8b5f3b","Select a material list or reload the project calendar.") ?? "Select a material list or reload the project calendar.")}</span></div>`;
      return;
    }
    const selected = selectedOrderLists();
    const drafts = selected.map(orderCalendarDraft).filter(Boolean);
    const activeDraftId = orderScheduleDraftId(focusList);
    const editableIds = [activeDraftId];
    const projectEvents = (Array.isArray(state.project?.events) ? state.project.events : []).map((event) => ({
      ...event,
      project_id: cleanText(event?.project_id || state.project?.id),
      project_title: cleanText(event?.project_title || state.project?.title || state.project?.name || state.project?.customer_name || state.project?.address),
      project_address: cleanText(event?.project_address || state.project?.address)
    }));
    const rerenderCalendar = () => renderOrderDeliveryCalendar(dialog);
    ScheduleView.renderProjectRangeScheduler(target, {
      Scheduling,
      project: state.project || null,
      events: projectEvents,
      drafts,
      activeDraftId,
      allowCreate: true,
      allowEdit: true,
      editableEventIds: editableIds,
      canEditEvent: (event) => cleanText(event?.id || event?.event_id) === activeDraftId,
      eventIsEditable: (event) => cleanText(event?.id || event?.event_id) === activeDraftId,
      placementMode: 'click',
      mode: state.orderCalendarMode,
      modes: ['day', '4day', 'week', 'month'],
      modeLabels: { '4day': '3 Day' },
      showModeSwitch: true,
      showToolbar: true,
      date: state.orderCalendarDate,
      slotMinutes: 30,
      shortRangeDayCount: 3,
      defaultDraftPayload(){
        const existing = linkedScheduleEvent(focusList) || {};
        return {
          ...existing,
          id: activeDraftId,
          event_id: cleanText(existing.id),
          material_list_id: cleanText(focusList.id),
          scope_resource_list_id: cleanText(focusList.id),
          resource_type: 'material',
          kind: 'material_delivery',
          schedule_item_kind: 'material_delivery',
          title: ((v0) => globalThis.PlatformLanguage?.text("materials","m_20094abf6017fb",`${v0} delivery`,{v0}) ?? `${v0} delivery`)(cleanText(focusList.title) || 'Materials'),
          project_id: cleanText(state.project?.id),
          project_title: cleanText(state.project?.title || state.project?.name || state.project?.customer_name || state.project?.address),
          project_address: cleanText(state.project?.address),
          scope_color: materialListColor(focusList, Math.max(0, state.lists.indexOf(focusList))),
          color: materialListColor(focusList, Math.max(0, state.lists.indexOf(focusList))),
          default_duration_ms: 60 * 60 * 1000
        };
      },
      onNavigate(nextDate){ state.orderCalendarDate = nextDate; rerenderCalendar(); },
      onModeChange(nextMode){ state.orderCalendarMode = ['day','4day','week','month'].includes(nextMode) ? nextMode : 'week'; rerenderCalendar(); },
      onDraftChange(next){ updateOrderScheduleFromCalendar(next, focusList); },
      onDraftConfirm(next){ updateOrderScheduleFromCalendar(next, focusList); syncOrderDialog(true); },
      onEventRangeChange(event, range){ updateOrderScheduleFromCalendar({ ...event, ...range }, focusList); syncOrderDialog(true); },
      onDraftSelect(draft){
        const listId = cleanText(draft?.material_list_id || draft?.scope_resource_list_id);
        if (listId && state.orderSelectedListIds.has(listId)) {
          state.orderScheduleFocusListId = listId;
          syncOrderDialog(true);
        }
      },
      onEventClick(event){
        const listId = cleanText(event?.material_list_id || event?.scope_resource_list_id);
        if (listId && state.orderSelectedListIds.has(listId)) {
          state.orderScheduleFocusListId = listId;
          syncOrderDialog(true);
        }
      }
    });
  }

  async function persistInlineDeliverySchedule(list, draft){
    const parsedStart = draft?.start ? new Date(draft.start) : null;
    const start = parsedStart && Number.isFinite(parsedStart.getTime()) ? parsedStart : dateFromOrderSchedule(draft);
    if (!start) throw new Error(`Choose a delivery date for ${cleanText(list?.title) || 'the selected list'}.`);
    const allDay = draft?.all_day !== false && !cleanText(draft.time);
    const parsedEnd = draft?.end ? new Date(draft.end) : null;
    const end = parsedEnd && Number.isFinite(parsedEnd.getTime()) && parsedEnd > start
      ? parsedEnd
      : new Date(start.getTime() + (allDay ? 24 * 60 : 60) * 60000);
    const ensured = await ensureScheduleEventForList(list, 'materials_order_modal');
    let currentList = ensured.list || list;
    let event = ensured.event || linkedScheduleEvent(currentList) || {
      id: uid('material_delivery'),
      title: cleanText(currentList.title) || 'Material delivery',
      material_list_id: cleanText(currentList.id),
      scope_resource_list_id: cleanText(currentList.id),
      resource_type: 'material',
      kind: 'material_delivery'
    };
    const Scheduling = window.PlatformScheduling;
    const updated = Scheduling?.updateProjectEventRange ? Scheduling.updateProjectEventRange(event, {
      start,
      end,
      all_day: allDay,
      start_date: cleanText(draft.date),
      end_date: cleanText(draft.date),
      schedule_granularity: allDay ? 'date' : 'time'
    }) : {
      ...event,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      all_day: allDay,
      start_date: cleanText(draft.date),
      end_date: cleanText(draft.date),
      schedule_granularity: allDay ? 'date' : 'time'
    };
    event = {
      ...updated,
      status: 'scheduled',
      material_list_id: cleanText(currentList.id),
      scope_resource_list_id: cleanText(currentList.id),
      resource_type: 'material',
      schedule_item_kind: 'material_delivery',
      kind: 'material_delivery',
      updated_at: todayIso()
    };
    if (apiReady() && Scheduling?.saveProjectEvent && state.project?.id && event.id) {
      const saved = await Scheduling.saveProjectEvent(orgId(), state.project, event, null);
      event = saved?.event || event;
      state.project = { ...(state.project || {}), ...(saved?.project || {}), events: saved?.project?.events || state.project?.events || [] };
    } else {
      const events = Array.isArray(state.project?.events) ? state.project.events : [];
      const index = events.findIndex((candidate) => cleanText(candidate.id) === cleanText(event.id));
      const nextEvents = [...events];
      if (index >= 0) nextEvents[index] = event;
      else nextEvents.push(event);
      state.project = { ...(state.project || {}), events: nextEvents };
    }
    currentList = updateMaterialListState({
      ...currentList,
      schedule_event_id: cleanText(event.id),
      schedule_status: 'scheduled',
      schedule: {
        ...(currentList.schedule || {}),
        event_id: cleanText(event.id),
        start_at: cleanText(event.start_at),
        end_at: cleanText(event.end_at),
        status: 'scheduled'
      }
    }) || currentList;
    callHost('setProject', state.project);
    return { list: currentList, event, start, end, allDay };
  }

  async function createOrderFromForm(form){
    const lists = selectedOrderLists().filter((list) => !materialListOrdered(list));
    if (!lists.length) return;
    if (!orderScheduleComplete()) {
      if (!state.orderTimingChoice) state.orderTimingChoice = 'scheduled';
      state.orderCalendarOpen = state.orderTimingChoice === 'scheduled';
      if (state.orderCalendarOpen) state.orderDatesConfirmed = false;
      syncOrderDialog(true);
      showToast((globalThis.PlatformLanguage?.text("materials","m_42d03dc71187fa","Delivery timing required") ?? "Delivery timing required"), (globalThis.PlatformLanguage?.text("materials","m_ce56d1a26a85bf","Schedule the selected deliveries or choose Order without dates.") ?? "Schedule the selected deliveries or choose Order without dates."), false);
      return;
    }
    captureOrderDraft(form.closest('[data-mt-order-dialog]'));
    const data = new FormData(form);
    const quotedAmount = number(data.get('quoted_price'), NaN);
    const paidAmount = number(data.get('paid_price'), NaN);
    const baseTitle = cleanText(data.get('title')) || (lists.length === 1 ? cleanText(lists[0].title) : 'Material order');
    state.saving = true;
    setWorkspaceSaving(true);
    materialRoot()?.querySelectorAll?.('[data-mt-order-dialog] button,[data-mt-order-dialog] input')?.forEach((control) => { control.disabled = true; });
    try {
      for (const originalList of lists) {
        let list = materialListById(originalList.id) || originalList;
        let scheduledEvent = null;
        let scheduledWindow = {};
        if (state.orderTimingChoice === 'scheduled') {
          const scheduled = await persistInlineDeliverySchedule(list, scheduleDraftForList(list));
          list = scheduled.list || list;
          scheduledEvent = scheduled.event;
          scheduledWindow = {
            date: cleanText(scheduleDraftForList(list).date),
            start_date: cleanText(scheduleDraftForList(list).date),
            time: cleanText(scheduleDraftForList(list).time),
            start_time: cleanText(scheduleDraftForList(list).time),
            start_at: scheduled.start.toISOString(),
            end_at: scheduled.end.toISOString(),
            precision: scheduled.allDay ? 'day' : 'datetime',
            timezone: Intl.DateTimeFormat(globalThis.PlatformLanguage?.formatLocale?.()).resolvedOptions().timeZone || ''
          };
        }
        const payload = {
          title: lists.length > 1 ? `${baseTitle} - ${cleanText(list.title)}` : baseTitle,
          order_source_id: cleanText(state.orderProvider) || defaultOrderSourceId(list),
          vendor: { name: cleanText(data.get('vendor')), email: cleanText(data.get('vendor_email')) },
          scheduled_window: scheduledWindow,
          schedule_event_id: cleanText(scheduledEvent?.id),
          delivery_status: state.orderTimingChoice === 'scheduled' ? 'scheduled' : 'unscheduled',
          quoted_price: Number.isFinite(quotedAmount) ? { amount: quotedAmount, currency: 'USD' } : undefined,
          paid_price: Number.isFinite(paidAmount) ? { amount: paidAmount, currency: 'USD' } : undefined,
          metadata: {
            source: 'materials_tab_manual_order',
            schedule_event_id: cleanText(scheduledEvent?.id),
            combined_request: lists.length > 1,
            combined_list_ids: lists.map((entry) => cleanText(entry.id)),
            material_list_color: materialListColor(list, Math.max(0, state.lists.indexOf(list)))
          }
        };
        if (!apiReady() || list.local) {
          const order = { id: uid('local_order'), material_list_id: cleanText(list.id), ...payload, items: listItems(list), created_at: todayIso(), revision: 1 };
          state.orders = [order, ...state.orders];
          updateMaterialListState({
            ...list,
            status: 'ordered',
            delivery_status: payload.delivery_status,
            locked_at: todayIso(),
            schedule: { ...(list.schedule || {}), locked: list.schedule?.lock_on_order !== false }
          });
        } else {
          const result = await window.MaterialsAPI.lists.createOrder(orgId(), list.id, {
            expected_revision: list.revision,
            ...payload
          });
          updateMaterialListState(result.material_list || result.list || list);
        }
      }
      showToast(
        lists.length === 1 ? 'Order recorded' : `${lists.length} orders recorded`,
        state.orderTimingChoice === 'scheduled' ? 'The selected material lists are tied to their delivery schedule.' : 'The selected material lists were ordered without delivery dates.',
        true
      );
      await loadActiveListDetails();
      window.dispatchEvent(new CustomEvent('fm:calendar:refresh'));
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("materials","m_d2037c2b3ce05a","Could not mark order") ?? "Could not mark order"), error?.message || 'Please try again.', false);
    } finally {
      state.saving = false;
      materialRoot()?.querySelector?.('[data-mt-order-dialog]')?.close?.();
      setWorkspaceSaving(false);
      lists.forEach((list) => syncScopeListCard(list.id));
      syncMaterialsGrid();
      syncOrderDialog(false);
    }
  }

  async function recordDelivery(orderId){
    const deliveredAt = new Date().toISOString();
    state.saving = true;
    setWorkspaceSaving(true);
    try {
      if (!apiReady()) {
        state.deliveriesByOrderId[orderId] = [{ id: uid('local_delivery'), status: 'delivered', actual_delivered_at: deliveredAt }];
        state.orders = state.orders.map((order) => order.id === orderId ? { ...order, delivery_status: 'delivered' } : order);
      } else {
        await window.MaterialsAPI.orders.recordDelivery(orgId(), orderId, {
          status: 'delivered',
          actual_delivered_at: deliveredAt
        });
        await loadActiveListDetails();
      }
      showToast((globalThis.PlatformLanguage?.text("materials","m_13cd17d955393a","Delivery recorded") ?? "Delivery recorded"), (globalThis.PlatformLanguage?.text("materials","m_0a3b15f149ad63","Materials marked delivered.") ?? "Materials marked delivered."), true);
    } catch (error) {
      showToast((globalThis.PlatformLanguage?.text("materials","m_28abf86e7c09a6","Could not record delivery") ?? "Could not record delivery"), error?.message || 'Please try again.', false);
    } finally {
      state.saving = false;
      setWorkspaceSaving(false);
      syncOrderDialog(false);
    }
  }

  function filteredItems(){
    const needle = state.search.toLowerCase();
    return visibleMaterialLists().flatMap((list) => listItems(list).map((item) => decoratedLineItem(item, list))).filter((item) => {
      if (state.selectedSection !== 'all' && lineSectionKey(item) !== state.selectedSection) return false;
      if (state.activeStructureId !== 'total' && cleanText(item.structure_id) && cleanText(item.structure_id) !== state.activeStructureId) return false;
      if (!needle) return true;
      return `${item.name || ''} ${item.code || ''} ${item.category || ''} ${item.section || ''}`.toLowerCase().includes(needle);
    });
  }

  function sectionItems(sectionKey){
    return filteredItems().filter((item) => lineSectionKey(item) === sectionKey);
  }

  function sectionSuppressedByMeasurements(sectionKey){
    const measures = projectMeasurements();
    if (sectionKey === 'shingles') return number(measures.slopeSquares ?? measures.shingleSquares, 0) <= 0;
    if (sectionKey === 'flat_roofing') return number(measures.flatRoofSquares, 0) <= 0;
    return false;
  }

  function missingMeasurementKeys(){
    const measures = projectMeasurements();
    return [
      ['eavesLf', 'Eaves'],
      ['rakesLf', 'Rakes'],
      ['hipsLf', 'Hips'],
      ['ridgesLf', 'Ridges'],
      ['valleyLf', 'Valleys']
    ].filter(([key]) => number(measures[key], 0) <= 0).map(([, label]) => label);
  }

  function sectionNeedsMeasurements(sectionKey){
    return false;
  }

  function suggestedItems(){
    const existing = new Set(listItems().map((item) => cleanText(item.pricebook_ref?.item_id || item.pricebookItemId)).filter(Boolean));
    const query = state.pricebookSearch.toLowerCase();
    return state.pricebookItems
      .filter((item) => !existing.has(cleanText(item.id)))
      .filter((item) => !query || `${item.name} ${item.category} ${item.description || ''}`.toLowerCase().includes(query))
      .slice(0, 24);
  }

  function statusClass(value){
    return cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  }

  function ensureStyles(){
    if (stylesInjected) return;
    injectCSS('materials-tab', css());
    window.PlatformUI?.initTooltips?.();
    stylesInjected = true;
  }

  function scheduleArrange(root){
    if (!root || typeof requestAnimationFrame !== 'function') {
      arrangeMaterialColumns(root);
      return;
    }
    if (arrangeFrame) cancelAnimationFrame(arrangeFrame);
    arrangeFrame = requestAnimationFrame(() => {
      arrangeFrame = requestAnimationFrame(() => {
        arrangeFrame = 0;
        arrangeMaterialColumns(root);
      });
    });
  }

  function render(options = {}){
    const timingStart = performance.now();
    if (!state.panelRoot) return;
    closeListMenu();
    const activeSelector = document.activeElement?.matches?.('[data-mt-pricebook-search]')
      ? '[data-mt-pricebook-search]'
      : '';
    const activeSelection = activeSelector ? {
      start: document.activeElement.selectionStart,
      end: document.activeElement.selectionEnd
    } : null;
    const previousScrollTop = options.preserveScroll
      ? number(state.panelRoot.querySelector('[data-materials-root] .mt-material-scroll')?.scrollTop, 0)
      : 0;
    ensureStyles();
    const root = state.panelRoot.querySelector('[data-materials-root]') || state.panelRoot;
    const list = state.activeList;
    const totals = visibleListTotals();
    const ordered = materialListOrdered(list);
    const activeType = resourceType(list);
    const activeTerms = resourceTerms(activeType, list);
    const canSchedule = !!list && resourceScheduleEnabled(list);
    const visibleCount = visibleMaterialLists().length;
    const htmlStart = performance.now();
    root.innerHTML = `
      <div class="mt-top">
        <div class="mt-title">
          <i class="fas fa-clipboard-list"></i>
          <div><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_9d3e82ecfd10ec","Scope") ?? "Scope")}</strong><span>${String(escapeHtml(list ? `${list.title || activeTerms.list} active · ${visibleCount} of ${state.lists.length} visible` : (state.project?.address || state.project?.title || (globalThis.PlatformLanguage?.text("materials","m_c9170d09831e64","No scope lists") ?? "No scope lists"))))}</span></div>
        </div>
        <div class="mt-actions">
          <button type="button" class="mt-icon-btn" data-mt-refresh title="${(globalThis.PlatformLanguage?.htmlText("materials","m_78973ce0cf3403","Refresh") ?? "Refresh")}"><i class="fas fa-rotate"></i></button>
          ${String(activeType === 'material' ? `<button type="button" class="mt-btn${state.pricebookOpen ? ' primary' : ''}" data-mt-open-pricebook ${!list ? 'disabled' : ''}><i class="fas fa-book"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_cf3630161575f6"," Price Book") ?? " Price Book")}</button>` : '')}
          <button type="button" class="mt-btn" data-mt-add-custom ${String(!list ? 'disabled' : '')}><i class="fas fa-plus"></i> ${String(escapeHtml(activeTerms.singular))}</button>
          ${String(canSchedule ? `<button type="button" class="mt-btn" data-mt-schedule-list="${escapeHtml(list?.id || '')}" ${state.saving || state.schedulingListId ? 'disabled' : ''}><i class="fas ${state.schedulingListId === cleanText(list?.id) ? 'fa-rotate mt-spin' : 'fa-calendar-day'}"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_80ce49ac8b6049"," Schedule") ?? " Schedule")}</button>` : '')}
          ${String(activeType === 'material' ? `<button type="button" class="mt-btn ${ordered ? 'success' : 'primary'}" data-mt-order ${!listItems().length || state.saving ? 'disabled' : ''}><i class="fas ${ordered ? 'fa-circle-check' : 'fa-cart-shopping'}"></i> ${ordered ? 'Ordered' : 'Order'}</button>` : '')}
        </div>
      </div>
      <div class="mt-body">
        <main class="mt-main">
          ${String(state.loading ? `<div class="mt-card"><p>${(globalThis.PlatformLanguage?.htmlText("materials","m_7b94d3b02679a9","Loading scope...") ?? "Loading scope...")}</p></div>` : '')}
          ${String(state.lastError ? `<div class="mt-card"><p>${escapeHtml(state.lastError)}</p></div>` : '')}
          <div class="mt-material-scroll" data-mt-material-scroll>
            <div class="mt-material-grid" data-mt-material-grid>
              ${String(renderMaterialSections())}
            </div>
          </div>
          ${String(activeType === 'labor' ? renderLaborProjectionPanel(list) : '')}
          ${String(state.pricebookOpen && activeType === 'material' ? renderPricebookPanel() : '')}
          <div class="mt-footer">
            <div class="mt-summary-grid">
              <div class="mt-stat"><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_929d3bd2149645","Projected") ?? "Projected")}</span><strong>${String(money(totals.projected))}</strong></div>
              <div class="mt-stat"><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_f05be3d739b87e","Quoted") ?? "Quoted")}</span><strong>${String(money(totals.quoted))}</strong></div>
              <div class="mt-stat"><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_956173c8527121","Paid") ?? "Paid")}</span><strong>${String(money(totals.paid))}</strong></div>
            </div>
          </div>
        </main>
      </div>
      ${String(activeType === 'material' ? renderOrderDialog() : '')}
      ${String(renderNewListDialog())}
    `;
    timingMark('render:innerHTML', { items: listItems().length, pricebookOpen: state.pricebookOpen, loading: state.loading }, htmlStart);
    const bindStart = performance.now();
    bindMain(root);
    timingMark('render:bindMain', { items: listItems().length }, bindStart);
    if (options.preserveScroll) {
      const scroller = root.querySelector('.mt-material-scroll');
      if (scroller) scroller.scrollTop = previousScrollTop;
    }
    if (activeSelector) {
      const input = root.querySelector(activeSelector);
      input?.focus?.();
      if (input?.setSelectionRange && activeSelection) input.setSelectionRange(activeSelection.start, activeSelection.end);
    }
    positionColorPortal(root);
    scheduleArrange(root);
    timingMark('render:end', { items: listItems().length, pricebookOpen: state.pricebookOpen, preserveScroll: !!options.preserveScroll }, timingStart);
  }

  function expenseTargetForList(list){
    const targets = Array.isArray(state.expenseSummary?.targets) ? state.expenseSummary.targets : [];
    return targets.find((target) => cleanText(target?.source_type) === 'scope_resource_list' && cleanText(target?.source_id) === cleanText(list?.id)) || null;
  }

  function laborDetailMeta(detail){
    const hours = number(detail?.hours, 0);
    const quantity = number(detail?.quantity, 0);
    const rate = number(detail?.rate_cents, 0);
    if (hours > 0) return `${hours.toLocaleString(undefined, { maximumFractionDigits:2 })} hr × ${money(rate / 100)}`;
    if (quantity > 0) return `${quantity.toLocaleString(undefined, { maximumFractionDigits:2 })} ${cleanText(detail?.unit) || 'units'} × ${money(rate / 100)}`;
    return rate > 0 ? `${money(rate / 100)} rate` : '';
  }

  function renderLaborProjectionPanel(list){
    const target = expenseTargetForList(list);
    const projection = target?.details || {};
    const details = Array.isArray(projection?.details) ? projection.details.filter((detail) => number(detail?.projected_cents, 0) > 0) : [];
    const groups = [
      { kind:'salary', title:(globalThis.PlatformLanguage?.text("materials","m_3fa0dba842bd13","Salary converted to hourly") ?? "Salary converted to hourly"), icon:'fa-calendar-check' },
      { kind:'hourly', title:(globalThis.PlatformLanguage?.text("materials","m_e05a1e64b972f8","Hourly wages") ?? "Hourly wages"), icon:'fa-clock' },
      { kind:'piece_rate', title:(globalThis.PlatformLanguage?.text("materials","m_4c9b3b4cfd52b2","Piece-rate work") ?? "Piece-rate work"), icon:'fa-list-check' }
    ].map((group) => ({ ...group, rows:details.filter((detail) => cleanText(detail?.kind) === group.kind) })).filter((group) => group.rows.length);
    const total = number(target?.projected_cents, projection?.projected_cents || 0);
    const resourceName = cleanText(projection?.work_resource_ref?.name);
    if (state.expenseError) return `<section class="mt-labor-estimate"><div class="mt-labor-estimate-head"><div><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_64da48200b02da","Estimated labor expense") ?? "Estimated labor expense")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_ce86fe78082565","Unavailable") ?? "Unavailable")}</span></div></div><div class="mt-empty">${((v0) => globalThis.PlatformLanguage?.htmlText("materials","m_894fbe7ce53443",`${v0} Refresh the project before relying on this estimate.`,{v0}) ?? `${v0} Refresh the project before relying on this estimate.`)(escapeHtml(state.expenseError))}</div></section>`;
    return `<section class="mt-labor-estimate">
      <div class="mt-labor-estimate-head"><div><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_64da48200b02da","Estimated labor expense") ?? "Estimated labor expense")}</strong><span>${String(escapeHtml(resourceName || (state.expenseLoading ? 'Updating estimate...' : `Assign a ${workResourceLabel()} to calculate team member rates`)))}</span></div><strong>${String(money(total / 100))}</strong></div>
      ${String(groups.length ? `<div class="mt-labor-breakdown">${groups.map((group) => `<div class="mt-labor-breakdown-group"><div class="mt-labor-breakdown-title"><span><i class="fas ${escapeHtml(group.icon)}"></i>${escapeHtml(group.title)}</span><strong>${money(group.rows.reduce((sum, row) => sum + number(row.projected_cents, 0), 0) / 100)}</strong></div>${group.rows.map((detail) => `<div class="mt-labor-breakdown-row"><div><strong>${escapeHtml(detail.label || titleFromKey(detail.kind))}</strong><span>${escapeHtml(laborDetailMeta(detail))}</span></div><strong>${money(number(detail.projected_cents, 0) / 100)}</strong></div>`).join('')}</div>`).join('')}</div>` : `<div class="mt-empty">${cleanText(projection?.mode) === 'none' ? 'This labor list is excluded from project expenses.' : 'Enter piece rates or estimated hours, then assign compensation to see the breakdown.'}</div>`)}
    </section>`;
  }

  function renderSectionTab(id, label, icon){
    return `<button type="button" class="mt-section-tab${state.selectedSection === id ? ' active' : ''}" data-mt-section="${escapeHtml(id)}"><i class="fas ${escapeHtml(icon)}"></i>${escapeHtml(label)}</button>`;
  }

  function materialSectionDefinitions(){
    const defs = [
      ...SECTION_DEFS,
      { key: 'labor', title: resourceTerms('labor', state.lists.find((list) => resourceType(list) === 'labor')).plural, icon: 'fa-helmet-safety', resource_type: 'labor' },
      { key: 'equipment', title: resourceTerms('equipment', state.lists.find((list) => resourceType(list) === 'equipment')).plural, icon: 'fa-truck-pickup', resource_type: 'equipment' }
    ];
    const known = new Set(defs.map((section) => section.key));
    filteredItems().forEach((item) => {
      const key = lineSectionKey(item);
      if (known.has(key)) return;
      known.add(key);
      defs.push({ key, title: key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()), icon: 'fa-box' });
    });
    return defs;
  }

  function renderMaterialSections(){
    const sections = materialSectionDefinitions()
      .filter((section) => sectionItems(section.key).length > 0);
    if (!sections.length) {
      const message = state.lists.length
        ? 'No visible scope items. Use the eye controls to show a list, or add an item to the active list.'
        : 'No resource lists are defined for this scope.';
      return `<section class="mt-section mt-material-empty"><div class="mt-empty">${escapeHtml(message)}</div></section>`;
    }
    const columns = [sections, []];
    return columns.map((column) => `
      <div class="mt-material-column">
        ${column.map((section) => {
      const items = sectionItems(section.key);
      return renderMaterialSection(section, items);
    }).join('')}
      </div>
    `).join('');
  }

  function renderMaterialSection(section, items = sectionItems(section.key)){
    const needsData = sectionNeedsMeasurements(section.key);
    const type = section.resource_type || 'material';
    const terms = resourceTerms(type, materialListById(items[0]?.__material_list_id));
    const material = type === 'material';
    const labor = type === 'labor';
    return `
      <section class="mt-section${String(needsData ? ' needs-data' : '')}" data-mt-section-key="${String(escapeHtml(section.key))}">
        <div class="mt-section-head"><h3><i class="fas ${String(escapeHtml(section.icon))}"></i>${String(escapeHtml(section.title))}</h3><div class="mt-section-head-actions"><span class="${String(needsData ? 'mt-warn' : '')}">${String(needsData ? 'Needs measurements' : `${items.length} items`)}</span>${String(material ? `<button type="button" class="mt-units-toggle${state.unitsMode === 'order' ? ' order' : ''}" data-mt-units-toggle data-fm-tooltip="${state.unitsMode === 'order' ? 'Showing order units (bundles, rolls, pieces). Click for measured amounts.' : 'Showing measured amounts. Click for order units (bundles, rolls, pieces).'}" aria-pressed="${state.unitsMode === 'order' ? 'true' : 'false'}"><i class="fas ${state.unitsMode === 'order' ? 'fa-boxes-stacked' : 'fa-ruler-combined'}"></i>${state.unitsMode === 'order' ? 'Order units' : 'Measured'}</button>` : '')}<button type="button" class="mt-section-add" data-mt-add-section="${String(escapeHtml(section.key))}" title="${((v8,v9) => globalThis.PlatformLanguage?.htmlText("materials","m_c63af829948dff",`Add ${v8} to ${v9}`,{v8,v9}) ?? `Add ${v8} to ${v9}`)(escapeHtml(terms.singular.toLowerCase()),escapeHtml(section.title))}" aria-label="${((v10,v11) => globalThis.PlatformLanguage?.htmlText("materials","m_d8e783b101ecb6",`Add ${v10} to ${v11}`,{v10,v11}) ?? `Add ${v10} to ${v11}`)(escapeHtml(terms.singular.toLowerCase()),escapeHtml(section.title))}" ${String(state.saving ? 'disabled' : '')}><i class="fas fa-plus"></i></button></div></div>
        <table class="mt-table">
          <colgroup><col>${String(material ? '<col style="width:52px">' : '')}${String(labor ? '<col style="width:90px">' : '')}<col style="width:82px"><col style="width:58px"><col style="width:74px"><col style="width:52px"></colgroup>
          <thead><tr><th>${String(escapeHtml(terms.singular))}</th>${String(material ? `<th>${(globalThis.PlatformLanguage?.htmlText("materials","m_db7002926d9977","Color") ?? "Color")}</th>` : '')}${String(labor ? `<th>${(globalThis.PlatformLanguage?.htmlText("materials","m_d9b2666bd68237","Pay type") ?? "Pay type")}</th>` : '')}<th>${(globalThis.PlatformLanguage?.htmlText("materials","m_1a29aea570fbc4","Qty") ?? "Qty")}</th><th>${(globalThis.PlatformLanguage?.htmlText("materials","m_4b91b73dae1ff3","Unit") ?? "Unit")}</th><th>${String(type === 'labor' ? 'Rate' : 'Unit $')}</th><th></th></tr></thead>
          <tbody>${String(items.length ? items.map(renderLineRow).join('') : `<tr><td colspan="${material ? 6 : labor ? 6 : 5}"><div class="mt-empty">${((v1) => globalThis.PlatformLanguage?.htmlText("materials","m_78337592690145",`No ${v1} in this category.`,{v1}) ?? `No ${v1} in this category.`)(escapeHtml(terms.plural.toLowerCase()))}</div></td></tr>`)}</tbody>
        </table>
      </section>
    `;
  }

  function arrangeMaterialColumns(root){
    const timingStart = performance.now();
    const scroll = root.querySelector('[data-mt-material-scroll]');
    const grid = root.querySelector('[data-mt-material-grid]');
    if (!scroll || !grid) {
      positionColorPortal(root);
      return;
    }
    const columns = Array.from(grid.querySelectorAll('.mt-material-column'));
    if (columns.length < 2 || grid.clientWidth <= 900 || window.matchMedia?.('(max-width: 980px)')?.matches) {
      if (columns.length >= 2) {
        const sections = [...columns[0].children, ...columns[1].children];
        columns[0].replaceChildren(...sections);
        columns[1].replaceChildren();
      }
      positionColorPortal(root);
      return;
    }
    const [left, right] = columns;
    const sections = [...left.children, ...right.children];
    if (sections.length <= 1) {
      positionColorPortal(root);
      return;
    }
    left.replaceChildren(...sections);
    right.replaceChildren();
    const gap = number(getComputedStyle(left).rowGap || getComputedStyle(left).gap, 14);
    const heights = sections.map((section) => section.getBoundingClientRect().height);
    let bestSplit = 1;
    let bestDifference = Number.POSITIVE_INFINITY;
    for (let split = 1; split < sections.length; split += 1) {
      const leftHeight = heights.slice(0, split).reduce((sum, value) => sum + value, 0) + (gap * Math.max(0, split - 1));
      const rightHeight = heights.slice(split).reduce((sum, value) => sum + value, 0) + (gap * Math.max(0, sections.length - split - 1));
      const difference = Math.abs(leftHeight - rightHeight);
      if (difference < bestDifference) {
        bestDifference = difference;
        bestSplit = split;
      }
    }
    left.replaceChildren(...sections.slice(0, bestSplit));
    right.replaceChildren(...sections.slice(bestSplit));
    positionColorPortal(root);
    timingMark('arrangeMaterialColumns', { sections: sections.length, split: bestSplit, leftHeight: left.scrollHeight, rightHeight: right.scrollHeight }, timingStart);
  }

  function renderLineRow(item){
    const variants = variantsForLine(item);
    const secondary = materialSecondaryText(item, variants.length > 1);
    const listId = cleanText(item.__material_list_id || state.activeListId);
    const listTitle = cleanText(item.__material_list_title || state.activeList?.title || (globalThis.PlatformLanguage?.text("materials","m_691187e28aba8e","Materials") ?? "Materials"));
    const listColor = normalizeColor(item.__material_list_color || materialListColor(materialListById(listId)));
    const incomplete = item.__scope_list_incomplete === true;
    const type = cleanText(item.__resource_type || resourceType(materialListById(listId))) || 'material';
    const quantity = type === 'material' ? integerQuantity(item.quantity, 0) : preciseQuantity(item.quantity, 0);
    const material = type === 'material';
    const labor = type === 'labor';
    const payType = cleanText(item?.metadata?.compensation_kind || item?.metadata?.pay_type || item?.metadata?.estimate_mode || 'piece_rate').replace('piece-rate', 'piece_rate');
    const orderInfo = material && state.unitsMode === 'order' ? orderInfoForLine(item, quantity) : null;
    const orderTooltip = orderInfo ? `Measured: ${quantity} ${cleanText(item.unit || 'ea')}${orderInfo.covered_quantity !== quantity ? ` · ${orderInfo.order_quantity} ${orderInfo.order_unit} covers ${orderInfo.covered_quantity} ${cleanText(item.unit || 'ea')}` : ''}${orderInfo.packaging?.description ? ` · ${orderInfo.packaging.description}` : ''}` : '';
    return `
      <tr class="mt-list-row ${String(incomplete ? 'incomplete' : 'complete')}" data-mt-item-row="${String(escapeHtml(item.id))}" data-mt-list-id="${String(escapeHtml(listId))}" style="--list-color:${String(escapeHtml(listColor))}">
        <td><div class="mt-line-main"><div class="mt-line-title"><button type="button" class="mt-list-dot" style="--list-color:${String(escapeHtml(listColor))}" data-mt-list-trigger="${String(escapeHtml(item.id))}" data-mt-list-id="${String(escapeHtml(listId))}" data-fm-tooltip="${String(escapeHtml(listTitle))}" title="${(globalThis.PlatformLanguage?.htmlText("materials","m_b939dc874a0fda","Move to another list") ?? "Move to another list")}" aria-label="${((v8) => globalThis.PlatformLanguage?.htmlText("materials","m_790adaaf81ef83",`Change list for ${v8}`,{v8}) ?? `Change list for ${v8}`)(escapeHtml(materialPrimaryName(item)))}" aria-expanded="${String(state.listMenu?.itemId === item.id ? 'true' : 'false')}" ${String(state.saving ? 'disabled' : '')}></button><input class="mt-input mt-cell-input mt-line-name" data-mt-item-name="${String(escapeHtml(item.id))}" data-mt-list-id="${String(escapeHtml(listId))}" value="${String(escapeHtml(materialPrimaryName(item)))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_7bd2b28790fb35","Item name") ?? "Item name")}" ${String(state.saving ? 'disabled' : '')}></div>${String(material ? renderVariantControl(item, variants) : '')}${String(material && secondary ? `<span>${escapeHtml(secondary)}</span>` : '')}</div></td>
        ${String(material ? `<td>${renderColorControl(item)}</td>` : '')}
        ${String(labor ? `<td><select class="mt-input mt-cell-input" data-mt-item-pay-type="${escapeHtml(item.id)}" data-mt-list-id="${escapeHtml(listId)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_d9b2666bd68237","Pay type") ?? "Pay type")}" ${state.saving ? 'disabled' : ''}><option value="piece_rate" ${payType === 'piece_rate' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("materials","m_237cf67332e1e8","Piece rate") ?? "Piece rate")}</option><option value="hourly" ${payType === 'hourly' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("materials","m_6a122e6ae08ae2","Hourly") ?? "Hourly")}</option><option value="salary" ${payType === 'salary' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("materials","m_40c128013ab7d0","Salary") ?? "Salary")}</option></select></td>` : '')}
        ${String(orderInfo ? `
        <td><div class="mt-order-qty-cell" data-fm-tooltip="${escapeHtml(orderTooltip)}"><strong>${escapeHtml(orderInfo.order_quantity)}</strong><span>${escapeHtml(`${quantity} ${cleanText(item.unit || 'ea')}`)}</span></div></td>
        <td><div class="mt-order-qty-cell" data-fm-tooltip="${escapeHtml(orderTooltip)}"><strong>${escapeHtml(orderInfo.order_unit)}</strong>${orderInfo.packaging?.description ? `<span>${escapeHtml(orderInfo.packaging.description)}</span>` : ''}</div></td>` : `
        <td><input class="mt-input mt-cell-input mt-number mt-qty-input" data-mt-item-qty="${escapeHtml(item.id)}" data-mt-list-id="${escapeHtml(listId)}" type="number" min="0" step="${type === 'material' ? '1' : '0.01'}" value="${escapeHtml(quantity || '')}" ${state.saving ? 'disabled' : ''}></td>
        <td><input class="mt-input mt-cell-input" data-mt-item-unit="${escapeHtml(item.id)}" data-mt-list-id="${escapeHtml(listId)}" value="${escapeHtml(item.unit || '')}" ${state.saving ? 'disabled' : ''}></td>`)}
        <td><input class="mt-input mt-cell-input mt-number" data-mt-item-price="${String(escapeHtml(item.id))}" data-mt-list-id="${String(escapeHtml(listId))}" type="number" min="0" step="0.01" value="${String(escapeHtml(item.projected_unit_price ?? ''))}" title="${String(escapeHtml(item.projected_total != null ? `Total ${money(item.projected_total)}` : ''))}" ${String(state.saving ? 'disabled' : '')}></td>
        <td><button type="button" class="mt-icon-btn" data-mt-remove="${String(escapeHtml(item.id))}" data-mt-list-id="${String(escapeHtml(listId))}" title="${(globalThis.PlatformLanguage?.htmlText("materials","m_f643f568915438","Remove") ?? "Remove")}" ${String(state.saving ? 'disabled' : '')}><i class="fas fa-trash"></i></button></td>
      </tr>
    `;
  }

  function renderVariantControl(item, variants = variantsForLine(item)){
    const currentId = cleanText(item.pricebook_ref?.item_id || item.product_selection?.variant_item_id || item.pricebookItemId);
    if (variants.length <= 1) {
      const variantName = cleanText(item.product_selection?.variant_name || item.pricebook_snapshot?.variant?.name);
      return variantName && variantName !== materialPrimaryName(item) ? `<span>${escapeHtml(variantName)}</span>` : '';
    }
    return `
      <select class="mt-variant-select" data-mt-item-variant="${escapeHtml(item.id)}" data-mt-list-id="${escapeHtml(item.__material_list_id || state.activeListId)}" ${state.saving ? 'disabled' : ''}>
        ${groupedVariantsForLine(item).map((group) => `
          <optgroup label="${escapeHtml(group.name)}">
            ${group.variants.map((variant) => `<option value="${escapeHtml(variant.id)}" ${variant.id === currentId ? 'selected' : ''}>${escapeHtml(variant.variantName || variant.name)}</option>`).join('')}
          </optgroup>
        `).join('')}
      </select>
    `;
  }

  function renderColorControl(item){
    const definition = optionDefinition(item, 'color');
    const values = optionValues(definition);
    if (!values.length) return '<span class="mt-small">-</span>';
    const selected = cleanText(selectedOptionsFor(item).color || definition.defaultValue || values[0]?.value);
    const selectedMeta = values.find((value) => cleanText(value.value) === selected) || values[0];
    const rich = richColorPicker(item);
    return `
      <button type="button" class="mt-color-trigger${String(rich ? ' rich' : '')}" data-mt-color-trigger="${String(escapeHtml(item.id))}" data-mt-list-id="${String(escapeHtml(item.__material_list_id || state.activeListId))}" data-fm-tooltip="${String(escapeHtml(selectedMeta?.label || selected))}" title="${String(escapeHtml(selectedMeta?.label || selected))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_d453ffba808085","Choose color") ?? "Choose color")}" aria-expanded="${String(state.colorMenu?.itemId === item.id ? 'true' : 'false')}" ${String(state.saving ? 'disabled' : '')}>
        <span class="mt-color-current"><span class="mt-color-swatch" style="${String(escapeHtml(optionValueBackground(selectedMeta)))}"></span>${String(selectedMeta?.label ? `<em>${escapeHtml(selectedMeta.label)}</em>` : '')}</span>
      </button>
    `;
  }

  function renderColorPortal(){
    const menu = state.colorMenu;
    if (!menu?.itemId) return '';
    const item = listItems(materialListById(menu.listId)).find((entry) => entry.id === menu.itemId);
    const definition = optionDefinition(item, 'color');
    const values = optionValues(definition);
    if (!item || !values.length) return '';
    const selected = cleanText(selectedOptionsFor(item).color || definition.defaultValue || values[0]?.value);
    const rich = richColorPicker(item);
    return `
      <div class="mt-color-portal${rich ? ' rich' : ''}" data-mt-color-portal style="left:${escapeHtml(menu.left)}px;top:${escapeHtml(menu.top)}px">
        <div class="mt-color-options">
          ${values.map((value) => `
            <button type="button" class="mt-color-option${rich ? ' rich' : ''}${cleanText(value.value) === selected ? ' active' : ''}" data-mt-item-option="${escapeHtml(item.id)}" data-mt-list-id="${escapeHtml(menu.listId || state.activeListId)}" data-mt-option-id="color" data-mt-option-value="${escapeHtml(value.value)}" title="${escapeHtml(value.label || value.value)}" style="${escapeHtml(optionValueBackground(value))}"><span>${escapeHtml(value.label || value.value)}</span></button>
          `).join('')}
        </div>
      </div>
    `;
  }

  function colorPortalHost(root = state.panelRoot){
    let node = root;
    let fixedHost = null;
    while (node && node !== document.body) {
      if (node.tagName === 'DIALOG' || node.getAttribute?.('aria-modal') === 'true') return node;
      const style = window.getComputedStyle?.(node);
      if (style?.position === 'fixed' && style.zIndex !== 'auto') fixedHost = node;
      node = node.parentElement;
    }
    return fixedHost || document.body;
  }

  function toggleColorMenu(itemId, trigger, listId = state.activeListId){
    if (state.colorMenu?.itemId === itemId && state.colorMenu?.listId === listId) {
      closeColorMenu();
      return;
    }
    const item = listItems(materialListById(listId)).find((entry) => entry.id === itemId);
    const values = optionValues(optionDefinition(item, 'color'));
    if (!item || !values.length || !trigger?.getBoundingClientRect) return;
    const rich = richColorPicker(item);
    const rect = trigger.getBoundingClientRect();
    const width = rich ? 250 : Math.max(72, Math.min(320, (values.length * 38) + 18));
    const rows = rich ? Math.ceil(values.length / 2) : 1;
    const height = rich ? (rows * 65) + 18 : 48;
    state.colorMenu = { itemId, listId, ...colorMenuPosition(trigger, width, height) };
    const root = state.panelRoot?.querySelector?.('[data-materials-root]') || state.panelRoot;
    if (!root) return;
    document.querySelectorAll('[data-mt-color-portal]').forEach((node) => node.remove());
    const holder = document.createElement('div');
    holder.innerHTML = renderColorPortal();
    const portal = holder.firstElementChild;
    if (!portal) return;
    colorPortalHost(root).appendChild(portal);
    trigger.setAttribute('aria-expanded', 'true');
    positionColorPortal(root);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => positionColorPortal(root));
      requestAnimationFrame(() => requestAnimationFrame(() => positionColorPortal(root)));
    }
    window.setTimeout?.(() => positionColorPortal(root), 120);
    portal.querySelectorAll('[data-mt-item-option]').forEach((button) => {
      const applyOption = () => {
        if (button.dataset.mtApplying === 'true') return;
        button.dataset.mtApplying = 'true';
        updateItemOption(button.dataset.mtItemOption, button.dataset.mtOptionId, button.dataset.mtOptionValue, button.dataset.mtListId);
      };
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        applyOption();
      });
      button.addEventListener('click', applyOption);
    });
    root.querySelector('[data-mt-material-scroll]')?.addEventListener('scroll', closeColorMenu, { once: true, passive: true });
  }

  function closeColorMenu(){
    state.colorMenu = null;
    state.listMenu = null;
    const root = state.panelRoot?.querySelector?.('[data-materials-root]') || state.panelRoot;
    document.querySelectorAll?.('[data-mt-color-portal]')?.forEach((node) => node.remove());
    root?.querySelectorAll?.('[data-mt-color-trigger][aria-expanded="true"]')?.forEach((button) => button.setAttribute('aria-expanded', 'false'));
  }

  function decoratedLineItem(item, list, listIndex = state.lists.indexOf(list)){
    return {
      ...item,
      __material_list_id: cleanText(list?.id),
      __material_list_title: cleanText(list?.title) || 'Material list',
      __material_list_color: materialListColor(list, Math.max(0, listIndex)),
      __material_list_ordered: materialListOrdered(list),
      __scope_list_incomplete: resourceListIncomplete(list),
      __resource_type: resourceType(list)
    };
  }

  function renderedLineItem(itemId, listId){
    const list = materialListById(listId);
    const item = listItems(list).find((entry) => cleanText(entry.id) === cleanText(itemId));
    return item && list ? decoratedLineItem(item, list) : null;
  }

  function materialRoot(){
    return state.panelRoot?.querySelector?.('[data-materials-root]') || state.panelRoot;
  }

  function findByData(root, selector, key, value){
    return Array.from(root?.querySelectorAll?.(selector) || []).find((node) => cleanText(node.dataset?.[key]) === cleanText(value)) || null;
  }

  function syncFooterTotals(){
    const root = materialRoot();
    const values = root?.querySelectorAll?.('.mt-footer .mt-stat strong');
    if (!values || values.length < 3) return;
    const totals = visibleListTotals();
    values[0].textContent = money(totals.projected);
    values[1].textContent = money(totals.quoted);
    values[2].textContent = money(totals.paid);
  }

  function topBarHtml(){
    const list = state.activeList;
    const activeType = resourceType(list);
    const activeTerms = resourceTerms(activeType, list);
    const ordered = materialListOrdered(list);
    const canSchedule = !!list && resourceScheduleEnabled(list);
    return `<div class="mt-top">
      <div class="mt-title"><i class="fas fa-clipboard-list"></i><div><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_9d3e82ecfd10ec","Scope") ?? "Scope")}</strong></div></div>
      <div class="mt-actions">
        <button type="button" class="mt-icon-btn" data-mt-refresh title="${(globalThis.PlatformLanguage?.htmlText("materials","m_78973ce0cf3403","Refresh") ?? "Refresh")}"><i class="fas fa-rotate"></i></button>
        ${String(activeType === 'material' ? `<button type="button" class="mt-btn${state.pricebookOpen ? ' primary' : ''}" data-mt-open-pricebook ${!list ? 'disabled' : ''}><i class="fas fa-book"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_cf3630161575f6"," Price Book") ?? " Price Book")}</button>` : '')}
        <button type="button" class="mt-btn" data-mt-add-custom ${String(!list ? 'disabled' : '')}><i class="fas fa-plus"></i> ${String(escapeHtml(activeTerms.singular))}</button>
        ${String(canSchedule ? `<button type="button" class="mt-btn" data-mt-schedule-list="${escapeHtml(list?.id || '')}" ${state.saving || state.schedulingListId ? 'disabled' : ''}><i class="fas ${state.schedulingListId === cleanText(list?.id) ? 'fa-rotate mt-spin' : 'fa-calendar-day'}"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_80ce49ac8b6049"," Schedule") ?? " Schedule")}</button>` : '')}
        ${String(activeType === 'material' ? `<button type="button" class="mt-btn ${ordered ? 'success' : 'primary'}" data-mt-order ${!listItems().length || state.saving ? 'disabled' : ''}><i class="fas ${ordered ? 'fa-circle-check' : 'fa-cart-shopping'}"></i> ${ordered ? 'Ordered' : 'Order'}</button>` : '')}
      </div>
    </div>`;
  }

  function syncTopBar(){
    const root = materialRoot();
    const existing = root?.querySelector?.('.mt-top');
    if (!existing) return false;
    const holder = document.createElement('div');
    holder.innerHTML = topBarHtml();
    const next = holder.firstElementChild;
    if (!next) return false;
    existing.replaceWith(next);
    bindMain(next);
    timingMark('syncTopBar');
    return true;
  }

  function setWorkspaceSaving(saving){
    const root = materialRoot();
    const selector = '[data-mt-add-section],[data-mt-item-variant],[data-mt-color-trigger],[data-mt-list-trigger],[data-mt-item-name],[data-mt-item-qty],[data-mt-item-unit],[data-mt-item-price],[data-mt-remove]';
    root?.querySelectorAll?.(selector)?.forEach((control) => { control.disabled = !!saving; });
    root?.classList?.toggle('is-saving', !!saving);
  }

  function syncLineRow(itemId, listId){
    const root = materialRoot();
    const existing = findByData(root, '[data-mt-item-row]', 'mtItemRow', itemId);
    const item = renderedLineItem(itemId, listId);
    if (!existing || !item) return false;
    const holder = document.createElement('tbody');
    holder.innerHTML = renderLineRow(item);
    const next = holder.firstElementChild;
    if (!next) return false;
    existing.replaceWith(next);
    bindLineControls(next);
    timingMark('syncLineRow', { itemId, listId });
    return true;
  }

  function syncMaterialSection(sectionKey){
    const root = materialRoot();
    const existing = findByData(root, '[data-mt-section-key]', 'mtSectionKey', sectionKey);
    const section = materialSectionDefinitions().find((entry) => entry.key === sectionKey);
    const items = sectionItems(sectionKey);
    if (!existing || !section || !items.length) return syncMaterialsGrid();
    const holder = document.createElement('div');
    holder.innerHTML = renderMaterialSection(section, items);
    const next = holder.firstElementChild;
    if (!next) return false;
    existing.replaceWith(next);
    bindSectionContent(next);
    syncFooterTotals();
    scheduleArrange(root);
    timingMark('syncMaterialSection', { sectionKey });
    return true;
  }

  function syncMaterialsGrid(){
    const root = materialRoot();
    const grid = root?.querySelector?.('[data-mt-material-grid]');
    if (!grid) return false;
    grid.innerHTML = renderMaterialSections();
    bindSectionContent(grid);
    syncFooterTotals();
    scheduleArrange(root);
    timingMark('syncMaterialsGrid');
    return true;
  }

  function syncPricebookPanel(){
    const root = materialRoot();
    const existing = root?.querySelector?.('[data-mt-pricebook-panel]');
    if (!state.pricebookOpen || resourceType(state.activeList) !== 'material') {
      existing?.remove?.();
      return true;
    }
    const holder = document.createElement('div');
    const searchWasActive = document.activeElement?.matches?.('[data-mt-pricebook-search]');
    const selectionStart = searchWasActive ? document.activeElement.selectionStart : null;
    const selectionEnd = searchWasActive ? document.activeElement.selectionEnd : null;
    holder.innerHTML = renderPricebookPanel();
    const next = holder.firstElementChild;
    if (!next) return false;
    if (existing) existing.replaceWith(next);
    else root.querySelector('.mt-main')?.appendChild(next);
    bindMain(next);
    if (searchWasActive) {
      const search = next.querySelector('[data-mt-pricebook-search]');
      search?.focus?.();
      if (search?.setSelectionRange) search.setSelectionRange(selectionStart, selectionEnd);
    }
    return true;
  }

  function syncOrderDialog(open = false){
    const root = materialRoot();
    const existing = root?.querySelector?.('[data-mt-order-dialog]');
    if (resourceType(state.activeList) !== 'material') {
      existing?.remove?.();
      return false;
    }
    const shouldOpen = open || !!existing?.open;
    if (!state.orderDraftFresh) captureOrderDraft(existing);
    state.orderDraftFresh = false;
    const holder = document.createElement('div');
    holder.innerHTML = renderOrderDialog();
    const next = holder.firstElementChild;
    if (!next) return false;
    if (existing) existing.replaceWith(next);
    else root.appendChild(next);
    bindMain(next);
    if (shouldOpen) next.showModal?.();
    if (state.orderCalendarOpen && state.orderTimingChoice === 'scheduled') renderOrderDeliveryCalendar(next);
    return true;
  }

  function syncScopeListCard(listId){
    const list = materialListById(listId);
    const existing = findByData(state.leftRoot, '[data-mt-list-wrap]', 'mtListWrap', listId);
    if (!list || !existing) return false;
    const holder = document.createElement('div');
    holder.innerHTML = renderScopeListCard(list, state.lists.indexOf(list));
    const next = holder.firstElementChild;
    if (!next) return false;
    existing.replaceWith(next);
    bindLeft(next);
    return true;
  }

  function closeListMenu(){
    state.listMenu = null;
    document.querySelectorAll?.('[data-mt-list-portal]')?.forEach((node) => node.remove());
    const root = state.panelRoot?.querySelector?.('[data-materials-root]') || state.panelRoot;
    root?.querySelectorAll?.('[data-mt-list-trigger][aria-expanded="true"]')?.forEach((button) => button.setAttribute('aria-expanded', 'false'));
  }

  function toggleListMenu(itemId, sourceListId, trigger){
    if (state.listMenu?.itemId === itemId && state.listMenu?.sourceListId === sourceListId) {
      closeListMenu();
      return;
    }
    closeListMenu();
    closeColorMenu();
    const source = materialListById(sourceListId);
    if (!source || !trigger?.getBoundingClientRect) return;
    const choices = state.lists.filter((list) => resourceType(list) === resourceType(source));
    if (!choices.length) return;
    const rect = trigger.getBoundingClientRect();
    const width = 220;
    const height = Math.min(260, (choices.length * 43) + 12);
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left - 8));
    const top = rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 7 : Math.max(8, rect.top - height - 7);
    state.listMenu = { itemId, sourceListId, left, top };
    const portal = document.createElement('div');
    portal.className = 'mt-list-portal';
    portal.dataset.mtListPortal = '';
    portal.style.left = `${left}px`;
    portal.style.top = `${top}px`;
    portal.innerHTML = choices.map((list, index) => {
      const id = cleanText(list.id);
      const current = id === cleanText(sourceListId);
      const color = materialListColor(list, state.lists.indexOf(list) >= 0 ? state.lists.indexOf(list) : index);
      return `<button type="button" class="mt-list-option${current ? ' active' : ''}" style="--option-color:${escapeHtml(color)}" data-mt-move-list="${escapeHtml(id)}"><span class="mt-list-option-dot"></span><span>${escapeHtml(list.title || resourceTerms(resourceType(list), list).list)}</span>${current ? '<i class="fas fa-check"></i>' : ''}</button>`;
    }).join('');
    colorPortalHost(state.panelRoot).appendChild(portal);
    trigger.setAttribute('aria-expanded', 'true');
    portal.querySelectorAll('[data-mt-move-list]').forEach((button) => {
      button.addEventListener('click', () => {
        const targetListId = button.dataset.mtMoveList;
        if (targetListId === sourceListId) closeListMenu();
        else moveItemToList(itemId, sourceListId, targetListId);
      });
    });
  }

  function colorMenuPosition(trigger, width, height){
    const rect = trigger.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const left = Math.max(8, Math.min(maxLeft, rect.left));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    return { left: Math.round(left), top: Math.round(top) };
  }

  function positionColorPortal(root = state.panelRoot){
    const menu = state.colorMenu;
    if (!menu?.itemId || !root) return;
    const portal = document.querySelector?.('[data-mt-color-portal]');
    const trigger = Array.from(root.querySelectorAll?.('[data-mt-color-trigger]') || [])
      .find((button) => button.dataset.mtColorTrigger === menu.itemId && button.dataset.mtListId === menu.listId);
    if (!portal || !trigger) return;
    const portalRect = portal.getBoundingClientRect();
    const position = colorMenuPosition(trigger, portalRect.width || 250, portalRect.height || 48);
    portal.style.left = `${position.left}px`;
    portal.style.top = `${position.top}px`;
    state.colorMenu = { ...menu, ...position };
  }

  function renderPricebookPanel(){
    const suggestions = suggestedItems();
    return `
      <div class="mt-pricebook-panel" data-mt-pricebook-panel>
        <div class="mt-pricebook-head">
          <strong><i class="fas fa-book"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_cf3630161575f6"," Price Book") ?? " Price Book")}</strong>
          <div class="mt-actions">
            <button type="button" class="mt-icon-btn" data-mt-expand-pricebook title="${(globalThis.PlatformLanguage?.htmlText("materials","m_df1458500a02a8","Open full price book") ?? "Open full price book")}"><i class="fas fa-up-right-and-down-left-from-center"></i></button>
            <button type="button" class="mt-icon-btn" data-mt-close-pricebook title="${(globalThis.PlatformLanguage?.htmlText("materials","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button>
          </div>
        </div>
        <div class="mt-pricebook-body">
          <input class="mt-search" data-mt-pricebook-search value="${String(escapeHtml(state.pricebookSearch))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("materials","m_d87f548c7ada6e","Search price book") ?? "Search price book")}">
          <div class="mt-suggest-list">
            ${String(suggestions.map((item) => `
              <div class="mt-suggest">
                <div><strong>${escapeHtml(item.name)}</strong><span>${((v1,v2,v3) => globalThis.PlatformLanguage?.htmlText("materials","m_7d0042dbf4f2fd",`${v1} / ${v2} per ${v3}`,{v1,v2,v3}) ?? `${v1} / ${v2} per ${v3}`)(escapeHtml(item.category || ''),money(item.unitPrice || 0),escapeHtml(item.unit || 'ea'))}</span></div>
                <button type="button" class="mt-icon-btn" data-mt-add-pricebook="${escapeHtml(item.id)}" title="${(globalThis.PlatformLanguage?.htmlText("materials","m_c807a71e1c06f5","Add") ?? "Add")}"><i class="fas fa-plus"></i></button>
              </div>
            `).join('') || `<div class="mt-empty">${(globalThis.PlatformLanguage?.htmlText("materials","m_d8588ab21f5ab1","No price book items") ?? "No price book items")}</div>`)}
            </div>
        </div>
      </div>
    `;
  }

  function scheduleLabel(window = {}){
    const startDate = cleanText(window.start_date || window.date);
    const endDate = cleanText(window.end_date);
    const startTime = cleanText(window.start_time || window.time);
    const endTime = cleanText(window.end_time);
    return [startDate, endDate && endDate !== startDate ? endDate : '', startTime, endTime ? `-${endTime}` : ''].filter(Boolean).join(' ');
  }

  function renderOrders(){
    return `
      <div class="mt-card" style="margin-top:12px">
        <h3><i class="fas fa-truck"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_226e67393d8997"," Orders") ?? " Orders")}</h3>
        <div class="mt-orders">
          ${String(state.orders.map((order) => {
            const deliveries = state.deliveriesByOrderId[order.id] || [];
            const delivered = deliveries.some((delivery) => delivery.status === 'delivered') || order.delivery_status === 'delivered';
            return `
              <div class="mt-order">
                <div><strong>${escapeHtml(order.title || (globalThis.PlatformLanguage?.text("materials","m_d7bad661a9f673","Material order") ?? "Material order"))}</strong><span>${escapeHtml(scheduleLabel(order.scheduled_window) || order.ordered_at || '')}</span><em class="mt-status ${statusClass(order.delivery_status)}">${escapeHtml(order.delivery_status || 'scheduled')}</em></div>
                <button type="button" class="mt-icon-btn" data-mt-deliver="${escapeHtml(order.id)}" ${delivered ? 'disabled' : ''} title="${(globalThis.PlatformLanguage?.htmlText("materials","m_c40b3b565133d9","Record delivery") ?? "Record delivery")}"><i class="fas fa-check"></i></button>
              </div>
            `;
          }).join('') || `<div class="mt-empty">${(globalThis.PlatformLanguage?.htmlText("materials","m_67b21c25dc288b","No orders") ?? "No orders")}</div>`)}
        </div>
      </div>
    `;
  }

  function deliveryRequestLabel(event){
    const parts = eventDateParts(event);
    if (!parts.date) return 'Delivery date not scheduled';
    const date = new Date(parts.iso);
    const dateLabel = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const timeLabel = parts.time && parts.time !== '00:00' ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    return `${dateLabel}${timeLabel ? ` at ${timeLabel}` : ''}`;
  }

  function orderRequestRows(list = state.activeList){
    return listItems(list).map((item) => {
      const details = [];
      const used = new Set();
      const addDetail = (label, value) => {
        const display = cleanText(value);
        const key = `${cleanText(label).toLowerCase()}:${display.toLowerCase()}`;
        if (!display || used.has(key)) return;
        used.add(key);
        details.push({ label: cleanText(label) || 'Detail', value: display });
      };
      const variant = cleanText(item.product_selection?.variant_name || item.pricebook_snapshot?.variant?.name);
      if (variant && variant !== materialPrimaryName(item) && variant !== cleanText(item.name)) addDetail('Variant', variant);
      const group = cleanText(item.product_selection?.variant_group_name || item.pricebook_snapshot?.variant?.group_name);
      if (group && group !== variant) addDetail('Product line', group);
      const manufacturer = cleanText(item.manufacturer || item.pricebook_snapshot?.item?.manufacturer);
      if (manufacturer && manufacturer.toLowerCase() !== 'generic') addDetail('Manufacturer', manufacturer);
      const selectedOptions = selectedOptionsFor(item);
      const definitions = optionDefinitionsForItem(item);
      const optionIds = [...new Set([...definitions.map((definition) => cleanText(definition.id)), ...Object.keys(selectedOptions)].filter(Boolean))];
      optionIds.forEach((optionId) => {
        const definition = optionDefinition(item, optionId);
        const hasSelection = Object.prototype.hasOwnProperty.call(selectedOptions, optionId) && cleanText(selectedOptions[optionId]);
        const rawValue = hasSelection ? selectedOptions[optionId] : (definition?.defaultValue ?? optionValues(definition)[0]?.value ?? '');
        const rawValues = Array.isArray(rawValue) ? rawValue : [rawValue];
        const displayValues = rawValues.map((entry) => {
          const raw = entry && typeof entry === 'object' ? cleanText(entry.label || entry.name || entry.value) : cleanText(entry);
          const match = optionValues(definition).find((value) => cleanText(value?.value) === raw);
          return cleanText(match?.label || match?.name || raw).replaceAll('_', ' ');
        }).filter(Boolean);
        addDetail(cleanText(definition?.label || definition?.name) || titleFromKey(optionId), displayValues.join(', '));
      });
      addDetail('SKU', item.code);
      addDetail('Notes', item.notes);
      const measuredQuantity = integerQuantity(item.quantity, 0);
      const measuredUnit = cleanText(item.unit || 'ea');
      const orderInfo = orderInfoForLine(item, measuredQuantity);
      if (orderInfo) {
        if (orderInfo.packaging?.description) addDetail('Package', orderInfo.packaging.description);
        addDetail('Covers', `${orderInfo.covered_quantity} ${measuredUnit} (measured ${measuredQuantity} ${measuredUnit})`);
      }
      return {
        name: materialPrimaryName(item),
        details,
        detail: details.map((entry) => `${entry.label}: ${entry.value}`).join('; '),
        quantity: orderInfo ? orderInfo.order_quantity : integerQuantity(item.order_quantity ?? item.quantity, 0),
        unit: orderInfo ? orderInfo.order_unit : cleanText(item.order_unit || item.unit || 'ea')
      };
    });
  }

  function orderRequestDetailsHtml(row){
    return row.details.map((entry) => `<span class="mt-order-detail"><strong>${escapeHtml(entry.label)}:</strong> ${escapeHtml(entry.value)}</span>`).join('') || `<span class="mt-small">${(globalThis.PlatformLanguage?.htmlText("materials","m_caa672dddbf42e","&mdash;") ?? "&mdash;")}</span>`;
  }

  function scheduleDraftLabel(draft = {}){
    const start = dateFromOrderSchedule(draft);
    if (!start) return 'Delivery date not scheduled';
    const dateLabel = start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const timeLabel = cleanText(draft.time) ? start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    return `${dateLabel}${timeLabel ? ` at ${timeLabel}` : ' · all day'}`;
  }

  function orderDeliveryLabel(list){
    const draft = scheduleDraftForList(list);
    if (cleanText(draft.date)) return scheduleDraftLabel(draft);
    if (state.orderTimingChoice === 'without_dates') return 'No date included in this order';
    if (state.orderTimingChoice === 'scheduled') return scheduleDraftLabel(draft);
    return deliveryRequestLabel(linkedScheduleEvent(list));
  }

  function orderRequestSubject(lists = selectedOrderLists()){
    const address = cleanText(state.project?.address || state.project?.title || projectId());
    const dates = state.orderTimingChoice === 'scheduled'
      ? [...new Set(lists.map((list) => cleanText(scheduleDraftForList(list).date)).filter(Boolean))]
      : [];
    return `Material delivery request - ${address}${dates.length === 1 ? ` - ${dates[0]}` : ''}`;
  }

  function orderDeliveryInstruction(list){
    const title = cleanText(list?.title || (globalThis.PlatformLanguage?.text("materials","m_7b257a79bb0ec3","materials") ?? "materials"));
    if (state.orderTimingChoice === 'without_dates') {
      return `I need the ${title} materials included in this order. The delivery date and time are not included in this request, so please contact me to arrange or confirm them.`;
    }
    const draft = scheduleDraftForList(list);
    const start = dateFromOrderSchedule(draft);
    if (!start) return `I need the ${title} delivery, but its date and time still need to be scheduled.`;
    const dateLabel = start.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    if (cleanText(draft.time)) {
      const timeLabel = start.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
      return `I need the ${title} delivery on ${dateLabel} at ${timeLabel}.`;
    }
    return `I need the ${title} delivery on ${dateLabel}. The delivery time is flexible, but please confirm it with me.`;
  }

  function orderRequestText(lists = selectedOrderLists()){
    const address = cleanText(state.project?.address || state.project?.title || (globalThis.PlatformLanguage?.text("materials","m_e79a19a31a91af","the project site") ?? "the project site"));
    const instructions = lists.map((list) => `- ${orderDeliveryInstruction(list)}`).join('\n');
    const sections = lists.map((list) => {
      const table = orderRequestRows(list).map((row) => `${row.name}\t${row.detail || '—'}\t${row.quantity}\t${row.unit}`).join('\n');
      return `${cleanText(list.title || (globalThis.PlatformLanguage?.text("materials","m_691187e28aba8e","Materials") ?? "Materials"))}\n${orderDeliveryInstruction(list)}\n\nMaterial\tDetails\tQuantity\tUnit\n${table}`;
    }).join('\n\n');
    return `${orderRequestSubject(lists)}\n\nHello,\n\nPlease place the following material order for delivery to ${address}.\n\nDelivery instructions:\n${instructions}\n\n${sections}\n\nPlease confirm product availability, quantities, variant and color details, and each requested delivery appointment before processing the order.\n\nThank you.`;
  }

  function orderRequestHtml(lists = selectedOrderLists()){
    const address = cleanText(state.project?.address || state.project?.title || (globalThis.PlatformLanguage?.text("materials","m_e79a19a31a91af","the project site") ?? "the project site"));
    const instructions = `<ul>${lists.map((list) => `<li>${escapeHtml(orderDeliveryInstruction(list))}</li>`).join('')}</ul>`;
    const cell = 'border:1px solid #999;padding:6px;text-align:left';
    const sections = lists.map((list) => `<p><strong>${String(escapeHtml(list.title || (globalThis.PlatformLanguage?.text("materials","m_691187e28aba8e","Materials") ?? "Materials")))}</strong><br><em>${String(escapeHtml(orderDeliveryInstruction(list)))}</em></p><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%"><thead><tr><th style="${String(cell)}">${(globalThis.PlatformLanguage?.htmlText("materials","m_613d6b4084975e","Material") ?? "Material")}</th><th style="${String(cell)}">${(globalThis.PlatformLanguage?.htmlText("materials","m_b3ecc234f63212","Details") ?? "Details")}</th><th style="${String(cell)}">${(globalThis.PlatformLanguage?.htmlText("materials","m_9c689ddee2f502","Quantity") ?? "Quantity")}</th><th style="${String(cell)}">${(globalThis.PlatformLanguage?.htmlText("materials","m_4b91b73dae1ff3","Unit") ?? "Unit")}</th></tr></thead><tbody>${String(orderRequestRows(list).map((row) => `<tr><td style="${cell}">${escapeHtml(row.name)}</td><td style="${cell}">${row.details.map((entry) => `<strong>${escapeHtml(entry.label)}:</strong> ${escapeHtml(entry.value)}`).join('<br>') || '&mdash;'}</td><td style="${cell}">${escapeHtml(row.quantity)}</td><td style="${cell}">${escapeHtml(row.unit)}</td></tr>`).join(''))}</tbody></table>`).join('<br>');
    return `<p><strong>${String(escapeHtml(orderRequestSubject(lists)))}</strong></p><p>${(globalThis.PlatformLanguage?.htmlText("materials","m_2634bd92bed7f7","Hello,") ?? "Hello,")}</p><p>${(globalThis.PlatformLanguage?.htmlText("materials","m_2dc5eebd0941a4","Please place the following material order for delivery to ") ?? "Please place the following material order for delivery to ")}<strong>${String(escapeHtml(address))}</strong>.</p><p><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_0e22a1d03e954f","Delivery instructions") ?? "Delivery instructions")}</strong></p>${String(instructions)}${String(sections)}<p>${(globalThis.PlatformLanguage?.htmlText("materials","m_09326393374cc9","Please confirm product availability, quantities, variant and color details, and each requested delivery appointment before processing the order.") ?? "Please confirm product availability, quantities, variant and color details, and each requested delivery appointment before processing the order.")}</p><p>${(globalThis.PlatformLanguage?.htmlText("materials","m_e495d4a9827c67","Thank you.") ?? "Thank you.")}</p>`;
  }

  function orderRequestPreviewHtml(lists = selectedOrderLists()){
    const address = cleanText(state.project?.address || state.project?.title || (globalThis.PlatformLanguage?.text("materials","m_e79a19a31a91af","the project site") ?? "the project site"));
    const instructions = lists.map((list) => `<li>${escapeHtml(orderDeliveryInstruction(list))}</li>`).join('');
    const sections = lists.map((list) => `<section class="mt-request-group"><p><strong>${String(escapeHtml(list.title || (globalThis.PlatformLanguage?.text("materials","m_691187e28aba8e","Materials") ?? "Materials")))}</strong> <em>${((v1) => globalThis.PlatformLanguage?.htmlText("materials","m_da1df6b7a47ee1",`(${v1} items)`,{v1}) ?? `(${v1} items)`)(escapeHtml(orderRequestRows(list).length))}</em><br><em>${String(escapeHtml(orderDeliveryInstruction(list)))}</em></p><table class="mt-order-table"><thead><tr><th>${(globalThis.PlatformLanguage?.htmlText("materials","m_613d6b4084975e","Material") ?? "Material")}</th><th>${(globalThis.PlatformLanguage?.htmlText("materials","m_b3ecc234f63212","Details") ?? "Details")}</th><th>${(globalThis.PlatformLanguage?.htmlText("materials","m_1a29aea570fbc4","Qty") ?? "Qty")}</th><th>${(globalThis.PlatformLanguage?.htmlText("materials","m_4b91b73dae1ff3","Unit") ?? "Unit")}</th></tr></thead><tbody>${String(orderRequestRows(list).map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${orderRequestDetailsHtml(row)}</td><td>${escapeHtml(row.quantity)}</td><td>${escapeHtml(row.unit)}</td></tr>`).join(''))}</tbody></table></section>`).join('');
    return `<p>${(globalThis.PlatformLanguage?.htmlText("materials","m_2634bd92bed7f7","Hello,") ?? "Hello,")}</p><p>${(globalThis.PlatformLanguage?.htmlText("materials","m_2dc5eebd0941a4","Please place the following material order for delivery to ") ?? "Please place the following material order for delivery to ")}<strong>${String(escapeHtml(address))}</strong>.</p><p><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_0e22a1d03e954f","Delivery instructions") ?? "Delivery instructions")}</strong></p><ul class="mt-email-instruction-list">${String(instructions)}</ul>${String(sections)}<p>${(globalThis.PlatformLanguage?.htmlText("materials","m_09326393374cc9","Please confirm product availability, quantities, variant and color details, and each requested delivery appointment before processing the order.") ?? "Please confirm product availability, quantities, variant and color details, and each requested delivery appointment before processing the order.")}</p><p>${(globalThis.PlatformLanguage?.htmlText("materials","m_e495d4a9827c67","Thank you.") ?? "Thank you.")}</p>`;
  }

  async function copyOrderRequest(event){
    const button = event?.currentTarget || materialRoot()?.querySelector?.('[data-mt-copy-order]');
    if (button?._mtCopyTimer) clearTimeout(button._mtCopyTimer);
    if (button) {
      button.classList.remove('copied', 'failed');
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Copying&hellip;';
      button.setAttribute('aria-live', 'polite');
    }
    const textValue = orderRequestText();
    const htmlValue = orderRequestHtml();
    try {
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([textValue], { type: 'text/plain' }),
          'text/html': new Blob([htmlValue], { type: 'text/html' })
        })]);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(textValue);
      } else {
        throw new Error('Clipboard access is unavailable.');
      }
      if (button) {
        button.classList.add('copied');
        button.innerHTML = '<i class="fas fa-check"></i> Copied';
        button._mtCopyTimer = setTimeout(() => {
          if (!button.isConnected) return;
          button.classList.remove('copied');
          button.innerHTML = '<i class="fas fa-copy"></i> Copy email &amp; table';
        }, 2400);
      }
      showToast((globalThis.PlatformLanguage?.text("materials","m_49778fdd64192c","Order request copied") ?? "Order request copied"), (globalThis.PlatformLanguage?.text("materials","m_7d4ef849cd48ae","Paste it into an email to your supplier.") ?? "Paste it into an email to your supplier."), true);
    } catch (error) {
      if (button) {
        button.classList.add('failed');
        button.innerHTML = '<i class="fas fa-triangle-exclamation"></i> Copy failed';
        button._mtCopyTimer = setTimeout(() => {
          if (!button.isConnected) return;
          button.classList.remove('failed');
          button.innerHTML = '<i class="fas fa-copy"></i> Try copying again';
        }, 2400);
      }
      showToast((globalThis.PlatformLanguage?.text("materials","m_eabbefbfeba11a","Could not copy request") ?? "Could not copy request"), error?.message || 'Select and copy the table manually.', false);
    }
  }

  function renderOrderListPicker(allLists, selectedLists){
    const tiles = allLists.map((list, index) => {
      const id = cleanText(list.id);
      const selected = state.orderSelectedListIds.has(id);
      const ordered = materialListOrdered(list);
      return `<button type="button" class="mt-order-list-option ${selected ? 'selected' : ''}" data-mt-order-list-toggle="${escapeHtml(id)}" aria-pressed="${selected ? 'true' : 'false'}"><span class="mt-request-list-dot" style="--list-color:${escapeHtml(materialListColor(list, Math.max(index, state.lists.indexOf(list))))}"></span><span><strong>${escapeHtml(list.title || (globalThis.PlatformLanguage?.text("materials","m_fd0199dc45d261","Material list") ?? "Material list"))}</strong><small>${escapeHtml(orderDeliveryLabel(list))}</small></span><em class="${ordered ? 'ordered' : ''}">${ordered ? 'Ordered' : `${escapeHtml(listItems(list).length)} items`}</em></button>`;
    }).join('');
    return `<section class="mt-order-list-picker"><div class="mt-order-section-head"><div><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_d903a6133c49d2","Included in this order") ?? "Included in this order")}</span><strong>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("materials","m_a5a370c47df87a",`${v0} material list${v1}`,{v0,v1}) ?? `${v0} material list${v1}`)(escapeHtml(selectedLists.length),selectedLists.length === 1 ? '' : 's')}</strong></div><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_39d567f6484730","Click a tile to include or remove it") ?? "Click a tile to include or remove it")}</span></div><div class="mt-order-list-options" role="group" aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_3422a94241c9cd","Material lists to order") ?? "Material lists to order")}">${String(tiles)}</div></section>`;
  }

  function renderOrderScheduleTargets(selectedLists){
    if (!state.orderCalendarOpen || state.orderTimingChoice !== 'scheduled') return '';
    const focusId = cleanText(orderScheduleFocusList()?.id);
    return `<section class="mt-order-schedule-targets"><div class="mt-order-section-head"><div><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_27872ce794104c","Delivery being edited") ?? "Delivery being edited")}</span><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_f5839bfd412709","Select one calendar item") ?? "Select one calendar item")}</strong></div><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_d919b5541b3cfc","Does not change the order lists above") ?? "Does not change the order lists above")}</span></div><div class="mt-order-target-options" role="group" aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_27872ce794104c","Delivery being edited") ?? "Delivery being edited")}">${String(selectedLists.map((list, index) => {
      const id = cleanText(list.id);
      const focused = focusId === id;
      return `<button type="button" class="mt-order-target ${focused ? 'active' : ''}" data-mt-order-schedule-focus="${escapeHtml(id)}" aria-pressed="${focused ? 'true' : 'false'}"><span class="mt-request-list-dot" style="--list-color:${escapeHtml(materialListColor(list, Math.max(index, state.lists.indexOf(list))))}"></span><span><strong>${escapeHtml(list.title || (globalThis.PlatformLanguage?.text("materials","m_fd0199dc45d261","Material list") ?? "Material list"))}</strong><small>${escapeHtml(orderDeliveryLabel(list))}</small></span><em>${focused ? 'Editing' : 'Edit'}</em></button>`;
    }).join(''))}</div></section>`;
  }

  function renderOrderTimingControls(selectedLists){
    const scheduled = state.orderTimingChoice === 'scheduled';
    const withoutDates = state.orderTimingChoice === 'without_dates';
    const scheduledCount = selectedLists.filter((list) => cleanText(scheduleDraftForList(list).date)).length;
    const datesComplete = scheduledCount === selectedLists.length && !!selectedLists.length;
    const dateSummary = `<div class="mt-order-date-summary">${selectedLists.map((list) => `<div><strong>${escapeHtml(list.title || (globalThis.PlatformLanguage?.text("materials","m_691187e28aba8e","Materials") ?? "Materials"))}</strong><span>${escapeHtml(orderDeliveryLabel(list))}</span></div>`).join('')}</div>`;
    if (state.orderCalendarOpen && scheduled) {
      return `<section class="mt-order-delivery-choice scheduling"><div class="mt-order-section-head"><div><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_bfe13760089f83","Delivery timing") ?? "Delivery timing")}</span><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_be783654eba71d","Editing delivery dates") ?? "Editing delivery dates")}</strong></div><span class="mt-required-pill ${String(datesComplete ? 'ready' : '')}">${String(datesComplete ? 'Ready to confirm' : `${scheduledCount} of ${selectedLists.length}`)}</span></div>${String(dateSummary)}<button type="button" class="mt-order-text-action" data-mt-order-timing="without_dates"><i class="fas fa-calendar-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_34d8f8348422d8"," Order without dates instead") ?? " Order without dates instead")}</button></section>`;
    }
    if (scheduled && datesComplete && state.orderDatesConfirmed) {
      return `<section class="mt-order-delivery-choice confirmed"><div class="mt-order-section-head"><div><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_bfe13760089f83","Delivery timing") ?? "Delivery timing")}</span><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_c832049612431e","Using scheduled delivery dates") ?? "Using scheduled delivery dates")}</strong></div><span class="mt-required-pill ready"><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_a280e9fb3b2819"," Ready") ?? " Ready")}</span></div>${String(dateSummary)}<div class="mt-order-timing-actions"><button type="button" data-mt-order-open-calendar><i class="fas fa-pen-to-square"></i><span><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_76c8711c1d6f59","Edit delivery dates") ?? "Edit delivery dates")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("materials","m_4ecc9339296a69","Open the project calendar") ?? "Open the project calendar")}</small></span></button><button type="button" data-mt-order-timing="without_dates"><i class="fas fa-calendar-xmark"></i><span><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_dda45bd2654af7","Order without dates") ?? "Order without dates")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("materials","m_a4ce40461c05cf","Ignore the scheduled dates for this order") ?? "Ignore the scheduled dates for this order")}</small></span></button></div></section>`;
    }
    if (scheduled) {
      return `<section class="mt-order-delivery-choice"><div class="mt-order-section-head"><div><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_bfe13760089f83","Delivery timing") ?? "Delivery timing")}</span><strong>${String(datesComplete ? 'Confirm the delivery dates' : 'Some deliveries still need dates')}</strong></div><span class="mt-required-pill">${(globalThis.PlatformLanguage?.htmlText("materials","m_db97f048cd99aa","Required") ?? "Required")}</span></div>${String(dateSummary)}<div class="mt-order-timing-actions"><button type="button" data-mt-order-open-calendar><i class="fas fa-calendar-check"></i><span><strong>${String(datesComplete ? 'Review and confirm dates' : 'Schedule missing deliveries')}</strong><small>${(globalThis.PlatformLanguage?.htmlText("materials","m_4ecc9339296a69","Open the project calendar") ?? "Open the project calendar")}</small></span></button><button type="button" data-mt-order-timing="without_dates"><i class="fas fa-calendar-xmark"></i><span><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_dda45bd2654af7","Order without dates") ?? "Order without dates")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("materials","m_825ae356dc7e5d","Arrange timing with the supplier later") ?? "Arrange timing with the supplier later")}</small></span></button></div></section>`;
    }
    const scheduledDatesNote = scheduledCount
      ? `<div class="mt-order-no-date-note"><i class="fas fa-calendar-check"></i><span>${((v0) => globalThis.PlatformLanguage?.htmlText("materials","m_d85134d46b1895",`${v0} Their dates will simply be left out of this supplier email.`,{v0}) ?? `${v0} Their dates will simply be left out of this supplier email.`)(scheduledCount === selectedLists.length ? 'These deliveries remain scheduled on the project.' : `${scheduledCount} of ${selectedLists.length} deliveries remain scheduled on the project.`)}</span></div>`
      : `<div class="mt-order-no-date-note"><i class="fas fa-envelope-open-text"></i><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_c6a2b7b62977b1","The email will ask the supplier to contact you to arrange each delivery.") ?? "The email will ask the supplier to contact you to arrange each delivery.")}</span></div>`;
    const datedOptionLabel = datesComplete ? 'Use scheduled delivery dates' : scheduledCount ? 'Schedule missing deliveries' : 'Schedule deliveries';
    const datedOptionHint = datesComplete ? 'Include the existing dates in the supplier email' : 'Use the project calendar';
    return `<section class="mt-order-delivery-choice"><div class="mt-order-section-head"><div><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_bfe13760089f83","Delivery timing") ?? "Delivery timing")}</span><strong>${String(withoutDates ? 'Ordering without delivery dates' : 'Choose one option')}</strong></div><span class="mt-required-pill ${String(withoutDates ? 'ready' : '')}">${String(withoutDates ? 'Selected' : 'Required')}</span></div>${String(scheduledCount ? dateSummary : '')}<div class="mt-order-timing-choices"><button type="button" data-mt-order-timing="scheduled"><i class="fas fa-calendar-check"></i><span><strong>${String(datedOptionLabel)}</strong><small>${String(datedOptionHint)}</small></span></button><button type="button" class="${String(withoutDates ? 'active' : '')}" data-mt-order-timing="without_dates"><i class="fas fa-calendar-xmark"></i><span><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_dda45bd2654af7","Order without dates") ?? "Order without dates")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("materials","m_5189a46ae92108","Leave dates out of this supplier email") ?? "Leave dates out of this supplier email")}</small></span></button></div>${String(withoutDates ? scheduledDatesNote : '')}${String(withoutDates && scheduledCount ? `<button type="button" class="mt-order-text-action" data-mt-order-open-calendar><i class="fas fa-pen-to-square"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_61f2453696af37"," Edit scheduled deliveries") ?? " Edit scheduled deliveries")}</button>` : '')}</section>`;
  }

  function renderOrderDialog(){
    const allLists = materialOrderLists();
    const lists = selectedOrderLists();
    const primaryList = lists[0] || state.activeList;
    const rows = lists.flatMap((list) => orderRequestRows(list));
    const pendingLists = lists.filter((list) => !materialListOrdered(list));
    const orderSources = orderSourcesForList(primaryList);
    const provider = orderSources.some((source) => source.id === state.orderProvider) ? state.orderProvider : defaultOrderSourceId(primaryList);
    const activeSource = orderSources.find((source) => source.id === provider) || orderSources[0];
    const manualProvider = activeSource?.kind === 'manual' && activeSource?.status === 'active';
    const scheduleComplete = orderScheduleComplete();
    const deliverySummary = state.orderTimingChoice === 'without_dates'
      ? 'Order without dates'
      : state.orderTimingChoice === 'scheduled'
        ? (scheduleComplete ? `${lists.length} scheduled deliver${lists.length === 1 ? 'y' : 'ies'}` : 'Delivery dates need confirmation')
        : 'Delivery timing required';
    const listPicker = renderOrderListPicker(allLists, lists);
    const timingControls = renderOrderTimingControls(lists);
    const scheduleTargets = renderOrderScheduleTargets(lists);
    const detailsPanel = `<div class="mt-order-details">${String(listPicker)}${String(timingControls)}${String(scheduleTargets)}<div class="mt-order-summary"><div><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_aaebd7ccba0b30","Project") ?? "Project")}</span><strong>${String(escapeHtml(state.project?.address || state.project?.title || ''))}</strong></div></div><div class="mt-form-grid"><label class="wide"><span class="mt-small">${(globalThis.PlatformLanguage?.htmlText("materials","m_5a81714733da92","Order title") ?? "Order title")}</span><input class="mt-input" name="title" value="${String(escapeHtml(state.orderDraft.title || (lists.length === 1 ? lists[0]?.title : 'Combined material order') || 'Material order'))}"></label><label><span class="mt-small">${(globalThis.PlatformLanguage?.htmlText("materials","m_ee089efa867b5d","Supplier") ?? "Supplier")}</span><input class="mt-input" name="vendor" value="${String(escapeHtml(state.orderDraft.vendor))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("materials","m_ea1009fc19cb4c","Supplier name") ?? "Supplier name")}"></label><label><span class="mt-small">${(globalThis.PlatformLanguage?.htmlText("materials","m_0850099cb964d6","Supplier email") ?? "Supplier email")}</span><input class="mt-input" type="email" name="vendor_email" value="${String(escapeHtml(state.orderDraft.vendor_email))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("materials","m_6718ec5ad32aa0","orders@supplier.com") ?? "orders@supplier.com")}"></label><label><span class="mt-small">${(globalThis.PlatformLanguage?.htmlText("materials","m_a0ff1e9d49d84c","Quoted total") ?? "Quoted total")}</span><input class="mt-input" type="number" min="0" step="0.01" name="quoted_price" value="${String(escapeHtml(state.orderDraft.quoted_price))}"></label><label><span class="mt-small">${(globalThis.PlatformLanguage?.htmlText("materials","m_d1c2c0c41314fa","Paid total") ?? "Paid total")}</span><input class="mt-input" type="number" min="0" step="0.01" name="paid_price" value="${String(escapeHtml(state.orderDraft.paid_price))}"></label></div><div class="mt-order-lock-note ${String(pendingLists.length ? '' : 'ordered')}"><i class="fas ${String(pendingLists.length ? 'fa-circle-info' : 'fa-lock')}"></i><span>${String(pendingLists.length ? 'Copying this request does not place the order. Selected lists are recorded separately while sharing this supplier email.' : 'Every selected list has already been marked as ordered. You can still copy the combined request.')}</span></div></div>`;
    const emailPanel = `<div class="mt-email-preview"><div class="mt-email-preview-head"><strong><i class="fas fa-envelope"></i> ${String(escapeHtml(orderRequestSubject(lists)))}</strong><button type="button" class="mt-email-copy" data-mt-copy-order><i class="fas fa-copy"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_f1733e455032ff"," Copy email & table") ?? " Copy email & table")}</button></div><div class="mt-email-body">${String(orderRequestPreviewHtml(lists))}</div></div>`;
    const focusList = orderScheduleFocusList();
    const datesReady = orderScheduleDatesComplete();
    const calendarPanel = `<section class="mt-order-calendar-panel"><div class="mt-order-calendar-head"><div><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_c0683b1d95229a","Project calendar") ?? "Project calendar")}</span><strong>${((v0) => globalThis.PlatformLanguage?.htmlText("materials","m_20094abf6017fb",`${v0} delivery`,{v0}) ?? `${v0} delivery`)(escapeHtml(focusList?.title || 'Material'))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("materials","m_2cb817ed73e87b","Existing project events are shown for context. Click or drag on the calendar to place this delivery.") ?? "Existing project events are shown for context. Click or drag on the calendar to place this delivery.")}</small></div><div class="mt-order-calendar-actions"><button type="button" data-mt-order-review-email><i class="fas fa-envelope"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_3b770970fb24ef"," Review email") ?? " Review email")}</button><button type="button" class="primary" data-mt-order-confirm-dates ${String(datesReady ? '' : 'disabled')}><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_81a9a36dc1c9ba"," Confirm dates") ?? " Confirm dates")}</button></div></div><div class="mt-order-calendar" data-mt-order-calendar></div></section>`;
    const detailsContent = `<div class="mt-order-content manual ${state.orderCalendarOpen && state.orderTimingChoice === 'scheduled' ? 'calendar-mode' : ''}">${detailsPanel}${state.orderCalendarOpen && state.orderTimingChoice === 'scheduled' ? calendarPanel : emailPanel}</div>`;
    const unavailableContent = (source) => `<div class="mt-order-content"><div class="mt-order-coming"><div><i class="fas ${escapeHtml(orderSourceIcon(source))}"></i><strong>${escapeHtml(source?.name || 'Supplier integration')}</strong><span>${source?.status === 'disabled' ? 'This order source is not available for the selected lists.' : 'Direct supplier ordering is coming soon. Use Manual Order today.'}</span></div></div></div>`;
    const canSubmit = manualProvider && pendingLists.length && rows.length && scheduleComplete;
    const submitLabel = !pendingLists.length ? 'Already ordered' : state.orderTimingChoice === 'scheduled' && !scheduleComplete ? 'Confirm delivery dates' : !scheduleComplete ? 'Choose delivery timing' : `Place ${pendingLists.length} order${pendingLists.length === 1 ? '' : 's'}`;
    const calendarFooter = `<button type="button" class="mt-btn" data-mt-order-review-email><i class="fas fa-envelope"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_3b770970fb24ef"," Review email") ?? " Review email")}</button><button type="button" class="mt-btn ${String(datesReady ? 'primary' : '')}" data-mt-order-confirm-dates ${String(datesReady ? '' : 'disabled')}><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_81a9a36dc1c9ba"," Confirm dates") ?? " Confirm dates")}</button>`;
    const orderFooter = `${state.orderTimingChoice === 'scheduled' ? `<button type="button" class="mt-btn" data-mt-order-open-calendar><i class="fas fa-pen-to-square"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_164172c27ea2a4"," Edit delivery dates") ?? " Edit delivery dates")}</button>` : ''}<button type="submit" class="mt-btn ${canSubmit ? 'primary' : ''}" ${canSubmit ? '' : 'disabled'}><i class="fas ${canSubmit ? 'fa-check' : 'fa-circle-exclamation'}"></i> ${escapeHtml(submitLabel)}</button>`;
    return `<dialog class="mt-modal" data-mt-order-dialog><div class="mt-modal-backdrop-hit" data-mt-close-order-backdrop aria-hidden="true"></div><form method="dialog" data-mt-order-form class="mt-modal-shell mt-order-modal"><div class="mt-modal-head"><div class="mt-modal-title"><i class="fas fa-cart-shopping"></i><div><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_36be482213df36","Order materials") ?? "Order materials")}</strong><span>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("materials","m_39b15ac7849e51",`${v0} list${v1} selected · build one supplier-ready request`,{v0,v1}) ?? `${v0} list${v1} selected · build one supplier-ready request`)(escapeHtml(lists.length),lists.length === 1 ? '' : 's')}</span></div></div><button type="button" class="mt-modal-close" data-mt-close-order aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div><div class="mt-order-layout"><nav class="mt-order-providers" aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_831dd5e3d9d0b5","Order method") ?? "Order method")}" role="tablist">${String(orderSources.map((source) => `<button type="button" role="tab" aria-selected="${provider === source.id ? 'true' : 'false'}" class="mt-provider ${provider === source.id ? 'active' : ''}" data-mt-order-provider="${escapeHtml(source.id)}"><i class="fas ${escapeHtml(orderSourceIcon(source))}"></i><span><strong>${escapeHtml(source.name)}</strong><span>${source.kind === 'manual' && source.status === 'active' ? 'Email or call supplier' : source.status === 'disabled' ? 'Unavailable' : 'Coming Soon'}</span></span></button>`).join(''))}</nav>${String(manualProvider ? detailsContent : unavailableContent(activeSource))}</div><div class="mt-modal-foot"><span class="mt-small">${((v4,v5,v6,v7,v8) => globalThis.PlatformLanguage?.htmlText("materials","m_2004834d3931db",`${v4} line item${v5} across ${v6} list${v7} · ${v8}`,{v4,v5,v6,v7,v8}) ?? `${v4} line item${v5} across ${v6} list${v7} · ${v8}`)(escapeHtml(rows.length),rows.length === 1 ? '' : 's',escapeHtml(lists.length),lists.length === 1 ? '' : 's',escapeHtml(deliverySummary))}</span><div class="mt-actions">${String(state.orderCalendarOpen ? calendarFooter : orderFooter)}</div></div></form></dialog>`;
  }

  function renderNewListDialog(){
    const color = firstUnusedListColor();
    return `
      <dialog class="mt-modal" data-mt-new-list-dialog>
        <form method="dialog" data-mt-new-list-form class="mt-modal-shell mt-new-list-modal">
          <div class="mt-modal-head"><div class="mt-modal-title"><i class="fas fa-layer-group"></i><div><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_c08e5572d68b86","New scope list") ?? "New scope list")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_e17a3d60158caf","Create a project-specific resource grouping") ?? "Create a project-specific resource grouping")}</span></div></div><button type="button" class="mt-modal-close" data-mt-close-new-list aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>
          <div class="mt-new-list-body">
            <label><span class="mt-small">${(globalThis.PlatformLanguage?.htmlText("materials","m_cc9396f2523c62","Resource type") ?? "Resource type")}</span><select class="mt-input" name="resource_type"><option value="material">${(globalThis.PlatformLanguage?.htmlText("materials","m_691187e28aba8e","Materials") ?? "Materials")}</option><option value="labor">${(globalThis.PlatformLanguage?.htmlText("materials","m_7acfa5ed3b7739","Labor") ?? "Labor")}</option><option value="equipment">${(globalThis.PlatformLanguage?.htmlText("materials","m_2813f320a63b94","Equipment") ?? "Equipment")}</option></select></label>
            <label><span class="mt-small">${(globalThis.PlatformLanguage?.htmlText("materials","m_48a52dec920f8b","List name") ?? "List name")}</span><input class="mt-input" name="title" required maxlength="120" placeholder="${(globalThis.PlatformLanguage?.htmlText("materials","m_da697bd7def41b","Example: Flashing delivery") ?? "Example: Flashing delivery")}"></label>
            <label><span class="mt-small">${(globalThis.PlatformLanguage?.htmlText("materials","m_c7b224210d489f","List color") ?? "List color")}</span><span class="mt-color-field"><input type="color" name="color" value="${String(escapeHtml(color))}"><input class="mt-input" value="${String(escapeHtml(color))}" data-mt-new-list-color-text aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_1aea29df534ede","List color value") ?? "List color value")}"></span></label>
            <p class="mt-small">${(globalThis.PlatformLanguage?.htmlText("materials","m_f96a5913aa2f19","This color identifies the list throughout Scope and Scheduling. Scheduling is optional for equipment.") ?? "This color identifies the list throughout Scope and Scheduling. Scheduling is optional for equipment.")}</p>
          </div>
          <div class="mt-modal-foot"><span class="mt-small">${(globalThis.PlatformLanguage?.htmlText("materials","m_23c8f416472bf8","Scope defaults can create these automatically.") ?? "Scope defaults can create these automatically.")}</span><div class="mt-actions"><button type="button" class="mt-btn" data-mt-close-new-list>${(globalThis.PlatformLanguage?.htmlText("materials","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="submit" class="mt-btn">${(globalThis.PlatformLanguage?.htmlText("materials","m_38d4da1be10d46","Create List") ?? "Create List")}</button><button type="submit" class="mt-btn primary" data-mt-new-list-schedule><i class="fas fa-calendar-plus"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_ef51e1150bf5be"," Create & Schedule") ?? " Create & Schedule")}</button></div></div>
        </form>
      </dialog>
    `;
  }

  function bindLineControls(root){
    root.querySelectorAll('[data-mt-remove]').forEach((button) => {
      button.addEventListener('click', () => removeItem(button.dataset.mtRemove, button.dataset.mtListId));
    });
    root.querySelectorAll('[data-mt-item-variant]').forEach((select) => {
      select.addEventListener('change', () => updateItemVariant(select.dataset.mtItemVariant, select.value, select.dataset.mtListId));
    });
    root.querySelectorAll('[data-mt-item-pay-type]').forEach((select) => {
      select.addEventListener('change', () => {
        const list = materialListById(select.dataset.mtListId);
        const item = listItems(list).find((entry) => cleanText(entry.id) === cleanText(select.dataset.mtItemPayType));
        updateItem(select.dataset.mtItemPayType, {
          metadata: { ...(item?.metadata || {}), compensation_kind: select.value }
        }, select.dataset.mtListId);
      });
    });
    root.querySelectorAll('[data-mt-color-trigger]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleColorMenu(button.dataset.mtColorTrigger, button, button.dataset.mtListId);
      });
    });
    root.querySelectorAll('[data-mt-list-trigger]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleListMenu(button.dataset.mtListTrigger, button.dataset.mtListId, button);
      });
    });
    root.querySelectorAll('[data-mt-item-name],[data-mt-item-qty],[data-mt-item-unit],[data-mt-item-price]').forEach((input) => {
      input.addEventListener('change', () => {
        const itemId = input.dataset.mtItemName || input.dataset.mtItemQty || input.dataset.mtItemUnit || input.dataset.mtItemPrice;
        const patch = {};
        if (input.dataset.mtItemName) patch.name = input.value;
        if (input.dataset.mtItemQty) patch.quantity = input.value;
        if (input.dataset.mtItemUnit) patch.unit = input.value;
        if (input.dataset.mtItemPrice) patch.projected_unit_price = input.value;
        updateItem(itemId, patch, input.dataset.mtListId);
      });
    });
  }

  function bindSectionContent(root){
    root.querySelectorAll('[data-mt-add-section]').forEach((button) => {
      button.addEventListener('click', () => addItem(null, button.dataset.mtAddSection));
    });
    root.querySelectorAll('[data-mt-units-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        state.unitsMode = state.unitsMode === 'order' ? 'measured' : 'order';
        render({ preserveScroll: true });
      });
    });
    bindLineControls(root);
  }

  function bindMain(root){
    root.querySelector('[data-mt-refresh]')?.addEventListener('click', loadData);
    root.querySelectorAll('[data-mt-section]').forEach((button) => button.addEventListener('click', () => {
      state.selectedSection = button.dataset.mtSection || 'all';
      rootWindow.Portal?.navigation?.replace?.({ materialSection:state.selectedSection === 'all' ? null : state.selectedSection }, { source:'scope-section', ownedKeys:['materialSection'] });
      render({ preserveScroll:true });
    }));
    bindSectionContent(root);
    root.querySelector('[data-mt-open-pricebook]')?.addEventListener('click', () => {
      state.pricebookOpen = !state.pricebookOpen;
      syncPricebookPanel();
    });
    root.querySelector('[data-mt-close-pricebook]')?.addEventListener('click', () => {
      state.pricebookOpen = false;
      syncPricebookPanel();
    });
    root.querySelector('[data-mt-pricebook-search]')?.addEventListener('input', (event) => {
      state.pricebookSearch = event.target.value || '';
      syncPricebookPanel();
    });
    root.querySelectorAll('[data-mt-add-pricebook]').forEach((button) => {
      button.addEventListener('click', () => addItem(state.pricebookItems.find((item) => item.id === button.dataset.mtAddPricebook)));
    });
    root.querySelector('[data-mt-expand-pricebook]')?.addEventListener('click', (event) => {
      const pb = pricebook();
      const originEl = event.currentTarget?.closest?.('[data-mt-pricebook-panel]') || event.currentTarget;
      const rect = originEl?.getBoundingClientRect?.();
      state.pricebookOpen = false;
      syncPricebookPanel();
      pb?.open?.({
        title: (globalThis.PlatformLanguage?.text("materials","m_dd68cb64803c4d","Price Book") ?? "Price Book"),
        subtitle: (globalThis.PlatformLanguage?.text("materials","m_66623bd81e6af5","Edit material item types, variants, options, prices, and formulas.") ?? "Edit material item types, variants, options, prices, and formulas."),
        originRect: rect ? {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        } : null
      });
    });
    root.querySelectorAll('[data-mt-item-option]').forEach((button) => {
      button.addEventListener('click', () => updateItemOption(button.dataset.mtItemOption, button.dataset.mtOptionId, button.dataset.mtOptionValue, button.dataset.mtListId));
    });
    if (state.colorMenu) {
      root.querySelector('[data-mt-material-scroll]')?.addEventListener('scroll', () => {
        closeColorMenu();
      }, { once: true, passive: true });
    }
    root.querySelector('[data-mt-material-scroll]')?.addEventListener('scroll', closeListMenu, { once: true, passive: true });
    root.querySelector('[data-mt-schedule-list]')?.addEventListener('click', (event) => scheduleMaterialList(event.currentTarget.dataset.mtScheduleList));
    root.querySelector('[data-mt-order]')?.addEventListener('click', () => {
      initializeOrderComposer(state.activeListId, { preferUnordered: true });
      syncOrderDialog(true);
    });
    root.querySelector('[data-mt-close-order]')?.addEventListener('click', (event) => event.currentTarget.closest('[data-mt-order-dialog]')?.close?.());
    root.querySelector('[data-mt-close-order-backdrop]')?.addEventListener('click', (event) => event.currentTarget.closest('[data-mt-order-dialog]')?.close?.());
    root.querySelectorAll('[data-mt-order-provider]').forEach((button) => button.addEventListener('click', () => {
      state.orderProvider = button.dataset.mtOrderProvider || 'manual';
      syncOrderDialog(true);
    }));
    root.querySelectorAll('[data-mt-order-list-toggle]').forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.mtOrderListToggle;
      captureOrderDraft(button.closest('[data-mt-order-dialog]'));
      if (!state.orderSelectedListIds.has(id)) {
        state.orderSelectedListIds.add(id);
        seedOrderSchedule(materialListById(id));
      } else if (state.orderSelectedListIds.size > 1) {
        state.orderSelectedListIds.delete(id);
        if (cleanText(state.orderScheduleFocusListId) === cleanText(id)) state.orderScheduleFocusListId = cleanText(selectedOrderLists()[0]?.id);
      } else {
        showToast((globalThis.PlatformLanguage?.text("materials","m_9e17ad9739b8ed","Keep one material list selected") ?? "Keep one material list selected"), (globalThis.PlatformLanguage?.text("materials","m_4e836c11f2a642","Choose another list before removing this one.") ?? "Choose another list before removing this one."), false);
      }
      const selected = selectedOrderLists();
      const listTitles = materialOrderLists().map((list) => cleanText(list.title)).filter(Boolean);
      if (selected.length > 1 && listTitles.includes(cleanText(state.orderDraft.title))) state.orderDraft.title = (globalThis.PlatformLanguage?.text("materials","m_8b217b055a433f","Combined material order") ?? "Combined material order");
      if (selected.length === 1 && cleanText(state.orderDraft.title) === 'Combined material order') state.orderDraft.title = cleanText(selected[0]?.title || (globalThis.PlatformLanguage?.text("materials","m_d7bad661a9f673","Material order") ?? "Material order"));
      if (state.orderTimingChoice === 'scheduled') {
        state.orderDatesConfirmed = orderScheduleDatesComplete() && selected.every((list) => scheduleDraftForList(list).dirty !== true);
      }
      state.orderDraftFresh = true;
      syncOrderDialog(true);
    }));
    root.querySelectorAll('[data-mt-order-timing]').forEach((button) => button.addEventListener('click', () => {
      const scheduled = button.dataset.mtOrderTiming !== 'without_dates';
      state.orderTimingChoice = scheduled ? 'scheduled' : 'without_dates';
      if (!scheduled) {
        state.orderCalendarOpen = false;
        syncOrderDialog(true);
        return;
      }
      const datesComplete = orderScheduleDatesComplete();
      const datesAlreadyConfirmed = datesComplete && (state.orderDatesConfirmed || selectedOrderLists().every((list) => scheduleDraftForList(list).dirty !== true));
      state.orderCalendarOpen = !datesAlreadyConfirmed;
      state.orderDatesConfirmed = datesAlreadyConfirmed;
      if (scheduled) {
        const nextList = selectedOrderLists().find((list) => !cleanText(scheduleDraftForList(list).date)) || selectedOrderLists()[0];
        state.orderScheduleFocusListId = cleanText(nextList?.id);
        const draftDate = nextList ? dateFromOrderSchedule(scheduleDraftForList(nextList)) : null;
        if (draftDate) state.orderCalendarDate = draftDate;
      }
      syncOrderDialog(true);
    }));
    root.querySelectorAll('[data-mt-order-schedule-focus]').forEach((button) => button.addEventListener('click', () => {
      const list = materialListById(button.dataset.mtOrderScheduleFocus);
      if (!list) return;
      state.orderScheduleFocusListId = cleanText(list.id);
      const draftDate = dateFromOrderSchedule(scheduleDraftForList(list));
      if (draftDate) state.orderCalendarDate = draftDate;
      syncOrderDialog(true);
    }));
    root.querySelectorAll('[data-mt-order-review-email]').forEach((button) => button.addEventListener('click', () => {
      state.orderCalendarOpen = false;
      syncOrderDialog(true);
    }));
    root.querySelectorAll('[data-mt-order-open-calendar]').forEach((button) => button.addEventListener('click', () => {
      state.orderTimingChoice = 'scheduled';
      state.orderCalendarOpen = true;
      state.orderDatesConfirmed = false;
      const nextList = selectedOrderLists().find((list) => !cleanText(scheduleDraftForList(list).date)) || selectedOrderLists()[0];
      state.orderScheduleFocusListId = cleanText(nextList?.id);
      syncOrderDialog(true);
    }));
    root.querySelectorAll('[data-mt-order-confirm-dates]').forEach((button) => button.addEventListener('click', () => {
      if (!orderScheduleDatesComplete()) {
        showToast((globalThis.PlatformLanguage?.text("materials","m_55b9357dd5ce66","Delivery dates still needed") ?? "Delivery dates still needed"), (globalThis.PlatformLanguage?.text("materials","m_3d7f07360507a6","Place every selected delivery on the calendar before confirming.") ?? "Place every selected delivery on the calendar before confirming."), false);
        return;
      }
      state.orderDatesConfirmed = true;
      state.orderCalendarOpen = false;
      syncOrderDialog(true);
    }));
    root.querySelector('[data-mt-copy-order]')?.addEventListener('click', copyOrderRequest);
    root.querySelector('[data-mt-order-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await createOrderFromForm(event.currentTarget);
      state.panelRoot?.querySelector?.('[data-mt-order-dialog]')?.close?.();
    });
    root.querySelectorAll('[data-mt-close-new-list]').forEach((button) => button.addEventListener('click', () => root.querySelector('[data-mt-new-list-dialog]')?.close?.()));
    const listColor = root.querySelector('[data-mt-new-list-form] input[name="color"]');
    const listColorText = root.querySelector('[data-mt-new-list-color-text]');
    listColor?.addEventListener('input', () => { if (listColorText) listColorText.value = listColor.value; });
    listColorText?.addEventListener('change', () => { if (listColor && /^#[0-9a-f]{6}$/i.test(listColorText.value)) listColor.value = listColorText.value; });
    root.querySelector('[data-mt-new-list-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const scheduleAfterCreate = !!event.submitter?.hasAttribute?.('data-mt-new-list-schedule');
      root.querySelector('[data-mt-new-list-dialog]')?.close?.();
      await createMaterialListFromForm(event.currentTarget, scheduleAfterCreate);
    });
    root.querySelectorAll('[data-mt-deliver]').forEach((button) => {
      button.addEventListener('click', () => recordDelivery(button.dataset.mtDeliver));
    });
  }

  function renderLeft(){
    const timingStart = performance.now();
    if (!state.leftRoot || !state.active) return;
    const target = leftContentRoot();
    if (!target) return;
    target.querySelector?.('.mn-left')?.remove();
    target.querySelector?.('.r-schedule-left-shell')?.remove();
    state.leftRoot.classList.add('visible', 'mode-edit');
    state.leftRoot.classList.remove('mode-list', 'mode-send');
    const label = state.leftRoot.querySelector('#rProposalLabel');
    if (label) {
      label.textContent = (globalThis.PlatformLanguage?.text("materials","m_9d3e82ecfd10ec","Scope") ?? "Scope");
      label.hidden = true;
    }
    target.innerHTML = leftHtml();
    bindLeft(target);
    projectNotesApi()?.bindHistoryExtras?.(target.querySelector('[data-mt-note-list]'), () => state.project);
    if (state.project?.id) projectNotesApi()?.load?.(state.project);
    timingMark('renderLeft:end', { active: state.active }, timingStart);
  }

  function leftContentRoot(){
    if (!state.leftRoot) return null;
    let list = state.leftRoot.querySelector('#rProposalList');
    if (!list) {
      state.leftRoot.innerHTML = `
        <div class="r-step-shell" style="grid-template-rows:1fr"><div class="r-step-inner"><div class="r-step-body">
          <label id="rProposalLabel">${(globalThis.PlatformLanguage?.htmlText("materials","m_9d3e82ecfd10ec","Scope") ?? "Scope")}</label>
          <div class="r-proposal-listing" id="rProposalList"></div>
        </div></div></div>
      `;
      list = state.leftRoot.querySelector('#rProposalList');
    }
    return list;
  }

  function setWorkspaceChrome(active){
    const overlay = state.context?.overlayRoot || state.context?.roots?.overlay || $('#rOverlay');
    if (!overlay) return;
    const activeTab = state.host?.getActivePreviewTab?.() || state.context?.activeTab || '';
    const setLeftOverride = typeof state.host?.setLeftColumnOverride === 'function'
      ? state.host.setLeftColumnOverride
      : null;
    if (active) {
      overlay.classList.add('materials-workspace');
      if (setLeftOverride) setLeftOverride(true, 'materials');
      else {
        overlay.classList.add('left-override');
        overlay.dataset.leftOverrideTab = 'materials';
      }
      overlay.classList.toggle('proposal-workspace', activeTab === 'proposal');
      return;
    }
    overlay.classList.remove('materials-workspace');
    if (setLeftOverride && activeTab !== 'materials') setLeftOverride(false, 'materials');
    else if (!setLeftOverride && activeTab !== 'materials') {
      overlay.classList.remove('left-override');
      delete overlay.dataset.leftOverrideTab;
    }
    if (activeTab !== 'proposal') overlay.classList.remove('proposal-workspace');
  }

  function scopeMeasurementRows(){
    const values = scopeMeasurements();
    const definitions = [
      ['roofSquares', 'Roof squares', 'sq'], ['shingleSquares', 'Shingle squares', 'sq'], ['slopeSquares', 'Slope squares', 'sq'],
      ['pitch0to2Squares', '0/12–2/12 pitch', 'sq'], ['flatRoofSquares', '0/12–2/12 (flat/low slope)', 'sq'],
      ['pitch2to4Squares', '2/12–4/12 pitch', 'sq'], ['pitch4to6Squares', '4/12–6/12 pitch', 'sq'],
      ['pitch6to8Squares', '6/12–8/12 pitch', 'sq'], ['pitch8to10Squares', '8/12–10/12 pitch', 'sq'],
      ['pitch10to12Squares', '10/12–12/12 pitch', 'sq'], ['pitch12PlusSquares', '12/12+ pitch', 'sq'],
      ['pitch9to12Squares', '8/12–12/12 pitch (combined)', 'sq'], ['pitch13PlusSquares', '12/12+ pitch', 'sq'],
      ['wastePercent', 'Waste', '%'], ['pitchRise', 'Dominant pitch', '/12'],
      ['eavesLf', 'Eaves', 'lf'], ['rakesLf', 'Rakes', 'lf'], ['hipsLf', 'Hips', 'lf'], ['ridgesLf', 'Ridges', 'lf'],
      ['valleyLf', 'Valleys', 'lf'], ['gutterLf', 'Gutters', 'lf'], ['downspoutLf', 'Downspouts', 'lf'],
      ['chimneysEa', 'Chimneys', 'ea'], ['skylightsEa', 'Skylights', 'ea'], ['pipeBootsEa', 'Pipe boots', 'ea'], ['structureCount', 'Structures', '']
    ];
    const used = new Set();
    const rows = [];
    const add = (key, label, unit, value) => {
      if (value == null || value === '' || typeof value === 'object') return;
      used.add(key);
      const parsed = Number(value);
      const display = Number.isFinite(parsed) ? parsed.toLocaleString([], { maximumFractionDigits: 2 }) : cleanText(value);
      if (!display) return;
      rows.push({ key, label, value: `${display}${unit === '/12' ? '/12' : unit ? ` ${unit}` : ''}` });
    };
    definitions.forEach(([key, label, unit]) => add(key, label, unit, values[key]));
    Object.entries(values).forEach(([key, value]) => {
      if (used.has(key) || ['structureMeasurements', 'structures'].includes(key) || rows.length >= 18) return;
      add(key, titleFromKey(key), '', value);
    });
    return rows;
  }

  function scopeCustomFieldRows(){
    return rootWindow.FirstMateCustomFields?.scopeEntries?.(state.project || {}) || [];
  }

  function projectNotesApi(){ return rootWindow.Portal?.ProjectNotes || null; }
  function scopeNoteDate(value){
    const date = new Date(value || 0);
    return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date.toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' }) : 'Earlier';
  }
  function scopeNotesHtml(){
    const api = projectNotesApi();
    if (!api) return `<div class="mt-empty">${(globalThis.PlatformLanguage?.htmlText("materials","m_9bf0612c80cedb","Notes are unavailable.") ?? "Notes are unavailable.")}</div>`;
    const notes = (api.timeline?.(state.project || {}) || api.visible(state.project || {})).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
    const all = state.noteVisibility.length === api.GROUPS.length;
    return `<div class="mt-project-notes">
      <div class="mt-note-compose">
        <textarea data-mt-note-text placeholder="${(globalThis.PlatformLanguage?.htmlText("materials","m_7546d22adf561a","Add a project note… Use @name or @email to tag someone.") ?? "Add a project note… Use @name or @email to tag someone.")}"></textarea>
        <div data-mt-audio-mount></div>
        <div class="mt-note-compose-foot"><span class="mt-small"><i class="fas fa-eye"></i> ${String(escapeHtml(api.visibilityLabel(state.noteVisibility)))}</span><span><input type="file" data-mt-note-upload-input accept="image/*,video/*,audio/*,.pdf,.doc,.docx" hidden><button type="button" class="mt-note-visibility" data-mt-note-visibility aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_f9c51272aecc10","Note visibility") ?? "Note visibility")}"><i class="fas fa-eye"></i></button> <button type="button" class="mt-note-visibility" data-mt-note-upload aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_1a061030ca2e35","Upload media") ?? "Upload media")}"><i class="fas fa-paperclip"></i></button> <button type="button" class="mt-note-visibility" data-mt-note-audio aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_dd978d5c5b3bd9","Record audio note") ?? "Record audio note")}"><i class="fas fa-microphone"></i></button> <button type="button" class="mt-note-save" data-mt-note-save>${String(state.editingNoteId ? 'Save note' : 'Add note')}</button></span></div>
        <div class="mt-note-visibility-pop" data-mt-note-visibility-pop ${String(state.noteVisibilityOpen ? '' : 'hidden')}><button type="button" data-mt-note-group="everybody"><i class="fas fa-${String(all ? 'check-circle' : 'circle')}"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_d068fb68fb07d2","Everybody") ?? "Everybody")}</button>${String(api.GROUPS.map((group) => `<button type="button" data-mt-note-group="${group}"><i class="fas fa-${state.noteVisibility.includes(group) ? 'check-circle' : 'circle'}"></i>${escapeHtml(group[0].toUpperCase() + group.slice(1))}</button>`).join(''))}<button type="button" data-mt-note-group="only_tagged"><i class="fas fa-${String(state.noteVisibility.length ? 'circle' : 'check-circle')}"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_6909fe060ad4e1","Only Tagged") ?? "Only Tagged")}</button></div>
      </div>
      <div class="mt-note-list" data-mt-note-list>${String(notes.length ? notes.map((note) => note.deleted_at
        ? `<article class="mt-note-card pn-removed" data-project-note-id="${escapeHtml(note.id)}">${api.removedNoteHtml?.(note) || ''}</article>`
        : `<article class="mt-note-card ${api.typeTags(note).length ? 'fm-note-card-with-types' : ''}" data-project-note-id="${escapeHtml(note.id)}">${api.renderTypeTags(note)}${note.text ? `<p>${escapeHtml(note.text)}</p>` : ''}${api.audioPlayerHtml?.(note) || ''}${api.mediaAttachmentsHtml?.(note) || ''}<div class="mt-note-meta"><span>${escapeHtml(note.created_by?.name || note.created_by?.email || 'Unknown')} · ${escapeHtml(scopeNoteDate(note.created_at))} · ${escapeHtml(api.visibilityLabel(note.visibility))}${api.editedMetaHtml?.(note) || ''}</span><span class="mt-note-actions">${api.repliesToggleHtml?.(note) || ''}${(note.can_edit || api.owns(note)) ? `<button type="button" data-mt-note-edit="${escapeHtml(note.id)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_1fcb173e99effe","Edit note") ?? "Edit note")}"><i class="fas fa-pen"></i></button>` : ''}${(note.can_delete || api.owns(note)) ? `<button type="button" data-mt-note-remove="${escapeHtml(note.id)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_4b4ba3b5b6d01b","Remove note") ?? "Remove note")}"><i class="fas fa-trash"></i></button>` : ''}</span></div></article>`).join('') : `<div class="mt-note-empty">${(globalThis.PlatformLanguage?.htmlText("materials","m_4eb6b190c37dac","No project notes yet.") ?? "No project notes yet.")}</div>`)}</div>
    </div>`;
  }

  async function persistScopeNotes(){
    // Notes persist through the channels backend; the project document itself
    // no longer carries note data, so no remote project save is needed here.
    await projectNotesApi()?.flush?.(state.project)?.catch?.(() => null);
    rootWindow.dispatchEvent(new CustomEvent('fm:project-notes:changed', { detail:{ projectId:projectId() } }));
  }

  rootWindow.addEventListener('fm:project-notes:refreshed', (event) => {
    if (!state.mounted || !state.active) return;
    if (cleanText(event.detail?.projectId) !== cleanText(projectId())) return;
    // Don't clobber an in-progress draft: renderLeft rebuilds the composer.
    const draftEl = leftContentRoot()?.querySelector?.('[data-mt-note-text]');
    if (draftEl && (document.activeElement === draftEl || cleanText(draftEl.value))) return;
    renderLeft();
  });

  function leftHtml(){
    const measurementRows = scopeMeasurementRows();
    const customFieldRows = scopeCustomFieldRows();
    const listsOpen = state.leftSections.lists !== false;
    const measurementsOpen = state.leftSections.measurements !== false;
    const customFieldsOpen = state.leftSections.custom_fields !== false;
    const notesOpen = state.leftSections.notes !== false;
    const noteCount = projectNotesApi()?.visible(state.project || {}).length || 0;
    return `
      <div class="mt-left">
        <div class="mt-left-head"><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_9d3e82ecfd10ec","Scope") ?? "Scope")}</strong>${String(state.activeList ? `<em class="mt-status ${statusClass(state.activeList.status)}">${escapeHtml(resourceTerms(resourceType(state.activeList), state.activeList).plural)}</em>` : '')}</div>
        <div class="mt-left-body">
          <section class="mt-left-group ${String(listsOpen ? '' : 'collapsed')}">
            <button type="button" class="mt-left-group-head" data-mt-left-toggle="lists" aria-expanded="${String(listsOpen ? 'true' : 'false')}"><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_aee5caa035aefc","Lists") ?? "Lists")}</strong><span>${String(state.lists.length)} <i class="fas fa-chevron-${String(listsOpen ? 'up' : 'down')}"></i></span></button>
            <div class="mt-left-group-body">
              ${String(['material', 'labor', 'equipment'].map((type) => {
                const lists = state.lists.filter((list) => resourceType(list) === type);
                if (!lists.length) return '';
                const terms = resourceTerms(type, lists[0]);
                return `<div class="mt-resource-group"><div class="mt-resource-group-title"><i class="fas ${escapeHtml(terms.icon)}"></i>${escapeHtml(terms.plural)}</div>${lists.map((list) => renderScopeListCard(list, state.lists.indexOf(list))).join('')}</div>`;
              }).join('') || `<div class="mt-empty">${(globalThis.PlatformLanguage?.htmlText("materials","m_9138375c2ce3e1","This scope does not define any resource lists.") ?? "This scope does not define any resource lists.")}</div>`)}
              <button type="button" class="mt-list-add mt-list-regenerate" data-mt-generate-materials ${String(state.generatingMaterials || state.saving ? 'disabled' : '')}><i class="fas ${String(state.generatingMaterials ? 'fa-rotate mt-spin' : 'fa-arrows-rotate')}"></i> ${String(state.generatingMaterials ? 'Regenerating' : 'Regenerate from scope')}</button>
              <button type="button" class="mt-list-add" data-mt-open-new-list><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_b8547d1ae4d15f"," New scope list") ?? " New scope list")}</button>
            </div>
          </section>
          <section class="mt-left-group ${String(measurementsOpen ? '' : 'collapsed')}">
            <button type="button" class="mt-left-group-head" data-mt-left-toggle="measurements" aria-expanded="${String(measurementsOpen ? 'true' : 'false')}"><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_0ce54f0aa2d758","Scope measurements") ?? "Scope measurements")}</strong><span>${String(measurementRows.length)} <i class="fas fa-chevron-${String(measurementsOpen ? 'up' : 'down')}"></i></span></button>
            <div class="mt-left-group-body">
              ${String(measurementRows.length ? `<div class="mt-scope-measures">${measurementRows.map((row) => `<div class="mt-scope-measure"><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(row.value)}</strong></div>`).join('')}</div><div class="mt-small"><i class="fas fa-lock"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_4d90bde666c93e"," Saved from the project scope") ?? " Saved from the project scope")}</div>` : `<div class="mt-empty">${(globalThis.PlatformLanguage?.htmlText("materials","m_7bdd98e65148d7","No measurements were saved with this scope.") ?? "No measurements were saved with this scope.")}</div>`)}
            </div>
          </section>
          ${String(customFieldRows.length ? `<section class="mt-left-group ${customFieldsOpen ? '' : 'collapsed'}">
            <button type="button" class="mt-left-group-head" data-mt-left-toggle="custom_fields" aria-expanded="${customFieldsOpen ? 'true' : 'false'}"><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_2d1233007f5250","Custom fields") ?? "Custom fields")}</strong><span>${customFieldRows.length} <i class="fas fa-chevron-${customFieldsOpen ? 'up' : 'down'}"></i></span></button>
            <div class="mt-left-group-body">
              <div class="mt-scope-measures">${customFieldRows.map((row) => `<div class="mt-scope-measure"><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(row.display)}</strong></div>`).join('')}</div>
              <div class="mt-small"><i class="fas fa-table-list"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_2280f0c13c04b8"," Project custom fields selected for Scope") ?? " Project custom fields selected for Scope")}</div>
            </div>
          </section>` : '')}
          <section class="mt-left-group ${String(notesOpen ? '' : 'collapsed')}">
            <button type="button" class="mt-left-group-head" data-mt-left-toggle="notes" aria-expanded="${String(notesOpen ? 'true' : 'false')}"><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_d1e91b9e7610fa","Project Notes") ?? "Project Notes")}</strong><span>${String(noteCount)} <i class="fas fa-chevron-${String(notesOpen ? 'up' : 'down')}"></i></span></button>
            <div class="mt-left-group-body">${String(scopeNotesHtml())}</div>
          </section>
        </div>
      </div>
    `;
  }

  function renderScopeListCard(list, index){
    const id = cleanText(list.id);
    const type = resourceType(list);
    const terms = resourceTerms(type, list);
    const color = materialListColor(list, index);
    const visible = state.visibleListIds.has(id);
    const ordered = type === 'material' && materialListOrdered(list);
    const eventParts = eventDateParts(linkedScheduleEvent(list));
    const schedulePending = resourceSchedulePending(list);
    const incomplete = resourceListIncomplete(list);
    const status = type === 'material'
      ? (!ordered ? 'Not ordered' : (schedulePending ? 'Not scheduled' : 'Ordered'))
      : (resourceScheduleEnabled(list) ? (eventParts.date ? `Scheduled ${eventParts.date}` : 'Not scheduled') : 'Ready');
    const controls = type === 'labor' ? renderLaborListControls(list) : renderListActionControls(list, type, ordered);
    return `<div class="mt-list-wrap${controls ? ' with-controls' : ''}" data-mt-list-wrap="${escapeHtml(id)}"><div class="mt-list-card ${state.activeListId === id ? 'active' : ''} ${incomplete ? 'incomplete' : 'complete'}" style="--list-color:${escapeHtml(color)}" data-mt-list-select="${escapeHtml(id)}" role="button" tabindex="0" aria-current="${state.activeListId === id ? 'true' : 'false'}">
      <span class="mt-list-card-copy"><strong>${escapeHtml(list.title || terms.list)}</strong><span><i class="fas ${type === 'material' && ordered ? 'fa-lock' : terms.icon}"></i>${escapeHtml(status)}</span></span>
      <span class="mt-list-card-actions"><button type="button" class="mt-list-eye ${visible ? 'visible' : ''}" style="--list-color:${escapeHtml(color)}" data-mt-list-visibility="${escapeHtml(id)}" title="${visible ? 'Hide' : 'Show'} ${escapeHtml(list.title || terms.list)}" aria-pressed="${visible ? 'true' : 'false'}"><i class="fas fa-eye${visible ? '' : '-slash'}"></i></button></span>
    </div>${controls}</div>`;
  }

  function renderListActionControls(list, type, ordered){
    const id = cleanText(list.id);
    const schedule = resourceScheduleEnabled(list);
    if (!schedule && type !== 'material') return '';
    return `<div class="mt-list-secondary">
      ${schedule ? `<button type="button" data-mt-list-schedule="${String(escapeHtml(id))}" ${String(state.schedulingListId ? 'disabled' : '')}><i class="fas fa-calendar-day"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_80ce49ac8b6049"," Schedule") ?? " Schedule")}</button>` : ''}
      ${type === 'material' ? `<button type="button" data-mt-list-order="${escapeHtml(id)}"><i class="fas ${ordered ? 'fa-circle-check' : 'fa-cart-shopping'}"></i> ${ordered ? 'Ordered' : 'Order'}</button>` : ''}
    </div>`;
  }

  function renderLaborListControls(list){
    const id = cleanText(list.id);
    const resourceId = cleanText(assignmentWorkResourceRef(list)?.id);
    const mode = cleanText(list?.compensation?.mode || list?.compensation?.default_mode || 'crew_default');
    const estimatedHours = Math.max(0, number(list?.compensation?.estimated_hours, 0));
    const salaryMode = cleanText(list?.compensation?.salary_expense_mode || (list?.compensation?.include_salary_as_hourly ? 'hourly' : 'ignore')) || 'ignore';
    const availableResources = workResourcesForScopeList(list);
    const selectedResource = workResourceById(resourceId);
    const resolvedMode = mode === 'crew_default'
      ? cleanText(list?.compensation?.resolved_mode || workResourceCompensationMode(selectedResource))
      : mode;
    const usesHours = ['hourly', 'hybrid'].includes(resolvedMode) || (resolvedMode === 'salary' && salaryMode === 'hourly');
    const canRegenerate = list?.metadata?.generated_from_scope === true && !!cleanText(list.scope_piece_id);
    const regenerating = state.regeneratingLaborListId === id;
    if (selectedResource && !availableResources.some((resource) => cleanText(resource.id) === resourceId)) availableResources.push(selectedResource);
    return `<div class="mt-list-secondary mt-labor-controls">
      <label title="${(globalThis.PlatformLanguage?.htmlText("materials","m_af5a4817bd5b60","Assigned work resource") ?? "Assigned work resource")}"><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_2f9d72baaebef0","Assigned") ?? "Assigned")}</span><select aria-label="${String(escapeHtml(workResourceLabel()))}" data-mt-labor-crew="${String(escapeHtml(id))}" ${String(state.saving ? 'disabled' : '')}><option value="">${(globalThis.PlatformLanguage?.htmlText("materials","m_8a993ed9b573b4","Unassigned") ?? "Unassigned")}</option>${String(availableResources.map((resource) => `<option value="${escapeHtml(resource.id)}" ${cleanText(resource.id) === resourceId ? 'selected' : ''}>${escapeHtml(resource.name || resource.label || resource.id)}</option>`).join(''))}</select></label>
      <label title="${(globalThis.PlatformLanguage?.htmlText("materials","m_ea57418325cafc","Project pay") ?? "Project pay")}"><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_f4f42f8c853a8d","Pay") ?? "Pay")}</span><select aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_ea57418325cafc","Project pay") ?? "Project pay")}" data-mt-labor-pay="${String(escapeHtml(id))}" ${String(state.saving ? 'disabled' : '')}><option value="crew_default" ${String(mode === 'crew_default' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("materials","m_01fe62d31733b2","Resource default") ?? "Resource default")}</option><option value="hourly" ${String(mode === 'hourly' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("materials","m_6a122e6ae08ae2","Hourly") ?? "Hourly")}</option><option value="piece_rate" ${String(mode === 'piece_rate' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("materials","m_237cf67332e1e8","Piece rate") ?? "Piece rate")}</option><option value="hybrid" ${String(mode === 'hybrid' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("materials","m_2ba7610473702e","Hourly + piece") ?? "Hourly + piece")}</option><option value="none" ${String(mode === 'none' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("materials","m_15c0c3889ab7d1","No project pay") ?? "No project pay")}</option></select></label>
      ${String(usesHours ? `<label title="${(globalThis.PlatformLanguage?.htmlText("materials","m_1cb199acd2ef5f","Estimated project hours per person") ?? "Estimated project hours per person")}"><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_5cb10fcf024aeb","Hours") ?? "Hours")}</span><input aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_32485d4a3101c8","Estimated hours per person") ?? "Estimated hours per person")}" data-mt-labor-hours="${escapeHtml(id)}" type="number" min="0" step="0.25" value="${escapeHtml(estimatedHours || '')}" placeholder="0" ${state.saving ? 'disabled' : ''}></label>` : '')}
      <label title="${(globalThis.PlatformLanguage?.htmlText("materials","m_fc17203896ecce","How salary compensation should be represented in this project expense") ?? "How salary compensation should be represented in this project expense")}"><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_40c128013ab7d0","Salary") ?? "Salary")}</span><select aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_d880e01e767290","Salary expense treatment") ?? "Salary expense treatment")}" data-mt-labor-salary="${String(escapeHtml(id))}" ${String(state.saving ? 'disabled' : '')}><option value="ignore" ${String(salaryMode === 'ignore' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("materials","m_b26fb21a853ebc","Ignore") ?? "Ignore")}</option><option value="hourly" ${String(salaryMode === 'hourly' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("materials","m_5b8c03e32d38d3","Convert to hourly") ?? "Convert to hourly")}</option></select></label>
      ${String((resourceScheduleEnabled(list) || canRegenerate) ? `<span class="mt-labor-actions">${canRegenerate ? `<button type="button" data-mt-regenerate-labor="${escapeHtml(id)}" ${state.saving || regenerating ? 'disabled' : ''}><i class="fas ${regenerating ? 'fa-rotate mt-spin' : 'fa-arrows-rotate'}"></i> ${regenerating ? 'Regenerating' : 'Regenerate labor'}</button>` : ''}${resourceScheduleEnabled(list) ? `<button type="button" data-mt-list-schedule="${escapeHtml(id)}" ${state.schedulingListId ? 'disabled' : ''}><i class="fas fa-calendar-day"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_80ce49ac8b6049"," Schedule") ?? " Schedule")}</button>` : ''}</span>` : '')}
    </div>`;
  }

  function scopeButton(value, label, icon){
    return `<button type="button" class="${state.roofScope === value ? 'active' : ''}" data-mt-scope="${escapeHtml(value)}"><i class="fas ${escapeHtml(icon)}"></i>${escapeHtml(label)}</button>`;
  }

  function renderDetailsSection(){
    return `
      <div class="mt-detail-card">
        <div class="mt-prompt">${(globalThis.PlatformLanguage?.htmlText("materials","m_b3ecc234f63212","Details") ?? "Details")}</div>
        <div class="mt-choice-row">
          <span class="mt-small">${(globalThis.PlatformLanguage?.htmlText("materials","m_996992330dcc5c","Flashing color") ?? "Flashing color")}</span>
          <div class="mt-swatch-row">
            ${String(['black', 'brown'].map((color) => `<button type="button" class="mt-swatch-btn${state.flashingColor === color ? ' active' : ''}" data-mt-flashing-color="${escapeHtml(color)}" title="${escapeHtml(color)}" style="background:${escapeHtml(colorForValue(color))}"></button>`).join(''))}
          </div>
        </div>
      </div>
    `;
  }

  function measurementField(key, label, value, unit = '', allowZero = false){
    const parsed = number(value, 0);
    const missing = !allowZero && parsed <= 0;
    return `
      <div class="mt-measure-field${missing ? ' missing' : ''}">
        <label for="mt_${escapeHtml(key)}">${escapeHtml(label)}</label>
        <div class="mt-measure-value">
          <input id="mt_${escapeHtml(key)}" data-mt-measure="${escapeHtml(key)}" type="number" min="0" step="0.01" value="${escapeHtml(parsed)}">
          ${unit ? `<span>${escapeHtml(unit)}</span>` : ''}
        </div>
      </div>
    `;
  }

  function measurementReadoutField(label, value){
    const missing = !cleanText(value) || cleanText(value) === '-';
    return `
      <div class="mt-measure-field${missing ? ' missing' : ''}">
        <label>${escapeHtml(label)}</label>
        <div class="mt-measure-value">
          <input type="text" value="${escapeHtml(value || '-')}" readonly>
        </div>
      </div>
    `;
  }

  function closeScopeNoteVisibilityOnOutsideClick(event){
    if (!state.noteVisibilityOpen || event.target?.closest?.('[data-mt-note-visibility],[data-mt-note-visibility-pop]')) return;
    state.noteVisibilityOpen = false;
    const pop = leftContentRoot()?.querySelector?.('[data-mt-note-visibility-pop]');
    if (pop) pop.hidden = true;
  }

  function bindLeft(root){
    rootWindow.FirstMateAudioNotes?.hydrate?.(root);
    const pendingAudioMount = root.querySelector('[data-mt-audio-mount]');
    if (state.pendingAudioNote && pendingAudioMount) {
      const pendingAudioButton = root.querySelector('[data-mt-note-audio]');
      if (pendingAudioButton) pendingAudioButton.disabled = true;
      projectNotesApi()?.mountPreparedUpload?.(pendingAudioMount, state.pendingAudioNote, () => {
        state.pendingAudioNote = null;
        const button = root.querySelector('[data-mt-note-audio]');
        if (button) button.disabled = false;
        const uploadButton = root.querySelector('[data-mt-note-upload]');
        if (uploadButton) uploadButton.disabled = false;
      });
    }
    if (!noteVisibilityOutsideBound) {
      document.addEventListener('click', closeScopeNoteVisibilityOnOutsideClick);
      noteVisibilityOutsideBound = true;
    }
    root.querySelectorAll('[data-mt-left-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.mtLeftToggle;
        if (!key) return;
        state.leftSections[key] = state.leftSections[key] === false;
        renderLeft();
      });
    });
    root.querySelector('[data-mt-note-visibility]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const pop = root.querySelector('[data-mt-note-visibility-pop]');
      state.noteVisibilityOpen = !state.noteVisibilityOpen;
      if (pop) pop.hidden = !state.noteVisibilityOpen;
    });
    root.querySelectorAll('[data-mt-note-group]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      const api = projectNotesApi();
      const draft = root.querySelector('[data-mt-note-text]')?.value || '';
      const group = button.dataset.mtNoteGroup;
      if (!api) return;
      if (group === 'everybody') state.noteVisibility = [...api.GROUPS];
      else if (group === 'only_tagged') state.noteVisibility = [];
      else state.noteVisibility = state.noteVisibility.includes(group) ? state.noteVisibility.filter((item) => item !== group) : [...state.noteVisibility, group];
      state.noteVisibilityOpen = true;
      renderLeft();
      const next = leftContentRoot()?.querySelector('[data-mt-note-text]');
      if (next) next.value = draft;
    }));
    root.querySelector('[data-mt-note-save]')?.addEventListener('click', async () => {
      const api = projectNotesApi();
      const text = cleanText(root.querySelector('[data-mt-note-text]')?.value);
      if (!api || (!text && !state.pendingAudioNote?.attachment) || !state.project) return;
      if (state.editingNoteId) api.update(state.project, state.editingNoteId, { text, visibility:state.noteVisibility });
      else api.add(state.project, text, state.noteVisibility, [], [], state.pendingAudioNote ? {
        attachments:[state.pendingAudioNote.attachment],
        metadata:state.pendingAudioNote.kind === 'audio' || String(state.pendingAudioNote.attachment?.content_type || '').startsWith('audio/')
          ? { audio_note:state.pendingAudioNote.metadata }
          : state.pendingAudioNote.metadata
      } : {});
      state.editingNoteId = '';
      state.pendingAudioNote = null;
      state.noteVisibility = [...api.GROUPS];
      state.noteVisibilityOpen = false;
      renderLeft();
      await persistScopeNotes();
      showToast((globalThis.PlatformLanguage?.text("materials","m_6c9ffb3d517f10","Note saved") ?? "Note saved"), (globalThis.PlatformLanguage?.text("materials","m_3b44027b035a28","Project note added to the history.") ?? "Project note added to the history."), true);
    });
    root.querySelector('[data-mt-note-upload]')?.addEventListener('click', () => root.querySelector('[data-mt-note-upload-input]')?.click());
    root.querySelector('[data-mt-note-upload-input]')?.addEventListener('change', async (event) => {
      const inputFile = event.currentTarget;
      const file = inputFile.files?.[0];
      const uploadButton = root.querySelector('[data-mt-note-upload]');
      const audioButton = root.querySelector('[data-mt-note-audio]');
      const api = projectNotesApi();
      inputFile.value = '';
      if (!file || !api?.prepareUpload || !state.project || state.pendingAudioNote) return;
      if (uploadButton) uploadButton.disabled = true;
      if (audioButton) audioButton.disabled = true;
      try {
        state.pendingAudioNote = await api.prepareUpload(state.project, file);
        const input = root.querySelector('[data-mt-note-text]');
        if (input && state.pendingAudioNote.text) input.value = [cleanText(input.value), state.pendingAudioNote.text].filter(Boolean).join('\n');
        renderLeft();
      } catch (error) {
        state.pendingAudioNote = null;
        if (uploadButton) uploadButton.disabled = false;
        if (audioButton) audioButton.disabled = false;
        showToast((globalThis.PlatformLanguage?.text("materials","m_eba695c553b0b3","Upload failed") ?? "Upload failed"), String(error?.message || 'Could not attach this file to the note.'), false);
      }
    });
    root.querySelector('[data-mt-note-audio]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const api = projectNotesApi();
      if (!api?.prepareAudioInline || !state.project || button.disabled || state.pendingAudioNote) return;
      button.disabled = true;
      const uploadButton = root.querySelector('[data-mt-note-upload]');
      if (uploadButton) uploadButton.disabled = true;
      const mount = root.querySelector('[data-mt-audio-mount]');
      const removeAudio = () => {
        state.pendingAudioNote = null;
        button.disabled = false;
        if (uploadButton) uploadButton.disabled = false;
      };
      try {
        state.pendingAudioNote = await api.prepareAudioInline(state.project, mount, { onRemove:removeAudio });
        const transcript = state.pendingAudioNote.text;
        const input = root.querySelector('[data-mt-note-text]');
        if (input) input.value = transcript;
      } catch (error) {
        if (!String(error?.message || '').toLowerCase().includes('cancelled')) showToast((globalThis.PlatformLanguage?.text("materials","m_8373af9614b53c","Audio note failed") ?? "Audio note failed"), String(error?.message || 'Could not create the audio note.'), false);
        button.disabled = false;
        if (uploadButton) uploadButton.disabled = false;
      }
    });
    root.querySelectorAll('[data-mt-note-edit]').forEach((button) => button.addEventListener('click', () => {
      const api = projectNotesApi();
      const note = api?.all(state.project || {}).find((item) => item.id === button.dataset.mtNoteEdit);
      if (!note) return;
      state.editingNoteId = note.id;
      state.noteVisibility = [...note.visibility];
      renderLeft();
      const input = leftContentRoot()?.querySelector('[data-mt-note-text]');
      if (input) { input.value = note.text; input.focus(); }
    }));
    root.querySelectorAll('[data-mt-note-remove]').forEach((button) => button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const api = projectNotesApi();
      const project = state.project;
      const noteId = button.dataset.mtNoteRemove;
      if (!api || !(await confirmAction('Remove this project note?')) || state.project !== project || !api.remove(project, noteId)) return;
      if (state.editingNoteId === noteId) state.editingNoteId = '';
      renderLeft();
      await persistScopeNotes();
    }));
    root.querySelectorAll('[data-mt-list-select]').forEach((card) => {
      const activate = () => selectMaterialList(card.dataset.mtListSelect);
      card.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        activate();
      });
      card.addEventListener('keydown', (event) => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        activate();
      });
    });
    root.querySelectorAll('[data-mt-list-visibility]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const id = button.dataset.mtListVisibility;
        if (state.visibleListIds.has(id)) state.visibleListIds.delete(id);
        else state.visibleListIds.add(id);
        syncScopeListCard(id);
        syncMaterialsGrid();
      });
    });
    root.querySelectorAll('[data-mt-list-schedule]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        scheduleMaterialList(button.dataset.mtListSchedule);
      });
    });
    root.querySelectorAll('[data-mt-list-order]').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        await selectMaterialList(button.dataset.mtListOrder);
        initializeOrderComposer(button.dataset.mtListOrder);
        syncOrderDialog(true);
      });
    });
    root.querySelectorAll('[data-mt-labor-crew]').forEach((select) => {
      select.addEventListener('click', (event) => event.stopPropagation());
      select.addEventListener('change', (event) => assignWorkResource(select.dataset.mtLaborCrew, event.target.value));
    });
    root.querySelectorAll('[data-mt-labor-pay]').forEach((select) => {
      select.addEventListener('click', (event) => event.stopPropagation());
      select.addEventListener('change', (event) => setLaborCompensationMode(select.dataset.mtLaborPay, event.target.value));
    });
    root.querySelectorAll('[data-mt-labor-hours]').forEach((input) => {
      input.addEventListener('click', (event) => event.stopPropagation());
      input.addEventListener('change', (event) => setLaborExpenseSettings(input.dataset.mtLaborHours, { estimated_hours:Math.max(0, number(event.target.value, 0)) }));
    });
    root.querySelectorAll('[data-mt-labor-salary]').forEach((select) => {
      select.addEventListener('click', (event) => event.stopPropagation());
      select.addEventListener('change', (event) => setLaborExpenseSettings(select.dataset.mtLaborSalary, {
        salary_expense_mode:event.target.value === 'hourly' ? 'hourly' : 'ignore',
        include_salary_as_hourly:event.target.value === 'hourly'
      }));
    });
    root.querySelectorAll('[data-mt-regenerate-labor]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        regenerateLaborListFromScope(button.dataset.mtRegenerateLabor);
      });
    });
    root.querySelector('[data-mt-open-new-list]')?.addEventListener('click', () => {
      const dialog = state.panelRoot?.querySelector?.('[data-mt-new-list-dialog]');
      dialog?.showModal?.();
      setTimeout(() => dialog?.querySelector?.('input[name="title"]')?.focus?.(), 0);
    });
    root.querySelectorAll('[data-mt-scope]').forEach((button) => {
      button.addEventListener('click', () => {
        state.roofScope = button.dataset.mtScope || 'full_roof';
        renderLeft();
      });
    });
    root.querySelectorAll('[data-mt-measure]').forEach((input) => {
      const updateMeasurement = () => {
        const key = input.dataset.mtMeasure || '';
        state.measurementOverrides = {
          ...(state.measurementOverrides || {}),
          [key]: number(input.value, 0)
        };
      };
      const commitMeasurement = () => {
        updateMeasurement();
        renderLeft();
        syncMaterialsGrid();
      };
      input.addEventListener('focus', () => input.select?.());
      input.addEventListener('input', updateMeasurement);
      input.addEventListener('change', commitMeasurement);
    });
    root.querySelector('[data-mt-generate-materials]')?.addEventListener('click', (event) => {
      markGenerateButtonLoading(event.currentTarget);
      setTimeout(() => regenerateMaterialListsFromScope(), 0);
    });
    root.querySelectorAll('[data-mt-flashing-color]').forEach((button) => {
      button.addEventListener('click', () => {
        state.flashingColor = button.dataset.mtFlashingColor || 'black';
        renderLeft();
      });
    });
    root.querySelector('[data-mt-refresh-measurements]')?.addEventListener('click', () => {
      regenerateMeasurementsFromReport();
    });
    root.querySelectorAll('[data-mt-structure]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.dataset.mtStructure || '';
        if (state.selectedStructureIds.has(id)) state.selectedStructureIds.delete(id);
        else state.selectedStructureIds.add(id);
        if (!state.selectedStructureIds.size) state.selectedStructureIds.add(id);
        renderLeft();
      });
    });
    root.querySelector('[data-mt-confirm-structures]')?.addEventListener('click', () => {
      state.structuresConfirmed = true;
      renderLeft();
      syncMaterialsGrid();
    });
    root.querySelectorAll('[data-mt-structure-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeStructureId = button.dataset.mtStructureTab || 'total';
        renderLeft();
        syncMaterialsGrid();
      });
    });
  }

  function mount(context = {}){
    installTimingProbe();
    const timingStart = performance.now();
    timingMark('mount:start', { active: context.active !== false });
    state.contextGeneration += 1;
    state.saving = false;
    const nextProject = projectFromContext(context);
    const previousProjectId = cleanText(state.project?.id || state.context?.projectId || state.context?.entityId);
    const nextProjectId = cleanText(nextProject?.id || context.projectId || context.entityId);
    state.context = context;
    state.host = context.host || context.projectWorkspace || state.host;
    state.project = nextProject;
    if (previousProjectId && nextProjectId && previousProjectId !== nextProjectId) {
      state.lists = [];
      state.activeListId = '';
      state.activeList = null;
      state.visibleListIds = new Set();
      state.orders = [];
      state.versions = [];
      state.deliveriesByOrderId = {};
      state.orderSelectedListIds = new Set();
      state.orderScheduleDrafts = {};
      state.orderDatesConfirmed = false;
      state.orderCalendarOpen = false;
      state.orderScheduleFocusListId = '';
      state.orderCalendarMode = 'week';
      state.orderCalendarDate = new Date();
      state.orderDraft = {};
      state.orderDraftFresh = false;
      state.measurementExtraSource = {};
      state.roofMeasurements = null;
      state.measurementLoadingId = '';
      state.measurementLoadedId = '';
      state.measurementOverrides = {};
      state.expenseSummary = null;
      state.expenseError = '';
      state.expenseLoading = false;
      state.crews = [];
      state.workforceTerms = {};
      state.saving = false;
    }
    state.panelRoot = context.panelRoot || context.roots?.main || context.root || state.panelRoot;
    state.leftRoot = context.leftRoot || context.roots?.left || state.leftRoot;
    state.active = context.active !== false;
    state.mounted = !!state.panelRoot;
    state.selectedSection = cleanText(rootWindow.Portal?.navigation?.read?.().materialSection) || 'all';
    if (state.panelRoot && !state.panelRoot.querySelector('[data-materials-root]')) state.panelRoot.innerHTML = panelHtml();
    const structures = projectStructures();
    if (!state.selectedStructureIds.size) structures.forEach((structure) => state.selectedStructureIds.add(structure.id));
    setWorkspaceChrome(state.active);
    loadData().catch((error) => {
      state.loading = false;
      state.lastError = error?.message || 'Could not load materials.';
      render();
    });
    renderLeft();
    rootWindow.FirstMateCustomFields?.load?.().then(() => {
      if (state.mounted && state.contextGeneration) {
        renderLeft();
        syncMaterialsGrid();
      }
    }).catch(() => null);
    timingMark('mount:end', { active: state.active, mounted: state.mounted }, timingStart);
    return api;
  }

  function setActive(active){
    installTimingProbe();
    const timingStart = performance.now();
    timingMark('setActive:start', { active: !!active, lists: state.lists.length });
    state.active = !!active;
    setWorkspaceChrome(state.active);
    if (state.active) {
      renderLeft();
      if (!state.lists.length && !state.loading) loadData();
      else render();
    } else {
      state.leftRoot?.querySelector?.('#rProposalList .mt-left')?.remove();
      const activeTab = state.host?.getActivePreviewTab?.() || state.context?.activeTab || '';
      if (!['proposal', 'materials', 'schedule', 'money'].includes(activeTab)) {
        state.leftRoot?.classList?.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
      }
    }
    timingMark('setActive:end', { active: state.active, lists: state.lists.length, items: listItems().length }, timingStart);
  }

  function reset(){
    state.lists = [];
    state.activeListId = '';
    state.activeList = null;
    state.visibleListIds = new Set();
    state.leftSections = { lists: true, measurements: true, custom_fields: true, notes: true };
    state.noteVisibility = ['office', 'crew', 'sales'];
    state.noteVisibilityOpen = false;
    state.editingNoteId = '';
    state.versions = [];
    state.orders = [];
    state.deliveriesByOrderId = {};
    state.crews = [];
    state.crewsLoading = false;
    state.workforceTerms = {};
    state.expenseSummary = null;
    state.expenseLoading = false;
    state.expenseError = '';
    state.selectedStructureIds = new Set();
    state.structuresConfirmed = false;
    state.activeStructureId = 'total';
    state.roofScope = 'full_roof';
    state.measurementOverrides = {};
    state.measurementExtraSource = {};
    state.roofMeasurements = null;
    state.measurementLoadingId = '';
    state.measurementLoadedId = '';
    state.measurementRefreshing = false;
    state.generatingMaterials = false;
    state.regeneratingLaborListId = '';
    state.flashingColor = 'black';
    state.pricebookOpen = false;
    state.pricebookSearch = '';
    state.colorMenu = null;
    state.search = '';
    state.selectedSection = 'all';
    state.orderProvider = 'manual';
    state.orderSelectedListIds = new Set();
    state.orderTimingChoice = '';
    state.orderScheduleDrafts = {};
    state.orderDatesConfirmed = false;
    state.orderCalendarOpen = false;
    state.orderScheduleFocusListId = '';
    state.orderCalendarMode = 'week';
    state.orderCalendarDate = new Date();
    state.orderDraft = {};
    state.orderDraftFresh = false;
    state.schedulingListId = '';
    state.creatingList = false;
  }

  function destroy(){
    if (arrangeFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(arrangeFrame);
    arrangeFrame = 0;
    if (noteVisibilityOutsideBound) document.removeEventListener('click', closeScopeNoteVisibilityOnOutsideClick);
    noteVisibilityOutsideBound = false;
    state.leftRoot?.querySelector?.('#rProposalList .mt-left')?.remove();
    state.leftRoot?.classList?.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
    reset();
    state.mounted = false;
    state.panelRoot = null;
    state.leftRoot = null;
  }

  function invoke(name, args = []){
    const fn = api[name];
    return typeof fn === 'function' ? fn(...(Array.isArray(args) ? args : [])) : undefined;
  }

  const api = {
    mount,
    setActive,
    activate: () => setActive(true),
    deactivate: () => setActive(false),
    render,
    renderAll: render,
    renderLeft,
    loadData,
    reset,
    destroy,
    unmount: destroy,
    invoke,
    debugTiming: () => rootWindow.FirstMateMaterialsTiming?.summary?.() || [],
    context: () => ({
      mounted: state.mounted,
      active: state.active,
      listCount: state.lists.length,
      activeListId: state.activeListId
    })
  };

  Portal.modules = Portal.modules || {};
  Portal.modules.materialsTab = api;
  Portal.modules.scopeTab = api;
  Portal.MaterialsTab = api;

  rootWindow.Portal?.navigation?.registerHandler?.('project-materials-route', {
    priority:600,
    apply:async (route) => {
      if (!route.project || route.projectTab !== 'materials' || !state.mounted) return;
      state.selectedSection = cleanText(route.materialSection) || 'all';
      if (route.materialList && route.materialList !== state.activeListId) await selectMaterialList(route.materialList, { fromRoute:true });
      else render({ preserveScroll:true });
    }
  });

  runtime?.registerApp?.({
    id: 'project.materials',
    kind: 'project_modal_app',
    title: (globalThis.PlatformLanguage?.text("materials","m_9d3e82ecfd10ec","Scope") ?? "Scope"),
    label: (globalThis.PlatformLanguage?.text("materials","m_9d3e82ecfd10ec","Scope") ?? "Scope"),
    icon: 'fa-clipboard-list',
    order: 55,
    visible: true,
    surfaces: ['project_modal'],
    regions: ['main', 'left'],
    requiresContext: ['project'],
    dependencies: ['pricebook.bridge'],
    enabled: (context = {}) => context.materialsEnabled !== false,
    panelHtml,
    mount
  });
})();
