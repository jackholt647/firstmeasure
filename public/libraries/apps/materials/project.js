/* public/libraries/apps/materials/project.js
 * Project modal Materials tab.
 */
(function(){
  let materialsAPI;
  let scopeWorkspace;
  let refreshTimer;
  const scopeWorkspaceUrl = new URL('./scope-of-work.js?v=20261013-rail-motion', document.currentScript?.src || `${location.origin}/libraries/apps/materials/project.js`).href;
  const calculusAdapterUrl = new URL('./calculus-native.js?v=20261013-scope', document.currentScript?.src || `${location.origin}/libraries/apps/materials/project.js`).href;
  const closeoutUrl = new URL('./closeout.js?v=20261015-closeout-order', document.currentScript?.src || `${location.origin}/libraries/apps/materials/project.js`).href;
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
    sidebarRoot: null,
    scopeDocuments: [],
    scopeDocumentsError: '',
    lists: [],
    activeListId: '',
    activeList: null,
    visibleListIds: new Set(),
    collapsedListIds: new Set(),
    expandedItemIds: new Set(),
    minimizedTypes: new Set(),
    dragItem: null,
    laborMenu: null,
    equipmentUnits: null,
    equipmentUnitsLoading: false,
    sourcesMenu: null,
    orderMethod: 'email',
    suppliers: null,
    headerActions: null,
    suppliersLoading: false,
    orderSupplierMenu: null,
    pricebookListId: '',
    autofill: null,
    orderLeftWidth: null,
    columnWeights: null,
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
    resourceTypes: [],
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
    return !!((materialsAPI || window.MaterialsAPI)?.projects && orgId() && projectId());
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
    const category=resourceCategories().find(row=>row.id===resourceType(list));return normalizeColor(category?.color,companyPrimaryColor());
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
    return value || 'material';
  }
  function resourceTerms(type = resourceType(), list = state.activeList){
    const configured = list?.terminology && typeof list.terminology === 'object' ? list.terminology : {};
    const defaults = {
      material: { singular: 'Material', plural: 'Materials', list: 'Material list', icon: 'fa-boxes-stacked' },
      labor: { singular: 'Labor item', plural: 'Labor', list: 'Labor work order', icon: 'fa-helmet-safety' },
      equipment: { singular: 'Equipment item', plural: 'Equipment', list: 'Equipment list', icon: 'fa-truck-pickup' }
    }[type] || {};
    const category=resourceCategories().find(row=>row.id===type);
    return {...{singular:'Resource item',plural:'Resources',list:'Scope list',icon:'fa-layer-group'},...defaults,...configured,...(category?{plural:category.name||'Untitled',icon:category.icon}:{} )};
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
    const id = cleanText(ref.id);
    return id ? { kind:cleanText(ref.kind || 'resource_group'), id, name:cleanText(ref.name) } : null;
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
    return window.FirstMateScopeData.scope(state.project||{},reportMeasurements());
  }
  function scopeMeasurements(){
    return window.FirstMateScopeData.measurements(state.project||{},state.lists,reportMeasurements());
  }
  function linkedScheduleEvent(list = state.activeList){
    const listId = cleanText(list?.id);
    const eventId = cleanText(list?.schedule_event_id || list?.delivery_event_id || list?.metadata?.schedule_event_id || list?.metadata?.delivery_event_id);
    const events = Array.isArray(state.project?.events) ? state.project.events : [];
    const event = events.find((event) => cleanText(event?.id) === eventId)
      || events.find((event) => cleanText(event?.scope_resource_list_id) === listId && !cleanText(event?.list_part_id))
      || null;
    const schedule = list?.schedule && typeof list.schedule === 'object' ? list.schedule : {};
    if (!event && !eventId && !cleanText(schedule.start_at || schedule.start || schedule.date)) return null;
    const startAt = cleanText(event?.start_at || event?.start || schedule.start_at || schedule.start || schedule.date);
    const endAt = cleanText(event?.end_at || event?.end || schedule.end_at || schedule.end);
    return {
      ...schedule,
      ...(event || {}),
      id: cleanText(event?.id || eventId || schedule.event_id),
      scope_resource_list_id: listId,
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
  function loadSuppliers(force = false){
    if (state.suppliersLoading || (state.suppliers && !force) || !window.MaterialsAPI?.suppliers?.list || !orgId()) return Promise.resolve(state.suppliers || []);
    state.suppliersLoading = true;
    return Promise.resolve(window.MaterialsAPI.suppliers.list(orgId())).then((result) => { state.suppliers = Array.isArray(result?.suppliers) ? result.suppliers : []; }).catch(() => { state.suppliers = state.suppliers || []; }).then(() => { state.suppliersLoading = false; return state.suppliers; });
  }
  // Everything an order can go to: each supplier itself (its default catalogue) and each of its locations.
  // Settings, Price Book, Suppliers, as an address that opens beside this project instead of replacing it.
  function supplierSettingsUrl(){
    try {
      const url = rootWindow.Portal?.navigation?.urlFor?.({ tab: 'company_settings', sub: 'pricebook', settingsView: 'suppliers', settingsEntity: '', project: '', projectTab: '' });
      return url?.href || String(url || '');
    } catch (_) { return ''; }
  }
  function supplierMark(supplier){
    const logo = cleanText(supplier?.logo);
    return logo ? `<img class="mt-supplier-mark" src="${escapeHtml(logo)}" alt="">` : '<i class="fas fa-store mt-supplier-mark" aria-hidden="true"></i>';
  }
  function supplierTargets(){
    return (state.suppliers || []).flatMap((supplier) => [
      { key: cleanText(supplier.id), supplier, location: null, name: cleanText(supplier.name), email: cleanText(supplier.order_email) },
      ...(supplier.locations || []).map((location) => ({ key: `${cleanText(supplier.id)}/${cleanText(location.id)}`, supplier, location, name: `${cleanText(supplier.name)} · ${cleanText(location.name)}`, email: cleanText(location.order_email || supplier.order_email) }))
    ]);
  }
  // A location answers from its own differences first, then from its supplier. Mirrors the backend resolution.
  function supplierOffer(target, itemId){
    const base = (target.supplier.offerings || []).find((row) => row.item_id === itemId) || null;
    const override = (target.location?.overrides || []).find((row) => row.item_id === itemId) || null;
    if (!(override?.carried ?? !!base)) return { carried: false, price_cents: null };
    return { carried: true, sku: override?.sku !== undefined ? override.sku : base?.sku || '', price_cents: override && Object.prototype.hasOwnProperty.call(override, 'price_cents') ? override.price_cents : base?.price_cents ?? null };
  }
  function orderableItems(list){
    return listItems(list).filter((item) => item.metadata?.delivery_fee !== true);
  }
  // Prices lists as one delivery from one supplier or location. A line that is not a price book item cannot be
  // matched to a catalogue and counts as not carried. Subtotal and total are unknown while any carried line is unpriced.
  function supplierQuote(target, lists, delivery = true){
    const missing = new Set(), unpriced = new Set(), prices = new Map();
    let subtotal = 0;
    lists.forEach((list) => orderableItems(list).forEach((item) => {
      const itemId = linePricebookItemId(item);
      const offer = itemId ? supplierOffer(target, itemId) : { carried: false, price_cents: null };
      if (!offer.carried) missing.add(item.id);
      else if (offer.price_cents == null) unpriced.add(item.id);
      else { prices.set(item.id, offer.price_cents); subtotal += Math.round(offer.price_cents * Math.max(0, number(item.quantity, 0))); }
    }));
    const fee = target.location?.delivery_fee || target.supplier.delivery_fee || null;
    const priced = !unpriced.size;
    const waived = !!fee && fee.free_above_cents != null && priced && subtotal >= fee.free_above_cents;
    const deliveryCents = !delivery || !fee || waived ? 0 : number(fee.amount_cents, 0);
    return { coversAll: !missing.size, missing, unpriced, prices, subtotal: priced ? subtotal : null, fee: fee ? number(fee.amount_cents, 0) : 0, waived, delivery: deliveryCents, total: priced ? subtotal + deliveryCents : null };
  }
  // The selected lists riding in the same delivery as this one.
  function orderDeliveryLists(list){
    const lead = orderGroupTarget(list) || list;
    return selectedOrderLists().filter((entry) => (orderGroupTarget(entry) || entry) === lead);
  }
  // The cheapest supplier or location that carries everything at known prices, delivery included.
  function bestSupplierTarget(lists){
    let best = null;
    supplierTargets().forEach((target) => {
      const quote = supplierQuote(target, lists, true);
      if (quote.coversAll && quote.total != null && (!best || quote.total < best.total)) best = { target, total: quote.total };
    });
    return best?.target || null;
  }
  // Who a list is ordered from. Grouped lists follow the list they are grouped with; nothing chosen means the cheapest full match.
  function orderSupplierChoice(list){
    const lead = orderGroupTarget(list) || list;
    const draft = scheduleDraftForList(lead);
    const delivery = draft.delivery !== false;
    if (cleanText(draft.supplier_email)) return { target: null, email: cleanText(draft.supplier_email), name: cleanText(draft.supplier_email), delivery };
    const chosen = draft.supplier_key ? supplierTargets().find((target) => target.key === draft.supplier_key) || null : null;
    const target = chosen || (draft.supplier_key == null ? bestSupplierTarget(orderDeliveryLists(lead)) : null);
    return { target, email: target?.email || '', name: target?.name || '', delivery };
  }
  // One supplier email per recipient.
  function orderSupplierGroups(lists = selectedOrderLists()){
    const groups = [];
    lists.forEach((list) => {
      const choice = orderSupplierChoice(list);
      const key = choice.target?.key || `email:${choice.email}`;
      let group = groups.find((entry) => entry.key === key);
      if (!group) groups.push(group = { key, choice, lists: [] });
      group.lists.push(list);
    });
    return groups;
  }
  // Delivery for a category's lists that have not been ordered yet, so rough costing includes it. The category is
  // priced as one delivery: the fee of the supplier that order would default to, or failing that the lowest fee among
  // suppliers carrying something on those lists. It is derived, never stored as a line; a placed order carries the
  // supplier's real fee in its own list instead. Switching it off is remembered on the category's lists.
  function projectedDelivery(type){
    const none = { available: false, enabled: false, amount: 0 };
    if (!type || type === 'labor' || !(state.suppliers || []).length) return none;
    const all = state.lists.filter((list) => resourceType(list) === type);
    const lists = all.filter((list) => !materialListOrdered(list) && listItems(list).length && !listItems(list).some((item) => item.metadata?.delivery_fee === true));
    if (!lists.length) return none;
    const count = lists.reduce((sum, list) => sum + listItems(list).length, 0);
    const best = bestSupplierTarget(lists);
    let cents = best ? supplierQuote(best, lists, true).delivery : 0;
    if (!best) supplierTargets().forEach((target) => {
      const quote = supplierQuote(target, lists, true);
      if (quote.missing.size < count && quote.fee > 0 && (!cents || quote.fee < cents)) cents = quote.fee;
    });
    if (!cents) return none;
    const enabled = !all.some((list) => list.metadata?.projected_delivery_disabled === true);
    return { available: true, enabled, amount: enabled ? cents / 100 : 0, estimate: cents / 100 };
  }
  // What a list is expected to cost: labor from the pay projection, everything else from its lines.
  function listProjected(list){
    // A labor list built from a pay sheet is worth its lines. One that is not still uses the older pay projection.
    const labor = resourceType(list) === 'labor' && !list?.metadata?.labor_generation ? expenseTargetForList(list) : null;
    return labor ? number(labor.projected_cents, 0) / 100 : listTotals(list).projected;
  }
  // A category's lists plus its projected delivery, and the same across every category.
  function categoryProjected(type, lists = state.lists.filter((list) => resourceType(list) === type)){
    return lists.reduce((sum, list) => sum + listProjected(list), 0) + projectedDelivery(type).amount;
  }
  function projectProjected(){
    return state.lists.reduce((sum, list) => sum + listProjected(list), 0) + [...new Set(state.lists.map((list) => resourceType(list)))].reduce((sum, type) => sum + projectedDelivery(type).amount, 0);
  }
  const ORDER_TIME_PRESETS = ['First thing in the morning', 'Morning (8am - 12pm)', 'Midday (11am - 1pm)', 'Afternoon (12pm - 4pm)', 'End of day', 'Any time'];
  // "9", "9am", "9:30 pm" or "14:00" as HH:MM; anything else is a delivery window described in words.
  function orderTimeClock(value){
    const match = cleanText(value).toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!match) return '';
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    if (match[3] === 'pm' && hour < 12) hour += 12;
    if (match[3] === 'am' && hour === 12) hour = 0;
    return hour < 24 && minute < 60 ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : '';
  }
  // The selected list whose delivery this list has been grouped with, while that list still has a date of its own.
  function orderGroupTarget(list){
    const targetId = cleanText(scheduleDraftForList(list).group_with);
    const target = targetId && targetId !== cleanText(list?.id) ? materialListById(targetId) : null;
    const draft = target ? scheduleDraftForList(target) : null;
    return target && state.orderSelectedListIds.has(targetId) && cleanText(draft.date) && !cleanText(draft.group_with) ? target : null;
  }
  function orderSchedule(list){
    return scheduleDraftForList(orderGroupTarget(list) || list);
  }
  // Deliveries as the supplier sees them: grouped lists share one entry; lists that merely have the same date stay separate.
  function orderDeliveryGroups(lists = selectedOrderLists()){
    const groups = [];
    lists.forEach((list) => {
      const lead = orderGroupTarget(list) || list;
      let group = groups.find((entry) => entry.id === cleanText(lead.id));
      if (!group) groups.push(group = { id: cleanText(lead.id), lists: [], schedule: scheduleDraftForList(lead) });
      group.lists.push(list);
    });
    return groups;
  }
  function orderGroupTitle(group){
    const names = group.lists.map((list) => cleanText(list.title) || 'Materials');
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
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
      time: event?.all_day === false && parts.time && parts.time !== '00:00' ? new Date(parts.iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '',
      start: cleanText(event?.start_at || event?.start),
      end: cleanText(event?.end_at || event?.end),
      all_day: event?.all_day !== false,
      dirty: false
    };
  }
  function initializeOrderComposer(preferredListId = state.activeListId, options = {}){
    closeOrderSupplierMenu();
    loadSuppliers(true).then(() => { if (materialRoot()?.querySelector?.('[data-mt-order-dialog]')?.open) { captureOrderDraft(materialRoot().querySelector('[data-mt-order-dialog]')); state.orderDraftFresh = true; syncOrderDialog(true); } });
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
    return true;
  }
  function projectFromContext(context = {}){
    return context.project || context.activeProject || context.projectModel?.state?.activeBaseProject || state.project || null;
  }

  function css(){
    return `
      .mt-app{height:100%;min-height:0;display:flex;flex-direction:column;background:#f7f8fb;color:#111827;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;container-type:inline-size;container-name:materials-workspace}
      .r-overlay.materials-workspace #mtSidebarSection.visible{min-height:0}
      .r-overlay.materials-workspace .r-tab-sidebar.mt-widget-sidebar{display:flex;flex-direction:column;box-sizing:border-box;flex:0 0 var(--scope-sidebar-width,33.333%)!important;width:var(--scope-sidebar-width,33.333%);min-width:0;max-width:none;min-height:0;padding:0;overflow:hidden}
      .r-overlay.materials-workspace #mtSidebarList{height:100%;flex:1;min-height:0;gap:0;overflow:hidden;display:flex;flex-direction:column}
      .mt-widget-sidebar .mt-left{height:auto;min-height:0;display:flex;flex-direction:column;gap:12px;padding:0}
      @media(max-width:850px){
        .r-overlay.materials-workspace :has(> .r-tab-sidebar.mt-widget-sidebar){flex-direction:column!important;min-width:0;min-height:0}
        .r-overlay.materials-workspace .r-tab-sidebar.mt-widget-sidebar{width:100%;min-width:0;flex:0 0 34vh!important;max-height:34vh}
        .r-overlay.materials-workspace :has(> .r-tab-sidebar.mt-widget-sidebar) > .r-tab-main{width:100%;min-width:0;min-height:0;flex:1}
      }
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
      .mt-main{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;padding:10px;display:flex;flex-direction:column;gap:10px}
      .mt-toolbar{display:grid;grid-template-columns:minmax(180px,1fr) auto;gap:10px;align-items:center}
      .mt-search{width:100%;border:1px solid rgba(15,23,42,.12);border-radius:8px;padding:9px 11px;font-size:12px;font-weight:800;outline:none;background:#fff}
      .mt-search:focus,.mt-input:focus,.mt-select:focus{border-color:rgba(var(--primary-rgb,217,48,37),.36);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.1)}
      .mt-section-tabs{display:flex;align-items:center;gap:7px;overflow:auto;scrollbar-width:none}
      .mt-section-tabs::-webkit-scrollbar{display:none}
      .mt-section-tab{border:1px solid transparent;background:transparent;color:#667085;min-height:32px;padding:6px 9px;border-radius:8px;font-size:11px;font-weight:950;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer}
      .mt-section-tab.active{background:#fff;border-color:rgba(15,23,42,.1);color:#101828;box-shadow:0 5px 14px rgba(15,23,42,.06)}
      .mt-material-grid{overflow-x:auto;display:flex;gap:0;height:100%;min-height:0;align-items:stretch}
      .mt-resource-column{flex:var(--column-weight,1) 1 0;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;border:1px solid #e4e7ec;border-radius:8px;background:#fff}
      
      .mt-resource-heading{display:flex;align-items:center;gap:4px}.mt-resource-heading>input{flex:1;min-width:0;width:0;font:inherit;color:inherit;border:0;background:transparent;padding:2px}.mt-resource-heading input::placeholder,.mt-list-head input::placeholder{color:#98a2b3;font-style:italic}.mt-resource-heading>button{color:var(--resource-color);flex:none}.mt-category-tools{display:flex;gap:2px}.mt-category-tools button{padding:3px;border:0;background:transparent;color:#667085;cursor:pointer;font-size:10px}.mt-category-tools button:hover{color:var(--resource-color)}.mt-category-tools button i+i{font-size:7px;margin-left:2px}.mt-list-head>input{flex:1;min-width:0;width:0;border:0;background:transparent;font:inherit;color:inherit;padding:2px}.mt-material-grid:has(.mt-resource-column~.mt-resource-column~.mt-resource-column~.mt-resource-column)>.mt-resource-column{flex:var(--column-weight,1) 0 210px}.mt-resource-tool{float:right;border:0;background:transparent;color:#536c8e;cursor:pointer;padding:0 2px}.mt-resource-heading{margin:0;padding:9px;font-size:12px;border-bottom:1px solid #e4e7ec;white-space:nowrap}
      .mt-resource-scroll{flex:1;min-height:0;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:8px}
      .mt-resource-scroll .mt-section{flex-shrink:0;min-width:350px}
      .mt-resource-add{margin:6px;padding:7px;border:1px dashed #d0d5dd;border-radius:6px;background:#fff;color:#475467;cursor:pointer;font-size:11px;text-align:left}
      .mt-resource-column[data-empty="true"] .mt-resource-add{white-space:normal}
      .mt-resource-scroll .mt-empty{padding:12px 2px}
      .sw-viewport{position:relative;flex:1;min-height:0;overflow:hidden}.sw-panel{position:absolute;inset:0;overflow:hidden}.sw-viewport>.sw-panel.fm-widget{position:absolute;inset:0;height:100%;min-height:0;aspect-ratio:auto}.sw-docs{height:100%;min-height:0;display:flex;flex-direction:column;background:#f7f9fc}.sw-doc-viewer.sw-detail{flex:1 1 0;height:auto;min-height:0}.sw-doc-viewer.sw-detail h2{font-size:16px;margin:2px 0 4px}.sw-doc-viewer .sw-total{font-size:15px}.sw-doc-viewer .sw-document-stage{margin-top:10px;border:1px solid #e4e9ef;border-radius:6px}.sw-doc-viewer.sw-detail section{margin-top:16px}.sw-doc-strip{flex:none;display:flex;align-items:center;gap:8px;min-height:62px;box-sizing:border-box;overflow-x:auto;scrollbar-width:thin;padding:8px 12px;border-top:1px solid #d5deeb;background:#f8fafc}.sw-doc-strip-empty{margin:auto;font-size:12px;color:#98a2b3}.sw-doc-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;color:#667085;font-size:12px}.sw-doc-empty i{font-size:28px;color:#c0c8d4}.sw-doc-empty strong{font-size:13px;color:#475467}.sw-doc-thumb{flex:0 0 auto;max-width:230px;display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid #cbd8ec;border-radius:8px;background:#fff;color:#243956;text-align:left;cursor:pointer}.sw-doc-thumb:hover{border-color:#98a2b3}.sw-doc-thumb[aria-pressed=true]{border-color:var(--primary,#d93025);box-shadow:0 0 0 1px var(--primary,#d93025)}.sw-doc-thumb i{color:#4879cb}.sw-doc-thumb span{min-width:0}.sw-doc-thumb strong,.sw-doc-thumb small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sw-doc-thumb strong{font-size:12px}.sw-doc-thumb small{margin-top:1px;font-size:10px;color:#667085}.sw-panel[hidden]{display:none}.sw-tabs{display:flex;flex:0 0 36px;gap:0;border-top:1px solid #d5deeb;background:#fff}.sw-tabs button{flex:1;min-width:0;border:0;border-radius:0;background:none;cursor:pointer;color:#62718a;display:flex;align-items:center;justify-content:center;gap:6px;font-size:10px;padding:6px 2px}.sw-tabs button[aria-selected=true]{color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.1);box-shadow:inset 0 -2px var(--primary,#d93025)}.sw-tabs i{font-size:13px}.sw-tabs button:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:-2px}.sw-home,.sw-detail{height:100%;overflow:auto;padding:12px;box-sizing:border-box;color:#263349;background:#f7f9fc}
      .sw-home section+section,.sw-detail section{margin-top:24px}.sw-home h3,.sw-detail h3{font-size:13px;letter-spacing:.02em;margin:0 0 12px;color:#475467}
      .sw-summary{display:flex;flex-direction:column;gap:6px;margin:16px 0}.sw-summary strong,.sw-total{font-size:21px;color:#172f50}.sw-summary span,.sw-tile-footer{font-size:11px;color:#52647e;line-height:1.5}.sw-tile-footer{display:flex;justify-content:space-between;gap:8px;margin-top:14px}
      .sw-empty{font-size:12px;line-height:1.6;color:#667085}

      .mt-workspace-header{display:flex;align-items:center;gap:8px;flex:0 0 auto;min-height:26px}.mt-workspace-actions{flex:none;display:flex;align-items:center;gap:6px;margin-left:auto}.mt-workspace-actions button{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
      .mt-icon-toggles{align-self:stretch;display:inline-flex;align-items:stretch;gap:3px}.mt-workspace-actions .mt-icon-toggles button{width:30px;min-height:26px;padding:0;justify-content:center}.mt-column-divider{flex:0 0 10px;align-self:stretch;position:relative;padding:0;border:0;background:transparent;cursor:col-resize;touch-action:none}.mt-column-divider::after{content:'';position:absolute;top:8px;bottom:8px;left:4px;width:2px;border-radius:2px;background:transparent;transition:background .12s}.mt-column-divider:hover::after,.mt-column-divider:focus-visible::after,.mt-column-divider.is-dragging::after{background:var(--primary,#d93025)}.mt-column-divider:focus-visible{outline:none}.mt-minimize-ghost{position:fixed;z-index:2147482650;box-sizing:border-box;display:flex;overflow:hidden;border-radius:8px;box-shadow:0 12px 32px rgba(15,23,42,.2);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827;pointer-events:none;transform-origin:0 0;will-change:transform,opacity;animation:mt-suck-in .24s linear forwards}.mt-minimize-ghost.is-restoring{animation:mt-suck-out .36s cubic-bezier(.15,.65,.3,1) forwards}.mt-minimize-ghost>.mt-resource-column{flex:1 1 auto!important;width:100%;height:100%}@keyframes mt-suck-in{to{transform:translate(var(--dx),var(--dy)) scale(var(--sx),var(--sy));opacity:.15}}@keyframes mt-suck-out{from{transform:translate(var(--dx),var(--dy)) scale(var(--sx),var(--sy));opacity:.15}to{transform:none;opacity:1}}@keyframes mt-tab-pop{from{transform:scale(1.2)}to{transform:scale(1)}}.mt-collapsed-pills button[data-mt-restore-type]{border-color:color-mix(in srgb,var(--tab-color,#667085) 35%,#fff);background:color-mix(in srgb,var(--tab-color,#667085) 10%,#fff);color:color-mix(in srgb,var(--tab-color,#667085) 85%,#101828)}.mt-collapsed-pills button[data-mt-restore-type] i{color:var(--tab-color,#667085)}.mt-collapsed-pills button.is-receiving{animation:mt-tab-pop .24s ease-out}.mt-workspace-header button,.mt-list-head button{border:1px solid #d0d5dd;border-radius:6px;background:#fff;padding:6px 9px;font-size:11px;color:#475467;cursor:pointer}.mt-collapsed-pills{display:flex;flex-wrap:wrap;gap:6px;flex:1;min-width:0}.mt-collapsed-pills button{border-radius:20px;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025))}.mt-list-pane{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows .22s ease,opacity .22s ease;flex-shrink:0}.mt-list-pane.is-collapsing{grid-template-rows:0fr;opacity:0}.mt-list-pane-inner{min-height:0;overflow:hidden}.mt-list-head{display:flex;align-items:center;gap:5px;padding:8px 2px}.mt-list-head strong{flex:1;font-size:12px;overflow-wrap:anywhere}.mt-list-head button{padding:4px 6px}.mt-list-pane .mt-list-secondary{margin-bottom:8px}.mt-list-pane .mt-section{min-width:350px}.mt-list-add-item{margin:8px 0}.mt-resource-scroll>.mt-list-pane{min-width:0}@media(prefers-reduced-motion:reduce){.mt-list-pane{transition:none}}
      .sw-back{border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:8px 12px;cursor:pointer;margin-bottom:20px;color:#263349}.sw-detail h2{font-size:22px;line-height:1.3;margin:8px 0 16px;overflow-wrap:anywhere}.sw-detail header>small{color:#52739a}.sw-detail header p{font-size:12px;color:#667085}
      .sw-table-wrap{overflow:auto}.sw-detail table{border-collapse:collapse;width:100%;font-size:12px;background:#fff}.sw-detail th{text-align:left;color:#667085;background:#eff3f8;font-size:11px}.sw-detail td,.sw-detail th{padding:10px;border-bottom:1px solid #e4e9ef;vertical-align:top}.sw-detail td small,.sw-source-id{display:block;font-size:10px;color:#667085;margin-top:4px;overflow-wrap:anywhere}.sw-document-stage{width:100%;min-height:120px;overflow:hidden;background:white}.sw-list-tools{margin-top:24px;font-size:12px}.sw-list-tools>summary{cursor:pointer;padding:10px 0;color:#52647e}

      .mt-scope-divider{flex:0 0 8px;width:8px;padding:0;border:0;background:transparent;cursor:col-resize;touch-action:none;position:relative}
      .mt-scope-divider:after{content:"";position:absolute;left:3px;top:0;bottom:0;width:2px;background:#e4e7ec}
      .mt-scope-divider:hover:after,.mt-scope-divider:focus-visible:after{background:var(--primary,#d93025)}
      @media(max-width:850px){.mt-scope-divider{display:none}}
      .mt-material-scroll{flex:1;min-height:0;overflow:hidden}
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

      .mt-resource-column{container:resource-column / inline-size}
      .mt-workspace-header button{padding:4px 8px}
      .mt-resource-column .mt-resource-heading{padding:6px 8px}
      .mt-resource-column .mt-resource-scroll{overflow-x:hidden;padding:4px 6px 6px;gap:6px}
      .mt-resource-column .mt-section{min-width:0;border:0;border-radius:0;background:transparent;box-shadow:none;overflow:visible}
      .mt-resource-column .mt-list-head{box-sizing:border-box;min-height:24px;gap:1px;padding:2px;border-radius:4px;background:#f2f4f7}
      .mt-resource-column .mt-list-pane.is-drop-target .mt-list-head{box-shadow:inset 0 0 0 1px var(--primary,#d93025)}
      .mt-resource-column .mt-list-head button{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:#667085;font-size:10px}
      .mt-resource-column .mt-list-head button:hover:not(:disabled){background:#e4e7ec;color:#344054}
      .mt-resource-column .mt-list-head button:disabled{opacity:.4;cursor:default}
      .mt-resource-column .mt-list-head button.is-done{color:#067647}
      .mt-resource-column .mt-list-head input{height:20px;padding:0 2px;font-size:11px;font-weight:700;text-overflow:ellipsis}
      .mt-resource-column .mt-list-head .mt-list-secondary{display:contents}
      .mt-list-total{flex:none;padding:0 3px;font-size:11px;font-variant-numeric:tabular-nums;color:#475467}
      .mt-list-tools{display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding:3px 0 1px}
      .mt-resource-column .mt-list-tools .mt-list-secondary{flex:0 1 auto;flex-wrap:wrap;gap:4px;min-height:0;margin:0;padding:0;border:0;background:transparent}
      .mt-resource-column .mt-list-tools .mt-list-secondary button{display:inline-flex;align-items:center;gap:4px;height:22px;min-height:22px;padding:0 7px;border-color:#e4e7ec;border-radius:4px;font-size:10px;font-weight:600}
      .mt-resource-column .mt-list-head button.mt-labor-assign{flex:0 1 auto;width:auto;min-width:0;max-width:55%;gap:4px;padding:0 5px;border:1px solid #d0d5dd;background:#fff;color:#344054;font-size:10px;font-weight:600}
      .mt-resource-column .mt-list-head button.mt-labor-assign.is-empty{border-style:dashed;color:#667085;font-weight:500}
      .mt-labor-assign span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mt-labor-assign i{font-size:7px;color:#98a2b3}
      .mt-labor-portal{position:fixed;z-index:2147482601;box-sizing:border-box;width:300px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;padding:8px;border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#fff;box-shadow:0 16px 38px rgba(15,23,42,.2);color:#344054;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
      .mt-labor-menu-title{padding:6px 4px 4px;font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#98a2b3}
      .mt-labor-options{display:flex;flex-direction:column;gap:1px;max-height:220px;overflow:auto}
      .mt-labor-portal.mt-assignment-portal{width:560px;display:flex;flex-direction:column;overflow:hidden}
      .mt-assignment-portal .mt-labor-options{max-height:none;min-height:0;overflow:auto;overscroll-behavior:contain}
      .mt-assignment-portal .mt-labor-menu-title,.mt-assignment-portal .mt-labor-regenerate,.mt-assignment-empty{flex-shrink:0}
      .mt-assignment-empty{padding:12px;color:#667085;font-size:12px}
      .mt-labor-option{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:6px;background:#fff;text-align:left;color:inherit;cursor:pointer}
      .mt-labor-option:hover{background:#f2f4f7}.mt-labor-option.active{background:rgba(var(--primary-rgb,217,48,37),.07)}
      .mt-labor-option span{min-width:0}.mt-labor-option strong,.mt-labor-option small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mt-labor-option strong{font-size:12px;font-weight:600;color:#101828}.mt-labor-option small{margin-top:1px;font-size:10px;color:#667085}
      .mt-labor-option i{color:var(--primary-readable,var(--primary,#d93025));font-size:10px}
      .mt-labor-pay{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
      .mt-labor-chips{display:flex;flex-wrap:wrap;gap:4px;padding:0 4px}
      .mt-labor-chips button{height:24px;padding:0 8px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;font-size:10px;font-weight:500;cursor:pointer}
      .mt-labor-chips button:hover{border-color:#98a2b3}
      .mt-labor-chips button.active{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025));font-weight:600}
      .mt-labor-hours{flex:none;display:flex;align-items:center;gap:4px;font-size:10px;color:#667085;white-space:nowrap}
      .mt-labor-hours input{width:46px;height:24px;box-sizing:border-box;padding:0 5px;border:1px solid #d0d5dd;border-radius:6px;font:inherit;font-size:11px;text-align:right;color:#101828}
      .mt-labor-regenerate{display:flex;align-items:center;gap:6px;width:100%;margin-top:8px;padding:7px 8px;border:0;border-top:1px solid #eaecf0;border-radius:0 0 6px 6px;background:#fff;color:#475467;font-size:11px;cursor:pointer}
      .mt-labor-regenerate:hover{background:#f2f4f7}
      .mt-resource-column .mt-section-label{padding:4px 0 1px 2px;font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#98a2b3}
      .mt-resource-column .mt-table,.mt-resource-column .mt-table tbody{display:block;width:100%}
      .mt-resource-column .mt-table colgroup,.mt-resource-column .mt-table thead{display:none}
      .mt-resource-column .mt-table tr.mt-list-row{box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:0 2px;min-height:24px;border-bottom:1px solid #f0f2f5;background:none}
      .mt-resource-column .mt-table tr.mt-list-row:hover,.mt-resource-column .mt-table tr.mt-list-row:focus-within{background:#f9fafb}
      .mt-resource-column .mt-table tr.mt-list-row.is-dragging{opacity:.4}
      .mt-resource-column .mt-table tr.mt-list-row.drop-before{box-shadow:inset 0 2px 0 var(--primary,#d93025)}
      .mt-resource-column .mt-table tr.mt-list-row.drop-after{box-shadow:inset 0 -2px 0 var(--primary,#d93025)}
      .mt-resource-column .mt-table tr.mt-list-row td{display:block;flex:none;min-width:0;padding:0;border:0;text-align:left;font-size:11px;white-space:nowrap}
      .mt-resource-column .mt-table tr.mt-list-row td.mt-c-name{flex:1 1 0}
      .mt-drag{display:flex;align-items:center;justify-content:center;width:9px;height:22px;color:#c0c5cf;font-size:9px;cursor:grab;touch-action:none}
      .mt-drag:hover,.mt-drag:focus-visible,.mt-drag[aria-expanded=true]{color:#475467}
      .mt-drag:active{cursor:grabbing}
      .mt-resource-column .mt-cell-input{box-sizing:border-box;height:20px;min-height:20px;min-width:0!important;padding:0 3px;border:1px solid transparent;border-radius:3px;background:transparent;font-size:11px;font-weight:500;text-overflow:ellipsis}
      .mt-resource-column .mt-cell-input:hover:not(:disabled){border-color:#d0d5dd;background:#fff}
      .mt-resource-column .mt-cell-input:focus{border:1px solid var(--primary,#d93025)!important;box-shadow:none!important;background:#fff}
      .mt-resource-column .mt-line-name{width:100%;padding:0 2px;font-weight:600}
      .mt-resource-column input.mt-number{appearance:textfield;-moz-appearance:textfield;text-align:right;font-variant-numeric:tabular-nums}
      .mt-resource-column input.mt-number::-webkit-inner-spin-button,.mt-resource-column input.mt-number::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
      .mt-resource-column .mt-c-qty .mt-cell-input,.mt-resource-column .mt-c-price .mt-cell-input{background:#f2f4f7}
      .mt-resource-column .mt-c-unit .mt-cell-input{padding:0 1px;color:#667085}
      .mt-resource-column .mt-c-price{display:flex;align-items:center;gap:2px;font-size:10px;color:#667085}
      .mt-resource-column .mt-c-price>span::after{content:' $';color:#98a2b3}
      .mt-resource-column .mt-c-meta{display:flex;align-items:center;gap:5px;min-width:0;max-width:100%}
      .mt-resource-column .mt-c-meta:empty{display:none}
      .mt-resource-column .mt-c-meta>span{overflow:hidden;text-overflow:ellipsis;font-size:10px;color:#98a2b3}
      .mt-resource-column .mt-c-meta select{display:block;width:auto;min-width:0;max-width:100%;height:20px;min-height:20px;padding:0;border:0;border-radius:3px;background:transparent;color:#667085;font-size:10px;font-weight:500;text-overflow:ellipsis;cursor:pointer}
      .mt-resource-column .mt-table tr.mt-list-row td.mt-c-color{display:flex}
      .mt-resource-column .mt-table tr.mt-list-row td.mt-c-color:has(>.mt-small){display:none}
      .mt-resource-column .mt-color-swatch{width:12px;height:12px;border-radius:3px}
      .mt-resource-column .mt-order-qty-cell{flex-direction:row;align-items:center;height:20px;padding:0 2px}
      .mt-resource-column .mt-order-qty-cell strong{font-size:11px;font-weight:500}
      .mt-resource-column .mt-c-unit .mt-order-qty-cell strong{color:#667085}
      .mt-resource-column .mt-order-qty-cell span{display:none}
      .mt-resource-column .mt-table tr.mt-list-row td.mt-c-total{min-width:7ch;padding:0 1px 0 3px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;color:#101828}
      .mt-expand{display:flex;align-items:center;justify-content:center;width:14px;height:20px;padding:0;border:0;border-radius:3px;background:transparent;color:#98a2b3;font-size:8px;cursor:pointer}
      .mt-expand:hover,.mt-expand:focus-visible{background:#e4e7ec;color:#344054}
      .mt-list-row.is-expanded .mt-expand i{transform:rotate(180deg)}
      .mt-resource-column .mt-table tr.mt-list-row td.mt-c-detail{display:none;flex:0 0 100%;box-sizing:border-box;align-items:center;flex-wrap:wrap;gap:2px 8px;padding:0 2px 3px 11px}
      .mt-resource-column .mt-table tr.mt-list-row.is-expanded td.mt-c-detail{display:flex}
      .mt-row-remove{display:inline-flex;align-items:center;gap:4px;height:20px;margin-left:auto;padding:0 6px;border:0;border-radius:3px;background:transparent;color:#667085;font-size:10px;cursor:pointer}
      .mt-row-remove:hover:not(:disabled),.mt-row-remove:focus-visible{color:#d92d20;background:#fef3f2}
      .mt-resource-column .mt-list-add-item{display:block;width:100%;margin:1px 0 0;padding:3px 4px 3px 11px;border:0;border-radius:4px;background:transparent;color:#667085;font-size:11px;text-align:left}
      .mt-resource-column .mt-list-add-item:hover:not(:disabled){background:#f2f4f7;color:var(--primary-readable,var(--primary,#d93025))}
      .mt-resource-column .mt-empty{padding:8px 2px;font-size:11px;font-weight:500}
      .mt-column-total{flex:none;padding:5px 9px;border-top:1px solid #e4e7ec;display:flex;justify-content:space-between;gap:5px;color:#475467;font-size:11px;background:#f9fafb}
      .mt-icon-dialog{border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054}.mt-icon-dialog::backdrop{background:rgba(15,23,42,.4)}
      .mt-project-notes{display:flex;flex-direction:column;gap:7px}.mt-note-compose{position:relative;display:flex;flex-direction:column;gap:6px}.mt-note-compose textarea{width:100%;min-height:68px;box-sizing:border-box;resize:vertical;border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:8px;font:inherit;font-size:11px;line-height:1.4;color:#344054}.mt-note-compose-foot{display:flex;align-items:center;justify-content:space-between;gap:6px}.mt-note-visibility{width:28px;height:28px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;color:#667085;cursor:pointer}.mt-note-save{border:0;border-radius:7px;background:#111827;color:#fff;height:28px;padding:0 9px;font-size:9px;font-weight:1000;cursor:pointer}.mt-note-visibility-pop{position:absolute;right:0;top:72px;z-index:2147483000;width:max-content;min-width:170px;min-height:34px;padding:5px;display:grid;grid-auto-rows:minmax(30px,auto);gap:2px;overflow:visible;border:1px solid rgba(15,23,42,.12);border-radius:9px;background:#fff;color:#344054;box-shadow:0 12px 32px rgba(15,23,42,.18)}.mt-note-visibility-pop[hidden]{display:none!important}.mt-note-visibility-pop button{width:100%;min-height:30px;border:0;border-radius:6px;background:#fff;padding:7px;display:flex;align-items:center;gap:7px;text-align:left;white-space:nowrap;font-size:10px;font-weight:900;color:#344054;cursor:pointer}.mt-note-visibility-pop button:hover{background:#f2f4f7}.mt-note-list{display:flex;flex-direction:column;gap:6px}.mt-note-card{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;padding:7px;display:flex;flex-direction:column;gap:5px}.mt-note-card p{margin:0;white-space:pre-wrap;font-size:10px;line-height:1.4;color:#344054}.mt-note-meta{display:flex;align-items:center;justify-content:space-between;gap:5px;color:#667085;font-size:8px;font-weight:850}.mt-note-meta>span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-note-actions{display:flex}.mt-note-actions button{width:20px;height:20px;border:0;background:transparent;color:#98a2b3;padding:0;cursor:pointer}.mt-note-empty{padding:8px;text-align:center;color:#98a2b3;font-size:9px;font-weight:850}
      dialog.mt-modal{border:0!important;padding:0!important;background:transparent!important;overflow:visible;max-width:none!important;max-height:none!important}dialog.mt-modal[open]{inset:0!important;width:100vw!important;height:100vh!important;margin:0!important;display:grid;place-items:center}dialog.mt-modal::backdrop{background:rgba(15,23,42,.48);backdrop-filter:blur(5px)}.mt-modal-backdrop-hit{position:absolute;inset:0;z-index:0}.mt-modal-shell{position:relative;z-index:1;background:#fff;border:1px solid rgba(15,23,42,.1);border-radius:16px;box-shadow:0 30px 90px rgba(15,23,42,.3);overflow:hidden}.mt-modal-head{min-height:62px;padding:13px 16px;border-bottom:1px solid #eaecf0;display:flex;align-items:center;justify-content:space-between;gap:14px}.mt-modal-title{display:flex;align-items:center;gap:10px;min-width:0}.mt-modal-title i{width:34px;height:34px;border-radius:10px;background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025));display:grid;place-items:center}.mt-modal-title strong{display:block;font-size:15px;font-weight:1000;color:#101828}.mt-modal-title span{display:block;margin-top:2px;font-size:10px;font-weight:850;color:#667085}.mt-modal-close{width:34px;height:34px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#475467;cursor:pointer}.mt-modal-foot{padding:12px 16px;border-top:1px solid #eaecf0;display:flex;align-items:center;justify-content:space-between;gap:10px;background:#f8fafc}
      .mt-new-list-modal{width:min(470px,calc(100vw - 28px))}.mt-new-list-body{padding:16px;display:grid;gap:13px}.mt-color-field{display:grid;grid-template-columns:44px minmax(0,1fr);gap:9px}.mt-color-field input[type="color"]{width:44px;height:38px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:3px}
      .mt-order-modal{width:min(1120px,calc(100vw - 28px));height:min(720px,calc(100vh - 28px));display:grid;grid-template-rows:auto minmax(0,1fr) auto}.mt-order-layout{min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr)}.mt-order-providers{padding:0 16px;border-bottom:1px solid #eaecf0;background:#f8fafc;display:flex;align-items:stretch;gap:4px;overflow-x:auto}.mt-provider{width:auto;min-width:150px;border:0;border-bottom:3px solid transparent;background:transparent;padding:9px 12px 8px;text-align:left;color:#344054;cursor:pointer;display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px;align-items:center}.mt-provider i{width:28px;height:28px;border-radius:8px;background:#fff;border:1px solid #e4e7ec;display:grid;place-items:center}.mt-provider strong{display:block;font-size:11px;font-weight:1000}.mt-provider span{display:block;margin-top:2px;font-size:9px;font-weight:850;color:#98a2b3}.mt-provider:hover{background:rgba(255,255,255,.7)}.mt-provider.active{background:#fff;border-bottom-color:var(--primary-readable,var(--primary,#d93025));color:var(--primary-readable,var(--primary,#d93025))}.mt-order-content{min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:13px}.mt-order-content.manual{overflow:hidden;display:grid;grid-template-columns:minmax(280px,.72fr) minmax(0,1.28fr);gap:16px}.mt-order-details{min-width:0;min-height:0;overflow:auto;padding-right:2px;display:flex;flex-direction:column;gap:13px}.mt-order-coming{height:100%;min-height:280px;display:grid;place-items:center;text-align:center;color:#667085}.mt-order-coming i{font-size:30px;color:#98a2b3}.mt-order-coming strong{display:block;margin-top:10px;font-size:15px;color:#344054}.mt-order-summary{display:grid;grid-template-columns:1fr;gap:8px}.mt-order-summary > div{border:1px solid #eaecf0;border-radius:9px;padding:9px;background:#f8fafc}.mt-order-summary span{display:block;font-size:9px;font-weight:1000;color:#667085;text-transform:uppercase}.mt-order-summary strong{display:block;margin-top:4px;font-size:12px;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-email-preview{min-width:0;min-height:0;border:1px solid #d0d5dd;border-radius:11px;background:#fff;overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr)}.mt-email-preview-head{padding:10px 12px;border-bottom:1px solid #eaecf0;background:#f8fafc;display:flex;align-items:center;justify-content:space-between;gap:10px}.mt-email-preview-head strong{min-width:0;font-size:11px;color:#344054;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-email-copy{flex:0 0 auto;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;height:32px;padding:0 10px;font-size:10px;font-weight:1000;display:inline-flex;align-items:center;gap:6px;cursor:pointer;transition:.16s ease}.mt-email-copy.copied{border-color:#75e0a7;background:#ecfdf3;color:#067647}.mt-email-copy.failed{border-color:#fda29b;background:#fef3f2;color:#b42318}.mt-email-body{min-height:0;overflow:auto;padding:12px;font-size:11px;line-height:1.5;color:#344054}.mt-email-body p{margin:0 0 10px}.mt-order-table{width:100%;border-collapse:collapse}.mt-order-table th,.mt-order-table td{border:1px solid #e4e7ec;padding:7px;text-align:left;font-size:10px;vertical-align:top}.mt-order-table th{background:#f8fafc;color:#667085;text-transform:uppercase}.mt-order-table th:nth-child(1){width:35%}.mt-order-table th:nth-child(2){width:35%}.mt-order-table td:nth-child(3),.mt-order-table td:nth-child(4){white-space:nowrap}.mt-order-detail{display:block}.mt-order-detail+.mt-order-detail{margin-top:2px}.mt-order-detail strong{font-size:9px;color:#667085}.mt-order-lock-note{display:flex;align-items:flex-start;gap:8px;border:1px solid #fedf89;border-radius:9px;background:#fffaeb;color:#93370d;padding:9px;font-size:10px;font-weight:850;line-height:1.4}.mt-order-lock-note.ordered{border-color:#abefc6;background:#ecfdf3;color:#067647}
      .mt-order-modal{width:min(1440px,calc(100vw - 48px));height:calc(100vh - 48px);max-height:920px}.mt-order-layout{grid-template-rows:auto auto minmax(0,1fr)}.mt-order-workflow-tabs{min-height:44px;padding:0 16px;border-bottom:1px solid #eaecf0;background:#fff;display:flex;align-items:end;gap:18px}.mt-order-workflow-tabs button{height:44px;border:0;border-bottom:2px solid transparent;background:transparent;color:#667085;padding:0 2px;display:flex;align-items:center;gap:7px;font-size:11px;font-weight:950;cursor:pointer}.mt-order-workflow-tabs button.active{border-bottom-color:#101828;color:#101828}.mt-order-workflow-tabs .required{border-radius:999px;background:#fff3e0;color:#b54708;padding:2px 6px;font-size:8px;text-transform:uppercase}.mt-order-workflow-tabs .complete{width:17px;height:17px;border-radius:999px;background:#ecfdf3;color:#067647;display:grid;place-items:center;font-size:8px}.mt-order-section-head{display:flex;align-items:end;justify-content:space-between;gap:8px}.mt-order-section-head>div span{display:block;font-size:9px;font-weight:1000;color:#667085;text-transform:uppercase}.mt-order-section-head>div strong{display:block;margin-top:2px;font-size:12px;color:#101828}.mt-order-section-head>span{font-size:9px;color:#98a2b3}.mt-order-list-picker{display:flex;flex-direction:column;gap:7px}.mt-order-list-options{display:flex;flex-direction:column;gap:5px}.mt-order-list-option{min-width:0;border:1px solid #e4e7ec;border-radius:9px;background:#fff;padding:7px 8px;display:grid;grid-template-columns:18px 9px minmax(0,1fr) auto;align-items:center;gap:7px;cursor:pointer}.mt-order-list-option.selected{border-color:rgba(var(--primary-rgb,217,48,37),.3);background:rgba(var(--primary-rgb,217,48,37),.035)}.mt-order-list-option input{position:absolute;opacity:0;pointer-events:none}.mt-order-list-check{width:16px;height:16px;border:1px solid #d0d5dd;border-radius:5px;background:#fff;color:transparent;display:grid;place-items:center;font-size:8px}.mt-order-list-option.selected .mt-order-list-check{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}.mt-order-list-option>span:nth-of-type(3){min-width:0}.mt-order-list-option strong{display:block;font-size:10px;color:#344054;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-order-list-option small{display:block;margin-top:2px;font-size:8px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-order-list-option em{font-style:normal;font-size:8px;font-weight:950;color:#667085;white-space:nowrap}.mt-order-list-option em.ordered{color:#067647}.mt-request-list-dot{width:9px;height:9px;border-radius:999px;background:var(--list-color,#667085);box-shadow:0 0 0 2px color-mix(in srgb,var(--list-color,#667085) 15%,transparent)}.mt-order-summary>button{width:100%;border:1px solid #eaecf0;border-radius:9px;padding:9px;background:#f8fafc;display:grid;grid-template-columns:minmax(0,1fr) auto;text-align:left;cursor:pointer}.mt-order-summary>button span,.mt-order-summary>button strong{grid-column:1}.mt-order-summary>button i{grid-column:2;grid-row:1 / span 2;align-self:center;color:#98a2b3}.mt-request-group{margin:12px 0 18px}.mt-request-delivery{border-radius:8px 8px 0 0;background:#f2f4f7;color:#344054;padding:8px 10px;display:flex;align-items:center;gap:7px}.mt-request-delivery strong{font-size:10px}.mt-request-list-head{padding:8px 2px 6px;display:grid;grid-template-columns:9px minmax(0,1fr) auto;align-items:center;gap:7px}.mt-request-list-head strong{font-size:11px}.mt-request-list-head>span:last-child{font-size:9px;color:#667085}.mt-order-content.schedule{overflow:hidden;display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1fr);gap:0;padding:0}.mt-order-schedule-side{min-height:0;overflow:auto;padding:16px;border-right:1px solid #eaecf0;background:#f8fafc;display:flex;flex-direction:column;gap:14px}.mt-order-schedule-tip{border:1px solid #d1e9ff;border-radius:9px;background:#eff8ff;color:#175cd3;padding:9px;display:flex;align-items:flex-start;gap:7px;font-size:9px;line-height:1.4}.mt-order-scheduler{min-width:0;min-height:0;overflow:auto;padding:18px 20px;background:#fff}.mt-order-scheduler-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.mt-order-scheduler-head span{display:block;font-size:9px;font-weight:1000;color:#667085;text-transform:uppercase}.mt-order-scheduler-head strong{display:block;margin-top:3px;font-size:15px;color:#101828}.mt-order-scheduler-head button{border:0;background:transparent;color:#475467;font-size:10px;font-weight:950;cursor:pointer}.mt-order-timing-choices{margin-top:16px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.mt-order-timing-choices>button{min-height:72px;border:1px solid #d0d5dd;border-radius:11px;background:#fff;color:#475467;padding:12px;text-align:left;display:grid;grid-template-columns:30px minmax(0,1fr);gap:10px;align-items:center;cursor:pointer}.mt-order-timing-choices>button>i{width:30px;height:30px;border-radius:9px;background:#f2f4f7;display:grid;place-items:center}.mt-order-timing-choices>button strong,.mt-order-timing-choices>button small{display:block}.mt-order-timing-choices>button strong{font-size:11px;color:#344054}.mt-order-timing-choices>button small{margin-top:3px;font-size:9px;color:#667085}.mt-order-timing-choices>button.active{border-color:rgba(var(--primary-rgb,217,48,37),.38);background:rgba(var(--primary-rgb,217,48,37),.045);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.08)}.mt-order-timing-choices>button.active>i{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}.mt-order-schedule-mode{margin-top:16px;padding:3px;border:1px solid #e4e7ec;border-radius:9px;background:#f2f4f7;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px}.mt-order-schedule-mode button{height:32px;border:0;border-radius:7px;background:transparent;color:#667085;font-size:9px;font-weight:950;cursor:pointer}.mt-order-schedule-mode button.active{background:#fff;color:#101828;box-shadow:0 2px 6px rgba(15,23,42,.08)}.mt-order-schedule-cards{margin-top:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.mt-order-schedule-card{border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:12px;display:flex;flex-direction:column;gap:11px}.mt-order-schedule-card.shared{grid-column:1/-1}.mt-order-schedule-card-title{display:flex;align-items:center;gap:9px}.mt-order-schedule-card-title>i{width:30px;height:30px;border-radius:9px;background:#eff8ff;color:#175cd3;display:grid;place-items:center}.mt-order-schedule-card-title>div{min-width:0}.mt-order-schedule-card-title strong,.mt-order-schedule-card-title span{display:block}.mt-order-schedule-card-title strong{font-size:11px;color:#344054}.mt-order-schedule-card-title span{margin-top:2px;font-size:9px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-order-date-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.7fr);gap:8px}.mt-order-date-fields label>span{display:block;margin-bottom:4px;font-size:9px;font-weight:950;color:#475467}.mt-order-date-fields em{font-style:normal;color:#b54708}.mt-order-date-fields small{font-weight:800;color:#98a2b3}.mt-order-date-fields input{width:100%;box-sizing:border-box;height:36px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:0 9px;color:#344054;font:inherit;font-size:10px}.mt-order-no-dates,.mt-order-timing-empty{margin-top:18px;min-height:150px;border:1px dashed #d0d5dd;border-radius:11px;background:#f8fafc;color:#667085;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:18px}.mt-order-no-dates>i,.mt-order-timing-empty>i{font-size:24px;color:#98a2b3}.mt-order-no-dates strong,.mt-order-timing-empty strong{margin-top:9px;font-size:12px;color:#344054}.mt-order-no-dates p,.mt-order-timing-empty span{max-width:420px;margin:5px 0 0;font-size:10px;line-height:1.45}
      @container materials-workspace (max-width:900px){.mt-material-grid{grid-template-columns:none}.mt-toolbar{grid-template-columns:1fr}.mt-top{align-items:flex-start;flex-direction:column}.mt-top .mt-actions{justify-content:flex-start;width:100%}.mt-summary-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media (max-width:980px){.mt-material-grid{grid-template-columns:none}.mt-toolbar{grid-template-columns:1fr}.mt-summary-grid{grid-template-columns:1fr}.mt-form-grid{grid-template-columns:1fr}.mt-labor-breakdown{grid-template-columns:1fr}.mt-labor-breakdown-group+.mt-labor-breakdown-group{border-left:0;border-top:1px solid #eaecf0}.mt-top{align-items:flex-start;flex-direction:column}.mt-actions{justify-content:flex-start}.mt-order-content.manual{grid-template-columns:minmax(240px,.7fr) minmax(0,1.3fr)}.mt-order-content.schedule{grid-template-columns:240px minmax(0,1fr)}.mt-order-schedule-cards{grid-template-columns:1fr}.mt-order-modal{height:calc(100vh - 24px);width:calc(100vw - 24px)}}
      @media (max-width:720px){.mt-order-content.manual{overflow:auto;display:flex}.mt-order-details{overflow:visible}.mt-email-preview{min-height:360px;flex:0 0 auto}.mt-email-body{overflow:auto}.mt-provider{min-width:132px}.mt-order-content.schedule{overflow:auto;display:flex}.mt-order-schedule-side{overflow:visible;border-right:0;border-bottom:1px solid #eaecf0}.mt-order-scheduler{overflow:visible}.mt-order-timing-choices{grid-template-columns:1fr}.mt-order-schedule-mode{grid-template-columns:1fr}.mt-order-date-fields{grid-template-columns:1fr}}
      @media (max-width:620px){.mt-top{padding:10px}.mt-main{padding:10px}.mt-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));width:100%}.mt-actions .mt-icon-btn{width:100%}.mt-order-providers{padding:0 8px}.mt-provider{min-width:120px;padding-inline:8px}.mt-order-modal{width:calc(100vw - 12px);height:calc(100vh - 12px)}.mt-modal-foot{align-items:stretch;flex-direction:column-reverse}.mt-modal-foot .mt-actions{grid-template-columns:1fr 1fr}.mt-scope-measures{grid-template-columns:1fr 1fr}}
      .mt-order-layout{grid-template-rows:auto minmax(0,1fr)}.mt-order-content.manual{grid-template-columns:minmax(330px,.72fr) minmax(0,1.28fr);padding:14px;gap:14px}.mt-order-details{gap:11px}
      .mt-order-list-options{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(142px,1fr);grid-template-rows:1fr;gap:6px;overflow-x:auto;padding:3px 3px 7px;scrollbar-width:thin}.mt-order-list-option{appearance:none;width:100%;min-width:0;min-height:64px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#344054;padding:8px;display:grid;grid-template-columns:9px minmax(0,1fr);grid-template-rows:auto auto;align-items:center;gap:3px 7px;text-align:left;cursor:pointer}.mt-order-list-option>.mt-request-list-dot{grid-column:1;grid-row:1/span 2}.mt-order-list-option>span:nth-of-type(2){grid-column:2;grid-row:1;min-width:0}.mt-order-list-option>em{grid-column:2;grid-row:2;justify-self:start}.mt-order-list-option:hover{border-color:#b8c0cc;background:#f8fafc}.mt-order-list-option.selected{border-color:color-mix(in srgb,var(--primary,#d93025) 42%,#d0d5dd);background:color-mix(in srgb,var(--primary,#d93025) 5%,#fff);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--primary,#d93025) 12%,transparent)}.mt-order-list-option.focused{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.11)}.mt-order-list-picker.scheduling .mt-order-list-option:not(.focused){opacity:.78}.mt-order-section-head>button{border:0;background:transparent;color:#475467;padding:2px;font-size:9px;font-weight:950;cursor:pointer}.mt-order-section-head>button:hover{color:var(--primary-readable,var(--primary,#d93025))}
      .mt-order-delivery-choice{border:1px solid #e4e7ec;border-radius:11px;background:#f8fafc;padding:10px}.mt-required-pill{border-radius:999px;background:#fff3e0;color:#b54708!important;padding:3px 7px;font-size:8px!important;font-weight:1000;text-transform:uppercase}.mt-order-delivery-choice .mt-order-timing-choices{margin-top:8px;gap:7px}.mt-order-delivery-choice .mt-order-timing-choices>button{min-height:60px;padding:8px;grid-template-columns:26px minmax(0,1fr);gap:8px;border-radius:9px}.mt-order-delivery-choice .mt-order-timing-choices>button>i{width:26px;height:26px;border-radius:7px}.mt-order-delivery-choice .mt-order-timing-choices>button strong{font-size:10px}.mt-order-delivery-choice .mt-order-timing-choices>button small{font-size:8px}.mt-order-no-date-note{margin-top:8px;border-radius:8px;background:#fff;color:#667085;padding:8px;display:flex;align-items:flex-start;gap:7px;font-size:9px;line-height:1.4}.mt-order-no-date-note i{color:#175cd3;margin-top:1px}
      .mt-request-instructions{margin:12px 0 16px;border:1px solid #d1e9ff;border-radius:9px;background:#eff8ff;padding:10px;color:#1849a9}.mt-request-instructions>strong{font-size:10px}.mt-request-instructions ul{list-style:none;margin:7px 0 0;padding:0;display:grid;gap:7px}.mt-request-instructions li{display:grid;grid-template-columns:9px minmax(0,1fr);align-items:start;gap:7px;font-size:10px;line-height:1.45}.mt-request-instructions .mt-request-list-dot{margin-top:3px}.mt-request-list-instruction{margin:0 0 8px!important;border-left:3px solid #d0d5dd;padding:6px 8px;background:#f8fafc;color:#344054;font-weight:850}.mt-request-group{margin:15px 0 20px}.mt-request-list-head{padding-top:0}
      .mt-order-calendar-panel{min-width:0;min-height:0;border:1px solid #d0d5dd;border-radius:11px;background:#fff;overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr)}.mt-order-calendar-head{padding:10px 12px;border-bottom:1px solid #eaecf0;background:#f8fafc;display:flex;align-items:center;justify-content:space-between;gap:12px}.mt-order-calendar-head>div{min-width:0}.mt-order-calendar-head span,.mt-order-calendar-head strong,.mt-order-calendar-head small{display:block}.mt-order-calendar-head span{font-size:8px;font-weight:1000;color:#667085;text-transform:uppercase}.mt-order-calendar-head strong{margin-top:2px;font-size:13px;color:#101828}.mt-order-calendar-head small{margin-top:2px;font-size:9px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-order-calendar-head button{flex:0 0 auto;height:31px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;padding:0 9px;font-size:9px;font-weight:950;cursor:pointer}.mt-order-calendar{min-width:0;min-height:0;overflow:auto;background:#fff}.mt-order-calendar>.prs-wrap{min-height:100%;border:0;border-radius:0;box-shadow:none}.mt-order-calendar .prs-toolbar{position:sticky;top:0;z-index:8}.mt-order-calendar-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#667085}.mt-order-calendar-empty i{font-size:25px}.mt-order-calendar-empty strong{margin-top:8px;color:#344054}.mt-order-calendar-empty span{margin-top:4px;font-size:10px}
      .mt-order-content.manual.calendar-mode{padding:14px 0 0 14px;gap:14px}.mt-order-content.manual.calendar-mode .mt-order-details{padding-bottom:14px}.mt-order-calendar-panel{width:100%;max-width:100%;box-sizing:border-box;border-width:0 0 0 1px;border-radius:0}.mt-order-calendar-head{padding:13px 16px;box-sizing:border-box}.mt-order-calendar-head>div:first-child{flex:1 1 auto}.mt-order-calendar-actions{flex:0 0 auto;display:flex;align-items:center;gap:7px}.mt-order-calendar-head button.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:var(--on-primary,#fff)}.mt-order-calendar-head button:disabled{opacity:.5;cursor:not-allowed}.mt-order-calendar{width:100%;max-width:100%;box-sizing:border-box;overflow:hidden}.mt-order-calendar>.prs-wrap{width:100%;max-width:100%;min-width:0;box-sizing:border-box;gap:0}.mt-order-calendar .prs-toolbar{width:100%;max-width:100%;box-sizing:border-box;padding:10px 14px;background:#fff;border-bottom:1px solid #eaecf0}.mt-order-calendar .prs-surface{width:100%;max-width:100%;box-sizing:border-box;border:0;border-radius:0;box-shadow:none;overflow:auto;scrollbar-gutter:stable}.mt-order-calendar .prs-time-grid,.mt-order-calendar .prs-all-day-grid,.mt-order-calendar .prs-month{box-sizing:border-box}
      .mt-order-date-summary{margin-top:8px;display:grid;gap:5px}.mt-order-date-summary>div{min-width:0;border:1px solid #e4e7ec;border-radius:7px;background:#fff;padding:6px 8px;display:grid;grid-template-columns:minmax(80px,.65fr) minmax(0,1.35fr);gap:8px;align-items:center}.mt-order-date-summary strong{font-size:9px;color:#344054;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-order-date-summary span{font-size:8px;color:#667085;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-required-pill.ready{background:#ecfdf3;color:#067647!important}.mt-order-timing-actions{margin-top:8px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.mt-order-timing-actions>button{min-height:50px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#475467;padding:8px;text-align:left;display:grid;grid-template-columns:24px minmax(0,1fr);gap:7px;align-items:center;cursor:pointer}.mt-order-timing-actions>button>i{width:24px;height:24px;border-radius:7px;background:#f2f4f7;display:grid;place-items:center}.mt-order-timing-actions strong,.mt-order-timing-actions small{display:block}.mt-order-timing-actions strong{font-size:9px;color:#344054}.mt-order-timing-actions small{margin-top:2px;font-size:8px;color:#667085}.mt-order-text-action{margin-top:8px;border:0;background:transparent;color:#667085;padding:2px;font-size:9px;font-weight:950;cursor:pointer}.mt-order-schedule-targets{border:1px solid #d1e9ff;border-radius:10px;background:#eff8ff;padding:10px}.mt-order-target-options{margin-top:8px;display:flex;gap:6px;overflow-x:auto;padding:2px}.mt-order-target{flex:1 0 132px;min-width:132px;border:1px solid #b2ddff;border-radius:8px;background:#fff;color:#344054;padding:7px;display:grid;grid-template-columns:9px minmax(0,1fr);grid-template-rows:auto auto;gap:2px 7px;text-align:left;cursor:pointer}.mt-order-target>.mt-request-list-dot{grid-row:1/span 2;align-self:center}.mt-order-target>span:nth-of-type(2){min-width:0}.mt-order-target strong,.mt-order-target small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mt-order-target strong{font-size:9px}.mt-order-target small{margin-top:2px;font-size:8px;color:#667085}.mt-order-target em{grid-column:2;font-size:8px;font-style:normal;font-weight:950;color:#175cd3}.mt-order-target.active{border-color:#1570ef;background:#eff8ff;box-shadow:0 0 0 2px #d1e9ff}.mt-email-instruction-list{margin:0 0 16px;padding-left:20px}.mt-email-instruction-list li+li{margin-top:6px}
      @media (max-width:900px){.mt-order-content.manual{overflow:auto;display:flex}.mt-order-details{overflow:visible}.mt-email-preview,.mt-order-calendar-panel{min-height:430px;flex:0 0 auto}.mt-order-list-options{grid-auto-columns:minmax(150px,220px)}}
      @media (max-width:620px){.mt-order-delivery-choice .mt-order-timing-choices{grid-template-columns:1fr}.mt-order-list-options{grid-auto-columns:minmax(145px,76vw)}.mt-order-calendar-head{align-items:flex-start}.mt-order-calendar-head small{white-space:normal}.mt-order-calendar-head button span{display:none}}
      .mt-order-head{min-height:0;padding:14px 18px}.mt-order-head h2{margin:0;font-size:20px;font-weight:700;color:#101828}
      .mt-order-layout{grid-template-rows:minmax(0,1fr)}.mt-order-modal{grid-template-rows:auto minmax(0,1fr)}
      .mt-order-methods{flex:none;display:flex;flex-wrap:wrap;gap:6px}.mt-order-right>.mt-order-coming{flex:1 1 0;height:auto}.mt-order-address{flex:1;min-width:0;margin-left:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:#475467}.mt-order-address i{margin-right:4px;color:#98a2b3}
      .mt-order-supplier-empty a{color:var(--primary-readable,var(--primary,#d93025));font-weight:600;white-space:nowrap}.mt-order-supplier-empty a i{font-size:9px}
      img.mt-supplier-mark{flex:none;width:20px;height:20px;border-radius:4px;object-fit:contain;background:#fff}i.mt-supplier-mark{flex:none;width:20px;text-align:center;color:#667085}
      .mt-email-fields{margin:0 0 12px;border:1px solid #e4e7ec;border-radius:8px;background:#f9fafb;font-size:12px}.mt-email-fields>div{display:flex;align-items:baseline;gap:8px;padding:6px 10px}.mt-email-fields>div+div{border-top:1px solid #e4e7ec}.mt-email-fields span{flex:none;width:48px;color:#667085}.mt-email-fields strong{font-weight:600;color:#101828}.mt-email-fields em{font-style:normal;color:#667085}.mt-email-fields em.missing{color:#b42318}.mt-order-methods button{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 14px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#475467;font-size:12px;font-weight:600;cursor:pointer}.mt-order-methods button:hover{border-color:#98a2b3}.mt-order-methods button.active{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.07);color:var(--primary-readable,var(--primary,#d93025));box-shadow:inset 0 0 0 1px var(--primary,#d93025)}
      .mt-order-right>.mt-order-coming{flex:1;min-height:0;border:1px dashed #d0d5dd;border-radius:11px}
      .mt-order-details .mt-form-grid{flex:none}.mt-order-details .mt-form-grid label>span{display:block;margin-bottom:3px}
      .mt-order-tiles{flex:1 1 0;min-height:64px;display:flex;align-items:stretch;gap:8px;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}
      .mt-order-tile{flex:1 1 0;min-width:176px;max-height:100%;display:flex;flex-direction:column;overflow:hidden;border:1px solid #e4e7ec;border-radius:10px;background:#fff}
      .mt-order-tile.selected{border-color:color-mix(in srgb,var(--primary,#d93025) 45%,#d0d5dd);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--primary,#d93025) 14%,transparent)}
      .mt-order-tile header{flex:none;display:flex;align-items:center;gap:4px;padding:4px 4px 4px 0}
      .mt-order-tile-select{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:8px;padding:7px 4px 7px 9px;border:0;background:transparent;color:#344054;text-align:left;cursor:pointer}
      .mt-order-tile-select strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600}
      .mt-order-tile .mt-order-list-check{flex:none}.mt-order-tile.selected .mt-order-list-check{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}
      .mt-order-tile-count{flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:#667085}
      .mt-order-tile-expand{flex:none;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:#667085;font-size:10px;cursor:pointer}.mt-order-tile-expand:hover{background:#f2f4f7;color:#344054}
      .mt-order-tile-items{flex:1 1 0;min-height:0;overflow-y:auto;scrollbar-width:thin;margin:0;padding:2px 9px 6px;list-style:none;border-top:1px solid #f0f2f5}
      .mt-order-tile-items li{display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid #f6f7f9;font-size:11px;color:#344054}.mt-order-tile-items li:last-child{border-bottom:0}
      .mt-order-tile-items span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mt-order-tile-items em{flex:none;font-style:normal;color:#667085;font-variant-numeric:tabular-nums}
      .mt-order-tile{position:relative}.mt-order-tile.has-more>.mt-order-tile-items::after{content:'\\2026';position:sticky;display:flex;left:0;right:0;bottom:0;margin-top:-22px;height:22px;display:flex;align-items:flex-end;justify-content:center;padding-bottom:1px;border-radius:0 0 9px 9px;background:linear-gradient(rgba(255,255,255,0),#fff 62%);color:#667085;font-size:15px;font-weight:700;letter-spacing:1px;pointer-events:none}
      .mt-order-tile>footer{flex:none;display:flex;flex-direction:column;gap:5px;min-height:118px;box-sizing:border-box;padding:7px 9px 8px;border-top:1px solid #eaecf0;background:#f8fafc;border-radius:0 0 9px 9px}
      .mt-order-tile-total{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;color:#667085}.mt-order-tile-total strong{font-size:13px;color:#101828;font-variant-numeric:tabular-nums}
      .mt-order-tile-when{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:4px}.mt-order-tile-when input{min-width:0;height:26px;box-sizing:border-box;padding:0 5px;border:1px solid #d0d5dd;border-radius:6px;background:#fff;color:#101828;font:inherit;font-size:11px}.mt-order-tile-when input:disabled{background:#f2f4f7;color:#98a2b3}
      .mt-order-tile-groups{display:flex;align-items:center;flex-wrap:wrap;gap:4px;font-size:10px;color:#667085}
      .mt-order-tile-group{max-width:100%;display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#344054;font-size:10px;font-weight:600;cursor:pointer}.mt-order-tile-group span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mt-order-tile-group:hover{border-color:#98a2b3}.mt-order-tile-group.active{border-color:color-mix(in srgb,var(--primary,#d93025) 45%,#d0d5dd);background:rgba(var(--primary-rgb,217,48,37),.07);color:var(--primary-readable,var(--primary,#d93025))}
      .mt-order-tile-items li.missing{background:#fef3f2;color:#b42318;border-radius:4px;padding-left:4px;padding-right:4px}.mt-order-tile-items li.unknown b{color:#b54708;font-weight:500}
      .mt-order-tile-items b{flex:none;min-width:58px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;color:#101828}
      .mt-order-tile-delivery{display:flex;align-items:center;gap:6px;font-size:11px;color:#475467;cursor:pointer}.mt-order-tile-delivery input{margin:0;accent-color:var(--primary,#d93025)}.mt-order-tile-delivery strong{margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums}
      .mt-order-tile-supplier{display:flex;align-items:center;gap:6px}.mt-order-tile-supplier button{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:1px solid #d0d5dd;border-radius:6px;background:#fff;color:#101828;font-size:11px;font-weight:600;cursor:pointer}
      .mt-order-tile-supplier button span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}.mt-order-tile-supplier button i{color:#667085;font-size:10px}.mt-order-tile-supplier button:disabled{background:#f2f4f7;color:#98a2b3;cursor:default}
      .mt-flag-red{color:#d92d20}.mt-flag-yellow{color:#dc9a04}
      .mt-order-supplier-portal{width:360px}.mt-order-supplier-search{width:100%;box-sizing:border-box;height:30px;padding:0 9px;border:1px solid #d0d5dd;border-radius:7px;font:inherit;font-size:12px}
      .mt-order-supplier-option{display:flex;align-items:center;gap:6px;padding:7px 2px 5px;font-size:11px;color:#475467;cursor:pointer}.mt-order-supplier-option input{margin:0}
      .mt-order-supplier-portal .mt-labor-option b{flex:none;font-size:12px;font-variant-numeric:tabular-nums;color:#344054}.mt-order-supplier-portal .mt-labor-option b.lowest{padding:2px 7px;border-radius:999px;background:#ecfdf3;color:#067647}
      .mt-order-supplier-portal .mt-labor-option.partial small{color:#b42318}.mt-order-supplier-empty{margin:8px 4px;font-size:11px;color:#667085}
      .mt-order-supplier-other{display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid #eaecf0}.mt-order-supplier-other input{flex:1;min-width:0;height:28px;padding:0 8px;border:1px solid #d0d5dd;border-radius:6px;font:inherit;font-size:11px}.mt-order-supplier-other button{height:28px;padding:0 10px;border:1px solid #d0d5dd;border-radius:6px;background:#fff;font-size:11px;font-weight:600;cursor:pointer}
      .mt-email-recipient{display:flex;align-items:baseline;gap:6px;margin:0 0 10px;padding:6px 9px;border-radius:7px;background:#f2f4f7;font-size:11px}.mt-email-recipient span{color:#667085}.mt-email-recipient em{font-style:normal;color:#667085}.mt-email-recipient em.missing{color:#b42318}.mt-email-split{margin:18px 0;border:0;border-top:1px dashed #d0d5dd}
      .mt-order-right{min-width:0;min-height:0;display:flex;flex-direction:column;gap:10px}.mt-order-right>.mt-email-preview{flex:1 1 0}.mt-order-send{flex:none;display:flex;justify-content:flex-end;gap:8px}.mt-order-send .mt-btn{min-height:40px;padding:0 22px}
      .mt-order-calendar-panel{grid-template-rows:auto auto minmax(0,1fr)}.mt-order-calendar-panel>.mt-order-target-options{margin:0;padding:8px 14px;border-bottom:1px solid #eaecf0}
      .mt-order-target strong{font-size:11px}.mt-order-target small{font-size:10px}
      @media (min-width:901px){.mt-order-details{overflow:hidden;padding-right:0}.mt-order-content.manual.calendar-mode .mt-order-details{padding-bottom:14px}}
      @media (max-width:900px){.mt-order-tiles{flex:none;max-height:260px}.mt-order-divider{display:none}}
      @media (min-width:901px){.mt-order-content.manual,.mt-order-content.manual.calendar-mode{grid-template-columns:var(--order-left,330px) 14px minmax(0,1fr);gap:0}}
      .mt-order-divider{position:relative;align-self:stretch;padding:0;border:0;background:transparent;cursor:col-resize;touch-action:none}.mt-order-divider::after{content:'';position:absolute;top:6px;bottom:6px;left:6px;width:2px;border-radius:2px;background:#e4e7ec;transition:background .12s}.mt-order-divider:hover::after,.mt-order-divider:focus-visible::after,.mt-order-divider.is-dragging::after{background:var(--primary,#d93025)}.mt-order-divider:focus-visible{outline:none}
      .mt-projected-total{flex:none;display:flex;flex-direction:column;justify-content:center;gap:1px;padding-right:10px;margin-right:2px;border-right:1px solid #e4e7ec;line-height:1.1}.mt-projected-total span{font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#98a2b3}.mt-projected-total strong{font-size:14px;font-variant-numeric:tabular-nums;color:#101828}
      .mt-header-action{overflow:hidden;max-width:40px}.mt-header-action.is-entering{animation:mt-action-in .3s cubic-bezier(.2,.7,.3,1) both}.mt-header-action.is-leaving{pointer-events:none;animation:mt-action-out .28s cubic-bezier(.5,0,.8,.4) both}
      @keyframes mt-action-in{from{opacity:0;max-width:0;padding-left:0;padding-right:0;margin-left:-6px;border-width:0;transform:translateX(36px)}to{opacity:1;max-width:40px;transform:none}}
      @keyframes mt-action-out{from{opacity:1;max-width:40px;transform:none}to{opacity:0;max-width:0;padding-left:0;padding-right:0;margin-left:-6px;border-width:0;transform:translateX(36px)}}
      @media(prefers-reduced-motion:reduce){.mt-header-action.is-entering,.mt-header-action.is-leaving{animation:none}.mt-header-action.is-leaving{display:none}}
      .mt-assign-block{display:flex;flex-direction:column;gap:6px;margin:8px;padding:10px;border:1px dashed #d0d5dd;border-radius:8px;background:#f9fafb}.mt-assign-block>strong{margin-bottom:2px;font-size:13px;color:#101828}.mt-assign-block>strong i{margin-left:3px;font-size:10px;color:#98a2b3}.mt-assign-block>em{font-size:11px;font-style:normal;color:#667085}
      .mt-assign-block button{display:flex;flex-direction:column;align-items:stretch;gap:8px;width:100%;padding:9px 10px;border:1px solid #e4e7ec;border-radius:7px;background:#fff;text-align:left;color:#344054;cursor:pointer}.mt-assign-block button:hover{border-color:var(--primary,#d93025)}.mt-assign-block.is-busy button{opacity:.6;cursor:progress}.mt-assign-block.is-busy button:hover{border-color:#e4e7ec}
      .mt-assign-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.mt-assign-top strong{min-width:0;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mt-assign-pills{display:flex;flex-wrap:nowrap;gap:4px;min-width:0;overflow:hidden}.mt-assign-pills .mt-pill{flex:none;padding:0 6px}.mt-assign-pills .mt-pill i{flex:none}.mt-assign-pills .mt-pill.fit{flex:0 1 auto;min-width:0;overflow:hidden}.mt-assign-pills .mt-pill.fit>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
      .mt-pill{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:999px;background:#eef2f6;color:#344054;font-size:10px;font-weight:600;white-space:nowrap}.mt-pill i{font-size:9px;color:#667085}.mt-pill.plain{background:transparent;border:1px solid #e4e7ec;color:#667085;font-weight:500}
      .mt-assign-top b,.mt-labor-option b.mt-pay{flex:none;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;color:#101828}.mt-assign-top b.unknown,.mt-labor-option b.mt-pay.unknown{font-size:11px;font-weight:600;color:#475467}
      tr.mt-list-row.needs-quantity .mt-c-qty input{box-shadow:inset 0 0 0 1px #f79009;background:#fffaeb}
      .mt-generate-portal{width:260px;display:flex;flex-direction:column;gap:6px}.mt-generate-portal label{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}.mt-generate-portal label em{font-style:normal;font-size:10px;color:#98a2b3}.mt-generate-portal input{width:90px;height:28px;padding:0 6px;border:1px solid #d0d5dd;border-radius:6px;font-size:12px;text-align:right}
      .mt-column-title{flex:1;min-width:0;padding:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mt-workspace-actions .mt-schedule-job{height:30px;padding:0 14px;gap:7px;border:1px solid var(--primary,#d93025);border-radius:8px;background:var(--primary,#d93025);color:#fff;font-size:12px;font-weight:700;cursor:pointer;transition:background-color .2s ease,border-color .2s ease,filter .15s ease}.mt-workspace-actions .mt-schedule-job:hover{filter:brightness(.94)}
      .mt-workspace-actions .mt-schedule-job.is-done,.mt-workspace-actions .mt-header-action.is-done{background:#079455;border-color:#079455;color:#fff}
      @keyframes sw-enter-forward{from{opacity:0;transform:translateX(22px)}to{opacity:1;transform:none}}@keyframes sw-enter-back{from{opacity:0;transform:translateX(-22px)}to{opacity:1;transform:none}}
      .sw-panel.sw-enter-forward{animation:sw-enter-forward .26s cubic-bezier(.22,1,.36,1) both}.sw-panel.sw-enter-back{animation:sw-enter-back .26s cubic-bezier(.22,1,.36,1) both}
      @media (prefers-reduced-motion: reduce){.sw-panel.sw-enter-forward,.sw-panel.sw-enter-back{animation:none}}
      tr.mt-list-row.is-brought .mt-c-name input{font-style:italic;color:#475467}
      tr.mt-list-row.is-estimated .mt-c-qty input{font-style:italic;color:#475467}
      .mt-resource-column .mt-table tr.mt-list-row td.mt-c-warn{flex:none;width:16px;text-align:center;color:#dc6803;font-size:10px;cursor:help}
      .mt-req-tray{flex:none;align-self:stretch;display:flex;min-height:0;margin-left:10px;border:1px solid #e4e7ec;border-radius:8px;background:#fff;overflow:hidden}
      .mt-req-bar{flex:none;width:30px;display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 0;border:0;border-right:1px solid transparent;background:#f9fafb;color:#667085;cursor:pointer;transition:background-color .15s ease}
      .mt-req-bar:hover{background:#f2f4f7;color:#344054}.mt-req-tray.is-open .mt-req-bar{border-right-color:#eaecf0}
      .mt-req-arrow{font-size:10px;transition:transform .24s cubic-bezier(.4,0,.2,1)}.mt-req-tray.is-open .mt-req-arrow{transform:rotate(180deg)}
      .mt-req-badges{display:flex;flex-direction:column;align-items:center;gap:6px}.mt-req-badge{display:flex;align-items:center;justify-content:center;min-width:18px;height:18px;box-sizing:border-box;padding:0 4px;border-radius:9px;font-size:10px;font-weight:700;line-height:1;color:#fff;font-variant-numeric:tabular-nums}.mt-req-badge i{font-size:14px}
      .mt-req-badge.is-open{background:#d92d20}.mt-req-badge.is-warning{background:#dc6803}.mt-req-badge.is-covered{padding:0;color:#079455}
      .mt-req-row.is-open .mt-req-dot{color:#d92d20}.mt-req-row.is-warning .mt-req-dot{color:#dc6803}.mt-req-row.is-covered .mt-req-dot{color:#079455}.mt-req-head .mt-req-kind{flex:none;width:13px;text-align:center;font-size:10px}
      .mt-req-bar-label{writing-mode:vertical-rl;transform:rotate(180deg);font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#98a2b3;margin-top:2px}
      .mt-req-panel{width:0;opacity:0;overflow:hidden;transition:width .26s cubic-bezier(.4,0,.2,1),opacity .2s ease}.mt-req-tray.is-open .mt-req-panel{width:290px;opacity:1}
      .mt-req-panel-inner{width:290px;height:100%;display:flex;flex-direction:column;min-height:0}
      .mt-req-title{flex:none;display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid #eaecf0}.mt-req-title>div{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}.mt-req-title strong{font-size:12px;color:#101828}.mt-req-title span{font-size:10px;color:#667085}
      .mt-req-fix{flex:none;display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:0;border-radius:5px;background:var(--primary,#d93025);color:#fff;font-size:10px;font-weight:700;cursor:pointer}.mt-req-fix:disabled{opacity:.7;cursor:default}.mt-req-fix i{font-size:10px}.mt-req-title .mt-req-fix span,.mt-req-title .mt-req-fix i{color:#fff}
      .mt-req-title select{flex:none;width:64px;height:22px;padding:0 4px;border:1px solid #d0d5dd;border-radius:5px;background:#fff;font-size:10px;font-weight:600;color:#344054;cursor:pointer}.mt-req-source{display:flex;align-items:center;gap:6px;color:#667085}.mt-req-source span{flex:1}
      .mt-req-scroll{flex:1;min-height:0;overflow:auto;padding:4px 6px 8px}
      .mt-req-group-head{display:flex;align-items:center;gap:5px;width:100%;padding:6px 4px 3px;border:0;background:transparent;font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#98a2b3;cursor:pointer}.mt-req-group-head i{font-size:8px}.mt-req-group-head span{flex:1;text-align:left}.mt-req-group-head em{font-style:normal}
      .mt-req-row{border-bottom:1px solid #f0f2f5}.mt-req-row.is-open{background:#fef3f2}.mt-req-row.is-warning{background:#fffaeb}
      .mt-req-row.is-covered.is-completed{background:#ecfdf3}.mt-req-row.is-completed .mt-req-dot,.mt-req-row.is-scheduled .mt-req-dot{color:#079455}.mt-req-row.is-completed .mt-req-head span{color:#067647}.mt-req-cover-state{flex:none;font-size:9px;font-weight:700;color:#079455}
      .mt-resource-column .mt-list-head button.mt-labor-more{color:#475467}.mt-resource-column .mt-list-head .mt-paid-pill{flex:none;display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:999px;background:#ecfdf3;color:#067647;font-size:10px;font-weight:800;white-space:nowrap}
      .mt-list-pane.is-finalized .mt-list-head{background:#ecfdf3}.mt-list-pane.is-finalized .mt-list-pane-inner>:not(.mt-list-head){pointer-events:none}.mt-list-pane.is-finalized .mt-list-add-item{display:none}.mt-list-pane.is-finalized input,.mt-list-pane.is-finalized select{color:#475467}
      .mt-workspace-actions .mt-closeout{height:30px;padding:0 12px;gap:7px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center}.mt-workspace-actions .mt-closeout:hover{background:#f2f4f7}.mt-workspace-actions .mt-closeout.is-done{background:#079455;border-color:#079455;color:#fff}
      .mt-req-head{display:flex;align-items:center;gap:6px;width:100%;min-height:26px;padding:2px 4px;border:0;background:transparent;font-size:11px;color:#344054;text-align:left;cursor:pointer}.mt-req-head:hover{background:rgba(16,24,40,.04)}
      .mt-req-head .mt-req-dot{flex:none;font-size:11px}.mt-req-head span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.mt-req-why{display:block;margin:-2px 0 3px;padding:0 6px 0 38px;font-size:10px;font-weight:600;line-height:1.35;color:#b54708}.is-open>.mt-req-why{color:#b42318}.mt-req-head em{flex:none;font-style:normal;font-size:10px;color:#667085;font-variant-numeric:tabular-nums}.mt-req-chevron{flex:none;font-size:8px;color:#98a2b3}
      .mt-req-row.is-caused .mt-req-head{padding-left:14px}
      .mt-req-detail{display:flex;flex-direction:column;gap:5px;padding:2px 6px 8px 21px;font-size:10px;color:#475467}.mt-req-detail p{margin:0}.mt-req-note{color:#667085;font-size:10px;padding:6px 4px;margin:0}
      .mt-req-warning{display:flex;gap:5px;color:#b54708}.mt-req-warning i{margin-top:2px;font-size:9px}
      .mt-req-cover{display:flex;flex-direction:column;gap:1px;padding:3px 6px;border:1px solid #eaecf0;border-radius:6px;background:#fff}.mt-req-cover-head{display:flex;align-items:center;gap:6px;min-height:20px}.mt-req-cover-head em{flex:0 1 auto;min-width:0;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:normal;font-size:10px;color:#667085}.mt-req-cover strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#101828}
      .mt-req-remove{flex:none;height:18px;padding:0 6px;border:0;border-radius:4px;background:transparent;font-size:10px;font-weight:600;color:#667085;cursor:pointer}.mt-req-remove:hover{background:#fef3f2;color:#b42318}
      .mt-req-cover ul{list-style:none;margin:3px 0 0;padding:0;display:flex;flex-direction:column;gap:2px}.mt-req-cover li{display:flex;align-items:center;gap:6px}.mt-req-cover li span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mt-req-cover li em{flex:none;font-style:normal;color:#667085;font-variant-numeric:tabular-nums}.mt-req-cover li button{flex:none;width:16px;height:16px;padding:0;border:0;border-radius:4px;background:transparent;color:#98a2b3;cursor:pointer}.mt-req-cover li button:hover{background:#f2f4f7;color:#344054}
      .mt-req-action{align-self:flex-start;max-width:100%;display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;white-space:nowrap;border:1px solid #d0d5dd;border-radius:5px;background:#fff;font-size:10px;font-weight:600;color:#344054;cursor:pointer}.mt-req-action:hover{background:#f9fafb}.mt-req-action span{min-width:0;overflow:hidden;text-overflow:ellipsis}.mt-req-action i{font-size:9px}
      .mt-req-mark{display:flex;flex-direction:column;gap:2px}.mt-req-mark select{height:24px;border:1px solid #d0d5dd;border-radius:5px;background:#fff;font-size:10px;color:#344054}
      @media (prefers-reduced-motion: reduce){.mt-req-panel,.mt-req-arrow{transition:none}}
      .mt-labor-option .mt-option-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}.mt-labor-option .mt-assign-top strong{font-size:12px}.mt-labor-portal{width:320px}
      tr.mt-list-row.is-unresolved .mt-c-name input,tr.mt-list-row.is-unresolved .mt-c-name{color:#b54708}tr.mt-list-row.is-unresolved .mt-c-total::after{content:"needs input";font-size:9px;font-weight:600;color:#b54708}
      .mt-delivery-row{flex:none;display:flex;align-items:center;gap:6px;height:26px;padding:0 6px 0 9px;border-top:1px solid #e4e7ec;background:#fff;font-size:11px;color:#475467}.mt-delivery-row i.fa-truck{font-size:10px;color:#98a2b3}.mt-delivery-row span{flex:1;min-width:0;font-style:italic}.mt-delivery-row strong{font-weight:600;font-variant-numeric:tabular-nums;color:#101828}.mt-delivery-row.off strong,.mt-delivery-row.off span{color:#98a2b3}
      .mt-delivery-row button{border:0;background:transparent;padding:0 2px;font-size:15px;color:var(--primary,#d93025);cursor:pointer}.mt-delivery-row.off button{color:#98a2b3}
      .mt-source-sub{display:flex;align-items:center;gap:6px;padding:2px 8px 6px 20px;font-size:11px;color:#475467;cursor:pointer}.mt-source-sub input{margin:0}
      .mt-workspace-actions button.mt-header-action{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:var(--on-primary,#fff);font-weight:700;align-self:stretch;width:32px;min-height:26px;padding:0;justify-content:center}.mt-workspace-actions button.mt-header-action:hover:not(:disabled){background:var(--primary-dark,var(--primary,#d93025))}.mt-workspace-actions button.mt-header-action:disabled{opacity:.5;cursor:not-allowed}
      .mt-resource-column .mt-list-head button[data-mt-open-pricebook][aria-pressed=true]{background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}
      .mt-autofill{position:fixed;z-index:2147482660;box-sizing:border-box;max-height:264px;overflow:auto;padding:4px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;box-shadow:0 14px 34px rgba(15,23,42,.18);font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
      .mt-autofill{width:max-content}.mt-autofill button{display:flex;align-items:baseline;gap:14px;width:100%;padding:6px 8px;border:0;border-radius:5px;background:#fff;color:#101828;text-align:left;cursor:pointer}
      .mt-autofill button:hover,.mt-autofill button[aria-selected=true]{background:rgba(var(--primary-rgb,217,48,37),.09)}
      .mt-autofill strong{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600}.mt-autofill em{flex:none;font-style:normal;font-size:10px;color:#98a2b3;white-space:nowrap}.mt-autofill span{flex:none;min-width:84px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;color:#344054;white-space:nowrap}
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
    const measurementId = activeMeasurementProjectId() || projectId();
    const hydrationContext = captureProjectOperation();
    if (state.measurementLoadingId === measurementId) return state.measurementLoadPromise;
    if (!measurementId || (!force && state.measurementLoadedId === measurementId)) return null;
    state.measurementLoadingId = measurementId;
    const reportOrderState = state.host?.getReportOrderState?.() || state.context?.reportOrderState || {};
    const sharedMeasurements = window.FirstMeasureAPI?.roofMeasurements;
    const load = sharedMeasurements?.load
      ? sharedMeasurements.load(state.project || {}, { reportOrderState, force })
      : loadMeasurementArtifactSource(measurementId).then((source) => ({ source, measurements: null }));
    state.measurementLoadPromise = load.then((result) => {
      if (!projectOperationIsCurrent(hydrationContext)) return;
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
      if (!projectOperationIsCurrent(hydrationContext)) return null;
      state.measurementLoadingId = '';
      state.lastError = 'Could not load the project measurements. Refresh to retry.';
      return null;
    });
    return state.measurementLoadPromise;
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
    if (type && type!=='material') return type;
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
    if (cleanText(value?.value) === 'none') return 'background:repeating-linear-gradient(135deg,#fff 0 3px,#d0d5dd 3px 4px)';
    const hex = cleanText(value?.metadata?.hex);
    return `background:${/^#[0-9a-f]{3,8}$/i.test(hex) ? hex : colorForValue(value?.value)}`;
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
    const writes = listWrites.get(cleanText(listId));
    if (writes?.pending > 0) writes.items = next.current_items;
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
      totals.projected += number(item.projected_total, number(item.quantity,0)*number(item.projected_unit_price,0));
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
    if (!loadContextIsCurrent(loadContext) || !apiReady() || !(materialsAPI || window.MaterialsAPI)?.projects?.initializeFromScope) return null;
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
      const result = await (materialsAPI || window.MaterialsAPI).projects.initializeFromScope(requestOrgId, requestProjectId, payload);
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
      if (!options.force && [403, 404, 405, 501].includes(Number(error?.status || 0))) return null;
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

  function workspaceIsEditing(){
    return state.saving || state.creatingList || state.loading || listWritesPending() || state.panelRoot?.querySelector('dialog[open]')
      || ([state.panelRoot, state.sidebarRoot].some((root) => root?.contains(document.activeElement))
        && document.activeElement?.matches('input,textarea,select,[contenteditable="true"]'));
  }

  async function refreshWorkspace(){
    if (!state.mounted || !state.active || document.hidden || workspaceIsEditing() || !materialsAPI || !scopeWorkspace) return;
    const operation = captureProjectOperation();
    const fingerprint = (lists) => JSON.stringify(lists.map((list) => [list.id, list.revision, list.status, list.delivery_status, list.current_items]));
    try {
      const [result, documents] = await Promise.all([
        materialsAPI.projects.list(operation.orgId, operation.projectId),
        scopeWorkspace.loadDocuments(operation.orgId, operation.projectId)
      ]);
      if (!projectOperationIsCurrent(operation) || !state.active || workspaceIsEditing()) return;
      const lists = result.material_lists || [];
      const categoriesChanged=JSON.stringify(result.resource_types||[])!==JSON.stringify(state.resourceTypes);
      if(result.resource_types)state.resourceTypes=result.resource_types;
      const listsChanged = fingerprint(lists) !== fingerprint(state.lists);
      const documentsChanged = JSON.stringify(documents.documents) !== JSON.stringify(state.scopeDocuments) || documents.error !== state.scopeDocumentsError;
      if (listsChanged) applyMaterialLists(lists);
      state.scopeDocuments = documents.documents;
      state.scopeDocumentsError = documents.error;
      if (listsChanged || documentsChanged || categoriesChanged) { render({ preserveScroll:true }); renderLeft(); }
    } catch { /* Keep the last usable view; the next background read retries. */ }
  }

  async function loadScopeDocuments(loadContext){
    try {
      scopeWorkspace ||= await import(scopeWorkspaceUrl);
      const result = await scopeWorkspace.loadDocuments(loadContext.orgId, loadContext.projectId);
      if (!loadContextIsCurrent(loadContext)) return;
      state.scopeDocuments = result.documents;
      state.scopeDocumentsError = result.error;
      render({ preserveScroll:true });
      renderLeft();
      scopeWorkspace.installDivider(state.sidebarRoot);
    } catch (error) {
      if (!loadContextIsCurrent(loadContext)) return;
      state.scopeDocumentsError = 'Scope documents could not load.';
    }
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
      if (!apiReady()) throw new Error('materials_api_unavailable');
      if (!materialsAPI) materialsAPI = (await import(calculusAdapterUrl)).nativeCalculusAPI(window.MaterialsAPI, projectId);
      const ancillary = Promise.allSettled([loadPricebookItems(loadContext), loadWorkResources(loadContext), requestMeasurementHydration(), loadScopeDocuments(loadContext)]);
      const result = await (materialsAPI || window.MaterialsAPI).projects.list(loadContext.orgId, loadContext.projectId);
      if (!loadContextIsCurrent(loadContext)) return;
      state.resourceTypes=Array.isArray(result.resource_types)?result.resource_types:[];
      applyMaterialLists(Array.isArray(result.material_lists) ? result.material_lists : []);
      state.loading = false;
      render();
      renderLeft();
      await ancillary;
      if (!loadContextIsCurrent(loadContext)) return;
      // Opening Scope is a read. Document deliverables own material generation;
      // legacy scope regeneration remains an explicit sidebar action.
      await Promise.all([loadActiveListDetails(loadContext), loadExpenseProjection(loadContext)]);
    } catch (error) {
      if (!loadContextIsCurrent(loadContext)) return;
      state.lastError = error?.message === 'materials_api_unavailable' ? '' : (error?.message || 'Could not load materials.');
      // Keep the successfully loaded lists if optional initialization fails.
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
    const result = await (materialsAPI || window.MaterialsAPI).projects.create(orgId(), projectId(), payload);
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
      (materialsAPI || window.MaterialsAPI).lists.versions(requestOrgId, requestListId).catch(() => ({ versions: [] })),
      (materialsAPI || window.MaterialsAPI).lists.orders(requestOrgId, requestListId).catch(() => ({ orders: [] }))
    ]);
    if (!requestIsCurrent()) return;
    const nextVersions = Array.isArray(versionsResult.versions) ? versionsResult.versions : [];
    const nextOrders = Array.isArray(ordersResult.orders) ? ordersResult.orders : [];
    const deliveryPairs = await Promise.all(nextOrders.map((order) => {
      return (materialsAPI || window.MaterialsAPI).orders.deliveries(requestOrgId, order.id)
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
      state.workforceGroupKinds = configurationResult?.configuration?.resource_group_kinds || configurationResult?.resource_group_kinds || [];
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

  // A list can move on between reading it and changing it: a rename, a background save, the list having only just been
  // created. A change that only adds, edits or removes particular lines still means the same thing on the newer list, so
  // it is sent again on the revision the server has. Replacing every line at once is never retried blind.
  async function withCurrentRevision(list, send, retryable = true){
    let revision = Number(list?.revision || 0) || undefined;
    for (let attempt = 0; ; attempt += 1) {
      try { return await send(revision); }
      catch (error) {
        const stale = error?.status === 409 && /revision/i.test(`${error?.data?.code || ''} ${error?.data?.error || ''} ${error?.message || ''}`);
        if (!stale || !retryable || attempt >= 3 || !list?.id) throw error;
        const fresh = await (materialsAPI || window.MaterialsAPI).lists.get(orgId(), list.id);
        const current = fresh?.material_list || fresh?.list || fresh;
        if (!current?.id) throw error;
        updateMaterialListState({ ...current, current_items: listItems(materialListById(list.id) || list) });
        revision = Number(current.revision || 0) || undefined;
      }
    }
  }
  async function patchScopeResourceList(listId, patch, operation = captureProjectOperation(listId)){
    const list = materialListById(listId);
    if (!list || !apiReady() || !projectOperationIsCurrent(operation)) return null;
    const result = await withCurrentRevision(list, (revision) => (materialsAPI || window.MaterialsAPI).lists.patch(operation.orgId, operation.listId, { expected_revision: revision, ...patch }), !('metadata' in (patch || {})) && !('current_items' in (patch || {})));
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
    const currentAssignment = list.assignment && typeof list.assignment === 'object' ? list.assignment : {};
    try {
      const updatedList = await patchScopeResourceList(listId, {
        assignment: {
          unit_id: resource && cleanText(resource.id) === cleanText(currentAssignment.work_resource_ref?.id) ? cleanText(currentAssignment.unit_id) : '',
          work_resource_ref: resource ? {
            kind: cleanText(resource.resource_kind || resource.kind),
            id: cleanText(resource.id),
            name: cleanText(resource.name || resource.label)
          } : null
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
        render({ preserveScroll: true });
        renderLeft();
        syncLaborMenu();
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
    refreshRequirements();
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
      const result = await (materialsAPI || window.MaterialsAPI).projects.create(orgId(), projectId(), {
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
    if (!currentList || !apiReady() || !(materialsAPI || window.MaterialsAPI)?.lists?.scheduleEvent) return { list: currentList, event };
    const type = resourceType(currentList);
    const terms = resourceTerms(type, currentList);
    const schedule = currentList.schedule || {};
    const result = await (materialsAPI || window.MaterialsAPI).lists.scheduleEvent(orgId(), currentList.id, {
      project_id: projectId(),
      branch_id: branchId(),
      event: {
        // A list made without a name (a work order, an equipment list) keeps its kind's name on the schedule.
        title: cleanText(schedule.title || (currentList.metadata?.placeholder_title ? '' : currentList.title)) || (type === 'labor' ? 'Work order' : cleanText(resourceCategories().find((row) => row.id === type)?.name)) || terms.list,
        kind: cleanText(schedule.kind) || (type === 'material' ? 'material_delivery' : type === 'labor' ? 'project_work' : 'equipment'),
        icon: cleanText(schedule.icon) || terms.icon,
        resource_type: type
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

  const listWrites = new Map();
  function listWritesPending(){
    return [...listWrites.values()].some((entry) => entry.pending > 0);
  }
  // Saves for one list are queued so each uses the revision the previous one returned. Edits are already on screen,
  // so while later saves are still queued the on-screen items are put back over each server copy.
  async function persistVersion(payload, options = {}){
    const requested = options.list || state.activeList;
    if (!requested) return null;
    const id = cleanText(requested.id);
    const entry = listWrites.get(id) || { chain: Promise.resolve(), pending: 0, items: null };
    listWrites.set(id, entry);
    entry.pending += 1;
    entry.items = listItems(materialListById(id) || requested);
    const run = entry.chain.catch(() => {}).then(() => persistVersionNow(payload, { ...options, list: materialListById(id) || requested }));
    entry.chain = run;
    try {
      return await run;
    } finally {
      entry.pending -= 1;
      if (entry.pending > 0 && entry.items && materialListById(id)) replaceListItems(id, entry.items);
      if (entry.pending <= 0) entry.items = null;
    }
  }

  async function persistVersionNow(payload, options = {}){
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
    const result = await withCurrentRevision(targetList, (revision) => (materialsAPI || window.MaterialsAPI).lists.createVersion(orgId(), targetList.id, { expected_revision: revision, ...payload }), !Array.isArray(payload?.items));
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
    if (resourceCategories().some(row=>row.id===section)&&section!=='material') return section;
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
    // A list still being created is waited for, so a fast click adds to it rather than being lost.
    if (state.creatingList && state.creatingListDone) await state.creatingListDone;
    if (state.saving || state.creatingList || state.loading) return;
    let targetList = destinationListForSection(section || 'accessories', requestedListId);
    if (!targetList) {
      const operation = captureProjectOperation();
      const type = resourceTypeForSection(section);
      const terms = resourceTerms(type, null);
      state.creatingList = true;
      setWorkspaceSaving(true);
      try {
        const result = await (materialsAPI || window.MaterialsAPI).projects.create(operation.orgId, operation.projectId, {
          title: 'Default', resource_type: type, branch_id: branchId(), items: [], sections: [],
          terminology: terms, color:materialListColor({resource_type:type}), order_sources: projectOrderSources(),
          metadata: { source:'scope_tab', role:`custom_${type}`, manually_created:true }
        });
        if (!projectOperationIsCurrent(operation)) return;
        targetList = updateMaterialListState(result.material_list || result.list);
        if (!targetList) throw Error('The resource list was not returned.');
      } catch (error) {
        if (projectOperationIsCurrent(operation)) showToast('Could not add item', error?.message || 'Please try again.', false);
        return;
      } finally {
        if (projectOperationIsCurrent(operation)) { state.creatingList = false; setWorkspaceSaving(false); }
      }
    }
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
    replaceListItems(targetList.id, [...baseItems, line]);
    state.activeListId = cleanText(targetList.id);
    state.activeList = materialListById(targetList.id);
    state.visibleListIds.add(cleanText(targetList.id));
    syncMaterialsGrid();
    const nameInput = findByData(materialRoot(), '[data-mt-item-name]', 'mtItemName', line.id);
    nameInput?.focus();
    nameInput?.select();
    // The row is usable at once; the save happens behind it and only speaks up if it fails.
    persistVersion({ reason: 'supplement', add_items: [line] }, { baseItems, list: targetList }).then(() => (type === 'labor' ? loadExpenseProjection().then(() => syncFooterTotals()) : null)).catch((error) => {
      const latest = materialListById(targetList.id);
      if (latest) replaceListItems(latest.id, listItems(latest).filter((entry) => entry.id !== line.id));
      syncMaterialsGrid();
      showToast(((v0) => globalThis.PlatformLanguage?.text("materials","m_6b20ad5f8a56d9",`Could not add ${v0}`,{v0}) ?? `Could not add ${v0}`)(terms.singular.toLowerCase()), error?.message || 'Please try again.', false);
    });
    timingMark('addItem:end', { items: listItems().length }, timingStart);
  }

  function markGenerateButtonLoading(button){
    if (!button) return;
    button.disabled = true;
    button.innerHTML = `<i class="fas fa-rotate mt-spin"></i>${button.closest('.mt-icon-toggles') ? '' : ' Regenerating'}`;
  }

  // Material an accepted document published waits for someone to generate it. Generates every such set; reports each.
  async function generatePendingMaterialSets(options = {}){
    const api = (materialsAPI || window.MaterialsAPI)?.calculus, generated = [], failed = [];
    if (!api?.generate) return { generated, failed };
    for (const list of state.lists.filter((entry) => entry.metadata?.calculus_pending || (options.all && entry.metadata?.calculus))) {
      try { const result = await api.generate(list.id); updateMaterialListState(result?.material_list); generated.push(cleanText(list.title) || 'Materials'); }
      catch (error) { failed.push(`${cleanText(list.title) || 'Materials'}: ${error?.message || 'could not be generated'}`); }
    }
    return { generated, failed };
  }
  // options.resourceType limits it to one column (the Materials heading's wand): the other columns are left as they are.
  async function regenerateMaterialListsFromScope(options = {}){
    const only = cleanText(options.resourceType);
    if (!apiReady() || !(materialsAPI || window.MaterialsAPI)?.projects?.initializeFromScope) {
      showToast((globalThis.PlatformLanguage?.text("materials","m_d9e2e6ecf3e384","Scope regeneration unavailable") ?? "Scope regeneration unavailable"), (globalThis.PlatformLanguage?.text("materials","m_6ae9948e2fd11a","Materials API is not ready for this project.") ?? "Materials API is not ready for this project."), false);
      return;
    }
    // Asking only makes sense when something already on the lists would be replaced.
    const replacesSomething = state.lists.some((list) => (!only || resourceType(list) === only) && listItems(list).length);
    const confirmed = !replacesSomething || await confirmAction(
      only === 'material'
        ? 'Regenerate the materials from the signed document and the project scope? Generated material lists are replaced; work orders and equipment are left as they are. Ordered lists are protected.'
        : 'Regenerate material lists from the project scope? This will replace generated planning lists with the current scope output. Ordered lists are protected.',
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
      syncResourceHeader();
      return;
    }
    state.generatingMaterials = true;
    renderLeft();
    render({ preserveScroll: true });
    const minimumFeedback = new Promise((resolve) => setTimeout(resolve, 650));
    try {
      const operation = captureProjectOperation();
      await requestMeasurementHydration();
      if (!projectOperationIsCurrent(operation)) return;
      // An accepted document's material comes first; the scope's own list definitions are added to it.
      const fromDocuments = await generatePendingMaterialSets({ all: true });
      if (!projectOperationIsCurrent(operation)) return;
      const generated = await initializeMaterialListsFromScope({ force: true, mergeLists: true, ...(only ? { resourceType: only } : {}) }).catch((error) => (fromDocuments.generated.length ? null : Promise.reject(error)));
      const fromScope = (generated?.material_lists || generated?.lists || []).length;
      if (!fromScope && !fromDocuments.generated.length) {
        throw new Error(fromDocuments.failed.length
          ? `The signed document's materials could not be generated. ${fromDocuments.failed.join(' ')}`
          : 'Nothing was generated: there is no signed document with materials, and the project scope defines no lists. Sign a document that includes materials, or add list definitions to the scope in the Scope builder.');
      }
      if (fromDocuments.failed.length) showToast('Some materials were not generated', fromDocuments.failed.join(' '), false);
      if (!projectOperationIsCurrent(operation)) return;
      const refreshed = await (materialsAPI || window.MaterialsAPI).projects.list(operation.orgId, operation.projectId);
      if (!projectOperationIsCurrent(operation)) return;
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
      const refreshed = await (materialsAPI || window.MaterialsAPI).projects.list(orgId(), projectId());
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
    const wholeUnits = discreteMaterial && !current.metadata?.calculus_line_id;
    const quantity = patch.quantity != null
      ? (wholeUnits ? integerQuantity(patch.quantity, current.quantity) : preciseQuantity(patch.quantity, current.quantity))
      : (wholeUnits ? integerQuantity(current.quantity, 0) : preciseQuantity(current.quantity, 0));
    const unitPrice = patch.projected_unit_price != null ? number(patch.projected_unit_price, current.projected_unit_price) : number(current.projected_unit_price, NaN);
    const nextPatch = {
      ...patch,
      id: itemId,
      ...(patch.name != null || patch.metadata ? { metadata: { ...(current.metadata || {}), ...(patch.metadata || {}), ...(patch.name != null ? { name_overridden: true } : {}) } } : {}),
      quantity,
      ...(discreteMaterial ? orderFieldsForLine({ ...current, ...patch }, quantity) : {}),
      projected_unit_price: Number.isFinite(unitPrice) ? unitPrice : undefined,
      projected_total: Number.isFinite(unitPrice) ? Math.round(quantity * unitPrice * 100) / 100 : current.projected_total
    };
    replaceListItems(targetList.id, baseItems.map((item) => item.id === itemId ? { ...item, ...nextPatch } : item));
    syncLineRow(itemId, targetList.id);
    syncFooterTotals();
    try {
      await persistVersion({ reason: 'revision', update_items: [nextPatch] }, { list: targetList, baseItems });
      if (laborItem) { await loadExpenseProjection(); syncFooterTotals(); }
    } catch (error) {
      // Only this item goes back to what it was; anything typed since stays.
      const latest = materialListById(targetList.id);
      if (latest) replaceListItems(latest.id, listItems(latest).map((item) => item.id === itemId ? current : item));
      syncLineRow(itemId, targetList.id);
      syncFooterTotals();
      showToast((globalThis.PlatformLanguage?.text("materials","m_9747f0d8655351","Could not update material") ?? "Could not update material"), error?.message || 'Please try again.', false);
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

  function clearDropMarkers(){
    materialRoot()?.querySelectorAll?.('.drop-before,.drop-after,.is-drop-target')?.forEach((node) => node.classList.remove('drop-before', 'drop-after', 'is-drop-target'));
  }

  function dragAccepts(listId){
    const target = materialListById(listId);
    return !!state.dragItem && !!target && !state.saving && resourceType(target) === state.dragItem.type;
  }

  // Places an item beside an anchor item (or at the end) of a list of the same resource type.
  async function dropItem(itemId, sourceListId, targetListId, anchorItemId = '', after = false){
    const source = materialListById(sourceListId);
    const target = materialListById(targetListId);
    if (!source || !target || state.saving || resourceType(source) !== resourceType(target) || cleanText(itemId) === cleanText(anchorItemId)) return;
    const same = source.id === target.id;
    const sourceItems = listItems(source);
    const targetItems = listItems(target);
    const item = sourceItems.find((entry) => cleanText(entry.id) === cleanText(itemId));
    if (!item) return;
    const nextItems = targetItems.filter((entry) => cleanText(entry.id) !== cleanText(itemId));
    const anchor = nextItems.findIndex((entry) => cleanText(entry.id) === cleanText(anchorItemId));
    nextItems.splice(anchor < 0 ? nextItems.length : anchor + (after ? 1 : 0), 0, item);
    if (same && nextItems.every((entry, index) => entry === targetItems[index])) return;
    state.saving = true;
    replaceListItems(target.id, nextItems);
    if (!same) replaceListItems(source.id, sourceItems.filter((entry) => cleanText(entry.id) !== cleanText(itemId)));
    syncMaterialsGrid();
    setWorkspaceSaving(true);
    try {
      await persistVersion({ reason: same ? 'revision' : 'supplement', items: nextItems }, { list: target, baseItems: targetItems });
      if (!same) {
        await persistVersion({ reason: 'removal', remove_item_ids: [item.id] }, { list: materialListById(source.id) || source, baseItems: sourceItems });
        showToast((globalThis.PlatformLanguage?.text("materials","m_599de4dbc508a0","List changed") ?? "List changed"), ((v0,v1) => globalThis.PlatformLanguage?.text("materials","m_dc3174ff4c2ae4",`${v0} moved to ${v1}.`,{v0,v1}) ?? `${v0} moved to ${v1}.`)(item.name || 'Item',target.title || resourceTerms(resourceType(target), target).list), true);
      }
    } catch (error) {
      replaceListItems(target.id, targetItems);
      if (!same) {
        replaceListItems(source.id, sourceItems);
        try {
          const currentTarget = materialListById(target.id);
          if (Number(currentTarget?.revision || 0) !== Number(target.revision || 0)) await persistVersion({ reason: 'removal', remove_item_ids: [item.id] }, { list: currentTarget, baseItems: targetItems });
        } catch (_) {}
      }
      showToast(same ? 'Could not reorder items' : (globalThis.PlatformLanguage?.text("materials","m_90625e9a36ebcb","Could not change list") ?? "Could not change list"), error?.message || 'Please try again.', false);
    } finally {
      state.saving = false;
      if (resourceType(target) === 'labor' && !same) await loadExpenseProjection();
      setWorkspaceSaving(false);
      syncMaterialsGrid();
    }
  }

  // Line item suggestions are always on; there is no switch.
  function autofillEnabled(){
    return true;
  }

  // Where a category's line item suggestions come from. Each entry reads data another app already owns; none is a fixed list.
  const LINE_ITEM_SOURCE_DEFS = [
    { id: 'pricebook', label: 'Price Book', detail: 'Items and variants from the price book' },
    { id: 'piece_rate', label: 'Piece Rate Items', detail: "Piece rates on the pay plan of the crew assigned to the list" },
    { id: 'hourly_labor', label: 'Hourly Labor', detail: "The hourly rate on the assigned crew's pay plan" },
    { id: 'equipment', label: 'Equipment', detail: 'Units and their daily rates from the Equipment app' }
  ];
  function categorySources(type){
    const category = resourceCategories().find((row) => row.id === type);
    return Array.isArray(category?.line_item_sources) ? category.line_item_sources : (({ material: ['pricebook'], labor: ['piece_rate', 'hourly_labor'], equipment: ['equipment'] })[type] || []);
  }
  function categorySkuOnly(type){
    const category = resourceCategories().find((row) => row.id === type);
    return typeof category?.pricebook_sku_only === 'boolean' ? category.pricebook_sku_only : type === 'material';
  }
  function loadEquipmentUnits(){
    if (state.equipmentUnits || state.equipmentUnitsLoading || !window.EquipmentAPI?.units || !orgId()) return;
    state.equipmentUnitsLoading = true;
    Promise.resolve(window.EquipmentAPI.units(orgId())).then((result) => { state.equipmentUnits = (Array.isArray(result?.units) ? result.units : []).filter((unit) => cleanText(unit.status) !== 'archived'); }).catch(() => { state.equipmentUnits = []; }).finally(() => { state.equipmentUnitsLoading = false; });
    if (window.EquipmentAPI.types) Promise.resolve(window.EquipmentAPI.types(orgId())).then((result) => { state.equipmentTypes = (Array.isArray(result?.types) ? result.types : []).filter((type) => cleanText(type.status) !== 'archived'); }).catch(() => { state.equipmentTypes = []; });
  }
  // What a unit or a type of equipment does for a job (debris disposal, so many cubic yards), copied onto the line it
  // is picked for so the project's requirements count the line as covering it.
  function equipmentProvides(value){
    return (Array.isArray(value) ? value : []).filter((entry) => cleanText(entry?.item)).map((entry) => ({ item: cleanText(entry.item), ...(typeof entry.capacity === 'number' && Number.isFinite(entry.capacity) && entry.capacity > 0 ? { capacity: entry.capacity } : {}), per_load: entry.per_load === true }));
  }
  // Suggestions for one list from the sources its category has switched on.
  // What kind of item a suggestion is, in words: its type when it has one, otherwise its category key read as a phrase.
  function autofillGroup(item){
    const type = cleanText(item?.type), category = cleanText(item?.category);
    const text = type && type !== category ? type : category.replace(/[_-]+/g, ' ');
    return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  }
  function autofillMatches(query, list){
    const tokens = cleanText(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length || !list) return [];
    const sources = categorySources(resourceType(list));
    const matches = (text) => tokens.every((token) => cleanText(text).toLowerCase().includes(token));
    const entries = [];
    const skuOnly = categorySkuOnly(resourceType(list));
    if (sources.includes('pricebook')) state.pricebookItems.forEach((item) => {
      if (skuOnly && !cleanText(item.code)) return;
      if (matches(`${item.name || ''} ${item.variantName || ''} ${item.category || ''}`)) entries.push({ label: item.name, group: autofillGroup(item), detail: `${money(item.unitPrice || 0)}/${item.unit || 'ea'}`, catalogItem: item });
    });
    const resource = sources.includes('piece_rate') || sources.includes('hourly_labor') ? laborSettings(list).resource : null;
    const plans = [resource?.compensation_plan, ...(Array.isArray(resource?.members) ? resource.members.map((member) => member?.compensation_plan) : [])].filter(Boolean);
    if (sources.includes('piece_rate')) {
      const seen = new Set();
      plans.flatMap((plan) => Array.isArray(plan.piece_rates) ? plan.piece_rates : []).forEach((rate) => {
        const key = cleanText(rate.id || rate.label);
        if (!key || seen.has(key) || !matches(rate.label)) return;
        seen.add(key);
        entries.push({ label: cleanText(rate.label), detail: `Piece rate · ${money(number(rate.rate_cents, 0) / 100)} per ${cleanText(rate.unit) || 'unit'}`, patch: { name: cleanText(rate.label), unit: cleanText(rate.unit) || 'unit', projected_unit_price: number(rate.rate_cents, 0) / 100, metadata: { compensation_kind: 'piece_rate', piece_rate_id: cleanText(rate.id) } } });
      });
    }
    if (sources.includes('hourly_labor')) {
      const hourly = plans.find((plan) => number(plan.hourly_rate_cents, 0) > 0);
      if (hourly && matches('Hourly labor hours')) entries.push({ label: 'Hourly labor', detail: `${cleanText(resource?.name) || 'Assigned crew'} · ${money(number(hourly.hourly_rate_cents, 0) / 100)} per hour`, patch: { name: 'Hourly labor', unit: 'hour', projected_unit_price: number(hourly.hourly_rate_cents, 0) / 100, metadata: { compensation_kind: 'hourly' } } });
    }
    if (sources.includes('equipment')) {
      loadEquipmentUnits();
      (state.equipmentUnits || []).forEach((unit) => {
        const name = cleanText(unit.name || unit.label);
        if (!name || !matches(name)) return;
        const daily = number(unit.rates?.daily_cents, 0);
        entries.push({ label: name, detail: daily > 0 ? `Equipment · ${money(daily / 100)} per day` : 'Equipment', patch: { name, unit: 'day', ...(daily > 0 ? { projected_unit_price: daily / 100 } : {}), metadata: { equipment_unit_id: cleanText(unit.id), equipment_type_id: cleanText(unit.type_id), provides: equipmentProvides(unit.effective_provides) } } });
      });
      (state.equipmentTypes || []).forEach((type) => {
        const name = cleanText(type.name);
        if (!name || !matches(name) || entries.some((entry) => entry.label === name)) return;
        const daily = number(type.default_rates?.daily_cents, 0);
        entries.push({ label: name, detail: daily > 0 ? `Equipment type · ${money(daily / 100)} per day` : 'Equipment type', patch: { name, unit: 'day', ...(daily > 0 ? { projected_unit_price: daily / 100 } : {}), metadata: { equipment_unit_id: '', equipment_type_id: cleanText(type.id), provides: equipmentProvides(type.provides) } } });
      });
    }
    return entries.slice(0, 8);
  }

  function closeSourcesMenu(){
    document.querySelectorAll?.('[data-mt-sources-portal]')?.forEach((node) => node.remove());
    document.removeEventListener?.('pointerdown', sourcesMenuDismiss, true);
    document.removeEventListener?.('keydown', sourcesMenuDismiss, true);
    state.sourcesMenu = null;
  }
  function sourcesMenuDismiss(event){
    if (event.type === 'keydown' ? event.key === 'Escape' : !event.target?.closest?.('[data-mt-sources-portal],[data-mt-category-sources]')) closeSourcesMenu();
  }
  // The per-category choice of which sources feed its suggestions; saved on the resource type for the whole company.
  function toggleSourcesMenu(type, trigger){
    const open = state.sourcesMenu === type;
    closeSourcesMenu();
    const category = resourceCategories().find((row) => row.id === type);
    if (open || !category || !trigger?.getBoundingClientRect) return;
    state.sourcesMenu = type;
    const portal = document.createElement('div');
    portal.className = 'mt-labor-portal';
    portal.dataset.mtSourcesPortal = '';
    portal.setAttribute('role', 'dialog');
    portal.setAttribute('aria-label', 'Line item sources');
    const draw = () => {
      const enabled = categorySources(type);
      portal.innerHTML = `<div class="mt-labor-menu-title">Line Item Sources</div><div class="mt-labor-options">${LINE_ITEM_SOURCE_DEFS.map((source) => `<button type="button" class="mt-labor-option${enabled.includes(source.id) ? ' active' : ''}" role="menuitemcheckbox" aria-checked="${enabled.includes(source.id)}" data-mt-source="${source.id}"><span><strong>${escapeHtml(source.label)}</strong><small>${escapeHtml(source.detail)}</small></span>${enabled.includes(source.id) ? '<i class="fas fa-check" aria-hidden="true"></i>' : ''}</button>${source.id === 'pricebook' && enabled.includes('pricebook') ? `<label class="mt-source-sub" title="Leave out price book items kept only for estimating, which have no SKU to order."><input type="checkbox" data-mt-source-sku ${categorySkuOnly(type) ? 'checked' : ''}> Only items with a SKU</label>` : ''}`).join('')}</div>`;
      portal.querySelector('[data-mt-source-sku]')?.addEventListener('change', (event) => { category.pricebook_sku_only = event.target.checked; if (!Array.isArray(category.line_item_sources)) category.line_item_sources = categorySources(type); saveResourceCategory(category); });
      portal.querySelectorAll('[data-mt-source]').forEach((button) => button.addEventListener('click', () => {
        const current = categorySources(type);
        category.line_item_sources = LINE_ITEM_SOURCE_DEFS.map((source) => source.id).filter((id) => (id === button.dataset.mtSource ? !current.includes(id) : current.includes(id)));
        saveResourceCategory(category);
        draw();
      }));
    };
    draw();
    colorPortalHost(state.panelRoot).appendChild(portal);
    const rect = trigger.getBoundingClientRect();
    const width = portal.offsetWidth || 300;
    const height = portal.offsetHeight || 220;
    portal.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
    portal.style.top = `${rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)}px`;
    document.addEventListener('pointerdown', sourcesMenuDismiss, true);
    document.addEventListener('keydown', sourcesMenuDismiss, true);
  }

  function closeAutofill(){
    document.querySelectorAll?.('[data-mt-autofill]')?.forEach((node) => node.remove());
    state.autofill = null;
  }

  // Suggests price book items under the name being typed; nothing is preselected, so Enter keeps the typed text unless an arrow key chose one.
  function showAutofill(input){
    closeAutofill();
    if (!autofillEnabled() || !input?.isConnected) return;
    const matches = autofillMatches(input.value, materialListById(input.dataset.mtListId));
    if (!matches.length) return;
    const portal = document.createElement('div');
    portal.className = 'mt-autofill';
    portal.dataset.mtAutofill = '';
    portal.setAttribute('role', 'listbox');
    portal.innerHTML = matches.map((item, index) => `<button type="button" role="option" tabindex="-1" aria-selected="false" data-mt-autofill-item="${index}"><strong>${escapeHtml(item.label)}</strong>${item.group ? `<em>${escapeHtml(item.group)}</em>` : ''}<span>${escapeHtml(item.detail)}</span></button>`).join('');
    colorPortalHost(state.panelRoot).appendChild(portal);
    const rect = input.getBoundingClientRect();
    portal.style.minWidth = `${Math.max(280, rect.width)}px`;
    portal.style.maxWidth = `${Math.max(280, Math.min(760, window.innerWidth - 16))}px`;
    const width = portal.offsetWidth;
    const height = portal.offsetHeight;
    portal.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left))}px`;
    portal.style.top = `${rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 2 : Math.max(8, rect.top - height - 2)}px`;
    state.autofill = { input, matches, index: -1, portal };
    portal.querySelectorAll('[data-mt-autofill-item]').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => commitItemName(input, matches[Number(button.dataset.mtAutofillItem)], false));
    });
  }

  function moveAutofill(step){
    const autofill = state.autofill;
    if (!autofill) return;
    const next = autofill.index + step;
    autofill.index = next >= autofill.matches.length ? -1 : next < -1 ? autofill.matches.length - 1 : next;
    autofill.portal.querySelectorAll('[data-mt-autofill-item]').forEach((button, index) => {
      button.setAttribute('aria-selected', String(index === autofill.index));
      if (index === autofill.index) button.scrollIntoView?.({ block: 'nearest' });
    });
  }

  // Commits a name cell: a chosen price book item replaces the line, typed text renames it, and Enter on a list's last row starts the next row.
  // Without addNext (Tab, or a clicked suggestion) focus moves to the row's count.
  function commitItemName(input, suggestion, addNext){
    const catalogItem = suggestion?.catalogItem || null;
    const itemId = input.dataset.mtItemName;
    const listId = input.dataset.mtListId;
    const list = materialListById(listId);
    const current = listItems(list).find((item) => cleanText(item.id) === cleanText(itemId));
    closeAutofill();
    if (!current) return;
    const last = cleanText(listItems(list).at(-1)?.id) === cleanText(itemId);
    const renamed = cleanText(input.value) !== cleanText(materialPrimaryName(current));
    if (catalogItem) {
      input.dataset.mtCommitted = '1';
      const quantity = integerQuantity(current.quantity, 0);
      const next = lineFromPricebookItem(catalogItem, quantity > 0 ? { quantity } : {});
      updateItem(itemId, { ...next, id: itemId, structure_id: current.structure_id || next.structure_id }, listId);
      syncMaterialsGrid();
    } else if (suggestion?.patch) {
      input.dataset.mtCommitted = '1';
      updateItem(itemId, suggestion.patch, listId);
    } else if (renamed) {
      input.dataset.mtCommitted = '1';
      updateItem(itemId, { name: input.value }, listId);
    }
    if (addNext && last && (suggestion || renamed)) { addItem(null, resourceType(list) === 'material' ? 'accessories' : resourceType(list), listId); return; }
    // Enter on typed text stays in the name. Tab and a picked suggestion go on to this row's count, found after the row was redrawn above.
    if (addNext && !suggestion) return;
    const count = findByData(materialRoot(), '[data-mt-item-qty]', 'mtItemQty', itemId);
    count?.focus?.();
    count?.select?.();
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
    const listId = cleanText(next?.scope_resource_list_id || fallbackList?.id);
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
        const listId = cleanText(draft?.scope_resource_list_id);
        if (listId && state.orderSelectedListIds.has(listId)) {
          state.orderScheduleFocusListId = listId;
          syncOrderDialog(true);
        }
      },
      onEventClick(event){
        const listId = cleanText(event?.scope_resource_list_id);
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
    const groups = orderSupplierGroups(selectedOrderLists());
    const unaddressed = groups.filter((group) => !group.choice.email);
    if (unaddressed.length) {
      showToast('Supplier needed', `Choose a supplier with an order email for ${unaddressed.flatMap((group) => group.lists.map((list) => cleanText(list.title) || 'Materials')).join(', ')}.`, false);
      return false;
    }
    if (!window.CommsAPI?.email?.send) {
      showToast('Email is unavailable here', 'Copy the email and send it from your own mail, then try again later.', false);
      return false;
    }
    state.saving = true;
    setWorkspaceSaving(true);
    materialRoot()?.querySelectorAll?.('[data-mt-order-dialog] button,[data-mt-order-dialog] input')?.forEach((control) => { control.disabled = true; });
    const emailed = [];
    try {
      for (const group of groups) {
        await window.CommsAPI.email.send(orgId(), projectId(), { to: group.choice.email, subject: orderRequestSubject(group.lists), text: orderRequestText(group.lists), html: orderRequestHtml(group.lists), idempotency_key: uid('material_order_email') });
        emailed.push(group.choice.name || group.choice.email);
      }
    } catch (error) {
      // Nothing is recorded unless every supplier was emailed; the dialog stays open with what was chosen.
      state.saving = false;
      setWorkspaceSaving(false);
      state.orderDraftFresh = true;
      syncOrderDialog(true);
      showToast('Could not send the email', `${emailed.length ? `Already sent to ${emailed.join(', ')}. ` : ''}${error?.message || 'Please try again.'}`, false);
      return false;
    }
    try {
      for (const originalList of lists) {
        let list = materialListById(originalList.id) || originalList;
        const choice = orderSupplierChoice(list);
        const leadsDelivery = !orderGroupTarget(list);
        let quotedCents = null;
        if (choice.target) {
          // What was ordered is the new projection: the supplier's prices replace the estimate, and the delivery fee
          // is added once per delivery as a line of its own.
          const quote = supplierQuote(choice.target, [list], false);
          const deliveryQuote = supplierQuote(choice.target, orderDeliveryLists(list), choice.delivery);
          const baseItems = listItems(list);
          const items = orderableItems(list).map((item) => {
            if (!quote.prices.has(item.id)) return item;
            const cents = quote.prices.get(item.id);
            return { ...item, projected_unit_price: cents / 100, projected_total: Math.round(cents * Math.max(0, number(item.quantity, 0))) / 100 };
          });
          const fee = leadsDelivery ? deliveryQuote.delivery : 0;
          if (fee > 0) items.push({ ...blankLine('accessories'), id: uid('delivery'), name: 'Delivery', quantity: 1, unit: 'ea', projected_unit_price: fee / 100, projected_total: fee / 100, metadata: { delivery_fee: true, resource_type: 'material', name_overridden: true, supplier_id: cleanText(choice.target.supplier.id) } });
          replaceListItems(list.id, items);
          await persistVersion({ reason: 'revision', items }, { list, baseItems });
          list = materialListById(list.id) || list;
          quotedCents = quote.subtotal == null ? null : quote.subtotal + fee;
        }
        let scheduledEvent = null;
        let scheduledWindow = {};
        const when = orderSchedule(list);
        const clock = orderTimeClock(when.time);
        if (cleanText(when.date)) {
          const scheduled = await persistInlineDeliverySchedule(list, { date: cleanText(when.date), time: clock, all_day: !clock });
          list = scheduled.list || list;
          scheduledEvent = scheduled.event;
          scheduledWindow = {
            date: cleanText(when.date),
            start_date: cleanText(when.date),
            time: clock,
            start_time: clock,
            time_label: cleanText(when.time),
            start_at: scheduled.start.toISOString(),
            end_at: scheduled.end.toISOString(),
            precision: scheduled.allDay ? 'day' : 'datetime',
            timezone: Intl.DateTimeFormat(globalThis.PlatformLanguage?.formatLocale?.()).resolvedOptions().timeZone || ''
          };
        }
        const payload = {
          title: cleanText(list.title) || 'Material order',
          order_source_id: cleanText(state.orderProvider) || defaultOrderSourceId(list),
          vendor: { name: choice.target ? cleanText(choice.target.supplier.name) : choice.email, email: choice.email },
          scheduled_window: scheduledWindow,
          schedule_event_id: cleanText(scheduledEvent?.id),
          delivery_status: cleanText(when.date) ? 'scheduled' : 'unscheduled',
          quoted_price: quotedCents == null ? undefined : { amount: quotedCents / 100, currency: 'USD' },
          metadata: {
            source: 'materials_tab_manual_order',
            schedule_event_id: cleanText(scheduledEvent?.id),
            supplier_id: cleanText(choice.target?.supplier.id),
            supplier_location_id: cleanText(choice.target?.location?.id),
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
          const result = await (materialsAPI || window.MaterialsAPI).lists.createOrder(orgId(), list.id, {
            expected_revision: list.revision,
            ...payload
          });
          updateMaterialListState(result.material_list || result.list || list);
        }
      }
      showToast(lists.length === 1 ? 'Order recorded' : `${lists.length} orders recorded`, `Emailed ${emailed.join(', ')}.`, true);
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
        await (materialsAPI || window.MaterialsAPI).orders.recordDelivery(orgId(), orderId, {
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
    columnWeights();
    if (!state.suppliers && !state.suppliersLoading) loadSuppliers().then(() => { if (!workspaceIsEditing()) syncMaterialsGrid(); });
    loadEquipmentUnits();
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

  function resourceScrollPositions(root){
    return Array.from(root?.querySelectorAll('.mt-resource-column') || []).map((column) => {
      const scroll = column.querySelector('.mt-resource-scroll');
      return { type:column.dataset.resourceType, top:scroll?.scrollTop || 0, left:scroll?.scrollLeft || 0 };
    });
  }

  function restoreResourceScroll(root, positions){
    positions.forEach((position) => {
      const scroll = root?.querySelector(`.mt-resource-column[data-resource-type="${position.type}"] .mt-resource-scroll`);
      if (scroll) { scroll.scrollTop = position.top; scroll.scrollLeft = position.left; }
    });
  }

  function render(options = {}){
    const timingStart = performance.now();
    if (!state.panelRoot) return;
    closeListMenu();
    const previousResourceScroll = options.preserveScroll ? resourceScrollPositions(state.panelRoot) : [];
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
      <div class="mt-body">
        <main class="mt-main">
          ${renderResourceHeader()}
          ${String(state.loading ? `<div class="mt-card"><p>${(globalThis.PlatformLanguage?.htmlText("materials","m_7b94d3b02679a9","Loading scope...") ?? "Loading scope...")}</p></div>` : '')}
          ${String(state.lastError ? `<div class="mt-card"><p>${escapeHtml(state.lastError)}</p></div>` : '')}
          <div class="mt-material-scroll" data-mt-material-scroll>
            <div class="mt-material-grid" data-mt-material-grid>
              ${String(renderMaterialSections())}
            </div>
          </div>
          
          ${String(state.pricebookOpen && activeType === 'material' ? renderPricebookPanel() : '')}
        </main>
      </div>
      ${String(activeType === 'material' ? renderOrderDialog() : '')}
      ${String(renderNewListDialog())}
    `;
    timingMark('render:innerHTML', { items: listItems().length, pricebookOpen: state.pricebookOpen, loading: state.loading }, htmlStart);
    const bindStart = performance.now();
    bindMain(root);
    bindLeft(root);
    bindResourceActions(root);
    bindRequirements(root);
    restoreResourceScroll(root, previousResourceScroll);
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
      { kind:'cost_rate', title:'Salaried time', icon:'fa-calendar-check' },
      { kind:'hourly', title:(globalThis.PlatformLanguage?.text("materials","m_e05a1e64b972f8","Hourly wages") ?? "Hourly wages"), icon:'fa-clock' },
      { kind:'piece_rate', title:(globalThis.PlatformLanguage?.text("materials","m_4c9b3b4cfd52b2","Piece-rate work") ?? "Piece-rate work"), icon:'fa-list-check' }
    ].map((group) => ({ ...group, rows:details.filter((detail) => cleanText(detail?.kind) === group.kind) })).filter((group) => group.rows.length);
    const total = number(target?.projected_cents, projection?.projected_cents || 0);
    const resourceName = cleanText(projection?.work_resource_ref?.name);
    if (state.expenseError) return `<section class="mt-labor-estimate"><div class="mt-labor-estimate-head"><div><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_64da48200b02da","Estimated labor expense") ?? "Estimated labor expense")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("materials","m_ce86fe78082565","Unavailable") ?? "Unavailable")}</span></div></div><div class="mt-empty">${((v0) => globalThis.PlatformLanguage?.htmlText("materials","m_894fbe7ce53443",`${v0} Refresh the project before relying on this estimate.`,{v0}) ?? `${v0} Refresh the project before relying on this estimate.`)(escapeHtml(state.expenseError))}</div></section>`;
    return `<section class="mt-labor-estimate">
      <div class="mt-labor-estimate-head"><div><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_64da48200b02da","Estimated labor expense") ?? "Estimated labor expense")}</strong><span>${String(escapeHtml(resourceName || (state.expenseLoading ? 'Updating estimate...' : `Not assigned`)))}</span></div><strong>${String(money(total / 100))}</strong></div>
      ${String(groups.length ? `<div class="mt-labor-breakdown">${groups.map((group) => `<div class="mt-labor-breakdown-group"><div class="mt-labor-breakdown-title"><span><i class="fas ${escapeHtml(group.icon)}"></i>${escapeHtml(group.title)}</span><strong>${money(group.rows.reduce((sum, row) => sum + number(row.projected_cents, 0), 0) / 100)}</strong></div>${group.rows.map((detail) => `<div class="mt-labor-breakdown-row"><div><strong>${escapeHtml(detail.label || titleFromKey(detail.kind))}</strong><span>${escapeHtml(laborDetailMeta(detail))}</span></div><strong>${money(number(detail.projected_cents, 0) / 100)}</strong></div>`).join('')}</div>`).join('')}</div>` : `<div class="mt-empty">Price this list's lines, or generate it from the assignee's pay sheet, to see the breakdown.</div>`)}
    </section>`;
  }

  function renderSectionTab(id, label, icon){
    return `<button type="button" class="mt-section-tab${state.selectedSection === id ? ' active' : ''}" data-mt-section="${escapeHtml(id)}"><i class="fas ${escapeHtml(icon)}"></i>${escapeHtml(label)}</button>`;
  }

  function resourceCategories(){
    for(const category of state.resourceTypes||[])if(!category.__saved)category.__saved={name:category.name,icon:category.icon,color:category.color};return state.resourceTypes||[];
  }
  function materialSectionDefinitions(){
    const defs=[...SECTION_DEFS,...resourceCategories().filter(row=>row.id!=='material').map(row=>({key:row.id,title:row.name||'Untitled',icon:row.icon,resource_type:row.id}))];
    const known=new Set(defs.map(row=>row.key));filteredItems().forEach(item=>{const key=lineSectionKey(item);if(!known.has(key)){known.add(key);defs.push({key,title:key.replace(/_/g,' '),icon:'fa-box',resource_type:resourceType(materialListById(item.__material_list_id))});}});return defs;
  }
  const resourceWriteQueue=new Map();
  function saveResourceCategory(category,create=false){
    const operation=captureProjectOperation(),previous=resourceWriteQueue.get(category.id)||Promise.resolve();
    const next=previous.catch(()=>{}).then(async()=>{const input={id:category.id,name:category.name||'',icon:category.icon,color:category.color,...(Array.isArray(category.line_item_sources)?{line_item_sources:category.line_item_sources}:{}),...(typeof category.pricebook_sku_only==='boolean'?{pricebook_sku_only:category.pricebook_sku_only}:{}),...(!create?{expected_revision:category.revision||0}:{})};const result=await window.MaterialsAPI.resourceTypes[create?'create':'patch'](operation.orgId,...(create?[input]:[category.id,input]));if(projectOperationIsCurrent(operation)){category.revision=result.resource_type.revision;category.__saved={name:input.name,icon:input.icon,color:input.color};if(!workspaceIsEditing())syncMaterialsGrid();}return result;});
    resourceWriteQueue.set(category.id,next);next.catch(error=>{if(projectOperationIsCurrent(operation)){if(create)state.resourceTypes=state.resourceTypes.filter(row=>row!==category);else if(resourceWriteQueue.get(category.id)===next&&category.__saved)Object.assign(category,category.__saved);syncMaterialsGrid();showToast('Could not save resource type',error.message,false);}});return next;
  }
  function addResourceCategory(){
    const category={id:'resource_'+crypto.randomUUID().replaceAll('-',''),name:'',icon:'fa-layer-group',color:companyPrimaryColor(),revision:0};state.resourceTypes.push(category);syncMaterialsGrid();const input=materialRoot()?.querySelector(`[data-mt-category-name="${category.id}"]`);input?.focus();saveResourceCategory(category,true);
  }
  async function createInlineList(type){
    if(state.creatingList||state.saving)return;const operation=captureProjectOperation(),category=resourceCategories().find(row=>row.id===type);if(!category)return;state.creatingList=true;
    let finish;state.creatingListDone=new Promise(resolve=>finish=resolve);
    try{const result=await (materialsAPI||window.MaterialsAPI).projects.create(operation.orgId,operation.projectId,{title:'',resource_type:type,color:category.color,branch_id:branchId(),sections:[],items:[],metadata:{source:'scope_tab',manually_created:true,placeholder_title:true}});if(!projectOperationIsCurrent(operation))return;const list=updateMaterialListState(result.material_list||result.list);if(!list)throw Error('The list was not returned.');state.visibleListIds.add(list.id);syncMaterialsGrid();materialRoot()?.querySelector(`[data-mt-list-name="${list.id}"]`)?.focus();}
    catch(error){if(projectOperationIsCurrent(operation))showToast('Could not create list',error.message,false);}finally{if(projectOperationIsCurrent(operation))state.creatingList=false;finish();}
  }
  async function removeResourceCategory(type){
    const category=resourceCategories().find(row=>row.id===type);if(!category||state.saving)return;
    const name=category.name||'this resource type',operation=captureProjectOperation();
    if(state.lists.some(list=>resourceType(list)===type)){showToast('Delete its lists first',`${name} still has lists in this project.`,false);return;}
    if(!await confirmAction(`Remove ${name}? It is removed for every project in this company.`)||!projectOperationIsCurrent(operation))return;
    try{await (resourceWriteQueue.get(type)||Promise.resolve()).catch(()=>{});await window.MaterialsAPI.resourceTypes.archive(operation.orgId,type,{expected_revision:category.revision||0});
      if(!projectOperationIsCurrent(operation))return;state.resourceTypes=state.resourceTypes.filter(row=>row.id!==type);state.minimizedTypes.delete(type);syncMaterialsGrid();}
    catch(error){if(projectOperationIsCurrent(operation))showToast('Could not remove resource type',error?.message||'Please try again.',false);}
  }
  function editResourceAppearance(type){
    const category=resourceCategories().find(row=>row.id===type);if(!category||!window.FirstMateWidgets)return;
    const dialog=document.createElement('dialog');dialog.className='mt-icon-dialog';dialog.style.cssText='max-width:520px;width:calc(100vw - 32px);padding:12px';const close=document.createElement('button');close.type='button';close.textContent='Close';close.style.cssText='float:right';close.onclick=()=>dialog.close();const stage=document.createElement('div');dialog.append(close,stage);materialRoot().append(dialog);const widget=window.FirstMateWidgets.mount(stage,{id:'icon.picker',version:'1',config:{prompt:'Icon and color',includeColor:true,value:category.icon,color:category.color}},{surface:'project',onSelect:(selection,detail)=>{if(!detail.confirmed)return;category.icon=selection.value;category.color=selection.color;saveResourceCategory(category);dialog.close();}});dialog.onclose=()=>{widget.destroy();dialog.remove();};dialog.showModal();
  }

  function bindResourceActions(root){
    if(!root)return;
    root.querySelectorAll('[data-mt-new-category]').forEach(button=>button.onclick=addResourceCategory);
    root.querySelectorAll('[data-mt-schedule-job]').forEach(button=>button.onclick=()=>scheduleJob());
    root.querySelectorAll('[data-mt-units-toggle]').forEach(button=>button.onclick=()=>{state.unitsMode=state.unitsMode==='order'?'measured':'order';render({preserveScroll:true});});
    root.querySelectorAll('[data-mt-minimize-type],[data-mt-restore-type]').forEach(button=>button.onclick=()=>{const minimizing=!!button.dataset.mtMinimizeType,type=button.dataset.mtMinimizeType||button.dataset.mtRestoreType,source=minimizing?button.closest('.mt-resource-column'):button,from=source.getBoundingClientRect(),clone=minimizing?source.cloneNode(true):null;if(minimizing)state.minimizedTypes.add(type);else state.minimizedTypes.delete(type);syncMaterialsGrid();animateMinimize(type,from,minimizing,clone);});
    root.querySelectorAll('[data-mt-category-sources]').forEach(button=>button.onclick=()=>toggleSourcesMenu(button.dataset.mtCategorySources,button));
    root.querySelectorAll('[data-mt-generate-column]').forEach(button=>button.onclick=()=>{if(state.generatingMaterials)return;button.disabled=true;button.querySelector('i')?.classList.replace('fa-wand-magic-sparkles','fa-rotate');button.querySelector('i')?.classList.add('mt-spin');setTimeout(()=>regenerateMaterialListsFromScope({resourceType:button.dataset.mtGenerateColumn}),0);});
    root.querySelectorAll('[data-mt-delete-type]').forEach(button=>button.onclick=()=>removeResourceCategory(button.dataset.mtDeleteType));
    root.querySelectorAll('[data-mt-new-category-list]').forEach(button=>button.onclick=()=>createInlineList(button.dataset.mtNewCategoryList));
    root.querySelectorAll('[data-mt-category-icon]').forEach(button=>button.onclick=()=>editResourceAppearance(button.dataset.mtCategoryIcon));
    root.querySelectorAll('[data-mt-category-name]').forEach(input=>{input.oninput=()=>{const category=resourceCategories().find(row=>row.id===input.dataset.mtCategoryName);if(category)category.name=input.value;};input.onchange=()=>{const category=resourceCategories().find(row=>row.id===input.dataset.mtCategoryName);if(category){category.name=input.value.trim();saveResourceCategory(category);}};});
    root.querySelectorAll('[data-mt-list-name]').forEach(input=>{input.onchange=async()=>{const id=input.dataset.mtListName,operation=captureProjectOperation(id);try{await patchScopeResourceList(id,{title:input.value.trim(),metadata:{...materialListById(id)?.metadata,placeholder_title:false}},operation);if(projectOperationIsCurrent(operation))syncMaterialsGrid();}catch(error){if(projectOperationIsCurrent(operation)){syncMaterialsGrid();showToast('Could not rename list',error.message,false);}}};
      input.onkeydown=async event=>{if(event.key!=='Enter')return;event.preventDefault();const id=input.dataset.mtListName,type=resourceType(materialListById(id));if(input.value!==input.defaultValue)await input.onchange();addItem(null,type==='material'?'accessories':type,id);};});
    root.querySelectorAll('[data-mt-restore-list],[data-mt-collapse-list],[data-mt-delete-list]').forEach(button=>{
      button.onclick=async()=>{
        const id=button.dataset.mtRestoreList||button.dataset.mtCollapseList||button.dataset.mtDeleteList;
        if(button.dataset.mtRestoreList){state.visibleListIds.add(id);syncMaterialsGrid();return;}
        if(button.dataset.mtCollapseList){if(state.collapsedListIds.has(id))state.collapsedListIds.delete(id);else state.collapsedListIds.add(id);syncMaterialsGrid();return;}
        const operation=captureProjectOperation(),list=materialListById(id);
        if(!list||state.saving||!await confirmAction(`Delete ${list.title||'this list'}?`))return;
        if(!projectOperationIsCurrent(operation))return;
        button.disabled=true;
        try{await materialsAPI.lists.archive(operation.orgId,id,{expected_revision:list.revision,reason:'Removed in Project'});
          if(!projectOperationIsCurrent(operation))return;
          state.lists=state.lists.filter(row=>row.id!==id);state.visibleListIds.delete(id);refreshRequirements();
          if(state.activeListId===id){state.activeList=state.lists[0]||null;state.activeListId=state.activeList?.id||'';}
          render({preserveScroll:true});renderLeft();
        }catch(error){if(projectOperationIsCurrent(operation))showToast('Could not delete list',error.message,false);}
        finally{button.disabled=false;}
      };
    });
  }
  // What has been committed on this project, read once and again whenever a list changes.
  function laborCommitments(){
    const api = (materialsAPI || window.MaterialsAPI)?.labor, key = `${orgId()}:${projectId()}`;
    if (state.laborCommitments?.key === key) return state.laborCommitments.rows;
    if (!api?.commitments || !apiReady() || !projectId()) return [];
    const entry = state.laborCommitments = { key, rows: [] };
    Promise.resolve(api.commitments(orgId(), projectId())).then((result) => { entry.rows = Array.isArray(result?.commitments) ? result.commitments : []; if (state.laborCommitments === entry) syncResourceHeader(); }).catch(() => {});
    return entry.rows;
  }
  // A labor list has been sent when its newest commitment is still held, was delivered, and froze the list as it is now.
  function laborListDelivered(list){
    const current = laborCommitments().filter((entry) => cleanText(entry.list_id) === cleanText(list?.id)).sort((a, b) => number(b.revision, 0) - number(a.revision, 0))[0];
    return !!current && current.status === 'committed' && current.delivery?.status === 'delivered' && number(current.list_revision, -1) === number(list?.revision, -2);
  }
  // Whether each header action has nothing left to do: every list of its kind is ordered, sent or reserved.
  function headerDone(){
    const lists = (type) => state.lists.filter((list) => resourceType(list) === type && listItems(list).length);
    const every = (type, test) => lists(type).length > 0 && lists(type).every(test);
    return {
      material: every('material', materialListOrdered),
      labor: every('labor', laborListDelivered),
      equipment: every('equipment', (list) => !resourceSchedulePending(list) && !!eventDateParts(linkedScheduleEvent(list)).date)
    };
  }
  // What on this project the schedule is still waiting for: a piece of work with no dates, or a list with none. Every
  // list that has something on it has to end up on the schedule, whether or not a scope said how.
  function jobSchedule(){
    const Scheduling = rootWindow.PlatformScheduling;
    const events = (Array.isArray(state.project?.events) ? state.project.events : []).filter((event) => !['cancelled', 'canceled'].includes(cleanText(event?.status).toLowerCase()));
    const isSpan = (event) => Scheduling?.eventIsSpan ? Scheduling.eventIsSpan(event) : cleanText(event?.kind) === 'schedule_group';
    const isScheduled = (event) => Scheduling?.eventIsScheduled ? Scheduling.eventIsScheduled(event) : cleanText(event?.status) !== 'unscheduled' && !!cleanText(event?.start_at);
    const spans = events.filter(isSpan), waiting = spans.find((span) => !isScheduled(span)) || null;
    const lists = state.lists.filter((list) => listItems(list).length);
    const pendingLists = lists.filter((list) => !eventDateParts(linkedScheduleEvent(list)).date);
    return { waiting, pendingLists, done: (spans.length > 0 || lists.length > 0) && !waiting && !pendingLists.length };
  }
  function scheduleJobButton(){
    if (!state.lists.some((list) => listItems(list).length)) return '';
    const done = jobSchedule().done, busy = !!state.schedulingJob;
    return `<button type="button" class="mt-schedule-job${done ? ' is-done' : ''}${busy ? ' is-busy' : ''}" data-mt-schedule-job data-fm-tooltip="${done ? 'Scheduled. Open the schedule to see or move it.' : 'Schedule this job: place the work, its equipment and its deliveries on the calendar'}"><i class="fas ${busy ? 'fa-circle-notch mt-spin' : done ? 'fa-check' : 'fa-calendar-days'}" aria-hidden="true"></i><span>${done ? 'Scheduled' : 'Schedule'}</span></button>`;
  }
  // Starts placing one thing on the schedule beside the lists. It is asked for once: the schedule remembers what is
  // being placed and shows it as soon as it has read the project, and asking twice would switch placing off again.
  function startPlacing(payload){
    const panel = rootWindow.Portal?.modules?.projectSchedule || rootWindow.Portal?.ProjectScheduleApp;
    if (!panel?.focusMaterialDelivery) { showToast('Schedule unavailable', 'The schedule could not be opened here. Open the Schedule tab to place this job.', false); return; }
    if (panel.context?.()?.mode === 'materials' && state.placingEventId === payload.event_id) return;
    state.placingEventId = payload.event_id;
    panel.focusMaterialDelivery(payload);
    // If the schedule still is not placing anything shortly after, say where the job can be picked up.
    setTimeout(() => { if (panel.context?.()?.mode !== 'materials') showToast('Choose it on the schedule', 'Pick this job from Waiting at the top of the schedule to place it.', false); }, 2500);
  }
  // Opens the Schedule view beside the lists and starts placing whatever is still waiting for dates. A piece of work a
  // scope planned is placed whole, with its equipment and deliveries. Lists the scope did not make (a signed document's
  // material, a work order made here) are given their events first: the server puts them under the job their scope
  // defines, and that job is what is placed. Only when nothing groups them is each list placed by hand, which is said
  // first.
  async function scheduleJob(){
    if (state.schedulingJob) return;
    const job = jobSchedule(), operation = captureProjectOperation();
    scopeWorkspace?.showSidebarView?.(leftContentRoot(), 'schedule');
    if (job.done) { showToast('Already scheduled', 'Everything on this job has dates. Move it on the schedule if it needs to change.'); return; }
    state.schedulingJob = true;
    syncResourceHeader();
    let payload = job.waiting ? { event_id: cleanText(job.waiting.id) } : null, span = cleanText(job.waiting?.id);
    try {
      // Every list that has no schedule item yet gets one, so all of them wait on the schedule; the work goes first.
      const order = ['labor', 'equipment', 'material'];
      const pending = [...job.pendingLists].sort((first, second) => order.indexOf(resourceType(first)) - order.indexOf(resourceType(second)));
      for (const list of pending) {
        const ensured = await ensureScheduleEventForList(list);
        if (!projectOperationIsCurrent(operation)) return;
        if (!span && cleanText(ensured?.event?.parent_event_id)) span = cleanText(ensured.event.parent_event_id);
        if (!payload && ensured?.event?.id) payload = schedulingFocusPayload(ensured.list || list, ensured.event);
      }
    } catch (error) {
      if (projectOperationIsCurrent(operation)) showToast('Could not start scheduling', error?.message || 'Please try again.', false);
      return;
    } finally {
      state.schedulingJob = false;
      if (projectOperationIsCurrent(operation)) syncResourceHeader();
    }
    if (span) payload = { event_id: span };
    else {
      const signed = (state.scopeDocuments || []).some((document) => document?.source === 'document');
      const approved = await confirmAction(signed
        ? 'This project\'s scope does not say how its work, equipment and deliveries fit together, so they cannot be placed as one job. Schedule each list by hand instead?'
        : 'No document has been signed for this project, so nothing says how its work, equipment and deliveries fit together. Schedule each list by hand instead?', { title: 'Schedule by hand?', confirmLabel: 'Schedule by hand', cancelLabel: 'Not now' });
      if (!approved || !projectOperationIsCurrent(operation)) return;
    }
    if (!payload) { showToast('Nothing to place', 'These lists could not be put on the schedule. Open the Schedule tab and add them there.', false); return; }
    // The schedule reads the project again so it has what was just created, then placing starts.
    try { rootWindow.dispatchEvent(new CustomEvent('fm:project-schedule:external', { detail: { project_id: projectId() } })); } catch (_) {}
    state.placingEventId = '';
    setTimeout(() => startPlacing(payload), 320);
  }
  // The schedule saves on its own; when it does, the header reads the project's dates again.
  function syncScheduleState(){
    const current = rootWindow.activeBaseProject;
    if (!state.panelRoot || !current || cleanText(current.id) !== projectId() || !Array.isArray(current.events)) return;
    state.project = { ...(state.project || {}), events: current.events };
    syncResourceHeader();
  }
  rootWindow.addEventListener('fm:calendar:refresh', () => setTimeout(syncScheduleState, 60));
  rootWindow.addEventListener('fm:projects:refresh', () => setTimeout(syncScheduleState, 60));
  function renderResourceHeader(){
    const order=state.unitsMode==='order';
    // An action exists only while its category has items. It slides in when the first item arrives and out when the last goes.
    const has=type=>state.lists.some(list=>resourceType(list)===type&&listItems(list).length);
    const want={material:has('material'),labor:has('labor'),equipment:has('equipment')},shown=state.headerActions||want;
    // An action with nothing left to do turns green and shows a check.
    const done=headerDone();
    const action=(key,attributes,icon)=>want[key]||shown[key]?`<button type="button" class="mt-header-action${key==='material'?' mt-order-all':''}${done[key]?' is-done':''}${want[key]?(shown[key]?'':' is-entering'):' is-leaving'}" ${attributes}><i class="fas ${done[key]?'fa-check':icon}"></i></button>`:'';
    const leaving=Object.keys(want).some(key=>shown[key]&&!want[key]);
    state.headerActions=want;
    if(leaving)setTimeout(()=>syncResourceHeader(),300);
    return `<header class="mt-workspace-header"><div class="mt-projected-total" title="Projected cost of every list on this project, including projected delivery"><span>Projected total</span><strong data-mt-projected-total>${money(projectProjected())}</strong></div><div class="mt-collapsed-pills">${resourceCategories().filter(category=>state.minimizedTypes?.has(category.id)&&!(category.id==='equipment'&&workOrderMerged())).map(category=>`<button type="button" data-mt-restore-type="${escapeHtml(category.id)}" style="--tab-color:${escapeHtml(category.color)}" data-fm-tooltip="Show ${escapeHtml(category.name||'Untitled')}" aria-label="Show ${escapeHtml(category.name||'Untitled')}"><i class="fas ${escapeHtml(category.icon)}"></i> ${escapeHtml(category.name||'Untitled')}</button>`).join('')}${state.lists.filter(list=>!state.visibleListIds.has(cleanText(list.id))).map(list=>`<button type="button" data-mt-restore-list="${escapeHtml(list.id)}" title="Expand ${escapeHtml(list.title)}"><i class="fas ${escapeHtml(resourceTerms(resourceType(list),list).icon)}"></i> ${escapeHtml(list.title)}</button>`).join('')}</div><div class="mt-workspace-actions"><button type="button" data-mt-new-category data-fm-tooltip="New category column" aria-label="New category"><i class="fas fa-plus"></i> Category</button><span class="mt-icon-toggles"><button type="button" data-mt-units-toggle aria-pressed="${order}" data-fm-tooltip="${order?'Units: order (bundles, boxes). Click for measured units.':'Units: measured. Click for order units (bundles, boxes).'}" aria-label="Units: ${order?'order':'measured'}. Switch."><i class="fas ${order?'fa-boxes-stacked':'fa-ruler-combined'}"></i></button><button type="button" data-mt-generate-materials data-fm-tooltip="Regenerate: build the lists again from the scope" aria-label="Regenerate lists from the scope" ${state.generatingMaterials||state.saving?'disabled':''}><i class="fas ${state.generatingMaterials?'fa-rotate mt-spin':'fa-wand-magic-sparkles'}"></i></button></span>${action('labor',`data-mt-work-order data-fm-tooltip="${done.labor?'Work Order: every work order has been committed and delivered as it stands':'Work Order: generate a work order for the labor on this project'}" aria-label="Work Order: generate a work order"`,'fa-clipboard-list')}${action('equipment','data-mt-reserve-equipment data-fm-tooltip="Reserve Equipment: reserve the equipment on this project" aria-label="Reserve Equipment"','fa-truck-pickup')}${action('material','data-mt-order-all data-fm-tooltip="Order Materials: order every material list, each from its own supplier" aria-label="Order Materials: order every material list"','fa-cart-shopping')}${scheduleJobButton()}${closeoutButton()}</div></header>`;
  }
  function syncResourceHeader(){
    const header=materialRoot()?.querySelector('.mt-workspace-header');
    if(!header)return;const holder=document.createElement('div');holder.innerHTML=renderResourceHeader();const next=holder.firstElementChild;header.replaceWith(next);bindLeft(next);bindResourceActions(next);
  }
  function columnWeights(){
    if(!state.columnWeights){state.columnWeights={};try{Object.assign(state.columnWeights,JSON.parse(rootWindow.localStorage?.getItem?.('fm_scope_column_weights')||'{}'));}catch(_){}}
    return state.columnWeights;
  }
  // Two adjacent columns trade width; their combined share of the row is unchanged.
  function resizeColumns(divider,delta,commit=false){
    const left=divider.previousElementSibling,right=divider.nextElementSibling;if(!left?.dataset?.resourceType||!right?.dataset?.resourceType)return;
    const weights=columnWeights(),weightOf=column=>Number(weights[column.dataset.resourceType])>0?Number(weights[column.dataset.resourceType]):1,start=divider.__start||(divider.__start={left:left.getBoundingClientRect().width,right:right.getBoundingClientRect().width,total:weightOf(left)+weightOf(right)});
    if(!(start.left+start.right>0))return;
    const span=start.left+start.right,minimum=Math.min(140,span/2),width=Math.max(minimum,Math.min(span-minimum,start.left+delta));
    weights[left.dataset.resourceType]=start.total*width/span;weights[right.dataset.resourceType]=start.total*(span-width)/span;
    left.style.setProperty('--column-weight',weights[left.dataset.resourceType]);right.style.setProperty('--column-weight',weights[right.dataset.resourceType]);
    if(commit){divider.__start=null;try{rootWindow.localStorage?.setItem?.('fm_scope_column_weights',JSON.stringify(weights));}catch(_){}}
  }
  function bindColumnDividers(root){
    root.querySelectorAll('.mt-column-divider').forEach(divider=>{
      divider.onpointerdown=event=>{if(event.button)return;event.preventDefault();const origin=event.clientX;divider.__start=null;divider.setPointerCapture?.(event.pointerId);divider.classList.add('is-dragging');
        divider.onpointermove=move=>resizeColumns(divider,move.clientX-origin);
        divider.onpointerup=divider.onpointercancel=up=>{resizeColumns(divider,up.clientX-origin,true);divider.onpointermove=divider.onpointerup=divider.onpointercancel=null;divider.classList.remove('is-dragging');};};
      divider.onkeydown=event=>{if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();divider.__start=null;resizeColumns(divider,event.key==='ArrowLeft'?-24:24,true);};
      divider.ondblclick=()=>{const weights=columnWeights();for(const column of [divider.previousElementSibling,divider.nextElementSibling]){delete weights[column.dataset.resourceType];column.style.removeProperty('--column-weight');}try{rootWindow.localStorage?.setItem?.('fm_scope_column_weights',JSON.stringify(weights));}catch(_){}};
    });
  }
  // Minimizing sends the column into its tab and restoring brings it back out, so it is clear where it went.
  function animateMinimize(type,from,minimizing,clone){
    if(!from||rootWindow.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)return;
    const root=materialRoot(),find=(selector,key)=>Array.from(root?.querySelectorAll?.(selector)||[]).find(node=>node.dataset[key]===type);
    const tab=minimizing?find('[data-mt-restore-type]','mtRestoreType'):null,column=minimizing?null:find('.mt-resource-column','resourceType');
    const target=tab||column;if(!target)return;
    // The ghost is the column itself, laid over its full-size position and scaled into (or out of) the tab.
    const to=target.getBoundingClientRect(),full=minimizing?from:to,small=minimizing?to:from,ghost=document.createElement('div');
    if(!(full.width>0&&full.height>0))return;
    ghost.className='mt-minimize-ghost'+(minimizing?'':' is-restoring');ghost.append(minimizing?clone:column.cloneNode(true));
    Object.assign(ghost.style,{left:full.left+'px',top:full.top+'px',width:full.width+'px',height:full.height+'px'});
    ghost.style.setProperty('--dx',(small.left-full.left)+'px');ghost.style.setProperty('--dy',(small.top-full.top)+'px');ghost.style.setProperty('--sx',small.width/full.width);ghost.style.setProperty('--sy',small.height/full.height);
    if(column)column.style.visibility='hidden';
    // The project window is a high fixed layer, so the ghost must live inside it to be visible.
    colorPortalHost(state.panelRoot).append(ghost);
    let finished=false;const finish=()=>{if(finished)return;finished=true;ghost.remove();if(column)column.style.visibility='';if(tab?.isConnected){tab.classList.add('is-receiving');tab.addEventListener('animationend',()=>tab.classList.remove('is-receiving'),{once:true});}};
    ghost.addEventListener('animationend',finish,{once:true});setTimeout(finish,700);
  }
  function workOrderMerged(){ return resourceCategories().some(row=>row.id==='labor'); }
  function renderMaterialSections(){
    const items = filteredItems();
    // Labor and the equipment it takes are one work order: who does the work, what they are paid and what they use.
    const types = resourceCategories().map(row=>row.id).filter(type=>!state.minimizedTypes?.has(type)&&!(type==='equipment'&&workOrderMerged()));
    const allEmpty = !items.length;
    return types.map((type) => {
      const merged=type==='labor'&&workOrderMerged(),members=merged?['labor','equipment']:[type];
      const rows = items.filter((item) => members.includes(resourceType(materialListById(item.__material_list_id))));
      const category=resourceCategories().find(row=>row.id===type);
      const terms = resourceTerms(type, state.lists.find((list) => resourceType(list) === type));
      const lists=state.lists.filter(list=>members.includes(resourceType(list))&&state.visibleListIds.has(cleanText(list.id))).sort((a,b)=>members.indexOf(resourceType(a))-members.indexOf(resourceType(b)));
      const listTotal=list=>listProjected(list);
      const weight=Number(state.columnWeights?.[type])>0?Number(state.columnWeights[type]):0;
      return `<section class="mt-resource-column" data-resource-type="${escapeHtml(type)}" style="--resource-color:${escapeHtml(category.color)}${weight>0?`;--column-weight:${weight}`:''}" data-empty="${!rows.length&&!lists.length}" data-all-empty="${allEmpty}">
        <h3 class="mt-resource-heading"><button type="button" class="mt-resource-tool" data-mt-category-icon="${escapeHtml(type)}" aria-label="Edit ${escapeHtml(terms.plural)} icon and color" title="Icon and color"><i class="fas ${escapeHtml(category.icon)}" aria-hidden="true"></i></button>${merged?'<span class="mt-column-title" title="Who does the work, what they are paid for it, and the equipment it takes">Work order</span>':`<input data-mt-category-name="${escapeHtml(type)}" value="${escapeHtml(category.name||'')}" placeholder="Untitled" aria-label="Resource type name">`}<span class="mt-category-tools">${type==='material'&&projectId()?`<button type="button" data-mt-generate-column="material" title="Generate materials from the signed document and the scope" aria-label="Generate materials"${state.generatingMaterials?' disabled':''}><i class="fas ${state.generatingMaterials?'fa-rotate mt-spin':'fa-wand-magic-sparkles'}" aria-hidden="true"></i></button>`:''}<button type="button" data-mt-category-sources="${escapeHtml(type)}" aria-haspopup="dialog" title="Line item sources" aria-label="Line item sources for ${escapeHtml(terms.plural)}"><i class="fas fa-gear"></i></button><button type="button" data-mt-new-category-list="${escapeHtml(type)}" title="${merged?'Add a work order':'Add list'}" aria-label="Add list to ${escapeHtml(terms.plural)}"><i class="fas fa-list"></i><i class="fas fa-plus"></i></button>${merged?'<button type="button" data-mt-new-category-list="equipment" title="Add an equipment list" aria-label="Add an equipment list"><i class="fas fa-truck-pickup"></i><i class="fas fa-plus"></i></button>':''}<button type="button" data-mt-minimize-type="${escapeHtml(type)}" title="Minimize ${escapeHtml(terms.plural)}" aria-label="Minimize ${escapeHtml(terms.plural)}"><i class="fas fa-minus"></i></button>${['material','labor','equipment'].includes(type)?'':`<button type="button" data-mt-delete-type="${escapeHtml(type)}" title="Remove resource type" aria-label="Remove ${escapeHtml(category.name||'this resource type')}"><i class="fas fa-trash"></i></button>`}</span></h3>
        <div class="mt-resource-scroll">${merged&&!lists.some(list=>resourceType(list)==='labor')&&projectId()?`<article class="mt-list-pane" data-mt-pane-list="project:${escapeHtml(projectId())}"><div class="mt-list-pane-inner">${renderAssignBlock({id:`project:${projectId()}`,resource_type:'labor'})}</div></article>`:''}${lists.map(list=>{
          // Inside a merged column each list is still its own kind.
          const type=resourceType(list),terms=resourceTerms(type,list),category=resourceCategories().find(row=>row.id===type)||{};
          const id=cleanText(list.id),listRows=rows.filter(item=>item.__material_list_id===id),collapsed=!!state.collapsedListIds?.has(id);
          const sections=materialSectionDefinitions().filter(section=>(section.resource_type||'material')===type&&listRows.some(item=>lineSectionKey(item)===section.key));
          // A list named after its category is the default list; the column heading already carries that name and icon.
          const title=list.metadata?.placeholder_title||[category.name,terms.plural].some(label=>cleanText(label).toLowerCase()===cleanText(list.title).toLowerCase())?'':cleanText(list.title);
          const tools=list.metadata?.calculus_pending?`<div class="mt-list-secondary"><button type="button" data-mt-generate="${escapeHtml(id)}">Generate materials</button></div>`:'';
          const actions=list.metadata?.calculus_pending?'':`${type==='labor'?renderLaborListControls(list):''}${renderListActionControls(list,type,materialListOrdered(list))}`;
          return `<article class="mt-list-pane${collapsed?' is-collapsed':''}${type==='labor'&&laborListFinalized(list)?' is-finalized':''}" data-mt-pane-list="${escapeHtml(id)}"><div class="mt-list-pane-inner"><header class="mt-list-head"><button type="button" data-mt-collapse-list="${escapeHtml(id)}" aria-expanded="${!collapsed}" aria-label="${collapsed?'Expand':'Collapse'} ${escapeHtml(title||'Default')}" title="${collapsed?'Expand':'Collapse'} list"><i class="fas fa-chevron-${collapsed?'right':'down'}"></i></button><input data-mt-list-name="${escapeHtml(id)}" value="${escapeHtml(title)}" placeholder="${merged&&type==='equipment'?'Equipment':'Default'}" aria-label="List name">${lists.length>1||collapsed?`<span class="mt-list-total" data-mt-list-total="${escapeHtml(id)}" title="List total">${money(listTotal(list))}</span>`:''}${type==='material'?`<button type="button" data-mt-open-pricebook data-mt-list-id="${escapeHtml(id)}" aria-pressed="${state.pricebookOpen&&cleanText(state.pricebookListId)===id}" title="Add to this list from the price book" aria-label="Add to ${escapeHtml(title||'Default')} from the price book"><i class="fas fa-book"></i></button>`:''}${actions}<button type="button" data-mt-delete-list="${escapeHtml(id)}" aria-label="Delete ${escapeHtml(title||'Default')}" title="${list.metadata?.calculus?'Accepted material artifacts are retained; collapse to hide this list':type==='labor'&&laborListFinalized(list)?'Finalized to be paid; a manager has to reopen it first':'Delete list'}" ${list.metadata?.calculus||type==='labor'&&laborListFinalized(list)?'disabled':''}><i class="fas fa-trash"></i></button></header>${collapsed?'':`${tools?`<div class="mt-list-tools">${tools}</div>`:''}${sections.map(section=>renderMaterialSection(section,listRows.filter(item=>lineSectionKey(item)===section.key),id,sections.length>1)).join('')||(type==='labor'&&!assignmentWorkResourceRef(list)?.id?renderAssignBlock(list):'<div class="mt-empty">Empty List</div>')}<button type="button" class="mt-resource-add mt-list-add-item" data-mt-add-section="${type==='material'?'accessories':type}" data-mt-list-id="${escapeHtml(id)}">+ Add ${escapeHtml(terms.singular.toLowerCase())}</button>`}</div></article>`;
        }).join('')||'<div class="mt-empty">Empty List</div>'}</div>
        ${lists.length?'':`<button type="button" class="mt-resource-add" data-mt-add-section="${type==='material'?'accessories':type}">+ Add ${escapeHtml(terms.singular.toLowerCase())}</button>`}
        ${members.map(type=>(estimate=>estimate.available?`<div class="mt-delivery-row${estimate.enabled?'':' off'}" title="One delivery for this category's unordered lists, estimated from your suppliers' fees. An order replaces it with the supplier's real fee."><i class="fas fa-truck" aria-hidden="true"></i><span>Projected delivery</span><strong>${estimate.enabled?`$${Math.round(estimate.amount).toLocaleString('en-US')}`:'Off'}</strong><button type="button" data-mt-delivery-toggle="${escapeHtml(type)}" aria-pressed="${estimate.enabled}" title="${estimate.enabled?'Leave delivery out of the projection':`Include projected delivery (${money(estimate.estimate)})`}" aria-label="Projected delivery"><i class="fas fa-toggle-${estimate.enabled?'on':'off'}" aria-hidden="true"></i></button></div>`:'')(projectedDelivery(type))).join('')}
        <footer class="mt-column-total"><span>Total</span><strong>${money(members.reduce((sum,member)=>sum+categoryProjected(member,lists.filter(list=>resourceType(list)===member)),0))}</strong></footer>
      </section>`;
    }).join('<button type="button" class="mt-column-divider" role="separator" aria-orientation="vertical" aria-label="Resize the columns on either side" title="Drag to resize. Double-click to reset."></button>')+renderRequirementsTray();
  }

  function renderMaterialSection(section, items = sectionItems(section.key), listId = '', labelled = false){
    const needsData = sectionNeedsMeasurements(section.key);
    const type = section.resource_type || 'material';
    const terms = resourceTerms(type, materialListById(items[0]?.__material_list_id));
    const material = type === 'material';
    const labor = type === 'labor';
    return `
      <section class="mt-section${String(needsData ? ' needs-data' : '')}" data-mt-section-key="${String(escapeHtml(section.key))}">
        ${material && (labelled || section.key!=='accessories') ? `<div class="mt-section-label">${escapeHtml(section.title)}</div>` : ''}
        <table class="mt-table">
          <colgroup><col>${String(material ? '<col style="width:52px">' : '')}${String(labor ? '<col style="width:90px">' : '')}<col style="width:82px"><col style="width:58px"><col style="width:74px"><col style="width:52px"></colgroup>
          <thead><tr><th>${String(escapeHtml(terms.singular))}</th>${String(material ? `<th>${(globalThis.PlatformLanguage?.htmlText("materials","m_db7002926d9977","Color") ?? "Color")}</th>` : '')}${String(labor ? `<th>${(globalThis.PlatformLanguage?.htmlText("materials","m_d9b2666bd68237","Pay type") ?? "Pay type")}</th>` : '')}<th>${(globalThis.PlatformLanguage?.htmlText("materials","m_1a29aea570fbc4","Qty") ?? "Qty")}</th><th>${(globalThis.PlatformLanguage?.htmlText("materials","m_4b91b73dae1ff3","Unit") ?? "Unit")}</th><th>${String(type === 'labor' ? 'Rate' : 'Unit $')}</th><th></th></tr></thead>
          <tbody>${String(items.length ? items.map(renderLineRow).join('') : `<tr><td colspan="${material ? 6 : labor ? 6 : 5}"><div class="mt-empty">${((v1) => globalThis.PlatformLanguage?.htmlText("materials","m_78337592690145",`No ${v1} in this category.`,{v1}) ?? `No ${v1} in this category.`)(escapeHtml(terms.plural.toLowerCase()))}</div></td></tr>`)}</tbody>
        </table>
      </section>
    `;
  }

  function arrangeMaterialColumns(root){
    positionColorPortal(root);
  }

  function renderLineRow(item){
    const variants = variantsForLine(item);
    const secondary = materialSecondaryText(item, variants.length > 1);
    const listId = cleanText(item.__material_list_id || state.activeListId);
    const type = cleanText(item.__resource_type || resourceType(materialListById(listId))) || 'material';
    const quantity = type === 'material' && !item.metadata?.calculus_line_id ? integerQuantity(item.quantity, 0) : preciseQuantity(item.quantity, 0);
    const material = type === 'material';
    const labor = type === 'labor';
    const orderInfo = material && state.unitsMode === 'order' ? orderInfoForLine(item, quantity) : null;
    const unitPrice = item.projected_unit_price == null || item.projected_unit_price === '' ? NaN : Number(item.projected_unit_price);
    const lineTotal = item.projected_total != null ? Number(item.projected_total) : quantity * unitPrice;
    const meta = material ? `${renderVariantControl(item, variants)}${secondary ? `<span>${escapeHtml(secondary)}</span>` : ''}`.trim() : '';
    const name = materialPrimaryName(item);
    const unit = cleanText(item.unit);
    const variantName = cleanText(item.product_selection?.variant_name || item.pricebook_snapshot?.variant?.name);
    // Rows are one line; the hover summary carries whatever the pane is too narrow to show.
    const summary = [name, `${quantity || 0}${unit ? ` ${unit}` : ''}${Number.isFinite(unitPrice) ? ` × ${money(unitPrice)}` : ''}${Number.isFinite(lineTotal) ? ` = ${money(lineTotal)}` : ''}`, [variantName !== name ? variantName : '', secondary !== variantName ? secondary : ''].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    const fit = (value, minimum) => `style="width:calc(${Math.max(minimum, String(value ?? '').length)}ch + 10px)" data-mt-fit="${minimum}"`;
    // Whole dollars with separators; cents only survive on small fractional prices, where rounding would misstate them.
    const priceText = Number.isFinite(unitPrice) ? unitPrice.toLocaleString('en-US', unitPrice < 100 && !Number.isInteger(unitPrice) ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 }) : '';
    const estimated = item.metadata?.quantity_estimated === true && number(item.quantity, 0) === number(item.metadata.estimated_quantity, NaN);
    const warnings = lineWarnings(listId, item.id);
    const orderTooltip = orderInfo ? `Measured: ${quantity} ${cleanText(item.unit || 'ea')}${orderInfo.covered_quantity !== quantity ? ` · ${orderInfo.order_quantity} ${orderInfo.order_unit} covers ${orderInfo.covered_quantity} ${cleanText(item.unit || 'ea')}` : ''}${orderInfo.packaging?.description ? ` · ${orderInfo.packaging.description}` : ''}` : '';
    return `
      <tr class="mt-list-row${state.expandedItemIds?.has(cleanText(item.id)) ? ' is-expanded' : ''}${item.metadata?.unresolved === true ? ' is-unresolved' : ''}${item.metadata?.quantity_needed === true && !(number(item.quantity, 0) > 0) ? ' needs-quantity' : ''}${item.metadata?.equipment === true ? ' is-brought' : ''}${estimated ? ' is-estimated' : ''}" data-resource-kind="${escapeHtml(type)}" data-mt-item-row="${String(escapeHtml(item.id))}" data-mt-list-id="${String(escapeHtml(listId))}" title="${escapeHtml(item.metadata?.unresolved === true ? `${item.name}: not priced yet. ${cleanText(item.metadata.unresolved_reason)}` : item.metadata?.quantity_needed === true && !(number(item.quantity, 0) > 0) ? `${item.name}: enter ${cleanText(item.metadata.quantity_label || 'the quantity').toLowerCase()} to price this line.` : item.metadata?.projection_only === true ? `${summary}\nCost rate: this projects what their time costs. They are paid by salary, not from this line.` : estimated ? `${summary}\nEstimated from the work this job requires and the hours on their pay sheet. Type the hours you expect to replace the estimate.` : item.metadata?.equipment === true ? `${summary}\nThey bring this${item.metadata?.equipment_included ? ' at no charge' : ''}. There is nothing to reserve.` : summary)}">
        <td class="mt-c-drag"><span class="mt-drag" role="button" tabindex="0" draggable="true" data-mt-list-trigger="${String(escapeHtml(item.id))}" data-mt-list-id="${String(escapeHtml(listId))}" title="Drag to reorder or move to another list. Click to choose a list." aria-label="${((v8) => globalThis.PlatformLanguage?.htmlText("materials","m_790adaaf81ef83",`Change list for ${v8}`,{v8}) ?? `Change list for ${v8}`)(escapeHtml(name))}" aria-expanded="${String(state.listMenu?.itemId === item.id ? 'true' : 'false')}"><i class="fas fa-grip-vertical" aria-hidden="true"></i></span></td>
        <td class="mt-c-name"><input class="mt-input mt-cell-input mt-line-name" data-mt-item-name="${String(escapeHtml(item.id))}" data-mt-list-id="${String(escapeHtml(listId))}" value="${String(escapeHtml(name))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_7bd2b28790fb35","Item name") ?? "Item name")}" ${String(state.saving ? 'disabled' : '')}></td>
        ${String(material ? `<td class="mt-c-color">${renderColorControl(item)}</td>` : '')}
        ${warnings.length ? `<td class="mt-c-warn" title="${escapeHtml(warnings.map((warning) => cleanText(warning.message)).join('\n'))}" aria-label="${escapeHtml(warnings.map((warning) => cleanText(warning.message)).join(' '))}"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i></td>` : ''}
        ${String(orderInfo ? `
        <td class="mt-c-qty"><div class="mt-order-qty-cell" data-fm-tooltip="${escapeHtml(orderTooltip)}"><strong>${escapeHtml(orderInfo.order_quantity)}</strong><span>${escapeHtml(`${quantity} ${cleanText(item.unit || 'ea')}`)}</span></div></td>
        <td class="mt-c-unit"><div class="mt-order-qty-cell" data-fm-tooltip="${escapeHtml(orderTooltip)}"><strong>${escapeHtml(orderInfo.order_unit)}</strong>${orderInfo.packaging?.description ? `<span>${escapeHtml(orderInfo.packaging.description)}</span>` : ''}</div></td>` : `
        <td class="mt-c-qty"><input class="mt-input mt-cell-input mt-number" aria-label="Quantity" placeholder="0" ${fit(quantity || '', 3)} data-mt-item-qty="${escapeHtml(item.id)}" data-mt-list-id="${escapeHtml(listId)}" type="number" min="0" step="${type === 'material' && !item.metadata?.calculus_line_id ? '1' : '0.01'}" value="${escapeHtml(quantity || '')}" ${state.saving ? 'disabled' : ''}></td>
        <td class="mt-c-unit"><input class="mt-input mt-cell-input" aria-label="Unit" placeholder="unit" ${fit(unit, 2)} data-mt-item-unit="${escapeHtml(item.id)}" data-mt-list-id="${escapeHtml(listId)}" value="${escapeHtml(item.unit || '')}" ${state.saving ? 'disabled' : ''}></td>`)}
        <td class="mt-c-total">${Number.isFinite(lineTotal) ? `$${Math.round(lineTotal).toLocaleString('en-US')}` : ''}</td>
        <td class="mt-c-expand"><button type="button" class="mt-expand" data-mt-expand-item="${escapeHtml(item.id)}" aria-expanded="${state.expandedItemIds?.has(cleanText(item.id)) ? 'true' : 'false'}" title="${labor ? 'Rate' : 'Unit price'} and remove" aria-label="Show ${labor ? 'rate' : 'unit price'} and remove for ${escapeHtml(name)}"><i class="fas fa-chevron-down" aria-hidden="true"></i></button></td>
        <td class="mt-c-detail"><span class="mt-c-meta">${meta}</span>
          <label class="mt-c-price"><span>${labor ? 'Rate' : 'Unit price'}</span><input class="mt-input mt-cell-input mt-number" aria-label="${labor?'Rate':'Unit price'}" placeholder="0" ${fit(priceText, 6)} data-mt-item-price="${String(escapeHtml(item.id))}" data-mt-list-id="${String(escapeHtml(listId))}" data-mt-raw="${String(escapeHtml(item.projected_unit_price ?? ''))}" type="text" inputmode="decimal" value="${escapeHtml(priceText)}" ${String(state.saving ? 'disabled' : '')}></label>
          <button type="button" class="mt-row-remove" data-mt-remove="${String(escapeHtml(item.id))}" data-mt-list-id="${String(escapeHtml(listId))}" title="${(globalThis.PlatformLanguage?.htmlText("materials","m_f643f568915438","Remove") ?? "Remove")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_f643f568915438","Remove") ?? "Remove")}" ${String(state.saving ? 'disabled' : '')}><i class="fas fa-trash" aria-hidden="true"></i> Remove</button></td>
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
      <select class="mt-variant-select" title="${escapeHtml(cleanText(item.product_selection?.variant_name || item.pricebook_snapshot?.variant?.name))}" aria-label="Variant" data-mt-item-variant="${escapeHtml(item.id)}" data-mt-list-id="${escapeHtml(item.__material_list_id || state.activeListId)}" ${state.saving ? 'disabled' : ''}>
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
      <button type="button" tabindex="-1" class="mt-color-trigger${String(rich ? ' rich' : '')}" data-mt-color-trigger="${String(escapeHtml(item.id))}" data-mt-list-id="${String(escapeHtml(item.__material_list_id || state.activeListId))}" data-fm-tooltip="${String(escapeHtml(selectedMeta?.label || selected))}" title="${String(escapeHtml(selectedMeta?.label || selected))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_d453ffba808085","Choose color") ?? "Choose color")}" aria-expanded="${String(state.colorMenu?.itemId === item.id ? 'true' : 'false')}">
        <span class="mt-color-current"><span class="mt-color-swatch" style="${String(escapeHtml(optionValueBackground(selectedMeta)))}"></span>${String(selectedMeta?.label ? `<em>${escapeHtml(selectedMeta.label)}</em>` : '')}</span>
      </button>
    `;
  }

  function renderColorPortal(){
    const menu = state.colorMenu;
    if (!menu?.itemId) return '';
    const item = listItems(materialListById(menu.listId)).find((entry) => cleanText(entry.id) === cleanText(menu.itemId));
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

  /* Colour menus are opened by one listener on the document rather than one per
   * swatch: a save that finishes mid-click redraws the row, and a listener on
   * the old swatch would never hear the click. Opening on the press, not the
   * release, means a redraw between the two cannot lose it. Any press outside
   * the menu, or Escape, closes it. A colour choice is queued behind earlier
   * writes to its list, so the swatches stay usable while something saves. */
  let colorMenuEventsInstalled = false;
  function installColorMenuEvents(){
    if (colorMenuEventsInstalled || typeof document === 'undefined') return;
    colorMenuEventsInstalled = true;
    const triggerFor = (event) => {
      const trigger = event.target?.closest?.('[data-mt-color-trigger]');
      return trigger && state.panelRoot?.contains?.(trigger) ? trigger : null;
    };
    const open = (trigger) => toggleColorMenu(trigger.dataset.mtColorTrigger, trigger, trigger.dataset.mtListId);
    document.addEventListener('pointerdown', (event) => {
      if (event.button) return;
      const trigger = triggerFor(event);
      if (trigger) {
        event.preventDefault();
        trigger.__mtOpenedOnPress = true;
        open(trigger);
        return;
      }
      if (state.colorMenu && !event.target?.closest?.('[data-mt-color-portal]')) closeColorMenu();
    }, true);
    document.addEventListener('click', (event) => {
      const trigger = triggerFor(event);
      if (!trigger) return;
      event.stopPropagation();
      if (trigger.__mtOpenedOnPress) { trigger.__mtOpenedOnPress = false; return; }
      open(trigger);
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.colorMenu) closeColorMenu();
    }, true);
  }

  function toggleColorMenu(itemId, trigger, listId = state.activeListId){
    // Only a menu that is actually showing is closed by its own swatch; a record left behind by a redraw is not.
    if (state.colorMenu?.itemId === itemId && state.colorMenu?.listId === listId && document.querySelector('[data-mt-color-portal]')) {
      closeColorMenu();
      return;
    }
    closeColorMenu();
    const item = listItems(materialListById(listId)).find((entry) => cleanText(entry.id) === cleanText(itemId));
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
    root?.querySelectorAll?.('.mt-resource-column').forEach(column=>{const type=column.dataset.resourceType,total=column.querySelector('.mt-column-total strong');if(total)total.textContent=money(categoryProjected(type,state.lists.filter(list=>resourceType(list)===type&&state.visibleListIds.has(cleanText(list.id)))));});
    const projected=root?.querySelector?.('[data-mt-projected-total]');if(projected)projected.textContent=money(projectProjected());
    root?.querySelectorAll?.('[data-mt-list-total]').forEach(node=>{const list=materialListById(node.dataset.mtListTotal);if(list)node.textContent=money(listProjected(list));});
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
      <div class="mt-title"><i class="fas fa-clipboard-list"></i><div><strong>${(globalThis.PlatformLanguage?.htmlText("materials","scope_of_work","Scope of Work") ?? "Scope of Work")}</strong></div></div>
      <div class="mt-actions">

        ${String(list && activeType === 'material' ? `<button type="button" class="mt-btn${state.pricebookOpen ? ' primary' : ''}" data-mt-open-pricebook ${!list ? 'disabled' : ''}><i class="fas fa-book"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_cf3630161575f6"," Price Book") ?? " Price Book")}</button>` : '')}
        <button type="button" class="mt-btn" data-mt-add-custom ${list ? '' : 'hidden'} ${String(!list ? 'disabled' : '')}><i class="fas fa-plus"></i> ${String(escapeHtml(activeTerms.singular))}</button>
        ${String(canSchedule ? `<button type="button" class="mt-btn" data-mt-schedule-list="${escapeHtml(list?.id || '')}" ${state.saving || state.schedulingListId ? 'disabled' : ''}><i class="fas ${state.schedulingListId === cleanText(list?.id) ? 'fa-rotate mt-spin' : 'fa-calendar-day'}"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_80ce49ac8b6049"," Schedule") ?? " Schedule")}</button>` : '')}
        ${String(list && activeType === 'material' ? `<button type="button" class="mt-btn ${ordered ? 'success' : 'primary'}" data-mt-order ${!listItems().length || state.saving ? 'disabled' : ''}><i class="fas ${ordered ? 'fa-circle-check' : 'fa-cart-shopping'}"></i> ${ordered ? 'Ordered' : 'Order'}</button>` : '')}
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
    const selector = '[data-mt-add-section],[data-mt-item-variant],[data-mt-list-trigger],[data-mt-item-name],[data-mt-item-qty],[data-mt-item-unit],[data-mt-item-price],[data-mt-remove]';
    root?.querySelectorAll?.(selector)?.forEach((control) => { control.disabled = !!saving; });
    root?.classList?.toggle('is-saving', !!saving);
    syncTopBar();
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
    const active = existing.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = active ? ['mtItemName', 'mtItemQty', 'mtItemUnit', 'mtItemPrice'].find((key) => active.dataset?.[key]) : '';
    existing.replaceWith(next);
    bindLineControls(next);
    if (focusKey) Array.from(next.querySelectorAll('input')).find((input) => input.dataset[focusKey])?.focus?.();
    timingMark('syncLineRow', { itemId, listId });
    return true;
  }

  function syncMaterialSection(sectionKey){
    return syncMaterialsGrid();
  }

  function syncMaterialsGrid(){
    const root = materialRoot();
    const grid = root?.querySelector?.('[data-mt-material-grid]');
    if (!grid) return false;
    const scrollPositions = resourceScrollPositions(grid);
    grid.innerHTML = renderMaterialSections();
    restoreResourceScroll(grid, scrollPositions);
    bindSectionContent(grid);
    bindLeft(grid);
    bindResourceActions(grid);
    bindRequirements(grid);
    syncResourceHeader();
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

  // Marks tiles whose item list is cut off, until it has been scrolled to its end.
  function markOrderTileOverflow(dialog){
    dialog?.querySelectorAll?.('.mt-order-tile-items')?.forEach((items) => {
      const mark = () => items.closest('.mt-order-tile')?.classList.toggle('has-more', items.scrollTop + items.clientHeight < items.scrollHeight - 2);
      items.onscroll = mark;
      mark();
    });
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
    markOrderTileOverflow(next);
    if (state.orderCalendarOpen && state.orderTimingChoice === 'scheduled') renderOrderDeliveryCalendar(next);
    return true;
  }

  function syncScopeListCard(listId){
    const list = materialListById(listId);
    const existing = findByData(state.sidebarRoot, '[data-mt-list-wrap]', 'mtListWrap', listId);
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
          <strong><i class="fas fa-book"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_cf3630161575f6"," Price Book") ?? " Price Book")}${escapeHtml(` · ${cleanText(materialListById(state.pricebookListId)?.title) || 'Default'}`)}</strong>
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
    return orderableItems(list).map((item) => {
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
    if (!start) return 'No delivery date';
    return `${start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}${cleanText(draft.time) ? `, ${cleanText(draft.time)}` : ''}`;
  }

  function orderDeliveryLabel(list){
    return scheduleDraftLabel(orderSchedule(list));
  }

  function orderRequestSubject(lists = selectedOrderLists()){
    const address = cleanText(state.project?.address || state.project?.title || projectId());
    const dates = [...new Set(lists.map((list) => cleanText(orderSchedule(list).date)))];
    return `Material delivery request - ${address}${dates.length === 1 && dates[0] ? ` - ${dates[0]}` : ''}`;
  }

  function orderDeliveryInstruction(group){
    const title = orderGroupTitle(group);
    const start = dateFromOrderSchedule(group.schedule);
    const time = cleanText(group.schedule.time);
    if (!start) return `I need the ${title} materials included in this order. The delivery date and time are not set, so please contact me to arrange them.`;
    const dateLabel = start.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    if (!time) return `I need the ${title} delivery on ${dateLabel}. The delivery time is flexible, but please confirm it with me.`;
    return `I need the ${title} delivery on ${dateLabel}${orderTimeClock(time) ? ` at ${time}` : `, ${time}`}.`;
  }

  function orderRequestText(lists = selectedOrderLists()){
    const address = cleanText(state.project?.address || state.project?.title || (globalThis.PlatformLanguage?.text("materials","m_e79a19a31a91af","the project site") ?? "the project site"));
    const groups = orderDeliveryGroups(lists);
    const instructions = groups.map((group) => `- ${orderDeliveryInstruction(group)}`).join('\n');
    const sections = groups.map((group) => {
      const table = group.lists.flatMap((list) => orderRequestRows(list)).map((row) => `${row.name}\t${row.detail || '—'}\t${row.quantity}\t${row.unit}`).join('\n');
      return `${orderGroupTitle(group)}\n${orderDeliveryInstruction(group)}\n\nMaterial\tDetails\tQuantity\tUnit\n${table}`;
    }).join('\n\n');
    return `${orderRequestSubject(lists)}\n\nHello,\n\nPlease place the following material order for delivery to ${address}.\n\nDelivery instructions:\n${instructions}\n\n${sections}\n\nPlease confirm product availability, quantities, variant and color details, and each requested delivery appointment before processing the order.\n\nThank you.`;
  }

  function orderRequestHtml(lists = selectedOrderLists()){
    const address = cleanText(state.project?.address || state.project?.title || (globalThis.PlatformLanguage?.text("materials","m_e79a19a31a91af","the project site") ?? "the project site"));
    const groups = orderDeliveryGroups(lists);
    const instructions = `<ul>${groups.map((group) => `<li>${escapeHtml(orderDeliveryInstruction(group))}</li>`).join('')}</ul>`;
    const cell = 'border:1px solid #999;padding:6px;text-align:left';
    const sections = groups.map((group) => `<p><strong>${escapeHtml(orderGroupTitle(group))}</strong><br><em>${escapeHtml(orderDeliveryInstruction(group))}</em></p><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%"><thead><tr><th style="${String(cell)}">${(globalThis.PlatformLanguage?.htmlText("materials","m_613d6b4084975e","Material") ?? "Material")}</th><th style="${String(cell)}">${(globalThis.PlatformLanguage?.htmlText("materials","m_b3ecc234f63212","Details") ?? "Details")}</th><th style="${String(cell)}">${(globalThis.PlatformLanguage?.htmlText("materials","m_9c689ddee2f502","Quantity") ?? "Quantity")}</th><th style="${String(cell)}">${(globalThis.PlatformLanguage?.htmlText("materials","m_4b91b73dae1ff3","Unit") ?? "Unit")}</th></tr></thead><tbody>${group.lists.flatMap((list) => orderRequestRows(list)).map((row) => `<tr><td style="${cell}">${escapeHtml(row.name)}</td><td style="${cell}">${row.details.map((entry) => `<strong>${escapeHtml(entry.label)}:</strong> ${escapeHtml(entry.value)}`).join('<br>') || '&mdash;'}</td><td style="${cell}">${escapeHtml(row.quantity)}</td><td style="${cell}">${escapeHtml(row.unit)}</td></tr>`).join('')}</tbody></table>`).join('<br>');
    return `<p><strong>${String(escapeHtml(orderRequestSubject(lists)))}</strong></p><p>${(globalThis.PlatformLanguage?.htmlText("materials","m_2634bd92bed7f7","Hello,") ?? "Hello,")}</p><p>${(globalThis.PlatformLanguage?.htmlText("materials","m_2dc5eebd0941a4","Please place the following material order for delivery to ") ?? "Please place the following material order for delivery to ")}<strong>${String(escapeHtml(address))}</strong>.</p><p><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_0e22a1d03e954f","Delivery instructions") ?? "Delivery instructions")}</strong></p>${String(instructions)}${String(sections)}<p>${(globalThis.PlatformLanguage?.htmlText("materials","m_09326393374cc9","Please confirm product availability, quantities, variant and color details, and each requested delivery appointment before processing the order.") ?? "Please confirm product availability, quantities, variant and color details, and each requested delivery appointment before processing the order.")}</p><p>${(globalThis.PlatformLanguage?.htmlText("materials","m_e495d4a9827c67","Thank you.") ?? "Thank you.")}</p>`;
  }

  function orderRequestPreviewHtml(lists = selectedOrderLists()){
    const address = cleanText(state.project?.address || state.project?.title || (globalThis.PlatformLanguage?.text("materials","m_e79a19a31a91af","the project site") ?? "the project site"));
    const groups = orderDeliveryGroups(lists);
    const instructions = groups.map((group) => `<li>${escapeHtml(orderDeliveryInstruction(group))}</li>`).join('');
    const sections = groups.map((group) => { const rows = group.lists.flatMap((list) => orderRequestRows(list)); return `<section class="mt-request-group"><p><strong>${escapeHtml(orderGroupTitle(group))}</strong> <em>${((v1) => globalThis.PlatformLanguage?.htmlText("materials","m_da1df6b7a47ee1",`(${v1} items)`,{v1}) ?? `(${v1} items)`)(escapeHtml(rows.length))}</em><br><em>${escapeHtml(orderDeliveryInstruction(group))}</em></p><table class="mt-order-table"><thead><tr><th>${(globalThis.PlatformLanguage?.htmlText("materials","m_613d6b4084975e","Material") ?? "Material")}</th><th>${(globalThis.PlatformLanguage?.htmlText("materials","m_b3ecc234f63212","Details") ?? "Details")}</th><th>${(globalThis.PlatformLanguage?.htmlText("materials","m_1a29aea570fbc4","Qty") ?? "Qty")}</th><th>${(globalThis.PlatformLanguage?.htmlText("materials","m_4b91b73dae1ff3","Unit") ?? "Unit")}</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${orderRequestDetailsHtml(row)}</td><td>${escapeHtml(row.quantity)}</td><td>${escapeHtml(row.unit)}</td></tr>`).join('')}</tbody></table></section>`; }).join('');
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

  // One full-height tile per material list: its header selects it, its items scroll, and its footer holds the total,
  // its delivery and who it is ordered from.
  function renderOrderListPicker(allLists, selectedLists){
    return `<section class="mt-order-tiles" role="group" aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_3422a94241c9cd","Material lists to order") ?? "Material lists to order")}">${allLists.map((list, index) => {
      const id = cleanText(list.id);
      const selected = state.orderSelectedListIds.has(id);
      const ordered = materialListOrdered(list);
      const items = orderableItems(list);
      const name = cleanText(list.title) || 'Materials';
      const draft = scheduleDraftForList(list);
      const groupLead = selected ? orderGroupTarget(list) : null;
      const shown = groupLead ? scheduleDraftForList(groupLead) : draft;
      const candidates = selected && !groupLead && !cleanText(draft.date) ? selectedLists.filter((other) => other !== list && cleanText(scheduleDraftForList(other).date) && !cleanText(scheduleDraftForList(other).group_with)) : [];
      const choice = selected ? orderSupplierChoice(list) : null;
      const quote = choice?.target ? supplierQuote(choice.target, [list], false) : null;
      // The fee is decided on the whole delivery and shown once, on the list the others are grouped with.
      const deliveryQuote = choice?.target ? supplierQuote(choice.target, orderDeliveryLists(list), choice.delivery) : null;
      const paysDelivery = !!choice?.target && !groupLead && deliveryQuote.fee > 0;
      const totalCents = quote ? (quote.subtotal == null ? null : quote.subtotal + (paysDelivery ? deliveryQuote.delivery : 0)) : Math.round(listTotals(list).projected * 100);
      const rows = items.map((item) => {
        const missing = !!quote?.missing.has(item.id), unknown = !!quote?.unpriced.has(item.id);
        const itemName = materialPrimaryName(item);
        const amount = `${number(item.quantity, 0)} ${cleanText(item.unit)}`.trim();
        const quantity = Math.max(0, number(item.quantity, 0));
        // The hover summary uses the prices the row shows: the chosen supplier's, or the list's own when none is chosen.
        const listPrice = item.projected_unit_price == null || item.projected_unit_price === '' ? NaN : Number(item.projected_unit_price);
        const cents = quote && !missing && !unknown ? quote.prices.get(item.id) : NaN;
        const unitPrice = quote ? cents / 100 : listPrice;
        const lineTotal = quote ? Math.round(cents * quantity) / 100 : item.projected_total != null ? Number(item.projected_total) : quantity * listPrice;
        const price = !quote || missing ? '' : unknown ? 'unknown' : money(lineTotal);
        const note = missing ? "The selected supplier doesn't carry this item." : unknown ? "We don't have this supplier's price for this item." : Number.isFinite(unitPrice) || Number.isFinite(lineTotal) ? '' : 'Price unknown.';
        const summary = [itemName, `${amount}${Number.isFinite(unitPrice) ? ` × ${money(unitPrice)}` : ''}${Number.isFinite(lineTotal) ? ` = ${money(lineTotal)}` : ''}`, note].filter(Boolean).join('\n');
        return `<li class="${missing ? 'missing' : unknown ? 'unknown' : ''}" title="${escapeHtml(summary)}"><span>${escapeHtml(itemName)}</span><em>${escapeHtml(amount)}</em>${quote ? `<b>${escapeHtml(price)}</b>` : ''}</li>`;
      }).join('') || '<li><span>No items</span></li>';
      const flags = `${quote && !quote.coversAll ? `<i class="fas fa-triangle-exclamation mt-flag-red" title="The selected supplier doesn't carry every item on this list." aria-label="The selected supplier doesn't carry every item on this list."></i>` : ''}${quote && quote.unpriced.size ? `<i class="fas fa-flag mt-flag-yellow" title="Contains items we don't have supplier pricing for." aria-label="Contains items we don't have supplier pricing for."></i>` : ''}`;
      const supplier = !selected ? '' : `<div class="mt-order-tile-supplier"><button type="button" data-mt-order-supplier="${escapeHtml(id)}" aria-haspopup="dialog" title="${escapeHtml(groupLead ? `Ordered with ${cleanText(groupLead.title) || 'Materials'}` : 'Choose who to order this list from')}" ${groupLead ? 'disabled' : ''}>${supplierMark(choice.target?.supplier)}<span>${escapeHtml(choice.name || 'Choose supplier')}</span>${groupLead ? '' : '<i class="fas fa-chevron-down" aria-hidden="true"></i>'}</button>${flags}</div>`;
      const deliveryToggle = paysDelivery ? `<label class="mt-order-tile-delivery" title="${escapeHtml(deliveryQuote.waived ? 'Delivery is free for an order this size.' : 'Include this supplier\'s delivery fee in the total. It is added to the list as its own line when the order is placed.')}"><input type="checkbox" data-mt-order-delivery="${escapeHtml(id)}" ${choice.delivery ? 'checked' : ''}><span>Delivery</span><strong>${deliveryQuote.waived ? 'Free' : choice.delivery ? money(deliveryQuote.delivery / 100) : `${money(deliveryQuote.fee / 100)} off`}</strong></label>` : '';
      const delivery = !selected ? '' : `<div class="mt-order-tile-when${groupLead ? ' grouped' : ''}"><input type="date" data-mt-order-date="${escapeHtml(id)}" value="${escapeHtml(cleanText(shown.date))}" aria-label="Delivery date for ${escapeHtml(name)}" title="Delivery date" ${groupLead ? 'disabled' : ''}><input type="text" list="mt-order-time-presets" data-mt-order-time="${escapeHtml(id)}" value="${escapeHtml(cleanText(shown.time))}" placeholder="Time" aria-label="Delivery time for ${escapeHtml(name)}" title="A time, or a window such as Morning. This text goes into the supplier email as written." ${groupLead ? 'disabled' : ''}></div>${groupLead ? `<button type="button" class="mt-order-tile-group active" data-mt-order-ungroup="${escapeHtml(id)}" title="Give this list its own delivery and supplier again"><span>Grouped with ${escapeHtml(cleanText(groupLead.title) || 'Materials')}</span><i class="fas fa-xmark" aria-hidden="true"></i></button>` : candidates.length ? `<div class="mt-order-tile-groups"><span>Group with</span>${candidates.map((other) => `<button type="button" class="mt-order-tile-group" data-mt-order-group="${escapeHtml(id)}" data-mt-order-group-target="${escapeHtml(other.id)}" title="${escapeHtml(`Deliver with ${cleanText(other.title) || 'Materials'}, from the same supplier: ${scheduleDraftLabel(scheduleDraftForList(other))}`)}">${escapeHtml(cleanText(other.title) || 'Materials')}</button>`).join('')}</div>` : ''}`;
      return `<article class="mt-order-tile${selected ? ' selected' : ''}" style="--list-color:${escapeHtml(materialListColor(list, Math.max(index, state.lists.indexOf(list))))}"><header><button type="button" class="mt-order-tile-select" data-mt-order-list-toggle="${escapeHtml(id)}" aria-pressed="${selected}" title="${selected ? 'Included in this order' : 'Not in this order'}${ordered ? ' · already ordered' : ''}"><span class="mt-order-list-check"><i class="fas fa-check" aria-hidden="true"></i></span><strong>${escapeHtml(name)}</strong></button><span class="mt-order-tile-count" title="${escapeHtml(`${items.length} item${items.length === 1 ? '' : 's'}`)}">${ordered ? '<i class="fas fa-lock" aria-hidden="true"></i> ' : ''}${escapeHtml(items.length)}</span></header><ul class="mt-order-tile-items">${rows}</ul><footer>${deliveryToggle}<div class="mt-order-tile-total"><span>Total</span><strong>${totalCents == null ? 'Unknown' : money(totalCents / 100)}</strong></div>${delivery}${supplier}</footer></article>`;
    }).join('')}</section>`;
  }

  function closeOrderSupplierMenu(){
    document.querySelectorAll?.('[data-mt-order-supplier-portal]')?.forEach((node) => node.remove());
    document.removeEventListener?.('pointerdown', orderSupplierMenuDismiss, true);
    document.removeEventListener?.('keydown', orderSupplierMenuDismiss, true);
    state.orderSupplierMenu = null;
  }
  function orderSupplierMenuDismiss(event){
    if (event.type === 'keydown') { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeOrderSupplierMenu(); } return; }
    if (!event.target?.closest?.('[data-mt-order-supplier-portal],[data-mt-order-supplier]')) closeOrderSupplierMenu();
  }
  // Searchable supplier and location picker for one delivery, with what each would charge for it.
  function toggleOrderSupplierMenu(listId, trigger){
    const open = state.orderSupplierMenu?.listId === listId;
    closeOrderSupplierMenu();
    const list = materialListById(listId);
    const dialog = trigger?.closest?.('[data-mt-order-dialog]');
    if (open || !list || !dialog) return;
    const lists = orderDeliveryLists(list);
    // With no supplier able to fill the whole list, start on the ones that can fill part of it rather than on nothing.
    const menu = state.orderSupplierMenu = { listId, search: '', showPartial: !supplierTargets().some((target) => supplierQuote(target, lists, false).coversAll) };
    const apply = (patch) => {
      captureOrderDraft(dialog);
      state.orderScheduleDrafts[cleanText(list.id)] = { ...scheduleDraftForList(list), ...patch };
      state.orderDraftFresh = true;
      closeOrderSupplierMenu();
      syncOrderDialog(true);
    };
    const portal = document.createElement('div');
    portal.className = 'mt-labor-portal mt-order-supplier-portal';
    portal.dataset.mtOrderSupplierPortal = '';
    portal.setAttribute('role', 'dialog');
    portal.setAttribute('aria-label', 'Choose a supplier');
    const current = orderSupplierChoice(list);
    portal.innerHTML = `<input type="search" class="mt-order-supplier-search" placeholder="Search suppliers and locations" aria-label="Search suppliers and locations"><label class="mt-order-supplier-option"><input type="checkbox" data-supplier-partial ${menu.showPartial ? 'checked' : ''}> Show suppliers that don't carry every item</label><div class="mt-labor-options" data-supplier-rows></div><div class="mt-order-supplier-other"><input type="email" placeholder="Or send to another email address" aria-label="Another email address" value="${escapeHtml(current.target ? '' : current.email)}"><button type="button" data-supplier-custom>Use</button></div>`;
    const draw = () => {
      const needle = menu.search.toLowerCase();
      const quoted = supplierTargets().filter((target) => !needle || target.name.toLowerCase().includes(needle)).map((target) => ({ target, quote: supplierQuote(target, lists, current.delivery) }));
      const rank = (entry) => (entry.quote.coversAll ? (entry.quote.total != null ? 0 : 1) : 2);
      const visible = quoted.filter((entry) => menu.showPartial || entry.quote.coversAll).sort((a, b) => rank(a) - rank(b) || (a.quote.total ?? Infinity) - (b.quote.total ?? Infinity) || a.target.name.localeCompare(b.target.name));
      const lowest = visible.find((entry) => rank(entry) === 0)?.quote.total;
      portal.querySelector('[data-supplier-rows]').innerHTML = visible.map(({ target, quote }) => {
        const note = !quote.coversAll ? `Doesn't carry ${quote.missing.size} item${quote.missing.size === 1 ? '' : 's'}` : quote.unpriced.size ? `${quote.unpriced.size} price${quote.unpriced.size === 1 ? '' : 's'} unknown` : quote.waived ? 'Carries everything · free delivery' : quote.delivery ? `Carries everything · includes ${money(quote.delivery / 100)} delivery` : 'Carries everything';
        return `<button type="button" class="mt-labor-option${current.target?.key === target.key ? ' active' : ''}${quote.coversAll ? '' : ' partial'}" data-supplier-key="${escapeHtml(target.key)}">${supplierMark(target.supplier)}<span><strong>${escapeHtml(target.name)}</strong><small>${escapeHtml(note)}</small></span><b class="${quote.total != null && quote.coversAll && quote.total === lowest ? 'lowest' : ''}">${quote.total == null ? 'Unknown' : money(quote.total / 100)}</b></button>`;
      }).join('') || `<p class="mt-order-supplier-empty">${(state.suppliers || []).length ? (quoted.length ? 'No supplier carries every item on this list. Tick the box above to see the others.' : 'No supplier matches.') : `No suppliers yet.${supplierSettingsUrl() ? ` <a href="${escapeHtml(supplierSettingsUrl())}" target="_blank" rel="noopener">Open supplier settings <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : ' Add them under Settings, Price Book, Suppliers.'}`}</p>`;
      portal.querySelectorAll('[data-supplier-key]').forEach((button) => button.addEventListener('click', () => apply({ supplier_key: button.dataset.supplierKey, supplier_email: '' })));
    };
    draw();
    portal.querySelector('.mt-order-supplier-search').addEventListener('input', (event) => { menu.search = event.target.value; draw(); });
    portal.querySelector('[data-supplier-partial]').addEventListener('change', (event) => { menu.showPartial = event.target.checked; draw(); });
    portal.querySelector('[data-supplier-custom]').addEventListener('click', () => { const email = cleanText(portal.querySelector('.mt-order-supplier-other input').value); if (email) apply({ supplier_email: email, supplier_key: '' }); });
    dialog.appendChild(portal);
    const rect = trigger.getBoundingClientRect();
    const width = portal.offsetWidth || 340;
    const height = portal.offsetHeight || 300;
    portal.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left))}px`;
    portal.style.top = `${rect.top - height - 4 >= 8 ? rect.top - height - 4 : Math.min(window.innerHeight - height - 8, rect.bottom + 4)}px`;
    document.addEventListener('pointerdown', orderSupplierMenuDismiss, true);
    document.addEventListener('keydown', orderSupplierMenuDismiss, true);
    portal.querySelector('.mt-order-supplier-search').focus();
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
    const supplierGroups = orderSupplierGroups(lists);
    const unaddressed = supplierGroups.filter((group) => !group.choice.email).flatMap((group) => group.lists.map((list) => cleanText(list.title) || 'Materials'));
    const blockedReason = !pendingLists.length ? 'Every selected list has already been ordered.' : !rows.length ? 'The selected lists have no items to order.' : unaddressed.length ? `Choose a supplier with an order email for ${unaddressed.join(', ')}.` : '';
    const detailsPanel = `<div class="mt-order-details">${renderOrderListPicker(allLists, lists)}<datalist id="mt-order-time-presets">${ORDER_TIME_PRESETS.map((preset) => `<option value="${escapeHtml(preset)}"></option>`).join('')}</datalist></div>`;
    const emailPanel = `<div class="mt-email-preview"><div class="mt-email-body">${supplierGroups.map((group) => `<div class="mt-email-fields"><div><span>To</span><strong>${escapeHtml(group.choice.target ? group.choice.name : group.choice.email || 'No supplier chosen')}</strong>${group.choice.target ? (group.choice.email ? `<em>${escapeHtml(group.choice.email)}</em>` : '<em class="missing">no order email on file</em>') : ''}</div><div><span>Subject</span><strong>${escapeHtml(orderRequestSubject(group.lists))}</strong></div></div>${orderRequestPreviewHtml(group.lists)}`).join('<hr class="mt-email-split">')}</div></div>`;
    const methods = [['email', 'fa-envelope', 'Order by Email', 'Email the request to the supplier and record the order'], ['agent', 'fa-robot', 'Order with Agent', 'Have an agent place the order. Not built yet.'], ['log', 'fa-clipboard-check', 'Log Order Only', 'Record an order that was placed some other way, without sending an email. Not built yet.']];
    const method = methods.some(([id]) => id === state.orderMethod) ? state.orderMethod : 'email';
    const methodBar = `<div class="mt-order-methods" role="radiogroup" aria-label="How to place this order">${methods.map(([id, icon, label, hint]) => `<button type="button" role="radio" aria-checked="${method === id}" class="${method === id ? 'active' : ''}" data-mt-order-method="${id}" title="${escapeHtml(hint)}"><i class="fas ${icon}" aria-hidden="true"></i> ${label}</button>`).join('')}</div>`;
    const methodPlaceholder = `<div class="mt-order-coming"><div><i class="fas ${method === 'agent' ? 'fa-robot' : 'fa-clipboard-check'}"></i><strong>${method === 'agent' ? 'Order with Agent' : 'Log Order Only'}</strong><span>${method === 'agent' ? 'Placing an order through an agent has not been built yet.' : 'Logging an order without sending an email has not been built yet.'}</span></div></div>`;
    const sendBar = `<div class="mt-order-send"><button type="button" class="mt-btn" data-mt-copy-order title="Copy the email and its table to paste somewhere else"><i class="fas fa-copy" aria-hidden="true"></i> Copy Email</button><button type="submit" class="mt-btn primary" data-mt-order-send title="${escapeHtml(blockedReason || (supplierGroups.length > 1 ? `Email each of the ${supplierGroups.length} suppliers its own request and record the orders.` : 'Email this request to the supplier and record the order.'))}" ${blockedReason ? 'disabled' : ''}><i class="fas fa-paper-plane" aria-hidden="true"></i> Send Email</button></div>`;
    const leftWidth = state.orderLeftWidth ? `${state.orderLeftWidth}px` : `min(64%, ${340 + Math.max(0, allLists.length - 1) * 190}px)`;
    const detailsContent = `<div class="mt-order-content manual" style="--order-left:${leftWidth}">${detailsPanel}<button type="button" class="mt-order-divider" role="separator" aria-orientation="vertical" aria-label="Resize the order details and the preview" title="Drag to resize. Double-click to reset."></button><div class="mt-order-right">${methodBar}${method === 'email' ? `${emailPanel}${sendBar}` : methodPlaceholder}</div></div>`;
    const unavailableContent = (source) => `<div class="mt-order-content"><div class="mt-order-coming"><div><i class="fas ${escapeHtml(orderSourceIcon(source))}"></i><strong>${escapeHtml(source?.name || 'Supplier integration')}</strong><span>${source?.status === 'disabled' ? 'This order source is not available for the selected lists.' : 'Direct supplier ordering is coming soon.'}</span></div></div></div>`;
    return `<dialog class="mt-modal" data-mt-order-dialog><div class="mt-modal-backdrop-hit" data-mt-close-order-backdrop aria-hidden="true"></div><form method="dialog" data-mt-order-form class="mt-modal-shell mt-order-modal"><div class="mt-modal-head mt-order-head"><h2>Order Materials</h2>${cleanText(state.project?.address) ? `<span class="mt-order-address" title="Delivery address"><i class="fas fa-location-dot" aria-hidden="true"></i> ${escapeHtml(cleanText(state.project.address))}</span>` : ''}<button type="button" class="mt-modal-close" data-mt-close-order aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div><div class="mt-order-layout">${String(manualProvider ? detailsContent : unavailableContent(activeSource))}</div></form></dialog>`;
  }

  function renderNewListDialog(){
    const color = firstUnusedListColor();
    return `

    `;
  }

  function bindLineControls(root){
    root.querySelectorAll('[data-mt-remove]').forEach((button) => {
      button.addEventListener('click', () => removeItem(button.dataset.mtRemove, button.dataset.mtListId));
    });
    root.querySelectorAll('[data-mt-item-variant]').forEach((select) => {
      select.addEventListener('change', () => updateItemVariant(select.dataset.mtItemVariant, select.value, select.dataset.mtListId));
    });
    installColorMenuEvents();
    root.querySelectorAll('[data-mt-list-trigger]').forEach((button) => {
      const openMenu = (event) => {
        event.stopPropagation();
        if (!state.saving) toggleListMenu(button.dataset.mtListTrigger, button.dataset.mtListId, button);
      };
      button.addEventListener('click', openMenu);
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openMenu(event);
      });
      button.addEventListener('dragstart', (event) => {
        const row = button.closest('[data-mt-item-row]');
        if (!row || state.saving) { event.preventDefault(); return; }
        closeListMenu();
        state.dragItem = { itemId: row.dataset.mtItemRow, listId: row.dataset.mtListId, type: resourceType(materialListById(row.dataset.mtListId)) };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', row.dataset.mtItemRow);
        event.dataTransfer.setDragImage(row, 8, 12);
        row.classList.add('is-dragging');
      });
      button.addEventListener('dragend', () => {
        state.dragItem = null;
        clearDropMarkers();
        button.closest('[data-mt-item-row]')?.classList.remove('is-dragging');
      });
    });
    [...(root.matches?.('[data-mt-item-row]') ? [root] : []), ...root.querySelectorAll('[data-mt-item-row]')].forEach((row) => {
      row.addEventListener('dragover', (event) => {
        if (!dragAccepts(row.dataset.mtListId)) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = row.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        clearDropMarkers();
        row.classList.add(after ? 'drop-after' : 'drop-before');
      });
      row.addEventListener('drop', (event) => {
        if (!dragAccepts(row.dataset.mtListId)) return;
        event.preventDefault();
        event.stopPropagation();
        const drag = state.dragItem;
        const after = row.classList.contains('drop-after');
        state.dragItem = null;
        clearDropMarkers();
        dropItem(drag.itemId, drag.listId, row.dataset.mtListId, row.dataset.mtItemRow, after);
      });
    });
    root.querySelectorAll('[data-mt-item-name]').forEach((input) => {
      const material = categorySources(resourceType(materialListById(input.dataset.mtListId))).length > 0;
      if (material) {
        input.setAttribute('autocomplete', 'off');
        input.addEventListener('input', () => showAutofill(input));
        input.addEventListener('blur', () => setTimeout(() => { if (state.autofill?.input === input) closeAutofill(); }, 120));
      }
      input.addEventListener('keydown', (event) => {
        const open = state.autofill?.input === input ? state.autofill : null;
        if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); moveAutofill(event.key === 'ArrowDown' ? 1 : -1); return; }
        if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeAutofill(); return; }
        // Tab takes the chosen suggestion, or keeps the typed text, and moves on to the count. Left to the browser, the focus
        // would land on a control that the rename's row redraw then replaces, and be lost.
        if (event.key === 'Tab' && !event.shiftKey) {
          const suggestion = open && open.index >= 0 ? open.matches[open.index] : null;
          if (!suggestion && !findByData(materialRoot(), '[data-mt-item-qty]', 'mtItemQty', input.dataset.mtItemName)) return;
          event.preventDefault();
          commitItemName(input, suggestion, false);
          return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commitItemName(input, open && open.index >= 0 ? open.matches[open.index] : null, true);
      });
    });
    root.querySelectorAll('[data-mt-expand-item]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = cleanText(button.dataset.mtExpandItem);
        const open = !state.expandedItemIds.has(id);
        if (open) state.expandedItemIds.add(id);
        else state.expandedItemIds.delete(id);
        button.closest('[data-mt-item-row]')?.classList.toggle('is-expanded', open);
        button.setAttribute('aria-expanded', String(open));
      });
    });
    root.querySelectorAll('[data-mt-fit]').forEach((input) => {
      const fit = () => { input.style.width = `calc(${Math.max(Number(input.dataset.mtFit), input.value.length)}ch + 10px)`; };
      input.addEventListener('input', fit);
      if (input.dataset.mtRaw == null) return;
      // The price shows rounded with separators and is edited as the stored number.
      const shown = input.value;
      input.addEventListener('focus', () => { input.value = input.dataset.mtRaw; fit(); input.select(); });
      input.addEventListener('blur', () => { if (input.value === input.dataset.mtRaw) { input.value = shown; fit(); } });
    });
    root.querySelectorAll('[data-mt-item-name],[data-mt-item-qty],[data-mt-item-unit],[data-mt-item-price]').forEach((input) => {
      if (!input.dataset.mtItemName) input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const itemId = input.dataset.mtItemQty || input.dataset.mtItemUnit || input.dataset.mtItemPrice;
        const list = materialListById(input.dataset.mtListId);
        const last = cleanText(listItems(list).at(-1)?.id) === cleanText(itemId);
        input.blur();
        if (last && list) addItem(null, resourceType(list) === 'material' ? 'accessories' : resourceType(list), list.id);
      });
      input.addEventListener('change', () => {
        if (input.dataset.mtCommitted) return;
        const itemId = input.dataset.mtItemName || input.dataset.mtItemQty || input.dataset.mtItemUnit || input.dataset.mtItemPrice;
        const patch = {};
        if (input.dataset.mtItemName) patch.name = input.value;
        if (input.dataset.mtItemQty) patch.quantity = input.value;
        if (input.dataset.mtItemUnit) patch.unit = input.value;
        if (input.dataset.mtItemPrice) patch.projected_unit_price = input.value.replace(/[^0-9.]/g, '');
        updateItem(itemId, patch, input.dataset.mtListId);
      });
    });
  }

  function bindSectionContent(root){
    root.querySelectorAll('[data-mt-add-section]').forEach((button) => {
      button.addEventListener('click', () => addItem(null, button.dataset.mtAddSection, button.dataset.mtListId));
    });
    bindColumnDividers(root);
    root.querySelectorAll('[data-mt-delivery-toggle]').forEach((button) => button.addEventListener('click', async () => {
      const type = button.dataset.mtDeliveryToggle;
      const lists = state.lists.filter((list) => resourceType(list) === type);
      const flagged = lists.filter((list) => list.metadata?.projected_delivery_disabled === true);
      // Off is remembered on one list of the category; on clears it wherever it was set.
      const changes = flagged.length ? flagged.map((list) => [list, false]) : lists.slice(0, 1).map((list) => [list, true]);
      if (!changes.length) return;
      const operation = captureProjectOperation(changes[0][0].id);
      try {
        for (const [list, disabled] of changes) await patchScopeResourceList(list.id, { metadata: { ...(list.metadata || {}), projected_delivery_disabled: disabled } }, operation);
        if (projectOperationIsCurrent(operation)) { syncMaterialsGrid(); syncResourceHeader(); }
      } catch (error) {
        if (projectOperationIsCurrent(operation)) showToast('Could not update projected delivery', error?.message || 'Please try again.', false);
      }
    }));
    root.querySelectorAll('[data-mt-open-pricebook]').forEach((button) => button.addEventListener('click', () => {
      const listId = cleanText(button.dataset.mtListId || state.activeListId);
      const list = materialListById(listId);
      state.pricebookOpen = !(state.pricebookOpen && cleanText(state.pricebookListId) === listId);
      state.pricebookListId = listId;
      if (list && resourceType(list) === 'material') { state.activeListId = listId; state.activeList = list; }
      syncPricebookPanel();
      materialRoot()?.querySelectorAll?.('[data-mt-open-pricebook][data-mt-list-id]')?.forEach((other) => other.setAttribute('aria-pressed', String(state.pricebookOpen && other.dataset.mtListId === listId)));
    }));
    root.querySelectorAll('[data-mt-pane-list]').forEach((pane) => {
      pane.addEventListener('dragover', (event) => {
        if (!dragAccepts(pane.dataset.mtPaneList)) return;
        event.preventDefault();
        clearDropMarkers();
        pane.classList.add('is-drop-target');
      });
      pane.addEventListener('drop', (event) => {
        if (!dragAccepts(pane.dataset.mtPaneList)) return;
        event.preventDefault();
        const drag = state.dragItem;
        state.dragItem = null;
        clearDropMarkers();
        dropItem(drag.itemId, drag.listId, pane.dataset.mtPaneList);
      });
    });
    bindLineControls(root);
  }

  function bindMain(root){

    root.querySelectorAll('[data-mt-section]').forEach((button) => button.addEventListener('click', () => {
      state.selectedSection = button.dataset.mtSection || 'all';
      rootWindow.Portal?.navigation?.replace?.({ materialSection:state.selectedSection === 'all' ? null : state.selectedSection }, { source:'scope-section', ownedKeys:['materialSection'] });
      render({ preserveScroll:true });
    }));
    bindSectionContent(root);

    root.querySelector('[data-mt-close-pricebook]')?.addEventListener('click', () => {
      state.pricebookOpen = false;
      syncPricebookPanel();
    });
    root.querySelector('[data-mt-pricebook-search]')?.addEventListener('input', (event) => {
      state.pricebookSearch = event.target.value || '';
      syncPricebookPanel();
    });
    root.querySelectorAll('[data-mt-add-pricebook]').forEach((button) => {
      button.addEventListener('click', () => addItem(state.pricebookItems.find((item) => item.id === button.dataset.mtAddPricebook), '', state.pricebookListId));
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
    const setOrderDelivery = (control, patch, focusNext = '') => {
      const dialog = control.closest('[data-mt-order-dialog]');
      const id = cleanText(control.dataset.mtOrderDate || control.dataset.mtOrderTime || control.dataset.mtOrderGroup || control.dataset.mtOrderUngroup || control.dataset.mtOrderDelivery);
      captureOrderDraft(dialog);
      state.orderScheduleDrafts[id] = { ...scheduleDraftForList(materialListById(id)), ...patch, dirty: true };
      state.orderDraftFresh = true;
      syncOrderDialog(true);
      if (focusNext) Array.from(materialRoot()?.querySelectorAll?.(focusNext) || []).find((node) => (node.dataset.mtOrderDate || node.dataset.mtOrderTime) === id)?.focus?.();
    };
    root.querySelectorAll('[data-mt-order-date]').forEach((input) => input.addEventListener('change', () => setOrderDelivery(input, { date: input.value, group_with: '' }, '[data-mt-order-time]')));
    root.querySelectorAll('[data-mt-order-time]').forEach((input) => input.addEventListener('change', () => setOrderDelivery(input, { time: input.value.trim(), group_with: '' })));
    root.querySelectorAll('[data-mt-order-delivery]').forEach((input) => input.addEventListener('change', () => setOrderDelivery(input, { delivery: input.checked })));
    root.querySelectorAll('[data-mt-order-supplier]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); toggleOrderSupplierMenu(button.dataset.mtOrderSupplier, button); }));
    root.querySelectorAll('[data-mt-order-group]').forEach((button) => button.addEventListener('click', () => setOrderDelivery(button, { group_with: cleanText(button.dataset.mtOrderGroupTarget) })));
    root.querySelectorAll('[data-mt-order-ungroup]').forEach((button) => button.addEventListener('click', () => setOrderDelivery(button, { group_with: '' }, '[data-mt-order-date]')));
    root.querySelectorAll('[data-mt-order-method]').forEach((button) => button.addEventListener('click', () => {
      captureOrderDraft(button.closest('[data-mt-order-dialog]'));
      state.orderMethod = button.dataset.mtOrderMethod;
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
      const draftDate = nextList ? dateFromOrderSchedule(scheduleDraftForList(nextList)) : null;
      if (draftDate) state.orderCalendarDate = draftDate;
      syncOrderDialog(true);
    }));
    root.querySelectorAll('[data-mt-order-confirm-dates]').forEach((button) => button.addEventListener('click', () => {
      if (!orderScheduleDatesComplete()) {
        showToast((globalThis.PlatformLanguage?.text("materials","m_55b9357dd5ce66","Delivery dates still needed") ?? "Delivery dates still needed"), (globalThis.PlatformLanguage?.text("materials","m_3d7f07360507a6","Place every selected delivery on the calendar before confirming.") ?? "Place every selected delivery on the calendar before confirming."), false);
        return;
      }
      state.orderDatesConfirmed = true;
      button.closest('[data-mt-order-form]')?.requestSubmit?.();
    }));
    root.querySelectorAll('.mt-order-divider').forEach((divider) => {
      const content = divider.parentElement;
      const left = divider.previousElementSibling;
      const apply = (width, commit) => {
        const next = Math.round(Math.max(280, Math.min(content.getBoundingClientRect().width - 380, width)));
        content.style.setProperty('--order-left', `${next}px`);
        if (commit) { state.orderLeftWidth = next; markOrderTileOverflow(content); rootWindow.dispatchEvent(new Event('resize')); }
      };
      divider.onpointerdown = (event) => {
        if (event.button) return;
        event.preventDefault();
        const origin = event.clientX;
        const start = left.getBoundingClientRect().width;
        divider.setPointerCapture?.(event.pointerId);
        divider.classList.add('is-dragging');
        divider.onpointermove = (move) => apply(start + move.clientX - origin, false);
        divider.onpointerup = divider.onpointercancel = (up) => { apply(start + up.clientX - origin, true); divider.classList.remove('is-dragging'); divider.onpointermove = divider.onpointerup = divider.onpointercancel = null; };
      };
      divider.onkeydown = (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        apply(left.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -24 : 24), true);
      };
      divider.ondblclick = () => { state.orderLeftWidth = null; captureOrderDraft(divider.closest('[data-mt-order-dialog]')); state.orderDraftFresh = true; syncOrderDialog(true); };
    });
    root.querySelector('[data-mt-copy-order]')?.addEventListener('click', copyOrderRequest);
    root.querySelector('[data-mt-order-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (await createOrderFromForm(event.currentTarget) === false) return;
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

  let scopeWidgetLibrary=null,scopeWidgetKey='',scopeWidgetSelection='overview';
  function scopeWidgetContext(){
    const fragment=(kind,config={})=>{
      const template=document.createElement('template');template.innerHTML=leftHtml();
      const wrapper=document.createElement('div');wrapper.className='mt-left';
      const groups=[...template.content.querySelectorAll('.mt-left-group')];
      for(const group of groups){const name=group.querySelector('[data-mt-left-toggle]')?.dataset.mtLeftToggle;
        if(name===kind || kind==='measurements'&&name==='custom_fields')wrapper.append(group);
      }
      if(config.resourceType&&config.resourceType!=='all')wrapper.querySelectorAll('[data-mt-resource-type]').forEach(el=>{if(el.dataset.mtResourceType!==config.resourceType)el.remove();});
      bindLeft(wrapper);return wrapper;
    };
    return {surface:'project',target:{scope:'project',organizationId:orgId(),projectId:projectId()},data:{'scope.lists':{lists:state.lists},'scope.measurements':{rows:scopeMeasurementRows()}},fragments:{'scope.lists':config=>fragment('lists',config),'scope.measurements':()=>fragment('measurements')}};
  }
  function disposeScopeWidgets(){scopeWidgetLibrary?.destroy();scopeWidgetLibrary=null;scopeWidgetKey='';}
  function renderLeft(){
    const timingStart = performance.now();
    if (!state.sidebarRoot || !state.active) return;
    const target = leftContentRoot();
    if (!target) return;
    target.querySelector?.('.mn-left')?.remove();
    target.querySelector?.('.r-schedule-left-shell')?.remove();
    state.sidebarRoot.classList.add('visible', 'mode-edit');
    state.sidebarRoot.classList.remove('mode-list', 'mode-send');
    const label = state.sidebarRoot.querySelector('#mtSidebarLabel');
    if (label) {
      label.textContent = (globalThis.PlatformLanguage?.text("materials","m_9d3e82ecfd10ec","Scope") ?? "Scope");
      label.hidden = true;
    }
    disposeScopeWidgets();
    if(scopeWorkspace)scopeWorkspace.mountSidebar(target,state.scopeDocuments,state.scopeDocumentsError,`${orgId()}:${projectId()}`,{widgetContext:scopeWidgetContext(),scheduleContext:state.context,measurementOverrides:state.measurementOverrides,onMeasurementChange:(key,value)=>{state.measurementOverrides={...state.measurementOverrides,[key]:value};syncMaterialsGrid();}});
    else target.textContent='Loading published scope data…';
    scopeWorkspace?.installDivider(state.sidebarRoot);
    timingMark('renderLeft:end', { active: state.active }, timingStart);
  }

  function leftContentRoot(){
    if (!state.sidebarRoot) return null;
    let list = state.sidebarRoot.querySelector('#mtSidebarList');
    if (!list) {
      state.sidebarRoot.classList.add('mt-widget-sidebar');
      state.sidebarRoot.innerHTML = '<div id="mtSidebarList"></div>';
      list = state.sidebarRoot.querySelector('#mtSidebarList');
    }
    return list;
  }

  function setWorkspaceChrome(active){
    const overlay=state.context?.overlayRoot || state.context?.roots?.overlay || document.getElementById('rOverlay');
    overlay?.classList.toggle('materials-workspace',active);
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
      const display = Number.isFinite(parsed) ? parsed.toLocaleString([], { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : cleanText(value);
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
        <div class="mt-note-compose-foot"><span class="mt-small"><i class="fas fa-eye"></i> ${String(escapeHtml(api.visibilityLabel(state.noteVisibility)))}</span><span><input type="file" data-mt-note-upload-input accept="image/*,video/*,audio/*,.pdf,.doc,.docx" hidden><button type="button" class="mt-note-visibility" data-mt-note-visibility aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_f9c51272aecc10","Note visibility") ?? "Note visibility")}"><i class="fas fa-eye"></i></button> <button type="button" class="mt-note-visibility" data-mt-note-upload aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_1a061030ca2e35","Upload media") ?? "Upload media")}"><i class="fas fa-paperclip"></i></button> <button type="button" class="mt-note-visibility" data-mt-note-audio aria-label="${(globalThis.PlatformLanguage?.htmlText("materials","m_dd978d5c5b3bd9","Record audio note") ?? "Record audio note")}"><span class="fm-voice-icon" aria-hidden="true" style="display:inline-block;width:1em;height:1em;flex:none;vertical-align:-.125em;background:currentColor;mask:url(/libraries/voice-icons/record.svg) center/contain no-repeat;-webkit-mask:url(/libraries/voice-icons/record.svg) center/contain no-repeat"></span></button> <button type="button" class="mt-note-save" data-mt-note-save>${String(state.editingNoteId ? 'Save note' : 'Add note')}</button></span></div>
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
                return `<div class="mt-resource-group" data-mt-resource-type="${type}"><div class="mt-resource-group-title"><i class="fas ${escapeHtml(terms.icon)}"></i>${escapeHtml(terms.plural)}</div>${lists.map((list) => renderScopeListCard(list, state.lists.indexOf(list))).join('')}</div>`;
              }).join('') || `<div class="mt-empty">${(globalThis.PlatformLanguage?.htmlText("materials","m_9138375c2ce3e1","This scope does not define any resource lists.") ?? "This scope does not define any resource lists.")}</div>`)}
              <button type="button" class="mt-list-add mt-list-regenerate" data-mt-generate-materials ${String(state.generatingMaterials || state.saving ? 'disabled' : '')}><i class="fas ${String(state.generatingMaterials ? 'fa-rotate mt-spin' : 'fa-arrows-rotate')}"></i> ${String(state.generatingMaterials ? 'Regenerating' : 'Regenerate from scope')}</button>
              <button type="button" class="mt-list-add" data-mt-open-new-list><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_b8547d1ae4d15f"," New scope list") ?? " New scope list")}</button>
            </div>
          </section>
          <section class="mt-left-group ${String(measurementsOpen ? '' : 'collapsed')}">
            <button type="button" class="mt-left-group-head" data-mt-left-toggle="measurements" aria-expanded="${String(measurementsOpen ? 'true' : 'false')}"><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_0ce54f0aa2d758","Scope measurements") ?? "Scope measurements")}</strong><span>${String(measurementRows.length)} <i class="fas fa-chevron-${String(measurementsOpen ? 'up' : 'down')}"></i></span></button>
            <div class="mt-left-group-body">
              ${String(measurementRows.length ? `<div class="mt-scope-measures">${measurementRows.map((row) => `<div class="mt-scope-measure"><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(row.value)}</strong></div>`).join('')}</div><div class="mt-small"><i class="fas fa-ruler-combined"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_4d90bde666c93e"," Project scope / FirstMeasure measurements") ?? " Project scope / FirstMeasure measurements")}</div>` : `<div class="mt-empty">${(globalThis.PlatformLanguage?.htmlText("materials","m_7bdd98e65148d7","No measurements are available yet. Link a completed FirstMeasure report or add scope measurements.") ?? "No measurements are available yet. Link a completed FirstMeasure report or add scope measurements.")}</div>`)}
            </div>
          </section>
          ${String(customFieldRows.length ? `<section class="mt-left-group ${customFieldsOpen ? '' : 'collapsed'}">
            <button type="button" class="mt-left-group-head" data-mt-left-toggle="custom_fields" aria-expanded="${customFieldsOpen ? 'true' : 'false'}"><strong>${(globalThis.PlatformLanguage?.htmlText("materials","m_2d1233007f5250","Custom fields") ?? "Custom fields")}</strong><span>${customFieldRows.length} <i class="fas fa-chevron-${customFieldsOpen ? 'up' : 'down'}"></i></span></button>
            <div class="mt-left-group-body">
              <div class="mt-scope-measures">${customFieldRows.map((row) => `<div class="mt-scope-measure"><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(row.display)}</strong></div>`).join('')}</div>
              <div class="mt-small"><i class="fas fa-table-list"></i>${(globalThis.PlatformLanguage?.htmlText("materials","m_2280f0c13c04b8"," Project custom fields selected for Scope") ?? " Project custom fields selected for Scope")}</div>
            </div>
          </section>` : '')}

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
    const status = list.metadata?.calculus_pending ? 'Ready to generate from signed document' : type === 'material'
      ? (!ordered ? 'Not ordered' : (schedulePending ? 'Not scheduled' : 'Ordered'))
      : (resourceScheduleEnabled(list) ? (eventParts.date ? `Scheduled ${eventParts.date}` : 'Not scheduled') : 'Ready');
    const controls = list.metadata?.calculus_pending ? `<div class="mt-list-secondary"><button type="button" data-mt-generate="${escapeHtml(id)}">Generate materials</button></div>` : type === 'labor'  ? renderLaborListControls(list) : renderListActionControls(list, type, ordered);
    return `<div class="mt-list-wrap${controls ? ' with-controls' : ''}" data-mt-list-wrap="${escapeHtml(id)}"><div class="mt-list-card ${state.activeListId === id ? 'active' : ''} ${incomplete ? 'incomplete' : 'complete'}" style="--list-color:${escapeHtml(color)}" data-mt-list-select="${escapeHtml(id)}" role="button" tabindex="0" aria-current="${state.activeListId === id ? 'true' : 'false'}">
      <span class="mt-list-card-copy"><strong>${escapeHtml(list.title || terms.list)}</strong><span><i class="fas ${type === 'material' && ordered ? 'fa-lock' : terms.icon}"></i>${escapeHtml(status)}</span>${list.metadata?.source_document ? `<span>From ${escapeHtml(list.metadata.source_document)}</span>` : ''}${(list.metadata?.calculation_warnings || []).map(message=>`<span class="mt-small">${escapeHtml(message)}</span>`).join('')}</span>
      <span class="mt-list-card-actions"><button type="button" class="mt-list-eye ${visible ? 'visible' : ''}" style="--list-color:${escapeHtml(color)}" data-mt-list-visibility="${escapeHtml(id)}" title="${visible ? 'Hide' : 'Show'} ${escapeHtml(list.title || terms.list)}" aria-pressed="${visible ? 'true' : 'false'}"><i class="fas fa-eye${visible ? '' : '-slash'}"></i></button></span>
    </div>${controls}</div>`;
  }

  function renderListActionControls(list, type, ordered){
    const id = cleanText(list.id);
    const schedule = resourceScheduleEnabled(list);
    if (!schedule && type !== 'material') return '';
    return `<div class="mt-list-secondary">${schedule ? `<button type="button" data-mt-list-schedule="${escapeHtml(id)}" title="Schedule" aria-label="Schedule" ${state.schedulingListId ? 'disabled' : ''}><i class="fas fa-calendar-day"></i></button>` : ''}${type === 'material' ? `<button type="button" class="${ordered ? 'is-done' : ''}" data-mt-list-order="${escapeHtml(id)}" title="${ordered ? 'Ordered' : 'Order'}" aria-label="${ordered ? 'Ordered' : 'Order'}"><i class="fas ${ordered ? 'fa-circle-check' : 'fa-cart-shopping'}"></i></button>` : ''}</div>`;
  }

  function laborPayLabel(mode){
    return ({ hourly:'Hourly', piece_rate:'Piece rate', hybrid:'Hourly + piece', salary:'Salary', none:'No pay' })[mode] || 'No pay';
  }

  // One reading of a labor list's assignment and pay, shared by its header control and settings popover.
  // Most projects still keep their measurements where this tab reads them rather than in a measurement dataset. They
  // are sent along in the dictionary's keys and units; the server uses them only when the project has no dataset.
  function legacyMeasurementPayload(){
    const m = projectMeasurements(), out = {};
    const put = (key, value, unit) => { const amount = Number(value); if (Number.isFinite(amount) && amount > 0) out[key] = { value: amount, unit }; };
    put('roofSquares', m.slopeSquares ?? m.shingleSquares, 'roofing_square');
    ['flatRoofSquares', 'pitch2to4Squares', 'pitch4to6Squares', 'pitch6to8Squares', 'pitch9to12Squares', 'pitch13PlusSquares'].forEach((key) => put(key, m[key], 'roofing_square'));
    ['eavesLf', 'rakesLf', 'hipsLf', 'ridgesLf', 'valleyLf'].forEach((key) => put(key, m[key], 'ft'));
    return out;
  }
  // What each assignee with a pay sheet would be paid for this list's project, read from the server and kept briefly.
  function assigneePay(listId){ return state.assigneePay?.[cleanText(listId)] || null; }
  function loadAssigneePay(listId, force = false){
    const id = cleanText(listId), api = (materialsAPI || window.MaterialsAPI)?.labor;
    if (!id || !api?.compare || !apiReady()) return Promise.resolve(null);
    const cached = assigneePay(id);
    if (cached && !force && (cached.loading || Date.now() - cached.at < 30000)) return cached.promise || Promise.resolve(cached);
    const entry = { loading: true, rows: cached?.rows || [], at: Date.now(), error: '' };
    // A project with no work order yet is compared as a project.
    const compared = id.startsWith('project:') ? api.compareProject?.(orgId(), id.slice(8), { legacy_measurements: legacyMeasurementPayload() }) : api.compare(orgId(), id, { legacy_measurements: legacyMeasurementPayload() });
    entry.promise = Promise.resolve(compared).then((result) => { entry.rows = Array.isArray(result?.assignees) ? result.assignees : []; }).catch((error) => { entry.error = error?.message || 'Pay could not be worked out.'; }).then(() => { entry.loading = false; entry.at = Date.now(); return entry; });
    state.assigneePay = { ...(state.assigneePay || {}), [id]: entry };
    return entry.promise;
  }
  function assigneePayFor(listId, resourceId){
    return (assigneePay(listId)?.rows || []).find((row) => cleanText(row.assignee?.id) === cleanText(resourceId)) || null;
  }
  // The price, or why there is not one yet. An hourly assignee has no job price until hours exist, so it says Hourly.
  function assigneePayLabel(row){
    if (!row) return '';
    if (!row.sheet) return 'No pay sheet';
    if (row.complete) return money(number(row.total_cents, 0) / 100);
    if (row.awaiting_hours) return row.cost_rate_cents != null && row.hourly_rate_cents == null ? 'Salaried' : 'Hourly';
    const needed = (row.missing_inputs || []).filter((input) => input.required).map((input) => cleanText(input.label))[0];
    return needed ? `Needs ${needed.toLowerCase()}` : 'Cannot price yet';
  }
  // Short facts about an assignee for this job, each with its own explanation on hover.
  function assigneePills(resource, row){
    const pill = (icon, label, tip, fit = false) => `<span class="mt-pill${fit ? ' fit' : ''}" title="${escapeHtml(tip)}"><i class="fas ${icon}" aria-hidden="true"></i><span>${escapeHtml(label)}</span></span>`;
    const pills = [];
    if (row?.hourly_rate_cents != null) pills.push(pill('fa-clock', `${money(number(row.hourly_rate_cents, 0) / 100)}/hr`, row?.estimated_hours != null ? `Paid by the hour at this rate. About ${row.estimated_hours} hours for this job, estimated from the work and the hours on their pay sheet; change the hours on the list to what you expect.` : 'Paid by the hour at this rate. Enter the hours on the list.'));
    if (row?.cost_rate_cents != null) pills.push(pill('fa-user-clock', `${money(number(row.cost_rate_cents, 0) / 100)}/hr`, 'Cost rate. They are on salary, so this is what an hour of their time costs you. It projects the job and is never paid out. Enter the hours on the list.'));
    (row?.equipment || []).filter((entry) => entry.included).forEach((entry) => pills.push(pill('fa-truck', cleanText(entry.name), `Brings their own ${cleanText(entry.name).toLowerCase()}, included in their pay.`, true)));
    (row?.equipment || []).filter((entry) => !entry.included).forEach((entry) => pills.push(pill('fa-truck', `${cleanText(entry.name)} ${money(number(entry.total_cents, 0) / 100)}`, `Brings their own ${cleanText(entry.name).toLowerCase()} and charges ${money(number(entry.total_cents, 0) / 100)} for it.`, true)));
    const open = (row?.not_covered || []).map((entry) => cleanText(entry.label)).filter(Boolean);
    if (open.length) pills.push(pill('fa-circle-exclamation', open.length === 1 ? `No ${open[0].toLowerCase()}` : `${open.length} left over`, `Their pay sheet does not cover: ${open.join(', ').toLowerCase()}. Something else has to.`, true));
    const unable = (row?.not_capable || []).map((entry) => cleanText(entry.label)).filter(Boolean);
    if (unable.length) pills.push(pill('fa-user-xmark', `${unable.length} not marked`, `Not marked as able to do: ${unable.join(', ').toLowerCase()}.`, true));
    const basis = row?.duration_basis;
    const days = row?.duration_days ? `${row.duration_days} day${row.duration_days === 1 ? '' : 's'}` : '';
    if (days) pills.push(pill('fa-calendar-day', `${row.duration_days}d`, basis ? `${days}. An estimate: ${Math.round(number(basis.value, 0) * 10) / 10} ${cleanText(basis.label).toLowerCase()} at ${basis.units_per_day} a day, the speed on their pay sheet.` : `${days}. An estimate from the speed on their pay sheet.`));
    return pills.join('');
  }
  // The organization's own word for the kind of assignee, cut short to fit; the whole word is in the tooltip.
  function assigneeKindPill(resource){
    const outside = cleanText(resource.resource_kind) === 'organization_connection';
    const groupType = !outside ? (state.workforceGroupKinds || []).find((kind) => cleanText(kind?.id) && cleanText(kind.id) === cleanText(resource.kind_id || resource.group_kind_id || resource.resource_group_kind_id)) : null;
    const label = cleanText(groupType?.label || groupType?.name || groupType?.singular) || cleanText(workforceLabel(cleanText(resource.resource_kind) || 'resource_group'));
    const word = label.split(/\s+/)[0] || label, short = label.length <= 5 ? label : word.slice(0, /[aeiouy]/i.test(word.charAt(2)) ? 4 : 3);
    return `<span class="mt-pill plain" title="${escapeHtml(`${label}. ${outside ? 'An outside company.' : 'People inside your organization.'}`)}">${escapeHtml(short)}</span>`;
  }
  // Both assignment entry points offer the same work overlap and pay-sheet ranking.
  function laborAssignmentOptions(list){
    const id = cleanText(list.id), pay = assigneePay(id);
    const rank = (row) => (row?.complete ? 0 : row?.sheet ? 1 : 2);
    // Only who does some of this job's work is offered: by their pay sheet, or by what they are marked as able to do.
    // A job that requires no work yet offers whoever has a pay sheet.
    const needsWork = (requirementSet()?.data?.requirements || []).some((row) => row.kind !== 'material');
    const offered = (row) => !!row && (needsWork ? number(row.overlap, 0) > 0 : !!row.sheet);
    const options = workResourcesForScopeList(list).map((resource) => ({ resource, row: assigneePayFor(id, resource.id) })).filter(({ row }) => offered(row))
      .sort((a, b) => rank(a.row) - rank(b.row) || number(a.row?.total_cents, Infinity) - number(b.row?.total_cents, Infinity) || cleanText(a.resource.name).localeCompare(cleanText(b.resource.name)));
    return { options, needsWork, pay };
  }
  // An unassigned, empty labor list asks who does the work, with what each choice would cost.
  function renderAssignBlock(list){
    const id = cleanText(list.id), { options, needsWork, pay } = laborAssignmentOptions(list);
    if (!pay) loadAssigneePay(id).then(() => { if (!workspaceIsEditing()) syncMaterialsGrid(); });
    return `<div class="mt-assign-block${state.assigningListId === id ? ' is-busy' : ''}" data-mt-assign-block="${escapeHtml(id)}"><strong title="Choose who does this work. Their pay sheet builds the list, and you can add or change lines afterwards.">Assign this work <i class="fas fa-circle-info" aria-hidden="true"></i></strong>${options.length ? '' : `<em>${pay?.loading || !pay ? 'Finding who can do this work…' : needsWork ? 'No one is marked as doing this job\'s work. Give an assignee a pay sheet, or mark the kinds of work they do.' : 'No one has a pay sheet yet.'}</em>`}${options.map(({ resource, row }) => `<button type="button" data-mt-assign-pick="${escapeHtml(id)}" data-mt-assign-resource="${escapeHtml(cleanText(resource.id))}"><span class="mt-assign-top"><strong title="${escapeHtml(resource.name || resource.label || resource.id)}">${escapeHtml(resource.name || resource.label || resource.id)}</strong><b class="${row?.complete ? '' : 'unknown'}">${escapeHtml(pay?.loading && !row ? '…' : assigneePayLabel(row))}</b></span><span class="mt-assign-pills">${assigneeKindPill(resource)}${assigneePills(resource, row)}</span></button>`).join('')}</div>`;
  }
  // Generating writes the list. Hours and the like are typed into their own lines afterwards; only a number that is not
  // a line's quantity is asked for first.
  async function generateLaborList(listId, manual){
    const id = cleanText(listId), api = (materialsAPI || window.MaterialsAPI)?.labor, list = materialListById(id);
    if (!list || !api?.generate || !apiReady()) return;
    const operation = captureProjectOperation(id);
    try {
      if (manual === undefined) {
        const preview = await api.preview(orgId(), id, { legacy_measurements: legacyMeasurementPayload() });
        if (!projectOperationIsCurrent(operation)) return;
        const inputs = Array.isArray(preview?.ask) ? preview.ask : [];
        if (inputs.length) { openGenerateMenu(id, inputs); return; }
        manual = {};
      }
      const result = await api.generate(orgId(), id, { manual, legacy_measurements: legacyMeasurementPayload() });
      if (!projectOperationIsCurrent(operation)) return;
      updateMaterialListState(result?.material_list);
      state.assigneePay = { ...(state.assigneePay || {}), [id]: null };
      await loadExpenseProjection();
      if (!projectOperationIsCurrent(operation)) return;
      render({ preserveScroll: true });
      const evaluation = result?.evaluation || {}, gaps = (evaluation.unresolved || []).length;
      const typed = listItems(materialListById(id)).filter((item) => item.metadata?.quantity_needed === true && !(number(item.quantity, 0) > 0)).map((item) => cleanText(item.metadata.quantity_label || item.name).toLowerCase());
      const waiting = listItems(materialListById(id)).filter((item) => item.metadata?.unresolved === true).length;
      showToast(waiting ? 'Generated with gaps' : 'Labor generated', waiting ? `${waiting} line${waiting === 1 ? '' : 's'} could not be priced yet. Hover one to see what it is waiting for.` : typed.length ? `Enter ${typed.join(' and ')} on the list to finish pricing it.` : money(number(evaluation.total_cents, 0) / 100), !waiting);
    } catch (error) {
      if (projectOperationIsCurrent(operation)) showToast('Could not generate labor', error?.message || 'Please try again.', false);
    }
  }
  function syncAssignBusy(){
    materialRoot()?.querySelectorAll?.('[data-mt-assign-block]')?.forEach((block) => block.classList.toggle('is-busy', block.dataset.mtAssignBlock === state.assigningListId));
  }
  // The block is never disabled by the page-wide saving flag, which a background line save can leave on a block drawn
  // mid-save. One assignment runs at a time, and it waits for line saves so it writes on the revision they leave.
  async function assignAndGenerate(listId, resourceId){
    let id = cleanText(listId);
    if (!id || state.assigningListId) return;
    // Choosing someone before the project has a work order makes the work order first.
    if (id.startsWith('project:')) {
      state.assigningListId = id; syncAssignBusy();
      try { const created = await createResourceList('labor'); id = cleanText(created?.id); }
      catch (error) { showToast('Could not create the work order', error?.message || 'Please try again.', false); return; }
      finally { state.assigningListId = ''; }
      if (!id) return;
    }
    const operation = captureProjectOperation(id);
    state.assigningListId = id;
    syncAssignBusy();
    try {
      for (let waited = 0; (state.saving || listWritesPending()) && waited < 15000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      if (!projectOperationIsCurrent(operation)) return;
      if (state.saving || listWritesPending()) { showToast('Still saving', 'Earlier changes are still saving. Please try again in a moment.', false); return; }
      await assignWorkResource(id, resourceId);
      if (cleanText(assignmentWorkResourceRef(materialListById(id))?.id) === cleanText(resourceId)) await generateLaborList(id);
    } finally {
      state.assigningListId = '';
      syncAssignBusy();
    }
  }
  function closeGenerateMenu(){
    document.querySelectorAll?.('[data-mt-generate-portal]')?.forEach((node) => node.remove());
    document.removeEventListener('pointerdown', generateMenuDismiss, true);
    document.removeEventListener('keydown', generateMenuDismiss, true);
  }
  function generateMenuDismiss(event){
    if (event.type === 'keydown' ? event.key === 'Escape' : !event.target?.closest?.('[data-mt-generate-portal],[data-mt-labor-generate]')) closeGenerateMenu();
  }
  function openGenerateMenu(listId, inputs){
    closeGenerateMenu();
    const list = materialListById(listId);
    const trigger = Array.from(materialRoot()?.querySelectorAll?.('[data-mt-labor-generate]') || []).find((button) => button.dataset.mtLaborGenerate === listId);
    if (!list) return;
    const previous = list.metadata?.labor_generation?.manual || {};
    const portal = document.createElement('form');
    portal.className = 'mt-labor-portal mt-generate-portal';
    portal.dataset.mtGeneratePortal = '';
    portal.setAttribute('aria-label', 'Numbers needed to generate this list');
    portal.innerHTML = `<div class="mt-labor-menu-title">Needed for this job</div>${inputs.map((input) => `<label><span>${escapeHtml(input.label || input.name)}${input.required ? '' : ' <em>optional</em>'}</span><input type="number" min="0" step="any" inputmode="decimal" name="${escapeHtml(input.name)}" value="${escapeHtml(previous[input.name] ?? '')}" ${input.required ? 'required' : ''}></label>`).join('')}<button type="submit" class="mt-labor-regenerate"><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> Generate</button>`;
    colorPortalHost(state.panelRoot).appendChild(portal);
    const rect = (trigger || materialRoot())?.getBoundingClientRect?.() || { right: 320, bottom: 80, top: 80 };
    const width = portal.offsetWidth || 260, height = portal.offsetHeight || 160;
    portal.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
    portal.style.top = `${rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)}px`;
    portal.addEventListener('submit', (event) => {
      event.preventDefault();
      const manual = {};
      inputs.forEach((input) => { const raw = portal.elements[input.name]?.value; if (raw !== '' && raw != null && Number.isFinite(Number(raw))) manual[input.name] = Number(raw); });
      closeGenerateMenu();
      generateLaborList(listId, manual);
    });
    document.addEventListener('pointerdown', generateMenuDismiss, true);
    document.addEventListener('keydown', generateMenuDismiss, true);
    portal.querySelector('input')?.focus();
  }
  // ---- Requirements: everything the project needs, and what on the lists accounts for each thing. The lists carry
  // the money; this carries none. It is read from the server, which reads it from the lists as they stand.
  function requirementsOpen(){
    if (state.requirementsOpen == null) { let saved = null; try { saved = rootWindow.localStorage?.getItem?.('fm_scope_requirements_open'); } catch (_) {} state.requirementsOpen = saved === '1'; }
    return state.requirementsOpen;
  }
  function requirementsKey(){ return `${orgId()}:${projectId()}`; }
  function requirementSet(){ return state.requirements?.key === requirementsKey() ? state.requirements : null; }
  function loadRequirements(force = false){
    const api = (materialsAPI || window.MaterialsAPI)?.labor, key = requirementsKey();
    if (!api?.requirements || !apiReady() || !projectId()) return Promise.resolve(null);
    const cached = requirementSet();
    if (cached && !force) return cached.promise || Promise.resolve(cached);
    let hints = [];
    try { hints = [...new Set((scopeForMaterials()?.pieces || []).map((piece) => cleanText(piece?.template_id || piece?.templateId || piece?.type)).filter((id) => id && id !== 'manual'))].slice(0, 50); } catch (_) {}
    const entry = { key, loading: true, data: cached?.data || null, error: '', serial: (cached?.serial || 0) + 1 };
    entry.promise = Promise.resolve(api.requirements(orgId(), projectId(), { legacy_measurements: legacyMeasurementPayload(), ...(hints.length ? { scope_template_ids: hints } : {}) }))
      .then((result) => { entry.data = result || null; }).catch((error) => { entry.error = error?.message || 'Requirements could not be worked out.'; })
      .then(() => { entry.loading = false; return entry; });
    state.requirements = entry;
    return entry.promise;
  }
  // Anything that changes a list can change what is accounted for, so the read follows shortly after the last change.
  function refreshRequirements(){
    clearTimeout(state.requirementsTimer);
    state.requirementsTimer = setTimeout(() => {
      const before = JSON.stringify(requirementSet()?.data?.line_warnings || []);
      loadRequirements(true).then((entry) => {
        if (!entry || state.requirements !== entry) return;
        // Line warnings live in the rows; the rows are redrawn only when they changed and nobody is typing.
        if (JSON.stringify(entry.data?.line_warnings || []) !== before && !workspaceIsEditing()) syncMaterialsGrid(); else syncRequirementsTray();
      });
    }, 500);
  }
  function lineWarnings(listId, itemId){
    return (requirementSet()?.data?.line_warnings || []).filter((warning) => cleanText(warning.list_id) === cleanText(listId) && cleanText(warning.item_id) === cleanText(itemId));
  }
  function requirementAmount(row){
    if (row.quantity == null || row.unit === 'job') return '';
    const unit = ({ roofing_square: 'sq', yd3: 'yd³' })[row.unit] ?? cleanText(row.unit);
    return `${(Math.round(number(row.quantity, 0) * 10) / 10).toLocaleString('en-US')} ${unit}`.trim();
  }
  const REQUIREMENT_STATUS = { open: ['fa-circle-exclamation', 'Not accounted for'], warning: ['fa-triangle-exclamation', 'Accounted for, with something to check'], covered: ['fa-circle-check', 'Accounted for'] };
  // A requirement carries the icon of the list that meets it: material, the work order's labor, or its equipment.
  function requirementKind(row){
    const type = row.kind === 'material' ? 'material' : row.kind === 'function' ? 'equipment' : 'labor', category = resourceCategories().find((entry) => entry.id === type) || {};
    const what = row.kind === 'material' ? 'Material to have on a material list' : row.kind === 'function' ? 'Something the job needs besides labor, met by equipment or by whoever takes care of it' : 'Work to be done, met by a work order';
    return { type, icon: cleanText(category.icon) || ({ material: 'fa-cubes', labor: 'fa-helmet-safety', equipment: 'fa-truck-pickup' })[type], color: cleanText(category.color) || '#667085', what };
  }
  function renderRequirementRow(row){
    // A covered requirement says how far it has got, as worked out on the server from the covering lists: everything
    // covering it scheduled (a calendar), or actually done (a check on green).
    const progress = row.status === 'covered' && ['scheduled', 'completed'].includes(row.progress) ? row.progress : '';
    const id = cleanText(row.id), expanded = !!state.expandedRequirementIds?.has(id), [icon, meaning] = progress === 'completed' ? ['fa-circle-check', 'Completed'] : progress === 'scheduled' ? ['fa-calendar-check', 'Accounted for and scheduled'] : REQUIREMENT_STATUS[row.status] || REQUIREMENT_STATUS.open;
    const covers = row.covered_by || [], by = covers.map((cover) => cleanText(cover.assignee_name || cover.list_title)).filter(Boolean);
    const kind = requirementKind(row);
    const from = [...new Set((row.sources || []).map((source) => cleanText(source.title)).filter(Boolean))];
    const byHand = row.kind !== 'material' && (requirementSet()?.data?.manual_work || []).some((entry) => entry.item === id);
    const tipHtml = requirementTooltip(row, kind, from);
    const tip = [`${row.label}${requirementAmount(row) ? `, ${requirementAmount(row)}` : ''}`, `${kind.what}.${row.description ? ` ${cleanText(row.description)}` : ''}`, from.length && row.kind !== 'material' ? `Required by: ${from.join(', ')}` : '', meaning + (by.length ? `: ${[...new Set(by)].join(', ')}` : ''), ...(row.warnings || []).map((warning) => cleanText(warning.message)), cleanText(row.reason)].filter(Boolean).join('\n');
    // How a cover reads depends on what is covered: work is done by someone, a function is taken care of, material is listed.
    const coverSays = (cover) => row.kind === 'material' ? 'Listed here' : cover.mode === 'included' ? (row.kind === 'function' ? 'Takes care of this at no separate charge' : 'Does this work at no separate charge') : cover.mode === 'provided' ? 'Brings equipment that takes care of this' : row.kind === 'function' ? (cover.assignee_name ? 'Takes care of this, on these line items' : 'These line items take care of this') : 'Does this work, on these line items';
    const lineMoney = (line) => line.total_cents == null ? '' : money(number(line.total_cents, 0) / 100);
    // Lines a person added to a work order, which they may mark as taking care of this.
    const handLines = row.kind === 'material' || row.status !== 'open' ? [] : state.lists.filter((list) => (row.kind === 'function' ? ['labor', 'equipment'] : ['labor']).includes(resourceType(list))).flatMap((list) => listItems(list).filter((item) => item.metadata?.generated_from_pay_sheet !== true && !(item.metadata?.covers || []).includes(id)).map((item) => ({ list, item })));
    const detail = !expanded ? '' : `<div class="mt-req-detail">${byHand ? `<div class="mt-req-source" title="You added this to the job by hand.${from.length > 1 ? ` It is also required by ${from.filter((title) => title !== 'Added by hand').join(', ')}, which stays.` : ''}"><span>Added by hand</span><button type="button" class="mt-req-remove" data-mt-req-unrequire="${escapeHtml(id)}">Remove</button></div>` : ''}${row.reason ? `<p class="mt-req-note">${escapeHtml(row.reason)}</p>` : ''}
      ${(row.warnings || []).map((warning) => `<p class="mt-req-warning"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><span>${escapeHtml(warning.message)}</span></p>`).join('')}
      ${covers.map((cover) => { const name = cleanText(cover.assignee_name || cover.list_title), list = materialListById(cover.list_id), mine = !!list && resourceType(list) === 'labor' && !!assignmentWorkResourceRef(list)?.id;
        const lines = (cover.lines || []).map((line) => `<li><span title="${escapeHtml(line.name)}">${escapeHtml(line.name)}</span><em>${escapeHtml([number(line.quantity, 0) ? `${Math.round(number(line.quantity, 0) * 100) / 100} ${cleanText(line.unit)}`.trim() : '', lineMoney(line)].filter(Boolean).join(' · '))}</em>${row.kind !== 'material' && line.generated === false ? `<button type="button" data-mt-req-unmark="${escapeHtml(id)}" data-mt-list-id="${escapeHtml(cover.list_id)}" data-mt-item-id="${escapeHtml(line.id)}" title="This line no longer accounts for it" aria-label="Unmark ${escapeHtml(line.name)}"><i class="fas fa-xmark" aria-hidden="true"></i></button>` : ''}</li>`).join('');
        const only = (cover.lines || []).length === 1 && !(row.kind !== 'material' && cover.lines[0].generated === false) ? cover.lines[0] : null;
        const onlyAmount = only ? [number(only.quantity, 0) ? `${Math.round(number(only.quantity, 0) * 100) / 100} ${cleanText(only.unit)}`.trim() : '', lineMoney(only)].filter(Boolean).join(' · ') : '';
        return `<div class="mt-req-cover"><div class="mt-req-cover-head" title="${escapeHtml(`${name}: ${coverSays(cover).toLowerCase()}.${only ? `\n${cleanText(only.name)}${onlyAmount ? `, ${onlyAmount}` : ''}` : ''}`)}"><strong>${escapeHtml(name)}</strong>${cover.completed ? '<span class="mt-req-cover-state">Done</span>' : cover.scheduled ? '<span class="mt-req-cover-state">Scheduled</span>' : ''}${only ? `<em>${escapeHtml(only.name)}</em>` : ''}${row.kind !== 'material' && mine && cover.mode !== 'provided' && (cover.lines || []).every((line) => line.generated !== false) ? `<button type="button" class="mt-req-remove" data-mt-req-exclude="${escapeHtml(id)}" data-mt-list-id="${escapeHtml(cover.list_id)}" title="Remove this from ${escapeHtml(name)}'s work order so someone else can do it. Their work order is built again without it.">Remove</button>` : ''}</div>${lines && !only ? `<ul>${lines}</ul>` : ''}</div>`; }).join('')}
      ${(row.can_cover || []).map((entry) => `<button type="button" class="mt-req-action" data-mt-req-include="${escapeHtml(id)}" data-mt-list-id="${escapeHtml(entry.list_id)}" title="Put this back on ${escapeHtml(entry.assignee_name)}'s work order. Their list is built again with it."><i class="fas fa-plus" aria-hidden="true"></i><span>${escapeHtml(entry.assignee_name)}</span></button>`).join('')}
      ${handLines.length ? `<label class="mt-req-mark"><select data-mt-req-mark="${escapeHtml(id)}" aria-label="Choose a line item that ${row.kind === 'function' ? 'takes care of this' : 'does this work'}" title="${row.kind === 'function' ? 'Line items you added to a work order or an equipment list. Choose the one that takes care of this.' : 'Line items you added to a work order. Choose the one that pays for this work.'}"><option value="">Choose a line item</option>${handLines.map(({ list, item }) => `<option value="${escapeHtml(`${list.id}|${item.id}`)}">${escapeHtml(`${cleanText(item.name) || 'Untitled'} · ${cleanText(assignmentWorkResourceRef(list)?.name || list.title) || resourceTerms(resourceType(list), list).plural}`)}</option>`).join('')}</select></label>` : row.status === 'open' && row.kind !== 'material' ? `<p class="mt-req-note">${row.kind === 'function' ? 'Assign someone who takes care of this, or add an equipment line item for it and choose it here.' : 'Assign a work order that covers this work, or add a line item to a work order for it and choose it here.'}</p>` : ''}
    </div>`;
    return `<div class="mt-req-row is-${escapeHtml(row.status)}${progress ? ` is-${progress}` : ''}${expanded ? ' is-expanded' : ''}${row.under ? ' is-caused' : ''}" data-mt-req-row="${escapeHtml(id)}"><button type="button" class="mt-req-head" data-mt-req-toggle="${escapeHtml(id)}" aria-expanded="${expanded}" aria-label="${escapeHtml(tip)}" data-fm-tooltip-html="${escapeHtml(tipHtml)}"><i class="fas ${icon} mt-req-dot" aria-hidden="true"></i><i class="fas ${escapeHtml(kind.icon)} mt-req-kind" style="color:${escapeHtml(kind.color)}" aria-hidden="true"></i><span>${escapeHtml(row.label)}</span><em>${escapeHtml(requirementAmount(row))}</em><i class="fas fa-chevron-${expanded ? 'down' : 'right'} mt-req-chevron" aria-hidden="true"></i></button>${!expanded && requirementWhy(row) ? `<small class="mt-req-why">${escapeHtml(requirementWhy(row))}</small>` : ''}${detail}</div>`;
  }
  // Why something is not settled, in one short sentence: shown under the row and leading its tooltip.
  function requirementWhy(row){
    if (row.status === 'covered') return '';
    const warning = cleanText(row.warnings?.[0]?.message);
    if (row.status === 'warning') return warning || 'Accounted for, with something to check.';
    if (row.kind === 'material') return 'Not on a material list yet.';
    return row.kind === 'function' ? 'Nothing on the work order takes care of this yet.' : 'No work order does this yet.';
  }
  function requirementTooltip(row, kind, from){
    const amount = requirementAmount(row);
    const by = [...new Set((row.covered_by || []).flatMap((cover) => (cover.lines || []).length ? cover.lines.map((line) => cleanText(line.name)) : [cleanText(cover.assignee_name || cover.list_title)]).filter(Boolean))];
    const state = row.status === 'open' ? 'Missing' : row.status === 'warning' ? 'To check' : row.progress === 'completed' ? 'Done' : row.progress === 'scheduled' ? 'Scheduled' : 'Accounted for';
    const lines = [
      `<div class="fm-tooltip-title">${escapeHtml(row.label)}${amount ? ` · ${escapeHtml(amount)}` : ''}</div>`,
      `<div><b>${escapeHtml(state)}</b>${requirementWhy(row) ? ` — ${escapeHtml(requirementWhy(row))}` : ''}</div>`,
      ...(row.warnings || []).slice(1).map((warning) => `<div>${escapeHtml(cleanText(warning.message))}</div>`),
      by.length ? `<div style="opacity:.75">By ${escapeHtml(by.join(', '))}</div>` : '',
      from.length && row.kind !== 'material' ? `<div style="opacity:.6">For ${escapeHtml(from.join(', '))}</div>` : ''
    ];
    return lines.filter(Boolean).join('');
  }
  function renderRequirementsTray(){
    const open = requirementsOpen(), set = requirementSet();
    if (!set) loadRequirements().then((entry) => { if (entry && state.requirements === entry) { if ((entry.data?.line_warnings || []).length && !workspaceIsEditing()) syncMaterialsGrid(); else syncRequirementsTray(); } });
    const data = set?.data, rows = data?.requirements || [], counts = data?.counts || { open: 0, warning: 0, covered: 0 };
    const status = !data ? 'loading' : data.status;
    // Collapsed, the bar alone says how the project stands: red for anything missing, yellow for anything to check, green when neither.
    const badges = status === 'loading' ? '<i class="fas fa-circle-notch mt-spin" aria-hidden="true"></i>' : status === 'empty' ? '<i class="fas fa-minus" aria-hidden="true"></i>'
      : `${counts.open ? `<span class="mt-req-badge is-open" title="${counts.open} not accounted for">${counts.open}</span>` : ''}${counts.warning ? `<span class="mt-req-badge is-warning" title="${counts.warning} to check">${counts.warning}</span>` : ''}${!counts.open && !counts.warning ? '<span class="mt-req-badge is-covered" title="Everything is accounted for"><i class="fas fa-circle-check" aria-hidden="true"></i></span>' : ''}`;
    const summary = status === 'loading' ? 'Working out what this project requires' : status === 'empty' ? 'No requirements yet' : [counts.open ? `${counts.open} not accounted for` : '', counts.warning ? `${counts.warning} to check` : '', !counts.open && !counts.warning ? 'Everything is accounted for' : ''].filter(Boolean).join(', ');
    const attention = rows.filter((row) => row.status !== 'covered').sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open'));
    const settled = rows.filter((row) => row.status === 'covered');
    const group = (key, label, list) => { if (!list.length) return ''; const collapsed = !!state.collapsedRequirementGroups?.has(key); return `<section class="mt-req-group${collapsed ? ' is-collapsed' : ''}"><button type="button" class="mt-req-group-head" data-mt-req-group="${escapeHtml(key)}" aria-expanded="${!collapsed}"><i class="fas fa-chevron-${collapsed ? 'right' : 'down'}" aria-hidden="true"></i><span>${escapeHtml(label)}</span><em>${list.length}</em></button>${collapsed ? '' : list.map(renderRequirementRow).join('')}</section>`; };
    const body = set?.error ? `<p class="mt-req-note">${escapeHtml(set.error)}</p>` : !data ? '<p class="mt-req-note">Working out what this project requires…</p>' : !rows.length ? `<p class="mt-req-note">${escapeHtml(data.reason || 'Nothing is required yet.')}</p>`
      : `${group('missing', 'Missing', attention.filter((row) => row.status === 'open'))}${group('check', 'To check', attention.filter((row) => row.status !== 'open'))}${group('material', 'Materials', settled.filter((row) => row.kind === 'material'))}${group('work', 'Work', settled.filter((row) => row.kind === 'work'))}${group('function', 'Other', settled.filter((row) => row.kind === 'function'))}`;
    return `<aside class="mt-req-tray${open ? ' is-open' : ''}" data-mt-req-tray data-status="${escapeHtml(status)}" aria-label="Requirements"><button type="button" class="mt-req-bar" data-mt-req-open aria-expanded="${open}" title="${escapeHtml(`Requirements: ${summary}. ${open ? 'Click to close.' : 'Click to open.'}`)}" aria-label="${escapeHtml(`Requirements: ${summary}`)}"><i class="fas fa-chevron-left mt-req-arrow" aria-hidden="true"></i><span class="mt-req-badges">${badges}</span><span class="mt-req-bar-label">Requirements</span></button><div class="mt-req-panel"><div class="mt-req-panel-inner"><header class="mt-req-title"><div><strong>Requirements</strong><span>${escapeHtml(summary)}</span></div>${counts.open || state.resolvingRequirements ? `<button type="button" class="mt-req-fix" data-mt-req-fix ${state.resolvingRequirements ? 'disabled' : ''} title="Fix all: generate only what the open requirements need — the signed document's materials, work orders, and equipment that provides what is missing" aria-label="Fix all requirements"><i class="fas ${state.resolvingRequirements ? 'fa-circle-notch mt-spin' : 'fa-wand-magic-sparkles'}" aria-hidden="true"></i><span>Fix all</span></button>` : ''}${(data?.available || []).length ? `<select data-mt-req-add aria-label="Add a requirement by hand" title="Add something this job includes that no accepted document has listed. It is sized from the measurements."><option value="">+ Add</option>${data.available.map((entry) => `<option value="${escapeHtml(entry.item)}" title="${escapeHtml(entry.description || '')}">${escapeHtml(entry.label)}</option>`).join('')}</select>` : ''}</header><div class="mt-req-scroll">${body}</div></div></div></aside>`;
  }
  function syncRequirementsTray(){
    const current = materialRoot()?.querySelector?.('[data-mt-req-tray]');
    if (!current) return;
    const scroll = current.querySelector('.mt-req-scroll')?.scrollTop || 0, holder = document.createElement('div');
    holder.innerHTML = renderRequirementsTray();
    const next = holder.firstElementChild;
    current.replaceWith(next);
    const scroller = next.querySelector('.mt-req-scroll');
    if (scroller) scroller.scrollTop = scroll;
    bindRequirements(next.parentElement || next);
  }
  // Taking work off a work order, or giving it back, builds that list again from its pay sheet without or with it.
  async function setWorkExcluded(listId, requirement, excluded){
    const list = materialListById(listId);
    if (!list || state.assigningListId) return;
    const operation = captureProjectOperation(listId), next = new Set(list.metadata?.work_scope?.excluded_items || []);
    if (excluded) next.add(requirement); else next.delete(requirement);
    state.assigningListId = cleanText(listId);
    try {
      await patchScopeResourceList(listId, { metadata: { ...(list.metadata || {}), work_scope: { ...(list.metadata?.work_scope || {}), excluded_items: [...next] } } }, operation);
      if (projectOperationIsCurrent(operation)) await generateLaborList(listId);
    } catch (error) {
      if (projectOperationIsCurrent(operation)) showToast('Could not change the work order', error?.message || 'Please try again.', false);
    } finally {
      state.assigningListId = '';
      refreshRequirements();
    }
  }
  // What a person adds by hand is one artifact on the project, replaced as a whole each time it changes.
  async function setManualRequirement(item, required){
    const api = (materialsAPI || window.MaterialsAPI)?.labor, current = requirementSet()?.data?.manual_work || [];
    if (!api?.saveManualScope || !item || state.savingManualScope) return;
    const operation = captureProjectOperation();
    state.savingManualScope = true;
    try {
      await api.saveManualScope(operation.orgId, operation.projectId, required ? [...current.filter((entry) => entry.item !== item), { item }] : current.filter((entry) => entry.item !== item));
    } catch (error) {
      if (projectOperationIsCurrent(operation)) showToast('Could not change what this job includes', error?.message || 'Please try again.', false);
    } finally {
      state.savingManualScope = false;
      if (projectOperationIsCurrent(operation)) { state.assigneePay = {}; refreshRequirements(); }
    }
  }
  // Fix all: goes through what generation can do, and does only what an open requirement needs. Warnings are left for a
  // person: they mean two things already account for something, and choosing between them is a decision.
  async function ensureEquipmentCatalog(){
    if (!window.EquipmentAPI?.units || !orgId()) return;
    if (!state.equipmentUnits) state.equipmentUnits = await Promise.resolve(window.EquipmentAPI.units(orgId())).then((result) => (Array.isArray(result?.units) ? result.units : []).filter((unit) => cleanText(unit.status) !== 'archived')).catch(() => []);
    if (!state.equipmentTypes && window.EquipmentAPI.types) state.equipmentTypes = await Promise.resolve(window.EquipmentAPI.types(orgId())).then((result) => (Array.isArray(result?.types) ? result.types : []).filter((type) => cleanText(type.status) !== 'archived')).catch(() => []);
  }
  // The equipment that best meets a function: something emptied and reused before anything else, then the smallest
  // that holds it all, then the largest, as many as it takes.
  function equipmentForRequirement(row){
    const need = number(row.quantity, 0);
    const offers = [
      ...(state.equipmentUnits || []).map((unit) => ({ name: cleanText(unit.name || unit.label), unit_id: cleanText(unit.id), type_id: cleanText(unit.type_id), daily: number(unit.rates?.daily_cents, 0), provides: equipmentProvides(unit.effective_provides) })),
      ...(state.equipmentTypes || []).map((type) => ({ name: cleanText(type.name), unit_id: '', type_id: cleanText(type.id), daily: number(type.default_rates?.daily_cents, 0), provides: equipmentProvides(type.provides) }))
    ].map((offer) => ({ ...offer, fn: offer.provides.find((entry) => entry.item === row.id) })).filter((offer) => offer.name && offer.fn);
    const holds = (offer) => (offer.fn.per_load || !(Number(offer.fn.capacity) > 0) ? Infinity : Number(offer.fn.capacity));
    const ranked = offers.sort((a, b) => Number(holds(b) === Infinity) - Number(holds(a) === Infinity) || Number(holds(b) >= need) - Number(holds(a) >= need) || (holds(a) >= need ? holds(a) - holds(b) : holds(b) - holds(a)));
    const best = ranked[0];
    const quantity = holds(best ?? { fn: {} }) === Infinity || !(need > 0) ? 1 : Math.ceil(need / holds(best));
    return best ? { ...best, quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1 } : null;
  }
  async function createResourceList(type){
    const operation = captureProjectOperation(), category = resourceCategories().find((row) => row.id === type);
    const result = await (materialsAPI || window.MaterialsAPI).projects.create(operation.orgId, operation.projectId, { title: '', resource_type: type, color: category?.color || companyPrimaryColor(), branch_id: branchId(), sections: [], items: [], metadata: { source: 'scope_tab', manually_created: true, placeholder_title: true } });
    return updateMaterialListState(result?.material_list || result?.list);
  }
  async function resolveRequirements(){
    if (state.resolvingRequirements) return;
    const operation = captureProjectOperation(), done = [], notes = [];
    const open = () => (requirementSet()?.data?.requirements || []).filter((row) => row.status === 'open');
    const fresh = async () => { await loadRequirements(true); return projectOperationIsCurrent(operation); };
    state.resolvingRequirements = true;
    syncRequirementsTray();
    try {
      if (!requirementSet()?.data && !(await fresh())) return;
      // 1. Material a signed document published that nobody generated.
      if (open().some((row) => row.kind === 'material')) {
        const result = await generatePendingMaterialSets();
        done.push(...result.generated.map((title) => `Generated ${title}`)); notes.push(...result.failed);
        if (!(await fresh())) return;
      }
      // 2. Work an assigned work order's pay sheet handles but nothing accounts for: it was left to someone else, or the
      // line that paid for it was deleted. Each such work order is built again from its sheet once, with that work back
      // in it; lines added by hand stay.
      const rebuild = new Map();
      for (const row of open()) {
        const entry = (row.can_cover || [])[0];
        if (!entry) continue;
        if (!rebuild.has(entry.list_id)) rebuild.set(entry.list_id, { entry, rows: [] });
        rebuild.get(entry.list_id).rows.push(row);
      }
      for (const { entry, rows } of rebuild.values()) {
        const list = materialListById(entry.list_id);
        if (!list || !projectOperationIsCurrent(operation)) continue;
        const excluded = new Set(list.metadata?.work_scope?.excluded_items || []), returning = rows.filter((row) => excluded.has(row.id));
        if (returning.length) {
          returning.forEach((row) => excluded.delete(row.id));
          await patchScopeResourceList(entry.list_id, { metadata: { ...(list.metadata || {}), work_scope: { ...(list.metadata?.work_scope || {}), excluded_items: [...excluded] } } }, captureProjectOperation(entry.list_id));
        }
        await generateLaborList(entry.list_id, {});
        done.push(`Rebuilt ${entry.assignee_name}'s work order from their pay sheet, so it covers ${rows.map((row) => row.label.toLowerCase()).join(', ')}`);
      }
      if (rebuild.size && !(await fresh())) return;
      // 3. Work orders that are assigned but were never built from their pay sheet.
      for (const list of state.lists.filter((entry) => resourceType(entry) === 'labor' && assignmentWorkResourceRef(entry)?.id && !entry.metadata?.labor_generation)) {
        await generateLaborList(list.id, {});
        done.push(`Built ${cleanText(assignmentWorkResourceRef(list)?.name) || 'a'} work order`);
      }
      if (!(await fresh())) return;
      // 4. Work still open: an unassigned work order goes to whoever covers most of it, then whoever is complete, then the cheapest.
      const openWork = open().filter((row) => row.kind === 'work');
      if (openWork.length) {
        let list = state.lists.find((entry) => resourceType(entry) === 'labor' && !assignmentWorkResourceRef(entry)?.id);
        if (!list && !state.lists.some((entry) => resourceType(entry) === 'labor' && listItems(entry).length)) list = await createResourceList('labor');
        if (list) {
          const wanted = new Set(openWork.map((row) => row.id)), pay = await loadAssigneePay(list.id, true);
          const covers = (row) => (row.work_items || []).filter((entry) => wanted.has(entry.item)).length;
          const best = (pay?.rows || []).filter((row) => row.sheet && covers(row) > 0)
            .sort((a, b) => covers(b) - covers(a) || Number(b.complete) - Number(a.complete) || number(a.total_cents, Infinity) - number(b.total_cents, Infinity))[0];
          if (best) { await assignAndGenerate(list.id, cleanText(best.assignee?.id)); done.push(`Assigned ${cleanText(best.assignee?.name)} and built their work order`); }
          else notes.push('No one with a pay sheet covers the open work. Set up a pay sheet for whoever does it.');
        } else notes.push('Every work order is assigned. The open work needs another work order or a line item for it.');
        if (!(await fresh())) return;
      }
      // 5. Functions still open, such as debris disposal: equipment that provides it, as much as the job needs.
      const openFunctions = open().filter((row) => row.kind === 'function');
      if (openFunctions.length) {
        await ensureEquipmentCatalog();
        for (const row of openFunctions) {
          const pick = equipmentForRequirement(row);
          if (!pick) { notes.push(`Nothing in your equipment provides ${row.label.toLowerCase()}. Mark an equipment type as providing it in the Equipment tab.`); continue; }
          const list = state.lists.find((entry) => resourceType(entry) === 'equipment') || await createResourceList('equipment');
          if (!list || !projectOperationIsCurrent(operation)) continue;
          await persistVersion({ reason: 'supplement', change_tool: 'requirements.fix_all', add_items: [{ id: uid('line'), section: 'equipment', name: pick.name, quantity: pick.quantity, unit: 'day', ...(pick.daily ? { projected_unit_price: pick.daily / 100 } : {}), metadata: { equipment_unit_id: pick.unit_id, equipment_type_id: pick.type_id, provides: pick.provides } }] }, { list });
          done.push(`Added ${pick.quantity > 1 ? `${pick.quantity} × ` : ''}${pick.name} for ${row.label.toLowerCase()}`);
        }
        if (!(await fresh())) return;
      }
    } catch (error) {
      // A rejected line says which field was wrong, so the cause can be fixed rather than guessed.
      const issues = (Array.isArray(error?.data?.issues) ? error.data.issues : []).map((issue) => `${(issue.path || []).join('.')}: ${issue.message}`).join('; ');
      if (projectOperationIsCurrent(operation)) notes.push(`${error?.message || 'Something could not be generated.'}${issues ? ` (${issues})` : ''}`);
    } finally {
      state.resolvingRequirements = false;
      if (projectOperationIsCurrent(operation)) {
        if (!workspaceIsEditing()) syncMaterialsGrid(); else syncRequirementsTray();
        const left = open().length, warnings = (requirementSet()?.data?.requirements || []).filter((row) => row.status === 'warning').length;
        const summary = [done.length ? done.join('. ') + '.' : 'Nothing could be generated for the open requirements.', left ? `${left} still not accounted for.` : '', warnings ? `${warnings} to check by hand.` : '', ...notes].filter(Boolean).join(' ');
        showToast(left ? 'Some requirements are still open' : done.length ? 'Requirements accounted for' : 'Nothing to fix', summary, !left);
      }
    }
  }
  async function markLineCover(listId, itemId, requirement, covers){
    const item = listItems(materialListById(listId)).find((entry) => cleanText(entry.id) === cleanText(itemId));
    if (!item) return;
    const current = (item.metadata?.covers || []).filter((entry) => entry !== requirement);
    await updateItem(item.id, { metadata: { covers: covers ? [...current, requirement] : current } }, listId);
    refreshRequirements();
  }
  function bindRequirements(root){
    if (!root) return;
    bindCompletion();
    root.querySelectorAll('[data-mt-req-open]').forEach((button) => button.onclick = () => {
      // The tray opens and closes in place so the width can animate; nothing else is redrawn.
      state.requirementsOpen = !requirementsOpen();
      try { rootWindow.localStorage?.setItem?.('fm_scope_requirements_open', state.requirementsOpen ? '1' : '0'); } catch (_) {}
      const tray = button.closest('[data-mt-req-tray]');
      tray?.classList.toggle('is-open', state.requirementsOpen);
      button.setAttribute('aria-expanded', String(state.requirementsOpen));
    });
    root.querySelectorAll('[data-mt-req-toggle]').forEach((button) => button.onclick = () => { const id = button.dataset.mtReqToggle; state.expandedRequirementIds = state.expandedRequirementIds || new Set(); if (state.expandedRequirementIds.has(id)) state.expandedRequirementIds.delete(id); else state.expandedRequirementIds.add(id); syncRequirementsTray(); });
    root.querySelectorAll('[data-mt-req-group]').forEach((button) => button.onclick = () => { const key = button.dataset.mtReqGroup; state.collapsedRequirementGroups = state.collapsedRequirementGroups || new Set(); if (state.collapsedRequirementGroups.has(key)) state.collapsedRequirementGroups.delete(key); else state.collapsedRequirementGroups.add(key); syncRequirementsTray(); });
    root.querySelectorAll('[data-mt-req-exclude]').forEach((button) => button.onclick = () => setWorkExcluded(button.dataset.mtListId, button.dataset.mtReqExclude, true));
    root.querySelectorAll('[data-mt-req-include]').forEach((button) => button.onclick = () => setWorkExcluded(button.dataset.mtListId, button.dataset.mtReqInclude, false));
    root.querySelectorAll('[data-mt-req-unmark]').forEach((button) => button.onclick = () => markLineCover(button.dataset.mtListId, button.dataset.mtItemId, button.dataset.mtReqUnmark, false));
    root.querySelectorAll('[data-mt-req-fix]').forEach((button) => button.onclick = () => resolveRequirements());
    root.querySelectorAll('[data-mt-req-add]').forEach((select) => select.onchange = () => { const item = select.value; select.value = ''; if (item) setManualRequirement(item, true); });
    root.querySelectorAll('[data-mt-req-unrequire]').forEach((button) => button.onclick = () => setManualRequirement(button.dataset.mtReqUnrequire, false));
    root.querySelectorAll('[data-mt-req-mark]').forEach((select) => select.onchange = () => { const [listId, itemId] = String(select.value || '').split('|'); if (listId && itemId) markLineCover(listId, itemId, select.dataset.mtReqMark, true); });
  }
  function laborSettings(list){
    const id = cleanText(list?.id);
    const resourceId = cleanText(assignmentWorkResourceRef(list)?.id);
    const resources = workResourcesForScopeList(list);
    const resource = workResourceById(resourceId) || resources.find((entry) => cleanText(entry.id) === resourceId) || null;
    return {
      id, resourceId, resources, resource,
      canRegenerate: list?.metadata?.generated_from_scope === true && !!cleanText(list?.scope_piece_id)
    };
  }

  // ---- Completion. A work order whose work was confirmed as done and finalized to be paid is locked, like an ordered
  // material list. What is finalized is read from the published labor-completion data; paying out a work order and
  // closing out the project are in closeout.js, which uses the shared completion and photo widgets.
  function laborCompletions(){
    const key = `${orgId()}:${projectId()}`, publication = window.PlatformAPI?.publication;
    if (state.laborCompletions?.key === key) return state.laborCompletions.rows;
    if (!publication?.read || !apiReady() || !projectId()) return [];
    const entry = state.laborCompletions = { key, rows: [] };
    entry.promise = Promise.resolve(publication.read(orgId(), { provider: 'labor-completion', export: 'project', target: { scope: 'project', organizationId: orgId(), projectId: projectId() } }))
      .then((result) => { entry.rows = result?.status === 'ready' && Array.isArray(result.value) ? result.value : []; if (state.laborCompletions === entry && entry.rows.some((row) => row.state === 'finalized') && !workspaceIsEditing()) syncMaterialsGrid(); })
      .catch(() => {});
    return entry.rows;
  }
  function laborListFinalized(list){
    return laborCompletions().find((entry) => entry.state === 'finalized' && cleanText(entry.list_id) === cleanText(list?.id)) || null;
  }
  function closeoutHost(){
    return {
      orgId: orgId(), projectId: projectId(), projectTitle: cleanText(state.project?.title || state.project?.address), portal: colorPortalHost(state.panelRoot),
      lists: () => state.lists, listItems: (list) => listItems(list), completions: () => laborCompletions(), toast: (title, body, ok) => showToast(title, body, ok),
      refresh: async () => { state.laborCompletions = null; state.laborCommitments = null; laborCompletions(); await state.laborCompletions?.promise; laborCommitments(); refreshRequirements(); if (!workspaceIsEditing()) syncMaterialsGrid(); syncResourceHeader(); }
    };
  }
  function closeoutModule(){
    return state.closeoutModule ||= import(closeoutUrl).catch((error) => { state.closeoutModule = null; throw error; });
  }
  // The Closeout entry point on the Project tab, beside the header actions, once there is a work order.
  function closeoutButton(){
    if (!state.lists.some((list) => resourceType(list) === 'labor' && listItems(list).length)) return '';
    return `<button type="button" class="mt-closeout" data-mt-closeout data-fm-tooltip="Close out this project: check change orders, signatures, payments, requirements, receipts and expenses, then finalize every work order to be paid" aria-label="Close out project"><i class="fas fa-flag-checkered" aria-hidden="true"></i><span>Closeout</span></button>`;
  }
  // One delegated listener for the work order More buttons and the Closeout button, which are redrawn often.
  function bindCompletion(){
    const host = state.panelRoot;
    if (!host || host.__mtCompletionBound) return;
    host.__mtCompletionBound = true;
    host.addEventListener('click', async (event) => {
      const more = event.target.closest?.('[data-mt-labor-more]'), closeout = event.target.closest?.('[data-mt-closeout]');
      if (!more && !closeout) return;
      event.preventDefault(); event.stopPropagation();
      try { const module = await closeoutModule(); if (more) module.openListMenu(closeoutHost(), more.dataset.mtLaborMore, more); else await module.openCloseout(closeoutHost()); }
      catch (error) { showToast('Could not open this', error?.message || 'Please try again.', false); }
    });
  }

  function renderLaborListControls(list){
    const settings = laborSettings(list);
    const name = cleanText(settings.resource?.name || assignmentWorkResourceRef(list)?.name);
    // The More menu pays the work order out. Once it is paid out, the list is locked and shows that instead of its assignment.
    const done = laborListFinalized(list);
    const more = `<button type="button" class="mt-labor-more" data-mt-labor-more="${escapeHtml(settings.id)}" aria-haspopup="menu" aria-expanded="false" title="More" aria-label="More for this work order"><i class="fas fa-ellipsis-vertical" aria-hidden="true"></i></button>`;
    if (done) return `<span class="mt-paid-pill" title="${escapeHtml(`Completed and to be paid${name ? `: ${name}` : ''}. Finalized ${new Date(done.finalized_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}. A manager can reopen it from More.`)}"><i class="fas fa-lock" aria-hidden="true"></i>${escapeHtml(name ? `${name} · To be paid` : 'To be paid')}</span>${more}`;
    return `<button type="button" class="mt-labor-assign${name ? '' : ' is-empty'}" data-mt-labor-menu="${escapeHtml(settings.id)}" aria-haspopup="dialog" aria-expanded="${state.laborMenu?.listId === settings.id ? 'true' : 'false'}" title="${escapeHtml(name ? `Assigned to ${name}` : 'Assign this work')}"><span>${escapeHtml(name || 'Unassigned')}</span><i class="fas fa-chevron-down" aria-hidden="true"></i></button>${name ? `<div class="mt-list-secondary"><button type="button" data-mt-labor-generate="${escapeHtml(settings.id)}" title="Generate this list from ${escapeHtml(name)}'s pay sheet. Lines added by hand are kept." aria-label="Generate from pay sheet"><i class="fas fa-wand-magic-sparkles"></i></button></div>` : ''}${more}`;
  }

  function renderLaborMenu(list){
    const settings = laborSettings(list);
    const { options, needsWork, pay } = laborAssignmentOptions(list);
    const chip = (attribute, value, label, active, hint = '') => `<button type="button" class="${active ? 'active' : ''}" ${attribute}="${escapeHtml(value)}" aria-pressed="${active}" ${hint ? `title="${escapeHtml(hint)}"` : ''}>${escapeHtml(label)}</button>`;
    const option = (resource) => {
      const id = cleanText(resource?.id);
      const members = Array.isArray(resource?.members) ? resource.members.length : 0;
      const detail = resource ? [workforceLabel(cleanText(resource.resource_kind) || 'resource_group'), members ? `${members} ${members === 1 ? 'member' : 'members'}` : ''].filter(Boolean).join(' · ') : 'No one is assigned';
      const row = resource ? assigneePayFor(settings.id, id) : null;
      const name = resource ? resource.name || resource.label || id : 'Unassigned';
      return `<button type="button" class="mt-labor-option${id === settings.resourceId ? ' active' : ''}" data-mt-labor-assign="${escapeHtml(id)}" role="menuitemradio" aria-checked="${id === settings.resourceId}"><span class="mt-option-main"><span class="mt-assign-top"><strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong>${resource ? `<b class="mt-pay${row?.complete ? '' : ' unknown'}">${escapeHtml(assigneePay(settings.id)?.loading && !row ? '…' : assigneePayLabel(row))}</b>` : ''}</span>${resource ? `<span class="mt-assign-pills">${assigneeKindPill(resource)}${assigneePills(resource, row)}</span>` : `<small>${escapeHtml(detail)}</small>`}</span>${id === settings.resourceId ? '<i class="fas fa-check" aria-hidden="true"></i>' : ''}</button>`;
    };
    return `
      <div class="mt-labor-menu-title">Assigned to</div>
      <div class="mt-labor-options" role="menu">${option(null)}${options.map(({ resource }) => option(resource)).join('')}</div>
      ${options.length ? '' : `<div class="mt-assignment-empty" role="status">${!pay || pay.loading ? 'Finding who can do this work…' : needsWork ? 'No assignees overlap with this job’s work.' : 'No one has a pay sheet yet.'}</div>`}
      ${settings.canRegenerate ? `<button type="button" class="mt-labor-regenerate" data-mt-labor-regenerate><i class="fas fa-arrows-rotate" aria-hidden="true"></i> Regenerate labor from scope</button>` : ''}
    `;
  }

  function laborMenuDismiss(event){
    if (event.type === 'keydown' ? event.key === 'Escape' : !event.target?.closest?.('[data-mt-labor-portal],[data-mt-labor-menu]')) closeLaborMenu();
  }

  function closeLaborMenu(){
    state.laborMenu = null;
    document.querySelectorAll?.('[data-mt-labor-portal]')?.forEach((node) => node.remove());
    document.removeEventListener?.('pointerdown', laborMenuDismiss, true);
    document.removeEventListener?.('keydown', laborMenuDismiss, true);
    materialRoot()?.querySelectorAll?.('[data-mt-labor-menu][aria-expanded="true"]')?.forEach((button) => button.setAttribute('aria-expanded', 'false'));
  }

  // Rebuilds the open popover from current state; called after every write because the grid re-renders under it.
  function syncLaborMenu(){
    const listId = state.laborMenu?.listId;
    if (!listId) return;
    const list = materialListById(listId);
    const trigger = Array.from(materialRoot()?.querySelectorAll?.('[data-mt-labor-menu]') || []).find((button) => button.dataset.mtLaborMenu === listId);
    document.querySelectorAll?.('[data-mt-labor-portal]')?.forEach((node) => node.remove());
    if (!list || !trigger) { closeLaborMenu(); return; }
    const portal = document.createElement('div');
    portal.className = 'mt-labor-portal';
    portal.classList.add('mt-assignment-portal');
    portal.dataset.mtLaborPortal = '';
    portal.setAttribute('role', 'dialog');
    portal.setAttribute('aria-label', 'Assignment');
    portal.innerHTML = renderLaborMenu(list);
    colorPortalHost(state.panelRoot).appendChild(portal);
    const rect = trigger.getBoundingClientRect();
    const below = Math.max(0, window.innerHeight - rect.bottom - 12);
    const above = Math.max(0, rect.top - 12);
    const openBelow = below >= Math.min(400, above);
    portal.style.maxHeight = `${Math.max(80, openBelow ? below : above)}px`;
    const width = portal.offsetWidth || 560;
    const height = portal.offsetHeight;
    portal.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
    portal.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, openBelow ? rect.bottom + 4 : rect.top - height - 4))}px`;
    trigger.setAttribute('aria-expanded', 'true');
    portal.querySelectorAll('[data-mt-labor-assign]').forEach((button) => {
      button.addEventListener('click', () => { if (button.dataset.mtLaborAssign !== laborSettings(materialListById(listId)).resourceId) assignWorkResource(listId, button.dataset.mtLaborAssign); });
    });
    portal.querySelector('[data-mt-labor-regenerate]')?.addEventListener('click', () => { closeLaborMenu(); regenerateLaborListFromScope(listId); });
  }

  function toggleLaborMenu(listId){
    const open = state.laborMenu?.listId === listId;
    closeLaborMenu();
    if (open) return;
    closeListMenu();
    closeColorMenu();
    state.laborMenu = { listId };
    document.addEventListener('pointerdown', laborMenuDismiss, true);
    document.addEventListener('keydown', laborMenuDismiss, true);
    syncLaborMenu();
    loadAssigneePay(listId).then(() => { if (state.laborMenu?.listId === listId) syncLaborMenu(); });
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
    root.querySelectorAll('[data-mt-generate]').forEach(button => button.addEventListener('click', async event => {
      event.stopPropagation(); button.disabled = true;
      try {
        const result = await materialsAPI.calculus.generate(button.dataset.mtGenerate);
        updateMaterialListState(result.material_list);
        renderLeft(); syncMaterialsGrid(); syncTopBar();
        showToast('Materials generated', 'Review the quantities and any missing measurement warnings before ordering.', true);
      } catch(error) { showToast('Could not generate materials', error.message, false); }
      finally { button.disabled = false; }
    }));
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
    root.querySelectorAll('[data-mt-work-order]').forEach((button) => button.addEventListener('click', () => showToast('Work orders are not built yet', 'Generating a work order from this project\'s labor is the next piece of this workflow.', false)));
    root.querySelectorAll('[data-mt-reserve-equipment]').forEach((button) => button.addEventListener('click', () => showToast('Equipment reservations are not built yet', 'Reserving this project\'s equipment is the next piece of this workflow.', false)));
    root.querySelectorAll('[data-mt-order-all]').forEach((button) => {
      button.addEventListener('click', async () => {
        const lists = state.lists.filter((list) => resourceType(list) === 'material' && listItems(list).length);
        const pending = lists.filter((list) => !materialListOrdered(list));
        const chosen = pending.length ? pending : lists;
        if (!chosen.length) return;
        await selectMaterialList(chosen[0].id);
        initializeOrderComposer(chosen[0].id);
        // Every material list that still needs ordering starts selected; the tiles can still leave one out.
        state.orderSelectedListIds = new Set(chosen.map((list) => cleanText(list.id)));
        if (chosen.length > 1) state.orderDraft.title = (globalThis.PlatformLanguage?.text("materials","m_8b217b055a433f","Combined material order") ?? "Combined material order");
        syncOrderDialog(true);
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
    root.querySelectorAll('[data-mt-labor-generate]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); if (!state.saving) generateLaborList(button.dataset.mtLaborGenerate); }));
    root.querySelectorAll('[data-mt-assign-pick]').forEach((button) => button.addEventListener('click', () => assignAndGenerate(button.dataset.mtAssignPick, button.dataset.mtAssignResource)));
    root.querySelectorAll('[data-mt-labor-menu]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleLaborMenu(button.dataset.mtLaborMenu);
      });
    });
    root.querySelectorAll('[data-mt-labor-crew]').forEach((select) => {
      select.addEventListener('click', (event) => event.stopPropagation());
      select.addEventListener('change', (event) => assignWorkResource(select.dataset.mtLaborCrew, event.target.value));
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
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshWorkspace, 20000);
    installTimingProbe();
    const timingStart = performance.now();
    timingMark('mount:start', { active: context.active !== false });
    state.contextGeneration += 1;
    state.saving = false;
    state.creatingList = false;
    const nextProject = projectFromContext(context);
    const previousProjectId = cleanText(state.project?.id || state.context?.projectId || state.context?.entityId);
    const nextProjectId = cleanText(nextProject?.id || context.projectId || context.entityId);
    state.context = context;
    state.host = context.host || context.projectWorkspace || state.host;
    state.project = nextProject;
    if (previousProjectId && nextProjectId && previousProjectId !== nextProjectId) {
      state.scopeDocuments = [];
      state.scopeDocumentsError = '';
      state.lists = [];
      state.resourceTypes = [];
      state.activeListId = '';
      state.activeList = null;
      state.visibleListIds = new Set(); state.collapsedListIds = new Set(); state.expandedItemIds = new Set(); state.minimizedTypes = new Set(); closeLaborMenu();
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
    state.sidebarRoot = context.sidebarRoot || context.roots?.sidebar || state.sidebarRoot;
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
      scopeWorkspace?.setSidebarVisible(leftContentRoot(),true);
      renderLeft();
      if (!state.loading) loadData();
      else render();
    } else {
      scopeWidgetLibrary?.setVisible(false);
      scopeWorkspace?.setSidebarVisible(leftContentRoot(),false);
      const activeTab = state.host?.getActivePreviewTab?.() || state.context?.activeTab || '';
      if (!['proposal', 'materials', 'schedule', 'money'].includes(activeTab)) {
        state.sidebarRoot?.classList?.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
      }
    }
    timingMark('setActive:end', { active: state.active, lists: state.lists.length, items: listItems().length }, timingStart);
  }

  function reset(){
    disposeScopeWidgets();
    state.scopeDocuments = [];
    state.scopeDocumentsError = '';
    scopeWorkspace?.disposeSidebar(leftContentRoot());
    scopeWorkspace?.removeDivider(state.sidebarRoot);
    state.lists = [];
    state.resourceTypes = [];
    state.activeListId = '';
    state.activeList = null;
    state.visibleListIds = new Set(); state.collapsedListIds = new Set(); state.expandedItemIds = new Set(); state.minimizedTypes = new Set(); closeLaborMenu();
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
    clearInterval(refreshTimer);
    if (arrangeFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(arrangeFrame);
    arrangeFrame = 0;
    if (noteVisibilityOutsideBound) document.removeEventListener('click', closeScopeNoteVisibilityOnOutsideClick);
    noteVisibilityOutsideBound = false;
    disposeScopeWidgets();
    state.sidebarRoot?.classList?.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
    reset();
    state.mounted = false;
    state.panelRoot = null;
    state.sidebarRoot = null;
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
    regions: ['main'],
    requiresContext: ['project'],
    dependencies: ['pricebook.bridge'],
    enabled: (context = {}) => context.materialsEnabled !== false,
    panelHtml,
    mount
  });
})();
