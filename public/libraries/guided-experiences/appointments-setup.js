// The appointment setup's own pages (guided experience `appointments.setup`, FM-515, docs/architecture/guided-experiences.md).
// It plays the first time someone opens Scheduling (put off by a skip until they book one, FM-553) or books an
// appointment, after the setup steps it requires (company type, kinds of work,
// who sells, who does the work, the kinds of appointments), each asked only while unanswered. One step that keeps its own
// pages: one per kind of appointment chosen (a text before it starts, a text when someone is on the way, who goes),
// then, when a text was asked for and texting is not set up, the offer to set it up (texting-setup.js, the same flow as
// the Communications setup) or skip, then the finish, which runs the completion action (appointments.setup.apply)
// with the answers. Everything it shows is read through the publication layer (appointment-setup.status, .catalog).
// GP-85: who goes is one or more answers (any one of them goes); each kind offers its own first (sales: me or a
// salesperson; work: crews, subcontractors or me; repairs: a technician too) and + shows the rest. Back on the first
// kind goes to the step before (ctx.back). The finish also offers the workforce setup (operations.workforce.setup)
// before scheduling, where it can play. A company with no sales appointments sees no sales/production badges.
// GP-137: the texting offer lists the texts waiting on it, and the setup's intro leads only the first page.
// GP-136: nobody going is an answer too (a delivery dropped off): the last one picked can be taken off.
// GP-138: the offer is the business phone (texts and calls, one registration), and its registration is more pages of
// this step: Back on its first page returns to the offer, and the phone's back walks its pages first.
import { commsAction, setUpTexting, textingReady } from './texting-setup.js?v=20261120-gp138b';
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();

