/* libraries/flows/flow-player.js
 * The flow player (docs/architecture/flows.md): one component that draws a flow one step at a time, the same way
 * wherever it is embedded. The run lives on the server (/v1/flows): this sends a step's answers and draws the step
 * the server returns. `surface` only changes the wrapper: `modal` (its own window), `panel` (inside another app),
 * `call` (inside a call: script lines read large), `preview` (a definition played with nothing saved).
 *
 *   FirstMateFlows.open(flowId, { label, source })            // a flow in its own window (New menu, CRM, project)
 *   FirstMateFlows.mount(el, { flowId | runId, surface, source, onDone })
 *   FirstMateFlows.preview(el, definition)                    // play a definition without saving anything
 *   FirstMateFlows.newMenu()                                  // [{ id, label, icon }] the New menu offers
 */
(function(){
  const root = window;
  if (root.FirstMateFlows) return;
  const clean = (value) => String(value ?? '').trim();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
  const L = (key, fallback, values) => root.PlatformLanguage?.text?.('flows', key, fallback, values) ?? fallback;
  const orgId = () => clean(root.__APP?.userOrgId || root.__APP?.orgId);
  const toast = (message, kind = 'success') => root.Portal?.ui?.showToast?.(message, kind);
  const api = (path, options = {}) => {
    if (!root.PlatformAPI?.request) return Promise.reject(new Error(L('unavailable', 'Flows are not available here.')));
    return root.PlatformAPI.request(`/v1/flows/organizations/${encodeURIComponent(orgId())}${path}`, options);
  };

  const css = `
.fmf{display:flex;flex-direction:column;gap:14px;min-width:0;color:#101828;font-size:14px}
.fmf-head{display:flex;align-items:center;gap:10px;min-width:0}
.fmf-head i.fmf-icon{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;background:rgba(var(--primary-rgb,37,99,235),.1);color:var(--primary,#2563eb);flex:none}
.fmf-head h3{margin:0;font-size:16px;font-weight:900;letter-spacing:-.01em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmf-head .fmf-who{margin-left:auto;color:#667085;font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}
.fmf-blocks{display:flex;flex-direction:column;gap:12px}
.fmf-say{margin:0;padding:12px 14px;border-left:4px solid var(--primary,#2563eb);background:#f8fafc;border-radius:0 12px 12px 0;font-size:15px;line-height:1.55;font-weight:600;white-space:pre-wrap}
.fmf[data-kind="call"] .fmf-say{font-size:17px}
.fmf-say::before{content:"${'\\201C'}";color:var(--primary,#2563eb);font-weight:900;margin-right:2px}
.fmf[data-kind="workflow"] .fmf-say::before{content:none}
.fmf-note{margin:0;display:flex;gap:8px;align-items:flex-start;color:#475467;font-weight:650;line-height:1.5;white-space:pre-wrap}
.fmf-note i{color:#98a2b3;margin-top:3px}
.fmf-field{display:flex;flex-direction:column;gap:6px}
.fmf-field>label,.fmf-field>.fmf-label{font-weight:800;font-size:13px;color:#344054}
.fmf-field input,.fmf-field textarea,.fmf-field select{font:inherit;font-size:14px;border:1px solid #d0d5dd;border-radius:10px;padding:9px 11px;color:#101828;background:#fff;outline:none;min-width:0}
.fmf-field textarea{min-height:76px;resize:vertical}
.fmf-field input:focus,.fmf-field textarea:focus,.fmf-field select:focus{border-color:var(--primary,#2563eb);box-shadow:0 0 0 3px rgba(var(--primary-rgb,37,99,235),.14)}
.fmf-options{display:flex;flex-wrap:wrap;gap:8px}
.fmf-option{border:1.5px solid #e4e7ec;background:#fff;border-radius:999px;padding:8px 14px;font:inherit;font-size:13px;font-weight:750;color:#344054;cursor:pointer}
.fmf-option[aria-pressed="true"]{border-color:var(--primary,#2563eb);background:rgba(var(--primary-rgb,37,99,235),.08);color:var(--primary,#2563eb)}
.fmf-choice .fmf-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.fmf-choice .fmf-option{border-radius:12px;padding:12px 14px;text-align:left}
.fmf-action{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;padding:12px 14px;border:1px dashed #c7d7fe;border-radius:12px;background:#f5f8ff}
.fmf-action>i{grid-row:span 2;color:#3538cd;margin-top:2px}
.fmf-action strong{font-size:13px;font-weight:850}
.fmf-action .fmf-copy{grid-column:2;margin:0;padding:10px 12px;background:#fff;border:1px solid #e0eaff;border-radius:10px;white-space:pre-wrap;font-size:13px;line-height:1.5;color:#344054}
.fmf-action .fmf-explain{grid-column:2;color:#667085;font-size:12px;font-weight:650}
.fmf-record{display:flex;gap:8px;align-items:center;color:#667085;font-size:12px;font-weight:700}
.fmf-done{display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.fmf-outcome{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;font-weight:850;font-size:13px;color:#fff}
.fmf-foot{display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap;margin-top:4px}
.fmf-err{flex:1;color:#b42318;font-weight:750;font-size:12.5px}
.fmf-btn{display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 15px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;font:inherit;font-weight:850;cursor:pointer}
.fmf-btn.primary{background:var(--primary,#2563eb);border-color:var(--primary,#2563eb);color:#fff}
.fmf-btn[disabled]{opacity:.55;cursor:default}
.fmf-loading{display:grid;place-items:center;min-height:120px;color:#98a2b3}
.fmf-preview-tag{align-self:flex-start;font-size:11px;font-weight:850;text-transform:uppercase;letter-spacing:.06em;color:#b54708;background:#fffaeb;border:1px solid #fedf89;border-radius:999px;padding:3px 9px}
.fm-flow-modal{position:fixed;inset:0;z-index:2147483300;display:grid;place-items:center;background:rgba(16,24,40,.45);padding:16px}
.fm-flow-modal-shell{width:min(620px,100%);max-height:calc(100dvh - 32px);display:flex;flex-direction:column;background:#fff;border-radius:18px;box-shadow:0 24px 60px rgba(16,24,40,.3);overflow:hidden}
.fm-flow-modal-top{display:flex;justify-content:flex-end;padding:10px 10px 0}
.fm-flow-modal-close{width:34px;height:34px;border:0;border-radius:10px;background:transparent;color:#667085;cursor:pointer;font-size:16px}
.fm-flow-modal-close:hover{background:#f2f4f7}
.fm-flow-modal-body{padding:0 22px 22px;overflow:auto}
@media (max-width:560px){.fm-flow-modal{padding:0;align-items:end}.fm-flow-modal-shell{border-radius:18px 18px 0 0;max-height:92dvh}}
`;
  function ensureStyles(){
    if (document.getElementById('fm-flow-player-css')) return;
    const style = document.createElement('style');
    style.id = 'fm-flow-player-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  const ACTION_ICONS = { 'communications.sendSms.v1': 'fa-comment-sms', 'communications.sendEmail.v1': 'fa-envelope', 'work.createTodo.v1': 'fa-list-check', 'scopes.activateTemplate.v1': 'fa-table-columns', 'sales.markLost.v1': 'fa-circle-xmark' };

  /** One step's blocks as HTML. `answers` fills what was answered before (going Back). */
  function blocksHtml(step, answers, kind, preview){
    return (step.blocks || []).map((block) => {
      const value = answers[block.key];
      switch (block.kind) {
        case 'say': return `<p class="fmf-say" data-block="${esc(block.id)}">${esc(block.text)}</p>`;
        case 'note': return `<p class="fmf-note" data-block="${esc(block.id)}"><i class="fas fa-circle-info" aria-hidden="true"></i><span>${esc(block.text)}</span></p>`;
        case 'choice': return `<div class="fmf-field fmf-choice" data-block="${esc(block.id)}"><span class="fmf-label">${esc(block.label)}${block.required ? '' : ''}</span>
          <div class="fmf-options" role="radiogroup">${block.options.map((option) => `<button type="button" class="fmf-option" role="radio" data-key="${esc(block.key)}" data-value="${esc(option.id)}" aria-pressed="${value === option.id}" aria-checked="${value === option.id}">${esc(option.label)}</button>`).join('')}</div></div>`;
        case 'ask': return askHtml(block, value);
        case 'action': return `<div class="fmf-action" data-block="${esc(block.id)}"><i class="fas ${ACTION_ICONS[block.automation] || 'fa-bolt'}" aria-hidden="true"></i><strong>${esc(block.label || L('action', 'When you continue'))}</strong>${block.preview ? `<p class="fmf-copy">${esc(block.preview)}</p>` : ''}${block.explainer ? `<span class="fmf-explain">${esc(block.explainer)}</span>` : ''}</div>`;
        case 'contact': return preview ? `<p class="fmf-record"><i class="fas fa-address-book" aria-hidden="true"></i>${esc(L('record_contact', 'Finds or makes the contact when you continue.'))}</p>` : '';
        case 'project': return preview ? `<p class="fmf-record"><i class="fas fa-folder-plus" aria-hidden="true"></i>${esc(block.mode === 'create_project' ? L('record_project', 'Makes the project when you continue.') : L('record_lead', 'Makes the lead when you continue.'))}</p>` : '';
        default: return '';
      }
    }).join('');
  }
  function askHtml(block, value){
    const id = `fmf_${block.key}_${Math.random().toString(36).slice(2, 7)}`;
    const label = `<label for="${id}">${esc(block.label)}${block.required ? ' <span aria-hidden="true" style="color:#b42318">*</span>' : ''}</label>`;
    const attrs = `id="${id}" data-key="${esc(block.key)}" data-input="${esc(block.input)}" placeholder="${esc(block.placeholder || '')}"`;
    if (block.input === 'select' || block.input === 'multi' || block.input === 'yes_no') {
      const options = block.input === 'yes_no' ? [{ id: 'yes', label: L('yes', 'Yes') }, { id: 'no', label: L('no', 'No') }] : block.options;
      const picked = (option) => block.input === 'multi' ? Array.isArray(value) && value.includes(option.id) : block.input === 'yes_no' ? (value === true ? 'yes' : value === false ? 'no' : '') === option.id : value === option.id;
      return `<div class="fmf-field" data-block="${esc(block.id)}"><span class="fmf-label">${esc(block.label)}</span><div class="fmf-options">${options.map((option) => `<button type="button" class="fmf-option" data-key="${esc(block.key)}" data-value="${esc(option.id)}" data-multi="${block.input === 'multi'}" aria-pressed="${picked(option)}">${esc(option.label)}</button>`).join('')}</div></div>`;
    }
    if (block.input === 'paragraph' || block.input === 'address') return `<div class="fmf-field" data-block="${esc(block.id)}">${label}<textarea ${attrs} rows="${block.input === 'address' ? 2 : 3}">${esc(value ?? '')}</textarea></div>`;
    const type = { number: 'number', money: 'number', date: 'date', phone: 'tel', email: 'email' }[block.input] || 'text';
    return `<div class="fmf-field" data-block="${esc(block.id)}">${label}<input type="${type}" ${attrs} value="${esc(value ?? '')}" ${block.input === 'money' ? 'step="0.01"' : ''}></div>`;
  }

  /** Reads the answers on screen for this step. Option rows keep their state in aria-pressed. */
  function collect(el, step){
    const answers = {};
    for (const block of step.blocks || []) {
      if (block.kind !== 'ask' && block.kind !== 'choice') continue;
      if (block.kind === 'choice' || ['select', 'multi', 'yes_no'].includes(block.input)) {
        const on = [...el.querySelectorAll(`[data-key="${CSS.escape(block.key)}"][aria-pressed="true"]`)].map((button) => button.dataset.value);
        if (block.input === 'multi') answers[block.key] = on;
        else if (on[0]) answers[block.key] = block.input === 'yes_no' ? on[0] === 'yes' : on[0];
      } else {
        const input = el.querySelector(`[data-key="${CSS.escape(block.key)}"]`);
        if (input && clean(input.value)) answers[block.key] = input.value;
      }
    }
    return answers;
  }

  /** Where the end-of-run buttons go. `open_project` and `open_contact` open the run's records. */
  function runButton(kind, target, view, handlers){
    if (kind === 'open_project' && view.project?.id) {
      handlers.close?.();
      if (root.FirstMateProjectWindows?.open) root.FirstMateProjectWindows.open(view.project.id); else root.Portal?.modules?.projects?.open?.(view.project.id);
    } else if (kind === 'open_contact' && view.contact?.id) {
      handlers.close?.();
      root.Portal?.modules?.contacts?.open?.({ id: view.contact.id, name: view.contact.name });
    } else if (kind === 'go_to' && target) {
      handlers.close?.();
      if (/^https?:\/\//.test(target)) root.open(target, '_blank', 'noopener'); else root.Portal?.navigation?.go?.(target);
    } else if (kind === 'start_flow' && target) { handlers.close?.(); open(target, { source: { kind: 'manual', ...(view.project?.id ? { project_id: view.project.id } : {}), ...(view.contact?.id ? { contact_id: view.contact.id } : {}) } }); }
    else if (kind === 'restart') handlers.restart?.();
    else handlers.close?.();
  }

  /**
   * Draws a run in `el`. With `definition` it plays a preview: the server says where each answer goes, nothing is
   * saved, records and actions are only described.
   */
  function mount(el, options = {}){
    ensureStyles();
    let alive = true, view = null, busy = false, error = '', preview = null;
    const surface = options.surface || 'panel';
    const handlers = { close: options.onClose, restart: () => start() };
    el.innerHTML = '<div class="fmf-loading"><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i></div>';

    function draw(){
      if (!alive) return;
      const step = preview ? preview.step : view?.step;
      const kind = preview ? preview.kind : view?.flow?.kind;
      const flow = preview ? preview.flow : view?.flow || {};
      const answers = preview ? preview.answers : view?.run?.answers || {};
      if (!step) return;
      const finished = !preview && view?.run?.status !== 'open';
      const buttons = (step.blocks || []).find((block) => block.kind === 'buttons');
      const who = [view?.contact?.name, view?.project?.title].filter(Boolean).join(' · ');
      const head = options.hideHead ? '' : `<div class="fmf-head"><i class="fas ${esc(flow.icon || 'fa-diagram-project')} fmf-icon" aria-hidden="true"></i><h3>${esc(step.title || flow.name || '')}</h3>${who ? `<span class="fmf-who">${esc(who)}</span>` : ''}</div>`;
      if (finished && !buttons) {
        const outcome = view.outcome;
        el.innerHTML = `<div class="fmf" data-kind="${esc(kind)}" data-surface="${esc(surface)}" data-done>${head}<div class="fmf-done">${outcome ? `<span class="fmf-outcome" style="background:${esc(outcome.color || '#667085')}">${esc(outcome.label)}</span>` : ''}<p class="fmf-note"><i class="fas fa-circle-check" aria-hidden="true"></i><span>${esc(L('done', 'Done. Everything is saved.'))}</span></p></div>
          <div class="fmf-foot">${view.contact?.id ? `<button type="button" class="fmf-btn" data-button="open_contact">${esc(L('open_contact', 'Open contact'))}</button>` : ''}${view.project?.id ? `<button type="button" class="fmf-btn" data-button="open_project">${esc(L('open_project', 'Open project'))}</button>` : ''}<button type="button" class="fmf-btn primary" data-button="close">${esc(L('close', 'Close'))}</button></div></div>`;
        options.onDone?.(view);
        return;
      }
      const canBack = preview ? preview.path.length > 0 : view?.can_back;
      const ends = buttons || finished;
      el.innerHTML = `<div class="fmf" data-kind="${esc(kind)}" data-surface="${esc(surface)}" data-step="${esc(step.id)}">${preview ? `<span class="fmf-preview-tag">${esc(L('preview', 'Preview: nothing is saved'))}</span>` : ''}${head}
        <div class="fmf-blocks">${blocksHtml(step, answers, kind, !!preview)}</div>
        <div class="fmf-foot">${error ? `<span class="fmf-err" role="alert">${esc(error)}</span>` : ''}
          ${canBack && !finished ? `<button type="button" class="fmf-btn" data-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('back', 'Back'))}</button>` : ''}
          ${ends ? (buttons?.buttons || []).map((button, index) => `<button type="button" class="fmf-btn ${index === 0 ? 'primary' : ''}" data-button="${esc(button.kind)}" data-target="${esc(button.target || '')}">${esc(button.label || L(button.kind, button.kind))}</button>`).join('')
            : `<button type="button" class="fmf-btn primary" data-next ${busy ? 'disabled' : ''}>${esc(busy ? L('saving', 'Saving…') : L('continue', 'Continue'))}</button>`}
        </div></div>`;
      if (buttons && view?.run?.status === 'open' && !preview) {
        // A step that only offers buttons ends the run as soon as it shows.
        advance(true);
      }
      if (buttons?.auto && !preview && finished) runButton(buttons.auto, '', view, handlers);
      el.querySelector('input,textarea')?.focus?.({ preventScroll: true });
    }

    async function start(){
      error = ''; busy = false;
      try {
        if (options.definition) {
          const definition = options.definition;
          preview = { definition, flow: definition, kind: definition.kind, path: [], answers: {}, step: null };
          await previewTo(definition.start);
        } else if (options.runId) {
          view = await api(`/runs/${encodeURIComponent(options.runId)}`);
        } else {
          view = await api('/runs', { method: 'POST', body: { flow_id: options.flowId, source: options.source || { kind: surface === 'modal' ? 'new_menu' : 'manual' } } });
        }
        draw();
      } catch (failure) {
        if (alive) el.innerHTML = `<p class="fmf-err" role="alert" style="padding:12px 0">${esc(failure?.message || L('load_failed', 'This flow could not be loaded.'))}</p>`;
      }
    }
    async function previewTo(stepId, answers = preview.answers){
      const result = await api('/flows/preview', { method: 'POST', body: { definition: preview.definition, step_id: stepId, answers } });
      preview.step = result.step; preview.next = result.next;
    }

    async function advance(silent = false){
      if (busy) return;
      const step = preview ? preview.step : view.step;
      const answers = collect(el, step);
      busy = true; error = ''; if (!silent) draw();
      try {
        if (preview) {
          preview.answers = { ...preview.answers, ...answers };
          await previewTo(step.id, preview.answers);
          const next = preview.next || {};
          if (next.to) { preview.path.push(step.id); await previewTo(next.to); }
          else { preview.done = next.outcome || 'end'; }
        } else {
          view = await api(`/runs/${encodeURIComponent(view.run.id)}/steps/${encodeURIComponent(step.id)}`, { method: 'POST', body: { answers, revision: view.run.revision } });
          if (view.project?.id && !options.projectId) root.dispatchEvent(new CustomEvent('fm:flow-run:changed', { detail: { run_id: view.run.id, project_id: view.project.id, contact_id: view.contact?.id || '' } }));
        }
      } catch (failure) { error = clean(failure?.message) || L('failed', 'That didn’t save. Try again.'); }
      busy = false;
      if (!silent || error) draw();
      if (preview?.done) {
        const outcome = (preview.definition.outcomes || []).find((entry) => entry.id === preview.done);
        el.querySelector('.fmf-foot').innerHTML = `${outcome ? `<span class="fmf-outcome" style="background:${esc(outcome.color)}">${esc(outcome.label)}</span>` : `<span class="fmf-note">${esc(L('preview_end', 'The flow ends here.'))}</span>`}<button type="button" class="fmf-btn" data-restart>${esc(L('start_over', 'Start over'))}</button>`;
      }
    }
    async function back(){
      if (busy) return;
      busy = true; error = '';
      try {
        if (preview) { const to = preview.path.pop(); preview.done = null; await previewTo(to); }
        else view = await api(`/runs/${encodeURIComponent(view.run.id)}/back`, { method: 'POST', body: {} });
      } catch (failure) { error = clean(failure?.message); }
      busy = false; draw();
    }

    const onClick = (event) => {
      const option = event.target.closest('.fmf-option');
      if (option) {
        const multi = option.dataset.multi === 'true';
        if (multi) option.setAttribute('aria-pressed', String(option.getAttribute('aria-pressed') !== 'true'));
        else el.querySelectorAll(`.fmf-option[data-key="${CSS.escape(option.dataset.key)}"]`).forEach((button) => { const on = button === option; button.setAttribute('aria-pressed', String(on)); if (button.getAttribute('role') === 'radio') button.setAttribute('aria-checked', String(on)); });
        // A choice that decides where the flow goes moves on at once.
        if (option.getAttribute('role') === 'radio' && el.querySelectorAll('.fmf-choice').length === 1 && !el.querySelector('.fmf-field:not(.fmf-choice) input, .fmf-field:not(.fmf-choice) textarea, .fmf-field:not(.fmf-choice) .fmf-option')) advance();
        return;
      }
      if (event.target.closest('[data-next]')) return advance();
      if (event.target.closest('[data-back]')) return back();
      if (event.target.closest('[data-restart]')) { preview = null; return start(); }
      const button = event.target.closest('[data-button]');
      if (button && view) runButton(button.dataset.button, button.dataset.target, view, handlers);
      else if (button) handlers.close?.();
    };
    const onKey = (event) => { if (event.key === 'Enter' && event.target.matches('.fmf input')) { event.preventDefault(); advance(); } };
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    start();
    return {
      get view(){ return view; },
      destroy(){
        alive = false; el.removeEventListener('click', onClick); el.removeEventListener('keydown', onKey);
        // A run closed before it ended is left open to resume from its project; nothing is lost.
      }
    };
  }

  /** A flow in its own window. */
  function open(flowId, options = {}){
    ensureStyles();
    const modal = document.createElement('div');
    modal.className = 'fm-flow-modal';
    modal.dataset.flow = flowId;
    modal.innerHTML = `<div class="fm-flow-modal-shell" role="dialog" aria-modal="true" aria-label="${esc(options.label || L('flow', 'Flow'))}"><div class="fm-flow-modal-top"><button type="button" class="fm-flow-modal-close" aria-label="${esc(L('close', 'Close'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button></div><div class="fm-flow-modal-body" data-flow-mount></div></div>`;
    document.body.appendChild(modal);
    let player = null;
    const remove = () => { player?.destroy?.(); modal.remove(); };
    const handle = root.Portal?.modals?.register?.(modal, { id: `flow-${flowId}`, closeOnBackdrop: false, onClose: remove });
    const close = () => (handle?.close ? handle.close('close') : remove());
    modal.querySelector('.fm-flow-modal-close').addEventListener('click', close);
    if (!handle) modal.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
    player = mount(modal.querySelector('[data-flow-mount]'), { flowId, surface: 'modal', source: options.source, onClose: close, onDone: options.onDone });
    return { close, modal };
  }

  function preview(el, definition, options = {}){ return mount(el, { ...options, definition, surface: 'preview' }); }

  let menuCache = { org: '', at: 0, flows: [], pending: null };
  /** The flows the New menu offers this person (entry.new_menu), briefly cached. */
  function newMenu(options = {}){
    const org = orgId();
    if (!org || !root.PlatformAPI?.request) return Promise.resolve([]);
    if (!options.fresh && menuCache.org === org && Date.now() - menuCache.at < 60_000) return Promise.resolve(menuCache.flows);
    if (menuCache.pending && menuCache.org === org) return menuCache.pending;
    menuCache.org = org;
    menuCache.pending = api('/flows/new-menu').then((result) => { menuCache = { org, at: Date.now(), flows: Array.isArray(result?.flows) ? result.flows : [], pending: null }; return menuCache.flows; })
      .catch(() => { menuCache = { org, at: Date.now(), flows: [], pending: null }; return []; });
    return menuCache.pending;
  }
  const cachedMenu = () => menuCache.org === orgId() ? menuCache.flows : [];
  root.addEventListener('fm:flows:changed', () => { menuCache.at = 0; });

  root.FirstMateFlows = { mount, open, preview, newMenu, cachedMenu, api };
})();
