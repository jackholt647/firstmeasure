// The workforce setup's own pages (guided experience `operations.workforce.setup`, GP-28,
// docs/architecture/guided-experiences.md "Who does the work"). Operations' Workforce card and the Operations tab's Labor
// Setup tag play it, after the setup steps it requires (what kind of company, what work it does), each asked only while
// unanswered. One step that keeps its own pages:
//   who     who does the work at the company: just me, its own crews, subcontractors, or both (the company profile's
//           `workforce` answer, saved with company-profile.save when it changes).
//   count   how many crews and how many subcontractors. The ones the organization already has are counted and kept.
//   work    each one named, which of the company's services it does, and (a crew) who is in it, optionally.
//   pay     how each is paid: piece rate, hourly or per job, defaulted by industry (the step's `pay_defaults`, library
//           data); "same as" another one; or their pay sheet handed to the agent.
//   done    what was set up, after operations.workforce.setup.apply wrote it; Done finishes the setup.
// The cards sit side by side and scroll as a carousel when they don't fit. What a group or company is called comes from
// the terminology system ("crew" is not a platform word). Everything it shows is read through the publication layer
// (workforce-setup.status); the writes are published actions, run as the person with a key of their own each time.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();
const GROUP = 'resource_group', COMPANY = 'organization_connection';
const MAX_EACH = 20;

const css = `
.gxw{display:flex;flex-direction:column;gap:16px;min-width:0;padding:2px 0 8px;color:#101828}
.gxw p{margin:0;color:#475467;line-height:1.5}
.gxw-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.gxw-choice{position:relative;display:flex;align-items:flex-start;gap:12px;min-height:76px;padding:14px 42px 14px 14px;border:1px solid #e4e7ec;border-radius:14px;background:#fff;font:inherit;text-align:left;color:#101828;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .2s,transform .15s}
.gxw-choice:hover{border-color:#c4c9d2;transform:translateY(-1px)}
.gxw-choice span{display:flex;flex-direction:column;gap:3px;min-width:0}
.gxw-choice strong{font-size:14.5px;font-weight:700;line-height:1.25}
.gxw-choice small{font-size:12.5px;color:#667085;line-height:1.4}
.gxw-choice[aria-pressed=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.05);box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxw-tick{position:absolute;top:12px;right:12px;width:22px;height:22px;border-radius:50%;border:1.5px solid #d0d5dd;display:grid;place-items:center;transition:background .15s,border-color .15s}
.gxw-tick svg{width:12px;height:12px;stroke:#fff;fill:none;stroke-width:3;opacity:0;transition:opacity .15s}
[aria-pressed=true]>.gxw-tick{background:var(--primary,#d93025);border-color:var(--primary,#d93025)}
[aria-pressed=true]>.gxw-tick svg{opacity:1}
.gxw-icon{flex:none;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary,#d93025);font-size:17px}
.gxw-counts{display:flex;flex-direction:column;border:1px solid #eaecf0;border-radius:14px;background:#fff;overflow:hidden}
.gxw-count{display:flex;align-items:center;gap:12px;padding:14px 16px;border-top:1px solid #f2f4f7}
.gxw-count:first-child{border-top:0}
.gxw-count>span{flex:1 1 auto;min-width:0}
.gxw-count strong{display:block;font-size:14.5px}
.gxw-count small{display:block;font-size:12.5px;color:#667085;margin-top:2px}
.gxw-step{display:inline-flex;align-items:center;height:38px;border:1px solid #d0d5dd;border-radius:11px;background:#fff;overflow:hidden;flex:none}
.gxw-step button{width:36px;height:100%;border:0;background:transparent;font:inherit;font-size:17px;color:#475467;cursor:pointer}
.gxw-step button:hover:not(:disabled){background:#f2f4f7}
.gxw-step button:disabled{opacity:.35;cursor:default}
.gxw-step input{width:44px;height:100%;border:0;border-left:1px solid #eaecf0;border-right:1px solid #eaecf0;text-align:center;font:inherit;font-size:15px;font-weight:650;color:#101828;outline:none;-moz-appearance:textfield;appearance:textfield}
.gxw-step input::-webkit-outer-spin-button,.gxw-step input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.gxw-step:focus-within{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
/* The cards: side by side, as many as fit (three at most); more scroll sideways as a carousel. */
.gxw-deck{position:relative;min-width:0}
.gxw-track{display:grid;grid-auto-flow:column;grid-auto-columns:min(340px,calc((100% - (var(--n,1) - 1) * 12px) / var(--n,1)));gap:12px;overflow-x:auto;overflow-y:visible;scroll-snap-type:x mandatory;scroll-padding:0 2px;padding:2px 2px 10px;scrollbar-width:thin;overscroll-behavior-x:contain}
.gxw-card{scroll-snap-align:start;display:flex;flex-direction:column;gap:12px;min-width:0;padding:14px;border:1px solid #e4e7ec;border-radius:14px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.gxw-card header{display:flex;align-items:center;gap:8px;min-width:0}
.gxw-kind{flex:none;font-size:11px;font-weight:750;letter-spacing:.04em;text-transform:uppercase;border-radius:999px;padding:3px 8px;background:#eff8ff;color:#175cd3}
.gxw-kind[data-kind=organization_connection]{background:#fdf2fa;color:#c11574}
.gxw-card header strong{min-width:0;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxw-input{width:100%;box-sizing:border-box;height:40px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:0 11px;font:inherit;font-size:14px;color:#101828;outline:none}
.gxw-input:focus,.gxw-select:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.14)}
.gxw-select{height:36px;max-width:100%;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:0 8px;font:inherit;font-size:13px;color:#344054;outline:none}
.gxw-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.gxw-field>b{font-size:11.5px;font-weight:700;color:#667085;letter-spacing:.02em}
.gxw-chips{display:flex;flex-wrap:wrap;gap:6px}
.gxw-chip{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:0 11px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;font:inherit;font-size:12.5px;font-weight:600;color:#344054;cursor:pointer}
.gxw-chip[aria-pressed=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.07);color:var(--primary,#d93025)}
.gxw-chip i{font-size:11px}
.gxw-person{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 4px 0 10px;border-radius:999px;background:#f2f4f7;font-size:12.5px;font-weight:600;color:#344054}
.gxw-person button{width:22px;height:22px;border:0;border-radius:50%;background:transparent;color:#667085;cursor:pointer}
.gxw-person button:hover{background:#e4e7ec}
.gxw-seg{display:flex;padding:3px;border-radius:11px;background:#f2f4f7;gap:2px}
.gxw-seg button{flex:1 1 0;min-width:0;height:32px;border:0;border-radius:8px;background:transparent;font:inherit;font-size:12.5px;font-weight:650;color:#475467;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gxw-seg button[aria-checked=true]{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.12)}
.gxw-rate{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.gxw-money{display:inline-flex;align-items:center;height:38px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding-left:10px;font-weight:650;color:#667085}
.gxw-money input{width:84px;height:100%;border:0;background:transparent;padding:0 8px 0 4px;font:inherit;font-size:14px;color:#101828;outline:none}
.gxw-money:focus-within{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.14)}
.gxw-unit{font-size:12.5px;color:#667085}
.gxw-same{font-size:12.5px;color:#475467;background:#f9fafb;border-radius:10px;padding:9px 11px}
.gxw-note{font-size:12.5px!important;color:#667085!important}
.gxw-sheet{align-self:flex-start;display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 11px;border:1px dashed #d0d5dd;border-radius:10px;background:#fff;font:inherit;font-size:12.5px;font-weight:650;color:#344054;cursor:pointer}
.gxw-sheet:hover{background:#f9fafb}
.gxw-nav{position:absolute;top:50%;z-index:2;width:34px;height:34px;margin-top:-22px;border:1px solid #d0d5dd;border-radius:50%;background:#fff;color:#344054;box-shadow:0 4px 12px rgba(16,24,40,.12);cursor:pointer;display:grid;place-items:center}
.gxw-nav[hidden]{display:none}
.gxw-nav.prev{left:-12px}.gxw-nav.next{right:-12px}
.gxw-where{font-size:12px;color:#667085;text-align:center;min-height:16px}
.gxw-rows{display:flex;flex-direction:column;gap:8px}
.gxw-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid #e4e7ec;border-radius:13px;background:#fff}
.gxw-row div{flex:1 1 auto;min-width:0}
.gxw-row strong{display:block;font-size:14px}
.gxw-row small{display:block;font-size:12px;color:#667085;margin-top:2px}
.gxw-done{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;background:#ecfdf3;color:#05603a}
.gxw-done i{font-size:22px}
.gxw-done p{color:#05603a;font-size:14px;font-weight:600}
.gxw-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}
.gxw-spacer{flex:1 1 auto}
.gxw-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 18px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;font:inherit;font-size:14px;font-weight:650;color:#344054;cursor:pointer}
.gxw-btn.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}
.gxw-btn:disabled{opacity:.55;cursor:default}
.gxw-btn:focus-visible,.gxw-choice:focus-visible,.gxw-chip:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxw-busy{display:flex;align-items:center;gap:10px;min-height:120px;justify-content:center;color:#475467}
.gxw-error{color:#b42318!important;font-size:13px}
.gxw-error:empty{display:none}
/* A phone: one choice per row, and one card at a time with the next one peeking in. */
@media(max-width:560px){.gxw-choices{grid-template-columns:minmax(0,1fr)}.gxw-track{grid-auto-columns:86%}.gxw-nav{display:none}.gxw-actions .gxw-btn{flex:1 1 auto}}
@media(prefers-reduced-motion:reduce){.gxw *{transition:none!important}.gxw-track{scroll-behavior:auto}}
`;
const tick = '<span class="gxw-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></span>';
function installStyle(){
  if (document.getElementById('gxw-css')) return;
  const style = document.createElement('style'); style.id = 'gxw-css'; style.textContent = css; document.head.append(style);
}

