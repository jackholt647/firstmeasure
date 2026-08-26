/**
 * monitor.js
 * SESSION MONITOR + QUEUE PRIORITIZATION ENGINE + AFK / KICK DETECTION
 *
 * Features:
 *  1. Aggressive session monitoring (checks every 10s, re-auth modal on expiry)
 *  2. Queue mode awareness (disabled / wait_for_feedback / hot_swap)
 *  3. Hot-swap detection: periodically checks for higher-priority projects
 *     - Filler → non-filler or correction  = SWAP
 *     - Non-filler → correction             = SWAP
 *     - Correction → never swap
 *  4. Auto-saves work before showing swap modal
 *  5. Fetch interception to guard critical saves
 *  6. AFK detection: 4-min idle warning, kicked after 1 further minute
 *  7. Admin force-kick: polls every 5 s, shows 10-s countdown then redirects
 *
 * Required globals (set by main.js / editor):
 *   window.loadProjectFromFolder(folder)  – loads a project
 *   window.saveProjectData(silent, fast)   – saves current project
 *
 * The monitor will wrap loadProjectFromFolder to track the current folder.
 */
(function () {
    'use strict';

    // ======================== CONFIGURATION ========================
    const CONFIG = {
        SESSION_CHECK_INTERVAL:  10_000,   // 10 s
        HOT_SWAP_CHECK_INTERVAL: 30_000,   // 30 s
        KICK_POLL_INTERVAL:       5_000,   //  5 s  – force-kick detection
        PRESENCE_PING_INTERVAL:  15_000,   // 15 s  – editor presence heartbeat
        AFK_KICK_ENABLED:             false,
        AFK_WARNING_MS:         9 * 60_000, //  4 min idle → show warning
        AFK_KICK_MS:            10 * 60_000, //  5 min total idle → kick
        KICK_COUNTDOWN_SECS:          10,   // seconds shown in force-kick modal
        PORTAL_URL:          'portal.php',  // redirect destination after kick
        CHECK_BEFORE_SAVE:           true,  // verify session before critical saves
        AUTO_RESUME:                 true,  // retry pending request after re-auth
        DEBUG:                       true
    };

    const IS_HEADLESS_EMBEDDED = (() => {
        try {
            const params = new URLSearchParams(window.location.search || '');
            const truthy = (name) => {
                if (!params.has(name)) return false;
                const value = String(params.get(name) || '').trim().toLowerCase();
                return value === '' || !['0', 'false', 'no', 'off'].includes(value);
            };
            return truthy('qa_embed')
                || truthy('headless')
                || (truthy('embedded') && (truthy('hide_header') || truthy('hideHeader') || truthy('no_header')));
        } catch (e) {
            return false;
        }
    })();
    window.FIRSTMEASURE_HEADLESS_EMBEDDED = IS_HEADLESS_EMBEDDED;

    function internalLegacyActionUrl() {
        const firstMeasureBase = String(window.FIRSTMEASURE_API_BASE || '').replace(/\/+$/, '');
        if (firstMeasureBase) {
            return `${firstMeasureBase.replace(/\/firstmeasure\/?$/, '')}/internal/legacy-action`;
        }
        const host = (location.hostname || '').toLowerCase();
        const v1Base = (host === '127.0.0.1' || host === 'localhost')
            ? 'http://127.0.0.1:3111/v1'
            : `${location.origin}/v1`;
        return `${v1Base}/internal/legacy-action`;
    }

    function platformAuthLegacyActionUrl() {
        const firstMeasureBase = String(window.FIRSTMEASURE_API_BASE || '').replace(/\/+$/, '');
        if (firstMeasureBase) {
            return `${firstMeasureBase.replace(/\/firstmeasure\/?$/, '')}/platform/auth/legacy-action`;
        }
        const host = (location.hostname || '').toLowerCase();
        const v1Base = (host === '127.0.0.1' || host === 'localhost')
            ? 'http://127.0.0.1:3111/v1'
            : `${location.origin}/v1`;
        return `${v1Base}/platform/auth/legacy-action`;
    }

    function appendActor(formData) {
        const actor = window.FIRSTMEASURE_ACTOR || {};
        if (actor.email && !formData.has('actor_email')) formData.append('actor_email', actor.email);
        if (actor.name && !formData.has('actor_name')) formData.append('actor_name', actor.name);
        if (actor.role && !formData.has('actor_role')) formData.append('actor_role', actor.role);
        return formData;
    }

    function postInternalLegacy(formData) {
        return fetch(internalLegacyActionUrl(), {
            method: 'POST',
            body: appendActor(formData)
        });
    }

    async function reauthenticateWithNodeAuth(form) {
        const payload = Object.fromEntries(new FormData(form).entries());
        payload.action = 'login';

        const loginRes = await fetch(platformAuthLegacyActionUrl(), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const loginData = await loginRes.json().catch(() => ({}));
        if (!loginRes.ok || loginData.success === false) {
            return loginData;
        }

        const hydrate = new URLSearchParams();
        hydrate.set('action', 'hydrate_node_session');
        const hydrateRes = await fetch('backend_login.php', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: hydrate.toString()
        });
        const hydrateData = await hydrateRes.json().catch(() => ({}));
        if (!hydrateRes.ok || hydrateData.success === false) {
            return hydrateData;
        }
        return { ...loginData, ...hydrateData, success: true };
    }

    // ======================== STATE ================================
    let sessionModalOpen   = false;
    let hotSwapModalOpen   = false;
    let kickModalOpen      = false;
    let afkModalOpen       = false;
    let isCheckingSession  = false;
    let isCheckingHotSwap  = false;
    let pendingRequest     = null;

    let sessionCheckTimer  = null;
    let hotSwapCheckTimer  = null;
    let kickPollTimer      = null;
    let presencePingTimer  = null;
    let afkWarningTimer    = null;
    let afkKickTimer       = null;
    let kickCountdownTimer = null;

    let lastSessionCheck   = 0;
    let sessionCheckCount  = 0;

    let userQueueMode      = 'disabled';   // disabled | wait_for_feedback | hot_swap
    let currentFolder      = null;         // tracked via loadProjectFromFolder wrapper
    let pendingHotSwap     = null;         // { folder, address, reason }
    let hotSwapDismissedAt = 0;            // cooldown after dismiss

    // AFK
    let lastActivityTime   = Date.now();   // updated on any user interaction
    let afkWarningShown    = false;
    let lastAfkExemptStatus = null;

    const AFK_ACTIVE_PROJECT_STATUSES = new Set([
        'not_started',
        'queued',
        'ready',
        'submitted',
        'processing',
        'in_progress',
        'draft',
        'drafting',
        'correction_needed',
        'requeue'
    ]);

    const AFK_REVIEW_PROJECT_STATUSES = new Set([
        'awaiting_review',
        'awaiting_manager_review',
        'qa_waiting',
        'qa_in_progress',
        'pending_rejection',
        'completed',
        'rejected',
        'rejected_no_coverage',
        'cancelled'
    ]);

    // ======================== LOGGING ==============================
    function log(...args) {
        if (CONFIG.DEBUG) console.log('[Monitor]', ...args);
    }

    function normalizeProjectStatus(status) {
        if (typeof window.firstMeasureNormalizeProjectStatus === 'function') {
            return window.firstMeasureNormalizeProjectStatus(status);
        }
        return String(status || '').toLowerCase().trim().replace(/\s+/g, '_');
    }

    function getCachedProjectManifest() {
        return window.currentProjectManifest && typeof window.currentProjectManifest === 'object'
            ? window.currentProjectManifest
            : null;
    }

    function getProjectStatusFromManifest(manifest) {
        return normalizeProjectStatus(manifest && manifest.status);
    }

    function shouldAfkKickForManifest(manifest) {
        const status = getProjectStatusFromManifest(manifest);
        if (AFK_REVIEW_PROJECT_STATUSES.has(status)) return false;
        if (AFK_ACTIVE_PROJECT_STATUSES.has(status)) return true;
        return true;
    }

    async function refreshCurrentProjectManifest() {
        if (!currentFolder || typeof window.firstMeasureGetProjectManifest !== 'function') {
            return getCachedProjectManifest();
        }

        try {
            return await window.firstMeasureGetProjectManifest(currentFolder, { refresh: true });
        } catch (e) {
            log('AFK status refresh failed; using cached manifest:', e.message);
            return getCachedProjectManifest();
        }
    }

    function pauseAfkForReviewStatus(status) {
        hideAfkWarningModal();
        lastActivityTime = Date.now();
        if (lastAfkExemptStatus !== status) {
            lastAfkExemptStatus = status;
            log('AFK kick disabled for project status:', status || '(unknown)');
        }
    }

    // ================================================================
    //  SECTION 1 — SESSION CHECKING
    // ================================================================

    async function checkSession() {
        if (IS_HEADLESS_EMBEDDED) return true;
        if (isCheckingSession) return true;
        isCheckingSession = true;
        sessionCheckCount++;
        lastSessionCheck = Date.now();

        try {
            const ctrl = new AbortController();
            const tid  = setTimeout(() => ctrl.abort(), 5000);

            const res = await fetch(window.location.href, {
                method:      'HEAD',
                credentials: 'same-origin',
                signal:      ctrl.signal,
                cache:       'no-store'
            });
            clearTimeout(tid);

            const finalUrl = res.url || window.location.href;
            if (finalUrl.includes('login') || finalUrl.includes('backend_login')) {
                log('Session EXPIRED (redirect detected)');
                return false;
            }
            if (res.status === 401 || res.status === 403) {
                log('Session EXPIRED (status ' + res.status + ')');
                return false;
            }
            log('Session OK  (#' + sessionCheckCount + ')');
            return true;
        } catch (e) {
            if (e.name === 'AbortError') { log('Session check timeout'); return true; }
            log('Session check error:', e.message);
            return true;   // assume valid on network hiccup
        } finally {
            isCheckingSession = false;
        }
    }

    // ================================================================
    //  SECTION 2 — SESSION EXPIRED MODAL
    // ================================================================

    function injectSessionModal() {
        if (document.getElementById('session-monitor-modal')) return;
        const html = `
        <div id="session-monitor-modal" style="
            display:none; position:fixed; top:0; left:0; width:100vw; height:100vh;
            background:rgba(0,0,0,0.85); z-index:999999; align-items:center;
            justify-content:center; backdrop-filter:blur(4px); animation:smFadeIn .2s ease-out;">
          <div style="background:#fff; border-radius:12px; box-shadow:0 20px 60px rgba(0,0,0,.5);
              width:420px; max-width:90vw; overflow:hidden; animation:smSlideUp .3s ease-out;">
            <div style="background:linear-gradient(135deg,#d93025,#b0261e); color:#fff;
                padding:24px; text-align:center; border-bottom:3px solid #8b1e17;">
              <i class="fas fa-lock" style="font-size:32px; margin-bottom:10px; opacity:.9;"></i>
              <h2 style="margin:8px 0 4px; font-size:18px; font-weight:700;">Session Expired</h2>
              <p style="margin:0; font-size:13px; opacity:.9;">Please log in again to continue</p>
            </div>
            <div style="padding:30px;">
              <form id="session-reauth-form" autocomplete="on">
                <div style="margin-bottom:18px;">
                  <label style="display:block; font-size:11px; font-weight:700; color:#5f6368;
                      margin-bottom:6px; text-transform:uppercase; letter-spacing:.5px;">Email</label>
                  <input type="email" name="email" id="session-email" required autocomplete="username"
                      style="width:100%; padding:12px; border:2px solid #e0e0e0; border-radius:6px;
                      font-size:14px; box-sizing:border-box;"
                      onfocus="this.style.borderColor='#d93025'" onblur="this.style.borderColor='#e0e0e0'">
                </div>
                <div style="margin-bottom:24px;">
                  <label style="display:block; font-size:11px; font-weight:700; color:#5f6368;
                      margin-bottom:6px; text-transform:uppercase; letter-spacing:.5px;">Password</label>
                  <input type="password" name="password" id="session-password" required autocomplete="current-password"
                      style="width:100%; padding:12px; border:2px solid #e0e0e0; border-radius:6px;
                      font-size:14px; box-sizing:border-box;"
                      onfocus="this.style.borderColor='#d93025'" onblur="this.style.borderColor='#e0e0e0'">
                </div>
                <button type="submit" id="session-login-btn" style="width:100%; padding:14px;
                    background:#d93025; color:#fff; border:none; border-radius:6px; font-size:14px;
                    font-weight:700; cursor:pointer; text-transform:uppercase; letter-spacing:1px;"
                    onmouseover="this.style.background='#b0261e'" onmouseout="this.style.background='#d93025'">
                  Log In
                </button>
                <div id="session-error" style="display:none; margin-top:16px; padding:12px;
                    background:#ffebee; border:1px solid #ffcdd2; border-radius:6px; color:#c62828;
                    font-size:13px; text-align:center;"></div>
              </form>
              <div style="text-align:center; margin-top:20px; padding-top:20px; border-top:1px solid #f0f0f0;">
                <p style="margin:0; font-size:12px; color:#999;">
                  <i class="fas fa-shield-alt" style="color:#4caf50; margin-right:4px;"></i>
                  Your work has been preserved and will save after login
                </p>
              </div>
            </div>
          </div>
        </div>
        <style>
          @keyframes smFadeIn  { from{opacity:0}  to{opacity:1} }
          @keyframes smSlideUp { from{transform:translateY(30px);opacity:0} to{transform:translateY(0);opacity:1} }
        </style>`;
        document.body.insertAdjacentHTML('beforeend', html);
        document.getElementById('session-reauth-form').addEventListener('submit', handleReauth);
    }

    function showSessionModal() {
        if (sessionModalOpen) return;
        const m = document.getElementById('session-monitor-modal');
        if (!m) { injectSessionModal(); return showSessionModal(); }
        m.style.display = 'flex';
        sessionModalOpen = true;

        const emailIn = document.getElementById('session-email');
        const stored  = sessionStorage.getItem('userEmail') || '';
        if (emailIn && stored) { emailIn.value = stored; document.getElementById('session-password').focus(); }
        else if (emailIn) emailIn.focus();
    }

    function hideSessionModal() {
        const m = document.getElementById('session-monitor-modal');
        if (m) m.style.display = 'none';
        sessionModalOpen = false;
        const pw = document.getElementById('session-password');
        if (pw) pw.value = '';
    }

    async function handleReauth(e) {
        e.preventDefault();
        const btn = document.getElementById('session-login-btn');
        const err = document.getElementById('session-error');
        btn.disabled = true; btn.textContent = 'Authenticating...'; err.style.display = 'none';

        try {
            const data = await reauthenticateWithNodeAuth(e.target);

            if (data.success) {
                const em = e.target.querySelector('[name="email"]').value;
                if (em) sessionStorage.setItem('userEmail', em);
                hideSessionModal();
                if (CONFIG.AUTO_RESUME && pendingRequest) {
                    const { url, options } = pendingRequest;
                    pendingRequest = null;
                    fetch(url, options).catch(() => {});
                }
                fetchQueueMode();
                return;
            }
            if (data.require_otp) {
                err.textContent = 'OTP required — redirecting to login…';
                err.style.display = 'block';
                setTimeout(() => { window.location.href = 'backend_login.php'; }, 2000);
                return;
            }
            err.textContent = data.error || 'Login failed';
            err.style.display = 'block';
        } catch (ex) {
            err.textContent = 'Connection error. Please try again.';
            err.style.display = 'block';
        } finally {
            btn.disabled = false; btn.textContent = 'Log In';
        }
    }

    // ================================================================
    //  SECTION 3 — FETCH INTERCEPTION  (guards critical saves)
    // ================================================================

    function interceptFetch() {
        if (IS_HEADLESS_EMBEDDED) {
            log('Fetch interceptor skipped for headless embedded mode');
            return;
        }
        const original = window.fetch;
        window.fetch = async function (url, options) {
            if (typeof url !== 'string' || !url.includes('/v1/firstmeasure/')) return original.apply(this, arguments);
            if (!options || options.method !== 'POST' || !(options.body instanceof FormData)) return original.apply(this, arguments);

            const action     = options.body.get('action');
            const isCritical = ['save', 'save_image', 'set_status', 'create', 'queue',
                                'upload_report', 'upload_summary', 'upload_model_data'].includes(action);

            if (CONFIG.CHECK_BEFORE_SAVE && isCritical) {
                const valid = await checkSession();
                if (!valid) {
                    pendingRequest = { url, options: { ...options } };
                    showSessionModal();
                    return new Response(JSON.stringify({ success: false, pending: true,
                        message: 'Session expired. Please log in to save your work.' }),
                        { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
            }
            return original.apply(this, arguments);
        };
        log('Fetch interceptor installed');
    }

    // ================================================================
    //  SECTION 4 — QUEUE MODE
    // ================================================================

    async function fetchQueueMode() {
        if (IS_HEADLESS_EMBEDDED) return;
        try {
            const fd = new FormData();
            fd.append('action', 'get_user_queue_mode');
            const res  = await postInternalLegacy(fd);
            const data = await res.json();
            if (data.success) {
                userQueueMode = data.queue_mode || 'disabled';
                log('Queue mode:', userQueueMode, '(' + (data.queue_mode_label || '') + ')');
                if (data.blocked) log('Queue BLOCKED:', data.blocked_reason);
                orchestrateTimers();
            }
        } catch (e) {
            log('Failed to fetch queue mode:', e.message);
        }
    }

    // ================================================================
    //  SECTION 5 — HOT-SWAP DETECTION
    // ================================================================

    async function checkHotSwap() {
        if (IS_HEADLESS_EMBEDDED) return;
        if (isCheckingHotSwap) return;
        if (userQueueMode !== 'hot_swap') return;
        if (!currentFolder) return;
        if (hotSwapModalOpen) return;
        if (hotSwapDismissedAt && (Date.now() - hotSwapDismissedAt < 60000)) return;

        isCheckingHotSwap = true;
        try {
            const fd = new FormData();
            fd.append('action', 'check_hot_swap');
            fd.append('current_folder', currentFolder);

            const res  = await postInternalLegacy(fd);
            const data = await res.json();

            if (!data.success) { log('Hot-swap check error:', data.error); return; }

            if (data.has_swap) {
                log('🔥 HOT SWAP available →', data.target_folder, '(' + data.reason + ')');
                pendingHotSwap = {
                    folder:  data.target_folder,
                    address: data.target_address || '',
                    reason:  data.reason || 'higher_priority'
                };
                await autoSaveThenShowSwapModal();
            } else {
                log('No swap needed (' + (data.reason || '-') + ')');
            }
        } catch (e) {
            log('Hot-swap check failed:', e.message);
        } finally {
            isCheckingHotSwap = false;
        }
    }

    async function autoSaveThenShowSwapModal() {
        if (typeof window.saveProjectData === 'function') {
            try {
                log('Auto-saving before swap modal…');
                await window.saveProjectData(true, true);
                log('Auto-save complete');
            } catch (e) {
                log('Auto-save failed (non-blocking):', e.message);
            }
        }
        showHotSwapModal();
    }

    // ================================================================
    //  SECTION 6 — HOT-SWAP MODAL
    // ================================================================

    function injectHotSwapModal() {
        if (document.getElementById('hot-swap-modal')) return;

        const html = `
        <div id="hot-swap-modal" style="
            display:none; position:fixed; top:0; left:0; width:100vw; height:100vh;
            background:rgba(0,0,0,0.80); z-index:999998; align-items:center;
            justify-content:center; backdrop-filter:blur(3px); animation:smFadeIn .2s ease-out;">
          <div style="background:#fff; border-radius:12px; box-shadow:0 20px 60px rgba(0,0,0,.5);
              width:480px; max-width:92vw; overflow:hidden; animation:smSlideUp .3s ease-out;">
            <div style="background:linear-gradient(135deg,#e65100,#bf360c); color:#fff;
                padding:24px; text-align:center; border-bottom:3px solid #8b1e17;">
              <i class="fas fa-bolt" style="font-size:34px; margin-bottom:8px;"></i>
              <h2 style="margin:8px 0 4px; font-size:18px; font-weight:700;">Priority Project Available</h2>
            </div>
            <div style="padding:28px 30px;">
              <p id="hot-swap-message" style="font-size:14px; line-height:1.6; color:#333; margin:0 0 8px;"></p>
              <p id="hot-swap-address" style="font-size:13px; color:#666; margin:0 0 24px;
                  padding:10px 14px; background:#f5f5f5; border-radius:8px; word-break:break-word;"></p>
              <button id="hot-swap-accept-btn" onclick="window._monitorAcceptHotSwap()" style="
                  width:100%; padding:14px; background:#e65100; color:#fff; border:none;
                  border-radius:6px; font-size:14px; font-weight:700; cursor:pointer;
                  text-transform:uppercase; letter-spacing:1px; margin-bottom:10px;"
                  onmouseover="this.style.background='#bf360c'"
                  onmouseout="this.style.background='#e65100'">
                Switch to Priority Project
              </button>
              <button id="hot-swap-dismiss-btn" onclick="window._monitorDismissHotSwap()" style="
                  width:100%; padding:10px; background:transparent; color:#999; border:1px solid #ddd;
                  border-radius:6px; font-size:12px; cursor:pointer;"
                  onmouseover="this.style.background='#fafafa'"
                  onmouseout="this.style.background='transparent'">
                Continue Current Project
              </button>
              <div id="hot-swap-error" style="display:none; margin-top:14px; padding:10px;
                  background:#fff3e0; border:1px solid #ffe0b2; border-radius:6px; color:#e65100;
                  font-size:12px; text-align:center;"></div>
            </div>
          </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
    }

    function showHotSwapModal() {
        if (hotSwapModalOpen || !pendingHotSwap) return;
        const m = document.getElementById('hot-swap-modal');
        if (!m) { injectHotSwapModal(); return showHotSwapModal(); }

        const addrEl = document.getElementById('hot-swap-address');
        const msgEl  = document.getElementById('hot-swap-message');
        const errEl  = document.getElementById('hot-swap-error');
        if (errEl) errEl.style.display = 'none';

        const reasonText = (pendingHotSwap.reason === 'correction_available')
            ? 'A QA correction on a previously submitted project requires your attention. Your current work has been saved.'
            : 'A high-priority item has entered the queue. Your work has been saved. Please switch to the higher-priority project.';
        if (msgEl)  msgEl.textContent = reasonText;
        if (addrEl) addrEl.textContent = pendingHotSwap.address || pendingHotSwap.folder;

        m.style.display  = 'flex';
        hotSwapModalOpen = true;
    }

    function hideHotSwapModal() {
        const m = document.getElementById('hot-swap-modal');
        if (m) m.style.display = 'none';
        hotSwapModalOpen = false;
    }

    // ================================================================
    //  SECTION 7 — HOT-SWAP EXECUTION
    // ================================================================

    window._monitorAcceptHotSwap = async function () {
        if (!pendingHotSwap) { hideHotSwapModal(); return; }

        const btn   = document.getElementById('hot-swap-accept-btn');
        const errEl = document.getElementById('hot-swap-error');
        if (btn) { btn.disabled = true; btn.textContent = 'Switching…'; }
        if (errEl) errEl.style.display = 'none';

        try {
            const fd = new FormData();
            fd.append('action', 'execute_hot_swap');
            fd.append('target_folder', pendingHotSwap.folder);

            const res  = await postInternalLegacy(fd);
            const data = await res.json();

            if (!data.success) {
                if (errEl) { errEl.textContent = data.error || 'Project is no longer available.'; errEl.style.display = 'block'; }
                setTimeout(() => { hideHotSwapModal(); pendingHotSwap = null; }, 2500);
                return;
            }

            log('Hot-swap accepted → loading', data.folder);
            hideHotSwapModal();
            const folder = data.folder;
            pendingHotSwap = null;

            if (typeof window.loadProjectFromFolder === 'function') {
                await window.loadProjectFromFolder(folder);
            } else {
                localStorage.setItem('autoLoadProject', folder);
                window.location.reload();
            }
        } catch (e) {
            log('Hot-swap execute error:', e.message);
            if (errEl) { errEl.textContent = 'Error: ' + e.message; errEl.style.display = 'block'; }
            setTimeout(() => { hideHotSwapModal(); pendingHotSwap = null; }, 3000);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Switch to Priority Project'; }
        }
    };

    window._monitorDismissHotSwap = function () {
        log('Hot-swap dismissed by user');
        hideHotSwapModal();
        pendingHotSwap     = null;
        hotSwapDismissedAt = Date.now();
    };

    // ================================================================
    //  SECTION 8 — PROJECT FOLDER TRACKING
    // ================================================================

    function installFolderTracker() {
        if (typeof window.loadProjectFromFolder !== 'function') {
            log('loadProjectFromFolder not found — will retry in 1s');
            setTimeout(installFolderTracker, 1000);
            return;
        }
        const _orig = window.loadProjectFromFolder;
        window.loadProjectFromFolder = async function (folder) {
            const result = await _orig.apply(this, arguments);
            currentFolder = folder || null;
            log('Project folder tracked:', currentFolder);
            hotSwapDismissedAt = 0;
            if (currentFolder) pingEditorPresence();
            // Reset AFK timer whenever a new project is loaded
            resetAfkTimer();
            return result;
        };
        log('Folder tracker installed');
    }

    // ================================================================
    //  SECTION 9 — FORCE-KICK DETECTION
    // ================================================================

    /**
     * Polls the server every 5 s to check whether an admin has kicked
     * the current user off the project they're editing.
     */
    async function pollForKick() {
        if (IS_HEADLESS_EMBEDDED) return;
        if (!currentFolder) return;
        if (kickModalOpen)  return;  // already showing countdown

        try {
            const data = await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(currentFolder)}/force-kick/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    actor: window.FIRSTMEASURE_ACTOR || {}
                })
            });

            if (!data.success || !data.kicked) return;

            log('🚨 Force-kick received from', data.kicked_by);
            showKickModal({
                kickedBy: data.kicked_by  || 'An administrator',
                reason:   data.reason     || null,
                folder:   currentFolder,
            });
        } catch (e) {
            log('Kick poll error:', e.message);
        }
    }

    async function pingEditorPresence() {
        if (IS_HEADLESS_EMBEDDED) return;
        if (window.FIRSTMEASURE_SUBMITTED_STATE) return;
        if (!currentFolder) return;

        try {
            await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(currentFolder)}/editor/presence`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    actor: window.FIRSTMEASURE_ACTOR || {}
                })
            });
        } catch (e) {
            log('Editor presence ping failed:', e.message);
        }
    }

    // ================================================================
    //  SECTION 10 — FORCE-KICK MODAL  (10-second countdown)
    // ================================================================

    function injectKickModal() {
        if (document.getElementById('force-kick-modal')) return;
        const html = `
        <div id="force-kick-modal" style="
            display:none; position:fixed; top:0; left:0; width:100vw; height:100vh;
            background:rgba(0,0,0,0.90); z-index:1000001; align-items:center;
            justify-content:center; backdrop-filter:blur(5px); animation:smFadeIn .2s ease-out;">
          <div style="background:#fff; border-radius:16px; box-shadow:0 24px 80px rgba(0,0,0,.6);
              width:460px; max-width:92vw; overflow:hidden; animation:smSlideUp .3s ease-out;
              text-align:center;">

            <!-- Red header -->
            <div style="background:linear-gradient(135deg,#b71c1c,#7f0000); color:#fff; padding:28px 24px 20px;">
              <div style="font-size:48px; margin-bottom:8px;">🚫</div>
              <h2 style="margin:0 0 6px; font-size:20px; font-weight:800; letter-spacing:-.3px;">
                Removed from Project
              </h2>
              <p id="kick-by-line" style="margin:0; font-size:13px; opacity:.85;"></p>
            </div>

            <!-- Body -->
            <div style="padding:28px 32px 24px;">
              <div id="kick-reason-block" style="display:none; margin-bottom:16px; padding:12px 16px;
                  background:#fff3e0; border:1px solid #ffcc80; border-radius:10px; font-size:13px;
                  color:#e65100; text-align:left;">
                <b>Reason:</b> <span id="kick-reason-text"></span>
              </div>

              <p style="font-size:14px; color:#444; line-height:1.55; margin:0 0 20px;">
                Your work has been saved. You will be returned to the portal automatically.
              </p>

              <!-- Countdown ring -->
              <div style="position:relative; display:inline-block; margin-bottom:20px;">
                <svg width="88" height="88" style="transform:rotate(-90deg);">
                  <circle cx="44" cy="44" r="38" fill="none" stroke="#f0f0f0" stroke-width="7"/>
                  <circle id="kick-ring" cx="44" cy="44" r="38" fill="none"
                      stroke="#b71c1c" stroke-width="7"
                      stroke-dasharray="238.76" stroke-dashoffset="0"
                      style="transition:stroke-dashoffset 1s linear;"/>
                </svg>
                <div style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
                    font-size:26px; font-weight:800; color:#b71c1c; line-height:1;">
                  <span id="kick-countdown-num">10</span>
                </div>
              </div>

              <button onclick="window._monitorAcknowledgeKick()" style="
                  display:block; width:100%; padding:14px; background:#b71c1c; color:#fff;
                  border:none; border-radius:8px; font-size:14px; font-weight:700;
                  cursor:pointer; letter-spacing:.5px; transition:background .2s;"
                  onmouseover="this.style.background='#7f0000'"
                  onmouseout="this.style.background='#b71c1c'">
                Return to Portal Now
              </button>
            </div>
          </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
    }

    function showKickModal({ kickedBy, reason, folder }) {
        if (kickModalOpen) return;
        const m = document.getElementById('force-kick-modal');
        if (!m) { injectKickModal(); return showKickModal({ kickedBy, reason, folder }); }

        // Stop AFK timers — no point running them now
        clearAfkTimers();
        // Stop kick polling — we already have the signal
        if (kickPollTimer) { clearInterval(kickPollTimer); kickPollTimer = null; }

        const byLine      = document.getElementById('kick-by-line');
        const reasonBlock = document.getElementById('kick-reason-block');
        const reasonText  = document.getElementById('kick-reason-text');
        const numEl       = document.getElementById('kick-countdown-num');
        const ring        = document.getElementById('kick-ring');

        if (byLine) byLine.textContent = 'Removed by: ' + kickedBy;
        if (reason && reasonBlock && reasonText) {
            reasonText.textContent = reason;
            reasonBlock.style.display = 'block';
        }

        m.style.display = 'flex';
        kickModalOpen   = true;

        // Auto-save before we do anything
        if (typeof window.saveProjectData === 'function') {
            window.saveProjectData(true, true).catch(() => {});
        }

        // Acknowledge on the server immediately (releases the assignment)
        _serverAcknowledgeKick(folder);

        // 10-second countdown
        const total    = CONFIG.KICK_COUNTDOWN_SECS;
        const circumf  = 238.76;
        let remaining  = total;

        if (numEl)  numEl.textContent = remaining;
        if (ring)   ring.style.strokeDashoffset = '0';

        kickCountdownTimer = setInterval(() => {
            remaining--;
            if (numEl) numEl.textContent = Math.max(0, remaining);
            if (ring)  ring.style.strokeDashoffset = String(circumf * (1 - remaining / total));
            if (remaining <= 0) {
                clearInterval(kickCountdownTimer);
                kickCountdownTimer = null;
                _redirectToPortal();
            }
        }, 1000);
    }

    async function _serverAcknowledgeKick(folder) {
        try {
            await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(folder)}/force-kick/acknowledge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    actor: window.FIRSTMEASURE_ACTOR || {}
                })
            });
        } catch (e) {
            log('acknowledge_kick request failed (non-fatal):', e.message);
        }
    }

    window._monitorAcknowledgeKick = function () {
        if (kickCountdownTimer) { clearInterval(kickCountdownTimer); kickCountdownTimer = null; }
        _redirectToPortal();
    };

    // ================================================================
    //  SECTION 11 — AFK DETECTION
    // ================================================================

    /** Reset the idle clock on any real user interaction. */
    function resetAfkTimer() {
        if (IS_HEADLESS_EMBEDDED) return;
        lastActivityTime = Date.now();

        // If the AFK warning is showing, hide it
        if (afkWarningShown) {
            hideAfkWarningModal();
        }
    }

    function startAfkTracking() {
        if (!CONFIG.AFK_KICK_ENABLED) {
            log('AFK kick tracking temporarily disabled');
            return;
        }
        if (IS_HEADLESS_EMBEDDED) {
            log('AFK tracking skipped for headless embedded mode');
            return;
        }
        // Listen for any sign of life
        const events = ['keydown', 'keypress', 'touchstart', 'click'];
        events.forEach(ev => document.addEventListener(ev, resetAfkTimer, { passive: true }));

        // Check idle state every 15 seconds — lightweight
        setInterval(tickAfk, 15_000);
        log('AFK tracking started (warn:', CONFIG.AFK_WARNING_MS / 60000, 'min  kick:',
            CONFIG.AFK_KICK_MS / 60000, 'min)');
    }

    function tickAfk() {
        if (!CONFIG.AFK_KICK_ENABLED) return;
        if (!currentFolder) return;   // no project loaded — don't care
        if (kickModalOpen)  return;   // already being kicked

        const manifest = getCachedProjectManifest();
        const status = getProjectStatusFromManifest(manifest);
        if (!shouldAfkKickForManifest(manifest)) {
            pauseAfkForReviewStatus(status);
            return;
        }
        lastAfkExemptStatus = null;

        const idle = Date.now() - lastActivityTime;

        if (idle >= CONFIG.AFK_KICK_MS) {
            // Time's up — kick
            log('AFK kick threshold reached (' + Math.round(idle / 1000) + 's idle)');
            doAfkKick(Math.round(idle / 1000));
        } else if (idle >= CONFIG.AFK_WARNING_MS && !afkWarningShown) {
            log('AFK warning threshold reached (' + Math.round(idle / 1000) + 's idle)');
            showAfkWarningModal();
        }
    }

    async function doAfkKick(idleSeconds) {
        if (!CONFIG.AFK_KICK_ENABLED) return;
        clearAfkTimers();
        if (kickModalOpen) return;  // force-kick already in progress

        const manifest = await refreshCurrentProjectManifest();
        const status = getProjectStatusFromManifest(manifest);
        if (!shouldAfkKickForManifest(manifest)) {
            pauseAfkForReviewStatus(status);
            return;
        }
        lastAfkExemptStatus = null;

        // Auto-save first
        if (typeof window.saveProjectData === 'function') {
            try { await window.saveProjectData(true, true); } catch (e) { /* ignore */ }
        }

        // Report to server
        try {
            await window.firstMeasureFetchJson(`/projects/${encodeURIComponent(currentFolder)}/afk-kick`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    idle_seconds: idleSeconds,
                    actor: window.FIRSTMEASURE_ACTOR || {}
                })
            });
        } catch (e) {
            log('report_afk_kick failed (non-fatal):', e.message);
        }

        showAfkKickNotice();
    }

    function clearAfkTimers() {
        if (afkWarningTimer) { clearTimeout(afkWarningTimer);  afkWarningTimer = null; }
        if (afkKickTimer)    { clearTimeout(afkKickTimer);     afkKickTimer    = null; }
    }

    // ================================================================
    //  SECTION 12 — AFK WARNING MODAL
    // ================================================================

    function injectAfkWarningModal() {
        if (document.getElementById('afk-warning-modal')) return;
        const html = `
        <div id="afk-warning-modal" style="
            display:none; position:fixed; top:0; left:0; width:100vw; height:100vh;
            background:rgba(0,0,0,0.75); z-index:1000000; align-items:center;
            justify-content:center; backdrop-filter:blur(3px); animation:smFadeIn .2s ease-out;">
          <div style="background:#fff; border-radius:14px; box-shadow:0 20px 60px rgba(0,0,0,.5);
              width:420px; max-width:92vw; overflow:hidden; animation:smSlideUp .3s ease-out;
              text-align:center;">

            <!-- Amber header -->
            <div style="background:linear-gradient(135deg,#f57c00,#e65100); color:#fff; padding:26px 24px 18px;">
              <div style="font-size:44px; margin-bottom:6px;">⏰</div>
              <h2 style="margin:0 0 5px; font-size:18px; font-weight:800;">Are You Still There?</h2>
              <p style="margin:0; font-size:12px; opacity:.9;">
                You've been idle for 4 minutes
              </p>
            </div>

            <!-- Body -->
            <div style="padding:24px 28px 20px;">
              <p style="font-size:14px; color:#444; line-height:1.55; margin:0 0 8px;">
                You will be <strong>automatically removed from this project</strong>
                in <span id="afk-countdown-label" style="color:#e65100; font-weight:700;">1 minute</span>
                unless you interact with the page.
              </p>
              <p style="font-size:12px; color:#888; margin:0 0 22px;">
                Your work will be saved before you are removed.
              </p>

              <!-- Progress bar -->
              <div style="background:#f0f0f0; border-radius:8px; overflow:hidden; height:8px; margin-bottom:22px;">
                <div id="afk-progress-bar" style="height:100%; width:100%;
                    background:linear-gradient(90deg,#f57c00,#e65100);
                    border-radius:8px; transition:width 1s linear;"></div>
              </div>

              <button onclick="window._monitorAfkStillHere()" style="
                  display:block; width:100%; padding:14px; background:#f57c00; color:#fff;
                  border:none; border-radius:8px; font-size:14px; font-weight:700;
                  cursor:pointer; letter-spacing:.4px; transition:background .2s;"
                  onmouseover="this.style.background='#e65100'"
                  onmouseout="this.style.background='#f57c00'">
                I'm Still Here — Keep Working
              </button>
            </div>
          </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
    }

    function showAfkWarningModal() {
        if (afkWarningShown) return;
        const m = document.getElementById('afk-warning-modal');
        if (!m) { injectAfkWarningModal(); return showAfkWarningModal(); }

        m.style.display = 'flex';
        afkModalOpen    = true;
        afkWarningShown = true;

        // Animate the progress bar draining over 60 seconds
        const bar = document.getElementById('afk-progress-bar');
        if (bar) {
            bar.style.width = '100%';
            requestAnimationFrame(() => { bar.style.width = '0%'; });
        }

        // Update the countdown label every second
        let secsLeft = Math.round((CONFIG.AFK_KICK_MS - CONFIG.AFK_WARNING_MS) / 1000);
        const label  = document.getElementById('afk-countdown-label');
        const labelTick = setInterval(() => {
            secsLeft--;
            if (label) {
                label.textContent = secsLeft > 60
                    ? Math.ceil(secsLeft / 60) + ' minutes'
                    : secsLeft + (secsLeft === 1 ? ' second' : ' seconds');
            }
            if (secsLeft <= 0) clearInterval(labelTick);
        }, 1000);
        m._labelTick = labelTick;   // store so we can clear it

        log('AFK warning modal shown');
    }

    function hideAfkWarningModal() {
        const m = document.getElementById('afk-warning-modal');
        if (m) {
            m.style.display = 'none';
            if (m._labelTick) { clearInterval(m._labelTick); m._labelTick = null; }
        }
        afkModalOpen    = false;
        afkWarningShown = false;
    }

    /** User clicked "I'm Still Here" */
    window._monitorAfkStillHere = function () {
        log('AFK dismissed by user — resetting idle clock');
        resetAfkTimer();
    };

    // ================================================================
    //  SECTION 13 — AFK KICK NOTICE  (shown briefly before redirect)
    // ================================================================

    function showAfkKickNotice() {
        // Reuse the force-kick modal structure but with different copy
        const existing = document.getElementById('force-kick-modal');
        if (!existing) injectKickModal();

        const m       = document.getElementById('force-kick-modal');
        const byLine  = document.getElementById('kick-by-line');
        const numEl   = document.getElementById('kick-countdown-num');
        const ring    = document.getElementById('kick-ring');
        const rBlock  = document.getElementById('kick-reason-block');
        if (rBlock) rBlock.style.display = 'none';
        if (byLine) byLine.textContent   = 'Removed due to inactivity (AFK)';

        m.style.display = 'flex';
        kickModalOpen   = true;

        const total   = 5;   // shorter countdown for AFK — they already had their warning
        const circumf = 238.76;
        let remaining = total;
        if (numEl) numEl.textContent = remaining;
        if (ring)  ring.style.strokeDashoffset = '0';

        kickCountdownTimer = setInterval(() => {
            remaining--;
            if (numEl) numEl.textContent = Math.max(0, remaining);
            if (ring)  ring.style.strokeDashoffset = String(circumf * (1 - remaining / total));
            if (remaining <= 0) {
                clearInterval(kickCountdownTimer);
                kickCountdownTimer = null;
                _redirectToPortal();
            }
        }, 1000);
    }

    // ================================================================
    //  SECTION 14 — SHARED REDIRECT
    // ================================================================

    function _redirectToPortal() {
        log('Redirecting to portal:', CONFIG.PORTAL_URL);
        // Clear all timers before navigating
        if (sessionCheckTimer)  { clearInterval(sessionCheckTimer);  sessionCheckTimer  = null; }
        if (hotSwapCheckTimer)  { clearInterval(hotSwapCheckTimer);  hotSwapCheckTimer  = null; }
        if (kickPollTimer)      { clearInterval(kickPollTimer);      kickPollTimer      = null; }
        if (presencePingTimer)  { clearInterval(presencePingTimer);  presencePingTimer  = null; }
        if (kickCountdownTimer) { clearInterval(kickCountdownTimer); kickCountdownTimer = null; }
        clearAfkTimers();
        window.location.href = CONFIG.PORTAL_URL;
    }

    window.firstMeasureStopEditorMonitors = function () {
        window.FIRSTMEASURE_SUBMITTED_STATE = true;
        if (sessionCheckTimer)  { clearInterval(sessionCheckTimer);  sessionCheckTimer  = null; }
        if (hotSwapCheckTimer)  { clearInterval(hotSwapCheckTimer);  hotSwapCheckTimer  = null; }
        if (kickPollTimer)      { clearInterval(kickPollTimer);      kickPollTimer      = null; }
        if (presencePingTimer)  { clearInterval(presencePingTimer);  presencePingTimer  = null; }
        if (kickCountdownTimer) { clearInterval(kickCountdownTimer); kickCountdownTimer = null; }
        clearAfkTimers();
        currentFolder = null;
        log('Editor monitor timers stopped after project submission');
    };

    // ================================================================
    //  SECTION 15 — TIMER ORCHESTRATION
    // ================================================================

    function orchestrateTimers() {
        if (window.FIRSTMEASURE_SUBMITTED_STATE) {
            log('Monitor timers skipped for submitted project state');
            return;
        }
        if (IS_HEADLESS_EMBEDDED) {
            log('Monitor timers skipped for headless embedded mode');
            return;
        }
        // Session check — always active
        if (!sessionCheckTimer) {
            sessionCheckTimer = setInterval(async () => {
                const ok = await checkSession();
                if (!ok && !sessionModalOpen) showSessionModal();
            }, CONFIG.SESSION_CHECK_INTERVAL);
            log('Session timer started (' + (CONFIG.SESSION_CHECK_INTERVAL / 1000) + 's)');
        }

        // Kick poll — always active when a folder might be loaded
        if (!kickPollTimer) {
            kickPollTimer = setInterval(pollForKick, CONFIG.KICK_POLL_INTERVAL);
            log('Kick poll timer started (' + (CONFIG.KICK_POLL_INTERVAL / 1000) + 's)');
        }

        if (!presencePingTimer) {
            presencePingTimer = setInterval(pingEditorPresence, CONFIG.PRESENCE_PING_INTERVAL);
            log('Editor presence timer started (' + (CONFIG.PRESENCE_PING_INTERVAL / 1000) + 's)');
        }

        // Hot-swap check — only when mode is hot_swap
        if (userQueueMode === 'hot_swap') {
            if (!hotSwapCheckTimer) {
                hotSwapCheckTimer = setInterval(checkHotSwap, CONFIG.HOT_SWAP_CHECK_INTERVAL);
                log('Hot-swap timer started (' + (CONFIG.HOT_SWAP_CHECK_INTERVAL / 1000) + 's)');
            }
        } else {
            if (hotSwapCheckTimer) {
                clearInterval(hotSwapCheckTimer);
                hotSwapCheckTimer = null;
                log('Hot-swap timer stopped (mode: ' + userQueueMode + ')');
            }
        }
    }

    // ================================================================
    //  SECTION 16 — INITIALIZATION
    // ================================================================

    function init() {
        if (window.FIRSTMEASURE_SUBMITTED_STATE) {
            log('Submitted project state detected; monitor initialization skipped');
            return;
        }

        log('Initializing…');

        if (IS_HEADLESS_EMBEDDED) {
            log('Headless embedded mode detected; session, presence, force-kick, hot-swap, and AFK monitors disabled');
            return;
        }

        // Inject all modals
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                injectSessionModal();
                injectHotSwapModal();
                injectKickModal();
                injectAfkWarningModal();
            });
        } else {
            injectSessionModal();
            injectHotSwapModal();
            injectKickModal();
            injectAfkWarningModal();
        }

        // Install fetch interceptor
        interceptFetch();

        // Track which project folder is loaded + install AFK activity listeners
        installFolderTracker();
        startAfkTracking();

        // Fetch queue mode, then start appropriate timers
        setTimeout(() => {
            fetchQueueMode();
            checkSession();
        }, 2000);

        // Start session + kick poll timers immediately
        orchestrateTimers();

        log('Ready');
    }

    // ================================================================
    //  SECTION 17 — PUBLIC API
    // ================================================================

    window.SessionMonitor = {
        check:          checkSession,
        showLogin:      showSessionModal,
        hideLogin:      hideSessionModal,
        checkHotSwap:   checkHotSwap,
        refreshMode:    fetchQueueMode,
        resetAfk:       resetAfkTimer,
        config:         CONFIG,
        getStatus: () => ({
            sessionCheckCount,
            lastSessionCheck:    lastSessionCheck ? new Date(lastSessionCheck).toLocaleTimeString() : null,
            sessionModalOpen,
            hotSwapModalOpen,
            kickModalOpen,
            afkModalOpen,
            afkWarningShown,
            idleSeconds:         Math.round((Date.now() - lastActivityTime) / 1000),
            isCheckingSession,
            isCheckingHotSwap,
            userQueueMode,
            currentFolder,
            pendingHotSwap
        })
    };

    init();

})();
