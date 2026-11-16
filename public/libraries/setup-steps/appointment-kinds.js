// "What kinds of appointments will you schedule?" (setup step `appointments.kinds`, FM-515, docs/architecture/setup-steps.md).
// A setup-step module: the player mounts it in the standard step frame and saves `answer()` with the step's action
// (appointments.kinds.save), which makes each kind an appointment type. The kinds come from the appointment-setup
// catalog (the ones suggested for this company are picked to start with); each has pills that say whether it is a
// sales or a production appointment (or other), and the person can add their own. It reads through the publication
// layer only and writes nothing itself.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();
const fold = (value) => clean(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
const CATEGORIES = ['sales', 'production', 'other'];

const css = `
.gxk{display:flex;flex-direction:column;gap:12px;min-width:0;padding-bottom:6px}
.gxk-lead{margin:0;font-size:13px;color:#475467}
.gxk-list{display:flex;flex-direction:column;gap:8px}
.gxk-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;transition:border-color .15s,background .15s,box-shadow .15s}
.gxk-row[data-on=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.04);box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxk-pick{display:flex;align-items:center;gap:10px;flex:1 1 auto;min-width:0;border:0;background:transparent;padding:4px 0;font:inherit;text-align:left;color:#101828;cursor:pointer}
.gxk-pick strong{font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxk-pick:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px;border-radius:6px}
.gxk-box{flex:none;width:22px;height:22px;border-radius:7px;border:1.5px solid #d0d5dd;display:grid;place-items:center;transition:background .15s,border-color .15s}
.gxk-box svg{width:12px;height:12px;stroke:#fff;fill:none;stroke-width:3;opacity:0}
[data-on=true] .gxk-box{background:var(--primary,#d93025);border-color:var(--primary,#d93025)}
[data-on=true] .gxk-box svg{opacity:1}
.gxk-pills{display:inline-flex;flex:none;gap:4px;padding:2px;border-radius:999px;background:#f2f4f7}
.gxk-pill{height:26px;padding:0 10px;border:0;border-radius:999px;background:transparent;font:inherit;font-size:12px;font-weight:650;color:#667085;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s,box-shadow .15s}
.gxk-pill[aria-checked=true]{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.14)}
.gxk-row[data-on=true] .gxk-pill[aria-checked=true][data-category=sales]{color:#067647}
.gxk-row[data-on=true] .gxk-pill[aria-checked=true][data-category=production]{color:#175cd3}
.gxk-pill:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
.gxk-add{display:flex;gap:8px}
.gxk-input{flex:1 1 auto;min-width:0;height:42px;border:1px solid #d0d5dd;border-radius:12px;padding:0 12px;font:inherit;font-size:14px;color:#101828;outline:none}
.gxk-input:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.14)}
.gxk-add button{height:42px;padding:0 14px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;font:inherit;font-size:13px;font-weight:650;color:#344054;cursor:pointer;white-space:nowrap}
.gxk-add button:disabled{opacity:.5;cursor:default}
.gxk-loading{display:grid;place-items:center;min-height:160px}
.gxk-error{color:#b42318;font-size:13px;margin:0}
@media(max-width:560px){.gxk-row{flex-wrap:wrap;gap:6px 10px}.gxk-pills{margin-left:32px}}
@media(prefers-reduced-motion:reduce){.gxk *{transition:none!important}}
`;
const box = '<span class="gxk-box" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></span>';
function installStyle(){
  if (document.getElementById('gx-appointment-kinds-style')) return;
  const style = document.createElement('style'); style.id = 'gx-appointment-kinds-style'; style.textContent = css; document.head.append(style);
}

export function mount(el, ctx){
  installStyle();
  const L = ctx.L, esc = ctx.esc;
  const answer = object(ctx.answer);
  let alive = true, rows = [], categories = [];
  el.innerHTML = '<div class="gxk-loading"><span class="gxs-spin" aria-hidden="true"></span></div>';

  // One row per kind: the catalog's (suggested ones picked), then what was answered before, then the person's own.
  function build(catalog, status){
    const known = array(catalog.kinds);
    const before = array(object(status).kinds);
    const given = array(answer.kinds);
    const startFrom = given.length ? given : before.length ? before : array(catalog.suggested).map((id) => ({ id }));
    const picked = new Map(startFrom.map((entry) => [clean(entry.id) || `custom_${fold(entry.label)}`, entry]));
    rows = known.map((entry) => ({ id: entry.id, label: L(entry.label), category: clean(picked.get(entry.id)?.category) || entry.category, on: picked.has(entry.id), custom: false }));
    for (const [id, entry] of picked) if (!rows.some((row) => row.id === id) && clean(entry.label)) rows.push({ id, label: clean(entry.label), category: CATEGORIES.includes(entry.category) ? entry.category : 'other', on: true, custom: true });
    categories = array(catalog.categories);
  }
  const pillsHtml = (row) => `<span class="gxk-pills" role="radiogroup" aria-label="${esc(L('gx_appt_kind_category', 'Kind of appointment'))}">${categories.map((entry) => `<button type="button" class="gxk-pill" role="radio" data-category="${esc(entry.id)}" aria-checked="${row.category === entry.id}">${esc(L(entry.label))}</button>`).join('')}</span>`;
  const rowHtml = (row) => `<div class="gxk-row" data-kind="${esc(row.id)}" data-on="${row.on}"><button type="button" class="gxk-pick" role="checkbox" aria-checked="${row.on}">${box}<strong>${esc(row.label)}</strong></button>${pillsHtml(row)}</div>`;
  function draw(){
    el.innerHTML = `<div class="gxk"><p class="gxk-lead">${esc(L('gx_appt_kinds_lead', 'Pick everything you schedule, and say whether each is for sales or production.'))}</p>
      <div class="gxk-list" data-list>${rows.map(rowHtml).join('')}</div>
      <div class="gxk-add"><input class="gxk-input" data-new maxlength="80" autocomplete="off" placeholder="${esc(L('gx_appt_kinds_add_placeholder', 'Add your own, for example “Estimate”'))}" aria-label="${esc(L('gx_appt_kinds_add_label', 'Another kind of appointment'))}"><button type="button" data-add disabled>${esc(L('gx_appt_kinds_add', 'Add'))}</button></div></div>`;
    report();
  }
  /** Marks a row's state in place: a click never redraws the element it landed on. */
  function sync(node, row){
    node.dataset.on = String(row.on);
    node.querySelector('.gxk-pick').setAttribute('aria-checked', String(row.on));
    node.querySelectorAll('[data-category]').forEach((pill) => pill.setAttribute('aria-checked', String(pill.dataset.category === row.category)));
    report();
  }
  const chosen = () => rows.filter((row) => row.on);
  function summary(){ return chosen().map((row) => row.label).join(', '); }
  function report(){ ctx.change({ kinds: chosen().map((row) => row.custom ? { id: row.id, label: row.label, category: row.category } : { id: row.id, category: row.category }) }, summary()); }
  function add(){
    const input = el.querySelector('[data-new]'), words = clean(input.value).replace(/[<>]/g, '').slice(0, 80);
    if (!words || !fold(words)) return;
    const id = `custom_${fold(words)}`;
    const existing = rows.find((row) => row.id === id || row.label.toLowerCase() === words.toLowerCase());
    if (existing) { existing.on = true; sync(el.querySelector(`[data-kind="${CSS.escape(existing.id)}"]`), existing); }
    else { const row = { id, label: words, category: 'production', on: true, custom: true }; rows.push(row); el.querySelector('[data-list]').insertAdjacentHTML('beforeend', rowHtml(row)); report(); }
    input.value = ''; el.querySelector('[data-add]').disabled = true; input.focus();
  }
  const onClick = (event) => {
    const node = event.target.closest('[data-kind]');
    if (node) {
      const row = rows.find((entry) => entry.id === node.dataset.kind); if (!row) return;
      const pill = event.target.closest('[data-category]');
      // A pill picks the kind too: saying what it is means you schedule it.
      if (pill) { row.category = pill.dataset.category; row.on = true; }
      else if (event.target.closest('.gxk-pick')) row.on = !row.on;
      sync(node, row);
      return;
    }
    if (event.target.closest('[data-add]')) add();
  };
  const onInput = (event) => { if (event.target.matches('[data-new]')) el.querySelector('[data-add]').disabled = !fold(event.target.value); };
  const onKey = (event) => { if (event.target.matches('[data-new]') && event.key === 'Enter') { event.preventDefault(); if (clean(event.target.value)) add(); else if (chosen().length) ctx.advance(); } };

  Promise.all([ctx.read('appointment-setup', 'catalog'), ctx.read('appointment-setup', 'status').catch(() => null)]).then(([catalog, status]) => {
    if (!alive) return;
    build(object(catalog), object(status));
    draw();
    el.addEventListener('click', onClick); el.addEventListener('input', onInput); el.addEventListener('keydown', onKey);
  }).catch((error) => {
    if (!alive) return;
    el.innerHTML = `<p class="gxk-error" role="alert">${esc(error?.message || L('gx_step_load_failed', 'This didn’t load. Close the setup and try again.'))}</p>`;
  });

  return {
    summary,
    valid: () => chosen().length > 0,
    hint: () => L('gx_appt_kinds_hint', 'Pick at least one kind of appointment.'),
    answer: () => ({ kinds: chosen().map((row) => row.custom ? { id: row.id, label: row.label, category: row.category } : { id: row.id, category: row.category }) }),
    destroy(){ alive = false; el.removeEventListener('click', onClick); el.removeEventListener('input', onInput); el.removeEventListener('keydown', onKey); }
  };
}
export default mount;