const css = `
.gxa{display:flex;flex-direction:column;gap:16px;min-width:0;padding:2px 0 8px;color:#101828}
.gxa p{margin:0;color:#475467;line-height:1.5}
.gxa-kinds{display:flex;flex-wrap:wrap;gap:6px}
.gxa-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;border:1px solid #e4e7ec;background:#fff;font-size:12px;font-weight:650;color:#667085}
.gxa-chip[data-state=current]{border-color:var(--primary,#d93025);color:#101828;box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxa-chip[data-state=done]{color:#344054}
.gxa-chip i{font-size:10px;color:#067647}
.gxa-cat{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:700;background:#f2f4f7;color:#475467}
.gxa-cat[data-category=sales]{background:#ecfdf3;color:#067647}
.gxa-cat[data-category=production]{background:#eff8ff;color:#175cd3}
.gxa-q{display:flex;flex-direction:column;gap:8px}
.gxa-label{font-size:13px;font-weight:700;color:#344054}
.gxa-toggle{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;font:inherit;text-align:left;color:#101828;cursor:pointer;transition:border-color .15s,background .15s}
.gxa-toggle:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxa-toggle span{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.gxa-toggle strong{font-size:14px}
.gxa-toggle small{font-size:12px;color:#667085}
.gxa-switch{flex:none;position:relative;width:38px;height:22px;border-radius:999px;background:#d0d5dd;transition:background .15s}
.gxa-switch::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.2);transition:transform .15s}
.gxa-toggle[aria-checked=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.04)}
.gxa-toggle[aria-checked=true] .gxa-switch{background:var(--primary,#d93025)}
.gxa-toggle[aria-checked=true] .gxa-switch::after{transform:translateX(16px)}
.gxa-who{display:flex;flex-wrap:wrap;gap:8px}
.gxa-who button{height:36px;padding:0 14px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;font:inherit;font-size:13px;font-weight:650;color:#344054;cursor:pointer;transition:border-color .15s,background .15s,color .15s}
.gxa-who button i{display:none;margin-right:6px;font-size:11px;color:var(--primary,#d93025)}
.gxa-who button[aria-checked=true] i{display:inline}
.gxa-who button.gxa-more{width:36px;padding:0;color:#667085}
.gxa-who button.gxa-more i{display:inline;margin:0;font-size:13px;color:inherit}
.gxa-who-hint{font-size:12px;color:#667085}
.gxa-who button[aria-checked=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06);color:#101828;box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxa-who button:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxa-rows{display:flex;flex-direction:column;gap:8px}
.gxa-row{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #e4e7ec;border-radius:13px;background:#fff}
.gxa-row div{flex:1 1 auto;min-width:0}
.gxa-row strong{display:block;font-size:14px}
.gxa-row small{display:block;font-size:12px;color:#667085;margin-top:2px}
.gxa-texts{display:flex;flex-direction:column;border:1px solid #e4e7ec;border-radius:13px;background:#fff}
.gxa-text{display:flex;align-items:baseline;justify-content:space-between;gap:4px 12px;flex-wrap:wrap;padding:10px 14px}
.gxa-text+.gxa-text{border-top:1px solid #f2f4f7}
.gxa-text strong{font-size:14px}
.gxa-text small{font-size:12px;color:#667085}
.gxa-icon{flex:none;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary,#d93025);font-size:17px}
.gxa-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}
.gxa-spacer{flex:1 1 auto}
.gxa-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 18px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;font:inherit;font-size:14px;font-weight:650;color:#344054;cursor:pointer}
.gxa-btn.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}
.gxa-btn:disabled{opacity:.55;cursor:default}
.gxa-btn:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxa-busy{display:flex;align-items:center;gap:10px;min-height:120px;justify-content:center;color:#475467}
.gxa-error{color:#b42318;font-size:13px;margin:0}
.gxa-error:empty{display:none}
/* A phone (GP-137): a page fills the sheet, what it says at the top and its buttons along the bottom, in reach of the
   thumb, never floating in the middle of a short page. Back and the main button share a row (Back a third); with a
   third button the main one takes the bottom row on its own and the others share the row above. */
@media(max-width:560px){
  .gxs-step:has(>.gxs-body>.gxa){justify-content:flex-start}
  .gxs-body:has(>.gxa){display:flex;flex-direction:column;flex:1 0 auto}
  .gxa{flex:1 0 auto}
  .gxa-actions{margin-top:auto;padding-top:8px}
  .gxa-spacer{display:none}
  .gxa-actions .gxa-btn{flex:1 1 0;min-width:0;height:46px;padding:0 12px}
  .gxa-actions .gxa-btn.primary{flex-grow:2}
  .gxa-actions:has(>button:nth-of-type(3)) .gxa-btn.primary{order:1;flex-basis:100%}
  .gxa-text{flex-direction:column;align-items:flex-start;gap:2px}
}
@media(prefers-reduced-motion:reduce){.gxa *{transition:none!important}}
`;
function installStyle(){
  if (document.getElementById('gxa-css')) return;
  const style = document.createElement('style'); style.id = 'gxa-css'; style.textContent = css; document.head.append(style);
}

