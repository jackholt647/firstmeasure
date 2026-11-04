(function () {
    'use strict';

    function apiBaseUrl() {
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost') {
            return `${location.origin}/v1/signup-sandbox`;
        }
        return `${location.origin}/v1/signup-sandbox`;
    }

    // A workflow says whether its test orgs can take development sample data.
    function offersSampleData(org) {
        return (state.workflows || []).some((workflow) => workflow.id === org.workflow_id && workflow.sample_data === true);
    }

    const state = {
        workflows: [],
        pages: [],
        testOrgs: [],
        testOrgUsers: [],
        selectedTestOrgId: null,
        selectedWorkflowId: null,
        sidebarTab: 'workflows',
        // The open workflow's view: its apps (the default) or its sign-up flow.
        mainView: 'apps',
        // Apps tab data per workflow id: { data, loading, error, status }.
        apps: {}
    };

    // ---- API ---------------------------------------------------------------

    async function api(path, options = {}) {
        const res = await fetch(`${apiBaseUrl()}${path}`, {
            credentials: 'include',
            headers: options.body ? { 'Content-Type': 'application/json' } : {},
            ...options,
            body: options.body ? JSON.stringify(options.body) : undefined
        });
        if (res.status === 401) { location.replace('/portal/experimental-admin.php'); throw new Error('Admin login required.'); }
        let payload = null;
        try { payload = await res.json(); } catch (_) { /* non-JSON */ }
        if (!res.ok || !payload || payload.ok === false) {
            throw new Error((payload && payload.error) || `Sandbox request failed (${res.status}).`);
        }
        return payload;
    }

    async function refresh() {
        const payload = await api('/state');
        state.workflows = payload.workflows || [];
        state.pages = payload.pages || [];
        state.testOrgs = payload.test_orgs || [];
        if (state.selectedTestOrgId && !state.testOrgs.some(org => org.id === state.selectedTestOrgId)) {
            state.selectedTestOrgId = null;
            state.testOrgUsers = [];
        }
        if (!state.selectedWorkflowId && state.workflows.length) {
            state.selectedWorkflowId = state.workflows[0].id;
        }
        if (state.selectedWorkflowId && !state.workflows.some(w => w.id === state.selectedWorkflowId)) {
            state.selectedWorkflowId = state.workflows.length ? state.workflows[0].id : null;
        }
        render();
    }

    function selectedWorkflow() {
        return state.workflows.find(w => w.id === state.selectedWorkflowId) || null;
    }

    function pageById(pageId) {
        return state.pages.find(p => p.id === pageId) || null;
    }

    async function patchWorkflow(workflow, body) {
        await api(`/workflows/${encodeURIComponent(workflow.id)}`, { method: 'PATCH', body });
        // An edited copy no longer follows its library entry; the Apps tab reads that again.
        delete state.apps[workflow.id];
        await refresh();
    }

    // ---- Small helpers -----------------------------------------------------

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function iconBtn(icon, title, onClick) {
        const btn = el('button', 'sbx-icon-btn');
        btn.innerHTML = `<i class="fa-solid ${icon}"></i>`;
        btn.title = title;
        btn.addEventListener('click', (event) => { event.stopPropagation(); onClick(event); });
        return btn;
    }

    function toast(message) {
        const node = document.getElementById('sbx-toast');
        node.textContent = message;
        node.hidden = false;
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => { node.hidden = true; }, 2600);
    }

    async function guarded(work) {
        try {
            await work();
        } catch (error) {
            toast(String(error.message || error));
        }
    }

    async function copyText(text, label) {
        try {
            await navigator.clipboard.writeText(text);
            toast(`${label || 'Copied'} to clipboard`);
        } catch (_) {
            openModal((modal) => {
                modal.appendChild(el('h2', '', 'Copy manually'));
                const field = el('div', 'sbx-field');
                const area = el('textarea', 'sbx-code');
                area.value = text;
                field.appendChild(area);
                modal.appendChild(field);
                addModalActions(modal, [{ label: 'Close', onClick: closeModal }]);
            });
        }
    }

    // ---- Dropdown menu -----------------------------------------------------

    function openMenu(anchor, items) {
        const menu = document.getElementById('sbx-menu');
        menu.innerHTML = '';
        for (const item of items) {
            if (item === 'sep') {
                menu.appendChild(el('div', 'sbx-menu-sep'));
                continue;
            }
            const btn = el('button', `sbx-menu-item${item.danger ? ' danger' : ''}`);
            btn.innerHTML = `<i class="fa-solid ${item.icon}"></i><span>${item.label}</span>`;
            btn.addEventListener('click', () => {
                closeMenu();
                item.onClick();
            });
            menu.appendChild(btn);
        }
        menu.hidden = false;
        const rect = anchor.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        let left = rect.left;
        if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
        let top = rect.bottom + 4;
        if (top + menuRect.height > window.innerHeight - 8) top = rect.top - menuRect.height - 4;
        menu.style.left = `${Math.max(8, left)}px`;
        menu.style.top = `${Math.max(8, top)}px`;
    }

    function closeMenu() {
        document.getElementById('sbx-menu').hidden = true;
    }

    document.addEventListener('click', (event) => {
        const menu = document.getElementById('sbx-menu');
        if (!menu.hidden && !menu.contains(event.target)) closeMenu();
    }, true);
    window.addEventListener('scroll', closeMenu, true);

    // ---- Modal -------------------------------------------------------------

    function openModal(build) {
        const backdrop = document.getElementById('sbx-modal-backdrop');
        const modal = document.getElementById('sbx-modal');
        modal.innerHTML = '';
        build(modal);
        backdrop.hidden = false;
    }

    function closeModal() {
        document.getElementById('sbx-modal-backdrop').hidden = true;
    }

    function addModalActions(modal, actions) {
        const row = el('div', 'sbx-modal-actions');
        for (const action of actions) {
            const btn = el('button', `sbx-btn${action.primary ? ' sbx-btn-primary' : ''}`, action.label);
            btn.addEventListener('click', action.onClick);
            row.appendChild(btn);
        }
        modal.appendChild(row);
    }

    function addField(modal, label, inputTag, attrs = {}) {
        const field = el('div', 'sbx-field');
        field.appendChild(el('label', '', label));
        const input = el(inputTag, attrs.className || '');
        for (const [key, value] of Object.entries(attrs)) {
            if (key === 'className') continue;
            if (key === 'value') input.value = value;
            else if (key === 'options') {
                for (const option of value) {
                    const opt = el('option', '', option.label);
                    opt.value = option.value;
                    input.appendChild(opt);
                }
                if (attrs.selected !== undefined) input.value = attrs.selected;
            } else if (key !== 'selected') input.setAttribute(key, value);
        }
        field.appendChild(input);
        modal.appendChild(field);
        return input;
    }

    function addJsonField(modal, label, value, placeholder) {
        return addField(modal, label, 'textarea', {
            className: 'sbx-code sbx-code-short',
            value: Object.keys(value || {}).length ? JSON.stringify(value, null, 2) : '',
            placeholder: placeholder || '{}'
        });
    }

    function parseJsonField(input, label) {
        const raw = input.value.trim();
        if (!raw) return {};
        try {
            return JSON.parse(raw);
        } catch (_) {
            throw new Error(`${label} is not valid JSON.`);
        }
    }

    // ---- Chips -------------------------------------------------------------

    function effectCounts(doc) {
        const effects = (doc && doc.effects) || {};
        return {
            flags: Object.keys(effects.app_flags || {}).length,
            settings: Object.keys(effects.settings || {}).length
        };
    }

    function chipRow(page) {
        const row = el('div', 'sbx-chip-row');
        row.appendChild(el('span', `sbx-chip role-${page.role}`, page.role));
        row.appendChild(el('span', `sbx-chip status-${page.status}`, page.status));
        if (page.variant_of) row.appendChild(el('span', 'sbx-chip', 'variant'));
        const counts = effectCounts(page);
        if (counts.flags) row.appendChild(el('span', 'sbx-chip effects', `${counts.flags} flag${counts.flags === 1 ? '' : 's'}`));
        if (counts.settings) row.appendChild(el('span', 'sbx-chip effects', `${counts.settings} setting${counts.settings === 1 ? '' : 's'}`));
        return row;
    }

    // ---- Render ------------------------------------------------------------

    function render() {
        renderSidebar();
        renderMain();
    }

    function renderSidebar() {
        const body = document.getElementById('sbx-sidebar-body');
        body.innerHTML = '';
        if (state.sidebarTab === 'workflows') renderWorkflowList(body);
        else if (state.sidebarTab === 'pages') renderPageList(body);
        else renderTestOrgList(body);
    }

    // Workflows tab: the list, with everything you do *to* a workflow in its ⋯ menu.
    function renderWorkflowList(body) {
        const addBtn = el('button', 'sbx-btn sbx-sidebar-add');
        addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> New workflow';
        addBtn.addEventListener('click', openWorkflowCreator);
        body.appendChild(addBtn);

        if (!state.workflows.length) {
            body.appendChild(el('div', 'sbx-empty-note', 'No workflows yet.'));
            return;
        }
        for (const workflow of state.workflows) {
            const item = el('div', `sbx-workflow-item${workflow.id === state.selectedWorkflowId ? ' active' : ''}`);
            const main = el('div', 'sbx-workflow-item-main');
            main.appendChild(el('div', 'sbx-workflow-item-title', workflow.title));
            const stageCount = (workflow.stages || []).length;
            main.appendChild(el('div', 'sbx-workflow-item-meta', `${stageCount} stage${stageCount === 1 ? '' : 's'}${workflow.variant_of ? ' · variant' : ''}`));
            item.appendChild(main);
            item.appendChild(iconBtn('fa-ellipsis-vertical', 'Workflow actions', (event) => {
                openMenu(event.currentTarget, workflowMenuItems(workflow));
            }));
            item.addEventListener('click', () => {
                state.selectedWorkflowId = workflow.id;
                render();
            });
            body.appendChild(item);
        }
    }

    function workflowMenuItems(workflow) {
        return [
            { icon: 'fa-flask', label: 'Launch test instance', onClick: () => launchTestInstance(workflow) },
            { icon: 'fa-sliders', label: 'Settings projection', onClick: () => openProjectionModal(workflow) },
            'sep',
            { icon: 'fa-code-branch', label: 'Duplicate as variant', onClick: () => guarded(async () => {
                const payload = await api(`/workflows/${encodeURIComponent(workflow.id)}/duplicate`, { method: 'POST', body: {} });
                state.selectedWorkflowId = payload.workflow.id;
                toast('Workflow duplicated');
                await refresh();
            }) },
            { icon: 'fa-copy', label: 'Copy workflow JSON', onClick: () => guarded(async () => {
                const payload = await api(`/workflows/${encodeURIComponent(workflow.id)}/export`);
                await copyText(JSON.stringify(payload.bundle, null, 2), 'Workflow JSON copied');
            }) },
            'sep',
            { icon: 'fa-trash', label: 'Delete workflow', danger: true, onClick: () => guarded(async () => {
                if (!confirm(`Delete workflow "${workflow.title}"? Pages stay in the library.`)) return;
                await api(`/workflows/${encodeURIComponent(workflow.id)}`, { method: 'DELETE' });
                toast('Workflow deleted');
                await refresh();
            }) }
        ];
    }

    // Pages tab: the page library.
    function renderPageList(body) {
        const addBtn = el('button', 'sbx-btn sbx-sidebar-add');
        addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> New page';
        addBtn.addEventListener('click', () => openPageCreator());
        body.appendChild(addBtn);

        if (!state.pages.length) {
            body.appendChild(el('div', 'sbx-empty-note', 'No pages yet.'));
            return;
        }
        for (const page of state.pages) {
            const card = el('div', 'sbx-side-card');
            card.appendChild(el('div', 'sbx-side-card-title', page.title));
            const idNode = el('div', 'sbx-side-card-id', page.id);
            idNode.title = 'Click to copy page id';
            idNode.addEventListener('click', () => copyText(page.id, 'Page id copied'));
            card.appendChild(idNode);
            card.appendChild(chipRow(page));
            const actions = el('div', 'sbx-side-card-actions');
            actions.appendChild(iconBtn('fa-pen', 'Edit page', () => openPageEditor(page)));
            actions.appendChild(iconBtn('fa-code-branch', 'Create variant', () => openVariantCreator(page)));
            actions.appendChild(iconBtn('fa-trash', 'Delete page', () => guarded(async () => {
                if (!confirm(`Delete page "${page.title}"?`)) return;
                try {
                    await api(`/pages/${encodeURIComponent(page.id)}`, { method: 'DELETE' });
                } catch (error) {
                    if (!confirm(`${error.message}\n\nDelete anyway?`)) return;
                    await api(`/pages/${encodeURIComponent(page.id)}?force=true`, { method: 'DELETE' });
                }
                toast('Page deleted');
                await refresh();
            })));
            card.appendChild(actions);
            body.appendChild(card);
        }
    }

    // Test orgs tab.
    function renderTestOrgList(body) {
        if (!state.testOrgs.length) {
            body.appendChild(el('div', 'sbx-empty-note', 'No test orgs. Launch a test instance from a workflow.'));
            return;
        }
        for (const org of [...state.testOrgs].reverse()) {
            const card = el('div', 'sbx-side-card');
            card.appendChild(el('div', 'sbx-side-card-title', org.org_name || org.org_id));
            const meta = el('div', 'sbx-side-card-meta');
            meta.textContent = `${org.email} · ${org.password}`;
            card.appendChild(meta);
            card.appendChild(el('div', 'sbx-side-card-meta', org.workflow_title || org.workflow_id));
            const actions = el('div', 'sbx-side-card-actions');
            const usersBtn = el('button', 'sbx-btn', 'Users');
            usersBtn.addEventListener('click', () => guarded(async () => {
                state.selectedTestOrgId = org.id;
                await loadTestOrgUsers(org.id);
            }));
            actions.appendChild(usersBtn);
            if (offersSampleData(org)) {
                const samplesBtn = el('button', 'sbx-btn', 'Add sample data');
                samplesBtn.addEventListener('click', () => openSampleDataModal(org));
                actions.appendChild(samplesBtn);
            }

            const resumeBtn = el('button', 'sbx-btn', 'Resume');
            resumeBtn.addEventListener('click', () => guarded(async () => {
                await api(`/test-orgs/${encodeURIComponent(org.id)}/login`, { method: 'POST', body: {} });
                const payload = await api(`/test-orgs/${encodeURIComponent(org.id)}/run-state`);
                const stages = payload.instance.stages || [];
                const target = (stages[payload.instance.start_stage] || stages[0] || {}).target || '/portal/';
                window.open(target, '_blank');
            }));
            actions.appendChild(resumeBtn);

            const appBtn = el('button', 'sbx-btn', 'Open app');
            appBtn.addEventListener('click', () => guarded(async () => {
                await api(`/test-orgs/${encodeURIComponent(org.id)}/login`, { method: 'POST', body: {} });
                window.open('/portal/', '_blank');
            }));
            actions.appendChild(appBtn);

            const deleteBtn = el('button', 'sbx-btn', 'Delete');
            deleteBtn.addEventListener('click', () => guarded(async () => {
                if (!confirm(`Delete test org "${org.org_name}" and all its data?`)) return;
                await api(`/test-orgs/${encodeURIComponent(org.id)}`, { method: 'DELETE' });
                toast('Test org deleted');
                await refresh();
            }));
            actions.appendChild(deleteBtn);

            card.appendChild(actions);
            body.appendChild(card);
        }
    }

    // ---- Main canvas: the open workflow, edited in place -------------------

    function renderMain() {
        const main = document.getElementById('sbx-main');
        closeAppPopover(false);
        main.innerHTML = '';
        if (state.sidebarTab === 'orgs') {
            renderTestOrgMain(main);
            return;
        }
        const workflow = selectedWorkflow();
        if (!workflow) {
            main.appendChild(el('div', 'sbx-empty-state', 'Create a workflow to get started.'));
            return;
        }

        const head = el('div', 'sbx-wf-head');
        const fields = el('div', 'sbx-wf-head-fields');

        const title = el('input', 'sbx-title-input');
        title.value = workflow.title;
        title.title = 'Click to rename';
        title.addEventListener('change', () => guarded(() => patchWorkflow(workflow, { title: title.value })));
        title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); });
        fields.appendChild(title);

        const desc = el('textarea', 'sbx-desc-input');
        desc.value = workflow.description || '';
        desc.placeholder = 'Add a description…';
        desc.rows = Math.max(1, Math.min(4, (workflow.description || '').split('\n').length));
        desc.addEventListener('change', () => guarded(() => patchWorkflow(workflow, { description: desc.value })));
        fields.appendChild(desc);

        head.appendChild(fields);

        const toolbar = el('div', 'sbx-wf-toolbar');
        const launchBtn = el('button', 'sbx-btn sbx-btn-primary');
        launchBtn.innerHTML = '<i class="fa-solid fa-flask"></i> Launch test instance';
        launchBtn.addEventListener('click', () => launchTestInstance(workflow));
        toolbar.appendChild(launchBtn);
        toolbar.appendChild(iconBtn('fa-ellipsis-vertical', 'Workflow actions', (event) => {
            openMenu(event.currentTarget, workflowMenuItems(workflow));
        }));
        head.appendChild(toolbar);
        main.appendChild(head);
        main.appendChild(renderViewTabs(workflow));

        if (state.mainView === 'apps') {
            main.appendChild(renderAppsPanel(workflow));
            return;
        }

        const metaRow = el('div', 'sbx-wf-meta-row');
        const idNode = el('span', 'sbx-wf-id', workflow.id);
        idNode.title = 'Click to copy workflow id (use in landing URLs)';
        idNode.addEventListener('click', () => copyText(workflow.id, 'Workflow id copied'));
        metaRow.appendChild(idNode);

        const entry = el('select', 'sbx-inline-select');
        for (const option of [
            { value: 'signup_first', label: 'Entry: signup first' },
            { value: 'landing_first', label: 'Entry: landing page first' }
        ]) {
            const opt = el('option', '', option.label);
            opt.value = option.value;
            entry.appendChild(opt);
        }
        entry.value = workflow.entry_mode;
        entry.addEventListener('change', () => guarded(() => patchWorkflow(workflow, { entry_mode: entry.value })));
        metaRow.appendChild(entry);

        if (workflow.variant_of) metaRow.appendChild(el('span', 'sbx-chip', `variant of ${workflow.variant_of}`));
        main.appendChild(metaRow);

        main.appendChild(renderDefaultsPanel(workflow));

        const grid = el('div', 'sbx-stage-grid');
        (workflow.stages || []).forEach((stage, index) => {
            grid.appendChild(renderStageTile(workflow, stage, index));
        });
        const addTile = el('button', 'sbx-add-stage-tile');
        addTile.innerHTML = '<i class="fa-solid fa-plus"></i><span>Add stage</span>';
        addTile.addEventListener('click', () => openAddStageModal(workflow));
        grid.appendChild(addTile);
        main.appendChild(grid);
    }

    // ---- Views of the open workflow: Apps (default) and Sign-up flow -----

    function renderViewTabs(workflow) {
        const views = [{ id: 'apps', label: 'Apps', icon: 'fa-table-cells-large' }, { id: 'flow', label: 'Sign-up flow', icon: 'fa-diagram-project' }];
        const bar = el('div', 'sbx-view-tabs');
        bar.setAttribute('role', 'tablist');
        bar.setAttribute('aria-label', 'Workflow views');
        views.forEach((view, index) => {
            const tab = el('button', `sbx-view-tab${state.mainView === view.id ? ' active' : ''}`);
            tab.type = 'button';
            tab.id = `sbx-view-${view.id}`;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(state.mainView === view.id));
            tab.tabIndex = state.mainView === view.id ? 0 : -1;
            tab.innerHTML = `<i class="fa-solid ${view.icon}" aria-hidden="true"></i><span>${view.label}</span>`;
            tab.addEventListener('click', () => { if (state.mainView !== view.id) { state.mainView = view.id; closeAppPopover(); renderMain(); focusViewTab(); } });
            tab.addEventListener('keydown', (event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length;
                state.mainView = views[next].id;
                closeAppPopover();
                renderMain();
                focusViewTab();
            });
            bar.appendChild(tab);
        });
        if (workflow) bar.dataset.workflow = workflow.id;
        return bar;
    }

    function focusViewTab() {
        const tab = document.getElementById(`sbx-view-${state.mainView}`);
        if (tab) tab.focus();
    }

    // ---- Apps tab ----------------------------------------------------------
    // Every app's starting state in this configuration, read from and saved to its config library entry
    // (v1/signup-sandbox/apps.ts holds the mapping; this page only shows it and sends the change).

    const APP_STATES = [
        { id: 'on', label: 'On', hint: 'Available from the start.' },
        { id: 'offered', label: 'Offered', hint: 'Off, with its welcome page and Get Started until someone starts it.' },
        { id: 'off', label: 'Off', hint: 'Not available.' }
    ];
    const APP_STATE_LABEL = Object.fromEntries(APP_STATES.map((entry) => [entry.id, entry.label]));

    function appsEntry(workflowId) {
        if (!state.apps[workflowId]) state.apps[workflowId] = { data: null, loading: false, error: '', status: null };
        return state.apps[workflowId];
    }

    async function loadApps(workflowId) {
        const entry = appsEntry(workflowId);
        entry.loading = true;
        try {
            entry.data = (await api(`/workflows/${encodeURIComponent(workflowId)}/apps`));
            entry.error = '';
        } catch (error) {
            entry.error = String(error.message || error);
        } finally {
            entry.loading = false;
        }
        if (state.selectedWorkflowId === workflowId && state.mainView === 'apps' && state.sidebarTab !== 'orgs') renderMain();
    }

    function platformCsrf(cookieName) {
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(cookieName || ''))) return '';
        const prefix = `${encodeURIComponent(cookieName)}=`;
        let jar = '';
        try { jar = document.cookie; } catch (_) { /* no cookies */ }
        const cookie = jar.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
        try { return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : ''; } catch (_) { return ''; }
    }

    // A config library write: the platform session and its CSRF token, never the sandbox's admin redirect.
    async function saveAppChange(workflowId, appId, change) {
        const entry = appsEntry(workflowId);
        const data = entry.data;
        if (!data || !data.configuration.editable) return;
        entry.status = { kind: 'saving', text: 'Saving…' };
        renderAppsStatus(workflowId);
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
        const token = platformCsrf(data.csrf_cookie);
        if (token) headers['X-Platform-CSRF'] = token;
        let response = null;
        let payload = null;
        try {
            response = await fetch(`${apiBaseUrl()}/workflows/${encodeURIComponent(workflowId)}/apps/${encodeURIComponent(appId)}`, {
                method: 'PUT', credentials: 'include', headers, body: JSON.stringify({ expected_revision: data.configuration.revision, ...change })
            });
            try { payload = await response.json(); } catch (_) { /* non-JSON */ }
        } catch (error) {
            entry.status = { kind: 'error', text: `Not saved: ${String(error.message || error)}` };
            renderAppsStatus(workflowId);
            return;
        }
        if (response.ok && payload && payload.ok !== false) {
            entry.data = payload;
            entry.status = { kind: 'saved', text: payload.changed === false ? 'No change' : `Saved · revision ${payload.configuration.revision}` };
            rerenderApps(workflowId, appId);
            return;
        }
        const message = (payload && (payload.error || payload.message)) || `Request failed (${response.status}).`;
        if (response.status === 409) {
            entry.status = { kind: 'conflict', text: 'Someone saved this configuration first. It has been reloaded: check it and make your change again.' };
            await loadApps(workflowId);
            rerenderApps(workflowId, appId);
            return;
        }
        entry.status = {
            kind: 'error',
            text: response.status === 401 || response.status === 403
                ? `Not saved: ${message} Sign in to the portal as a platform administrator, or launch a test instance, then try again.`
                : `Not saved: ${message}`
        };
        renderAppsStatus(workflowId);
    }

    function rerenderApps(workflowId, reopenAppId) {
        if (state.selectedWorkflowId !== workflowId || state.mainView !== 'apps') return;
        const keepAdvanced = !!document.querySelector('.sbx-app-pop details[open]');
        const reopen = !!reopenAppId && appPopover.appId === reopenAppId;
        const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focusKey : '';
        renderMain();
        if (!reopen) return;
        const tile = document.querySelector(`.sbx-app-tile[data-app="${CSS.escape(reopenAppId)}"]`);
        if (tile) openAppPopover(workflowId, reopenAppId, tile, { keepFocus: true, advanced: keepAdvanced, focusKey });
    }

    function renderAppsStatus(workflowId) {
        const node = document.getElementById('sbx-apps-status');
        if (!node || state.selectedWorkflowId !== workflowId) return;
        const status = appsEntry(workflowId).status;
        node.className = `sbx-apps-status${status ? ` is-${status.kind}` : ''}`;
        node.textContent = status ? status.text : '';
        const pop = document.querySelector('.sbx-app-pop');
        if (pop) pop.classList.toggle('is-saving', !!status && status.kind === 'saving');
    }

    function renderAppsPanel(workflow) {
        const panel = el('section', 'sbx-apps');
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', 'sbx-view-apps');
        const entry = appsEntry(workflow.id);
        if (!entry.data && !entry.loading && !entry.error) loadApps(workflow.id);
        if (!entry.data) {
            panel.appendChild(el('div', 'sbx-empty-note', entry.error ? `Apps could not be loaded: ${entry.error}` : 'Loading apps…'));
            return panel;
        }
        const data = entry.data;

        const bar = el('div', 'sbx-apps-bar');
        const legend = el('ul', 'sbx-apps-legend');
        legend.setAttribute('aria-label', 'App states');
        for (const item of APP_STATES) {
            const row = el('li', `sbx-legend-item is-${item.id}`);
            row.title = item.hint;
            row.appendChild(el('span', 'sbx-state-dot'));
            const text = el('span');
            text.appendChild(el('strong', '', item.label));
            text.appendChild(document.createTextNode(` ${item.hint}`));
            row.appendChild(text);
            legend.appendChild(row);
        }
        bar.appendChild(legend);
        const meta = el('div', 'sbx-apps-meta');
        const source = data.configuration.source === 'library'
            ? `sandbox_configuration/${data.configuration.id} · revision ${data.configuration.revision}`
            : 'Made in the sandbox · read-only';
        meta.appendChild(el('span', 'sbx-apps-source', source));
        const status = el('span', 'sbx-apps-status');
        status.id = 'sbx-apps-status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        meta.appendChild(status);
        bar.appendChild(meta);
        panel.appendChild(bar);

        if (data.configuration.copy_state === 'changed') {
            panel.appendChild(el('div', 'sbx-apps-note', 'This workflow was edited in the sandbox, so test instances use that edited copy, not these library defaults, until it is reset to the library.'));
        } else if (!data.configuration.editable) {
            panel.appendChild(el('div', 'sbx-apps-note', data.configuration.source === 'library'
                ? 'The config library is read-only here, so these defaults cannot be changed on this server.'
                : 'This workflow is not a config library configuration, so its apps are shown but not edited here.'));
        }

        for (const group of data.groups) {
            if (!group.apps.length) continue;
            const section = el('section', 'sbx-apps-group');
            const headingId = `sbx-apps-group-${group.id}`;
            section.setAttribute('aria-labelledby', headingId);
            const heading = el('h3', 'sbx-apps-group-title');
            heading.id = headingId;
            heading.appendChild(el('span', '', group.title));
            const counts = APP_STATES.map((item) => [item, group.apps.filter((app) => app.state === item.id).length]).filter(([, count]) => count);
            heading.appendChild(el('span', 'sbx-apps-group-count', counts.map(([item, count]) => `${count} ${item.label.toLowerCase()}`).join(' · ')));
            section.appendChild(heading);
            const grid = el('div', 'sbx-apps-grid');
            for (const app of group.apps) grid.appendChild(renderAppTile(workflow.id, app));
            section.appendChild(grid);
            panel.appendChild(section);
        }
        requestAnimationFrame(() => renderAppsStatus(workflow.id));
        return panel;
    }

    function renderAppTile(workflowId, app) {
        const tile = el('button', `sbx-app-tile is-${app.state}`);
        tile.type = 'button';
        tile.dataset.app = app.id;
        tile.setAttribute('aria-haspopup', 'dialog');
        tile.setAttribute('aria-expanded', 'false');
        tile.setAttribute('aria-label', `${app.title}: ${APP_STATE_LABEL[app.state]}`);
        tile.title = `${app.title} (${app.id}): ${APP_STATE_LABEL[app.state]}`;
        const icon = el('span', 'sbx-app-icon');
        icon.innerHTML = `<i class="fa-solid ${/^fa-[a-z0-9-]+$/.test(app.icon) ? app.icon : 'fa-cube'}" aria-hidden="true"></i>`;
        tile.appendChild(icon);
        tile.appendChild(el('span', 'sbx-app-title', app.title));
        const badge = el('span', 'sbx-app-state');
        badge.setAttribute('aria-hidden', 'true');
        badge.appendChild(el('span', 'sbx-state-dot'));
        badge.appendChild(el('span', 'sbx-app-state-text', APP_STATE_LABEL[app.state]));
        tile.appendChild(badge);
        if (app.pill) {
            tile.classList.add('has-pill');
            tile.appendChild(el('span', 'sbx-app-pill', app.pill === 'new' ? 'New' : 'Soon'));
        }
        tile.addEventListener('click', (event) => {
            event.stopPropagation();
            if (appPopover.appId === app.id) closeAppPopover(true);
            else openAppPopover(workflowId, app.id, tile);
        });
        return tile;
    }

    function findApp(workflowId, appId) {
        const data = appsEntry(workflowId).data;
        return data ? data.groups.flatMap((group) => group.apps).find((app) => app.id === appId) || null : null;
    }

    const SURFACE_LABEL = { portal_tab: 'portal app', project_modal: 'project tab', contact_modal: 'contact tab' };

    // Another app's title, with where it lives when that differs from `from` (Money's tab and its Financials page).
    function appTitleById(workflowId, appId, from) {
        const app = findApp(workflowId, appId);
        if (!app) return appId;
        return from && from.surface !== app.surface ? `${app.title} (${SURFACE_LABEL[app.surface] || app.surface})` : app.title;
    }

    const REASONS = {
        hidden: 'Its switch is on, but its placement hides it from the apps menu.',
        flag_disabled: 'Its organization switch is off.'
    };

    function appExplanation(workflowId, app) {
        if (app.state === 'on') return app.switches.length ? `On: ${app.switches.filter((entry) => entry.on).map((entry) => entry.label).join(', ')}.` : 'Always on: this app has no organization switch.';
        if (app.state === 'offered') return 'Offered: shows its welcome and Get Started until someone starts it.';
        if (REASONS[app.reason]) return REASONS[app.reason];
        if (app.reason.startsWith('offered:')) return `Its switch is held off by the ${appTitleById(workflowId, app.reason.slice(8))} offer.`;
        if (app.reason.startsWith('requires ')) return `Off until ${app.reason.slice(9)} is on (On turns it on).`;
        return 'Off.';
    }

    const appPopover = { node: null, appId: null, workflowId: null, tile: null };

    function closeAppPopover(returnFocus) {
        if (!appPopover.node) return;
        const tile = appPopover.tile;
        appPopover.node.remove();
        appPopover.node = null;
        appPopover.appId = null;
        if (tile) tile.setAttribute('aria-expanded', 'false');
        if (returnFocus && tile && document.body.contains(tile)) tile.focus();
        appPopover.tile = null;
    }

    function openAppPopover(workflowId, appId, tile, options = {}) {
        closeAppPopover(false);
        const app = findApp(workflowId, appId);
        const data = appsEntry(workflowId).data;
        if (!app || !data) return;
        const editable = data.configuration.editable;
        const pop = el('div', 'sbx-app-pop');
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-modal', 'false');
        const titleId = `sbx-app-pop-title-${app.id.replace(/[^a-z0-9]/gi, '-')}`;
        pop.setAttribute('aria-labelledby', titleId);

        const head = el('div', 'sbx-app-pop-head');
        const icon = el('span', 'sbx-app-icon');
        icon.innerHTML = `<i class="fa-solid ${/^fa-[a-z0-9-]+$/.test(app.icon) ? app.icon : 'fa-cube'}" aria-hidden="true"></i>`;
        head.appendChild(icon);
        const titles = el('div', 'sbx-app-pop-titles');
        const title = el('div', 'sbx-app-pop-title', app.title);
        title.id = titleId;
        titles.appendChild(title);
        titles.appendChild(el('div', 'sbx-app-pop-id', app.id));
        head.appendChild(titles);
        const close = iconBtn('fa-xmark', 'Close', () => closeAppPopover(true));
        close.setAttribute('aria-label', 'Close');
        head.appendChild(close);
        pop.appendChild(head);

        const choices = el('div', 'sbx-app-choices');
        choices.setAttribute('role', 'group');
        choices.setAttribute('aria-label', `Default for ${app.title}`);
        for (const item of APP_STATES) {
            const button = el('button', `sbx-app-choice is-${item.id}${app.state === item.id ? ' active' : ''}`);
            button.type = 'button';
            button.setAttribute('aria-pressed', String(app.state === item.id));
            button.dataset.focusKey = `state:${item.id}`;
            button.appendChild(el('span', 'sbx-state-dot'));
            button.appendChild(el('span', '', item.label));
            let unavailable = '';
            if (item.id === 'offered' && !app.offerable) unavailable = 'This app has no welcome page, so it cannot be offered.';
            if (item.id === 'off' && !app.switches.length && app.surface !== 'portal_tab') unavailable = 'This view has no organization switch, so it is always on.';
            button.disabled = !editable || !!unavailable;
            button.title = unavailable || item.hint;
            button.addEventListener('click', () => {
                if (app.state === item.id) return;
                saveAppChange(workflowId, app.id, { state: item.id });
            });
            choices.appendChild(button);
        }
        pop.appendChild(choices);
        pop.appendChild(el('p', 'sbx-app-pop-why', appExplanation(workflowId, app)));

        const together = [...new Set([...(app.offer_siblings || []), ...(app.shared_with || [])])];
        if (together.length) {
            pop.appendChild(el('p', 'sbx-app-pop-shared', `Shares its switch with ${together.map((id) => appTitleById(workflowId, id, app)).join(', ')}: changing this changes them too.`));
        }

        const advanced = renderAppAdvanced(workflowId, app, editable);
        if (advanced) {
            if (options.advanced) advanced.open = true;
            pop.appendChild(advanced);
        }

        pop.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { event.stopPropagation(); closeAppPopover(true); return; }
            if (event.key !== 'Tab') return;
            const focusable = [...pop.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not(:disabled), summary')].filter((node) => node.offsetParent !== null);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        });
        pop.addEventListener('click', (event) => event.stopPropagation());
        document.body.appendChild(pop);
        appPopover.node = pop;
        appPopover.appId = app.id;
        appPopover.workflowId = workflowId;
        appPopover.tile = tile;
        tile.setAttribute('aria-expanded', 'true');
        placeAppPopover();
        renderAppsStatus(workflowId);
        if (!options.keepFocus) {
            const first = pop.querySelector('.sbx-app-choice.active:not(:disabled)') || pop.querySelector('.sbx-app-choice:not(:disabled)') || close;
            first.focus();
        } else {
            const again = (options.focusKey && pop.querySelector(`[data-focus-key="${CSS.escape(options.focusKey)}"]`)) || pop.querySelector('.sbx-app-choice.active') || close;
            again.focus({ preventScroll: true });
        }
    }

    function placeAppPopover() {
        const pop = appPopover.node;
        const tile = appPopover.tile;
        if (!pop || !tile) return;
        const margin = 8;
        const rect = tile.getBoundingClientRect();
        const width = Math.min(340, window.innerWidth - margin * 2);
        pop.style.width = `${width}px`;
        pop.style.maxHeight = `${Math.max(200, window.innerHeight - margin * 2)}px`;
        const height = pop.getBoundingClientRect().height;
        let left = rect.left + rect.width / 2 - width / 2;
        left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
        let top = rect.bottom + 6;
        if (top + height > window.innerHeight - margin) top = rect.top - height - 6;
        if (top < margin) top = Math.max(margin, window.innerHeight - height - margin);
        pop.style.left = `${Math.round(left)}px`;
        pop.style.top = `${Math.round(top)}px`;
    }

    function renderAppAdvanced(workflowId, app, editable) {
        const rows = [];
        const field = (label, description, control, focusKey) => {
            control.dataset.focusKey = focusKey;
            const row = el('label', 'sbx-adv-row');
            const text = el('span', 'sbx-adv-text');
            text.appendChild(el('span', 'sbx-adv-label', label));
            if (description) text.appendChild(el('span', 'sbx-adv-desc', description));
            row.appendChild(text);
            control.disabled = control.disabled || !editable;
            row.appendChild(control);
            return row;
        };
        const select = (options, value, onChange) => {
            const node = el('select', 'sbx-adv-select');
            for (const [optionValue, optionLabel] of options) {
                const opt = el('option', '', optionLabel);
                opt.value = optionValue;
                node.appendChild(opt);
            }
            node.value = value;
            node.addEventListener('change', () => onChange(node.value));
            return node;
        };
        const checkbox = (checked, onChange) => {
            const node = el('input', 'sbx-adv-check');
            node.type = 'checkbox';
            node.checked = !!checked;
            node.addEventListener('change', () => onChange(node.checked));
            return node;
        };

        if (app.surface === 'portal_tab') {
            rows.push(field('Placement', 'Where the app sits for the organization; hidden takes it out of the apps menu.',
                select([['', 'Default'], ['sidebar', 'Sidebar'], ['more', 'More apps'], ['settings', 'In Settings'], ['hidden', 'Hidden']], app.placement || '',
                    (value) => saveAppChange(workflowId, app.id, { placement: value })), 'placement'));
        }
        if (app.surface === 'project_modal') {
            rows.push(field('Tab pill', 'A pill on the project window tab.',
                select([['', 'None'], ['new', 'New'], ['coming_soon', 'Coming soon']], app.pill || '',
                    (value) => saveAppChange(workflowId, app.id, { pill: value })), 'pill'));
        }
        for (const option of app.options) {
            rows.push(field(option.label, `${option.description} App option for every role.`,
                checkbox(option.value, (value) => saveAppChange(workflowId, app.id, { options: { [option.key]: value } })), `option:${option.key}`));
        }
        for (const feature of app.features) {
            let control;
            if (feature.type === 'boolean') {
                control = checkbox(feature.value === true, (value) => saveAppChange(workflowId, app.id, { features: { [feature.key]: value } }));
            } else if (feature.type === 'select') {
                control = select(feature.options, String(feature.value ?? ''), (value) => saveAppChange(workflowId, app.id, { features: { [feature.key]: value } }));
            } else {
                control = el('input', 'sbx-adv-input');
                control.type = feature.type === 'number' ? 'number' : 'text';
                control.value = feature.value === null || feature.value === undefined ? '' : String(feature.value);
                control.addEventListener('change', () => saveAppChange(workflowId, app.id, { features: { [feature.key]: feature.type === 'number' ? Number(control.value) : control.value } }));
            }
            if (feature.locked) { control.disabled = true; control.title = 'Fixed by the platform.'; }
            const row = field(feature.label, feature.description, control, `feature:${feature.key}`);
            row.classList.toggle('is-unavailable', !feature.available);
            row.style.setProperty('--sbx-adv-depth', String(Math.max(0, Math.min(4, feature.depth - 1))));
            row.title = `${feature.key}${feature.configured ? ' · set by this configuration' : ' · from the base'}${feature.available ? '' : ' · its parent is off'}`;
            rows.push(row);
        }
        if (!rows.length) return null;
        const details = el('details', 'sbx-app-adv');
        const summary = el('summary');
        const count = app.features.length + app.options.length;
        summary.textContent = count ? `Advanced · ${count} feature${count === 1 ? '' : 's'} and option${count === 1 ? '' : 's'}` : 'Advanced';
        details.appendChild(summary);
        const body = el('div', 'sbx-adv-body');
        rows.forEach((row) => body.appendChild(row));
        details.appendChild(body);
        details.addEventListener('toggle', placeAppPopover);
        return details;
    }

    document.addEventListener('click', (event) => {
        if (appPopover.node && !appPopover.node.contains(event.target)) closeAppPopover(false);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && appPopover.node) closeAppPopover(true);
    });
    window.addEventListener('resize', placeAppPopover);
    window.addEventListener('scroll', (event) => {
        if (appPopover.node && !appPopover.node.contains(event.target)) placeAppPopover();
    }, true);

    async function loadTestOrgUsers(orgId) {
        const payload = await api(`/test-orgs/${encodeURIComponent(orgId)}/users`);
        if (state.selectedTestOrgId !== orgId) return;
        state.testOrgUsers = payload.users || [];
        renderMain();
    }

    function renderTestOrgMain(main) {
        const org = state.testOrgs.find(item => item.id === state.selectedTestOrgId);
        if (!org) {
            main.appendChild(el('div', 'sbx-empty-state', 'Select a test org to see its users.'));
            return;
        }
        main.appendChild(el('h2', '', org.org_name || org.org_id));
        main.appendChild(el('div', 'sbx-side-card-meta', `${org.org_id} · ${org.workflow_title || org.workflow_id}`));
        const add = el('button', 'sbx-btn sbx-btn-primary', 'Add user');
        add.addEventListener('click', () => openTestOrgUserCreator(org));
        main.appendChild(add);
        if (offersSampleData(org)) {
            const samples = el('button', 'sbx-btn', 'Add sample data');
            samples.addEventListener('click', () => openSampleDataModal(org));
            main.appendChild(samples);
        }
        const list = el('div', 'sbx-org-users');
        for (const user of state.testOrgUsers) {
            const row = el('div', 'sbx-org-user');
            const details = el('div');
            details.appendChild(el('div', 'sbx-side-card-title', user.name || user.email));
            details.appendChild(el('div', 'sbx-side-card-meta', `${user.email} · ${user.role || 'member'} · ${user.status || 'active'}`));
            const granted = Object.entries(user.permissions || {}).filter(([, value]) => value === true).map(([key]) => key);
            details.appendChild(el('div', 'sbx-side-card-meta', granted.length ? `Additional permissions: ${granted.join(', ')}` : 'No additional permissions'));
            row.appendChild(details);
            const jump = el('button', 'sbx-btn', 'Jump in as user');
            jump.disabled = user.status === 'disabled';
            jump.addEventListener('click', () => {
                const portalTab = window.open('about:blank', '_blank');
                guarded(async () => {
                    try {
                        const payload = await api(`/test-orgs/${encodeURIComponent(org.id)}/users/${encodeURIComponent(user.id)}/login`, { method: 'POST', body: {} });
                        if (portalTab) portalTab.location.replace(payload.redirect || '/portal/');
                        else location.assign(payload.redirect || '/portal/');
                    } catch (error) {
                        if (portalTab) portalTab.close();
                        throw error;
                    }
                });
            });
            row.appendChild(jump);
            list.appendChild(row);
        }
        if (!state.testOrgUsers.length) list.appendChild(el('div', 'sbx-empty-note', 'No users found for this organization.'));
        main.appendChild(list);
    }

    function openSampleDataModal(org) {
        openModal((modal) => {
            modal.appendChild(el('h2', '', 'Add sample data'));
            modal.appendChild(el('p', '', 'Choose what to add. Existing records and your edits are preserved when you run this again.'));
            const checks = new Map();
            for (const [key, label] of [
                ['equipment', 'Equipment — fleet, yard, maintenance and reservations'],
                ['channels', 'Channels — four sample channels with conversations'],
                ['projects', 'Projects — four jobs with scheduled events'],
                ['customers', 'Customers — five sample contacts']
            ]) {
                const row = el('label', 'sbx-permission-choice');
                const check = el('input');
                check.type = 'checkbox';
                checks.set(key, check);
                row.appendChild(check);
                row.appendChild(el('span', '', label));
                modal.appendChild(row);
            }
            let busy = false;
            addModalActions(modal, [
                { label: 'Cancel', onClick: closeModal },
                { label: 'Add selected sample data', primary: true, onClick: () => guarded(async () => {
                    if (busy) return;
                    const selection = Object.fromEntries([...checks].map(([key, check]) => [key, check.checked]));
                    if (!Object.values(selection).some(Boolean)) { toast('Choose at least one sample data option'); return; }
                    busy = true;
                    try {
                        await api(`/test-orgs/${encodeURIComponent(org.id)}/sample-data`, { method: 'POST', body: selection });
                        closeModal();
                        toast('Selected sample data is ready');
                    } finally { busy = false; }
                }) }
            ]);
        });
    }

    function openTestOrgUserCreator(org) {
        openModal((modal) => {
            modal.appendChild(el('h2', '', `Add user to ${org.org_name}`));
            const name = addField(modal, 'Name', 'input', { placeholder: 'Alex Tester' });
            const email = addField(modal, 'Email', 'input', { type: 'email', placeholder: 'alex@example.test' });
            const role = addField(modal, 'Role', 'select', { options: [
                { value: 'viewer', label: 'Viewer' },
                { value: 'manager', label: 'Manager' },
                { value: 'admin', label: 'Admin' },
                { value: 'custom', label: 'Custom' }
            ], selected: 'viewer' });
            const permissionChoices = [
                ['order_reports', 'Order reports'], ['view_reports', 'View reports'],
                ['manage_billing', 'Manage billing'], ['manage_company_settings', 'Manage company settings'],
                ['manage_report_settings', 'Manage report settings'], ['manage_company_users', 'Manage users'],
                ['manage_company_user_permissions', 'Manage user permissions']
            ];
            const checks = new Map();
            const choices = el('div', 'sbx-permission-choices');
            choices.appendChild(el('div', 'sbx-side-card-title', 'Additional permissions'));
            for (const [key, label] of permissionChoices) {
                const item = el('label', 'sbx-permission-choice');
                const checkbox = el('input');
                checkbox.type = 'checkbox';
                checks.set(key, checkbox);
                item.appendChild(checkbox);
                item.appendChild(el('span', '', label));
                choices.appendChild(item);
            }
            modal.appendChild(choices);
            const permissions = addJsonField(modal, 'Other permission overrides (optional JSON)', {}, '{ "some_named_permission": true }');
            modal.appendChild(el('div', 'sbx-empty-note', 'This development test user can be opened from the list without a password. A permission set to false overrides a role grant.'));
            addModalActions(modal, [
                { label: 'Cancel', onClick: closeModal },
                { label: 'Add user', primary: true, onClick: () => guarded(async () => {
                    await api(`/test-orgs/${encodeURIComponent(org.id)}/users`, { method: 'POST', body: {
                        name: name.value, email: email.value, role: role.value,
                        permissions: {
                            ...Object.fromEntries([...checks].filter(([, checkbox]) => checkbox.checked).map(([key]) => [key, true])),
                            ...parseJsonField(permissions, 'Other permission overrides')
                        }
                    } });
                    closeModal();
                    toast('User added');
                    await loadTestOrgUsers(org.id);
                }) }
            ]);
        });
    }

    function renderDefaultsPanel(workflow) {
        const defaults = workflow.defaults || {};
        const flagCount = Object.keys(defaults.app_flags || {}).length;
        const settingCount = Object.keys(defaults.settings || {}).length;
        const scopeFlagCount = Object.keys(defaults.scope_flags || {}).length;
        const details = el('details', 'sbx-defaults');
        const summary = el('summary');
        summary.textContent = `Default org state${flagCount || settingCount ? ` — ${flagCount} flag${flagCount === 1 ? '' : 's'}, ${settingCount} setting${settingCount === 1 ? '' : 's'} on top of platform defaults` : ' — platform defaults'}`;
        if (scopeFlagCount) {
            summary.textContent = summary.textContent.replace(
                ' on top of platform defaults',
                `, ${scopeFlagCount} scope set${scopeFlagCount === 1 ? '' : 's'} on top of platform defaults`
            );
        }
        details.appendChild(summary);
        const bodyWrap = el('div', 'sbx-defaults-body');
        const flags = addJsonField(bodyWrap, 'Default app flags ("group.flag": value)', defaults.app_flags, '{ "apps.equipment": false }');
        const settings = addJsonField(bodyWrap, 'Default settings (dot-path into org global data)', defaults.settings, '{ "branding.colors.primary": "#0b5cad" }');
        const scopeFlags = addJsonField(bodyWrap, 'Default scope sets ("scope_template_id": enabled)', defaults.scope_flags, '{ "sales_pipeline": false }');
        const save = el('button', 'sbx-btn', 'Save defaults');
        save.addEventListener('click', () => guarded(async () => {
            await patchWorkflow(workflow, {
                defaults: {
                    app_flags: parseJsonField(flags, 'Default app flags'),
                    settings: parseJsonField(settings, 'Default settings'),
                    scope_flags: parseJsonField(scopeFlags, 'Default scope sets')
                }
            });
            toast('Defaults saved');
        }));
        bodyWrap.appendChild(save);
        details.appendChild(bodyWrap);
        return details;
    }

    function renderStageTile(workflow, stage, index) {
        const page = pageById(stage.page_id) || { id: stage.page_id, title: 'Missing page', role: 'setup', status: 'placeholder' };
        const tile = el('div', 'sbx-stage-tile');
        tile.appendChild(el('div', 'sbx-stage-tile-index', String(index + 1)));
        tile.appendChild(el('div', 'sbx-stage-tile-title', page.title));
        tile.appendChild(chipRow(page));
        const idNode = el('div', 'sbx-stage-tile-id', page.id);
        idNode.title = 'Click to copy page id';
        idNode.addEventListener('click', () => copyText(page.id, 'Page id copied'));
        tile.appendChild(idNode);
        tile.appendChild(el('div', 'sbx-stage-tile-notes', stage.notes || ''));

        const actions = el('div', 'sbx-stage-tile-actions');
        const move = (offset) => guarded(async () => {
            const stages = [...workflow.stages];
            const target = index + offset;
            if (target < 0 || target >= stages.length) return;
            [stages[index], stages[target]] = [stages[target], stages[index]];
            await patchWorkflow(workflow, { stages });
        });
        actions.appendChild(iconBtn('fa-arrow-left', 'Move earlier', () => move(-1)));
        actions.appendChild(iconBtn('fa-arrow-right', 'Move later', () => move(1)));
        actions.appendChild(iconBtn('fa-pen', 'Edit page', () => openPageEditor(page)));
        actions.appendChild(iconBtn('fa-note-sticky', 'Edit stage notes', () => guarded(async () => {
            const notes = prompt('Stage notes:', stage.notes || '');
            if (notes === null) return;
            const stages = workflow.stages.map(s => s.id === stage.id ? { ...s, notes } : s);
            await patchWorkflow(workflow, { stages });
        })));
        actions.appendChild(iconBtn('fa-xmark', 'Remove stage', () => guarded(async () => {
            const stages = workflow.stages.filter(s => s.id !== stage.id);
            await patchWorkflow(workflow, { stages });
        })));
        tile.appendChild(actions);
        return tile;
    }

    // ---- Workflow creation -------------------------------------------------

    function openWorkflowCreator() {
        openModal((modal) => {
            modal.appendChild(el('h2', '', 'New workflow'));
            const title = addField(modal, 'Title', 'input', { value: '' });
            const entry = addField(modal, 'Entry mode', 'select', {
                options: [
                    { value: 'signup_first', label: 'Signup first (no landing page front step)' },
                    { value: 'landing_first', label: 'Landing page first (marketing front door)' }
                ],
                selected: 'signup_first'
            });
            addModalActions(modal, [
                { label: 'Cancel', onClick: closeModal },
                { label: 'Create', primary: true, onClick: () => guarded(async () => {
                    const payload = await api('/workflows', { method: 'POST', body: {
                        title: title.value,
                        entry_mode: entry.value
                    } });
                    state.selectedWorkflowId = payload.workflow.id;
                    closeModal();
                    toast('Workflow created');
                    await refresh();
                }) }
            ]);
        });
    }

    // ---- Settings projection ----------------------------------------------

    function projectionSection(parent, heading, value) {
        parent.appendChild(el('h3', 'sbx-projection-heading', heading));
        const pre = el('pre', 'sbx-projection-json');
        pre.textContent = JSON.stringify(value, null, 2);
        parent.appendChild(pre);
    }

    function openProjectionModal(workflow) {
        guarded(async () => {
            const payload = await api(`/workflows/${encodeURIComponent(workflow.id)}/projection`);
            const projection = payload.projection;
            openModal((modal) => {
                modal.appendChild(el('h2', '', `Settings projection — ${projection.workflow_title}`));
                modal.appendChild(el('div', 'sbx-empty-note', 'Platform defaults → workflow defaults (baseline) → each stage\'s effects, in order. "$user" entries depend on what the signing-up customer picks.'));
                projectionSection(modal, 'Baseline (org state at instance creation)', {
                    workflow_defaults: projection.baseline.workflow_defaults,
                    app_flags: projection.baseline.app_flags,
                    scope_flags: projection.baseline.scope_flags,
                    settings: projection.baseline.settings
                });
                projection.stages.forEach((stage, index) => {
                    projectionSection(modal, `Stage ${index + 1}: ${stage.page_title}`, {
                        effects: stage.effects,
                        user_choices: stage.user_choices
                    });
                });
                projectionSection(modal, 'Final state after the workflow', projection.final_state);
                addModalActions(modal, [
                    { label: 'Copy projection JSON', onClick: () => copyText(JSON.stringify(projection, null, 2), 'Projection JSON copied') },
                    { label: 'Close', primary: true, onClick: closeModal }
                ]);
            });
        });
    }

    // ---- Page modals -------------------------------------------------------

    function pageFormFields(modal, page = {}) {
        return {
            title: addField(modal, 'Title', 'input', { value: page.title || '' }),
            role: addField(modal, 'Role', 'select', {
                options: [
                    { value: 'setup', label: 'Setup step (shown to logged-in new org)' },
                    { value: 'signup', label: 'Signup (entry step, skipped by test instances)' },
                    { value: 'landing', label: 'Landing page (entry step, skipped by test instances)' }
                ],
                selected: page.role || 'setup'
            }),
            brief: addField(modal, 'Agent brief (what should this page do?)', 'textarea', { value: page.brief || '', placeholder: 'Placeholder pages get built later by Claude/Codex from this brief.' })
        };
    }

    function openPageCreator(onCreated) {
        openModal((modal) => {
            modal.appendChild(el('h2', '', 'New page (placeholder)'));
            const fields = pageFormFields(modal);
            addModalActions(modal, [
                { label: 'Cancel', onClick: closeModal },
                { label: 'Create', primary: true, onClick: () => guarded(async () => {
                    const payload = await api('/pages', { method: 'POST', body: {
                        title: fields.title.value,
                        role: fields.role.value,
                        brief: fields.brief.value
                    } });
                    closeModal();
                    toast(`Page created: ${payload.page.id}`);
                    await refresh();
                    if (onCreated) await onCreated(payload.page);
                }) }
            ]);
        });
    }

    function openVariantCreator(sourcePage, onCreated) {
        openModal((modal) => {
            modal.appendChild(el('h2', '', `New variant of "${sourcePage.title}"`));
            const title = addField(modal, 'Variant title', 'input', { value: `${sourcePage.title} (variant)` });
            const brief = addField(modal, 'What should differ from the original?', 'textarea', { value: sourcePage.brief || '' });
            addModalActions(modal, [
                { label: 'Cancel', onClick: closeModal },
                { label: 'Create variant', primary: true, onClick: () => guarded(async () => {
                    const payload = await api(`/pages/${encodeURIComponent(sourcePage.id)}/variant`, { method: 'POST', body: {
                        title: title.value,
                        brief: brief.value
                    } });
                    closeModal();
                    toast(`Variant created: ${payload.page.id}`);
                    await refresh();
                    if (onCreated) await onCreated(payload.page);
                }) }
            ]);
        });
    }

    function openPageEditor(page) {
        openModal((modal) => {
            modal.appendChild(el('h2', '', `Edit page — ${page.title}`));
            const fields = pageFormFields(modal, page);
            const status = addField(modal, 'Status', 'select', {
                options: [
                    { value: 'placeholder', label: 'Placeholder (not built yet)' },
                    { value: 'implemented', label: 'Implemented (bundle exists)' },
                    { value: 'builtin', label: 'Builtin (maps to existing FirstMate surface)' }
                ],
                selected: page.status
            });
            const effects = page.effects || {};
            const effectFlags = addJsonField(modal, 'App flags this page sets ("group.flag": value, or "$user" if the customer picks)', effects.app_flags, '{ "apps.equipment": "$user" }');
            const effectSettings = addJsonField(modal, 'Settings this page sets (dot-path into org global data)', effects.settings, '{ "branding.colors.primary": "$user" }');
            const effectScopeFlags = addJsonField(modal, 'Scope sets this page enables or disables ("scope_template_id": boolean)', effects.scope_flags, '{ "sales_pipeline": false }');
            addModalActions(modal, [
                { label: 'Cancel', onClick: closeModal },
                { label: 'Save', primary: true, onClick: () => guarded(async () => {
                    await api(`/pages/${encodeURIComponent(page.id)}`, { method: 'PATCH', body: {
                        title: fields.title.value,
                        role: fields.role.value,
                        brief: fields.brief.value,
                        status: status.value,
                        effects: {
                            app_flags: parseJsonField(effectFlags, 'App flag effects'),
                            settings: parseJsonField(effectSettings, 'Setting effects'),
                            scope_flags: parseJsonField(effectScopeFlags, 'Scope set effects')
                        }
                    } });
                    closeModal();
                    toast('Page saved');
                    await refresh();
                }) }
            ]);
        });
    }

    // ---- Add stage ---------------------------------------------------------

    async function appendStage(workflow, pageId) {
        const stages = [...(workflow.stages || []), { page_id: pageId, notes: '' }];
        await patchWorkflow(workflow, { stages });
    }

    function openAddStageModal(workflow) {
        openModal((modal) => {
            modal.appendChild(el('h2', '', 'Add stage'));
            const tabs = el('div', 'sbx-modal-tabs');
            const content = el('div');
            const views = {
                library: () => {
                    content.innerHTML = '';
                    if (!state.pages.length) {
                        content.appendChild(el('div', 'sbx-empty-note', 'The page library is empty.'));
                        return;
                    }
                    for (const page of state.pages) {
                        const item = el('div', 'sbx-picker-item');
                        item.appendChild(el('div', 'sbx-side-card-title', page.title));
                        item.appendChild(el('div', 'sbx-side-card-id', page.id));
                        item.appendChild(chipRow(page));
                        item.addEventListener('click', () => guarded(async () => {
                            closeModal();
                            await appendStage(workflow, page.id);
                            toast('Stage added');
                        }));
                        content.appendChild(item);
                    }
                },
                newPage: () => {
                    closeModal();
                    openPageCreator(async (page) => {
                        await appendStage(workflow, page.id);
                        toast('Placeholder page added to workflow');
                    });
                },
                variant: () => {
                    content.innerHTML = '';
                    content.appendChild(el('div', 'sbx-empty-note', 'Pick the page to branch from:'));
                    for (const page of state.pages) {
                        const item = el('div', 'sbx-picker-item');
                        item.appendChild(el('div', 'sbx-side-card-title', page.title));
                        item.appendChild(chipRow(page));
                        item.addEventListener('click', () => {
                            closeModal();
                            openVariantCreator(page, async (variant) => {
                                await appendStage(workflow, variant.id);
                                toast('Variant page added to workflow');
                            });
                        });
                        content.appendChild(item);
                    }
                }
            };
            const tabDefs = [
                { key: 'library', label: 'From library' },
                { key: 'newPage', label: 'New page' },
                { key: 'variant', label: 'New variant' }
            ];
            for (const def of tabDefs) {
                const tab = el('button', `sbx-modal-tab${def.key === 'library' ? ' active' : ''}`, def.label);
                tab.addEventListener('click', () => {
                    tabs.querySelectorAll('.sbx-modal-tab').forEach(node => node.classList.remove('active'));
                    tab.classList.add('active');
                    views[def.key]();
                });
                tabs.appendChild(tab);
            }
            modal.appendChild(tabs);
            modal.appendChild(content);
            views.library();
            addModalActions(modal, [{ label: 'Close', onClick: closeModal }]);
        });
    }

    // ---- Test instances ----------------------------------------------------

    function launchTestInstance(workflow) {
        guarded(async () => {
            toast('Creating test org…');
            const payload = await api(`/workflows/${encodeURIComponent(workflow.id)}/instances`, { method: 'POST', body: {} });
            toast(`Logged in as ${payload.test_org.org_name}`);
            window.open(payload.redirect, '_blank');
            await refresh();
        });
    }

    // ---- Import / export ---------------------------------------------------

    function openImportModal() {
        openModal((modal) => {
            modal.appendChild(el('h2', '', 'Import bundle'));
            const area = addField(modal, 'Paste a signup_sandbox_bundle JSON document', 'textarea', { className: 'sbx-code' });
            const overwrite = addField(modal, 'Existing docs with matching ids', 'select', {
                options: [
                    { value: 'no', label: 'Skip them' },
                    { value: 'yes', label: 'Overwrite them' }
                ],
                selected: 'no'
            });
            addModalActions(modal, [
                { label: 'Cancel', onClick: closeModal },
                { label: 'Import', primary: true, onClick: () => guarded(async () => {
                    const bundle = JSON.parse(area.value);
                    const payload = await api('/import', { method: 'POST', body: { bundle, overwrite: overwrite.value === 'yes' } });
                    closeModal();
                    const summary = payload.summary;
                    toast(`Imported ${summary.workflows_imported} workflow(s), ${summary.pages_imported} page(s)`);
                    await refresh();
                }) }
            ]);
        });
    }

    // ---- Boot --------------------------------------------------------------

    document.getElementById('sbx-tabs').addEventListener('click', (event) => {
        const tab = event.target.closest('.sbx-tab');
        if (!tab) return;
        state.sidebarTab = tab.dataset.tab;
        document.querySelectorAll('.sbx-tab').forEach(node => node.classList.toggle('active', node === tab));
        render();
    });

    document.getElementById('sbx-header-menu-btn').addEventListener('click', (event) => {
        event.stopPropagation();
        openMenu(event.currentTarget, [
            { icon: 'fa-file-import', label: 'Import bundle', onClick: openImportModal },
            { icon: 'fa-file-export', label: 'Export full library', onClick: () => guarded(async () => {
                const payload = await api('/export');
                await copyText(JSON.stringify(payload.bundle, null, 2), 'Library JSON copied');
            }) },
            { icon: 'fa-sign-out-alt', label: 'Admin logout', onClick: () => guarded(async () => { await api('/admin/logout', { method: 'POST', body: {} }); location.replace('/portal/experimental-admin.php'); }) },
            'sep',
            { icon: 'fa-arrow-up-right-from-square', label: 'Open portal', onClick: () => window.open('/portal/', '_blank') }
        ]);
    });

    document.getElementById('sbx-modal-backdrop').addEventListener('click', (event) => {
        if (event.target === event.currentTarget) closeModal();
    });

    guarded(refresh);
})();