/**
 * Whether an assignee the organization has is part of its workforce: a group of a type that does the work (the step's
 * `work_group_types`, library data; a group with no type counts), an outside company with no type the step names as
 * another kind of partner (`other_company_types`: haul-off, supplier delivery). The rest (a sales team, a dumpster
 * company) are not shown, counted or saved here.
 */
export function inWorkforce(options, entry){
  const types = array(entry?.type_ids).length ? array(entry.type_ids) : [clean(entry?.type_id)].filter(Boolean);
  if (entry?.kind === 'resource_group') { const work = array(object(options).work_group_types); return !work.length || !types.length || types.some((id) => work.includes(id)); }
  const other = array(object(options).other_company_types);
  return !types.some((id) => other.includes(id));
}
/** Which kinds the answer to "who does the work" asks for. */
export function kindsFor(workforce){
  const id = clean(workforce);
  return { groups: id === 'crews' || id === 'crews_and_subs' || id === 'just_me', companies: id === 'subcontractors' || id === 'crews_and_subs' };
}
/**
 * How a new one is paid at first: the step's `pay_defaults` (library data, the first whose `industry_sets` the company is
 * in, or one with none), as long as the company can be paid that way (a piece rate needs roofing work); else hourly.
 */
export function defaultPay(options, profile, kind){
  const sets = array(object(profile).industry_sets), roofing = array(object(profile).work_kinds).includes('roofing');
  const rules = array(object(options).pay_defaults);
  const fits = (rule) => (!array(rule.industry_sets).length || array(rule.industry_sets).some((id) => sets.includes(id))) && (!array(rule.kinds).length || array(rule.kinds).includes(kind));
  const rule = rules.find(fits) || {};
  const method = clean(rule.method);
  if (method === 'per_measurement' && roofing) return { method, rate: 0, measurement: clean(rule.measurement) || 'roof.squares' };
  if (method === 'per_job') return { method, rate: 0 };
  return { method: 'hourly', rate: 0 };
}
/** A card's pay, following "same as" to the one it copies (never round in a circle). */
export function payOf(rows, row, seen = new Set()){
  if (!row || seen.has(row.key)) return null;
  seen.add(row.key);
  if (row.same) { const other = rows.find((entry) => entry.key === row.same); if (other) return payOf(rows, other, seen); }
  return row.locked || row.sheet ? null : row.pay;
}
/** What the setup sends to operations.workforce.setup.apply for the cards it shows. */
export function applyInput(rows){
  return {
    include_labor: true,
    labor: { assignees: rows.map((row) => {
      const pay = payOf(rows, row);
      const members = row.kind === GROUP ? row.member_user_ids.filter((id) => !array(row.saved_members).includes(id)) : [];
      return {
        ...(row.ref ? { ref: row.ref } : {}), kind: row.kind, name: clean(row.name),
        service_ids: [...row.service_ids],
        ...(members.length ? { member_user_ids: members } : {}),
        ...(pay && Number(pay.rate) > 0 && !row.locked && !row.sheet ? { pay: { method: pay.method, rate: Number(pay.rate), ...(pay.method === 'per_measurement' ? { measurement: pay.measurement || 'roof.squares' } : {}) } } : {})
      };
    }) }
  };
}

