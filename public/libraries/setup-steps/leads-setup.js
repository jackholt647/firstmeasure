// The leads setup's steps (docs/architecture/flows.md, "The leads setup"). One setup-step module, one part per step
// (`options.part`): sources, contact, no_answer, questions, script, new_menu. The player mounts it in the standard step
// frame and saves `answer()` with `leads.setup.save` on Continue. It reads through the publication layer only
// (`lead-setup.status`) and writes nothing itself. It asks how the company handles a new lead, never how to configure
// anything; the script step shows the flow those answers make, plays it, and lets the person change its words.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();
const fold = (value) => clean(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

const css = `
.gxl{display:flex;flex-direction:column;gap:12px;min-width:0;padding-bottom:6px;color:#101828;font-size:13.5px}
.gxl-lead{margin:0;color:#475467;line-height:1.5}
.gxl-choices{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.gxl-choice{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;align-items:start;width:100%;padding:13px 14px;border:1.5px solid #eaecf0;border-radius:14px;background:#fff;font:inherit;text-align:left;cursor:pointer}
.gxl-choice[aria-pressed="true"]{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
.gxl-choice>i{grid-row:span 2;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:#f2f4f7;color:#475467}
.gxl-choice strong{font-weight:900}
.gxl-choice span{color:#667085;font-size:12px;font-weight:650;line-height:1.4}
.gxl-choice small{grid-column:2;color:#067647;font-weight:800;font-size:11.5px}
.gxl-list{display:flex;flex-direction:column;gap:8px}
.gxl-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid #e4e7ec;border-radius:12px;background:#fff}
.gxl-row[data-on="false"]{opacity:.6}
.gxl-row input[type=checkbox]{width:18px;height:18px;accent-color:var(--primary,#d93025)}
.gxl-row label{flex:1;min-width:0;font-weight:750}
.gxl-row .gxl-meta{color:#667085;font-size:12px;font-weight:650}
.gxl-icon{width:28px;height:28px;border:0;border-radius:8px;background:#f2f4f7;color:#475467;cursor:pointer}
.gxl-icon[disabled]{opacity:.35;cursor:default}
.gxl-add{display:flex;gap:8px}
.gxl-add input{flex:1;min-width:0;height:40px;border:1px solid #d0d5dd;border-radius:11px;padding:0 12px;font:inherit}
.gxl-add button,.gxl-btn{height:40px;padding:0 14px;border:1px solid #d0d5dd;border-radius:11px;background:#fff;font:inherit;font-weight:750;color:#344054;cursor:pointer}
.gxl-tip{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:#f9fafb;color:#475467;font-weight:650;line-height:1.45}
.gxl-tip code{font-weight:800}
.gxl-map{display:flex;flex-direction:column;gap:10px}
.gxl-step{border:1px solid #e4e7ec;border-radius:14px;padding:12px 14px;background:#fff;display:flex;flex-direction:column;gap:8px}
.gxl-step h4{margin:0;font-size:13.5px;font-weight:900;display:flex;gap:8px;align-items:center}
.gxl-step h4 span{color:#98a2b3;font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.gxl-line{display:flex;gap:8px;align-items:flex-start}
.gxl-line>i{color:#98a2b3;margin-top:9px;width:14px;text-align:center}
.gxl-line textarea{flex:1;min-width:0;border:1px solid #e4e7ec;border-radius:10px;padding:8px 10px;font:inherit;font-size:13px;line-height:1.45;resize:vertical;min-height:40px}
.gxl-line .gxl-q{flex:1;padding:6px 0;font-weight:700}
.gxl-goes{display:flex;flex-wrap:wrap;gap:6px}
.gxl-goes span{font-size:12px;font-weight:750;padding:3px 9px;border-radius:999px;background:#f2f4f7;color:#344054}
.gxl-goes span.out{color:#fff}
.gxl-try{border:1px dashed #d0d5dd;border-radius:14px;padding:14px}
.gxl-menu{display:grid;grid-template-columns:minmax(0,1fr) 210px;gap:16px;align-items:start}
.gxl-mock{border-radius:14px;background:#f8fafc;border:1px solid #e4e7ec;padding:12px;display:flex;flex-direction:column;gap:8px}
.gxl-mock-btn{display:flex;align-items:center;gap:8px;justify-content:center;height:38px;border-radius:10px;background:var(--primary,#d93025);color:#fff;font-weight:850}
.gxl-mock-pop{background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 8px 24px rgba(16,24,40,.1);padding:6px;display:flex;flex-direction:column}
.gxl-mock-pop div{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;font-weight:700;color:#344054}
.gxl-mock-pop div:first-child{background:#f2f4f7}
.gxl-mock-pop i{width:16px;color:#667085;text-align:center}
@media(max-width:620px){.gxl-menu{grid-template-columns:minmax(0,1fr)}}
`;
function installStyle(){
  if (document.getElementById('gx-leads-setup-style')) return;
  const style = document.createElement('style'); style.id = 'gx-leads-setup-style'; style.textContent = css; document.head.append(style);
}

const MENU = {
  lead: ['fa-user-plus', 'menu_lead', 'Lead', 'menu_lead_hint', 'Enter a call-in or walk-in lead in a few questions'],
  project: ['fa-folder-plus', 'menu_project', 'Project', 'menu_project_hint', 'Straight onto your board'],
  contact: ['fa-address-book', 'menu_contact', 'Contact', 'menu_contact_hint', 'A person or company, no job yet'],
  report: ['fa-file-lines', 'menu_report', 'Report', 'menu_report_hint', 'Order measurements'],
  document: ['fa-file-medical', 'menu_document', 'Document', 'menu_document_hint', 'A proposal, invoice or contract'],
  payment: ['fa-money-check-dollar', 'menu_payment', 'Payment', 'menu_payment_hint', 'Take a payment'],
  appointment: ['fa-calendar-plus', 'menu_appointment', 'Appointment', 'menu_appointment_hint', 'Book a visit']
};
// What a person reads and types in place of templates: [first name] stands for {{contact.first_name}}.
const TOKENS = [['{{contact.first_name}}', 'first name'], ['{{contact.name}}', 'name'], ['{{contact.phone}}', 'phone'], ['{{contact.email}}', 'email'], ['{{user.first_name}}', 'your name'], ['{{organization.name}}', 'company name']];
export const friendly = (value) => TOKENS.reduce((out, [template, word]) => out.split(template).join(`[${word}]`), String(value ?? ''));
export const templated = (value) => TOKENS.reduce((out, [template, word]) => out.split(`[${word}]`).join(template), String(value ?? ''));
const BLOCK_ICONS = { say: 'fa-quote-left', note: 'fa-circle-info', ask: 'fa-circle-question', choice: 'fa-code-branch', action: 'fa-bolt', contact: 'fa-address-book', project: 'fa-folder-plus', outcome: 'fa-flag-checkered', buttons: 'fa-arrow-pointer' };

export function mount(el, ctx){
  installStyle();
  const L = ctx.L, esc = ctx.esc;
  const T = (key, fallback) => esc(L(`gx_leads_${key}`, fallback));
  const part = clean(object(ctx.options).part) || 'contact';
  ctx.place?.keep?.(() => ({ page: part }));
  // The working state is this step's own copy: the frame writes each change() into ctx.answer, which holds answer()'s
  // shape (ids, not rows), so it is only read back here to start from what was answered before (going Back).
  const given = object(ctx.answer);
  let alive = true, status = null, player = null;
  const state = {};
  el.innerHTML = '<div class="gxl"><span class="gxs-spin" aria-hidden="true"></span></div>';

  const report = (summary = '') => ctx.change(answer(), summary);
  function answer(){
    if (part === 'sources') return { part, sources: array(state.sources) };
    if (part === 'contact') return { part, method: clean(state.method) };
    if (part === 'no_answer') return { part, actions: array(state.actions) };
    if (part === 'questions') return { part, questions: array(state.questions).filter((entry) => entry.on !== false).map(({ on: _on, ...entry }) => entry) };
    if (part === 'script') return { part, definition: state.definition };
    return { part, items: array(state.items).filter((entry) => entry.on).map((entry) => entry.id) };
  }

  function choices(name, options, picked, multi){
    return `<div class="gxl-choices" role="${multi ? 'group' : 'radiogroup'}">${options.map(([id, icon, key, label, hintKey, hint, badge]) => {
      const on = multi ? array(picked).includes(id) : picked === id;
      return `<button type="button" class="gxl-choice" data-${name}="${esc(id)}" ${multi ? '' : 'role="radio"'} aria-pressed="${on}" ${multi ? '' : `aria-checked="${on}"`}><i class="fas ${icon}" aria-hidden="true"></i><strong>${T(key, label)}</strong><span>${T(hintKey, hint)}</span>${badge ? `<small>${esc(badge)}</small>` : ''}</button>`;
    }).join('')}</div>`;
  }

  function draw(){
    if (!alive || !status) return;
    const answers = object(status.answers);
    if (part === 'sources') {
      const inbox = object(object(status.sources).lead_inbox);
      el.innerHTML = `<div class="gxl"><p class="gxl-lead">${T('sources_lead', 'Pick everything you use. We’ll turn each one on so its leads land in your new leads.')}</p>
        ${choices('source', [
          ['website', 'fa-globe', 'src_website', 'Website forms', 'src_website_hint', 'A form on your site that sends you the lead.'],
          ['email', 'fa-envelope-open-text', 'src_email', 'Lead emails', 'src_email_hint', 'Lead services or your site email you leads; forward them to your lead inbox.', inbox.address || ''],
          ['services', 'fa-plug', 'src_services', 'Lead services', 'src_services_hint', 'Angi, Google, Facebook and others. Connect them in Settings › Connections.'],
          ['phone', 'fa-phone', 'src_phone', 'Phone calls', 'src_phone_hint', 'People who call you. Set up calling in Communications.']
        ], state.sources, true)}
        <div class="gxl-tip"><i class="fas fa-circle-info" aria-hidden="true"></i><span>${T('sources_later', 'You can connect more lead sources any time in Settings › Lead import and Settings › Connections.')}</span></div></div>`;
    } else if (part === 'contact') {
      el.innerHTML = `<div class="gxl">${choices('method', [
        ['call', 'fa-phone-volume', 'contact_call', 'We call them', 'contact_call_hint', 'Most companies call a new lead first.'],
        ['text', 'fa-comment-sms', 'contact_text', 'We text them', 'contact_text_hint', 'A text first, then a call when they reply.'],
        ['email', 'fa-envelope', 'contact_email', 'We email them', 'contact_email_hint', 'An email first.'],
        ['none', 'fa-folder-open', 'contact_none', 'We treat it like any project', 'contact_none_hint', 'Just tell us it came in and put it on the board.']
      ], state.method)}</div>`;
    } else if (part === 'no_answer') {
      el.innerHTML = `<div class="gxl"><p class="gxl-lead">${T('no_answer_lead', 'Pick any of them. We’ll put them in your call script, with the words we send.')}</p>${choices('action', [
        ['text', 'fa-comment-sms', 'na_text', 'Send them a text', 'na_text_hint', '“We tried calling. When’s a good time to talk?”'],
        ['email', 'fa-envelope', 'na_email', 'Send them an email', 'na_email_hint', 'A short note that you tried to reach them.'],
        ['retry', 'fa-clock-rotate-left', 'na_retry', 'Try them again later', 'na_retry_hint', 'A to-do to call again in a few hours.']
      ], state.actions, true)}</div>`;
    } else if (part === 'questions') {
      el.innerHTML = `<div class="gxl"><p class="gxl-lead">${T('questions_lead', 'Pick what you ask on that first call. Add your own; you can reword any of them later.')}</p>
        <div class="gxl-list" data-list>${array(state.questions).map((entry, index) => `<div class="gxl-row" data-on="${entry.on !== false}"><input type="checkbox" id="gxlq_${index}" data-question="${index}" ${entry.on !== false ? 'checked' : ''}><label for="gxlq_${index}">${esc(entry.label)}</label>
          <button type="button" class="gxl-icon" data-move="${index}:-1" aria-label="${T('move_up', 'Move up')}" ${index === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button><button type="button" class="gxl-icon" data-move="${index}:1" aria-label="${T('move_down', 'Move down')}" ${index === state.questions.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button></div>`).join('')}</div>
        <div class="gxl-add"><input type="text" data-new placeholder="${T('question_placeholder', 'Your own question, e.g. How old is the roof?')}" maxlength="200"><button type="button" data-add>${T('add', 'Add')}</button></div></div>`;
    } else if (part === 'script') {
      // The editors may not be on this page (a setup can play outside the portal page): load them first.
      if (!window.FirstMateFlowScriptEditor && !state.loadingEditors) {
        state.loadingEditors = true;
        el.innerHTML = '<div class="gxl"><span class="gxs-spin" aria-hidden="true"></span></div>';
        flowLibraries().catch((error) => console.warn('The flow editors did not load; showing the simple list.', error)).finally(() => { if (alive) drawScript(); });
        return;
      }
      drawScript();
    }
    else drawMenu();
  }

  /** The new-lead flow as a map of its steps: what you say (editable), what you ask, what's sent (editable), where it goes. */
  /** The flow player and both editors, from the same /libraries/ this module came from, each once per page. */
  function flowLibraries(){
    const base = new URL('../flows/', import.meta.url).href.replace(/[?#].*$/, '');
    const version = new URL(import.meta.url).search;
    const load = (file, global) => window[global] ? Promise.resolve() : (window.__fmFlowLoads ||= {})[file] ||= new Promise((resolve, reject) => {
      const tag = document.createElement('script'); tag.src = `${base}${file}${version}`; tag.onload = resolve; tag.onerror = () => reject(new Error(`${file} did not load`)); document.head.appendChild(tag);
    });
    return load('flow-player.js', 'FirstMateFlows').then(() => Promise.all([load('flow-editor.js', 'FirstMateFlowEditor'), load('flow-script-editor.js', 'FirstMateFlowScriptEditor')]));
  }
  function drawScript(){
    const flow = object(state.definition);
    if (!flow.steps) { el.innerHTML = `<div class="gxl"><p class="gxl-lead">${T('script_none', 'You treat new leads like any project, so there’s no script to set up.')}</p></div>`; return; }
    // The script editor (a prototype beside the map editor): the flow as the script itself, in the wide sheet. What the
    // step is about is its title's tooltip, so nothing above the editor takes height.
    const onChange = (definition) => { state.definition = definition; report(); };
    if (window.FirstMateFlowScriptEditor?.mount && !state.map) {
      ctx.setWide?.(true);
      el.innerHTML = '<div class="gxl-editor" data-editor style="height:min(720px,calc(var(--gx-vh,100vh) - 230px));min-height:480px;border:1px solid #eaecf0;border-radius:14px;overflow:hidden"></div>';
      player = window.FirstMateFlowScriptEditor.mount(el.querySelector('[data-editor]'), { definition: flow, embedded: true, onChange,
        onSwitchToMap: window.FirstMateFlowEditor?.mount ? (definition) => { state.definition = definition; state.map = true; player?.destroy?.(); drawScript(); } : undefined });
      return;
    }
    if (window.FirstMateFlowEditor?.mount) {
      ctx.setWide?.(true);
      el.innerHTML = `<div class="gxl">${window.FirstMateFlowScriptEditor ? `<button type="button" class="gxl-btn" data-script-view style="align-self:flex-start"><i class="fas fa-align-left"></i> ${T('script_view', 'Script view')}</button>` : ''}<div data-editor></div></div>`;
      player = window.FirstMateFlowEditor.mount(el.querySelector('[data-editor]'), { definition: flow, embedded: true, onChange });
      el.querySelector('[data-script-view]')?.addEventListener('click', () => { player?.destroy?.(); state.map = false; drawScript(); });
      return;
    }
    const outcomes = new Map(array(flow.outcomes).map((entry) => [entry.id, entry]));
    const steps = new Map(array(flow.steps).map((entry) => [entry.id, entry]));
    const order = new Map(array(flow.steps).map((entry, index) => [entry.id, index + 1]));
    const goes = (step) => {
      const out = [];
      for (const block of array(step.blocks)) {
        if (block.kind === 'choice') for (const option of array(block.options)) {
          const target = option.outcome ? outcomes.get(option.outcome) : steps.get(option.to);
          if (!target) continue;
          // A choice that goes to a step names its number; an ending names the ending when it says more than the choice.
          const where = option.outcome ? (clean(target.label).toLowerCase() === clean(option.label).toLowerCase() ? '' : ` → ${esc(target.label)}`) : ` → ${L('gx_leads_step_n', 'step')} ${order.get(option.to)}`;
          out.push(`<span class="${option.outcome ? 'out' : ''}" ${option.outcome ? `style="background:${esc(target.color || '#667085')}"` : ''}>${esc(option.label)}${where}</span>`);
        }
        if (block.kind === 'outcome' && outcomes.get(block.outcome)) out.push(`<span class="out" style="background:${esc(outcomes.get(block.outcome).color)}">${esc(outcomes.get(block.outcome).label)}</span>`);
      }
      if (typeof step.next === 'string' && steps.get(step.next)) out.push(`<span>→ ${L('gx_leads_step_n', 'step')} ${order.get(step.next)}: ${esc(steps.get(step.next).title)}</span>`);
      return out.length ? `<div class="gxl-goes">${out.join('')}</div>` : '';
    };
    const line = (step, block) => {
      const icon = `<i class="fas ${BLOCK_ICONS[block.kind] || 'fa-circle'}" aria-hidden="true"></i>`;
      if (block.kind === 'say' || block.kind === 'note') return `<div class="gxl-line">${icon}<textarea data-edit="${esc(step.id)}|${esc(block.id)}|text" rows="2">${esc(friendly(block.text))}</textarea></div>`;
      if (block.kind === 'action' && object(block.input).text !== undefined) return `<div class="gxl-line">${icon}<textarea data-edit="${esc(step.id)}|${esc(block.id)}|copy" rows="3" aria-label="${esc(block.label)}">${esc(friendly(object(block.input).text))}</textarea></div>`;
      if (block.kind === 'action') return `<div class="gxl-line">${icon}<span class="gxl-q">${esc(block.preview || block.label)}</span></div>`;
      if (block.kind === 'ask' || block.kind === 'choice') return `<div class="gxl-line">${icon}<span class="gxl-q">${esc(block.label)}</span></div>`;
      return '';
    };
    el.innerHTML = `<div class="gxl"><p class="gxl-lead">${T('script_lead', 'This is your new lead call script, made from your answers. Change the words; try it below.')}</p>
      <div class="gxl-map">${array(flow.steps).map((step, index) => `<div class="gxl-step"><h4><span>${index + 1}</span>${esc(step.title)}</h4>${array(step.blocks).map((block) => line(step, block)).join('')}${goes(step)}</div>`).join('')}</div>
      <div class="gxl-try"><div data-try></div></div>${tip()}</div>`;
    try_();
  }
  const tip = () => `<div class="gxl-tip"><i class="fas fa-pen-to-square" aria-hidden="true"></i><span>${T('script_words', 'Words in [brackets] are filled in for each lead: [first name], [your name], [company name].')} ${T('script_later', 'To edit your scripts later, go to CRM settings › Flows or call center settings.')}</span></div>`;
  function try_(){
    const target = el.querySelector('[data-try]');
    if (!target || !window.FirstMateFlows?.preview) return;
    player?.destroy?.();
    player = window.FirstMateFlows.preview(target, state.definition, { hideHead: false });
  }

  /** The New menu as it will look, beside the list to change it. */
  function drawMenu(){
    const items = array(state.items);
    const shown = items.filter((entry) => entry.on);
    el.innerHTML = `<div class="gxl"><p class="gxl-lead">${T('menu_lead', 'This is the New button on the left. Choose what it offers and in what order. New › Lead plays your lead questions; New › Project goes straight onto your board.')}</p>
      <div class="gxl-menu"><div class="gxl-list">${items.map((entry, index) => { const [icon, key, label, hintKey, hint] = MENU[entry.id]; return `<div class="gxl-row" data-on="${entry.on}"><input type="checkbox" id="gxlm_${entry.id}" data-item="${esc(entry.id)}" ${entry.on ? 'checked' : ''}><i class="fas ${icon}" aria-hidden="true" style="color:#667085"></i><label for="gxlm_${entry.id}">${T(key, label)} <span class="gxl-meta">${T(hintKey, hint)}</span></label>
        <button type="button" class="gxl-icon" data-move="${index}:-1" aria-label="${T('move_up', 'Move up')}" ${index === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button><button type="button" class="gxl-icon" data-move="${index}:1" aria-label="${T('move_down', 'Move down')}" ${index === items.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button></div>`; }).join('')}</div>
      <div class="gxl-mock" aria-hidden="true"><div class="gxl-mock-btn"><i class="fas fa-plus-circle"></i>${T('menu_new', 'New')}</div><div class="gxl-mock-pop">${shown.map((entry) => `<div><i class="fas ${MENU[entry.id][0]}"></i>${T(MENU[entry.id][1], MENU[entry.id][2])}</div>`).join('') || `<div>${T('menu_empty', 'Nothing yet')}</div>`}</div></div></div></div>`;
  }

  function start(){
    const answers = object(status.answers);
    if (part === 'sources') state.sources = Array.isArray(given.sources) ? given.sources : array(answers.sources).length ? answers.sources : ['website', 'email'];
    if (part === 'contact') state.method = clean(given.method) || clean(answers.contact) || 'call';
    if (part === 'no_answer') state.actions = Array.isArray(given.actions) ? given.actions : Array.isArray(answers.no_answer) ? answers.no_answer : ['text', 'retry'];
    if (part === 'questions') {
      const chosen = Array.isArray(given.questions) ? given.questions : Array.isArray(answers.questions) ? answers.questions : null;
      const suggested = array(status.suggested_questions);
      state.questions = (chosen ? [...chosen.map((entry) => ({ ...entry, on: true })), ...suggested.filter((entry) => !chosen.some((have) => have.key === entry.key)).map((entry) => ({ ...entry, on: false }))]
        : suggested.map((entry) => ({ ...entry, on: true })));
    }
    if (part === 'script') state.definition = given.definition || status.flow;
    if (part === 'new_menu') {
      const saved = Array.isArray(given.items) ? given.items : Array.isArray(answers.new_menu) ? answers.new_menu : null;
      const order = saved || ['lead', 'project', 'contact', 'report'];
      state.items = [...order.filter((id) => MENU[id]).map((id) => ({ id, on: true })), ...Object.keys(MENU).filter((id) => !order.includes(id)).map((id) => ({ id, on: false }))];
    }
    draw(); report();
  }

  const onClick = (event) => {
    const pick = event.target.closest('[data-source],[data-method],[data-action]');
    if (pick) {
      if (pick.dataset.method) { state.method = pick.dataset.method; el.querySelectorAll('[data-method]').forEach((button) => { const on = button === pick; button.setAttribute('aria-pressed', String(on)); button.setAttribute('aria-checked', String(on)); }); }
      else {
        const key = pick.dataset.source ? 'sources' : 'actions', id = pick.dataset.source || pick.dataset.action;
        const list = new Set(array(state[key])); if (list.has(id)) list.delete(id); else list.add(id);
        state[key] = [...list]; pick.setAttribute('aria-pressed', String(list.has(id)));
      }
      return report();
    }
    const move = event.target.closest('[data-move]');
    if (move) {
      const [index, by] = move.dataset.move.split(':').map(Number), key = part === 'questions' ? 'questions' : 'items';
      const list = [...state[key]], to = index + by;
      if (to < 0 || to >= list.length) return;
      [list[index], list[to]] = [list[to], list[index]]; state[key] = list; draw(); return report();
    }
    if (event.target.closest('[data-add]')) add();
  };
  const onChange = (event) => {
    if (event.target.matches('[data-question]')) { state.questions[Number(event.target.dataset.question)].on = event.target.checked; event.target.closest('.gxl-row').dataset.on = String(event.target.checked); return report(); }
    if (event.target.matches('[data-item]')) { state.items.find((entry) => entry.id === event.target.dataset.item).on = event.target.checked; drawMenu(); return report(); }
    if (event.target.matches('[data-edit]')) {
      const [stepId, blockId, field] = event.target.dataset.edit.split('|');
      const flow = JSON.parse(JSON.stringify(state.definition));
      const block = array(array(flow.steps).find((step) => step.id === stepId)?.blocks).find((entry) => entry.id === blockId);
      if (!block) return;
      const value = templated(event.target.value);
      if (field === 'copy') { block.input = { ...object(block.input), text: value }; block.preview = value; } else block.text = value;
      state.definition = flow; report(); try_();
    }
  };
  const onKey = (event) => { if (event.target.matches('[data-new]') && event.key === 'Enter') { event.preventDefault(); add(); } };
  function add(){
    const input = el.querySelector('[data-new]'), label = clean(input?.value).replace(/[<>]/g, '').slice(0, 200), key = fold(label);
    if (!label || !key) return;
    if (!state.questions.some((entry) => entry.key === key)) state.questions.push({ key, label, input: 'text', options: [], on: true });
    draw(); report(); el.querySelector('[data-new]')?.focus();
  }

  ctx.read('lead-setup', 'status').then((value) => {
    if (!alive) return;
    status = object(value);
    start();
    el.addEventListener('click', onClick); el.addEventListener('change', onChange); el.addEventListener('keydown', onKey);
  }).catch((error) => { if (alive) el.innerHTML = `<p class="gxs-module-error" role="alert">${esc(error?.message || L('gx_ui_step_load_failed', 'This step didn’t load. Close the setup and try again.'))}</p>`; });

  return {
    summary: () => '',
    valid: () => {
      if (part === 'contact') return !!clean(state.method);
      if (part === 'new_menu') return array(state.items).some((entry) => entry.on);
      return true;
    },
    hint: () => part === 'new_menu' ? L('gx_leads_menu_hint', 'Keep at least one thing in the New menu.') : L('gx_leads_pick_hint', 'Pick one to continue.'),
    answer,
    escape: () => false,
    destroy(){
      alive = false; player?.destroy?.(); el.removeEventListener('click', onClick); el.removeEventListener('change', onChange); el.removeEventListener('keydown', onKey);
      // What this step saved changes the page around it: the New menu reads its items and flows again.
      if (part === 'script') ctx.setWide?.(false);
      if (part === 'new_menu' || part === 'script') { window.dispatchEvent(new CustomEvent('fm:flows:changed')); window.Portal?.appFlags?.load?.({ refresh: true }); }
    }
  };
}
export default mount;
