// The salesperson setup's own pages (guided experience `sales.team.setup`, GP-144, docs/architecture/guided-experiences.md
// "Who sells"). The New appointment dialog's "No one is set up to go to these yet", a sales type's Add users and the
// calendar's "Salesperson is not assigned" play it, after the setup steps it requires (what kind of company, what work
// it does), each asked only while unanswered. One step that keeps its own pages:
//   people  the salespeople, one card each: someone already in the organization picked from a list or someone new
//           added by name and email, and the kinds of work they may sell, every one the company does to start with.
//           Someone in Sales through a role or a group is shown and kept; only the ones added here can be taken off.
//   done    who sells what, after sales.team.setup.apply wrote it (and the new ones were invited, when asked); Done
//           finishes the setup.
// Everything it shows is read through the publication layer (sales-team-setup.status); the writes are published
// actions run as the person: someone new is added with workforce.users.add and invited with workforce.users.invite.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();
const fold = (value) => clean(value).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const PENDING = 'new-person:';
const isPending = (id) => String(id || '').startsWith(PENDING);
const initials = (name) => clean(name).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';

const css = `
.gxp{display:flex;flex-direction:column;gap:16px;min-width:0;padding:2px 0 8px;color:#101828}
.gxp p{margin:0;color:#475467;line-height:1.5}
.gxp-cards{display:flex;flex-direction:column;gap:10px}
.gxp-card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:1px solid #e4e7ec;border-radius:14px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.gxp-card>header{display:flex;align-items:center;gap:12px;min-width:0}
.gxp-card>header>span{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.gxp-card>header strong{font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxp-card>header small{font-size:12px;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxp-avatar{flex:none;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary,#d93025);font-size:12.5px;font-weight:750}
.gxp-remove{flex:none;width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:#98a2b3;cursor:pointer;display:grid;place-items:center;font-size:13px}
.gxp-remove:hover{background:#f2f4f7;color:#475467}
.gxp-remove:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxp-sells{display:flex;flex-direction:column;gap:8px}
.gxp-sells>b{font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#667085}
.gxp-chips{display:flex;flex-wrap:wrap;gap:8px}
.gxp-chip{display:inline-flex;align-items:center;gap:7px;min-height:34px;padding:6px 13px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;font:inherit;font-size:13px;font-weight:600;line-height:1.25;color:#475467;cursor:pointer;text-align:left;transition:border-color .15s,background .15s,color .15s}
.gxp-chip i{display:none;font-size:11px}
.gxp-chip[aria-pressed=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.07);color:var(--primary,#d93025)}
.gxp-chip[aria-pressed=true] i{display:inline}
.gxp-chip:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxp-add{align-self:flex-start;display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 15px;border:1px dashed #c4c9d2;border-radius:12px;background:#fff;font:inherit;font-size:13.5px;font-weight:650;color:#344054;cursor:pointer}
.gxp-add:hover{background:#f9fafb}
.gxp-add[aria-expanded=true]{border-style:solid;border-color:var(--primary,#d93025);color:var(--primary,#d93025)}
.gxp-menu{display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;box-shadow:0 12px 32px rgba(16,24,40,.14)}
.gxp-menu input{height:38px;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:9px;padding:0 11px;font:inherit;font-size:14px;color:#101828;outline:none;min-width:0}
.gxp-menu input:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
.gxp-menu ul{list-style:none;margin:0;padding:0;max-height:240px;overflow:auto}
.gxp-menu li button{display:flex;align-items:center;gap:10px;width:100%;padding:8px;border:0;border-radius:8px;background:transparent;font:inherit;font-size:13.5px;color:#101828;text-align:left;cursor:pointer}
.gxp-menu li button:hover,.gxp-menu li button:focus-visible{background:#f2f4f7;outline:none}
.gxp-menu li button>span:last-child{display:flex;flex-direction:column;min-width:0}
.gxp-menu li small{font-size:11.5px;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxp-menu .gxp-avatar{width:28px;height:28px;font-size:10.5px}
.gxp-menu-empty{padding:8px;font-size:12.5px;color:#667085}
.gxp-menu-new{display:flex;align-items:center;gap:9px;padding:9px 8px;border:0;border-top:1px solid #f2f4f7;background:transparent;font:inherit;font-size:13.5px;font-weight:650;color:var(--primary-readable,var(--primary,#d93025));cursor:pointer;text-align:left}
.gxp-menu-new:hover{background:rgba(var(--primary-rgb,217,48,37),.06)}
.gxp-newform{display:flex;flex-direction:column;gap:8px;padding:6px}
.gxp-newform>strong{font-size:13px;color:#344054}
.gxp-newform .gxp-actions{margin-top:0}
.gxp-newform .gxp-btn{height:36px;padding:0 13px;font-size:13px}
.gxp-toggle{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;font:inherit;text-align:left;color:#101828;cursor:pointer}
.gxp-toggle span{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.gxp-toggle strong{font-size:14px}
.gxp-toggle small{font-size:12px;color:#667085}
.gxp-switch{flex:none;position:relative;width:38px;height:22px;border-radius:999px;background:#d0d5dd;transition:background .15s}
.gxp-switch::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.2);transition:transform .15s}
.gxp-toggle[aria-checked=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.04)}
.gxp-toggle[aria-checked=true] .gxp-switch{background:var(--primary,#d93025)}
.gxp-toggle[aria-checked=true] .gxp-switch::after{transform:translateX(16px)}
.gxp-toggle:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxp-rows{display:flex;flex-direction:column;gap:8px}
.gxp-row{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #e4e7ec;border-radius:13px;background:#fff}
.gxp-row div{flex:1 1 auto;min-width:0}
.gxp-row strong{display:block;font-size:14px}
.gxp-row small{display:block;font-size:12px;color:#667085;margin-top:2px}
.gxp-done{display:flex;align-items:flex-start;gap:10px}
.gxp-done>i{flex:none;margin-top:2px;font-size:18px;color:#067647}
.gxp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}
.gxp-spacer{flex:1 1 auto}
.gxp-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 18px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;font:inherit;font-size:14px;font-weight:650;color:#344054;cursor:pointer}
.gxp-btn.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}
.gxp-btn:disabled{opacity:.55;cursor:default}
.gxp-btn:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxp-busy{display:flex;align-items:center;gap:10px;min-height:120px;justify-content:center;color:#475467}
.gxp-note{font-size:12.5px!important;color:#667085!important}
.gxp-error{color:#b42318!important;font-size:13px;margin:0}
.gxp-error:empty{display:none}
/* A phone: the page fills the sheet, its buttons along the bottom in reach of the thumb (as the appointment setup). */
@media(max-width:560px){
  .gxs-step:has(>.gxs-body>.gxp){justify-content:flex-start}
  .gxs-body:has(>.gxp){display:flex;flex-direction:column;flex:1 0 auto}
  .gxp{flex:1 0 auto}
  .gxp>.gxp-actions{margin-top:auto;padding-top:8px}
  .gxp>.gxp-actions .gxp-spacer{display:none}
  .gxp>.gxp-actions .gxp-btn{flex:1 1 0;min-width:0;height:46px;padding:0 12px}
  .gxp>.gxp-actions .gxp-btn.primary{flex-grow:2}
  .gxp-add{align-self:stretch;justify-content:center;height:44px}
}
@media(prefers-reduced-motion:reduce){.gxp *{transition:none!important}}
`;
function installStyle(){
  if (document.getElementById('gxp-css')) return;
  const style = document.createElement('style'); style.id = 'gxp-css'; style.textContent = css; document.head.append(style);
}