export function mount(el, ctx){
  installStyle();
  const { esc } = ctx;
  const L = (key, fallback, values) => { let text = ctx.L(key, fallback); for (const [name, value] of Object.entries(values || {})) text = text.split(`{${name}}`).join(String(value)); return text; };
  const copy = (value, fallback = '') => value && typeof value === 'object' ? ctx.L(clean(value.key), clean(value.text) || fallback) : clean(value) || fallback;
  const word = (path, fallback) => clean(window.PlatformTerminology?.get?.(path, fallback) || window.Portal?.terminology?.get?.(path, fallback)) || fallback;
  const crew = word('workforce.resource_group_singular', 'Crew'), crews = word('workforce.resource_group_plural', 'Crews');
  const sub = word('workforce.organization_connection_singular', 'Subcontractor'), subs = word('workforce.organization_connection_plural', 'Subcontractors');
  const orgId = String(window.__APP?.userOrgId || window.Portal?.currentUser?.orgId || ctx.orgId || '');
  const me = { id: clean(window.Portal?.currentUser?.id || window.__APP?.userId), name: clean(window.Portal?.currentUser?.name || window.__APP?.userName) };
  const options = object(ctx.options);
  let alive = true, busy = false, page = 0, status = {}, profile = {}, workforce = '', savedWorkforce = '', rows = [], counts = {}, result = null;
  const pages = ['who', 'count', 'work', 'pay', 'done'];

  const errorLine = '<p class="gxw-error" role="alert" data-gxw-error></p>';
  const fail = (error) => { const node = el.querySelector('[data-gxw-error]'); if (node) node.textContent = clean(error?.message) || L('gx_wfs_error', 'That didn’t work. Try again.'); };
  const heading = el.closest('.gxs-step')?.querySelector('.gxs-titlebar h2'), stepHeading = heading?.innerHTML || '';
  function title(value){ ctx.setTitle?.(value); if (heading) heading.innerHTML = value ? esc(value) : stepHeading; }
  const icon = (name) => `<span class="gxw-icon" aria-hidden="true"><i class="fas ${esc(name)}"></i></span>`;
  const kindWord = (kind) => kind === GROUP ? crew : sub;
  const services = () => array(profile.services);
  const serviceLabel = (id) => services().find((entry) => entry.id === id)?.label || id;
  const people = () => array(status.people);
  const personName = (id) => people().find((entry) => entry.id === id)?.name || (id === me.id ? me.name : id);
  const measurements = () => array(status.measurements);
  const roofing = () => array(profile.work_kinds).includes('roofing');
  const wanted = () => kindsFor(workforce);
  // Crews first, then subcontractors, each in the order they were added.
  const shown = () => [...rows.filter((row) => row.kind === GROUP && wanted().groups), ...rows.filter((row) => row.kind === COMPANY && wanted().companies)];
  const existingOf = (kind) => rows.filter((row) => row.kind === kind && row.existing);
  function report(){ ctx.change?.({ workforce, ...applyInput(shown()) }, shown().map((row) => clean(row.name)).join(', ')); }
  function go(to){
    // "Just me" has nobody to count: the one card is the person's own.
    let next = Math.max(0, Math.min(to, pages.length - 1));
    if (pages[next] === 'count' && workforce === 'just_me') next += to > page ? 1 : -1;
    page = next; draw(); el.closest('.gxs-step')?.scrollTo?.({ top: 0 }); ctx.syncBack?.();
  }
  const backButton = () => `<button type="button" class="gxw-btn" data-gxw-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>`;
  const nextButton = (label) => `<button type="button" class="gxw-btn primary" data-gxw-next>${esc(label || L('gx_ui_continue', 'Continue'))}</button>`;

  // ── Who does the work at your company? ─────────────────────────────────
  const WHO_ICONS = { just_me: 'fa-user', crews: 'fa-people-group', subcontractors: 'fa-handshake', crews_and_subs: 'fa-users-gear' };
  function drawWho(){
    title(L('gx_wfs_who_title', 'Who does the work at your company?'));
    const answers = array(status.workforces);
    el.innerHTML = `<div class="gxw" data-gxw-page="who">
      <p>${esc(L('gx_wfs_who_lead', 'Tell us how your work gets done. Next you’ll name each {crew_lower} and {sub_lower}, say what they do and how you pay them.', { crew_lower: crew.toLowerCase(), sub_lower: sub.toLowerCase() }))}</p>
      <div class="gxw-choices" role="radiogroup">${answers.map((entry) => `<button type="button" class="gxw-choice" data-gxw-who="${esc(entry.id)}" role="radio" aria-pressed="${workforce === entry.id}" aria-checked="${workforce === entry.id}">${icon(WHO_ICONS[entry.id] || 'fa-users')}<span><strong>${esc(copy(entry.label, entry.id))}</strong><small>${esc(copy(entry.hint))}</small></span>${tick}</button>`).join('')}</div>
      ${errorLine}
      <div class="gxw-actions"><span class="gxw-spacer"></span>${nextButton()}</div>
    </div>`;
    el.querySelectorAll('[data-gxw-who]').forEach((button) => button.addEventListener('click', () => {
      workforce = button.dataset.gxwWho;
      el.querySelectorAll('[data-gxw-who]').forEach((other) => { const on = other === button; other.setAttribute('aria-pressed', String(on)); other.setAttribute('aria-checked', String(on)); });
      el.querySelector('[data-gxw-error]').textContent = '';
      fitRows(); report();
    }));
    el.querySelector('[data-gxw-next]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!workforce) { fail({ message: L('gx_wfs_who_required', 'Choose who does the work to continue.') }); return; }
      if (busy) return;
      // The answer is the company profile's, kept once for every setup that needs it.
      if (workforce !== savedWorkforce) {
        busy = true; button.disabled = true;
        try {
          await window.PlatformAPI.publication.invoke(orgId, 'company-profile.save', { scope: 'organization', organizationId: orgId }, { workforce }, { idempotencyKey: `operations.workforce.setup:who:${orgId}:${crypto.randomUUID()}` });
          savedWorkforce = workforce;
        } catch (error) { fail(error); return; } finally { busy = false; if (button.isConnected) button.disabled = false; }
      }
      if (!alive) return;
      go(page + 1);
    });
  }

  // ── How many do you have? ──────────────────────────────────────────────
  const defaultName = (kind, at) => {
    const used = new Set(rows.map((row) => clean(row.name).toLowerCase()));
    for (let n = at; n < at + 200; n += 1) {
      const letter = n < 26 ? String.fromCharCode(65 + n) : String(n + 1);
      const name = `${kindWord(kind)} ${letter}`;
      if (!used.has(name.toLowerCase())) return name;
    }
    return `${kindWord(kind)} ${at + 1}`;
  };
  function newRow(kind){
    const at = rows.filter((row) => row.kind === kind).length;
    const own = workforce === 'just_me' && kind === GROUP && !rows.some((row) => row.kind === GROUP);
    return { key: `new:${kind}:${crypto.randomUUID().slice(0, 8)}`, kind, existing: false, name: own && me.name ? me.name : defaultName(kind, at),
      service_ids: services().map((entry) => entry.id), member_user_ids: own && me.id ? [me.id] : [], saved_members: [], pay: defaultPay(options, profile, kind), same: '' };
  }
  /** Adds or takes away new cards so each kind has as many as was said; the ones already set up are always kept. */
  function fitRows(){
    for (const kind of [GROUP, COMPANY]) {
      const on = kind === GROUP ? wanted().groups : wanted().companies;
      const want = on ? Math.max(existingOf(kind).length, workforce === 'just_me' ? 1 : Number(counts[kind]) || 1) : existingOf(kind).length;
      let have = rows.filter((row) => row.kind === kind);
      while (have.length < want) { rows.push(newRow(kind)); have = rows.filter((row) => row.kind === kind); }
      while (have.length > want) { const last = [...have].reverse().find((row) => !row.existing); if (!last) break; rows = rows.filter((row) => row !== last); rows.forEach((row) => { if (row.same === last.key) row.same = ''; }); have = rows.filter((row) => row.kind === kind); }
      counts[kind] = have.length;
    }
  }
  function drawCount(){
    title(L('gx_wfs_count_title', 'How many do you have?'));
    const line = (kind, label, hint) => {
      const min = Math.max(1, existingOf(kind).length), value = rows.filter((row) => row.kind === kind).length;
      const have = existingOf(kind).length;
      return `<div class="gxw-count" data-gxw-count="${kind}">${icon(kind === GROUP ? 'fa-people-group' : 'fa-handshake')}<span><strong>${esc(label)}</strong><small>${esc(have ? L('gx_wfs_count_have', '{n} already set up, kept as they are', { n: have }) : hint)}</small></span>
        <span class="gxw-step"><button type="button" data-gxw-minus aria-label="${esc(L('gx_wfs_fewer', 'One fewer'))}" ${value <= min ? 'disabled' : ''}>−</button><input type="number" inputmode="numeric" min="${min}" max="${MAX_EACH}" value="${value}" aria-label="${esc(label)}"><button type="button" data-gxw-plus aria-label="${esc(L('gx_wfs_more', 'One more'))}" ${value >= MAX_EACH ? 'disabled' : ''}>+</button></span></div>`;
    };
    el.innerHTML = `<div class="gxw" data-gxw-page="count">
      <p>${esc(L('gx_wfs_count_lead', 'Count each team that goes out on its own. You’ll name them next.'))}</p>
      <div class="gxw-counts">
        ${wanted().groups ? line(GROUP, crews, L('gx_wfs_count_crews_hint', 'Teams of your own people')) : ''}
        ${wanted().companies ? line(COMPANY, subs, L('gx_wfs_count_subs_hint', 'Outside companies that do the work for you')) : ''}
      </div>
      ${errorLine}
      <div class="gxw-actions">${backButton()}<span class="gxw-spacer"></span>${nextButton()}</div>
    </div>`;
    el.querySelectorAll('[data-gxw-count]').forEach((holder) => {
      const kind = holder.dataset.gxwCount, input = holder.querySelector('input');
      const set = (value) => {
        const min = Math.max(1, existingOf(kind).length);
        counts[kind] = Math.max(min, Math.min(MAX_EACH, Math.round(Number(value)) || min));
        fitRows(); report(); drawCount();
        el.querySelector(`[data-gxw-count="${kind}"] input`)?.focus();
      };
      holder.querySelector('[data-gxw-minus]').addEventListener('click', () => set(Number(input.value) - 1));
      holder.querySelector('[data-gxw-plus]').addEventListener('click', () => set(Number(input.value) + 1));
      input.addEventListener('change', () => set(input.value));
    });
    el.querySelector('[data-gxw-back]').addEventListener('click', () => go(page - 1));
    el.querySelector('[data-gxw-next]').addEventListener('click', () => go(page + 1));
  }

  // ── The cards, side by side or as a carousel ───────────────────────────
  function deck(cards){
    return `<div class="gxw-deck"><button type="button" class="gxw-nav prev" data-gxw-nav="-1" aria-label="${esc(L('gx_wfs_previous', 'Previous'))}" hidden><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
      <div class="gxw-track" style="--n:${Math.max(1, Math.min(3, cards.length))}">${cards.join('')}</div>
      <button type="button" class="gxw-nav next" data-gxw-nav="1" aria-label="${esc(L('gx_wfs_next', 'Next'))}" hidden><i class="fas fa-chevron-right" aria-hidden="true"></i></button></div>
      <div class="gxw-where" aria-live="polite"></div>`;
  }
  function wireDeck(){
    const track = el.querySelector('.gxw-track'); if (!track) return;
    const prev = el.querySelector('[data-gxw-nav="-1"]'), next = el.querySelector('[data-gxw-nav="1"]'), where = el.querySelector('.gxw-where');
    const update = () => {
      const more = track.scrollWidth - track.clientWidth > 4;
      prev.hidden = !more || track.scrollLeft < 4; next.hidden = !more || track.scrollLeft > track.scrollWidth - track.clientWidth - 4;
      const cards = [...track.children], width = cards[0]?.getBoundingClientRect().width || 1;
      const first = Math.round(track.scrollLeft / (width + 12)), visible = Math.max(1, Math.round((track.clientWidth + 12) / (width + 12)));
      where.textContent = more ? L('gx_wfs_where', '{from}–{to} of {n}', { from: first + 1, to: Math.min(cards.length, first + visible), n: cards.length }) : '';
    };
    const step = (direction) => { const width = track.firstElementChild?.getBoundingClientRect().width || track.clientWidth; track.scrollBy({ left: direction * (width + 12), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };
    prev.addEventListener('click', () => step(-1)); next.addEventListener('click', () => step(1));
    track.addEventListener('scroll', update, { passive: true });
    // A field tabbed into on a card out of view brings that card in.
    track.addEventListener('focusin', (event) => event.target.closest('.gxw-card')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
    requestAnimationFrame(update);
  }
  const head = (row) => `<header><span class="gxw-kind" data-kind="${row.kind}">${esc(kindWord(row.kind))}</span><strong title="${esc(row.name)}">${esc(row.name)}</strong></header>`;

  // ── Name each one and say what they do ─────────────────────────────────
  function workCard(row){
    const chosen = new Set(row.service_ids);
    const others = people().filter((person) => !row.member_user_ids.includes(person.id));
    return `<article class="gxw-card" data-gxw-card="${esc(row.key)}">
      <header><span class="gxw-kind" data-kind="${row.kind}">${esc(kindWord(row.kind))}</span></header>
      <label class="gxw-field"><b>${esc(L('gx_wfs_name', 'Name'))}</b><input class="gxw-input" data-gxw-name value="${esc(row.name)}" maxlength="300" ${row.existing ? 'readonly title="' + esc(L('gx_wfs_name_people', 'Rename it in People')) + '"' : ''}></label>
      ${services().length ? `<div class="gxw-field"><b>${esc(L('gx_wfs_does', 'What they do'))}</b><div class="gxw-chips">${services().map((entry) => `<button type="button" class="gxw-chip" data-gxw-service="${esc(entry.id)}" aria-pressed="${chosen.has(entry.id)}">${chosen.has(entry.id) ? '<i class="fas fa-check" aria-hidden="true"></i>' : ''}${esc(entry.label)}</button>`).join('')}</div></div>` : ''}
      ${row.kind === GROUP ? `<div class="gxw-field"><b>${esc(L('gx_wfs_members', 'Who’s on it (optional)'))}</b>
        ${row.member_user_ids.length ? `<div class="gxw-chips">${row.member_user_ids.map((id) => `<span class="gxw-person">${esc(personName(id))}${array(row.saved_members).includes(id) ? '<span style="width:6px"></span>' : `<button type="button" data-gxw-unmember="${esc(id)}" aria-label="${esc(L('gx_wfs_member_remove', 'Take off'))} ${esc(personName(id))}"><i class="fas fa-xmark" aria-hidden="true"></i></button>`}</span>`).join('')}</div>` : ''}
        ${others.length ? `<select class="gxw-select" data-gxw-member><option value="">${esc(L('gx_wfs_member_add', 'Add someone…'))}</option>${others.map((person) => `<option value="${esc(person.id)}">${esc(person.name)}</option>`).join('')}</select>` : ''}
      </div>` : ''}
    </article>`;
  }
  function drawWork(){
    title(L('gx_wfs_work_title', 'Name each one and say what they do'));
    const list = shown();
    el.innerHTML = `<div class="gxw" data-gxw-page="work">
      <p>${esc(services().length ? L('gx_wfs_work_lead', 'Give each one a name your team uses and pick the work they do. You can add who is on a {crew_lower} now or later.', { crew_lower: crew.toLowerCase() }) : L('gx_wfs_work_lead_plain', 'Give each one a name your team uses.'))}</p>
      ${deck(list.map(workCard))}
      ${errorLine}
      <div class="gxw-actions">${backButton()}<span class="gxw-spacer"></span>${nextButton()}</div>
    </div>`;
    const rowOf = (node) => rows.find((row) => row.key === node.closest('[data-gxw-card]')?.dataset.gxwCard);
    el.querySelectorAll('[data-gxw-name]').forEach((input) => input.addEventListener('input', () => { const row = rowOf(input); if (row && !row.existing) { row.name = input.value; report(); } }));
    el.querySelectorAll('[data-gxw-service]').forEach((button) => button.addEventListener('click', () => {
      const row = rowOf(button), id = button.dataset.gxwService; if (!row) return;
      row.service_ids = row.service_ids.includes(id) ? row.service_ids.filter((entry) => entry !== id) : [...row.service_ids, id];
      const on = row.service_ids.includes(id);
      button.setAttribute('aria-pressed', String(on)); button.innerHTML = `${on ? '<i class="fas fa-check" aria-hidden="true"></i>' : ''}${esc(serviceLabel(id))}`;
      report();
    }));
    const redrawCard = (row) => { const card = el.querySelector(`[data-gxw-card="${CSS.escape(row.key)}"]`); if (!card) return; const left = el.querySelector('.gxw-track')?.scrollLeft || 0; drawWork(); const track = el.querySelector('.gxw-track'); if (track) track.scrollLeft = left; el.querySelector(`[data-gxw-card="${CSS.escape(row.key)}"] [data-gxw-member]`)?.focus({ preventScroll: true }); };
    el.querySelectorAll('[data-gxw-member]').forEach((select) => select.addEventListener('change', () => { const row = rowOf(select); if (!row || !select.value) return; row.member_user_ids = [...new Set([...row.member_user_ids, select.value])]; report(); redrawCard(row); }));
    el.querySelectorAll('[data-gxw-unmember]').forEach((button) => button.addEventListener('click', () => { const row = rowOf(button); if (!row) return; row.member_user_ids = row.member_user_ids.filter((id) => id !== button.dataset.gxwUnmember); report(); redrawCard(row); }));
    el.querySelector('[data-gxw-back]').addEventListener('click', () => go(page - 1));
    el.querySelector('[data-gxw-next]').addEventListener('click', () => {
      const unnamed = list.findIndex((row) => !clean(row.name));
      if (unnamed >= 0) { fail({ message: L('gx_wfs_name_required', 'Give each one a name.') }); el.querySelectorAll('[data-gxw-name]')[unnamed]?.focus(); return; }
      const names = list.map((row) => `${row.kind}:${clean(row.name).toLowerCase()}`);
      if (new Set(names).size !== names.length) { fail({ message: L('gx_wfs_name_unique', 'Give each one its own name.') }); return; }
      const idle = list.find((row) => services().length && !row.service_ids.length);
      if (idle) { fail({ message: L('gx_wfs_does_required', 'Pick at least one kind of work for {name}.', { name: clean(idle.name) }) }); return; }
      go(page + 1);
    });
    wireDeck();
  }

  // ── How do you pay them? ───────────────────────────────────────────────
  const unitOf = (pay) => pay?.method === 'hourly' ? L('gx_lab_per_hour', 'per hour') : pay?.method === 'per_job' ? L('gx_lab_per_job', 'per job') : String(pay?.measurement || 'roof.squares').startsWith('roof.squares') || pay?.measurement === 'roof.flat_squares' ? L('gx_lab_per_square', 'per square') : L('gx_lab_per_foot', 'per foot');
  const payText = (pay) => pay && Number(pay.rate) > 0 ? `$${Number(pay.rate).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unitOf(pay)}` : '';
  function payCard(row, list){
    const pay = row.pay, others = list.filter((other) => other !== row && !other.locked && !other.sheet && other.same !== row.key);
    const method = (id, label) => `<button type="button" role="radio" data-gxw-method="${id}" aria-checked="${pay?.method === id}">${esc(label)}</button>`;
    const same = row.same ? list.find((other) => other.key === row.same) : null;
    let body;
    if (row.locked) body = `<p class="gxw-note">${esc(L('gx_lab_locked', 'Paid by its own pay sheet'))} (${row.lines} ${esc(L('gx_lab_lines', 'lines'))}). ${esc(L('gx_lab_locked_where', 'Change it in People.'))}</p>`;
    else if (row.sheet) body = `<p class="gxw-same"><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> ${esc(L('gx_wfs_sheet_sent', 'The agent is setting up their pay from the sheet you sent.'))}</p>`;
    else if (same) body = `<p class="gxw-same">${esc(L('gx_wfs_same_as', 'Paid the same as {name}', { name: clean(same.name) }))}${payText(payOf(list, row)) ? ` · ${esc(payText(payOf(list, row)))}` : ''}</p>`;
    else body = `<div class="gxw-seg" role="radiogroup" aria-label="${esc(L('gx_lab_how_paid', 'How they are paid'))}">${roofing() || pay?.method === 'per_measurement' ? method('per_measurement', L('gx_lab_piece', 'Piece rate')) : ''}${method('hourly', L('gx_lab_hourly', 'Hourly'))}${method('per_job', L('gx_lab_job', 'Per job'))}</div>
      <div class="gxw-rate"><label class="gxw-money">$<input type="number" min="0" step="0.01" inputmode="decimal" data-gxw-rate value="${Number(pay?.rate) > 0 ? esc(pay.rate) : ''}" placeholder="0.00" aria-label="${esc(L('gx_lab_rate', 'Rate'))}"></label>
      ${pay?.method === 'per_measurement' ? `<span class="gxw-unit">${esc(L('gx_wfs_per', 'per'))}</span><select class="gxw-select" data-gxw-measurement aria-label="${esc(L('gx_lab_paid_on', 'Paid on'))}">${measurements().map((entry) => `<option value="${esc(entry.id)}" ${entry.id === (pay.measurement || 'roof.squares') ? 'selected' : ''}>${esc(entry.label)}</option>`).join('')}</select>` : `<span class="gxw-unit">${esc(unitOf(pay))}</span>`}</div>`;
    return `<article class="gxw-card" data-gxw-card="${esc(row.key)}">${head(row)}
      ${body}
      ${!row.locked && !row.sheet && (others.length || same) ? `<label class="gxw-field"><b>${esc(L('gx_wfs_same', 'Same pay as'))}</b><select class="gxw-select" data-gxw-same><option value="">${esc(L('gx_wfs_same_none', 'Nobody: their own rates'))}</option>${list.filter((other) => other !== row && !other.locked && !other.sheet && other.same !== row.key).map((other) => `<option value="${esc(other.key)}" ${other.key === row.same ? 'selected' : ''}>${esc(other.name)}</option>`).join('')}</select></label>` : ''}
      ${ctx.paySheet && !row.locked && !row.sheet ? `<button type="button" class="gxw-sheet" data-gxw-sheet title="${esc(L('gx_lab_sheet_tip', 'Upload their pay sheet or rate card and the agent sets up their pay from it'))}"><i class="fas fa-file-arrow-up" aria-hidden="true"></i>${esc(L('gx_lab_sheet_upload', 'Upload pay sheet'))}</button>` : ''}
    </article>`;
  }
  function drawPay(){
    title(L('gx_wfs_pay_title', 'How do you pay them?'));
    const list = shown();
    el.innerHTML = `<div class="gxw" data-gxw-page="pay">
      <p>${esc(L('gx_wfs_pay_lead', 'Set each one’s rate, or say they’re paid the same as another. Leave a rate empty to set it later in People.'))}</p>
      ${deck(list.map((row) => payCard(row, list)))}
      ${errorLine}
      <div class="gxw-actions">${backButton()}<span class="gxw-spacer"></span><button type="button" class="gxw-btn primary" data-gxw-apply>${esc(L('gx_wfs_apply', 'Save'))}</button></div>
    </div>`;
    const rowOf = (node) => rows.find((row) => row.key === node.closest('[data-gxw-card]')?.dataset.gxwCard);
    const redraw = (focus) => { const left = el.querySelector('.gxw-track')?.scrollLeft || 0; drawPay(); const track = el.querySelector('.gxw-track'); if (track) track.scrollLeft = left; if (focus) el.querySelector(focus)?.focus({ preventScroll: true }); };
    el.querySelectorAll('[data-gxw-method]').forEach((button) => button.addEventListener('click', () => {
      const row = rowOf(button), method = button.dataset.gxwMethod; if (!row) return;
      row.pay = { method, rate: row.pay?.method === method ? row.pay.rate : 0, ...(method === 'per_measurement' ? { measurement: row.pay?.measurement || 'roof.squares' } : {}) };
      report(); redraw(`[data-gxw-card="${CSS.escape(row.key)}"] [data-gxw-rate]`);
    }));
    el.querySelectorAll('[data-gxw-rate]').forEach((input) => input.addEventListener('input', () => {
      const row = rowOf(input); if (!row?.pay) return;
      const value = Number(input.value); row.pay = { ...row.pay, rate: Number.isFinite(value) && value >= 0 ? value : 0 };
      report();
      // Cards that copy this one say the new rate.
      list.filter((other) => other.same === row.key).forEach((other) => { const note = el.querySelector(`[data-gxw-card="${CSS.escape(other.key)}"] .gxw-same`); if (note) note.textContent = `${L('gx_wfs_same_as', 'Paid the same as {name}', { name: clean(row.name) })}${payText(payOf(list, other)) ? ` · ${payText(payOf(list, other))}` : ''}`; });
    }));
    el.querySelectorAll('[data-gxw-measurement]').forEach((select) => select.addEventListener('change', () => { const row = rowOf(select); if (row?.pay) { row.pay = { ...row.pay, measurement: select.value }; report(); } }));
    el.querySelectorAll('[data-gxw-same]').forEach((select) => select.addEventListener('change', () => { const row = rowOf(select); if (!row) return; row.same = select.value; report(); redraw(`[data-gxw-card="${CSS.escape(row.key)}"] [data-gxw-same]`); }));
    el.querySelectorAll('[data-gxw-sheet]').forEach((button) => button.addEventListener('click', () => uploadSheet(rowOf(button), button)));
    el.querySelector('[data-gxw-back]').addEventListener('click', () => go(page - 1));
    el.querySelector('[data-gxw-apply]').addEventListener('click', (event) => apply(event.currentTarget));
    wireDeck();
  }
  /**
   * Their pay sheet, for the agent: the card is saved first (so a new one has an id to name), then the player picks the
   * file and hands it to the agent beside the setup, which writes their pay sheet. Their rates here are left alone.
   */
  async function uploadSheet(row, button){
    if (!row || busy || !ctx.paySheet) return;
    busy = true; button.disabled = true;
    try {
      if (!row.ref) {
        const saved = await save([{ ...row, sheet: true }]);
        const match = array(saved.assignees).find((entry) => entry.kind === row.kind && clean(entry.name).toLowerCase() === clean(row.name).toLowerCase());
        if (match?.ref) { row.ref = match.ref; row.existing = true; row.saved_members = [...row.member_user_ids]; }
      }
      const sent = await ctx.paySheet({ ref: row.ref, kind: row.kind, name: clean(row.name) });
      if (sent !== null && sent !== undefined && alive) { row.sheet = true; rows.forEach((other) => { if (other.same === row.key) other.same = ''; }); report(); drawPay(); }
    } catch (error) { fail(error); }
    finally { busy = false; if (button.isConnected) button.disabled = false; }
  }
  async function save(list){
    const target = { scope: 'organization', organizationId: orgId };
    const response = await window.PlatformAPI.publication.invoke(orgId, 'operations.workforce.setup.apply', target, applyInput(list), { idempotencyKey: `operations.workforce.setup:${orgId}:${crypto.randomUUID()}` });
    return object(response?.value ?? response?.result ?? response);
  }
  async function apply(button){
    if (busy) return; busy = true; button.disabled = true;
    report();
    try {
      result = await save(shown());
      if (!alive) return;
      // What was just written is no longer new: a Back and a second Save change them rather than add them again.
      for (const entry of array(result.assignees)) {
        const row = shown().find((item) => item.kind === entry.kind && clean(item.name).toLowerCase() === clean(entry.name).toLowerCase());
        if (row && entry.ref) { row.ref = entry.ref; row.existing = true; row.saved_members = [...row.member_user_ids]; }
      }
      // The Operations tab and People under the sheet read their workforce again.
      const windows = new Set([window]); try { if (window.top.location.origin === location.origin) windows.add(window.top); } catch (_) {}
      windows.forEach((win) => win.dispatchEvent(new win.CustomEvent('fm:workforce:changed', { detail: { source: 'operations.workforce.setup' } })));
      go(pages.indexOf('done'));
    } catch (error) { fail(error); }
    finally { busy = false; if (button.isConnected) button.disabled = false; }
  }

  // ── Your crews and subcontractors are set up ───────────────────────────
  function drawDone(){
    const list = shown(), both = list.some((row) => row.kind === GROUP) && list.some((row) => row.kind === COMPANY);
    title(both ? L('gx_wfs_done_title_both', 'Your {crews_lower} and {subs_lower} are set up', { crews_lower: crews.toLowerCase(), subs_lower: subs.toLowerCase() }) : L('gx_wfs_done_title', 'Who does the work is set up'));
    el.innerHTML = `<div class="gxw" data-gxw-page="done">
      <div class="gxw-done" role="status"><i class="fas fa-circle-check" aria-hidden="true"></i><p>${esc(L('gx_wfs_done_body', 'Work orders use their pay, and you can change any of it in Operations settings or People.'))}</p></div>
      <div class="gxw-rows">${list.map((row) => {
        const pay = payOf(list, row), same = row.same ? list.find((other) => other.key === row.same) : null;
        const parts = [row.service_ids.map(serviceLabel).join(', '),
          row.kind === GROUP && row.member_user_ids.length ? L('gx_wfs_done_people', '{n} on it', { n: row.member_user_ids.length }) : '',
          row.locked ? L('gx_lab_locked', 'Paid by its own pay sheet') : row.sheet ? L('gx_wfs_done_sheet', 'Pay from their sheet') : same ? L('gx_wfs_same_as', 'Paid the same as {name}', { name: clean(same.name) }) : payText(pay) || L('gx_wfs_done_no_pay', 'Pay not set yet')].filter(Boolean);
        return `<div class="gxw-row" data-gxw-done="${esc(row.key)}">${icon(row.kind === GROUP ? 'fa-people-group' : 'fa-handshake')}<div><strong>${esc(row.name)}</strong><small>${esc(parts.join(' · '))}</small></div></div>`;
      }).join('')}</div>
      ${errorLine}
      <div class="gxw-actions"><span class="gxw-spacer"></span><button type="button" class="gxw-btn primary" data-gxw-finish>${esc(L('gx_ui_done', 'Done'))}</button></div>
    </div>`;
    el.querySelector('[data-gxw-finish]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (busy) return; busy = true; button.disabled = true;
      try { await ctx.complete?.(); } catch (error) { fail(error); } finally { busy = false; if (button.isConnected) button.disabled = false; }
    });
  }

  function draw(){
    if (!alive) return;
    const name = pages[page];
    if (name === 'who') drawWho();
    else if (name === 'count') drawCount();
    else if (name === 'work') drawWork();
    else if (name === 'pay') drawPay();
    else drawDone();
  }

  el.innerHTML = '<div class="gxw"><div class="gxw-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
  // Read when the step shows, not when the setup opened: the setup steps before it may have just answered the profile.
  ctx.read('workforce-setup', 'status').then((value) => {
    if (!alive) return;
    status = object(value); profile = object(status.profile);
    workforce = savedWorkforce = clean(profile.workforce);
    const known = new Set(services().map((entry) => entry.id));
    rows = array(status.assignees).filter((entry) => inWorkforce(options, entry)).map((entry) => {
      const simple = entry.pay?.simple || null;
      const saved = array(entry.service_ids).filter((id) => known.has(id));
      return { key: `${entry.kind}:${clean(entry.ref?.id)}`, ref: entry.ref, kind: entry.kind, existing: true, name: clean(entry.name),
        // Nothing said yet about what it does: everything the company does, until the person says otherwise.
        service_ids: saved.length ? saved : [...known], member_user_ids: array(entry.member_user_ids), saved_members: array(entry.member_user_ids),
        locked: !!entry.pay && !simple, lines: Number(entry.pay?.lines || 0), pay: simple ? { ...simple } : defaultPay(options, profile, entry.kind), same: '' };
    });
    for (const kind of [GROUP, COMPANY]) counts[kind] = Math.max(1, existingOf(kind).length);
    if (workforce) fitRows();
    report(); draw();
  }).catch((error) => { if (alive) { el.innerHTML = `<div class="gxw">${errorLine}</div>`; fail(error); } });
  return {
    valid: () => true,
    escape: () => busy,
    // The phone's back walks these pages first; once everything is written there is nothing to go back to.
    backDepth: () => pages[page] === 'done' ? 0 : pages.slice(0, page).filter((name) => !(name === 'count' && workforce === 'just_me')).length,
    back(){ if (pages[page] === 'done' || page === 0) return false; go(page - 1); return true; },
    destroy(){ alive = false; }
  };
}
export default mount;
