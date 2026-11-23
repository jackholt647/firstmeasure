// The Automations Hub setup's own pages (guided experience `automations.setup`, GP-110, GP-119,
// docs/architecture/automations-hub.md). It asks how the company runs, never how to configure anything: people who
// have never seen the system cannot say how its boards should be wired, but they know whether they call a lead first.
// The server turns the answers into the flow (scopes/flow-setup.ts): the MVP platform's one pipeline, from new lead to
// finished job, with a first call and an appointment at its front, new leads waiting until a call says what the job
// is, or the sold job handed to the production board. The hub plays it embedded in its right-hand panel: after each
// answer the chart draws what it would make (`automations-setup.plan`, nothing saved, the hub's `preview`). Pages:
//   known    when a lead comes in, do you know what the job is? (yes, almost always / usually / no, we find out on the phone)
//   call     do you call each new lead before anything else? (not asked when they find out on the phone)
//   visit    do you meet the customer before you give a price?
//   handoff  once a job is sold, who runs it? Continue saves the answers with automations.setup.apply, as the person.
//   done     what was set up, in words.
// It requires the setup step `company.type` (asked first, only while unanswered). The answers are the company
// profile's `lead_flow`: a replay starts from them. Without the hub around it (played elsewhere) nothing is previewed.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();

const css = `
.gxa{display:flex;flex-direction:column;gap:14px;min-width:0;padding:2px 0 8px;color:#101828;font-size:13px}
.gxa p{margin:0;color:#475467;line-height:1.5;font-weight:600}
.gxa h3{margin:0;font-size:15px;font-weight:950;letter-spacing:-.01em}
.gxa-choices{display:grid;gap:10px}
.gxa-choice{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:start;width:100%;padding:13px 14px;border:1.5px solid #eaecf0;border-radius:14px;background:#fff;font:inherit;text-align:left;cursor:pointer}
.gxa-choice[aria-pressed="true"]{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
.gxa-choice>i{grid-row:span 2;width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:#f2f4f7;color:#475467;font-size:15px}
.gxa-choice strong{font-size:13.5px;font-weight:950}
.gxa-choice span{color:#667085;font-size:12px;font-weight:650;line-height:1.45}
.gxa-tips{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.gxa-tips li{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;line-height:1.45;font-weight:700;color:#344054}
.gxa-tips i{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary,#d93025)}
.gxa-foot{display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:4px;flex-wrap:wrap}
.gxa-foot .gxa-err{flex:1;color:#b42318;font-weight:750;font-size:12px}
.gxa-btn{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 14px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;font:inherit;font-weight:850;cursor:pointer}
.gxa-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
.gxa-btn[disabled]{opacity:.5;cursor:default}
`;

function installStyle(){
  if (document.getElementById('gxa-automations-setup-css')) return;
  const style = document.createElement('style');
  style.id = 'gxa-automations-setup-css';
  style.textContent = css;
  document.head.appendChild(style);
}

/** The questions, in the order asked, with their answers (ids are the company profile's `lead_flow`). */
const QUESTIONS = [
  { id:'job_known', title:['known_title', 'When a new lead comes in, do you already know what the job is?'], choices:[
    ['yes', 'fa-house-chimney', 'known_yes', 'Yes, almost always', 'known_yes_hint', 'Nearly every lead is the same kind of job, like a new roof.'],
    ['mostly', 'fa-circle-half-stroke', 'known_mostly', 'Usually', 'known_mostly_hint', 'Most are, but some turn out to be something else, like a repair.'],
    ['no', 'fa-phone', 'known_no', 'No, we find out when we talk to them', 'known_no_hint', 'A lead could need any of the work you do.']] },
  { id:'first_call', title:['call_title', 'Do you call each new lead before anything else?'], skip:(answers) => answers.job_known === 'no', choices:[
    ['yes', 'fa-phone-volume', 'call_yes', 'Yes, we call them first', 'call_yes_hint', 'To hear what they need and set up the next step.'],
    ['no', 'fa-ruler-combined', 'call_no', 'No, we get started on it', 'call_no_hint', 'We order measurements and work up a price.']] },
  { id:'visit', title:['visit_title', 'Do you meet the customer before you give a price?'], choices:[
    ['yes', 'fa-house-user', 'visit_yes', 'Yes, we go out and see the job', 'visit_yes_hint', 'An appointment or inspection at the home, then the price.'],
    ['no', 'fa-file-invoice-dollar', 'visit_no', 'No, we price it without a visit', 'visit_no_hint', 'From measurements, photos or what they tell us.']] },
  { id:'handoff', title:['handoff_title', 'Once a job is sold, who runs it?'], choices:[
    ['same', 'fa-user', 'handoff_same', 'The same person, start to finish', 'handoff_same_hint', 'Whoever sold it orders the materials and sees the work through.'],
    ['separate', 'fa-users', 'handoff_separate', 'It’s handed to someone else', 'handoff_separate_hint', 'A production manager or the office schedules the crew and runs the job.']] }
];

