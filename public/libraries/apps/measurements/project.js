/* public/libraries/apps/measurements/project.js
 * Embeddable project measurements/report-results pane.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  const Portal = window.Portal;
  const util = Portal?.util || {};
  const cfg = Portal?.cfg || window.__APP || {};
  const $ = util.$ || ((sel, root = document) => root.querySelector(sel));
  const injectCSS = util.injectCSS || (() => {});
  const postAction = util.postAction || (async () => ({ data: { success: false } }));
  const formatDate = util.formatDate || ((value) => String(value || ''));
  const fmUrl = util.fmUrl || ((path) => String(path || ''));
  const fmJson = util.fmJson || null;
  const fmPost = util.fmPost || null;
  const platformJson = util.platformJson || null;
  const currentActor = util.currentActor || (() => ({}));
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match])));
  const showToast = Portal?.ui?.showToast || window.showToast || (() => {});
  const PRICE_RESIDENTIAL = 7;
  const PRICE_COMMERCIAL = 12;
  const PRICE_MULTIFAMILY = 12;
  const GUTTER_REPORT_ADDON = Number(cfg.gutterReportAddon ?? 2) || 2;
  const WEATHER_REPORT_ADDON = Number(cfg.weatherReportAddon ?? 5) || 5;
  const PDF_PREVIEW_QUERY_FLAGS = ['disablePdfPreview', 'mobileDebug', 'noPdfPreview'];
  const TYPE_META = {
    residential: { label: 'Residential', icon: 'fa-house', price: PRICE_RESIDENTIAL },
    commercial: { label: 'Commercial', icon: 'fa-building', price: PRICE_COMMERCIAL },
    multifamily: { label: 'Multifamily', icon: 'fa-city', price: PRICE_MULTIFAMILY },
  };

  function queryFlagEnabled(names){
    try {
      const params = new URLSearchParams(window.location.search || '');
      return names.some((name) => {
        if (!params.has(name)) return false;
        const value = String(params.get(name) || '').trim().toLowerCase();
        return !['0', 'false', 'off', 'no'].includes(value);
      });
    } catch (error) {
      return false;
    }
  }

  const pdfPreviewDisabled = !!cfg.pdfPreviewDisabled || queryFlagEnabled(PDF_PREVIEW_QUERY_FLAGS);

  let cancellationCountdownTimer = null;
  let pendingExpediteSelection = '';
  let activeMeasurementTab = 'standard';
  let activeInstantMountKey = '';
  let reportRequestModalState = null;
  const measurementAssetCache = new Map();
  const measurementAssetLoads = new Set();
  const measurementSummaryMetricCache = new Map();
  const measurementSummaryMetricLoads = new Set();
  let weatherReportPollTimer = null;
  let weatherReportPollAttempt = 0;

  const state = {
    mounted: false,
    active: false,
    host: null,
    model: null,
    panelRoot: null
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
    defineHostAccessor('reportOrderState', () => callHost('getReportOrderState') || state.model?.state?.reportOrderState || null, (value) => {
      if (state.model?.state) state.model.state.reportOrderState = value || null;
      callHost('setReportOrderState', value || null);
    });
    defineHostAccessor('selectedType', () => callHost('getSelectedType') || 'residential', (value) => callHost('setSelectedType', value));
    defineHostAccessor('activePreviewTab', () => callHost('getActivePreviewTab') || 'map', (value) => callHost('setActivePreviewTab', value));
    defineHostAccessor('reportExpediteOptions', () => callHost('getReportExpediteOptions') || [], (value) => callHost('setReportExpediteOptions', value));
    defineHostAccessor('reorderMeasurementProjectId', () => callHost('getReorderMeasurementProjectId') || '', (value) => callHost('setReorderMeasurementProjectId', value));
    defineHostAccessor('reorderSourceCanReopenInPlace', () => !!callHost('getReorderSourceCanReopenInPlace'), (value) => callHost('setReorderSourceCanReopenInPlace', !!value));
    defineHostAccessor('reportSelection', () => callHost('getReportSelection') || null, (value) => callHost('setReportSelection', value));
    defineHostAccessor('includeGutterMeasurements', () => !!callHost('getIncludeGutterMeasurements'), (value) => callHost('setIncludeGutterMeasurements', !!value));
    defineHostAccessor('includeWeatherReport', () => !!callHost('getIncludeWeatherReport'), (value) => callHost('setIncludeWeatherReport', !!value));
    defineHostAccessor('includeInstantPreview', () => !!callHost('getIncludeInstantPreview'), (value) => callHost('setIncludeInstantPreview', !!value));
    defineHostAccessor('selectedReportExpedite', () => callHost('getSelectedReportExpedite') || null, (value) => callHost('setSelectedReportExpedite', value));
  }

  function panelHtml(){
    return `
      <div class="r-measure-tabs" id="rMeasureTabs"></div>
      <div class="r-measure-body">
        <div class="r-measure-pane" data-measure-pane="map"><div id="rMeasurementMap" style="height:100%"></div></div>
        <div class="r-measure-pane" data-measure-pane="summary"><div id="rMeasurementSummary" style="height:100%"></div></div>
        <div class="r-measure-pane" data-measure-pane="instant"><div id="rMeasurementInstant" style="height:100%"></div></div>
        <div class="r-measure-pane" data-measure-pane="standard"><div id="rMeasurementStandard" style="height:100%"></div></div>
        <div class="r-measure-pane" data-measure-pane="customer"><div id="rMeasurementCustomer" style="height:100%"></div></div>
        <div class="r-measure-pane" data-measure-pane="xml"><div id="rMeasurementXml" style="height:100%"></div></div>
        <div class="r-measure-pane" data-measure-pane="weather"><div id="rMeasurementWeather" style="height:100%"></div></div>
      </div>
    `;
  }

  function resolveRoot(context = {}){
    const root = context.panelRoot || context.roots?.main || state.panelRoot || document.querySelector('#rOverlay .r-preview-panel[data-panel="measurements"]');
    if (!root) return null;
    if (!root.querySelector?.('#rMeasureTabs')) root.innerHTML = panelHtml();
    return root;
  }

  function currentPanelRoot(){
    if (state.panelRoot?.isConnected) return state.panelRoot;
    state.panelRoot = document.querySelector('#rOverlay .r-preview-panel[data-panel="measurements"]');
    return state.panelRoot || null;
  }

  function measureBody(){
    return currentPanelRoot()?.querySelector?.('.r-measure-body') || null;
  }

  function cssEscape(value){
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function selectedReportMode(){ return callHost('selectedReportMode') || 'full'; }
  function reportModeLabel(){ return callHost('reportModeLabel') || 'Standard'; }
  function reportExpediteOption(...args){ return callHost('reportExpediteOption', ...args) || null; }
  function defaultReportExpediteOption(...args){ return callHost('defaultReportExpediteOption', ...args) || reportExpediteOption('standard_3_6') || null; }
  function normalizeReportExpediteKey(value){ return callHost('normalizeReportExpediteKey', value) || String(value || '').trim(); }
  function reportExpediteOptionsEnabled(){ return !!callHost('reportExpediteOptionsEnabled'); }
  function reportExpeditePricingReady(){
    const hosted = callHost('reportExpeditePricingReady');
    if (hosted === true || hosted === false) return hosted;
    return reportExpediteOptions.length > 0 && reportExpediteOptions.every((option) => option?._pricingAuthoritative === true);
  }
  function reportExpeditePricingLoading(){
    return callHost('reportExpeditePricingLoading') === true;
  }
  function reportOrderingClosed(){ return !!callHost('reportOrderingClosed'); }
  function reportCancellationsEnabled(){ return callHost('reportCancellationsEnabled') !== false; }
  function reportFollowupEnabled(){ return !!callHost('reportFollowupEnabled'); }
  function weatherReportsEnabled(){ return !!callHost('weatherReportsEnabled'); }
  function instantReportsEnabled(){ return !!callHost('instantReportsEnabled'); }
  function inlineProjectMapWithReports(){ return !!callHost('inlineProjectMapWithReports'); }
  function firstMeasureFlagEnabled(flag, fallback = false){
    const appFlags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (appFlags?.current?.()) {
      if (appFlags.has?.('firstmeasure', flag)) return true;
      const value = appFlags.value?.('firstmeasure', flag, undefined);
      return value === undefined ? fallback : value !== false;
    }
    return fallback;
  }
  function measurementReportSummaryEnabled(){
    return firstMeasureFlagEnabled('measurement_report_summary', false);
  }
  function fmtMoney(value){ return callHost('fmtMoney', value) || String(Math.round((Number(value) || 0) * 100) / 100); }
  function addMinutes(date, minutes){ return new Date(date.getTime() + (Number(minutes) || 0) * 60000); }
  function isPerStructureType(type){ return !!callHost('isPerStructureType', type); }
  function pinCount(){ return Number(callHost('pinCount') || 0); }
  function freeExpediteUses(){ return Number(callHost('freeExpediteUses') || 0); }
  function reportExpediteCouponDiscount(...args){ return Number(callHost('reportExpediteCouponDiscount', ...args) || 0); }
  function reportExpeditePriceHtml(...args){ return callHost('reportExpeditePriceHtml', ...args) || ''; }
  function reportExpediteDeltaLabel(option, type = selectedType){
    const hosted = callHost('reportExpediteDeltaLabel', option, type);
    if (hosted) return hosted;
    const base = TYPE_META[type]?.price ?? PRICE_RESIDENTIAL;
    const unit = Number(option?.unit_price ?? reportExpediteUnitPrice(option, type || 'residential'));
    const delta = Math.max(0, Math.round((unit - base) * 100) / 100);
    return delta > 0 ? `+$${fmtMoney(delta)}` : '+$0';
  }
  function formatTurnaroundTime(date){
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  function reportCustomerPromiseLabelFromDate(date){
    return date && !Number.isNaN(date.getTime()) ? `By ${formatTurnaroundTime(date)}` : '';
  }
  function reportCustomerPromiseLabelFromWindow(windowLabel){
    const text = String(windowLabel || '').trim();
    if (!text) return '';
    const parts = text.split(/\s+-\s+/);
    return parts.length > 1 && parts[parts.length - 1] ? `By ${parts[parts.length - 1]}` : text;
  }
  function localReportExpediteWindowLabel(option, now = new Date()){
    if (!option) return '';
    const dueStart = option.due_window_start ? new Date(option.due_window_start) : null;
    const dueEnd = option.due_window_end ? new Date(option.due_window_end) : null;
    if (dueStart && dueEnd && !Number.isNaN(dueStart.getTime()) && !Number.isNaN(dueEnd.getTime())) {
      return `${formatTurnaroundTime(dueStart)} - ${formatTurnaroundTime(dueEnd)}`;
    }
    if (option.window_label) return option.window_label;
    return `${formatTurnaroundTime(addMinutes(now, option.startMinutes))} - ${formatTurnaroundTime(addMinutes(now, option.endMinutes))}`;
  }
  function reportExpediteCustomerPromiseLabel(option, now = new Date()){
    const hosted = callHost('reportExpediteCustomerPromiseLabel', option, now);
    if (hosted) return hosted;
    if (!option) return '';
    const dueEnd = option.due_window_end ? new Date(option.due_window_end) : null;
    if (dueEnd && !Number.isNaN(dueEnd.getTime())) return reportCustomerPromiseLabelFromDate(dueEnd);
    const endMinutes = Number(option.endMinutes ?? option.end_minutes);
    if (Number.isFinite(endMinutes)) return reportCustomerPromiseLabelFromDate(addMinutes(now, endMinutes));
    return reportCustomerPromiseLabelFromWindow(option.window_label || '');
  }
  function reportExpediteWindowLabel(option, now = new Date()){
    return callHost('reportExpediteWindowLabel', option, now) || localReportExpediteWindowLabel(option, now);
  }
  function reportExpediteDurationLabel(option){
    const end = Number(option?.endMinutes);
    if (!Number.isFinite(end)) return option?.label || '';
    const formatHours = (minutes) => {
      const hours = Math.ceil(Math.max(1, Number(minutes) || 0) / 90) * 1.5;
      return Number.isInteger(hours) ? String(hours) : String(hours).replace(/0+$/, '').replace(/\.$/, '');
    };
    const hours = formatHours(end);
    return `Less than ${hours} hour${hours === '1' ? '' : 's'}`;
  }
  function reportExpediteNetTotalPrice(...args){ return Number(callHost('reportExpediteNetTotalPrice', ...args) || 0); }
  function reportExpediteTotalPrice(...args){ return Number(callHost('reportExpediteTotalPrice', ...args) || 0); }
  function reportExpediteUnitPrice(...args){ return Number(callHost('reportExpediteUnitPrice', ...args) || 0); }
  function buildLocalReportExpediteOptions(...args){ return callHost('buildLocalReportExpediteOptions', ...args) || []; }
  function loadReportExpediteOptions(...args){ return callHost('loadReportExpediteOptions', ...args); }
  function hasReportOrdered(){
    const hosted = callHost('hasReportOrdered');
    if (hosted === true) return true;
    if (reorderMeasurementProjectId) return false;
    if (reportOrderState?.ordered || activeBaseProject?.workflow_state === 'measurement_ordered') return true;
    const measurement = reportOrderMeasurement();
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    if (activeMeasurementProjectId()) return true;
    return [
      activeBaseProject?.has_report,
      activeBaseProject?.report_url,
      activeBaseProject?.pdf_url,
      activeBaseProject?.summary_url,
      activeBaseProject?.xml_url,
      measurement.id,
      measurement.project_id,
      measurement.folder,
      raw.id,
      raw.project_id,
      raw.folder,
      manifest.project_id,
      manifest.folder
    ].some((value) => !!String(value ?? '').trim());
  }
  function shouldAutoOpenInstantFromMode(...args){ return !!callHost('shouldAutoOpenInstantFromMode', ...args); }
  function setProjectionMode(...args){ return callHost('setProjectionMode', ...args); }
  function renderRoofChoice(){ return callHost('renderRoofChoice'); }
  function finiteCoord(value){
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  async function ensureCreditsForPurchase(...args){ return callHost('ensureCreditsForPurchase', ...args) !== false; }
  function openCreditTopupForPurchase(...args){ return callHost('openCreditTopupForPurchase', ...args); }
  function creditErrorDetails(error){ return callHost('creditErrorDetails', error) || { isCreditError: false }; }
  function syncProjectViewerTabs(){ return callHost('syncProjectViewerTabs'); }
  function renderWorkflowState(){ return callHost('renderWorkflowState'); }
  function renderProjectViewerSummary(){ return callHost('renderProjectViewerSummary'); }
  function persistActiveBaseProject(){ return callHost('persistProject'); }
  function close(){ return callHost('closeProjectWorkspace'); }
  function open(...args){ return callHost('openProjectWorkspace', ...args); }
  function setActivePreviewTab(...args){ return callHost('setActivePreviewTab', ...args); }
  function projectDefaultPreviewTab(){ return callHost('projectDefaultPreviewTab') || 'map'; }
  function projectOrgId(){ return callHost('projectOrgId') || ''; }
  function getMarkersData(){ return callHost('getMarkersData') || []; }
  function normalizeProjectPins(...args){ return callHost('normalizeProjectPins', ...args) || []; }
  function buildPinIcon(...args){ return callHost('buildPinIcon', ...args) || ''; }
  function focusMapOnProject(...args){ return callHost('focusMapOnProject', ...args); }
  function renderPinInfo(){ return callHost('renderPinInfo'); }
  function renderConfirm(){ return callHost('renderConfirm'); }
  function renderAfterHoursNotice(){ return callHost('renderAfterHoursNotice'); }
  function syncReportExpediteMinuteRefresh(){ return callHost('syncReportExpediteMinuteRefresh'); }
  function stopReportExpediteMinuteRefresh(){ return callHost('stopReportExpediteMinuteRefresh'); }
  function currentPrice(){ return Number(callHost('currentPrice') || 0); }
  function currentPriceQuote(){ return callHost('currentPriceQuote') || { final_amount: currentPrice() }; }
  function reportBaseUnitPrice(...args){ return Number(callHost('reportBaseUnitPrice', ...args) || 0); }
  function activeSubmitButton(){ return callHost('activeSubmitButton') || null; }
  function setSubmitBusyLabel(...args){ return callHost('setSubmitBusyLabel', ...args); }
  function updateSubmitLabel(){ return callHost('updateSubmitLabel'); }
  function queueAutosaveNotice(){ return callHost('autosaveSoon'); }

  function measurementTabs(){
    const tabs = [];
    const cancelled = reportOrderIsCancelled();
    const rejected = reportOrderIsRejected();
    const pending = reportOrderIsActivelyPending();
    const ready = !cancelled && !rejected && !reportOrderReleaseHoldIsActive() && (!!reportOrderState?.hasReadyReport || reportOrderIsCompleteLike());
    const projectId = activeMeasurementProjectId();
    const cachedAssets = projectId ? primeMeasurementAssetCacheFromKnownUrls(projectId) : null;
    const hasXml = ready && !!cachedAssets?.xmlUrl;
    const changes = reportFollowupEnabled() ? reportChangeRequests() : [];
    const supportView = !changes.length || reportRequestsAreSupportOnly(changes);
    if (inlineProjectMapWithReports()) {
      tabs.push({
        id: 'map',
        label: 'Map',
        icon: 'fa-map-location-dot',
        active: activeMeasurementTab === 'map',
        disabled: false,
        pending: false
      });
    }
    if (measurementReportSummaryEnabled()) {
      tabs.push({
        id: 'summary',
        label: 'Summary',
        icon: 'fa-clipboard-list',
        active: activeMeasurementTab === 'summary',
        disabled: false,
        pending
      });
    }
    if (reportOrderState?.includeInspection) {
      tabs.push({
        id: 'instant',
        label: 'Instant',
        icon: 'fa-bolt',
        active: activeMeasurementTab === 'instant',
        pending
      });
    }
    tabs.push({
      id: 'standard',
      label: 'Standard',
      icon: cancelled ? 'fa-ban' : (rejected ? 'fa-circle-exclamation' : (pending ? 'fa-circle-notch fa-spin' : 'fa-file-pdf')),
      active: activeMeasurementTab === 'standard',
      disabled: false,
      pending
    });
    tabs.push({
      id: 'customer',
      label: 'Customer',
      icon: cancelled ? 'fa-ban' : (rejected ? 'fa-circle-exclamation' : (pending ? 'fa-circle-notch fa-spin' : 'fa-file-lines')),
      active: activeMeasurementTab === 'customer',
      disabled: cancelled || rejected,
      pending
    });
    if (hasXml) {
      tabs.push({
        id: 'xml',
        label: 'XML',
        icon: 'fa-code',
        active: activeMeasurementTab === 'xml',
        disabled: cancelled || rejected || !ready,
        pending: false
      });
    }
    if (weatherReportsEnabled()) {
      const weather = weatherReportInfo();
      tabs.push({
        id: 'weather',
        label: 'Weather',
        icon: 'fa-cloud-bolt',
        active: activeMeasurementTab === 'weather',
        disabled: cancelled || rejected,
        pending: weather.ordered && !weather.url
      });
    }
    if (reportFollowupEnabled()) {
      tabs.push({
        id: 'changes',
        label: supportView ? 'Support' : 'Changes Pending',
        icon: supportView ? 'fa-headset' : 'fa-list-check',
        active: activeMeasurementTab === 'changes',
        disabled: false,
        pending: changes.some((request) => String(request.status || '').toLowerCase() === 'pending_review')
      });
    }
    return tabs;
  }

  function isPlatformProjectId(value){
    return /^(project|base|__optimistic)_/i.test(String(value || '').trim());
  }

  function isFirstMeasureCompleteStatus(...values){
    return values
      .map((value) => String(value ?? '').trim().toLowerCase())
      .some((status) => status === 'completed' || status === 'complete');
  }

  function isFirstMeasureReturnedReportStatus(...values){
    return values
      .map((value) => String(value ?? '').trim().toLowerCase())
      .some((status) => status === 'completed' || status === 'complete' || status === 'rework_requested' || status === 'reworking' || status === 'customer_rework_requested');
  }

  function isCancelledStatus(...values){
    return values
      .map((value) => String(value ?? '').trim().toLowerCase())
      .some((status) => status === 'cancelled' || status === 'canceled');
  }

  function isRejectedStatus(...values){
    return values
      .map((value) => String(value ?? '').trim().toLowerCase())
      .some((status) => status === 'rejected' || status === 'rejected_no_coverage');
  }

  function reportOrderStatus(){
    const measurement = reportOrderMeasurement();
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    return String(reportOrderState?.status || measurement.status || raw.status || manifest.status || '').trim().toLowerCase();
  }

  function reportOrderIsCancelled(){
    const measurement = reportOrderMeasurement();
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    return isCancelledStatus(
      reportOrderState?.status,
      measurement.status,
      raw.status,
      manifest.status
    );
  }

  function reportOrderIsRejected(){
    const measurement = reportOrderMeasurement();
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    return isRejectedStatus(
      reportOrderState?.status,
      measurement.status,
      raw.status,
      manifest.status
    );
  }

  function reportOrderKnownAssetUrls(){
    const releaseHeld = reportOrderReleaseHoldIsActive();
    const terminalWithoutReport = releaseHeld || reportOrderIsRejected() || reportOrderIsCancelled();
    const measurement = reportOrderMeasurement();
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    const data = reportOrderState?.data && typeof reportOrderState.data === 'object' ? reportOrderState.data : {};
    const dataProject = data.project && typeof data.project === 'object' ? data.project : {};
    const dataManifest = data.manifest && typeof data.manifest === 'object' ? data.manifest : {};
    return {
      reportUrl: terminalWithoutReport ? '' : String(
        reportOrderState?.reportUrl
        || measurement.report_url
        || measurement.pdf_url
        || raw.report_url
        || raw.pdf_url
        || manifest.report_url
        || manifest.pdf_url
        || activeBaseProject?.report_url
        || activeBaseProject?.pdf_url
        || dataProject.report_url
        || dataProject.pdf_url
        || dataManifest.report_url
        || dataManifest.pdf_url
        || ''
      ).trim(),
      summaryUrl: terminalWithoutReport ? '' : String(
        reportOrderState?.summaryUrl
        || measurement.summary_url
        || raw.summary_url
        || manifest.summary_url
        || activeBaseProject?.summary_url
        || dataProject.summary_url
        || dataManifest.summary_url
        || ''
      ).trim(),
      xmlUrl: terminalWithoutReport ? '' : String(
        reportOrderState?.xmlUrl
        || measurement.xml_url
        || raw.xml_url
        || manifest.xml_url
        || activeBaseProject?.xml_url
        || dataProject.xml_url
        || dataManifest.xml_url
        || ''
      ).trim(),
      instantPdfUrl: String(
        reportOrderState?.instantPdfUrl
        || measurement.instant_pdf_url
        || raw.instant_pdf_url
        || raw.instant_url
        || manifest.instant_pdf_url
        || activeBaseProject?.instant_pdf_url
        || activeBaseProject?.instant_url
        || dataProject.instant_pdf_url
        || dataProject.instant_url
        || dataManifest.instant_pdf_url
        || ''
      ).trim()
    };
  }

  function primeMeasurementAssetCacheFromKnownUrls(projectId = activeMeasurementProjectId()){
    if (!projectId) return null;
    const releaseHeld = reportOrderReleaseHoldIsActive();
    const terminalWithoutReport = releaseHeld || reportOrderIsRejected() || reportOrderIsCancelled();
    const known = reportOrderKnownAssetUrls();
    const cached = measurementAssetCache.get(projectId) || {};
    const next = {
      ...cached,
      reportUrl: terminalWithoutReport ? '' : (cached.reportUrl || known.reportUrl || ''),
      summaryUrl: terminalWithoutReport ? '' : (cached.summaryUrl || known.summaryUrl || ''),
      xmlUrl: terminalWithoutReport ? '' : (cached.xmlUrl || known.xmlUrl || ''),
      instantPdfUrl: cached.instantPdfUrl || known.instantPdfUrl || '',
      hasCheckedArtifacts: !!cached.hasCheckedArtifacts,
    };
    if (terminalWithoutReport) {
      measurementAssetCache.set(projectId, next);
      return next;
    }
    if (next.reportUrl || next.summaryUrl || next.xmlUrl || next.instantPdfUrl) {
      measurementAssetCache.set(projectId, next);
      return next;
    }
    return cached || null;
  }

  function reportOrderHasReadyAssets(){
    if (reportOrderReleaseHoldIsActive()) return false;
    if (reportOrderIsRejected() || reportOrderIsCancelled()) return false;
    const projectId = activeMeasurementProjectId();
    const cachedAssets = projectId ? primeMeasurementAssetCacheFromKnownUrls(projectId) : null;
    if (cachedAssets?.reportUrl || cachedAssets?.summaryUrl) return true;
    const measurement = reportOrderMeasurement();
    const reportMode = String(reportOrderState?.data?.report_mode || measurement.report_mode || activeBaseProject?.report_mode || '').trim().toLowerCase();
    const instantOrdered = !!(
      reportOrderState?.includeInspection
      || measurement.include_instant
      || measurement.instant_only
      || reportMode === 'instant'
      || reportMode === 'both'
    );
    return !!(instantOrdered && cachedAssets?.instantPdfUrl);
  }

  function reportOrderIsCompleteLike(){
    if (reportOrderReleaseHoldIsActive()) return false;
    if (reportOrderIsRejected() || reportOrderIsCancelled()) return false;
    const measurement = reportOrderMeasurement();
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    if (reportOrderState?.hasReadyReport) return true;
    if (isFirstMeasureCompleteStatus(reportOrderState?.status, measurement.status, raw.status, manifest.status)) return true;
    if (!reportOrderHasReadyAssets()) return false;
    return !!reportOrderState?.hasReadyReport
      || isFirstMeasureCompleteStatus(
        reportOrderState?.status,
        measurement.status
      )
      || (reportOrderStatus() === 'ready' && reportOrderHasReadyAssets());
  }

  function reportOrderIsActivelyPending(){
    if (!hasReportOrdered()) return false;
    if (reportOrderIsCancelled() || reportOrderIsRejected()) return false;
    if (reportOrderIsCompleteLike()) return false;
    const status = reportOrderStatus();
    if (status === 'submitted') return !reportOrderIsStaleSubmitted();
    if (['completed', 'complete', 'ready'].includes(status)) return !reportOrderIsCompleteLike();
    if ([
      'queued',
      'processing',
      'in_progress',
      'awaiting_review',
      'awaiting_manager_review',
      'pending_rejection',
      'measurement_ordered'
    ].includes(status)) return true;
    return !status;
  }

  function reportOrderPendingStage(){
    if (reportOrderReleaseHoldIsActive()) return 'processing';
    const status = reportOrderStatus();
    if (['submitted', 'queued', 'ready', 'measurement_ordered'].includes(status)) return 'processing';
    if (['awaiting_review', 'awaiting_manager_review', 'pending_rejection'].includes(status)) return 'review';
    if (['processing', 'in_progress'].includes(status)) return 'processing';
    return 'pending';
  }

  function firstMeasurementId(...values){
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text && !isPlatformProjectId(text)) return text;
    }
    return '';
  }
  function measurementIdFromAssetUrl(...values){
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (!text) continue;
      const match = text.match(/\/projects\/([^/?#]+)/i);
      const id = match ? firstMeasurementId(decodeURIComponent(match[1] || '')) : '';
      if (id) return id;
    }
    return '';
  }

  function activeMeasurementProjectId(){
    const measurement = activeBaseProject?.measurement_project || activeBaseProject?.measurement || {};
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    return firstMeasurementId(
      measurement.id,
      measurement.project_id,
      measurement.folder,
      measurement.measurement_project_id,
      raw.folder,
      raw.id,
      raw.project_id,
      reportOrderState?.data?.folder,
      reportOrderState?.data?.project?.id,
      reportOrderState?.data?.project?.project_id,
      measurementIdFromAssetUrl(
        activeBaseProject?.report_url,
        activeBaseProject?.pdf_url,
        activeBaseProject?.summary_url,
        activeBaseProject?.xml_url,
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

  function contextMeasurementProjectId(context = {}){
    const project = context.project || context.activeProject || context.entity || {};
    const measurement = project?.measurement_project || project?.measurement || {};
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    return firstMeasurementId(
      measurement.id,
      measurement.project_id,
      measurement.folder,
      measurement.measurement_project_id,
      raw.folder,
      raw.id,
      raw.project_id,
      context.reportOrderState?.data?.folder,
      context.reportOrderState?.data?.project?.id,
      context.reportOrderState?.data?.project?.project_id,
      project.measurement_project_id,
      project.folder,
      measurementIdFromAssetUrl(
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
        context.reportOrderState?.reportUrl,
        context.reportOrderState?.summaryUrl,
        context.reportOrderState?.xmlUrl
      )
    );
  }

  function measurementsVisible(context = {}){
    if (context.hasReportOrdered || context.reorderMeasurementProjectId) return true;
    const project = context.project || context.activeProject || context.entity || {};
    const state = context.reportOrderState || {};
    if (state.ordered && (state.hasReadyReport || state.reportUrl || state.summaryUrl || state.xmlUrl)) return true;
    if (project.has_report || project.report_url || project.pdf_url || project.summary_url || project.xml_url) return true;
    return !!contextMeasurementProjectId(context);
  }

  function parseReportDate(value){
    const text = String(value || '').trim();
    if (!text) return null;
    const hasExplicitZone = /[zZ]|[+-]\d\d:?\d\d$/.test(text);
    const isoish = text.includes('T') ? text : text.replace(' ', 'T');
    if (hasExplicitZone) {
      const direct = Date.parse(isoish);
      if (Number.isFinite(direct)) return new Date(direct);
    }
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text)) {
      const utc = Date.parse(`${isoish}Z`);
      if (Number.isFinite(utc)) return new Date(utc);
    }
    const direct = Date.parse(text);
    if (Number.isFinite(direct)) return new Date(direct);
    const zoned = Date.parse(`${isoish}Z`);
    return Number.isFinite(zoned) ? new Date(zoned) : null;
  }

  const SUBMITTED_REPORT_STALE_MS = 2 * 60 * 1000;
  function reportOrderSubmittedAt(){
    const measurement = reportOrderMeasurement();
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    const timestamps = manifest.timestamps && typeof manifest.timestamps === 'object' ? manifest.timestamps : {};
    return parseReportDate(
      reportOrderState?.submittedAt
      || measurement.submitted_at
      || measurement.queued_at
      || measurement.created_at
      || manifest.submitted_at
      || manifest.queued_at
      || manifest.created_at
      || timestamps.submitted_at
      || timestamps.queued_at
      || timestamps.created_at
      || activeBaseProject?.created_at
      || activeBaseProject?.updated_at
    );
  }

  function reportOrderIsStaleSubmitted(){
    if (reportOrderStatus() !== 'submitted') return false;
    const submittedAt = reportOrderSubmittedAt();
    if (!submittedAt) return true;
    return Date.now() - submittedAt.getTime() > SUBMITTED_REPORT_STALE_MS;
  }

  function reportReleaseHoldIsActive(manifest){
    if (!manifest || typeof manifest !== 'object') return false;
    const raw = manifest.raw && typeof manifest.raw === 'object' ? manifest.raw : {};
    manifest = manifest.manifest && typeof manifest.manifest === 'object'
      ? manifest.manifest
      : (raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : manifest);
    const delivery = manifest.delivery && typeof manifest.delivery === 'object' ? manifest.delivery : {};
    const hold = manifest.delivery_release_hold && typeof manifest.delivery_release_hold === 'object'
      ? manifest.delivery_release_hold
      : (delivery.release_hold && typeof delivery.release_hold === 'object' ? delivery.release_hold : {});
    const status = String(manifest.delivery_hold_status || hold.status || '').trim().toLowerCase();
    if (status !== 'holding') return false;
    const scheduled = parseReportDate(manifest.delivery_hold_scheduled_release_at || hold.scheduled_release_at || '');
    return !!scheduled && scheduled.getTime() > Date.now();
  }

  function reportOrderReleaseHoldIsActive(){
    const measurement = reportOrderMeasurement();
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    return reportReleaseHoldIsActive(manifest)
      || reportReleaseHoldIsActive(raw)
      || reportReleaseHoldIsActive(measurement)
      || reportReleaseHoldIsActive(activeBaseProject || {});
  }

  function reportOrderMeasurement(){
    return activeBaseProject?.measurement_project || activeBaseProject?.measurement || {};
  }

  function truthyOrderFlag(value){
    if (value === true || value === 1 || value === '1') return true;
    const text = String(value ?? '').trim().toLowerCase();
    return text === 'true' || text === 'yes' || text === 'on';
  }

  function reportOrderManifest(){
    const measurement = reportOrderMeasurement();
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    if (raw.manifest && typeof raw.manifest === 'object') return raw.manifest;
    return activeBaseProject?.manifest && typeof activeBaseProject.manifest === 'object' ? activeBaseProject.manifest : {};
  }

  function reportOrderBillingProjectType(){
    return normalizeOrderProjectType(selectedType || activeBaseProject?.project_type || reportOrderManifest().project_type) || 'residential';
  }

  function reportOrderBillingPinCount(){
    const normalizedPins = normalizeProjectPins(activeBaseProject || {});
    if (normalizedPins.length) return normalizedPins.length;
    const manifestPins = reportOrderManifest().pins;
    if (Array.isArray(manifestPins) && manifestPins.length) return manifestPins.length;
    return Math.max(1, pinCount() || 1);
  }

  function reportOrderIncludesInstant(){
    const measurement = reportOrderMeasurement();
    const manifest = reportOrderManifest();
    const mode = String(
      reportOrderState?.payload?.report_mode
      || reportOrderState?.data?.report_mode
      || measurement.report_mode
      || manifest.report_mode
      || activeBaseProject?.report_mode
      || ''
    ).trim().toLowerCase();
    return !!(reportOrderState?.includeInspection || measurement.include_instant || manifest.instant_enabled || mode === 'instant' || mode === 'both');
  }

  function reportOrderIncludesGutters(){
    const measurement = reportOrderMeasurement();
    const manifest = reportOrderManifest();
    return truthyOrderFlag(
      reportOrderState?.includeGutters
      ?? activeBaseProject?.include_gutter_measurements
      ?? measurement.include_gutters
      ?? measurement.include_gutter_measurements
      ?? manifest.include_gutter_measurements
      ?? false
    );
  }

  function reportOrderIncludesWeather(){
    const measurement = reportOrderMeasurement();
    const manifest = reportOrderManifest();
    return truthyOrderFlag(
      reportOrderState?.includeWeather
      ?? measurement.include_weather_report
      ?? manifest.include_weather_report
      ?? activeBaseProject?.include_weather_report
      ?? false
    );
  }

  function reportOrderExpediteUpgradeBaseline(){
    const type = reportOrderBillingProjectType();
    const count = reportOrderBillingPinCount();
    const currentOption = reportExpediteOption(reportOrderExpediteKey()) || defaultReportExpediteOption();
    const reportUnit = Number(currentOption?.unit_price ?? reportExpediteUnitPrice(currentOption, type)) || TYPE_META[type]?.price || PRICE_RESIDENTIAL;
    const instant = reportOrderIncludesInstant() ? (isPerStructureType(type) ? 4 : 2) : 0;
    const unit = reportUnit + instant;
    const report = isPerStructureType(type) ? unit * count : unit;
    return Math.round(report * 100) / 100;
  }

  function reportOrderAmountCharged(){
    const measurement = reportOrderMeasurement();
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = reportOrderManifest();
    const candidates = [
      reportOrderState?.amountCharged,
      reportOrderState?.amount_charged,
      measurement.amount_charged,
      activeBaseProject?.amount_charged,
      manifest.amount_charged,
      raw.amount_charged,
      activeBaseProject?.measurement_project?.amount_charged,
      activeBaseProject?.measurement?.amount_charged
    ];
    for (const value of candidates) {
      const amount = Number(value);
      if (Number.isFinite(amount) && amount > 0) return amount;
    }
    return 0;
  }

  function reportOrderCreditedAmountForExpediteUpgrade(){
    const currentCharged = reportOrderAmountCharged();
    const baseline = reportOrderExpediteUpgradeBaseline();
    if (currentCharged > 0 && baseline > 0) return Math.min(currentCharged, baseline);
    if (baseline > 0 && hasReportOrdered() && !reportOrderIsExpedited()) return baseline;
    return currentCharged;
  }

  function reportOrderExpediteUpgradeTotal(option){
    const type = reportOrderBillingProjectType();
    const count = reportOrderBillingPinCount();
    const reportUnit = Number(option?.unit_price ?? reportExpediteUnitPrice(option, type)) || TYPE_META[type]?.price || PRICE_RESIDENTIAL;
    const instant = reportOrderIncludesInstant() ? (isPerStructureType(type) ? 4 : 2) : 0;
    const unit = reportUnit + instant;
    const report = isPerStructureType(type) ? unit * count : unit;
    const gutters = type === 'residential' && reportOrderIncludesGutters() ? GUTTER_REPORT_ADDON : 0;
    const weather = reportOrderIncludesWeather() ? WEATHER_REPORT_ADDON * count : 0;
    const gross = Math.round((report + gutters + weather) * 100) / 100;
    const discount = reportExpediteCouponDiscount(option, type);
    return Math.round(Math.max(0.01, gross - discount) * 100) / 100;
  }

  function reportOrderExpediteUpgradeDelta(option){
    return Math.max(0, Math.round((reportOrderExpediteUpgradeTotal(option) - reportOrderCreditedAmountForExpediteUpgrade()) * 100) / 100);
  }

  function reportOrderExpediteKey(){
    return normalizeReportExpediteKey(reportOrderState?.reportExpediteOption || reportOrderMeasurement().report_expedite_option || 'standard_3_6');
  }

  function reportOrderIsExpedited(){
    const key = reportOrderExpediteKey();
    return !!(reportOrderState?.isExpedited || reportOrderMeasurement().is_expedited || ['rush_1_3','rush_under_1'].includes(key));
  }

  function reportExpediteRefundInfo(){
    const measurement = reportOrderMeasurement();
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    const delivery = manifest.delivery && typeof manifest.delivery === 'object' ? manifest.delivery : {};
    const deliveryRefund = delivery.expedite_refund && typeof delivery.expedite_refund === 'object' ? delivery.expedite_refund : {};
    const status = String(
      reportOrderState?.expediteRefundStatus
      || measurement.report_expedite_refund_status
      || activeBaseProject?.report_expedite_refund_status
      || manifest.report_expedite_refund_status
      || deliveryRefund.status
      || ''
    ).trim().toLowerCase();
    const amount = Number(
      reportOrderState?.expediteRefundAmount
      ?? measurement.report_expedite_refund_amount
      ?? activeBaseProject?.report_expedite_refund_amount
      ?? manifest.report_expedite_refund_amount
      ?? deliveryRefund.amount
      ?? 0
    ) || 0;
    const refundedAt = reportOrderState?.expediteRefundAt
      || measurement.report_expedite_refund_at
      || activeBaseProject?.report_expedite_refund_at
      || manifest.report_expedite_refund_at
      || deliveryRefund.refunded_at
      || '';
    const message = reportOrderState?.expediteRefundMessage
      || measurement.report_expedite_refund_message
      || activeBaseProject?.report_expedite_refund_message
      || manifest.report_expedite_refund_message
      || '';
    return { active: status === 'refunded' || status === 'no_charge', status, amount, refundedAt, message };
  }

  function reportExpediteRefundNoticeHtml(){
    const info = reportExpediteRefundInfo();
    if (!info.active) return '';
    const amountText = info.amount > 0
      ? `$${fmtMoney(info.amount)} in expedite fees was refunded to your credits.`
      : 'The expedited delivery charge was removed for this order.';
    const at = info.refundedAt ? ` Refunded ${escapeHtml(formatDate(info.refundedAt))}.` : '';
    return `
      <div class="r-report-refund-note">
        <i class="fas fa-circle-info"></i>
        <div>
          <strong>Expedite refund applied</strong>
          <span>${escapeHtml(amountText)} We missed the expedited delivery window, but your report is still being completed as quickly as possible.${at}</span>
        </div>
      </div>`;
  }

  function reportOrderDueEnd(){
    const measurement = reportOrderMeasurement();
    const explicit = parseReportDate(reportOrderState?.reportDueWindowEnd || measurement.report_due_window_end || activeBaseProject?.report_due_window_end);
    if (explicit) return explicit;
    const submitted = parseReportDate(reportOrderState?.submittedAt || measurement.submitted_at || activeBaseProject?.created_at || activeBaseProject?.updated_at);
    if (!submitted) return null;
    const option = reportExpediteOption(reportOrderExpediteKey()) || defaultReportExpediteOption();
    return addMinutes(submitted, Number(option?.endMinutes) || 360);
  }

  function reportOrderCustomerDeliveryText(){
    const dueEnd = reportOrderDueEnd();
    if (dueEnd) return reportCustomerPromiseLabelFromDate(dueEnd);
    const measurement = reportOrderMeasurement();
    const windowLabel = reportOrderState?.reportDueWindowLabel
      || measurement.report_due_window_label
      || activeBaseProject?.report_due_window_label
      || '';
    return reportCustomerPromiseLabelFromWindow(windowLabel);
  }

  function formatMinutesDuration(minutes){
    const rounded = Math.max(0, Math.round(Number(minutes) || 0));
    const hours = Math.floor(rounded / 60);
    const mins = rounded % 60;
    if (hours && mins) return `${hours} hr ${mins} min`;
    if (hours) return `${hours} hr${hours === 1 ? '' : 's'}`;
    return `${mins} min`;
  }

  function formatCancelRemaining(seconds){
    const remaining = Math.max(0, Math.ceil(Number(seconds) || 0));
    if (remaining > 300) return formatMinutesDuration(Math.ceil(remaining / 60));
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    if (mins > 0) return `${mins} min ${String(secs).padStart(2, '0')} sec`;
    return `${secs} sec`;
  }

  function reportOrderRemainingMinutes(){
    const dueEnd = reportOrderDueEnd();
    if (!dueEnd) return null;
    return Math.max(0, Math.ceil((dueEnd.getTime() - Date.now()) / 60000));
  }

  function reportOrderCancelState(){
    const expedited = reportOrderIsExpedited();
    const submitted = parseReportDate(reportOrderState?.submittedAt || reportOrderMeasurement().submitted_at || activeBaseProject?.created_at || activeBaseProject?.updated_at);
    const graceMinutes = expedited ? 1 : 15;
    const now = Date.now();
    const deadline = submitted ? submitted.getTime() + (graceMinutes * 60000) : 0;
    const elapsed = submitted ? Math.max(0, (now - submitted.getTime()) / 60000) : Infinity;
    const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));
    return {
      expedited,
      allowed: elapsed <= graceMinutes,
      graceMinutes,
      deadline,
      remainingSeconds: remaining,
      message: expedited
        ? 'Expedited reports begin work immediately and cannot be cancelled after 1 minute.'
        : 'Standard reports can be cancelled within 15 minutes of ordering.'
    };
  }

  function clearCancellationCountdown(){
    if (!cancellationCountdownTimer) return;
    clearTimeout(cancellationCountdownTimer);
    cancellationCountdownTimer = null;
  }

  function scheduleCancellationCountdown(cancelState = reportOrderCancelState()){
    clearCancellationCountdown();
    if (!reportCancellationsEnabled() || !cancelState.allowed || cancelState.remainingSeconds <= 0) return;
    const remainingMs = Math.max(0, Number(cancelState.deadline || 0) - Date.now());
    if (remainingMs <= 0) {
      cancellationCountdownTimer = setTimeout(() => {
        cancellationCountdownTimer = null;
        if (activePreviewTab === 'measurements') renderMeasurementsPanel();
      }, 250);
      return;
    }
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    let delay;
    if (remainingSeconds <= 300) {
      delay = (remainingMs % 1000) + 80;
      if (delay < 120) delay += 1000;
    } else {
      const currentDisplayedMinutes = Math.ceil(remainingSeconds / 60);
      const nextDisplayedMinuteBoundaryMs = Math.max(0, remainingMs - ((currentDisplayedMinutes - 1) * 60000));
      delay = Math.max(250, nextDisplayedMinuteBoundaryMs + 80);
    }
    cancellationCountdownTimer = setTimeout(() => {
      cancellationCountdownTimer = null;
      refreshCancellationCountdown();
    }, Math.min(delay, 60000));
  }

  function refreshCancellationCountdown(){
    if (activePreviewTab !== 'measurements' || !reportOrderState?.ordered) {
      clearCancellationCountdown();
      return;
    }
    const cancelState = reportOrderCancelState();
    if (!cancelState.allowed || cancelState.remainingSeconds <= 0) {
      renderMeasurementsPanel();
      return;
    }
    const button = document.querySelector('[data-cancel-report-order]');
    if (!button) {
      clearCancellationCountdown();
      return;
    }
    button.textContent = `Cancel report (${formatCancelRemaining(cancelState.remainingSeconds)} left)`;
    scheduleCancellationCountdown(cancelState);
  }

  function pendingExpediteOptions(){
    const remaining = reportOrderRemainingMinutes();
    const currentKey = reportOrderExpediteKey();
    const currentOption = reportExpediteOption(currentKey) || defaultReportExpediteOption();
    const currentStart = Number(currentOption?.startMinutes) || 180;
    const closed = reportOrderingClosed();
    const pricingReady = reportExpeditePricingReady();
    return reportExpediteOptions
      .filter((option) => option.expedited)
      .map((option) => {
        const end = Number(option.endMinutes) || 0;
        const start = Number(option.startMinutes) || 0;
        const alreadyAsFast = currentKey === option.key || (reportOrderIsExpedited() && start >= currentStart);
        const notFaster = remaining != null && end >= remaining;
        const availableWhenPriced = !(closed || alreadyAsFast || notFaster);
        const delta = pricingReady ? reportOrderExpediteUpgradeDelta(option) : 0;
        return {
          option,
          disabled: !availableWhenPriced || !pricingReady || delta <= 0,
          availableWhenPriced,
          priceLoading: availableWhenPriced && !pricingReady,
          delta
        };
      });
  }

  function pendingExpeditePriceHtml(delta, loading = false){
    if (loading) return '<span class="r-pending-action-price is-loading" aria-label="Loading current price"></span>';
    return `<span class="r-pending-action-price">+$${escapeHtml(fmtMoney(delta))}</span>`;
  }

  function selectPendingReportExpedite(optionKey){
    const upgrade = pendingExpediteOptions().find((entry) => entry.option?.key === optionKey && !entry.disabled);
    pendingExpediteSelection = upgrade ? optionKey : '';
    renderMeasurementsPanel();
  }

  function pendingReportHtml(kind){
    const stage = reportOrderPendingStage();
    const title = kind === 'instant'
      ? 'Instant Report Generating'
      : (kind === 'customer'
        ? 'Customer Report Processing'
        : (stage === 'processing' ? 'Standard Report Processing' : 'Standard Report Pending'));
    if (reportOrderIsRejected()) return rejectedReportHtml();
    if (reportOrderIsCancelled()) return cancelledReportHtml();
    if (reportOrderIsStaleSubmitted()) return staleSubmittedReportHtml();
    if (!reportOrderIsActivelyPending()) return reportCompletePlaceholderHtml(kind);
    if (kind !== 'standard') return `<div class="r-report-pending"><div class="r-report-pending-card"><i class="fas fa-circle-notch fa-spin"></i><h3>${title}</h3></div></div>`;
    const expedited = reportOrderIsExpedited();
    const due = reportOrderCustomerDeliveryText();
    const cancelState = reportOrderCancelState();
    const closed = reportOrderingClosed();
    const showExpediteUpgrade = reportExpediteOptionsEnabled();
    if (showExpediteUpgrade && !closed && !reportExpeditePricingReady() && !reportExpeditePricingLoading()) {
      loadReportExpediteOptions();
    }
    const showCancellation = reportCancellationsEnabled();
    const options = showExpediteUpgrade ? pendingExpediteOptions() : [];
    const pricingReady = reportExpeditePricingReady();
    const hasFasterOption = pricingReady
      ? options.some((entry) => !entry.disabled)
      : options.some((entry) => entry.availableWhenPriced);
    const selectedUpgrade = options.find((entry) => entry.option?.key === pendingExpediteSelection && !entry.disabled) || null;
    const selectedUpgradeLabel = selectedUpgrade
      ? reportExpediteDurationLabel(selectedUpgrade.option)
      : '';
    const deliveryText = reportExpediteOptionsEnabled() ? (due || 'Estimating delivery window') : '';
    const statusLabel = stage === 'processing' ? 'In progress' : (stage === 'review' ? 'In review' : 'Pending');
    const cancelLabel = cancelState.allowed
      ? `Cancel report${cancelState.remainingSeconds ? ` (${formatCancelRemaining(cancelState.remainingSeconds)} left)` : ''}`
      : 'Cancel report';
    return `
      <div class="r-report-pending">
        <div class="r-report-pending-card${expedited ? ' is-expedited' : ''}">
          ${expedited ? '<h3 class="r-pending-title is-expedited"><i class="fas fa-bolt"></i> Expedited</h3>' : `<i class="fas fa-circle-notch fa-spin"></i><h3>${title}</h3>`}
          ${reportExpediteRefundNoticeHtml()}
          <div class="r-pending-detail"><strong>Status</strong><span>${escapeHtml(statusLabel)}</span></div>
          ${deliveryText ? `<div class="r-pending-detail"><strong>Estimated delivery</strong><span>${escapeHtml(deliveryText)}</span></div>` : ''}
          ${expedited ? '<p>Expedited reports begin work immediately.</p>' : (showExpediteUpgrade ? `
            <div class="r-pending-actions">
              ${closed ? '<p>Expediting is unavailable while we are closed.</p>' : (!pricingReady && hasFasterOption ? '<p>Checking current expedite pricing...</p>' : (hasFasterOption ? '<p>Need it sooner? Expedite this order from now.</p>' : '<p>This project is already being worked on, so expediting is too late.</p>'))}
              <div class="r-pending-action-row">
                ${options.map(({ option, disabled, delta, priceLoading }) => {
                  const selected = option.key === pendingExpediteSelection && !disabled;
                  return `<button type="button" class="r-pending-action${selected ? ' selected' : ''}" data-select-upgrade-expedite="${escapeHtml(option.key)}" aria-pressed="${selected ? 'true' : 'false'}" ${disabled ? 'disabled' : ''}><span class="r-pending-action-copy"><strong>${escapeHtml(reportExpediteDurationLabel(option))}</strong><span>${escapeHtml(reportExpediteCustomerPromiseLabel(option))}</span></span>${pendingExpeditePriceHtml(delta, priceLoading)}</button>`;
                }).join('')}
              </div>
              ${selectedUpgrade ? `<button type="button" class="r-pending-expedite-confirm" data-confirm-upgrade-expedite="${escapeHtml(selectedUpgrade.option.key)}">Expedite Report${selectedUpgradeLabel ? ` - ${escapeHtml(selectedUpgradeLabel)}` : ''}</button>` : ''}
            </div>` : '')}
          ${showCancellation ? `
          <div class="r-pending-actions">
            <button type="button" class="r-pending-cancel" data-cancel-report-order ${cancelState.allowed ? '' : 'disabled'}>${escapeHtml(cancelLabel)}</button>
            <div class="r-pending-note">${escapeHtml(cancelState.allowed ? cancelState.message : (cancelState.expedited ? 'The 1-minute cancellation grace period for this expedited report has ended.' : 'The cancellation grace period for this project has ended.'))}</div>
          </div>` : ''}
        </div>
      </div>`;
  }

  function reportCompletePlaceholderHtml(kind){
    const title = kind === 'customer' ? 'Customer Report Processing' : (kind === 'instant' ? 'Instant Report Pending' : 'Standard Report Pending');
    return `
      <div class="r-report-pending">
        <div class="r-report-pending-card">
          <i class="fas fa-circle-notch fa-spin"></i>
          <h3>${escapeHtml(title)}</h3>
          <p>We are checking for the report file. It will appear here as soon as it is available.</p>
        </div>
      </div>`;
  }

  function cancelledReportHtml(){
    const refunded = Number(reportOrderState?.refundedAmount ?? reportOrderMeasurement().cancellation_refund_amount ?? activeBaseProject?.cancellation_refund_amount ?? 0) || 0;
    return `
      <div class="r-report-pending">
        <div class="r-report-pending-card is-cancelled">
          <i class="fas fa-ban"></i>
          <h3>Report Canceled</h3>
          <p>This report order was canceled and is no longer being processed.</p>
          ${refunded > 0 ? `<div class="r-pending-detail"><strong>Refunded</strong><span>$${escapeHtml(fmtMoney(refunded))} returned to credits</span></div>` : ''}
          <div class="r-pending-actions">
            <button type="button" class="r-pending-reorder" data-reorder-report-order>Order this report again</button>
            <div class="r-pending-note">This starts a new report order for this same project and replaces the canceled order in this workflow.</div>
          </div>
        </div>
      </div>`;
  }

  function staleSubmittedReportHtml(){
    return `
      <div class="r-report-pending">
        <div class="r-report-pending-card is-cancelled">
          <i class="fas fa-ban"></i>
          <h3>Report Not Active</h3>
          <p>This report stayed in submitted state and is no longer being processed.</p>
          <div class="r-pending-actions">
            <button type="button" class="r-pending-reorder" data-reorder-report-order>Order this report again</button>
            <div class="r-pending-note">This starts a new report order for this same project and replaces the stalled order in this workflow.</div>
          </div>
        </div>
      </div>`;
  }

  function normalizeProjectTypeLabel(value){
    const key = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    if (key === 'multi-family' || key === 'multifamily') return 'multi-family';
    if (key === 'commercial') return 'commercial';
    return 'residential';
  }

  function reportOrderReorderType(){
    const measurement = reportOrderMeasurement();
    const reorder = (activeBaseProject?.rejection_reorder && typeof activeBaseProject.rejection_reorder === 'object')
      ? activeBaseProject.rejection_reorder
      : ((measurement?.rejection_reorder && typeof measurement.rejection_reorder === 'object') ? measurement.rejection_reorder : {});
    const type = activeBaseProject?.correct_project_type
      || activeBaseProject?.rejection_correct_project_type
      || measurement?.correct_project_type
      || measurement?.rejection_correct_project_type
      || reorder.project_type
      || activeBaseProject?.reorder_project_type
      || measurement?.reorder_project_type
      || '';
    const normalized = String(type || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    if (normalized === 'multi-family' || normalized === 'multifamily') return 'multifamily';
    if (normalized === 'commercial') return 'commercial';
    return '';
  }

  function customerRejectionCopy(value = ''){
    return String(value || '')
      .replace(/,\s*and the reorder link opens the same order with [^.]+ selected\./gi, '.')
      .replace(/\s+and the reorder link opens the same order with [^.]+ selected\./gi, '.')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function fallbackCustomerRejectionCopy(reason, details = {}){
    const key = String(reason || '').trim().toLowerCase();
    const rejectionMessage = customerRejectionCopy(details.rejection_message || '');
    if (key === 'obscured_visibility') {
      return 'This report was rejected because the structure is too obscured in the available imagery. This can happen when trees, shadows, image quality, or other visual obstructions prevent us from confidently identifying and measuring the roof. We have reimbursed the original report.';
    }
    if (key === 'invalid_pin_placement') {
      return 'This report was rejected because the selected pin does not appear to be placed on a structure we can measure. This can happen if the pin is on a yard, driveway, nearby object, or a structure that does not have enough usable imagery for accurate measurement. We have reimbursed the original report.';
    }
    if (key === 'incorrect_structure_type') {
      const reorderLabel = normalizeProjectTypeLabel(details.reorder_type || details.project_type || 'commercial');
      return `This report was rejected because it appears to require a ${reorderLabel} report. We have reimbursed the original report.`;
    }
    if (key === 'api_insufficient_credits') {
      return rejectionMessage || 'This report was rejected because the organization did not have enough credits for the additional structures. No additional structure-pin billing was kept for this rejected report.';
    }
    return 'This report was rejected. We have reimbursed the original report.';
  }

  function normalizeOrderProjectType(value){
    const key = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    if (key === 'multi-family' || key === 'multifamily') return 'multifamily';
    return TYPE_META[key] ? key : '';
  }

  function reorderSourceProjectId(baseProject = {}){
    return String(
      baseProject.reorder_source_project_id
      || baseProject.source_project_id
      || baseProject.rejection_reorder?.source_project_id
      || baseProject.measurement_project?.id
      || baseProject.measurement_project?.folder
      || baseProject.measurement_project?.project_id
      || baseProject.measurement_project?.measurement_project_id
      || baseProject.measurement?.id
      || baseProject.measurement?.folder
      || baseProject.measurement?.project_id
      || baseProject.measurement?.measurement_project_id
      || ''
    ).trim();
  }

  function applyReorderPrefillState(baseProject = {}){
    const measurement = (baseProject.measurement_project && typeof baseProject.measurement_project === 'object')
      ? baseProject.measurement_project
      : ((baseProject.measurement && typeof baseProject.measurement === 'object') ? baseProject.measurement : {});
    const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    const manifest = (raw.manifest && typeof raw.manifest === 'object') ? raw.manifest : {};
    const reorder = (baseProject.rejection_reorder && typeof baseProject.rejection_reorder === 'object') ? baseProject.rejection_reorder : {};
    const correctedType = normalizeOrderProjectType(
      baseProject.correct_project_type
      || baseProject.rejection_correct_project_type
      || reorder.project_type
      || measurement.correct_project_type
      || measurement.rejection_correct_project_type
      || baseProject.project_type
    );
    reorderMeasurementProjectId = reorderSourceProjectId(baseProject);
    reorderSourceCanReopenInPlace = isRejectedStatus(
      baseProject.status,
      baseProject.workflow_state,
      measurement.status,
      raw.status,
      manifest.status
    );
    reportOrderState = null;
    reportSelection = 'roof';
    if (correctedType) selectedType = correctedType;
    typePickerExpanded = false;
    includeGutterMeasurements = selectedType === 'residential' && !!(baseProject.include_gutter_measurements || measurement.include_gutters);
    includeWeatherReport = !!(baseProject.include_weather_report || baseProject.weather_report_id || measurement.include_weather_report || measurement.weather_report_id);
    const previousMode = String(baseProject.report_mode || measurement.report_mode || '').trim().toLowerCase();
    includeInstantPreview = shouldAutoOpenInstantFromMode(previousMode);
    selectedReportExpedite = baseProject.report_expedite_option || measurement.report_expedite_option || selectedReportExpedite || null;
    activeMeasurementTab = 'standard';
    const pins = normalizeProjectPins(baseProject);
    if (baseProject.address) addressSelected = true;
    if (pins.length) {
      locationConfirmed = true;
      if ($('#rCustom')) $('#rCustom').value = '1';
      setCoords(pins[0].lat, pins[0].lng, true);
    }
    mobileOrderPage = mobileOrderUsesFinalPage() ? 'final' : 'details';
    setProjectionMode(false);
    setActivePreviewTab('map');
  }

  function rejectedReportHtml(){
    const measurement = reportOrderMeasurement();
    const refundAmount = Number(activeBaseProject?.refund_amount ?? measurement?.refund_amount ?? 0) || 0;
    const reorderType = reportOrderReorderType();
    const reorderLabel = normalizeProjectTypeLabel(reorderType || activeBaseProject?.project_type || selectedType || 'commercial');
    const reason = String(activeBaseProject?.rejection_reason || measurement?.rejection_reason || '').trim().toLowerCase();
    const copy = customerRejectionCopy(activeBaseProject?.customer_rejection_message)
      || customerRejectionCopy(measurement?.customer_rejection_message)
      || fallbackCustomerRejectionCopy(reason, {
        reorder_type: reorderType,
        project_type: activeBaseProject?.project_type || selectedType,
        rejection_message: activeBaseProject?.rejection_message || measurement?.rejection_message || ''
      });
    return `
      <div class="r-report-pending">
        <div class="r-report-pending-card is-rejected">
          <i class="fas fa-circle-exclamation"></i>
          <h3>Report rejected</h3>
          <p>${escapeHtml(copy)}</p>
          ${refundAmount > 0 ? `<div class="r-pending-detail"><strong>Reimbursed</strong><span>$${escapeHtml(fmtMoney(refundAmount))} returned to credits</span></div>` : ''}
          ${reorderType ? `
          <div class="r-pending-actions">
            <button type="button" class="r-pending-reorder" data-reorder-rejected-report>${escapeHtml(`Reorder as ${reorderLabel.charAt(0).toUpperCase() + reorderLabel.slice(1)}`)}</button>
          </div>` : ''}
        </div>
      </div>`;
  }

  function reorderCurrentReportOrder(correctedType = ''){
    if (!activeBaseProject) return;
    const measurement = reportOrderMeasurement();
    applyReorderPrefillState({
      ...activeBaseProject,
      correct_project_type: correctedType || activeBaseProject.correct_project_type || measurement?.correct_project_type || activeBaseProject.project_type,
      reorder_source_project_id: activeMeasurementProjectId(),
      measurement: {
        ...(activeBaseProject.measurement || {}),
        ...(measurement || {})
      },
      measurement_project: {
        ...(activeBaseProject.measurement_project || {}),
        ...(measurement || {})
      }
    });
    renderRoofChoice();
    renderWorkflowState();
    syncProjectViewerTabs();
    projectViewer?.setActiveTab?.('map');
  }

  function reorderCancelledReportOrder(){
    reorderCurrentReportOrder('');
  }

  function reorderRejectedReportOrder(){
    reorderCurrentReportOrder(reportOrderReorderType());
  }

  function reportFrameHtml(url){
    const safeUrl = escapeHtml(url || '');
    if (pdfPreviewDisabled) {
      return `
        <div class="r-report-debug-disabled">
          <div class="r-report-debug-card">
            <i class="fas fa-file-pdf"></i>
            <h3>PDF preview disabled</h3>
            <p>The embedded PDF viewer is disabled by the current debug flag so Chrome mobile tools can stay open.</p>
            ${url ? `<a href="${safeUrl}" target="_blank" rel="noopener"><i class="fas fa-up-right-from-square"></i> Open PDF</a>` : ''}
          </div>
        </div>`;
    }
    return `
      <div class="r-report-frame">
        <iframe class="r-report-iframe" src="${safeUrl}#view=FitH"></iframe>
      </div>
    `;
  }

  function ensureMeasurementSummaryCss(){
    injectCSS('measurement_report_summary', `
      .r-report-summary{height:100%;overflow:auto;background:#f8fafc;padding:22px;box-sizing:border-box;color:#18222d}
      .r-report-summary-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:16px}
      .r-report-summary-title h3{margin:0;font-size:22px;line-height:1.15;color:#101828;font-weight:1000}
      .r-report-summary-title p{margin:6px 0 0;font-size:12px;line-height:1.45;color:#667085;font-weight:850}
      .r-report-summary-status{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid rgba(15,23,42,.08);border-radius:999px;background:#fff;color:#344054;font-size:11px;font-weight:1000;text-transform:uppercase;white-space:nowrap}
      .r-report-summary-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(300px,.9fr);gap:14px;align-items:start}
      .r-report-summary-section{border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#fff;box-shadow:0 10px 24px rgba(15,23,42,.05);overflow:hidden}
      .r-report-summary-section h4{margin:0;padding:13px 15px;border-bottom:1px solid rgba(15,23,42,.07);display:flex;align-items:center;gap:8px;font-size:13px;font-weight:1000;color:#101828}
      .r-report-summary-section h4 i{color:var(--primary-readable,var(--primary,#d93025))}
      .r-report-summary-section h4 .r-report-summary-heading{display:inline-flex;align-items:center;gap:8px;min-width:0}
      .r-report-summary-section h4 .r-report-summary-heading-spacer{flex:1}
      .r-report-summary-download{appearance:none;border:1px solid rgba(15,23,42,.10);border-radius:7px;background:#fff;color:#344054;display:inline-flex;align-items:center;gap:6px;padding:6px 9px;font:inherit;font-size:11px;font-weight:1000;line-height:1;cursor:pointer;transition:.16s ease}
      .r-report-summary-download:hover{border-color:rgba(var(--primary-rgb,217,48,37),.30);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.04)}
      .r-report-summary-download i{color:currentColor}
      .r-report-summary-list{display:grid}
      .r-report-summary-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 15px;border-top:1px solid rgba(15,23,42,.06)}
      .r-report-summary-row:first-child{border-top:0}
      .r-report-summary-row strong{display:block;font-size:13px;font-weight:1000;color:#18222d}
      .r-report-summary-row span{display:block;margin-top:3px;font-size:11px;font-weight:850;color:#667085;line-height:1.35}
      .r-report-summary-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 8px;background:#eef2f7;color:#475467;font-size:10px;font-weight:1000;text-transform:uppercase;white-space:nowrap}
      .r-report-summary-pill.ready{background:#ecfdf3;color:#067647}
      .r-report-summary-pill.pending{background:#fff8db;color:#7a5b00}
      .r-report-summary-link{display:inline-flex;align-items:center;gap:6px;color:var(--primary-readable,var(--primary,#d93025));font-size:11px;font-weight:1000;text-decoration:none}
      .r-report-summary-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;padding:14px}
      .r-report-summary-metric{border:1px solid rgba(15,23,42,.07);border-radius:8px;background:#f8fafc;padding:12px;min-height:78px;box-sizing:border-box}
      .r-report-summary-metric span{display:block;font-size:10px;font-weight:1000;text-transform:uppercase;color:#667085}
      .r-report-summary-metric strong{display:block;margin-top:8px;font-size:21px;line-height:1.05;font-weight:1000;color:#101828}
      .r-report-summary-metric em{font-style:normal;font-size:11px;font-weight:850;color:#667085}
      .r-report-summary-delivery{padding:14px 15px;display:grid;gap:12px}
      .r-report-summary-field{display:grid;gap:4px}
      .r-report-summary-field span{font-size:10px;font-weight:1000;text-transform:uppercase;color:#667085}
      .r-report-summary-field strong,.r-report-summary-field div{font-size:13px;font-weight:900;line-height:1.45;color:#18222d}
      .r-report-summary-cc{display:flex;flex-wrap:wrap;gap:6px}
      .r-report-summary-cc b{display:inline-flex;border-radius:6px;background:#eef2f7;padding:4px 7px;font-size:11px;font-weight:900;color:#344054}
      .r-report-summary-notes{white-space:pre-wrap;border:1px solid rgba(15,23,42,.07);border-radius:8px;background:#f8fafc;padding:10px}
      .r-report-summary-empty{padding:18px 15px;color:#667085;font-size:12px;font-weight:850;line-height:1.45}
      @media (max-width: 820px){
        .r-report-summary{padding:14px}
        .r-report-summary-head{flex-direction:column;align-items:stretch}
        .r-report-summary-grid{grid-template-columns:1fr}
        .r-report-summary-row{grid-template-columns:1fr}
      }
    `);
  }

  function csvCell(value){
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function csvNumericCell(value){
    const text = String(value ?? '').trim();
    return /^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$/.test(text) ? text.replace(/,/g, '') : text;
  }

  function reportSummaryMeasurementsCsv(metrics = []){
    return [
      ['Measurement', 'Value', 'Unit'].map(csvCell).join(','),
      ...metrics.map((metric) => [
        metric.label,
        csvNumericCell(metric.value),
        metric.unit || ''
      ].map(csvCell).join(','))
    ].join('\r\n');
  }

  function reportSummaryCsvFileName(projectId = activeMeasurementProjectId()){
    return `measurements_${String(projectId || activeBaseProject?.id || '').slice(0, 12) || 'summary'}.csv`;
  }

  function downloadTextFile(text, fileName, contentType){
    const blob = new Blob([text], { type: contentType });
    const objUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objUrl;
    link.download = fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(objUrl);
      link.remove();
    }, 1000);
  }

  function plainObject(value){
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function reportSummarySources(){
    const measurement = reportOrderMeasurement();
    const raw = plainObject(measurement.raw);
    const manifest = plainObject(raw.manifest || measurement.manifest);
    const data = plainObject(reportOrderState?.data);
    return {
      measurement,
      raw,
      manifest,
      data,
      delivery: plainObject(manifest.delivery || raw.delivery || measurement.delivery || activeBaseProject?.delivery),
      emailState: plainObject(manifest.email_state || raw.email_state || measurement.email_state || activeBaseProject?.email_state)
    };
  }

  function readPath(source, path){
    return String(path || '').split('.').reduce((value, key) => (
      value && typeof value === 'object' ? value[key] : undefined
    ), source);
  }

  function numericValue(value){
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
      if (match) {
        const number = Number(match[0]);
        if (Number.isFinite(number)) return number;
      }
    }
    return null;
  }

  function firstFinitePath(sources, paths){
    for (const source of sources) {
      for (const path of paths) {
        const value = numericValue(readPath(source, path));
        if (value != null) return value;
      }
    }
    return null;
  }

  function firstCleanText(...values){
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  function normalizeEmailList(...values){
    const emails = [];
    const addEmail = (item) => {
      if (Array.isArray(item)) {
        item.forEach(addEmail);
        return;
      }
      if (item && typeof item === 'object') {
        addEmail(item.email);
        return;
      }
      const text = String(item ?? '').trim();
      if (!text) return;
      if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
        try {
          addEmail(JSON.parse(text));
          return;
        } catch (error) {}
      }
      text.split(/[,\n;]/).forEach((part) => {
        const email = part.trim().replace(/^['"]+|['"]+$/g, '');
        if (email && !emails.some((existing) => existing.toLowerCase() === email.toLowerCase())) emails.push(email);
      });
    };
    values.forEach((value) => {
      addEmail(value);
    });
    return emails;
  }

  function reportLineType(value){
    const key = String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, '');
    if (key.includes('ridge')) return 'ridge';
    if (key.includes('valley')) return 'valley';
    if (key.includes('rake') || key.includes('gable')) return 'rake';
    if (key.includes('eave') || key.includes('eve')) return 'eave';
    if (key.includes('hip')) return 'hip';
    if (key.includes('headwall') || key === 'headwall' || key === 'head') return 'headWall';
    if (key.includes('sidewall') || key === 'sidewall' || key === 'side') return 'sideWall';
    if (key.includes('stepflash') || key.includes('stepflashing')) return 'stepFlashing';
    if (key.includes('transition') || key === 'trans' || key.includes('flashing')) return 'transition';
    if (key.includes('parapet')) return 'parapet';
    if (key.includes('chimney')) return 'counterFlashing';
    return '';
  }

  function reportLineMetricLabel(type){
    return ({
      eave: 'Eaves',
      valley: 'Valleys',
      rake: 'Rakes',
      ridge: 'Ridges',
      hip: 'Hips',
      headWall: 'Headwall flashing',
      sideWall: 'Sidewall flashing',
      stepFlashing: 'Step flashing',
      transition: 'Transitions',
      parapet: 'Parapet wall',
      counterFlashing: 'Counter flashing'
    })[type] || '';
  }

  function reportLineLength(value){
    return numericValue(
      value?.length_ft
      ?? value?.lengthFt
      ?? value?.total_length_ft
      ?? value?.totalLengthFt
      ?? value?.line_length_ft
      ?? value?.lineLengthFt
      ?? value?.feet
      ?? value?.ft
      ?? value?.length
    );
  }

  function reportObstacleType(value){
    const key = String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, '');
    if (key.includes('skylight')) return 'skylight';
    if (key.includes('chimney')) return 'chimney';
    return '';
  }

  function reportObstacleLabel(type){
    return type === 'chimney' ? 'chimney' : (type === 'skylight' ? 'skylight' : '');
  }

  function reportPointKey(point){
    if (!point || typeof point !== 'object') return '';
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return '';
    return `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
  }

  function reportLinePoints(line){
    if (Array.isArray(line?.points) && line.points.length >= 2) return [line.points[0], line.points[1]];
    if (line?.start && line?.end) return [line.start, line.end];
    if (line?.from && line?.to) return [line.from, line.to];
    return [null, null];
  }

  function reportDimensionLabel(value){
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '';
    const rounded = Math.round(number * 2) / 2;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/\.0$/, '');
  }

  function reportObstacleDimension(lengths){
    const sorted = (Array.isArray(lengths) ? lengths : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    if (!sorted.length) return '';
    const clusters = [];
    sorted.forEach((length) => {
      const cluster = clusters.find((item) => Math.abs(item.avg - length) <= 0.75);
      if (cluster) {
        cluster.values.push(length);
        cluster.avg = cluster.values.reduce((sum, value) => sum + value, 0) / cluster.values.length;
      } else {
        clusters.push({ avg: length, values: [length] });
      }
    });
    const dims = clusters
      .sort((a, b) => b.values.length - a.values.length || a.avg - b.avg)
      .slice(0, 2)
      .map((cluster) => cluster.avg)
      .sort((a, b) => a - b);
    if (!dims.length) return '';
    if (dims.length === 1) dims.push(dims[0]);
    const first = reportDimensionLabel(dims[0]);
    const second = reportDimensionLabel(dims[1]);
    return first && second ? `${first} x ${second}` : '';
  }

  function collectReportObstacleRows(){
    const { measurement, raw, manifest, data } = reportSummarySources();
    const sources = [activeBaseProject, measurement, raw, manifest, data].filter(Boolean);
    const candidates = [];
    const candidateKeys = new Set();
    const seen = new Set();
    const visit = (value, depth = 0) => {
      if (!value || depth > 5) return;
      if (typeof value === 'object') {
        if (seen.has(value)) return;
        seen.add(value);
      }
      if (Array.isArray(value)) {
        value.forEach((item) => {
          const type = reportObstacleType(item?.type || item?.line_type || item?.label || item?.name);
          const length = reportLineLength(item);
          const [start, end] = reportLinePoints(item);
          if (type && length != null) {
            const startKey = reportPointKey(start);
            const endKey = reportPointKey(end);
            const dedupeKey = [type, Math.round(Number(length) * 10) / 10, startKey, endKey].join('|');
            if (!candidateKeys.has(dedupeKey)) {
              candidateKeys.add(dedupeKey);
              candidates.push({ type, length, startKey, endKey });
            }
          }
          visit(item, depth + 1);
        });
        return;
      }
      if (typeof value !== 'object') return;
      Object.values(value).forEach((child) => visit(child, depth + 1));
    };
    sources.forEach((source) => visit(source));

    const rows = [];
    ['skylight', 'chimney'].forEach((type) => {
      const lines = candidates.filter((line) => line.type === type);
      const linesWithKeys = lines.filter((line) => line.startKey || line.endKey);
      const linesWithoutKeys = lines.filter((line) => !line.startKey && !line.endKey);
      const unused = new Set(linesWithKeys.map((_, index) => index));
      const groups = new Map();
      while (unused.size) {
        const firstIndex = unused.values().next().value;
        unused.delete(firstIndex);
        const queue = [firstIndex];
        const component = [];
        const keys = new Set([linesWithKeys[firstIndex].startKey, linesWithKeys[firstIndex].endKey].filter(Boolean));
        while (queue.length) {
          const index = queue.shift();
          component.push(linesWithKeys[index]);
          Array.from(unused).forEach((candidateIndex) => {
            const candidate = linesWithKeys[candidateIndex];
            if ((candidate.startKey && keys.has(candidate.startKey)) || (candidate.endKey && keys.has(candidate.endKey))) {
              unused.delete(candidateIndex);
              queue.push(candidateIndex);
              if (candidate.startKey) keys.add(candidate.startKey);
              if (candidate.endKey) keys.add(candidate.endKey);
            }
          });
        }
        const dimension = reportObstacleDimension(component.map((line) => line.length)) || 'Unknown size';
        const label = `${dimension} ${reportObstacleLabel(type)}`;
        groups.set(label, (groups.get(label) || 0) + 1);
      }
      for (let index = 0; index < linesWithoutKeys.length; index += 4) {
        const component = linesWithoutKeys.slice(index, index + 4);
        const dimension = reportObstacleDimension(component.map((line) => line.length)) || 'Unknown size';
        const label = `${dimension} ${reportObstacleLabel(type)}`;
        groups.set(label, (groups.get(label) || 0) + 1);
      }
      groups.forEach((count, label) => {
        rows.push({ label, value: formatSummaryNumber(count), unit: 'count' });
      });
    });
    return rows;
  }

  function xmlAttr(node, name){
    return node?.getAttribute?.(name) ?? '';
  }

  function xmlPointCoordinates(node){
    const data = xmlAttr(node, 'data');
    if (data) {
      const parts = data.split(',').map((part) => numericValue(part));
      return parts.length >= 3 ? { x: parts[0] || 0, y: parts[1] || 0, z: parts[2] || 0 } : null;
    }
    const x = numericValue(xmlAttr(node, 'x'));
    const y = numericValue(xmlAttr(node, 'y'));
    const z = numericValue(xmlAttr(node, 'z'));
    return x == null || y == null ? null : { x, y, z: z || 0 };
  }

  function distanceBetweenPoints(a, b){
    if (!a || !b) return null;
    const dx = (Number(a.x) || 0) - (Number(b.x) || 0);
    const dy = (Number(a.y) || 0) - (Number(b.y) || 0);
    const dz = (Number(a.z) || 0) - (Number(b.z) || 0);
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return Number.isFinite(distance) ? distance : null;
  }

  function reportSummaryMetricsFromXml(xmlText){
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'application/xml');
    if (xml.querySelector('parsererror')) return [];
    const pointById = new Map();
    const pointByIndex = new Map();
    Array.from(xml.querySelectorAll('POINT')).forEach((node, index) => {
      const point = xmlPointCoordinates(node);
      if (!point) return;
      const id = xmlAttr(node, 'id') || String(index + 1);
      const explicitIndex = xmlAttr(node, 'index') || String(index + 1);
      pointById.set(id, point);
      pointByIndex.set(String(explicitIndex), point);
      pointByIndex.set(String(index + 1), point);
    });

    const lineTotals = {
      ridge: 0,
      hip: 0,
      valley: 0,
      rake: 0,
      eave: 0,
      headWall: 0,
      sideWall: 0,
      stepFlashing: 0,
      transition: 0,
      parapet: 0,
      counterFlashing: 0
    };
    Array.from(xml.querySelectorAll('LINE')).forEach((node) => {
      const type = reportLineType(xmlAttr(node, 'type'));
      if (!type) return;
      let length = numericValue(xmlAttr(node, 'length')) ?? numericValue(xmlAttr(node, 'length_ft'));
      if (length == null) {
        const path = xmlAttr(node, 'path').split(',').map((part) => part.trim()).filter(Boolean);
        const start = xmlAttr(node, 'start') || path[0] || '';
        const end = xmlAttr(node, 'end') || path[path.length - 1] || '';
        length = distanceBetweenPoints(pointById.get(start) || pointByIndex.get(start), pointById.get(end) || pointByIndex.get(end));
      }
      if (length != null) lineTotals[type] += length;
    });

    const faces = Array.from(xml.querySelectorAll('SURFACE, FACE'));
    const surfaceAreas = [];
    const pitches = [];
    faces.forEach((node) => {
      const polygon = node.matches('FACE') ? node.querySelector('POLYGON') : null;
      const area = numericValue(xmlAttr(node, 'area')) ?? numericValue(xmlAttr(polygon, 'size')) ?? numericValue(xmlAttr(polygon, 'area'));
      if (area != null && area > 0) surfaceAreas.push(area);
      const pitch = numericValue(xmlAttr(node, 'pitch')) ?? numericValue(xmlAttr(polygon, 'pitch'));
      if (pitch != null && pitch > 0) pitches.push({ pitch, area: area || 1 });
    });

    const totalArea = surfaceAreas.reduce((sum, area) => sum + area, 0);
    const dominantPitch = pitches.length
      ? pitches.sort((a, b) => b.area - a.area)[0].pitch
      : null;
    const rows = [];
    if (totalArea > 0) {
      rows.push({ label: 'Roof squares', value: formatSummaryNumber(totalArea / 100, 1), unit: 'sq' });
      rows.push({ label: 'Roof area', value: formatSummaryNumber(totalArea), unit: 'sq ft' });
    }
    Object.entries(lineTotals).forEach(([type, total]) => {
      const label = reportLineMetricLabel(type);
      if (label && total > 0) rows.push({ label, value: formatSummaryNumber(total), unit: 'ft' });
    });
    if (faces.length) rows.push({ label: 'Facets', value: formatSummaryNumber(faces.length), unit: '' });
    if (dominantPitch != null) rows.push({ label: 'Main pitch', value: formatSummaryNumber(dominantPitch, 1), unit: '/12' });
    return rows;
  }

  function reportSummaryMetricCacheKey(projectId, xmlUrl){
    return String(projectId || xmlUrl || '').trim();
  }

  function loadReportSummaryMetricsFromXml(xmlUrl, projectId){
    const key = reportSummaryMetricCacheKey(projectId, xmlUrl);
    if (!xmlUrl || !key || measurementSummaryMetricCache.has(key) || measurementSummaryMetricLoads.has(key)) return;
    measurementSummaryMetricLoads.add(key);
    fetch(xmlUrl, { credentials: 'include' })
      .then((response) => {
        if (!response.ok) throw new Error(`Measurement XML unavailable (${response.status})`);
        return response.text();
      })
      .then((text) => {
        measurementSummaryMetricCache.set(key, reportSummaryMetricsFromXml(text));
      })
      .catch(() => {
        measurementSummaryMetricCache.set(key, []);
      })
      .finally(() => {
        measurementSummaryMetricLoads.delete(key);
        if (activePreviewTab === 'measurements' && activeMeasurementTab === 'summary') renderMeasurementsPanel();
      });
  }

  function collectReportLineTotals(){
    const { measurement, raw, manifest, data } = reportSummarySources();
    const totals = {
      ridge: 0,
      hip: 0,
      valley: 0,
      rake: 0,
      eave: 0,
      headWall: 0,
      sideWall: 0,
      stepFlashing: 0,
      transition: 0,
      parapet: 0,
      counterFlashing: 0
    };
    const seen = new Set();
    const visit = (value, depth = 0) => {
      if (!value || depth > 5) return;
      if (typeof value === 'object') {
        if (seen.has(value)) return;
        seen.add(value);
      }
      if (Array.isArray(value)) {
        value.forEach((item) => {
          const type = reportLineType(item?.type || item?.line_type || item?.label || item?.name);
          const length = reportLineLength(item);
          if (type && length != null) totals[type] += length;
          visit(item, depth + 1);
        });
        return;
      }
      if (typeof value !== 'object') return;
      Object.entries(value).forEach(([key, child]) => {
        const type = reportLineType(key);
        const directLength = type ? numericValue(child) : null;
        if (type && directLength != null) {
          totals[type] += directLength;
          return;
        }
        visit(child, depth + 1);
      });
    };
    [activeBaseProject, measurement, raw, manifest, data].forEach((source) => visit(source));
    Object.keys(totals).forEach((key) => {
      totals[key] = Math.round(totals[key] * 10) / 10;
    });
    return totals;
  }

  function formatSummaryNumber(value, decimals = 0){
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    const rounded = decimals > 0 ? Math.round(number * (10 ** decimals)) / (10 ** decimals) : Math.round(number);
    return rounded.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals
    });
  }

  function calculateReportSummarySuggestedWaste(facetCount, hipsFt = 0){
    const facets = Math.max(0, Math.round(Number(facetCount) || 0));
    const hasHips = Number(hipsFt) > 0;
    const base = Math.floor((facets + 1) / 3) + 5;
    return Math.min(25, base + (hasHips ? 3 : 0));
  }

  function finiteMetricValue(rows, label){
    const row = Array.isArray(rows) ? rows.find((item) => item?.label === label) : null;
    return row ? numericValue(row.value) : null;
  }

  function reportSummaryWastePercent(sources, facetCount, hipsFt){
    const waste = firstFinitePath(sources, [
      'manualWastePct',
      'manual_waste_pct',
      'wastePct',
      'waste_percent',
      'wastePercent',
      'suggestedWaste',
      'suggested_waste',
      'suggestedWastePct',
      'suggested_waste_pct',
      'materials.wastePercent',
      'materials.waste_pct',
      'summary.wastePercent',
      'summary.waste_pct',
      'measurements.wastePercent',
      'measurements.waste_pct',
      'pdf_state.manualWastePct',
      'pdfState.manualWastePct',
      'settings.manualWastePct'
    ]);
    if (waste != null) return Math.max(0, Math.min(60, Math.round(waste)));
    if (facetCount != null) return calculateReportSummarySuggestedWaste(facetCount, hipsFt);
    return 10;
  }

  function reportSummaryMetricRows(xmlRows = []){
    const { measurement, raw, manifest, data } = reportSummarySources();
    const sources = [
      measurement,
      raw,
      manifest,
      plainObject(manifest.components),
      plainObject(raw.components),
      plainObject(data.project),
      data,
      activeBaseProject || {}
    ];
    const squares = firstFinitePath(sources, [
      'materials.totalSquares',
      'report.materials.totalSquares',
      'measurements.total_squares',
      'measurements.totalSquares',
      'summary.total_squares',
      'summary.totalSquares',
      'roof.total_squares',
      'roof.squares',
      'total_squares',
      'totalSquares',
      'roof_squares',
      'squares'
    ]);
    const roofAreaSqFt = firstFinitePath(sources, [
      'materials.totalRoofAreaSqFt',
      'materials.total_area_sqft',
      'report.materials.totalRoofAreaSqFt',
      'measurements.roof_area_sqft',
      'measurements.total_roof_area_sqft',
      'summary.roof_area_sqft',
      'roof.total_area_sqft',
      'roof_area_sqft',
      'total_roof_area_sqft',
      'roofAreaSqFt'
    ]) || (squares != null ? squares * 100 : null);
    const facets = firstFinitePath(sources, [
      'total_facets',
      'facet_count',
      'facets',
      'measurements.facet_count',
      'materials.totalFacets',
      'report.total_facets'
    ]);
    const pitch = firstFinitePath(sources, [
      'predominant_pitch',
      'dominant_pitch',
      'pitch',
      'measurements.predominant_pitch',
      'summary.predominant_pitch'
    ]);
    const lineTotals = collectReportLineTotals();
    const rows = [];
    if (squares != null) rows.push({ label: 'Roof squares', value: formatSummaryNumber(squares, 1), unit: 'sq' });
    if (roofAreaSqFt != null) rows.push({ label: 'Roof area', value: formatSummaryNumber(roofAreaSqFt), unit: 'sq ft' });
    Object.entries(lineTotals).forEach(([type, total]) => {
      const label = reportLineMetricLabel(type);
      if (label && total > 0) rows.push({ label, value: formatSummaryNumber(total), unit: 'ft' });
    });
    if (facets != null) rows.push({ label: 'Facets', value: formatSummaryNumber(facets), unit: '' });
    if (pitch != null) rows.push({ label: 'Main pitch', value: formatSummaryNumber(pitch, 1), unit: '/12' });
    if (Array.isArray(xmlRows) && xmlRows.length) {
      const labels = new Set(rows.map((row) => row.label));
      xmlRows.forEach((row) => {
        if (!labels.has(row.label)) rows.push(row);
      });
    }
    collectReportObstacleRows().forEach((row) => {
      if (!rows.some((existing) => existing.label === row.label)) rows.push(row);
    });
    const resolvedSquares = squares ?? finiteMetricValue(rows, 'Roof squares');
    const resolvedFacets = facets ?? finiteMetricValue(rows, 'Facets');
    const resolvedHips = lineTotals.hip > 0 ? lineTotals.hip : (finiteMetricValue(rows, 'Hips') || 0);
    if (resolvedSquares != null) {
      const wastePct = reportSummaryWastePercent(sources, resolvedFacets, resolvedHips);
      if (!rows.some((row) => row.label === 'Suggested waste')) {
        rows.push({ label: 'Suggested waste', value: formatSummaryNumber(wastePct), unit: '%' });
      }
      if (!rows.some((row) => row.label === 'Squares with waste')) {
        rows.push({
          label: 'Squares with waste',
          value: formatSummaryNumber(Math.ceil(resolvedSquares * (1 + (wastePct / 100)))),
          unit: 'sq'
        });
      }
    }
    return rows;
  }

  function reportSummaryStatusLabel(row){
    if (row.processing) return 'Processing';
    if (row.ready) return 'Ready';
    if (row.pending) return 'Pending';
    return 'Not available';
  }

  function reportSummaryStatusClass(row){
    if (row.ready) return 'ready';
    if (row.processing || row.pending) return 'pending';
    return '';
  }

  function reportSummaryReportRows(cachedAssets = {}){
    const documentsUnlocked = reportOrderIsCompleteLike();
    const pending = reportOrderIsActivelyPending();
    const weather = weatherReportInfo();
    const instantOrdered = reportOrderIncludesInstant();
    const guttersOrdered = reportOrderIncludesGutters();
    const documentState = (url, pendingWhenUnlocked = false) => ({
      url: documentsUnlocked ? (url || '') : '',
      ready: documentsUnlocked && !!url,
      pending: documentsUnlocked && !!pendingWhenUnlocked,
      processing: !documentsUnlocked
    });
    const standardState = documentState(cachedAssets?.reportUrl || '', pending && !cachedAssets?.reportUrl);
    const summaryState = documentState(cachedAssets?.summaryUrl || '', pending && !cachedAssets?.summaryUrl);
    const rows = [
      {
        label: 'Standard report',
        detail: guttersOrdered ? 'Main roof measurement PDF with gutter measurements' : 'Main roof measurement PDF',
        ...standardState
      },
      {
        label: 'Customer Report',
        detail: 'Customer-facing summary PDF',
        ...summaryState
      }
    ];
    if (cachedAssets?.xmlUrl || documentsUnlocked) {
      rows.push({
        label: 'XML model',
        detail: 'Model data export',
        ...documentState(cachedAssets?.xmlUrl || '')
      });
    }
    if (instantOrdered) {
      rows.push({
        label: 'Instant report',
        detail: 'Instant measurement preview',
        ...documentState(cachedAssets?.instantPdfUrl || '')
      });
    }
    if (weatherReportsEnabled() || weather.ordered || weather.url) {
      rows.push({
        label: 'Weather report',
        detail: 'Historical severe-weather PDF',
        ...documentState(weather.url || '', weather.ordered && !weather.url)
      });
    }
    return rows;
  }

  function reportSummaryDeliveryInfo(){
    const { measurement, raw, manifest, delivery, emailState } = reportSummarySources();
    const reportEmail = plainObject(emailState.report_email);
    const cc = normalizeEmailList(
      reportOrderState?.ccEmails,
      reportOrderState?.payload?.cc_emails,
      activeBaseProject?.cc_emails,
      measurement.cc_emails,
      raw.cc_emails,
      manifest.cc_emails,
      delivery.cc_emails,
      reportEmail.cc,
      reportEmail.last_cc
    );
    const sentAt = firstCleanText(
      reportEmail.sent_at_utc,
      delivery.report_sent_at,
      manifest.report_sent_at,
      raw.report_sent_at,
      measurement.report_sent_at,
      activeBaseProject?.report_sent_at,
      activeBaseProject?.completed_at
    );
    const notes = firstCleanText(
      reportOrderState?.techNotes,
      reportOrderState?.payload?.tech_notes,
      activeBaseProject?.tech_notes,
      measurement.tech_notes,
      raw.tech_notes,
      manifest.tech_notes
    );
    return {
      sentAt,
      sentAtLabel: sentAt ? formatDate(sentAt) : 'Not sent yet',
      cc,
      notes,
      to: normalizeEmailList(reportEmail.last_to, delivery.to, manifest.issuer?.email, raw.issuer?.email, measurement.issuer?.email)[0] || ''
    };
  }

  function reportSummaryHtml(cachedAssets = {}, projectId = activeMeasurementProjectId()){
    ensureMeasurementSummaryCss();
    const project = activeBaseProject || {};
    const reportComplete = reportOrderIsCompleteLike();
    const status = reportOrderIsRejected()
      ? 'Rejected'
      : (reportOrderIsCancelled() ? 'Cancelled' : (reportOrderIsActivelyPending() ? 'Processing' : (reportComplete ? 'Complete' : 'Ordered')));
    const address = firstCleanText(project.address, project.project_address, reportOrderMeasurement().address);
    const reports = reportSummaryReportRows(cachedAssets);
    const metricKey = reportSummaryMetricCacheKey(projectId, cachedAssets?.xmlUrl || '');
    const xmlMetrics = reportComplete && metricKey ? measurementSummaryMetricCache.get(metricKey) : null;
    const metrics = reportComplete ? reportSummaryMetricRows(xmlMetrics || []) : [];
    const delivery = reportSummaryDeliveryInfo();
    const measurementsSection = reportComplete && metrics.length ? `
      <section class="r-report-summary-section" style="grid-column:1 / -1">
        <h4>
          <span class="r-report-summary-heading"><i class="fas fa-ruler"></i>Measurements</span>
          <span class="r-report-summary-heading-spacer"></span>
          <button type="button" class="r-report-summary-download" data-download-measurements-csv>
            <i class="fas fa-download"></i> CSV
          </button>
        </h4>
        <div class="r-report-summary-metrics">
          ${metrics.map((metric) => `
            <div class="r-report-summary-metric">
              <span>${escapeHtml(metric.label)}</span>
              <strong>${escapeHtml(metric.value)}</strong>
              ${metric.unit ? `<em>${escapeHtml(metric.unit)}</em>` : ''}
            </div>
          `).join('')}
        </div>
      </section>
    ` : '';
    return `
      <div class="r-report-summary">
        <div class="r-report-summary-head">
          <div class="r-report-summary-title">
            <h3>Roof Report Summary</h3>
            ${address ? `<p>${escapeHtml(address)}</p>` : ''}
          </div>
          <div class="r-report-summary-status"><i class="fas fa-ruler-combined"></i>${escapeHtml(status)}</div>
        </div>
        <div class="r-report-summary-grid">
          <section class="r-report-summary-section">
            <h4><i class="fas fa-file-lines"></i>Reports</h4>
            <div class="r-report-summary-list">
              ${reports.map((row) => `
                <div class="r-report-summary-row">
                  <div>
                    <strong>${escapeHtml(row.label)}</strong>
                    <span>${escapeHtml(row.detail)}${row.url ? ` <a class="r-report-summary-link" href="${escapeHtml(row.url)}" target="_blank" rel="noopener"><i class="fas fa-up-right-from-square"></i>Open</a>` : ''}</span>
                  </div>
                  <div class="r-report-summary-pill ${reportSummaryStatusClass(row)}">${escapeHtml(reportSummaryStatusLabel(row))}</div>
                </div>
              `).join('')}
            </div>
          </section>
          <section class="r-report-summary-section">
            <h4><i class="fas fa-paper-plane"></i>Delivery</h4>
            <div class="r-report-summary-delivery">
              <div class="r-report-summary-field">
                <span>Email sent</span>
                <strong>${escapeHtml(delivery.sentAtLabel)}</strong>
              </div>
              ${delivery.to ? `<div class="r-report-summary-field"><span>Recipient</span><strong>${escapeHtml(delivery.to)}</strong></div>` : ''}
              <div class="r-report-summary-field">
                <span>CC</span>
                <div class="r-report-summary-cc">${delivery.cc.length ? delivery.cc.map((email) => `<b>${escapeHtml(email)}</b>`).join('') : '<strong>None</strong>'}</div>
              </div>
              <div class="r-report-summary-field">
                <span>Technician notes</span>
                ${delivery.notes ? `<div class="r-report-summary-notes">${escapeHtml(delivery.notes)}</div>` : '<strong>None</strong>'}
              </div>
            </div>
          </section>
          ${measurementsSection}
        </div>
      </div>
    `;
  }

  function downloadMeasurementsCsv(projectId = activeMeasurementProjectId(), cachedAssets = {}){
    if (!reportOrderIsCompleteLike()) return;
    const metricKey = reportSummaryMetricCacheKey(projectId, cachedAssets?.xmlUrl || '');
    const xmlMetrics = metricKey ? measurementSummaryMetricCache.get(metricKey) : null;
    const metrics = reportSummaryMetricRows(xmlMetrics || []);
    if (!metrics.length) {
      showToast('No measurements to download', 'Measurements are not available for this report yet.', false);
      return;
    }
    downloadTextFile(
      reportSummaryMeasurementsCsv(metrics),
      reportSummaryCsvFileName(projectId),
      'text/csv;charset=utf-8'
    );
  }

  function xmlDownloadFileName(projectId = activeMeasurementProjectId()){
    return `model_${String(projectId || activeBaseProject?.id || '').slice(0, 12) || 'data'}.xml`;
  }

  function xmlDownloadPanelHtml(url){
    const disabled = url ? '' : ' disabled';
    return `
      <div class="r-report-pending">
        <div class="r-report-pending-card">
          <i class="fas fa-code"></i>
          <h3>XML Model</h3>
          <button type="button" class="r-pending-action" data-download-xml${disabled}>
            Download XML Model
            <span>model_data.xml</span>
          </button>
        </div>
      </div>`;
  }

  async function downloadXmlModel(url, projectId = activeMeasurementProjectId()){
    if (!url) return;
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error(`XML download failed (${response.status})`);
      const blob = await response.blob();
      const objUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objUrl;
      link.download = xmlDownloadFileName(projectId);
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(objUrl);
        link.remove();
      }, 1000);
    } catch (error) {
      showToast('Could not download XML', error?.message || 'Please try again.', false);
    }
  }

  function weatherApiUrl(path = ''){
    const text = String(path || '').trim();
    if (/^https?:\/\//i.test(text)) return text;
    const suffix = text.replace(/^\/?v1\/weather\/?/i, '').replace(/^\/+/, '');
    const base = String(window.PlatformAPI?.baseUrl?.() || window.FirstMeasureAPI?.baseUrl?.() || '').replace(/\/+$/, '');
    const root = base
      ? base.replace(/\/v1\/(?:platform|firstmeasure)$/i, '/v1/weather')
      : `${location.origin.replace(/\/+$/, '')}/v1/weather`;
    return `${root.replace(/\/+$/, '')}/${suffix}`;
  }

  function weatherReportInfo(){
    const measurement = reportOrderMeasurement();
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    const projectId = activeMeasurementProjectId();
    const id = String(
      reportOrderState?.weatherReportId
      || measurement.weather_report_id
      || manifest.weather_report_id
      || activeBaseProject?.weather_report_id
      || ''
    ).trim();
    const storedUrl = String(
      reportOrderState?.weatherReportPdfUrl
      || measurement.weather_report_pdf_url
      || manifest.weather_report_pdf_url
      || activeBaseProject?.weather_report_pdf_url
      || ''
    ).trim();
    const status = String(
      measurement.weather_report_status
      || manifest.weather_report_status
      || activeBaseProject?.weather_report_status
      || ''
    ).trim().toLowerCase();
    const error = String(
      measurement.weather_report_error
      || manifest.weather_report_error
      || activeBaseProject?.weather_report_error
      || ''
    ).trim();
    const ordered = !!(
      (projectId && (
        reportOrderState?.includeWeather
        || measurement.include_weather_report
        || manifest.include_weather_report
        || activeBaseProject?.include_weather_report
      ))
      || id
      || storedUrl
    );
    const url = storedUrl ? weatherApiUrl(storedUrl) : (id ? weatherApiUrl(`reports/${encodeURIComponent(id)}/pdf`) : '');
    return { ordered, id, url, status, error };
  }

  function weatherReportStructureCount(){
    const count = reportRequestExistingPins().length || pinCount();
    return Math.max(1, Number(count) || 1);
  }

  function weatherReportTotalPrice(){
    return Math.round(WEATHER_REPORT_ADDON * weatherReportStructureCount() * 100) / 100;
  }

  function weatherReportOrderButtonHtml(){
    const total = weatherReportTotalPrice();
    return `Add for $${escapeHtml(fmtMoney(total))}<span>Delivered with this project</span>`;
  }

  function weatherReportPanelHtml(){
    if (!weatherReportsEnabled()) {
      return pendingReportHtml('weather');
    }
    const info = weatherReportInfo();
    if (info.url) return reportFrameHtml(info.url);
    if (info.status === 'failed') {
      return `
        <div class="r-report-pending">
          <div class="r-report-pending-card">
            <i class="fas fa-circle-exclamation"></i>
            <h3>Weather Report Failed</h3>
            <p>${escapeHtml(info.error || 'The weather report could not be generated. You can try again from here.')}</p>
            <div class="r-pending-actions">
              <button type="button" class="r-pending-action" data-order-weather-report>Try again<span>No additional charge</span></button>
            </div>
          </div>
        </div>`;
    }
    if (info.ordered) {
      const waitingOnReport = !reportOrderIsCompleteLike();
      return `
        <div class="r-report-pending">
          <div class="r-report-pending-card">
            <i class="fas ${waitingOnReport ? 'fa-clock' : 'fa-circle-notch fa-spin'}"></i>
            <h3>Historical Weather Report</h3>
            <p>${escapeHtml(waitingOnReport
              ? 'The weather report is ordered and will generate after the FirstMeasure report is complete.'
              : 'The historical severe-weather report is generating. It will appear here when it is ready.')}</p>
            <div class="r-pending-actions">
              <button type="button" class="r-pending-action" data-check-weather-report>Check status<span>Refresh this tab</span></button>
            </div>
          </div>
        </div>`;
    }
    return `
      <div class="r-report-pending">
        <div class="r-report-pending-card">
          <i class="fas fa-cloud-bolt"></i>
          <h3>Add Historical Weather</h3>
          <p>Add a property-specific history of hail, wind, and tornado events with nearby event records and map-style exhibits.</p>
          <div class="r-pending-actions">
            <button type="button" class="r-pending-action" data-order-weather-report>${weatherReportOrderButtonHtml()}</button>
          </div>
        </div>
      </div>`;
  }

  function clearWeatherReportPoll(){
    if (weatherReportPollTimer) clearTimeout(weatherReportPollTimer);
    weatherReportPollTimer = null;
  }

  function markWeatherReportOrderedLocally(status = 'processing'){
    mergeReportManifestIntoActiveProject({
      include_weather_report: true,
      weather_report_tier: 'history',
      weather_report_status: status,
      weather_report_error: ''
    });
  }

  async function refreshWeatherReportState(projectId){
    if (!projectId || !fmJson) return null;
    const data = await fmJson(`projects/${encodeURIComponent(projectId)}`);
    const manifest = (data?.project?.manifest && typeof data.project.manifest === 'object') ? data.project.manifest : {};
    if (Object.keys(manifest).length && activeMeasurementProjectId() === projectId) {
      mergeReportManifestIntoActiveProject(manifest);
    }
    return manifest;
  }

  function scheduleWeatherReportPoll(projectId = activeMeasurementProjectId(), delay = 3500){
    clearWeatherReportPoll();
    const info = weatherReportInfo();
    if (!projectId || !info.ordered || info.url || info.status === 'failed') return;
    weatherReportPollTimer = setTimeout(async () => {
      weatherReportPollTimer = null;
      try {
        await refreshWeatherReportState(projectId);
        weatherReportPollAttempt += 1;
        if (activePreviewTab === 'measurements') renderMeasurementsPanel();
      } catch (_) {
        weatherReportPollAttempt += 1;
      }
      const next = weatherReportInfo();
      if (next.ordered && !next.url && next.status !== 'failed') {
        const nextDelay = Math.min(30000, 3500 + weatherReportPollAttempt * 1500);
        scheduleWeatherReportPoll(projectId, nextDelay);
      } else {
        weatherReportPollAttempt = 0;
      }
    }, delay);
  }

  async function checkWeatherReportStatus(button){
    const projectId = activeMeasurementProjectId();
    if (!projectId) return;
    const original = button?.innerHTML || 'Check status<span>Refresh this tab</span>';
    if (button) {
      button.disabled = true;
      button.innerHTML = 'Checking...';
    }
    try {
      await refreshWeatherReportState(projectId);
      renderMeasurementsPanel();
      const info = weatherReportInfo();
      if (info.url) {
        showToast('Weather report ready', 'The historical weather report is ready.', true);
      } else if (info.status === 'failed') {
        showToast('Weather report failed', info.error || 'The weather report could not be generated.', false);
      } else {
        scheduleWeatherReportPoll(projectId, 3500);
      }
    } catch (error) {
      showToast('Could not check weather', error?.message || 'Please try again.', false);
    } finally {
      if (button && document.body.contains(button)) {
        button.disabled = false;
        button.innerHTML = original;
      }
    }
  }

  async function orderWeatherReport(button){
    if (!weatherReportsEnabled()) {
      showToast('Weather reports unavailable', 'Historical weather reports are not enabled for this account.', false);
      return;
    }
    const projectId = activeMeasurementProjectId();
    if (!projectId) {
      showToast('Order the roof report first', 'Weather can be added after a report order exists.', false);
      return;
    }
    const weatherChargeAmount = weatherReportTotalPrice();
    const creditOk = await ensureCreditsForPurchase(weatherChargeAmount, 'the historical weather report', 'weather_credit_gate');
    if (!creditOk) return;
    const wasOrdered = weatherReportInfo().ordered;
    const original = button?.innerHTML || weatherReportOrderButtonHtml();
    markWeatherReportOrderedLocally('processing');
    activeMeasurementTab = 'weather';
    renderMeasurementsPanel();
    syncProjectViewerTabs();
    scheduleWeatherReportPoll(projectId, 2500);
    try {
      const data = await fmPost(`projects/${encodeURIComponent(projectId)}/weather/order`, { actor: currentActor?.() || {}, structure_count: weatherReportStructureCount() });
      if (!data?.success) throw new Error(data?.error || data?.message || 'Could not order the weather report.');
      if (data.manifest) mergeReportManifestIntoActiveProject(data.manifest);
      if (data.weather_report_id || data.weather_report_pdf_url) {
        const patch = {
          include_weather_report: true,
          weather_report_id: data.weather_report_id || '',
          weather_report_pdf_url: data.weather_report_pdf_url || ''
        };
        mergeReportManifestIntoActiveProject(patch);
      }
      activeMeasurementTab = 'weather';
      showToast('Weather report ordered', data.charged_amount ? `$${fmtMoney(data.charged_amount)} charged to credits.` : 'The weather report is ready.', true);
      window.Portal.credits.refreshCredits().catch(() => null);
      window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
      renderMeasurementsPanel();
      syncProjectViewerTabs();
      scheduleWeatherReportPoll(projectId, 2500);
    } catch (error) {
      if (!wasOrdered) {
        mergeReportManifestIntoActiveProject({
          include_weather_report: false,
          weather_report_tier: '',
          weather_report_status: '',
          weather_report_error: '',
          weather_report_id: '',
          weather_report_pdf_url: ''
        });
        renderMeasurementsPanel();
        syncProjectViewerTabs();
      }
      const credit = creditErrorDetails(error);
      if (credit.isCreditError) {
        openCreditTopupForPurchase({
          label: 'the historical weather report',
          required: credit.required || weatherChargeAmount,
          balance: credit.balance,
          context: 'weather_credit_reject'
        });
      } else {
        showToast('Could not order weather', error?.message || 'Please try again.', false);
      }
      if (button && document.body.contains(button)) {
        button.disabled = false;
        button.innerHTML = original;
      }
    }
  }

  function reportRequestProjectType(){
    return selectedType || activeBaseProject?.project_type || reportOrderMeasurement().project_type || 'residential';
  }

  function reportChangeRequests(){
    const measurement = reportOrderMeasurement();
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    const sources = [
      activeBaseProject?.report_change_requests,
      measurement.report_change_requests,
      manifest.report_change_requests
    ];
    const byId = new Map();
    sources.forEach((source) => {
      if (!Array.isArray(source)) return;
      source.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        const id = String(entry.id || entry.request_id || `idx_${index}`).trim();
        byId.set(id, { ...entry, id });
      });
    });
    return Array.from(byId.values()).sort((a, b) => {
      const at = Date.parse(a.created_at || a.submitted_at || '') || 0;
      const bt = Date.parse(b.created_at || b.submitted_at || '') || 0;
      return bt - at;
    });
  }

  function reportRequestsAreSupportOnly(requests){
    return Array.isArray(requests)
      && requests.length > 0
      && requests.every((request) => String(request?.type || request?.request_type || '').trim().toLowerCase() === 'report_issue');
  }

  function reportChangeRequestLabel(type){
    const normalized = String(type || '').trim().toLowerCase();
    if (normalized === 'report_issue') return 'Reported issue';
    if (normalized === 'additional_structure') return 'Additional structure';
    return 'Change or correction';
  }

  function reportChangeRequestStatusText(request){
    const type = String(request?.type || request?.request_type || '').trim().toLowerCase();
    const status = String(request?.status || '').trim().toLowerCase();
    if (type === 'report_issue') return 'Sent to support';
    if (status === 'approved') return 'Approved';
    if (status === 'rejected') return 'Rejected';
    if (status === 'completed' || status === 'complete') return 'Completed';
    return 'Waiting for review';
  }

  function reportChangesPanelHtml(){
    const requests = reportChangeRequests();
    const supportOnly = reportRequestsAreSupportOnly(requests);
    if (!requests.length) {
      return `
        <div class="r-report-changes">
          <div class="r-report-support-empty">
            <div class="r-report-support-empty-card">
              <i class="fas fa-headset"></i>
              <h3>Support</h3>
              <p>Need help with this report? Send a support request and attach photos if they help explain the issue.</p>
              <button type="button" class="r-report-support-request" data-open-support-request><i class="fas fa-message"></i> Request Support</button>
            </div>
          </div>
        </div>`;
    }
    return `
      <div class="r-report-changes">
        <div class="r-report-changes-head">
          <div>
            <h3>${supportOnly ? 'Support' : 'Changes Pending'}</h3>
            <p>${supportOnly ? 'Your support messages for this returned report are listed here.' : 'Your returned report stays available while these requests are reviewed.'}</p>
          </div>
          <button type="button" class="r-report-support-request" data-open-support-request><i class="fas fa-message"></i> Request Support</button>
        </div>
        <div class="r-report-change-list">
          ${requests.map((request) => {
            const type = String(request.type || request.request_type || '').trim().toLowerCase();
            const isIssue = type === 'report_issue';
            const pins = Array.isArray(request.pins) ? request.pins.length : 0;
            const photos = Array.isArray(request.photos) ? request.photos.length : 0;
            const charge = Number(request.charged_amount || 0) || 0;
            const created = request.created_at ? formatDate(request.created_at) : '';
            const expedite = normalizeReportExpediteKey(request.report_expedite_option || '') !== 'standard_3_6';
            return `
              <div class="r-report-change-card">
                <div class="r-report-change-top">
                  <div>
                    <div class="r-report-change-title">${escapeHtml(request.label || reportChangeRequestLabel(type))}</div>
                    <div class="r-report-change-meta">${created ? `Submitted ${escapeHtml(created)}` : 'Submitted'}</div>
                  </div>
                  <span class="r-report-change-status"><i class="fas ${isIssue ? 'fa-envelope' : 'fa-screwdriver-wrench'}"></i>${escapeHtml(reportChangeRequestStatusText(request))}</span>
                </div>
                ${request.notes ? `<div class="r-report-change-notes">${escapeHtml(request.notes)}</div>` : ''}
                <div class="r-report-change-facts">
                  ${isIssue ? '<span><i class="fas fa-circle-info"></i>Support will reach out if needed</span>' : '<span><i class="fas fa-clock"></i>Waiting for review</span>'}
                  ${pins ? `<span><i class="fas fa-location-dot"></i>${pins} pin${pins === 1 ? '' : 's'}</span>` : ''}
                  ${photos ? `<span><i class="fas fa-image"></i>${photos} photo${photos === 1 ? '' : 's'}</span>` : ''}
                  ${charge > 0 ? `<span><i class="fas fa-credit-card"></i>$${escapeHtml(fmtMoney(charge))} charged</span>` : '<span><i class="fas fa-dollar-sign"></i>No charge</span>'}
                  ${expedite ? '<span><i class="fas fa-bolt"></i>Rushed</span>' : ''}
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  function ensureReportSummaryPane(){
    const body = measureBody();
    if (!body) return null;
    let pane = body.querySelector('[data-measure-pane="summary"]');
    if (!measurementReportSummaryEnabled()) {
      pane?.remove();
      return null;
    }
    if (!pane) {
      pane = document.createElement('div');
      pane.className = 'r-measure-pane';
      pane.dataset.measurePane = 'summary';
      pane.innerHTML = '<div id="rMeasurementSummary" style="height:100%"></div>';
      body.insertBefore(pane, body.firstChild);
    }
    return pane.querySelector('#rMeasurementSummary');
  }

  function ensureInlineProjectMapPane(){
    const body = measureBody();
    if (!body) return null;
    let pane = body.querySelector('[data-measure-pane="map"]');
    if (!inlineProjectMapWithReports()) {
      pane?.remove();
      return null;
    }
    if (!pane) {
      pane = document.createElement('div');
      pane.className = 'r-measure-pane';
      pane.dataset.measurePane = 'map';
      pane.innerHTML = '<div id="rMeasurementMap" style="height:100%"></div>';
      body.insertBefore(pane, body.firstChild);
    }
    return pane.querySelector('#rMeasurementMap');
  }

  function ensureReportChangesPane(){
    const body = measureBody();
    if (!body) return null;
    let pane = body.querySelector('[data-measure-pane="changes"]');
    if (!reportFollowupEnabled()) {
      pane?.remove();
      return null;
    }
    if (!pane) {
      pane = document.createElement('div');
      pane.className = 'r-measure-pane';
      pane.dataset.measurePane = 'changes';
      pane.innerHTML = '<div id="rMeasurementChanges" style="height:100%"></div>';
      body.appendChild(pane);
    }
    return pane.querySelector('#rMeasurementChanges');
  }

  function reportHasReturnedAssets(cachedAssets){
    if (reportOrderReleaseHoldIsActive()) return false;
    return !reportOrderIsCancelled() && !reportOrderIsRejected() && !!(cachedAssets?.reportUrl || cachedAssets?.summaryUrl || reportOrderState?.hasReadyReport);
  }

  function renderReportFollowupButton(cachedAssets){
    const body = measureBody();
    if (!body) return;
    const buttons = Array.from(body.querySelectorAll('.r-report-followup-open'));
    let button = buttons[0] || null;
    buttons.slice(1).forEach((duplicate) => duplicate.remove());
    if (!reportFollowupEnabled()) {
      buttons.forEach((node) => node.remove());
      return;
    }
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'r-report-followup-open';
      button.innerHTML = '<i class="fas fa-headset"></i><span>Support</span>';
      body.appendChild(button);
    }
    const visible = !!activeMeasurementProjectId();
    button.classList.toggle('visible', visible);
    button.onclick = visible ? openReportRequestModal : null;
  }

  function reportRequestExistingPins(){
    const basePins = normalizeProjectPins(activeBaseProject || {});
    const measurement = reportOrderMeasurement();
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    const manifestPins = normalizeProjectPins(manifest);
    const pins = basePins.length ? basePins : manifestPins;
    const seen = new Set();
    return pins.filter((pin) => {
      const key = `${Number(pin.lat).toFixed(7)},${Number(pin.lng).toFixed(7)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function reportRequestNewPins(){
    const pins = Array.isArray(reportRequestModalState?.newPins) ? reportRequestModalState.newPins : [];
    return pins.map((pin) => {
      const lat = finiteCoord(pin?.lat);
      const lng = finiteCoord(pin?.lng);
      return lat != null && lng != null ? { lat, lng } : null;
    }).filter(Boolean);
  }

  function reportRequestStructureCount(){
    return reportRequestNewPins().length;
  }

  function syncReportRequestStructureCount(){
    if (!reportRequestModalState) return;
    reportRequestModalState.structureCount = reportRequestNewPins().length;
  }

  function reportRequestChargeEstimate(){
    if (!reportRequestModalState || reportRequestModalState.type !== 'additional_structure') return 0;
    const type = reportRequestProjectType();
    if (!isPerStructureType(type)) return 0;
    if (reportRequestStructureCount() <= 0) return 0;
    const key = reportExpediteOptionsEnabled()
      ? normalizeReportExpediteKey(reportRequestModalState.expedite || 'standard_3_6')
      : 'standard_3_6';
    const option = reportExpediteOption(key) || defaultReportExpediteOption();
    const unit = Number(option?.unit_price ?? reportExpediteUnitPrice(option, type)) || TYPE_META[type]?.price || PRICE_COMMERCIAL;
    const gross = unit * reportRequestStructureCount();
    if (option?.expedited && freeExpediteUses() > 0) {
      const standard = reportExpediteOption('standard_3_6') || defaultReportExpediteOption();
      const standardUnit = Number(standard?.unit_price ?? reportExpediteUnitPrice(standard, type)) || TYPE_META[type]?.price || PRICE_COMMERCIAL;
      const discount = Math.max(0, unit - standardUnit) * reportRequestStructureCount();
      return Math.round(Math.max(0.01, gross - discount) * 100) / 100;
    }
    return Math.round(gross * 100) / 100;
  }

  function reportRequestExpediteOptions(){
    if (!reportExpediteOptionsEnabled()) {
      return (reportExpediteOptions.length ? reportExpediteOptions : buildLocalReportExpediteOptions(reportRequestProjectType()))
        .filter((option) => option.key === 'standard_3_6');
    }
    const type = reportRequestProjectType();
    return (reportExpediteOptions.length ? reportExpediteOptions : buildLocalReportExpediteOptions(type))
      .filter((option) => option.key === 'standard_3_6' || option.key === 'rush_under_1' || option.key === 'rush_1_3');
  }

  function fitReportRequestMap(requestMap, pins){
    if (!requestMap || !window.google?.maps) return;
    if (pins.length > 1) {
      const bounds = new google.maps.LatLngBounds();
      pins.forEach((pin) => bounds.extend(pin));
      requestMap.fitBounds(bounds, 70);
      return;
    }
    if (pins.length === 1) {
      requestMap.setCenter(pins[0]);
      requestMap.setZoom(20);
      return;
    }
    const lat = finiteCoord(activeBaseProject?.lat ?? activeBaseProject?.latitude ?? $('#rLat')?.value);
    const lng = finiteCoord(activeBaseProject?.lng ?? activeBaseProject?.longitude ?? $('#rLng')?.value);
    if (lat != null && lng != null) {
      requestMap.setCenter({ lat, lng });
      requestMap.setZoom(19);
    }
  }

  function updateReportRequestModalDynamicUi(){
    if (!reportRequestModalState?.overlay) return;
    const overlay = reportRequestModalState.overlay;
    const newPins = reportRequestNewPins();
    syncReportRequestStructureCount();
    const charge = reportRequestChargeEstimate();
    const freeRush = reportRequestModalState.type === 'additional_structure'
      && isPerStructureType(reportRequestProjectType())
      && normalizeReportExpediteKey(reportRequestModalState.expedite) !== 'standard_3_6'
      && freeExpediteUses() > 0;
    const countText = String(reportRequestStructureCount());
    overlay.querySelectorAll('[data-followup-new-count]').forEach((node) => { node.textContent = countText; });
    const countDisplay = overlay.querySelector('[data-followup-count-display]');
    if (countDisplay) countDisplay.textContent = countText;
    const price = overlay.querySelector('[data-followup-price]');
    if (price) price.textContent = charge > 0 ? `$${fmtMoney(charge)}` : '';
    const submit = overlay.querySelector('.r-report-followup-submit');
    if (submit && submit.dataset.submitting !== '1') {
      submit.disabled = reportRequestModalState.type === 'additional_structure' && !newPins.length;
      submit.textContent = charge > 0 ? `Submit - $${fmtMoney(charge)}` : 'Submit';
    }
    const clear = overlay.querySelector('[data-followup-clear-new-pins]');
    if (clear) clear.disabled = !newPins.length;
    const note = overlay.querySelector('[data-followup-pin-note]');
    if (note) {
      note.textContent = `Click the map to place each additional structure. Existing structures are shown in gray and cannot be moved.${newPins.length ? ` ${newPins.length} new pin${newPins.length === 1 ? '' : 's'} will be attached.` : ''}${freeRush ? ` Free expedite applied. ${freeExpediteUses()} free expedite use${freeExpediteUses() === 1 ? '' : 's'} available.` : ''}`;
    }
  }

  function setupReportRequestMap(){
    const mount = document.getElementById('rReportFollowupMap');
    if (!mount || !reportRequestModalState || reportRequestModalState.type !== 'additional_structure') return;
    if (!window.google?.maps?.Map || !window.google?.maps?.Marker) {
      mount.innerHTML = '<div class="r-report-pending"><div class="r-report-pending-card"><i class="fas fa-location-dot"></i><h3>Map unavailable</h3><p>Google Maps is still loading. Close and reopen this request in a moment.</p></div></div>';
      return;
    }
    const existingPins = reportRequestExistingPins();
    const newPins = reportRequestNewPins();
    const requestMap = new google.maps.Map(mount, {
      center: existingPins[0] || newPins[0] || { lat: 39.8283, lng: -98.5795 },
      zoom: existingPins.length || newPins.length ? 20 : 4,
      mapTypeId: 'hybrid',
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
    const iconSize = { scaledSize: new google.maps.Size(42, 56), anchor: new google.maps.Point(21, 54) };
    const oldIcon = {
      ...iconSize,
      url: buildPinIcon({ fill: '#64748b', stroke: '#ffffff', glyph: '#ffffff', opacity: .88 })
    };
    const newIcon = {
      ...iconSize,
      url: buildPinIcon({ fill: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#d93025' })
    };
    existingPins.forEach((pin, index) => {
      new google.maps.Marker({
        map: requestMap,
        position: pin,
        draggable: false,
        clickable: false,
        icon: oldIcon,
        title: `Existing structure ${index + 1}`
      });
    });
    const removeNewMarker = (index) => {
      const marker = reportRequestModalState.requestMapMarkers?.[index];
      if (marker) marker.setMap(null);
      reportRequestModalState.ignoreNextMapClickUntil = Date.now() + 180;
      reportRequestModalState.newPins.splice(index, 1);
      reportRequestModalState.requestMapMarkers = [];
      setupReportRequestMapMarkers(requestMap, newIcon);
      updateReportRequestModalDynamicUi();
    };
    const setupReportRequestMapMarkers = (targetMap, icon) => {
      (reportRequestModalState.requestMapMarkers || []).forEach((marker) => marker.setMap(null));
      reportRequestModalState.requestMapMarkers = reportRequestNewPins().map((pin, index) => {
        const marker = new google.maps.Marker({
          map: targetMap,
          position: pin,
          draggable: true,
          icon,
          title: 'New requested structure. Drag to reposition. Click to remove.'
        });
        marker.addListener('click', (event) => {
          event?.domEvent?.stopPropagation?.();
          removeNewMarker(index);
        });
        marker.addListener('dragend', () => {
          const pos = marker.getPosition();
          if (pos) reportRequestModalState.newPins[index] = { lat: pos.lat(), lng: pos.lng() };
          updateReportRequestModalDynamicUi();
        });
        return marker;
      });
    };
    setupReportRequestMapMarkers(requestMap, newIcon);
    reportRequestModalState.requestMap = requestMap;
    requestMap.addListener('click', (event) => {
      if (!event?.latLng) return;
      if (Date.now() < (Number(reportRequestModalState.ignoreNextMapClickUntil) || 0)) return;
      const index = reportRequestNewPins().length;
      reportRequestModalState.newPins = reportRequestNewPins().concat([{ lat: event.latLng.lat(), lng: event.latLng.lng() }]);
      const marker = new google.maps.Marker({
        map: requestMap,
        position: event.latLng,
        draggable: true,
        icon: newIcon,
        title: 'New requested structure. Drag to reposition. Click to remove.'
      });
      marker.addListener('click', (markerEvent) => {
        markerEvent?.domEvent?.stopPropagation?.();
        removeNewMarker(index);
      });
      marker.addListener('dragend', () => {
        const pos = marker.getPosition();
        if (pos) reportRequestModalState.newPins[index] = { lat: pos.lat(), lng: pos.lng() };
        updateReportRequestModalDynamicUi();
      });
      reportRequestModalState.requestMapMarkers = (reportRequestModalState.requestMapMarkers || []).concat([marker]);
      updateReportRequestModalDynamicUi();
    });
    fitReportRequestMap(requestMap, existingPins.concat(newPins));
    setTimeout(() => {
      try {
        google.maps.event.trigger(requestMap, 'resize');
        fitReportRequestMap(requestMap, reportRequestExistingPins().concat(reportRequestNewPins()));
      } catch (e) {}
    }, 60);
  }

  function closeReportRequestModal(){
    reportRequestModalState?.handle?.unregister?.();
    reportRequestModalState?.overlay?.remove?.();
    reportRequestModalState = null;
  }

  function reportRequestModalTypeMeta(type){
    if (type === 'report_issue') return { title: 'Report an issue', icon: 'fa-circle-exclamation', note: 'This sends a support message to FirstMeasure.' };
    if (type === 'additional_structure') return { title: 'Request an additional structure', icon: 'fa-location-dot', note: 'Place the additional structure on the map. Commercial and multifamily requests are billed per added structure.' };
    return { title: 'Request a change or correction', icon: 'fa-pen-to-square', note: 'Add notes and photos for the correction team.' };
  }

  function refreshReportRequestModal(){
    if (!reportRequestModalState?.overlay) return;
    const overlay = reportRequestModalState.overlay;
    const type = reportRequestModalState.type;
    const meta = reportRequestModalTypeMeta(type);
    const projectType = reportRequestProjectType();
    const isAdditional = type === 'additional_structure';
    const charge = reportRequestChargeEstimate();
    const showRush = isAdditional && isPerStructureType(projectType) && reportExpediteOptionsEnabled();
    const existingPins = reportRequestExistingPins();
    const newPins = reportRequestNewPins();
    const freeRush = showRush && normalizeReportExpediteKey(reportRequestModalState.expedite) !== 'standard_3_6' && freeExpediteUses() > 0;
    overlay.innerHTML = `
      <div class="r-report-followup-card${isAdditional ? ' is-additional' : ''}" role="dialog" aria-modal="true" aria-label="Support">
        <div class="r-report-followup-top">
          <div>
            <h3>Support</h3>
            <p>${escapeHtml(meta.note)}</p>
          </div>
          <button type="button" class="r-report-followup-close" data-report-followup-close aria-label="Close"><i class="fas fa-times"></i></button>
        </div>
        <div class="r-report-followup-types">
          ${['change_correction','additional_structure','report_issue'].map((key) => {
            const item = reportRequestModalTypeMeta(key);
            return `
              <button type="button" class="r-report-followup-type${key === type ? ' active' : ''}" data-followup-type="${escapeHtml(key)}">
                <i class="fas ${escapeHtml(item.icon)}"></i>
                <strong>${escapeHtml(item.title)}</strong>
                <span>${key === 'report_issue' ? 'Support message' : (key === 'additional_structure' ? 'Adds a rework request' : 'Free rework request')}</span>
              </button>`;
          }).join('')}
        </div>
        <form class="r-report-followup-form${isAdditional ? ' is-additional' : ''}" data-report-followup-form>
          <div class="r-report-followup-field">
            <label for="rReportFollowupNotes">Details</label>
            <textarea id="rReportFollowupNotes" rows="6" placeholder="${escapeHtml(meta.title)}">${escapeHtml(reportRequestModalState.notes || '')}</textarea>
          </div>
          <div class="r-report-followup-field">
            <label for="rReportFollowupPhotos">Photos</label>
            <input id="rReportFollowupPhotos" type="file" accept="image/*" multiple>
          </div>
          ${isAdditional ? `
            <div class="r-report-followup-field r-report-followup-map-field">
              <label>Structures</label>
              <div class="r-report-followup-map-wrap">
                <div class="r-report-followup-map" id="rReportFollowupMap"></div>
                <div class="r-report-followup-map-foot">
                  <div class="r-report-followup-map-legend">
                    <span class="old"><i></i>${existingPins.length} existing locked</span>
                    <span class="new"><i></i><span data-followup-new-count>${newPins.length}</span> new requested</span>
                  </div>
                  <button type="button" class="r-report-followup-map-clear" data-followup-clear-new-pins ${newPins.length ? '' : 'disabled'}>Clear new pins</button>
                </div>
              </div>
            </div>
            <div class="r-report-followup-grid">
              <div class="r-report-followup-field">
                <label>Additional structures</label>
                <div class="r-report-followup-count-display" data-followup-count-display>${escapeHtml(String(reportRequestStructureCount()))}</div>
              </div>
              <div class="r-report-followup-summary">
                <span>${escapeHtml(TYPE_META[projectType]?.label || projectType)} request</span>
                <strong data-followup-price>${charge > 0 ? `$${escapeHtml(fmtMoney(charge))}` : ''}</strong>
              </div>
            </div>
            ${showRush ? `
              <div class="r-report-followup-field">
                <label>Delivery</label>
                <div class="r-report-followup-expedite">
                  ${reportRequestExpediteOptions().map((option) => {
                    const selected = normalizeReportExpediteKey(reportRequestModalState.expedite) === option.key;
                    const window = reportExpediteCustomerPromiseLabel(option);
                    return `<button type="button" class="${selected ? 'active' : ''}" data-followup-expedite="${escapeHtml(option.key)}">${escapeHtml(option.key === 'standard_3_6' ? 'Standard' : reportExpediteDurationLabel(option))}<span>${escapeHtml(window)} · ${escapeHtml(reportExpediteDeltaLabel(option, projectType))} each</span></button>`;
                  }).join('')}
                </div>
              </div>` : ''}
            <div class="r-report-followup-note" data-followup-pin-note>Click the map to place each additional structure. Existing structures are shown in gray and cannot be moved.${newPins.length ? ` ${newPins.length} new pin${newPins.length === 1 ? '' : 's'} will be attached.` : ''}${freeRush ? ` Free expedite applied. ${freeExpediteUses()} free expedite use${freeExpediteUses() === 1 ? '' : 's'} available.` : ''}</div>` : ''}
          <div class="r-report-followup-error" id="rReportFollowupError"></div>
          <div class="r-report-followup-actions">
            <button type="button" class="r-report-followup-secondary" data-report-followup-close>Cancel</button>
            <button type="submit" class="r-report-followup-submit" ${isAdditional && !newPins.length ? 'disabled' : ''}>${charge > 0 ? `Submit - $${escapeHtml(fmtMoney(charge))}` : 'Submit'}</button>
          </div>
        </form>
      </div>`;

    overlay.querySelectorAll('[data-report-followup-close]').forEach((button) => {
      button.addEventListener('click', closeReportRequestModal);
    });
    let downOnBackdrop = false;
    overlay.onmousedown = (event) => {
      downOnBackdrop = event.target === overlay;
    };
    overlay.onmouseup = (event) => {
      if (downOnBackdrop && event.target === overlay) closeReportRequestModal();
      downOnBackdrop = false;
    };
    overlay.querySelectorAll('[data-followup-type]').forEach((button) => {
      button.addEventListener('click', () => {
        reportRequestModalState.notes = overlay.querySelector('#rReportFollowupNotes')?.value || '';
        reportRequestModalState.type = button.dataset.followupType || 'change_correction';
        if (reportRequestModalState.type === 'additional_structure') reportRequestModalState.expedite = 'standard_3_6';
        refreshReportRequestModal();
      });
    });
    overlay.querySelector('[data-followup-clear-new-pins]')?.addEventListener('click', () => {
      (reportRequestModalState.requestMapMarkers || []).forEach((marker) => marker.setMap(null));
      reportRequestModalState.requestMapMarkers = [];
      reportRequestModalState.newPins = [];
      reportRequestModalState.structureCount = 0;
      updateReportRequestModalDynamicUi();
    });
    overlay.querySelectorAll('[data-followup-expedite]').forEach((button) => {
      button.addEventListener('click', () => {
        reportRequestModalState.expedite = button.dataset.followupExpedite || 'standard_3_6';
        refreshReportRequestModal();
      });
    });
    overlay.querySelector('[data-report-followup-form]')?.addEventListener('submit', submitReportRequestModal);
    setupReportRequestMap();
  }

  function openReportRequestModal(){
    if (!reportFollowupEnabled()) {
      showToast('Report follow-up unavailable', 'Report follow-up requests are not enabled for this account.', false);
      return;
    }
    const projectType = reportRequestProjectType();
    if (reportExpediteOptionsEnabled() && projectType) loadReportExpediteOptions(true);
    const overlay = document.createElement('div');
    overlay.className = 'r-report-followup-modal';
    document.body.appendChild(overlay);
    const handle = window.Portal?.modals?.register?.(overlay, { onClose: closeReportRequestModal });
    reportRequestModalState = {
      overlay,
        handle,
        type: 'change_correction',
        notes: '',
        newPins: [],
        structureCount: 1,
        expedite: 'standard_3_6'
      };
    refreshReportRequestModal();
  }

  function readReportRequestPhotos(input){
    const files = Array.from(input?.files || []).slice(0, 8);
    return Promise.all(files.map((file) => new Promise((resolve, reject) => {
      if (file.size > 3_500_000) {
        reject(new Error(`${file.name} is too large. Please upload photos under 3.5 MB.`));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, type: file.type, data_url: String(reader.result || '') });
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsDataURL(file);
    })));
  }

  function mergeReportReworkResponse(data){
    if (!activeBaseProject || !data?.request) return;
    const request = data.request;
    const manifest = data.manifest && typeof data.manifest === 'object' ? data.manifest : {};
    const currentRequests = reportChangeRequests().filter((entry) => entry.id !== request.id);
    const nextRequests = Array.isArray(manifest.report_change_requests) ? manifest.report_change_requests : [request, ...currentRequests];
    const measurement = activeBaseProject.measurement_project || activeBaseProject.measurement || {};
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const nextManifest = Object.keys(manifest).length ? manifest : { ...(raw.manifest || {}), report_change_requests: nextRequests };
    activeBaseProject.report_change_requests = nextRequests;
    activeBaseProject.latest_report_change_request = request;
    activeBaseProject.status = nextManifest.status || activeBaseProject.status;
    activeBaseProject.workflow_state = nextManifest.status === 'rework_requested' ? 'measurement_rework_requested' : activeBaseProject.workflow_state;
    const nextMeasurement = {
      ...measurement,
      status: nextManifest.status || measurement.status,
      report_change_requests: nextRequests,
      latest_report_change_request: request,
      raw: {
        ...raw,
        manifest: nextManifest
      }
    };
    activeBaseProject.measurement = nextMeasurement;
    activeBaseProject.measurement_project = nextMeasurement;
    if (reportOrderState) {
      reportOrderState.status = nextMeasurement.status || reportOrderState.status;
      reportOrderState.hasReadyReport = true;
    }
    activeMeasurementTab = 'changes';
    persistActiveBaseProject();
  }

  async function submitReportReworkRequestAction(payload){
    const actor = typeof currentActor === 'function' ? currentActor() : {};
    if (typeof platformJson === 'function') {
      return await platformJson('portal-action', {
        method: 'POST',
        body: {
          ...payload,
          action: 'submit_report_rework_request',
          actor,
          actor_email: actor.email || window.__APP?.userEmail || '',
          actor_name: actor.name || window.__APP?.userName || '',
          actor_org_id: actor.organization_id || window.__APP?.userOrgId || '',
          actor_team_id: actor.team_id || window.__APP?.userTeamId || window.__APP?.userBranchId || ''
        }
      });
    }
    const { data } = await postAction('submit_report_rework_request', payload);
    return data;
  }

  async function submitReportRequestModal(event){
    event.preventDefault();
    if (!reportFollowupEnabled()) {
      showToast('Report follow-up unavailable', 'Report follow-up requests are not enabled for this account.', false);
      return;
    }
    const state = reportRequestModalState;
    if (!state?.overlay) return;
    const overlay = state.overlay;
    const errorEl = overlay.querySelector('#rReportFollowupError');
    const submit = overlay.querySelector('.r-report-followup-submit');
    let notes = (overlay.querySelector('#rReportFollowupNotes')?.value || '').trim();
    const additionalStructure = state.type === 'additional_structure';
    if (!notes && !additionalStructure) {
      if (errorEl) {
        errorEl.textContent = 'Please describe what you need.';
        errorEl.classList.add('visible');
      }
      return;
    }
    const projectId = activeMeasurementProjectId();
    if (!projectId) return;
    if (additionalStructure && !reportRequestNewPins().length) {
      if (errorEl) {
        errorEl.textContent = 'Place a pin for the additional structure on the map.';
        errorEl.classList.add('visible');
      }
      return;
    }
    if (!notes && additionalStructure) notes = 'Additional structure requested by pin.';
    const chargeEstimate = additionalStructure ? reportRequestChargeEstimate() : 0;
    if (chargeEstimate > 0) {
      const creditOk = await ensureCreditsForPurchase(chargeEstimate, 'the additional structure request', 'additional_structure_credit_gate');
      if (!creditOk) return;
    }
    const original = submit?.textContent || 'Submit';
    if (submit) {
      submit.disabled = true;
      submit.dataset.submitting = '1';
      submit.textContent = 'Submitting...';
    }
    try {
      const photos = await readReportRequestPhotos(overlay.querySelector('#rReportFollowupPhotos'));
      const payload = {
        project_id: projectId,
        request_type: state.type,
        notes,
        photos: JSON.stringify(photos),
        pins: JSON.stringify(state.type === 'additional_structure' ? reportRequestNewPins() : []),
        structure_count: String(state.type === 'additional_structure' ? reportRequestStructureCount() : 0),
        report_expedite_option: state.type === 'additional_structure' && reportExpediteOptionsEnabled() ? normalizeReportExpediteKey(state.expedite || 'standard_3_6') : 'standard_3_6',
        billing_reason: state.type === 'additional_structure' ? 'additional_structure_request' : '',
        billing_label: state.type === 'additional_structure' ? 'Additional structure request' : '',
        billing_description: state.type === 'additional_structure' ? 'Additional structures added to returned report' : ''
      };
      const data = await submitReportReworkRequestAction(payload);
      if (!data?.success) throw new Error(data?.error || data?.message || 'Could not submit the request.');
      mergeReportReworkResponse(data);
      closeReportRequestModal();
      showToast('Request submitted', data.charged_amount ? `Charged $${fmtMoney(data.charged_amount)} for the additional structure request.` : 'The report follow-up was saved.', true);
      if (data.charged_amount) window.Portal.credits.refreshCredits().catch(() => null);
      renderMeasurementsPanel();
      syncProjectViewerTabs();
      window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    } catch (error) {
      const credit = creditErrorDetails(error);
      if (credit.isCreditError) {
        openCreditTopupForPurchase({
          label: 'the additional structure request',
          required: credit.required || reportRequestChargeEstimate(),
          balance: credit.balance,
          context: 'additional_structure_credit_reject'
        });
      } else if (errorEl) {
        errorEl.textContent = error?.message || 'Could not submit the request.';
        errorEl.classList.add('visible');
      }
      if (submit) {
        delete submit.dataset.submitting;
        submit.disabled = false;
        submit.textContent = original;
        updateReportRequestModalDynamicUi();
      }
    }
  }

  function disposeInstantMeasurement(){
    const instantRoot = $('#rMeasurementInstant');
    if (instantRoot) window.Portal?.instantReports?.dispose?.(instantRoot);
    activeInstantMountKey = '';
  }

  function buildInstantMeasurementProject(projectId){
    const base = activeBaseProject || {};
    const measurement = base.measurement && typeof base.measurement === 'object' ? base.measurement : {};
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const primary = primaryContact();
    return {
      ...base,
      id: projectId || base.id || measurement.id || raw.id,
      project_id: projectId || measurement.project_id || raw.project_id || raw.id,
      folder: projectId || measurement.folder || raw.folder,
      address: base.address || reportOrderState?.address || '',
      resident: primary.name || base.resident || '',
      resident_email: primary.email || base.resident_email || '',
      resident_phone: primary.phone || base.resident_phone || '',
      report_mode: 'both',
      instant_enabled: true,
      instant_only: false,
      measurement: {
        ...measurement,
        id: projectId || measurement.id || raw.id,
        project_id: projectId || measurement.project_id || raw.project_id || raw.id,
        folder: projectId || measurement.folder || raw.folder,
        raw
      }
    };
  }

  function renderInstantMeasurement(projectId){
    const instantRoot = $('#rMeasurementInstant');
    if (!instantRoot) return;
    if (!projectId) {
      disposeInstantMeasurement();
      instantRoot.innerHTML = pendingReportHtml('instant');
      return;
    }
    if (!window.Portal?.instantReports?.mount) {
      instantRoot.innerHTML = pendingReportHtml('instant');
      return;
    }
    if (activeInstantMountKey === projectId && instantRoot.querySelector('#vmInstantPane')) return;
    activeInstantMountKey = projectId;
    const instantProject = buildInstantMeasurementProject(projectId);
    window.Portal.instantReports.mount(instantRoot, instantProject, {
      saveCustomer: async () => ({ draft: collectContacts()[0] || {} })
    });
  }

  async function loadMeasurementAssets(projectId){
    if (!projectId || !fmJson || !fmUrl) return null;
    const cached = measurementAssetCache.get(projectId) || null;
    if (cached?.hasCheckedArtifacts) {
      if (activeMeasurementProjectId() === projectId && (reportOrderReleaseHoldIsActive() || reportOrderIsRejected() || reportOrderIsCancelled())) {
        const next = { ...cached, reportUrl: '', summaryUrl: '', xmlUrl: '' };
        measurementAssetCache.set(projectId, next);
        return next;
      }
      return cached;
    }
    if (measurementAssetLoads.has(projectId)) return null;
    measurementAssetLoads.add(projectId);
    try {
      const data = await fmJson(`projects/${encodeURIComponent(projectId)}`);
      const files = Array.isArray(data?.project?.files) ? data.project.files : [];
      const manifest = (data?.project?.manifest && typeof data.project.manifest === 'object') ? data.project.manifest : {};
      if (manifest && Object.keys(manifest).length && activeMeasurementProjectId() === projectId) {
        mergeReportManifestIntoActiveProject(manifest);
      }
      const names = new Set(files.map((file) => String(file?.name || '')));
      const lowerNames = new Set(files.map((file) => String(file?.name || '').toLowerCase()));
      const status = String(data?.project?.status || data?.project?.manifest?.status || '').toLowerCase();
      const releaseHeld = reportReleaseHoldIsActive(manifest);
      const activeMeasurement = reportOrderMeasurement();
      const activeRaw = activeMeasurement?.raw && typeof activeMeasurement.raw === 'object' ? activeMeasurement.raw : {};
      const rejected = activeMeasurementProjectId() === projectId && isRejectedStatus(
        status,
        manifest.status,
        reportOrderState?.status,
        activeMeasurement.status,
        activeRaw.status
      );
      const cancelled = activeMeasurementProjectId() === projectId && isCancelledStatus(
        status,
        manifest.status,
        reportOrderState?.status,
        activeMeasurement.status,
        activeRaw.status
      );
      const terminalWithoutReport = releaseHeld || rejected || cancelled;
      const reportReturned = isFirstMeasureReturnedReportStatus(status) && !terminalWithoutReport;
      const known = activeMeasurementProjectId() === projectId ? reportOrderKnownAssetUrls() : {};
      const assets = {
        ...cached,
        reportUrl: terminalWithoutReport ? '' : (cached?.reportUrl || known.reportUrl || (reportReturned && (lowerNames.has('report.pdf') || !files.length) ? fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts/Report.pdf`) : '')),
        summaryUrl: terminalWithoutReport ? '' : (cached?.summaryUrl || known.summaryUrl || (reportReturned && (lowerNames.has('summary.pdf') || !files.length) ? fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts/Summary.pdf`) : '')),
        xmlUrl: terminalWithoutReport ? '' : (cached?.xmlUrl || known.xmlUrl || (lowerNames.has('model_data.xml') ? fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts/model_data.xml`) : '')),
        instantPdfUrl: cached?.instantPdfUrl || known.instantPdfUrl || (lowerNames.has('instant report.pdf') ? fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts/Instant%20Report.pdf`) : ''),
        hasInstantPayload: names.has('instant-structures.json') || names.has('insights.json') || names.has('dsm.tif'),
        hasCheckedArtifacts: true,
      };
      measurementAssetCache.set(projectId, assets);
      if (reportOrderState?.ordered && !terminalWithoutReport && (reportReturned || assets.reportUrl || assets.summaryUrl)) {
        reportOrderState.hasReadyReport = true;
      }
      return assets;
    } catch (error) {
      return null;
    } finally {
      measurementAssetLoads.delete(projectId);
    }
  }

  function setActiveMeasurementTab(tab){
    const available = measurementTabs();
    const next = available.find((entry) => entry.id === tab && !entry.disabled) || available.find((entry) => !entry.disabled) || available[0];
    activeMeasurementTab = next?.id || 'standard';
    renderMeasurementsPanel();
  }

  function mergeReportManifestIntoActiveProject(manifest = {}){
    if (!activeBaseProject || !manifest || typeof manifest !== 'object') return;
    const measurement = activeBaseProject.measurement_project || activeBaseProject.measurement || {};
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const currentManifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    manifest = { ...currentManifest, ...manifest };
    const includeWeather = Boolean(
      manifest.include_weather_report
      ?? manifest.weather_report_id
      ?? manifest.weather_report_pdf_url
      ?? measurement.include_weather_report
      ?? measurement.weather_report_id
      ?? measurement.weather_report_pdf_url
      ?? activeBaseProject.include_weather_report
      ?? activeBaseProject.weather_report_id
      ?? activeBaseProject.weather_report_pdf_url
      ?? false
    );
    const isExpedited = Boolean(manifest.is_expedited ?? measurement.is_expedited ?? activeBaseProject.is_expedited ?? false);
    const nextMeasurement = {
      ...measurement,
      status: manifest.status || measurement.status,
      include_weather_report: includeWeather,
      weather_report_tier: manifest.weather_report_tier || measurement.weather_report_tier || 'history',
      weather_report_id: manifest.weather_report_id || measurement.weather_report_id || '',
      weather_report_pdf_url: manifest.weather_report_pdf_url || measurement.weather_report_pdf_url || '',
      weather_report_status: manifest.weather_report_status || measurement.weather_report_status || '',
      weather_report_error: manifest.weather_report_error || measurement.weather_report_error || '',
      weather_report_generated_at: manifest.weather_report_generated_at || measurement.weather_report_generated_at || '',
      is_expedited: isExpedited,
      report_expedite_option: manifest.report_expedite_option || measurement.report_expedite_option || '',
      report_expedite_label: manifest.report_expedite_label || measurement.report_expedite_label || '',
      report_due_window_start: manifest.report_due_window_start || measurement.report_due_window_start || '',
      report_due_window_end: manifest.report_due_window_end || measurement.report_due_window_end || '',
      report_due_window_label: manifest.report_due_window_label || measurement.report_due_window_label || '',
      report_production_deadline_at: manifest.report_production_deadline_at || measurement.report_production_deadline_at || '',
      report_expedite_refund_status: manifest.report_expedite_refund_status || measurement.report_expedite_refund_status || '',
      report_expedite_refund_amount: Number(manifest.report_expedite_refund_amount ?? measurement.report_expedite_refund_amount ?? 0) || 0,
      report_expedite_refund_at: manifest.report_expedite_refund_at || measurement.report_expedite_refund_at || '',
      report_expedite_refund_message: manifest.report_expedite_refund_message || measurement.report_expedite_refund_message || '',
      amount_charged: Number(manifest.amount_charged ?? measurement.amount_charged ?? 0) || 0,
      raw: {
        ...raw,
        manifest
      }
    };
    activeBaseProject.is_expedited = isExpedited;
    activeBaseProject.report_expedite_option = nextMeasurement.report_expedite_option;
    activeBaseProject.report_expedite_label = nextMeasurement.report_expedite_label;
    activeBaseProject.report_due_window_start = nextMeasurement.report_due_window_start;
    activeBaseProject.report_due_window_end = nextMeasurement.report_due_window_end;
    activeBaseProject.report_due_window_label = nextMeasurement.report_due_window_label;
    activeBaseProject.report_production_deadline_at = nextMeasurement.report_production_deadline_at;
    activeBaseProject.report_expedite_refund_status = nextMeasurement.report_expedite_refund_status;
    activeBaseProject.report_expedite_refund_amount = nextMeasurement.report_expedite_refund_amount;
    activeBaseProject.report_expedite_refund_at = nextMeasurement.report_expedite_refund_at;
    activeBaseProject.report_expedite_refund_message = nextMeasurement.report_expedite_refund_message;
    activeBaseProject.amount_charged = nextMeasurement.amount_charged;
    activeBaseProject.include_weather_report = includeWeather;
    activeBaseProject.weather_report_tier = nextMeasurement.weather_report_tier;
    activeBaseProject.weather_report_id = nextMeasurement.weather_report_id;
    activeBaseProject.weather_report_pdf_url = nextMeasurement.weather_report_pdf_url;
    activeBaseProject.weather_report_status = nextMeasurement.weather_report_status;
    activeBaseProject.weather_report_error = nextMeasurement.weather_report_error;
    activeBaseProject.weather_report_generated_at = nextMeasurement.weather_report_generated_at;
    activeBaseProject.status = manifest.status || activeBaseProject.status;
    activeBaseProject.measurement = nextMeasurement;
    activeBaseProject.measurement_project = nextMeasurement;
    if (reportOrderState) {
      reportOrderState.includeWeather = includeWeather;
      reportOrderState.weatherReportId = nextMeasurement.weather_report_id;
      reportOrderState.weatherReportPdfUrl = nextMeasurement.weather_report_pdf_url;
      reportOrderState.isExpedited = isExpedited;
      reportOrderState.reportExpediteOption = nextMeasurement.report_expedite_option;
      reportOrderState.reportDueWindowStart = nextMeasurement.report_due_window_start;
      reportOrderState.reportDueWindowEnd = nextMeasurement.report_due_window_end;
      reportOrderState.reportDueWindowLabel = nextMeasurement.report_due_window_label;
      reportOrderState.reportProductionDeadlineAt = nextMeasurement.report_production_deadline_at;
      reportOrderState.expediteRefundStatus = nextMeasurement.report_expedite_refund_status;
      reportOrderState.expediteRefundAmount = nextMeasurement.report_expedite_refund_amount;
      reportOrderState.expediteRefundAt = nextMeasurement.report_expedite_refund_at;
      reportOrderState.expediteRefundMessage = nextMeasurement.report_expedite_refund_message;
      reportOrderState.amountCharged = nextMeasurement.amount_charged;
    }
    persistActiveBaseProject();
  }

  function snapshotReportExpediteState(){
    const measurement = reportOrderMeasurement();
    return {
      project: activeBaseProject ? {
        is_expedited: activeBaseProject.is_expedited,
        report_expedite_option: activeBaseProject.report_expedite_option,
        report_expedite_label: activeBaseProject.report_expedite_label,
        report_due_window_start: activeBaseProject.report_due_window_start,
        report_due_window_end: activeBaseProject.report_due_window_end,
        report_due_window_label: activeBaseProject.report_due_window_label,
        report_production_deadline_at: activeBaseProject.report_production_deadline_at,
        amount_charged: activeBaseProject.amount_charged
      } : null,
      measurement: measurement && typeof measurement === 'object' ? {
        is_expedited: measurement.is_expedited,
        report_expedite_option: measurement.report_expedite_option,
        report_expedite_label: measurement.report_expedite_label,
        report_due_window_start: measurement.report_due_window_start,
        report_due_window_end: measurement.report_due_window_end,
        report_due_window_label: measurement.report_due_window_label,
        report_production_deadline_at: measurement.report_production_deadline_at,
        amount_charged: measurement.amount_charged
      } : null,
      reportOrderState: reportOrderState ? {
        isExpedited: reportOrderState.isExpedited,
        reportExpediteOption: reportOrderState.reportExpediteOption,
        reportExpediteLabel: reportOrderState.reportExpediteLabel,
        reportDueWindowStart: reportOrderState.reportDueWindowStart,
        reportDueWindowEnd: reportOrderState.reportDueWindowEnd,
        reportDueWindowLabel: reportOrderState.reportDueWindowLabel,
        reportProductionDeadlineAt: reportOrderState.reportProductionDeadlineAt,
        amountCharged: reportOrderState.amountCharged
      } : null
    };
  }

  function restoreReportExpediteState(snapshot){
    if (!snapshot) return;
    const measurement = reportOrderMeasurement();
    if (activeBaseProject && snapshot.project) Object.assign(activeBaseProject, snapshot.project);
    if (measurement && typeof measurement === 'object' && snapshot.measurement) Object.assign(measurement, snapshot.measurement);
    if (reportOrderState && snapshot.reportOrderState) Object.assign(reportOrderState, snapshot.reportOrderState);
  }

  function applyOptimisticReportExpedite(optionKey){
    const option = reportExpediteOption(optionKey) || reportExpediteOptions.find((entry) => entry.key === optionKey);
    if (!option || !activeBaseProject) return false;
    const now = new Date();
    const dueStart = addMinutes(now, Number(option.startMinutes) || 0);
    const dueEnd = addMinutes(now, Number(option.endMinutes) || 180);
    const productionDeadline = option.production_deadline_at
      ? new Date(option.production_deadline_at)
      : addMinutes(now, Number(option.productionDeadlineMinutes ?? option.production_deadline_minutes ?? option.startMinutes ?? 0) || 0);
    const label = reportExpediteWindowLabel(option, now);
    const measurement = reportOrderMeasurement();
    const currentCharged = reportOrderAmountCharged() || reportOrderCreditedAmountForExpediteUpgrade();
    const charged = Math.round((currentCharged + reportOrderExpediteUpgradeDelta(option)) * 100) / 100;
    const patch = {
      is_expedited: true,
      report_expedite_option: option.key,
      report_expedite_label: option.label || reportExpediteDurationLabel(option),
      report_due_window_start: dueStart.toISOString(),
      report_due_window_end: dueEnd.toISOString(),
      report_due_window_label: label,
      report_production_deadline_at: productionDeadline.toISOString(),
      amount_charged: charged
    };
    Object.assign(activeBaseProject, patch);
    if (measurement && typeof measurement === 'object') Object.assign(measurement, patch);
    if (reportOrderState) {
      reportOrderState.isExpedited = true;
      reportOrderState.reportExpediteOption = option.key;
      reportOrderState.reportExpediteLabel = patch.report_expedite_label;
      reportOrderState.reportDueWindowStart = patch.report_due_window_start;
      reportOrderState.reportDueWindowEnd = patch.report_due_window_end;
      reportOrderState.reportDueWindowLabel = label;
      reportOrderState.reportProductionDeadlineAt = patch.report_production_deadline_at;
      reportOrderState.amountCharged = charged;
    }
    return true;
  }

  async function upgradePendingReportExpedite(optionKey, button){
    if (!reportExpediteOptionsEnabled()) {
      showToast('Expediting unavailable', 'Report expediting is not enabled for this account.', false);
      return;
    }
    if (reportOrderingClosed()) {
      pendingExpediteSelection = '';
      renderMeasurementsPanel();
      showToast('Expediting unavailable', 'Expedited turnaround is unavailable while we are closed.', false);
      return;
    }
    const projectId = activeMeasurementProjectId();
    if (!projectId || !optionKey) return;
    const original = button?.innerHTML;
    const upgrade = pendingExpediteOptions().find((entry) => entry.option?.key === optionKey);
    const chargeEstimate = Number(upgrade?.delta ?? 0) || 0;
    if (chargeEstimate > 0) {
      const creditOk = await ensureCreditsForPurchase(chargeEstimate, 'the expedited delivery upgrade', 'expedite_credit_gate');
      if (!creditOk) return;
    }
    const snapshot = snapshotReportExpediteState();
    if (button) {
      button.disabled = true;
      button.innerHTML = 'Expediting...';
    }
    if (applyOptimisticReportExpedite(optionKey)) {
      renderMeasurementsPanel();
      syncProjectViewerTabs();
    }
    try {
      const { data } = await postAction('expedite_queued_report', {
        project_id: projectId,
        report_expedite_option: optionKey
      });
      if (!data?.success) throw new Error(data?.error || data?.message || 'Could not expedite this report.');
      mergeReportManifestIntoActiveProject(data.manifest || {});
      pendingExpediteSelection = '';
      showToast('Report expedited', data.charge_amount ? `Charged $${fmtMoney(data.charge_amount)} for the faster delivery option.` : 'Delivery has been updated.', true);
      renderMeasurementsPanel();
      syncProjectViewerTabs();
      window.Portal.credits.refreshCredits().catch(() => null);
      window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    } catch (error) {
      restoreReportExpediteState(snapshot);
      renderMeasurementsPanel();
      syncProjectViewerTabs();
      const credit = creditErrorDetails(error);
      if (credit.isCreditError) {
        openCreditTopupForPurchase({
          label: 'the expedited delivery upgrade',
          required: credit.required || chargeEstimate,
          balance: credit.balance,
          context: 'expedite_credit_reject'
        });
      } else {
        showToast('Could not expedite', error?.message || 'Please try again.', false);
      }
      if (button) {
        button.disabled = false;
        button.innerHTML = original;
      }
    }
  }

  async function cancelPendingReportOrder(button){
    if (!reportCancellationsEnabled()) {
      showToast('Cancellation unavailable', 'Report cancellation is not enabled for this account.', false);
      return;
    }
    const cancelState = reportOrderCancelState();
    if (!cancelState.allowed || cancelState.remainingSeconds <= 0) {
      showToast('Cancellation unavailable', cancelState.expedited
        ? 'The 1-minute cancellation grace period for this expedited report has ended.'
        : 'The cancellation grace period for this project has ended.', false);
      renderMeasurementsPanel();
      return;
    }
    const projectId = activeMeasurementProjectId();
    if (!projectId) return;
    const original = button?.textContent || 'Cancel report';
    if (button) {
      button.disabled = true;
      button.textContent = 'Cancelling...';
    }
    try {
      const { data } = await postAction('cancel_queued_report', { project_id: projectId });
      if (!data?.success) throw new Error(data?.error || data?.message || 'Could not cancel this report.');
      if (activeBaseProject) {
        const cancelledAt = data.manifest?.cancelled_at || data.manifest?.timestamps?.cancelled_at || new Date().toISOString();
        const refundedAmount = Number(data.refunded || 0) || 0;
        activeBaseProject.status = 'cancelled';
        activeBaseProject.workflow_state = 'measurement_cancelled';
        activeBaseProject.cancellation_refund_amount = refundedAmount;
        activeBaseProject.cancellation_refunded = refundedAmount > 0;
        activeBaseProject.updated_at = cancelledAt;
        const measurement = activeBaseProject.measurement_project || activeBaseProject.measurement || {};
        activeBaseProject.measurement = {
          ...measurement,
          status: 'cancelled',
          cancelled_at: cancelledAt,
          cancellation_refund_amount: refundedAmount,
          raw: {
            ...(measurement.raw || {}),
            manifest: data.manifest || measurement.raw?.manifest || {}
          }
        };
        activeBaseProject.measurement_project = activeBaseProject.measurement;
        if (reportOrderState) {
          reportOrderState.status = 'cancelled';
          reportOrderState.refundedAmount = refundedAmount;
          reportOrderState.hasReadyReport = false;
        }
        clearCancellationCountdown();
        persistActiveBaseProject();
        window.dispatchEvent(new CustomEvent('fm:projects:optimistic-update', {
          detail: { project: activeBaseProject, redraw: true }
        }));
      }
      showToast('Report cancelled', data.refunded ? `$${fmtMoney(data.refunded)} was refunded to credits.` : 'The order was cancelled.', true);
      window.Portal.credits.refreshCredits().catch(() => null);
      window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
      close();
    } catch (error) {
      showToast('Could not cancel', error?.message || 'Please try again.', false);
      if (button) {
        button.disabled = false;
        button.textContent = original;
      }
    }
  }

  function mountInlineProjectMap(panelRoot){
    const app = window.Portal?.modules?.projectMap || window.Portal?.ProjectMapApp || null;
    if (!app?.mount || !panelRoot) return null;
    if (!panelRoot.querySelector('#rMap .gm-style')) {
      app.reset?.();
    }
    const mounted = app.mount({
      activeTab: 'map',
      activeProject: activeBaseProject,
      project: activeBaseProject,
      projectId: activeBaseProject?.id || '',
      panelRoot,
      previewRoot: panelRoot,
      overlayRoot: document.querySelector('#rOverlay'),
      host: hostFor(),
      projectWorkspace: hostFor(),
      active: activeMeasurementTab === 'map'
    });
    app.initializeMapView?.(activeBaseProject);
    return mounted;
  }

  function renderMeasurementsPanel(){
    const root = currentPanelRoot();
    if (!root) return;
    const tabsEl = $('#rMeasureTabs', root);
    ensureInlineProjectMapPane();
    ensureReportSummaryPane();
    ensureReportChangesPane();
    const tabs = measurementTabs();
    if (!tabs.some((tab) => tab.id === activeMeasurementTab)) {
      activeMeasurementTab = tabs.find((tab) => tab.id === 'standard' && !tab.disabled)?.id || tabs.find((tab) => !tab.disabled)?.id || 'standard';
    }
    const buttonIds = {
      map: 'rSubTabMap',
      summary: 'rSubTabSummary',
      instant: 'rSubTabInstant',
      standard: 'rSubTabStandard',
      customer: 'rSubTabCustomer',
      weather: 'rSubTabWeather',
      changes: 'rSubTabChanges'
    };
    window.Portal.ProjectViewer.renderTabs(tabsEl, tabs.map((tab) => ({
      ...tab,
      buttonId: buttonIds[tab.id] || `rSubTab${tab.id}`
    })), {
      tabClass: 'r-measure-tab',
      onTabClick: (tab) => setActiveMeasurementTab(tab.id)
    });
    if (tabsEl) {
      const submitted = reportOrderState?.submittedAt ? formatDate(reportOrderState.submittedAt) : '';
      const parts = [reportOrderState?.includeInspection ? 'Instant + standard' : 'Standard'];
      if (weatherReportInfo().ordered) parts.push('weather');
      const mode = parts.join(' + ');
      tabsEl.insertAdjacentHTML('beforeend', `<div class="r-measure-meta">${escapeHtml(mode)}${submitted ? ` · Ordered ${escapeHtml(submitted)}` : ''}</div>`);
    }
    root.querySelectorAll('.r-measure-pane').forEach((pane) => {
      pane.classList.toggle('active', pane.dataset.measurePane === activeMeasurementTab);
    });
    const instant = $('#rMeasurementInstant', root);
    const map = $('#rMeasurementMap', root);
    const summary = $('#rMeasurementSummary', root);
    const standard = $('#rMeasurementStandard', root);
    const customer = $('#rMeasurementCustomer', root);
    const xml = $('#rMeasurementXml', root);
    const weather = $('#rMeasurementWeather', root);
    const changes = $('#rMeasurementChanges', root);
    const projectId = activeMeasurementProjectId();
    const terminalWithoutReport = reportOrderReleaseHoldIsActive() || reportOrderIsRejected() || reportOrderIsCancelled();
    const knownAssets = reportOrderKnownAssetUrls();
    const cachedAssets = projectId
      ? primeMeasurementAssetCacheFromKnownUrls(projectId)
      : ((knownAssets.reportUrl || knownAssets.summaryUrl || knownAssets.xmlUrl || knownAssets.instantPdfUrl)
        ? { ...knownAssets, hasCheckedArtifacts: true }
        : null);
    if (map && inlineProjectMapWithReports() && activeMeasurementTab === 'map') {
      mountInlineProjectMap(map);
    }
    if (summary) {
      summary.innerHTML = measurementReportSummaryEnabled()
        ? reportSummaryHtml(cachedAssets || {}, projectId)
        : '';
      if (measurementReportSummaryEnabled() && reportOrderIsCompleteLike() && cachedAssets?.xmlUrl) {
        loadReportSummaryMetricsFromXml(cachedAssets.xmlUrl, projectId);
      }
    }
    if (instant) {
      if (activeMeasurementTab === 'instant') {
        renderInstantMeasurement(projectId);
      } else if (activeInstantMountKey) {
        disposeInstantMeasurement();
      } else if (!instant.innerHTML.trim()) {
        instant.innerHTML = pendingReportHtml('instant');
      }
    }
    if (standard) {
      standard.innerHTML = !terminalWithoutReport && cachedAssets?.reportUrl
        ? `${reportExpediteRefundNoticeHtml()}${reportFrameHtml(cachedAssets.reportUrl)}`
        : pendingReportHtml('standard');
    }
    if (customer) {
      customer.innerHTML = !terminalWithoutReport && cachedAssets?.summaryUrl
        ? `${reportExpediteRefundNoticeHtml()}${reportFrameHtml(cachedAssets.summaryUrl)}`
        : pendingReportHtml('customer');
    }
    if (xml) {
      xml.innerHTML = xmlDownloadPanelHtml(terminalWithoutReport ? '' : (cachedAssets?.xmlUrl || ''));
    }
    if (weather) weather.innerHTML = weatherReportPanelHtml();
    const weatherInfo = weatherReportInfo();
    if (weatherInfo.ordered && !weatherInfo.url && weatherInfo.status !== 'failed') {
      scheduleWeatherReportPoll(projectId);
    } else if (!weatherInfo.ordered || weatherInfo.url || weatherInfo.status === 'failed') {
      clearWeatherReportPoll();
      if (weatherInfo.url || weatherInfo.status === 'failed') weatherReportPollAttempt = 0;
    }
    if (changes) changes.innerHTML = reportChangesPanelHtml();
    renderReportFollowupButton(cachedAssets);
    if (projectId && (!cachedAssets || !cachedAssets.hasCheckedArtifacts) && !measurementAssetLoads.has(projectId)) {
      loadMeasurementAssets(projectId).then((assets) => {
        if (assets?.hasCheckedArtifacts && reportOrderState?.ordered && activeMeasurementProjectId() === projectId) renderMeasurementsPanel();
      });
    }
    document.querySelectorAll('[data-download-xml]').forEach((button) => {
      button.addEventListener('click', () => downloadXmlModel(cachedAssets?.xmlUrl || '', projectId));
    });
    document.querySelectorAll('[data-download-measurements-csv]').forEach((button) => {
      button.addEventListener('click', () => downloadMeasurementsCsv(projectId, cachedAssets || {}));
    });
    document.querySelectorAll('[data-select-upgrade-expedite]').forEach((button) => {
      button.addEventListener('click', () => selectPendingReportExpedite(button.dataset.selectUpgradeExpedite));
    });
    document.querySelectorAll('[data-confirm-upgrade-expedite]').forEach((button) => {
      button.addEventListener('click', () => upgradePendingReportExpedite(button.dataset.confirmUpgradeExpedite, button));
    });
    document.querySelectorAll('[data-cancel-report-order]').forEach((button) => {
      button.addEventListener('click', () => cancelPendingReportOrder(button));
    });
    document.querySelectorAll('[data-reorder-report-order]').forEach((button) => {
      button.addEventListener('click', () => reorderCancelledReportOrder());
    });
    document.querySelectorAll('[data-reorder-rejected-report]').forEach((button) => {
      button.addEventListener('click', () => reorderRejectedReportOrder());
    });
    document.querySelectorAll('[data-order-weather-report]').forEach((button) => {
      button.addEventListener('click', () => orderWeatherReport(button));
    });
    document.querySelectorAll('[data-check-weather-report]').forEach((button) => {
      button.addEventListener('click', () => checkWeatherReportStatus(button));
    });
    document.querySelectorAll('[data-open-support-request]').forEach((button) => {
      button.addEventListener('click', openReportRequestModal);
    });
    if (activePreviewTab === 'measurements' && reportOrderState?.ordered && reportCancellationsEnabled() && reportOrderIsActivelyPending()) {
      scheduleCancellationCountdown();
    } else {
      clearCancellationCountdown();
    }
    syncReportExpediteMinuteRefresh();
  }


  function mount(context = {}){
    state.host = hostFor(context);
    state.model = modelFromContext(context);
    state.panelRoot = resolveRoot(context);
    state.mounted = !!state.panelRoot;
    state.active = context.active !== false;
    if (state.model && window.FirstMateAppContext?.installProjectContextAccessors) {
      window.FirstMateAppContext.installProjectContextAccessors(state.model, { overwrite: false });
    }
    installHostGlobals();
    if (state.active && state.panelRoot) renderMeasurementsPanel();
    return api;
  }

  function activate(context = {}){
    if (context.host || context.projectWorkspace || context.panelRoot) mount(context);
    state.active = true;
    if (state.panelRoot) renderMeasurementsPanel();
  }

  function reset(){
    clearCancellationCountdown();
    clearWeatherReportPoll();
    disposeInstantMeasurement();
    pendingExpediteSelection = '';
    activeMeasurementTab = 'standard';
    reportRequestModalState = null;
    weatherReportPollAttempt = 0;
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
    measurementTabs,
    isPlatformProjectId,
    isFirstMeasureCompleteStatus,
    isFirstMeasureReturnedReportStatus,
    isCancelledStatus,
    isRejectedStatus,
    reportOrderStatus,
    reportOrderIsCancelled,
    reportOrderIsRejected,
    reportOrderKnownAssetUrls,
    primeMeasurementAssetCacheFromKnownUrls,
    reportOrderHasReadyAssets,
    reportOrderIsCompleteLike,
    reportOrderIsActivelyPending,
    reportOrderPendingStage,
    firstMeasurementId,
    activeMeasurementProjectId,
    parseReportDate,
    reportOrderSubmittedAt,
    reportOrderIsStaleSubmitted,
    reportReleaseHoldIsActive,
    reportOrderReleaseHoldIsActive,
    reportOrderMeasurement,
    reportOrderExpediteKey,
    reportOrderIsExpedited,
    reportExpediteRefundInfo,
    reportExpediteRefundNoticeHtml,
    reportOrderDueEnd,
    reportOrderCustomerDeliveryText,
    formatMinutesDuration,
    formatCancelRemaining,
    reportOrderRemainingMinutes,
    reportOrderCancelState,
    clearCancellationCountdown,
    scheduleCancellationCountdown,
    refreshCancellationCountdown,
    pendingExpediteOptions,
    pendingExpeditePriceHtml,
    selectPendingReportExpedite,
    pendingReportHtml,
    reportCompletePlaceholderHtml,
    cancelledReportHtml,
    staleSubmittedReportHtml,
    normalizeProjectTypeLabel,
    reportOrderReorderType,
    customerRejectionCopy,
    normalizeOrderProjectType,
    reorderSourceProjectId,
    applyReorderPrefillState,
    rejectedReportHtml,
    reorderCurrentReportOrder,
    reorderCancelledReportOrder,
    reorderRejectedReportOrder,
    reportFrameHtml,
    xmlDownloadFileName,
    xmlDownloadPanelHtml,
    downloadXmlModel,
    weatherApiUrl,
    weatherReportInfo,
    weatherReportStructureCount,
    weatherReportTotalPrice,
    weatherReportOrderButtonHtml,
    weatherReportPanelHtml,
    measurementReportSummaryEnabled,
    reportSummaryHtml,
    reportSummaryMetricRows,
    reportSummaryDeliveryInfo,
    ensureReportSummaryPane,
    clearWeatherReportPoll,
    markWeatherReportOrderedLocally,
    refreshWeatherReportState,
    scheduleWeatherReportPoll,
    checkWeatherReportStatus,
    orderWeatherReport,
    reportRequestProjectType,
    reportChangeRequests,
    reportRequestsAreSupportOnly,
    reportChangeRequestLabel,
    reportChangeRequestStatusText,
    reportChangesPanelHtml,
    ensureReportChangesPane,
    reportHasReturnedAssets,
    renderReportFollowupButton,
    reportRequestExistingPins,
    reportRequestNewPins,
    reportRequestStructureCount,
    syncReportRequestStructureCount,
    reportRequestChargeEstimate,
    reportRequestExpediteOptions,
    fitReportRequestMap,
    updateReportRequestModalDynamicUi,
    setupReportRequestMap,
    closeReportRequestModal,
    reportRequestModalTypeMeta,
    refreshReportRequestModal,
    openReportRequestModal,
    readReportRequestPhotos,
    mergeReportReworkResponse,
    submitReportReworkRequestAction,
    submitReportRequestModal,
    disposeInstantMeasurement,
    buildInstantMeasurementProject,
    renderInstantMeasurement,
    loadMeasurementAssets,
    setActiveMeasurementTab,
    mergeReportManifestIntoActiveProject,
    snapshotReportExpediteState,
    restoreReportExpediteState,
    applyOptimisticReportExpedite,
    upgradePendingReportExpedite,
    cancelPendingReportOrder,
    renderMeasurementsPanel,
    cache: () => ({ measurementAssetCache, measurementAssetLoads }),
    context: () => ({ mounted: state.mounted, active: state.active, activeMeasurementTab })
  };

  const definition = {
    id: 'project.measurements',
    kind: 'project_modal_app',
    title: 'Reports',
    label: 'Reports',
    icon: 'fa-ruler-combined',
    order: 60,
    visible: true,
    surfaces: ['project_modal'],
    regions: ['main'],
    requiresContext: ['project'],
    enabled: measurementsVisible,
    pending: (context = {}) => !!context.reportOrderPending,
    panelHtml,
    mount
  };

  Portal.modules = Portal.modules || {};
  Portal.modules.projectMeasurements = api;
  Portal.ProjectMeasurementsApp = api;

  runtime?.registerApp?.(definition);
})();
