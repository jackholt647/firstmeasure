/* FirstMate setup-wizard shell: the standardized full-screen onboarding
 * workflow dialog (head + step rail + body + foot) shared by settings
 * wizards such as domain onboarding and, in the future, SMS/10DLC setup.
 *
 * window.FirstMateSetupWizard.open(config) -> controller
 *
 * config:
 *   id            string   Stable identifier; used for route sources and the modal id.
 *   workflowKey   string   Value written to the `workflow` route key while open.
 *   title         string   Head title (bold line).
 *   subtitle      string|fn(ctx) Head subtitle line (per-step copy allowed).
 *   icon          string   FontAwesome class for the head icon (e.g. 'fa-globe').
 *   steps         array|fn(ctx) -> [{ id, label, optional?,
 *                     render(container, ctx),                 required
 *                     renderFooter?(container, ctx),          replaces default Back/Continue
 *                     validate?(ctx) -> issues[],             gates default Continue
 *                     status?(ctx) -> 'done'|'needs-attention'|null|{state,label,icon},
 *                     nextLabel?|fn(ctx) }]
 *   initialStepId string   Step to open on (deep links / reopen).
 *   state         object   Arbitrary mutable state shared with the steps via ctx.state.
 *   autosave      { debounceMs?, save(state)->Promise }  Debounced persistence;
 *                 renderers call ctx.touch() after mutating state.
 *   locked        bool|fn  Read-only mode (post-submit); disables autosave + submit.
 *   onSubmit      fn(ctx)  Invoked by the default footer's final-step button.
 *   submitLabel   string   Label for that button (default 'Submit').
 *   onClose       fn(info) Called after the wizard closes.
 *   writeRoute    fn(patch, options)  Host route writer (e.g. company settings'
 *                 writeSettingsRoute). Default: Portal.navigation.write.
 *   routeMatch    fn(route) -> bool  Extra route-scope predicate; when it
 *                 returns false the wizard closes even if `workflow` still
 *                 matches (e.g. SMS requires tab=company_settings&sub=sms).
 *   closeRoute    fn()     Host route clearer. Default: Portal.navigation.backOrClose
 *                 over ['workflow','workflow_step'].
 *   canClose      fn(reason) -> bool  Return false to block escape/backdrop close.
 *   closeOnEscape / closeOnBackdrop  bool (default true), forwarded to Portal.modals.
 *   stepNavigable fn(stepId, ctx) -> bool  Whether the rail button is clickable.
 *   railNote      string|fn(ctx) -> html   Bottom-of-rail note (trusted host html).
 *   statusNote    string   Initial footer status text.
 *   onBeforeStep  fn(fromId, toId, ctx)  Runs before any step change (capture drafts).
 *   onStepChange  fn(toId, fromId, ctx)  Runs after any step change, before render.
 *
 * controller: { id, el, ctx, goTo(stepId), refresh(), close(options),
 *               setLocked(value), getState() }
 */
