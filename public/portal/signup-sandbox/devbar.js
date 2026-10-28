// Signup Sandbox test runs and the dev console loader. Included on every
// signup surface (portal, login, landing pages). It asks the sandbox API
// whether the logged-in org is a sandbox test org and, if so, runs the test
// run: every stage goes to its REAL surface (wizard steps slide the actual
// onboarding wizard in place, landing/signup stages open the real pages, and
// placeholder/bundle pages render as an overlay inside the portal,
// ?sbx_stage=<index>). The stage list lives in the dev console's Test run
// section (libraries/dev-console), which this script loads on every
// development page; window.SignupSandboxRun is what that section drives.
// In production /v1/signup-sandbox is dead and this script does nothing.
(function () {
    'use strict';

    function apiBaseUrl() {
        const host = String(location.hostname || '').toLowerCase();
        if (host === '127.0.0.1' || host === 'localhost') {
            return `${location.origin}/v1/signup-sandbox`;
        }
        return `${location.origin}/v1/signup-sandbox`;
    }

    const ASSET_VERSION = new URL(document.currentScript?.src || location.href).searchParams.get('v') || 'dev';
    let overlayStageIndex = null;
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
        note.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#202124;color:#fff;border-radius:999px;padding:8px 16px;font:12.5px "Segoe UI",Roboto,sans-serif;z-index:2147483647;box-shadow:0 8px 20px rgba(0,0,0,0.25)';
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
            overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483200;background:#f6f7f9;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:clamp(16px,5vh,48px) clamp(12px,3vw,20px);box-sizing:border-box;font:14px "Segoe UI",Roboto,sans-serif;color:#202124`;
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

    // ---- Run ----------------------------------------------------------------

    // Which stage's surface (wizard step / overlay / page) is showing now.
    function activeStageIndex(instance) {
        const hook = wizardHook();
        if (overlayStageIndex !== null) return overlayStageIndex;
        const wizardCurrent = hook && hook.isVisible() ? hook.currentPage() : null;
        return (instance.stages || []).findIndex((stage) => {
            if (wizardCurrent !== null && stageKind(stage) === 'wizard') {
                return hook.pageIndexForName(String((stage.page.implementation || {}).builtin_ref || 'branding')) === wizardCurrent;
            }
            if (String((stage.page.implementation || {}).type) === 'landing_embed' && location.pathname.indexOf('/landing/') !== -1) {
                const variant = new URLSearchParams(location.search).get('variant') || 'measurements';
                return String(stage.target).indexOf(`variant=${encodeURIComponent(variant)}`) !== -1;
            }
            return String(stage.page.role) === 'signup' && location.pathname.indexOf('login.php') !== -1;
        });
    }

    // Opens a stage from the console: wizard steps and portal overlays in
    // place, other surfaces by navigating.
    function openStage(instance, index) {
        const stage = instance.stages[index];
        if (!stage) return;
        const kind = stageKind(stage);
        const onPortal = /\/portal\/(index\.php)?$/.test(location.pathname.replace(/\/+$/, '/'));
        if (kind === 'wizard' && wizardHook()) {
            closeStageOverlay();
            const idx = wizardStepIndex(stage);
            if (idx !== null) jumpWizardTo(idx);
            return;
        }
        if ((kind === 'placeholder' || kind === 'bundle') && onPortal) {
            renderStageOverlay(instance, index);
            return;
        }
        location.href = stage.target;
    }

    function start(instance) {
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

        // When the real wizard is dismissed (Finish/skip posts
        // onboarding_complete), reload into the configured app: the shell
        // behind the wizard was built before the workflow applied its
        // flags/settings, so only a fresh boot shows the real result.
        let wizardWasVisible = false;
        setInterval(() => {
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

    function exposeRun(instance, running) {
        window.SignupSandboxRun = {
            instance: () => currentInstance || instance,
            // A workflow can run without its test-run controls (`dev_bar` false).
            running,
            stageDone: (stage) => stageDone(currentInstance || instance, stage),
            isEntryStage,
            activeStageIndex: () => activeStageIndex(currentInstance || instance),
            openStage: (index) => openStage(currentInstance || instance, index),
            closeStageOverlay
        };
        window.dispatchEvent(new CustomEvent('fm:sandbox-run:ready'));
    }

    function loadConsole() {
        if (window.top !== window) return;
        import('/libraries/dev-console/dev-console.js?v=20261028-dock1').then((module) => module.mount()).catch(() => {});
    }

    fetch(`${apiBaseUrl()}/current-instance`, { credentials: 'include' })
        .then((res) => {
            // Production: the sandbox API is gone, and so is everything here.
            if (res.status === 404) return null;
            loadConsole();
            return res.ok ? res.json() : null;
        })
        .then((payload) => {
            if (!payload || !payload.ok || !payload.instance) return;
            const running = payload.instance.workflow?.dev_bar !== false;
            if (running) start(payload.instance);
            exposeRun(payload.instance, running);
        })
        .catch(() => { /* not a dev environment; stay silent */ });
})();