/** The pages a person goes through for these answers: the questions that apply, then what was set up. */
export function pagesFor(answers){
  return [...QUESTIONS.filter((question) => !question.skip?.(object(answers))).map((question) => question.id), 'done'];
}

export function mount(el, ctx){
  installStyle();
  const L = ctx.L, esc = ctx.esc;
  const T = (key, fallback) => esc(L(`gx_aus_${key}`, fallback));
  const hub = () => window.FirstMateAutomationsHub?.active || null;
  const orgId = clean(window.__APP?.userOrgId || window.__APP?.orgId || hub()?.orgId?.());
  let alive = true, page = 0, answers = {}, plan = null, saved = null, saving = false, error = '', asked = 0;
  const pages = () => pagesFor(answers);
  // Where this setup is, for a live redraw and for an issue filed from it (guided-setup.js ctx.place).
  ctx.place?.keep?.(() => ({ page: pages()[page], answers, saved }));
  const question = () => QUESTIONS.find((entry) => entry.id === pages()[page]) || null;
  const answersOf = () => Object.fromEntries(QUESTIONS.filter((entry) => answers[entry.id] && !entry.skip?.(answers)).map((entry) => [entry.id, answers[entry.id]]));

  /** The chart draws what these answers would make (nothing is saved); the newest answer wins. */
  async function previewPlan(){
    const h = hub();
    if (!h) return;
    const ask = ++asked;
    try {
      const value = await ctx.read('automations-setup', 'plan', { args:answersOf() });
      if (!alive || ask !== asked) return;
      plan = object(value);
      h.preview({ routing:plan.routing, templates:array(plan.templates) });
      spot();
    } catch (failure) { if (alive && ask === asked) console.warn('The setup could not draw its answers on the chart.', failure); }
  }
  function spot(){
    const h = hub();
    if (!h) return;
    const name = pages()[page];
    const pipeline = `[data-board="${CSS.escape(clean(plan?.pipeline_id) || 'generic_roofing')}"]`;
    if (name === 'job_known') h.spotlight('[data-lead="default"], [data-sink]');
    else if (name === 'first_call' || name === 'visit') h.spotlight(`${pipeline} .fmah-stages`);
    else if (name === 'handoff') h.spotlight(`${pipeline}, [data-lane-label]`);
    else h.spotlight(null);
  }

  el.innerHTML = '<div class="gxs-module-loading"><span class="gxs-spin" aria-hidden="true"></span></div>';
  Promise.all([Promise.resolve(hub()?.ready?.()), ctx.read('company-profile', 'profile').catch(() => null)]).then(([, profile]) => {
    if (!alive) return;
    // A replay starts from what the company said before; a first run asks everything.
    const flow = object(object(profile).lead_flow);
    for (const entry of QUESTIONS) if (clean(flow[entry.id])) answers[entry.id] = clean(flow[entry.id]);
    // Redrawn after a live edit (guided-setup.js ctx.place): the answers so far and the page it was on.
    const was = object(ctx.place?.restored);
    if (was.page) { answers = { ...answers, ...object(was.answers) }; saved = was.saved ?? null; const at = pages().indexOf(was.page); if (at >= 0) page = at; }
    render();
    previewPlan();
  }).catch((failure) => { if (alive) el.innerHTML = `<p class="gxs-module-error" role="alert">${esc(clean(failure?.message) || L('gx_ui_step_load_failed', 'This step didn’t load. Close the setup and try again.'))}</p>`; });

  function summary(){
    const result = object(saved), flow = object(result.lead_flow);
    const boards = array(plan?.templates).map(object);
    const nameOf = (id) => esc(clean(boards.find((board) => board.id === id)?.name) || id);
    const pipeline = nameOf(clean(result.pipeline_id) || 'generic_roofing');
    const items = [
      flow.job_known === 'no'
        ? ['fa-inbox', `${T('done_wait', 'New leads wait in your new leads until someone calls them, then go onto')} <strong>${pipeline}</strong>`]
        : ['fa-inbox', `${T('done_entry', 'New leads go straight onto')} <strong>${pipeline}</strong>`],
      ...(flow.job_known !== 'no' && flow.first_call === 'yes' ? [['fa-phone-volume', T('done_call', 'Its first step is a call to the customer.')]] : []),
      ...(flow.visit === 'yes' ? [['fa-house-user', T('done_visit', 'Then an appointment to see the job, before the price.')]] : []),
      flow.handoff === 'separate' && result.production_id
        ? ['fa-users', `${T('done_handoff', 'Once it’s signed, the job moves onto')} <strong>${nameOf(result.production_id)}</strong>`]
        : ['fa-arrows-up-down', T('done_one', 'It runs from new lead to finished job, across Sales and Production.')]
    ];
    return `<ul class="gxa-tips">${items.map(([icon, html]) => `<li><i class="fas ${icon}" aria-hidden="true"></i><span>${html}</span></li>`).join('')}</ul>`;
  }

  function render(){
    if (!alive) return;
    const name = pages()[page];
    const foot = (next, options = {}) => `<div class="gxa-foot">${error ? `<span class="gxa-err" role="alert">${esc(error)}</span>` : ''}${(page > 0 || ctx.canBack?.()) && name !== 'done' ? `<button type="button" class="gxa-btn" data-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>` : ''}<button type="button" class="gxa-btn primary" data-next ${options.disabled ? 'disabled' : ''}>${esc(next)}</button></div>`;
    const entry = question();
    if (entry) {
      const last = pages()[page + 1] === 'done';
      el.innerHTML = `<div class="gxa" data-question="${esc(entry.id)}"><h3>${T(entry.title[0], entry.title[1])}</h3>
        <div class="gxa-choices" role="radiogroup">${entry.choices.map(([id, icon, key, text, hintKey, hint]) => `<button type="button" class="gxa-choice" role="radio" data-answer="${esc(id)}" aria-checked="${answers[entry.id] === id}" aria-pressed="${answers[entry.id] === id}"><i class="fas ${icon}" aria-hidden="true"></i><strong>${T(key, text)}</strong><span>${T(hintKey, hint)}</span></button>`).join('')}</div>
        ${foot(saving ? L('gx_aus_saving', 'Saving…') : last ? L('gx_aus_finish', 'Set up my flow') : L('gx_ui_continue', 'Continue'), { disabled:saving || !answers[entry.id] })}</div>`;
    } else {
      el.innerHTML = `<div class="gxa" data-question="done"><h3>${T('done_title', 'Your flow is set up')}</h3>${summary()}
        <p>${T('done_change', 'It’s on the chart. Run the setup again any time your business changes.')}</p>${foot(L('gx_aus_done', 'Done'))}</div>`;
    }
    spot();
    ctx.change({}, '');
    ctx.syncBack?.();
  }

  async function save(){
    if (saving) return;
    saving = true; error = ''; render();
    try {
      if (!orgId || !window.PlatformAPI?.publication?.invoke) throw new Error(L('gx_ui_save_unavailable', 'This can’t be saved here. Reload the page and try again.'));
      const result = await window.PlatformAPI.publication.invoke(orgId, 'automations.setup.apply', { scope:'organization', organizationId:orgId }, answersOf(),
        { idempotencyKey:`automations.setup:${orgId}:${crypto.randomUUID()}` });
      saved = object(result?.result ?? result?.value ?? result);
      if (saved.value && !saved.lead_flow) saved = object(saved.value);
      saving = false;
      hub()?.preview?.(null);
      await hub()?.reload?.();
      page += 1; render();
    } catch (failure) {
      saving = false; error = clean(failure?.message) || L('gx_wfs_error', 'That didn’t work. Try again.'); render();
    }
  }

  el.addEventListener('click', (event) => {
    const pick = event.target.closest('[data-answer]');
    if (pick) {
      const entry = question();
      if (!entry) return;
      answers[entry.id] = pick.dataset.answer; error = '';
      // Only the chosen state changes: the button clicked stays in the page (a re-render would move the click away).
      el.querySelectorAll('[data-answer]').forEach((button) => { const on = button === pick; button.setAttribute('aria-checked', String(on)); button.setAttribute('aria-pressed', String(on)); });
      const next = el.querySelector('[data-next]'); if (next) next.disabled = false;
      previewPlan();
      return;
    }
    if (event.target.closest('[data-back]')) { if (!back()) ctx.back?.(); return; }
    if (event.target.closest('[data-next]')) {
      const name = pages()[page];
      if (name === 'done') { hub()?.spotlight?.(null); return ctx.advance(); }
      if (pages()[page + 1] === 'done') return save();
      page += 1; error = ''; render();
    }
  });

  function back(){ if (page === 0 || pages()[page] === 'done') return false; page -= 1; error = ''; render(); return true; }

  return {
    handlesNavigation:true,
    valid:() => true,
    summary:() => '',
    back,
    backDepth:() => pages()[page] === 'done' ? 0 : page,
    escape:() => false,
    destroy(){ alive = false; hub()?.preview?.(null); hub()?.spotlight?.(null); }
  };
}