(function(){
  'use strict';
  if (window.FirstMateSetupWizard) return;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clean = (value) => String(value ?? '').trim();
  let cssReady = false;

  function ensureCss(){
    if (cssReady) return;
    cssReady = true;
    const style = document.createElement('style');
    style.id = 'fm-setup-wizard-css';
    style.textContent = `
      .fm-wizard-backdrop{position:fixed;inset:0;z-index:2147483300;display:flex;align-items:stretch;justify-content:center;background:rgba(15,23,42,.46);backdrop-filter:blur(5px);padding:14px}
      .fm-wizard{display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:min(1180px,100%);overflow:hidden;border:1px solid rgba(15,23,42,.12);border-radius:18px;background:#fff;box-shadow:0 28px 90px rgba(15,23,42,.3);color:#101828}
      .fm-wizard *{box-sizing:border-box}
      .fm-wizard-head{height:66px;display:flex;align-items:center;justify-content:space-between;gap:14px;border-bottom:3px solid var(--primary-readable,var(--primary,#d93025));padding:0 18px}
      .fm-wizard-title{display:flex;align-items:center;gap:11px;min-width:0}
      .fm-wizard-title-icon{display:grid;place-items:center;width:36px;height:36px;flex:0 0 36px;border-radius:10px;background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025));font-size:15px}
      .fm-wizard-title strong{display:block;color:#101828;font-size:17px;font-weight:1000}
      .fm-wizard-subtitle{display:block;margin-top:3px;overflow:hidden;color:#667085;font-size:11px;font-weight:900;text-overflow:ellipsis;white-space:nowrap}
      .fm-wizard-close{display:grid;place-items:center;width:38px;height:38px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;color:#344054;cursor:pointer}
      .fm-wizard-body{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:0}
      .fm-wizard-rail{display:flex;min-height:0;flex-direction:column;border-right:1px solid #eaecf0;background:#f8fafc;padding:14px}
      .fm-wizard-steps{display:grid;align-content:start;gap:8px;overflow:auto}
      .fm-wizard-step{display:grid;gap:4px;border:1px solid transparent;border-radius:12px;background:transparent;padding:11px;color:#344054;text-align:left;cursor:pointer}
      .fm-wizard-step:disabled{cursor:default;opacity:.58}
      .fm-wizard-step-title{display:flex;align-items:center;gap:8px;min-width:0}
      .fm-wizard-step .num{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:0 0 20px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#667085;font-size:9px}
      .fm-wizard-step strong{min-width:0;overflow-wrap:anywhere;font-size:12px;font-weight:1000}
      .fm-wizard-step-status{color:#667085;font-size:11px;font-weight:800;line-height:1.3}
      .fm-wizard-step.active{border-color:#d0d5dd;background:#fff;box-shadow:0 8px 18px rgba(15,23,42,.06);color:#101828}
      .fm-wizard-step.active .num{border-color:rgba(var(--primary-rgb,217,48,37),.38);background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025))}
      .fm-wizard-step.done strong{color:#166534}
      .fm-wizard-step.done .num{border-color:#86efac;background:#dcfce7;color:#166534}
      .fm-wizard-step.needs-attention strong{color:#9a3412}
      .fm-wizard-step.needs-attention .num{border-color:#fed7aa;background:#fff7ed;color:#c2410c}
      .fm-wizard-rail-foot{margin-top:auto;padding:16px 4px 2px;color:#667085;font-size:9px;line-height:1.5}
      .fm-wizard-main{min-width:0;min-height:0}
      .fm-wizard-pane{height:100%;overflow:auto;padding:18px 22px}
      .fm-wizard-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;min-height:62px;border-top:1px solid #eaecf0;padding:10px 18px;background:#fff}
      .fm-wizard-foot-note{margin-right:auto;color:#667085;font-size:11px;font-weight:850}
      .fm-wizard-foot-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
      .fm-wizard-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:40px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:8px 13px;color:#344054;font:900 11px/1.2 inherit;cursor:pointer}
      .fm-wizard-btn.primary{border-color:var(--primary-readable,var(--primary,#d93025));background:var(--primary-readable,var(--primary,#d93025));color:#fff}
      .fm-wizard-btn:disabled{opacity:.5;cursor:default}
      .fm-wizard-issues{display:flex;align-items:flex-start;gap:9px;margin:0 0 16px;border:1px solid #fecdca;border-radius:10px;background:#fef3f2;padding:11px 12px;color:#912018;font-size:10px;font-weight:800;line-height:1.5}
      .fm-wizard-issues i{margin-top:2px}
      .fm-wizard-issues ul{margin:4px 0 0;padding-left:16px;display:grid;gap:3px}
      @media(max-width:860px){.fm-wizard-backdrop{padding:0}.fm-wizard{border-radius:0}.fm-wizard-body{grid-template-columns:1fr}.fm-wizard-rail{border-right:0;border-bottom:1px solid #eaecf0}.fm-wizard-steps{display:flex;overflow-x:auto}.fm-wizard-step{min-width:180px}.fm-wizard-head{height:auto;min-height:66px}.fm-wizard-foot{height:auto;min-height:62px}}
    `;
    document.head.appendChild(style);
  }

  function open(config = {}){
    ensureCss();
    const id = clean(config.id) || 'setup-wizard';
    const workflowKey = clean(config.workflowKey);
    const state = config.state && typeof config.state === 'object' ? config.state : {};
    const debounceMs = Number(config.autosave?.debounceMs) > 0 ? Number(config.autosave.debounceMs) : 900;
    let lockedOverride = null;
    let closed = false;
    let statusText = clean(config.statusNote);
    let issues = [];
    let saveTimer = null;
    let savePromise = null;
    let saveDirty = false;

    const isLocked = () => {
      if (lockedOverride !== null) return lockedOverride;
      if (typeof config.locked === 'function') return config.locked() === true;
      return config.locked === true;
    };

    const overlay = document.createElement('div');
    overlay.className = 'fm-wizard-backdrop';
    overlay.dataset.fmWizard = id;

    /* ---- autosave ---------------------------------------------------- */
    const renderFootNote = () => {
      const note = overlay.querySelector('[data-fm-note]');
      if (note) note.textContent = statusText;
    };
    const runSave = async () => {
      if (typeof config.autosave?.save !== 'function') return true;
      if (savePromise) {
        const prior = await savePromise;
        if (!prior) return false;
        return runSave();
      }
      statusText = 'Saving draft...';
      renderFootNote();
      saveDirty = false;
      savePromise = (async () => {
        try {
          await config.autosave.save(state);
          statusText = 'Autosaved.';
          return true;
        } catch (error) {
          statusText = clean(error?.message) || 'Could not save the draft.';
          return false;
        } finally {
          renderFootNote();
        }
      })();
      try {
        return await savePromise;
      } finally {
        savePromise = null;
      }
    };
    const scheduleSave = () => {
      if (typeof config.autosave?.save !== 'function' || isLocked()) return;
      saveDirty = true;
      statusText = 'Autosave pending...';
      renderFootNote();
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        runSave();
      }, debounceMs);
    };
    const flushSave = async () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (typeof config.autosave?.save !== 'function' || isLocked()) return true;
      if (!saveDirty) {
        if (savePromise) return savePromise;
        return true;
      }
      return runSave();
    };

    /* ---- routing ----------------------------------------------------- */
    const writeStepRoute = (stepId) => {
      if (!workflowKey) return;
      if (window.Portal?.navigation?.applying) return;
      const patch = { workflow: workflowKey, workflow_step: stepId };
      const options = { history:'push', source:`${id}-step`, ownedKeys:['workflow','workflow_step'] };
      if (typeof config.writeRoute === 'function') config.writeRoute(patch, options);
      else window.Portal?.navigation?.write?.(patch, options);
    };
    const clearRoute = () => {
      if (typeof config.closeRoute === 'function') { config.closeRoute(); return; }
      if (!workflowKey) return;
      if (window.Portal?.navigation?.applying) return;
      window.Portal?.navigation?.backOrClose?.(['workflow','workflow_step'], { workflow:'', workflow_step:'' }, { source:`${id}-close` });
    };

    /* ---- steps ------------------------------------------------------- */
    const stepsList = () => {
      const raw = typeof config.steps === 'function' ? config.steps(ctx) : config.steps;
      return Array.isArray(raw) ? raw.filter((step) => step && clean(step.id)) : [];
    };
    const currentIndex = () => {
      const steps = stepsList();
      const index = steps.findIndex((step) => step.id === currentStepId);
      return index >= 0 ? index : 0;
    };

    const applyStepChange = (stepId, options = {}) => {
      const previous = currentStepId;
      if (typeof config.onBeforeStep === 'function' && overlay.isConnected) {
        try { config.onBeforeStep(previous, stepId, ctx); } catch (error) { console.warn(`FirstMate setup wizard onBeforeStep failed: ${id}`, error); }
      }
      issues = [];
      currentStepId = stepId;
      if (typeof config.onStepChange === 'function') {
        try { config.onStepChange(stepId, previous, ctx); } catch (error) { console.warn(`FirstMate setup wizard onStepChange failed: ${id}`, error); }
      }
      if (options.route !== false) writeStepRoute(stepId);
      render();
    };

    async function goTo(stepId, options = {}){
      if (closed) return;
      const target = clean(stepId);
      if (!stepsList().some((step) => step.id === target)) return;
      if (target === currentStepId) { render(); return; }
      if (options.flush !== false && !(await flushSave())) { render(); return; }
      applyStepChange(target, options);
    }

    async function continueStep(){
      const steps = stepsList();
      const index = currentIndex();
      const step = steps[index] || {};
      issues = typeof step.validate === 'function' ? (step.validate(ctx) || []) : [];
      if (issues.length) { render(); return; }
      if (!(await flushSave())) { render(); return; }
      if (index >= steps.length - 1) {
        if (isLocked()) return;
        if (typeof config.onSubmit === 'function') await config.onSubmit(ctx);
        return;
      }
      applyStepChange(steps[index + 1].id);
    }

    async function backStep(){
      const steps = stepsList();
      const index = currentIndex();
      if (index <= 0) return;
      if (!(await flushSave())) { render(); return; }
      applyStepChange(steps[index - 1].id);
    }

    /* ---- close ------------------------------------------------------- */
    async function doClose(options = {}){
      if (closed) return;
      const reason = clean(options.reason) || 'programmatic';
      if (options.force !== true && typeof config.canClose === 'function' && config.canClose(reason) === false) return;
      closed = true;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (typeof config.autosave?.save === 'function' && !isLocked() && options.skipSave !== true && saveDirty) {
        const saved = await runSave();
        if (!saved && options.force !== true) {
          closed = false;
          // Escape/backdrop closes pop the Portal.modals entry before this
          // save gate runs; re-register so the next escape still reaches us.
          const stillRegistered = (window.Portal?.modals?.snapshot?.() || []).some((modal) => modal?.id === id);
          if (modalHandle && !stillRegistered) registerModal();
          return;
        }
      }
      unregisterRoute();
      try { modalHandle?.unregister?.(); } catch (error) {}
      removeFallbackListeners();
      overlay.remove();
      if (options.fromRoute !== true) clearRoute();
      if (typeof config.onClose === 'function') {
        try { config.onClose({ reason, fromRoute: options.fromRoute === true }); } catch (error) { console.warn(`FirstMate setup wizard onClose failed: ${id}`, error); }
      }
    }

    /* ---- ctx + controller -------------------------------------------- */
    const ctx = {
      state,
      root: overlay,
      get stepId(){ return currentStepId; },
      get locked(){ return isLocked(); },
      get issues(){ return issues.slice(); },
      touch: scheduleSave,
      flushAutosave: flushSave,
      refresh: () => render(),
      goTo: (stepId, options) => goTo(stepId, options),
      next: () => continueStep(),
      back: () => backStep(),
      close: (options) => doClose(options || {}),
      setStatus: (text) => { statusText = clean(text); renderFootNote(); },
      setIssues: (list) => { issues = Array.isArray(list) ? list.filter(Boolean) : []; render(); }
    };

    let currentStepId = clean(config.initialStepId);
    if (!stepsList().some((step) => step.id === currentStepId)) currentStepId = stepsList()[0]?.id || '';

    const controller = {
      id,
      el: overlay,
      ctx,
      goTo: (stepId, options) => goTo(stepId, options),
      refresh: () => render(),
      close: (options) => doClose(options || {}),
      setLocked: (value) => { lockedOverride = value === undefined ? true : value === true; render(); },
      getState: () => state
    };

    /* ---- rendering --------------------------------------------------- */
    const defaultStatusLabel = (stepState, active) => {
      if (active) return 'Current step';
      if (stepState === 'done') return 'Complete';
      if (stepState === 'needs-attention') return 'Needs attention';
      return 'Not started';
    };

    function railHtml(steps, activeIndex){
      return steps.map((step, index) => {
        const active = index === activeIndex;
        let info = null;
        try { info = typeof step.status === 'function' ? step.status(ctx) : null; } catch (error) { console.warn(`FirstMate setup wizard step status failed: ${id}`, error); }
        const normalized = info && typeof info === 'object' ? info : { state: clean(info) };
        const stepState = ['done', 'needs-attention'].includes(clean(normalized.state)) ? clean(normalized.state) : '';
        const cls = [active ? 'active' : '', stepState].filter(Boolean).join(' ');
        const label = clean(normalized.label) || defaultStatusLabel(stepState, active);
        const iconClass = clean(normalized.icon) || (stepState === 'done' ? 'fa-check' : '');
        const icon = iconClass ? `<i class="fas ${esc(iconClass)}"></i>` : String(index + 1);
        let navigable = true;
        try { navigable = typeof config.stepNavigable === 'function' ? config.stepNavigable(step.id, ctx) !== false : true; } catch (error) { navigable = true; }
        const disabled = active || !navigable;
        return `<button class="fm-wizard-step ${cls}" type="button" data-fm-step="${esc(step.id)}" ${disabled ? 'disabled' : ''}><span class="fm-wizard-step-title"><span class="num">${icon}</span><strong>${esc(step.label || step.id)}</strong></span><span class="fm-wizard-step-status">${esc(label)}</span></button>`;
      }).join('');
    }

    function defaultFooterHtml(steps, index, step){
      const isLast = index >= steps.length - 1;
      const rawNext = typeof step.nextLabel === 'function' ? step.nextLabel(ctx) : step.nextLabel;
      const nextLabel = clean(rawNext) || (isLast ? (clean(config.submitLabel) || 'Submit') : 'Continue');
      const back = index > 0 ? `<button class="fm-wizard-btn" type="button" data-fm-back>${(globalThis.PlatformLanguage?.text("setup-wizard","m_121372231b5699","Back") ?? "Back")}</button>` : '';
      const disabled = isLast && isLocked() ? 'disabled' : '';
      return `${back}<button class="fm-wizard-btn primary" type="button" data-fm-next ${disabled}>${esc(nextLabel)} <i class="fas fa-arrow-right"></i></button>`;
    }

    function render(){
      if (closed) return;
      const steps = stepsList();
      const index = currentIndex();
      if (!steps.length) return;
      if (steps[index].id !== currentStepId) currentStepId = steps[index].id;
      const step = steps[index];
      let subtitle = '';
      try { subtitle = clean(typeof config.subtitle === 'function' ? config.subtitle(ctx) : config.subtitle); } catch (error) { subtitle = ''; }
      let railNote = '';
      try { railNote = String((typeof config.railNote === 'function' ? config.railNote(ctx) : config.railNote) ?? ''); } catch (error) { railNote = ''; }
      overlay.innerHTML = `
        <div class="fm-wizard" role="dialog" aria-modal="true" aria-label="${String(esc(config.title || 'Setup'))}">
          <header class="fm-wizard-head">
            <div class="fm-wizard-title"><span class="fm-wizard-title-icon"><i class="fas ${String(esc(clean(config.icon) || 'fa-wand-magic-sparkles'))}"></i></span><div><strong>${String(esc(config.title || 'Setup'))}</strong>${String(subtitle ? `<span class="fm-wizard-subtitle">${esc(subtitle)}</span>` : '')}</div></div>
            <button class="fm-wizard-close" type="button" data-fm-close aria-label="${(globalThis.PlatformLanguage?.text("setup-wizard","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button>
          </header>
          <div class="fm-wizard-body">
            <aside class="fm-wizard-rail"><div class="fm-wizard-steps">${String(railHtml(steps, index))}</div>${String(railNote ? `<div class="fm-wizard-rail-foot">${railNote}</div>` : '')}</aside>
            <section class="fm-wizard-main"><div class="fm-wizard-pane"><div data-fm-alerts>${String(issues.length ? `<div class="fm-wizard-issues" role="alert"><i class="fas fa-circle-exclamation"></i><div><strong>Finish this step:</strong><ul>${issues.map((issue) => `<li>${esc(issue)}</li>`).join('')}</ul></div></div>` : '')}</div><div data-fm-step-body></div></div></section>
          </div>
          <footer class="fm-wizard-foot"><span class="fm-wizard-foot-note" data-fm-note>${String(esc(statusText))}</span><div class="fm-wizard-foot-actions" data-fm-actions></div></footer>
        </div>`;
      const body = overlay.querySelector('[data-fm-step-body]');
      try {
        if (typeof step.render === 'function') step.render(body, ctx);
      } catch (error) {
        console.warn(`FirstMate setup wizard step render failed: ${id}`, error);
        body.innerHTML = `<p style="color:#b42318;font-size:11px;font-weight:800">${esc(error?.message || 'This step could not be displayed.')}</p>`;
      }
      const actions = overlay.querySelector('[data-fm-actions]');
      if (typeof step.renderFooter === 'function') {
        try { step.renderFooter(actions, ctx); } catch (error) { console.warn(`FirstMate setup wizard footer render failed: ${id}`, error); }
      } else {
        actions.innerHTML = defaultFooterHtml(steps, index, step);
        actions.querySelector('[data-fm-back]')?.addEventListener('click', () => backStep());
        actions.querySelector('[data-fm-next]')?.addEventListener('click', () => continueStep());
      }
      overlay.querySelector('[data-fm-close]')?.addEventListener('click', () => doClose({ reason:'button' }));
      overlay.querySelectorAll('[data-fm-step]').forEach((button) => button.addEventListener('click', () => {
        const target = clean(button.dataset.fmStep);
        if (target && target !== currentStepId) goTo(target);
      }));
    }

    /* ---- modal + route registration ----------------------------------- */
    document.body.appendChild(overlay);
    render();

    let modalHandle = null;
    const registerModal = () => {
      modalHandle = window.Portal?.modals?.register?.(overlay, {
        id,
        closeOnEscape: config.closeOnEscape !== false,
        closeOnBackdrop: config.closeOnBackdrop !== false,
        closePredicate: (reason) => {
          if (typeof config.canClose === 'function' && config.canClose(reason) === false) return false;
          return true;
        },
        onClose: (reason) => { void doClose({ reason }); }
      }) || null;
    };
    registerModal();

    // Standalone fallback (no Portal.modals): still honor escape + backdrop.
    let fallbackKeydown = null;
    let fallbackBackdrop = null;
    if (!modalHandle) {
      if (config.closeOnEscape !== false) {
        fallbackKeydown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          event.preventDefault();
          void doClose({ reason:'escape' });
        };
        document.addEventListener('keydown', fallbackKeydown, true);
      }
      if (config.closeOnBackdrop !== false) {
        fallbackBackdrop = (event) => {
          if (event.target === overlay) void doClose({ reason:'backdrop' });
        };
        overlay.addEventListener('click', fallbackBackdrop);
      }
    }
    const removeFallbackListeners = () => {
      if (fallbackKeydown) document.removeEventListener('keydown', fallbackKeydown, true);
      if (fallbackBackdrop) overlay.removeEventListener('click', fallbackBackdrop);
      fallbackKeydown = null;
      fallbackBackdrop = null;
    };

    let unregisterRoute = () => {};
    if (workflowKey && window.Portal?.navigation?.registerHandler) {
      unregisterRoute = window.Portal.navigation.registerHandler(`${id}-workflow`, {
        priority: 500,
        apply: (route) => {
          if (closed) return;
          let scoped = true;
          if (typeof config.routeMatch === 'function') {
            try { scoped = config.routeMatch(route) !== false; } catch (error) { scoped = true; }
          }
          if (clean(route?.workflow) !== workflowKey || !scoped) {
            if (overlay.isConnected) void doClose({ fromRoute:true, reason:'route' });
            return;
          }
          const stepId = clean(route?.workflow_step);
          if (stepId && stepId !== currentStepId && stepsList().some((step) => step.id === stepId)) {
            applyStepChange(stepId, { route:false });
          }
        }
      }) || (() => {});
    }

    writeStepRoute(currentStepId);
    return controller;
  }

  window.FirstMateSetupWizard = { open };
})();