export function mount(el, ctx){
  installStyle();
  const { esc } = ctx;
  const L = (key, fallback, values) => { let text = ctx.L(key, fallback); for (const [name, value] of Object.entries(values || {})) text = text.split(`{${name}}`).join(String(value)); return text; };
  const copy = (entry) => typeof entry === 'string' ? entry : clean(ctx.L(entry, object(entry).text)) || clean(object(entry).text);
  const orgId = String(window.__APP?.userOrgId || window.Portal?.currentUser?.orgId || ctx.orgId || '');
  const target = { scope: 'organization', organizationId: orgId };
  const invoke = async (action, input, key) => { const response = await window.PlatformAPI.publication.invoke(orgId, action, target, input, { idempotencyKey: `sales.team.setup:${key}:${orgId}:${crypto.randomUUID()}` }); return object(response?.value ?? response?.result ?? response); };
  // page: 'people' or 'done'. menu: the add list open ('list'), its new-person form ('new'), or closed ('').
  let alive = true, busy = false, page = 'people', status = {}, services = [], people = [], rows = [], menu = '', query = '', invite = true, invited = null;

  const errorLine = '<p class="gxp-error" role="alert" data-gxp-error></p>';
  const fail = (error) => { const node = el.querySelector('[data-gxp-error]'); if (node) node.textContent = clean(error?.message) || L('gx_sales_error', 'That didn’t work. Try again.'); };
  const heading = el.closest('.gxs-step')?.querySelector('.gxs-titlebar h2'), stepHeading = heading?.innerHTML || '';
  function title(value){ ctx.setTitle?.(value); if (heading) heading.innerHTML = value ? esc(value) : stepHeading; }
  const personOf = (id) => people.find((entry) => entry.id === id);
  const serviceLabel = (id) => services.find((entry) => entry.id === id)?.label || id;
  function report(){ ctx.change({ salespeople: rows.map(({ user_id, service_ids }) => ({ user_id, service_ids })) }, rows.map((row) => row.name).join(', ')); }

  // ── Your salespeople ───────────────────────────────────────────────────
  function card(row){
    const person = personOf(row.user_id);
    const sub = row.via === 'role' ? L('gx_sales_via_role', 'In Sales through their role') : row.via === 'group' ? L('gx_sales_via_group', 'In Sales through their team')
      : isPending(row.user_id) ? L('gx_sales_new', 'New · {email}', { email: row.email }) : person?.status === 'invited' ? L('gx_sales_invited', 'Hasn’t joined yet') : clean(person?.email);
    const chips = services.map((service) => `<button type="button" class="gxp-chip" data-gxp-sell="${esc(service.id)}" aria-pressed="${row.service_ids.includes(service.id)}"><i class="fas fa-check" aria-hidden="true"></i>${esc(service.label)}</button>`).join('');
    return `<section class="gxp-card" data-gxp-card="${esc(row.user_id)}" aria-label="${esc(row.name)}">
      <header><span class="gxp-avatar" aria-hidden="true">${esc(initials(row.name))}</span><span><strong>${esc(row.name)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
        ${row.via === 'direct' ? `<button type="button" class="gxp-remove" data-gxp-remove aria-label="${esc(L('gx_sales_remove', 'Take {name} off', { name: row.name }))}" title="${esc(L('gx_sales_remove_short', 'Take off'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button>` : ''}</header>
      ${services.length ? `<div class="gxp-sells" role="group" aria-label="${esc(L('gx_sales_sells_label', 'What {name} sells', { name: row.name }))}"><b>${esc(L('gx_sales_sells', 'Sells'))}</b><div class="gxp-chips">${chips}</div></div>` : ''}
    </section>`;
  }
  function menuHtml(){
    if (menu === 'new') return `<div class="gxp-menu" data-gxp-menu><form class="gxp-newform" data-gxp-newform novalidate><strong>${esc(L('gx_sales_new_title', 'Someone new'))}</strong>
      <input type="text" data-gxp-new-name autocomplete="off" placeholder="${esc(L('gx_sales_new_name', 'Name'))}" aria-label="${esc(L('gx_sales_new_name', 'Name'))}" value="${esc(query)}">
      <input type="email" data-gxp-new-email autocomplete="off" inputmode="email" autocapitalize="off" spellcheck="false" placeholder="${esc(L('gx_sales_new_email', 'Email'))}" aria-label="${esc(L('gx_sales_new_email', 'Email'))}">
      <p class="gxp-error" role="alert" data-gxp-new-error></p>
      <div class="gxp-actions"><button type="button" class="gxp-btn" data-gxp-new-cancel>${esc(L('gx_ui_cancel', 'Cancel'))}</button><button type="submit" class="gxp-btn primary">${esc(L('gx_sales_new_add', 'Add'))}</button></div></form></div>`;
    const taken = new Set(rows.map((row) => row.user_id));
    const found = people.filter((person) => !taken.has(person.id) && (!query || fold(`${person.name} ${person.email}`).includes(fold(query))));
    return `<div class="gxp-menu" data-gxp-menu>
      <input type="search" data-gxp-search placeholder="${esc(L('gx_sales_search', 'Search people'))}" aria-label="${esc(L('gx_sales_search', 'Search people'))}" value="${esc(query)}" autocomplete="off">
      ${found.length ? `<ul>${found.slice(0, 60).map((person) => `<li><button type="button" data-gxp-person="${esc(person.id)}"><span class="gxp-avatar" aria-hidden="true">${esc(initials(person.name))}</span><span>${esc(person.name)}<small>${esc(person.status === 'invited' ? L('gx_sales_invited', 'Hasn’t joined yet') : person.email)}</small></span></button></li>`).join('')}</ul>`
        : `<div class="gxp-menu-empty">${esc(query ? L('gx_sales_search_none', 'Nobody by that name yet.') : L('gx_sales_everyone', 'Everyone is already here.'))}</div>`}
      ${status.can?.add_people ? `<button type="button" class="gxp-menu-new" data-gxp-new><i class="fas fa-user-plus" aria-hidden="true"></i>${esc(query ? L('gx_sales_new_named', 'Add “{name}”', { name: query }) : L('gx_sales_new_title', 'Someone new'))}</button>` : ''}
    </div>`;
  }
  function drawPeople(focus = ''){
    title('');
    const fresh = rows.filter((row) => isPending(row.user_id));
    el.innerHTML = `<div class="gxp" data-gxp-page="people">
      <p>${esc(services.length ? L('gx_sales_lead', 'Add everyone who goes to sales appointments, and what each one sells. They can sell all of your work to start with.') : L('gx_sales_lead_plain', 'Add everyone who goes to sales appointments.'))}</p>
      ${rows.length ? `<div class="gxp-cards">${rows.map(card).join('')}</div>` : ''}
      <button type="button" class="gxp-add" data-gxp-add aria-expanded="${!!menu}"><i class="fas fa-plus" aria-hidden="true"></i>${esc(rows.length ? L('gx_sales_add_another', 'Add another salesperson') : L('gx_sales_add', 'Add a salesperson'))}</button>
      ${menu ? menuHtml() : ''}
      ${fresh.length && status.can?.invite ? `<button type="button" class="gxp-toggle" role="switch" data-gxp-invite aria-checked="${invite}"><span><strong>${esc(fresh.length === 1 ? L('gx_sales_invite_one', 'Invite {name} to the app', { name: fresh[0].name }) : L('gx_sales_invite', 'Invite the new ones to the app'))}</strong><small>${esc(L('gx_sales_invite_hint', 'We email them a link to sign in, so they see their appointments.'))}</small></span><i class="gxp-switch" aria-hidden="true"></i></button>` : ''}
      ${errorLine}
      <div class="gxp-actions">
        ${ctx.canBack?.() === true ? `<button type="button" class="gxp-btn" data-gxp-back><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button>` : ''}
        <span class="gxp-spacer"></span>
        <button type="button" class="gxp-btn primary" data-gxp-save>${esc(L('gx_sales_save', 'Save salespeople'))}</button>
      </div>
    </div>`;
    el.querySelectorAll('[data-gxp-card]').forEach((node) => {
      const row = rows.find((entry) => entry.user_id === node.dataset.gxpCard); if (!row) return;
      // A press changes its own state in place; nothing it landed on is drawn again.
      node.querySelectorAll('[data-gxp-sell]').forEach((button) => button.addEventListener('click', () => {
        const id = button.dataset.gxpSell, on = row.service_ids.includes(id);
        row.service_ids = on ? row.service_ids.filter((entry) => entry !== id) : [...row.service_ids, id];
        button.setAttribute('aria-pressed', String(!on)); report();
      }));
      node.querySelector('[data-gxp-remove]')?.addEventListener('click', () => { rows = rows.filter((entry) => entry !== row); report(); drawPeople('[data-gxp-add]'); });
    });
    el.querySelector('[data-gxp-add]').addEventListener('click', () => { menu = menu ? '' : 'list'; query = ''; drawPeople(menu ? '[data-gxp-search]' : '[data-gxp-add]'); });
    const search = el.querySelector('[data-gxp-search]');
    search?.addEventListener('input', () => { query = search.value; const at = search.selectionStart; drawPeople(); const again = el.querySelector('[data-gxp-search]'); again?.focus(); again?.setSelectionRange?.(at, at); });
    search?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); el.querySelector('[data-gxp-person]')?.click(); } });
    el.querySelectorAll('[data-gxp-person]').forEach((button) => button.addEventListener('click', () => {
      const person = personOf(button.dataset.gxpPerson); if (!person) return;
      rows.push({ user_id: person.id, name: person.name, email: person.email, via: 'direct', added: true, service_ids: services.map((service) => service.id) });
      menu = ''; query = ''; report(); drawPeople(`[data-gxp-card="${CSS.escape(person.id)}"] [data-gxp-sell], [data-gxp-add]`);
    }));
    el.querySelector('[data-gxp-new]')?.addEventListener('click', () => { menu = 'new'; drawPeople('[data-gxp-new-name]'); });
    el.querySelector('[data-gxp-new-cancel]')?.addEventListener('click', () => { menu = 'list'; drawPeople('[data-gxp-search]'); });
    el.querySelector('[data-gxp-newform]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = clean(el.querySelector('[data-gxp-new-name]').value), email = clean(el.querySelector('[data-gxp-new-email]').value).toLowerCase();
      const problem = el.querySelector('[data-gxp-new-error]');
      if (!name) { problem.textContent = L('gx_sales_new_need_name', 'Give their name.'); el.querySelector('[data-gxp-new-name]').focus(); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { problem.textContent = L('gx_sales_new_need_email', 'Give an email we can send their invite to.'); el.querySelector('[data-gxp-new-email]').focus(); return; }
      if (people.some((person) => person.email === email) || rows.some((row) => row.email === email)) { problem.textContent = L('gx_sales_new_taken', 'Someone here already has that email. Pick them from the list.'); return; }
      const id = `${PENDING}${crypto.randomUUID().slice(0, 12)}`;
      rows.push({ user_id: id, name, email, via: 'direct', added: true, service_ids: services.map((service) => service.id) });
      menu = ''; query = ''; report(); drawPeople('[data-gxp-add]');
    });
    el.querySelector('[data-gxp-invite]')?.addEventListener('click', (event) => { invite = !invite; event.currentTarget.setAttribute('aria-checked', String(invite)); });
    el.querySelector('[data-gxp-back]')?.addEventListener('click', () => ctx.back?.());
    el.querySelector('[data-gxp-save]').addEventListener('click', (event) => save(event.currentTarget));
    if (focus) el.querySelector(focus)?.focus({ preventScroll: false });
  }

  async function save(button){
    if (busy) return;
    if (!rows.length) { fail({ message: L('gx_sales_none', 'Add at least one salesperson.') }); return; }
    if (services.length && rows.some((row) => !row.service_ids.length)) { fail({ message: L('gx_sales_sells_none', 'Pick at least one kind of work {name} sells.', { name: rows.find((row) => !row.service_ids.length).name }) }); return; }
    busy = true; button.disabled = true;
    try {
      // Someone new is added to the organization first, so the save names them by id.
      const asked = [];
      for (const row of rows.filter((entry) => isPending(entry.user_id))) {
        const response = await window.PlatformAPI.publication.invoke(orgId, 'workforce.users.add', target, { name: row.name, email: row.email }, { idempotencyKey: `sales.team.setup:person:${orgId}:${row.user_id}` });
        const user = object(object(response?.value ?? response?.result ?? response).user);
        if (!user.id) throw new Error(L('gx_sales_add_failed', '{name} could not be added. Try again.', { name: row.name }));
        people.push({ id: user.id, name: clean(user.name) || row.name, email: clean(user.email) || row.email, status: 'invited' });
        row.user_id = user.id; asked.push(user.id);
      }
      report();
      status = { ...status, ...(await invoke('sales.team.setup.apply', { salespeople: rows.map(({ user_id, service_ids }) => ({ user_id, service_ids })) }, 'apply')) };
      invited = null;
      if (asked.length && invite && status.can?.invite) {
        try {
          const value = await invoke('workforce.users.invite', { user_ids: asked }, 'invite');
          invited = { sent: Number(value.sent || 0), failed: array(value.invites).filter((entry) => !entry.ok).map((entry) => personOf(entry.user_id)?.name || entry.user_id) };
        } catch (error) { invited = { sent: 0, failed: asked.map((id) => personOf(id)?.name || id) }; }
      }
      // Scheduling and the New appointment dialog read who can go again.
      const windows = new Set([window]); try { if (window.top.location.origin === location.origin) windows.add(window.top); } catch (_) {}
      windows.forEach((win) => win.dispatchEvent(new win.CustomEvent('fm:workforce:updated', { detail: { source: 'sales.team.setup' } })));
      if (!alive) return;
      page = 'done'; draw(); ctx.syncBack?.(); el.closest('.gxs-step')?.scrollTo?.({ top: 0 });
    } catch (error) { if (alive) fail(error); }
    finally { busy = false; if (button.isConnected) button.disabled = false; }
  }

  // ── Your salespeople are set up ────────────────────────────────────────
  function drawDone(){
    title(L('gx_sales_done_title', 'Your salespeople are set up'));
    const sells = (row) => !services.length ? '' : row.service_ids.length === services.length ? L('gx_sales_done_all', 'Sells all of your work') : row.service_ids.map(serviceLabel).join(', ');
    el.innerHTML = `<div class="gxp" data-gxp-page="done">
      <div class="gxp-done" role="status"><i class="fas fa-circle-check" aria-hidden="true"></i><p>${esc(L('gx_sales_done_body', 'Sales appointments can go to them now. Change who sells in People › Departments.'))}${invited?.sent ? ` ${esc(invited.sent === 1 ? L('gx_sales_done_invited_one', 'We emailed 1 invite to the app.') : L('gx_sales_done_invited', 'We emailed {n} invites to the app.', { n: invited.sent }))}` : ''}</p></div>
      ${invited?.failed?.length ? `<p class="gxp-error" role="alert">${esc(L('gx_sales_done_invite_failed', 'These invites didn’t go out: {names}. Send them from People.', { names: invited.failed.join(', ') }))}</p>` : ''}
      <div class="gxp-rows">${rows.map((row) => `<div class="gxp-row" data-gxp-done="${esc(row.user_id)}"><span class="gxp-avatar" aria-hidden="true">${esc(initials(row.name))}</span><div><strong>${esc(row.name)}</strong>${sells(row) ? `<small>${esc(sells(row))}</small>` : ''}</div></div>`).join('')}</div>
      ${errorLine}
      <div class="gxp-actions"><button type="button" class="gxp-btn" data-gxp-edit><i class="fas fa-arrow-left" aria-hidden="true"></i>${esc(L('gx_ui_back', 'Back'))}</button><span class="gxp-spacer"></span><button type="button" class="gxp-btn primary" data-gxp-finish>${esc(L('gx_ui_done', 'Done'))}</button></div>
    </div>`;
    el.querySelector('[data-gxp-edit]').addEventListener('click', () => { page = 'people'; draw(); ctx.syncBack?.(); });
    el.querySelector('[data-gxp-finish]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (busy) return; busy = true; button.disabled = true;
      try { await ctx.complete?.(); } catch (error) { fail(error); } finally { busy = false; if (button.isConnected) button.disabled = false; }
    });
    el.querySelector('[data-gxp-finish]').focus({ preventScroll: true });
  }

  // The setup's intro (why it asks) leads the first page only.
  const intro = el.closest('.gxs-step')?.querySelector('.gxs-intro');
  function draw(){
    if (!alive) return;
    if (intro) intro.hidden = page !== 'people';
    if (page === 'done') drawDone(); else drawPeople();
  }

  el.innerHTML = '<div class="gxp"><div class="gxp-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
  // Read when the step shows: the setup steps before it may have just answered what work the company does.
  ctx.read('sales-team-setup', 'status').then((value) => {
    if (!alive) return;
    status = object(value);
    services = array(status.services).map((entry) => ({ id: clean(entry.id), label: copy(entry.label) })).filter((entry) => entry.id);
    people = array(status.people).map((entry) => ({ id: clean(entry.id), name: clean(entry.name), email: clean(entry.email).toLowerCase(), status: clean(entry.status) }));
    const all = services.map((service) => service.id);
    // Nothing said yet about what someone sells: everything the company does, until the person says otherwise.
    rows = array(status.salespeople).map((entry) => {
      const saved = array(entry.service_ids).filter((id) => all.includes(id));
      return { user_id: clean(entry.user_id), name: clean(entry.name), email: clean(personOf(entry.user_id)?.email), via: clean(entry.via) || 'direct', service_ids: entry.service_ids === null || !saved.length ? [...all] : saved };
    });
    report(); draw();
  }).catch((error) => { if (alive) { el.innerHTML = `<div class="gxp">${errorLine}</div>`; fail(error); } });
  return {
    valid: () => true,
    // Escape closes the add list first.
    escape: () => { if (busy) return true; if (menu && page === 'people') { menu = ''; drawPeople('[data-gxp-add]'); return true; } return false; },
    // The phone's back leaves the done page for the people page; from there it is the setup's own Back.
    backDepth: () => page === 'done' ? 1 : 0,
    back(){ if (busy) return true; if (page === 'done') { page = 'people'; draw(); return true; } return false; },
    destroy(){ alive = false; }
  };
}
export default mount;
