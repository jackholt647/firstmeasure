(function () {
    'use strict';

    function apiBaseUrl() {
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost') {
            return `${location.origin}/v1/signup-sandbox`;
        }
        return `${location.origin}/v1/signup-sandbox`;
    }

    const state = {
        workflows: [],
        pages: [],
        testOrgs: [],
        selectedWorkflowId: null,
        sidebarTab: 'workflows'
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
        main.innerHTML = '';
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
        renderSidebar();
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
