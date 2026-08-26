/**
 * api_keys.js - Internal admin UI for FirstMeasure public API keys.
 */
(function () {
    const PLUGIN_ID = 'api-keys';
    const cfg = window.PORTAL_CFG || {};
    const perms = cfg.perms || {};
    const user = cfg.user || {};
    const isAdmin = user.role === 'admin'
        || user.role === 'system_admin'
        || !!user.is_admin
        || !!perms.is_admin_legacy
        || !!perms.platform_admin;

    if (!isAdmin || !window.Portal) return;

    Portal.registerPlugin({
        id: PLUGIN_ID,
        title: 'API Keys',
        iconClass: 'fas fa-key'
    });

    const viewHost = document.getElementById('portalPluginViews');
    if (!viewHost) return;

    const view = document.createElement('div');
    view.id = 'view-' + PLUGIN_ID;
    view.style.display = 'none';
    view.innerHTML = `
        <div class="header-bar">
            <h1>API Keys</h1>
        </div>

        <div class="ak-layout">
            <section class="panel-card ak-org-panel">
                <div class="ak-section-head">
                    <div>
                        <h3><i class="fas fa-building"></i> Organizations</h3>
                        <p>Select the customer organization that owns the API key.</p>
                    </div>
                    <button class="btn-inline" id="akRefreshOrgsBtn" type="button">
                        <i class="fas fa-arrows-rotate"></i>
                        Refresh
                    </button>
                </div>
                <div class="ak-org-controls">
                    <div class="ak-search-row">
                        <i class="fas fa-magnifying-glass"></i>
                        <input id="akOrgSearch" type="search" placeholder="Search organizations or keys">
                    </div>
                    <select id="akKeyPresence" aria-label="Filter organizations by API key status">
                        <option value="active" selected>Has active keys</option>
                        <option value="none">No active keys</option>
                        <option value="all">All organizations</option>
                    </select>
                </div>
                <div id="akOrgStatus" class="ak-muted">Loading organizations...</div>
                <div id="akOrgList" class="ak-org-list"></div>
                <div class="ak-pagination">
                    <button class="btn-inline" id="akOrgPrev" type="button">Previous</button>
                    <span id="akOrgPage">Page 1 of 1</span>
                    <button class="btn-inline" id="akOrgNext" type="button">Next</button>
                </div>
            </section>

            <section class="panel-card ak-key-panel">
                <div class="ak-section-head">
                    <div>
                        <h3><i class="fas fa-key"></i> FirstMeasure Keys</h3>
                        <p id="akSelectedOrgLabel">Choose an organization to manage keys.</p>
                    </div>
                </div>

                <div id="akGenerateForm" class="ak-generate-form" aria-disabled="true">
                    <div class="ak-form-grid">
                        <label>
                            <span>Key name</span>
                            <input id="akKeyName" type="text" value="FirstMeasure API key">
                        </label>
                        <label>
                            <span>Mode</span>
                            <select id="akKeyMode">
                                <option value="live">Live</option>
                                <option value="test">Test</option>
                            </select>
                        </label>
                        <label>
                            <span>Expiration date</span>
                            <input id="akExpiresAt" type="date">
                        </label>
                        <label>
                            <span>Delivery link expires</span>
                            <select id="akDeliveryTtl">
                                <option value="1">1 hour</option>
                                <option value="24">24 hours</option>
                                <option value="72" selected>3 days</option>
                                <option value="168">7 days</option>
                            </select>
                        </label>
                    </div>
                    <label class="ak-check">
                        <input id="akRevokeExisting" type="checkbox">
                        <span>Revoke existing active keys for this organization before creating a new one</span>
                    </label>
                    <div class="ak-actions">
                        <button class="btn-inline primary" id="akGenerateBtn" type="button" disabled>
                            <i class="fas fa-plus"></i>
                            Generate Key
                        </button>
                        <button class="btn-inline" id="akReloadKeysBtn" type="button" disabled>
                            <i class="fas fa-arrows-rotate"></i>
                            Reload Keys
                        </button>
                    </div>
                </div>

                <div id="akSecretPanel" class="ak-secret-panel" hidden>
                    <div class="ak-secret-copy">
                        <div>
                            <strong>New API key</strong>
                            <p>Copy it now. The full secret is only shown once.</p>
                        </div>
                        <button class="btn-inline" id="akCopySecretBtn" type="button">
                            <i class="fas fa-copy"></i>
                            Copy
                        </button>
                    </div>
                    <textarea id="akSecretValue" readonly spellcheck="false"></textarea>
                </div>

                <div id="akDeliveryPanel" class="ak-delivery-panel" hidden>
                    <div class="ak-secret-copy">
                        <div>
                            <strong>Self-destructing delivery link</strong>
                            <p id="akDeliveryDescription">The customer can reveal this key once.</p>
                        </div>
                    </div>
                    <input id="akDeliveryValue" readonly spellcheck="false" autocomplete="off">
                    <div class="ak-actions">
                        <button class="btn-inline primary" id="akCopyDeliveryBtn" type="button">
                            <i class="fas fa-copy"></i>
                            Copy Link
                        </button>
                        <button class="btn-inline" id="akEmailDeliveryBtn" type="button">
                            <i class="fas fa-envelope"></i>
                            Email Link
                        </button>
                    </div>
                    <p class="ak-delivery-note">Creating another link for this key immediately invalidates any unused prior link.</p>
                </div>

                <div id="akKeyStatus" class="ak-muted">No organization selected.</div>
                <div class="ak-table-wrap">
                    <table class="ak-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Key</th>
                                <th>Mode</th>
                                <th>Status</th>
                                <th>Expires</th>
                                <th>Last Used</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody id="akKeyRows"></tbody>
                    </table>
                </div>
            </section>
        </div>

        <style>
            .ak-layout {
                display:flex;
                flex-wrap:wrap;
                gap:18px;
                align-items:start;
            }
            .ak-org-panel {
                flex:1 1 300px;
                max-width:360px;
                min-width:0;
            }
            .ak-key-panel {
                flex:999 1 520px;
                min-width:0;
            }
            .ak-section-head {
                display:flex;
                align-items:flex-start;
                justify-content:space-between;
                gap:12px;
                margin-bottom:14px;
            }
            .ak-section-head h3 {
                margin:0;
                font-size:16px;
                color:#1f2933;
                display:flex;
                align-items:center;
                gap:8px;
            }
            .ak-section-head h3 i { color:var(--primary, #1a73e8); }
            .ak-section-head p {
                margin:5px 0 0 0;
                color:#667085;
                font-size:13px;
                line-height:1.45;
            }
            .ak-search-row {
                height:40px;
                display:flex;
                align-items:center;
                gap:9px;
                border:1px solid #d7dde6;
                border-radius:8px;
                padding:0 12px;
                background:#fff;
                margin-bottom:12px;
            }
            .ak-search-row i { color:#7b8794; font-size:13px; }
            .ak-search-row input {
                border:0;
                outline:0;
                width:100%;
                font-size:14px;
                background:transparent;
            }
            .ak-org-list {
                display:grid;
                gap:8px;
                max-height:620px;
                overflow:auto;
                padding-right:3px;
            }
            .ak-org-item {
                width:100%;
                text-align:left;
                border:1px solid #e2e7ef;
                background:#fff;
                border-radius:8px;
                padding:11px 12px;
                cursor:pointer;
                transition:background 0.15s, border-color 0.15s, box-shadow 0.15s;
            }
            .ak-org-item:hover {
                background:#f8fbff;
                border-color:#b8cef3;
            }
            .ak-org-item.active {
                border-color:var(--primary, #1a73e8);
                box-shadow:0 0 0 2px rgba(26,115,232,0.14);
            }
            .ak-org-name {
                font-weight:800;
                color:#1f2933;
                font-size:13px;
                line-height:1.25;
            }
            .ak-org-meta {
                margin-top:4px;
                color:#667085;
                font-size:12px;
                display:flex;
                gap:8px;
                flex-wrap:wrap;
            }
            .ak-muted {
                color:#667085;
                font-size:13px;
                padding:9px 0;
            }
            .ak-generate-form {
                border:1px solid #e2e7ef;
                border-radius:8px;
                background:#fbfcfe;
                padding:14px;
                margin-bottom:14px;
            }
            .ak-form-grid {
                display:grid;
                grid-template-columns:repeat(auto-fit, minmax(min(100%, 150px), 1fr));
                gap:12px;
            }
            .ak-form-grid label {
                display:grid;
                gap:6px;
                font-size:12px;
                color:#667085;
                font-weight:800;
            }
            .ak-form-grid input,
            .ak-form-grid select {
                min-height:38px;
                border:1px solid #cfd6e1;
                border-radius:8px;
                padding:8px 10px;
                font-size:13px;
                font-weight:700;
                color:#1f2933;
                background:#fff;
                box-sizing:border-box;
                width:100%;
            }
            .ak-check {
                display:flex;
                align-items:flex-start;
                gap:9px;
                margin:12px 0;
                color:#46515f;
                font-size:13px;
                line-height:1.4;
            }
            .ak-check input { margin-top:2px; }
            .ak-actions {
                display:flex;
                gap:10px;
                flex-wrap:wrap;
            }
            .ak-secret-panel {
                border:1px solid #f2c94c;
                background:#fff9e8;
                border-radius:8px;
                padding:12px;
                margin-bottom:14px;
            }
            .ak-secret-copy {
                display:flex;
                align-items:flex-start;
                justify-content:space-between;
                gap:12px;
                margin-bottom:10px;
            }
            .ak-secret-copy strong {
                color:#7a4d00;
                font-size:13px;
            }
            .ak-secret-copy p {
                margin:3px 0 0 0;
                color:#7a4d00;
                font-size:12px;
            }
            #akSecretValue {
                width:100%;
                box-sizing:border-box;
                min-height:74px;
                resize:vertical;
                border:1px solid #e7c44b;
                border-radius:8px;
                padding:10px;
                font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                color:#202124;
                background:#fff;
            }
            .ak-delivery-panel {
                border:1px solid #b8cef3;
                background:#edf4ff;
                border-radius:8px;
                padding:12px;
                margin-bottom:14px;
            }
            .ak-delivery-panel .ak-secret-copy strong { color:#174ea6; }
            .ak-delivery-panel .ak-secret-copy p { color:#365f98; }
            #akDeliveryValue {
                width:100%;
                box-sizing:border-box;
                min-height:42px;
                border:1px solid #a9c3ec;
                border-radius:8px;
                padding:10px;
                margin-bottom:10px;
                font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                color:#202124;
                background:#fff;
            }
            .ak-delivery-note {
                margin:9px 0 0;
                color:#526987;
                font-size:11px;
                line-height:1.45;
            }
            .ak-table-wrap {
                overflow:auto;
                border:1px solid #e2e7ef;
                border-radius:8px;
                background:#fff;
            }
            .ak-table {
                width:100%;
                border-collapse:collapse;
                min-width:780px;
            }
            .ak-table th,
            .ak-table td {
                padding:10px 12px;
                border-bottom:1px solid #eef1f5;
                text-align:left;
                font-size:12px;
                vertical-align:middle;
            }
            .ak-table th {
                color:#667085;
                background:#f8fafc;
                font-weight:800;
                text-transform:uppercase;
                letter-spacing:0;
            }
            .ak-table tr:last-child td { border-bottom:0; }
            .ak-key-name {
                font-size:13px;
                font-weight:800;
                color:#1f2933;
            }
            .ak-mono {
                font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                color:#344054;
            }
            .ak-badge {
                display:inline-flex;
                align-items:center;
                gap:5px;
                min-height:22px;
                border-radius:999px;
                padding:2px 8px;
                font-size:11px;
                font-weight:800;
                border:1px solid #d7dde6;
                background:#f7f9fc;
                color:#46515f;
            }
            .ak-badge.live { border-color:#b7dfc2; background:#ecf8ef; color:#137333; }
            .ak-badge.test { border-color:#b8cef3; background:#edf4ff; color:#174ea6; }
            .ak-badge.revoked,
            .ak-badge.expired { border-color:#f4b4ae; background:#fce8e6; color:#b0261e; }
            .ak-org-controls { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:10px; }
            .ak-org-controls select {
                min-width:160px;
                border:1px solid #d7dde6;
                border-radius:10px;
                padding:9px 10px;
                background:#fff;
                color:#344054;
                font:inherit;
                font-size:12px;
                font-weight:700;
            }
            .ak-pagination {
                display:flex;
                align-items:center;
                justify-content:space-between;
                gap:10px;
                padding-top:12px;
                font-size:12px;
                font-weight:700;
                color:#667085;
            }
            .ak-row-actions {
                display:flex;
                justify-content:flex-end;
                gap:8px;
                white-space:nowrap;
            }
            @media (max-width: 980px) {
                .ak-layout { display:grid; grid-template-columns:minmax(0, 1fr); }
                .ak-org-panel { max-width:none; }
                .ak-org-list { max-height:320px; }
                .ak-form-grid { grid-template-columns:1fr; }
                .ak-org-controls { grid-template-columns:1fr; }
            }
        </style>
    `;
    viewHost.appendChild(view);

    const state = {
        orgs: [],
        selectedOrg: null,
        keys: [],
        loaded: false,
        orgSearchTimer: null,
        orgSearchSequence: 0,
        orgPage: 1,
        orgTotalPages: 1,
        orgTotal: 0,
        lastDelivery: null
    };

    function esc(value) {
        return Portal.escapeHtml(value);
    }

    function internalBase() {
        const configured = String(cfg.endpoints?.internal || '').replace(/\/+$/, '');
        if (configured) return configured;
        const firstMeasureBase = String(window.FIRSTMEASURE_API_BASE || cfg.endpoints?.firstmeasure || '').replace(/\/+$/, '');
        if (firstMeasureBase) return firstMeasureBase.replace(/\/firstmeasure\/?$/i, '/internal');
        const v1Base = String(window.V1_API_BASE || '').replace(/\/+$/, '');
        if (v1Base) return `${v1Base}/internal`;
        const host = String(location.hostname || '').toLowerCase();
        if ((host === '127.0.0.1' || host === 'localhost') && location.port && location.port !== '3111') {
            return `http://${host}:3111/v1/internal`;
        }
        return '/v1/internal';
    }

    function actorHeaders() {
        return {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        };
    }

    function withActorQuery(path) {
        const separator = String(path || '').includes('?') ? '&' : '?';
        const params = new URLSearchParams({
            actor_email: String(user.email || ''),
            actor_name: String(user.name || ''),
            actor_role: String(user.role || '')
        });
        return `${path}${separator}${params.toString()}`;
    }

    async function api(path, options) {
        const url = `${internalBase()}${withActorQuery(path)}`;
        const init = Object.assign({ method: 'GET', headers: actorHeaders(), cache: 'no-store' }, options || {});
        const res = await fetch(url, init);
        const text = await res.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch (err) {
            throw new Error(`Server returned invalid JSON (${res.status}).`);
        }
        if (!res.ok || data.ok === false || data.success === false) {
            throw new Error(data.message || data.error || `Request failed (${res.status}).`);
        }
        return data;
    }

    function formatMoney(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return '$0';
        return `$${number.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    }

    function formatDate(value) {
        if (!value) return 'Never';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function formatDateTime(value) {
        if (!value) return 'Never';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    function setStatus(id, message, tone) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = message || '';
        el.className = 'ak-muted';
        el.style.color = tone === 'error' ? '#b0261e' : (tone === 'success' ? '#137333' : '#667085');
    }

    function selectedOrgId() {
        return state.selectedOrg && state.selectedOrg.id ? String(state.selectedOrg.id) : '';
    }

    function syncFormState() {
        const hasOrg = !!selectedOrgId();
        const form = document.getElementById('akGenerateForm');
        const generate = document.getElementById('akGenerateBtn');
        const reload = document.getElementById('akReloadKeysBtn');
        const label = document.getElementById('akSelectedOrgLabel');
        if (form) form.setAttribute('aria-disabled', hasOrg ? 'false' : 'true');
        if (generate) generate.disabled = !hasOrg;
        if (reload) reload.disabled = !hasOrg;
        if (label) {
            label.textContent = hasOrg
                ? `${state.selectedOrg.name || state.selectedOrg.id} (${state.selectedOrg.id})`
                : 'Choose an organization to manage keys.';
        }
    }

    function renderOrganizations() {
        const list = document.getElementById('akOrgList');
        if (!list) return;
        const visible = state.orgs;
        if (!visible.length) {
            list.innerHTML = '<div class="ak-muted">No organizations found.</div>';
            return;
        }
        list.innerHTML = visible.map((org) => {
            const active = selectedOrgId() === String(org.id || '');
            const kind = org.is_test ? 'Test organization' : 'Customer';
            const activeKeys = Number(org.active_key_count || 0);
            const totalKeys = Number(org.total_key_count || 0);
            const keySummary = activeKeys
                ? `${activeKeys} active key${activeKeys === 1 ? '' : 's'}`
                : (totalKeys ? `${totalKeys} inactive key${totalKeys === 1 ? '' : 's'}` : 'No API keys');
            return `
                <button type="button" class="ak-org-item ${active ? 'active' : ''}" data-org-id="${esc(org.id)}">
                    <div class="ak-org-name">${esc(org.name || org.id)}</div>
                    <div class="ak-org-meta">
                        <span>${esc(org.id)}</span>
                        <span>${esc(kind)}</span>
                        <span>${esc(keySummary)}</span>
                    </div>
                </button>
            `;
        }).join('');
        list.querySelectorAll('.ak-org-item').forEach((button) => {
            button.addEventListener('click', () => {
                const id = button.getAttribute('data-org-id');
                state.selectedOrg = state.orgs.find((org) => String(org.id || '') === id) || null;
                showSecret('');
                showDelivery(null);
                renderOrganizations();
                syncFormState();
                loadKeys();
            });
        });
    }

    function renderKeys() {
        const body = document.getElementById('akKeyRows');
        if (!body) return;
        if (!state.keys.length) {
            body.innerHTML = '<tr><td colspan="7" class="ak-muted">No API keys for this organization yet.</td></tr>';
            return;
        }
        body.innerHTML = state.keys.map((key) => {
            const expired = !!key.expired;
            const revoked = key.status === 'revoked';
            const statusClass = revoked ? 'revoked' : (expired ? 'expired' : 'live');
            const statusText = revoked ? 'Revoked' : (expired ? 'Expired' : 'Active');
            const canModify = !revoked;
            const canDeliver = canModify && !!key.delivery_available && !expired;
            const deliveryTitle = canDeliver
                ? 'Create a new one-time delivery link. Any unused previous link will be invalidated.'
                : 'This historical key must be re-rolled once before secure delivery links are available.';
            return `
                <tr>
                    <td>
                        <div class="ak-key-name">${esc(key.name || 'FirstMeasure API key')}</div>
                        <div class="ak-muted" style="padding:2px 0 0 0;">Created ${esc(formatDateTime(key.created_at))}</div>
                    </td>
                    <td><span class="ak-mono">${esc(key.key_prefix)}...${esc(key.last4)}</span></td>
                    <td><span class="ak-badge ${esc(key.mode)}">${esc(String(key.mode || '').toUpperCase())}</span></td>
                    <td><span class="ak-badge ${statusClass}">${statusText}</span></td>
                    <td>${esc(key.expires_at ? formatDate(key.expires_at) : 'No expiration')}</td>
                    <td>${esc(formatDateTime(key.last_used_at))}</td>
                    <td>
                        <div class="ak-row-actions">
                            <button class="btn-inline" type="button" data-ak-action="reroll" data-key-id="${esc(key.key_id)}" ${canModify ? '' : 'disabled'}>
                                <i class="fas fa-arrows-rotate"></i>
                                Re-roll
                            </button>
                            <button class="btn-inline" type="button" data-ak-action="delivery" data-key-id="${esc(key.key_id)}" title="${esc(deliveryTitle)}" ${canDeliver ? '' : 'disabled'}>
                                <i class="fas fa-link"></i>
                                New Link
                            </button>
                            <button class="btn-inline" type="button" data-ak-action="revoke" data-key-id="${esc(key.key_id)}" ${canModify ? '' : 'disabled'}>
                                <i class="fas fa-ban"></i>
                                Revoke
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
        body.querySelectorAll('[data-ak-action]').forEach((button) => {
            button.addEventListener('click', () => {
                const action = button.getAttribute('data-ak-action');
                const keyId = button.getAttribute('data-key-id') || '';
                if (action === 'revoke') revokeKey(keyId);
                if (action === 'reroll') rerollKey(keyId);
                if (action === 'delivery') createDeliveryLink(keyId);
            });
        });
    }

    async function loadOrganizations() {
        const sequence = ++state.orgSearchSequence;
        const search = String(document.getElementById('akOrgSearch')?.value || '').trim();
        const keyFilter = String(document.getElementById('akKeyPresence')?.value || 'active');
        setStatus('akOrgStatus', 'Loading organizations...');
        try {
            const data = await api(`/admin/firstmeasure-api-key-organizations?q=${encodeURIComponent(search)}&key_filter=${encodeURIComponent(keyFilter)}&page=${state.orgPage}&per_page=25`);
            if (sequence !== state.orgSearchSequence) return;
            state.orgs = Array.isArray(data.organizations) ? data.organizations : [];
            const pagination = data.pagination && typeof data.pagination === 'object' ? data.pagination : {};
            state.orgPage = Math.max(1, Number(pagination.page || 1));
            state.orgTotalPages = Math.max(1, Number(pagination.total_pages || 1));
            state.orgTotal = Math.max(0, Number(pagination.total_count || data.total || 0));
            setStatus('akOrgStatus', `${state.orgTotal} organization${state.orgTotal === 1 ? '' : 's'} found.`);
            renderOrganizations();
            renderOrganizationPagination();
        } catch (err) {
            if (sequence !== state.orgSearchSequence) return;
            setStatus('akOrgStatus', err.message || 'Failed to load organizations.', 'error');
        }
    }

    function queueOrganizationSearch() {
        if (state.orgSearchTimer) clearTimeout(state.orgSearchTimer);
        state.orgSearchTimer = setTimeout(() => {
            state.orgSearchTimer = null;
            state.orgPage = 1;
            loadOrganizations();
        }, 250);
    }

    function renderOrganizationPagination() {
        const previous = document.getElementById('akOrgPrev');
        const next = document.getElementById('akOrgNext');
        const label = document.getElementById('akOrgPage');
        if (previous) previous.disabled = state.orgPage <= 1;
        if (next) next.disabled = state.orgPage >= state.orgTotalPages;
        if (label) label.textContent = `Page ${state.orgPage} of ${state.orgTotalPages}`;
    }

    function changeOrganizationPage(delta) {
        const nextPage = Math.max(1, Math.min(state.orgTotalPages, state.orgPage + delta));
        if (nextPage === state.orgPage) return;
        state.orgPage = nextPage;
        loadOrganizations();
    }

    async function loadKeys() {
        const orgId = selectedOrgId();
        state.keys = [];
        renderKeys();
        if (!orgId) {
            setStatus('akKeyStatus', 'No organization selected.');
            return;
        }
        setStatus('akKeyStatus', 'Loading keys...');
        try {
            const data = await api(`/admin/firstmeasure-api-keys?org_id=${encodeURIComponent(orgId)}`);
            state.keys = Array.isArray(data.keys) ? data.keys : [];
            setStatus('akKeyStatus', `${state.keys.length} key${state.keys.length === 1 ? '' : 's'} found.`);
            renderKeys();
        } catch (err) {
            setStatus('akKeyStatus', err.message || 'Failed to load keys.', 'error');
        }
    }

    function generationPayload() {
        const orgId = selectedOrgId();
        const name = String(document.getElementById('akKeyName')?.value || '').trim() || 'FirstMeasure API key';
        const mode = String(document.getElementById('akKeyMode')?.value || 'live');
        const expiresAt = String(document.getElementById('akExpiresAt')?.value || '').trim();
        return {
            org_id: orgId,
            name,
            mode,
            expires_at: expiresAt || null,
            revoke_existing: !!document.getElementById('akRevokeExisting')?.checked,
            create_delivery_link: true,
            delivery_ttl_hours: Number(document.getElementById('akDeliveryTtl')?.value || 72)
        };
    }

    function showSecret(key) {
        const panel = document.getElementById('akSecretPanel');
        const value = document.getElementById('akSecretValue');
        if (!panel || !value) return;
        value.value = key || '';
        panel.hidden = !key;
    }

    function showDelivery(delivery) {
        const panel = document.getElementById('akDeliveryPanel');
        const value = document.getElementById('akDeliveryValue');
        const description = document.getElementById('akDeliveryDescription');
        const url = String(delivery?.url || '');
        state.lastDelivery = url ? delivery : null;
        if (!panel || !value) return;
        value.value = url;
        panel.hidden = !url;
        if (description && url) {
            description.textContent = `The customer can reveal this ${String(delivery.mode || '').toUpperCase()} key once. Link expires ${formatDateTime(delivery.expires_at)}.`;
        }
    }

    async function generateKey() {
        if (!selectedOrgId()) return;
        showSecret('');
        showDelivery(null);
        const button = document.getElementById('akGenerateBtn');
        const original = button ? button.innerHTML : '';
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
        }
        try {
            const data = await api('/admin/firstmeasure-api-keys', {
                method: 'POST',
                body: JSON.stringify(generationPayload())
            });
            showSecret(data.key || '');
            showDelivery(data.delivery || null);
            setStatus('akKeyStatus', data.delivery?.url
                ? 'API key generated. Copy or email the one-time delivery link.'
                : 'API key generated. Copy the full key now.', 'success');
            await loadKeys();
            await loadOrganizations();
        } catch (err) {
            setStatus('akKeyStatus', err.message || 'Failed to generate key.', 'error');
        } finally {
            if (button) {
                button.disabled = false;
                button.innerHTML = original;
            }
            syncFormState();
        }
    }

    async function revokeKey(keyId) {
        if (!keyId) return;
        if (!confirm('Revoke this API key? Existing integrations using it will stop working.')) return;
        try {
            await api(`/admin/firstmeasure-api-keys/${encodeURIComponent(keyId)}/revoke`, {
                method: 'POST',
                body: JSON.stringify({})
            });
            showSecret('');
            showDelivery(null);
            setStatus('akKeyStatus', 'API key revoked.', 'success');
            await loadKeys();
            await loadOrganizations();
        } catch (err) {
            setStatus('akKeyStatus', err.message || 'Failed to revoke key.', 'error');
        }
    }

    async function rerollKey(keyId) {
        if (!keyId) return;
        if (!confirm('Re-roll this API key? The old key will be revoked and the new secret will be shown once.')) return;
        const selected = state.keys.find((key) => String(key.key_id || '') === keyId) || {};
        const expiresAt = String(document.getElementById('akExpiresAt')?.value || '').trim();
        try {
            const data = await api(`/admin/firstmeasure-api-keys/${encodeURIComponent(keyId)}/reroll`, {
                method: 'POST',
                body: JSON.stringify({
                    name: selected.name || 'FirstMeasure API key',
                    mode: selected.mode || 'live',
                    expires_at: expiresAt || selected.expires_at || null,
                    create_delivery_link: true,
                    delivery_ttl_hours: Number(document.getElementById('akDeliveryTtl')?.value || 72)
                })
            });
            showSecret(data.key || '');
            showDelivery(data.delivery || null);
            setStatus('akKeyStatus', data.delivery?.url
                ? 'API key re-rolled. The old key is revoked; share the new one-time delivery link.'
                : 'API key re-rolled. Copy the new full key now.', 'success');
            await loadKeys();
            await loadOrganizations();
        } catch (err) {
            setStatus('akKeyStatus', err.message || 'Failed to re-roll key.', 'error');
        }
    }

    async function createDeliveryLink(keyId) {
        if (!keyId) return;
        if (!confirm('Create a new one-time delivery link? Any unused prior link for this key will stop working.')) return;
        try {
            const data = await api(`/admin/firstmeasure-api-keys/${encodeURIComponent(keyId)}/delivery-links`, {
                method: 'POST',
                body: JSON.stringify({
                    delivery_ttl_hours: Number(document.getElementById('akDeliveryTtl')?.value || 72)
                })
            });
            showDelivery(data.delivery || null);
            showSecret('');
            setStatus('akKeyStatus', 'New one-time delivery link created. Any unused previous link is now invalid.', 'success');
        } catch (err) {
            setStatus('akKeyStatus', err.message || 'Failed to create delivery link.', 'error');
        }
    }

    async function copySecret() {
        const value = document.getElementById('akSecretValue');
        const text = value ? String(value.value || '') : '';
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            setStatus('akKeyStatus', 'Copied API key to clipboard.', 'success');
        } catch (err) {
            if (value) {
                value.focus();
                value.select();
            }
            setStatus('akKeyStatus', 'Select the key text and copy it manually.', 'error');
        }
    }

    async function copyDeliveryLink() {
        const value = document.getElementById('akDeliveryValue');
        const text = value ? String(value.value || '') : '';
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            setStatus('akKeyStatus', 'Copied one-time delivery link to clipboard.', 'success');
        } catch (err) {
            value.focus();
            value.select();
            setStatus('akKeyStatus', 'Select the delivery link and copy it manually.', 'error');
        }
    }

    function emailDeliveryLink() {
        const delivery = state.lastDelivery || {};
        const url = String(delivery.url || '');
        if (!url) return;
        const mode = String(delivery.mode || '').toUpperCase();
        const subject = 'Your FirstMeasure API key';
        const body = [
            'Your FirstMeasure API key is ready.',
            '',
            `Open this one-time link to reveal the ${mode || 'API'} key:`,
            url,
            '',
            `This link expires ${formatDateTime(delivery.expires_at)} and can reveal the key only once.`,
            'Store the key in a server-side secret manager. Do not put it in browser code, source control, chat, or logs.',
            '',
            'Documentation: https://app.1m8.ai/documentation/apis/firstmeasure/'
        ].join('\n');
        location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    }

    function bindEvents() {
        document.getElementById('akOrgSearch')?.addEventListener('input', queueOrganizationSearch);
        document.getElementById('akKeyPresence')?.addEventListener('change', () => {
            state.orgPage = 1;
            loadOrganizations();
        });
        document.getElementById('akRefreshOrgsBtn')?.addEventListener('click', () => loadOrganizations());
        document.getElementById('akOrgPrev')?.addEventListener('click', () => changeOrganizationPage(-1));
        document.getElementById('akOrgNext')?.addEventListener('click', () => changeOrganizationPage(1));
        document.getElementById('akGenerateBtn')?.addEventListener('click', generateKey);
        document.getElementById('akReloadKeysBtn')?.addEventListener('click', loadKeys);
        document.getElementById('akCopySecretBtn')?.addEventListener('click', copySecret);
        document.getElementById('akCopyDeliveryBtn')?.addEventListener('click', copyDeliveryLink);
        document.getElementById('akEmailDeliveryBtn')?.addEventListener('click', emailDeliveryLink);
    }

    async function onVisible() {
        if (state.loaded) return;
        state.loaded = true;
        bindEvents();
        syncFormState();
        renderKeys();
        await loadOrganizations();
    }

    const observer = new MutationObserver(() => {
        if (view.style.display !== 'none') onVisible();
    });
    observer.observe(view, { attributes: true, attributeFilter: ['style'] });

    window.ApiKeysAdmin = {
        loadOrganizations,
        loadKeys
    };
})();
