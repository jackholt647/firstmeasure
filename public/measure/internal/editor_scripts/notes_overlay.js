/* notes_overlay.js
 * QA Kickback Notes Overlay v2.4 - Drafter Response System
 * Updated: Residential multi-structure confirmation gate.
 * Updated: Customer tech notes displayed in overlay (distinct from QA feedback).
 * Updated: Removed Reply button; only Mark as Fixed and Dispute remain.
 */
(function(){
  // ---------- state ----------
  let lastFolderId = null;
  let lastNotesSig = '';
  let qaThreads = [];
  let displayThreads = [];
  let manifestData = null;
  let activeThreadScope = 'qa';
  let currentBundleMeta = {};
  let ui = { 
    fab: null, 
    modal: null, 
    body: null, 
    badge: null 
  };
  let pendingImages = {}; // threadId -> File[]

  // Track whether the residential confirmation has been acknowledged this session
  // Keyed by folder id so switching projects re-triggers it
  let residentialConfirmedFolders = {};
  
  // ---------- helpers ----------
  function esc(s){
    return String(s ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }
  
  function fmtWhen(s){
    if (!s) return '';
    const t = Date.parse(String(s).replace(' ', 'T'));
    if (!isFinite(t)) return String(s);
    try { return new Date(t).toLocaleString(); } catch(e){ return String(s); }
  }

  function getApiProjectPath(folderId, suffix){
    return `/projects/${encodeURIComponent(folderId)}${suffix}`;
  }

  function getArtifactUrl(folderId, fileName){
    return window.firstMeasureBuildUrl(getApiProjectPath(folderId, `/artifacts/${encodeURIComponent(fileName)}`));
  }

  function cloneJson(value, fallback = null){
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return fallback;
    }
  }

  function isQaEmbedMode(){
    try {
      const params = new URLSearchParams(window.location.search || '');
      return params.has('qa_embed') || params.has('qa_feedback_editor');
    } catch (e) {
      return false;
    }
  }

  function getActorInfo(fallbackName = 'QA'){
    const actor = (window.FIRSTMEASURE_ACTOR && typeof window.FIRSTMEASURE_ACTOR === 'object')
      ? window.FIRSTMEASURE_ACTOR
      : {};
    return {
      name: actor.name || window.currentUserName || fallbackName,
      email: actor.email || window.currentUserEmail || fallbackName.toLowerCase()
    };
  }

  function notifyQaParent(){
    if (!isQaEmbedMode() || window.parent === window) return;
    try {
      window.parent.postMessage({
        type: 'firstmeasure:qa_threads_updated',
        folder: lastFolderId,
        scope: activeThreadScope,
        threads: cloneJson(qaThreads, [])
      }, window.location.origin);
    } catch (e) {}
  }

  function getDraftMetaKey(){
    return 'qa_thread_drafts';
  }

  function getCurrentAppMetadata(){
    const loaded = (window.currentProjectLoadedAppMetadata && typeof window.currentProjectLoadedAppMetadata === 'object')
      ? window.currentProjectLoadedAppMetadata
      : {};
    const bundleMeta = (currentBundleMeta && typeof currentBundleMeta === 'object') ? currentBundleMeta : {};
    return { ...cloneJson(bundleMeta, {}), ...cloneJson(loaded, {}) };
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

    const byId = new Map();
    baseThreads.forEach((thread) => {
      if (thread && thread.id) byId.set(String(thread.id), thread);
    });

    const merged = [];
    const seen = new Set();

    for (const thread of baseThreads) {
      const id = thread && thread.id ? String(thread.id) : '';
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

  function resolveThreadImageUrl(url){
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    if (/^[a-z]+:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
    if (lastFolderId && !/[\\/]/.test(raw)) return getArtifactUrl(lastFolderId, raw);

    const apiBase = String(window.FIRSTMEASURE_API_BASE || '').trim();
    if (raw.startsWith('/')) {
      try {
        const base = apiBase ? new URL(apiBase) : new URL(window.location.origin);
        return `${base.protocol}//${base.host}${raw}`;
      } catch (e) {
        return raw;
      }
    }

    try {
      return apiBase ? new URL(raw, `${apiBase.replace(/\/+$/, '')}/`).href : raw;
    } catch (e) {
      return raw;
    }
  }

  async function persistThreadDrafts(){
    if (!lastFolderId || typeof window.firstMeasureFetchJson !== 'function') return false;
    const nextMeta = getCurrentAppMetadata();
    const draftKey = getDraftMetaKey();
    const drafts = (nextMeta[draftKey] && typeof nextMeta[draftKey] === 'object')
      ? cloneJson(nextMeta[draftKey], {})
      : {};
    drafts[activeThreadScope] = {
      saved_at: new Date().toISOString(),
      threads: cloneJson(qaThreads, [])
    };
    nextMeta[draftKey] = drafts;

    await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(lastFolderId)}/editor/save`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ metadata: nextMeta })
    });

    currentBundleMeta = cloneJson(nextMeta, {});
    window.currentProjectLoadedAppMetadata = cloneJson(nextMeta, {});
    return true;
  }

  async function clearThreadDrafts(scope = activeThreadScope){
    if (!lastFolderId || typeof window.firstMeasureFetchJson !== 'function') return false;
    const nextMeta = getCurrentAppMetadata();
    const draftKey = getDraftMetaKey();
    const drafts = (nextMeta[draftKey] && typeof nextMeta[draftKey] === 'object')
      ? cloneJson(nextMeta[draftKey], {})
      : {};
    delete drafts[scope];
    if (Object.keys(drafts).length > 0) nextMeta[draftKey] = drafts;
    else delete nextMeta[draftKey];

    await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(lastFolderId)}/editor/save`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ metadata: nextMeta })
    });

    currentBundleMeta = cloneJson(nextMeta, {});
    window.currentProjectLoadedAppMetadata = cloneJson(nextMeta, {});
    return true;
  }

  function getThreadScopeForManifest(manifest){
    const status = String(manifest && manifest.status || '').trim().toLowerCase();
    const workflow = manifest && manifest.workflow && typeof manifest.workflow === 'object' ? manifest.workflow : {};
    const histories = [manifest && manifest.work_history, workflow.work_history, workflow.history];
    let latestKickback = null;
    for (const history of histories) {
      if (!Array.isArray(history)) continue;
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const event = String(history[index] && (history[index].event || history[index].type) || '').trim().toLowerCase();
        if (event === 'manager_sent_back_to_tech' || event === 'manager_rejected') {
          latestKickback = { scope: 'manager', index };
          break;
        }
        if (event === 'qa_sent_back_to_tech' || event === 'qa_rejected') {
          latestKickback = { scope: 'qa', index };
          break;
        }
      }
      if (latestKickback) break;
    }
    if ((status === 'correction_needed' || status === 'requeue') && latestKickback) {
      return latestKickback.scope;
    }
    const hasManagerThreads = Array.isArray(manifest && manifest.manager_threads) && manifest.manager_threads.length > 0;
    const hasQaReviewed = Boolean(String(manifest && manifest.qa_reviewed_at || '').trim());
    const isVip = Boolean(manifest && manifest.is_vip);
    if (hasManagerThreads || (isVip && hasQaReviewed && (status === 'correction_needed' || status === 'requeue'))) {
      return 'manager';
    }
    return 'qa';
  }

  function buildDisplayThreads(threadsByScope, activeScope){
    const scopes = activeScope === 'manager' ? ['manager', 'qa'] : ['qa', 'manager'];
    const output = [];
    const seen = new Set();
    for (const scope of scopes) {
      const threads = Array.isArray(threadsByScope && threadsByScope[scope]) ? threadsByScope[scope] : [];
      for (const source of threads) {
        if (!source || typeof source !== 'object') continue;
        const id = String(source.id || '');
        const key = `${scope}:${id || JSON.stringify(source)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push({
          ...cloneJson(source, {}),
          __fm_scope: scope,
          __fm_read_only: scope !== activeScope
        });
      }
    }
    return output;
  }

  function syncActiveDisplayThreads(){
    const historical = displayThreads.filter((thread) => thread && thread.__fm_scope !== activeThreadScope);
    const active = qaThreads.map((thread) => ({
      ...cloneJson(thread, {}),
      __fm_scope: activeThreadScope,
      __fm_read_only: false
    }));
    displayThreads = [...active, ...historical];
  }
  
  // ---------- styles ----------
  function ensureStyles(){
    if (document.getElementById('qaNotesOverlayStyles')) return;
    const css = `
      /* FAB Button */
      .qa-notes-fab {
        position: fixed;
        left: 20px;
        bottom: 20px;
        z-index: 9000;
        display: none;
        align-items: center;
        gap: 12px;
        padding: 14px 18px;
        border-radius: 16px;
        border: 1px solid rgba(0,0,0,0.12);
        background: rgba(255,255,255,0.98);
        color: #202124;
        font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 8px 32px rgba(0,0,0,0.15);
        backdrop-filter: blur(8px);
        transition: transform .1s ease, box-shadow .15s ease;
      }
      .qa-notes-fab:hover {
        transform: translateY(-2px);
        box-shadow: 0 12px 40px rgba(0,0,0,0.2);
      }
      .qa-notes-fab .icon {
        width: 40px;
        height: 40px;
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
      }
      .qa-notes-fab .txt .title {
        font-weight: 900;
        font-size: 14px;
        line-height: 1.2;
      }
      .qa-notes-fab .txt .sub {
        font-size: 12px;
        color: #666;
        font-weight: 600;
      }
      .qa-notes-fab .badge {
        min-width: 24px;
        height: 24px;
        padding: 0 8px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 900;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      /* Kickback state */
      .qa-notes-fab.kickback {
        background: linear-gradient(135deg, #dc3545 0%, #b02a37 100%);
        color: #fff;
        border-color: rgba(220,53,69,0.5);
        animation: kickbackPulse 2s ease-in-out infinite;
      }
      .qa-notes-fab.kickback .icon {
        background: rgba(255,255,255,0.15);
        color: #fff;
      }
      .qa-notes-fab.kickback .txt .sub { color: rgba(255,255,255,0.85); }
      .qa-notes-fab.kickback .badge {
        background: rgba(255,255,255,0.2);
        color: #fff;
      }
      @keyframes kickbackPulse {
        0%, 100% { box-shadow: 0 8px 32px rgba(220,53,69,0.3); }
        50% { box-shadow: 0 8px 40px rgba(220,53,69,0.5); }
      }

      /* Customer-notes-only FAB state (no kickback, calm info look) */
      .qa-notes-fab.customer-only {
        background: rgba(255,255,255,0.98);
        color: #202124;
        border-color: rgba(13,110,253,0.25);
      }
      .qa-notes-fab.customer-only .icon {
        background: rgba(13,110,253,0.10);
        color: #0d6efd;
      }
      .qa-notes-fab.customer-only .txt .sub { color: #666; }
      .qa-notes-fab.customer-only .badge {
        background: rgba(13,110,253,0.10);
        color: #0d6efd;
      }

      /* ========== Residential Confirmation Gate ========== */
      .res-confirm-card {
        position: fixed;
        left: 20px;
        bottom: 20px;
        z-index: 11000;
        width: min(420px, calc(100vw - 40px));
        background: #fff;
        border-radius: 20px;
        overflow: hidden;
        box-shadow: 0 12px 48px rgba(0,0,0,0.28);
        border: 2px solid #e65100;
        font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
        animation: resCardIn .25s ease;
      }
      @keyframes resCardIn {
        from { opacity: 0; transform: translateY(20px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .res-confirm-banner {
        background: linear-gradient(135deg, #ff6b00 0%, #e65100 100%);
        padding: 18px 20px;
        color: #fff;
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .res-confirm-banner .warn-icon {
        width: 44px;
        height: 44px;
        border-radius: 12px;
        background: rgba(255,255,255,0.15);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        flex-shrink: 0;
      }
      .res-confirm-banner .banner-text h2 {
        margin: 0;
        font-size: 15px;
        font-weight: 900;
      }
      .res-confirm-banner .banner-text p {
        margin: 2px 0 0;
        font-size: 11px;
        opacity: 0.9;
        font-weight: 500;
      }
      .res-confirm-body {
        padding: 16px 20px 12px;
      }
      .res-confirm-body .detail-box {
        background: #fff8f0;
        border: 1.5px solid #ffe0b2;
        border-radius: 12px;
        padding: 12px 14px;
        margin-bottom: 14px;
      }
      .res-confirm-body .detail-box .detail-row {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        color: #333;
      }
      .res-confirm-body .detail-box .detail-row + .detail-row {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid #ffe0b2;
      }
      .res-confirm-body .detail-box .detail-row .detail-icon {
        width: 28px;
        height: 28px;
        border-radius: 7px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        flex-shrink: 0;
      }
      .res-confirm-body .detail-box .detail-row .detail-label {
        font-weight: 700;
        color: #666;
        min-width: 80px;
      }
      .res-confirm-body .detail-box .detail-row .detail-value {
        font-weight: 900;
      }
      .res-confirm-body .prompt-text {
        font-size: 13px;
        font-weight: 800;
        color: #202124;
        text-align: center;
        margin-bottom: 0;
        line-height: 1.45;
      }
      .res-confirm-actions {
        display: flex;
        gap: 10px;
        padding: 12px 20px 18px;
      }
      .res-confirm-actions button {
        flex: 1;
        padding: 12px 16px;
        border-radius: 12px;
        border: none;
        font-weight: 900;
        font-size: 13px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        transition: all .15s ease;
      }
      .res-confirm-actions button:active { transform: scale(0.97); }
      .res-confirm-actions .btn-yes {
        background: #198754;
        color: #fff;
      }
      .res-confirm-actions .btn-yes:hover { background: #157347; }
      .res-confirm-actions .btn-no {
        background: #dc3545;
        color: #fff;
      }
      .res-confirm-actions .btn-no:hover { background: #bb2d3b; }

      /* Modal */
      .qa-notes-modal {
        position: fixed;
        left: 20px;
        bottom: 100px;
        z-index: 9001;
        width: min(600px, calc(100vw - 40px));
        max-height: min(70vh, 700px);
        display: none;
        flex-direction: column;
        border-radius: 20px;
        overflow: hidden;
        border: 1px solid rgba(0,0,0,0.1);
        background: #fff;
        font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 25px 80px rgba(0,0,0,0.25);
      }
      .qa-notes-modal.show {
        display: flex;
        animation: modalSlideUp .2s ease;
      }
      @keyframes modalSlideUp {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      /* Modal header */
      .qa-notes-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 16px 18px;
        background: linear-gradient(135deg, #dc3545 0%, #b02a37 100%);
        color: #fff;
      }
      .qa-notes-header.info-mode {
        background: linear-gradient(135deg, #0d6efd 0%, #0a58ca 100%);
      }
      .qa-notes-header.qa-review-mode {
        background: linear-gradient(135deg, #b42318 0%, #7f1d1d 100%);
      }
      .qa-notes-header .title-wrap {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .qa-notes-header .title {
        font-weight: 900;
        font-size: 16px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .qa-notes-header .subtitle {
        font-size: 12px;
        opacity: 0.9;
      }
      .qa-notes-header .close-btn {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        background: rgba(255,255,255,0.15);
        border: none;
        color: #fff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        transition: background .1s ease;
      }
      .qa-notes-header .close-btn:hover { background: rgba(255,255,255,0.25); }
      /* Summary bar */
      .qa-notes-summary {
        display: flex;
        gap: 16px;
        padding: 12px 18px;
        background: #f8f9fa;
        border-bottom: 1px solid #eee;
        font-size: 12px;
      }
      .qa-notes-summary .stat {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .qa-notes-summary .stat .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
      }
      .qa-notes-summary .stat .dot.open { background: #dc3545; }
      .qa-notes-summary .stat .dot.fixed { background: #0d6efd; }
      .qa-notes-summary .stat .dot.disputed { background: #ffc107; }
      .qa-notes-summary .stat .dot.resolved { background: #198754; }
      /* Body */
      .qa-notes-body {
        flex: 1;
        overflow-y: auto;
        padding: 14px;
      }

      /* ---- Customer Notes Card ---- */
      .qa-customer-notes {
        border: 1px solid rgba(13,110,253,0.20);
        border-left: 4px solid #0d6efd;
        border-radius: 14px;
        margin-bottom: 14px;
        overflow: hidden;
        background: #fff;
      }
      .qa-customer-notes .qa-cn-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        background: #e8f0fe;
        border-bottom: 1px solid rgba(13,110,253,0.12);
      }
      .qa-customer-notes .qa-cn-header .qa-cn-icon {
        width: 28px;
        height: 28px;
        border-radius: 8px;
        background: rgba(13,110,253,0.15);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #0d6efd;
        font-size: 13px;
        flex-shrink: 0;
      }
      .qa-customer-notes .qa-cn-header .qa-cn-label {
        font-weight: 900;
        font-size: 12px;
        color: #0a58ca;
        text-transform: uppercase;
        letter-spacing: 0.4px;
      }
      .qa-customer-notes .qa-cn-header .qa-cn-tag {
        margin-left: auto;
        padding: 3px 8px;
        border-radius: 999px;
        font-size: 9px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.3px;
        background: rgba(13,110,253,0.12);
        color: #0a58ca;
      }
      .qa-customer-notes .qa-cn-body {
        padding: 14px;
      }
      .qa-customer-notes .qa-cn-body .qa-cn-text {
        font-size: 13px;
        line-height: 1.55;
        color: #333;
        white-space: pre-wrap;
        word-break: break-word;
      }

      /* Thread card */
      .qa-thread-card {
        border: 1px solid #e0e0e0;
        border-radius: 14px;
        margin-bottom: 14px;
        overflow: hidden;
        background: #fff;
        transition: box-shadow .1s ease;
      }
      .qa-thread-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
      .qa-thread-card.open { border-left: 4px solid #dc3545; }
      .qa-thread-card.fixed { border-left: 4px solid #0d6efd; }
      .qa-thread-card.disputed { border-left: 4px solid #ffc107; }
      .qa-thread-card.resolved { border-left: 4px solid #198754; }
      .qa-thread-card.closed { border-left: 4px solid #6c757d; }
      /* Thread header */
      .qa-thread-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px;
        cursor: pointer;
        background: #fafafa;
        border-bottom: 1px solid #eee;
      }
      .qa-thread-header .label {
        flex: 1;
        font-weight: 800;
        font-size: 13px;
        color: #333;
      }
      .qa-thread-header .status {
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
      }
      .qa-thread-header .status.open { background: #fce8e6; color: #b02a37; }
      .qa-thread-header .status.fixed { background: #e8f0fe; color: #0d6efd; }
      .qa-thread-header .status.disputed { background: #fff7e0; color: #856404; }
      .qa-thread-header .status.resolved { background: #e6f4ea; color: #137333; }
      .qa-thread-header .status.closed { background: #f1f3f4; color: #5f6368; }
      .qa-thread-header .source {
        font-size: 10px;
        font-weight: 900;
        letter-spacing: .04em;
        text-transform: uppercase;
        border-radius: 999px;
        padding: 4px 7px;
        background: #e8f0fe;
        color: #174ea6;
        white-space: nowrap;
      }
      .qa-thread-header .source.manager { background: #f3e8fd; color: #681da8; }
      .qa-thread-card.read-only { background: #fbfbfc; }
      .qa-thread-read-only {
        margin: 10px 14px 14px;
        color: #5f6368;
        font-size: 11px;
        font-weight: 800;
      }
      .qa-thread-header .chevron {
        color: #999;
        transition: transform .2s ease;
      }
      .qa-thread-card.expanded .qa-thread-header .chevron {
        transform: rotate(180deg);
      }
      /* Thread content */
      .qa-thread-content {
        display: none;
        padding: 14px;
      }
      .qa-thread-card.expanded .qa-thread-content { display: block; }
      /* Messages */
      .qa-messages {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 14px;
      }
      .qa-message {
        padding: 12px;
        border-radius: 10px;
        background: #f8f9fa;
        border: 1px solid #e9ecef;
      }
      .qa-message.qa { border-left: 3px solid #dc3545; }
      .qa-message.drafter { border-left: 3px solid #0d6efd; }
      .qa-message .meta {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        font-size: 11px;
        color: #666;
      }
      .qa-message .meta .name { font-weight: 800; color: #333; }
      .qa-message .meta .role {
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 9px;
        font-weight: 800;
        text-transform: uppercase;
      }
      .qa-message .meta .role.qa { background: #fce8e6; color: #b02a37; }
      .qa-message .meta .role.drafter { background: #e8f0fe; color: #0d6efd; }
      .qa-message .text {
        font-size: 13px;
        line-height: 1.5;
        color: #333;
        white-space: pre-wrap;
      }
      .qa-message .images {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }
      .qa-message .images img {
        max-width: 150px;
        max-height: 100px;
        border-radius: 8px;
        border: 1px solid #ddd;
        cursor: pointer;
      }
      .qa-message .images img:hover { opacity: 0.9; }
      .qa-message .action-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-top: 8px;
        padding: 4px 8px;
        border-radius: 6px;
        font-size: 10px;
        font-weight: 800;
      }
      .qa-message .action-badge.marked_fixed { background: #e8f0fe; color: #0d6efd; }
      .qa-message .action-badge.disputed { background: #fff7e0; color: #856404; }
      /* Reply composer */
      .qa-reply-composer {
        border-top: 1px solid #eee;
        padding-top: 14px;
      }
      .qa-reply-composer textarea {
        width: 100%;
        min-height: 100px;
        border: 1px solid #ddd;
        border-radius: 10px;
        padding: 12px;
        font-family: inherit;
        font-size: 13px;
        resize: vertical;
        box-sizing: border-box;
        margin-bottom: 10px;
      }
      .qa-reply-composer textarea:focus {
        border-color: #0d6efd;
        outline: none;
        box-shadow: 0 0 0 3px rgba(13,110,253,0.1);
      }
      .qa-reply-composer .upload-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }
      .qa-reply-composer .upload-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        border: 1px dashed #ccc;
        border-radius: 8px;
        background: #fff;
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
        color: #666;
        transition: all .1s ease;
      }
      .qa-reply-composer .upload-btn:hover {
        border-color: #0d6efd;
        color: #0d6efd;
      }
      .qa-reply-composer .preview-images {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .qa-reply-composer .preview-img {
        position: relative;
        width: 60px;
        height: 60px;
        border-radius: 8px;
        overflow: hidden;
        border: 1px solid #ddd;
      }
      .qa-reply-composer .preview-img img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .qa-reply-composer .preview-img .remove {
        position: absolute;
        top: 2px;
        right: 2px;
        width: 18px;
        height: 18px;
        background: rgba(0,0,0,0.6);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font-size: 10px;
        cursor: pointer;
      }
      .qa-reply-composer .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .qa-review-composer {
        border: 1px solid rgba(220,53,69,0.22);
        border-left: 4px solid #dc3545;
        border-radius: 14px;
        padding: 12px;
        margin-bottom: 14px;
        background: #fffafa;
      }
      .qa-review-composer .composer-title {
        font-size: 12px;
        font-weight: 950;
        color: #842029;
        text-transform: uppercase;
        letter-spacing: .3px;
        margin-bottom: 8px;
      }
      .qa-reply-composer .btn {
        padding: 10px 16px;
        border-radius: 10px;
        border: 1px solid #ddd;
        background: #fff;
        font-weight: 800;
        font-size: 12px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        transition: all .1s ease;
      }
      .qa-reply-composer .btn:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
      .qa-reply-composer .btn.primary {
        background: #0d6efd;
        border-color: #0d6efd;
        color: #fff;
      }
      .qa-reply-composer .btn.primary:hover { background: #0b5ed7; }
      .qa-reply-composer .btn.warning {
        background: #ffc107;
        border-color: #ffc107;
        color: #000;
      }
      .qa-reply-composer .btn.warning:hover { background: #ffca2c; }
      /* Footer actions (Simple Text) */
      .qa-notes-footer {
        padding: 12px 18px;
        border-top: 1px solid #eee;
        background: #f8f9fa;
        color: #666;
        font-size: 11px;
        font-style: italic;
        text-align: center;
      }
      /* Lightbox */
      .qa-lightbox {
        position: fixed;
        inset: 0;
        z-index: 10000;
        background: rgba(0,0,0,0.9);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 40px;
      }
      .qa-lightbox.show { display: flex; }
      .qa-lightbox img {
        max-width: 100%;
        max-height: 100%;
        border-radius: 8px;
      }
      .qa-lightbox .close {
        position: absolute;
        top: 20px;
        right: 20px;
        width: 40px;
        height: 40px;
        background: rgba(255,255,255,0.1);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        cursor: pointer;
        font-size: 18px;
      }
      /* Empty state */
      .qa-empty-state {
        text-align: center;
        padding: 40px 20px;
        color: #666;
      }
      .qa-empty-state .icon {
        font-size: 48px;
        color: #198754;
        margin-bottom: 16px;
      }
      .qa-empty-state .title {
        font-weight: 900;
        font-size: 18px;
        color: #333;
        margin-bottom: 8px;
      }
    `;
    const style = document.createElement('style');
    style.id = 'qaNotesOverlayStyles';
    style.textContent = css;
    document.head.appendChild(style);
  }
  
  // ---------- UI setup ----------
  function ensureUI(){
    ensureStyles();
    
    if (!ui.fab){
      const fab = document.createElement('div');
      fab.className = 'qa-notes-fab';
      fab.innerHTML = `
        <div class="icon"><i class="fas fa-clipboard-list"></i></div>
        <div class="txt">
          <div class="title">QA Feedback</div>
          <div class="sub">Tap to view</div>
        </div>
        <span class="badge">0</span>
      `;
      fab.onclick = () => toggleModal();
      document.body.appendChild(fab);
      ui.fab = fab;
      ui.badge = fab.querySelector('.badge');
    }
    if (!ui.modal){
      const modal = document.createElement('div');
      modal.className = 'qa-notes-modal';
      modal.innerHTML = `
        <div class="qa-notes-header" id="qaNotesHeader">
          <div class="title-wrap">
            <div class="title"><i class="fas fa-exclamation-triangle"></i> QA Feedback</div>
            <div class="subtitle">Please address the issues below</div>
          </div>
          <button class="close-btn"><i class="fas fa-times"></i></button>
        </div>
        <div class="qa-notes-summary" id="qaNotesSummary"></div>
        <div class="qa-notes-body" id="qaNotesBody"></div>
        <div class="qa-notes-footer">
          <i class="fas fa-info-circle"></i> Responses are saved automatically. They will be sent to QA when you submit the PDF.
        </div>
      `;
      modal.querySelector('.close-btn').onclick = () => hideModal();
      document.body.appendChild(modal);
      ui.modal = modal;
      ui.body = modal.querySelector('#qaNotesBody');
    }
    // Lightbox
    if (!document.getElementById('qaDrafterLightbox')){
      const lb = document.createElement('div');
      lb.className = 'qa-lightbox';
      lb.id = 'qaDrafterLightbox';
      lb.innerHTML = `
        <div class="close"><i class="fas fa-times"></i></div>
        <img src="" alt="Preview">
      `;
      lb.onclick = (e) => {
        if (e.target === lb || e.target.closest('.close')) lb.classList.remove('show');
      };
      document.body.appendChild(lb);
    }
    return true;
  }
  function showLightbox(src){
    const lb = document.getElementById('qaDrafterLightbox');
    if (!lb) return;
    lb.querySelector('img').src = src;
    lb.classList.add('show');
  }

  // ================================================================
  //  RESIDENTIAL MULTI-STRUCTURE CONFIRMATION GATE
  // ================================================================

  /**
   * Determines whether the confirmation gate should fire.
   * Criteria:
   *   1. project_type === 'residential'
   *   2. pins array has more than 1 entry (multiple structures)
   *   3. Not already confirmed this session for this folder
   */
  function needsResidentialConfirmation(manifest, folderId) {
    if (!manifest) return false;

    // Only for residential projects
    const projType = (manifest.project_type || '').toLowerCase().trim();
    if (projType !== 'residential') return false;

    // Only when there are multiple structure pins
    const pins = Array.isArray(manifest.pins) ? manifest.pins : [];
    if (pins.length <= 1) return false;

    // Already confirmed for this folder this session
    if (residentialConfirmedFolders[folderId]) return false;

    return true;
  }

  /**
   * Shows the blocking confirmation modal. Returns a Promise<boolean>
   * true = "Yes, it IS residential"   false = "No, wrong type"
   * Cannot be dismissed by backdrop click or Escape — only the two buttons.
   */
  function showResidentialConfirmation(manifest) {
    return new Promise((resolve) => {
      // Remove any leftover card
      const existing = document.getElementById('res-confirm-card');
      if (existing) existing.remove();

      const pins = Array.isArray(manifest.pins) ? manifest.pins : [];
      const address = manifest.address || 'Unknown address';

      // Hide the FAB while this card is visible so they don't overlap
      if (ui.fab) ui.fab.style.display = 'none';
      // Also hide the QA modal if open
      hideModal();

      const card = document.createElement('div');
      card.id = 'res-confirm-card';
      card.className = 'res-confirm-card';

      card.innerHTML = `
        <div class="res-confirm-banner">
          <div class="warn-icon"><i class="fas fa-exclamation-triangle"></i></div>
          <div class="banner-text">
            <h2>Project Type Verification</h2>
            <p>Multiple structures detected &mdash; please verify</p>
          </div>
        </div>
        <div class="res-confirm-body">
          <div class="detail-box">
            <div class="detail-row">
              <div class="detail-icon" style="background:#e3f2fd; color:#1565c0;">
                <i class="fas fa-home"></i>
              </div>
              <div class="detail-label">Listed As</div>
              <div class="detail-value" style="color:#1565c0;">Single-Family Residential</div>
            </div>
            <div class="detail-row">
              <div class="detail-icon" style="background:#fff3e0; color:#e65100;">
                <i class="fas fa-map-marker-alt"></i>
              </div>
              <div class="detail-label">Structures</div>
              <div class="detail-value" style="color:#e65100;">${pins.length} pins placed</div>
            </div>
            <div class="detail-row">
              <div class="detail-icon" style="background:#f3e5f5; color:#7b1fa2;">
                <i class="fas fa-map-pin"></i>
              </div>
              <div class="detail-label">Address</div>
              <div class="detail-value">${esc(address)}</div>
            </div>
          </div>
          <div class="prompt-text">
            This was listed as a <strong>single-family residential</strong> project.<br>
            Please confirm that this is correct.
          </div>
        </div>
        <div class="res-confirm-actions">
          <button class="btn-no" id="resConfirmNo">
            <i class="fas fa-times-circle"></i> No, Incorrect
          </button>
          <button class="btn-yes" id="resConfirmYes">
            <i class="fas fa-check-circle"></i> Yes, Residential
          </button>
        </div>
      `;

      document.body.appendChild(card);

      const cleanup = () => {
        card.remove();
        // Restore FAB visibility
        updateFab();
      };

      card.querySelector('#resConfirmYes').onclick = () => {
        cleanup();
        resolve(true);
      };

      card.querySelector('#resConfirmNo').onclick = () => {
        cleanup();
        resolve(false);
      };
    });
  }

  /**
   * Opens the Reject Project modal (from main.js) and pre-selects
   * the "Incorrect Structure Type" reason button.
   */
  function triggerRejectWithIncorrectType() {
    if (typeof openRejectModal !== 'function') {
      alert('Could not open rejection dialog. Please reject manually and select "Incorrect Structure Type".');
      return;
    }

    openRejectModal();

    // openRejectModal builds its DOM synchronously. Use rAF + short timeout
    // so the browser has painted before we programmatically click the reason.
    requestAnimationFrame(() => {
      setTimeout(() => {
        const reasonBtns = document.querySelectorAll('.reject-reason-btn');
        for (const btn of reasonBtns) {
          const reason = (btn.dataset.reason || '').trim();
          const label = (btn.dataset.label || btn.textContent || '').trim();
          if (reason === 'incorrect_structure_type' || label === 'Incorrect Structure Type') {
            btn.click();
            break;
          }
        }
      }, 50);
    });
  }

  /**
   * Main gate — called after manifest loads for a folder.
   */
  async function maybeShowResidentialGate(manifest, folderId) {
    if (!needsResidentialConfirmation(manifest, folderId)) return;

    const confirmed = await showResidentialConfirmation(manifest);

    if (confirmed) {
      // User says "Yes it's residential" — mark acknowledged, proceed normally
      residentialConfirmedFolders[folderId] = true;
    } else {
      // User says "No, wrong type" — mark so it won't re-trigger, open reject modal
      residentialConfirmedFolders[folderId] = true;
      triggerRejectWithIncorrectType();
    }
  }
  
  // ---------- helpers for customer notes ----------
  function getCustomerNotes(){
    return (manifestData && manifestData.tech_notes) ? String(manifestData.tech_notes).trim() : '';
  }

  function getResubmissionNotes(){
    const list = (manifestData && Array.isArray(manifestData.resubmissions)) ? manifestData.resubmissions : [];
    return list
      .filter(item => item && typeof item === 'object' && String(item.notes || '').trim())
      .map((item, idx) => ({
        round: item.round || (idx + 1),
        reopened_at: item.reopened_at || '',
        completed_at: item.completed_at || '',
        reopened_by: item.reopened_by_name || item.reopened_by_email || '',
        notes: String(item.notes || '').trim(),
        images: Array.isArray(item.images) ? item.images.filter(img => img && (img.url || img.name)).map(img => ({
          url: img.url || (img.name ? getArtifactUrl(lastFolderId, img.name) : ''),
          name: img.original_name || img.name || ''
        })).filter(img => img.url) : []
      }));
  }

  // ---------- UI state ----------
  function updateFab(){
    if (!ui.fab) return;
    syncActiveDisplayThreads();
    
    const openCount = qaThreads.filter(t => t.status === 'open').length;
    const hasThreads = displayThreads.length > 0;
    const hasActionableThreads = qaThreads.length > 0;
    const hasCustNotes = !!getCustomerNotes();
    const hasResubNotes = getResubmissionNotes().length > 0;
    const qaReview = isQaEmbedMode();
    
    if (!qaReview && !hasThreads && !hasCustNotes && !hasResubNotes){
      ui.fab.style.display = 'none';
      return;
    }
    
    ui.fab.style.display = 'flex';

    // Remove both state classes first
    ui.fab.classList.remove('kickback', 'customer-only');
    
    const icon = ui.fab.querySelector('.icon i');
    const title = ui.fab.querySelector('.txt .title');
    const sub = ui.fab.querySelector('.txt .sub');
    
    if (qaReview){
      icon.className = 'fas fa-clipboard-list';
      title.textContent = 'QA Feedback';
      sub.textContent = hasThreads ? `${displayThreads.length} item${displayThreads.length > 1 ? 's' : ''}` : 'Add feedback';
      ui.badge.textContent = String(displayThreads.length);
    } else if (openCount > 0){
      // QA kickback mode (red, pulsing)
      ui.fab.classList.add('kickback');
      icon.className = 'fas fa-exclamation-triangle';
      title.textContent = 'QA KICKBACK';
      sub.textContent = `${openCount} issue${openCount > 1 ? 's' : ''} to address`;
      ui.badge.textContent = String(displayThreads.length);
    } else if (hasThreads){
      // QA threads exist but all addressed
      icon.className = 'fas fa-clipboard-check';
      title.textContent = 'QA Feedback';
      sub.textContent = hasActionableThreads ? 'All issues addressed' : 'Review feedback history';
      ui.badge.textContent = String(displayThreads.length);
    } else {
      // Only project notes, no QA threads
      ui.fab.classList.add('customer-only');
      icon.className = hasResubNotes ? 'fas fa-rotate-left' : 'fas fa-sticky-note';
      title.textContent = hasResubNotes ? 'Rework Notes' : 'Customer Notes';
      sub.textContent = 'Tap to view';
      ui.badge.textContent = String((hasCustNotes ? 1 : 0) + getResubmissionNotes().length);
    }
  }
  function showModal(){ if (ui.modal) ui.modal.classList.add('show'); }
  function hideModal(){ if (ui.modal) ui.modal.classList.remove('show'); }
  function toggleModal(){ 
    if (ui.modal) {
      ui.modal.classList.toggle('show');
      if (ui.modal.classList.contains('show')) renderThreads();
    }
  }
  
  // ---------- render ----------
  function renderThreads(){
    if (!ui.body) return;

    const custNotes = getCustomerNotes();
    const resubNotes = getResubmissionNotes();
    const hasThreads = displayThreads.length > 0;
    const hasActionableThreads = qaThreads.length > 0;
    const hasResubNotes = resubNotes.length > 0;
    const qaReview = isQaEmbedMode();

    // Update modal header style based on context
    const headerEl = document.getElementById('qaNotesHeader');
    if (headerEl){
      const titleEl = headerEl.querySelector('.title');
      const subtitleEl = headerEl.querySelector('.subtitle');
      if (qaReview){
        headerEl.classList.remove('info-mode');
        headerEl.classList.add('qa-review-mode');
        if (titleEl) titleEl.innerHTML = '<i class="fas fa-clipboard-check"></i> QA Feedback';
        if (subtitleEl) subtitleEl.textContent = 'Add feedback for the technician';
      } else if (!hasThreads && (custNotes || hasResubNotes)){
        // Project-notes-only mode: blue header
        headerEl.classList.add('info-mode');
        headerEl.classList.remove('qa-review-mode');
        if (titleEl) titleEl.innerHTML = '<i class="fas fa-sticky-note"></i> Project Notes';
        if (subtitleEl) subtitleEl.textContent = hasResubNotes ? 'Notes for this reopened project' : 'Notes submitted with this order';
      } else if (hasThreads && !hasActionableThreads) {
        headerEl.classList.add('info-mode');
        headerEl.classList.remove('qa-review-mode');
        if (titleEl) titleEl.innerHTML = '<i class="fas fa-clipboard-list"></i> Project Feedback';
        if (subtitleEl) subtitleEl.textContent = 'QA and manager feedback history';
      } else {
        // Normal QA mode: red header
        headerEl.classList.remove('info-mode');
        headerEl.classList.remove('qa-review-mode');
        if (titleEl) titleEl.innerHTML = '<i class="fas fa-exclamation-triangle"></i> QA Feedback';
        if (subtitleEl) subtitleEl.textContent = 'Please address the issues below';
      }
    }
    
    // Summary bar
    const summary = document.getElementById('qaNotesSummary');
    if (summary){
      if (hasActionableThreads){
        const open = qaThreads.filter(t => t.status === 'open').length;
        const fixed = qaThreads.filter(t => t.status === 'fixed').length;
        const disputed = qaThreads.filter(t => t.status === 'disputed').length;
        const resolved = qaThreads.filter(t => t.status === 'resolved' || t.status === 'closed').length;
        summary.style.display = '';
        summary.innerHTML = `
          <div class="stat"><div class="dot open"></div> ${open} Open</div>
          <div class="stat"><div class="dot fixed"></div> ${fixed} Fixed</div>
          <div class="stat"><div class="dot disputed"></div> ${disputed} Disputed</div>
          <div class="stat"><div class="dot resolved"></div> ${resolved} Resolved</div>
        `;
      } else {
        // Hide summary bar if no QA threads
        summary.style.display = 'none';
      }
    }
    
    // Build body content
    let html = '';

    if (qaReview){
      html += `
        <div class="qa-review-composer qa-reply-composer">
          <div class="composer-title"><i class="fas fa-plus-circle"></i> Add QA Feedback</div>
          <textarea placeholder="Describe what the technician needs to fix..." id="qaReplyText_qaNewIssue"></textarea>
          <div class="upload-row">
            <label class="upload-btn">
              <i class="fas fa-image"></i> Add Image
              <input type="file" accept="image/*" multiple style="display:none;" id="qaReplyImages_qaNewIssue">
            </label>
            <div class="preview-images" id="qaReplyPreview_qaNewIssue"></div>
          </div>
          <div class="actions">
            <button class="btn primary" data-action="create-qa-feedback">
              <i class="fas fa-comment-medical"></i> Add Feedback
            </button>
          </div>
        </div>
      `;
    }

    // ---- Customer Notes card (always at top, visually distinct) ----
    if (custNotes){
      html += `
        <div class="qa-customer-notes">
          <div class="qa-cn-header">
            <div class="qa-cn-icon"><i class="fas fa-user"></i></div>
            <div class="qa-cn-label">Customer Notes</div>
            <div class="qa-cn-tag">From Order</div>
          </div>
          <div class="qa-cn-body">
            <div class="qa-cn-text">${esc(custNotes)}</div>
          </div>
        </div>
      `;
    }

    if (hasResubNotes){
      resubNotes.slice().reverse().forEach((item) => {
        const imagesHtml = item.images.length
          ? `<div class="images" style="margin-top:10px;">${item.images.map(img => `<img src="${esc(img.url)}" title="${esc(img.name)}" onclick="window.DrafterQA.showLightbox('${esc(img.url)}')">`).join('')}</div>`
          : '';
        html += `
          <div class="qa-customer-notes">
            <div class="qa-cn-header">
              <div class="qa-cn-icon"><i class="fas fa-rotate-left"></i></div>
              <div class="qa-cn-label">Rework Notes</div>
              <div class="qa-cn-tag">Round ${esc(item.round)}</div>
            </div>
            <div class="qa-cn-body">
              <div class="qa-cn-text">${esc(item.notes)}</div>
              <div style="margin-top:8px;font-size:11px;color:#666;font-weight:800;">
                ${item.completed_at ? `Completed before reopen: ${esc(item.completed_at)}<br>` : ''}
                ${item.reopened_at ? `Reopened: ${esc(item.reopened_at)}` : ''}
                ${item.reopened_by ? ` by ${esc(item.reopened_by)}` : ''}
              </div>
              ${imagesHtml}
            </div>
          </div>
        `;
      });
    }

    // ---- QA Threads ----
    if (!hasThreads && !custNotes && !hasResubNotes && !qaReview){
      html += `
        <div class="qa-empty-state">
          <div class="icon"><i class="fas fa-check-circle"></i></div>
          <div class="title">All Clear!</div>
          <div>No QA feedback for this project.</div>
        </div>
      `;
      ui.body.innerHTML = html;
      return;
    }

    if (!hasThreads && (custNotes || hasResubNotes) && !qaReview){
      // Only project notes, no QA threads - we already rendered the cards above
      ui.body.innerHTML = html;
      return;
    }
    
    for (const thread of displayThreads){
      const readOnly = Boolean(thread.__fm_read_only);
      const sourceScope = thread.__fm_scope === 'manager' ? 'manager' : 'qa';
      const sourceLabel = sourceScope === 'manager' ? 'Manager' : 'QA';
      const statusLabels = {
        open: 'Open',
        fixed: 'Marked Fixed',
        disputed: 'Disputed',
        resolved: 'Resolved',
        closed: 'Closed'
      };
      
      // Messages
      let messagesHtml = '<div class="qa-messages">';
      for (const msg of thread.history){
        const actionBadges = {
          marked_fixed: '<span class="action-badge marked_fixed"><i class="fas fa-wrench"></i> Marked as Fixed</span>',
          disputed: '<span class="action-badge disputed"><i class="fas fa-question-circle"></i> Disputed</span>',
          qa_resolved: '<span class="action-badge marked_fixed"><i class="fas fa-check-double"></i> Marked Resolved</span>'
        };
        
        let imagesHtml = '';
        if (msg.images && msg.images.length > 0){
          imagesHtml = '<div class="images">' + msg.images.map(src => {
            const resolvedSrc = resolveThreadImageUrl(src);
            return `<img src="${esc(resolvedSrc)}" onclick="window.DrafterQA.showLightbox('${esc(resolvedSrc)}')">`;
          }).join('') + '</div>';
        }
        
        messagesHtml += `
          <div class="qa-message ${msg.role}">
            <div class="meta">
              <span class="name">${esc(msg.by_name || msg.by)}</span>
              <span class="role ${msg.role}">${msg.role === 'qa' ? 'QA' : (msg.role === 'manager' ? 'Manager' : 'Drafter')}</span>
              <span>${fmtWhen(msg.ts)}</span>
            </div>
            <div class="text">${esc(msg.text)}</div>
            ${imagesHtml}
            ${actionBadges[msg.action] || ''}
          </div>
        `;
      }
      messagesHtml += '</div>';
      
      // Reply composer (only for non-resolved threads)
      let composerHtml = '';
      if (!readOnly && thread.status !== 'resolved' && thread.status !== 'closed'){
        const qaActions = qaReview
          ? `
              <button class="btn primary" data-thread="${thread.id}" data-action="qa-reply">
                <i class="fas fa-reply"></i> Add Comment
              </button>
              <button class="btn" data-thread="${thread.id}" data-action="qa-resolve">
                <i class="fas fa-check-double"></i> Mark Resolved
              </button>
            `
          : `
              <button class="btn primary" data-thread="${thread.id}" data-action="fix">
                <i class="fas fa-check"></i> Mark as Fixed
              </button>
              <button class="btn warning" data-thread="${thread.id}" data-action="dispute">
                <i class="fas fa-question-circle"></i> Dispute
              </button>
            `;
        composerHtml = `
          <div class="qa-reply-composer">
            <textarea placeholder="${qaReview ? 'Add a QA comment...' : 'Add your response...'}" id="qaReplyText_${thread.id}"></textarea>
            <div class="upload-row">
              <label class="upload-btn">
                <i class="fas fa-image"></i> Add Image
                <input type="file" accept="image/*" multiple style="display:none;" id="qaReplyImages_${thread.id}">
              </label>
              <div class="preview-images" id="qaReplyPreview_${thread.id}"></div>
            </div>
            <div class="actions">
              ${qaActions}
            </div>
          </div>
        `;
      }
      
      html += `
        <div class="qa-thread-card ${thread.status}${readOnly ? ' read-only' : ''}" data-thread-id="${thread.id}">
          <div class="qa-thread-header">
            <div class="label">${esc(thread.label)}</div>
            <span class="source ${sourceScope}">${sourceLabel}</span>
            <span class="status ${thread.status}">${statusLabels[thread.status] || thread.status}</span>
            <i class="fas fa-chevron-down chevron"></i>
          </div>
          <div class="qa-thread-content">
            ${messagesHtml}
            ${composerHtml}
            ${readOnly ? `<div class="qa-thread-read-only"><i class="fas fa-clock-rotate-left"></i> Previous ${sourceLabel} feedback — shown for project history.</div>` : ''}
          </div>
        </div>
      `;
    }
    
    ui.body.innerHTML = html;
    
    // Wire up events
    ui.body.querySelectorAll('.qa-thread-header').forEach(header => {
      header.onclick = () => {
        const card = header.closest('.qa-thread-card');
        card.classList.toggle('expanded');
      };
    });
    
    // Wire up action buttons
    ui.body.querySelectorAll('.qa-reply-composer .btn[data-action]').forEach(btn => {
      if (btn.dataset.action === 'create-qa-feedback') btn.onclick = () => createQaFeedbackThread();
      else btn.onclick = () => handleThreadAction(btn.dataset.thread, btn.dataset.action);
    });
    
    // Wire up image uploads
    if (qaReview) setupImageUpload('qaNewIssue');
    qaThreads.forEach(t => {
      if (t.status !== 'resolved' && t.status !== 'closed'){
        setupImageUpload(t.id);
      }
    });
  }
  
  function setupImageUpload(threadId){
    const input = document.getElementById(`qaReplyImages_${threadId}`);
    const preview = document.getElementById(`qaReplyPreview_${threadId}`);
    if (!input || !preview) return;
    
    pendingImages[threadId] = pendingImages[threadId] || [];
    
    input.onchange = () => {
      for (const file of input.files){
        if (!file.type.startsWith('image/')) continue;
        pendingImages[threadId].push(file);
        
        const reader = new FileReader();
        reader.onload = (e) => {
          const div = document.createElement('div');
          div.className = 'preview-img';
          div.innerHTML = `<img src="${e.target.result}"><div class="remove"><i class="fas fa-times"></i></div>`;
          div.querySelector('.remove').onclick = () => {
            const idx = pendingImages[threadId].indexOf(file);
            if (idx > -1) pendingImages[threadId].splice(idx, 1);
            div.remove();
          };
          preview.appendChild(div);
        };
        reader.readAsDataURL(file);
      }
      input.value = '';
    };
  }
  
  async function uploadImages(threadId){
    const files = pendingImages[threadId] || [];
    const urls = [];
    
    for (let i = 0; i < files.length; i += 1){
      const file = files[i];
      try {
        const ext = (String(file && file.name || '').split('.').pop() || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
        const safeName = `qa_note_${threadId}_${Date.now()}_${i}.${ext}`;
        const data = await window.firstMeasureUploadArtifact(lastFolderId, file, safeName);
        const savedName = data && data.artifact && data.artifact.name ? data.artifact.name : safeName;
        urls.push(getArtifactUrl(lastFolderId, savedName));
      } catch(e){
        console.error('Image upload failed:', e);
      }
    }
    
    pendingImages[threadId] = [];
    return urls;
  }

  async function createQaFeedbackThread(){
    if (!isQaEmbedMode()) return;
    const textEl = document.getElementById('qaReplyText_qaNewIssue');
    const text = textEl ? textEl.value.trim() : '';
    if (!text && !(pendingImages.qaNewIssue && pendingImages.qaNewIssue.length)) {
      alert('Please add a comment or image for the QA feedback.');
      return;
    }
    const images = await uploadImages('qaNewIssue');
    const actor = getActorInfo('QA');
    const id = `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    qaThreads.push({
      id,
      item_id: id,
      category: 'general',
      label: 'QA Feedback',
      status: 'open',
      created_at: new Date().toISOString(),
      history: [{
        ts: new Date().toISOString(),
        by: actor.email,
        by_name: actor.name,
        role: 'qa',
        action: 'created',
        text,
        images
      }]
    });
    if (textEl) textEl.value = '';
    renderThreads();
    updateFab();
    notifyQaParent();
    persistThreadDrafts().then(notifyQaParent).catch((err) => {
      console.warn('Failed to persist QA feedback draft:', err);
    });
  }

  async function addFeedbackFromExternal(payload){
    if (!isQaEmbedMode()) return { success: false, threads: cloneJson(qaThreads, []) };
    const label = String(payload && payload.label || 'QA Feedback').trim() || 'QA Feedback';
    const text = String(payload && payload.text || '').trim();
    if (!text) return { success: false, threads: cloneJson(qaThreads, []) };
    const resolved = !!(payload && (payload.resolved || payload.corrected));
    const actor = getActorInfo('QA');
    const id = `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    qaThreads.push({
      id,
      item_id: id,
      category: 'pdf_review',
      label,
      status: resolved ? 'resolved' : 'open',
      created_at: new Date().toISOString(),
      history: [{
        ts: new Date().toISOString(),
        by: actor.email,
        by_name: actor.name,
        role: 'qa',
        action: 'created',
        text,
        images: []
      }].concat(resolved ? [{
        ts: new Date().toISOString(),
        by: actor.email,
        by_name: actor.name,
        role: 'qa',
        action: 'qa_resolved',
        text: String(payload.resolveText || payload.correctedText || 'Corrected by QA before approval.'),
        images: []
      }] : [])
    });
    renderThreads();
    updateFab();
    notifyQaParent();
    await persistThreadDrafts().catch((err) => {
      console.warn('Failed to persist QA feedback draft:', err);
    });
    notifyQaParent();
    return { success: true, threads: cloneJson(qaThreads, []) };
  }
  
  async function handleThreadAction(threadId, action){
    const thread = qaThreads.find(t => t.id === threadId);
    if (!thread) return;
    
    const textEl = document.getElementById(`qaReplyText_${threadId}`);
    const text = textEl ? textEl.value.trim() : '';
    
    if (action === 'dispute' && !text){
      alert('Please enter a response explaining the dispute.');
      return;
    }
    if (action === 'qa-reply' && !text && !(pendingImages[threadId] && pendingImages[threadId].length)) {
      alert('Please add a comment or image before saving QA feedback.');
      return;
    }
    
    // Upload images first
    const images = await uploadImages(threadId);
    
    if (isQaEmbedMode()){
      const actor = getActorInfo('QA');
      const msg = {
        ts: new Date().toISOString(),
        by: actor.email,
        by_name: actor.name,
        role: 'qa',
        action: action === 'qa-resolve' ? 'qa_resolved' : 'comment',
        text: text || (action === 'qa-resolve' ? 'Marked resolved during QA review.' : ''),
        images
      };
      thread.history.push(msg);
      if (action === 'qa-resolve') thread.status = 'resolved';
      if (textEl) textEl.value = '';
      renderThreads();
      updateFab();
      notifyQaParent();
      persistThreadDrafts().then(notifyQaParent).catch((err) => {
        console.warn('Failed to persist QA feedback draft:', err);
      });
      return;
    }
    
    // Get current user info
    const actor = getActorInfo('Drafter');
    const userName = actor.name;
    const userEmail = actor.email;
    
    const msg = {
      ts: new Date().toISOString(),
      by: userEmail,
      by_name: userName,
      role: 'drafter',
      action: action === 'fix' ? 'marked_fixed' : 'disputed',
      text: text || (action === 'fix' ? 'I have fixed this issue.' : ''),
      images: images
    };
    
    thread.history.push(msg);
    
    if (action === 'fix'){
      thread.status = 'fixed';
    } else if (action === 'dispute'){
      thread.status = 'disputed';
    }
    
    // Clear input
    if (textEl) textEl.value = '';
    
    renderThreads();
    updateFab();
    notifyQaParent();
    persistThreadDrafts().catch((err) => {
      console.warn('Failed to persist QA response draft:', err);
    });
  }
  // ---------- programmatic submission ----------
  
  // Silent Submit (Called by report.js)
  async function submitFixesSilent(options) {
    options = options && typeof options === 'object' ? options : {};
    if (!qaThreads || qaThreads.length === 0) {
      return { success: true, next_status: null, manifest: manifestData, thread_scope: activeThreadScope };
    }
    try {
      const submittedScope = activeThreadScope;
      const data = await window.firstMeasureFetchJson(getApiProjectPath(lastFolderId, '/drafter/qa-response'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threads: qaThreads,
          thread_scope: submittedScope,
          pdf_sync_job_id: String(options.pdf_sync_job_id || ''),
          pdf_sync_revision: String(options.pdf_sync_revision || ''),
          actor: window.FIRSTMEASURE_ACTOR || {}
        })
      });

      if (data && data.manifest) {
        manifestData = data.manifest;
        activeThreadScope = getThreadScopeForManifest(manifestData);
      }

      if (data && data.success) {
        await clearThreadDrafts(submittedScope).catch((err) => {
          console.warn('Failed to clear QA response draft after submit:', err);
        });
      }

      return {
        success: Boolean(data && data.success),
        next_status: data && data.next_status ? String(data.next_status) : null,
        manifest: data && data.manifest ? data.manifest : manifestData,
        thread_scope: data && data.thread_scope ? String(data.thread_scope) : activeThreadScope
      };
    } catch(e) {
      console.error("Silent QA submit failed", e);
      return { success: false, next_status: null, manifest: manifestData, thread_scope: activeThreadScope };
    }
  }
  // Check if all handled (Called by report.js)
  function areAllThreadsHandled() {
    const openItems = qaThreads.filter(t => t.status === 'open');
    return openItems.length === 0;
  }
  // ---------- data loading ----------
  async function fetchManifest(folderId){
    try {
      const data = await window.firstMeasureFetchJson(getApiProjectPath(folderId, '/editor'), { method: 'GET' });
      return data && typeof data === 'object' ? data : null;
    } catch (e) {
      console.error('Failed to load project manifest for QA notes overlay:', e);
      return null;
    }
  }
  
  async function refreshForFolder(folderId){
    if (!folderId) return;
    if (!ensureUI()) return;
    
    const bundle = await fetchManifest(folderId);
    const manifest = bundle && bundle.manifest ? bundle.manifest : null;
    if (!manifest){
      qaThreads = [];
      displayThreads = [];
      manifestData = null;
      currentBundleMeta = {};
      lastFolderId = folderId;
      lastNotesSig = '';
      hideModal();
      updateFab();
      return;
    }
    
    lastFolderId = folderId;
    manifestData = manifest;
    currentBundleMeta = (bundle && bundle.app_metadata && typeof bundle.app_metadata === 'object')
      ? cloneJson(bundle.app_metadata, {})
      : {};
    if (Object.keys(currentBundleMeta).length) {
      window.currentProjectLoadedAppMetadata = cloneJson(currentBundleMeta, {});
    }
    activeThreadScope = getThreadScopeForManifest(manifest);
    
    // Keep the active correction scope editable, while also showing feedback
    // from the other review stage as read-only project history.
    const threadsByScope = {
      qa: mergeThreadDrafts(
        manifest.qa_threads,
        getDraftThreadsFromMeta(currentBundleMeta, 'qa')
      ),
      manager: mergeThreadDrafts(
        manifest.manager_threads,
        getDraftThreadsFromMeta(currentBundleMeta, 'manager')
      )
    };
    qaThreads = threadsByScope[activeThreadScope];
    displayThreads = buildDisplayThreads(threadsByScope, activeThreadScope);
    
    const sig = JSON.stringify(displayThreads) + '|' + (manifest.tech_notes || '') + '|' + JSON.stringify(manifest.resubmissions || []);
    const changed = sig !== lastNotesSig;
    lastNotesSig = sig;
    
    updateFab();
    
    // Auto-show modal if there are open issues (kickback)
    const hasOpenIssues = qaThreads.some(t => t.status === 'open');
    if (hasOpenIssues && changed){
      showModal();
      renderThreads();
    }

    // ---- Residential multi-structure gate ----
    // Fires AFTER QA modal logic so it layers on top (z-index 11000 vs 9001)
    await maybeShowResidentialGate(manifest, folderId);
  }
  
  // ---------- hooks ----------
  function hookLoadProject(){
    if (window.__drafterQaHooked) return;
    window.__drafterQaHooked = true;
    
    const orig = window.loadProjectFromFolder;
    if (typeof orig !== 'function') return;
    
    window.loadProjectFromFolder = async function(folderHash){
      const ret = await orig.apply(this, arguments);
      const fid = folderHash || window.currentProjectId;
      setTimeout(() => { refreshForFolder(fid).catch(() => {}); }, 100);
      return ret;
    };
  }
  
  function startLightPoll(){
    if (window.__drafterQaPoll) return;
    window.__drafterQaPoll = setInterval(() => {
      const fid = window.currentProjectId;
      if (fid && fid !== lastFolderId){
        refreshForFolder(fid).catch(() => {});
      }
    }, 2000);
  }

  function hookVisibilityRefresh(){
    if (window.__drafterQaVisibilityRefreshHooked) return;
    window.__drafterQaVisibilityRefreshHooked = true;
    const refreshCurrent = () => {
      const fid = window.currentProjectId;
      if (fid) refreshForFolder(fid).catch(() => {});
    };
    window.addEventListener('focus', refreshCurrent);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshCurrent();
    });
  }
  
  function init(){
    hookLoadProject();
    hookVisibilityRefresh();
    ensureUI();
    
    // Expose API
    window.DrafterQA = {
      refresh: () => refreshForFolder(window.currentProjectId),
      showLightbox: showLightbox,
      show: showModal,
      hide: hideModal,
      // API for report.js integration
      checkAllHandled: areAllThreadsHandled,
      submitSilent: submitFixesSilent, 
      hasNotes: () => qaThreads.length > 0,
      addFeedback: addFeedbackFromExternal,
      getThreads: () => cloneJson(qaThreads, [])
    };
    
    if (window.currentProjectId){
      refreshForFolder(window.currentProjectId).catch(() => {});
    }
    
    startLightPoll();
  }
  
  // Wait for DOM
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
