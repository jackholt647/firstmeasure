/**
 * admin_tools.js - Portal plugin for admin maintenance tasks
 * Currently: Rebuild project index (SQLite), Auto-Filler settings
 */
(function () {
    const PLUGIN_ID = 'admin-tools';
    const cfg = window.PORTAL_CFG || {};
    // Only show for admins
    const isAdmin = cfg.perms?.is_admin_legacy || cfg.user?.role === 'admin';
    if (!isAdmin) return;
    // Register nav item
    Portal.registerPlugin({
        id: PLUGIN_ID,
        title: 'Admin Tools',
        iconClass: 'fas fa-wrench'
    });
    // Inject view HTML
    const viewHost = document.getElementById('portalPluginViews');
    if (!viewHost) return;
    const view = document.createElement('div');
    view.id = 'view-' + PLUGIN_ID;
    view.style.display = 'none';
    view.innerHTML = `
        <div class="header-bar">
            <h1>Admin Tools</h1>
        </div>

        <!-- Rebuild Index -->
        <div class="panel-card" style="max-width:700px;">
            <h3 style="margin:0 0 6px 0; font-size:15px;">
                <i class="fas fa-database" style="color:var(--primary); margin-right:6px;"></i>
                Rebuild Project Index
            </h3>
            <p style="font-size:13px; color:#666; margin:0 0 16px 0; line-height:1.5;">
                Scans every <code>manifest.json</code> on disk and rebuilds the SQLite index from scratch.
                This is safe to run at any time — it won't affect project data, only the search index.
            </p>
            <div id="atRebuildStatus" style="display:none; margin-bottom:14px; padding:12px 14px; border-radius:10px; font-size:13px; font-weight:700; line-height:1.4;"></div>
            <button id="btnRebuildIndex" class="btn-inline primary" onclick="AdminTools.rebuildIndex()" style="gap:10px;">
                <i class="fas fa-arrows-rotate"></i>
                Rebuild Index
            </button>
        </div>

        <!-- Rush Mode -->
        <div class="panel-card" style="max-width:700px; margin-top:18px;">
            <h3 style="margin:0 0 6px 0; font-size:15px;">
                <i class="fas fa-bolt" style="color:#ea580c; margin-right:6px;"></i>
                Rush Mode
            </h3>
            <p style="font-size:13px; color:#666; margin:0 0 16px 0; line-height:1.5;">
                Start a rush period now or queue one for a specific time. Projects completed during rush mode get a 25% bonus tag.
            </p>
            <div id="atRushCurrent" style="padding:10px 14px; border-radius:10px; background:#fff7ed; border:1px solid #fed7aa; color:#9a3412; font-size:13px; font-weight:800; margin-bottom:14px;">
                <i class="fas fa-spinner fa-spin"></i>&ensp;Loading rush status...
            </div>
            <div class="at-form-row">
                <label for="atRushDuration">Duration</label>
                <input type="number" id="atRushDuration" min="1" max="1440" step="1" value="60">
                <span>minutes</span>
            </div>
            <div class="at-form-row">
                <label for="atRushStartAt">Start time</label>
                <input type="datetime-local" id="atRushStartAt">
                <span>leave blank to start now</span>
            </div>
            <div id="atRushSaveStatus" style="display:none; margin-bottom:10px; padding:10px 14px; border-radius:10px; font-size:13px; font-weight:600; line-height:1.4;"></div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                <button class="btn-inline primary" onclick="AdminTools.startRushMode()" style="gap:8px; font-size:12px;">
                    <i class="fas fa-bolt"></i>
                    Start / Queue Rush
                </button>
                <button class="btn-inline" onclick="AdminTools.loadRushMode()" style="gap:8px; font-size:12px;">
                    <i class="fas fa-arrows-rotate"></i>
                    Refresh
                </button>
            </div>
            <div id="atRushHistory" style="margin-top:14px; display:grid; gap:6px;"></div>
            <div style="height:1px; background:#eceff3; margin:16px 0;"></div>
            <h4 style="margin:0 0 8px 0; font-size:13px; color:#9a3412;">
                <i class="fas fa-gears" style="margin-right:6px;"></i>
                Automatic Rush Mode
            </h4>
            <div id="atRushAutoLoading" style="padding:8px 0 12px; font-size:13px; color:#888;">
                <i class="fas fa-spinner fa-spin"></i>&ensp;Loading automation settings...
            </div>
            <div id="atRushAutoBody" style="display:none;">
                <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
                    <label style="font-size:13px; font-weight:700; min-width:130px;">Enabled</label>
                    <label class="at-toggle-wrap" style="position:relative; display:inline-block; width:44px; height:24px; flex-shrink:0;">
                        <input type="checkbox" id="atRushAutoEnabled"
                               style="opacity:0; width:0; height:0; position:absolute;"
                               onchange="AdminTools._syncRushAutomationLabels()">
                        <span class="at-toggle-track"></span>
                    </label>
                    <span id="atRushAutoEnabledLabel" style="font-size:12px; color:#888;"></span>
                </div>
                <div class="at-form-row">
                    <label for="atRushAutoRequestThreshold">Requests</label>
                    <input type="number" id="atRushAutoRequestThreshold" min="1" max="10000" step="1" value="30" oninput="AdminTools._syncRushAutomationLabels()">
                    <span>trigger after more than this many requested projects</span>
                </div>
                <div class="at-form-row">
                    <label for="atRushAutoWindowMinutes">Time window</label>
                    <input type="number" id="atRushAutoWindowMinutes" min="1" max="1440" step="1" value="60" oninput="AdminTools._syncRushAutomationLabels()">
                    <span>minutes to count requested projects</span>
                </div>
                <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
                    <label style="font-size:13px; font-weight:700; min-width:130px;">Queue condition</label>
                    <label class="at-toggle-wrap" style="position:relative; display:inline-block; width:44px; height:24px; flex-shrink:0;">
                        <input type="checkbox" id="atRushAutoQueueEnabled"
                               style="opacity:0; width:0; height:0; position:absolute;"
                               onchange="AdminTools._syncRushAutomationLabels()">
                        <span class="at-toggle-track"></span>
                    </label>
                    <span id="atRushAutoQueueEnabledLabel" style="font-size:12px; color:#888;"></span>
                </div>
                <div class="at-form-row">
                    <label for="atRushAutoQueueThreshold">Queue projects</label>
                    <input type="number" id="atRushAutoQueueThreshold" min="0" max="10000" step="1" value="0" oninput="AdminTools._syncRushAutomationLabels()">
                    <span>trigger only when queue is greater than this number</span>
                </div>
                <div class="at-form-row">
                    <label for="atRushAutoDuration">Rush duration</label>
                    <input type="number" id="atRushAutoDuration" min="1" max="1440" step="1" value="60" oninput="AdminTools._syncRushAutomationLabels()">
                    <span>minutes automatic rush mode stays active</span>
                </div>
                <div id="atRushAutoSummary" style="font-size:12px; color:#667085; line-height:1.45; margin:0 0 12px 142px;"></div>
                <div id="atRushAutoSaveStatus" style="display:none; margin-bottom:10px; padding:10px 14px; border-radius:10px; font-size:13px; font-weight:600; line-height:1.4;"></div>
                <button class="btn-inline primary" onclick="AdminTools.saveRushAutomation()" style="gap:8px; font-size:12px;">
                    <i class="fas fa-save"></i>
                    Save Automatic Rush
                </button>
            </div>
        </div>

        <!-- QA Settings -->
        <div class="panel-card" style="max-width:700px; margin-top:18px;">
            <h3 style="margin:0 0 6px 0; font-size:15px;">
                <i class="fas fa-clipboard-check" style="color:var(--primary); margin-right:6px;"></i>
                QA Workflow
            </h3>
            <p style="font-size:13px; color:#666; margin:0 0 16px 0; line-height:1.5;">
                Company-wide controls for how QA handles correction decisions.
            </p>

            <div id="atQaLoading" style="padding:12px 0; font-size:13px; color:#888;">
                <i class="fas fa-spinner fa-spin"></i>&ensp;Loading settings...
            </div>

            <div id="atQaBody" style="display:none;">
                <div style="display:flex; align-items:center; gap:12px; margin-bottom:10px;">
                    <label style="font-size:13px; font-weight:600; min-width:130px;">Fix-only mode</label>
                    <label class="at-toggle-wrap" style="position:relative; display:inline-block; width:44px; height:24px; flex-shrink:0;">
                        <input type="checkbox" id="atQaFixOnlyMode"
                               style="opacity:0; width:0; height:0; position:absolute;"
                               onchange="AdminTools.saveQaSettings()">
                        <span class="at-toggle-track"></span>
                    </label>
                    <span id="atQaFixOnlyLabel" style="font-size:12px; color:#888;"></span>
                </div>
                <div style="font-size:12px; color:#666; line-height:1.45; margin:0 0 12px 142px;">
                    When enabled, QA can approve clean projects or correct issues themselves, but cannot request technician corrections.
                </div>
                <div id="atQaSaveStatus" style="display:none; margin-bottom:10px; padding:10px 14px; border-radius:10px; font-size:13px; font-weight:600; line-height:1.4;"></div>
            </div>
        </div>

        <!-- Production Queue Settings -->
        <div class="panel-card" style="max-width:700px; margin-top:18px;">
            <h3 style="margin:0 0 6px 0; font-size:15px;">
                <i class="fas fa-forward" style="color:var(--primary); margin-right:6px;"></i>
                Production Queue Pulls
            </h3>
            <p style="font-size:13px; color:#666; margin:0 0 16px 0; line-height:1.5;">
                Controls how the Next in Queue button picks from the newest time bucket after assigned, reserved, correction, and VIP rules are applied.
            </p>

            <div id="atQueueLoading" style="padding:12px 0; font-size:13px; color:#888;">
                <i class="fas fa-spinner fa-spin"></i>&ensp;Loading settings...
            </div>

            <div id="atQueueBody" style="display:none;">
                <div class="at-form-row">
                    <label for="atQueueWindowMinutes">Priority window</label>
                    <input type="number" id="atQueueWindowMinutes" min="1" max="240" step="1" value="15">
                    <span>minutes per queue bucket</span>
                </div>
                <div class="at-form-row at-form-row-wide">
                    <label for="atQueueSeniorOrder">Senior order</label>
                    <input type="text" id="atQueueSeniorOrder" value="5,4,3,2,1">
                    <span>complexity levels, first to last</span>
                </div>
                <div class="at-form-row at-form-row-wide">
                    <label for="atQueueStandardOrder">Standard order</label>
                    <input type="text" id="atQueueStandardOrder" value="3,4,2,1,5">
                    <span>complexity levels, first to last</span>
                </div>
                <div class="at-form-row at-form-row-wide">
                    <label for="atQueueJuniorOrder">Junior order</label>
                    <input type="text" id="atQueueJuniorOrder" value="1,2,3,4,5">
                    <span>complexity levels, first to last</span>
                </div>
                <div style="font-size:12px; color:#666; line-height:1.45; margin:4px 0 14px 142px;">
                    Defaults: senior pulls 5→4→3→2→1, standard pulls 3→4→2→1→5, junior pulls 1→2→3→4→5.
                </div>
                <div id="atQueueSaveStatus" style="display:none; margin-bottom:10px; padding:10px 14px; border-radius:10px; font-size:13px; font-weight:600; line-height:1.4;"></div>
                <button class="btn-inline primary" onclick="AdminTools.saveQueueSettings()" style="gap:8px; font-size:12px;">
                    <i class="fas fa-save"></i>
                    Save Queue Pull Settings
                </button>
            </div>
        </div>

        <!-- Auto-Filler Settings -->
        <div class="panel-card" style="max-width:700px; margin-top:18px;">
            <h3 style="margin:0 0 6px 0; font-size:15px;">
                <i class="fas fa-fill-drip" style="color:var(--primary); margin-right:6px;"></i>
                Auto-Filler Projects
            </h3>
            <p style="font-size:13px; color:#666; margin:0 0 16px 0; line-height:1.5;">
                Automatically creates filler projects from <code>addresses.json</code> when the unstarted queue
                drops below a threshold. Fillers keep drafters productive during slow periods.
            </p>

            <div id="atFillerLoading" style="padding:12px 0; font-size:13px; color:#888;">
                <i class="fas fa-spinner fa-spin"></i>&ensp;Loading settings…
            </div>

            <div id="atFillerBody" style="display:none;">
                <!-- Toggle -->
                <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
                    <label style="font-size:13px; font-weight:600; min-width:130px;">Enabled</label>
                    <label class="at-toggle-wrap" style="position:relative; display:inline-block; width:44px; height:24px; flex-shrink:0;">
                        <input type="checkbox" id="atFillerEnabled"
                               style="opacity:0; width:0; height:0; position:absolute;"
                               onchange="AdminTools.saveFillerSettings()">
                        <span class="at-toggle-track"></span>
                    </label>
                    <span id="atFillerEnabledLabel" style="font-size:12px; color:#888;"></span>
                </div>

                <!-- Threshold -->
                <div style="display:flex; align-items:center; gap:12px; margin-bottom:18px;">
                    <label for="atFillerThreshold" style="font-size:13px; font-weight:600; min-width:130px;">Min Queue Depth</label>
                    <input type="number" id="atFillerThreshold" min="1" max="50" value="2"
                           style="width:72px; padding:6px 10px; border:1px solid #ccc; border-radius:8px; font-size:14px; text-align:center;"
                           onchange="AdminTools.saveFillerSettings()">
                    <span style="font-size:12px; color:#888;">Spawn fillers when unstarted projects are less than this</span>
                </div>

                <!-- Pending / Status -->
                <div id="atFillerPending" style="padding:10px 14px; border-radius:10px; background:#f4f6f8; border:1px solid #e2e6ea; font-size:13px; line-height:1.5; margin-bottom:14px;"></div>

                <!-- Save feedback -->
                <div id="atFillerSaveStatus" style="display:none; margin-bottom:10px; padding:10px 14px; border-radius:10px; font-size:13px; font-weight:600; line-height:1.4;"></div>

                <button class="btn-inline" onclick="AdminTools.loadFillerSettings()" style="gap:8px; font-size:12px;">
                    <i class="fas fa-arrows-rotate"></i>
                    Refresh
                </button>
            </div>
        </div>

        <!-- Toggle switch styles (scoped) -->
        <style>
            .at-toggle-track {
                position:absolute; top:0; left:0; right:0; bottom:0;
                background:#ccc; border-radius:24px; cursor:pointer;
                transition: background 0.2s;
            }
            .at-toggle-track::before {
                content:''; position:absolute; height:18px; width:18px;
                left:3px; bottom:3px; background:#fff; border-radius:50%;
                transition: transform 0.2s;
                box-shadow: 0 1px 3px rgba(0,0,0,0.15);
            }
            .at-toggle-wrap input:checked + .at-toggle-track {
                background: var(--primary, #1a73e8);
            }
            .at-toggle-wrap input:checked + .at-toggle-track::before {
                transform: translateX(20px);
            }
            .at-form-row {
                display:grid;
                grid-template-columns:130px minmax(72px, 1fr) minmax(160px, 1.1fr);
                align-items:center;
                gap:12px;
                margin-bottom:12px;
            }
            .at-form-row label {
                font-size:13px;
                font-weight:700;
                color:#333;
            }
            .at-form-row input {
                width:100%;
                box-sizing:border-box;
                padding:8px 10px;
                border:1px solid #cfd5df;
                border-radius:8px;
                font-size:13px;
                font-weight:700;
            }
            .at-form-row span {
                font-size:12px;
                color:#777;
                line-height:1.35;
            }
            @media (max-width: 720px) {
                .at-form-row {
                    grid-template-columns:1fr;
                    gap:6px;
                }
            }
        </style>
    `;
    viewHost.appendChild(view);

    // Logic
    window.AdminTools = {

        // ---- Rebuild Index ----
        async rebuildIndex() {
            const btn = document.getElementById('btnRebuildIndex');
            const statusEl = document.getElementById('atRebuildStatus');

            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rebuilding…';
            statusEl.style.display = 'block';
            statusEl.style.background = '#e8f0fe';
            statusEl.style.border = '1px solid #c5d9f7';
            statusEl.style.color = '#1a73e8';
            statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i>&ensp;Scanning manifests and rebuilding index. This may take a moment…';

            try {
                const res = await Portal.apiPost(`${cfg.endpoints.firstmeasure}/admin/reindex`, {
                    actor: cfg.current_user || {}
                });
                if (res.ok || res.success) {
                    const result = res.result || {};
                    const count = Number(result.indexedProjects ?? result.indexed_projects ?? res.count ?? res.indexed_projects ?? 0);
                    const bad = Number(result.bad ?? res.bad ?? 0);
                    statusEl.style.background = '#e6f4ea';
                    statusEl.style.border = '1px solid #c8e6c9';
                    statusEl.style.color = '#137333';
                    statusEl.innerHTML =
                        `<i class="fas fa-circle-check"></i>&ensp;` +
                        `Rebuild complete — <strong>${count}</strong> project${count === 1 ? '' : 's'} indexed` +
                        (bad > 0 ? `, <strong>${bad}</strong> skipped (bad JSON)` : '') +
                        `.`;
                } else {
                    throw new Error(res.error || 'Unknown error');
                }
            } catch (err) {
                statusEl.style.background = '#fce8e6';
                statusEl.style.border = '1px solid #f4b4ae';
                statusEl.style.color = '#b0261e';
                statusEl.innerHTML = `<i class="fas fa-triangle-exclamation"></i>&ensp;Rebuild failed: ${Portal.escapeHtml(err.message)}`;
            }
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-arrows-rotate"></i> Rebuild Index';
        },

        // ---- Auto-Filler Settings ----

        _fillerLoaded: false,

        async loadFillerSettings() {
            const loading = document.getElementById('atFillerLoading');
            const body    = document.getElementById('atFillerBody');

            if (!this._fillerLoaded) {
                loading.style.display = '';
                body.style.display = 'none';
            }

            try {
                const res = await Portal.apiPost(cfg.endpoints.server, {
                    action: 'server_config_list'
                });
                if (!res.success) throw new Error(res.error || 'Failed to load config');

                const settings = res.settings || {};

                AdminTools._populateQaSettings(settings);
                AdminTools._populateQueueSettings(settings);
                AdminTools.loadRushMode();
                AdminTools.loadRushAutomation();

                // Populate controls
                const toggle    = document.getElementById('atFillerEnabled');
                const threshold = document.getElementById('atFillerThreshold');
                const label     = document.getElementById('atFillerEnabledLabel');

                const enabled = !!settings.auto_filler_enabled;
                toggle.checked = enabled;
                label.textContent = enabled ? 'On' : 'Off';
                label.style.color = enabled ? '#137333' : '#888';

                threshold.value = parseInt(settings.auto_filler_min_queue, 10) || 2;

                // Pending display
                const pending = Array.isArray(settings.auto_filler_pending) ? settings.auto_filler_pending : [];
                const pendingEl = document.getElementById('atFillerPending');

                if (pending.length === 0) {
                    pendingEl.innerHTML = `<i class="fas fa-check-circle" style="color:#137333; margin-right:4px;"></i> <strong>0</strong> filler projects currently generating.`;
                } else {
                    let rows = pending.map(p => {
                        const addr = Portal.escapeHtml(p.address || p.folder || '—');
                        const ago  = p.created_at ? AdminTools._timeAgo(p.created_at) : '';
                        return `<div style="padding:2px 0;"><i class="fas fa-spinner fa-spin" style="font-size:11px; color:#f59e0b; margin-right:6px;"></i>${addr}${ago ? ` <span style="color:#999; font-size:11px;">(${ago})</span>` : ''}</div>`;
                    }).join('');
                    pendingEl.innerHTML =
                        `<div style="font-weight:600; margin-bottom:6px;"><i class="fas fa-hourglass-half" style="color:#f59e0b; margin-right:4px;"></i> ${pending.length} filler project${pending.length === 1 ? '' : 's'} currently generating:</div>` +
                        rows;
                }

                loading.style.display = 'none';
                body.style.display = '';
                this._fillerLoaded = true;

            } catch (err) {
                loading.innerHTML = `<span style="color:#b0261e;"><i class="fas fa-triangle-exclamation"></i>&ensp;${Portal.escapeHtml(err.message)}</span>`;
            }
        },

        _parseLevelOrder(raw, fallback) {
            const out = [];
            String(raw || '').split(',').forEach(part => {
                const n = parseInt(part.trim(), 10);
                if (n >= 1 && n <= 5 && !out.includes(n)) out.push(n);
            });
            fallback.forEach(n => { if (!out.includes(n)) out.push(n); });
            return out.slice(0, 5);
        },

        _formatLevelOrder(value, fallback) {
            const arr = Array.isArray(value) ? value : String(value || '').split(',');
            return this._parseLevelOrder(arr.join(','), fallback).join(',');
        },

        _populateQueueSettings(settings) {
            const loading = document.getElementById('atQueueLoading');
            const body = document.getElementById('atQueueBody');
            const win = document.getElementById('atQueueWindowMinutes');
            const senior = document.getElementById('atQueueSeniorOrder');
            const standard = document.getElementById('atQueueStandardOrder');
            const junior = document.getElementById('atQueueJuniorOrder');
            if (!loading || !body || !win || !senior || !standard || !junior) return;

            let minutes = parseInt(settings.production_queue_priority_window_minutes, 10);
            if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) minutes = 15;
            win.value = String(minutes);
            senior.value = this._formatLevelOrder(settings.production_queue_priority_senior, [5,4,3,2,1]);
            standard.value = this._formatLevelOrder(settings.production_queue_priority_standard, [3,4,2,1,5]);
            junior.value = this._formatLevelOrder(settings.production_queue_priority_junior, [1,2,3,4,5]);

            loading.style.display = 'none';
            body.style.display = '';
        },

        async saveQueueSettings() {
            const win = document.getElementById('atQueueWindowMinutes');
            const senior = document.getElementById('atQueueSeniorOrder');
            const standard = document.getElementById('atQueueStandardOrder');
            const junior = document.getElementById('atQueueJuniorOrder');
            const statusEl = document.getElementById('atQueueSaveStatus');
            if (!win || !senior || !standard || !junior || !statusEl) return;

            let minutes = parseInt(win.value, 10);
            if (!Number.isFinite(minutes) || minutes < 1) minutes = 1;
            if (minutes > 240) minutes = 240;
            win.value = String(minutes);

            const seniorOrder = this._parseLevelOrder(senior.value, [5,4,3,2,1]);
            const standardOrder = this._parseLevelOrder(standard.value, [3,4,2,1,5]);
            const juniorOrder = this._parseLevelOrder(junior.value, [1,2,3,4,5]);
            senior.value = seniorOrder.join(',');
            standard.value = standardOrder.join(',');
            junior.value = juniorOrder.join(',');

            try {
                const res = await Portal.apiPost(cfg.endpoints.server, {
                    action: 'server_config_set',
                    pairs: JSON.stringify({
                        production_queue_priority_window_minutes: minutes,
                        production_queue_priority_senior: seniorOrder,
                        production_queue_priority_standard: standardOrder,
                        production_queue_priority_junior: juniorOrder
                    })
                });
                if (!res.success) throw new Error(res.error || 'Save failed');

                statusEl.style.display = 'block';
                statusEl.style.background = '#e6f4ea';
                statusEl.style.border = '1px solid #c8e6c9';
                statusEl.style.color = '#137333';
                statusEl.innerHTML = '<i class="fas fa-circle-check"></i>&ensp;Production queue pull settings saved.';
                setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
            } catch (err) {
                statusEl.style.display = 'block';
                statusEl.style.background = '#fce8e6';
                statusEl.style.border = '1px solid #f4b4ae';
                statusEl.style.color = '#b0261e';
                statusEl.innerHTML = `<i class="fas fa-triangle-exclamation"></i>&ensp;${Portal.escapeHtml(err.message)}`;
            }
        },

        _populateQaSettings(settings) {
            const loading = document.getElementById('atQaLoading');
            const body = document.getElementById('atQaBody');
            const toggle = document.getElementById('atQaFixOnlyMode');
            const label = document.getElementById('atQaFixOnlyLabel');
            if (!loading || !body || !toggle || !label) return;

            const enabled = !!settings.qa_fix_only_mode;
            toggle.checked = enabled;
            label.textContent = enabled ? 'On' : 'Off';
            label.style.color = enabled ? '#b0261e' : '#888';
            loading.style.display = 'none';
            body.style.display = '';
        },

        _rushAutomationDefaults() {
            return {
                enabled: false,
                request_count_threshold: 30,
                request_window_minutes: 60,
                queue_threshold_enabled: false,
                queue_count_threshold: 0,
                rush_duration_minutes: 60
            };
        },

        _clampInt(value, fallback, min, max) {
            let n = parseInt(value, 10);
            if (!Number.isFinite(n)) n = fallback;
            return Math.max(min, Math.min(max, n));
        },

        _syncRushAutomationLabels(lastEvaluation) {
            const enabled = document.getElementById('atRushAutoEnabled');
            const enabledLabel = document.getElementById('atRushAutoEnabledLabel');
            const queueEnabled = document.getElementById('atRushAutoQueueEnabled');
            const queueLabel = document.getElementById('atRushAutoQueueEnabledLabel');
            const summary = document.getElementById('atRushAutoSummary');
            const req = document.getElementById('atRushAutoRequestThreshold');
            const win = document.getElementById('atRushAutoWindowMinutes');
            const queue = document.getElementById('atRushAutoQueueThreshold');
            const dur = document.getElementById('atRushAutoDuration');
            if (!enabled || !enabledLabel || !queueEnabled || !queueLabel || !summary || !req || !win || !queue || !dur) return;

            enabledLabel.textContent = enabled.checked ? 'On' : 'Off';
            enabledLabel.style.color = enabled.checked ? '#ea580c' : '#888';
            queueLabel.textContent = queueEnabled.checked ? 'Required' : 'Ignored';
            queueLabel.style.color = queueEnabled.checked ? '#ea580c' : '#888';
            queue.disabled = !queueEnabled.checked;
            queue.style.opacity = queueEnabled.checked ? '1' : '0.55';

            const requestThreshold = this._clampInt(req.value, 30, 1, 10000);
            const windowMinutes = this._clampInt(win.value, 60, 1, 1440);
            const queueThreshold = this._clampInt(queue.value, 0, 0, 10000);
            const duration = this._clampInt(dur.value, 60, 1, 1440);
            const queueText = queueEnabled.checked
                ? ` and more than ${queueThreshold} projects are in queue`
                : '';
            const evalText = lastEvaluation && lastEvaluation.evaluated_at
                ? ` Last check: ${Number(lastEvaluation.requested_count || 0)} request(s), ${Number(lastEvaluation.queue_count || 0)} queued.`
                : '';
            summary.textContent = `When enabled, more than ${requestThreshold} requested project(s) in ${windowMinutes} minute(s)${queueText} starts rush mode for ${duration} minute(s).${evalText}`;
        },

        _populateRushAutomation(payload) {
            const loading = document.getElementById('atRushAutoLoading');
            const body = document.getElementById('atRushAutoBody');
            const enabled = document.getElementById('atRushAutoEnabled');
            const req = document.getElementById('atRushAutoRequestThreshold');
            const win = document.getElementById('atRushAutoWindowMinutes');
            const queueEnabled = document.getElementById('atRushAutoQueueEnabled');
            const queue = document.getElementById('atRushAutoQueueThreshold');
            const dur = document.getElementById('atRushAutoDuration');
            if (!loading || !body || !enabled || !req || !win || !queueEnabled || !queue || !dur) return;

            const defaults = this._rushAutomationDefaults();
            const settings = Object.assign({}, defaults, payload?.settings || {});
            enabled.checked = !!settings.enabled;
            req.value = String(this._clampInt(settings.request_count_threshold, defaults.request_count_threshold, 1, 10000));
            win.value = String(this._clampInt(settings.request_window_minutes, defaults.request_window_minutes, 1, 1440));
            queueEnabled.checked = !!settings.queue_threshold_enabled;
            queue.value = String(this._clampInt(settings.queue_count_threshold, defaults.queue_count_threshold, 0, 10000));
            dur.value = String(this._clampInt(settings.rush_duration_minutes, defaults.rush_duration_minutes, 1, 1440));
            this._syncRushAutomationLabels(payload?.last_evaluation || null);

            loading.style.display = 'none';
            body.style.display = '';
        },

        async loadRushAutomation() {
            const loading = document.getElementById('atRushAutoLoading');
            const body = document.getElementById('atRushAutoBody');
            if (!loading || !body) return;
            loading.style.display = '';
            body.style.display = 'none';
            try {
                const res = await Portal.apiPost(cfg.endpoints.server, { action: 'rush_mode_automation_get' });
                if (!res.success) throw new Error(res.error || 'Failed to load rush automation settings');
                this._populateRushAutomation(res);
            } catch (err) {
                loading.innerHTML = `<span style="color:#b0261e;"><i class="fas fa-triangle-exclamation"></i>&ensp;${Portal.escapeHtml(err.message)}</span>`;
            }
        },

        async saveRushAutomation() {
            const enabled = document.getElementById('atRushAutoEnabled');
            const req = document.getElementById('atRushAutoRequestThreshold');
            const win = document.getElementById('atRushAutoWindowMinutes');
            const queueEnabled = document.getElementById('atRushAutoQueueEnabled');
            const queue = document.getElementById('atRushAutoQueueThreshold');
            const dur = document.getElementById('atRushAutoDuration');
            const statusEl = document.getElementById('atRushAutoSaveStatus');
            if (!enabled || !req || !win || !queueEnabled || !queue || !dur || !statusEl) return;

            const defaults = this._rushAutomationDefaults();
            const settings = {
                enabled: !!enabled.checked,
                request_count_threshold: this._clampInt(req.value, defaults.request_count_threshold, 1, 10000),
                request_window_minutes: this._clampInt(win.value, defaults.request_window_minutes, 1, 1440),
                queue_threshold_enabled: !!queueEnabled.checked,
                queue_count_threshold: this._clampInt(queue.value, defaults.queue_count_threshold, 0, 10000),
                rush_duration_minutes: this._clampInt(dur.value, defaults.rush_duration_minutes, 1, 1440)
            };
            req.value = String(settings.request_count_threshold);
            win.value = String(settings.request_window_minutes);
            queue.value = String(settings.queue_count_threshold);
            dur.value = String(settings.rush_duration_minutes);

            try {
                const res = await Portal.apiPost(cfg.endpoints.server, {
                    action: 'rush_mode_automation_set',
                    settings: JSON.stringify(settings)
                });
                if (!res.success) throw new Error(res.error || 'Failed to save rush automation settings');
                this._populateRushAutomation(res);
                statusEl.style.display = 'block';
                statusEl.style.background = '#e6f4ea';
                statusEl.style.border = '1px solid #c8e6c9';
                statusEl.style.color = '#137333';
                statusEl.innerHTML = '<i class="fas fa-circle-check"></i>&ensp;Automatic rush settings saved.';
                setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
            } catch (err) {
                statusEl.style.display = 'block';
                statusEl.style.background = '#fce8e6';
                statusEl.style.border = '1px solid #f4b4ae';
                statusEl.style.color = '#b0261e';
                statusEl.innerHTML = `<i class="fas fa-triangle-exclamation"></i>&ensp;${Portal.escapeHtml(err.message)}`;
            }
        },

        async loadRushMode() {
            const currentEl = document.getElementById('atRushCurrent');
            const historyEl = document.getElementById('atRushHistory');
            if (!currentEl || !historyEl) return;
            try {
                const current = await Portal.apiPost(cfg.endpoints.server, { action: 'rush_mode_current' });
                if (!current.success) throw new Error(current.error || 'Failed to load rush mode');

                if (current.active && current.rush_mode) {
                    const mode = current.rush_mode;
                    currentEl.style.background = '#ffedd5';
                    currentEl.style.border = '1px solid #fb923c';
                    currentEl.style.color = '#9a3412';
                    currentEl.innerHTML = `<i class="fas fa-bolt"></i>&ensp;Rush mode is active — ${this._formatRushCountdown(mode.remaining_seconds)} remaining.`;
                } else {
                    currentEl.style.background = '#f4f6f8';
                    currentEl.style.border = '1px solid #e2e6ea';
                    currentEl.style.color = '#667085';
                    currentEl.innerHTML = '<i class="fas fa-circle-check"></i>&ensp;No active rush mode.';
                }

                let history = { rush_modes: [] };
                try {
                    history = await Portal.apiPost(cfg.endpoints.server, { action: 'rush_mode_list' });
                    if (!history.success) throw new Error(history.error || 'Failed to load rush mode history');
                } catch (historyErr) {
                    historyEl.innerHTML = `<div style="font-size:12px; color:#b0261e; padding:7px 9px; border:1px solid #f4b4ae; border-radius:8px; background:#fce8e6;">${Portal.escapeHtml(historyErr.message)}</div>`;
                    return;
                }

                const modes = Array.isArray(history.rush_modes) ? history.rush_modes.slice(0, 5) : [];
                historyEl.innerHTML = modes.length ? modes.map(mode => {
                    const start = this._formatDateTime(mode.start_at);
                    const dur = Math.round(Number(mode.duration_seconds || 0) / 60);
                    const active = mode.active ? ' <b style="color:#ea580c;">Active</b>' : '';
                    return `<div style="font-size:12px; color:#667085; padding:7px 9px; border:1px solid #eceff3; border-radius:8px; background:#fff;">${Portal.escapeHtml(start)} · ${dur} min${active}</div>`;
                }).join('') : '<div style="font-size:12px; color:#999;">No rush modes have been scheduled yet.</div>';
            } catch (err) {
                currentEl.style.background = '#fce8e6';
                currentEl.style.border = '1px solid #f4b4ae';
                currentEl.style.color = '#b0261e';
                currentEl.innerHTML = `<i class="fas fa-triangle-exclamation"></i>&ensp;${Portal.escapeHtml(err.message)}`;
            }
        },

        async startRushMode() {
            const durationEl = document.getElementById('atRushDuration');
            const startEl = document.getElementById('atRushStartAt');
            const statusEl = document.getElementById('atRushSaveStatus');
            if (!durationEl || !startEl || !statusEl) return;
            let duration = parseInt(durationEl.value, 10);
            if (!Number.isFinite(duration) || duration < 1) duration = 1;
            if (duration > 1440) duration = 1440;
            durationEl.value = String(duration);

            let startAt = '';
            if (startEl.value) {
                const parsed = new Date(startEl.value);
                if (Number.isNaN(parsed.getTime())) {
                    statusEl.style.display = 'block';
                    statusEl.style.background = '#fce8e6';
                    statusEl.style.border = '1px solid #f4b4ae';
                    statusEl.style.color = '#b0261e';
                    statusEl.innerHTML = '<i class="fas fa-triangle-exclamation"></i>&ensp;Start time is invalid.';
                    return;
                }
                startAt = parsed.toISOString();
            }

            try {
                const res = await Portal.apiPost(cfg.endpoints.server, {
                    action: 'rush_mode_start',
                    duration_minutes: String(duration),
                    start_at: startAt
                });
                if (!res.success) throw new Error(res.error || 'Failed to start rush mode');
                statusEl.style.display = 'block';
                statusEl.style.background = '#e6f4ea';
                statusEl.style.border = '1px solid #c8e6c9';
                statusEl.style.color = '#137333';
                statusEl.innerHTML = '<i class="fas fa-circle-check"></i>&ensp;Rush mode saved.';
                setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
                startEl.value = '';
                await this.loadRushMode();
                if (window.PortalStatusBar && typeof window.PortalStatusBar.refresh === 'function') {
                    window.PortalStatusBar.refresh(false);
                }
            } catch (err) {
                statusEl.style.display = 'block';
                statusEl.style.background = '#fce8e6';
                statusEl.style.border = '1px solid #f4b4ae';
                statusEl.style.color = '#b0261e';
                statusEl.innerHTML = `<i class="fas fa-triangle-exclamation"></i>&ensp;${Portal.escapeHtml(err.message)}`;
            }
        },

        _formatRushCountdown(seconds) {
            const safe = Math.max(0, Math.floor(Number(seconds) || 0));
            const h = Math.floor(safe / 3600);
            const m = Math.floor((safe % 3600) / 60);
            const s = safe % 60;
            return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
        },

        _formatDateTime(value) {
            const d = new Date(value);
            if (Number.isNaN(d.getTime())) return String(value || '-');
            return d.toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
        },

        async saveQaSettings() {
            const toggle = document.getElementById('atQaFixOnlyMode');
            const label = document.getElementById('atQaFixOnlyLabel');
            const statusEl = document.getElementById('atQaSaveStatus');
            if (!toggle || !label || !statusEl) return;

            const enabled = !!toggle.checked;
            label.textContent = enabled ? 'On' : 'Off';
            label.style.color = enabled ? '#b0261e' : '#888';

            try {
                const res = await Portal.apiPost(cfg.endpoints.server, {
                    action: 'server_config_set',
                    pairs: JSON.stringify({
                        qa_fix_only_mode: enabled
                    })
                });
                if (!res.success) throw new Error(res.error || 'Save failed');

                if (!window.PORTAL_CFG.flags) window.PORTAL_CFG.flags = {};
                window.PORTAL_CFG.flags.qa_fix_only_mode = enabled;
                window.dispatchEvent(new CustomEvent('firstmeasure:qa_fix_only_mode_changed', {
                    detail: { enabled }
                }));

                statusEl.style.display = 'block';
                statusEl.style.background = '#e6f4ea';
                statusEl.style.border = '1px solid #c8e6c9';
                statusEl.style.color = '#137333';
                statusEl.innerHTML = '<i class="fas fa-circle-check"></i>&ensp;QA workflow setting saved company-wide.';
                setTimeout(() => { statusEl.style.display = 'none'; }, 3000);

            } catch (err) {
                statusEl.style.display = 'block';
                statusEl.style.background = '#fce8e6';
                statusEl.style.border = '1px solid #f4b4ae';
                statusEl.style.color = '#b0261e';
                statusEl.innerHTML = `<i class="fas fa-triangle-exclamation"></i>&ensp;${Portal.escapeHtml(err.message)}`;
            }
        },

        async saveFillerSettings() {
            const toggle    = document.getElementById('atFillerEnabled');
            const threshold = document.getElementById('atFillerThreshold');
            const label     = document.getElementById('atFillerEnabledLabel');
            const statusEl  = document.getElementById('atFillerSaveStatus');

            const enabled = toggle.checked;
            label.textContent = enabled ? 'On' : 'Off';
            label.style.color = enabled ? '#137333' : '#888';

            let minQueue = parseInt(threshold.value, 10);
            if (isNaN(minQueue) || minQueue < 1) minQueue = 1;
            if (minQueue > 50) minQueue = 50;
            threshold.value = minQueue;

            try {
                const res = await Portal.apiPost(cfg.endpoints.server, {
                    action: 'server_config_set',
                    pairs: JSON.stringify({
                        auto_filler_enabled:   enabled,
                        auto_filler_min_queue: minQueue
                    })
                });
                if (!res.success) throw new Error(res.error || 'Save failed');

                statusEl.style.display = 'block';
                statusEl.style.background = '#e6f4ea';
                statusEl.style.border = '1px solid #c8e6c9';
                statusEl.style.color = '#137333';
                statusEl.innerHTML = '<i class="fas fa-circle-check"></i>&ensp;Settings saved.';
                setTimeout(() => { statusEl.style.display = 'none'; }, 3000);

            } catch (err) {
                statusEl.style.display = 'block';
                statusEl.style.background = '#fce8e6';
                statusEl.style.border = '1px solid #f4b4ae';
                statusEl.style.color = '#b0261e';
                statusEl.innerHTML = `<i class="fas fa-triangle-exclamation"></i>&ensp;${Portal.escapeHtml(err.message)}`;
            }
        },

        _timeAgo(dateStr) {
            const then = new Date(dateStr).getTime();
            if (isNaN(then)) return '';
            const secs = Math.floor((Date.now() - then) / 1000);
            if (secs < 10)   return 'just now';
            if (secs < 60)   return secs + 's ago';
            if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
            return Math.floor(secs / 3600) + 'h ago';
        }
    };

    // Auto-load filler settings when the view becomes visible
    const obs = new MutationObserver(() => {
        if (view.style.display !== 'none' && !AdminTools._fillerLoaded) {
            AdminTools.loadFillerSettings();
        }
    });
    obs.observe(view, { attributes: true, attributeFilter: ['style'] });

})();
