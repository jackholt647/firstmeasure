// Signup Sandbox dev bar. Included on every signup surface (portal, login,
// landing pages); asks the sandbox API whether the logged-in org is a sandbox
// test org and, if so, injects a thin bar along the bottom of the screen with
// one pill per workflow stage. Every pill goes to the stage's REAL surface:
// wizard steps slide the actual onboarding wizard in place, landing/signup
// pills open the real pages, and placeholder/bundle pages render as an
// overlay inside the portal (?sbx_stage=<index>) — there is no separate
// runner page. For everyone else (and in production, where /v1/signup-sandbox
// is dead) this script does nothing.
(function () {
    'use strict';

    function apiBaseUrl() {
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost') {
            return `${location.origin}/v1/signup-sandbox`;
        }
        return `${location.origin}/v1/signup-sandbox`;
    }

    if (sessionStorage.getItem('sbxDevbarHidden') === '1') return;

    const BAR_HEIGHT = 34;
    const ASSET_VERSION = new URL(document.currentScript?.src || location.href).searchParams.get('v') || 'dev';
    let overlayStageIndex = null;
    let pills = [];
    let currentInstance = null;
    const loadedBundles = {};

    async function api(path, options = {}) {
        const res = await fetch(`${apiBaseUrl()}${path}`, {
            credentials: 'include',
            headers: options.body ? { 'Content-Type': 'application/json' } : {},
            ...options,
            body: options.body ? JSON.stringify(options.body) : undefined
        });
        const payload = await res.json();
        if (!res.ok || payload.ok === false) throw new Error(payload.error || `Request failed (${res.status}).`);
        return payload;
    }

    function toastLine(message) {
        const note = document.createElement('div');
        note.textContent = message;
        note.style.cssText = 'position:fixed;bottom:44px;left:50%;transform:translateX(-50%);background:#202124;color:#fff;border-radius:999px;padding:8px 16px;font:12.5px "Segoe UI",Roboto,sans-serif;z-index:2147483647;box-shadow:0 8px 20px rgba(0,0,0,0.25)';
        document.body.appendChild(note);
        setTimeout(() => note.remove(), 2400);
    }

    // ---- Wizard bridge -----------------------------------------------------

    function wizardHook() {
        const hook = window.Portal && window.Portal.modules && window.Portal.modules.onboarding_wizard;
        return hook && typeof hook.goToPage === 'function' ? hook : null;
    }

    function isEntryStage(stage) {
        const role = String((stage.page || {}).role || 'setup');
        return role === 'landing' || role === 'signup';
    }

    function stageKind(stage) {
        const page = stage.page || {};
        const implementation = page.implementation || {};
        const type = String(implementation.type || 'placeholder');
        if (type === 'builtin_wizard' && String(page.role) === 'setup') return 'wizard';
        if (type === 'bundle') return 'bundle';
        if (type === 'placeholder') return 'placeholder';
        return 'external'; // landing / signup / anything with its own page
    }

    function wizardStepIndex(stage) {
        const hook = wizardHook();
        if (!hook || stageKind(stage) !== 'wizard') return null;
        const idx = hook.pageIndexForName(String((stage.page.implementation || {}).builtin_ref || 'branding'));
        return typeof idx === 'number' ? idx : null;
    }

    function jumpWizardTo(idx) {
        const hook = wizardHook();
        if (!hook) return;
        if (!hook.isVisible()) hook.show();
        // Never goToPage the page we're already on: the wizard's transition
        // marks the current page exit-left without re-activating it (blank).
        setTimeout(() => {
            if (hook.currentPage() !== idx) hook.goToPage(idx);
        }, 50);
    }

    function stageDone(instance, stage) {
        if ((instance.completed_stage_ids || []).includes(stage.id)) return true;
        if (stageKind(stage) === 'wizard') return Boolean(instance.onboarding_completed);
        return false;
    }

    // ---- Stage overlay (placeholder/bundle pages, inside the real portal) --

    function closeStageOverlay() {
        overlayStageIndex = null;
        const overlay = document.getElementById('sbx-stage-overlay');
        if (overlay) overlay.remove();
        setWizardHidden(false);
        syncStageParam();
    }

    function setWizardHidden(hidden) {
        let style = document.getElementById('sbx-wizard-hide-style');
        if (hidden && !style) {
            style = document.createElement('style');
            style.id = 'sbx-wizard-hide-style';
            style.textContent = '#obOverlay, #obPrecover { display: none !important; }';
            document.head.appendChild(style);
        } else if (!hidden && style) {
            style.remove();
        }
    }

    function syncStageParam() {
        const url = new URL(location.href);
        if (overlayStageIndex === null) url.searchParams.delete('sbx_stage');
        else url.searchParams.set('sbx_stage', String(overlayStageIndex));
        history.replaceState(null, '', url.toString());
    }

    function stageContext(instance, stage, index) {
        return {
            workflow: instance.workflow,
            stage,
            page: stage.page,
            instanceId: String(instance.test_org.id),
            apiBaseUrl: apiBaseUrl(),
            back: () => goToStage(instance, Math.max(0, index - 1)),
            complete: (input = {}) => completeAndAdvance(instance, stage, index, input)
        };
    }

    async function completeAndAdvance(instance, stage, index, input = {}) {
        try {
            const result = await api(`/test-orgs/${encodeURIComponent(instance.test_org.id)}/complete-stage/${encodeURIComponent(stage.id)}`, { method: 'POST', body: input });
            if (result.effects && result.effects.applied) toastLine('Applied this stage\'s declared effects to the test org');
            instance.completed_stage_ids = result.completed_stage_ids || instance.completed_stage_ids;
        } catch (error) {
            toastLine(`Could not record stage completion: ${error.message}`);
        }
        goToStage(instance, index + 1);
    }

    function renderStageOverlay(instance, index) {
        const stage = instance.stages[index];
        if (!stage) return;
        overlayStageIndex = index;
        setWizardHidden(true);
        syncStageParam();

        let overlay = document.getElementById('sbx-stage-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'sbx-stage-overlay';
            overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:${BAR_HEIGHT}px;z-index:2147483200;background:#f6f7f9;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:clamp(16px,5vh,48px) clamp(12px,3vw,20px);box-sizing:border-box;font:14px "Segoe UI",Roboto,sans-serif;color:#202124`;
            document.body.appendChild(overlay);
        }
        overlay.innerHTML = '';

        const card = document.createElement('div');
        card.style.cssText = 'background:#fff;border:1px solid #e4e7ec;border-radius:14px;margin:0;padding:clamp(20px,4vw,30px);width:min(720px,100%);box-sizing:border-box;box-shadow:0 4px 18px rgba(16,24,40,0.06)';
        overlay.appendChild(card);

        const page = stage.page || {};
        const implementation = page.implementation || {};

        if (stageKind(stage) === 'bundle' && implementation.bundle) {
            const mount = document.createElement('div');
            card.appendChild(mount);
            const renderFromRegistry = () => {
                const registry = window.SignupSandboxPages || {};
                const module = registry[page.id];
                if (module && typeof module.render === 'function') {
                    module.render(mount, stageContext(instance, stage, index));
                } else {
                    mount.textContent = `Bundle loaded but no page registered under window.SignupSandboxPages['${page.id}'].`;
                }
            };
            if (loadedBundles[page.id]) {
                renderFromRegistry();
            } else {
                const script = document.createElement('script');
                script.src = `/portal/signup-sandbox/${implementation.bundle}?v=${encodeURIComponent(ASSET_VERSION)}`;
                script.onload = () => { loadedBundles[page.id] = true; renderFromRegistry(); };
                script.onerror = () => {
                    mount.textContent = `Failed to load bundle /portal/signup-sandbox/${implementation.bundle}. The page is marked implemented but the file is missing.`;
                };
                document.body.appendChild(script);
            }
            return;
        }

        // Placeholder card: what this page will be, straight from its doc.
        const heading = document.createElement('h2');
        heading.textContent = page.title || stage.page_id;
        heading.style.cssText = 'margin:0 0 6px;font-size:20px';
        card.appendChild(heading);

        const meta = document.createElement('div');
        meta.textContent = `${page.id} · role: ${page.role} · status: ${page.status}`;
        meta.style.cssText = 'font-family:Consolas,monospace;font-size:11.5px;color:#667085;margin-bottom:14px';
        card.appendChild(meta);

        const brief = document.createElement('div');
        brief.style.cssText = 'background:#f6f7f9;border-radius:9px;padding:13px 15px;font-size:13px;color:#475467;white-space:pre-wrap';
        let text = `This page has not been built yet — this card stands in for it during test runs.\n\nBrief:\n${page.brief || '(no brief yet)'}`;
        const effects = page.effects || {};
        const flagEntries = Object.entries(effects.app_flags || {});
        const settingEntries = Object.entries(effects.settings || {});
        if (flagEntries.length || settingEntries.length) {
            text += '\n\nDeclared effects (literal values apply to this test org on Continue):';
            for (const [key, value] of flagEntries) text += `\n  flag ${key} = ${JSON.stringify(value)}`;
            for (const [key, value] of settingEntries) text += `\n  setting ${key} = ${JSON.stringify(value)}`;
        }
        brief.textContent = text;
        card.appendChild(brief);

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;margin-top:18px';
        const continueBtn = document.createElement('button');
        continueBtn.textContent = 'Continue';
        continueBtn.style.cssText = 'background:#d93025;border:none;color:#fff;border-radius:8px;padding:9px 16px;font-size:13.5px;cursor:pointer;font-family:inherit';
        continueBtn.addEventListener('click', () => completeAndAdvance(instance, stage, index));
        actions.appendChild(continueBtn);
        card.appendChild(actions);
    }

    // ---- Stage navigation --------------------------------------------------

    function goToStage(instance, index) {
        if (index >= instance.stages.length) {
            // Workflow complete: boot the configured app cleanly. The current
            // shell was built before the stages applied their flags/settings,
            // so a fresh load is what actually shows the configured instance.
            location.replace('/portal/');
            return;
        }
        const stage = instance.stages[Math.max(0, index)];
        const kind = stageKind(stage);
        if (kind === 'placeholder' || kind === 'bundle') {
            const onPortal = location.pathname.replace(/\/+$/, '/').endsWith('/portal/') || /\/portal\/(index\.php)?$/.test(location.pathname);
            if (onPortal) {
                renderStageOverlay(instance, instance.stages.indexOf(stage));
            } else {
                location.href = stage.target;
            }
            return;
        }
        if (kind === 'wizard') {
            const idx = wizardStepIndex(stage);
            if (idx !== null) {
                closeStageOverlay();
                jumpWizardTo(idx);
                return;
            }
        }
        location.href = stage.target;
    }

    // ---- Bar ---------------------------------------------------------------

    function render(instance) {
        currentInstance = instance;
        // The production branding page owns the whole branding interaction.
        // In a composed sandbox workflow, resume the configured next stage
        // after it saves instead of falling through to the production
        // wizard's fixed page sequence.
        window.addEventListener('fm:onboarding:branding-complete', (event) => {
            const hook = wizardHook();
            const index = (instance.stages || []).findIndex((stage) =>
                stageKind(stage) === 'wizard'
                && String((stage.page.implementation || {}).builtin_ref || '') === 'branding'
                && hook
                && hook.currentPage() === wizardStepIndex(stage));
            if (index < 0) return;
            event.preventDefault();
            void completeAndAdvance(instance, instance.stages[index], index);
        }, { once: true });
        const bar = document.createElement('div');
        bar.id = 'sbx-devbar';
        bar.style.cssText = [
            'position:fixed', 'bottom:0', 'left:0', 'right:0', `height:${BAR_HEIGHT}px`,
            'z-index:2147483647', 'display:flex', 'align-items:center', 'gap:8px',
            'padding:0 10px', 'background:#ffffff', 'color:#202124',
            'border-top:1px solid #e2e5ea',
            'font:12px "Segoe UI", Roboto, sans-serif', 'overflow-x:auto',
            'white-space:nowrap', 'box-shadow:0 -2px 10px rgba(0,0,0,0.08)'
        ].join(';');

        const label = document.createElement('span');
        label.style.cssText = 'font-weight:700;color:#d93025;flex:0 0 auto;display:inline-flex;align-items:center;gap:6px';
        label.innerHTML = '<i class="fa-solid fa-flask"></i> TEST RUN';
        label.title = `${instance.workflow.title} — ${instance.test_org.org_name} (${instance.test_org.email} / ${instance.test_org.password})`;
        bar.appendChild(label);

        pills = [];
        (instance.stages || []).forEach((stage, index) => {
            const pill = document.createElement('a');
            const page = stage.page || {};
            const done = stageDone(instance, stage);
            const skippedEntry = isEntryStage(stage);
            pill.href = stage.target;
            pill.textContent = `${index + 1} · ${page.title || stage.page_id}`;
            pill.style.cssText = [
                'flex:0 0 auto', 'display:inline-flex', 'align-items:center', 'gap:5px',
                'padding:3px 10px', 'border-radius:999px', 'text-decoration:none',
                `color:${done ? '#137333' : '#202124'}`,
                `border:1px solid ${done ? '#137333' : '#d5d9e0'}`,
                skippedEntry ? 'opacity:0.65;font-style:italic' : ''
            ].filter(Boolean).join(';');
            if (done) pill.innerHTML = `<i class="fa-solid fa-check"></i>${pill.textContent}`;
            if (skippedEntry) pill.title = 'Entry step — already satisfied for this test org, but you can still view the real page.';
            pill.addEventListener('click', (event) => {
                const kind = stageKind(stage);
                const onPortal = /\/portal\/(index\.php)?$/.test(location.pathname.replace(/\/+$/, '/'));
                if (kind === 'wizard' && wizardHook()) {
                    event.preventDefault();
                    closeStageOverlay();
                    const idx = wizardStepIndex(stage);
                    if (idx !== null) jumpWizardTo(idx);
                } else if ((kind === 'placeholder' || kind === 'bundle') && onPortal) {
                    event.preventDefault();
                    renderStageOverlay(instance, index);
                }
                // External surfaces (landing/signup) navigate via href.
            });
            pills.push({ pill, stage, index, done });
            bar.appendChild(pill);
        });

        const spacer = document.createElement('span');
        spacer.style.cssText = 'flex:1 1 auto';
        bar.appendChild(spacer);

        const builderLink = document.createElement('a');
        builderLink.href = '/portal/signup-sandbox/';
        builderLink.textContent = 'Builder';
        builderLink.style.cssText = 'color:#1a73e8;text-decoration:none;flex:0 0 auto';
        bar.appendChild(builderLink);

        const hideBtn = document.createElement('button');
        hideBtn.innerHTML = '&times;';
        hideBtn.title = 'Hide for this tab session';
        hideBtn.style.cssText = 'flex:0 0 auto;background:none;border:none;color:#6b7280;font-size:16px;cursor:pointer;padding:0 2px;font-family:inherit';
        hideBtn.addEventListener('click', () => {
            sessionStorage.setItem('sbxDevbarHidden', '1');
            closeStageOverlay();
            const styleTag = document.getElementById('sbx-devbar-style');
            if (styleTag) styleTag.remove();
            bar.remove();
        });
        bar.appendChild(hideBtn);

        document.body.appendChild(bar);
        // Keep the page's own bottom edge (and the wizard overlay, which is a
        // full-screen fixed element) clear of the bar.
        const style = document.createElement('style');
        style.id = 'sbx-devbar-style';
        style.textContent = `
            #obOverlay { bottom: ${BAR_HEIGHT}px !important; }
            #sbx-devbar { scrollbar-width: none; }
            #sbx-devbar::-webkit-scrollbar { display: none; }
            body { padding-bottom: ${BAR_HEIGHT}px; }
            @media (max-width: 520px) {
                #obOverlay .ob-pages {
                    height: calc(100vh - ${BAR_HEIGHT}px);
                    height: calc(100dvh - ${BAR_HEIGHT}px);
                    max-height: calc(100vh - ${BAR_HEIGHT}px);
                    max-height: calc(100dvh - ${BAR_HEIGHT}px);
                }
            }
        `;
        document.head.appendChild(style);

        // Highlight whichever stage's surface (wizard step / overlay / page)
        // is currently showing.
        function updateActive() {
            const hook = wizardHook();
            const wizardVisible = hook && hook.isVisible() && overlayStageIndex === null;
            const wizardCurrent = wizardVisible ? hook.currentPage() : null;
            pills.forEach((entry) => {
                let active = false;
                if (overlayStageIndex !== null) {
                    active = entry.index === overlayStageIndex;
                } else if (wizardCurrent !== null && stageKind(entry.stage) === 'wizard') {
                    active = hook.pageIndexForName(String((entry.stage.page.implementation || {}).builtin_ref || 'branding')) === wizardCurrent;
                } else if (String((entry.stage.page.implementation || {}).type) === 'landing_embed' && location.pathname.indexOf('/landing/') !== -1) {
                    const variant = new URLSearchParams(location.search).get('variant') || 'measurements';
                    active = String(entry.stage.target).indexOf(`variant=${encodeURIComponent(variant)}`) !== -1;
                } else if (String(entry.stage.page.role) === 'signup' && location.pathname.indexOf('login.php') !== -1) {
                    active = true;
                }
                entry.pill.style.background = active ? 'rgba(217,48,37,0.08)' : 'transparent';
                entry.pill.style.borderColor = active ? '#d93025' : (entry.done ? '#137333' : '#d5d9e0');
            });
        }
        updateActive();
        setInterval(updateActive, 700);

        // When the real wizard is dismissed (Finish/skip posts
        // onboarding_complete), reload into the configured app: the shell
        // behind the wizard was built before the workflow applied its
        // flags/settings, so only a fresh boot shows the real result.
        let wizardWasVisible = false;
        setInterval(() => {
            if (!document.body.contains(bar)) return;
            const hook = wizardHook();
            const visible = Boolean(hook && hook.isVisible());
            if (wizardWasVisible && !visible && overlayStageIndex === null) {
                location.replace('/portal/');
                return;
            }
            wizardWasVisible = visible;
        }, 500);

        // Deep links: ?sbx_stage=<index> opens the stage overlay; ?sbx_step=
        // <name> jumps the wizard once it has booted.
        const params = new URLSearchParams(location.search);
        const stageParam = params.get('sbx_stage');
        if (stageParam !== null && instance.stages[Number(stageParam)]) {
            renderStageOverlay(instance, Number(stageParam));
        }
        const requestedStep = params.get('sbx_step');
        if (requestedStep) {
            const startedAt = Date.now();
            const poll = setInterval(() => {
                const hook = wizardHook();
                if (hook && hook.isVisible()) {
                    clearInterval(poll);
                    const idx = hook.pageIndexForName(requestedStep);
                    if (typeof idx === 'number' && hook.currentPage() !== idx) hook.goToPage(idx);
                } else if (Date.now() - startedAt > 8000) {
                    clearInterval(poll);
                }
            }, 150);
        }
    }

    fetch(`${apiBaseUrl()}/current-instance`, { credentials: 'include' })
        .then((res) => (res.ok ? res.json() : null))
        .then((payload) => {
            if (payload && payload.ok && payload.instance) render(payload.instance);
        })
        .catch(() => { /* not a dev environment; stay silent */ });
})();