export function mount(el, ctx){
  installStyle();
  const { esc } = ctx;
  const L = (key, fallback, values) => { let text = ctx.L(key, fallback); for (const [name, value] of Object.entries(values || {})) text = text.split(`{${name}}`).join(String(value)); return text; };
  const orgId = String(window.__APP?.userOrgId || window.Portal?.currentUser?.orgId || ctx.orgId || '');
  let alive = true, busy = false, page = 0, kinds = [], every = [], labels = {}, categories = {}, comms = null, textingOffered = false, noSales = false, registration = null;
  // Crews and subcontractors are named by the terminology system ("crew" is not a platform word).
  const word = (path, fallback) => clean(window.PlatformTerminology?.get?.(path, fallback) || window.Portal?.terminology?.get?.(path, fallback)) || fallback;
  const crewsWord = word('workforce.resource_group_plural', 'Crews'), subsWord = word('workforce.organization_connection_plural', 'Subcontractors');
  const guides = () => window.FirstMateGuides || (() => { try { return window.top?.FirstMateGuides; } catch (_) { return null; } })();
  // The workforce setup is offered at the finish only where it can play (it needs Operations and the crew app).
  const workforceSetup = () => !!guides()?.experience?.('operations.workforce.setup');

  const errorLine = '<p class="gxa-error" role="alert" data-gxa-error></p>';
  const fail = (error) => { const node = el.querySelector('[data-gxa-error]'); if (node) node.textContent = clean(error?.message) || L('gx_appt_error', 'That didn’t work. Try again.'); };
  const heading = el.closest('.gxs-step')?.querySelector('.gxs-titlebar h2'), stepHeading = heading?.innerHTML || '';
  function title(value){ ctx.setTitle?.(value); if (heading) heading.innerHTML = value ? esc(value) : stepHeading; }
  const icon = (name) => `<span class="gxa-icon" aria-hidden="true"><i class="fas ${name}"></i></span>`;
  const wantsTexts = () => kinds.some((kind) => kind.reminder || kind.on_my_way);
  // The pages: one per kind, then texting (only when a text was asked for and texting is not ready), then the finish.
  const pages = () => [...kinds.map((_, at) => `kind:${at}`), ...(wantsTexts() && textingOffered && !textingReady(comms) ? ['texting'] : []), 'done'];
  function report(){ ctx.change({ appointment_types: kinds.map(({ id, reminder, on_my_way, attendees }) => ({ id, reminder, on_my_way, attendees })) }, kinds.map((kind) => kind.label).join(', ')); }
  function go(to){ page = Math.max(0, Math.min(to, pages().length - 1)); draw(); ctx.syncBack?.(); el.closest('.gxs-step')?.scrollTo?.({ top: 0 }); }
  // Back on the first page leaves this step for the one before it (the kinds of appointments), as the sheet's Back would.
  const canLeaveBack = () => ctx.canBack?.() === true;
  function back(){ if (registration) return registration.back(); if (busy) return true; if (page > 0) { go(page - 1); return true; } return false; }
  const texts = (kind) => kind.reminder && kind.on_my_way ? L('gx_appt_done_texts_both', 'Reminder and on-my-way texts') : kind.reminder ? L('gx_appt_done_texts_reminder', 'Reminder text') : kind.on_my_way ? L('gx_appt_done_texts_way', 'On-my-way text') : L('gx_appt_done_texts_none', 'No texts');
  const category = (id) => noSales ? '' : `<span class="gxa-cat" data-category="${esc(id)}">${esc(categories[id] || id)}</span>`;
  const who = (id) => id === 'crews' ? crewsWord : id === 'subcontractors' ? subsWord : labels[id] || id;

  function drawKind(at){
    const kind = kinds[at];
    title(kind.label);
    const toggle = (name, label, hint) => `<button type="button" class="gxa-toggle" role="switch" data-gxa-toggle="${name}" aria-checked="${!!kind[name]}"><span><strong>${esc(label)}</strong><small>${esc(hint)}</small></span><i class="gxa-switch" aria-hidden="true"></i></button>`;
    const chips = kinds.map((entry, index) => `<span class="gxa-chip" data-state="${index === at ? 'current' : index < at ? 'done' : 'next'}">${index < at ? '<i class="fas fa-check" aria-hidden="true"></i>' : ''}${esc(entry.label)}</span>`).join('');
    el.innerHTML = `<div class="gxa" data-gxa-kind="${esc(kind.id)}">
      ${kinds.length > 1 ? `<div class="gxa-kinds" aria-hidden="true">${chips}</div>` : ''}
      <p>${category(kind.category)} ${esc(L('gx_appt_kind_lead', 'A few questions about this kind of appointment.'))}</p>
      <div class="gxa-q"><span class="gxa-label">${esc(L('gx_appt_texts_label', 'Texts to the customer'))}</span>
        ${toggle('reminder', L('gx_appt_reminder', 'Text them before it starts'), L('gx_appt_reminder_hint', 'A reminder with the time and who’s coming.'))}
        ${toggle('on_my_way', L('gx_appt_on_my_way', 'Text them when we’re on the way'), L('gx_appt_on_my_way_hint', 'Sent when whoever goes taps “I’m on my way”.'))}
      </div>
      <div class="gxa-q"><span class="gxa-label" id="gxa-who-label">${esc(L('gx_appt_who', 'Who goes to these?'))}</span>
        <div class="gxa-who" role="group" aria-labelledby="gxa-who-label" data-gxa-who-list>${whoButtons(kind)}</div>
        <small class="gxa-who-hint">${esc(L('gx_appt_who_hint_none', 'Pick everyone who can go; any one of them goes. Leave them all off when nobody goes.'))}</small>
      </div>
      ${errorLine}
      <div class="gxa-actions">
        ${at > 0 || canLeaveBack() ? `<button type="button" class="gxa-btn" data-gxa-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>` : ''}
        <span class="gxa-spacer"></span>
        <button type="button" class="gxa-btn primary" data-gxa-next>${esc(L('gx_ui_continue', 'Continue'))}</button>
      </div>
    </div>`;
    // A press changes its own state in place; nothing it landed on is drawn again.
    el.querySelectorAll('[data-gxa-toggle]').forEach((button) => button.addEventListener('click', () => {
      const name = button.dataset.gxaToggle; kind[name] = !kind[name]; button.setAttribute('aria-checked', String(kind[name])); report();
    }));
    // Several can be picked, or none when nobody goes (GP-136). + shows everyone else who could go.
    el.querySelector('[data-gxa-who-list]').addEventListener('click', (event) => {
      const more = event.target.closest('[data-gxa-more]');
      if (more) { kind.more = true; const list = el.querySelector('[data-gxa-who-list]'); list.innerHTML = whoButtons(kind); list.querySelector(`[data-gxa-who="${CSS.escape(more.dataset.gxaMore)}"]`)?.focus(); return; }
      const button = event.target.closest('[data-gxa-who]'); if (!button) return;
      const id = button.dataset.gxaWho, on = kind.attendees.includes(id);
      kind.attendees = on ? kind.attendees.filter((entry) => entry !== id) : [...kind.attendees, id];
      button.setAttribute('aria-checked', String(!on));
      report();
    });
    el.querySelector('[data-gxa-back]')?.addEventListener('click', () => { if (!back()) ctx.back?.(); });
    el.querySelector('[data-gxa-next]').addEventListener('click', () => go(page + 1));
  }

  /** The kind's own answers first, then any picked from beyond them, then + (or, once pressed, everyone else). */
  function whoButtons(kind){
    const shown = [...kind.offered, ...kind.attendees.filter((id) => !kind.offered.includes(id))];
    const rest = every.filter((id) => !shown.includes(id));
    const list = kind.more ? [...shown, ...rest] : shown;
    const check = '<i class="fas fa-check" aria-hidden="true"></i>';
    return list.map((id) => `<button type="button" role="checkbox" data-gxa-who="${esc(id)}" aria-checked="${kind.attendees.includes(id)}">${check}${esc(who(id))}</button>`).join('')
      + (!kind.more && rest.length ? `<button type="button" class="gxa-more" data-gxa-more="${esc(rest[0])}" aria-label="${esc(L('gx_appt_who_more', 'Someone else'))}" title="${esc(L('gx_appt_who_more', 'Someone else'))}"><i class="fas fa-plus" aria-hidden="true"></i></button>` : '');
  }

  function drawTexting(){
    title(L('gx_appt_phone_title', 'Set up your business phone'));
    el.innerHTML = `<div class="gxa">
      <p>${esc(L('gx_appt_phone_lead', 'To text your customers, FirstMate needs a business number registered with the carriers. The same number makes and takes calls. It takes a few minutes, or do it later in Settings › Phone.'))}</p>
      <div class="gxa-rows"><div class="gxa-row">${icon('fa-phone')}<div><strong>${esc(L('gx_appt_phone_row', 'Texts and calls from your business number'))}</strong><small>${esc(L('gx_appt_texting_row_hint', 'Replies come back to the customer’s project.'))}</small></div></div></div>
      <div class="gxa-q"><span class="gxa-label">${esc(L('gx_appt_texts_label', 'Texts to the customer'))}</span>
        <div class="gxa-texts">${kinds.filter((kind) => kind.reminder || kind.on_my_way).map((kind) => `<div class="gxa-text"><strong>${esc(kind.label)}</strong><small>${esc(texts(kind))}</small></div>`).join('')}</div>
      </div>
      ${errorLine}
      <div class="gxa-actions">
        <button type="button" class="gxa-btn" data-gxa-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>
        <span class="gxa-spacer"></span>
        <button type="button" class="gxa-btn" data-gxa-skip>${esc(L('gx_appt_texting_skip', 'Skip for now'))}</button>
        <button type="button" class="gxa-btn primary" data-gxa-texting>${esc(L('gx_appt_phone_start', 'Set up phone'))}</button>
      </div>
    </div>`;
    el.querySelector('[data-gxa-back]').addEventListener('click', () => go(page - 1));
    el.querySelector('[data-gxa-skip]').addEventListener('click', () => go(pages().indexOf('done')));
    el.querySelector('[data-gxa-texting]').addEventListener('click', (event) => startTexting(event.currentTarget));
  }
  async function startTexting(button){
    if (busy) return; busy = true; button.disabled = true;
    try {
      const { left } = await setUpTexting({ orgId, status: comms || {}, host: el, setTitle: title, alive: () => alive,
        onStep: () => { ctx.syncBack?.(); el.closest('.gxs-step')?.scrollTo?.({ top: 0 }); },
        onStatus: (value) => { comms = value; },
        onRegistering: (handle) => {
          registration = handle || null;
          if (!handle && alive) { title(L('gx_comms_registering_title', 'Register your business')); el.innerHTML = `<div class="gxa"><div class="gxa-busy" role="status"><span class="gxs-spin" aria-hidden="true"></span><span>${esc(L('gx_comms_registering', 'Registering your business with the carriers…'))}</span></div>${errorLine}</div>`; }
        } });
      // Back out of registration's first page is back on the offer; anything else goes on to the finish.
      if (alive) { if (left === 'back') { draw(); ctx.syncBack?.(); } else go(pages().indexOf('done')); }
    } catch (error) { registration = null; if (alive) { draw(); fail(error); } }
    finally { busy = false; if (button.isConnected) button.disabled = false; }
  }

  function drawDone(){
    title(L('gx_appt_done_title', 'Your appointment types are ready'));
    const goes = (kind) => !kind.attendees.length ? L('gx_appt_done_nobody', 'Nobody goes') : kind.attendees.map(who).map((text, at) => at ? text.charAt(0).toLowerCase() + text.slice(1) : text).join(L('gx_appt_done_or', ' or '));
    // Before scheduling, an optional detour: set up who does the work, when any kind sends crews or subcontractors.
    const offerTeams = workforceSetup() && kinds.some((kind) => kind.attendees.includes('crews') || kind.attendees.includes('subcontractors') || kind.attendees.includes('technician'));
    const textingNote = wantsTexts() && textingOffered && !textingReady(comms) ? `<p>${esc(L('gx_appt_done_phone_later', 'Texts start once your business phone is set up in Settings › Phone.'))}</p>` : '';
    el.innerHTML = `<div class="gxa">
      <div class="gxa-rows">${kinds.map((kind) => `<div class="gxa-row" data-gxa-type="${esc(kind.id)}">${icon('fa-calendar-check')}<div><strong>${esc(kind.label)} ${category(kind.category)}</strong><small>${esc(goes(kind))} · ${esc(texts(kind))}</small></div></div>`).join('')}</div>
      ${textingNote}
      ${errorLine}
      <div class="gxa-actions">
        <button type="button" class="gxa-btn" data-gxa-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>
        <span class="gxa-spacer"></span>
        ${offerTeams ? `<button type="button" class="gxa-btn" data-gxa-teams><i class="fas fa-users" aria-hidden="true"></i>${esc(L('gx_appt_done_teams', 'Set up {crews} and {subcontractors}', { crews: crewsWord.toLowerCase(), subcontractors: subsWord.toLowerCase() }))}</button>` : ''}
        <button type="button" class="gxa-btn primary" data-gxa-finish>${esc(L('gx_appt_done', 'Book an appointment'))}</button>
      </div>
    </div>`;
    el.querySelector('[data-gxa-back]').addEventListener('click', () => go(page - 1));
    el.querySelector('[data-gxa-finish]').addEventListener('click', (event) => finish(event.currentTarget));
    el.querySelector('[data-gxa-teams]')?.addEventListener('click', (event) => finish(event.currentTarget, true));
  }
  // With `teams`, the workforce setup plays first (the appointment setup waits, hidden), then the setup finishes and
  // goes on to scheduling as usual, whether or not that one was finished.
  async function finish(button, teams = false){
    if (busy) return; busy = true; button.disabled = true;
    report();
    try {
      if (teams) await ctx.runGuide?.('operations.workforce.setup', { replay: true });
      if (alive) await ctx.complete?.();
    } catch (error) { fail(error); } finally { busy = false; if (button.isConnected) button.disabled = false; }
  }

  // The setup's intro (why it asks) leads the first page only.
  const intro = el.closest('.gxs-step')?.querySelector('.gxs-intro');
  function draw(){
    if (!alive) return;
    if (intro) intro.hidden = page > 0;
    const name = pages()[page] || 'done';
    if (name.startsWith('kind:')) drawKind(Number(name.slice(5)));
    else if (name === 'texting') drawTexting();
    else drawDone();
  }

  el.innerHTML = '<div class="gxa"><div class="gxa-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
  // Where texting stands is read once; where the Communications app is off the setup simply does not offer it.
  const commsRead = commsAction(orgId, 'comms.setup.status').then((value) => { comms = value; textingOffered = true; }).catch(() => { textingOffered = false; });
  Promise.all([ctx.read('appointment-setup', 'status'), ctx.read('appointment-setup', 'catalog'), commsRead]).then(([status, catalog]) => {
    if (!alive) return;
    status = object(status); catalog = object(catalog);
    for (const entry of array(catalog.attendees)) labels[entry.id] = ctx.L(object(entry.label).key, clean(object(entry.label).text));
    for (const entry of array(catalog.categories)) categories[entry.id] = ctx.L(object(entry.label).key, clean(object(entry.label).text));
    const names = new Map(array(catalog.kinds).map((entry) => [entry.id, ctx.L(object(entry.label).key, clean(object(entry.label).text))]));
    every = array(catalog.attendees).map((entry) => entry.id);
    noSales = status.no_sales === true;
    const offerOf = new Map(array(catalog.kinds).map((entry) => [entry.id, array(entry.offer)]));
    kinds = array(status.kinds).map((kind) => {
      // An empty list is nobody going (GP-136), not a missing answer.
      const picked = array(kind.attendees).filter((id) => every.includes(id));
      const offered = array(kind.offered).length ? array(kind.offered) : offerOf.get(kind.id) || [];
      return { id: kind.id, label: kind.custom ? clean(kind.label) : names.get(kind.id) || clean(kind.label), category: kind.category, reminder: !!kind.reminder, on_my_way: !!kind.on_my_way, offered: offered.filter((id) => every.includes(id)), attendees: picked, more: false };
    });
    if (!kinds.length) { el.innerHTML = `<div class="gxa"><p class="gxa-error" role="alert">${esc(L('gx_appt_no_kinds', 'Choose the kinds of appointments you schedule first. Close the setup and try again.'))}</p></div>`; return; }
    // Redrawn after a live edit (guided-setup.js, "Editing a setup live"): the answers so far and the page it was on.
    const was = object(ctx.hot);
    if (array(was.kinds).length === kinds.length && was.kinds.every((kind, at) => kind?.id === kinds[at].id)) kinds = was.kinds.map((kind) => ({ ...kind }));
    if (Number(was.page) > 0) page = Math.min(Number(was.page), pages().length - 1);
    report(); draw();
  }).catch((error) => { if (alive) { el.innerHTML = `<div class="gxa">${errorLine}</div>`; fail(error); } });
  return { valid: () => true, escape: () => busy && !registration, back, backDepth: () => page + (registration ? registration.depth() : 0), hotState: () => ({ page, kinds }), destroy(){ alive = false; registration?.close?.(); } };
}
export default mount;
