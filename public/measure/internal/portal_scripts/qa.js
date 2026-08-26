/* portal_scripts/qa.js
 * QA Plugin v4.1 - Threaded Conversation System + VIP Manager Sign-off
 *
 * Changes from v4:
 * - After submit, returns to list (no auto-advance to next)
 * - Claimed projects shown in segmented section at top of pipeline
 * - Manager approval history merged into regular history (removed from purple box)
 * - Recent history shows only items approved today
 * - Created date column added to manager sign-off table
 * - Clickable history items with read-only project info modal
 *
 * v4.1 patch:
 * - Open threads can now be resolved directly (no longer requires "fixed" state first)
 * - "Resolve All Issues" button added to actions panel in both QA and manager modes
 */
(function(){
  if (!window.Portal) return;
  const cfg = () => window.Portal.cfg;
  const QA_PRIORITY_SORT = 'qa_priority';
  const QA_LEGACY_PARAMS = ['qa_legacy', 'old_qa', 'qa_old'];

  function useLegacyQaInspector(){
    try {
      const params = new URLSearchParams(window.location.search || '');
      if (QA_LEGACY_PARAMS.some((key) => params.has(key))) return true;
      return localStorage.getItem('qa_layout') === 'legacy';
    } catch(e) {
      return false;
    }
  }
  
  function canDoQA(){
    const p = (cfg().perms || {});
    const role = ((cfg().user && cfg().user.role) || '').toLowerCase();
    return role === 'admin' || role === 'qa' || !!p.manage_qa || !!p.is_admin_legacy;
  }

  function canManageQaQueue(){
    const p = (cfg().perms || {});
    const role = ((cfg().user && cfg().user.role) || '').toLowerCase();
    return role === 'admin' || role === 'manager' || !!p.manage_qa_queue || !!p.is_admin_legacy;
  }

  function canManagerReview(){
    const role = ((cfg().user && cfg().user.role) || '').toLowerCase();
    return role === 'admin' || role === 'manager';
  }

  function canBulkApproveQA(){
    return cfg().flags?.can_bulk_approve_qa === true;
  }

  function canSeeQaTechnicianIdentity(){
    return canManagerReview();
  }

  function qaCurrentUserEmail(){
    return String((cfg().user && cfg().user.email) || '').trim().toLowerCase();
  }

  function blindTechnicianLabel(){
    return 'Hidden';
  }

  function displayQaActorName(raw, fallback){
    if (canSeeQaTechnicianIdentity()) return raw || fallback || 'Unknown';
    return fallback || 'Hidden';
  }

  function canQA(){
    return canDoQA() || canManageQaQueue() || canManagerReview();
  }

  function isQaFixOnlyMode(){
    try {
      const params = new URLSearchParams(window.location.search || '');
      const raw = params.get('qa_fix_only') || params.get('fix_only') || '';
      if (raw) return raw === '1' || raw === 'true' || raw === 'yes';
    } catch(e) {}
    return !!(cfg().flags && cfg().flags.qa_fix_only_mode);
  }

  function updateQaFixOnlyIndicators(){
    const on = isQaFixOnlyMode();
    document.querySelectorAll('[data-qa-fix-only-indicator]').forEach((el) => {
      el.style.display = on ? 'inline-flex' : 'none';
    });
    updateActionButtons();
  }

  function getQaDecisionType(status) {
    if (status === 'corrected_approved') return 'qa_corrected_and_approved';
    if (status === 'rejected') return 'technician_correction_requested';
    return 'approved_without_changes';
  }

  function buildQaDecisionTracking(status) {
    const apiStatus = status === 'corrected_approved' ? 'approved' : status;
    const decisionType = getQaDecisionType(status);
    return {
      qa_decision_type: decisionType,
      decision_type: decisionType,
      correction_needed: status !== 'approved',
      qa_correction_needed: status !== 'approved',
      correction_source: status === 'corrected_approved' ? 'qa' : (status === 'rejected' ? 'technician' : 'none'),
      corrected_by_qa: status === 'corrected_approved',
      qa_corrected_by_qa: status === 'corrected_approved',
      correction_requested_from_technician: apiStatus === 'rejected',
      qa_correction_requested_from_technician: apiStatus === 'rejected',
      approved_without_changes: status === 'approved',
      qa_approved_without_changes: status === 'approved'
    };
  }

  function qaPdfDebugEnabled(){
    try {
      const params = new URLSearchParams(window.location.search || '');
      return params.has('debug') || params.has('pdf_debug') || params.has('qa_debug') || window.FIRSTMEASURE_QA_PDF_DEBUG === true;
    } catch(e) {
      return window.FIRSTMEASURE_QA_PDF_DEBUG === true;
    }
  }

  function qaDebugGenerateUrl(projectId, source){
    const raw = Portal.fmUrl(`projects/${encodeURIComponent(projectId)}/pdfs/generate`);
    try {
      const url = new URL(raw, window.location.origin);
      url.searchParams.set('debug', '1');
      url.searchParams.set('debug_source', source || 'qa_pdf_generate');
      return url.toString();
    } catch(e) {
      const joiner = String(raw).includes('?') ? '&' : '?';
      return `${raw}${joiner}debug=1&debug_source=${encodeURIComponent(source || 'qa_pdf_generate')}`;
    }
  }

  function qaPdfDebugHeaders(source){
    // Keep debug data in the query string. Custom browser headers trigger CORS
    // preflight failures against local/API environments that only allow basic headers.
    return {};
  }

  function qaLogPdfGenerateError(error, context){
    console.group('[QA PDF GENERATE ERROR]');
    console.error(error);
    console.log('context:', context || {});
    if (error && error.endpoint) console.log('endpoint:', error.endpoint);
    if (error && error.status) console.log('status:', error.status);
    if (error && error.debugTrace) console.log('firstMeasureDebugTrace:', error.debugTrace);
    if (error && error.details) console.log('server response:', error.details);
    if (error && error.details && error.details.debug_error) console.log('server debug_error:', error.details.debug_error);
    if (error && error.responseText) console.log('raw response text:', error.responseText);
    console.groupEnd();
  }

  function qaSummarizeFetchOptions(options){
    const out = {
      method: options?.method || 'GET',
      mode: options?.mode || 'default',
      credentials: options?.credentials || 'default',
      headers: options?.headers || {}
    };
    try {
      const body = typeof options?.body === 'string' ? options.body : '';
      out.body_length = body.length;
      if (body) out.body_preview = body.slice(0, 1200);
    } catch(e) {}
    return out;
  }

  async function qaFetchJsonWithDebug(url, options, context){
    let resp;
    try {
      resp = await fetch(url, options);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error || 'Fetch failed'));
      err.endpoint = url;
      err.details = {
        likely_cors_or_network_error: true,
        origin: window.location.origin,
        request: qaSummarizeFetchOptions(options),
        context: context || {},
        note: 'If this is a CORS preflight failure, check Access-Control-Allow-Headers on the API response. Debug metadata is sent via debug_source query params to avoid custom request headers.'
      };
      qaLogPdfGenerateError(err, context);
      throw err;
    }
    const responseText = await resp.text();
    let data = null;
    try { data = responseText ? JSON.parse(responseText) : null; } catch(e) {}
    if (!data) data = {};
    if (!resp.ok || data.ok === false) {
      const debugError = data.debug_error && (data.debug_error.message || data.debug_error.name)
        ? `${data.debug_error.name || 'server_error'}: ${data.debug_error.message || ''}`.trim()
        : '';
      const err = new Error(debugError || data.message || data.error || `Request failed (${resp.status})`);
      err.status = resp.status;
      err.endpoint = url;
      err.details = data;
      err.responseText = responseText;
      err.debugTrace = resp.headers.get('X-FirstMeasure-Debug-Trace') || '';
      qaLogPdfGenerateError(err, context);
      throw err;
    }
    if (qaPdfDebugEnabled()) {
      console.groupCollapsed('[QA PDF GENERATE OK]');
      console.log('context:', context || {});
      console.log('endpoint:', url);
      console.log('response:', data);
      console.groupEnd();
    }
    return data;
  }

  // ----------------- CHECKLIST DEFINITION -----------------
  const CHECKLIST_CATEGORIES = [
    {
      id: 'commercial',
      title: 'Commercial',
      icon: 'fa-building',
      items: [
        { id: 'no_missing_protrusions', label: 'No missing protrusions' }
      ]
    },
    {
      id: 'gutters',
      title: 'Gutters',
      icon: 'fa-water',
      items: [
        { id: 'gutter_labels_correct', label: 'Gutter is labeled correctly' }
      ]
    },
    {
      id: 'first_page_overhead',
      title: 'First Page & Overhead/Angle Views',
      icon: 'fa-file-image',
      items: [
        { id: 'neat_geometry', label: 'Neat geometry and angles' },
        { id: 'no_missing_structures', label: 'No missing structures' },
        { id: 'no_missing_chimneys', label: 'No missing chimneys' },
        { id: 'no_missing_skylights', label: 'No missing skylights' },
        { id: 'transitions_correct', label: 'All transitions / roof-to-wall drawn correctly' }
      ]
    },
    {
      id: '3d_model',
      title: '3D Model Review',
      icon: 'fa-cube',
      items: [
        { id: 'layer_assignment', label: 'Correct layer assignment' },
        { id: 'faces_lined_up', label: 'All faces in 3D model are lined up correctly', hint: 'Turn off height map to check edges and gaps' },
        { id: 'faces_accurate_heightmap', label: 'All faces are accurate to height map', hint: 'Move structure through height map to verify' },
        { id: 'holes_blown_through', label: 'All chimneys, skylights, dormers have holes blown through layers beneath' }
      ]
    },
    {
      id: 'report_details',
      title: 'Report Details',
      icon: 'fa-clipboard-list',
      items: [
        { id: 'pitches_logical', label: 'All pitches shown logically make sense', hint: 'Opposite dormer sides typically same pitch; simple roofs usually 1-2 pitches' },
        { id: 'line_types_correct', label: 'Line types correctly labeled (Hips, Valleys, Ridges, Eaves, Rakes, Transitions, Skylights, Chimney back/edge)' },
        { id: 'quad_view_centered', label: 'Quad view photos are centered and show four angles' },
        { id: 'labels_readable', label: 'All labels on report are easily readable' },
        { id: 'box_vents_neat', label: 'Box vents placed neatly (if applicable)' },
        { id: 'ridge_vents_appropriate', label: 'Ridge vents placed appropriately (if applicable)' }
      ]
    },
    {
      id: 'streetview_zillow',
      title: 'Streetview / Zillow Check',
      icon: 'fa-street-view',
      items: [
        { id: 'no_missing_wall_faces', label: 'No missing small faces on the walls of the house' }
      ]
    }
  ];

  const ALL_CHECKLIST_ITEMS = CHECKLIST_CATEGORIES.flatMap(cat => 
    cat.items.map(item => ({ ...item, category: cat.id, categoryTitle: cat.title }))
  );

  function getVisibleChecklistCategories(){
    const manifest = currentManifest || {};
    const projectType = String(manifest.project_type || '').trim().toLowerCase();
    const includeGutters = !!manifest.include_gutter_measurements;
    return CHECKLIST_CATEGORIES.filter((cat) => {
      if (cat.id === 'commercial') return projectType === 'commercial';
      if (cat.id === 'gutters') return includeGutters;
      return true;
    });
  }

  // ----------------- STATE -----------------
  let pendingList = [];
  let historyList = [];
  let managerList = [];
  let managerHistoryList = [];
  let isManagerReviewMode = false;
  const QA_PENDING_PAGE_SIZE_KEY = 'qa_manager_pending_page_size_v1';
  let qaPendingPage = 1;
  let qaPendingPageSize = loadQaPendingPageSize();
  let qaPendingTotalCount = 0;
  let qaPendingTotalPages = 1;
  const QA_HISTORY_PAGE_SIZE_KEY = 'qa_manager_history_page_size_v1';
  let qaHistoryPage = 1;
  let qaHistoryPageSize = loadQaHistoryPageSize();
  let qaHistoryTotalCount = 0;
  let qaHistoryTotalPages = 1;

  let currentId = null;
  let currentManifest = null;
  let currentProjectStatus = null;
  let currentAppMetadata = {};
  let qaThreads = [];
  let qaSplitPct = 50;
  let splitDragging = false;
  let activeMap = null;
  let activeMarker = null;
  let activeLastLoc = null;
  let inQAView = false;
  let queueSeq = 0;
  let inspectorSeq = 0;
  let submitSeq = 0;
  let qaSubmitting = false;
  let pdfSeq = 0;
  let qaPdfJsLoading = null;
  let qaPdfDoc = null;
  let qaPdfCurrentPage = 1;
  let qaPdfObjectUrl = null;
  let qaPdfRenderSeq = 0;
  let qaPdfPreviewSeq = 0;
  let qaPdfSyncSeq = 0;
  let qaPdfPreviewTimer = null;
  let qaPdfPersistActive = false;
  let qaPdfPersistPending = false;
  let qaPdfBaseSnapshot = null;
  let qaPdfPreviewSnapshot = null;
  let qaPdfTopViewSettings = null;
  let qaPdfPageConfig = {};
  let qaPdfVentEditMode = false;
  let qaPdfCurrentPageKind = 'general';
  let qaPdfForcedPageKind = '';
  let qaPdfAvailableSources = {};
  let qaPdfSourceThumbs = {};
  let qaPdfSourcesChecked = false;
  let qaPdfImageLoadCache = new Map();
  let qaPdfSourceCanvasCache = new Map();
  let qaPdfTopViewPreviewSeq = 0;
  let qaPdfTopViewSliderActive = false;
  let qaPdfDiagramSliderActive = false;
  let qaPdfMeasurementSliderActive = false;
  let qaPdfLastSourceUrl = '';
  let qaPdfLastSyncJobId = '';
  let qaPdfLastSyncRevision = '';
  let qaLightboxItems = [];

  function loadQaPendingPageSize(){
    try {
      const value = Number.parseInt(localStorage.getItem(QA_PENDING_PAGE_SIZE_KEY) || '200', 10);
      return [25, 50, 100, 200].includes(value) ? value : 200;
    } catch(e) {
      return 200;
    }
  }

  function saveQaPendingPageSize(value){
    try { localStorage.setItem(QA_PENDING_PAGE_SIZE_KEY, String(value)); } catch(e){}
  }

  function loadQaHistoryPageSize(){
    try {
      const value = Number.parseInt(localStorage.getItem(QA_HISTORY_PAGE_SIZE_KEY) || '25', 10);
      return [10, 25, 50, 100].includes(value) ? value : 25;
    } catch(e) {
      return 25;
    }
  }

  function saveQaHistoryPageSize(value){
    try { localStorage.setItem(QA_HISTORY_PAGE_SIZE_KEY, String(value)); } catch(e){}
  }
  let qaLightboxIndex = 0;
  let uiWired = false;
  let splitterWired = false;
  let resizeWired = false;
  let qaBulkSelectedIds = new Set();
  let qaBulkRowStatus = new Map();
  let qaBulkLastSelectIndex = -1;
  let qaBulkRunActive = false;
  let qaImageAssets = {};
  let qaActiveImageView = 'live_quad';
  let qaImageCrop = null;
  let qaImageBundle = null;
  let qaImageLoadToken = 0;
  let qaImageGeometryVisible = true;
  let qaImageShowFaces = true;
  let qaImageShowTypeColors = true;
  let qaImageShowMeasurements = true;
  let qaImageShowLegend = true;
  let qaImageViewport = {
    baseWidth: 0,
    baseHeight: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    panStartX: 0,
    panStartY: 0
  };

  let sortColumn = QA_PRIORITY_SORT;
  let sortDirection = 'asc';
  let showFillers = true;
  let qaQueueStats = {};
  let qaLeaderboardRange = 'day';
  const QA_SHIFT_TIME_ZONE = 'America/Los_Angeles';
  let qaLeaderboardDate = qaShiftDateKeyFor(new Date());
  const qaLeaderboardDailyCache = new Map();

  try {
    const sc = localStorage.getItem('qa_sort_column');
    const sd = localStorage.getItem('qa_sort_direction');
    const sf = localStorage.getItem('qa_show_fillers');
    if (sc) sortColumn = sc;
    if (sd) sortDirection = sd;
    if (sf !== null) showFillers = sf === 'true';
  } catch(e) {}
  if (!canSeeQaTechnicianIdentity() && sortColumn === 'drafter') {
    sortColumn = QA_PRIORITY_SORT;
  }

  function persistSortState() {
    if (canManageQaQueue()) return;
    try {
      localStorage.setItem('qa_sort_column', sortColumn);
      localStorage.setItem('qa_sort_direction', sortDirection);
    } catch(e) {}
  }
  function persistFillerState() {
    try {
      localStorage.setItem('qa_show_fillers', String(showFillers));
    } catch(e) {}
  }

  let heartbeatTimer = null;
  let idleTimer = null;
  let lastQaActivityAt = Date.now();
  let lastHeartbeatSentAt = 0;
  let heartbeatInFlight = false;
  let heartbeatContextTimer = null;
  let qaIdleReleased = false;
  let qaReservedProjects = [];
  let qaPreloadedProjectId = null;
  const qaActivityTargets = new WeakSet();
  const HEARTBEAT_INTERVAL = 120000;
  const HEARTBEAT_ACTIVITY_THROTTLE = 60000;
  const QA_IDLE_LIMIT = 15 * 60 * 1000;
  const QA_IDLE_RELEASE_ENABLED = false;
  const QA_PRELOAD_TARGET = 1;

  function startHeartbeat() {
    if (heartbeatTimer) return;
    markQaActivity();
    wireQaActivityListeners();
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
    scheduleIdleCheck();
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  async function sendHeartbeat() {
    if (qaIdleReleased) return;
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    lastHeartbeatSentAt = Date.now();
    const active = !QA_IDLE_RELEASE_ENABLED || Date.now() - lastQaActivityAt < QA_IDLE_LIMIT;
    try {
      await fmPost('qa/session/heartbeat', {
        active,
        current_folder: currentId || null,
        current_view: 'qa'
      }, 10000);
      if (QA_IDLE_RELEASE_ENABLED && !active) await handleQaIdleTimeout();
    } catch (e) {
      console.warn('Heartbeat failed:', e);
    } finally {
      heartbeatInFlight = false;
    }
  }

  function refreshHeartbeatContext() {
    lastHeartbeatSentAt = 0;
    qaIdleReleased = false;
    if (heartbeatContextTimer) clearTimeout(heartbeatContextTimer);
    if (!heartbeatInFlight) {
      heartbeatContextTimer = null;
      sendHeartbeat();
      return;
    }
    heartbeatContextTimer = setTimeout(refreshHeartbeatContext, 250);
  }

  function markQaActivity(){
    lastQaActivityAt = Date.now();
    qaIdleReleased = false;
    scheduleIdleCheck();
    if (inQAView && heartbeatTimer && Date.now() - lastHeartbeatSentAt >= HEARTBEAT_ACTIVITY_THROTTLE) {
      sendHeartbeat();
    }
  }

  function wireQaActivityListeners(){
    wireQaActivityTarget(window);
    wireEmbeddedEditorActivity();
  }

  function wireQaActivityTarget(target){
    if (!target || qaActivityTargets.has(target)) return;
    qaActivityTargets.add(target);
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'pointermove', 'scroll', 'wheel', 'input'].forEach((eventName) => {
      target.addEventListener(eventName, markQaActivity, { passive: true });
    });
  }

  function wireEmbeddedEditorActivity(){
    const frame = document.getElementById('qaEmbeddedEditorFrame');
    if (!frame) return;
    wireQaActivityTarget(frame);
    if (!frame.__qaActivityLoadWired) {
      frame.__qaActivityLoadWired = true;
      frame.addEventListener('load', () => {
        markQaActivity();
        wireEmbeddedEditorActivity();
      });
    }
    try {
      if (frame.contentWindow) wireQaActivityTarget(frame.contentWindow);
      if (frame.contentDocument) wireQaActivityTarget(frame.contentDocument);
    } catch(e) {}
  }

  function scheduleIdleCheck(){
    if (!QA_IDLE_RELEASE_ENABLED) return;
    if (!inQAView && !heartbeatTimer) return;
    if (idleTimer) clearTimeout(idleTimer);
    const wait = Math.max(1000, QA_IDLE_LIMIT - (Date.now() - lastQaActivityAt));
    idleTimer = setTimeout(async () => {
      if (!inQAView) return;
      if (Date.now() - lastQaActivityAt >= QA_IDLE_LIMIT) {
        await handleQaIdleTimeout();
      } else {
        scheduleIdleCheck();
      }
    }, wait);
  }

  async function handleQaIdleTimeout(){
    if (!QA_IDLE_RELEASE_ENABLED) return;
    if (qaIdleReleased) return;
    qaIdleReleased = true;
    const currentUser = qaCurrentUserEmail();
    const claimedCount = Number(qaQueueStats.claimed_count || 0);
    const hasReservedClaims = Array.isArray(qaReservedProjects) && qaReservedProjects.some((item) => item && item.id);
    const hasLoadedClaim = !!currentId && !isManagerReviewMode && (
      !currentManifest
      || String(currentManifest.qa_claimed_by_email || '').trim().toLowerCase() === currentUser
      || !String(currentManifest.qa_claimed_by_email || '').trim()
    );
    const shouldNotify = claimedCount > 0 || hasReservedClaims || hasLoadedClaim;
    let releasedCount = 0;
    try {
      const res = await fmPost('qa/session/release', { reason: 'idle_timeout' }, 15000);
      releasedCount = Number(res && res.released ? res.released : 0);
    } catch (e) {
      console.warn('Failed to release QA claims after idle timeout:', e);
    }
    qaReservedProjects = [];
    qaPreloadedProjectId = null;
    clearPreloadedEditor();
    if (shouldNotify || releasedCount > 0) {
      await qaNotice('QA session timed out', 'You were idle for more than five minutes, so your QA claims were released.');
    }
    if (currentId && !isManagerReviewMode) closeInspectorToList({ releaseClaims: false });
    await loadQueue();
  }

  // ----------------- DOM / STYLES -----------------
  function ensureStyles(){
    if (document.getElementById('qaPluginStyles')) return;
    const css = `
      /* ===== Layout modes ===== */
      #view-qa { min-height:0; box-sizing:border-box; padding:30px; }
      .qa-wrap { display:flex; gap:18px; flex:1; min-height:0; min-width:0; width:100%; height:auto; }
      .qa-wrap.list-mode .qa-left { width:100%; min-width:0; }
      .qa-wrap.list-mode .qa-right { display:none; }
      .qa-wrap.inspector-mode .qa-left { width:454px; min-width:340px; }
      .qa-wrap.inspector-mode .qa-right { display:flex; }
      .qa-wrap.embedded-mode { gap:12px; }
      .qa-wrap.embedded-mode .qa-left {
        width:min(500px, 42vw);
        min-width:360px;
      }
      .qa-wrap.embedded-mode .qa-right {
        display:flex;
        min-width:520px;
        background:#fff;
        border:1px solid var(--border);
        box-shadow:0 2px 8px rgba(0,0,0,0.06);
      }
      .qa-wrap.embedded-mode.inspector-mode { gap:0; }
      .qa-wrap.embedded-mode.inspector-mode .qa-left { display:none; }
      .qa-wrap.embedded-mode.inspector-mode .qa-right {
        width:100%;
        max-width:100%;
        min-width:0;
        border:0;
        border-radius:0;
        box-shadow:none;
      }
      .qa-wrap.embedded-mode.list-mode .qa-left { width:100%; min-width:0; }
      .qa-wrap.embedded-mode.list-mode .qa-right { display:none; }
      .qa-wrap.embedded-mode #qaRightSplit { display:none; }
      .qa-wrap:not(.embedded-mode) #qaEmbeddedEditorShell { display:none; }
      .qa-wrap.embedded-mode .qa-right-inner { padding:0; width:100%; min-height:0; display:flex; flex-direction:column; }
      body.qa-editor-fullscreen #view-qa {
        flex:1 1 auto;
        min-width:0;
        min-height:0;
        width:100%;
        height:100%;
        margin:0;
        padding:0;
        overflow:hidden;
        background:#fff;
      }
      body.qa-editor-fullscreen .qa-wrap.embedded-mode.inspector-mode {
        width:100%;
        height:100%;
        min-width:0;
        min-height:0;
        margin:0;
        padding:0;
        gap:0;
        overflow:hidden;
        background:#fff;
      }
      body.qa-editor-fullscreen .qa-wrap.embedded-mode.inspector-mode .qa-right,
      body.qa-editor-fullscreen .qa-wrap.embedded-mode.inspector-mode .qa-right-inner,
      body.qa-editor-fullscreen .qa-wrap.embedded-mode.inspector-mode .qa-embedded-editor-shell {
        width:100%;
        max-width:100%;
        min-width:0;
        height:100%;
        min-height:0;
        margin:0;
        padding:0;
        border:0;
        border-radius:0;
        box-shadow:none;
        background:#fff;
        overflow:hidden;
        box-sizing:border-box;
      }
      body.qa-editor-fullscreen .qa-wrap.embedded-mode.inspector-mode .qa-right {
        flex:1 1 auto;
      }
      body.qa-editor-fullscreen .qa-wrap.embedded-mode.inspector-mode .qa-right-inner {
        flex:1 1 auto;
      }
      body.qa-editor-fullscreen .qa-wrap.embedded-mode.inspector-mode .qa-embedded-header {
        padding:8px 16px;
        min-height:50px;
        width:100%;
        max-width:100%;
        margin:0;
        overflow:hidden;
        box-sizing:border-box;
      }
      body.qa-editor-fullscreen .qa-wrap.embedded-mode.inspector-mode .qa-embedded-header > * {
        min-width:0;
      }
      body.qa-editor-fullscreen .qa-wrap.embedded-mode.inspector-mode .qa-embedded-editor-shell {
        flex:1 1 auto;
        height:auto;
      }
      body.qa-editor-fullscreen .qa-wrap.embedded-mode.inspector-mode .qa-embedded-editor-shell iframe {
        width:100%;
        max-width:100%;
        height:100%;
        margin:0;
        padding:0;
        border:0;
        background:#fff;
      }
      .qa-embedded-header {
        display:none;
        align-items:center;
        justify-content:space-between;
        gap:14px;
        padding:10px 14px;
        min-height:58px;
        border-bottom:2px solid var(--primary);
        background:#fff;
        color:#202124;
        flex-shrink:0;
        min-width:0;
        box-sizing:border-box;
      }
      .qa-wrap.embedded-mode.inspector-mode .qa-embedded-header { display:flex; }
      .qa-embedded-header .qa-embedded-left {
        display:flex;
        align-items:center;
        gap:12px;
        min-width:0;
        flex:1 1 auto;
      }
      .qa-embedded-meta {
        display:flex;
        flex-direction:column;
        gap:2px;
        min-width:0;
      }
      .qa-embedded-address-row {
        display:flex;
        align-items:center;
        gap:8px;
        min-width:0;
      }
      .qa-copy-address {
        cursor:pointer;
        border-radius:4px;
        transition:color .15s ease, background .15s ease;
      }
      .qa-copy-address:hover,
      .qa-copy-address:focus-visible {
        color:#1a73e8;
        background:#e8f0fe;
        outline:none;
      }
      .qa-project-type-pill {
        display:none;
        flex:0 0 auto;
        padding:3px 9px;
        border:1.5px solid transparent;
        border-radius:20px;
        font-size:10px;
        font-weight:800;
        letter-spacing:.4px;
        line-height:1.2;
        text-transform:uppercase;
        white-space:nowrap;
      }
      .qa-project-type-pill.residential { display:inline-flex; background:#e3f2fd; color:#1565c0; border-color:#90caf9; }
      .qa-project-type-pill.commercial { display:inline-flex; background:#fff3e0; color:#e65100; border-color:#ffcc80; }
      .qa-project-type-pill.multifamily { display:inline-flex; background:#e8f5e9; color:#2e7d32; border-color:#a5d6a7; }
      .qa-copy-feedback {
        display:none;
        flex:0 0 auto;
        color:#137333;
        font-size:10px;
        font-weight:900;
        white-space:nowrap;
      }
      .qa-copy-feedback.show { display:inline-flex; }
      .qa-nav-address-row { display:flex; align-items:center; gap:7px; min-width:0; }
      .qa-embedded-address {
        font-size:14px;
        font-weight:950;
        color:#202124;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        max-width:46vw;
      }
      .qa-embedded-sub {
        font-size:11px;
        font-weight:850;
        color:#5f6368;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        max-width:46vw;
      }
      .qa-embedded-actions {
        display:flex;
        align-items:center;
        justify-content:flex-end;
        gap:8px;
        flex-wrap:nowrap;
        min-width:0;
        flex:0 1 auto;
      }
      .qa-embedded-editor-shell {
        flex:1;
        min-height:0;
        position:relative;
        display:flex;
        background:#fff;
        border-radius:0;
        overflow:hidden;
      }
      .qa-embedded-editor-shell iframe {
        width:100%;
        height:100%;
        border:0;
        display:none;
        background:#fff;
      }
      .qa-embedded-editor-shell iframe.qa-preload-frame {
        position:absolute;
        left:-10000px;
        top:0;
        width:1px;
        height:1px;
        opacity:0;
        pointer-events:none;
      }
      .qa-embedded-empty {
        position:absolute;
        inset:0;
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        gap:8px;
        color:#5f6368;
        text-align:center;
        font-weight:850;
        padding:24px;
      }
      .qa-embedded-empty i { font-size:28px; color:#1a73e8; }
      .qa-table tr.qa-selected td { background:#e8f0fe !important; box-shadow:inset 3px 0 0 #1a73e8; }
      .qa-submit-overlay {
        position:fixed; inset:0; z-index:99998; display:none; align-items:center; justify-content:center;
        background:rgba(18,22,28,.34); backdrop-filter:blur(2px); cursor:progress;
      }
      .qa-submit-overlay.show { display:flex; }
      .qa-submit-card {
        min-width:220px; padding:18px 20px; border-radius:10px; background:#fff; color:#202124;
        border:1px solid rgba(16,24,40,.12); box-shadow:0 18px 48px rgba(0,0,0,.26);
        display:flex; align-items:center; gap:12px; font-size:13px; font-weight:950;
      }
      .qa-submit-card i { color:#1a73e8; font-size:16px; }
      .qa-confirm-overlay {
        position:fixed; inset:0; background:rgba(32,33,36,.42); z-index:9999;
        display:none; align-items:center; justify-content:center; padding:24px;
      }
      .qa-confirm-overlay.show { display:flex; }
      .qa-confirm-card {
        width:min(460px, calc(100vw - 48px)); background:#fff; border-radius:10px;
        border:1px solid #e5e7eb; box-shadow:0 24px 70px rgba(0,0,0,.22); overflow:hidden;
      }
      .qa-confirm-head { padding:16px 18px 10px; font-size:16px; font-weight:950; color:#202124; }
      .qa-confirm-body { padding:0 18px 16px; color:#5f6368; font-size:13px; line-height:1.5; }
      .qa-confirm-actions {
        display:flex; justify-content:flex-end; gap:8px; padding:14px 18px; background:#fafafa; border-top:1px solid #eef0f2;
      }

      .qa-panel {
        background:#fff;
        border:1px solid var(--border);
        border-radius:14px;
        box-shadow:0 2px 8px rgba(0,0,0,0.06);
        overflow:hidden;
        min-height:0;
      }
      .qa-left { display:flex; flex-direction:column; position:relative; min-height:0; }
      .qa-right { flex:1; display:flex; flex-direction:column; min-width: 520px; min-height:0; background:#525659; border-radius:14px; overflow:hidden; position: relative; }
      .qa-topbar { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:16px 18px; border-bottom:1px solid #eee; }
      .qa-title { font-weight:900; letter-spacing:0.2px; color:#202124; display:flex; align-items:center; gap:10px; }
      .qa-fix-only-pill {
        display:none;
        align-items:center;
        gap:6px;
        padding:5px 9px;
        border-radius:999px;
        border:1px solid #f4b4ae;
        background:#fce8e6;
        color:#b0261e;
        font-size:11px;
        font-weight:950;
        white-space:nowrap;
      }
      .qa-stats { display:flex; gap:10px; align-items:center; }
      .qa-stat { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:8px 12px; border-radius:10px; border:1px solid #eee; background:#fafafa; min-width:90px; }
      .qa-stat .v { font-weight:900; font-size:18px; color: var(--primary); line-height:1; }
      .qa-stat .l { font-size:10px; font-weight:800; color:#777; text-transform:uppercase; margin-top:4px; }

      /* ===== Toolbar ===== */
      .qa-toolbar {
        display:flex; align-items:center; justify-content:space-between;
        padding:10px 18px; border-bottom:1px solid #eee; gap:12px; background:#fafafa;
      }
      .qa-toolbar-left { display:flex; align-items:center; gap:14px; }
      .qa-toolbar-right { display:flex; align-items:center; gap:14px; }
      .qa-load-error {
        display:none;
        align-items:flex-start;
        gap:8px;
        margin:10px 18px 0;
        padding:10px 12px;
        border:1px solid #f4b4ae;
        border-radius:10px;
        background:#fce8e6;
        color:#8c1d18;
        font-size:12px;
        font-weight:850;
        line-height:1.35;
      }
      .qa-load-error.show { display:flex; }
      .qa-load-error i { margin-top:2px; flex:0 0 auto; }
      .qa-bulk-panel {
        position:fixed; inset:0; z-index:100020; display:none; align-items:center; justify-content:center;
        padding:28px; background:rgba(32,33,36,.46); backdrop-filter:blur(4px);
      }
      .qa-bulk-panel.show { display:flex; }
      .qa-bulk-modal {
        width:min(920px, 100%); max-height:min(760px, calc(100vh - 56px)); display:flex; flex-direction:column;
        border:1px solid rgba(218,220,224,.9); border-radius:12px; background:#fff;
        box-shadow:0 24px 70px rgba(32,33,36,.24); overflow:hidden;
      }
      .qa-bulk-head {
        display:flex; align-items:flex-start; justify-content:space-between; gap:18px;
        padding:20px 22px 16px; border-bottom:1px solid #eef0f2; background:#fff;
      }
      .qa-bulk-title { display:flex; align-items:center; gap:10px; margin:0; font-size:17px; font-weight:950; color:#202124; }
      .qa-bulk-title i { color:#1a73e8; }
      .qa-bulk-subtitle { margin:6px 0 0; font-size:12px; line-height:1.45; color:#5f6368; max-width:640px; }
      .qa-bulk-close {
        width:34px; height:34px; display:flex; align-items:center; justify-content:center; flex:0 0 auto;
        border:1px solid #dfe3ea; border-radius:8px; background:#fff; color:#5f6368; cursor:pointer;
      }
      .qa-bulk-close:hover { background:#f8fafd; color:#202124; }
      .qa-bulk-body { padding:18px 22px; overflow:auto; }
      .qa-bulk-grid {
        display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:14px 16px; align-items:start;
      }
      .qa-bulk-field label {
        display:block; min-height:14px; font-size:10px; line-height:1.2; font-weight:950; color:#5f6368;
        text-transform:uppercase; margin-bottom:6px; white-space:normal;
      }
      .qa-bulk-field input,
      .qa-bulk-field select {
        width:100%; box-sizing:border-box; height:38px; border:1px solid #dfe3ea; border-radius:8px; padding:0 10px;
        font-size:13px; font-weight:750; background:#fff; color:#202124;
      }
      .qa-bulk-field .qa-bulk-switch {
        height:38px; display:flex; align-items:center; gap:10px; cursor:pointer; user-select:none;
        margin:0; text-transform:none; letter-spacing:0; color:#202124;
      }
      .qa-bulk-switch input {
        position:absolute; width:1px; height:1px; opacity:0; pointer-events:none;
      }
      .qa-bulk-switch-track {
        position:relative; width:56px; height:28px; flex:0 0 56px; border-radius:999px;
        background:#d93025; border:1px solid #b3261e; transition:background .15s ease, border-color .15s ease;
        box-shadow:inset 0 0 0 1px rgba(255,255,255,.22);
      }
      .qa-bulk-switch-track::before,
      .qa-bulk-switch-track::after {
        position:absolute; top:50%; transform:translateY(-50%); font-size:9px; font-weight:950; color:#fff;
      }
      .qa-bulk-switch-track::before { content:'OFF'; right:7px; }
      .qa-bulk-switch-track::after {
        content:''; left:3px; width:22px; height:22px; border-radius:50%; background:#fff;
        box-shadow:0 1px 4px rgba(0,0,0,.28); transform:translateY(-50%); transition:left .15s ease;
      }
      .qa-bulk-switch input:checked + .qa-bulk-switch-track {
        background:#188038; border-color:#137333;
      }
      .qa-bulk-switch input:checked + .qa-bulk-switch-track::before {
        content:'ON'; left:8px; right:auto;
      }
      .qa-bulk-switch input:checked + .qa-bulk-switch-track::after { left:29px; }
      .qa-bulk-switch-text {
        min-width:104px; font-size:13px; line-height:1.15; font-weight:900; color:#b3261e;
      }
      .qa-bulk-switch-text::before { content:'VIP excluded'; }
      .qa-bulk-switch input:checked ~ .qa-bulk-switch-text { color:#137333; }
      .qa-bulk-switch input:checked ~ .qa-bulk-switch-text::before { content:'VIP included'; }
      .qa-bulk-switch input:focus-visible + .qa-bulk-switch-track {
        outline:2px solid #1a73e8; outline-offset:2px;
      }
      .qa-bulk-summary {
        display:grid; grid-template-columns:auto minmax(260px, 1fr) auto; gap:14px; align-items:center;
        padding:14px 22px; border-top:1px solid #eef0f2; background:#fafafa;
      }
      .qa-bulk-count { font-size:13px; font-weight:900; color:#202124; }
      .qa-bulk-count b { color:#0b8043; }
      .qa-bulk-confirm { display:inline-flex; align-items:flex-start; gap:8px; font-size:12px; line-height:1.35; font-weight:850; color:#3c4043; min-width:0; }
      .qa-bulk-confirm input { width:16px; height:16px; }
      .qa-bulk-preview {
        margin-top:16px; max-height:320px; overflow:auto; border:1px solid #eef0f2; border-radius:8px;
        background:#fafafa; padding:0; font-size:12px; color:#5f6368; line-height:1.45;
      }
      .qa-bulk-empty { padding:12px; }
      .qa-bulk-selectbar {
        display:flex; align-items:center; justify-content:space-between; gap:12px;
        padding:8px 10px; border-bottom:1px solid #eef0f2; background:#fff;
        position:sticky; top:0; z-index:1;
      }
      .qa-bulk-select-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .qa-bulk-link {
        border:0; background:none; color:#1a73e8; font-size:11px; font-weight:900; cursor:pointer; padding:2px 0;
      }
      .qa-bulk-link:hover { text-decoration:underline; }
      .qa-bulk-list { display:flex; flex-direction:column; }
      .qa-bulk-row {
        display:grid; grid-template-columns:28px minmax(210px, 1.4fr) minmax(120px, .8fr) 82px minmax(118px, .7fr) minmax(120px, .75fr);
        gap:10px; align-items:center; padding:9px 10px; border-bottom:1px solid #eef0f2; background:#fff;
      }
      .qa-bulk-row:last-child { border-bottom:0; }
      .qa-bulk-row:hover { background:#f8fafd; }
      .qa-bulk-row.is-unchecked { opacity:.6; }
      .qa-bulk-row.is-running { background:#e8f0fe; }
      .qa-bulk-row.is-success { background:#e6f4ea; }
      .qa-bulk-row.is-error { background:#fce8e6; }
      .qa-bulk-check { width:16px; height:16px; }
      .qa-bulk-main { min-width:0; }
      .qa-bulk-address { font-weight:950; color:#202124; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .qa-bulk-id { font-size:10px; color:#80868b; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .qa-bulk-meta-label { display:block; font-size:9px; font-weight:950; color:#80868b; text-transform:uppercase; line-height:1.1; }
      .qa-bulk-meta-value { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#3c4043; font-weight:850; }
      .qa-bulk-status {
        display:inline-flex; align-items:center; gap:6px; justify-content:center;
        border-radius:999px; border:1px solid #dfe3ea; background:#f8f9fa; color:#5f6368;
        padding:4px 8px; font-size:10px; font-weight:950; text-transform:uppercase; white-space:nowrap;
      }
      .qa-bulk-status.queued { background:#f8f9fa; color:#5f6368; }
      .qa-bulk-status.running { background:#e8f0fe; color:#1a73e8; border-color:#d2e3fc; }
      .qa-bulk-status.success { background:#e6f4ea; color:#137333; border-color:#c8e6c9; }
      .qa-bulk-status.error { background:#fce8e6; color:#b0261e; border-color:#f1b7b2; }
      .qa-bulk-row-error {
        grid-column:2 / -1; color:#b0261e; font-size:11px; font-weight:850;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      }
      @media (max-width: 860px){
        .qa-bulk-grid { grid-template-columns:repeat(2, minmax(0, 1fr)); }
        .qa-bulk-summary { grid-template-columns:1fr; }
        .qa-bulk-row { grid-template-columns:28px minmax(0, 1fr); }
        .qa-bulk-row > :not(.qa-bulk-main):not(.qa-bulk-check):not(.qa-bulk-row-error) { grid-column:2; }
        .qa-bulk-row-error { grid-column:2; }
      }
      @media (max-width: 560px){
        .qa-bulk-panel { padding:12px; align-items:stretch; }
        .qa-bulk-modal { max-height:calc(100vh - 24px); }
        .qa-bulk-grid { grid-template-columns:1fr; }
      }
      .qa-toggle-wrap {
        display:flex; align-items:center; gap:8px;
        font-size:12px; font-weight:800; color:#555; cursor:pointer; user-select:none;
      }
      .qa-toggle-switch {
        position:relative; width:36px; height:20px; background:#ccc;
        border-radius:999px; transition:background .15s ease; flex-shrink:0;
      }
      .qa-toggle-switch.on { background:#34a853; }
      .qa-toggle-switch::after {
        content:''; position:absolute; top:2px; left:2px;
        width:16px; height:16px; background:#fff; border-radius:50%;
        transition:transform .15s ease; box-shadow:0 1px 3px rgba(0,0,0,0.2);
      }
      .qa-toggle-switch.on::after { transform:translateX(16px); }
      .qa-sort-hint { font-size:11px; color:#999; font-weight:700; }
      .qa-worker-panel {
        display:none; margin:18px 0; padding:18px; border:1px solid #eee;
        border-radius:16px; background:linear-gradient(180deg, #fff 0%, #fafafa 100%);
      }
      .qa-worker-panel.show { display:block; }
      .qa-worker-panel.loading {
        display:block;
        border-color:#dbe7ff;
        background:linear-gradient(180deg, #f8fbff 0%, #fff 100%);
      }
      .qa-worker-panel.loading .qa-worker-next {
        border-color:#dbe7ff;
        background:#f8fbff;
      }
      .qa-loading-inline {
        display:inline-flex;
        align-items:center;
        gap:8px;
        color:#1a73e8;
        font-size:12px;
        font-weight:900;
      }
      .qa-worker-panel .hero {
        display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:16px;
      }
      .qa-worker-panel .hero h3 { margin:0; font-size:20px; color:#202124; }
      .qa-worker-panel .hero p { margin:6px 0 0 0; color:#5f6368; font-size:13px; line-height:1.5; }
      .qa-worker-stats {
        display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:12px;
        margin-bottom:16px;
      }
      .qa-worker-stat {
        padding:14px 16px; border-radius:14px; border:1px solid #eceff1; background:#fff;
      }
      .qa-worker-stat .v { font-size:24px; font-weight:950; color:var(--primary); line-height:1; }
      .qa-worker-stat .l { margin-top:6px; font-size:11px; font-weight:900; text-transform:uppercase; color:#777; }
      .qa-rate-strip {
        display:none;
        gap:10px;
        padding:8px 18px 12px;
      }
      .qa-rate-strip-head,.qa-shift-date-controls{display:flex;align-items:center;gap:7px}
      .qa-rate-strip-head{grid-column:1/-1;justify-content:space-between;flex-wrap:wrap;color:#4b5563;font-size:11px;font-weight:950;text-transform:uppercase}
      .qa-rate-strip-values{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
      .qa-shift-date-controls button,.qa-shift-date-controls input{height:28px;border:1px solid #d9dee8;background:#fff;color:#374151;border-radius:7px;font-size:11px;font-weight:900}
      .qa-shift-date-controls button{width:28px;cursor:pointer}
      .qa-shift-date-controls button:disabled{opacity:.4;cursor:not-allowed}
      .qa-shift-date-controls input{padding:0 7px}
      .qa-rate-chip {
        display:flex;
        flex-direction:column;
        align-items:flex-start;
        justify-content:center;
        gap:5px;
        min-height:56px;
        border:1px solid #e5e7eb;
        background:#fff;
        border-radius:8px;
        padding:9px 12px;
        font-size:13px;
        font-weight:950;
        color:#202124;
        min-width:0;
      }
      .qa-rate-chip .qa-rate-name {
        max-width:100%;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
      }
      .qa-rate-chip b {
        color:#0b8043;
        font-size:16px;
        line-height:1;
        font-weight:950;
      }
      .qa-rate-chip small{color:#6b7280;font-size:10px;font-weight:800;line-height:1.25}
      .qa-leaderboard {
        display:none;
        margin:0 0 14px;
        border:1px solid #e5e7eb;
        border-radius:8px;
        overflow:hidden;
        background:#fff;
      }
      .qa-leaderboard.show { display:block; }
      .qa-leaderboard-head {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        padding:9px 12px;
        background:#f8fafc;
        border-bottom:1px solid #eef0f2;
      }
      .qa-leaderboard-title {
        font-size:11px;
        font-weight:950;
        letter-spacing:.04em;
        text-transform:uppercase;
        color:#202124;
        display:flex;
        align-items:center;
        gap:7px;
      }
      .qa-leaderboard-sub {
        font-size:10px;
        font-weight:850;
        color:#6b7280;
        white-space:nowrap;
      }
      .qa-leaderboard-actions {
        display:flex;
        align-items:center;
        gap:8px;
      }
      .qa-leaderboard-range {
        display:inline-flex;
        overflow:hidden;
        border:1px solid #d9dee8;
        border-radius:8px;
        background:#fff;
      }
      .qa-leaderboard-range button {
        border:0;
        border-left:1px solid #eef0f2;
        background:#fff;
        color:#4b5563;
        cursor:pointer;
        font-size:10px;
        font-weight:950;
        padding:6px 8px;
      }
      .qa-leaderboard-range button:first-child{border-left:0}
      .qa-leaderboard-range button.active{background:#202124;color:#fff}
      .qa-leaderboard-grid {
        display:grid;
        gap:0;
      }
      .qa-leaderboard-col {
        min-width:0;
        border-left:1px solid #eef0f2;
      }
      .qa-leaderboard-col:first-child { border-left:0; }
      .qa-leaderboard-row {
        display:grid;
        grid-template-columns:30px minmax(0,1fr) auto;
        align-items:center;
        gap:7px;
        padding:8px 10px;
        border-bottom:1px solid #eef0f2;
        min-width:0;
      }
      .qa-leaderboard-col .qa-leaderboard-row:last-child{border-bottom:0}
      .qa-leaderboard-row.rank-1{background:#fffbeb;box-shadow:inset 3px 0 0 #d97706}
      .qa-leaderboard-rank {
        width:24px;
        height:24px;
        border-radius:999px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        background:#eef2f7;
        color:#202124;
        font-size:11px;
        font-weight:950;
      }
      .qa-leaderboard-row.rank-1 .qa-leaderboard-rank{background:#f59e0b;color:#fff}
      .qa-leaderboard-row.rank-2 .qa-leaderboard-rank{background:#94a3b8;color:#fff}
      .qa-leaderboard-row.rank-3 .qa-leaderboard-rank{background:#b45309;color:#fff}
      .qa-leaderboard-row.me {
        position:relative;
        background:#fff7ed;
        outline:2px solid #f59e0b;
        outline-offset:-2px;
        box-shadow:inset 5px 0 0 #f59e0b, 0 1px 0 rgba(245,158,11,.18);
      }
      .qa-leaderboard-row.me .qa-leaderboard-rank {
        background:#d97706;
        color:#fff;
      }
      .qa-leaderboard-name {
        min-width:0;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        color:#202124;
        font-size:12px;
        font-weight:950;
      }
      .qa-leaderboard-meta {
        margin-top:1px;
        color:#777;
        font-size:10px;
        font-weight:800;
      }
      .qa-leaderboard-count {
        color:#0b8043;
        font-size:12px;
        font-weight:950;
        white-space:nowrap;
      }
      .qa-leaderboard-you {
        display:inline-flex;
        margin-left:6px;
        padding:2px 6px;
        border-radius:999px;
        background:#d97706;
        color:#fff;
        font-size:10px;
        font-weight:950;
        vertical-align:2px;
        text-transform:uppercase;
        letter-spacing:.03em;
      }
      @media (max-width: 780px){
        .qa-leaderboard-grid{grid-template-columns:1fr}
        .qa-leaderboard-col{border-left:0;border-top:1px solid #eef0f2}
        .qa-leaderboard-col:first-child{border-top:0}
      }
      .qa-worker-next {
        display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 16px;
        border-radius:14px; background:#fff8e1; border:1px solid #ffe08a; margin-bottom:12px;
      }
      .qa-worker-next .meta { min-width:0; }
      .qa-worker-next .eyebrow {
        font-size:11px; font-weight:900; text-transform:uppercase; color:#7a4b00;
      }
      .qa-worker-next .addr {
        margin-top:4px; font-size:14px; font-weight:900; color:#202124;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      }
      .qa-worker-note { font-size:12px; color:#666; margin-top:6px; }
.qa-row-priority td { background:rgba(249,171,0,.06); }
.qa-row-priority td:first-child { box-shadow: inset 4px 0 0 #f9ab00; }
      .qa-priority-actions { display:flex; align-items:center; gap:6px; justify-content:flex-end; }

      /* ===== Table ===== */
      .qa-table-wrap { padding:0 18px 18px 18px; overflow:auto; flex:1; }
      .qa-table { width:100%; border-collapse:collapse; background:#fff; }
      .qa-table th {
        background:#f8f9fa; padding:10px 12px; text-align:left;
        font-size:11px; color:#555; text-transform:uppercase; border-bottom:1px solid #eee;
        white-space:nowrap;
      }
      .qa-table th.sortable {
        cursor:pointer; user-select:none; transition:background .1s ease;
      }
      .qa-table th.sortable:hover { background:#eef0f2; }
      .qa-table th .sort-icon {
        display:inline-block; margin-left:4px; font-size:9px; opacity:0.25; transition:opacity .1s ease;
      }
      .qa-table th.sortable.active { color:var(--primary); }
      .qa-table th.sortable.active .sort-icon { opacity:1; color:var(--primary); }
      .qa-table td { padding:10px 12px; border-bottom:1px solid #eee; font-size:13px; vertical-align:middle; }
      .qa-table tr:hover td { background:#fafafa; }
      .qa-table td.addr-cell { max-width:280px; }
      .qa-table td.addr-cell strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .qa-table td.nowrap { white-space:nowrap; }
      .qa-table td.muted { color:#888; font-size:12px; }
      .qa-score-cell { position:relative; overflow:visible; }
      .qa-score-wrap {
        position:relative; display:inline-flex; align-items:center; justify-content:center;
      }
      .qa-score-pill {
        display:inline-flex; align-items:center; justify-content:center;
        min-width:42px; height:24px; padding:0 10px; border-radius:999px;
        border:1px solid #dfe3ea; background:#f8fafc; color:#202124;
        font-size:12px; font-weight:950; line-height:1; cursor:default;
        box-shadow:inset 0 1px 0 rgba(255,255,255,.65);
      }
      .qa-score-pill.low { background:#eaf7ef; color:#137333; border-color:#c8e6c9; }
      .qa-score-pill.medium { background:#fff7e0; color:#7a4b00; border-color:#f9d978; }
      .qa-score-pill.high { background:#fce8e6; color:#9c1b1b; border-color:#f1b7b2; }
      .qa-score-pill.unavailable { background:#f1f3f4; color:#777; border-color:#e0e0e0; }
      .qa-score-tooltip { display:none; }
      .qa-score-floating-tooltip {
        position:fixed;
        width:218px; padding:10px 11px; border-radius:8px;
        background:#202124; color:#fff; box-shadow:0 12px 30px rgba(32,33,36,.22);
        opacity:0; visibility:hidden; pointer-events:none; z-index:10000;
        transition:opacity .12s ease, transform .12s ease, visibility .12s ease;
        transform:translateY(-3px);
        white-space:normal; text-align:left;
      }
      .qa-score-floating-tooltip.show {
        opacity:1; visibility:visible; transform:translateY(0);
      }
      .qa-score-floating-tooltip::before {
        content:""; position:absolute; top:-5px; left:var(--qa-score-arrow-x, 50%); width:10px; height:10px;
        background:#202124; transform:translateX(-50%) rotate(45deg);
      }
      .qa-score-floating-tooltip.above::before {
        top:auto; bottom:-5px;
      }
      .qa-score-floating-tooltip .score-head {
        display:flex; justify-content:space-between; gap:10px; align-items:baseline;
        padding-bottom:7px; margin-bottom:7px; border-bottom:1px solid rgba(255,255,255,.16);
      }
      .qa-score-floating-tooltip .score-head span { color:#cbd5e1; font-size:10px; font-weight:900; text-transform:uppercase; }
      .qa-score-floating-tooltip .score-head b { font-size:15px; font-weight:950; }
      .qa-score-floating-tooltip .score-line {
        display:flex; justify-content:space-between; gap:12px; align-items:center;
        font-size:12px; line-height:1.45;
      }
      .qa-score-floating-tooltip .score-line + .score-line { margin-top:4px; }
      .qa-score-floating-tooltip .score-line .k { color:#cbd5e1; }
      .qa-score-floating-tooltip .score-line .v { font-weight:900; color:#fff; }
      .qa-score-floating-tooltip .score-note {
        margin-top:7px; padding-top:7px; border-top:1px solid rgba(255,255,255,.16);
        color:#cbd5e1; font-size:11px; line-height:1.35;
      }

      /* Claim status styles */
      .qa-table tr.claimed-by-self td { background: #e8f0fe; }
      .qa-table tr.claimed-by-self:hover td { background: #d2e3fc; }
      .qa-table tr.claimed-by-other td { background: #f5f5f5; opacity: 0.7; }
      .qa-table tr.claimed-by-other:hover td { background: #f0f0f0; }
      .qa-table tr.released td { background: #fffbea; }
      .qa-table tr.released:hover td { background: #fff7d6; }

      .qa-claim-indicator {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 3px 8px; border-radius: 999px; font-size: 10px;
        font-weight: 900; text-transform: uppercase; margin-left: 6px;
      }
      .qa-claim-indicator.yours { background: #e8f0fe; color: #1a73e8; border: 1px solid #d2e3fc; }
      .qa-claim-indicator.available { background: #e6f4ea; color: #137333; border: 1px solid #c8e6c9; }
      .qa-claim-indicator.released { background: #fff7e0; color: #7a4b00; border: 1px solid #fbbc04; }
      .qa-claim-indicator.locked { background: #f1f3f4; color: #5f6368; border: 1px solid #dadce0; }

      .qa-btn.disabled-claim {
        opacity: 0.4; cursor: not-allowed; pointer-events: none;
        background: #e0e0e0; border-color: #ccc; color: #888;
      }

      .qa-badge { padding:3px 8px; border-radius:999px; font-size:10px; font-weight:900; text-transform:uppercase; display:inline-flex; align-items:center; gap:6px; }
      .qa-badge.pending { background:#fff7e0; color:#7a4b00; border:1px solid #fbbc04; }
      .qa-badge.approved { background:#e6f4ea; color:#137333; border:1px solid #c8e6c9; }
      .qa-badge.correction { background:#fce8e6; color:#b0261e; border:1px solid #f1b7b2; }
      .qa-badge.processing { background:#f1f3f4; color:#5f6368; border:1px solid #dadce0; }
      .qa-badge.filler { background:#e8f0fe; color:#1a73e8; border:1px solid #d2e3fc; }
      .qa-badge.pending-rejection { background:#fce8e6; color:#9c1b1b; border:1px solid #f1b7b2; }
      .qa-badge.submission-failed { background:#b3261e; color:#fff; border:1px solid #7f1d1d; box-shadow:0 0 0 2px rgba(179,38,30,.16); }
      .qa-badge.rejected { background:#f1f3f4; color:#5f6368; border:1px solid #dadce0; }
      .qa-badge.manager-review { background:#ede7f6; color:#5e35b1; border:1px solid #d1c4e9; }
      .qa-badge.customer-rework { background:#fbf7ff; color:#5e1681; border:1px solid #d7b7ff; }
      .qa-btn {
        border:1px solid var(--border); background:#fff; padding:8px 10px;
        border-radius:10px; font-weight:900; cursor:pointer;
        display:inline-flex; align-items:center; gap:8px;
        transition: transform .08s ease, box-shadow .12s ease, background .12s ease, border-color .12s ease;
        user-select:none;
      }
      .qa-btn:hover { box-shadow:0 8px 20px rgba(0,0,0,0.08); transform: translateY(-1px); }
      .qa-btn.primary { background: var(--primary); border-color: var(--primary); color:#fff; }
      .qa-btn.primary:hover { background:#b0261e; border-color:#b0261e; }
      .qa-btn:disabled { opacity:0.55; cursor:not-allowed; transform:none; box-shadow:none; }
      .qa-btn.sm { padding:6px 10px; border-radius:9px; font-size:12px; }
      .qa-btn.ghost { background:#f8f9fa; border-color:#e9eaee; color:#333; }
      .qa-btn.secondary { background:#fff; border:1px solid #1a73e8; color:#1a73e8; }
      .qa-btn.secondary:hover { background:#e8f0fe; border-color:#1967d2; color:#1967d2; }
      .qa-btn.success { background:#34a853; border-color:#34a853; color:#fff; }
      .qa-btn.success:hover { background:#2d8e47; }
      .qa-btn.danger { background:#d93025; border-color:#d93025; color:#fff; }
      .qa-btn.danger:hover { background:#b0261e; }
      .qa-btn.warning { background:#f9ab00; border-color:#f9ab00; color:#fff; }
      .qa-btn.warning:hover { background:#e69500; }
      .qa-btn.manager { background:#5e35b1; border-color:#5e35b1; color:#fff; }
      .qa-btn.manager:hover { background:#4527a0; }
      .qa-deck { position:relative; flex:1; overflow:hidden; min-height:0; }
      .qa-slide { position:absolute; inset:0; display:flex; flex-direction:column; transform: translateX(0); opacity:1;
        transition: transform 260ms cubic-bezier(.2,.9,.2,1), opacity 220ms ease; will-change: transform, opacity; }
      .qa-slide.hidden { pointer-events:none; opacity:0; }
      .qa-slide.list.hidden { transform: translateX(-16px); }
      .qa-slide.checklist { transform: translateX(16px); opacity:0; pointer-events:none; }
      .qa-slide.checklist.show { transform: translateX(0); opacity:1; pointer-events:auto; }
      .qa-check-head { padding:16px 18px; border-bottom:1px solid #eee; background:#fff; display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .qa-check-head .left { display:flex; align-items:center; gap:10px; min-width:0; }
      .qa-check-head .addr { font-weight:950; color:#202124; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width: 380px; }
      .qa-check-head .sub { font-size:11px; color:#777; font-weight:800; }
      .qa-check-head .meta { display:flex; flex-direction:column; min-width:0; }
      .qa-check-body { padding:0; overflow:auto; flex:1; background: linear-gradient(180deg, #ffffff 0%, #fafafa 100%); }
      
      /* Submission sources panel */
      .qa-submission-sources {
        margin: 14px 18px; padding: 14px 16px;
        border: 1px solid #d2e3fc; border-radius: 12px; background: #f0f6ff;
      }
      .qa-submission-sources .ss-header {
        display: flex; align-items: center; gap: 8px;
        font-weight: 900; font-size: 13px; color: #1a73e8;
        margin-bottom: 10px; cursor: pointer; user-select: none;
      }
      .qa-submission-sources .ss-header .toggle-icon {
        margin-left: auto; font-size: 11px; color: #999; transition: transform .15s ease;
      }
      .qa-submission-sources.collapsed .ss-body { display: none; }
      .qa-submission-sources.collapsed .ss-header .toggle-icon { transform: rotate(-90deg); }
      .qa-submission-sources .ss-notes {
        font-size: 13px; line-height: 1.5; color: #333; white-space: pre-wrap;
        padding: 10px 12px; background: #fff; border: 1px solid #e0e0e0;
        border-radius: 8px; margin-bottom: 10px;
      }
      .qa-submission-sources .ss-images { display: flex; flex-wrap: wrap; gap: 8px; }
      .qa-submission-sources .ss-images img {
        max-width: 180px; max-height: 140px; border-radius: 8px;
        border: 1px solid #e0e0e0; cursor: pointer; transition: transform .1s ease; background: #fff;
      }
      .qa-submission-sources .ss-images img:hover { transform: scale(1.03); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
      .qa-submission-sources .ss-meta { font-size: 11px; color: #777; margin-top: 8px; }
      .qa-submission-sources .ss-empty { font-size: 12px; color: #999; font-style: italic; }

      /* Rejection review panel */
      .qa-rejection-review {
        margin: 14px 18px; padding: 16px;
        border: 2px solid #f1b7b2; border-radius: 12px; background: #fef7f6;
      }
      .qa-rejection-review .rr-header {
        display: flex; align-items: center; gap: 8px;
        font-weight: 900; font-size: 14px; color: #b0261e; margin-bottom: 12px;
      }
      .qa-rejection-review .rr-header i { font-size: 16px; }
      .qa-rejection-review .rr-meta {
        font-size: 12px; color: #666; margin-bottom: 12px; line-height: 1.5;
      }
      .qa-rejection-review .rr-meta strong { color: #333; }
      .qa-rejection-review .rr-reasons { margin-bottom: 12px; }
      .qa-rejection-review .rr-reasons-label {
        font-size: 11px; font-weight: 900; text-transform: uppercase; color: #555; margin-bottom: 6px;
      }
      .qa-rejection-review .rr-reason-item {
        display: flex; align-items: center; gap: 8px; padding: 8px 12px;
        background: #fff; border: 1px solid #f1b7b2; border-radius: 8px;
        margin-bottom: 6px; font-size: 13px; color: #333;
      }
      .qa-rejection-review .rr-reason-item i { color: #d93025; font-size: 12px; }
      .qa-rejection-review .rr-notes {
        font-size: 13px; line-height: 1.5; color: #333; white-space: pre-wrap;
        padding: 10px 12px; background: #fff; border: 1px solid #e0e0e0;
        border-radius: 8px; margin-bottom: 14px;
      }
      .qa-rejection-review .rr-notes-label {
        font-size: 11px; font-weight: 900; text-transform: uppercase; color: #555; margin-bottom: 6px;
      }
      .qa-rejection-review .rr-review-notes textarea {
        width: 100%; min-height: 80px; border: 1px solid #d0d0d0;
        border-radius: 10px; padding: 10px 12px; font-family: inherit;
        font-size: 13px; resize: vertical; box-sizing: border-box; margin-bottom: 12px;
      }
      .qa-rejection-review .rr-review-notes textarea:focus { border-color: #1a73e8; outline: none; box-shadow: 0 0 0 3px rgba(26,115,232,0.1); }
      .qa-rejection-review .rr-actions { display: flex; gap: 10px; }
      .qa-rejection-review .rr-actions .qa-btn { flex: 1; justify-content: center; }

      /* Category sections */
      .qa-category { border-bottom: 1px solid #eee; }
      .qa-category:last-child { border-bottom: none; }
      .qa-category-header {
        display: flex; align-items: center; gap: 10px; padding: 14px 18px;
        background: #f8f9fa; cursor: pointer; user-select: none;
        font-weight: 900; font-size: 13px; color: #333; border-bottom: 1px solid #eee;
      }
      .qa-category-header:hover { background: #f0f1f2; }
      .qa-category-header .icon { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; background: rgba(26,115,232,0.1); color: #1a73e8; border-radius: 8px; }
      .qa-category-header .count { margin-left: auto; font-size: 11px; color: #777; }
      .qa-category-header .count.has-issues { color: var(--primary); }
      .qa-category-items { padding: 12px 18px; display: flex; flex-direction: column; gap: 10px; }
      .qa-category.collapsed .qa-category-items { display: none; }

      /* Checklist items */
      .qa-check-item {
        border: 1px solid #e0e0e0; border-radius: 12px; background: #fff;
        overflow: hidden; transition: box-shadow .12s ease, border-color .12s ease;
      }
      .qa-check-item:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
      .qa-check-item.has-thread { border-color: var(--primary); border-width: 2px; }
      .qa-check-item.has-thread.resolved { border-color: #34a853; }
      .qa-check-item-header {
        display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: pointer;
      }
      .qa-check-item-header .label { flex: 1; font-weight: 800; font-size: 13px; color: #333; }
      .qa-check-item-header .hint { font-size: 11px; color: #777; font-weight: 600; margin-top: 2px; }
      .qa-check-item-header .status-badge {
        padding: 4px 10px; border-radius: 999px; font-size: 10px; font-weight: 900; text-transform: uppercase;
      }
      .qa-check-item-header .status-badge.open { background: #fce8e6; color: #b0261e; }
      .qa-check-item-header .status-badge.disputed { background: #fff7e0; color: #7a4b00; }
      .qa-check-item-header .status-badge.fixed { background: #e8f0fe; color: #1a73e8; }
      .qa-check-item-header .status-badge.resolved { background: #e6f4ea; color: #137333; }
      .qa-check-item-header .status-badge.closed { background: #f1f3f4; color: #5f6368; }
      .qa-check-item-header .toggle-btn {
        width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
        border: 1px solid #e0e0e0; border-radius: 8px; background: #fff;
        cursor: pointer; color: #777; transition: all .12s ease;
      }
      .qa-check-item-header .toggle-btn:hover { background: #f8f9fa; color: #333; }
      .qa-check-item-header .toggle-btn.active { background: var(--primary); border-color: var(--primary); color: #fff; }
      
      /* Thread panel */
      .qa-thread-panel { display: none; border-top: 1px solid #eee; background: #fafafa; padding: 14px; }
      .qa-check-item.expanded .qa-thread-panel { display: block; }
      
      /* Thread history */
      .qa-thread-history {
        max-height: 400px; overflow-y: auto; margin-bottom: 14px;
        display: flex; flex-direction: column; gap: 12px;
      }
      .qa-thread-message { padding: 12px; border-radius: 10px; background: #fff; border: 1px solid #e0e0e0; }
      .qa-thread-message.qa { border-left: 4px solid var(--primary); }
      .qa-thread-message.drafter { border-left: 4px solid #1a73e8; }
      .qa-thread-message.manager { border-left: 4px solid #5e35b1; }
      .qa-thread-message .header {
        display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 11px; color: #777;
      }
      .qa-thread-message .header .name { font-weight: 900; color: #333; }
      .qa-thread-message .header .role { padding: 2px 6px; border-radius: 4px; font-weight: 800; text-transform: uppercase; font-size: 9px; }
      .qa-thread-message .header .role.qa { background: #fce8e6; color: #b0261e; }
      .qa-thread-message .header .role.drafter { background: #e8f0fe; color: #1a73e8; }
      .qa-thread-message .header .role.manager { background: #ede7f6; color: #5e35b1; }
      .qa-thread-message .text { font-size: 13px; line-height: 1.5; color: #333; white-space: pre-wrap; }
      .qa-thread-message .images { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .qa-thread-message .images img {
        max-width: 200px; max-height: 150px; border-radius: 8px;
        border: 1px solid #e0e0e0; cursor: pointer; transition: transform .1s ease;
      }
      .qa-thread-message .images img:hover { transform: scale(1.02); }
      .qa-thread-message .action-badge {
        display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px;
        border-radius: 6px; font-size: 10px; font-weight: 800; margin-top: 8px;
      }
      .qa-thread-message .action-badge.marked_fixed { background: #e8f0fe; color: #1a73e8; }
      .qa-thread-message .action-badge.disputed { background: #fff7e0; color: #7a4b00; }
      .qa-thread-message .action-badge.resolved { background: #e6f4ea; color: #137333; }
      .qa-thread-message .action-badge.closed { background: #f1f3f4; color: #5f6368; }
      
      /* Reply composer */
      .qa-reply-composer { display: flex; flex-direction: column; gap: 10px; }
      .qa-reply-composer textarea {
        width: 100%; min-height: 120px; border: 1px solid #d0d0d0;
        border-radius: 10px; padding: 12px; font-family: inherit;
        font-size: 13px; resize: vertical; box-sizing: border-box;
      }
      .qa-reply-composer textarea:focus { border-color: #1a73e8; outline: none; box-shadow: 0 0 0 3px rgba(26,115,232,0.1); }
      .qa-reply-composer .image-upload-area { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .qa-reply-composer .upload-btn {
        display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px;
        border: 1px dashed #ccc; border-radius: 8px; background: #fff;
        cursor: pointer; font-size: 12px; font-weight: 700; color: #666; transition: all .12s ease;
      }
      .qa-reply-composer .upload-btn:hover { border-color: #1a73e8; color: #1a73e8; background: #f8f9fa; }
      .qa-reply-composer .preview-images { display: flex; gap: 8px; flex-wrap: wrap; }
      .qa-reply-composer .preview-images .preview-img {
        position: relative; width: 80px; height: 80px; border-radius: 8px;
        overflow: hidden; border: 1px solid #e0e0e0;
      }
      .qa-reply-composer .preview-images .preview-img img { width: 100%; height: 100%; object-fit: cover; }
      .qa-reply-composer .preview-images .preview-img .remove {
        position: absolute; top: 4px; right: 4px; width: 20px; height: 20px;
        background: rgba(0,0,0,0.6); border-radius: 50%; display: flex;
        align-items: center; justify-content: center; color: #fff; font-size: 10px; cursor: pointer;
      }
      .qa-reply-composer .actions { display: flex; gap: 8px; justify-content: flex-end; }
      
      .qa-quick-actions { display: flex; gap: 8px; margin-top: 10px; }
      
      /* Actions panel */
      .qa-actions-panel {
        position: sticky; bottom: 0; background: #fff; border-top: 1px solid #eee;
        padding: 14px 18px; display: flex; flex-direction: column; gap: 10px;
        box-shadow: 0 -4px 12px rgba(0,0,0,0.04);
      }
      .qa-actions-panel .summary {
        display: flex; gap: 16px; font-size: 12px; color: #666;
        padding: 10px 14px; background: #f8f9fa; border-radius: 10px;
      }
      .qa-actions-panel .summary .item { display: flex; align-items: center; gap: 6px; }
      .qa-actions-panel .summary .item .dot { width: 8px; height: 8px; border-radius: 50%; }
      .qa-actions-panel .summary .item .dot.open { background: var(--primary); }
      .qa-actions-panel .summary .item .dot.resolved { background: #34a853; }
      .qa-actions-panel .summary .item .dot.disputed { background: #fbbc04; }
      .qa-actions-panel .buttons { display: flex; gap: 10px; }
      .qa-actions-panel .buttons .qa-btn { flex: 1; justify-content: center; }

      /* Resolve-all row */
      .qa-resolve-all-row { display: flex; gap: 10px; padding-top: 2px; }
      .qa-resolve-all-row .qa-btn { flex: 1; justify-content: center; font-size: 12px; }
      
      .qa-utility-actions { margin-top:8px; padding-top:8px; border-top:1px solid #eee; display:flex; gap:8px; }
      
      /* Right panel styles */
      .qa-right-inner { position: relative; display: flex; flex: 1; height: 100%; padding: 14px; box-sizing: border-box; }
      .qa-right-split {
        --qaSplit: 50%;
        position: relative; display: flex; flex: 1; min-height: 0;
        border-radius: 14px; overflow: hidden;
        border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.08);
      }
      .qa-pane { position: relative; min-width: 160px; min-height: 0; display: flex; flex-direction: column; }
      .qa-pane.pdf { flex: 0 0 var(--qaSplit); }
      .qa-pane.stack, .qa-pane.map { flex: 1 1 auto; min-width: 280px; }
      .qa-stack { display:flex; flex-direction:column; flex:1; min-height:0; }
      .qa-stack-pane { flex:1 1 50%; min-height:0; display:flex; flex-direction:column; border-bottom:1px solid rgba(255,255,255,0.12); }
      .qa-stack-pane:last-child { border-bottom:none; }
      .qa-pane-head {
        height: 44px; flex-shrink: 0; display: flex; align-items: center;
        justify-content: space-between; gap: 10px; padding: 0 12px;
        background: rgba(255,255,255,0.08); border-bottom: 1px solid rgba(255,255,255,0.12);
        color: rgba(255,255,255,0.92); font-weight: 950; font-size: 12px;
        letter-spacing: .2px; user-select: none;
      }
      .qa-pane-body {
        flex: 1; min-height: 0; width: 100%; height: 100%;
        display: block; position: relative; background: #525659;
      }
      .qa-pane-body iframe { width:100%; height:100%; border:none; display:block; background:#525659; }
      .qa-pdf-viewer { position:absolute; inset:0; display:flex; flex-direction:column; min-height:0; background:#4e5256; }
      .qa-pdf-main { flex:1; min-height:0; overflow:auto; display:flex; justify-content:center; align-items:flex-start; padding:18px; box-sizing:border-box; }
      .qa-pdf-main canvas { background:#fff; box-shadow:0 3px 18px rgba(0,0,0,0.34); max-width:100%; height:auto; }
      .qa-pdf-page-wrap { position:relative; display:inline-flex; }
      .qa-pdf-disabled-wash { position:absolute; inset:0; background:rgba(240,242,245,.68); display:none; align-items:center; justify-content:center; color:#222; font-weight:950; font-size:18px; text-align:center; pointer-events:none; }
      .qa-pdf-page-wrap.disabled .qa-pdf-disabled-wash { display:flex; }
      .qa-pdf-live-topview { position:absolute; z-index:2; background:#fff; box-shadow:0 0 0 1px rgba(0,0,0,.08); object-fit:cover; pointer-events:none; }
      .qa-pdf-empty { margin:auto; color:rgba(255,255,255,0.75); font-size:12px; font-weight:850; text-align:center; }
      .qa-pdf-thumbs { height:102px; flex:0 0 102px; display:flex; gap:8px; align-items:center; overflow-x:auto; padding:9px 10px; box-sizing:border-box; background:rgba(22,24,28,0.82); border-top:1px solid rgba(255,255,255,0.13); }
      .qa-pdf-thumb { position:relative; flex:0 0 auto; width:56px; height:78px; border:2px solid transparent; border-radius:7px; background:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; padding:0; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.24); }
      .qa-pdf-thumb:hover { border-color:rgba(255,255,255,0.42); }
      .qa-pdf-thumb.active { border-color:#8ab4f8; box-shadow:0 0 0 2px rgba(138,180,248,0.2), 0 2px 8px rgba(0,0,0,0.3); }
      .qa-pdf-thumb canvas { width:100%; height:100%; object-fit:contain; display:block; background:#fff; }
      .qa-pdf-thumb span { position:absolute; right:3px; bottom:3px; min-width:15px; height:15px; padding:0 3px; border-radius:4px; background:rgba(0,0,0,0.68); color:#fff; font-size:9px; font-weight:900; line-height:15px; text-align:center; }
      .qa-reference-strip { flex:0 0 auto; display:none; gap:10px; align-items:center; padding:9px 10px; box-sizing:border-box; background:rgba(9,11,14,0.92); border-top:1px solid rgba(255,255,255,0.12); color:#fff; }
      .qa-reference-strip.show { display:flex; }
      .qa-reference-strip.embedded { display:none !important; border-top:0; border-bottom:1px solid rgba(0,0,0,.08); background:#202124; min-height:82px; }
      .qa-wrap:not(.embedded-mode) .qa-reference-strip.embedded { display:none !important; }
      .qa-reference-label { flex:0 0 auto; min-width:92px; max-width:132px; display:flex; flex-direction:column; gap:2px; font-size:10px; font-weight:950; letter-spacing:.25px; text-transform:uppercase; color:rgba(255,255,255,.86); }
      .qa-reference-label span { font-size:10px; font-weight:800; text-transform:none; color:rgba(255,255,255,.58); letter-spacing:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .qa-reference-note-btn { flex:0 0 auto; border:1px solid rgba(138,180,248,.42); background:rgba(138,180,248,.12); color:#d2e3fc; height:62px; min-width:86px; max-width:122px; border-radius:8px; cursor:pointer; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px; font-size:10px; font-weight:950; }
      .qa-reference-note-btn:hover { background:rgba(138,180,248,.2); border-color:rgba(138,180,248,.72); }
      .qa-reference-thumbs { display:flex; gap:8px; align-items:center; overflow-x:auto; min-width:0; flex:1 1 auto; padding-bottom:2px; }
      .qa-reference-thumb { position:relative; flex:0 0 auto; width:72px; height:62px; border:2px solid transparent; border-radius:8px; overflow:hidden; padding:0; background:#25282d; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.24); }
      .qa-reference-thumb:hover { border-color:rgba(255,255,255,.48); }
      .qa-reference-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
      .qa-reference-thumb .idx { position:absolute; right:3px; bottom:3px; min-width:16px; height:16px; padding:0 4px; border-radius:5px; background:rgba(0,0,0,.72); color:#fff; font-size:9px; font-weight:950; line-height:16px; text-align:center; }
      .qa-reference-empty { display:flex; align-items:center; gap:8px; color:rgba(255,255,255,.58); font-size:11px; font-weight:850; }
      .qa-pdf-tools { display:flex; align-items:center; gap:6px; min-width:0; }
      .qa-pdf-tool { border:1px solid rgba(255,255,255,0.24); background:rgba(0,0,0,0.2); color:rgba(255,255,255,0.86); border-radius:7px; padding:4px 7px; font-size:10px; font-weight:900; cursor:pointer; }
      .qa-pdf-tool:hover { background:rgba(255,255,255,0.12); color:#fff; }
      .qa-pdf-tool.active { background:rgba(26,115,232,0.26); border-color:rgba(138,180,248,0.62); color:#8ab4f8; }
      .qa-pdf-tool:disabled { opacity:.45; cursor:not-allowed; }
      .qa-pdf-config { display:block; flex:0 0 172px; height:172px; padding:12px; box-sizing:border-box; background:#f8fafc; border-bottom:1px solid rgba(20,27,38,0.16); color:#202124; overflow:hidden; box-shadow:inset 0 -1px 0 rgba(255,255,255,.72); }
      .qa-pdf-config.show { display:block; }
      .qa-pdf-config-inner { height:100%; display:flex; flex-direction:column; gap:10px; }
      .qa-pdf-setting-row { display:flex; align-items:center; gap:12px; min-height:34px; padding:0 2px; }
      .qa-pdf-setting-row label { flex:0 0 auto; min-width:72px; font-size:10px; font-weight:950; color:#4b5563; text-transform:uppercase; letter-spacing:.04em; }
      .qa-pdf-setting-row input[type=range] { width:100%; height:4px; accent-color:#1a73e8; cursor:pointer; }
      .qa-pdf-config-value { flex:0 0 46px; font-size:11px; font-weight:950; color:#1558c0; text-align:right; padding:4px 6px; border-radius:7px; background:#eef5ff; border:1px solid #d7e8ff; }
      .qa-pdf-source-strip { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px; height:80px; }
      .qa-pdf-source-strip .qa-pdf-empty { grid-column:1 / -1; align-self:center; justify-self:center; color:#667085; background:#eef2f6; border:1px dashed #cfd7e2; border-radius:8px; padding:11px 14px; }
      .qa-pdf-source-card { border:1px solid #d7dde6; background:#e7ebf0; border-radius:8px; overflow:hidden; padding:0; cursor:pointer; position:relative; box-shadow:0 1px 2px rgba(16,24,40,.08); transition:border-color .12s ease, box-shadow .12s ease, transform .12s ease, opacity .12s ease; }
      .qa-pdf-source-card img { width:100%; height:100%; object-fit:cover; display:block; filter:saturate(.98) contrast(1.01); }
      .qa-pdf-source-card:hover { border-color:#8db8f6; box-shadow:0 4px 12px rgba(26,115,232,.16); transform:translateY(-1px); }
      .qa-pdf-source-card.active { border-color:#1a73e8; box-shadow:0 0 0 2px rgba(26,115,232,.18), 0 4px 12px rgba(16,24,40,.14); }
      .qa-pdf-source-card.active::after { content:''; position:absolute; inset:0; box-shadow:inset 0 0 0 2px rgba(255,255,255,.88); pointer-events:none; }
      .qa-pdf-source-card:disabled { opacity:.32; cursor:not-allowed; }
      .qa-pdf-config-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:auto; padding-top:2px; }
      .qa-pdf-config .qa-pdf-tool { border:1px solid #d6dce5; background:#fff; color:#344054; border-radius:8px; padding:6px 10px; font-size:11px; box-shadow:0 1px 2px rgba(16,24,40,.06); }
      .qa-pdf-config .qa-pdf-tool:hover { background:#f2f6fb; border-color:#b8c4d6; color:#111827; box-shadow:0 3px 8px rgba(16,24,40,.09); }
      .qa-pdf-config .qa-pdf-tool.active { background:#1a73e8; border-color:#1a73e8; color:#fff; box-shadow:0 4px 10px rgba(26,115,232,.24); }
      .qa-pdf-config-note { font-size:11px; color:#667085; line-height:1.35; background:#eef2f6; border:1px solid #dde4ee; border-radius:8px; padding:8px 10px; }
      .qa-pdf-page-toggle { display:inline-flex; align-items:center; gap:10px; min-height:34px; padding:6px 10px; border-radius:8px; background:#fff; border:1px solid #d7dde6; font-size:11px; font-weight:950; color:#344054; cursor:pointer; box-shadow:0 1px 2px rgba(16,24,40,.06); }
      .qa-pdf-page-toggle:hover { border-color:#b8c4d6; background:#fbfcfe; }
      .qa-pdf-switch { width:36px; height:20px; border-radius:999px; background:#c7ced8; position:relative; flex:0 0 auto; transition:background .14s ease; }
      .qa-pdf-switch::after { content:''; position:absolute; width:16px; height:16px; border-radius:50%; background:#fff; top:2px; left:2px; box-shadow:0 1px 3px rgba(0,0,0,.24); transition:transform .14s ease; }
      .qa-pdf-page-toggle.on .qa-pdf-switch { background:#1a73e8; }
      .qa-pdf-page-toggle.on .qa-pdf-switch::after { transform:translateX(16px); }
      .qa-pdf-segment { display:inline-grid; grid-template-columns:1fr 1fr; border:1px solid #d7dde6; border-radius:8px; overflow:hidden; background:#eef2f6; padding:2px; box-shadow:inset 0 1px 2px rgba(16,24,40,.06); }
      .qa-pdf-segment button { border:0; background:transparent; border-radius:6px; padding:6px 12px; font-size:11px; font-weight:950; cursor:pointer; color:#536173; }
      .qa-pdf-segment button.active { background:#fff; color:#1558c0; box-shadow:0 1px 2px rgba(16,24,40,.12); }
      .qa-pdf-structure-summary { display:flex; align-items:center; gap:5px; min-height:28px; font-size:11px; font-weight:850; color:#475467; }
      .qa-pdf-structure-summary strong { color:#1558c0; font-weight:950; }
      .qa-pdf-structure-list { display:flex; gap:8px; overflow-x:auto; padding-bottom:2px; min-height:96px; }
      .qa-pdf-structure-card { flex:0 0 178px; display:grid; grid-template-rows:auto auto 1fr; gap:7px; padding:9px; border:1px solid #d7dde6; border-radius:8px; background:#fff; box-shadow:0 1px 2px rgba(16,24,40,.06); }
      .qa-pdf-structure-card.off { opacity:.56; background:#f1f4f8; }
      .qa-pdf-structure-include { display:flex; align-items:center; gap:7px; font-size:11px; font-weight:950; color:#344054; }
      .qa-pdf-structure-card select { width:100%; min-width:0; border:1px solid #d7dde6; border-radius:7px; padding:5px 7px; font-size:11px; font-weight:800; color:#344054; background:#fff; }
      .qa-pdf-structure-card span { font-size:10px; font-weight:850; color:#667085; }
      .qa-pdf-vent-editor { position:absolute; inset:0; z-index:3; pointer-events:none; }
      .qa-pdf-vent-editor.on { pointer-events:auto; cursor:crosshair; }
      .qa-pdf-vent-editor.modal { inset:0 !important; left:0 !important; top:0 !important; width:auto !important; height:auto !important; z-index:6; display:flex; align-items:center; justify-content:center; padding:22px; box-sizing:border-box; background:rgba(18,22,28,.74); pointer-events:auto; cursor:default; }
      .qa-pdf-vent-modal { width:min(90vw, 1180px); max-height:96%; display:flex; flex-direction:column; gap:10px; }
      .qa-pdf-vent-modal-head { height:34px; display:flex; align-items:center; justify-content:space-between; color:#fff; font-size:12px; font-weight:950; }
      .qa-pdf-vent-count { display:flex; align-items:center; gap:12px; color:rgba(255,255,255,.86); font-size:12px; font-weight:850; }
      .qa-pdf-vent-count strong { color:#fff; font-weight:950; }
      .qa-pdf-vent-stage { position:relative; width:100%; max-height:calc(100vh - 230px); overflow:hidden; align-self:center; background:#fff; border-radius:8px; box-shadow:0 10px 34px rgba(0,0,0,.42); cursor:none; }
      .qa-pdf-vent-stage img { display:block; width:100%; max-height:calc(100vh - 230px); height:auto; object-fit:contain; }
      .qa-pdf-vent-ridges { position:absolute; inset:0; width:100%; height:100%; pointer-events:auto; }
      .qa-pdf-vent-ridge-hit { pointer-events:stroke; cursor:pointer; fill:none; stroke:rgba(255,255,255,0); stroke-width:22; stroke-linecap:round; }
      .qa-pdf-vent-ridge-line { fill:none; stroke:#e53935; stroke-width:6; stroke-linecap:round; pointer-events:none; filter:drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
      .qa-pdf-vent-ridge-line.off { stroke:rgba(160,70,70,.42); stroke-width:5; }
      .qa-pdf-boxvent { position:absolute; width:8px; height:8px; border-radius:2px; background:#ff9800; border:1px solid #fff; box-shadow:0 1px 4px rgba(0,0,0,.35); transform:translate(-50%,-50%); cursor:grab; pointer-events:auto; }
      .qa-pdf-boxvent:active { cursor:grabbing; }
      .qa-pdf-boxvent.ghost { opacity:.48; pointer-events:none; display:none; cursor:none; }
      .qa-live-map-stage {
        position:absolute; inset:0; display:block;
      }
      .qa-live-map-stage.hidden {
        display:none;
      }
      .qa-image-stage {
        width:100%; height:100%; display:flex; align-items:center; justify-content:center;
        overflow:hidden; position:relative;
        background: radial-gradient(circle at top, #2f3136 0%, #1f2023 78%);
      }
      .qa-image-stage.interactive { cursor: grab; }
      .qa-image-stage.interactive.dragging { cursor: grabbing; }
      .qa-image-content {
        position:absolute; top:0; left:0; transform-origin:0 0;
        will-change: transform;
      }
      .qa-image-content canvas {
        position:absolute; top:0; left:0; display:block;
      }
      .qa-image-content canvas {
        background:#2d2f33;
      }
      #qaImageOverlay {
        position:absolute; inset:0; display:block;
        overflow:visible; pointer-events:none;
        z-index:2;
      }
      .qa-geo-line {
        fill:none; stroke:#74ddff; stroke-width:4.65; stroke-linecap:round; stroke-linejoin:round;
        vector-effect: non-scaling-stroke;
      }
      .qa-geo-point {
        fill:#ffffff; stroke:#0f1720; stroke-width:1.35; vector-effect: non-scaling-stroke;
      }
      .qa-image-legend {
        position:absolute; right:10px; bottom:10px; z-index:4;
        min-width:140px; max-width:min(240px, 46%);
        padding:8px 10px; border-radius:10px;
        background:rgba(18,22,28,0.72); border:1px solid rgba(255,255,255,0.12);
        color:#fff; font-size:11px; line-height:1.35;
        backdrop-filter:blur(8px);
      }
      .qa-image-legend.hidden { display:none; }
      .qa-image-legend-title {
        font-weight:900; letter-spacing:.2px; font-size:11px; margin-bottom:6px; opacity:.92;
      }
      .qa-image-legend-list {
        display:grid; grid-template-columns:1fr; gap:4px;
      }
      .qa-image-legend-item {
        display:flex; align-items:center; gap:7px; min-width:0;
      }
      .qa-image-legend-swatch {
        width:14px; height:3px; border-radius:999px; flex:0 0 auto;
        box-shadow:0 0 0 1px rgba(255,255,255,0.16);
      }
      .qa-image-legend-label {
        min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      }
      .qa-image-tools { display:flex; align-items:center; gap:6px; margin-left:8px; }
      .qa-image-tool {
        border:1px solid rgba(255,255,255,0.24); background:rgba(0,0,0,0.2); color:rgba(255,255,255,0.86);
        border-radius:7px; padding:4px 7px; font-size:10px; font-weight:900; letter-spacing:.2px; cursor:pointer;
        transition:background .12s ease,border-color .12s ease,color .12s ease,opacity .12s ease;
      }
      .qa-image-tool:hover { background:rgba(255,255,255,0.12); border-color:rgba(255,255,255,0.38); color:#fff; }
      .qa-image-tool.active { background:rgba(26,115,232,0.26); border-color:rgba(138,180,248,0.62); color:#8ab4f8; }
      .qa-image-hud {
        position:absolute; left:10px; bottom:10px; z-index:3;
        padding:5px 8px; border-radius:8px; background:rgba(0,0,0,0.42);
        border:1px solid rgba(255,255,255,0.12); color:rgba(255,255,255,0.86);
        font-size:10px; font-weight:800; letter-spacing:.2px;
      }
      .qa-mini-tabs { display:flex; align-items:center; gap:6px; }
      .qa-mini-tab {
        border:1px solid rgba(255,255,255,0.24); background:rgba(0,0,0,0.2); color:rgba(255,255,255,0.8);
        border-radius:7px; padding:4px 7px; font-size:10px; font-weight:900; letter-spacing:.2px; cursor:pointer;
        transition:background .12s ease,border-color .12s ease,color .12s ease,opacity .12s ease;
      }
      .qa-mini-tab:hover { background:rgba(255,255,255,0.12); border-color:rgba(255,255,255,0.38); color:#fff; }
      .qa-mini-tab.active { background:rgba(26,115,232,0.26); border-color:rgba(138,180,248,0.62); color:#8ab4f8; }
      .qa-mini-tab:disabled { opacity:0.38; cursor:not-allowed; }
      .qa-image-empty {
        position:absolute; inset:0; display:none; align-items:center; justify-content:center;
        padding:18px; text-align:center; color:rgba(255,255,255,0.74); font-weight:800; font-size:12px;
      }
      .qa-image-empty.show { display:flex; }
      .qa-splitter {
        width: 10px; cursor: col-resize;
        background: rgba(255,255,255,0.07);
        border-left: 1px solid rgba(255,255,255,0.10);
        border-right: 1px solid rgba(0,0,0,0.25);
        position: relative; flex: 0 0 10px; user-select: none; touch-action: none;
      }
      .qa-splitter:before {
        content: ""; position:absolute; top: 50%; left: 50%;
        width: 4px; height: 64px; transform: translate(-50%, -50%);
        border-radius: 999px; background: rgba(255,255,255,0.35);
        box-shadow: 0 0 0 3px rgba(255,255,255,0.10);
      }
      .qa-empty {
        position:absolute; inset: 0; display:flex; flex-direction:column;
        align-items:flex-start; justify-content:flex-start; padding:18px;
        color:#fff; pointer-events:none;
      }
      .qa-drag-shield {
        position: fixed; inset: 0; z-index: 999999; display:none;
        cursor: col-resize; background: rgba(0,0,0,0.00);
      }
      .qa-drag-shield.show { display:block; }
      
      /* Image lightbox */
      .qa-lightbox {
        position: fixed; inset: 0; z-index: 100000;
        background: rgba(0,0,0,0.9); display: none;
        align-items: center; justify-content: center; padding: 40px;
      }
      .qa-lightbox.show { display: flex; }
      .qa-lightbox-shell { width:min(1180px, 100%); height:min(820px, 100%); display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:14px; align-items:stretch; }
      .qa-lightbox-main { min-width:0; min-height:0; display:flex; flex-direction:column; gap:10px; }
      .qa-lightbox-stage { position:relative; flex:1; min-height:0; display:flex; align-items:center; justify-content:center; }
      .qa-lightbox img.qa-lightbox-image { max-width: 100%; max-height: 100%; border-radius: 8px; object-fit:contain; box-shadow:0 10px 40px rgba(0,0,0,.38); }
      .qa-lightbox-nav { position:absolute; top:50%; transform:translateY(-50%); width:42px; height:52px; border:1px solid rgba(255,255,255,.22); border-radius:10px; background:rgba(0,0,0,.44); color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:18px; }
      .qa-lightbox-nav:hover { background:rgba(255,255,255,.14); }
      .qa-lightbox-nav.prev { left:0; }
      .qa-lightbox-nav.next { right:0; }
      .qa-lightbox-nav:disabled { opacity:.25; cursor:default; }
      .qa-lightbox-rail { flex:0 0 auto; display:flex; gap:8px; overflow-x:auto; padding:2px 0 4px; }
      .qa-lightbox-thumb { flex:0 0 auto; width:68px; height:54px; border:2px solid transparent; border-radius:7px; padding:0; overflow:hidden; background:#202124; cursor:pointer; }
      .qa-lightbox-thumb.active { border-color:#8ab4f8; box-shadow:0 0 0 2px rgba(138,180,248,.22); }
      .qa-lightbox-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
      .qa-lightbox-info { min-width:0; min-height:0; display:flex; flex-direction:column; gap:10px; color:#fff; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.16); border-radius:12px; padding:14px; box-sizing:border-box; }
      .qa-lightbox-title { font-size:13px; font-weight:950; color:#fff; display:flex; align-items:center; justify-content:space-between; gap:10px; }
      .qa-lightbox-count { color:rgba(255,255,255,.62); font-size:11px; font-weight:850; white-space:nowrap; }
      .qa-lightbox-notes { flex:1; min-height:0; overflow:auto; white-space:pre-wrap; font-size:13px; line-height:1.48; color:rgba(255,255,255,.88); background:rgba(0,0,0,.18); border:1px solid rgba(255,255,255,.1); border-radius:9px; padding:11px; }
      .qa-lightbox-notes.empty { color:rgba(255,255,255,.48); font-style:italic; }
      .qa-lightbox .close {
        position: absolute; top: 20px; right: 20px; width: 40px; height: 40px;
        background: rgba(255,255,255,0.1); border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        color: #fff; cursor: pointer; font-size: 18px;
      }
      @media (max-width: 900px) {
        .qa-lightbox-shell { grid-template-columns:1fr; grid-template-rows:minmax(0,1fr) auto; }
        .qa-lightbox-info { max-height:220px; }
      }

      /* History section */
      .qa-history-section { margin-top:18px; }
      .qa-history-header {
        display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:8px;
        padding:0 0 0 0;
      }
      .qa-history-header .label { font-weight:900; color:#555; }
      .qa-history-controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; color:#667085; font-size:11px; font-weight:800; }
      .qa-history-controls select {
        border:1px solid #d9dee8; border-radius:8px; background:#fff; color:#344054;
        padding:6px 8px; font:inherit;
      }
      .qa-history-controls .qa-btn { min-width:32px; justify-content:center; }
      .qa-history-controls .qa-btn[disabled] { opacity:.45; cursor:not-allowed; }
      .qa-history-page-summary { min-width:92px; text-align:center; white-space:nowrap; }

      /* Claimed section at top of pipeline */
      .qa-claimed-section {
        margin-bottom: 14px; border: 2px solid #d2e3fc; border-radius: 14px;
        background: #f5f9ff; overflow: hidden;
      }
      .qa-claimed-section-header {
        display: flex; align-items: center; gap: 10px;
        padding: 12px 18px; background: #e8f0fe; border-bottom: 1px solid #d2e3fc;
        font-weight: 900; font-size: 13px; color: #1a73e8;
      }
      .qa-claimed-section-header .icon { font-size: 15px; }
      .qa-claimed-section-header .count {
        margin-left: auto; padding: 3px 10px; border-radius: 999px;
        background: #1a73e8; color: #fff; font-size: 11px; font-weight: 900;
      }
      .qa-claimed-section .qa-table th { background: #eef3fc; }

      /* VIP_MANAGER — Manager sign-off section */
      .qa-manager-section {
        margin-bottom: 18px;
        margin-top: 22px; border: 2px solid #d1c4e9; border-radius: 14px;
        background: #faf8ff; overflow: hidden;
      }
      .qa-manager-section-header {
        display: flex; align-items: center; gap: 10px;
        padding: 14px 18px; background: #ede7f6; border-bottom: 1px solid #d1c4e9;
        font-weight: 900; font-size: 14px; color: #5e35b1;
      }
      .qa-manager-section-header .icon { font-size: 16px; }
      .qa-manager-section-header .count {
        margin-left: auto; padding: 3px 10px; border-radius: 999px;
        background: #5e35b1; color: #fff; font-size: 11px; font-weight: 900;
      }
      .qa-manager-section .qa-table th { background: #f3f0fa; }
      .qa-manager-section .qa-table td { font-size: 13px; }
      .qa-manager-section .qa-btn.primary { background: #5e35b1; border-color: #5e35b1; }
      .qa-manager-section .qa-btn.primary:hover { background: #4527a0; border-color: #4527a0; }

      /* Manager mode indicator in checklist header */
      .qa-manager-mode-pill {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 4px 12px; border-radius: 999px;
        background: #5e35b1; color: #fff; font-size: 10px; font-weight: 900;
        text-transform: uppercase; letter-spacing: 0.5px;
      }

      /* History row clickable */
      .qa-table tr.history-clickable { cursor: pointer; }
      .qa-table tr.history-clickable:hover td { background: #eef0f2; }

      /* Project detail modal */
      .qa-detail-modal-overlay {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,0.5); display: flex;
        align-items: center; justify-content: center; padding: 30px;
      }
      .qa-detail-modal {
        background: #fff; border-radius: 16px; max-width: 600px; width: 100%;
        max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.2);
      }
      .qa-detail-modal .modal-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 18px 22px; border-bottom: 1px solid #eee;
      }
      .qa-detail-modal .modal-header h3 {
        margin: 0; font-size: 16px; font-weight: 950; color: #202124;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 460px;
      }
      .qa-detail-modal .modal-close {
        width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
        border: 1px solid #e0e0e0; border-radius: 8px; background: #fff; cursor: pointer;
        color: #777; font-size: 14px; flex-shrink: 0;
      }
      .qa-detail-modal .modal-close:hover { background: #f5f5f5; color: #333; }
      .qa-detail-modal .modal-body { padding: 18px 22px; }
      .qa-detail-modal .detail-section { margin-bottom: 18px; }
      .qa-detail-modal .detail-section:last-child { margin-bottom: 0; }
      .qa-detail-modal .detail-label {
        font-size: 11px; font-weight: 900; text-transform: uppercase;
        color: #777; margin-bottom: 8px; letter-spacing: 0.3px;
      }
      .qa-detail-modal .detail-grid {
        display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px;
      }
      .qa-detail-modal .detail-item {
        font-size: 13px; color: #333; line-height: 1.5;
      }
      .qa-detail-modal .detail-item .dk { font-weight: 700; color: #555; font-size: 11px; display: block; }
      .qa-detail-modal .detail-item .dv { display: block; }
      .qa-detail-modal .timeline-item {
        display: flex; gap: 10px; padding: 10px 14px; margin-bottom: 8px;
        border: 1px solid #eee; border-radius: 10px; background: #fafafa;
        font-size: 12px; line-height: 1.5;
      }
      .qa-detail-modal .timeline-item .tl-icon {
        width: 28px; height: 28px; border-radius: 8px; display: flex;
        align-items: center; justify-content: center; flex-shrink: 0;
        font-size: 11px;
      }
      .qa-detail-modal .timeline-item .tl-icon.green { background: #e6f4ea; color: #137333; }
      .qa-detail-modal .timeline-item .tl-icon.blue { background: #e8f0fe; color: #1a73e8; }
      .qa-detail-modal .timeline-item .tl-icon.red { background: #fce8e6; color: #b0261e; }
      .qa-detail-modal .timeline-item .tl-icon.purple { background: #ede7f6; color: #5e35b1; }
      .qa-detail-modal .timeline-item .tl-icon.gray { background: #f1f3f4; color: #5f6368; }
      .qa-detail-modal .timeline-item .tl-body { flex: 1; min-width: 0; }
      .qa-detail-modal .timeline-item .tl-title { font-weight: 800; color: #333; }
      .qa-detail-modal .timeline-item .tl-meta { color: #777; font-size: 11px; }
      .qa-detail-modal .duration-bar {
        display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px;
      }
      .qa-detail-modal .duration-chip {
        padding: 4px 10px; border-radius: 8px; font-size: 11px;
        font-weight: 800; background: #f1f3f4; color: #5f6368;
      }

      @media (max-width: 1100px){
        .qa-wrap { flex-direction:column; height:auto; }
        .qa-wrap.list-mode .qa-left,
        .qa-wrap.inspector-mode .qa-left { width:100%; min-width:0; }
        .qa-right { height: 70vh; min-width:0; }
        .qa-wrap.embedded-mode .qa-left { width:100%; min-width:0; }
        .qa-check-head .addr { max-width: 70vw; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'qaPluginStyles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function ensureMarkup(){
    const host = document.getElementById('portalPluginViews');
    if (!host) return;
    if (document.getElementById('view-qa')) return;
    const wrap = document.createElement('div');
    wrap.id = 'view-qa';
    wrap.style.display = 'none';
    const legacyInspector = useLegacyQaInspector();
    const showTechnicianIdentity = canSeeQaTechnicianIdentity();
    const pendingColspan = showTechnicianIdentity ? 8 : 7;
    wrap.innerHTML = `
      <div class="qa-wrap ${legacyInspector ? 'list-mode' : 'list-mode embedded-mode'}">
        <div class="qa-submit-overlay" id="qaSubmitOverlay">
          <div class="qa-submit-card"><i class="fas fa-spinner fa-spin"></i><span id="qaSubmitOverlayText">Sending report...</span></div>
        </div>
        <div class="qa-confirm-overlay" id="qaConfirmOverlay">
          <div class="qa-confirm-card">
            <div class="qa-confirm-head" id="qaConfirmTitle">Are you sure?</div>
            <div class="qa-confirm-body" id="qaConfirmMessage"></div>
            <div class="qa-confirm-actions">
              <button class="qa-btn sm ghost" id="qaConfirmCancelBtn">Cancel</button>
              <button class="qa-btn sm primary" id="qaConfirmOkBtn">Confirm</button>
            </div>
          </div>
        </div>
        <div class="qa-panel qa-left">
          <div class="qa-deck">
            <div class="qa-slide list" id="qaSlideList">
              <div class="qa-topbar">
                <div class="qa-title">
                  <i class="fas fa-clipboard-check" style="color: var(--primary);"></i>
                  Pipeline
                  <span class="qa-fix-only-pill" data-qa-fix-only-indicator><i class="fas fa-tools"></i> Fix-only mode</span>
                </div>
                <div style="display:flex; gap:10px; align-items:center;">
                  <button class="qa-btn secondary sm" id="qaRefreshBtn"><i class="fas fa-sync"></i> Refresh</button>
                  <button class="qa-btn secondary sm" id="qaBulkApproveToggle" style="${canBulkApproveQA() ? '' : 'display:none;'}"><i class="fas fa-layer-group"></i> Bulk Approve</button>
                  <div class="qa-stats">
                    <div class="qa-stat" id="qaStatPending"><div class="v" id="qaCountPending">0</div><div class="l" id="qaCountPendingLabel">Pending</div></div>
                    <div class="qa-stat" id="qaStatManager"><div class="v" id="qaCountManager">0</div><div class="l" id="qaCountManagerLabel">Mgr Review</div></div>
                    <div class="qa-stat" id="qaStatHistory"><div class="v" id="qaCountHistory">0</div><div class="l" id="qaCountHistoryLabel">Today</div></div>
                  </div>
                </div>
              </div>
              <div class="qa-rate-strip" id="qaRateStrip"></div>
              <div class="qa-toolbar" id="qaToolbar">
                <div class="qa-toolbar-left">
                  <div class="qa-toggle-wrap" id="qaFillerToggle" title="Show or hide filler projects">
                    <div class="qa-toggle-switch ${showFillers ? 'on' : ''}" id="qaFillerSwitch"></div>
                    <span>Show Fillers</span>
                  </div>
                  <span class="qa-sort-hint" id="qaSortHint"></span>
                </div>
                <div class="qa-toolbar-right">
                </div>
              </div>
              <div class="qa-load-error" id="qaLoadError" role="status" aria-live="polite">
                <i class="fas fa-exclamation-triangle"></i>
                <span id="qaLoadErrorText">The QA queue could not refresh. Showing the last loaded queue.</span>
              </div>
              <div class="qa-bulk-panel" id="qaBulkApprovePanel" aria-hidden="true">
                <div class="qa-bulk-modal" role="dialog" aria-modal="true" aria-labelledby="qaBulkApproveTitle">
                  <div class="qa-bulk-head">
                    <div>
                      <h3 class="qa-bulk-title" id="qaBulkApproveTitle"><i class="fas fa-layer-group"></i> Bulk Approve QA</h3>
                      <p class="qa-bulk-subtitle">Choose the score and quality limits for the projects you want to approve together.</p>
                    </div>
                    <button class="qa-bulk-close" id="qaBulkCloseBtn" type="button" aria-label="Close bulk approval"><i class="fas fa-times"></i></button>
                  </div>
                  <div class="qa-bulk-body">
                    <div class="qa-bulk-grid">
                      <div class="qa-bulk-field">
                        <label for="qaBulkMaxScore">Max QA Score</label>
                        <input type="number" id="qaBulkMaxScore" value="10" min="0" max="40" step="0.5">
                      </div>
                      <div class="qa-bulk-field">
                        <label for="qaBulkMaxHeight">Max Solar Penalty</label>
                        <input type="number" id="qaBulkMaxHeight" placeholder="Any" min="0" max="10" step="0.5">
                      </div>
                      <div class="qa-bulk-field">
                        <label for="qaBulkRank">Drafter Rank</label>
                        <select id="qaBulkRank">
                          <option value="">Any rank</option>
                          <option value="standard_plus">Standard or senior</option>
                          <option value="senior">Senior only</option>
                          <option value="standard">Standard only</option>
                          <option value="junior">Junior only</option>
                        </select>
                      </div>
                      <div class="qa-bulk-field">
                        <label for="qaBulkTechnician">Technician</label>
                        <select id="qaBulkTechnician"><option value="">Any technician</option></select>
                      </div>
                      <div class="qa-bulk-field">
                        <label for="qaBulkMaxComplexity">Max Complexity Points</label>
                        <input type="number" id="qaBulkMaxComplexity" placeholder="Any" min="0" max="20" step="1">
                      </div>
                      <div class="qa-bulk-field">
                        <label for="qaBulkIncludeClaimed">Claimed Projects</label>
                        <select id="qaBulkIncludeClaimed">
                          <option value="0">Skip claimed</option>
                          <option value="1">Include claimed</option>
                        </select>
                      </div>
                      <div class="qa-bulk-field">
                        <label for="qaBulkIncludeVip">VIP Projects</label>
                        <label class="qa-bulk-switch" for="qaBulkIncludeVip">
                          <input type="checkbox" id="qaBulkIncludeVip">
                          <span class="qa-bulk-switch-track" aria-hidden="true"></span>
                          <span class="qa-bulk-switch-text"></span>
                        </label>
                      </div>
                    </div>
                    <div class="qa-bulk-preview" id="qaBulkPreview">No matching projects.</div>
                  </div>
                  <div class="qa-bulk-summary">
                    <div class="qa-bulk-count" id="qaBulkCount">Matches: <b>0</b></div>
                    <label class="qa-bulk-confirm"><input type="checkbox" id="qaBulkConfirm"> I understand this will approve and send matching reports.</label>
                    <button class="qa-btn success sm" id="qaBulkApproveBtn" disabled><i class="fas fa-check-double"></i> Approve Matching</button>
                  </div>
                </div>
              </div>
              <div class="qa-table-wrap">
                <div class="qa-worker-panel" id="qaWorkerPanel">
                  <div class="hero">
                    <div>
                      <h3>Grab your next QA project</h3>
                      <p>Projects are assigned automatically. Grab the next one and keep moving.</p>
                    </div>
                    <button class="qa-btn primary" id="qaGrabNextBtn"><i class="fas fa-bolt"></i> Grab Next</button>
                  </div>
                  <div class="qa-worker-stats">
                    <div class="qa-worker-stat"><div class="v" id="qaWorkerClaimedCount">0</div><div class="l">Claimed</div></div>
                    <div class="qa-worker-stat"><div class="v" id="qaWorkerReviewedToday">0</div><div class="l">Reviewed Today</div></div>
                  </div>
                  <div class="qa-worker-next" id="qaWorkerNextCard">
                    <div class="meta">
                      <div class="eyebrow" id="qaWorkerNextEyebrow">Ready</div>
                      <div class="addr" id="qaWorkerNextAddress">Projects are assigned automatically.</div>
                      <div class="qa-worker-note" id="qaWorkerNextNote"></div>
                    </div>
                  </div>
                  <div class="qa-leaderboard" id="qaWorkerLeaderboard"></div>
                </div>

                <!-- Manager sign-off section (shift managers only) -->
                <div class="qa-manager-section" id="qaManagerSection" style="display:none;">
                  <div class="qa-manager-section-header">
                    <span class="icon"><i class="fas fa-user-shield"></i></span>
                    Manager Sign-off — VIP Projects
                    <span class="count" id="qaManagerCount">0</span>
                  </div>
                  <div style="padding:0 18px 12px;">
                    <table class="qa-table">
                      <thead>
                        <tr>
                          <th>Address</th>
                          <th>Created</th>
                          <th>QA Approved By</th>
                          <th>QA Approved At</th>
                          <th>Drafter</th>
                          <th style="text-align:right;">Action</th>
                        </tr>
                      </thead>
                      <tbody id="qaManagerBody"></tbody>
                    </table>
                  </div>
                </div>

                <!-- Claimed by me section -->
                <div class="qa-claimed-section" id="qaClaimedSection" style="display:none;">
                  <div class="qa-claimed-section-header">
                    <span class="icon"><i class="fas fa-user-check"></i></span>
                    Your Claimed Items
                    <span class="count" id="qaClaimedCount">0</span>
                  </div>
                  <div style="padding:0 18px 12px;">
                    <table class="qa-table">
                      <thead>
                        <tr>
                          <th>Address</th>
                          <th>Requested By</th>
                          <th>Created</th>
                          <th>Entered QA</th>
                          ${showTechnicianIdentity ? '<th>Drafter</th>' : ''}
                          <th>Status</th>
                          <th style="text-align:right;">Action</th>
                        </tr>
                      </thead>
                      <tbody id="qaClaimedBody"></tbody>
                    </table>
                  </div>
                </div>

                <div class="qa-history-header" id="qaPendingPaginationHeader" style="${canManageQaQueue() ? '' : 'display:none;'}">
                  <div class="label">Pending Approvals</div>
                  <div class="qa-history-controls" id="qaPendingPaginationControls">
                    <label for="qaPendingPageSize">Rows</label>
                    <select id="qaPendingPageSize">
                      <option value="25">25</option>
                      <option value="50">50</option>
                      <option value="100">100</option>
                      <option value="200">200</option>
                    </select>
                    <button class="qa-btn sm ghost" id="qaPendingPrevBtn" type="button" aria-label="Previous pending projects page"><i class="fas fa-chevron-left"></i></button>
                    <span class="qa-history-page-summary" id="qaPendingPageSummary">Page 1 of 1</span>
                    <button class="qa-btn sm ghost" id="qaPendingNextBtn" type="button" aria-label="Next pending projects page"><i class="fas fa-chevron-right"></i></button>
                  </div>
                </div>
                <table class="qa-table" id="qaPendingTable">
                  <thead>
                    <tr id="qaPendingHead">
                      <th class="sortable" data-col="address">Address <span class="sort-icon"><i class="fas fa-sort"></i></span></th>
                      <th class="sortable" data-col="requested_by">Requested By <span class="sort-icon"><i class="fas fa-sort"></i></span></th>
                      <th class="sortable" data-col="created_at">Created <span class="sort-icon"><i class="fas fa-sort"></i></span></th>
                      <th class="sortable" data-col="entered_qa">Entered QA <span class="sort-icon"><i class="fas fa-sort"></i></span></th>
                      ${showTechnicianIdentity ? '<th class="sortable" data-col="drafter">Drafter <span class="sort-icon"><i class="fas fa-sort"></i></span></th>' : ''}
                      <th>QA Score</th>
                      <th class="sortable" data-col="status">Status <span class="sort-icon"><i class="fas fa-sort"></i></span></th>
                      <th style="text-align:right;">Action</th>
                    </tr>
                  </thead>
                  <tbody id="qaQueueBody">
                    <tr><td colspan="${pendingColspan}" style="text-align:center; padding:20px; color:#999;"><i class="fas fa-spinner fa-spin"></i> Loading…</td></tr>
                  </tbody>
                </table>

                <div class="qa-history-section" style="margin-top:18px;">
                  <div class="qa-history-header">
                    <div class="label">Approved Today</div>
                    <div class="qa-history-controls" id="qaHistoryControls" style="${canManageQaQueue() || canManagerReview() ? '' : 'display:none;'}">
                      <label for="qaHistoryPageSize">Rows</label>
                      <select id="qaHistoryPageSize">
                        <option value="10">10</option>
                        <option value="25">25</option>
                        <option value="50">50</option>
                        <option value="100">100</option>
                      </select>
                      <button class="qa-btn sm ghost" id="qaHistoryPrevBtn" type="button" aria-label="Previous completed projects page"><i class="fas fa-chevron-left"></i></button>
                      <span class="qa-history-page-summary" id="qaHistoryPageSummary">Page 1 of 1</span>
                      <button class="qa-btn sm ghost" id="qaHistoryNextBtn" type="button" aria-label="Next completed projects page"><i class="fas fa-chevron-right"></i></button>
                    </div>
                  </div>
                  <table class="qa-table" style="opacity:0.9;">
                    <thead>
                      <tr>
                        <th>Address</th>
                        <th>Date</th>
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody id="qaHistoryBody"></tbody>
                  </table>
                </div>
              </div>
            </div>
            <div class="qa-slide checklist" id="qaSlideChecklist">
              <div class="qa-check-head">
                <div class="left">
                  <button class="qa-btn sm ghost" id="qaBackToListBtn"><i class="fas fa-arrow-left"></i> Back</button>
                  <div class="meta">
                    <div class="qa-nav-address-row">
                      <div class="addr qa-copy-address" id="qaNavAddress" role="button" tabindex="0" title="Click to copy address">Select a job…</div>
                      <span class="qa-project-type-pill" id="qaNavProjectType"></span>
                      <span class="qa-copy-feedback" id="qaNavCopyFeedback" aria-live="polite"><i class="fas fa-check"></i> Copied</span>
                    </div>
                    <div class="sub" id="qaNavSub">Checklist</div>
                  </div>
                </div>
                <div style="display:flex; gap:8px; align-items:center;">
                  <button class="qa-btn sm" id="qaPrevBtn" disabled><i class="fas fa-chevron-left"></i></button>
                  <button class="qa-btn sm" id="qaNextBtn" disabled><i class="fas fa-chevron-right"></i></button>
                </div>
              </div>
              <div class="qa-check-body" id="qaCheckBody"></div>
              <div class="qa-actions-panel" id="qaActionsPanel">
                <div class="summary" id="qaThreadSummary"></div>
                <div class="buttons" id="qaActionButtons">
                  <button class="qa-btn success" id="qaApproveBtn"><i class="fas fa-check"></i> Approve Without Changes</button>
                  <button class="qa-btn primary" id="qaRejectBtn"><i class="fas fa-undo"></i> Request Tech Correction</button>
                  <button class="qa-btn secondary" id="qaCorrectApproveBtn"><i class="fas fa-tools"></i> Correct and Approve</button>
                </div>
                <div class="qa-resolve-all-row" id="qaResolveAllRow" style="display:none;">
                  <button class="qa-btn ghost sm" id="qaResolveAllBtn" title="Mark all open issues as resolved so you can approve — use when issues were flagged by mistake or already resolved offline">
                    <i class="fas fa-check-double"></i> Resolve All Issues
                  </button>
                </div>
                <div class="qa-utility-actions">
                  <button class="qa-btn secondary sm" id="qaEditDirectlyBtn"><i class="fas fa-edit"></i> Edit Directly</button>
                  <button class="qa-btn secondary sm" id="qaReloadProjectBtn"><i class="fas fa-sync-alt"></i> Reload</button>
                  <button class="qa-btn secondary sm" id="qaReleaseClaimBtn" title="Release this item back to the queue"><i class="fas fa-unlock"></i> Release</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="qa-right">
          <div class="qa-right-inner">
            <div class="qa-embedded-header" id="qaEmbeddedHeader">
              <div class="qa-embedded-left">
                <button class="qa-btn sm ghost" id="qaEmbeddedBackBtn"><i class="fas fa-arrow-left"></i> Back</button>
                <div class="qa-embedded-meta">
                  <div class="qa-embedded-address-row">
                    <div class="qa-embedded-address qa-copy-address" id="qaEmbeddedAddress" role="button" tabindex="0" title="Click to copy address">Select a job...</div>
                    <span class="qa-project-type-pill" id="qaEmbeddedProjectType"></span>
                    <span class="qa-copy-feedback" id="qaEmbeddedCopyFeedback" aria-live="polite"><i class="fas fa-check"></i> Copied</span>
                    <span class="qa-fix-only-pill" data-qa-fix-only-indicator><i class="fas fa-tools"></i> Fix-only mode</span>
                  </div>
                  <div class="qa-embedded-sub" id="qaEmbeddedSub"></div>
                </div>
              </div>
              <div class="qa-embedded-actions">
                <button class="qa-btn ghost sm" id="qaEmbeddedResolveAllBtn" title="Mark all open issues as resolved">
                  <i class="fas fa-check-double"></i> Resolve All Issues
                </button>
                <button class="qa-btn secondary sm" id="qaEmbeddedReloadBtn"><i class="fas fa-sync-alt"></i> Reload</button>
                <button class="qa-btn secondary sm" id="qaEmbeddedReleaseBtn" title="Release this item back to the queue"><i class="fas fa-unlock"></i> Release</button>
              </div>
            </div>
            <div class="qa-reference-strip embedded" id="qaSubmissionRefsEmbedded"></div>
            <div class="qa-embedded-editor-shell" id="qaEmbeddedEditorShell">
              <iframe id="qaEmbeddedEditorFrame" src="about:blank" loading="lazy"></iframe>
              <iframe id="qaPreloadEditorFrame" class="qa-preload-frame" src="about:blank" loading="lazy" aria-hidden="true"></iframe>
              <div class="qa-embedded-empty" id="qaEmbeddedEmpty">
                <i class="fas fa-window-maximize"></i>
                <div>Select a project from the list to load the editor here.</div>
              </div>
            </div>
            <div class="qa-right-split" id="qaRightSplit">
              <div class="qa-pane pdf">
                <div class="qa-pane-head">
                  <span><i class="fas fa-file-pdf"></i> PDF</span>
                  <div class="qa-pdf-tools">
                    <button type="button" class="qa-pdf-tool" id="qaPdfPrevPageBtn" title="Previous page"><i class="fas fa-chevron-left"></i></button>
                    <span style="opacity:.75; font-weight:900;" id="qaPdfHint">Fit</span>
                    <button type="button" class="qa-pdf-tool" id="qaPdfNextPageBtn" title="Next page"><i class="fas fa-chevron-right"></i></button>
                    <button type="button" class="qa-pdf-tool" id="qaPdfConfigBtn" title="Configure PDF preview"><i class="fas fa-sliders-h"></i></button>
                  </div>
                </div>
                <div class="qa-pdf-config" id="qaPdfConfigPanel">
                  <div class="qa-pdf-config-inner" id="qaPdfConfigContent"></div>
                </div>
                <div class="qa-pane-body">
                  <div class="qa-pdf-viewer" id="qaPdfViewer">
                    <div class="qa-pdf-main" id="qaPdfMain">
                      <div class="qa-pdf-empty">Select a job to load the PDF.</div>
                    </div>
                    <div class="qa-pdf-vent-editor" id="qaPdfVentEditor"></div>
                    <div class="qa-pdf-thumbs" id="qaPdfThumbs"></div>
                    <div class="qa-reference-strip" id="qaSubmissionRefs"></div>
                  </div>
                </div>
              </div>
              <div class="qa-splitter" id="qaSplitter" title="Drag to resize"></div>
              <div class="qa-pane map">
                <div class="qa-stack">
                  <div class="qa-stack-pane">
                    <div class="qa-pane-head">
                      <span><i class="fas fa-cube"></i> 3D</span>
                    </div>
                    <div class="qa-pane-body">
                      <iframe id="qa3DFrame" src="about:blank" loading="lazy"></iframe>
                    </div>
                  </div>
                  <div class="qa-stack-pane">
                    <div class="qa-pane-head">
                      <span><i class="fas fa-map-marked-alt"></i> Map</span>
                      <div style="display:flex; align-items:center; gap:8px;">
                        <div class="qa-mini-tabs" id="qaImageTabs">
                          <button type="button" class="qa-mini-tab active" data-view="live_quad">Quad</button>
                          <button type="button" class="qa-mini-tab" data-view="live_map">Map</button>
                          <button type="button" class="qa-mini-tab" data-view="solar">Solar</button>
                          <button type="button" class="qa-mini-tab" data-view="google">G</button>
                          <button type="button" class="qa-mini-tab" data-view="azure">B</button>
                          <button type="button" class="qa-mini-tab" data-view="apple">A</button>
                        </div>
                        <div class="qa-image-tools">
                          <button type="button" class="qa-image-tool active" id="qaImageGeoBtn" title="Toggle geometry overlay on saved imagery views">GEO</button>
                          <button type="button" class="qa-image-tool active" id="qaImageFacesBtn" title="Toggle translucent face overlays">FACE</button>
        <button type="button" class="qa-image-tool active" id="qaImageTypesBtn" title="Toggle line type colors and legend">TYPE</button>
        <button type="button" class="qa-image-tool active" id="qaImageMeasuresBtn" title="Toggle measurement labels">MEAS</button>
        <button type="button" class="qa-image-tool" id="qaImageFitBtn" title="Reset to the full-image fit view">FIT</button>
                        </div>
                      </div>
                    </div>
                    <div class="qa-pane-body">
                      <div id="qaMapViewport" class="qa-live-map-stage">
                        <iframe id="qaMapFrame" src="about:blank" loading="lazy"></iframe>
                      </div>
                      <div class="qa-image-stage interactive" id="qaImageViewport" style="display:none; position:absolute; inset:0;">
                        <div class="qa-image-content" id="qaImageContent" style="display:none;">
                          <canvas id="qaImageCanvas"></canvas>
                        </div>
                        <svg id="qaImageOverlay" xmlns="http://www.w3.org/2000/svg"></svg>
                        <div id="qaImageLegend" class="qa-image-legend hidden"></div>
                        <div id="qaQuadEmpty" class="qa-image-empty show">No saved top-down image is available for this project yet.</div>
                        <div id="qaImageHud" class="qa-image-hud" style="display:none;">100%</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div id="qaInspectorEmpty" class="qa-empty">
                <div style="font-weight:950; font-size:16px; margin-bottom:6px;">Viewer</div>
                <div style="opacity:0.85; font-weight:800;">Select a job to load the PDF, 3D view, and live map.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="qa-drag-shield" id="qaDragShield"></div>
      <div class="qa-lightbox" id="qaLightbox">
        <div class="close"><i class="fas fa-times"></i></div>
        <div class="qa-lightbox-shell">
          <div class="qa-lightbox-main">
            <div class="qa-lightbox-stage">
              <button type="button" class="qa-lightbox-nav prev" data-lightbox-nav="prev" title="Previous image"><i class="fas fa-chevron-left"></i></button>
              <img class="qa-lightbox-image" src="" alt="Preview">
              <button type="button" class="qa-lightbox-nav next" data-lightbox-nav="next" title="Next image"><i class="fas fa-chevron-right"></i></button>
            </div>
            <div class="qa-lightbox-rail" id="qaLightboxRail"></div>
          </div>
          <div class="qa-lightbox-info">
            <div class="qa-lightbox-title">
              <span id="qaLightboxTitle">Reference Image</span>
              <span class="qa-lightbox-count" id="qaLightboxCount"></span>
            </div>
            <div class="qa-lightbox-notes empty" id="qaLightboxNotes">No notes provided.</div>
          </div>
        </div>
      </div>
    `;
    host.appendChild(wrap);
  }

  // ----------------- UTIL -----------------
  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

  function parseServerDate(d){
    if (!d) return null;
    let s = String(d).trim();
    s = s.replace(' ', 'T');
    if (!/[Zz]$/.test(s) && !/[+-]\d{2}:\d{2}$/.test(s) && !/[+-]\d{4}$/.test(s)) {
      s += 'Z';
    }
    const dt = new Date(s);
    return isNaN(dt.getTime()) ? null : dt;
  }

  function fmtDate(d){
    try {
      const dt = parseServerDate(d);
      if (!dt) return d || '';
      return dt.toLocaleString();
    } catch(e){ return d || ''; }
  }
  function fmtDateShort(d){
    try {
      const dt = parseServerDate(d);
      if (!dt) return d || '';
      const now = new Date();
      const isToday = dt.toDateString() === now.toDateString();
      if (isToday) return dt.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
      return dt.toLocaleDateString([], { month:'short', day:'numeric' }) + ' ' + dt.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
    } catch(e){ return d || ''; }
  }

  function isToday(d){
    const dt = parseServerDate(d);
    if (!dt) return false;
    return dt.toDateString() === (new Date()).toDateString();
  }

  function esc(s){ return Portal.escapeHtml(s); }
  function genId(){ return 'thread_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36); }

  let qaScoreTooltipEl = null;
  let qaScoreTooltipAnchor = null;

  function ensureQaScoreTooltipEl(){
    if (qaScoreTooltipEl) return qaScoreTooltipEl;
    qaScoreTooltipEl = document.createElement('div');
    qaScoreTooltipEl.className = 'qa-score-floating-tooltip';
    qaScoreTooltipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(qaScoreTooltipEl);
    return qaScoreTooltipEl;
  }

  function positionQaScoreTooltip(){
    if (!qaScoreTooltipAnchor || !qaScoreTooltipEl) return;
    const anchorRect = qaScoreTooltipAnchor.getBoundingClientRect();
    const tooltipRect = qaScoreTooltipEl.getBoundingClientRect();
    const margin = 8;
    let top = anchorRect.bottom + 9;
    let above = false;
    if (top + tooltipRect.height + margin > window.innerHeight && anchorRect.top - tooltipRect.height - 9 > margin) {
      top = anchorRect.top - tooltipRect.height - 9;
      above = true;
    }
    const idealLeft = anchorRect.left + (anchorRect.width / 2) - (tooltipRect.width / 2);
    const left = Math.max(margin, Math.min(window.innerWidth - tooltipRect.width - margin, idealLeft));
    const arrowX = anchorRect.left + (anchorRect.width / 2) - left;
    qaScoreTooltipEl.style.left = `${left}px`;
    qaScoreTooltipEl.style.top = `${top}px`;
    qaScoreTooltipEl.style.setProperty('--qa-score-arrow-x', `${Math.max(12, Math.min(tooltipRect.width - 12, arrowX))}px`);
    qaScoreTooltipEl.classList.toggle('above', above);
  }

  function showQaScoreTooltip(anchor){
    const source = anchor && anchor.querySelector('.qa-score-tooltip');
    if (!source) return;
    qaScoreTooltipAnchor = anchor;
    const el = ensureQaScoreTooltipEl();
    el.innerHTML = source.innerHTML;
    el.classList.remove('above', 'show');
    el.style.visibility = 'hidden';
    el.style.opacity = '0';
    requestAnimationFrame(() => {
      positionQaScoreTooltip();
      el.style.visibility = '';
      el.style.opacity = '';
      el.classList.add('show');
    });
  }

  function hideQaScoreTooltip(){
    qaScoreTooltipAnchor = null;
    if (qaScoreTooltipEl) qaScoreTooltipEl.classList.remove('show');
  }

  function wireQaScoreTooltips(){
    document.addEventListener('mouseover', (e) => {
      const anchor = e.target && e.target.closest ? e.target.closest('.qa-score-wrap') : null;
      if (!anchor || (e.relatedTarget && anchor.contains(e.relatedTarget))) return;
      showQaScoreTooltip(anchor);
    });
    document.addEventListener('mouseout', (e) => {
      const anchor = e.target && e.target.closest ? e.target.closest('.qa-score-wrap') : null;
      if (!anchor || (e.relatedTarget && anchor.contains(e.relatedTarget))) return;
      hideQaScoreTooltip();
    });
    document.addEventListener('focusin', (e) => {
      const anchor = e.target && e.target.closest ? e.target.closest('.qa-score-wrap') : null;
      if (anchor) showQaScoreTooltip(anchor);
    });
    document.addEventListener('focusout', (e) => {
      const anchor = e.target && e.target.closest ? e.target.closest('.qa-score-wrap') : null;
      if (anchor) hideQaScoreTooltip();
    });
    window.addEventListener('resize', positionQaScoreTooltip);
    window.addEventListener('scroll', positionQaScoreTooltip, true);
  }
  
  function badgeForStatus(status){
    if (status === 'submission_failed') return `<span class="qa-badge submission-failed"><i class="fas fa-triangle-exclamation"></i> Submission Failed</span>`;
    if (status === 'awaiting_review') return `<span class="qa-badge pending"><i class="fas fa-clock"></i> Pending</span>`;
    if (status === 'pending_rejection') return `<span class="qa-badge pending-rejection"><i class="fas fa-exclamation-triangle"></i> Rejection Requested</span>`;
    if (status === 'awaiting_manager_review') return `<span class="qa-badge manager-review"><i class="fas fa-user-shield"></i> Manager Review</span>`;
    return `<span class="qa-badge pending"><i class="fas fa-clock"></i> Pending</span>`;
  }

  function badgeForHistoryStatus(status){
    if (status === 'submission_failed') return `<span class="qa-badge submission-failed"><i class="fas fa-triangle-exclamation"></i> Submission Failed</span>`;
    if (status === 'completed') return `<span class="qa-badge approved"><i class="fas fa-circle-check"></i> Approved</span>`;
    if (status === 'processing' || status === 'in_progress') return `<span class="qa-badge processing"><i class="fas fa-circle-half-stroke"></i> In Progress</span>`;
    if (status === 'rejected' || status === 'rejected_no_coverage') return `<span class="qa-badge rejected"><i class="fas fa-times-circle"></i> Rejected</span>`;
    if (status === 'awaiting_review') return `<span class="qa-badge pending"><i class="fas fa-clock"></i> Awaiting Review</span>`;
    if (status === 'awaiting_manager_review') return `<span class="qa-badge manager-review"><i class="fas fa-user-shield"></i> Manager Review</span>`;
    if (status === 'pending_rejection') return `<span class="qa-badge pending-rejection"><i class="fas fa-exclamation-triangle"></i> Rejection Requested</span>`;
    if (status === 'correction_needed') return `<span class="qa-badge correction"><i class="fas fa-triangle-exclamation"></i> Correction</span>`;
    if (status === 'queued' || status === 'ready') return `<span class="qa-badge processing"><i class="fas fa-hourglass-half"></i> Queued</span>`;
    return `<span class="qa-badge correction"><i class="fas fa-triangle-exclamation"></i> ${esc(status || 'Unknown')}</span>`;
  }

  function normalizeCustomerReworkType(value){
    const key = String(value || '').trim().toLowerCase();
    if (key === 'additional_structure') return 'additional_structure';
    if (key === 'change_correction' || key === 'correction' || key === 'change') return 'change_correction';
    if (key === 'report_issue' || key === 'issue') return 'report_issue';
    return key;
  }

  function customerReworkTypeLabel(value){
    const key = normalizeCustomerReworkType(value);
    if (key === 'additional_structure') return 'Additional Structure';
    if (key === 'change_correction') return 'Change / Correction';
    if (key === 'report_issue') return 'Reported Issue';
    return 'Customer Rework';
  }

  function getCustomerReworkMeta(item, manifest){
    const sources = [manifest, item].filter(Boolean);
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const inQa = !!source.customer_rework_in_qa
        || !!source.customer_rework_submitted_to_qa_at
        || !!source.customer_rework_request_id;
      const latest = source.latest_report_change_request && typeof source.latest_report_change_request === 'object'
        ? source.latest_report_change_request
        : null;
      const latestStatus = String(latest?.status || '').trim().toLowerCase();
      const latestType = normalizeCustomerReworkType(latest?.type || latest?.request_type);
      const latestActive = latest && latestType && latestType !== 'report_issue'
        && ['submitted_to_qa', 'pending_review', 'reworking'].includes(latestStatus);
      if (inQa || latestActive) {
        const type = normalizeCustomerReworkType(
          source.customer_rework_request_type
          || latest?.type
          || latest?.request_type
          || source.rework_request_type
        );
        return {
          isRework: true,
          type,
          label: source.customer_rework_request_label || latest?.label || customerReworkTypeLabel(type)
        };
      }
    }
    return { isRework: false, type: '', label: '' };
  }

  function customerReworkPill(item, manifest){
    const meta = getCustomerReworkMeta(item, manifest);
    if (!meta.isRework) return '';
    return ` <span class="qa-badge customer-rework" title="${esc(meta.label || 'Customer rework')}"><i class="fas fa-screwdriver-wrench"></i> Customer Rework</span>`;
  }

  function isCurrentCustomerReworkQaJob(){
    return getCustomerReworkMeta(null, currentManifest).isRework;
  }

  function setSlides(mode){
    const list = document.getElementById('qaSlideList');
    const cl = document.getElementById('qaSlideChecklist');
    if (!list || !cl) return;
    if (mode === 'checklist') { list.classList.add('hidden'); cl.classList.add('show'); }
    else { cl.classList.remove('show'); list.classList.remove('hidden'); }
  }

  function isEmbeddedQaMode(){
    const wrap = document.querySelector('.qa-wrap');
    return !!(wrap && wrap.classList.contains('embedded-mode'));
  }

  function activateEmbeddedQaMode(on){
    const wrap = document.querySelector('.qa-wrap');
    if (!wrap) return;
    wrap.classList.toggle('embedded-mode', !!on);
  }

  function setQaEditorShellFullscreen(on){
    document.body.classList.toggle('qa-editor-fullscreen', !!on);
  }

  function setLayoutMode(mode){
    const wrap = document.querySelector('.qa-wrap');
    if (!wrap) return;
    if (mode === 'inspector') {
      wrap.classList.remove('list-mode');
      wrap.classList.add('inspector-mode');
      setQaEditorShellFullscreen(isEmbeddedQaMode());
    } else {
      wrap.classList.remove('inspector-mode');
      wrap.classList.add('list-mode');
      setQaEditorShellFullscreen(false);
    }
  }

  function setViewerLoaded(on){
    const empty = document.getElementById('qaInspectorEmpty');
    if (empty) empty.style.display = on ? 'none' : 'flex';
  }

  function setEmbeddedEditorLoaded(on){
    const empty = document.getElementById('qaEmbeddedEmpty');
    const frame = document.getElementById('qaEmbeddedEditorFrame');
    if (empty) empty.style.display = on ? 'none' : 'flex';
    if (frame) frame.style.display = on ? 'block' : 'none';
  }

  function clearEmbeddedEditor(){
    const frame = document.getElementById('qaEmbeddedEditorFrame');
    if (frame) frame.src = 'about:blank';
    setEmbeddedEditorLoaded(false);
  }

  function clearPreloadedEditor(){
    const frame = document.getElementById('qaPreloadEditorFrame');
    if (frame) frame.src = 'about:blank';
    qaPreloadedProjectId = null;
  }

  function setEmbeddedHeaderText(addressHtml, subText){
    const addr = document.getElementById('qaEmbeddedAddress');
    const sub = document.getElementById('qaEmbeddedSub');
    if (addr) addr.innerHTML = addressHtml || 'Select a job...';
    setQaHeaderSubline(sub, subText);
  }

  const QA_PROJECT_TYPE_LABELS = {
    residential: 'Residential',
    commercial: 'Commercial',
    multifamily: 'Multi-Family'
  };

  function setQaHeaderProjectType(projectType){
    const key = String(projectType || '').trim().toLowerCase();
    const label = QA_PROJECT_TYPE_LABELS[key] || '';
    ['qaNavProjectType', 'qaEmbeddedProjectType'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.className = `qa-project-type-pill${label ? ` ${key}` : ''}`;
      el.textContent = label;
    });
  }

  function setQaCopyAddress(address){
    const value = String(address || '').trim();
    ['qaNavAddress', 'qaEmbeddedAddress'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.dataset.copyAddress = value;
      el.setAttribute('aria-label', value ? `Copy address: ${value}` : 'Address unavailable');
    });
  }

  async function copyQaAddress(el){
    const address = String(el?.dataset?.copyAddress || '').trim();
    if (!address) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(address);
      } else {
        const input = document.createElement('textarea');
        input.value = address;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        const copied = document.execCommand('copy');
        input.remove();
        if (!copied) throw new Error('Copy command failed');
      }
      const feedbackId = el.id === 'qaEmbeddedAddress' ? 'qaEmbeddedCopyFeedback' : 'qaNavCopyFeedback';
      const feedback = document.getElementById(feedbackId);
      if (feedback) {
        feedback.classList.add('show');
        clearTimeout(feedback.__qaHideTimer);
        feedback.__qaHideTimer = setTimeout(() => feedback.classList.remove('show'), 1200);
      }
    } catch (error) {
      console.warn('[QA] Could not copy address:', error);
    }
  }

  function wireQaCopyAddress(el){
    if (!el) return;
    el.onclick = () => copyQaAddress(el);
    el.onkeydown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      copyQaAddress(el);
    };
  }

  function setQaHeaderSubline(el, subText){
    if (!el) return;
    const text = String(subText || '').trim();
    el.textContent = text;
    el.style.display = text ? '' : 'none';
  }

  function updateEmbeddedHeaderStats(){
    const resolveBtn = document.getElementById('qaEmbeddedResolveAllBtn');
    const releaseBtn = document.getElementById('qaEmbeddedReleaseBtn');
    const approveBtn = document.getElementById('qaEmbeddedApproveBtn');
    const rejectBtn = document.getElementById('qaEmbeddedRejectBtn');
    const isCustomerRework = isCurrentCustomerReworkQaJob();
    const stats = getThreadStats();
    const issueCount = stats.open + stats.fixed + stats.disputed;
    if (approveBtn) approveBtn.innerHTML = isManagerReviewMode
      ? '<i class="fas fa-check-double"></i> Final Approve & Send'
      : '<i class="fas fa-check"></i> Approve Without Changes';
    if (rejectBtn) {
      rejectBtn.innerHTML = '<i class="fas fa-undo"></i> Request Tech Correction';
      rejectBtn.style.display = isCustomerRework ? 'none' : '';
      rejectBtn.title = isCustomerRework ? 'Customer rework jobs are finalized by QA instead of being returned to the technician.' : '';
    }
    if (resolveBtn) {
      resolveBtn.style.display = issueCount > 0 ? '' : 'none';
      resolveBtn.disabled = issueCount <= 0;
      resolveBtn.innerHTML = `<i class="fas fa-check-double"></i> Resolve All Issues${issueCount > 0 ? ` (${issueCount})` : ''}`;
    }
    if (releaseBtn) releaseBtn.style.display = isManagerReviewMode ? 'none' : '';
    if (approveBtn) approveBtn.disabled = !(stats.open === 0 && stats.fixed === 0 && stats.disputed === 0);
    if (rejectBtn) rejectBtn.disabled = isCustomerRework || !(stats.open > 0 || stats.fixed > 0 || stats.disputed > 0);
  }

  function setEmbeddedEditorFrame(folderId, opts){
    const frame = document.getElementById('qaEmbeddedEditorFrame');
    if (!frame || !folderId) return;
    if (String(folderId) === String(qaPreloadedProjectId || '')) {
      const preload = document.getElementById('qaPreloadEditorFrame');
      if (preload && preload.src && preload.src !== 'about:blank') {
        // Swap their IDs in the DOM
        frame.id = 'qaPreloadEditorFrame';
        preload.id = 'qaEmbeddedEditorFrame';
        
        // Swap their CSS classes, styles, and accessibility attributes
        frame.className = 'qa-preload-frame';
        frame.setAttribute('aria-hidden', 'true');
        frame.style.display = 'block'; // Keep it block but positioned off-screen via CSS
        
        preload.className = '';
        preload.removeAttribute('aria-hidden');
        preload.style.display = 'block';
        
        // Reset the old frame (which is now the background preload frame)
        frame.src = 'about:blank';
        
        qaPreloadedProjectId = null;
        setEmbeddedEditorLoaded(true);
        wireEmbeddedEditorActivity();
        return;
      }
    }
    frame.src = buildQaEditorUrl(folderId, opts).toString();
    setEmbeddedEditorLoaded(true);
    wireEmbeddedEditorActivity();
  }

  function buildQaEditorUrl(folderId, opts){
    const url = new URL('editor.php', window.location.href);
    url.searchParams.set('folder', folderId);
    url.searchParams.set('embedded', '1');
    url.searchParams.set('hide_header', '1');
    url.searchParams.set('qa_embed', '1');
    url.searchParams.set('qa_open_pdf', '1');
    url.searchParams.set('qa_line_mode', '1');
    url.searchParams.set('qa_feedback_editor', '1');
    if (isQaFixOnlyMode()) url.searchParams.set('qa_fix_only', '1');
    if (opts && opts.hard) url.searchParams.set('_qa_reload', String(Date.now()));
    return url;
  }

  function preloadReservedEditor(){
    const frame = document.getElementById('qaPreloadEditorFrame');
    if (!frame || !Array.isArray(qaReservedProjects)) return;
    const next = qaReservedProjects.find((item) => item && item.id && String(item.id) !== String(currentId || ''));
    if (!next) {
      clearPreloadedEditor();
      return;
    }
    if (String(next.id) === String(qaPreloadedProjectId || '')) return;
    qaPreloadedProjectId = next.id;
    frame.src = buildQaEditorUrl(next.id, {}).toString();
  }

  function absorbReservedProjects(projects){
    const incoming = Array.isArray(projects) ? projects.filter((item) => item && item.id) : [];
    if (!incoming.length) return;
    const byId = new Map();
    [...qaReservedProjects, ...incoming].forEach((item) => {
      if (item && item.id) byId.set(String(item.id), item);
    });
    qaReservedProjects = Array.from(byId.values());
    preloadReservedEditor();
  }

  async function refillQaReservationBuffer(){
    if (!inQAView || !canDoQA() || isManagerReviewMode) return;
    
    // Scan pendingList for other projects claimed by me and absorb them first
    const myEmail = qaCurrentUserEmail();
    if (myEmail !== '') {
      const myClaimedFromPending = (Array.isArray(pendingList) ? pendingList : []).filter((item) => {
        if (!item || !item.id) return false;
        const status = String(item.status || 'awaiting_review').trim().toLowerCase();
        if (status !== 'awaiting_review' && status !== 'submission_failed' && status !== 'pending_rejection') return false;
        const claimedBy = String(item.qa_claimed_by_email || '').trim().toLowerCase();
        return claimedBy === myEmail;
      });
      if (myClaimedFromPending.length > 0) {
        absorbReservedProjects(myClaimedFromPending);
      }
    }

    const valid = qaReservedProjects.filter((item) => item && item.id && String(item.id) !== String(currentId || ''));
    if (valid.length >= QA_PRELOAD_TARGET - 1) {
      preloadReservedEditor();
      return;
    }
    try {
      const data = await fmPost('qa/queue/pull', {
        ...qaQueuePayload(),
        count: QA_PRELOAD_TARGET,
        release_stale: false
      }, 20000);
      if (data && data.success && Array.isArray(data.reserved_projects)) {
        absorbReservedProjects(data.reserved_projects);
        return data.reserved_projects;
      } else if (data && data.success && Array.isArray(data.projects)) {
        absorbReservedProjects(data.projects);
        return data.projects;
      }
    } catch (e) {
      console.warn('Failed to refill QA preload buffer:', e);
    }
    return [];
  }

  function getNextQaProject(finishedId) {
    const myEmail = qaCurrentUserEmail();
    
    function isValidCandidate(item) {
      if (!item || !item.id) return false;
      if (String(item.id) === String(finishedId || '')) return false;
      const status = String(item.status || 'awaiting_review').trim().toLowerCase();
      if (status !== 'awaiting_review' && status !== 'submission_failed' && status !== 'pending_rejection') return false;
      return true;
    }
    
    function isClaimedByMe(item) {
      const claimedBy = String(item.qa_claimed_by_email || '').trim().toLowerCase();
      return claimedBy === myEmail;
    }

    // Helper to check if a project is available/unclaimed by others
    function isUnclaimed(item) {
      const claimedBy = String(item.qa_claimed_by_email || '').trim().toLowerCase();
      if (!claimedBy) return true;
      if (String(item.qa_availability_reason || '').trim().toLowerCase() === 'claimer_offline') return true;
      return false;
    }

    // Lazy loaded / reserved projects (excluding finished project)
    const reservedCandidates = (Array.isArray(qaReservedProjects) ? qaReservedProjects : [])
      .filter(item => isValidCandidate(item));

    // Pending list projects (excluding finished project)
    const pendingCandidates = (Array.isArray(pendingList) ? pendingList : [])
      .filter(item => isValidCandidate(item));

    // 1. Claimed + Lazy Loaded (in reservedCandidates)
    let next = reservedCandidates.find(item => isClaimedByMe(item));
    if (next) return next;

    // 2. Claimed + Not Lazy Loaded (in pendingCandidates but not in reservedCandidates)
    next = pendingCandidates.find(item => isClaimedByMe(item) && !reservedCandidates.some(r => String(r.id) === String(item.id)));
    if (next) return next;

    // 3. Unclaimed + Lazy Loaded (in reservedCandidates)
    next = reservedCandidates.find(item => isUnclaimed(item));
    if (next) return next;

    // 4. Unclaimed next in line (in pendingCandidates but not in reservedCandidates)
    next = pendingCandidates.find(item => isUnclaimed(item) && !reservedCandidates.some(r => String(r.id) === String(item.id)));
    if (next) return next;

    return null;
  }

  async function advanceAfterQaFinish(){
    const finishedId = currentId;
    qaReservedProjects = qaReservedProjects.filter((item) => item && item.id && String(item.id) !== String(finishedId || ''));
    for (let attempt = 0; attempt < 8; attempt++) {
      let next = getNextQaProject(finishedId);
      if (!next) {
        await refillQaReservationBuffer();
        next = getNextQaProject(finishedId);
      }
      if (!next) break;

      const nextId = String(next.id);
      const claimRes = await fmPost(`projects/${encodeURIComponent(nextId)}/qa/claim`, {}, 15000);
      if (claimRes && claimRes.success) {
        await openInspector(nextId, { skipClaim: true });
        refillQaReservationBuffer();
        return;
      }

      console.info(
        `[QA ADVANCE] Skipping unavailable project ${nextId}: ${String(claimRes?.error || 'claim rejected')}`
      );
      qaReservedProjects = qaReservedProjects.filter((item) => item && String(item.id) !== nextId);
      pendingList = pendingList.filter((item) => item && String(item.id) !== nextId);
      if (String(qaPreloadedProjectId || '') === nextId) clearPreloadedEditor();
    }
    setQaSubmitBlocking(false);
    await closeInspectorToList({ releaseClaims: true, reason: 'queue_empty_after_submit' });
  }

  function mapsAvailable(){ return !!(window.google && google.maps && typeof google.maps.Map === 'function'); }

  function safeLoc(lat, lng){
    const la = parseFloat(lat);
    const ln = parseFloat(lng);
    if (!isFinite(la) || !isFinite(ln)) return null;
    return { lat: la, lng: ln };
  }

  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  function withTimeout(promise, ms, label){
    let t = null;
    const timeout = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(label || 'Request timed out')), ms);
    });
    return Promise.race([
      promise.finally(() => { if (t) clearTimeout(t); }),
      timeout
    ]);
  }

  function qaConfirm(options){
    const overlay = document.getElementById('qaConfirmOverlay');
    const title = document.getElementById('qaConfirmTitle');
    const message = document.getElementById('qaConfirmMessage');
    const ok = document.getElementById('qaConfirmOkBtn');
    const cancel = document.getElementById('qaConfirmCancelBtn');
    if (!overlay || !ok || !cancel) return Promise.resolve(window.confirm(options?.message || 'Are you sure?'));
    if (title) title.textContent = options?.title || 'Are you sure?';
    if (message) message.textContent = options?.message || '';
    ok.innerHTML = options?.confirmHtml || 'Confirm';
    cancel.textContent = options?.cancelText || 'Cancel';
    cancel.style.display = options?.alertOnly ? 'none' : '';
    overlay.classList.add('show');
    return new Promise((resolve) => {
      const cleanup = (value) => {
        overlay.classList.remove('show');
        cancel.style.display = '';
        ok.onclick = null;
        cancel.onclick = null;
        overlay.onclick = null;
        resolve(value);
      };
      ok.onclick = () => cleanup(true);
      cancel.onclick = () => cleanup(false);
      overlay.onclick = (e) => { if (e.target === overlay) cleanup(options?.alertOnly ? true : false); };
    });
  }

  function qaNotice(title, message){
    return qaConfirm({
      title: title || 'QA notice',
      message: message || '',
      confirmHtml: '<i class="fas fa-check"></i> OK',
      alertOnly: true
    });
  }

  function qaTeamPayload(){
    const raw = String((cfg().team && cfg().team.id) || cfg().team_id || cfg().user?.team_id || 'default').trim();
    if (!raw || raw.toLowerCase() === 'default' || raw.toLowerCase() === 'all') return {};
    return { team: raw, team_id: raw };
  }

  function qaQueuePayload(){
    // Internal staff teams describe the people roster. They are not project
    // queue partitions: projects already awaiting QA retain the project team
    // they entered production with. Automatically applying the QA user's
    // roster team here can therefore make the shared queue appear empty.
    return {};
  }

  function normalizeQaActorTeamId(raw){
    const value = String(raw || '').trim();
    if (!value || value.toLowerCase() === 'default' || value.toLowerCase() === 'all') return '';
    return value;
  }

  async function fmPatch(path, payload, ms, opts){
    const body = { ...(payload || {}) };
    const includeActor = !opts || opts.includeActor !== false;
    if (includeActor && !body.actor) {
      body.actor = fmActor();
    }
    return await withTimeout(
      Portal.fmJson(path, {
        method: 'PATCH',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }),
      ms || 25000,
      'Request timed out'
    );
  }

  function qaClaimedByEmail(item){
    return String(item?.qa_claimed_by_email || item?.workflow?.qa_claim?.email || '').trim().toLowerCase();
  }

  function qaReviewerEmail(item){
    const direct = firstTextValue([
      item?.qa_reviewed_by_email,
      item?.qa_reviewed_by,
      item?.qa_approved_by_email,
      item?.qa_approved_by
    ]).toLowerCase();
    if (direct) return direct;
    const history = Array.isArray(item?.work_history) ? item.work_history : [];
    for (let i = history.length - 1; i >= 0; i--) {
      const ev = history[i] || {};
      const name = String(ev.event || ev.type || '').trim().toLowerCase();
      if (!['qa_approved', 'qa_approved_pending_manager', 'qa_reviewed', 'qa_claimed'].includes(name)) continue;
      const email = firstTextValue([ev.qa_email, ev.qa_reviewer_email, ev.by_email, ev.user_email]).toLowerCase();
      if (email) return email;
    }
    return '';
  }

  function qaReviewerName(item){
    return firstTextValue([
      item?.qa_approved_by_name,
      item?.qa_reviewed_by_name,
      item?.qa_reviewer_name,
      qaReviewerEmail(item)
    ]);
  }

  function qaIsClaimAvailableForUser(item, email){
    const claimedBy = qaClaimedByEmail(item);
    if (!claimedBy || claimedBy === email) return true;
    if (String(item?.qa_availability_reason || '').trim().toLowerCase() === 'claimer_offline') return true;
    if (!item?.hidden_from_queue && item?.qa_available) return true;
    return false;
  }

  function qaLeaderboardFromCompletedItems(items, date){
    const rows = new Map();
    const targetDate = String(date || '').trim();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const elapsedHours = Math.max(1 / 60, (Date.now() - startOfDay.getTime()) / 3600000);
    for (const item of Array.isArray(items) ? items : []) {
      const at = item?.qa_approved_at || item?.qa_reviewed_at || item?.completed_at || item?.date || '';
      if (targetDate) {
        const dt = parseServerDate(at);
        if (!dt || qaFormatDateOnlyFromUtcDate(dt) !== targetDate) continue;
      } else if (!isToday(at)) {
        continue;
      }
      const email = qaReviewerEmail(item);
      if (!email) continue;
      if (!rows.has(email)) {
        rows.set(email, {
          email,
          name: qaReviewerName(item) || email,
          approved_count: 0,
          points: 0,
          projects_per_hour: 0,
          points_per_hour: 0
        });
      }
      const row = rows.get(email);
      row.approved_count += 1;
      row.points += getQaProjectPoints(item) || 1;
    }
    const list = Array.from(rows.values()).sort((a, b) => {
      if (Number(a.points) !== Number(b.points)) return Number(b.points) - Number(a.points);
      if (Number(a.approved_count) !== Number(b.approved_count)) return Number(b.approved_count) - Number(a.approved_count);
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    list.forEach((row, idx) => {
      row.rank = idx + 1;
      row.points = Math.round(Number(row.points || 0) * 100) / 100;
      row.projects_per_hour = Math.round((Number(row.approved_count || 0) / elapsedHours) * 100) / 100;
      row.points_per_hour = Math.round((Number(row.points || 0) / elapsedHours) * 100) / 100;
    });
    return {
      success: true,
      leaderboard: list,
      date: targetDate || '',
      timezone: 'local',
      cached: false
    };
  }

  function formatQaCompletedPoints(value){
    const rounded = Math.round(Number(value || 0) * 100) / 100;
    return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function qaShiftTodayKey(){
    return qaShiftDateKeyFor(new Date());
  }

  function qaShiftDateKeyFor(date){
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: QA_SHIFT_TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date).reduce((out, part) => {
      if (part.type !== 'literal') out[part.type] = part.value;
      return out;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function qaShiftDateLabel(date){
    const parsed = new Date(`${date}T12:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
    });
  }

  function qaShiftDateOffset(date, days){
    const parsed = new Date(`${date}T12:00:00Z`);
    parsed.setUTCDate(parsed.getUTCDate() + days);
    return qaFormatDateOnlyFromUtcDate(parsed);
  }

  function qaShiftDateControlsHtml(){
    const isToday = qaLeaderboardDate >= qaShiftTodayKey();
    return `<div class="qa-shift-date-controls" aria-label="QA shift date">
      <button type="button" data-qa-shift-date-step="-1" title="Previous shift date"><i class="fas fa-chevron-left"></i></button>
      <input type="date" data-qa-shift-date-input value="${esc(qaLeaderboardDate)}" max="${esc(qaShiftTodayKey())}" aria-label="QA shift start date">
      <button type="button" data-qa-shift-date-step="1" title="Next shift date" ${isToday ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>
    </div>`;
  }

  function qaShiftRangeLabel(row){
    const shifts = Array.isArray(row?.shifts) ? row.shifts : [];
    if (!shifts.length) return `${Number(row?.shift_count || 0)} shifts · ${Number(row?.approved_count || 0)} projects`;
    const time = (value) => new Intl.DateTimeFormat(undefined, {
      hour: 'numeric', minute: '2-digit'
    }).format(new Date(value));
    const ranges = shifts.map((shift) => `${time(shift.started_at)}–${time(shift.ended_at)}`);
    return `${ranges.join(' · ')} local time · ${Number(row?.approved_count || 0)} projects`;
  }

  function wireQaShiftDateControls(root){
    if (!root) return;
    root.querySelectorAll('[data-qa-shift-date-step]').forEach((button) => {
      button.addEventListener('click', async () => {
        const step = Number(button.getAttribute('data-qa-shift-date-step') || 0);
        const next = qaShiftDateOffset(qaLeaderboardDate, step);
        if (next > qaShiftTodayKey()) return;
        qaLeaderboardDate = next;
        await loadQueue();
      });
    });
    root.querySelectorAll('[data-qa-shift-date-input]').forEach((input) => {
      input.addEventListener('change', async () => {
        const next = String(input.value || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || next > qaShiftTodayKey()) return;
        qaLeaderboardDate = next;
        await loadQueue();
      });
    });
  }

  function mergeQaRankedQueueMeta(pending, ranked){
    const pendingItems = Array.isArray(pending) ? pending.filter(Boolean) : [];
    const rankedItems = Array.isArray(ranked) ? ranked.filter(Boolean) : [];
    if (!rankedItems.length) return pendingItems.map((item, idx) => ({ ...item, qa_priority_rank: item.qa_priority_rank || idx + 1 }));
    const byId = new Map();
    pendingItems.forEach((item) => {
      const id = String(item?.id || item?.folder || item?.project_id || '').trim();
      if (id) byId.set(id, item);
    });
    const out = [];
    const seen = new Set();
    rankedItems.forEach((rankedItem, idx) => {
      const id = String(rankedItem?.id || rankedItem?.folder || rankedItem?.project_id || '').trim();
      if (!id || !byId.has(id)) return;
      out.push({
        ...byId.get(id),
        ...rankedItem,
        qa_priority: !!rankedItem.qa_priority,
        qa_priority_rank: idx + 1
      });
      seen.add(id);
    });
    pendingItems.forEach((item) => {
      const id = String(item?.id || item?.folder || item?.project_id || '').trim();
      if (id && seen.has(id)) return;
      out.push(item);
    });
    out.forEach((item, idx) => {
      if (!item.qa_priority_rank) item.qa_priority_rank = idx + 1;
    });
    return out;
  }

  async function fetchQaLeaderboardDayFromNode(date, force=false){
    const key = String(date || '');
    const team = qaTeamPayload();
    const cacheKey = `${team.team || 'all'}:${key}`;
    if (!force && qaLeaderboardDailyCache.has(cacheKey)) return qaLeaderboardDailyCache.get(cacheKey);
    const res = await fmPost('qa/leaderboard', { ...team, date: key, force: !!force }, 20000);
    qaLeaderboardDailyCache.set(cacheKey, res);
    return res;
  }

  function qaDelay(ms){
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchQaSnapshotFromNode(){
    const team = qaQueuePayload();
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const bootstrap = await fmPost('qa/bootstrap', {
          ...team,
          can_do_qa: canDoQA(),
          can_manage_queue: canManageQaQueue(),
          can_manager_review: canManagerReview(),
          limit: 500,
          pending_page: qaPendingPage,
          pending_limit: qaPendingPageSize,
          history_page: qaHistoryPage,
          history_limit: qaHistoryPageSize,
          release_stale: true
        }, 20000);
        if (!bootstrap || bootstrap.success === false || bootstrap.ok === false) {
          throw new Error(bootstrap?.error || bootstrap?.message || 'Failed to load QA queue');
        }
        return bootstrap;
      } catch (e) {
        lastError = e;
        const message = String(e && e.message ? e.message : '');
        if (attempt >= 1 || /unauthorized|forbidden|timed out/i.test(message)) break;
        await qaDelay(800);
      }
    }
    throw lastError || new Error('Failed to load QA queue');
  }

  async function markCurrentProjectReturnToMe(){
    if (!currentId) return null;
    const actor = fmActor();
    const actorEmail = String(actor.email || '').trim().toLowerCase();
    const actorName = String(actor.name || actorEmail).trim() || actorEmail;
    const nowIso = new Date().toISOString();
    return await fmPatch(`projects/${encodeURIComponent(currentId)}`, {
      qa_return_to_email: actorEmail,
      qa_return_to_name: actorName,
      qa_return_to_set_at: nowIso,
      qa_return_to_reason: 'technician_correction',
      return_to_qa_email: actorEmail,
      return_to_qa_name: actorName,
      return_to_qa_at: nowIso,
      timestamps: {
        updated_at: nowIso
      }
    }, 10000);
  }

  async function reviewPendingRejectionWithNode(decision, reviewNotes){
    if (!currentId) throw new Error('No project loaded.');
    const actor = fmActor();
    const manifest = currentManifest && typeof currentManifest === 'object' ? currentManifest : {};
    const rejectionRequest = manifest.rejection_request && typeof manifest.rejection_request === 'object'
      ? { ...manifest.rejection_request }
      : {};
    const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');
    rejectionRequest.reviewed = true;
    rejectionRequest.review_decision = decision;
    rejectionRequest.reviewed_at = nowSql;
    rejectionRequest.reviewed_by = actor.email || null;
    rejectionRequest.reviewed_by_name = actor.name || actor.email || null;
    rejectionRequest.review_notes = reviewNotes || null;

    if (decision === 'overturned') {
      let restoredStatus = String(rejectionRequest.previous_status || '').trim().toLowerCase();
      if (!restoredStatus || restoredStatus === 'pending_rejection') restoredStatus = 'processing';
      await fmPatch(`projects/${encodeURIComponent(currentId)}`, {
        rejection_request: rejectionRequest,
        timestamps: { updated_at: nowSql }
      }, 15000);
      await fmPost(`projects/${encodeURIComponent(currentId)}/status`, {
        status: restoredStatus
      }, 15000);
      return {
        success: true,
        folder: currentId,
        decision: 'overturned',
        status: restoredStatus
      };
    }

    const reasons = Array.isArray(rejectionRequest.reasons)
      ? rejectionRequest.reasons.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const reason = reasons[0] || manifest.rejection_reason || 'no_height_map';
    const note = String(rejectionRequest.notes || reasons.join('; ') || reviewNotes || '').trim();
    return await fmPost(`projects/${encodeURIComponent(currentId)}/coverage/reject`, {
      rejection_reason: reason,
      rejection_reasons: reasons.length ? reasons : [reason],
      note,
      review_notes: reviewNotes || '',
      rejection_request: rejectionRequest
    }, 30000);
  }

  function qaPacificDateParts(date = new Date()){
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date).reduce((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
  }

  function qaFormatDateOnlyFromUtcDate(date){
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function qaWeekDates(anchorDate = qaLeaderboardDate){
    const todayUtc = new Date(`${anchorDate}T12:00:00Z`);
    const day = todayUtc.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const dates = [];
    for (let offset = mondayOffset; offset <= mondayOffset + 6; offset++) {
      dates.push(qaFormatDateOnlyFromUtcDate(new Date(todayUtc.getTime() + offset * 86400000)));
    }
    return dates;
  }

  async function fetchQaLeaderboardDay(date, force=false){
    const key = String(date || '');
    const team = (cfg().team && cfg().team.id) || cfg().team_id || 'default';
    const cacheKey = `${team}:${key}`;
    const isCurrentShiftDate = key === qaShiftTodayKey();
    if (!force && !isCurrentShiftDate && qaLeaderboardDailyCache.has(cacheKey)) return qaLeaderboardDailyCache.get(cacheKey);
    const res = await fetchQaLeaderboardDayFromNode(key, force || isCurrentShiftDate);
    if (!res || res.success === false) throw new Error(res?.error || 'QA leaderboard failed');
    qaLeaderboardDailyCache.set(cacheKey, res);
    return res;
  }

  async function buildQaWeeklyLeaderboard(force=false){
    const dates = qaWeekDates(qaLeaderboardDate);
    const days = await Promise.all(dates.map((date) => fetchQaLeaderboardDay(date, force)));
    const byEmail = new Map();
    days.forEach((day) => {
      (Array.isArray(day?.leaderboard) ? day.leaderboard : []).forEach((row) => {
        const email = String(row.email || '').toLowerCase().trim();
        if (!email) return;
        if (!byEmail.has(email)) {
          byEmail.set(email, {
            email,
            name: String(row.name || email).trim(),
            approved_count: 0,
            points: 0,
            projects_per_hour: 0,
            points_per_hour: 0
            ,active_hours: 0
            ,shift_count: 0
            ,shifts: []
          });
        }
        const target = byEmail.get(email);
        target.approved_count += Number(row.approved_count || 0);
        target.points += Number(row.points || 0);
        target.active_hours += Number(row.active_hours || 0);
        target.shift_count += Number(row.shift_count || 0);
        target.shifts.push(...(Array.isArray(row.shifts) ? row.shifts : []));
        if (!target.name || target.name === target.email) target.name = String(row.name || email).trim();
      });
    });
    const list = Array.from(byEmail.values()).sort((a, b) => {
      if (Number(a.points) !== Number(b.points)) return Number(b.points) - Number(a.points);
      if (Number(a.approved_count) !== Number(b.approved_count)) return Number(b.approved_count) - Number(a.approved_count);
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    list.forEach((row, idx) => {
      row.rank = idx + 1;
      row.points = Math.round(Number(row.points || 0) * 100) / 100;
      row.projects_per_hour = row.active_hours > 0 ? Math.round((Number(row.approved_count || 0) / row.active_hours) * 100) / 100 : 0;
      row.points_per_hour = row.active_hours > 0 ? Math.round((Number(row.points || 0) / row.active_hours) * 100) / 100 : 0;
    });
    return {
      success: true,
      leaderboard: list,
      range: 'week',
      dates,
      timezone: QA_SHIFT_TIME_ZONE,
      cached: days.every((day) => !!day?.cached)
    };
  }

  function fmActor(){
    if (typeof Portal.fmActor === 'function' || typeof Portal.internalActor === 'function') {
      const actor = (typeof Portal.fmActor === 'function' ? Portal.fmActor() : Portal.internalActor()) || {};
      const roles = new Set(Array.isArray(actor.roles) ? actor.roles : []);
      if (canDoQA()) roles.add('qa');
      if (canManagerReview()) roles.add('manager');
      return {
        ...actor,
        role: actor.role || (canManagerReview() ? 'manager' : (canDoQA() ? 'qa' : undefined)),
        roles: Array.from(roles)
      };
    }
    const user = (cfg().user || {});
    const actor = {};
    if (user.email) actor.email = user.email;
    if (user.name) actor.name = user.name;
    const teamId = normalizeQaActorTeamId(user.team_id);
    if (teamId) actor.team_id = teamId;
    if (user.organization_id) actor.organization_id = user.organization_id;
    const roles = [];
    if (canDoQA()) roles.push('qa');
    if (canManagerReview()) roles.push('manager');
    if (user.is_admin) roles.push('admin');
    if (cfg().flags && cfg().flags.is_queue_admin) roles.push('queue_admin');
    if (user.role) actor.role = user.role;
    else if (canManagerReview()) actor.role = 'manager';
    else if (canDoQA()) actor.role = 'qa';
    actor.roles = Array.from(new Set(roles));
    return actor;
  }

  async function fmPost(path, payload, ms, opts){
    const body = { ...(payload || {}) };
    const includeActor = !opts || opts.includeActor !== false;
    if (includeActor && !body.actor) {
      body.actor = fmActor();
    }
    return await withTimeout(
      Portal.fmPost(path, body),
      ms || 25000,
      'Request timed out'
    );
  }

  async function pullQaQueueWithBusyRetry(payload){
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await fmPost('qa/queue/pull', payload, 20000);
      } catch (error) {
        lastError = error;
        const retryable = error?.status === 503 && error?.data?.retryable === true;
        if (!retryable || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * (2 ** attempt)));
      }
    }
    throw lastError || new Error('Failed to grab the next QA project.');
  }

  function fmArtifactUrl(folderId, fileName){
    return Portal.fmUrl(`projects/${encodeURIComponent(folderId)}/artifacts/${encodeURIComponent(fileName)}`);
  }

  function fmProjectPdfUrl(folderId, slot){
    const query = new URLSearchParams({ slot: slot || 'main' });
    return `${Portal.fmUrl(`projects/${encodeURIComponent(folderId)}/pdf`)}?${query.toString()}`;
  }

  async function fmGetEditorBundle(folderId, ms, opts){
    if (opts && opts.force) clearQaEditorBundleCache(folderId);
    const cached = (opts && opts.force) ? null : readQaEditorBundleCache(folderId);
    if (cached) return cached;
    const data = await withTimeout(
      Portal.fmJson(`projects/${encodeURIComponent(folderId)}/editor`),
      ms || 20000,
      'Project load timed out'
    );
    writeQaEditorBundleCache(folderId, data);
    return data;
  }

  function qaEditorBundleCacheKey(folderId){
    return `qa_editor_bundle:v1:${firstMeasureApiBase()}:${String(folderId || '').trim()}`;
  }

  function readQaEditorBundleCache(folderId, maxAgeMs = 120000){
    if (!folderId || !window.sessionStorage) return null;
    try {
      const raw = sessionStorage.getItem(qaEditorBundleCacheKey(folderId));
      if (!raw) return null;
      const wrapped = JSON.parse(raw);
      const savedAt = Number(wrapped && wrapped.savedAt);
      if (!savedAt || Date.now() - savedAt > maxAgeMs) return null;
      return wrapped.data && typeof wrapped.data === 'object' ? wrapped.data : null;
    } catch (e) {
      return null;
    }
  }

  function writeQaEditorBundleCache(folderId, data){
    if (!folderId || !data || typeof data !== 'object' || !window.sessionStorage) return;
    try {
      sessionStorage.setItem(qaEditorBundleCacheKey(folderId), JSON.stringify({
        savedAt: Date.now(),
        data
      }));
    } catch (e) {}
  }

  function updateQaEditorBundleCache(folderId, patch){
    const cached = readQaEditorBundleCache(folderId);
    if (!cached || !patch || typeof patch !== 'object') return;
    writeQaEditorBundleCache(folderId, { ...cached, ...patch });
  }

  function clearQaEditorBundleCache(folderId){
    if (!folderId || !window.sessionStorage) return;
    try {
      sessionStorage.removeItem(qaEditorBundleCacheKey(folderId));
    } catch (e) {}
  }

  function cloneJson(value, fallback = null){
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return fallback;
    }
  }

  function getDraftMetaKey(){
    return 'qa_thread_drafts';
  }

  function getDraftScope(){
    return isManagerReviewMode ? 'manager' : 'qa';
  }

  function getCurrentAppMetadata(){
    return (currentAppMetadata && typeof currentAppMetadata === 'object')
      ? cloneJson(currentAppMetadata, {})
      : {};
  }

  function getDraftThreadsFromMeta(meta, scope){
    const drafts = meta && typeof meta === 'object' ? meta[getDraftMetaKey()] : null;
    const bucket = drafts && typeof drafts === 'object' ? drafts[scope] : null;
    return Array.isArray(bucket && bucket.threads) ? cloneJson(bucket.threads, []) : [];
  }

  function mergeThreadDrafts(sourceThreads, draftThreads){
    const baseThreads = Array.isArray(sourceThreads) ? cloneJson(sourceThreads, []) : [];
    const localDrafts = Array.isArray(draftThreads) ? cloneJson(draftThreads, []) : [];
    if (!localDrafts.length) return baseThreads;

    const merged = [];
    const seen = new Set();

    for (const thread of baseThreads) {
      const id = String(thread && thread.id || '');
      const draft = id ? localDrafts.find((item) => String(item && item.id || '') === id) : null;
      if (draft && typeof draft === 'object') {
        merged.push({
          ...thread,
          ...draft,
          history: Array.isArray(draft.history) ? draft.history : (Array.isArray(thread.history) ? thread.history : [])
        });
        seen.add(id);
      } else {
        merged.push(thread);
      }
    }

    for (const draft of localDrafts) {
      const id = String(draft && draft.id || '');
      if (id && seen.has(id)) continue;
      if (draft && typeof draft === 'object') merged.push(draft);
    }

    return merged;
  }

  async function persistThreadDrafts(){
    if (!currentId) return false;
    const nextMeta = getCurrentAppMetadata();
    const draftKey = getDraftMetaKey();
    const drafts = (nextMeta[draftKey] && typeof nextMeta[draftKey] === 'object')
      ? cloneJson(nextMeta[draftKey], {})
      : {};
    drafts[getDraftScope()] = {
      saved_at: new Date().toISOString(),
      threads: cloneJson(qaThreads, [])
    };
    nextMeta[draftKey] = drafts;

    await Portal.fmJson(`projects/${encodeURIComponent(currentId)}/editor/save`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ metadata: nextMeta })
    });

    currentAppMetadata = cloneJson(nextMeta, {});
    updateQaEditorBundleCache(currentId, { app_metadata: currentAppMetadata });
    return true;
  }

  async function clearThreadDrafts(scope = getDraftScope()){
    if (!currentId) return false;
    const nextMeta = getCurrentAppMetadata();
    const draftKey = getDraftMetaKey();
    const drafts = (nextMeta[draftKey] && typeof nextMeta[draftKey] === 'object')
      ? cloneJson(nextMeta[draftKey], {})
      : {};
    delete drafts[scope];
    if (Object.keys(drafts).length > 0) nextMeta[draftKey] = drafts;
    else delete nextMeta[draftKey];

    await Portal.fmJson(`projects/${encodeURIComponent(currentId)}/editor/save`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ metadata: nextMeta })
    });

    currentAppMetadata = cloneJson(nextMeta, {});
    updateQaEditorBundleCache(currentId, { app_metadata: currentAppMetadata });
    return true;
  }

  function firstMeasureApiBase(){
    const explicit = (cfg().endpoints && cfg().endpoints.firstmeasure) ? String(cfg().endpoints.firstmeasure).trim() : '';
    if (explicit) return explicit.replace(/\/+$/, '');
    if (typeof Portal.fmUrl === 'function') {
      const probe = String(Portal.fmUrl('')).trim();
      if (probe) return probe.replace(/\/+$/, '');
    }
    return `${window.location.origin.replace(/\/+$/, '')}/v1/firstmeasure`;
  }

  function resolveFirstMeasureAssetUrl(url){
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^[a-z]+:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
    if (currentId && !/[\\/]/.test(raw)) return fmArtifactUrl(currentId, raw);
    const apiBase = firstMeasureApiBase();
    if (raw.startsWith('/v1/firstmeasure/')) {
      const apiOrigin = apiBase.replace(/\/v1\/firstmeasure\/?$/i, '');
      return `${apiOrigin}${raw}`;
    }
    if (raw.startsWith('/')) {
      const root = new URL(apiBase);
      return `${root.protocol}//${root.host}${raw}`;
    }
    return new URL(raw, `${apiBase}/`).href;
  }

  function hasOwn(obj, key){
    return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function buildSubmissionSourcesFromFinalizeState(finalizeState){
    if (!finalizeState || typeof finalizeState !== 'object') return null;
    const notes = typeof finalizeState.notes === 'string' ? finalizeState.notes : '';
    const images = Array.isArray(finalizeState.images) ? finalizeState.images.map((entry, index) => {
      if (entry && typeof entry === 'object') {
        const rawUrl = String(entry.url || entry.file_name || entry.name || entry.filename || entry.dataUrl || '').trim();
        if (!rawUrl) return null;
        return {
          url: rawUrl,
          original_name: String(entry.original_name || entry.name || entry.file_name || entry.filename || `source_${index + 1}`)
        };
      }
      const raw = String(entry || '').trim();
      if (!raw) return null;
      return { url: raw, original_name: `source_${index + 1}` };
    }).filter(Boolean) : [];

    return { notes, images };
  }

  function normalizeSubmissionSources(rawSources){
    if (!rawSources || typeof rawSources !== 'object') return { notes: '', images: [], submitted_at: '', submitted_by: '' };
    const notes = typeof rawSources.notes === 'string' ? rawSources.notes : '';
    const images = Array.isArray(rawSources.images) ? rawSources.images.map((entry, index) => {
      const image = (entry && typeof entry === 'object') ? entry : { url: entry };
      const rawUrl = String(image.url || image.file_name || image.name || image.filename || '').trim();
      if (!rawUrl) return null;
      return {
        ...image,
        url: resolveFirstMeasureAssetUrl(rawUrl),
        original_name: String(image.original_name || image.name || image.file_name || image.filename || `source_${index + 1}`)
      };
    }).filter(Boolean) : [];

    return {
      notes,
      images,
      submitted_at: typeof rawSources.submitted_at === 'string' ? rawSources.submitted_at : '',
      submitted_by: typeof rawSources.submitted_by === 'string' ? rawSources.submitted_by : ''
    };
  }

  function getSubmissionSources(){
    const meta = getCurrentAppMetadata();
    if (hasOwn(meta, 'submission_sources')) {
      const normalized = normalizeSubmissionSources(meta.submission_sources);
      if (qaPdfDebugEnabled()) console.log('[QA References] using app_metadata.submission_sources', normalized, meta.submission_sources);
      return normalized;
    }

    if (currentManifest && hasOwn(currentManifest, 'submission_sources')) {
      const normalized = normalizeSubmissionSources(currentManifest.submission_sources);
      if (qaPdfDebugEnabled()) console.log('[QA References] using manifest.submission_sources', normalized, currentManifest.submission_sources);
      return normalized;
    }

    const pdfState = getQaPdfState();
    if (pdfState && pdfState.finalizeSources) {
      const normalized = normalizeSubmissionSources(buildSubmissionSourcesFromFinalizeState(pdfState.finalizeSources));
      if (qaPdfDebugEnabled()) console.log('[QA References] using pdf_state.finalizeSources', normalized, pdfState.finalizeSources);
      return normalized;
    }

    if (meta && meta.pdfConfig && meta.pdfConfig.finalizeSources) {
      const normalized = normalizeSubmissionSources(buildSubmissionSourcesFromFinalizeState(meta.pdfConfig.finalizeSources));
      if (qaPdfDebugEnabled()) console.log('[QA References] using app_metadata.pdfConfig.finalizeSources', normalized, meta.pdfConfig.finalizeSources);
      return normalized;
    }

    if (qaPdfDebugEnabled()) console.log('[QA References] no submission source data found', {
      app_metadata_keys: meta && typeof meta === 'object' ? Object.keys(meta) : [],
      manifest_keys: currentManifest && typeof currentManifest === 'object' ? Object.keys(currentManifest) : [],
      has_pdf_state: !!pdfState
    });
    return normalizeSubmissionSources(null);
  }

  // ----------------- DURATION HELPERS -----------------
  function formatDuration(ms){
    if (!ms || ms <= 0) return '—';
    const totalMin = Math.floor(ms / 60000);
    if (totalMin < 60) return `${totalMin}m`;
    const hrs = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    if (hrs < 24) return `${hrs}h ${min}m`;
    const days = Math.floor(hrs / 24);
    const remHrs = hrs % 24;
    return `${days}d ${remHrs}h`;
  }

  function getTechnicianMeta(source, manifest){
    const item = (source && typeof source === 'object') ? source : {};
    const mf = (manifest && typeof manifest === 'object') ? manifest : {};
    const workHistory = Array.isArray(item.work_history)
      ? item.work_history
      : (Array.isArray(mf.work_history) ? mf.work_history : []);
    let original = null;
    let latest = null;
    for (const ev of workHistory) {
      if (!ev || typeof ev !== 'object') continue;
      const email = String(ev.worker_email || ev.assigned_to_email || '').trim();
      const name = String(ev.worker_name || ev.assigned_to_name || '').trim();
      if (!email && !name) continue;
      const entry = { email, name };
      if (!original) original = entry;
      latest = entry;
    }
    const assignedEmail = String(item.assigned_to_email || mf.assigned_to_email || '').trim();
    const assignedName = String(item.assigned_to_name || mf.assigned_to_name || '').trim();
    const current = (assignedEmail || assignedName) ? { email: assignedEmail, name: assignedName } : null;
    const display = current || latest || original || null;
    return { original, latest, current, display };
  }

  function getTechnicianLabel(source, manifest){
    if (!canSeeQaTechnicianIdentity()) return blindTechnicianLabel();
    const tech = getTechnicianMeta(source, manifest).display;
    if (!tech) return '—';
    return tech.name || tech.email || '—';
  }

  function firstTextValue(values){
    for (const value of values) {
      if (value == null) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return '';
  }

  function getRequestedByMeta(source, manifest){
    const item = (source && typeof source === 'object') ? source : {};
    const mf = (manifest && typeof manifest === 'object') ? manifest : {};

    for (const candidate of [item, mf]) {
      if (!candidate || typeof candidate !== 'object') continue;
      const issuer = (candidate.issuer && typeof candidate.issuer === 'object') ? candidate.issuer : {};
      const ownerRef = (candidate.owner_ref && typeof candidate.owner_ref === 'object') ? candidate.owner_ref : {};
      const name = firstTextValue([
        candidate.owner,
        candidate.owner_name,
        issuer.name,
        candidate.issuer_name,
        ownerRef.name
      ]);
      const email = firstTextValue([
        candidate.owner_email,
        issuer.email,
        candidate.issuer_email,
        ownerRef.email
      ]);
      if (name || email) {
        return {
          name,
          email,
          display: name || email || '—'
        };
      }
    }

    return { name: '', email: '', display: '—' };
  }

  function getQaApprovalMeta(source, manifest){
    const item = (source && typeof source === 'object') ? source : {};
    const mf = (manifest && typeof manifest === 'object') ? manifest : {};
    const workHistory = Array.isArray(mf.work_history)
      ? mf.work_history
      : (Array.isArray(item.work_history) ? item.work_history : []);

    let name = firstTextValue([
      item.qa_approved_by_name,
      item.qa_reviewed_by_name,
      mf.qa_approved_by_name,
      mf.qa_reviewed_by_name
    ]);
    let email = firstTextValue([
      item.qa_approved_by,
      item.qa_reviewed_by,
      mf.qa_approved_by,
      mf.qa_reviewed_by
    ]);
    let at = firstTextValue([
      item.qa_approved_at,
      item.qa_reviewed_at,
      mf.qa_approved_at,
      mf.qa_reviewed_at
    ]);

    for (let i = workHistory.length - 1; i >= 0 && (!name || !email || !at); i--) {
      const ev = workHistory[i];
      if (!ev || typeof ev !== 'object') continue;
      const event = String(ev.event || '').trim();
      if (!['qa_approved_pending_manager', 'qa_approved', 'qa_reviewed'].includes(event)) continue;
      if (!name) name = firstTextValue([ev.qa_name, ev.inspector_name, ev.user_name]);
      if (!email) email = firstTextValue([ev.qa_email, ev.inspector, ev.user_email]);
      if (!at) at = firstTextValue([ev.ts, ev.date, ev.created_at]);
    }

    if (!canSeeQaTechnicianIdentity()) {
      return { name: '', email: '', at, display: blindTechnicianLabel() };
    }

    return {
      name,
      email,
      at,
      display: name || email || '—'
    };
  }

  // ----------------- SORT HELPERS -----------------
  function getSortValue(item, col){
    switch(col){
      case QA_PRIORITY_SORT: return Number(item.qa_priority_rank || 0) || 0;
      case 'address': return (item.address || '').toLowerCase();
      case 'requested_by': return getRequestedByMeta(item).display.toLowerCase();
      case 'created_at': return new Date(String(item.created_at || '').replace(' ','T')).getTime() || 0;
      case 'entered_qa': return new Date(String(item.date || item.uploaded_at || '').replace(' ','T')).getTime() || 0;
      case 'drafter': return getTechnicianLabel(item).toLowerCase();
      case 'status': return (item.status || '').toLowerCase();
      default: return '';
    }
  }

  function sortItems(items, col, dir){
    const sorted = [...items];
    sorted.sort((a, b) => {
      let va = getSortValue(a, col);
      let vb = getSortValue(b, col);
      if (typeof va === 'number' && typeof vb === 'number') {
        return dir === 'asc' ? va - vb : vb - va;
      }
      if (va < vb) return dir === 'asc' ? -1 : 1;
      if (va > vb) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }

  function qaNumber(value, fallback = NaN){
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function getQaScoreValue(item){
    const rank = item && item.qa_rank ? item.qa_rank : {};
    return qaNumber(item?.qa_error_score ?? item?.qa_priority_rank_score ?? rank.error_score);
  }

  function getQaProjectPoints(item){
    const rank = item && item.qa_rank ? item.qa_rank : {};
    return qaNumber(item?.project_points ?? rank.project_points);
  }

  function getQaHeightPoints(item){
    const rank = item && item.qa_rank ? item.qa_rank : {};
    return qaNumber(item?.height_quality_points ?? rank.height_quality_points);
  }

  function getQaDrafterRank(item){
    const rank = item && item.qa_rank ? item.qa_rank : {};
    const value = String(item?.drafter_rank ?? rank.drafter_rank ?? 'junior').trim().toLowerCase();
    return ['junior', 'standard', 'senior'].includes(value) ? value : 'junior';
  }

  function getQaTechnicianEmail(item){
    const tech = getTechnicianMeta(item).display;
    return String(tech?.email || item?.qa_paid_to_email || item?.assigned_to_email || item?.drafter_email || item?.technician_email || '').trim().toLowerCase();
  }

  function getBulkCriteria(){
    const rankValue = document.getElementById('qaBulkRank')?.value || '';
    let drafterRanks = [];
    if (rankValue === 'standard_plus') drafterRanks = ['standard', 'senior'];
    else if (rankValue) drafterRanks = [rankValue];
    const maxHeightRaw = document.getElementById('qaBulkMaxHeight')?.value;
    const maxProjectRaw = document.getElementById('qaBulkMaxComplexity')?.value;
    const criteria = {
      max_score: qaNumber(document.getElementById('qaBulkMaxScore')?.value, 10),
      drafter_ranks: drafterRanks,
      technician_email: String(document.getElementById('qaBulkTechnician')?.value || '').trim().toLowerCase(),
      include_claimed: document.getElementById('qaBulkIncludeClaimed')?.value === '1',
      include_vip: !!document.getElementById('qaBulkIncludeVip')?.checked,
      include_expedited: true
    };
    if (maxHeightRaw !== '') criteria.max_height_points = qaNumber(maxHeightRaw);
    if (maxProjectRaw !== '') criteria.max_project_points = qaNumber(maxProjectRaw);
    return criteria;
  }

  function qaBulkMatches(item, criteria){
    const score = getQaScoreValue(item);
    if (!Number.isFinite(score) || score > qaNumber(criteria.max_score, 10)) return false;
    if (Number.isFinite(qaNumber(criteria.max_height_points)) && getQaHeightPoints(item) > qaNumber(criteria.max_height_points)) return false;
    if (Number.isFinite(qaNumber(criteria.max_project_points)) && getQaProjectPoints(item) > qaNumber(criteria.max_project_points)) return false;
    if (Array.isArray(criteria.drafter_ranks) && criteria.drafter_ranks.length && !criteria.drafter_ranks.includes(getQaDrafterRank(item))) return false;
    if (criteria.technician_email && getQaTechnicianEmail(item) !== criteria.technician_email) return false;
    if (!criteria.include_claimed && String(item.qa_claimed_by_email || '').trim()) return false;
    if (!criteria.include_vip && !!item.is_vip) return false;
    return String(item.status || 'awaiting_review').trim().toLowerCase() === 'awaiting_review';
  }

  function getBulkApprovalMatches(){
    if (!canManagerReview()) return [];
    const criteria = getBulkCriteria();
    return pendingList.filter((item) => qaBulkMatches(item, criteria));
  }

  function qaBulkItemId(item){
    return String(item && item.id ? item.id : '').trim();
  }

  function syncBulkSelectionWithMatches(matches){
    const ids = new Set(matches.map(qaBulkItemId).filter(Boolean));
    Array.from(qaBulkSelectedIds).forEach((id) => {
      if (!ids.has(id)) qaBulkSelectedIds.delete(id);
    });
    matches.forEach((item) => {
      const id = qaBulkItemId(item);
      if (id && !qaBulkRowStatus.has(id) && !qaBulkRunActive) qaBulkSelectedIds.add(id);
    });
  }

  function getBulkSelectedMatches(matches){
    return matches.filter((item) => qaBulkSelectedIds.has(qaBulkItemId(item)));
  }

  function getBulkItemApprovalTime(item){
    const approval = getQaApprovalMeta(item);
    return approval && approval.at ? fmtDateShort(approval.at) : 'Pending';
  }

  function getBulkStatusMeta(id){
    const raw = qaBulkRowStatus.get(id) || {};
    const status = raw.status || 'queued';
    if (status === 'running') return { cls: 'running', icon: 'fa-spinner fa-spin', label: raw.label || 'Sending' };
    if (status === 'success') return { cls: 'success', icon: 'fa-check', label: raw.label || 'Approved' };
    if (status === 'error') return { cls: 'error', icon: 'fa-triangle-exclamation', label: raw.label || 'Failed' };
    return { cls: 'queued', icon: 'fa-clock', label: raw.label || 'Queued' };
  }

  function renderBulkApprovalRows(matches){
    if (!matches.length) return '<div class="qa-bulk-empty">No matching projects.</div>';
    const selected = getBulkSelectedMatches(matches);
    const rows = matches.map((item, index) => {
      const id = qaBulkItemId(item);
      const checked = qaBulkSelectedIds.has(id);
      const status = getBulkStatusMeta(id);
      const statusRaw = qaBulkRowStatus.get(id) || {};
      const rowCls = [
        'qa-bulk-row',
        checked ? '' : 'is-unchecked',
        status.cls === 'running' ? 'is-running' : '',
        status.cls === 'success' ? 'is-success' : '',
        status.cls === 'error' ? 'is-error' : ''
      ].filter(Boolean).join(' ');
      const drafter = getTechnicianLabel(item);
      const score = formatOneDecimal(getQaScoreValue(item));
      const approvalTime = statusRaw.approvedAt ? fmtDateShort(statusRaw.approvedAt) : getBulkItemApprovalTime(item);
      const error = statusRaw.error ? `<div class="qa-bulk-row-error">${esc(statusRaw.error)}</div>` : '';
      return `
        <label class="${rowCls}" data-bulk-id="${esc(id)}" data-bulk-index="${index}">
          <input class="qa-bulk-check" type="checkbox" data-bulk-id="${esc(id)}" data-bulk-index="${index}" ${checked ? 'checked' : ''} ${qaBulkRunActive ? 'disabled' : ''}>
          <div class="qa-bulk-main">
            <div class="qa-bulk-address">${esc(item.address || id || 'Project')}</div>
            <div class="qa-bulk-id">${esc(id)}</div>
          </div>
          <div><span class="qa-bulk-meta-label">Drafter</span><span class="qa-bulk-meta-value">${esc(drafter)}</span></div>
          <div><span class="qa-bulk-meta-label">Score</span><span class="qa-bulk-meta-value">${esc(score)}</span></div>
          <div><span class="qa-bulk-meta-label">Approval</span><span class="qa-bulk-meta-value">${esc(approvalTime)}</span></div>
          <div><span class="qa-bulk-status ${status.cls}"><i class="fas ${status.icon}"></i>${esc(status.label)}</span></div>
          ${error}
        </label>
      `;
    }).join('');
    return `
      <div class="qa-bulk-selectbar">
        <div><b>${selected.length}</b> selected of <b>${matches.length}</b></div>
        <div class="qa-bulk-select-actions">
          <button class="qa-bulk-link" type="button" id="qaBulkSelectAllBtn">Select all</button>
          <button class="qa-bulk-link" type="button" id="qaBulkSelectNoneBtn">Select none</button>
        </div>
      </div>
      <div class="qa-bulk-list">${rows}</div>
    `;
  }

  function wireBulkPreviewSelection(matches){
    const preview = document.getElementById('qaBulkPreview');
    if (!preview || qaBulkRunActive) return;
    const selectAll = document.getElementById('qaBulkSelectAllBtn');
    const selectNone = document.getElementById('qaBulkSelectNoneBtn');
    if (selectAll) selectAll.onclick = () => {
      matches.forEach((item) => {
        const id = qaBulkItemId(item);
        if (id) qaBulkSelectedIds.add(id);
      });
      qaBulkLastSelectIndex = -1;
      updateQaBulkControls();
    };
    if (selectNone) selectNone.onclick = () => {
      matches.forEach((item) => qaBulkSelectedIds.delete(qaBulkItemId(item)));
      qaBulkLastSelectIndex = -1;
      updateQaBulkControls();
    };
    preview.querySelectorAll('.qa-bulk-check').forEach((input) => {
      input.onclick = (event) => {
        const target = event.currentTarget;
        const index = Number(target.getAttribute('data-bulk-index'));
        const checked = !!target.checked;
        if (event.shiftKey && qaBulkLastSelectIndex >= 0 && Number.isFinite(index)) {
          const start = Math.min(qaBulkLastSelectIndex, index);
          const end = Math.max(qaBulkLastSelectIndex, index);
          for (let i = start; i <= end; i++) {
            const id = qaBulkItemId(matches[i]);
            if (!id) continue;
            if (checked) qaBulkSelectedIds.add(id);
            else qaBulkSelectedIds.delete(id);
          }
        } else {
          const id = String(target.getAttribute('data-bulk-id') || '').trim();
          if (id) {
            if (checked) qaBulkSelectedIds.add(id);
            else qaBulkSelectedIds.delete(id);
          }
        }
        if (Number.isFinite(index)) qaBulkLastSelectIndex = index;
        updateQaBulkControls();
      };
    });
  }

  function updateBulkTechnicianOptions(){
    const select = document.getElementById('qaBulkTechnician');
    if (!select) return;
    const current = select.value;
    const techs = new Map();
    pendingList.forEach((item) => {
      const email = getQaTechnicianEmail(item);
      if (!email) return;
      techs.set(email, getTechnicianLabel(item) || email);
    });
    select.innerHTML = '<option value="">Any technician</option>' + Array.from(techs.entries())
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
      .map(([email, label]) => `<option value="${esc(email)}">${esc(label)}</option>`)
      .join('');
    if (current && techs.has(current)) select.value = current;
  }

  function updateQaBulkControls(){
    const toggle = document.getElementById('qaBulkApproveToggle');
    const panel = document.getElementById('qaBulkApprovePanel');
    if (toggle) toggle.style.display = canBulkApproveQA() ? '' : 'none';
    if (panel && !canBulkApproveQA()) {
      panel.classList.remove('show');
      panel.setAttribute('aria-hidden', 'true');
    }
    if (!canBulkApproveQA()) return;
    updateBulkTechnicianOptions();
    const matches = getBulkApprovalMatches();
    syncBulkSelectionWithMatches(matches);
    const selectedMatches = getBulkSelectedMatches(matches);
    const countEl = document.getElementById('qaBulkCount');
    if (countEl) countEl.innerHTML = `Selected: <b>${selectedMatches.length}</b> / Matches: <b>${matches.length}</b>`;
    const preview = document.getElementById('qaBulkPreview');
    if (preview) {
      preview.innerHTML = matches.length
        ? matches.slice(0, 25).map((item) => `<div>${esc(item.address || item.id || '')} · score ${esc(formatOneDecimal(getQaScoreValue(item)))} · ${esc(getQaDrafterRank(item))}</div>`).join('')
        : 'No matching projects.';
    }
    if (preview) {
      preview.innerHTML = renderBulkApprovalRows(matches);
      wireBulkPreviewSelection(matches);
    }
    const approve = document.getElementById('qaBulkApproveBtn');
    const confirm = document.getElementById('qaBulkConfirm');
    if (approve) approve.disabled = !!qaBulkRunActive || !(selectedMatches.length && confirm && confirm.checked);
  }

  function setBulkApprovalModalOpen(open){
    const panel = document.getElementById('qaBulkApprovePanel');
    if (!panel) return;
    const wasOpen = panel.classList.contains('show');
    if (open && !wasOpen && !qaBulkRunActive) {
      qaBulkSelectedIds.clear();
      qaBulkRowStatus.clear();
      qaBulkLastSelectIndex = -1;
    }
    panel.classList.toggle('show', !!open);
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      updateQaBulkControls();
      setTimeout(() => {
        const first = document.getElementById('qaBulkMaxScore');
        if (first) first.focus();
      }, 0);
    }
  }

  function formatOneDecimal(value){
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    return n.toFixed(1);
  }

  function updateSortHeaders(){
    const headRow = document.getElementById('qaPendingHead');
    if (!headRow) return;
    if (canManageQaQueue()) {
      headRow.querySelectorAll('th.sortable').forEach(th => {
        th.classList.remove('active');
        const icon = th.querySelector('.sort-icon i');
        if (icon) icon.className = 'fas fa-sort';
      });
      const hint = document.getElementById('qaSortHint');
      if (hint) hint.textContent = 'Priority order: Prioritized, VIP/Expedited, then standard; 30-minute batches use QA score then age';
      return;
    }
    headRow.querySelectorAll('th.sortable').forEach(th => {
      const col = th.dataset.col;
      const icon = th.querySelector('.sort-icon i');
      th.classList.toggle('active', col === sortColumn);
      if (col === sortColumn) {
        icon.className = sortDirection === 'asc' ? 'fas fa-sort-up' : 'fas fa-sort-down';
      } else {
        icon.className = 'fas fa-sort';
      }
    });
    const hint = document.getElementById('qaSortHint');
    if (hint) {
      const labels = { address:'Address', requested_by:'Requested By', created_at:'Created', entered_qa:'Entered QA', drafter:'Drafter', status:'Status' };
      hint.textContent = `Sorted by ${labels[sortColumn] || sortColumn} (${sortDirection === 'asc' ? '↑' : '↓'})`;
    }
  }

  function handleSortClick(col){
    if (canManageQaQueue()) return;
    if (sortColumn === col) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = col;
      sortDirection = 'asc';
    }
    persistSortState();
    renderQueue(pendingList, historyList);
  }

  // ----------------- LIGHTBOX -----------------
  function renderLightbox(){
    const lb = document.getElementById('qaLightbox');
    if (!lb) return;
    const item = qaLightboxItems[qaLightboxIndex] || {};
    const img = lb.querySelector('.qa-lightbox-image');
    const title = document.getElementById('qaLightboxTitle');
    const count = document.getElementById('qaLightboxCount');
    const notes = document.getElementById('qaLightboxNotes');
    const rail = document.getElementById('qaLightboxRail');
    if (img) img.src = item.url || '';
    if (img) img.style.display = item.url ? '' : 'none';
    if (title) title.textContent = item.title || item.original_name || item.name || 'Reference Image';
    if (count) count.textContent = qaLightboxItems.length > 1 ? `${qaLightboxIndex + 1} / ${qaLightboxItems.length}` : '';
    if (notes) {
      const noteText = String(item.notes || '').trim();
      notes.textContent = noteText || 'No notes provided.';
      notes.classList.toggle('empty', !noteText);
    }
    lb.querySelectorAll('[data-lightbox-nav]').forEach((btn) => {
      btn.disabled = qaLightboxItems.length <= 1;
    });
    if (rail) {
      rail.innerHTML = qaLightboxItems.length > 1
        ? qaLightboxItems.map((entry, idx) => `<button type="button" class="qa-lightbox-thumb ${idx === qaLightboxIndex ? 'active' : ''}" data-lightbox-index="${idx}" title="${esc(entry.title || entry.original_name || entry.name || '')}"><img src="${esc(entry.url || '')}" alt=""></button>`).join('')
        : '';
      rail.querySelectorAll('[data-lightbox-index]').forEach((btn) => {
        btn.onclick = () => setLightboxIndex(Number(btn.dataset.lightboxIndex || 0));
      });
      rail.querySelector('.qa-lightbox-thumb.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function setLightboxIndex(index){
    if (!qaLightboxItems.length) return;
    const len = qaLightboxItems.length;
    qaLightboxIndex = ((Number(index) || 0) % len + len) % len;
    renderLightbox();
  }

  function showLightbox(src, items = null, startIndex = 0){
    const lb = document.getElementById('qaLightbox');
    if (!lb) return;
    if (Array.isArray(items) && items.length) {
      qaLightboxItems = items.filter(item => item && (item.url || item.notes));
      qaLightboxIndex = Math.max(0, Math.min(qaLightboxItems.length - 1, Number(startIndex) || 0));
    } else {
      qaLightboxItems = [{ url: src, title: 'Image Preview', notes: '' }];
      qaLightboxIndex = 0;
    }
    renderLightbox();
    lb.classList.add('show');
  }
  function hideLightbox(){
    const lb = document.getElementById('qaLightbox');
    if (lb) lb.classList.remove('show');
  }
  function stepLightbox(delta){
    if (!document.getElementById('qaLightbox')?.classList.contains('show')) return;
    if (qaLightboxItems.length <= 1) return;
    setLightboxIndex(qaLightboxIndex + delta);
  }

  function bindQaLightboxImages(root){
    const host = root || document;
    host.querySelectorAll('[data-qa-lightbox-src]').forEach((el) => {
      if (el.dataset.qaLightboxBound === '1') return;
      el.dataset.qaLightboxBound = '1';
      el.addEventListener('click', (event) => {
        event.preventDefault();
        const src = el.getAttribute('data-qa-lightbox-src') || el.getAttribute('src') || '';
        if (src) showLightbox(src);
      });
    });
  }

  // ----------------- NAV -----------------
  function getVisiblePending(){
    if (showFillers) return pendingList;
    return pendingList.filter(x => !x.is_filler);
  }

  function updateNavButtons(){
    const prev = document.getElementById('qaPrevBtn');
    const next = document.getElementById('qaNextBtn');
    if (!prev || !next) return;

    if (isManagerReviewMode) {
      const idx = managerList.findIndex(x => x.id === currentId);
      const hasPrev = idx > 0;
      const hasNext = idx !== -1 && idx < managerList.length - 1;
      prev.disabled = !hasPrev;
      next.disabled = !hasNext;
      prev.onclick = hasPrev ? () => openInspector(managerList[idx - 1].id, { managerMode: true }) : null;
      next.onclick = hasNext ? () => openInspector(managerList[idx + 1].id, { managerMode: true }) : null;
      return;
    }

    const visible = getVisiblePending();
    const idx = visible.findIndex(x => x.id === currentId);
    const hasPrev = idx > 0;
    const hasNext = idx !== -1 && idx < visible.length - 1;
    prev.disabled = !hasPrev;
    next.disabled = !hasNext;
    prev.onclick = hasPrev ? () => openInspector(visible[idx - 1].id) : null;
    next.onclick = hasNext ? () => openInspector(visible[idx + 1].id) : null;
  }

  // ----------------- THREADS -----------------
  function getThreadForItem(itemId){
    const matches = qaThreads.filter(t => t.item_id === itemId);
    if (matches.length === 0) return null;
    return matches.find(t => t.status !== 'resolved' && t.status !== 'closed') || matches[0];
  }

  function createThread(itemId, text, images = []){
    const item = ALL_CHECKLIST_ITEMS.find(i => i.id === itemId);
    const myRole = isManagerReviewMode ? 'manager' : 'qa';
    const thread = {
      id: genId(),
      item_id: itemId,
      label: item ? item.label : itemId,
      category: item ? item.category : 'unknown',
      status: 'open',
      created_at: new Date().toISOString(),
      created_by: cfg().user?.email || myRole,
      history: [{
        ts: new Date().toISOString(),
        by: cfg().user?.email || myRole,
        by_name: cfg().user?.name || (isManagerReviewMode ? 'Manager' : 'QA'),
        role: myRole,
        action: 'opened',
        text: text,
        images: images
      }]
    };
    qaThreads.push(thread);
    persistThreadDrafts().catch((err) => {
      console.warn('Failed to persist QA thread draft:', err);
    });
    return thread;
  }

  function addMessageToThread(threadId, text, images = [], action = 'responded'){
    const thread = qaThreads.find(t => t.id === threadId);
    if (!thread) return;
    const myRole = isManagerReviewMode ? 'manager' : 'qa';
    thread.history.push({
      ts: new Date().toISOString(),
      by: cfg().user?.email || myRole,
      by_name: cfg().user?.name || (isManagerReviewMode ? 'Manager' : 'QA'),
      role: myRole,
      action: action,
      text: text,
      images: images
    });
    if (action === 'resolved' || action === 'closed') {
      const newStatus = (action === 'resolved') ? 'resolved' : 'closed';
      qaThreads.forEach(t => {
        if (t.item_id === thread.item_id) t.status = newStatus;
      });
    }
    persistThreadDrafts().catch((err) => {
      console.warn('Failed to persist QA thread draft:', err);
    });
  }

  function getThreadStats(){
    let open = 0, resolved = 0, disputed = 0, fixed = 0;
    for (const t of qaThreads){
      if (t.status === 'open') open++;
      else if (t.status === 'resolved') resolved++;
      else if (t.status === 'disputed') disputed++;
      else if (t.status === 'fixed') fixed++;
    }
    return { open, resolved, disputed, fixed, total: qaThreads.length };
  }

  // ----------------- RESOLVE ALL ISSUES -----------------
  function resolveAllIssues(){
    const stats = getThreadStats();
    const toResolve = qaThreads.filter(t => t.status !== 'resolved' && t.status !== 'closed');
    if (toResolve.length === 0) return;

    const countLabel = toResolve.length === 1 ? '1 open issue' : `${toResolve.length} open issues`;
    const note = prompt(
      `Resolve all ${countLabel}?\n\nThis marks every flagged item as resolved so you can approve the project.\nAdd an optional note (e.g. "Reviewed — no actual issues found"):`,
      'Reviewed — no corrections needed'
    );
    if (note === null) return; // cancelled

    const myRole = isManagerReviewMode ? 'manager' : 'qa';
    const resolveNote = note.trim() || 'Resolved by QA — no corrections required.';

    for (const thread of toResolve) {
      thread.history.push({
        ts: new Date().toISOString(),
        by: cfg().user?.email || myRole,
        by_name: cfg().user?.name || (isManagerReviewMode ? 'Manager' : 'QA'),
        role: myRole,
        action: 'resolved',
        text: resolveNote,
        images: []
      });
      thread.status = 'resolved';
    }

    persistThreadDrafts().catch((err) => {
      console.warn('Failed to persist QA thread draft:', err);
    });

    // Collapse all expanded thread panels and re-render
    document.querySelectorAll('.qa-check-item.expanded').forEach(el => el.classList.remove('expanded'));
    renderChecklist();
  }

  // ----------------- SUBMISSION SOURCES -----------------
  function renderSubmissionSources(){
    const hosts = [document.getElementById('qaSubmissionRefs')].filter(Boolean);
    if (!hosts.length) return;
    hosts.forEach((host) => {
      host.classList.remove('show');
      host.innerHTML = '';
    });
    if (!currentManifest) return;

    const sources = getSubmissionSources();
    const hasNotes = sources && sources.notes && sources.notes.trim();
    const hasImages = sources && Array.isArray(sources.images) && sources.images.length > 0;
    if (!hasNotes && !hasImages) {
      hosts.forEach((host) => {
        host.innerHTML = '<div class="qa-reference-empty"><i class="fas fa-paperclip"></i> No technician references were provided.</div>';
      });
      return;
    }

    const notes = String(sources.notes || '').trim();
    const submittedMeta = sources.submitted_at
      ? `Submitted ${fmtDate(sources.submitted_at)}${sources.submitted_by ? ` by ${sources.submitted_by}` : ''}`
      : (sources.submitted_by ? `Submitted by ${sources.submitted_by}` : '');
    const items = hasImages
      ? sources.images
          .map((img, index) => {
            const rawUrl = typeof img === 'string' ? img : (img?.url || '');
            const url = resolveFirstMeasureAssetUrl(rawUrl);
            return {
              url,
              title: (typeof img === 'object' && img ? (img.original_name || img.name || img.file_name || img.filename) : '') || `Reference ${index + 1}`,
              notes
            };
          })
          .filter(item => item.url)
      : [];

    const html = `
      <div class="qa-reference-label">
        <div><i class="fas fa-paperclip"></i> References</div>
        <span>${esc(submittedMeta || (items.length ? `${items.length} image${items.length === 1 ? '' : 's'}` : 'Technician notes'))}</span>
      </div>
      ${notes ? `<button type="button" class="qa-reference-note-btn" data-reference-notes><i class="fas fa-note-sticky"></i><span>Notes</span></button>` : ''}
      ${items.length ? `<div class="qa-reference-thumbs">${items.map((item, idx) => `
        <button type="button" class="qa-reference-thumb" data-reference-index="${idx}" title="${esc(item.title)}">
          <img src="${esc(item.url)}" alt="${esc(item.title)}">
          <span class="idx">${idx + 1}</span>
        </button>
      `).join('')}</div>` : '<div class="qa-reference-empty"><i class="fas fa-note-sticky"></i> Technician notes attached.</div>'}
    `;

    hosts.forEach((host) => {
      host.classList.add('show');
      host.innerHTML = html;
      host.querySelectorAll('[data-reference-index]').forEach((btn) => {
        btn.onclick = () => showLightbox(items[Number(btn.dataset.referenceIndex || 0)]?.url || '', items, Number(btn.dataset.referenceIndex || 0));
      });
      host.querySelectorAll('[data-reference-notes]').forEach((notesBtn) => {
        notesBtn.onclick = () => {
          const noteItems = items.length ? items : [{ url: '', title: 'Technician Notes', notes }];
          showLightbox(noteItems[0]?.url || '', noteItems, 0);
        };
      });
    });
  }

  // ----------------- REJECTION REVIEW -----------------
  function renderRejectionReviewPanel(){
    const body = document.getElementById('qaCheckBody');
    if (!body || !currentManifest) return;

    const existing = body.querySelector('.qa-rejection-review');
    if (existing) existing.remove();

    const rr = currentManifest.rejection_request;
    if (!rr || currentProjectStatus !== 'pending_rejection') return;

    const div = document.createElement('div');
    div.className = 'qa-rejection-review';

    let reasonsHtml = '';
    if (Array.isArray(rr.reasons) && rr.reasons.length > 0) {
      reasonsHtml = '<div class="rr-reasons"><div class="rr-reasons-label">Rejection Reasons</div>';
      for (const reason of rr.reasons) {
        reasonsHtml += `<div class="rr-reason-item"><i class="fas fa-exclamation-circle"></i> ${esc(reason)}</div>`;
      }
      reasonsHtml += '</div>';
    }

    let notesHtml = '';
    if (rr.notes && rr.notes.trim()) {
      notesHtml = `
        <div class="rr-notes-label">Technician Notes</div>
        <div class="rr-notes">${esc(rr.notes)}</div>
      `;
    }

    div.innerHTML = `
      <div class="rr-header"><i class="fas fa-exclamation-triangle"></i> Rejection Requested</div>
      <div class="rr-meta">
        <strong>Requested by:</strong> ${esc(rr.requested_by_name || rr.requested_by || 'Unknown')}<br>
        <strong>Date:</strong> ${fmtDate(rr.requested_at || '')}<br>
        <strong>Previous status:</strong> ${esc(rr.previous_status || 'Unknown')}
      </div>
      ${reasonsHtml}
      ${notesHtml}
      <div class="rr-review-notes">
        <div class="rr-notes-label">Your Review Notes (optional)</div>
        <textarea placeholder="Add any notes about your decision…" id="qaRejectionReviewNotes"></textarea>
      </div>
      <div class="rr-actions">
        <button class="qa-btn warning" id="qaOverturnRejectionBtn"><i class="fas fa-undo"></i> Overturn — Send Back to Drafter</button>
        <button class="qa-btn danger" id="qaConfirmRejectionBtn"><i class="fas fa-times-circle"></i> Confirm Rejection</button>
      </div>
    `;

    div.querySelector('#qaOverturnRejectionBtn').onclick = () => submitRejectionReview('overturned');
    div.querySelector('#qaConfirmRejectionBtn').onclick = () => submitRejectionReview('confirmed');

    body.insertBefore(div, body.firstChild);
  }

  async function submitRejectionReview(decision){
    if (!currentId) return;
    const mySubmit = ++submitSeq;

    const confirmBtn = document.getElementById('qaConfirmRejectionBtn');
    const overturnBtn = document.getElementById('qaOverturnRejectionBtn');
    const activeBtn = (decision === 'confirmed') ? confirmBtn : overturnBtn;
    const otherBtn = (decision === 'confirmed') ? overturnBtn : confirmBtn;
    
    if (!activeBtn) return;

    const confirmMsg = decision === 'confirmed'
      ? 'Are you sure you want to confirm this rejection? The project will be marked as rejected.'
      : 'Are you sure you want to overturn this rejection? The project will be sent back to the drafter for continued work.';

    const ok = await qaConfirm({
      title: decision === 'confirmed' ? 'Confirm rejection?' : 'Overturn rejection?',
      message: confirmMsg,
      confirmHtml: decision === 'confirmed'
        ? '<i class="fas fa-times-circle"></i> Confirm Rejection'
        : '<i class="fas fa-undo"></i> Send Back'
    });
    if (!ok) return;

    const reviewNotes = (document.getElementById('qaRejectionReviewNotes')?.value || '').trim();

    const origActive = activeBtn.innerHTML;
    const origOther = otherBtn ? otherBtn.innerHTML : null;
    activeBtn.disabled = true;
    if (otherBtn) otherBtn.disabled = true;
    activeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processing…`;

    try {
      const res = await reviewPendingRejectionWithNode(decision, reviewNotes);

      if (mySubmit !== submitSeq) return;
      if (!inQAView) return;

      if (res && res.success) {
        closeInspectorToList();
        return;
      }

      const msg = (res && (res.error || res.message)) ? (res.error || res.message) : 'Unknown';
      alert('Error: ' + msg);
      activeBtn.disabled = false;
      activeBtn.innerHTML = origActive;
      if (otherBtn) { otherBtn.disabled = false; otherBtn.innerHTML = origOther; }
    } catch(err) {
      if (mySubmit !== submitSeq) return;
      alert('Network error: ' + (err.message || err));
      activeBtn.disabled = false;
      activeBtn.innerHTML = origActive;
      if (otherBtn) { otherBtn.disabled = false; otherBtn.innerHTML = origOther; }
    }
  }

  // -----------------
  function renderChecklist(){
    const body = document.getElementById('qaCheckBody');
    if (!body) return;
    body.innerHTML = '';

    renderSubmissionSources();

    if (currentProjectStatus === 'pending_rejection') {
      renderRejectionReviewPanel();
    }

    if (isManagerReviewMode) {
      const qaThreadsSummary = (currentManifest && Array.isArray(currentManifest.qa_threads))
        ? currentManifest.qa_threads : [];
      const resolvedCount = qaThreadsSummary.filter(t => t.status === 'resolved' || t.status === 'closed').length;
      const banner = document.createElement('div');
      banner.style.cssText = 'margin:14px 18px; padding:12px 16px; border:1px solid #d1c4e9; border-radius:12px; background:#f3f0fa; font-size:13px; color:#5e35b1; font-weight:700;';
      banner.innerHTML = `<i class="fas fa-user-shield" style="margin-right:6px;"></i> Manager Review Mode — QA passed this project (${resolvedCount}/${qaThreadsSummary.length} threads resolved). Review and give final sign-off below.`;
      body.appendChild(banner);
    }

    for (const cat of getVisibleChecklistCategories()){
      const catDiv = document.createElement('div');
      catDiv.className = 'qa-category';
      catDiv.dataset.catId = cat.id;

      const catIssues = qaThreads.filter(t => t.category === cat.id && t.status !== 'resolved' && t.status !== 'closed').length;

      catDiv.innerHTML = `
        <div class="qa-category-header">
          <div class="icon"><i class="fas ${cat.icon}"></i></div>
          <span>${esc(cat.title)}</span>
          <span class="count ${catIssues > 0 ? 'has-issues' : ''}">${catIssues > 0 ? catIssues + ' issue' + (catIssues > 1 ? 's' : '') : 'All clear'}</span>
        </div>
        <div class="qa-category-items"></div>
      `;

      const itemsContainer = catDiv.querySelector('.qa-category-items');
      for (const item of cat.items){
        const thread = getThreadForItem(item.id);
        const itemDiv = document.createElement('div');
        itemDiv.className = 'qa-check-item';
        itemDiv.dataset.itemId = item.id;
        if (thread) {
          itemDiv.classList.add('has-thread');
          if (thread.status === 'resolved' || thread.status === 'closed') itemDiv.classList.add('resolved');
        }

        let statusBadge = '';
        if (thread) {
          const statusLabels = { open: 'Open', disputed: 'Disputed', fixed: 'Fixed', resolved: 'Resolved', closed: 'Closed' };
          statusBadge = `<span class="status-badge ${thread.status}">${statusLabels[thread.status] || thread.status}</span>`;
        }

        itemDiv.innerHTML = `
          <div class="qa-check-item-header">
            <div style="flex:1;">
              <div class="label">${esc(item.label)}</div>
              ${item.hint ? `<div class="hint">${esc(item.hint)}</div>` : ''}
            </div>
            ${statusBadge}
            <div class="toggle-btn ${thread ? 'active' : ''}" title="${thread ? 'View/Edit Issue' : 'Flag Issue'}">
              <i class="fas ${thread ? 'fa-comment-dots' : 'fa-flag'}"></i>
            </div>
          </div>
          <div class="qa-thread-panel"></div>
        `;

        itemDiv.querySelector('.toggle-btn').onclick = (e) => {
          e.stopPropagation();
          toggleItemPanel(item.id);
        };

        itemsContainer.appendChild(itemDiv);
      }

      catDiv.querySelector('.qa-category-header').onclick = () => {
        catDiv.classList.toggle('collapsed');
      };

      body.appendChild(catDiv);
    }

    updateActionButtons();
  }

  function toggleItemPanel(itemId){
    const itemDiv = document.querySelector(`.qa-check-item[data-item-id="${itemId}"]`);
    if (!itemDiv) return;
    
    document.querySelectorAll('.qa-check-item.expanded').forEach(el => {
      if (el !== itemDiv) el.classList.remove('expanded');
    });

    itemDiv.classList.toggle('expanded');
    if (itemDiv.classList.contains('expanded')){
      renderThreadPanel(itemId);
    }
  }

  function renderThreadPanel(itemId){
    const itemDiv = document.querySelector(`.qa-check-item[data-item-id="${itemId}"]`);
    if (!itemDiv) return;
    const panel = itemDiv.querySelector('.qa-thread-panel');
    if (!panel) return;

    const thread = getThreadForItem(itemId);

    if (!thread){
      panel.innerHTML = `
        <div class="qa-reply-composer">
          <textarea placeholder="Describe the issue with this item..." id="qaNewIssueText_${itemId}"></textarea>
          <div class="image-upload-area">
            <label class="upload-btn">
              <i class="fas fa-image"></i> Add Image
              <input type="file" accept="image/*" multiple style="display:none;" id="qaNewIssueImages_${itemId}">
            </label>
            <div class="preview-images" id="qaNewIssuePreview_${itemId}"></div>
          </div>
          <div class="actions">
            <button class="qa-btn ${isManagerReviewMode ? 'manager' : 'primary'}" id="qaCreateIssueBtn_${itemId}"><i class="fas fa-flag"></i> Flag Issue</button>
          </div>
        </div>
      `;

      setupImageUpload(`qaNewIssueImages_${itemId}`, `qaNewIssuePreview_${itemId}`);
      
      document.getElementById(`qaCreateIssueBtn_${itemId}`).onclick = async () => {
        const text = document.getElementById(`qaNewIssueText_${itemId}`).value.trim();
        if (!text) { alert('Please describe the issue.'); return; }
        const images = await uploadPendingImages(`qaNewIssuePreview_${itemId}`);
        createThread(itemId, text, images);
        renderChecklist();
        toggleItemPanel(itemId);
      };
    } else {
      let historyHtml = '<div class="qa-thread-history">';
      for (const msg of thread.history){
        const actionBadges = {
          marked_fixed: '<span class="action-badge marked_fixed"><i class="fas fa-wrench"></i> Marked as Fixed</span>',
          disputed: '<span class="action-badge disputed"><i class="fas fa-question-circle"></i> Disputed</span>',
          resolved: '<span class="action-badge resolved"><i class="fas fa-check-circle"></i> Resolved</span>',
          closed: '<span class="action-badge closed"><i class="fas fa-times-circle"></i> Closed</span>'
        };
        
        let imagesHtml = '';
        if (msg.images && msg.images.length > 0){
          imagesHtml = '<div class="images">' + msg.images.map(src => 
            `<img src="${esc(resolveFirstMeasureAssetUrl(src))}" data-qa-lightbox-src="${esc(resolveFirstMeasureAssetUrl(src))}">`
          ).join('') + '</div>';
        }

        const roleLabel = msg.role === 'manager' ? 'Manager' : (msg.role === 'qa' ? 'QA' : 'Drafter');
        const displayName = displayQaActorName(msg.by_name || msg.by, roleLabel);

        historyHtml += `
          <div class="qa-thread-message ${msg.role}">
            <div class="header">
              <span class="name">${esc(displayName)}</span>
              <span class="role ${msg.role}">${roleLabel}</span>
              <span>${fmtDate(msg.ts)}</span>
            </div>
            <div class="text">${esc(msg.text)}</div>
            ${imagesHtml}
            ${actionBadges[msg.action] || ''}
          </div>
        `;
      }
      historyHtml += '</div>';

      // ── CHANGED: show Resolve button for open, fixed, OR disputed threads ──
      let composerHtml = '';
      if (thread.status !== 'resolved' && thread.status !== 'closed'){
        const btnClass = isManagerReviewMode ? 'manager' : '';
        const canResolve = thread.status === 'open' || thread.status === 'fixed' || thread.status === 'disputed';
        composerHtml = `
          <div class="qa-reply-composer">
            <textarea placeholder="Add a response or resolution note..." id="qaReplyText_${itemId}"></textarea>
            <div class="image-upload-area">
              <label class="upload-btn">
                <i class="fas fa-image"></i> Add Image
                <input type="file" accept="image/*" multiple style="display:none;" id="qaReplyImages_${itemId}">
              </label>
              <div class="preview-images" id="qaReplyPreview_${itemId}"></div>
            </div>
            <div class="actions">
              ${canResolve ?
                `<button class="qa-btn success" id="qaResolveBtn_${itemId}" title="Mark this issue resolved — no correction needed"><i class="fas fa-check-circle"></i> Mark Resolved</button>` : ''}
              <button class="qa-btn ${btnClass}" id="qaReplyBtn_${itemId}"><i class="fas fa-reply"></i> Reply</button>
            </div>
          </div>
        `;
      }

      panel.innerHTML = historyHtml + composerHtml;
      bindQaLightboxImages(panel);

      if (thread.status !== 'resolved' && thread.status !== 'closed'){
        setupImageUpload(`qaReplyImages_${itemId}`, `qaReplyPreview_${itemId}`);
        
        document.getElementById(`qaReplyBtn_${itemId}`).onclick = async () => {
          const text = document.getElementById(`qaReplyText_${itemId}`).value.trim();
          if (!text) { alert('Please enter a response.'); return; }
          const images = await uploadPendingImages(`qaReplyPreview_${itemId}`);
          addMessageToThread(thread.id, text, images, 'responded');
          renderThreadPanel(itemId);
        };

        const resolveBtn = document.getElementById(`qaResolveBtn_${itemId}`);
        if (resolveBtn){
          resolveBtn.onclick = async () => {
            const text = document.getElementById(`qaReplyText_${itemId}`).value.trim() || 'Issue resolved.';
            const images = await uploadPendingImages(`qaReplyPreview_${itemId}`);
            addMessageToThread(thread.id, text, images, 'resolved');
            renderChecklist();
            toggleItemPanel(itemId);
          };
        }
      }
    }
  }

  // ----------------- IMAGE UPLOAD -----------------
  let pendingImages = {};

  function setupImageUpload(inputId, previewId){
    const input = document.getElementById(inputId);
    const preview = document.getElementById(previewId);
    if (!input || !preview) return;

    pendingImages[previewId] = [];

    input.onchange = () => {
      for (const file of input.files){
        if (!file.type.startsWith('image/')) continue;
        pendingImages[previewId].push(file);
        
        const reader = new FileReader();
        reader.onload = (e) => {
          const div = document.createElement('div');
          div.className = 'preview-img';
          div.innerHTML = `<img src="${e.target.result}"><div class="remove"><i class="fas fa-times"></i></div>`;
          div.querySelector('.remove').onclick = () => {
            const idx = pendingImages[previewId].indexOf(file);
            if (idx > -1) pendingImages[previewId].splice(idx, 1);
            div.remove();
          };
          preview.appendChild(div);
        };
        reader.readAsDataURL(file);
      }
      input.value = '';
    };
  }

  async function uploadPendingImages(previewId){
    const files = pendingImages[previewId] || [];
    const urls = [];
    
    for (const file of files){
      const safeName = `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${String(file.name || 'image.png').replace(/[^a-z0-9._-]/gi, '_')}`;
      const formData = new FormData();
      formData.append('file', file, safeName);

      try {
        const resp = await fetch(Portal.fmUrl(`projects/${encodeURIComponent(currentId)}/artifacts`), {
          method: 'POST',
          body: formData
        });
        const text = await resp.text();
        const data = text ? JSON.parse(text) : {};
        if (!resp.ok) {
          throw new Error(data.message || data.error || 'Image upload failed.');
        }
        const savedName = (data && data.artifact && data.artifact.name) ? data.artifact.name : safeName;
        if (savedName){
          urls.push(fmArtifactUrl(currentId, savedName));
        }
      } catch(e){
        console.error('Image upload failed:', e);
      }
    }

    pendingImages[previewId] = [];
    return urls;
  }

  // ----------------- ACTION BUTTONS -----------------
  function getQaActionButton(primaryId, embeddedId){
    if (isEmbeddedQaMode()) return document.getElementById(embeddedId) || document.getElementById(primaryId);
    return document.getElementById(primaryId) || document.getElementById(embeddedId);
  }

  function getQaActionButtons(primaryId, embeddedId){
    return [document.getElementById(primaryId), document.getElementById(embeddedId)].filter(Boolean);
  }

  function updateActionButtons(){
    const stats = getThreadStats();
    const summary = document.getElementById('qaThreadSummary');
    const buttonsDiv = document.getElementById('qaActionButtons');
    const resolveAllRow = document.getElementById('qaResolveAllRow');
    const resolveAllBtn = document.getElementById('qaResolveAllBtn');
    const isCustomerRework = isCurrentCustomerReworkQaJob();

    // Wire resolve-all once (safe to repeat — onclick replaces)
    if (resolveAllBtn) {
      resolveAllBtn.onclick = () => resolveAllIssues();
    }

    if (currentProjectStatus === 'pending_rejection') {
      if (summary) {
        summary.innerHTML = `
          <div class="item" style="color: #b0261e; font-weight: 900;">
            <i class="fas fa-exclamation-triangle" style="margin-right: 4px;"></i>
            Rejection review — use the panel above to confirm or overturn
          </div>
        `;
      }
      if (buttonsDiv) { buttonsDiv.innerHTML = ''; }
      if (resolveAllRow) resolveAllRow.style.display = 'none';
      const releaseBtn = document.getElementById('qaReleaseClaimBtn');
      if (releaseBtn) releaseBtn.style.display = '';
      updateEmbeddedHeaderStats();
      return;
    }

    if (isManagerReviewMode) {
      if (summary) {
        summary.innerHTML = `
          <div class="item"><div class="dot open"></div> ${stats.open} Open</div>
          <div class="item"><div class="dot disputed"></div> ${stats.disputed + stats.fixed} Pending</div>
          <div class="item"><div class="dot resolved"></div> ${stats.resolved} Resolved</div>
          <div class="item" style="margin-left:auto; color:#5e35b1; font-weight:900;">
            <i class="fas fa-user-shield"></i> Manager Sign-off
          </div>
        `;
      }
      if (buttonsDiv) {
        buttonsDiv.innerHTML = `
          <button class="qa-btn success" id="qaManagerApproveBtn"><i class="fas fa-check-double"></i> Final Approve & Send</button>
          <button class="qa-btn danger" id="qaManagerRejectBtn"><i class="fas fa-undo"></i> Request Tech Correction</button>
        `;
        const approveBtn = document.getElementById('qaManagerApproveBtn');
        const rejectBtn = document.getElementById('qaManagerRejectBtn');
        if (approveBtn) approveBtn.onclick = () => submitManagerDecision('approved');
        if (rejectBtn) rejectBtn.onclick = () => submitManagerDecision('rejected');

        const canApprove = stats.open === 0 && stats.disputed === 0 && stats.fixed === 0;
        const canReject = stats.open > 0 || stats.disputed > 0 || stats.fixed > 0;
        if (approveBtn) approveBtn.disabled = !canApprove;
        if (rejectBtn) {
          rejectBtn.style.display = isCustomerRework ? 'none' : '';
          rejectBtn.disabled = isCustomerRework || !canReject;
          rejectBtn.title = isCustomerRework ? 'Customer rework jobs are finalized by QA instead of being returned to the technician.' : '';
        }
      }

      // Show "Resolve All" in manager mode too when there are open issues
      const hasOpenIssues = stats.open > 0 || stats.fixed > 0 || stats.disputed > 0;
      if (resolveAllRow) resolveAllRow.style.display = hasOpenIssues ? '' : 'none';
      if (resolveAllBtn && hasOpenIssues) {
        const count = stats.open + stats.fixed + stats.disputed;
        resolveAllBtn.innerHTML = `<i class="fas fa-check-double"></i> Resolve All Issues (${count})`;
      }

      const releaseBtn = document.getElementById('qaReleaseClaimBtn');
      if (releaseBtn) releaseBtn.style.display = 'none';
      updateEmbeddedHeaderStats();
      return;
    }

    const qaStatus = String(currentProjectStatus || '').trim().toLowerCase();
    if (qaStatus === 'submission_failed') {
      const failure = currentManifest && currentManifest.submission_failure && typeof currentManifest.submission_failure === 'object'
        ? currentManifest.submission_failure
        : {};
      const failureMessage = String(failure.error || 'The server could not deliver this report after multiple attempts.');
      if (summary) {
        summary.innerHTML = `
          <div class="item" style="color:#b3261e;font-weight:950;max-width:100%;">
            <i class="fas fa-triangle-exclamation" style="margin-right:4px;"></i>
            SUBMISSION FAILED: ${esc(failureMessage)}
          </div>
        `;
      }
      if (buttonsDiv) {
        buttonsDiv.innerHTML = `
          <button class="qa-btn success" id="qaApproveBtn"><i class="fas fa-rotate-right"></i> Retry Submission</button>
          <button class="qa-btn primary" id="qaRejectBtn" style="display:none" disabled></button>
          <button class="qa-btn secondary" id="qaCorrectApproveBtn" style="display:none" disabled></button>
        `;
        const retryBtn = document.getElementById('qaApproveBtn');
        if (retryBtn) retryBtn.onclick = () => submitDecision('approved');
      }
      if (resolveAllRow) resolveAllRow.style.display = 'none';
      const releaseBtn = document.getElementById('qaReleaseClaimBtn');
      if (releaseBtn) releaseBtn.style.display = '';
      updateEmbeddedHeaderStats();
      getQaActionButtons('qaApproveBtn', 'qaEmbeddedApproveBtn').forEach((btn) => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-rotate-right"></i> Retry Submission';
      });
      getQaActionButtons('qaRejectBtn', 'qaEmbeddedRejectBtn').forEach((btn) => { btn.style.display = 'none'; btn.disabled = true; });
      getQaActionButtons('qaCorrectApproveBtn', 'qaEmbeddedCorrectApproveBtn').forEach((btn) => { btn.style.display = 'none'; btn.disabled = true; });
      return;
    }
    if (qaStatus && qaStatus !== 'awaiting_review') {
      if (summary) {
        summary.innerHTML = `
          <div class="item" style="color:#5f6368;font-weight:900;">
            <i class="fas fa-circle-half-stroke" style="margin-right:4px;"></i>
            Project status: ${esc(qaStatus)}
          </div>
        `;
      }
      if (buttonsDiv) {
        buttonsDiv.innerHTML = `
          <button class="qa-btn success" id="qaApproveBtn" disabled><i class="fas fa-check"></i> Approve Without Changes</button>
          <button class="qa-btn primary" id="qaRejectBtn" disabled><i class="fas fa-undo"></i> Request Tech Correction</button>
          <button class="qa-btn secondary" id="qaCorrectApproveBtn" disabled><i class="fas fa-tools"></i> Correct and Approve</button>
        `;
      }
      if (resolveAllRow) resolveAllRow.style.display = 'none';
      const releaseBtn = document.getElementById('qaReleaseClaimBtn');
      if (releaseBtn) releaseBtn.style.display = '';
      updateEmbeddedHeaderStats();
      getQaActionButtons('qaApproveBtn', 'qaEmbeddedApproveBtn').forEach((btn) => { btn.disabled = true; });
      getQaActionButtons('qaRejectBtn', 'qaEmbeddedRejectBtn').forEach((btn) => { btn.disabled = true; });
      getQaActionButtons('qaCorrectApproveBtn', 'qaEmbeddedCorrectApproveBtn').forEach((btn) => { btn.disabled = true; });
      return;
    }

    if (summary){
      summary.innerHTML = `
        <div class="item"><div class="dot open"></div> ${stats.open} Open</div>
        <div class="item"><div class="dot disputed"></div> ${stats.disputed + stats.fixed} Pending</div>
        <div class="item"><div class="dot resolved"></div> ${stats.resolved} Resolved</div>
        ${isCustomerRework ? '<div class="item" style="margin-left:auto;color:#5e1681;font-weight:900;"><i class="fas fa-screwdriver-wrench"></i> Customer rework - finalize in QA</div>' : ''}
      `;
    }

    if (buttonsDiv && !buttonsDiv.querySelector('#qaApproveBtn')) {
      buttonsDiv.innerHTML = `
        <button class="qa-btn success" id="qaApproveBtn"><i class="fas fa-check"></i> Approve Without Changes</button>
        <button class="qa-btn primary" id="qaRejectBtn"><i class="fas fa-undo"></i> Request Tech Correction</button>
        <button class="qa-btn secondary" id="qaCorrectApproveBtn"><i class="fas fa-tools"></i> Correct and Approve</button>
      `;
      const approve = document.getElementById('qaApproveBtn');
      const reject = document.getElementById('qaRejectBtn');
      const correct = document.getElementById('qaCorrectApproveBtn');
      if (approve) approve.onclick = () => submitDecision('approved');
      if (reject) reject.onclick = () => submitDecision('rejected');
      if (correct) correct.onclick = () => submitDecision('corrected_approved');
    }

    const canApprove = stats.open === 0 && stats.disputed === 0 && stats.fixed === 0;
    const canReject = stats.open > 0 || stats.disputed > 0 || stats.fixed > 0;
    const fixOnly = isQaFixOnlyMode();

    getQaActionButtons('qaApproveBtn', 'qaEmbeddedApproveBtn').forEach((btn) => { btn.disabled = !canApprove; });
    getQaActionButtons('qaRejectBtn', 'qaEmbeddedRejectBtn').forEach((btn) => {
      btn.style.display = isCustomerRework ? 'none' : '';
      btn.disabled = isCustomerRework || !canReject || fixOnly;
      btn.title = isCustomerRework
        ? 'Customer rework jobs are finalized by QA instead of being returned to the technician.'
        : (fixOnly ? 'Fix-only QA mode is enabled. Correct and approve instead.' : '');
    });
    getQaActionButtons('qaCorrectApproveBtn', 'qaEmbeddedCorrectApproveBtn').forEach((btn) => { btn.disabled = !canReject; });

    // Show "Resolve All" when there are open issues in QA mode
    const hasOpenIssues = stats.open > 0 || stats.fixed > 0 || stats.disputed > 0;
    if (resolveAllRow) resolveAllRow.style.display = hasOpenIssues ? '' : 'none';
    if (resolveAllBtn && hasOpenIssues) {
      const count = stats.open + stats.fixed + stats.disputed;
      resolveAllBtn.innerHTML = `<i class="fas fa-check-double"></i> Resolve All Issues (${count})`;
    }

    const releaseBtn = document.getElementById('qaReleaseClaimBtn');
    if (releaseBtn) releaseBtn.style.display = '';
    updateEmbeddedHeaderStats();
  }

  // ----------------- SUBMIT DECISION (QA) -----------------
  async function submitDecision(status, requestedPdfSync){
    if (!currentId) return;
    if (qaSubmitting) return;
    requestedPdfSync = resolveQaReviewedPdfSync(requestedPdfSync);
    const apiStatus = status === 'corrected_approved' ? 'approved' : status;
    if (apiStatus === 'rejected' && isCurrentCustomerReworkQaJob()) {
      alert('Customer rework jobs should be corrected and approved, or approved without changes. They cannot be sent back to the technician.');
      return;
    }
    if (status === 'rejected' && isQaFixOnlyMode()) {
      alert('Fix-only QA mode is enabled. Correct the issues and approve, or approve without changes.');
      return;
    }
    if (apiStatus === 'approved') {
      const isSubmissionRetry = String(currentProjectStatus || '').trim().toLowerCase() === 'submission_failed';
      const msg = isSubmissionRetry
        ? 'Retry sending this previously approved report? It will leave QA as soon as the server accepts the retry.'
        : status === 'corrected_approved'
        ? 'Approve this corrected report and send it? This will remove it from QA.'
        : 'Approve this report without changes and send it? This will remove it from QA.';
      const ok = await qaConfirm({
        title: isSubmissionRetry ? 'Retry submission?' : 'Approve and send?',
        message: msg,
        confirmHtml: isSubmissionRetry ? '<i class="fas fa-rotate-right"></i> Retry Submission' : '<i class="fas fa-check"></i> Approve & Send'
      });
      if (!ok) return;
    }
    const mySubmit = ++submitSeq;
    
    const approveBtn = getQaActionButton('qaApproveBtn', 'qaEmbeddedApproveBtn');
    const rejectBtn = getQaActionButton('qaRejectBtn', 'qaEmbeddedRejectBtn');
    const correctBtn = getQaActionButton('qaCorrectApproveBtn', 'qaEmbeddedCorrectApproveBtn');
    const btn = status === 'corrected_approved' ? correctBtn : ((apiStatus === 'approved') ? approveBtn : rejectBtn);
    if (!btn) return;
    
    const otherButtons = [approveBtn, rejectBtn, correctBtn].filter((item) => item && item !== btn);
    const original = btn.innerHTML;
    const otherOriginals = otherButtons.map((item) => ({ item, html: item.innerHTML }));
    
    btn.disabled = true;
    otherButtons.forEach((item) => { item.disabled = true; });

    const isVip = !!(currentManifest && currentManifest.is_vip);
    if (apiStatus === 'approved' && isVip) {
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Sending to Manager…`;
    } else {
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processing…`;
    }

    setQaSubmitBlocking(true, apiStatus === 'approved' ? 'Submitting approval...' : 'Sending back to tech...');

    try {
      let reviewedPdfSync = null;
      if (apiStatus === 'approved') {
        setQaSubmitBlocking(true, 'Saving latest editor changes...');
        await saveEmbeddedEditorStateForQaApproval();
        reviewedPdfSync = await ensureQaPdfReportsReadyForSend(requestedPdfSync);
        if (mySubmit !== submitSeq) return;
        if (!inQAView) return;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Submitting...`;
      }
      const res = await fmPost(`projects/${encodeURIComponent(currentId)}/qa/decision`, {
        status: apiStatus,
        ...buildQaDecisionTracking(status),
        pdf_sync_job_id: reviewedPdfSync?.jobId || '',
        pdf_sync_revision: reviewedPdfSync?.revision || '',
        threads: qaThreads,
        actor: fmActor()
      }, 45000);
      if (mySubmit !== submitSeq) return;
      if (!inQAView) return;
      
      if (res && res.success) {
        const verification = await verifyQaDecisionPersisted(currentId, apiStatus, isVip, res);
        if (apiStatus === 'approved') {
          console.info('[QA DELIVERY] Server accepted the reviewed PDF revision; client approval is complete.', {
            projectId: currentId,
            revision: reviewedPdfSync?.revision || null,
            pdfSyncJobId: reviewedPdfSync?.jobId || null,
            deliveryJobId: res.delivery_job_id || null
          });
          setQaSubmitBlocking(false);
        }
        if (apiStatus === 'rejected') {
          await markCurrentProjectReturnToMe().catch((err) => {
            console.warn('Failed to record QA return routing:', err);
          });
        }
        await clearThreadDrafts('qa').catch((err) => {
          console.warn('Failed to clear QA thread draft after submit:', err);
        });
        if (apiStatus === 'rejected' && res.message) alert(res.message);
        setQaSubmitBlocking(false);
        if (verification && verification.emailWarning) {
          console.warn('[QA] Approval completed, but customer email was not confirmed:', verification.emailWarning);
        }
        try {
          await advanceAfterQaFinish();
        } catch (navErr) {
          console.error('[QA] Approval saved, but post-submit routing failed:', navErr);
          await qaNotice(
            'QA approval saved',
            'The project was approved, but moving to the next QA item failed. Returning to the QA queue.'
          );
          await closeInspectorToList({ releaseClaims: true, reason: 'post_submit_navigation_error' });
        }
        return;
      }
      
      const msg = (res && (res.error || res.message)) ? (res.error || res.message) : 'Unknown';
      alert('Error: ' + msg);
    } catch(e){
      if (mySubmit !== submitSeq) return;
      if (!inQAView) return;
      alert('Error: ' + (e && e.message ? e.message : 'Unknown'));
    } finally {
      if (mySubmit !== submitSeq) return;
      if (!inQAView) return;
      setQaSubmitBlocking(false);
      if (btn) { btn.disabled = false; btn.innerHTML = original; }
      otherOriginals.forEach(({ item, html }) => {
        item.disabled = false;
        item.innerHTML = html;
      });
      updateActionButtons();
    }
  }

  async function ensureQaClaimForCurrentProject(){
    if (!currentId) return;
    const res = await fmPost(`projects/${encodeURIComponent(currentId)}/qa/claim`, {}, 15000);
    if (!res || res.success === false) {
      const claimerName = res && (res.claimed_by_name || res.claimed_by);
      const publicClaimerName = displayQaActorName(claimerName, 'another QA reviewer');
      throw new Error(claimerName
        ? `This project is currently claimed by ${publicClaimerName}.`
        : 'This project could not be claimed for QA.');
    }
  }

  function qaDecisionEmailWarning(res){
    const candidates = [
      res && res.email_result,
      res && res.email,
      res && res.send_result,
      res && res.email_summary && res.email_summary.report_email,
      res && res.project && res.project.email_result,
      res && res.project && res.project.email,
      res && res.project && res.project.email_state && res.project.email_state.report_email
    ].filter((item) => item && typeof item === 'object');
    const failed = candidates.find((item) => item.ok === false || item.success === false || item.last_ok === false || item.error);
    if (!failed) return '';
    return String(failed.error || failed.message || 'The customer email did not send.');
  }

  function qaManifestEmailWarning(manifest){
    const state = manifest && manifest.email_state && manifest.email_state.report_email;
    if (!state || typeof state !== 'object') return '';
    if (state.sent_ok === true || state.last_ok === true) return '';
    if (state.last_ok === false || state.sent_ok === false) {
      return String(state.error || state.message || 'The report email has not been confirmed as sent.');
    }
    return '';
  }

  async function verifyQaDecisionPersisted(folderId, apiStatus, wasVip, res){
    if (apiStatus !== 'approved') return { emailWarning: '' };
    if (res && res.accepted === true) {
      console.info('[QA DELIVERY] Server accepted the approval and queued background delivery.', {
        projectId: folderId,
        deliveryJobId: res.delivery_job_id || null,
        pdfSyncJobId: res.pdf_sync_job_id || null
      });
      return { emailWarning: '' };
    }
    let emailWarning = qaDecisionEmailWarning(res);

    const expectedStatuses = wasVip
      ? new Set(['awaiting_manager_review', 'completed'])
      : new Set(['completed']);
    let lastStatus = '';
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt > 0) await sleep(1000);
      const mf = await fetchManifest(folderId, 20000, { force: true });
      const manifest = mf && mf.manifest ? mf.manifest : {};
      const status = String(manifest.status || '').trim().toLowerCase();
      lastStatus = status || lastStatus;
      currentManifest = manifest;
      currentProjectStatus = status || currentProjectStatus;
      if (expectedStatuses.has(status)) {
        if (!emailWarning && !wasVip && status === 'completed') {
          emailWarning = qaManifestEmailWarning(manifest);
        }
        return { emailWarning };
      }
    }

    throw new Error(
      `QA approval returned success, but the project still has status "${lastStatus || 'unknown'}". ` +
      'The UI will stay on this project so it can be retried or inspected.'
    );
  }

  // ----------------- MANAGER DECISION -----------------
  async function submitManagerDecision(status, requestedPdfSync){
    if (!currentId || !isManagerReviewMode) return;
    requestedPdfSync = resolveQaReviewedPdfSync(requestedPdfSync);
    if (status === 'rejected' && isCurrentCustomerReworkQaJob()) {
      alert('Customer rework jobs should be finalized here instead of being sent back to the technician.');
      return;
    }
    const mySubmit = ++submitSeq;

    const approveBtn = getQaActionButton('qaManagerApproveBtn', 'qaEmbeddedApproveBtn');
    const rejectBtn = getQaActionButton('qaManagerRejectBtn', 'qaEmbeddedRejectBtn');
    const btn = (status === 'approved') ? approveBtn : rejectBtn;
    const otherBtn = (status === 'approved') ? rejectBtn : approveBtn;
    if (!btn) return;

    const confirmMsg = status === 'approved'
      ? 'Give final approval? The report will be sent to the customer.'
      : 'Send this back for technician correction? If the original technician is online it will be reserved for them. Otherwise it will enter the open queue for another technician.';
    const ok = await qaConfirm({
      title: status === 'approved' ? 'Final approve and send?' : 'Request manager changes?',
      message: confirmMsg,
      confirmHtml: status === 'approved'
        ? '<i class="fas fa-check-double"></i> Final Approve & Send'
        : '<i class="fas fa-undo"></i> Send Back'
    });
    if (!ok) return;

    const original = btn.innerHTML;
    const otherOriginal = otherBtn ? otherBtn.innerHTML : null;
    btn.disabled = true;
    if (otherBtn) otherBtn.disabled = true;
    setQaSubmitBlocking(true, status === 'approved' ? 'Preparing and sending report...' : 'Sending back to tech...');
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processing…`;

    let reviewedPdfSync = null;
    try {
      if (status === 'approved') {
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Preparing PDFs...`;
        setQaSubmitBlocking(true, 'Saving latest editor changes...');
        await saveEmbeddedEditorStateForQaApproval();
        reviewedPdfSync = await ensureQaPdfReportsReadyForSend(requestedPdfSync);
        if (mySubmit !== submitSeq) return;
        if (!inQAView) return;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processing...`;
        setQaSubmitBlocking(true, 'Sending report...');
      }
      const res = await fmPost(`projects/${encodeURIComponent(currentId)}/manager/decision`, {
        status: status,
        pdf_sync_job_id: reviewedPdfSync?.jobId || '',
        pdf_sync_revision: reviewedPdfSync?.revision || '',
        threads: qaThreads,
        notes: ''
      }, 45000);

      if (mySubmit !== submitSeq) return;
      if (!inQAView) return;

      if (res && res.success) {
        await clearThreadDrafts('manager').catch((err) => {
          console.warn('Failed to clear manager thread draft after submit:', err);
        });
        if (status === 'rejected' && res.message) alert(res.message);
        closeInspectorToList();
        return;
      }

      const msg = (res && (res.error || res.message)) ? (res.error || res.message) : 'Unknown';
      alert('Error: ' + msg);
    } catch(e){
      if (mySubmit !== submitSeq) return;
      if (!inQAView) return;
      alert('Error: ' + (e && e.message ? e.message : 'Unknown'));
    } finally {
      if (mySubmit !== submitSeq) return;
      if (!inQAView) return;
      setQaSubmitBlocking(false);
      if (btn) { btn.disabled = false; btn.innerHTML = original; }
      if (otherBtn) { otherBtn.disabled = false; if (otherOriginal !== null) otherBtn.innerHTML = otherOriginal; }
      updateActionButtons();
    }
  }

  // ----------------- SPLITTER -----------------
  function setDragShield(on){
    const s = document.getElementById('qaDragShield');
    if (!s) return;
    if (on) s.classList.add('show'); else s.classList.remove('show');
  }

  function applySplit(){
    const split = document.getElementById('qaRightSplit');
    if (!split) return;
    split.style.setProperty('--qaSplit', `${qaSplitPct}%`);
    forceResizeMap();
    applyQaImageViewportTransform();
  }

  function computePctFromClientX(clientX){
    const split = document.getElementById('qaRightSplit');
    if (!split) return qaSplitPct;
    const rect = split.getBoundingClientRect();
    const x = clientX - rect.left;
    const pct = (x / rect.width) * 100;
    return clamp(Math.round(pct), 25, 75);
  }

  function wireSplitterOnce(){
    if (splitterWired) return;
    splitterWired = true;
    const splitter = document.getElementById('qaSplitter');
    if (!splitter) return;
    
    const onMove = (e) => {
      if (!splitDragging) return;
      const x = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
      qaSplitPct = computePctFromClientX(x);
      applySplit();
      e.preventDefault();
    };
    
    const stop = () => {
      if (!splitDragging) return;
      splitDragging = false;
      setDragShield(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      forceResizeMap();
    };
    
    splitter.addEventListener('mousedown', (e) => {
      splitDragging = true; setDragShield(true);
      document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
      qaSplitPct = computePctFromClientX(e.clientX); applySplit(); e.preventDefault();
    });
    
    splitter.addEventListener('touchstart', (e) => {
      splitDragging = true; setDragShield(true);
      document.body.style.userSelect = 'none';
      const x = (e.touches && e.touches[0]) ? e.touches[0].clientX : 0;
      qaSplitPct = computePctFromClientX(x); applySplit(); e.preventDefault();
    }, { passive:false });
    
    window.addEventListener('mousemove', onMove, { passive:false });
    window.addEventListener('touchmove', onMove, { passive:false });
    window.addEventListener('mouseup', stop, { passive:true });
    window.addEventListener('touchend', stop, { passive:true });
    window.addEventListener('touchcancel', stop, { passive:true });
    
    const shield = document.getElementById('qaDragShield');
    if (shield) {
      shield.addEventListener('mouseup', stop);
      shield.addEventListener('touchend', stop);
    }
    applySplit();
  }

  // ----------------- MAPS -----------------
  function forceResizeMap(){
    const frames = [
      document.getElementById('qa3DFrame'),
      document.getElementById('qaMapFrame')
    ].filter(Boolean);
    const bump = (delay) => setTimeout(() => {
      frames.forEach((frame) => {
        if (!frame || !frame.contentWindow) return;
        try { frame.contentWindow.dispatchEvent(new Event('resize')); } catch(e){}
      });
    }, delay);
    requestAnimationFrame(() => bump(0));
    bump(120);
    bump(320);
  }

  function initOrReuseActiveMap(){
    return false;
  }

  function setActiveMapLocation(loc){
    activeLastLoc = loc || null;
  }

  function isQaLiveMapMode(viewId){
    const view = String(viewId || '').trim().toLowerCase();
    return view === 'live_quad' || view === 'live_map';
  }

  function setQaTopViewHint(label){
    const hint = document.getElementById('qaTopViewHint');
    if (hint) hint.textContent = String(label || 'QUAD').trim().toUpperCase();
  }

  function applyQaTopViewMode(){
    const mapViewport = document.getElementById('qaMapViewport');
    const imageViewport = document.getElementById('qaImageViewport');
    const isLive = isQaLiveMapMode(qaActiveImageView);
    if (mapViewport) mapViewport.classList.toggle('hidden', !isLive);
    if (imageViewport) imageViewport.style.display = isLive ? 'none' : 'flex';
    if (isLive) {
      const mode = qaActiveImageView === 'live_map' ? 'map' : 'quad';
      setQaTopViewHint(mode === 'map' ? 'MAP' : 'QUAD');
      const frame = document.getElementById('qaMapFrame');
      if (frame && frame.contentWindow) {
        try {
          frame.contentWindow.postMessage({ type: 'qa-map-mode', mode }, '*');
        } catch (e) {}
      }
    } else {
      setQaTopViewHint(getQaImageLabel(qaActiveImageView));
    }
  }

  function clearQa3DViewer(){
    const frame = document.getElementById('qa3DFrame');
    if (frame) frame.src = 'about:blank';
  }

  function setQa3DViewer(folderId){
    const frame = document.getElementById('qa3DFrame');
    if (!frame || !folderId) return;
    const api = firstMeasureApiBase();
    const url = `apps/qa_3d_viewer.php?folder=${encodeURIComponent(folderId)}&api=${encodeURIComponent(api)}&v=${Date.now()}`;
    frame.src = url;
  }

  function clearQaMapViewer(){
    const frame = document.getElementById('qaMapFrame');
    if (frame) frame.src = 'about:blank';
    setQaTopViewHint('QUAD');
  }

  function setQaMapViewer(folderId){
    const frame = document.getElementById('qaMapFrame');
    if (!frame || !folderId) return;
    const api = firstMeasureApiBase();
    const mapsScript = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
    const mapsSrc = mapsScript ? String(mapsScript.src || '').trim() : '';
    const mapUrl =
      `apps/qa_map_viewer.php?folder=${encodeURIComponent(folderId)}` +
      `&api=${encodeURIComponent(api)}` +
      (mapsSrc ? `&maps_src=${encodeURIComponent(mapsSrc)}` : '') +
      `&mode=${encodeURIComponent(qaActiveImageView === 'live_map' ? 'map' : 'quad')}` +
      `&v=${Date.now()}`;
    frame.onload = () => applyQaTopViewMode();
    frame.src = mapUrl;
    setQaTopViewHint(qaActiveImageView === 'live_map' ? 'MAP' : 'QUAD');
  }

  function clearQaQuadView(){
    qaImageAssets = {};
    qaImageBundle = null;
    qaActiveImageView = 'live_quad';
    qaImageCrop = null;
    qaImageLoadToken += 1;
    qaImageViewport.baseWidth = 0;
    qaImageViewport.baseHeight = 0;
    qaImageViewport.zoom = 1;
    qaImageViewport.panX = 0;
    qaImageViewport.panY = 0;
    qaImageViewport.dragging = false;
    const content = document.getElementById('qaImageContent');
    const canvas = document.getElementById('qaImageCanvas');
    const overlay = document.getElementById('qaImageOverlay');
    const empty = document.getElementById('qaQuadEmpty');
    const hud = document.getElementById('qaImageHud');
    const viewport = document.getElementById('qaImageViewport');
    if (content) {
      content.style.display = 'none';
      content.style.width = '0px';
      content.style.height = '0px';
      content.style.transform = 'translate(0px, 0px) scale(1)';
    }
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, 1, 1);
    }
    if (overlay) {
      overlay.innerHTML = '';
      overlay.setAttribute('viewBox', '0 0 1 1');
      overlay.style.display = 'none';
    }
    if (empty) {
      empty.textContent = 'No saved top-down image is available for this project yet.';
      empty.classList.add('show');
    }
    if (hud) hud.style.display = 'none';
    if (viewport) viewport.classList.remove('dragging');
    updateQaImageTabs();
    updateQaImageGeometryUi();
  }

  function getQaImageBundleMeta(){
    return (qaImageBundle && qaImageBundle.app_metadata && typeof qaImageBundle.app_metadata === 'object')
      ? qaImageBundle.app_metadata
      : {};
  }

  function getQaPdfState(){
    return (qaImageBundle && qaImageBundle.pdf_state && typeof qaImageBundle.pdf_state === 'object')
      ? qaImageBundle.pdf_state
      : null;
  }

  function getQaImageBaseDims(viewId, img){
    const meta = getQaImageBundleMeta();
    const pdfState = getQaPdfState();
    if (viewId === 'quad') {
      return {
        width: Math.max(1, Number(img && (img.naturalWidth || img.width)) || 1),
        height: Math.max(1, Number(img && (img.naturalHeight || img.height)) || 1)
      };
    }
    const dims = (pdfState && pdfState.dims) || {};
    const width = Math.round(Number(meta.imageWidth || dims.width || dims.w || (img && (img.naturalWidth || img.width)) || 0));
    const height = Math.round(Number(meta.imageHeight || dims.height || dims.h || (img && (img.naturalHeight || img.height)) || 0));
    return {
      width: Math.max(1, width || 1),
      height: Math.max(1, height || 1)
    };
  }

  function getQaLayerConfig(viewId){
    const meta = getQaImageBundleMeta();
    const cfg = meta.layer_config && typeof meta.layer_config === 'object' ? meta.layer_config[viewId] : null;
    return (cfg && typeof cfg === 'object')
      ? cfg
      : { scale: 1.0, x: 0, y: 0, rot: 0, fineScale: 1.0 };
  }

  function drawQaScaledImage(ctx, img, targetW, targetH, layerCfg){
    const sw = Number(img && (img.naturalWidth || img.width)) || 0;
    const sh = Number(img && (img.naturalHeight || img.height)) || 0;
    if (!(sw > 0 && sh > 0)) return;
    const cfg = layerCfg && typeof layerCfg === 'object' ? layerCfg : {};
    const scale = Number.isFinite(cfg.scale) ? cfg.scale : 1;
    const fineScale = Number.isFinite(cfg.fineScale) ? cfg.fineScale : 1;
    const offX = Number.isFinite(cfg.x) ? cfg.x : 0;
    const offY = Number.isFinite(cfg.y) ? cfg.y : 0;
    const rotRad = Number.isFinite(cfg.rot) ? cfg.rot : 0;
    const effScale = Math.max(0.01, scale * fineScale);
    const cropW = sw / effScale;
    const cropH = sh / effScale;
    let sourceX = (sw - cropW) / 2 + offX;
    let sourceY = (sh - cropH) / 2 + offY;

    ctx.save();
    ctx.clearRect(0, 0, targetW, targetH);
    ctx.translate(targetW / 2, targetH / 2);
    if (rotRad) ctx.rotate(rotRad);
    ctx.drawImage(img, sourceX, sourceY, cropW, cropH, -targetW / 2, -targetH / 2, targetW, targetH);
    ctx.restore();
  }

  function clampQaByte(value){
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(255, Math.round(n)));
  }

  function getQaSavedImageSources(assets){
    const sourceAssets = assets || {};
    return {
      quad: sourceAssets.quad_crop || sourceAssets.quad || '',
      solar: sourceAssets.rgb || sourceAssets.solar || sourceAssets.solarImg || '',
      google: sourceAssets.google || '',
      azure: sourceAssets.azure || '',
      apple: sourceAssets.apple || ''
    };
  }

  function getQaImageLabel(viewId){
    if (viewId === 'live_quad') return 'Quad';
    if (viewId === 'live_map') return 'Map';
    if (viewId === 'quad') return 'Quad';
    if (viewId === 'solar') return 'Solar';
    if (viewId === 'google') return 'Google';
    if (viewId === 'azure') return 'Azure';
    if (viewId === 'apple') return 'Apple';
    return 'Saved';
  }

  function updateQaImageTabs(){
    const wrap = document.getElementById('qaImageTabs');
    if (!wrap) return;
    wrap.querySelectorAll('.qa-mini-tab').forEach((btn) => {
      const view = btn.dataset.view || '';
      const hasAsset = isQaLiveMapMode(view) ? true : !!qaImageAssets[view];
      btn.disabled = !hasAsset;
      btn.classList.toggle('active', view === qaActiveImageView);
      btn.title = hasAsset
        ? (isQaLiveMapMode(view) ? `Show live ${getQaImageLabel(view)} view` : `Show saved ${getQaImageLabel(view)} view`)
        : `${getQaImageLabel(view)} view is not saved for this project`;
    });
  }

  function getQaImageViewportRefs(){
    return {
      viewport: document.getElementById('qaImageViewport'),
      content: document.getElementById('qaImageContent'),
      canvas: document.getElementById('qaImageCanvas'),
      overlay: document.getElementById('qaImageOverlay'),
      legend: document.getElementById('qaImageLegend'),
      empty: document.getElementById('qaQuadEmpty'),
      hud: document.getElementById('qaImageHud')
    };
  }

  function getQaLegendItems(){
    const geometry = getQaImageGeometry();
    if (!geometry || !Array.isArray(geometry.connections)) return [];
    const found = new Set();
    geometry.connections.forEach((conn) => {
      const type = String(conn && conn.type || '').trim().toLowerCase();
      if (type && QA_LINE_TYPES[type]) found.add(type);
    });
    return Object.keys(QA_LINE_TYPES)
      .filter((type) => found.has(type))
      .map((type) => ({ type, color: QA_LINE_TYPES[type].color, label: QA_LINE_TYPES[type].label }));
  }

  function updateQaImageLegend(){
    const legend = document.getElementById('qaImageLegend');
    if (!legend) return;
    const supported = !isQaLiveMapMode(qaActiveImageView) && qaImageGeometryVisible;
    const items = supported ? getQaLegendItems() : [];
    const show = qaImageShowLegend && supported && items.length > 0;
    legend.classList.toggle('hidden', !show);
    if (!show) {
      legend.innerHTML = '';
      return;
    }
    legend.innerHTML = `
      <div class="qa-image-legend-title">Line Types</div>
      <div class="qa-image-legend-list">
        ${items.map((item) => `
          <div class="qa-image-legend-item">
            <span class="qa-image-legend-swatch" style="background:${item.color};"></span>
            <span class="qa-image-legend-label">${item.label}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function getQaImageGeometry(){
    const meta = getQaImageBundleMeta();
    const pdfState = getQaPdfState();
    const raw = (meta.geometry && Array.isArray(meta.geometry.points)) ? meta.geometry : ((pdfState && pdfState.geometry && Array.isArray(pdfState.geometry.points)) ? pdfState.geometry : null);
    if (!raw) return null;
    return normalizeQaGeometry(raw);
  }

  function normalizeQaGeometry(raw){
    const rawPoints = Array.isArray(raw.points) ? raw.points : [];
    const points = rawPoints.map((point, idx) => ({
      idx,
      x: Number(point && point.x),
      y: Number(point && point.y),
      z: Number(point && point.z),
      layer: Number(point && point.layer) || 1
    })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    const pointIndexByKey = new Map();
    points.forEach((point, idx) => {
      pointIndexByKey.set(qaPointKey(point.x, point.y, point.layer), idx);
    });
    const connections = [];
    (Array.isArray(raw.connections) ? raw.connections : []).forEach((connection) => {
      let startIdx = Number.isInteger(connection && connection.startIdx) ? connection.startIdx : -1;
      let endIdx = Number.isInteger(connection && connection.endIdx) ? connection.endIdx : -1;
      if (!(startIdx >= 0) && connection && connection.start) {
        startIdx = pointIndexByKey.get(qaPointKey(connection.start.x, connection.start.y, connection.start.layer || 1));
      }
      if (!(endIdx >= 0) && connection && connection.end) {
        endIdx = pointIndexByKey.get(qaPointKey(connection.end.x, connection.end.y, connection.end.layer || 1));
      }
      if (!(startIdx >= 0) || !(endIdx >= 0) || startIdx === endIdx) return;
      connections.push({
        startIdx,
        endIdx,
        type: String(connection && connection.type || '').trim().toLowerCase()
      });
    });
    const mapStoredFace = (face) => {
      if (!face || !Array.isArray(face.pointIndices)) return null;
      const facePoints = face.pointIndices.map((idx) => points[idx]).filter(Boolean);
      if (facePoints.length < 3) return null;
      return {
        layer: Number(face.layer) || Number(facePoints[0].layer) || 1,
        points: facePoints
      };
    };
    const resolvedFaces = Array.isArray(raw.resolvedFaces) ? raw.resolvedFaces.map(mapStoredFace).filter(Boolean) : [];
    const manualFaces = Array.isArray(raw.manualFaces) ? raw.manualFaces.map(mapStoredFace).filter(Boolean) : [];
    return { points, connections, resolvedFaces, manualFaces };
  }

  function qaPointKey(x, y, layer){
    return `${Math.round(Number(x) * 10)}|${Math.round(Number(y) * 10)}|${Number(layer) || 1}`;
  }

  function qaEdgeKey(a, b){
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  function qaPolygonArea(points){
    let area = 0;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      area += (Number(a.x) * Number(b.y)) - (Number(b.x) * Number(a.y));
    }
    return area / 2;
  }

  function normalizeQaCycle(cycle){
    let bestIndex = 0;
    for (let i = 1; i < cycle.length; i += 1) {
      if (cycle[i] < cycle[bestIndex]) bestIndex = i;
    }
    return cycle.slice(bestIndex).concat(cycle.slice(0, bestIndex));
  }

  function qaCycleSignature(cycle){
    const a = normalizeQaCycle(cycle.slice()).join('-');
    const b = normalizeQaCycle(cycle.slice().reverse()).join('-');
    return a < b ? a : b;
  }

  function isQaChordlessCycle(cycle, edgeSet){
    const n = cycle.length;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const adjacent = (j === i + 1) || (i === 0 && j === n - 1);
        if (adjacent) continue;
        if (edgeSet.has(qaEdgeKey(cycle[i], cycle[j]))) return false;
      }
    }
    return true;
  }

  function collectQaGeometryFaces(geometry){
    if (!geometry) return [];
    if (Array.isArray(geometry.resolvedFaces) && geometry.resolvedFaces.length) return geometry.resolvedFaces;
    if (Array.isArray(geometry.manualFaces) && geometry.manualFaces.length) return geometry.manualFaces;
    return [];
  }

  function qaMetersPerPx(){
    const meta = getQaImageBundleMeta();
    const width = Number(meta.imageWidth || qaImageViewport.baseWidth || 0);
    const radius = Number((qaImageBundle && qaImageBundle.manifest && qaImageBundle.manifest.radius_meters) || (meta.layer_config && meta.layer_config.__radius && meta.layer_config.__radius.scale) || 20);
    if (!(width > 0) || !(radius > 0)) return 0;
    return (radius * 2) / width;
  }

  function getQaMeasurementText(start, end){
    const metersPerPx = qaMetersPerPx();
    const dx = Number(end.x) - Number(start.x);
    const dy = Number(end.y) - Number(start.y);
    const dist2dMeters = Math.hypot(dx, dy) * metersPerPx;
    if (Number.isFinite(start.z) && Number.isFinite(end.z)) {
      const dz = Number(start.z) - Number(end.z);
      return `${(Math.sqrt(dist2dMeters * dist2dMeters + dz * dz) * 3.28084).toFixed(1)}'`;
    }
    return `${(dist2dMeters * 3.28084).toFixed(1)}'`;
  }

  function getQaImageTransformState(){
    const viewport = document.getElementById('qaImageViewport');
    if (!viewport || !(qaImageViewport.baseWidth > 0) || !(qaImageViewport.baseHeight > 0)) return null;
    const stageW = Math.max(1, viewport.clientWidth || 1);
    const stageH = Math.max(1, viewport.clientHeight || 1);
    const fitScale = Math.min(stageW / qaImageViewport.baseWidth, stageH / qaImageViewport.baseHeight);
    const zoom = Math.max(0.25, Number(qaImageViewport.zoom) || 1);
    const scale = fitScale * zoom;
    const offsetX = ((stageW - (qaImageViewport.baseWidth * scale)) / 2) + qaImageViewport.panX;
    const offsetY = ((stageH - (qaImageViewport.baseHeight * scale)) / 2) + qaImageViewport.panY;
    return { stageW, stageH, scale, offsetX, offsetY };
  }

  function qaImageToViewportPoint(x, y, transform){
    const tx = Number(x);
    const ty = Number(y);
    if (!Number.isFinite(tx) || !Number.isFinite(ty) || !transform) return null;
    return {
      x: transform.offsetX + (tx * transform.scale),
      y: transform.offsetY + (ty * transform.scale)
    };
  }

  function getQaMeasurementLabelMetrics(text){
    const canvas = getQaMeasurementLabelMetrics.canvas || (getQaMeasurementLabelMetrics.canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    if (!ctx) return { width: 30, height: 18 };
    ctx.font = '700 15px Arial';
    const textWidth = Math.ceil(ctx.measureText(String(text || '')).width);
    return {
      width: Math.max(30, textWidth + 10),
      height: 18
    };
  }

  function getQaLineColor(connection, layer){
    if (qaImageShowTypeColors && connection && connection.type && QA_LINE_TYPES[connection.type]) return QA_LINE_TYPES[connection.type].color;
    const style = QA_LAYER_STYLES[layer] || QA_LAYER_STYLES[1];
    return style.line;
  }

  async function loadQaTiffCanvas(url){
    if (!window.GeoTIFF || typeof window.GeoTIFF.fromArrayBuffer !== 'function') {
      throw new Error('GeoTIFF decoder is unavailable.');
    }
    const response = await fetch(resolveFirstMeasureAssetUrl(url), { cache: 'no-store' });
    if (!response.ok) throw new Error(`TIFF failed to load (${response.status}).`);
    const buffer = await response.arrayBuffer();
    const tiff = await window.GeoTIFF.fromArrayBuffer(buffer);
    const image = await tiff.getImage();
    const width = Math.max(1, Number(image.getWidth()) || 1);
    const height = Math.max(1, Number(image.getHeight()) || 1);
    const rasters = await image.readRasters();
    const count = width * height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas rendering is unavailable.');
    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;
    const r = rasters && rasters[0] ? rasters[0] : null;
    const g = rasters && rasters[1] ? rasters[1] : r;
    const b = rasters && rasters[2] ? rasters[2] : r;
    const a = rasters && rasters[3] ? rasters[3] : null;
    for (let i = 0; i < count; i += 1) {
      const offset = i * 4;
      data[offset] = clampQaByte(r ? r[i] : 0);
      data[offset + 1] = clampQaByte(g ? g[i] : data[offset]);
      data[offset + 2] = clampQaByte(b ? b[i] : data[offset]);
      data[offset + 3] = a ? clampQaByte(a[i]) : 255;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  function loadQaStageImage(url){
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image failed to load.'));
      img.src = resolveFirstMeasureAssetUrl(url);
    });
  }

  async function loadQaStageSource(url, viewId){
    const raw = String(url || '').trim().toLowerCase();
    if (viewId === 'solar' || raw.endsWith('.tif') || raw.endsWith('.tiff')) {
      return await loadQaTiffCanvas(url);
    }
    return await loadQaStageImage(url);
  }

  function updateQaImageGeometryUi(){
    const geoBtn = document.getElementById('qaImageGeoBtn');
    const faceBtn = document.getElementById('qaImageFacesBtn');
    const typesBtn = document.getElementById('qaImageTypesBtn');
    const measuresBtn = document.getElementById('qaImageMeasuresBtn');
    if (!geoBtn) return;
    const supported = !isQaLiveMapMode(qaActiveImageView);
    geoBtn.disabled = !supported;
    geoBtn.classList.toggle('active', !!(supported && qaImageGeometryVisible));
    geoBtn.title = supported
      ? 'Toggle geometry overlay on saved imagery views'
      : 'Geometry overlay is available on Solar, Google, Bing, and Apple views';
    if (faceBtn) {
      faceBtn.disabled = !supported;
      faceBtn.classList.toggle('active', !!(supported && qaImageShowFaces));
    }
    if (typesBtn) {
      typesBtn.disabled = !supported;
      typesBtn.classList.toggle('active', !!(supported && qaImageShowTypeColors));
    }
    if (measuresBtn) {
      measuresBtn.disabled = !supported;
      measuresBtn.classList.toggle('active', !!(supported && qaImageShowMeasurements));
    }
    updateQaImageLegend();
  }

  function renderQaGeometryOverlay(viewId, width, height){
    const overlay = document.getElementById('qaImageOverlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    const transform = getQaImageTransformState();
    const stageW = Math.max(1, transform ? transform.stageW : 1);
    const stageH = Math.max(1, transform ? transform.stageH : 1);
    overlay.setAttribute('viewBox', `0 0 ${stageW} ${stageH}`);
    overlay.setAttribute('width', String(stageW));
    overlay.setAttribute('height', String(stageH));
    const shouldShow = qaImageGeometryVisible && viewId !== 'quad';
    overlay.style.display = shouldShow ? 'block' : 'none';
    if (!shouldShow || !transform) return;
    const geometry = getQaImageGeometry();
    if (!geometry || !Array.isArray(geometry.points) || !geometry.points.length) return;
    const svgNs = 'http://www.w3.org/2000/svg';
    const points = geometry.points;
    const connections = Array.isArray(geometry.connections) ? geometry.connections : [];
    const faces = collectQaGeometryFaces(geometry);

    if (qaImageShowFaces) {
      faces.forEach((face) => {
        if (!face || !Array.isArray(face.points) || face.points.length < 3) return;
        const style = QA_LAYER_STYLES[Number(face.layer) || 1] || QA_LAYER_STYLES[1];
        const path = document.createElementNS(svgNs, 'path');
        const first = qaImageToViewportPoint(face.points[0].x, face.points[0].y, transform);
        if (!first) return;
        let d = `M ${first.x} ${first.y}`;
        for (let i = 1; i < face.points.length; i += 1) {
          const next = qaImageToViewportPoint(face.points[i].x, face.points[i].y, transform);
          if (!next) continue;
          d += ` L ${next.x} ${next.y}`;
        }
        d += ' Z';
        path.setAttribute('d', d);
        path.setAttribute('fill', style.fill);
        path.setAttribute('stroke', style.line);
        path.setAttribute('stroke-width', '1.4');
        path.setAttribute('vector-effect', 'non-scaling-stroke');
        overlay.appendChild(path);
      });
    }

    connections.forEach((conn) => {
      let start = null;
      let end = null;
      if (Number.isInteger(conn && conn.startIdx) && points[conn.startIdx]) start = points[conn.startIdx];
      if (Number.isInteger(conn && conn.endIdx) && points[conn.endIdx]) end = points[conn.endIdx];
      if (!start || !end) return;
      if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return;
      const startPt = qaImageToViewportPoint(start.x, start.y, transform);
      const endPt = qaImageToViewportPoint(end.x, end.y, transform);
      if (!startPt || !endPt) return;
      const line = document.createElementNS(svgNs, 'line');
      line.setAttribute('class', 'qa-geo-line');
      line.setAttribute('x1', String(startPt.x));
      line.setAttribute('y1', String(startPt.y));
      line.setAttribute('x2', String(endPt.x));
      line.setAttribute('y2', String(endPt.y));
      line.style.stroke = getQaLineColor(conn, start.layer || end.layer || 1);
      overlay.appendChild(line);
      if (qaImageShowMeasurements) {
        const text = getQaMeasurementText(start, end);
        const midX = (startPt.x + endPt.x) / 2;
        const midY = (startPt.y + endPt.y) / 2;
        const group = document.createElementNS(svgNs, 'g');
        const rect = document.createElementNS(svgNs, 'rect');
        const textEl = document.createElementNS(svgNs, 'text');
        const metrics = getQaMeasurementLabelMetrics(text);
        const widthPx = metrics.width;
        const heightPx = metrics.height;
        rect.setAttribute('x', String(midX - widthPx / 2));
        rect.setAttribute('y', String(midY - (heightPx / 2)));
        rect.setAttribute('width', String(widthPx));
        rect.setAttribute('height', String(heightPx));
        rect.setAttribute('rx', '3');
        rect.setAttribute('fill', 'rgba(255,255,255,0.58)');
        textEl.setAttribute('x', String(midX));
        textEl.setAttribute('y', String(midY + 0.1));
        textEl.setAttribute('text-anchor', 'middle');
        textEl.setAttribute('dominant-baseline', 'middle');
        textEl.setAttribute('fill', '#111');
        textEl.setAttribute('font-size', '15');
        textEl.setAttribute('font-family', 'Arial, sans-serif');
        textEl.setAttribute('font-weight', '700');
        textEl.textContent = text;
        group.appendChild(rect);
        group.appendChild(textEl);
        overlay.appendChild(group);
      }
    });

    points.forEach((pt) => {
      if (![pt.x, pt.y].every(Number.isFinite)) return;
      const screenPt = qaImageToViewportPoint(pt.x, pt.y, transform);
      if (!screenPt) return;
      const circle = document.createElementNS(svgNs, 'circle');
      circle.setAttribute('class', 'qa-geo-point');
      circle.setAttribute('cx', String(screenPt.x));
      circle.setAttribute('cy', String(screenPt.y));
      circle.setAttribute('r', '5.4');
      const style = QA_LAYER_STYLES[Number(pt.layer) || 1] || QA_LAYER_STYLES[1];
      circle.style.fill = style.dot;
      overlay.appendChild(circle);
    });
    updateQaImageLegend();
  }

  function getQaImageFitScale(){
    const viewport = document.getElementById('qaImageViewport');
    if (!viewport || !(qaImageViewport.baseWidth > 0) || !(qaImageViewport.baseHeight > 0)) return 1;
    const stageW = Math.max(1, viewport.clientWidth || 1);
    const stageH = Math.max(1, viewport.clientHeight || 1);
    return Math.min(stageW / qaImageViewport.baseWidth, stageH / qaImageViewport.baseHeight);
  }

  function clampQaImagePan(){
    const viewport = document.getElementById('qaImageViewport');
    if (!viewport || !(qaImageViewport.baseWidth > 0) || !(qaImageViewport.baseHeight > 0)) return;
    const stageW = Math.max(1, viewport.clientWidth || 1);
    const stageH = Math.max(1, viewport.clientHeight || 1);
    const fitScale = getQaImageFitScale();
    const scale = fitScale * Math.max(0.25, qaImageViewport.zoom || 1);
    const renderedW = qaImageViewport.baseWidth * scale;
    const renderedH = qaImageViewport.baseHeight * scale;
    const slackX = Math.max(0, (renderedW - stageW) / 2);
    const slackY = Math.max(0, (renderedH - stageH) / 2);
    qaImageViewport.panX = clamp(qaImageViewport.panX, -(slackX + 120), slackX + 120);
    qaImageViewport.panY = clamp(qaImageViewport.panY, -(slackY + 120), slackY + 120);
  }

  function applyQaImageViewportTransform(){
    const { viewport, content, hud } = getQaImageViewportRefs();
    if (!viewport || !content || !(qaImageViewport.baseWidth > 0) || !(qaImageViewport.baseHeight > 0)) {
      if (hud) hud.style.display = 'none';
      return;
    }
    clampQaImagePan();
    const stageW = Math.max(1, viewport.clientWidth || 1);
    const stageH = Math.max(1, viewport.clientHeight || 1);
    const fitScale = getQaImageFitScale();
    const zoom = Math.max(0.25, Number(qaImageViewport.zoom) || 1);
    const scale = fitScale * zoom;
    const offsetX = ((stageW - (qaImageViewport.baseWidth * scale)) / 2) + qaImageViewport.panX;
    const offsetY = ((stageH - (qaImageViewport.baseHeight * scale)) / 2) + qaImageViewport.panY;
    content.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    renderQaGeometryOverlay(qaActiveImageView, qaImageViewport.baseWidth || 1, qaImageViewport.baseHeight || 1);
    if (hud) {
      hud.textContent = `${Math.round(zoom * 100)}%`;
      hud.style.display = 'block';
    }
    updateQaImageLegend();
  }

  function updateQaMeasurementLabelScale(contentScale){
    return;
  }

  function resetQaImageViewport(){
    qaImageViewport.zoom = 1;
    qaImageViewport.panX = 0;
    qaImageViewport.panY = 0;
    applyQaImageViewportTransform();
  }

  async function renderQaImageView(assetUrl, viewId){
    const refs = getQaImageViewportRefs();
    const safeView = String(viewId || qaActiveImageView || 'quad');
    const token = ++qaImageLoadToken;
    updateQaImageTabs();
    updateQaImageGeometryUi();

    if (!assetUrl) {
      if (refs.content) refs.content.style.display = 'none';
      if (refs.empty) {
        refs.empty.textContent = `No saved ${getQaImageLabel(safeView).toLowerCase()} image is available for this project yet.`;
        refs.empty.classList.add('show');
      }
      if (refs.hud) refs.hud.style.display = 'none';
      return;
    }

    if (refs.empty) {
      refs.empty.textContent = `Loading saved ${getQaImageLabel(safeView).toLowerCase()} image...`;
      refs.empty.classList.add('show');
    }
    if (refs.content) refs.content.style.display = 'none';

    try {
      const img = await loadQaStageSource(assetUrl, safeView);
      if (token !== qaImageLoadToken) return;
      const dims = getQaImageBaseDims(safeView, img);
      qaImageViewport.baseWidth = Math.max(1, dims.width);
      qaImageViewport.baseHeight = Math.max(1, dims.height);

      if (refs.canvas) {
        refs.canvas.width = qaImageViewport.baseWidth;
        refs.canvas.height = qaImageViewport.baseHeight;
        const ctx = refs.canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, qaImageViewport.baseWidth, qaImageViewport.baseHeight);
          if (safeView === 'quad') {
            ctx.drawImage(img, 0, 0, qaImageViewport.baseWidth, qaImageViewport.baseHeight);
          } else {
            drawQaScaledImage(ctx, img, qaImageViewport.baseWidth, qaImageViewport.baseHeight, getQaLayerConfig(safeView));
          }
        }
      }

      if (refs.content) {
        refs.content.style.width = `${qaImageViewport.baseWidth}px`;
        refs.content.style.height = `${qaImageViewport.baseHeight}px`;
        refs.content.style.display = 'block';
      }

      renderQaGeometryOverlay(safeView, qaImageViewport.baseWidth, qaImageViewport.baseHeight);
      if (refs.empty) refs.empty.classList.remove('show');
      resetQaImageViewport();
    } catch (error) {
      if (token !== qaImageLoadToken) return;
      if (refs.content) refs.content.style.display = 'none';
      if (refs.empty) {
        refs.empty.textContent = `Saved ${getQaImageLabel(safeView).toLowerCase()} image could not be loaded for this project.`;
        refs.empty.classList.add('show');
      }
      if (refs.hud) refs.hud.style.display = 'none';
    }
  }

  function setQaImageAssets(assets, bundle){
    qaImageBundle = bundle || {};
    qaImageAssets = getQaSavedImageSources(assets);
    const preferredOrder = ['quad', 'solar', 'google', 'azure', 'apple'];
    const preferred = preferredOrder.find((key) => !!qaImageAssets[key]) || 'quad';
    if (!isQaLiveMapMode(qaActiveImageView)) {
      qaActiveImageView = qaImageAssets[qaActiveImageView] ? qaActiveImageView : preferred;
      renderQaImageView(qaImageAssets[qaActiveImageView], qaActiveImageView);
    } else {
      updateQaImageTabs();
      updateQaImageGeometryUi();
      applyQaTopViewMode();
    }
  }

  function selectQaImageView(viewId){
    const nextView = String(viewId || '').trim();
    if (!nextView) return;
    if (isQaLiveMapMode(nextView)) {
      qaActiveImageView = nextView;
      updateQaImageTabs();
      updateQaImageGeometryUi();
      applyQaTopViewMode();
      return;
    }
    if (!qaImageAssets[nextView]) return;
    qaActiveImageView = nextView;
    applyQaTopViewMode();
    renderQaImageView(qaImageAssets[nextView], nextView);
  }

  // ----------------- PDF -----------------
  function clearPdf(){
    qaPdfRenderSeq++;
    qaPdfDoc = null;
    qaPdfCurrentPage = 1;
    qaPdfBaseSnapshot = null;
    qaPdfPreviewSnapshot = null;
    qaPdfTopViewSettings = null;
    qaPdfPageConfig = {};
    qaPdfVentEditMode = false;
    qaPdfLastSyncJobId = '';
    qaPdfLastSyncRevision = '';
    qaPdfLastSourceUrl = '';
    qaPdfSyncSeq++;
    qaPdfPersistPending = false;
    if (qaPdfPreviewTimer) {
      clearTimeout(qaPdfPreviewTimer);
      qaPdfPreviewTimer = null;
    }
    if (qaPdfObjectUrl) {
      try { URL.revokeObjectURL(qaPdfObjectUrl); } catch(e) {}
      qaPdfObjectUrl = null;
    }
    const main = document.getElementById('qaPdfMain');
    const thumbs = document.getElementById('qaPdfThumbs');
    const panel = document.getElementById('qaPdfConfigPanel');
    const refs = [document.getElementById('qaSubmissionRefs'), document.getElementById('qaSubmissionRefsEmbedded')].filter(Boolean);
    if (main) main.innerHTML = '<div class="qa-pdf-empty">Select a job to load the PDF.</div>';
    if (thumbs) thumbs.innerHTML = '';
    refs.forEach((ref) => { ref.classList.remove('show'); ref.innerHTML = ''; });
    if (panel) panel.classList.remove('show');
    updateQaPdfNav();
  }

  function setPdfHint(text){
    const el = document.getElementById('qaPdfHint');
    if (el) el.textContent = text || 'Fit';
  }

  function setQaSubmitBlocking(on, text){
    qaSubmitting = !!on;
    const overlay = document.getElementById('qaSubmitOverlay');
    const label = document.getElementById('qaSubmitOverlayText');
    if (label && text) label.textContent = text;
    if (overlay) overlay.classList.toggle('show', !!on);
  }

  function areQaQuadViewsDisabled(){
    const globalSettings = (window.PORTAL_CFG && window.PORTAL_CFG.report_settings && typeof window.PORTAL_CFG.report_settings === 'object')
      ? window.PORTAL_CFG.report_settings
      : {};
    if (
      globalSettings.disable_quad_views ||
      globalSettings.disableQuadViews ||
      globalSettings.no_quad_views ||
      globalSettings.noQuadViews
    ) {
      return true;
    }
    const org = (qaImageBundle && qaImageBundle.organization && typeof qaImageBundle.organization === 'object')
      ? qaImageBundle.organization
      : (window.projectOrganization || {});
    const general = org && org.report_settings && org.report_settings.general
      ? org.report_settings.general
      : {};
    return !!(
      general.disable_quad_views ||
      general.disableQuadViews ||
      general.no_quad_views ||
      general.noQuadViews
    );
  }

  async function ensureQaPdfJs(){
    if (window.pdfjsLib || window['pdfjs-dist/build/pdf']) return window.pdfjsLib || window['pdfjs-dist/build/pdf'];
    if (!qaPdfJsLoading) {
      qaPdfJsLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        script.onload = () => {
          const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
          if (!lib) {
            reject(new Error('PDF.js loaded but did not expose a runtime.'));
            return;
          }
          lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
          resolve(lib);
        };
        script.onerror = () => reject(new Error('Unable to load PDF.js.'));
        document.head.appendChild(script);
      }).catch((err) => {
        qaPdfJsLoading = null;
        throw err;
      });
    }
    return qaPdfJsLoading;
  }

  function updateQaPdfNav(){
    const prev = document.getElementById('qaPdfPrevPageBtn');
    const next = document.getElementById('qaPdfNextPageBtn');
    if (prev) prev.disabled = !qaPdfDoc || qaPdfCurrentPage <= 1;
    if (next) next.disabled = !qaPdfDoc || qaPdfCurrentPage >= qaPdfDoc.numPages;
    if (qaPdfDoc) setPdfHint(`Page ${qaPdfCurrentPage}/${qaPdfDoc.numPages}`);
    document.querySelectorAll('.qa-pdf-thumb').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.page || 0) === qaPdfCurrentPage);
    });
  }

  function updateQaDisabledPageVisual(){
    const kind = getQaPdfPageKind();
    const disabled = (kind === 'elevations' && qaPdfPageConfig.page_elevations === false)
      || (kind === 'ventilation' && qaPdfPageConfig.page_ventilation === false)
      || (kind === 'structures' && shouldRenderQaPdfDisabledStructuresPage());
    const wrap = document.querySelector('#qaPdfMain .qa-pdf-page-wrap');
    if (wrap) wrap.classList.toggle('disabled', !!disabled);
  }

  async function renderQaPdfPage(pageNum){
    if (!qaPdfDoc) return;
    const myRenderSeq = ++qaPdfRenderSeq;
    const nextPage = Math.max(1, Math.min(qaPdfDoc.numPages, Number(pageNum) || 1));
    if (nextPage !== qaPdfCurrentPage) qaPdfForcedPageKind = '';
    qaPdfCurrentPage = nextPage;
    updateQaPdfNav();
    const main = document.getElementById('qaPdfMain');
    if (!main) return;
    main.innerHTML = '<div class="qa-pdf-empty">Rendering...</div>';
    const page = await qaPdfDoc.getPage(qaPdfCurrentPage);
    if (myRenderSeq !== qaPdfRenderSeq) return;
    qaPdfCurrentPageKind = qaPdfForcedPageKind || await detectQaPdfPageKind(page);
    const unscaled = page.getViewport({ scale: 1 });
    const maxW = Math.max(220, main.clientWidth - 36);
    const maxH = Math.max(260, main.clientHeight - 36);
    const scale = Math.min(maxW / unscaled.width, maxH / unscaled.height, 2.25);
    const viewport = page.getViewport({ scale: Math.max(0.2, scale) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${Math.ceil(viewport.width)}px`;
    canvas.style.height = `${Math.ceil(viewport.height)}px`;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    if (myRenderSeq !== qaPdfRenderSeq) return;
    main.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'qa-pdf-page-wrap';
    wrap.dataset.pageKind = qaPdfCurrentPageKind;
    wrap.appendChild(canvas);
    const wash = document.createElement('div');
    wash.className = 'qa-pdf-disabled-wash';
    wash.textContent = qaPdfCurrentPageKind === 'elevations'
      ? 'Quad View Disabled'
      : (qaPdfCurrentPageKind === 'structures' ? 'Structure Page Disabled' : 'Page Disabled');
    wrap.appendChild(wash);
    main.appendChild(wrap);
    updateQaDisabledPageVisual();
    updateQaPdfNav();
    renderQaPdfConfigContent();
    renderQaTopViewLivePreview();
    renderQaVentOverlay();
  }

  async function detectQaPdfPageKind(page){
    try {
      const text = await page.getTextContent();
      const joined = (text.items || []).map((item) => String(item.str || '')).join(' ');
      if (joined.includes('Top View')) return 'top_view';
      if (joined.includes('3D Elevations')) return 'elevations';
      if (joined.includes('Pitch Diagram')) return 'pitch';
      if (joined.includes('Area Diagram')) return 'area';
      if (/Layer\s+\d+\s+Measurements/i.test(joined)) return 'layer';
      if (joined.includes('Ventilation')) return 'ventilation';
      if (joined.includes('Structure Breakdown')) return 'structures';
      if (joined.includes('Project Summary')) return 'summary';
      if (joined.includes('3D Facets')) return 'facets_3d';
      if (joined.includes('Gutters')) return 'gutters';
      if (joined.includes('Notes')) return 'notes';
      if (joined.includes('Materials')) return 'materials';
    } catch(e) {}
    return 'general';
  }

  async function renderQaPdfThumbs(){
    const thumbs = document.getElementById('qaPdfThumbs');
    if (!thumbs || !qaPdfDoc) return;
    const myRenderSeq = qaPdfRenderSeq;
    thumbs.innerHTML = '';
    for (let pageNum = 1; pageNum <= qaPdfDoc.numPages; pageNum++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qa-pdf-thumb';
      btn.dataset.page = String(pageNum);
      btn.title = `Page ${pageNum}`;
      btn.innerHTML = `<span>${pageNum}</span>`;
      btn.onclick = () => renderQaPdfPage(pageNum);
      thumbs.appendChild(btn);
    }
    updateQaPdfNav();
    const pages = Array.from(thumbs.querySelectorAll('.qa-pdf-thumb'));
    for (let i = 0; i < pages.length; i += 1) {
      const btn = pages[i];
      const pageNum = Number(btn.dataset.page || 0);
      const page = await qaPdfDoc.getPage(pageNum);
      if (myRenderSeq !== qaPdfRenderSeq) return;
      const unscaled = page.getViewport({ scale: 1 });
      const scale = Math.min(52 / unscaled.width, 74 / unscaled.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      if (myRenderSeq !== qaPdfRenderSeq) return;
      btn.prepend(canvas);
      if (i % 2 === 1) await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    updateQaPdfNav();
  }

  async function loadQaPdfDocument(url, startPage){
    const lib = await ensureQaPdfJs();
    const loadSeq = ++qaPdfRenderSeq;
    const main = document.getElementById('qaPdfMain');
    const thumbs = document.getElementById('qaPdfThumbs');
    if (main) main.innerHTML = '<div class="qa-pdf-empty">Loading PDF...</div>';
    if (thumbs) thumbs.innerHTML = '';
    const doc = await lib.getDocument(url).promise;
    if (loadSeq !== qaPdfRenderSeq) return;
    qaPdfDoc = doc;
    qaPdfForcedPageKind = '';
    qaPdfCurrentPage = Math.max(1, Math.min(doc.numPages, Number(startPage) || 1));
    await renderQaPdfPage(qaPdfCurrentPage);
    renderQaPdfThumbs().catch((error) => {
      console.warn('[QA PDF] Failed to render thumbnails:', error);
    });
  }

  function wireQaPdfControls(){
    const prev = document.getElementById('qaPdfPrevPageBtn');
    const next = document.getElementById('qaPdfNextPageBtn');
    const configBtn = document.getElementById('qaPdfConfigBtn');
    if (prev && !prev.__qaWired) {
      prev.__qaWired = true;
      prev.onclick = () => renderQaPdfPage(qaPdfCurrentPage - 1);
    }
    if (next && !next.__qaWired) {
      next.__qaWired = true;
      next.onclick = () => renderQaPdfPage(qaPdfCurrentPage + 1);
    }
    if (configBtn && !configBtn.__qaWired) {
      configBtn.__qaWired = true;
      configBtn.onclick = () => {
        const panel = document.getElementById('qaPdfConfigPanel');
        if (panel) panel.classList.toggle('show');
      };
    }
    updateQaPdfNav();
  }

  function initializeQaPdfConfigurator(snapshot, options){
    options = options && typeof options === 'object' ? options : {};
    qaPdfBaseSnapshot = snapshot && typeof snapshot === 'object' ? cloneJson(snapshot, null) : null;
    qaPdfPreviewSnapshot = null;
    const settings = (qaPdfBaseSnapshot && qaPdfBaseSnapshot.imageSettings && typeof qaPdfBaseSnapshot.imageSettings === 'object')
      ? cloneJson(qaPdfBaseSnapshot.imageSettings, {})
      : {};
    qaPdfTopViewSettings = {
      mainViewId: settings.mainViewId || 'solar',
      ventViewId: settings.ventViewId || 'solar',
      cropPadding: Number.isFinite(Number(settings.cropPadding)) ? Number(settings.cropPadding) : 50
    };
    qaPdfPageConfig = {
      page_elevations: !areQaQuadViewsDisabled() && !(qaPdfBaseSnapshot?.elevationSettings && qaPdfBaseSnapshot.elevationSettings.include === false),
      page_ventilation: !(qaPdfBaseSnapshot?.ventSettings && qaPdfBaseSnapshot.ventSettings.include === false),
      ...((qaPdfBaseSnapshot && qaPdfBaseSnapshot.pdfConfig && typeof qaPdfBaseSnapshot.pdfConfig === 'object') ? cloneJson(qaPdfBaseSnapshot.pdfConfig, {}) : {})
    };
    if (areQaQuadViewsDisabled()) {
      qaPdfPageConfig.page_elevations = false;
      qaPdfBaseSnapshot.quadImage = null;
      qaPdfBaseSnapshot.elevationSettings = {
        ...((qaPdfBaseSnapshot.elevationSettings && typeof qaPdfBaseSnapshot.elevationSettings === 'object') ? qaPdfBaseSnapshot.elevationSettings : {}),
        include: false
      };
    }
    if (typeof qaPdfBaseSnapshot.diagramFontScale !== 'number') qaPdfBaseSnapshot.diagramFontScale = 1;
    if (typeof qaPdfBaseSnapshot.measurementFontScale !== 'number') qaPdfBaseSnapshot.measurementFontScale = 1;
    if (!qaPdfBaseSnapshot.ventSettings || typeof qaPdfBaseSnapshot.ventSettings !== 'object') {
      qaPdfBaseSnapshot.ventSettings = { include: true, excludedRidges: [], mode: 'ridge', boxVents: [] };
    }
    qaPdfBaseSnapshot.ventSettings.mode = qaPdfBaseSnapshot.ventSettings.mode || 'ridge';
    qaPdfBaseSnapshot.ventSettings.boxVents = Array.isArray(qaPdfBaseSnapshot.ventSettings.boxVents) ? qaPdfBaseSnapshot.ventSettings.boxVents : [];
    qaPdfAvailableSources = {};
    qaPdfSourceThumbs = {};
    qaPdfSourceCanvasCache = new Map();
    qaPdfSourcesChecked = false;
    updateQaTopViewSourceOptions();
    renderQaPdfConfigContent();
    refreshQaAvailablePdfSources().then(() => {
      renderQaPdfConfigContent();
      renderQaTopViewLivePreview();
    }).catch(() => {});
    if (options.renderDisabledPreview !== false && shouldRenderQaPdfDisabledPagePreviewOnLoad()) {
      scheduleQaPdfPreviewRender(0, { persist: false });
    }
  }

  function shouldRenderQaPdfDisabledPagePreviewOnLoad(){
    if (!qaPdfBaseSnapshot) return false;
    const hasDisabledQuad = !areQaQuadViewsDisabled() && qaPdfPageConfig.page_elevations === false && !!qaPdfBaseSnapshot.quadImage;
    const hasDisabledVent = qaPdfPageConfig.page_ventilation === false;
    return hasDisabledQuad || hasDisabledVent || shouldRenderQaPdfDisabledStructuresPage();
  }

  function getQaPdfRawStructures(){
    return Array.isArray(qaPdfBaseSnapshot?.structures) ? qaPdfBaseSnapshot.structures : [];
  }

  function getQaPdfStructureSettings(){
    if (!qaPdfBaseSnapshot) return {};
    if (!qaPdfBaseSnapshot.structureSettings || typeof qaPdfBaseSnapshot.structureSettings !== 'object') {
      qaPdfBaseSnapshot.structureSettings = {};
    }
    return qaPdfBaseSnapshot.structureSettings;
  }

  function getQaPdfEffectiveStructures(rawStructs, settings){
    rawStructs = Array.isArray(rawStructs) ? rawStructs : [];
    settings = settings && typeof settings === 'object' ? settings : {};
    if (!rawStructs.length) return [];
    const hiddenIds = new Set();
    const mergeMap = new Map();
    const byId = new Map();
    rawStructs.forEach((s) => {
      const id = Number(s && s.id);
      if (!Number.isFinite(id)) return;
      byId.set(id, s);
      const cfg = settings[id] || settings[String(id)] || {};
      if (cfg.hidden) hiddenIds.add(id);
      const targetId = Number(cfg.mergeTarget);
      if (Number.isFinite(targetId) && targetId !== id) mergeMap.set(id, targetId);
    });
    const effective = new Map();
    rawStructs.forEach((s) => {
      const id = Number(s && s.id);
      if (!Number.isFinite(id) || hiddenIds.has(id) || mergeMap.has(id)) return;
      effective.set(id, {
        ...s,
        id,
        faces: Array.isArray(s.faces) ? [...s.faces] : [],
        lines: Array.isArray(s.lines) ? [...s.lines] : [],
        originalIds: [id]
      });
    });
    mergeMap.forEach((targetId, sourceId) => {
      if (hiddenIds.has(sourceId)) return;
      const target = effective.get(targetId);
      const source = byId.get(sourceId);
      if (!target || !source) return;
      target.originalIds.push(sourceId);
      if (Array.isArray(source.faces)) target.faces.push(...source.faces);
      if (Array.isArray(source.lines)) target.lines.push(...source.lines);
    });
    return Array.from(effective.values());
  }

  function getQaPdfStructureCounts(){
    const raw = getQaPdfRawStructures();
    const effective = getQaPdfEffectiveStructures(raw, getQaPdfStructureSettings());
    return { raw: raw.length, effective: effective.length };
  }

  function shouldRenderQaPdfDisabledStructuresPage(){
    const counts = getQaPdfStructureCounts();
    return counts.raw > 1 && counts.effective <= 1;
  }

  function updateQaTopViewSourceOptions(){
    const srcs = qaPdfAvailableSources;
    if (qaPdfTopViewSettings && !srcs[qaPdfTopViewSettings.mainViewId]) {
      const first = ['solar', 'google', 'azure', 'apple'].find((id) => srcs[id]);
      if (first) qaPdfTopViewSettings.mainViewId = first;
    }
  }

  async function refreshQaAvailablePdfSources(){
    const raw = getQaSavedImageSources(qaImageAssets || {});
    const entries = await Promise.all(['solar','google','azure','apple'].map(async (id) => {
      const src = raw[id] || '';
      if (!src) return [id, ''];
      try {
        const canvas = await loadQaPdfSourceCanvas(id, src);
        qaPdfSourceThumbs[id] = makeQaCanvasThumbDataUrl(canvas, 260, 150);
        return [id, src];
      } catch(e) {
        delete qaPdfSourceThumbs[id];
        return [id, ''];
      }
    }));
    qaPdfAvailableSources = Object.fromEntries(entries.filter((entry) => entry[1]));
    qaPdfSourcesChecked = true;
    updateQaTopViewSourceOptions();
  }

  function getQaPdfPageKind(){
    return qaPdfForcedPageKind || qaPdfCurrentPageKind || 'general';
  }

  function qaPageToggleHtml(flag, label){
    const on = qaPdfPageConfig[flag] !== false;
    return `<button type="button" class="qa-pdf-page-toggle ${on ? 'on' : ''}" data-page-flag="${flag}"><span class="qa-pdf-switch"></span>${label}</button>`;
  }

  function qaRangeHtml(id, label, value, min, max, step, unit){
    return `<div class="qa-pdf-setting-row"><label for="${id}">${label}</label><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"><span class="qa-pdf-config-value" id="${id}Value">${value}${unit || ''}</span></div>`;
  }

  function qaStructureControlHtml(structure, rawStructs, settings){
    const id = Number(structure && structure.id);
    if (!Number.isFinite(id)) return '';
    const cfg = settings[id] || settings[String(id)] || {};
    const included = !cfg.hidden;
    const mergeTarget = cfg.mergeTarget ? String(cfg.mergeTarget) : '';
    const options = ['<option value="">Do not merge</option>'].concat(
      rawStructs
        .filter((other) => Number(other && other.id) !== id)
        .map((other) => {
          const otherId = String(other.id);
          return `<option value="${esc(otherId)}" ${mergeTarget === otherId ? 'selected' : ''}>Merge into ${esc(otherId)}</option>`;
        })
    ).join('');
    const faceCount = Array.isArray(structure.faces) ? structure.faces.length : 0;
    const lineCount = Array.isArray(structure.lines) ? structure.lines.length : 0;
    return `
      <div class="qa-pdf-structure-card ${included ? '' : 'off'}" data-structure-id="${id}">
        <label class="qa-pdf-structure-include"><input type="checkbox" data-structure-include ${included ? 'checked' : ''}>Structure ${id}</label>
        <select data-structure-merge ${included ? '' : 'disabled'}>${options}</select>
        <span>${faceCount} facets, ${lineCount} lines</span>
      </div>
    `;
  }

  function renderQaPdfConfigContent(){
    const host = document.getElementById('qaPdfConfigContent');
    if (!host || !qaPdfBaseSnapshot) return;
    const kind = getQaPdfPageKind();
    if (kind === 'top_view') {
      const available = ['solar','google','azure','apple'].filter((id) => qaPdfAvailableSources[id]);
      const emptyText = qaPdfSourcesChecked ? 'No usable imagery is available' : 'Loading available imagery...';
      host.innerHTML = `
        <div class="qa-pdf-source-strip">
          ${available.length ? available.map((id) => `<button type="button" class="qa-pdf-source-card ${qaPdfTopViewSettings?.mainViewId === id ? 'active' : ''}" data-top-source="${id}"><img src="${esc(qaPdfSourceThumbs[id] || qaPdfAvailableSources[id])}" alt=""></button>`).join('') : `<div class="qa-pdf-empty">${emptyText}</div>`}
        </div>
        ${qaRangeHtml('qaTopViewPadding', 'Zoom Out', qaPdfTopViewSettings?.cropPadding || 50, 0, 400, 10, 'px')}
      `;
    } else if (kind === 'elevations') {
      host.innerHTML = areQaQuadViewsDisabled()
        ? `<div class="qa-pdf-config-note">Quad View pages are disabled for this organization.</div>`
        : `<div class="qa-pdf-setting-row">${qaPageToggleHtml('page_elevations', 'Include Quad View Page')}</div><div class="qa-pdf-config-note">Turning this off removes the page from the generated PDF and renumbers everything after it.</div>`;
    } else if (kind === 'pitch' || kind === 'area') {
      host.innerHTML = `
        ${qaRangeHtml('qaDiagramFontScale', 'Label Size', Number(qaPdfBaseSnapshot.diagramFontScale || 1).toFixed(2), 0.65, 1.8, 0.05, 'x')}
        <div class="qa-pdf-config-note">Adjusts facet number label size on pitch and area diagrams.</div>
      `;
    } else if (kind === 'layer') {
      host.innerHTML = `
        ${qaRangeHtml('qaMeasurementFontScale', 'Measurement Size', Number(qaPdfBaseSnapshot.measurementFontScale || 1).toFixed(2), 0.65, 1.8, 0.05, 'x')}
        <div class="qa-pdf-config-note">Adjusts measurement number labels on layer measurement pages.</div>
      `;
    } else if (kind === 'ventilation') {
      const vent = qaPdfBaseSnapshot.ventSettings || {};
      const mode = vent.mode || 'ridge';
      host.innerHTML = `
        <div class="qa-pdf-setting-row">${qaPageToggleHtml('page_ventilation', 'Include Ventilation Page')}</div>
        <div class="qa-pdf-setting-row"><label>Vent Type</label><div class="qa-pdf-segment"><button type="button" data-vent-mode="ridge" class="${mode === 'ridge' ? 'active' : ''}">Ridge</button><button type="button" data-vent-mode="box" class="${mode === 'box' ? 'active' : ''}">Box</button></div><button type="button" class="qa-pdf-tool ${qaPdfVentEditMode ? 'active' : ''}" data-vent-edit>Edit</button></div>
        <div class="qa-pdf-config-note">Place box vents in the enlarged editor, then Done updates the preview.</div>
      `;
    } else if (kind === 'structures') {
      const raw = getQaPdfRawStructures();
      const settings = getQaPdfStructureSettings();
      const counts = getQaPdfStructureCounts();
      if (raw.length > 1) {
        host.innerHTML = `
          <div class="qa-pdf-structure-summary">
            <strong>${counts.effective}</strong> active structure${counts.effective === 1 ? '' : 's'} from <strong>${counts.raw}</strong> detected
          </div>
          <div class="qa-pdf-structure-list">
            ${raw.map((s) => qaStructureControlHtml(s, raw, settings)).join('')}
          </div>
        `;
      } else {
        host.innerHTML = `<div class="qa-pdf-config-note">No editable structure breakdown is available for this report.</div>`;
      }
    } else {
      host.innerHTML = `<div class="qa-pdf-config-note">Page-specific settings will appear here when this page has editable PDF controls.</div>`;
    }
    wireQaPdfDynamicControls();
  }

  function wireQaPdfDynamicControls(){
    const host = document.getElementById('qaPdfConfigContent');
    if (!host) return;
    host.querySelectorAll('[data-top-source]').forEach((btn) => {
      btn.onclick = () => {
        if (btn.disabled) return;
        cancelQaPdfPreviewRender();
        qaPdfTopViewSettings.mainViewId = btn.dataset.topSource;
        renderQaPdfConfigContent();
        renderQaTopViewLivePreview();
        updateQaTopViewPreviewFromControls();
      };
    });
    host.querySelectorAll('[data-page-flag]').forEach((btn) => {
      btn.onclick = () => {
        const flag = btn.dataset.pageFlag;
        qaPdfPageConfig[flag] = !(qaPdfPageConfig[flag] !== false);
        if (flag === 'page_elevations') {
          qaPdfForcedPageKind = 'elevations';
          qaPdfPreviewSnapshot = {
            ...(qaPdfPreviewSnapshot || {}),
            elevationSettings: { ...((qaPdfBaseSnapshot.elevationSettings && typeof qaPdfBaseSnapshot.elevationSettings === 'object') ? qaPdfBaseSnapshot.elevationSettings : {}), include: qaPdfPageConfig[flag] !== false }
          };
        }
        if (flag === 'page_ventilation') {
          qaPdfForcedPageKind = 'ventilation';
          qaPdfPreviewSnapshot = {
            ...(qaPdfPreviewSnapshot || {}),
            ventSettings: { ...((qaPdfBaseSnapshot.ventSettings && typeof qaPdfBaseSnapshot.ventSettings === 'object') ? qaPdfBaseSnapshot.ventSettings : {}), include: qaPdfPageConfig[flag] !== false }
          };
        }
        renderQaPdfConfigContent();
        updateQaDisabledPageVisual();
        if (qaPdfPageConfig[flag] !== false) qaPdfForcedPageKind = '';
        scheduleQaPdfPreviewRender(150);
      };
    });
    const topPad = host.querySelector('#qaTopViewPadding');
    if (topPad) {
      let topPadCommittedValue = String(topPad.value);
      const updateTopPadding = () => {
        qaPdfTopViewSettings.cropPadding = Math.max(0, Number(topPad.value) || 0);
        const val = host.querySelector('#qaTopViewPaddingValue');
        if (val) val.textContent = `${qaPdfTopViewSettings.cropPadding}px`;
        renderQaTopViewLivePreview();
      };
      const commitTopPadding = () => {
        if (!qaPdfTopViewSliderActive && topPadCommittedValue === String(topPad.value)) return;
        qaPdfTopViewSliderActive = false;
        topPadCommittedValue = String(topPad.value);
        updateTopPadding();
        scheduleQaPdfPreviewRender();
      };
      topPad.onpointerdown = () => {
        qaPdfTopViewSliderActive = true;
        cancelQaPdfPreviewRender();
      };
      topPad.oninput = () => {
        updateTopPadding();
        if (!qaPdfTopViewSliderActive) scheduleQaPdfPreviewRender();
      };
      topPad.onchange = commitTopPadding;
      topPad.onpointerup = commitTopPadding;
      topPad.onpointercancel = commitTopPadding;
    }
    const diagram = host.querySelector('#qaDiagramFontScale');
    if (diagram) {
      const updateDiagramScale = () => {
        qaPdfBaseSnapshot.diagramFontScale = Number(diagram.value) || 1;
        const val = host.querySelector('#qaDiagramFontScaleValue');
        if (val) val.textContent = `${Number(qaPdfBaseSnapshot.diagramFontScale).toFixed(2)}x`;
      };
      const commitDiagramScale = () => {
        qaPdfDiagramSliderActive = false;
        updateDiagramScale();
        scheduleQaPdfPreviewRender();
      };
      diagram.onpointerdown = () => {
        qaPdfDiagramSliderActive = true;
        cancelQaPdfPreviewRender();
      };
      diagram.oninput = () => {
        updateDiagramScale();
        if (!qaPdfDiagramSliderActive) scheduleQaPdfPreviewRender();
      };
      diagram.onchange = commitDiagramScale;
      diagram.onpointerup = commitDiagramScale;
      diagram.onpointercancel = commitDiagramScale;
      diagram.onlostpointercapture = () => {
        if (qaPdfDiagramSliderActive) commitDiagramScale();
      };
    }
    const measure = host.querySelector('#qaMeasurementFontScale');
    if (measure) {
      const updateMeasurementScale = () => {
        qaPdfBaseSnapshot.measurementFontScale = Number(measure.value) || 1;
        const val = host.querySelector('#qaMeasurementFontScaleValue');
        if (val) val.textContent = `${Number(qaPdfBaseSnapshot.measurementFontScale).toFixed(2)}x`;
      };
      const commitMeasurementScale = () => {
        qaPdfMeasurementSliderActive = false;
        updateMeasurementScale();
        scheduleQaPdfPreviewRender();
      };
      measure.onpointerdown = () => {
        qaPdfMeasurementSliderActive = true;
        cancelQaPdfPreviewRender();
      };
      measure.oninput = () => {
        updateMeasurementScale();
        if (!qaPdfMeasurementSliderActive) scheduleQaPdfPreviewRender();
      };
      measure.onchange = commitMeasurementScale;
      measure.onpointerup = commitMeasurementScale;
      measure.onpointercancel = commitMeasurementScale;
      measure.onlostpointercapture = () => {
        if (qaPdfMeasurementSliderActive) commitMeasurementScale();
      };
    }
    host.querySelectorAll('[data-vent-mode]').forEach((btn) => {
      btn.onclick = () => {
        qaPdfBaseSnapshot.ventSettings = { ...qaPdfBaseSnapshot.ventSettings, mode: btn.dataset.ventMode };
        qaPdfVentEditMode = false;
        renderQaPdfConfigContent();
        renderQaVentOverlay();
        scheduleQaPdfPreviewRender(150);
      };
    });
    const edit = host.querySelector('[data-vent-edit]');
    if (edit) edit.onclick = () => {
      qaPdfVentEditMode = true;
      qaPdfBaseSnapshot.ventSettings = {
        ...qaPdfBaseSnapshot.ventSettings,
        mode: qaPdfBaseSnapshot.ventSettings?.mode || 'ridge',
        excludedRidges: Array.isArray(qaPdfBaseSnapshot.ventSettings?.excludedRidges) ? qaPdfBaseSnapshot.ventSettings.excludedRidges : [],
        boxVents: Array.isArray(qaPdfBaseSnapshot.ventSettings?.boxVents) ? qaPdfBaseSnapshot.ventSettings.boxVents : []
      };
      renderQaPdfConfigContent();
      renderQaVentOverlay();
    };
    host.querySelectorAll('[data-structure-id]').forEach((card) => {
      const id = String(card.dataset.structureId || '').trim();
      if (!id) return;
      const include = card.querySelector('[data-structure-include]');
      const merge = card.querySelector('[data-structure-merge]');
      const ensureCfg = () => {
        const settings = getQaPdfStructureSettings();
        if (!settings[id] || typeof settings[id] !== 'object') settings[id] = {};
        return settings[id];
      };
      if (include) {
        include.onchange = () => {
          const cfg = ensureCfg();
          cfg.hidden = !include.checked;
          if (cfg.hidden && merge) merge.value = '';
          if (cfg.hidden) cfg.mergeTarget = '';
          renderQaPdfConfigContent();
          qaPdfForcedPageKind = 'structures';
          updateQaDisabledPageVisual();
          scheduleQaPdfPreviewRender(150);
        };
      }
      if (merge) {
        merge.onchange = () => {
          const cfg = ensureCfg();
          cfg.mergeTarget = merge.value || '';
          qaPdfForcedPageKind = 'structures';
          renderQaPdfConfigContent();
          updateQaDisabledPageVisual();
          scheduleQaPdfPreviewRender(150);
        };
      }
    });
  }

  function loadQaImageElement(src){
    if (qaPdfImageLoadCache.has(src)) return qaPdfImageLoadCache.get(src);
    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        qaPdfImageLoadCache.delete(src);
        reject(new Error('Unable to load image source.'));
      };
      img.src = src;
    });
    qaPdfImageLoadCache.set(src, promise);
    return promise;
  }

  function makeQaCanvasThumbDataUrl(sourceCanvas, maxW, maxH){
    const sw = Math.max(1, Number(sourceCanvas && sourceCanvas.width) || 1);
    const sh = Math.max(1, Number(sourceCanvas && sourceCanvas.height) || 1);
    const scale = Math.min(Number(maxW || 260) / sw, Number(maxH || 150) / sh, 1);
    const tw = Math.max(1, Math.round(sw * scale));
    const th = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, tw, th);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0, sw, sh, 0, 0, tw, th);
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  async function loadQaPdfSourceCanvas(viewId, knownSrc){
    const srcs = getQaSavedImageSources(qaImageAssets || {});
    const src = knownSrc || qaPdfAvailableSources[viewId] || srcs[viewId] || '';
    if (!src) throw new Error('That image source is not available for this project.');
    const cacheKey = `${viewId}|${src}`;
    if (qaPdfSourceCanvasCache.has(cacheKey)) return await qaPdfSourceCanvasCache.get(cacheKey);
    const promise = (async () => {
      const source = await loadQaStageSource(src, viewId);
      const dims = getQaImageBaseDims(viewId, source);
      const canvas = document.createElement('canvas');
      canvas.width = dims.width;
      canvas.height = dims.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (viewId === 'solar') {
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      } else {
        drawQaScaledImage(ctx, source, canvas.width, canvas.height, getQaLayerConfig(viewId));
      }
      return canvas;
    })().catch((err) => {
      qaPdfSourceCanvasCache.delete(cacheKey);
      throw err;
    });
    qaPdfSourceCanvasCache.set(cacheKey, promise);
    return await promise;
  }

  async function buildQaTopViewDataUrl(viewId, cropPadding){
    const snapshot = qaPdfBaseSnapshot || getQaPdfState();
    if (!snapshot || !snapshot.cropRegion) throw new Error('No saved PDF crop region is available.');
    const sourceCanvas = await loadQaPdfSourceCanvas(viewId);

    const baseCrop = snapshot.cropRegion;
    const pad = Math.max(0, Number(cropPadding) || 0);
    const cx = Number(baseCrop.minX || 0) + (Number(baseCrop.width || 0) / 2);
    const cy = Number(baseCrop.minY || 0) + (Number(baseCrop.height || 0) / 2);
    const squareSize = Math.max(Number(baseCrop.width || 1), Number(baseCrop.height || 1)) + (pad * 2);
    const sqMinX = cx - (squareSize / 2);
    const sqMinY = cy - (squareSize / 2);
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = Math.max(1, Math.round(squareSize));
    cropCanvas.height = Math.max(1, Math.round(squareSize));
    const cropCtx = cropCanvas.getContext('2d');
    cropCtx.fillStyle = '#fff';
    cropCtx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
    cropCtx.drawImage(sourceCanvas, sqMinX, sqMinY, squareSize, squareSize, 0, 0, cropCanvas.width, cropCanvas.height);

    const outCanvas = document.createElement('canvas');
    const target = 800;
    outCanvas.width = target;
    outCanvas.height = target;
    const outCtx = outCanvas.getContext('2d');
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.fillStyle = '#fff';
    outCtx.fillRect(0, 0, target, target);
    outCtx.drawImage(cropCanvas, 0, 0, target, target);

    return {
      dataUrl: outCanvas.toDataURL('image/jpeg', 0.85),
      displayCrop: {
        minX: sqMinX,
        minY: sqMinY,
        width: squareSize,
        height: squareSize
      }
    };
  }

  async function buildQaVentEditorImageDataUrl(){
    const snapshot = qaPdfBaseSnapshot || getQaPdfState();
    if (!snapshot || !snapshot.cropRegion) throw new Error('No saved PDF crop region is available.');
    const settings = snapshot.imageSettings || {};
    const viewId = settings.ventViewId || settings.mainViewId || qaPdfTopViewSettings?.ventViewId || 'solar';
    const sourceCanvas = await loadQaPdfSourceCanvas(viewId);

    const crop = snapshot.cropRegion;
    const cropW = Math.max(1, Number(crop.width || 1));
    const cropH = Math.max(1, Number(crop.height || 1));
    const outW = 1600;
    const outH = Math.max(1, Math.round(outW * (cropH / cropW)));
    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext('2d');
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.fillStyle = '#fff';
    outCtx.fillRect(0, 0, outW, outH);
    outCtx.drawImage(
      sourceCanvas,
      Number(crop.minX || 0),
      Number(crop.minY || 0),
      cropW,
      cropH,
      0,
      0,
      outW,
      outH
    );
    return outCanvas.toDataURL('image/jpeg', 0.9);
  }

  async function renderQaTopViewLivePreview(){
    if (getQaPdfPageKind() !== 'top_view' || !qaPdfTopViewSettings) return;
    const previewSeq = ++qaPdfTopViewPreviewSeq;
    const wrap = document.querySelector('#qaPdfMain .qa-pdf-page-wrap');
    if (!wrap) return;
    try {
      const topView = await buildQaTopViewDataUrl(qaPdfTopViewSettings.mainViewId || 'solar', qaPdfTopViewSettings.cropPadding || 0);
      if (previewSeq !== qaPdfTopViewPreviewSeq) return;
      const canvas = wrap.querySelector('canvas');
      if (!canvas) return;
      let img = wrap.querySelector('.qa-pdf-live-topview');
      if (!img) {
        img = document.createElement('img');
        img.className = 'qa-pdf-live-topview';
        wrap.appendChild(img);
      }
      img.className = 'qa-pdf-live-topview';
      img.src = topView.dataUrl;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const pageMmW = 215.9;
      const pageMmH = 279.4;
      const marginLeftMm = 25;
      const availableMmW = pageMmW - marginLeftMm - 15;
      const topMm = 35;
      const radiusMm = 3;
      const sizeMm = Math.min(availableMmW, pageMmH - topMm - 30);
      const leftMm = marginLeftMm + (availableMmW - sizeMm) / 2;
      const size = sizeMm / pageMmW * w;
      const radius = radiusMm / pageMmW * w;
      img.style.width = `${size}px`;
      img.style.height = `${size}px`;
      img.style.left = `${leftMm / pageMmW * w}px`;
      img.style.top = `${topMm / pageMmH * h}px`;
      img.style.borderRadius = `${radius}px`;
    } catch(e) {}
  }

  async function updateQaTopViewPreviewFromControls(){
    if (!qaPdfBaseSnapshot || !qaPdfTopViewSettings) return;
    qaPdfTopViewSettings = {
      ...(qaPdfTopViewSettings || {}),
      mainViewId: qaPdfTopViewSettings.mainViewId || 'solar',
      cropPadding: Math.max(0, Number(qaPdfTopViewSettings.cropPadding) || 0)
    };
    cancelQaPdfPreviewRender();
    scheduleQaPdfPreviewRender(120);
  }

  function isQaPdfPreviewInteractionActive(){
    return !!(qaPdfTopViewSliderActive || qaPdfDiagramSliderActive || qaPdfMeasurementSliderActive);
  }

  function cancelQaPdfPreviewRender(){
    if (qaPdfPreviewTimer) {
      clearTimeout(qaPdfPreviewTimer);
      qaPdfPreviewTimer = null;
    }
    qaPdfSyncSeq++;
    qaPdfPreviewSeq++;
  }

  function scheduleQaPdfPreviewRender(delay, options){
    options = options && typeof options === 'object' ? options : {};
    const syncSeq = ++qaPdfSyncSeq;
    if (qaPdfPreviewTimer) clearTimeout(qaPdfPreviewTimer);
    qaPdfPreviewTimer = setTimeout(() => {
      qaPdfPreviewTimer = null;
      if (isQaPdfPreviewInteractionActive()) return;
      renderQaPdfPreview({ syncSeq, persist: options.persist !== false }).catch((err) => {
        console.error('[QA PDF] Preview render failed:', err);
        setPdfHint('Preview failed');
      });
    }, Number.isFinite(Number(delay)) ? Number(delay) : 500);
  }

  async function renderQaPdfPreview(options){
    options = options && typeof options === 'object' ? options : {};
    if (!currentId || !qaPdfBaseSnapshot || !qaPdfTopViewSettings) return;
    const syncSeq = Number.isFinite(Number(options.syncSeq)) ? Number(options.syncSeq) : ++qaPdfSyncSeq;
    const myPreviewSeq = ++qaPdfPreviewSeq;
    setPdfHint('Rendering...');
    const viewId = qaPdfTopViewSettings.mainViewId || 'solar';
    const cropPadding = Number(qaPdfTopViewSettings.cropPadding) || 0;
    let topView = null;
    if (qaPdfAvailableSources[viewId]) {
      topView = await buildQaTopViewDataUrl(viewId, cropPadding);
    }
    if (myPreviewSeq !== qaPdfPreviewSeq || syncSeq !== qaPdfSyncSeq) return;
    const nextImageSettings = {
      ...((qaPdfBaseSnapshot.imageSettings && typeof qaPdfBaseSnapshot.imageSettings === 'object') ? qaPdfBaseSnapshot.imageSettings : {}),
      ...qaPdfTopViewSettings,
      mainViewId: viewId,
      cropPadding
    };
    const topViewPatch = topView
      ? { solarImg: topView.dataUrl, displayCrop: topView.displayCrop }
      : { solarImg: qaPdfBaseSnapshot.solarImg || null, displayCrop: qaPdfBaseSnapshot.displayCrop || null };
    const previewPageConfig = {
      ...qaPdfPageConfig,
      page_elevations: !areQaQuadViewsDisabled(),
      page_ventilation: true,
      ...(shouldRenderQaPdfDisabledStructuresPage() ? { page_structures_preview: true } : {})
    };
    const previewVentSettings = {
      ...cloneJson(qaPdfBaseSnapshot.ventSettings || {}, {}),
      include: true
    };
    qaPdfPreviewSnapshot = {
      ...(qaPdfPreviewSnapshot || {}),
      ...topViewPatch,
      imageSettings: nextImageSettings,
      diagramFontScale: Number(qaPdfBaseSnapshot.diagramFontScale) || 1,
      measurementFontScale: Number(qaPdfBaseSnapshot.measurementFontScale) || 1,
      structureSettings: cloneJson(getQaPdfStructureSettings(), {}),
      ventSettings: previewVentSettings,
      elevationSettings: {
        ...((qaPdfBaseSnapshot.elevationSettings && typeof qaPdfBaseSnapshot.elevationSettings === 'object') ? qaPdfBaseSnapshot.elevationSettings : {}),
        include: !areQaQuadViewsDisabled()
      },
      pdfConfig: { ...((qaPdfBaseSnapshot.pdfConfig && typeof qaPdfBaseSnapshot.pdfConfig === 'object') ? qaPdfBaseSnapshot.pdfConfig : {}), ...previewPageConfig }
    };
    const editorWin = await waitForQaEmbeddedEditorWindow();
    const pdfRuntime = editorWin.FirstMatePDFStandalone;
    if (!pdfRuntime || typeof pdfRuntime.generateProjectPdfsWithBackgroundSync !== 'function') {
      throw new Error('The embedded editor local PDF runtime is unavailable.');
    }
    const renderSnapshot = {
      ...cloneJson(qaPdfBaseSnapshot, {}),
      ...cloneJson(qaPdfPreviewSnapshot, {}),
      pdfConfig: {
        ...cloneJson(qaPdfBaseSnapshot.pdfConfig || {}, {}),
        ...previewPageConfig
      }
    };
    const outputSpecs = [
      { slot: 'main', mode: 'full', persist: true, update_status: false, page_config: previewPageConfig },
      { slot: 'summary', mode: 'summary', persist: true, update_status: false }
    ];
    const localResult = await pdfRuntime.generateProjectPdfsWithBackgroundSync(
      currentId,
      renderSnapshot,
      {
        folderId: currentId,
        manifest: editorWin.currentProjectManifest || currentManifest || null,
        organization: editorWin.projectOrganization || qaImageBundle?.organization || null
      },
      {
        outputs: outputSpecs,
        localOutputs: outputSpecs,
        onOutput: async (output) => {
          if (!output || output.slot !== 'main' || !output.result?.blob) return;
          if (myPreviewSeq !== qaPdfPreviewSeq || syncSeq !== qaPdfSyncSeq) return;
          if (qaPdfObjectUrl) {
            try { URL.revokeObjectURL(qaPdfObjectUrl); } catch(e) {}
          }
          qaPdfObjectUrl = URL.createObjectURL(output.result.blob);
          await loadQaPdfDocument(qaPdfObjectUrl, qaPdfCurrentPage);
          setPdfHint('Main ready; verifying summary...');
        }
      }
    );
    if (myPreviewSeq !== qaPdfPreviewSeq || syncSeq !== qaPdfSyncSeq) return;
    const mainOutput = Array.isArray(localResult.outputs)
      ? localResult.outputs.find((output) => output && output.slot === 'main')
      : null;
    const blob = mainOutput && mainOutput.blob;
    if (!blob) throw new Error('The local PDF renderer did not return the main report.');
    qaPdfLastSyncJobId = String(localResult.sync?.job_id || '');
    qaPdfLastSyncRevision = String(localResult.revision || '');
    if (myPreviewSeq !== qaPdfPreviewSeq || syncSeq !== qaPdfSyncSeq) return;
    if (qaPdfObjectUrl) {
      try { URL.revokeObjectURL(qaPdfObjectUrl); } catch(e) {}
    }
    qaPdfObjectUrl = URL.createObjectURL(blob);
    await loadQaPdfDocument(qaPdfObjectUrl, qaPdfCurrentPage);
    if (options.persist !== false && syncSeq === qaPdfSyncSeq) {
      qaPdfBaseSnapshot = cloneJson(localResult.snapshot || renderSnapshot, {});
      updateQaEditorBundleCache(currentId, { pdf_state: cloneJson(qaPdfBaseSnapshot, {}) });
      qaPdfPreviewSnapshot = null;
      setPdfHint('Synced');
    } else if (syncSeq === qaPdfSyncSeq) {
      setPdfHint(`Page ${qaPdfCurrentPage}/${qaPdfDoc ? qaPdfDoc.numPages : '?'}`);
    }
  }

  async function persistQaPdfPreviewToReport(options){
    options = options && typeof options === 'object' ? options : {};
    if (!currentId || !qaPdfBaseSnapshot) return;
    const syncSeq = Number.isFinite(Number(options.syncSeq)) ? Number(options.syncSeq) : qaPdfSyncSeq;
    if (qaPdfPersistActive) {
      qaPdfPersistPending = true;
      return;
    }
    qaPdfPersistActive = true;
    try {
      if (!qaPdfPreviewSnapshot) {
        await renderQaPdfPreview({ syncSeq, persist: false });
      }
      if (!qaPdfPreviewSnapshot) throw new Error('No preview changes are ready to apply.');
      const nextSnapshot = {
        ...cloneJson(qaPdfBaseSnapshot, {}),
        ...cloneJson(qaPdfPreviewSnapshot, {}),
        structureSettings: cloneJson(getQaPdfStructureSettings(), {}),
        pdfConfig: {
          ...((qaPdfBaseSnapshot.pdfConfig && typeof qaPdfBaseSnapshot.pdfConfig === 'object') ? qaPdfBaseSnapshot.pdfConfig : {}),
          ...qaPdfPageConfig
        }
      };
      if (areQaQuadViewsDisabled()) {
        nextSnapshot.quadImage = null;
        nextSnapshot.elevationSettings = {
          ...((nextSnapshot.elevationSettings && typeof nextSnapshot.elevationSettings === 'object') ? nextSnapshot.elevationSettings : {}),
          include: false
        };
        nextSnapshot.pdfConfig.page_elevations = false;
      }
      if (syncSeq !== qaPdfSyncSeq) return;
      setPdfHint('Syncing...');
      const saveResp = await fetch(Portal.fmUrl(`projects/${encodeURIComponent(currentId)}/pdf-state`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(nextSnapshot)
      });
      if (syncSeq !== qaPdfSyncSeq) return;
      const saveJson = await saveResp.json().catch(() => ({}));
      if (!saveResp.ok || saveJson.ok === false) {
        throw new Error(saveJson.error || saveJson.message || 'Failed to save PDF configuration.');
      }
      await qaFetchJsonWithDebug(qaDebugGenerateUrl(currentId, 'qa_preview_sync_generate'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...qaPdfDebugHeaders('qa_preview_sync_generate')
        },
        body: JSON.stringify({
          persist_files: true,
          update_status: false,
          outputs: [
            {
              slot: 'main',
              mode: 'full',
              persist: true,
              update_status: false,
              page_config: qaPdfPageConfig
            },
            {
              slot: 'summary',
              mode: 'summary',
              persist: true,
              update_status: false
            }
          ]
        })
      }, {
        stage: 'persistQaPdfPreviewToReport',
        projectId: currentId,
        syncSeq
      });
      if (syncSeq !== qaPdfSyncSeq) return;
      qaPdfBaseSnapshot = nextSnapshot;
      updateQaEditorBundleCache(currentId, { pdf_state: cloneJson(nextSnapshot, {}) });
      qaPdfPreviewSnapshot = null;
      qaPdfLastSourceUrl = `${fmProjectPdfUrl(currentId, 'main')}&v=${Date.now()}`;
      setPdfHint('Synced');
      setTimeout(() => {
        if (syncSeq === qaPdfSyncSeq && qaPdfDoc) setPdfHint(`Page ${qaPdfCurrentPage}/${qaPdfDoc.numPages}`);
      }, 900);
    } catch (e) {
      console.error('[QA PDF] Sync failed:', e);
      if (!options.silent) alert(e && e.message ? e.message : 'Failed to sync PDF preview changes.');
      throw e;
    } finally {
      qaPdfPersistActive = false;
      if (qaPdfPersistPending && currentId && qaPdfBaseSnapshot) {
        qaPdfPersistPending = false;
        scheduleQaPdfPreviewRender(0);
      }
    }
    updateQaBulkControls();
  }

  async function applyQaPdfPreviewToReport(options){
    return persistQaPdfPreviewToReport(options);
  }

  async function flushQaPdfPendingSync(){
    if (!currentId || !qaPdfBaseSnapshot) return;
    if (qaPdfPreviewTimer) {
      clearTimeout(qaPdfPreviewTimer);
      qaPdfPreviewTimer = null;
      const syncSeq = ++qaPdfSyncSeq;
      await renderQaPdfPreview({ syncSeq, persist: true });
      return;
    }
    if (qaPdfPreviewSnapshot) {
      await renderQaPdfPreview({ syncSeq: qaPdfSyncSeq, persist: true });
    }
  }

  function getActiveQaEditorFrame(){
    const frame = document.getElementById('qaEmbeddedEditorFrame');
    if (!frame || !frame.contentWindow) return null;
    return frame;
  }

  async function waitForQaEmbeddedEditorWindow(timeoutMs = 20000){
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < timeoutMs) {
      const frame = getActiveQaEditorFrame();
      try {
        const win = frame && frame.contentWindow;
        if (win && String(win.currentProjectId || '') === String(currentId || '') && typeof win.saveProjectData === 'function') {
          return win;
        }
      } catch (e) {
        lastError = e;
      }
      await sleep(250);
    }
    throw new Error(lastError && lastError.message
      ? `The embedded editor could not be reached: ${lastError.message}`
      : 'The embedded editor is not ready. Reload the QA item and try approving again.');
  }

  async function waitForQaPdfPersistenceIdle(timeoutMs = 20000){
    const started = Date.now();
    while (qaPdfPersistActive && Date.now() - started < timeoutMs) {
      await sleep(150);
    }
    if (qaPdfPersistActive) {
      throw new Error('The QA PDF preview is still syncing. Please wait a moment and try again.');
    }
  }

  function captureQaPdfControlState(){
    const base = qaPdfBaseSnapshot && typeof qaPdfBaseSnapshot === 'object' ? qaPdfBaseSnapshot : {};
    return {
      hadConfigurator: !!qaPdfBaseSnapshot,
      topViewSettings: cloneJson(qaPdfTopViewSettings, null),
      pageConfig: cloneJson(qaPdfPageConfig, {}),
      diagramFontScale: (typeof base.diagramFontScale === 'number') ? base.diagramFontScale : null,
      measurementFontScale: (typeof base.measurementFontScale === 'number') ? base.measurementFontScale : null,
      structureSettings: cloneJson(base.structureSettings, null),
      ventSettings: cloneJson(base.ventSettings, null),
      elevationSettings: cloneJson(base.elevationSettings, null)
    };
  }

  function restoreQaPdfControlState(controlState){
    if (!controlState || !controlState.hadConfigurator || !qaPdfBaseSnapshot) return;
    const savedPageConfig = controlState.pageConfig && typeof controlState.pageConfig === 'object'
      ? controlState.pageConfig
      : {};
    qaPdfPageConfig = {
      page_elevations: !(qaPdfBaseSnapshot?.elevationSettings && qaPdfBaseSnapshot.elevationSettings.include === false),
      page_ventilation: !(qaPdfBaseSnapshot?.ventSettings && qaPdfBaseSnapshot.ventSettings.include === false),
      ...((qaPdfBaseSnapshot.pdfConfig && typeof qaPdfBaseSnapshot.pdfConfig === 'object') ? cloneJson(qaPdfBaseSnapshot.pdfConfig, {}) : {}),
      ...savedPageConfig
    };
    if (areQaQuadViewsDisabled()) {
      qaPdfPageConfig.page_elevations = false;
      qaPdfBaseSnapshot.quadImage = null;
      qaPdfBaseSnapshot.elevationSettings = {
        ...((qaPdfBaseSnapshot.elevationSettings && typeof qaPdfBaseSnapshot.elevationSettings === 'object') ? qaPdfBaseSnapshot.elevationSettings : {}),
        include: false
      };
    }
    if (controlState.topViewSettings && typeof controlState.topViewSettings === 'object') {
      qaPdfTopViewSettings = {
        ...(qaPdfTopViewSettings || {}),
        ...cloneJson(controlState.topViewSettings, {})
      };
    }
    if (typeof controlState.diagramFontScale === 'number') {
      qaPdfBaseSnapshot.diagramFontScale = controlState.diagramFontScale;
    }
    if (typeof controlState.measurementFontScale === 'number') {
      qaPdfBaseSnapshot.measurementFontScale = controlState.measurementFontScale;
    }
    if (controlState.structureSettings && typeof controlState.structureSettings === 'object') {
      qaPdfBaseSnapshot.structureSettings = cloneJson(controlState.structureSettings, {});
    }
    if (controlState.ventSettings && typeof controlState.ventSettings === 'object') {
      qaPdfBaseSnapshot.ventSettings = cloneJson(controlState.ventSettings, {});
    }
    if (controlState.elevationSettings && typeof controlState.elevationSettings === 'object') {
      qaPdfBaseSnapshot.elevationSettings = cloneJson(controlState.elevationSettings, {});
    }
  }

  async function refreshQaPdfStateAfterEditorSave(controlState){
    if (!currentId) return null;
    clearQaEditorBundleCache(currentId);
    const bundle = await fmGetEditorBundle(currentId, 25000, { force: true });
    if (bundle && typeof bundle === 'object') {
      qaImageBundle = bundle;
      if (typeof setQaImageAssets === 'function') {
        setQaImageAssets(bundle.assets || {}, bundle);
      }
      qaPdfImageLoadCache = new Map();
      qaPdfSourceCanvasCache = new Map();
      qaPdfAvailableSources = {};
      qaPdfSourcesChecked = false;
      if (bundle.app_metadata && typeof bundle.app_metadata === 'object') {
        currentAppMetadata = cloneJson(bundle.app_metadata, {});
      }
      if (bundle.manifest && typeof bundle.manifest === 'object') {
        currentManifest = bundle.manifest;
        currentProjectStatus = String(bundle.manifest.status || currentProjectStatus || '').trim().toLowerCase();
      }
      if (bundle.pdf_state && typeof bundle.pdf_state === 'object') {
        qaPdfBaseSnapshot = cloneJson(bundle.pdf_state, null);
        qaPdfPreviewSnapshot = null;
        restoreQaPdfControlState(controlState);
        updateQaEditorBundleCache(currentId, { pdf_state: cloneJson(qaPdfBaseSnapshot, {}) });
      }
    }
    return qaPdfBaseSnapshot;
  }

  async function saveEmbeddedEditorStateForQaApproval(){
    if (!currentId) return;
    await waitForQaPdfPersistenceIdle();
    const controlState = captureQaPdfControlState();
    if (qaPdfPreviewTimer) {
      clearTimeout(qaPdfPreviewTimer);
      qaPdfPreviewTimer = null;
    }
    qaPdfPreviewSnapshot = null;
    qaPdfSyncSeq++;
    qaPdfPreviewSeq++;

    setPdfHint('Saving editor...');
    const editorWin = await waitForQaEmbeddedEditorWindow();
    const saved = await editorWin.saveProjectData(true, true);
    if (saved !== true) {
      throw new Error('The embedded editor did not save successfully. The report was not sent.');
    }
    if (typeof editorWin.saveStandalonePdfState !== 'function') {
      throw new Error('The embedded editor cannot save the PDF state. Reload the QA item and try again.');
    }
    if (typeof editorWin.captureStateForPDF !== 'function') {
      throw new Error('The embedded editor cannot capture a fresh PDF state. Reload the QA item and try again.');
    }
    const livePdfState = await editorWin.captureStateForPDF();
    if (!livePdfState) {
      throw new Error('The embedded editor did not return a fresh PDF state. The report was not sent.');
    }
    const pdfSaved = await editorWin.saveStandalonePdfState(livePdfState, { skipCaptureIfMissing: false });
    if (pdfSaved !== true) {
      throw new Error('The embedded editor did not produce a fresh PDF state. The report was not sent.');
    }
    await refreshQaPdfStateAfterEditorSave(controlState);
    qaPdfLastSyncJobId = '';
    qaPdfLastSyncRevision = '';
    setPdfHint('Saved');
  }

  function resolveQaReviewedPdfSync(requestedPdfSync){
    let jobId = String(requestedPdfSync?.jobId || requestedPdfSync?.job_id || requestedPdfSync?.pdf_sync_job_id || '').trim();
    let revision = String(requestedPdfSync?.revision || requestedPdfSync?.pdf_sync_revision || '').trim();
    if (!jobId || !revision) {
      try {
        const editorWin = getActiveQaEditorFrame()?.contentWindow;
        const reviewedSync = editorWin?.__lastFirstMeasureReviewedPdfSync || editorWin?.__lastFirstMeasurePdfSync || {};
        jobId = jobId || String(reviewedSync.jobId || reviewedSync.job_id || '').trim();
        revision = revision || String(reviewedSync.revision || '').trim();
      } catch (error) {
        console.warn('[PDF SYNC] Unable to read the reviewed PDF revision from the embedded editor.', error);
      }
    }
    console.info(
      `[PDF SYNC] Approval captured reviewed revision: project=${currentId}; job=${jobId || 'missing'}; revision=${revision || 'missing'}`
    );
    return { jobId, revision };
  }

  async function ensureQaPdfReportsReadyForSend(requestedPdfSync){
    if (!currentId) return;
    const requestedJobId = String(requestedPdfSync?.jobId || requestedPdfSync?.job_id || requestedPdfSync?.pdf_sync_job_id || '').trim();
    const requestedRevision = String(requestedPdfSync?.revision || requestedPdfSync?.pdf_sync_revision || '').trim();
    if (requestedJobId && requestedRevision) {
      qaPdfLastSyncJobId = requestedJobId;
      qaPdfLastSyncRevision = requestedRevision;
      console.info('[PDF SYNC] QA approval received the exact revision reviewed in the embedded PDF.', {
        projectId: currentId,
        jobId: requestedJobId,
        revision: requestedRevision
      });
      return { jobId: requestedJobId, revision: requestedRevision };
    }
    if (!qaPdfBaseSnapshot) {
      console.warn('[PDF SYNC] Approving the existing stored PDF because no render snapshot is available.', { projectId: currentId });
      return qaPdfLastSyncJobId ? { jobId: qaPdfLastSyncJobId, revision: qaPdfLastSyncRevision } : null;
    }
    if (qaPdfBaseSnapshot && (qaPdfPreviewSnapshot || qaPdfPreviewTimer)) {
      await flushQaPdfPendingSync();
    }
    if (!qaPdfLastSyncJobId && qaPdfBaseSnapshot && qaPdfTopViewSettings) {
      await renderQaPdfPreview({ syncSeq: ++qaPdfSyncSeq, persist: true });
    }
    if (!qaPdfLastSyncJobId) throw new Error('The PDF synchronization job was not accepted by the server.');
    console.info('[PDF SYNC] QA approval is using the last locally reviewed PDF revision.', {
      projectId: currentId,
      jobId: qaPdfLastSyncJobId,
      revision: qaPdfLastSyncRevision
    });
    return { jobId: qaPdfLastSyncJobId, revision: qaPdfLastSyncRevision };
  }

  function getQaVentImageRect(canvas){
    const pageMmW = 215.9;
    const pageMmH = 279.4;
    const x = 25;
    const y = 35;
    const w = pageMmW - x - 15;
    const atticBoxH = 24;
    const rowH = 32;
    const intakeH = 40;
    const keyContentW = 30;
    const ry = y + atticBoxH + 5 + rowH + 5 + intakeH + 5;
    const disclaimerReserve = 30;
    const availH = pageMmH - 20 - disclaimerReserve - ry;
    const imgMaxH = Math.min(availH, 75);
    const crop = qaPdfBaseSnapshot && qaPdfBaseSnapshot.cropRegion ? qaPdfBaseSnapshot.cropRegion : null;
    const vRat = crop && Number(crop.width) && Number(crop.height) ? Number(crop.width) / Number(crop.height) : 1;
    const imgMaxW = w * 0.62;
    let imgW;
    let imgH;
    if (vRat >= (imgMaxW / imgMaxH)) {
      imgW = imgMaxW;
      imgH = imgW / vRat;
    } else {
      imgH = imgMaxH;
      imgW = imgH * vRat;
    }
    const gap = (w - keyContentW - imgW) / 3;
    const imgX = x + gap + keyContentW + gap;
    const imgY = ry + (availH - imgH) / 2;
    const canvasW = canvas.clientWidth;
    const canvasH = canvas.clientHeight;
    return {
      left: imgX / pageMmW * canvasW,
      top: imgY / pageMmH * canvasH,
      width: imgW / pageMmW * canvasW,
      height: imgH / pageMmH * canvasH
    };
  }

  function getQaVentImageDataUrl(canvas){
    const rect = getQaVentImageRect(canvas);
    const sx = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
    const sy = canvas.height / Math.max(1, canvas.clientHeight || canvas.height);
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(rect.width * sx));
    crop.height = Math.max(1, Math.round(rect.height * sy));
    crop.getContext('2d').drawImage(
      canvas,
      Math.round(rect.left * sx),
      Math.round(rect.top * sy),
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height
    );
    return crop.toDataURL('image/jpeg', 0.9);
  }

  function finishQaVentEdit(){
    qaPdfVentEditMode = false;
    renderQaPdfConfigContent();
    renderQaVentOverlay();
    setPdfHint('Rendering...');
    scheduleQaPdfPreviewRender(0);
  }

  function getQaVentMetrics(){
    const report = qaPdfBaseSnapshot && qaPdfBaseSnapshot.report;
    const materials = report && report.materials ? report.materials : {};
    const lines = report && Array.isArray(report.lines) ? report.lines : [];
    const BOX_VENT_RATING = 50;
    const RIDGE_VENT_RATING = 18;
    const SOFFIT_FACTOR = 0.98;
    const orgGen = window.projectOrganization?.report_settings?.general;
    const ratio = (orgGen && orgGen.nfva_ratio) ? parseInt(orgGen.nfva_ratio, 10) : 300;
    const selectedRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 300;
    const roofSurfaceSqFt = (Number(materials.totalSquares) || 0) * 100;
    const footprintSqFt = Number(materials.totalFootprintSqFt) || roofSurfaceSqFt;
    const atticArea = Number(materials.atticAreaSqFt) || (footprintSqFt * SOFFIT_FACTOR);
    const totalNfvaSqIn = (atticArea / selectedRatio) * 144;
    const reqExhaust = totalNfvaSqIn / 2;
    const excluded = Array.isArray(qaPdfBaseSnapshot?.ventSettings?.excludedRidges) ? qaPdfBaseSnapshot.ventSettings.excludedRidges : [];
    const activeRidgeLines = lines.filter((line, idx) => line && line.type === 'ridge' && !excluded.includes(idx));
    const totalRidgeFt = activeRidgeLines.reduce((sum, line) => sum + (Number(line.length) || 0), 0);
    const ridgeNeededFt = reqExhaust / RIDGE_VENT_RATING;
    const ridgeCapacity = totalRidgeFt * RIDGE_VENT_RATING;
    const ridgeOk = ridgeCapacity >= reqExhaust && totalRidgeFt >= 4;
    return {
      reqExhaust,
      totalRidgeFt,
      ridgeNeededFt,
      ridgeCapacity,
      ridgeOk,
      boxOnlyCount: Math.max(0, Math.ceil(reqExhaust / BOX_VENT_RATING))
    };
  }

  function getQaNeededBoxVentCount(){
    return getQaVentMetrics().boxOnlyCount;
  }

  function updateQaVentCount(modal){
    const count = modal && modal.querySelector('[data-vent-count]');
    if (!count) return;
    const mode = qaPdfBaseSnapshot?.ventSettings?.mode || 'ridge';
    const metrics = getQaVentMetrics();
    if (mode === 'ridge') {
      const status = metrics.ridgeOk ? 'Ridge length sufficient' : 'Not enough ridge left, switch to box vents';
      count.innerHTML = `<span>Needed Ridge: <strong>${Math.ceil(metrics.ridgeNeededFt)}'</strong></span><span>Active Ridge: <strong>${Math.round(metrics.totalRidgeFt)}'</strong></span><span><strong>${status}</strong></span>`;
      return;
    }
    const needed = metrics.boxOnlyCount;
    const placed = Array.isArray(qaPdfBaseSnapshot?.ventSettings?.boxVents) ? qaPdfBaseSnapshot.ventSettings.boxVents.length : 0;
    const remaining = Math.max(0, needed - placed);
    count.innerHTML = `<span>Needed Box Vents: <strong>${needed}</strong></span><span>Placed: <strong>${placed}</strong></span><span>Remaining Needed: <strong>${remaining}</strong></span>`;
  }

  function renderQaVentDots(stage, modal){
    if (!stage || !qaPdfBaseSnapshot?.ventSettings) return;
    stage.querySelectorAll('.qa-pdf-boxvent:not(.ghost)').forEach((el) => el.remove());
    const vents = qaPdfBaseSnapshot.ventSettings.boxVents || [];
    const width = stage.clientWidth || 1;
    const height = stage.clientHeight || 1;
    vents.forEach((vent, idx) => {
      const dot = document.createElement('div');
      dot.className = 'qa-pdf-boxvent';
      dot.style.left = `${(Number(vent.nx) || 0.5) * width}px`;
      dot.style.top = `${(Number(vent.ny) || 0.5) * height}px`;
      dot.ondblclick = (ev) => {
        ev.stopPropagation();
        vents.splice(idx, 1);
        renderQaVentDots(stage, modal);
      };
      dot.onpointerdown = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        dot.setPointerCapture(ev.pointerId);
        const move = (mv) => {
          const r = stage.getBoundingClientRect();
          vent.nx = Math.max(0, Math.min(1, (mv.clientX - r.left) / r.width));
          vent.ny = Math.max(0, Math.min(1, (mv.clientY - r.top) / r.height));
          dot.style.left = `${vent.nx * (stage.clientWidth || width)}px`;
          dot.style.top = `${vent.ny * (stage.clientHeight || height)}px`;
        };
        const up = () => {
          dot.onpointermove = null;
          dot.onpointerup = null;
        };
        dot.onpointermove = move;
        dot.onpointerup = up;
      };
      stage.appendChild(dot);
    });
    updateQaVentCount(modal || stage.closest('.qa-pdf-vent-modal'));
  }

  function renderQaVentRidges(stage, modal){
    if (!stage || !qaPdfBaseSnapshot?.ventSettings) return;
    stage.querySelectorAll('.qa-pdf-vent-ridges').forEach((el) => el.remove());
    const report = qaPdfBaseSnapshot.report || {};
    const crop = qaPdfBaseSnapshot.cropRegion || {};
    const lines = Array.isArray(report.lines) ? report.lines : [];
    const excluded = Array.isArray(qaPdfBaseSnapshot.ventSettings.excludedRidges)
      ? qaPdfBaseSnapshot.ventSettings.excludedRidges
      : (qaPdfBaseSnapshot.ventSettings.excludedRidges = []);
    const width = stage.clientWidth || 1;
    const height = stage.clientHeight || 1;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('qa-pdf-vent-ridges');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    lines.forEach((line, idx) => {
      if (!line || line.type !== 'ridge' || !Array.isArray(line.points) || line.points.length < 2) return;
      const p1 = line.points[0];
      const p2 = line.points[1];
      const x1 = ((Number(p1.x) - Number(crop.minX || 0)) / Math.max(1, Number(crop.width || 1))) * width;
      const y1 = ((Number(p1.y) - Number(crop.minY || 0)) / Math.max(1, Number(crop.height || 1))) * height;
      const x2 = ((Number(p2.x) - Number(crop.minX || 0)) / Math.max(1, Number(crop.width || 1))) * width;
      const y2 = ((Number(p2.y) - Number(crop.minY || 0)) / Math.max(1, Number(crop.height || 1))) * height;
      const off = excluded.includes(idx);
      const lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      lineEl.classList.add('qa-pdf-vent-ridge-line');
      if (off) lineEl.classList.add('off');
      lineEl.setAttribute('x1', x1);
      lineEl.setAttribute('y1', y1);
      lineEl.setAttribute('x2', x2);
      lineEl.setAttribute('y2', y2);
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      hit.classList.add('qa-pdf-vent-ridge-hit');
      hit.setAttribute('x1', x1);
      hit.setAttribute('y1', y1);
      hit.setAttribute('x2', x2);
      hit.setAttribute('y2', y2);
      hit.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const current = qaPdfBaseSnapshot.ventSettings.excludedRidges || [];
        if (current.includes(idx)) {
          qaPdfBaseSnapshot.ventSettings.excludedRidges = current.filter((item) => item !== idx);
        } else {
          qaPdfBaseSnapshot.ventSettings.excludedRidges = current.concat(idx);
        }
        renderQaVentRidges(stage, modal);
      });
      svg.appendChild(lineEl);
      svg.appendChild(hit);
    });
    stage.appendChild(svg);
    updateQaVentCount(modal || stage.closest('.qa-pdf-vent-modal'));
  }

  function updateQaVentGhost(stage, ev){
    const ghost = stage && stage.querySelector('.qa-pdf-boxvent.ghost');
    if (!ghost) return;
    const r = stage.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
    const y = Math.max(0, Math.min(r.height, ev.clientY - r.top));
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
    ghost.style.display = 'block';
  }

  function renderQaVentOverlay(){
    const overlay = document.getElementById('qaPdfVentEditor');
    if (!overlay) return;
    overlay.innerHTML = '';
    overlay.className = 'qa-pdf-vent-editor';
    if (!qaPdfVentEditMode || getQaPdfPageKind() !== 'ventilation' || !qaPdfBaseSnapshot?.ventSettings) return;
    overlay.classList.add('modal', 'on');
    overlay.style.cssText = '';
    const modal = document.createElement('div');
    modal.className = 'qa-pdf-vent-modal';
    const mode = qaPdfBaseSnapshot.ventSettings?.mode || 'ridge';
    modal.innerHTML = `
      <div class="qa-pdf-vent-modal-head">
        <span>${mode === 'ridge' ? 'Ridge Vents' : 'Box Vents'}</span>
        <div class="qa-pdf-vent-count" data-vent-count></div>
        <button type="button" class="qa-pdf-tool active" data-vent-done>Done</button>
      </div>
      <div class="qa-pdf-vent-stage"><img alt="">${mode === 'box' ? '<div class="qa-pdf-boxvent ghost"></div>' : ''}</div>
    `;
    overlay.appendChild(modal);
    const stage = modal.querySelector('.qa-pdf-vent-stage');
    const img = stage.querySelector('img');
    img.onload = () => {
      if (mode === 'ridge') renderQaVentRidges(stage, modal);
      else renderQaVentDots(stage, modal);
    };
    buildQaVentEditorImageDataUrl()
      .then((dataUrl) => { img.src = dataUrl; })
      .catch(() => {
        const canvas = document.querySelector('#qaPdfMain canvas');
        if (canvas) img.src = getQaVentImageDataUrl(canvas);
      });
    updateQaVentCount(modal);
    modal.querySelector('[data-vent-done]').onclick = finishQaVentEdit;
    if (mode === 'box') {
      stage.onpointermove = (ev) => updateQaVentGhost(stage, ev);
      stage.onpointerenter = (ev) => updateQaVentGhost(stage, ev);
      stage.onpointerleave = () => {
        const ghost = stage.querySelector('.qa-pdf-boxvent.ghost');
        if (ghost) ghost.style.display = 'none';
      };
      stage.onclick = (ev) => {
        if (ev.target !== stage && ev.target !== img) return;
        const r = stage.getBoundingClientRect();
        const nx = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        const ny = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
        qaPdfBaseSnapshot.ventSettings.boxVents = qaPdfBaseSnapshot.ventSettings.boxVents || [];
        qaPdfBaseSnapshot.ventSettings.boxVents.push({ nx, ny });
        renderQaVentDots(stage, modal);
      };
    } else {
      stage.style.cursor = 'default';
    }
  }

  async function loadPdfFor(folderId, myInspectorSeq, hard){
    wireQaPdfControls();
    const myPdfSeq = ++pdfSeq;
    if (qaPdfObjectUrl) {
      try { URL.revokeObjectURL(qaPdfObjectUrl); } catch(e) {}
      qaPdfObjectUrl = null;
    }
    qaPdfDoc = null;
    qaPdfCurrentPage = 1;
    qaPdfBaseSnapshot = null;
    qaPdfPreviewSnapshot = null;
    qaPdfTopViewSettings = null;
    qaPdfPageConfig = {};
    qaPdfVentEditMode = false;
    setPdfHint('Loading...');
    const previewUrl = `${fmProjectPdfUrl(folderId, 'main')}&v=${Date.now()}`;
    qaPdfLastSourceUrl = previewUrl;
    try {
      initializeQaPdfConfigurator(getQaPdfState(), { renderDisabledPreview: false });
      if (qaPdfBaseSnapshot) {
        await renderQaPdfPreview({ persist: true });
      } else {
        console.warn('[PDF SYNC] No saved PDF snapshot was available; falling back to the stored report.');
        await loadQaPdfDocument(previewUrl, 1);
      }
      if (myInspectorSeq !== inspectorSeq || myPdfSeq !== pdfSeq) return;
    } catch (e) {
      if (myInspectorSeq !== inspectorSeq || myPdfSeq !== pdfSeq) return;
      console.error('[QA PDF] Failed to load PDF:', e);
      const main = document.getElementById('qaPdfMain');
      if (main) main.innerHTML = '<div class="qa-pdf-empty">No PDF preview is available.</div>';
      setPdfHint('No PDF');
    }
    return;
  }

  // ----------------- PROJECT DETAIL MODAL -----------------
  async function showProjectDetailModal(item){
    const existingOverlay = document.querySelector('.qa-detail-modal-overlay');
    if (existingOverlay) existingOverlay.remove();

    const overlay = document.createElement('div');
    overlay.className = 'qa-detail-modal-overlay';

    let manifest = null;
    try {
      const mf = await fmGetEditorBundle(item.id, 15000);
      manifest = mf?.manifest || null;
    } catch(e) {}

    const m = manifest || item;
    const address = m.address || item.address || 'Unknown';
    const status = m.status || item.status || '';
    const createdAt = m.created_at || item.created_at || '';
    const queuedAt = m.queued_at || '';
    const startedAt = m.started_at || item.started_at || '';
    const uploadedAt = m.uploaded_at || '';
    const completedAt = m.completed_at || item.completed_at || '';
    const drafter = getTechnicianLabel(item, m);
    const qaApprover = getQaApprovalMeta(item, m).display;
    const managerApprover = m.manager_approved_by_name || m.manager_approved_by || null;
    const isVip = !!(m.is_vip || item.is_vip);
    const isExpedited = !!(m.is_expedited || item.is_expedited);
    const isFiller = !!(m.is_filler || item.is_filler);

    const dtCreated = parseServerDate(createdAt);
    const dtStarted = parseServerDate(startedAt);
    const dtUploaded = parseServerDate(uploadedAt);
    const dtCompleted = parseServerDate(completedAt);

    const queueToStart = (dtCreated && dtStarted) ? (dtStarted.getTime() - dtCreated.getTime()) : null;
    const startToUpload = (dtStarted && dtUploaded) ? (dtUploaded.getTime() - dtStarted.getTime()) : null;
    const uploadToComplete = (dtUploaded && dtCompleted) ? (dtCompleted.getTime() - dtUploaded.getTime()) : null;
    const totalTime = (dtCreated && dtCompleted) ? (dtCompleted.getTime() - dtCreated.getTime()) : null;

    const workHistory = (m.work_history && Array.isArray(m.work_history)) ? m.work_history : [];
    const qaHistory = (m.qa_history && Array.isArray(m.qa_history)) ? m.qa_history : [];

    let timelineHtml = '';
    const eventIcons = {
      'claimed_new': { icon: 'fa-play', cls: 'blue' },
      'claimed_correction': { icon: 'fa-redo', cls: 'blue' },
      'submitted_for_qa': { icon: 'fa-upload', cls: 'blue' },
      'correction_submitted': { icon: 'fa-upload', cls: 'blue' },
      'qa_approved': { icon: 'fa-check', cls: 'green' },
      'qa_approved_pending_manager': { icon: 'fa-check', cls: 'green' },
      'qa_rejected': { icon: 'fa-times', cls: 'red' },
      'qa_sent_back_to_tech': { icon: 'fa-undo', cls: 'red' },
      'manager_approved': { icon: 'fa-check-double', cls: 'purple' },
      'manager_rejected': { icon: 'fa-undo', cls: 'red' },
      'manager_sent_back_to_tech': { icon: 'fa-undo', cls: 'red' },
      'qa_claimed': { icon: 'fa-user-check', cls: 'blue' },
      'qa_claim_released': { icon: 'fa-unlock', cls: 'gray' },
    };

    const allEvents = [];
    for (const ev of workHistory) {
      allEvents.push({ ts: ev.ts || '', event: ev.event || 'unknown', detail: ev });
    }
    for (const ev of qaHistory) {
      allEvents.push({ ts: ev.date || '', event: 'qa_' + (ev.status || 'review'), detail: ev });
    }
    allEvents.sort((a, b) => {
      const ta = parseServerDate(a.ts);
      const tb = parseServerDate(b.ts);
      if (!ta && !tb) return 0;
      if (!ta) return -1;
      if (!tb) return 1;
      return ta.getTime() - tb.getTime();
    });

    const seenKeys = new Set();
    const dedupedEvents = [];
    for (const ev of allEvents) {
      const key = ev.event + '_' + (ev.ts || '').substring(0, 16);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      dedupedEvents.push(ev);
    }

    for (const ev of dedupedEvents) {
      const iconInfo = eventIcons[ev.event] || { icon: 'fa-circle', cls: 'gray' };
      const eventLabel = (ev.event || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      let meta = fmtDate(ev.ts);
      if (!canSeeQaTechnicianIdentity()) ev.detail = {};
      if (ev.detail.worker_name || ev.detail.worker_email) meta += ` — ${esc(ev.detail.worker_name || ev.detail.worker_email)}`;
      if (ev.detail.qa_name || ev.detail.qa_email) meta += ` — ${esc(ev.detail.qa_name || ev.detail.qa_email)}`;
      if (ev.detail.manager_name || ev.detail.manager_email) meta += ` — ${esc(ev.detail.manager_name || ev.detail.manager_email)}`;
      if (ev.detail.inspector_name || ev.detail.inspector) meta += ` — ${esc(ev.detail.inspector_name || ev.detail.inspector)}`;

      timelineHtml += `
        <div class="timeline-item">
          <div class="tl-icon ${iconInfo.cls}"><i class="fas ${iconInfo.icon}"></i></div>
          <div class="tl-body">
            <div class="tl-title">${esc(eventLabel)}</div>
            <div class="tl-meta">${meta}</div>
          </div>
        </div>
      `;
    }

    if (!timelineHtml) {
      timelineHtml = '<div style="color:#999; font-size:12px; font-style:italic; padding:10px 0;">No history events recorded.</div>';
    }

    const modal = document.createElement('div');
    modal.className = 'qa-detail-modal';
    const identityDetailsHtml = canSeeQaTechnicianIdentity()
      ? `
            <div class="detail-item"><span class="dk">Drafter</span><span class="dv">${esc(drafter)}</span></div>
            <div class="detail-item"><span class="dk">QA Approved By</span><span class="dv">${esc(qaApprover)}</span></div>
            ${managerApprover ? `<div class="detail-item"><span class="dk">Manager Approved By</span><span class="dv">${esc(managerApprover)}</span></div>` : ''}
        `
      : '';
    modal.innerHTML = `
      <div class="modal-header">
        <h3>${esc(address)} ${isVip ? '<span style="color:#f9ab00;">⭐ VIP</span>' : ''} ${isFiller ? '<span style="color:#1a73e8; font-size:12px;">FILLER</span>' : ''}</h3>
        <div class="modal-close"><i class="fas fa-times"></i></div>
      </div>
      <div class="modal-body">
        <div class="detail-section">
          <div class="detail-label">Project Info</div>
          <div class="detail-grid">
            <div class="detail-item"><span class="dk">Status</span><span class="dv">${badgeForHistoryStatus(status)}</span></div>
            ${identityDetailsHtml}
            <div class="detail-item"><span class="dk">Created</span><span class="dv">${fmtDate(createdAt)}</span></div>
            <div class="detail-item"><span class="dk">Completed</span><span class="dv">${fmtDate(completedAt)}</span></div>
          </div>
        </div>
        <div class="detail-section">
          <div class="detail-label">Stage Durations</div>
          <div class="duration-bar">
            <div class="duration-chip"><i class="fas fa-hourglass-start" style="margin-right:4px;"></i> Queue → Start: ${formatDuration(queueToStart)}</div>
            <div class="duration-chip"><i class="fas fa-pencil-alt" style="margin-right:4px;"></i> Drafting: ${formatDuration(startToUpload)}</div>
            <div class="duration-chip"><i class="fas fa-clipboard-check" style="margin-right:4px;"></i> QA Review: ${formatDuration(uploadToComplete)}</div>
            <div class="duration-chip" style="background:#e8f0fe; color:#1a73e8;"><i class="fas fa-clock" style="margin-right:4px;"></i> Total: ${formatDuration(totalTime)}</div>
          </div>
        </div>
        <div class="detail-section">
          <div class="detail-label">Timeline</div>
          ${timelineHtml}
        </div>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const closeModal = () => overlay.remove();
    modal.querySelector('.modal-close').onclick = closeModal;
    overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
  }

  // ----------------- QUEUE API -----------------
  function setQueueLoadingState(active){
    const loading = !!active;
    const refresh = document.getElementById('qaRefreshBtn');
    if (refresh) {
      refresh.disabled = loading;
      refresh.innerHTML = loading
        ? '<i class="fas fa-spinner fa-spin"></i> Refreshing'
        : '<i class="fas fa-sync"></i> Refresh';
    }

    const workerPanel = document.getElementById('qaWorkerPanel');
    if (workerPanel) {
      const showWorkerView = !canManageQaQueue() && canDoQA();
      workerPanel.classList.toggle('loading', loading && showWorkerView);
      if (loading && showWorkerView) {
        workerPanel.classList.add('show');
        const nextEyebrowEl = document.getElementById('qaWorkerNextEyebrow');
        const nextAddrEl = document.getElementById('qaWorkerNextAddress');
        const nextNoteEl = document.getElementById('qaWorkerNextNote');
        const grabBtn = document.getElementById('qaGrabNextBtn');
        if (nextEyebrowEl) nextEyebrowEl.innerHTML = '<span class="qa-loading-inline"><i class="fas fa-spinner fa-spin"></i> Loading queue</span>';
        if (nextAddrEl && !pendingList.length && !managerList.length) nextAddrEl.textContent = 'Checking for available QA projects...';
        if (nextNoteEl) nextNoteEl.textContent = 'The pipeline is refreshing. Existing queue data will stay visible when available.';
        if (grabBtn) {
          grabBtn.disabled = true;
          grabBtn.classList.add('disabled');
          grabBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading';
        }
      }
    }
  }

  function setQueueLoadError(message){
    const box = document.getElementById('qaLoadError');
    const text = document.getElementById('qaLoadErrorText');
    if (!box) return;
    const msg = String(message || '').trim();
    const hasExistingQueue = pendingList.length || historyList.length || managerList.length || managerHistoryList.length;
    const suffix = hasExistingQueue
      ? 'Showing the last loaded queue.'
      : 'Use Refresh to try again.';
    if (text) {
      text.textContent = msg
        ? `${msg} ${suffix}`
        : `The QA queue could not refresh. ${suffix}`;
    }
    box.classList.add('show');
  }

  function clearQueueLoadError(){
    const box = document.getElementById('qaLoadError');
    if (box) box.classList.remove('show');
  }

  function normalizeQaSnapshotList(value, label){
    if (!Array.isArray(value)) return [];
    const out = [];
    value.forEach((item, idx) => {
      if (!item || typeof item !== 'object') {
        console.warn(`[QA] Ignoring malformed ${label || 'queue'} item at index ${idx}:`, item);
        return;
      }
      out.push(item);
    });
    return out;
  }

  function safeRenderQueue(pending, history){
    try {
      renderQueue(pending, history);
      return true;
    } catch (e) {
      console.error('[QA] Queue render failed:', e, {
        pending_count: Array.isArray(pending) ? pending.length : null,
        history_count: Array.isArray(history) ? history.length : null,
        manager_count: Array.isArray(managerList) ? managerList.length : null,
        manager_history_count: Array.isArray(managerHistoryList) ? managerHistoryList.length : null
      });
      setQueueLoadError('The QA queue data loaded, but the list could not render.');
      return false;
    }
  }

  async function loadQueue(){
    const mySeq = ++queueSeq;
    const qBody = document.getElementById('qaQueueBody');
    const pendingColspan = canSeeQaTechnicianIdentity() ? 8 : 7;
    setQueueLoadingState(true);
    if (qBody && !qBody.querySelector('tr')) {
      qBody.innerHTML = `<tr><td colspan="${pendingColspan}" style="text-align:center; padding:20px; color:#999;"><i class="fas fa-spinner fa-spin"></i> Loading…</td></tr>`;
    }
    let data = null;
    try {
      data = await fetchQaSnapshotFromNode();
    } catch(e){
      if (mySeq !== queueSeq) return;
      if (!inQAView) return;
      setQueueLoadingState(false);
      const message = e && e.message ? e.message : 'Failed to load QA queue.';
      console.warn('[QA] Queue refresh failed:', e);
      setQueueLoadError(message);
      safeRenderQueue(pendingList, historyList);
      return;
    }

    if (mySeq !== queueSeq) return;
    if (!inQAView) return;
    if (!data || data.error || data.success === false) {
      setQueueLoadingState(false);
      const message = data?.error || data?.message || 'Failed to load QA queue.';
      console.warn('[QA] Queue refresh failed:', data || message);
      setQueueLoadError(message);
      safeRenderQueue(pendingList, historyList);
      return;
    }

    pendingList = normalizeQaSnapshotList(data.pending, 'pending');
    historyList = normalizeQaSnapshotList(data.history, 'history');
    managerList = normalizeQaSnapshotList(data.manager, 'manager');
    managerHistoryList = normalizeQaSnapshotList(data.manager_history, 'manager_history');
    const pendingPagination = data.pending_pagination && typeof data.pending_pagination === 'object'
      ? data.pending_pagination
      : {};
    qaPendingPage = Math.max(1, Number.parseInt(pendingPagination.page || qaPendingPage, 10) || 1);
    qaPendingPageSize = [25, 50, 100, 200].includes(Number.parseInt(pendingPagination.per_page, 10))
      ? Number.parseInt(pendingPagination.per_page, 10)
      : qaPendingPageSize;
    qaPendingTotalCount = Math.max(0, Number.parseInt(pendingPagination.total_count || pendingList.length, 10) || 0);
    qaPendingTotalPages = Math.max(1, Number.parseInt(pendingPagination.total_pages || 1, 10) || 1);
    const historyPagination = data.history_pagination && typeof data.history_pagination === 'object'
      ? data.history_pagination
      : {};
    qaHistoryPage = Math.max(1, Number.parseInt(historyPagination.page || qaHistoryPage, 10) || 1);
    qaHistoryPageSize = [10, 25, 50, 100].includes(Number.parseInt(historyPagination.per_page, 10))
      ? Number.parseInt(historyPagination.per_page, 10)
      : qaHistoryPageSize;
    qaHistoryTotalCount = Math.max(0, Number.parseInt(historyPagination.total_count || historyList.length, 10) || 0);
    qaHistoryTotalPages = Math.max(1, Number.parseInt(historyPagination.total_pages || 1, 10) || 1);
    qaQueueStats = (data && typeof data.stats === 'object' && data.stats) ? data.stats : {};
    if (canDoQA()) {
      try {
        const bootstrapDaily = qaQueueStats.qa_leaderboard_today;
        if (bootstrapDaily?.date === qaLeaderboardDate && Array.isArray(bootstrapDaily?.leaderboard)) {
          const team = qaTeamPayload();
          qaLeaderboardDailyCache.set(`${team.team || 'all'}:${qaLeaderboardDate}`, bootstrapDaily);
          qaQueueStats.qa_leaderboard_selected = bootstrapDaily;
        } else {
          qaQueueStats.qa_leaderboard_selected = await fetchQaLeaderboardDay(qaLeaderboardDate, false);
        }
        if (qaLeaderboardRange === 'week') {
          qaQueueStats.qa_leaderboard_week = await buildQaWeeklyLeaderboard(false);
        }
      } catch(e) {
        qaQueueStats.qa_leaderboard_selected = { success: false, leaderboard: [], date: qaLeaderboardDate };
        if (qaLeaderboardRange === 'week') qaQueueStats.qa_leaderboard_week = { success: false, leaderboard: [] };
      }
    }

    setQueueLoadingState(false);
    clearQueueLoadError();
    if (!safeRenderQueue(pendingList, historyList)) return;

    if (currentId && !isManagerReviewMode && !pendingList.some(x => x.id === currentId)) {
      try {
        await ensureQaClaimForCurrentProject();
        console.info(`[QA] Kept the active project ${currentId} open after it was omitted from one queue refresh.`);
        updateNavButtons();
      } catch (claimError) {
        console.warn('[QA] The active project is no longer claimable; returning to the queue.', claimError);
        await closeInspectorToList({ releaseClaims: false, reason: 'active_claim_unavailable' });
      }
    } else if (currentId && isManagerReviewMode && !managerList.some(x => x.id === currentId)) {
      closeInspectorToList();
    } else {
      updateNavButtons();
    }
  }

  function updateQaPendingPager(){
    const header = document.getElementById('qaPendingPaginationHeader');
    const canPagePending = canManageQaQueue();
    if (header) header.style.display = canPagePending ? '' : 'none';
    const size = document.getElementById('qaPendingPageSize');
    if (size) size.value = String(qaPendingPageSize);
    const summary = document.getElementById('qaPendingPageSummary');
    if (summary) {
      summary.textContent = `Page ${qaPendingPage} of ${qaPendingTotalPages} · ${qaPendingTotalCount}`;
    }
    const prev = document.getElementById('qaPendingPrevBtn');
    const next = document.getElementById('qaPendingNextBtn');
    if (prev) prev.disabled = qaPendingPage <= 1;
    if (next) next.disabled = qaPendingPage >= qaPendingTotalPages;
  }

  function updateQaHistoryPager(){
    const controls = document.getElementById('qaHistoryControls');
    const canPageHistory = canManageQaQueue() || canManagerReview();
    if (controls) controls.style.display = canPageHistory ? '' : 'none';
    const size = document.getElementById('qaHistoryPageSize');
    if (size) size.value = String(qaHistoryPageSize);
    const summary = document.getElementById('qaHistoryPageSummary');
    if (summary) {
      summary.textContent = `Page ${qaHistoryPage} of ${qaHistoryTotalPages} · ${qaHistoryTotalCount}`;
    }
    const prev = document.getElementById('qaHistoryPrevBtn');
    const next = document.getElementById('qaHistoryNextBtn');
    if (prev) prev.disabled = qaHistoryPage <= 1;
    if (next) next.disabled = qaHistoryPage >= qaHistoryTotalPages;
  }

  function renderQueue(pending, history){
    const qBody = document.getElementById('qaQueueBody');
    const hBody = document.getElementById('qaHistoryBody');
    const cP = document.getElementById('qaCountPending');
    const cH = document.getElementById('qaCountHistory');
    const cM = document.getElementById('qaCountManager');
    const statPending = document.getElementById('qaStatPending');
    const statManager = document.getElementById('qaStatManager');
    const statHistory = document.getElementById('qaStatHistory');
    const cPLabel = document.getElementById('qaCountPendingLabel');
    const cHLabel = document.getElementById('qaCountHistoryLabel');
    const cMLabel = document.getElementById('qaCountManagerLabel');
    
    const currentUserEmail = (cfg().user?.email || '').toLowerCase();
    const showQueueManagerView = canManageQaQueue();
    const showWorkerView = !showQueueManagerView && canDoQA();
    const showTechnicianIdentity = canSeeQaTechnicianIdentity();
    const pendingColspan = showTechnicianIdentity ? 8 : 7;
    
    let displayPending = pending;
    if (!showFillers) {
      displayPending = pending.filter(x => !x.is_filler || !!x.qa_priority);
    }
    if (!showQueueManagerView) {
      displayPending = sortItems(displayPending, sortColumn, sortDirection);
    }

    const claimedByMe = displayPending.filter(item => {
      const claimedBy = (item.qa_claimed_by_email || '').toLowerCase();
      return claimedBy === currentUserEmail;
    });
    const unclaimedOrOthers = displayPending.filter(item => {
      const claimedBy = (item.qa_claimed_by_email || '').toLowerCase();
      return claimedBy !== currentUserEmail;
    });

    let todayHistory = history.filter(item => {
      const d = item.completed_at || item.date || '';
      return isToday(d) && item.status === 'completed';
    });

    for (const mgrItem of managerHistoryList) {
      const d = mgrItem.completed_at || '';
      if (isToday(d)) {
        if (!todayHistory.some(h => h.id === mgrItem.id)) {
          todayHistory.push({
            id: mgrItem.id,
            address: mgrItem.address || '',
            date: mgrItem.completed_at || '',
            completed_at: mgrItem.completed_at || '',
            status: 'completed',
            is_vip: mgrItem.is_vip || false,
            is_filler: mgrItem.is_filler || false,
            assigned_to_name: mgrItem.assigned_to_name || null,
            assigned_to_email: mgrItem.assigned_to_email || null,
          });
        }
      }
    }

    todayHistory.sort((a, b) => {
      const ta = parseServerDate(a.completed_at || a.date || '');
      const tb = parseServerDate(b.completed_at || b.date || '');
      return (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0);
    });

    if (cH) cH.textContent = String(showQueueManagerView ? qaHistoryTotalCount : todayHistory.length);
    if (cM) cM.textContent = String(managerList.length);
    updateQaPendingPager();
    updateQaHistoryPager();
    if (showWorkerView) {
      const claimedCount = Number(qaQueueStats.claimed_count || claimedByMe.length || 0);
      const queueEmpty = displayPending.length < 1;
      if (statPending) statPending.style.display = '';
      if (statHistory) statHistory.style.display = '';
      if (statManager) statManager.style.display = queueEmpty ? '' : 'none';
      if (cP) cP.textContent = String(claimedCount);
      if (cPLabel) cPLabel.textContent = 'Claimed';
      if (cHLabel) cHLabel.textContent = 'Today';
      if (cM) cM.textContent = queueEmpty ? 'Yes' : '0';
      if (cMLabel) cMLabel.textContent = 'Queue Empty';
    } else {
      if (statPending) statPending.style.display = '';
      if (statHistory) statHistory.style.display = '';
      if (statManager) statManager.style.display = '';
      if (cP) {
        cP.textContent = displayPending.length !== pending.length
          ? `${displayPending.length} / ${qaPendingTotalCount}`
          : String(qaPendingTotalCount);
      }
      if (cPLabel) cPLabel.textContent = 'Pending';
      if (cHLabel) cHLabel.textContent = 'Today';
      if (cMLabel) cMLabel.textContent = 'Mgr Review';
    }

    updateSortHeaders();

    const sw = document.getElementById('qaFillerSwitch');
    if (sw) { sw.classList.toggle('on', showFillers); }
    const fillerToggle = document.getElementById('qaFillerToggle');
    if (fillerToggle) fillerToggle.style.display = showQueueManagerView ? '' : 'none';
    const sortHint = document.getElementById('qaSortHint');
    if (sortHint && showWorkerView) sortHint.textContent = 'Queue priority is handled automatically';
    const rateStrip = document.getElementById('qaRateStrip');
    if (rateStrip) {
      const selectedDaily = qaQueueStats.qa_leaderboard_selected || qaQueueStats.qa_leaderboard_today || {};
      const rates = Array.isArray(selectedDaily.leaderboard) ? selectedDaily.leaderboard : [];
      if (showQueueManagerView && canSeeQaTechnicianIdentity()) {
        rateStrip.style.display = 'grid';
        const values = rates.length ? rates.map((row) => {
          const label = row.name || row.email || 'QA';
          const points = formatQaCompletedPoints(row.points);
          const shiftMeta = qaShiftRangeLabel(row);
          return `<span class="qa-rate-chip" title="${esc(shiftMeta)}"><span class="qa-rate-name" title="${esc(label)}">${esc(label)}</span><b>${points} pts</b><small>${esc(shiftMeta)}</small></span>`;
        }).join('') : '<span class="qa-rate-chip"><span class="qa-rate-name">No QA shift points</span><b>0 pts</b></span>';
        rateStrip.innerHTML = `
          <div class="qa-rate-strip-head"><span>QA shift points · ${esc(qaShiftDateLabel(qaLeaderboardDate))} Pacific</span>${qaShiftDateControlsHtml()}</div>
          <div class="qa-rate-strip-values">${values}</div>`;
        wireQaShiftDateControls(rateStrip);
      } else {
        rateStrip.style.display = 'none';
        rateStrip.innerHTML = '';
      }
    }
    const workerPanel = document.getElementById('qaWorkerPanel');
    if (workerPanel) workerPanel.classList.toggle('show', showWorkerView);
    const pendingTable = document.getElementById('qaPendingTable');
    if (pendingTable) pendingTable.style.display = showQueueManagerView ? '' : 'none';
    
    const fillerPill = (isFiller) => isFiller
      ? ` <span class="qa-badge filler" title="Filler job"><i class="fas fa-circle"></i> Filler</span>`
      : '';

    const vipPill = (isVip) => isVip
      ? ` <span class="qa-badge" style="background:#fff8e1;color:#7a4b00;border:1px solid #f9ab00;" title="VIP project"><i class="fas fa-star" style="color:#f9ab00;"></i> VIP</span>`
      : '';
    const expeditedPill = (isExpedited) => isExpedited
      ? ` <span class="qa-badge" style="background:#ecfdf5;color:#0f766e;border:1px solid #0f766e;" title="Expedited project"><i class="fas fa-bolt"></i> Expedited</span>`
      : '';
    const priorityPill = (item) => !!item.qa_priority
      ? ` <span class="qa-badge" style="background:#fff3cd;color:#7a4b00;border:1px solid #f9ab00;" title="This project is manually prioritized above the standard QA order"><i class="fas fa-thumbtack"></i> Prioritized</span>`
      : '';

    const formatScorePart = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return '—';
      return n % 1 === 0 ? String(n) : n.toFixed(1);
    };

    const qaScorePill = (item) => {
      const rank = item.qa_rank || {};
      const total = Number(item.qa_error_score ?? item.qa_priority_rank_score ?? rank.error_score);
      if (!Number.isFinite(total)) {
        return `
          <span class="qa-score-wrap">
            <span class="qa-score-pill unavailable" tabindex="0" aria-label="QA score unavailable">—</span>
          </span>
        `;
      }
      if (!canSeeQaTechnicianIdentity()) {
        const pillClass = total >= 22 ? 'high' : (total >= 15 ? 'medium' : 'low');
        return `
          <span class="qa-score-wrap">
            <span class="qa-score-pill ${pillClass}" tabindex="0" aria-label="QA score uses blind queue weighting">${esc(formatScorePart(total))}</span>
            <span class="qa-score-tooltip" role="tooltip">
              <div class="score-head"><span>QA Score</span><b>${esc(formatScorePart(total))}</b></div>
              <div class="score-note">This score is shown without technician details for blind review.</div>
            </span>
          </span>
        `;
      }
      const projectPoints = item.project_points ?? rank.project_points;
      const drafterRank = String(item.drafter_rank ?? rank.drafter_rank ?? 'junior').toLowerCase();
      const drafterPoints = item.drafter_rank_points ?? rank.drafter_rank_points;
      const heightPoints = item.height_quality_points ?? rank.height_quality_points;
      const heightSource = String(item.height_quality_source ?? rank.height_quality_source ?? '').toLowerCase();
      const heightRaw = item.height_quality_raw ?? rank.height_quality_raw;
      const heightIsDefault = heightSource === 'default' || (!heightSource && Number(heightPoints) === 5);
      const heightLabel = heightIsDefault ? 'Solar imagery quality (default)' : 'Solar imagery quality';
      const heightRawLabel = heightRaw === null || typeof heightRaw === 'undefined' || heightRaw === '' ? '-' : String(heightRaw);
      const heightNote = heightIsDefault
        ? 'No Google Solar imageryQuality field was found, so this uses the neutral +5 fallback.'
        : `Google Solar imageryQuality: ${heightRawLabel}`;
      const pillClass = total >= 22 ? 'high' : (total >= 15 ? 'medium' : 'low');
      const breakdownLabel = `QA score ${formatScorePart(total)}. Project ${formatScorePart(projectPoints)}, drafter ${formatScorePart(drafterPoints)}, height map ${formatScorePart(heightPoints)}.`;
      return `
        <span class="qa-score-wrap">
          <span class="qa-score-pill ${pillClass}" tabindex="0" aria-label="${esc(breakdownLabel)}">${esc(formatScorePart(total))}</span>
          <span class="qa-score-tooltip" role="tooltip">
            <div class="score-head"><span>QA Score</span><b>${esc(formatScorePart(total))}</b></div>
            <div class="score-line"><span class="k">Project complexity</span><span class="v">+${esc(formatScorePart(projectPoints))}</span></div>
            <div class="score-line"><span class="k">Drafter rank (${esc(drafterRank)})</span><span class="v">+${esc(formatScorePart(drafterPoints))}</span></div>
            <div class="score-line"><span class="k">${esc(heightLabel)}</span><span class="v">+${esc(formatScorePart(heightPoints))}</span></div>
            <div class="score-note">${esc(heightNote)}</div>
          </span>
        </span>
      `;
    };
    
    const getClaimStatus = (item) => {
      const claimedBy = (item.qa_claimed_by_email || '').toLowerCase();
      const claimedByName = item.qa_claimed_by_name || item.qa_claimed_by_email || 'Someone';
      const publicClaimedByName = displayQaActorName(claimedByName, 'Another QA reviewer');
      
      if (!claimedBy) {
        return { type: 'available', rowClass: '', canReview: canDoQA(),
          indicator: `<span class="qa-claim-indicator available" title="Available to claim"><i class="fas fa-unlock"></i> Available</span>`,
          buttonClass: 'primary', buttonText: canDoQA() ? '<i class="fas fa-arrow-right"></i> Review' : '<i class="fas fa-eye"></i> Queue Only' };
      }
      
      if (claimedBy === currentUserEmail) {
        return { type: 'yours', rowClass: 'claimed-by-self', canReview: canDoQA(),
          indicator: `<span class="qa-claim-indicator yours" title="You are reviewing this"><i class="fas fa-user-check"></i> Yours</span>`,
          buttonClass: 'secondary', buttonText: '<i class="fas fa-arrow-right"></i> Continue' };
      }
      
      // Claim ownership is authoritative. Availability hints can be stale on
      // legacy records, but a project with an owner must never render as
      // capturable. Managers will receive the force-release action below.
      return { type: 'locked', rowClass: 'claimed-by-other', canReview: false,
        indicator: `<span class="qa-claim-indicator locked" title="Being reviewed by ${esc(publicClaimedByName)}"><i class="fas fa-lock"></i> ${esc(publicClaimedByName)}</span>`,
        buttonClass: 'disabled-claim', buttonText: '<i class="fas fa-lock"></i> In Review' };
    };

    const releaseClaim = async (item, force = false) => {
      const result = await fmPost(`projects/${encodeURIComponent(item.id)}/qa/release-claim`, {
        reason: force ? 'manager_force_release' : 'manual',
        force: !!force
      }, 15000);
      if (result && result.success === false) {
        throw new Error(result.message || result.error || 'Failed to release QA claim');
      }
      if (currentId === item.id) closeInspectorToList();
      await loadQueue();
    };

    const prioritizeProject = async (folderId) => {
      await fmPost(`projects/${encodeURIComponent(folderId)}/qa/priority`, {
        prioritized: true
      }, 15000);
      await loadQueue();
    };

    const renderPendingRow = (item, tbody) => {
      const tr = document.createElement('tr');
      const drafter = getTechnicianLabel(item);
      const isFiller = !!item.is_filler;
      const isVip = !!item.is_vip;
      const isExpedited = !!item.is_expedited;
      const claim = getClaimStatus(item);
      const itemStatus = item.status || 'awaiting_review';
      const requestedBy = getRequestedByMeta(item).display;
      const createdAt = item.created_at || '';
      const enteredQA = item.uploaded_at || item.date || '';
      const canReviewThis = claim.canReview && canDoQA();
      const claimedBy = String(item.qa_claimed_by_email || '').trim().toLowerCase();
      const canForceRelease = canManagerReview()
        && claimedBy
        && claimedBy !== currentUserEmail;
      
      if (claim.rowClass) { tr.className = claim.rowClass; }
      if (item.qa_priority) tr.classList.add('qa-row-priority');
      if (item.id === currentId) tr.classList.add('qa-selected');
      tr.innerHTML = `
        <td class="addr-cell">
          <strong>${esc(item.address || '')}</strong>
          ${vipPill(isVip)}
          ${expeditedPill(isExpedited)}
          ${fillerPill(isFiller)}
          ${priorityPill(item)}
          ${customerReworkPill(item)}
          ${claim.indicator}
        </td>
        <td class="nowrap">${esc(requestedBy)}</td>
        <td class="nowrap muted" title="${esc(fmtDate(createdAt))}">${esc(fmtDateShort(createdAt))}</td>
        <td class="nowrap muted" title="${esc(fmtDate(enteredQA))}">${esc(fmtDateShort(enteredQA))}</td>
        ${showTechnicianIdentity ? `<td class="nowrap">${esc(drafter)}</td>` : ''}
        <td class="nowrap qa-score-cell">${qaScorePill(item)}</td>
        <td>${badgeForStatus(itemStatus)}</td>
        <td style="text-align:right;">
          <div class="qa-priority-actions">
            ${showQueueManagerView ? `<button class="qa-btn sm ghost qa-toggle-priority" title="${item.qa_priority ? 'Remove manual priority' : 'Mark as prioritized'}"><i class="fas ${item.qa_priority ? 'fa-times' : 'fa-thumbtack'}"></i> ${item.qa_priority ? 'Unprioritize' : 'Prioritize'}</button>` : ''}
            ${canForceRelease
              ? '<button class="qa-btn sm danger qa-force-release" title="Release this claim and return the project to the QA queue"><i class="fas fa-unlock"></i> Release</button>'
              : `<button class="qa-btn sm qa-row-action ${claim.buttonClass}" ${canReviewThis ? '' : 'disabled'}>${claim.buttonText}</button>`}
          </div>
        </td>
      `;
      
      const rowActionBtn = tr.querySelector('.qa-row-action');
      if (canReviewThis && rowActionBtn) {
        rowActionBtn.onclick = () => openInspector(item.id);
      }
      const togglePriorityBtn = tr.querySelector('.qa-toggle-priority');
      if (togglePriorityBtn) {
        togglePriorityBtn.onclick = async (e) => {
          e.stopPropagation();
          try {
            await fmPost(`projects/${encodeURIComponent(item.id)}/qa/priority`, {
              prioritized: !item.qa_priority
            }, 15000);
            await loadQueue();
          } catch (err) {
            alert('Failed to update priority: ' + (err.message || 'Unknown error'));
          }
        };
      }
      const forceReleaseBtn = tr.querySelector('.qa-force-release');
      if (forceReleaseBtn) {
        forceReleaseBtn.onclick = async (e) => {
          e.stopPropagation();
          const claimedByName = item.qa_claimed_by_name || item.qa_claimed_by_email || 'the current QA reviewer';
          const ok = await qaConfirm({
            title: 'Release QA claim?',
            message: `Release "${item.address || 'this project'}" from ${claimedByName} and return it to the QA queue? Their open review will no longer be able to submit a decision.`,
            confirmHtml: '<i class="fas fa-unlock"></i> Release'
          });
          if (!ok) return;
          forceReleaseBtn.disabled = true;
          forceReleaseBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Releasing';
          try {
            await releaseClaim(item, true);
          } catch (err) {
            alert('Failed to release: ' + (err.message || 'Unknown error'));
            forceReleaseBtn.disabled = false;
            forceReleaseBtn.innerHTML = '<i class="fas fa-unlock"></i> Release';
          }
        };
      }
      
      tbody.appendChild(tr);
    };

    const claimedSection = document.getElementById('qaClaimedSection');
    const claimedBody = document.getElementById('qaClaimedBody');
    const claimedCount = document.getElementById('qaClaimedCount');

    if (claimedSection && claimedBody) {
      if (showQueueManagerView && claimedByMe.length > 0) {
        claimedSection.style.display = '';
        if (claimedCount) claimedCount.textContent = String(claimedByMe.length);
        claimedBody.innerHTML = '';
        claimedByMe.forEach(item => {
          const tr = document.createElement('tr');
          tr.className = 'claimed-by-self';
          if (item.id === currentId) tr.classList.add('qa-selected');
          const drafter = getTechnicianLabel(item);
          const itemStatus = item.status || 'awaiting_review';
          const requestedBy = getRequestedByMeta(item).display;
          const createdAt = item.created_at || '';
          const enteredQA = item.uploaded_at || item.date || '';
          tr.innerHTML = `
            <td class="addr-cell">
              <strong>${esc(item.address || '')}</strong>
              ${vipPill(!!item.is_vip)}
              ${expeditedPill(!!item.is_expedited)}
              ${fillerPill(!!item.is_filler)}
              ${customerReworkPill(item)}
            </td>
            <td class="nowrap">${esc(requestedBy)}</td>
            <td class="nowrap muted" title="${esc(fmtDate(createdAt))}">${esc(fmtDateShort(createdAt))}</td>
            <td class="nowrap muted" title="${esc(fmtDate(enteredQA))}">${esc(fmtDateShort(enteredQA))}</td>
            ${showTechnicianIdentity ? `<td class="nowrap">${esc(drafter)}</td>` : ''}
            <td>${badgeForStatus(itemStatus)}</td>
            <td style="text-align:right; white-space:nowrap;">
              <button class="qa-btn sm secondary qa-claimed-continue"><i class="fas fa-arrow-right"></i> Continue</button>
              <button class="qa-btn sm ghost qa-claimed-release" title="Release back to queue" style="margin-left:4px;"><i class="fas fa-unlock"></i></button>
            </td>
          `;
          tr.querySelector('.qa-claimed-continue').onclick = () => openInspector(item.id);
          tr.querySelector('.qa-claimed-release').onclick = async (e) => {
            e.stopPropagation();
            const ok = await qaConfirm({
              title: 'Release claim?',
              message: `Release "${item.address || 'this item'}" back to the queue?`,
              confirmHtml: '<i class="fas fa-unlock"></i> Release'
            });
            if (!ok) return;
          const btn = tr.querySelector('.qa-claimed-release');
          btn.disabled = true;
          btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
          try {
              await releaseClaim(item);
            } catch (err) {
              alert('Failed to release: ' + (err.message || 'Unknown error'));
              btn.disabled = false;
              btn.innerHTML = '<i class="fas fa-unlock"></i>';
            }
          };
          claimedBody.appendChild(tr);
        });
      } else {
        claimedSection.style.display = 'none';
      }
    }

    if (qBody && showQueueManagerView) {
      qBody.innerHTML = '';
      if (!unclaimedOrOthers.length) {
        const msg = claimedByMe.length > 0
          ? 'No other items in the queue. Your claimed items are shown above.'
          : (!showFillers && pending.length > 0 ? 'All pending items are fillers. Toggle "Show Fillers" to see them.' : 'No jobs pending review.');
        qBody.innerHTML = `<tr><td colspan="${pendingColspan}" style="text-align:center; padding:20px; color:#999;">${msg}</td></tr>`;
      } else {
        unclaimedOrOthers.forEach(item => renderPendingRow(item, qBody));
      }
    }

    if (workerPanel && showWorkerView) {
      const grabBtn = document.getElementById('qaGrabNextBtn');
      const claimedEl = document.getElementById('qaWorkerClaimedCount');
      const reviewedTodayEl = document.getElementById('qaWorkerReviewedToday');
      const nextAddrEl = document.getElementById('qaWorkerNextAddress');
      const nextNoteEl = document.getElementById('qaWorkerNextNote');
      const nextEyebrowEl = document.getElementById('qaWorkerNextEyebrow');
      const claimedCount = Number(qaQueueStats.claimed_count || claimedByMe.length || 0);
      const nextCandidateId = String(qaQueueStats.next_candidate_id || '').trim();
      const hasVisiblePending = displayPending.length > 0;
      const canGrabNext = claimedCount > 0 || !!nextCandidateId || hasVisiblePending;
      const queueEmpty = !canGrabNext;
      if (claimedEl) claimedEl.textContent = String(claimedCount);
      if (reviewedTodayEl) reviewedTodayEl.textContent = String(qaQueueStats.reviewed_today_count || 0);
      if (nextAddrEl) nextAddrEl.textContent = queueEmpty
        ? 'No QA projects are available right now.'
        : 'Projects are assigned automatically.';
      if (nextEyebrowEl) {
        nextEyebrowEl.textContent = queueEmpty ? 'Queue Empty' : 'Ready';
      }
      if (grabBtn) {
        grabBtn.disabled = !canGrabNext;
        grabBtn.classList.toggle('disabled', !canGrabNext);
        grabBtn.setAttribute('aria-disabled', canGrabNext ? 'false' : 'true');
        grabBtn.innerHTML = claimedCount
          ? '<i class="fas fa-arrow-right"></i> Continue Current'
          : (canGrabNext ? '<i class="fas fa-bolt"></i> Grab Next' : '<i class="fas fa-ban"></i> No Projects');
      }
      if (nextNoteEl) {
        nextNoteEl.textContent = queueEmpty
          ? 'Check back in a moment or refresh to try again.'
          : 'Use the button above to grab the next project or continue the one you already claimed.';
      }
      const leaderboardEl = document.getElementById('qaWorkerLeaderboard');
      if (leaderboardEl) {
        const isWeek = qaLeaderboardRange === 'week';
        const payload = isWeek ? (qaQueueStats.qa_leaderboard_week || {}) : (qaQueueStats.qa_leaderboard_selected || qaQueueStats.qa_leaderboard_today || {});
        const rows = Array.isArray(payload.leaderboard) ? payload.leaderboard : [];
        const me = String(cfg().user?.email || '').toLowerCase().trim();
        const renderRow = (row, idx) => {
          const rank = Number(row.rank || idx + 1);
          const email = String(row.email || '').toLowerCase().trim();
          const isMe = email && email === me;
          const topClass = rank <= 3 ? ` rank-${rank}` : '';
          const icon = rank === 1 ? '<i class="fas fa-crown"></i>' : (rank === 2 ? '<i class="fas fa-medal"></i>' : (rank === 3 ? '<i class="fas fa-award"></i>' : String(rank)));
          const name = row.name || row.email || 'QA';
          const points = formatQaCompletedPoints(row.points);
          const pointsPerHour = Number(row.points_per_hour || 0);
          return `
            <div class="qa-leaderboard-row${topClass}${isMe ? ' me' : ''}">
              <span class="qa-leaderboard-rank">${icon}</span>
              <div style="min-width:0;">
                <div class="qa-leaderboard-name" title="${esc(name)}">${esc(name)}${isMe ? '<span class="qa-leaderboard-you">You</span>' : ''}</div>
                <div class="qa-leaderboard-meta">${isWeek ? `${pointsPerHour.toFixed(2)} pts/hr · ${Number(row.shift_count || 0)} shifts` : esc(qaShiftRangeLabel(row))}</div>
              </div>
              <div class="qa-leaderboard-count">${points} pts completed</div>
            </div>
          `;
        };
        const columnSize = 10;
        const columns = [];
        for (let i = 0; i < rows.length; i += columnSize) {
          columns.push(rows.slice(i, i + columnSize));
        }
        const columnCount = Math.max(1, columns.length);
        const html = columns.map((column, columnIdx) => `
          <div class="qa-leaderboard-col">
            ${column.map((row, rowIdx) => renderRow(row, columnIdx * columnSize + rowIdx)).join('')}
          </div>
        `).join('');
        leaderboardEl.classList.add('show');
        leaderboardEl.innerHTML = `
          <div class="qa-leaderboard-head">
            <div class="qa-leaderboard-title"><i class="fas fa-trophy" style="color:#d97706;"></i> QA Leaderboard</div>
            <div class="qa-leaderboard-actions">
              ${qaShiftDateControlsHtml()}
              <div class="qa-leaderboard-range" aria-label="QA leaderboard range">
                <button type="button" class="${!isWeek ? 'active' : ''}" data-qa-leaderboard-range="day">Daily</button>
                <button type="button" class="${isWeek ? 'active' : ''}" data-qa-leaderboard-range="week">Weekly</button>
              </div>
              <div class="qa-leaderboard-sub">${isWeek ? 'Week containing' : 'Shift start date'} ${esc(qaShiftDateLabel(qaLeaderboardDate))} Pacific</div>
            </div>
          </div>
          ${html ? `<div class="qa-leaderboard-grid" style="grid-template-columns:repeat(${columnCount},minmax(0,1fr));">${html}</div>` : `<div style="padding:14px;color:#777;font-size:12px;font-weight:850;text-align:center;">No QA shift points for ${isWeek ? 'this week' : qaShiftDateLabel(qaLeaderboardDate)}.</div>`}
        `;
        wireQaShiftDateControls(leaderboardEl);
        leaderboardEl.querySelectorAll('[data-qa-leaderboard-range]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const next = btn.getAttribute('data-qa-leaderboard-range') === 'week' ? 'week' : 'day';
            if (qaLeaderboardRange === next) return;
            qaLeaderboardRange = next;
            if (next === 'week') {
              leaderboardEl.innerHTML = '<div style="padding:14px;color:#777;font-size:12px;font-weight:850;text-align:center;"><i class="fas fa-spinner fa-spin"></i> Loading weekly leaderboard...</div>';
            }
            await loadQueue();
          });
        });
      }
    }

    const mgrSection = document.getElementById('qaManagerSection');
    const mgrBody = document.getElementById('qaManagerBody');
    const mgrCount = document.getElementById('qaManagerCount');

    if (mgrSection) {
      if (canManagerReview() && managerList.length > 0) {
        mgrSection.style.display = '';
        if (mgrCount) mgrCount.textContent = String(managerList.length);

        if (mgrBody) {
          mgrBody.innerHTML = '';
          for (const item of managerList) {
            const tr = document.createElement('tr');
            if (item.id === currentId) tr.classList.add('qa-selected');
            const qaApproval = getQaApprovalMeta(item);
            tr.innerHTML = `
              <td class="addr-cell">
                <strong>${esc(item.address || '')}</strong>
                ${vipPill(true)}
                ${fillerPill(!!item.is_filler)}
              </td>
              <td class="nowrap muted" title="${esc(fmtDate(item.created_at || ''))}">${esc(fmtDateShort(item.created_at || ''))}</td>
              <td class="nowrap">${esc(qaApproval.display)}</td>
              <td class="nowrap muted" title="${esc(fmtDate(qaApproval.at || ''))}">${esc(fmtDateShort(qaApproval.at || ''))}</td>
              <td class="nowrap">${esc(getTechnicianLabel(item))}</td>
              <td style="text-align:right;">
                <button class="qa-btn sm manager"><i class="fas fa-user-shield"></i> Review</button>
              </td>
            `;
            tr.querySelector('button').onclick = () => openInspector(item.id, { managerMode: true });
            mgrBody.appendChild(tr);
          }
        }
      } else {
        mgrSection.style.display = 'none';
      }
    }
    
    if (hBody) {
      hBody.innerHTML = '';
      if (!todayHistory.length) {
        hBody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:14px; color:#999;">No approvals today yet.</td></tr>`;
      } else {
        todayHistory.forEach(item => {
          const tr = document.createElement('tr');
          tr.className = 'history-clickable';
          const isFiller = !!item.is_filler;
          const isVip = !!item.is_vip;
          const isExpedited = !!item.is_expedited;
          tr.innerHTML = `
            <td>${esc(item.address || '')} ${vipPill(isVip)} ${expeditedPill(isExpedited)} ${fillerPill(isFiller)}</td>
            <td>${esc(fmtDate(item.completed_at || item.date || ''))}</td>
            <td>${badgeForHistoryStatus(item.status)}</td>
          `;
          tr.onclick = () => showProjectDetailModal(item);
          hBody.appendChild(tr);
        });
      }
    }
  }

  // ----------------- INSPECTOR -----------------
  async function fetchManifest(folderId, ms, opts){
    const data = await fmGetEditorBundle(folderId, ms || 20000, opts || null);
    const lat = data && data.manifest ? data.manifest.lat : null;
    const lng = data && data.manifest ? data.manifest.lng : null;
    const address = (data && data.manifest && data.manifest.address) ? data.manifest.address : '(Unknown address)';
    return { data, lat, lng, address, manifest: data?.manifest };
  }

  async function openInspector(folderId, opts){
    if (isEmbeddedQaMode()) {
      return openInspectorEmbedded(folderId, opts);
    }
    return openInspectorLegacy(folderId, opts);
  }

  async function openInspectorEmbedded(folderId, opts){
    const hard = !!(opts && opts.hard);
    const requestedManagerMode = !!(opts && opts.managerMode);
    const skipClaim = !!(opts && opts.skipClaim);

    const mySeq = ++inspectorSeq;
    currentId = folderId;
    isManagerReviewMode = requestedManagerMode;
    refreshHeartbeatContext();

    const pendingItem = pendingList.find(x => x.id === folderId);
    const managerItem = managerList.find(x => x.id === folderId);
    const itemStatus = managerItem
      ? (managerItem.status || 'awaiting_manager_review')
      : (pendingItem ? (pendingItem.status || 'awaiting_review') : 'awaiting_review');

    if (!isManagerReviewMode && !canDoQA()) {
      alert('You can manage the QA queue, but this account is not enabled to perform QA reviews.');
      currentId = null;
      return;
    }

    if (!skipClaim && !isManagerReviewMode && (itemStatus === 'awaiting_review' || itemStatus === 'submission_failed')) {
      try {
        const claimRes = await fmPost(`projects/${encodeURIComponent(folderId)}/qa/claim`, {}, 15000);
        if (!claimRes.success) {
          if (claimRes.error === 'item_claimed_by_other_user') {
            const claimerName = claimRes.claimed_by_name || claimRes.claimed_by || 'another QA user';
            alert(`This item is currently being reviewed by ${displayQaActorName(claimerName, 'another QA reviewer')}. Please select a different item.`);
          } else {
            alert(claimRes.message || 'This item is no longer available for QA. The queue will be refreshed.');
            loadQueue().catch(() => {});
          }
          currentId = null;
          isManagerReviewMode = false;
          return;
        }
      } catch (e) {
        console.warn('Claim check failed; refusing to open the project without verified ownership:', e);
        await qaNotice('Could not verify QA claim', 'This project was not opened because its QA ownership could not be verified. Refresh the queue and try again.');
        currentId = null;
        isManagerReviewMode = false;
        loadQueue().catch(() => {});
        return;
      }
    }

    setLayoutMode('inspector');
    setSlides('checklist');
    setViewerLoaded(false);
    clearEmbeddedEditor();
    preloadReservedEditor();
    clearPdf();
    clearQa3DViewer();
    clearQaMapViewer();
    currentManifest = null;
    currentAppMetadata = {};
    currentProjectStatus = itemStatus;
    qaThreads = [];
    renderQueue(pendingList, historyList);
    setQaHeaderProjectType(null);
    setQaCopyAddress('');

    const addrEl = document.getElementById('qaNavAddress');
    const subEl  = document.getElementById('qaNavSub');
    if (addrEl) addrEl.textContent = 'Loading...';
    setQaHeaderSubline(subEl, isManagerReviewMode ? 'Manager Sign-off' : '');
    setEmbeddedHeaderText('Loading...', isManagerReviewMode ? 'Manager Sign-off' : '');
    updateEmbeddedHeaderStats();

    try {
      const mf = await fetchManifest(folderId, 20000, { force: hard });
      if (mySeq !== inspectorSeq) return;
      if (!inQAView) return;
      setEmbeddedEditorFrame(folderId, { hard });

      currentManifest = mf.manifest;
      setQaHeaderProjectType(currentManifest && currentManifest.project_type);
      setQaCopyAddress(mf.address);
      currentAppMetadata = (mf && mf.data && mf.data.app_metadata && typeof mf.data.app_metadata === 'object')
        ? cloneJson(mf.data.app_metadata, {})
        : {};
      currentProjectStatus = (currentManifest && currentManifest.status) ? currentManifest.status : itemStatus;
      if (isManagerReviewMode) {
        qaThreads = mergeThreadDrafts(
          currentManifest && Array.isArray(currentManifest.manager_threads) ? currentManifest.manager_threads : [],
          getDraftThreadsFromMeta(currentAppMetadata, 'manager')
        );
      } else {
        qaThreads = mergeThreadDrafts(
          currentManifest && Array.isArray(currentManifest.qa_threads) ? currentManifest.qa_threads : [],
          getDraftThreadsFromMeta(currentAppMetadata, 'qa')
        );
      }

      const item = pendingItem || managerItem || null;
      const isVip = !!(currentManifest && currentManifest.is_vip);
      const isExpedited = !!(currentManifest && currentManifest.is_expedited);
      const customerRework = getCustomerReworkMeta(item, currentManifest);
      if (addrEl) {
        let addrText = mf.address;
        if (currentProjectStatus === 'pending_rejection' || currentProjectStatus === 'submission_failed') addrText += ' !';
        let extra = '';
        if (isVip) extra += ' <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:6px;background:#f9ab00;color:#fff;font-size:10px;font-weight:950;vertical-align:middle;">VIP</span>';
        if (isExpedited) extra += ' <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:6px;background:#0f766e;color:#fff;font-size:10px;font-weight:950;vertical-align:middle;">EXPEDITED</span>';
        if (customerRework.isRework) extra += ' <span class="qa-badge customer-rework"><i class="fas fa-screwdriver-wrench"></i> Customer Rework</span>';
        if (isManagerReviewMode) extra += ' <span class="qa-manager-mode-pill"><i class="fas fa-user-shield"></i> Manager Review</span>';
        addrEl.innerHTML = esc(addrText) + extra;
        setEmbeddedHeaderText(esc(addrText) + extra, document.getElementById('qaEmbeddedSub')?.textContent || '');
      }
      if (subEl) {
        const drafter = getTechnicianLabel(item, currentManifest);
        let subText = '';
        if (isManagerReviewMode) {
          const qaBy = getQaApprovalMeta(item, currentManifest).display || 'QA';
          subText = `Manager Sign-off - QA approved by: ${qaBy} - Drafter: ${drafter}`;
        } else if (canSeeQaTechnicianIdentity()) {
          subText = `Drafter: ${drafter} - Submitted: ${fmtDate((item && item.date) || '')}`;
          if (currentProjectStatus === 'pending_rejection') subText += ' - REJECTION REQUESTED';
          if (currentProjectStatus === 'submission_failed') subText += ' - SUBMISSION FAILED - NEEDS ATTENTION';
        }
        if (customerRework.isRework) {
          subText = subText ? `${subText} - Customer rework: ${customerRework.label}` : `Customer rework: ${customerRework.label}`;
        }
        setQaHeaderSubline(subEl, subText);
        setEmbeddedHeaderText(document.getElementById('qaEmbeddedAddress')?.innerHTML || esc(mf.address || ''), subText);
      }
    } catch(e) {
      if (mySeq !== inspectorSeq) return;
      qaThreads = [];
      currentAppMetadata = {};
      currentProjectStatus = itemStatus;
      setQaHeaderProjectType(null);
      setQaCopyAddress('');
      if (addrEl) addrEl.textContent = '(Unknown address)';
      setEmbeddedHeaderText('(Unknown address)', isManagerReviewMode ? 'Manager Sign-off' : '');
    }

    renderChecklist();
    updateActionButtons();
    updateNavButtons();
  }

  async function openInspectorLegacy(folderId, opts){
    const hard = !!(opts && opts.hard);
    const requestedManagerMode = !!(opts && opts.managerMode);
    const skipClaim = !!(opts && opts.skipClaim);

    const mySeq = ++inspectorSeq;
    currentId = folderId;
    isManagerReviewMode = requestedManagerMode;
    refreshHeartbeatContext();
    
    const pendingItem = pendingList.find(x => x.id === folderId);
    const managerItem = managerList.find(x => x.id === folderId);
    const itemStatus = managerItem
      ? (managerItem.status || 'awaiting_manager_review')
      : (pendingItem ? (pendingItem.status || 'awaiting_review') : 'awaiting_review');

    if (!isManagerReviewMode && !canDoQA()) {
      alert('You can manage the QA queue, but this account is not enabled to perform QA reviews.');
      currentId = null;
      return;
    }
    
    if (!skipClaim && !isManagerReviewMode && (itemStatus === 'awaiting_review' || itemStatus === 'submission_failed')) {
      try {
        const claimRes = await fmPost(`projects/${encodeURIComponent(folderId)}/qa/claim`, {}, 15000);
        
        if (!claimRes.success) {
          if (claimRes.error === 'item_claimed_by_other_user') {
            const claimerName = claimRes.claimed_by_name || claimRes.claimed_by || 'another QA user';
            alert(`This item is currently being reviewed by ${displayQaActorName(claimerName, 'another QA reviewer')}. Please select a different item.`);
          } else {
            alert(claimRes.message || 'This item is no longer available for QA. The queue will be refreshed.');
            loadQueue().catch(() => {});
          }
          currentId = null;
          isManagerReviewMode = false;
          return;
        }
      } catch (e) {
        console.warn('Claim check failed; refusing to open the project without verified ownership:', e);
        await qaNotice('Could not verify QA claim', 'This project was not opened because its QA ownership could not be verified. Refresh the queue and try again.');
        currentId = null;
        isManagerReviewMode = false;
        loadQueue().catch(() => {});
        return;
      }
    }
    
    setLayoutMode('inspector');
    setSlides('checklist');
    setViewerLoaded(true);
    clearQa3DViewer();
    clearQaMapViewer();
    
    const addrEl = document.getElementById('qaNavAddress');
    const subEl  = document.getElementById('qaNavSub');
    setQaHeaderProjectType(null);
    setQaCopyAddress('');
    if (addrEl) addrEl.textContent = 'Loading…';
    setQaHeaderSubline(subEl, isManagerReviewMode ? 'Manager Sign-off' : '');
    
    const item = pendingItem || managerItem || null;
    if (subEl && item) {
      const drafter = getTechnicianLabel(item);
      if (isManagerReviewMode) {
        subEl.textContent = `Manager Sign-off • Drafter: ${drafter}`;
      } else {
        setQaHeaderSubline(subEl, canSeeQaTechnicianIdentity()
          ? `Drafter: ${drafter} • Submitted: ${fmtDate(item.date || item.uploaded_at || '')}`
          : '');
      }
    }

    try {
      const mf = await fetchManifest(folderId, 20000, { force: hard });
      if (mySeq !== inspectorSeq) return;
      if (!inQAView) return;
      
      currentManifest = mf.manifest;
      setQaHeaderProjectType(currentManifest && currentManifest.project_type);
      setQaCopyAddress(mf.address);
      currentAppMetadata = (mf && mf.data && mf.data.app_metadata && typeof mf.data.app_metadata === 'object')
        ? cloneJson(mf.data.app_metadata, {})
        : {};
      currentProjectStatus = (currentManifest && currentManifest.status) ? currentManifest.status : itemStatus;

      if (isManagerReviewMode) {
        qaThreads = mergeThreadDrafts(
          currentManifest && Array.isArray(currentManifest.manager_threads) ? currentManifest.manager_threads : [],
          getDraftThreadsFromMeta(currentAppMetadata, 'manager')
        );
      } else {
        qaThreads = mergeThreadDrafts(
          currentManifest && Array.isArray(currentManifest.qa_threads) ? currentManifest.qa_threads : [],
          getDraftThreadsFromMeta(currentAppMetadata, 'qa')
        );
      }

      const isVip = !!(currentManifest && currentManifest.is_vip);
      const isExpedited = !!(currentManifest && currentManifest.is_expedited);
      const customerRework = getCustomerReworkMeta(item, currentManifest);

      if (addrEl) {
        let addrText = mf.address;
        if (currentProjectStatus === 'pending_rejection' || currentProjectStatus === 'submission_failed') addrText += ' ⚠️';
        let extra = '';
        if (isVip) extra += ' <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:6px;background:#f9ab00;color:#fff;font-size:10px;font-weight:950;vertical-align:middle;">⭐ VIP</span>';
        if (isExpedited) extra += ' <span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:6px;background:#0f766e;color:#fff;font-size:10px;font-weight:950;vertical-align:middle;">EXPEDITED</span>';
        if (customerRework.isRework) extra += ' <span class="qa-badge customer-rework"><i class="fas fa-screwdriver-wrench"></i> Customer Rework</span>';
        if (isManagerReviewMode) extra += ' <span class="qa-manager-mode-pill"><i class="fas fa-user-shield"></i> Manager Review</span>';
        addrEl.innerHTML = esc(addrText) + extra;
      }
      
      if (subEl) {
        const drafter = getTechnicianLabel(item, currentManifest);
        if (isManagerReviewMode) {
          const qaBy = getQaApprovalMeta(item, currentManifest).display || 'QA';
          subEl.textContent = `Manager Sign-off • QA approved by: ${qaBy} • Drafter: ${drafter}`;
        } else {
          let subText = canSeeQaTechnicianIdentity()
            ? `Drafter: ${drafter} • Submitted: ${fmtDate((item && item.date) || '')}`
            : '';
          if (currentProjectStatus === 'pending_rejection') subText += ' • REJECTION REQUESTED';
          if (currentProjectStatus === 'submission_failed') subText += ' • SUBMISSION FAILED - NEEDS ATTENTION';
          if (!canSeeQaTechnicianIdentity()) subText = '';
          if (customerRework.isRework) {
            subText = subText ? `${subText} - Customer rework: ${customerRework.label}` : `Customer rework: ${customerRework.label}`;
          }
          setQaHeaderSubline(subEl, subText);
        }
      }

      const bundle = (mf && mf.data) ? mf.data : {};
      const assets = bundle && bundle.assets ? bundle.assets : {};
      setQaImageAssets(assets, bundle);
      setQa3DViewer(folderId);
      setQaMapViewer(folderId);
    } catch(e){
      if (mySeq !== inspectorSeq) return;
      qaThreads = [];
      currentAppMetadata = {};
      currentProjectStatus = itemStatus;
      setQaHeaderProjectType(null);
      setQaCopyAddress('');
      if (addrEl) addrEl.textContent = '(Unknown address)';
    }

    renderChecklist();
    updateNavButtons();
    loadPdfFor(folderId, mySeq, hard).catch(()=>{});
    
    setTimeout(() => {
      if (mySeq !== inspectorSeq) return;
      forceResizeMap();
      applyQaImageViewportTransform();
    }, 120);
  }

  let _closingToList = false;

  async function releaseQaClaimsForPipeline(reason, projectIds){
    const scopedProjectIds = Array.from(new Set((Array.isArray(projectIds) ? projectIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)));
    clearPreloadedEditor();
    if (!canDoQA()) return;
    try {
      await fmPost('qa/session/release', {
        reason: reason || 'pipeline_return',
        project_ids: scopedProjectIds
      }, 15000);
    } catch (e) {
      console.warn('Failed to release QA claims while returning to pipeline:', e);
    }
  }

  async function closeInspectorToList(options){
    const opts = options || {};
    const wasManagerReviewMode = isManagerReviewMode;
    // Claims survive ordinary back-navigation and view changes. Releasing a
    // claim implicitly here can strand an editor that remains open in another
    // tab and hand the same project to a second reviewer. Only explicit
    // completion/error cleanup or the Release action opts into release.
    const shouldReleaseClaims = opts.releaseClaims === true && !wasManagerReviewMode && canDoQA();
    const projectIdsToRelease = Array.from(new Set([
      currentId,
      ...(Array.isArray(qaReservedProjects) ? qaReservedProjects.map((item) => item && item.id) : [])
    ].map((id) => String(id || '').trim()).filter(Boolean)));
    qaReservedProjects = [];
    setQaSubmitBlocking(false);
    currentId = null;
    currentManifest = null;
    currentProjectStatus = null;
    currentAppMetadata = {};
    qaThreads = [];
    isManagerReviewMode = false;
    refreshHeartbeatContext();
    setSlides('list');
    setLayoutMode('list');
    setViewerLoaded(false);
    clearEmbeddedEditor();
    clearPdf();
    clearQa3DViewer();
    clearQaMapViewer();
    try{ if (activeMarker) activeMarker.setPosition(null); }catch(e){}
    activeLastLoc = null;
    forceResizeMap();
    if (!_closingToList) {
      _closingToList = true;
      try {
        if (shouldReleaseClaims) {
          await releaseQaClaimsForPipeline(opts.reason || 'pipeline_return', projectIdsToRelease);
        }
        await loadQueue();
      } finally {
        _closingToList = false;
      }
    } else if (shouldReleaseClaims) {
      releaseQaClaimsForPipeline(opts.reason || 'pipeline_return', projectIdsToRelease);
    }
  }

  // ----------------- EDIT / RELOAD -----------------
  async function editCurrentProject(){
    if (!currentId) { alert('No project currently loaded.'); return; }
    window.open('editor.php?folder=' + encodeURIComponent(currentId), '_blank');
  }

  async function releaseCurrentClaim(){
    if (!currentId) return;
    if (isManagerReviewMode) { alert('Manager review does not use claiming.'); return; }
    const ok = await qaConfirm({
      title: 'Release claim?',
      message: 'Release this item back to the queue? Another QA user will be able to claim it.',
      confirmHtml: '<i class="fas fa-unlock"></i> Release'
    });
    if (!ok) return;
    try {
      await fmPost(`projects/${encodeURIComponent(currentId)}/qa/release-claim`, {
        reason: 'manual_release'
      }, 15000);
      closeInspectorToList();
      await loadQueue();
    } catch (e) {
      alert('Failed to release: ' + (e.message || 'Unknown error'));
    }
  }

  async function reloadCurrentProject(){
    if (!currentId) { alert('No project currently loaded.'); return; }
    const btnReload = getQaActionButton('qaReloadProjectBtn', 'qaEmbeddedReloadBtn');
    if (!btnReload) return;
    const originalHTML = btnReload.innerHTML;
    btnReload.disabled = true;
    btnReload.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reloading...';
    try {
      await openInspector(currentId, { hard: true, managerMode: isManagerReviewMode });
      btnReload.innerHTML = '<i class="fas fa-check"></i> Reloaded!';
      setTimeout(() => { btnReload.disabled = false; btnReload.innerHTML = originalHTML; }, 1200);
    } catch(e){
      alert('Failed to reload project.');
      btnReload.disabled = false;
      btnReload.innerHTML = originalHTML;
    }
  }

  async function refreshQaView(){
    if (!inQAView) return;
    const btnRefresh = document.getElementById('qaRefreshBtn');
    const originalHTML = btnRefresh ? btnRefresh.innerHTML : '';
    if (btnRefresh) {
      btnRefresh.disabled = true;
      btnRefresh.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Refreshing...';
    }
    try {
      if (currentId) {
        await openInspector(currentId, { hard: true, managerMode: isManagerReviewMode });
      }
      await loadQueue();
      if (btnRefresh) {
        btnRefresh.innerHTML = '<i class="fas fa-check"></i> Refreshed!';
      }
    } catch (e) {
      console.error('[QA] Refresh failed', e);
      if (btnRefresh) {
        btnRefresh.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Retry';
      }
    } finally {
      if (btnRefresh) {
        setTimeout(() => {
          btnRefresh.disabled = false;
          btnRefresh.innerHTML = originalHTML;
        }, 1200);
      }
    }
  }

  function getBulkSkipLabel(row){
    const reason = String(row?.reason || '').trim();
    if (reason === 'missing_pdf') return 'Missing report PDF';
    if (reason === 'criteria_mismatch') return getBulkCriteriaMismatchLabel(row);
    if (reason === 'not_awaiting_review') return `No longer in QA${row?.status ? ` (${row.status})` : ''}`;
    if (reason === 'claimed') return `Claimed by ${row?.claimed_by || 'someone else'}`;
    if (reason === 'not_found') return 'Project not found';
    if (reason === 'status_not_completed') return `Could not complete${row?.status ? ` (${row.status})` : ''}`;
    if (reason === 'approval_failed') return 'Approval failed';
    return reason ? reason.replace(/_/g, ' ') : 'Unknown reason';
  }

  function getBulkCriteriaMismatchLabel(row){
    const criteria = getBulkCriteria();
    const details = [];
    const score = qaNumber(row?.score);
    const maxScore = qaNumber(criteria.max_score);
    if (Number.isFinite(score) && Number.isFinite(maxScore) && score > maxScore) {
      details.push(`QA score ${formatOneDecimal(score)} is above max ${formatOneDecimal(maxScore)}`);
    }
    const height = qaNumber(row?.height_quality_points ?? row?.height_points);
    const maxHeight = qaNumber(criteria.max_height_points);
    if (Number.isFinite(height) && Number.isFinite(maxHeight) && height > maxHeight) {
      details.push(`solar penalty ${formatOneDecimal(height)} is above max ${formatOneDecimal(maxHeight)}`);
    }
    const projectPoints = qaNumber(row?.project_points ?? row?.complexity_points);
    const maxProject = qaNumber(criteria.max_project_points);
    if (Number.isFinite(projectPoints) && Number.isFinite(maxProject) && projectPoints > maxProject) {
      details.push(`complexity ${formatOneDecimal(projectPoints)} is above max ${formatOneDecimal(maxProject)}`);
    }
    const rank = String(row?.drafter_rank || '').trim().toLowerCase();
    if (rank && Array.isArray(criteria.drafter_ranks) && criteria.drafter_ranks.length && !criteria.drafter_ranks.includes(rank)) {
      details.push(`drafter rank ${rank} is not selected`);
    }
    if (!criteria.include_claimed && String(row?.claimed_by || row?.qa_claimed_by_email || '').trim()) {
      details.push(`project is claimed by ${row.claimed_by || row.qa_claimed_by_email}`);
    }
    if (!criteria.include_vip && !!row?.is_vip) {
      details.push('VIP projects are excluded');
    }
    return details.length ? details.join('; ') : 'No longer matches the selected bulk filters';
  }

  function summarizeBulkSkips(skippedRows){
    const groups = new Map();
    skippedRows.forEach((row) => {
      const label = getBulkSkipLabel(row);
      groups.set(label, (groups.get(label) || 0) + 1);
    });
    return Array.from(groups.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, count]) => `${count} ${label}`)
      .join('; ');
  }

  function renderBulkApprovalResult(res, matchesById){
    const approved = Number(res.approved_count || 0);
    const skipped = Number(res.skipped_count || 0);
    const skippedRows = Array.isArray(res.skipped) ? res.skipped : [];
    const approvedRows = Array.isArray(res.approved) ? res.approved : [];
    const skippedSummary = summarizeBulkSkips(skippedRows);
    const detailRows = [
      ...approvedRows.slice(0, 10).map((row) => {
        const item = matchesById.get(String(row.id || '')) || {};
        return `<div style="color:#137333;">Approved ${esc(item.address || row.id || 'project')}${row.email_result && row.email_result.ok === false ? ' - email send failed' : ''}</div>`;
      }),
      ...skippedRows.slice(0, 25).map((row) => {
        const item = matchesById.get(String(row.id || '')) || {};
        return `<div style="color:#b0261e;">Skipped ${esc(item.address || row.id || 'project')} - ${esc(getBulkSkipLabel(row))}</div>`;
      })
    ];
    const more = skippedRows.length > 25 ? `<div style="color:#5f6368;">${esc(skippedRows.length - 25)} more skipped projects not shown.</div>` : '';
    return `<div><b>Approved ${approved} project${approved === 1 ? '' : 's'}</b>${skipped ? `; skipped ${skipped}` : ''}.</div>${skippedSummary ? `<div style="color:#b0261e;"><b>Why skipped:</b> ${esc(skippedSummary)}</div>` : ''}${detailRows.join('')}${more}`;
  }

  async function claimSingleBulkQaProject(item){
    const folderId = qaBulkItemId(item);
    if (!folderId) throw new Error('Missing project id.');
    const claimRes = await fmPost(`projects/${encodeURIComponent(folderId)}/qa/claim`, {}, 15000);
    if (!claimRes || claimRes.success === false) {
      const claimerName = claimRes && (claimRes.claimed_by_name || claimRes.claimed_by);
      const publicClaimerName = displayQaActorName(claimerName, 'another QA reviewer');
      throw new Error(claimerName
        ? `This project is currently claimed by ${publicClaimerName}.`
        : 'This project could not be claimed for QA.');
    }
    return claimRes;
  }

  async function approveSingleBulkQaProject(item){
    const folderId = qaBulkItemId(item);
    if (!folderId) throw new Error('Missing project id.');
    return await fmPost(`projects/${encodeURIComponent(folderId)}/qa/decision`, {
      status: 'approved',
      ...buildQaDecisionTracking('approved'),
      threads: [],
      actor: fmActor()
    }, 60000);
  }

  async function runBulkQaApproval(){
    const btn = document.getElementById('qaBulkApproveBtn');
    const confirm = document.getElementById('qaBulkConfirm');
    const matches = getBulkApprovalMatches();
    syncBulkSelectionWithMatches(matches);
    const selected = getBulkSelectedMatches(matches);
    if (!btn || !confirm || !confirm.checked || !selected.length || qaBulkRunActive) return;
    const original = btn.innerHTML;
    qaBulkRunActive = true;
    qaBulkRowStatus.clear();
    selected.forEach((item) => {
      const id = qaBulkItemId(item);
      if (id) qaBulkRowStatus.set(id, { status: 'queued', label: 'Queued' });
    });
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Approving 0/' + selected.length;
    updateQaBulkControls();

    let approved = 0;
    let failed = 0;
    try {
      for (let i = 0; i < selected.length; i++) {
        const item = selected[i];
        const id = qaBulkItemId(item);
        if (!id) continue;
        qaBulkRowStatus.set(id, { status: 'running', label: `Claiming ${i + 1}/${selected.length}` });
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Claiming ${i + 1}/${selected.length}`;
        updateQaBulkControls();
        try {
          await claimSingleBulkQaProject(item);
          qaBulkRowStatus.set(id, { status: 'running', label: `Sending ${i + 1}/${selected.length}` });
          btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Approving ${i + 1}/${selected.length}`;
          updateQaBulkControls();
          const res = await approveSingleBulkQaProject(item);
          if (!res || res.success === false) {
            throw new Error(res?.message || res?.error || 'Approval failed.');
          }
          approved++;
          qaBulkRowStatus.set(id, { status: 'success', label: 'Approved', approvedAt: new Date().toISOString() });
        } catch (err) {
          failed++;
          qaBulkRowStatus.set(id, {
            status: 'error',
            label: 'Failed',
            error: err && err.message ? err.message : 'Approval failed.'
          });
        }
        updateQaBulkControls();
      }

      confirm.checked = false;
      const countEl = document.getElementById('qaBulkCount');
      if (countEl) countEl.innerHTML = `Approved: <b>${approved}</b>${failed ? ` / Failed: <b style="color:#b0261e;">${failed}</b>` : ''}`;
      btn.innerHTML = approved ? '<i class="fas fa-check"></i> Done' : original;
      await qaNotice('Bulk approval complete', `Approved ${approved} project${approved === 1 ? '' : 's'}${failed ? `; ${failed} failed.` : '.'}`);
    } finally {
      qaBulkRunActive = false;
      btn.innerHTML = approved ? '<i class="fas fa-check"></i> Done' : original;
      updateQaBulkControls();
    }
  }

  // ----------------- WIRE UI -----------------
  function wireUIOnce(){
    if (uiWired) return;
    uiWired = true;
    wireQaScoreTooltips();
    
    const refresh = document.getElementById('qaRefreshBtn');
    if (refresh) refresh.onclick = () => refreshQaView();
    const pendingPageSize = document.getElementById('qaPendingPageSize');
    if (pendingPageSize) {
      pendingPageSize.value = String(qaPendingPageSize);
      pendingPageSize.onchange = async () => {
        const value = Number.parseInt(pendingPageSize.value || '200', 10);
        qaPendingPageSize = [25, 50, 100, 200].includes(value) ? value : 200;
        qaPendingPage = 1;
        saveQaPendingPageSize(qaPendingPageSize);
        await loadQueue();
      };
    }
    const pendingPrev = document.getElementById('qaPendingPrevBtn');
    if (pendingPrev) pendingPrev.onclick = async () => {
      if (qaPendingPage <= 1) return;
      qaPendingPage--;
      await loadQueue();
    };
    const pendingNext = document.getElementById('qaPendingNextBtn');
    if (pendingNext) pendingNext.onclick = async () => {
      if (qaPendingPage >= qaPendingTotalPages) return;
      qaPendingPage++;
      await loadQueue();
    };
    const historyPageSize = document.getElementById('qaHistoryPageSize');
    if (historyPageSize) {
      historyPageSize.value = String(qaHistoryPageSize);
      historyPageSize.onchange = async () => {
        const value = Number.parseInt(historyPageSize.value || '25', 10);
        qaHistoryPageSize = [10, 25, 50, 100].includes(value) ? value : 25;
        qaHistoryPage = 1;
        saveQaHistoryPageSize(qaHistoryPageSize);
        await loadQueue();
      };
    }
    const historyPrev = document.getElementById('qaHistoryPrevBtn');
    if (historyPrev) historyPrev.onclick = async () => {
      if (qaHistoryPage <= 1) return;
      qaHistoryPage--;
      await loadQueue();
    };
    const historyNext = document.getElementById('qaHistoryNextBtn');
    if (historyNext) historyNext.onclick = async () => {
      if (qaHistoryPage >= qaHistoryTotalPages) return;
      qaHistoryPage++;
      await loadQueue();
    };

    const bulkToggle = document.getElementById('qaBulkApproveToggle');
    const bulkPanel = document.getElementById('qaBulkApprovePanel');
    if (bulkToggle && bulkPanel) {
      bulkToggle.onclick = () => {
        setBulkApprovalModalOpen(!bulkPanel.classList.contains('show'));
      };
      bulkPanel.onclick = (event) => {
        if (event.target === bulkPanel) setBulkApprovalModalOpen(false);
      };
    }
    const bulkClose = document.getElementById('qaBulkCloseBtn');
    if (bulkClose) bulkClose.onclick = () => setBulkApprovalModalOpen(false);
    window.addEventListener('keydown', (event) => {
      const lightboxOpen = document.getElementById('qaLightbox')?.classList.contains('show');
      if (lightboxOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          hideLightbox();
          return;
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          stepLightbox(-1);
          return;
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          stepLightbox(1);
          return;
        }
      }
      if (event.key === 'Escape' && document.getElementById('qaBulkApprovePanel')?.classList.contains('show')) {
        setBulkApprovalModalOpen(false);
      }
    });
    ['qaBulkMaxScore', 'qaBulkMaxHeight', 'qaBulkRank', 'qaBulkTechnician', 'qaBulkMaxComplexity', 'qaBulkIncludeClaimed', 'qaBulkIncludeVip', 'qaBulkConfirm'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.oninput = () => updateQaBulkControls();
      if (el) el.onchange = () => updateQaBulkControls();
    });
    const bulkApprove = document.getElementById('qaBulkApproveBtn');
    if (bulkApprove) bulkApprove.onclick = () => runBulkQaApproval();
    
    const back = document.getElementById('qaBackToListBtn');
    if (back) back.onclick = () => closeInspectorToList();
    
    const approve = document.getElementById('qaApproveBtn');
    const reject = document.getElementById('qaRejectBtn');
    const correctApprove = document.getElementById('qaCorrectApproveBtn');
    if (approve) approve.onclick = () => submitDecision('approved');
    if (reject) reject.onclick = () => submitDecision('rejected');
    if (correctApprove) correctApprove.onclick = () => submitDecision('corrected_approved');
    
    const editBtn = document.getElementById('qaEditDirectlyBtn');
    if (editBtn) editBtn.onclick = () => editCurrentProject();
    
    const reloadBtn = document.getElementById('qaReloadProjectBtn');
    if (reloadBtn) reloadBtn.onclick = () => reloadCurrentProject();

    const resolveAllBtn = document.getElementById('qaResolveAllBtn');
    if (resolveAllBtn) resolveAllBtn.onclick = () => resolveAllIssues();

    const releaseBtn = document.getElementById('qaReleaseClaimBtn');
    if (releaseBtn) releaseBtn.onclick = () => releaseCurrentClaim();

    const embeddedBack = document.getElementById('qaEmbeddedBackBtn');
    if (embeddedBack) embeddedBack.onclick = () => closeInspectorToList();
    wireQaCopyAddress(document.getElementById('qaNavAddress'));
    wireQaCopyAddress(document.getElementById('qaEmbeddedAddress'));
    const embeddedApprove = document.getElementById('qaEmbeddedApproveBtn');
    const embeddedReject = document.getElementById('qaEmbeddedRejectBtn');
    const embeddedCorrectApprove = document.getElementById('qaEmbeddedCorrectApproveBtn');
    if (embeddedApprove) embeddedApprove.onclick = () => isManagerReviewMode ? submitManagerDecision('approved') : submitDecision('approved');
    if (embeddedReject) embeddedReject.onclick = () => isManagerReviewMode ? submitManagerDecision('rejected') : submitDecision('rejected');
    if (embeddedCorrectApprove) embeddedCorrectApprove.onclick = () => submitDecision('corrected_approved');
    const embeddedReload = document.getElementById('qaEmbeddedReloadBtn');
    if (embeddedReload) embeddedReload.onclick = () => reloadCurrentProject();
    const embeddedResolveAll = document.getElementById('qaEmbeddedResolveAllBtn');
    if (embeddedResolveAll) embeddedResolveAll.onclick = () => resolveAllIssues();
    const embeddedRelease = document.getElementById('qaEmbeddedReleaseBtn');
    if (embeddedRelease) embeddedRelease.onclick = () => releaseCurrentClaim();

    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data || {};
      if (!data) return;
      if (String(data.type || '').indexOf('firstmeasure:') === 0) markQaActivity();
      if (data.type === 'firstmeasure:qa_decision_request') {
        if (!currentId || String(data.folder || '') !== String(currentId)) return;
        if (Array.isArray(data.threads)) {
          qaThreads = cloneJson(data.threads, []);
          renderChecklist();
          updateActionButtons();
        }
        const status = data.status === 'corrected_approved' ? 'corrected_approved' : (data.status === 'approved' ? 'approved' : 'rejected');
        const requestedPdfSync = {
          jobId: String(data.pdf_sync_job_id || ''),
          revision: String(data.pdf_sync_revision || '')
        };
        if (isManagerReviewMode) submitManagerDecision(status === 'corrected_approved' ? 'approved' : status, requestedPdfSync);
        else submitDecision(status, requestedPdfSync);
        return;
      }
      if (data.type !== 'firstmeasure:qa_threads_updated') return;
      if (!currentId || String(data.folder || '') !== String(currentId)) return;
      if (Array.isArray(data.threads)) {
        qaThreads = cloneJson(data.threads, []);
        renderChecklist();
        updateActionButtons();
      }
    });

    const grabNextBtn = document.getElementById('qaGrabNextBtn');
    if (grabNextBtn) {
      grabNextBtn.onclick = async () => {
        if (grabNextBtn.disabled) return;
        const original = grabNextBtn.innerHTML;
        grabNextBtn.disabled = true;
        grabNextBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Grabbing...';
        try {
          const data = await pullQaQueueWithBusyRetry({
            ...qaQueuePayload(),
            count: QA_PRELOAD_TARGET,
            release_stale: false
          });
          const projects = Array.isArray(data?.projects) ? data.projects : [];
          const folder = String(projects[0]?.id || data?.folder || '').trim();
          if (!data || !data.success || !folder) throw new Error(data?.error || 'No QA project available.');
          if (projects.length) {
            absorbReservedProjects(projects);
          }
          if (projects[0] && typeof projects[0] === 'object') {
            const claimedProject = {
              ...projects[0],
              qa_claimed_by_email: projects[0].qa_claimed_by_email || cfg().user?.email || '',
              qa_claimed_by_name: projects[0].qa_claimed_by_name || cfg().user?.name || cfg().user?.email || '',
              qa_claimed_at: projects[0].qa_claimed_at || new Date().toISOString()
            };
            pendingList = pendingList.filter(item => item.id !== folder);
            pendingList.unshift(claimedProject);
          }
          await openInspector(folder, { skipClaim: true });
        } catch (err) {
          await loadQueue().catch(() => {});
          const details = err?.data && typeof err.data === 'object'
            ? [
                err.data.api_error,
                err.data.api_status ? `API status ${err.data.api_status}` : '',
                err.status ? `HTTP ${err.status}` : '',
                err.data.request_id ? `Request ${err.data.request_id}` : ''
              ].filter(Boolean).join(' - ')
            : (err?.status ? `HTTP ${err.status}` : '');
          await qaNotice('Could not grab QA project', `${err.message || 'Failed to grab the next QA project.'}${details ? `\n${details}` : ''}`);
        } finally {
          grabNextBtn.disabled = false;
          grabNextBtn.innerHTML = original;
          renderQueue(pendingList, historyList);
        }
      };
    }
    
    const lb = document.getElementById('qaLightbox');
    if (lb) {
      lb.onclick = (e) => {
        if (e.target === lb || e.target.closest('.close')) hideLightbox();
      };
      lb.querySelector('[data-lightbox-nav="prev"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        stepLightbox(-1);
      });
      lb.querySelector('[data-lightbox-nav="next"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        stepLightbox(1);
      });
    }

    const headRow = document.getElementById('qaPendingHead');
    if (headRow) {
      headRow.querySelectorAll('th.sortable').forEach(th => {
        th.onclick = () => {
          const col = th.dataset.col;
          if (col) handleSortClick(col);
        };
      });
    }

    const fillerToggle = document.getElementById('qaFillerToggle');
    if (fillerToggle) {
      fillerToggle.onclick = () => {
        showFillers = !showFillers;
        persistFillerState();
        renderQueue(pendingList, historyList);
      };
    }

    const imageTabs = document.getElementById('qaImageTabs');
    if (imageTabs) {
      imageTabs.querySelectorAll('.qa-mini-tab').forEach((btn) => {
        btn.onclick = () => selectQaImageView(btn.dataset.view || '');
      });
    }

    const geoBtn = document.getElementById('qaImageGeoBtn');
    if (geoBtn) {
      geoBtn.onclick = () => {
        if (isQaLiveMapMode(qaActiveImageView)) return;
        qaImageGeometryVisible = !qaImageGeometryVisible;
        renderQaGeometryOverlay(qaActiveImageView, qaImageViewport.baseWidth || 1, qaImageViewport.baseHeight || 1);
        updateQaImageGeometryUi();
      };
    }

    const faceBtn = document.getElementById('qaImageFacesBtn');
    if (faceBtn) {
      faceBtn.onclick = () => {
        if (isQaLiveMapMode(qaActiveImageView)) return;
        qaImageShowFaces = !qaImageShowFaces;
        renderQaGeometryOverlay(qaActiveImageView, qaImageViewport.baseWidth || 1, qaImageViewport.baseHeight || 1);
        updateQaImageGeometryUi();
      };
    }

    const typesBtn = document.getElementById('qaImageTypesBtn');
    if (typesBtn) {
      typesBtn.onclick = () => {
        if (isQaLiveMapMode(qaActiveImageView)) return;
        qaImageShowTypeColors = !qaImageShowTypeColors;
        qaImageShowLegend = qaImageShowTypeColors;
        renderQaGeometryOverlay(qaActiveImageView, qaImageViewport.baseWidth || 1, qaImageViewport.baseHeight || 1);
        updateQaImageGeometryUi();
      };
    }

    const measuresBtn = document.getElementById('qaImageMeasuresBtn');
    if (measuresBtn) {
      measuresBtn.onclick = () => {
        if (isQaLiveMapMode(qaActiveImageView)) return;
        qaImageShowMeasurements = !qaImageShowMeasurements;
        renderQaGeometryOverlay(qaActiveImageView, qaImageViewport.baseWidth || 1, qaImageViewport.baseHeight || 1);
        updateQaImageGeometryUi();
      };
    }

    const fitBtn = document.getElementById('qaImageFitBtn');
    if (fitBtn) fitBtn.onclick = () => resetQaImageViewport();

    const imageViewport = document.getElementById('qaImageViewport');
    if (imageViewport) {
      imageViewport.addEventListener('wheel', (e) => {
        if (!(qaImageViewport.baseWidth > 0) || !(qaImageViewport.baseHeight > 0)) return;
        e.preventDefault();
        const rect = imageViewport.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const stageW = Math.max(1, rect.width || 1);
        const stageH = Math.max(1, rect.height || 1);
        const fitScale = getQaImageFitScale();
        const oldZoom = Math.max(0.25, Number(qaImageViewport.zoom) || 1);
        const oldScale = fitScale * oldZoom;
        const oldBaseX = ((stageW - (qaImageViewport.baseWidth * oldScale)) / 2) + qaImageViewport.panX;
        const oldBaseY = ((stageH - (qaImageViewport.baseHeight * oldScale)) / 2) + qaImageViewport.panY;
        const localX = (mouseX - oldBaseX) / oldScale;
        const localY = (mouseY - oldBaseY) / oldScale;
        const zoomFactor = e.deltaY < 0 ? 1.12 : (1 / 1.12);
        const nextZoom = clamp(oldZoom * zoomFactor, 0.5, 12);
        const nextScale = fitScale * nextZoom;
        const nextBaseX = (stageW - (qaImageViewport.baseWidth * nextScale)) / 2;
        const nextBaseY = (stageH - (qaImageViewport.baseHeight * nextScale)) / 2;
        qaImageViewport.zoom = nextZoom;
        qaImageViewport.panX = mouseX - nextBaseX - (localX * nextScale);
        qaImageViewport.panY = mouseY - nextBaseY - (localY * nextScale);
        applyQaImageViewportTransform();
      }, { passive: false });

      imageViewport.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (!(qaImageViewport.baseWidth > 0) || !(qaImageViewport.baseHeight > 0)) return;
        qaImageViewport.dragging = true;
        qaImageViewport.dragStartX = e.clientX;
        qaImageViewport.dragStartY = e.clientY;
        qaImageViewport.panStartX = qaImageViewport.panX;
        qaImageViewport.panStartY = qaImageViewport.panY;
        imageViewport.classList.add('dragging');
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!qaImageViewport.dragging) return;
        qaImageViewport.panX = qaImageViewport.panStartX + (e.clientX - qaImageViewport.dragStartX);
        qaImageViewport.panY = qaImageViewport.panStartY + (e.clientY - qaImageViewport.dragStartY);
        applyQaImageViewportTransform();
      });

      window.addEventListener('mouseup', () => {
        if (!qaImageViewport.dragging) return;
        qaImageViewport.dragging = false;
        imageViewport.classList.remove('dragging');
      });

      imageViewport.addEventListener('mouseleave', () => {
        if (!qaImageViewport.dragging) return;
        qaImageViewport.dragging = false;
        imageViewport.classList.remove('dragging');
      });
    }
    
    wireSplitterOnce();
    
    if (!resizeWired) {
      resizeWired = true;
      window.addEventListener('resize', () => {
        forceResizeMap();
        applyQaImageViewportTransform();
      });
    }
  }

  // ----------------- INIT -----------------
  function init(){
    if (!canQA()) return;
    ensureStyles();
    ensureMarkup();
    updateQaFixOnlyIndicators();
    Portal.registerPlugin({
      id: 'qa',
      title: 'QA',
      iconClass: 'fas fa-clipboard-check'
    });
    
    window.QAPlugin = { 
      editCurrentProject, 
      reloadCurrentProject,
      showLightbox,
      updateQaFixOnlyIndicators
    };

    window.addEventListener('firstmeasure:qa_fix_only_mode_changed', (event) => {
      const enabled = !!(event.detail && event.detail.enabled);
      if (!cfg().flags) cfg().flags = {};
      cfg().flags.qa_fix_only_mode = enabled;
      updateQaFixOnlyIndicators();
      if (currentId) setEmbeddedEditorFrame(currentId, { hard: true });
    });
    
    const origSwitch = Portal.switchView.bind(Portal);
    let qaAutoRefreshTimer = null;
    
    Portal.switchView = async function(id, btn){
      const requestedOldQa = (id === 'qa-old');
      const requestedQa = (id === 'qa' || requestedOldQa);
      const targetId = requestedOldQa ? 'qa' : id;
      if (!requestedQa && inQAView && window.Portal?._applyingStartupView) {
        return;
      }
      const wasInQAView = inQAView;
      const wasManagerReviewMode = isManagerReviewMode;
      const embeddedBefore = isEmbeddedQaMode();
      const result = await origSwitch(targetId, btn);
      if (String(window.Portal?._currentView || '') !== String(targetId || '')) {
        return result;
      }
      const pluginHost = document.getElementById('portalPluginViews');
      const qaView = document.getElementById('view-qa');
      if (qaAutoRefreshTimer) {
        clearInterval(qaAutoRefreshTimer);
        qaAutoRefreshTimer = null;
      }
      
      inQAView = requestedQa;
      if (requestedQa) { startHeartbeat(); }
      else { stopHeartbeat(); }

      if (!inQAView) {
        setQaEditorShellFullscreen(false);
        if (pluginHost) {
          pluginHost.style.display = '';
          pluginHost.style.flex = '';
          pluginHost.style.flexDirection = '';
          pluginHost.style.minHeight = '';
        }
        if (qaView) {
          qaView.style.display = 'none';
          qaView.style.flexDirection = '';
          qaView.style.flex = '';
          qaView.style.minHeight = '';
        }
        closeInspectorToList({
          releaseClaims: false,
          reason: 'left_qa_view'
        });
        return;
      }
      if (pluginHost) {
        pluginHost.style.display = 'flex';
        pluginHost.style.flex = '1';
        pluginHost.style.flexDirection = 'column';
        pluginHost.style.minHeight = '0';
      }
      const embeddedAfter = !requestedOldQa && !useLegacyQaInspector();
      activateEmbeddedQaMode(embeddedAfter);
      if (embeddedBefore !== embeddedAfter) {
        currentId = null;
        currentManifest = null;
        currentProjectStatus = null;
        currentAppMetadata = {};
        qaThreads = [];
        isManagerReviewMode = false;
        setSlides('list');
        setLayoutMode('list');
        setViewerLoaded(false);
        clearEmbeddedEditor();
        clearPreloadedEditor();
        clearPdf();
        clearQa3DViewer();
        clearQaMapViewer();
      }
      if (qaView) {
        qaView.style.display = 'flex';
        qaView.style.flexDirection = 'column';
        qaView.style.flex = '1';
        qaView.style.minHeight = '0';
      }
      wireUIOnce();
      updateQaFixOnlyIndicators();
      await loadQueue();
      qaAutoRefreshTimer = setInterval(() => {
        if (!inQAView) return;
        loadQueue();
      }, 150000);
      return result;
    };
  }
  
  init();
})();
  const QA_LAYER_STYLES = {
    1: { line: '#00FF00', dot: '#FFFF00', fill: 'rgba(0,255,0,0.22)' },
    2: { line: '#FFA500', dot: '#FF0000', fill: 'rgba(255,165,0,0.22)' },
    3: { line: '#0000FF', dot: '#800080', fill: 'rgba(0,102,255,0.22)' },
    4: { line: '#9C27B0', dot: '#FFC0CB', fill: 'rgba(156,39,176,0.22)' },
    5: { line: '#006400', dot: '#DAA520', fill: 'rgba(0,100,0,0.22)' },
    6: { line: '#000080', dot: '#FF00FF', fill: 'rgba(0,0,128,0.22)' }
  };
  const QA_LINE_TYPES = {
    ridge: { color: '#FF0000', label: 'Ridge' },
    hip: { color: '#E67300', label: 'Hip' },
    valley: { color: '#800080', label: 'Valley' },
    rake: { color: '#006400', label: 'Rake' },
    eave: { color: '#FFD400', label: 'Eave' },
    head_wall: { color: '#A0522D', label: 'Headwall Flashing' },
    side_wall: { color: '#FF00FF', label: 'Sidewall Flashing' },
    trans: { color: '#808080', label: 'Transition' },
    parapet: { color: '#5C2E0C', label: 'Parapet Wall' },
    protrusion: { color: '#589BA6', label: 'Protrusion' },
    chimney_back: { color: '#00008B', label: 'Chimney Back Pan' },
    chimney_edge: { color: '#007bff', label: 'Chimney Step' },
    chimney_front: { color: '#ADD8E6', label: 'Chimney Apron' },
    skylight: { color: '#00FFFF', label: 'Skylight' },
    unknown: { color: '#000000', label: 'Unknown' }
  };
